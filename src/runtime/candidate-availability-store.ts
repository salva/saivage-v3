/**
 * FsCandidateAvailability — durable JSONL-backed CandidateAvailability with an
 * O_EXCL pidfile lock. Lives under `<projectRoot>/.saivage/runtime/`.
 *
 * - `candidate-availability.jsonl`  — append-only event log of entries.
 * - `candidate-availability.lock`   — exclusive lock holding the owner PID.
 *
 * On construction the lock is acquired (throws CandidateAvailabilityLockedError
 * if another live process holds it) and the JSONL is replayed into memory.
 * Compaction rewrites the JSONL when it exceeds the configured byte budget.
 */

import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { join } from 'node:path';

import {
  type AvailabilityDecision,
  type CandidateAvailabilityEntry,
  MemoryCandidateAvailability,
} from '../agents/candidate-availability.js';
import { type Candidate, candidateKey } from '../agents/provider.js';

export class CandidateAvailabilityLockedError extends Error {
  readonly holderPid: number | null;
  constructor(lockPath: string, holderPid: number | null) {
    super(
      `CandidateAvailability lock at ${lockPath} is held by pid=${holderPid ?? 'unknown'}; refusing to start a second writer.`,
    );
    this.name = 'CandidateAvailabilityLockedError';
    this.holderPid = holderPid;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const errno = (err as NodeJS.ErrnoException).code;
    if (errno === 'ESRCH') return false;
    // EPERM means the process exists but we can't signal it — treat as alive.
    return errno === 'EPERM';
  }
}

interface FsAvailabilityRecord {
  candidate: Candidate;
  state: CandidateAvailabilityEntry['state'];
  untilMs: number;
  reason?: string;
  updatedAtMs: number;
}

export class FsCandidateAvailability extends MemoryCandidateAvailability {
  readonly jsonlPath: string;
  readonly lockPath: string;
  private readonly compactBytes: number;
  private disposed = false;
  private bytesWritten = 0;

  constructor(projectRoot: string, opts: { compactBytes?: number } = {}) {
    super();
    const runtimeDir = join(projectRoot, '.saivage', 'runtime');
    mkdirSync(runtimeDir, { recursive: true });
    this.jsonlPath = join(runtimeDir, 'candidate-availability.jsonl');
    this.lockPath = join(runtimeDir, 'candidate-availability.lock');
    this.compactBytes = opts.compactBytes ?? 262144;
    this.acquireLock();
    this.replay();
  }

  private acquireLock(): void {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const fd = openSync(this.lockPath, 'wx');
        try {
          writeSync(fd, String(process.pid));
        } finally {
          closeSync(fd);
        }
        return;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
        const holder = this.readLockHolder();
        if (holder !== null && isProcessAlive(holder)) {
          throw new CandidateAvailabilityLockedError(this.lockPath, holder);
        }
        // Stale lock — remove and retry once.
        try {
          unlinkSync(this.lockPath);
        } catch {
          void 0;
        }
      }
    }
    throw new CandidateAvailabilityLockedError(this.lockPath, this.readLockHolder());
  }

  private readLockHolder(): number | null {
    try {
      const raw = readFileSync(this.lockPath, 'utf-8').trim();
      const pid = Number.parseInt(raw, 10);
      return Number.isFinite(pid) && pid > 0 ? pid : null;
    } catch {
      return null;
    }
  }

  private replay(): void {
    if (!existsSync(this.jsonlPath)) {
      this.bytesWritten = 0;
      return;
    }
    const raw = readFileSync(this.jsonlPath, 'utf-8');
    this.bytesWritten = Buffer.byteLength(raw, 'utf-8');
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const record = JSON.parse(trimmed) as FsAvailabilityRecord;
        this.entries.set(candidateKey(record.candidate), {
          candidate: record.candidate,
          state: record.state,
          untilMs: record.untilMs,
          reason: record.reason,
          updatedAtMs: record.updatedAtMs,
        });
      } catch {
        // Skip corrupt lines; the in-memory map is the source of truth post-replay.
      }
    }
  }

  protected async persist(entry: CandidateAvailabilityEntry): Promise<void> {
    if (this.disposed) return;
    const record: FsAvailabilityRecord = {
      candidate: entry.candidate,
      state: entry.state,
      untilMs: entry.untilMs,
      reason: entry.reason,
      updatedAtMs: entry.updatedAtMs,
    };
    const line = JSON.stringify(record) + '\n';
    const fd = openSync(this.jsonlPath, 'a');
    try {
      writeSync(fd, line);
    } finally {
      closeSync(fd);
    }
    this.bytesWritten += Buffer.byteLength(line, 'utf-8');
    if (this.bytesWritten > this.compactBytes) this.compact();
  }

  private compact(): void {
    const snapshot = this.getAllEntries();
    const tmp = `${this.jsonlPath}.tmp-${process.pid}`;
    const body = snapshot
      .map((entry) =>
        JSON.stringify({
          candidate: entry.candidate,
          state: entry.state,
          untilMs: entry.untilMs,
          reason: entry.reason,
          updatedAtMs: entry.updatedAtMs,
        }),
      )
      .join('\n');
    const payload = body.length > 0 ? body + '\n' : '';
    writeFileSync(tmp, payload);
    renameSync(tmp, this.jsonlPath);
    try {
      this.bytesWritten = statSync(this.jsonlPath).size;
    } catch {
      this.bytesWritten = Buffer.byteLength(payload, 'utf-8');
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    try {
      unlinkSync(this.lockPath);
    } catch {
      void 0;
    }
  }
}

/** Re-exported for callers that want a memory-backed availability store. */
export { MemoryCandidateAvailability as MemoryCandidateAvailabilityStore } from '../agents/candidate-availability.js';
export type { AvailabilityDecision };
