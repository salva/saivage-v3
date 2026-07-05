# Resume-or-Start LLM Design

Status: second-review design proposal.

Date: 2026-07-05

## Second-review verdict

Keep the fix narrow. The duplicated code is an LLM lifecycle seam, not evidence that planner, reviewer, and executor should share a larger turn-driving harness.

The clean architecture is:

- `BaseMainLLMCardProcessorActor` owns LLM actor lifecycle mechanics.
- Concrete processor actors own role-specific record slots, invocation surfaces, terminal contracts, and repair-loop policy.

Hoisting `resumeOrStartLlm` follows that boundary. Expanding the change into a generic `driveMainLlm` helper would cross it.

This is intentionally not the easy-first choice. The larger consolidation was reconsidered and rejected because it would make the base class know too much about role behavior. The brave/simple choice is to keep the role loops explicit until their real duplication is removed by targeted designs such as the role invocation-surface factory and analyst repair-loop unification.

## Problem

`resumeOrStartLlm` is defined byte-for-byte identically in both processor actors:

- `src/runtime/actors/planning-card-processor-actor.ts` (planner + reviewer paths).
- `src/runtime/actors/terminal-card-processor-actor.ts` (executor path).

Each copy is three lines that decide how to obtain the first `LLMActorOutcome` from a possibly-recovered `LLMActor`:

```ts
if (llm.state() === 'calling_provider') return llm.awaitPendingTurn();
if (llm.state() === 'waiting_tool') return Promise.resolve(llm.waitingToolOutcome());
return llm.turn(input, signal);
```

Each copy also carries an identical inline structural type for the `llm` parameter:

```ts
{ state(): string; turn(input: LlmInvocationInput, signal?: AbortSignal): Promise<LLMActorOutcome>; awaitPendingTurn(): Promise<LLMActorOutcome>; waitingToolOutcome(): Extract<LLMActorOutcome, { type: 'tool_call' }> }
```

That structural type exists only because the method was `private`. It duplicates the public surface of `LLMActor` and has no independent meaning.

The shared base `BaseMainLLMCardProcessorActor` already owns every other LLM lifecycle concern: `createMainLlm`, `adoptRecoveredLlmActor`, `replayWaitingToolCall`, `listLlmActors`, and `onActivationSettled` (which clears active LLM actors). `resumeOrStartLlm` is the one missing tenant.

## Decision

Hoist `resumeOrStartLlm` to `BaseMainLLMCardProcessorActor` as a `protected` method with the concrete `LLMActor` parameter type. Delete both private copies and their inline structural type.

```ts
protected resumeOrStartLlm(llm: LLMActor, input: LlmInvocationInput, signal: AbortSignal): Promise<LLMActorOutcome> {
  if (llm.state() === 'calling_provider') return llm.awaitPendingTurn();
  if (llm.state() === 'waiting_tool') return Promise.resolve(llm.waitingToolOutcome());
  return llm.turn(input, signal);
}
```

The base class already imports `LLMActor`. Adding `LLMActorOutcome` (from `./llm-actor.js`) and `LlmInvocationInput` (from `./llm-invocation.js`) to the base's imports widens the surface by zero — both types are already transitively required.

All three call sites already use `this.resumeOrStartLlm(...)`, so they require no changes.

### Why the structural type disappears

The structural type was a workaround for keeping the method `private` while accepting any duck-typed object with the same four methods. On the base class the method is `protected` and the base already works with concrete `LLMActor` instances (`createMainLlm(): LLMActor`, `activeLlmActors: Map<string, LLMActor>`, `adoptRecoveredLlmActor(llm: LLMActor)`). There is no reason to accept a structural subset; the concrete type is stricter, clearer, and already in scope.

## What this design deliberately does not do

### No `driveMainLlm` consolidation (Proposal B)

Both processors follow the pattern `createMainLlm → resumeOrStartLlm → runContractBoundedRepairLoop`. It is tempting to consolidate all three into a single `driveMainLlm(agentId, inputBuilder, signal, handlers)` on the base.

This is rejected as over-engineering. The repair-loop handler shapes diverge significantly across roles:

- **Planner**: completion-gate validation, notification-currentness check, reviewer rework sub-loop, record-slot enforcement for `status.md`.
- **Reviewer**: stale-currentness relaunch with budget, record-slot enforcement for `review.md`, abandonment on rework.
- **Executor**: process ownership tracking, invocation-surface cleanup in `finally`, record-slot enforcement for `status.md`.

A generic harness over these three handler shapes would require either a large callback surface (re-introducing the parallel structure it removes) or role-specific branching inside the base (coupling the base to every role's contract). Neither is simpler than the current shape where each processor owns its own repair loop and shares only the resume-or-start decision.

### No consolidation of the `discardOpenRecordSlot` fresh-activation check

Both processors also duplicate a `if (llm.state() === 'idle') discardOpenRecordSlot(...)` check before calling `resumeOrStartLlm`. This looks similar but differs per role:

- Planner: `filename: 'status.md'`, `reason: 'new_activation'`.
- Reviewer (inside planner): `filename: 'review.md'`, `reason: 'new_reviewer_activation'`.
- Executor: `filename: 'status.md'`, `reason: 'new_activation'`.

The filename and reason are role/record-specific. Forcing them into a base-level parameter would add plumbing without removing meaningful duplication. They stay at the call site.

### No freshness wrapper return value

Another possible abstraction is to make the base return `{ llm, outcome, startedFresh }`, so callers can avoid checking `llm.state() === 'idle'` before discarding stale record slots.

That is also rejected. Callers need the `LLMActor` directly for subsequent `appendToolResult`, `continueAfterPlainText`, and abandonment calls, and record-slot cleanup remains role-specific. Returning a small object would add ceremony around the same two facts instead of simplifying them.

### No compatibility or adapter surface

The implementation should delete both private methods outright. Do not keep a deprecated private wrapper in either processor, and do not introduce a structural interface solely for tests. Subclasses use the current protected base method directly.

### No new test

`resumeOrStartLlm` is a three-line branch over `LLMActor` states. Its three branches are already exercised by the existing processor and recovery test suites:

- `calling_provider` resume: covered by actor-recovery tests that reconstruct an in-flight provider call.
- `waiting_tool` resume: covered by actor-recovery tests that reconstruct a persisted tool-call wait.
- Fresh `turn`: covered by every non-recovery processor test.

Adding a dedicated base-level unit test would test the micro-actor framework's state machine, not our logic. Existing coverage suffices.

## Implementation

1. Add `LLMActorOutcome` and `LlmInvocationInput` imports to `base-main-llm-card-processor-actor.ts`.
2. Add `protected resumeOrStartLlm(llm: LLMActor, input: LlmInvocationInput, signal: AbortSignal): Promise<LLMActorOutcome>` to `BaseMainLLMCardProcessorActor`.
3. Delete the private `resumeOrStartLlm` from `planning-card-processor-actor.ts` (including its inline structural type).
4. Delete the private `resumeOrStartLlm` from `terminal-card-processor-actor.ts` (including its inline structural type).
5. Call sites are unchanged (`this.resumeOrStartLlm(...)` resolves to the inherited protected method).

## Validation

- `npm run typecheck`
- `jest tests/runtime/actors/planning-card-processor-actor.test.ts tests/runtime/actors/terminal-card-processor-actor.test.ts tests/runtime/actors/actor-recovery.test.ts`
- `npm run validate:routine`
- `npm test`
- `npm run build`
