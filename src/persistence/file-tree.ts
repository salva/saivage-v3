import { mkdirSync, existsSync, writeFileSync, renameSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { ProjectConfig, CardRecord } from '../schemas/index.js';
import {
  cardRecordSchema,
  projectConfigSchema,
} from '../schemas/index.js';
import { isReadBlocked } from '../workspace/index.js';
import { redactTextForOutbound } from '../redaction/index.js';

export function writeFileAtomic(targetPath: string, data: string): void {
  const lastSep = targetPath.lastIndexOf('/');
  const dir = lastSep >= 0 ? targetPath.slice(0, lastSep) : '.';
  mkdirSync(dir, { recursive: true });
  const suffix = randomBytes(8).toString('hex');
  const tmpPath = `${targetPath}.tmp.${suffix}`;
  writeFileSync(tmpPath, data, 'utf-8');
  renameSync(tmpPath, targetPath);
}

export function readProjectFileAtomic(projectRoot: string, relativePath: string, opts?: { redactSecrets?: boolean }): string {
  const cleanPath = relativePath.replace(/^\.\//, '');
  if (isAbsolute(cleanPath)) throw new Error(`Failed to read "${cleanPath}": absolute paths are not allowed.`);
  const root = resolve(projectRoot);
  const absPath = resolve(root, cleanPath);
  const projectRelativePath = relative(root, absPath);
  if (projectRelativePath.startsWith('..') || isAbsolute(projectRelativePath)) throw new Error(`Failed to read "${cleanPath}": path escapes the project root.`);
  if (isReadBlocked(projectRelativePath)) throw new Error(`Access to "${projectRelativePath}" is blocked for security reasons. This file contains sensitive authentication data and cannot be read by agents.`);
  let content: string;
  try { content = readFileSync(absPath, 'utf-8'); } catch (err) { throw new Error(`Failed to read "${cleanPath}": ${(err as Error).message}`); }
  if (opts?.redactSecrets && projectRelativePath === '.saivage/saivage.json') content = redactTextForOutbound(content, 'operator.api', { source: 'file-tree.read-project-file' });
  return content;
}

function defaultProjectConfig(name: string): ProjectConfig {
  const now = new Date().toISOString();
  return { id: 'project', name, context: '', goals_summary: '', constraints: [], max_goal_depth: 5, planner_enabled: true, created_at: now, updated_at: now };
}

function defaultProjectCard(): CardRecord {
  const now = new Date().toISOString();
  return {
    id: 'project',
    type: 'project',
    parent: null,
    depth: 0,
    position: 0,
    title: 'project',
    description: '',
    status: 'backlog',
    lifecycle: { status: 'backlog', result: null, error: null, completed_at: null },
    tags: [],
    priority: 0,
    urgency: 'normal',
    created_by: 'analyst',
    created_at: now,
    updated_at: now,
    version_seq: 1,
    depends_on: [],
    blocks: [],
    related: [],
    acceptance: '',
    artifacts: [],
    attachments: [],
    retries: 0,
  };
}


const SAIVAGE_DIRS: string[] = ['skills', 'cards/by-id', 'cards/history', 'cards/.commit', 'diaries', 'reviews/by-goal', 'agents/llm-exchanges', 'agents/messages', 'agents/sessions', 'runtime', 'tmp/state', 'supervision', 'views', 'instructions'];

const LEGACY_REJECTED_ARTIFACTS: string[] = [
  'cards/index.json',
  'cards/tree',
  'cards/dependencies',
  'cards/dependencies/depends-on.json',
  'cards/dependencies/blocks.json',
  'cards/blocks.json',
];
const SAIVAGE_WORK_DIRS: string[] = ['cards', 'processes', 'downloads', 'quarantine', 'tmp/runtime', 'tmp/stash', 'tmp/uploads', 'tmp/previews'];

function validationHint(projectRoot: string): string {
  return `Legacy .saivage state is not supported. Move it aside or let Saivage discard it under ${join(projectRoot, '.saivage.discarded-<timestamp>')} and restart with empty state.`;
}

function isValidJsonFile(path: string, schema: { safeParse: (value: unknown) => { success: boolean } }): boolean {
  if (!existsSync(path)) return false;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as unknown;
    return schema.safeParse(parsed).success;
  } catch {
    return false;
  }
}

function isNewSaivageState(projectRoot: string): boolean {
  const saivageDir = join(projectRoot, '.saivage');
  if (!existsSync(saivageDir)) return false;
  const requiredDirs = [
    'cards/by-id',
    'agents/sessions',
    'agents/messages',
    'runtime',
    'views',
    'supervision',
  ];
  for (const dir of requiredDirs) {
    try {
      if (!statSync(join(saivageDir, dir)).isDirectory()) return false;
    } catch {
      return false;
    }
  }
  // Reject any leftover legacy artifact from the pre-F13 layout.
  for (const artifact of LEGACY_REJECTED_ARTIFACTS) {
    if (existsSync(join(saivageDir, artifact))) return false;
  }
  const projectCardPath = join(saivageDir, 'cards', 'by-id', 'project.json');
  return isValidJsonFile(join(saivageDir, 'project.json'), projectConfigSchema)
    && isValidJsonFile(projectCardPath, cardRecordSchema);
}

function discardLegacySaivageDir(projectRoot: string): void {
  const saivageDir = join(projectRoot, '.saivage');
  const discardedDir = join(projectRoot, `.saivage.discarded-${new Date().toISOString().replace(/[:.]/g, '-')}`);
  renameSync(saivageDir, discardedDir);
}

function ensureCleanSlateBoot(projectRoot: string): void {
  const saivageDir = join(projectRoot, '.saivage');
  if (!existsSync(saivageDir)) return;
  if (isNewSaivageState(projectRoot)) return;
  discardLegacySaivageDir(projectRoot);
}

export function explainLegacyStateRejection(projectRoot: string, stateKind: string, details: string): never {
  throw new Error(`${stateKind} validation failed: ${details}. ${validationHint(projectRoot)}`);
}

export function initProjectTree(projectRoot: string): { projectRoot: string } {
  ensureCleanSlateBoot(projectRoot);
  const saivageDir = join(projectRoot, '.saivage');
  const saivageWorkDir = join(projectRoot, '.saivage-work');
  const projectJsonPath = join(saivageDir, 'project.json');
  if (existsSync(projectJsonPath)) return { projectRoot };
  const name = projectRoot.split('/').pop() || 'saivage-project';
  for (const dir of SAIVAGE_DIRS) mkdirSync(join(saivageDir, dir), { recursive: true });
  for (const dir of SAIVAGE_WORK_DIRS) mkdirSync(join(saivageWorkDir, dir), { recursive: true });
  writeFileAtomic(projectJsonPath, JSON.stringify(defaultProjectConfig(name), null, 2) + '\n');
  writeFileAtomic(join(saivageDir, 'cards', 'by-id', 'project.json'), JSON.stringify(defaultProjectCard(), null, 2) + '\n');
  writeFileAtomic(join(saivageDir, 'views', 'leaderboard.json'), JSON.stringify([], null, 2) + '\n');
  writeFileAtomic(join(saivageDir, 'views', 'saved-filters.json'), JSON.stringify([], null, 2) + '\n');
  writeFileAtomic(join(saivageDir, 'skills', 'index.json'), JSON.stringify([], null, 2) + '\n');
  writeFileAtomic(join(saivageDir, 'runtime', 'events.jsonl'), '');
  writeFileAtomic(join(saivageDir, 'runtime', 'errors.jsonl'), '');
  writeFileAtomic(join(saivageDir, 'supervision', 'reviews.jsonl'), '');
  writeFileAtomic(join(saivageDir, 'supervision', 'quarantine-index.json'), JSON.stringify([], null, 2) + '\n');
  writeFileAtomic(join(saivageDir, 'saivage.json'), JSON.stringify({ server: { port: 8080, host: '0.0.0.0' }, runtime: {} }, null, 2) + '\n');
  return { projectRoot };
}

export function isInitialized(projectRoot: string): boolean {
  return existsSync(join(projectRoot, '.saivage', 'project.json'));
}

export function listDiscardedSaivageDirs(projectRoot: string): string[] {
  return existsSync(projectRoot)
    ? readdirSync(projectRoot).filter((entry) => entry.startsWith('.saivage.discarded-'))
    : [];
}
