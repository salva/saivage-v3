# F16: Over-Decomposed File Structure With Many Re-export Barrels

**Severity:** MEDIUM  
**Transversality:** CROSS-CUTTING  
**Category:** Over-engineering  
**Verdict:** PARTLY SOUND — some re-exports add boundary value; pure wrappers should go

## Summary

The agents module has 58 files, many of which are 1-10 line re-export barrels or single-function files that add import depth without cohesion. Several runtime "runner" classes are stateless and could be plain functions.

## Corrected Evidence

Pure re-exports with no value:
- `src/agents/llm-errors.ts` — 8 lines, re-exports from `llm-failure.ts` plus one function
- `src/agents/default-agent-execution.ts`, `fake-agent.ts`, `system-prompt.ts` — One-line re-exports
- `src/agents/session-persistence.ts` — Single-line re-export from `../runtime/session-persistence.js`
- `src/agents/tool-api.ts` — Barrel over 4 modules
- `src/agents/agent-tool-catalog.ts` — Static-only class wrapping imported map lookups

Overstatement corrected: `src/agents/llm-errors.ts` centralizes provider diagnostic redaction via `redactTextForOutbound`. Stateless runner classes like `PlannerIterationRunner` and `PlannerActivationRunner` are dependency bundles with behavior, not just empty wrappers.

## Clean Architecture Approach

Delete or inline pure compatibility barrels and single-use wrappers first. Keep phase runner modules if they represent cohesive runtime steps. Prefer functions when a class only stores constructor deps and exposes one method. Do not create new abstractions just to move files around — delete indirection that adds nothing.