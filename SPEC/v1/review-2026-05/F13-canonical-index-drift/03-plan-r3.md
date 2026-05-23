# F13 — Implementation Plan (r3)

Supersedes [03-plan-r2.md](03-plan-r2.md). Addresses plan-review items 1–8 and coordination items in [01-analysis-review-r2.md](01-analysis-review-r2.md). Companion: [01-analysis-r3.md](01-analysis-r3.md), [02-design-r3.md](02-design-r3.md). F13 is the umbrella; F12 r3 is a closure pointer plus its absorbed acceptance shape (see §"Absorbed F12 acceptance shape").

## Validation baseline (MUST use package scripts only)

Run from `/home/salva/g/ml/saivage-v3/`. Resolves plan-review item 5.

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
```

Final gate:

```
npm run preflight     # web:test:sweep + docs:verify
npm test              # full Jest suite
```

Live probe: after any mutation against `http://10.0.3.112:8080`, `GET /api/cards/<id>/history` returns `total > 0`, `max(history[].version_seq) === card.version_seq`, every entry has `entry_id` and `kind`, and `.saivage/runtime/errors.jsonl` shows no new `Canonical hierarchy invariant failed` line during a 5-minute soak. The drift signal that fired in G1/T20 and G5/T45 cannot fire because no `cards/index.json` exists to disagree with the by-id record.

## Async construction chain (resolves plan-review item 2)

The r2 plan said "`CardStore.open` is async and `Runtime`'s constructor becomes async". TS constructors cannot be async. The concrete chain is:

1. **`CardStore.open(projectRoot, eventBus, maxGoalDepth?): Promise<CardStore>`** — async static factory. Performs marker recovery, loads by-id, builds adjacency, runs structural + startup invariant checks. The `new CardStore(...)` constructor becomes `private`.
2. **`Runtime.open(config, agentRuntime?): Promise<Runtime>`** — async static factory. Replaces the public `new Runtime(...)` constructor. The constructor becomes `private` and accepts a pre-built `CardStore`. `Runtime.open` builds the `EventBus` first, then `await CardStore.open(...)`, then constructs the rest synchronously inside the private constructor.
3. **`ActiveRuntime.open(projectRoot, config, mcpManager?): Promise<ActiveRuntime>`** — async static factory. Replaces the public constructor. Performs the same logger/skills/adapter setup, then `const runtime = await Runtime.open(runtimeConfig, this._agentAdapter)`, then wires the event bus the same way [src/runtime/active-runtime.ts](../../../src/runtime/active-runtime.ts#L99) does today.
4. **`createServer`** ([src/server/server.ts](../../../src/server/server.ts#L108)) — already async. Change `new ActiveRuntime(projectRoot, saivageConfig)` to `await ActiveRuntime.open(projectRoot, saivageConfig)`. `await activeRuntime.start()` already follows. Route registration (`registerOperatorContractRoutes`, etc.) already runs after this `await`, so the readiness gate is in place.
5. **Per-route `new CardStore(projectRoot)` sites** (6 sites — see grep below) — convert each to `await CardStore.open(projectRoot)` inside the surrounding async handler. The store is a new instance per request today; per-request `await` is acceptable (boot is sub-100 ms on target projects). The longer-term cleanup of "stop spinning per-request CardStore instances" is out of scope for F13.

Grep target before/after each step:

```
grep -rn 'new CardStore\|new Runtime\|new ActiveRuntime' src/ tests/
```

Pre-F13 sites (verified):

- [src/runtime/runtime.ts#L108](../../../src/runtime/runtime.ts#L108) — inside `Runtime` constructor → moves into `Runtime.open`.
- [src/runtime/active-runtime.ts#L99](../../../src/runtime/active-runtime.ts#L99) — `new Runtime(...)` → `await Runtime.open(...)` inside `ActiveRuntime.open`.
- [src/server/server.ts#L108](../../../src/server/server.ts#L108) — `new ActiveRuntime(...)` → `await ActiveRuntime.open(...)`.
- [src/server/routes/operator-contracts.ts#L55](../../../src/server/routes/operator-contracts.ts#L55) — `new CardStore` → `await CardStore.open`.
- [src/server/routes/chats-files-debug.ts#L75](../../../src/server/routes/chats-files-debug.ts#L75) — same.
- [src/notifications/notification-triggers.ts#L68](../../../src/notifications/notification-triggers.ts#L68) — same; surrounding function becomes async; its callers in `src/notifications/` already are async.
- [src/agents/agent-adapter.ts#L184](../../../src/agents/agent-adapter.ts#L184), [#L385](../../../src/agents/agent-adapter.ts#L385) — same.
- [src/agents/analyst-stage6.ts#L114](../../../src/agents/analyst-stage6.ts#L114), [#L139](../../../src/agents/analyst-stage6.ts#L139), [#L169](../../../src/agents/analyst-stage6.ts#L169), [#L186](../../../src/agents/analyst-stage6.ts#L186), [#L207](../../../src/agents/analyst-stage6.ts#L207) — five sites; surrounding functions already async.
- [src/agents/analyst-tools.ts#L75](../../../src/agents/analyst-tools.ts#L75) `getStore(ctx)` — change return to `Promise<CardStore>`, callers `await`.
- [src/agents/analyst-handler.ts#L444](../../../src/agents/analyst-handler.ts#L444) — same.
- Tests under `tests/` that build `new CardStore(...)` — full list emitted by the grep above; convert in one sweep.

`Runtime` and `ActiveRuntime` get one-line backward-compat shims **deleted**: per the project guideline, the synchronous constructors are removed in the same PR, not deprecated.

## Schema changes (resolves plan-review item 3)

Add `entry_id: string` and `kind: CardHistoryKind` to `CardHistoryEntry`. Apply in this order so a typecheck failure in one fanout location does not block another:

1. [src/schemas/types.ts](../../../src/schemas/types.ts#L55) — add `CardHistoryKind` union and the two fields on `CardHistoryEntry`.
2. [src/schemas/validators.ts](../../../src/schemas/validators.ts#L23) — extend `cardHistoryEntrySchema`: `entry_id: z.string().uuid()`, `kind: z.enum([...])`.
3. [src/schemas/index.ts](../../../src/schemas/index.ts) — re-export `CardHistoryKind`.
4. [src/contracts/operator-api.ts](../../../src/contracts/operator-api.ts#L151) `CardHistoryListResponseSchema` — already wraps the entry schema; verify with `npm run typecheck`.
5. [src/cards/card-store.ts](../../../src/cards/card-store.ts) — every `CardHistoryEntry` constructed by `applyMutation` includes both new fields (constants per kind defined inline).
6. [src/tools/agent-tools.ts](../../../src/tools/agent-tools.ts#L103) — registration for `cards.history.list` / `cards.history.get`; schema already pulled from contracts, so no edit beyond typecheck verification.
7. [src/agents/analyst-tools.ts](../../../src/agents/analyst-tools.ts#L120) — drop `TRACKED_EDIT_FIELDS`; the diff renderer reads `entry.changed_fields` directly. Add `entry.kind` to the rendered diff label.
8. [src/agents/card-history-tools.test.ts](../../../tests/agents/card-history-tools.test.ts) — every fixture entry gains `entry_id` (use `crypto.randomUUID()` in test helpers) and `kind`.
9. [src/api/cards-history.test.ts](../../../tests/api/cards-history.test.ts), [tests/utils/card-history.test.ts](../../../tests/utils/card-history.test.ts), [tests/server/runtime-card-contract-routes.test.ts](../../../tests/server/runtime-card-contract-routes.test.ts), [tests/server/operator-api-contracts.test.ts](../../../tests/server/operator-api-contracts.test.ts), [tests/server/operator-api-contract-fixtures.test.ts](../../../tests/server/operator-api-contract-fixtures.test.ts) — same fixture update.
10. [web/src/api/client.ts](../../../web/src/api/client.ts#L183) — types follow the contract; verify with `npm run web:typecheck`.
11. [web/src/stores/cards.ts](../../../web/src/stores/cards.ts#L307) — cache shape unchanged; types follow.
12. [web/src/__tests__/card-history-panel.test.ts](../../../web/src/__tests__/card-history-panel.test.ts), [web/src/__tests__/card-history-panel-analyst-filter.test.ts](../../../web/src/__tests__/card-history-panel-analyst-filter.test.ts) — every history-entry fixture gains `entry_id` + `kind`. The panel renders the existing fields unchanged; an optional `kind` chip can be added later but is not in F13 scope.
13. [tests/schemas.test.ts](../../../tests/schemas.test.ts) — add a case asserting `cardHistoryEntrySchema` rejects entries missing `entry_id` or `kind`.

## `initProjectTree` / `isNewSaivageState` (resolves plan-review item 4)

[src/persistence/file-tree.ts](../../../src/persistence/file-tree.ts):

- `initProjectTree` ([:148](../../../src/persistence/file-tree.ts#L148)) writes only: `project.json`, `cards/by-id/project.json`, `notes/queue.json`, `views/leaderboard.json`, `views/saved-filters.json`, `skills/index.json`, `runtime/events.jsonl`, `runtime/errors.jsonl`, `supervision/reviews.jsonl`, `supervision/quarantine-index.json`, `saivage.json`. Removes writes of `cards/index.json`, `cards/tree/project.children.json`, `cards/dependencies/depends-on.json`, `cards/dependencies/blocks.json`.
- `SAIVAGE_DIRS` ([:74](../../../src/persistence/file-tree.ts#L74)) removes `cards/tree` and `cards/dependencies`. Adds `cards/.commit`.
- `isNewSaivageState` ([:99](../../../src/persistence/file-tree.ts#L99)–`L118`) — drop the `cards/tree`, `cards/dependencies` required-dir entries and the `cards/index.json` validity check. The required check becomes: `cards/by-id`, `agents/sessions`, `agents/messages`, `runtime`, `notes/by-card`, `views`, `supervision` directories exist, plus `project.json`, `cards/by-id/project.json`, `notes/queue.json` parse against their schemas.
- Delete `defaultCardIndexEntry`, `defaultDependsOnIndex`, `defaultBlocksIndex` ([:70](../../../src/persistence/file-tree.ts#L70)–`L149`).
- Delete the `cardIndexSchema` import at [:5](../../../src/persistence/file-tree.ts#L5).
- [tests/utils/file-tree.test.ts](../../../tests/utils/file-tree.test.ts) — update assertions: after `initProjectTree`, `ls .saivage/cards/` shows only `by-id/`, `history/`, `.commit/`. `isNewSaivageState` returns true for the slim seed. Add a case asserting that the old seed shape (with `cards/index.json` and `cards/tree/`) is **not** treated as new — it is discarded as legacy and reinitialized.

## Absorbed F12 acceptance shape (F13 must keep these green)

F12 r3 is a closure pointer. The F12-specific acceptance criteria F13 must satisfy:

- [tests/api/cards-history.test.ts](../../../tests/api/cards-history.test.ts) — `GET /api/cards/<id>/history` returns `total > 0` after any mutation; entries carry `entry_id` and `kind`; `max(history[].version_seq) === card.version_seq`.
- [tests/utils/card-history.test.ts](../../../tests/utils/card-history.test.ts) — REWRITTEN: the assertion at L43 ("update without tracked fields does not append history") is replaced with "every `update()` call appends exactly one history line whose `kind` is `'update'` and whose `changed_fields` contains the diffed keys". The orphan-recovery cases at L66–L117 (which rely on the deleted `reconcileCardHistory`) are replaced with: hand-inject an orphan tail whose `version_seq > card.version_seq` and assert `CardStore.open` throws `CardStoreInvariantError` with the file path and recovery hint.
- [tests/utils/card-store-startup-refusal.test.ts](../../../tests/utils/card-store-startup-refusal.test.ts) — update boot-refusal cases for the slim layout (no `cards/index.json`); add cases for marker-corruption refusal and JSONL-deep-corruption refusal.
- New: [tests/utils/apply-mutation.test.ts](../../../tests/utils/apply-mutation.test.ts) — happy-path coverage for each `kind` (`create`, `update`, `status`, `mutate`, `delete`, `archive`, `depends`); each asserts exactly one history line with the right `kind`, `entry_id` is a valid UUID, `version_seq` bumps by 1, and the in-memory state matches the on-disk by-id record after the call returns.
- [tests/server/websocket-analyst-safety.test.ts](../../../tests/server/websocket-analyst-safety.test.ts) — assert `card_history_appended` fires exactly once per `applyMutation` (the existing `card_history_record_appended` assertion is deleted because the internal event is gone).
- [tests/projections/ledger-projections.test.ts](../../../tests/projections/ledger-projections.test.ts) — delete the `CardHistoryProjection` test block; the rest stays unchanged.
- [tests/agents/card-history-tools.test.ts](../../../tests/agents/card-history-tools.test.ts) — every fixture and assertion updated to the new entry shape.
- Web: [web/src/__tests__/card-history-panel.test.ts](../../../web/src/__tests__/card-history-panel.test.ts) and [.../card-history-panel-analyst-filter.test.ts](../../../web/src/__tests__/card-history-panel-analyst-filter.test.ts) — same.

## Crash-injection test matrix (resolves plan-review item 8)

New file [tests/utils/card-store-crash-injection.test.ts](../../../tests/utils/card-store-crash-injection.test.ts). Harness wraps `applyMutation` with a configurable `abortAfter` failure point, runs a sequence of mutations against a fresh tmp project under `/home/salva/g/ml/saivage-v3/tmp/`, closes the store, reopens via `CardStore.open`, asserts on both on-disk and in-memory state. Matrix:

| Abort point | Mutation kind(s) | Disk-state assertion | In-memory assertion |
| --- | --- | --- | --- |
| Before staging tmp | every | unchanged | unchanged |
| After tmp staged, before marker rename | every | tmp present; recovery unlinks it | unchanged |
| After marker rename, before by-id rename | create, update, status, mutate, delete, depends | marker + tmp present; recovery completes rename + appends history + unlinks marker | post-mutation card visible |
| After by-id rename, before history append | every | marker + new by-id; recovery appends history if `entry_id` not last, unlinks marker | post-mutation card visible |
| After history append, before marker unlink | every | marker + new by-id + history line; recovery is no-op append (entry_id matches) + unlink marker | post-mutation card visible |
| After marker unlink | every | committed | post-mutation card visible |
| Mid history append (partial JSONL line) | update | marker + new by-id + truncated JSONL tail | recovery truncates partial to sidecar, appends, unlinks marker; reopened state matches commit |
| Marker file corruption (write garbage to `.commit/<token>.json`) | n/a (injected after a successful mutation) | corrupt marker present | `CardStore.open` throws `CardStoreInvariantError` naming the marker path |
| Orphan tmp without marker | n/a (synthesize a `.tmp.<token>` next to by-id) | tmp present, no marker | recovery unlinks tmp; reopened state is the pre-tmp commit |
| Multi-card archive crash after each per-card prefix (0..N) | archive | group marker + per-card marker for next card, prior cards unlinked, current card still present | recovery resumes; final reopened state matches a clean `archiveAndDeleteSubtree` from the same starting state |
| Reopen with by-id-only seed state (no `cards/index.json`, no `.commit/`, no derived files) | n/a | only `cards/by-id/`, `cards/history/`, `cards/.commit/` directories exist | `CardStore.open` succeeds; `state.list()` returns the seeded cards |

Plus [tests/utils/card-store-boot-recovery.test.ts](../../../tests/utils/card-store-boot-recovery.test.ts): 50 mutations interleaved with 10 random crash injections (seeded RNG), assert the final reopened state matches the expected sequence and no marker is left behind.

## Dead-code inventory (complete; resolves plan-review item 6)

After all PRs land, the following greps must each return zero matches in `src/` and `tests/`. Web greps are run separately with `web/src/`.

Identifiers:

```
grep -rn 'cardIndexSchema\|cardChildrenIndexSchema\|cardDependencyIndexSchema\|cardBlocksIndexSchema' src/ tests/ web/src/
grep -rn 'CardIndex\b\|CardChildrenIndex\b\|CardDependencyIndex\b\|CardBlocksIndex\b' src/ tests/ web/src/
grep -rn 'CardIndexEntry\|cardIndexEntrySchema' src/ tests/ web/src/
grep -rn 'defaultCardIndexEntry\|defaultDependsOnIndex\|defaultBlocksIndex' src/ tests/
grep -rn 'CardHistoryProjection\|registerCardHistoryProjection\|cardHistoryLedger' src/ tests/
grep -rn 'card_history_record_appended\|CardHistoryRecordAppendedEvent' src/ tests/
grep -rn 'CardStoreHealth\b\|CardStoreCanonicalHealth\|CardStoreHealthSchema\|cardStoreHealth\b' src/ tests/ web/src/
grep -rn 'getHealth\b' src/cards/ tests/utils/card-store.test.ts
grep -rn 'HierarchyGraph' src/ tests/
grep -rn 'reconcileCardHistory\|appendHistoryEntry\|writeHistoryEntries\|loadHistoryEntries' src/ tests/
grep -rn 'parseChildrenIndex' src/ tests/
grep -rn 'recomputeBlocks' src/ tests/
grep -rn 'TRACKED_FIELDS\|TRACKED_UPDATE_FIELDS\|TRACKED_EDIT_FIELDS' src/ tests/
grep -rn 'addToIndex\|removeFromIndex\|loadIndex\|saveIndex\|loadDependsOn\|saveDependsOn\|loadBlocks\|saveBlocks\|indexPath\|dependsOnPath\|blocksPath' src/cards/ tests/
grep -rn 'validatedPersistedState\|ensurePersistedStateValidated\|validatePersistedState\|loadCanonicalCardsFromDisk\|writeCard' src/cards/ tests/
grep -rn 'beforeTrackedCardRename' src/ tests/
grep -rn 'cards/tree\|cards/dependencies' src/ tests/ web/src/   # only `.commit/`, `by-id/`, `history/` remain
```

Files / modules deleted outright:

- None outright; every file above keeps at least one symbol after the rewrite, except potentially [src/cards/card-store.ts](../../../src/cards/card-store.ts)'s standalone `HierarchyGraph` class (deleted; its checks move into `CardStoreState`).

Files emptied of F13-related content (deletion of test blocks only):

- [tests/projections/ledger-projections.test.ts](../../../tests/projections/ledger-projections.test.ts) — `CardHistoryProjection` block.

Schema declarations to remove:

- `cardIndexSchema`, `cardChildrenIndexSchema`, `cardDependencyIndexSchema`, `cardBlocksIndexSchema` from [src/schemas/validators.ts](../../../src/schemas/validators.ts#L27-L30).
- `CardIndexEntry`, `CardIndex`, `CardChildrenIndex`, `CardDependencyIndex`, `CardBlocksIndex` from [src/schemas/types.ts](../../../src/schemas/types.ts#L58-L62).
- Corresponding re-exports in [src/schemas/index.ts](../../../src/schemas/index.ts#L33-L37).
- `CardStoreHealthSchema`, `CardStoreCanonicalHealth*` from [src/schemas/](../../../src/schemas/) and [src/contracts/operator-api.ts](../../../src/contracts/operator-api.ts#L99), [src/contracts/index.ts](../../../src/contracts/index.ts#L22).
- `CardHistoryRecordAppendedEvent` interface from [src/schemas/types.ts](../../../src/schemas/types.ts) (if present).

Event registry:

- [src/events/registry.ts](../../../src/events/registry.ts#L65) — remove `card_history_record_appended` event kind. Keep `card_history_appended` ([L58](../../../src/events/registry.ts#L58)).

Projection module:

- [src/projections/ledger-projections.ts](../../../src/projections/ledger-projections.ts#L52-L168) — delete `CardHistoryProjection`, `registerCardHistoryProjection`, `cardHistoryLedger`. Update `registerLedgerProjections` to not call them.
- [src/projections/index.ts](../../../src/projections/index.ts) — drop the deleted exports.

`cards/tree/<id>.children.json` writer:

- The only writer is `initProjectTree` ([src/persistence/file-tree.ts](../../../src/persistence/file-tree.ts#L156)). Deleted.
- The only reader is `parseChildrenIndex` in `card-store.ts`. Deleted (it returns the in-memory children list now).

Dashboard / control-room cleanup:

- `grep -rn 'cardStoreHealth' web/src/` — every match in store fields, components, and tests is deleted. The websocket envelope at [src/server/websocket.ts](../../../src/server/websocket.ts#L95) drops the field.
- [src/server/routes/operator-contracts.ts](../../../src/server/routes/operator-contracts.ts#L88) — remove the hard-coded `cardStoreHealth: { canonical: 'ok' }` from the response.
- [src/contracts/operator-events.ts](../../../src/contracts/operator-events.ts#L42) — drop `cardStoreHealth` field from snapshot envelope.

Related tests:

- [tests/server/operator-api-contracts.test.ts](../../../tests/server/operator-api-contracts.test.ts), [tests/server/operator-api-contract-fixtures.test.ts](../../../tests/server/operator-api-contract-fixtures.test.ts), [tests/server/websocket-analyst-safety.test.ts](../../../tests/server/websocket-analyst-safety.test.ts), [tests/server/server-availability-contract.test.ts](../../../tests/server/server-availability-contract.test.ts) — remove every `cardStoreHealth` assertion (do not replace with a stub).
- [tests/utils/card-store.test.ts](../../../tests/utils/card-store.test.ts) — remove the test cases that exercised `update()` and `setStatus()` skipping history (stale per F12 closure). Add cases asserting both methods now produce history entries with the right `kind`.
- [tests/utils/card-history.test.ts](../../../tests/utils/card-history.test.ts) — see "Absorbed F12 acceptance shape" above for the rewrites.

## Step sequencing

Steps are intended to land as one merge train. Each step keeps the typecheck and targeted Jest baseline green.

1. **Schema fanout.** Add `entry_id` + `kind` to the schema + type + every fixture (no production code uses them yet; tests pass `crypto.randomUUID()` placeholders).
2. **`CardStoreState` extraction.** New module `src/cards/state.ts` containing the in-memory state + adjacency rebuild + structural validators (carried verbatim from `HierarchyGraph.build` minus the index↔by-id check). New test `tests/utils/card-store-state.test.ts`.
3. **Commit-marker + idempotent ledger.** New `src/cards/commit-marker.ts`; `appendSyncIdempotent` added to [src/persistence/jsonl-ledger.ts](../../../src/persistence/jsonl-ledger.ts) implementing the partial-line truncate-to-sidecar contract from [02-design-r3.md](02-design-r3.md) §"JSONL crash semantics".
4. **`applyMutation`.** New `src/cards/apply-mutation.ts` implementing the seven-step sequence. New tests `tests/utils/apply-mutation.test.ts`, `tests/utils/card-store-crash-injection.test.ts`, `tests/utils/card-store-boot-recovery.test.ts`.
5. **`CardStore` rewrite + `CardStore.open` factory.** All mutation methods become thin wrappers around `applyMutation`; all reads go through `CardStoreState`. `validatePersistedState`, `reconcileCardHistory`, `recomputeBlocks`, `appendHistoryEntry`, `parseChildrenIndex`, `HierarchyGraph`, the `TRACKED_*` constants, `canonicalHealth`, `getHealth`, the index/deps/blocks helpers — all deleted in this step.
6. **`Runtime.open` + `ActiveRuntime.open` + server wiring.** Async construction chain.
7. **`initProjectTree` / `isNewSaivageState` slimmed.** `SAIVAGE_DIRS` updated. Default-index helpers deleted.
8. **Projection + event-registry deletion.** `CardHistoryProjection`, `registerCardHistoryProjection`, `card_history_record_appended`. `card_history_appended` is emitted from inside `applyMutation`.
9. **Contract / dashboard / websocket cleanup.** `cardStoreHealth` removed everywhere, including the hard-coded literal at [src/server/routes/operator-contracts.ts](../../../src/server/routes/operator-contracts.ts#L88).
10. **Final grep sweep.** All identifiers in §"Dead-code inventory" return zero matches.

Steps 5–7 must land together (a freshly seeded project without `cards/index.json` cannot be opened by the pre-step-5 `CardStore`). Steps 1–4 are additive and land first. Steps 8–10 are deletion-only and land last.

## F19 / F20 / F23 ordering pin (resolves coordination)

- **F13 lands first.** F19, F20, F23 rebase onto it.
- **F19 (runtime pinned to failed card)** — its fix calls `cardStore.setStatus`. After F13, this is `await cardStore.setStatus(...)` and produces a history entry with `kind: 'status'` and `entry_id`. F19's tests gain free audit-trail assertions; the F19 tests in `tests/runtime/runtime-activation-ledger.test.ts` and `tests/runtime/runtime-command-ledger.test.ts` are updated when F13's schema-fanout step rewrites their fixtures.
- **F20 (executor false-failed)** — independent (lives in the executor wrapper, not the card store). No F13 coordination needed; F20 lands any time before or after F13.
- **F23 (illegal `failed → active`)** — patches `validateTransition`. After F13, `validateTransition` lives in `CardStoreState`. F23 patches the moved function. If F23 lands before F13, its patch sits in `card-store.ts` and is carried verbatim into `state.ts` by F13's step 2.

## Rollback (resolves plan-review item 7)

Per the project guideline (architecture-first, no backward compatibility), rollback is one of:

- **Revert the PR series before release.** `git revert` the F13 merge commit. The pre-F13 code expects `cards/index.json` and friends on disk and reads history entries without `entry_id` / `kind`; after revert, dev environments must reset the local `.saivage` state because the on-disk history files have the new schema. There is **no** bidirectional runtime compatibility shim.
- **Reset local `.saivage` state.** For dev or CI environments where a corrupt commit-marker recovery is suspected, `rm -rf .saivage/cards/.commit/` recovers from a bad marker. To go back to a pre-F13 baseline, `rm -rf .saivage/` and rerun `initProjectTree` against the pre-F13 binary.

No "old code reads new files correctly", no "new code reads old files via a shim", no `@deprecated` markers anywhere.

## Risk and mitigations

- **Async fan-out misses.** Mitigation: every `new CardStore(...)` / `new Runtime(...)` / `new ActiveRuntime(...)` becomes a typecheck error after step 5 because the public constructors are removed; the grep in §"Async construction chain" is the mechanical gate.
- **Fixture tests writing `cards/index.json` directly.** Mitigation: the schema deletion in step 9 makes any code that names `CardIndex` / `cardIndexSchema` a typecheck error; the grep in §"Dead-code inventory" is the mechanical gate.
- **Corrupt last history line after hard kill.** Handled by the partial-line contract in [02-design-r3.md](02-design-r3.md) §"JSONL crash semantics"; exercised by the crash-injection matrix.
- **Operator hand-edits `cards/by-id/<id>.json` between mutations.** Honored on next `CardStore.open`. The startup invariant check catches inconsistency between by-id and the last history line.
