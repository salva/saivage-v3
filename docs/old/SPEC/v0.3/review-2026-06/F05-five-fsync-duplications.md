# F05: Four Duplicated Directory fsync Implementations and Multiple Atomic-Write Patterns

**Severity:** MEDIUM  
**Transversality:** CROSS-CUTTING  
**Category:** Duplication of concerns  
**Verdict:** PARTLY SOUND — four (not five) direct fsync duplications; quarantine delegates to writeFileAtomic

## Summary

Directory fsync logic is duplicated in four files. Additionally, three separate atomic-write patterns exist that bypass the persistence module's `AtomicJsonFile`: `apply-mutation.ts` has its own write+fsync+rename dance, `diary.ts` uses `writeFileAtomic` from `file-tree.ts`, and `AtomicJsonFile` uses its own versioned-envelope pattern.

## Corrected Evidence

Direct `fsyncDirectory`/`fsyncDir` implementations:
- `src/cards/apply-mutation.ts:89-100`
- `src/cards/commit-marker.ts:65-76`
- `src/persistence/atomic-json-file.ts:19-29`
- `src/persistence/file-tree.ts:31-45`

Overstatement corrected: `src/workspace/quarantine.ts` uses `writeFileAtomic` (from `file-tree.ts`), not an inline fsync. The count is four, not five.

Separate atomic-write conventions:
- `src/cards/apply-mutation.ts` — write+fsync+rename (no version envelope)
- `src/persistence/atomic-json-file.ts` — version-enveloped atomic write
- `src/persistence/file-tree.ts` — `writeFileAtomic` (no version envelope, no fsync)

## Clean Architecture Approach

Put directory fsync and durable temp-write/rename in one persistence primitive module. Provide clearly named operations: `writeFileAtomicFast` (no fsync, rename-only) and `writeFileDurableAtomic` (fsync+rename). Remove all local fsync helpers. Card mutation writes should use one of these, not their own write+fsync+rename.