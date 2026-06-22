# F12 — Implementation plan (r5, closure mode)

Supersedes [03-plan-r4.md](./03-plan-r4.md). Addresses [01-analysis-review-r4.md](./01-analysis-review-r4.md) Plan section: the implementation pointer now targets the [F13 r4](../F13-canonical-index-drift/03-plan-r4.md) analysis/design/plan trio (F13 r4 supersedes r3); the live probe additionally asserts that every history row and every history header carries `entry_id` (UUID-shape) and `kind` (allowed-literal set); the test-list provenance is updated to F12 r4 / F13 r4. The numeric history math is unchanged.

**F12 has no independent implementation steps.** All work is performed by [F13](../F13-canonical-index-drift/03-plan-r4.md).

## (a) Pointer to the implementation plan

The implementation is owned by the [F13 r4 trio](../F13-canonical-index-drift/01-analysis-r4.md): [analysis-r4](../F13-canonical-index-drift/01-analysis-r4.md), [design-r4](../F13-canonical-index-drift/02-design-r4.md), [plan-r4](../F13-canonical-index-drift/03-plan-r4.md). F13 r4 supersedes F13 r3 in its entirety; any remaining F13-r3 cross-link in earlier F12 revisions is now stale and replaced by the r4 link.

F12 contributes:

- The acceptance shape in [01-analysis-r5.md §4](./01-analysis-r5.md#4-f12-acceptance-shape-binding-f13-must-satisfy) — F13's plan must close all of it (including the new `entry_id`/`kind` bullets).
- The enumerated acceptance test list in [02-design-r5.md §"F12 acceptance test enumeration"](./02-design-r5.md#f12-acceptance-test-enumeration-f13-r4-plan-must-include-each) and re-stated in §(b) below — F13 r4 must include every item, with the `entry_id`/`kind` assertions, in its targeted Jest/Vitest baseline. Provenance: F12 r4 → F12 r5 (no item renumbering) and the corresponding F13 r4 absorbed list.
- The live-probe success criterion in §(c) — F13's final validation step must assert it on the `saivage-v3` harness.

Orchestrator-binding semantics adopted for all F12 acceptance math: row `version_seq = N` is the snapshot taken BEFORE the mutation that bumps the card to `version_seq = N+1`. Therefore:

- `history.total >= card.version_seq - 1`
- `max(history[].version_seq) === card.version_seq - 1`
- `history/<seq>` is populated for every `seq ∈ [1, card.version_seq - 1]`
- `diff?from=1&to=2` is non-empty whenever a real field differs

This matches [tests/utils/card-history.test.ts](../../../tests/utils/card-history.test.ts) and is the only acceptance math used below.

## (b) F12 acceptance tests that MUST appear in F13's test list

These tests are F12's non-regression contract. F13 r4 must add or rewrite them in the same PR series that lands `applyMutation`; their pass/fail is the F12 closure signal. Provenance: F12 r4 §(b) (numeric assertions retained verbatim) + F12 r5 (added `entry_id` / `kind` assertions, per [01-analysis-review-r4.md](./01-analysis-review-r4.md) Analysis #2 and Plan #2).

### Backend Jest (paths relative to `/home/salva/g/ml/saivage-v3/`)

1. [tests/server/operator-api-contracts.test.ts](../../../tests/server/operator-api-contracts.test.ts) — add (or replace existing untracked-update assertion with):
   - `PATCH /api/cards/:id` with `{ title: "x" }` then `GET /api/cards/:id/history` → `total === 1`, `history[0].version_seq === 1`, `history[0].changed_fields` includes `"title"`, `max(history[].version_seq) === card.version_seq - 1`, **`history[0].entry_id` matches `/^[0-9a-f-]{36}$/i` and `history[0].kind` is in the F13-r4-defined allowed-literal set**.
   - `PATCH /api/cards/:id` with `{ status: "active" }` then `GET /api/cards/:id/history` → `total === 1`, `history[0].version_seq === 1`, `history[0].changed_fields` includes `"status"`, **`entry_id` and `kind` populated as above** (proves the previously-untracked path now produces history with full envelope).
   - After two consecutive PATCHes, `GET /api/cards/:id` returns `version_seq === 3`, `GET /api/cards/:id/history` returns `total === 2` with `version_seq` values `[2, 1]` (newest first), `total >= card.version_seq - 1`, `max(history[].version_seq) === 2 === card.version_seq - 1`, **and every row carries a UUID-shape `entry_id` and an allowed `kind`; the two `entry_id` values are pairwise distinct**.
   - `GET /api/cards/:id/history/1` returns the pre-first-edit snapshot (not 404), **with `entry_id` and `kind` on the response header object identical to the row at `version_seq === 1` from the list endpoint**.
   - `GET /api/cards/:id/diff?from=1&to=2` returns a `changed_fields` list including `"title"` or `"status"` per the mutation above.

2. [tests/api/cards-history.test.ts](../../../tests/api/cards-history.test.ts) — keep all current passing cases; remove any case that asserts `total === 0` after an `update()`/`setStatus()` mutation; add a case proving `total >= card.version_seq - 1` and `max(history[].version_seq) === card.version_seq - 1` after a mixed mutation sequence (`update`, `setStatus`, `mutateCard`, `updateDependsOn`). **Assert every returned row in the final list carries a UUID-shape `entry_id` and an allowed `kind`; assert pairwise uniqueness of `entry_id` across the full sequence.**

3. [tests/server/websocket-analyst-safety.test.ts](../../../tests/server/websocket-analyst-safety.test.ts) — assert that `card_history_appended` is emitted exactly once per `applyMutation` that bumps `version_seq`, and that the event payload matches [src/contracts/operator-events.ts#L110-L119](../../../src/contracts/operator-events.ts#L110-L119). **The payload's `entry_id` is asserted to be UUID-shape and to match the `entry_id` of the corresponding row returned by `cards.history.list`; the payload's `kind` is asserted to be in the allowed literal set.**

4. [tests/agents/card-history-tools.test.ts](../../../tests/agents/card-history-tools.test.ts) — `cards.history.list` and `cards.history.get` agent tools return populated history after any mutation kind (not merely a fixture compile check). **Agent-tool responses are asserted to expose `entry_id` (UUID shape) and `kind` (allowed literal) for every row and every header, identical to the HTTP response.**

5. [tests/utils/card-history.test.ts](../../../tests/utils/card-history.test.ts) — rewrite the case at L43 (`"update without tracked fields does not append history"`) to its negation: every accepted patch produces exactly one history entry with `version_seq === card.version_seq - 1` post-bump, **and that entry has a fresh UUID `entry_id` plus the correct `kind`**. Delete the orphan-recovery cases at L66-L117 (silent truncation is gone). Add a new case asserting that a hand-injected orphan tail causes `CardStore.open(projectRoot)` to throw loudly instead of silently rewriting the file; **the thrown error message MUST reference the offending row's `entry_id` (if present) or `version_seq` so operators can locate it**.

### Web Vitest (paths relative to `/home/salva/g/ml/saivage-v3/web/`)

6. [src/__tests__/card-history-panel.test.ts](../../../web/src/__tests__/card-history-panel.test.ts) — after a mocked mutation, the panel renders ≥1 entry (no longer `"No history entries yet."`). **Mock fixture rows carry `entry_id` (UUID) and `kind`; the test asserts the panel receives both fields without normalising them to empty strings.**
7. [src/__tests__/card-history-panel-analyst-filter.test.ts](../../../web/src/__tests__/card-history-panel-analyst-filter.test.ts) — analyst filter operates on a non-empty list. **Fixture rows carry `entry_id` and `kind`; the filter assertion preserves both on the rows that pass the filter.**
8. [src/__tests__/operator-dashboard-smoke.test.ts](../../../web/src/__tests__/operator-dashboard-smoke.test.ts) — dashboard smoke test asserts the history tab populates after a UI-driven mutation. **The smoke fixture's history entries carry `entry_id` and `kind`; the smoke test asserts the populated panel data preserves both.**

## (c) Live-probe success criterion

After F13 lands and the `saivage-v3` harness is rebuilt/redeployed per [.github/skills/saivage-development-validation/SKILL.md](../../../../.github/skills/saivage-development-validation/SKILL.md), mutate any card via the operator API and assert all numeric invariants AND the per-row envelope invariants:

```
history.total > 0
history.total >= card.version_seq - 1
max(history[].version_seq) === card.version_seq - 1
∀ row ∈ history[]: row.entry_id matches UUID regex /^[0-9a-f-]{36}$/i
∀ row ∈ history[]: row.kind is in the F13-r4-defined allowed-literal set
the header returned by GET history/<max_seq> carries the same entry_id + kind as the matching row
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

# 4. Assert numeric invariants.
test "$AFTER" -gt "$BEFORE" \
  || { echo "FAIL: version_seq did not bump ($BEFORE -> $AFTER)"; exit 1; }
test "$TOTAL" -gt 0 \
  || { echo "FAIL: history empty after mutation"; exit 1; }
test "$TOTAL" -ge "$((AFTER - 1))" \
  || { echo "FAIL: history.total=$TOTAL < card.version_seq-1=$((AFTER - 1))"; exit 1; }
test "$MAX_SEQ" -eq "$((AFTER - 1))" \
  || { echo "FAIL: max(history.version_seq)=$MAX_SEQ != card.version_seq-1=$((AFTER - 1))"; exit 1; }

# 5. Assert per-row envelope invariants (entry_id UUID-shape + kind present on every row).
BAD_ENVELOPE=$(echo "$HIST" \
  | jq -r '[.history[] | select((.entry_id // "" | test("^[0-9a-f-]{36}$"; "i")) | not or (.kind // "" | length == 0))] | length')
test "$BAD_ENVELOPE" -eq 0 \
  || { echo "FAIL: $BAD_ENVELOPE history row(s) missing UUID entry_id or non-empty kind"; echo "$HIST" | jq .; exit 1; }

# 6. Assert the per-seq header endpoint carries the same envelope for the latest row.
LATEST_ROW=$(echo "$HIST" | jq -c '.history[] | select(.version_seq == '"$MAX_SEQ"')')
HDR=$(curl -fsS "http://10.0.3.112:8080/api/cards/$ID/history/$MAX_SEQ")
HDR_ENTRY_ID=$(echo "$HDR" | jq -r '.entry_id // .header.entry_id // empty')
HDR_KIND=$(echo "$HDR" | jq -r '.kind // .header.kind // empty')
ROW_ENTRY_ID=$(echo "$LATEST_ROW" | jq -r '.entry_id')
ROW_KIND=$(echo "$LATEST_ROW" | jq -r '.kind')
test -n "$HDR_ENTRY_ID" && test "$HDR_ENTRY_ID" = "$ROW_ENTRY_ID" \
  || { echo "FAIL: history/<seq> header entry_id ($HDR_ENTRY_ID) != list row entry_id ($ROW_ENTRY_ID)"; exit 1; }
test -n "$HDR_KIND" && test "$HDR_KIND" = "$ROW_KIND" \
  || { echo "FAIL: history/<seq> header kind ($HDR_KIND) != list row kind ($ROW_KIND)"; exit 1; }

echo "F12 LIVE PROBE PASS: card.version_seq=$AFTER, history.total=$TOTAL, max_seq=$MAX_SEQ, envelope OK"
```

The probe passes ⇔ F12 is closed. F13 r4's plan must run this probe (or an equivalent in-test assertion covering all numeric AND envelope invariants) as its final validation gate; failure blocks the PR.
