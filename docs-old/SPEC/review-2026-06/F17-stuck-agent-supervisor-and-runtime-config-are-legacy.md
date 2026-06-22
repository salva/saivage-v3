# F17: StuckAgentSupervisor and RuntimeConfig reference old runtime patterns

## Summary

`stuck-agent-supervisor.ts` (571 lines) and `runtime-config.ts` (80 lines) define interfaces and a class that reference `AgentExecutionPort`, `RuntimeAssembly`, `RuntimeTestParts`, and `fakeAgentConfig` -- all concepts from the old concrete runtime. The `StuckAgentSupervisor` is a complex background detection module that depends on `current-run.ts` and `runtime-lifecycle-state.ts`, neither of which are used by the XState actor runtime.

## Evidence

- `src/runtime/stuck-agent-supervisor.ts` depends on `current-run.ts` and `runtime-lifecycle-state.ts` which derive state from the old `runtime.json` persistence model, not from XState actor state.
- `src/runtime/runtime-config.ts:6`: imports `StuckAgentSupervisor` -- a dependency from the old runtime.
- `src/runtime/runtime-config.ts:1`: imports `AgentExecutionPort`, `RuntimeActivationLedgerPort` -- old runtime concepts.
- `src/application/runtime-composition.ts`: does not import `StuckAgentSupervisor` or `RuntimeConfig`.

## Category

Dead code / legacy coupling

## Severity

2 -- these modules exist but are not wired in the XState runtime path. They add confusion and increase the size of the runtime module surface without being functional.

## Transversality

Local (stuck-agent-supervisor.ts, runtime-config.ts)