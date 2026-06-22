# F03 — No "agent declares done" signal distinct from "runtime forces a tool emission"

## Summary

In the current design the only way an agent can finish is to call the
hardcoded `emit_planner_result` / `emit_executor_result` /
`emit_reviewer_result` tool with the full envelope inline. There is no
separate "I believe I am done, here is my candidate answer" signal — agent
intent ("done") and wire artefact ("structured envelope right now") are the
same event. As a consequence the runtime cannot distinguish "the agent
forgot the envelope" from "the agent never claimed to be done", and the
synthesised `continue` envelope for deferred `activate_card` (see F06) only
exists to paper over the missing signal in one specific case.

## Evidence

- [agent-adapter.ts#L335](src/agents/agent-adapter.ts#L335) — the only exit
  paths are "terminal tool seen, validate envelope" or "loop ran out, throw":

  ```ts
  if (envelopeRole && terminalToolName) {
    const terminalCall = toolCallsThisTurn.find((c) => c.function.name === terminalToolName);
    if (terminalCall) { ... finalEnvelope = envelope; break; }
  }
  ```

- [role-result-tools.ts#L20](src/agents/role-result-tools.ts#L20) — the
  terminal tool's description hard-codes "emit the result envelope as the
  final action of this turn", binding done-ness to envelope emission:

  ```ts
  description: `Emit the ${role} result envelope as the final action of this turn.`,
  ```

- [terminal-protocol.ts#L8](src/agents/terminal-protocol.ts#L8) — "no
  terminal tool" is treated as a hard contract error rather than "not done
  yet".

## Category

bad-design

## Severity

high

## Transversality

architectural

## Why this matters for the redesign

The target model needs a cheap signal ("I am done, please verify") that the
runtime can then evaluate against the contract — possibly synthesising the
envelope from the conversation, possibly asking the agent to fill in gaps,
possibly accepting the agent's own envelope. Without a done signal that is
separate from the envelope itself, the verifier-and-repair loop has no
trigger.
