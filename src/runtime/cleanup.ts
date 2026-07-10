import { existsSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join, resolve, normalize } from 'node:path';
import type { CardStore } from '../cards/store-api.js';
import { saivageCardsRoot, saivageWorkRoot } from '../persistence/layout.js';

// ── Types ─────────────────────────────────────────────────────

export interface CleanupResult {
  /** Number of card tmp directories cleaned */
  cardTmpCleaned: number;
  /** Number of stale stash files removed */
  staleStashRemoved: number;
  /** Number of completed process dirs cleaned */
  processDirsCleaned: number;
}

export interface CleanStaleProcessOptions {
  /** Path to .saivage/work/ directory */
  saivageWorkDir: string;
  /** CardStore instance retained for the public cleanup API shape */
  store: CardStore;
  /** Absolute filesystem paths/directories that cleanup must preserve */
  preserve: Set<string>;
  /** Maximum age of completed process dirs before cleanup, in ms (default: 24h) */
  maxAgeMs?: number;
  /** Process ids known to be live in the current in-memory runtime */
  liveProcessIds?: ReadonlySet<string>;
}

type ConversationIndexForCleanup = {
  schema_version: 2;
  versions: Record<string, unknown>;
};

// ── Safety Helpers ────────────────────────────────────────────

/**
 * Resolve and normalize a path to prevent traversal attacks.
 * Returns the absolute normalized path, or null if the resolved
 * path escapes the expected root.
 */
function safeResolve(root: string, subpath: string): string | null {
  const absRoot = resolve(root);
  const resolved = resolve(absRoot, subpath);
  const norm = normalize(resolved);

  // Must be within root
  if (!norm.startsWith(absRoot + '/') && norm !== absRoot) {
    return null;
  }

  return norm;
}

// ── Public API: cleanCardTmp ──────────────────────────────────

/**
 * Remove only the tmp/ subdirectory under cards/<id>/.
 *
 * This is the safest cleanup target — tmp files within a card's
 * working area are always disposable.
 *
 * @param saivageWorkDir - Path to .saivage/work/ directory
 * @param cardId - Card ID whose tmp/ directory should be cleaned
 * @returns true if the tmp directory was removed, false if it didn't exist
 */
export function cleanCardTmp(saivageWorkDir: string, cardId: string): boolean {
  const tmpDir = safeResolve(saivageWorkDir, join('cards', cardId, 'tmp'));
  if (!tmpDir) return false;

  if (!existsSync(tmpDir)) return false;

  // Safety: verify this is exactly a card tmp directory
  const absWork = resolve(saivageWorkDir);
  const expected = normalize(join(absWork, 'cards', cardId, 'tmp'));
  if (tmpDir !== expected) return false;

  // Double-check: it must contain exactly 'cards/<id>/tmp' in the disposable work area.
  const relFromWork = tmpDir.slice(absWork.length + 1);
  const cardTmpPattern = new RegExp(`^cards/${escapeRegex(cardId)}/tmp$`);
  if (!cardTmpPattern.test(relFromWork)) return false;

  try {
    rmSync(tmpDir, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

// ── Public API: cleanStaleStash ───────────────────────────────

/**
 * Remove stash files in .saivage/work/tmp/stash/ that are older
 * than maxAgeMs milliseconds.
 *
 * @param saivageWorkDir - Path to .saivage/work/ directory
 * @param maxAgeMs - Maximum age in milliseconds (default: 24 hours)
 * @returns Number of files removed
 */
export function cleanStaleStash(
  saivageWorkDir: string,
  preserve: Set<string>,
  maxAgeMs: number = 24 * 60 * 60 * 1000,
): number {
  const stashDir = safeResolve(saivageWorkDir, join('tmp', 'stash'));
  if (!stashDir) return 0;
  if (!existsSync(stashDir)) return 0;

  // Verify this is exactly the stash directory, not some other tmp dir
  const absWork = resolve(saivageWorkDir);
  const expectedStash = normalize(join(absWork, 'tmp', 'stash'));
  if (stashDir !== expectedStash) return 0;

  let removed = 0;
  const cutoff = Date.now() - maxAgeMs;

  let entries: string[];
  try {
    entries = readdirSync(stashDir);
  } catch {
    return 0;
  }

  for (const entry of entries) {
    const fullPath = join(stashDir, entry);
    try {
      if (preserve.has(normalize(resolve(fullPath)))) continue;
      const st = statSync(fullPath);
      if (st.mtimeMs < cutoff) {
        rmSync(fullPath, { recursive: true, force: true });
        removed++;
      }
    } catch {
      // skip files we can't stat or remove
    }
  }

  return removed;
}

// ── Public API: cleanStaleProcessOutput ───────────────────────

/**
  * Remove stale process output directories from .saivage/work/processes/ and .saivage/work/cards/<cardId>/processes/
  * whose output is no longer needed.
 *
 * A process directory is eligible for cleanup when:
  * 1. The process id is not present in liveProcessIds.
  * 2. No conversation URL references the output directory.
  * 3. The latest mtime of the directory/stdout/stderr is older than maxAgeMs.
 *
 * @param options - Options including saivageWorkDir, store, and maxAgeMs
 * @returns Number of process directories cleaned
 */
export function cleanStaleProcessOutput(options: CleanStaleProcessOptions): number {
  const { saivageWorkDir, preserve, maxAgeMs = 24 * 60 * 60 * 1000, liveProcessIds = new Set<string>() } = options;
  const processesDir = safeResolve(saivageWorkDir, 'processes');
  if (!processesDir) return 0;
  const absWork = resolve(saivageWorkDir);
  const expectedProcesses = normalize(join(absWork, 'processes'));
  if (processesDir !== expectedProcesses) return 0;

  let cleaned = 0;
  const cutoff = Date.now() - maxAgeMs;

  const cleanProcessDir = (entry: string, procDir: string): void => {

    const latestMtimeMs = latestProcessOutputMtimeMs(procDir);
    if (latestMtimeMs === null) return;

    // Never remove output for in-memory live processes.
    if (liveProcessIds.has(entry)) return;

    // Never remove output referenced by any conversation version.
    if (preserve.has(normalize(resolve(procDir)))) return;

    // Skip if too new
    if (latestMtimeMs >= cutoff) return;

    try {
      rmSync(procDir, { recursive: true, force: true });
      cleaned++;
    } catch {
      // skip directories we can't remove
    }
  };

  if (existsSync(processesDir)) {
    for (const entry of readdirSync(processesDir)) cleanProcessDir(entry, join(processesDir, entry));
  }
  const cardsDir = safeResolve(saivageWorkDir, 'cards');
  if (cardsDir && existsSync(cardsDir)) {
    for (const cardEntry of readdirSync(cardsDir, { withFileTypes: true })) {
      if (!cardEntry.isDirectory()) continue;
      const cardProcesses = safeResolve(saivageWorkDir, join('cards', cardEntry.name, 'processes'));
      if (!cardProcesses || !existsSync(cardProcesses)) continue;
      for (const entry of readdirSync(cardProcesses)) cleanProcessDir(entry, join(cardProcesses, entry));
    }
  }

  return cleaned;
}

// ── Public API: cleanAll ──────────────────────────────────────

/**
 * Run all safe cleanup operations and return a summary.
 *
 * This is the primary entry point for general cleanup. It runs each
 * targeted cleanup function and aggregates the results.
 *
 * @param saivageWorkDir - Path to .saivage/work/ directory
 * @param store - CardStore instance for artifact reference checks
 * @param options - Optional overrides for max ages
 * @returns CleanupResult with counts for each cleaned category
 */
export function cleanAll(
  saivageWorkDir: string,
  store: CardStore,
  options?: {
    stashMaxAgeMs?: number;
    processMaxAgeMs?: number;
    liveProcessIds?: ReadonlySet<string>;
  },
): CleanupResult {
  const result: CleanupResult = {
    cardTmpCleaned: 0,
    staleStashRemoved: 0,
    processDirsCleaned: 0,
  };

  const preserve = referencedRecoverableUrls(resolve(saivageWorkDir, '..', '..'));

  // 1. Clean card tmp directories
  // Iterate over all cards and clean their tmp dirs
  try {
    const allCards = store.list();
    for (const card of allCards) {
      if (cleanCardTmp(saivageWorkDir, card.id)) {
        result.cardTmpCleaned++;
      }
    }
  } catch {
    // best effort
  }

  // 2. Clean stale stash
  result.staleStashRemoved = cleanStaleStash(
    saivageWorkDir,
    preserve,
    options?.stashMaxAgeMs,
  );

  // 3. Clean stale process output
  result.processDirsCleaned = cleanStaleProcessOutput({
    saivageWorkDir,
    store,
    preserve,
    maxAgeMs: options?.processMaxAgeMs,
    liveProcessIds: options?.liveProcessIds,
  });

  return result;
}

export function referencedRecoverableUrls(projectRoot: string): Set<string> {
  const preserve = new Set<string>();
  for (const conversationDir of currentConversationDirs(projectRoot)) {
    const indexPath = join(conversationDir, 'index.json');
    if (!existsSync(indexPath)) continue;
    const index = parseConversationIndexForCleanup(indexPath);
    for (const version of Object.keys(index.versions)) {
      const versionPath = join(conversationDir, `${version}.jsonl`);
      if (!existsSync(versionPath)) throw new Error(`Conversation version '${versionPath}' listed in '${indexPath}' was not found.`);
      collectRecoverableUrlPaths(projectRoot, readFileSync(versionPath, 'utf8'), preserve);
    }
  }

  return preserve;
}

// ── Internal Helpers ──────────────────────────────────────────

function latestProcessOutputMtimeMs(procDir: string): number | null {
  let dirStat;
  try {
    dirStat = statSync(procDir);
  } catch {
    return null;
  }
  if (!dirStat.isDirectory()) return null;

  let latest = dirStat.mtimeMs;
  for (const name of ['stdout.log', 'stderr.log']) {
    const path = join(procDir, name);
    if (!existsSync(path)) continue;
    latest = Math.max(latest, statSync(path).mtimeMs);
  }
  return latest;
}

function parseConversationIndexForCleanup(indexPath: string): ConversationIndexForCleanup {
  const parsed = JSON.parse(readFileSync(indexPath, 'utf8')) as unknown;
  if (!parsed || typeof parsed !== 'object' || (parsed as { schema_version?: unknown }).schema_version !== 2) {
    throw new Error(`Conversation index '${indexPath}' must use schema_version 2 for cleanup reference scanning.`);
  }
  const versions = (parsed as { versions?: unknown }).versions;
  if (!versions || typeof versions !== 'object' || Array.isArray(versions)) {
    throw new Error(`Conversation index '${indexPath}' has no version map for cleanup reference scanning.`);
  }
  return { schema_version: 2, versions: versions as Record<string, unknown> };
}

function currentConversationDirs(projectRoot: string): string[] {
  const dirs: string[] = [];
  collectConversationDirs(join(projectRoot, '.saivage', 'agents', 'conversations'), dirs);
  const cardsRoot = saivageCardsRoot(projectRoot);
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

function collectRecoverableUrlPaths(projectRoot: string, jsonl: string, preserve: Set<string>): void {
  for (const line of jsonl.split('\n')) {
    if (!line) continue;
    const row = JSON.parse(line) as { kind?: unknown; content?: unknown };
    if ((row.kind !== 'tool_result' && row.kind !== 'context_compaction') || typeof row.content !== 'string') continue;
    for (const url of extractWorkUrls(row.content)) {
      const protectedPath = recoverableUrlPath(projectRoot, url);
      if (protectedPath) preserve.add(protectedPath);
    }
  }
}

function extractWorkUrls(content: string): string[] {
  return Array.from(content.matchAll(/work:\/\/\/[^\s`"'<>\])}]+/g), (match) => match[0].replace(/[.,;:]+$/u, ''));
}

function recoverableUrlPath(projectRoot: string, rawUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  if (url.protocol !== 'work:') return null;

  const saivageWorkDir = saivageWorkRoot(projectRoot);
  const pathname = decodeURIComponent(url.pathname);
  const stashPrefix = '/tmp/stash/';
  if (pathname.startsWith(stashPrefix)) {
    const stashFile = safeResolve(saivageWorkDir, join('tmp', 'stash', pathname.slice(stashPrefix.length)));
    return stashFile ? normalize(resolve(stashFile)) : null;
  }

  const processMatch = /^\/processes\/([^/]+)\//u.exec(pathname);
  if (processMatch) {
    const processDir = safeResolve(saivageWorkDir, join('processes', processMatch[1]));
    return processDir ? normalize(resolve(processDir)) : null;
  }

  const cardProcessMatch = /^\/cards\/([^/]+)\/processes\/([^/]+)\//u.exec(pathname);
  if (cardProcessMatch) {
    const processDir = safeResolve(saivageWorkDir, join('cards', cardProcessMatch[1], 'processes', cardProcessMatch[2]));
    return processDir ? normalize(resolve(processDir)) : null;
  }

  return null;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
