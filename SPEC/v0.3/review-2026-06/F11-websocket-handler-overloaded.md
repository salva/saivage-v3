# F11: WebSocket Handler Overloaded With Multiple Concerns

**Severity:** MEDIUM  
**Transversality:** LOCAL  
**Category:** Tangled code  
**Verdict:** SOUND — confirmed at `src/server/websocket.ts:89-231`

## Summary

`registerWebSocket` is a 142-line function handling authentication, LiveSync membership, analyst session creation, turn queuing, both LiveSync and analyst message handling, and manual tool-result serialization with ad-hoc type assertions.

## Corrected Evidence

- `src/server/websocket.ts:89-231` — Single function with 5 parameters and two signature overloads
- `src/server/websocket.ts:121-215` — One `on('message')` handler for LiveSync and analyst events
- `src/server/websocket.ts:173-199` — Ad-hoc tool result projection with `as unknown as Record<string, unknown>` casts

## Clean Architecture Approach

Split transport from domain: `registerWebSocket` authenticates, attaches lifecycle handlers, and delegates frames. LiveSync frame handling, analyst inbound handling, and tool-activity projection each become small modules. Tool result projection should use a typed schema, not ad-hoc key extraction.