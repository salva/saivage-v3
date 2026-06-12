# F12 — Design proposals (r2)

Supersedes [02-design-r1.md](./02-design-r1.md). Addresses the 9 design-review items in [01-analysis-review-r1.md](./01-analysis-review-r1.md) and the F13 coordination items in [F13/01-analysis-review-r1.md](../F13-canonical-index-drift/01-analysis-review-r1.md). Companion: [01-analysis-r2.md](./01-analysis-r2.md).

Project guideline reminder: **architecture-first, no backward compatibility, no migration shims, no dead code, no over-engineering.**

## Stance on F13

This design **subsumes F13** as an architecture-first choice (analysis §9, F13 reviewer #9). F13's own r2 must mark the implementation as subsumed by this plan; F13's r2 analysis/design can remain as the index-drift framing, but the *implementation surface* belongs entirely here. Rationale: both bugs are the same multi-file-write defect; collapsing them lets us delete one set of code paths atomically. We commit to landing the deletions of `cards/index.json`, `depends-on.json`, `blocks.json`, the consistency invariant in `HierarchyGraph.build`, and the history projection in **this** workstream's steps.

## Rejected: Proposal A (focused fix)

**Reviewer item #1.** Proposal A from r1 — inline the history append into `mutateCard`, keep `update`/`setStatus` bypassing history, keep `cards/index.json` and friends — is **rejected** under the project guideline. Reasons:

- Leaves the `update()`/`setStatus()`/`mutateCard()` API split, so the operator audit trail keeps missing every status, result, error, artifact, and attachment edit.
- Leaves `cards/index.json`, `depends-on.json`, `blocks.json` as authoritative files with their own write paths, which is exactly the F13 defect.
- Keeps the `CardHistoryProjection` indirection that buys nothing (no fan-out, no batching, no cross-process delivery) and pays correctness cost (project-wide lock).
- Keeps `reconcileCardHistory` silently truncating data on every store construction.

A is preserved here only as a contrast point, not as a viable variant.

## Rejected: Proposal B.2 (cache files)

**Reviewer item #2.** Keeping `cards/index.json`, `depends-on.json`, `blocks.json` as caches that are rewritten on every mutation **preserves the same shared-file write set** that produces F13's drift window and forces the per-card lock model to fall back to a project-wide lock during cache rewrites. Under the no-backward-compat rule, the cache layer is dead weight. The accepted design is Proposal B.1 only.

## Accepted: Proposal B.1 — single mutation entry point, by-id is the only authoritative card-state file

**Reviewer items #1, #2, #6.** This is the only proposal carried forward.

### Source of truth (reviewer item #6)

- `<projectRoot>/.saivage/cards/by-id/<id>.json` — the canonical current snapshot. Reads always return what is in this file.
- `<projectRoot>/.saivage/cards/history/<id>.history.jsonl` — append-only audit log of every mutation. Used for `getCardAt(seq != current)`, `listCardHistory`, `diffCard`.
- `<projectRoot>/.saivage/cards/locks/<id>.lock` — per-card advisory lock file.

**Explicit semantics:** by-id is the current state. History is a per-mutation snapshot of the *pre-mutation* card. There is no event-sourced replay model, no WAL, no `cards/events.jsonl`. History entries are never replayed to reconstruct current state; if history is corrupt the current state is still readable from by-id.

We do not introduce a `CardTransaction` abstraction (r1 reviewer #6): the only thing it would wrap is `applyMutation` itself, and one wrapper around one method is not an abstraction.

### Removed at rest (reviewer item #2)

- `<projectRoot>/.saivage/cards/index.json` — deleted from on-disk layout, deleted from `initProjectTree`, deleted from `isNewSaivageState`, deleted from schemas (`cardIndexSchema`, `cardChildrenIndexSchema` if unused).
- `<projectRoot>/.saivage/cards/dependencies/depends-on.json` — deleted; depends-on is derived from `card.depends_on`.
- `<projectRoot>/.saivage/cards/dependencies/blocks.json` — deleted; blocks is derived by inverting `card.depends_on`.

`reconcileCardHistory` is deleted: with append-then-rename-with-rollback (see §write path), an orphan tail is an invariant violation, not a recoverable state. The `read()` method ([src/cards/card-store.ts#L758-L764](../../../src/cards/card-store.ts#L758-L764)) currently overlays `card.blocks` from `blocks.json`; in this design `card.blocks` is recomputed in memory from the by-id glob and written back into the by-id record at mutation time (see §3 below).

### Write path (reviewer items #3, #4, #5)

Single entry point: `CardStore.applyMutation(id, patch, ctx): Promise<CardRecord>`.

**The method is async.** This is the deliberate resolution of reviewer item #4: `ProjectLock.withLock` returns `Promise<T>`, the per-card lock file is acquired via that primitive, and there is no synchronous retrying lock. Every transitive caller becomes async. The full list is in [03-plan-r2.md §Step 4](./03-plan-r2.md#step-4--migrate-external-call-sites-to-applymutation).

Steps under `cardLock(id).withLock(async handle => { ... })`:

1. `read(id)` — load current by-id record (cheap, in-memory cache valid because we hold the per-card lock).
2. Validate the candidate (`validateMutablePatch`).
3. `prunePartialPatch(existing, patch)` — if empty, release lock and return `existing` unchanged. **No history line is written for no-op patches.**
4. Build the next card with `version_seq = existing.version_seq + 1`.
5. Build the history entry. `changed_fields` is **the full diff** (every field whose new value differs from existing), not a `TRACKED_FIELDS`-filtered subset. `version_seq` in the entry is `existing.version_seq` (the pre-bump snapshot's version).
6. `statSync(<id>.history.jsonl).size` (or 0 if absent) → captured as `historyByteLength` for rollback.
7. Open the history file with `O_APPEND | O_CREAT | O_WRONLY`, write `JSON.stringify(historyEntry) + "\n"`, `fsync`, close.
8. Write `<id>.json.tmp`, `fsync`, `rename` to `<id>.json`. **If this step throws**: `truncateSync(<id>.history.jsonl, historyByteLength)` inside the same critical section, then rethrow.
9. Rebuild the in-memory hierarchy graph and dependency caches from the changed card and its neighbours (in-memory only; no shared file write).
10. Release the lock. Return the updated record.

**Public broadcast event (reviewer item #9):** `card_history_appended` ([src/events/registry.ts#L58](../../../src/events/registry.ts#L58), [src/contracts/operator-events.ts#L110-L119](../../../src/contracts/operator-events.ts#L110-L119), [src/server/websocket.ts#L303](../../../src/server/websocket.ts#L303)) is **kept** because it is part of the websocket/operator event wire contract. It is emitted by the runtime/route layer **after** `applyMutation` returns successfully — not by the card store. Specifically: the operator HTTP route, the runtime mutation orchestrator, the planner/analyst tool wrappers each call `applyMutation` and then emit `card_history_appended` on the shared bus. The card store no longer takes an `eventBus` parameter and no longer emits anything.

**Internal projection event `card_history_record_appended` is deleted** ([src/events/registry.ts#L65](../../../src/events/registry.ts#L65)); the projection that consumed it is also deleted.

### Locking model (reviewer item #3)

Single per-card lock at `<projectRoot>/.saivage/cards/locks/<id>.lock`, acquired with `ProjectLock(...).withLock(async handle => ...)`. This is sufficient because **no shared cache files are written by mutations** — `cards/index.json`, `depends-on.json`, `blocks.json` are deleted, not "rewritten under the per-card lock". The graph rebuild in step 9 is in-memory only.

Cross-process: two processes mutating the same card serialize on the per-card lock file. Two processes mutating different cards do not contend. The runtime's `runtime/project.lock` (used by state.ts, control actions, notifications) is unrelated to card mutations and is no longer touched by card writes.

### Crash semantics (reviewer item #5)

The invariant chosen is: **append history first; rename by-id second; on rename failure, truncate history back to the pre-append byte length inside the same critical section.**

| Failure point | On-disk state | Detection |
|---|---|---|
| Before step 7 | unchanged | n/a |
| During step 7 (append before fsync) | possibly partial last line | startup invariant check (below) |
| Between step 7 and step 8 (rename throws) | history has orphan, rollback truncates it | rollback runs in same critical section |
| Between step 7 and step 8 (process crash) | history has orphan, no rollback | startup invariant check throws loudly |
| After step 8 succeeds | committed | n/a |

**Startup invariant** (replaces the deleted `reconcileCardHistory`): on `new CardStore(projectRoot)`, for each by-id record, read the last line of `<id>.history.jsonl` and assert `last.version_seq < current.version_seq`. If the assertion fails, throw a fatal `CardStoreInvariantError` naming the card id, the orphan `version_seq`, and the recovery instruction ("run `saivage reset` or hand-edit `.saivage/cards/history/<id>.history.jsonl`"). **No silent truncation, ever.** Partial-line detection: if `JSON.parse` of the last line throws, same fatal error with the byte offset.

This is the single invariant. The design does **not** leave orphan history visible AND claim crash safety simultaneously (reviewer item #5).

### Read path

- `read(id)`: read `<id>.json` directly. No `blocks.json` overlay (the field lives in the card record, recomputed at mutation time from the in-memory graph).
- `list()`: glob `by-id/*.json` and read each. Cached in memory; cache is invalidated by `applyMutation` and on `new CardStore`.
- `listChildren`, `descendantsOf`, `getAncestors`: in-memory graph built from the by-id glob.
- `listCardHistory(id)`: read `<id>.history.jsonl`, reverse.
- `getCardAt(id, seq)`: if `seq == current.version_seq`, return `read(id)`; else find in history.
- `diffCard(id, from, to)`: unchanged on top of `getCardAt`.

### API/contract impact (reviewer item #7)

- Wire schemas for `cards.history.list`, `cards.history.get`, `cards.diff` ([src/contracts/operator-api.ts#L151-L159](../../../src/contracts/operator-api.ts#L151-L159)) are **kept unchanged** for this F12. The current `headers: z.record(...)` wildcard is sloppy but tightening it is a separate cleanup that does not affect the bug fix. Explicitly out of scope; tracked as future debt.
- Wire schemas for `cards.update` payload are **kept unchanged**. The semantic change is that every accepted field now produces a history line (because `TRACKED_FIELDS` is gone). This is a positive-direction operator change.
- New contract tests required:
  - `tests/server/operator-api-contracts.test.ts`: PATCH `/api/cards/:id` with a previously-untracked field (e.g. `status`), then GET `/api/cards/:id/history`, assert `total: 1`, `history[0].version_seq: 1`, `changed_fields: ["status"]`.
  - Same with a tracked field (e.g. `title`), assert identical behaviour.
  - GET `/api/cards/:id/history/1` returns pre-edit snapshot.
  - GET `/api/cards/:id/diff?from=1&to=2` returns the changed field list.
  - `tests/server/websocket-analyst-safety.test.ts` (and websocket smoke tests): assert `card_history_appended` is emitted exactly once per `applyMutation`.

### Dead-code removal list (reviewer item #8)

Mandatory deletions (in addition to those listed in r1 §Proposal B):

- `appendHistoryEntry` ([src/cards/card-store.ts#L543-L552](../../../src/cards/card-store.ts#L543-L552))
- `reconcileCardHistory` ([src/cards/card-store.ts#L554-L568](../../../src/cards/card-store.ts#L554-L568))
- `writeHistoryEntries` ([src/cards/card-store.ts#L535-L542](../../../src/cards/card-store.ts#L535-L542))
- `parseChildrenIndex` ([src/cards/card-store.ts#L384-L388](../../../src/cards/card-store.ts#L384-L388))
- `TRACKED_FIELDS` ([src/cards/card-store.ts#L204-L222](../../../src/cards/card-store.ts#L204-L222))
- `TRACKED_UPDATE_FIELDS` ([src/server/routes/operator-contracts.ts#L15](../../../src/server/routes/operator-contracts.ts#L15)) and the `tracked` branch at L155
- `TRACKED_EDIT_FIELDS` ([src/agents/analyst-tools.ts#L120-L121](../../../src/agents/analyst-tools.ts#L120-L121))
- `update`, `mutateCard`, `setStatus`, `updateDependsOn`, `activateGoal` methods on `CardStore` (collapsed into `applyMutation`)
- `CardStoreTestHooks.beforeTrackedCardRename` ([src/cards/card-store.ts#L51-L53](../../../src/cards/card-store.ts#L51-L53)) → replaced by `beforeByIdRename`
- `eventBus` constructor parameter on `CardStore` ([src/cards/card-store.ts#L328-L341](../../../src/cards/card-store.ts#L328-L341))
- `CardHistoryProjection` class, `registerCardHistoryProjection` function, `cardHistoryLedger` helper ([src/projections/ledger-projections.ts#L107-L122](../../../src/projections/ledger-projections.ts#L107-L122), [:166-168](../../../src/projections/ledger-projections.ts#L166-L168), [:52-54](../../../src/projections/ledger-projections.ts#L52-L54))
- `card_history_record_appended` event kind ([src/events/registry.ts#L65](../../../src/events/registry.ts#L65))
- `cardIndexSchema`, `cardChildrenIndexSchema`, `cardDependencyIndexSchema`, `cardBlocksIndexSchema` from [src/schemas/validators.ts#L27-L30](../../../src/schemas/validators.ts#L27-L30), [src/schemas/types.ts#L58-L62](../../../src/schemas/types.ts#L58-L62), [src/schemas/index.ts#L33-L37](../../../src/schemas/index.ts#L33-L37); update [tests/schemas.test.ts](../../../tests/schemas.test.ts).
- `addToIndex`, `removeFromIndex`, `loadIndex`, `saveIndex`, `loadDependsOn`, `saveDependsOn`, `loadBlocks`, `saveBlocks`, `recomputeBlocks`, `indexPath`, `dependsOnPath`, `blocksPath` on `CardStore`.
- `defaultCardIndexEntry`, `defaultDependsOnIndex`, `defaultBlocksIndex` from [src/persistence/file-tree.ts#L70-L149](../../../src/persistence/file-tree.ts#L70-L149); `isNewSaivageState` loses its `cards/index.json` check.
- The canonical-mismatch branch in `HierarchyGraph.build` ([src/cards/card-store.ts#L77-L89](../../../src/cards/card-store.ts#L77-L89)) — F13's invariant is no longer representable.
- `CardStoreHealthSchema` and related exports (per F13 reviewer #6): [src/contracts/operator-api.ts#L99](../../../src/contracts/operator-api.ts#L99), [src/contracts/index.ts#L22](../../../src/contracts/index.ts#L22); websocket status payload handling in [src/server/websocket.ts#L95](../../../src/server/websocket.ts#L95); the hard-coded `{ canonical: 'ok' }` at [src/server/routes/operator-contracts.ts#L88](../../../src/server/routes/operator-contracts.ts#L88). The in-memory `canonicalHealth` flag becomes unobservable; the `getHealth()` method is deleted or shrunk.
- Orphan-recovery cases at [tests/utils/card-history.test.ts#L66-L117](../../../tests/utils/card-history.test.ts#L66-L117); the "update without tracked fields does not append history" case at [tests/utils/card-history.test.ts#L43](../../../tests/utils/card-history.test.ts#L43).
- `card_history_record_appended` test case in [tests/projections/ledger-projections.test.ts#L125](../../../tests/projections/ledger-projections.test.ts#L125).

No migration shim, no `@deprecated` markers, no fallback paths. Old on-disk files (`cards/index.json`, `depends-on.json`, `blocks.json`) that exist on already-deployed projects are simply ignored by the new code and may be hand-deleted by the operator or wiped by `saivage reset`.

### Failure modes considered

- Concurrent mutation of the same card from two processes: serialised on per-card lock.
- Concurrent mutation of different cards: independent.
- Reader during writer: by-id rename is atomic; history append is a single fully-buffered line; readers see consistent pre- or post-state.
- Partial fsync on history (power loss mid-write): caught by startup invariant.
- Cross-card consistency (parent rename, child orphaning): the graph is rebuilt from glob on every `applyMutation`, so a deleted parent is observed by the next mutation. We do not enforce referential integrity across cards in this design (out of scope; covered by existing `validatePersistedState` walks of by-id structure).

### Tests strategy summary

See [03-plan-r2.md](./03-plan-r2.md) for the per-step list. Headline additions:

- New invariant test: hand-inject orphan tail, assert `new CardStore` throws.
- New concurrency test: two parallel `applyMutation` calls on the same id resolve serialised; two on different ids run in parallel.
- New contract tests on `PATCH /api/cards/:id` → `GET /api/cards/:id/history` round trip for both tracked and previously-untracked fields.
- Web component/store tests: card history panel populates after a real mutation.
- Delete: orphan recovery, "update without tracked fields does not append history", `card_history_record_appended` projection test.
