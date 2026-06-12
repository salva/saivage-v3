# F11: RuntimeConfig and RuntimeAssembly are legacy interfaces not consumed by the XState runtime

## Summary

`RuntimeConfig` (runtime-config.ts:62-80) and `RuntimeAssembly` (runtime-config.ts:55-60) define legacy interface shapes including `AgentExecutionPort`, `StuckAgentSupervisor`, and `fakeAgentConfig`. These are from the old concrete runtime and are not consumed by the XState runtime. Meanwhile, the actual XState runtime uses `SupervisorRuntimeApiOptions` (supervisor-runtime-api.ts:25-36) and `XStateRuntimeApiFactoryDeps` (xstate-runtime-api-factory.ts:7-13), which have no reference to `RuntimeConfig` or `RuntimeAssembly`.

## Evidence

- `src/runtime/runtime-config.ts:55-60`: `RuntimeAssembly` defines `controls`, `coreParts`, `emitAgentEvent`, and an optional `testParts` property, none of which are used by the XState runtime.
- `src/runtime/runtime-config.ts:26-33`: `RuntimeCoreParts` with `subscribe`, `publishRuntimeLedgerEvent`, `emitAnalystToolInvoked`, `countGoals` -- these are concepts from the old runtime, not the XState runtime.
- `src/runtime/runtime-config.ts:35-41`: `RuntimeTestParts` references `StuckAgentSupervisor` from `stuck-agent-supervisor.ts` and `AgentExecutionPort` from contracts, neither of which is used by the actor runtime.
- `src/application/runtime-composition.ts:99`: The XState path uses `createXStateRuntimeApi` as the default factory, not `RuntimeConfig`.

## Category

Dead code / over-engineering

## Severity

2 -- these interfaces add confusion for readers and increase the maintenance surface, but have no runtime impact since they are not wired.

## Transversality

Local (runtime-config.ts)