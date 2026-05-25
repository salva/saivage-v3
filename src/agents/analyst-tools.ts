import { join, relative, resolve as resolvePath } from 'node:path';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync, lstatSync } from 'node:fs';
import { CardStore } from '../cards/index.js';
import { getNotes, deleteAllNotes } from '../cards/index.js';
import { getDiaryEntries, deleteDiary } from '../cards/index.js';
import { readRuntimeState } from '../runtime/index.js';
import { pauseRuntimeControl, resumeRuntimeControl, RESUME_FROM_FREEZE_MESSAGE } from '../runtime/index.js';
import { listProcesses, tailOutput, getProcess, killProcess } from '../runtime/index.js';
import type { CardRecord, CardType, CardStatus, ControlActionSurface } from '../schemas/index.js';
import type { ActiveRuntime } from '../runtime/index.js';
import type { ActorRole, SafetyClass } from './authz.js';
import { evaluateAuthz } from './authz.js';
import { listControlActions, recordControlAction } from '../persistence/index.js';
import { redactTextForOutbound } from '../redaction/index.js';
import { SecretPathError, assertSafeShellCwd } from '../workspace/index.js';
import { classifyShellCommand, sanitizedEnv } from '../workspace/index.js';
import { markGoalNeedsCorrections, normalizeAnalystIssues, notifyPlannerOfAnalystAction } from '../agents/analyst-stage6.js';
import { CARD_STATUS_VALUES, CARD_TYPE_VALUES, URGENCY_VALUES, NOTE_KIND_VALUES } from './analyst-tool-schemas.js';
import { decide } from '../permissions/index.js';
import { assertAnalystInspectionTarget, isAnalystSecretPath, redactAnalystSecretValue } from './analyst-secret-classifier.js';
import { runAuditedAnalystTool } from './analyst-tool-runner.js';
import { getRedactedConfig, mcpAdd, mcpEdit, mcpRemove, setFailoverOrder, setRoleRouting, setRuntimeSetting, setServerSetting } from './analyst-config-writer.js';

/**
 * Convert a raw tool error message (often a stringified Zod issue array
 * thrown by the card store / validators) into a single-line hint the
 * analyst LLM can act on without having to parse JSON.
 *
 * Always references the canonical tool parameter schema and, when the
 * failure is an enum mismatch, lists the allowed values.
 */
function humanizeToolError(toolName: string, raw: string): string {
  const enumHints: string[] = [];
  const enumIssueRe = /"received":\s*"([^"]*)"[\s\S]*?"path":\s*\[\s*"([^"]+)"[\s\S]*?Expected\s+([^,]+(?:\s*\|\s*[^,]+)+)/g;
  let m: RegExpExecArray | null;
  while ((m = enumIssueRe.exec(raw)) !== null) {
    const got = m[1];
    const field = m[2];
    const allowed = m[3].replace(/'/g, '').split('|').map((s) => s.trim()).filter(Boolean).join(', ');
    enumHints.push(`field '${field}' received '${got}'; allowed values: ${allowed}`);
  }
  if (enumHints.length === 0) {
    if (/\bstatus\b/i.test(raw)) enumHints.push(`'status' allowed values: ${CARD_STATUS_VALUES.join(', ')}`);
    else if (/\burgency\b/i.test(raw)) enumHints.push(`'urgency' allowed values: ${URGENCY_VALUES.join(', ')}`);
    else if (/\btype\b/i.test(raw)) enumHints.push(`'type' allowed values: ${CARD_TYPE_VALUES.join(', ')}`);
    else if (/\bkind\b/i.test(raw)) enumHints.push(`'kind' allowed values: ${NOTE_KIND_VALUES.join(', ')}`);
  }
  const hintLine = enumHints.length > 0 ? ` Hint: ${enumHints.join('; ')}.` : '';
  return `${toolName} failed.${hintLine} See the '${toolName}' tool's parameter schema for the full list of accepted fields and values. Original error: ${raw}`;
}

function preflightEnum<T extends string>(value: unknown, allowed: readonly T[], field: string, toolName: string): { ok: true } | { ok: false; error: string } {
  if (value === undefined) return { ok: true };
  if (typeof value !== 'string') return { ok: false, error: `${toolName} failed: field '${field}' must be a string. Allowed values: ${allowed.join(', ')}. See the '${toolName}' tool's parameter schema.` };
  if (!(allowed as readonly string[]).includes(value)) return { ok: false, error: `${toolName} failed: field '${field}' received '${value}', which is not a valid value. Allowed values: ${allowed.join(', ')}. See the '${toolName}' tool's parameter schema.` };
  return { ok: true };
}


export interface ActionPreview { type: string; summary: string; affectedCards: Array<{ id: string; title: string; type: string; status: string }>; affectedProcesses: Array<{ id: string; command: string; status: string }>; warnings: string[]; }
export interface ToolResult { success: boolean; data?: unknown; preview?: ActionPreview; error?: string; }


type ShellCommandParams = { command: string; cwd?: string; timeoutMs?: number; maxOutputBytes?: number };
type NormalizedShellCommandParams = { command: string; cwd: string; timeoutMs: number; maxOutputBytes: number };

const SHELL_TIMEOUT_DEFAULT_MS = 15_000;
const SHELL_TIMEOUT_MAX_MS = 60_000;
const SHELL_OUTPUT_DEFAULT_BYTES = 65_536;
const SHELL_OUTPUT_MAX_BYTES = 1_048_576;

function saivageDir(projectRoot: string): string { return join(projectRoot, '.saivage'); }
function getStore(ctx: ToolContext): CardStore { return ctx.store ?? new CardStore(ctx.projectRoot); }
function cardSummary(card: CardRecord) { return { id: card.id, title: card.title, type: card.type, status: card.status }; }
function normalizeParentValue(value: unknown): string | null | undefined { if (value === null) return null; if (typeof value !== 'string') return undefined; const trimmed = value.trim(); if (!trimmed) return undefined; if (trimmed.toLowerCase() === 'null') return null; return trimmed; }
function defaultParentForCreate(store: CardStore, type: CardType): string | null | undefined { if (type === 'project') return null; if (type === 'goal') return store.read('project') ? 'project' : undefined; const activeGoals = store.list().filter((card) => card.type === 'goal' && ['active', 'running', 'backlog', 'drafting', 'blocked'].includes(card.status)).sort((a, b) => a.priority - b.priority); if (activeGoals.length === 1) return activeGoals[0].id; const allGoals = store.list().filter((card) => card.type === 'goal').sort((a, b) => a.priority - b.priority); if (allGoals.length === 1) return allGoals[0].id; return store.read('project') ? 'project' : undefined; }
function summarizeShellCommand(command: string): string { return redactShellText(command).split(/\s+/).map((token) => { try { return isAnalystSecretPath(resolvePath(token)) ? '[SECRET_PATH]' : token; } catch { return token; } }).join(' ').slice(0, 200); }

export interface ToolContext { projectRoot: string; store?: CardStore; sessionId?: string; activeRuntime?: ActiveRuntime; actor: ActorRole; surface: ControlActionSurface; confirmedDestructive?: boolean; }


function buildDeletePreview(projectRoot: string, store: CardStore, id: string): ActionPreview { const card = store.read(id); if (!card) return { type: 'delete_card', summary: `Delete card '${id}' (card not found — no children to delete).`, affectedCards: [], affectedProcesses: [], warnings: [`Card '${id}' does not exist.`] }; const descendantIds = store.getDescendantIds(id); const allAffectedIds = [id, ...descendantIds]; return { type: 'delete_card', summary: `Delete card '${card.title}' (${card.id}) and all descendants (${allAffectedIds.length} total card(s)).`, affectedCards: allAffectedIds.map((cid) => { const c = store.read(cid); return c ? cardSummary(c) : { id: cid, title: '(not found)', type: 'unknown', status: 'unknown' }; }), affectedProcesses: listProcesses(projectRoot).filter((p) => allAffectedIds.includes(p.card_id)).map((p) => ({ id: p.id, command: p.command, status: p.status })), warnings: descendantIds.length > 0 ? [`This will permanently delete ${descendantIds.length} descendant card(s).`] : [] }; }
function buildAbortPreview(projectRoot: string, store: CardStore, goalId: string): ActionPreview { const goal = store.read(goalId); if (!goal) return { type: 'abort_goal', summary: `Abort goal '${goalId}' (goal not found).`, affectedCards: [], affectedProcesses: [], warnings: [`Goal card '${goalId}' does not exist.`] }; const descendantIds = store.getDescendantIds(goalId); const allAffectedIds = [goalId, ...descendantIds]; return { type: 'abort_goal', summary: `Abort goal '${goal.title}' (${goal.id}) and all descendants (${allAffectedIds.length} total card(s)).`, affectedCards: allAffectedIds.map((cid) => { const c = store.read(cid); return c ? cardSummary(c) : { id: cid, title: '(not found)', type: 'unknown', status: 'unknown' }; }), affectedProcesses: listProcesses(projectRoot).filter((p) => allAffectedIds.includes(p.card_id)).map((p) => ({ id: p.id, command: p.command, status: p.status })), warnings: [] }; }
function buildRestartGoalPreview(projectRoot: string, store: CardStore, goalId: string): ActionPreview { const goal = store.read(goalId); if (!goal) return { type: 'restart_goal', summary: `Restart goal '${goalId}' (goal not found).`, affectedCards: [], affectedProcesses: [], warnings: [`Goal card '${goalId}' does not exist.`] }; const descendantIds = store.getDescendantIds(goalId); const allAffectedIds = [goalId, ...descendantIds]; return { type: 'restart_goal', summary: `Restart goal '${goal.title}' (${goal.id}). Running children will be cancelled, plan diary cleared, goal re-queued.`, affectedCards: allAffectedIds.map((cid) => { const c = store.read(cid); return c ? cardSummary(c) : { id: cid, title: '(not found)', type: 'unknown', status: 'unknown' }; }), affectedProcesses: listProcesses(projectRoot).filter((p) => allAffectedIds.includes(p.card_id) && p.status === 'running').map((p) => ({ id: p.id, command: p.command, status: p.status })), warnings: ['The plan diary for this goal will be cleared.'] }; }

function redactShellText(value: string): string { return redactTextForOutbound(value, 'model.issue', { source: 'analyst-tools.shell' }); }
function summarizeShellOutcome(exitCode: number | null, truncated: boolean, timedOut: boolean): string { return timedOut ? 'command timed out' : `exit=${exitCode === null ? 'null' : String(exitCode)}${truncated ? ' truncated' : ''}`; }
function captureLimited(buffer: Buffer, limit: number): { text: string; truncated: boolean; truncatedBytes: number } { if (buffer.length <= limit) return { text: buffer.toString('utf8'), truncated: false, truncatedBytes: 0 }; const sliced = buffer.subarray(0, limit).toString('utf8'); const truncatedBytes = buffer.length - limit; return { text: `${sliced}\n[truncated ${truncatedBytes} bytes]`, truncated: true, truncatedBytes }; }
async function runShellCommandWithCapture(command: string, cwd: string, timeoutMs: number, maxOutputBytes: number): Promise<{ exitCode: number | null; durationMs: number; stdout: string; stderr: string; truncated: boolean; timedOut: boolean }> { return await new Promise((resolveResult) => { const startedAt = Date.now(); const child = spawn('bash', ['-lc', command], { cwd, env: sanitizedEnv(), timeout: timeoutMs, killSignal: 'SIGKILL' }); const stdoutChunks: Buffer[] = []; const stderrChunks: Buffer[] = []; let stdoutBytes = 0; let stderrBytes = 0; let timedOut = false; child.stdout.on('data', (chunk) => { const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk); if (stdoutBytes < maxOutputBytes) stdoutChunks.push(buf); stdoutBytes += buf.length; }); child.stderr.on('data', (chunk) => { const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk); if (stderrBytes < maxOutputBytes) stderrChunks.push(buf); stderrBytes += buf.length; }); child.on('error', (error) => { resolveResult({ exitCode: null, durationMs: Date.now() - startedAt, stdout: '', stderr: redactShellText(error.message), truncated: false, timedOut: false }); }); child.on('spawn', () => { if (child.stdin) child.stdin.end(); }); child.on('close', (code, signal) => { timedOut = signal === 'SIGKILL' && Date.now() - startedAt >= timeoutMs; const stdoutCapture = captureLimited(Buffer.concat(stdoutChunks), maxOutputBytes); const stderrCapture = captureLimited(Buffer.concat(stderrChunks), maxOutputBytes); resolveResult({ exitCode: timedOut ? null : code, durationMs: Date.now() - startedAt, stdout: redactShellText(stdoutCapture.text), stderr: redactShellText(stderrCapture.text || (timedOut ? `Command timed out after ${timeoutMs}ms.` : '')), truncated: stdoutCapture.truncated || stderrCapture.truncated || stdoutBytes > maxOutputBytes || stderrBytes > maxOutputBytes, timedOut }); }); }); }

function isFiniteNumber(value: unknown): value is number { return typeof value === 'number' && Number.isFinite(value); }
function normalizeShellCwd(projectRoot: string, cwd: unknown): string { if (cwd === undefined) return projectRoot; if (typeof cwd !== 'string') throw new Error('cwd must be a string when provided.'); const trimmed = cwd.trim(); if (!trimmed) return projectRoot; const resolved = resolvePath(trimmed); const rel = relative(projectRoot, resolved); if (rel !== '' && (rel === '..' || rel.startsWith('../') || rel.startsWith('..\\'))) throw new Error('cwd must stay within the project root.'); if (!existsSync(resolved) || !statSync(resolved).isDirectory()) throw new Error('cwd is not a readable directory within the project root.'); assertSafeShellCwd(resolved); return resolved; }
function normalizeShellNumeric(value: unknown, fallback: number, max: number, field: 'timeoutMs' | 'maxOutputBytes'): number { if (value === undefined) return fallback; if (!isFiniteNumber(value)) throw new Error(`${field} must be a finite number when provided.`); return Math.min(Math.max(1, Math.trunc(value)), max); }
function normalizeShellParams(ctx: ToolContext, params: ShellCommandParams): NormalizedShellCommandParams { if (params === null || typeof params !== 'object' || Array.isArray(params)) throw new Error('run_shell_command params must be an object.'); if (typeof params.command !== 'string' || params.command.trim().length === 0) throw new Error('command is required and must be a non-empty string.'); return { command: params.command, cwd: normalizeShellCwd(ctx.projectRoot, params.cwd), timeoutMs: normalizeShellNumeric(params.timeoutMs, SHELL_TIMEOUT_DEFAULT_MS, SHELL_TIMEOUT_MAX_MS, 'timeoutMs'), maxOutputBytes: normalizeShellNumeric(params.maxOutputBytes, SHELL_OUTPUT_DEFAULT_BYTES, SHELL_OUTPUT_MAX_BYTES, 'maxOutputBytes') }; }


export async function mark_goal_needs_corrections(ctx: ToolContext, params: { goalId: string; issues: unknown[]; note?: string }): Promise<ToolResult> { return runAuditedAnalystTool(ctx, params, { action: 'goal.needs_corrections', safety_class: 'high', target_kind: 'card', getTargetId: (p) => p.goalId, run: async () => { try { const issues = normalizeAnalystIssues(params.issues); return { success: true, data: markGoalNeedsCorrections(ctx.projectRoot, params.goalId, issues, params.note) }; } catch (err) { return { success: false, error: err instanceof Error ? err.message : String(err) }; } } }); }

export async function create_card(ctx: ToolContext, params: { type: CardType; parent: string | null; title: string; description: string; status?: CardStatus; tags?: string[]; priority?: number; urgency?: 'low' | 'normal' | 'high' | 'critical'; acceptance?: string; depends_on?: string[]; related?: string[]; id?: string; }): Promise<ToolResult> { return runAuditedAnalystTool(ctx, params, { action: 'card.create', safety_class: 'low', target_kind: 'card', getTargetId: (p) => p.id ?? null, run: async () => { try { const typeCheck = preflightEnum(params.type, CARD_TYPE_VALUES, 'type', 'create_card'); if (!typeCheck.ok) return { success: false, error: typeCheck.error }; const statusCheck = preflightEnum(params.status, CARD_STATUS_VALUES, 'status', 'create_card'); if (!statusCheck.ok) return { success: false, error: statusCheck.error }; const urgencyCheck = preflightEnum(params.urgency, URGENCY_VALUES, 'urgency', 'create_card'); if (!urgencyCheck.ok) return { success: false, error: urgencyCheck.error }; const store = getStore(ctx); const parent = normalizeParentValue(params.parent) ?? defaultParentForCreate(store, params.type); if (parent === undefined) return { success: false, error: `Cannot create ${params.type} card without a parent. Inspect the card tree and provide an existing parent ID.` }; if (parent !== null && !store.read(parent)) return { success: false, error: `Parent card '${parent}' does not exist.` }; const card = store.create({ type: params.type, parent, depth: 0, title: params.title, description: params.description, status: params.status ?? 'drafting', tags: params.tags ?? [], priority: params.priority ?? 0, urgency: params.urgency ?? 'normal', created_by: 'analyst', acceptance: params.acceptance ?? '', depends_on: params.depends_on ?? [], related: params.related ?? [], blocks: [], artifacts: [], attachments: [], retries: 0, ...(params.id ? { id: params.id } : {}) }); return { success: true, data: card }; } catch (err) { return { success: false, error: humanizeToolError('create_card', err instanceof Error ? err.message : String(err)) }; } } }); }

const ALLOWED_EDIT_FIELDS = new Set(['title','description','status','tags','priority','urgency','acceptance','depends_on','related','estimate','subtype','assigned_to','result','metrics','started_at','completed_at','duration_ms','error','parent','type','instructions_file','attachments','artifacts']);
export async function edit_card(ctx: ToolContext, params: { id: string } & Record<string, unknown>): Promise<ToolResult> { return runAuditedAnalystTool(ctx, params, { action: 'card.update', safety_class: 'high', target_kind: 'card', getTargetId: (p) => p.id, preview: () => ({ type: 'edit_card', summary: `Edit card '${params.id}'.`, affectedCards: getStore(ctx).read(params.id) ? [cardSummary(getStore(ctx).read(params.id)!)] : [], affectedProcesses: [], warnings: [] }), run: async () => { try { const statusCheck = preflightEnum(params.status, CARD_STATUS_VALUES, 'status', 'edit_card'); if (!statusCheck.ok) return { success: false, error: statusCheck.error }; const urgencyCheck = preflightEnum(params.urgency, URGENCY_VALUES, 'urgency', 'edit_card'); if (!urgencyCheck.ok) return { success: false, error: urgencyCheck.error }; const typeCheck = preflightEnum(params.type, CARD_TYPE_VALUES, 'type', 'edit_card'); if (!typeCheck.ok) return { success: false, error: typeCheck.error }; const store = getStore(ctx); const card = store.read(params.id); if (!card) return { success: false, error: `Card '${params.id}' not found.` }; const changes: Record<string, unknown> = {}; const rejected: string[] = []; for (const [key, value] of Object.entries(params)) { if (key === 'id' || key === '__obsolete_confirmed_preview_hash__') continue; if (ALLOWED_EDIT_FIELDS.has(key)) changes[key] = value; else rejected.push(key); } if (Object.keys(changes).length === 0) return { success: false, error: `edit_card failed: no allowed fields to update. Rejected fields: ${rejected.join(', ') || '(none)'}. Allowed fields include: ${Array.from(ALLOWED_EDIT_FIELDS).join(', ')}. See the 'edit_card' tool's parameter schema.` }; const updated = store.mutateCard(params.id, changes as Partial<CardRecord>, { actor: ctx.actor, surface: ctx.surface, reason: 'analyst edit' }); try { notifyPlannerOfAnalystAction(ctx.projectRoot, params.id, `analyst edited card fields: ${Object.keys(changes).join(', ')}`); } catch { void 0; } return { success: true, data: updated }; } catch (err) { return { success: false, error: humanizeToolError('edit_card', err instanceof Error ? err.message : String(err)) }; } } }); }
export async function move_card(ctx: ToolContext, params: { id: string; newParent: string | null }): Promise<ToolResult> { return runAuditedAnalystTool(ctx, params, { action: 'card.move', safety_class: 'high', target_kind: 'card', getTargetId: (p) => p.id, preview: () => ({ type: 'move_card', summary: `Move card '${params.id}'.`, affectedCards: getStore(ctx).read(params.id) ? [cardSummary(getStore(ctx).read(params.id)!)] : [], affectedProcesses: [], warnings: [] }), run: async () => { try { const store = getStore(ctx); const card = store.read(params.id); if (!card) return { success: false, error: `Card '${params.id}' not found.` }; if (params.newParent !== null) { if (params.newParent === params.id) return { success: false, error: 'Cannot set a card as its own parent.' }; if (store.getDescendantIds(params.id).includes(params.newParent)) return { success: false, error: `Cannot move card under its own descendant '${params.newParent}'.` }; } const updated = store.mutateCard(params.id, { parent: params.newParent }, { actor: ctx.actor, surface: ctx.surface, reason: 'card moved' }); return { success: true, data: updated }; } catch (err) { return { success: false, error: err instanceof Error ? err.message : String(err) }; } } }); }
export async function delete_card(ctx: ToolContext, params: { ids: string[] }): Promise<ToolResult> { return runAuditedAnalystTool(ctx, params, { action: 'card.delete', safety_class: 'destructive', target_kind: 'card', getTargetId: (p) => p.ids.join(','), preview: () => { const store = getStore(ctx); const previews = params.ids.map((id) => buildDeletePreview(ctx.projectRoot, store, id)); return { type: 'delete_card', summary: `Delete ${params.ids.length} card target(s) and their descendants.`, affectedCards: previews.flatMap((preview) => preview.affectedCards), affectedProcesses: previews.flatMap((preview) => preview.affectedProcesses), warnings: previews.flatMap((preview) => preview.warnings) }; }, run: async () => { const store = getStore(ctx); const sd = saivageDir(ctx.projectRoot); const deletedTopLevel: string[] = []; const deletedAll: string[] = []; const failures: Array<{ id: string; reason: string }> = []; for (const targetId of params.ids) { try { const card = store.read(targetId); if (!card) { failures.push({ id: targetId, reason: `Card '${targetId}' not found.` }); continue; } const cards = [targetId, ...store.getDescendantIds(targetId)].map((id) => store.read(id)).filter((c): c is CardRecord => c !== null).sort((a, b) => b.depth - a.depth); const denied = cards.find((c) => !decide({ role: 'analyst', action: 'card.delete', targetState: c.status }).allowed); if (denied) { const decision = decide({ role: 'analyst', action: 'card.delete', targetState: denied.status }); failures.push({ id: targetId, reason: `delete_card denied by permission matrix for card '${denied.id}' in state '${denied.status}' (${decision.allowed ? 'not_allowed' : decision.reason}).` }); continue; } for (const c of cards) { try { deleteAllNotes(sd, c.id); } catch { void 0; } store.delete(c.id); deletedAll.push(c.id); } deletedTopLevel.push(targetId); } catch (err) { failures.push({ id: targetId, reason: err instanceof Error ? err.message : String(err) }); } } if (deletedTopLevel.length > 0 && failures.length > 0) return { success: true, data: { partial: true, total: params.ids.length, succeeded: deletedTopLevel.length, failures } }; if (failures.length > 0) return { success: false, error: failures.map((failure) => `${failure.id}: ${failure.reason}`).join('; '), data: { failures } }; return { success: true, data: { deleted: deletedAll, top_level_deleted: deletedTopLevel } }; } }); }
export async function list_cards(ctx: ToolContext, params: { status?: CardStatus | CardStatus[]; type?: CardType | CardType[]; parent?: string; tag?: string; }): Promise<ToolResult> { try { const store = getStore(ctx); let cards = store.list(); if (params.status) { const statuses = Array.isArray(params.status) ? params.status : [params.status]; cards = cards.filter((c) => statuses.includes(c.status)); } if (params.type) { const types = Array.isArray(params.type) ? params.type : [params.type]; cards = cards.filter((c) => types.includes(c.type)); } if (params.parent !== undefined) cards = params.parent === null ? cards.filter((c) => c.parent === null) : cards.filter((c) => store.listChildren(params.parent!).includes(c.id)); if (params.tag) cards = cards.filter((c) => c.tags.includes(params.tag!)); return { success: true, data: cards.map((c) => ({ id: c.id, type: c.type, title: c.title, status: c.status, priority: c.priority, parent: c.parent, tags: c.tags })) }; } catch (err) { return { success: false, error: err instanceof Error ? err.message : String(err) }; } }
export async function get_card(ctx: ToolContext, params: { id: string }): Promise<ToolResult> { try { const store = getStore(ctx); const card = store.read(params.id); if (!card) return { success: false, error: `Card '${params.id}' not found.` }; const notes = getNotes(saivageDir(ctx.projectRoot), params.id); const children = store.listChildren(params.id).map((cid) => store.read(cid)).filter((c): c is CardRecord => c !== null).map(cardSummary); return { success: true, data: { ...card, notes, children } }; } catch (err) { return { success: false, error: err instanceof Error ? err.message : String(err) }; } }
interface TreeNode { id: string; type: string; title: string; status: string; children: TreeNode[]; }
function buildNode(store: CardStore, id: string): TreeNode | null { const card = store.read(id); if (!card) return null; return { id: card.id, type: card.type, title: card.title, status: card.status, children: store.listChildren(id).map((cid) => buildNode(store, cid)).filter((n): n is TreeNode => n !== null) }; }
export async function get_tree(ctx: ToolContext, params: { rootId?: string }): Promise<ToolResult> { try { const store = getStore(ctx); const rootId = params.rootId ?? 'project'; if (!store.read(rootId)) return { success: false, error: `Root card '${rootId}' not found.` }; const tree = buildNode(store, rootId); if (!tree) return { success: false, error: `Failed to build tree from '${rootId}'.` }; return { success: true, data: tree }; } catch (err) { return { success: false, error: err instanceof Error ? err.message : String(err) }; } }
export async function get_plan_diary(ctx: ToolContext, params: { goalId: string }): Promise<ToolResult> { try { const store = getStore(ctx); const goal = store.read(params.goalId); if (!goal || (goal.type !== 'goal' && goal.type !== 'project')) return { success: false, error: `Goal '${params.goalId}' not found.` }; return { success: true, data: getDiaryEntries(saivageDir(ctx.projectRoot), params.goalId) }; } catch (err) { return { success: false, error: err instanceof Error ? err.message : String(err) }; } }
export async function get_card_output(ctx: ToolContext, params: { cardId: string; lines?: number; processId?: string; }): Promise<ToolResult> { try { const store = getStore(ctx); if (!store.read(params.cardId)) return { success: false, error: `Card '${params.cardId}' not found.` }; const numLines = params.lines ?? 50; if (params.processId) { const proc = getProcess(ctx.projectRoot, params.processId); if (!proc) return { success: false, error: `Process '${params.processId}' not found.` }; if (proc.card_id !== params.cardId) return { success: false, error: `Process '${params.processId}' is not associated with card '${params.cardId}'.` }; return { success: true, data: { process: { id: proc.id, command: proc.command, status: proc.status, pid: proc.pid }, output: tailOutput(ctx.projectRoot, params.processId, numLines) } }; } return { success: true, data: listProcesses(ctx.projectRoot, { cardId: params.cardId }).map((proc) => ({ id: proc.id, command: proc.command, status: proc.status, pid: proc.pid, started_at: proc.started_at, completed_at: proc.completed_at, exit_code: proc.exit_code, output: tailOutput(ctx.projectRoot, proc.id, numLines) })) }; } catch (err) { return { success: false, error: err instanceof Error ? err.message : String(err) }; } }
export async function get_status(ctx: ToolContext, _params: Record<string, never>): Promise<ToolResult> { try { const store = getStore(ctx); const runtimeState = readRuntimeState(ctx.projectRoot); const allCards = store.list(); const runningProcesses = listProcesses(ctx.projectRoot).filter((p) => p.status === 'running'); const plannerStateCounts = allCards.reduce<Record<string, number>>((counts, card) => { counts[card.status] = (counts[card.status] ?? 0) + 1; return counts; }, {}); const activeCardRun = runtimeState?.active_card_run ?? null; const runtimeIntent = runtimeState?.runtime_intent ?? null; const runtimeRuns = runtimeState?.runtime_runs ?? []; const activationRecords = runtimeState?.runtime_activations ?? []; return { success: true, data: { runtime: runtimeState, runtimeSummary: { status: runtimeState?.status ?? 'unknown', paused: runtimeState?.paused ?? false, currentCardId: runtimeState?.current_card_id ?? null, activeCardRun, runtimeIntent, projectRuns: runtimeRuns.map((run) => ({ run_id: run.run_id, kind: run.kind, card_id: run.card_id, phase: run.phase, runtime_status: run.runtime_status, started_at: run.started_at, finished_at: run.finished_at ?? null })), activations: activationRecords.map((activation) => ({ activation_id: activation.activation_id, parent_card_id: activation.parent_card_id, child_card_id: activation.child_card_id, status: activation.status, requested_at: activation.requested_at, runtime_run_id: activation.runtime_run_id ?? null })) }, runningProcesses: runningProcesses.length, plannerStateCounts, counts: { done: plannerStateCounts.done ?? 0, failed: plannerStateCounts.failed ?? 0, blocked: plannerStateCounts.blocked ?? 0, total: allCards.length } } }; } catch (err) { return { success: false, error: err instanceof Error ? err.message : String(err) }; } }

export async function list_card_history(ctx: ToolContext, params: { cardId: string }): Promise<ToolResult> { try { const store = getStore(ctx); if (!store.read(params.cardId)) return { success: false, error: `Card '${params.cardId}' not found.` }; const entries = store.listCardHistory(params.cardId).map((entry) => ({ card_id: entry.card_id, version_seq: entry.version_seq, changed_at: entry.changed_at, changed_by_actor: entry.changed_by_actor, changed_by_surface: entry.changed_by_surface, change_reason: entry.change_reason, changed_fields: entry.changed_fields, change_summary: entry.change_summary })); return { success: true, data: entries }; } catch (err) { return { success: false, error: err instanceof Error ? err.message : String(err) }; } }
export async function get_card_history_entry(ctx: ToolContext, params: { cardId: string; version_seq: number }): Promise<ToolResult> { try { const store = getStore(ctx); const entry = store.listCardHistory(params.cardId).find((candidate) => candidate.version_seq === params.version_seq); if (!entry) return { success: false, error: `Card '${params.cardId}' has no history entry for version ${params.version_seq}.` }; return { success: true, data: entry }; } catch (err) { return { success: false, error: err instanceof Error ? err.message : String(err) }; } }
export async function diff_card(ctx: ToolContext, params: { cardId: string; fromSeq?: number; toSeq?: number }): Promise<ToolResult> { try { const store = getStore(ctx); const card = store.read(params.cardId); if (!card) return { success: false, error: `Card '${params.cardId}' not found.` }; const toSeq = params.toSeq ?? card.version_seq; const fromSeq = params.fromSeq ?? Math.max(1, toSeq - 1); return { success: true, data: { card_id: params.cardId, from_version_seq: fromSeq, to_version_seq: toSeq, diff: store.diffCard(params.cardId, fromSeq, toSeq) } }; } catch (err) { return { success: false, error: err instanceof Error ? err.message : String(err) }; } }

export async function start_project(ctx: ToolContext, params: Record<string, never> = {}): Promise<ToolResult> { return runAuditedAnalystTool(ctx, params, { action: 'runtime.start_project', safety_class: 'low', target_kind: 'runtime', getTargetId: () => 'project', run: async () => { if (!ctx.activeRuntime) return { success: false, error: 'Active runtime is not available.' }; const data = await ctx.activeRuntime.runtime.startProject('analyst'); return { success: data.success, ...(data.success ? { data } : { error: data.error.message, data }) }; } }); }

export async function stop_project(ctx: ToolContext, params: Record<string, never> = {}): Promise<ToolResult> { return runAuditedAnalystTool(ctx, params, { action: 'runtime.stop_project', safety_class: 'destructive', target_kind: 'runtime', getTargetId: () => 'project', run: async () => { if (!ctx.activeRuntime) return { success: false, error: 'Active runtime is not available.' }; const data = await ctx.activeRuntime.runtime.stopProject('analyst'); return { success: true, data }; } }); }

export async function terminate_process(ctx: ToolContext, params: { processId: string }): Promise<ToolResult> { return runAuditedAnalystTool(ctx, params, { action: 'process.terminate', safety_class: 'destructive', target_kind: 'process', getTargetId: (p) => p.processId, run: async () => { const proc = await killProcess(ctx.projectRoot, params.processId, 'SIGTERM'); if (!proc) return { success: false, error: `Process '${params.processId}' not found.` }; return { success: true, data: proc }; } }); }
export async function pause_runtime(ctx: ToolContext, params: Record<string, never> = {}): Promise<ToolResult> { return runAuditedAnalystTool(ctx, params, { action: 'runtime.pause', safety_class: 'low', target_kind: 'runtime', getTargetId: () => 'project', run: async () => { const result = pauseRuntimeControl({ projectRoot: ctx.projectRoot, activeRuntime: ctx.activeRuntime }); if (!result.ok) return { success: false, error: result.message ?? result.error ?? 'Failed to pause runtime' }; return { success: true, data: { status: result.status, paused: result.paused } }; } }); }
export async function resume_runtime(ctx: ToolContext, params: Record<string, never> = {}): Promise<ToolResult> { return runAuditedAnalystTool(ctx, params, { action: 'runtime.resume', safety_class: 'low', target_kind: 'runtime', getTargetId: () => 'project', run: async () => { const state = readRuntimeState(ctx.projectRoot); if (state?.status === 'frozen' || state?.status === 'error') return { success: false, error: `${state.status === 'frozen' ? RESUME_FROM_FREEZE_MESSAGE : 'Runtime is in error state. Use resume-from-freeze after correcting the frozen/error condition.'}` }; const result = resumeRuntimeControl({ projectRoot: ctx.projectRoot, activeRuntime: ctx.activeRuntime }); if (!result.ok) return { success: false, error: result.message ?? result.error ?? 'Failed to resume runtime' }; return { success: true, data: { status: result.status, paused: result.paused } }; } }); }
export async function abort_goal_subtree(ctx: ToolContext, params: { goalId: string }): Promise<ToolResult> { return runAuditedAnalystTool(ctx, params, { action: 'goal.abort', safety_class: 'destructive', target_kind: 'card', getTargetId: (p) => p.goalId, preview: () => buildAbortPreview(ctx.projectRoot, getStore(ctx), params.goalId), run: async () => { const store = getStore(ctx); try { const goal = store.read(params.goalId); if (!goal) return { success: false, error: `Goal '${params.goalId}' not found.` }; const cancelled: string[] = []; for (const id of [params.goalId, ...store.getDescendantIds(params.goalId)]) { try { store.setStatus(id, 'cancelled'); cancelled.push(id); } catch { void 0; } } return { success: true, data: { cancelled } }; } catch (err) { return { success: false, error: err instanceof Error ? err.message : String(err) }; } } }); }
export async function restart_card_or_subtree(ctx: ToolContext, params: { id: string }): Promise<ToolResult> { return runAuditedAnalystTool(ctx, params, { action: 'card.restart', safety_class: 'destructive', target_kind: 'card', getTargetId: (p) => p.id, preview: () => { const store = getStore(ctx); const card = store.read(params.id); return card ? { type: 'restart_card', summary: `Restart card '${card.title}' (${card.id}) — will be moved to backlog.`, affectedCards: [cardSummary(card)], affectedProcesses: [], warnings: ['Card result and error will be cleared.'] } : { type: 'restart_card', summary: `Restart card '${params.id}'.`, affectedCards: [], affectedProcesses: [], warnings: [] }; }, run: async () => { const store = getStore(ctx); try { const card = store.read(params.id); if (!card) return { success: false, error: `Card '${params.id}' not found.` }; if (card.type === 'goal' || card.type === 'project') return restart_goal(ctx, { goalId: params.id }); if (!decide({ role: 'analyst', action: 'card.restart', targetState: card.status }).allowed) return { success: false, error: `Card '${params.id}' has status '${card.status}'. Only matrix-allowed states can be restarted by analyst.` }; return { success: true, data: store.update(params.id, { status: 'backlog', result: null, error: null, completed_at: null }) }; } catch (err) { return { success: false, error: err instanceof Error ? err.message : String(err) }; } } }); }
export async function restart_goal(ctx: ToolContext, params: { goalId: string }): Promise<ToolResult> { return runAuditedAnalystTool(ctx, params, { action: 'goal.restart', safety_class: 'destructive', target_kind: 'card', getTargetId: (p) => p.goalId, preview: () => buildRestartGoalPreview(ctx.projectRoot, getStore(ctx), params.goalId), run: async () => { const store = getStore(ctx); try { const goal = store.read(params.goalId); if (!goal) return { success: false, error: `Goal '${params.goalId}' not found.` }; for (const id of store.getDescendantIds(params.goalId)) { try { const child = store.read(id); if (child && (child.status === 'running' || child.status === 'active')) store.setStatus(id, 'cancelled'); } catch { void 0; } } try { deleteDiary(saivageDir(ctx.projectRoot), params.goalId); } catch { void 0; } store.update(params.goalId, { status: 'backlog', result: null, error: null, completed_at: null }); return { success: true, data: { goalId: params.goalId, status: 'backlog', descendantIds: store.getDescendantIds(params.goalId) } }; } catch (err) { return { success: false, error: err instanceof Error ? err.message : String(err) }; } } }); }


export async function queue_notification(_ctx: ToolContext, params: { recipient: string; kind: string; body: string }): Promise<ToolResult> { return { success: false, data: { reason: 'not_yet_available', stage_owner: 'S04', recipient: params.recipient } }; }

export async function reorder_child(_ctx: ToolContext, params: { parentId: string; orderedChildIds: string[] }): Promise<ToolResult> { return { success: false, data: { reason: 'not_yet_available', stage_owner: 'S03', parent_id: params.parentId } }; }

export async function navigate_workspace(_ctx: ToolContext, params: { target: { kind: 'card' | 'transcript' | 'process' | 'plan_diary' | 'process_list' | 'agent_session_list' | 'config'; id?: string; refinement?: string } }): Promise<ToolResult> { return { success: true, data: { navigated_to: params.target } }; }

export async function navigate_back(_ctx: ToolContext, _params: Record<string, never> = {}): Promise<ToolResult> { return { success: true, data: { navigated_back: true } }; }

export async function show_config(ctx: ToolContext, _params: Record<string, never> = {}): Promise<ToolResult> { try { const path = join(ctx.projectRoot, '.saivage', 'saivage.json'); assertAnalystInspectionTarget(path); const result = getRedactedConfig(ctx.projectRoot); if (!result.success) return { success: false, data: { reason: 'invalid_argument', fieldPath: result.fieldPath, detail: result.message } }; return { success: true, data: { config: redactAnalystSecretValue(result.config) } }; } catch (err) { return { success: false, error: err instanceof Error ? err.message : String(err) }; } }

export async function restart_server(ctx: ToolContext, params: Record<string, never> = {}): Promise<ToolResult> { return runAuditedAnalystTool(ctx, params, { action: 'runtime.restart_server', safety_class: 'destructive', target_kind: 'runtime', getTargetId: () => 'server', run: async () => { if (!ctx.activeRuntime?.server) return { success: false, error: 'Server restart primitive is not available.' }; await ctx.activeRuntime.server.requestRestart(); return { success: true, data: { restart_requested: true } }; } }); }

type ReconfigureParams = { action: 'set_role_routing' | 'set_failover_order' | 'mcp_add' | 'mcp_edit' | 'mcp_remove' | 'set_runtime_setting' | 'set_server_setting'; role?: string; model_candidate?: string; ordered_providers?: string[]; name?: string; command?: string; args?: string[]; env?: Record<string, string>; key?: string; value?: unknown };

export async function reconfigure(ctx: ToolContext, params: ReconfigureParams): Promise<ToolResult> {
  const actionName = `reconfigure.${params.action.replace(/^set_/, 'set_')}`;
  const targetKind = 'config';
  const targetId = () => params.name ?? params.role ?? params.key ?? params.action;
  return runAuditedAnalystTool(ctx, params as ReconfigureParams & Record<string, unknown>, { action: actionName, safety_class: 'low', target_kind: targetKind, getTargetId: targetId, run: async () => {
    const invalid = (fieldPath: string, detail: string): ToolResult => ({ success: false, data: { reason: 'invalid_argument', fieldPath, detail }, error: detail });
    let result;
    switch (params.action) {
      case 'set_role_routing': result = setRoleRouting(ctx.projectRoot, params.role!, params.model_candidate!); break;
      case 'set_failover_order': result = setFailoverOrder(ctx.projectRoot, params.role!, params.ordered_providers!); break;
      case 'mcp_add':
        result = mcpAdd(ctx.projectRoot, params.name!, params.command!, params.args, params.env);
        if (result.success) { ctx.activeRuntime?.mcpManager?.reloadServersFromConfig(); await ctx.activeRuntime?.mcpManager?.startServer(params.name!); }
        break;
      case 'mcp_edit':
        result = mcpEdit(ctx.projectRoot, params.name!, { command: params.command, args: params.args, env: params.env });
        if (result.success) { ctx.activeRuntime?.mcpManager?.reloadServersFromConfig(); await ctx.activeRuntime?.mcpManager?.restartServer(params.name!); }
        break;
      case 'mcp_remove':
        await ctx.activeRuntime?.mcpManager?.stopServer(params.name!);
        result = mcpRemove(ctx.projectRoot, params.name!);
        if (result.success) ctx.activeRuntime?.mcpManager?.reloadServersFromConfig();
        break;
      case 'set_runtime_setting': result = setRuntimeSetting(ctx.projectRoot, params.key!, params.value); break;
      case 'set_server_setting': result = setServerSetting(ctx.projectRoot, params.key!, params.value); break;
      default: return invalid('action', 'Unknown reconfigure action.');
    }
    if (!result.success) return invalid(result.fieldPath, result.message);
    if (params.action === 'set_server_setting' && result.requires_restart) return { success: true, data: { applied: true, requires_restart: true, key: params.key } };
    return { success: true, data: { applied: true, action: params.action } };
  } });
}

const FILE_READ_MAX_BYTES = 1_000_000;
const FILE_READ_DEFAULT_BYTES = 200_000;
const LIST_DIR_DEFAULT_ENTRIES = 500;
const JSONL_TAIL_DEFAULT = 50;
const JSONL_TAIL_MAX = 1000;

function isBinarySample(buf: Buffer): boolean {
  if (buf.length === 0) return false;
  let suspicious = 0;
  const sample = Math.min(buf.length, 1024);
  for (let i = 0; i < sample; i += 1) {
    const b = buf[i];
    if (b === 0) return true;
    if (b < 7 || (b > 14 && b < 32)) suspicious += 1;
  }
  return suspicious / sample > 0.3;
}

export async function run_shell_command(ctx: ToolContext, params: ShellCommandParams): Promise<ToolResult> {
  try {
    if (ctx.surface === 'telegram') return { success: false, error: 'run_shell_command is not available on Telegram.' };
    const normalized = normalizeShellParams(ctx, params);
    const classifiedAs = classifyShellCommand(normalized.command, normalized.cwd);
    const verdict = evaluateAuthz({ actor: ctx.actor, surface: ctx.surface, safety_class: classifiedAs });
    const auditBase = { actor: ctx.actor, surface: ctx.surface, action: 'shell.exec', target_kind: null, target_id: null, params_summary: `shell.exec [classified=${classifiedAs}] ${summarizeShellCommand(normalized.command)}`, confirmed: true };
    if (verdict === 'deny') {
      recordControlAction(ctx.projectRoot, { ...auditBase, outcome: 'denied', outcome_summary: `shell denied [classified=${classifiedAs}]` });
      return { success: false, error: `Denied by authorization policy for ${ctx.actor}/${ctx.surface}/${classifiedAs}.`, data: { classified_as: classifiedAs } };
    }
    if (verdict === 'preview_only') {
      recordControlAction(ctx.projectRoot, { ...auditBase, outcome: 'rejected', outcome_summary: `shell preview confirmation removed [classified=${classifiedAs}]` });
      return { success: false, error: `Shell command requires an authorized surface for ${ctx.actor}/${ctx.surface}/${classifiedAs}; confirmed/preview_hash is no longer accepted.`, data: { classified_as: classifiedAs } };
    }
    const result = await runShellCommandWithCapture(normalized.command, normalized.cwd, normalized.timeoutMs, normalized.maxOutputBytes);
    const payload = { classified_as: classifiedAs, exit_code: result.exitCode, duration_ms: result.durationMs, stdout: result.stdout, stderr: result.stderr, truncated: result.truncated, cwd: normalized.cwd, command: redactShellText(normalized.command) };
    if (classifiedAs !== 'read_only') {
      recordControlAction(ctx.projectRoot, { ...auditBase, outcome: result.exitCode === 0 && !result.timedOut ? 'ok' : 'error', outcome_summary: `${summarizeShellOutcome(result.exitCode, result.truncated, result.timedOut)} stdout=${result.stdout} stderr=${result.stderr}`.slice(0, 2000), ...(result.exitCode === 0 && !result.timedOut ? {} : { error: result.stderr || `shell command failed: ${summarizeShellOutcome(result.exitCode, result.truncated, result.timedOut)}` }) });
    }
    if (result.timedOut) return { success: false, error: `Command timed out after ${normalized.timeoutMs}ms.`, data: payload };
    return { success: result.exitCode === 0, ...(result.exitCode === 0 ? { data: payload } : { error: result.stderr || `Command exited with code ${result.exitCode}`, data: payload }) };
  } catch (err) {
    if (err instanceof SecretPathError) return { success: false, error: 'Access denied: secret-bearing path is off-limits ([SECRET_PATH]). Use safer inspection paths that do not touch secrets.' };
    return { success: false, error: err instanceof Error ? redactShellText(err.message).replaceAll(ctx.projectRoot, '[PROJECT_ROOT]') : String(err) };
  }
}

export async function read_file(_ctx: ToolContext, params: { path: string; maxBytes?: number }): Promise<ToolResult> {
  try {
    if (typeof params.path !== 'string' || params.path.length === 0) return { success: false, error: 'path is required.' };
    const abs = resolvePath(params.path);
    assertAnalystInspectionTarget(abs);
    if (!existsSync(abs)) return { success: false, error: `Path not found: ${abs}` };
    const st = statSync(abs);
    if (st.isDirectory()) return { success: false, error: `Path is a directory; use list_directory instead: ${abs}` };
    if (!st.isFile()) return { success: false, error: `Path is not a regular file: ${abs}` };
    const cap = Math.min(Math.max(1, params.maxBytes ?? FILE_READ_DEFAULT_BYTES), FILE_READ_MAX_BYTES);
    const buf = readFileSync(abs);
    const truncated = buf.length > cap;
    const sliced = truncated ? buf.subarray(0, cap) : buf;
    if (isBinarySample(sliced)) {
      return { success: true, data: { path: abs, size: st.size, binary: true, content: null, truncated, modified_at: st.mtime.toISOString() } };
    }
    return { success: true, data: { path: abs, size: st.size, binary: false, truncated, bytes_returned: sliced.length, content: sliced.toString('utf-8'), modified_at: st.mtime.toISOString() } };
  } catch (err) {
    if (err instanceof SecretPathError) return { success: false, error: err.message };
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function list_directory(_ctx: ToolContext, params: { path: string; maxEntries?: number }): Promise<ToolResult> {
  try {
    if (typeof params.path !== 'string' || params.path.length === 0) return { success: false, error: 'path is required.' };
    const abs = resolvePath(params.path);
    assertAnalystInspectionTarget(abs);
    if (!existsSync(abs)) return { success: false, error: `Path not found: ${abs}` };
    const st = statSync(abs);
    if (!st.isDirectory()) return { success: false, error: `Path is not a directory: ${abs}` };
    const cap = Math.min(Math.max(1, params.maxEntries ?? LIST_DIR_DEFAULT_ENTRIES), 5000);
    const names = readdirSync(abs).sort();
    const truncated = names.length > cap;
    const slice = truncated ? names.slice(0, cap) : names;
    const entries: Array<Record<string, unknown>> = [];
    let redactedCount = 0;
    for (const name of slice) {
      const child = join(abs, name);
      if (isAnalystSecretPath(child)) {
        redactedCount += 1;
        continue;
      }
      try {
        const ls = lstatSync(child);
        const symlink = ls.isSymbolicLink();
        const cs = symlink ? statSync(child) : ls;
        entries.push({ name, type: cs.isDirectory() ? 'directory' : cs.isFile() ? 'file' : 'other', size: cs.isFile() ? cs.size : undefined, symlink, modified_at: cs.mtime.toISOString() });
      } catch (err) {
        entries.push({ name, type: 'unreadable', error: err instanceof Error ? err.message : String(err) });
      }
    }
    if (redactedCount > 0) entries.push({ name: '<redacted>', count: redactedCount });
    return { success: true, data: { path: abs, total_entries: names.length, truncated, redacted_count: redactedCount, entries } };
  } catch (err) {
    if (err instanceof SecretPathError) return { success: false, error: err.message };
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

function readJsonlTail(path: string, limit: number): { entries: unknown[]; total: number } {
  if (!existsSync(path)) return { entries: [], total: 0 };
  const raw = readFileSync(path, 'utf-8');
  const lines = raw.split('\n').filter((line) => line.trim() !== '');
  const tail = lines.slice(-limit);
  const entries: unknown[] = [];
  for (const line of tail) {
    try { entries.push(JSON.parse(line)); } catch { void 0;}
  }
  return { entries, total: lines.length };
}

export async function read_runtime_events(ctx: ToolContext, params: { limit?: number; kind?: string }): Promise<ToolResult> {
  try {
    const limit = Math.min(Math.max(1, params.limit ?? JSONL_TAIL_DEFAULT), JSONL_TAIL_MAX);
    const { entries, total } = readJsonlTail(join(ctx.projectRoot, '.saivage', 'runtime', 'events.jsonl'), limit);
    const filtered = params.kind ? entries.filter((e) => typeof e === 'object' && e !== null && (e as Record<string, unknown>)['kind'] === params.kind) : entries;
    return { success: true, data: { total_lines: total, returned: filtered.length, events: filtered } };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function read_runtime_errors(ctx: ToolContext, params: { limit?: number }): Promise<ToolResult> {
  try {
    const limit = Math.min(Math.max(1, params.limit ?? JSONL_TAIL_DEFAULT), JSONL_TAIL_MAX);
    const { entries, total } = readJsonlTail(join(ctx.projectRoot, '.saivage', 'runtime', 'errors.jsonl'), limit);
    return { success: true, data: { total_lines: total, returned: entries.length, errors: entries } };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function read_control_actions(ctx: ToolContext, params: { limit?: number; since?: string }): Promise<ToolResult> {
  try {
    const limit = Math.min(Math.max(1, params.limit ?? JSONL_TAIL_DEFAULT), JSONL_TAIL_MAX);
    const all = listControlActions(ctx.projectRoot, params.since ? { since: params.since } : undefined);
    const tail = all.slice(-limit);
    return { success: true, data: { total_lines: all.length, returned: tail.length, actions: tail } };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function list_processes_tool(ctx: ToolContext, params: { status?: string; cardId?: string }): Promise<ToolResult> {
  try {
    const procs = listProcesses(ctx.projectRoot, params.cardId ? { cardId: params.cardId } : undefined);
    const filtered = params.status ? procs.filter((p) => p.status === params.status) : procs;
    return { success: true, data: filtered.map((p) => ({ id: p.id, command: p.command, card_id: p.card_id, status: p.status, pid: p.pid, started_at: p.started_at, completed_at: p.completed_at, exit_code: p.exit_code })) };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function list_agent_sessions(ctx: ToolContext, _params: Record<string, never>): Promise<ToolResult> {
  try {
    const dir = join(ctx.projectRoot, '.saivage', 'agents', 'sessions');
    if (!existsSync(dir)) return { success: true, data: [] };
    const files = readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
    const sessions = files.map((file) => {
      try {
        const data = JSON.parse(readFileSync(join(dir, file), 'utf-8')) as Record<string, unknown>;
        return { id: (data['id'] as string) ?? file.replace('.json', ''), role: data['role'] ?? null, status: data['status'] ?? null, started_at: data['started_at'] ?? null, card_id: data['card_id'] ?? null };
      } catch (err) {
        return { id: file.replace('.json', ''), error: err instanceof Error ? err.message : String(err) };
      }
    });
    return { success: true, data: sessions };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function read_agent_session(ctx: ToolContext, params: { sessionId: string; lastN?: number }): Promise<ToolResult> {
  try {
    if (typeof params.sessionId !== 'string' || params.sessionId.length === 0) return { success: false, error: 'sessionId is required.' };
    if (!/^[a-zA-Z0-9_-]+$/.test(params.sessionId)) return { success: false, error: 'sessionId contains invalid characters.' };
    const sessionPath = join(ctx.projectRoot, '.saivage', 'agents', 'sessions', `${params.sessionId}.json`);
    const messagesPath = join(ctx.projectRoot, '.saivage', 'agents', 'messages', `${params.sessionId}.jsonl`);
    const session = existsSync(sessionPath) ? JSON.parse(readFileSync(sessionPath, 'utf-8')) : null;
    const limit = Math.min(Math.max(1, params.lastN ?? JSONL_TAIL_DEFAULT), JSONL_TAIL_MAX);
    const { entries, total } = readJsonlTail(messagesPath, limit);
    return { success: true, data: { session, total_messages: total, returned: entries.length, messages: entries } };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}
