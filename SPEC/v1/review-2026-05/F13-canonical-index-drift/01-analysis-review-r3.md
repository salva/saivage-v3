## Analysis review

1. Align the F12 closure semantics before implementation. [01-analysis-r3.md](01-analysis-r3.md) says `GET /api/cards/<id>/history` should have `max(history[].version_seq) === card.version_seq` after mutation, while F12 r3 requires `max(history[].version_seq) === card.version_seq - 1` and pre-mutation snapshots in [../F12-card-history-empty/01-analysis-r3.md](../F12-card-history-empty/01-analysis-r3.md) and [../F12-card-history-empty/03-plan-r3.md](../F12-card-history-empty/03-plan-r3.md). The current substrate tests also encode pre-edit snapshots in [tests/utils/card-history.test.ts](../../../tests/utils/card-history.test.ts). Update F13 analysis, design, plan, live probe, and crash tests to use one contract.

2. Spell out the final `CardHistoryEntry` meaning for every `kind` after the F12 alignment. The analysis adds `entry_id` and `kind`, but it still leaves unclear whether `create`, `delete`, `archive`, and `depends` entries snapshot the pre-mutation record, the post-mutation record, or a tombstone shape, and whether deleted-card history remains queryable through `cards.history.get`. Add a small table that defines `version_seq`, `snapshot`, and route visibility for `create`, `update`, `status`, `mutate`, `delete`, `archive`, and `depends`.

3. Complete the schema fanout list with the actual current surfaces. Add [web/src/api/types.ts](../../../web/src/api/types.ts) (`CardHistoryHeader`, `CardHistoryEntry`, and response interfaces), [src/contracts/index.ts](../../../src/contracts/index.ts) exports, `CardHistoryEntryResponseSchema`, and the actual agent tool names in [src/tools/agent-tools.ts](../../../src/tools/agent-tools.ts) (`list_card_history`, `get_card_history_entry`). Do not say the contract response already wraps `cardHistoryEntrySchema`; current [src/contracts/operator-api.ts](../../../src/contracts/operator-api.ts) uses `z.record(...)` for both history list and entry responses.

4. Make the F12 acceptance handoff exact, not summarized. F13 says it absorbs F12, but the F13 analysis only lists a subset and uses the wrong sequence invariant. Cross-link the F12 r3 acceptance test list and state that F13 must include those tests verbatim, including `operator-dashboard-smoke`, `history/<seq>`, `diff`, and the exact `card.version_seq - 1` assertions.

## Design review

1. Change the on-disk write sequence so the durable history line matches the F12 pre-mutation contract. [02-design-r3.md](02-design-r3.md) step 2 currently computes the entry with the new `version_seq`, but F12 and current `getCardAt`/`diffCard` semantics require the history row for seq `N` to be the snapshot before the mutation that produces current seq `N + 1`. Keep the public websocket event free to report the post-mutation card version, but define the durable history row separately.

2. Tighten startup invariants from "no future orphan" to "no missing audit tail". Boot recovery currently accepts `last.version_seq < card.version_seq` as an audit gap, and the crash table explicitly accepts out-of-band history truncation as current-state-safe. That violates F12's `total >= card.version_seq - 1`, `history/<seq>` no-404, and diff-pivot requirements. Require contiguous history entries for every expected seq, reject duplicates/gaps after `entry_id` de-duplication, and make history truncation a loud `CardStoreInvariantError`.

3. Make JSONL tail repair implementable for full-sized history records. The proposed "read last 4 KB" algorithm cannot parse a final complete line if a `CardRecord` snapshot makes the line longer than 4 KB. Define a backwards scan to the previous newline, or a bounded/full-file strategy that always obtains the whole final line. Also state whether `appendSyncIdempotent` performs full-file corruption detection or only tail repair, and which boot path throws on deep corruption.

4. Extend the multi-card archive proof beyond parent-child ordering. Descendants-first deletion preserves parent references, but the structural validator also checks dependency closure and `blocks` consistency. Define how `archiveAndDeleteSubtree` handles surviving cards whose `depends_on` references a deleted card, surviving cards whose `blocks` array changes because a dependent was deleted, and whether those survivor rewrites receive their own `kind`/history entries inside the same group marker.

5. Finish the group-marker recovery state machine. Specify recovery for crash points after the group marker is written but before the first per-card marker, after a per-card marker is written but before its by-id operation, after a per-card marker is unlinked but before the group marker is unlinked, and for a corrupted per-card marker referenced by a valid group marker. The plan's matrix covers prefixes, but the design needs the exact marker/entry presence checks that make those prefixes idempotent.

6. Move `card_history_appended` emission outside the held mutation lock, or explicitly guard reentrancy. The design emits from step 8 and releases the project mutex/lock at step 9. Because the event bus is synchronous, a subscriber that calls back into `CardStore` can deadlock or violate the reentrancy class the analysis identified. Emit after lock release with a captured payload, or document a non-reentrant event dispatch guard and test it.

## Plan review

1. Fix the `ActiveRuntime.open` factory mechanics. The plan says a static factory calls `Runtime.open(runtimeConfig, this._agentAdapter)`, but there is no instance `this` before construction. Define the exact private-constructor shape: either build `AgentAdapter` and `Runtime` in local variables and pass both into `new ActiveRuntime(...)`, or construct an instance in a private initializing state and await a private `init` method. Keep `createServer` route registration gated on the awaited factory.

2. Make the async-constructor fanout complete and machine-verifiable. The production chain is mostly named, but the text says "6 sites" while `rg -n 'new CardStore|new Runtime|new ActiveRuntime' src tests` returns many more production and test call sites. Add a generated checklist or a grep-output appendix that includes all production sites plus the test helper strategy; otherwise removing the public constructors will strand dozens of tests and fixtures.

3. Correct the schema plan around contracts and web types. [03-plan-r3.md](03-plan-r3.md) says `CardHistoryListResponseSchema` already wraps the entry schema; it does not. Add explicit edits for `CardHistoryListResponseSchema`, `CardHistoryEntryResponseSchema`, typed list headers vs. full entry payloads, [web/src/api/types.ts](../../../web/src/api/types.ts), web mocks, and contract fixtures.

4. Add the missing F12 web and live validation gates using package scripts. `package.json` has `web:test:operator-smoke`, but the F13 baseline does not run it. Add `npm run web:test:operator-smoke` and an explicit run for [web/src/__tests__/card-history-panel.test.ts](../../../web/src/__tests__/card-history-panel.test.ts), then fix the live probe to assert `max(history[].version_seq) === card.version_seq - 1` and `history/<seq>`/`diff` success, not equality to `card.version_seq`.

5. Define how `isNewSaivageState` rejects legacy state after the slim-layout change. Dropping `cards/index.json`, `cards/tree`, and `cards/dependencies` from required checks will let an old seed that also has `cards/by-id/project.json` pass unless the function actively rejects deleted derived files. Add the concrete negative checks and tests for old derived files being treated as legacy, not silently accepted.

6. Complete the dead-code grep inventory for literal paths and direct readers. Add an `rg` target for `cards/index\.json` across `src/`, `tests/`, and `web/src/`; current code includes a user-facing index-file diagnostic in [src/server/routes/chats-files-debug.ts](../../../src/server/routes/chats-files-debug.ts) that the listed greps would miss. Keep the existing `cards/tree|cards/dependencies` and `cardStoreHealth` greps, and add [web/src/api/types.ts](../../../web/src/api/types.ts) to the explicit contract cleanup list.

7. Add F12 assertions to every crash-injection recovery case. The matrix covers partial JSONL, marker corruption, orphan tmp, multi-card prefixes, and by-id-only reopen, but it should also assert after each successful recovery that history is contiguous, `max(history[].version_seq) === card.version_seq - 1`, every `history/<seq>` in range resolves, and `diff` works across the recovered sequence.

8. Remove the rollback instruction that says `rm -rf .saivage/cards/.commit/` recovers from a bad marker. The design declares corrupt markers fatal and operator-visible; deleting marker files can discard the only durable description of an in-flight commit. Keep rollback to PR revert before release or full local `.saivage` reset.

9. Decide the mutex implementation in the plan. The design names `async-mutex` or a hand-rolled promise chain, but [package.json](../../../package.json) does not currently include `async-mutex`. Either add the dependency and validation impact explicitly, or specify the local no-dependency implementation.

## Cross-check with F12 r3

1. Include every test from [../F12-card-history-empty/03-plan-r3.md](../F12-card-history-empty/03-plan-r3.md) verbatim in F13's test list. F13 currently omits `web/src/__tests__/operator-dashboard-smoke.test.ts` and does not spell out the exact `tests/server/operator-api-contracts.test.ts` cases for title patch, status patch, two consecutive patches, `history/1`, and `diff`.

2. Replace all F13 `card.version_seq` history-tail assertions with F12's `card.version_seq - 1` assertions unless the orchestrator explicitly changes F12. This applies to the analysis acceptance bullets, the design write sequence, the plan live probe, `apply-mutation` tests, boot-recovery tests, and crash-injection matrix.

3. Preserve the F12 public route/event contract while adding `entry_id` and `kind`. F12 requires `cards.history.list`, `cards.history.get`, the history wire responses, and `card_history_appended` to keep their public paths and response/event shape. If F13 tightens schemas from `z.record(...)` to typed entries, add contract tests proving existing consumers still receive the expected fields plus the new fields.

4. Cover every F12 mutation surface through real entrypoints, not only the new primitive. Add acceptance assertions for HTTP PATCH, runtime/planner calls, analyst tools, `setStatus`, `update`, `updateDependsOn`, `create`, `delete`, and `archiveAndDeleteSubtree`, each proving exactly one history entry and exactly one websocket event per successful version bump.

5. Make silent truncation impossible, not merely less likely. F12 requires deletion of `reconcileCardHistory` and any equivalent silent rewrite path. F13 must not replace it with a softer acceptance of missing committed history lines as an "audit gap"; missing or truncated history for an existing version sequence is a startup invariant failure.

VERDICT: CHANGES_REQUESTED