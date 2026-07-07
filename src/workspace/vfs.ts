import { readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import type { AgentRole } from '../schemas/index.js';
import { exposedRecordSlotDefinitionForFilename, readRecordSlotIndex, recordSlotDefinitions, normalizeRecordUrl, type RecordSlotFormat } from '../runtime/records/record-slots.js';
import { isReadBlocked, looksLikeSecretPath } from './file-access-security.js';
import { parseScopedPathUrl } from './scoped-path-url.js';
import { parseScopedPathScheme, resolveRecordReadTarget, resolveRecordWriteTarget, scopedPathResolvers, validRecordSegment, workUrlFromAbsolutePath, type ScopedPathScheme } from './scoped-path-schemes.js';

export type VfsMode = 'read' | 'write' | 'search';

export interface VfsContext {
  projectRoot: string;
  agent?: { cardId?: string; agentRole?: AgentRole };
  fail: (message: string) => Error;
}

export type VfsResolved =
  | { kind: 'project' | 'tmp' | 'system' | 'work'; absolutePath: string; relativePath: string; workRoot?: string; isRoot: boolean }
  | ({ kind: 'record'; cardId: string; isRoot: boolean } & (
    | { recordKind: 'directory' }
    | { recordKind: 'document'; filename: string; slot: string; version: number; absolutePath: string; relativePath: string; recordUrl: string }
  ));

export type VfsEntry = { name: string; type: 'dir' | 'file' };

export interface RecordSummary {
  filename: string;
  path: string;
  url: string;
  latest: number | null;
  format: RecordSlotFormat;
  schema: string;
  writers: readonly AgentRole[];
  size: number | null;
  modifiedAt: string | null;
  writer: AgentRole | null;
}

export type VfsListing =
  | { kind: 'entries'; entries: VfsEntry[] }
  | { kind: 'records'; records: RecordSummary[] };

const SKIPPED_DIRS = new Set(['.git', 'node_modules', '.saivage', '.saivage-work', 'dist', 'build', '__pycache__']);
const TMP_SCOPED_PREFIX_RE = /^\.saivage-work\/cards\/[^/]+\/tmp\/?/;

type FsResolved = Extract<VfsResolved, { kind: 'project' | 'tmp' | 'system' | 'work' }>;
type RecordDirectoryResolved = Extract<VfsResolved, { kind: 'record'; recordKind: 'directory' }>;

function normalizeRel(path: string): string {
  return path.replace(/\\/g, '/');
}

export function isHiddenPath(projectRoot: string, absolutePath: string, relativePath: string): boolean {
  return isReadBlocked(relativePath) || looksLikeSecretPath(absolutePath) || relativePath.split('/').some((part) => SKIPPED_DIRS.has(part));
}

export function workRootOf(resolved: { kind?: string; workRoot?: unknown }): string | undefined {
  return resolved.kind === 'work' && typeof resolved.workRoot === 'string' ? resolved.workRoot : undefined;
}

export function scopedReadFilterRel(resolved: { kind?: string; workRoot?: unknown; relativePath: string }, candidateAbs: string, candidateScopedRel: string): string {
  const workRoot = workRootOf(resolved);
  if (workRoot) return normalizeRel(relative(workRoot, candidateAbs));
  if (resolved.kind === 'tmp') return candidateScopedRel.replace(TMP_SCOPED_PREFIX_RE, '');
  return candidateScopedRel;
}

export function listVisibleDirectoryEntries(ctx: { projectRoot: string }, resolved: FsResolved | { kind: 'project'; absolutePath: string; relativePath: string }): VfsEntry[] {
  const { absolutePath, relativePath } = resolved;
  return readdirSync(absolutePath, { withFileTypes: true })
    .map((entry) => ({ name: entry.name, type: entry.isDirectory() ? 'dir' as const : 'file' as const, absolutePath: join(absolutePath, entry.name), relativePath: normalizeRel(join(relativePath === '.' ? '' : relativePath, entry.name)) }))
    .filter((entry) => !isHiddenPath(ctx.projectRoot, entry.absolutePath, scopedReadFilterRel(resolved, entry.absolutePath, entry.relativePath)))
    .map(({ name, type }) => ({ name, type }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function globSegmentToRegExp(segment: string): string {
  return segment.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]');
}

export function globToRegExp(pattern: string): RegExp {
  const segments = normalizeRel(pattern).split('/');
  const parts = ['^'];
  for (let i = 0; i < segments.length; i += 1) {
    const segment = segments[i];
    if (segment === '**') parts.push(i === segments.length - 1 ? '.*' : '(?:[^/]+/)*');
    else parts.push(globSegmentToRegExp(segment));
    if (i < segments.length - 1 && segment !== '**') parts.push('/');
  }
  parts.push('$');
  return new RegExp(parts.join(''));
}

export function walkFiles(projectRoot: string, start: string, visitor: (absolutePath: string, relativePath: string) => boolean | void, options: { includeHidden: boolean; root?: string; displayPath?: (absolutePath: string, relativePath: string) => string } = { includeHidden: false }): void {
  const root = options.root ?? projectRoot;
  for (const entry of readdirSync(start, { withFileTypes: true })) {
    const absolutePath = join(start, entry.name);
    const relativePath = normalizeRel(relative(root, absolutePath));
    if (entry.isDirectory()) {
      if (!options.includeHidden && (SKIPPED_DIRS.has(entry.name) || isHiddenPath(projectRoot, absolutePath, relativePath))) continue;
      walkFiles(projectRoot, absolutePath, visitor, options);
      continue;
    }
    if (!entry.isFile() || (!options.includeHidden && isHiddenPath(projectRoot, absolutePath, relativePath))) continue;
    if (visitor(absolutePath, options.displayPath ? options.displayPath(absolutePath, relativePath) : relativePath) === false) return;
  }
}

export function displayPathForResolved(projectRoot: string, resolved: VfsResolved, absolutePath = 'absolutePath' in resolved ? resolved.absolutePath : ''): string {
  if (resolved.kind === 'record') return resolved.recordKind === 'document' ? resolved.recordUrl : `record:///${resolved.cardId}`;
  if (resolved.kind === 'work') return workUrlFromAbsolutePath(projectRoot, absolutePath);
  return resolved.relativePath;
}

function toolFacingErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function parseScheme(ctx: VfsContext, raw: string): ScopedPathScheme | null {
  try {
    return parseScopedPathScheme(raw);
  } catch (error) {
    throw ctx.fail(toolFacingErrorMessage(error));
  }
}

function delegateDirectoryScheme(ctx: VfsContext, raw: string, mode: VfsMode, scheme: Exclude<ScopedPathScheme, 'record'>): FsResolved {
  if ((scheme === 'project' || scheme === 'work' || scheme === 'system') && raw === `${scheme}:///`) {
    if (scheme === 'project') return { kind: 'project', absolutePath: ctx.projectRoot, relativePath: '.', isRoot: true };
    if (scheme === 'work') {
      const workRoot = join(ctx.projectRoot, '.saivage-work');
      return { kind: 'work', absolutePath: workRoot, relativePath: '.saivage-work', workRoot, isRoot: true };
    }
    return { kind: 'system', absolutePath: '/', relativePath: 'system:///', isRoot: true };
  }
  try {
    const resolved = scopedPathResolvers[scheme](ctx, raw, mode);
    if (resolved.kind === 'record') throw new Error(`Unexpected record resolver for ${scheme}.`);
    return { ...resolved, isRoot: false };
  } catch (error) {
    throw ctx.fail(toolFacingErrorMessage(error));
  }
}

function parseRecordCardDirectory(ctx: VfsContext, raw: string): RecordDirectoryResolved {
  let parsed;
  try {
    parsed = parseScopedPathUrl(raw, 'record');
  } catch (error) {
    throw ctx.fail(toolFacingErrorMessage(error));
  }
  if (parsed.query !== null || parsed.hadFragment) throw ctx.fail(`Invalid record search URL '${raw}'.`);
  if (parsed.segments.length !== 1) throw ctx.fail(`Invalid record search URL '${raw}'.`);
  const cardId = validRecordSegment(parsed.segments[0]!, 'card id', raw, ctx.fail);
  return { kind: 'record', recordKind: 'directory', cardId, isRoot: false };
}

function isExposedRecordFilename(filename: string): boolean {
  try {
    exposedRecordSlotDefinitionForFilename(filename);
    return true;
  } catch {
    return false;
  }
}

function resolveRecord(ctx: VfsContext, raw: string, mode: VfsMode): VfsResolved {
  if (mode === 'search') return parseRecordCardDirectory(ctx, raw);
  if (mode === 'write') {
    const target = resolveRecordWriteTarget(ctx, raw);
    const opened = scopedPathResolvers.record(ctx, raw, 'write');
    if (opened.kind !== 'record') throw new Error('Record write resolver returned a non-record path.');
    return { kind: 'record', recordKind: 'document', cardId: target.cardId, filename: opened.filename, slot: opened.slot, version: opened.version, absolutePath: opened.absolutePath, relativePath: opened.relativePath, recordUrl: opened.recordUrl, isRoot: false };
  }

  let parsed;
  try {
    parsed = parseScopedPathUrl(raw, 'record');
  } catch (error) {
    throw ctx.fail(toolFacingErrorMessage(error));
  }
  const isDocument = parsed.query !== null || (parsed.segments.length === 1 && isExposedRecordFilename(parsed.segments[0]!));
  if (!isDocument) return parseRecordCardDirectory(ctx, raw);
  const target = resolveRecordReadTarget(ctx, raw);
  return { kind: 'record', recordKind: 'document', cardId: target.cardId, filename: target.filename, slot: target.slot, version: target.version, absolutePath: target.absolutePath, relativePath: target.relativePath, recordUrl: target.recordUrl, isRoot: false };
}

export function resolveScopedPath(ctx: VfsContext, raw: string, mode: VfsMode): VfsResolved | null {
  const scheme = parseScheme(ctx, raw);
  if (scheme === null) return null;
  if (scheme === 'record') return resolveRecord(ctx, raw, mode);
  return delegateDirectoryScheme(ctx, raw, mode, scheme);
}

function recordSummaries(projectRoot: string, cardId: string): RecordSummary[] {
  return recordSlotDefinitions()
    .filter((definition) => definition.exposed)
    .map((definition) => {
      const index = readRecordSlotIndex(projectRoot, cardId, definition.slot);
      if (index.latest === null) return { filename: definition.filename, path: `record:///${definition.filename}`, url: `record:///${definition.filename}?card=${encodeURIComponent(cardId)}`, latest: null, format: definition.format, schema: definition.schema, writers: definition.writers, size: null, modifiedAt: null, writer: null };
      const entry = index.versions[String(index.latest)];
      if (entry?.status !== 'closed') return { filename: definition.filename, path: `record:///${definition.filename}`, url: `record:///${definition.filename}?card=${encodeURIComponent(cardId)}`, latest: null, format: definition.format, schema: definition.schema, writers: definition.writers, size: null, modifiedAt: null, writer: null };
      return { filename: definition.filename, path: `record:///${definition.filename}`, url: normalizeRecordUrl({ filename: definition.filename, cardId, version: index.latest }), latest: index.latest, format: definition.format, schema: definition.schema, writers: definition.writers, size: entry.size ?? null, modifiedAt: entry.committed_at ?? null, writer: entry.writer ?? null };
    });
}

export async function listScopedPath(ctx: VfsContext, raw: string): Promise<VfsListing> {
  const resolved = resolveScopedPath(ctx, raw, 'search');
  if (resolved === null) throw ctx.fail(`Expected a scoped path, got '${raw}'.`);
  if (resolved.kind === 'record') return { kind: 'records', records: recordSummaries(ctx.projectRoot, resolved.cardId) };
  const st = statSync(resolved.absolutePath);
  if (!st.isDirectory()) throw ctx.fail(`Path '${displayPathForResolved(ctx.projectRoot, resolved)}' is not a directory.`);
  return { kind: 'entries', entries: listVisibleDirectoryEntries(ctx, resolved) };
}

function displayPathCallback(projectRoot: string, resolved: FsResolved): ((absolutePath: string, relativePath: string) => string) | undefined {
  if (resolved.kind === 'system') return (abs) => `system:///${normalizeRel(abs).replace(/^\/+/, '')}`;
  if (resolved.kind === 'work') return (abs) => workUrlFromAbsolutePath(projectRoot, abs);
  return undefined;
}

export async function globScopedPath(ctx: VfsContext, raw: string, globPattern: string, limit: number): Promise<{ matches: string[]; truncated: boolean }> {
  const pattern = globToRegExp(globPattern);
  const resolved = resolveScopedPath(ctx, raw, 'search');
  if (resolved === null) throw ctx.fail(`Expected a scoped path, got '${raw}'.`);
  if (resolved.kind === 'record') {
    const matches: string[] = [];
    for (const record of recordSummaries(ctx.projectRoot, resolved.cardId)) {
      if (pattern.test(record.filename) || pattern.test(record.path) || pattern.test(record.url)) matches.push(record.url);
      if (matches.length >= limit) break;
    }
    return { matches, truncated: matches.length >= limit };
  }
  const st = statSync(resolved.absolutePath);
  const matches: string[] = [];
  const base = resolved.relativePath === '.' || resolved.kind === 'system' || resolved.kind === 'work' ? resolved.absolutePath : resolved.absolutePath;
  const consider = (abs: string, rel: string): boolean | void => {
    const within = normalizeRel(relative(base, abs));
    if (pattern.test(within) || pattern.test(rel)) matches.push(rel);
    if (matches.length >= limit) return false;
  };
  if (st.isFile()) consider(resolved.absolutePath, displayPathForResolved(ctx.projectRoot, resolved));
  else walkFiles(ctx.projectRoot, resolved.absolutePath, consider, { includeHidden: false, root: resolved.kind === 'system' ? resolved.absolutePath : workRootOf(resolved), displayPath: displayPathCallback(ctx.projectRoot, resolved) });
  return { matches, truncated: matches.length >= limit };
}
