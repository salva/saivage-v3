# F17: Multiple Utility Duplications (now, valuesEqual, Redaction)

**Severity:** MEDIUM  
**Transversality:** CROSS-CUTTING  
**Category:** Duplication of concerns  
**Verdict:** PARTLY SOUND — `now()` and `valuesEqual` duplication is real; redaction partly shares underlying module

## Summary

Several small utility functions are independently defined in multiple files rather than shared from a common module. The `now()` function (ISO timestamp) is defined in 7+ places. `valuesEqual` is defined in 2 places. Secret redaction has multiple entry points but partly shares a common underlying module.

## Corrected Evidence

`now()` duplication:
- `src/runtime/runtime.ts:24-26`, `src/runtime/runtime-startup.ts:27-29`, `src/runtime/activation-repair.ts:15-17`, `src/runtime/synthetic-planner-notes.ts:24`, `src/cards/artifacts.ts:9-11`, `src/cards/card-store.ts:96-98`, `src/agents/analyst-handler.ts:81`

`valuesEqual` duplication:
- `src/cards/card-store.ts:104-106`, `src/cards/lifecycle.ts:105-107`

Redaction paths:
- `src/agents/invocation-recovery-policy.ts:45-67` — Own regex list
- `src/agents/analyst-sanitization.ts:27-68` — Calls `redactTextForOutbound`
- `src/agents/llm-errors.ts:6-8` — Calls `redactTextForOutbound`

Overstatement corrected: `analyst-sanitization.ts` and `llm-errors.ts` both already use the shared `redactTextForOutbound` function. Only `invocation-recovery-policy.ts` has its own independent regex list. `now()` duplication is low severity but wastes cognitive space.

## Clean Architecture Approach

Add small shared primitives only where they clarify architecture: one runtime clock helper (or injected clock for testability), one `valuesEqual` for card mutation comparison, and one redaction policy entry point with context-specific profiles. Do not create a general "utils" catch-all.