# Wave 2: Card Data Model — Plan & Design

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
  invalidate(): void {
    this.state = loadCardStoreState(this.projectRoot, { maxDepth: this.maxDepth });
  }
}
```

The constructor calls `loadCardStoreState` once. After that:
- Every mutation method (`create`, `setStatus`, `archiveAndDeleteSubtree`, etc.) already calls `applyMutationSync` which writes to disk, then calls `this.state.upsert(updatedCard)` to update the in-memory model.
- The only reason `refreshState()` existed was to pick up external writes. Replace this with an explicit `invalidate()` that immediately reloads from disk. Callers use it when they know an external process may have written.
- **No stale flag, no `ensureFresh()`.** Reads perform zero I/O and return directly from the in-memory model. `invalidate()` unconditionally reloads synchronously from disk.
- A `CardStore` instance is authoritative only for its own mutation path. External writers require explicit `store.invalidate()` before reads. Add two-store tests: stale-before-invalidate and fresh-after-invalidate.
- **Keep defensive cloning (`deepClone`).** Do not remove `deepClone` in this wave. `CardRecord` remains mutable at the type level; reads return cloned records to prevent accidental mutation of store state.

### F24: Split state.ts into read model, loader, and validator

**Current `state.ts` (547 lines)** mixes three roles:
1. `CardStoreState` class — in-memory read model + adjacency cache + adjacency mutation (lines 52-277)
2. `readJsonFile`, `parseCard`, `readHistoryEntriesStrict`, `validateCardHistoryInvariant` — filesystem I/O + validation (lines 279-396)
3. `loadCardStoreState` — disk loading + 9 invariant checks + boot (lines 398-547)

**Target structure:**

```
src/cards/
  state.ts          → CardStoreState class only (adjacency read model, upsert, remove, queries)
  validator.ts       → validateCardStoreInvariants() + validateCardHistoryInvariant()
  errors.ts          → CardStoreInvariantError, ReorderSetMismatchError
src/persistence/
  card-loader.ts     → loadCardStoreState() + parseCard + readJsonFile + byIdDir/historyDir helpers
```

**`state.ts` (pure read model):**
- `CardStoreState` class with `upsert()`, `remove()`, query methods, adjacency caches
- No filesystem imports. No `loadCardStoreState`.
- `_blocksInverse` is the canonical blocks source; `blocks` field on `CardRecord` is removed entirely, with callers using `blocksFor()`
- `_depthCache` and `depthOf()` are deleted entirely. No `invalidateDepths()`.

**`src/persistence/card-loader.ts`:**
- `loadCardStoreState(projectRoot, options)` — reads filesystem, calls validator, returns `CardStoreState`
- `parseCard()`, `readJsonFile()`, `cardByIdPath()`, `cardHistoryPath()`, `byIdDir()`, `historyDir()`
- `readHistoryEntriesStrict()`
- `parseCard()` strips `blocks` from raw input before schema validation

**`src/cards/validator.ts`:**
- `validateParsedCards({ cards, maxDepth }): { depthById; cardsInDepthOrder }` — validates parsed raw cards before state seeding. Do not validate through `CardStoreState`.
- `validateCardHistoryInvariant()` — extracted as-is

**`src/cards/errors.ts`:**
- `CardStoreInvariantError`
- `ReorderSetMismatchError`

**Denormalized `blocks` field:**
Remove `blocks` from `CardRecord` schema entirely. It is redundant with `_blocksInverse`. Callers that need "which cards block this one" use `store.blocksFor(cardId)` from `CardStore`. Keep `_blocksInverse` cleanup logic. Remove only the denormalized `blocks` writes: `computeBlocksArrayFor`, `refreshBlocksField`, and `{ ...card, blocks: ... }`.

### F30: Generate card IDs inside locked mutations

**Current:** `generateId()` (line 108-118) scans all existing IDs for the highest numeric suffix, then increments. Called before the lock, so concurrent creation can select the same ID.

**Target:** Keep `card-N` format. Move `generateId` call inside `applyMutationLocked` / the locked body of `create()`. Preserve `PROJECT_CARD_ID` special-casing and reserved IDs while sequential IDs exist.

```typescript
// Inside applyMutationLocked (or the locked body of create()):
const nextId = generateId(Array.from(state._cards.keys()));
// generateId now runs inside the lock, eliminating race conditions
```

Do not add `ulid` or any new dependency. The `generateId` function signature stays the same; it just moves into the locked body.

---

## Step-by-Step Implementation

### Step 1: Move ID generation inside the project lock

**Files:** `src/cards/card-store.ts`, `src/cards/state.ts`

Move the `generateId()` call from before `applyMutationSync` into the locked body of `create()`. This eliminates the race condition where concurrent creation could select the same ID.

1. Move the `generateId(existingIds)` call into `applyMutationLocked` (or the locked body of `create()`), after the lock is acquired.
2. Preserve `PROJECT_CARD_ID` special-casing and `__RESERVED_IDS` handling while sequential IDs exist.
3. `CardStoreState` still needs `nextCardId()` (or equivalent) that returns `max(existing numeric IDs) + 1`.

**Test updates:**
- Add test: concurrent `create()` calls produce unique IDs.
- Add test: `PROJECT_CARD_ID` creation still works.
- Add test: reserved IDs are not assigned.

**Verify:** `npm run typecheck && npm test`

### Step 2: Remove refreshState() on all reads, add invalidate()

**Files:** `src/cards/card-store.ts`

All 12 call sites for `refreshState()` must be removed:

**Read methods (7):** `read()`, `list()`, `listChildren()`, `getParent()`, `getAncestors()`, `getDescendantIds()`, `detectCycles()`

**Mutation methods (4):** `create()` (line 329), `appendEvidenceRefs()` (line 409), `reorderChildren()` (line 488), `archiveAndDeleteSubtree()` (line 623)

(The 12th call is likely in `refreshState` itself or a helper.)

1. Remove every `this.refreshState()` call from all 12 sites listed above.
2. Remove the `refreshState()` method entirely.
3. Add `invalidate(): void` that immediately reloads: `this.state = loadCardStoreState(this.projectRoot, { maxDepth: this.maxDepth });` — no stale flag, no conditional. Invalidating unconditionally reloads from disk.
4. Verify each mutation method already calls `this.state.upsert(updatedCard)` after durable writes, so the in-memory model stays current.

**Test updates:**
- Add two-store invalidate test: two `CardStore` instances sharing a project root; store A creates a card; store B reads and gets stale data; store B calls `invalidate()`; store B reads and gets the new card.
- Add two-store stale-before-invalidate test: store B does NOT call `invalidate()` and therefore does NOT see store A's creation.
- Add test: `invalidate()` on a fresh store reloads without error.
- Add test: normal read path performs zero filesystem I/O (verified by mocking `loadCardStoreState` and confirming it is not called during reads).

**Verify:** `npm run typecheck && npm test`. Manual: create card, read card, update card status, read again — must reflect mutation without reload.

### Step 3: Split state.ts into read model, loader, validator, and errors

**Files:** `src/cards/state.ts`, `src/cards/validator.ts` (new), `src/cards/errors.ts` (new), `src/persistence/card-loader.ts` (new), all importers

This is the largest refactoring step. All symbol moves and importer updates happen in one step — no temporary barrel re-exports from `state.ts`.

**`src/cards/errors.ts`:**
- Move `CardStoreInvariantError` and `ReorderSetMismatchError` from `state.ts`
- Both `state.ts` and `validator.ts` import from `./errors.js`

**`src/cards/validator.ts`:**
- Move `validateCardHistoryInvariant()` and `parseHistoryLine()` from `state.ts`
- Add `validateParsedCards({ cards, maxDepth }): { depthById; cardsInDepthOrder }` — validates parsed raw cards before state seeding. Do not validate through `CardStoreState`.
- Import error classes from `./errors.js`

**`src/persistence/card-loader.ts`:**
- Move `loadCardStoreState()`, `readJsonFile()`, `parseCard()`, `byIdDir()`, `historyDir()`, `cardByIdPath()`, `cardHistoryPath()`, `readHistoryEntriesStrict()` from `state.ts`
- Import `validateParsedCards` and `validateCardHistoryInvariant` from `../cards/validator.js`
- Import `CardStoreState` from `../cards/state.js`
- `parseCard()` strips `blocks` from raw input before schema validation

**`src/cards/state.ts`:**
- Retains only `CardStoreState` class: `upsert()`, `remove()`, query methods, adjacency caches
- No filesystem imports. No `loadCardStoreState`.
- Delete `_depthCache` property, `depthOf()` method, and all `_depthCache.clear()` calls in `upsert()`/`remove()`. Do NOT add `invalidateDepths()`.

Update all importers in the same step:
- Every file that imported `loadCardStoreState`, `cardByIdPath`, `cardHistoryPath`, `readHistoryEntriesStrict`, etc. from `state.ts` now imports from `persistence/card-loader.ts`
- Every file that imported `CardStoreInvariantError` or `ReorderSetMismatchError` from `state.ts` now imports from `cards/errors.ts`
- Every file that imported `validateCardHistoryInvariant` from `state.ts` now imports from `cards/validator.ts`
- Remove all barrel re-exports from `state.ts`. After this step, `state.ts` exports only `CardStoreState`.

**Test updates:**
- Update all test imports to use new module paths.
- Add test: `validateParsedCards` rejects invalid cards before `CardStoreState` construction.
- Add test: `CardStoreState` can be instantiated without filesystem imports.

**Note:** `valuesEqual` is also defined in `src/cards/lifecycle.ts:105`. When Wave 1 extracts the shared utility, `lifecycle.ts` must also be updated. That is not this wave's concern.

**Verify:** `npm run typecheck && npm test`

### Step 4: Remove denormalized `blocks` field from CardRecord

**Files:** `src/schemas/types.ts`, `src/schemas/validators.ts`, `src/cards/state.ts`, `src/cards/card-store.ts`, `src/cards/lifecycle.ts`, `src/agents/planner-control-executor.ts`, `src/tools/analyst-card-tools.ts`, `src/runtime/context-builder.ts`, `src/application/read-models/debug-read-model.ts`, and all other callers of `card.blocks`

Remove `blocks` from the persisted `CardRecord` type and schema in one step — no optional transition field.

1. In `src/schemas/types.ts`: remove `blocks` from the `CardRecord` type.
2. In `src/schemas/validators.ts`: remove `blocks` from `cardRecordSchema`.
3. In `src/persistence/card-loader.ts`: `parseCard()` must strip `blocks` from raw input before schema validation. This handles existing card files on disk that still contain `blocks`.
4. **Card history migration:** `CardHistoryEntry.snapshot` uses `cardRecordSchema`. After removing `blocks` from the schema, existing JSONL history files containing `blocks` would fail validation. `parseCard()` must normalize (strip `blocks`) before schema validation. This applies to both card files and history snapshots.
5. In `CardStoreState.upsert()`: remove `refreshBlocksField()` call and the `blocks` assignment in the spread. Remove `refreshBlocksField()` and `computeBlocksArrayFor` methods entirely.
6. In `CardStoreState.remove()`: keep `_blocksInverse` cleanup logic.
7. Add `CardStore.blocksFor(id: string): string[]` public method that delegates to `this.state.blocksFor(id)`.

**Explicit `blocks` caller removal — all of these must be updated:**

Runtime callers:
- `src/cards/lifecycle.ts`: Remove `'blocks'` from `TRACKED_FIELDS`. Remove `blocks` from `buildUpdatedCard` and `buildNewCard`.
- `src/cards/state.ts`: Remove `blocks` from `upsert()` spread and `refreshBlocksField()`. Remove `_blocksInverse` from the `dependents` spread if it references `blocks`.
- `src/agents/planner-control-executor.ts:182`: Remove `blocks: []` from card creation input.
- `src/tools/analyst-card-tools.ts:104`: Remove `blocks: []` from card creation input.
- `src/runtime/context-builder.ts:137`: Remove `blocks` references.
- `src/application/read-models/debug-read-model.ts:24`: Remove `blocks` references.

Web callers:
- `web/src/stores/analystChat.ts:235`: Remove `blocks` references.
- `web/src/stores/debug.ts:86`: Remove `blocks` references.
- `web/src/api/types.ts` (lines 189, 262): Remove `blocks` from web API type definitions.
- `web/src/components/cards/CardDetailView.vue` (lines 72, 75): Remove `blocks` references.

Test fixtures: Remove `blocks` from all mock `CardRecord` fixtures.

**NewCardInput / buildNewCard updates:**
- Remove `blocks: []` from `buildNewCard()`.
- Remove `blocks: []` from `planner-control-executor.ts` create inputs.
- Remove `blocks: []` from `analyst-card-tools.ts` create inputs.
- Remove `'blocks'` from `TRACKED_FIELDS` in `lifecycle.ts`.

**Test updates:**
- Remove `blocks` from all mock `CardRecord` test fixtures.
- Add test: `CardStore.blocksFor(id)` returns correct blockers from `_blocksInverse`.
- Add test: `parseCard()` strips `blocks` from raw input before schema validation.
- Add test: history entry parsing strips `blocks` from snapshots.
- Add test: creating a card with `depends_on` correctly populates `_blocksInverse`; `store.blocksFor()` returns correct blockers.
- Add web check: outbound API responses no longer include `blocks` field (or it is empty/derived).
- Update `web/src/api/types.ts` and `DebugStateResponse` type.

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
   - Verify card IDs are sequential `card-N` format (not ULID) and unique under concurrency
   - Verify no filesystem reads during normal card reads (add a `console.log` to `loadCardStoreState` — it should only be called on construction and after explicit `invalidate()`)
   - Verify `invalidate()` works: modify card file externally, call `invalidate()`, read card — must reflect external change
   - Verify two-store scenario: store A creates a card, store B calls `invalidate()` and reads it correctly