# F08 combined analysis + design + plan review, r2

No architectural blockers found.

r2 resolves the r1 green-checkpoint blocker by making Batch 1 a transactional migration: the `LlmFailure` substrate, legacy hierarchy deletion, every current importer rewrite, recovery-policy rewrite, adapter event rewrites, and focused tests land together, with the zero-hit grep gate preserving the no-backward-compat rule.

The design aligns with F05 r4: `LlmContractMismatchError` becomes a typed `contract_mismatch` failure that fails the invocation without cooldown or provider-health poisoning, the subtype union includes F05's terminal-protocol cases plus `tools_and_response_format_conflict`, and the typed payload gives F03/F04 the fields they need in their follow-up batches. The minor wording tension between the §2.2 final cooldown behavior and Batch 2's provider-hint wiring is non-blocking because the plan explicitly gates provider-hint cooldown assertions to Batch 2 while Batch 1 remains green on the existing recovery-delay fallback.

VERDICT: APPROVED