# F13 — Functional Analysis (r3)

Supersedes [01-analysis-r2.md](01-analysis-r2.md). Addresses [01-analysis-review-r2.md](01-analysis-review-r2.md) and the orchestrator decision that **F13 is the umbrella workstream that subsumes F12**; F12 r3 will be a closure pointer plus its acceptance shape (the F12-specific tests F13 must keep passing).

## Ownership (binding)

F13 owns the rewrite of [src/cards/card-store.ts](../../../src/cards/card-store.ts), the history semantics, the persistence protocol (commit markers + idempotent recovery), the locking model, and the event ownership. F12 no longer has an independent implementation surface; its acceptance criteria are absorbed into [03-plan-r3.md](03-plan-r3.md) §"Absorbed F12 acceptance shape". No code in `src/cards/`, `src/projections/ledger-projections.ts`, `src/persistence/file-tree.ts`, `src/server/routes/operator-contracts.ts`, or `src/contracts/operator-api.ts` is edited by two PRs.

This resolves analysis-review item 2 and coordination items 1–4 from [01-analysis-review-r2.md](01-analysis-review-r2.md).

## Observed failure (unchanged from r2)

`Canonical hierarchy invariant failed: cards/index.json entry for 'project' does not match by-id record.` Thrown by `HierarchyGraph.build` ([src/cards/card-store.ts](../../../src/cards/card-store.ts#L73)). Observed twice in the same Phase-2 sweep (G1/T20, G5/T45, ts `2026-05-23 13:51:55`). Steady-state probe G2/T23 reads the literal `{ canonical: 'ok' }` hard-coded at [src/server/routes/operator-contracts.ts](../../../src/server/routes/operator-contracts.ts#L88), not a live consistency check.

## Concurrency framing (kept from r2)

`mutateCard` / `update` / `setStatus` / `create` / `delete` / `archiveAndDeleteSubtree` / `updateDependsOn` bodies are synchronous JavaScript with no internal `await`. A normal Fastify handler **cannot** schedule another mutation between two `renameSync` calls on the same event loop. The r1 "HTTP read races between step 2 and 3 of a synchronous mutation" claim stays withdrawn.

Only three failure classes can produce the observed drift:

1. **Crash between by-id rename and `cards/index.json` write.** `validatePersistedState` ([src/cards/card-store.ts](../../../src/cards/card-store.ts#L327)) throws on the next boot. The throw is re-raised out of the constructor, so the store never serves requests in that state — every API call fails until the operator intervenes.
2. **Cross-process or out-of-band writer.** Any process that rewrites `cards/index.json` or `cards/by-id/<id>.json` without holding the project lock produces exactly the observed log. `JsonlLedger`'s `ProjectLock` is only held inside the history append; nothing locks the by-id ↔ index pair as a unit today.
3. **Synchronous event-bus reentrancy from step 1.** `eventBus.emit('card_history_record_appended', …)` at [src/cards/card-store.ts](../../../src/cards/card-store.ts#L544) is synchronous. No current subscriber re-enters `CardStore` mutating methods (grep over `eventBus.on('card_history_record_appended')` in `src/cards/notifications/index.ts` confirms), but the contract does not forbid it.

The "boot self-heal" story from r1 remains an unproven hypothesis; the F13 plan ships an injected-failure test at the by-id/index boundary that decides whether the observed log is crash residue, cross-process drift, or a third path. See [03-plan-r3.md](03-plan-r3.md) §"Crash-injection test matrix".

## Mutation-path inventory (carried from r2, with `recomputeBlocks` clarified)

| Path | Files written today | History today | Post-F13 fate |
| --- | --- | --- | --- |
| `mutateCard` ([card-store.ts#L811](../../../src/cards/card-store.ts#L811)) | by-id, index, deps (opt), blocks (opt), history | yes | merged into single `applyMutation`; history mandatory |
| `update` / `setStatus` ([card-store.ts#L801](../../../src/cards/card-store.ts#L801), [#L1090](../../../src/cards/card-store.ts#L1090)) | by-id, index, deps (opt), blocks (opt) | **no** (F12 bug) | merged into `applyMutation`; history mandatory |
| `create` ([card-store.ts#L749](../../../src/cards/card-store.ts#L749)) | by-id, index, deps, blocks | no | `applyMutation` with `kind: 'create'`; history mandatory (version_seq=1) |
| `delete` ([card-store.ts#L917](../../../src/cards/card-store.ts#L917)) | by-id (unlink), index, deps, blocks | no | `applyMutation` with `kind: 'delete'`; final history line |
| `archiveAndDeleteSubtree` ([card-store.ts#L965](../../../src/cards/card-store.ts#L965)) | many by-id (unlink), index, deps, blocks | no | single `applyMutation` group with one group commit marker (see below); descendants-first ordering proof in [02-design-r3.md](02-design-r3.md) |
| `updateDependsOn` ([card-store.ts#L1039](../../../src/cards/card-store.ts#L1039)) | deps, blocks, by-id (`.depends_on` field) | no | `applyMutation` with `kind: 'depends'`; mutates the dependent card record only |
| `recomputeBlocks` ([card-store.ts#L1090](../../../src/cards/card-store.ts#L1090)) | blocks.json (today) | no | **disappears as on-disk write.** Becomes an in-memory helper that recomputes `card.blocks` arrays from `card.depends_on` during read/load. Not a `CardStore` public API after F13. See §"`recomputeBlocks` fate" below. |
| `initProjectTree` ([persistence/file-tree.ts#L148](../../../src/persistence/file-tree.ts#L148)) | by-id/project.json, index.json, tree/project.children.json, deps/depends-on.json, deps/blocks.json | no | writes by-id/project.json only; the four derived files are deleted from on-disk layout |

This resolves analysis-review item 4: `recomputeBlocks` is no longer a mutation path that writes a projection — there is no projection to write — and it does not appear in the F12 closure table because it is no longer a public mutation.

## Schema-level consequences (new — resolves analysis-review item 3)

The F12 closure table in [03-plan-r3.md](03-plan-r3.md) writes `kind: 'create' | 'update' | 'status' | 'mutate' | 'delete' | 'archive' | 'depends'` and the commit-marker idempotent-recovery logic requires `entry_id`. Today's `CardHistoryEntry` ([src/schemas/types.ts](../../../src/schemas/types.ts#L55), [src/schemas/validators.ts](../../../src/schemas/validators.ts#L23)) has neither field. F13 therefore changes the durable wire shape:

```ts
export type CardHistoryKind =
  | 'create' | 'update' | 'status' | 'mutate' | 'delete' | 'archive' | 'depends';

export interface CardHistoryEntry {
  entry_id: string;                       // UUID, written exactly once per logical mutation
  kind: CardHistoryKind;                  // routing tag for renderers and idempotent recovery
  card_id: string;
  version_seq: number;                    // post-bump version of the card
  snapshot: CardRecord;                   // unchanged
  changed_at: string;
  changed_by_actor: NoteAuthor;
  changed_by_surface: ControlActionSurface;
  change_reason: string | null;
  changed_fields: string[];
  change_summary: string;
}
```

Fanout (full list in [03-plan-r3.md](03-plan-r3.md) §"Schema fanout"): [src/schemas/validators.ts](../../../src/schemas/validators.ts#L23) `cardHistoryEntrySchema`, [src/schemas/types.ts](../../../src/schemas/types.ts#L55) `CardHistoryEntry`, the contract response in [src/contracts/operator-api.ts](../../../src/contracts/operator-api.ts#L151), the agent tool registration in [src/tools/agent-tools.ts](../../../src/tools/agent-tools.ts#L103), the analyst tool diff renderer in [src/agents/analyst-tools.ts](../../../src/agents/analyst-tools.ts#L120), the web HTTP client at [web/src/api/client.ts](../../../web/src/api/client.ts#L183), the Pinia store at [web/src/stores/cards.ts](../../../web/src/stores/cards.ts#L307), the dashboard history panel tests under [web/src/__tests__/card-history-panel.test.ts](../../../web/src/__tests__/card-history-panel.test.ts), and every backend test that builds a `CardHistoryEntry` fixture (full list in plan).

Per the architecture-first rule there is no migration shim and no reader that tolerates missing `entry_id` / `kind`. Pre-F13 history files on disk are not read by post-F13 code; rollback is "revert PR" or "reset local `.saivage` state", not bidirectional compatibility.

## `canonicalHealth` surfaces (carried from r2)

- `CardStore.getHealth()` ([src/cards/card-store.ts](../../../src/cards/card-store.ts#L461)) — in-memory "last mutation succeeded" flag, the only signal that is live.
- `/api/state` returns `cardStoreHealth: { canonical: 'ok' }` as a **hard-coded literal** ([src/server/routes/operator-contracts.ts](../../../src/server/routes/operator-contracts.ts#L88)). False as a health signal; explains G2/T23.
- Websocket snapshot reads the in-memory flag ([src/server/websocket.ts](../../../src/server/websocket.ts#L95)).

Post-F13: with `cards/index.json` deleted from the on-disk layout (see §"Source-of-truth decision"), the canonical-mismatch invariant in `HierarchyGraph.build` is **unrepresentable**. The `canonicalHealth` field, schema, route literal, websocket field, and dashboard consumers all become dead weight and are deleted. Full deletion list in [03-plan-r3.md](03-plan-r3.md) §"Dead-code inventory".

## Source-of-truth decision (binding — resolves design-review item 1 and coordination items)

The chosen layout is the **slimmer F12 B.1 stance applied inside the F13 framework**:

- `cards/by-id/<id>.json` — the only authoritative card-state file. Atomic via temp + rename.
- `cards/history/<id>.history.jsonl` — append-only audit log. Authoritative for audit, never replayed to reconstruct current state.
- `cards/.commit/<token>.json` — durable commit markers (new directory; empty in steady state). Recovery uses the marker plus `entry_id` to make the by-id rename and history append idempotent.

**Deleted from the on-disk layout** (no projection writer, no derived files at rest):

- `cards/index.json`
- `cards/dependencies/depends-on.json`
- `cards/dependencies/blocks.json`
- `cards/tree/<id>.children.json` and the whole `cards/tree/` directory
- `cards/blocks.json` (if present anywhere; legacy form)

These files are not re-emitted on boot, not rewritten on mutation, and not consumed by any production reader. In-memory derivation (parent index, depends-on adjacency, blocks adjacency, children-by-parent) lives in `CardStoreState` and is rebuilt from the by-id glob on `CardStore.open` and after each mutation. The dashboard, CLI, and analyst tools read through the in-memory `CardStore` API; no consumer reads the deleted files. The `cards/index.json`-stale-cache failure mode, the projection-write failure semantics question (design-review item 6), and the boot-regenerates-every-projection-on-every-boot ergonomics concern all evaporate.

This makes the `HierarchyGraph.build` index↔by-id equality throw **unrepresentable** because there is nothing on disk to disagree with the by-id record.

## `recomputeBlocks` fate (resolves analysis-review item 4)

`CardStore.recomputeBlocks()` ([card-store.ts#L1090](../../../src/cards/card-store.ts#L1090)) and the `cards/dependencies/blocks.json` file are both deleted. The `blocks` adjacency is computed in-memory by inverting `card.depends_on` across the by-id set at `CardStore.open` and again whenever `applyMutation` runs (incrementally for the touched card and its prior/new dependents). It is **not** a public method on `CardStore`. The `card.blocks` field on `CardRecord` is populated from this in-memory adjacency at write time so the by-id record itself remains self-consistent for read paths (the existing `read()` shape is preserved). No public API regression.

## F12 closure inside F13 (resolves analysis-review item 2)

Every state-changing call to `CardStore` produces an audit entry by construction inside `applyMutation`. The `TRACKED_FIELDS` / `TRACKED_UPDATE_FIELDS` / `TRACKED_EDIT_FIELDS` split is deleted (it was the source of the F12 silent-update bug); `changed_fields` is computed as the full diff between the pre- and post-mutation card. The stale [tests/utils/card-history.test.ts#L43](../../../tests/utils/card-history.test.ts#L43) assertion ("update without tracked fields does not append history") is rewritten to assert the opposite contract.

F12-specific acceptance criteria that F13 must keep green:

- `GET /api/cards/<id>/history` returns `total > 0` and `max(history[].version_seq) === card.version_seq` after any successful mutation through any code path (HTTP, runtime, analyst, planner).
- PATCH `/api/cards/<id>` with a previously-untracked field (e.g. `status`) appends exactly one history line with `kind: 'update'` (or `kind: 'status'` if `setStatus` is the entrypoint) and `changed_fields` containing the field name.
- `card_history_appended` websocket event fires exactly once per `applyMutation`.
- The startup invariant check (replaces the deleted silent `reconcileCardHistory`) throws a loud `CardStoreInvariantError` on an orphan history tail whose `entry_id` does not match a recoverable commit marker.

Full F12 test list in [03-plan-r3.md](03-plan-r3.md) §"Absorbed F12 acceptance shape".

## Boot replay / recovery cost (resolves design-review item 4 and bounds the slimmer surface)

The slimmer surface makes the boot bound trivially honest:

- **Always: load every `cards/by-id/*.json`.** Bounded by current card count. Target projects ≤ 200 cards, typical ≤ 50. Each file is < 16 KB. On the deployment hardware (LXC container, local disk), loading 200 files is sub-100 ms.
- **Sometimes: recover outstanding commit markers in `cards/.commit/`.** Steady-state count is 0. After a crash, at most one marker per in-flight mutation; a `archiveAndDeleteSubtree` crash leaves one **group** marker (see [02-design-r3.md](02-design-r3.md) §"Multi-card mutation atomicity") regardless of subtree size. Recovery cost is O(markers) and each marker recovery is one rename + one idempotent JSONL append + one unlink + one fsync of the marker directory.
- **Always: build in-memory adjacency** (parent, depends-on, blocks-inverse, children-by-parent). O(N cards) with one pass.
- **Never: full event-log replay.** There is no global event log to replay; history files are per-card and authoritative only for audit.

No derived files are written on boot (because none exist on disk). `git status` is unaffected. Readiness gate: `Runtime.open` (and `ActiveRuntime.open`, and `createServer`) `await`s `CardStore.open` before any route handler can land — see [03-plan-r3.md](03-plan-r3.md) §"Async construction chain".

## Assumptions still unverified by code reading alone

- Whether a controlled `SIGKILL` between by-id rename and `cards/index.json` write reliably produces the observed `errors.jsonl` line on the next boot. Proven by the injected-failure tests in [03-plan-r3.md](03-plan-r3.md) §"Crash-injection test matrix".
- Whether any current subscriber to `card_history_record_appended` re-enters the store. Static grep over `src/` shows none; the event kind is being deleted regardless, so the question becomes moot.
- Whether any out-of-band process writes into `.saivage/cards/`. After F13, the only durable artifacts are by-id and history; an out-of-band writer rewriting a by-id file is honored on the next `CardStore.open` (no cross-file invariant can be violated), and writing into `cards/.commit/` requires the operator to be doing something deliberate.
