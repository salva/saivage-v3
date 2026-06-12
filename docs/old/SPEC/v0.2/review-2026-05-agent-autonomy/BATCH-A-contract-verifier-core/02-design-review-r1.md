# Batch A - Contract Verifier Core: Design Review

The design has the right north star: contract failures should move out of `LlmRequestError` / `decideFailure`, the done signal should be explicit, and the inline plain-message nudge should disappear. P-A2 is also the right recommendation in principle. I cannot approve this revision as implementable as written because several type and boundary details still contradict the source tree.

## Required changes

1. Repair-budget ownership is internally contradictory.

   Section 2.1.4 defines `RepairBudget.max` as "total repair attempts per invocation, across all candidates." Section 2.6 then says the budget is allocated when `invokeAgent` enters, but also that a transport-driven retry of `agentFn` starts a fresh repair budget. Those cannot all be true. The current source has two nested retry axes: `invokeWithRecovery` replays `agentFn`, while `AgentAdapter.invokeAgent` also has a same-candidate retry loop around `defaultInvocationRecoveryPolicy.decideFailure` ([src/agents/agent-adapter.ts](../../../../src/agents/agent-adapter.ts#L273-L459)). The design must pick one precise budget scope and state where the counter is allocated, incremented, persisted in outcomes, and reset, if ever. Without that, `repair_exhausted` is not implementable deterministically.

2. The P-A2 TypeScript signatures are not yet internally sound.

   The recommended design's `DoneSignalForm` only gives `project` to the `kind: 'tool'` variant, but section 3.5 says message contracts synthesize `proposed` through the contract's `project` callback. A `kind: 'message'` contract therefore cannot type-check as described. The `Contract` interface also returns only `Record<string, unknown>` and relies on a "thin caller-side projection casts to the static type". That preserves the current weak boundary in [src/agents/agent-adapter.ts](../../../../src/agents/agent-adapter.ts#L46-L60), where projection is still a possible validation site. Make the contract generic, for example `Contract<TEnvelope, TResult>`, or otherwise have `Contract.check` return the typed successful result so `parseEnvelope`/casts cannot reintroduce schema failures outside the verifier.

   The state-machine signatures need the active contract as input. `onLlmResult(state, result)` cannot know which tool name is the done signal, how to project arguments, or whether a message result is a valid analyst-style done signal without `Contract`/`DoneSignalForm`. The source today gets those answers from `ROLE_RESULT_TOOL_NAMES` and `ROLE_RESULT_TOOLS` ([src/agents/agent-adapter.ts](../../../../src/agents/agent-adapter.ts#L294-L296)); P-A2 deletes those maps, so the replacement transition API must carry the contract explicitly.

3. The transport-vs-contract split is not enforceable until the event and exchange schemas are redesigned.

   The design deletes `TERMINAL_TOOL_NAMES` from [src/contracts/llm-exchange.ts](../../../../src/contracts/llm-exchange.ts#L32-L36), but the old terminal-tool names are also baked into recorded exchange typing and runtime events: `deriveTerminalToolFromOptions` narrows through `TerminalToolName` in [src/agents/llm-recording.ts](../../../../src/agents/llm-recording.ts#L4-L66); `LlmAttemptOutcome`, `LlmFailureClass`, and `LlmInvocationSummaryEvent.final_terminal_tool` still encode `emit_*_result` and `contract_mismatch` in [src/schemas/types.ts](../../../../src/schemas/types.ts#L154-L163); the zod event registry repeats those enums in [src/schemas/event-catalog.ts](../../../../src/schemas/event-catalog.ts#L7-L54). The design says the failure-class column stays transport-shaped, but it does not specify the replacement event shape for verifier rejection, `repair_exhausted`, `no_progress`, or a successful `signal_done`. Add the exact schema/type changes and old enum removals, with no compatibility branch.

4. The dead-code removal list misses live old-contract producers.

   Deleting [src/agents/terminal-protocol.ts](../../../../src/agents/terminal-protocol.ts) and [src/agents/role-result-tools.ts](../../../../src/agents/role-result-tools.ts) is necessary but not sufficient. [src/agents/agent-tool-catalog.ts](../../../../src/agents/agent-tool-catalog.ts#L5-L137) imports `EMIT_PLANNER_RESULT` / `EMIT_EXECUTOR_RESULT` / `EMIT_REVIEWER_RESULT`, includes the old role result names in `ROLE_TOOL_NAMES`, and registers the old definitions in `ALL_TOOL_DEFINITIONS_BY_NAME`. [src/agents/persisted-tool-call.ts](../../../../src/agents/persisted-tool-call.ts#L1-L120) still imports `LlmRequestError` and throws `contract_mismatch` for legacy row shapes, invalid JSON, and schema violations. [src/agents/llm-errors.ts](../../../../src/agents/llm-errors.ts) re-exports the old failure names. The design must list these symbols/files and state whether each is deleted, rewritten to non-contract parse errors, or moved under the verifier. The project rule forbids preserving `legacy_message_shape` support as a compatibility shim.

5. The repair protocol needs one unambiguous turn ordering.

   Section 2.3 says multiple `signal_done` calls in one turn are allowed but extras are ignored after the first. The pseudocode in 2.2 overwrites `pendingDone` on every done call, so the last one wins. It also says the runtime writes a `tool_result` row against `signal_done` for satisfied and violated checks, but the pseudocode does not persist that row before continuing. Pick first or last, define what persisted row duplicate done calls receive, and define how invalid JSON in the done tool arguments becomes `envelope_invalid_json` rather than collapsing to `proposed: null` / `envelope_missing`. This matters because current `ToolCall.function.arguments` arrives as a string ([src/agents/llm-contracts.ts](../../../../src/agents/llm-contracts.ts#L18-L24)), and the design's `parseDoneArgs` return type loses parse-error information.

## Issue coverage

- F02 is addressed conceptually by removing `contract_mismatch` from the recovery-policy input and replacing fatal aborts with verifier repair plus `repair_exhausted`. It needs the budget correction above before it is implementable.
- F03 is addressed by the dedicated `signal_done` tool and, in P-A2, `DoneSignalForm`. The choice is well justified by provider support for `tool_calls`.
- F04 is addressed in the failure-union design (`LlmTransportFailure` only for `LlmRequestError` / `decideFailure`), but the current event/exchange schemas and `persisted-tool-call.ts` holes would let contract concepts remain in transport-shaped surfaces.
- F09 is addressed by deleting the inline nudge in [src/agents/agent-adapter.ts](../../../../src/agents/agent-adapter.ts#L302-L320) and making `model_repair` verifier-owned. The design must complete the deletion list so no second producer remains.

## Other review axes

The document does present both required proposals: P-A1 as the focused fix and P-A2 as the one-level-up architecture. The done-signal choice is opinionated and grounded. The no-backward-compatibility rule is stated, but not fully honored while `legacy_message_shape` and old terminal-tool event schemas remain unaddressed. The transport/contract split is the correct architecture, but it is not yet fully specified at the schema and recorder boundaries. The recommendation should remain P-A2 after the fixes above; P-A1 would leave too much role/schema/prompt fan-out for Batch B and Batch C to rewrite again.

VERDICT: CHANGES_REQUESTED