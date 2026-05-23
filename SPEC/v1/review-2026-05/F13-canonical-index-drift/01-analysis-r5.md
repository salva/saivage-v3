# F13 — Functional Analysis (r5)

Supersedes [01-analysis-r4.md](01-analysis-r4.md). Addresses every numbered item in [01-analysis-review-r4.md](01-analysis-review-r4.md) and the orchestrator-binding decisions for r5:

- **No seq-0 create tombstone.** `create` produces NO public history row. `version_seq` is strictly positive (≥ 1). The first history row appears at `version_seq = 1` after the first mutation that bumps the card to `version_seq = 2`. A card with `card.version_seq === 1` (the post-`create` baseline) has `history.total === 0`. F12's `total >= V - 1` invariant is therefore satisfied trivially for `V = 1` (`0 >= 0`).
- F13 remains the umbrella; slim layout (derived files deleted, not just unwritten).
- Single project-wide mutex composed with the cross-process `ProjectLock.withLock` API; commit markers carry `entry_id` and `kind`.
- History row for `version_seq = N` is the snapshot taken BEFORE the mutation that produces `card.version_seq = N + 1`. Therefore for any card with current `version_seq = V`, the history satisfies `max(history[].version_seq) === V - 1` (when `V >= 2`) and `total >= V - 1` (trivially when `V === 1`).
- `transitionCard` is async (cross-issue contract with F19 r4).

## Observed failure (unchanged)

`Canonical hierarchy invariant failed: cards/index.json entry for 'project' does not match by-id record.` — [src/cards/card-store.ts#L73](../../../src/cards/card-store.ts#L73). The G2/T23 steady-state probe reads the hard-coded `{ canonical: 'ok' }` literal at [src/server/routes/operator-contracts.ts#L88](../../../src/server/routes/operator-contracts.ts#L88), not a live consistency check.

## Concurrency framing (unchanged)

`mutateCard` / `update` / `setStatus` / `create` / `delete` / `archiveAndDeleteSubtree` / `updateDependsOn` bodies are synchronous JS today; a normal Fastify handler cannot schedule another mutation between two `renameSync` calls. The r1 "HTTP read race during a synchronous mutation" hypothesis stays withdrawn. Only three failure classes can produce the observed drift: crash between by-id rename and `cards/index.json` write; out-of-band writer; synchronous event-bus reentrancy. After F13, classes 1 and 3 are unrepresentable (no `cards/index.json`, no synchronous `card_history_record_appended` re-entry path).

## Mutation-path inventory (carried from r4)

Unchanged. `recomputeBlocks` disappears as on-disk write and becomes an in-memory derivation. `archiveAndDeleteSubtree` is the only multi-card mutation; its survivor-rewrite semantics are defined in [02-design-r5.md](02-design-r5.md) §"Multi-card mutation atomicity".

## History contract (BINDING — resolves r4 review item 1)

### Sequence invariant

For every card `c` with `c.version_seq = V`:

- `V >= 1` always (project creation produces `V = 1`).
- `total >= V - 1`. For `V === 1` this is `total >= 0`, trivially satisfied by an empty/absent history file.
- `max(history[].version_seq) === V - 1` when `V >= 2`; undefined (no rows) when `V === 1`.
- History rows are contiguous: `{ history[].version_seq }` equals `{1, 2, ..., V - 1}` for `V >= 2`; the empty set when `V === 1`.
- A history row's `version_seq = N` is the snapshot of `c` **before** the mutation that produced `c.version_seq = N + 1`. So `history[0]` (newest first, `version_seq = V - 1`) shows the state just prior to the most recent commit.

### Websocket payload note

The durable history row uses the pre-mutation `version_seq`. The websocket `card_history_appended` event payload is free to additionally report the post-mutation `card.version_seq` in its envelope; that does not change the durable JSONL row. F13 keeps the existing event payload shape (no behaviour regression for current subscribers) and the row stored on disk uses the pre-mutation `version_seq`.

### `CardHistoryEntry` semantics table (resolves r4 review item 1)

`kind` is a required field on every entry; `entry_id: string` (UUID) is required on every entry. `version_seq` is strictly positive on every entry (the existing `cardHistoryEntrySchema` `z.number().int().positive()` constraint at [src/schemas/validators.ts#L23](../../../src/schemas/validators.ts#L23) is preserved verbatim, as are the route rejections `seq <= 0` at [src/server/routes/operator-contracts.ts#L128](../../../src/server/routes/operator-contracts.ts#L128) and `from <= 0` / `to <= 0` at [src/server/routes/operator-contracts.ts#L140](../../../src/server/routes/operator-contracts.ts#L140) and the response-schema `z.number().int().positive()` constraints at [src/contracts/operator-api.ts#L158](../../../src/contracts/operator-api.ts#L158)).

| `kind` | `version_seq` value | `snapshot` content | Route visibility (`GET /api/cards/<id>/history`, `history/<seq>`, `diff?from=&to=`) | Notes |
| --- | --- | --- | --- | --- |
| `create` | **n/a** | **n/a** | **No public history row.** Creation is the `version_seq = 1` baseline; the first history row appears at `version_seq = 1` after the first mutation, when `card.version_seq` becomes 2. `GET history/0` and `diff?from=0` continue to return HTTP 400 (rejected by the existing positive-seq route guards). | `applyMutation` for `create` writes the by-id record (and its commit marker for crash-safety), but **does NOT append a history row**. The card's `version_seq = 1` is its own historical baseline; the first row written under any other `kind` carries `version_seq = 1` and a `snapshot` equal to the just-created `CardRecord`. |
| `update` | pre-mutation `card.version_seq` (i.e. `V_before`, always `>= 1`) | pre-mutation full `CardRecord` snapshot | Visible. | Produced by `CardStore.update`. |
| `status` | `V_before` (`>= 1`) | pre-mutation snapshot | Visible. | Produced by `CardStore.setStatus`. `changed_fields` always contains `"status"`. |
| `mutate` | `V_before` (`>= 1`) | pre-mutation snapshot | Visible. | Produced by `CardStore.mutateCard` (composite patch from analyst/planner tools). |
| `depends` | `V_before` (`>= 1`) | pre-mutation snapshot of the dependent card | Visible on the dependent card's history only. | Produced by `CardStore.updateDependsOn`. Does NOT write history rows on neighbours whose in-memory `blocks` array recomputes; the inverse adjacency is derived and not authoritative. |
| `delete` | `V_before` (`>= 1`) | pre-mutation full snapshot (the last-known state of the now-deleted card) | Visible. The deleted card's history file (`cards/history/<id>.history.jsonl`) is preserved on disk; `GET /api/cards/<id>/history` and `history/<seq>` continue to resolve for a deleted card; the `GET /api/cards/<id>` lookup returns 404 for the live record. `diff?from=&to=` resolves up to the final `delete` row. | Final row in the file. No further appends. |
| `archive` | `V_before` (`>= 1`) for each archived card | pre-mutation full snapshot per card | Visible per-card with the same semantics as `delete`. | Emitted by `archiveAndDeleteSubtree`; one row per archived card, all sharing the same `group_token` (recorded inside the commit marker, not in the row itself). |

Rules common to every kind that **does** produce a history row:

- `entry_id` is generated once per logical mutation and stored in both the commit marker and the JSONL row; recovery uses `entry_id` to make `appendSyncIdempotent` exactly-once.
- `version_seq` is always `>= 1`. There is no seq-0 row at any layer — schema, route, diff response, ledger, or test fixture.
- `changed_fields` is the full diff between the pre- and post-mutation `CardRecord` (the deleted `TRACKED_FIELDS` / `TRACKED_UPDATE_FIELDS` / `TRACKED_EDIT_FIELDS` split is gone). For `delete` / `archive`, `changed_fields` is `[]` (the row records the final state, not a diff). For every single-PATCH operator-contract test, the row's `changed_fields` is **non-empty** and lists the actually-changed field.
- Deleted-card history remains queryable: the `cards/history/<id>.history.jsonl` file is not unlinked when the by-id record is removed, and the operator/agent routes still serve it.

Note: removing the seq-0 row means `create` does NOT participate in the contiguous-history check at boot. The boot invariant in [02-design-r5.md](02-design-r5.md) §"Boot recovery" explicitly forbids any row with `version_seq < 1` and treats a row with `version_seq < 1` as `CardStoreInvariantError`.

## Schema fanout (COMPLETE — resolves r3 analysis-review item 3, unchanged from r4)

The current contract surfaces use `z.record(z.string(), z.unknown())` for both history responses, not the entry schema. F13 tightens both:

Backend Zod surfaces:

- [src/schemas/types.ts#L55](../../../src/schemas/types.ts#L55) — `CardHistoryEntry` gains `entry_id: string` and `kind: CardHistoryKind`. Add `CardHistoryKind` union. `CardHistoryKind` excludes `create` (no public row).
- [src/schemas/validators.ts#L23](../../../src/schemas/validators.ts#L23) — `cardHistoryEntrySchema` adds `entry_id: z.string().uuid()` and `kind: z.enum([...])`. `version_seq` stays `z.number().int().positive()`. The `z.lazy(...)` wrapper around the entry schema is preserved only as the exported alias; a concrete base object is introduced for `.omit()` mechanics (see [03-plan-r5.md](03-plan-r5.md) §"Schema changes").
- [src/schemas/index.ts](../../../src/schemas/index.ts) — re-export `CardHistoryKind`.
- [src/contracts/operator-api.ts#L156](../../../src/contracts/operator-api.ts#L156) — `CardHistoryListResponseSchema` tightens to `z.array(cardHistoryHeaderSchema)`.
- [src/contracts/operator-api.ts#L157](../../../src/contracts/operator-api.ts#L157) — `CardHistoryEntryResponseSchema` tightens to `z.object({ entry: cardHistoryEntrySchema })`.
- [src/contracts/operator-api.ts#L158](../../../src/contracts/operator-api.ts#L158) — `CardDiffResponseSchema` keeps `from`/`to` as `z.number().int().positive()`. No diff query ever traverses seq 0.
- [src/contracts/index.ts](../../../src/contracts/index.ts) — export `cardHistoryHeaderSchema`, the tightened response schemas, and their inferred types.

Agent-tool surfaces:

- [src/tools/agent-tools.ts](../../../src/tools/agent-tools.ts) — `list_card_history` and `get_card_history_entry` tools pull schemas from the contracts above; any test stub passing `{}` fails Zod validation.

Web surfaces:

- [web/src/api/types.ts#L240](../../../web/src/api/types.ts#L240) — `CardHistoryHeader` interface gains `entry_id: string` and `kind: CardHistoryKind`.
- [web/src/api/types.ts#L251](../../../web/src/api/types.ts#L251) — `CardHistoryEntry` extends the header so it inherits the new fields.
- [web/src/api/types.ts#L789](../../../web/src/api/types.ts#L789) — `CardHistoryListResponse` and `CardHistoryEntryResponse` types follow the contract; no shape change beyond the field additions.
- [web/src/api/client.ts](../../../web/src/api/client.ts) — typed through the contract import; no runtime change.
- [web/src/stores/cards.ts](../../../web/src/stores/cards.ts) — cache shape unchanged; types follow.
- [web/src/__tests__/card-history-panel.test.ts](../../../web/src/__tests__/card-history-panel.test.ts), [.../card-history-panel-analyst-filter.test.ts](../../../web/src/__tests__/card-history-panel-analyst-filter.test.ts), [.../operator-dashboard-smoke.test.ts](../../../web/src/__tests__/operator-dashboard-smoke.test.ts) — every fixture gains `entry_id` (use `crypto.randomUUID()`) and `kind`. No fixture carries seq 0.

Backend test fixtures:

- [tests/agents/card-history-tools.test.ts](../../../tests/agents/card-history-tools.test.ts), [tests/api/cards-history.test.ts](../../../tests/api/cards-history.test.ts), [tests/utils/card-history.test.ts](../../../tests/utils/card-history.test.ts), [tests/server/runtime-card-contract-routes.test.ts](../../../tests/server/runtime-card-contract-routes.test.ts), [tests/server/operator-api-contracts.test.ts](../../../tests/server/operator-api-contracts.test.ts), [tests/server/operator-api-contract-fixtures.test.ts](../../../tests/server/operator-api-contract-fixtures.test.ts), [tests/schemas.test.ts](../../../tests/schemas.test.ts) — every fixture has `version_seq >= 1`.

Per the architecture-first rule, no reader tolerates missing `entry_id` / `kind`; pre-F13 on-disk history files are not read by post-F13 code. Rollback is "revert PR" or "reset local `.saivage` state".

## F12 closure inside F13 (resolves r4 cross-check item 1 — provenance now F12 r4)

Every state-changing call to `CardStore` that bumps `version_seq` produces exactly one history entry inside `applyMutation`. `create` is the lone exception: it bumps `version_seq` to 1 (from the not-yet-existing state) and writes no public history row. The full list of F12 **r4** acceptance tests F13 must keep green is cross-linked verbatim from [../F12-card-history-empty/03-plan-r4.md](../F12-card-history-empty/03-plan-r4.md) §(b); see [03-plan-r5.md](03-plan-r5.md) §"Absorbed F12 acceptance shape" for the enumerated list.

## `transitionCard` is async (binding cross-issue note)

`CardStore.transitionCard` (the F19 r4 entrypoint for promoting a card into the active runtime) becomes `async` and routes its on-disk effects through `applyMutation`. F13 does not own its body but does own the contract: every `transitionCard` call composes with the project mutex + `ProjectLock.withLock` (see [02-design-r5.md](02-design-r5.md) §"Locking model"), produces one history row with `kind: 'status'`, one `card_history_appended` event, and a `card.version_seq` bump. F19 r4 and F13 must land together or in dependency order; the F13 plan's async-constructor fanout grep includes the `transitionCard` call sites so the migration is mechanical.

## Source-of-truth decision (unchanged)

Authoritative on disk: `cards/by-id/<id>.json`, `cards/history/<id>.history.jsonl`, `cards/.commit/<token>.json`. Deleted from the on-disk layout: `cards/index.json`, `cards/dependencies/depends-on.json`, `cards/dependencies/blocks.json`, `cards/tree/<id>.children.json`, `cards/tree/` directory, `cards/dependencies/` directory, `cards/views/` directory (no subsystem reads or writes it; grep across `src/`, `tests/`, `web/` confirms only the `SAIVAGE_DIRS` declaration and the file-tree test expectation reference it), `cards/blocks.json` (legacy). The `HierarchyGraph.build` index↔by-id equality throw becomes unrepresentable.

## `canonicalHealth` surfaces (unchanged)

`CardStore.getHealth()`, the hard-coded `/api/state` literal, and the websocket field are all deleted; full grep list in [03-plan-r5.md](03-plan-r5.md) §"Dead-code inventory".

## Boot replay / recovery cost (resolves r4 review item 1, boot path)

Always load every `cards/by-id/*.json` (bounded by card count, sub-100 ms on target). Recover any markers in `cards/.commit/` (empty in steady state). Build in-memory adjacency. Run startup invariant: per card with `V >= 2`, the per-card history file must contain a contiguous run of rows `{1..V-1}` (after de-dup by `entry_id` and marker-driven recovery); per card with `V === 1`, the history file must be absent or empty. Any gap, duplicate, any row with `version_seq < 1`, any row with `version_seq > V - 1`, or any orphan is a fatal `CardStoreInvariantError`.

## Assumptions still unverified by code reading alone

- Whether a controlled `SIGKILL` between by-id rename and `cards/index.json` write reliably produces the observed `errors.jsonl` line on the next boot. Proven by the injected-failure tests in [03-plan-r5.md](03-plan-r5.md) §"Crash-injection test matrix".
- Whether any current subscriber to `card_history_record_appended` re-enters the store. Static grep shows none; the event kind is deleted regardless.
- Whether any out-of-band process writes into `.saivage/cards/`. After F13, an out-of-band by-id rewrite is honoured on next `CardStore.open` (subject to the contiguous-history invariant); writing into `cards/.commit/` is an operator-deliberate act and recovery refuses to silently discard a corrupt marker.
