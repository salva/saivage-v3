# Batch C Design Review - r1

## Verdict Summary

Changes requested. The design has the right decomposition and P-C1 is the right recommendation in principle, but it is not yet implementable as written because the proposed outer orchestration still lets verifier-terminal outcomes and candidate-exhaustion errors flow through the existing `invokeWithRecovery` exception retry path. That breaks the F08 budget split: `turns_exhausted` / `repair_exhausted` are specified as no-replay verifier outcomes, but the pseudocode still throws them into a wrapper that retries every thrown error until `maxRetries` is exhausted.

## Required Changes

1. **Make verifier-terminal outcomes stop the outer recovery loop without replay.**

   Section 2.2 and the failure-class table correctly state that `max_agent_turns_exhausted` and `max_repair_rounds_exhausted` are verifier terminal outcomes and must not consume axis 3 or replay `agentFn`. Section 2.4 then records the verifier terminal outcome and throws `InvocationVerifierTerminalError` from inside the `invokeWithRecovery` callback. The current wrapper in [src/agents/recovery.ts](../../../../src/agents/recovery.ts#L84-L174) catches any thrown error, appends a failed `InvocationAttempt`, emits/persists failure side effects, sleeps, and retries while attempts remain. As written, this reintroduces the exact outer replay path the design says is deleted.

   Fix the design by specifying one concrete control shape: either `invokeWithRecovery` is rewritten to return a terminal failed attempt without retrying when the callback returns/throws a typed `VerifierTerminal`, or Batch C stops using `invokeWithRecovery` for verifier terminals and owns the outer loop directly. The review should be able to see where `turns_exhausted` and `repair_exhausted` become final `InvocationAttempt` entries and why they cannot trigger `maxTransportRetries`.

2. **Remove the ownership overlap between `InvocationAttemptRecorder` and `invokeWithRecovery`.**

   The design says `InvocationAttemptRecorder` owns `decideSuccess` / `decideFailure`, `llm_attempt` emission, availability marking, `model_issue` / `model_recovered` persistence, retry-delay sleep, and abort-vs-continue decisions. The pseudocode still passes `publishEvents`, `eventBus`, `recoveryDelayMs`, and `persistFailure` into the existing recovery wrapper, whose current implementation also emits recovery events, persists failure notes, and sleeps after every failed outer attempt in [src/agents/recovery.ts](../../../../src/agents/recovery.ts#L108-L174). That creates two policy/effect owners and makes the budget table unenforceable.

   Pick one owner. The cleanest P-C1 version is to narrow `invokeWithRecovery` into a small attempt-array runner that does not classify, persist, emit, or sleep, leaving those effects to `InvocationAttemptRecorder`; alternatively delete the wrapper from this path and let the recorder drive the outer loop. The design must also define what happens when all candidates in a resolved chain fail over: today the pseudocode throws `All candidates exhausted`, which the existing wrapper would replay as an opaque error.

3. **Complete the F01 deletion/replacement list for all current phase call sites.**

   The source references for `llm-options-factory.ts`, the gateways, `llm-recording.ts`, the terminal-phase tests, and the probe are accurate. One live production caller is missing: [src/agents/analyst-llm-resolver.ts](../../../../src/agents/analyst-llm-resolver.ts#L159-L166) calls `buildLlmOptions('analyst', 'tools', ...)`. If `LlmRolePhase` and the old `buildLlmOptions(role, phase, ...)` signature are deleted, that file must be in the replacement list even if the analyst contract itself stays out of scope.

   The acceptance criteria should also search tests and helpers, not only `src/`, because [tests/agents/_llm-test-helpers.ts](../../../../tests/agents/_llm-test-helpers.ts), [tests/agents/llm-client-recorder.test.ts](../../../../tests/agents/llm-client-recorder.test.ts), and [tests/agents/llm-client-integration.test.ts](../../../../tests/agents/llm-client-integration.test.ts) construct the old single-shape-but-still-phased options object. The implementation should leave no `phase: 'tools'` literals either, not just no `phase: 'terminal'` literals.

4. **Tighten the TypeScript sketches so they are valid implementation targets.**

   The current project exports `ToolDefinition`, `tool_choice`, `max_tokens`, and `signal` from [src/agents/llm-contracts.ts](../../../../src/agents/llm-contracts.ts#L12-L54). The design snippets introduce `LlmToolDefinition`, `toolChoice`, `maxTokens`, and `abortSignal` without listing the coordinated transport/recorder/test edits needed for those renames. Renaming is fine, but the design should make it explicit and update the surrounding snippets consistently; otherwise implementers will mix old and new option shapes.

   Also clarify whether the collaborator snippets are declaration-only sketches or implementation files. `class AgentSessionLifecycle { constructor(...); start(...): Promise<...>; }` is valid in a `.d.ts`-style declaration but not in an implementation `.ts` file without method bodies or `declare`/`abstract`. This is a small fix, but it matters because the document presents the snippets as TypeScript signatures to compile against the project.

5. **Honor the no-backward-compatibility rule at the runtime-config boundary.**

   The design says `maxToolTurns`, `maxRecoveryRetries`, and the old recovery-delay semantics are removed, with `maxAgentTurns`, `maxRepairRounds`, `maxTransportRetries`, and `transportRetryDelayMs` replacing them. The deletion list should explicitly cover the existing legacy-runtime migration hooks in [src/agents/config-schema.ts](../../../../src/agents/config-schema.ts#L13-L40) and [src/agents/config-schema.ts](../../../../src/agents/config-schema.ts#L372-L379), which currently accept and rehydrate `maxRecoveryRetries` / `recoveryDelayMs`. Leaving those paths in place would preserve old runtime config under a migration shim, contrary to the project rule.

## Axis Assessment

- **F01 / F08 / F10 coverage:** Partially approved. F10 decomposition and F01 phase deletion are directionally concrete; F08 is conceptually right but not enforceable until the outer retry control path is fixed.
- **Two proposals:** Approved. P-C1 is a focused extraction and P-C2 is a real level-up with a state-machine driver.
- **Boundary clarity:** Changes requested. The collaborator boundaries are clear on paper, but `InvocationAttemptRecorder` and `invokeWithRecovery` overlap in the executable pseudocode.
- **No backward compatibility:** Changes requested. The principle is stated, but runtime-config legacy migration deletion is not explicit.
- **Deletion list:** Changes requested. It misses the analyst `buildLlmOptions` caller and phase-bearing test helpers.
- **Budget unification and failure table:** Changes requested. The table is mostly correct, but the pseudocode still routes no-replay verifier terminals through a retrying exception wrapper.
- **Batch A/B compatibility:** Approved. The assumptions are explicit and the contract/verifier seams are reasonable, subject to the outer-loop fix above.
- **Self-containment:** Approved. The document is readable without prior rounds and restates the relevant approved analysis.
- **Recommendation:** Approved in direction. P-C1 remains the right recommendation once the retry-loop and deletion-list fixes are made.

## Spot Verification

I spot-verified the cited source surfaces in `llm-options-factory.ts`, `llm-contracts.ts`, `agent-adapter.ts`, `invocation-recovery-policy.ts`, `recovery.ts`, the OpenAI gateways, `llm-recording.ts`, event schemas, and config schema. The current `saivage-v3` baseline passes `npm run typecheck`.

VERDICT: CHANGES_REQUESTED