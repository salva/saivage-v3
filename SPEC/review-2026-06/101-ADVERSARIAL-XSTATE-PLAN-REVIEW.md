# Adversarial XState Plan Review

Status: adversarial review performed after the plan was updated to make XState central and controller classes deletion-default.

## Verdict

APPROVE WITH CHANGES.

The plan is directionally correct but needed tighter wording to prevent three escape hatches:

1. The `RuntimeApi` adapter could keep orchestration by constructing and awaiting runner/controller implementations.
2. Cancellation/quiescence could slip from P0 into a later polish phase, allowing a fake load-bearing XState pass.
3. `ChildActivationPort.startChild()` could preserve imperative child dispatch under a new name.

## Accepted Changes

The consolidated plan now includes these requirements:

1. A retained external adapter may only construct the top-level actor system, send commands to the supervisor actor, subscribe/wait for supervisor snapshots, and project read-model state.
2. The adapter must not import, instantiate, or call card, LLM, reviewer, child-activation, or process runner implementations.
3. Runtime behavior may advance only through XState actor events, invocations, spawned children, and machine transitions.
4. P0 is not complete unless `stopProject()` and `shutdown()` can cancel active provider calls, reviewer calls, child activations, and process waits through supervisor-to-child XState events and observe bounded quiescence.
5. `activate_card` must not call a `ChildActivationPort.startChild()` Promise API. Child activation must be actor spawn/invocation owned by the goal/supervisor actor tree.
6. `getActivityStatus()` must project from actor snapshots/read models, not from `LlmRunnerController`.
7. P0 machine states must each have an explicit recovery classification before implementation.
8. The `llmTurnMachine` must fail fast on unsupported multiple-tool-call provider output rather than silently selecting the first call.
9. Machine states should represent durable wait points, cancellation boundaries, recovery boundaries, or externally meaningful lifecycle phases, not every synchronous function call.
10. Boundary tests should prevent `supervisor-runtime-api.ts` from importing orchestration runner modules.

## Remaining Watchpoints

1. During implementation, reject any patch that keeps `runner.start()`, `runTurn()`, `startChild()`, or process `wait()` as the path that advances runtime behavior.
2. Reject any new `*Controller` production class unless it is only an adapter around actor creation/event sending/projection.
3. Require direct machine tests before preserving public facade tests.
