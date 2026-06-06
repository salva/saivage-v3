# F01: AgentAdapter invokeAgent Is a 610-Line Method With Too Many Seams

**Severity:** HIGH  
**Transversality:** CROSS-CUTTING  
**Category:** Tangled responsibilities  
**Verdict:** SOUND — code confirmed at `src/agents/agent-adapter.ts:712-1321`

## Summary

`AgentAdapter.invokeAgent` (lines 712-1321) handles candidate resolution, session creation, LLM candidate iteration, tool call dispatch coordination, contract verification feedback, recovery/retry loop, event emission, and session finalization in one method. The adapter also holds planner-specific compaction and report-envelope synthesis that belong in a planner-specific module.

## Corrected Evidence

- `src/agents/agent-adapter.ts:712-1321` — 610-line `invokeAgent` method
- `src/agents/agent-adapter.ts:174-258` — Planner-specific compaction in the generic adapter
- `src/agents/agent-adapter.ts:124-155` — Planner-specific report-envelope synthesis
- `src/agents/agent-adapter.ts:388-410` — Setter injection (`setLlmCallFn`, `setContentSupervisor`, `setMcpManager`, `setSkillsEngine`, `setAfterSessionCreatedHook`)

Overstatement corrected: tool call dispatch is partly delegated to `AgentToolExecutor`, loop driving to `AgentLoopDriver`, and gateway to `AgentLlmInvocationGateway`. The method orchestrates rather than implements every detail, but it still owns too many seams.

## Clean Architecture Approach

Split `invokeAgent` around actual seams into focused modules: `AgentInvocationRunner` (outer recovery/candidate loop), `AgentSessionLifecycle` (session creation/status transitions), `AttemptRecorder` (event recording), and move planner-only context/terminal-envelope handling to a planner module. Keep `AgentAdapter` as a thin facade wiring these together.