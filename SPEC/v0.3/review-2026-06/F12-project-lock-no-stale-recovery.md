# F12: ProjectLock Has No Stale-Lock Recovery

**Severity:** MEDIUM  
**Transversality:** LOCAL  
**Category:** Bad data representation  
**Verdict:** SOUND — confirmed at `src/persistence/project-lock.ts`

## Summary

The project lock uses exclusive file creation (`O_WRONLY | O_EXCL | O_CREAT`). On process crash, the stale lock file blocks subsequent acquisitions. The lock stores PID and timestamp metadata but never reads it for stale detection. Additionally, the sync and async lock paths cannot coexist — the sync path rejects immediately if async locks are queued, rather than deadlock, but the behavior is still confusing.

## Corrected Evidence

- `src/persistence/project-lock.ts:41-46` — Exclusive lock creation with PID/timestamp metadata written
- `src/persistence/project-lock.ts:82-88` — Same pattern for async lock
- `src/persistence/project-lock.ts:33-36` — `withLockSync` rejects if `queuedAsyncCallCount > 0`
- `src/persistence/project-lock.ts:64-108` — `withLock` uses promise queue, not interruptible

Overstatement corrected: the sync/async conflict is not a deadlock — the sync path fails immediately. But it still means sync and async callers cannot interoperate.

## Clean Architecture Approach

One lock authority with one queue and explicit stale-lock policy (check lock metadata: PID alive? lock age?). Remove or demote the sync path — make all callers use the async authority. Store lock metadata (PID, timestamp, hostname) and validate before declaring a project locked.