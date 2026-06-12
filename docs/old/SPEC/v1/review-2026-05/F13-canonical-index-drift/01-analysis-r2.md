# F13 — Functional Analysis (r2)

Supersedes [01-analysis-r1.md](01-analysis-r1.md). Rewritten per review items 1-5 in [01-analysis-review-r1.md](01-analysis-review-r1.md).

## Observed failure

`Canonical hierarchy invariant failed: cards/index.json entry for 'project' does not match by-id record.`

- Emitted by `HierarchyGraph.build` in [src/cards/card-store.ts](../../../src/cards/card-store.ts#L73) (`throw` covering lines 73-94 around the equality check between the index projection and the by-id record).
- Observed twice in the same Phase-2 sweep: G1/T20 (`Debug → Errors` panel) and G5/T45 (`errors.jsonl` line 4, ts `2026-05-23 13:51:55`). Both incidents land in a mutation burst that touches the `project` card.
- Steady-state probe G2/T23 reports `cardStoreHealth.canonical = "ok"`. That value is not a live consistency probe — see §"`canonicalHealth` surfaces" below.

## What the code actually does

`CardStore.mutateCard` ([src/cards/card-store.ts](../../../src/cards/card-store.ts#L811)) executes one synchronous block with this on-disk side-effect order:

1. `appendHistoryEntry` → `eventBus.emit('card_history_record_appended', …)` ([src/cards/card-store.ts](../../../src/cards/card-store.ts#L544)) → `CardHistoryProjection.apply` ([src/projections/ledger-projections.ts](../../../src/projections/ledger-projections.ts#L105)) acquires `runtime/project.lock` and `JsonlLedger.appendSync` ([src/persistence/jsonl-ledger.ts](../../../src/persistence/jsonl-ledger.ts#L1)) writes one line to `.saivage/cards/history/<id>.history.jsonl`.
2. `writeFileSync(tmp)` + `renameSync(tmp, by-id/<id>.json)` ([src/cards/card-store.ts](../../../src/cards/card-store.ts#L853-L855)). New `version_seq` is now on disk under `by-id/`.
3. `loadIndex` → mutate `index.cards[id]` → `writeFileAtomic` of `cards/index.json` ([src/cards/card-store.ts](../../../src/cards/card-store.ts#L421), implementation [src/persistence/file-tree.ts](../../../src/persistence/file-tree.ts#L14)).
4. Optional `addToDependsOn` / `saveDependsOn` → `cards/dependencies/depends-on.json` (atomic).
5. `recomputeBlocks` → `cards/dependencies/blocks.json` (atomic).
6. `rebuildGraphStrict` ([src/cards/card-store.ts](../../../src/cards/card-store.ts#L440)) re-reads index + every by-id record and runs `HierarchyGraph.build`. On mismatch it throws and sets `canonicalHealth='invalid'`; on success it sets `canonicalHealth='ok'`.
7. `eventBus.emit('card_history_appended', …)` ([src/cards/card-store.ts](../../../src/cards/card-store.ts#L876)) — observability only, no disk write.
8. `enqueueCardMutationNotifications`.

`update` and `setStatus` go through `persistMutation` ([src/cards/card-store.ts](../../../src/cards/card-store.ts#L711)) and **skip step 1 entirely**. `create` ([src/cards/card-store.ts](../../../src/cards/card-store.ts#L749)) does `writeCard → addToIndex → addToDependsOn → recomputeBlocks → rebuildGraphStrict`, also no history.

## Failure classes — separated

The full mutation body is synchronous JavaScript with no internal `await`. A normal Fastify handler **cannot** schedule another mutation between steps 2 and 3 on the same event loop; the same applies to all other within-process callers (runtime tick, planner tools, analyst tools). The r1 claim that HTTP reads can "land between step 2 and step 3 of a concurrent mutation" is wrong for same-process callers and is **withdrawn**.

The drift is produced by one of the following classes. They are the only candidates supported by code reading:

### Class 1 — Crash interruption between steps 2 and 3

Process dies (`SIGKILL`, OOM, host reset, `process.exit` triggered by an unrelated error handler) after `renameSync` of `by-id/<id>.json` but before `writeFileAtomic` of `cards/index.json`. On next boot `validatePersistedState` ([src/cards/card-store.ts](../../../src/cards/card-store.ts#L327)) calls `HierarchyGraph.build` which throws the observed message. The throw also sets `canonicalHealth='invalid'`, but the throw is re-raised to the constructor, so the store never serves requests in that state — every subsequent API call surfaces the error or 500.

### Class 2 — Cross-process or out-of-band writer

The host filesystem permits any other process (a CLI tool, an operator hand-editing JSON, a sibling Saivage instance, a backup-restore script) to rewrite either `cards/index.json` or `cards/by-id/<id>.json` without touching the other. `JsonlLedger`'s `ProjectLock` is only held inside the history append (step 1); it is **not** held around steps 2-3. Any such out-of-band write produces exactly the observed log.

### Class 3 — Synchronous event-bus reentrancy from step 1

`eventBus.emit('card_history_record_appended', …)` at [src/cards/card-store.ts](../../../src/cards/card-store.ts#L544) is synchronous. Subscribers run inside `mutateCard`'s call frame before steps 2-3. No current subscriber calls back into `CardStore` mutating methods, but the contract does not forbid it; any subscriber that ever did would write by-id under the still-pre-mutation index.

### Hypothesis only — boot self-heal

r1 claimed crash-interruption residue followed by `performCrashRecovery`-driven `setStatus` writing step 3 of the *next* mutation, producing the "fires once, then disappears" pattern in `errors.jsonl`. Re-reading the constructor: `validatePersistedState` throws *before* the runtime starts, which currently aborts boot rather than allowing a subsequent mutation to overwrite. So the self-heal narrative is **plausible but unproven**. The artifacts only show that the error fired and that a later steady-state probe returned `ok`; they do not prove a controlled crash-then-recover sequence. The plan must include an injected-failure test at the by-id/index boundary that drives the system through this sequence and asserts the precise post-restart behaviour.

## Mutation paths that touch the same canonical/projection files

All of these write more than one of `{by-id/<id>.json, index.json, dependencies/depends-on.json, dependencies/blocks.json, history/<id>.history.jsonl}` and therefore inherit the F13 invariant exposure:

| Path | Files written | History? | Invariants that must hold post-write |
| --- | --- | --- | --- |
| `mutateCard` [card-store.ts#L811](../../../src/cards/card-store.ts#L811) | by-id, index, deps (opt), blocks (opt), history | yes | index entry ≡ by-id; history.last.version_seq == card.version_seq |
| `update` / `setStatus` [card-store.ts#L801](../../../src/cards/card-store.ts#L801), [card-store.ts#L1090](../../../src/cards/card-store.ts#L1090) | by-id, index, deps (opt), blocks (opt) | **no** (F12) | index entry ≡ by-id |
| `create` [card-store.ts#L749](../../../src/cards/card-store.ts#L749) | by-id, index, deps, blocks | no | index entry exists; deps/blocks symmetric |
| `delete` [card-store.ts#L917](../../../src/cards/card-store.ts#L917) | by-id (unlink), index, deps, blocks | no | id absent from all three |
| `archiveAndDeleteSubtree` [card-store.ts#L965](../../../src/cards/card-store.ts#L965) | many by-id (unlink), index, deps, blocks | no | every descendant absent from all three |
| `updateDependsOn` [card-store.ts#L1039](../../../src/cards/card-store.ts#L1039) | deps, blocks; by-id (because deps live in card record) | no | by-id `.depends_on` ≡ `depends-on.json` row |
| `recomputeBlocks` [card-store.ts#L1090](../../../src/cards/card-store.ts#L1090) | blocks | no | blocks derivable from deps + index |
| `initProjectTree` [persistence/file-tree.ts#L148](../../../src/persistence/file-tree.ts#L148) | by-id/project.json, index.json, tree/project.children.json, dependencies/depends-on.json, dependencies/blocks.json | no | all five agree from the first byte written |

Paths that need history semantics under any fix (per F12 expected behavior): `mutateCard`, `update`, `setStatus`, `create`, `delete`, `archiveAndDeleteSubtree`. Dependency-only and block-only paths are debatable — see [03-plan-r2.md](03-plan-r2.md) §F12 closure semantics.

## F12 framing against existing tests

`update` and `setStatus` skip history appends; this is **wrong product semantics**, and the current test suite encodes the wrong behaviour:

- [tests/utils/card-history.test.ts](../../../tests/utils/card-history.test.ts#L43) asserts that an `update()` call produces zero history entries. That test is stale against the desired contract and must be rewritten when F13 lands. It is not merely an absent code path; it is an actively-defended bug.
- [tests/utils/card-store.test.ts](../../../tests/utils/card-store.test.ts) similarly does not assert history-on-status-transition.
- [tests/api/cards-history.test.ts](../../../tests/api/cards-history.test.ts) only exercises `mutateCard` paths.

Cross-references this with F12: F12's reviewer noted the same — "the analysis must either show a concrete code path where the rename can commit without the history projection write, or stop claiming that the silent `update()` path explains the observed `version_seq=4` history-empty state". F12 in its current state is a *direct* consequence of the `update`/`setStatus` history skip plus the absence of any caller that calls `mutateCard` from the runtime lifecycle. F13 and F12 share the architectural defect "card mutations are scattered across multiple files and the history append is opt-in" but they are not the same proximate failure; F13 can fire even when F12 is absent (cross-process writer) and F12 fires on every runtime status transition regardless of F13.

## `canonicalHealth` surfaces

`canonicalHealth` is read through three different surfaces, each with different semantics. r1 conflated them.

- **In-process probe.** `CardStore.getHealth()` ([src/cards/card-store.ts](../../../src/cards/card-store.ts#L461)) returns the in-memory flag. The flag is set to `ok` at the end of every successful mutation regardless of whether earlier mutations failed; it is essentially "did the last mutation succeed". It is the only signal that is up-to-date with the in-memory state.
- **Operator HTTP contract route.** `/api/state` returns the canonical health field as a hard-coded literal `{ canonical: 'ok' }` ([src/server/routes/operator-contracts.ts](../../../src/server/routes/operator-contracts.ts#L88)). This is unconditionally `ok` and does not look at the store. It is therefore **false** as a health signal and explains the G2/T23 observation: the probe was reading a constant, not a check.
- **Websocket snapshot.** `src/server/websocket.ts` line 95 ([src/server/websocket.ts](../../../src/server/websocket.ts#L95)) calls `activeRuntime.runtime.cardStore.getHealth()` and embeds it in the snapshot envelope. This is a real read of the in-memory flag, but inherits the "last-mutation-succeeded" weakness.

Any fix must decide what `canonicalHealth` means or delete it. The current hard-coded literal in operator-contracts is misleading enough that operators cannot trust the value; under architecture-first, the field is dead weight and should be removed entirely. See [03-plan-r2.md](03-plan-r2.md) §Deletion inventory.

## Adjacent affected behaviour

- **F12.** Shared root architecture: scattered authoritative files, opt-in history. F13 plan subsumes F12 once history becomes mandatory for `update`/`setStatus`/`create`/`delete`/`archive`.
- **F19 (`runtime` pinned to failed card), F20 (executor false-failed), F23 (illegal `failed→active`).** Each calls `cardStore.update` / `setStatus` from the runtime lifecycle. Touching `setStatus` semantics (history appends, atomic commit, lock scope) changes the audit trail visible to those issues' tests. See [03-plan-r2.md](03-plan-r2.md) §Coordination.
- **Operator reads.** Same-process reads do not race with same-process writes (sync mutation body). Cross-process or boot-time reads still observe the partial pair when class 1 or 2 has happened.
- **Projection rebuild from history.** Today's `cards/history/*.history.jsonl` is incomplete (F12). It cannot be used to rebuild the by-id state.
- **`reconcileCardHistory`.** Runs on every constructor ([src/cards/card-store.ts](../../../src/cards/card-store.ts#L552)) and **rewrites** the history file when `entry.version_seq >= card.version_seq`. This is a silent data-loss path on boot after a crash between steps 1 and 2.

## Assumptions still unverified by code reading alone

- Whether a controlled `SIGKILL` between steps 2 and 3 reliably produces the observed `errors.jsonl` line on the next boot. Must be proven by the injected-failure test the plan requires.
- Whether any current subscriber to `card_history_record_appended` re-enters the store. Static reading of [src/cards/notifications/index.ts](../../../src/cards/notifications/index.ts) shows none, but a grep over all `eventBus.on('card_history_record_appended')` registrations is still required.
- Whether out-of-band processes ever write into `.saivage/cards/`. Operator playbook says no, but the lock scope does not enforce it.
