# Wave 1: Persistence & Utility Primitives — Implementation Plan

Issues: F05, F12, F17, F31

## Design

### F05: Consolidate fsync and atomic-write utilities

**Problem:** Five files define their own sync or async `fsyncDir`/`fsyncDirectory`. Three separate atomic-write patterns exist with different durability guarantees and no clear ownership.

**New module structure:**

| File | Action |
|------|--------|
| `src/persistence/durable-write.ts` | **CREATE** — single owner of `fsyncDir`, `fsyncDirAsync`, `fsyncFile`, `writeFileAtomic`, `writeFileSyncDurable` |
| `src/persistence/atomic-json-file.ts` | MODIFY — remove local `fsyncDirectory`, import from `durable-write.ts` |
| `src/persistence/file-tree.ts` | MODIFY — remove `writeFileAtomic`, `writeFileSyncDurable`, `fsyncDirectory`; import from `durable-write.ts` for internal use only; do NOT re-export |
| `src/persistence/jsonl-ledger.ts` | No change needed (doesn't have its own fsync) |
| `src/cards/apply-mutation.ts` | MODIFY — remove local `fsyncDir` and `fsyncFileAtPath`; import `fsyncDir`, `fsyncFile` from `durable-write.ts` |
| `src/cards/commit-marker.ts` | MODIFY — remove local `fsyncDir`; import `fsyncDir` from `durable-write.ts` |
| `src/auth/auth-profile-store.ts` | MODIFY — remove async local `fsyncDirectory`; import `fsyncDirAsync` from `durable-write.ts` |

**New API in `src/persistence/durable-write.ts`:**

```ts
export function fsyncDir(dirPath: string): void;
export function fsyncDirAsync(dirPath: string): Promise<void>;
export function fsyncFile(path: string): void;
export function writeFileAtomic(targetPath: string, data: string): void;
export function writeFileSyncDurable(targetPath: string, data: string): void;
```

- `fsyncDir` — best-effort directory fsync (opens dir for reading, fsyncs, closes; catches and ignores errors).
- `fsyncDirAsync` — async best-effort directory fsync for existing async persistence code such as `auth-profile-store.ts`.
- `fsyncFile` — opens file for read-write, fsyncs, closes. Used for staging writes that need file-level durability before rename.
- `writeFileAtomic` — mkdir, write to tmp with random suffix, rename. No file fsync, no dir fsync. For non-critical writes where crash-atomic rename is sufficient (diary index, session files, quarantine, project init).
- `writeFileSyncDurable` — mkdir, open fd, write, fsync fd, close, rename, fsyncDir. For writes that must survive process crash (commit markers, session persistence, runtime state, config).

These are the exact same sync implementations currently in `file-tree.ts`, moved to a module whose name communicates their purpose. The `fsyncDir` implementation from `atomic-json-file.ts` is identical to the one in `file-tree.ts`; both are deleted in favor of the single export. The async `fsyncDirectory` in `auth-profile-store.ts` is kept async but moved behind `fsyncDirAsync` so the final tree has one sync and one async directory-fsync primitive.

**Why not abstract further:** A shared sync/async directory fsync pair, a `fsyncFile`, and two clearly named write functions is sufficient. There is no need for a write-strategy enum, builder, or abstraction layer. The naming itself (`Atomic` vs `Durable`) communicates the guarantee.

**Migration path:** `persistence/index.ts` exports `fsyncDir`, `fsyncDirAsync`, `fsyncFile`, `writeFileAtomic`, `writeFileSyncDurable` directly from `durable-write.js`. `file-tree.ts` imports from `durable-write.ts` for its own project initialization use but does NOT re-export these functions. Callers that currently import `writeFileAtomic` or `writeFileSyncDurable` from `file-tree.js` must be updated to import from `persistence/index.js` or `durable-write.js` directly. This ensures clear ownership and avoids transitive re-export chains.

---

### F12: Add stale-lock detection to ProjectLock

**Problem:** Exclusive-file-creation lock with no stale detection. On process crash, the lock file remains and blocks all subsequent acquisitions. PID and timestamp are stored but never read.

**Changes:**

| File | Action |
|------|--------|
| `src/persistence/project-lock.ts` | MODIFY — add stale detection to `withLock` and `withLockSync`, add `LockMetadata` interface |
| `src/persistence/errors.ts` | MODIFY — add `StaleLockError` (type-imports `LockMetadata` from `project-lock.ts`) |

**New lock metadata and stale detection:**

`LockMetadata` is defined in `src/persistence/project-lock.ts`:

```ts
export interface LockMetadata {
  pid: number;
  acquired_at: string;
  hostname: string;
}
```

`StaleLockError` is defined in `src/persistence/errors.ts`:

```ts
import type { LockMetadata } from './project-lock.js';

export class StaleLockError extends PersistenceError {
  constructor(readonly lockPath: string, readonly metadata: LockMetadata | null, reason = 'stale lock detected') {
    const holder = metadata
      ? `held by PID ${metadata.pid} on ${metadata.hostname} since ${metadata.acquired_at}`
      : 'metadata unreadable or invalid';
    super(`Stale lock at ${lockPath}: ${reason}; ${holder}`);
  }
}
```

**Keep `withLockSync`.** Wave 1 adds stale-lock detection to both sync and async acquisition; it does not convert sync callers to async and does not change `withLock` to accept sync callbacks. Removing `withLockSync` would force all current sync callers (apply-mutation, card-store, state, ledger-projections) to become async, cascading extensively across the codebase. The real fix for F12 is stale detection, not removing sync.

**Stale detection on acquisition failure:**

On `EEXIST`, both `withLock` and `withLockSync` read the lock file metadata and check staleness inside acquisition (not as a separate public method):

1. If metadata is unreadable or invalid → throw `StaleLockError(lockPath, null, 'invalid lock metadata')` (cannot determine staleness safely).
2. If hostname does not match current host → throw `StaleLockError(lockPath, metadata, 'lock belongs to a different host')` (cannot verify PID on different host).
3. If PID is alive (including `process.kill(pid, 0)` returning `EPERM`) → lock is genuinely held; retry after delay.
4. If PID is dead AND `staleLockAction === 'remove'` → remove lock file and retry acquisition.
5. If PID is dead AND `staleLockAction === 'error'` → throw `StaleLockError(lockPath, metadata, 'lock holder process is not alive')`.

Default is `staleLockAction: 'error'`. Runtime startup or explicit recovery paths may opt into `'remove'` after logging stale metadata.

Note: there is no public `removeStaleLock()` method. Stale detection and removal happen exclusively inside the acquisition loop after observing `EEXIST`. This avoids race conditions from separate cleanup calls.

```ts
export interface ProjectLockOptions {
  timeoutMs?: number;
  retryDelayMs?: number;
  staleLockAction?: 'error' | 'remove';
}
```

**PID-alive detection:** Uses `process.kill(pid, 0)` — sends signal 0, which checks existence without sending a signal. `EPERM` means the PID exists but the process lacks permission to signal it (i.e., alive). On Windows, falls back to always treating the PID as potentially alive (conservative).

```ts
function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EPERM') return true;
    return false;
  }
}
```

**Updated `withLock` and `withLockSync` flow:**

Both methods include stale detection in the acquisition loop:

```ts
async withLock<T>(fn: (handle: LockHandle) => Promise<T>): Promise<T> {
  // Queue entry (same as current)
  // On EEXIST: read metadata, check hostname/PID staleness, remove+retry or throw StaleLockError
  // On acquisition: write metadata with hostname, run fn, cleanup
}

withLockSync<T>(fn: (handle: LockHandle) => T): T {
  // On EEXIST: read metadata, remove stale same-host dead-PID locks when configured, otherwise throw
  // Keep rejecting when an in-process async lock is queued or active
}
```

---

### F17: Deduplicate `now()` and `valuesEqual()`

**Problem:** `now()` (ISO timestamp) is duplicated in 8 files. `valuesEqual` is duplicated in 2 files. The invocation-recovery-policy has its own independent regex list for secret redaction.

**New module structure:**

| File | Action |
|------|--------|
| `src/utils/clock.ts` | **CREATE** — export `now(): string` |
| `src/utils/index.ts` | MODIFY — re-export `now` from `clock.ts` |
| `src/cards/value-equality.ts` | **CREATE** — export `valuesEqual(a: unknown, b: unknown): boolean` |
| `src/cards/card-store.ts` | MODIFY — remove local `now`, `valuesEqual`; import from `../utils/clock.js` and `./value-equality.js` |
| `src/cards/artifacts.ts` | MODIFY — remove local `now`; import from `../utils/clock.js` |
| `src/cards/lifecycle.ts` | MODIFY — remove local `valuesEqual`; import from `./value-equality.js` |
| `src/runtime/runtime.ts` | MODIFY — remove local `now`; import from `../utils/clock.js` |
| `src/runtime/runtime-startup.ts` | MODIFY — remove local `now`; import from `../utils/clock.js` |
| `src/runtime/activation-repair.ts` | MODIFY — remove local `now`; import from `../utils/clock.js` |
| `src/runtime/synthetic-planner-notes.ts` | MODIFY — remove local `now`; import from `../utils/clock.js` |
| `src/runtime/process-runner.ts` | MODIFY — remove local `now`; import from `../utils/clock.js` |
| `src/agents/analyst-handler.ts` | MODIFY — remove local `now`; import from `../utils/clock.js` |

**`src/utils/clock.ts`:**

```ts
export function now(): string {
  return new Date().toISOString();
}
```

**`src/cards/value-equality.ts`:**

```ts
export function valuesEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
```

**Redaction (invocation-recovery-policy.ts):** The finding notes that `analyst-sanitization.ts` and `llm-errors.ts` already use `redactTextForOutbound`. Only `invocation-recovery-policy.ts` has its own independent `SECRET_PATTERNS` regex list and `sanitizeRecoveryMessage` function. Rather than creating a separate redaction module (which would be over-engineering for one caller), we modify `sanitizeRecoveryMessage` to call `redactTextForOutbound` for the common patterns and keep only the recovery-policy-specific truncation and prefix logic. This eliminates the duplicated regex list.

**`src/agents/invocation-recovery-policy.ts` changes:**

Replace the `SECRET_PATTERNS` array and the regex loop in `sanitizeRecoveryMessage` with a call to `redactTextForOutbound`, then apply recovery-specific truncation:

```ts
import { redactTextForOutbound } from '../redaction/index.js';

export function sanitizeRecoveryMessage(value: unknown, maxLength = 500): string {
  const text = value instanceof Error ? value.message : String(value ?? 'Unknown error');
  const redacted = redactTextForOutbound(text, 'provider.diagnostic') as string;
  if (redacted.length > maxLength) return `${redacted.slice(0, maxLength)}…`;
  return redacted;
}
```

Remove `SECRET_PATTERNS` entirely. The `redactTextForOutbound` function already handles all the patterns that were in `SECRET_PATTERNS` plus more. Do not pass options to `redactTextForOutbound`; the options parameter is voided in the function body.

---

### F31: Separate JSONL ledger conventions and make diary read failures explicit

**Problem:** `JsonlLedger` has two append conventions (version-enveloped `appendSync` and raw `appendSyncIdempotent`/`appendSyncIdempotentByKey`). Diary reads silently skip missing entries and fabricate synthetic empty review assessments.

**New module structure:**

| File | Action |
|------|--------|
| `src/persistence/jsonl-ledger.ts` | MODIFY — keep versioned envelope class, remove raw functions |
| `src/persistence/raw-jsonl.ts` | **CREATE** — `appendSyncIdempotent`, `appendSyncIdempotentByKey`, `lastLineSync` |
| `src/persistence/index.ts` | MODIFY — add exports from `raw-jsonl.ts` |
| `src/cards/diary.ts` | MODIFY — throw `DiaryReadError` for unreadable indexed files; throw `DiaryIntegrityError` for inconsistent indexes; `getDiaryEntry` returns `null` only for missing IDs |

**`src/persistence/raw-jsonl.ts` API:**

```ts
export interface LastLineSyncResult {
  line: string | null;
  endsWithNewline: boolean;
  partialTail: string | null;
}

export function lastLineSync(jsonlPath: string): LastLineSyncResult;
export function appendSyncIdempotent(jsonlPath: string, entry: { entry_id: string } & Record<string, unknown>): void;
export function appendSyncIdempotentByKey<T extends Record<string, unknown>>(jsonlPath: string, entry: T, idField: keyof T & string): void;
```

These are the exact same implementations currently in `jsonl-ledger.ts`, moved to a file whose name communicates that they operate on raw (non-versioned) JSONL. The `JsonlLedger` class stays in `jsonl-ledger.ts` and only handles version-enveloped records.

**`src/persistence/jsonl-ledger.ts` changes:**

Remove `LastLineSyncResult`, `lastLineSync`, `appendSyncIdempotent`, `appendSyncIdempotentByKey` — they are now in `raw-jsonl.ts`.

**`src/cards/diary.ts` changes:**

Two error classes for diary failures:

```ts
export class DiaryReadError extends Error {
  constructor(readonly goalCardId: string, readonly missingEntryId: string, readonly missingFilename: string) {
    super(`Diary entry ${missingEntryId} (${missingFilename}) missing for goal ${goalCardId}`);
  }
}

export class DiaryIntegrityError extends Error {
  constructor(readonly goalCardId: string, readonly entryId: string, readonly reason: string) {
    super(`Diary integrity error for goal ${goalCardId}: ${reason} (entry ${entryId})`);
  }
}
```

- `DiaryReadError` — thrown when an indexed diary file cannot be read (file missing or unreadable).
- `DiaryIntegrityError` — thrown when the diary index is inconsistent (review index points to a missing or no-assessment diary entry).

`getDiaryEntry` returns `null` only when the entry id is not in the index (i.e., the entry simply does not exist). It throws `DiaryReadError` when the entry is in the index but the file is missing or unreadable.

In `getDiaryEntries`, when `existsSync(path)` is false, throw `DiaryReadError` instead of skipping.

`getReviewAssessments` currently fabricates a synthetic `ReviewAssessment` with empty values when the diary entry is missing. Change to throw `DiaryIntegrityError` — callers should handle data integrity issues rather than silently degrading.

---

## Step-by-Step Implementation Sequence

Each step is a minimal compilable commit. All steps must pass `npm run typecheck && npm test` before proceeding.

### Step 1: Create `src/persistence/durable-write.ts`

**Files:** Create `src/persistence/durable-write.ts`

Move `writeFileAtomic`, `writeFileSyncDurable`, and `fsyncDir` (the `fsyncDirectory` from `file-tree.ts`) into this new module. Use the `file-tree.ts` implementations verbatim (they already have directory-fsync in `writeFileSyncDurable` and best-effort-fsync in `fsyncDir`). Also add `fsyncFile` for file-level durability before rename and `fsyncDirAsync` for the existing async auth profile persistence path.

```ts
// src/persistence/durable-write.ts
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomBytes } from 'node:crypto';

export function fsyncDir(dirPath: string): void {
  let fd: number | null = null;
  try {
    fd = openSync(dirPath, 'r');
    fsyncSync(fd);
  } catch {
    // Best-effort directory fsync; not all platforms permit opening a directory.
  } finally {
    try {
      if (fd !== null) closeSync(fd);
    } catch { /* best-effort */ }
  }
}

export function fsyncFile(path: string): void {
  const fd = openSync(path, 'r+');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

export async function fsyncDirAsync(dirPath: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(dirPath, 'r');
    await handle.sync();
  } catch {
    // Best-effort directory fsync; not all platforms permit opening a directory.
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export function writeFileAtomic(targetPath: string, data: string): void {
  const lastSep = targetPath.lastIndexOf('/');
  const dir = lastSep >= 0 ? targetPath.slice(0, lastSep) : '.';
  mkdirSync(dir, { recursive: true });
  const suffix = randomBytes(8).toString('hex');
  const tmpPath = `${targetPath}.tmp.${suffix}`;
  writeFileSync(tmpPath, data, 'utf-8');
  renameSync(tmpPath, targetPath);
}

export function writeFileSyncDurable(targetPath: string, data: string): void {
  const dir = dirname(targetPath);
  mkdirSync(dir, { recursive: true });
  const suffix = randomBytes(8).toString('hex');
  const tmpPath = `${targetPath}.tmp.${suffix}`;
  let fd: number | null = null;
  try {
    fd = openSync(tmpPath, 'w');
    writeFileSync(fd, data, 'utf-8');
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    renameSync(tmpPath, targetPath);
    fsyncDir(dir);
  } catch (error) {
    try { if (fd !== null) closeSync(fd); } catch { /* preserve original error */ }
    try { if (existsSync(tmpPath)) unlinkSync(tmpPath); } catch { /* preserve original error */ }
    throw error;
  }
}
```

**Verification:** `npx tsc --noEmit` compiles. No caller changes yet.

### Step 2: Make `file-tree.ts` delegate to `durable-write.ts`

**Files:** Modify `src/persistence/file-tree.ts`, modify `src/persistence/index.ts`

- Remove the local `fsyncDirectory` function and the implementations of `writeFileAtomic` and `writeFileSyncDurable`.
- Import `writeFileAtomic` and `writeFileSyncDurable` from `./durable-write.js` for internal use within `file-tree.ts`.
- Do NOT re-export `writeFileAtomic` or `writeFileSyncDurable` from `file-tree.ts`.

The `file-tree.ts` changes:

```ts
import { writeFileAtomic, writeFileSyncDurable } from './durable-write.js';
```

Remove: the local `fsyncDirectory` function, the local `writeFileAtomic` function, the local `writeFileSyncDurable` function. Remove `fsyncSync`, `openSync`, `randomBytes` from the `node:fs` and `node:crypto` imports if no longer needed.

In `src/persistence/index.ts`, remove `writeFileAtomic` and `writeFileSyncDurable` from the existing `./file-tree.js` export block, then add direct exports from `./durable-write.js`:

```ts
export { fsyncDir, fsyncDirAsync, fsyncFile, writeFileAtomic, writeFileSyncDurable } from './durable-write.js';
```

Callers that previously imported `writeFileAtomic` or `writeFileSyncDurable` from `file-tree.js` must be updated to import from `persistence/index.js` or `durable-write.js` directly.

**Verification:** `npm run typecheck && npm test`. All existing callers of `writeFileAtomic` and `writeFileSyncDurable` resolve through `persistence/index.js`. No behavior change.

### Step 3: Make `atomic-json-file.ts` and `auth-profile-store.ts` use shared directory fsync

**Files:** Modify `src/persistence/atomic-json-file.ts`, `src/auth/auth-profile-store.ts`

- In `atomic-json-file.ts`, remove the local `fsyncDirectory` function (lines 19-29).
- Import `fsyncDir` from `./durable-write.js` and replace `fsyncDirectory(dir)` with `fsyncDir(dir)` in `writeJson`.
- In `auth-profile-store.ts`, remove the local async `fsyncDirectory` function (lines 204-214).
- Import `fsyncDirAsync` from `../persistence/durable-write.js` and replace `await fsyncDirectory(parent)` with `await fsyncDirAsync(parent)` in `writeAuthProfilesAtomic`.

**Verification:** `npm run typecheck && npm test`.

### Step 4: Make `apply-mutation.ts` use shared `fsyncDir` and `fsyncFile`

**Files:** Modify `src/cards/apply-mutation.ts`

- Remove the local `fsyncFileAtPath` function (lines 80-87) and `fsyncDir` function (lines 89-100).
- Import `{ fsyncDir, fsyncFile }` from `../persistence/durable-write.js`.
- In `stageByIdTmp`: replace `fsyncFileAtPath(tmpPath)` with `fsyncFile(tmpPath)`.
- In `applyMutationLocked`: replace `fsyncDir(dirname(finalPath))` with shared `fsyncDir`.
- Remove `fsyncSync`, `openSync` from the `node:fs` import if no longer needed.

**Verification:** `npm run typecheck && npm test`.

### Step 5: Make `commit-marker.ts` use shared `fsyncDir`

**Files:** Modify `src/cards/commit-marker.ts`

- Remove the local `fsyncDir` function (lines 65-76).
- Import `fsyncDir` from `../persistence/durable-write.js`.
- `writeFileSyncDurable` is already imported from `../persistence/index.js` — keep that import.
- Remove redundant `fsyncDir(commitMarkerDir(projectRoot))` calls after `writeFileSyncDurable(...)`. `writeFileSyncDurable` already fsyncs the directory; calling `fsyncDir` again is redundant. Keep `fsyncDir` calls only after `unlinkSync` operations (which don't have their own directory fsync).
- Remove `closeSync`, `fsyncSync`, `openSync` from `node:fs` import if no longer used.

**Verification:** `npm run typecheck && npm test`.

### Step 6: Add `LockMetadata` to `project-lock.ts` and `StaleLockError` to `errors.ts`

**Files:** Modify `src/persistence/project-lock.ts`, modify `src/persistence/errors.ts`

In `src/persistence/project-lock.ts`, add:

```ts
export interface LockMetadata {
  pid: number;
  acquired_at: string;
  hostname: string;
}
```

In `src/persistence/errors.ts`, add:

```ts
import type { LockMetadata } from './project-lock.js';

export class StaleLockError extends PersistenceError {
  constructor(readonly lockPath: string, readonly metadata: LockMetadata | null, reason = 'stale lock detected') {
    const holder = metadata
      ? `held by PID ${metadata.pid} on ${metadata.hostname} since ${metadata.acquired_at}`
      : 'metadata unreadable or invalid';
    super(`Stale lock at ${lockPath}: ${reason}; ${holder}`);
  }
}
```

Update `src/persistence/index.ts` to export `StaleLockError` from `./errors.js` and `LockMetadata` from `./project-lock.js`.

**Verification:** `npm run typecheck`. No callers yet.

### Step 7: Add stale-lock detection to `ProjectLock`

**Files:** Modify `src/persistence/project-lock.ts`

Major changes:
1. Add `import { hostname } from 'node:os'`
2. Import `{ StaleLockError }` from `./errors.js` and use local `LockMetadata`
3. Add `staleLockAction` to `ProjectLockOptions` (default `'error'`)
4. Add `isPidAlive` helper (conservative: `EPERM` means alive)
5. Add `readLockMetadata` helper
6. Add `writeLockMetadata` helper
7. Modify `withLock`: on `EEXIST`, read metadata, check hostname/PID staleness inside the acquisition loop, auto-remove or throw `StaleLockError`
8. Modify `withLockSync`: on `EEXIST`, detect invalid/different-host/dead-PID locks and optionally remove stale same-host dead-PID locks; keep immediate failure for live locks and in-process async queue conflicts
9. Write lock metadata with `hostname` field: `{ pid, acquired_at, hostname }`
10. Keep `queuedAsyncCallCount` so `withLockSync` continues to fail fast when async callers are already queued

No public `removeStaleLock()` method. Stale detection and removal happen exclusively inside the acquisition loop after observing `EEXIST`.

Updated `ProjectLock`:

```ts
export interface ProjectLockOptions {
  timeoutMs?: number;
  retryDelayMs?: number;
  staleLockAction?: 'error' | 'remove';
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EPERM') return true;
    return false;
  }
}

function readLockMetadata(lockPath: string): LockMetadata | null {
  try {
    const raw = readFileSync(lockPath, 'utf-8').trim();
    const parsed = JSON.parse(raw) as Partial<LockMetadata>;
    if (typeof parsed.pid !== 'number' || !Number.isSafeInteger(parsed.pid) || parsed.pid <= 0) return null;
    if (typeof parsed.acquired_at !== 'string' || Number.isNaN(Date.parse(parsed.acquired_at))) return null;
    if (typeof parsed.hostname !== 'string' || parsed.hostname.length === 0) return null;
    return { pid: parsed.pid, acquired_at: parsed.acquired_at, hostname: parsed.hostname };
  } catch {
    return null;
  }
}

function writeLockMetadata(lockPath: string, fd: number): void {
  const meta: LockMetadata = { pid: process.pid, acquired_at: new Date().toISOString(), hostname: hostname() };
  writeFileSync(fd, JSON.stringify(meta) + '\n', 'utf-8');
}
```

Stale detection logic for `withLock`, inside the acquisition loop after observing `EEXIST`:

1. Read metadata with `readLockMetadata`. If unreadable or invalid → throw `StaleLockError(lockPath, null, 'invalid lock metadata')` (cannot determine staleness safely).
2. If hostname does not match `hostname()` → throw `StaleLockError(lockPath, metadata, 'lock belongs to a different host')` (cannot verify PID on different host).
3. If `isPidAlive(meta.pid)` returns `true` → lock is genuinely held; retry after delay.
4. If PID is dead AND `staleLockAction === 'remove'` → `unlinkSync(lockPath)`, then retry acquisition.
5. If PID is dead AND `staleLockAction === 'error'` → throw `StaleLockError(lockPath, metadata, 'lock holder process is not alive')`.

`withLockSync` uses the same metadata checks after `EEXIST`, but it does not wait on live locks. If the PID is alive, or this process already has an active/queued async lock, it preserves the current fail-fast behavior by throwing `LockTimeoutError(lockPath, 0)`. If the PID is dead and `staleLockAction === 'remove'`, it unlinks and retries the synchronous `openSync('wx')`; otherwise it throws `StaleLockError`.

`ProjectLock` keeps both `withLock` and `withLockSync`:

```ts
export class ProjectLock {
  private readonly timeoutMs: number;
  private readonly retryDelayMs: number;
  private readonly staleLockAction: 'error' | 'remove';
  // ... existing queue fields, including queuedAsyncCallCount

  constructor(readonly lockPath: string, options: ProjectLockOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.retryDelayMs = options.retryDelayMs ?? 25;
    this.staleLockAction = options.staleLockAction ?? 'error';
  }

  async withLock<T>(fn: (handle: LockHandle) => Promise<T>): Promise<T> { ... }
  withLockSync<T>(fn: (handle: LockHandle) => T): T { ... }
  assertOwns(handle: LockHandle): void { /* same as before */ }
}
```

**Verification:** Add focused cases to `tests/persistence/persistence-primitives.test.ts`, then run `npm run typecheck && npm test`. Cover: stale lock with dead same-host PID (removed when `staleLockAction='remove'`, error when `'error'`), live PID with async acquisition retries until timeout, live PID with sync acquisition fails fast, different hostname (always error), unreadable/invalid metadata (error), and sync acquisition still rejects when an in-process async lock is queued.

### Step 8: Create `src/utils/clock.ts` and `src/cards/value-equality.ts`

**Files:** Create `src/utils/clock.ts`, create `src/cards/value-equality.ts`

`src/utils/clock.ts`:
```ts
export function now(): string {
  return new Date().toISOString();
}
```

`src/cards/value-equality.ts`:
```ts
export function valuesEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
```

Update `src/utils/index.ts` to re-export `now`:
```ts
export { now } from './clock.js';
```

**Verification:** `npm run typecheck`. No callers yet.

### Step 9: Migrate all `now()` callers

**Files:** Modify 9 caller files, each in its own focused change:

1. `src/runtime/runtime.ts` — remove local `now`, add `import { now } from '../utils/clock.js'`
2. `src/runtime/runtime-startup.ts` — remove local `now`, add `import { now } from '../utils/clock.js'`
3. `src/runtime/activation-repair.ts` — remove local `now`, add `import { now } from '../utils/clock.js'`
4. `src/runtime/synthetic-planner-notes.ts` — remove local `now`, add `import { now } from '../utils/clock.js'`
5. `src/runtime/process-runner.ts` — remove local `now`, add `import { now } from '../utils/clock.js'`
6. `src/cards/card-store.ts` — remove local `now`, add `import { now } from '../utils/clock.js'`; remove local `valuesEqual`, add `import { valuesEqual } from './value-equality.js'`
7. `src/cards/artifacts.ts` — remove local `now`, add `import { now } from '../utils/clock.js'`
8. `src/cards/lifecycle.ts` — remove local `valuesEqual`, add `import { valuesEqual } from './value-equality.js'`
9. `src/agents/analyst-handler.ts` — remove local `now`, add `import { now } from '../utils/clock.js'`

**Verification:** `npm run typecheck && npm test` after all changes.

### Step 10: Migrate `valuesEqual` from `lifecycle.ts` to `value-equality.ts`

(Combined with Step 9 above for `lifecycle.ts` and `card-store.ts`.)

**Verification:** `npm run typecheck && npm test`.

### Step 11: Consolidate invocation-recovery-policy redaction

**Files:** Modify `src/agents/invocation-recovery-policy.ts`

- Remove the `SECRET_PATTERNS` array (lines 44-50).
- Add `import { redactTextForOutbound } from '../redaction/index.js'`.
- Rewrite `sanitizeRecoveryMessage` to call `redactTextForOutbound` then truncate:

```ts
export function sanitizeRecoveryMessage(value: unknown, maxLength = 500): string {
  const text = value instanceof Error ? value.message : String(value ?? 'Unknown error');
  const redacted = redactTextForOutbound(text, 'provider.diagnostic') as string;
  if (redacted.length > maxLength) return `${redacted.slice(0, maxLength)}…`;
  return redacted;
}
```

Do not pass an options argument to `redactTextForOutbound`; the `options` parameter is voided in the function body.

**Verification:** `npm run typecheck && npm test`. The recovery policy tests should pass with the new redaction (which covers all the patterns that were in `SECRET_PATTERNS` plus more).

### Step 12: Extract raw JSONL helpers to `raw-jsonl.ts`

**Files:** Create `src/persistence/raw-jsonl.ts`, modify `src/persistence/jsonl-ledger.ts`, modify `src/persistence/index.ts`

**`src/persistence/raw-jsonl.ts`:** Move `LastLineSyncResult`, `lastLineSync`, `appendSyncIdempotent`, `appendSyncIdempotentByKey` from `jsonl-ledger.ts` to this new file. Keep the same imports (`node:fs`, `node:path`, `./errors.js`).

Remove the comment block about "raw (non-versioned) JSONL helpers" (the section comment from lines 140-142 of `jsonl-ledger.ts`), since the file name now communicates the convention.

**`src/persistence/jsonl-ledger.ts`:** Remove the raw functions and their comment block (lines 140-251). The `JsonlLedger` class remains as the versioned-envelope authority.

**`src/persistence/index.ts`:** Change the export of `appendSyncIdempotent`, `appendSyncIdempotentByKey`, `lastLineSync` from `./jsonl-ledger.js` to `./raw-jsonl.js`. Add `LastLineSyncResult` type export from `./raw-jsonl.js`. Also add exports for `fsyncDir`, `fsyncDirAsync`, `fsyncFile`, `writeFileAtomic`, `writeFileSyncDurable` from `./durable-write.js` directly (not through `./file-tree.js`).

**Verification:** `npm run typecheck && npm test`. All callers of `appendSyncIdempotent` etc. still resolve through the index re-export.

### Step 13: Make diary read failures explicit

**Files:** Modify `src/cards/diary.ts`, `tests/utils/diary.test.ts`

**Add `DiaryReadError` and `DiaryIntegrityError`:**

```ts
export class DiaryReadError extends Error {
  constructor(readonly goalCardId: string, readonly missingEntryId: string, readonly missingFilename: string) {
    super(`Diary entry ${missingEntryId} (${missingFilename}) missing for goal ${goalCardId}`);
  }
}

export class DiaryIntegrityError extends Error {
  constructor(readonly goalCardId: string, readonly entryId: string, readonly reason: string) {
    super(`Diary integrity error for goal ${goalCardId}: ${reason} (entry ${entryId})`);
  }
}
```

**`getDiaryEntry`:** Returns `null` only when the entry id is not in the index (entry does not exist). When the entry is in the index but the file is missing or unreadable, throws `DiaryReadError`.

**`getDiaryEntries`:** When `existsSync(path)` is false for an indexed entry, throw `DiaryReadError` instead of skipping. Change:

```ts
// Before:
for (const idxEntry of index.entries) {
  const path = join(diaryDir(saivageDir, goalCardId), idxEntry.filename);
  if (existsSync(path)) {
    const raw = readFileSync(path, 'utf-8');
    const parsed = JSON.parse(raw) as DiaryEntry;
    entries.push(diaryEntrySchema.parse(parsed));
  }
}

// After:
for (const idxEntry of index.entries) {
  const path = join(diaryDir(saivageDir, goalCardId), idxEntry.filename);
  if (!existsSync(path)) {
    throw new DiaryReadError(goalCardId, idxEntry.id, idxEntry.filename);
  }
  const raw = readFileSync(path, 'utf-8');
  const parsed = JSON.parse(raw) as DiaryEntry;
  entries.push(diaryEntrySchema.parse(parsed));
}
```

**`getReviewAssessments`:** When `diaryEntry?.assessment` is falsy (which currently includes both `null` diary entry and missing assessment), throw `DiaryIntegrityError` instead of fabricating a synthetic empty assessment. Change:

```ts
// Before:
for (const rev of reviewIndex.reviews) {
  const diaryEntry = getDiaryEntry(saivageDir, goalCardId, rev.diary_entry_id);
  if (diaryEntry?.assessment) {
    assessments.push(diaryEntry.assessment);
  } else {
    assessments.push({
      id: rev.id,
      goal_card_id: goalCardId,
      reviewer_session_id: '',
      result: rev.result,
      summary: '',
      achieved: [],
      evidence_card_ids: [],
      created_at: rev.timestamp,
      assessment_id: rev.id,
      at: rev.timestamp,
      issues: [],
    });
  }
}

// After:
for (const rev of reviewIndex.reviews) {
  const diaryEntry = getDiaryEntry(saivageDir, goalCardId, rev.diary_entry_id);
  if (diaryEntry === undefined || diaryEntry === null) {
    throw new DiaryIntegrityError(goalCardId, rev.diary_entry_id, 'review index references missing diary entry');
  }
  if (!diaryEntry.assessment) {
    throw new DiaryIntegrityError(goalCardId, rev.diary_entry_id, 'review index references diary entry with no assessment');
  }
  assessments.push(diaryEntry.assessment);
}
```

**Tests:** Update `tests/utils/diary.test.ts` to import `DiaryReadError` and `DiaryIntegrityError`, remove expectations that indexed missing files are skipped or converted to `null`, and keep the existing missing-diary-directory behavior (`getDiaryEntries` returns `[]`, `getDiaryEntry` returns `null`).

**Verification:** `npm run typecheck && npm test`. Tests that relied on silent skip/fabrication behavior will need to be updated to expect `DiaryReadError` or `DiaryIntegrityError`. This is intentional — silent data degradation is a bug, not a feature. Diary tests must cover: missing diary directory remains empty/null; indexed diary file missing throws `DiaryReadError`; review index pointing to missing/no-assessment diary entry throws `DiaryIntegrityError`.

---

## Implementation Dependency Order

```
Step 1 (durable-write.ts) ──→ Step 2 (file-tree delegates) ──→ Step 3 (atomic-json-file uses fsyncDir)
                          ──→ Step 4 (apply-mutation uses fsyncDir/fsyncFile)
                          ──→ Step 5 (commit-marker uses fsyncDir)

Step 6 (LockMetadata + StaleLockError)  ──→ Step 7 (ProjectLock stale detection)

Step 8 (clock.ts, value-equality.ts) ──→ Step 9 (now() migration) ──→ Step 10 (valuesEqual migration)

Step 11 (redaction consolidation) — independent

Step 12 (raw-jsonl.ts) ──→ Step 13 (diary explicit errors)
```

Steps 1-5, Steps 6-7, Steps 8-10, Step 11, and Steps 12-13 can each proceed independently. Within each group, the order matters.

## Validation

When the wave is complete, run:

```bash
npm run validate:routine   # typecheck + build + docs
npm test                   # full test suite
```

Additional manual checks:

1. **Fsync consolidation:** Grep for local `fsyncDir`/`fsyncDirectory`/`fsyncFileAtPath` definitions — none should remain outside `durable-write.ts`:
   ```bash
   rg -n 'function fsyncDir|function fsyncDirectory|function fsyncFileAtPath' src/
   ```

2. **now() consolidation:** Grep for local `now()` definitions — none should remain outside `clock.ts`:
   ```bash
   rg -n 'function now()' src/
   ```

3. **valuesEqual consolidation:** Grep for local `valuesEqual` definitions — none should remain outside `value-equality.ts`:
   ```bash
   rg -n 'function valuesEqual' src/
   ```

4. **Stale lock recovery:** Manually test by creating a lock file, killing the process, and verifying that a new lock acquisition fails with `StaleLockError` by default (staleLockAction='error'), or succeeds with `staleLockAction='remove'`:
   ```bash
   # Create a stale lock with a dead PID and matching hostname
   echo '{"pid":99999,"acquired_at":"2026-01-01T00:00:00Z","hostname":"'"$(hostname)"'"}' > .saivage/.lock
   # Verify StaleLockError is thrown by default (staleLockAction='error')
   # Verify lock is removed and acquisition succeeds when staleLockAction='remove'
   ```

5. **JSONL separation:** Verify `appendSyncIdempotent` and `lastLineSync` are importable from `../persistence/index.js` and that existing callers (card-store, state, session-persistence) still work.

6. **Diary explicit errors:** Verify that `getDiaryEntries` throws `DiaryReadError` instead of silently skipping, and that `getReviewAssessments` throws `DiaryIntegrityError` instead of fabricating empty objects. Verify that `getDiaryEntry` returns `null` only for entry IDs not in the index.

7. **All persistence primitives exercised:** Card creation, card update, card deletion (uses `applyMutation`, `commit-marker`, `writeFileSyncDurable`, `fsyncDir`, `appendSyncIdempotent`), project lock acquisition and release, JSONL ledger read/write, diary read/write.
