# XState Runtime Core Open Decisions

Status: design decisions needing operator supervision.

Last updated: 2026-06-12.

This document lists the remaining design choices that should be decided deliberately before the runtime-core architecture is treated as fully settled.

## 1. Should `needs_verification` Exist As A Card Status?

### Context

The functional specification defines these card statuses: `backlog`, `running`, `changed`, `done`, `failed`, `blocked`, and `cancelled`.

Executor outcomes fit the same activation contract as every card's main agent: the child activation returns exactly one of `done`, `failed`, or `blocked` to the parent planner. A separate `needs_verification` status would add a fourth terminal-ish executor outcome where the executor says work is partially complete but needs human or reviewer verification before the parent can proceed.

This is not just a naming detail. It changes the planner contract, completion gates, UI/read-model status set, notification/correction flows, and recovery rules.

### Option A: Do Not Add `needs_verification` (Recommended)

Keep the status set as specified. If an executor cannot honestly report `done`, it reports `blocked` with a precise reason, such as "needs manual verification of generated artifact." The parent planner then handles the unresolved blocker by adding verification work, notifying a card, editing/cancelling work, or reporting `blocked` upward.

Benefits:

- Keeps activation outcomes simple: `done`, `failed`, `blocked`.
- Keeps `blocked` as the single unresolved-work state.
- Avoids another completion-gate case.
- Avoids a status that overlaps with reviewer assessment.
- Better matches the functional specification.

Costs:

- "Needs verification" becomes a kind of `blocked`, not a visually distinct lifecycle state.
- The UI may need good blocked-reason display so this remains understandable.

### Option B: Add `needs_verification` As A First-Class Status

Add `needs_verification` to the functional specification, card status set, activation outcomes, completion gates, terminal card machine, read models, and UI.

Benefits:

- Gives partial executor success a distinct state.
- Makes verification-needed cards easy to filter and display.

Costs:

- Adds a fourth activation outcome beyond `done`/`failed`/`blocked`.
- Complicates parent planner handling: the parent must know how `needs_verification` differs from `blocked`.
- Overlaps with reviewer and evidence validation concepts.
- Requires additional cancellation, changed propagation, completion compatibility, and recovery semantics.

### Recommendation

Choose Option A unless there is a strong product need for a separate visual/status category. `blocked` already means unresolved work that requires parent/user action, and "needs verification" fits that meaning.

## 2. Should Readiness Checking Be A Named Machine Phase Or A Guard?

### Context

Before a planner can close a goal as `done`, the runtime must verify that descendant statuses are completion-compatible, evidence references are valid, and reviewer assessment can begin. The architecture currently names this phase `checking_readiness`.

In XState terms, a readiness check could be either:

- a guard on the transition from planner `done` report to reviewer assessment; or
- a short named state that performs validation and emits a planner-visible diagnostic when it fails.

### Option A: Keep `checking_readiness` As A Named Phase (Recommended)

Use a named phase because readiness failures are meaningful runtime events. A planner-visible diagnostic should identify exactly which descendant/evidence condition blocked completion.

Benefits:

- Easier to observe and debug why a completion attempt failed.
- Gives recovery a clear boundary if a crash happens during validation.
- Makes the readiness gate explicit in machine traces and tests.

Costs:

- Slightly more machine state than a pure guard.

### Option B: Make Readiness A Guard

Use guards from `planning` directly to `reviewing`, with rejection actions that return diagnostics to the planner.

Benefits:

- Smaller state machine.
- More idiomatic when validation is synchronous and side-effect-free.

Costs:

- Less visible in machine traces.
- Harder to attach durable diagnostics or recovery classification if readiness validation expands.

### Recommendation

Keep the named phase for clarity unless implementation shows it is purely synchronous and trivial.

## 3. How Explicit Should Configuration Reload Semantics Be?

### Context

The specification says the Analyst can change model/provider routing, failover ordering, MCP entries, runtime settings, and server settings. The architecture now says in-flight LLM turns keep the configuration they were admitted with, and future turns read the latest effective configuration at admission time.

The remaining design question is whether configuration changes should also emit runtime events for observability and audit.

### Option A: Configuration Changes Are Canonical-Service Events And Audit Records (Recommended)

Configuration changes are not supervisor workflow events, but they emit control-action audit records and projection freshness events. LLM admission reads the latest effective configuration when a new turn begins.

Benefits:

- Keeps supervisor machine focused on runtime lifecycle.
- Gives users/auditors a timeline of configuration changes.
- Avoids trying to mutate in-flight provider calls.

Costs:

- Runtime machines learn about configuration changes only at their next admission/read boundary.

### Option B: Configuration Changes Are Supervisor Events

Send `CONFIG_CHANGED` to the supervisor and let it fan out to runtime actors.

Benefits:

- Centralized awareness.
- Could support future live reconfiguration hooks.

Costs:

- Bloats supervisor responsibility.
- Risks turning the supervisor into a general workflow bus.
- Still cannot safely change already-admitted provider calls.

### Recommendation

Choose Option A. Treat configuration as canonical service state plus audit/projection events, not as supervisor workflow.

## 4. Should Child Activation Use Only `invoke`, Or Allow `spawn` With Manual Supervision?

### Context

`activate_card` is a synchronous logical barrier from the parent planner's perspective. The parent waits for exactly one child outcome: `done`, `failed`, or `blocked`.

XState offers two relevant actor ownership models:

- `invoke`: the parent enters a state that owns the child actor and receives completion/error automatically.
- `spawn`: the parent creates an actor reference and must manually supervise lifecycle, errors, cancellation, and outcome delivery.

### Option A: Use `invoke` For Child Activation (Recommended)

The parent goal machine invokes the child card actor while in `activating_child`.

Benefits:

- Directly models the activation barrier.
- Guarantees completion/error routing through the parent state.
- Avoids a manual supervision layer.
- Keeps cancellation and cleanup tied to the parent state.

Costs:

- Less flexible for detached child work, which the specification does not require.

### Option B: Allow `spawn` For Child Activation

The parent spawns a child and tracks it through actor references and custom events.

Benefits:

- More flexible if child work later needs to outlive the parent state.

Costs:

- Reintroduces manual lifecycle supervision.
- Makes exactly-one-outcome delivery harder to prove.
- Easier to create detached actor islands, which the architecture explicitly avoids.

### Recommendation

Choose Option A. Reserve `spawn` for process actors and other resources whose lifecycle can outlive one tool-call barrier.
