# F01 — Per-turn "tools vs terminal" phase machinery is dead architecture

## Summary

The runtime carries a two-phase type system (`LlmRolePhase = 'tools' |
'terminal'`) with strict invariants that the adapter never exercises. The hot
path always calls `buildLlmOptions(role, 'tools', ...)` and appends the
terminal `emit_*_result` tool to the regular tool list every turn. The
"terminal" branch of the factory exists only to fail loudly when misused. This
is a leftover from a forced last-turn protocol that the tactical patch in
commit `a2a6f05` superseded, and it keeps the codebase shaped around the wrong
mental model.

## Evidence

- [llm-options-factory.ts#L17](src/agents/llm-options-factory.ts#L17)
  defines the phase split and the terminal-only branch:

  ```ts
  export type LlmRolePhase = 'tools' | 'terminal';
  // ...
  if (phase === 'tools') { ... return opts; }
  // phase === 'terminal'
  if (!isEnvelopeBearing(role)) { throw new Error(...); }
  ```

- [agent-adapter.ts#L297](src/agents/agent-adapter.ts#L297) only ever uses
  the `'tools'` phase and merges the terminal tool with the rest:

  ```ts
  const turnTools = terminalToolDef ? [...tools, terminalToolDef] : tools;
  const llmOpts = buildLlmOptions(role, 'tools', turnTools, ...);
  ```

- [llm-contracts.ts#L38](src/agents/llm-contracts.ts#L38) keeps a
  `LlmCompleteOptionsTerminal` member of the discriminated union that no
  production code constructs; downstream gateways must still branch on it.

## Category

dead-code

## Severity

medium

## Transversality

cross-cutting

## Why this matters for the redesign

A contract-verifier model wants a single, uniform turn shape ("here are the
tools, here is the contract") and a separate post-hoc verifier. Keeping
`LlmRolePhase`, `LlmCompleteOptionsTerminal`, `terminalToolName`,
`terminalToolDefinition`, and `deriveTerminalTool` alive forces every transport
gateway and every test fixture to keep handling a phase distinction that
should not exist. Removing it is a precondition for declaring the contract at
invocation construction time instead of per turn.
