import type { SaivageConfig } from '../schemas/index.js';
import { runWorkGcOperation } from './work-gc-operation.js';
import type { WorkGcRequest, WorkGcResponse } from '../contracts/index.js';
import { createObservedCollections } from '../retrieval/index.js';
import {
  PublicationOutcomeUnknownError,
  WorkGcBusyError,
  type OutboundHttpEmitter,
} from '../contracts/index.js';
import {
  buildProviderRoutingReadModel,
  type ProviderRoutingReadModel,
  MemoryCandidateAvailability,
  ProviderRegistry,
  InvocationService,
  buildCandidateRequest,
  selectLlmProtocolAdapter,
  buildLlmOptions,
  supportsCapabilityRequest,
} from '../agents/execution-api.js';
import { AnalystRuntime, AnalystSession, type AnalystTurnInput } from '../runtime/runtime-api.js';
import type { McpToolInvocationPort } from '../mcp/manager-api.js';
import type { RuntimeApi } from '../runtime/runtime-api.js';

import { CardService } from '../cards/store-api.js';
import {
  createInvocationServiceProvider,
  executeInternalSummaryTurn,
} from './invocation-service-provider.js';
import { createSupervisorRuntimeApi, OversightSession } from '../runtime/runtime-api.js';
import { ProcessRunner } from '../runtime/runtime-api.js';
import type { ManagedProcessScope } from '../runtime/runtime-api.js';
import { RuntimeGate } from '../runtime/runtime-api.js';
import { createPromptTemplateRegistry } from '../utils/prompt-api.js';
import type { RestartCapability } from '../contracts/index.js';
import type { ResolvedConfigAuthority } from '../config/index.js';
import type { FreshnessEffects } from '../contracts/index.js';
import type { ConversationFileContext } from '../persistence/index.js';
import { materializeConversationImage } from '../persistence/session-api.js';
import { providerConversationRequiresImages } from '../contracts/index.js';
import { compact, shouldCompact, type AutonomousCompactionPolicy } from '../runtime/runtime-api.js';
import {
  admitSummaryRequest,
  assertSummarizerCapabilities,
  buildSummaryRequestInput,
  SUMMARY_COMPLETION_TOKENS,
  type SummarizerProviderPort,
  type SummaryRequestSerialization,
} from '../runtime/runtime-api.js';
import { SUMMARY_REFINE_INSTRUCTION } from '../runtime/runtime-api.js';
import type { CompactorPort } from '../runtime/runtime-api.js';
import type { LlmInvocationInput } from '../runtime/runtime-api.js';
import type { RuntimeProcessIdentity } from '../runtime/runtime-api.js';
import type { ConversationSessionId, GlobalConversationSessionId } from '../schemas/index.js';
import { executeToolAction } from '../tools/execution-api.js';
import { createAnalystOperationSurface } from './analyst-operation-surface.js';
import { ExternalAnalystOperations } from './external-analyst-operations.js';
import type { AnalystStartup } from '../config/index.js';
import { runtimeAgentBinding } from '../runtime/runtime-api.js';
import { EventQueryService } from './event-query-service.js';
import type { CompiledRuntimeWorkflows } from '../runtime/runtime-api.js';
import type { ApplicationFatalPort } from '../contracts/index.js';
import type { ExecutingLlmSnapshot } from '../runtime/runtime-api.js';
import {
  ProjectOversight,
  type OversightClock,
  type OversightStatus,
} from './project-oversight.js';
import { globalAgentSessionId } from '../schemas/index.js';
import { createOversightNotificationPort } from './oversight-notification-port.js';
import { submitNotificationTool, type QueueNotificationToolInput } from '../tools/tool-api.js';

export interface RuntimeApplication {
  collectWorkGarbage(request: WorkGcRequest, signal: AbortSignal): Promise<WorkGcResponse>;
  assertWorkGcIngressAllowed(): void;
  cancelWorkGc(reason: Error): void;
  runWorkGc<I, T>(input: {
    signal: AbortSignal;
    inventory(signal: AbortSignal): Promise<I>;
    collect(inventory: I, signal: AbortSignal): Promise<T>;
  }): Promise<{ value: T; restoredRunning: boolean }>;
  cleanupWorkGc(): Promise<void>;
  readonly analystAvailability: Readonly<{
    mode: AnalystStartup['mode'];
    internal_enabled: boolean;
    external_enabled: boolean;
  }>;
  readonly externalAnalystOperations: ExternalAnalystOperations | null;
  readonly runtimeApi: RuntimeApi;
  readonly cardStore: CardService;
  readonly processRunner: ProcessRunner;
  readonly analystRuntime: AnalystRuntime;
  readonly analystSessionId: import('../schemas/index.js').GlobalConversationSessionId;
  getOversightStatus(): OversightStatus;
  captureExecutingLlmSnapshots(): ReadonlyMap<ConversationSessionId, ExecutingLlmSnapshot>;
  closeRuntimeAdmission(): void;
  closeAnalystAdmission(): void;
  closeOversightAdmission(): void;
  cleanupRuntimeForApplicationStop(): Promise<void>;
  cleanupAnalystForApplicationStop(): Promise<void>;
  cleanupOversightForApplicationStop(): Promise<void>;
  getProviderRoutingReadModel(): ProviderRoutingReadModel;
}

interface RuntimeApplicationServices {
  assertWorkGcEntryIdle(): void;
  assertWorkGcReady(): void;
  analystStartup: AnalystStartup;
  externalProjectIdentityDigest: string | null;
  onExternalAnalystOwnerFailure(error: unknown): void;
  outboundHttp?: OutboundHttpEmitter;
  failedProviderDiagnostics?: string;
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
  onOversightOwnerFailure(error: unknown): void;
  oversightClock?: OversightClock;
}

export function createRuntimeApplication(services: RuntimeApplicationServices): RuntimeApplication {
  const { projectRoot, config, cardStore, restartCapability } = services;
  const eventQueries = new EventQueryService(projectRoot);
  const candidateAvailability = new MemoryCandidateAvailability();
  const conversations: ConversationFileContext = { projectRoot, changes: services.freshness };

  const registry = services.providerRegistry;
  const summarizerCandidate = registry.assertCandidate(config.compaction.summarizer_candidate);
  const summarizerCapabilities = registry.getEffectiveCapabilities(summarizerCandidate);
  assertSummarizerCapabilities(summarizerCapabilities);
  if (
    [...services.workflows.agentBindings.values()].some(
      (binding) => binding.capabilityRequest.requiresImages,
    ) &&
    !supportsCapabilityRequest(summarizerCapabilities, { requiresImages: true }).supported
  )
    throw new Error('Image-enabled agents require an image-compatible summary candidate.');
  const invocationService = new InvocationService({
    outboundHttp: services.outboundHttp,
    failedProviderDiagnostics: services.failedProviderDiagnostics,
    projectRoot,
    registry,
    candidateAvailability,
    freshness: services.freshness,
  });
  const summarizerSerializeRequest = (input: LlmInvocationInput): SummaryRequestSerialization => {
    const maxTokens = input.modelParams.maxTokens;
    if (maxTokens === undefined)
      throw new Error(
        'Summary request serialization requires an explicit completion token request.',
      );
    const candidate = registry.assertCandidate(config.compaction.summarizer_candidate);
    const capabilities = registry.getEffectiveCapabilities(candidate);
    if (
      providerConversationRequiresImages(input.providerConversation) &&
      !supportsCapabilityRequest(capabilities, { requiresImages: true }).supported
    )
      throw new Error('Selected summary candidate cannot consume images.');
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
        { projectRoot, sessionId: input.sessionId },
      ),
    });
    return {
      serializedRequest: plan.request.serializedBody,
      requestSha256: plan.request.requestHash,
      estimatedInputTokens: plan.request.estimatedWireInputTokens,
      imageCount: plan.request.imageCount,
    };
  };
  const summarizerProvider: SummarizerProviderPort = {
    materializeImage: (sourceSessionId, descriptor) =>
      materializeConversationImage(projectRoot, sourceSessionId, descriptor),
    candidate: summarizerCandidate,
    contextWindowTokens: summarizerCapabilities.contextWindowTokens,
    maxOutputTokens: summarizerCapabilities.maxOutputTokens,
    serializeSummaryRequest: summarizerSerializeRequest,
    completeTurn: (input, admitted, signal) =>
      executeInternalSummaryTurn(invocationService, input, signal, admitted),
    projectProviderExchanges: (sessionId, purpose, sourceInputId, attempts, context) =>
      invocationService.projectProviderExchanges(
        sessionId,
        purpose,
        sourceInputId,
        attempts,
        context,
      ),
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
    throw new Error(
      `The invariant compaction summary request overhead plus ${SUMMARY_COMPLETION_TOKENS} requested output tokens does not fit the configured fixed candidate capacity.`,
    );
  const compactionPolicy: AutonomousCompactionPolicy = {
    context_utilization_fraction: config.compaction.context_utilization_fraction,
    trigger_fraction: config.compaction.trigger_fraction,
    tail_fraction: config.compaction.tail_fraction,
    snap: config.compaction.snap,
  };
  const compactor: CompactorPort = { shouldCompact, compact };
  const retrieval = createObservedCollections(projectRoot);
  const processRunner = services.processRunner;
  const runtimeGate = new RuntimeGate();
  const promptTemplates = createPromptTemplateRegistry(services.workflows);
  const workflows = services.workflows;
  const oversightBinding = runtimeAgentBinding(workflows, workflows.oversight.name);
  let workGcTask: Promise<unknown> | null = null;
  let workGcAbort: AbortController | null = null;
  const cancelWorkGc = (reason: Error): void => {
    workGcAbort?.abort(reason);
  };
  const runtimeSupervisor = createSupervisorRuntimeApi({
    cancelWorkGc,
    outboundHttp: services.outboundHttp,
    projectRoot,
    processIdentity: services.processIdentity,
    actorStore: cardStore,
    provider: createInvocationServiceProvider(invocationService, projectRoot),
    promptTemplates,
    workflows,
    compactionConfig: compactionPolicy,
    compactor,
    summarizerProvider,
    processRunner,
    runtimeProcessRootScope: services.runtimeProcessRootScope,
    runtimeGate,
    mcpToolInvocation: services.mcpToolInvocation,
    retrieval,
    conversations,
    freshness: services.freshness,
    fatalPort: services.fatalPort,
    runtimeStatusChanged: (status) => projectOversight?.runtimeStatusChanged(status),
  });
  const runtimeApi: RuntimeApi = runtimeSupervisor;
  const runtimeObservation = Object.freeze({ getStatus: runtimeApi.getStatus.bind(runtimeApi) });
  const analystSessionId = services.analystSessionId;
  const internalAnalystRootScope = processRunner.createContainerScope(
    services.analystProcessRootScope,
    'internal-analyst',
  );
  let analystRuntimeCache: AnalystRuntime | null = null;
  const createAnalystSession = (_turn: AnalystTurnInput): AnalystSession => {
    const analystBinding = runtimeAgentBinding(workflows, workflows.analyst.name);
    const directScope = processRunner.createDirectScope(
      internalAnalystRootScope,
      `analyst-session:${analystSessionId}`,
      'operator_session',
    );
    const createInvocationSurface = () => {
      return createAnalystOperationSurface({
        workflows,
        author: { kind: 'agent', agent: workflows.analyst.name },
        allowedTools: analystBinding.toolSet.names,
        outboundHttp: services.outboundHttp,
        submitNotification: runtimeApi.submitNotification.bind(runtimeApi),
        cancelCard: runtimeApi.cancelCard.bind(runtimeApi),
        currentProcessPosition: (cardId) =>
          runtimeApi.getActorRuntimeReadModel().cards.find((card) => card.cardId === cardId)
            ?.processState ?? null,
        context: {
          assertGlobalSourceWrite: runtimeApi.assertGlobalSourceWrite.bind(runtimeApi),
          cardTypeVocabulary: workflows.cardTypeVocabulary,
          projectRoot,
          configAuthority: services.configAuthority,
          interventionReadiness: runtimeSupervisor,
          processRunner,
          processScope: directScope,
          qualityProcessParentScope: internalAnalystRootScope,
          store: cardStore,
          sessionId: analystSessionId,
          runtime: Object.freeze({
            startProject: runtimeApi.startProject.bind(runtimeApi),
            pause: runtimeApi.pause.bind(runtimeApi),
            hasWorkGcMaintenanceHold: runtimeApi.hasWorkGcMaintenanceHold.bind(runtimeApi),
            resume: runtimeApi.resume.bind(runtimeApi),
            stopProject: runtimeApi.stopProject.bind(runtimeApi),
            notifyCard: runtimeApi.notifyCard.bind(runtimeApi),
            getStatus: runtimeApi.getStatus.bind(runtimeApi),
          }),
          mcpToolInvocation: services.mcpToolInvocation,
          retrieval,
          restartCapability,
          eventQueries,
          captureExecutingLlmSnapshots,
        },
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
      provider: createInvocationServiceProvider(invocationService, projectRoot),
      conversations,
      compactionPolicy,
      compactor,
      summarizerProvider,
      cardStore,
      runtimeCurrent: () => {
        const state = runtimeApi.getRuntimeState();
        return state === null
          ? { status: 'stopped' as const, currentCardId: null }
          : { status: state.status, currentCardId: state.current_card_id };
      },
      runtimeProjectionChanged: () =>
        services.freshness.agentMembershipChanged({
          scope: 'global-session',
          sessionId: analystSessionId,
        }),
      createInvocationSurface,
      shutdownProcesses,
      fatalPort: services.fatalPort,
      cardTypeVocabulary: workflows.cardTypeVocabulary,
    });
  };
  const getAnalystToolNames = (): string[] => workflows.analyst.tools.map(({ name }) => name);
  const terminateAnalystRoot = (reason: string) =>
    processRunner.terminateScopeTree({
      rootScope: internalAnalystRootScope,
      categories: ['operator_session'],
      reason,
    });
  const captureExecutingLlmSnapshots = (): ReadonlyMap<
    ConversationSessionId,
    ExecutingLlmSnapshot
  > => {
    const snapshots = new Map(runtimeSupervisor.captureAutonomousExecutingLlmSnapshots());
    const analystSnapshot = analystRuntimeCache?.executingLlmSnapshot();
    if (analystSnapshot) snapshots.set(analystSnapshot.sessionId, analystSnapshot);
    const oversightSnapshot = projectOversight?.executingLlmSnapshot();
    if (oversightSnapshot) snapshots.set(oversightSnapshot.sessionId, oversightSnapshot);
    return snapshots;
  };
  const oversightSessionId = globalAgentSessionId(workflows.oversight.name);
  const oversightProvider = createInvocationServiceProvider(invocationService, projectRoot);
  const projectOversight = new ProjectOversight({
    enabled: config.oversight.enabled,
    intervalMs: config.oversight.interval_seconds * 1000,
    agentName: workflows.oversight.name,
    sessionId: oversightSessionId,
    serviceEpoch: services.processIdentity.startedAt,
    clock: services.oversightClock,
    changed: () => services.freshness.runtimeChanged(),
    onOwnerFailure: services.onOversightOwnerFailure,
    createCheck: () => {
      const submitNotification = createOversightNotificationPort({
        oversight: projectOversight,
        cards: cardStore,
        workflows,
        submitNotification: runtimeApi.submitNotification.bind(runtimeApi),
      });
      const observationToolContext = {
        agentName: workflows.oversight.name,
        projectRoot,
        store: cardStore,
        processRunner,
        eventQueries,
        runtime: runtimeObservation,
        queueNotification: (input: QueueNotificationToolInput, signal: AbortSignal) =>
          executeToolAction('none', () =>
            submitNotificationTool(input, submitNotification, signal),
          ),
        captureExecutingLlmSnapshots,
        currentProcessPosition: (cardId: string) =>
          runtimeApi.getActorRuntimeReadModel().cards.find((card) => card.cardId === cardId)
            ?.processState ?? null,
      };
      const surface = oversightBinding.toolSet.bind({
        outboundHttp: services.outboundHttp,
        scope: 'global',
        nativeGit: workflows.gitPolicy !== null,
        assertGlobalSourceWrite: runtimeApi.assertGlobalSourceWrite.bind(runtimeApi),
        agentName: workflows.oversight.name,
        projectRoot,
        store: cardStore,
        processRunner,
        mcpToolInvocation: services.mcpToolInvocation,
        observationToolContext,
        cardTypeVocabulary: workflows.cardTypeVocabulary,
      });
      return new OversightSession({
        sessionId: oversightSessionId,
        agentName: workflows.oversight.name,
        surface,
        provider: oversightProvider,
        conversations,
        promptTemplates,
        modelParams: oversightBinding.contract.model,
        capabilityRequest: oversightBinding.capabilityRequest,
        candidateChain: oversightBinding.candidateChain,
        routeUsableInputTokens: oversightBinding.routeUsableInputTokens,
        compactionPolicy,
        compactor,
        summarizerProvider,
        runtimeProjectionChanged: () =>
          services.freshness.agentMembershipChanged({
            scope: 'global-session',
            sessionId: oversightSessionId,
          }),
        fatalPort: services.fatalPort,
        cardTypeVocabulary: workflows.cardTypeVocabulary,
      });
    },
  });

  const analystAvailability = Object.freeze({
    mode: services.analystStartup.mode,
    internal_enabled: services.analystStartup.mode !== 'external',
    external_enabled: services.analystStartup.mode !== 'internal',
  });
  let externalAnalystOperations: ExternalAnalystOperations | null = null;
  if (services.analystStartup.mode !== 'internal') {
    const startup = services.analystStartup;
    if (services.externalProjectIdentityDigest === null)
      throw new Error('External Analyst requires the established project identity.');
    const directScope = processRunner.createDirectScope(
      services.analystProcessRootScope,
      `external:${startup.principal}`,
      'operator_session',
    );
    externalAnalystOperations = new ExternalAnalystOperations({
      assertIngressAllowed: () => runtimeSupervisor.assertWorkGcIngressAllowed(),
      projectRoot,
      principal: startup.principal,
      projectIdentityDigest: services.externalProjectIdentityDigest,
      processRunner,
      directScope,
      fatalPort: services.fatalPort,
      onOwnerFailure: services.onExternalAnalystOwnerFailure,
      surface: createAnalystOperationSurface({
        workflows,
        author: { kind: 'external-agent', principal: startup.principal },
        allowedTools: startup.tools,
        submitNotification: runtimeApi.submitNotification.bind(runtimeApi),
        cancelCard: runtimeApi.cancelCard.bind(runtimeApi),
        outboundHttp: services.outboundHttp,
        currentProcessPosition: (cardId) =>
          runtimeApi.getActorRuntimeReadModel().cards.find((card) => card.cardId === cardId)
            ?.processState ?? null,
        context: {
          cardTypeVocabulary: workflows.cardTypeVocabulary,
          assertGlobalSourceWrite: runtimeApi.assertGlobalSourceWrite.bind(runtimeApi),
          projectRoot,
          configAuthority: services.configAuthority,
          interventionReadiness: runtimeSupervisor,
          processRunner,
          processScope: directScope,
          qualityProcessParentScope: services.analystProcessRootScope,
          store: cardStore,
          runtime: {
            startProject: runtimeApi.startProject.bind(runtimeApi),
            pause: runtimeApi.pause.bind(runtimeApi),
            hasWorkGcMaintenanceHold: runtimeApi.hasWorkGcMaintenanceHold.bind(runtimeApi),
            resume: runtimeApi.resume.bind(runtimeApi),
            stopProject: runtimeApi.stopProject.bind(runtimeApi),
            notifyCard: runtimeApi.notifyCard.bind(runtimeApi),
            getStatus: runtimeApi.getStatus.bind(runtimeApi),
          },
          mcpToolInvocation: services.mcpToolInvocation,
          retrieval,
          restartCapability,
          eventQueries,
          captureExecutingLlmSnapshots,
        },
      }),
    });
  }
  return {
    collectWorkGarbage(request, signal) {
      return runWorkGcOperation({ ...services, request, signal, run: this.runWorkGc.bind(this) });
    },
    assertWorkGcIngressAllowed: () => runtimeSupervisor.assertWorkGcIngressAllowed(),
    cancelWorkGc: (reason) => runtimeSupervisor.cancelWorkGc(reason),
    runWorkGc(input) {
      if (workGcTask) return Promise.reject(new WorkGcBusyError());
      const abort = new AbortController();
      workGcAbort = abort;
      const signal = AbortSignal.any([input.signal, abort.signal]);
      const task = Promise.resolve().then(async () => {
        signal.throwIfAborted();
        const inventory = await input.inventory(signal);
        signal.throwIfAborted();
        return runtimeSupervisor.withWorkGcMaintenance({
          signal,
          assertEntryIdle: services.assertWorkGcEntryIdle,
          settleAcceptedWork: async () => {
            await Promise.all([
              analystRuntimeCache?.awaitNaturalTurnCompletion(),
              externalAnalystOperations?.awaitAcceptedOperations(),
              projectOversight.awaitCancelledCheck(),
            ]);
          },
          assertReady: services.assertWorkGcReady,
          collect: (heldSignal) => input.collect(inventory, heldSignal),
        });
      });
      workGcTask = task;
      void task.then(
        () => {
          workGcTask = null;
          workGcAbort = null;
        },
        (error) => {
          if (error instanceof PublicationOutcomeUnknownError)
            services.fatalPort.publicationOutcomeUnknown(error);
          workGcTask = null;
          workGcAbort = null;
        },
      );
      return task;
    },
    async cleanupWorkGc() {
      cancelWorkGc(new Error('Application closing.'));
      // Ordinary GC refusal/cancellation is not an application cleanup failure.
      try {
        await workGcTask;
      } catch (error) {
        if (error instanceof PublicationOutcomeUnknownError)
          services.fatalPort.publicationOutcomeUnknown(error);
      }
    },
    analystAvailability,
    externalAnalystOperations,
    runtimeApi,
    analystSessionId,
    cardStore,
    processRunner,
    captureExecutingLlmSnapshots,
    getOversightStatus: () => projectOversight.status(),
    get analystRuntime() {
      analystRuntimeCache ??= new AnalystRuntime({
        assertIngressAllowed: () => runtimeSupervisor.assertWorkGcIngressAllowed(),
        internalEnabled: analystAvailability.internal_enabled,
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
    closeOversightAdmission() {
      projectOversight.closeAdmission();
    },
    cleanupRuntimeForApplicationStop() {
      return runtimeSupervisor.cleanupForApplicationStop();
    },
    cleanupAnalystForApplicationStop() {
      return analystRuntimeCache
        ? analystRuntimeCache.cleanupForApplicationStop()
        : Promise.resolve();
    },
    cleanupOversightForApplicationStop() {
      return projectOversight.cleanupForApplicationStop();
    },
    getProviderRoutingReadModel() {
      return buildProviderRoutingReadModel({
        registry,
        availability: candidateAvailability,
      });
    },
  };
}
