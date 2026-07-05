# Slave Base Actor Design

Status: design proposal.

Date: 2026-07-05

## 1. Purpose

The frozen `BaseActor` is a fire-and-forget state machine. Transitions return `void`, and async work scheduled through `runTask` returns `void`; the task result is delivered to `on_done` / `on_failed` callbacks registered by the subclass. There is no built-in framework channel that hands an async result back to the caller that triggered the transition.

That is a good framework constraint. `BaseActor` owns state transitions and per-state task abortion; it should not become a promise-returning workflow engine.

The problem is above the framework: every actor that accepts one unit of work and reports an outcome has built its own pending-result slot:

- `ConversationLLMActor.#pendingTurn`
- `BaseCardProcessorActor.#pending`
- `CardActor.#pendingActivation`
- `AnalystSessionActor.pendingTurn`

Those slots differ in construction, re-entrancy policy, cancellation handling, and recovery behavior. `BaseCardProcessorActor.activate` even has a nested double-promise solely to expose the current in-flight promise. This document specifies a thin `SlaveBaseActor` helper that removes those parallel structures without changing the frozen core.

## 2. Design Correction From The Old Slave Actor

The removed `SlaveActor` / `SimpleSlaveActor` had the right idea but the wrong shape. It owned a queue, job ids, queued/current cancellation, and a baked-in `waiting → running` worker loop. None of the production actors matched that loop:

- LLM turns move through `idle → calling_provider → waiting_tool → calling_provider ...`.
- Processor activations move through `idle|settled → planning|executing → settled`.
- Analyst turns move through `idle → conversing → idle`.

So the regenerated helper must be smaller. It must not own a queue, a state machine, a job id, or a `runJob` contract.

It owns exactly one concept: **the current work slot**.

## 3. Work Slot, Not State Machine

`SlaveBaseActor` stores one in-flight work unit:

```ts
type WorkSlot<Work, Outcome> = {
  work: Work;
  signal: AbortSignal;
  promise: Promise<Outcome>;
  resolve: (outcome: Outcome) => void;
  reject: (error: Error) => void;
};
```

The slot is the callback object the earlier discussion identified. It is internal, not part of the public API. Public actor methods keep domain names and return promises (`turn`, `appendToolResult`, `activate`, `submit`). Internally those methods call `beginWork(...)`, which creates the slot and returns its promise.

This keeps the architecture simple:

- No new external callback API.
- No bridge/adapter layer.
- No queue.
- No generic worker loop.
- No second public way to invoke the actor.

The domain method still owns the state precondition. The base only guards that no work slot is already active.

Examples:

- `ConversationLLMActor.turn(...)` checks `state() === 'idle'`, then calls `beginWork(...)`, then sends `turn`.
- `ConversationLLMActor.appendToolResult(...)` checks `state() === 'waiting_tool'`, then calls `beginWork(...)`, then sends `turn`.
- `BaseCardProcessorActor.activate(...)` checks `state() === 'idle' || state() === 'settled'`, then calls `beginWork(...)`, then sends `activate`.

This distinction matters: the accepting state is not always literally named `idle`. `waiting_tool` and `settled` are valid parked accepting states for specific methods. Therefore the base must not enforce `state() === 'idle'`; it enforces only "one active work slot."

## 4. API

Location: `src/runtime/micro-actor/slave-base-actor.ts`, exported from `src/runtime/micro-actor/index.ts`. The frozen `src/runtime/micro-actor/micro-actor.ts` is unchanged.

```ts
export abstract class SlaveBaseActor<Work, Outcome> extends BaseActor {
  protected hasWork(): boolean;
  protected beginWork(work: Work, signal: AbortSignal): Promise<Outcome>;
  protected restoreWork(work: Work, signal: AbortSignal): Promise<Outcome>;
  protected pendingWork(): Promise<Outcome>;
  protected requireWork(): { work: Work; signal: AbortSignal };
  protected workSignal(): AbortSignal | null;
  protected resolveWork(outcome: Outcome): void;
  protected rejectWork(error: Error): void;
  protected clearWork(): void;
}
```

Contract:

- `beginWork(work, signal)` creates the slot and returns the slot promise. It throws if a slot already exists. It does not send an event; the domain method sends the event after the slot exists.
- `restoreWork(work, signal)` creates the slot without sending an event and returns its promise. It is for recovery paths that call `recover(state)` directly.
- `pendingWork()` returns the current slot promise. It throws if there is no slot. It is used for recovered or already-active work (`awaitPendingTurn`, processor re-entrancy).
- `requireWork()` returns `{ work, signal }`. It throws if there is no slot. Active-state enter hooks use this to seed their `runTask`.
- `workSignal()` returns the current slot signal or `null`.
- `resolveWork(outcome)` / `rejectWork(error)` settle the slot promise and clear the slot. They throw if no slot exists. Double settlement is a bug, not a tolerated case.
- `clearWork()` intentionally discards an already-resolved parked slot after the public caller has received the outcome and no continuation is expected. This is only for explicit abandonment paths such as `LLMActor.abandonParkedTurn`; normal success/failure must use `resolveWork` / `rejectWork`.

The base is deliberately small. There is no `onWorkSubmitted` hook: that would be another indirection. The domain method creates the slot and sends the event in the same function.

## 5. Why Double Settlement Throws

The first draft used no-op double settlement as a generic race guard. That is too defensive and hides impossible states.

In the clean design, a servant's master aborts the signal, but the servant still settles exactly once through its normal completion path. The master does not also resolve the servant's promise. Therefore a second `resolveWork` / `rejectWork` means a real logic bug and should throw loudly.

`CardActor` is the exception because it is not a servant adopter. It owns the activation controller and may resolve its outer activation immediately on cancellation while a late processor task is still unwinding. That race stays in `CardActor`, where it belongs, and is handled explicitly by clearing the outer activation slot after first resolution.

## 6. Adopters

| Actor | Adopts `SlaveBaseActor`? | Reason |
| --- | --- | --- |
| `ConversationLLMActor` / `LLMActor` | yes | provider-turn work slots: `turn` from `idle`, continuation from `waiting_tool` |
| `BaseCardProcessorActor` | yes | activation work slots from `idle` or `settled` |
| `AnalystSessionActor` | yes, if it remains an actor | one analyst turn from `idle` |
| `CardActor` | no | coordinator/master with card lifecycle states, notifications, descendant cancellation, and the activation abort controller |
| `RuntimeSupervisorActor` | no | mode flag, no async outcome |

`AnalystSessionActor` adoption is conditional on the F08 decision. If analyst sessions are made deliberately ephemeral and simplified out of `BaseActor`, they obviously do not adopt this base. If they remain actors, they should use the same slot helper rather than keeping `pendingTurn`.

## 7. LLM Actor Shape

The LLM actor has two kinds of work:

1. Initial turn from `idle`.
2. Continuation turn from `waiting_tool` after `appendToolResult`.

Both are provider-turn work slots. A tool-call outcome resolves the current slot and moves the actor to `waiting_tool`; the actor is parked and has no active work slot while it waits for a tool result. `appendToolResult` then creates a new slot and sends `turn` again.

```ts
turn(input: LlmInvocationInput, signal: AbortSignal): Promise<LLMActorOutcome> {
  if (this.state() !== 'idle') return Promise.reject(new Error(...));
  const promise = this.beginWork(input, signal);
  this.parkedSendEvent('turn');
  return promise;
}

appendToolResult(..., signal: AbortSignal): Promise<LLMActorOutcome> {
  if (this.state() !== 'waiting_tool') return Promise.reject(new Error(...));
  const nextInput = this.buildContinuationInput(...);
  const promise = this.beginWork(nextInput, signal);
  this.parkedSendEvent('turn');
  return promise;
}

_on_enter__calling_provider(): void {
  const { work: input, signal: activationSignal } = this.requireWork();
  this.runTask(async (runTaskSignal) => {
    await this.gate.waitUntilOpen();
    return this.provider.completeTurn(input, AbortSignal.any([runTaskSignal, activationSignal]));
  }, {
    on_done: (result) => this.completeWithProviderResult(input, result),
    on_failed: (error) => this.isCurrentTurnAborted(error)
      ? this.rejectWork(error)
      : this.completeWithError(input, error),
  });
}
```

The current private `#turnSignal` disappears; `workSignal()` / `requireWork().signal` is the activation signal. The cross-state insight from the cancellation design remains unchanged: provider calls compose the framework `runTask` signal with the caller's activation signal.

## 8. Processor Actor Shape

Processor actors have one activation slot at a time.

```ts
activate(input: CardActivationInput, signal: AbortSignal): Promise<CardProcessorOutcome> {
  if (this.hasWork() && this.isActiveState(this.state())) return this.pendingWork();
  if (!this.canActivateFrom(this.state())) return Promise.reject(new Error(...));
  const promise = this.beginWork(input, signal);
  this.parkedSendEvent('activate');
  return promise;
}

protected runPendingActivation(run: (input: CardActivationInput, signal: AbortSignal) => Promise<CardProcessorOutcome>): void {
  const { work: input, signal } = this.requireWork();
  this.runTask(() => run(input, signal), {
    on_done: (outcome) => this.finishActivation(outcome),
    on_failed: (error) => this.finishActivation(this.activationFailureOutcome(error.message)),
  });
}

private finishActivation(outcome: CardProcessorOutcome): void {
  this.outcome = outcome;
  this.activeReconstruction = null;
  this.onActivationSettled(outcome);
  this.resolveWork(outcome);
  this.sendEvent(outcome.status);
}
```

This deletes the `#pending` record and the double-promise construction. Processor re-entrancy uses `pendingWork()`.

## 9. Recovery

`restoreWork(work, signal)` is only for actors recovered directly into an active state.

The LLM actor needs it:

```ts
const actor = new LLMActor(...);
const promise = actor.restoreWork(active.input, recoveredActivationSignal);
actor.restoreLlmSpecificState(active);
actor.recover(snapshot.state_value);
```

`awaitPendingTurn()` returns `pendingWork()`.

The processor actor does not need `restoreWork` in normal startup recovery. Processors are constructed fresh, started into `idle`, then `CardActor`'s recovered `running` entry calls the processor's `activate` / `recoverActive`, which follows the normal `beginWork → activate event` path.

## 10. CardActor Is A Master, Not A Slave

`CardActor` does not adopt `SlaveBaseActor`. It owns card lifecycle state and the activation abort controller. It is also responsible for:

- writing card status,
- cancelling descendants,
- delivering notifications,
- resolving the root or parent activation,
- ignoring late processor outcomes after operator cancellation.

It should still be cleaned up as part of this design:

- Store one activation promise on the card actor.
- `activate` creates it and returns it.
- `awaitSettlement` returns the same promise by reference while work is running.
- `commitOutcome` / `cancel` clear the activation slot after first resolution.
- Late processor outcomes after cancellation are ignored explicitly in `CardActor`, not hidden by `SlaveBaseActor` no-op semantics.

This fixes the resolver-swap issue without pretending `CardActor` is a single-flight worker.

## 11. Cancellation

Cancellation remains caller-owned.

- `CardActor` owns the activation `AbortController` and aborts it in `cancel()`.
- Processor and LLM work slots receive that signal.
- Tools and provider calls observe that signal.
- The servant actor settles once through its normal completion path.

The base does not own an `AbortController`. Adding one would create another cancellation authority and reintroduce the duplication this design is removing.

Resolve-vs-reject on cancellation stays actor-specific:

- LLM provider-turn cancellation rejects the provider-turn promise.
- Analyst cancellation resolves with a cancelled response if analyst remains an actor.
- Processor cancellation is projected by the processor/card contract, not by the base.

## 12. Removal

- Add `src/runtime/micro-actor/slave-base-actor.ts`; export it from `src/runtime/micro-actor/index.ts`.
- Convert `ConversationLLMActor` to `SlaveBaseActor<LlmInvocationInput, LLMActorOutcome>`; delete `#pendingTurn`, `createPendingTurn`, `#turnSignal`, and pending-turn resolver plumbing.
- Convert `BaseCardProcessorActor` to `SlaveBaseActor<CardActivationInput, CardProcessorOutcome>`; delete `#pending` and the double-promise.
- Convert `AnalystSessionActor` only if the F08 decision keeps it as an actor; otherwise simplify analyst sessions directly and do not adopt this base there.
- Clean `CardActor` separately as master-side activation-slot cleanup; do not make it extend `SlaveBaseActor`.

## 13. Explicit Decisions

1. `SlaveBaseActor` is a work-slot helper, not a worker framework.
2. It does not impose an `idle` state. Domain methods enforce their own accepting states.
3. It has no public callback API. The callback object exists inside the slot; public methods keep returning promises.
4. It has no queue, no job ids, no `runJob`, and no abstract submit hook.
5. Double settlement throws. Generic no-op settlement is rejected as over-defensive.
6. Cancellation is caller-owned; the base does not create or abort controllers.
7. `restoreWork` exists only for direct active-state recovery, primarily the LLM actor.
8. `CardActor` is deliberately outside the base and gets a separate master-side cleanup.

## 14. Validation

- `beginWork` while another slot exists throws.
- `resolveWork` with no active slot throws.
- `rejectWork` with no active slot throws.
- `resolveWork` settles exactly once and clears the slot.
- Processor `activate` re-entrancy during active work returns `pendingWork()`.
- LLM `turn` from `idle` creates a slot; tool-call outcome resolves the slot and parks in `waiting_tool` with no active slot.
- LLM `appendToolResult` from `waiting_tool` creates a new slot and continues the provider turn.
- LLM direct recovery uses `restoreWork` then `recover('calling_provider')` / `recover('waiting_tool')`.
- CardActor `awaitSettlement` returns the same activation promise without resolver mutation.
- Cancellation through `CardActor.#activationAbort` aborts processor/LLM/tool work; servants settle through their normal paths.
- `npm run typecheck`; focused actor tests; `npm test`; `npm run build`.
