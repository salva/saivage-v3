# F04 — Recovery policy conflates transport faults with semantic contract violations

## Summary

`LlmFailure` is a flat discriminated union that mixes transport-layer faults
(`auth_permanent`, `rate_limit`, `server_transient`, `timeout`,
`token_budget_exceeded`, `parse_error`) with semantic-layer faults
(`contract_mismatch` with several subtypes). `InvocationRecoveryPolicy.decideFailure`
switches on the same union and produces availability decisions, retry budgets,
and abort flags from one table. The result is that the body sniffer in
`OpenCodeGoClassifier` can turn any HTTP 400 into a `contract_mismatch`, and
conversely a real envelope schema violation is treated under the same
"give up" arm as those provider-specific 400s.

## Evidence

- [llm-failure.ts#L8](src/agents/llm-failure.ts#L8) — one union for both
  layers:

  ```ts
  export type LlmFailure =
    | { kind: 'auth_permanent'; ... }
    | { kind: 'rate_limit'; ... }
    | { kind: 'server_transient'; ... }
    | { kind: 'timeout'; ... }
    | { kind: 'contract_mismatch'; ...; subtype: ContractMismatchSubtype; status?: number }
    ...
  ```

- [llm-failure-classifiers.ts#L100](src/agents/llm-failure-classifiers.ts#L100)
  — provider classifier promotes generic HTTP 400 to a contract violation:

  ```ts
  // Any other HTTP 400 from opencode-go is also a contract violation per F08 plan.
  return { kind: 'contract_mismatch', provider: ctx.provider,
           subtype: 'unknown', status: 400, ... };
  ```

- [invocation-recovery-policy.ts#L75](src/agents/invocation-recovery-policy.ts#L75)
  — a single `switch (failure.kind)` decides cooldowns, failovers, and aborts
  for both transport and semantic failures.

## Category

leaky-abstraction

## Severity

high

## Transversality

cross-cutting

## Why this matters for the redesign

Transport faults belong to the candidate health subsystem (cool down, fail
over). Semantic faults belong to the contract-verifier loop (build a repair
prompt, retry the same candidate, keep the conversation). Threading them
through one union and one policy switch is what makes the contract failure
route into an abort. The redesign needs to separate the two channels at the
type level before the verifier loop can exist.
