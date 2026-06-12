# F04 Combined Doc r2 Review

## Findings

1. **Blocker: the proposed strict registry path is incompatible with the summary `.superRefine(...)` shape.**

   r2 correctly tries to close the r1 schema-drift blocker by adding strict registry entries and a strict-preserving `buildLoggedEventSchema` path ([COMBINED-r2.md#L92](COMBINED-r2.md#L92), [COMBINED-r2.md#L252](COMBINED-r2.md#L252)). However, the same plan says `llm_invocation_summary`'s conditional fields are enforced by `.superRefine(...)` ([COMBINED-r2.md#L177](COMBINED-r2.md#L177), [COMBINED-r2.md#L240](COMBINED-r2.md#L240)). In Zod, `.superRefine(...)` wraps the object in `ZodEffects`, while the proposed builder still extracts `(entry.schema as z.AnyZodObject).shape` just like the current implementation does ([src/schemas/event-catalog.ts#L96](../../../src/schemas/event-catalog.ts#L96)). That means the r2 schema path either cannot build the logged-event schema for `llm_invocation_summary`, or it forces implementers to drop the conditional refinement from the registry-derived path. This reopens the exact end-to-end strictness blocker r2 claims to close.

   Required correction: make the registry store payload shape separately from refinements, or teach `buildLoggedEventSchema` to compose a strict base object with an optional per-kind refinement without relying on `.shape` after `.superRefine(...)`. The tests should include the catalog-derived `loggedEventSchema` and `loggedEventSchemaByKind.llm_invocation_summary` rejecting both unknown keys and invalid verdict/final-field combinations.

## Advisory Notes

- `llm_invocation_summary.attempts_count` should count emitted `llm_attempt` rows, not `invokeWithRecovery` wrapper attempts. r2's B2 text says to compute it from `attempts.length` ([COMBINED-r2.md#L286](COMBINED-r2.md#L286)), but its failover test expects three candidate HTTP failures to produce `attempts_count=3`; one outer recovery attempt can contain multiple candidate HTTP calls. Keep a local `attemptOutcomeCount` incremented by `recordAttemptOutcome` and use that for the summary.
- The architecture-first posture is otherwise aligned: old event kinds are deleted, the retry double-emission is fixed by a single `recordAttemptOutcome` boundary, web consumers are migrated, and the F05 terminal-tool mapping remains conceptually consistent.

## Coverage Check

- Clean architecture: strong direction, blocked only by the strict-schema composition issue above.
- Zero backward compatibility: satisfied; no dual emit, alias, or translator survives.
- F05 consistency: satisfied at the design level; `terminal_tool` moves naturally into `llm_attempt.outcome.kind === 'succeeded'`.

VERDICT: CHANGES_REQUESTED