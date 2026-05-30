# F07 — System prompts disagree with the runtime contract about how to return

## Summary

The planner / executor / reviewer system prompts instruct the agent to "return
a single JSON object" wrapped in a triple-backtick `json` code block, but the
runtime only ever accepts a structured tool call to `emit_*_result`. Nothing
in the prompt tells the agent that a tool call is required, nor names the
terminal tool, nor describes what happens when the contract is not met. The
match between prompt and contract is implicit at best, and the operator's
trigger case (a planner that returned plain text) is the natural failure mode.

## Evidence

- [system-prompt.ts#L67](src/agents/system-prompt.ts#L67) — planner prompt
  asks for raw JSON, not a tool call:

  ```ts
  Your response MUST be a single JSON object with the fields below.
  Wrap it in a \`\`\`json code block or return raw JSON.
  ```

- [system-prompt.ts#L139](src/agents/system-prompt.ts#L139) — executor prompt
  uses the same pattern; reviewer prompt at L209 likewise.

- The runtime contract is the tool definition built in
  [role-result-tools.ts#L21](src/agents/role-result-tools.ts#L21)
  (`emit_${role}_result`); the prompt never mentions that name.

- [agent-role-runner.ts#L36](src/agents/agent-role-runner.ts#L36) — the only
  per-invocation prompt mutation is `applySelfCheck`, which is unrelated to
  the return contract.

## Category

inconsistency

## Severity

high

## Transversality

cross-cutting

## Why this matters for the redesign

The verifier-and-repair model only works if the agent knows what it is being
asked to return. The redesign needs to drive the prompt-side contract
documentation from the same source of truth as the runtime-side verifier —
schema, done-signal name, repair-message format — and stop hand-writing the
JSON shape in three places that drift independently of the schema.
