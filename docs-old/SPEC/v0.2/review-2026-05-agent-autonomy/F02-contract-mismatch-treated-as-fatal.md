# F02 — `contract_mismatch` failures abort the whole invocation instead of repairing it

## Summary

When the runtime detects any envelope-shape problem (missing terminal tool,
unexpected tool name, malformed tool-argument JSON, schema violation, legacy
persisted-row shape), it raises `LlmRequestError{kind:'contract_mismatch'}`.
`InvocationRecoveryPolicy.decideFailure` then maps that family to
`fail_invocation` with `abort=true` and `markFailed=false`. The candidate is
not even marked unavailable — the entire invocation is given up, no further
candidates are tried, and the agent never sees the violation. This is exactly
the path that killed `nvidia-nim/_/meta/llama-3.3-70b-instruct` in the
operator's trigger case.

## Evidence

- [invocation-recovery-policy.ts#L114](src/agents/invocation-recovery-policy.ts#L114)
  collapses every contract subtype into an abort:

  ```ts
  case 'contract_mismatch':
    return this.buildDecision(context, 'fail_invocation', failure,
      `Candidate ${candidate} violated tool-call contract (subtype=${failure.subtype}): ${sanitized}`,
      { markFailed: false, appendModelIssue: true, abort: true });
  ```

- [terminal-protocol.ts#L8](src/agents/terminal-protocol.ts#L8) raises
  `terminal_tool_missing` even when the agent simply has not finished yet:

  ```ts
  if (call === undefined) {
    throw new LlmRequestError({ kind: 'contract_mismatch',
      subtype: 'terminal_tool_missing', ... });
  }
  ```

- [agent-adapter.ts#L386](src/agents/agent-adapter.ts#L386) reaches the same
  contract error when the turn budget runs out:

  ```ts
  throw new LlmRequestError({ kind: 'contract_mismatch',
    subtype: 'terminal_tool_missing',
    message: `Role '${role}' did not emit terminal tool within ${maxToolTurns} turns.` });
  ```

## Category

contract-violation-handling

## Severity

critical

## Transversality

architectural

## Why this matters for the redesign

In the target model "runtime is a contract verifier with a repair loop"
violations are the normal case the runtime is built to handle, not a fatal
error. The current code has no place to express "tell the agent what went
wrong, give it another shot, then escalate". The repair channel has to become
first-class and `contract_mismatch` has to leave the abort family.
