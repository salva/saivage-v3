import * as childProcess from 'node:child_process';
import { closeSync, createReadStream, lstatSync, mkdirSync, openSync, readFileSync, readSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { StringDecoder } from 'node:string_decoder';

import type { AgentName } from '../schemas/index.js';
import { isBinarySample } from './analyst-tool-helpers.js';
import { redactTextForOutbound } from '../redaction/index.js';
import { assertRecordWrite, displayPathForResolved, globScopedPath, globToRegExp, hasParentPathSegment, isHiddenPath, isWriteBlocked, listScopedPath, listVisibleDirectoryEntries, looksLikeSecretPath, parseScopedPathScheme, resolveContainedProjectPath, resolveRecordWriteTarget, resolveScopedPath, scopedReadFilterRel, visitFiles, visitScopedFiles, walkFiles, type VfsResolved } from '../workspace/index.js';
import type { CardService } from '../cards/card-api.js';
import type { CardNotification } from '../schemas/index.js';
import type { NotifyCardResult } from '../runtime/runtime-api.js';
import { mutateRecord } from '../application/record-mutation-service.js';
import { buildScopedPathUrl, parseScopedPathUrl } from '../contracts/scoped-path-url.js';
import { ToolArgumentValidationError } from './invocation.js';
import {
  DISCOVERY_RESPONSE_MAX_BYTES,
  packCollectionData,
  packTextSliceData,
  utf8ByteLength,
  type CollectionPage,
  type CollectionPosition,
  type TextSlice,
} from './response-packer.js';

const { spawnSync } = childProcess;

const DEFAULT_SEARCH_LIMIT = 200;
const MAX_SEARCH_LIMIT = 1000;
export const MAX_READ_FILE_BYTES = 10 * 1024 * 1024;
const READ_HEAD_SAMPLE_BYTES = 4096;
export const MAX_GREP_LINE_CHARS = 2000;
const GREP_HEAD_SAMPLE_BYTES = 1024;
const GREP_STREAM_CHUNK_BYTES = 64 * 1024;

export type WorkspaceContext = { projectRoot: string; cardId?: string; agentName?: AgentName; store?: CardService; notifyCard?: (cardId: string, notification: CardNotification) => NotifyCardResult; onRecordWritten?: (name: string) => void };
type ResolvedToolPath = Extract<VfsResolved, { kind: 'project' | 'tmp' | 'system' | 'work' }> | Extract<VfsResolved, { kind: 'record'; recordKind: 'document' }>;
type WritableToolPath = Omit<Extract<VfsResolved, { kind: 'project' | 'tmp' | 'system' | 'work' }>, 'kind'> & { kind: 'project' | 'tmp' | 'system' };
type ReadPosition =
  | { kind: 'collection'; item_index: number; item_byte_offset: number }
  | { kind: 'text'; byte_offset: number };
type ReadProjectParams = { path: string; position?: ReadPosition; read_mode?: 'auto' | 'text'; metadata_only?: boolean; response_bytes?: number };

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

function assertReadable(projectRoot: string, path: string, label = 'read path'): { absolutePath: string; relativePath: string } {
  const resolved = resolveProjectPath(projectRoot, path, label);
  if (isHiddenPath(projectRoot, resolved.absolutePath, resolved.relativePath)) throw toolInputError(`Access to '${resolved.relativePath}' is blocked for security reasons.`);
  return resolved;
}

function assertWritable(projectRoot: string, path: string): { absolutePath: string; relativePath: string } {
  assertNoSymlinkComponents(projectRoot, isAbsolute(path) ? resolve(path) : resolve(projectRoot, path));
  const resolved = resolveProjectPath(projectRoot, path, 'write path');
  if (resolved.relativePath === '.' || resolved.relativePath.endsWith('/')) throw toolInputError('write requires a file path, not a directory.');
  if (resolved.relativePath === '.saivage' || resolved.relativePath.startsWith('.saivage/')) throw toolInputError('Cannot modify Saivage internal state directories.');
  if (isWriteBlocked(resolved.relativePath) || looksLikeSecretPath(resolved.absolutePath)) throw toolInputError(`Write access to '${resolved.relativePath}' is blocked for security reasons.`);
  try {
    if (lstatSync(resolved.absolutePath).isSymbolicLink()) throw toolInputError(`Write access to symlink '${resolved.relativePath}' is blocked for security reasons.`);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  return resolved;
}

function assertNoSymlinkComponents(root: string, target: string): void {
  const rel = relative(resolve(root), resolve(target));
  if (rel === '') return;
  let current = resolve(root);
  for (const segment of rel.split(/[\\/]/)) {
    current = join(current, segment);
    try {
      if (lstatSync(current).isSymbolicLink()) throw toolInputError(`Write access to symlink '${relative(root, current).replace(/\\/g, '/')}' is blocked for security reasons.`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
  }
}

function isSaivageInternalDestination(projectRoot: string, destination: string): boolean {
  const internalRoot = resolve(projectRoot, '.saivage');
  const fromInternalRoot = relative(internalRoot, resolve(destination));
  return fromInternalRoot === '' || (fromInternalRoot !== '..' && !fromInternalRoot.startsWith(`..${sep}`) && !isAbsolute(fromInternalRoot));
}

function vfsCtx(ctx: WorkspaceContext) {
  return { projectRoot: ctx.projectRoot, records: ctx.store, agent: { cardId: ctx.cardId, agentName: ctx.agentName }, fail: toolInputError };
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
  if (resolved.kind === 'project') assertNoSymlinkComponents(ctx.projectRoot, resolved.absolutePath);
  if (resolved.absolutePath === '/' || raw.endsWith('/') || (resolved.kind !== 'system' && (resolved.relativePath === '.' || resolved.relativePath.endsWith('/')))) throw toolInputError('write requires a file path, not a directory.');
  if (resolved.kind !== 'tmp' && isSaivageInternalDestination(ctx.projectRoot, resolved.absolutePath)) throw toolInputError('Cannot modify Saivage internal state directories.');
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

function resolveWritePath(ctx: WorkspaceContext, raw: string): WritableToolPath {
  const resolved = resolveScopedPath(vfsCtx(ctx), raw, 'write');
  if (resolved === null) {
    return { kind: 'project', ...assertWritable(ctx.projectRoot, raw), isRoot: false };
  }
  const writable = assertScopedWritable(ctx, raw, resolved);
  if (writable.kind === 'record') throw new Error('Logical record writes must be handled before filesystem path resolution.');
  if (writable.kind === 'work') throw new Error('Read-only work paths must be rejected by scoped path resolution.');
  return { ...writable, kind: writable.kind };
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
    if (!clean || isAbsolute(clean) || hasParentPathSegment(clean) || /^[a-z][a-z0-9+.-]*:\/\/\//i.test(clean)) throw toolInputError(`Unsafe patch path '${raw}'.`);
    paths.add(clean);
  }
  return [...paths];
}

export async function readProject(ctx: WorkspaceContext, params: ReadProjectParams): Promise<unknown> {
  const cap = params.response_bytes ?? DISCOVERY_RESPONSE_MAX_BYTES;
  const collectionPosition = (): CollectionPosition => {
    if (params.position === undefined) return { item_index: 0, item_byte_offset: 0 };
    if (params.position.kind !== 'collection') throw new ToolArgumentValidationError(`Path kind requires a collection position, got '${params.position.kind}'.`);
    return { item_index: params.position.item_index, item_byte_offset: params.position.item_byte_offset };
  };
  const textOffset = (): number => {
    if (params.position === undefined) return 0;
    if (params.position.kind !== 'text') throw new ToolArgumentValidationError(`Path kind requires a text position, got '${params.position.kind}'.`);
    return params.position.byte_offset;
  };
  const { resolved, scoped } = resolveReadPath(ctx, params.path);

  if (resolved.kind === 'record' && resolved.recordKind === 'directory') {
    const listing = await listScopedPath(vfsCtx(ctx), params.path);
    if (listing.kind !== 'records') throw new Error('Record directory listing did not return records.');
    if (params.metadata_only === true) {
      const { data } = packTextSliceData({
        text: `record:///${resolved.cardId}`,
        byteOffset: textOffset(),
        cap,
        render: (slice: TextSlice) => ({ metadata_only: true, is_directory: true, entries_count: listing.records.length, path: slice }),
      });
      return data;
    }
    const items = listing.records.map((record) => ({ name: record.name, format: record.format, state: record.state, head_version: record.head_version, version_url: record.version_url }));
    const { data } = packCollectionData({
      cap,
      total: items.length,
      position: collectionPosition(),
      item: (index) => items[index]!,
      render: (page: CollectionPage) => ({ path: `record:///${resolved.cardId}`, is_directory: true, total_entries: items.length, records: page }),
    });
    return data;
  }

  if (resolved.kind === 'record') {
    const base = {
      record_url: resolved.recordUrl,
      card_id: resolved.cardId,
      name: resolved.filename,
      format: resolved.format,
      state: resolved.state,
      head_version: resolved.headVersion,
      version: resolved.version,
      version_url: resolved.versionUrl,
      committed_at: resolved.committedAt,
      total_bytes: resolved.size,
    };
    const offset = textOffset();
    if (params.metadata_only === true) {
      const { data } = packTextSliceData({
        text: resolved.recordUrl,
        byteOffset: offset,
        cap,
        render: (slice: TextSlice) => ({ ...base, metadata_only: true, is_directory: false, path: slice }),
      });
      return data;
    }
    const { data } = packTextSliceData({
      text: resolved.content,
      byteOffset: offset,
      cap,
      render: (slice: TextSlice) => ({ ...base, path: resolved.recordUrl, content: slice }),
    });
    return data;
  }

  const { absolutePath, relativePath } = resolved;
  const st = statSync(absolutePath);
  const baseRecord = { path: displayPathForResolved(ctx.projectRoot, resolved) };

  if (params.metadata_only === true) {
    if (!st.isDirectory() && !st.isFile()) throw toolInputError(`Unsupported file type: ${relativePath}`);
    let entriesCount: number | undefined;
    if (st.isDirectory()) {
      const entries = await directoryEntriesForRead(ctx, params.path, resolved, scoped);
      entriesCount = entries.length;
    }
    const scalars = { metadata_only: true as const, is_directory: st.isDirectory() as boolean, size: st.size, mtime: st.mtime.toISOString() };
    const { data } = packTextSliceData({
      text: baseRecord.path,
      byteOffset: textOffset(),
      cap,
      render: (slice: TextSlice) => ({ ...scalars, ...(entriesCount !== undefined ? { entries_count: entriesCount } : {}), path: slice }),
    });
    return data;
  }

  if (st.isDirectory()) {
    const entries = await directoryEntriesForRead(ctx, params.path, resolved, scoped);
    const items = entries.map((entry) => ({ name: entry.name, type: entry.type }));
    const { data } = packCollectionData({
      cap,
      total: items.length,
      position: collectionPosition(),
      item: (index) => items[index]!,
      render: (page: CollectionPage) => ({ ...baseRecord, is_directory: true, total_entries: items.length, entries: page }),
    });
    return data;
  }

  if (!st.isFile()) throw toolInputError(`Unsupported file type: ${relativePath}`);
  const offset = textOffset();
  if (st.size > MAX_READ_FILE_BYTES) {
    const sample = readFileHead(absolutePath, READ_HEAD_SAMPLE_BYTES);
    if (isBinarySample(sample)) throw toolInputError(`Cannot read binary file as text: ${relativePath}`);
    return { ...baseRecord, content: null, total_bytes: st.size, too_large: true, max_bytes: MAX_READ_FILE_BYTES, message: `File is larger than ${MAX_READ_FILE_BYTES} bytes and was not read inline. Use metadata_only to inspect file metadata, or grep/glob to find narrower text targets before reading.` };
  }
  const buffer = readFileSync(absolutePath);
  if (isBinarySample(buffer.subarray(0, Math.min(buffer.length, READ_HEAD_SAMPLE_BYTES)))) throw toolInputError(`Cannot read binary file as text: ${relativePath}`);
  const content = resolved.kind === 'work' ? redactTextForOutbound(buffer.toString('utf8')) : buffer.toString('utf8');
  const { data } = packTextSliceData({
    text: content,
    byteOffset: offset,
    cap,
    render: (slice: TextSlice) => ({ ...baseRecord, size: st.size, mtime: st.mtime.toISOString(), total_bytes: utf8ByteLength(content), content: slice }),
  });
  return data;
}

export type WorkspaceMutationOutcome = import('../contracts/record-mutation.js').RecordMutationResult | { kind: 'applied'; data: Record<string, unknown> };

export async function writeProject(ctx: WorkspaceContext, params: { path: string; content: string }): Promise<WorkspaceMutationOutcome> {
  if (params.path.startsWith('record:///')) {
    if (!ctx.store || !ctx.agentName) throw new Error('Record writes require an injected card store and named agent.');
    return mutateRecord(ctx.store, { path: params.path, operation: 'write', content: params.content, surface: 'card_agent', agentName: ctx.agentName, cardId: ctx.cardId, requiredTools: ['write'], onRecordWritten: ctx.onRecordWritten });
  }
  const resolved = resolveWritePath(ctx, params.path);
  const { absolutePath, relativePath } = resolved;
  mkdirSync(dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, params.content, 'utf8');
  const scoped = parseScopedPathScheme(params.path);
  const destination_kind = scoped === null ? 'project_relative' : resolved.kind === 'project' ? 'project_url' : resolved.kind === 'tmp' ? 'tmp_url' : 'system_url';
  const target = scoped === null ? relativePath.replaceAll('\\', '/') : buildScopedPathUrl(resolved.kind, parseScopedPathUrl(params.path, resolved.kind).segments);
  return { kind: 'applied', data: { destination_kind, target, bytes: Buffer.byteLength(params.content, 'utf8'), written: true } };
}

export function authorizeWriteProject(ctx: WorkspaceContext, params: { path: string; content?: string }): void {
  if (params.path.startsWith('record:///')) {
    const target = resolveRecordWriteTarget(vfsCtx(ctx), params.path);
    assertRecordWrite(target.agent.cardId,target.cardId,toolInputError);
    return;
  }
  if (params.path.startsWith('work:///')) throw toolInputError('Webfetch save_as does not support work URLs.');
  resolveWritePath(ctx, params.path);
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
  let contentTruncated = false;

  const result = () => ({
    pattern: params.pattern,
    matches,
    truncated: matches.length >= limit || contentTruncated,
    ...(contentTruncated ? { content_truncated: true, max_line_chars: MAX_GREP_LINE_CHARS } : {}),
  });

  if (limit === 0) return result();

  if (scoped !== null) {
    const redact = scoped.kind === 'work';
    await visitScopedFiles(vfsCtx(ctx), raw, async (entry) => {
      if (matches.length >= limit) return false;
      const outcome = entry.content === undefined
        ? await scanFile(entry.absolutePath!, entry.displayPath, regex, include, redact, limit, matches)
        : scanRecordText(entry.content, entry.displayPath, regex, include, limit, matches);
      contentTruncated ||= outcome.contentTruncated;
      return outcome.stop ? false : undefined;
    });
    return result();
  }

  const target = { kind: 'project' as const, ...assertReadable(ctx.projectRoot, raw), isRoot: false };
  const st = statSync(target.absolutePath);
  if (st.isFile()) {
    const outcome = await scanFile(target.absolutePath, displayPathForResolved(ctx.projectRoot, target), regex, include, false, limit, matches);
    contentTruncated = outcome.contentTruncated;
  } else {
    await visitFiles(ctx.projectRoot, target.absolutePath, async (abs, rel) => {
      if (matches.length >= limit) return false;
      const outcome = await scanFile(abs, rel, regex, include, false, limit, matches);
      contentTruncated ||= outcome.contentTruncated;
      return outcome.stop ? false : undefined;
    }, { includeHidden: false });
  }
  return result();
}

interface GrepScanOutcome {
  stop: boolean;
  contentTruncated: boolean;
}

function scanRecordText(content: string, displayPath: string, regex: RegExp, include: RegExp | null, limit: number, matches: Array<{ path: string; line: number; preview: string }>): GrepScanOutcome {
  if (include) { include.lastIndex = 0; if (!include.test(displayPath)) return { stop: false, contentTruncated: false }; }
  let contentTruncated = false;
  for (const [index, rawLine] of content.split(/\r?\n/).entries()) {
    const line = rawLine.slice(0, MAX_GREP_LINE_CHARS);
    contentTruncated ||= line.length !== rawLine.length;
    regex.lastIndex = 0;
    if (regex.test(line)) matches.push({ path: displayPath, line: index + 1, preview: line.slice(0, 500) });
    if (matches.length >= limit) return { stop: true, contentTruncated };
  }
  return { stop: false, contentTruncated };
}

async function scanFile(absolutePath: string, displayPath: string, regex: RegExp, include: RegExp | null, redact: boolean, limit: number, matches: Array<{ path: string; line: number; preview: string }>): Promise<GrepScanOutcome> {
  if (include) {
    include.lastIndex = 0;
    if (!include.test(displayPath)) return { stop: false, contentTruncated: false };
  }

  const stream = createReadStream(absolutePath, { highWaterMark: GREP_STREAM_CHUNK_BYTES });
  const decoder = new StringDecoder('utf8');
  const initialChunks: Buffer[] = [];
  let initialBytes = 0;
  let classified = false;
  let linePrefix = '';
  let lineChars = 0;
  let lineNumber = 1;
  let contentTruncated = false;
  let pendingCarriageReturn = false;
  let stop = false;

  const append = (char: string) => {
    if (lineChars < MAX_GREP_LINE_CHARS) {
      linePrefix += char;
      lineChars += 1;
    } else {
      contentTruncated = true;
    }
  };

  const finishLine = () => {
    regex.lastIndex = 0;
    if (regex.test(linePrefix)) {
      const preview = linePrefix.slice(0, 500);
      matches.push({ path: displayPath, line: lineNumber, preview: redact ? redactTextForOutbound(preview) : preview });
    }
    if (matches.length >= limit) stop = true;
    linePrefix = '';
    lineChars = 0;
    lineNumber += 1;
  };

  const consumeText = (text: string) => {
    for (const char of text) {
      if (char === '\n') {
        pendingCarriageReturn = false;
        finishLine();
        if (stop) return;
        continue;
      }
      if (pendingCarriageReturn) append('\r');
      pendingCarriageReturn = char === '\r';
      if (!pendingCarriageReturn) append(char);
    }
  };

  try {
    for await (const rawChunk of stream) {
      const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);
      if (!classified) {
        initialChunks.push(chunk);
        initialBytes += chunk.length;
        if (initialBytes < GREP_HEAD_SAMPLE_BYTES) continue;
        const initial = Buffer.concat(initialChunks, initialBytes);
        if (isBinarySample(initial.subarray(0, GREP_HEAD_SAMPLE_BYTES))) {
          stream.destroy();
          return { stop: false, contentTruncated: false };
        }
        classified = true;
        consumeText(decoder.write(initial));
      } else {
        consumeText(decoder.write(chunk));
      }
      if (stop) {
        stream.destroy();
        return { stop: true, contentTruncated };
      }
    }

    if (!classified) {
      const initial = Buffer.concat(initialChunks, initialBytes);
      if (isBinarySample(initial)) return { stop: false, contentTruncated: false };
      consumeText(decoder.write(initial));
    }
    consumeText(decoder.end());
    if (stop) return { stop: true, contentTruncated };
    if (pendingCarriageReturn) append('\r');
    finishLine();
    return { stop, contentTruncated };
  } catch (error) {
    stream.destroy();
    throw error;
  }
}

export async function editProject(ctx: WorkspaceContext, params: { path: string; old_string: string; new_string: string; replace_all?: boolean }): Promise<WorkspaceMutationOutcome> {
  if (params.path.startsWith('record:///')) {
    if (!ctx.store || !ctx.agentName) throw new Error('Record edits require an injected card store and named agent.');
    return mutateRecord(ctx.store, { path: params.path, operation: 'edit', oldString: params.old_string, newString: params.new_string, replaceAll: params.replace_all, surface: 'card_agent', agentName: ctx.agentName, cardId: ctx.cardId, requiredTools: ['edit'], onRecordWritten: ctx.onRecordWritten });
  }
  const resolved = resolveWritePath(ctx, params.path);
  const { absolutePath, relativePath } = resolved;
  const content = readFileSync(absolutePath, 'utf8');
  const occurrences = content.split(params.old_string).length - 1;
  if (occurrences === 0) throw toolInputError('old_string was not found.');
  if (occurrences > 1 && params.replace_all !== true) throw toolInputError('old_string appears multiple times; set replace_all to true.');
  const next = params.replace_all === true ? content.split(params.old_string).join(params.new_string) : content.replace(params.old_string, params.new_string);
  writeFileSync(absolutePath, next, 'utf8');
  return { kind: 'applied', data: { path: relativePath, replacements: params.replace_all === true ? occurrences : 1, bytes: Buffer.byteLength(next, 'utf8'), edited: true } };
}

export async function applyProjectPatch(ctx: WorkspaceContext, params: { patch: string }): Promise<unknown> {
  const affected = patchPaths(params.patch);
  if (affected.length === 0) throw toolInputError('Patch does not contain any file changes.');
  for (const path of affected) assertWritable(ctx.projectRoot, path);
  const check = spawnSync('git', ['apply', '--check', '--'], { cwd: ctx.projectRoot, input: params.patch, encoding: 'utf8' });
  if (check.status !== 0) throw toolInputError(check.stderr || check.stdout || 'Patch check failed.');
  const applied = spawnSync('git', ['apply', '--'], { cwd: ctx.projectRoot, input: params.patch, encoding: 'utf8' });
  if (applied.status !== 0) throw toolInputError(applied.stderr || applied.stdout || 'Patch apply failed.');
  return { changed_files: affected, applied: true };
}
