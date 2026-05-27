import { join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { writeFileAtomic } from '../persistence/index.js';
import { agentSessionSchema, agentMessageSchema } from '../schemas/index.js';
import type { AgentSession, AgentMessage, MessageRole, MessageKind, ControlActionSurface, ControlActionAuditEntry } from '../schemas/index.js';
import type { ToolResult, ToolContext } from './analyst-tools.js';
import { ANALYST_OFFLINE_REPLY, AnalystOfflineError, LlmIntentResolver, TOOL_REGISTRY } from './analyst-llm-resolver.js';
import { CardStore } from '../cards/index.js';
import type { ActiveRuntime } from '../runtime/index.js';
import type { ActorRole } from './authz.js';
import { sanitizeAnalystText } from '../agents/analyst-sanitization.js';
import { compactSession } from './compaction.js';
import { ANALYST_DESTRUCTIVE_AMENDMENT_TEMPLATE, ANALYST_DESTRUCTIVE_PREVIEW_TEMPLATE, ANALYST_DESTRUCTIVE_STALE_AFFIRMATION_TEMPLATE, ANALYST_PARTIAL_SUCCESS_TEMPLATE, ANALYST_UNKNOWN_CAPABILITY_TEMPLATE, CONFIRMATION_TTL_MS, PendingDestructiveStore, isDestructiveAnalystTool } from './analyst-tool-runner.js';
import { recordControlAction, stableStringify } from '../persistence/index.js';


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


function now(): string { return new Date().toISOString(); }
function saivageDir(projectRoot: string): string { return join(projectRoot, '.saivage'); }
function sessionsDir(projectRoot: string): string { return join(saivageDir(projectRoot), 'agents', 'sessions'); }
function messagesDir(projectRoot: string): string { return join(saivageDir(projectRoot), 'agents', 'messages'); }
function sessionFilePath(projectRoot: string, sessionId: string): string { return join(sessionsDir(projectRoot), `${sessionId}.json`); }
function messagesFilePath(projectRoot: string, sessionId: string): string { return join(messagesDir(projectRoot), `${sessionId}.jsonl`); }
function newMessageId(sessionId: string, existingCount: number): string { return `msg-${sessionId}-${existingCount + 1}`; }

function readMessages(projectRoot: string, sessionId: string): AgentMessage[] {
  const mp = messagesFilePath(projectRoot, sessionId);
  if (!existsSync(mp)) return [];
  const raw = readFileSync(mp, 'utf-8');
  if (raw.trim() === '') return [];
  const lines = raw.split('\n').filter((line) => line.trim() !== '');
  return lines.map((line) => agentMessageSchema.parse(JSON.parse(line)));
}

function appendMessage(projectRoot: string, sessionId: string, message: { role: MessageRole; kind: MessageKind; content: string; tool?: string; tool_call_id?: string; }): AgentMessage {
  const existing = readMessages(projectRoot, sessionId);
  const msg: AgentMessage = { id: newMessageId(sessionId, existing.length), session_id: sessionId, role: message.role, kind: message.kind, content: message.content, tool: message.tool, tool_call_id: message.tool_call_id, timestamp: now() };
  agentMessageSchema.parse(msg);
  const mp = messagesFilePath(projectRoot, sessionId);
  const line = JSON.stringify(msg) + '\n';
  if (existsSync(mp)) writeFileAtomic(mp, readFileSync(mp, 'utf-8') + line); else writeFileAtomic(mp, line);
  return msg;
}

const ANALYST_CONTEXT_LIMIT_TOKENS = 128_000;

function trimToCleanToolBoundary(messages: AgentMessage[]): AgentMessage[] {
  const callIdsInSlice = new Set<string>();
  for (const m of messages) {
    if (m.role === 'assistant' && m.kind === 'tool_call') {
      try {
        const parsed = JSON.parse(m.content) as { toolCalls?: Array<{ id?: string }> };
        for (const tc of parsed.toolCalls ?? []) {
          if (typeof tc?.id === 'string') callIdsInSlice.add(tc.id);
        }
      } catch { /* leave empty */ }
    }
  }
  const cleaned: AgentMessage[] = [];
  for (const m of messages) {
    if (m.role === 'tool' && m.kind === 'tool_result') {
      const id = m.tool_call_id;
      if (!id || !callIdsInSlice.has(id)) continue;
    }
    cleaned.push(m);
  }
  const resultIds = new Set<string>();
  for (const m of cleaned) {
    if (m.role === 'tool' && m.kind === 'tool_result' && m.tool_call_id) resultIds.add(m.tool_call_id);
  }
  const finalMessages: AgentMessage[] = [];
  for (const m of cleaned) {
    if (m.role === 'assistant' && m.kind === 'tool_call') {
      let allPresent = true;
      try {
        const parsed = JSON.parse(m.content) as { toolCalls?: Array<{ id?: string }> };
        for (const tc of parsed.toolCalls ?? []) {
          if (!tc?.id || !resultIds.has(tc.id)) { allPresent = false; break; }
        }
      } catch { allPresent = false; }
      if (!allPresent) continue;
    }
    finalMessages.push(m);
  }
  return finalMessages;
}

function readSession(projectRoot: string, sessionId: string): AgentSession | null {
  const sp = sessionFilePath(projectRoot, sessionId);
  if (!existsSync(sp)) return null;
  const raw = readFileSync(sp, 'utf-8');
  const parsed = agentSessionSchema.safeParse(JSON.parse(raw));
  if (!parsed.success) throw new Error(`AgentSession validation failed for ${sessionId}: ${parsed.error.message}`);
  return parsed.data;
}

function writeSession(projectRoot: string, session: AgentSession): void {
  agentSessionSchema.parse(session);
  writeFileAtomic(sessionFilePath(projectRoot, session.id), JSON.stringify(session, null, 2) + '\n');
}

export const GLOBAL_ANALYST_SESSION_ID = 'analyst';
export function getOrCreateAnalystSession(projectRoot: string, sessionId?: string): { session: AgentSession; sessionId: string } {
  const resolvedSessionId = sessionId || GLOBAL_ANALYST_SESSION_ID;
  const existing = readSession(projectRoot, resolvedSessionId);
  if (existing) return { session: existing, sessionId: existing.id };
  const session: AgentSession = { id: resolvedSessionId, role: 'analyst', status: 'active', started_at: now() };
  writeSession(projectRoot, session);
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

  let summary = result.success ? (tool === 'edit_card' && related_card_id ? `edited card ${related_card_id}` : 'completed') : (result.error ?? 'failed');
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

function broadcastToolInvocation(activeRuntime: ActiveRuntime | undefined, sessionId: string, tool: string, result: ToolResult): void {
  if (!activeRuntime) return;
  const payload = summarizeForBroadcast(tool, result);
  activeRuntime.runtime.eventBus.emit('analyst_tool_invoked', { sessionId, tool, success: result.success, ...payload });
}


export class AnalystHandler {
  private projectRoot: string;
  private onActivity?: ActivityCallback;
  private llmResolver: LlmIntentResolver;
  private sessionQueues: Map<string, Promise<AnalystResponse>> = new Map();
  private activeRuntime?: ActiveRuntime;
  private actor: ActorRole;
  private surface: ControlActionSurface;
  private requestServerRestart?: () => Promise<void>;
  private pendingDestructive = new PendingDestructiveStore();
  private amendmentSessions = new Set<string>();

  constructor(projectRoot: string, onActivity?: ActivityCallback, activeRuntime?: ActiveRuntime, actor: ActorRole = 'analyst', surface: ControlActionSurface = 'web-chat', requestServerRestart?: () => Promise<void>) {
    this.projectRoot = projectRoot;
    this.onActivity = onActivity;
    this.activeRuntime = activeRuntime;
    this.actor = actor;
    this.surface = surface;
    this.requestServerRestart = requestServerRestart;
    this.llmResolver = new LlmIntentResolver(projectRoot);
    this.llmResolver.setEventLogger(activeRuntime?.runtime?.eventLogger);
  }

  getAvailableToolNames(): string[] {
    return Object.keys(TOOL_REGISTRY).filter((name) => !(this.surface === 'telegram' && name === 'run_shell_command'));
  }

  async handleMessage(sessionId: string, userContent: string, workspaceContext?: WorkspaceContext): Promise<AnalystResponse> {
    const previous = this.sessionQueues.get(sessionId) ?? Promise.resolve(null as never);
    const next = previous.catch(() => null as never).then(() => this.handleMessageSerial(sessionId, userContent, workspaceContext));
    this.sessionQueues.set(sessionId, next);
    try { return await next; } finally { if (this.sessionQueues.get(sessionId) === next) this.sessionQueues.delete(sessionId); }
  }

  private emitActivity(activity: { type: 'tool_call' | 'tool_result' | 'thinking'; content: Record<string, unknown> }): void {
    if (!this.onActivity) return;
    try { this.onActivity(activity); } catch { void 0; }
  }

  private async handleMessageSerial(sessionId: string, userContent: string, workspaceContext?: WorkspaceContext): Promise<AnalystResponse> {
    let session = readSession(this.projectRoot, sessionId);
    if (!session) { const created = getOrCreateAnalystSession(this.projectRoot, sessionId); session = created.session; sessionId = created.sessionId; }
    const priorMessages = readMessages(this.projectRoot, sessionId);
    const duplicateResponse = this.findRecentDuplicateResponse(priorMessages, userContent);
    if (duplicateResponse) return duplicateResponse;
    appendMessage(this.projectRoot, sessionId, { role: 'user', kind: 'text', content: userContent });

    const expired = this.pendingDestructive.prune(Date.now());
    for (const invocation of expired) this.recordPendingOutcome(invocation, 'expired', 'destructive confirmation expired');
    if (expired.some((invocation) => invocation.sessionId === sessionId) && this.isAffirmation(userContent)) {
      const text = ANALYST_DESTRUCTIVE_STALE_AFFIRMATION_TEMPLATE();
      const persisted = appendMessage(this.projectRoot, sessionId, { role: 'assistant', kind: 'text', content: text });
      return { sessionId, message: { id: persisted.id, role: 'assistant', kind: 'text', content: text, timestamp: persisted.timestamp } };
    }
    const pending = this.pendingDestructive.get(sessionId);
    if (pending && Date.now() - pending.createdAt > CONFIRMATION_TTL_MS) {
      this.pendingDestructive.delete(sessionId);
      this.recordPendingOutcome(pending, 'expired', 'destructive confirmation expired');
      if (this.isAffirmation(userContent)) {
        const text = ANALYST_DESTRUCTIVE_STALE_AFFIRMATION_TEMPLATE();
        const persisted = appendMessage(this.projectRoot, sessionId, { role: 'assistant', kind: 'text', content: text });
        return { sessionId, message: { id: persisted.id, role: 'assistant', kind: 'text', content: text, timestamp: persisted.timestamp } };
      }
    }
    const activePending = this.pendingDestructive.get(sessionId);
    if (activePending) {
      if (this.isAffirmation(userContent)) {
        this.pendingDestructive.delete(sessionId);
        const ctx: ToolContext = { projectRoot: this.projectRoot, sessionId, activeRuntime: this.activeRuntime, requestServerRestart: this.requestServerRestart, actor: this.actor, surface: this.surface, confirmedDestructive: true };
        const toolFn = TOOL_REGISTRY[activePending.tool];
        const result = toolFn ? await toolFn(ctx, activePending.params) : { success: false, error: ANALYST_UNKNOWN_CAPABILITY_TEMPLATE(activePending.tool) };
        const preview = this.destructivePreviewFor(activePending.tool, activePending.params);
        const text = this.responseTextForResult(result) ?? (result.success ? `Confirmed. ${preview.actionVerb} applied to ${preview.ids.length} item(s): ${preview.ids.join(', ')}.` : (result.error ?? 'Confirmed action failed.'));
        const persisted = appendMessage(this.projectRoot, sessionId, { role: 'assistant', kind: 'text', content: text });
        return { sessionId, message: { id: persisted.id, role: 'assistant', kind: 'text', content: text, timestamp: persisted.timestamp }, toolInvocations: [{ tool: activePending.tool, params: activePending.params, result }] };
      }
      if (this.isCancellation(userContent)) {
        this.pendingDestructive.delete(sessionId);
        this.recordPendingOutcome(activePending, 'cancelled', 'destructive confirmation cancelled');
        const text = 'Cancelled. No changes were made.';
        const persisted = appendMessage(this.projectRoot, sessionId, { role: 'assistant', kind: 'text', content: text });
        return { sessionId, message: { id: persisted.id, role: 'assistant', kind: 'text', content: text, timestamp: persisted.timestamp } };
      }
      this.pendingDestructive.delete(sessionId);
      this.recordPendingOutcome(activePending, 'amended', 'destructive confirmation amended');
      this.amendmentSessions.add(sessionId);
    }

    const llmAvailable = await this.llmResolver.isAvailable();
    if (!llmAvailable) {
      const persisted = appendMessage(this.projectRoot, sessionId, { role: 'assistant', kind: 'text', content: ANALYST_OFFLINE_REPLY });
      return { sessionId, message: { id: persisted.id, role: 'assistant', kind: 'text', content: ANALYST_OFFLINE_REPLY, timestamp: persisted.timestamp } };
    }
    return await this.runAnalystLoop(sessionId, userContent, workspaceContext);
  }

  private isAffirmation(userContent: string): boolean { return new Set(['yes','y','confirm','proceed','do it','ok']).has(userContent.trim().toLowerCase()); }
  private isCancellation(userContent: string): boolean { return new Set(['no','n','cancel','stop','abort','never mind']).has(userContent.trim().toLowerCase()); }
  private recordPendingOutcome(invocation: { tool: string; params: Record<string, unknown> }, outcome: 'rejected' | 'preview' | 'cancelled' | 'expired' | 'amended', summary: string): void {
    recordControlAction(this.projectRoot, { actor: this.actor, surface: this.surface, action: `destructive_confirmation.${invocation.tool}`, target_kind: null, target_id: null, params_summary: stableStringify(invocation.params), confirmed: false, outcome, outcome_summary: summary });
  }
  private destructivePreviewFor(tool: string, params: Record<string, unknown>): { actionVerb: string; targetDescription: string; ids: string[] } {
    const ids = Array.isArray(params['ids']) ? params['ids'].map(String) : typeof params['id'] === 'string' ? [params['id']] : typeof params['goalId'] === 'string' ? [params['goalId']] : typeof params['processId'] === 'string' ? [params['processId']] : ['target'];
    const actionVerb = tool.replace(/_/g, ' ');
    return { actionVerb, targetDescription: tool, ids };
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
    const toolInvocations: NonNullable<AnalystResponse['toolInvocations']> = [];
    const projectContext = this.buildProjectContext();
    const ctx: ToolContext = { projectRoot: this.projectRoot, sessionId, activeRuntime: this.activeRuntime, requestServerRestart: this.requestServerRestart, actor: this.actor, surface: this.surface };
    const previousToolCallFingerprints = new Set<string>();

    for (;;) {
      // Auto-compact when the conversation approaches the model context
      // window. Falls back to truncation (last 20% of messages) when no
      // summarizer is wired in. After compaction we still apply
      // trimToCleanToolBoundary so any orphan tool_call ↔ tool_result
      // pair produced by truncation can't reach the LLM and trigger an
      // HTTP 400 "No tool call found for function call output" error.
      // No max-compaction cap: the operator cannot start a fresh
      // analyst session from the chat, so compaction must always
      // succeed in shrinking the working set.
      try {
        await compactSession(saivageDir(this.projectRoot), sessionId, {
          contextLimit: ANALYST_CONTEXT_LIMIT_TOKENS,
          threshold: 0.8,
          maxCompactions: Number.MAX_SAFE_INTEGER,
        });
      } catch { /* compaction is best-effort; continue with raw history */ }

      const history = readMessages(this.projectRoot, sessionId);
      const bounded = trimToCleanToolBoundary(history);
      const modelInput: AgentMessage[] = [
        { id: `workspace-context-${sessionId}`, session_id: sessionId, role: 'system', kind: 'text', content: buildWorkspaceContextNote(workspaceContext), timestamp: now() },
        ...bounded,
      ];

      let llmResult;
      try {
        llmResult = await this.llmResolver.chat(modelInput, projectContext);
      } catch (err) {
        const errMsg = err instanceof AnalystOfflineError
          ? err.message
          : `Analyst LLM unavailable: ${err instanceof Error ? err.message : String(err)}`;
        const persisted = appendMessage(this.projectRoot, sessionId, { role: 'assistant', kind: 'text', content: errMsg });
        return { sessionId, message: { id: persisted.id, role: 'assistant', kind: 'text', content: errMsg, timestamp: persisted.timestamp }, toolInvocations: toolInvocations.length > 0 ? toolInvocations : undefined };
      }

      if (!llmResult.toolCalls || llmResult.toolCalls.length === 0) {
        const finalText = (llmResult.content ?? '').trim() || 'Done.';
        const persisted = appendMessage(this.projectRoot, sessionId, { role: 'assistant', kind: 'text', content: finalText });
        return { sessionId, message: { id: persisted.id, role: 'assistant', kind: 'text', content: finalText, timestamp: persisted.timestamp }, toolInvocations: toolInvocations.length > 0 ? toolInvocations : undefined };
      }

      const toolCalls = llmResult.toolCalls;
      const fingerprint = toolCalls.map((tc) => `${tc.function.name}:${tc.function.arguments}`).sort().join('||');
      if (previousToolCallFingerprints.has(fingerprint)) {
        const noProgressText = 'I repeated the same tool calls without making progress. Please refine the request or inspect the latest tool results.';
        const persisted = appendMessage(this.projectRoot, sessionId, { role: 'assistant', kind: 'text', content: noProgressText });
        return { sessionId, message: { id: persisted.id, role: 'assistant', kind: 'text', content: noProgressText, timestamp: persisted.timestamp }, toolInvocations: toolInvocations.length > 0 ? toolInvocations : undefined };
      }
      previousToolCallFingerprints.add(fingerprint);
      appendMessage(this.projectRoot, sessionId, { role: 'assistant', kind: 'tool_call', content: JSON.stringify({ toolCalls }) });

      for (const tc of toolCalls) {
        let params: Record<string, unknown> = {};
        try { params = JSON.parse(tc.function.arguments) as Record<string, unknown>; } catch { params = {}; }


        this.emitActivity({ type: 'tool_call', content: { tool: tc.function.name, params } });

        const toolFn = TOOL_REGISTRY[tc.function.name];
        let result: ToolResult;
        if (!toolFn) {
          this.amendmentSessions.delete(sessionId);
          result = { success: false, error: ANALYST_UNKNOWN_CAPABILITY_TEMPLATE(tc.function.name) };
        } else if (isDestructiveAnalystTool(tc.function.name)) {
          const preview = this.destructivePreviewFor(tc.function.name, params);
          this.pendingDestructive.set(sessionId, { sessionId, tool: tc.function.name, params, createdAt: Date.now(), actionVerb: preview.actionVerb, targetDescription: preview.targetDescription, ids: preview.ids });
          const isAmendment = this.amendmentSessions.delete(sessionId);
          const summary = isAmendment
            ? ANALYST_DESTRUCTIVE_AMENDMENT_TEMPLATE(preview.actionVerb, preview.targetDescription)
            : ANALYST_DESTRUCTIVE_PREVIEW_TEMPLATE(preview.actionVerb, preview.targetDescription, preview.ids.length, preview.ids);
          result = { success: false, preview: { type: 'destructive_confirmation', summary, affectedCards: [], affectedProcesses: [], warnings: ['Awaiting conversational confirmation.'] } };
        } else {
          this.amendmentSessions.delete(sessionId);
          try { result = await toolFn(ctx, params); }
          catch (err) { result = { success: false, error: err instanceof Error ? err.message : String(err) }; }
        }


        this.emitActivity({ type: 'tool_result', content: { tool: tc.function.name, success: result.success, hasPreview: !!result.preview } });

        toolInvocations.push({ tool: tc.function.name, params, result });

        const resultJson = JSON.stringify(result);
        const truncated = resultJson.length > 16_000 ? resultJson.slice(0, 16_000) + '…[truncated]' : resultJson;
        appendMessage(this.projectRoot, sessionId, { role: 'tool', kind: 'tool_result', content: truncated, tool: tc.function.name, tool_call_id: tc.id });
        broadcastToolInvocation(this.activeRuntime, sessionId, tc.function.name, result);
        const contractText = !toolFn ? result.error : (result.preview?.type === 'destructive_confirmation' ? result.preview.summary : this.responseTextForResult(result));
        if (contractText) {
          const persisted = appendMessage(this.projectRoot, sessionId, { role: 'assistant', kind: 'text', content: contractText });
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
      const store = new CardStore(this.projectRoot);
      return JSON.stringify({ projectRoot: this.projectRoot, cards: store.list().map((card) => ({ id: card.id, type: card.type, parent: card.parent, status: card.status, title: card.title, description: card.description, acceptance: card.acceptance, priority: card.priority, tags: card.tags })) }, null, 2);
    } catch {
      return `Project root: ${this.projectRoot}`;
    }
  }
}

interface CachedHandler {
  handler: AnalystHandler;
  activeRuntime?: ActiveRuntime;
  onActivity?: ActivityCallback;
  actor: ActorRole;
  surface: ControlActionSurface;
  requestServerRestart?: () => Promise<void>;
}
const analystHandlersByRoot = new Map<string, CachedHandler>();

export function getAnalystHandler(projectRoot: string, opts?: { activeRuntime?: ActiveRuntime; onActivity?: ActivityCallback; actor?: ActorRole; surface?: ControlActionSurface; requestServerRestart?: () => Promise<void> }): AnalystHandler {
  const actor = opts?.actor ?? 'analyst';
  const surface = opts?.surface ?? 'web-chat';
  const cached = analystHandlersByRoot.get(projectRoot);
  if (cached
    && cached.activeRuntime === opts?.activeRuntime
    && cached.onActivity === opts?.onActivity
    && cached.actor === actor
    && cached.surface === surface
    && cached.requestServerRestart === opts?.requestServerRestart) return cached.handler;
  const handler = new AnalystHandler(projectRoot, opts?.onActivity, opts?.activeRuntime, actor, surface, opts?.requestServerRestart);
  analystHandlersByRoot.set(projectRoot, { handler, activeRuntime: opts?.activeRuntime, onActivity: opts?.onActivity, actor, surface, requestServerRestart: opts?.requestServerRestart });
  return handler;
}

export function resetAnalystHandlerCache(projectRoot?: string): void {
  if (projectRoot) { analystHandlersByRoot.delete(projectRoot); return; }
  analystHandlersByRoot.clear();
}
