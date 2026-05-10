import { mkdirSync, existsSync, writeFileSync, renameSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { ProjectConfig, CardRecord } from '../schemas/types.js';
import {
  isReadBlocked,
  redactSecrets,
} from './file-access-security.js';

// ── Atomic Write Helper ──────────────────────────────────────

/**
 * Write data to a file atomically using a temp file + rename.
 * Creates parent directories if they don't exist.
 */
export function writeFileAtomic(targetPath: string, data: string): void {
  const lastSep = targetPath.lastIndexOf('/');
  const dir = lastSep >= 0 ? targetPath.slice(0, lastSep) : '.';
  mkdirSync(dir, { recursive: true });

  const suffix = randomBytes(8).toString('hex');
  const tmpPath = `${targetPath}.tmp.${suffix}`;

  writeFileSync(tmpPath, data, 'utf-8');
  renameSync(tmpPath, targetPath);
}

// ── Atomic Read Helper ───────────────────────────────────────

/**
 * Read a project file with optional security checks.
 *
 * - When `redactSecrets` is true and the file is `.saivage/saivage.json`,
 *   secret values (API keys, tokens) are replaced with `[REDACTED]`.
 * - If the file is read-blocked (e.g., `.saivage/auth-profiles.json`),
 *   an error is thrown with a descriptive message.
 *
 * This is the main file-read integration point for agents — it ensures
 * agents cannot access blocked files and receive redacted configs.
 *
 * @param projectRoot - Absolute path to the project root.
 * @param relativePath - Project-relative file path.
 * @param opts - Options for security processing.
 * @returns The file content (possibly redacted).
 * @throws If the file is read-blocked or if the file does not exist.
 */
export function readProjectFileAtomic(
  projectRoot: string,
  relativePath: string,
  opts?: { redactSecrets?: boolean },
): string {
  // Strip leading ./ for consistent path matching
  const cleanPath = relativePath.replace(/^\.\//, '');

  // Check if this file is entirely blocked from reading
  if (isReadBlocked(cleanPath)) {
    throw new Error(
      `Access to "${cleanPath}" is blocked for security reasons. ` +
      `This file contains sensitive authentication data and cannot be read by agents.`,
    );
  }

  // Read the file
  const absPath = join(projectRoot, cleanPath);
  let content: string;
  try {
    content = readFileSync(absPath, 'utf-8');
  } catch (err) {
    throw new Error(
      `Failed to read "${cleanPath}": ${(err as Error).message}`,
    );
  }

  // Redact secrets if requested and the file is saivage.json
  if (opts?.redactSecrets && cleanPath === '.saivage/saivage.json') {
    content = redactSecrets(content);
  }

  return content;
}

// ── Default Content Factories ────────────────────────────────

function defaultProjectConfig(name: string): ProjectConfig {
  const now = new Date().toISOString();
  return {
    id: 'project',
    name,
    context: '',
    goals_summary: '',
    constraints: [],
    max_goal_depth: 5,
    planner_enabled: true,
    created_at: now,
    updated_at: now,
  };
}

function defaultProjectCard(): CardRecord {
  const now = new Date().toISOString();
  return {
    id: 'project',
    type: 'project',
    parent: null,
    depth: 0,
    title: 'project',
    description: '',
    status: 'backlog',
    tags: [],
    priority: 0,
    urgency: 'normal',
    created_by: 'analyst',
    created_at: now,
    updated_at: now,
    depends_on: [],
    blocks: [],
    related: [],
    acceptance: '',
    artifacts: [],
    attachments: [],
    retries: 0,
  };
}

function defaultCardIndexEntry(): {
  cards: Record<
    string,
    { id: string; type: string; parent: string | null; status: string; title: string }
  >;
} {
  return {
    cards: {
      project: {
        id: 'project',
        type: 'project',
        parent: null,
        status: 'backlog',
        title: 'project',
      },
    },
  };
}

function defaultDependsOnIndex(): Record<string, string[]> {
  return {};
}

function defaultBlocksIndex(): Record<string, string[]> {
  return {};
}

function defaultNotesQueue(): {
  entries: Array<{ card_id: string; note_id: string; timestamp: string; kind: string }>;
} {
  return { entries: [] };
}

// ── Directory Lists ──────────────────────────────────────────

const SAIVAGE_DIRS: string[] = [
  'skills',
  'cards/by-id',
  'cards/tree',
  'cards/dependencies',
  'cards/views',
  'diaries',
  'reviews/by-goal',
  'notes/by-card',
  'agents/sessions',
  'agents/messages',
  'runtime',
  'supervision',
  'views',
  'instructions',
];

const SAIVAGE_WORK_DIRS: string[] = [
  'cards',
  'processes',
  'downloads',
  'quarantine',
  'tmp/runtime',
  'tmp/stash',
  'tmp/uploads',
  'tmp/previews',
];

// ── File Tree Initialization ─────────────────────────────────

/**
 * Initialize the project file tree under `.saivage/` and `.saivage-work/`.
 *
 * Creates all directories, scaffold files (empty arrays, default configs),
 * the project card, and associated indexes.
 *
 * Idempotent: if `.saivage/project.json` already exists, skips all creation.
 *
 * @param projectRoot - Absolute path to the project root directory.
 *    The project name is derived from the last segment of the path.
 * @returns The project root path.
 */
export function initProjectTree(projectRoot: string): { projectRoot: string } {
  const saivageDir = join(projectRoot, '.saivage');
  const saivageWorkDir = join(projectRoot, '.saivage-work');
  const projectJsonPath = join(saivageDir, 'project.json');

  // Idempotency check: if project.json exists, the tree is already initialized
  if (existsSync(projectJsonPath)) {
    return { projectRoot };
  }

  // Derive project name from directory name
  const name = projectRoot.split('/').pop() || 'saivage-project';

  // Phase 1: Create all directories
  for (const dir of SAIVAGE_DIRS) {
    mkdirSync(join(saivageDir, dir), { recursive: true });
  }
  for (const dir of SAIVAGE_WORK_DIRS) {
    mkdirSync(join(saivageWorkDir, dir), { recursive: true });
  }

  // Phase 2: Create scaffold files

  // project.json — ProjectConfig
  writeFileAtomic(projectJsonPath, JSON.stringify(defaultProjectConfig(name), null, 2) + '\n');

  // cards/by-id/project.json — the root project card
  writeFileAtomic(
    join(saivageDir, 'cards', 'by-id', 'project.json'),
    JSON.stringify(defaultProjectCard(), null, 2) + '\n',
  );

  // cards/index.json — card index with project entry
  writeFileAtomic(
    join(saivageDir, 'cards', 'index.json'),
    JSON.stringify(defaultCardIndexEntry(), null, 2) + '\n',
  );

  // cards/tree/project.children.json — empty children list
  writeFileAtomic(
    join(saivageDir, 'cards', 'tree', 'project.children.json'),
    JSON.stringify([], null, 2) + '\n',
  );

  // cards/dependencies/depends-on.json — empty depends_on index
  writeFileAtomic(
    join(saivageDir, 'cards', 'dependencies', 'depends-on.json'),
    JSON.stringify(defaultDependsOnIndex(), null, 2) + '\n',
  );

  // cards/dependencies/blocks.json — empty blocks index
  writeFileAtomic(
    join(saivageDir, 'cards', 'dependencies', 'blocks.json'),
    JSON.stringify(defaultBlocksIndex(), null, 2) + '\n',
  );

  // notes/queue.json — empty notes queue
  writeFileAtomic(
    join(saivageDir, 'notes', 'queue.json'),
    JSON.stringify(defaultNotesQueue(), null, 2) + '\n',
  );

  // views/leaderboard.json — empty leaderboard
  writeFileAtomic(
    join(saivageDir, 'views', 'leaderboard.json'),
    JSON.stringify([], null, 2) + '\n',
  );

  // views/saved-filters.json — empty saved filters
  writeFileAtomic(
    join(saivageDir, 'views', 'saved-filters.json'),
    JSON.stringify([], null, 2) + '\n',
  );

  // skills/index.json — empty skills index
  writeFileAtomic(join(saivageDir, 'skills', 'index.json'), JSON.stringify({}, null, 2) + '\n');

  // runtime/events.jsonl — empty events log
  writeFileAtomic(join(saivageDir, 'runtime', 'events.jsonl'), '');

  // runtime/errors.jsonl — empty errors log
  writeFileAtomic(join(saivageDir, 'runtime', 'errors.jsonl'), '');

  // supervision/reviews.jsonl — empty reviews log
  writeFileAtomic(join(saivageDir, 'supervision', 'reviews.jsonl'), '');

  // supervision/quarantine-index.json — empty quarantine index
  writeFileAtomic(
    join(saivageDir, 'supervision', 'quarantine-index.json'),
    JSON.stringify([], null, 2) + '\n',
  );

  return { projectRoot };
}

/**
 * Check whether a directory looks like an initialized Saivage project.
 * Returns true if `.saivage/project.json` exists.
 */
export function isInitialized(projectRoot: string): boolean {
  return existsSync(join(projectRoot, '.saivage', 'project.json'));
}
