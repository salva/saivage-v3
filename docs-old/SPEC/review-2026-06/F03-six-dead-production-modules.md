# F03: Six dead production modules with zero importers

## Summary

Six production modules under `src/runtime/` have zero production importers (not imported by any other module in `src/`, only used by tests or not used at all):

1. `agent-runtime-factory.ts` (53 lines) -- not imported anywhere in production or tests.
2. `candidate-availability-store.ts` (202 lines) -- re-exports `FsCandidateAvailability` from `src/agents/candidate-availability-store.ts` but nobody imports from the runtime copy. The agents copy at `src/agents/candidate-availability-store.ts` is the one used by `runtime-composition.ts`.
3. `crash-recovery.ts` (57 lines) -- not imported anywhere. The `runtime-config.ts` declares a `performCrashRecovery()` interface method but there is no connection to this implementation.
4. `persisted-planner-history.ts` (88 lines) -- not imported anywhere.
5. `runtime-diagnostics.ts` (37 lines) -- not imported anywhere. `runtime-config.ts` declares a `RuntimeDiagnosticsObserver` type that matches its interface but the factory function is never called.
6. `session-persistence-port.ts` (40 lines) -- not imported anywhere.

## Evidence

- Dependency analysis shows zero production importers for all six modules.
- `src/runtime/candidate-availability-store.ts` is a near-duplicate of `src/agents/candidate-availability-store.ts`. The runtime version adds an FsCandidateAvailability class while the agents version already has its own MemoryCandidateAvailability.

## Category

Dead code

## Severity

3 -- dead code increases maintenance burden and confuses readers, but has no runtime impact.

## Transversality

Local (individual modules)