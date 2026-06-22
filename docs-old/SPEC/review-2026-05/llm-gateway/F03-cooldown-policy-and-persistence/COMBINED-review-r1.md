# F03 combined analysis + design + plan review, r1

1. Batch 2 cannot be a green checkpoint after deleting the provider health API before rewiring its consumers.

   a. Evidence: the plan requires every batch to end at a green checkpoint ([COMBINED-r1.md#L213](COMBINED-r1.md#L213)), then batch 2 deletes `ProviderRegistry` health methods including `isHealthy`, `markFailed`, and `markSucceeded` ([COMBINED-r1.md#L242](COMBINED-r1.md#L242)). The same batch explicitly says `AgentAdapter` must not yet reference the new substrate and keeps only a temporary `cooldownMs` field for compile continuity ([COMBINED-r1.md#L260](COMBINED-r1.md#L260)). Current consumers still call the deleted methods: `ModelRouter.resolveModel` calls `registry.isHealthy` ([src/agents/model-router.ts#L124](../../../../src/agents/model-router.ts#L124)), and `AgentAdapter` calls `registry.isHealthy`, `registry.markSucceeded`, and `registry.markFailed` ([src/agents/agent-adapter.ts#L331](../../../../src/agents/agent-adapter.ts#L331), [src/agents/agent-adapter.ts#L398](../../../../src/agents/agent-adapter.ts#L398), [src/agents/agent-adapter.ts#L408](../../../../src/agents/agent-adapter.ts#L408)).

   b. Impact: batch 2 cannot compile with `npx tsc --noEmit` as written. The temporary `cooldownMs` scaffold only preserves the recovery-decision field shape; it does not preserve the deleted provider methods. That violates the requested green-checkpoint property and blocks implementation sequencing.

   c. Required change: move deletion of the provider health API into the same batch that rewires all consumers to `CandidateAvailability`, or wire `ModelRouter`, `AgentAdapter`, and the analyst path in batch 2 before the checkpoint. Do not leave a final legacy shim, but each published batch has to compile.

2. The default `maxCooldownMs` cap contradicts the stated `resets_at` correctness target and the draft's own test expectation.

   a. Evidence: the issue cites a production `resets_at=1780172729`, roughly 24 h ahead, and recommends using explicit reset time as the cooldown lower bound ([../F03-cooldown-policy-and-persistence.md#L5](../F03-cooldown-policy-and-persistence.md#L5), [../F03-cooldown-policy-and-persistence.md#L41](../F03-cooldown-policy-and-persistence.md#L41)). The combined doc scopes the work as honoring `Retry-After` / `resets_at` ([COMBINED-r1.md#L3](COMBINED-r1.md#L3)) and repeats that the current bug is a 24 h window mis-honored as 60 s ([COMBINED-r1.md#L58-L64](COMBINED-r1.md#L58-L64)). But the design caps explicit reset-derived cooldowns at `runtime.maxCooldownMs`, default 6 h ([COMBINED-r1.md#L84](COMBINED-r1.md#L84), [COMBINED-r1.md#L178](COMBINED-r1.md#L178), [COMBINED-r1.md#L243](COMBINED-r1.md#L243)), while the planned test expects `resetsAtMs = now + 24h` to yield `untilMs ~= now + 24h` ([COMBINED-r1.md#L257](COMBINED-r1.md#L257)).

   b. Impact: with the documented default, the implementation retries the reported candidate about 18 h before the provider-stated reset. That no longer honors `resets_at` by default, so the design does not fully close F03 and the test plan is internally inconsistent.

   c. Required change: make provider-stated reset times authoritative up to a default cap that covers the reported class of quota windows, or make the safety cap opt-in/high enough by default and test the cap separately. Align the default, the parser/recovery policy, and the `now + 24h` test expectation.

3. The single-writer analyst availability path is underspecified relative to current construction ownership.

   a. Evidence: Proposal B states that only `ActiveRuntime`'s `CandidateAvailability` instance writes the store ([COMBINED-r1.md#L171](COMBINED-r1.md#L171)), and says `ActiveRuntime` injects that instance into both `AgentAdapter` and `AnalystLlmResolver` ([COMBINED-r1.md#L190](COMBINED-r1.md#L190), [COMBINED-r1.md#L267](COMBINED-r1.md#L267)). Current code does not have that ownership path: `ActiveRuntime` constructs only the shared `AgentAdapter` ([src/runtime/active-runtime.ts#L164](../../../../src/runtime/active-runtime.ts#L164), [src/runtime/active-runtime.ts#L203](../../../../src/runtime/active-runtime.ts#L203)); `AnalystHandler` separately constructs `new LlmIntentResolver(projectRoot)` ([src/agents/analyst-handler.ts#L199](../../../../src/agents/analyst-handler.ts#L199)); and `LlmIntentResolver` constructs its own `ProviderRegistry` and `ModelRouter` ([src/agents/analyst-llm-resolver.ts#L136-L137](../../../../src/agents/analyst-llm-resolver.ts#L136-L137)).

   b. Impact: if the plan is followed literally, the analyst path either remains on separate in-memory provider health or opens another availability writer, violating the single-writer invariant and the claimed unification of analyst and agent recovery.

   c. Required change: specify the construction/API changes that pass the `ActiveRuntime`-owned availability instance into `AnalystHandler` / `LlmIntentResolver`, and update both model-router construction sites to use that shared availability. This should be in the same batch as the analyst recovery rewrite.

VERDICT: CHANGES_REQUESTED