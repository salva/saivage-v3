# F12 — Design (r4, closure mode)

Supersedes [02-design-r3.md](./02-design-r3.md). Addresses [01-analysis-review-r3.md](./01-analysis-review-r3.md) Design section: implementation-owner link now points at the F13 r3 design (not r2, and not a future reissue); the "F13 decides between…" out-of-scope bullets are removed because the orchestrator decisions are binding; the "must appear verbatim" wording is replaced by an explicit enumerated test list that the F13 r4 plan must include.

F12 has no independent design.

## Implementation owner

The implementation is the [F13 r3 design](../F13-canonical-index-drift/02-design-r3.md). The binding architecture decisions absorbed from F12 r2 and reflected in F13 r3 are:

- **Derived files are deleted entirely.** No `cards/index.json`, no `depends-on.json`, no `blocks.json`, no `cards/tree/<id>.children.json`. Reads scan `cards/by-id/` (and the per-card history file) directly.
- **Single project-wide mutation mutex.** One in-process lock per `projectRoot`; no per-card locks; no nested locks.
- **Commit markers carry `entry_id` and `kind`** on every history entry, and the marker is what crash-recovery uses to decide whether the by-id rename committed.

These three decisions are **not** open questions for F13; they are binding inputs to its design.

## F12-specific acceptance shape (binding contract for F13)

For any card `<id>` that has been mutated at least once since creation, with the orchestrator-binding semantics "row `version_seq = N` is the pre-mutation snapshot for the bump to `N+1`":

- `GET /api/cards/<id>/history` returns `total >= 1` with `total >= card.version_seq - 1` and `max(history[].version_seq) === card.version_seq - 1`.
- `GET /api/cards/<id>/history/<seq>` returns the pre-mutation snapshot for every `seq ∈ [1, card.version_seq - 1]`.
- `GET /api/cards/<id>/diff?from=<a>&to=<b>` returns a non-empty `changed_fields` list whenever a real field differs (in particular `diff?from=1&to=2` after two mutations).
- The websocket `card_history_appended` event fires exactly once per `version_seq` bump and matches the wire contract in [src/contracts/operator-events.ts#L110-L119](../../../src/contracts/operator-events.ts#L110-L119).

## F12-specific surfaces F13's design must cover (non-regression)

F13 r3 may rewrite `card-store.ts` freely, but its design and plan must explicitly preserve or replace each of the following:

1. **History HTTP routes.** `cards.history.list` and `cards.history.get` ([src/server/routes/operator-contracts.ts#L116-L122](../../../src/server/routes/operator-contracts.ts#L116-L122)) keep their current paths and response shapes.
2. **History wire schemas.** `CardHistoryListResponseSchema` and the per-entry schema ([src/contracts/operator-api.ts#L151-L159](../../../src/contracts/operator-api.ts#L151-L159)) keep their public shape. The `headers: z.record(...)` wildcard is out of scope for tightening here; if F13 tightens it, F12 acceptance tests still pass.
3. **Websocket event preservation.** `card_history_appended` ([src/events/registry.ts#L58](../../../src/events/registry.ts#L58)) is preserved as a public broadcast event, emitted exactly once per successful mutation. Whether it is emitted from inside `CardStore` or from a runtime/route wrapper is F13's choice; F12 only requires the wire-level invariant.
4. **History round-trip contract tests.** The F12 acceptance tests enumerated in §"F12 acceptance test enumeration" below MUST be present (by file path and assertion content) in the F13 r4 plan's Jest/Vitest baseline. F13 r4 must reference this list by section anchor and add each item to its targeted test list.
5. **Untracked-update coverage.** F13 must close the audit-debt path so that `setStatus`, `update` (any patched field), `updateDependsOn`, `create`, `delete`, and `archiveAndDeleteSubtree` each produce one history entry per mutation.
6. **Silent-truncation removal.** `reconcileCardHistory` and any equivalent silent-rewrite path is deleted; orphan tails become a loud startup error.

## F12 acceptance test enumeration (F13 r4 plan must include each)

This is the concrete, enumerated list that replaces the prior "must appear verbatim" wording. F13 r4 is required to add or rewrite each numbered item below in its targeted-test baseline; assertion details are owned by [03-plan-r4.md §(b)](./03-plan-r4.md#b-f12-acceptance-tests-that-must-appear-in-f13s-test-list) and re-stated there for the writer's convenience.

Backend Jest (paths relative to `/home/salva/g/ml/saivage-v3/`):

1. [tests/server/operator-api-contracts.test.ts](../../../tests/server/operator-api-contracts.test.ts) — title PATCH then history populated; status PATCH then history populated; two consecutive PATCHes produce `history.total === 2` with `version_seq` values `[2, 1]` newest-first and `max(history[].version_seq) === card.version_seq - 1`; `GET history/1` returns the pre-first-edit snapshot; `GET diff?from=1&to=2` returns non-empty `changed_fields`.
2. [tests/api/cards-history.test.ts](../../../tests/api/cards-history.test.ts) — mixed-mutation sequence (`update`, `setStatus`, `mutateCard`, `updateDependsOn`) ends with `max(history[].version_seq) === card.version_seq - 1`.
3. [tests/server/websocket-analyst-safety.test.ts](../../../tests/server/websocket-analyst-safety.test.ts) — `card_history_appended` emitted exactly once per `applyMutation` that bumps `version_seq`.
4. [tests/agents/card-history-tools.test.ts](../../../tests/agents/card-history-tools.test.ts) — `cards.history.list` and `cards.history.get` return populated history after a mutation.
5. [tests/utils/card-history.test.ts](../../../tests/utils/card-history.test.ts) — rewrite the `"update without tracked fields does not append history"` case to its negation; delete the silent-recovery cases; assert that an injected orphan tail causes `CardStore.open(projectRoot)` to throw loudly.

Web Vitest (paths relative to `/home/salva/g/ml/saivage-v3/web/`):

6. [src/__tests__/card-history-panel.test.ts](../../../web/src/__tests__/card-history-panel.test.ts) — after a mocked mutation the panel renders ≥1 entry.
7. [src/__tests__/card-history-panel-analyst-filter.test.ts](../../../web/src/__tests__/card-history-panel-analyst-filter.test.ts) — analyst filter operates on a non-empty list.
8. [src/__tests__/operator-dashboard-smoke.test.ts](../../../web/src/__tests__/operator-dashboard-smoke.test.ts) — dashboard smoke test asserts the history tab populates after a UI-driven mutation.

## Out of scope for F12 r4

- `CardStore` API shape, async fan-out, `CardStore.open(...)` factory → F13 owns.
- Deletion inventory beyond the "silent-truncation removal" above → F13 owns.
- Schema/contract cleanup beyond the F12-acceptance shape → F13 owns.
- Comment/docstring discipline on touched/untouched files → F13's implementation-plan review gate; F12 r4 adopts the workspace rule (no new docstrings or comments outside the lines being changed).
