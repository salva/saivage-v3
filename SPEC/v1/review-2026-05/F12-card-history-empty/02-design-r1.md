# F12 — Design proposals (r1)

Companion to [01-analysis-r1.md](./01-analysis-r1.md). Two proposals, ordered by scope. Project guideline reminder: architecture-first, no backward compatibility, no migration shims. Old on-disk shapes that are no longer used MUST be deleted by the implementation, not "left for later".

## Proposal A — Focused fix: inline the history append into `mutateCard` and remove the projection indirection

### Intent

Make `cards/history/<id>.history.jsonl` writes happen inline inside `mutateCard`, in the same single critical section as the by-id rename and the index write. Remove the EventBus indirection for card history. The projection currently buys nothing (no cross-bus fan-out, no async dispatch, no batching) and pays correctness cost (lock cross-talk, hidden failure modes, orphan tail).

### Data model

Unchanged at rest:

- `<projectRoot>/.saivage/cards/by-id/<id>.json` — card record with `version_seq`.
- `<projectRoot>/.saivage/cards/index.json` — index of {id, type, parent, status, title}.
- `<projectRoot>/.saivage/cards/history/<id>.history.jsonl` — append-only JSONL of `CardHistoryEntry`.

Removed at rest:

- `reconcileCardHistory`'s orphan-truncation contract becomes obsolete and the tail-drop block is deleted; with inline writes there cannot be an orphan tail beyond a single in-flight line that wasn't fsynced.

### Write path

Replace [src/cards/card-store.ts:540-553](../../../src/cards/card-store.ts#L540-L553) (`appendHistoryEntry`) and rewrite the tail of [src/cards/card-store.ts:811-883](../../../src/cards/card-store.ts#L811-L883) (`mutateCard`) so that the steps run in this order under a card-scoped advisory lock at `<projectRoot>/.saivage/cards/locks/<id>.lock`:

1. Validate the candidate.
2. Acquire the per-card lock.
3. Append the history line to `<id>.history.jsonl` with `O_APPEND|O_CREAT` and `fsync`.
4. Rename the new by-id record from `<id>.json.tmp` to `<id>.json`.
5. Read-modify-write `cards/index.json` (also via temp+rename).
6. Read-modify-write `depends-on.json` / `blocks.json` as needed.
7. Release the lock.
8. Rebuild the in-memory graph from the now-consistent on-disk state.

Rollback on step 4/5 failure: truncate the JSONL back to its pre-step-3 byte length (captured before the append) and rethrow. Truncation MUST happen inside the same critical section.

The per-card lock is new. It replaces `runtime/project.lock` usage by the history projection (which leaks across subsystems). It does NOT replace `runtime/project.lock`; runtime state writes keep using their own lock.

### Read path

`listCardHistory` unchanged. `loadHistoryEntries` unchanged. `reconcileCardHistory` deleted entirely (no longer reachable; the inline write+rollback contract makes the orphan case unreachable).

### API impact

None on the wire. `cards.history.list`, `cards.history.get`, `cards.diff` are byte-identical.

### On-disk format impact

- `<id>.history.jsonl` schema unchanged.
- No backward-compat shim for cards persisted by the old projection-based writer. The cards already on disk are valid. The orphan-tail truncation that `reconcileCardHistory` performed silently is removed: any orphan tail that exists today on disk (from past abort windows) is left intact — it will be visible to `listCardHistory` and will produce a normal-looking history entry. This is acceptable because (a) orphan entries are real pre-bump snapshots and (b) the project guideline explicitly forbids migration code; a `saivage reset` is the operator path if any stale shape is unacceptable.

### Failure modes considered

- **Crash between step 3 and step 4**: history has an entry for a `version_seq` that the by-id record never reaches. On next read, that entry's `version_seq == current.version_seq`. `getCardAt` for that seq would return the snapshot, which differs from the current by-id record only in the fields that were going to change. This is a real but bounded ghost. Detection: on `validatePersistedState`, fail loudly if any history entry has `version_seq >= card.version_seq`. NO automatic truncation. The operator must `saivage reset` or hand-edit. This is consistent with the architecture-first guideline: silent recovery is worse than loud failure.
- **Lock contention between two processes**: per-card lock means contention only blocks two callers mutating the SAME card, not the whole project. Use `withLock` (async, with retry) — NOT `withLockSync` — so contended callers wait instead of throwing.
- **fsync of the JSONL fails**: throw; do not proceed to the rename.

### Test strategy

- Existing [tests/utils/card-history.test.ts](../../../tests/utils/card-history.test.ts) cases stay green. Replace the `beforeTrackedCardRename: () => { throw }` injection ([tests/utils/card-history.test.ts:69](../../../tests/utils/card-history.test.ts#L69)) with a new injection point that throws BETWEEN steps 3 and 4, then assert that on reopen the store throws a clear invariant error (not silent truncation). Delete the existing "drops only trailing orphan history lines on reopen" case and the "drops trailing orphan history entries" case ([tests/utils/card-history.test.ts:66-117](../../../tests/utils/card-history.test.ts#L66-L117)) — they test behaviour that is intentionally removed.
- Add a concurrency test: two `mutateCard` calls on the same id from two threads (or `Promise.all` with the async lock) succeed serialised and produce two consecutive history lines.
- Add a route-level test: POST `/api/cards/<id>` with a tracked field change, then GET `/api/cards/<id>/history`, expect one entry.

### What this does NOT fix

- The `update()`/`setStatus()` silent-mutation path remains. `cards.update` keeps routing tracked fields to `mutateCard` and untracked fields to `update`, so the wire-level operator surface is unaffected. Internal callers (`runtime.ts`, `planner-tools.ts`, `artifacts.ts`) keep using `update()` for fields like `result`, `error`, `status`, `artifacts`, `attachments` — and those changes will still not appear in history. That is in scope for F13 and F20 follow-ups, not for F12.

## Proposal B — One level up: collapse mutation paths, introduce a single `CardTransaction`, and make history the audited single source of truth for mutations

### Intent

Subsume Proposal A AND address F13's atomicity gap by treating the card store as a write-ahead-log + projections system, with the projections being IN-PROCESS REBUILD-ON-DEMAND from the by-id files plus the history file. The `update()` vs `mutateCard()` API split is removed. There is exactly one mutation entry point, and every mutation produces a history line.

### Data model

At rest:

- `<projectRoot>/.saivage/cards/by-id/<id>.json` — canonical card record (kept; this is the latest snapshot).
- `<projectRoot>/.saivage/cards/history/<id>.history.jsonl` — append-only audit log of every mutation, regardless of whether the operator considers the changed fields "tracked".
- `<projectRoot>/.saivage/cards/locks/<id>.lock` — per-card advisory lock.

At rest, REMOVED:

- `<projectRoot>/.saivage/cards/index.json` is regenerated at runtime from the by-id files. It becomes a non-authoritative cache. Two viable variants:
  - **B.1 (recommended):** drop the file entirely; build the in-memory index by globbing `by-id/*.json` at startup and on demand. F13's invariant check becomes "graph parsed from by-id files is acyclic + within max depth" — there is nothing for it to drift from.
  - **B.2:** keep the file as a cache, rebuilt from by-id on every mutation under the per-card lock. F13's invariant check stays but never fires because index is derived.
- `<projectRoot>/.saivage/cards/dependencies/depends-on.json` and `blocks.json` are likewise regenerated from `card.depends_on` (and inverted for `blocks`). Both files deleted in B.1, kept-as-cache in B.2.

### Write path

A single new method `CardStore.applyMutation(id, patch, ctx): CardRecord` replaces `update`, `mutateCard`, `updateDependsOn`, `setStatus`, `activateGoal`. Steps:

1. Validate transition / structural rules (existing helpers extracted from `validateMutablePatch`).
2. Acquire `cards/locks/<id>.lock` via `withLock` (async).
3. Compute the prune (`prunePartialPatch`); if empty, release lock and return existing.
4. Build the history entry from the FULL diff (every field that changes, not only `TRACKED_FIELDS`). `version_seq` is `existing.version_seq` (pre-bump).
5. Append the history line (`O_APPEND|O_CREAT`, fsync).
6. Build the next card record with `version_seq = existing.version_seq + 1`.
7. Write the next by-id record (`tmp` + rename, fsync the parent dir).
8. In B.2, refresh `cards/index.json` and `depends-on.json`/`blocks.json` from in-memory state (tmp+rename each).
9. Release the lock.

Rollback on step 7 failure: truncate the JSONL back to its pre-step-5 byte length.

`TRACKED_FIELDS` is deleted. Every mutation is tracked. The operator API distinction "tracked vs untracked" disappears.

### Read path

- `read(id)`: read by-id file (unchanged shape).
- `list()`: glob `by-id/*.json` (B.1) or read `index.json` cache (B.2).
- `listChildren`, `descendantsOf`, `getAncestors`: build/return from in-memory graph, which is rebuilt from by-id files on demand.
- `listCardHistory`: read JSONL (unchanged).
- `getCardAt(id, seq)`: if `seq == current.version_seq`, return by-id; else search JSONL.
- `diffCard`: unchanged, on top of `getCardAt`.

### Call-site changes

Every call site that uses `update()`, `setStatus()`, `updateDependsOn()` is rewritten to call `applyMutation()`:

- [src/runtime/runtime.ts](../../../src/runtime/runtime.ts) — sites at lines 266, 278, 483, 635, 644, 645, 663, 725, 737, 740, 779, 780.
- [src/tools/planner-tools.ts](../../../src/tools/planner-tools.ts) — sites at lines 163, 178, 209, 220, 221, 286, 295, 298, 307.
- [src/cards/artifacts.ts](../../../src/cards/artifacts.ts) — sites at lines 113, 188, 280, 326.
- [src/cards/card-store.ts](../../../src/cards/card-store.ts) — internal `setStatus`, `activateGoal`, `updateDependsOn` rewritten in terms of `applyMutation`.
- [src/server/routes/operator-contracts.ts:155](../../../src/server/routes/operator-contracts.ts#L155) — `cards.update` collapses to a single `applyMutation` call; the `tracked ? mutateCard : update` branch is deleted.

`CardMutationContext` becomes mandatory on every call. Internal sites that today omit it (e.g. `update({status:'running'})` from runtime) must pass `{actor: 'runtime', surface: 'runtime', reason: 'execution started'}` or equivalent. This is intentional: it forces the audit signal at every mutation site.

### Dead-code removal (mandatory per project guideline)

The following are DELETED in B (not deprecated, not shim-wrapped):

- `appendHistoryEntry` method ([src/cards/card-store.ts:543-552](../../../src/cards/card-store.ts#L543-L552)) — emit is no longer the write mechanism.
- `reconcileCardHistory` method ([src/cards/card-store.ts:537-550](../../../src/cards/card-store.ts#L537-L550)) — orphan tails are an invariant violation, not a recoverable state.
- `CardHistoryProjection` class and `registerCardHistoryProjection` function ([src/projections/ledger-projections.ts:107-122](../../../src/projections/ledger-projections.ts#L107-L122), [src/projections/ledger-projections.ts:166-168](../../../src/projections/ledger-projections.ts#L166-L168)) — no longer subscribed.
- `card_history_record_appended` event kind from [src/events/registry.ts:65](../../../src/events/registry.ts#L65) — no remaining emitter or subscriber.
- The `update` and `mutateCard` methods on `CardStore` ([src/cards/card-store.ts:794-883](../../../src/cards/card-store.ts#L794-L883)) — collapsed into `applyMutation`.
- `TRACKED_FIELDS` constant ([src/cards/card-store.ts:204-222](../../../src/cards/card-store.ts#L204-L222)).
- `TRACKED_UPDATE_FIELDS` in [src/server/routes/operator-contracts.ts:15](../../../src/server/routes/operator-contracts.ts#L15) and the `tracked` branching at [src/server/routes/operator-contracts.ts:155](../../../src/server/routes/operator-contracts.ts#L155).
- `CardStoreTestHooks` ([src/cards/card-store.ts:51-53](../../../src/cards/card-store.ts#L51-L53)) and its `beforeTrackedCardRename` injection — replaced by a single `beforeByIdRename` hook on `applyMutation`.
- The `eventBus` constructor parameter on `CardStore` ([src/cards/card-store.ts:328-341](../../../src/cards/card-store.ts#L328-L341)) and its single caller in [src/runtime/runtime.ts:108](../../../src/runtime/runtime.ts#L108). `CardStore` no longer publishes anything; runtime broadcasts (e.g. `card_history_appended` for websocket consumers, [src/cards/card-store.ts:876](../../../src/cards/card-store.ts#L876)) move to a thin wrapper in `ActiveRuntime` that observes `applyMutation` return values and emits on the runtime bus.
- In B.1 specifically: `cards/index.json`, `depends-on.json`, `blocks.json` on-disk files (and their schemas `cardIndexSchema`, `cardChildrenIndexSchema`, `cardDependencyIndexSchema`, `cardBlocksIndexSchema` if unused by anything else). `addToIndex`, `removeFromIndex`, `loadIndex`, `saveIndex`, `loadDependsOn`, `saveDependsOn`, `loadBlocks`, `saveBlocks`, `recomputeBlocks` are all deleted. `HierarchyGraph.build` is rewritten to take only `cards: CardRecord[]` (no `index` parameter) since the index is no longer authoritative.

### Failure modes considered

- Crash between history append and by-id rename: same as Proposal A. Loud invariant failure on next start.
- Concurrent mutation of two different cards: independent per-card locks, no contention.
- A reader (e.g. HTTP request) during a writer's critical section: reader sees pre-mutation by-id and pre-append history (because rename is atomic and the JSONL append is also atomic from a reader's POV when reading whole lines). Acceptable.
- Lock file leakage: `ProjectLock.withLock` already cleans up on `finally`. Per-card lock files in `cards/locks/` accumulate up to one per card but are tiny and only contain pid + timestamp.

### Test strategy

- Delete [tests/projections/ledger-projections.test.ts](../../../tests/projections/ledger-projections.test.ts) cases that exercise `card_history_record_appended` (line 125 and the surrounding case).
- Delete [tests/utils/card-history.test.ts](../../../tests/utils/card-history.test.ts) orphan-recovery cases ([:66-117](../../../tests/utils/card-history.test.ts#L66-L117)). Replace with an invariant-failure test on reopen with an orphan tail.
- Rewrite [tests/utils/card-store.test.ts](../../../tests/utils/card-store.test.ts) update/mutateCard cases against the new `applyMutation` API; every mutation expectation now also asserts a history line.
- Update [tests/agents/card-history-tools.test.ts](../../../tests/agents/card-history-tools.test.ts) only if tool wiring changes (signatures should not).
- New invariant test on startup: corrupt by-id depth/parent, expect loud failure (already exists for F13; tighten now that index is derived in B.1).
- New concurrency test: two `applyMutation` calls on the same id resolve serialised.
- New end-to-end test: simulate executor reporting back through `runtime.ts:725` and assert a history line is written.

### API impact

- Wire endpoint behaviour for `cards.history.list`, `cards.history.get`, `cards.diff` is unchanged. The set of history entries grows because previously-untracked mutations are now recorded — operator-facing change but in the positive direction (better audit).
- `cards.update`: payload unchanged; semantic change is that all fields produce a history line. This is acceptable per project guideline.

### Recommendation

Adopt **Proposal B.1**. Reasoning, mapped to project guidelines:

- "Clean code and proper architecture are the top priority" — B.1 collapses three mutation entry points to one, removes the projection indirection, removes three redundant on-disk index files (which are the literal root cause of F13). A is a patch; B.1 removes the class of bug.
- "Actively REMOVE code supporting old features/structures" — B.1's deletion list is substantial and concrete; A keeps the projection class and the dual-entry-point API.
- "Never apply minimal-change defaults" — A is the minimal change.
- "No helpers/abstractions for one-time operations" — `applyMutation` is the ONE mutation operation, used everywhere; it is not an abstraction over one site.
- "No over-engineering" — B.1 reduces the number of on-disk files and the number of code paths; the per-card lock is a simple advisory file lock already provided by `ProjectLock`.

The plan ([03-plan-r1.md](./03-plan-r1.md)) is written against Proposal B.1.
