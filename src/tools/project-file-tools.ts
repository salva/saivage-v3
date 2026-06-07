import * as childProcess from 'node:child_process';
import { lstatSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { z } from 'zod';

import { isBinarySample } from './analyst-tool-helpers.js';
import { describe, type UnifiedToolDefinition } from './tool-catalog.js';
import { isReadBlocked, isWriteBlocked, looksLikeSecretPath, resolveContainedProjectPath } from '../workspace/index.js';

const { spawnSync } = childProcess;

const DEFAULT_READ_LIMIT = 2000;
const DEFAULT_SEARCH_LIMIT = 200;
const MAX_SEARCH_LIMIT = 1000;
const SKIPPED_DIRS = new Set(['.git', 'node_modules', '.saivage', '.saivage-work', 'dist', 'build', '__pycache__']);

type WorkspaceContext = { projectRoot: string };

function normalizeRel(path: string): string {
  return path.replace(/\\/g, '/');
}

function resolveProjectPath(projectRoot: string, path: string, label: string): { absolutePath: string; relativePath: string } {
  const resolved = resolveContainedProjectPath(projectRoot, path);
  if (!resolved.safe || !resolved.relativePath) throw new Error(resolved.reason ?? `${label} must resolve inside the project root.`);
  return { absolutePath: resolved.absolutePath, relativePath: resolved.relativePath };
}

function isHiddenPath(projectRoot: string, absolutePath: string, relativePath: string): boolean {
  return isReadBlocked(relativePath) || looksLikeSecretPath(absolutePath) || relativePath.split('/').some((part) => SKIPPED_DIRS.has(part));
}

function assertReadable(projectRoot: string, path: string): { absolutePath: string; relativePath: string } {
  const resolved = resolveProjectPath(projectRoot, path, 'read path');
  if (isHiddenPath(projectRoot, resolved.absolutePath, resolved.relativePath)) throw new Error(`Access to '${resolved.relativePath}' is blocked for security reasons.`);
  return resolved;
}

function assertWritable(projectRoot: string, path: string): { absolutePath: string; relativePath: string } {
  const resolved = resolveProjectPath(projectRoot, path, 'write path');
  if (resolved.relativePath === '.' || resolved.relativePath.endsWith('/')) throw new Error('write requires a file path, not a directory.');
  if (resolved.relativePath === '.saivage' || resolved.relativePath.startsWith('.saivage/') || resolved.relativePath === '.saivage-work' || resolved.relativePath.startsWith('.saivage-work/')) throw new Error('Cannot modify Saivage internal state directories.');
  if (isWriteBlocked(resolved.relativePath) || looksLikeSecretPath(resolved.absolutePath)) throw new Error(`Write access to '${resolved.relativePath}' is blocked for security reasons.`);
  try {
    if (lstatSync(resolved.absolutePath).isSymbolicLink()) throw new Error(`Write access to symlink '${resolved.relativePath}' is blocked for security reasons.`);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  return resolved;
}

function parseNonNegativeInt(value: unknown, fallback: number, max = Number.MAX_SAFE_INTEGER): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || Number(value) < 0) throw new Error('Expected a non-negative integer.');
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

function walkFiles(projectRoot: string, start: string, visitor: (absolutePath: string, relativePath: string) => boolean | void): void {
  for (const entry of readdirSync(start, { withFileTypes: true })) {
    const absolutePath = join(start, entry.name);
    const relativePath = normalizeRel(relative(projectRoot, absolutePath));
    if (entry.isDirectory()) {
      if (SKIPPED_DIRS.has(entry.name) || isHiddenPath(projectRoot, absolutePath, relativePath)) continue;
      walkFiles(projectRoot, absolutePath, visitor);
      continue;
    }
    if (!entry.isFile() || isHiddenPath(projectRoot, absolutePath, relativePath)) continue;
    if (visitor(absolutePath, relativePath) === false) return;
  }
}

function patchPaths(patch: string): string[] {
  const paths = new Set<string>();
  for (const line of patch.split('\n')) {
    if (/^(?:new|deleted) file mode |^old mode |^new mode |^similarity index |^rename from |^rename to |^GIT binary patch/.test(line)) throw new Error('Unsupported patch feature. Only text add/modify/delete diffs are allowed.');
    const match = /^(?:---|\+\+\+)\s+(\S+)/.exec(line);
    if (!match) continue;
    const raw = match[1];
    if (raw === '/dev/null') continue;
    const clean = raw.replace(/^[ab]\//, '');
    if (!clean || isAbsolute(clean) || clean.includes('..')) throw new Error(`Unsafe patch path '${raw}'.`);
    paths.add(clean);
  }
  return [...paths];
}

export async function readProject(ctx: WorkspaceContext, params: { path: string; offset?: number; limit?: number; read_mode?: 'auto' | 'text' | 'multimodal' }): Promise<unknown> {
  const mode = params.read_mode ?? 'auto';
  if (mode === 'multimodal') throw new Error('multimodal read_mode is not supported by v3 project tools yet.');
  const { absolutePath, relativePath } = assertReadable(ctx.projectRoot, params.path);
  const st = statSync(absolutePath);
  const offset = parseNonNegativeInt(params.offset, 0);
  const limit = parseNonNegativeInt(params.limit, DEFAULT_READ_LIMIT, DEFAULT_READ_LIMIT);
  if (st.isDirectory()) {
    const entries = readdirSync(absolutePath, { withFileTypes: true })
      .map((entry) => ({ name: entry.name, type: entry.isDirectory() ? 'dir' : 'file', absolutePath: join(absolutePath, entry.name), relativePath: normalizeRel(join(relativePath === '.' ? '' : relativePath, entry.name)) }))
      .filter((entry) => !isHiddenPath(ctx.projectRoot, entry.absolutePath, entry.relativePath))
      .map(({ name, type }) => ({ name, type }))
      .sort((a, b) => a.name.localeCompare(b.name));
    return { path: relativePath, entries: entries.slice(offset, offset + limit), offset, limit, total_entries: entries.length, truncated: offset + limit < entries.length };
  }
  if (!st.isFile()) throw new Error(`Unsupported file type: ${relativePath}`);
  const buffer = readFileSync(absolutePath);
  if (isBinarySample(buffer.subarray(0, Math.min(buffer.length, 1024)))) throw new Error(`Cannot read binary file as text: ${relativePath}`);
  const lines = buffer.toString('utf8').split(/\r?\n/);
  const window = lines.slice(offset, offset + limit);
  return { path: relativePath, content: window.join('\n'), offset, limit, total_lines: lines.length, truncated: offset + limit < lines.length };
}

export async function writeProject(ctx: WorkspaceContext, params: { path: string; content: string }): Promise<unknown> {
  const { absolutePath, relativePath } = assertWritable(ctx.projectRoot, params.path);
  mkdirSync(dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, params.content, 'utf8');
  return { path: relativePath, bytes: Buffer.byteLength(params.content, 'utf8'), written: true };
}

export async function globProject(ctx: WorkspaceContext, params: { directory: string; pattern: string; max_results?: number }): Promise<unknown> {
  const { absolutePath, relativePath } = assertReadable(ctx.projectRoot, params.directory);
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
  else walkFiles(ctx.projectRoot, absolutePath, consider);
  return { directory: relativePath, pattern: params.pattern, matches, truncated: matches.length >= limit };
}

export async function grepProject(ctx: WorkspaceContext, params: { pattern: string; path?: string; include?: string; max_results?: number }): Promise<unknown> {
  const target = assertReadable(ctx.projectRoot, params.path ?? '.');
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
  else walkFiles(ctx.projectRoot, target.absolutePath, scan);
  return { pattern: params.pattern, matches, truncated: matches.length >= limit };
}

export async function editProject(ctx: WorkspaceContext, params: { path: string; old_string: string; new_string: string; replace_all?: boolean }): Promise<unknown> {
  const { absolutePath, relativePath } = assertWritable(ctx.projectRoot, params.path);
  const content = readFileSync(absolutePath, 'utf8');
  const occurrences = content.split(params.old_string).length - 1;
  if (occurrences === 0) throw new Error('old_string was not found.');
  if (occurrences > 1 && params.replace_all !== true) throw new Error('old_string appears multiple times; set replace_all to true.');
  const next = params.replace_all === true ? content.split(params.old_string).join(params.new_string) : content.replace(params.old_string, params.new_string);
  writeFileSync(absolutePath, next, 'utf8');
  return { path: relativePath, replacements: params.replace_all === true ? occurrences : 1, bytes: Buffer.byteLength(next, 'utf8'), edited: true };
}

export async function applyProjectPatch(ctx: WorkspaceContext, params: { patch: string }): Promise<unknown> {
  const affected = patchPaths(params.patch);
  if (affected.length === 0) throw new Error('Patch does not contain any file changes.');
  for (const path of affected) assertWritable(ctx.projectRoot, path);
  const check = spawnSync('git', ['apply', '--check', '--'], { cwd: ctx.projectRoot, input: params.patch, encoding: 'utf8' });
  if (check.status !== 0) throw new Error(check.stderr || check.stdout || 'Patch check failed.');
  const applied = spawnSync('git', ['apply', '--'], { cwd: ctx.projectRoot, input: params.patch, encoding: 'utf8' });
  if (applied.status !== 0) throw new Error(applied.stderr || applied.stdout || 'Patch apply failed.');
  return { changed_files: affected, applied: true };
}

export const projectFileTools: readonly UnifiedToolDefinition<string, any>[] = [
  { name: 'read', description: 'Read a project file or directory. Text reads support zero-based offset and line limit.', input: z.object({ path: z.string(), offset: z.number().int().optional(), limit: z.number().int().optional(), read_mode: z.enum(['auto', 'text', 'multimodal']).optional() }).strict(), roles: ['planner', 'executor', 'reviewer'], workspace: true },
  { name: 'write', description: 'Create or replace a project file.', input: z.object({ path: z.string(), content: z.string() }).strict(), roles: ['planner', 'executor'], workspace: true },
  { name: 'glob', description: 'Search project files by glob pattern under a project directory.', input: z.object({ directory: z.string(), pattern: z.string(), max_results: z.number().int().optional() }).strict(), roles: ['planner', 'executor', 'reviewer'], workspace: true },
  { name: 'grep', description: 'Search project text files with a JavaScript regular expression.', input: z.object({ pattern: z.string(), path: z.string().optional(), include: z.string().optional(), max_results: z.number().int().optional() }).strict(), roles: ['planner', 'executor', 'reviewer'], workspace: true },
  { name: 'edit', description: 'Replace exact text in one project file.', input: z.object({ path: z.string(), old_string: z.string(), new_string: z.string(), replace_all: z.boolean().optional() }).strict(), roles: ['planner', 'executor'], workspace: true },
  { name: 'apply_patch', description: 'Apply a text-only unified diff after project path validation.', input: z.object({ patch: describe(z.string(), 'Unified diff text.') }).strict(), roles: ['planner', 'executor'], workspace: true },
] as const;
