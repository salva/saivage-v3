import { GLOBAL_ANALYST_SESSION_ID, type AnalystConversationSessionId, type ControlActionSurface, type ControlActionAuditEntry } from '../schemas/index.js';
import type { ToolContext } from '../tools/analyst-tool-types.js';
import type { ResolvedConfigAuthority } from '../config/index.js';
import {
  ANALYST_NO_MODEL_REPLY,
  AnalystOfflineError,
  formatVocabularySnippet,
} from './analyst-prompt.js';
import { CardService } from '../cards/card-api.js';
import type { RuntimeApi } from '../runtime/control-api.js';
import type { EventBus } from '../events/index.js';
import { buildRuntimeDiagnosticEvent } from '../runtime/runtime-diagnostic-event.js';
import type { EventLog } from '../observability/index.js';
import type { McpToolInvocationPort } from '../mcp/manager-api.js';
import type { ActorRole } from './authz.js';
import { sanitizeAnalystText } from '../agents/analyst-sanitization.js';
import { ANALYST_UNSUPPORTED_ACTION_TEMPLATE } from './analyst-tool-runner.js';
import { getModelParamsForRole } from './config-schema.js';
import type { SaivageConfig } from './config-schema.js';
import { capabilityRequestForLlmOptions } from './provider-capabilities.js';
import { buildAgentProtocolViolation, parseProtocolToolArgs } from './agent-protocol-violation.js';
import { appendAnalystIngressBatch, appendAnalystRestartBatch, providerConversationProjection } from '../runtime/actors/conversation-session.js';
import { ConversationLLMActor, type LLMActorOutcome, type LLMProviderPort } from '../runtime/actors/llm-actor.js';
import { appendLlmTurnMessage } from '../runtime/actors/llm-delivery-log.js';
import { readConversation, type ConversationFileContext } from '../persistence/conversation-file.js';
import type { AppLogContext } from '../persistence/app-log.js';
import type { PreparedLlmInvocationInput } from '../runtime/actors/llm-invocation.js';
import { invokeToolCall, surfaceToolDefinitions, type InvocationSurface, type ToolResult } from '../tools/invocation.js';
import { buildRoleSurface } from '../tools/role-invocation-surfaces.js';
import type { ProcessRunner } from '../runtime/process-runner.js';
import type { ManagedProcessScope } from '../runtime/process-runner.js';
import { BaseActor, compileActorDefinition } from '../runtime/micro-actor/index.js';
import { deferred, type Deferred } from '../runtime/actors/deferred.js';
import { formatPromptToolList, type PromptTemplateRegistry } from '../utils/prompt-api.js';
import type { RestartPort } from '../boot/restart-port.js';
import type { RestartChatAcknowledgement } from '../contracts/operator-api-chats.js';
import { ActivationOperationTracker, type InvocationJoinOutcome } from '../runtime/actors/invocation-lifecycle.js';
import { createAnalystMutationServices } from '../application/analyst-mutation-services.js';
import type { CompactorPort } from '../runtime/actors/llm-actor.js';
import { prepareCompaction, type AutonomousCompactionPolicy } from '../runtime/actors/compaction/compactor.js';
import type { SummarizerProviderPort } from '../runtime/actors/compaction/summarizer.js';
import type { ExecutingLlmSnapshot } from '../runtime/actors/executing-llm-snapshot.js';


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
  sessionId: AnalystConversationSessionId;
  restart: RestartChatAcknowledgement | null;
  cancelled?: boolean;
  toolInvocations?: Array<{
    tool: string;
    params: Record<string, unknown>;
    result: ToolResult;
  }>;
}

export interface AnalystRuntimeDeps {
  configAuthority: ResolvedConfigAuthority;
  cardStore: CardService;
  runtime: Pick<RuntimeApi, 'startProject' | 'pause' | 'resume' | 'stopProject' | 'cancelCard' | 'notifyCard' | 'getStatus'>;
  runtimeControl?: import('../application/runtime-control-service.js').RuntimeControlApplicationPort;
  eventLogger?: EventLog;
  eventBus: EventBus;
  mcpToolInvocation: McpToolInvocationPort;
  provider: LLMProviderPort;
  compactionPolicy: AutonomousCompactionPolicy;
  compactor: CompactorPort;
  summarizerProvider: SummarizerProviderPort;
  processRunner: ProcessRunner;
  analystProcessRootScope: ManagedProcessScope;
  conversations: ConversationFileContext;
  appLogs: AppLogContext;
  interventionReadiness: import('../application/intervention-readiness.js').InterventionReadinessFacet;
  runtimeProjectionChanged(): void;
  captureExecutingLlmSnapshots(): readonly ExecutingLlmSnapshot[];
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
  sessionId: AnalystConversationSessionId;
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



function broadcastToolInvocation(deps: AnalystRuntimeDeps, sessionId: AnalystConversationSessionId, tool: string, result: ToolResult): void {
  const payload = summarizeForBroadcast(tool, result);
  deps.eventBus.emit('analyst_tool_invoked', { sessionId, tool, success: result.success, ...payload });
}

function analystToolContext(args: { projectRoot: string; runtimeDeps: AnalystRuntimeDeps; store: CardService; processScope: ManagedProcessScope; sessionId?: string; actor: ActorRole; surface: ControlActionSurface; restartServerAvailable: boolean }): ToolContext {
  const notifyCard = args.runtimeDeps.runtime.notifyCard.bind(args.runtimeDeps.runtime);
  const analystMutations = createAnalystMutationServices({ projectRoot: args.projectRoot, store: args.store, configAuthority: args.runtimeDeps.configAuthority, surface: args.surface, notifyCard, cancelCard: args.runtimeDeps.runtime.cancelCard.bind(args.runtimeDeps.runtime) });
  return { projectRoot: args.projectRoot, configAuthority: args.runtimeDeps.configAuthority, interventionReadiness: args.runtimeDeps.interventionReadiness, processRunner: args.runtimeDeps.processRunner, processScope: args.processScope, store: args.store, sessionId: args.sessionId, runtime: args.runtimeDeps.runtime, runtimeControl: args.runtimeDeps.runtimeControl, mcpToolInvocation: args.runtimeDeps.mcpToolInvocation, restartServerAvailable: args.restartServerAvailable, actor: args.actor, surface: args.surface, eventBus: args.runtimeDeps.eventBus, appLogs: args.runtimeDeps.appLogs, captureExecutingLlmSnapshots: args.runtimeDeps.captureExecutingLlmSnapshots, analystMutations };
}

type PendingAnalystTurn = {
  input: AnalystTurnInput;
  onActivity?: ActivityCallback;
};

const ANALYST_SESSION_ACTOR_DEFINITION = compileActorDefinition({
  initial: 'idle',
  states: {
    idle: { parked: true, on: { submit: 'conversing' } },
    conversing: { on: { done: 'idle', failed: 'idle', cancel: 'idle' } },
  },
});

export class AnalystSessionActor extends BaseActor {
  private readonly llm: ConversationLLMActor;
  private pendingTurn: PendingAnalystTurn | null = null;
  private result: Deferred<AnalystTurnResult> | null = null;
  private turnAbort: AbortController | null = null;
  private cancellationReason: string | null = null;
  private toolInFlight: string | null = null;
  private started = false;
  private lastOutcome: AnalystSessionReadModel['lastOutcome'] = null;
  private pendingRestartConfirmation = false;
  private readonly processScope: ManagedProcessScope;
  private operationTracker: ActivationOperationTracker | null = null;
  private readonly retiredOperationTrackers: ActivationOperationTracker[] = [];

  constructor(private readonly args: { projectRoot: string; sessionId: AnalystConversationSessionId; config: SaivageConfig; runtimeDeps: AnalystRuntimeDeps; promptTemplates: PromptTemplateRegistry; actor?: ActorRole; surface?: ControlActionSurface; restartServerAvailable: boolean; restartPort?: RestartPort }) {
    super(ANALYST_SESSION_ACTOR_DEFINITION, {
      enter: ({ target }) => {
        if (target === 'conversing') this.enterConversing();
      },
    });
    this.processScope = args.runtimeDeps.processRunner.createDirectScope(args.runtimeDeps.analystProcessRootScope, `analyst-session:${args.sessionId}`, 'operator_session');
    this.llm = new ConversationLLMActor({ projectRoot: args.projectRoot, agentId: args.sessionId, provider: args.runtimeDeps.provider, conversations: args.runtimeDeps.conversations, compactor: args.runtimeDeps.compactor, summarizerProvider: args.runtimeDeps.summarizerProvider, runtimeProjectionChanged: args.runtimeDeps.runtimeProjectionChanged });
  }

  override start(): void {
    this.llm.start();
    super.start();
    this.started = true;
  }

  get sessionId(): AnalystConversationSessionId {
    return this.args.sessionId;
  }

  submit(input: AnalystTurnInput, onActivity?: ActivityCallback): Promise<AnalystTurnResult> {
    if (!this.started) return Promise.reject(new Error(`Analyst session '${this.sessionId}' has not started.`));
    if (this.state() !== 'idle' || this.result) return Promise.reject(new Error(`Analyst session '${this.sessionId}' already has an active turn.`));
    this.pendingTurn = { input, onActivity };
    this.result = deferred<AnalystTurnResult>();
    this.operationTracker = new ActivationOperationTracker();
    this.parkedSendEvent('submit');
    this.args.runtimeDeps.runtimeProjectionChanged();
    return this.result.promise;
  }

  cancel(reason: string): boolean {
    const result = this.result;
    if (this.state() !== 'conversing' || !result) return false;
    this.cancellationReason = reason;
    this.operationTracker?.revoke(new Error(reason));
    this.turnAbort?.abort(new Error(reason));
    this.pendingTurn = null;
          this.result = null;
    this.lastOutcome = 'cancelled';
    this.persistAssistantNotice(`Cancelled: ${reason}`);
    result.resolve({ sessionId: this.sessionId, restart: null, cancelled: true });
    this.sendEvent('cancel');
    this.args.runtimeDeps.runtimeProjectionChanged();
    return true;
  }

  readModel(): AnalystSessionReadModel {
    return { sessionId: this.sessionId, phase: this.state() === 'conversing' ? 'conversing' : 'idle', toolInFlight: this.toolInFlight, lastOutcome: this.lastOutcome };
  }

  executingLlmSnapshot(): ExecutingLlmSnapshot | null {
    if (this.state() !== 'conversing' || !this.result) return null;
    return Object.freeze({ sessionId: this.sessionId, agentId: this.llm.agentId, role: 'analyst', cardId: null, activity: this.llm.executingActivity() });
  }

  private enterConversing(): void {
    const turn = this.pendingTurn;
    const result = this.result;
    if (!turn || !result) throw new Error(`Analyst session '${this.sessionId}' entered conversing without a pending turn.`);
    const turnAbort = new AbortController();
    this.turnAbort = turnAbort;
    this.cancellationReason = null;
    this.toolInFlight = null;
    const tracker = this.operationTracker;
    if (!tracker) throw new Error(`Analyst session '${this.sessionId}' entered conversing without an operation tracker.`);
    this.runTask((taskSignal) => tracker.run(AbortSignal.any([turnAbort.signal, taskSignal]), (operationSignal) => this.runAnalystLoop(turn.input, operationSignal)), {
      on_done: (response) => {
        void tracker.trackConsumer(() => {
          this.retireOperationTracker(tracker);
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
          this.args.runtimeDeps.runtimeProjectionChanged();
        });
      },
      on_failed: (error) => {
        void tracker.trackConsumer(() => {
          this.retireOperationTracker(tracker);
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
          this.args.runtimeDeps.runtimeProjectionChanged();
        });
      },
    });
  }

  private async runAnalystLoop(input: AnalystTurnInput, signal: AbortSignal): Promise<AnalystResponse> {
    const sessionId = this.sessionId;
    const toolInvocations: AnalystToolInvocations = [];
    if (this.pendingRestartConfirmation) {
      this.pendingRestartConfirmation = false;
      if (input.userContent === 'RESTART SERVER') return this.scheduleConfirmedRestart(input);
    }
    const store = this.args.runtimeDeps.cardStore;
    const ctx = analystToolContext({ projectRoot: this.args.projectRoot, runtimeDeps: this.args.runtimeDeps, store, processScope: this.processScope, sessionId, actor: this.args.actor ?? 'analyst', surface: this.args.surface ?? 'web-chat', restartServerAvailable: this.args.restartServerAvailable });
    const surface = buildRoleSurface({ role: 'analyst', toolContext: ctx });
    const previousToolCallFingerprints = new Set<string>();
    let noProgressDirectiveSent = false;
    const invocationInput = this.buildInvocationInput(input, surface);
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
        const identity = { sessionId: this.sessionId, sourceInputId: toolCall.inputId, toolCallId: toolCall.toolCallId, toolName: toolCall.toolName };
        result = await invokeToolCall(surface, toolCall.toolName, rawArguments, signal, { ...identity, waits: this.llm.waitCallbacks(identity) });
      } catch (err) {
        if (this.isCancelled()) return this.cancelledLoopResponse();
        throw err;
      }
      this.toolInFlight = null;
      this.throwIfCancelled();

      this.emitActivity({ type: 'tool_result', content: { tool: toolCall.toolName, success: result.success } });
      toolInvocations.push({ tool: toolCall.toolName, params, result });
      broadcastToolInvocation(this.args.runtimeDeps, sessionId, toolCall.toolName, result);
      if (toolCall.toolName === 'restart_server' && result.success) {
        this.llm.settleToolResultWithoutContinuation(toolCall.toolCallId, result);
        this.pendingRestartConfirmation = true;
        return this.response(toolInvocations, { status: 'confirmation_required', confirmationMessage: 'RESTART SERVER' });
      }
      outcome = await this.appendToolResult(toolCall.toolCallId, result, toolInvocations, signal);
    }
  }

  private scheduleConfirmedRestart(input: AnalystTurnInput): AnalystResponse {
    if (!this.args.restartServerAvailable || !this.args.restartPort) throw new Error('Restart confirmation is unavailable without authenticated operator restart capability.');
    appendAnalystRestartBatch(this.args.runtimeDeps.conversations, randomUUID(), input.userContent);
    this.args.restartPort.schedule();
    return this.response(undefined, { status: 'scheduled' });
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

  private buildInvocationInput(turn: AnalystTurnInput, surface: InvocationSurface): PreparedLlmInvocationInput {
    const tools = surfaceToolDefinitions(surface);
    const modelParams = getModelParamsForRole(this.args.config, 'analyst');
    const inputId = randomUUID();
    const systemPrompt = this.args.promptTemplates.render('analyst', 'analyst', {
      toolList: formatPromptToolList(tools),
      vocabularySnippet: formatVocabularySnippet(),
      projectContext: this.buildProjectContext(),
    });
    const preparedCompaction = prepareCompaction(this.args.runtimeDeps.compactionPolicy, systemPrompt, tools, modelParams.maxTokens);
    appendAnalystIngressBatch(this.args.runtimeDeps.conversations, inputId, buildWorkspaceContextNote(turn.workspaceContext), turn.userContent);
    return {
      inputId,
      agentId: this.llm.agentId,
      role: 'analyst',
      sessionId: this.sessionId,
      systemPrompt,
      providerConversation: providerConversationProjection(readConversation(this.args.projectRoot, this.sessionId)),
      tools,
      terminalToolNames: [],
      modelParams: { temperature: modelParams.temperature },
      preparedCompaction,
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

  private errorResponse(err: unknown, toolInvocations: AnalystToolInvocations, input?: PreparedLlmInvocationInput): AnalystResponse {
    if (input) {
      appendLlmTurnMessage(this.args.runtimeDeps.conversations, input, this.errorMessage(err));
    }
    return this.response(toolInvocations);
  }

  private response(toolInvocations?: AnalystToolInvocations, restart: RestartChatAcknowledgement | null = null): AnalystResponse {
    return { sessionId: this.sessionId, restart, toolInvocations: toolInvocations && toolInvocations.length > 0 ? toolInvocations : undefined };
  }

  private persistAssistantNotice(content: string): void {
    const input = this.llm.input;
    if (!input) return;
    appendLlmTurnMessage(this.args.runtimeDeps.conversations, input, content);
  }

  private buildProjectContext(): string {
    try {
      const store = this.args.runtimeDeps.cardStore;
      return JSON.stringify({ projectRoot: this.args.projectRoot, cards: store.list().map((card) => ({ id: card.id, type: card.type, parent: store.getParent(card.id), status: card.lifecycle.status, title: card.title, priority: card.priority, tags: card.tags })) }, null, 2);
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
    return { sessionId: this.sessionId, restart: null, cancelled: true };
  }

  private cancelledLoopOutcome(): LLMActorOutcome {
    return { type: 'result', agentId: this.llm.agentId, result: { kind: 'message', content: `Cancelled: ${this.cancellationReason ?? 'cancelled'}` } };
  }

  async shutdownProcesses(): Promise<void> {
    this.args.runtimeDeps.processRunner.closeScope(this.processScope);
    const report = await this.args.runtimeDeps.processRunner.terminateScopeTree({ rootScope: this.processScope, categories: ['operator_session'], reason: 'session closed', graceMs: 5_000 });
    if (report.failed.length > 0) throw new Error(report.failed.map((failure) => `${failure.groupId}: ${failure.state}: ${failure.diagnostic}`).join('; '));
  }

  disposeSession(reason: unknown): void {
    this.operationTracker?.revoke(reason);
    this.llm.disposeInvocations(reason);
  }

  async joinSession(): Promise<readonly InvocationJoinOutcome[]> {
    const trackers = new Set(this.retiredOperationTrackers);
    if (this.operationTracker) trackers.add(this.operationTracker);
    const outcomes = await Promise.all([...trackers].map((tracker) => tracker.join()));
    outcomes.push(await this.llm.joinInvocationSettlement());
    await this.awaitLifecycleSettlement();
    return outcomes;
  }

  private retireOperationTracker(tracker: ActivationOperationTracker): void {
    tracker.revoke(new Error('Analyst turn settled.'));
    if (!this.retiredOperationTrackers.includes(tracker)) this.retiredOperationTrackers.push(tracker);
    if (this.operationTracker === tracker) this.operationTracker = null;
  }
}

export class AnalystRuntime {
  private session: AnalystSessionActor | null = null;
  private admissionOpen = true;

  constructor(private readonly args: { projectRoot: string; config: SaivageConfig; runtimeDeps: AnalystRuntimeDeps; promptTemplates: PromptTemplateRegistry; restartServerAvailable?: boolean; restartPort?: RestartPort }) {}

  submit(input: AnalystTurnInput, onActivity?: ActivityCallback): Promise<AnalystTurnResult> {
    if (!this.admissionOpen) return Promise.reject(new Error('Analyst admission is closed.'));
    return this.getOrCreateSession(input).submit(input, onActivity);
  }

  cancel(reason: string): boolean {
    return this.session?.cancel(reason) ?? false;
  }

  listSessions(): AnalystSessionReadModel[] {
    return this.session ? [this.session.readModel()] : [];
  }

  executingLlmSnapshot(): ExecutingLlmSnapshot | null {
    return this.session?.executingLlmSnapshot() ?? null;
  }

  getAvailableToolNames(actor: ActorRole = 'analyst', surface: ControlActionSurface = 'web-chat'): string[] {
    const processScope = this.args.runtimeDeps.processRunner.createDirectScope(this.args.runtimeDeps.analystProcessRootScope, 'analyst-tool-catalog', 'operator_session');
    try {
      const catalogStore = this.args.runtimeDeps.cardStore;
      const ctx = analystToolContext({ projectRoot: this.args.projectRoot, runtimeDeps: this.args.runtimeDeps, store: catalogStore, processScope, actor, surface, restartServerAvailable: this.args.restartServerAvailable ?? false });
      return Array.from(buildRoleSurface({ role: 'analyst', toolContext: ctx }).tools.keys());
    } finally {
      this.args.runtimeDeps.processRunner.closeScope(processScope);
    }
  }

  closeAdmission(): void {
    this.admissionOpen = false;
    this.session?.disposeSession(new Error('Application stopping.'));
  }

  async cleanupForApplicationStop(): Promise<void> {
    this.closeAdmission();
    let termination: Promise<import('../runtime/process-runner.js').ProcessStopReport>;
    try { termination = this.args.runtimeDeps.processRunner.terminateOwnedRoot('analyst', this.args.runtimeDeps.analystProcessRootScope, 'application stopping'); }
    catch (error) { termination = Promise.reject(error); }
    const joins = this.session ? [this.session.joinSession()] : [];
    const settlements = await Promise.allSettled([termination, ...joins]);
    const terminationSettlement = settlements[0]!;
    if (terminationSettlement.status === 'rejected') throw terminationSettlement.reason;
    if (settlements.some((settlement) => settlement.status === 'rejected') || terminationSettlement.value.failed.length !== 0) throw new Error('Analyst application cleanup failed.');
  }

  private getOrCreateSession(input?: AnalystTurnInput): AnalystSessionActor {
    if (!this.session) {
      this.session = new AnalystSessionActor({ ...this.args, restartServerAvailable: this.args.restartServerAvailable ?? false, sessionId: GLOBAL_ANALYST_SESSION_ID, actor: input?.actor, surface: input?.surface });
      this.session.start();
    }
    return this.session;
  }
}
import { randomUUID } from 'node:crypto';
