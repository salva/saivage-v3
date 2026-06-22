# F13 — Functional Analysis (r1)

## Observed failure

`Canonical hierarchy invariant failed: cards/index.json entry for 'project' does not match by-id record.`

- Emitted by [src/cards/card-store.ts](../../../src/cards/card-store.ts) line 87 inside `HierarchyGraph.build`.
- First observed in Phase-2 G1/T20 (Debug → Errors panel) during the post-create mutation burst, then re-observed in G5/T45 at `errors.jsonl` line 4 timestamped `2026-05-23 13:51:55`.
- Steady-state probe G2/T23 reports `cardStoreHealth.canonical = "ok"` — the in-memory health flag is reset to `ok` by the next successful `rebuildGraphStrict()` call (see [src/cards/card-store.ts](../../../src/cards/card-store.ts) line 451), so the operator API surface lies about the actual transient inconsistency window.

## Current write sequence for a tracked card mutation

Path: `CardStore.mutateCard(id, changes, ctx)` — [src/cards/card-store.ts](../../../src/cards/card-store.ts) line 811.

Order of side effects against disk (every step is synchronous; there is no surrounding lock):

1. `appendHistoryEntry(parsedHistory.data)` ([src/cards/card-store.ts](../../../src/cards/card-store.ts) line 547) emits `card_history_record_appended` on the in-process `EventBus`.
   - `CardHistoryProjection.apply` ([src/projections/ledger-projections.ts](../../../src/projections/ledger-projections.ts) line 105) acquires the runtime `ProjectLock` and `JsonlLedger.appendSync` writes one line to `.saivage/cards/history/<id>.history.jsonl`.
2. `writeFileSync(tmpPath, ...)` + `renameSync(tmpPath, by-id/<id>.json)` ([src/cards/card-store.ts](../../../src/cards/card-store.ts) lines 853-855) — atomic for that single file. New `version_seq` lives here.
3. `loadIndex()` reads `cards/index.json` from disk, mutates `index.cards[id]`, `saveIndex(index)` writes it back via `writeFileAtomic` ([src/cards/card-store.ts](../../../src/cards/card-store.ts) line 421, `writeFileAtomic` at [src/persistence/file-tree.ts](../../../src/persistence/file-tree.ts) line 14) — atomic for that single file.
4. If `depends_on` changed: `addToDependsOn` or `saveDependsOn(deps)` writes `.saivage/cards/dependencies/depends-on.json` (atomic per file).
5. `recomputeBlocks()` reads deps + index, rebuilds and writes `.saivage/cards/dependencies/blocks.json` (atomic per file).
6. `rebuildGraphStrict()` re-reads index, re-reads every by-id record, calls `HierarchyGraph.build`, raises the invariant on mismatch.
7. `eventBus.emit('card_history_appended', …)` (notification only, no disk write).
8. `enqueueCardMutationNotifications(...)` writes notification records via its own ledger.

`CardStore.update` / `setStatus` (used by the runtime path — [src/runtime/runtime.ts](../../../src/runtime/runtime.ts) lines 266, 278, 483, 614, 644, etc.) follow the same shape via `persistMutation` ([src/cards/card-store.ts](../../../src/cards/card-store.ts) line 711) but skip step 1 entirely. That is the proximate cause of [F12](../F12-card-history-empty/00-issue.md): runtime-driven status transitions never produce a history entry.

`create` ([src/cards/card-store.ts](../../../src/cards/card-store.ts) line 749) executes `writeCard → addToIndex → addToDependsOn → recomputeBlocks → rebuildGraphStrict` — same multi-file pattern, no history at all.

## Race / partial-write windows

The runtime is single-process and the entire mutation body is synchronous, so two `mutateCard` invocations cannot interleave inside the Node event loop. The drift is therefore not a classical thread race. The real failure modes are:

- **Crash between steps 2 and 3.** `by-id/<id>.json` now carries `{title:'new', status:'new', version_seq:N+1}` while `cards/index.json` still carries the previous projection. Next boot, `validatePersistedState` ([src/cards/card-store.ts](../../../src/cards/card-store.ts) line 327) calls `HierarchyGraph.build`, throws line 87, sets `canonicalHealth='invalid'`, and the entire `CardStore` becomes unusable until manual intervention. The audit log entry is consistent with this: the message fires during a mutation burst on `project`, exactly the window where `version_seq` bumps and `title`/`status` flip together.
- **Crash between steps 1 and 2.** History gets an entry for `version_seq = N` (the pre-mutation snapshot) but the by-id record on disk is still at `N`. Next boot, `reconcileCardHistory` ([src/cards/card-store.ts](../../../src/cards/card-store.ts) line 552) drops the trailing entry because `entry.version_seq >= card.version_seq`. Operator audit trail loss; no invariant error.
- **Crash between steps 3 and 5.** Index and by-id agree, but `depends-on.json` / `blocks.json` lag. `recomputeBlocks` on next mutation rebuilds them; no visible error, but `getBlocks` reads stale data in the interim.
- **Crash between steps 2 and 3 followed by step-2 retry on next mutation.** When the store loads after restart the `validatePersistedState` throws; if the throw is caught and the next mutation runs anyway (which is what the audit observes — `setStatus` from `performCrashRecovery` runs at boot, see [src/runtime/runtime.ts](../../../src/runtime/runtime.ts) line 614), step 3 of that mutation overwrites the stale index entry and "self-heals" the file pair. The invariant error therefore appears once in `errors.jsonl` and disappears, which exactly matches the G5/T45 evidence.
- **Reentrant mutation triggered by step 1.** The synchronous `eventBus.emit` invokes notification handlers ([src/cards/notifications/index.ts](../../../src/cards/notifications/index.ts)) which can themselves call `cardStore.read`. None currently call mutating APIs, but the contract does not forbid it; the design is one event-bus subscriber away from a real reentrancy bug.

## Where the invariant validator runs and why `canonicalHealth` returns to `ok`

- `validatePersistedState` runs once via `ensurePersistedStateValidated` on the first read/write after boot. Sets `canonicalHealth='invalid'` on failure, but also re-throws — so the caller observes the error before ever reading the flag.
- `rebuildGraphStrict` runs at the **end** of every successful mutation (`mutateCard`, `persistMutation`, `create`, `delete`, `archiveAndDeleteSubtree`). On success it sets `canonicalHealth='ok'`, overwriting any previous `'invalid'` marker.
- There is no scheduled validator and no "currently consistent vs historically consistent" distinction. `cardStoreHealth.canonical` is just "did the last mutation succeed?" — a meaningless health signal for an operator. G2/T23 reading `ok` is therefore expected even seconds after `errors.jsonl` logged an invariant failure: a subsequent successful mutation flipped the flag back. The probe is not falsified evidence of consistency; it is a wrongly-scoped probe.

## Adjacent affected behaviour

- **F12 (card history empty).** `update` and `setStatus` write the by-id record and the index but never emit `card_history_record_appended`. Every runtime status transition (`backlog → active → running → done/failed`) is invisible to `listCardHistory`. `reconcileCardHistory` then drops any history entries whose `version_seq` is `>= card.version_seq` — which, because `update` does **not** bump `version_seq`, is none — but the absence of any append in the first place is the bug. F13 and F12 share the same root architectural defect: card mutations are scattered across multiple files with no single transactional boundary, and the history path is opt-in instead of mandatory.
- **Operator reads racing with writes.** `/api/cards` ([src/server/routes/cards.ts](../../../src/server/routes/cards.ts)) calls `cardStore.list()` which reads the index then per-id files. There is no cross-file snapshot read; an HTTP request landing between step 2 and step 3 of a concurrent mutation observes the new by-id record under the old index entry. This is silent: it does not throw, it just returns inconsistent data to the dashboard.
- **Projection rebuild.** `registerCardHistoryProjection` ([src/projections/ledger-projections.ts](../../../src/projections/ledger-projections.ts) line 166) is the only projection that writes a per-card ledger. If we ever needed to rebuild the index from the history ledger we cannot, because `update`/`setStatus`/`create`/`delete` paths skip the history append; the ledger is not a complete log.
- **Replication / future multi-process.** Three independent atomic writes across three files plus the assumption that no other process holds the file means any future split (CLI tool writing while the server is up, distributed worker, etc.) immediately races. The current `ProjectLock` is held only inside the projection write, not around the multi-file mutation.

## Assumptions not verified from code

- That Fastify route handlers never call `cardStore.mutateCard` from inside an `await`-boundary where another handler could schedule a competing mutation onto the next microtask tick. The bodies of the mutation methods are sync, but their *callers* may be async — verified only by static read of `runtime.ts`, not exhaustively across all routes.
- That `process.exit` / `SIGKILL` between steps 2 and 3 actually produces the audit's invariant log on next boot. Reproduction was not attempted; the audit only shows the error occurred, not a controlled crash sequence.
- That no test currently exercises a forced crash between the two writes. `tests/cards/*` (not enumerated here) likely cover the happy path only.
- That `EventBus.emit` is fully synchronous for `card_history_record_appended` listeners — read confirms `subscribeMany` registers a sync callback and `apply` returns `void`, but the bus implementation in [src/events/index.ts](../../../src/events/index.ts) was not re-verified for this analysis.
