import type { SaivageConfig } from '../schemas/saivage-config.js';
import { buildProviderRoutingReadModel, type ProviderRoutingReadModel } from '../agents/provider-routing-read-model.js';
import { MemoryCandidateAvailability } from '../agents/candidate-availability.js';
import { AnalystRuntime, AnalystSession, type AnalystTurnInput } from '../agents/analyst-api.js';
import { ProviderRegistry } from '../agents/provider.js';
import { ModelRouter } from '../agents/model-router.js';
import type { McpToolInvocationPort } from '../mcp/manager-api.js';
import type { EventLog } from '../observability/index.js';
import type { RuntimeApi } from '../runtime/control-api.js';

import { CardService } from '../cards/card-service.js';
import { InvocationService } from '../agents/invocation-service.js';
import { createInvocationServiceProvider, invocationRequest } from './invocation-service-provider.js';
import { createSupervisorRuntimeApi } from '../runtime/actors/index.js';
import { ProcessRunner } from '../runtime/process-runner.js';
import type { ManagedProcessScope } from '../runtime/managed-process-group-registry.js';
import { RuntimeGate } from '../runtime/runtime-gate.js';
import { createPromptTemplateRegistry } from '../utils/prompt-api.js';
import type { RestartPort } from '../boot/restart-port.js';
import type { ResolvedConfigAuthority } from '../config/index.js';
import type { FreshnessEffects } from './freshness-effects.js';
import type { ConversationFileContext } from '../persistence/conversation-file.js';
import { RuntimeInterventionBinding } from './intervention-readiness.js';
import { compact, shouldCompact, type AutonomousCompactionPolicy } from '../runtime/actors/compaction/compactor.js';
import type { SummarizerProviderPort } from '../runtime/actors/compaction/summarizer.js';
import type { CompactorPort } from '../runtime/actors/llm-actor.js';
import type { RuntimeProcessIdentity } from '../runtime/lock.js';
import type { ExecutingLlmSnapshot } from '../runtime/actors/executing-llm-snapshot.js';
import { globalAgentSessionId } from '../schemas/index.js';
import type { ToolContext } from '../tools/analyst-tool-types.js';
import { buildAgentSurface } from '../tools/agent-invocation-surface.js';
import { createAnalystMutationServices } from './analyst-mutation-services.js';
import { describeNodeResultContract } from '../runtime/card-process/card-process-config.js';
import { createProcessPromptRegistry } from '../runtime/card-process/process-prompt-registry.js';
import { EventQueryService } from './event-query-service.js';
import type { CompiledRuntimeWorkflows } from '../runtime/card-process/card-process-config.js';

export interface RuntimeApplication {
  readonly runtimeApi: RuntimeApi;
  readonly cardStore: CardService;
  readonly processRunner: ProcessRunner;
  readonly analystRuntime: AnalystRuntime;
  readonly analystSessionId: import('../schemas/index.js').GlobalConversationSessionId;
  closeRuntimeAdmission(): void;
  closeAnalystAdmission(): void;
  cleanupRuntimeForApplicationStop(): Promise<void>;
  cleanupAnalystForApplicationStop(): Promise<void>;
  getProviderRoutingReadModel(): ProviderRoutingReadModel;
  captureExecutingLlmSnapshots(): readonly ExecutingLlmSnapshot[];
}

export interface RuntimeApplicationServices {
  projectRoot: string;
  processIdentity: RuntimeProcessIdentity;
  config: SaivageConfig;
  workflows: CompiledRuntimeWorkflows;
  providerRegistry:ProviderRegistry;
  configAuthority: ResolvedConfigAuthority;
  eventLogger: EventLog;
  cardStore: CardService;
  restartServerAvailable?: boolean;
  restartPort?: RestartPort;
  freshness: FreshnessEffects;
  processRunner: ProcessRunner;
  runtimeProcessRootScope: ManagedProcessScope;
  analystProcessRootScope: ManagedProcessScope;
  mcpToolInvocation: McpToolInvocationPort;
}

export function createRuntimeApplication(services: RuntimeApplicationServices): RuntimeApplication {
  const { projectRoot, config, eventLogger, cardStore, restartServerAvailable = false, restartPort } = services;
  const interventionBinding = new RuntimeInterventionBinding();
  const eventQueries = new EventQueryService(projectRoot);
  const candidateAvailability = new MemoryCandidateAvailability();
  const conversations: ConversationFileContext = { projectRoot, changes: services.freshness };

  const registry = services.providerRegistry;
  const summarizerCandidate = registry.assertCandidate(config.compaction.summarizer_candidate);
  const router = new ModelRouter(
    config,
    registry,
  );
  const invocationService = new InvocationService({
    projectRoot,
    registry,
    router,
    candidateAvailability,
    freshness: services.freshness,
  });
  const summarizerProvider: SummarizerProviderPort = {
    completeTurn: (input, signal) => invocationService.invokeWithRecovery(invocationRequest(input, signal, [summarizerCandidate])),
    projectProviderExchanges: (sessionId, sourceInputId, attempts, assistantOutputIds, operationError) => invocationService.projectProviderExchanges(sessionId, sourceInputId, attempts, assistantOutputIds, operationError),
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
  const processPrompts = createProcessPromptRegistry(workflows);
  for (const [cardType, process] of workflows.cardTypes) {
      for (const [stateId, node] of process.states) {
        if (node.kind !== 'node') continue;
        promptTemplates.validateProcessNode(cardType, node.agent.name, {
          cardId: 'startup-validation-card',
          cardTitle: 'Startup prompt validation',
          cardBrief: 'Startup validates the effective role template before actor construction.',
          cardType,
          contractDescription: describeNodeResultContract(process, stateId),
          toolList: '- startup-validation: no runtime tool invocation',
        });
      }
  }

  const runtimeSupervisor = createSupervisorRuntimeApi({
    projectRoot,
    processIdentity: services.processIdentity,
    actorStore: cardStore,
    interventionBinding,
    provider: createInvocationServiceProvider(invocationService),
    promptTemplates,
    workflows,
    processPrompts,
    compactionConfig: compactionPolicy,
    compactor,
    summarizerProvider,
    processRunner,
    runtimeProcessRootScope: services.runtimeProcessRootScope,
    runtimeGate,
    mcpToolInvocation: services.mcpToolInvocation,
    conversations,
    freshness: services.freshness,
  });
  const runtimeApi: RuntimeApi = runtimeSupervisor;
  const analystSessionId=globalAgentSessionId(workflows.analyst.name);
  let analystRuntimeCache: AnalystRuntime | null = null;
  const analystProvider = createInvocationServiceProvider(invocationService);
  const createAnalystSession = (_turn: AnalystTurnInput): AnalystSession => {
    const directScope = processRunner.createDirectScope(services.analystProcessRootScope, `analyst-session:${analystSessionId}`, 'operator_session');
    const createInvocationSurface = () => {
      const notifyCard = runtimeApi.notifyCard.bind(runtimeApi);
      const analystMutations = createAnalystMutationServices({ projectRoot, store: cardStore, configAuthority: services.configAuthority, notifyCard, cancelCard: runtimeApi.cancelCard.bind(runtimeApi) });
      const context: ToolContext = {
        projectRoot,
        configAuthority: services.configAuthority,
        interventionReadiness: interventionBinding,
        processRunner,
        processScope: directScope,
        store: cardStore,
        sessionId: analystSessionId,
        runtime: runtimeApi,
        mcpToolInvocation: services.mcpToolInvocation,
        restartServerAvailable,
        actor: workflows.analyst.name,
        surface: 'web-chat',
        captureExecutingLlmSnapshots: () => {
          const snapshots = [...runtimeSupervisor.captureAutonomousExecutingLlmSnapshots()];
          const analyst = analystRuntimeCache?.executingLlmSnapshot();
          if (analyst) snapshots.push(analyst);
          return snapshots;
        },
        analystMutations,
        eventQueries,
      };
      return buildAgentSurface({ agentName: workflows.analyst.name, toolNames: workflows.analyst.tools, projectRoot, store: cardStore, processRunner, processScope: directScope, processOwnerId: analystSessionId, mcpToolInvocation: services.mcpToolInvocation, analystToolContext: context });
    };
    const shutdownProcesses = async (): Promise<void> => {
      const report = await processRunner.closeAndTerminateDirectScope({ directScope, category: 'operator_session', reason: 'session closed', graceMs: 5_000 });
      if (report.failed.length > 0) throw new Error(report.failed.map((failure) => `${failure.groupId}: ${failure.state}: ${failure.diagnostic}`).join('; '));
    };
    return new AnalystSession({
      projectRoot,
      sessionId: analystSessionId,
      config,
      candidateChain:workflows.candidateChains.get(workflows.analyst.name)!,
      promptTemplates,
      restartServerAvailable,
      restartPort,
      provider: analystProvider,
      conversations,
      compactionPolicy,
      compactor,
      summarizerProvider,
      eventLogger,
      cardStore,
      runtimeProjectionChanged: () => services.freshness.agentsChanged(),
      createInvocationSurface,
      shutdownProcesses,
    });
  };
  const getAnalystToolNames = (): string[] => {
    const directScope = processRunner.createDirectScope(services.analystProcessRootScope, 'analyst-tool-catalog', 'operator_session');
    try {
      const notifyCard = runtimeApi.notifyCard.bind(runtimeApi);
      const analystMutations = createAnalystMutationServices({ projectRoot, store: cardStore, configAuthority: services.configAuthority, notifyCard, cancelCard: runtimeApi.cancelCard.bind(runtimeApi) });
      const context: ToolContext = {
        projectRoot,
        configAuthority: services.configAuthority,
        interventionReadiness: interventionBinding,
        processRunner,
        processScope: directScope,
        store: cardStore,
        runtime: runtimeApi,
        mcpToolInvocation: services.mcpToolInvocation,
        restartServerAvailable,
        actor: workflows.analyst.name,
        surface: 'web-chat',
        captureExecutingLlmSnapshots: () => {
          const snapshots = [...runtimeSupervisor.captureAutonomousExecutingLlmSnapshots()];
          const analyst = analystRuntimeCache?.executingLlmSnapshot();
          if (analyst) snapshots.push(analyst);
          return snapshots;
        },
        analystMutations,
        eventQueries,
      };
      return Array.from(buildAgentSurface({ agentName: workflows.analyst.name, toolNames: workflows.analyst.tools, projectRoot, store: cardStore, processRunner, processScope: directScope, processOwnerId: 'analyst-tool-catalog', mcpToolInvocation: services.mcpToolInvocation, analystToolContext: context }).tools.keys());
    } finally {
      processRunner.closeScope(directScope);
    }
  };
  const terminateAnalystRoot = (reason: string) => processRunner.terminateScopeTree({ rootScope: services.analystProcessRootScope, categories: ['operator_session'], reason, graceMs: 5_000 });

  return {
    runtimeApi,
    analystSessionId,
    cardStore,
    processRunner,
    get analystRuntime() {
      analystRuntimeCache ??= new AnalystRuntime({ createSession: createAnalystSession, getAvailableToolNames: getAnalystToolNames, terminateRoot: terminateAnalystRoot });
      return analystRuntimeCache;
    },
    captureExecutingLlmSnapshots() {
      const snapshots = [...runtimeSupervisor.captureAutonomousExecutingLlmSnapshots()];
      const analyst = analystRuntimeCache?.executingLlmSnapshot();
      if (analyst) snapshots.push(analyst);
      return snapshots;
    },
    closeRuntimeAdmission() { runtimeSupervisor.closeApplicationAdmission(); },
    closeAnalystAdmission() { analystRuntimeCache?.closeAdmission(); },
    cleanupRuntimeForApplicationStop() { return runtimeSupervisor.cleanupForApplicationStop(); },
    cleanupAnalystForApplicationStop() { return analystRuntimeCache ? analystRuntimeCache.cleanupForApplicationStop() : Promise.resolve(); },
    getProviderRoutingReadModel() {
      return buildProviderRoutingReadModel({
        registry,
        availability: candidateAvailability,
      });
    },
  };
}
