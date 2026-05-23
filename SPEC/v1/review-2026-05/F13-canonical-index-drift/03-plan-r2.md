# F13 — Implementation Plan (r2) — Proposal C

Chosen design: by-id authoritative + derived projections + per-card history ledger (see [02-design-r2.md](02-design-r2.md) §Proposal C). F12 lands inside this work; F19/F20/F23 coordinate as documented in §Coordination.

## Baseline validation commands (per this repo)

This repo runs **Jest**, not Vitest, for root tests (see [package.json](../../../package.json#L14-L16)). Web tests use Vitest under `web/`. Use these:

```
cd /home/salva/g/ml/saivage-v3
npm run typecheck
npm run test:direct -- tests/utils/card-store.test.ts tests/utils/card-history.test.ts tests/utils/card-store-startup-refusal.test.ts tests/utils/file-tree.test.ts tests/projections/ledger-projections.test.ts tests/persistence/persistence-primitives.test.ts tests/api/cards-history.test.ts tests/agents/card-history-tools.test.ts tests/server/card-routes-authz-audit.test.ts tests/server/runtime-card-contract-routes.test.ts tests/server/operator-api-contracts.test.ts tests/server/operator-api-contract-fixtures.test.ts tests/server/websocket-analyst-safety.test.ts tests/server/server-availability-contract.test.ts tests/runtime/runtime-activation-ledger.test.ts tests/runtime/runtime-command-ledger.test.ts tests/schemas.test.ts
```

Web build/test, if the contract or dashboard schema changes:

```
npm run web:typecheck
npm run web:test:control-room
npm run web:test:store:cards
npm run web:test:analyst-ui
```

There is no `tests/cards/` directory (verified by `list_dir`); the r1 plan referenced a non-existent path. Card-store tests live under `tests/utils/`, `tests/api/`, `tests/server/`, `tests/projections/`, `tests/persistence/`. **Do not** use `npx vitest run tests/cards`.

## Step 1 — Extract derived-projection writer

- New file `src/cards/projections-writer.ts`:
  - `writeAllDerivedProjections(projectRoot, state)` — writes `cards/index.json`, `cards/dependencies/depends-on.json`, `cards/dependencies/blocks.json`, and every `cards/tree/<id>.children.json` from in-memory `CardStoreState`. Stable key ordering, no timestamps, byte-identical for the same input state.
  - `writeDerivedProjectionsForCards(projectRoot, state, touchedIds)` — same, restricted to touched cards plus the always-shared index/deps/blocks (always rewritten as a single trio).
- No removal yet; old write paths in `card-store.ts` continue to function in parallel.
- Validation: `npm run typecheck`; new test `tests/utils/projections-writer.test.ts` covering full vs. incremental, idempotence, bytewise equivalence of two successive full rebuilds, stable key order under reshuffled `Map` iteration.
- Rollback: delete the new file and the new test.

## Step 2 — Extract in-memory state container

- New file `src/cards/state.ts`:
  - `CardStoreState` holding `cards: Map<id, CardRecord>`, `dependsOn: Map<id, string[]>`, `blocks: Map<id, string[]>`, `childrenByParent: Map<id, string[]>`.
  - `static fromByIdDir(projectRoot): CardStoreState` — loads every `cards/by-id/*.json`, builds the maps, runs the existing parent/depth/cycle/terminal/max-depth checks (moved verbatim from `HierarchyGraph.build` minus the index↔by-id equality throw).
  - Pure helpers: `addCard`, `updateCard`, `removeCard`, `setDependsOn`, `recomputeBlocks`, `computeIndex(): CardIndex`, `computeChangedFields(prev, next, TRACKED_FIELDS)`.
- Validation: `npm run typecheck`; new test `tests/utils/card-store-state.test.ts` covering boot from a hand-rolled by-id set, cycle detection, max-depth, parent-rules, computed index/deps/blocks/children equivalence with the existing `card-store.ts` output for the same input.
- Rollback: delete the new file and the new test.

## Step 3 — Introduce `applyMutation` and the commit marker

- New file `src/cards/commit-marker.ts`:
  - Types: `CommitMarker = { token: string; kind: MutationKind; by_id: { tmp_path: string; final_path: string } | { unlink_path: string }; history: { entry_id: string; entry: CardHistoryEntry; jsonl_path: string }; }`.
  - `writeMarker(projectRoot, marker)`, `listOutstandingMarkers(projectRoot)`, `recoverMarker(projectRoot, marker)` (replays renames + idempotent history append), `unlinkMarker(projectRoot, token)`.
  - Token = `randomUUID()`.
- Modify [src/persistence/jsonl-ledger.ts](../../../src/persistence/jsonl-ledger.ts): add `appendSyncIdempotent(path, line, entry_id)` that re-reads the last line and skips the append if the existing `entry_id` matches. (Does not change existing callers.)
- New file `src/cards/apply-mutation.ts`: exports `applyMutation(projectRoot, state, mutex, projectLock, request): Promise<CardStoreState>` implementing the seven-step sequence in [02-design-r2.md](02-design-r2.md) §"On-disk write sequence".
- Validation: `npm run typecheck`; new test `tests/utils/apply-mutation-crash.test.ts` (see Step 7 for full crash matrix; in this step add only the happy-path + "two sequential mutations" cases).
- Rollback: delete the new files; revert the ledger change.

## Step 4 — Rewrite `CardStore` on top of state + applyMutation

Files modified:
- [src/cards/card-store.ts](../../../src/cards/card-store.ts): rewritten. Constructor is now async via a `static async open(projectRoot, eventBus): Promise<CardStore>` factory:
  1. Recover any outstanding commit markers (`recoverMarker` for each).
  2. `state = await CardStoreState.fromByIdDir(projectRoot)`.
  3. `writeAllDerivedProjections(projectRoot, state)`.
  4. Return new instance holding `state`, `mutex`, `projectLock`, `eventBus`.
- Every mutation method (`create`, `update`, `mutateCard`, `setStatus`, `delete`, `archiveAndDeleteSubtree`, `updateDependsOn`, `recomputeBlocks`) becomes `async`, computes the next `CardRecord` in memory, builds the `CardHistoryEntry` (mandatory — see §F12 closure semantics below), calls `applyMutation`, then emits `card_history_appended` and `enqueueCardMutationNotifications`. After the mutation, `writeDerivedProjectionsForCards(projectRoot, state, touchedIds)` runs synchronously inside the locked region.
- Every read method (`read`, `list`, `getBlocks`, `getDependsOn`, `getDescendantIds`, `detectCycles`, `validateTransition`, `getCardAt`, `diffCard`) reads from `state` (in-memory), not from disk.
- `listCardHistory(id)` reads `cards/history/<id>.history.jsonl` via the existing ledger reader. This is the only read path that still touches the filesystem for card data.

Code removed in this step (matches [02-design-r2.md](02-design-r2.md) §Code that becomes unnecessary; full inventory in §Deletion inventory below):
- `validatedPersistedState`, `ensurePersistedStateValidated`, `validatePersistedState`, `loadCanonicalCardsFromDisk`, `loadIndex`, `saveIndex`, `addToIndex`, `removeFromIndex`, `writeCard`, `loadHistoryEntries`, `writeHistoryEntries`, `saveDependsOn`, `saveBlocks`, `parseChildrenIndex`, `rebuildGraphStrict`, `reconcileCardHistory`, `appendHistoryEntry`.
- `canonicalHealth` field, `getHealth` method, `CardStoreHealth`, `CardStoreCanonicalHealth` types and exports from [src/cards/card-store.ts](../../../src/cards/card-store.ts#L48-L50) and [src/cards/index.ts](../../../src/cards/index.ts#L7-L8).
- In `HierarchyGraph.build` ([src/cards/card-store.ts](../../../src/cards/card-store.ts#L73-L94)): the index↔by-id agreement throw. Parent/depth/cycle/terminal/max-depth checks **moved into `CardStoreState`** rather than deleted; the standalone `HierarchyGraph.build` function and the in-store call site are deleted.
- The `TRACKED_FIELDS`/`TRACKED_EDIT_FIELDS` split in callers becomes irrelevant — every mutation produces history. Update analyst tools ([src/agents/analyst-tools.ts](../../../src/agents/analyst-tools.ts#L120-L121)) to drop the local copy.

Async fan-out (review item 2 in F12 review applies here): every caller of the now-async mutation API must be `await`ed. Verified call sites:
- [src/runtime/runtime.ts](../../../src/runtime/runtime.ts) lines 266, 278, 483, 614, 644, and `performCrashRecovery` body — already async.
- [src/server/routes/operator-contracts.ts](../../../src/server/routes/operator-contracts.ts#L153-L157) `cards.update` — already async handler.
- [src/server/routes/cards.ts](../../../src/server/routes/cards.ts) all mutation routes — already async.
- [src/agents/analyst-stage6.ts](../../../src/agents/analyst-stage6.ts#L132-L188) — already async.
- [src/agents/analyst-tools.ts](../../../src/agents/analyst-tools.ts#L121-L144) — already async.
- [src/tools/agent-tools.ts](../../../src/tools/agent-tools.ts#L103-L121) — already async.
- [src/runtime/runtime-planner.ts](../../../src/runtime/runtime-planner.ts), planner-tools, artifact registration — all currently `async`.

All `new CardStore(projectRoot)` call sites must change to `await CardStore.open(projectRoot, eventBus)`. Grep target: `new CardStore(` in `src/` and `tests/`. The runtime constructor in [src/runtime/runtime.ts](../../../src/runtime/runtime.ts) becomes async; its callers must await (already do).

Validation: `npm run typecheck`; the full test list from §Baseline validation commands; explicit assertion that the per-step crash matrix from Step 7 passes.

Rollback: `git checkout HEAD~1 -- src/cards/card-store.ts src/cards/index.ts src/agents/analyst-tools.ts`. Steps 1-3 artifacts remain on disk; delete them too if the rollback is permanent.

## Step 5 — Delete the card-history projection from the event bus

- [src/projections/ledger-projections.ts](../../../src/projections/ledger-projections.ts#L105-L168): delete `CardHistoryProjection`, `registerCardHistoryProjection`, the call from `registerLedgerProjections`, and any helper.
- [src/projections/index.ts](../../../src/projections/index.ts): remove the export of `registerCardHistoryProjection`.
- [src/events/registry.ts](../../../src/events/registry.ts#L65): remove the `card_history_record_appended` entry. Keep `card_history_appended` ([src/events/registry.ts](../../../src/events/registry.ts#L58)) — it stays as a broadcast event and is now emitted by `CardStore` after every mutation.
- [src/schemas/types.ts](../../../src/schemas/types.ts): delete the `CardHistoryRecordAppendedEvent` interface if present.
- [tests/projections/ledger-projections.test.ts](../../../tests/projections/ledger-projections.test.ts): delete the `CardHistoryProjection` test block; keep the rest.
- Validation: `npm run typecheck`; `npm run test:direct -- tests/projections/ledger-projections.test.ts tests/utils/event-bus.test.ts tests/utils/event-logger.test.ts`.
- Rollback: revert these files.

## Step 6 — Seed the project tree as by-id only

- [src/persistence/file-tree.ts](../../../src/persistence/file-tree.ts#L148-L156): `initProjectTree` writes **only** `cards/by-id/project.json`, `notes/queue.json`, `views/leaderboard.json`, `views/saved-filters.json`, `skills/index.json`. The first `CardStore.open` on the new project generates `cards/index.json`, `cards/dependencies/depends-on.json`, `cards/dependencies/blocks.json`, and `cards/tree/project.children.json` from by-id.
- Delete `defaultCardIndexEntry`, `defaultDependsOnIndex`, `defaultBlocksIndex` (no remaining callers after this step).
- This step **must land in the same commit as Step 4** (or strictly after it in a single PR) — review item 2 on plan ordering. Reason: if Step 6 lands while the constructor still calls `loadCanonicalCardsFromDisk`, the constructor refuses to start because `cards/index.json` is missing. If Step 4 lands while seeding still writes `index.json`, the constructor regenerates it with the same content — harmless but the seeded `index.json` is dead bytes.
- Validation: `npm run typecheck`; `npm run test:direct -- tests/persistence/persistence-primitives.test.ts tests/utils/file-tree.test.ts tests/utils/card-store.test.ts`; manual round-trip `node bin/saivage.js init <tmp-path>` with `<tmp-path>` under `/home/salva/g/ml/tmp/`.
- Rollback: revert `file-tree.ts` and Step 4 together.

## Step 7 — Crash-injection test suite

New test file `tests/utils/card-store-crash-injection.test.ts`. The test harness wraps `applyMutation` with a configurable `abortAfter: 'staging' | 'marker' | 'by-id-rename' | 'history-append' | 'marker-unlink' | 'projection-write'` failure point. For each abort point and for each mutation kind (`create`, `update`, `setStatus`, `mutateCard`, `delete`, `archive`, `depends`), the test:

1. Builds a tmp project under `tmp/` (per workspace rules — see workspace handoff).
2. Calls a series of mutations, injects an abort, closes the store.
3. Reopens via `CardStore.open` (which runs recovery).
4. Asserts on **both** disk state and public reads:
   - `cards/by-id/<id>.json` is either pre-mutation or fully post-mutation (no partial).
   - `cards/history/<id>.history.jsonl` either has the entry exactly once or not at all; never twice and never partially.
   - `state.read(id)` matches the by-id file.
   - `state.listCardHistory(id)` matches the history file.
   - Derived files (`cards/index.json`, etc.) match the in-memory state after recovery.

Also add `tests/utils/card-store-boot-recovery.test.ts`:
- 50 mutations, abort after by-id rename for every 5th.
- Boot, assert all recoveries succeed and `cards/index.json` is bytewise equal to a freshly computed index.

Validation: `npm run test:direct -- tests/utils/card-store-crash-injection.test.ts tests/utils/card-store-boot-recovery.test.ts`.

Rollback: delete the test files.

## Step 8 — Operator route, contracts, and dashboard refresh

- [src/contracts/operator-api.ts](../../../src/contracts/operator-api.ts#L99-L135): delete `CardStoreHealthSchema`; remove the `cardStoreHealth: CardStoreHealthSchema.optional()` field from `RuntimeGetStateResponseSchema`.
- [src/contracts/index.ts](../../../src/contracts/index.ts#L22): remove `CardStoreHealthSchema` export.
- [src/contracts/operator-events.ts](../../../src/contracts/operator-events.ts#L12), [src/contracts/operator-events.ts](../../../src/contracts/operator-events.ts#L42): remove the import and the `cardStoreHealth` field from the snapshot envelope.
- [src/server/routes/operator-contracts.ts](../../../src/server/routes/operator-contracts.ts#L88): remove the hard-coded `cardStoreHealth: { canonical: 'ok' }` literal from the response body.
- [src/server/websocket.ts](../../../src/server/websocket.ts#L95): remove the `content.cardStoreHealth = …` assignment.
- Dashboard ([web/src/](../../../web/src)): grep for `cardStoreHealth` and delete the renderers + store fields.
- Tests with `cardStoreHealth` assertions: [tests/server/operator-api-contracts.test.ts](../../../tests/server/operator-api-contracts.test.ts), [tests/server/operator-api-contract-fixtures.test.ts](../../../tests/server/operator-api-contract-fixtures.test.ts), [tests/server/websocket-analyst-safety.test.ts](../../../tests/server/websocket-analyst-safety.test.ts), [tests/server/server-availability-contract.test.ts](../../../tests/server/server-availability-contract.test.ts). Remove the assertions; do not replace with a stub.
- Validation: `npm run typecheck`; the full test list from §Baseline; `npm run web:typecheck && npm run web:test:control-room` if the dashboard schema changed.
- Rollback: revert these files.

## F12 closure semantics — what each mutation appends to history

Mandatory in `applyMutation`:

| Mutation | History entry produced? | `changed_fields` content |
| --- | --- | --- |
| `create(parent, fields)` | yes (single entry, version_seq = 1) | the full set of populated fields |
| `update(id, patch)` (tracked field changed) | yes | the names of changed tracked fields |
| `update(id, patch)` (no tracked field changed) | yes | empty array; `kind: 'update'` |
| `setStatus(id, status)` | yes | `['status']` |
| `mutateCard(id, changes)` | yes (existing behaviour preserved) | as before |
| `delete(id)` | yes (final entry with `kind: 'deleted'`) | `['lifecycle']` |
| `archiveAndDeleteSubtree(root)` | one per affected card | `['lifecycle']` |
| `updateDependsOn(id, deps)` | yes | `['depends_on']` |
| `recomputeBlocks()` (no card-record change) | **no** | — (this is a derived recomputation, not a card mutation) |

This closes F12: every state-changing call to `CardStore` produces an audit entry by construction. `TRACKED_FIELDS` becomes a metadata hint for the dashboard's diff renderer, not a routing gate. The `tests/utils/card-history.test.ts` test at line 43 that asserts zero history entries after `update()` is **stale** and must be rewritten to assert one entry with the new shape.

## Deletion inventory (cumulative, mechanically checkable)

After all steps land, a grep over `src/` and `tests/` for any of the following must return zero matches:

- Identifiers: `validatedPersistedState`, `ensurePersistedStateValidated`, `validatePersistedState`, `loadCanonicalCardsFromDisk`, `loadIndex`, `saveIndex`, `addToIndex`, `removeFromIndex`, `writeCard`, `loadHistoryEntries`, `writeHistoryEntries`, `saveDependsOn`, `saveBlocks`, `parseChildrenIndex`, `rebuildGraphStrict`, `reconcileCardHistory`, `appendHistoryEntry`, `canonicalHealth`, `CardStoreHealth`, `CardStoreCanonicalHealth`, `getHealth`, `CardStoreHealthSchema`, `cardStoreHealth`, `card_history_record_appended`, `CardHistoryProjection`, `registerCardHistoryProjection`, `cardHistoryLedger`, `defaultCardIndexEntry`, `defaultDependsOnIndex`, `defaultBlocksIndex`, `TRACKED_EDIT_FIELDS`, `HierarchyGraph`.
- Source files to delete: none outright (every file above keeps at least one symbol), but `card-store.ts` shrinks substantially.
- Schema declarations to remove: in [src/schemas/validators.ts](../../../src/schemas/validators.ts#L27-L30), [src/schemas/types.ts](../../../src/schemas/types.ts#L58-L62), [src/schemas/index.ts](../../../src/schemas/index.ts#L33-L37) — any `CardStoreHealth*` / `CardHistoryRecordAppended*` exports.
- Test removals: `CardHistoryProjection` test block in [tests/projections/ledger-projections.test.ts](../../../tests/projections/ledger-projections.test.ts); all `cardStoreHealth` assertions in the four server contract tests above; all `update()→0 history` assertions in [tests/utils/card-history.test.ts](../../../tests/utils/card-history.test.ts) (rewritten, not deleted).

## Coordination with F12, F19, F20, F23

- **F12 (history empty).** Subsumed. After Step 4 lands, `/api/cards/:id/history` returns entries for every mutation including runtime-driven `setStatus` calls. F12's existing tests that expected empty history on `update` must be rewritten (see §F12 closure semantics). Mark F12 closed by F13 in the metaplan. No separate PR.
- **F19 (runtime pinned to failed card).** F19's fix changes `runtime.advance` / `performCrashRecovery` logic and calls `cardStore.setStatus`. Land F13 **first** so F19 can add tests of the form "after a `failed` card is replaced, `cardStore.listCardHistory(failedId)` shows the transition entries". If F19 must land first for operator reasons, it temporarily continues to call `setStatus` with the same opt-in history behaviour (no F12 fix); F13's Step 4 then rewrites the underlying primitive without changing F19's call sites. Overlapping runtime tests: [tests/runtime/runtime-activation-ledger.test.ts](../../../tests/runtime/runtime-activation-ledger.test.ts), [tests/runtime/runtime-command-ledger.test.ts](../../../tests/runtime/runtime-command-ledger.test.ts), [tests/utils/freeze-resume.test.ts](../../../tests/utils/freeze-resume.test.ts), [tests/utils/runtime-integration.test.ts](../../../tests/utils/runtime-integration.test.ts), [tests/utils/runtime-state-invariant.test.ts](../../../tests/utils/runtime-state-invariant.test.ts), [tests/utils/runtime-held-dispatch.test.ts](../../../tests/utils/runtime-held-dispatch.test.ts).
- **F20 (executor false-failed).** Independent of the card-store rewrite (lives in the executor wrapper). No ordering constraint; F20's tests gain free audit-trail assertions once F13 lands but do not need to assert them.
- **F23 (illegal `failed→active`).** F23 patches `validateTransition` in [src/cards/card-store.ts](../../../src/cards/card-store.ts). Under F13, `validateTransition` moves into `CardStoreState`. Land F13 first; F23 then patches the moved function. If F23 lands first, its patch sits in `card-store.ts` and Step 4 carries the patch into `state.ts` verbatim.
- **F18 (PID in status).** Independent. No coordination required.

## Rollback strategy

Per the workspace architecture-first/no-backward-compatibility rule, rollback means one of:

- **Revert before release.** `git revert` the PR series. Because the on-disk format of `cards/by-id/*.json` and `cards/history/*.history.jsonl` is byte-identical to today, the pre-F13 code reads the post-F13 files correctly (the only difference is that history files now contain entries for `update`/`setStatus`, which the pre-F13 reader exposes via `listCardHistory` without complaint). The derived files (`index.json`, `depends-on.json`, `blocks.json`) are regenerated by the pre-F13 code on its first mutation.
- **Reset local `.saivage` state.** For dev/CI environments where a corrupt commit-marker recovery is suspected, `rm -rf .saivage/cards/.commit/ && rm .saivage/cards/index.json .saivage/cards/dependencies/{depends-on,blocks}.json && rm -rf .saivage/cards/tree/` and reopen the store; the constructor regenerates everything from by-id.

There is **no** bidirectional runtime compatibility shim. Old code does not need to know about `.commit/`. New code does not need to know about a pre-F13 on-disk state because there is no pre-F13 on-disk state that the new code cannot read.

## Expected risk

Medium. Surface area: every code path that mutates cards. Dominant risks:

- **Async fan-out.** All mutation methods become async. Audit lists every call site; missed `await`s manifest as race conditions in tests. Mitigation: typecheck flags every missing `await` because the return type changes from `CardRecord` to `Promise<CardRecord>`.
- **Fixture tests writing directly to `cards/index.json` or `cards/dependencies/*.json`.** Those writes become dead — the store regenerates from by-id on next open. Mitigation: grep `tests/` for direct writes to those paths and convert to `writeFileAtomic(cardPath(...), ...)` seeding instead.
- **Derived projection drift after manual edits.** Operators editing `cards/index.json` by hand have their edits silently dropped. Mitigation: documented behaviour change; the projection writer's stable output keeps `git diff` clean.
- **Corrupt last history line after hard kill.** Localised to one card; `JsonlLedger`'s existing quarantine on read tolerates it ([src/persistence/jsonl-ledger.ts](../../../src/persistence/jsonl-ledger.ts#L70)). The commit-marker idempotent-append on recovery prevents producing a corrupt line in the first place when the kill lands after marker rename.
