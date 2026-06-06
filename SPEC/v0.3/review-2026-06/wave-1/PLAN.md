# Wave 1: Persistence & Utility Primitives — Implementation Plan

## Second Review Corrections

This section supersedes both the Reviewed Corrections and any conflicting text below.

1. **CRITICAL — F12 section still says "Remove `withLockSync`"**: The F12 Design section (lines ~73-78, ~101-138) describes removing `withLockSync`. Reviewed Correction #4 explicitly says "Keep `ProjectLock.withLockSync`." The revised approach (lines ~503-545) correctly keeps it. **Delete the initial F12 section entirely; only the revised approach governs.**
2. **CRITICAL — `staleLockAction` default is `'error'` not `'remove'`**: The revised code at line ~469 shows `?? 'remove'`. Reviewed Correction #8 says the default must be `'error'`. Change to `this.staleLockAction = options.staleLockAction ?? 'error';`.
3. **CRITICAL — `LockMetadata` must be in `project-lock.ts` not `errors.ts`**: Reviewed Correction #6. `LockMetadata` interface goes in `src/persistence/project-lock.ts`. `StaleLockError` can stay in `errors.ts` but must import `LockMetadata` from `project-lock.ts`, or both can live in `project-lock.ts` with `StaleLockError` importing `PersistenceError` from `errors.ts`.
4. **HIGH — `file-tree.ts` must NOT re-export durable-write helpers**: Reviewed Correction #1. The plan's Step 2 says `file-tree.ts` re-exports `writeFileAtomic` and `writeFileSyncDurable`. The correction says `file-tree.ts` must not re-export them; `persistence/index.ts` should export directly from `durable-write.js`.
5. **HIGH — `fsyncFile` must appear in Step 1 API surface**: Reviewed Correction #2 says to include `fsyncFile` in the initial API. The Step 1 "New API" section only lists `fsyncDir`, `writeFileAtomic`, `writeFileSyncDurable`. Add `fsyncFile(path: string): void`.
6. **HIGH — Redaction call must not pass voided options**: Reviewed Correction #11. The plan's Step 11 shows `redactTextForOutbound(text, 'provider.diagnostic', { source: 'invocation-recovery-policy' })`. The `options` parameter is voided in the function body. Remove the options argument: `redactTextForOutbound(text, 'provider.diagnostic')`.
7. **HIGH — Diary needs both `DiaryReadError` and `DiaryIntegrityError`**: Reviewed Correction #14-15. `DiaryReadError` for indexed files that can't be read. `DiaryIntegrityError` for inconsistent indexes (review index pointing to missing/no-assessment entry). `getDiaryEntry` returns `null` only when entry id not in index.
8. **HIGH — `removeStaleLock()` must check hostname**: Reviewed Correction #9. `removeStaleLock()` must only remove same-host, valid-metadata, dead-PID locks. Different hostname, unreadable metadata, or invalid metadata return `false` (not removable).
9. **HIGH — Commit-marker redundant fsync must be removed**: Reviewed Correction #3. Step 5 removes local `fsyncDir` but doesn't call out removing redundant `fsyncDir(commitMarkerDir(projectRoot))` calls AFTER `writeFileSyncDurable`. These must be removed. Keep `fsyncDir` only after `unlinkSync` operations.
10. **MEDIUM — `persistence/index.ts` export changes not fully specified**: Step 12 moves raw JSONL helpers from `jsonl-ledger.js` to `raw-jsonl.js`. It should also specify adding `fsyncDir`, `fsyncFile`, `writeFileAtomic`, `writeFileSyncDurable` exports from `./durable-write.js` directly (not through `./file-tree.js`).
11. **MEDIUM — `valuesEqual` location**: Step 8 creates `src/cards/shared.ts`. Reviewed Correction #10 says "Prefer `src/cards/value-equality.ts` over a catch-all `src/cards/shared.ts`." Use `value-equality.ts`.
12. **MEDIUM — StaleLockError message inconsistency**: Line ~91 says "acquired by PID" while line ~408 says "held by PID". Use one consistent message.
13. **MEDIUM — Project lock `removeStaleLock()` behavior after read**: The revised approach shows reading metadata inside `withLock`/`withLockSync`. Stale removal should happen inside the acquisition loop after observing `EEXIST`, not as a separate public method. Conservative: `process.kill(pid, 0)` returning `EPERM` means alive. Default action is error, not remove.

## Reviewed Corrections

This section supersedes any conflicting text below.

1. `src/persistence/durable-write.ts` owns `fsyncDir`, `fsyncFile`, `writeFileAtomic`, and `writeFileSyncDurable`. `file-tree.ts` may import these helpers for project initialization, but must not re-export them. `persistence/index.ts` exports helpers directly from `durable-write.js`.
2. Include `fsyncFile(path: string): void` in the initial Wave 1 API. `apply-mutation.ts` imports `{ fsyncDir, fsyncFile }` and removes local `fsyncFileAtPath` and `fsyncDir`.
3. In `commit-marker.ts`, remove redundant marker-directory fsyncs after `writeFileSyncDurable(...)`; keep directory fsync only after marker unlink operations.
4. Keep `ProjectLock.withLockSync`. Wave 1 adds stale-lock detection to both sync and async acquisition; it does not convert sync callers to async and does not change `withLock` to accept sync callbacks.
5. Keep the current `withLockSync` rejection when an async lock is active or queued. Do not implement synchronous waiting for async queue slots.
6. Define `LockMetadata` in `project-lock.ts`, not `errors.ts`. `errors.ts` may import it only for `StaleLockError` constructor typing.
7. Stale-lock detection is conservative: `process.kill(pid, 0)` returning `EPERM` means alive. Different hostname, unreadable metadata, and invalid metadata are held/errors, not auto-removable.
8. `staleLockAction` defaults to `'error'`, not `'remove'`. Runtime startup or explicit recovery paths may opt into removal after logging stale metadata.
9. Prefer stale removal inside the acquisition loop after observing `EEXIST`. Any public `removeStaleLock()` is best-effort and only removes same-host, valid-metadata, dead-PID locks.
10. Split utility migration: migrate local `now()` functions, then migrate `valuesEqual`. Prefer `src/cards/value-equality.ts` over a catch-all `src/cards/shared.ts`.
11. Before replacing `invocation-recovery-policy.ts` regexes, extend central redaction to cover bare GitHub tokens `gh[pousr]_...` and Slack `xox[baprs]-...`, with tests. `redactTextForOutbound` ignores options, so do not pass misleading options.
12. `JsonlLedger` already supports `version: null`. Keep it as the schema-validated ledger class. Move only raw idempotent append/tail helpers to `raw-jsonl.ts`.
13. `persistence/index.ts` exports raw helpers explicitly: `JsonlLedger`/types from `jsonl-ledger.js`; `appendSyncIdempotent`, `appendSyncIdempotentByKey`, `lastLineSync`, and `LastLineSyncResult` from `raw-jsonl.js`.
14. Diary errors need `DiaryReadError` for indexed files that cannot be read and `DiaryIntegrityError` for inconsistent indexes. `getDiaryEntry` returns `null` only when the entry id is not in the index.
15. Diary tests must cover: missing diary directory remains empty/null; indexed diary file missing throws `DiaryReadError`; review index pointing to missing/no-assessment diary entry throws `DiaryIntegrityError`.
16. Validation: `npm run typecheck`, focused Jest tests for persistence/cards/agents, then `npm run validate:routine`. Manual searches use `rg` and include `fsyncFile`.

Generated: 2026-06-06

Issues: F05, F12, F17, F31

## Design

### F05: Consolidate fsync and atomic-write utilities

**Problem:** Four files define their own `fsyncDir`/`fsyncDirectory`. Three separate atomic-write patterns exist with different durability guarantees and no clear ownership.

**New module structure:**

| File | Action |
|------|--------|
| `src/persistence/durable-write.ts` | **CREATE** — single owner of `fsyncDir`, `writeFileAtomic`, `writeFileSyncDurable` |
| `src/persistence/atomic-json-file.ts` | MODIFY — remove local `fsyncDirectory`, import from `durable-write.ts` |
| `src/persistence/file-tree.ts` | MODIFY — remove `writeFileAtomic`, `writeFileSyncDurable`, `fsyncDirectory`; import from `durable-write.ts`; re-export `writeFileAtomic` and `writeFileSyncDurable` for backward compat during transition |
| `src/persistence/jsonl-ledger.ts` | No change needed (doesn't have its own fsync) |
| `src/cards/apply-mutation.ts` | MODIFY — remove local `fsyncDir` and `fsyncFileAtPath`; import `fsyncDir` from `durable-write.ts` |
| `src/cards/commit-marker.ts` | MODIFY — remove local `fsyncDir`; import `fsyncDir` from `durable-write.ts` |

**New API in `src/persistence/durable-write.ts`:**

```ts
export function fsyncDir(dirPath: string): void;
export function writeFileAtomic(targetPath: string, data: string): void;
export function writeFileSyncDurable(targetPath: string, data: string): void;
```

- `fsyncDir` — best-effort directory fsync (opens dir for reading, fsyncs, closes; catches and ignores errors).
- `writeFileAtomic` — mkdir, write to tmp with random suffix, rename. No file fsync, no dir fsync. For non-critical writes where crash-atomic rename is sufficient (diary index, session files, quarantine, project init).
- `writeFileSyncDurable` — mkdir, open fd, write, fsync fd, close, rename, fsyncDir. For writes that must survive process crash (commit markers, session persistence, runtime state, config).

These are the exact same implementations currently in `file-tree.ts`, moved to a module whose name communicates their purpose. The `fsyncDir` implementation from `atomic-json-file.ts` is identical to the one in `file-tree.ts`; both are deleted in favor of the single export.

**Why not abstract further:** A shared `fsyncDir` and two clearly named write functions is sufficient. There is no need for a write-strategy enum, builder, or abstraction layer. The naming itself (`Atomic` vs `Durable`) communicates the guarantee.

**Migration path:** `file-tree.ts` re-exports the two write functions from `durable-write.ts` so that existing callers (`quarantine.ts`, `diary.ts`, `workspace-tools.ts`, `analyst-handler.ts`, `llm-exchange-log.ts`, `freeze-manifest.ts`, `analyst-config-writer.ts`, `process-runner.ts`, `initProjectTree`) continue to compile. After all callers are migrated (which can be a separate cleanup), the re-exports can be removed. For this wave, we only consolidate the implementations, not all call sites.

---

### F12: Add stale-lock recovery to ProjectLock

**Problem:** Exclusive-file-creation lock with no stale detection. On process crash, the lock file remains and blocks all subsequent acquisitions. PID and timestamp are stored but never read.

**Changes:**

| File | Action |
|------|--------|
| `src/persistence/project-lock.ts` | MODIFY — add `withLock` only (remove `withLockSync`), add stale detection |
| `src/persistence/errors.ts` | MODIFY — add `StaleLockError` |
| `src/cards/apply-mutation.ts` | MODIFY — `withLockOnly` becomes a thin wrapper calling `withLock` synchronously |
| `src/cards/card-store.ts` | MODIFY — `withLockSync` → synchronous call within `withLock` |
| `src/runtime/state.ts` | MODIFY — `withLockSync` → synchronous call within `withLock` |
| `src/projections/ledger-projections.ts` | MODIFY — `withLockSync` → synchronous call within `withLock` |

**New lock metadata and stale detection:**

```ts
interface LockMetadata {
  pid: number;
  acquired_at: string;
  hostname: string;
}

export class StaleLockError extends PersistenceError {
  constructor(readonly lockPath: string, readonly metadata: LockMetadata) {
    super(`Stale lock detected at ${lockPath}: acquired by PID ${metadata.pid} on ${metadata.hostname} at ${metadata.acquired_at}`);
  }
}
```

Stale detection on acquisition failure:
1. On `EEXIST`, read the lock file. If the stored PID matches a currently-running process, the lock is genuinely held — continue retrying.
2. If the stored PID does not match a running process (or the file is unreadable), the lock is stale — throw `StaleLockError` so callers can decide to remove the stale lock and retry.
3. On a `StaleLockError`, callers can call `lock.removeStaleLock()` to clear it, or the `withLock` method can optionally be configured to auto-remove stale locks.

**Remove `withLockSync`:** The sync path rejects immediately when async callers are queued, creating confusing interleaving semantics. Since all current `withLockSync` callers execute synchronous code inside the lock (card mutations, state writes, ledger appends), we convert them to use `withLock` with a synchronous body. This removes the interleaving problem entirely.

The async `withLock` method gets a new option:

```ts
export interface ProjectLockOptions {
  timeoutMs?: number;
  retryDelayMs?: number;
  staleLockAction?: 'error' | 'remove';
}
```

When `staleLockAction` is `'remove'` (the default for production), a detected stale lock is removed and acquisition retries. When `'error'`, a `StaleLockError` is thrown so the caller can log, alert, or manually intervene.

**PID-alive detection:** Uses `process.kill(pid, 0)` — sends signal 0, which checks existence without sending a signal. On Windows, falls back to always treating the PID as potentially alive (conservative).

```ts
function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
```

**Updated `withLock` flow:**

```ts
async withLock<T>(fn: (handle: LockHandle) => Promise<T>): Promise<T> {
  // Queue entry (same as current)
  // On EEXIST: read metadata, check staleness, remove if stale+configured, otherwise retry
  // On acquisition: write metadata with hostname, run fn, cleanup
}
```

**Why not keep `withLockSync`:** Sync and async paths can't interleave safely. The sync path already rejects if async callers are queued. All current sync callers run purely synchronous code. Converting to `withLock` removes the interleaving problem without behavioral change — the callback runs synchronously once the lock is acquired.

---

### F17: Deduplicate `now()` and `valuesEqual()`

**Problem:** `now()` (ISO timestamp) is duplicated in 8 files. `valuesEqual` is duplicated in 2 files. The invocation-recovery-policy has its own independent regex list for secret redaction.

**New module structure:**

| File | Action |
|------|--------|
| `src/utils/clock.ts` | **CREATE** — export `now(): string` |
| `src/utils/index.ts` | MODIFY — re-export `now` from `clock.ts` |
| `src/cards/shared.ts` | **CREATE** — export `valuesEqual(a: unknown, b: unknown): boolean` |
| `src/cards/card-store.ts` | MODIFY — remove local `now`, `valuesEqual`; import from `../utils/clock.js` and `./shared.js` |
| `src/cards/artifacts.ts` | MODIFY — remove local `now`; import from `../utils/clock.js` |
| `src/cards/lifecycle.ts` | MODIFY — remove local `valuesEqual`; import from `./shared.js` |
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

**`src/cards/shared.ts`:**

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
  const redacted = redactTextForOutbound(text, 'provider.diagnostic', { source: 'invocation-recovery-policy' });
  const unbranded = redacted as string;
  if (unbranded.length > maxLength) return `${unbranded.slice(0, maxLength)}…`;
  return unbranded;
}
```

Remove `SECRET_PATTERNS` entirely. The `redactTextForOutbound` function already handles all the patterns that were in `SECRET_PATTERNS` plus more.

---

### F31: Separate JSONL ledger conventions and make diary read failures explicit

**Problem:** `JsonlLedger` has two append conventions (version-enveloped `appendSync` and raw `appendSyncIdempotent`/`appendSyncIdempotentByKey`). Diary reads silently skip missing entries and fabricate synthetic empty review assessments.

**New module structure:**

| File | Action |
|------|--------|
| `src/persistence/jsonl-ledger.ts` | MODIFY — keep versioned envelope class, remove raw functions |
| `src/persistence/raw-jsonl.ts` | **CREATE** — `appendSyncIdempotent`, `appendSyncIdempotentByKey`, `lastLineSync` |
| `src/persistence/index.ts` | MODIFY — add exports from `raw-jsonl.ts` |
| `src/cards/diary.ts` | MODIFY — throw `DiaryReadError` instead of skipping; throw instead of fabricating fallback reviews |

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

`getDiaryEntries` currently skips entries whose files don't exist. Change to throw a `DiaryReadError`:

```ts
export class DiaryReadError extends Error {
  constructor(readonly goalCardId: string, readonly missingEntryId: string, readonly missingFilename: string) {
    super(`Diary entry ${missingEntryId} (${missingFilename}) missing for goal ${goalCardId}`);
  }
}
```

In `getDiaryEntries`, when `existsSync(path)` is false, throw `DiaryReadError` instead of skipping.

`getReviewAssessments` currently fabricates a synthetic `ReviewAssessment` with empty values when the diary entry is missing. Change to throw `DiaryReadError` — callers should handle data integrity issues rather than silently degrading.

---

## Step-by-Step Implementation Sequence

Each step is a minimal compilable commit. All steps must pass `npm run typecheck && npm test` before proceeding.

### Step 1: Create `src/persistence/durable-write.ts`

**Files:** Create `src/persistence/durable-write.ts`

Move `writeFileAtomic`, `writeFileSyncDurable`, and `fsyncDir` (the `fsyncDirectory` from `file-tree.ts`) into this new module. Use the `file-tree.ts` implementations verbatim (they already have directory-fsync in `writeFileSyncDurable` and best-effort-fsync in `fsyncDir`).

```ts
// src/persistence/durable-write.ts
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
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

**Files:** Modify `src/persistence/file-tree.ts`

- Remove the local `fsyncDirectory` function and the implementations of `writeFileAtomic` and `writeFileSyncDurable`.
- Import all three from `./durable-write.js`.
- Re-export `writeFileAtomic` and `writeFileSyncDurable` so all existing callers continue to compile.

The `file-tree.ts` imports become:

```ts
import { writeFileAtomic, writeFileSyncDurable } from './durable-write.js';
export { writeFileAtomic, writeFileSyncDurable };
```

Remove: the local `fsyncDirectory` function (lines 31-45), the local `writeFileAtomic` function (lines 21-29), the local `writeFileSyncDurable` function (lines 47-74). Remove `fsyncSync`, `openSync`, `randomBytes` from the `node:fs` and `node:crypto` imports if no longer needed.

**Verification:** `npm run typecheck && npm test`. All existing callers of `writeFileAtomic` and `writeFileSyncDurable` resolve through the re-export. No behavior change.

### Step 3: Make `atomic-json-file.ts` use shared `fsyncDir`

**Files:** Modify `src/persistence/atomic-json-file.ts`

- Remove the local `fsyncDirectory` function (lines 19-29).
- Import `fsyncDir` from `./durable-write.js`.
- Replace the call from `fsyncDirectory(dir)` to `fsyncDir(dir)` in `writeJson`.

**Verification:** `npm run typecheck && npm test`.

### Step 4: Make `apply-mutation.ts` use shared `fsyncDir`

**Files:** Modify `src/cards/apply-mutation.ts`

- Remove the local `fsyncFileAtPath` function (lines 80-87) and `fsyncDir` function (lines 89-100).
- Import `fsyncDir` from `../persistence/durable-write.js`.
- Replace `fsyncFileAtPath(tmpPath)` call in `stageByIdTmp` — since the function writes with `writeFileSync` (not `openSync`+`writeFileSync`+`fsyncSync`), we need to decide: should the staging write be durable or fast? Current code does `writeFileSync` then `fsyncFileAtPath` (open file separately and fsync). Replace with `openSync`+`writeFileSync`+`fsyncSync`+`closeSync` pattern (matching `writeFileSyncDurable` discipline but we need the tmp path). Actually, the simplest fix: after `writeFileSync(tmpPath, data)`, call `fsyncDir(dirname(tmpPath))` which fsyncs the parent directory. But the current code explicitly opens the file and fsyncs it. Let's keep the same semantics: after `writeFileSync`, open the file and fsync it, then fsync the directory on rename.

Actually, the simplest approach: `stageByIdTmp` currently does `writeFileSync(tmpPath, data)` then `fsyncFileAtPath(tmpPath)`. We can replace `fsyncFileAtPath` with a direct inline `openSync`/`fsyncSync`/`closeSync` (that's what `writeFileSyncDurable` does but we need control of the fd for the write pattern). Or better: just call `writeFileSyncDurable` for the staging write too? No — `writeFileSyncDurable` renames and we need the tmp file to stay at the tmp path.

Best approach: keep the staging write as `writeFileSync` but add a dedicated `fsyncFile` helper to `durable-write.ts`:

Actually, re-reading the code: `stageByIdTmp` writes the card JSON to a temp file, then commits via rename in `applyMutationLocked`. The `fsyncFileAtPath` ensures the temp file data is on disk before the rename. The `fsyncDir` on the target directory ensures the rename is durable. This is the correct commit pattern.

Add a `fsyncFile` to `durable-write.ts`:

```ts
export function fsyncFile(path: string): void {
  const fd = openSync(path, 'r+');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
```

Then in `apply-mutation.ts`, replace `fsyncFileAtPath(tmpPath)` with `fsyncFile(tmpPath)` and `fsyncDir(dirname(finalPath))` with the shared `fsyncDir`.

- Import `{ fsyncDir, fsyncFile }` from `../persistence/durable-write.js`.
- Remove local `fsyncFileAtPath` and `fsyncDir`.
- In `stageByIdTmp`: replace `fsyncFileAtPath(tmpPath)` with `fsyncFile(tmpPath)`.
- In `applyMutationLocked`: replace `fsyncDir(dirname(finalPath))` with shared `fsyncDir`.
- Remove `fsyncSync`, `openSync` from the `node:fs` import if no longer needed.

**Verification:** `npm run typecheck && npm test`.

### Step 5: Make `commit-marker.ts` use shared `fsyncDir`

**Files:** Modify `src/cards/commit-marker.ts`

- Remove the local `fsyncDir` function (lines 65-76).
- Import `fsyncDir` from `../persistence/durable-write.js`.
- `writeFileSyncDurable` is already imported from `../persistence/index.js` — keep that import.
- Remove `closeSync`, `fsyncSync`, `openSync` from `node:fs` import if no longer used.

**Verification:** `npm run typecheck && npm test`.

### Step 6: Add `StaleLockError` to `persistence/errors.ts`

**Files:** Modify `src/persistence/errors.ts`

Add:

```ts
export interface LockMetadata {
  pid: number;
  acquired_at: string;
  hostname: string;
}

export class StaleLockError extends PersistenceError {
  constructor(readonly lockPath: string, readonly metadata: LockMetadata) {
    super(`Stale lock at ${lockPath}: held by PID ${metadata.pid} on ${metadata.hostname} since ${metadata.acquired_at}`);
  }
}
```

Update `src/persistence/index.ts` to export `StaleLockError` and `LockMetadata`.

**Verification:** `npm run typecheck`. No callers yet.

### Step 7: Rewrite `ProjectLock` — remove `withLockSync`, add stale detection

**Files:** Modify `src/persistence/project-lock.ts`

Major changes:
1. Add `import os from 'node:os'`
2. Add `import { LockMetadata, StaleLockError } from './errors.js'`
3. Add `staleLockAction` to `ProjectLockOptions`
4. Add `isPidAlive` helper
5. Add `readLockMetadata` helper
6. Modify `withLock`: on `EEXIST`, read metadata, check staleness, auto-remove or throw `StaleLockError`
7. Write lock metadata with `hostname` field: `{ pid, acquired_at, hostname }`
8. Remove `withLockSync`
9. Remove the `queuedAsyncCallCount` field (no longer needed — was only used by `withLockSync` to reject)

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
  } catch {
    return false;
  }
}

function readLockMetadata(lockPath: string): LockMetadata | null {
  try {
    const raw = readFileSync(lockPath, 'utf-8').trim();
    return JSON.parse(raw) as LockMetadata;
  } catch {
    return null;
  }
}

export class ProjectLock {
  private readonly timeoutMs: number;
  private readonly retryDelayMs: number;
  private readonly staleLockAction: 'error' | 'remove';
  private activeHandle: LockHandle | null = null;
  private asyncQueue: Promise<void> = Promise.resolve();

  constructor(readonly lockPath: string, options: ProjectLockOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.retryDelayMs = options.retryDelayMs ?? 25;
    this.staleLockAction = options.staleLockAction ?? 'remove';
  }

  async withLock<T>(fn: (handle: LockHandle) => Promise<T>): Promise<T> {
    // ... queue slot management (same as before, but remove queuedAsyncCallCount)
    // On EEXIST: read metadata, if stale PID, either remove+retry or throw StaleLockError
    // Write metadata with hostname
  }

  assertOwns(handle: LockHandle): void { /* same as before */ }

  removeStaleLock(): boolean {
    // Read metadata, verify stale, remove lock file, return true if removed
    const meta = readLockMetadata(this.lockPath);
    if (!meta) return false;
    if (isPidAlive(meta.pid)) return false;
    try { unlinkSync(this.lockPath); return true; }
    catch { return false; }
  }
}
```

**Update callers of `withLockSync`:**

All current `withLockSync` callers run synchronous code. Convert each:

- `src/cards/card-store.ts:407` — `this.projectLock.withLockSync((handle) => { ... })` becomes `await this.projectLock.withLock(async (handle) => { ... })`. The method is inside `archiveCardAndDeleteSubtreeSync` — rename to `archiveCardAndDeleteSubtree` and make it async. But this may cascade... Let's take a different approach: provide a `withLockSync` that is a thin synchronous wrapper using spin-wait (no async queue) for the single-process case. Actually, looking at the callers more carefully:

Looking at the `withLockSync` usage:
- `apply-mutation.ts:143`: `withLockOnly` calls `deps.projectLock.withLockSync(...)`
- `card-store.ts:407`: Inside `archiveCardAndDeleteSubtreeSync`
- `runtime/state.ts`: Multiple `lock.withLockSync(...)` calls
- `projections/ledger-projections.ts`: Multiple `lock.withLockSync(...)` calls

Since removing `withLockSync` would force all these callers to become async (cascading async up the call stack extensively), and these callers all need synchronous execution, the cleaner approach is:

**Keep `withLockSync` but simplify it.** Remove the `queuedAsyncCallCount` rejection (it's not worth the complexity). Make `withLockSync` a simple synchronous acquire-release with stale detection. When async callers are queued, `withLockSync` still blocks until it can acquire, because the async queue runs on the same JS event loop. The real fix for F12 is stale detection, not removing sync.

Revised approach:
- Keep `withLockSync` but add stale detection and metadata validation to it
- Add stale detection to `withLock` async path
- Add `removeStaleLock()` method
- Add `StaleLockError`
- Both paths write metadata with `hostname`
- Both paths check staleness on `EEXIST`

This is simpler, less invasive, and still addresses the F12 finding (no stale recovery) without a massive async cascading refactor.

Updated implementation for Step 7:

**`src/persistence/project-lock.ts`:**

```ts
import { mkdirSync, openSync, closeSync, unlinkSync, existsSync, writeFileSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import os from 'node:os';
import { LockOwnershipError, LockTimeoutError, StaleLockError } from './errors.js';

// ... (LockHandle, ProjectLockOptions as before, plus staleLockAction)

function isPidAlive(pid: number): boolean { ... }
function readLockMetadata(lockPath: string): LockMetadata | null { ... }

function writeLockMetadata(lockPath: string, fd: number): void {
  const meta: LockMetadata = { pid: process.pid, acquired_at: new Date().toISOString(), hostname: os.hostname() };
  writeFileSync(fd, JSON.stringify(meta) + '\n', 'utf-8');
}

export class ProjectLock {
  // ... same fields plus staleLockAction
  // withLockSync: add stale detection on EEXIST, don't reject when queuedAsyncCallCount > 0
  // withLock: add stale detection on EEXIST
  // removeStaleLock(): read metadata, check PID, remove if stale
}
```

The key behavioral change: on `EEXIST`, both `withLockSync` and `withLock` read the lock file metadata. If the stored PID is not alive, they either remove the stale lock and retry (if `staleLockAction === 'remove'`) or throw `StaleLockError` (if `staleLockAction === 'error'`). Default is `'remove'`.

**Verification:** `npm run typecheck && npm test`. All existing lock tests pass. New stale-lock test added.

### Step 8: Create `src/utils/clock.ts` and `src/cards/shared.ts`

**Files:** Create `src/utils/clock.ts`, create `src/cards/shared.ts`

`src/utils/clock.ts`:
```ts
export function now(): string {
  return new Date().toISOString();
}
```

`src/cards/shared.ts`:
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

**Files:** Modify 8 files, each in its own focused change:

1. `src/runtime/runtime.ts` — remove local `now`, add `import { now } from '../utils/clock.js'`
2. `src/runtime/runtime-startup.ts` — remove local `now`, add `import { now } from '../utils/clock.js'`
3. `src/runtime/activation-repair.ts` — remove local `now`, add `import { now } from '../utils/clock.js'`
4. `src/runtime/synthetic-planner-notes.ts` — remove local `now`, add `import { now } from '../utils/clock.js'`
5. `src/runtime/process-runner.ts` — remove local `now`, add `import { now } from '../utils/clock.js'`
6. `src/cards/card-store.ts` — remove local `now`, add `import { now } from '../utils/clock.js'`; remove local `valuesEqual`, add `import { valuesEqual } from './shared.js'`
7. `src/cards/artifacts.ts` — remove local `now`, add `import { now } from '../utils/clock.js'`
8. `src/cards/lifecycle.ts` — remove local `valuesEqual`, add `import { valuesEqual } from './shared.js'`
9. `src/agents/analyst-handler.ts` — remove local `now`, add `import { now } from '../utils/clock.js'`

**Verification:** `npm run typecheck && npm test` after all changes.

### Step 10: Migrate `valuesEqual` from `lifecycle.ts` to `shared.ts`

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
  const redacted = redactTextForOutbound(text, 'provider.diagnostic', { source: 'invocation-recovery-policy' });
  const result = redacted as string;
  if (result.length > maxLength) return `${result.slice(0, maxLength)}…`;
  return result;
}
```

**Verification:** `npm run typecheck && npm test`. The recovery policy tests should pass with the new redaction (which covers all the patterns that were in `SECRET_PATTERNS` plus more).

### Step 12: Extract raw JSONL helpers to `raw-jsonl.ts`

**Files:** Create `src/persistence/raw-jsonl.ts`, modify `src/persistence/jsonl-ledger.ts`, modify `src/persistence/index.ts`

**`src/persistence/raw-jsonl.ts`:** Move `LastLineSyncResult`, `lastLineSync`, `appendSyncIdempotent`, `appendSyncIdempotentByKey` from `jsonl-ledger.ts` to this new file. Keep the same imports (`node:fs`, `node:path`, `./errors.js`).

Remove the comment block about "raw (non-versioned) JSONL helpers" (the section comment from lines 140-142 of `jsonl-ledger.ts`), since the file name now communicates the convention.

**`src/persistence/jsonl-ledger.ts`:** Remove the raw functions and their comment block (lines 140-251). The `JsonlLedger` class remains as the versioned-envelope authority.

**`src/persistence/index.ts`:** Change the export of `appendSyncIdempotent`, `appendSyncIdempotentByKey`, `lastLineSync` from `./jsonl-ledger.js` to `./raw-jsonl.js`. Add `LastLineSyncResult` type export from `./raw-jsonl.js`.

**Verification:** `npm run typecheck && npm test`. All callers of `appendSyncIdempotent` etc. still resolve through the index re-export.

### Step 13: Make diary read failures explicit

**Files:** Modify `src/cards/diary.ts`

**Add `DiaryReadError`:**

```ts
export class DiaryReadError extends Error {
  constructor(readonly goalCardId: string, readonly missingEntryId: string, readonly missingFilename: string) {
    super(`Diary entry ${missingEntryId} (${missingFilename}) missing for goal ${goalCardId}`);
  }
}
```

**`getDiaryEntries`:** When `existsSync(path)` is false, throw `DiaryReadError` instead of skipping. Change:

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

**`getReviewAssessments`:** When `diaryEntry?.assessment` is falsy (which currently includes both `null` diary entry and missing assessment), throw `DiaryReadError` instead of fabricating a synthetic empty assessment. Change:

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
  if (!diaryEntry?.assessment) {
    throw new DiaryReadError(goalCardId, rev.diary_entry_id, rev.id);
  }
  assessments.push(diaryEntry.assessment);
}
```

**Verification:** `npm run typecheck && npm test`. Tests that relied on silent skip/fabrication behavior will need to be updated to expect `DiaryReadError`. This is intentional — silent data degradation is a bug, not a feature.

---

## Implementation Dependency Order

```
Step 1 (durable-write.ts) ──→ Step 2 (file-tree delegates) ──→ Step 3 (atomic-json-file uses fsyncDir)
                          ──→ Step 4 (apply-mutation uses fsyncDir/fsyncFile)
                          ──→ Step 5 (commit-marker uses fsyncDir)

Step 6 (StaleLockError)  ──→ Step 7 (ProjectLock rewrite)

Step 8 (clock.ts, shared.ts) ──→ Step 9 (now() migration) ──→ Step 10 (valuesEqual migration)

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
   grep -rn 'function fsyncDir\|function fsyncDirectory\|function fsyncFileAtPath' src/
   ```

2. **now() consolidation:** Grep for local `now()` definitions — none should remain outside `clock.ts`:
   ```bash
   grep -rn 'function now()' src/
   ```

3. **valuesEqual consolidation:** Grep for local `valuesEqual` definitions — none should remain outside `shared.ts`:
   ```bash
   grep -rn 'function valuesEqual' src/
   ```

4. **Stale lock recovery:** Manually test by creating a lock file, killing the process, and verifying that a new lock acquisition succeeds:
   ```bash
   # Create a stale lock with a dead PID
   echo '{"pid":99999,"acquired_at":"2026-01-01T00:00:00Z","hostname":"test"}' > .saivage/.lock
   # Verify a new ProjectLock.withLock() call succeeds (stale lock is removed)
   ```

5. **JSONL separation:** Verify `appendSyncIdempotent` and `lastLineSync` are importable from `../persistence/index.js` and that existing callers (card-store, state, session-persistence) still work.

6. **Diary explicit errors:** Verify that `getDiaryEntries` throws instead of silently skipping, and that `getReviewAssessments` throws instead of fabricating empty objects.

7. **All persistence primitives exercised:** Card creation, card update, card deletion (uses `applyMutation`, `commit-marker`, `writeFileSyncDurable`, `fsyncDir`, `appendSyncIdempotent`), project lock acquisition and release, JSONL ledger read/write, diary read/write.
