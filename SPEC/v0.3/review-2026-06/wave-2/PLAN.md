# Wave 2: Card Data Model — Plan & Design

## Second Review Corrections

This section supersedes both the Reviewed Corrections and any conflicting text below.

1. **CRITICAL — Remove Step 1 entirely**: Step 1 creates `src/cards/shared.ts` and moves `now()`/`valuesEqual()`. Reviewed Correction #17 says "Drop shared utility extraction from this wave. Wave 1 owns utilities." The metaplan assigns F17 to Wave 1. Delete Step 1.
2. **CRITICAL — Design section still shows stale flag / `ensureFresh()` pattern**: The F03 Design section describes `private stale = true` and `ensureFresh()`. Reviewed Correction #1 says "Do not use a stale flag with conditional read reloads. Reads do no I/O. `invalidate()` immediately reloads synchronously." Remove the stale-flag/ensureFresh design entirely. Reads return `this.state.get(id)` directly. `invalidate()` unconditionally reloads: `this.state = loadCardStoreState(this.projectRoot, { maxDepth: this.maxDepth })`.
3. **CRITICAL — Keep defensive cloning**: The design says "Remove deepClone." Reviewed Correction #3 says "Do not remove deepClone in this wave unless records are deeply frozen on write and public reads return `DeepReadonly<CardRecord>`. The corrected plan keeps defensive cloning." Do NOT remove Step 6 (deepClone removal) or replace it with "freeze on write, return `Readonly<CardRecord>` while keeping the clone."
4. **CRITICAL — Do not add `ulid`**: Step 7 says "Add `ulid` as a dependency." Reviewed Correction #14 says "Do not add `ulid`. Keep `card-N`, move ID generation inside the project lock." Move `generateId` call inside `applyMutationLocked`/the locked body of `create()`. Preserve `PROJECT_CARD_ID` special-casing.
5. **CRITICAL — Correct step sequence**: Reviewed Correction #15 says "locked create validation/id/depth/position first, remove read refresh second, split loader/validator third, remove denormalized blocks fourth." Current order is: shared utils → validator → loader → blocks → refreshState → deepClone → ULID → depthCache. Correct order: (1) move ID generation inside lock (F30), (2) remove refreshState from reads + add invalidate(), (3) split state/loader/validator, (4) remove denormalized blocks. Drop shared-utils (Wave 1), deepClone (correction #3), and depthCache (correction #16).
6. **HIGH — Error classes go in `src/cards/errors.ts` not `validator.ts`**: Reviewed Correction #5. `CardStoreInvariantError` and `ReorderSetMismatchError` must be in a separate `errors.ts` to avoid cycles between `state.ts`, `validator.ts`, and loader modules.
7. **HIGH — Loader goes in `src/persistence/card-loader.ts` not `src/cards/loader.ts`**: Reviewed Correction #7. The metaplan lists `new src/persistence/card-loader.ts` for F24. Use `persistence/card-loader.ts`.
8. **HIGH — No optional transition field for `blocks`**: Reviewed Correction #9. Remove `blocks` from `CardRecord` type in `src/schemas/types.ts` AND `cardRecordSchema` in `src/schemas/validators.ts` in one step. Do NOT use `.optional()`. The loader's `parseCard()` must strip `blocks` from raw input before schema validation.
9. **HIGH — Add `CardStore.blocksFor(id)` public method**: Reviewed Correction #10. External callers (web, API routes, runtime) use `store.blocksFor(id)`, not `state.blocksFor()`. Add `blocksFor(id: string): string[] { return this.state.blocksFor(id); }` to `CardStore`.
10. **HIGH — Card history migration needs normalization**: `cardHistoryEntrySchema.snapshot` uses `cardRecordSchema`. After removing `blocks` from the schema, existing JSONL history files containing `blocks` would fail validation. `parseCard()` must normalize (strip `blocks`) before schema validation. Add this as an explicit substep.
11. **HIGH — No temporary barrel re-exports from `state.ts`**: Reviewed Correction #6. Move symbols and update all importers in the same step. Do not add re-exports from `state.ts`.
12. **HIGH — All `refreshState()` calls must be enumerated**: Read methods (7) AND mutation methods (4) call `refreshState()`: `create()` (line 329), `appendEvidenceRefs()` (line 409), `reorderChildren()` (line 488), `archiveAndDeleteSubtree()` (line 623). All 12 must be removed.
13. **HIGH — Explicit `blocks` caller enumeration**: The plan says "search for all references." Explicit callers: `src/cards/lifecycle.ts` (TRACKED_FIELDS, buildUpdatedCard, buildNewCard), `src/agents/planner-control-executor.ts:182`, `src/tools/analyst-card-tools.ts:104`, `src/runtime/context-builder.ts:137`, `src/application/read-models/debug-read-model.ts:24`, `src/cards/state.ts` (upsert, refreshBlocksField, dependents spread), `web/src/stores/analystChat.ts:235`, `web/src/api/types.ts` (lines 189, 262), `web/src/components/cards/CardDetailView.vue` (lines 72, 75), `web/src/stores/debug.ts:86`, plus test fixtures.
14. **HIGH — NewCardInput/buildNewCard updates**: Remove `blocks: []` from `buildNewCard()`, `planner-control-executor.ts`, and `analyst-card-tools.ts` create inputs. Remove `'blocks'` from `TRACKED_FIELDS` in lifecycle.ts.
15. **HIGH — Missing test updates**: Every step needs explicit test-update substeps: remove `blocks` from mock CardRecord fixtures, add two-store invalidate tests, add `blocksFor()` tests, update `web/src/api/types.ts` and `DebugStateResponse`.
16. **MEDIUM — `valuesEqual` also in `lifecycle.ts`**: `src/cards/lifecycle.ts:105` defines its own `valuesEqual`. If Wave 1 extracts it, `lifecycle.ts` must also be updated.
17. **MEDIUM — Schema files are `types.ts` and `validators.ts`, not `index.ts`**: Step 4 says "`src/schemas/index.ts` (or wherever CardRecord Zod schema is)." Use `src/schemas/types.ts` (type) and `src/schemas/validators.ts` (Zod schema).
18. **MEDIUM — Delete `_depthCache` and `depthOf()` entirely**: Reviewed Correction #16. `_depthCache` has zero external consumers. Remove `_depthCache` property, `depthOf()` method, and `_depthCache.clear()` calls in `upsert()`/`remove()`. Do NOT add `invalidateDepths()`.
19. **MEDIUM — Reorder steps per correction #15**: 1. Move ID generation inside lock (no ulid), 2. Remove all refreshState calls + add invalidate(), 3. Split state/loader/validator/errors, 4. Remove denormalized blocks. Drop shared-utils, deepClone-removal, depthCache-targeting steps.

## Reviewed Corrections

This section supersedes any conflicting text below.

1. Do not use a stale flag with conditional read reloads. Reads do no I/O. `invalidate()` or `reloadFromDisk()` immediately reloads synchronously from disk.
2. A `CardStore` instance is authoritative only for its own mutation path. External writers require explicit `store.invalidate()` before reads. Add two-store tests: stale-before-invalidate and fresh-after-invalidate.
3. Do not remove `deepClone` in this wave unless records are deeply frozen on write and public reads return `DeepReadonly<CardRecord>`. The corrected plan keeps defensive cloning.
4. Validator boundary: validate parsed raw cards before state seeding. Use `validateParsedCards({ cards, maxDepth }): { depthById; cardsInDepthOrder }`; do not validate through `CardStoreState`.
5. Create `src/cards/errors.ts` for `CardStoreInvariantError` and `ReorderSetMismatchError` to avoid cycles between `state.ts`, `validator.ts`, and loader modules.
6. Do not keep temporary compatibility re-exports from `state.ts`. Move symbols and update imports in the same step. After splitting, `state.ts` exports only `CardStoreState`.
7. Prefer `src/persistence/card-loader.ts` for filesystem loading, matching the metaplan. If kept under cards, update the metaplan and justify it.
8. Remove `blocks` from persisted `CardRecord`, not necessarily from operator views. Persisted cards have `depends_on`; `CardStoreState` owns reverse dependency adjacency; `CardStore.blocksFor(id)` exposes derived blockers.
9. `blocks` removal changes `src/schemas/types.ts` first, then `src/schemas/validators.ts`. Do not use an optional transition field unless introducing a separate persisted compatibility type.
10. Add `CardStore.blocksFor(id: string): string[]`; production consumers use the store/read-model, not `state.blocksFor(...)` directly.
11. Keep `_blocksInverse` cleanup. Remove only denormalized `blocks` writes: `computeBlocksArrayFor`, `refreshBlocksField`, and `{ ...card, blocks: ... }`.
12. Update `NewCardInput`, `buildNewCard`, create callers, fixtures, web API types, debug store, analyst chat context, `CardDetailView`, and current docs referencing `blocks`.
13. `CardHistoryEntry.snapshot` uses `CardRecord`; update history validation and fixtures consistently when removing persisted `blocks`.
14. Do not add `ulid`. Keep `card-N`, but move ID generation inside the project lock. Preserve project-card exception and reserved IDs while sequential IDs exist.
15. Correct sequence: locked create validation/id/depth/position first, remove read refresh second, split loader/validator third, remove denormalized `blocks` fourth.
16. Delete targeted `_depthCache` invalidation. `_depthCache` is not populated/useful; either remove it and `depthOf()` or leave current clearing until a real cache user exists.
17. Drop shared utility extraction from this wave. Wave 1 owns utilities.
18. Validation must not use manual logging. Add focused two-store invalidate tests and web checks if outbound `blocks` changes.

**Issues:** F03, F24, F30  
**Risk:** HIGHEST — touches every card read/write path  
**Prerequisite:** Wave 1 (persistence primitives) should be complete  
**Validation:** `npm run validate:routine`, `npm test`, manual card CRUD and archival

---

## Design

### F03: Eliminate refreshState() on every read

**Current:** `CardStore.read()`, `list()`, `listChildren()`, `getParent()`, `getAncestors()`, `getDescendantIds()`, `detectCycles()` all call `this.refreshState()` → `loadCardStoreState()` → full filesystem scan.

**Target:** `CardStoreState` is the authoritative in-memory read model. Mutations update it synchronously after durable writes. No implicit reload on reads.

**New API:**

```typescript
// src/cards/card-store.ts
class CardStore {
  private state: CardStoreState;
  private version: number; // increments on every mutation
  
  // Reads: immediate, no I/O
  read(id: string): CardRecord | null
  list(): CardRecord[]
  listChildren(parentId: string): string[]
  // ...

  // Explicit invalidation for external writers (rare)
  invalidate(): void { this.stale = true; }
  
  // Private: reload only when stale
  private ensureFresh(): void {
    if (this.stale) { this.state = loadCardStoreState(this.projectRoot, { maxDepth: this.maxDepth }); this.stale = false; }
  }
}
```

The constructor calls `loadCardStoreState` once. After that:
- Every mutation method (`create`, `setStatus`, `archiveAndDeleteSubtree`, etc.) already calls `applyMutationSync` which writes to disk, then calls `this.state.upsert(updatedCard)` to update the in-memory model.
- The only reason `refreshState()` existed was to pick up external writes. Replace this with an explicit `invalidate()` that callers use when they know an external process may have written.

**Remove `deepClone`:** Make `CardRecord` deeply readonly at the type level (`Readonly<...>` with recursive mapped type). Return the record directly from the map. Callers who need mutation make their own copy.

### F24: Split state.ts into read model, loader, and validator

**Current `state.ts` (547 lines)** mixes three roles:
1. `CardStoreState` class — in-memory read model + adjacency cache + adjacency mutation (lines 52-277)
2. `readJsonFile`, `parseCard`, `readHistoryEntriesStrict`, `validateCardHistoryInvariant` — filesystem I/O + validation (lines 279-396)
3. `loadCardStoreState` — disk loading + 9 invariant checks + boot (lines 398-547)

**Target structure:**

```
src/cards/
  state.ts          → CardStoreState class only (adjacency read model, upsert, remove, queries)
  loader.ts          → loadCardStoreState() + parseCard + readJsonFile + byIdDir/historyDir helpers
  validator.ts       → validateCardStoreInvariants() + validateCardHistoryInvariant()
  shared.ts          → valuesEqual(), now() (removed from card-store.ts)
```

**`state.ts` (pure read model):**
- `CardStoreState` class with `upsert()`, `remove()`, query methods, adjacency caches
- No filesystem imports. No `loadCardStoreState`.
- `_blocksInverse` becomes the canonical blocks source; `blocks` field on `CardRecord` is computed from it (or removed from the schema entirely, with callers using `blocksFor()`)
- `_depthCache` is invalidated only for ancestors of the mutated card, not all cards

**`loader.ts`:**
- `loadCardStoreState(projectRoot, options)` — reads filesystem, calls validator, returns `CardStoreState`
- `parseCard()`, `readJsonFile()`, `cardByIdPath()`, `cardHistoryPath()`, `byIdDir()`, `historyDir()`
- `readHistoryEntriesStrict()`

**`validator.ts`:**
- `validateCardStoreInvariants(state, projectRoot)` — the 9 invariant checks currently in `loadCardStoreState`
- `validateCardHistoryInvariant()` — extracted as-is

**Denormalized `blocks` field:**
Remove `blocks` from `CardRecord` schema. It is redundant with `_blocksInverse`. Callers that need "which cards block this one" use `state.blocksFor(cardId)` or `state.blocksFor(id)` from the inverse map. This eliminates `refreshBlocksField()` and the O(degree) write propagation on every upsert.

### F30: Generate card IDs inside locked mutations

**Current:** `generateId()` (line 108-118) scans all existing IDs for the highest numeric suffix, then increments. Called before the lock, so concurrent creation can select the same ID.

**Target:** Use ULID-style IDs. Generate the ID inside `applyMutationSync` after acquiring the lock.

```typescript
// src/cards/card-store.ts
import { ulid } from 'ulid';

// In create():
const id = ulid();
// Remove generateId function
// Remove __RESERVED_IDS from CardStoreState (no longer needed for collision avoidance)
```

If adding a dependency is undesirable, use a monotonic counter stored in the same locked transaction:

```typescript
// Inside applyMutationLocked:
const nextId = `card-${state.nextCardId()}`;
// where nextCardId() returns max(existing numeric IDs) + 1
```

This is safe because it runs inside the project lock. The `__RESERVED_IDS` set can be removed since ULIDs don't collide.

---

## Step-by-Step Implementation

### Step 1: Extract shared utilities from card-store.ts

**Files:** `src/cards/shared.ts` (new), `src/cards/card-store.ts`

Create `src/cards/shared.ts`:
```typescript
export function now(): string { return new Date().toISOString(); }
export function valuesEqual(a: unknown, b: unknown): boolean { return JSON.stringify(a) === JSON.stringify(b); }
```

Remove `now()` and `valuesEqual()` from `card-store.ts`. Add imports from `./shared.js`.

Update all callers of `now()` in cards/ to import from `./shared.js`:
- `src/cards/artifacts.ts` — remove local `now()`, import from shared
- `src/cards/card-store.ts` — remove local `now()` and `valuesEqual()`, import from shared

**Verify:** `npm run typecheck && npm test`

### Step 2: Extract validator from state.ts

**Files:** `src/cards/validator.ts` (new), `src/cards/state.ts`

Create `src/cards/validator.ts`:
- Move `CardStoreInvariantError`, `ReorderSetMismatchError` from `state.ts`
- Move `validateCardHistoryInvariant()` and `parseHistoryLine()` from `state.ts`
- Add `validateCardStoreInvariants(state: CardStoreState, projectRoot: string): void` that performs the 9 invariant checks currently in `loadCardStoreState` lines 424-522

Update `state.ts` to import `CardStoreInvariantError` and `ReorderSetMismatchError` from `./validator.js`.

Update `loadCardStoreState` to call `validateCardStoreInvariants(state, projectRoot)` instead of inline checks.

**Verify:** `npm run typecheck && npm test`

### Step 3: Extract loader from state.ts

**Files:** `src/cards/loader.ts` (new), `src/cards/state.ts`

Create `src/cards/loader.ts`:
- Move `loadCardStoreState()`, `readJsonFile()`, `parseCard()`, `byIdDir()`, `historyDir()`, `cardByIdPath()`, `cardHistoryPath()`, `readHistoryEntriesStrict()` from `state.ts`
- Import `validateCardStoreInvariants` and `validateCardHistoryInvariant` from `./validator.js`
- Import `CardStoreState` from `./state.js`

Update `state.ts` to re-export `loadCardStoreState`, `cardByIdPath`, `cardHistoryPath`, `readHistoryEntriesStrict` from `./loader.js` (temporary barrel to keep imports working).

Update all external importers to import from `./loader.js` or `./validator.js` as appropriate. Remove the barrel re-exports after all importers are updated.

**Verify:** `npm run typecheck && npm test`

### Step 4: Remove denormalized `blocks` field from CardRecord

**Files:** `src/schemas/index.ts` (or wherever `CardRecord` Zod schema is), `src/cards/state.ts`, `src/cards/card-store.ts`, all callers of `card.blocks`

This is the most impactful step. The `blocks` field on `CardRecord` is denormalized — it's always derivable from `_blocksInverse`.

1. Remove `blocks` from the `CardRecord` Zod schema (make it optional during transition with `.optional()`).
2. In `CardStoreState.upsert()`, remove the `refreshBlocksField()` call and the `blocks` assignment in the spread.
3. In `CardStoreState.remove()`, remove the `blocksInverse` cleanup already present.
4. Update all callers of `card.blocks` to use `state.blocksFor(card.id)` instead.
5. Once all callers are updated, remove the `blocks` field from the Zod schema entirely.

Search for all `card.blocks` and `.blocks` references across the codebase and update them.

**Verify:** `npm run typecheck && npm test`

### Step 5: Remove refreshState() on reads, add invalidate()

**Files:** `src/cards/card-store.ts`

1. Remove the `refreshState()` call from `read()`, `list()`, `listChildren()`, `getParent()`, `getAncestors()`, `getDescendantIds()`, `detectCycles()`.
2. Add a `private stale = true` flag. Set it to `true` in the constructor.
3. Add a `private ensureFresh()` method that calls `loadCardStoreState` and sets `stale = false`.
4. Call `ensureFresh()` in the constructor only.
5. Add `invalidate()` method that sets `stale = true`.
6. All mutation methods already update `this.state` after durable writes (via `upsert`). Verify each mutation does this correctly.

The `state` field becomes an authoritative in-memory model. The only time it reloads from disk is on construction or after explicit `invalidate()`.

**Verify:** `npm run typecheck && npm test`. Manual: create card, read card, update card status, read again — must reflect mutation without reload.

### Step 6: Remove deepClone from reads

**Files:** `src/cards/card-store.ts`, `src/cards/state.ts`, callers

1. In `state.ts`, make `CardRecord` return type `Readonly<CardRecord>` (or use a mapped type to make all fields readonly).
2. Remove `deepClone` function from `card-store.ts`.
3. `read()` returns `CardRecord | null` directly from the map — callers cannot mutate.
4. `list()` returns `Array.from(this.state.list())` — no deep clone needed since CardRecord fields are primitive or readonly arrays.

Update any callers that mutate returned card records (they should use the store's mutation methods).

**Verify:** `npm run typecheck && npm test`

### Step 7: Replace generateId with ULID

**Files:** `src/cards/card-store.ts`

1. Add `ulid` as a dependency (or implement a simple monotonic counter).
2. Replace `generateId(existingIds)` with `ulid()` in `create()`.
3. Remove `generateId` function and `__RESERVED_IDS` set from `CardStoreState`.
4. Remove `addReservedId()` and `isReservedId()` from `CardStoreState` (ULIDs don't collide).
5. Remove reserved ID scanning from `loadCardStoreState` (the history/archive directory scans).

**Verify:** `npm run typecheck && npm test`. Manual: create multiple cards, verify IDs are unique and monotonically sortable.

### Step 8: Optimize _depthCache invalidation

**Files:** `src/cards/state.ts`

Replace `this._depthCache.clear()` (which invalidates all depths) with targeted invalidation:

```typescript
private invalidateDepths(changedId: string): void {
  this._depthCache.delete(changedId);
  // Invalidate all ancestors
  let current = this._cards.get(changedId);
  while (current && current.parent !== null) {
    this._depthCache.delete(current.parent);
    current = this._cards.get(current.parent);
  }
}
```

Call `this.invalidateDepths(card.id)` in `upsert()` and `remove()` instead of `this._depthCache.clear()`.

**Verify:** `npm run typecheck && npm test`

---

## Validation

After all steps:

1. `npm run typecheck` — must pass
2. `npm test` — all existing tests must pass
3. `npm run validate:routine` — routine validation passes
4. Manual test:
   - Create a card, read it, update its status, read again — must reflect mutation
   - Create child cards, verify parent/child queries work
   - Archive and delete a subtree
   - Verify card IDs are ULID-style (not `card-N`)
   - Verify no filesystem reads during normal card reads (add a `console.log` to `loadCardStoreState` — it should only be called once on startup)
   - Verify `invalidate()` works: modify card file externally, call `invalidate()`, read card — must reflect external change
