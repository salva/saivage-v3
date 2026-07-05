# Actor Result Channel Design

Status: design proposal.

Date: 2026-07-05

## 1. Problem

`BaseActor` is fire-and-forget: transitions and `runTask` return `void`; task results go to `on_done` / `on_failed` callbacks. This is the right framework design and stays.

Four actors accept one async work unit and must hand its outcome to a caller awaiting across the actor boundary (a supervisor awaiting `CardActor`; a card awaiting its processor; a processor awaiting the LLM actor; an HTTP handler awaiting the analyst). Each needs a **deferred result**: a promise plus its resolvers, stored so the actor's completion path can settle it.

Two earlier drafts of this design over-engineered the solution:

- `SlaveBaseActor` — a `BaseActor` subclass with nine protected methods.
- `WorkSlot<Work, Outcome>` — a composed component with six members bundling work + signal + deferred.

Both assumed "the current work unit" is a cohesive, extractable concept. It is not. The grep of the four actors shows the work unit smeared across many domain fields that cannot move into a shared class:

- `CardActor`: `#pendingActivation` (just `{ caller, resolve }`), plus `#activationId`, `#activationCounter`, `#activationAbort`, `#cancellation`.
- `AnalystSessionActor`: `pendingTurn`, plus `turnAbort`, `cancellationReason`, `toolInFlight`, `lastOutcome`.
- `ConversationLLMActor`: `#pendingTurn`, plus `#turnSignal`, `input`, `outcome`, `waitingToolCall`, `deliveredToolCallIds`, `#toolDeliveryCounter`, `#systemPromptLoggedSessionIds`.

A class that bundles work + signal + deferred captures 2 of N fields and leaves the actor holding the rest. That is an incoherent boundary. The only genuinely uniform thing across the four actors is the deferred itself — promise + resolvers — and that is three lines of idiomatic JavaScript.

## 2. The design

One helper, because JavaScript has no built-in deferred:

```ts
export type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: Error) => void;
};

export function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
```

Location: `src/runtime/actors/deferred.ts`.

Each actor holds `#result: Deferred<Outcome> | null` and keeps every other piece of work/cancellation state where it already is — on the actor. The public method creates the deferred, stores it, sends its event, returns `#result.promise`. The completion path resolves or rejects, then nulls the field.

That is the whole design. No work bundling, no slot class, no protected surface, no second type parameter.

## 3. A Promise is already the race guard

A JavaScript promise settles exactly once. `resolve(a)` then `resolve(b)` resolves with `a`; the second call is a native no-op. This is exactly the single-use, first-wins semantics the `WorkSlot` draft implemented manually. It is free, and it is correct for the one legitimate double-settle — `CardActor.cancel` racing the processor's late `on_done`:

- cancel resolves `cancelled` first → the late processor outcome is a native no-op. Card stays cancelled. Correct.
- processor completes first → cancel's resolve is a native no-op. Card stays done (cancel is a no-op on done cards anyway). Correct.

So `#cancellation` and the `commitOutcome` guard are deleted. The only discipline is nulling `#result` after settling so the next activation creates a fresh deferred. F13's resolver swap disappears for the same reason: `awaitSettlement` returns `this.#result.promise` by reference while active; two awaiters share one promise.

## 4. What changes per actor

Each actor gets the same small treatment. The deferred replaces the hand-rolled pending record; everything else stays.

### `ConversationLLMActor`

```ts
#result: Deferred<LLMActorOutcome> | null = null;
#activationSignal: AbortSignal | null = null;

turn(input: LlmInvocationInput, signal: AbortSignal): Promise<LLMActorOutcome> {
  if (this.state() !== 'idle' || this.#result) return Promise.reject(new Error(`...`));
  this.input = input;
  this.#activationSignal = signal;
  this.#result = deferred<LLMActorOutcome>();
  this.parkedSendEvent('turn');
  return this.#result.promise;
}

private settle(outcome: LLMActorOutcome, event: 'done' | 'failed' | 'tool_call'): void {
  this.#result?.resolve(outcome);
  this.#result = null;
  this.sendEvent(event);
}
```

`#pendingTurn`, `createPendingTurn`, and `#turnSignal` are deleted. `providerSignal` composes `AbortSignal.any([runTaskSignal, this.#activationSignal!])` — same cross-state insight as [Tool Cancellation Design](./tool-cancellation-design.md) §3.4, just sourced from a plain field. `abandonParkedTurn` is unchanged: it runs from `waiting_tool` where the segment's deferred is already settled and nulled.

### `BaseCardProcessorActor`

```ts
#result: Deferred<CardProcessorOutcome> | null = null;

activate(input, signal): Promise<CardProcessorOutcome> {
  if (this.#result && this.isActiveState(this.state())) return this.#result!.promise;
  if (!this.canActivateFrom(this.state())) return Promise.reject(new Error(`...`));
  this.#result = deferred<CardProcessorOutcome>();
  this.parkedSendEvent('activate');
  return this.#result.promise;
}

private finishActivation(outcome: CardProcessorOutcome): void {
  this.outcome = outcome;
  this.activeReconstruction = null;
  this.onActivationSettled(outcome);
  this.#result?.resolve(outcome);
  this.#result = null;
  this.sendEvent(outcome.status);
}
```

The entire `#pending` record, the double-promise (F11), and `settlePending`'s resolver fan-out are deleted. Re-entrancy returns `this.#result!.promise`.

### `CardActor`

```ts
#result: Deferred<CardActivationOutcome> | null = null;

activate(caller): Promise<CardActivationOutcome> {
  /* validations */
  this.#activationAbort = new AbortController();
  this.#result = deferred<CardActivationOutcome>();
  this.parkedSendEvent('activate');
  return this.#result.promise;
}

private commitOutcome(outcome): void {
  /* lifecycle patch, lastOutcome, activeReconstruction clear */
  this.#result?.resolve(outcome);   // native no-op if cancel already settled
  this.#result = null;
  this.sendEvent(outcome.status);
}

cancel(reason): void {
  /* write cancelled status, cancel descendants, abort #activationAbort */
  this.#result?.resolve({ status: 'cancelled', summary: reason.reason });
  this.#result = null;
  this.sendEvent('cancel');
}

awaitSettlement(): Promise<CardActivationOutcome> {
  if (this.#result) return this.#result.promise;   // shared by reference, no swap
  /* settled-card fallback */
}
```

`#pendingActivation`, `#cancellation`, the `commitOutcome` guard, and the `awaitSettlement` resolver swap are deleted.

### `AnalystSessionActor`

Same shape (one `#result: Deferred<AnalystTurnResult> | null`), if it remains an actor — see F08.

## 5. Recovery

There is no recovery API. The factory constructs the actor, sets `#result = deferred<Outcome>()` and `#activationSignal = signal`, restores actor-specific fields, then calls `recover(state)`. `awaitPendingTurn()` returns `this.#result!.promise`.

## 6. What is deliberately not shared

These differ across the four actors by design, and the deferred does not try to unify them:

- **Accepting-state precondition.** LLM requires `idle`; processor requires `idle` or `settled`; the domain method checks.
- **Re-entrancy policy.** Processor returns the existing promise; the others reject.
- **Cancellation ownership.** `CardActor` owns `#activationAbort`; the others receive a caller signal.
- **Resolve-vs-reject on cancel.** LLM rejects; analyst resolves with a cancelled response; processor/card settle with an outcome.
- **Recovery shape.** Only the LLM actor is recovered directly into an active state.

Forcing these into a shared class was the mistake in both earlier drafts. They are a few lines of domain code each, on the actor where they belong.

## 7. Why not `WorkSlot` or `SlaveBaseActor`

- The work unit is not extractable: each actor holds 4-8 domain fields around the deferred. A class that bundles two of them splits one concept across two objects.
- `SlaveBaseActor` (base class) additionally constrained inheritance and added nine protected names to every adopter's surface, which is why it had to exclude `CardActor`.
- The single-use race guard is native promise semantics. Re-implementing it (as both drafts did) is redundant code pretending to add safety.
- The one genuine gap — no built-in deferred in JavaScript — is five lines.

## 8. Explicit decisions

1. One helper, `deferred<T>()`, in `src/runtime/actors/deferred.ts`.
2. Each actor holds `#result: Deferred<Outcome> | null` and its own domain fields.
3. Settlement relies on native promise semantics (first-wins, no-op). No manual guard, no throw.
4. `#result` is nulled after settling so the next work unit gets a fresh deferred.
5. `awaitSettlement` shares the promise by reference.
6. Re-entrancy, accepting-state, cancellation, resolve-vs-reject, and recovery stay on each actor.

## 9. Validation

- `resolve(a)` then `resolve(b)` on a deferred → promise resolves with `a`.
- `resolve(a)` then `reject(e)` → resolves with `a`.
- `CardActor.cancel` after `commitOutcome` → cancel's resolve is a no-op; card stays done. `commitOutcome` after `cancel` → outcome resolve is a no-op; card stays cancelled.
- Two `awaitSettlement` callers during one activation → both resolve with the same outcome.
- Processor `activate` re-entrancy returns `#result.promise`.
- LLM `turn` from `idle` creates a deferred; a tool-call outcome settles and nulls it; `appendToolResult` creates a fresh one.
- LLM recovery sets `#result` then `recover(state)`; `awaitPendingTurn()` returns it.
- `npm run typecheck`; focused actor tests; `npm test`; `npm run build`.
