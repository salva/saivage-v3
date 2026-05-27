import { EventEmitter } from 'node:events';
import type { SaivageConfig, RuntimeSection } from './config-schema.js';
import { loadConfig, getRuntimeConfig, getModelParamsForRole } from './config-schema.js';
import { ProviderRegistry, type Candidate } from './provider.js';
import { ModelRouter } from './model-router.js';
import { parsePlannerResult, parseExecutorResult, parseReviewerResult, buildExecutorFallbackResult, type PlannerResult, type ExecutorResult, type ReviewerResult } from './result-parser.js';
import { createSession, completeSession, appendMessage, getSession, getSessionMessages, markSessionWaiting, updateSessionModel, assertNoActiveWorkerSession } from './session-persistence.js';
import type { AgentInvocationRole, AgentMessage, HandoffSummary, LoggedEvent, OperationalAgentRole } from '../schemas/index.js';
import type { NotificationCenter } from '../notifications/index.js';
import { compactSession } from './compaction.js';
import { invokeWithRecovery, type RecoveryContext } from './recovery.js';
import type { ContentSupervisor } from '../workspace/index.js';
import { getSafeFileForAgent, type SafeFileResult } from '../workspace/index.js';
import type { AgentExecutionPort, PlannerInvocationRequest, ExecutorInvocationRequest, ReviewerInvocationRequest, SessionReinvokeRequest, RuntimeActivationLedgerPort } from '../contracts/index.js';
import type { LlmCompleteOptions, LlmCallFn } from './llm-contracts.js';
import { capabilityRequestForLlmOptions } from './provider-capabilities.js';
import { defaultInvocationRecoveryPolicy, type InvocationRecoveryContext } from './invocation-recovery-policy.js';
import { EventLogger } from '../observability/index.js';
import { buildReviewerPrompt } from './system-prompt.js';
import type { McpToolInvocationPort } from '../mcp/index.js';
import { SkillsEngine } from './skills-engine.js';
import { getProjectNotificationCenter } from '../notifications/notification-delivery.js';
import { CardStore } from '../cards/index.js';
import { injectQueuedSyntheticPlannerNotes } from '../agents/analyst-stage6.js';
import { parseDeferredActivationEnvelope } from '../schemas/index.js';
import { PlannerControlExecutor } from './planner-control-executor.js';
import { redactTextForOutbound } from '../redaction/index.js';
import { ToolRuntime, AGENT_TOOL_DEFINITIONS } from '../tools/index.js';
import { AgentSessionCoordinator, type SessionCreatedHook } from './agent-session-coordinator.js';
import { AgentToolExecutor } from './agent-tool-executor.js';
import { AgentLlmInvocationGateway } from './agent-llm-gateway.js';
import { AgentRoleRunner } from './agent-role-runner.js';
import { decide as decideCardPermission } from '../permissions/index.js';

export type AgentRole = OperationalAgentRole;
export type InvokableAgentRole = AgentInvocationRole;
export interface AgentAdapterConfig { projectRoot: string; saivageDir: string; config: SaivageConfig; eventBus?: EventEmitter; eventLogger?: EventLogger; activationLedger?: RuntimeActivationLedgerPort; }
function delayInvocationRecovery(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

export class AgentAdapter implements AgentExecutionPort {
  readonly projectRoot: string;
  readonly saivageDir: string;
  readonly config: SaivageConfig;
  readonly runtimeConfig: RuntimeSection;
  readonly registry: ProviderRegistry;
  readonly router: ModelRouter;
  readonly notificationCenter: NotificationCenter;
  eventBus?: EventEmitter;
  private runtimeLedgerEventBus?: { emit(event: LoggedEvent): void };
  readonly eventLogger?: EventLogger;
  private llmCallFn: LlmCallFn | null = null;
  private contentSupervisor?: ContentSupervisor;
  private _mcpManager: McpToolInvocationPort | undefined;
  private _skillsEngine: SkillsEngine | undefined;
  private activationLedger?: RuntimeActivationLedgerPort;
  private readonly plannerControlExecutor: PlannerControlExecutor;
  private readonly toolRuntime: ToolRuntime<typeof AGENT_TOOL_DEFINITIONS>;
  private readonly sessionCoordinator: AgentSessionCoordinator;
  private readonly toolExecutor: AgentToolExecutor;
  private readonly llmGateway: AgentLlmInvocationGateway;
  private readonly roleRunner: AgentRoleRunner;

  constructor(cfg: AgentAdapterConfig) {
    this.projectRoot = cfg.projectRoot;
    this.saivageDir = cfg.saivageDir;
    this.config = cfg.config;
    this.runtimeConfig = getRuntimeConfig(cfg.config);
    this.registry = new ProviderRegistry(cfg.config);
    this.router = new ModelRouter(cfg.config, this.registry, cfg.projectRoot);
    this.notificationCenter = getProjectNotificationCenter(cfg.projectRoot);
    this.eventBus = cfg.eventBus;
    this.eventLogger = cfg.eventLogger;
    this.activationLedger = cfg.activationLedger;
    this.toolRuntime = new ToolRuntime({ matrix: { decide: decideCardPermission }, bus: cfg.eventBus }, AGENT_TOOL_DEFINITIONS);
    this.plannerControlExecutor = new PlannerControlExecutor({
      cardStore: new CardStore(this.projectRoot),
      projectRoot: this.projectRoot,
      saivageDir: this.saivageDir,
      runtimeStateProvider: () => this.activationLedger?.readState() ?? null,
      activationLedger: { readState: () => this.activationLedger?.readState() ?? null, appendRun: (input) => this.activationLedger!.appendRun(input), upsertActivation: (input) => this.activationLedger!.upsertActivation(input) },
      reviewer: async (goalId, assessmentId, reviewerSessionId, report) => (await this.invokeReviewer({ goalId, systemPrompt: buildReviewerPrompt(), contextMessages: [{ id: `review-report:${assessmentId}`, session_id: reviewerSessionId, role: 'user', kind: 'text', content: `The planner reports the following terminal outcome for goal '${goalId}'. Evaluate against the goal's acceptance criteria and respond with the canonical ReviewerResult JSON envelope.\n\n${JSON.stringify(report, null, 2)}`, timestamp: new Date().toISOString() }], assessmentId, reviewerSessionId })).assessment,
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
    this.toolExecutor = new AgentToolExecutor({
      projectRoot: this.projectRoot,
      toolRuntime: this.toolRuntime,
      plannerControlExecutor: this.plannerControlExecutor,
      getMcpManager: () => this._mcpManager,
      getSkillsEngine: () => this._skillsEngine,
      getContentSupervisor: () => this.contentSupervisor,
    });
    this.llmGateway = new AgentLlmInvocationGateway({
      projectRoot: this.projectRoot,
      saivageDir: this.saivageDir,
      registry: this.registry,
      eventLogger: this.eventLogger,
    });
    this.roleRunner = new AgentRoleRunner({ config: this.config, eventBus: this.eventBus, eventLogger: this.eventLogger });
  }

  setEventBus(eventBus: EventEmitter): void { this.eventBus = eventBus; this.sessionCoordinator.setEventBus(eventBus); this.roleRunner.setEventBus(eventBus); }
  setRuntimeLedgerEventBus(eventBus: { emit(event: LoggedEvent): void }): void { this.runtimeLedgerEventBus = eventBus; }
  setActivationLedger(activationLedger: RuntimeActivationLedgerPort): void { this.activationLedger = activationLedger; }
  setLlmCallFn(fn: LlmCallFn): void { this.llmCallFn = fn; }
  setContentSupervisor(supervisor: ContentSupervisor): void { this.contentSupervisor = supervisor; }
  getContentSupervisor(): ContentSupervisor | undefined { return this.contentSupervisor; }
  setMcpManager(mcpManager: McpToolInvocationPort): void { this._mcpManager = mcpManager; }
  getMcpManager(): McpToolInvocationPort | undefined { return this._mcpManager; }
  setSkillsEngine(engine: SkillsEngine): void { this._skillsEngine = engine; }
  getSkillsEngine(): SkillsEngine | undefined { return this._skillsEngine; }
  setAfterSessionCreatedHook(hook: SessionCreatedHook | null): void { this.sessionCoordinator.setAfterSessionCreatedHook(hook); }

  public getToolNamesForRole(role: AgentRole): string[] { return this.toolExecutor.getToolNamesForRole(role); }
  private buildToolsForRole(role: AgentRole) { return this.toolExecutor.buildToolsForRole(role); }

  async callMcpTool(role: AgentRole, serverName: string, toolName: string, args: Record<string, unknown>): Promise<unknown> {
    return this.toolExecutor.callMcpTool(role, serverName, toolName, args);
  }

  getSafeFileContent(filePath: string, content: string): SafeFileResult { return getSafeFileForAgent(filePath, content); }
  private redactModelIssueText(message: unknown): string { return redactTextForOutbound(message, 'model.issue', { source: 'agent-adapter' }); }
  private redactProviderErrorMessage(message: unknown): string { return redactTextForOutbound(message, 'model.issue', { source: 'agent-adapter' }); }
  private applySelfCheck(role: AgentRole, systemPrompt: string, sessionId: string): string { return this.roleRunner.applySelfCheck(role, systemPrompt, sessionId); }
  private resetOnRoleChange(role: AgentRole): void { this.roleRunner.resetOnRoleChange(role); }
  cancelSession(sessionId: string): boolean { return this.sessionCoordinator.cancelSession(sessionId); }
  forceCancelSession(sessionId: string): boolean { return this.sessionCoordinator.forceCancelSession(sessionId); }
  getHandoffSummary(sessionId: string): HandoffSummary | null { return this.sessionCoordinator.getHandoffSummary(sessionId); }
  getActiveSessionHandoffs(): HandoffSummary[] { return this.sessionCoordinator.getActiveSessionHandoffs(); }
  async invokePlanner(request: PlannerInvocationRequest): Promise<PlannerResult>;
  async invokePlanner(goalId: string, systemPrompt?: string, contextMessages?: AgentMessage[]): Promise<PlannerResult>;
  async invokePlanner(requestOrGoalId: PlannerInvocationRequest | string, systemPrompt: string = '', contextMessages: AgentMessage[] = []): Promise<PlannerResult> {
    const request: PlannerInvocationRequest = typeof requestOrGoalId === 'string' ? { goalId: requestOrGoalId, systemPrompt, contextMessages } : requestOrGoalId;
    const plannerSessionId = `planner:${request.goalId}`;
    const existing = getSession(this.saivageDir, plannerSessionId);
    if (existing) injectQueuedSyntheticPlannerNotes(this.projectRoot, plannerSessionId);
    return this.invokeAgent('planner', request.goalId, request.goalId, request.systemPrompt ?? '', request.contextMessages ?? [], parsePlannerResult);
  }
  async invokeExecutor(request: ExecutorInvocationRequest): Promise<ExecutorResult>;
  async invokeExecutor(cardId: string, goalId: string, systemPrompt?: string, contextMessages?: AgentMessage[]): Promise<ExecutorResult>;
  async invokeExecutor(requestOrCardId: ExecutorInvocationRequest | string, goalId?: string, systemPrompt: string = '', contextMessages: AgentMessage[] = []): Promise<ExecutorResult> { const request: ExecutorInvocationRequest = typeof requestOrCardId === 'string' ? { cardId: requestOrCardId, goalId: goalId ?? '', systemPrompt, contextMessages } : requestOrCardId; return this.invokeAgent('executor', request.goalId, request.cardId, request.systemPrompt ?? '', request.contextMessages ?? [], parseExecutorResult); }
  async invokeReviewer(request: ReviewerInvocationRequest): Promise<ReviewerResult>;
  async invokeReviewer(goalId: string, systemPrompt?: string, contextMessages?: AgentMessage[], options?: { assessmentId?: string; reviewerSessionId?: string }): Promise<ReviewerResult>;
  async invokeReviewer(requestOrGoalId: ReviewerInvocationRequest | string, systemPrompt: string = '', contextMessages: AgentMessage[] = [], options: { assessmentId?: string; reviewerSessionId?: string } = {}): Promise<ReviewerResult> { const request: ReviewerInvocationRequest = typeof requestOrGoalId === 'string' ? { goalId: requestOrGoalId, systemPrompt, contextMessages, assessmentId: options.assessmentId, reviewerSessionId: options.reviewerSessionId } : requestOrGoalId; return this.invokeAgent('reviewer', request.goalId, request.goalId, request.systemPrompt ?? '', request.contextMessages ?? [], parseReviewerResult, request.reviewerSessionId); }
  async reinvokeSession(request: SessionReinvokeRequest): Promise<ExecutorResult | ReviewerResult>;
  async reinvokeSession(sessionId: string, systemPrompt?: string, contextMessages?: AgentMessage[]): Promise<ExecutorResult | ReviewerResult>;
  async reinvokeSession(requestOrSessionId: SessionReinvokeRequest | string, systemPrompt: string = '', contextMessages: AgentMessage[] = []): Promise<ExecutorResult | ReviewerResult> { const request: SessionReinvokeRequest = typeof requestOrSessionId === 'string' ? { sessionId: requestOrSessionId, systemPrompt, contextMessages } : requestOrSessionId; const session = getSession(this.saivageDir, request.sessionId); if (!session) throw new Error(`Session not found: ${request.sessionId}`); if (session.role === 'executor') return this.invokeExecutor({ cardId: session.card_id ?? session.goal_card_id ?? '', goalId: session.goal_card_id ?? '', systemPrompt: request.systemPrompt, contextMessages: request.contextMessages }); if (session.role === 'reviewer') return this.invokeReviewer({ goalId: session.goal_card_id ?? '', systemPrompt: request.systemPrompt, contextMessages: request.contextMessages, reviewerSessionId: session.id }); throw new Error(`Session '${request.sessionId}' is not reinvokable.`); }
  private parseToolCallsFromResponse(rawResponse: string) { return this.toolExecutor.parseToolCallsFromResponse(rawResponse); }

  private async processToolCall(tc: { id: string; type: string; function: { name: string; arguments: string } }, role: AgentRole, sessionId: string, invocation?: { goalId?: string; cardId?: string }) {
    return this.toolExecutor.processToolCall(tc, role, sessionId, invocation);
  }

  private buildModelMessages(sessionId: string): AgentMessage[] { return this.sessionCoordinator.buildModelMessages(sessionId); }
  private buildForceFinalAnswerPrompt(role: AgentRole): string {
    if (role === 'planner') return 'The tool-calling loop was terminated. Do NOT emit any further toolCalls. Reply with ONLY your final planner result JSON envelope: {"status":"continue"|"done"|"blocked","summary":"...","created_cards":[],"updated_cards":[],"blocked_reason":"..."}';
    if (role === 'executor') return 'The tool-calling loop was terminated. Do NOT emit any further toolCalls. Reply with ONLY your final executor result JSON envelope: {"card_id":"...","status":"done"|"failed","status_text":"...","summary":"...","result":{},"artifacts":[],"attachments":[]}';
    if (role === 'reviewer') return 'The tool-calling loop was terminated. Do NOT emit any further toolCalls. Reply with ONLY your final reviewer result JSON envelope: {"assessment":{"result":"pass"|"needs_corrections","summary":"...","issues":[]}}';
    return 'The tool-calling loop was terminated. Reply with ONLY your final result JSON envelope. Do NOT emit any further toolCalls.';
  }
  private async forceFinalAnswer(role: AgentRole, sessionId: string, candidate: Candidate, systemPrompt: string, modelParams: { temperature: number; maxTokens: number }, abortController: AbortController, reason: string): Promise<string> {
    appendMessage(this.saivageDir, sessionId, { role: 'system', kind: 'model_issue', content: `${this.redactModelIssueText(reason)} Forcing final-answer turn without tools.` });
    appendMessage(this.saivageDir, sessionId, { role: 'user', kind: 'text', content: this.buildForceFinalAnswerPrompt(role) });
    const modelMessages = this.buildModelMessages(sessionId);
    try {
      const forced = await this.llmCallFn!(candidate, systemPrompt, modelMessages, sessionId, { temperature: modelParams.temperature, max_tokens: modelParams.maxTokens, signal: abortController.signal });
      return forced;
    } catch (err) {
      appendMessage(this.saivageDir, sessionId, { role: 'system', kind: 'model_issue', content: `forceFinalAnswer LLM call failed: ${this.redactProviderErrorMessage(err)}` });
      throw err;
    }
  }
  private async handleToolCallsLoop(rawResponse: string, role: AgentRole, sessionId: string, candidate: Candidate, systemPrompt: string, modelParams: { temperature: number; maxTokens: number }, abortController: AbortController, invocation?: { goalId?: string; cardId?: string }): Promise<{ response: string; transportSucceeded: boolean }> {
    let currentResponse = rawResponse;
    const previousCalls = new Set<string>();
    for (;;) {
      const toolCalls = this.parseToolCallsFromResponse(currentResponse);
      if (!toolCalls) return { response: currentResponse, transportSucceeded: true };
      const callFingerprint = toolCalls.map((tc) => `${tc.function.name}:${tc.function.arguments}`).sort().join('||');
      if (previousCalls.has(callFingerprint)) {
        appendMessage(this.saivageDir, sessionId, { role: 'system', kind: 'model_issue', content: `Repeated tool-call fingerprint detected; stopping tool loop as no-progress diagnostic: ${this.redactModelIssueText(callFingerprint)}` });
        const forced = await this.forceFinalAnswer(role, sessionId, candidate, systemPrompt, modelParams, abortController, 'Repeated tool-call fingerprint detected.');
        return { response: forced, transportSucceeded: true };
      }
      previousCalls.add(callFingerprint);
      // Persist each assistant tool call independently. Codex Responses requires
      // every function_call item in history to have a matching output; planner
      // activate_card intentionally defers its output while child work runs.
      // Per-call rows let Codex history assembly drop only the deferred
      // activate_card call without hiding executed sibling tool calls/results.
      for (const tc of toolCalls) {
        appendMessage(this.saivageDir, sessionId, { role: 'assistant', kind: 'tool_call', content: JSON.stringify({ toolCalls: [tc] }), tool: tc.function.name });
      }
      const toolMessages: Array<{ role: 'tool'; kind: 'tool_result' | 'tool_error'; content: string; tool: string; tool_call_id: string }> = [];
      const deferredActivations: import('../schemas/types.js').DeferredActivationEnvelopeV1[] = [];
      for (const tc of toolCalls) {
        const msg = await this.processToolCall(tc, role, sessionId, invocation);
        const deferred = role === 'planner' && tc.function.name === 'activate_card' ? parseDeferredActivationEnvelope(msg.content) : null;
        if (deferred) deferredActivations.push(deferred);
        else toolMessages.push(msg);
      }
      for (const msg of toolMessages) appendMessage(this.saivageDir, sessionId, { role: msg.role, kind: msg.kind, content: msg.content, tool: msg.tool, tool_call_id: msg.tool_call_id });
      if (toolMessages.length === 0 && deferredActivations.length > 0) {
        const activatedIds: string[] = deferredActivations.map((envelope) => envelope.child_card_id);
        // Check whether any activated card has failed/blocked dependencies. If
        // so, propagate that as the planner envelope so the parent card is
        // marked blocked and the runtime stops tight-looping.
        const cardStoreSynth = new CardStore(this.projectRoot);
        const blockingReasons: string[] = [];
        for (const cid of activatedIds) {
          const card = cardStoreSynth.read(cid);
          if (!card) { blockingReasons.push(`card ${cid} not found`); continue; }
          for (const depId of (card.depends_on ?? [])) {
            const dep = cardStoreSynth.read(depId);
            if (dep && (dep.status === 'failed' || dep.status === 'blocked')) {
              blockingReasons.push(`${cid} depends on ${depId} (status=${dep.status})`);
            }
          }
        }
        if (blockingReasons.length > 0) {
          const blockedReason = `Cannot activate child: ${blockingReasons.join('; ')}`;
          const synthEnvelope = JSON.stringify({ status: 'blocked', blocked_reason: blockedReason, summary: blockedReason, created_cards: [], updated_cards: [] });
          appendMessage(this.saivageDir, sessionId, { role: 'system', kind: 'model_issue', content: `Synthesised planner BLOCKED envelope for deferred activate_card: ${this.redactModelIssueText(blockedReason)}` });
          return { response: synthEnvelope, transportSucceeded: true };
        }
        const synthSummary = activatedIds.length > 0 ? `Activated child card${activatedIds.length === 1 ? '' : 's'} ${activatedIds.join(', ')}; awaiting completion.` : 'Activated child card; awaiting completion.';
        const synthEnvelope = JSON.stringify({ status: 'continue', summary: synthSummary, created_cards: [], updated_cards: [] });
        appendMessage(this.saivageDir, sessionId, { role: 'system', kind: 'model_issue', content: `Synthesised planner continuation envelope for deferred activate_card: ${this.redactModelIssueText(synthSummary)}` });
        return { response: synthEnvelope, transportSucceeded: true };
      }
      const followUpTools = this.buildToolsForRole(role);
      const modelMessages = this.buildModelMessages(sessionId);
      currentResponse = await this.llmCallFn!(candidate, systemPrompt, modelMessages, sessionId, { temperature: modelParams.temperature, max_tokens: modelParams.maxTokens, signal: abortController.signal, ...(followUpTools.length > 0 ? { tools: followUpTools, tool_choice: 'auto' } : {}) });
    }
  }

  private async invokeAgent<T>(role: AgentRole, goalId: string, cardId: string, systemPrompt: string, contextMessages: AgentMessage[], parser: (raw: string) => T, requestedSessionId?: string): Promise<T> {
    if (!this.llmCallFn) throw new Error('No LLM call function registered. Call setLlmCallFn() first.');
    this.resetOnRoleChange(role);
    const modelParams = getModelParamsForRole(this.config, role);
    const tools = this.buildToolsForRole(role);
    const tool_choice: 'auto' | undefined = tools.length > 0 ? 'auto' : undefined;
    const capabilityRequest = capabilityRequestForLlmOptions({
      tools,
      tool_choice,
      stream: false,
    });
    const candidates = await this.router.resolve(role, capabilityRequest);
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
    assertNoActiveWorkerSession(this.saivageDir, role as import('../schemas/types.js').AgentRole, cardId);
    const session = createSession(this.saivageDir, role as import('../schemas/types.js').AgentRole, goalId, cardId, undefined, requestedSessionId);
    await this.sessionCoordinator.notifySessionCreated(session.id);
    this.sessionCoordinator.publishSessionStarted({ sessionId: session.id, role: role as unknown as import('../schemas/types.js').AgentRole, goalId, cardId });
    const baseSystemPrompt = systemPrompt;
    systemPrompt = this.applySelfCheck(role, systemPrompt, session.id);
    for (const msg of contextMessages) appendMessage(this.saivageDir, session.id, { role: msg.role, kind: msg.kind, content: msg.content, tool: msg.tool, links: msg.links });
    const recoveryOpts = { recoveryDelayMs: this.runtimeConfig.recoveryDelayMs ?? 60000, maxRetries: this.runtimeConfig.maxRecoveryRetries ?? 3, publishEvents: true, eventBus: this.eventBus, cardId, goalId, sessionId: session.id, agentRole: role, persistFailure: (error: Error, attempt: number, _ctx: RecoveryContext) => { try { appendMessage(this.saivageDir, session.id, { role: 'system', kind: 'model_issue', content: `Agent invocation failed (attempt ${attempt}): ${this.redactProviderErrorMessage(error.message)}` }); } catch { void 0; } if (this.eventLogger) this.eventLogger.appendEvent({ kind: 'retry_attempted', session_id: session.id, role: role as unknown as import('../schemas/types.js').AgentRole, attempt, directive: _ctx.directive }); if (this.eventBus) this.eventBus.emit('retry_attempted', { session_id: session.id, role, attempt, directive: _ctx.directive }); } };
    const agentFn = async (recoveryCtx: RecoveryContext) => {
      const candidateChain = await this.router.resolve(role, capabilityRequest);
      const capabilitySkips = this.router.getLastCapabilitySkips();
      if (candidateChain.length === 0) {
        const noCandidateDecision = defaultInvocationRecoveryPolicy.decideNoCandidates({ role, attempt: recoveryCtx.attempt, maxAttempts: recoveryCtx.maxAttempts, recoveryDelayMs: this.runtimeConfig.recoveryDelayMs ?? 60000, maxRecoveryRetries: this.runtimeConfig.maxRecoveryRetries ?? 3, capabilityRequest, capabilitySkips, sessionId: session.id, goalId, cardId });
        throw new Error(noCandidateDecision.message);
      }
      let lastError: Error | null = null;
      try {
        for (const candidate of candidateChain) {
          let sameCandidateRecoveryAttempt = 1;
          for (;;) {
            if (this.sessionCoordinator.isCancelled(session.id)) throw new Error(`Agent invocation cancelled for session ${session.id}. Role: ${role}, goal: ${goalId}, card: ${cardId}`);
            if (!this.registry.isHealthy(candidate)) break;
            try {
              updateSessionModel(this.saivageDir, session.id, candidate.model);
            if (this.eventLogger) this.eventLogger.appendEvent({ kind: 'model_selected', session_id: session.id, provider: candidate.provider, model: candidate.model, role: role as unknown as import('../schemas/types.js').AgentRole });
            if (this.eventBus) this.eventBus.emit('model_selected', { session_id: session.id, provider: candidate.provider, model: candidate.model, role });
            if (recoveryCtx.isRecovery && recoveryCtx.directive) appendMessage(this.saivageDir, session.id, { role: 'system', kind: 'model_recovered', content: recoveryCtx.directive });
            const compactionResult = await compactSession(this.saivageDir, session.id, { contextLimit: 128000, threshold: this.runtimeConfig.compactionThreshold ?? 0.8, maxCompactions: this.runtimeConfig.maxCompactions ?? 3 });
            if (compactionResult.maxReached) throw new Error(`Max compactions (${this.runtimeConfig.maxCompactions ?? 3}) reached for session ${session.id}. Session must be restarted with fresh context.`);
            if (this.eventLogger && compactionResult.compacted) this.eventLogger.appendEvent({ kind: 'compaction_triggered', session_id: session.id, role: role as unknown as import('../schemas/types.js').AgentRole, tokens_before: compactionResult.tokensBefore, tokens_after: compactionResult.tokensAfter });
            if (this.eventBus && compactionResult.compacted) this.eventBus.emit('compaction_triggered', { session_id: session.id, role, tokens_before: compactionResult.tokensBefore, tokens_after: compactionResult.tokensAfter });
            const abortController = new AbortController();
            this.sessionCoordinator.trackAbortController(session.id, abortController);
            const callStart = Date.now();
            try {
              const llmOpts: LlmCompleteOptions = { temperature: modelParams.temperature, max_tokens: modelParams.maxTokens, signal: abortController.signal, ...(tools.length > 0 ? { tools, tool_choice } : {}) };
              const firstTurnMessages = this.buildModelMessages(session.id);
              const rawResponse = await this.llmCallFn!(candidate, systemPrompt, firstTurnMessages, session.id, llmOpts);
              const loopResult = await this.handleToolCallsLoop(rawResponse, role, session.id, candidate, systemPrompt, modelParams, abortController, { goalId, cardId });
              let finalResponse = loopResult.response;
              const callDuration = Date.now() - callStart;
              appendMessage(this.saivageDir, session.id, { role: 'assistant', kind: 'text', content: finalResponse });
              let parsed: T;
              try { parsed = parser(finalResponse); } catch (err) {
                const partial = (err && typeof err === 'object' && 'partial' in (err as Record<string, unknown>)) ? (err as { partial?: unknown }).partial : null;
                const selfCheckValue = (partial && typeof partial === 'object' && partial !== null && 'self_check' in (partial as Record<string, unknown>)) ? (partial as Record<string, unknown>).self_check : null;
                const toolCallsValue = (partial && typeof partial === 'object' && partial !== null && 'toolCalls' in (partial as Record<string, unknown>)) ? (partial as Record<string, unknown>).toolCalls : null;
                if (selfCheckValue === null && toolCallsValue !== null && Array.isArray(toolCallsValue) && (role === 'planner' || role === 'executor' || role === 'reviewer')) {
                  // The model emitted `{toolCalls: [...]}` as plain content text
                  // instead of the canonical envelope (e.g. when the provider
                  // dropped tool_calls into the content channel). Re-prompt
                  // once asking for the canonical result schema.
                  appendMessage(this.saivageDir, session.id, { role: 'system', kind: 'model_issue', content: `Your previous response was a bare {"toolCalls":[...]} object in the content channel. That is NOT a valid ${role} result. Either issue real tool calls via the tool_calls API channel, or emit the canonical ${role} result JSON envelope now (with the required "status" field).` });
                  if (this.eventLogger) this.eventLogger.appendEvent({ kind: 'model_issue', session_id: session.id, role: role as unknown as import('../schemas/types.js').AgentRole, message: 'toolCalls-in-content envelope rejected; re-prompted for canonical result' });
                  const retryMessages = getSessionMessages(this.saivageDir, session.id);
                  const retryResponse = await this.llmCallFn!(candidate, systemPrompt, retryMessages, session.id, llmOpts);
                  const retryLoop = await this.handleToolCallsLoop(retryResponse, role, session.id, candidate, systemPrompt, modelParams, abortController, { goalId, cardId });
                  finalResponse = retryLoop.response;
                  appendMessage(this.saivageDir, session.id, { role: 'assistant', kind: 'text', content: finalResponse });
                  try { parsed = parser(finalResponse); }
                  catch (err2) {
                    if (role === 'executor') {
                      const fallback = buildExecutorFallbackResult(finalResponse, { cardId, sessionMessages: getSessionMessages(this.saivageDir, session.id), reason: 'tool_calls_envelope_recovery' });
                      if (fallback) { appendMessage(this.saivageDir, session.id, { role: 'system', kind: 'model_issue', content: `Executor result fallback constructed after toolCalls-envelope recovery parse failure: ${err2 instanceof Error ? this.redactProviderErrorMessage(err2.message) : 'unknown parse error'}` }); parsed = fallback as T; }
                      else throw err2;
                    } else throw err2;
                  }
                } else if (selfCheckValue !== null && (role === 'planner' || role === 'executor' || role === 'reviewer')) {
                  appendMessage(this.saivageDir, session.id, { role: 'system', kind: 'model_issue', content: `Self-check acknowledged (status=${this.redactModelIssueText(selfCheckValue)}). Resume normal ${role} flow now — emit the final ${role} result JSON (with the canonical schema, NOT a self_check wrapper).` });
                  if (this.eventLogger) this.eventLogger.appendEvent({ kind: 'self_check_triggered', session_id: session.id, role: role as unknown as import('../schemas/types.js').AgentRole, rounds: 0, threshold: 0, response: String(selfCheckValue) });
                  systemPrompt = baseSystemPrompt;
                  const retryMessages = getSessionMessages(this.saivageDir, session.id);
                  const retryResponse = await this.llmCallFn!(candidate, systemPrompt, retryMessages, session.id, llmOpts);
                  const retryLoop = await this.handleToolCallsLoop(retryResponse, role, session.id, candidate, systemPrompt, modelParams, abortController, { goalId, cardId });
                  finalResponse = retryLoop.response;
                  appendMessage(this.saivageDir, session.id, { role: 'assistant', kind: 'text', content: finalResponse });
                  try { parsed = parser(finalResponse); }
                  catch (err2) {
                    if (role === 'executor') {
                      const fallback = buildExecutorFallbackResult(finalResponse, { cardId, sessionMessages: getSessionMessages(this.saivageDir, session.id), reason: 'self_check_recovery' });
                      if (fallback) { appendMessage(this.saivageDir, session.id, { role: 'system', kind: 'model_issue', content: `Executor result fallback constructed after self-check recovery parse failure: ${err2 instanceof Error ? this.redactProviderErrorMessage(err2.message) : 'unknown parse error'}` }); parsed = fallback as T; }
                      else throw err2;
                    } else throw err2;
                  }
                } else if (role === 'executor') {
                  const fallback = buildExecutorFallbackResult(finalResponse, { cardId, sessionMessages: getSessionMessages(this.saivageDir, session.id), reason: 'parse_failure' });
                  if (fallback) { appendMessage(this.saivageDir, session.id, { role: 'system', kind: 'model_issue', content: `Executor result fallback constructed after parse failure: ${err instanceof Error ? this.redactProviderErrorMessage(err.message) : 'unknown parse error'}` }); parsed = fallback as T; }
                  else throw err;
                } else throw err;
              }
              const successDecision = defaultInvocationRecoveryPolicy.decideSuccess({ role, candidate, attempt: recoveryCtx.attempt, maxAttempts: recoveryCtx.maxAttempts, recoveryDelayMs: this.runtimeConfig.recoveryDelayMs ?? 60000, maxRecoveryRetries: this.runtimeConfig.maxRecoveryRetries ?? 3, capabilityRequest, capabilitySkips, sessionId: session.id, goalId, cardId });
              if (successDecision.markSucceeded) this.registry.markSucceeded(candidate);
              if (this.eventLogger) this.eventLogger.appendEvent({ kind: 'invocation_succeeded', session_id: session.id, role: role as unknown as import('../schemas/types.js').AgentRole, attempt: recoveryCtx.attempt, duration_ms: callDuration, failureClass: successDecision.failureClass, recoveryAction: successDecision.action });
              if (this.eventBus) this.eventBus.emit('invocation_succeeded', { session_id: session.id, role, attempt: recoveryCtx.attempt, duration_ms: callDuration, recoveryAction: successDecision.action });
              this.sessionCoordinator.clearCancellation(session.id);
              return parsed;
            } finally { this.sessionCoordinator.clearAbortController(session.id); }
            } catch (err) {
            lastError = err instanceof Error ? err : new Error(String(err));
            const policyContext: InvocationRecoveryContext = { role, candidate, attempt: sameCandidateRecoveryAttempt, maxAttempts: recoveryCtx.maxAttempts, recoveryDelayMs: this.runtimeConfig.recoveryDelayMs ?? 60000, maxRecoveryRetries: this.runtimeConfig.maxRecoveryRetries ?? 3, capabilityRequest, capabilitySkips, sessionId: session.id, goalId, cardId };
            const decision = defaultInvocationRecoveryPolicy.decideFailure(lastError, policyContext);
            if (decision.markFailed) this.registry.markFailed(candidate, decision.cooldownMs ?? (this.runtimeConfig.recoveryDelayMs ?? 60000));
            if (decision.appendModelIssue) appendMessage(this.saivageDir, session.id, { role: 'system', kind: 'model_issue', content: this.redactModelIssueText(decision.message) });
            if (this.eventLogger) this.eventLogger.appendEvent({ kind: 'invocation_failed', session_id: session.id, role: role as unknown as import('../schemas/types.js').AgentRole, attempt: recoveryCtx.attempt, error_message: this.redactModelIssueText(decision.message), failureClass: decision.failureClass, recoveryAction: decision.action, cooldownMs: decision.cooldownMs, retryDelayMs: decision.retryDelayMs, capabilitySkipReasons: decision.eventPayload.capabilitySkipReasons });
            if (this.eventBus) this.eventBus.emit('invocation_failed', { session_id: session.id, role, attempt: recoveryCtx.attempt, error_message: this.redactModelIssueText(decision.message), failureClass: decision.failureClass, recoveryAction: decision.action, cooldownMs: decision.cooldownMs, retryDelayMs: decision.retryDelayMs, capabilitySkipReasons: decision.eventPayload.capabilitySkipReasons });
            if (decision.abort || this.sessionCoordinator.isCancelled(session.id)) {
              this.sessionCoordinator.publishCancelledRetryStop(session.id, role as unknown as import('../schemas/types.js').AgentRole);
              if (decision.failureClass === 'cancelled' || this.sessionCoordinator.isCancelled(session.id)) throw new Error(`Agent invocation cancelled for session ${session.id}. Role: ${role}, goal: ${goalId}, card: ${cardId}`);
              throw lastError;
            }
            if (decision.action === 'retry_same_after_delay') {
              if (this.eventLogger) this.eventLogger.appendEvent({ kind: 'retry_attempted', session_id: session.id, role: role as unknown as import('../schemas/types.js').AgentRole, attempt: recoveryCtx.attempt, directive: this.redactModelIssueText(decision.message), failureClass: decision.failureClass, recoveryAction: decision.action, retryDelayMs: decision.retryDelayMs });
              if (this.eventBus) this.eventBus.emit('retry_attempted', { session_id: session.id, role, attempt: recoveryCtx.attempt, directive: this.redactModelIssueText(decision.message), failureClass: decision.failureClass, recoveryAction: decision.action, retryDelayMs: decision.retryDelayMs });
              await delayInvocationRecovery(decision.retryDelayMs ?? 0);
              sameCandidateRecoveryAttempt += 1;
              continue;
            }
            break;
          }
          }
        }        throw lastError ?? new Error(`All candidates exhausted for role '${role}'.`);
      } finally { this.sessionCoordinator.clearCancellation(session.id); }
    };
    const attempts = await invokeWithRecovery(agentFn, recoveryOpts);
    const lastAttempt = attempts[attempts.length - 1];
    if (lastAttempt.success && lastAttempt.result !== undefined) {
      const resultValue = lastAttempt.result as T;
      const resultStatus = typeof resultValue === 'object' && resultValue !== null && 'status' in (resultValue as Record<string, unknown>)
        ? (resultValue as Record<string, unknown>).status
        : null;
      if (role === 'planner' && resultStatus === 'continue') markSessionWaiting(this.saivageDir, session.id);
      else if (role === 'planner' && resultStatus === 'blocked') completeSession(this.saivageDir, session.id, 'blocked');
      else if (role === 'executor' && resultStatus === 'failed') completeSession(this.saivageDir, session.id, 'failed');
      else completeSession(this.saivageDir, session.id, 'done');
      return resultValue;
    }
    completeSession(this.saivageDir, session.id, 'failed');
    throw lastAttempt.error ?? new Error(`Agent '${role}' invocation failed after ${attempts.length} attempts.`);
  }

  getRouter(): ModelRouter { return this.router; }
  getRegistry(): ProviderRegistry { return this.registry; }

  async flushRecorders(): Promise<void> { await this.llmGateway.flushRecorders(); }

  createLlmCallFn(): LlmCallFn { return this.llmGateway.createLlmCallFn(); }

}

export function createAgentAdapter(projectRoot: string, eventBus?: EventEmitter): AgentAdapter { const saivageDir = `${projectRoot}/.saivage`; const { config, warnings } = loadConfig(projectRoot); if (warnings.length > 0 && eventBus) for (const warning of warnings) eventBus.emit('config_warning', { warning }); return new AgentAdapter({ projectRoot, saivageDir, config, eventBus }); }
