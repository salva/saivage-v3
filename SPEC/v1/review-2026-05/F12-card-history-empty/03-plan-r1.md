# F12 — Implementation plan (r1)

Chosen design: **Proposal B.1** in [02-design-r1.md](./02-design-r1.md). Companion analysis: [01-analysis-r1.md](./01-analysis-r1.md).

Standard validation surface lives in [.github/skills/saivage-development-validation/SKILL.md](../../../../../.github/skills/saivage-development-validation/SKILL.md). Each step lists the explicit validation commands it requires.

## Sequencing rationale

F12 and F13 share the same root cause (non-atomic multi-file card mutation). Proposal B.1 fixes both. The plan therefore sequences F13 and F12 as a single workstream. The order below avoids any in-tree state where the writer and the reader disagree on whether `index.json` is authoritative.

Each step is a single PR-sized change. Steps 1-3 are the new substrate; steps 4-6 migrate all call sites; steps 7-8 delete the obsolete files and assertions. Do not skip step 8.

## Step 1 — Introduce per-card advisory lock

**Files modified:**
- [src/cards/card-store.ts](../../../src/cards/card-store.ts) — add `cardLockPath(projectRoot, id)` helper next to `historyPath`; add `cardLock(id): ProjectLock` private method.
- No new file; `ProjectLock` from [src/persistence/project-lock.ts](../../../src/persistence/project-lock.ts) is reused as-is.
- [src/persistence/file-tree.ts](../../../src/persistence/file-tree.ts) — add `cards/locks` to `SAIVAGE_DIRS` so `initProjectTree` creates the directory.

**Validation:**
- `npx tsc --noEmit` from `saivage-v3/`.
- `npm run test -- tests/persistence/file-tree.test.ts` to confirm the new dir is created.

**Rollback:** revert the two files. No on-disk migration required (the new lock dir is empty until step 3 lands).

**Transversality:** 2 files, 1 subsystem (persistence).

## Step 2 — Add `CardStore.applyMutation` alongside existing `update`/`mutateCard`

**Files modified:**
- [src/cards/card-store.ts](../../../src/cards/card-store.ts) — implement `applyMutation(id, patch, ctx): CardRecord` per [02-design-r1.md §Proposal B / Write path](./02-design-r1.md). Reuse `validateMutablePatch`, `buildUpdatedCard`, `prunePartialPatch`. Acquire `cardLock(id).withLock(async handle => {...})`. Use the lock handle to gate (a) JSONL append with `O_APPEND|O_CREAT|fsync`, (b) by-id tmp+rename, (c) index/depends/blocks refresh, (d) graph rebuild. Capture pre-append JSONL byte length and truncate on step-7 failure inside the same critical section.
- Leave `update`, `mutateCard`, `setStatus`, `updateDependsOn`, `activateGoal` untouched in this step. They remain callable.

**Validation:**
- `npx tsc --noEmit`.
- `npm run test -- tests/utils/card-store.test.ts tests/utils/card-history.test.ts` — existing tests must stay green (no caller uses the new method yet).
- New test in `tests/utils/card-history.test.ts`: call `applyMutation` directly; assert the new history line, the bumped `version_seq`, the rolled-back JSONL on injected rename failure.

**Rollback:** delete the new method.

**Transversality:** 1 file.

## Step 3 — Migrate `CardStore`-internal callers (`update`, `setStatus`, `updateDependsOn`, `mutateCard`) to delegate to `applyMutation`

**Files modified:**
- [src/cards/card-store.ts](../../../src/cards/card-store.ts) — rewrite `update`, `mutateCard`, `setStatus`, `updateDependsOn`, `activateGoal` as thin wrappers that call `applyMutation`. They now ALL produce a history line. `TRACKED_FIELDS` is no longer used to gate history; delete its uses but leave the constant for step 7.

**Validation:**
- `npx tsc --noEmit`.
- `npm run test -- tests/utils/` — most card-history and card-store tests will need updating because previously-untracked edits (`setStatus`, `update`) now bump `version_seq` and append history. Update assertions to reflect the new contract; do NOT add compatibility branches.
- `npm run test -- tests/projections/ledger-projections.test.ts` — the `card_history_record_appended` case at [tests/projections/ledger-projections.test.ts:125](../../../tests/projections/ledger-projections.test.ts#L125) still passes (projection still exists and still works), but is now exercised by no production code path.

**Rollback:** revert the wrapper rewrites; the new `applyMutation` from step 2 stays.

**Transversality:** 1 file, broad test churn.

## Step 4 — Migrate external call sites to `applyMutation`

**Files modified:**
- [src/runtime/runtime.ts](../../../src/runtime/runtime.ts) — replace `cardStore.update(...)`, `cardStore.setStatus(...)`, `cardStore.mutateCard(...)` at lines 266, 278, 483, 635, 644, 645, 663, 725, 737, 740, 779, 780 with `cardStore.applyMutation(id, patch, ctx)`. Choose `ctx.actor` and `ctx.surface` per call site (`'runtime'` / `'runtime'` for runtime-internal; planner-driven sites use `'planner'` / `'runtime'`).
- [src/tools/planner-tools.ts](../../../src/tools/planner-tools.ts) — same at lines 163, 178, 209, 220, 221, 286, 295, 298, 307. `ctx.actor` is `'planner'`, `ctx.surface` is `'runtime'`.
- [src/cards/artifacts.ts](../../../src/cards/artifacts.ts) — same at lines 113, 188, 280, 326. `ctx.actor` is whatever the caller of `registerArtifact`/`registerAttachment` already passes through (extend signatures if needed; do NOT default).
- [src/server/routes/operator-contracts.ts](../../../src/server/routes/operator-contracts.ts) — at line 155 the `tracked ? mutateCard : update` branch collapses to one `applyMutation` call. Remove `TRACKED_UPDATE_FIELDS` ([:15](../../../src/server/routes/operator-contracts.ts#L15)) and its uses.

**Validation:**
- `npx tsc --noEmit`.
- `npm run test` — full suite. Expect failures in tests that assert "version_seq stays at 1 after `setStatus`" or "history is empty after `update`"; update them per the new contract.
- Live probe on `saivage-v3` build per [.github/skills/saivage-development-validation/SKILL.md](../../../../../.github/skills/saivage-development-validation/SKILL.md): boot the harness, mutate a card via the operator API, `curl /api/cards/<id>/history`, expect a non-empty response.

**Rollback:** revert per file. No on-disk migration; rollback is safe because step 3 made `update`/`setStatus` semantically equivalent to `applyMutation`.

**Transversality:** 4 files, 3 subsystems (runtime, tools, cards, server-routes).

## Step 5 — Make `cards/index.json`, `depends-on.json`, `blocks.json` non-authoritative caches

**Files modified:**
- [src/cards/card-store.ts](../../../src/cards/card-store.ts) — `validatePersistedState` builds the in-memory graph from `by-id/*.json` directly (glob the directory). The `index.json` / `depends-on.json` / `blocks.json` are still written but never read for correctness. `HierarchyGraph.build` takes only `cards: CardRecord[]` and computes parent/child from `card.parent` alone. The "matches `cards/index.json` entry" branch in `HierarchyGraph.build` ([src/cards/card-store.ts:77-89](../../../src/cards/card-store.ts#L77-L89)) is deleted (F13 fix lands here).

**Validation:**
- `npx tsc --noEmit`.
- `npm run test`.
- Live probe: run two concurrent `applyMutation`s via the API on different cards; assert no "Canonical hierarchy invariant failed" error in `.saivage/runtime/errors.jsonl` (F13 regression check).

**Rollback:** revert. The cache files were still being written; reads from them just resume.

**Transversality:** 1 file. Closes [F13](../F13-canonical-index-drift/00-issue.md).

## Step 6 — Stop writing the cache files; remove their schemas

**Files modified:**
- [src/cards/card-store.ts](../../../src/cards/card-store.ts) — delete `addToIndex`, `removeFromIndex`, `loadIndex`, `saveIndex`, `loadDependsOn`, `saveDependsOn`, `loadBlocks`, `saveBlocks`, `recomputeBlocks`, `indexPath`, `dependsOnPath`, `blocksPath`, and all callers (now no-ops).
- [src/schemas/](../../../src/schemas/) — delete `cardIndexSchema`, `cardChildrenIndexSchema`, `cardDependencyIndexSchema`, `cardBlocksIndexSchema` and their exports. Search for any external usage (`grep -r 'cardIndexSchema\|cardChildrenIndexSchema\|cardDependencyIndexSchema\|cardBlocksIndexSchema' src tests`); update or delete.
- [src/persistence/file-tree.ts](../../../src/persistence/file-tree.ts) — `defaultCardIndexEntry`, `defaultDependsOnIndex`, `defaultBlocksIndex` deleted; `initProjectTree` no longer writes `cards/index.json`, `cards/dependencies/depends-on.json`, `cards/dependencies/blocks.json`. The `isNewSaivageState` predicate ([src/persistence/file-tree.ts:115-118](../../../src/persistence/file-tree.ts#L115-L118)) loses its `cards/index.json` check.
- Old projects on disk will still have `cards/index.json` and the dependency files; per project guideline, do NOT add migration. Documented expectation: operators run `saivage reset` if the layout matters.

**Validation:**
- `npx tsc --noEmit`.
- `npm run test`.
- On a freshly initialised project root (`saivage init` flow), assert the file tree contains by-id and history but NOT `index.json`.

**Rollback:** revert all three files.

**Transversality:** 3 files, 2 subsystems (cards, persistence). Schema deletions ripple through `src/schemas/`.

## Step 7 — Remove the `CardHistoryProjection` indirection and the EventBus parameter on `CardStore`

**Files modified:**
- [src/cards/card-store.ts](../../../src/cards/card-store.ts) — delete `appendHistoryEntry` ([:543-552](../../../src/cards/card-store.ts#L543-L552)), `reconcileCardHistory` ([:537-550](../../../src/cards/card-store.ts#L537-L550)), the `eventBus` constructor parameter and field, the `registerCardHistoryProjection` import, the `card_history_appended` emit at [:876](../../../src/cards/card-store.ts#L876). Delete `CardStoreTestHooks.beforeTrackedCardRename` and replace its sole usage in tests with `beforeByIdRename` on `applyMutation`.
- [src/projections/ledger-projections.ts](../../../src/projections/ledger-projections.ts) — delete `CardHistoryProjection` class ([:107-122](../../../src/projections/ledger-projections.ts#L107-L122)), `registerCardHistoryProjection` ([:166-168](../../../src/projections/ledger-projections.ts#L166-L168)), `cardHistoryLedger` helper ([:52-54](../../../src/projections/ledger-projections.ts#L52-L54)). Update `registerLedgerProjections` ([:179-185](../../../src/projections/ledger-projections.ts#L179-L185)) to no longer call it. Delete its export from [src/projections/index.ts](../../../src/projections/index.ts).
- [src/events/registry.ts:65](../../../src/events/registry.ts#L65) — delete the `card_history_record_appended` event kind.
- [src/runtime/runtime.ts:108](../../../src/runtime/runtime.ts#L108) — drop the `this.eventBus` argument from `new CardStore(...)`. The runtime that needs to broadcast `card_history_appended` for websocket consumers gains a tiny wrapper around `cardStore.applyMutation` that calls the original method and then emits on its own bus. The wrapper lives in [src/runtime/runtime.ts](../../../src/runtime/runtime.ts) (NOT in cards/), so cards remains pure of event-bus concerns.
- [tests/projections/ledger-projections.test.ts:125](../../../tests/projections/ledger-projections.test.ts#L125) — delete the `card_history_record_appended` test case and any imports of the deleted class.
- [tests/utils/card-history.test.ts:66-117](../../../tests/utils/card-history.test.ts#L66-L117) — delete the two orphan-recovery cases; replace with one case asserting that a hand-injected orphan tail causes `validatePersistedState` to throw on the next `new CardStore`.

**Validation:**
- `npx tsc --noEmit`.
- `npm run test`.
- Live probe: restart `saivage-v3` harness; tail `.saivage/runtime/errors.jsonl` for one minute under load; assert no `subscriber_error` events sourced from `card_history_record_appended`.

**Rollback:** revert. Step 6 is independent.

**Transversality:** 6 files, 3 subsystems (cards, projections, events, runtime).

## Step 8 — Final cleanup pass

**Files modified:**
- Search-and-delete any remaining `TRACKED_FIELDS`, `TRACKED_UPDATE_FIELDS` references.
- Search-and-delete any `setStatus`, `updateDependsOn` definitions or call sites that became unreachable.
- Verify zero references to deleted symbols: `grep -rn 'card_history_record_appended\|CardHistoryProjection\|cardHistoryLedger\|reconcileCardHistory\|appendHistoryEntry\|TRACKED_FIELDS\|TRACKED_UPDATE_FIELDS' src tests` must return empty.
- Update [docs/](../../../docs/) Card-system documentation to reflect the single-entry-point API and the deletion of `cards/index.json`. Per project guideline, do NOT document the old shape.

**Validation:**
- `npx tsc --noEmit`.
- `npm run test`.
- Full validation per [.github/skills/saivage-development-validation/SKILL.md](../../../../../.github/skills/saivage-development-validation/SKILL.md): build, restart `saivage-v3` container, mutate a card via the dashboard, verify the history tab populates within one click, verify `/api/cards/<id>/diff?from=1&to=<current>` returns a real diff body.

**Rollback:** none required; this step contains only deletions of unreachable code.

**Transversality:** sweeping across `src/`, `tests/`, `docs/`.

## Estimated transversality across the whole workstream

- **Subsystems touched:** `src/cards/`, `src/projections/`, `src/events/`, `src/runtime/`, `src/tools/`, `src/server/routes/`, `src/persistence/`, `src/schemas/`.
- **Files modified or deleted:** approximately 14-18 source files plus their tests.
- **Subsystems NOT touched:** `src/agents/`, `src/mcp/`, `src/observability/`, `src/permissions/`, `web/`. The agent adapter, planner control executor, and analyst tools see no API change (their `new CardStore(projectRoot)` constructor calls just stop accepting an event bus, which they were not passing).

## Consolidated dead-code removal list

For an implementer checking off deletions:

- `appendHistoryEntry` method ([src/cards/card-store.ts:543-552](../../../src/cards/card-store.ts#L543-L552))
- `reconcileCardHistory` method ([src/cards/card-store.ts:537-550](../../../src/cards/card-store.ts#L537-L550))
- `update`, `mutateCard`, `setStatus`, `updateDependsOn`, `activateGoal` methods on `CardStore` collapsed into `applyMutation` (steps 3+8)
- `TRACKED_FIELDS` constant ([src/cards/card-store.ts:204-222](../../../src/cards/card-store.ts#L204-L222))
- `TRACKED_UPDATE_FIELDS` constant ([src/server/routes/operator-contracts.ts:15](../../../src/server/routes/operator-contracts.ts#L15))
- `eventBus` constructor parameter on `CardStore` ([src/cards/card-store.ts:328-341](../../../src/cards/card-store.ts#L328-L341))
- `CardStoreTestHooks.beforeTrackedCardRename` ([src/cards/card-store.ts:51-53](../../../src/cards/card-store.ts#L51-L53))
- `addToIndex`, `removeFromIndex`, `loadIndex`, `saveIndex`, `loadDependsOn`, `saveDependsOn`, `loadBlocks`, `saveBlocks`, `recomputeBlocks`, `indexPath`, `dependsOnPath`, `blocksPath`
- `cards/index.json`, `cards/dependencies/depends-on.json`, `cards/dependencies/blocks.json` from the on-disk layout (and from `initProjectTree`)
- `cardIndexSchema`, `cardChildrenIndexSchema`, `cardDependencyIndexSchema`, `cardBlocksIndexSchema` from `src/schemas/`
- `CardHistoryProjection`, `registerCardHistoryProjection`, `cardHistoryLedger` from [src/projections/ledger-projections.ts](../../../src/projections/ledger-projections.ts)
- `card_history_record_appended` event kind from [src/events/registry.ts:65](../../../src/events/registry.ts#L65)
- `defaultCardIndexEntry`, `defaultDependsOnIndex`, `defaultBlocksIndex` from [src/persistence/file-tree.ts](../../../src/persistence/file-tree.ts)
- Orphan-recovery cases from [tests/utils/card-history.test.ts:66-117](../../../tests/utils/card-history.test.ts#L66-L117)
- `card_history_record_appended` case from [tests/projections/ledger-projections.test.ts:125](../../../tests/projections/ledger-projections.test.ts#L125)

No migration helper, no compatibility shim, no "deprecated but still works" defaults.
