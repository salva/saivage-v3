# F05 — Hardcoded `planner | executor | reviewer` taxonomy baked into the runtime

## Summary

The "envelope-bearing role" set is duplicated as a literal type in at least
five places, and the role-to-tool-name and role-to-schema lookups are global
constants. Adding a role, splitting executor by card type, or — more
importantly for the redesign — declaring the contract per invocation requires
forking every one of these maps. The runtime cannot say "this particular call
returns shape X" because shape is only addressable via the global role key.

## Evidence

- [role-envelope-schemas.ts#L51](src/agents/role-envelope-schemas.ts#L51) —
  baked role union and schema map:

  ```ts
  export type EnvelopeBearingRole = 'planner' | 'executor' | 'reviewer';
  export const ENVELOPE_SCHEMAS: Record<EnvelopeBearingRole, z.ZodTypeAny> = { ... };
  ```

- [role-result-tools.ts#L4](src/agents/role-result-tools.ts#L4) — role-to-tool
  name map and three pre-built tool definitions:

  ```ts
  export const ROLE_RESULT_TOOL_NAMES = {
    planner: 'emit_planner_result',
    executor: 'emit_executor_result',
    reviewer: 'emit_reviewer_result',
  } as const ...
  ```

- [agent-adapter.ts#L292](src/agents/agent-adapter.ts#L292) — adapter
  re-derives the same set inline every turn:

  ```ts
  const expectsEnvelope = role === 'planner' || role === 'executor' || role === 'reviewer';
  const envelopeRole = expectsEnvelope ? (role as EnvelopeBearingRole) : null;
  ```

- [contracts/llm-exchange.ts#L35](src/contracts/llm-exchange.ts#L35) —
  duplicate `TERMINAL_TOOL_NAMES` constant in the contracts layer.

- [llm-options-factory.ts#L15](src/agents/llm-options-factory.ts#L15) and
  [terminal-protocol.ts#L1](src/agents/terminal-protocol.ts#L1) repeat the
  same role discrimination.

## Category

leaky-abstraction

## Severity

high

## Transversality

architectural

## Why this matters for the redesign

A contract verifier wants `invokeAgent({ contract, tools, prompt, ... })`
where `contract` is a value passed in by the caller — schema, done signal,
unmet-obligation diff function. The current taxonomy makes the contract a
property of a global role string, which is the wrong granularity. Collapsing
the maps is a prerequisite to letting the surrounding flow (and not the
runtime) own the contract.
