# F12 — Implementation plan (r3, closure mode)

Supersedes [03-plan-r2.md](./03-plan-r2.md). **F12 has no independent implementation steps.** All work is performed by [F13](../F13-canonical-index-drift/03-plan-r2.md) (to be re-emitted as r3).

## (a) Pointer to the implementation plan

The implementation is the F13 r3 plan: [F13/03-plan-r2.md](../F13-canonical-index-drift/03-plan-r2.md) (which F13 must re-issue as r3 absorbing the F12-r2 simplifications — see [02-design-r3.md](./02-design-r3.md)).

F12 contributes:

- The acceptance shape in [01-analysis-r3.md §4](./01-analysis-r3.md#4-f12-acceptance-shape-binding-f13-must-satisfy) — F13's plan must close all of it.
- The acceptance test list below — F13's plan must include every test verbatim in its targeted Jest baseline.
- The live-probe success criterion in §(c) — F13's final validation step must assert it on the `saivage-v3` harness.

## (b) F12 acceptance tests that MUST appear in F13's test list

These tests are F12's non-regression contract. F13 must add or rewrite them in the same PR series that lands `applyMutation`; their pass/fail is the F12 closure signal.

### Backend Jest (paths relative to `/home/salva/g/ml/saivage-v3/`)

1. [tests/server/operator-api-contracts.test.ts](../../../tests/server/operator-api-contracts.test.ts) — add (or replace existing untracked-update assertion with):
   - `PATCH /api/cards/:id` with `{ title: "x" }` then `GET /api/cards/:id/history` → `total === 1`, `history[0].version_seq === 1`, `history[0].changed_fields` includes `"title"`.
   - `PATCH /api/cards/:id` with `{ status: "active" }` then `GET /api/cards/:id/history` → `total === 1`, `history[0].version_seq === 1`, `history[0].changed_fields` includes `"status"` (proves the previously-untracked path now produces history).
   - After two consecutive PATCHes, `GET /api/cards/:id` returns `version_seq === 3`, `GET /api/cards/:id/history` returns `total === 2` with `version_seq` values `[2, 1]` (newest first), and `max(history[].version_seq) === 2 === card.version_seq - 1`.
   - `GET /api/cards/:id/history/1` returns the pre-first-edit snapshot (not 404).
   - `GET /api/cards/:id/diff?from=1&to=2` returns a `changed_fields` list including `"title"` or `"status"` per the mutation above.

2. [tests/api/cards-history.test.ts](../../../tests/api/cards-history.test.ts) — keep all current passing cases; remove any case that asserts `total === 0` after an `update()`/`setStatus()` mutation; add a case proving `max(history[].version_seq) === card.version_seq - 1` after a mixed mutation sequence (`update`, `setStatus`, `mutateCard`, `updateDependsOn`).

3. [tests/server/websocket-analyst-safety.test.ts](../../../tests/server/websocket-analyst-safety.test.ts) — assert that `card_history_appended` is emitted exactly once per `applyMutation` that bumps `version_seq`, and that the event payload matches [src/contracts/operator-events.ts#L110-L119](../../../src/contracts/operator-events.ts#L110-L119).

4. [tests/agents/card-history-tools.test.ts](../../../tests/agents/card-history-tools.test.ts) — `cards.history.list` and `cards.history.get` agent tools return populated history after any mutation kind.

5. [tests/utils/card-history.test.ts](../../../tests/utils/card-history.test.ts) — rewrite the case at L43 (`"update without tracked fields does not append history"`) to its negation: every accepted patch produces exactly one history entry. Delete the orphan-recovery cases at L66-L117 (silent truncation is gone). Add a new case asserting that a hand-injected orphan tail causes `CardStore.open(projectRoot)` to throw loudly instead of silently rewriting the file.

### Web Vitest (paths relative to `/home/salva/g/ml/saivage-v3/web/`)

6. [src/__tests__/card-history-panel.test.ts](../../../web/src/__tests__/card-history-panel.test.ts) — after a mocked mutation, the panel renders ≥1 entry (no longer `"No history entries yet."`).
7. [src/__tests__/card-history-panel-analyst-filter.test.ts](../../../web/src/__tests__/card-history-panel-analyst-filter.test.ts) — analyst filter operates on a non-empty list.
8. [src/__tests__/operator-dashboard-smoke.test.ts](../../../web/src/__tests__/operator-dashboard-smoke.test.ts) — dashboard smoke test asserts the history tab populates after any UI-driven mutation.

## (c) Live-probe success criterion

After F13 lands and the `saivage-v3` harness is rebuilt/redeployed per [.github/skills/saivage-development-validation/SKILL.md](../../../../.github/skills/saivage-development-validation/SKILL.md), mutate any card via the operator API (e.g. `PATCH /api/cards/project` with a title or status change) and assert:

```
history.total > 0 && max(history[].version_seq) === card.version_seq - 1
```

Concrete probe (run from the host):

```bash
ID=project
# 1. Snapshot pre-mutation version.
BEFORE=$(curl -fsS http://10.0.3.112:8080/api/cards/$ID | jq -r '.version_seq')

# 2. Mutate via the operator route (whatever field is currently valid).
curl -fsS -X PATCH -H 'content-type: application/json' \
  -d '{"title":"f12-probe"}' \
  http://10.0.3.112:8080/api/cards/$ID >/dev/null

# 3. Read back.
AFTER=$(curl -fsS http://10.0.3.112:8080/api/cards/$ID | jq -r '.version_seq')
HIST=$(curl -fsS http://10.0.3.112:8080/api/cards/$ID/history)
TOTAL=$(echo "$HIST" | jq '.total')
MAX_SEQ=$(echo "$HIST" | jq '[.history[].version_seq] | max')

# 4. Assert.
test "$AFTER" -gt "$BEFORE" || { echo "FAIL: version_seq did not bump"; exit 1; }
test "$TOTAL" -gt 0          || { echo "FAIL: history empty";          exit 1; }
test "$MAX_SEQ" -eq "$((AFTER - 1))" \
  || { echo "FAIL: max(history.version_seq)=$MAX_SEQ != $AFTER-1";    exit 1; }
echo "F12 LIVE PROBE PASS: version_seq=$AFTER, history.total=$TOTAL, max_seq=$MAX_SEQ"
```

The probe passes ⇔ F12 is closed. F13's plan must run this probe (or an equivalent in-test assertion) as its final validation gate; failure blocks the PR.
