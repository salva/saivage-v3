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
- Mutations should not call `read()` for internal checks after read I/O is removed when direct `this.state` access is enough. This avoids accidental read-path semantics in mutation code and keeps mutation ordering explicit.

### F24: Split state.ts into read model, loader, and validator

**Current `state.ts` (547 lines)** mixes three roles:
1. `CardStoreState` class — in-memory read model + adjacency cache + adjacency mutation (lines 52-277)
2. `readJsonFile`, `parseCard`, `readHistoryEntriesStrict`, `validateCardHistoryInvariant` — filesystem I/O + validation (lines 279-396)
3. `loadCardStoreState` — disk loading + 9 invariant checks + boot (lines 398-547)

**Target structure:**

```
src/cards/
  state.ts          → CardStoreState class only (adjacency read model, upsert, remove, queries)
  validator.ts       → validateParsedCards() + validateCardHistoryInvariant()
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
- `parseCard()` strips `blocks` from raw card files before schema validation
- History parsing strips `blocks` from `snapshot` before history schema validation

**`src/cards/validator.ts`:**
- `validateParsedCards({ cards, maxDepth }): { depthById; cardsInDepthOrder }` — validates parsed raw cards before state seeding. Do not validate through `CardStoreState`.
- `validateCardHistoryInvariant()` — extracted as-is

**`src/cards/errors.ts`:**
- `CardStoreInvariantError`
- `ReorderSetMismatchError`

**Denormalized `blocks` field:**
Remove `blocks` from `CardRecord` schema entirely. It is redundant with `_blocksInverse`. Callers that need "which cards block this one" use `store.blocksFor(cardId)` from `CardStore`. Keep `_blocksInverse` cleanup logic. Remove only the denormalized `blocks` writes: `computeBlocksArrayFor`, `refreshBlocksField`, and `{ ...card, blocks: ... }`.

### F30: Generate card IDs inside locked mutations

**Current:** `generateId()` (line 108-118) scans all existing IDs for the highest numeric suffix, then increments. It is called in `create()` before `applyMutationSync()` acquires the project lock, so concurrent creators can select the same ID and one create fails inside `applyMutationLocked()`.

**Target:** Keep `card-N` format. Move `generateId` into the locked body of `create()`. Preserve `PROJECT_CARD_ID` special-casing and reserved IDs while sequential IDs exist. Reload card state inside the create lock before parent/project/id checks so `card-N` generation sees other processes' committed writes without restoring read-time refresh behavior.

```typescript
this.projectLock.withLockSync((handle) => {
  this.projectLock.assertOwns(handle);
  this.state = loadCardStoreState(this.projectRoot, { maxDepth: this.maxDepth });
  const id = newCardId(input.type, () => generateId(this.state.allKnownIds()));
  // build and validate the card, then persist with applyMutationWithOwnedLockSync(...)
});
```

Do not add `ulid` or any new dependency. The `generateId` function signature stays the same; it just moves into the locked body.

---

## Step-by-Step Implementation

### Step 1: Move ID generation inside the project lock

**Files:** `src/cards/card-store.ts`, `src/cards/state.ts`, `src/cards/apply-mutation.ts`

Move the `generateId()` call from before `applyMutationSync` into the locked body of `create()`. This eliminates the race where concurrent creation selects the same ID and one caller fails after the lock is acquired.

1. Rewrite `create()` to acquire `this.projectLock.withLockSync()` itself and persist with `applyMutationWithOwnedLockSync()` so ID generation, validation, and durable create happen in one lock hold.
2. Inside that lock, reload `this.state = loadCardStoreState(...)` before computing `allKnownIds`, project-card uniqueness, parent existence, parent terminal-state checks, depth, position, and dependency cycle checks. This is a mutation-time concurrency safety reload, not a read-time refresh.
3. Preserve `PROJECT_CARD_ID` special-casing and `__RESERVED_IDS` handling while sequential IDs exist.
4. Keep `generateId(existingIds: string[])` and call it with `this.state.allKnownIds()` inside the lock. Do not add `nextCardId()` unless it replaces `generateId` with equivalent `card-N` semantics.
5. Replace internal `this.read(input.parent)`, `this.read()` for depth, and `this.detectCycles()` calls inside `create()` with direct `this.state.get(...)` and `this.state.detectDependsOnCycle(...)` calls while the lock is held.

**Test updates:**
- Add test: concurrent `create()` calls produce unique IDs.
- Add test: `PROJECT_CARD_ID` creation still works.
- Add test: reserved IDs are not assigned.
- Add two-store create test: store A creates `card-1`; store B, without `invalidate()`, creates `card-2` rather than failing on duplicate `card-1`.

**Verify:** `npm run typecheck && npm test`

### Step 2: Remove refreshState() on all reads, add invalidate()

**Files:** `src/cards/card-store.ts`

All 11 direct call sites for `refreshState()` must be removed:

**Read methods (7):** `read()`, `list()`, `listChildren()`, `getParent()`, `getAncestors()`, `getDescendantIds()`, `detectCycles()`

**Mutation methods (4):** `create()` (line 329), `appendEvidenceRefs()` (line 409), `reorderChildren()` (line 488), `archiveAndDeleteSubtree()` (line 623)

1. Remove every `this.refreshState()` call from the 11 sites listed above.
2. Remove the `refreshState()` method entirely.
3. Add `invalidate(): void` that immediately reloads: `this.state = loadCardStoreState(this.projectRoot, { maxDepth: this.maxDepth });` — no stale flag, no conditional. Invalidating unconditionally reloads from disk.
4. Keep the lock-scoped `loadCardStoreState()` in `create()` from Step 1. Do not reintroduce read-time or general mutation-time refreshes.
5. Verify each mutation method updates in-memory state through `applyMutationSync`, `applyMutationWithOwnedLockSync`, or `applyMutationGroupSync`, which call `state.upsert()`/`state.remove()` after durable writes.

**Test updates:**
- Add two-store invalidate test: two `CardStore` instances sharing a project root; store A creates a card; store B reads and gets stale data; store B calls `invalidate()`; store B reads and gets the new card.
- Add two-store stale-before-invalidate test: store B does NOT call `invalidate()` and therefore does NOT see store A's creation.
- Add test: `invalidate()` on a fresh store reloads without error.
- Add test: normal read path performs zero filesystem I/O. Use a spy/mock around the loader module after the F24 split, or a focused fs spy on `readdirSync`/`readFileSync`; do not add `console.log` instrumentation.

**Verify:** `npm run typecheck && npm test`. Manual: create card, read card, update card status, read again — must reflect mutation without reload.

### Step 3: Split state.ts into read model, loader, validator, and errors

**Files:** `src/cards/state.ts`, `src/cards/validator.ts` (new), `src/cards/errors.ts` (new), `src/persistence/card-loader.ts` (new), all importers

This is the largest refactoring step. All symbol moves and importer updates happen in one step — no temporary barrel re-exports from `state.ts`.

**`src/cards/errors.ts`:**
- Move `CardStoreInvariantError` and `ReorderSetMismatchError` from `state.ts`
- Both `state.ts` and `validator.ts` import from `./errors.js`

**`src/cards/validator.ts`:**
- Move `validateCardHistoryInvariant()` from `state.ts`
- Add `validateParsedCards({ cards, maxDepth }): { depthById; cardsInDepthOrder }` — validates parsed raw cards before state seeding. Do not validate through `CardStoreState`.
- `validateParsedCards()` owns the existing boot invariants now in `loadCardStoreState`: single canonical project card, parent self-reference/missing parent/terminal parent, dependency closure, parent-cycle detection, max depth/stored depth, root position, and contiguous sibling positions.
- Import error classes from `./errors.js`

**`src/persistence/card-loader.ts`:**
- Move `loadCardStoreState()`, `readJsonFile()`, `parseCard()`, `parseHistoryLine()`, `byIdDir()`, `historyDir()`, `cardByIdPath()`, `cardHistoryPath()`, `readHistoryEntriesStrict()` from `state.ts`
- Import `validateParsedCards` and `validateCardHistoryInvariant` from `../cards/validator.js`
- Import `CardStoreState` from `../cards/state.js`
- `parseCard()` strips `blocks` from raw card files before schema validation
- `parseHistoryLine()` or a loader-local history normalizer strips `blocks` from `snapshot` before `cardHistoryEntrySchema` validation

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
4. **Card history migration:** `CardHistoryEntry.snapshot` uses `cardRecordSchema`. After removing `blocks` from the schema, existing JSONL history files containing `blocks` would fail validation. Normalize history rows in `parseHistoryLine()` or a loader-local helper by stripping `snapshot.blocks` before `cardHistoryEntrySchema` validation. `parseCard()` only handles card files.
5. In `CardStoreState.upsert()`: remove `refreshBlocksField()` call and the `blocks` assignment in the spread. Remove `refreshBlocksField()` and `computeBlocksArrayFor` methods entirely.
6. In `CardStoreState.remove()`: keep `_blocksInverse` cleanup logic.
7. Add `CardStore.blocksFor(id: string): string[]` public method that delegates to `this.state.blocksFor(id)`.

**Explicit `blocks` caller removal — all of these must be updated:**

Runtime callers:
- `src/cards/lifecycle.ts`: Remove `'blocks'` from `TRACKED_FIELDS`. Remove `blocks` from `buildUpdatedCard` and `buildNewCard`.
- `src/cards/state.ts`: Remove `blocks` from `upsert()` spread and delete `refreshBlocksField()`/`computeBlocksArrayFor()`. Keep `_blocksInverse`; it remains the source for `blocksFor()`.
- `src/agents/planner-control-executor.ts:182`: Remove `blocks: []` from card creation input.
- `src/tools/analyst-card-tools.ts:104`: Remove `blocks: []` from card creation input.
- `src/runtime/context-builder.ts:137`: Replace `goal.blocks` with `input.cards.blocksFor(goal.id)` if planner context still needs "cards blocked by this goal".
- `src/application/read-models/debug-read-model.ts:24`: Remove `blocks` from debug card summaries, or derive it through `store.blocksFor(c.id)` only if the debug API keeps a derived field.
- `src/cards/card-store.ts`: Add `blocksFor(id: string): string[]` and update imports after the loader/errors split. Ensure `loadCardHistoryEntries()` uses the new loader import path.
- `src/cards/apply-mutation.ts`: Update `cardByIdPath`, `cardHistoryPath`, and `CardStoreInvariantError` imports after the loader/errors split.

Web callers:
- `web/src/stores/analystChat.ts:235`: Remove `card.blocks` seed entries, or replace them only if the API exposes a derived `blocksFor` field under a new name.
- `web/src/stores/debug.ts:86`: Remove `blocks` from the debug card type unless the debug API deliberately keeps derived blockers.
- `web/src/api/types.ts` (lines 189, 262): Remove `blocks` from web API type definitions.
- `web/src/components/cards/CardDetailView.vue` (lines 72, 75): Remove `blocks` references.
- `web/src/__tests__/analyst-chat-store.test.ts`: Remove `blocks` fixture/expectation.

Test fixtures: Remove `blocks` from all mock `CardRecord` fixtures in `tests/**` and `web/src/__tests__/**`. Keep unrelated prose/tests that use the word "blocks" for control-flow blocking.

**NewCardInput / buildNewCard updates:**
- Remove `blocks: []` from `buildNewCard()`.
- Remove `blocks: []` from `planner-control-executor.ts` create inputs.
- Remove `blocks: []` from `analyst-card-tools.ts` create inputs.
- Remove `'blocks'` from `TRACKED_FIELDS` in `lifecycle.ts`.

**Test updates:**
- Remove `blocks` from all mock `CardRecord` test fixtures.
- Add test: `CardStore.blocksFor(id)` returns correct blockers from `_blocksInverse`.
- Add test: `parseCard()` strips `blocks` from raw input before schema validation.
- Add test: `readHistoryEntriesStrict()`/history parsing strips `blocks` from snapshots before schema validation.
- Add test: creating a card with `depends_on` correctly populates `_blocksInverse`; `store.blocksFor()` returns correct blockers.
- Add web check: card/detail/debug responses no longer include persisted `blocks`; if a derived blocker list remains, it is produced from `CardStore.blocksFor()` and typed under the chosen API contract.
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
   - Verify no filesystem reads during normal card reads with a loader/fs spy. `loadCardStoreState` should run on construction, explicit `invalidate()`, and lock-scoped `create()` concurrency reload only
   - Verify `invalidate()` works: modify card file externally, call `invalidate()`, read card — must reflect external change
   - Verify two-store scenario: store A creates a card, store B calls `invalidate()` and reads it correctly
