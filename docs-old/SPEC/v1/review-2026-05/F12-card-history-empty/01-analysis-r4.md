# F12 — Functional analysis (r4, closure mode)

Supersedes [01-analysis-r3.md](./01-analysis-r3.md). Addresses [01-analysis-review-r3.md](./01-analysis-review-r3.md): replaces all stale F13 r2 / "to be re-emitted as r3" references with direct pointers to the F13 r3 documents, narrows Appendix A's claim to "proves the invariant is violable" (not "always reproduces the live empty-history observation"), and moves the destructive scratch path inside the `saivage-v3` container.

The orchestrator-binding history-row semantics adopted by both F12 r4 and F13 r4 are: **a history row with `version_seq = N` is the snapshot taken BEFORE the mutation that bumps the card to `version_seq = N+1`.** Therefore for any mutated card `max(history[].version_seq) === card.version_seq - 1` and `history.total >= card.version_seq - 1`. This matches [tests/utils/card-history.test.ts](../../../tests/utils/card-history.test.ts).

## 1. User-visible symptom

`GET /api/cards/<id>/history` returns `{ "history": [], "total": 0 }` for cards whose by-id `version_seq` is `> 1`. The UI Card → History tab renders `"No history entries yet."` permanently. `cards.history.get` then 404s on every seq, and `cards.diff` (see [F21](../F21-diff-rejects-to-last/00-issue.md)) loses its only valid pivot.

## 2. Verified failure mechanism (narrowed)

Three claims are kept; everything else from r2 is dropped as either covered by F13 or unverifiable from the live deployment.

### 2.1 Proven code defects (these will be removed by F13)

- **Silent history truncation on every store construction.** `reconcileCardHistory()` ([src/cards/card-store.ts#L554-L568](../../../src/cards/card-store.ts#L554-L568)) is invoked from `validatePersistedState()` on every `new CardStore(projectRoot)` and pops every trailing history line with `version_seq >= card.version_seq`, then `writeFileSync`s the result. No event, no `errors.jsonl` entry, no temp+rename. Each operator HTTP request constructs a fresh store ([src/server/routes/operator-contracts.ts#L55](../../../src/server/routes/operator-contracts.ts#L55)), so any orphan tail is erased on the next read.
- **Multi-file mutation without a transactional boundary.** `mutateCard` ([src/cards/card-store.ts#L811-L883](../../../src/cards/card-store.ts#L811-L883)) writes the history line via the synchronous `CardHistoryProjection`, then renames `<id>.json`, then writes `cards/index.json`, then writes `depends-on.json`/`blocks.json`. There is no rollback if step N fails after step N-1 committed; combined with §2.1 above this turns "history append survived, by-id rename crashed" into "orphan line silently deleted on next read".
- **Architectural debt: untracked update path.** `update()` ([src/cards/card-store.ts#L794-L809](../../../src/cards/card-store.ts#L794-L809)) and `setStatus()` ([src/cards/card-store.ts#L1090-L1095](../../../src/cards/card-store.ts#L1090-L1095)) go through `persistMutation` ([src/cards/card-store.ts#L646-L678](../../../src/cards/card-store.ts#L646-L678)), which preserves `existing.version_seq` and never appends history. This is a coverage gap for the audit log but is **not** by itself a producer of the `version_seq > 1` + empty-history state, because these calls also do not bump `version_seq`.

### 2.2 Synthetic crash / orphan behaviour (reproducible only by injection)

A persisted state with `version_seq > 1` and an empty `history/<id>.history.jsonl` is reachable today only via:

1. **Path B** — history append + fsync succeeds, then `<id>.json` rename fails (disk full, EROFS, EIO, or test injection). The orphan history line has `version_seq == card.version_seq` at append time (pre-bump in the new model: it records the snapshot BEFORE the never-completed bump). On the next `new CardStore`, `reconcileCardHistory` silently truncates it.
2. **Path C** — process crash (SIGKILL, OOM, power loss) between history fsync and `<id>.json` rename. Same outcome as B after the next construction.
3. **Compound** — several B/C events in series followed by reconciliation can erase multiple committed history lines if the orphan tail re-truncates earlier lines whose `version_seq` is still `>= card.version_seq` post-rollback (because the rename never bumped).

None of these is observable from logs (single `console.warn` only), which matches the audit reporter's "history empty, version_seq bumped" observation.

### 2.3 Audit observation that is no longer directly reproducible

The original audit recorded `project.version_seq = 4` on the live `saivage-v3-getrich-v2` deployment with an empty `/api/cards/project/history`. The current deployment shows `project.version_seq = 1` (the project was reset between the audit and r2 verification). The audit's exact `version_seq = 4` value therefore cannot be re-derived. What can be re-derived: the code paths in §2.1/§2.2 still exist on `main`, and the synthetic recipe in Appendix A proves the acceptance invariant is violable (it constructs a `version_seq > 1` / empty-history state on demand); it does not, however, reproduce the live audit observation step-for-step on every run.

## 3. Decision — F12 is subsumed by F13

The F12 r2 design and F13 r2 design picked incompatible architectures over the same code surface (`src/cards/card-store.ts`, history projection, derived index/deps/blocks files, locking model, event ownership). Per orchestrator decision:

- **F13 r3 is the umbrella** (see [F13 01-analysis-r3.md](../F13-canonical-index-drift/01-analysis-r3.md), [F13 02-design-r3.md](../F13-canonical-index-drift/02-design-r3.md), [F13 03-plan-r3.md](../F13-canonical-index-drift/03-plan-r3.md)). It owns `applyMutation`, the deletion of `cards/index.json` / `depends-on.json` / `blocks.json`, the deletion of `reconcileCardHistory`, the deletion of `CardHistoryProjection` and `card_history_record_appended`, the per-card crash-safety contract, and the locking model.
- **F12 r4 retains only its acceptance shape** (see §4 below) and the F12-specific consumer surfaces F13 must cover (see [02-design-r4.md](./02-design-r4.md)).
- **No competing F12 implementation plan exists.** [03-plan-r4.md](./03-plan-r4.md) contains no independent steps; it points to the F13 r3 plan and lists the acceptance tests F13 must include.

The binding architecture decisions absorbed from F12 r2 into F13 (already reflected in the F13 r3 documents): **delete the derived files entirely** (no projections-writer; no `cards/tree/<id>.children.json`), **single per-project mutation mutex** (not per-card), **commit markers carry `entry_id` and `kind`** on history entries.

## 4. F12 acceptance shape (binding, F13 must satisfy)

For any card that has been mutated at least once since creation, with the orchestrator-binding semantics "row `version_seq = N` is the pre-mutation snapshot for the bump to `N+1`":

- `GET /api/cards/<id>/history` returns `total >= 1`.
- `history.total >= card.version_seq - 1` (every bump produced an entry).
- `max(history[].version_seq) === card.version_seq - 1` (no missing tail; the latest entry corresponds to the pre-last-mutation snapshot).
- `GET /api/cards/<id>/history/<seq>` returns the historical snapshot for every `seq` in `[1, card.version_seq - 1]` (no 404 in that range).
- `GET /api/cards/<id>/diff?from=1&to=2` returns a non-empty `changed_fields` list whenever a real field differs.
- The websocket `card_history_appended` event ([src/events/registry.ts#L58](../../../src/events/registry.ts#L58), [src/contracts/operator-events.ts#L110-L119](../../../src/contracts/operator-events.ts#L110-L119), [src/server/websocket.ts#L303](../../../src/server/websocket.ts#L303)) fires exactly once per `applyMutation` that bumps `version_seq`.

## 5. F12-specific consumer surfaces F13 must touch

These are the read/event surfaces that exist *because of F12*. F13's design must not regress them while it rewrites `card-store.ts`:

- Wire schemas: `CardHistoryListResponseSchema` and `CardHistoryGetResponseSchema` ([src/contracts/operator-api.ts#L151-L159](../../../src/contracts/operator-api.ts#L151-L159)).
- HTTP routes: `cards.history.list`, `cards.history.get` ([src/server/routes/operator-contracts.ts#L116-L122](../../../src/server/routes/operator-contracts.ts#L116-L122)); mount in [src/server/routes/cards.ts](../../../src/server/routes/cards.ts).
- Web HTTP client + store + components: [web/src/api/client.ts#L183-L193](../../../web/src/api/client.ts#L183-L193), [web/src/stores/cards.ts#L307-L317](../../../web/src/stores/cards.ts#L307-L317), [web/src/__tests__/card-history-panel.test.ts](../../../web/src/__tests__/card-history-panel.test.ts).
- Agent/tool consumers: [src/agents/analyst-tools.ts#L120-L144](../../../src/agents/analyst-tools.ts#L120-L144), [src/tools/agent-tools.ts#L103-L121](../../../src/tools/agent-tools.ts#L103-L121).
- Public event preserved: `card_history_appended` (see §4 wire contract).

## 6. Coordination with adjacent reviews

- **F13** — owner of the rewrite. Concrete asks listed in [02-design-r4.md](./02-design-r4.md) and [03-plan-r4.md](./03-plan-r4.md).
- **F19, F20, F23** — runtime-side patches that call `cardStore.update`/`setStatus`. After F13 lands, those calls become `await applyMutation` and their existing "version_seq stays at N" assertions must flip to "version_seq bumped, one history entry appended". F12 r4 has no say in their ordering; F13's plan does.
- **F21** — depends on F12 fix being live (history pivot for diff). Closure of F12 = closure of F13 = unblocks F21.

## Appendix A — Synthetic invariant test recipe (for F13 acceptance)

**What this recipe proves.** It demonstrates that the F12 acceptance invariant (`history.total >= card.version_seq - 1` with `max(history[].version_seq) === card.version_seq - 1` for any mutated card) is *violable* under the current code: a hand-injected orphan tail combined with a `version_seq` bump and a fresh `CardStore` construction produces a state where the live API returns `total === 0` while `card.version_seq > 1`. It does **not** claim to reproduce the original live audit observation step-for-step on every run; the live deployment was reset between the audit and r2 verification (see §2.3).

This recipe is destructive (it hand-injects state). Run only on a freshly-built `saivage-v3` harness. All scratch lives **inside the container** under `/work/saivage-v3/tmp/f12-invariant` (NEVER `/tmp`, NEVER on the host workspace `tmp/`).

```bash
# Container-local scratch under the project root. NOT /tmp. NOT the host workspace.
CONTAINER_SCRATCH=/work/saivage-v3/tmp/f12-invariant
ssh root@10.0.3.112 "mkdir -p $CONTAINER_SCRATCH"

PROJECT_ROOT=/work/saivage-v3
ID=project

# 1. Non-destructive inspection of live state (always safe).
ssh root@10.0.3.112 "cat $PROJECT_ROOT/.saivage/cards/by-id/$ID.json" \
  | jq '{id, version_seq, status, title}'
ssh root@10.0.3.112 "test -f $PROJECT_ROOT/.saivage/cards/history/$ID.history.jsonl \
  && wc -l $PROJECT_ROOT/.saivage/cards/history/$ID.history.jsonl \
  || echo 'no history file'"
curl -fsS "http://10.0.3.112:8080/api/cards/$ID/history" | jq .

# 2. Destructive injection — DO NOT run on shared/prod data.
# Snapshot first; restore after the test.
ssh root@10.0.3.112 "cp $PROJECT_ROOT/.saivage/cards/by-id/$ID.json $CONTAINER_SCRATCH/by-id.bak"
ssh root@10.0.3.112 "cp $PROJECT_ROOT/.saivage/cards/history/$ID.history.jsonl $CONTAINER_SCRATCH/history.bak 2>/dev/null || true"

# Bump by-id version, append a synthetic orphan history line whose version_seq matches the pre-bump snapshot.
ssh root@10.0.3.112 "jq '.version_seq = 99' $PROJECT_ROOT/.saivage/cards/by-id/$ID.json \
  > $CONTAINER_SCRATCH/x && mv $CONTAINER_SCRATCH/x $PROJECT_ROOT/.saivage/cards/by-id/$ID.json"
ssh root@10.0.3.112 "echo '{\"card_id\":\"project\",\"version_seq\":98,\"snapshot\":{},\"changed_at\":\"2026-05-23T00:00:00Z\",\"changed_by_actor\":\"runtime\",\"changed_by_surface\":\"runtime\",\"change_reason\":null,\"changed_fields\":[\"title\"],\"change_summary\":\"title\"}' \
  >> $PROJECT_ROOT/.saivage/cards/history/$ID.history.jsonl"

# 3. Trigger reconciliation (any HTTP request constructs a fresh store).
curl -fsS "http://10.0.3.112:8080/api/cards/$ID/history" | jq .

# 4. Acceptance after F13 lands:
#    - The above curl MUST throw a startup CardStoreInvariantError (or equivalent) loudly,
#      surfacing the orphan; the history file is NOT silently rewritten.
#    - Pre-F13 (current behaviour): the orphan line is silently truncated, API returns [].
#    - Either pre- or post-F13, the recipe demonstrates that an injected divergence between
#      by-id.version_seq and history-tail violates the invariant — it does NOT claim to
#      reproduce the original live empty-history observation deterministically.

# 5. Cleanup — restore originals.
ssh root@10.0.3.112 "cp $CONTAINER_SCRATCH/by-id.bak $PROJECT_ROOT/.saivage/cards/by-id/$ID.json"
ssh root@10.0.3.112 "[ -f $CONTAINER_SCRATCH/history.bak ] && cp $CONTAINER_SCRATCH/history.bak $PROJECT_ROOT/.saivage/cards/history/$ID.history.jsonl \
  || rm -f $PROJECT_ROOT/.saivage/cards/history/$ID.history.jsonl"
ssh root@10.0.3.112 "rm -rf $CONTAINER_SCRATCH"
```

The non-destructive part (step 1) is the operator-facing diagnostic and is safe to run any time. Steps 2-4 belong inside F13's crash-injection test suite under `tests/utils/`; they are not a manual operator probe. If a host-side staging artefact is later needed, place it under the workspace-local `tmp/` (e.g. `/home/salva/g/ml/tmp/f12-invariant-host/`) and copy it into the container via `scp`/`ssh`; do not run injection commands against host paths.
