# F09: SupervisorRuntimeApi.getActivityStatus returns hardcoded idle

## Summary

`SupervisorRuntimeApi.getActivityStatus()` (supervisor-runtime-api.ts:168-170) always returns `{ status: 'idle', pending_calls: [], updated_at: this.now() }` regardless of what the runtime is actually doing. This is a stub that was likely intended to be replaced with real activity tracking but was never implemented.

## Evidence

- `src/runtime/actors/supervisor-runtime-api.ts:168-170`:
  ```typescript
  getActivityStatus(_sessionId: string): SessionActivity {
    return { status: 'idle', pending_calls: [], updated_at: this.now() };
  }
  ```
- The parameter `_sessionId` is prefixed with underscore, indicating it is unused.

## Category

Half-implemented

## Severity

4 -- the operator UI and read models depend on activity status to show users what the runtime is doing. Returning always-idle means the UI cannot display active planner/executor/reviewer sessions or pending tool calls, making the runtime appear permanently idle even during active execution.

## Transversality

Cross-cutting (affects operator UI, read models, and any status monitoring)
