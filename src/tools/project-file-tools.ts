import * as childProcess from 'node:child_process';
import { lstatSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative } from 'node:path';

import type { AgentRole } from '../schemas/index.js';
import { isBinarySample } from './analyst-tool-helpers.js';
import { redactTextForOutbound } from '../redaction/index.js';
import { assertRecordWrite, isReadBlocked, isWriteBlocked, looksLikeSecretPath, parseScopedPathScheme, resolveContainedProjectPath, resolveRecordSearchTarget, resolveRecordWriteTarget, scopedPathResolvers, workUrlFromAbsolutePath, type ResolvedScopedPath, type ScopedPathScheme } from '../workspace/index.js';
import { closeOpenRecordSlot, discardOpenRecordSlot, openRecordSlot, readRecordSlotIndex } from '../runtime/records/record-slots.js';
import type { CardStore } from '../cards/store-api.js';
import { readRuntimeState } from '../runtime/state-api.js';

const { spawnSync } = childProcess;

const DEFAULT_READ_LIMIT = 2000;
const DEFAULT_SEARCH_LIMIT = 200;
const MAX_SEARCH_LIMIT = 1000;
const SKIPPED_DIRS = new Set(['.git', 'node_modules', '.saivage', '.saivage-work', 'dist', 'build', '__pycache__']);

export type WorkspaceContext = { projectRoot: string; cardId?: string; agentRole?: AgentRole; store?: Pick<CardStore, 'read'> };
type ResolvedToolPath = ResolvedScopedPath;

export class WorkspaceToolInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkspaceToolInputError';
  }
}

function toolInputError(message: string): WorkspaceToolInputError {
  return new WorkspaceToolInputError(message);
}

function normalizeRel(path: string): string {
  return path.replace(/\\/g, '/');
}

function resolveProjectPath(projectRoot: string, path: string, label: string): { absolutePath: string; relativePath: string } {
  const resolved = resolveContainedProjectPath(projectRoot, path);
  if (!resolved.safe || !resolved.relativePath) throw toolInputError(resolved.reason ?? `${label} must resolve inside the project root.`);
  return { absolutePath: resolved.absolutePath, relativePath: resolved.relativePath };
}

function isHiddenPath(projectRoot: string, absolutePath: string, relativePath: string): boolean {
  return isReadBlocked(relativePath) || looksLikeSecretPath(absolutePath) || relativePath.split('/').some((part) => SKIPPED_DIRS.has(part));
}

function workRootOf(resolved: { kind?: string; workRoot?: unknown; absolutePath?: string; relativePath?: string }): string | undefined {
  return resolved.kind === 'work' && typeof resolved.workRoot === 'string' ? resolved.workRoot : undefined;
}

function displayPathForResolved(projectRoot: string, resolved: ResolvedToolPath, absolutePath = resolved.absolutePath): string {
  return resolved.kind === 'work' ? workUrlFromAbsolutePath(projectRoot, absolutePath) : resolved.relativePath;
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

function resolveToolPath(ctx: WorkspaceContext, raw: string, mode: 'read' | 'write'): ResolvedToolPath {
  let scheme: ScopedPathScheme | null;
  try {
    scheme = parseScopedPathScheme(raw);
  } catch (error) {
    throw toolInputError(error instanceof Error ? error.message : String(error));
  }
  if (scheme) {
    if ((scheme === 'project' || scheme === 'system') && mode === 'write' && !canWriteWorkspaceFiles(ctx.agentRole)) throw toolInputError(`${ctx.agentRole} cannot write ${scheme} files.`);
    const resolved = scopedPathResolvers[scheme]({ projectRoot: ctx.projectRoot, agent: { cardId: ctx.cardId, agentRole: ctx.agentRole }, fail: toolInputError }, raw, mode);
    if (mode === 'read' && resolved.kind !== 'record') {
      const workRoot = workRootOf(resolved);
      const filterRel = workRoot ? normalizeRel(relative(workRoot, resolved.absolutePath)) : resolved.kind === 'tmp' ? resolved.relativePath.replace(/^\.saivage-work\/cards\/[^/]+\/tmp\/?/, '') : resolved.relativePath;
      if (isHiddenPath(ctx.projectRoot, resolved.absolutePath, filterRel)) throw toolInputError(`Access to '${resolved.relativePath}' is blocked for security reasons.`);
    }
    if (mode === 'write' && resolved.kind !== 'record') {
      if (resolved.absolutePath === '/' || raw.endsWith('/') || (resolved.kind !== 'system' && (resolved.relativePath === '.' || resolved.relativePath.endsWith('/')))) throw toolInputError('write requires a file path, not a directory.');
      if (resolved.kind === 'project' && (resolved.relativePath === '.saivage' || resolved.relativePath.startsWith('.saivage/') || resolved.relativePath === '.saivage-work' || resolved.relativePath.startsWith('.saivage-work/'))) throw toolInputError('Cannot modify Saivage internal state directories.');
      if (isWriteBlocked(resolved.relativePath) || looksLikeSecretPath(resolved.absolutePath)) throw toolInputError(`Write access to '${resolved.relativePath}' is blocked for security reasons.`);
      try {
        if (lstatSync(resolved.absolutePath).isSymbolicLink()) throw toolInputError(`Write access to symlink '${resolved.relativePath}' is blocked for security reasons.`);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      }
    }
    return resolved;
  }
  const projectPath = raw;
  if (mode === 'write' && !canWriteWorkspaceFiles(ctx.agentRole)) throw toolInputError(`${ctx.agentRole} cannot write project files.`);
  const resolved = mode === 'read' ? assertReadable(ctx.projectRoot, projectPath) : assertWritable(ctx.projectRoot, projectPath);
  return { kind: 'project', ...resolved };
}

function parseNonNegativeInt(value: unknown, fallback: number, max = Number.MAX_SAFE_INTEGER): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || Number(value) < 0) throw toolInputError('Expected a non-negative integer.');
  return Math.min(Number(value), max);
}

function globSegmentToRegExp(segment: string): string {
  return segment.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]');
}

function globToRegExp(pattern: string): RegExp {
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

function walkFiles(projectRoot: string, start: string, visitor: (absolutePath: string, relativePath: string) => boolean | void, options: { includeHidden: boolean; root?: string; displayPath?: (absolutePath: string, relativePath: string) => string } = { includeHidden: false }): void {
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

export async function readProject(ctx: WorkspaceContext, params: { path: string; offset?: number; limit?: number; read_mode?: 'auto' | 'text' | 'multimodal' }): Promise<unknown> {
  const mode = params.read_mode ?? 'auto';
  if (mode === 'multimodal') throw toolInputError('multimodal read_mode is not supported by v3 project tools yet.');
  const resolved = resolveToolPath(ctx, params.path, 'read');
  const { absolutePath, relativePath } = resolved;
  const st = statSync(absolutePath);
  const offset = parseNonNegativeInt(params.offset, 0);
  const limit = parseNonNegativeInt(params.limit, DEFAULT_READ_LIMIT, DEFAULT_READ_LIMIT);
  if (st.isDirectory()) {
    const entries = readdirSync(absolutePath, { withFileTypes: true })
      .map((entry) => ({ name: entry.name, type: entry.isDirectory() ? 'dir' : 'file', absolutePath: join(absolutePath, entry.name), relativePath: normalizeRel(join(relativePath === '.' ? '' : relativePath, entry.name)) }))
      .filter((entry) => !isHiddenPath(ctx.projectRoot, entry.absolutePath, workRootOf(resolved) ? normalizeRel(relative(workRootOf(resolved)!, entry.absolutePath)) : entry.relativePath))
      .map(({ name, type }) => ({ name, type }))
      .sort((a, b) => a.name.localeCompare(b.name));
    return { path: displayPathForResolved(ctx.projectRoot, resolved), ...(resolved.kind === 'record' ? { record_url: resolved.recordUrl } : {}), entries: entries.slice(offset, offset + limit), offset, limit, total_entries: entries.length, truncated: offset + limit < entries.length };
  }
  if (!st.isFile()) throw toolInputError(`Unsupported file type: ${relativePath}`);
  const buffer = readFileSync(absolutePath);
  if (isBinarySample(buffer.subarray(0, Math.min(buffer.length, 1024)))) throw toolInputError(`Cannot read binary file as text: ${relativePath}`);
  const lines = buffer.toString('utf8').split(/\r?\n/);
  const window = lines.slice(offset, offset + limit);
  const content = resolved.kind === 'work' ? redactTextForOutbound(window.join('\n'), 'operator.api', { source: 'project-file-tools.read.work' }) : window.join('\n');
  return { path: displayPathForResolved(ctx.projectRoot, resolved), ...(resolved.kind === 'record' ? { record_url: resolved.recordUrl } : {}), content, offset, limit, total_lines: lines.length, truncated: offset + limit < lines.length };
}

export async function writeProject(ctx: WorkspaceContext, params: { path: string; content: string }): Promise<unknown> {
  if (ctx.agentRole === 'analyst' && params.path.startsWith('record:///')) return writeAnalystBriefRecord(ctx, params);
  const resolved = resolveToolPath(ctx, params.path, 'write');
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
    resolveToolPath(ctx, params.path, 'write');
    return;
  }
  if (params.path.startsWith('system:///')) {
    if (!canWriteWorkspaceFiles(ctx.agentRole)) throw toolInputError(`${ctx.agentRole} cannot write system files.`);
    resolveToolPath(ctx, params.path, 'write');
    return;
  }
  if (!canWriteWorkspaceFiles(ctx.agentRole)) throw toolInputError(`${ctx.agentRole} cannot write project files.`);
  resolveToolPath(ctx, params.path, 'write');
}

function writeAnalystBriefRecord(ctx: WorkspaceContext, params: { path: string; content: string }): unknown {
  const target = assertAnalystBriefRecordWritable(ctx, params);
  const card = ctx.store!.read(target.cardId)!;
  const open = openRecordSlot(ctx.projectRoot, { cardId: target.cardId, filename: 'brief.md' });
  try {
    writeFileSync(open.absolutePath, params.content, 'utf8');
    const closed = closeOpenRecordSlot(ctx.projectRoot, { cardId: target.cardId, filename: 'brief.md', writer: 'analyst', cardVersionSeq: card.version_seq });
    return { card_id: target.cardId, path: closed.relativePath, record_url: closed.recordUrl, bytes: Buffer.byteLength(params.content, 'utf8'), written: true };
  } catch (err) {
    discardOpenRecordSlot(ctx.projectRoot, { cardId: target.cardId, filename: 'brief.md', reason: 'analyst write failed' });
    throw err;
  }
}

function assertAnalystBriefRecordWritable(ctx: WorkspaceContext, params: { path: string; content?: string }): { cardId: string; path: string } {
  if (!params.path.startsWith('record:///')) throw toolInputError('Analyst write only writes record:///brief.md document records. It cannot write host or project files.');
  if (!ctx.store) throw new Error('Analyst record writes require a card store.');
  const runtimeState = readRuntimeState(ctx.projectRoot);
  if (runtimeState?.status !== 'stopped' && runtimeState?.status !== 'paused') throw toolInputError(`Analyst write requires runtime status stopped or paused before mutating card records. Current runtime status is ${runtimeState?.status ?? 'unknown'}.`);
  const target = resolveAnalystBriefWriteUrl(ctx, params.path);
  if (params.content !== undefined) {
    if (params.content.length === 0) throw toolInputError('brief.md content must not be empty.');
    validateBriefMarkdown(params.content);
  }
  const card = ctx.store.read(target.cardId);
  if (!card) throw toolInputError(`Card '${target.cardId}' not found.`);
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
  const isRecordSearch = params.directory.startsWith('record:///');
  const isSystemSearch = params.directory.startsWith('system:///');
  const isWorkSearch = params.directory.startsWith('work:///');
  const resolved = isRecordSearch
    ? resolveRecordSearchPath(ctx, params.directory)
    : resolveToolPath(ctx, params.directory, 'read');
  const { absolutePath, relativePath } = resolved;
  const st = statSync(absolutePath);
  const pattern = globToRegExp(params.pattern);
  const limit = parseNonNegativeInt(params.max_results, DEFAULT_SEARCH_LIMIT, MAX_SEARCH_LIMIT);
  const matches: string[] = [];
  const consider = (abs: string, rel: string): boolean | void => {
    const within = normalizeRel(relative(relativePath === '.' ? ctx.projectRoot : absolutePath, abs));
    if (pattern.test(within) || pattern.test(rel)) matches.push(rel);
    if (matches.length >= limit) return false;
  };
  if (st.isFile()) consider(absolutePath, isWorkSearch ? workUrlFromAbsolutePath(ctx.projectRoot, absolutePath) : relativePath);
  else walkFiles(ctx.projectRoot, absolutePath, consider, { includeHidden: isRecordSearch, root: isSystemSearch ? absolutePath : workRootOf(resolved), displayPath: isSystemSearch ? (abs) => `system:///${normalizeRel(abs).replace(/^\/+/, '')}` : isWorkSearch ? (abs) => workUrlFromAbsolutePath(ctx.projectRoot, abs) : undefined });
  return { directory: isWorkSearch ? workUrlFromAbsolutePath(ctx.projectRoot, absolutePath) : relativePath, pattern: params.pattern, matches, truncated: matches.length >= limit };
}

export async function grepProject(ctx: WorkspaceContext, params: { pattern: string; path?: string; include?: string; max_results?: number }): Promise<unknown> {
  const isRecordSearch = params.path?.startsWith('record:///') ?? false;
  const isSystemSearch = params.path?.startsWith('system:///') ?? false;
  const isWorkSearch = params.path?.startsWith('work:///') ?? false;
  const target = isRecordSearch
    ? resolveRecordSearchPath(ctx, params.path!)
    : resolveToolPath(ctx, params.path ?? '.', 'read');
  const regex = new RegExp(params.pattern);
  const include = params.include ? globToRegExp(params.include) : null;
  const limit = parseNonNegativeInt(params.max_results, DEFAULT_SEARCH_LIMIT, MAX_SEARCH_LIMIT);
  const matches: Array<{ path: string; line: number; preview: string }> = [];
  const scan = (abs: string, rel: string): boolean | void => {
    if (include && !include.test(rel)) return;
    const sample = readFileSync(abs);
    if (isBinarySample(sample.subarray(0, Math.min(sample.length, 1024)))) return;
    const lines = sample.toString('utf8').split(/\r?\n/);
    for (let i = 0; i < lines.length; i += 1) {
      if (regex.test(lines[i])) {
        const preview = lines[i].slice(0, 500);
        matches.push({ path: rel, line: i + 1, preview: isWorkSearch ? redactTextForOutbound(preview, 'operator.api', { source: 'project-file-tools.read.work' }) : preview });
      }
      if (matches.length >= limit) return false;
    }
  };
  const st = statSync(target.absolutePath);
  if (st.isFile()) scan(target.absolutePath, isWorkSearch ? workUrlFromAbsolutePath(ctx.projectRoot, target.absolutePath) : target.relativePath);
  else walkFiles(ctx.projectRoot, target.absolutePath, scan, { includeHidden: isRecordSearch, root: isSystemSearch ? target.absolutePath : workRootOf(target), displayPath: isSystemSearch ? (abs) => `system:///${normalizeRel(abs).replace(/^\/+/, '')}` : isWorkSearch ? (abs) => workUrlFromAbsolutePath(ctx.projectRoot, abs) : undefined });
  return { pattern: params.pattern, matches, truncated: matches.length >= limit };
}

export async function editProject(ctx: WorkspaceContext, params: { path: string; old_string: string; new_string: string; replace_all?: boolean }): Promise<unknown> {
  const resolved = resolveToolPath(ctx, params.path, 'write');
  const { absolutePath, relativePath } = resolved;
  const content = readFileSync(absolutePath, 'utf8');
  const occurrences = content.split(params.old_string).length - 1;
  if (occurrences === 0) throw toolInputError('old_string was not found.');
  if (occurrences > 1 && params.replace_all !== true) throw toolInputError('old_string appears multiple times; set replace_all to true.');
  const next = params.replace_all === true ? content.split(params.old_string).join(params.new_string) : content.replace(params.old_string, params.new_string);
  writeFileSync(absolutePath, next, 'utf8');
  return { path: relativePath, ...(resolved.kind === 'record' ? { record_url: resolved.recordUrl } : {}), replacements: params.replace_all === true ? occurrences : 1, bytes: Buffer.byteLength(next, 'utf8'), edited: true };
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

function resolveRecordSearchPath(ctx: WorkspaceContext, raw: string): { absolutePath: string; relativePath: string } {
  if (!ctx.agentRole) throw toolInputError('record:/// paths require an active agent role.');
  return resolveRecordSearchTarget({ projectRoot: ctx.projectRoot, agent: { cardId: ctx.cardId, agentRole: ctx.agentRole }, fail: toolInputError }, raw);
}
