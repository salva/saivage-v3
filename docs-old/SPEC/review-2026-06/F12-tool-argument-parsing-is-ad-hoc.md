# F12: Tool argument parsing in card-runner.ts and goal-card-runner.ts uses ad-hoc type casts with throw

## Summary

Both `TerminalCardRunnerController` and `GoalCardRunnerController` parse tool call arguments by casting `args: unknown` to `Record<string, unknown>` with manual type checks and `throw new Error(...)`. This splits parsing logic across the controller classes rather than centralizing it, and the parse functions are private helpers that duplicate validation patterns.

## Evidence

- `src/runtime/actors/card-runner.ts:234-265`: `parseProcessStartArgs`, `parseProcessWaitArgs`, `parseProcessIdArgs`, `parseTimeoutMs` -- four private parse functions, each doing manual `typeof` checks and `throw new Error`.
- `src/runtime/actors/goal-card-runner.ts:306-310`: `parseActivateCardArgs` -- same pattern.
- The XState runtime has `actor-tool-definitions.ts` with tool schemas, but these schemas are not used for parsing/validating the args coming back from the LLM. The schemas and the parsing are entirely disconnected.

## Category

Bad abstraction / code duplication

## Severity

2 -- functionally correct but duplicates validation logic, bypasses the existing schema infrastructure, and makes it harder to add new tools.

## Transversality

Local (card-runner.ts, goal-card-runner.ts)