# F18: Planning Blockers Use Substring Matching for Error Classification

**Severity:** MEDIUM  
**Transversality:** LOCAL  
**Category:** Bad data representation  
**Verdict:** SOUND — confirmed at `src/runtime/planning-blockers.ts:26-38`

## Summary

`isReviewerCapacityPlannerBlocker` uses substring matching on error/status text to classify planner blockers. This is fragile — any text change in error message format, status strings, or error summary will silently break blocker classification.

## Corrected Evidence

- `src/runtime/planning-blockers.ts:26-38` — Matches `reviewer`, `report_goal_done`, `report goal done`, `reviewer invocation failed`, and capacity phrases
- `src/runtime/planning-blockers.ts:20-24` — Classification affects preservation logic
- `src/runtime/phases/planner-phase.ts:48-77` — Planner decisions depend on these classifications

## Clean Architecture Approach

Encode blocker cause as structured data on planner/reviewer results (e.g., `resume_reason: 'reviewer_unavailable'` plus a typed `blocker_cause`). Use string text only as display detail. Replace substring matching with discriminated-union pattern matching.