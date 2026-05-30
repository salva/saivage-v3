# F08 — `maxToolTurns` and `maxRecoveryRetries` are two budgets pretending to be one

## Summary

The adapter caps every candidate at `runtimeConfig.maxToolTurns ?? 16` tool
turns inside a single LLM session; the recovery harness around it caps the
whole invocation at `maxRecoveryRetries + 1` attempts (default 4). They share
no accounting, no cause-of-exhaustion vocabulary, and no policy hooks. A
planner that runs the inner loop to its budget produces a synthetic
`contract_mismatch{terminal_tool_missing}` (see F02) which the outer policy
treats as `fail_invocation`/`abort=true` (see F02), so the recovery harness
never sees it. Meanwhile the recovery harness has its own per-attempt
`directive` and `previousError` that the adapter does not consume.

## Evidence

- [agent-adapter.ts#L297](src/agents/agent-adapter.ts#L297) — inner budget:

  ```ts
  const maxToolTurns = this.runtimeConfig.maxToolTurns ?? 16;
  let finalEnvelope: Record<string, unknown> | null = null;
  for (let turn = 0; turn < maxToolTurns; turn++) { ... }
  ```

- [recovery.ts#L99](src/agents/recovery.ts#L99) — outer budget plus an
  unused directive:

  ```ts
  const maxAttempts = maxRetries + 1; // initial attempt + retries
  ...
  directive: isRecovery ? `RECOVERY DIRECTIVE: ...` : '',
  ```

- [agent-adapter.ts#L386](src/agents/agent-adapter.ts#L386) — exhaustion of
  the inner budget feeds straight back into the contract-mismatch abort
  path:

  ```ts
  throw new LlmRequestError({ kind: 'contract_mismatch',
    subtype: 'terminal_tool_missing',
    message: `Role '${role}' did not emit terminal tool within ${maxToolTurns} turns.` });
  ```

## Category

inconsistency

## Severity

medium

## Transversality

cross-cutting

## Why this matters for the redesign

A contract verifier wants two clearly-named budgets: "how many free agent
turns before we interrupt and verify" and "how many verify-and-repair rounds
before we give up". The current shape has neither — it has a tool-turn
counter that fakes the first and a per-candidate retry counter that fakes the
second, with `contract_mismatch` welded between them. Naming and separating
these budgets is a precondition to talking about the new loop at all.
