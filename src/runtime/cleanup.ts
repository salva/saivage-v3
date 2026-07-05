import { existsSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join, resolve, normalize } from 'node:path';
import type { CardStore } from '../cards/store-api.js';
import type { ProcessRecord } from '../schemas/index.js';

// ── Types ─────────────────────────────────────────────────────

export interface CleanupResult {
  /** Number of card tmp directories cleaned */
  cardTmpCleaned: number;
  /** Number of stale stash files removed */
  staleStashRemoved: number;
  /** Number of completed process dirs cleaned */
  processDirsCleaned: number;
  /** Number of stale preview files removed */
  stalePreviewsRemoved: number;
  /** Number of stale upload files removed */
  staleUploadsRemoved: number;
}

export interface CleanStaleProcessOptions {
  /** Path to .saivage-work/ directory */
  saivageWorkDir: string;
  /** CardStore instance retained for the public cleanup API shape */
  store: CardStore;
  /** Maximum age of completed process dirs before cleanup, in ms (default: 24h) */
  maxAgeMs?: number;
}

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
 * @param saivageWorkDir - Path to .saivage-work/ directory
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
 * Remove stash files in .saivage-work/tmp/stash/ that are older
 * than maxAgeMs milliseconds.
 *
 * Never touches other tmp/ subdirectories (runtime/, uploads/, previews/).
 *
 * @param saivageWorkDir - Path to .saivage-work/ directory
 * @param maxAgeMs - Maximum age in milliseconds (default: 24 hours)
 * @returns Number of files removed
 */
export function cleanStaleStash(
  saivageWorkDir: string,
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

// ── Public API: cleanStalePreviews ────────────────────────────

/**
 * Remove stale preview files in .saivage-work/tmp/previews/ that
 * are older than maxAgeMs milliseconds.
 *
 * @param saivageWorkDir - Path to .saivage-work/ directory
 * @param maxAgeMs - Maximum age in milliseconds (default: 24 hours)
 * @returns Number of files removed
 */
export function cleanStalePreviews(
  saivageWorkDir: string,
  maxAgeMs: number = 24 * 60 * 60 * 1000,
): number {
  const previewsDir = safeResolve(saivageWorkDir, join('tmp', 'previews'));
  if (!previewsDir) return 0;
  if (!existsSync(previewsDir)) return 0;

  // Verify this is exactly the previews directory
  const absWork = resolve(saivageWorkDir);
  const expectedPreviews = normalize(join(absWork, 'tmp', 'previews'));
  if (previewsDir !== expectedPreviews) return 0;

  let removed = 0;
  const cutoff = Date.now() - maxAgeMs;

  let entries: string[];
  try {
    entries = readdirSync(previewsDir);
  } catch {
    return 0;
  }

  for (const entry of entries) {
    const fullPath = join(previewsDir, entry);
    try {
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

// ── Public API: cleanStaleUploads ─────────────────────────────

/**
 * Remove stale upload files in .saivage-work/tmp/uploads/ that
 * are older than maxAgeMs milliseconds.
 *
 * @param saivageWorkDir - Path to .saivage-work/ directory
 * @param maxAgeMs - Maximum age in milliseconds (default: 24 hours)
 * @returns Number of files removed
 */
export function cleanStaleUploads(
  saivageWorkDir: string,
  maxAgeMs: number = 24 * 60 * 60 * 1000,
): number {
  const uploadsDir = safeResolve(saivageWorkDir, join('tmp', 'uploads'));
  if (!uploadsDir) return 0;
  if (!existsSync(uploadsDir)) return 0;

  // Verify this is exactly the uploads directory
  const absWork = resolve(saivageWorkDir);
  const expectedUploads = normalize(join(absWork, 'tmp', 'uploads'));
  if (uploadsDir !== expectedUploads) return 0;

  let removed = 0;
  const cutoff = Date.now() - maxAgeMs;

  let entries: string[];
  try {
    entries = readdirSync(uploadsDir);
  } catch {
    return 0;
  }

  for (const entry of entries) {
    const fullPath = join(uploadsDir, entry);
    try {
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
 * Remove completed (exited/failed/killed) process output directories
 * from .saivage-work/processes/ whose output is no longer needed.
 *
 * A process directory is eligible for cleanup when:
 * 1. The process status is NOT 'running'.
 * 2. The process directory is older than maxAgeMs.
 * CRITICAL: Never removes running process dirs.
 *
 * @param options - Options including saivageWorkDir, store, and maxAgeMs
 * @returns Number of process directories cleaned
 */
export function cleanStaleProcessOutput(options: CleanStaleProcessOptions): number {
  const { saivageWorkDir, maxAgeMs = 24 * 60 * 60 * 1000 } = options;
  const processesDir = safeResolve(saivageWorkDir, 'processes');
  if (!processesDir) return 0;
  if (!existsSync(processesDir)) return 0;

  // Verify this is exactly the processes directory
  const absWork = resolve(saivageWorkDir);
  const expectedProcesses = normalize(join(absWork, 'processes'));
  if (processesDir !== expectedProcesses) return 0;

  const runningProcessIds = loadRunningProcessIds(saivageWorkDir);
  if (!runningProcessIds) return 0;

  let cleaned = 0;
  const cutoff = Date.now() - maxAgeMs;

  let entries: string[];
  try {
    entries = readdirSync(processesDir);
  } catch {
    return 0;
  }

  for (const entry of entries) {
    const procDir = join(processesDir, entry);

    // Skip non-directories
    let st;
    try {
      st = statSync(procDir);
    } catch {
      continue;
    }
    if (!st.isDirectory()) continue;

    // Never remove output for registry-running processes.
    if (runningProcessIds.has(entry)) continue;

    // Skip if too new
    if (st.mtimeMs >= cutoff) continue;

    try {
      rmSync(procDir, { recursive: true, force: true });
      cleaned++;
    } catch {
      // skip directories we can't remove
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
 * Never removes download reviews or quarantine metadata.
 *
 * @param saivageWorkDir - Path to .saivage-work/ directory
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
    previewsMaxAgeMs?: number;
    uploadsMaxAgeMs?: number;
  },
): CleanupResult {
  const result: CleanupResult = {
    cardTmpCleaned: 0,
    staleStashRemoved: 0,
    processDirsCleaned: 0,
    stalePreviewsRemoved: 0,
    staleUploadsRemoved: 0,
  };

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
    options?.stashMaxAgeMs,
  );

  // 3. Clean stale process output
  result.processDirsCleaned = cleanStaleProcessOutput({
    saivageWorkDir,
    store,
    maxAgeMs: options?.processMaxAgeMs,
  });

  // 4. Clean stale previews
  result.stalePreviewsRemoved = cleanStalePreviews(
    saivageWorkDir,
    options?.previewsMaxAgeMs,
  );

  // 5. Clean stale uploads
  result.staleUploadsRemoved = cleanStaleUploads(
    saivageWorkDir,
    options?.uploadsMaxAgeMs,
  );

  return result;
}

// ── Internal Helpers ──────────────────────────────────────────

function loadRunningProcessIds(saivageWorkDir: string): Set<string> | null {
  const projectRoot = resolve(saivageWorkDir, '..');
  const running = new Set<string>();
  const registryPath = join(projectRoot, '.saivage', 'runtime', 'processes.json');
  if (!existsSync(registryPath)) return running;
  let parsed: { records?: ProcessRecord[] };
  try {
    parsed = JSON.parse(readFileSync(registryPath, 'utf8')) as { records?: ProcessRecord[] };
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.records)) return null;
  for (const record of parsed.records) {
    if (record.status === 'running') {
      running.add(record.id);
    }
  }
  return running;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
