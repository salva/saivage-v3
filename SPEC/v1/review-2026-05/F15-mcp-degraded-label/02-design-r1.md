# F15 — Design (round 1)

## Goal

Stop reporting `degraded` for the "no MCP servers configured" condition. Reserve `degraded` for genuine impairment.

## Chosen design — extend the enum with `idle`

Add a fifth value, `idle`, to `AvailabilityState` and emit it from the empty-MCP branch in `buildServerAvailability`. Keep the diagnostic `{ code: 'mcp-manager-empty', summary: ... }` so operators retain machine-readable context, but rephrase the summary as a configuration statement, not a fault.

### New enum

```ts
// src/contracts/operator-api.ts
export const AvailabilityStateSchema = z.enum([
  'available',   // component is healthy and serving
  'degraded',    // component is configured but not fully functional
  'idle',        // component is intentionally inactive (e.g. no MCP servers configured)
  'unavailable', // component failed to start or is in a hard-fault state
  'unknown',     // state could not be determined
]);
```

### Classifier change

```ts
// src/server/availability.ts
mcp = hasRunning
  ? { state: 'available', source: 'mcp-manager', checkedAt }
  : hasConfigured
    ? { state: 'degraded', source: 'mcp-manager', checkedAt }
    : {
        state: 'idle',
        source: 'mcp-manager',
        checkedAt,
        diagnostic: { code: 'mcp-manager-empty', summary: 'No MCP servers configured.' },
      };
```

`degraded` continues to mean "servers are configured but none are currently running" — a real fault. `idle` means "no servers were ever configured" — by design.

### Diagnostic semantics

- `idle` components MAY carry a diagnostic explaining *why* they are idle. The diagnostic code stays `mcp-manager-empty` so existing log greps still match.
- Other components (`api`, `runtime`) never emit `idle` today. The enum is global because the schema is shared, but only the MCP branch produces it.

## Why `idle` and not `unconfigured` / `disabled` / `optional`

- `unconfigured` reads as a setup defect; the GetRich v2 deployment is intentionally MCP-free.
- `disabled` implies someone toggled it off; configuration absence is the default, not an opt-out.
- `optional` is not a state, it is a property of the component.
- `idle` is symmetric with how runtime exposes activity ("idle" runtime exists in this repo's vocabulary already — see `cue-idle` CSS in `web/dist/assets/index-BAXz35uL.css` and `statusLabel === 'idle'` patterns in `web/src/stores/runtime.ts`), so operators won't need new mental models.

## Consumer updates

1. **Web type mirror** — [web/src/api/types.ts:550](../../../web/src/api/types.ts#L550): add `'idle'` to the `AvailabilityState` union.
2. **Dashboard label builder** — [web/src/stores/runtime.ts:113-120](../../../web/src/stores/runtime.ts#L113-L120): add an `idle` branch for the MCP component that emits no banner text (operators don't need to be told their explicit configuration is correct). Concretely:
   ```ts
   if (mcpComponent.state === 'unavailable') parts.push(...);
   else if (mcpComponent.state === 'degraded') parts.push(...);
   else if (mcpComponent.state === 'unknown') parts.push('MCP startup availability is unknown.');
   // idle: no message. The component is intentionally inactive.
   ```
   The runtime component does not need an `idle` branch (it never emits `idle`).
3. **Tests** — update the two pinning tests to expect `state: 'idle'` and the new summary, and add a new assertion that `degraded` is *not* emitted for the empty case.
4. **Docs** — extend the enum documentation in [docs/operation.md:75](../../../docs/operation.md#L75) and rewrite the prose at [docs/operation.md:241](../../../docs/operation.md#L241) to describe four distinguishable states (startup-failure → `unavailable`, not-attempted → `unknown`, empty → `idle`, running-but-impaired → `degraded`).

## Contracts (operator API)

- `AvailabilityStateSchema` adds `'idle'`. Zod validators in `web/src/api/contracts.ts` re-import from the operator-api package and so pick up the new value automatically.
- No new fields. Diagnostic shape (`{ code, summary }`) is unchanged.
- This is a **breaking** change to consumers that pattern-match on the enum — accepted per workspace policy (no backward compatibility). External monitors that alert on `state !== 'available'` will now stop firing for MCP-idle, which is the intended fix.

## Alternatives considered (and rejected)

### Alt A — Move the empty case to `available`

Reasoning: "no servers configured" is the configured equilibrium, so the server *is* available.

Rejected because:
- A consumer probing whether MCP can answer a tool call would interpret `available` as "yes, ask it", but with zero servers no answer is possible. `available` should mean "I can serve".
- Loses the `mcp-manager-empty` diagnostic distinction once an external tool consumes only `state`.

### Alt B — Keep `degraded`, only change the summary string

Reasoning: minimum churn, just tell operators it's fine.

Rejected because it doesn't fix the actual bug (monitors keyed on the enum), it only treats the symptom. Violates the architecture-first / no-shim policy.

### Alt C — Drop the MCP component entirely when empty

Reasoning: if there are no servers, there is nothing to report.

Rejected because the component map is contract-shape: api/runtime/mcp are all required keys per [src/contracts/operator-api.ts:120-123](../../../src/contracts/operator-api.ts#L120-L123). Making `mcp` optional cascades into every consumer and erases the diagnostic.

### Alt D — Split into two booleans (`configured`, `running`) on the diagnostic

Rejected: violates the established enum-driven contract used by `api` and `runtime`. Asymmetry adds complexity for no gain.

## Out of scope

- Re-classifying `runtime: degraded` (the `readRuntimeState`-only fallback at [src/server/availability.ts:67-69](../../../src/server/availability.ts#L67-L69)). That semantics is correct: persisted-state fallback without an in-process runtime *is* a degraded situation. F15 only touches MCP.
- MCP manager internals (`src/mcp/mcp-manager.ts`). The fix lives entirely in the classifier + enum.
- Adding alerting rules. Out-of-band operator concern.
