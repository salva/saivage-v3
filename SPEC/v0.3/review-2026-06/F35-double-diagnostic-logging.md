# F35: Diagnostic Call-Site Duplication

**Severity:** LOW  
**Transversality:** CROSS-CUTTING  
**Category:** Duplication of concerns  
**Verdict:** PARTLY SOUND — call sites call two methods; log volume doubling is unverified

## Summary

Several dispatchers call both `deps.emitRuntimeDiagnostic(input)` and `deps.eventLogger.appendEvent({ kind: 'runtime_diagnostic', ... })` for the same diagnostic event. These represent two publishing responsibilities: event bus emission and durable logging.

## Corrected Evidence

- `src/runtime/runtime-planner-dispatcher.ts:68-75,100-107` — Both calls
- `src/runtime/executor-activation-dispatcher.ts:80-88,125-127` — Both calls

Overstatement corrected: `emitRuntimeDiagnostic` calls `RuntimeEventPublisher.emit`, which emits to the event bus. It does not itself append to `EventLogger`. The two calls serve different purposes (bus vs. durable log), but the split responsibility at the call site means callers must remember to call both.

## Clean Architecture Approach

One `publishRuntimeDiagnostic` method that owns both event-bus emission and durable logging. Callers provide one diagnostic object once. Remove the need for callers to know about both channels.