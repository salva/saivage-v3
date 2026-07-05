import type { AgentMessage, ControlActionSurface, ControlActionAuditEntry } from '../schemas/index.js';
import type { ToolContext } from '../tools/analyst-tool-types.js';
import {
  ANALYST_NO_MODEL_REPLY,
  AnalystOfflineError,
  getAnalystSystemPrompt,
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
import { ANALYST_PARTIAL_SUCCESS_TEMPLATE, ANALYST_UNSUPPORTED_ACTION_TEMPLATE } from './analyst-tool-runner.js';
import { getModelParamsForRole } from './config-schema.js';
import type { SaivageConfig } from './config-schema.js';
import { capabilityRequestForLlmOptions } from './provider-capabilities.js';
import { buildAgentProtocolViolation, parseProtocolToolArgs } from './agent-protocol-violation.js';
import { appendConversationMessage, buildContextTextMessage, conversationMessagesForModel, readConversationMessages } from '../runtime/actors/conversation-store.js';
import { ConversationLLMActor, type LLMActorOutcome, type LLMProviderPort } from '../runtime/actors/llm-actor.js';
import type { LlmInvocationInput } from '../runtime/actors/llm-invocation.js';
import { resolveAnalystSessionId } from './session-ids.js';
import { ANALYST_CONTROL_TOOLS } from '../tools/analyst-tool-registry.js';
import { buildInvocationSurface, defineTool, invokeToolCall, surfaceToolDefinitions, type InvocationSurface, type ToolProvider, type ToolResult } from '../tools/invocation.js';
import { createProcessProvider } from '../tools/process-provider.js';
import { createWebProvider } from '../tools/web-tools.js';
import { createPatchProvider, createWorkspaceProvider } from '../tools/workspace-provider.js';
import { createSkillProvider } from '../tools/skill-provider.js';
import { createMcpProvider } from '../tools/mcp-provider.js';
import { createCardInspectionProvider } from '../tools/card-inspection-provider.js';
import { createCardHistoryProvider } from '../tools/card-history-provider.js';
import type { ProcessRunner } from '../runtime/process-runner.js';
import { BaseActor, type ActorDefinition } from '../runtime/micro-actor/index.js';


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
  message: {
    id: string;
    role: 'assistant';
    kind: 'text';
    content: string;
    timestamp: string;
  };
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


class AnalystLoopRunner {
  private projectRoot: string;
  private onActivity?: ActivityCallback;
  private readonly runtimeDeps: AnalystRuntimeDeps;
  private actor: ActorRole;
  private surface: ControlActionSurface;
  private requestServerRestart?: () => Promise<void>;
  private readonly config: SaivageConfig;

  constructor(projectRoot: string, config: SaivageConfig, runtimeDeps: AnalystRuntimeDeps, onActivity?: ActivityCallback, actor: ActorRole = 'analyst', surface: ControlActionSurface = 'web-chat', requestServerRestart?: () => Promise<void>) {
    this.projectRoot = projectRoot;
    this.onActivity = onActivity;
    this.runtimeDeps = runtimeDeps;
    this.config = config;
    this.actor = actor;
    this.surface = surface;
    this.requestServerRestart = requestServerRestart;
  }

  getAvailableToolNames(): string[] {
    const ctx: ToolContext = { projectRoot: this.projectRoot, processRunner: this.runtimeDeps.processRunner, store: this.runtimeDeps.cardStore, runtime: this.runtimeDeps.runtime, mcpManager: this.runtimeDeps.mcpManager, requestServerRestart: this.requestServerRestart, actor: this.actor, surface: this.surface, eventBus: this.runtimeDeps.eventBus };
    return Array.from(this.analystInvocationSurface(ctx).tools.keys());
  }

  private emitActivity(activity: { type: 'tool_call' | 'tool_result' | 'thinking'; content: Record<string, unknown> }): void {
    if (!this.onActivity) return;
    try { this.onActivity(activity); } catch (err) { this.logBoundaryDiagnostic('analyst_activity_callback_failed', err); }
  }

  private logBoundaryDiagnostic(phase: string, err: unknown): void {
    try {
      this.runtimeDeps.eventLogger?.appendEvent(buildRuntimeDiagnosticEvent({
        phase,
        error: err,
      }));
    } catch {
      /* best-effort diagnostics; never fail the analyst response path */
    }
  }

  private responseTextForResult(result: ToolResult): string | null {
    if (result.success && result.data && typeof result.data === 'object' && (result.data as Record<string, unknown>)['partial'] === true) {
      const data = result.data as Record<string, unknown>;
      const failures = Array.isArray(data['failures']) ? data['failures'] as Array<Record<string, unknown>> : [];
      return ANALYST_PARTIAL_SUCCESS_TEMPLATE(Number(data['succeeded'] ?? 0), Number(data['total'] ?? 0), failures.map((failure) => String(failure['id'] ?? 'unknown')), failures.map((failure) => String(failure['reason'] ?? 'unknown reason')));
    }
    return null;
  }

  async runAnalystLoop(sessionId: string, actor: ConversationLLMActor, userContent: string, workspaceContext: WorkspaceContext | undefined, signal: AbortSignal): Promise<AnalystResponse> {
    sessionId = resolveAnalystSessionId(sessionId);
    const toolInvocations: NonNullable<AnalystResponse['toolInvocations']> = [];
    const ctx: ToolContext = { projectRoot: this.projectRoot, processRunner: this.runtimeDeps.processRunner, store: this.runtimeDeps.cardStore, sessionId, runtime: this.runtimeDeps.runtime, mcpManager: this.runtimeDeps.mcpManager, requestServerRestart: this.requestServerRestart, actor: this.actor, surface: this.surface, eventBus: this.runtimeDeps.eventBus };
    const surface = this.analystInvocationSurface(ctx);
    const previousToolCallFingerprints = new Set<string>();
    const workspaceContextMessage = buildContextTextMessage(sessionId, 'system', buildWorkspaceContextNote(workspaceContext));
    const userMessage = buildContextTextMessage(sessionId, 'user', userContent);
    let outcome: LLMActorOutcome;

    try {
      outcome = await actor.turn(this.buildInvocationInput(sessionId, actor, [workspaceContextMessage, userMessage], surface));
    } catch (err) {
      return this.errorResponse(sessionId, err, toolInvocations);
    }

    for (;;) {
      if (signal.aborted) throw new Error('Analyst turn cancelled.');
      if (outcome.type === 'error') return this.errorResponse(sessionId, outcome.error, toolInvocations);

      if (outcome.type === 'result') {
        const finalText = (outcome.result.content ?? '').trim() || 'Done.';
        const timestamp = new Date().toISOString();
        return { sessionId, message: { id: `${sessionId}:assistant:${timestamp}:${Math.random().toString(36).slice(2)}`, role: 'assistant', kind: 'text', content: finalText, timestamp }, toolInvocations: toolInvocations.length > 0 ? toolInvocations : undefined };
      }

      const toolCall = outcome;
      if (!surface.tools.has(toolCall.toolName)) {
        const content = ANALYST_UNSUPPORTED_ACTION_TEMPLATE('Analyst', Array.from(surface.tools.keys()));
        const persisted = this.appendAssistantTextMessage(sessionId, content);
        return { sessionId, message: { id: persisted.id, role: 'assistant', kind: 'text', content, timestamp: persisted.timestamp }, toolInvocations: toolInvocations.length > 0 ? toolInvocations : undefined };
      }
      const rawArguments = typeof actor.waitingToolCall?.toolCallArguments === 'string' ? actor.waitingToolCall.toolCallArguments : JSON.stringify(toolCall.args);
      const fingerprint = `${toolCall.toolName}:${rawArguments}`;
      if (previousToolCallFingerprints.has(fingerprint)) {
        const noProgressText = 'I repeated the same tool calls without making progress. Please refine the request or inspect the latest tool results.';
        const persisted = this.appendAssistantTextMessage(sessionId, noProgressText);
        return { sessionId, message: { id: persisted.id, role: 'assistant', kind: 'text', content: noProgressText, timestamp: persisted.timestamp }, toolInvocations: toolInvocations.length > 0 ? toolInvocations : undefined };
      }
      previousToolCallFingerprints.add(fingerprint);

      const parsed = parseProtocolToolArgs(rawArguments);
      if (parsed.kind === 'violation') {
        const violation = buildAgentProtocolViolation({ session_id: sessionId, role: 'analyst', tool_call_id: toolCall.toolCallId, tool_name: toolCall.toolName, violation: parsed.violation, raw: rawArguments });
        this.logBoundaryDiagnostic('analyst_tool_arguments_protocol_violation', new Error(`${parsed.violation}: ${parsed.detail}`));
        const content = JSON.stringify(violation);
        const result: ToolResult = { success: false, error: content };
        this.emitActivity({ type: 'tool_result', content: { tool: toolCall.toolName, success: false, errorKind: 'agent_protocol_violation' } });
        toolInvocations.push({ tool: toolCall.toolName, params: {}, result });
        outcome = await actor.appendToolResult(toolCall.toolCallId, result);
        if (outcome.type === 'error') {
          const persisted = this.appendAssistantTextMessage(sessionId, content);
          return { sessionId, message: { id: persisted.id, role: 'assistant', kind: 'text', content, timestamp: persisted.timestamp }, toolInvocations };
        }
        continue;
      }

      const params = parsed.args;
      this.emitActivity({ type: 'tool_call', content: { tool: toolCall.toolName, params } });
      if (signal.aborted) throw new Error('Analyst turn cancelled.');
      const result = await invokeToolCall(surface, toolCall.toolName, rawArguments);
      if (signal.aborted) throw new Error('Analyst turn cancelled.');

      this.emitActivity({ type: 'tool_result', content: { tool: toolCall.toolName, success: result.success } });
      toolInvocations.push({ tool: toolCall.toolName, params, result });
      broadcastToolInvocation(this.runtimeDeps, sessionId, toolCall.toolName, result);
      const contractText = this.responseTextForResult(result);
      try {
        outcome = await actor.appendToolResult(toolCall.toolCallId, result);
      } catch (err) {
        return this.errorResponse(sessionId, err, toolInvocations);
      }
      if (contractText) {
        const persisted = this.appendAssistantTextMessage(sessionId, contractText);
        return { sessionId, message: { id: persisted.id, role: 'assistant', kind: 'text', content: contractText, timestamp: persisted.timestamp }, toolInvocations };
      }
    }
  }

  private buildInvocationInput(sessionId: string, actor: ConversationLLMActor, newMessages: AgentMessage[], surface: InvocationSurface): LlmInvocationInput {
    const tools = surfaceToolDefinitions(surface);
    const modelParams = getModelParamsForRole(this.config, 'analyst');
    const contextMessages = actor.input
      ? [...actor.input.contextMessages, ...newMessages]
      : [...conversationMessagesForModel(readConversationMessages(this.projectRoot, sessionId)), ...newMessages] as AgentMessage[];
    return {
      inputId: `${actor.agentId}:turn:${Date.now()}`,
      agentId: actor.agentId,
      role: 'analyst',
      sessionId,
      systemPrompt: `${getAnalystSystemPrompt(tools)}\n\n${this.buildProjectContext()}`,
      contextMessages,
      turnMessages: newMessages,
      tools,
      terminalToolNames: [],
      modelParams: { temperature: modelParams.temperature, maxTokens: modelParams.maxTokens },
      capabilityRequest: capabilityRequestForLlmOptions({ tools, stream: false }),
      episodeContext: { surface: this.surface },
    };
  }

  private analystInvocationSurface(ctx: ToolContext): InvocationSurface {
    return buildInvocationSurface('analyst', [
      this.analystControlProvider(ctx),
      createCardInspectionProvider({ projectRoot: this.projectRoot, store: this.runtimeDeps.cardStore, agentRole: 'analyst' }),
      createCardHistoryProvider({ projectRoot: this.projectRoot, store: this.runtimeDeps.cardStore, sessionId: ctx.sessionId, agentRole: 'analyst' }),
      createWorkspaceProvider({ projectRoot: this.projectRoot, agentRole: 'analyst', store: this.runtimeDeps.cardStore }),
      createPatchProvider({ projectRoot: this.projectRoot, agentRole: 'analyst' }),
      createProcessProvider({ projectRoot: this.projectRoot, processRunner: this.runtimeDeps.processRunner, ownerId: ctx.sessionId ?? 'analyst', agentRole: 'analyst', ownerKind: 'operator', launchReason: 'analyst workspace run_command' }),
      createWebProvider({ projectRoot: this.projectRoot, agentRole: 'analyst', store: this.runtimeDeps.cardStore }),
      createSkillProvider({ projectRoot: this.projectRoot, agentRole: 'analyst' }),
      createMcpProvider({ mcpManagerProvider: () => this.runtimeDeps.mcpManager, agentRole: 'analyst' }),
    ]);
  }

  private analystControlProvider(ctx: ToolContext): ToolProvider {
    return {
      providerName: 'analyst',
      tools: ANALYST_CONTROL_TOOLS
        .map((tool) => defineTool({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.input,
          executor: async (args): Promise<ToolResult> => {
            if (!tool.executor) throw new Error(`Analyst tool '${tool.name}' has no executor.`);
            return tool.executor(ctx, args as Record<string, unknown>);
          },
        })),
    };
  }

  private appendAssistantTextMessage(sessionId: string, content: string): AgentMessage {
    const timestamp = new Date().toISOString();
    const message: AgentMessage = {
      id: `${sessionId}:assistant:${timestamp}:${Math.random().toString(36).slice(2)}`,
      session_id: sessionId,
      role: 'assistant',
      kind: 'text',
      content,
      round_id: `r-assistant-${Buffer.from(`${sessionId}:${timestamp}`).toString('hex').slice(0, 32).padEnd(32, '0')}`,
      message_index: 1,
      block_index: 0,
      timestamp,
    };
    appendConversationMessage(this.projectRoot, message);
    return message;
  }

  private errorResponse(sessionId: string, err: unknown, toolInvocations: NonNullable<AnalystResponse['toolInvocations']>): AnalystResponse {
    const noHealthyMessage = `No healthy candidates available for role 'analyst'.`;
    const error = typeof err === 'string' ? err : err instanceof Error ? err.message : String(err);
    const errMsg = err instanceof AnalystOfflineError
      ? err.message
      : error === noHealthyMessage
        ? ANALYST_NO_MODEL_REPLY
        : `Analyst LLM unavailable: ${error}`;
    const persisted = this.appendAssistantTextMessage(sessionId, errMsg);
    return { sessionId, message: { id: persisted.id, role: 'assistant', kind: 'text', content: errMsg, timestamp: persisted.timestamp }, toolInvocations: toolInvocations.length > 0 ? toolInvocations : undefined };
  }

  private buildProjectContext(): string {
    try {
      const store = this.runtimeDeps.cardStore;
      return JSON.stringify({ projectRoot: this.projectRoot, cards: store.list().map((card) => ({ id: card.id, type: card.type, parent: card.parent, status: card.status, title: card.title, priority: card.priority, tags: card.tags })) }, null, 2);
    } catch (err) {
      this.logBoundaryDiagnostic('analyst_project_context_build_failed', err);
      return `Project root: ${this.projectRoot}`;
    }
  }
}

type PendingAnalystTurn = {
  input: AnalystTurnInput;
  onActivity?: ActivityCallback;
  resolve: (result: AnalystTurnResult) => void;
  reject: (error: Error) => void;
};

export class AnalystSessionActor extends BaseActor {
  static _actor: ActorDefinition = {
    initial: 'idle',
    states: {
      idle: { parked: true, on: { submit: 'conversing' } },
      conversing: { on: { done: 'idle', failed: 'idle', cancel: 'idle' } },
    },
  };

  private readonly loop: AnalystLoopRunner;
  private readonly llm: ConversationLLMActor;
  private pendingTurn: PendingAnalystTurn | null = null;
  private started = false;
  private lastOutcome: AnalystSessionReadModel['lastOutcome'] = null;

  constructor(private readonly args: { projectRoot: string; sessionId: string; config: SaivageConfig; runtimeDeps: AnalystRuntimeDeps; actor?: ActorRole; surface?: ControlActionSurface; requestServerRestart?: () => Promise<void> }) {
    super();
    this.loop = new AnalystLoopRunner(args.projectRoot, args.config, args.runtimeDeps, (activity) => {
      this.pendingTurn?.onActivity?.(activity);
    }, args.actor ?? 'analyst', args.surface ?? 'web-chat', args.requestServerRestart);
    this.llm = new ConversationLLMActor({ projectRoot: args.projectRoot, agentId: args.sessionId, provider: args.runtimeDeps.provider });
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
    if (this.state() !== 'idle' || this.pendingTurn) return Promise.reject(new Error(`Analyst session '${this.sessionId}' already has an active turn.`));
    return new Promise<AnalystTurnResult>((resolve, reject) => {
      this.pendingTurn = { input, onActivity, resolve, reject };
      this.parkedSendEvent('submit');
    });
  }

  cancel(reason: string): boolean {
    const turn = this.pendingTurn;
    if (this.state() !== 'conversing' || !turn) return false;
    const timestamp = new Date().toISOString();
    this.pendingTurn = null;
    this.lastOutcome = 'cancelled';
    if (this.llm.state() === 'waiting_tool') this.llm.abandonParkedTurn();
    turn.resolve({ sessionId: this.sessionId, cancelled: true, message: { id: `${this.sessionId}:cancelled:${timestamp}`, role: 'assistant', kind: 'text', content: `Cancelled: ${reason}`, timestamp } });
    this.sendEvent('cancel');
    return true;
  }

  readModel(): AnalystSessionReadModel {
    return { sessionId: this.sessionId, phase: this.state() === 'conversing' ? 'conversing' : 'idle', toolInFlight: null, lastOutcome: this.lastOutcome };
  }

  _on_enter__conversing(): void {
    const turn = this.pendingTurn;
    if (!turn) throw new Error(`Analyst session '${this.sessionId}' entered conversing without a pending turn.`);
    this.runTask((signal) => this.loop.runAnalystLoop(this.sessionId, this.llm, turn.input.userContent, turn.input.workspaceContext, signal), {
      on_done: (result) => {
        if (this.pendingTurn !== turn) return;
        this.pendingTurn = null;
        this.lastOutcome = 'completed';
        turn.resolve(result);
        this.sendEvent('done');
      },
      on_failed: (error) => {
        if (this.pendingTurn !== turn) return;
        this.pendingTurn = null;
        this.lastOutcome = 'failed';
        turn.reject(error);
        this.sendEvent('failed');
      },
    });
  }
}

export class AnalystRuntime {
  private readonly sessions = new Map<string, AnalystSessionActor>();

  constructor(private readonly args: { projectRoot: string; config: SaivageConfig; runtimeDeps: AnalystRuntimeDeps; requestServerRestart?: () => Promise<void> }) {}

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
    return new AnalystLoopRunner(this.args.projectRoot, this.args.config, this.args.runtimeDeps, undefined, actor, surface, this.args.requestServerRestart).getAvailableToolNames();
  }

  async shutdown(): Promise<void> {
    await Promise.all([...this.sessions.keys()].map((sessionId) => this.shutdownSessionProcesses(sessionId)));
  }

  async shutdownSessionProcesses(sessionId: string): Promise<void> {
    await this.args.runtimeDeps.processRunner.stopByOwner(resolveAnalystSessionId(sessionId), 'analyst session closed', { graceMs: 5000 });
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
