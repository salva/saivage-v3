# F13 — Implementation Plan (r1) — Proposal B

Chosen design: event-sourced `CardStore` (see [02-design-r1.md](02-design-r1.md) §Proposal B). F12 lands inside this work — there is no separate fix.

Validation command for every step:

```
cd /home/salva/g/ml/saivage-v3
npx tsc --noEmit
npx vitest run tests/cards tests/projections tests/persistence
```

## Step 1 — Event log schema and writer primitive

- New file `src/cards/event-log.ts`:
  - `cardEventSchema` (zod): `{ seq, ts, actor, surface, reason|null, kind: 'card_created'|'card_updated'|'card_deleted'|'card_archived', card_id, version_seq, snapshot: CardRecord, prev_snapshot: CardRecord | null, changed_fields: string[] }`.
  - `CardEventLog` class wrapping a `JsonlLedger<CardEvent>` rooted at `.saivage/cards/events.jsonl`, using the existing `ProjectLock` at `.saivage/runtime/project.lock`.
  - Methods: `appendSync(event)`, `replay(): CardEvent[]`, `truncateTrailingPartialLine()`.
- Add `cardEventSchema` export from [src/schemas/index.ts](../../../src/schemas/index.ts).
- Validation: `npx tsc --noEmit`; new unit test `tests/cards/event-log.test.ts` covering append + replay + truncated-tail recovery.
- Rollback: delete the new file and the schema export.

## Step 2 — In-memory state model rebuilt from the log

- New file `src/cards/state.ts`:
  - `CardStoreState` class holding `cards: Map<id, CardRecord>`, `index: CardIndex`, `dependsOn: CardDependencyIndex`, `blocks: CardBlocksIndex`, `historyByCard: Map<id, CardHistoryEntry[]>`.
  - `static fromEventLog(events): CardStoreState` — folds events into the maps; derives per-card `version_seq` from event count for that card; derives `created_at`/`updated_at` from event timestamps.
  - `applyEvent(event)` — incremental update used after each append.
  - Helper: `computeChangedFields(prev, next, TRACKED_FIELDS)` (moved from `card-store.ts`).
- Validation: `npx tsc --noEmit`; new test `tests/cards/state.test.ts` covering create→update→delete→archive replays plus equivalence between full-replay and incremental apply.
- Rollback: delete the new file.

## Step 3 — Projection rebuilder

- New file `src/cards/projections-writer.ts`:
  - `writeAllProjections(projectRoot, state)` — writes `cards/index.json`, every `cards/by-id/<id>.json`, `cards/dependencies/depends-on.json`, `cards/dependencies/blocks.json`, every `cards/history/<id>.history.jsonl`, in any order, using `writeFileAtomic`. No commit marker needed; these are derived.
  - `writeIncrementalProjections(projectRoot, state, touchedCardIds)` — same, restricted to the touched ids plus the always-shared index/dependencies files.
- Validation: `npx tsc --noEmit`; test `tests/cards/projections-writer.test.ts` covering full + incremental, idempotence, and bytewise equivalence between successive full rebuilds.
- Rollback: delete the new file.

## Step 4 — Rewrite `CardStore` on top of event log + state + projection writer

Files modified:

- [src/cards/card-store.ts](../../../src/cards/card-store.ts) — rewritten. Constructor: loads the event log (creating an empty file if missing), builds `CardStoreState`, calls `writeAllProjections` once.
- Each mutation method (`create`, `update`, `mutateCard`, `setStatus`, `delete`, `archiveAndDeleteSubtree`, `updateDependsOn`, `recomputeBlocks`) now:
  1. Validates against the in-memory `CardStoreState` (parent rules, depth, cycles, transitions, terminal-children, max-depth — logic preserved from current `HierarchyGraph.build` and per-method checks).
  2. Builds the next `CardRecord`, bumps `version_seq`.
  3. Builds a `CardEvent`, calls `cardEventLog.appendSync(event)`.
  4. `state.applyEvent(event)`.
  5. `writeIncrementalProjections(projectRoot, state, [card.id])`.
  6. Emits the existing high-level events (`card_history_appended`, `enqueueCardMutationNotifications`) — these stay as observability notifications, not as the durable contract.

Code removed in this step (matches Proposal B removal list in [02-design-r1.md](02-design-r1.md) §Code that becomes unnecessary):

- `validatedPersistedState`, `ensurePersistedStateValidated`, `validatePersistedState`, `rebuildGraphStrict`, `loadCanonicalCardsFromDisk`, `reconcileCardHistory`, `appendHistoryEntry`, `addToIndex`, `removeFromIndex`, `writeCard`, `loadHistoryEntries`, `writeHistoryEntries`, `saveIndex`, `saveDependsOn`, `saveBlocks` (replaced by projection writer).
- `canonicalHealth`, `CardStoreCanonicalHealth`, `CardStoreHealth`, `getHealth`, and the `card-store.ts` exports of these types.
- The "index entry does not match by-id record" throw in `HierarchyGraph.build` (lines 73-94). Parent/depth/cycle/terminal/max-depth checks move into `CardStoreState` validation helpers.
- Re-exports in [src/cards/index.ts](../../../src/cards/index.ts) of `CardStoreCanonicalHealth`, `CardStoreHealth`.

Validation: `npx tsc --noEmit`; full `tests/cards` suite; `tests/server/routes/cards` if present.

Rollback: revert `card-store.ts` (single file revert; the new files from Steps 1-3 remain on disk but are unused — delete them too if the rollback is permanent).

## Step 5 — Remove the card-history projection from the event bus

- [src/projections/ledger-projections.ts](../../../src/projections/ledger-projections.ts): delete `CardHistoryProjection`, `registerCardHistoryProjection`, the call in `registerLedgerProjections`, the export from [src/projections/index.ts](../../../src/projections/index.ts).
- [src/events/index.ts](../../../src/events/index.ts): remove `card_history_record_appended` from `eventKindValues`.
- [src/cards/card-store.ts](../../../src/cards/card-store.ts): remove the `registerCardHistoryProjection(this.eventBus, this.projectRoot)` call in the constructor and the `EventBus` import if no longer used.
- Audit callers in `tests/` for `card_history_record_appended` and `registerCardHistoryProjection`; delete or rewrite to assert on `CardEvent` appends instead.

Validation: `npx tsc --noEmit`; `npx vitest run tests/projections tests/events`.

Rollback: revert these three files.

## Step 6 — Seed the project tree via an event, not by writing projections

- [src/persistence/file-tree.ts](../../../src/persistence/file-tree.ts): replace the calls writing `cards/index.json`, `cards/by-id/project.json`, `cards/dependencies/{depends-on,blocks}.json` (lines 148-152) with a single helper that opens a `CardEventLog` and appends a `card_created` event for the default project card. The projection files are then produced by the `CardStore` constructor's initial `writeAllProjections`.
- `defaultCardIndexEntry`, `defaultDependsOnIndex`, `defaultBlocksIndex` lose their callers; delete them.

Validation: `npx tsc --noEmit`; `npx vitest run tests/persistence tests/cards`; manual `saivage init <tmp-path>` round-trip with `tmp/` under `/home/salva/g/ml`.

Rollback: revert `file-tree.ts`.

## Step 7 — Crash-recovery sweep in `runtime.ts`

- [src/runtime/runtime.ts](../../../src/runtime/runtime.ts) `performCrashRecovery` (line 614) currently iterates active/running cards and calls `setStatus(...,'backlog')`. Under the new store every such call writes one event and rebuilds projections. No code change required, but add a regression test forcing 50 active cards at boot and asserting (a) every transition appears in `events.jsonl`, (b) `cards/index.json` matches `state.index` bytewise after recovery.

Validation: `npx vitest run tests/runtime/crash-recovery`.

Rollback: delete the new test.

## Step 8 — Operator route refresh

- [src/server/routes/cards.ts](../../../src/server/routes/cards.ts) `/api/cards/:id/history` already calls `cardStore.listCardHistory(id)`. Under the new store this returns entries reconstructed from `events.jsonl`, so F12 closes here. Confirm the route returns `{ history: CardHistoryEntry[], total }` shape unchanged.
- `cardStoreHealth` field consumers — grep `cardStoreHealth` across `src/` and remove the field from `/api/state` / `/api/runtime/status` payloads, plus the corresponding zod field in [src/contracts/](../../../src/contracts/) and the web dashboard rendering.

Validation: `npx tsc --noEmit`; `npx vitest run tests/server`; `pnpm -C web build` if the dashboard schema changed.

Rollback: re-add the field as a constant `'ok'` literal.

## Coordination

- **F12 (card history empty).** Collapsed into Step 4. No separate PR. After Step 4 lands, `/api/cards/:id/history` returns entries for every mutation including runtime-driven status transitions; F12's acceptance test is satisfied by construction. Mark F12 as "closed by F13" in the metaplan.
- **F19 / F20 / F23 (runtime lifecycle).** These all mutate cards via `cardStore.update` / `setStatus`. They become *consumers* of the new event-sourced store; no behavioural change for them, but their tests gain free history-trail assertions. Land F13 first so that the lifecycle fixes can use `cardStore.listCardHistory` as their audit signal. If a lifecycle fix needs to land before Step 4 is merged, gate it on the temporary `setStatus`/`update` calling `appendHistoryEntry` explicitly (a 3-line patch reverted by Step 4).
- **F18 (PID in status).** Independent. No coordination required.

## Explicit dead-code removal list (cumulative across steps)

[src/cards/card-store.ts](../../../src/cards/card-store.ts):
- `validatedPersistedState`, `ensurePersistedStateValidated`, `validatePersistedState`, `rebuildGraphStrict`, `loadCanonicalCardsFromDisk`, `reconcileCardHistory`, `appendHistoryEntry`, `addToIndex`, `removeFromIndex`, `writeCard`, `loadHistoryEntries`, `writeHistoryEntries`, `saveIndex`, `saveDependsOn`, `saveBlocks`, `canonicalHealth`, `CardStoreCanonicalHealth`, `CardStoreHealth`, `getHealth`.
- The index↔by-id agreement throw in `HierarchyGraph.build` (lines 73-94).

[src/cards/index.ts](../../../src/cards/index.ts):
- Type re-exports `CardStoreCanonicalHealth`, `CardStoreHealth`.

[src/projections/ledger-projections.ts](../../../src/projections/ledger-projections.ts):
- `CardHistoryProjection`, `registerCardHistoryProjection`, call in `registerLedgerProjections`, helper `cardHistoryLedger`.

[src/projections/index.ts](../../../src/projections/index.ts):
- Export of `registerCardHistoryProjection`.

[src/events/index.ts](../../../src/events/index.ts):
- `card_history_record_appended` event kind.

[src/persistence/file-tree.ts](../../../src/persistence/file-tree.ts):
- `defaultCardIndexEntry`, `defaultDependsOnIndex`, `defaultBlocksIndex` (delete with their callers).
- The four direct projection writes in `initProjectTree` (lines 149-152).

[src/contracts/](../../../src/contracts/) and dashboard:
- `cardStoreHealth` field and its zod schema.

## Rollback strategy

Each step is a single PR touching ≤ 3 files (Step 4 is the exception — it rewrites `card-store.ts`; rollback is `git checkout HEAD~1 -- src/cards/card-store.ts`). Because every mutation is an append-only event, a forward-only migration applies: if a bug lands, the next PR re-rewrites `card-store.ts` while keeping `events.jsonl` untouched. The on-disk projection files are derived and always regenerated on boot, so no data migration is ever needed.

For a Step 4 emergency revert in production: revert the PR, restart `saivage.service`. The pre-event-log code reads the projection files that the event-log code last wrote, which are byte-equivalent to what the pre-event-log code would have written, so the rollback is in-place.

## Expected risk

Medium. The store is touched by every code path; the surface area is large but the API contract on `CardStore` is preserved verbatim. The dominant risk is hidden assumptions in tests that write projection files as fixtures — those tests will need rewriting in Step 4. The dominant operational risk is a corrupt last line in `events.jsonl` after a hard kill; mitigated by `truncateTrailingPartialLine` in Step 1.
