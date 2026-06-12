# F14: SupervisorRuntimeApi.getStatus computes status ambiguously from internal mode

## Summary

`SupervisorRuntimeApi.getStatus()` (supervisor-runtime-api.ts:157-166) derives status from `this.started` and `this.supervisor.mode` with a conditional that cannot represent `"stopping"`:

```typescript
const mode = this.started ? this.supervisor.mode : 'stopping';
return {
  status: mode === 'paused' ? 'paused' : this.started ? 'idle' : 'idle',
  paused: mode === 'paused',
  currentCardId: this.currentCardId,
  goalCount: this.currentCardId ? 1 : 0,
  lastTickAt: null,
};
```

The `status` field collapses 'running' and 'stopping' both to 'idle'. The `goalCount` is 0 or 1 instead of the actual number of goals. `lastTickAt` is always null.

## Evidence

- `src/runtime/actors/supervisor-runtime-api.ts:157-166`: The status computation as described above.
- `src/schemas/index.ts`: The `RuntimeStatus` schema likely supports more detailed statuses that cannot be represented here.

## Category

Bad assumption / half-implemented

## Severity

3 -- the operator UI and read models rely on `getStatus()` to present runtime state. The current implementation cannot distinguish between a running runtime and a stopped/failed one, and always reports `goalCount` as 0 or 1.

## Transversality

Cross-cutting (operator UI, read models)