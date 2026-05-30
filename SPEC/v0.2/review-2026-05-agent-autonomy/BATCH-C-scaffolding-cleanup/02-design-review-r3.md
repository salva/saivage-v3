# Batch C Design Review - r3

## Verdict Summary

Approved. This r3 review is scoped to the three r2 blockers only: the missing Batch B `projectStatus` surface, the closed terminal-tool enum survivor, and all-candidates-exhausted being mislabeled as a replayable parse-error path. The r3 design substantively resolves all three.

## Verification

1. **`contract.projectStatus` conflict resolved.** r3 restates the Batch B `Contract` interface without `projectStatus`, adds a Batch-C-owned `StatusProjector<TypedResult>` function type, stores it on `AgentInvocationPlan`, and has `InvocationOutcomeProjector` call `plan.statusProjector(result)`. It also rejects adding `projectStatus` to `Contract`, keeping lifecycle projection outside the Batch B wire contract.

2. **Closed terminal-tool enum removed.** r3 explicitly deletes `TERMINAL_TOOL_NAMES`, `TerminalToolName`, their re-exports, and the `terminalTool: z.enum(...)` exchange schema field. Terminal names now come from `contract.terminals`, terminal membership uses `contract.isTerminalToolName(...)`, and recorder metadata uses Batch B's `terminalToolNames` / `terminalToolFired` shape.

3. **All-candidates-exhausted semantics corrected.** r3's budget table maps ordinary full-chain candidate exhaustion to `abort{candidate_chain_exhausted}` and terminal `transport_exhausted` without consuming axis 3. `AttemptDirective` restricts `replay_outer` to `provider_protocol_error` and exhausted transport `parse_error`, and the orchestrator carries `lastTransportRec` out of the candidate loop so fall-through synthesizes `abort{candidate_chain_exhausted}` rather than fabricating `replay_outer`.

## Scope Note

I did not perform a new broad design review beyond the r2 carry-forward issues. Within the requested scope, r3 is consistent with the approved analysis, Batch A r3's verifier/transport split, and Batch B r1's contract and recorder surfaces.

VERDICT: APPROVED