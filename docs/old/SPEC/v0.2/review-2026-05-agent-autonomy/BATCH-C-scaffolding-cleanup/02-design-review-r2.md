# Batch C Design Review - r2

## Verdict Summary

Changes requested. The r2 design resolves the main r1 objections: `invokeWithRecovery` is no longer co-owned with the recorder, verifier-terminal outcomes stop through an `abort/verifier_terminal` directive, the analyst and test phase call sites are now named, the runtime-config legacy migration delete is explicit, and the TypeScript sketches are mostly implementation-shaped. However, three substantive holes remain around Batch B compatibility and enforceability of the transport budget.

## Required Changes

1. **Align the status projection with the approved Batch B `Contract` surface.**

   Batch C says `InvocationOutcomeProjector` drives lifecycle status via `plan.contract.projectStatus(typedResult)` in [02-design-r2.md](02-design-r2.md#L685), and later treats `contract.projectStatus(...)` as the F10 fix in [02-design-r2.md](02-design-r2.md#L1125). The approved Batch B `Contract` interface has `project(envelope, terminalName): TypedResult` but no `projectStatus` member in [../BATCH-B-contract-surface/02-design-r1.md](../BATCH-B-contract-surface/02-design-r1.md#L131-L136).

   This makes the decomposition incompatible with the integration target as written. Fix by either extending the Batch B contract surface explicitly, adding a separate `statusProjector` / `lifecycleProjector` field to `AgentInvocationPlan`, or defining a small adapter owned by Batch C. The review should be able to see the exact type that maps `TypedResult -> SessionStatus` and why it composes with planner, executor, reviewer, and future contracts.

2. **Remove the closed terminal-tool enum from Batch C; Batch B deletes it.**

   Batch C still states that `TERMINAL_TOOL_NAMES` and `TerminalToolName` survive unchanged as the canonical result-tool string source in [02-design-r2.md](02-design-r2.md#L143-L148). That conflicts with approved Batch B, which explicitly deletes `TERMINAL_TOOL_NAMES` and the closed `terminalTool` enum in [../BATCH-B-contract-surface/02-design-r1.md](../BATCH-B-contract-surface/02-design-r1.md#L370-L374), replaces the schema with contract-carried terminal names in [../BATCH-B-contract-surface/02-design-r1.md](../BATCH-B-contract-surface/02-design-r1.md#L402-L403), and rewrites recorder metadata to `terminalToolNames` / `terminalToolFired` in [../BATCH-B-contract-surface/02-design-r1.md](../BATCH-B-contract-surface/02-design-r1.md#L716-L739).

   Update Batch C's F01 deletion/replacement list and recorder assumptions so the terminal name source is only `contract.terminals` / Batch B recorder request metadata. Keeping the closed enum would preserve exactly the role-keyed compatibility surface Batch B removes, and it would make the design fail its own Batch A/B compatibility axis.

3. **Make all-candidates-exhausted preserve the recorder's failure class instead of forcing an outer replay.**

   The budget table says `auth_permanent`, `capability_mismatch`, `rate_limit`, `server_transient`, `timeout`, and `token_budget_exceeded` fail over without consuming axis 3, while only `provider_protocol_error` and transport `parse_error` consume `maxTransportRetries`. But the orchestration pseudocode falls out of the candidate loop with `All candidates exhausted` and unconditionally returns `directive: { action: 'replay_outer', reason: 'parse_error_transport_exhausted' }` in [02-design-r2.md](02-design-r2.md#L783).

   That path can convert any full-chain failover into an axis-3 replay and mislabel it as parse-error exhaustion. Carry the last `AttemptOutcomeRecord` / directive out of the candidate loop and make the final action depend on that typed reason. `replay_outer` should be produced only by the recorder for the two transport classes that are allowed to consume axis 3; ordinary chain exhaustion should become a terminal transport/candidate-exhausted verdict without spending `maxTransportRetries`.

## Axis Assessment

- **F01:** Mostly resolved. The live phase sites, analyst caller, probe, and phase-bearing tests are now enumerated. Approval depends on removing the `TERMINAL_TOOL_NAMES` survivor clause so the design integrates with Batch B.
- **F08:** Partially resolved. Verifier terminals no longer flow through the old recovery wrapper, but the all-candidates-exhausted replay path still lets non-replayable failures consume the transport retry budget.
- **F10:** Partially resolved. The collaborator split is clean, but the lifecycle projection calls a method not present in the approved contract target.
- **Two proposals and recommendation:** Approved. P-C1 is the right scope for this cleanup batch, with P-C2 correctly positioned as a follow-up.
- **No backward compatibility / deletion list:** Mostly approved. Runtime-config migration deletion and `recovery.ts` deletion are now explicit; the remaining closed terminal-tool enum is the compatibility leak.
- **Batch A/B compatibility:** Changes requested for the two Batch B conflicts above.
- **Self-containment:** Good overall, but the status projector type must be made explicit.

## Spot Verification

I spot-verified the current TypeScript surfaces for the cited hot-path symbols: `buildLlmOptions`, `LlmCompleteOptionsTerminal`, gateway `opts.phase` branches, `deriveTerminalToolFromOptions`, `agent-adapter.ts` recovery/budget logic, `config-schema.ts` legacy runtime migration, `recovery.ts`, `invocation-recovery-policy.ts`, analyst `buildLlmOptions` usage, phase-bearing tests, and the existing terminal-tool recorder/schema constants. I did not run the full TypeScript suite; this review is a document/source spot check.

VERDICT: CHANGES_REQUESTED