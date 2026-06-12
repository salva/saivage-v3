# F12 — Functional analysis (r1)

## 1. User-visible symptom

`GET /api/cards/<id>/history` returns `{"history": [], "total": 0}` even for cards whose `version_seq` on disk is greater than 1. The Card → History tab in the operator UI consequently renders `"No history entries yet."` for the lifetime of the project. Because `GET /api/cards/<id>/diff` requires concrete `from`/`to` integers that the caller is expected to discover via the history list (see [F21](../F21-diff-rejects-to-last/00-issue.md)), the diff endpoint is also effectively unusable, which removes the only per-card audit trail surfaced to the operator.

Concrete on-disk evidence collected during the audit on the `saivage-v3-getrich-v2` deployment:

- Cards on disk: dozens under [.saivage/cards/by-id/](../../../../) with most at `version_seq=1` and a handful past 1.
- History dir contains exactly ONE history file: `g3-fix-closed-market-walk-forward-filtering.history.jsonl`.
- The corresponding card record has `version_seq=2`. Every other card at `version_seq > 1` (or that was historically at `version_seq > 1` and reset/re-seeded since the audit) has no history file at all.
- Raw response samples: [tmp/saivage-v3-checkers-e2e-artifacts-20260523-phase2/t44-history.json](../../../../tmp/saivage-v3-checkers-e2e-artifacts-20260523-phase2/t44-history.json), [t44-project-history.json](../../../../tmp/saivage-v3-checkers-e2e-artifacts-20260523-phase2/t44-project-history.json), both `{"history":[],"total":0}`.

## 2. What the code actually does today

### 2.1 The contract surface (reader)

- The route is mounted by [src/server/routes/operator-contracts.ts](../../../src/server/routes/operator-contracts.ts) at the contract key `cards.history.list`.
- The handler ([src/server/routes/operator-contracts.ts:116-122](../../../src/server/routes/operator-contracts.ts#L116-L122)) constructs a `CardStore` at module init ([src/server/routes/operator-contracts.ts:55](../../../src/server/routes/operator-contracts.ts#L55)) with `new CardStore(projectRoot)` — no shared `EventBus` is passed, so the constructor falls into the "private bus" branch (see §2.3).
- The handler calls `store.listCardHistory(id)`, maps each entry through `historyHeader` + `redactValue`, and returns `{ history, total: history.length }`. There is no fallback, no projection rebuild, no cross-process read.
- `redactValue` cannot suppress entries (it walks strings); if the file is empty the response is empty.

### 2.2 The reader inside the store

- `listCardHistory` ([src/cards/card-store.ts:881-884](../../../src/cards/card-store.ts#L881-L884)) calls `loadHistoryEntries(id)`, then reverses.
- `loadHistoryEntries` ([src/cards/card-store.ts:522-534](../../../src/cards/card-store.ts#L522-L534)) reads `historyPath(projectRoot, id)` = `<projectRoot>/.saivage/cards/history/<id>.history.jsonl` ([src/cards/card-store.ts:316-318](../../../src/cards/card-store.ts#L316-L318)). If the file does not exist, returns `[]`. If empty, returns `[]`. If it parses but any line fails the schema, it throws. The reader is therefore correct on its own terms: empty response means empty (or absent) file.

### 2.3 The writer

The write path that bumps `version_seq` is `CardStore.mutateCard` ([src/cards/card-store.ts:811-883](../../../src/cards/card-store.ts#L811-L883)). The sequence is:

1. Build a `historyEntry` carrying `version_seq: existing.version_seq` (the pre-bump value) and `snapshot: deepClone(existing)` ([src/cards/card-store.ts:836-846](../../../src/cards/card-store.ts#L836-L846)).
2. Call `appendHistoryEntry(parsedHistory.data)` ([src/cards/card-store.ts:849](../../../src/cards/card-store.ts#L849)). This does NOT touch the filesystem. It only emits a `card_history_record_appended` event on `this.eventBus` ([src/cards/card-store.ts:543-552](../../../src/cards/card-store.ts#L543-L552)).
3. Atomically rename the by-id file with `version_seq = existing.version_seq + 1` ([src/cards/card-store.ts:850-855](../../../src/cards/card-store.ts#L850-L855)).
4. Rewrite `cards/index.json`, depends-on, blocks, then rebuild the in-memory graph ([src/cards/card-store.ts:857-873](../../../src/cards/card-store.ts#L857-L873)).
5. Emit `card_history_appended` (the broadcast-facing event, distinct from the `_record_appended` projection trigger).

The actual history file write is performed by `CardHistoryProjection.apply` ([src/projections/ledger-projections.ts:107-122](../../../src/projections/ledger-projections.ts#L107-L122)). The projection:

- Constructs a fresh `ProjectLock(runtimeLock(projectRoot))` per call — i.e. `.saivage/runtime/project.lock`, not a card-scoped lock.
- Constructs a fresh `JsonlLedger` per call.
- Calls `lock.withLockSync(handle => ledger.appendSync(handle, parsed))`.

`ProjectLock.withLockSync` ([src/persistence/project-lock.ts:33-63](../../../src/persistence/project-lock.ts#L33-L63)) opens the lock file with `wx`; if the file already exists it throws `LockTimeoutError` immediately (no retry). It also throws if any in-process `activeHandle` or queued `withLock` call exists.

The projection is registered by `CardStore`'s constructor ([src/cards/card-store.ts:340](../../../src/cards/card-store.ts#L340)) via `registerCardHistoryProjection`, which in turn subscribes with `failFast: true` ([src/projections/ledger-projections.ts:166-168](../../../src/projections/ledger-projections.ts#L166-L168) and `registerProjection` at [src/projections/ledger-projections.ts:31-41](../../../src/projections/ledger-projections.ts#L31-L41)). `failFast: true` ⇒ `propagateErrors: true` in `EventBus.subscribeMany`, so handler errors throw out of `emit` ([src/events/bus.ts:176-189](../../../src/events/bus.ts#L176-L189)).

### 2.4 Multiple `CardStore` instances per process

`CardStore` is instantiated separately by:

- `ActiveRuntime` ([src/runtime/runtime.ts:108](../../../src/runtime/runtime.ts#L108)) — receives the shared `EventBus`.
- The HTTP contract layer ([src/server/routes/operator-contracts.ts:55](../../../src/server/routes/operator-contracts.ts#L55)) — private bus.
- `chats-files-debug.ts` ([src/server/routes/chats-files-debug.ts:75](../../../src/server/routes/chats-files-debug.ts#L75)) — private bus.
- `notification-triggers.ts` ([src/notifications/notification-triggers.ts:68](../../../src/notifications/notification-triggers.ts#L68)) — private bus.
- `agent-adapter.ts` ([src/agents/agent-adapter.ts:184](../../../src/agents/agent-adapter.ts#L184), [:385](../../../src/agents/agent-adapter.ts#L385)) — private bus.
- `analyst-stage6.ts` (five sites: [:114](../../../src/agents/analyst-stage6.ts#L114), [:139](../../../src/agents/analyst-stage6.ts#L139), [:169](../../../src/agents/analyst-stage6.ts#L169), [:186](../../../src/agents/analyst-stage6.ts#L186), [:207](../../../src/agents/analyst-stage6.ts#L207)) — private bus.
- `analyst-handler.ts` ([src/agents/analyst-handler.ts:444](../../../src/agents/analyst-handler.ts#L444)) — private bus.
- `analyst-tools.ts` ([src/agents/analyst-tools.ts:75](../../../src/agents/analyst-tools.ts#L75)) — private bus.

Each private-bus instance re-subscribes its own `CardHistoryProjection` to its own bus. Emission of `card_history_record_appended` therefore only ever runs the projection on the same bus that emitted it. Cross-instance fan-out does not happen and is not needed.

### 2.5 The silent `update()` path

`CardStore.update` ([src/cards/card-store.ts:794-802](../../../src/cards/card-store.ts#L794-L802)) and `setStatus` ([src/cards/card-store.ts:1090-1095](../../../src/cards/card-store.ts#L1090-L1095)) take a different branch through `persistMutation` ([src/cards/card-store.ts:651-678](../../../src/cards/card-store.ts#L651-L678)). That branch:

- Preserves `existing.version_seq` (no bump).
- Writes the by-id file via `writeJson` (non-atomic write, no `.tmp`+rename — `writeJson` itself uses `writeFileAtomic`, OK).
- Rewrites `cards/index.json`.
- Does NOT emit any history event.

Many call sites use `update()` for fields that look tracked: `runtime.ts:725` (`status`, `result`, …), `runtime.ts:740` (executor failure), `runtime.ts:644-665` (planner outcome), `planner-tools.ts:163-307` (planner control), `artifacts.ts:113,188,280,326` (artifact/attachment registration). None of these appear in the history file. This is in scope for F12 because it explains how cards reach states that look like "version progressed" from the operator's perspective (e.g. status changed, result accumulated) while no history file ever materialises.

## 3. Why the symptom occurs

There are three independent root causes that all funnel into the empty-history symptom. They must be addressed together; fixing only one leaves the others as latent failure modes.

### 3.1 History appends are non-atomic with the version bump

`mutateCard` emits the history event BEFORE the by-id rename, but the projection write and the rename are unrelated filesystem operations under two unrelated locks (`runtime/project.lock` for the projection, no lock for `writeCard`/`saveIndex`). If the projection fails, `failFast: true` should propagate and abort the rename — but only after `appendSync` has already opened, written, and `fsync`-ed a new line into the history file. If the rename then fails, the history file has an orphan that the next `validatePersistedState` will silently drop via `reconcileCardHistory` ([src/cards/card-store.ts:537-550](../../../src/cards/card-store.ts#L537-L550)). The reverse failure mode (rename succeeds, projection wrote nothing for some reason) leaves a card with `version_seq` bumped and no history line. There is no transaction boundary that prevents either.

### 3.2 The history projection acquires the wrong lock

`CardHistoryProjection.apply` calls `lock.withLockSync(...)` on `.saivage/runtime/project.lock`, which is the same lock the runtime uses for `state.ts:116,129,148`, for `control-actions.jsonl`, and for `notifications`. `withLockSync` does not retry; it throws `LockTimeoutError` on the first `EEXIST`. With `propagateErrors: true`, that error propagates back through `emit` → `mutateCard`, so the mutation is aborted before `writeCard` runs — except that `appendSync` is the FIRST step the projection performs after it does take the lock, so a race where the runtime has the lock briefly first means mutateCard throws and the card is never updated even though nothing was wrong with the mutation itself. From the operator's POV the card just appears unmutated. This explains intermittent "ghost edits" where the UI form posts an update that silently disappears.

### 3.3 `update()` and `setStatus()` bypass history entirely

The audit observation "version_seq=4, history empty" cannot be produced by `mutateCard` alone (because mutateCard's emit+rename are coupled; the projection writing nothing while the rename succeeds is only possible if `propagateErrors` is bypassed — which is not the case). The observation IS reproducible if the runtime called `setStatus` or `update()` multiple times AND `mutateCard` was called once (which threw at the projection step but actually wrote the history line first before throwing — see §3.1). The most common pattern is `update({result, status, error})` from `runtime.ts:725`/`740`/`644-665` after the executor reports back, repeated per planner turn, which silently bumps NOTHING (no version, no history) — but the operator's `version_seq` indicator on the UI conflates "any change happened" with "tracked change happened", so the operator sees the card change without a corresponding history line. The architectural problem is that there is no single mutation entry point with a non-bypassable history append.

## 4. Adjacent affected behaviour

- **UI Card → History tab**: empty forever, audit signal lost (Phase-2 G1/T15–T16).
- **`GET /api/cards/<id>/diff`**: the operator's only way to discover valid `from`/`to` pairs is the history list. With the history empty, the only callable diff is `?from=current&to=current`, which `cards.history.get` rejects with a `Invalid version sequence` 400. Cross-references [F21](../F21-diff-rejects-to-last/00-issue.md).
- **`cards.history.get`**: same store, returns 404 for every seq because the underlying list is empty.
- **`CardHistoryProjection` failures are observable in `errors.jsonl` only via `subscriber_error` events** ([src/events/bus.ts:213-220](../../../src/events/bus.ts#L213-L220)), but only if the error-log projection is registered against the same bus — which is not the case for the private-bus instances created by the route layer and by the agents. Failures from those private-bus projections vanish.
- **`reconcileCardHistory`** silently truncates history on every constructor invocation. Every new `CardStore` instance (i.e. every HTTP request that hits the cards route, every agent tool call) re-runs validation. If there is any orphan tail it disappears.
- **Notifications, control-action audit, and event-log projections share the same lock and the same `failFast: true` policy**. A history-projection abort interrupts the in-progress `EventBus.emit` loop, so any sibling projection registered to the same kind that hadn't yet been delivered is skipped. None of the three currently subscribe to `card_history_record_appended`, but the pattern is fragile.

## 5. Assumptions I cannot verify from the code alone

- The audit screenshot's "version_seq=4 for project" reading was taken at a moment when the live store had that value; the current `saivage-v3-getrich-v2` deployment shows `project` at `version_seq=1`, so either (a) the project was reset between audit and now, or (b) the audit was reading a stale UI cache. Either way the symptom is reproducible from first principles in §3.
- I have not run a synthetic load to confirm that `LockTimeoutError` from the history projection is observed in `errors.jsonl` (the bus subscriber-error path requires the error-log projection on the same private bus, which the route-side store does not have).
- I am assuming `writeFileAtomic` (used by `writeJson`) is in fact rename-based; I did not inspect [src/persistence/atomic-write.ts] (or its sibling). If it is not, §3.1's "rename succeeds, history empty" window widens.
- I am assuming each agent subprocess spawned by `process-runner` reaches the cards directory at `projectRoot/.saivage/cards/` with the same `projectRoot` value the server uses. The lone observed history file (`g3-fix-closed-market-walk-forward-filtering`) was written by an agent, so this assumption holds for at least one agent role; I am not certain it holds for all roles.

## 6. Relation to F13

[F13](../F13-canonical-index-drift/00-issue.md) and F12 share the SAME shared root cause: the card store performs a multi-file mutation (by-id record, `cards/index.json`, history file, depends-on, blocks, in-memory graph) without a transactional write boundary. The F13 invariant `cards/index.json entry for '<id>' does not match by-id record` fires when an `update()`/`mutateCard` writes the by-id file but the index write fails or is observed mid-write by a reader. F12's "version bumped but no history" is the same architectural defect on a different pair of files.

The shared transaction boundary that is missing is: **"all card mutations (by-id, index, history, deps, blocks) for a single `mutateCard` or `update` call must be committed as a single atomic step under a single card-scoped lock, or rolled back together."** Today there is no such boundary; there is a sequence of independent `writeFileAtomic` calls plus an `EventBus.emit` for the history append.

Fixing F13 without fixing F12 is impossible (the history file is part of the same write set). Fixing F12 in a way that does not also fix F13 would require leaving the by-id/index split unprotected, which violates the project's architecture-first guideline. The two issues must be resolved by the same refactor.
