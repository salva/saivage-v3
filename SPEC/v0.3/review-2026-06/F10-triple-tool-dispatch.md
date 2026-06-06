# F10: Tool Dispatch Duplicated Across Three Paths With Diverging Semantics

**Severity:** HIGH  
**Transversality:** ARCHITECTURAL  
**Category:** Duplication of concerns / Missing abstraction  
**Verdict:** PARTLY SOUND — duplication is real but planner-control tools have genuine domain-specific semantics

## Summary

Tool dispatch is implemented three times: (1) `AgentToolExecutor.processToolCall` dispatches across tool categories, (2) `AnalystHandler.runAnalystLoop` has its own tool registry and execution, and (3) `PlannerControlExecutor` handles planner-specific tools inline. The first two duplicate parsing, result formatting, and error handling; the third has stateful domain-specific semantics that should not be flattened.

## Corrected Evidence

- `src/agents/agent-tool-executor.ts:94-147` — 53-line if/else chain dispatch
- `src/agents/analyst-handler.ts:329-360` — Own TOOL_REGISTRY lookup, tool call persistence, result formatting, truncation
- `src/agents/planner-control-executor.ts:95-260` — Planner-specific switch with domain-specific side effects

Overstatement corrected: analyst tools are built from canonical `TOOL_DEFINITIONS` (not entirely ad hoc). Planner-control tools are stateful domain commands (activate_card, cancel_card, etc.) and should not be treated as generic tool dispatch. The duplication is in envelope formatting, result truncation, persistence, and error handling — not in domain logic.

## Clean Architecture Approach

Introduce a `ToolDispatcher` that owns parsing, policy check, result envelope construction, truncation, persistence hooks, and error formatting. Register adapters per tool category: runtime, planner-control, MCP, skill, workspace, analyst. Planner-control keeps its domain-specific handler but delegates envelope/transport concerns to the dispatcher.