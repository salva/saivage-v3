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
  executeAdmittedTurn,
} from './invocation-service-provider.js';
import { createSupervisorRuntimeApi } from '../runtime/actors/index.js';
import { ProcessRunner } from '../runtime/process-runner.js';
import type { ManagedProcessScope } from '../runtime/managed-process-group-registry.js';
import { RuntimeGate } from '../runtime/runtime-gate.js';
import { createPromptTemplateRegistry } from '../utils/prompt-api.js';
import type { RestartCapability } from '../contracts/index.js';
import type { ResolvedConfigAuthority } from '../config/index.js';
import type { FreshnessEffects } from './freshness-effects.js';
import type { ConversationFileContext } from '../persistence/conversation-file.js';
import {
  compact,
  shouldCompact,
  type AutonomousCompactionPolicy,
} from '../runtime/actors/compaction/compactor.js';
import { admitSummaryRequest, assertSummarizerCapabilities, buildSummaryRequestInput, SUMMARY_COMPLETION_TOKENS, type SummarizerProviderPort, type SummaryRequestSerialization } from '../runtime/actors/compaction/summarizer.js';
import { SUMMARY_REFINE_INSTRUCTION } from '../runtime/actors/compaction/refine-accumulator.js';
import type { CompactorPort } from '../runtime/actors/llm-actor.js';
import { buildCandidateRequest } from '../agents/candidate-request.js';
import { selectLlmProtocolAdapter } from '../agents/llm-protocol-adapter.js';
import { buildLlmOptions } from '../agents/llm-options-factory.js';
import type { LlmInvocationInput } from '../runtime/actors/llm-invocation.js';
import type { RuntimeProcessIdentity } from '../runtime/lock.js';
import type { ConversationSessionId, GlobalConversationSessionId } from '../schemas/index.js';
import type { ToolContext } from '../tools/analyst-tool-types.js';
import { createAnalystMutationServices } from './analyst-mutation-services.js';
import { runtimeAgentBinding } from '../runtime/card-process/card-process-config.js';
import { EventQueryService } from './event-query-service.js';
import type { CompiledRuntimeWorkflows } from '../runtime/card-process/card-process-config.js';
import type { ApplicationFatalPort } from '../contracts/index.js';
import type { ExecutingLlmSnapshot } from '../runtime/actors/executing-llm-snapshot.js';

export interface RuntimeApplication {
  readonly runtimeApi: RuntimeApi;
  readonly cardStore: CardService;
  readonly processRunner: ProcessRunner;
  readonly analystRuntime: AnalystRuntime;
  readonly analystSessionId: import('../schemas/index.js').GlobalConversationSessionId;
  captureExecutingLlmSnapshots(): ReadonlyMap<ConversationSessionId, ExecutingLlmSnapshot>;
  closeRuntimeAdmission(): void;
  closeAnalystAdmission(): void;
  cleanupRuntimeForApplicationStop(): Promise<void>;
  cleanupAnalystForApplicationStop(): Promise<void>;
  getProviderRoutingReadModel(): ProviderRoutingReadModel;
}

interface RuntimeApplicationServices {
  projectRoot: string;
  processIdentity: RuntimeProcessIdentity;
  config: SaivageConfig;
  workflows: CompiledRuntimeWorkflows;
  providerRegistry: ProviderRegistry;
  configAuthority: ResolvedConfigAuthority;
  cardStore: CardService;
  restartCapability: RestartCapability;
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
    restartCapability,
  } = services;
  const eventQueries = new EventQueryService(projectRoot);
  const candidateAvailability = new MemoryCandidateAvailability();
  const conversations: ConversationFileContext = { projectRoot, changes: services.freshness };

  const registry = services.providerRegistry;
  const summarizerCandidate = registry.assertCandidate(config.compaction.summarizer_candidate);
  const summarizerCapabilities = registry.getEffectiveCapabilities(summarizerCandidate);
  assertSummarizerCapabilities(summarizerCapabilities);
  const invocationService = new InvocationService({
    projectRoot,
    registry,
    candidateAvailability,
    freshness: services.freshness,
  });
  const summarizerSerializeRequest = (input: LlmInvocationInput): SummaryRequestSerialization => {
    const maxTokens = input.modelParams.maxTokens;
    if (maxTokens === undefined) throw new Error('Summary request serialization requires an explicit completion token request.');
    const candidate = registry.assertCandidate(config.compaction.summarizer_candidate);
    const capabilities = registry.getEffectiveCapabilities(candidate);
    const adapter = selectLlmProtocolAdapter(capabilities.transportProtocol);
    const plan = buildCandidateRequest({
      candidate,
      capabilities,
      adapter,
      systemPrompt: input.systemPrompt,
      providerConversation: input.providerConversation,
      options: buildLlmOptions(
        input.agentName,
        input.tools,
        input.terminalToolNames,
        { temperature: input.modelParams.temperature, max_tokens: maxTokens },
        undefined,
        input.inputId,
      ),
    });
    return {
      serializedRequest: plan.request.serializedBody,
      requestSha256: plan.request.requestHash,
      estimatedInputTokens: plan.request.estimatedWireInputTokens,
    };
  };
  const summarizerProvider: SummarizerProviderPort = {
    candidate:summarizerCandidate,
    contextWindowTokens: summarizerCapabilities.contextWindowTokens,
    maxOutputTokens: summarizerCapabilities.maxOutputTokens,
    serializeSummaryRequest: summarizerSerializeRequest,
    completeTurn: (input, admitted, signal) => executeAdmittedTurn(invocationService, input, signal, admitted.requestSha256),
    projectProviderExchanges: (sessionId, sourceInputId, attempts, context) =>
      invocationService.projectProviderExchanges(
        sessionId,
        sourceInputId,
        attempts,
        context),
  };
  const invariantSummaryInput = buildSummaryRequestInput({
    candidate: summarizerCandidate,
    sourceSessionId: services.analystSessionId,
    instruction: SUMMARY_REFINE_INSTRUCTION,
    items: [],
  });
  const invariantSummaryAdmission = admitSummaryRequest({
    serialization: summarizerSerializeRequest(invariantSummaryInput),
    contextUtilizationFraction: config.compaction.context_utilization_fraction,
    contextWindowTokens: summarizerCapabilities.contextWindowTokens,
    maxOutputTokens: summarizerCapabilities.maxOutputTokens,
  });
  if (invariantSummaryAdmission.kind !== 'admitted')
    throw new Error(`The invariant compaction summary request overhead plus ${SUMMARY_COMPLETION_TOKENS} requested output tokens does not fit the configured fixed candidate capacity.`);
  const compactionPolicy: AutonomousCompactionPolicy = {
    context_utilization_fraction: config.compaction.context_utilization_fraction,
    trigger_fraction: config.compaction.trigger_fraction,
    tail_fraction: config.compaction.tail_fraction,
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
        restartCapability,
        actor: workflows.analyst.name,
        surface: 'web-chat',
        analystMutations,
        eventQueries,
        captureExecutingLlmSnapshots,
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
      });
      if (report.failed.length > 0)
        throw new Error(
          report.failed
            .map((failure) => `${failure.groupId}: ${failure.state}: ${failure.diagnostic}`)
            .join('; '),
        );
    };
    return new AnalystSession({
      sessionId: analystSessionId,
      agentName: analystBinding.contract.name,
      modelParams: analystBinding.contract.model,
      capabilityRequest: analystBinding.capabilityRequest,
      candidateChain: analystBinding.candidateChain,
      routeUsableInputTokens: analystBinding.routeUsableInputTokens,
      promptTemplates,
      restartCapability,
      provider: analystProvider,
      conversations,
      compactionPolicy,
      compactor,
      summarizerProvider,
      cardStore,
      runtimeCurrent: () => {
        const state = runtimeApi.getRuntimeState();
        return state === null ? { status: 'stopped' as const, currentCardId: null } : { status: state.status, currentCardId: state.current_card_id };
      },
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
    });
  const captureExecutingLlmSnapshots = (): ReadonlyMap<ConversationSessionId, ExecutingLlmSnapshot> => {
    const snapshots = new Map(runtimeSupervisor.captureAutonomousExecutingLlmSnapshots());
    const analystSnapshot = analystRuntimeCache?.executingLlmSnapshot();
    if (analystSnapshot) snapshots.set(analystSnapshot.sessionId, analystSnapshot);
    return snapshots;
  };

  return {
    runtimeApi,
    analystSessionId,
    cardStore,
    processRunner,
    captureExecutingLlmSnapshots,
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
