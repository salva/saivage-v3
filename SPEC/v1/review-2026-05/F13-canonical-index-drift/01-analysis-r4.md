# F13 — Functional Analysis (r4)

Supersedes [01-analysis-r3.md](01-analysis-r3.md). Addresses every numbered item in [01-analysis-review-r3.md](01-analysis-review-r3.md) and the orchestrator-binding decisions:

- F13 is the umbrella; slim layout (derived files deleted, not just unwritten).
- Single project-wide mutex; commit markers carry `entry_id` and `kind`.
- **History row for `version_seq = N` is the snapshot BEFORE the mutation that produces `card.version_seq = N + 1`.** Therefore for any card with current `version_seq = V`, the history must satisfy `max(history[].version_seq) === V - 1` and `total >= V - 1`.
- `transitionCard` is async (cross-issue contract with F19 r4).

## Observed failure (unchanged)

`Canonical hierarchy invariant failed: cards/index.json entry for 'project' does not match by-id record.` — [src/cards/card-store.ts#L73](../../../src/cards/card-store.ts#L73). The G2/T23 steady-state probe reads the hard-coded `{ canonical: 'ok' }` literal at [src/server/routes/operator-contracts.ts#L88](../../../src/server/routes/operator-contracts.ts#L88), not a live consistency check.

## Concurrency framing (unchanged)

`mutateCard` / `update` / `setStatus` / `create` / `delete` / `archiveAndDeleteSubtree` / `updateDependsOn` bodies are synchronous JS today; a normal Fastify handler cannot schedule another mutation between two `renameSync` calls. The r1 "HTTP read race during a synchronous mutation" hypothesis stays withdrawn. Only three failure classes can produce the observed drift: crash between by-id rename and `cards/index.json` write; out-of-band writer; synchronous event-bus reentrancy. After F13, classes 1 and 3 are unrepresentable (no `cards/index.json`, no synchronous `card_history_record_appended` re-entry path).

## Mutation-path inventory (carried from r3)

Unchanged. `recomputeBlocks` disappears as on-disk write and becomes an in-memory derivation. `archiveAndDeleteSubtree` is the only multi-card mutation; its survivor-rewrite semantics are now defined in [02-design-r4.md](02-design-r4.md) §"Multi-card mutation atomicity".

## History contract (BINDING — resolves analysis-review items 1, 2, 4 and cross-check items 2, 3, 5)

### Sequence invariant

For every card `c` with `c.version_seq = V`:

- `total >= V - 1` (one history row per past mutation; project seed produces `V = 1` with `total = 0`).
- `max(history[].version_seq) === V - 1` whenever `V >= 1`. Project creation (`V = 1`) produces no history row.
- History rows are contiguous: the set `{ history[].version_seq }` equals `{1, 2, ..., V - 1}` for `V >= 2`.
- A history row's `version_seq = N` is the snapshot of `c` **before** the mutation that produced `c.version_seq = N + 1`. So `history[0]` (newest first, `version_seq = V - 1`) shows the state just prior to the most recent commit.

### Websocket payload note

The durable history row uses the pre-mutation `version_seq`. The websocket `card_history_appended` event payload is free to additionally report the post-mutation `card.version_seq` in its envelope; that does not change the durable JSONL row. F13 keeps the existing event payload shape (no behaviour regression for current subscribers) and the row stored on disk uses the pre-mutation `version_seq`.

### `CardHistoryEntry` semantics table (resolves analysis-review item 2)

`kind` is a required field on every entry; `entry_id: string` (UUID) is required on every entry.

| `kind` | `version_seq` value | `snapshot` content | Route visibility (`GET /api/cards/<id>/history`, `history/<seq>`, `diff?from=&to=`) | Notes |
| --- | --- | --- | --- | --- |
| `create` | `0` | tombstone shape: `{ id, type, parent: null, status: 'placeholder', version_seq: 0 }` with all other `CardRecord` fields at their `cardRecordSchema` defaults (mirrors a synthetic pre-existence row so `diff?from=0&to=1` is meaningful) | Visible. `history/<seq>=0` returns the tombstone; `diff?from=0&to=1` returns the full `create` payload. | The first real edit later writes `version_seq = 1` row with the pre-edit `CardRecord` snapshot (i.e. the state right after `create`). This keeps the contract `history[N].snapshot == card-state-before-mutation-that-produced-N+1` consistent across `create`. |
| `update` | pre-mutation `card.version_seq` (i.e. `V_before`) | pre-mutation full `CardRecord` snapshot | Visible. | Produced by `CardStore.update`. |
| `status` | `V_before` | pre-mutation snapshot | Visible. | Produced by `CardStore.setStatus`. `changed_fields` always contains `"status"`. |
| `mutate` | `V_before` | pre-mutation snapshot | Visible. | Produced by `CardStore.mutateCard` (composite patch from analyst/planner tools). |
| `depends` | `V_before` | pre-mutation snapshot of the dependent card | Visible on the dependent card's history only. | Produced by `CardStore.updateDependsOn`. Does NOT write history rows on neighbours whose in-memory `blocks` array recomputes; the inverse adjacency is derived and not authoritative. |
| `delete` | `V_before` | pre-mutation full snapshot (the last-known state of the now-deleted card) | Visible. The deleted card's history file (`cards/history/<id>.history.jsonl`) is preserved on disk; `GET /api/cards/<id>/history` and `history/<seq>` continue to resolve for a deleted card; the `GET /api/cards/<id>` lookup returns 404 for the live record. `diff?from=&to=` resolves up to the final `delete` row. | Final row in the file. No further appends. |
| `archive` | `V_before` for each archived card | pre-mutation full snapshot per card | Visible per-card with the same semantics as `delete`. | Emitted by `archiveAndDeleteSubtree`; one row per archived card, all sharing the same `group_token` (recorded inside the commit marker, not in the row itself). |

Rules common to every kind:

- `entry_id` is generated once per logical mutation and stored in both the commit marker and the JSONL row; recovery uses `entry_id` to make `appendSyncIdempotent` exactly-once.
- `changed_fields` is the full diff between the pre- and post-mutation `CardRecord` (the deleted `TRACKED_FIELDS` / `TRACKED_UPDATE_FIELDS` / `TRACKED_EDIT_FIELDS` split is gone). For `create`, `changed_fields` is every field that differs from the synthetic tombstone (effectively all of them). For `delete` / `archive`, `changed_fields` is `[]` (the row records the final state, not a diff).
- Deleted-card history remains queryable: the `cards/history/<id>.history.jsonl` file is not unlinked when the by-id record is removed, and the operator/agent routes still serve it.

## Schema fanout (COMPLETE — resolves analysis-review item 3)

The current contract surfaces use `z.record(z.string(), z.unknown())` for both history responses, not the entry schema. F13 tightens both:

Backend Zod surfaces:

- [src/schemas/types.ts#L55](../../../src/schemas/types.ts#L55) — `CardHistoryEntry` gains `entry_id: string` and `kind: CardHistoryKind`. Add `CardHistoryKind` union.
- [src/schemas/validators.ts#L23](../../../src/schemas/validators.ts#L23) — `cardHistoryEntrySchema` adds `entry_id: z.string().uuid()` and `kind: z.enum([...])`.
- [src/schemas/index.ts](../../../src/schemas/index.ts) — re-export `CardHistoryKind`.
- [src/contracts/operator-api.ts#L156](../../../src/contracts/operator-api.ts#L156) — `CardHistoryListResponseSchema` currently `z.array(z.record(z.string(), z.unknown()))`; tighten to `z.array(cardHistoryHeaderSchema)` (a strict header subset of `cardHistoryEntrySchema`, omitting `snapshot` to keep list payloads small but adding `entry_id` and `kind`).
- [src/contracts/operator-api.ts#L157](../../../src/contracts/operator-api.ts#L157) — `CardHistoryEntryResponseSchema` currently `z.object({ entry: z.record(z.string(), z.unknown()) })`; tighten to `z.object({ entry: cardHistoryEntrySchema })`.
- [src/contracts/index.ts](../../../src/contracts/index.ts) — export the new `cardHistoryHeaderSchema`, `CardHistoryListResponseSchema`, `CardHistoryEntryResponseSchema`, and the tightened response types.

Agent-tool surfaces:

- [src/tools/agent-tools.ts](../../../src/tools/agent-tools.ts) — `list_card_history` and `get_card_history_entry` tools pull schemas from the contracts above; their output schemas become typed and any test stub passing `{}` fails Zod validation.

Web surfaces (resolves the missing item from r3):

- [web/src/api/types.ts#L240](../../../web/src/api/types.ts#L240) — `CardHistoryHeader` interface gains `entry_id: string` and `kind: CardHistoryKind`.
- [web/src/api/types.ts#L251](../../../web/src/api/types.ts#L251) — `CardHistoryEntry` extends the header so it inherits the new fields.
- [web/src/api/types.ts#L789](../../../web/src/api/types.ts#L789) — `CardHistoryListResponse` and `CardHistoryEntryResponse` types follow the contract; no shape change beyond the field additions.
- [web/src/api/client.ts](../../../web/src/api/client.ts) — typed through the contract import; no runtime change.
- [web/src/stores/cards.ts](../../../web/src/stores/cards.ts) — cache shape unchanged; types follow.
- [web/src/__tests__/card-history-panel.test.ts](../../../web/src/__tests__/card-history-panel.test.ts), [.../card-history-panel-analyst-filter.test.ts](../../../web/src/__tests__/card-history-panel-analyst-filter.test.ts), [.../operator-dashboard-smoke.test.ts](../../../web/src/__tests__/operator-dashboard-smoke.test.ts) — every fixture gains `entry_id` (use `crypto.randomUUID()`) and `kind`.

Backend test fixtures:

- [tests/agents/card-history-tools.test.ts](../../../tests/agents/card-history-tools.test.ts), [tests/api/cards-history.test.ts](../../../tests/api/cards-history.test.ts), [tests/utils/card-history.test.ts](../../../tests/utils/card-history.test.ts), [tests/server/runtime-card-contract-routes.test.ts](../../../tests/server/runtime-card-contract-routes.test.ts), [tests/server/operator-api-contracts.test.ts](../../../tests/server/operator-api-contracts.test.ts), [tests/server/operator-api-contract-fixtures.test.ts](../../../tests/server/operator-api-contract-fixtures.test.ts), [tests/schemas.test.ts](../../../tests/schemas.test.ts).

Per the architecture-first rule, no reader tolerates missing `entry_id` / `kind`; pre-F13 on-disk history files are not read by post-F13 code. Rollback is "revert PR" or "reset local `.saivage` state".

## F12 closure inside F13 (resolves analysis-review item 4 and cross-check items 1, 4)

Every state-changing call to `CardStore` produces exactly one history entry inside `applyMutation`. The full list of F12 r3 acceptance tests F13 must keep green is cross-linked verbatim from [../F12-card-history-empty/03-plan-r3.md](../F12-card-history-empty/03-plan-r3.md) §(b):

1. [tests/server/operator-api-contracts.test.ts](../../../tests/server/operator-api-contracts.test.ts) — PATCH `{ title: "x" }`; PATCH `{ status: "active" }`; two consecutive PATCHes producing `card.version_seq === 3` with `total === 2`, `version_seq` values `[2, 1]` (newest first), `max(history[].version_seq) === 2 === card.version_seq - 1`; `GET history/1` returns pre-first-edit snapshot (not 404); `GET diff?from=1&to=2` returns `changed_fields`.
2. [tests/api/cards-history.test.ts](../../../tests/api/cards-history.test.ts) — remove any `total === 0` assertion after an `update`/`setStatus`; add `max(history[].version_seq) === card.version_seq - 1` after a mixed (`update`, `setStatus`, `mutateCard`, `updateDependsOn`) sequence.
3. [tests/server/websocket-analyst-safety.test.ts](../../../tests/server/websocket-analyst-safety.test.ts) — `card_history_appended` emitted exactly once per `applyMutation` that bumps `version_seq`.
4. [tests/agents/card-history-tools.test.ts](../../../tests/agents/card-history-tools.test.ts) — `list_card_history` and `get_card_history_entry` return populated history after any mutation kind.
5. [tests/utils/card-history.test.ts](../../../tests/utils/card-history.test.ts) — rewrite the L43 case ("update without tracked fields does not append history") to its negation; delete the L66–L117 orphan-recovery cases (silent truncation is gone); add a case asserting that a hand-injected orphan tail with `version_seq > card.version_seq` causes `CardStore.open` to throw `CardStoreInvariantError`.
6. [web/src/__tests__/card-history-panel.test.ts](../../../web/src/__tests__/card-history-panel.test.ts) — panel renders ≥ 1 entry after a mocked mutation.
7. [web/src/__tests__/card-history-panel-analyst-filter.test.ts](../../../web/src/__tests__/card-history-panel-analyst-filter.test.ts) — analyst filter operates on a non-empty list.
8. [web/src/__tests__/operator-dashboard-smoke.test.ts](../../../web/src/__tests__/operator-dashboard-smoke.test.ts) — dashboard smoke asserts the history tab populates after a UI-driven mutation.

Every F12 mutation surface (HTTP PATCH, runtime/planner calls, analyst tools, `setStatus`, `update`, `updateDependsOn`, `create`, `delete`, `archiveAndDeleteSubtree`) must be covered by an acceptance assertion that proves **exactly one history entry and exactly one `card_history_appended` event per successful version bump**. This is enforced both by the rewritten `tests/utils/card-history.test.ts` matrix and by the new `tests/utils/apply-mutation.test.ts` matrix in [03-plan-r4.md](03-plan-r4.md).

## `transitionCard` is async (binding cross-issue note)

`CardStore.transitionCard` (the F19 r4 entrypoint for promoting a card into the active runtime) becomes `async` and routes its on-disk effects through `applyMutation`. F13 does not own its body but does own the contract: every `transitionCard` call composes with `await projectMutex.lock()` + `await projectLock.acquire()`, produces one history row with `kind: 'status'`, one `card_history_appended` event, and a `card.version_seq` bump. F19 r4 and F13 must land together or in dependency order; the F13 plan's async-constructor fanout grep includes the `transitionCard` call sites so the migration is mechanical.

## Source-of-truth decision (unchanged)

Authoritative on disk: `cards/by-id/<id>.json`, `cards/history/<id>.history.jsonl`, `cards/.commit/<token>.json`. Deleted from the on-disk layout: `cards/index.json`, `cards/dependencies/depends-on.json`, `cards/dependencies/blocks.json`, `cards/tree/<id>.children.json`, `cards/tree/` directory, `cards/blocks.json` (legacy). The `HierarchyGraph.build` index↔by-id equality throw becomes unrepresentable.

## `canonicalHealth` surfaces (unchanged from r3)

`CardStore.getHealth()`, the hard-coded `/api/state` literal, and the websocket field are all deleted; full grep list in [03-plan-r4.md](03-plan-r4.md) §"Dead-code inventory".

## Boot replay / recovery cost (unchanged from r3)

Always load every `cards/by-id/*.json` (bounded by card count, sub-100 ms on target). Recover any markers in `cards/.commit/` (empty in steady state). Build in-memory adjacency. Run startup invariant: per card, the per-card history file must contain a contiguous run of rows `1..V-1` (after de-dup by `entry_id` and marker-driven recovery); any gap, duplicate, or `version_seq > V - 1` orphan is a fatal `CardStoreInvariantError`.

## Assumptions still unverified by code reading alone

- Whether a controlled `SIGKILL` between by-id rename and `cards/index.json` write reliably produces the observed `errors.jsonl` line on the next boot. Proven by the injected-failure tests in [03-plan-r4.md](03-plan-r4.md) §"Crash-injection test matrix".
- Whether any current subscriber to `card_history_record_appended` re-enters the store. Static grep shows none; the event kind is deleted regardless.
- Whether any out-of-band process writes into `.saivage/cards/`. After F13, an out-of-band by-id rewrite is honoured on next `CardStore.open` (subject to the contiguous-history invariant); writing into `cards/.commit/` is an operator-deliberate act and recovery refuses to silently discard a corrupt marker.
