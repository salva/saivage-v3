import { join } from 'node:path';
import type { AgentSession, AgentMessage, ControlActionSurface, ControlActionAuditEntry } from '../schemas/index.js';
import type { ToolResult, ToolContext } from '../tools/analyst-tool-types.js';
import {
  ANALYST_NO_MODEL_REPLY,
  AnalystOfflineError,
  getAnalystSystemPrompt,
  getAnalystToolDefinitions,
  getAvailableAnalystToolNames,
} from './analyst-prompt.js';
import { CardStore } from '../cards/store-api.js';
import type { RuntimeApi } from '../runtime/control-api.js';
import type { EventPayload } from '../events/index.js';
import { buildRuntimeDiagnosticEvent } from '../runtime/runtime-event-publisher.js';
import type { SessionActivity, SessionStamper } from '../runtime/session-stamper.js';
import type { CandidateAvailability } from './candidate-availability.js';
import { MemoryCandidateAvailability } from './candidate-availability.js';
import type { EventLogger } from '../observability/index.js';
import type { McpManager } from '../mcp/manager-api.js';
import type { ActorRole } from './authz.js';
import { sanitizeAnalystText } from '../agents/analyst-sanitization.js';
import { ContextCompactor } from './context-compactor.js';
import { appendMessage, createSession, getSession, getSessionMessages } from './session-persistence.js';
import { generateRoundId } from '../schemas/round-id-server.js';
import { ANALYST_PARTIAL_SUCCESS_TEMPLATE, ANALYST_UNSUPPORTED_ACTION_TEMPLATE } from './analyst-tool-runner.js';
import { serializeToolCallMessage } from '../contracts/persisted-tool-call.js';
import { now } from '../utils/clock.js';
import { AnalystAdapter, ToolDispatcher } from './tool-dispatcher.js';
import { InvocationService } from './invocation-service.js';
import { loadConfig, getModelParamsForRole, getRuntimeConfig } from './config-schema.js';
import type { RuntimeSection, SaivageConfig } from './config-schema.js';
import { ProviderRegistry } from './provider.js';
import { ModelRouter } from './model-router.js';
import { capabilityRequestForLlmOptions } from './provider-capabilities.js';
import { RoleToolPolicy } from './role-tool-policy.js';


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
  runtime: Pick<RuntimeApi, 'startProject' | 'stopProject' | 'pause' | 'resume'>;
  stamper: SessionStamper & { getActivityStatus(sessionId: string): SessionActivity };
  candidateAvailability?: CandidateAvailability;
  eventLogger?: EventLogger;
  emitAnalystToolInvoked(payload: EventPayload<'analyst_tool_invoked'>): void;
  mcpManager?: McpManager;
  contextCompactor?: ContextCompactor;
  invocationService?: InvocationService;
}

function saivageDir(projectRoot: string): string { return join(projectRoot, '.saivage'); }

const ANALYST_CONTEXT_LIMIT_TOKENS = 128_000;

export const GLOBAL_ANALYST_SESSION_ID = 'analyst';
export function getOrCreateAnalystSession(projectRoot: string, sessionId?: string): { session: AgentSession; sessionId: string } {
  const resolvedSessionId = sessionId || GLOBAL_ANALYST_SESSION_ID;
  const dir = saivageDir(projectRoot);
  const existing = getSession(dir, resolvedSessionId);
  if (existing) return { session: existing, sessionId: existing.id };
  const session = createSession(dir, 'analyst', null, null, undefined, resolvedSessionId);
  return { session, sessionId: session.id };
}


function summarizeForBroadcast(tool: string, result: ToolResult): { summary: string; classified_as?: string; related_card_id?: string; related_note_id?: string; related_process_id?: string } {
  const data = result.data && typeof result.data === 'object' ? result.data as Record<string, unknown> : null;
  const preview = result.preview && typeof result.preview === 'object' ? result.preview as unknown as Record<string, unknown> : null;
  const source = data ?? preview ?? {};
  const auditSource = data?.['audit_entry'] && typeof data['audit_entry'] === 'object' ? data['audit_entry'] as ControlActionAuditEntry : null;
  const classified_as = typeof source['classified_as'] === 'string' ? String(source['classified_as']) : undefined;
  const relatedCardFromData = typeof data?.['id'] === 'string' && (tool === 'edit_card' || tool === 'get_card' || tool === 'create_card') ? String(data['id']) : undefined;
  const relatedCardFromPreview = Array.isArray(preview?.['affectedCards']) && preview['affectedCards'].length > 0 && preview['affectedCards'][0] && typeof (preview['affectedCards'][0] as Record<string, unknown>)['id'] === 'string' ? String((preview['affectedCards'][0] as Record<string, unknown>)['id']) : undefined;
  const related_card_id = typeof source['card_id'] === 'string' ? String(source['card_id']) : relatedCardFromData ?? relatedCardFromPreview ?? (typeof source['related_card_id'] === 'string' ? String(source['related_card_id']) : auditSource?.target_kind === 'card' && auditSource.target_id ? auditSource.target_id : undefined);
  const related_note_id = typeof source['note_id'] === 'string' ? String(source['note_id']) : typeof source['related_note_id'] === 'string' ? String(source['related_note_id']) : auditSource?.target_kind === 'note' && auditSource.target_id ? auditSource.target_id : undefined;
  const related_process_id = typeof source['process_id'] === 'string' ? String(source['process_id']) : typeof source['related_process_id'] === 'string' ? String(source['related_process_id']) : auditSource?.target_kind === 'process' && auditSource.target_id ? auditSource.target_id : undefined;

  let summary = result.success ? (tool === 'edit_card' && related_card_id ? `edited card ${related_card_id}` : 'completed') : (result.errorEnvelope?.message ?? result.error ?? 'failed');
  if (auditSource?.outcome_summary) {
    summary = auditSource.outcome_summary;
  } else if (tool === 'read_file' && data) {
    const path = typeof data['path'] === 'string' ? data['path'] : 'file';
    const binary = data['binary'] === true;
    const size = typeof data['size'] === 'number' ? ` (${data['size']} bytes)` : '';
    summary = binary ? `read binary file ${path}${size}` : `read file ${path}${size}`;
  } else if (tool === 'list_directory' && data) {
    const path = typeof data['path'] === 'string' ? data['path'] : 'directory';
    const count = Array.isArray(data['entries']) ? data['entries'].length : 0;
    summary = `listed directory ${path} (${count} entries)`;
  } else if (tool === 'run_shell_command') {
    if (preview) {
      summary = typeof preview['summary'] === 'string' ? preview['summary'] : 'shell preview generated';
    } else if (data) {
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


export class AnalystHandler {
  private projectRoot: string;
  private onActivity?: ActivityCallback;
  private invocationService: InvocationService;
  private sessionQueues: Map<string, Promise<AnalystResponse>> = new Map();
  private readonly runtimeDeps: AnalystRuntimeDeps;
  private actor: ActorRole;
  private surface: ControlActionSurface;
  private requestServerRestart?: () => Promise<void>;
  private readonly contextCompactor: ContextCompactor;
  private readonly toolDispatcher: ToolDispatcher;
  private readonly config: SaivageConfig;
  private readonly runtimeConfig: RuntimeSection;

  constructor(projectRoot: string, runtimeDeps: AnalystRuntimeDeps, onActivity?: ActivityCallback, actor: ActorRole = 'analyst', surface: ControlActionSurface = 'web-chat', requestServerRestart?: () => Promise<void>) {
    this.projectRoot = projectRoot;
    this.onActivity = onActivity;
    this.runtimeDeps = runtimeDeps;
    this.config = loadConfig(projectRoot).config;
    this.runtimeConfig = getRuntimeConfig(this.config);
    this.actor = actor;
    this.surface = surface;
    this.requestServerRestart = requestServerRestart;
    this.contextCompactor = runtimeDeps.contextCompactor ?? new ContextCompactor({
      saivageDir: saivageDir(projectRoot),
      sessionStamper: runtimeDeps.stamper,
    });
    const availability = this.runtimeDeps.candidateAvailability ?? new MemoryCandidateAvailability();
    const registry = new ProviderRegistry(this.config);
    const router = new ModelRouter(this.config, registry, projectRoot, availability);
    this.invocationService = runtimeDeps.invocationService ?? new InvocationService({
      projectRoot,
      saivageDir: saivageDir(projectRoot),
      registry,
      router,
      eventLogger: runtimeDeps.eventLogger,
      candidateAvailability: availability,
      recoveryDelayMs: this.runtimeConfig.recoveryDelayMs,
      maxRecoveryRetries: this.runtimeConfig.maxRecoveryRetries,
    });
    this.toolDispatcher = new ToolDispatcher([new AnalystAdapter()]);
  }

  getAvailableToolNames(): string[] {
    return getAvailableAnalystToolNames(this.surface);
  }

  async handleMessage(sessionId: string, userContent: string, workspaceContext?: WorkspaceContext): Promise<AnalystResponse> {
    const previous = this.sessionQueues.get(sessionId) ?? Promise.resolve(null as never);
    const next = previous.catch(() => null as never).then(() => this.handleMessageSerial(sessionId, userContent, workspaceContext));
    this.sessionQueues.set(sessionId, next);
    try { return await next; } finally { if (this.sessionQueues.get(sessionId) === next) this.sessionQueues.delete(sessionId); }
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

  private parseToolArgs(raw: string, phase: string): Record<string, unknown> {
    try {
      const candidate = JSON.parse(raw) as unknown;
      return candidate && typeof candidate === 'object' && !Array.isArray(candidate) ? candidate as Record<string, unknown> : {};
    } catch (err) {
      this.logBoundaryDiagnostic(phase, err);
      return {};
    }
  }

  private async handleMessageSerial(sessionId: string, userContent: string, workspaceContext?: WorkspaceContext): Promise<AnalystResponse> {
    let session = getSession(saivageDir(this.projectRoot), sessionId);
    if (!session) { const created = getOrCreateAnalystSession(this.projectRoot, sessionId); session = created.session; sessionId = created.sessionId; }
    const priorMessages = getSessionMessages(saivageDir(this.projectRoot), sessionId);
    const duplicateResponse = this.findRecentDuplicateResponse(priorMessages, userContent);
    if (duplicateResponse) return duplicateResponse;
    appendMessage(saivageDir(this.projectRoot), sessionId, { role: 'user', kind: 'text', content: userContent }, this.runtimeDeps.stamper.stampUserMessage(sessionId), this.runtimeDeps.stamper);

    return await this.runAnalystLoop(sessionId, userContent, workspaceContext);
  }

  private responseTextForResult(result: ToolResult): string | null {
    if (result.success && result.data && typeof result.data === 'object' && (result.data as Record<string, unknown>)['partial'] === true) {
      const data = result.data as Record<string, unknown>;
      const failures = Array.isArray(data['failures']) ? data['failures'] as Array<Record<string, unknown>> : [];
      return ANALYST_PARTIAL_SUCCESS_TEMPLATE(Number(data['succeeded'] ?? 0), Number(data['total'] ?? 0), failures.map((failure) => String(failure['id'] ?? 'unknown')), failures.map((failure) => String(failure['reason'] ?? 'unknown reason')));
    }
    if (!result.success && result.data && typeof result.data === 'object' && (result.data as Record<string, unknown>)['reason'] === 'not_yet_available') {
      const data = result.data as Record<string, unknown>;
      return `Not yet available: this capability is owned by ${String(data['stage_owner'] ?? 'a later stage')}.`;
    }
    return null;
  }

  private async runAnalystLoop(sessionId: string, _userContent: string, workspaceContext?: WorkspaceContext): Promise<AnalystResponse> {
    this.runtimeDeps.stamper.openAssistantRound(sessionId);
    const toolInvocations: NonNullable<AnalystResponse['toolInvocations']> = [];
    const projectContext = this.buildProjectContext();
    const ctx: ToolContext = { projectRoot: this.projectRoot, store: this.runtimeDeps.cardStore, sessionId, runtime: this.runtimeDeps.runtime, mcpManager: this.runtimeDeps.mcpManager, requestServerRestart: this.requestServerRestart, actor: this.actor, surface: this.surface };
    const previousToolCallFingerprints = new Set<string>();

    for (;;) {
      // Auto-compact when the conversation approaches the model context
      // window. Falls back to truncation (last 20% of messages) when no
      // summarizer is wired in. After compaction we still apply
      // shared boundary pruning so any orphan tool_call ↔ tool_result
      // pair produced by truncation can't reach the LLM and trigger an
      // HTTP 400 "No tool call found for function call output" error.
      // No max-compaction cap: the operator cannot start a fresh
      // analyst session from the chat, so compaction must always
      // succeed in shrinking the working set.
      try {
        await this.contextCompactor.compactSession(sessionId, {
          contextLimit: ANALYST_CONTEXT_LIMIT_TOKENS,
          threshold: 0.8,
          maxCompactions: Number.MAX_SAFE_INTEGER,
        });
      } catch (err) { this.logBoundaryDiagnostic('analyst_history_compaction_failed', err); }

      const history = getSessionMessages(saivageDir(this.projectRoot), sessionId);
      const bounded = this.contextCompactor.pruneToolBoundary(history);
      const modelInput: AgentMessage[] = [
        { id: `workspace-context-${sessionId}`, session_id: sessionId, role: 'system', kind: 'text', content: buildWorkspaceContextNote(workspaceContext), round_id: generateRoundId('pre'), message_index: 0, block_index: 0, timestamp: now() },
        ...bounded,
      ];

      let llmResult;
      try {
        const modelParams = getModelParamsForRole(this.config, 'analyst');
        const tools = getAnalystToolDefinitions();
        llmResult = await this.invocationService.invokeWithRecovery({
          role: 'analyst',
          sessionId,
          systemPrompt: `${getAnalystSystemPrompt()}\n\n${projectContext}`,
          contextMessages: modelInput,
          tools,
          terminalToolNames: [],
          modelParams: { temperature: modelParams.temperature, maxTokens: modelParams.maxTokens },
          capabilityRequest: capabilityRequestForLlmOptions({ tools, stream: false }),
        });
      } catch (err) {
        const noHealthyMessage = `No healthy candidates available for role 'analyst'.`;
        const errMsg = err instanceof AnalystOfflineError
          ? err.message
          : err instanceof Error && err.message === noHealthyMessage
            ? ANALYST_NO_MODEL_REPLY
          : `Analyst LLM unavailable: ${err instanceof Error ? err.message : String(err)}`;
        const persisted = appendMessage(saivageDir(this.projectRoot), sessionId, { role: 'assistant', kind: 'text', content: errMsg }, this.runtimeDeps.stamper.stampInRound(sessionId), this.runtimeDeps.stamper);
        return { sessionId, message: { id: persisted.id, role: 'assistant', kind: 'text', content: errMsg, timestamp: persisted.timestamp }, toolInvocations: toolInvocations.length > 0 ? toolInvocations : undefined };
      }

      if (llmResult.kind === 'message') {
        const finalText = (llmResult.content ?? '').trim() || 'Done.';
        const persisted = appendMessage(saivageDir(this.projectRoot), sessionId, { role: 'assistant', kind: 'text', content: finalText }, this.runtimeDeps.stamper.stampInRound(sessionId), this.runtimeDeps.stamper);
        return { sessionId, message: { id: persisted.id, role: 'assistant', kind: 'text', content: finalText, timestamp: persisted.timestamp }, toolInvocations: toolInvocations.length > 0 ? toolInvocations : undefined };
      }

      const toolCalls = llmResult.tool_calls;
      const unavailableTool = toolCalls.find((tc) => !RoleToolPolicy.assertAnalystSurfaceTool(tc.function.name, this.surface).allowed);
      if (unavailableTool) {
        const content = ANALYST_UNSUPPORTED_ACTION_TEMPLATE('Analyst', getAvailableAnalystToolNames(this.surface));
        const persisted = appendMessage(saivageDir(this.projectRoot), sessionId, { role: 'assistant', kind: 'text', content }, this.runtimeDeps.stamper.stampInRound(sessionId), this.runtimeDeps.stamper);
        return { sessionId, message: { id: persisted.id, role: 'assistant', kind: 'text', content, timestamp: persisted.timestamp }, toolInvocations: toolInvocations.length > 0 ? toolInvocations : undefined };
      }
      const fingerprint = toolCalls.map((tc) => `${tc.function.name}:${tc.function.arguments}`).sort().join('||');
      if (previousToolCallFingerprints.has(fingerprint)) {
        const noProgressText = 'I repeated the same tool calls without making progress. Please refine the request or inspect the latest tool results.';
        const persisted = appendMessage(saivageDir(this.projectRoot), sessionId, { role: 'assistant', kind: 'text', content: noProgressText }, this.runtimeDeps.stamper.stampInRound(sessionId), this.runtimeDeps.stamper);
        return { sessionId, message: { id: persisted.id, role: 'assistant', kind: 'text', content: noProgressText, timestamp: persisted.timestamp }, toolInvocations: toolInvocations.length > 0 ? toolInvocations : undefined };
      }
      previousToolCallFingerprints.add(fingerprint);
      for (const tc of toolCalls) {
        let parsedArgs: Record<string, unknown>;
        parsedArgs = this.parseToolArgs(tc.function.arguments, 'analyst_tool_call_arguments_parse_failed');
        const row = serializeToolCallMessage({ id: tc.id, name: tc.function.name, args: parsedArgs });
        appendMessage(saivageDir(this.projectRoot), sessionId, { role: 'assistant', kind: 'tool_call', content: JSON.stringify(row), tool: tc.function.name, tool_call_id: tc.id }, this.runtimeDeps.stamper.stampInRound(sessionId), this.runtimeDeps.stamper);
      }

      for (const tc of toolCalls) {
        let params: Record<string, unknown> = {};
        params = this.parseToolArgs(tc.function.arguments, 'analyst_tool_execution_arguments_parse_failed');


        this.emitActivity({ type: 'tool_call', content: { tool: tc.function.name, params } });

        const dispatched = await this.toolDispatcher.dispatch({ id: tc.id, name: tc.function.name, arguments: tc.function.arguments }, {
          role: 'analyst',
          sessionId,
          analystSurface: this.surface,
          toolContext: ctx,
          knownRuntimeTool: (name) => getAvailableAnalystToolNames(this.surface).includes(name),
        });
        const result = dispatched.adapterResult?.data as ToolResult | undefined ?? {
          success: false,
          error: dispatched.content,
          errorEnvelope: { kind: 'internal', message: dispatched.content },
        };


        this.emitActivity({ type: 'tool_result', content: { tool: tc.function.name, success: result.success, hasPreview: !!result.preview, errorKind: result.errorEnvelope?.kind } });

        toolInvocations.push({ tool: tc.function.name, params, result });

        appendMessage(saivageDir(this.projectRoot), sessionId, { role: 'tool', kind: dispatched.kind, content: dispatched.content, tool: dispatched.tool, tool_call_id: dispatched.tool_call_id }, this.runtimeDeps.stamper.stampInRound(sessionId), this.runtimeDeps.stamper);
        broadcastToolInvocation(this.runtimeDeps, sessionId, tc.function.name, result);
        const contractText = result.errorEnvelope?.kind === 'not_found' ? result.errorEnvelope.message : this.responseTextForResult(result);
        if (contractText) {
          const persisted = appendMessage(saivageDir(this.projectRoot), sessionId, { role: 'assistant', kind: 'text', content: contractText }, this.runtimeDeps.stamper.stampInRound(sessionId), this.runtimeDeps.stamper);
          return { sessionId, message: { id: persisted.id, role: 'assistant', kind: 'text', content: contractText, timestamp: persisted.timestamp }, toolInvocations };
        }
      }
    }
  }


  private findRecentDuplicateResponse(messages: AgentMessage[], userContent: string): AnalystResponse | null {
    const lastUserIndex = [...messages].reverse().findIndex((msg) => msg.role === 'user');
    if (lastUserIndex < 0) return null;
    const userIndex = messages.length - 1 - lastUserIndex;
    const lastUser = messages[userIndex];
    if (lastUser.content !== userContent) return null;
    const interveningUser = messages.slice(userIndex + 1).some((msg) => msg.role === 'user');
    if (interveningUser) return null;
    const lastAssistant = messages.slice(userIndex + 1).find((msg) => msg.role === 'assistant' && msg.kind === 'text');
    if (!lastAssistant) return null;
    const ageMs = Date.now() - Date.parse(lastUser.timestamp);
    if (!Number.isFinite(ageMs) || ageMs > 5000) return null;
    return { sessionId: lastAssistant.session_id, message: { id: lastAssistant.id, role: 'assistant', kind: 'text', content: lastAssistant.content, timestamp: lastAssistant.timestamp } };
  }

  private buildProjectContext(): string {
    try {
      const store = this.runtimeDeps.cardStore;
      return JSON.stringify({ projectRoot: this.projectRoot, cards: store.list().map((card) => ({ id: card.id, type: card.type, parent: card.parent, status: card.status, title: card.title, description: card.description, acceptance: card.acceptance, priority: card.priority, tags: card.tags })) }, null, 2);
    } catch (err) {
      this.logBoundaryDiagnostic('analyst_project_context_build_failed', err);
      return `Project root: ${this.projectRoot}`;
    }
  }
}

export function getAnalystHandler(projectRoot: string, opts: { runtimeDeps: AnalystRuntimeDeps; onActivity?: ActivityCallback; actor?: ActorRole; surface?: ControlActionSurface; requestServerRestart?: () => Promise<void> }): AnalystHandler {
  const actor = opts.actor ?? 'analyst';
  const surface = opts.surface ?? 'web-chat';
  return new AnalystHandler(projectRoot, opts.runtimeDeps, opts.onActivity, actor, surface, opts.requestServerRestart);
}
