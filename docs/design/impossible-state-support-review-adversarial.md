# Adversarial Review: Impossible-State Support Inventory

Date: 2026-06-07

This document reviews `docs/design/impossible-state-support-review.md` against the project's stated principles: simple/clean architecture, no backward compatibility, fail fast for impossible states, no over-defensive code, brave deep refactoring.

## False Positives: Findings That Should Be Removed

### F01. Reentrancy guard is not impossible-state support

The `_tickInFlight` guard at `src/runtime/state-machine.ts:157` is a standard sequential-runtime reentrancy guard. In single-threaded JavaScript, if `tick()` is called while already executing, that means code inside `tick()` triggered another `tick()`. The guard prevents infinite recursion.

This is not "defensive code for impossible internal states." It is a legitimate concurrency/reentrancy guard for a sequential runtime. The review confuses two different concepts:
- Defensive code that silently recovers from impossible states (bad)
- Reentrancy guard that prevents recursive entry (good)

**Recommendation:** Remove F01. The guard should stay.

### F17. Tool boundary pruning is legitimate post-compaction cleanup

`pruneToolBoundary()` at `src/agents/context-compactor.ts:71-99` is called in two contexts:
1. After compaction truncation, where orphan tool calls/results are expected
2. In the analyst handler before sending to the model, where session boundaries may leave orphans

In both cases, orphan tool boundaries are expected artifacts of truncation or session boundaries, not transcript corruption. The review misidentifies the purpose of this function.

**Recommendation:** Remove F17. The pruning is legitimate.

### F25. Runtime state invariant is strict, not permissive

The review claims `src/runtime/state.ts:55-80` "permits `status: 'idle'` with a non-null `active_card_run` when the run status is terminal." This is a misreading.

The code at line 76-81:
```typescript
function assertRuntimeStateInvariants(state: RuntimeState): RuntimeState {
  if (state.status !== 'idle' || activeRunIsIdleTerminal(state.active_card_run)) {
    return state;
  }
  throw new RuntimeStateInvariantError(describeInvariantViolation(state));
}
```

This **throws** when `status === 'idle'` and `active_card_run` has a non-terminal status. Terminal runs (stopped/cancelled) are allowed to linger briefly during state transitions, which is correct behavior. The invariant is strict, not permissive.

**Recommendation:** Remove F25. The invariant is correct.

## Findings That Miss the Real Issue

### F02. The function is fine; callers are the problem

`transitionCard()` returns `false` when the card is missing. The review says this should fail loudly, but the function behavior is reasonable: it logs the error and returns a boolean. The real issue is callers that ignore the return value and continue.

**Recommendation:** Reframe F02 to focus on callers that ignore the `false` return, not the function itself.

### F07. Reducer is correct; mutation layer should propagate failure

`reduceActivationCompletion(...)` returns `null` when there is no matching activation. This is correct reducer behavior: "no change" is represented as `null`. The issue is that `applyRuntimeMutation` at `src/runtime/mutations.ts:89-99` uses `?? current`, turning the null signal into a silent no-op.

**Recommendation:** Reframe F07 to target the mutation layer, not the reducer. The mutation should throw or return an error when the reducer signals "no matching activation."

### F10. Function returns boolean; callers must handle it

`completeChildActivationForParent()` returns `false` when no caller edge exists. This is a valid pattern: the function signals failure, and callers decide what to do. The issue is that some callers, such as `src/runtime/phases/reviewer-assessment-handler.ts` around the reviewer-pass unwind branch, fall back to global `reviewer_finished` instead of failing.

**Recommendation:** Reframe F10 to target the callers that mishandle `false`, not the function itself.

### F22. Architectural issue, not defensive code

`SessionMessageLog` owns fallback round stamps because the invocation runner doesn't have access to the session stamper. This is an architectural issue: message ordering should be owned by a single stamper/lifecycle. The fix is to thread the stamper through the invocation runner, not to remove the fallback.

**Recommendation:** Reframe F22 as an architectural refactoring: make `SessionMessageLog` take a stamper dependency.

## Findings That Conflate External Input with Internal State

### F12/F16. Model output is external input, not internal state

These findings flag tool-call argument parse failures that convert malformed JSON to `{}`. The review applies the fail-fast principle, but fail-fast applies to **internal state**, not **external input**.

Model/provider output is external input. When the model sends invalid JSON, we have two choices:
1. Fail the entire invocation (abort the agent's work)
2. Continue with empty args (let the tool handle it)

The review doesn't acknowledge this distinction. For external input, graceful degradation may be appropriate. The decision depends on product requirements, not architectural principles.

**Recommendation:** Reframe F12/F16 as product decisions, not architectural violations. Alternatively, if the decision is to fail fast on malformed model output, make that explicit.

### F18. Model retries are external behavior

The code comment at `src/runtime/session-persistence.ts:428-432` explicitly says duplicate `activate_card` calls handle model retries. Model retries are external behavior, not internal state corruption.

**Recommendation:** Reframe F18 as a product decision about how to handle model retries, not an invariant violation.

## Missing Findings

### M01. Activation reducer has extensive defensive defaulting

`activeRunFromActivationState()` at `src/runtime/activation-reducer.ts:18-66` has extensive `??` defaulting:
- `card_type` defaults to `'goal'` or `'code'`
- `runtime_status` defaults to `'running'`
- `caller_session_id` defaults to `null` or synthesized `planner:${goalId}`
- `planner_session_id` defaults to synthesized `planner:${goalId}`
- `correction_attempts` defaults to `0`
- `started_at` and `last_turn_at` default to `nowIso`

This is exactly the kind of defensive defaulting the review should flag. In normal operation, these fields should be explicit from the card/ledger/session edge. Broad defaulting hides missing activation metadata.

**Severity:** High
**Recommendation:** Add M01 to the inventory.

### M02. Executor completion handler falls back to stale card

`handleExecutorCompletion()` at `src/runtime/phases/executor-completion-handler.ts:34`:
```typescript
const latestCard = input.effects.readCard(input.cardId) ?? input.card;
```

If the latest card read returns `null`, the code falls back to the originally-passed card. After execution, the card should still exist and be readable. A missing card is an invariant violation. Falling back to a stale snapshot can commit terminal results against obsolete state.

**Severity:** High
**Recommendation:** Add M02 to the inventory.

### M03. F09 is outdated; fallback was added intentionally

F09 flags the `reviewer_finished` fallback at `src/runtime/phases/reviewer-assessment-handler.ts:78-84`. However, this fallback was added intentionally in commit `cd7fbff6` ("fix(runtime): idle direct reviewer completions without activation edge") to handle direct dispatch without an activation edge.

The review doesn't acknowledge that this was a deliberate recent change. Either the commit was wrong, or the finding is outdated.

**Recommendation:** Re-evaluate F09 in light of the intentional commit. If the fallback is still considered wrong, the commit should be reverted.

## Severity Rating Errors

### F03 should be critical, not high

Live invariant correction during ticks is the single biggest architectural issue in the inventory. It masks all other state-machine bugs by silently repairing impossible state on every tick. This should be **critical** severity, not high.

### F20 should be high, not medium

Backward-compatibility overloads with empty strings (`parentSessionId: ''`, `goalId: ''`, `assessmentId: ''`) are exactly what the project wants removed. These are not "medium" issues; they are explicit backward-compatibility code that should be deleted.

### F11 should be high, not medium

Synthesized session ids (`planner:${parentCardId}`) are a compatibility fallback for old sessions. If planner identity is now deterministic, this fallback should be removed. This is not "medium"; it is explicit backward-compatibility code.

### F14 should be high, not medium

Reporting unexpected internal state as cancellation hides state-machine corruption behind an operator/provider-like outcome. This is not "medium"; it is a critical observability issue.

## Architectural Blind Spots

### B01. F03 is the root cause of many other findings

F03 (live invariant correction) is the root cause of many other findings. If invariant correction is removed, the state machine will be forced to produce correct state, and many other findings become moot:
- F01 (reentrancy guard) becomes unnecessary if ticks don't repair state
- F04 (catch and null) becomes unnecessary if invariant checking doesn't need to be defensive
- F06 (null active run) becomes unnecessary if the state machine produces correct state
- F25 (terminal active runs) becomes unnecessary if the invariant is strict

The review doesn't acknowledge that F03 is the root cause and should be addressed first.

**Recommendation:** Reorder the suggested review order to put F03 first, not in the second batch.

### B02. Review doesn't specify fix direction

Many findings say "should fail fast" but don't specify how. For example:
- F04 says "should fail fast" but doesn't say whether to throw, propagate the error, or log and abort
- F07 says "should fail fast" but doesn't say whether the mutation should throw or return an error
- F10 says "should fail fast" but doesn't say whether the caller should throw or propagate

The review should specify the fix direction for each finding, not just say "fail fast."

### B03. Review doesn't address SessionMessageLog architecture

F22 identifies the fallback stamps but doesn't address the architectural issue: `SessionMessageLog` exists because the invocation runner doesn't have access to the session stamper. The fix is to thread the stamper through, which is a significant refactoring. The review should acknowledge this.

### B04. Review doesn't distinguish between "remove" and "refactor"

Some findings should result in code removal (backward-compatibility overloads, synthesized session ids). Others should result in refactoring (thread stamper through, make mutation layer propagate failures). The review doesn't distinguish between these two outcomes.

## Suggested Corrected Review Order

Based on the adversarial review, the corrected order should be:

1. **F03 (critical)**: Remove live invariant correction. This is the root cause.
2. **M01 (high)**: Remove activation-reducer defensive defaulting.
3. **M02 (high)**: Remove executor-completion stale-card fallback.
4. **F04, F05, F06 (high)**: Make state-machine error handling fail fast.
5. **F07, F08 (high)**: Make mutation layer and reviewer handler fail fast.
6. **F13, F15 (high)**: Make contract verifier fail fast on malformed input.
7. **F20, F11 (high)**: Remove backward-compatibility overloads and synthesized ids.
8. **F14 (high)**: Make agent loop fail fast on unexpected state.
9. **F21 (high)**: Make reinvocation fail fast on missing metadata.
10. **F02, F09, F10 (reframe)**: Focus on callers, not functions.
11. **F19 (medium)**: Remove planner session scan fallback.
12. **F22 (refactor)**: Thread stamper through invocation runner.
13. **F23, F24 (medium)**: Improve error handling and metadata clearing.
14. **R01, R02, R03 (high)**: Narrow startup repair paths.
15. **F12, F16, F18 (product decision)**: Decide on external input handling.

## Summary

The original inventory has three false positives (F01, F17, F25), several findings that miss the real issue (F02, F07, F10, F22), findings that conflate external input with internal state (F12, F16, F18), and two significant missing findings (M01, M02). Severity ratings are inconsistent, and the review doesn't acknowledge that F03 is the root cause of many other issues.

The corrected inventory should remove three findings, reframe four findings, add two findings, and reorder the review order to address F03 first.
