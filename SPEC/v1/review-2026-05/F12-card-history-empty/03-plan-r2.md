# F12 — Implementation plan (r2)

Chosen design: **Proposal B.1** from [02-design-r2.md](./02-design-r2.md). Companion analysis: [01-analysis-r2.md](./01-analysis-r2.md). Supersedes [03-plan-r1.md](./03-plan-r1.md). Addresses the 10 plan-review items in [01-analysis-review-r1.md](./01-analysis-review-r1.md) and F13 reviewer items #1/#3/#7/#8/#9.

## Coordination with F13 (reviewer plan item #10)

This plan is the single approved workstream for F12 **and** F13. F13's r2 must state that the implementation is subsumed here; F13's plan-r2 should be a one-paragraph pointer back to this file with no independent steps. **No two plans race over [src/cards/card-store.ts](../../../src/cards/card-store.ts).** F19/F20/F23 (which call `cardStore.update`/`setStatus`) must rebase onto this plan once Step 4 lands; their runtime-lifecycle test assertions on `version_seq` need updating because every mutation now bumps it.

## Validation baseline (reviewer plan item #9, F13 reviewer #3)

Per-step commands run from `/home/salva/g/ml/saivage-v3/`. The repo uses Jest, not Vitest, for backend tests. Web tests use the npm `web:*` scripts from [package.json](../../../package.json#L31). Full standard validation per [.github/skills/saivage-development-validation/SKILL.md](../../../../.github/skills/saivage-development-validation/SKILL.md) runs as the final gate.

Targeted Jest baseline that **every step** must keep green (with assertions updated per the new contract):

```
npm run typecheck
npm run test:direct -- \
  tests/utils/card-store.test.ts \
  tests/utils/card-history.test.ts \
  tests/projections/ledger-projections.test.ts \
  tests/persistence/persistence-primitives.test.ts \
  tests/persistence/file-tree.test.ts \
  tests/api/cards-history.test.ts \
  tests/agents/card-history-tools.test.ts \
  tests/server/card-routes-authz-audit.test.ts \
  tests/server/runtime-card-contract-routes.test.ts \
  tests/server/operator-api-contracts.test.ts \
  tests/server/websocket-analyst-safety.test.ts \
  tests/schemas.test.ts
```

Web baseline (run from `web/`):

```
npm run web:test -- \
  src/__tests__/card-history-panel.test.ts \
  src/__tests__/card-history-panel-analyst-filter.test.ts \
  src/__tests__/operator-dashboard-smoke.test.ts
```

Live probe success condition (used in steps 4, 7, and 8): after mutating any card via the operator API, `curl /api/cards/<id>/history` returns `total > 0` and `max(history[].version_seq) === card.version_seq - 1`, and `.saivage/runtime/errors.jsonl` shows no new `Canonical hierarchy invariant failed` line.

## Sequencing rationale (reviewer plan item #1)

The plan eliminates any intermediate state where per-card locks protect mutations that still rewrite shared cache files. Concretely:

- **Step 1** adds the per-card lock directory only.
- **Step 2** adds `applyMutation` but does **not** delete `update`/`mutateCard` yet. It writes the per-card lock; the shared `cards/index.json` / `depends-on.json` / `blocks.json` writes still go through the legacy code path, **but only one mutation method runs per `CardStore` instance** because we serialize at the call site (no caller has been migrated yet).
- **Step 3** rewrites `update`/`mutateCard`/`setStatus`/`updateDependsOn`/`activateGoal` as delegations to `applyMutation`. The shared cache files are now written under the per-card lock — temporarily a wider footprint than ideal, but no two cards' mutations race on those files because step 3 ALSO removes the cache files' reads (they become write-only). This single step is the unsafe-intermediate window.
- **Step 4** migrates external callers to await `applyMutation`.
- **Step 5** removes the shared cache file *reads* from the read path, derives the graph from by-id glob.
- **Step 6** stops *writing* the cache files; deletes schemas and `initProjectTree` entries.
- **Step 7** removes the EventBus indirection (projection, `card_history_record_appended`).
- **Step 8** final cleanup sweep.

Steps 3–6 are intended to land in one merge train; if they cannot, the unsafe window is bounded to "mutations write extra files that nobody reads", which is a leak but not a correctness bug.

## Step 1 — Per-card lock substrate

**Files modified:**
- [src/cards/card-store.ts](../../../src/cards/card-store.ts) — add `cardLockPath(projectRoot, id)` helper next to `historyPath`; add `private cardLock(id: string): ProjectLock` returning `new ProjectLock(cardLockPath(this.projectRoot, id))`.
- [src/persistence/file-tree.ts](../../../src/persistence/file-tree.ts) — add `cards/locks` to `SAIVAGE_DIRS` so `initProjectTree` creates the directory.

**Validation:** `npm run typecheck`; `npm run test:direct -- tests/persistence/file-tree.test.ts`.

**Rollback:** revert both files. No on-disk migration.

## Step 2 — Add `CardStore.applyMutation(id, patch, ctx): Promise<CardRecord>` (reviewer plan item #2)

**Files modified:**
- [src/cards/card-store.ts](../../../src/cards/card-store.ts) — implement the async method per [02-design-r2.md §Write path](./02-design-r2.md#write-path-reviewer-items-3-4-5). Acquire `cardLock(id).withLock(async handle => ...)`. Reuse `validateMutablePatch`, `buildUpdatedCard`, `prunePartialPatch`. Capture pre-append history file byte length via `statSync` (or 0 if absent); on by-id rename failure, `truncateSync` back to that length inside the same critical section, then rethrow. Add a `beforeByIdRename` test hook in `CardStoreTestHooks`. **Do not** remove `update`/`mutateCard`/`setStatus`/`updateDependsOn` yet.

**Validation:**
- `npm run typecheck`.
- `npm run test:direct -- tests/utils/card-store.test.ts tests/utils/card-history.test.ts` — all existing tests must stay green (no caller uses `applyMutation` yet).
- **New test in [tests/utils/card-history.test.ts](../../../tests/utils/card-history.test.ts):** call `applyMutation` directly with a tracked field, assert one history line, bumped `version_seq`, history entry's `version_seq === existing.version_seq`.
- **New test:** inject failure via `beforeByIdRename`, assert history file is truncated to pre-append size and `applyMutation` throws.
- **New test:** two `Promise.all([applyMutation(id, …), applyMutation(id, …)])` calls on the same id resolve serialised, produce two consecutive history lines with `version_seq` 1 and 2.

**Rollback:** delete the new method.

## Step 3 — Delegate `update`/`mutateCard`/`setStatus`/`updateDependsOn`/`activateGoal` to `applyMutation`

**Files modified:**
- [src/cards/card-store.ts](../../../src/cards/card-store.ts) — rewrite the five methods as `async` thin wrappers that call `applyMutation`. Their signatures become `Promise<CardRecord>`. **All callers in this same file** (internal usages, e.g. `archiveAndDeleteSubtree` and `delete` if they call `setStatus`) are awaited.
- Stop reading `cards/index.json` / `depends-on.json` / `blocks.json` from `read()` and from `validatePersistedState()`. Build the in-memory graph from `by-id/*.json` glob. The `read()` method ([src/cards/card-store.ts#L758-L764](../../../src/cards/card-store.ts#L758-L764)) no longer overlays `card.blocks` from `blocks.json`; instead `applyMutation` computes blocks from the in-memory graph and stores them on the card record before write (reviewer plan item #6).
- Delete the canonical-mismatch branch in `HierarchyGraph.build` ([src/cards/card-store.ts#L77-L89](../../../src/cards/card-store.ts#L77-L89)). The static method signature drops its `index` parameter.

**Validation:**
- `npm run typecheck`.
- Full Jest baseline (see top of file). Expect failures in tests that asserted "version_seq stays at 1 after `setStatus`" or "history is empty after `update`" — update assertions to the new contract; do NOT add compatibility branches.
- Delete the case at [tests/utils/card-history.test.ts#L43](../../../tests/utils/card-history.test.ts#L43) ("update without tracked fields does not append history") — semantics are intentionally reversed.

**Rollback:** revert. The new `applyMutation` from step 2 stays.

## Step 4 — Migrate external mutation call sites; convert callers to async (reviewer plan items #2, #3, #4)

**Files modified:**
- [src/runtime/runtime.ts](../../../src/runtime/runtime.ts) — every `cardStore.update(...)`, `cardStore.setStatus(...)`, `cardStore.mutateCard(...)` call site is awaited (lines 266, 278, 483, 635, 644, 645, 663, 725, 737, 740, 779, 780). Surrounding methods become `async`. Trace upward and convert all transitive callers.
- [src/tools/planner-tools.ts](../../../src/tools/planner-tools.ts) — same migration at lines 163, 178, 209, 220, 221, 286, 295, 298, 307.
- [src/cards/artifacts.ts](../../../src/cards/artifacts.ts) — same at lines 113, 188, 280, 326. Extend `registerArtifact`/`registerAttachment` signatures to require a `CardMutationContext`; do NOT default.
- [src/agents/analyst-stage6.ts](../../../src/agents/analyst-stage6.ts) — lines 132–188 (and the five `new CardStore` sites). Convert to `applyMutation`; await.
- [src/agents/analyst-tools.ts](../../../src/agents/analyst-tools.ts) — lines 121–144. Delete the local `TRACKED_EDIT_FIELDS` constant ([:120-121](../../../src/agents/analyst-tools.ts#L120-L121)) and its tracked/untracked branch. Convert to `applyMutation`.
- [src/agents/analyst-handler.ts](../../../src/agents/analyst-handler.ts) — line 444.
- [src/agents/agent-adapter.ts](../../../src/agents/agent-adapter.ts) — lines 184, 385.
- [src/server/routes/operator-contracts.ts](../../../src/server/routes/operator-contracts.ts) — line 155: replace the `tracked ? mutateCard : update` branch with a single `await applyMutation`. Delete `TRACKED_UPDATE_FIELDS` ([:15](../../../src/server/routes/operator-contracts.ts#L15)).
- [src/server/routes/cards.ts](../../../src/server/routes/cards.ts) — the delegating shell. **Decision (reviewer plan item #4):** delete the historical source-anchor padding/comment block; the file remains as a thin re-export shell or is folded into `operator-contracts.ts` if straightforward. If non-trivial, leave the file's body unchanged but remove the padding comments. Either way, no `update`/`mutateCard` calls remain.
- Tests: `tests/server/runtime-card-contract-routes.test.ts`, `tests/server/operator-api-contracts.test.ts`, `tests/server/card-routes-authz-audit.test.ts`, `tests/api/cards-history.test.ts`, `tests/agents/card-history-tools.test.ts` — update to `await` and to the new contract (every mutation appends history).

**Validation:**
- `npm run typecheck`.
- Full Jest baseline.
- `npm run web:test -- src/__tests__/card-history-panel.test.ts src/__tests__/card-history-panel-analyst-filter.test.ts src/__tests__/operator-dashboard-smoke.test.ts`.
- Live probe per top-of-file success condition.

**Rollback:** revert per file. Steps 1–3 stay.

## Step 5 — Make `cards/index.json` / `depends-on.json` / `blocks.json` write-only (no reader uses them)

**Files modified:**
- [src/cards/card-store.ts](../../../src/cards/card-store.ts) — confirm no remaining production reader. `validatePersistedState` and all read methods derive from by-id glob only.

**Validation:** full Jest baseline + live probe; check `errors.jsonl` shows zero `Canonical hierarchy invariant failed` entries under load (F13 regression check).

**Rollback:** revert the read-path changes.

## Step 6 — Delete the shared cache files, schemas, and init code (reviewer plan items #5, #6)

**Files modified:**
- [src/cards/card-store.ts](../../../src/cards/card-store.ts) — delete `addToIndex`, `removeFromIndex`, `loadIndex`, `saveIndex`, `loadDependsOn`, `saveDependsOn`, `loadBlocks`, `saveBlocks`, `recomputeBlocks`, `indexPath`, `dependsOnPath`, `blocksPath`. Delete `parseChildrenIndex` ([src/cards/card-store.ts#L384-L388](../../../src/cards/card-store.ts#L384-L388)) if unused after the cache deletion.
- [src/schemas/validators.ts](../../../src/schemas/validators.ts) — delete `cardIndexSchema`, `cardChildrenIndexSchema`, `cardDependencyIndexSchema`, `cardBlocksIndexSchema` ([:27-30](../../../src/schemas/validators.ts#L27-L30)).
- [src/schemas/types.ts](../../../src/schemas/types.ts) — delete the corresponding type exports ([:58-62](../../../src/schemas/types.ts#L58-L62)).
- [src/schemas/index.ts](../../../src/schemas/index.ts) — delete re-exports ([:33-37](../../../src/schemas/index.ts#L33-L37)).
- [tests/schemas.test.ts](../../../tests/schemas.test.ts) — delete or rewrite the cases for the four deleted schemas.
- [src/persistence/file-tree.ts](../../../src/persistence/file-tree.ts) — delete `defaultCardIndexEntry`, `defaultDependsOnIndex`, `defaultBlocksIndex` ([:70-149](../../../src/persistence/file-tree.ts#L70-L149)); `initProjectTree` no longer writes `cards/index.json`, `cards/dependencies/depends-on.json`, `cards/dependencies/blocks.json`. `isNewSaivageState` ([:115-118](../../../src/persistence/file-tree.ts#L115-L118)) loses its `cards/index.json` check.
- [tests/persistence/file-tree.test.ts](../../../tests/persistence/file-tree.test.ts) — update assertions: a freshly seeded project has by-id and history but no index/deps/blocks files.

**Old projects on disk** retain the now-orphan files. Per project guideline, no migration is added. Operators run `saivage reset` if it matters.

**Validation:** full Jest baseline; on a freshly initialised project root, `ls .saivage/cards/` shows only `by-id/`, `history/`, `locks/`.

**Rollback:** revert all five files.

## Step 7 — Remove the `CardHistoryProjection` indirection; move public emit to runtime (reviewer design item #9, plan item #7)

**Files modified:**
- [src/cards/card-store.ts](../../../src/cards/card-store.ts) — delete `appendHistoryEntry` ([:543-552](../../../src/cards/card-store.ts#L543-L552)), `reconcileCardHistory` ([:554-568](../../../src/cards/card-store.ts#L554-L568)), `writeHistoryEntries` ([:535-542](../../../src/cards/card-store.ts#L535-L542)), the `eventBus` constructor parameter and field ([:328-341](../../../src/cards/card-store.ts#L328-L341)), the `registerCardHistoryProjection` import, the `card_history_appended` emit at L876, `CardStoreTestHooks.beforeTrackedCardRename` ([:51-53](../../../src/cards/card-store.ts#L51-L53)) (the new `beforeByIdRename` hook from step 2 replaces it).
- [src/cards/card-store.ts](../../../src/cards/card-store.ts) — add the startup invariant check in `validatePersistedState`: for each by-id record, load the last history line; if `last.version_seq >= card.version_seq` or parsing fails, throw `CardStoreInvariantError` with the card id, orphan version_seq, and `saivage reset` recovery instruction.
- [src/projections/ledger-projections.ts](../../../src/projections/ledger-projections.ts) — delete `CardHistoryProjection` class ([:107-122](../../../src/projections/ledger-projections.ts#L107-L122)), `registerCardHistoryProjection` ([:166-168](../../../src/projections/ledger-projections.ts#L166-L168)), `cardHistoryLedger` ([:52-54](../../../src/projections/ledger-projections.ts#L52-L54)). Update `registerLedgerProjections` ([:179-185](../../../src/projections/ledger-projections.ts#L179-L185)) to no longer call them.
- [src/projections/index.ts](../../../src/projections/index.ts) — drop the deleted exports.
- [src/events/registry.ts](../../../src/events/registry.ts#L65) — delete the `card_history_record_appended` event kind. The public `card_history_appended` kind ([:58](../../../src/events/registry.ts#L58)) stays.
- [src/runtime/runtime.ts](../../../src/runtime/runtime.ts) — at line 108, drop the `this.eventBus` argument from `new CardStore(...)`. Add a thin wrapper that calls `await cardStore.applyMutation(...)` and then emits `card_history_appended` on the runtime bus using the returned card and the diffed fields. The same emit pattern is duplicated at the operator route in [src/server/routes/operator-contracts.ts#L155](../../../src/server/routes/operator-contracts.ts#L155) for HTTP-driven mutations (so websocket subscribers see the event).
- [src/contracts/operator-api.ts](../../../src/contracts/operator-api.ts#L99), [src/contracts/index.ts](../../../src/contracts/index.ts#L22) — delete `CardStoreHealthSchema` and exports per F13 reviewer #6.
- [src/server/websocket.ts](../../../src/server/websocket.ts#L95) — delete the `cardStoreHealth` payload field from status snapshots.
- [src/server/routes/operator-contracts.ts](../../../src/server/routes/operator-contracts.ts#L88) — delete the hard-coded `{ canonical: 'ok' }`.
- Tests: delete `tests/projections/ledger-projections.test.ts:125` (the `card_history_record_appended` case); delete [tests/utils/card-history.test.ts#L66-L117](../../../tests/utils/card-history.test.ts#L66-L117) orphan-recovery cases; add one new case asserting that a hand-injected orphan tail causes `new CardStore(projectRoot)` to throw `CardStoreInvariantError`. Update `tests/server/websocket-analyst-safety.test.ts` to assert that `card_history_appended` is emitted by the runtime/route wrapper after `applyMutation`, not by the card store. Remove or rewrite any test that asserts on `cardStoreHealth` shape.

**Validation:** full Jest baseline + web baseline; restart `saivage-v3` harness; tail `.saivage/runtime/errors.jsonl` for one minute under load; assert no `subscriber_error` events.

**Rollback:** revert all listed files together; step 7 is internally coupled.

## Step 8 — Final sweep

**Files modified:**
- Mechanical greps must all return empty (reviewer plan item #5):

```
grep -rn 'card_history_record_appended\|CardHistoryProjection\|cardHistoryLedger\|reconcileCardHistory\|appendHistoryEntry\|writeHistoryEntries\|TRACKED_FIELDS\|TRACKED_UPDATE_FIELDS\|TRACKED_EDIT_FIELDS\|cardIndexSchema\|cardChildrenIndexSchema\|cardDependencyIndexSchema\|cardBlocksIndexSchema\|defaultCardIndexEntry\|defaultDependsOnIndex\|defaultBlocksIndex\|CardStoreHealthSchema\|cardStoreHealth\|beforeTrackedCardRename' src tests web/src
```

- Remove any `setStatus`/`updateDependsOn` definitions that became unreachable. Update [docs/](../../../docs/) only where it documents the deleted API or on-disk shape — per project guideline, do NOT preserve the old shape in docs.

**Validation:**
- All commands at the top of this file.
- Full skill-driven validation per [.github/skills/saivage-development-validation/SKILL.md](../../../../.github/skills/saivage-development-validation/SKILL.md): build, restart `saivage-v3` container, mutate a card via the dashboard, verify the history tab populates within one click, verify `/api/cards/<id>/diff?from=1&to=<current>` returns a real diff body, verify `errors.jsonl` has no new `Canonical hierarchy invariant failed` entries during a 5-minute soak.

**Rollback:** none required; this step contains only deletions of unreachable code.

## Consolidated dead-code removal list

(For an implementer checking off deletions.)

- `appendHistoryEntry`, `reconcileCardHistory`, `writeHistoryEntries`, `parseChildrenIndex` methods on `CardStore`.
- `update`, `mutateCard`, `setStatus`, `updateDependsOn`, `activateGoal` collapsed into `applyMutation`.
- `TRACKED_FIELDS`, `TRACKED_UPDATE_FIELDS`, `TRACKED_EDIT_FIELDS` constants.
- `eventBus` constructor parameter on `CardStore`.
- `CardStoreTestHooks.beforeTrackedCardRename` → replaced by `beforeByIdRename`.
- `addToIndex`, `removeFromIndex`, `loadIndex`, `saveIndex`, `loadDependsOn`, `saveDependsOn`, `loadBlocks`, `saveBlocks`, `recomputeBlocks`, `indexPath`, `dependsOnPath`, `blocksPath` on `CardStore`.
- `cards/index.json`, `cards/dependencies/depends-on.json`, `cards/dependencies/blocks.json` from on-disk layout and `initProjectTree`.
- `cardIndexSchema`, `cardChildrenIndexSchema`, `cardDependencyIndexSchema`, `cardBlocksIndexSchema` from `src/schemas/`.
- `CardHistoryProjection`, `registerCardHistoryProjection`, `cardHistoryLedger` from `src/projections/ledger-projections.ts`.
- `card_history_record_appended` event kind.
- `defaultCardIndexEntry`, `defaultDependsOnIndex`, `defaultBlocksIndex` from `src/persistence/file-tree.ts`.
- `CardStoreHealthSchema` and exports; websocket `cardStoreHealth` payload; hard-coded `{ canonical: 'ok' }`.
- Canonical-mismatch branch in `HierarchyGraph.build`.
- Orphan-recovery cases in `tests/utils/card-history.test.ts:66-117`; "update without tracked fields" case at L43.
- `card_history_record_appended` case in `tests/projections/ledger-projections.test.ts:125`.

No migration helper, no compatibility shim, no "deprecated but still works" defaults.

## Transversality summary

- **Subsystems touched:** `src/cards/`, `src/projections/`, `src/events/`, `src/runtime/`, `src/tools/`, `src/server/routes/`, `src/server/websocket.ts`, `src/persistence/`, `src/schemas/`, `src/contracts/`, `src/agents/` (stage6, tools, handler, adapter).
- **Files modified or deleted:** ~20 source files plus their tests, plus three web tests.
- **Subsystems NOT touched:** `src/mcp/`, `src/observability/`, `src/permissions/`, `src/telegram/`, `src/notifications/` (except where they already consume `card_history_appended`).
- **F13 deliverables included here:** deletion of `cards/index.json` + deps/blocks; deletion of canonical-mismatch branch; deletion of `CardStoreHealthSchema`. F13 r2 is a one-paragraph pointer to this plan.
