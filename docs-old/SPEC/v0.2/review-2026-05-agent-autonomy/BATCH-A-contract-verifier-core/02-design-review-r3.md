# Batch A - Contract Verifier Core: Design Review r3

R3 addresses the two R2 blockers. I reviewed this revision only against the previously flagged issues and did not find a remaining correctness defect in either area.

## Scoped verification

1. Phase deletion is now complete across the previously missed consumers.

   R3 adds an explicit `LlmCompleteOptions` rewrite in section 2.1.8 and carries the same deletion through P-A2 section 3.4. The design no longer merely deletes `LlmCompleteOptionsTerminal`; it states how each live consumer changes: `LlmProviderGateway.assertCandidateCapabilities` derives capabilities from `opts.tools`, both OpenAI gateways read `opts.tools` and `opts.tool_choice` directly, `llm-recording.ts` derives the done signal from the tools array, `analyst-llm-resolver.ts` adopts the new `buildLlmOptions` signature without a phase argument, and the probe script constructs the flat options shape. That resolves the TypeScript inconsistency identified in R2 without retaining a compatibility branch.

2. The verifier-only `model_repair` invariant is no longer contradicted by compaction.

   R3 introduces `MessageKind: 'context_compaction'`, updates `messageKindSchema`, rewrites `createCompactionMessage` and the fallback compaction path to emit that new kind, and widens diagnostic consumers in the adapter, frontend API type, timeline builder, and tests. The invariant is now stated as a producer-set split: `model_repair` rows come only from `ContractVerifier.renderRepairMessage`, while `context_compaction` rows come only from `createCompactionMessage`. This is the clean no-backward-compatibility fix R2 asked for.

## Result

The r3 design substantively resolves both R2 issues and preserves the architecture-first, no-shim approach required by the brief.

VERDICT: APPROVED