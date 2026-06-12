# Adversarial Review: Impossible-State Cleanup Plan

Date: 2026-06-07

This document adversarially reviews the impossible-state cleanup metaplan (`docs/design/impossible-state-cleanup-plan/index.md`) and its seven wave documents, checked against the reconciled inventory (`docs/design/impossible-state-support-review.md`), the prior adversarial review (`docs/design/impossible-state-support-review-adversarial.md`), and the current source code.

## Line-Number Drift

### L01. Wave 1 Step 2 line reference is stale

Wave 1 references `src/runtime/state-machine.ts#L217-L230` for the invariant-observation patch loop. Current code has the patch at line 229 (`if (observation.correction) this.state.patch(...)`), inside `observeInvariants()` at lines 217-231. The range is close but not exact; the step says "L217-L230" but the actual patch line is 229 and the function extends to 231. This is cosmetic but can cause confusion during implementation.

**Severity:** low
**Recommendation:** Update to `L217-L231` or cite the function name `observeInvariants()` instead.

### L02. Wave 1 Step 3 line reference is stale

Wave 1 references `src/runtime/state-machine.ts#L221-L225` for the card status read catch. Current code at lines 223-224 is `try { currentCardStatus = this.cards.readStatus(currentCardId) ?? null; } catch { currentCardStatus = null; }`. The lines are 223-224, not 221-225.

**Severity:** low
**Recommendation:** Update to `L223-L224`.

### L03. Wave 1 Step 4 line reference is stale

Wave 1 references `src/runtime/state-machine.ts#L233-L239` for swallowed redispatch errors. Current code at lines 233-238 has `try { this.redispatch.redispatch(decision.cardId); } catch { void 0; }` at line 238. The range 233-239 is close but slightly off.

**Severity:** low
**Recommendation:** Update to `L233-L238`.

### L04. Wave 2 Step 3 line reference is stale

Wave 2 references `src/runtime/activation-unwind.ts#L70-L81` for the caller-edge synthesis. Current `findActivationCallerEdge()` runs from line 70 to line 82. The synthesized session id is at line 78: `const callerSessionId = parentSession?.id ?? 'planner:${parentCardId}'`. Minor off-by-one.

**Severity:** low
**Recommendation:** Update to `L70-L82`.

### L05. Wave 2 Step 4 line reference is stale

Wave 2 references `src/runtime/phases/reviewer-assessment-handler.ts#L72-L84` for the reviewer child completion fallback. Current code has the relevant block at lines 72-84 (the `else` branch with `appendChildUnwindToolResult` and `reviewer_finished` fallback). This one is correct.

**Severity:** none — included for completeness.

### L06. Wave 3 Step 2 line references are stale

Wave 3 references `src/runtime/terminal-commit/commit-planner.ts#L18-L63`, `commit-reviewer.ts#L21-L59`, `commit-executor.ts#L46-L124`. These were not independently verified in this review. They should be spot-checked before implementation.

**Severity:** low
**Recommendation:** Spot-check terminal-commit file line ranges before implementing Wave 3.

## Finding Coverage Gaps

### G01. C07 is not covered by any wave

The reconciled inventory lists C07 ("Reviewer pass proceeds when the goal card is missing") at `src/runtime/phases/reviewer-assessment-handler.ts:52-71`. Current code at line 60 reads `const latestGoalCard = input.effects.readCard(input.goalId)` and at line 61 only commits the pass if `latestGoalCard` is truthy, but still emits completion at line 86. This finding is not mentioned in any wave document.

**Severity:** high
**Recommendation:** Add C07 to Wave 2 or Wave 3. Wave 2 already covers reviewer ownership (C06, C08, C09, C13, C20) and is the natural home. Add a step: "throw if the reviewed goal card cannot be read before committing reviewer pass lifecycle."

### G02. C10 is covered in Wave 5 but should be in Wave 3 or earlier

C10 ("Malformed planner `activate_card` tool result falls through as ordinary result") is listed under Wave 5 (Agent Session and Protocol Strictness). However, `activate_card` is an internal tool result, not external model output. The inventory itself says: "A malformed result is an implementation invariant violation, not external model input." The metaplan's Rule D says external protocol failures must not be normalized, but C10 is not an external protocol failure. Placing it with P01/P02 (external protocol normalization) blurs the internal/external distinction that the adversarial review of the inventory fought hard to establish.

**Severity:** medium
**Recommendation:** Move C10 to Wave 3 alongside the other terminal/executor strictness changes, or create a separate step in Wave 1/2 for internal tool-result strictness. At minimum, Wave 5 Step 3 should explicitly acknowledge that `activate_card` is internal, not external.

### G03. C11 severity is misframed in Wave 5

C11 ("Agent loop reports unexpected internal state as cancellation") is in Wave 5 Step 4. The current code at `src/agents/agent-loop-driver.ts:191-192` shows `default: return { kind: 'cancelled', reason: 'abort' }`. The plan says to replace with an invariant throw, which is correct. However, Wave 5 groups this with session/protocol strictness (P01-P03, C17-C18). C11 is an internal state-machine bug, not a session or protocol issue. It could be addressed independently in Wave 1 or 2 since it has no dependency on Waves 3 or 4.

**Severity:** low — the fix direction is correct, just misplaced
**Recommendation:** Consider moving C11 to an earlier wave. If left in Wave 5, add a note that it is independent and could be implemented sooner.

## Architectural Issues

### A01. Wave 2 RuntimeDispatchOwnership shape is underspecified

Wave 2 introduces `RuntimeDispatchOwnership` as a discriminated union type (`activation` | `direct`), but does not specify:

1. Where exactly this is stored. The text says "Store this on the authoritative run record" and "copy the ownership from the open run into the active run", but does not specify the schema field name, whether it is a new field on `RuntimeRunRecord`, a new field on `ActiveCardRun`, or both.
2. How existing runtime runs get this field. If `runtime_runs` entries lack `ownership`, does startup reconstruction synthesize it? The plan says no synthesis (Rule B), but then how does the runtime handle pre-existing persisted runs that lack the field?
3. What happens during the transition period. There will be runs in `runtime_runs` created before Wave 2 that lack the `ownership` field. The plan does not address migration or startup repair for this.

**Severity:** high — this is the central data model change in the cleanup
**Recommendation:** Add a step to Wave 2 that specifies:
- The schema field name and location (e.g., `ownership: RuntimeDispatchOwnership` on `RuntimeRunRecord` and `ActiveCardRun`)
- Whether existing persisted runs without `ownership` fail startup or get a repair-time default
- A test for the migration boundary

### A02. Wave 2 Step 1 scope is too broad

"Remove Defensive Active-Run Defaults" targets `src/runtime/activation-reducer.ts#L18-L66` and lists required fields. At the time of the review, `activeRunFromActivationState()` was also called by legacy startup-repair and activation-unwind helpers. Those legacy helpers have since been removed with the obsolete runtime startup/activation repair path.

If any new repair path is introduced, it must produce valid active runs explicitly rather than relying on the removed legacy repair synthesis. The plan says "Only timestamps for newly opened runs may default to `nowIso`"; keep that as a normal-path invariant and do not recreate the removed startup-repair defaults.

**Severity:** high — removing defaults without providing repair alternatives will break startup
**Recommendation:** Keep `activeRunFromActivationState()` as the normal-path strict function. Do not add a repair variant unless a current actor-runtime recovery path has a concrete, explicit identity source.

### A03. Wave 2 Step 5 interacts with model retries but doesn't address the root cause

Step 5 says "more than one unresolved call: throw `RuntimeActivationInvariantError`" and "If model retries can produce duplicate activation calls, prevent that earlier in the agent loop by making duplicate activation intent a verifier/model-repair condition." This pushes the problem to a future change without specifying what that change looks like. Model retries that re-emit `activate_card` are a known model behavior. Throwing on duplicate unresolved calls during unwind will crash the runtime on a model retry that hasn't been resolved yet. The current code's "choose newest" approach is there precisely because model retries can produce duplicates in a single planner turn.

**Severity:** high — this step as written can crash the runtime in normal operation
**Recommendation:** Either:
- (a) Make the verifier prevent duplicate `activate_card` calls in the same turn before they reach the session log (the "prevent earlier" approach), and make Step 5 dependent on that verifier change, or
- (b) Keep the "choose newest" behavior but make it explicit and operator-visible: log a diagnostic, don't crash, and ensure the activation ledger records only one activation per child card.

Option (a) is consistent with the plan's goals but requires more design. Option (b) is safer but tolerates a known model behavior. The plan should choose one.

### A04. Wave 3 Step 1 proposes a helper but doesn't decide the core question

Wave 3 proposes `transitionCardStrict()` but then says "Prefer updating `RuntimeStateMachine.transitionCard()` itself to throw for impossible runtime transitions if no legitimate caller needs boolean results." This is the right question but the plan doesn't answer it. Currently `transitionCard()` returns `false` for:
1. Card not found (line 184-191)
2. Transition not accepted (line 200-209)

Are there legitimate callers that need the boolean? The plan doesn't audit callers. If there are operator-preview or diagnostic callers that legitimately need a non-throwing check, the plan needs to name them. If not, the simpler path is to make `transitionCard()` throw and delete the boolean variant.

**Severity:** medium
**Recommendation:** Audit all callers of `transitionCard()` and document whether any need the boolean result. Then make a clear decision: throw or keep two variants.

### A05. Wave 4 Step 3 adds assessment_id to reviewer session metadata but doesn't specify the schema

"add it to session metadata at reviewer session creation" is vague. The `AgentSession` schema currently has `goal_card_id` and `card_id` fields but no `assessment_id`. Where does this field go? Is it a new field on `AgentSession`? A metadata map? This needs specification.

**Severity:** medium
**Recommendation:** Specify the schema field name and location for `assessment_id` in `AgentSession`, or reference the schema change explicitly.

### A06. Wave 5 Step 9 surfaces handoff errors but doesn't specify the operator-visible format

The plan says "return an explicit operator-visible error state or emit a diagnostic event" for handoff read failures. The current code at `src/agents/agent-session-coordinator.ts:92` returns `null` on catch. The plan doesn't specify what the operator-visible format looks like. Is it a special `HandoffSummary` with an error field? A thrown error that the HTTP route catches? A diagnostic event that goes to the event log only?

**Severity:** medium
**Recommendation:** Specify the error representation. The simplest option: throw from `getHandoffSummary()` and let the HTTP route handler catch and return a 500 with the error class name. This is consistent with fail-fast. If a degraded handoff is still needed for read-model queries, return a `HandoffSummary` with an error field and let the consumer decide.

## Dependency Chain Issues

### D01. Wave 4 depends on Wave 2 but the dependency is weak

The metaplan says "Wave 4 can run after Wave 2 because activation/session identity must be explicit before compatibility lookup and overload removal is safe." But Wave 4 targets are `agent-adapter.ts` string overloads and `session-persistence.ts` scan fallback. These don't depend on `RuntimeDispatchOwnership` from Wave 2. They depend on the principle that identity must be explicit (Rule B), which is already stated in the metaplan. The string overloads could be deleted independently of the ownership model change.

**Severity:** low — the ordering is conservative, not wrong
**Recommendation:** Mark Wave 4 as "can run after Wave 1" instead of "after Wave 2". The only real dependency is that after Wave 1 removes tick repair, callers that relied on repair to survive missing identity will crash. That is the desired behavior.

### D02. Wave 6 should explicitly depend on Wave 2 ownership model

The metaplan says "Wave 6 should run after Waves 1-3." But Wave 6 Step 3 targets `runtime-core.ts#L542-L597` startup reconciliation, which currently closes all open running runs when idle. After Wave 2 introduces `RuntimeDispatchOwnership`, the reconciliation logic needs to know the ownership of each open run to decide whether it can be safely closed. Without ownership metadata, reconciliation cannot distinguish root runs from child runs that might have activation parents.

**Severity:** medium
**Recommendation:** Add Wave 2 as an explicit dependency for Wave 6 Step 3. Specify that startup reconciliation after Wave 2 must use ownership metadata to decide run closure.

## Missing Implementation Details

### M01. Wave 1 Step 5 doesn't specify `parseReviewerStartedActiveRun`

The plan says "The parser must throw if `activeCardRun` is missing or malformed" but doesn't specify what this parser looks like. The current code at `src/runtime/runtime-core.ts:347` simply casts: `(payload.activeCardRun ?? null) as RuntimeState['active_card_run']`. The plan needs to specify whether `parseReviewerStartedActiveRun()` is a new function or a schema validation, and what "malformed" means (missing field? wrong type? semantically invalid?).

**Severity:** medium
**Recommendation:** Specify that `parseReviewerStartedActiveRun()` validates the payload shape against the `ActiveCardRun` schema and throws `RuntimeStateInvariantError` on validation failure. Reference the schema type.

### M02. Wave 3 Step 4 doesn't specify what "synthesize unwind outcome from card lifecycle/status" means for startup repair

The plan says "if the card is terminal, synthesize unwind outcome from card lifecycle/status". The old `executeStartupActiveRunRepairDecision()` implementation that motivated this note has since been removed with the obsolete runtime startup repair path. Any future actor-runtime recovery design should specify a current code path rather than reviving startup unwind synthesis.

**Severity:** medium
**Recommendation:** Specify the actor-runtime recovery behavior directly if terminal executor cards need recovery. Do not reintroduce the removed `appendChildUnwindToolResult` startup path.

### M03. Wave 5 Step 7 splits pruning APIs but doesn't specify the diagnostic/assertion API shape

"Use assertion/diagnostic for analyst full history before model input" is vague. What does the assertion function return? Does it throw? Does it return a list of orphan pairs? Does it log and continue? The current `pruneToolBoundary()` silently removes orphans. The plan says to split it, but the strict variant needs a specified behavior.

**Severity:** medium
**Recommendation:** Specify `assertToolBoundaryIntegrity()` to return either `{ valid: true }` or `{ valid: false; orphans: Array<{call: AgentMessage; results: AgentMessage[]}> }`, and let the analyst handler decide whether to throw, log, or strip. The plan says "strict validator" — define what strict means.

### M04. Wave 7 Step 2 audit is underspecified

"Audit all reducers/transitions that set `status: 'idle'`" is a research step, not an implementation step. The plan should list the known reducers/transitions that set idle, or at minimum specify the audit method. Currently known idle transitions:
- `reduceRuntimeEvent`: `goal_exit`, `card_terminated`, `goal_completed`, `reviewer_finished` (`src/runtime/runtime-core.ts:342-351`)
- `buildShutdownRuntimeStatePatch()` in `runtime-core.ts` if still present after old shutdown composition removal
- `planClearActiveCardRunForRepair()` (`src/runtime/runtime-core.ts:224-235`)
- `planSweptCurrentAgentSessionPatch()` (`src/runtime/runtime-core.ts:237-245`)
- `planIdleRunningRootRunReconciliation()` state patches (`src/runtime/runtime-core.ts:542-597`)
- The old `buildBlockedPlannerStartupState()` startup-repair path was removed with obsolete startup repair.

**Severity:** medium
**Recommendation:** Pre-populate Step 2 with the known idle-transition sites above. The audit then verifies this list is complete rather than starting from scratch.

## Cross-Wave Consistency

### X01. Rule B (No Synthesized Identity) conflicts with startup-repair needs in multiple waves

Rule B says "Do not synthesize `planner:${cardId}`, caller tool ids, empty goal/card ids, or placeholder assessment ids." But startup repair in Wave 6 and the `buildChildRunStartupState`/`buildResumePlannerStartupState`/`buildReviewerInterruptedStartupState` functions all synthesize `plannerSessionId` as `planner:${cardId}`. The metaplan's Rule A says repair functions can exist in startup modules, but Rule B is absolute. These rules need to be reconciled: either Rule B has a startup-repair exception, or Wave 6 must replace all `planner:${cardId}` synthesis with explicit lookups.

**Severity:** high — this affects Waves 2, 4, and 6
**Recommendation:** Amend Rule B to: "Do not synthesize identity in normal runtime paths. Startup repair may reconstruct identity from persisted state using explicitly named repair helpers that document what they reconstruct and why." Then audit all `planner:${cardId}` occurrences and move them into named repair helpers.

### X02. Wave 5 and Rule D conflict on external vs internal tool results

Rule D says "Malformed model/provider output is external input" and Wave 5 Step 2 and Step 6 treat assistant/analyst tool args as external protocol failures. But Step 3 says internal `activate_card` tool results should throw. The distinction is correct, but the wave document doesn't draw a clear boundary. What about other internal tool results? Are there other internal tools whose malformed results should throw rather than become protocol errors?

**Severity:** low
**Recommendation:** Add a note to Wave 5 that explicitly lists which tools are internal (throw on malformed) vs external (protocol error on malformed). Currently only `activate_card` is identified as internal. If there are others (e.g., `report_goal_done` when produced by planner tool execution), they should be listed.

### X03. `findParentPlannerRunForResumption()` in runtime-core.ts still synthesizes after Wave 2

The current `findParentPlannerRunForResumption()` at `src/runtime/runtime-core.ts:736-767` constructs an `active_card_run` with synthesized fields: `caller_session_id: null`, `caller_tool_call_id: null`, and `planner_session_id: parentRunId ? plannerSessionId : null` where `plannerSessionId` can fall back to `planner:${parentCardId}` (line 754). This is in the normal `reduceActivationCompletion()` path, not startup repair. Wave 2 Step 1 removes defaults from `activeRunFromActivationState()` but doesn't address `findParentPlannerRunForResumption()`, which constructs active runs directly.

**Severity:** high — this is a synthesis path that Wave 2 misses
**Recommendation:** Add a step to Wave 2: "Make `findParentPlannerRunForResumption()` use `RuntimeDispatchOwnership` instead of synthesizing caller/planner session ids." The returned active run should copy identity from the activation record, not default or synthesize.

## Test Coverage Gaps

### T01. Wave 1 tests don't cover the tick-error-propagation scheduler boundary

Wave 1 Step 4 says "if throwing from tick creates unhandled scheduler scheduler promises, fix the scheduler boundary to record and surface errors." But the test list for Wave 1 says "redispatch failure propagates" — this tests the happy path of propagation, not the scheduler boundary handling an unhandled promise rejection. The scheduler uses `void this.tick()` at line 143, which means a thrown tick will create an unhandled promise rejection.

**Severity:** medium — this is a real production risk
**Recommendation:** Add a test: "tick with throwing redispatch does not create unhandled promise rejection; scheduler records the error." Also consider changing `void this.tick()` to `void this.tick().catch(...)` or using `process.on('unhandledRejection')` in the scheduler.

### T02. Wave 2 tests don't cover startup repair after ownership introduction

Wave 2 test list includes "startup repair, if still using old reconstruction, must use a repair-only helper." But there is no test for: "persisted runtime state with runs that lack `ownership` field fails startup or gets repair-time default." This is the migration boundary test called out in A01.

**Severity:** medium
**Recommendation:** Add: "runtime state with pre-Wave-2 runs (no ownership field) either fails startup or gets reconstructed with explicit repair ownership."

### T03. Wave 7 tests don't cover the transition period

Wave 7 makes idle + any non-null active run invalid. But there will be persisted runtime state from before Wave 7 that has idle + terminal active run. The plan says "Do not preserve old behavior for existing bad persisted state; fail and reset/repair explicitly." But there is no test for: "persisted idle runtime with terminal active_card_run fails startup or gets cleared by startup repair."

**Severity:** medium
**Recommendation:** Add: "startup with persisted idle+terminal active_card_run clears the active run or fails startup."

## Risk Assessment Gaps

### R01. No rollback strategy for any wave

Each wave makes strictness changes that can surface previously-masked bugs in production. The GetRich v2 deployment runs autonomously. If Wave 1 makes the tick loop throw on state invariants that were previously self-healing, the runtime may crash-loop on state that was previously survivable. The plan says "fail and reset/repair explicitly" but doesn't specify:
1. What the operator should do when the runtime crashes on an invariant
2. Whether the runtime should auto-restart after an invariant crash
3. Whether there is a diagnostic mode that logs-but-doesn't-throw for the first N ticks after a wave deployment

**Severity:** high — this affects production stability
**Recommendation:** Add a risk-mitigation section to the metaplan:
- After each wave, deploy with a temporary `SAIVAGE_STRICT_INVARIANT_LOG_ONLY=true` env flag that logs but doesn't throw for the first 24 hours
- After 24 hours with no logged invariants, remove the flag
- Or: add a per-invariant kill switch that the operator can use to downgrade a throw to a log

### R02. Wave 1 + Wave 7 compound risk for the GetRich v2 deployment

Wave 1 removes tick self-healing. Wave 7 makes idle+terminal-active-run invalid. Together, these mean that any code path that sets idle with a non-null active run (even briefly, between two ticks) will crash the runtime. Currently, the tick loop would self-heal this transient state. After both waves, transient state becomes a hard crash. The plan doesn't quantify how many code paths set idle + non-null active run, or how likely transient violations are.

**Severity:** high
**Recommendation:** Audit all idle-transition paths (see M04) before implementing Wave 7. For each, verify that `active_card_run` is set to null atomically with the idle status change. If any path sets idle first and clears active run later (in a separate mutation), that path will crash after Wave 7.

## Omissions From the Original Inventory

### O01. `planSweptCurrentAgentSessionPatch()` is not covered

`src/runtime/runtime-core.ts:237-245` sets `{ active_card_run: null, status: 'idle' }` when the current session is swept. This is a legitimate shutdown path, but it constructs an idle state with no active run during a mutation. If any intermediate state exists between the mutation and the next tick, Wave 7's invariant could fire. The plan doesn't mention this function.

**Severity:** low — this path is correct, but should be verified
**Recommendation:** Add `planSweptCurrentAgentSessionPatch()` to the Wave 7 Step 2 audit list.

### O02. `buildResumeFromFreezeRuntimeStatePatch()` is not covered

`src/runtime/runtime-core.ts:202-210` sets `active_card_run: manifest.active_card_run ?? null` and `status: manifest.active_card_run ? 'running' : 'idle'`. If the manifest has a terminal active run, this produces idle+non-null-active-run, which Wave 7 would reject. The plan doesn't address freeze/resume.

**Severity:** medium
**Recommendation:** Add a step to Wave 7: "Ensure `buildResumeFromFreezeRuntimeStatePatch()` clears terminal active runs or converts them to running state." Or add a freeze manifest validation that rejects manifests with terminal active runs.

### O03. `planIdleRunningRootRunReconciliation()` is not covered by Wave 7

The startup reconciliation at `src/runtime/runtime-core.ts:542-597` produces state patches with `status: 'idle'` and `active_card_run: null`. This is correct, but the function's early-return conditions (line 551-557) mean it can return `null` when the runtime is idle with a non-null active run, leaving the invalid state unpatched. This is a Wave 6 target (R03) but the interaction with Wave 7 is not noted.

**Severity:** low
**Recommendation:** Cross-reference R03 and Wave 7 Step 3 in the metaplan.

## Summary

The cleanup plan is directionally sound and correctly identifies the root architectural problem (live tick repair). The wave decomposition and dependency ordering are reasonable. The most significant issues are:

1. **G01 (high):** C07 is not covered by any wave.
2. **A01 (high):** `RuntimeDispatchOwnership` storage and migration are underspecified.
3. **A02 (high):** Removing active-run defaults without repair alternatives will break startup.
4. **A03 (high):** Duplicate activation rejection can crash the runtime on model retries.
5. **X01 (high):** Rule B conflicts with startup-repair needs across multiple waves.
6. **X03 (high):** `findParentPlannerRunForResumption()` is a synthesis path that Wave 2 misses.
7. **R01 (high):** No rollback or diagnostic-mode strategy for production deployments.
8. **R02 (high):** Wave 1 + Wave 7 compound crash risk for transient state.

Recommendation: address the high-severity items before beginning Wave 1 implementation. The line-number drift items (L01-L06) should be fixed as a quick pass. G01, A01, A02, A03, X01, X03, R01, and R02 need design amendments to the affected wave documents.
