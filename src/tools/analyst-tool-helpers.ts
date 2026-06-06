import { spawn } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve as resolvePath } from 'node:path';

import { PROJECT_CARD_ID, type CardStore } from '../cards/store-api.js';
import { computeCardDisplayPath } from '../application/read-models/card-view.js';
import { listProcesses } from '../runtime/process-api.js';
import type { CardRecord, CardType } from '../schemas/index.js';
import { assertSafeShellCwd } from '../workspace/index.js';
import { isAnalystSecretPath } from '../workspace/file-access-security.js';
import {
  DEFAULT_COMMAND_TIMEOUT_MS,
  DEFAULT_MAX_OUTPUT_BYTES,
  MAX_ANALYST_OUTPUT_BYTES,
  MAX_COMMAND_TIMEOUT_MS,
  redactCommandForPolicy,
  sanitizedCommandEnv,
} from '../runtime/command-policy.js';
import { CARD_STATUS_VALUES, CARD_TYPE_VALUES, URGENCY_VALUES } from './tool-catalog.js';
import type { ActionPreview, ToolContext, ToolErrorEnvelope, ToolErrorKind, ToolResult } from './analyst-tool-types.js';

export type ShellCommandParams = {
  command: string;
  cwd?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
};

export type NormalizedShellCommandParams = {
  command: string;
  cwd: string;
  timeoutMs: number;
  maxOutputBytes: number;
};

export function saivageDir(projectRoot: string): string {
  return join(projectRoot, '.saivage');
}

export function getStore(ctx: ToolContext): CardStore {
  return ctx.store;
}

export function cardSummary(card: CardRecord, store?: CardStore) {
  return { id: card.id, display_path: store ? computeCardDisplayPath(store, card) : null, title: card.title, type: card.type, status: card.status };
}

export function normalizeParentValue(value: unknown): string | null | undefined {
  if (value === null) return null;
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (trimmed.toLowerCase() === 'null') return null;
  return trimmed;
}

export function defaultParentForCreate(store: CardStore, type: CardType): string | null | undefined {
  if (type === 'project') return null;
  if (type === 'goal') return PROJECT_CARD_ID;
  const activeGoals = store
    .list()
    .filter((card) => card.type === 'goal' && ['active', 'running', 'backlog', 'drafting', 'blocked'].includes(card.status))
    .sort((a, b) => a.priority - b.priority);
  if (activeGoals.length === 1) return activeGoals[0].id;
  const allGoals = store
    .list()
    .filter((card) => card.type === 'goal')
    .sort((a, b) => a.priority - b.priority);
  if (allGoals.length === 1) return allGoals[0].id;
  return PROJECT_CARD_ID;
}

export function humanizeToolError(toolName: string, raw: string): string {
  const enumHints: string[] = [];
  const enumIssueRe = /"received":\s*"([^"]*)"[\s\S]*?"path":\s*\[\s*"([^"]+)"[\s\S]*?Expected\s+([^,]+(?:\s*\|\s*[^,]+)+)/g;
  let m: RegExpExecArray | null;
  while ((m = enumIssueRe.exec(raw)) !== null) {
    const got = m[1];
    const field = m[2];
    const allowed = m[3]
      .replace(/'/g, '')
      .split('|')
      .map((s) => s.trim())
      .filter(Boolean)
      .join(', ');
    enumHints.push(`field '${field}' received '${got}'; allowed values: ${allowed}`);
  }
  if (enumHints.length === 0) {
    if (/\bstatus\b/i.test(raw)) enumHints.push(`'status' allowed values: ${CARD_STATUS_VALUES.join(', ')}`);
    else if (/\burgency\b/i.test(raw)) enumHints.push(`'urgency' allowed values: ${URGENCY_VALUES.join(', ')}`);
    else if (/\btype\b/i.test(raw)) enumHints.push(`'type' allowed values: ${CARD_TYPE_VALUES.join(', ')}`);
  }
  const hintLine = enumHints.length > 0 ? ` Hint: ${enumHints.join('; ')}.` : '';
  return `${toolName} failed.${hintLine} See the '${toolName}' tool's parameter schema for the full list of accepted fields and values. Original error: ${raw}`;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function toolError(kind: ToolErrorKind, message: string, details?: Record<string, unknown>, retryable?: boolean): ToolErrorEnvelope {
  const envelope: ToolErrorEnvelope = { kind, message };
  if (details !== undefined) envelope.details = details;
  if (retryable !== undefined) envelope.retryable = retryable;
  return envelope;
}

export function toolFailure(kind: ToolErrorKind, message: string, details?: Record<string, unknown>, retryable?: boolean): ToolResult {
  const errorEnvelope = toolError(kind, message, details, retryable);
  return { success: false, error: errorEnvelope.message, errorEnvelope };
}

export function classifyToolError(err: unknown, fallbackKind: ToolErrorKind = 'internal', messageOverride?: string): ToolErrorEnvelope {
  const raw = messageOverride ?? errorMessage(err);
  const lower = raw.toLowerCase();
  const kind: ToolErrorKind =
    lower.includes('denied') || lower.includes('not available on telegram') || lower.includes('off-limits') || lower.includes('authorization') ? 'permission'
      : lower.includes('not found') || lower.includes('does not exist') ? 'not_found'
        : lower.includes('invalid') || lower.includes('required') || lower.includes('must be') || lower.includes('schema') || lower.includes('allowed values') || lower.includes('no allowed fields') ? 'validation'
          : lower.includes('cannot') || lower.includes('conflict') || lower.includes('mismatch') ? 'conflict'
            : lower.includes('enoent') || lower.includes('eacces') || lower.includes('file') || lower.includes('directory') || lower.includes('readable') ? 'io'
              : fallbackKind;
  return toolError(kind, raw);
}

export function toolFailureFromError(err: unknown, fallbackKind: ToolErrorKind = 'internal', messageOverride?: string): ToolResult {
  const errorEnvelope = classifyToolError(err, fallbackKind, messageOverride);
  return { success: false, error: errorEnvelope.message, errorEnvelope };
}

export function preflightEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
  field: string,
  toolName: string,
): { ok: true } | { ok: false; error: string; errorEnvelope: ToolErrorEnvelope } {
  if (value === undefined) return { ok: true };
  if (typeof value !== 'string') {
    const message = `${toolName} failed: field '${field}' must be a string. Allowed values: ${allowed.join(', ')}. See the '${toolName}' tool's parameter schema.`;
    return { ok: false, error: message, errorEnvelope: toolError('validation', message, { field }) };
  }
  if (!(allowed as readonly string[]).includes(value)) {
    const message = `${toolName} failed: field '${field}' received '${value}', which is not a valid value. Allowed values: ${allowed.join(', ')}. See the '${toolName}' tool's parameter schema.`;
    return { ok: false, error: message, errorEnvelope: toolError('validation', message, { field, allowed: [...allowed] }) };
  }
  return { ok: true };
}

export function buildDeletePreview(projectRoot: string, store: CardStore, id: string): ActionPreview {
  const card = store.read(id);
  if (!card) return { type: 'delete_card', summary: `Delete card '${id}' (card not found - no children to delete).`, affectedCards: [], affectedProcesses: [], warnings: [`Card '${id}' does not exist.`] };
  const descendantIds = store.getDescendantIds(id);
  const allAffectedIds = [id, ...descendantIds];
  return {
    type: 'delete_card',
    summary: `Delete card '${card.title}' (${card.id}) and all descendants (${allAffectedIds.length} total card(s)).`,
    affectedCards: allAffectedIds.map((cid) => {
      const c = store.read(cid);
      return c ? cardSummary(c) : { id: cid, title: '(not found)', type: 'unknown', status: 'unknown' };
    }),
    affectedProcesses: listProcesses(projectRoot).filter((p) => allAffectedIds.includes(p.card_id)).map((p) => ({ id: p.id, command: p.command, status: p.status })),
    warnings: descendantIds.length > 0 ? [`This will permanently delete ${descendantIds.length} descendant card(s).`] : [],
  };
}

export function buildAbortPreview(projectRoot: string, store: CardStore, goalId: string): ActionPreview {
  const goal = store.read(goalId);
  if (!goal) return { type: 'abort_goal', summary: `Abort goal '${goalId}' (goal not found).`, affectedCards: [], affectedProcesses: [], warnings: [`Goal card '${goalId}' does not exist.`] };
  const descendantIds = store.getDescendantIds(goalId);
  const allAffectedIds = [goalId, ...descendantIds];
  return {
    type: 'abort_goal',
    summary: `Abort goal '${goal.title}' (${goal.id}) and all descendants (${allAffectedIds.length} total card(s)).`,
    affectedCards: allAffectedIds.map((cid) => {
      const c = store.read(cid);
      return c ? cardSummary(c) : { id: cid, title: '(not found)', type: 'unknown', status: 'unknown' };
    }),
    affectedProcesses: listProcesses(projectRoot).filter((p) => allAffectedIds.includes(p.card_id)).map((p) => ({ id: p.id, command: p.command, status: p.status })),
    warnings: [],
  };
}

export function buildRestartGoalPreview(projectRoot: string, store: CardStore, goalId: string): ActionPreview {
  const goal = store.read(goalId);
  if (!goal) return { type: 'restart_goal', summary: `Restart goal '${goalId}' (goal not found).`, affectedCards: [], affectedProcesses: [], warnings: [`Goal card '${goalId}' does not exist.`] };
  const descendantIds = store.getDescendantIds(goalId);
  const allAffectedIds = [goalId, ...descendantIds];
  return {
    type: 'restart_goal',
    summary: `Restart goal '${goal.title}' (${goal.id}). Running children will be cancelled, plan diary cleared, goal re-queued.`,
    affectedCards: allAffectedIds.map((cid) => {
      const c = store.read(cid);
      return c ? cardSummary(c) : { id: cid, title: '(not found)', type: 'unknown', status: 'unknown' };
    }),
    affectedProcesses: listProcesses(projectRoot).filter((p) => allAffectedIds.includes(p.card_id) && p.status === 'running').map((p) => ({ id: p.id, command: p.command, status: p.status })),
    warnings: ['The plan diary for this goal will be cleared.'],
  };
}

export function redactShellText(value: string): string {
  return redactCommandForPolicy(value);
}

export function summarizeShellCommand(command: string): string {
  return redactShellText(command)
    .split(/\s+/)
    .map((token) => {
      try {
        return isAnalystSecretPath(resolvePath(token)) ? '[SECRET_PATH]' : token;
      } catch {
        return token;
      }
    })
    .join(' ')
    .slice(0, 200);
}

export function summarizeShellOutcome(exitCode: number | null, truncated: boolean, timedOut: boolean): string {
  return timedOut ? 'command timed out' : `exit=${exitCode === null ? 'null' : String(exitCode)}${truncated ? ' truncated' : ''}`;
}

function captureLimited(buffer: Buffer, limit: number): { text: string; truncated: boolean; truncatedBytes: number } {
  if (buffer.length <= limit) return { text: buffer.toString('utf8'), truncated: false, truncatedBytes: 0 };
  const sliced = buffer.subarray(0, limit).toString('utf8');
  const truncatedBytes = buffer.length - limit;
  return { text: `${sliced}\n[truncated ${truncatedBytes} bytes]`, truncated: true, truncatedBytes };
}

export async function runShellCommandWithCapture(command: string, cwd: string, timeoutMs: number, maxOutputBytes: number): Promise<{ exitCode: number | null; durationMs: number; stdout: string; stderr: string; truncated: boolean; timedOut: boolean }> {
  return await new Promise((resolveResult) => {
    const startedAt = Date.now();
    const child = spawn('bash', ['-lc', command], { cwd, env: sanitizedCommandEnv(), timeout: timeoutMs, killSignal: 'SIGKILL' });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let timedOut = false;
    child.stdout.on('data', (chunk) => {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (stdoutBytes < maxOutputBytes) stdoutChunks.push(buf);
      stdoutBytes += buf.length;
    });
    child.stderr.on('data', (chunk) => {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (stderrBytes < maxOutputBytes) stderrChunks.push(buf);
      stderrBytes += buf.length;
    });
    child.on('error', (error) => resolveResult({ exitCode: null, durationMs: Date.now() - startedAt, stdout: '', stderr: redactShellText(error.message), truncated: false, timedOut: false }));
    child.on('spawn', () => { if (child.stdin) child.stdin.end(); });
    child.on('close', (code, signal) => {
      timedOut = signal === 'SIGKILL' && Date.now() - startedAt >= timeoutMs;
      const stdoutCapture = captureLimited(Buffer.concat(stdoutChunks), maxOutputBytes);
      const stderrCapture = captureLimited(Buffer.concat(stderrChunks), maxOutputBytes);
      resolveResult({
        exitCode: timedOut ? null : code,
        durationMs: Date.now() - startedAt,
        stdout: redactShellText(stdoutCapture.text),
        stderr: redactShellText(stderrCapture.text || (timedOut ? `Command timed out after ${timeoutMs}ms.` : '')),
        truncated: stdoutCapture.truncated || stderrCapture.truncated || stdoutBytes > maxOutputBytes || stderrBytes > maxOutputBytes,
        timedOut,
      });
    });
  });
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function normalizeShellCwd(projectRoot: string, cwd: unknown): string {
  if (cwd === undefined) return projectRoot;
  if (typeof cwd !== 'string') throw new Error('cwd must be a string when provided.');
  const trimmed = cwd.trim();
  if (!trimmed) return projectRoot;
  const resolved = resolvePath(trimmed);
  const rel = relative(projectRoot, resolved);
  if (rel !== '' && (rel === '..' || rel.startsWith('../') || rel.startsWith('..\\'))) throw new Error('cwd must stay within the project root.');
  if (!existsSync(resolved) || !statSync(resolved).isDirectory()) throw new Error('cwd is not a readable directory within the project root.');
  assertSafeShellCwd(resolved);
  return resolved;
}

function normalizeShellNumeric(value: unknown, fallback: number, max: number, field: 'timeoutMs' | 'maxOutputBytes'): number {
  if (value === undefined) return fallback;
  if (!isFiniteNumber(value)) throw new Error(`${field} must be a finite number when provided.`);
  return Math.min(Math.max(1, Math.trunc(value)), max);
}

export function normalizeShellParams(ctx: ToolContext, params: ShellCommandParams): NormalizedShellCommandParams {
  if (params === null || typeof params !== 'object' || Array.isArray(params)) throw new Error('run_shell_command params must be an object.');
  if (typeof params.command !== 'string' || params.command.trim().length === 0) throw new Error('command is required and must be a non-empty string.');
  return {
    command: params.command,
    cwd: normalizeShellCwd(ctx.projectRoot, params.cwd),
    timeoutMs: normalizeShellNumeric(params.timeoutMs, DEFAULT_COMMAND_TIMEOUT_MS, MAX_COMMAND_TIMEOUT_MS, 'timeoutMs'),
    maxOutputBytes: normalizeShellNumeric(params.maxOutputBytes, DEFAULT_MAX_OUTPUT_BYTES, MAX_ANALYST_OUTPUT_BYTES, 'maxOutputBytes'),
  };
}

export function isBinarySample(buf: Buffer): boolean {
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

export function readJsonlTail(path: string, limit: number): { entries: unknown[]; total: number; parseErrors: number } {
  if (!existsSync(path)) return { entries: [], total: 0, parseErrors: 0 };
  const raw = readFileSync(path, 'utf-8');
  const lines = raw.split('\n').filter((line) => line.trim() !== '');
  const tail = lines.slice(-limit);
  const entries: unknown[] = [];
  let parseErrors = 0;
  for (const line of tail) {
    try {
      entries.push(JSON.parse(line));
    } catch {
      parseErrors += 1;
    }
  }
  return { entries, total: lines.length, parseErrors };
}
