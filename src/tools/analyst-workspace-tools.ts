import { z } from 'zod';
import { existsSync, lstatSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve as resolvePath } from 'node:path';

import { evaluateAuthz } from '../agents/authz.js';
import { recordControlAction } from '../persistence/index.js';
import { readRuntimeState } from '../runtime/state-api.js';
import { SecretPathError, classifyShellCommand } from '../workspace/index.js';
import { looksLikeSecretPath } from '../workspace/secret-paths.js';
import { assertAnalystInspectionTarget, isAnalystSecretPath } from '../workspace/file-access-security.js';
import { runAuditedAnalystTool } from '../agents/analyst-tool-runner.js';
import type { ToolContext, ToolResult } from './analyst-tool-types.js';
import { describe, emptyInput, type UnifiedToolDefinition } from './tool-catalog.js';
import { isBinarySample, normalizeShellParams, redactShellText, runShellCommandWithCapture, summarizeShellCommand, summarizeShellOutcome, toolFailure, toolFailureFromError, type ShellCommandParams } from './analyst-tool-helpers.js';
import { closeOpenRecordSlot, discardOpenRecordSlot, exposedRecordSlotDefinitionForFilename, openRecordSlot, readClosedRecordSlotMetadata, readRecordSlotIndex, recordPath } from '../runtime/records/record-slots.js';

const FILE_READ_MAX_BYTES = 1_000_000;
const FILE_READ_DEFAULT_BYTES = 200_000;
const LIST_DIR_DEFAULT_ENTRIES = 500;

export async function navigate_workspace(ctx: ToolContext, params: { target: { kind: 'card' | 'transcript' | 'process' | 'process_list' | 'agent_session_list' | 'config'; id?: string; refinement?: string } }): Promise<ToolResult> {
  return runAuditedAnalystTool(ctx, params, { action: 'workspace.navigate', safety_class: 'low', target_kind: 'session', getTargetId: (p) => `${p.target.kind}:${p.target.id ?? '-'}`, run: async () => ({ success: true, data: { intent: 'navigate_workspace', target: params.target } }) });
}

export async function navigate_back(ctx: ToolContext, params: Record<string, never> = {}): Promise<ToolResult> {
  return runAuditedAnalystTool(ctx, params, { action: 'workspace.navigate_back', safety_class: 'low', target_kind: 'session', getTargetId: () => 'workspace', run: async () => ({ success: true, data: { intent: 'navigate_back' } }) });
}

export async function run_shell_command(ctx: ToolContext, params: ShellCommandParams): Promise<ToolResult> {
  try {
    if (ctx.surface === 'telegram') return toolFailure('permission', 'run_shell_command is not available on Telegram.');
    const normalized = normalizeShellParams(ctx, params);
    for (const token of normalized.command.split(/\s+/)) if (token && looksLikeSecretPath(token)) throw new SecretPathError(token);
    const classifiedAs = classifyShellCommand(normalized.command, normalized.cwd);
    const verdict = evaluateAuthz({ actor: ctx.actor, surface: ctx.surface, safety_class: classifiedAs });
    const auditBase = { actor: ctx.actor, surface: ctx.surface, action: 'shell.exec', target_kind: null, target_id: null, params_summary: `shell.exec [classified=${classifiedAs}] ${summarizeShellCommand(normalized.command)}` };
    if (verdict === 'deny') {
      recordControlAction(ctx.projectRoot, { ...auditBase, outcome: 'denied', outcome_summary: `shell denied [classified=${classifiedAs}]` }, ctx.eventBus);
      return { ...toolFailure('permission', `Denied by authorization policy for ${ctx.actor}/${ctx.surface}/${classifiedAs}.`, { classified_as: classifiedAs }), data: { classified_as: classifiedAs } };
    }
    const result = await runShellCommandWithCapture(normalized.command, normalized.cwd, normalized.timeoutMs, normalized.maxOutputBytes);
    const payload = { classified_as: classifiedAs, exit_code: result.exitCode, duration_ms: result.durationMs, stdout: result.stdout, stderr: result.stderr, truncated: result.truncated, cwd: normalized.cwd, command: redactShellText(normalized.command) };
    if (classifiedAs !== 'read_only') recordControlAction(ctx.projectRoot, { ...auditBase, outcome: result.exitCode === 0 && !result.timedOut ? 'ok' : 'error', outcome_summary: `${summarizeShellOutcome(result.exitCode, result.truncated, result.timedOut)} stdout=${result.stdout} stderr=${result.stderr}`.slice(0, 2000), ...(result.exitCode === 0 && !result.timedOut ? {} : { error: result.stderr || `shell command failed: ${summarizeShellOutcome(result.exitCode, result.truncated, result.timedOut)}` }) }, ctx.eventBus);
    if (result.timedOut) return { ...toolFailure('io', `Command timed out after ${normalized.timeoutMs}ms.`, { classified_as: classifiedAs }, true), data: payload };
    return { success: result.exitCode === 0, ...(result.exitCode === 0 ? { data: payload } : { ...toolFailure('io', result.stderr || `Command exited with code ${result.exitCode}`, { classified_as: classifiedAs, exit_code: result.exitCode }), data: payload }) };
  } catch (err) {
    if (err instanceof SecretPathError) return toolFailure('permission', 'Access denied: secret-bearing path is off-limits ([SECRET_PATH]). Use safer inspection paths that do not touch secrets.');
    return toolFailureFromError(err, 'internal', err instanceof Error ? redactShellText(err.message).replaceAll(ctx.projectRoot, '[PROJECT_ROOT]') : String(err));
  }
}

export async function read_file(_ctx: ToolContext, params: { path: string; maxBytes?: number }): Promise<ToolResult> {
  try {
    if (typeof params.path !== 'string' || params.path.length === 0) return toolFailure('validation', 'path is required.', { field: 'path' });
    if (params.path.startsWith('record://')) return readRecordFile(_ctx.projectRoot, params.path, params.maxBytes);
    const abs = resolvePath(params.path); assertAnalystInspectionTarget(abs);
    if (!existsSync(abs)) return toolFailure('not_found', `Path not found: ${abs}`);
    const st = statSync(abs); if (st.isDirectory()) return toolFailure('conflict', `Path is a directory; use list_directory instead: ${abs}`); if (!st.isFile()) return toolFailure('conflict', `Path is not a regular file: ${abs}`);
    const cap = Math.min(Math.max(1, params.maxBytes ?? FILE_READ_DEFAULT_BYTES), FILE_READ_MAX_BYTES);
    const buf = readFileSync(abs); const truncated = buf.length > cap; const sliced = truncated ? buf.subarray(0, cap) : buf;
    if (isBinarySample(sliced)) return { success: true, data: { path: abs, size: st.size, binary: true, content: null, truncated, modified_at: st.mtime.toISOString() } };
    return { success: true, data: { path: abs, size: st.size, binary: false, truncated, bytes_returned: sliced.length, content: sliced.toString('utf-8'), modified_at: st.mtime.toISOString() } };
  } catch (err) { if (err instanceof SecretPathError) return toolFailure('permission', err.message); return toolFailureFromError(err, 'io'); }
}

export async function write_file(ctx: ToolContext, params: { path: string; content: string }): Promise<ToolResult> {
  const auditParams = { path: params.path, bytes: Buffer.byteLength(params.content ?? '', 'utf8') };
  return runAuditedAnalystTool(ctx, auditParams, { action: 'record.brief.write', safety_class: 'high', target_kind: 'card', getTargetId: () => {
    try { return params.path.startsWith('record://') ? new URL(params.path).searchParams.get('card') : null; } catch { return null; }
  }, run: async () => {
    try {
      if (!params.path.startsWith('record://')) return toolFailure('permission', 'write_file only writes record://brief.md document records. It cannot write host or project files.', { path: params.path });
      const runtimeState = readRuntimeState(ctx.projectRoot);
      if (runtimeState?.status !== 'stopped' && runtimeState?.status !== 'paused') return toolFailure('permission', `write_file requires runtime status stopped or paused before the Analyst mutates card records. Current runtime status is ${runtimeState?.status ?? 'unknown'}.`, { status: runtimeState?.status ?? 'unknown' });
      const target = parseBriefWriteUrl(params.path);
      if (params.content.length === 0) return toolFailure('validation', 'brief.md content must not be empty.', { path: params.path });
      validateBriefMarkdown(params.content);
      const card = ctx.store.read(target.cardId);
      if (!card) return toolFailure('not_found', `Card '${target.cardId}' not found.`, { cardId: target.cardId });
      const index = readRecordSlotIndex(ctx.projectRoot, target.cardId, 'brief');
      if (index.open !== null) return toolFailure('conflict', `Cannot write '${target.path}': latest brief.md version is open.`, { cardId: target.cardId, open: index.open });
      const open = openRecordSlot(ctx.projectRoot, { cardId: target.cardId, filename: 'brief.md' });
      try {
        writeFileSync(open.absolutePath, params.content, 'utf8');
        const closed = closeOpenRecordSlot(ctx.projectRoot, { cardId: target.cardId, filename: 'brief.md', writer: 'analyst', cardVersionSeq: card.version_seq });
        return { success: true, data: { card_id: target.cardId, path: closed.relativePath, record_url: closed.recordUrl, bytes: Buffer.byteLength(params.content, 'utf8'), written: true } };
      } catch (err) {
        discardOpenRecordSlot(ctx.projectRoot, { cardId: target.cardId, filename: 'brief.md', reason: 'analyst write_file failed' });
        throw err;
      }
    } catch (err) { return toolFailureFromError(err, 'validation'); }
  } });
}

function parseBriefWriteUrl(raw: string): { cardId: string; path: string } {
  const url = new URL(raw);
  const filename = validRecordSegment(decodeURIComponent(`${url.hostname}${url.pathname}`), 'record filename', raw);
  if (filename !== 'brief.md') throw new Error('write_file only supports record://brief.md document writes.');
  const cardId = validRecordSegment(url.searchParams.get('card') ?? '', 'card id', raw);
  const version = url.searchParams.get('v') ?? 'next';
  if (version !== 'next') throw new Error('write_file record writes must use v=next.');
  return { cardId, path: `record://brief.md?card=${encodeURIComponent(cardId)}&v=next` };
}

function validateBriefMarkdown(content: string): void {
  for (const heading of ['# Goal', '# Instructions', '# Acceptance Criteria']) {
    if (!content.includes(heading)) throw new Error(`brief.md must include '${heading}'.`);
  }
}

function readRecordFile(projectRoot: string, raw: string, maxBytes?: number): ToolResult {
  const url = new URL(raw);
  const filename = validRecordSegment(decodeURIComponent(`${url.hostname}${url.pathname}`), 'record filename', raw);
  const definition = exposedRecordSlotDefinitionForFilename(filename);
  const cardId = validRecordSegment(url.searchParams.get('card') ?? '', 'card id', raw);
  const versionParam = url.searchParams.get('v') ?? undefined;
  if (versionParam === 'next') return toolFailure('validation', 'read_file can read only closed records.');
  const index = readRecordSlotIndex(projectRoot, cardId, definition.slot);
  const version = versionParam && versionParam !== 'latest' ? Number(versionParam) : index.latest;
  if (version === null) return toolFailure('not_found', `No closed record exists for '${cardId}/${definition.slot}'.`);
  if (!Number.isInteger(version) || version < 1) return toolFailure('validation', `Invalid record version '${versionParam}'.`);
  const entry = index.versions[String(version)];
  if (!entry || entry.status !== 'closed') return toolFailure('not_found', `Record '${cardId}/${definition.slot}/${version}' is not closed.`);
  const path = recordPath(projectRoot, cardId, definition.slot, version, filename).absolutePath;
  const st = statSync(path);
  const cap = Math.min(Math.max(1, maxBytes ?? FILE_READ_DEFAULT_BYTES), FILE_READ_MAX_BYTES);
  const buf = readFileSync(path);
  const truncated = buf.length > cap;
  const sliced = truncated ? buf.subarray(0, cap) : buf;
  return { success: true, data: { path: raw, size: st.size, binary: false, truncated, bytes_returned: sliced.length, content: sliced.toString('utf-8'), modified_at: st.mtime.toISOString() } };
}

export async function read_file_metadata(ctx: ToolContext, params: { path: string }): Promise<ToolResult> {
  try {
    if (typeof params.path !== 'string' || params.path.length === 0) return toolFailure('validation', 'path is required.', { field: 'path' });
    if (params.path.startsWith('record://')) return { success: true, data: recordMetadataFromUrl(ctx.projectRoot, params.path) };
    const abs = resolvePath(params.path); assertAnalystInspectionTarget(abs);
    if (!existsSync(abs)) return toolFailure('not_found', `Path not found: ${abs}`);
    const st = statSync(abs);
    return { success: true, data: { path: abs, size: st.size, type: st.isDirectory() ? 'directory' : st.isFile() ? 'file' : 'other', modified_at: st.mtime.toISOString() } };
  } catch (err) { if (err instanceof SecretPathError) return toolFailure('permission', err.message); return toolFailureFromError(err, 'io'); }
}

export async function list_directory(_ctx: ToolContext, params: { path: string; maxEntries?: number }): Promise<ToolResult> {
  try {
    if (typeof params.path !== 'string' || params.path.length === 0) return toolFailure('validation', 'path is required.', { field: 'path' });
    const abs = resolvePath(params.path); assertAnalystInspectionTarget(abs);
    if (!existsSync(abs)) return toolFailure('not_found', `Path not found: ${abs}`);
    const st = statSync(abs); if (!st.isDirectory()) return toolFailure('conflict', `Path is not a directory: ${abs}`);
    const cap = Math.min(Math.max(1, params.maxEntries ?? LIST_DIR_DEFAULT_ENTRIES), 5000); const names = readdirSync(abs).sort(); const truncated = names.length > cap; const slice = truncated ? names.slice(0, cap) : names; const entries: Array<Record<string, unknown>> = []; let redactedCount = 0;
    for (const name of slice) {
      const child = join(abs, name); if (isAnalystSecretPath(child)) { redactedCount += 1; continue; }
      try { const ls = lstatSync(child); const symlink = ls.isSymbolicLink(); const cs = symlink ? statSync(child) : ls; entries.push({ name, type: cs.isDirectory() ? 'directory' : cs.isFile() ? 'file' : 'other', size: cs.isFile() ? cs.size : undefined, symlink, modified_at: cs.mtime.toISOString() }); }
      catch (err) { entries.push({ name, type: 'unreadable', error: err instanceof Error ? err.message : String(err) }); }
    }
    if (redactedCount > 0) entries.push({ ['name']: '<redacted>', count: redactedCount });
    return { success: true, data: { path: abs, total_entries: names.length, truncated, redacted_count: redactedCount, entries } };
  } catch (err) { if (err instanceof SecretPathError) return toolFailure('permission', err.message); return toolFailureFromError(err, 'io'); }
}

export const analystWorkspaceTools: readonly UnifiedToolDefinition<string, any>[] = [
  { name: 'navigate_workspace', description: 'Navigate the workspace area.', input: z.object({ target: z.object({ kind: z.enum(['card', 'transcript', 'process', 'process_list', 'agent_session_list', 'config']), id: describe(z.string().optional(), 'Optional target id.'), refinement: describe(z.string().optional(), 'Optional view refinement.') }).strict() }).strict(), roles: ['analyst'], executor: navigate_workspace },
  { name: 'navigate_back', description: 'Navigate back in the workspace area.', input: emptyInput, roles: ['analyst'], executor: navigate_back },
  { name: 'read_file', description: 'Read the contents of any file the saivage service can see on the host. Returns up to maxBytes bytes (default 200000, max 1000000). Binary files return content=null with binary=true. Use absolute paths or paths relative to the saivage server cwd.', input: z.object({ path: describe(z.string(), 'Absolute or relative file path.'), maxBytes: describe(z.number().int().optional(), 'Max bytes to read (default 200000, max 1000000).') }).strict(), roles: ['analyst'], executor: read_file },
  { name: 'read_file_metadata', description: 'Read metadata for a host file or closed record:// document URL without returning file content.', input: z.object({ path: describe(z.string(), 'Absolute, relative, or record:// document URL.') }).strict(), roles: ['analyst'], executor: read_file_metadata },
  { name: 'write_file', description: 'Write a new closed brief record while runtime status is stopped or paused. Only supports record://brief.md?card=<id>&v=next; it cannot write host or project files.', input: z.object({ path: describe(z.string(), 'Must be record://brief.md?card=<id>&v=next.'), content: describe(z.string(), 'Full brief.md content including Goal, Instructions, and Acceptance Criteria headings.') }).strict(), roles: ['analyst'], executor: write_file },
  { name: 'list_directory', description: 'List the contents of any directory the saivage service can see on the host. Use absolute paths or paths relative to the saivage server cwd.', input: z.object({ path: describe(z.string(), 'Absolute or relative directory path.'), maxEntries: describe(z.number().int().optional(), 'Max entries to return (default 500, max 5000).') }).strict(), roles: ['analyst'], executor: list_directory },
  { name: 'run_shell_command', description: 'Run a bounded inspection shell command. Destructive commands are denied on web-chat and must not be used to mutate project source or runtime state.', input: z.object({ command: describe(z.string(), 'Shell command to inspect the host or project state.'), cwd: describe(z.string().optional(), 'Optional working directory. Defaults to the project root.'), timeoutMs: describe(z.number().int().optional(), 'Optional timeout in milliseconds (default 15000, max 60000).'), maxOutputBytes: describe(z.number().int().optional(), 'Optional per-stream output cap in bytes (default 65536, max 1048576).') }).strict(), roles: ['analyst'], executor: run_shell_command },
] as const;

function recordMetadataFromUrl(projectRoot: string, raw: string): unknown {
  const url = new URL(raw);
  const filename = validRecordSegment(decodeURIComponent(`${url.hostname}${url.pathname}`), 'record filename', raw);
  const cardId = validRecordSegment(url.searchParams.get('card') ?? '', 'card id', raw);
  const versionParam = url.searchParams.get('v') ?? undefined;
  if (versionParam === 'next') throw new Error('record metadata is available only for closed records.');
  const version = versionParam && versionParam !== 'latest' ? Number(versionParam) : undefined;
  if (version !== undefined && (!Number.isInteger(version) || version < 1)) throw new Error(`Invalid record version '${versionParam}'.`);
  return readClosedRecordSlotMetadata(projectRoot, { cardId, filename, version });
}

function validRecordSegment(value: string, label: string, raw: string): string {
  if (!value || value === '.' || value === '..' || value.includes('/') || value.includes('\\')) throw new Error(`Invalid ${label} in record URL '${raw}'.`);
  return value;
}
