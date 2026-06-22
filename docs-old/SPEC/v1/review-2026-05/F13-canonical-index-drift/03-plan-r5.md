# F13 — Implementation Plan (r5)

Supersedes [03-plan-r4.md](03-plan-r4.md). Addresses plan-review items 1–3 in [01-analysis-review-r4.md](01-analysis-review-r4.md) and the orchestrator-binding r5 decisions. Companion: [01-analysis-r5.md](01-analysis-r5.md), [02-design-r5.md](02-design-r5.md). F13 is the umbrella; **F12 r5** is the closure pointer plus its absorbed acceptance shape (§"Absorbed F12 acceptance shape").

## Validation baseline (MUST use package scripts only — resolves r4 review plan item 2)

Run from `/home/salva/g/ml/saivage-v3/`.

```
npm run typecheck
npm run lint
npm run test:direct -- \
  tests/utils/card-store.test.ts \
  tests/utils/card-history.test.ts \
  tests/utils/card-store-startup-refusal.test.ts \
  tests/utils/card-store-state.test.ts \
  tests/utils/apply-mutation.test.ts \
  tests/utils/card-store-crash-injection.test.ts \
  tests/utils/card-store-boot-recovery.test.ts \
  tests/utils/file-tree.test.ts \
  tests/projections/ledger-projections.test.ts \
  tests/persistence/persistence-primitives.test.ts \
  tests/api/cards-history.test.ts \
  tests/agents/card-history-tools.test.ts \
  tests/server/card-routes-authz-audit.test.ts \
  tests/server/runtime-card-contract-routes.test.ts \
  tests/server/operator-api-contracts.test.ts \
  tests/server/operator-api-contract-fixtures.test.ts \
  tests/server/websocket-analyst-safety.test.ts \
  tests/server/server-availability-contract.test.ts \
  tests/runtime/runtime-activation-ledger.test.ts \
  tests/runtime/runtime-command-ledger.test.ts \
  tests/schemas.test.ts
npm run docs:verify
```

Web (run from repo root; the scripts `cd web` internally):

```
npm run web:typecheck
npm run web:test:control-room
npm run web:test:store:cards
npm run web:test:analyst-ui
npm run web:test:operator-smoke
npm run web:test:card-history-panel
```

Add the new script to [package.json](../../../package.json) alongside the existing `web:test:operator-smoke` at [L70](../../../package.json#L70):

```jsonc
"web:test:card-history-panel": "cd web && npx vitest run src/__tests__/card-history-panel.test.ts"
```

No raw `cd web && npx vitest …` invocation appears in this plan; every web test runs through an `npm run ...` script.

Final gate:

```
npm run preflight     # web:test:sweep + docs:verify
npm test              # full Jest suite
npm run validate:release
```

### Live probe

After any successful mutation against `http://10.0.3.112:8080`, `GET /api/cards/<id>` returns `card`, `GET /api/cards/<id>/history` returns `list`. Assert:

- `list.total >= card.version_seq - 1` (trivially satisfied as `0 >= 0` for a card at `version_seq === 1`).
- `max(list.history[].version_seq) === card.version_seq - 1` for any card with `card.version_seq >= 2`.
- Every entry in `list.history` has a non-empty `entry_id` (UUID) and a `kind` ∈ `{update, status, mutate, delete, archive, depends}` — **no `create` row ever appears in the public history**.
- `GET /api/cards/<id>/history/<seq>` succeeds (HTTP 200) for every `seq` in `{1, ..., card.version_seq - 1}`.
- `GET /api/cards/<id>/history/0` returns HTTP 400 (existing positive-seq guard).
- `GET /api/cards/<id>/diff?from=1&to=card.version_seq - 1` (for `card.version_seq >= 2`) succeeds and returns a non-empty `changed_fields`.
- `GET /api/cards/<id>/diff?from=0&to=1` returns HTTP 400 (existing positive-`from` guard).
- `.saivage/runtime/errors.jsonl` shows no new `Canonical hierarchy invariant failed` line during a 5-minute soak.

## Async construction chain (unchanged from r4 in shape; reworded for the real lock API)

TS constructors cannot be `async`. Each factory builds dependencies in **local variables**, then passes them to a `private` constructor — no `this` is referenced before construction.

### `CardStore.open`

```ts
class CardStore {
  static async open(projectRoot: string, eventBus: EventBus, maxGoalDepth?: number): Promise<CardStore> {
    const mutex = new ProjectMutex();
    const projectLock = new ProjectLock(join(projectRoot, '.saivage', 'project.lock'));
    const state = await loadCardStoreState(projectRoot);
    return new CardStore({ projectRoot, eventBus, mutex, projectLock, state, maxGoalDepth });
  }
  private constructor(deps: CardStoreDeps) { /* assign fields only; no I/O */ }
}
```

`ProjectLock` is constructed (not "created") and the existing `withLock` / `withLockSync` / `assertOwns` API is used unchanged. The constructor becomes `private`; every `new CardStore(...)` call site is converted to `await CardStore.open(...)`.

### `Runtime.open`, `ActiveRuntime.open`, `createServer` gating, `transitionCard`, async-constructor fanout appendix

All unchanged in shape from [03-plan-r4.md](03-plan-r4.md) §"Async construction chain". The grep gate `rg -n 'new CardStore\(|new Runtime\(|new ActiveRuntime\(' src tests web/src` must return zero matches after the sweep. Test-helper factories live in `tests/_setup/card-store-factory.ts` and `tests/_setup/runtime-factory.ts`.

## Schema changes (resolves r4 review plan item 1)

`cardHistoryEntrySchema` is exported as `z.ZodType<CardHistoryEntry>` via `z.lazy(...)` ([src/schemas/validators.ts#L23](../../../src/schemas/validators.ts#L23)) and **does not expose `.omit()`**. Fix this by introducing a concrete base object schema first, then defining both the entry and the header off the base. Apply in this order:

1. [src/schemas/types.ts#L55](../../../src/schemas/types.ts#L55) — add the `CardHistoryKind` union (no `create` member: `'update' | 'status' | 'mutate' | 'depends' | 'delete' | 'archive'`) and the two fields on `CardHistoryEntry`. Add `CardHistoryHeader = Omit<CardHistoryEntry, 'snapshot'>`.
2. [src/schemas/validators.ts#L23](../../../src/schemas/validators.ts#L23) — replace the existing `z.lazy` one-liner with the following three definitions:

   ```ts
   const cardHistoryEntryBaseSchema = z.object({
     card_id: z.string().min(1),
     version_seq: z.number().int().positive(),
     snapshot: cardRecordSchema,
     changed_at: z.string().datetime(),
     changed_by_actor: noteAuthorSchema,
     changed_by_surface: controlActionSurfaceSchema,
     change_reason: z.string().nullable(),
     changed_fields: z.array(z.string()),
     change_summary: z.string(),
     entry_id: z.string().uuid(),
     kind: z.enum(['update', 'status', 'mutate', 'depends', 'delete', 'archive']),
   });
   export const cardHistoryHeaderSchema = cardHistoryEntryBaseSchema.omit({ snapshot: true });
   export const cardHistoryEntrySchema: z.ZodType<import('./types.js').CardHistoryEntry> =
     cardHistoryEntryBaseSchema;
   ```

   Rationale: `.omit()` is a method on `ZodObject`, not on `ZodType`. The base object schema preserves the `ZodObject` shape so `.omit({ snapshot: true })` works. The exported `cardHistoryEntrySchema` keeps its declared type as `z.ZodType<CardHistoryEntry>` so consumers see no API change. `version_seq` stays `z.number().int().positive()` — there is no seq-0 entry to admit. The `z.lazy(...)` wrapper is dropped because `cardRecordSchema` already handles the self-reference inside `CardRecord`; if a future schema change introduces a true recursive dependency between `CardHistoryEntry` and itself, wrap only the base schema's recursive field in `z.lazy`, not the whole entry export.

3. [src/schemas/index.ts](../../../src/schemas/index.ts) — re-export `CardHistoryKind`, `cardHistoryHeaderSchema`.
4. [src/contracts/operator-api.ts#L156](../../../src/contracts/operator-api.ts#L156) — replace `CardHistoryListResponseSchema = z.object({ history: z.array(z.record(z.string(), z.unknown())), total: ... })` with `z.object({ history: z.array(cardHistoryHeaderSchema), total: z.number().int().nonnegative() })`.
5. [src/contracts/operator-api.ts#L157](../../../src/contracts/operator-api.ts#L157) — replace `CardHistoryEntryResponseSchema = z.object({ entry: z.record(z.string(), z.unknown()) })` with `z.object({ entry: cardHistoryEntrySchema })`.
6. [src/contracts/operator-api.ts#L158](../../../src/contracts/operator-api.ts#L158) — keep `CardDiffResponseSchema` exactly as is (`from` / `to` are `z.number().int().positive()`).
7. [src/contracts/index.ts](../../../src/contracts/index.ts) — export the new schemas and their inferred types.
8. [src/cards/card-store.ts](../../../src/cards/card-store.ts) — every `CardHistoryEntry` constructed by `applyMutation` includes both new fields. The `create` path does NOT construct any entry.
9. [src/tools/agent-tools.ts](../../../src/tools/agent-tools.ts) — `list_card_history`, `get_card_history_entry` registrations pull from contracts; verify with `npm run typecheck`.
10. [src/agents/analyst-tools.ts#L120](../../../src/agents/analyst-tools.ts#L120) — drop `TRACKED_EDIT_FIELDS`; renderer reads `entry.changed_fields` directly.
11. [web/src/api/types.ts#L240](../../../web/src/api/types.ts#L240) — `CardHistoryHeader` gains `entry_id`, `kind`. `kind` excludes `'create'`.
12. [web/src/api/types.ts#L251](../../../web/src/api/types.ts#L251) — `CardHistoryEntry extends CardHistoryHeader` inherits the new fields.
13. [web/src/api/types.ts#L789](../../../web/src/api/types.ts#L789) — response types follow.
14. [web/src/api/client.ts](../../../web/src/api/client.ts) — typed through the contract; no runtime change.
15. [web/src/stores/cards.ts](../../../web/src/stores/cards.ts) — types follow.
16. Web mocks under [web/src/__tests__/__mocks__/](../../../web/src/__tests__/__mocks__/) and fixtures in [web/src/__tests__/](../../../web/src/__tests__/) — every history-entry fixture gains `entry_id` and `kind`; **no fixture uses `version_seq === 0` or `kind === 'create'`**. A freshly-mocked card starts at `version_seq === 1` with an empty `history` array.
17. Backend fixtures: [tests/agents/card-history-tools.test.ts](../../../tests/agents/card-history-tools.test.ts), [tests/api/cards-history.test.ts](../../../tests/api/cards-history.test.ts), [tests/utils/card-history.test.ts](../../../tests/utils/card-history.test.ts), [tests/server/runtime-card-contract-routes.test.ts](../../../tests/server/runtime-card-contract-routes.test.ts), [tests/server/operator-api-contracts.test.ts](../../../tests/server/operator-api-contracts.test.ts), [tests/server/operator-api-contract-fixtures.test.ts](../../../tests/server/operator-api-contract-fixtures.test.ts), [tests/schemas.test.ts](../../../tests/schemas.test.ts) — same: `entry_id` via `crypto.randomUUID()`, `kind` ∈ the six-value enum, `version_seq >= 1`. Add `tests/schemas.test.ts` cases asserting: (a) `cardHistoryEntrySchema` rejects entries missing `entry_id` or `kind`; (b) `cardHistoryEntrySchema` rejects `version_seq === 0`; (c) `cardHistoryEntrySchema` rejects `kind === 'create'`; (d) `CardHistoryListResponseSchema` rejects a list element missing `entry_id`.

## `initProjectTree` / `isNewSaivageState` (slim layout — resolves the r4 review plan item 3 decision)

[src/persistence/file-tree.ts](../../../src/persistence/file-tree.ts):

- `initProjectTree` ([:148](../../../src/persistence/file-tree.ts#L148)) writes only: `project.json`, `cards/by-id/project.json`, `notes/queue.json`, `views/leaderboard.json`, `views/saved-filters.json`, `skills/index.json`, `runtime/events.jsonl`, `runtime/errors.jsonl`, `supervision/reviews.jsonl`, `supervision/quarantine-index.json`, `saivage.json`. Removes writes of `cards/index.json`, `cards/tree/project.children.json`, `cards/dependencies/depends-on.json`, `cards/dependencies/blocks.json`.
- `SAIVAGE_DIRS` ([:75](../../../src/persistence/file-tree.ts#L75)) — **decision: remove `cards/views` along with `cards/tree` and `cards/dependencies`; add `cards/.commit`.** Rationale: `rg -n 'cards/views' src tests web` returns only the `SAIVAGE_DIRS` declaration itself and one line in `tests/utils/file-tree.test.ts` — no subsystem reads or writes it. Keeping a directory that no code touches violates the architecture-first guideline. Post-change `SAIVAGE_DIRS` slim-cards entries are exactly `['cards/by-id', 'cards/history', 'cards/.commit']`.
- `isNewSaivageState` ([:99](../../../src/persistence/file-tree.ts#L99)–`L118`) — drop the `cards/tree`, `cards/dependencies` required-dir entries and the `cards/index.json` validity check. Required check becomes: `cards/by-id`, `agents/sessions`, `agents/messages`, `runtime`, `notes/by-card`, `views`, `supervision` directories exist, plus `project.json`, `cards/by-id/project.json`, `notes/queue.json` parse against their schemas. The seed's `cards/by-id/project.json` carries `version_seq === 1` with no history file.
- **Negative checks against legacy state.** `isNewSaivageState` returns `false` if any of the following derived artifacts exist:
  - `cards/index.json`
  - `cards/tree/` directory (even if empty)
  - `cards/dependencies/` directory (even if empty)
  - `cards/dependencies/depends-on.json`
  - `cards/dependencies/blocks.json`
  - `cards/blocks.json` (legacy flat form)
  - `cards/views/` directory (even if empty)
- Delete `defaultCardIndexEntry`, `defaultDependsOnIndex`, `defaultBlocksIndex` ([:70](../../../src/persistence/file-tree.ts#L70)–`L72`).
- Delete the `cardIndexSchema` import at [:5](../../../src/persistence/file-tree.ts#L5).
- [tests/utils/file-tree.test.ts](../../../tests/utils/file-tree.test.ts): the expected post-`initProjectTree` listing of `.saivage/cards/` is updated to `['by-id', 'history', '.commit']` (sorted). The `'cards/views'` entry at L183 is removed. Add positive-rejection cases for the legacy artifacts listed above, including `cards/views/`. The card seed assertion checks `card.version_seq === 1` and `listCardHistory(card.id).length === 0`.

## Mutex implementation (unchanged from r4)

`package.json` does NOT include `async-mutex`. F13 does **not** add the dependency. Instead, add `src/cards/project-mutex.ts` (≈ 10 LOC, MIT-licensed local code, no third-party scope):

```ts
export class ProjectMutex {
  private chain: Promise<void> = Promise.resolve();
  async lock(): Promise<() => void> {
    let release!: () => void;
    const next = new Promise<void>((resolve) => { release = resolve; });
    const prior = this.chain;
    this.chain = this.chain.then(() => next);
    await prior;
    return release;
  }
}
```

Usage in `applyMutation` (canonical form — outer in-process mutex, inner `withLock`, event emission outside both):

```ts
const release = await projectMutex.lock();
let capturedPayload: CardHistoryAppendedPayload | null = null;
try {
  await projectLock.withLock(async (handle) => {
    // steps 2–8 of the on-disk write sequence, persistence calls take `handle`.
    // capturedPayload = ... (null for `create`).
  });
} finally {
  release();
}
if (capturedPayload !== null) {
  eventBus.emit('card_history_appended', capturedPayload);
}
```

Tests in [tests/utils/project-mutex.test.ts](../../../tests/utils/project-mutex.test.ts) (new): two concurrent `lock()` calls serialize; a `lock()` issued after a `release()` runs immediately; a `lock()` whose body throws still releases the chain so the next `lock()` proceeds.

## Absorbed F12 acceptance shape (copied VERBATIM from F12 r5 §(b))

The eight items below are reproduced verbatim from [../F12-card-history-empty/03-plan-r5.md](../F12-card-history-empty/03-plan-r5.md) §(b). F13 must keep all eight green; their pass/fail is the F12 closure signal. Every per-row `entry_id`/`kind` assertion below is mechanically guaranteed by §"Schema changes" above (the `cardHistoryEntrySchema` mandates UUID `entry_id` and the six-value `kind` enum) plus §"Live probe additions" below; the test-level assertions encode the contract explicitly.

### Backend Jest (paths relative to `/home/salva/g/ml/saivage-v3/`)

1. [tests/server/operator-api-contracts.test.ts](../../../tests/server/operator-api-contracts.test.ts) — add (or replace existing untracked-update assertion with):
   - `PATCH /api/cards/:id` with `{ title: "x" }` then `GET /api/cards/:id/history` → `total === 1`, `history[0].version_seq === 1`, `history[0].changed_fields` includes `"title"`, `max(history[].version_seq) === card.version_seq - 1`, **`history[0].entry_id` matches `/^[0-9a-f-]{36}$/i` and `history[0].kind` is in the allowed-literal set**.
   - `PATCH /api/cards/:id` with `{ status: "active" }` then `GET /api/cards/:id/history` → `total === 1`, `history[0].version_seq === 1`, `history[0].changed_fields` includes `"status"`, **`entry_id` and `kind` populated as above** (proves the previously-untracked path now produces history with full envelope).
   - After two consecutive PATCHes, `GET /api/cards/:id` returns `version_seq === 3`, `GET /api/cards/:id/history` returns `total === 2` with `version_seq` values `[2, 1]` (newest first), `total >= card.version_seq - 1`, `max(history[].version_seq) === 2 === card.version_seq - 1`, **every row carries a UUID-shape `entry_id` and an allowed `kind`; the two `entry_id` values are pairwise distinct**.
   - `GET /api/cards/:id/history/1` returns the pre-first-edit snapshot (not 404), **with `entry_id` and `kind` on the response header object identical to the row at `version_seq === 1` from the list endpoint**.
   - `GET /api/cards/:id/diff?from=1&to=2` returns a `changed_fields` list including `"title"` or `"status"` per the mutation above. **Every single-PATCH operator-contract case in this file additionally asserts `max(history[].version_seq) === card.version_seq - 1` post-mutation, and the diff assertion requires `changed_fields` to be non-empty and to contain the actually-changed field.**

2. [tests/api/cards-history.test.ts](../../../tests/api/cards-history.test.ts) — keep all current passing cases; remove any case that asserts `total === 0` after an `update()`/`setStatus()` mutation; add a case proving `total >= card.version_seq - 1` and `max(history[].version_seq) === card.version_seq - 1` after a mixed mutation sequence (`update`, `setStatus`, `mutateCard`, `updateDependsOn`). **Assert every returned row in the final list carries a UUID-shape `entry_id` and an allowed `kind`; assert pairwise uniqueness of `entry_id` across the full sequence.** Every item in the absorbed list also asserts the invariant `total >= card.version_seq - 1`.

3. [tests/server/websocket-analyst-safety.test.ts](../../../tests/server/websocket-analyst-safety.test.ts) — assert that `card_history_appended` is emitted exactly once per `applyMutation` that bumps `version_seq` (and writes a history row; `create` bumps `version_seq` to 1 but writes no row and emits no event), and that the event payload matches [src/contracts/operator-events.ts#L110-L119](../../../src/contracts/operator-events.ts#L110-L119). **The payload's `entry_id` is asserted to be UUID-shape and to match the `entry_id` of the corresponding row returned by `cards.history.list`; the payload's `kind` is asserted to be in the allowed literal set.**

4. [tests/agents/card-history-tools.test.ts](../../../tests/agents/card-history-tools.test.ts) — `cards.history.list` and `cards.history.get` agent tools return populated history after any mutation kind (not merely a fixture compile check). **Agent-tool responses are asserted to expose `entry_id` (UUID shape) and `kind` (allowed literal) for every row and every header, identical to the HTTP response.**

5. [tests/utils/card-history.test.ts](../../../tests/utils/card-history.test.ts) — rewrite the case at L43 (`"update without tracked fields does not append history"`) to its negation: every accepted patch produces exactly one history entry with `version_seq === card.version_seq - 1` post-bump, **and that entry has a fresh UUID `entry_id` plus the correct `kind`**. Delete the orphan-recovery cases at L66-L117 (silent truncation is gone). Add a new case asserting that a hand-injected orphan tail causes `CardStore.open(projectRoot)` to throw loudly instead of silently rewriting the file; **the thrown error message MUST reference the offending row's `entry_id` (if present) or `version_seq` so operators can locate it**. Add a case asserting that a hand-injected row with `version_seq === 0` causes `CardStore.open` to throw `CardStoreInvariantError`.

### Web Vitest (paths relative to `/home/salva/g/ml/saivage-v3/web/`)

6. [src/__tests__/card-history-panel.test.ts](../../../web/src/__tests__/card-history-panel.test.ts) — after a mocked mutation, the panel renders ≥ 1 entry (no longer `"No history entries yet."`). Run via `npm run web:test:card-history-panel` (new script added in §"Validation baseline"). **Mock fixture rows carry `entry_id` (UUID) and `kind`; the test asserts the panel receives both fields without normalising them to empty strings.**
7. [src/__tests__/card-history-panel-analyst-filter.test.ts](../../../web/src/__tests__/card-history-panel-analyst-filter.test.ts) — analyst filter operates on a non-empty list. **Fixture rows carry `entry_id` and `kind`; the filter assertion preserves both on the rows that pass the filter.**
8. [src/__tests__/operator-dashboard-smoke.test.ts](../../../web/src/__tests__/operator-dashboard-smoke.test.ts) — dashboard smoke test asserts the history tab populates after a UI-driven mutation; run via `npm run web:test:operator-smoke`. **The smoke fixture's history entries carry `entry_id` and `kind`; the smoke test asserts the populated panel data preserves both.**

Each absorbed item carries the invariant `total >= card.version_seq - 1`.

### F12 mutation-surface coverage

The acceptance matrix below MUST be exercised through real entrypoints, not only the new `applyMutation` primitive. One history entry + one `card_history_appended` event per successful version bump (with the documented `create` exception: bumps `version_seq` to 1 but writes no row and emits no event).

| Surface | Entrypoint | Test file |
| --- | --- | --- |
| HTTP PATCH (title/status/etc.) | `PATCH /api/cards/:id` | `tests/server/operator-api-contracts.test.ts` |
| HTTP create | `POST /api/cards` | `tests/server/operator-api-contracts.test.ts` — asserts new card has `version_seq === 1`, history is empty, no event emitted |
| HTTP delete | `DELETE /api/cards/:id` | `tests/server/operator-api-contracts.test.ts` |
| HTTP archive | `POST /api/cards/:id/archive` | `tests/server/operator-api-contracts.test.ts` |
| Runtime/planner `setStatus` | runtime transition path | `tests/runtime/runtime-activation-ledger.test.ts` |
| Runtime/planner `transitionCard` (async, F19 r4) | runtime activation | `tests/runtime/runtime-activation-ledger.test.ts` |
| Analyst tool `update_card` | analyst handler | `tests/agents/card-history-tools.test.ts` (extended) |
| Analyst tool `mutate_card` | analyst handler | `tests/agents/card-history-tools.test.ts` (extended) |
| `CardStore.updateDependsOn` direct | unit | `tests/utils/apply-mutation.test.ts` |
| `CardStore.archiveAndDeleteSubtree` direct | unit | `tests/utils/apply-mutation.test.ts` |

Every row except `HTTP create` asserts: `card.version_seq` bumps by 1 (or once per archived card for the subtree case), one matching history row appears with the right `kind` (∈ the six-value enum, never `'create'`) and an `entry_id` UUID, exactly one `card_history_appended` event fires per version bump, and `max(history[].version_seq) === card.version_seq - 1` post-mutation. The `HTTP create` row asserts the negation: no history row, no event.

## Crash-injection test matrix

Carried verbatim from r4 §"Crash-injection test matrix" with two additions:

- A new row: **`create` abort after marker rename, before by-id rename** — recovery completes the by-id rename and unlinks the marker; **no history append occurs** (marker.history === null); post-state: `card.version_seq === 1`, history file absent or empty, no `CardStoreInvariantError`.
- A new row: **hand-injected history row with `version_seq === 0`** for any card — `CardStore.open` throws `CardStoreInvariantError` naming the card id, file path, and the offending `version_seq` value.

All other rows are unchanged; the `(a)`–`(d)` invariant assertions in the harness header now read "for `V >= 2`, history is contiguous `{1..V-1}`; for `V === 1`, history is absent or empty" so the boot invariant test mirrors the design.

## Dead-code inventory

Unchanged from [03-plan-r4.md](03-plan-r4.md) §"Dead-code inventory" with one addition: the grep `rg -n 'cards/views' src tests web/src` returns zero matches after the slim-layout step (only the `SAIVAGE_DIRS` declaration and the file-tree test expectation referenced it; both are deleted). All other identifier and literal-path greps return zero matches as listed in r4.

`reconcileCardHistory` deletion is unchanged: missing or truncated history for a card with `version_seq >= 2` is a startup invariant failure.

## Step sequencing

Steps are intended to land as one merge train. Each step keeps the typecheck and targeted Jest baseline green.

1. **Schema fanout.** Add `entry_id` + `kind` + `CardHistoryHeader` + tightened response schemas, using the `cardHistoryEntryBaseSchema` shape from §"Schema changes". Update every fixture (no seq-0, no `'create'` kind).
2. **`CardStoreState` extraction.** New module `src/cards/state.ts`. New test `tests/utils/card-store-state.test.ts`.
3. **`ProjectMutex` + commit-marker + idempotent ledger.** New `src/cards/project-mutex.ts`, `src/cards/commit-marker.ts`. `appendSyncIdempotent` + `lastLineSync` added to [src/persistence/jsonl-ledger.ts](../../../src/persistence/jsonl-ledger.ts).
4. **`applyMutation`.** New `src/cards/apply-mutation.ts` implementing the ten-step sequence with **outer mutex + inner `withLock`**, pre-mutation `version_seq` on the durable row, `create` skipping the history append, and event emit after both locks released. New tests `tests/utils/apply-mutation.test.ts`, `tests/utils/card-store-crash-injection.test.ts`, `tests/utils/card-store-boot-recovery.test.ts`, `tests/utils/project-mutex.test.ts`.
5. **`CardStore` rewrite + `CardStore.open` factory.** All mutation methods become thin wrappers around `applyMutation`; all reads go through `CardStoreState`. `transitionCard` becomes `async`. `validatePersistedState`, `reconcileCardHistory`, `recomputeBlocks`, `appendHistoryEntry`, `parseChildrenIndex`, `HierarchyGraph`, the `TRACKED_*` constants, `canonicalHealth`, `getHealth`, the index/deps/blocks helpers — all deleted in this step.
6. **`Runtime.open` + `ActiveRuntime.open` + server wiring.** Async construction chain. Test-helper factories in `tests/_setup/`. Convert every `new CardStore(...)` / `new Runtime(...)` / `new ActiveRuntime(...)` site.
7. **`initProjectTree` / `isNewSaivageState` slimmed + legacy negative checks** (including `cards/views/`).
8. **Projection + event-registry deletion.** `CardHistoryProjection`, `registerCardHistoryProjection`, `card_history_record_appended`.
9. **Contract / dashboard / websocket / doctor-route cleanup.** `cardStoreHealth` removed everywhere; the `chats-files-debug.ts` `/api/debug/doctor` index-file branch is deleted; `chats-files-debug.ts` `new CardStore` site is converted in step 6.
10. **`package.json` script + final grep sweep.** Add `web:test:card-history-panel`. All identifiers and literal paths in §"Dead-code inventory" return zero matches.

Steps 5–7 must land together. Steps 1–4 are additive and land first. Steps 8–10 are deletion-only and land last.

## F19 / F20 / F23 ordering pin

Unchanged from r4.

## Rollback

Per the project guideline (architecture-first, no backward compatibility), rollback options are:

- **Revert the PR series before release.** `git revert` the F13 merge commit. Dev environments must reset the local `.saivage` state because the on-disk history files have the new schema. No bidirectional runtime compatibility shim.
- **Full local `.saivage` reset.** `rm -rf .saivage/` and rerun `initProjectTree` against the pre-F13 binary.

The r3 instruction `rm -rf .saivage/cards/.commit/` remains deleted. Corrupt or in-flight markers are fatal and operator-visible by design.

## Risk and mitigations

Unchanged from r4.
