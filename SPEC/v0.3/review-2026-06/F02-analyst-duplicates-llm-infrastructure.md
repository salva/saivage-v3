# F02: Analyst Path Duplicates LLM Orchestration (Not Full Transport Stack)

**Severity:** HIGH  
**Transversality:** ARCHITECTURAL  
**Category:** Duplication of concerns  
**Verdict:** PARTLY SOUND — orchestration/session/tool-loop duplication is real; transport stack is shared

## Summary

The analyst path (`analyst-llm-resolver.ts` + `analyst-handler.ts`) independently implements LLM candidate iteration with recovery, session read/write, tool dispatch, and result formatting. It does reuse `LlmProviderGateway`, `resolveLlmTransportConfig`, `buildLlmOptions`, and `createLlmExchangeRecorder` from the shared stack. The duplication is in orchestration policy, session management, and tool-loop control — not in the entire transport layer.

## Corrected Evidence

- `src/agents/analyst-llm-resolver.ts:100-223` — Own candidate iteration with recovery, duplicating `AgentAdapter.invokeAgent` orchestration
- `src/agents/analyst-handler.ts:119-140` — Private read/write session methods instead of using `session-persistence.ts`
- `src/agents/analyst-handler.ts:272-368` — Own tool dispatch loop with `TOOL_REGISTRY` lookup and `findRecentDuplicateResponse` dedup
- `src/agents/analyst-handler.ts:358` — Magic number truncation (16,000 chars)

Overstatement corrected: `analyst-llm-resolver.ts:4` and `:145-158` reuse `LlmProviderGateway`, `resolveLlmTransportConfig`, `buildLlmOptions`, and `createLlmExchangeRecorder`. The duplicated layer is orchestration/session/tool-loop policy, not HTTP transport.

## Clean Architecture Approach

Introduce one invocation service that accepts role, prompt, message sink/source, candidate policy, tool dispatcher, and recovery policy. The analyst plugs in analyst-specific prompt, tool set, and session handling. Eliminate the analyst-specific LLM resolver entirely. The shared service owns candidate iteration, recovery, recording, and turn loop.