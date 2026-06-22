# F22 — Design r2

## Decision

**Fail-fast inside `loadEnvironment`** ([src/config/environment.ts](../../../src/config/environment.ts#L177-L228)), **before** the frozen `Environment` is returned and therefore **before** `startApp` ([src/boot/app.ts#L16-L19](../../../src/boot/app.ts)) ever awaits `startServer`. A missing dispatched-role model list causes `loadEnvironment` to throw `EnvironmentLoadError`. `startApp` does not catch this; the Node process exits non-zero; `systemd` marks `saivage-v3-getrich.service` as `failed`. **No degraded-runtime path. No catch in `server.ts` that swallows model-role precondition failures.**

## Alternatives

### A. Fail-fast in `loadEnvironment` (chosen)

Extend [src/config/environment.ts](../../../src/config/environment.ts#L177-L228) so that, after the candidate `Environment` passes `environmentSchema.safeParse` and before `deepFreeze` returns, it calls `validateModelRoles(config)`. If the result is `{ ok: false, missingRoles }`, the function throws `EnvironmentLoadError` with a `field: 'models.<role>'` diagnostic naming every missing role. The throw propagates synchronously through `loadEnvironment` → `startApp` → `process.exit(non-zero)`.

**Architecture-first match:** configuration completeness becomes a `loadEnvironment` precondition — same tier as "valid JSON", "schema-shaped object", "environment validation". Once `loadEnvironment` returns, the runtime is contractually guaranteed to have model lists for every dispatched role; the resolver throw at [src/agents/config-schema.ts#L427](../../../src/agents/config-schema.ts) becomes structurally unreachable in production for any `r ∈ AgentRole`.

**Why not `ActiveRuntime.open`:** the existing `server.ts:108` `try { … new ActiveRuntime(...) } catch { runtimeStartupFailure = ... }` block ([src/server/server.ts#L108](../../../src/server/server.ts)) swallows construction failures so the API stays up in degraded mode. Validating inside `ActiveRuntime` makes the missing-role error indistinguishable from any other runtime startup glitch, leaves `/api/runtime/status` reachable, and lets `systemctl is-active` report `active`. That is the opposite of the fail-fast contract this finding requires. Doing the validation one layer up (inside `loadEnvironment`) is strictly cleaner: a single throw at the right boundary, no edits to the `server.ts:108` catch, and the existing `try/catch` keeps its narrow purpose (genuine runtime startup faults like filesystem errors, never config preconditions).

### B. Deterministic ordering — block planner dispatch until config-load promise resolves

Add an explicit `configReady: Promise<SaivageConfig>` on `ActiveRuntime` and `await` it in `dispatchGoal`. The audit in [01-analysis-r2.md](01-analysis-r2.md#why-the-first-cycle-fails-subsequent-succeed-observation-is-not-explainable-in-process) shows the synchronous chain already enforces ordering, so this gate is dead weight: it adds a new failure mode (promise-not-awaited bugs) and does not eliminate the underlying defect (a `models = {}` config still parses, and the first dispatch still throws — just slightly later).

**Verdict:** rejected. B treats a phantom race. A addresses the real architectural omission at the right boundary.

## Roles validated

The dispatched four — `planner`, `executor`, `reviewer`, `analyst` — i.e. the entirety of `AgentRole` at [src/agents/agent-adapter.ts#L40](../../../src/agents/agent-adapter.ts). Scope note from [01-analysis-r2.md](01-analysis-r2.md#scope-note-15-roles-in-issue-text): F22 does not validate the operator-facing 15-role surface and does not widen the schema.

A role `r` is "configured" iff **any** of:

1. `config.models[r]` is a non-empty array, **or**
2. `config.models.routing?.[r]` names a profile in `config.models.profiles` whose `preferred ∪ allowed` is non-empty, **or**
3. `config.models.default` is a non-empty array.

If none of these holds for some `r ∈ AgentRole`, validation fails and `loadEnvironment` throws.

## Error surface

`EnvironmentLoadError` is the existing throw type for `loadEnvironment`, and the failure must look like every other config precondition violation. Concrete shape (final):

```
Configuration validation failed: missing model role(s): planner, executor.
  models.planner = (unset) — set "models.planner" to a non-empty string[] in .saivage/saivage.json
  models.executor = (unset) — or set "models.default" as a shared fallback
Roles defined in this config: reviewer = ["gpt-4.1"], analyst = ["gpt-4.1"]
```

- Thrown via `new EnvironmentLoadError(message, { field: 'models.' + firstMissing, expected: 'non-empty string[] or models.default', received: 'unset', source: 'file' })` so it carries the same metadata shape as adjacent throws in [src/config/environment.ts](../../../src/config/environment.ts#L172-L228).
- Propagation: `loadEnvironment` throws → `startApp` does not catch → Node exits non-zero → `saivage-v3-getrich.service` enters `failed`.
- **No code in `server.ts` is added or changed.** The existing `try/catch` at [src/server/server.ts#L108](../../../src/server/server.ts) is irrelevant: by the time `startServer` would run, `loadEnvironment` has already thrown.
- **No `/api/runtime/status` surface.** The HTTP server never starts, so the missing-role case is not observable through any API. Diagnostics are systemd / journalctl only — the right channel for a boot precondition failure.

## What survives, what dies

- **Survives** (as defence-in-depth invariant): the throw at [src/agents/config-schema.ts#L427](../../../src/agents/config-schema.ts). After this fix, `validateModelRoles` guarantees boot never reaches that throw for `r ∈ AgentRole`. The throw still guards unknown role strings (e.g. a future code path calling `getModelListForRole(config, 'oracle')`). Kept as-is. **No new comment, no message change** — workspace guideline forbids adding docstrings/comments in untouched code, and the invariant is carried by tests + this design doc.
- **No dead code to delete.** Audit (`rg "setConfig|reloadConfig|refreshConfig|updateConfig" src/runtime src/agents`) returned zero hits — no stale hot-reload paths to remove.
- **No new fallback chain.** No "default to gpt-4.1", no "guess from first defined role". Fail-fast only.

## Non-goals

- Do **not** validate provider availability for the listed models here (separate concern; lives in provider registry health checks).
- Do **not** widen `modelsSectionSchema` to accept additional role names (out of scope per [01-analysis-r2.md scope note](01-analysis-r2.md#scope-note-15-roles-in-issue-text)).
- Do **not** add Zod strict mode for the `models` object in this finding (separate follow-up against schema strictness; tracked as a future ticket against the operator-dashboard / `modelsSectionSchema` surface).
- Do **not** introduce a `configReady` promise or any boot synchronization primitive.
- Do **not** add a catch in `server.ts` that turns a missing-role precondition failure into a degraded-runtime startup record. The whole point is that the process exits.
