# F22: Frontend Stale-Data Race Conditions on Rapid Navigation

**Severity:** MEDIUM  
**Transversality:** LOCAL (frontend)  
**Category:** Missing abstraction  
**Verdict:** PARTLY SOUND — core race condition is real but not all stores are affected equally

## Summary

Card detail and conversation fetches have no cancellation or sequence tracking. Rapid navigation can cause stale responses to overwrite current data. Some stores partially guard specific fetches, but the shared `loading`/`error` refs create UX conflicts.

## Corrected Evidence

- `web/src/stores/cards.ts:163-212` — `fetchCardDetail` has no cancellation guard
- `web/src/stores/agents.ts:60-80` — Shared loading/error for sessions and conversation
- `web/src/stores/debug.ts:191-240` — Shared loading/error for state/errors/timeline fetch

Overstatement corrected: `web/src/stores/agents.ts:87` does guard LLM exchange by `llmExchangeSessionId`, and `web/src/stores/cards.ts:68-77` has separate history loading/error. The core card detail/conversation race is still real.

## Clean Architecture Approach

Give each entity detail fetch an owned AbortController or request sequence token. Discard responses unless the token still matches the selected entity. Split list/detail/panel loading/error state where UX surfaces differ.