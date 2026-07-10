import {
  mkdirSync,
  existsSync,
  renameSync,
  readFileSync,
  readdirSync,
  statSync,
} from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import type { ProjectConfig } from '../schemas/index.js';
import { projectConfigSchema, runtimeStateSchema } from '../schemas/index.js';
import { isReadBlocked } from '../workspace/index.js';
import { redactTextForOutbound } from '../redaction/index.js';
import { writeFileAtomic } from './durable-write.js';
import { CardStore } from '../cards/card-store.js';
import { createDefaultRuntimeState } from '../runtime/default-state.js';
import { isLocked } from '../runtime/lock.js';
import { cardIdFromSessionId } from '../runtime/actors/ids.js';
import { saivageWorkRoot } from './layout.js';

const PRIOR_WORK_DIRNAME = `.saivage-${'work'}`;
const PRIOR_DURABLE_CARDS_SEGMENTS = ['outputs', 'cards'] as const;

export function readProjectFileAtomic(
  projectRoot: string,
  relativePath: string,
  opts?: { redactSecrets?: boolean },
): string {
  const cleanPath = relativePath.replace(/^\.\//, '');
  if (isAbsolute(cleanPath))
    throw new Error(`Failed to read "${cleanPath}": absolute paths are not allowed.`);
  const root = resolve(projectRoot);
  const absPath = resolve(root, cleanPath);
  const projectRelativePath = relative(root, absPath);
  if (projectRelativePath.startsWith('..') || isAbsolute(projectRelativePath))
    throw new Error(`Failed to read "${cleanPath}": path escapes the project root.`);
  if (isReadBlocked(projectRelativePath))
    throw new Error(
      `Access to "${projectRelativePath}" is blocked for security reasons. This file contains sensitive authentication data and cannot be read by agents.`,
    );
  let content: string;
  try {
    content = readFileSync(absPath, 'utf-8');
  } catch (err) {
    throw new Error(`Failed to read "${cleanPath}": ${(err as Error).message}`);
  }
  if (opts?.redactSecrets && projectRelativePath === '.saivage/saivage.yaml')
    content = redactTextForOutbound(content, 'operator.api', {
      source: 'file-tree.read-project-file',
    });
  return content;
}

function defaultProjectConfig(name: string): ProjectConfig {
  const now = new Date().toISOString();
  return {
    id: 'project',
    name,
    context: '',
    goals_summary: '',
    constraints: [],
    planner_enabled: true,
    created_at: now,
    updated_at: now,
  };
}

const SAIVAGE_DIRS: string[] = [
  'skills',
  'cards',
  'agents/conversations',
  'agents/runtime/actors/llm',
  'runtime',
  'tmp/state',
  'supervision',
  'instructions',
];

const LEGACY_REJECTED_ARTIFACTS: string[] = [
  'cards/by-id',
  'cards/history',
  'cards/tree',
  'cards/dependencies',
  'cards/dependencies/depends-on.json',
  'cards/dependencies/blocks.json',
  'cards/blocks.json',
  'agents/tool-deliveries',
  'agents/tool-call-statuses',
  'agents/llm-exchanges',
  'runtime/processes.json',
  'runtime/actors',
  'views',
];
const SAIVAGE_WORK_DIRS: string[] = ['cards', 'processes', 'downloads', 'quarantine', 'tmp/runtime', 'tmp/stash', 'tmp/uploads', 'tmp/previews'];

function validationHint(projectRoot: string): string {
  return `Legacy .saivage state is not supported. Move it aside or let Saivage discard it under ${join(projectRoot, '.saivage.discarded-<timestamp>')} and restart with empty state.`;
}

function ensureWorkDirs(projectRoot: string): void {
  const workRoot = saivageWorkRoot(projectRoot);
  for (const dir of SAIVAGE_WORK_DIRS) mkdirSync(join(workRoot, dir), { recursive: true });
}

function isValidJsonFile(
  path: string,
  schema: { safeParse: (value: unknown) => { success: boolean } },
): boolean {
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
    'cards',
    'agents/conversations',
    'agents/runtime/actors/llm',
    'runtime',
    'supervision',
  ];
  if (existsSync(join(saivageDir, ...PRIOR_DURABLE_CARDS_SEGMENTS))) return false;
  if (existsSync(join(projectRoot, PRIOR_WORK_DIRNAME))) return false;
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
  if (hasCardScopedConversationUnderAgents(saivageDir)) return false;
  if (hasV1ConversationSegments(saivageDir)) return false;
  return isValidJsonFile(join(saivageDir, 'project.json'), projectConfigSchema);
}

function hasCardScopedConversationUnderAgents(saivageDir: string): boolean {
  const conversationsDir = join(saivageDir, 'agents', 'conversations');
  if (!existsSync(conversationsDir)) return false;
  for (const entry of readdirSync(conversationsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    let sessionId: string;
    try {
      sessionId = decodeURIComponent(entry.name);
    } catch {
      return true;
    }
    try {
      if (cardIdFromSessionId(sessionId)) return true;
    } catch {
      return true;
    }
  }
  return false;
}

function hasV1ConversationSegments(saivageDir: string): boolean {
  for (const dir of currentConversationDirs(saivageDir)) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isFile() && /^seg-\d{3}\.jsonl$/.test(entry.name)) return true;
    }
  }
  return false;
}

function currentConversationDirs(saivageDir: string): string[] {
  const dirs: string[] = [];
  collectConversationDirs(join(saivageDir, 'agents', 'conversations'), dirs);
  const cardsRoot = join(saivageDir, 'cards');
  if (existsSync(cardsRoot)) {
    for (const cardEntry of readdirSync(cardsRoot, { withFileTypes: true })) {
      if (!cardEntry.isDirectory()) continue;
      collectConversationDirs(join(cardsRoot, cardEntry.name, 'conversations'), dirs);
    }
  }
  return dirs;
}

function collectConversationDirs(root: string, dirs: string[]): void {
  if (!existsSync(root)) return;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.isDirectory()) dirs.push(join(root, entry.name));
  }
}

function discardLegacyState(projectRoot: string, stamp: string): void {
  const saivageDir = join(projectRoot, '.saivage');
  const saivageWorkDir = join(projectRoot, PRIOR_WORK_DIRNAME);
  if (existsSync(saivageDir)) renameSync(saivageDir, join(projectRoot, `.saivage.discarded-${stamp}`));
  if (existsSync(saivageWorkDir)) renameSync(saivageWorkDir, join(projectRoot, `${PRIOR_WORK_DIRNAME}.discarded-${stamp}`));
}

function ensureCleanSlateBoot(projectRoot: string): void {
  const saivageDir = join(projectRoot, '.saivage');
  const saivageWorkDir = join(projectRoot, PRIOR_WORK_DIRNAME);
  if (!existsSync(saivageDir) && !existsSync(saivageWorkDir)) return;
  if (isNewSaivageState(projectRoot)) return;
  if (isLocked(projectRoot)) throw new Error(`Cannot discard legacy Saivage state while runtime lock '${join(projectRoot, '.saivage', 'work', 'tmp', 'runtime', 'runtime.lock')}' is held. Stop the runtime first.`);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  discardLegacyState(projectRoot, stamp);
}

export function explainStateValidationRejection(
  projectRoot: string,
  stateKind: string,
  details: string,
): never {
  throw new Error(`${stateKind} validation failed: ${details}. ${validationHint(projectRoot)}`);
}

export function initProjectTree(projectRoot: string): { projectRoot: string } {
  ensureCleanSlateBoot(projectRoot);
  const saivageDir = join(projectRoot, '.saivage');
  const projectJsonPath = join(saivageDir, 'project.json');
  if (existsSync(projectJsonPath)) { ensureWorkDirs(projectRoot); return { projectRoot }; }
  const name = projectRoot.split('/').pop() || 'saivage-project';
  for (const dir of SAIVAGE_DIRS) mkdirSync(join(saivageDir, dir), { recursive: true });
  ensureWorkDirs(projectRoot);
  writeFileAtomic(projectJsonPath, JSON.stringify(defaultProjectConfig(name), null, 2) + '\n');
  writeFileAtomic(join(saivageDir, 'skills', 'index.json'), JSON.stringify([], null, 2) + '\n');
  writeFileAtomic(join(saivageDir, 'runtime', 'events.jsonl'), '');
  writeFileAtomic(join(saivageDir, 'runtime', 'errors.jsonl'), '');
  const runtimeState = runtimeStateSchema.parse(createDefaultRuntimeState());
  writeFileAtomic(join(saivageDir, 'tmp', 'state', 'runtime.json'), JSON.stringify({ version: 1, data: runtimeState }, null, 2) + '\n');
  writeFileAtomic(join(saivageDir, 'supervision', 'reviews.jsonl'), '');
  writeFileAtomic(
    join(saivageDir, 'supervision', 'quarantine-index.json'),
    JSON.stringify([], null, 2) + '\n',
  );
  writeFileAtomic(
    join(saivageDir, 'saivage.yaml'),
    'server:\n  host: "0.0.0.0"\n  port: 8080\nruntime: {}\n',
  );
  new CardStore(projectRoot).create({
    type: 'project',
    parent: null,
    depth: 0,
    title: name,
    brief: `# Goal\n\nDefine and execute the ${name} project.\n\n# Instructions\n\nUse this root card as the canonical project objective and planning anchor.\n\n# Acceptance Criteria\n\n- The project objective is captured in the root card brief.\n- Child work is created under this project card.\n`,
    status: 'backlog',
    tags: [],
    priority: 0,
    urgency: 'normal',
    created_by: 'analyst',
    depends_on: [],
    related: [],
    retries: 0,
  });
  return { projectRoot };
}

export function isInitialized(projectRoot: string): boolean {
  return existsSync(join(projectRoot, '.saivage', 'project.json'));
}
