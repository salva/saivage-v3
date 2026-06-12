# F12 — Functional analysis (r2)

Supersedes [01-analysis-r1.md](./01-analysis-r1.md). Addresses the 7 analysis points in [01-analysis-review-r1.md](./01-analysis-review-r1.md) and the F13 coordination items in [F13/01-analysis-review-r1.md](../F13-canonical-index-drift/01-analysis-review-r1.md).

## 1. User-visible symptom (restated)

`GET /api/cards/<id>/history` returns `{ "history": [], "total": 0 }` for cards whose by-id `version_seq` is `> 1`. UI Card → History tab renders `"No history entries yet."` permanently. `cards.history.get` consequently returns 404 for every seq and `cards.diff` (see [F21](../F21-diff-rejects-to-last/00-issue.md)) loses its only valid pivot.

## 2. Code paths actually responsible (spot-checked)

The analysis below was re-checked against the current tree.

### 2.1 Tracked mutation: `mutateCard` ([src/cards/card-store.ts#L811-L883](../../../src/cards/card-store.ts#L811-L883))

```
1. validate + build candidate
2. emit 'card_history_record_appended' on this.eventBus     (appendHistoryEntry, L849)
3. testHook beforeTrackedCardRename                          (L850)
4. write by-id tmp + rename to <id>.json with version_seq+1 (L852-855)
5. saveIndex                                                 (L857-868)
6. recomputeBlocks + rebuildGraphStrict                      (L869-873)
7. emit 'card_history_appended' for websocket               (L876)
```

Step 2 is **synchronous** and the projection ([src/projections/ledger-projections.ts#L107-L122](../../../src/projections/ledger-projections.ts#L107-L122)) is registered with `failFast: true` ([src/projections/ledger-projections.ts#L166-L168](../../../src/projections/ledger-projections.ts#L166-L168)), so any projection error propagates out of step 2 and aborts before step 4. The constructor always registers the projection on `this.eventBus` ([src/cards/card-store.ts#L340](../../../src/cards/card-store.ts#L340)), regardless of whether the bus was passed in or created privately.

### 2.2 Untracked mutation: `update`/`setStatus`

`update()` ([src/cards/card-store.ts#L794-L809](../../../src/cards/card-store.ts#L794-L809)) and `setStatus()` ([src/cards/card-store.ts#L1090-L1095](../../../src/cards/card-store.ts#L1090-L1095)) both go through `persistMutation` ([src/cards/card-store.ts#L646-L678](../../../src/cards/card-store.ts#L646-L678)), which preserves `existing.version_seq` (built by `buildUpdatedCard`, L640-643). **They do not bump `version_seq` and they do not append history.**

This is encoded by the suite at [tests/utils/card-history.test.ts#L43](../../../tests/utils/card-history.test.ts#L43) ("update without tracked fields does not append history"); per the F13 reviewer note, this is stale product semantics that needs to change, not just an absent code path.

### 2.3 Mutations beyond `update`/`mutateCard`

Per F13 reviewer item #4, the additional mutation entry points that touch by-id, index, depends-on, blocks, or history are:

- `create()` ([src/cards/card-store.ts#L681-L777](../../../src/cards/card-store.ts#L681-L777)) — writes by-id, index, depends-on; never appends history.
- `delete()` and `archiveAndDeleteSubtree()` (~L917, L965) — remove by-id, index, depends-on, blocks, history file; never append history.
- `updateDependsOn()` (~L1039) — writes by-id, index, depends-on; never appends history.
- `recomputeBlocks()` (~L1042-1051) — writes shared blocks.json without per-card locking.
- `initProjectTree()` ([src/persistence/file-tree.ts#L70-L149](../../../src/persistence/file-tree.ts#L70-L149)) — seeds `cards/index.json`, `depends-on.json`, `blocks.json` independently from any by-id file.

These are F13's territory, but they share the same multi-file write set, so the F12 fix must coordinate with them (see §6 below).

## 3. Corrected root-cause proof for the reported invariant

**Reviewer item #1.** The r1 claim that the silent `update()` path explains `version_seq=4` with empty history is wrong: `update()`/`setStatus()` do not bump `version_seq` (see §2.2). The candidates that can produce a card with `version_seq > 1` and no history line on disk are exhausted below.

Failure matrix (reviewer items #1, #2, #7):

| # | Sequence | Reachable today? | Effect on `version_seq` | Effect on history file |
|---|---|---|---|---|
| A | Projection throws **before** appending (e.g. `LockTimeoutError` from `ProjectLock.withLockSync` on `runtime/project.lock`) | Yes. Same-process re-entrancy or out-of-process holder of `runtime/project.lock`. `withLockSync` is no-retry, throws on first `EEXIST` ([src/persistence/project-lock.ts#L33-L63](../../../src/persistence/project-lock.ts#L33-L63)). | Unchanged (rename never runs). | Unchanged. |
| B | Projection appends + fsyncs, then rename in step 4 throws | Yes if disk full, EROFS, EIO, or a test injection between append and rename. The `appendSync` call writes one full line then releases the lock; subsequent rename failure leaves a real orphan tail. | Unchanged (rename never runs). | One orphan line with `version_seq == card.version_seq` (pre-bump value). |
| C | Process crash between step 2 (append fsynced) and step 4 (rename) | Yes (power loss, SIGKILL, container OOM). | Unchanged. | Same orphan as B. |
| D | Append + rename + index all succeed; subsequent `recomputeBlocks` or `rebuildGraphStrict` throws | Yes, but rare (would require a structurally invalid in-memory graph). | Bumped. | History line present. **Not the symptom.** |
| E | On a later `new CardStore(projectRoot)`, `validatePersistedState` runs `reconcileCardHistory()` ([src/cards/card-store.ts#L554-L568](../../../src/cards/card-store.ts#L554-L568)) and silently truncates every history line whose `version_seq >= card.version_seq` | **Yes, on every construction.** Each HTTP request through `operator-contracts.ts` ([:55](../../../src/server/routes/operator-contracts.ts#L55)) and each agent-side instance ([§2.4 in r1](./01-analysis-r1.md#L24-L41)) build a fresh store and re-run this. | Unchanged. | Lines with `seq >= current` are deleted from disk. |
| F | Cross-process write: agent process writes by-id+rename through its own `CardStore`, but its history projection holds `runtime/project.lock` long enough that another writer in the same process throws | Possible. The lock is project-wide, not card-scoped. | Bumped in the winning process. | Empty in the loser. Loser's by-id was never written, so this does not produce the symptom *for the loser's card*; but interleaving repeats can produce orphans (case C). |

**Conclusion (reviewer item #1):** The reported state — `version_seq > 1` with `loadHistoryEntries(id)` returning `[]` — is reachable today by exactly two production paths:

- **Path B/C followed by Path E**: a crash/throw between append and rename leaves an orphan tail whose `version_seq` equals the pre-rename card `version_seq`. The next `new CardStore` (any HTTP request, any agent) calls `reconcileCardHistory`, which deletes that orphan because `entries[last].version_seq >= card.version_seq`. The card's `version_seq` was *not* bumped, so the symptom in this case is `version_seq` matches the most recent rename that succeeded but history is empty because every preceding committed line is gone too if multiple aborts compounded. (See below for the precise compound case.)
- **Path B with a partial commit history**: the operator audit observed `version_seq=4` (one specific moment). A card reaching `version_seq=4` requires four successful mutateCard cycles. If any one of those cycles failed at step 2 *after* projection write but before rename, the orphan line is *less* than the eventual `current.version_seq` and would not be truncated; but the next successful cycle would write line `seq=N` followed by a rename to `seq=N+1` and that line stays. So `version_seq=4` with truly empty history requires either (a) all four `mutateCard` cycles' history files were deleted/never written (e.g. agent ran under a different `projectRoot`, or the history dir was wiped), or (b) a project reset happened after writes (matches the audit's own caveat in [§5 of r1](./01-analysis-r1.md)).

**The honest statement is therefore (reviewer items #1, #2, #6):**

> *Single-mutation* `version_seq > 1` with empty history cannot be produced by `update()`/`setStatus()` alone. It can be produced by a crash/error between the projection append and the by-id rename (cases B/C), and the empty result on subsequent reads is then guaranteed by `reconcileCardHistory()`'s silent truncation (case E). The observed `project.version_seq=4` with empty history is most plausibly explained by the project having been reset between the audit and the current snapshot (the saivage-v3-getrich-v2 deployment currently shows `project.version_seq=1`), combined with the architectural fact that *no `update`/`setStatus`/`setDependsOn`/`create` call ever writes history* — so all four prior tracked mutations could have come from `mutateCard` and been preserved, then wiped by a reset, while non-`mutateCard` work on the project kept bumping nothing.

## 4. Reproduction & inspection recipe (reviewer item #6)

Run on a freshly-built `saivage-v3` harness (see [.github/skills/saivage-development-validation/SKILL.md](../../../../.github/skills/saivage-development-validation/SKILL.md)):

```bash
PROJECT_ROOT=/work/saivage-v3
ID=project

# 1. Snapshot current by-id
cat "$PROJECT_ROOT/.saivage/cards/by-id/$ID.json" | jq '{id, version_seq, status, title}'

# 2. List existing history file
ls -la "$PROJECT_ROOT/.saivage/cards/history/" 2>/dev/null
test -f "$PROJECT_ROOT/.saivage/cards/history/$ID.history.jsonl" \
  && wc -l "$PROJECT_ROOT/.saivage/cards/history/$ID.history.jsonl" \
  || echo "no history file"

# 3. Raw API responses
curl -fsS "http://10.0.3.112:8080/api/cards/$ID/history" | jq .
curl -fsS "http://10.0.3.112:8080/api/cards/$ID/history/1" | jq .
curl -fsS "http://10.0.3.112:8080/api/cards/$ID/diff?from=1&to=2" | jq .

# 4. Inject orphan: bump by-id version, leave history empty
# (only for reproducing case E; do NOT run on prod data)
jq '.version_seq = 99' "$PROJECT_ROOT/.saivage/cards/by-id/$ID.json" > /tmp/x && \
  mv /tmp/x "$PROJECT_ROOT/.saivage/cards/by-id/$ID.json"
echo '{"card_id":"project","version_seq":99,"snapshot":{},"changed_at":"2026-05-23T00:00:00Z","changed_by_actor":"runtime","changed_by_surface":"runtime","change_reason":null,"changed_fields":["title"],"change_summary":"title"}' \
  >> "$PROJECT_ROOT/.saivage/cards/history/$ID.history.jsonl"

# 5. Touch the store from a fresh process to trigger reconcileCardHistory
curl -fsS "http://10.0.3.112:8080/api/cards/$ID/history" | jq .

# Expectation: orphan line silently disappears from the file; API returns [].
```

The success condition for the fix is: after **any** real mutation (UI form save, agent edit, runtime status change), `GET /api/cards/<id>/history` returns `total > 0` and `max(history[].version_seq) === card.version_seq - 1`.

## 5. Affected API and consumer surfaces (reviewer item #5)

Reader chain that consumes the history file or the contract:

- Contract schema: `CardHistoryListResponseSchema` ([src/contracts/operator-api.ts#L151-L159](../../../src/contracts/operator-api.ts#L151-L159)) — note the `headers: z.record(...)` wildcard, which lets the empty-list response satisfy the schema trivially.
- HTTP route handler: [src/server/routes/operator-contracts.ts#L116-L122](../../../src/server/routes/operator-contracts.ts#L116-L122) (`cards.history.list`); the delegating shell [src/server/routes/cards.ts](../../../src/server/routes/cards.ts) still mounts `/api/cards/:id/history`.
- Web HTTP client: [web/src/api/client.ts#L183-L193](../../../web/src/api/client.ts#L183-L193) (`fetchCardHistory`, `fetchCardHistoryEntry`, `fetchCardDiff`).
- Web Pinia store: [web/src/stores/cards.ts#L307-L317](../../../web/src/stores/cards.ts#L307-L317) (cache + invalidation).
- Web components: card history panel + analyst filter (see [web/src/__tests__/card-history-panel.test.ts](../../../web/src/__tests__/card-history-panel.test.ts) for mocks).
- Analyst tools: [src/agents/analyst-tools.ts#L120-L144](../../../src/agents/analyst-tools.ts#L120-L144) — `TRACKED_EDIT_FIELDS` duplicates the tracked/untracked split and consumes the history list via the agent tool registration.
- Agent tools: [src/tools/agent-tools.ts#L103-L121](../../../src/tools/agent-tools.ts#L103-L121) — registers `cards.history.list` and `cards.history.get` for planner/analyst.
- Schemas/types: history schemas exported from [src/schemas/index.ts](../../../src/schemas/index.ts), [src/schemas/types.ts](../../../src/schemas/types.ts); tested in [tests/schemas.test.ts](../../../tests/schemas.test.ts).
- Mutation call sites currently misclassified in r1 — adding `analyst-stage6.ts` ([:114](../../../src/agents/analyst-stage6.ts#L114), [:132-188](../../../src/agents/analyst-stage6.ts#L132-L188)), `analyst-tools.ts` ([:121-144](../../../src/agents/analyst-tools.ts#L121-L144)), `analyst-handler.ts` ([:444](../../../src/agents/analyst-handler.ts#L444)).

## 6. Architectural debt vs. demonstrated cause (reviewer item #4)

The `TRACKED_FIELDS` split ([src/cards/card-store.ts#L204-L222](../../../src/cards/card-store.ts#L204-L222)), the `TRACKED_UPDATE_FIELDS` shadow in routes ([src/server/routes/operator-contracts.ts#L15](../../../src/server/routes/operator-contracts.ts#L15)), and the `TRACKED_EDIT_FIELDS` copy in analyst tools ([src/agents/analyst-tools.ts#L120-L121](../../../src/agents/analyst-tools.ts#L120-L121)) are **architectural debt that drops audit signal**. They do **not** by themselves produce a `version_seq` bump without a history entry. They are listed here so the design and plan address them, but the analysis no longer asserts they cause the reported invariant.

## 7. Startup reconciliation as a first-class data-loss behaviour (reviewer item #7)

`reconcileCardHistory()` ([src/cards/card-store.ts#L554-L568](../../../src/cards/card-store.ts#L554-L568)) silently rewrites `<id>.history.jsonl` on every `new CardStore(projectRoot)`:

- Trigger: called from `validatePersistedState()`, which runs once per `CardStore` instance.
- Behaviour: pops every trailing entry with `version_seq >= card.version_seq` and overwrites the file via `writeFileSync` (not even temp+rename).
- Logging: a single `console.warn`, no event, not surfaced to `errors.jsonl`.
- Reachable from: HTTP request handlers (each constructs a private store), analyst tools, agent adapter, notification triggers — i.e. every interactive surface. So even one transient orphan tail is **erased on the first read after the abort**, which is exactly the symptom the audit observed.

This is the smoking gun that makes Path B/C invisible to operators after the fact and makes the F12 invariant non-reproducible from logs.

## 8. Concurrency/locking claims (reviewer F13 item #1, F12 item #2)

Same-process: every `mutateCard`/`update`/`setStatus`/`persistMutation` body is synchronous and contains no `await` between the by-id rename and the index write. A Fastify handler cannot interleave another mutation on the same event loop between those two `renameSync` calls. The race classes that **are** real:

1. **Crash interruption** between any two of the four fs operations (history append, by-id rename, index rename, depends-on/blocks rewrite). This is what the failure matrix in §3 enumerates.
2. **Cross-process writers** (agent processes spawned by `process-runner` hold their own `CardStore`). Each holds `runtime/project.lock` only during the history append; the by-id, index, depends-on, blocks writes are unlocked.
3. **Synchronous EventBus re-entrancy** from `appendHistoryEntry` ([src/cards/card-store.ts#L543-L552](../../../src/cards/card-store.ts#L543-L552)) — a subscriber that itself mutates a card would observe mid-mutation state. No current subscriber does so, but the surface exists.

The locking discussion in r1 §3.2 stays as a real failure mode for **mutation aborts** and intermittent ghost edits, but is rewritten here to no longer be cited as a direct cause of the empty-history-with-bumped-version invariant (which it cannot produce on its own, because `failFast: true` propagates the lock error out of `mutateCard` before the rename).

## 9. Relation to F13 (reviewer item #3, F13 reviewer items #8/#9)

F12 and F13 **can** be fixed separately:

- F13 in isolation: make the hierarchy graph derive from by-id records; delete the `cards/index.json` ↔ by-id consistency check; F13's reported invariant becomes unrepresentable. This does **not** require touching history at all.
- F12 in isolation: make history append part of the same critical section as the by-id rename (single per-card lock, append-then-rename-or-rollback); delete `reconcileCardHistory`; this does not require touching `cards/index.json` at all.

Both fixes touch [src/cards/card-store.ts](../../../src/cards/card-store.ts), but they touch different methods. They are **not logically inseparable**.

**Stance taken in this r2 (see [02-design-r2.md §Stance on F13](./02-design-r2.md#stance-on-f13)):** F12 subsumes F13 as an **architecture-first choice**, not a logical necessity. The justification is that both bugs are instances of the same anti-pattern (multi-file mutation without a transactional boundary), and fixing them together lets us collapse `update`/`mutateCard`/`setStatus`/`updateDependsOn` into one entry point and delete the redundant index/depends/blocks files in one workstream. Splitting them would either (a) leave dead code between PRs or (b) duplicate the rewrite of `persistMutation` / `mutateCard`. F13's own r2 should reflect that it is subsumed.

## 10. Assumptions still requiring runtime confirmation

- `writeFileAtomic` is rename-based (assumed; not re-verified in this r2). Confirm during implementation; if not, case B widens.
- All agent subprocesses spawned by `process-runner` use the same `projectRoot` as the server. Verified for the one observed history file (`g3-fix-closed-market-walk-forward-filtering`); should be re-verified for analyst, reviewer, and executor roles in §4's reproduction.
- The exact `version_seq=4` audit value is not re-derivable from the current deployment (project was reset). The failure-matrix analysis above stands without it.
