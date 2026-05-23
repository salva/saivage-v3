## Analysis review

The r2 analysis fixes several r1 problems: it no longer blames `update()`/`setStatus()` for bumping `version_seq`, separates projection-lock aborts from committed empty history, treats startup reconciliation as data loss, adds the missing reader/consumer surfaces, and correctly states that F12 and F13 are not logically inseparable.

Still not fully addressed:

1. r1 analysis items #1 and #6 remain only partially satisfied. Section 3 says the `version_seq > 1` plus empty-history state is "reachable today by exactly two production paths", but the listed crash/rollback paths leave the card version unchanged unless followed by later successful mutations, and the document then admits `version_seq=4` with truly empty history requires a reset, history wipe, or different `projectRoot`. That is not a proof of the reported invariant. Rewrite the conclusion so it distinguishes: (a) proven code defects, (b) synthetic crash/orphan behaviour, and (c) the audit observation that is no longer directly reproducible.

2. The reproduction recipe is useful as an injection test, but it does not prove the original live invariant. It hand-edits by-id/history state, uses `/tmp/x` instead of workspace-local `tmp/`, and proves `reconcileCardHistory()` deletes an injected orphan tail rather than proving how a real `version_seq=4` card got an empty ledger. Keep it, but label it as a destructive synthetic invariant test and add a separate non-destructive inspection recipe for the live state.

3. The analysis says F12 subsumes F13 as an architecture-first choice and says F13 r2 "should reflect that it is subsumed." That is not true of the actual F13 r2 documents under review; they choose Proposal C and say F12 is subsumed by F13. This turns the analysis stance into a coordination defect, not an addressed r1 item.

## Design review

The F12 r2 design addresses the local r1 design asks in isolation: Proposal A and B.2 are rejected, `applyMutation` is async, the wire-schema decision is explicit, silent history reconciliation is rejected, and the public `card_history_appended` event is intentionally preserved.

Changes still required:

1. The accepted design is not mutually consistent with F13 r2 Proposal C. F12 B.1 deletes `cards/index.json`, `depends-on.json`, and `blocks.json` from the durable layout; F13 C keeps `cards/index.json`, `depends-on.json`, `blocks.json`, and `cards/tree/<id>.children.json` as derived projections. F12 uses append-then-rename with truncate/fatal-startup semantics; F13 uses commit markers with idempotent history replay. Pick one architecture.

2. The locking model is still unsafe for cross-card state. F12 says per-card locks are sufficient because shared files are deleted, but it also says `card.blocks` is recomputed from the by-id glob and written back into by-id records at mutation time. A dependency mutation on card A can change the `blocks` field of cards B/C; writing those neighbour records while holding only A's lock races with mutations of B/C. Either make `blocks` purely derived/in-memory as F13 C does, or hold a store-wide/project lock for any mutation that writes more than one card record.

3. The mutation coverage is incomplete for the stated "every mutation produces history" contract. The analysis enumerates `create()`, `delete()`, `archiveAndDeleteSubtree()`, and dependency changes as part of the same write set, but the F12 design's collapse list focuses on `update`, `mutateCard`, `setStatus`, `updateDependsOn`, and `activateGoal`. If F12 is the umbrella, the design must define history semantics and transaction coverage for create/delete/archive as F13 r2 does.

4. The event ownership conflicts with F13. F12 removes the `eventBus` constructor parameter from `CardStore` and has runtime/routes/tools emit `card_history_appended` after `applyMutation`; F13 keeps an event-bus-aware `CardStore` and emits after every mutation method. Both cannot be the final design.

5. The dead-code list is complete enough for the r1 F12-focused asks, but not for the expanded F13-subsuming claim. It omits or conflicts with F13's deletion inventory for `validatedPersistedState`, `ensurePersistedStateValidated`, `loadCanonicalCardsFromDisk`, `writeCard`, `canonicalHealth`, `CardStoreCanonicalHealth`, `getHealth`, `CardHistoryRecordAppendedEvent`, `HierarchyGraph`, `cards/tree/<id>.children.json` projection handling, dashboard `cardStoreHealth` consumers, and related tests. Align the deletion list with the chosen umbrella plan.

## Plan review

The plan improves the test surface and names more call sites than r1, but several required r1 plan changes are still unresolved.

1. r1 plan item #1 is not addressed. The plan explicitly admits an "unsafe-intermediate window" in Steps 3-6 where per-card locks protect mutations that still write shared cache files. Saying the files are temporarily write-only does not make concurrent writes safe, and "single merge train" is not an implementation invariant. Remove the intermediate state entirely, or use one store-wide/project lock until shared writes are gone.

2. The step order contradicts the sequencing rationale. Step 3 says it removes cache-file reads and still writes the cache files; Step 5 again makes the same files write-only; Step 6 finally stops writes. Collapse or reorder these so there is one clear transition from authoritative/shared files to derived/no-read files.

3. The async conversion is still narrower than the claimed mutation model. If every state-changing card operation is covered, the plan must include `create`, `delete`, `archiveAndDeleteSubtree`, and any constructor/opening changes required by the selected architecture. F13 r2's `CardStore.open(...)` plan is not represented in F12 r2.

4. The plan's validation commands mostly use the correct root runner (`npm run typecheck`, `npm run test:direct`), but there are concrete mismatches with `package.json` and the tree. `tests/persistence/file-tree.test.ts` does not exist; the file is `tests/utils/file-tree.test.ts`. The web baseline says "run from `web/`" but uses `npm run web:test`, which only exists at the repo root; from `web/` the command is `npm run test -- ...`, or from the root use `npm run web:test -- ...`.

5. The validation baseline should not keep ambiguous "full Jest baseline" language without a stable target after deleting projection/health tests. List the exact root Jest files that remain after the selected design lands, and list the exact tests that are deleted or rewritten.

6. The live probe is good, but it must be tied to the chosen F13/F12 architecture. F12 checks for no `Canonical hierarchy invariant failed` line while deleting canonical-health/index drift entirely; F13 regenerates derived projections and removes `cardStoreHealth`. The expected probe result should match the final selected implementation, not both.

## Coordination check (F13)

F12 r2 and F13 r2 are not mutually consistent.

1. Umbrella conflict: F12 says "this plan is the single approved workstream for F12 and F13" and that F13 r2 should be a pointer back to F12. F13 says the opposite: F12 is subsumed by F13, F12 should be marked closed by F13, and there should be no separate PR.

2. Architecture conflict: F12 accepted B.1 deletes the derived files; F13 Proposal C keeps them as derived projections, adds `src/cards/projections-writer.ts`, and regenerates `cards/tree/<id>.children.json` too.

3. Crash-safety conflict: F12 relies on append-first plus rollback/fatal startup checks. F13 relies on durable commit markers and idempotent history append/recovery. These are different persistence protocols.

4. Locking conflict: F12 uses per-card locks for independent mutations. F13 uses an in-process mutex plus `runtime/project.lock` across the whole mutation, which is necessary for multi-card/archive/projection regeneration semantics.

5. API lifecycle conflict: F12 leaves the store constructor model mostly intact and moves public event emission outside the store. F13 makes `CardStore.open(...)` async and keeps mutation/event emission inside the store.

Concrete asks:

1. Choose one umbrella. Since F13 r2 is the latest document that explicitly selects Proposal C, the simplest fix is to rewrite F12 r2 as "F12 is closed by F13 Proposal C" and point its implementation plan to F13, with only F12-specific acceptance tests retained here.

2. If F12 is intended to remain the umbrella instead, rewrite F13 r2 design and plan to match F12 B.1 exactly. Do not leave F13 on Proposal C while F12 claims to subsume it.

3. After choosing the umbrella, update the dead-code inventory, validation commands, crash-injection tests, and mutation semantics in both issue directories so they describe one implementable workstream.

VERDICT: CHANGES_REQUESTED