# F02: XState machines are decorative -- state transitions are not the execution driver

## Summary

The XState machines (`goalCardRunnerMachine`, `terminalCardRunnerMachine`, `llmRunnerMachine`, `runtimeSupervisorMachine`) create actor state machines with `createMachine` and `createActor`, but the state transitions are not the primary execution drivers. The machines are used as state-recording side effects: each controller calls `this.actor.send(event)` after imperative operations and reads `this.actor.getSnapshot()` for status queries. The actual flow is controlled by imperative `for` loops and `await` chains in the controller classes.

## Evidence

- `src/runtime/actors/goal-card-runner.ts:134-204`: `start()` is a `for` loop calling `this.plannerRunner.runTurn()` and `this.reviewPlannerResult()` imperatively. State transitions happen via `this.actor.send({ type: 'REVIEW_READY' })` as side effects (line 268), not via XState event handlers driving transitions.
- `src/runtime/actors/card-runner.ts:95-148`: Same pattern -- `for` loop with imperative `await this.llmRunner.runTurn()`, then `this.actor.send({ type: 'TERMINAL_OUTCOME', outcome })` as a post-hoc recording.
- `src/runtime/actors/llm-runner.ts:125-155`: `runTurn()` sends `RUN_TURN` event, then imperatively awaits `this.providerTurn.completeTurn(input)`, then sends `PROVIDER_RESULT` or `PROVIDER_ERROR`. The machine's states (`done`, `running`) are queried by `.state` getter but never drive logic.
- `src/runtime/actors/runtime-supervisor.ts:66-133`: The supervisor machine *is* used to gate admission (`requestProviderCall` checks `.work !== 'ready'`), making it the one machine with genuine behavioral effect. But even here, the `requestProviderCall` method sends an event and immediately returns `true` without waiting for the transition to complete.

## Category

Architectural / bad abstraction

## Severity

4 -- The XState dependency adds complexity (import cost, learning curve, snapshot serialization for state that could be a plain object) without delivering the benefit of declarative state machines. The code would be simpler and more honest with plain state objects.

## Transversality

Cross-cutting (actors/ directory, 5+ files)