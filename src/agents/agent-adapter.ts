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
import { EventLogger } from '../observability/index.js';
import type { McpToolInvocationPort } from '../mcp/manager-api.js';
import { SkillsEngine } from './skills-engine.js';
import { getProjectNotificationCenter } from '../notifications/notification-delivery.js';
import type { CardStore } from '../cards/store-api.js';
import { injectQueuedSyntheticPlannerNotes } from '../runtime/synthetic-planner-notes.js';
import { PlannerControlExecutor } from './planner-control-executor.js';
import { createPlannerControlExecutor } from './planner-control-factory.js';
import { ContextCompactor } from './context-compactor.js';
import type { Contract } from '../contracts/contract.js';
import {
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
import { SessionStampCounter } from '../runtime/session-stamp-counter.js';
import { SessionMessageLog } from './session-message-log.js';
import { AgentSessionLifecycle } from './session-lifecycle.js';
import { InvocationModelContext } from './invocation-model-context.js';
import { AgentInvocationRunner } from './invocation-runner.js';
import { compensateActivationBarrierThrow } from './activation-barrier-compensation.js';

export type AgentRole = OperationalAgentRole;
export type InvokableAgentRole = AgentInvocationRole;

export class SessionInvariantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SessionInvariantError';
  }
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
    this.sessionCoordinator = new AgentSessionCoordinator({
      saivageDir: this.saivageDir,
      notificationCenter: this.notificationCenter,
      eventBus: this.eventBus,
      eventLogger: this.eventLogger,
    });
    this.sessionLifecycle = new AgentSessionLifecycle(this.saivageDir, this.sessionCoordinator);
    this.plannerControlExecutor = createPlannerControlExecutor({
      cardStore: this.cardStore,
      projectRoot: this.projectRoot,
      saivageDir: this.saivageDir,
      runtimeStateProvider: () => this.activationLedger?.readState() ?? null,
      activationLedgerProvider: () => this.activationLedger,
      markSessionWaiting: (sessionId) => this.sessionLifecycle.markWaiting(sessionId),
      markSessionActive: (sessionId) => this.sessionLifecycle.markActive(sessionId),
      invokeReviewer: (request) => this.invokeReviewer(request),
      maxReviewRetries: this.runtimeConfig?.maxReviewRetries ?? 3,
      eventBusProvider: () => this.runtimeLedgerEventBus,
      eventLogger: this.eventLogger,
    });
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
        compensateActivationBarrierThrow(
          {
            projectRoot: this.projectRoot,
            saivageDir: this.saivageDir,
            messageLog: this.messageLog,
            redactProviderErrorMessage: (message) => this.redactProviderErrorMessage(message),
          },
          sessionId,
          toolCallId,
          activation,
          error,
        ),
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
  async invokePlanner(request: PlannerInvocationRequest): Promise<PlannerResult> {
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
      request.contract,
      undefined,
      request.activationBarrier,
    );
    return typedResult.result;
  }
  async invokeExecutor(request: ExecutorInvocationRequest): Promise<ExecutorResult> {
    return this.invokeAgent<ExecutorResultEnvelope, ExecutorResult>(
      'executor',
      request.goalId,
      request.cardId,
      request.systemPrompt ?? '',
      request.contextMessages ?? [],
      request.contract,
    );
  }
  async invokeReviewer(request: ReviewerInvocationRequest): Promise<ReviewerResult> {
    return this.invokeAgent<ReviewerResultEnvelope, ReviewerResult>(
      'reviewer',
      request.goalId,
      request.goalId,
      request.systemPrompt ?? '',
      request.contextMessages ?? [],
      request.contract,
      request.reviewerSessionId,
      undefined,
      request.assessmentId,
    );
  }
  async reinvokeSession(request: SessionReinvokeRequest): Promise<ExecutorResult | ReviewerResult> {
    const session = getSession(this.saivageDir, request.sessionId);
    if (!session) throw new Error(`Session not found: ${request.sessionId}`);
    if (session.role === 'executor') {
      if (!session.card_id) throw new SessionInvariantError(`Executor session '${session.id}' is missing card_id.`);
      if (!session.goal_card_id) throw new SessionInvariantError(`Executor session '${session.id}' is missing goal_card_id.`);
      return this.invokeExecutor({
        cardId: session.card_id,
        goalId: session.goal_card_id,
        systemPrompt: request.systemPrompt,
        contextMessages: request.contextMessages,
        contract: createExecutorContract({ cardId: session.card_id, goalId: session.goal_card_id }),
      });
    }
    if (session.role === 'reviewer') {
      if (!session.goal_card_id) throw new SessionInvariantError(`Reviewer session '${session.id}' is missing goal_card_id.`);
      if (!session.assessment_id) throw new SessionInvariantError(`Reviewer session '${session.id}' is missing assessment_id.`);
      return this.invokeReviewer({
        goalId: session.goal_card_id,
        systemPrompt: request.systemPrompt,
        contextMessages: request.contextMessages,
        reviewerSessionId: session.id,
        assessmentId: session.assessment_id,
        contract: createReviewerContract({ goalId: session.goal_card_id, assessmentId: session.assessment_id }),
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

  private compensateActivationBarrierThrow(
    sessionId: string,
    toolCallId: string,
    activation: RuntimeActivationRecord,
    error: unknown,
  ): void {
    compensateActivationBarrierThrow(
      {
        projectRoot: this.projectRoot,
        saivageDir: this.saivageDir,
        messageLog: this.messageLog,
        redactProviderErrorMessage: (message) => this.redactProviderErrorMessage(message),
      },
      sessionId,
      toolCallId,
      activation,
      error,
    );
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
    assessmentId?: string | null,
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
      assessmentId,
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
