## Analysis review

r4 addresses the r3 analysis requests. The runtime-originating `CardStatus` inventory now includes the multi-line executor result writer at [../../../../src/runtime/runtime.ts](../../../../src/runtime/runtime.ts#L725-L733), classifies the evidence-registration downgrade at [../../../../src/runtime/runtime.ts](../../../../src/runtime/runtime.ts#L740) as a control-flow hazard rather than an independent legal transition, and correctly scopes nested `result.planning.status` payloads out of the card-status inventory. The L266 reviewer-phase repair classification is also corrected: the construction proof ties the incoming state to `activateGoal` and `invokeReviewer`, and the chosen machine action is `reviewer_repair_resume`, not `restart`.

No analysis changes required.

## Design review

The r3 design blockers are resolved in substance. `transitionCard` is explicitly async and all `transitionCard` snippets are awaited; the action table emits legal one-step sequences under [../../../../src/cards/card-store.ts](../../../../src/cards/card-store.ts#L217-L227), including `restart` from `cancelled` through `drafting` and decomposed `fail` paths through `running`; the executor terminal restructure folds L725-L733 and L740 into one `executor_finish` transition; and the `enforceInvariants` staging is now aligned as Step 3 observe-only, Step 4 true with corrective bodies, Step 7 flag removal.

1. The design/plan snippets still need to reflect F13 r4's async `CardStore.update` surface for follow-up non-status writes. The executor terminal restructure and Step 5 bullets correctly await `transitionCard`, but follow-up calls such as `this.cardStore.update(card.id, { result, error, ... })` are shown without `await`. Since F13 r4 routes mutations through async `applyMutation`, F19 should require `await` on those non-status payload updates too, or explicitly state why they are intentionally fire-and-forget. The latter would be surprising here because these payloads carry executor results, registration failures, and error text that must be durable before the runtime proceeds.

## Plan review

Most r3 plan asks are addressed: Step 5 now covers [../../../../src/runtime/runtime.ts](../../../../src/runtime/runtime.ts#L725-L733) and deletes the old L740 downgrade path through the executor terminal restructure; Step 5 adds deterministic Jest coverage for executor `done`, executor `failed`, evidence-registration failure, every `RESTARTABLE_STATES` member, and illegal sequences; Probe-D remains informational with explicit Jest gates; and Step 6 no longer lands net-new invariant logic.

1. The final AST gate is not runnable with the current package dependencies. The Step 7 gate imports `ts-morph` and runs with `npx tsx`, with `ts-node/esm` as the fallback, but [../../../../package.json](../../../../package.json) contains none of `ts-morph`, `tsx`, or `ts-node`. This violates the requested dependency check for the grep gate. Add the required dev dependency or dependencies with explicit rationale and a committed script command, or replace the gate with the documented multiline `rg` fallback. As written, Step 7 will fail before it can enforce anything.

2. Step 5 imports permission constants that are currently module-local. [../../../../src/permissions/card-permissions.ts](../../../../src/permissions/card-permissions.ts#L28-L29) defines `RESTARTABLE_STATES` and `STARTABLE_STATES` as non-exported constants, but the plan says to import `STARTABLE_STATES` and drive tests from `RESTARTABLE_STATES`. Add an explicit plan item to export these constants (and update any public-surface expectations), or have F19 define its own local typed sets from `CardStatus` with a test that keeps them synchronized with the permission matrix.

3. Step 5 should state that every post-F13 `cardStore.update` follow-up is awaited, not only every machine call. This applies to the non-status updates after startup repair, planner failure, executor terminal completion, ignored/failed evidence registration payloads, and planner-status rejection bookkeeping. Without that, the docs can produce code that satisfies the `transitionCard` await gate while still racing or dropping the durable payload writes introduced by F13.

VERDICT: CHANGES_REQUESTED