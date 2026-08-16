import type { SaivageConfig } from '../schemas/saivage-config.js';
import {
  buildProviderRoutingReadModel,
  type ProviderRoutingReadModel,
} from '../agents/provider-routing-read-model.js';
import { MemoryCandidateAvailability } from '../agents/candidate-availability.js';
import { AnalystRuntime, AnalystSession, type AnalystTurnInput } from '../agents/analyst-api.js';
import { ProviderRegistry } from '../agents/provider.js';
import type { McpToolInvocationPort } from '../mcp/manager-api.js';
import type { RuntimeApi } from '../runtime/runtime-api.js';

import { CardService } from '../cards/card-service.js';
import { InvocationService } from '../agents/invocation-service.js';
import {
  createInvocationServiceProvider,
  invocationRequest,
} from './invocation-service-provider.js';
import { createSupervisorRuntimeApi } from '../runtime/actors/index.js';
import { ProcessRunner } from '../runtime/process-runner.js';
import type { ManagedProcessScope } from '../runtime/managed-process-group-registry.js';
import { RuntimeGate } from '../runtime/runtime-gate.js';
import { createPromptTemplateRegistry } from '../utils/prompt-api.js';
import type { RestartPort } from '../boot/restart-port.js';
import type { ResolvedConfigAuthority } from '../config/index.js';
import type { FreshnessEffects } from './freshness-effects.js';
import type { ConversationFileContext } from '../persistence/conversation-file.js';
import {
  compact,
  shouldCompact,
  type AutonomousCompactionPolicy,
} from '../runtime/actors/compaction/compactor.js';
import type { SummarizerProviderPort } from '../runtime/actors/compaction/summarizer.js';
import type { CompactorPort } from '../runtime/actors/llm-actor.js';
import type { RuntimeProcessIdentity } from '../runtime/lock.js';
import type { ConversationSessionId, GlobalConversationSessionId } from '../schemas/index.js';
import type { ToolContext } from '../tools/analyst-tool-types.js';
import { createAnalystMutationServices } from './analyst-mutation-services.js';
import { runtimeAgentBinding } from '../runtime/card-process/card-process-config.js';
import { EventQueryService } from './event-query-service.js';
import type { CompiledRuntimeWorkflows } from '../runtime/card-process/card-process-config.js';
import type { ApplicationFatalPort } from '../contracts/index.js';

export interface RuntimeApplication {
  readonly runtimeApi: RuntimeApi;
  readonly cardStore: CardService;
  readonly processRunner: ProcessRunner;
  readonly analystRuntime: AnalystRuntime;
  readonly analystSessionId: import('../schemas/index.js').GlobalConversationSessionId;
  captureExecutingLlmSessionIds(): ReadonlySet<ConversationSessionId>;
  closeRuntimeAdmission(): void;
  closeAnalystAdmission(): void;
  cleanupRuntimeForApplicationStop(): Promise<void>;
  cleanupAnalystForApplicationStop(): Promise<void>;
  getProviderRoutingReadModel(): ProviderRoutingReadModel;
}

export interface RuntimeApplicationServices {
  projectRoot: string;
  processIdentity: RuntimeProcessIdentity;
  config: SaivageConfig;
  workflows: CompiledRuntimeWorkflows;
  providerRegistry: ProviderRegistry;
  configAuthority: ResolvedConfigAuthority;
  cardStore: CardService;
  restartServerAvailable?: boolean;
  restartPort?: RestartPort;
  freshness: FreshnessEffects;
  processRunner: ProcessRunner;
  runtimeProcessRootScope: ManagedProcessScope;
  analystProcessRootScope: ManagedProcessScope;
  mcpToolInvocation: McpToolInvocationPort;
  fatalPort: ApplicationFatalPort;
  analystSessionId: GlobalConversationSessionId;
}

export function createRuntimeApplication(services: RuntimeApplicationServices): RuntimeApplication {
  const {
    projectRoot,
    config,
    cardStore,
    restartServerAvailable = false,
    restartPort,
  } = services;
  const eventQueries = new EventQueryService(projectRoot);
  const candidateAvailability = new MemoryCandidateAvailability();
  const conversations: ConversationFileContext = { projectRoot, changes: services.freshness };

  const registry = services.providerRegistry;
  const summarizerCandidate = registry.assertCandidate(config.compaction.summarizer_candidate);
  const invocationService = new InvocationService({
    projectRoot,
    registry,
    candidateAvailability,
    freshness: services.freshness,
  });
  const summarizerProvider: SummarizerProviderPort = {
    candidate:summarizerCandidate,
    completeTurn: (input, signal) => invocationService.invokeWithRecovery(invocationRequest(input, signal)),
    projectProviderExchanges: (sessionId, sourceInputId, attempts, context) =>
      invocationService.projectProviderExchanges(
        sessionId,
        sourceInputId,
        attempts,
        context),
  };
  const compactionPolicy: AutonomousCompactionPolicy = {
    input_budget_tokens: config.compaction.input_budget_tokens,
    trigger_fraction: config.compaction.trigger_fraction,
    completion_reserve_fraction: config.compaction.completion_reserve_fraction,
    merge_line_fraction: config.compaction.merge_line_fraction,
    summary_line_fraction: config.compaction.summary_line_fraction,
    escalate_merge_line_fraction: config.compaction.escalate_merge_line_fraction,
    escalate_summary_line_fraction: config.compaction.escalate_summary_line_fraction,
    snap: config.compaction.snap,
  };
  const compactor: CompactorPort = { shouldCompact, compact };
  const processRunner = services.processRunner;
  const runtimeGate = new RuntimeGate();
  const promptTemplates = createPromptTemplateRegistry(services.workflows);
  const workflows = services.workflows;
  const analystBinding = runtimeAgentBinding(workflows, workflows.analyst.name);
  const runtimeSupervisor = createSupervisorRuntimeApi({
    projectRoot,
    processIdentity: services.processIdentity,
    actorStore: cardStore,
    provider: createInvocationServiceProvider(invocationService),
    promptTemplates,
    workflows,
    compactionConfig: compactionPolicy,
    compactor,
    summarizerProvider,
    processRunner,
    runtimeProcessRootScope: services.runtimeProcessRootScope,
    runtimeGate,
    mcpToolInvocation: services.mcpToolInvocation,
    conversations,
    freshness: services.freshness,
    fatalPort: services.fatalPort,
  });
  const runtimeApi: RuntimeApi = runtimeSupervisor;
  const analystSessionId = services.analystSessionId;
  let analystRuntimeCache: AnalystRuntime | null = null;
  const analystProvider = createInvocationServiceProvider(invocationService);
  const createAnalystSession = (_turn: AnalystTurnInput): AnalystSession => {
    const directScope = processRunner.createDirectScope(
      services.analystProcessRootScope,
      `analyst-session:${analystSessionId}`,
      'operator_session',
    );
    const createInvocationSurface = () => {
      const notifyCard = runtimeApi.notifyCard.bind(runtimeApi);
      const analystMutations = createAnalystMutationServices({
        projectRoot,
        store: cardStore,
        configAuthority: services.configAuthority,
        notifyCard,
        cancelCard: runtimeApi.cancelCard.bind(runtimeApi),
      });
      const context: ToolContext = {
        cardTypeVocabulary: workflows.cardTypeVocabulary,
        projectRoot,
        configAuthority: services.configAuthority,
        interventionReadiness: runtimeSupervisor,
        processRunner,
        processScope: directScope,
        store: cardStore,
        sessionId: analystSessionId,
        runtime: runtimeApi,
        mcpToolInvocation: services.mcpToolInvocation,
        restartServerAvailable,
        actor: workflows.analyst.name,
        surface: 'web-chat',
        analystMutations,
        eventQueries,
        captureExecutingLlmSessionIds,
      };
      return analystBinding.toolSet.bind({
        scope: 'global',
        agentName: analystBinding.contract.name,
        projectRoot,
        store: cardStore,
        processRunner,
        processScope: directScope,
        processOwnerId: analystSessionId,
        mcpToolInvocation: services.mcpToolInvocation,
        analystToolContext: context,
        cardTypeVocabulary: workflows.cardTypeVocabulary,
      });
    };
    const shutdownProcesses = async (): Promise<void> => {
      const report = await processRunner.closeAndTerminateDirectScope({
        directScope,
        category: 'operator_session',
        reason: 'session closed',
        graceMs: 5_000,
      });
      if (report.failed.length > 0)
        throw new Error(
          report.failed
            .map((failure) => `${failure.groupId}: ${failure.state}: ${failure.diagnostic}`)
            .join('; '),
        );
    };
    return new AnalystSession({
      projectRoot,
      sessionId: analystSessionId,
      agentName: analystBinding.contract.name,
      modelParams: analystBinding.contract.model,
      capabilityRequest: analystBinding.capabilityRequest,
      candidateChain: analystBinding.candidateChain,
      promptTemplates,
      restartServerAvailable,
      restartPort,
      provider: analystProvider,
      conversations,
      compactionPolicy,
      compactor,
      summarizerProvider,
      cardStore,
      runtimeProjectionChanged: () => services.freshness.agentMembershipChanged({ scope: 'global-session', sessionId: analystSessionId }),
      createInvocationSurface,
      shutdownProcesses,
      fatalPort: services.fatalPort,
      cardTypeVocabulary: workflows.cardTypeVocabulary,
    });
  };
  const getAnalystToolNames = (): string[] => [...analystBinding.toolSet.names];
  const terminateAnalystRoot = (reason: string) =>
    processRunner.terminateScopeTree({
      rootScope: services.analystProcessRootScope,
      categories: ['operator_session'],
      reason,
      graceMs: 5_000,
    });
  const captureExecutingLlmSessionIds = (): ReadonlySet<ConversationSessionId> => {
    const sessionIds = new Set(runtimeSupervisor.captureAutonomousExecutingLlmSessionIds());
    const analystSnapshot = analystRuntimeCache?.executingLlmSnapshot();
    if (analystSnapshot) sessionIds.add(analystSnapshot.sessionId);
    return sessionIds;
  };

  return {
    runtimeApi,
    analystSessionId,
    cardStore,
    processRunner,
    captureExecutingLlmSessionIds,
    get analystRuntime() {
      analystRuntimeCache ??= new AnalystRuntime({
        createSession: createAnalystSession,
        getAvailableToolNames: getAnalystToolNames,
        terminateRoot: terminateAnalystRoot,
      });
      return analystRuntimeCache;
    },
    closeRuntimeAdmission() {
      runtimeSupervisor.closeApplicationAdmission();
    },
    closeAnalystAdmission() {
      analystRuntimeCache?.closeAdmission();
    },
    cleanupRuntimeForApplicationStop() {
      return runtimeSupervisor.cleanupForApplicationStop();
    },
    cleanupAnalystForApplicationStop() {
      return analystRuntimeCache
        ? analystRuntimeCache.cleanupForApplicationStop()
        : Promise.resolve();
    },
    getProviderRoutingReadModel() {
      return buildProviderRoutingReadModel({
        registry,
        availability: candidateAvailability,
      });
    },
  };
}
