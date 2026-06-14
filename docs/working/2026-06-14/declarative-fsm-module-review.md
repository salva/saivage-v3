# Review: Declarative FSM Module Design

Date: 2026-06-14.

Purpose: find inconsistencies, oversights, short-sighted approaches, missing
functionality, errors, and bugs in `declarative-fsm-module-design.md`.

Principle: this is a minimalist framework. Do not extend it to do things we
don't need. Flag over-engineering just as seriously as gaps.

## 1. Section 9 command examples conflict with closure-based callbacks

**Severity: critical — two different completion-mechanism models in the same doc.**

Section 4 defines command completion through closure-based callbacks:

- The runtime converts a command into an async job.
- The job callback is a closure that captures the target `MachineRef`,
  event-construction data, and `enqueueEvent`.
- When the job completes, the closure constructs the event envelope and
  enqueues it.

Section 9 shows commands carrying event-type-name mappings:

```ts
type RuntimeCommand =
  | { type: "call_provider"; ...; onSucceeded: "provider_call_succeeded"; ... }
  | { type: "activate_child"; ...; onCompleted: "child_activation_completed"; ... }
```

These two mechanisms are different answers to the same question: "how does a
command's completion become an event?"

- **Model A (strings in commands)**: commands carry event-type-name strings. The
  runtime looks up a mapping to construct events. This requires a runtime
  registry mapping `(commandType, outcome, eventType) → eventConstructor`.
- **Model B (closures)**: the subsystem that creates the job from the command
  also constructs the callback closure. The closure already knows the target,
  event type, and payload construction. No registry needed.

We chose Model B in Section 4. Section 9's command examples still use Model A.

**Fix**: Remove `onSucceeded`/`onFailed`/`onTimedOut`/`onCompleted` string
fields from command types. Commands are pure side-effect data. The callback
closure is constructed by the code that creates the job, not embedded in the
command. Add a note making this explicit.

## 2. `on_enter` semantic gaps

**Severity: medium — unspecified behaviors that implementors will guess at.**

Three cases the doc does not address:

**(a) Does `on_enter` fire for the initial state?**

When a machine instance is first created with `state: initial`, does the
`on_enter` for the initial state run?

Recommendation: **No.** The initial state is set by definition, not by
transition. Initialization logic belongs at instance creation, not in `on_enter`.
If you need to emit initial commands, create the instance and then dispatch an
init event.

**(b) Does `on_enter` fire when a handler stays in the same state?**

Section 7 says: "If a handler returns no `state`, the machine remains in the
current state." Does `on_enter` for the current state run in this case?

Recommendation: **No.** `on_enter` fires on *entry* — meaning a transition
to a state that the machine was not already in. If the handler does not change
state, there is no entry. This is the standard FSM interpretation and avoids
accidental repeated initialization.

**(c) What inputs does `on_enter` receive?**

The type says `on_enter` is a `Handler`, which receives
`{ state, context, event }`. But after a transition, what values do these have?

- `state`: the target state (where the machine just arrived).
- `context`: the context after the triggering handler's updates.
- `event`: the original event that triggered the transition.

Recommendation: state these explicitly.

## 3. Context immutability rule

**Severity: medium — a handler could accidentally mutate shared context.**

Section 7 says handlers "must be pure with respect to external systems" and
"must not perform I/O." It does not state that handlers must not mutate the
input context object.

The `HandlerResult` type has `context?: Context`, which implies context
replacement. But nothing prevents a handler from mutating `input.context` and
returning nothing. If the runtime shares context references across dispatches,
mutation would be a silent bug.

**Fix**: Add an explicit rule: "Handlers and `on_enter` must not mutate the
input context. Return a new or updated context in the handler result. The
runtime should treat context as immutable and replace it with the handler
result."

This is not over-engineering — it prevents a class of bugs that are invisible
in single-dispatch unit tests and only appear under concurrent or interleaved
event processing.

## 4. `assign` helper type signature is incorrect

**Severity: low — utility sketch, not core API.**

```ts
export function assign<Context>(patch: Partial<Context>): { context: Context };
```

This type says `assign` returns `{ context: Context }`, but the function only
has a `Partial<Context>` patch — it would need the base context to merge with.
The actual signature would need to be a handler helper that merges the patch
into the current context, something like:

```ts
export function assign<Context>(patch: Partial<Context>):
  (input: { context: Context }) => { context: Context };
```

Or simply remove it from the spec, since `({ context }) => ({ context: { ...context, ...patch } })`
is clear enough inline. For a minimalist module, dropping the helper is fine —
the inline spread pattern is readable and doesn't need abstraction.

**Recommendation**: Remove `assign` from the optional helpers. It adds no value
over inline spread and its type is misleading.

## 5. `transition` helper is identity with checked type narrowing

**Severity: low — cosmetic, but could confuse.**

```ts
export function transition<State>(target: State): State;
```

This just returns `target`. Its only value is checked-type narrowing — it
ensures the target state string is a valid `State`. But the machine definition
validation already checks this at definition time.

**Recommendation**: Remove `transition` from the optional helpers. Direct
string values in the `on` map are clear and already validated by
`defineMachine`.

## 6. No issue — event delivery ordering is correct

Section 3 says "delivery for a single target object is serial" and "delivery
across different target objects may be concurrent." This is correct and
minimalist. No change needed.

## 7. No issue — `InvalidTransitionError` for unhandled events is correct

Section 13 says "Unknown event for current state throws." Section 3 says the
runtime catches this and records a diagnostic. For a minimalist FSM, this is
the right design: the machine is strict, and the runtime handles the fallout.
States that want to ignore events can add explicit no-op handlers.

## 8. No issue — no `on_exit` hook

Not having `on_exit` is correct for a minimalist framework. Cleanup logic
belongs in the transition handler or `on_enter` for the target state.

## Summary of changes

| # | What | Change |
|---|------|--------|
| 1 | Section 9 commands | Remove event-type-name fields from command types. Commands are pure side-effect data. |
| 2 | Section 6/7 `on_enter` | Add explicit rules: no `on_enter` on initial state; no `on_enter` when handler stays in same state; `on_enter` receives target state, updated context, original event. |
| 3 | Section 7 handlers | Add context immutability rule. |
| 4 | Section 12 helpers | Remove `assign` and `transition` helpers. |