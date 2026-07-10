import type { AgentMessage, ControlActionSurface, ControlActionAuditEntry } from '../schemas/index.js';
import type { ToolContext } from '../tools/analyst-tool-types.js';
import {
  ANALYST_NO_MODEL_REPLY,
  AnalystOfflineError,
  formatVocabularySnippet,
} from './analyst-prompt.js';
import { CardStore } from '../cards/store-api.js';
import type { RuntimeApi } from '../runtime/control-api.js';
import type { EventBus, EventPayload } from '../events/index.js';
import { buildRuntimeDiagnosticEvent } from '../runtime/runtime-diagnostic-event.js';
import type { CandidateAvailability } from './candidate-availability.js';
import type { EventLogger } from '../observability/index.js';
import type { McpManager } from '../mcp/manager-api.js';
import type { ActorRole } from './authz.js';
import { sanitizeAnalystText } from '../agents/analyst-sanitization.js';
import { ANALYST_UNSUPPORTED_ACTION_TEMPLATE } from './analyst-tool-runner.js';
import { getModelParamsForRole } from './config-schema.js';
import type { SaivageConfig } from './config-schema.js';
import { capabilityRequestForLlmOptions } from './provider-capabilities.js';
import { buildAgentProtocolViolation, parseProtocolToolArgs } from './agent-protocol-violation.js';
import { buildContextTextMessage, conversationMessagesForModel, readActiveVersionMessages, readConversationMessages } from '../runtime/actors/conversation-store.js';
import { buildResponsesReplayProjection } from './llm-openai-responses-mapper.js';
import { ConversationLLMActor, type LLMActorOutcome, type LLMProviderPort } from '../runtime/actors/llm-actor.js';
import { appendLlmTurnMessage } from '../runtime/actors/llm-delivery-log.js';
import { createConversationChangePublisher } from '../runtime/actors/conversation-publisher.js';
import type { LlmInvocationInput } from '../runtime/actors/llm-invocation.js';
import { activeConversationReplayForInvocation, genericContextMessagesForInvocation } from '../runtime/actors/llm-invocation.js';
import { resolveAnalystSessionId } from './session-ids.js';
import { invokeToolCall, surfaceToolDefinitions, type InvocationSurface, type ToolResult } from '../tools/invocation.js';
import { createProcessProvider } from '../tools/process-provider.js';
import { buildRoleSurface } from '../tools/role-invocation-surfaces.js';
import type { ProcessRunner } from '../runtime/process-runner.js';
import { BaseActor, type ActorDefinition } from '../runtime/micro-actor/index.js';
import { deferred, type Deferred } from '../runtime/actors/deferred.js';
import { formatPromptToolList, type PromptTemplateRegistry } from '../utils/prompt-api.js';


export interface WorkspaceContext {
  view: string | null;
  entityId: string | null;
  refinement: Record<string, string> | null;
}

function isWorkspaceContextEmpty(workspaceContext?: WorkspaceContext): boolean {
  if (!workspaceContext) return true;
  const refinement = workspaceContext.refinement;
  return workspaceContext.view === null
    && workspaceContext.entityId === null
    && (!refinement || Object.keys(refinement).length === 0);
}

export function buildWorkspaceContextNote(workspaceContext?: WorkspaceContext): string {
  if (isWorkspaceContextEmpty(workspaceContext)) return '[workspace-context] none — no entity is currently in focus';
  const lines = ['[workspace-context]'];
  if (workspaceContext?.view !== null && workspaceContext?.view !== undefined) lines.push(`view: ${workspaceContext.view}`);
  if (workspaceContext?.entityId !== null && workspaceContext?.entityId !== undefined) lines.push(`entity: ${workspaceContext.entityId}`);
  const refinement = workspaceContext?.refinement;
  if (refinement && Object.keys(refinement).length > 0) {
    lines.push(`refinement: ${Object.entries(refinement).map(([key, value]) => `${key}=${value}`).join(';')}`);
  }
  return lines.join('\n');
}

export interface ActivityCallback {
  (activity: { type: 'tool_call' | 'tool_result' | 'thinking'; content: Record<string, unknown> }): void;
}

export interface AnalystResponse {
  sessionId: string;
  cancelled?: boolean;
  toolInvocations?: Array<{
    tool: string;
    params: Record<string, unknown>;
    result: ToolResult;
  }>;
}

export interface AnalystRuntimeDeps {
  cardStore: CardStore;
  runtime: Pick<RuntimeApi, 'startProject' | 'stopProject' | 'pause' | 'resume' | 'notifyCard' | 'getStatus'>;
  candidateAvailability?: CandidateAvailability;
  eventLogger?: EventLogger;
  emitAnalystToolInvoked(payload: EventPayload<'analyst_tool_invoked'>): void;
  eventBus: EventBus;
  mcpManager?: McpManager;
  provider: LLMProviderPort;
  processRunner: ProcessRunner;
}

export interface AnalystTurnInput {
  userContent: string;
  workspaceContext?: WorkspaceContext;
  actor?: ActorRole;
  surface?: ControlActionSurface;
}

export type AnalystTurnResult = AnalystResponse;

type AnalystToolInvocations = NonNullable<AnalystResponse['toolInvocations']>;

export interface AnalystSessionReadModel {
  sessionId: string;
  phase: 'idle' | 'conversing';
  toolInFlight: string | null;
  lastOutcome: 'completed' | 'failed' | 'cancelled' | null;
}

function summarizeForBroadcast(tool: string, result: ToolResult): { summary: string; classified_as?: string; related_card_id?: string; related_note_id?: string; related_process_id?: string } {
  const data = result.success && result.data && typeof result.data === 'object' ? result.data as Record<string, unknown> : null;
  const source = data ?? {};
  const auditSource = data?.['audit_entry'] && typeof data['audit_entry'] === 'object' ? data['audit_entry'] as ControlActionAuditEntry : null;
  const classified_as = typeof source['classified_as'] === 'string' ? String(source['classified_as']) : undefined;
  const relatedCardFromData = typeof data?.['id'] === 'string' && (tool === 'edit_card' || tool === 'get_card' || tool === 'create_card') ? String(data['id']) : undefined;
  const related_card_id = typeof source['card_id'] === 'string' ? String(source['card_id']) : relatedCardFromData ?? (typeof source['related_card_id'] === 'string' ? String(source['related_card_id']) : auditSource?.target_kind === 'card' && auditSource.target_id ? auditSource.target_id : undefined);
  const related_note_id = typeof source['note_id'] === 'string' ? String(source['note_id']) : typeof source['related_note_id'] === 'string' ? String(source['related_note_id']) : auditSource?.target_kind === 'note' && auditSource.target_id ? auditSource.target_id : undefined;
  const related_process_id = typeof source['process_id'] === 'string' ? String(source['process_id']) : typeof source['related_process_id'] === 'string' ? String(source['related_process_id']) : auditSource?.target_kind === 'process' && auditSource.target_id ? auditSource.target_id : undefined;

  let summary = result.success ? (tool === 'edit_card' && related_card_id ? `edited card ${related_card_id}` : 'completed') : result.error;
  if (auditSource?.outcome_summary) {
    summary = auditSource.outcome_summary;
  } else if (tool === 'read' && data) {
    const path = typeof data['path'] === 'string' ? data['path'] : 'file';
    const binary = data['binary'] === true;
    const size = typeof data['size'] === 'number' ? ` (${data['size']} bytes)` : '';
    summary = binary ? `read binary file ${path}${size}` : `read file ${path}${size}`;
  } else if (tool === 'glob' && data) {
    const path = typeof data['path'] === 'string' ? data['path'] : 'directory';
    const count = Array.isArray(data['matches']) ? data['matches'].length : 0;
    summary = `globbed ${path} (${count} matches)`;
  } else if (tool === 'run_command') {
    if (data) {
      const code = data['exit_code'];
      summary = `${classified_as ?? 'shell'} command exit=${code === null ? 'null' : String(code)}`;
    }
  }

  return { summary: sanitizeAnalystText(summary, 200), classified_as, related_card_id, related_note_id, related_process_id };
}



function broadcastToolInvocation(deps: AnalystRuntimeDeps, sessionId: string, tool: string, result: ToolResult): void {
  const payload = summarizeForBroadcast(tool, result);
  deps.emitAnalystToolInvoked({ sessionId, tool, success: result.success, ...payload });
}

function analystToolContext(args: { projectRoot: string; runtimeDeps: AnalystRuntimeDeps; sessionId?: string; actor: ActorRole; surface: ControlActionSurface; requestServerRestart?: () => Promise<void> }): ToolContext {
  return { projectRoot: args.projectRoot, processRunner: args.runtimeDeps.processRunner, store: args.runtimeDeps.cardStore, sessionId: args.sessionId, runtime: args.runtimeDeps.runtime, mcpManager: args.runtimeDeps.mcpManager, requestServerRestart: args.requestServerRestart, actor: args.actor, surface: args.surface, eventBus: args.runtimeDeps.eventBus };
}

type PendingAnalystTurn = {
  input: AnalystTurnInput;
  onActivity?: ActivityCallback;
};

export class AnalystSessionActor extends BaseActor {
  static _actor: ActorDefinition = {
    initial: 'idle',
    states: {
      idle: { parked: true, on: { submit: 'conversing' } },
      conversing: { on: { done: 'idle', failed: 'idle', cancel: 'idle' } },
    },
  };

  private readonly llm: ConversationLLMActor;
  private pendingTurn: PendingAnalystTurn | null = null;
  private result: Deferred<AnalystTurnResult> | null = null;
  private turnAbort: AbortController | null = null;
  private cancellationReason: string | null = null;
  private toolInFlight: string | null = null;
  private started = false;
  private lastOutcome: AnalystSessionReadModel['lastOutcome'] = null;

  constructor(private readonly args: { projectRoot: string; sessionId: string; config: SaivageConfig; runtimeDeps: AnalystRuntimeDeps; promptTemplates: PromptTemplateRegistry; actor?: ActorRole; surface?: ControlActionSurface; requestServerRestart?: () => Promise<void> }) {
    super();
    this.llm = new ConversationLLMActor({ projectRoot: args.projectRoot, agentId: args.sessionId, provider: args.runtimeDeps.provider, conversationPublisher: createConversationChangePublisher(args.runtimeDeps.eventBus) });
    if (readConversationMessages(args.projectRoot, args.sessionId).some((message) => message.kind === 'system_prompt')) {
      this.llm.seedSystemPromptLogged(args.sessionId);
    }
  }

  override start(): void {
    this.llm.start();
    super.start();
    this.started = true;
  }

  get sessionId(): string {
    return this.args.sessionId;
  }

  submit(input: AnalystTurnInput, onActivity?: ActivityCallback): Promise<AnalystTurnResult> {
    if (!this.started) return Promise.reject(new Error(`Analyst session '${this.sessionId}' has not started.`));
    if (this.state() !== 'idle' || this.result) return Promise.reject(new Error(`Analyst session '${this.sessionId}' already has an active turn.`));
    this.pendingTurn = { input, onActivity };
    this.result = deferred<AnalystTurnResult>();
    this.parkedSendEvent('submit');
    return this.result.promise;
  }

  cancel(reason: string): boolean {
    const result = this.result;
    if (this.state() !== 'conversing' || !result) return false;
    this.cancellationReason = reason;
    this.turnAbort?.abort(new Error(reason));
    this.pendingTurn = null;
    this.result = null;
    this.lastOutcome = 'cancelled';
    this.persistAssistantNotice(`Cancelled: ${reason}`);
    result.resolve({ sessionId: this.sessionId, cancelled: true });
    this.sendEvent('cancel');
    return true;
  }

  readModel(): AnalystSessionReadModel {
    return { sessionId: this.sessionId, phase: this.state() === 'conversing' ? 'conversing' : 'idle', toolInFlight: this.toolInFlight, lastOutcome: this.lastOutcome };
  }

  _on_enter__conversing(): void {
    const turn = this.pendingTurn;
    const result = this.result;
    if (!turn || !result) throw new Error(`Analyst session '${this.sessionId}' entered conversing without a pending turn.`);
    const turnAbort = new AbortController();
    this.turnAbort = turnAbort;
    this.cancellationReason = null;
    this.toolInFlight = null;
    this.runTask(() => this.runAnalystLoop(turn.input, turnAbort.signal), {
      on_done: (response) => {
        this.cleanupTurnState();
        if (this.cancellationReason !== null) {
          this.resetCancellationState();
          return;
        }
        if (this.result !== result) return;
        this.pendingTurn = null;
        this.result = null;
        this.lastOutcome = 'completed';
        result.resolve(response);
        this.sendEvent('done');
      },
      on_failed: (error) => {
        this.cleanupTurnState();
        if (this.cancellationReason !== null) {
          this.resetCancellationState();
          return;
        }
        if (this.result !== result) return;
        this.pendingTurn = null;
        this.result = null;
        this.lastOutcome = 'failed';
        result.reject(error);
        this.sendEvent('failed');
      },
    });
  }

  private async runAnalystLoop(input: AnalystTurnInput, signal: AbortSignal): Promise<AnalystResponse> {
    const sessionId = this.sessionId;
    const toolInvocations: AnalystToolInvocations = [];
    const ctx = analystToolContext({ projectRoot: this.args.projectRoot, runtimeDeps: this.args.runtimeDeps, sessionId, actor: this.args.actor ?? 'analyst', surface: this.args.surface ?? 'web-chat', requestServerRestart: this.args.requestServerRestart });
    const surface = buildRoleSurface('analyst', { projectRoot: this.args.projectRoot, toolContext: ctx, store: ctx.store, processRunner: ctx.processRunner, sessionId: ctx.sessionId, ownerId: ctx.sessionId ?? 'analyst', mcpManagerProvider: () => ctx.mcpManager, notifyCard: (cardId, notification) => this.args.runtimeDeps.runtime.notifyCard(cardId, notification) });
    const previousToolCallFingerprints = new Set<string>();
    let noProgressDirectiveSent = false;
    const workspaceContextMessage = buildContextTextMessage(sessionId, 'system', buildWorkspaceContextNote(input.workspaceContext));
    const userMessage = buildContextTextMessage(sessionId, 'user', input.userContent);
    const invocationInput = this.buildInvocationInput([workspaceContextMessage, userMessage], surface);
    let outcome: LLMActorOutcome;

    try {
      this.throwIfCancelled();
      outcome = await this.llm.turn(invocationInput, signal);
    } catch (err) {
      if (this.isCancelled()) return this.cancelledLoopResponse();
      return this.errorResponse(err, toolInvocations, invocationInput);
    }

    for (;;) {
      this.throwIfCancelled();
      if (outcome.type === 'error') {
        this.persistAssistantNotice(this.errorMessage(outcome.error));
        return this.response(toolInvocations);
      }

      if (outcome.type === 'result') {
        return this.response(toolInvocations);
      }

      const toolCall = outcome;
      const rawArguments = typeof this.llm.waitingToolCall?.toolCallArguments === 'string' ? this.llm.waitingToolCall.toolCallArguments : JSON.stringify(toolCall.args);
      const fingerprint = `${toolCall.toolName}:${rawArguments}`;
      if (previousToolCallFingerprints.has(fingerprint)) {
        if (this.llm.deliveredToolCallIds.has(toolCall.toolCallId)) {
          this.persistAssistantNotice('I repeated the same tool calls without making progress. Please refine the request or inspect the latest tool results.');
          return this.response(toolInvocations);
        }
        if (noProgressDirectiveSent) {
          this.persistAssistantNotice('I repeated the same tool calls without making progress. Please refine the request or inspect the latest tool results.');
          return this.response(toolInvocations);
        }
        noProgressDirectiveSent = true;
        outcome = await this.rejectToolCall(
          toolCall,
          'The same tool call was repeated without progress. Stop calling tools and answer the operator from the latest tool results.',
          'no_progress',
          toolCall.args && typeof toolCall.args === 'object' ? toolCall.args as Record<string, unknown> : {},
          toolInvocations,
          signal,
        );
        continue;
      }
      previousToolCallFingerprints.add(fingerprint);

      if (!surface.tools.has(toolCall.toolName)) {
        outcome = await this.rejectToolCall(
          toolCall,
          ANALYST_UNSUPPORTED_ACTION_TEMPLATE('Analyst', Array.from(surface.tools.keys())),
          'unsupported_action',
          {},
          toolInvocations,
          signal,
        );
        continue;
      }

      const parsed = parseProtocolToolArgs(rawArguments);
      if (parsed.kind === 'violation') {
        const violation = buildAgentProtocolViolation({ session_id: sessionId, role: 'analyst', tool_call_id: toolCall.toolCallId, tool_name: toolCall.toolName, violation: parsed.violation, raw: rawArguments });
        this.logBoundaryDiagnostic('analyst_tool_arguments_protocol_violation', new Error(`${parsed.violation}: ${parsed.detail}`));
        outcome = await this.rejectToolCall(
          toolCall,
          JSON.stringify(violation),
          'agent_protocol_violation',
          {},
          toolInvocations,
          signal,
        );
        continue;
      }

      const params = parsed.args;
      this.emitActivity({ type: 'tool_call', content: { tool: toolCall.toolName, params } });
      this.throwIfCancelled();
      this.toolInFlight = toolCall.toolName;
      let result: ToolResult;
      try {
        result = await invokeToolCall(surface, toolCall.toolName, rawArguments, signal);
      } catch (err) {
        if (this.isCancelled()) return this.cancelledLoopResponse();
        throw err;
      }
      this.toolInFlight = null;
      this.throwIfCancelled();

      this.emitActivity({ type: 'tool_result', content: { tool: toolCall.toolName, success: result.success } });
      toolInvocations.push({ tool: toolCall.toolName, params, result });
      broadcastToolInvocation(this.args.runtimeDeps, sessionId, toolCall.toolName, result);
      outcome = await this.appendToolResult(toolCall.toolCallId, result, toolInvocations, signal);
    }
  }

  private async rejectToolCall(toolCall: Extract<LLMActorOutcome, { type: 'tool_call' }>, error: string, errorKind: string, params: Record<string, unknown>, toolInvocations: AnalystToolInvocations, signal: AbortSignal): Promise<LLMActorOutcome> {
    const result: ToolResult = { success: false, error };
    this.emitActivity({ type: 'tool_result', content: { tool: toolCall.toolName, success: false, errorKind } });
    toolInvocations.push({ tool: toolCall.toolName, params, result });
    return this.appendToolResult(toolCall.toolCallId, result, toolInvocations, signal);
  }

  private async appendToolResult(toolCallId: string, result: ToolResult, toolInvocations: AnalystToolInvocations, signal: AbortSignal): Promise<LLMActorOutcome> {
    try {
      this.throwIfCancelled();
      return await this.llm.appendToolResult(toolCallId, result, signal);
    } catch (err) {
      if (this.isCancelled()) return this.cancelledLoopOutcome();
      const message = this.errorMessage(err);
      this.persistAssistantNotice(message);
      return { type: 'result', agentId: this.llm.agentId, result: { kind: 'message', content: message } };
    }
  }

  private buildInvocationInput(newMessages: AgentMessage[], surface: InvocationSurface): LlmInvocationInput {
    const tools = surfaceToolDefinitions(surface);
    const modelParams = getModelParamsForRole(this.args.config, 'analyst');
    const activeRows = this.llm.input
      ? [...activeConversationReplayForInvocation(this.llm.input).messages, ...newMessages]
      : [...readActiveVersionMessages(this.args.projectRoot, this.sessionId), ...newMessages];
    const genericContextMessages = this.llm.input
      ? [...genericContextMessagesForInvocation(this.llm.input), ...newMessages]
      : conversationMessagesForModel(activeRows);
    return {
      inputId: `${this.llm.agentId}:turn:${Date.now()}`,
      agentId: this.llm.agentId,
      role: 'analyst',
      sessionId: this.sessionId,
      systemPrompt: this.args.promptTemplates.render('analyst', 'analyst', {
        toolList: formatPromptToolList(tools),
        vocabularySnippet: formatVocabularySnippet(),
        projectContext: this.buildProjectContext(),
      }),
      genericContextMessages,
      contextMessages: genericContextMessages,
      activeConversationReplay: buildResponsesReplayProjection(this.sessionId, activeRows),
      turnMessages: newMessages,
      tools,
      terminalToolNames: [],
      modelParams: { temperature: modelParams.temperature, maxTokens: modelParams.maxTokens },
      capabilityRequest: capabilityRequestForLlmOptions({ tools, stream: false }),
      episodeContext: { surface: this.args.surface ?? 'web-chat' },
    };
  }

  private emitActivity(activity: { type: 'tool_call' | 'tool_result' | 'thinking'; content: Record<string, unknown> }): void {
    const onActivity = this.pendingTurn?.onActivity;
    if (!onActivity) return;
    try { onActivity(activity); } catch (err) { this.logBoundaryDiagnostic('analyst_activity_callback_failed', err); }
  }

  private logBoundaryDiagnostic(phase: string, err: unknown): void {
    try {
      this.args.runtimeDeps.eventLogger?.appendEvent(buildRuntimeDiagnosticEvent({ phase, error: err }));
    } catch {
      /* best-effort diagnostics; never fail the analyst response path */
    }
  }

  private errorMessage(err: unknown): string {
    const noHealthyMessage = `No healthy candidates available for role 'analyst'.`;
    const error = typeof err === 'string' ? err : err instanceof Error ? err.message : String(err);
    return err instanceof AnalystOfflineError
      ? err.message
      : error === noHealthyMessage
        ? ANALYST_NO_MODEL_REPLY
        : `Analyst LLM unavailable: ${error}`;
  }

  private errorResponse(err: unknown, toolInvocations: AnalystToolInvocations, input?: LlmInvocationInput): AnalystResponse {
    if (input) {
      const message = appendLlmTurnMessage(this.args.projectRoot, input, this.errorMessage(err));
      this.llm.conversationPublisher?.entryAppended(message.appendResult);
    }
    return this.response(toolInvocations);
  }

  private response(toolInvocations?: AnalystToolInvocations): AnalystResponse {
    return { sessionId: this.sessionId, toolInvocations: toolInvocations && toolInvocations.length > 0 ? toolInvocations : undefined };
  }

  private persistAssistantNotice(content: string): void {
    const input = this.llm.input;
    if (!input) return;
    const message = appendLlmTurnMessage(this.args.projectRoot, input, content);
    this.llm.conversationPublisher?.entryAppended(message.appendResult);
  }

  private buildProjectContext(): string {
    try {
      const store = this.args.runtimeDeps.cardStore;
      return JSON.stringify({ projectRoot: this.args.projectRoot, cards: store.list().map((card) => ({ id: card.id, type: card.type, parent: card.parent, status: card.status, title: card.title, priority: card.priority, tags: card.tags })) }, null, 2);
    } catch (err) {
      this.logBoundaryDiagnostic('analyst_project_context_build_failed', err);
      return `Project root: ${this.args.projectRoot}`;
    }
  }

  private cleanupTurnState(): void {
    this.toolInFlight = null;
    this.turnAbort = null;
    if (this.llm.state() === 'waiting_tool') this.llm.abandonParkedTurn();
  }

  private resetCancellationState(): void {
    this.cancellationReason = null;
  }

  private isCancelled(): boolean {
    return this.cancellationReason !== null || this.turnAbort?.signal.aborted === true;
  }

  private throwIfCancelled(): void {
    if (this.isCancelled()) throw new Error('Analyst turn cancelled.');
  }

  private cancelledLoopResponse(): AnalystResponse {
    this.persistAssistantNotice(`Cancelled: ${this.cancellationReason ?? 'cancelled'}`);
    return { sessionId: this.sessionId, cancelled: true };
  }

  private cancelledLoopOutcome(): LLMActorOutcome {
    return { type: 'result', agentId: this.llm.agentId, result: { kind: 'message', content: `Cancelled: ${this.cancellationReason ?? 'cancelled'}` } };
  }
}

export class AnalystRuntime {
  private readonly sessions = new Map<string, AnalystSessionActor>();

  constructor(private readonly args: { projectRoot: string; config: SaivageConfig; runtimeDeps: AnalystRuntimeDeps; promptTemplates: PromptTemplateRegistry; requestServerRestart?: () => Promise<void> }) {}

  setRequestServerRestart(requestServerRestart: (() => Promise<void>) | undefined): void {
    this.args.requestServerRestart = requestServerRestart;
  }

  submit(sessionId: string, input: AnalystTurnInput, onActivity?: ActivityCallback): Promise<AnalystTurnResult> {
    return this.getOrCreateSession(sessionId, input).submit(input, onActivity);
  }

  cancel(sessionId: string, reason: string): boolean {
    return this.sessions.get(resolveAnalystSessionId(sessionId))?.cancel(reason) ?? false;
  }

  listSessions(): AnalystSessionReadModel[] {
    return [...this.sessions.values()].map((session) => session.readModel());
  }

  getAvailableToolNames(actor: ActorRole = 'analyst', surface: ControlActionSurface = 'web-chat'): string[] {
    const ctx = analystToolContext({ projectRoot: this.args.projectRoot, runtimeDeps: this.args.runtimeDeps, actor, surface, requestServerRestart: this.args.requestServerRestart });
    return Array.from(buildRoleSurface('analyst', { projectRoot: this.args.projectRoot, toolContext: ctx, store: ctx.store, processRunner: ctx.processRunner, sessionId: ctx.sessionId, ownerId: ctx.sessionId ?? 'analyst', mcpManagerProvider: () => ctx.mcpManager, notifyCard: (cardId, notification) => this.args.runtimeDeps.runtime.notifyCard(cardId, notification) }).tools.keys());
  }

  async shutdown(): Promise<void> {
    await Promise.all([...this.sessions.keys()].map((sessionId) => this.shutdownSessionProcesses(sessionId)));
  }

  async shutdownSessionProcesses(sessionId: string): Promise<void> {
    const ownerId = resolveAnalystSessionId(sessionId);
    await createProcessProvider({ projectRoot: this.args.projectRoot, processRunner: this.args.runtimeDeps.processRunner, ownerId, agentRole: 'analyst', ownerKind: 'operator', launchReason: 'analyst workspace run_command' }).cleanup?.({ kind: 'session_closed' });
  }

  private getOrCreateSession(sessionId: string, input?: AnalystTurnInput): AnalystSessionActor {
    const resolvedSessionId = resolveAnalystSessionId(sessionId);
    let actor = this.sessions.get(resolvedSessionId);
    if (!actor) {
      actor = new AnalystSessionActor({ ...this.args, sessionId: resolvedSessionId, actor: input?.actor, surface: input?.surface });
      actor.start();
      this.sessions.set(resolvedSessionId, actor);
    }
    return actor;
  }
}
