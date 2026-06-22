# F14: Frontend Stores Mix Multiple Domains With Shared Loading/Error State

**Severity:** MEDIUM  
**Transversality:** CROSS-CUTTING (frontend)  
**Category:** Tangled code  
**Verdict:** PARTLY SOUND — stores have more domain-specific state than the original finding claimed

## Summary

Three Pinia stores conflate unrelated domains with shared `loading`/`error` refs: `analystChat.ts` mixes session lifecycle, message sending, workspace routing, tool tracking, badges, and toasts; `debug.ts` shares one `loading`/`error` across state, errors, and timeline; `cards.ts` mixes browse, detail, and history.

## Corrected Evidence

- `web/src/stores/analystChat.ts:1-449` — Seven concerns, with direct `useWorkspaceRouteStore()` at line 294
- `web/src/stores/debug.ts:76-435` — Shares `loading`/`error` across 6+ domains
- `web/src/stores/cards.ts:51-339` — Browse + detail + history with shared loading

Overstatement corrected: `analystChat.ts` does have separate session/message/send states at lines 148-153, not one shared loading/error. `debug.ts` has separate process/doctor/supervision states at lines 96-132. Only the main `fetchAll()` loading/error is problematic. `cards.ts` does have separate history loading/error at lines 68-77.

## Clean Architecture Approach

Split by UI domain: `AnalystConversationStore` (session + message + send), `AnalystWorkspaceActions` (toasts, badges, card seeding), `DebugTimelineStore`, `DebugProcessStore`, `DebugOperatorStore`, `CardBrowseStore`, `CardDetailStore`, `CardHistoryStore`. Give each its own loading/error state.