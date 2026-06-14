# Second Review: Declarative FSM Module Design

Date: 2026-06-14.

Purpose: find inconsistencies, oversights, short-sighted approaches, missing
functionality, errors, and bugs in the current `declarative-fsm-module-design.md`
after the on_leave / object-instance / ignore-default / delay-out-of-scope
updates.

Principle: minimalist framework. Do not extend it to do things we don't need.
Flag over-engineering as seriously as gaps.

## 1. DispatchResult no longer carries the full object — but the runtime needs it

**Severity: medium — the API sketch is now incomplete.**

`DispatchResult` currently returns `{ state, commands }`. Previously it returned
`{ state, context, commands }`. Now that handlers mutate `self` directly, the
dispatch function modifies the passed-in object in place and returns only the
new state and commands.

The runtime still needs to know what changed. Two options:

- **(a) Return `self` from dispatch.** The dispatch function already has the
  mutated object. Return it so the runtime can persist it. This is the simplest
  and most consistent approach.

- **(b) Trust that the runtime already holds a reference to `self`.** Since
  `self` is passed by reference, the runtime already sees the mutations. Return
  only `state` and `commands`, and document that `self` is mutated in place.

The doc doesn't say which. The `MachineSnapshot` / `Data` type in Section 9
suggests the runtime persists snapshots, but the dispatch API sketch only
returns `{ state, commands }`.

**Recommendation:** State explicitly that `dispatch` mutates `self` in place and
the caller already holds a reference to the mutated object. Remove `state` from
`DispatchResult` if the caller can read `self.state`, or keep `state` as a
convenience. The persistence story is: the runtime serializes `self` after
dispatch returns, not from the `DispatchResult`.

## 2. `on_leave` fires on same-state handler — ambiguous

**Severity: medium — the `cancel_requested` example depends on this.**

Section 7 says: "If a handler returns no `state`, the machine remains in the
current state." Section 6 says: "`on_enter` does not fire when a handler stays
in the same state."

But the doc never says whether `on_leave` fires when a handler stays in the
same state.

Consider the LLM loop example:

```ts
cancel_requested: ({ self }) => {
  self.cancellationRequested = true;
  return {};  // no state change
},
```

Should `on_leave` for `calling_provider` fire here? No — there is no
transition. The handler just sets a flag and stays. This matches `on_enter`
not firing either.

But what if someone writes a handler that stays in the same state but *does*
return `{ state: "same_state" }` explicitly? Is that different from returning
`{}`?

**Recommendation:** Add an explicit rule: "`on_leave` does not fire when the
machine stays in the same state, regardless of whether the handler explicitly
returns the current state or returns no `state` field. A state must actually
change for `on_leave` and `on_enter` to fire."

## 3. Section 3 still mentions InvalidTransitionError for unknown events

**Severity: low — minor inconsistency with the ignore-default rule.**

Section 3, line 72:

> If dispatch throws `InvalidTransitionError` for an invalid snapshot state or
> invalid target state, the runtime records a diagnostic and does not retry the
> same event blindly.

This is correct as written — it now says "invalid snapshot state or invalid
target state," not "unknown event." But Section 14 says "unknown events for
the current state are ignored." The `InvalidTransitionError` export is still in
the API surface.

These are consistent: `InvalidTransitionError` is for truly invalid states and
targets, not for unhandled events. But the naming could confuse an implementor
into thinking an unhandled event should throw.

**Recommendation:** Either rename to `InvalidStateError` / `InvalidTargetError`,
or add a brief note that `InvalidTransitionError` is thrown only for unknown
snapshot states and invalid target states, not for unhandled events. A simple
doc sentence is enough; no API change needed.

## 4. `sequence` only supports `done`-advance — but `error` convention is undocumented here

**Severity: low — missing convenience, not a fault.**

Section 8 says `error` is the conventional failure event name with no implicit
behavior unless the machine declares an `error` transition. This is fine. But
a common pattern in QVD (and likely in Saivage) is a sequence where `error`
should jump to a shared error/cleanup path regardless of which step fails.

Currently you'd need to declare `error` on every step state. With `sequence`,
you'd have to duplicate the error handler across all sequence states.

This is not a framework feature request — it's a documentation note. The
`sequence` convention is intentionally minimal. If error-from-any-step becomes
painful, the runtime can use `__any__`-style defaults or a shared error state
in the machine definition, but that's a later iteration.

**No change needed.** Just recording that this is a known convenience gap that
should be solved at the machine-definition layer, not the FSM module layer.

## 5. `command` helper is now orphaned

**Severity: low — the helper sketch is inconsistent with the examples.**

Section 13 still shows:

```ts
export function command<Command>(command: Command): { commands: Command[] };
```

But none of the examples use it. Every handler uses the inline
`{ commands: [...] }` form. The helper wraps a single command into an array,
which is marginal sugar at best.

**Recommendation:** Remove `command` from the optional helpers. It adds no
value over `[{ type: "..." }]` and is never used in the examples.

## 6. `on_enter` handler signature inconsistency with `self` vs `{ self, event }`

**Severity: low — TypeScript will catch this, but the sketch is misleading.**

The `Handler` type signature uses `(input: { self; event })`. The `on_enter`
section says `on_enter` "receives the same inputs as a regular handler: `self`
is the machine object after its state field has been updated."

But the `shutting_down` example writes:

```ts
on_enter: () => ({
  commands: [{ type: "terminate_runtime_processes", timeoutMs: 30_000 }],
}),
```

This arrow function takes no arguments. TypeScript would infer this as a
`Handler` that ignores its input, which works since `Handler`'s parameter is a
single object. But the pattern `({ self }) => ...` used in event handlers is
different from `() => ...` used in `on_enter`.

This is fine — `on_enter` is just a `Handler` and can destructure or ignore
its inputs. No change needed, just noting the pattern is correct.

## 7. `MachineSnapshot.data` type is unused and potentially confusing

**Severity: low — the snapshot type is mentioned but not wired into any API.**

Section 9 defines:

```ts
type MachineSnapshot<State extends string, Data extends object> = {
  machine: string;
  id: string;
  state: State;
  data: Data;
  version: number;
};
```

But `dispatch` takes `self: Self`, not a snapshot. And `MachineSnapshot` isn't
used anywhere in the API surface. The module is supposed to include "a small
snapshot validator" but the validator isn't sketched.

If `self` is the live object and `dispatch` mutates it in place, then the
snapshot is how the runtime persists and reconstructs `self`. The type should
probably be `Data` matching the fields of `Self` minus the `state` field (since
`state` is already in the snapshot), or it should be documented that `Data`
is whatever the runtime chooses to persist.

**Recommendation:** Either:
- (a) Remove `MachineSnapshot` from the FSM module doc entirely and say
  "persistence is the runtime's responsibility; the FSM module only requires
  that `self` objects are reconstructable from persisted data." This is the
  minimalist choice.
- (b) Keep it but add a note that `Data` represents the serializable fields of
  `Self` and the runtime is responsible for serialization/deserialization;
  `state` is stored separately in the snapshot.

Option (a) is cleaner for a minimalist FSM module.

## Summary of recommended changes

| # | What | Change |
|---|------|--------|
| 1 | Dispatch mutates `self` | Add explicit rule: `dispatch` mutates `self` in place. The runtime holds the reference and persists it after dispatch returns. |
| 2 | `on_leave` same-state rule | Add explicit rule: `on_leave` does not fire when the machine stays in the same state. Both `on_leave` and `on_enter` fire only on actual state change. |
| 3 | `InvalidTransitionError` scope | Add note: thrown only for unknown snapshot states and invalid target states, not for unhandled events. |
| 4 | `error` in sequences | No change. Document as known convenience gap, solved at machine-definition layer. |
| 5 | `command` helper | Remove from optional helpers. Never used in examples. |
| 6 | `on_enter` signature | No change. Pattern is correct. |
| 7 | `MachineSnapshot` | Remove from the FSM module doc. Say persistence is the runtime's responsibility and `self` objects must be reconstructable from persisted data. |