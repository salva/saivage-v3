# F22 — Design r1

## Alternatives

### A. Fail-fast validation at boot (recommended)

Validate role-model completeness **once, synchronously, immediately after `loadEnvironment` returns** and **before any agent runtime / dispatch wiring**. If validation fails, the boot throws `EnvironmentLoadError`-equivalent with a diagnostic that names every missing role; `systemd` reports a clean unit failure; nothing in `errors.jsonl` because the runtime never starts.

**Architecture-first match:** configuration completeness becomes a boot precondition — same tier as "valid JSON", "schema-shaped object". Once boot succeeds, the resolver's defence-in-depth throw at [src/agents/config-schema.ts#L426](../../../src/agents/config-schema.ts) is unreachable in production; it survives only as an internal invariant.

**Scope:**

- Add `validateModelRoles(config: SaivageConfig): { ok: true } | { ok: false; missingRoles: string[] }` in `src/config/`.
- Call it from `ActiveRuntime.open` (F13 r5 async factory) right after the `config` non-null check, before constructing `EventLogger`, `AgentAdapter`, or `ModelRouter`.
- Existing tests at [tests/agents/config-schema.test.ts#L348](../../../tests/agents/config-schema.test.ts) (which exercise the throw inside `getModelListForRole`) stay valid as invariant-level tests.

**Roles validated (the dispatched four):**

`planner`, `executor`, `reviewer`, `analyst` — the entirety of `AgentRole` at [src/agents/agent-adapter.ts#L40](../../../src/agents/agent-adapter.ts). These are the only roles that flow into `router.resolve` from `invokeAgent`.

A role `r` is considered "configured" iff **any** of:

1. `config.models[r]` is a non-empty array, **or**
2. `config.models.routing?.[r]` names a profile present in `config.models.profiles` whose `preferred ∪ allowed` is non-empty, **or**
3. `config.models.default` is a non-empty array.

If none of the four roles satisfies any condition (and there is no `default`), the result is `{ ok: false, missingRoles: ['planner', 'executor', 'reviewer', 'analyst'] }`.

**Error message format (final form):**

```
Saivage config is missing model lists for required role(s): planner, executor.
  models.planner = (unset)        — set "models.planner" to a non-empty string[] in .saivage/saivage.json
  models.executor = (unset)       — or set "models.default" as a shared fallback
Roles defined in this config: reviewer = ["gpt-4.1"], analyst = ["gpt-4.1"]
Fix the config and restart the service. See SPEC §models.
```

The message lists (1) each missing role explicitly, (2) the existing role coverage so operators can copy-paste, (3) the canonical fix (file path + restart). One log line at `ERROR` plus the thrown error body — no stack trace fluff.

**Discrepancy with issue "15 roles":** the issue claims operator filled 15 role slots. `modelsSectionSchema` only ships 10 per-role keys; the extra 5 (whatever they are) are dropped silently by Zod. We do **not** widen the schema in this finding — out of scope, and would mask the operator-input bug. The diagnostic message above gives operators direct evidence: "Roles defined in this config: ..." shows them exactly what the schema accepted, so an operator who typed `manager_v2` and got nothing back will see immediately.

### B. Deterministic ordering — block planner dispatch until config-load promise resolves

Add an explicit `configReady: Promise<SaivageConfig>` field on `ActiveRuntime`. Have `Runtime.dispatchGoal` `await` it before any `invokePlanner` call. Wire `ActiveRuntime.open` to resolve the promise after assigning `this._config`.

**Cost vs benefit:** the audit in [SPEC/v1/review-2026-05/F22-planner-no-default-model/01-analysis-r1.md](01-analysis-r1.md) §"Why first-cycle-fails-subsequent-succeed is not explainable in-process" shows the synchronous chain already enforces this ordering. Adding an `await` gate is dead weight — it lengthens the boot path, adds a new failure mode (promise-not-awaited bugs), and **does not eliminate the underlying defect** (a `models = {}` config still parses and dispatches still throw, just slightly later). Empty role lists remain a silent fault until the first agent call.

**Verdict:** rejected. B treats a phantom race; A addresses the real architectural omission.

## Recommendation

**A.** No backward compatibility for the silent-empty-`models` config — refuse to start. Per workspace guideline "Architecture-first, no backward compatibility / Fail-fast over silent fallback", this is the right shape.

## What survives, what dies

- **Survives** (as internal invariant): the throw at [src/agents/config-schema.ts#L426](../../../src/agents/config-schema.ts), but with a comment `// Invariant: validateModelRoles enforces this at boot. Reachable only on bypass.` and no message-format changes.
- **Dies in production usage**, kept as invariant trap: same throw site. Tests at [tests/agents/config-schema.test.ts#L348](../../../tests/agents/config-schema.test.ts) keep coverage of the invariant.
- **No new fallback chain.** No "default to gpt-4.1", no "guess from first defined role". Fail-fast.

## Non-goals

- Do **not** validate provider availability for the listed models here (separate concern; lives in provider registry health checks).
- Do **not** widen `modelsSectionSchema` to accept new role names — the "15 roles" mismatch in the issue is an operator-input symptom, not the bug we're fixing.
- Do **not** introduce a `configReady` promise or any new boot synchronization primitive.
