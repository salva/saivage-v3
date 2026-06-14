# Third Review: Declarative FSM Module Design

Date: 2026-06-14.

Purpose: find inconsistencies, oversights, short-sighted approaches, missing
functionality, errors, and bugs in the current `declarative-fsm-module-design.md`.

Principle: minimalist framework. Do not extend it to do things we don't need.
Write findings only. Do not modify the design document.

## 1. `dispatch` is called both by name and by the pump sketch, but `defineMachine` return value is unclear

**Severity: low — API sketch ambiguity.**

Section 13 shows:

```ts
function dispatch<State, Self, Ev, Cmd>(
  machine: CompiledMachine<...>,
  self: Self,
  event: Ev,
): DispatchResult<State, Cmd>;
```

Section 3 shows:

```ts
const commands = dispatchEvent(event);
```

Two different names (`dispatch` and `dispatchEvent`) for what is presumably the same operation. `dispatchEvent` also takes an `EventEnvelope`, while `dispatch` takes a raw `Ev`. The relationship between them should be stated: `dispatchEvent` extracts the event from the envelope and calls `dispatch`.

## 2. `send` targets self only — but cross-object events need a different path

**Severity: medium — gap in the delivery model.**

Section 7 bookkeeping rules say:

> Machine objects expose a `send(name, args?)` method that queues an event for the same object in the global event queue.

This is fine for self-targeting events (e.g., timer completions, cancel signals). But the delivery rules in Section 3 say events can target any FSM object via `EventEnvelope.target`. The pump sketch shows `dispatchEvent(event)` where `event` is an `EventEnvelope` with a `target`.

The gap: how does one FSM object send an event to *another* FSM object? `self.send` only targets self. The design needs either:

- (a) A `sendTo(target, name, args)` on MachineSelf, or
- (b) A separate runtime function `enqueueEvent(envelope)` that external code and callbacks use, and `self.send` is just sugar for `enqueueEvent({ target: self._ref, name, args })`.

Option (b) is cleaner and already implicit in the callback examples. The `MachineRef` and `enqueueEvent` function exist in the design already. Adding a `sendTo` method would be redundant — the queue is global and `enqueueEvent` already handles cross-object delivery.

**Recommendation:** Document that `self.send(name, args)` wraps `enqueueEvent` with the object's own `MachineRef`, and that cross-object delivery uses `enqueueEvent` directly or through a runtime function. No new method on `MachineSelf` is needed.

## 3. `AsyncEventQueue` is runtime, not FSM module

**Severity: low — boundary clarity.**

The `AsyncEventQueue` class and `runEventPump` function in Section 3 are runtime code, not FSM module code. They should be clearly marked as "runtime sketch, not part of the FSM module." The FSM module exports `defineMachine`, `dispatch`, and error classes only. The queue and pump belong to the Saivage runtime.

## 4. `EventEnvelope.id` is declared but never consumed

**Severity: low — unused field.**

`EventEnvelope` has an `id` field for deduplication, but no rule says what the FSM module or runtime does with it. The delivery rules mention "Event envelopes should have stable ids so delivery can be deduplicated after recovery" but there is no deduplication mechanism described.

This is fine for a minimalist design — the runtime handles dedup, not the FSM module — but a brief note saying "The FSM module does not inspect or use `id`. Deduplication is the runtime's responsibility" would close the loop.

## 5. `MachineRef` is declared but never connected to `MachineSelf`

**Severity: low — type gap.**

`MachineSelf` has `_sm` and methods, but no `MachineRef` field. How does `send` know which `MachineRef` to put on the envelope? Either:

- The FSM module stores a `ref: MachineRef` inside `_sm`, or
- The runtime sets it when creating the object.

This is a runtime concern, not an FSM module concern, but `MachineSelf` should probably include the `ref` so `send` can use it. Alternatively, `send` can be a runtime method that knows the object's ref from outside.

**Recommendation:** Add `ref?: MachineRef` to `_sm` as an optional field set by the runtime, or document that `send` gets the ref from runtime context, not from the FSM module API.

## 6. Callback example still uses `EnqueueEvent<LlmEvent>` and typed `JobCallback<Ev>`

**Severity: low — stale type parameter.**

Section 4 still shows:

```ts
type AsyncJob<Cmd extends Command, Ev extends Event> = { ... callback: JobCallback<Ev>; ... };
type JobCallback<Ev extends Event> = { ... };
```

And the callback example:

```ts
function makeProviderCallback(input: {
  ...
  enqueueEvent: (envelope: EventEnvelope) => void;
}): JobCallback<LlmEvent> {
```

Since events are now untyped `{ name, args? }`, the generic `Ev` parameter on `AsyncJob` and `JobCallback` is misleading. The callback doesn't need a type parameter for the event shape since events are plain dictionaries.

**Recommendation:** Simplify to:

```ts
type JobCallback = {
  onSucceeded: (result: unknown) => void;
  onFailed: (error: unknown) => void;
  onTimedOut: () => void;
};
```

The `Ev` parameter adds no enforcement since `Event` is `{ name: string; args?: Record<string, unknown> }`.

## 7. `Ev extends Event` parameter is vestigial throughout

**Severity: low — cosmetic but confusing.**

`Event` is now `{ name: string; args?: Record<string, unknown> }`. The `Ev` generic parameter on `Handler`, `StateDefinition`, and `MachineDefinition` no longer constrains anything meaningful — it's always `Event`. The type system cannot enforce that a particular state only accepts certain event names because the `on` map is `Record<string, ...>`.

Keeping `Ev` doesn't hurt, but it suggests a degree of type safety that doesn't exist. Two options:

- (a) Remove `Ev` entirely from the API and just use `Event` everywhere. Simpler, honest.
- (b) Keep `Ev` as a documentation hint but document that the framework does not enforce event name types.

**Recommendation:** Remove `Ev` from the minimal API. Replace with plain `Event`. This reduces generic complexity without losing anything since events are untyped dictionaries.

## 8. `on_enter` handler that returns no state and no commands returns void-ish result

**Severity: low — edge case clarity.**

A handler that wants to stay in the same state and emit no commands can return `{}`. The `HandlerResult` type allows this since all fields are optional. But there is no explicit rule saying what happens when a handler returns `undefined` or `void` vs `{}`.

In practice JavaScript handlers that forget `return` will return `undefined`. The dispatch logic should treat `undefined` the same as `{}` — no state change, no commands.

**Recommendation:** Add a brief rule: "If a handler returns `undefined` or `{}`, the machine stays in the current state and no commands are emitted."

## 9. No mention of `MachineSelf` containing a `ref` for `send`

**Severity: medium — `send` cannot work without it.**

`self.send(name, args)` needs to produce an `EventEnvelope` with a `target: MachineRef`. But `MachineSelf` doesn't include a `MachineRef`. The `send` method needs either:

- A `ref` stored on the object (under `_sm` or at top level), or
- A closure over the runtime's `enqueueEvent` function that already knows the target.

If `send` is a method on `MachineSelf`, it needs access to both the queue and the object's own ref. These could be closure-captured at object creation time.

**Recommendation:** Either add `ref: MachineRef` to `MachineSelf._sm` and document that the runtime sets it, or document that `send` is a runtime-added method that closes over the global queue and the object's ref. The second option keeps `MachineSelf` as a simpler type.

## 10. `drain()` has a race condition comment opportunity

**Severity: low — not a bug, but worth noting.**

The `AsyncEventQueue.drain()` implementation replaces `this.items` with a new empty array. Between `shift()` returning the first item and `drain()` being called, another `push()` could arrive. Since JS is single-threaded, this is safe — `push` cannot interleave within the same microtask. But this is worth a brief note for anyone porting to a multi-threaded environment.

No action needed for the minimalist design, just recording that the queue assumes single-threaded delivery.

## Summary

| # | What | Severity | Recommendation |
|---|------|----------|----------------|
| 1 | `dispatch` vs `dispatchEvent` naming | Low | Document that `dispatchEvent` extracts event from envelope and calls `dispatch` |
| 2 | Cross-object event delivery path | Medium | Document that `self.send` targets self; `enqueueEvent` with explicit `target` handles cross-object |
| 3 | Queue/pump is runtime, not FSM module | Low | Add brief "this is runtime code, not part of the FSM module" note |
| 4 | `EventEnvelope.id` unused by FSM module | Low | Add note that FSM module does not inspect `id`; deduplication is runtime's job |
| 5 | `MachineRef` not in `MachineSelf` | Low | Document that `send` gets the ref from runtime context, or add optional `ref` to `_sm` |
| 6 | Stale `Ev` generic on `AsyncJob`/`JobCallback` | Low | Remove `Ev` type parameter; use plain `JobCallback` without generic |
| 7 | `Ev extends Event` parameter is vestigial | Low | Consider removing `Ev` from API since events are untyped; reduces generic complexity |
| 8 | Handler returning `undefined` | Low | Add rule: `undefined` or `{}` means no state change and no commands |
| 9 | `send` needs access to `MachineRef` | Medium | Document that `send` is a runtime-added method closing over queue and ref, or add `ref` to `_sm` |
| 10 | Queue assumes single-threaded JS | Low | Note in code comment, no design change needed |