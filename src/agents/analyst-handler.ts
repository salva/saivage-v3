import { join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { writeFileAtomic } from '../persistence/file-tree.js';
import { agentSessionSchema, agentMessageSchema } from '../schemas/validators.js';
import type { AgentSession, AgentMessage, MessageRole, MessageKind, ControlActionSurface, ControlActionAuditEntry } from '../schemas/types.js';
import type { ToolResult, ToolContext } from './analyst-tools.js';
import { TOOL_REGISTRY } from './analyst-llm-resolver.js';
import { LlmIntentResolver } from './analyst-llm-resolver.js';
import { CardStore } from '../cards/card-store.js';
import type { ActiveRuntime } from '../runtime/active-runtime.js';
import type { ActorRole } from './authz.js';
import { sanitizeAnalystText } from '../agents/analyst-sanitization.js';
import { compactSession } from './compaction.js';

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

interface ParsedIntent {
  tool: string;
  params: Record<string, unknown>;
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

/**
 * Approximate context window (tokens) used to decide when to compact the
 * analyst conversation. Compaction triggers at 80% of this value. Chosen
 * conservatively to fit even smaller models routed for analyst use.
 */
const ANALYST_CONTEXT_LIMIT_TOKENS = 128_000;

/**
 * Trim a bounded history slice so that tool_call ↔ tool_result pairs are
 * preserved. Without this, slice(-N) can land in the middle of a
 * tool-call batch and leave orphan `tool_result` messages (or an
 * orphan assistant `tool_call` whose results were dropped), which the
 * OpenAI Responses API rejects with HTTP 400 "No tool call found for
 * function call output with call_id ...".
 */
function trimToCleanToolBoundary(messages: AgentMessage[]): AgentMessage[] {
  // Collect tool_call ids announced by assistant `tool_call` messages
  // *inside* this slice.
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
  // Drop any `tool_result` whose originating tool_call is not in the slice.
  const cleaned: AgentMessage[] = [];
  for (const m of messages) {
    if (m.role === 'tool' && m.kind === 'tool_result') {
      const id = m.tool_call_id;
      if (!id || !callIdsInSlice.has(id)) continue;
    }
    cleaned.push(m);
  }
  // Also drop any leading assistant `tool_call` batch whose results are
  // not all present (would leave orphan function_call entries).
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

function extractCardIds(text: string): string[] { const matches = text.match(/([a-zA-Z]+-[a-zA-Z0-9]+|project)/g); if (!matches) return []; return [...new Set(matches)]; }
function extractGoalIds(text: string): string[] { const matches = text.match(/goal-\d+/g); if (!matches) return []; return [...new Set(matches)]; }
function extractProcessIds(text: string): string[] { const matches = text.match(/proc-[a-zA-Z0-9-]+/g); if (!matches) return []; return [...new Set(matches)]; }
function extractStatus(text: string): string | undefined { const statuses = ['backlog', 'active', 'done', 'failed', 'cancelled']; const lower = text.toLowerCase(); for (const s of statuses) if (lower.includes(s)) return s; return undefined; }
function extractPriority(text: string): number | undefined { const m = text.match(/(?:priority|pri|p)\s*[:=]?\s*(\d+)/i); if (m) { const val = parseInt(m[1], 10); if (!isNaN(val)) return val; } return undefined; }
function extractCardType(text: string): string | undefined { const types = ['architecture', 'code', 'test', 'doc', 'data', 'research', 'ops', 'goal']; const lower = text.toLowerCase().replace(/\b(?:goal|architecture|code|test|doc|data|research|ops)-[a-z0-9]+\b/g, ' '); for (const t of types) { const explicitPattern = new RegExp(`\\b${t}\\s+(?:card|task|work|item|goal)\\b`, 'i'); if (explicitPattern.test(lower)) return t; } for (const t of types) { const pattern = new RegExp(`\\b${t}\\b`, 'i'); if (pattern.test(lower)) return t; } if (/\bproject\b/i.test(lower)) return 'project'; return undefined; }
function refineIntentFromUserContent(intent: ParsedIntent, userContent: string): ParsedIntent { if (intent.tool !== 'create_card') return intent; const explicitType = extractCardType(userContent); if (!explicitType || explicitType === intent.params.type) return intent; return { ...intent, params: { ...intent.params, type: explicitType } }; }
function extractTags(text: string): string[] { const tags: string[] = []; const tagColon = text.match(/tag\s*:\s*(\S+)/gi); if (tagColon) for (const m of tagColon) tags.push(m.replace(/tag\s*:\s*/i, '')); const hashTags = text.match(/#(\w[\w-]*)/g); if (hashTags) for (const m of hashTags) tags.push(m.slice(1)); return [...new Set(tags)]; }
function extractLines(text: string): number | undefined { const m = text.match(/lines?\s*[:=]\s*(\d+)/i); if (m) { const val = parseInt(m[1], 10); if (!isNaN(val)) return val; } const m2 = text.match(/(\d+)\s*lines/i); if (m2) { const val = parseInt(m2[1], 10); if (!isNaN(val)) return val; } return undefined; }
function extractTitle(text: string): string | undefined { const doubleQuoted = text.match(/"([^"]+)"/); if (doubleQuoted) return doubleQuoted[1]; const singleQuoted = text.match(/'([^']+)'/); if (singleQuoted) return singleQuoted[1]; return undefined; }
function extractParentId(text: string): string | undefined { const m = text.match(/(?:under|parent|above|below|in|beneath)\s+([a-zA-Z]+-[a-zA-Z0-9]+|project)/i); if (m) return m[1]; return undefined; }
function extractNewParent(text: string): string | undefined { const m = text.match(/(?:to|into|under)\s+([a-zA-Z]+-[a-zA-Z0-9]+|project)/i); if (m) return m[1]; return undefined; }
function extractNoteKind(text: string): string | undefined { const lower = text.toLowerCase(); if (lower.includes('directive')) return 'directive'; if (lower.includes('progress')) return 'progress'; if (lower.includes('escalation')) return 'escalation'; if (lower.includes('comment')) return 'comment'; return undefined; }

function parseIntent(text: string): ParsedIntent | null {
  const cardIds = extractCardIds(text);
  if (/\bpause\b.*\bruntime\b|\bruntime\b.*\bpause\b/i.test(text)) return { tool: 'pause_runtime', params: {} };
  if (/\bresume\b.*\bruntime\b|\bruntime\b.*\bresume\b/i.test(text)) return { tool: 'resume_runtime', params: {} };
  if (/\b(?:abort|cancel)\b.*\bgoal\b|\bgoal\b.*\b(?:abort|cancel)\b/i.test(text)) { const goalIds = extractGoalIds(text); if (goalIds.length > 0) return { tool: 'abort_goal', params: { goalId: goalIds[0] } }; return { tool: 'abort_goal', params: {} }; }
  if (/\brestart\s+goal\b|\breset\s+goal\b/i.test(text)) { const goalIds = extractGoalIds(text); if (goalIds.length > 0) return { tool: 'restart_goal', params: { goalId: goalIds[0] } }; return { tool: 'restart_goal', params: {} }; }
  if (/\brestart\s+card\b|\bre-?queue\b/i.test(text)) { const ids = cardIds.filter((id) => id !== 'project'); if (ids.length > 0) return { tool: 'restart_card', params: { id: ids[0] } }; return { tool: 'restart_card', params: {} }; }
  if (/\b(?:delete|remove)\b/i.test(text)) { const ids = cardIds.filter((id) => id !== 'project'); if (ids.length > 0) return { tool: 'delete_card', params: { id: ids[0] } }; return { tool: 'delete_card', params: {} }; }
  if (/\bmove\b/i.test(text)) { const ids = cardIds.filter((id) => id !== 'project'); const newParent = extractNewParent(text); const params: Record<string, unknown> = {}; if (newParent !== undefined) params.newParent = newParent; if (ids.length > 0) { params.id = ids[0]; return { tool: 'move_card', params }; } return { tool: 'move_card', params }; }
  if (/\b(?:edit|update|change|modify)\b/i.test(text)) { const ids = cardIds.filter((id) => id !== 'project'); const params: Record<string, unknown> = {}; if (ids.length > 0) params.id = ids[0]; const title = extractTitle(text); if (title) params.title = title; else { const titleTail = text.match(/\btitle\s+(.+)$/i); if (titleTail?.[1]) params.title = titleTail[1].trim(); } const status = extractStatus(text); if (status) params.status = status; const priority = extractPriority(text); if (priority !== undefined) params.priority = priority; const tags = extractTags(text); if (tags.length > 0) params.tags = tags; return { tool: 'edit_card', params }; }
  if (/\b(?:note|comment|directive)\b/i.test(text)) { const ids = cardIds.filter((id) => id !== 'project'); const kind = extractNoteKind(text); const params: Record<string, unknown> = { kind: kind || 'comment', content: text }; if (ids.length > 0) params.cardId = ids[0]; return { tool: 'add_note', params }; }
  if (/\b(?:create|new|add)\b/i.test(text)) { const type = extractCardType(text); const title = extractTitle(text); const parent = extractParentId(text); const params: Record<string, unknown> = {}; if (type) params.type = type; if (title) params.title = title; if (parent) params.parent = parent; const descMatch = text.match(/description\s*[:=]\s*(.+?)(?:\s+\w+\s*[:=]|\s*$)/i); if (descMatch) params.description = descMatch[1].trim(); return { tool: 'create_card', params }; }
  if (/\b(?:see|current|existing|available|what)\b.*\b(?:card|task|item)s?\b/i.test(text) || /\b(?:card|task|item)s?\b.*\b(?:exist|available|current)\b/i.test(text)) return { tool: 'get_tree', params: {} };
  if (/\bobjectives?\b/i.test(text)) return { tool: 'get_card', params: { id: 'project' } };
  if (/\b(?:tree|hierarchy)\b/i.test(text)) { const rootMatch = text.match(/(?:from|root|of)\s+([a-zA-Z]+-[a-zA-Z0-9]+|project)/i); const params: Record<string, unknown> = {}; if (rootMatch) params.rootId = rootMatch[1]; return { tool: 'get_tree', params }; }
  if (/\b(?:diary|plan\s*log)\b/i.test(text)) { const goalIds = extractGoalIds(text); if (goalIds.length > 0) return { tool: 'get_plan_diary', params: { goalId: goalIds[0] } }; return { tool: 'get_plan_diary', params: {} }; }
  if (/\b(read|inspect|show|open)\b.*\b(file|README|package\.json|tsconfig|json|md|log)\b/i.test(text) || /\bREADME\.md\b/i.test(text)) { const pathMatch = text.match(/((?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+\.[A-Za-z0-9_-]+)/); const path = pathMatch?.[1] ?? (text.match(/\bREADME(?:\.md)?\b/i)?.[0] ?? null); if (path) return { tool: 'read_file', params: { path } }; }
  if (/\b(run|exec(?:ute)?)\b.*\b(shell|command)\b/i.test(text) || /^(sudo|ls|pwd|cat|grep|rg|git\s+status|git\s+diff|python3?)\b/i.test(text.trim())) { return { tool: 'run_shell_command', params: { command: text.trim() } }; }
  if (/\b(?:output|log|stdout|stderr)\b/i.test(text) && !/\b(?:create|edit|delete|move)\b/i.test(text)) { const ids = cardIds.filter((id) => id !== 'project'); const procIds = extractProcessIds(text); const lines = extractLines(text); const params: Record<string, unknown> = {}; if (procIds.length > 0) params.processId = procIds[0]; if (ids.length > 0) params.cardId = ids[0]; if (lines !== undefined) params.lines = lines; return { tool: 'get_card_output', params }; }
  if (/\b(?:detail|inspect|show\s+card|look\s+at|examine)\b/i.test(text)) { const ids = cardIds.filter((id) => id !== 'project'); if (ids.length > 0) return { tool: 'get_card', params: { id: ids[0] } }; return { tool: 'get_card', params: {} }; }
  if (/\b(?:list|show)\b.*\b(?:card|task|item)s?\b/i.test(text)) { const status = extractStatus(text); const type = extractCardType(text); const parent = extractParentId(text); const tags = extractTags(text); const params: Record<string, unknown> = {}; if (status) params.status = status; if (type && type !== 'project') params.type = type; if (parent) params.parent = parent; if (tags.length > 0) params.tag = tags[0]; return { tool: 'list_cards', params }; }
  if (/\b(?:status|state|overview|how.*going|progress)\b/i.test(text)) return { tool: 'get_status', params: {} };
  if (cardIds.length > 0 && cardIds[0] !== 'project') return { tool: 'get_card', params: { id: cardIds[0] } };
  return null;
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

function buildResponse(tool: string, result: ToolResult): string {
  if (!result.success) return `❌ Failed: ${result.error || 'Unknown error'}`;
  if (result.preview) {
    const p = result.preview;
    let previewMsg = `⚠️ Action preview. This mutation was not applied; use an authorized surface or adjust the request.\n\n`;
    previewMsg += `**Action**: ${p.type}\n`;
    previewMsg += `**Summary**: ${p.summary}\n`;
    if (p.affectedCards.length > 0) { previewMsg += `\n**Affected Cards**:\n`; for (const card of p.affectedCards.slice(0, 10)) previewMsg += `  - ${card.id}: "${card.title}" (${card.type}, ${card.status})\n`; if (p.affectedCards.length > 10) previewMsg += `  ... and ${p.affectedCards.length - 10} more\n`; }
    if (p.affectedProcesses.length > 0) { previewMsg += `\n**Affected Processes**:\n`; for (const proc of p.affectedProcesses) previewMsg += `  - ${proc.id}: ${proc.command} (${proc.status})\n`; }
    if (p.warnings.length > 0) { previewMsg += `\n**Warnings**:\n`; for (const w of p.warnings) previewMsg += `  - ⚠ ${w}\n`; }
    return previewMsg;
  }
  switch (tool) {
    case 'pause_runtime': return `Runtime paused. Status: ${String((result.data as Record<string, unknown> | undefined)?.status || 'paused')}.`;
    case 'resume_runtime': return `Runtime resumed. Status: ${String((result.data as Record<string, unknown> | undefined)?.status || 'idle')}.`;
    default: return 'Action completed successfully.';
  }
}

const HELP_TEXT = "I'm not sure how to help with that. I can create/edit/list/delete cards, manage notes, control the runtime (pause/resume/abort/restart), inspect processes and outputs, and show the card tree. Try asking me something specific!";

export class AnalystHandler {
  private projectRoot: string;
  private onActivity?: ActivityCallback;
  private lastIntent: Map<string, ParsedIntent> = new Map();
  private llmResolver: LlmIntentResolver;
  private sessionQueues: Map<string, Promise<AnalystResponse>> = new Map();
  private activeRuntime?: ActiveRuntime;
  private actor: ActorRole;
  private surface: ControlActionSurface;

  constructor(projectRoot: string, onActivity?: ActivityCallback, activeRuntime?: ActiveRuntime, actor: ActorRole = 'analyst', surface: ControlActionSurface = 'web-chat') {
    this.projectRoot = projectRoot;
    this.onActivity = onActivity;
    this.activeRuntime = activeRuntime;
    this.actor = actor;
    this.surface = surface;
    this.llmResolver = new LlmIntentResolver(projectRoot);
  }

  getAvailableToolNames(): string[] {
    return Object.keys(TOOL_REGISTRY).filter((name) => !(this.surface === 'telegram' && name === 'run_shell_command'));
  }

  async handleMessage(sessionId: string, userContent: string): Promise<AnalystResponse> {
    const previous = this.sessionQueues.get(sessionId) ?? Promise.resolve(null as never);
    const next = previous.catch(() => null as never).then(() => this.handleMessageSerial(sessionId, userContent));
    this.sessionQueues.set(sessionId, next);
    try { return await next; } finally { if (this.sessionQueues.get(sessionId) === next) this.sessionQueues.delete(sessionId); }
  }

  private emitActivity(activity: { type: 'tool_call' | 'tool_result' | 'thinking'; content: Record<string, unknown> }): void {
    if (!this.onActivity) return;
    try { this.onActivity(activity); } catch {}
  }

  private async handleMessageSerial(sessionId: string, userContent: string): Promise<AnalystResponse> {
    let session = readSession(this.projectRoot, sessionId);
    if (!session) { const created = getOrCreateAnalystSession(this.projectRoot, sessionId); session = created.session; sessionId = created.sessionId; }
    const priorMessages = readMessages(this.projectRoot, sessionId);
    const duplicateResponse = this.findRecentDuplicateResponse(priorMessages, userContent);
    if (duplicateResponse) return duplicateResponse;
    appendMessage(this.projectRoot, sessionId, { role: 'user', kind: 'text', content: userContent });

    const deterministicIntent = parseIntent(userContent);
    if (deterministicIntent && ['pause_runtime', 'resume_runtime'].includes(deterministicIntent.tool)) {
      return await this.runOfflineFallback(sessionId, userContent);
    }

    const llmAvailable = await this.llmResolver.isAvailable();
    if (llmAvailable) {
      return await this.runAnalystLoop(sessionId, userContent);
    }
    return await this.runOfflineFallback(sessionId, userContent);
  }

  private async runAnalystLoop(sessionId: string, userContent: string): Promise<AnalystResponse> {
    const toolInvocations: NonNullable<AnalystResponse['toolInvocations']> = [];
    const projectContext = this.buildProjectContext();
    const ctx: ToolContext = { projectRoot: this.projectRoot, sessionId, activeRuntime: this.activeRuntime, actor: this.actor, surface: this.surface };
    const previousToolCallFingerprints = new Set<string>();

    while (true) {
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

      let llmResult;
      try {
        llmResult = await this.llmResolver.chat(bounded, projectContext);
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        const errMsg = `⚠️ Analyst LLM unavailable: ${reason}`;
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
          result = { success: false, error: `Unknown tool: ${tc.function.name}` };
        } else {
          try { result = await toolFn(ctx, params); }
          catch (err) { result = { success: false, error: err instanceof Error ? err.message : String(err) }; }
        }

        if (result.success && this.lastIntent.get(sessionId)?.tool === tc.function.name) this.lastIntent.delete(sessionId);

        this.emitActivity({ type: 'tool_result', content: { tool: tc.function.name, success: result.success, hasPreview: !!result.preview } });

        toolInvocations.push({ tool: tc.function.name, params, result });

        const resultJson = JSON.stringify(result);
        const truncated = resultJson.length > 16_000 ? resultJson.slice(0, 16_000) + '…[truncated]' : resultJson;
        appendMessage(this.projectRoot, sessionId, { role: 'tool', kind: 'tool_result', content: truncated, tool: tc.function.name, tool_call_id: tc.id });
        broadcastToolInvocation(this.activeRuntime, sessionId, tc.function.name, result);
      }
    }
  }

  private async runOfflineFallback(sessionId: string, userContent: string): Promise<AnalystResponse> {
    let intent: ParsedIntent | null = null;
    const lower = userContent.trim().toLowerCase();
    if (lower === 'yes' || lower === 'confirm' || lower === 'proceed' || lower === 'ok') {
      const lastInt = this.lastIntent.get(sessionId);
      if (lastInt) {
        intent = { tool: lastInt.tool, params: { ...lastInt.params } };
        this.lastIntent.delete(sessionId);
      }
    }
    if (!intent) intent = parseIntent(userContent);
    if (intent) intent = refineIntentFromUserContent(intent, userContent);
    const toolInvocations: AnalystResponse['toolInvocations'] = [];
    try {
      if (!intent) { const msg = appendMessage(this.projectRoot, sessionId, { role: 'assistant', kind: 'text', content: HELP_TEXT }); return { sessionId, message: { id: msg.id, role: 'assistant', kind: 'text', content: HELP_TEXT, timestamp: msg.timestamp } }; }
      const toolFn = TOOL_REGISTRY[intent.tool];
      if (!toolFn) { const errorContent = `❌ Unknown tool: ${intent.tool}`; const msg = appendMessage(this.projectRoot, sessionId, { role: 'assistant', kind: 'text', content: errorContent }); return { sessionId, message: { id: msg.id, role: 'assistant', kind: 'text', content: errorContent, timestamp: msg.timestamp } }; }
      this.emitActivity({ type: 'tool_call', content: { tool: intent.tool, params: intent.params } });
      const ctx: ToolContext = { projectRoot: this.projectRoot, sessionId, activeRuntime: this.activeRuntime, actor: this.actor, surface: this.surface };
      const result = await toolFn(ctx, intent.params);
      this.emitActivity({ type: 'tool_result', content: { tool: intent.tool, success: result.success, hasPreview: !!result.preview } });
      toolInvocations.push({ tool: intent.tool, params: intent.params, result });
      appendMessage(this.projectRoot, sessionId, { role: 'tool', kind: 'tool_result', content: JSON.stringify(result).slice(0, 16000), tool: intent.tool });
      broadcastToolInvocation(this.activeRuntime, sessionId, intent.tool, result);
      const responseContent = buildResponse(intent.tool, result);
      const msg = appendMessage(this.projectRoot, sessionId, { role: 'assistant', kind: 'text', content: responseContent, tool: intent.tool });
      return { sessionId, message: { id: msg.id, role: 'assistant', kind: 'text', content: responseContent, timestamp: msg.timestamp }, toolInvocations: toolInvocations.length > 0 ? toolInvocations : undefined };
    } catch (err) {
      const errorContent = `❌ Error: ${err instanceof Error ? err.message : String(err)}`;
      const msg = appendMessage(this.projectRoot, sessionId, { role: 'assistant', kind: 'text', content: errorContent });
      return { sessionId, message: { id: msg.id, role: 'assistant', kind: 'text', content: errorContent, timestamp: msg.timestamp } };
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
}
const analystHandlersByRoot = new Map<string, CachedHandler>();

export function getAnalystHandler(projectRoot: string, opts?: { activeRuntime?: ActiveRuntime; onActivity?: ActivityCallback; actor?: ActorRole; surface?: ControlActionSurface }): AnalystHandler {
  const actor = opts?.actor ?? 'analyst';
  const surface = opts?.surface ?? 'web-chat';
  const cached = analystHandlersByRoot.get(projectRoot);
  if (cached
    && cached.activeRuntime === opts?.activeRuntime
    && cached.onActivity === opts?.onActivity
    && cached.actor === actor
    && cached.surface === surface) return cached.handler;
  const handler = new AnalystHandler(projectRoot, opts?.onActivity, opts?.activeRuntime, actor, surface);
  analystHandlersByRoot.set(projectRoot, { handler, activeRuntime: opts?.activeRuntime, onActivity: opts?.onActivity, actor, surface });
  return handler;
}

export function resetAnalystHandlerCache(projectRoot?: string): void {
  if (projectRoot) { analystHandlersByRoot.delete(projectRoot); return; }
  analystHandlersByRoot.clear();
}
