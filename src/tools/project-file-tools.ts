import * as childProcess from 'node:child_process';
import { closeSync, createReadStream, lstatSync, mkdirSync, openSync, readFileSync, readSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import type { z } from 'zod';

import type { AgentName } from '../schemas/index.js';
import { isBinarySample } from './analyst-tool-helpers.js';
import { redactTextForOutbound } from '../redaction/index.js';
import { assertRecordWrite, displayPathForResolved, globToRegExp, hasParentPathSegment, isHiddenPath, isWriteBlocked, listScopedPath, listVisibleDirectoryEntries, loadProjectSearchIgnore, looksLikeSecretPath, parseScopedPathScheme, resolveContainedProjectPath, resolveRecordWriteTarget, resolveScopedPath, scopedReadFilterRel, visitFiles, visitScopedFiles, type VfsResolved } from '../workspace/index.js';
import type { CardService } from '../cards/card-api.js';
import type { CardNotification } from '../schemas/index.js';
import type { NotifyCardResult } from '../runtime/runtime-api.js';
import { mutateRecord } from '../application/record-mutation-service.js';
import { buildScopedPathUrl, parseScopedPathUrl } from '../contracts/scoped-path-url.js';
import { ToolArgumentValidationError } from './invocation.js';
import { globWorkspaceInputSchema, grepWorkspaceInputSchema } from '../contracts/builtin-tool-inputs.js';
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

type GlobProjectParams = z.input<typeof globWorkspaceInputSchema>;
type GrepProjectParams = z.input<typeof grepWorkspaceInputSchema>;
type GrepMatch = { path: string; line: number; preview: string };

function searchWindow<T>(position: CollectionPosition, maxResults: number) {
  let total = 0;
  const retained: T[] = [];
  return {
    add(item: T): void {
      if (total >= position.item_index && retained.length < maxResults) retained.push(item);
      total += 1;
    },
    total: (): number => total,
    item: (globalIndex: number): T => retained[globalIndex - position.item_index]!,
  };
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

export async function globProject(ctx: WorkspaceContext, params: GlobProjectParams): Promise<unknown> {
  const position = params.position ?? { item_index: 0, item_byte_offset: 0 };
  const maxResults = params.max_results ?? 200;
  const cap = params.response_bytes ?? DISCOVERY_RESPONSE_MAX_BYTES;
  const scoped = resolveScopedPath(vfsCtx(ctx), params.directory, 'search');
  const pattern = globToRegExp(params.pattern);
  const window = searchWindow<string>(position, maxResults);
  if (scoped !== null) {
    await visitScopedFiles(vfsCtx(ctx), params.directory, async (entry) => {
      if (pattern.test(entry.matchPath) || pattern.test(entry.displayPath)) window.add(entry.displayPath);
    });
  } else {
    const resolved = { kind: 'project' as const, ...assertReadable(ctx.projectRoot, params.directory), isRoot: false };
    const { absolutePath, relativePath } = resolved;
    const consider = (abs: string, rel: string): void => {
      const within = abs === absolutePath ? relativePath : relative(absolutePath, abs).replace(/\\/g, '/');
      if (pattern.test(within) || pattern.test(rel)) window.add(rel);
    };
    const st = statSync(absolutePath);
    if (st.isFile()) consider(absolutePath, relativePath);
    else await visitFiles(ctx.projectRoot, absolutePath, async (abs, rel) => { consider(abs, rel); }, { includeHidden: false, projectSearchIgnore: loadProjectSearchIgnore(ctx.projectRoot, toolInputError) });
  }
  const total = window.total();
  return packCollectionData({ cap, total, position, maxItems: maxResults, item: window.item, render: (matches: CollectionPage) => ({ matches }) }).data;
}

export async function grepProject(ctx: WorkspaceContext, params: GrepProjectParams): Promise<unknown> {
  const raw = params.path ?? '.';
  const position = params.position ?? { item_index: 0, item_byte_offset: 0 };
  const maxResults = params.max_results ?? 200;
  const cap = params.response_bytes ?? DISCOVERY_RESPONSE_MAX_BYTES;
  const scoped = resolveScopedPath(vfsCtx(ctx), raw, 'search');
  let regex: RegExp;
  try {
    regex = new RegExp(params.pattern);
  } catch (error) {
    throw toolInputError(error instanceof Error ? error.message : String(error));
  }
  const include = params.include ? globToRegExp(params.include) : null;
  const window = searchWindow<GrepMatch>(position, maxResults);
  let contentTruncated = false;
  const onMatch = (match: GrepMatch): void => window.add(match);

  if (scoped !== null) {
    const redact = scoped.kind === 'work';
    await visitScopedFiles(vfsCtx(ctx), raw, async (entry) => {
      const outcome = entry.content === undefined
        ? await scanFile(entry.absolutePath!, entry.displayPath, regex, include, redact, onMatch)
        : scanRecordText(entry.content, entry.displayPath, regex, include, onMatch);
      contentTruncated ||= outcome.contentTruncated;
    });
  } else {
    const target = { kind: 'project' as const, ...assertReadable(ctx.projectRoot, raw), isRoot: false };
    const st = statSync(target.absolutePath);
    if (st.isFile()) {
      const outcome = await scanFile(target.absolutePath, displayPathForResolved(ctx.projectRoot, target), regex, include, false, onMatch);
      contentTruncated = outcome.contentTruncated;
    } else {
      await visitFiles(ctx.projectRoot, target.absolutePath, async (abs, rel) => {
        const outcome = await scanFile(abs, rel, regex, include, false, onMatch);
        contentTruncated ||= outcome.contentTruncated;
      }, { includeHidden: false, projectSearchIgnore: loadProjectSearchIgnore(ctx.projectRoot, toolInputError) });
    }
  }
  const total = window.total();
  return packCollectionData({
    cap,
    total,
    position,
    maxItems: maxResults,
    item: window.item,
    render: (matches: CollectionPage) => ({ matches, content_truncated: contentTruncated, max_line_chars: MAX_GREP_LINE_CHARS }),
  }).data;
}

interface GrepScanOutcome {
  contentTruncated: boolean;
}

function scanRecordText(content: string, displayPath: string, regex: RegExp, include: RegExp | null, onMatch: (match: GrepMatch) => void): GrepScanOutcome {
  if (include) { include.lastIndex = 0; if (!include.test(displayPath)) return { contentTruncated: false }; }
  let contentTruncated = false;
  for (const [index, rawLine] of content.split(/\r?\n/).entries()) {
    const line = rawLine.slice(0, MAX_GREP_LINE_CHARS);
    contentTruncated ||= line.length !== rawLine.length;
    regex.lastIndex = 0;
    if (regex.test(line)) onMatch({ path: displayPath, line: index + 1, preview: line.slice(0, 500) });
  }
  return { contentTruncated };
}

async function scanFile(absolutePath: string, displayPath: string, regex: RegExp, include: RegExp | null, redact: boolean, onMatch: (match: GrepMatch) => void): Promise<GrepScanOutcome> {
  if (include) {
    include.lastIndex = 0;
    if (!include.test(displayPath)) return { contentTruncated: false };
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
      onMatch({ path: displayPath, line: lineNumber, preview: redact ? redactTextForOutbound(preview) : preview });
    }
    linePrefix = '';
    lineChars = 0;
    lineNumber += 1;
  };

  const consumeText = (text: string) => {
    for (const char of text) {
      if (char === '\n') {
        pendingCarriageReturn = false;
        finishLine();
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
          return { contentTruncated: false };
        }
        classified = true;
        consumeText(decoder.write(initial));
      } else {
        consumeText(decoder.write(chunk));
      }
    }

    if (!classified) {
      const initial = Buffer.concat(initialChunks, initialBytes);
      if (isBinarySample(initial)) return { contentTruncated: false };
      consumeText(decoder.write(initial));
    }
    consumeText(decoder.end());
    if (pendingCarriageReturn) append('\r');
    finishLine();
    return { contentTruncated };
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
