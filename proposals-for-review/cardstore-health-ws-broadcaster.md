# WebSocket `runtime-state` broadcaster populating `cardStoreHealth`

Source: `architecture-audit/reports/cardstore-health-ws-broadcaster-opportunity.md`
(Phase A follow-up, archived in `old-documents/` after cleanup).

## Status

Deferred future opportunity. Not a regression and not on any active stage.

## Summary

Today, REST `GET /api/state` is the only populated source of the optional
`cardStoreHealth` envelope field. The WebSocket layer is contract-ready —
`runtime-state` envelopes accept the field
(`src/contracts/operator-events.ts:29-36`,
`src/server/websocket.ts:64-74`,
`web/src/stores/runtime.ts:212-221`) — and the runtime-owned `CardStore`
is reachable via `activeRuntime.runtime.cardStore.getHealth()`
(`src/runtime/runtime.ts:89-104`,
`src/server/routes/runtime-config-notes.ts:152-156`).

The missing piece is a precise broadcaster trigger and source-of-truth
rule: the current `wireRuntimeEvents()` path transforms runtime event-log
payloads, not `runtime-state` snapshots. Adding `cardStoreHealth` to the
WebSocket fanout requires either (a) a deliberately scoped new
`runtime-state` broadcast point that has `activeRuntime.runtime.cardStore`
in closure and calls read-only `getHealth()`, or (b) a connection-time
snapshot send on WS authentication.

## Why deferred

The current REST source is authoritative and stable; the WS extension is
a UX/latency improvement, not a correctness fix. The ARCH-028
implementation log explicitly recorded the no-server-synthesized-broadcaster
residual.

## What landing this would look like

- Add a single broadcast point (connection-time and/or periodic) that
  validates against `validateKnownWsEnvelope` and includes
  `cardStoreHealth` from the runtime-owned store.
- No contract change required.
- Add a focused test pinning the WS payload shape.
