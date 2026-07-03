import * as childProcess from 'node:child_process';
import { lstatSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

import { isBinarySample } from './analyst-tool-helpers.js';
import { isReadBlocked, isWriteBlocked, looksLikeSecretPath, resolveContainedProjectPath } from '../workspace/index.js';
import { closeOpenRecordSlot, concreteRecordSlot, discardOpenRecordSlot, exposedRecordSlotDefinitionForFilename, latestClosedRecordSlot, openRecordSlot, readRecordSlotIndex, RECORD_OUTPUTS_RELATIVE_DIR, recordSlotDir, type OpenRecordSlot } from '../runtime/records/record-slots.js';
import type { AgentRole } from './tool-definition.js';
import type { CardStore } from '../cards/store-api.js';
import { readRuntimeState } from '../runtime/state-api.js';

const { spawnSync } = childProcess;

const DEFAULT_READ_LIMIT = 2000;
const DEFAULT_SEARCH_LIMIT = 200;
const MAX_SEARCH_LIMIT = 1000;
const SKIPPED_DIRS = new Set(['.git', 'node_modules', '.saivage', '.saivage-work', 'dist', 'build', '__pycache__']);

export type WorkspaceContext = { projectRoot: string; cardId?: string; agentRole?: AgentRole; store?: Pick<CardStore, 'read'> };
type ResolvedToolPath = { kind: 'project' | 'tmp' | 'system'; absolutePath: string; relativePath: string } | ({ kind: 'record' } & OpenRecordSlot);
type ScopedAgentContext = { cardId?: string; agentRole: AgentRole };

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

function systemDisplayPath(absolutePath: string): string {
  return `system://${absolutePath}`;
}

function resolveSystemPath(raw: string): { absolutePath: string; relativePath: string } {
  const target = decodeURIComponent(raw.slice('system://'.length));
  if (!target.startsWith('/')) throw toolInputError(`system:// paths must use an absolute path: '${raw}'.`);
  const absolutePath = resolve(target);
  return { absolutePath, relativePath: systemDisplayPath(absolutePath) };
}

function assertReadableSystemPath(raw: string): { absolutePath: string; relativePath: string } {
  const resolved = resolveSystemPath(raw);
  if (isHiddenPath('', resolved.absolutePath, normalizeRel(resolved.absolutePath))) throw toolInputError(`Access to '${resolved.relativePath}' is blocked for security reasons.`);
  return resolved;
}

function assertWritableSystemPath(raw: string): { absolutePath: string; relativePath: string } {
  const resolved = resolveSystemPath(raw);
  if (resolved.absolutePath === '/' || raw.endsWith('/')) throw toolInputError('write requires a file path, not a directory.');
  if (isWriteBlocked(normalizeRel(resolved.absolutePath)) || looksLikeSecretPath(resolved.absolutePath)) throw toolInputError(`Write access to '${resolved.relativePath}' is blocked for security reasons.`);
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

function resolveProjectSchemePath(path: string): string {
  return path.startsWith('project://') ? path.slice('project://'.length) : path;
}

function requireAgentRole(ctx: WorkspaceContext, scheme: string): ScopedAgentContext {
  if (!ctx.agentRole) throw toolInputError(`${scheme} paths require an active agent role.`);
  return { cardId: ctx.cardId, agentRole: ctx.agentRole };
}

function parseRecordUrlParts(ctx: WorkspaceContext, raw: string, defaultVersion: string): { agent: ScopedAgentContext; filename: string; cardId: string; version: string } {
  const agent = requireAgentRole(ctx, 'record://');
  const url = new URL(raw);
  const rawFilename = decodeURIComponent(`${url.hostname}${url.pathname}`);
  const filename = validRecordSegment(rawFilename, 'record filename', raw);
  if (!filename) throw toolInputError(`Invalid record URL '${raw}'.`);
  exposedRecordSlotDefinitionForFilename(filename);
  const cardId = validRecordSegment(url.searchParams.get('card') ?? agent.cardId ?? '', 'card id', raw);
  const version = url.searchParams.get('v') ?? defaultVersion;
  return { agent, filename, cardId, version };
}

function parseRecordUrl(ctx: WorkspaceContext, raw: string, mode: 'read' | 'write'): OpenRecordSlot {
  const { agent, filename, cardId, version } = parseRecordUrlParts(ctx, raw, mode === 'read' ? 'latest' : 'next');
  if (mode === 'write') {
    if (!agent.cardId) throw toolInputError('Record writes require an active card context.');
    assertRecordWrite(agent.agentRole, agent.cardId, cardId, filename, version);
    return openRecordSlot(ctx.projectRoot, { cardId, filename });
  }
  if (version === 'next') {
    const open = openRecordSlot(ctx.projectRoot, { cardId, filename });
    if (!agent.cardId || cardId !== agent.cardId || !exposedRecordSlotDefinitionForFilename(filename).writers.includes(agent.agentRole)) throw toolInputError('Only the owning agent may read its current open record slot.');
    return open;
  }
  if (version === 'latest') return latestClosedRecordSlot(ctx.projectRoot, { cardId, filename });
  const numeric = Number(version);
  if (!Number.isInteger(numeric) || numeric < 1) throw toolInputError(`Invalid record version '${version}'.`);
  const record = concreteRecordSlot(ctx.projectRoot, { cardId, filename, version: numeric });
  const index = readRecordSlotIndex(ctx.projectRoot, cardId, record.slot);
  const entry = index.versions[String(numeric)];
  if (entry.status !== 'closed' && !(entry.status === 'open' && cardId === agent.cardId && exposedRecordSlotDefinitionForFilename(filename).writers.includes(agent.agentRole))) throw toolInputError('Only closed records are readable outside the owning open slot.');
  return record;
}

function assertRecordWrite(role: AgentRole, currentCardId: string, cardId: string, filename: string, version: string): void {
  if (cardId !== currentCardId) throw toolInputError('Agents may write records only for their current card.');
  const definition = exposedRecordSlotDefinitionForFilename(filename);
  if (!definition.writers.includes(role)) throw toolInputError(`${role} cannot write record slot '${definition.slot}'.`);
  if (version !== 'next') throw toolInputError('Record writes must use v=next.');
}

function resolveTmpPath(ctx: WorkspaceContext, raw: string, mode: 'read' | 'write'): ResolvedToolPath {
  const agent = requireAgentRole(ctx, 'tmp://');
  const url = new URL(raw);
  const cardId = decodeURIComponent(url.hostname);
  const rel = decodeURIComponent(url.pathname.replace(/^\/+/, ''));
  if (!cardId || !rel || rel.includes('..')) throw toolInputError(`Invalid tmp URL '${raw}'.`);
  if (mode === 'write' && agent.agentRole !== 'analyst' && cardId !== agent.cardId) throw toolInputError('Agents may write tmp files only for their current card.');
  const projectRel = `.saivage-work/cards/${cardId}/tmp/${rel}`;
  const resolved = resolveProjectPath(ctx.projectRoot, projectRel, 'tmp path');
  return { kind: 'tmp', ...resolved };
}

function resolveToolPath(ctx: WorkspaceContext, raw: string, mode: 'read' | 'write'): ResolvedToolPath {
  if (raw.startsWith('record://')) return { kind: 'record', ...parseRecordUrl(ctx, raw, mode) };
  if (raw.startsWith('tmp://')) return resolveTmpPath(ctx, raw, mode);
  if (raw.startsWith('system://')) {
    if (mode === 'write' && !canWriteWorkspaceFiles(ctx.agentRole)) throw toolInputError(`${ctx.agentRole} cannot write system files.`);
    const resolved = mode === 'read' ? assertReadableSystemPath(raw) : assertWritableSystemPath(raw);
    return { kind: 'system', ...resolved };
  }
  const projectPath = resolveProjectSchemePath(raw);
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
    if (!clean || isAbsolute(clean) || clean.includes('..')) throw toolInputError(`Unsafe patch path '${raw}'.`);
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
      .filter((entry) => !isHiddenPath(ctx.projectRoot, entry.absolutePath, entry.relativePath))
      .map(({ name, type }) => ({ name, type }))
      .sort((a, b) => a.name.localeCompare(b.name));
    return { path: relativePath, ...(resolved.kind === 'record' ? { record_url: resolved.recordUrl } : {}), entries: entries.slice(offset, offset + limit), offset, limit, total_entries: entries.length, truncated: offset + limit < entries.length };
  }
  if (!st.isFile()) throw toolInputError(`Unsupported file type: ${relativePath}`);
  const buffer = readFileSync(absolutePath);
  if (isBinarySample(buffer.subarray(0, Math.min(buffer.length, 1024)))) throw toolInputError(`Cannot read binary file as text: ${relativePath}`);
  const lines = buffer.toString('utf8').split(/\r?\n/);
  const window = lines.slice(offset, offset + limit);
  return { path: relativePath, ...(resolved.kind === 'record' ? { record_url: resolved.recordUrl } : {}), content: window.join('\n'), offset, limit, total_lines: lines.length, truncated: offset + limit < lines.length };
}

export async function writeProject(ctx: WorkspaceContext, params: { path: string; content: string }): Promise<unknown> {
  if (ctx.agentRole === 'analyst' && params.path.startsWith('record://')) return writeAnalystBriefRecord(ctx, params);
  const resolved = resolveToolPath(ctx, params.path, 'write');
  const { absolutePath, relativePath } = resolved;
  mkdirSync(dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, params.content, 'utf8');
  return { path: relativePath, ...(resolved.kind === 'record' ? { record_url: resolved.recordUrl } : {}), bytes: Buffer.byteLength(params.content, 'utf8'), written: true };
}

export function authorizeWriteProject(ctx: WorkspaceContext, params: { path: string; content?: string }): void {
  if (ctx.agentRole === 'analyst' && params.path.startsWith('record://')) {
    assertAnalystBriefRecordWritable(ctx, params);
    return;
  }
  if (params.path.startsWith('record://')) {
    const { agent, filename, cardId, version } = parseRecordUrlParts(ctx, params.path, 'next');
    if (!agent.cardId) throw toolInputError('Record writes require an active card context.');
    assertRecordWrite(agent.agentRole, agent.cardId, cardId, filename, version);
    return;
  }
  if (params.path.startsWith('tmp://')) {
    resolveTmpPath(ctx, params.path, 'write');
    return;
  }
  if (params.path.startsWith('system://')) {
    if (!canWriteWorkspaceFiles(ctx.agentRole)) throw toolInputError(`${ctx.agentRole} cannot write system files.`);
    assertWritableSystemPath(params.path);
    return;
  }
  const projectPath = resolveProjectSchemePath(params.path);
  if (!canWriteWorkspaceFiles(ctx.agentRole)) throw toolInputError(`${ctx.agentRole} cannot write project files.`);
  assertWritable(ctx.projectRoot, projectPath);
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
  if (!params.path.startsWith('record://')) throw toolInputError('Analyst write only writes record://brief.md document records. It cannot write host or project files.');
  if (!ctx.store) throw new Error('Analyst record writes require a card store.');
  const runtimeState = readRuntimeState(ctx.projectRoot);
  if (runtimeState?.status !== 'stopped' && runtimeState?.status !== 'paused') throw toolInputError(`Analyst write requires runtime status stopped or paused before mutating card records. Current runtime status is ${runtimeState?.status ?? 'unknown'}.`);
  const target = parseAnalystBriefWriteUrl(params.path);
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

function parseAnalystBriefWriteUrl(raw: string): { cardId: string; path: string } {
  const url = new URL(raw);
  const filename = validRecordSegment(decodeURIComponent(`${url.hostname}${url.pathname}`), 'record filename', raw);
  if (filename !== 'brief.md') throw toolInputError('Analyst write only supports record://brief.md document writes.');
  const cardId = validRecordSegment(url.searchParams.get('card') ?? '', 'card id', raw);
  const version = url.searchParams.get('v') ?? 'next';
  if (version !== 'next') throw toolInputError('Analyst record writes must use v=next.');
  return { cardId, path: `record://brief.md?card=${encodeURIComponent(cardId)}&v=next` };
}

function validateBriefMarkdown(content: string): void {
  for (const heading of ['# Goal', '# Instructions', '# Acceptance Criteria']) {
    if (!content.includes(heading)) throw toolInputError(`brief.md must include '${heading}'.`);
  }
}

export async function globProject(ctx: WorkspaceContext, params: { directory: string; pattern: string; max_results?: number }): Promise<unknown> {
  const isRecordSearch = params.directory.startsWith('record://');
  const isSystemSearch = params.directory.startsWith('system://');
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
  if (st.isFile()) consider(absolutePath, relativePath);
  else walkFiles(ctx.projectRoot, absolutePath, consider, { includeHidden: isRecordSearch, root: isSystemSearch ? absolutePath : undefined, displayPath: isSystemSearch ? (abs) => systemDisplayPath(abs) : undefined });
  return { directory: relativePath, pattern: params.pattern, matches, truncated: matches.length >= limit };
}

export async function grepProject(ctx: WorkspaceContext, params: { pattern: string; path?: string; include?: string; max_results?: number }): Promise<unknown> {
  const isRecordSearch = params.path?.startsWith('record://') ?? false;
  const isSystemSearch = params.path?.startsWith('system://') ?? false;
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
      if (regex.test(lines[i])) matches.push({ path: rel, line: i + 1, preview: lines[i].slice(0, 500) });
      if (matches.length >= limit) return false;
    }
  };
  const st = statSync(target.absolutePath);
  if (st.isFile()) scan(target.absolutePath, target.relativePath);
  else walkFiles(ctx.projectRoot, target.absolutePath, scan, { includeHidden: isRecordSearch, root: isSystemSearch ? target.absolutePath : undefined, displayPath: isSystemSearch ? (abs) => systemDisplayPath(abs) : undefined });
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
  const agent = requireAgentRole(ctx, 'record://');
  const url = new URL(raw);
  const host = decodeURIComponent(url.hostname);
  const path = decodeURIComponent(url.pathname.replace(/^\/+/, ''));
  const cardId = validRecordSegment(host || url.searchParams.get('card') || agent.cardId || '', 'card id', raw);
  const slot = path ? validRecordSegment(path, 'record slot', raw) : '';
  const absolutePath = slot ? recordSlotDir(ctx.projectRoot, cardId, exposedRecordSlotDefinitionForFilename(slot.includes('.') ? slot : `${slot}.md`).slot) : join(ctx.projectRoot, RECORD_OUTPUTS_RELATIVE_DIR, cardId);
  const relativePath = normalizeRel(relative(ctx.projectRoot, absolutePath));
  const contained = resolveContainedProjectPath(ctx.projectRoot, relativePath);
  if (!contained.safe || contained.relativePath !== relativePath || !relativePath.startsWith(`${RECORD_OUTPUTS_RELATIVE_DIR}/${cardId}`)) throw toolInputError(`Invalid record search URL '${raw}'.`);
  return { absolutePath, relativePath };
}

function validRecordSegment(value: string, label: string, raw: string): string {
  if (!value || value === '.' || value === '..' || value.includes('/') || value.includes('\\')) throw toolInputError(`Invalid ${label} in record URL '${raw}'.`);
  return value;
}
