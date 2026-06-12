# F23: Three Compaction Approaches With No Shared Strategy

**Severity:** MEDIUM  
**Transversality:** CROSS-CUTTING  
**Category:** Duplication of concerns  
**Verdict:** PARTLY SOUND — three approaches exist but analyst boundary cleanup is not full compaction

## Summary

Context compaction has three implementations: (1) `compaction.ts` with session-level compaction and in-memory state tracking, (2) `agent-adapter.ts` with planner-specific in-memory history compaction, and (3) `analyst-handler.ts` with tool-boundary trimming. The `compaction.ts` module-level `compactionStates` Map has a potential race on concurrent async calls for the same session.

## Corrected Evidence

- `src/agents/compaction.ts:55-64` — Module-level `compactionStates` Map
- `src/agents/compaction.ts:94-202` — Session compaction with message trimming
- `src/agents/agent-adapter.ts:174-258` — Planner-specific compaction outside compaction module
- `src/agents/analyst-handler.ts:88-117` — Tool-boundary trimming (not full compaction with budget tracking)
- `src/agents/compaction.ts:249-266` — `trimLeadingOrphanToolRows` duplicates analyst tool-boundary concept

Overstatement corrected: the analyst code is boundary cleanup, not full compaction with budget tracking. The `compactionStates` Map race is not a thread issue in Node's single-threaded model, but interleaved async calls for the same session can see stale `state.count` decisions.

## Clean Architecture Approach

One `ContextCompactor` service with per-session serialization and configurable policy inputs for planner/analyst/session modes. Keep boundary trimming as a shared pure helper used by all modes. Remove in-memory global state — make compaction state per-session and managed by the session lifecycle.