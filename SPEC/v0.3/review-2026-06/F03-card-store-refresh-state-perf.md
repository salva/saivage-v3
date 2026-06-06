# F03: CardStore.refreshState() Re-Scans All Cards on Every Read

**Severity:** HIGH  
**Transversality:** LOCAL  
**Category:** Bad data representation / Performance  
**Verdict:** SOUND — confirmed at `src/cards/card-store.ts:218-220,241-278` and `src/cards/state.ts:408-547`

## Summary

Every public read method (`read`, `list`, `listChildren`, `getParent`, `getAncestors`, `getDescendantIds`, `detectCycles`) calls `this.refreshState()` which calls `loadCardStoreState()` — a full filesystem scan of every card JSON file plus history. This makes every card read O(n) in I/O.

## Corrected Evidence

- `src/cards/card-store.ts:218-220` — `refreshState()` calls `loadCardStoreState` unconditionally
- `src/cards/card-store.ts:241-278` — Seven read methods call `this.refreshState()`
- `src/cards/state.ts:408-547` — `loadCardStoreState` reads card files, validates history, scans archive
- `src/cards/card-store.ts:100-102` — `deepClone` via JSON round-trip on every read

Overstatement corrected: "all history JSONL files" is imprecise. `loadCardStoreState` validates history invariants and scans filenames, but does not necessarily load every history entry into memory. The race condition claim is weak because writes use atomic/locked paths. The core proven issue is read-time full reload.

## Clean Architecture Approach

Make `CardStoreState` the authoritative in-process read model. Mutations update it synchronously after durable writes. Reloading should be explicit (e.g., `invalidate()` called after external writes), not implicit on every read. Remove `deepClone` and make card records immutable at the type level.