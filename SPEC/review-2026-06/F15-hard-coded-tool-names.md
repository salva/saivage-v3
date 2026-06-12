# F15: TerminalCardRunnerController and GoalCardRunnerController hard-code tool names instead of using shared definitions

## Summary

The runner controllers check tool call results by comparing `output.toolName` against string literals (`'run_process'`, `'wait_process'`, `'inspect_process'`, `'kill_process'`, `'activate_card'`). The canonical tool definitions are in `actor-tool-definitions.ts` (`XSTATE_PLANNER_TOOL_DEFINITIONS`, `XSTATE_PROCESS_TOOL_DEFINITIONS`), but these are only used for LLM prompt generation. The execution-side dispatch uses raw string comparison.

## Evidence

- `src/runtime/actors/card-runner.ts:163-191`: `handleExecutorToolCall` uses `if (toolName === 'run_process')`, `if (toolName === 'wait_process')`, etc.
- `src/runtime/actors/goal-card-runner.ts:162`: `if (output.toolName !== 'activate_card')` -- hard-coded string.
- `src/runtime/actors/actor-tool-definitions.ts:4-7`: `XSTATE_PLANNER_TOOL_DEFINITIONS` and `XSTATE_PROCESS_TOOL_DEFINITIONS` define the same tool names.
- No shared constant or enum connects the two. Renaming a tool in definitions would silently break the dispatch.

## Category

Bad assumption / fragile coupling

## Severity

3 -- a tool name change in definitions without updating the dispatch strings would cause all tool calls to be rejected as "unsupported", with no type error to catch it.

## Transversality

Cross-cutting (card-runner.ts, goal-card-runner.ts, actor-tool-definitions.ts)