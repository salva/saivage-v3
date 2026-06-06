import { EventEmitter } from 'node:events';
import type { SaivageConfig, RuntimeSection } from './config-schema.js';
import { getRuntimeConfig } from './config-schema.js';
import { ProviderRegistry } from './provider.js';
import { ModelRouter } from './model-router.js';
import {
  type CandidateAvailability,
  MemoryCandidateAvailability,
} from './candidate-availability.js';
import {
  getSession,
  getSessionMessages,
} from './session-persistence.js';
import type {
  AgentInvocationRole,
  AgentMessage,
  HandoffSummary,
  OperationalAgentRole,
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
import { generateRoundId } from '../schemas/round-id-server.js';
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
import { redactTextForOutbound } from '../redaction/index.js';
import { ToolRuntime, AGENT_TOOL_DEFINITIONS } from '../tools/index.js';
import { AgentSessionCoordinator, type SessionCreatedHook } from './agent-session-coordinator.js';
import { AgentToolExecutor } from './agent-tool-executor.js';
import { InvocationService } from './invocation-service.js';
import { applyRuntimeMutation } from '../runtime/mutations.js';
import { planClearActiveCardRunPatch } from '../runtime/runtime-core.js';
import { readRuntimeState } from '../runtime/state.js';
import { SessionStampCounter } from '../runtime/session-stamp-counter.js';
import { SessionMessageLog } from './session-message-log.js';
import { AgentSessionLifecycle } from './session-lifecycle.js';
import { InvocationModelContext } from './invocation-model-context.js';
import { AgentInvocationRunner } from './invocation-runner.js';

export type AgentRole = OperationalAgentRole;
export type InvokableAgentRole = AgentInvocationRole;

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
  private readonly sessionLifecycle: AgentSessionLifecycle;
  private readonly messageLog: SessionMessageLog;
  private readonly modelContext: InvocationModelContext;
  private readonly toolExecutor: AgentToolExecutor;
  private readonly invocationService: InvocationService;
  private readonly invocationRunner: AgentInvocationRunner;
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
        if (parentSessionId) this.sessionLifecycle.markWaiting(parentSessionId);
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
          if (parentSessionId) this.sessionLifecycle.markActive(parentSessionId);
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
    this.sessionLifecycle = new AgentSessionLifecycle(this.saivageDir, this.sessionCoordinator);
    this.messageLog = new SessionMessageLog(this.saivageDir);
    this.modelContext = new InvocationModelContext({
      projectRoot: this.projectRoot,
      sessionCoordinator: this.sessionCoordinator,
      contextCompactor: this.contextCompactor,
      cardStore: this.cardStore,
      runtimeStateProvider: this.runtimeStateProvider,
    });
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
    this.invocationRunner = new AgentInvocationRunner({
      projectRoot: this.projectRoot,
      saivageDir: this.saivageDir,
      config: this.config,
      runtimeConfig: this.runtimeConfig,
      router: this.router,
      candidateAvailability: this.candidateAvailability,
      sessionLifecycle: this.sessionLifecycle,
      messageLog: this.messageLog,
      modelContext: this.modelContext,
      toolExecutor: this.toolExecutor,
      invocationService: this.invocationService,
      eventBusProvider: () => this.eventBus,
      eventLogger: this.eventLogger,
      redactModelIssueText: (message) => this.redactModelIssueText(message),
      redactProviderErrorMessage: (message) => this.redactProviderErrorMessage(message),
      compensateActivationBarrierThrow: (sessionId, toolCallId, activation, error) =>
        this.compensateActivationBarrierThrow(sessionId, toolCallId, activation, error),
    });
  }

  setEventBus(eventBus: EventEmitter): void {
    this.eventBus = eventBus;
    this.sessionLifecycle.setEventBus(eventBus);
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
    this.sessionLifecycle.setAfterSessionCreatedHook(hook);
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
    return this.sessionLifecycle.cancel(sessionId);
  }
  forceCancelSession(sessionId: string): boolean {
    return this.sessionLifecycle.forceCancel(sessionId);
  }
  getHandoffSummary(sessionId: string): HandoffSummary | null {
    return this.sessionLifecycle.getHandoffSummary(sessionId);
  }
  getActiveSessionHandoffs(): HandoffSummary[] {
    return this.sessionLifecycle.getActiveSessionHandoffs();
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
    return this.modelContext.buildModelMessages(sessionId, role, goalId);
  }

  private nextFallbackRound(
    sessionId: string,
    prefix: 'pre' | 'user' | 'assistant' | 'diagnostic' = 'assistant',
  ) {
    return this.messageLog.nextFallbackRound(sessionId, prefix);
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
    return this.invocationRunner.invoke(
      role,
      goalId,
      cardId,
      systemPrompt,
      contextMessages,
      contract,
      requestedSessionId,
      activationBarrier,
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
