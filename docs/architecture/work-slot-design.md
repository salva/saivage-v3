# Work Slot Design

Status: design proposal.

Date: 2026-07-05

## 1. Purpose

`BaseActor` is fire-and-forget. Transitions return `void`; `runTask` returns `void` and delivers results to `on_done` / `on_failed` callbacks. This is the right framework design — a state machine that awaits results cannot abort cleanly on state change — so it stays.

Above the framework, every actor that accepts one async work unit and reports an outcome needs a result channel. Four actors hand-rolled one, and they drifted:

- `ConversationLLMActor.#pendingTurn`
- `BaseCardProcessorActor.#pending` (with a nested double-promise solely to expose the in-flight promise)
- `CardActor.#pendingActivation` + `#activationAbort` + `#cancellation` + the `commitOutcome` race guard
- `AnalystSessionActor.pendingTurn` + `turnAbort` + `cancellationReason`

This is review finding F04, and the root cause of F11 (double-promise), F13 (resolver swap), and the cancellation-flag triad in F05.

This design replaces all four with one small composed component: `WorkSlot<Work, Outcome>`.

## 2. Component, not base class

An earlier draft proposed `SlaveBaseActor`, a `BaseActor` subclass with nine protected methods. Reviewing against "clean and simple, no over-engineering," a component is strictly better:

- **No inheritance constraint.** The base-class draft had to exclude `CardActor` (the worst case) because `CardActor`'s cancel race did not fit the base's throw-on-double-settle. A component has no such limit; `CardActor` adopts it like any other.
- **No protected-method pollution.** Adopters hold one private field instead of inheriting nine names.
- **Decoupled from `BaseActor`.** `WorkSlot` is a plain single-flight result holder. It does not know about states, events, or recovery. It is reusable and testable in isolation.
- **No false "master/servant" framing.** The base-class draft split actors into slaves and masters and special-cased the master. There is no such split: every one of these actors has exactly one in-flight operation whose result someone awaits. That is a work slot.

Each actor holds a `WorkSlot` field. There is one implementation, so the four hand-rolled channels cannot drift again.

This also corrects the older removed `SlaveActor` / `SimpleSlaveActor`, which over-specified in the other direction (a queue, job ids, a baked-in `waiting → running` loop). `WorkSlot` owns one concept: the current work unit's result channel.

## 3. `WorkSlot`

Location: `src/runtime/actors/work-slot.ts`. It does not extend `BaseActor` and does not live in the frozen `micro-actor/` directory.

```ts
export class WorkSlot<Work, Outcome> {
  #slot: {
    work: Work;
    signal: AbortSignal;
    resolve: (outcome: Outcome) => void;
    reject: (error: Error) => void;
    promise: Promise<Outcome>;
  } | null = null;

  get active(): boolean { return this.#slot !== null; }
  get promise(): Promise<Outcome> | null { return this.#slot?.promise ?? null; }

  begin(work: Work, signal: AbortSignal): Promise<Outcome> {
    if (this.#slot !== null) throw new Error('WorkSlot already active');
    let resolve!: (outcome: Outcome) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<Outcome>((res, rej) => { resolve = res; reject = rej; });
    this.#slot = { work, signal, resolve, reject, promise };
    return promise;
  }

  resolve(outcome: Outcome): void {
    const slot = this.#slot;
    this.#slot = null;
    slot?.resolve(outcome);
  }

  reject(error: Error): void {
    const slot = this.#slot;
    this.#slot = null;
    slot?.reject(error);
  }

  require(): { work: Work; signal: AbortSignal } {
    if (!this.#slot) throw new Error('WorkSlot has no active work');
    return { work: this.#slot.work, signal: this.#slot.signal };
  }
}
```

Contract:

- `begin(work, signal)` creates the slot and returns its promise. Throws only if a slot already exists — an invariant backstop. Domain methods pre-check `active` and apply their own re-entrancy policy (return the existing promise, or reject) before calling `begin`.
- `resolve(outcome)` / `reject(error)` settle and clear the slot. **No-op if there is no slot.** Safe to call from `runTask` callbacks.
- `active` / `promise` — predicate and current promise (for re-entrancy, `awaitSettlement`, recovered-turn lookup).
- `require()` — returns `{ work, signal }` for the active-state enter hook. Throws if no slot.

Six members. No event sending, no state machine, no recovery-specific method, no signal getter separate from `require`.

## 4. Single-use, first-wins, no-op — not throw

An earlier draft threw on double settlement. That is unsafe. `resolve` / `reject` are called from `runTask` `on_done` / `on_failed`, which execute inside `BaseActor.#actorMain`. A throw there is caught by the main loop, which logs and sets `#actorMainRunning = false` (`micro-actor.ts#L199-L203`); the actor is dead. Enforcing an invariant by killing the actor is catastrophic.

Double settlement has exactly one legitimate cause: `CardActor.cancel` resolves the activation with a cancelled outcome while the processor's `runTask` is still unwinding and fires its `on_failed` a moment later. First-resolution-wins is the correct semantics for that race — the cancelled outcome should win, the late processor failure should be dropped. For the LLM, processor, and analyst actors, double settlement does not happen in correct operation; a spurious second call is silently ignored rather than catastrophic.

So `resolve` / `reject` clear the slot and become no-ops on a second call. The first outcome always wins. This is the whole race guard; it deletes `CardActor.#cancellation` and the `commitOutcome` guard.

## 5. Adopters — all four

| Actor | Work | Outcome | Notes |
| --- | --- | --- | --- |
| `ConversationLLMActor` | `LlmInvocationInput` | `LLMActorOutcome` | one slot per provider-call segment; resolved on message/tool_call/error, re-begun on continuation |
| `BaseCardProcessorActor` | `CardActivationInput` | `CardProcessorOutcome` | one slot per activation |
| `CardActor` | activation caller | `CardActivationOutcome` | one slot per activation; settled by `commitOutcome` **or** `cancel` |
| `AnalystSessionActor` | analyst turn | `AnalystTurnResult` | one slot per turn (if analyst remains an actor — see F08) |

`CardActor` is included. The base-class draft excluded it; the only reason was the throw semantics, which §4 removes. With first-wins no-op settlement, `CardActor.cancel` and the processor's late `on_done` both settle the same slot safely.

`RuntimeSupervisorActor` does not adopt: it returns sync booleans, not outcomes.

## 6. Shapes

### 6.1 `ConversationLLMActor`

The slot is per provider-call segment. `turn` and `appendToolResult` each `begin` one; the segment's outcome resolves it; the actor parks in `waiting_tool` with no active slot until the next segment.

```ts
turn(input: LlmInvocationInput, signal: AbortSignal): Promise<LLMActorOutcome> {
  if (this.state() !== 'idle') return Promise.reject(new Error(`...cannot turn from '${this.state()}'`));
  const promise = this.work.begin(input, signal);
  this.parkedSendEvent('turn');
  return promise;
}

_on_enter__calling_provider(): void {
  const { work: input, signal: activationSignal } = this.work.require();
  this.runTask(async (runTaskSignal) => {
    await this.gate.waitUntilOpen();
    return this.provider.completeTurn(input, AbortSignal.any([runTaskSignal, activationSignal]));
  }, {
    on_done: (result) => this.completeWithProviderResult(input, result),
    on_failed: (error) => this.isCurrentTurnAborted(error) ? this.work.reject(error) : this.completeWithError(input, error.message),
  });
}

private completeWithProviderResult(input, result): void {
  // message  → this.work.resolve({ type:'result', ... }); sendEvent('done')
  // tool_call → this.work.resolve({ type:'tool_call', ... }); sendEvent('tool_call')
}
```

`#pendingTurn`, `createPendingTurn`, `#turnSignal`, and the abort-detection plumbing are deleted. `activationSignal` is `this.work.require().signal` — the cross-state insight from [Tool Cancellation Design](./tool-cancellation-design.md) §3.4 is preserved; only the source of the activation signal changes.

`abandonParkedTurn` touches no slot (it runs from `waiting_tool`, where the segment's slot is already resolved); it is unchanged in shape.

### 6.2 `BaseCardProcessorActor`

```ts
activate(input: CardActivationInput, signal: AbortSignal): Promise<CardProcessorOutcome> {
  if (this.work.active && this.isActiveState(this.state())) return this.work.promise!;
  if (!this.canActivateFrom(this.state())) return Promise.reject(new Error(`...cannot activate from '${this.state()}'`));
  const promise = this.work.begin(input, signal);
  this.parkedSendEvent('activate');
  return promise;
}

protected runPendingActivation(run: (input, signal) => Promise<CardProcessorOutcome>): void {
  const { work: input, signal } = this.work.require();
  this.runTask(() => run(input, signal), {
    on_done: (outcome) => this.finishActivation(outcome),
    on_failed: (error) => this.finishActivation(this.activationFailureOutcome(error.message)),
  });
}

private finishActivation(outcome: CardProcessorOutcome): void {
  this.outcome = outcome;
  this.activeReconstruction = null;
  this.onActivationSettled(outcome);
  this.work.resolve(outcome);
  this.sendEvent(outcome.status);
}
```

The entire `#pending` record, the double-promise, and `settlePending`'s resolver fan-out are deleted. Re-entrancy uses `this.work.promise`.

### 6.3 `CardActor`

```ts
activate(caller: CardActivationCaller): Promise<CardActivationOutcome> {
  // ... existing caller / status validation ...
  const promise = this.work.begin({ caller }, this.#activationAbort!.signal);  // see note
  this.#activationAbort = new AbortController();
  this.parkedSendEvent('activate');
  return promise;
}

private commitOutcome(outcome: ...): void {
  // ... lifecycle patch, lastOutcome, activeReconstruction clear ...
  this.work.resolve(outcome);
  this.sendEvent(outcome.status);
}

cancel(reason: CardCancelReason): void {
  // ... write cancelled status, cancel descendants ...
  this.#activationAbort?.abort(new Error(reason.reason));
  this.work.resolve({ status: 'cancelled', summary: reason.reason });  // first-wins: no-ops if commitOutcome already settled
  this.sendEvent('cancel');
}

awaitSettlement(): Promise<CardActivationOutcome> {
  if (this.work.active) return this.work.promise!;
  // ... existing settled-card fallback ...
}
```

`#pendingActivation`, `#cancellation`, the `commitOutcome` cancellation guard, and the `awaitSettlement` resolver swap are deleted. The slot's nullness is the settled check. `#activationAbort` stays — `CardActor` owns the controller because it is the entity that decides to cancel.

### 6.4 `AnalystSessionActor`

Adopts the same way (one slot per turn, settled from the `runTask` `on_done`/`on_failed`) **if** it remains an actor. F08 may instead simplify analyst sessions out of `BaseActor` entirely; in that case this design does not apply to it. The decision is independent of this doc.

## 7. Recovery

There is no recovery-specific API. The recovery factory constructs the actor, calls `work.begin(work, signal)` on its fresh slot, restores actor-specific fields, then calls `recover(state)`:

```ts
static fromActiveReconstruction(args: ...): LLMActor {
  const actor = new LLMActor({ ... });
  const promise = actor.work.begin(args.activeReconstruction.input, args.signal);
  actor.restoreLlmSpecificState(args.activeReconstruction);  // deliveredToolCallIds, waitingToolCall, etc.
  actor.recover(args.state);
  return actor;  // caller reads promise via awaitPendingTurn() → actor.work.promise
}
```

`begin` on a freshly-constructed slot cannot conflict (the slot is empty), so no special "arm without triggering" method is needed. `awaitPendingTurn()` returns `this.work.promise`. Processor recovery uses the normal `activate` path (processors are constructed fresh into `idle`, then `CardActor`'s recovered entry drives `activate`); it does not recover directly into an active state.

## 8. What this deletes

- `ConversationLLMActor`: `#pendingTurn`, `createPendingTurn`, `failPendingTurnFatally`'s resolver plumbing, `#turnSignal`.
- `BaseCardProcessorActor`: `#pending`, the double-promise `activate` body, `settlePending`'s `pending.resolve`.
- `CardActor`: `#pendingActivation`, `#cancellation`, the `commitOutcome` race guard, the `awaitSettlement` resolver swap.
- `AnalystSessionActor` (if it remains an actor): `pendingTurn`, `turnAbort`, the `cancellationReason`-gated callbacks.

## 9. Explicit decisions

1. `WorkSlot` is a composed component, not a `BaseActor` subclass. Adopters hold one private field.
2. It owns one concept: the current work unit's result channel. No queue, no state machine, no event sending, no recovery-specific method.
3. Settlement is single-use, first-wins, no-op — not throw. Throw would kill the actor via `#actorMain`'s catch. The one legitimate double-settle (`CardActor` cancel race) is handled correctly by first-wins.
4. `CardActor` adopts the slot. The earlier exclusion existed only to preserve throw semantics; with no-op settlement there is no reason to exclude it.
5. Cancellation stays caller-owned. `CardActor` keeps `#activationAbort`; `WorkSlot` stores the caller's signal so enter hooks can compose it with the framework `runTask` signal, but it does not own a controller.
6. Domain methods own accepting-state preconditions and re-entrancy policy. `WorkSlot.begin`'s throw-if-active is a backstop, not the policy.
7. `restoreWork` / `clearWork` from the earlier draft are removed: the first is `begin` on a fresh slot, the second was invented for a flow (`abandonParkedTurn`) that has no active slot.

## 10. Validation

- `begin` while active throws; domain methods pre-check `active` so this is unreachable in correct use.
- `resolve` / `reject` with no slot is a silent no-op (first-wins).
- `resolve(outcomeA)` then `resolve(outcomeB)` → promise resolves with `outcomeA`.
- `resolve(outcome)` then `reject(error)` → promise resolves with `outcome`.
- Processor `activate` re-entrancy during active work returns `work.promise`.
- LLM `turn` from `idle` begins a slot; a tool-call outcome resolves it and the actor parks in `waiting_tool` with no active slot; `appendToolResult` begins a new slot.
- LLM recovery: `begin` on a fresh slot + `recover('calling_provider')` → provider call settles via `resolve`/`reject`.
- `CardActor.cancel` after `commitOutcome` → cancel's `resolve` is a no-op; card stays done. `commitOutcome` after `cancel` → outcome `resolve` is a no-op; card stays cancelled.
- `awaitSettlement` returns `work.promise` while active; returns the synthesized terminal outcome when the card is already settled.
- `npm run typecheck`; focused actor tests; `npm test`; `npm run build`.
