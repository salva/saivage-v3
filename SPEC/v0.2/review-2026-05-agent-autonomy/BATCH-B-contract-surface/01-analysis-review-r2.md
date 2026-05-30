# Batch B Analysis Review - r2

## Verdict Summary

The revised Batch B analysis substantively addresses the r1 objections. It now covers the legacy deferred-activation parser fallback, the persisted `activate_card` unresolved/completion scanners, agent-side terminal-tool recording, concrete downstream `PlannerResult` / `ReviewerResult` consumers, and the compatibility risk carried by Position A. Its F05/F06/F07 coverage is now architecturally credible and self-contained.

Changes are still required because exact source-reference correctness was a mandatory review axis, and several cited anchors in the new revision are stale. The conclusions are sound; the evidence links need cleanup before this should be approved.

## Source Reference Verification

Verified references that are substantively correct:

- `EnvelopeBearingRole` and `ENVELOPE_SCHEMAS` are correctly anchored at [../../../src/agents/role-envelope-schemas.ts#L64](../../../src/agents/role-envelope-schemas.ts#L64) and [../../../src/agents/role-envelope-schemas.ts#L66](../../../src/agents/role-envelope-schemas.ts#L66).
- `ROLE_RESULT_TOOL_NAMES`, `buildToolDef`, and `ROLE_RESULT_TOOLS` are correctly anchored at [../../../src/agents/role-result-tools.ts#L4](../../../src/agents/role-result-tools.ts#L4), [../../../src/agents/role-result-tools.ts#L19](../../../src/agents/role-result-tools.ts#L19), and [../../../src/agents/role-result-tools.ts#L34](../../../src/agents/role-result-tools.ts#L34).
- The adapter's role-derived terminal setup, deferred activation detection, synthesis branch, inline `CardStore`, and final persisted JSON response are correctly anchored at [../../../src/agents/agent-adapter.ts#L292](../../../src/agents/agent-adapter.ts#L292), [../../../src/agents/agent-adapter.ts#L352](../../../src/agents/agent-adapter.ts#L352), [../../../src/agents/agent-adapter.ts#L358](../../../src/agents/agent-adapter.ts#L358), [../../../src/agents/agent-adapter.ts#L360](../../../src/agents/agent-adapter.ts#L360), and [../../../src/agents/agent-adapter.ts#L388](../../../src/agents/agent-adapter.ts#L388).
- `TERMINAL_TOOL_NAMES`, its closed zod enum, the `contracts/index.ts` re-export, and the `llm-recording.ts` narrowing through `TERMINAL_TOOL_NAMES` are correctly identified.
- The planner-control executor deferred payloads at [../../../src/agents/planner-control-executor.ts#L120](../../../src/agents/planner-control-executor.ts#L120) and [../../../src/agents/planner-control-executor.ts#L131](../../../src/agents/planner-control-executor.ts#L131) are correct.
- The legacy `__saivage_defer_tool_result` fallback and literal `legacy` field synthesis are correctly anchored at [../../../src/schemas/validators.ts#L68](../../../src/schemas/validators.ts#L68).
- The runtime planner/reviewer consumers and `applyPlannerResult` anchors are credible: [../../../src/runtime/runtime.ts#L677](../../../src/runtime/runtime.ts#L677), [../../../src/runtime/runtime.ts#L822](../../../src/runtime/runtime.ts#L822), and [../../../src/runtime/runtime.ts#L453](../../../src/runtime/runtime.ts#L453).

Incorrect or stale anchors that must be fixed:

1. The analysis cites `parseDeferredActivationEnvelope` at `src/schemas/validators.ts#L62`, but the current function starts at [../../../src/schemas/validators.ts#L64](../../../src/schemas/validators.ts#L64). It also cites `parseActivationCompletionEnvelope` at `#L74`, but the function starts at [../../../src/schemas/validators.ts#L75](../../../src/schemas/validators.ts#L75).

2. The newly added persistence citations are slightly stale. `findUniqueUnresolvedActivateCardToolCall` starts at [../../../src/agents/session-persistence.ts#L404](../../../src/agents/session-persistence.ts#L404), not `#L405`; `appendActivateCardToolResultOnce` starts at [../../../src/agents/session-persistence.ts#L445](../../../src/agents/session-persistence.ts#L445), not `#L446`; and `findUnresolvedActivateCards` starts at [../../../src/runtime/runtime.ts#L235](../../../src/runtime/runtime.ts#L235), not `#L239`.

3. The self-check anchor in the open questions is materially wrong. [../../../src/agents/system-prompt.ts#L222](../../../src/agents/system-prompt.ts#L222) points into the reviewer JSON block, not the self-check prompt. `buildSelfCheckPrompt` starts at [../../../src/agents/system-prompt.ts#L253](../../../src/agents/system-prompt.ts#L253), and the ad-hoc `self_check` JSON examples are at [../../../src/agents/system-prompt.ts#L268](../../../src/agents/system-prompt.ts#L268), [../../../src/agents/system-prompt.ts#L270](../../../src/agents/system-prompt.ts#L270), and [../../../src/agents/system-prompt.ts#L272](../../../src/agents/system-prompt.ts#L272).

4. The analyst early-exit citation in the open questions is stale. The `result.kind === 'message'` branch starts at [../../../src/agents/agent-adapter.ts#L304](../../../src/agents/agent-adapter.ts#L304), and the non-envelope early exit is at [../../../src/agents/agent-adapter.ts#L305](../../../src/agents/agent-adapter.ts#L305), not `#L296-L299`.

5. The executor schema citation is off by one: `ExecutorResultSchema` starts at [../../../src/agents/role-envelope-schemas.ts#L49](../../../src/agents/role-envelope-schemas.ts#L49), not `#L48`. The associated `sourceFile` / `path` claims are still correct, but the anchor should land on the actual schema or the specific artifact fields.

## Completeness Against F05/F06/F07

- F05 is complete. The revision connects the role union, role-to-schema map, role-to-tool-name map, adapter, options factory, verifier, tool catalogue, policy, contracts enum, and recording layer.
- F06 is now complete at the analysis level. It covers adapter-side synthesis, planner-control deferred payloads, the no-backward-compat parser fallback, session persistence, runtime unresolved-activation scanning, completion envelope parsing, and the design options for deferred activation.
- F07 is complete conceptually. The prompt/runtime mechanism mismatch is clear, the hand-written JSON shape drift is described, and the self-check side channel is included. The self-check line anchor is the only blocker in this section.

## Backward Compatibility

The revision now correctly flags the live `__saivage_defer_tool_result` fallback as a compatibility shim to delete, and it labels Position A as compatibility-shaped rather than treating it as neutral. I did not find a remaining unflagged backward-compatibility smell in the substance of the analysis.

## Self-Containment

The document is self-contained. It does not rely on r1/r2 process history, approval markers, or sibling documents to explain the problem or the target behaviour.

## Cross-Cutting Impact

The impact map is credible. It names `src/contracts/`, supervisor consumers, planner-control executor, `src/schemas/validators.ts`, `system-prompt.ts`, `agent-tool-catalog.ts`, `RoleToolPolicy`, `llm-options-factory.ts`, `terminal-protocol.ts`, `agent-adapter.ts`, session persistence, runtime activation scanning, recording, replay, and tests. That is enough surface area for the design phase to avoid accidentally preserving the old role-keyed contract.

## Open Questions

The open questions are genuinely design-phase questions: contract location, prompt schema rendering, single vs multiple done signals, repair format ownership, A/B/C deferred activation strategy, optional analyst unification, recorder enum widening, self-check treatment, and the role/contract type boundary. Position A is now properly caveated as a compatibility/autonomy risk.

VERDICT: CHANGES_REQUESTED