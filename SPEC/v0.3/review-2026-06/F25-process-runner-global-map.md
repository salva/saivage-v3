# F25: ProcessRunner Module-Level Global Map and Class-Function Indirection

**Severity:** MEDIUM  
**Transversality:** LOCAL  
**Category:** Bad data representation  
**Verdict:** PARTLY SOUND — global map exists but has disposal; class-function indirection adds no value

## Summary

`ProcessRunnerService` delegates every method to module-level `*ForService` functions, adding no encapsulation value. A module-level `processRunnerServicesByRoot` Map tracks all process runners and has disposal, but leak risk remains if lifecycle disposal is skipped.

## Corrected Evidence

- `src/runtime/process-runner.ts:76-127` — Class methods that delegate to module functions
- `src/runtime/process-runner.ts:129` — Module-level `processRunnerServicesByRoot` Map
- `src/runtime/process-runner.ts:1081-1085` — Map entry deleted during `disposeProcessRuntimeScope`

Overstatement corrected: disposal does exist at line 1081-1085. The risk is only if disposal is skipped. Creating a new `EventLogger` per reconciliation audit (lines 780-813) is still wasteful.

## Clean Architecture Approach

Make process runner an explicitly composed, runtime-owned service. Remove module singleton access except at outer compatibility boundaries. Inject event loggers instead of constructing new ones per call. Convert stateless class methods to plain functions or merge the class with its module functions.