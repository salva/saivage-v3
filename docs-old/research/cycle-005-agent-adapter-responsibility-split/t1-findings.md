# Research findings — Wave 005 AgentAdapter split

Date: 2026-05-27  
Task: `t1-scope-and-proposals`

## Executive summary

Wave 005 is still current. `AgentAdapter` is 638 lines and remains responsible for provider/model routing, session lifecycle, cancellation, handoff summaries, tool catalogs, tool dispatch, MCP/skill/workspace/planner-control handling, recovery, compaction, LLM calls, parser fallback, recorder caches, and final session completion.

The best bounded implementation is a direct split into:

- `AgentSessionCoordinator`
- `AgentToolExecutor` / `AgentToolCatalog`
- `AgentRoleRunner` / optional `AgentLlmGateway`

`AgentAdapter` should remain as a thin `AgentExecutionPort` facade. A bigger application-layer restructure is plausible but should probably be deferred because it overlaps Wave 006 MCP and Wave 007 LLM provider-gateway work.

## Key evidence

- Mailbox contains no live proposal: only `README.md`, `done/`, and `rejected/`.
- Current dirty diff is broad and unrelated in places; implementation must stage only Wave 005 files.
- `AgentAdapter` imports broad concerns at `src/agents/agent-adapter.ts:1-37` and constructs `ToolRuntime`/`PlannerControlExecutor` at `src/agents/agent-adapter.ts:182-205`.
- Tool catalog/policy/dispatch remains in `AgentAdapter` at `src/agents/agent-adapter.ts:49-154` and `src/agents/agent-adapter.ts:290-345`.
- Session/cancellation/handoff lifecycle remains in `AgentAdapter` at `src/agents/agent-adapter.ts:266-287` and `src/agents/agent-adapter.ts:459-467`.
- LLM/recovery/tool-loop orchestration remains in `AgentAdapter` at `src/agents/agent-adapter.ts:369-597`.
- LLM client/recorder gateway creation remains in `AgentAdapter` at `src/agents/agent-adapter.ts:620-634`.
- `RoleToolPolicy` already exists and can support extraction: `src/agents/role-tool-policy.ts:39-210`.
- `PlannerControlExecutor` already exists and should be injected into a new tool executor: `src/agents/planner-control-executor.ts:53-182`.
- Focused tests exist for policy/planner control, but many tests still instantiate `AgentAdapter` for extracted sub-concerns.

## Artifacts written

- `architecture-audit/cycle-005-agent-adapter-responsibility-split/scope-check.md`
- `architecture-audit/cycle-005-agent-adapter-responsibility-split/proposals/proposal-direct.md`
- `architecture-audit/cycle-005-agent-adapter-responsibility-split/proposals/proposal-restructure.md`

## Source citations

All citations are local source paths/line numbers from the active tree as required by this architecture audit. No web research was needed.
