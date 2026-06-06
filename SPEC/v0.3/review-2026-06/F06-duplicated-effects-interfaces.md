# F06: Phase Effects Interfaces Share Overlapping Methods but Are Not Identical

**Severity:** MEDIUM  
**Transversality:** CROSS-CUTTING  
**Category:** Missing abstractions (partial)  
**Verdict:** PARTLY SOUND — overlap exists but interfaces differ in domain-specific methods

## Summary

Six effects interfaces across phase handler files share overlapping methods (`now`, `transitionCard`, `updateCard`, `emitRuntimeDiagnostic` or equivalents) but each also has unique domain-specific methods. The claim that all share the same methods is inaccurate.

## Corrected Evidence

Shared methods across most (but not all) interfaces:
- `src/runtime/phases/reviewer-invocation-failure.ts:4-12` — Has diagnostics but no `now`
- `src/runtime/phases/executor-invocation-failure.ts:4-14` — Has `now`, diagnostics, `appendError`
- `src/runtime/phases/executor-completion-handler.ts:6-14` — Has `now`, no diagnostics
- `src/runtime/phases/planner-invocation-failure.ts:31-41` — Has `now`, diagnostics
- `src/runtime/phases/reviewer-assessment-handler.ts:7-17` — Has update/diagnostics
- `src/runtime/startup-repair.ts:155-174` — Has `repairTerminalLifecycle`, not `updateCard`

Overstatement corrected: the interfaces are not identical. Only partial methods overlap. A single giant base interface would be wrong.

## Clean Architecture Approach

Extract small composable ports: `ClockEffects` (`now`), `CardTransitionEffects` (`transitionCard`), `CardPatchEffects` (`updateCard`), `RuntimeDiagnosticEffects` (`emitRuntimeDiagnostic`). Each phase composes only the ports it needs. Avoid one monolithic base interface.