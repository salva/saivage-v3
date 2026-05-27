# Wave 007 LLM transport/provider gateway research note

Date: 2026-05-27  
Task: `t1-scope-and-proposals`  
Cycle: `architecture-audit/cycle-007-llm-transport-provider-gateway/`

## Executive summary

- Mailbox preemption check passed: `proposals-for-review/` contains only `README.md`, `done/`, and `rejected/`; the live proposal set is empty.
- Wave 007 premises still hold. `src/agents/llm-client.ts` remains the central LLM monolith: it owns exported tool-call contracts, provider-specific request payloads, URL/header quirks, HTTP fetch, streaming parsers, error taxonomy, redaction, and exchange-recorder calls (`src/agents/llm-client.ts:24`, `src/agents/llm-client.ts:89`, `src/agents/llm-client.ts:219`, `src/agents/llm-client.ts:286`, `src/agents/llm-client.ts:317`, `src/agents/llm-client.ts:525`, `src/agents/llm-client.ts:818`, `src/agents/llm-client.ts:952`, `src/agents/llm-client.ts:972`, `src/agents/llm-client.ts:1011`).
- Wave 005 already introduced an agent-side `AgentLlmInvocationGateway`, but it is still a thin cache/recorder adapter over the monolithic `LlmClient` and imports `LlmCallFn` from `agent-adapter`, preserving an awkward back-edge (`src/agents/agent-llm-gateway.ts:3`, `src/agents/agent-llm-gateway.ts:7`, `src/agents/agent-llm-gateway.ts:48`).
- Analyst chat is a second direct LLM consumer that must be included in scope. It constructs/caches `LlmClient`, resolves transport config, creates exchange recorders, and catches `Llm*Error` classes itself (`src/agents/analyst-llm-resolver.ts:3`, `src/agents/analyst-llm-resolver.ts:135`, `src/agents/analyst-llm-resolver.ts:167`, `src/agents/analyst-llm-resolver.ts:175`, `src/agents/analyst-llm-resolver.ts:192`).
- Current working tree already has unrelated/pre-existing modifications in Wave 007 files, especially removal of the Codex `max_output_tokens` retry path and corresponding test changes. The implementation worker must treat those as current baseline and avoid reverting them unless the approved proposal explicitly says so.

## Evidence consulted

Stable command logs:

- `architecture-audit/cycle-007-llm-transport-provider-gateway/logs/t1-current-llm-evidence.stdout.log`
- `architecture-audit/cycle-007-llm-transport-provider-gateway/logs/t1-current-llm-callers.stdout.log`

Key source files:

- `src/agents/llm-client.ts`
- `src/agents/agent-llm-gateway.ts`
- `src/agents/llm-transport.ts`
- `src/agents/analyst-llm-resolver.ts`
- `src/agents/skill-tools.ts`
- `src/agents/workspace-tools.ts`
- `src/agents/analyst-tool-schemas.ts`
- `tests/agents/llm-client-integration.test.ts`
- `tests/agents/llm-client-recorder.test.ts`

## Recommended implementation approach

Prefer the direct proposal for this cycle: extract the LLM client along existing seams without redesigning the entire provider/model router. The highest-value subset is:

1. Move exported invocation/tool/error contracts out of `llm-client.ts` into narrow LLM contract modules.
2. Split generic OpenAI-compatible chat completions and OpenAI Codex response-backend gateway code into provider gateway modules.
3. Split stream parsers and stream tee/recording helpers so parsers are testable without HTTP/recorder setup.
4. Keep `AgentLlmInvocationGateway` and `LlmIntentResolver` behavior intact while changing them to consume the new invocation facade/contracts.
5. Delete the old `createLlmClient` factory if no production or test call site needs it after extraction.

The broader restructure proposal is useful as an upper-bound alternative, but it risks coupling this cycle to a larger provider-router redesign and should only be selected if reviewers decide the direct extraction leaves too many transport concepts inside agent code.
