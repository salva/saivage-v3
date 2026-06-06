# F28: Content Supervisor Writes to Disk on Every Safe Scan

**Severity:** LOW  
**Transversality:** LOCAL  
**Category:** Unneeded feature  
**Verdict:** SOUND — confirmed at `src/workspace/content-supervisor.ts` and `src/workspace/quarantine.ts`

## Summary

`ContentSupervisor.screenContent()` records a JSONL entry for every piece of content that passes the heuristic scan, even trivially safe content. The quarantine module uses synchronous file I/O throughout, and `appendJsonl` reads the entire file, appends, and rewrites atomically — not safe under concurrent writes.

## Corrected Evidence

- `src/workspace/content-supervisor.ts:142-154` — `recordContentPass` writes to disk for every safe scan
- `src/workspace/quarantine.ts:12,69-79` — Synchronous I/O and read-whole-file-then-rewrite pattern

Overstatement: the module assumes low volume, which may be acceptable for current usage. The race condition is real if concurrent writers exist.

## Clean Architecture Approach

Do not persist safe pass records by default. Persist only blocked/escalated decisions. Use append-only file descriptor writes under the project lock for any JSONL audit stream. Make pass-recording configurable.