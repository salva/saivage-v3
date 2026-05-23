# F12 — Design (r3, closure mode)

Supersedes [02-design-r2.md](./02-design-r2.md). F12 has no independent design.

## Implementation owner

The implementation is the [F13 r3 design](../F13-canonical-index-drift/02-design-r2.md) (Proposal C, to be re-emitted as r3 with the F12-r2 simplifications absorbed: derived files deleted rather than projected; single per-project mutation mutex; commit markers carrying `entry_id` and `kind` on history entries). All write-path, locking, crash-recovery, event-ownership, and dead-code decisions belong to F13.

## F12-specific acceptance shape (binding contract for F13)

For any card `<id>` that has been mutated at least once since creation:

- `GET /api/cards/<id>/history` returns `total >= 1` with `total >= card.version_seq - 1` and `max(history[].version_seq) === card.version_seq - 1`.
- `GET /api/cards/<id>/history/<seq>` returns the pre-mutation snapshot for every `seq ∈ [1, card.version_seq - 1]`.
- `GET /api/cards/<id>/diff?from=<a>&to=<b>` returns a non-empty `changed_fields` list whenever a real field differs.
- The websocket `card_history_appended` event fires exactly once per `version_seq` bump and matches the wire contract in [src/contracts/operator-events.ts#L110-L119](../../../src/contracts/operator-events.ts#L110-L119).

## F12-specific surfaces F13's design must cover (non-regression)

F13 r3 may rewrite `card-store.ts` freely, but its design and plan must explicitly preserve or replace each of the following:

1. **History HTTP routes.** `cards.history.list` and `cards.history.get` ([src/server/routes/operator-contracts.ts#L116-L122](../../../src/server/routes/operator-contracts.ts#L116-L122)) keep their current paths and response shapes.
2. **History wire schemas.** `CardHistoryListResponseSchema` and the per-entry schema ([src/contracts/operator-api.ts#L151-L159](../../../src/contracts/operator-api.ts#L151-L159)) keep their public shape. The `headers: z.record(...)` wildcard is out of scope for tightening here; if F13 tightens it, F12 acceptance tests still pass.
3. **Websocket event preservation.** `card_history_appended` ([src/events/registry.ts#L58](../../../src/events/registry.ts#L58)) is preserved as a public broadcast event, emitted exactly once per successful mutation. Whether it is emitted from inside `CardStore` or from a runtime/route wrapper is F13's choice; F12 only requires the wire-level invariant.
4. **History round-trip contract tests.** Test cases listed in [03-plan-r3.md §F12 acceptance tests](./03-plan-r3.md#f12-acceptance-tests-that-must-appear-in-f13s-test-list) must appear verbatim in F13's test list.
5. **Untracked-update coverage.** F13 must close the audit-debt path so that `setStatus`, `update` (any patched field), `updateDependsOn`, `create`, `delete`, and `archiveAndDeleteSubtree` each produce one history entry per mutation. F13 r2's "F12 closure semantics" table already encodes this.
6. **Silent-truncation removal.** `reconcileCardHistory` and any equivalent silent-rewrite path is deleted; orphan tails become a loud startup error.

## Out of scope for F12 r3

- Architecture choice between deleting vs. regenerating derived files (`cards/index.json`, `depends-on.json`, `blocks.json`, `cards/tree/<id>.children.json`) → F13 decides.
- Locking model (per-card vs. project-wide mutex) → F13 decides.
- Crash-recovery primitive (commit marker vs. append-then-rollback) → F13 decides.
- `CardStore` API shape, async fan-out, `CardStore.open(...)` factory → F13 decides.
- Deletion inventory beyond the "silent-truncation removal" above → F13 owns.
- Schema/contract cleanup beyond the F12-acceptance shape → F13 owns.
