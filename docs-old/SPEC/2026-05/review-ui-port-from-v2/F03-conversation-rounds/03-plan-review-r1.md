# F03 - Conversation rounds / diagnostics / pairing - Plan review (r1)

Reviewer r1 for [03-plan-r1.md](03-plan-r1.md), checked against the approved design [02-design-r3.md](02-design-r3.md), approved analysis [01-analysis-r2.md](01-analysis-r2.md), and the F04 chip adapter contract in [../F04-chat-surface-style/02-design-r2.md](../F04-chat-surface-style/02-design-r2.md).

## Findings

### 1. Blocking: backend stamp coverage is not complete across all current `AgentMessage` producers

The plan's backend shape is directionally right: Commit 1 adds `ActiveRuntime` round counters and activity state, Commit 2 widens `AgentMessage`, adds schema validation, removes the old `appendMessage` arity, stamps the main `agent-adapter.ts` producer paths, persists `tool_call_id: tc.id` on assistant `tool_call`, and rebuilds round state on resume.

However, it does not explicitly cover every append path required by the approved analysis. The approved analysis requires all shared `AgentMessage` producers to stamp `round_id` / `message_index` / `block_index`, including the analyst path. A quick producer audit shows current writers outside the plan's explicit Commit 2 scope:

- `src/agents/analyst-handler.ts` has a local `appendMessage(...)` helper that constructs `AgentMessage` directly and parses it through `agentMessageSchema`.
- `src/runtime/runtime.ts` appends planner resume context through the shared `appendMessage(...)`.
- `src/agents/analyst-stage6.ts` appends synthetic planner notes through the shared `appendMessage(...)`.
- `src/agents/fake-agent.ts` appends fixture `tool_call` records through the shared `appendMessage(...)`.
- `src/agents/session-persistence.ts` has helper paths such as stale-session failure and `appendActivateCardToolResultOnce(...)`.
- `src/agents/compaction.ts` manually constructs `AgentMessage` summary / truncation records and calls `replaceSessionMessages(...)`.

Why this blocks approval: once `AgentMessage` and `agentMessageSchema` require stamp fields, omitted producers either fail root typecheck, fail at runtime schema parse, or write records the conversation route can no longer read. The analyst-local helper is especially important because it bypasses the shared `session-persistence.ts` append signature, so the signature widening alone will not force the correct architecture.

Required plan change:

- Add an explicit producer-audit step to Commit 2, e.g. `rg "appendMessage\\(|AgentMessage =|agentMessageSchema.parse" src`, and require zero unstamped producers at the end of the commit.
- Either route the analyst writer through the shared persistence/round-stamping API, or give `AnalystHandler` an explicit `ActiveRuntime`-backed `SessionRoundState` contract per approved analysis §5.2.
- Add concrete stamping rules for runtime resume context, synthetic planner notes, fake-agent fixture appends, stale-session failure diagnostics, `appendActivateCardToolResultOnce(...)`, and compaction summary/truncation records.
- Make compaction manual records use `stampCompacted(...)` / `r-compacted-N` consistently, and define whether rewritten kept messages are restamped or preserved under the approved compaction contract.
- Add backend tests that fail if analyst messages, compaction records, runtime resume context, fake-agent appends, or helper-created tool results are missing the required stamp fields.

## Requested Axes

1. **Backend stamp commit completeness:** not yet complete. Counters, schema, persistence rewrite, activity state, and main adapter `tool_call_id` scalar are planned well, but the plan misses several existing producers. This is the only blocking issue.

2. **Wire response migration:** acceptable. Commit 3 migrates REST, WS, and web API types in one commit to `{ session, entries, activity_status }`, deletes `content.message`, and does not introduce an old/new dual envelope. The documented mid-stack web typecheck gap is acceptable for a single tip-green branch.

3. **Frontend commit order:** acceptable. The order is clean: pure timeline utility and composable first, SFC components next, `AnalystChatPanel` chip swap after `<ToolChip>` exists, then store/view deletion and rewire. That matches the dependency graph.

4. **Deletion of old `steps` / `groupIntoSteps` / `messages`:** acceptable at branch granularity. Commit 7 deletes `MessageStep`, `groupIntoSteps()`, `messages`, `steps`, and `expandedToolCalls`, rewrites `AgentConversationView`, and has branch-tip greps for residue. The old machinery exists during commits 3-6, but the plan is explicit that only the branch tip must be green.

5. **`AnalystChatPanel` chip swap:** included. Commit 6 creates `tool-chip-adapter.ts`, removes inline `.tool-chip*` markup, deletes `ChipParts`, deletes scoped chip styles, and binds paired plus pending calls through the shared `<ToolChip>` with the F04 eight-prop adapter contract.

6. **Tests:** mostly comprehensive. The plan carries the named design cases for parser, timeline, composable, store, chip DOM contract, pending footer, route shape, activity status, schema grammar, and `tool_call_id` scalar. After the backend-producer gap above is fixed, add named tests for the omitted append producers. The `grep ... | wc -l` count in Commit 8 is fine as a reviewer aid, but it should not be treated as proof that every named design case exists.

7. **Rollback:** realistic enough. A single merge revert plus redeploy is a workable rollback, and the caveat about compaction display after rollback is honest. The per-commit `git reset --hard` language should be understood as local branch-abort guidance only; shared integration rollback should stay revert-based.

## Recommendation

The plan is close. I would approve after the backend producer-audit and stamping coverage are made explicit, because the rest of the plan follows the approved architecture-first direction and avoids compatibility shims.

VERDICT: CHANGES_REQUESTED