# F19: Frontend Sync System Has 3-Layer Redundancy

**Severity:** MEDIUM  
**Transversality:** LOCAL (frontend)  
**Category:** Over-engineering  
**Verdict:** PARTLY SOUND — three layers exist; claimed reactivity gap is mostly mitigated

## Summary

The WebSocket pipeline has three layers: `WsConnectionManager` (websocket.ts), `SyncClient` class (sync/client.ts), and `useSyncStore` (stores/sync.ts). The Pinia store is a 31-line pass-through. The concern was that `WsConnectionManager` uses a bespoke `makeRef` pattern instead of Vue reactivity, creating a gap.

## Corrected Evidence

- `web/src/api/websocket.ts:76-78` — Custom ref pattern
- `web/src/sync/client.ts:24-151` — SyncClient singleton
- `web/src/stores/sync.ts:5-31` — Pinia pass-through

Overstatement corrected: `SyncClient` copies connection state into real Vue refs at `web/src/sync/client.ts:31-44` and updates them through `conn.onState` at `web/src/sync/client.ts:50-54`. The reactivity gap is mostly mitigated by the manual ref copy. Adding a new sync message type may affect transport and client, but not necessarily the Pinia store.

## Clean Architecture Approach

Flatten to two layers: a Pinia sync store that directly wraps the WebSocket manager using Vue `ref()`. Remove the `SyncClient` class and its module-level singleton. Let the store own Vue reactivity and lifecycle directly.