import { EventEmitter } from 'node:events';
import type { SaivageConfig, RuntimeSection } from './config-schema.js';
import { getRuntimeConfig, getModelParamsForRole } from './config-schema.js';
import { ProviderRegistry } from './provider.js';
import { ModelRouter } from './model-router.js';
import {
  type CandidateAvailability,
  MemoryCandidateAvailability,
} from './candidate-availability.js';
import {
  createSession,
  completeSession,
  appendMessage as appendPersistentMessage,
  getSession,
  getSessionMessages,
  markSessionWaiting,
  setSessionStatus,
  updateSessionModel,
  assertNoActiveAgentSession,
} from './session-persistence.js';
import type {
  AgentInvocationRole,
  AgentMessage,
  HandoffSummary,
  OperationalAgentRole,
  LlmAttemptOutcome,
  LlmFailureClass,
  RuntimeState,
  RuntimeActivationRecord,
} from '../schemas/index.js';
import type { TypedEventEmitter } from '../events/index.js';
import type { NotificationCenter } from '../notifications/index.js';
import type { ContentSupervisor } from '../workspace/index.js';
import { getSafeFileForAgent, type SafeFileResult } from '../workspace/index.js';
import type {
  AgentExecutionPort,
  PlannerInvocationRequest,
  ExecutorInvocationRequest,
  ReviewerInvocationRequest,
  SessionReinvokeRequest,
  RuntimeActivationLedgerPort,
  PlannerActivationBarrier,
  PlannerResult,
  ExecutorResult,
  ReviewerResult,
} from '../contracts/index.js';
import type { LlmCallFn } from './llm-contracts.js';
import { serializeToolCallMessage } from '../contracts/persisted-tool-call.js';
import { LlmRequestError } from '../contracts/llm-failure.js';
import { capabilityRequestForLlmOptions } from './provider-capabilities.js';
import { generateRoundId } from '../schemas/round-id-server.js';
import {
  defaultInvocationRecoveryPolicy,
  type InvocationRecoveryContext,
} from './invocation-recovery-policy.js';
import { EventLogger } from '../observability/index.js';
import { buildReviewerPrompt } from './system-prompt.js';
import type { McpToolInvocationPort } from '../mcp/manager-api.js';
import { SkillsEngine } from './skills-engine.js';
import { getProjectNotificationCenter } from '../notifications/notification-delivery.js';
import type { CardStore } from '../cards/store-api.js';
import { injectQueuedSyntheticPlannerNotes } from '../runtime/synthetic-planner-notes.js';
import { PlannerControlExecutor } from './planner-control-executor.js';
import { ContextCompactor } from './context-compactor.js';
import type { Contract } from '../contracts/contract.js';
import {
  createPlannerContract,
  type PlannerEnvelope,
  type PlannerTypedResult,
} from '../contracts/planner-contract.js';
import { createExecutorContract } from '../contracts/executor-contract.js';
import { createReviewerContract } from '../contracts/reviewer-contract.js';
import type { ExecutorResultEnvelope } from '../contracts/executor-envelope.js';
import type { ReviewerResultEnvelope } from '../contracts/reviewer-envelope.js';
import { createContractVerifier } from './contract-verifier.js';
import { createAgentLoopDriver, type AgentLoopDriverIO } from './agent-loop-driver.js';
import { createRepairBudget } from './invocation-outcome.js';
import { redactTextForOutbound } from '../redaction/index.js';
import { ToolRuntime, AGENT_TOOL_DEFINITIONS } from '../tools/index.js';
import { AgentSessionCoordinator, type SessionCreatedHook } from './agent-session-coordinator.js';
import { AgentToolExecutor } from './agent-tool-executor.js';
import { InvocationService } from './invocation-service.js';
import { applyRuntimeMutation } from '../runtime/mutations.js';
import { planClearActiveCardRunPatch } from '../runtime/runtime-core.js';
import { readRuntimeState } from '../runtime/state.js';
import { SessionStampCounter } from '../runtime/session-stamp-counter.js';
import { AttemptRecorder } from './attempt-recorder.js';
import { PlannerEnvelopeTracker } from './planner-envelope-tracker.js';
import { SessionMessageLog } from './session-message-log.js';

export type AgentRole = OperationalAgentRole;
export type InvokableAgentRole = AgentInvocationRole;

interface AgentRecoveryContext {
  attempt: number;
  maxAttempts: number;
  isRecovery: boolean;
  previousError?: Error;
  directive: string;
}

interface AgentInvocationAttempt<R> {
  attempt: number;
  success: boolean;
  result?: R;
  error?: Error;
}

export interface AgentAdapterConfig {
  projectRoot: string;
  saivageDir: string;
  config: SaivageConfig;
  eventBus?: EventEmitter;
  eventLogger?: EventLogger;
  activationLedger?: RuntimeActivationLedgerPort;
  candidateAvailability?: CandidateAvailability;
  cardStore?: CardStore;
  runtimeStateProvider?: () => RuntimeState | null;
  contextCompactor?: ContextCompactor;
  invocationService?: InvocationService;
  llmCallFn?: LlmCallFn;
}

function delayInvocationRecovery(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

function buildRecoveryDirective(previousError: Error | undefined): string {
  return `RECOVERY DIRECTIVE: Your previous invocation failed. Please re-read authoritative state from disk (cards, notes, plan diary) to understand the current state before proceeding. Previous error: ${previousError?.message ?? 'Unknown error'}`;
}

export class AgentAdapter implements AgentExecutionPort {
  readonly projectRoot: string;
  readonly saivageDir: string;
  readonly config: SaivageConfig;
  readonly runtimeConfig: RuntimeSection;
  readonly registry: ProviderRegistry;
  readonly router: ModelRouter;
  readonly candidateAvailability: CandidateAvailability;
  readonly notificationCenter: NotificationCenter;
  eventBus?: EventEmitter;
  private runtimeLedgerEventBus?: TypedEventEmitter;
  readonly eventLogger?: EventLogger;
  private contentSupervisor?: ContentSupervisor;
  private _mcpManager: McpToolInvocationPort | undefined;
  private _skillsEngine: SkillsEngine | undefined;
  private activationLedger?: RuntimeActivationLedgerPort;
  private readonly plannerControlExecutor: PlannerControlExecutor;
  private readonly toolRuntime: ToolRuntime<typeof AGENT_TOOL_DEFINITIONS>;
  private readonly sessionCoordinator: AgentSessionCoordinator;
  private readonly messageLog: SessionMessageLog;
  private readonly toolExecutor: AgentToolExecutor;
  private readonly invocationService: InvocationService;
  private readonly cardStore: CardStore;
  private readonly runtimeStateProvider?: () => RuntimeState | null;
  private readonly contextCompactor: ContextCompactor;

  constructor(cfg: AgentAdapterConfig) {
    this.projectRoot = cfg.projectRoot;
    this.saivageDir = cfg.saivageDir;
    this.config = cfg.config;
    this.runtimeConfig = getRuntimeConfig(cfg.config);
    this.registry = new ProviderRegistry(cfg.config);
    this.candidateAvailability = cfg.candidateAvailability ?? new MemoryCandidateAvailability();
    this.router = new ModelRouter(
      cfg.config,
      this.registry,
      cfg.projectRoot,
      this.candidateAvailability,
    );
    this.notificationCenter = getProjectNotificationCenter(cfg.projectRoot);
    this.eventBus = cfg.eventBus;
    this.eventLogger = cfg.eventLogger;
    this.activationLedger = cfg.activationLedger;
    if (!cfg.cardStore) throw new Error('AgentAdapter requires a composition-owned CardStore.');
    this.cardStore = cfg.cardStore;
    this.runtimeStateProvider = cfg.runtimeStateProvider;
    this.contextCompactor = cfg.contextCompactor ?? new ContextCompactor({
      saivageDir: this.saivageDir,
      sessionStamper: new SessionStampCounter(),
    });
    this.toolRuntime = new ToolRuntime(
      { cardStore: this.cardStore, bus: cfg.eventBus },
      AGENT_TOOL_DEFINITIONS,
    );
    this.plannerControlExecutor = new PlannerControlExecutor({
      cardStore: this.cardStore,
      projectRoot: this.projectRoot,
      saivageDir: this.saivageDir,
      runtimeStateProvider: () => this.activationLedger?.readState() ?? null,
      activationLedger: {
        readState: () => this.activationLedger?.readState() ?? null,
        appendRun: (input) => this.activationLedger!.appendRun(input),
        upsertActivation: (input) => this.activationLedger!.upsertActivation(input),
      },
      reviewer: async (goalId, assessmentId, reviewerSessionId, report, parentSessionId) => {
        if (parentSessionId) markSessionWaiting(this.saivageDir, parentSessionId);
        try {
          const reviewerContract = createReviewerContract({ goalId, assessmentId });
          return (
            await this.invokeReviewer({
              goalId,
              systemPrompt: buildReviewerPrompt(reviewerContract),
              contextMessages: [
                {
                  id: `review-report:${assessmentId}`,
                  session_id: reviewerSessionId,
                  role: 'user',
                  kind: 'text',
                  content: `The planner reports the following terminal outcome for goal '${goalId}'. Evaluate against the goal's acceptance criteria and respond with the canonical ReviewerResult JSON envelope.\n\n${JSON.stringify(report, null, 2)}`,
                  round_id: generateRoundId('user'),
                  message_index: 0,
                  block_index: 0,
                  timestamp: new Date().toISOString(),
                },
              ],
              assessmentId,
              reviewerSessionId,
              contract: reviewerContract,
            })
          ).assessment;
        } finally {
          if (parentSessionId) setSessionStatus(this.saivageDir, parentSessionId, 'active');
        }
      },
      maxReviewRetries: this.runtimeConfig?.maxReviewRetries ?? 3,
      assessmentIdFactory: undefined,
      eventBusProvider: () => this.runtimeLedgerEventBus,
      eventLogger: this.eventLogger,
    });
    this.sessionCoordinator = new AgentSessionCoordinator({
      saivageDir: this.saivageDir,
      notificationCenter: this.notificationCenter,
      eventBus: this.eventBus,
      eventLogger: this.eventLogger,
    });
    this.messageLog = new SessionMessageLog(this.saivageDir);
    this.toolExecutor = new AgentToolExecutor({
      projectRoot: this.projectRoot,
      toolRuntime: this.toolRuntime,
      plannerControlExecutor: this.plannerControlExecutor,
      getMcpManager: () => this._mcpManager,
      getSkillsEngine: () => this._skillsEngine,
      getContentSupervisor: () => this.contentSupervisor,
    });
    this.invocationService = cfg.invocationService ?? new InvocationService({
      projectRoot: this.projectRoot,
      saivageDir: this.saivageDir,
      registry: this.registry,
      router: this.router,
      eventLogger: this.eventLogger,
      candidateAvailability: this.candidateAvailability,
      recoveryDelayMs: this.runtimeConfig?.recoveryDelayMs,
      maxRecoveryRetries: this.runtimeConfig?.maxRecoveryRetries,
      llmCallFn: cfg.llmCallFn,
    });
  }

  setEventBus(eventBus: EventEmitter): void {
    this.eventBus = eventBus;
    this.sessionCoordinator.setEventBus(eventBus);
  }
  setRuntimeLedgerEventBus(eventBus: TypedEventEmitter): void {
    this.runtimeLedgerEventBus = eventBus;
  }
  setActivationLedger(activationLedger: RuntimeActivationLedgerPort): void {
    this.activationLedger = activationLedger;
  }
  setContentSupervisor(supervisor: ContentSupervisor): void {
    this.contentSupervisor = supervisor;
  }
  getContentSupervisor(): ContentSupervisor | undefined {
    return this.contentSupervisor;
  }
  setMcpManager(mcpManager: McpToolInvocationPort): void {
    this._mcpManager = mcpManager;
  }
  getMcpManager(): McpToolInvocationPort | undefined {
    return this._mcpManager;
  }
  setSkillsEngine(engine: SkillsEngine): void {
    this._skillsEngine = engine;
  }
  getSkillsEngine(): SkillsEngine | undefined {
    return this._skillsEngine;
  }
  setAfterSessionCreatedHook(hook: SessionCreatedHook | null): void {
    this.sessionCoordinator.setAfterSessionCreatedHook(hook);
  }

  public getToolNamesForRole(role: AgentRole): string[] {
    return this.toolExecutor.getToolNamesForRole(role);
  }
  private buildToolsForRole(role: AgentRole) {
    return this.toolExecutor.buildToolsForRole(role);
  }

  async callMcpTool(
    role: AgentRole,
    serverName: string,
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    return this.toolExecutor.callMcpTool(role, serverName, toolName, args);
  }

  getSafeFileContent(filePath: string, content: string): SafeFileResult {
    return getSafeFileForAgent(filePath, content);
  }
  private redactModelIssueText(message: unknown): string {
    return redactTextForOutbound(message, 'model.issue', { source: 'agent-adapter' });
  }
  private redactProviderErrorMessage(message: unknown): string {
    return redactTextForOutbound(message, 'model.issue', { source: 'agent-adapter' });
  }
  cancelSession(sessionId: string): boolean {
    return this.sessionCoordinator.cancelSession(sessionId);
  }
  forceCancelSession(sessionId: string): boolean {
    return this.sessionCoordinator.forceCancelSession(sessionId);
  }
  getHandoffSummary(sessionId: string): HandoffSummary | null {
    return this.sessionCoordinator.getHandoffSummary(sessionId);
  }
  getActiveSessionHandoffs(): HandoffSummary[] {
    return this.sessionCoordinator.getActiveSessionHandoffs();
  }
  async invokePlanner(request: PlannerInvocationRequest): Promise<PlannerResult>;
  async invokePlanner(
    goalId: string,
    systemPrompt?: string,
    contextMessages?: AgentMessage[],
  ): Promise<PlannerResult>;
  async invokePlanner(
    requestOrGoalId: PlannerInvocationRequest | string,
    systemPrompt: string = '',
    contextMessages: AgentMessage[] = [],
  ): Promise<PlannerResult> {
    const goalId = typeof requestOrGoalId === 'string' ? requestOrGoalId : requestOrGoalId.goalId;
    const contract =
      typeof requestOrGoalId === 'string'
        ? createPlannerContract({ goalId, parentSessionId: '' })
        : requestOrGoalId.contract;
    const request: PlannerInvocationRequest =
      typeof requestOrGoalId === 'string'
        ? { goalId, systemPrompt, contextMessages, contract }
        : requestOrGoalId;
    const plannerSessionId = `planner:${request.goalId}`;
    const existing = getSession(this.saivageDir, plannerSessionId);
    if (existing)
      injectQueuedSyntheticPlannerNotes(this.projectRoot, plannerSessionId, {
        stampUserMessage: (id: string) => this.nextFallbackRound(id, 'user'),
      });
    const typedResult = await this.invokeAgent<PlannerEnvelope, PlannerTypedResult>(
      'planner',
      request.goalId,
      request.goalId,
      request.systemPrompt ?? '',
      request.contextMessages ?? [],
      contract,
      undefined,
      request.activationBarrier,
    );
    return typedResult.result;
  }
  async invokeExecutor(request: ExecutorInvocationRequest): Promise<ExecutorResult>;
  async invokeExecutor(
    cardId: string,
    goalId: string,
    systemPrompt?: string,
    contextMessages?: AgentMessage[],
  ): Promise<ExecutorResult>;
  async invokeExecutor(
    requestOrCardId: ExecutorInvocationRequest | string,
    goalId?: string,
    systemPrompt: string = '',
    contextMessages: AgentMessage[] = [],
  ): Promise<ExecutorResult> {
    const cardId = typeof requestOrCardId === 'string' ? requestOrCardId : requestOrCardId.cardId;
    const resolvedGoalId =
      typeof requestOrCardId === 'string' ? (goalId ?? '') : requestOrCardId.goalId;
    const contract =
      typeof requestOrCardId === 'string'
        ? createExecutorContract({ cardId, goalId: resolvedGoalId })
        : requestOrCardId.contract;
    const request: ExecutorInvocationRequest =
      typeof requestOrCardId === 'string'
        ? { cardId, goalId: resolvedGoalId, systemPrompt, contextMessages, contract }
        : requestOrCardId;
    return this.invokeAgent<ExecutorResultEnvelope, ExecutorResult>(
      'executor',
      request.goalId,
      request.cardId,
      request.systemPrompt ?? '',
      request.contextMessages ?? [],
      contract,
    );
  }
  async invokeReviewer(request: ReviewerInvocationRequest): Promise<ReviewerResult>;
  async invokeReviewer(
    goalId: string,
    systemPrompt?: string,
    contextMessages?: AgentMessage[],
    options?: { assessmentId?: string; reviewerSessionId?: string },
  ): Promise<ReviewerResult>;
  async invokeReviewer(
    requestOrGoalId: ReviewerInvocationRequest | string,
    systemPrompt: string = '',
    contextMessages: AgentMessage[] = [],
    options: { assessmentId?: string; reviewerSessionId?: string } = {},
  ): Promise<ReviewerResult> {
    const goalId = typeof requestOrGoalId === 'string' ? requestOrGoalId : requestOrGoalId.goalId;
    const assessmentId =
      typeof requestOrGoalId === 'string' ? options.assessmentId : requestOrGoalId.assessmentId;
    const contract =
      typeof requestOrGoalId === 'string'
        ? createReviewerContract({ goalId, assessmentId: assessmentId ?? '' })
        : requestOrGoalId.contract;
    const request: ReviewerInvocationRequest =
      typeof requestOrGoalId === 'string'
        ? {
            goalId,
            systemPrompt,
            contextMessages,
            assessmentId: options.assessmentId,
            reviewerSessionId: options.reviewerSessionId,
            contract,
          }
        : requestOrGoalId;
    return this.invokeAgent<ReviewerResultEnvelope, ReviewerResult>(
      'reviewer',
      request.goalId,
      request.goalId,
      request.systemPrompt ?? '',
      request.contextMessages ?? [],
      contract,
      request.reviewerSessionId,
    );
  }
  async reinvokeSession(request: SessionReinvokeRequest): Promise<ExecutorResult | ReviewerResult>;
  async reinvokeSession(
    sessionId: string,
    systemPrompt?: string,
    contextMessages?: AgentMessage[],
  ): Promise<ExecutorResult | ReviewerResult>;
  async reinvokeSession(
    requestOrSessionId: SessionReinvokeRequest | string,
    systemPrompt: string = '',
    contextMessages: AgentMessage[] = [],
  ): Promise<ExecutorResult | ReviewerResult> {
    const request: SessionReinvokeRequest =
      typeof requestOrSessionId === 'string'
        ? { sessionId: requestOrSessionId, systemPrompt, contextMessages }
        : requestOrSessionId;
    const session = getSession(this.saivageDir, request.sessionId);
    if (!session) throw new Error(`Session not found: ${request.sessionId}`);
    if (session.role === 'executor') {
      const cardId = session.card_id ?? session.goal_card_id ?? '';
      const reGoalId = session.goal_card_id ?? '';
      return this.invokeExecutor({
        cardId,
        goalId: reGoalId,
        systemPrompt: request.systemPrompt,
        contextMessages: request.contextMessages,
        contract: createExecutorContract({ cardId, goalId: reGoalId }),
      });
    }
    if (session.role === 'reviewer') {
      const reGoalId = session.goal_card_id ?? '';
      return this.invokeReviewer({
        goalId: reGoalId,
        systemPrompt: request.systemPrompt,
        contextMessages: request.contextMessages,
        reviewerSessionId: session.id,
        contract: createReviewerContract({ goalId: reGoalId, assessmentId: '' }),
      });
    }
    throw new Error(`Session '${request.sessionId}' is not reinvokable.`);
  }

  private async processToolCall(
    tc: { id: string; type: string; function: { name: string; arguments: string } },
    role: AgentRole,
    sessionId: string,
    invocation?: { goalId?: string; cardId?: string },
  ) {
    return this.toolExecutor.processToolCall(tc, role, sessionId, invocation);
  }

  private buildModelMessages(sessionId: string, role?: AgentRole, goalId?: string): AgentMessage[] {
    return this.contextCompactor.compactPlannerInMemory(
      sessionId,
      this.sessionCoordinator.buildModelMessages(sessionId),
      role,
      { contextLimit: 24000, threshold: 1 },
      {
        projectRoot: this.projectRoot,
        goalId: goalId ?? sessionId.replace(/^planner:/, ''),
        cardStore: this.cardStore,
        runtimeStateProvider: this.runtimeStateProvider,
      },
    );
  }

  private nextFallbackRound(
    sessionId: string,
    prefix: 'pre' | 'user' | 'assistant' | 'diagnostic' = 'assistant',
  ) {
    return this.messageLog.nextFallbackRound(sessionId, prefix);
  }
  private stampInCurrentFallbackRound(sessionId: string) {
    return this.messageLog.stampInCurrentFallbackRound(sessionId);
  }
  private appendSessionMessage(sessionId: string, message: Parameters<SessionMessageLog['append']>[1]) {
    return this.messageLog.append(sessionId, message);
  }

  private compensateActivationBarrierThrow(
    sessionId: string,
    toolCallId: string,
    activation: RuntimeActivationRecord,
    error: unknown,
  ): void {
    const messages = getSessionMessages(this.saivageDir, sessionId);
    const alreadyResolved = messages.some(
      (message) =>
        (message.kind === 'tool_result' || message.kind === 'tool_error') &&
        message.tool_call_id === toolCallId,
    );
    if (!alreadyResolved) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.appendSessionMessage(sessionId, {
        role: 'tool',
        kind: 'tool_error',
        content: JSON.stringify({
          error: 'activation_barrier_dispatch_failed',
          message: this.redactProviderErrorMessage(errorMessage),
          child_card_id: activation.child_card_id,
          activation_id: activation.activation_id,
        }),
        tool: 'activate_card',
        tool_call_id: toolCallId,
      });
    }

    const now = new Date().toISOString();
    applyRuntimeMutation(this.projectRoot, {
      kind: 'completeActivation',
      childCardId: activation.child_card_id,
      outcome: 'failed',
      completedAt: now,
    });
    const clearPatch = planClearActiveCardRunPatch({
      state: readRuntimeState(this.projectRoot),
      cardId: activation.child_card_id,
    });
    if (clearPatch) applyRuntimeMutation(this.projectRoot, { kind: 'patchRuntimeState', patch: clearPatch });
  }

  private async invokeAgent<E, R>(
    role: AgentRole,
    goalId: string,
    cardId: string,
    systemPrompt: string,
    contextMessages: AgentMessage[],
    contract: Contract<E, R>,
    requestedSessionId?: string,
    activationBarrier?: PlannerActivationBarrier,
  ): Promise<R> {
    const modelParams = getModelParamsForRole(this.config, role);
    const tools = this.buildToolsForRole(role);
    const capabilityRequest = capabilityRequestForLlmOptions({
      tools,
      stream: false,
    });
    const candidates = await this.invocationService.resolveCandidates(role, capabilityRequest);
    if (candidates.length === 0) {
      const noCandidateDecision = defaultInvocationRecoveryPolicy.decideNoCandidates({
        role,
        attempt: 1,
        maxAttempts: (this.runtimeConfig.maxRecoveryRetries ?? 3) + 1,
        recoveryDelayMs: this.runtimeConfig.recoveryDelayMs ?? 60000,
        maxRecoveryRetries: this.runtimeConfig.maxRecoveryRetries ?? 3,
        capabilityRequest,
        capabilitySkips: this.router.getLastCapabilitySkips(),
        goalId,
        cardId,
      });
      throw new Error(noCandidateDecision.message);
    }
    assertNoActiveAgentSession(this.saivageDir, role as import('../schemas/types.js').AgentRole);
    const session = createSession(
      this.saivageDir,
      role as import('../schemas/types.js').AgentRole,
      goalId,
      cardId,
      undefined,
      requestedSessionId,
    );
    await this.sessionCoordinator.notifySessionCreated(session.id);
    this.sessionCoordinator.publishSessionStarted({
      sessionId: session.id,
      role: role as unknown as import('../schemas/types.js').AgentRole,
      goalId,
      cardId,
    });
    for (const msg of contextMessages)
      appendPersistentMessage(
        this.saivageDir,
        session.id,
        {
          role: msg.role,
          kind: msg.kind,
          content: msg.content,
          tool: msg.tool,
          links: msg.links,
          model_spec: msg.model_spec,
          requested_model_spec: msg.requested_model_spec,
        },
        { round_id: msg.round_id, message_index: msg.message_index, block_index: msg.block_index },
      );
    const recoveryDelayMs = this.runtimeConfig.recoveryDelayMs ?? 60000;
    const maxRecoveryRetries = this.runtimeConfig.maxRecoveryRetries ?? 3;
    const maxOuterAttempts = maxRecoveryRetries + 1;
    const invocationStart = Date.now();
    const attemptRecorder = new AttemptRecorder(this.eventBus, this.eventLogger);
    const plannerEnvelopeTracker = new PlannerEnvelopeTracker();
    const agentFn = async (recoveryCtx: AgentRecoveryContext) => {
      const candidateChain = await this.invocationService.resolveCandidates(role, capabilityRequest);
      const capabilitySkips = this.router.getLastCapabilitySkips();
      if (candidateChain.length === 0) {
        const noCandidateDecision = defaultInvocationRecoveryPolicy.decideNoCandidates({
          role,
          attempt: recoveryCtx.attempt,
          maxAttempts: recoveryCtx.maxAttempts,
          recoveryDelayMs: this.runtimeConfig.recoveryDelayMs ?? 60000,
          maxRecoveryRetries: this.runtimeConfig.maxRecoveryRetries ?? 3,
          capabilityRequest,
          capabilitySkips,
          sessionId: session.id,
          goalId,
          cardId,
        });
        throw new Error(noCandidateDecision.message);
      }
      let lastError: Error | null = null;
      try {
        for (const candidate of candidateChain) {
          let sameCandidateRecoveryAttempt = 1;
          for (;;) {
            if (this.sessionCoordinator.isCancelled(session.id))
              throw new Error(
                `Agent invocation cancelled for session ${session.id}. Role: ${role}, goal: ${goalId}, card: ${cardId}`,
              );
            if (!this.candidateAvailability.isAvailable(candidate)) break;
            let callStart = 0;
            let startedAtIso = '';
            try {
              updateSessionModel(this.saivageDir, session.id, candidate.model);
              const recoveryDirective = recoveryCtx.isRecovery
                ? recoveryCtx.directive
                : sameCandidateRecoveryAttempt > 1
                  ? buildRecoveryDirective(lastError ?? undefined)
                  : '';
              if (recoveryDirective)
                this.appendSessionMessage(session.id, {
                  role: 'system',
                  kind: 'model_recovered',
                  content: recoveryDirective,
                });
              const abortController = new AbortController();
              this.sessionCoordinator.trackAbortController(session.id, abortController);
              callStart = Date.now();
              startedAtIso = new Date(callStart).toISOString();
              try {
                const turnTools = [...tools, ...contract.terminals.map((t) => t.toolDefinition)];
                const maxToolTurns = this.runtimeConfig.maxToolTurns ?? 16;
                const verifier = createContractVerifier();
                const io: AgentLoopDriverIO<E, R> = {
                  contract,
                  verifier,
                  sessionId: session.id,
                  role,
                  attempt: recoveryCtx.attempt,
                  budget: createRepairBudget(1),
                  maxToolTurns,
                  invokeTurn: async () => {
                    const turnMessages = this.buildModelMessages(session.id, role, goalId);
                    return this.invocationService.invokeCall({
                      role,
                      sessionId: session.id,
                      systemPrompt,
                      contextMessages: turnMessages,
                      tools: turnTools,
                      terminalToolNames: contract.terminals.map((t) => t.name),
                      modelParams: { temperature: modelParams.temperature, maxTokens: modelParams.maxTokens },
                      capabilityRequest,
                      abortSignal: abortController.signal,
                    }, candidate);
                  },
                  persistAssistantToolCalls: (result) => {
                    if (result.kind !== 'tool_calls') return;
                    for (const tc of result.tool_calls) {
                      let parsedArgs: Record<string, unknown>;
                      try {
                        parsedArgs = JSON.parse(tc.function.arguments) as Record<string, unknown>;
                        if (
                          !parsedArgs ||
                          typeof parsedArgs !== 'object' ||
                          Array.isArray(parsedArgs)
                        )
                          parsedArgs = {};
                      } catch {
                        parsedArgs = {};
                      }
                      this.appendSessionMessage(session.id, {
                        role: 'assistant',
                        kind: 'tool_call',
                        content: JSON.stringify(
                          serializeToolCallMessage({
                            id: tc.id,
                            name: tc.function.name,
                            args: parsedArgs,
                          }),
                        ),
                        tool: tc.function.name,
                        tool_call_id: tc.id,
                      });
                    }
                  },
                  persistAssistantText: (content) => {
                    this.appendSessionMessage(session.id, {
                      role: 'assistant',
                      kind: 'text',
                      content,
                    });
                  },
                  executeActionToolCalls: async (result) => {
                    if (result.kind !== 'tool_calls') return { runtimeSignalledDone: false };
                    for (const tc of result.tool_calls) {
                      if (contract.isTerminalToolName(tc.function.name)) continue;
                      const msg = await this.processToolCall(tc, role, session.id, {
                        goalId,
                        cardId,
                      });
                      if (role === 'planner' && tc.function.name === 'activate_card' && msg.kind === 'tool_result' && activationBarrier) {
                        let activation: unknown;
                        try {
                          const body = JSON.parse(msg.content) as { activation?: unknown };
                          activation = body.activation;
                        } catch {
                          activation = null;
                        }
                        if (activation && typeof activation === 'object' && 'activation_id' in activation) {
                          try {
                            markSessionWaiting(this.saivageDir, session.id);
                            await activationBarrier.dispatch({ activation: activation as RuntimeActivationRecord });
                          } catch (err) {
                            this.compensateActivationBarrierThrow(session.id, tc.id, activation as RuntimeActivationRecord, err);
                            throw err;
                          }
                          continue;
                        }
                      }
                      this.appendSessionMessage(session.id, {
                        role: msg.role,
                        kind: msg.kind,
                        content: msg.content,
                        tool: msg.tool,
                        tool_call_id: msg.tool_call_id,
                      });
                      if (
                        role === 'planner' &&
                        msg.kind === 'tool_result' &&
                        (tc.function.name === 'report_goal_done' ||
                          tc.function.name === 'report_goal_failed' ||
                          tc.function.name === 'report_goal_blocked')
                      ) {
                        plannerEnvelopeTracker.trackTerminalToolResult(tc.function.name, goalId, msg.content);
                      }
                    }
                    return { runtimeSignalledDone: plannerEnvelopeTracker.hasEnvelope() };
                  },
                  persistDuplicateDoneIgnored: (toolCallId, toolName) => {
                    this.appendSessionMessage(session.id, {
                      role: 'tool',
                      kind: 'tool_result',
                      content: 'duplicate terminal call ignored',
                      tool: toolName,
                      tool_call_id: toolCallId,
                    });
                  },
                  persistVerifiedDone: (toolCallId, toolName) => {
                    this.appendSessionMessage(session.id, {
                      role: 'tool',
                      kind: 'tool_result',
                      content: 'verified',
                      tool: toolName,
                      tool_call_id: toolCallId,
                    });
                  },
                  persistViolatedDone: (toolCallId, toolName, content) => {
                    this.appendSessionMessage(session.id, {
                      role: 'tool',
                      kind: 'tool_result',
                      content,
                      tool: toolName,
                      tool_call_id: toolCallId,
                    });
                  },
                  appendRepairMessage: (message) => {
                    this.appendSessionMessage(session.id, {
                      role: 'system',
                      kind: 'model_repair',
                      content: message,
                    });
                  },
                  isCancelled: () => this.sessionCoordinator.isCancelled(session.id),
                  emitVerifierRejection: (event) => {
                    if (this.eventLogger)
                      this.eventLogger.appendEvent({
                        kind: 'llm_verifier_rejection',
                        session_id: event.session_id,
                        role: event.role as import('../schemas/types.js').AgentRole,
                        contract_id: event.contract_id,
                        attempt: event.attempt,
                        repair_round: event.repair_round,
                        obligation_codes: event.obligation_codes,
                        proposed_present: event.proposed_present,
                      });
                    if (this.eventBus) this.eventBus.emit('llm_verifier_rejection', event);
                  },
                  takeRuntimeDoneEnvelope:
                    role === 'planner'
                      ? () => plannerEnvelopeTracker.takeEnvelope<E>()
                      : undefined,
                };
                const driver = createAgentLoopDriver<E, R>(io);
                const outcome = await driver.run();
                const callDuration = Date.now() - callStart;
                if (outcome.kind === 'succeeded') {
                  attemptRecorder.recordContractVerdict('satisfied', outcome.repairAttempts);
                  const finalResponse = JSON.stringify(outcome.envelope);
                  this.appendSessionMessage(session.id, {
                    role: 'assistant',
                    kind: 'text',
                    content: finalResponse,
                  });
                  const successDecision = defaultInvocationRecoveryPolicy.decideSuccess({
                    role,
                    candidate,
                    attempt: recoveryCtx.attempt,
                    maxAttempts: recoveryCtx.maxAttempts,
                    recoveryDelayMs: this.runtimeConfig.recoveryDelayMs ?? 60000,
                    maxRecoveryRetries: this.runtimeConfig.maxRecoveryRetries ?? 3,
                    capabilityRequest,
                    capabilitySkips,
                    sessionId: session.id,
                    goalId,
                    cardId,
                  });
                  if (successDecision.markSucceeded)
                    await this.candidateAvailability.markSucceeded(candidate);
                  const succeededOutcome: LlmAttemptOutcome = {
                    kind: 'succeeded',
                    terminal_tool: outcome.terminalName as LlmAttemptOutcome extends {
                      kind: 'succeeded';
                      terminal_tool: infer X;
                    }
                      ? X
                      : never,
                  };
                  const succeededCapSkips = this.router.getLastCapabilitySkips();
                  attemptRecorder.recordOutcome({
                    session_id: session.id,
                    role: role as unknown as import('../schemas/types.js').AgentRole,
                    attempt: recoveryCtx.attempt,
                    same_candidate_attempt: sameCandidateRecoveryAttempt,
                    provider: candidate.provider,
                    model: candidate.model,
                    account: candidate.account ?? '_',
                    started_at: startedAtIso,
                    duration_ms: callDuration,
                    outcome: succeededOutcome,
                    capability_skip_reasons:
                      succeededCapSkips && succeededCapSkips.length > 0
                        ? succeededCapSkips.map((d) => ({
                            provider: d.candidate.provider,
                            model: d.candidate.model,
                            reasons: d.reasons.slice(),
                          }))
                        : undefined,
                  });
                  this.sessionCoordinator.clearCancellation(session.id);
                  return outcome.result;
                }
                if (outcome.kind === 'cancelled') {
                  throw new Error(
                    `Agent invocation cancelled for session ${session.id}. Role: ${role}, goal: ${goalId}, card: ${cardId}`,
                  );
                }
                if (outcome.kind === 'repair_exhausted') {
                  attemptRecorder.recordContractVerdict('repair_exhausted', outcome.repairAttempts);
                  const codes = outcome.lastReport.obligations.map((o) => o.code).join(',');
                  throw new LlmRequestError({
                    kind: 'provider_protocol_error',
                    provider: candidate.provider,
                    status: 0,
                    message: `Role '${role}' contract verification exhausted after ${outcome.repairAttempts} repair attempt(s): ${codes}.`,
                  });
                }
                if (outcome.kind === 'no_progress') {
                  attemptRecorder.recordContractVerdict('no_progress', outcome.repairAttempts);
                  throw new LlmRequestError({
                    kind: 'provider_protocol_error',
                    provider: candidate.provider,
                    status: 0,
                    message: `Role '${role}' did not emit terminal tool within ${outcome.turnsConsumed} turns.`,
                  });
                }
                throw new LlmRequestError({
                  kind: 'provider_protocol_error',
                  provider: candidate.provider,
                  status: 0,
                  message: `Role '${role}' transport failure: ${outcome.failure.kind}.`,
                });
              } finally {
                this.sessionCoordinator.clearAbortController(session.id);
              }
            } catch (err) {
              lastError = err instanceof Error ? err : new Error(String(err));
              const failureDurationMs = Date.now() - callStart;
              const policyContext: InvocationRecoveryContext = {
                role,
                candidate,
                attempt: sameCandidateRecoveryAttempt,
                maxAttempts: recoveryCtx.maxAttempts,
                recoveryDelayMs: this.runtimeConfig.recoveryDelayMs ?? 60000,
                maxRecoveryRetries: this.runtimeConfig.maxRecoveryRetries ?? 3,
                capabilityRequest,
                capabilitySkips,
                sessionId: session.id,
                goalId,
                cardId,
              };
              const decision = defaultInvocationRecoveryPolicy.decideFailure(
                lastError,
                policyContext,
              );
              if (decision.markFailed && decision.availability)
                await this.candidateAvailability.markFailed(candidate, decision.availability);
              if (decision.appendModelIssue)
                this.appendSessionMessage(session.id, {
                  role: 'system',
                  kind: 'model_issue',
                  content: this.redactModelIssueText(decision.message),
                });
              const failedOutcome: LlmAttemptOutcome = {
                kind: 'failed',
                failure_class: (decision.failure?.kind ?? 'unknown') as LlmFailureClass,
                recovery_action: decision.action,
                error_name: lastError.name,
                error_message: this.redactModelIssueText(decision.message),
                error_preview: this.redactProviderErrorMessage(lastError.message.slice(0, 240)),
                cooldown_ms: decision.availability
                  ? Math.max(0, decision.availability.untilMs - Date.now())
                  : undefined,
                retry_delay_ms: decision.retryDelayMs,
              };
              const failedCapSkips = this.router.getLastCapabilitySkips();
              attemptRecorder.recordOutcome({
                session_id: session.id,
                role: role as unknown as import('../schemas/types.js').AgentRole,
                attempt: recoveryCtx.attempt,
                same_candidate_attempt: sameCandidateRecoveryAttempt,
                provider: candidate.provider,
                model: candidate.model,
                account: candidate.account ?? '_',
                started_at: startedAtIso,
                duration_ms: failureDurationMs,
                outcome: failedOutcome,
                capability_skip_reasons:
                  failedCapSkips && failedCapSkips.length > 0
                    ? failedCapSkips.map((d) => ({
                        provider: d.candidate.provider,
                        model: d.candidate.model,
                        reasons: d.reasons.slice(),
                      }))
                    : undefined,
              });
              if (decision.abort || this.sessionCoordinator.isCancelled(session.id)) {
                this.sessionCoordinator.publishCancelledRetryStop(
                  session.id,
                  role as unknown as import('../schemas/types.js').AgentRole,
                );
                if (
                  decision.failure?.kind === 'cancelled' ||
                  this.sessionCoordinator.isCancelled(session.id)
                )
                  throw new Error(
                    `Agent invocation cancelled for session ${session.id}. Role: ${role}, goal: ${goalId}, card: ${cardId}`,
                  );
                throw lastError;
              }
              if (decision.action === 'retry_same_after_delay') {
                await delayInvocationRecovery(decision.retryDelayMs ?? 0);
                sameCandidateRecoveryAttempt += 1;
                continue;
              }
              break;
            }
          }
        }
        throw lastError ?? new Error(`All candidates exhausted for role '${role}'.`);
      } finally {
        this.sessionCoordinator.clearCancellation(session.id);
      }
    };
    const attempts: AgentInvocationAttempt<R>[] = [];
    for (let attempt = 1; attempt <= maxOuterAttempts; attempt += 1) {
      const previousError = attempts[attempt - 2]?.error;
      const recoveryCtx: AgentRecoveryContext = {
        attempt,
        maxAttempts: maxOuterAttempts,
        isRecovery: attempt > 1,
        previousError,
        directive: attempt > 1 ? buildRecoveryDirective(previousError) : '',
      };
      try {
        const result = await agentFn(recoveryCtx);
        attempts.push({ attempt, success: true, result });
        if (this.eventBus)
          this.eventBus.emit('agent_recovered', {
            role,
            attempt,
            sessionId: session.id,
            cardId,
            goalId,
          });
        break;
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        attempts.push({ attempt, success: false, error });
        try {
          this.appendSessionMessage(session.id, {
            role: 'system',
            kind: 'model_issue',
            content: `Agent invocation failed (attempt ${attempt}): ${this.redactProviderErrorMessage(error.message)}`,
          });
        } catch {
          void 0;
        }
        if (this.eventBus)
          this.eventBus.emit('agent_invocation_failed', {
            role,
            attempt,
            error: error.message,
            sessionId: session.id,
            cardId,
            goalId,
            recoverable: attempt < maxOuterAttempts,
          });
        if (attempt >= maxOuterAttempts) break;
        await delayInvocationRecovery(recoveryDelayMs);
      }
    }
    const summaryLast = attempts[attempts.length - 1];
    const summaryCancelled =
      this.sessionCoordinator.isCancelled(session.id) ||
      (typeof summaryLast?.error?.message === 'string' &&
        /cancelled/i.test(summaryLast.error.message));
    const verdict: 'succeeded' | 'exhausted' | 'cancelled' = summaryLast?.success
      ? 'succeeded'
      : summaryCancelled
        ? 'cancelled'
        : 'exhausted';
    const summaryPayload = {
      session_id: session.id,
      role: role as unknown as import('../schemas/types.js').AgentRole,
      goal_id: goalId,
      card_id: cardId,
      contract_id: contract.name + '.v1',
      attempts_count: attemptRecorder.getOutcomeCount(),
      total_duration_ms: Date.now() - invocationStart,
      verdict,
      repair_attempts: attemptRecorder.getRepairAttempts(),
      contract_verdict: attemptRecorder.getContractVerdict(),
      final_provider: verdict === 'succeeded' ? attemptRecorder.getLastSucceeded()?.provider : undefined,
      final_model: verdict === 'succeeded' ? attemptRecorder.getLastSucceeded()?.model : undefined,
      final_account: verdict === 'succeeded' ? attemptRecorder.getLastSucceeded()?.account : undefined,
      final_terminal_tool: (() => {
        const succeeded = attemptRecorder.getLastSucceeded();
        return verdict === 'succeeded' && succeeded?.outcome.kind === 'succeeded'
          ? succeeded.outcome.terminal_tool
          : undefined;
      })(),
      last_failure_class: verdict === 'succeeded' ? undefined : attemptRecorder.getLastFailedClass(),
    };
    if (this.eventLogger)
      this.eventLogger.appendEvent({ kind: 'llm_invocation_summary', ...summaryPayload });
    if (this.eventBus) this.eventBus.emit('llm_invocation_summary', summaryPayload);
    const lastAttempt = attempts[attempts.length - 1];
    if (lastAttempt.success && lastAttempt.result !== undefined) {
      const resultValue = lastAttempt.result as R;
      const statusBearer =
        role === 'planner' &&
        typeof resultValue === 'object' &&
        resultValue !== null &&
        'result' in (resultValue as Record<string, unknown>)
          ? (resultValue as unknown as { result: unknown }).result
          : resultValue;
      const resultStatus =
        typeof statusBearer === 'object' &&
        statusBearer !== null &&
        'status' in (statusBearer as Record<string, unknown>)
          ? (statusBearer as Record<string, unknown>).status
          : null;
      if (role === 'planner' && resultStatus === 'continue')
        markSessionWaiting(this.saivageDir, session.id);
      else if (role === 'planner' && resultStatus === 'blocked')
        completeSession(this.saivageDir, session.id, 'blocked');
      else if (role === 'executor' && resultStatus === 'failed')
        completeSession(this.saivageDir, session.id, 'failed');
      else completeSession(this.saivageDir, session.id, 'done');
      return resultValue;
    }
    completeSession(this.saivageDir, session.id, 'failed');
    throw (
      lastAttempt.error ??
      new Error(`Agent '${role}' invocation failed after ${attempts.length} attempts.`)
    );
  }

  getRouter(): ModelRouter {
    return this.router;
  }
  getRegistry(): ProviderRegistry {
    return this.registry;
  }
  getCandidateAvailability(): CandidateAvailability {
    return this.candidateAvailability;
  }

  async flushRecorders(): Promise<void> {
    await this.invocationService.flushRecorders();
  }
}
