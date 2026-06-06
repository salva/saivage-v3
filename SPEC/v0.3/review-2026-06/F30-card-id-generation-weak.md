# F30: Card ID Generation Is Weak and O(n)

**Severity:** LOW  
**Transversality:** LOCAL  
**Category:** Bad data representation  
**Verdict:** PARTLY SOUND — O(n) and predictable are real; concurrent collision overstated

## Summary

`CardStore.generateId()` scans all existing IDs for the highest numeric suffix and increments it. This is O(n) per creation, predictable, and could select the same ID before the project lock is acquired.

## Corrected Evidence

- `src/cards/card-store.ts:108-118` — `generateId` scans all existing IDs

Overstatement corrected: mutations are serialized under `ProjectLock` in `apply-mutation.ts:163-170`, and duplicate creation is rejected at `apply-mutation.ts:195-204`. Concurrent creators can select the same ID but one will fail, not corrupt data. The real issues are predictability and O(n) cost.

## Clean Architecture Approach

Generate IDs inside the locked mutation, or use random/ULID-style IDs. The simplest fix: let `applyMutationLocked` assign the ID from a monotonic counter or random source, not from a scan of existing IDs.