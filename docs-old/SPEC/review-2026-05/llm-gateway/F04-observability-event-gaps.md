# F04 — Event payloads are missing the fields needed to debug LLM routing

## Summary

The three LLM-routing events declared in `event-catalog.ts` and validated in `validators.ts` are too thin to reconstruct an invocation post-mortem. `model_selected` lacks `attempt`; `invocation_succeeded` and `invocation_failed` lack `provider` and `model`. The emit sites in `AgentAdapter` pass extra diagnostic fields (`failureClass`, `recoveryAction`, `cooldownMs`, `capabilitySkipReasons`) but those are not declared in the schemas, so they are stripped if the writer validates outbound events.

## Evidence

Schema declarations:
- [src/schemas/event-catalog.ts#L49-L51](src/schemas/event-catalog.ts#L49)
```ts
model_selected:      payload({ session_id, provider, model, role })
invocation_succeeded: payload({ session_id, role, attempt, duration_ms })
invocation_failed:    payload({ session_id, role, attempt, error_message })
```
- [src/schemas/validators.ts#L164-L166](src/schemas/validators.ts#L164) — Zod schemas mirror the catalog (no `provider`/`model` on the succeeded/failed pair, no `attempt` on `model_selected`).
- [src/schemas/types.ts#L154-L156](src/schemas/types.ts#L154) — TypeScript types mirror the schemas.

Emit sites:
- [src/agents/agent-adapter.ts#L334-L335](src/agents/agent-adapter.ts#L334) — `model_selected` carries `{session_id, provider, model, role}`; `attempt` is omitted even though it is available in `recoveryCtx.attempt` two lines above.
- [src/agents/agent-adapter.ts#L399-L400](src/agents/agent-adapter.ts#L399) — `invocation_succeeded` carries `{session_id, role, attempt, duration_ms, failureClass, recoveryAction}`; `provider` and `model` are omitted. `failureClass`/`recoveryAction` are NOT in the schema and are stripped by the validator.
- [src/agents/agent-adapter.ts#L410-L411](src/agents/agent-adapter.ts#L410) — `invocation_failed` is the same shape plus `cooldownMs`, `retryDelayMs`, `capabilitySkipReasons` — all undeclared.

Operator-observed effect: the produced JSONL events show `provider=None`, `model=None`, `attempt=None` for the relevant kinds; they cannot be joined back to the failure to reconstruct what was tried.

## Category

architectural (specifically: schema-vs-emitter drift) and missing-diagnostics.

## Severity

medium — does not break runtime, but every other issue in this folder is much slower to investigate without it.

## Transversality

cuts across schemas, validators, types, and the adapter emit sites. Trivial mechanically but touches three coupled files.

## Recommended direction

- Extend the three event payloads with `provider: z.string()`, `model: z.string()`, `attempt: z.number()`, `failureClass`, `recoveryAction`, `cooldownMs?`, `retryDelayMs?`, `capabilitySkipReasons?` (the latter five only on the failed/succeeded pair).
- Update `event-catalog.ts`, `validators.ts`, `types.ts`, and any test snapshots in lockstep.
- Add one regression test that asserts the JSONL writer preserves the extra keys (this prevents future schema-vs-emitter drift).

## Cross-links

- F03 — `cooldownMs` and `cooldownUntilMs` should be added so operators can see why a candidate is parked.
- F08 — when the failure class table grows, every new class needs to round-trip through events; this fix is a prerequisite.
