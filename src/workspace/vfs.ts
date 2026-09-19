import { readdirSync, statSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';

import { cardIdSchema, type AgentName } from '../schemas/index.js';
import { effectiveRecordContent } from '../persistence/canonical-record-artifacts.js';
import type { CardService } from '../cards/card-api.js';
type CompleteRecordReader=Pick<CardService,'readRecordCurrent'|'readRecordVersion'|'listDeclaredRecordMetadata'>;
import { isReadBlocked, looksLikeSecretPath } from './file-access-security.js';
import { parseScopedPathUrl } from '../contracts/scoped-path-url.js';
import { parseScopedPathScheme, resolveRecordReadTarget, resolveRecordWriteTarget, scopedPathResolvers, validRecordSegment, workUrlFromAbsolutePath, type ScopedPathScheme } from './scoped-path-schemes.js';
import { SAIVAGE_WORK_RELATIVE_DIR, saivageWorkRoot } from '../persistence/layout.js';
import { ModelRecordTargetWireSchema, type ModelRecordTargetWire } from '../contracts/record-mutation.js';
import { isProjectDirectoryExcluded, loadProjectSearchIgnore, type ProjectSearchIgnore } from './project-search-ignore.js';

type VfsMode = 'read' | 'write' | 'search';

interface VfsContext {
  projectRoot: string;
  agent?: { cardId?: string; agentName?: AgentName };
  fail: (message: string) => Error;
  records?: CompleteRecordReader;
}

export type VfsResolved =
  | { kind: 'project' | 'tmp' | 'system' | 'work'; absolutePath: string; relativePath: string; workRoot?: string; isRoot: boolean }
  | ({ kind: 'record'; cardId: string; isRoot: boolean } & (
    | { recordKind: 'directory' }
    | { recordKind: 'document'; filename: string; format:'markdown'; schema:string; state:'absent'|'open'|'closed'|'discarded'; headVersion:number|null; version: number|null; versionUrl:string|null; recordUrl: string; currentSelection: boolean; content: string; committedAt: string | null; size: number }
  ));

type VfsEntry = { name: string; type: 'dir' | 'file' };

type RecordSummary = ModelRecordTargetWire;

interface ScopedFileEntry {
  absolutePath?: string;
  content?: string;
  displayPath: string;
  matchPath: string;
}

type VfsListing =
  | { kind: 'entries'; entries: VfsEntry[] }
  | { kind: 'records'; records: RecordSummary[] };

const SKIPPED_DIRS = new Set(['.git', 'node_modules', '.saivage', 'dist', 'build', '__pycache__']);
const TMP_SCOPED_PREFIX_RE = /^\.saivage\/work\/cards\/[^/]+\/tmp\/?/;

type FsResolved = Extract<VfsResolved, { kind: 'project' | 'tmp' | 'system' | 'work' }>;
type RecordDirectoryResolved = Extract<VfsResolved, { kind: 'record'; recordKind: 'directory' }>;

function normalizeRel(path: string): string {
  return path.replace(/\\/g, '/');
}

export function isHiddenPath(projectRoot: string, absolutePath: string, relativePath: string): boolean {
  return isReadBlocked(relativePath) || looksLikeSecretPath(absolutePath) || relativePath.split('/').some((part) => SKIPPED_DIRS.has(part));
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function workRootOf(resolved: { kind?: string; workRoot?: unknown }): string | undefined {
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
    .sort((a, b) => compareStrings(a.name, b.name));
}

function globSegmentToRegExp(segment: string): string {
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

export async function visitFiles(projectRoot: string, start: string, visitor: (absolutePath: string, relativePath: string) => Promise<boolean | void>, options: { includeHidden: boolean; root?: string; displayPath?: (absolutePath: string, relativePath: string) => string; projectSearchIgnore?: ProjectSearchIgnore } = { includeHidden: false }): Promise<boolean | void> {
  const projectRelativeStart = normalizeRel(relative(projectRoot, start)) || '.';
  if (options.projectSearchIgnore && isProjectDirectoryExcluded(options.projectSearchIgnore, projectRelativeStart)) return;
  const root = options.root ?? projectRoot;
  const entries = (await readdir(start, { withFileTypes: true })).sort((a, b) => compareStrings(a.name, b.name));
  for (const entry of entries) {
    const absolutePath = join(start, entry.name);
    const relativePath = normalizeRel(relative(root, absolutePath));
    if (entry.isDirectory()) {
      if (!options.includeHidden && (SKIPPED_DIRS.has(entry.name) || isHiddenPath(projectRoot, absolutePath, relativePath))) continue;
      if (await visitFiles(projectRoot, absolutePath, visitor, options) === false) return false;
      continue;
    }
    if (!entry.isFile() || (!options.includeHidden && isHiddenPath(projectRoot, absolutePath, relativePath))) continue;
    if (await visitor(absolutePath, options.displayPath ? options.displayPath(absolutePath, relativePath) : relativePath) === false) return false;
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
      const workRoot = saivageWorkRoot(ctx.projectRoot);
      return { kind: 'work', absolutePath: workRoot, relativePath: SAIVAGE_WORK_RELATIVE_DIR, workRoot, isRoot: true };
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
  const segment = validRecordSegment(parsed.segments[0]!, 'card id', raw, ctx.fail);
  const parsedCardId = cardIdSchema.safeParse(segment);
  if (!parsedCardId.success) throw ctx.fail(`Invalid card id in record URL '${raw}'.`);
  const cardId = parsedCardId.data;
  return { kind: 'record', recordKind: 'directory', cardId, isRoot: false };
}

function resolveRecord(ctx: VfsContext, raw: string, mode: VfsMode): VfsResolved {
  if (!ctx.records) throw ctx.fail('Record operations require an injected persistence reader.');
  if (mode === 'search') return parseRecordCardDirectory(ctx, raw);
  if (mode === 'write') {
    const target = resolveRecordWriteTarget(ctx, raw);
    return { kind: 'record', recordKind: 'document', cardId: target.cardId, filename: target.filename,format:target.definition.format,schema:target.definition.schema,state:'absent',headVersion:null, version:null,versionUrl:null, content: '', committedAt: null, size: 0, recordUrl: target.currentUrl, currentSelection: true, isRoot: false };
  }

  let parsed;
  try {
    parsed = parseScopedPathUrl(raw, 'record');
  } catch (error) {
    throw ctx.fail(toolFacingErrorMessage(error));
  }
  const isDocument = parsed.query !== null || (parsed.segments.length === 1 && parsed.segments[0]!.endsWith('.md'));
  if (!isDocument) return parseRecordCardDirectory(ctx, raw);
  const target = resolveRecordReadTarget(ctx, raw);const projection=target.projection;
  const effective=projection?effectiveRecordContent(projection.artifact):null;const content=effective?.content??'';const currentSelection=target.parsed.version===null;
  return {kind:'record',recordKind:'document',cardId:target.parsed.cardId,filename:target.parsed.name,format:target.definition.format,schema:target.definition.schema,state:projection?.artifact.state??'absent',headVersion:projection?.headVersion??null,version:projection?.headVersion??null,versionUrl:projection?.versionUrl??null,content,committedAt:effective?.modifiedAt??null,size:Buffer.byteLength(content),recordUrl:currentSelection?target.parsed.currentUrl:projection!.versionUrl,currentSelection,isRoot:false};
}

export function resolveScopedPath(ctx: VfsContext, raw: string, mode: VfsMode): VfsResolved | null {
  const scheme = parseScheme(ctx, raw);
  if (scheme === null) return null;
  if (scheme === 'record') return resolveRecord(ctx, raw, mode);
  return delegateDirectoryScheme(ctx, raw, mode, scheme);
}

function recordSummaries(ctx: VfsContext, reader: CompleteRecordReader, cardId: string): RecordSummary[] {
  const result=reader.listDeclaredRecordMetadata(cardId);if(result.kind==='card-not-found')throw ctx.fail('Card not found.');return result.value.definitions
    .map(({definition,classification}) => {
      const latest = classification.kind==='present'?classification.projection:null;
      const currentUrl = `record:///${definition.filename}?card=${encodeURIComponent(cardId)}`;
      return ModelRecordTargetWireSchema.parse({ card_id: cardId, name: definition.filename, format: definition.format, schema: definition.schema, state: latest?.artifact.state ?? 'absent', head_version: latest?.headVersion ?? null, current_url: currentUrl, version_url: latest?.versionUrl ?? null });
    });
}

export async function listScopedPath(ctx: VfsContext, raw: string): Promise<VfsListing> {
  const resolved = resolveScopedPath(ctx, raw, 'search');
  if (resolved === null) throw ctx.fail(`Expected a scoped path, got '${raw}'.`);
  if (resolved.kind === 'record') return { kind: 'records', records: recordSummaries(ctx, ctx.records!, resolved.cardId) };
  const st = statSync(resolved.absolutePath);
  if (!st.isDirectory()) throw ctx.fail(`Path '${displayPathForResolved(ctx.projectRoot, resolved)}' is not a directory.`);
  return { kind: 'entries', entries: listVisibleDirectoryEntries(ctx, resolved) };
}

function displayPathCallback(projectRoot: string, resolved: FsResolved): ((absolutePath: string, relativePath: string) => string) | undefined {
  if (resolved.kind === 'system') return (abs) => `system:///${normalizeRel(abs).replace(/^\/+/, '')}`;
  if (resolved.kind === 'work') return (abs) => workUrlFromAbsolutePath(projectRoot, abs);
  if (resolved.kind === 'tmp') return (abs) => normalizeRel(relative(projectRoot, abs));
  return undefined;
}

export async function visitScopedFiles(ctx: VfsContext, raw: string, visitor: (entry: ScopedFileEntry) => Promise<boolean | void>): Promise<void> {
  const resolved = resolveScopedPath(ctx, raw, 'search');
  if (resolved === null) throw ctx.fail(`Expected a scoped path, got '${raw}'.`);

  if (resolved.kind === 'record') {
    const metadata=ctx.records!.listDeclaredRecordMetadata(resolved.cardId);if(metadata.kind==='card-not-found')throw ctx.fail('Card not found.');for (const {classification} of [...metadata.value.definitions].sort((a,b)=>compareStrings(a.definition.filename,b.definition.filename))) {
      const latest=classification.kind==='present'?classification.projection:null;
      if (latest === null) continue;
      const effective = effectiveRecordContent(latest.artifact); if (!effective) continue;
      if (await visitor({ content: effective.content, displayPath: latest.currentUrl, matchPath: latest.filename }) === false) return;
    }
    return;
  }

  const st = statSync(resolved.absolutePath);
  if (st.isFile()) {
    const filterRel = scopedReadFilterRel(resolved, resolved.absolutePath, resolved.relativePath);
    if (isHiddenPath(ctx.projectRoot, resolved.absolutePath, filterRel)) return;
    await visitor({ absolutePath: resolved.absolutePath, displayPath: displayPathForResolved(ctx.projectRoot, resolved), matchPath: resolved.relativePath });
    return;
  }

  const base = resolved.absolutePath;
  const projectSearchIgnore = resolved.kind === 'project' ? loadProjectSearchIgnore(ctx.projectRoot, ctx.fail) : undefined;
  await visitFiles(ctx.projectRoot, resolved.absolutePath, (absolutePath, displayPath) => visitor({
    absolutePath,
    displayPath,
    matchPath: normalizeRel(relative(base, absolutePath)),
  }), { includeHidden: false, root: resolved.kind === 'system' || resolved.kind === 'tmp' ? resolved.absolutePath : workRootOf(resolved), displayPath: displayPathCallback(ctx.projectRoot, resolved), projectSearchIgnore });
}
