# F24: Cards State Module Mixes I/O, Validation, and In-Memory Read Model

**Severity:** MEDIUM  
**Transversality:** LOCAL  
**Category:** Tangled code / Bad abstraction  
**Verdict:** SOUND — confirmed at `src/cards/state.ts`

## Summary

`CardStoreState` (547 lines) combines three roles: (1) an in-memory read model / adjacency cache, (2) a boot-time validator performing 9 invariant checks, and (3) filesystem I/O for loading card files. The `blocks` field is denormalized with O(degree) refresh on every mutation, and `_depthCache` is invalidated for all cards on any mutation.

## Corrected Evidence

- `src/cards/state.ts:1-53` — Filesystem persistence operations inside the state class
- `src/cards/state.ts:220-405` — 9 invariant checks mixed with cache management
- `src/cards/state.ts:408-547` — `loadCardStoreState` reads filesystem directly
- `src/cards/state.ts:56-57` — Denormalized `blocks` field
- `src/cards/state.ts:141-150` — `_blocksInverse` refresh propagation
- `src/cards/state.ts:237-249` — `_depthCache.clear()` on every mutation

## Clean Architecture Approach

Keep `CardStoreState` as a pure in-memory adjacency/read model. Move disk loading/parsing into the persistence module. Move boot invariants into a standalone validator that consumes already-parsed records. Remove denormalized `blocks` from `CardRecord` — compute it on demand from `_blocksInverse` or remove the inverse map and compute adjacency queries from parent/child edges.