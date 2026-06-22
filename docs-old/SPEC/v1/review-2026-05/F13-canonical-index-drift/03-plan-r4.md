# F13 — Implementation Plan (r4)

Supersedes [03-plan-r3.md](03-plan-r3.md). Addresses plan-review items 1–9 and cross-check items in [01-analysis-review-r3.md](01-analysis-review-r3.md). Companion: [01-analysis-r4.md](01-analysis-r4.md), [02-design-r4.md](02-design-r4.md). F13 is the umbrella; F12 r3 is a closure pointer plus its absorbed acceptance shape (§"Absorbed F12 acceptance shape").

## Validation baseline (MUST use package scripts only)

Run from `/home/salva/g/ml/saivage-v3/`. Resolves plan-review item 4.

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
cd web && npx vitest run src/__tests__/card-history-panel.test.ts
```

Final gate:

```
npm run preflight     # web:test:sweep + docs:verify
npm test              # full Jest suite
npm run validate:release
```

### Live probe (replaces r3; resolves plan-review item 4 final paragraph)

After any successful mutation against `http://10.0.3.112:8080`, `GET /api/cards/<id>` returns `card`, `GET /api/cards/<id>/history` returns `list`. Assert:

- `list.total >= card.version_seq - 1`.
- `max(list.history[].version_seq) === card.version_seq - 1` for any card with `card.version_seq >= 1`.
- Every entry in `list.history` has a non-empty `entry_id` (UUID) and a `kind` ∈ `{create, update, status, mutate, delete, archive, depends}`.
- `GET /api/cards/<id>/history/<seq>` succeeds (HTTP 200) for every `seq` in `{1, ..., card.version_seq - 1}`.
- `GET /api/cards/<id>/diff?from=1&to=card.version_seq - 1` (for `card.version_seq >= 2`) succeeds and returns a non-empty `changed_fields`.
- `.saivage/runtime/errors.jsonl` shows no new `Canonical hierarchy invariant failed` line during a 5-minute soak.

The drift signal that fired in G1/T20 and G5/T45 cannot fire because no `cards/index.json` exists to disagree with the by-id record.

## Async construction chain (resolves plan-review items 1, 2)

TS constructors cannot be `async`. Each factory builds dependencies in **local variables**, then passes them to a `private` constructor — no `this` is referenced before construction.

### `CardStore.open`

```ts
class CardStore {
  static async open(projectRoot: string, eventBus: EventBus, maxGoalDepth?: number): Promise<CardStore> {
    const mutex = new ProjectMutex();
    const projectLock = await ProjectLock.create(projectRoot);
    const state = await loadCardStoreState(projectRoot);   // marker recovery, by-id load, adjacency, structural + startup-history invariants
    return new CardStore({ projectRoot, eventBus, mutex, projectLock, state, maxGoalDepth });
  }
  private constructor(deps: CardStoreDeps) { /* assign fields only; no I/O */ }
}
```

The constructor becomes `private`; every `new CardStore(...)` call site is converted to `await CardStore.open(...)`.

### `Runtime.open`

```ts
class Runtime {
  static async open(config: RuntimeConfig, agentRuntime?: AgentRuntime): Promise<Runtime> {
    const eventBus = new EventBus();
    const cardStore = await CardStore.open(config.projectRoot, eventBus);
    // ... build other deps that needed `this` in the old constructor as locals ...
    return new Runtime({ config, agentRuntime, eventBus, cardStore, /* etc. */ });
  }
  private constructor(deps: RuntimeDeps) { /* assign fields only; no I/O */ }
}
```

### `ActiveRuntime.open` (resolves plan-review item 1)

```ts
class ActiveRuntime {
  static async open(projectRoot: string, saivageConfig: SaivageConfig, mcpManager?: McpManager): Promise<ActiveRuntime> {
    const logger = createLogger(...);
    const skills = await loadSkills(...);
    const agentAdapter = new AgentAdapter({ logger, skills, mcpManager });
    const runtimeConfig = buildRuntimeConfig(projectRoot, saivageConfig);
    const runtime = await Runtime.open(runtimeConfig, agentAdapter);
    return new ActiveRuntime({ projectRoot, saivageConfig, logger, skills, agentAdapter, runtime, mcpManager });
  }
  private constructor(deps: ActiveRuntimeDeps) { /* assign fields only; no I/O */ }
}
```

No `this._agentAdapter` reference before construction. The `agentAdapter` is built in a local, used to build the `runtime` (which is awaited), and then both are passed to the private constructor.

### `createServer` gating

[src/server/server.ts#L108](../../../src/server/server.ts#L108): change `new ActiveRuntime(projectRoot, saivageConfig)` to `await ActiveRuntime.open(projectRoot, saivageConfig)`. `await activeRuntime.start()` already follows. Route registration (`registerOperatorContractRoutes`, etc.) runs after this `await`, so the readiness gate is in place.

### `transitionCard` (cross-issue with F19 r4)

`CardStore.transitionCard` becomes `async`. Body routes the durable effect through `applyMutation` with `kind: 'status'`. All call sites are part of the fanout grep below. F19 r4 and F13 land together or in dependency order.

### Async-constructor fanout appendix (resolves plan-review item 2)

Run before and after each step:

```
rg -n 'new CardStore|new Runtime|new ActiveRuntime' src tests web/src
```

Pre-F13 production sites (verified from the spot-check grep at r3 review time; the list below is exhaustive for `src/` and the executed call sites in `tests/` plus the test-helper strategy):

Production (`src/`):

- [src/runtime/runtime.ts#L108](../../../src/runtime/runtime.ts#L108) — inside the current `Runtime` constructor. Moves into `Runtime.open`.
- [src/runtime/active-runtime.ts#L99](../../../src/runtime/active-runtime.ts#L99) — `new Runtime(...)` → `await Runtime.open(...)` inside `ActiveRuntime.open`.
- [src/server/server.ts#L108](../../../src/server/server.ts#L108) — `new ActiveRuntime(...)` → `await ActiveRuntime.open(...)`.
- [src/server/routes/operator-contracts.ts#L55](../../../src/server/routes/operator-contracts.ts#L55) — `new CardStore` → `await CardStore.open` inside the async handler.
- [src/server/routes/chats-files-debug.ts#L75](../../../src/server/routes/chats-files-debug.ts#L75) — same.
- [src/notifications/notification-triggers.ts#L68](../../../src/notifications/notification-triggers.ts#L68) — same; surrounding function becomes async.
- [src/agents/agent-adapter.ts#L184](../../../src/agents/agent-adapter.ts#L184), [#L385](../../../src/agents/agent-adapter.ts#L385) — same.
- [src/agents/analyst-stage6.ts#L114](../../../src/agents/analyst-stage6.ts#L114), [#L139](../../../src/agents/analyst-stage6.ts#L139), [#L169](../../../src/agents/analyst-stage6.ts#L169), [#L186](../../../src/agents/analyst-stage6.ts#L186), [#L207](../../../src/agents/analyst-stage6.ts#L207) — five sites; surrounding functions already async.
- [src/agents/analyst-tools.ts#L75](../../../src/agents/analyst-tools.ts#L75) `getStore(ctx)` — return `Promise<CardStore>`; callers `await`.
- [src/agents/analyst-handler.ts#L444](../../../src/agents/analyst-handler.ts#L444) — same.

Tests (`tests/`): the grep at r3 review time returned 20+ `new CardStore(...)` sites across `tests/analyst.test.ts`, `tests/runtime/runtime-activation-ledger.test.ts`, `tests/integration/runtime-redesign-golden.test.ts`, `tests/e2e/hardening-e2e.test.ts` (3 sites), `tests/agents/agent-adapter-reviewer-prompt.test.ts`, `tests/agents/planner-control-executor.test.ts`, `tests/agents/agent-adapter-force-final-answer.test.ts`, `tests/agents/codex-deferred-activate-card.test.ts`, `tests/agents/agent-adapter-planner-tools.test.ts`, `tests/agents/card-history-tools.test.ts`, `tests/utils/planner-tools.test.ts` (2 sites), `tests/utils/runtime-integration.test.ts` (7 sites), `tests/utils/runtime-continuous-improvement.test.ts`, and additional `new Runtime(...)` / `new ActiveRuntime(...)` sites across `tests/runtime/runtime-command-ledger.test.ts` (10+ sites), `tests/e2e/hardening-e2e.test.ts` (4 sites), `tests/agents/agent-adapter-abort.test.ts` (3 sites), `tests/integration/runtime-redesign-golden.test.ts`. The full list is regenerated by the grep above; the implementation step that removes the public constructors converts every site in one sweep.

Test-helper strategy:

- Add `tests/_setup/card-store-factory.ts` exporting `openCardStoreForTest(projectRoot: string, opts?: { eventBus?: EventBus; maxGoalDepth?: number }): Promise<CardStore>`. Default `eventBus` is a freshly-constructed `EventBus` for the test.
- Add `tests/_setup/runtime-factory.ts` exporting `openRuntimeForTest(opts: { projectRoot: string; ... }): Promise<Runtime>` and `openActiveRuntimeForTest(opts: ...): Promise<ActiveRuntime>`.
- Convert every `const store = new CardStore(tmpDir)` to `const store = await openCardStoreForTest(tmpDir)` in the same sweep that removes the public constructors. Same for `Runtime` / `ActiveRuntime`.

The mechanical gate: after the sweep, `rg -n 'new CardStore\(|new Runtime\(|new ActiveRuntime\(' src tests web/src` returns zero matches. TypeScript itself enforces the constraint because the public constructors are deleted.

## Schema changes (resolves plan-review item 3)

`CardHistoryListResponseSchema` currently uses `z.record(z.string(), z.unknown())` for history entries; F13 tightens it. Apply in this order so a typecheck failure in one fanout location does not block another:

1. [src/schemas/types.ts#L55](../../../src/schemas/types.ts#L55) — add `CardHistoryKind` union and the two fields on `CardHistoryEntry`. Add `CardHistoryHeader = Omit<CardHistoryEntry, 'snapshot'>`.
2. [src/schemas/validators.ts#L23](../../../src/schemas/validators.ts#L23) — extend `cardHistoryEntrySchema` with `entry_id: z.string().uuid()` and `kind: z.enum([...])`. Add `cardHistoryHeaderSchema = cardHistoryEntrySchema.omit({ snapshot: true })`.
3. [src/schemas/index.ts](../../../src/schemas/index.ts) — re-export `CardHistoryKind`, `cardHistoryHeaderSchema`.
4. [src/contracts/operator-api.ts#L156](../../../src/contracts/operator-api.ts#L156) — replace `CardHistoryListResponseSchema = z.object({ history: z.array(z.record(z.string(), z.unknown())), total: ... })` with `z.object({ history: z.array(cardHistoryHeaderSchema), total: z.number().int().nonnegative() })`.
5. [src/contracts/operator-api.ts#L157](../../../src/contracts/operator-api.ts#L157) — replace `CardHistoryEntryResponseSchema = z.object({ entry: z.record(z.string(), z.unknown()) })` with `z.object({ entry: cardHistoryEntrySchema })`.
6. [src/contracts/index.ts](../../../src/contracts/index.ts) — export the new schemas and their inferred types.
7. [src/cards/card-store.ts](../../../src/cards/card-store.ts) — every `CardHistoryEntry` constructed by `applyMutation` includes both new fields.
8. [src/tools/agent-tools.ts](../../../src/tools/agent-tools.ts) — `list_card_history`, `get_card_history_entry` registrations pull from contracts; verify with `npm run typecheck`.
9. [src/agents/analyst-tools.ts#L120](../../../src/agents/analyst-tools.ts#L120) — drop `TRACKED_EDIT_FIELDS`; renderer reads `entry.changed_fields` directly.
10. [web/src/api/types.ts#L240](../../../web/src/api/types.ts#L240) — `CardHistoryHeader` gains `entry_id`, `kind`.
11. [web/src/api/types.ts#L251](../../../web/src/api/types.ts#L251) — `CardHistoryEntry extends CardHistoryHeader` inherits the new fields.
12. [web/src/api/types.ts#L789](../../../web/src/api/types.ts#L789) — response types follow.
13. [web/src/api/client.ts](../../../web/src/api/client.ts) — typed through the contract; no runtime change.
14. [web/src/stores/cards.ts](../../../web/src/stores/cards.ts) — types follow.
15. Web mocks under [web/src/__tests__/__mocks__/](../../../web/src/__tests__/__mocks__/) and fixtures in [web/src/__tests__/](../../../web/src/__tests__/) — every history-entry fixture gains `entry_id` and `kind`.
16. Backend fixtures: [tests/agents/card-history-tools.test.ts](../../../tests/agents/card-history-tools.test.ts), [tests/api/cards-history.test.ts](../../../tests/api/cards-history.test.ts), [tests/utils/card-history.test.ts](../../../tests/utils/card-history.test.ts), [tests/server/runtime-card-contract-routes.test.ts](../../../tests/server/runtime-card-contract-routes.test.ts), [tests/server/operator-api-contracts.test.ts](../../../tests/server/operator-api-contracts.test.ts), [tests/server/operator-api-contract-fixtures.test.ts](../../../tests/server/operator-api-contract-fixtures.test.ts), [tests/schemas.test.ts](../../../tests/schemas.test.ts) — every fixture entry gains `entry_id` (via `crypto.randomUUID()`) and `kind`. Add a `tests/schemas.test.ts` case asserting `cardHistoryEntrySchema` rejects entries missing either field, AND a case asserting `CardHistoryListResponseSchema` rejects a list element missing `entry_id` (regression guard against accidental loosening back to `z.record`).

## `initProjectTree` / `isNewSaivageState` (resolves plan-review item 5)

[src/persistence/file-tree.ts](../../../src/persistence/file-tree.ts):

- `initProjectTree` ([:148](../../../src/persistence/file-tree.ts#L148)) writes only: `project.json`, `cards/by-id/project.json`, `notes/queue.json`, `views/leaderboard.json`, `views/saved-filters.json`, `skills/index.json`, `runtime/events.jsonl`, `runtime/errors.jsonl`, `supervision/reviews.jsonl`, `supervision/quarantine-index.json`, `saivage.json`. Removes writes of `cards/index.json`, `cards/tree/project.children.json`, `cards/dependencies/depends-on.json`, `cards/dependencies/blocks.json`.
- `SAIVAGE_DIRS` ([:74](../../../src/persistence/file-tree.ts#L74)) removes `cards/tree` and `cards/dependencies`. Adds `cards/.commit`.
- `isNewSaivageState` ([:99](../../../src/persistence/file-tree.ts#L99)–`L118`) — drop the `cards/tree`, `cards/dependencies` required-dir entries and the `cards/index.json` validity check. Required check becomes: `cards/by-id`, `agents/sessions`, `agents/messages`, `runtime`, `notes/by-card`, `views`, `supervision` directories exist, plus `project.json`, `cards/by-id/project.json`, `notes/queue.json` parse against their schemas.
- **Negative checks against legacy state (resolves plan-review item 5).** `isNewSaivageState` returns `false` (i.e. the seed is treated as legacy, not new) if any of the following derived artifacts exist:
  - `cards/index.json`
  - `cards/tree/` directory (even if empty)
  - `cards/dependencies/` directory (even if empty)
  - `cards/dependencies/depends-on.json`
  - `cards/dependencies/blocks.json`
  - `cards/blocks.json` (legacy flat form)
  The rationale: a half-migrated seed that has both `cards/by-id/project.json` and `cards/index.json` is NOT a fresh F13 layout; treating it as new would let stale derived files survive into a post-F13 runtime that does not maintain them.
- Delete `defaultCardIndexEntry`, `defaultDependsOnIndex`, `defaultBlocksIndex` ([:70](../../../src/persistence/file-tree.ts#L70)–`L149`).
- Delete the `cardIndexSchema` import at [:5](../../../src/persistence/file-tree.ts#L5).
- [tests/utils/file-tree.test.ts](../../../tests/utils/file-tree.test.ts): after `initProjectTree`, `ls .saivage/cards/` shows only `by-id/`, `history/`, `.commit/`. `isNewSaivageState` returns `true` for the slim seed. Add positive-rejection cases: a seed with `cards/index.json` returns `false`; a seed with `cards/tree/` returns `false`; a seed with `cards/dependencies/depends-on.json` returns `false`; a seed with `cards/dependencies/blocks.json` returns `false`. Each negative case asserts the file is treated as legacy, not silently accepted.

## Mutex implementation (resolves plan-review item 9)

`package.json` does NOT currently include `async-mutex`. F13 does **not** add the dependency. Instead, add `src/cards/project-mutex.ts` (≈ 10 LOC, MIT-licensed local code, no third-party scope):

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

Usage in `applyMutation`:

```ts
const release = await projectMutex.lock();
try {
  // steps 2–8 (capture event payload locally before release)
} finally {
  release();
  await projectLock.release();
}
// step 10: emit event after lock release
```

Tests in [tests/utils/project-mutex.test.ts](../../../tests/utils/project-mutex.test.ts) (new): two concurrent `lock()` calls serialize; a `lock()` issued after a `release()` runs immediately; a `lock()` whose body throws still releases the chain so the next `lock()` proceeds.

## Absorbed F12 acceptance shape (F13 must keep these green — resolves cross-check items 1, 4)

Every test from [../F12-card-history-empty/03-plan-r3.md](../F12-card-history-empty/03-plan-r3.md) §(b), verbatim:

1. [tests/server/operator-api-contracts.test.ts](../../../tests/server/operator-api-contracts.test.ts) — PATCH `{ title: "x" }` → `history.total === 1`, `history[0].version_seq === 1`, `history[0].changed_fields` includes `"title"`. PATCH `{ status: "active" }` → `history.total === 1`, `history[0].version_seq === 1`, `history[0].changed_fields` includes `"status"`. Two consecutive PATCHes → `card.version_seq === 3`, `history.total === 2`, `version_seq` values `[2, 1]` newest first, `max(history[].version_seq) === 2 === card.version_seq - 1`. `GET /api/cards/<id>/history/1` returns the pre-first-edit snapshot (not 404). `GET /api/cards/<id>/diff?from=1&to=2` returns a `changed_fields` list.
2. [tests/api/cards-history.test.ts](../../../tests/api/cards-history.test.ts) — remove any `total === 0` assertion after `update`/`setStatus`; add `max(history[].version_seq) === card.version_seq - 1` after a mixed (`update`, `setStatus`, `mutateCard`, `updateDependsOn`) sequence; assert every entry has `entry_id` and `kind`.
3. [tests/server/websocket-analyst-safety.test.ts](../../../tests/server/websocket-analyst-safety.test.ts) — `card_history_appended` emitted exactly once per `applyMutation` that bumps `version_seq`; event payload matches [src/contracts/operator-events.ts#L110-L119](../../../src/contracts/operator-events.ts#L110-L119); the prior `card_history_record_appended` assertion is deleted.
4. [tests/agents/card-history-tools.test.ts](../../../tests/agents/card-history-tools.test.ts) — `list_card_history` and `get_card_history_entry` return populated history after any mutation kind; every entry has `entry_id` and `kind`.
5. [tests/utils/card-history.test.ts](../../../tests/utils/card-history.test.ts) — rewrite L43 to its negation; delete L66–L117 orphan-recovery cases; add a hand-injected orphan-tail case that asserts `CardStore.open` throws `CardStoreInvariantError`.
6. [web/src/__tests__/card-history-panel.test.ts](../../../web/src/__tests__/card-history-panel.test.ts) — panel renders ≥ 1 entry after a mocked mutation.
7. [web/src/__tests__/card-history-panel-analyst-filter.test.ts](../../../web/src/__tests__/card-history-panel-analyst-filter.test.ts) — analyst filter operates on a non-empty list.
8. [web/src/__tests__/operator-dashboard-smoke.test.ts](../../../web/src/__tests__/operator-dashboard-smoke.test.ts) — dashboard smoke asserts the history tab populates after a UI-driven mutation; run via `npm run web:test:operator-smoke`.

### F12 mutation-surface coverage (resolves cross-check item 4)

The acceptance matrix below MUST be exercised through real entrypoints, not only the new `applyMutation` primitive. One history entry + one `card_history_appended` event per successful version bump.

| Surface | Entrypoint | Test file |
| --- | --- | --- |
| HTTP PATCH (title/status/etc.) | `PATCH /api/cards/:id` | `tests/server/operator-api-contracts.test.ts` |
| HTTP create | `POST /api/cards` | `tests/server/operator-api-contracts.test.ts` |
| HTTP delete | `DELETE /api/cards/:id` | `tests/server/operator-api-contracts.test.ts` |
| HTTP archive | `POST /api/cards/:id/archive` | `tests/server/operator-api-contracts.test.ts` |
| Runtime/planner `setStatus` | runtime transition path | `tests/runtime/runtime-activation-ledger.test.ts` |
| Runtime/planner `transitionCard` (async, F19 r4) | runtime activation | `tests/runtime/runtime-activation-ledger.test.ts` |
| Analyst tool `update_card` | analyst handler | `tests/agents/card-history-tools.test.ts` (extended) |
| Analyst tool `mutate_card` | analyst handler | `tests/agents/card-history-tools.test.ts` (extended) |
| `CardStore.updateDependsOn` direct | unit | `tests/utils/apply-mutation.test.ts` |
| `CardStore.archiveAndDeleteSubtree` direct | unit | `tests/utils/apply-mutation.test.ts` |

Every row asserts: `card.version_seq` bumps by 1 (or once per archived card for the subtree case), one matching history row appears with the right `kind` and an `entry_id` UUID, exactly one `card_history_appended` event fires per version bump, and `max(history[].version_seq) === card.version_seq - 1` post-mutation.

## Crash-injection test matrix (resolves plan-review items 7, 8 + cross-check items 2, 5)

New file [tests/utils/card-store-crash-injection.test.ts](../../../tests/utils/card-store-crash-injection.test.ts). Harness wraps `applyMutation` with a configurable `abortAfter` failure point. Each row, after the configured crash + reopen via `CardStore.open`, asserts:

- **(a)** history file is contiguous (rows `1..V-1` with no gap, no duplicate `entry_id`);
- **(b)** `max(history[].version_seq) === card.version_seq - 1`;
- **(c)** `GET /api/cards/<id>/history/<seq>` (in-process route shim) resolves for every `seq` in `{1..V-1}`;
- **(d)** `GET /api/cards/<id>/diff?from=1&to=V-1` (when `V >= 2`) resolves and returns a non-empty `changed_fields`.

| Abort point | Mutation kind(s) | Disk-state assertion | In-memory assertion | Invariants (a)–(d) |
| --- | --- | --- | --- | --- |
| Before staging tmp | every | unchanged | unchanged | hold (no-op) |
| After tmp staged, before marker rename | every | tmp present; recovery unlinks it | unchanged | hold |
| After marker rename, before by-id rename | create, update, status, mutate, delete, depends | marker + tmp present; recovery completes rename + appends history + unlinks marker | post-mutation card visible | hold |
| After by-id rename, before history append | every | marker + new by-id; recovery appends, unlinks marker | post-mutation visible | hold |
| After history append, before marker unlink | every | marker + new by-id + history line; recovery is no-op append (entry_id matches) + unlink | post-mutation visible | hold |
| After marker unlink, before event emit | every | committed | post-mutation visible; event not yet emitted | hold (event loss is at-most-once and tolerated) |
| Mid history append (partial JSONL line larger than 4 KB tail window) | update with a snapshot ≥ 8 KB | marker + new by-id + truncated tail | recovery sidelines partial bytes, appends, unlinks marker | hold |
| Marker file corruption (write garbage to `.commit/<token>.json`) | n/a (injected after a successful mutation) | corrupt marker present | `CardStore.open` throws `CardStoreInvariantError` naming the marker path | n/a (fatal) |
| Orphan tmp without marker | n/a | tmp present, no marker | recovery unlinks tmp; reopened state is the pre-tmp commit | hold |
| Multi-card archive crash after each per-card prefix (0..N) | archive | group marker + per-card marker for next card; prior cards unlinked; current card still present | recovery resumes; final reopened state equals a clean `archiveAndDeleteSubtree` from the same starting state | hold for every survivor and for every archived card's preserved history file |
| Group recovery state (a) (group marker, no per-card marker yet) | archive | group marker only | recovery executes from index 0 | hold |
| Group recovery state (b) (per-card marker, by-id not yet updated) | archive | group + one per-card marker | recovery completes the per-card sequence | hold |
| Group recovery state (c) (per-card marker unlinked, group marker still present) | archive | group marker only, no per-card markers, prior cards committed | recovery advances index and unlinks group marker | hold |
| Group recovery state (d) (corrupted per-card marker referenced by valid group) | archive | corrupt per-card marker | fatal `CardStoreInvariantError`; neither marker is unlinked | n/a |
| Reopen with by-id-only seed (no `cards/index.json`, no `.commit/`, no derived files) | n/a | only `cards/by-id/`, `cards/history/`, `cards/.commit/` exist | `CardStore.open` succeeds; `state.list()` returns the seeded cards | hold |
| Out-of-band history truncation while card is at `V >= 2` | n/a | history file truncated below `V - 1` | `CardStore.open` throws `CardStoreInvariantError` | n/a (loud) |
| Out-of-band by-id version bump past `last_history_seq + 1` | n/a | by-id rewritten with `version_seq = X`, history file last row = `Y` with `X > Y + 1` | `CardStore.open` throws `CardStoreInvariantError` | n/a (loud) |
| Event subscriber re-enters `cardStore.update` from `card_history_appended` handler | update | both mutations commit in order | `card.version_seq` advances by 2; no deadlock | hold after the second mutation |

Plus [tests/utils/card-store-boot-recovery.test.ts](../../../tests/utils/card-store-boot-recovery.test.ts): 50 mutations interleaved with 10 random crash injections (seeded RNG); the final reopened state matches the expected sequence; no marker is left behind; invariants (a)–(d) hold for every card.

## Dead-code inventory (resolves plan-review item 6)

After all PRs land, the following greps must each return zero matches in `src/`, `tests/`, and `web/src/` as listed:

Identifiers:

```
rg -n 'cardIndexSchema|cardChildrenIndexSchema|cardDependencyIndexSchema|cardBlocksIndexSchema' src tests web/src
rg -n 'CardIndex\b|CardChildrenIndex\b|CardDependencyIndex\b|CardBlocksIndex\b' src tests web/src
rg -n 'CardIndexEntry|cardIndexEntrySchema' src tests web/src
rg -n 'defaultCardIndexEntry|defaultDependsOnIndex|defaultBlocksIndex' src tests
rg -n 'CardHistoryProjection|registerCardHistoryProjection|cardHistoryLedger' src tests
rg -n 'card_history_record_appended|CardHistoryRecordAppendedEvent' src tests
rg -n 'CardStoreHealth\b|CardStoreCanonicalHealth|CardStoreHealthSchema|cardStoreHealth\b' src tests web/src
rg -n 'getHealth\b' src/cards tests/utils/card-store.test.ts
rg -n 'HierarchyGraph' src tests
rg -n 'reconcileCardHistory|appendHistoryEntry|writeHistoryEntries|loadHistoryEntries' src tests
rg -n 'parseChildrenIndex' src tests
rg -n 'recomputeBlocks' src tests
rg -n 'TRACKED_FIELDS|TRACKED_UPDATE_FIELDS|TRACKED_EDIT_FIELDS' src tests
rg -n 'addToIndex|removeFromIndex|loadIndex|saveIndex|loadDependsOn|saveDependsOn|loadBlocks|saveBlocks|indexPath|dependsOnPath|blocksPath' src/cards tests
rg -n 'validatedPersistedState|ensurePersistedStateValidated|validatePersistedState|loadCanonicalCardsFromDisk|writeCard' src/cards tests
rg -n 'beforeTrackedCardRename' src tests
rg -n 'cards/tree|cards/dependencies' src tests web/src
```

Literal-path additions (resolves plan-review item 6):

```
rg -n 'cards/index\.json' src tests web/src
```

`src/server/routes/chats-files-debug.ts` currently contains a user-facing `/api/debug/doctor` handler at [L390-L470](../../../src/server/routes/chats-files-debug.ts#L390) that reads `.saivage/cards/index.json` and emits diagnostics about index-vs-by-id divergence. F13 deletes the entire index-file branch of that handler: the checks `index_entries_have_card_files`, the `Index file (.saivage/cards/index.json) is not valid JSON.` issue, and any cross-check that compares `indexCards` to `diskCardIds`. The doctor route remains; its remaining checks operate over `cards/by-id/` alone. After the deletion, the literal-path grep above returns zero matches.

Web cleanup (explicit, plan-review item 6):

- [web/src/api/types.ts](../../../web/src/api/types.ts) — `CardHistoryHeader` / `CardHistoryEntry` / response types updated per §"Schema changes". Any web-side references to `cardStoreHealth` are removed (store fields, components, tests).

Files / modules deleted outright: none outright; every file above keeps at least one symbol after the rewrite, except potentially `HierarchyGraph` (deleted from `src/cards/card-store.ts`).

Files emptied of F13-related content: [tests/projections/ledger-projections.test.ts](../../../tests/projections/ledger-projections.test.ts) — `CardHistoryProjection` block.

Schema declarations to remove:

- `cardIndexSchema`, `cardChildrenIndexSchema`, `cardDependencyIndexSchema`, `cardBlocksIndexSchema` from [src/schemas/validators.ts](../../../src/schemas/validators.ts#L27-L30).
- `CardIndexEntry`, `CardIndex`, `CardChildrenIndex`, `CardDependencyIndex`, `CardBlocksIndex` from [src/schemas/types.ts](../../../src/schemas/types.ts#L58-L62).
- Corresponding re-exports in [src/schemas/index.ts](../../../src/schemas/index.ts#L33-L37).
- `CardStoreHealthSchema`, `CardStoreCanonicalHealth*` from [src/schemas/](../../../src/schemas/) and [src/contracts/operator-api.ts](../../../src/contracts/operator-api.ts#L99), [src/contracts/index.ts](../../../src/contracts/index.ts#L22).
- `CardHistoryRecordAppendedEvent` interface from [src/schemas/types.ts](../../../src/schemas/types.ts) (if present).

Event registry:

- [src/events/registry.ts#L65](../../../src/events/registry.ts#L65) — remove `card_history_record_appended`. Keep `card_history_appended` ([L58](../../../src/events/registry.ts#L58)).

Projection module:

- [src/projections/ledger-projections.ts#L52-L168](../../../src/projections/ledger-projections.ts#L52) — delete `CardHistoryProjection`, `registerCardHistoryProjection`, `cardHistoryLedger`. Update `registerLedgerProjections` to not call them.
- [src/projections/index.ts](../../../src/projections/index.ts) — drop the deleted exports.

`cards/tree/<id>.children.json` writer / reader:

- Writer: `initProjectTree` ([src/persistence/file-tree.ts#L156](../../../src/persistence/file-tree.ts#L156)) — deleted.
- Reader: `parseChildrenIndex` in `card-store.ts` — deleted (children list is in-memory).

Dashboard / control-room cleanup:

- `rg -n 'cardStoreHealth' web/src` — every match deleted; the websocket envelope at [src/server/websocket.ts#L95](../../../src/server/websocket.ts#L95) drops the field.
- [src/server/routes/operator-contracts.ts#L88](../../../src/server/routes/operator-contracts.ts#L88) — remove the hard-coded `cardStoreHealth: { canonical: 'ok' }`.
- [src/contracts/operator-events.ts#L42](../../../src/contracts/operator-events.ts#L42) — drop `cardStoreHealth` field from snapshot envelope.

Related tests:

- [tests/server/operator-api-contracts.test.ts](../../../tests/server/operator-api-contracts.test.ts), [tests/server/operator-api-contract-fixtures.test.ts](../../../tests/server/operator-api-contract-fixtures.test.ts), [tests/server/websocket-analyst-safety.test.ts](../../../tests/server/websocket-analyst-safety.test.ts), [tests/server/server-availability-contract.test.ts](../../../tests/server/server-availability-contract.test.ts) — remove every `cardStoreHealth` assertion (do not replace with a stub).
- [tests/utils/card-store.test.ts](../../../tests/utils/card-store.test.ts) — remove tests that exercised `update()`/`setStatus()` skipping history; add cases asserting both methods now produce history entries with the right `kind`.
- [tests/utils/card-history.test.ts](../../../tests/utils/card-history.test.ts) — see "Absorbed F12 acceptance shape".

### `reconcileCardHistory` deletion (cross-check item 5)

`reconcileCardHistory` and any equivalent silent rewrite path (`appendHistoryEntry` helper that pads gaps, `writeHistoryEntries` bulk overwrite, any "audit gap acceptable" branch in `CardStore.open`) are deleted. Missing or truncated history for a card with `version_seq >= 2` is a startup invariant failure (`CardStoreInvariantError`), per [02-design-r4.md](02-design-r4.md) §"Boot recovery". The grep `rg -n 'reconcileCardHistory|appendHistoryEntry|writeHistoryEntries|loadHistoryEntries' src tests` returns zero matches.

## Step sequencing

Steps are intended to land as one merge train. Each step keeps the typecheck and targeted Jest baseline green.

1. **Schema fanout.** Add `entry_id` + `kind` + `CardHistoryHeader` + tightened response schemas. Update every fixture.
2. **`CardStoreState` extraction.** New module `src/cards/state.ts` (in-memory state, adjacency rebuild, structural validators carried from `HierarchyGraph.build` minus the index↔by-id check). New test `tests/utils/card-store-state.test.ts`.
3. **`ProjectMutex` + commit-marker + idempotent ledger.** New `src/cards/project-mutex.ts`, `src/cards/commit-marker.ts`. `appendSyncIdempotent` + `lastLineSync` (backwards-scan tail finder) added to [src/persistence/jsonl-ledger.ts](../../../src/persistence/jsonl-ledger.ts).
4. **`applyMutation`.** New `src/cards/apply-mutation.ts` implementing the ten-step sequence with **pre-mutation `version_seq` on the durable row** and **event emit after lock release**. New tests `tests/utils/apply-mutation.test.ts`, `tests/utils/card-store-crash-injection.test.ts`, `tests/utils/card-store-boot-recovery.test.ts`, `tests/utils/project-mutex.test.ts`.
5. **`CardStore` rewrite + `CardStore.open` factory.** All mutation methods become thin wrappers around `applyMutation`; all reads go through `CardStoreState`. `transitionCard` becomes `async`. `validatePersistedState`, `reconcileCardHistory`, `recomputeBlocks`, `appendHistoryEntry`, `parseChildrenIndex`, `HierarchyGraph`, the `TRACKED_*` constants, `canonicalHealth`, `getHealth`, the index/deps/blocks helpers — all deleted in this step.
6. **`Runtime.open` + `ActiveRuntime.open` + server wiring.** Async construction chain. Test-helper factories in `tests/_setup/`. Convert every `new CardStore(...)` / `new Runtime(...)` / `new ActiveRuntime(...)` site.
7. **`initProjectTree` / `isNewSaivageState` slimmed + legacy negative checks.**
8. **Projection + event-registry deletion.** `CardHistoryProjection`, `registerCardHistoryProjection`, `card_history_record_appended`.
9. **Contract / dashboard / websocket / doctor-route cleanup.** `cardStoreHealth` removed everywhere; the `chats-files-debug.ts` `/api/debug/doctor` index-file branch is deleted; `chats-files-debug.ts` `new CardStore` site is converted in step 6.
10. **Final grep sweep.** All identifiers and literal paths in §"Dead-code inventory" return zero matches.

Steps 5–7 must land together (a freshly seeded project without `cards/index.json` cannot be opened by the pre-step-5 `CardStore`). Steps 1–4 are additive and land first. Steps 8–10 are deletion-only and land last.

## F19 / F20 / F23 ordering pin

- F13 lands first. F19 r4, F20, F23 rebase onto it.
- F19 r4: `transitionCard` is `async`; the fix calls `await cardStore.setStatus` and produces a history entry with `kind: 'status'` and `entry_id`. F19's tests in `tests/runtime/runtime-activation-ledger.test.ts` and `tests/runtime/runtime-command-ledger.test.ts` gain `entry_id`/`kind` assertions through F13's schema fanout step.
- F20: independent.
- F23: patches `validateTransition`; after F13 the function lives in `CardStoreState`. If F23 lands first, the patch is carried verbatim by F13 step 2.

## Rollback (resolves plan-review item 8)

Per the project guideline (architecture-first, no backward compatibility), rollback options are:

- **Revert the PR series before release.** `git revert` the F13 merge commit. Dev environments must reset the local `.saivage` state because the on-disk history files have the new schema. No bidirectional runtime compatibility shim.
- **Full local `.saivage` reset.** `rm -rf .saivage/` and rerun `initProjectTree` against the pre-F13 binary.

**Removed from the rollback procedure (resolves plan-review item 8):** the r3 instruction `rm -rf .saivage/cards/.commit/` is deleted. Corrupt or in-flight markers are fatal and operator-visible by design; deleting marker files would discard the only durable description of a pending commit and silently corrupt the by-id ↔ history pair. Operators presented with a fatal marker error must either (a) inspect and hand-correct the on-disk state with the error message's location info, or (b) full-reset the local `.saivage`. There is no shortcut "delete the markers and reboot".

No `@deprecated` markers anywhere. No "old code reads new files correctly", no "new code reads old files via a shim".

## Risk and mitigations

- **Async fan-out misses.** Every `new CardStore(...)` / `new Runtime(...)` / `new ActiveRuntime(...)` becomes a typecheck error after step 5 (constructors are private); the grep in §"Async construction chain" is the mechanical gate.
- **Fixture tests writing `cards/index.json` directly.** The schema deletion makes any code that names `CardIndex` / `cardIndexSchema` a typecheck error; the grep in §"Dead-code inventory" is the mechanical gate.
- **Corrupt last history line.** Handled by the partial-line contract in [02-design-r4.md](02-design-r4.md) §"JSONL crash semantics"; exercised by the crash-injection matrix.
- **Operator hand-edits `cards/by-id/<id>.json` between mutations.** Honoured on next `CardStore.open` only if the contiguous-history invariant still holds; otherwise loud `CardStoreInvariantError`.
- **Audit truncation goes loud where it was silent.** Intended behaviour; replaces `reconcileCardHistory`. Operators see a clear error with the file path and recovery hint.
