# Phase E Metaplan Review r1

Finding: M02 establishes the F08 typed `LlmFailure` architecture by deleting `InvocationFailureClass`/`failureClass` and making `InvocationRecoveryPolicy.decideFailure` switch on `failure.kind`, but M04/M05 still schedule the F05-era class-based `LlmContractMismatchError` addition and an `instanceof LlmContractMismatchError` recovery branch. In this order, the metaplan is not self-consistent: either F05 B1 must land before F08, or the F05 B1/B2 text must be rewritten so terminal-protocol errors construct/unwrap `LlmFailure { kind: 'contract_mismatch' }` and the policy keeps the F08 switch-based branch. This is an architectural blocker because it breaks the green-checkpoint contract and risks reintroducing the deleted error hierarchy.

Checked: F08 is otherwise before F03/F04; F05 B1-B6 order is preserved with F06 inserted after B2 and before B3; each batch includes typecheck/Jest coverage at least at the intended scope plus live probes where runtime behavior changes; old shapes are planned to hard-fail; risk register covers both VS Code SFC corruption and stale TS buffer reverts.

Required change: Reconcile the F05/F08 contract-mismatch ownership in the metaplan text and validation gates before approval.

VERDICT: CHANGES_REQUESTED