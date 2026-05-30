# F10 — `AgentAdapter` owns envelope projection, status mapping, and session lifecycle in one method

## Summary

`AgentAdapter.invokeAgent` is the single ~250-line method that runs the
candidate chain, the tool loop, the recovery accounting, the envelope
projection (`parseEnvelope` callbacks), and the session-lifecycle bookkeeping
that decides whether the session is `waiting`, `blocked`, `failed`, or `done`
based on the typed result's `status` field. The status mapping is hardcoded
for planner / executor and silent for reviewer, and is wired into the same
function that handles transport failures. The three `envelopeTo*Result`
adapters are also defined at module top level, so the runtime cannot accept
an envelope from any caller that did not register a `parseEnvelope` of the
right shape.

## Evidence

- [agent-adapter.ts#L483](src/agents/agent-adapter.ts#L483) — status-driven
  session lifecycle baked into the invoke method:

  ```ts
  if (role === 'planner' && resultStatus === 'continue') markSessionWaiting(...);
  else if (role === 'planner' && resultStatus === 'blocked') completeSession(..., 'blocked');
  else if (role === 'executor' && resultStatus === 'failed') completeSession(..., 'failed');
  else completeSession(..., 'done');
  ```

- [agent-adapter.ts#L49](src/agents/agent-adapter.ts#L49) — three
  envelope-to-result projections hard-coded at module scope:

  ```ts
  function envelopeToPlannerResult(envelope: Record<string, unknown>): PlannerResult { ... }
  function envelopeToExecutorResult(envelope: Record<string, unknown>): ExecutorResult { ... }
  function envelopeToReviewerResult(envelope: Record<string, unknown>): ReviewerResult { ... }
  ```

- [agent-adapter.ts#L463](src/agents/agent-adapter.ts#L463) — the same method
  also builds the `llm_invocation_summary` event and the verdict
  (`succeeded` / `exhausted` / `cancelled`).

## Category

bad-design

## Severity

medium

## Transversality

cross-cutting

## Why this matters for the redesign

A contract verifier wants to be passed `{ contract, project, ... }` and
return a typed result; the surrounding flow should decide what to do with
that result (mark session waiting, complete it, etc.). Splitting the typed
projection and the lifecycle mapping out of `invokeAgent` is necessary to
keep the new loop small enough to reason about, and to stop pinning the
runtime to the planner/executor/reviewer trio (see F05).
