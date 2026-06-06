# F32: Agent Loop Has No Per-Iteration Timeout

**Severity:** LOW  
**Transversality:** LOCAL  
**Category:** Missing abstraction  
**Verdict:** PARTLY SOUND — no per-iteration timeout exists; cancellation plumbing partially exists

## Summary

`runPlannerLoop` iterates up to `MAX_PLANNER_ITERATIONS = 50` with no per-iteration timeout. A stuck planner invocation blocks the dispatch loop indefinitely. `RepairBudget` uses a mutable `consumed` field passed by reference.

## Corrected Evidence

- `src/runtime/runtime-planner-dispatcher.ts:15` — Hardcoded `MAX_PLANNER_ITERATIONS = 50`
- `src/runtime/runtime-planner-dispatcher.ts:80-87` — No timeout wrapping per iteration
- `src/agents/invocation-outcome.ts:4-7` — Mutable `RepairBudget.consumed`

Overstatement corrected: agent invocation does create an `AbortController` at `src/agents/agent-adapter.ts:836-858`, so cancellation plumbing exists. There is just no per-iteration deadline that aborts it. The stuck-iteration risk is real but bounded by the outer LLM call timeout at the provider level.

## Clean Architecture Approach

Pass an iteration deadline/abort signal from runtime into the planner phase. Wrap each iteration with a timeout. Model repair budget as returned state rather than shared mutable input.