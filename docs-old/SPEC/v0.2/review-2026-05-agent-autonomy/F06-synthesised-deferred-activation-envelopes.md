# F06 — Runtime fabricates planner envelopes from deferred `activate_card` calls

## Summary

When the planner's only non-terminal tool call in a turn is `activate_card`
and the planner-control executor returns a `deferred` envelope, the adapter
silently fabricates a `PlannerResult` envelope of its own (`status:'continue'`
or `status:'blocked'`) and exits the turn loop. The planner never authored
that envelope, never saw it, and never gets to refine it. The synthesis logic
also re-reads the card store to compute dependency-blocked reasons, mixing
card semantics into the generic per-turn loop.

## Evidence

- [agent-adapter.ts#L350](src/agents/agent-adapter.ts#L350) — synthesis
  branch:

  ```ts
  if (toolMessages.length === 0 && deferredActivations.length > 0) {
    ...
    if (blockingReasons.length > 0) {
      finalEnvelope = { status: 'blocked', blocked_reason, summary, ... };
      ...; break;
    }
    finalEnvelope = { status: 'continue', summary: synthSummary,
                      created_cards: [], updated_cards: [] };
    ...; break;
  }
  ```

- [planner-control-executor.ts#L130](src/agents/planner-control-executor.ts#L130)
  — `activate_card` returns the `deferred` envelope the adapter then keys on:

  ```ts
  result = { success: true, activation,
             deferred: createDeferredActivationEnvelope({ ... }) };
  ```

- [schemas/index.ts via parseDeferredActivationEnvelope](src/agents/agent-adapter.ts#L31)
  — the parser the adapter uses to recognise this case at runtime.

## Category

half-implemented

## Severity

high

## Transversality

cross-cutting

## Why this matters for the redesign

This synthesis only exists because the agent has no clean "done, awaiting
child" signal (see F03). In the verifier model the planner should be able to
say "I am done with this turn, awaiting child activation"; the runtime should
verify that against the contract instead of inventing the envelope behind the
planner's back. Removing this branch is also a prerequisite to ungroaning the
adapter — it currently has CardStore reads, dependency walks, and synthetic
`model_issue` rows woven into the LLM turn loop.
