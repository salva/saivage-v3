# Batch B Design Review - r1

## Verdict Summary

Approved. The design concretely resolves F05, F06, and F07 by making the invocation contract an explicit value, deleting the role-keyed contract taxonomy, replacing deferred-activation synthesis with a first-class planner terminal, and rendering the prompt's terminal obligations from the same contract terminals that the verifier consumes. P-B1 is the right recommendation: it fixes the contract surface without introducing the registry / prompt-renderer / tool-catalogue abstraction stack before there is a second concrete contract family that needs it.

## Coverage Against Review Axes

- **F05 is resolved.** P-B1 removes `EnvelopeBearingRole`, `ENVELOPE_SCHEMAS`, `ROLE_RESULT_TOOL_NAMES`, `ROLE_RESULT_TOOLS`, `TERMINAL_TOOL_NAMES`, the recorder narrowing, and the role-keyed terminal-tool splice from `ROLE_TOOL_NAMES`. The replacement map is explicit and keeps `role` only as prompt/tool-catalogue/observability metadata.
- **F06 is resolved.** Position C is selected and defended: `emit_planner_deferred` becomes a real planner terminal whose body is the strict `DeferredActivationEnvelopeV1`. The adapter's synthetic planner envelope branch, inline `CardStore` construction, dependency walk, `system / model_issue` synthesis rows, and legacy deferred parser fallback are all deletion work.
- **F07 is resolved.** The hand-written raw-JSON output blocks are removed from planner / executor / reviewer prompts and replaced with terminal-contract rendering that names the required tool calls. The design also deletes the unverifiable self-check JSON side channel rather than leaving a second prompt-only contract.
- **Two proposals are present.** P-B1 is the focused fix; P-B2 is a real level-up that makes verifier, prompt renderer, and tool catalogue first-class. The comparison table makes the cost and payoff clear.
- **The contract surface is ergonomic enough to implement.** `Contract<Envelope, TypedResult>` carries terminals, verification, terminal-name membership, and projection in one value. Multiple terminal tools are modelled directly, which is the right shape for the planner deferred case and for Batch A's likely done-signal work.
- **No backward compatibility is preserved.** The design explicitly rejects migration shims, legacy parser acceptance, feature flags, and old exchange fixtures. Existing recordings are regenerated rather than migrated.
- **The deletion list is explicit.** Section 2.3 plus the recommendation sequence names the symbols, branches, schemas, prompt blocks, policy path, and fixtures that must be removed.
- **Prompt rendering is enforceable if implemented as written.** The design's intended source of truth is `terminals -> zodToJsonSchemaMini -> jsonSchemaToProse`; implementation should keep `Contract.describe()` as a thin wrapper over `describeTerminals(terminals)`, not as a per-contract hand-written string. The design already points that way and deletes the hand-written prompt blocks, so this is an implementation guardrail rather than a design blocker.
- **Deferred activation resolution is defensible.** Position C avoids both runtime-forged results and the redundant "call `emit_planner_result` after `activate_card`" ritual. It also resolves the adjacent F03 awaiting-child signal by making "done, awaiting child" structurally distinct.
- **Batch A compatibility is stated and credible.** `Contract.verify` is the verifier seam, the terminal set is the done-signal set, verification failures return structured `LlmRequestError` values that a repair loop can consume, and P-B2 shows how a verifier registry can be extracted later if Batch A chooses that shape.
- **The recommendation is grounded.** The design recommends P-B1 because it fixes the concrete problems with lower conceptual cost, while preserving a mechanical path to P-B2.

## Spot Verification

I spot-verified the source claims against the current tree: the role/schema/tool maps, terminal enum, recorder narrowing, prompt/raw-JSON mismatch, self-check prompt, adapter terminal-tool block, deferred-activation synthesis branch, legacy `__saivage_defer_tool_result` fallback, planner-control deferred payloads, role-tool-policy surface, and supervisor-facing result types all match the design's described blast radius. `npm run typecheck` passes in `saivage-v3`, so the current TypeScript baseline is green.

One non-blocking TypeScript-design note: section 2.2's abbreviated `PlannerTypedResult` deferred branch omits the `activations` field that section 2.6.1 later includes. Section 2.6.1 is the better authoritative shape because it gives the supervisor the strict deferred envelope directly; align the earlier snippet during implementation.

VERDICT: APPROVED