import * as childProcess from 'node:child_process';
import { closeSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';

import type { AgentRole } from '../schemas/index.js';
import { isBinarySample } from './analyst-tool-helpers.js';
import { redactTextForOutbound } from '../redaction/index.js';
import { assertRecordWrite, collectScopedFiles, displayPathForResolved, globScopedPath, globToRegExp, isHiddenPath, isWriteBlocked, listScopedPath, listVisibleDirectoryEntries, looksLikeSecretPath, resolveContainedProjectPath, resolveRecordWriteTarget, resolveScopedPath, scopedReadFilterRel, walkFiles, type VfsResolved } from '../workspace/index.js';
import { closeOpenRecordSlot, discardOpenRecordSlot, latestClosedRecordSlot, openRecordSlot, readRecordSlotIndex } from '../runtime/records/record-slots.js';
import type { CardStore } from '../cards/store-api.js';
import { readRuntimeState } from '../runtime/state-api.js';
import { propagateAnalystBriefEdit } from '../runtime/changed-propagation.js';
import type { CardNotification } from '../runtime/actors/card-actor.js';
import type { NotifyCardResult } from '../runtime/runtime-api.js';

const { spawnSync } = childProcess;

const DEFAULT_READ_LIMIT = 2000;
const DEFAULT_SEARCH_LIMIT = 200;
const MAX_SEARCH_LIMIT = 1000;
export const MAX_READ_FILE_BYTES = 10 * 1024 * 1024;
export const MAX_READ_OUTPUT_BYTES = 256 * 1024;
export const MAX_READ_LINE_CHARS = 2000;
export const READ_HEAD_SAMPLE_BYTES = 4096;

export type WorkspaceContext = { projectRoot: string; cardId?: string; agentRole?: AgentRole; store?: Pick<CardStore, 'read' | 'getAncestors' | 'setStatus'>; notifyCard?: (cardId: string, notification: CardNotification) => NotifyCardResult };
type ResolvedToolPath = Extract<VfsResolved, { kind: 'project' | 'tmp' | 'system' | 'work' }> | Extract<VfsResolved, { kind: 'record'; recordKind: 'document' }>;

export class WorkspaceToolInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkspaceToolInputError';
  }
}

function toolInputError(message: string): WorkspaceToolInputError {
  return new WorkspaceToolInputError(message);
}

function resolveProjectPath(projectRoot: string, path: string, label: string): { absolutePath: string; relativePath: string } {
  const resolved = resolveContainedProjectPath(projectRoot, path);
  if (!resolved.safe || !resolved.relativePath) throw toolInputError(resolved.reason ?? `${label} must resolve inside the project root.`);
  return { absolutePath: resolved.absolutePath, relativePath: resolved.relativePath };
}

function readFileHead(absolutePath: string, maxBytes: number): Buffer {
  const fd = openSync(absolutePath, 'r');
  try {
    const buffer = Buffer.alloc(maxBytes);
    const bytesRead = readSync(fd, buffer, 0, maxBytes, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    closeSync(fd);
  }
}

function truncateUtf8(content: string, maxBytes: number): { content: string; truncated: boolean } {
  let bytes = 0;
  let end = 0;
  for (const char of content) {
    const nextBytes = Buffer.byteLength(char, 'utf8');
    if (bytes + nextBytes > maxBytes) return { content: content.slice(0, end), truncated: true };
    bytes += nextBytes;
    end += char.length;
  }
  return { content, truncated: false };
}

function truncateChars(content: string, maxChars: number): { content: string; truncated: boolean } {
  let chars = 0;
  let end = 0;
  for (const char of content) {
    if (chars === maxChars) return { content: content.slice(0, end), truncated: true };
    chars += 1;
    end += char.length;
  }
  return { content, truncated: false };
}

function assertReadable(projectRoot: string, path: string, label = 'read path'): { absolutePath: string; relativePath: string } {
  const resolved = resolveProjectPath(projectRoot, path, label);
  if (isHiddenPath(projectRoot, resolved.absolutePath, resolved.relativePath)) throw toolInputError(`Access to '${resolved.relativePath}' is blocked for security reasons.`);
  return resolved;
}

function assertWritable(projectRoot: string, path: string): { absolutePath: string; relativePath: string } {
  const resolved = resolveProjectPath(projectRoot, path, 'write path');
  if (resolved.relativePath === '.' || resolved.relativePath.endsWith('/')) throw toolInputError('write requires a file path, not a directory.');
  if (resolved.relativePath === '.saivage' || resolved.relativePath.startsWith('.saivage/') || resolved.relativePath === '.saivage-work' || resolved.relativePath.startsWith('.saivage-work/')) throw toolInputError('Cannot modify Saivage internal state directories.');
  if (isWriteBlocked(resolved.relativePath) || looksLikeSecretPath(resolved.absolutePath)) throw toolInputError(`Write access to '${resolved.relativePath}' is blocked for security reasons.`);
  try {
    if (lstatSync(resolved.absolutePath).isSymbolicLink()) throw toolInputError(`Write access to symlink '${resolved.relativePath}' is blocked for security reasons.`);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  return resolved;
}

function canWriteWorkspaceFiles(role: AgentRole | undefined): boolean {
  return role === undefined || role === 'executor' || role === 'analyst';
}

function vfsCtx(ctx: WorkspaceContext) {
  return { projectRoot: ctx.projectRoot, agent: { cardId: ctx.cardId, agentRole: ctx.agentRole }, fail: toolInputError };
}

function assertScopedReadable(ctx: WorkspaceContext, resolved: VfsResolved): ResolvedToolPath {
  if (resolved.kind === 'record') {
    if (resolved.recordKind === 'directory') throw new Error('Record directory must be handled by caller.');
    return resolved;
  }
  const filterRel = scopedReadFilterRel(resolved, resolved.absolutePath, resolved.relativePath);
  if (isHiddenPath(ctx.projectRoot, resolved.absolutePath, filterRel)) throw toolInputError(`Access to '${resolved.relativePath}' is blocked for security reasons.`);
  return resolved;
}

function assertScopedWritable(ctx: WorkspaceContext, raw: string, resolved: VfsResolved): ResolvedToolPath {
  if (resolved.kind === 'record') {
    if (resolved.recordKind === 'directory') throw toolInputError('write requires a file path, not a directory.');
    return resolved;
  }
  if ((resolved.kind === 'project' || resolved.kind === 'system') && !canWriteWorkspaceFiles(ctx.agentRole)) throw toolInputError(`${ctx.agentRole} cannot write ${resolved.kind} files.`);
  if (resolved.absolutePath === '/' || raw.endsWith('/') || (resolved.kind !== 'system' && (resolved.relativePath === '.' || resolved.relativePath.endsWith('/')))) throw toolInputError('write requires a file path, not a directory.');
  if (resolved.kind === 'project' && (resolved.relativePath === '.saivage' || resolved.relativePath.startsWith('.saivage/') || resolved.relativePath === '.saivage-work' || resolved.relativePath.startsWith('.saivage-work/'))) throw toolInputError('Cannot modify Saivage internal state directories.');
  if (isWriteBlocked(resolved.relativePath) || looksLikeSecretPath(resolved.absolutePath)) throw toolInputError(`Write access to '${resolved.relativePath}' is blocked for security reasons.`);
  try {
    if (lstatSync(resolved.absolutePath).isSymbolicLink()) throw toolInputError(`Write access to symlink '${resolved.relativePath}' is blocked for security reasons.`);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  return resolved;
}

function resolveReadPath(ctx: WorkspaceContext, raw: string): { resolved: ResolvedToolPath | Extract<VfsResolved, { kind: 'record'; recordKind: 'directory' }>; scoped: boolean } {
  const resolved = resolveScopedPath(vfsCtx(ctx), raw, 'read');
  if (resolved === null) return { resolved: { kind: 'project', ...assertReadable(ctx.projectRoot, raw), isRoot: false }, scoped: false };
  if (resolved.kind === 'record' && resolved.recordKind === 'directory') return { resolved, scoped: true };
  return { resolved: assertScopedReadable(ctx, resolved), scoped: true };
}

function resolveWritePath(ctx: WorkspaceContext, raw: string): ResolvedToolPath {
  const resolved = resolveScopedPath(vfsCtx(ctx), raw, 'write');
  if (resolved === null) {
    if (!canWriteWorkspaceFiles(ctx.agentRole)) throw toolInputError(`${ctx.agentRole} cannot write project files.`);
    return { kind: 'project', ...assertWritable(ctx.projectRoot, raw), isRoot: false };
  }
  return assertScopedWritable(ctx, raw, resolved);
}

async function directoryEntriesForRead(ctx: WorkspaceContext, raw: string, resolved: ResolvedToolPath, scoped: boolean) {
  if (scoped) {
    const listing = await listScopedPath(vfsCtx(ctx), raw);
    if (listing.kind !== 'entries') throw new Error('Filesystem directory listing did not return entries.');
    return listing.entries;
  }
  if (resolved.kind === 'record') throw new Error('Record document cannot be listed as a directory.');
  return listVisibleDirectoryEntries(ctx, resolved);
}

function parseNonNegativeInt(value: unknown, fallback: number, max = Number.MAX_SAFE_INTEGER): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || Number(value) < 0) throw toolInputError('Expected a non-negative integer.');
  return Math.min(Number(value), max);
}

function patchPaths(patch: string): string[] {
  const paths = new Set<string>();
  for (const line of patch.split('\n')) {
    if (/^(?:new|deleted) file mode |^old mode |^new mode |^similarity index |^rename from |^rename to |^GIT binary patch/.test(line)) throw toolInputError('Unsupported patch feature. Only text add/modify/delete diffs are allowed.');
    const match = /^(?:---|\+\+\+)\s+(\S+)/.exec(line);
    if (!match) continue;
    const raw = match[1];
    if (raw === '/dev/null') continue;
    const clean = raw.replace(/^[ab]\//, '');
    if (!clean || isAbsolute(clean) || clean.includes('..') || /^[a-z][a-z0-9+.-]*:\/\/\//i.test(clean)) throw toolInputError(`Unsafe patch path '${raw}'.`);
    paths.add(clean);
  }
  return [...paths];
}

export async function readProject(ctx: WorkspaceContext, params: { path: string; offset?: number; limit?: number; read_mode?: 'auto' | 'text' | 'multimodal'; metadata_only?: boolean }): Promise<unknown> {
  const { resolved, scoped } = resolveReadPath(ctx, params.path);
  if (resolved.kind === 'record' && resolved.recordKind === 'directory') {
    const listing = await listScopedPath(vfsCtx(ctx), params.path);
    if (listing.kind !== 'records') throw new Error('Record directory listing did not return records.');
    const offset = parseNonNegativeInt(params.offset, 0);
    const limit = parseNonNegativeInt(params.limit, DEFAULT_READ_LIMIT, DEFAULT_READ_LIMIT);
    if (params.metadata_only === true) return { path: `record:///${resolved.cardId}`, metadata_only: true, is_directory: true, entries_count: listing.records.length };
    return { path: `record:///${resolved.cardId}`, records: listing.records.slice(offset, offset + limit), offset, limit, total_records: listing.records.length, truncated: offset + limit < listing.records.length };
  }
  const { absolutePath, relativePath } = resolved;
  const st = statSync(absolutePath);
  const baseRecord = { path: displayPathForResolved(ctx.projectRoot, resolved), ...(resolved.kind === 'record' ? { record_url: resolved.recordUrl } : {}) };
  if (params.metadata_only === true) {
    if (st.isDirectory()) {
      const entries = await directoryEntriesForRead(ctx, params.path, resolved, scoped);
      return { ...baseRecord, metadata_only: true, is_directory: true, size: st.size, mtime: st.mtime.toISOString(), entries_count: entries.length };
    }
    if (!st.isFile()) throw toolInputError(`Unsupported file type: ${relativePath}`);
    return { ...baseRecord, metadata_only: true, is_directory: false, size: st.size, mtime: st.mtime.toISOString() };
  }
  const mode = params.read_mode ?? 'auto';
  if (mode === 'multimodal') throw toolInputError('multimodal read_mode is not supported by v3 project tools yet.');
  const offset = parseNonNegativeInt(params.offset, 0);
  const limit = parseNonNegativeInt(params.limit, DEFAULT_READ_LIMIT, DEFAULT_READ_LIMIT);
  if (st.isDirectory()) {
    const entries = await directoryEntriesForRead(ctx, params.path, resolved, scoped);
    return { ...baseRecord, entries: entries.slice(offset, offset + limit), offset, limit, total_entries: entries.length, truncated: offset + limit < entries.length };
  }
  if (!st.isFile()) throw toolInputError(`Unsupported file type: ${relativePath}`);
  if (st.size > MAX_READ_FILE_BYTES) {
    const sample = readFileHead(absolutePath, READ_HEAD_SAMPLE_BYTES);
    if (isBinarySample(sample)) throw toolInputError(`Cannot read binary file as text: ${relativePath}`);
    return { ...baseRecord, content: null, offset, limit, total_lines: null, truncated: true, too_large: true, size: st.size, max_bytes: MAX_READ_FILE_BYTES, bytes: 0, message: `File is larger than ${MAX_READ_FILE_BYTES} bytes and was not read inline. Use metadata_only to inspect file metadata, or grep/glob to find narrower text targets before reading.` };
  }
  const buffer = readFileSync(absolutePath);
  if (isBinarySample(buffer.subarray(0, Math.min(buffer.length, READ_HEAD_SAMPLE_BYTES)))) throw toolInputError(`Cannot read binary file as text: ${relativePath}`);
  const lines = buffer.toString('utf8').split(/\r?\n/);
  let linesTruncated = false;
  const window = lines.slice(offset, offset + limit).map((line) => {
    const cappedLine = truncateChars(line, MAX_READ_LINE_CHARS);
    if (cappedLine.truncated) linesTruncated = true;
    return cappedLine.content;
  });
  const capped = truncateUtf8(window.join('\n'), MAX_READ_OUTPUT_BYTES);
  const redactedContent = resolved.kind === 'work' ? redactTextForOutbound(capped.content, 'operator.api', { source: 'project-file-tools.read.work' }) : capped.content;
  const returned = truncateUtf8(redactedContent, MAX_READ_OUTPUT_BYTES);
  const contentTruncated = capped.truncated || returned.truncated;
  const truncated = offset + limit < lines.length || linesTruncated || contentTruncated;
  const content = returned.content;
  return {
    ...baseRecord,
    content,
    offset,
    limit,
    total_lines: lines.length,
    truncated,
    size: st.size,
    bytes: Buffer.byteLength(content, 'utf8'),
    ...(linesTruncated ? { lines_truncated: true } : {}),
    ...(contentTruncated ? { content_truncated: true, max_bytes: MAX_READ_OUTPUT_BYTES } : {}),
  };
}

export async function writeProject(ctx: WorkspaceContext, params: { path: string; content: string }): Promise<unknown> {
  if (ctx.agentRole === 'analyst' && params.path.startsWith('record:///')) return writeAnalystBriefRecord(ctx, params);
  const resolved = resolveWritePath(ctx, params.path);
  const { absolutePath, relativePath } = resolved;
  mkdirSync(dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, params.content, 'utf8');
  return { path: relativePath, ...(resolved.kind === 'record' ? { record_url: resolved.recordUrl } : {}), bytes: Buffer.byteLength(params.content, 'utf8'), written: true };
}

export function authorizeWriteProject(ctx: WorkspaceContext, params: { path: string; content?: string }): void {
  if (ctx.agentRole === 'analyst' && params.path.startsWith('record:///')) {
    assertAnalystBriefRecordWritable(ctx, params);
    return;
  }
  if (params.path.startsWith('record:///')) {
    const target = resolveRecordWriteTarget({ projectRoot: ctx.projectRoot, agent: { cardId: ctx.cardId, agentRole: ctx.agentRole }, fail: toolInputError }, params.path);
    assertRecordWrite(target.agent.agentRole, target.agent.cardId, target.cardId, target.filename, target.version, toolInputError);
    return;
  }
  if (params.path.startsWith('tmp:///')) {
    resolveWritePath(ctx, params.path);
    return;
  }
  if (params.path.startsWith('system:///')) {
    if (!canWriteWorkspaceFiles(ctx.agentRole)) throw toolInputError(`${ctx.agentRole} cannot write system files.`);
    resolveWritePath(ctx, params.path);
    return;
  }
  if (!canWriteWorkspaceFiles(ctx.agentRole)) throw toolInputError(`${ctx.agentRole} cannot write project files.`);
  resolveWritePath(ctx, params.path);
}

function writeAnalystBriefRecord(ctx: WorkspaceContext, params: { path: string; content: string }): unknown {
  const target = assertAnalystBriefRecordWritable(ctx, params);
  const card = ctx.store!.read(target.cardId)!;
  const open = openRecordSlot(ctx.projectRoot, { cardId: target.cardId, filename: 'brief.md' });
  try {
    writeFileSync(open.absolutePath, params.content, 'utf8');
    const closed = closeOpenRecordSlot(ctx.projectRoot, { cardId: target.cardId, filename: 'brief.md', writer: 'analyst', cardVersionSeq: card.version_seq });
    propagateAnalystBriefEdit(ctx.store!, target.cardId, { kind: 'analyst_edit', summary: 'Analyst updated brief.md' }, ctx.notifyCard!);
    return { card_id: target.cardId, path: closed.relativePath, record_url: closed.recordUrl, bytes: Buffer.byteLength(params.content, 'utf8'), written: true };
  } catch (err) {
    discardOpenRecordSlot(ctx.projectRoot, { cardId: target.cardId, filename: 'brief.md', reason: 'analyst write failed' });
    throw err;
  }
}

function assertAnalystBriefRecordWritable(ctx: WorkspaceContext, params: { path: string; content?: string }): { cardId: string; path: string } {
  if (!params.path.startsWith('record:///')) throw toolInputError('Analyst write only writes record:///brief.md document records. It cannot write host or project files.');
  if (!ctx.store) throw new Error('Analyst record writes require a card store.');
  if (!ctx.notifyCard) throw toolInputError('Analyst brief record edits require card notification capability.');
  const runtimeState = readRuntimeState(ctx.projectRoot);
  if (runtimeState?.status !== 'stopped' && runtimeState?.status !== 'paused') throw toolInputError(`Analyst write requires runtime status stopped or paused before mutating card records. Current runtime status is ${runtimeState?.status ?? 'unknown'}.`);
  const target = resolveAnalystBriefWriteUrl(ctx, params.path);
  if (params.content !== undefined) {
    if (params.content.length === 0) throw toolInputError('brief.md content must not be empty.');
    validateBriefMarkdown(params.content);
  }
  const card = ctx.store.read(target.cardId);
  if (!card) throw toolInputError(`Card '${target.cardId}' not found.`);
  if (card.status !== 'backlog' && card.status !== 'done' && card.status !== 'failed' && card.status !== 'running') throw toolInputError(`Analyst brief edits require target card status backlog, done, failed, or running. Current status is ${card.status}.`);
  const index = readRecordSlotIndex(ctx.projectRoot, target.cardId, 'brief');
  if (index.open !== null) throw toolInputError(`Cannot write '${target.path}': latest brief.md version is open.`);
  return target;
}

function resolveAnalystBriefWriteUrl(ctx: WorkspaceContext, raw: string): { cardId: string; path: string } {
  const target = resolveRecordWriteTarget({ projectRoot: ctx.projectRoot, agent: { cardId: ctx.cardId, agentRole: ctx.agentRole }, fail: toolInputError }, raw);
  if (target.filename !== 'brief.md') throw toolInputError('Analyst write only supports record:///brief.md document writes.');
  if (target.version !== 'next') throw toolInputError('Analyst record writes must use v=next.');
  return { cardId: target.cardId, path: target.recordUrl };
}

function validateBriefMarkdown(content: string): void {
  for (const heading of ['# Goal', '# Instructions', '# Acceptance Criteria']) {
    if (!content.includes(heading)) throw toolInputError(`brief.md must include '${heading}'.`);
  }
}

export async function globProject(ctx: WorkspaceContext, params: { directory: string; pattern: string; max_results?: number }): Promise<unknown> {
  const scoped = resolveScopedPath(vfsCtx(ctx), params.directory, 'search');
  const limit = parseNonNegativeInt(params.max_results, DEFAULT_SEARCH_LIMIT, MAX_SEARCH_LIMIT);
  if (scoped !== null) {
    const result = await globScopedPath(vfsCtx(ctx), params.directory, params.pattern, limit);
    return { directory: displayPathForResolved(ctx.projectRoot, scoped), pattern: params.pattern, matches: result.matches, truncated: result.truncated };
  }
  const resolved = { kind: 'project' as const, ...assertReadable(ctx.projectRoot, params.directory), isRoot: false };
  const { absolutePath, relativePath } = resolved;
  const st = statSync(absolutePath);
  const pattern = globToRegExp(params.pattern);
  const matches: string[] = [];
  const consider = (abs: string, rel: string): boolean | void => {
    const within = abs === absolutePath ? relativePath : abs.slice((relativePath === '.' ? ctx.projectRoot : absolutePath).length + 1).replace(/\\/g, '/');
    if (pattern.test(within) || pattern.test(rel)) matches.push(rel);
    if (matches.length >= limit) return false;
  };
  if (st.isFile()) consider(absolutePath, relativePath);
  else walkFiles(ctx.projectRoot, absolutePath, consider, { includeHidden: false });
  return { directory: relativePath, pattern: params.pattern, matches, truncated: matches.length >= limit };
}

export async function grepProject(ctx: WorkspaceContext, params: { pattern: string; path?: string; include?: string; max_results?: number }): Promise<unknown> {
  const raw = params.path ?? '.';
  const scoped = resolveScopedPath(vfsCtx(ctx), raw, 'search');
  let regex: RegExp;
  try {
    regex = new RegExp(params.pattern);
  } catch (error) {
    throw toolInputError(error instanceof Error ? error.message : String(error));
  }
  const include = params.include ? globToRegExp(params.include) : null;
  const limit = parseNonNegativeInt(params.max_results, DEFAULT_SEARCH_LIMIT, MAX_SEARCH_LIMIT);
  const matches: Array<{ path: string; line: number; preview: string }> = [];

  if (scoped !== null) {
    const redact = scoped.kind === 'work';
    collectScopedFiles(vfsCtx(ctx), raw, (entry) => scanFile(entry.absolutePath, entry.displayPath, regex, include, redact, limit, matches));
    return { pattern: params.pattern, matches, truncated: matches.length >= limit };
  }

  const target = { kind: 'project' as const, ...assertReadable(ctx.projectRoot, raw), isRoot: false };
  const st = statSync(target.absolutePath);
  if (st.isFile()) scanFile(target.absolutePath, displayPathForResolved(ctx.projectRoot, target), regex, include, false, limit, matches);
  else walkFiles(ctx.projectRoot, target.absolutePath, (abs, rel) => scanFile(abs, rel, regex, include, false, limit, matches), { includeHidden: false });
  return { pattern: params.pattern, matches, truncated: matches.length >= limit };
}

function scanFile(absolutePath: string, displayPath: string, regex: RegExp, include: RegExp | null, redact: boolean, limit: number, matches: Array<{ path: string; line: number; preview: string }>): boolean | void {
  if (include && !include.test(displayPath)) return;
  const sample = readFileSync(absolutePath);
  if (isBinarySample(sample.subarray(0, Math.min(sample.length, 1024)))) return;
  const lines = sample.toString('utf8').split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    if (regex.test(lines[i]!)) {
      const preview = lines[i]!.slice(0, 500);
      matches.push({ path: displayPath, line: i + 1, preview: redact ? redactTextForOutbound(preview, 'operator.api', { source: 'project-file-tools.grep.work' }) : preview });
    }
    if (matches.length >= limit) return false;
  }
}

export async function editProject(ctx: WorkspaceContext, params: { path: string; old_string: string; new_string: string; replace_all?: boolean }): Promise<unknown> {
  if (ctx.agentRole === 'analyst' && params.path.startsWith('record:///')) return editAnalystBriefRecord(ctx, params);
  const resolved = resolveWritePath(ctx, params.path);
  const { absolutePath, relativePath } = resolved;
  const content = readFileSync(absolutePath, 'utf8');
  const occurrences = content.split(params.old_string).length - 1;
  if (occurrences === 0) throw toolInputError('old_string was not found.');
  if (occurrences > 1 && params.replace_all !== true) throw toolInputError('old_string appears multiple times; set replace_all to true.');
  const next = params.replace_all === true ? content.split(params.old_string).join(params.new_string) : content.replace(params.old_string, params.new_string);
  writeFileSync(absolutePath, next, 'utf8');
  return { path: relativePath, ...(resolved.kind === 'record' ? { record_url: resolved.recordUrl } : {}), replacements: params.replace_all === true ? occurrences : 1, bytes: Buffer.byteLength(next, 'utf8'), edited: true };
}

function editAnalystBriefRecord(ctx: WorkspaceContext, params: { path: string; old_string: string; new_string: string; replace_all?: boolean }): unknown {
  const target = assertAnalystBriefRecordWritable(ctx, { path: params.path });
  const index = readRecordSlotIndex(ctx.projectRoot, target.cardId, 'brief');
  if (index.latest === null) throw toolInputError(`Cannot edit '${target.path}': no closed brief.md version exists.`);
  const latest = latestClosedRecordSlot(ctx.projectRoot, { cardId: target.cardId, filename: 'brief.md' });
  const content = readFileSync(latest.absolutePath, 'utf8');
  const occurrences = content.split(params.old_string).length - 1;
  if (occurrences === 0) throw toolInputError('old_string was not found.');
  if (occurrences > 1 && params.replace_all !== true) throw toolInputError('old_string appears multiple times; set replace_all to true.');
  const next = params.replace_all === true ? content.split(params.old_string).join(params.new_string) : content.replace(params.old_string, params.new_string);
  return writeAnalystBriefRecord(ctx, { path: target.path, content: next });
}

export async function applyProjectPatch(ctx: WorkspaceContext, params: { patch: string }): Promise<unknown> {
  if (!canWriteWorkspaceFiles(ctx.agentRole)) throw toolInputError(`${ctx.agentRole} cannot write project files.`);
  const affected = patchPaths(params.patch);
  if (affected.length === 0) throw toolInputError('Patch does not contain any file changes.');
  for (const path of affected) assertWritable(ctx.projectRoot, path);
  const check = spawnSync('git', ['apply', '--check', '--'], { cwd: ctx.projectRoot, input: params.patch, encoding: 'utf8' });
  if (check.status !== 0) throw toolInputError(check.stderr || check.stdout || 'Patch check failed.');
  const applied = spawnSync('git', ['apply', '--'], { cwd: ctx.projectRoot, input: params.patch, encoding: 'utf8' });
  if (applied.status !== 0) throw toolInputError(applied.stderr || applied.stdout || 'Patch apply failed.');
  return { changed_files: affected, applied: true };
}
