# Batch A - Contract Verifier Core: Design Review r2

R2 resolves most of the R1 blockers. The repair-budget scope is now precise, first-wins duplicate done-signal ordering is unambiguous, invalid done JSON keeps its own obligation code, P-A2's contract signatures are generic, the state-machine API carries the active contract, and the event/exchange rewrite is much more explicit. The recommendation for P-A2 is grounded in the brief and the approved analysis.

I cannot approve yet because two source-verified implementation holes remain.

## Required changes

1. The `LlmCompleteOptions`/phase deletion is not internally complete.

   R2 deletes `LlmCompleteOptionsTerminal`, removes the `phase` field, and rewrites `buildLlmOptions`, but the live source has additional typed consumers that branch on `opts.phase === 'terminal'` and read `terminalToolName` / `terminalToolDefinition`: [src/agents/llm-provider-gateway.ts](../../../../src/agents/llm-provider-gateway.ts#L42), [src/agents/llm-openai-chat-gateway.ts](../../../../src/agents/llm-openai-chat-gateway.ts#L183-L187), [src/agents/llm-openai-codex-gateway.ts](../../../../src/agents/llm-openai-codex-gateway.ts#L122-L128), and the analyst call site still calls `buildLlmOptions('analyst', 'tools', ...)` in [src/agents/analyst-llm-resolver.ts](../../../../src/agents/analyst-llm-resolver.ts#L159-L166). R2's delete list names `llm-contracts.ts`, `llm-options-factory.ts`, `llm-recording.ts`, the probe script, and adapter code, but not these gateway/call-site rewrites. Because the proposed type surface removes the discriminant those files currently compile against, this is not a stylistic omission; the design is not TS-consistent until it states the replacement shape for these consumers.

   The clean fix is small: say the gateways always consume `opts.tools` plus `opts.tool_choice`, `LlmProviderGateway.assertCandidateCapabilities` derives capabilities from `opts.tools`, the recorder derives `doneSignalTool` from the tools array, and the analyst resolver adopts the new `buildLlmOptions` signature. If the transport implementations remain out of scope, the phase-bearing public type cannot be deleted in this batch.

2. The verifier-only `model_repair` invariant is contradicted by compaction.

   R2 says the verifier is the only producer of `MessageKind: 'model_repair'`. The live tree also creates `system / model_repair` rows for context compaction notices in [src/agents/compaction.ts](../../../../src/agents/compaction.ts#L205-L214), including fallback compaction messages through the same helper. That means F09's repaired invariant is false as written: after deleting the inline nudge in [src/agents/agent-adapter.ts](../../../../src/agents/agent-adapter.ts#L302-L320), there is still a non-verifier producer of `model_repair`.

   The design must either move compaction notices to a different message kind / existing non-repair kind, explicitly rename the verifier-owned kind so compaction is not sharing it, or relax the invariant to "only producer of contract-repair `model_repair`" and define how consumers distinguish contract repair from context compaction. Given the batch's stated transport/contract split and no-backward-compatibility rule, a hard rename/delete path is preferable to leaving a semantic overload.

## Issue coverage

- F02 is substantively addressed: `contract_mismatch` leaves the transport failure union, repair happens inside `agentFn`, and `repair_exhausted` / `no_progress` are explicit contract-layer outcomes.
- F03 is addressed: `signal_done` is justified as the uniform structured channel, and P-A2 generalizes analyst-style message completion through `Contract.doneSignal`.
- F04 is architecturally addressed, but the missing gateway consumer rewrite above leaves the transport/contract split not fully enforceable at the TypeScript boundary.
- F09 is addressed for the adapter nudge, but not for the broader `model_repair` producer set until compaction is handled.

## Other review axes

Both proposals are present, P-A2 is self-contained at the architecture level, the repair protocol is now unambiguous, old terminal-tool/event shapes are listed for deletion with no compatibility branch, and the done-signal recommendation is well supported by provider behaviour. The remaining objections are narrow but substantive because they affect compile-time consistency and a core invariant of the repair layer.

VERDICT: CHANGES_REQUESTED