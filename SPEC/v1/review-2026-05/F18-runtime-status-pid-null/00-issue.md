# F18 — `/api/runtime/status.pid` returns `null` even when the service is up

## Summary

`/api/runtime/status` exposes `runtime.pid` which is `null` both before and after a `systemctl restart` even though the systemd `MainPID` cycled `4983 → 5485`. The Debug → State UI widget therefore shows a misleading PID (compounding Phase-1 F05 which is independent). Either populate with the live systemd `MainPID` (preferred — the runtime is a single-process unit), document the field as "embedded child process PID, often null", or remove it.

## Evidence

- Phase-2 G4/T37: [tmp/saivage-v3-checkers-e2e-artifacts-20260523-phase2/G4-report.md](../../../../tmp/saivage-v3-checkers-e2e-artifacts-20260523-phase2/G4-report.md) §T37 (sub-finding F13 in that report's local numbering, renamed F18 in the aggregate).
- Owner code: [src/runtime/state.ts](../../../src/runtime/state.ts) (PID field), [src/server/server.ts](../../../src/server/server.ts) line 64 inline route `registerRuntimeDispatchRoutes` (the response assembler currently drops the field entirely when `activeRuntime` is available).

## Category

half-implemented / inconsistency (state field never populated by current path)

## Severity

P3 — observability only.

## Transversality

Local: one field on one response.
