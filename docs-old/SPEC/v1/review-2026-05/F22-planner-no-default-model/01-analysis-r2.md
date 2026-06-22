# F22 — Analysis r2

## Root cause

Neither (a) "ordering race" nor (b) "missing sibling fallback" describes the real defect. The audited chain is **synchronously sequenced** — config is fully parsed by [`loadEnvironment`](../../../src/config/environment.ts#L177-L228) before any agent is wired — and [`getModelListForRole`](../../../src/agents/config-schema.ts#L399-L427) already implements a `models.default` fallback. The defect is a **boot-time validation gap**: configuration completeness for the dispatched roles is *never* asserted at boot. The first code path that learns the config is incomplete is the resolver, deep inside agent dispatch, and it surfaces as an `errors.jsonl` line on the first planner cycle.

This is variant (b) with a precise diagnosis: the fallback chain is `models.planner → routing/profiles → models.default → throw`. If the operator's `.saivage/saivage.json` does not contain `models.planner` **and** does not contain `models.default`, every planner dispatch throws.

## Why the "first cycle fails, subsequent succeed" observation is not explainable in-process

- `SaivageConfig` is wrapped in a deeply frozen `Environment` ([src/config/environment.ts](../../../src/config/environment.ts#L228)). It cannot be mutated post-load.
- `AgentAdapter.config` is assigned once in the constructor ([src/agents/agent-adapter.ts](../../../src/agents/agent-adapter.ts#L173-L178)) and never reassigned. No `setConfig` method exists.
- `ModelRouter.config` is captured once in its constructor.
- `rg "setConfig|reloadConfig|refreshConfig|updateConfig" src/runtime src/agents` returns zero hits; `readConfigFile` is only called from `loadEnvironment`.

Therefore if `getModelListForRole(config, 'planner')` throws on call N, it throws on call N+1 with the same input. **Success after failure for the same process and same project requires a restarted/new process, a different project, or a different config file path** — there is no in-process mechanism that can make the resolver start returning a list it previously rejected. We do not speculate about how that re-load happened; the only architectural conclusion is that the runtime must refuse to start when the dispatched roles are unconfigured, so the operator never observes a "first cycle fails" state at all.

## Concrete code citations

### (i) Resolver call sites

[src/agents/config-schema.ts#L399-L427](../../../src/agents/config-schema.ts) — `getModelListForRole(config, role)`:

```ts
const direct = (models as Record<string, unknown>)[role];
if (Array.isArray(direct)) return direct as string[];
if (models.routing && models.profiles) { /* profile lookup */ }
if (models.default) return models.default;
throw new Error(`No model list configured for role '${role}' and no default.`);
```

This is the **only** throw site that matches the `errors.jsonl` string.

Called from [src/agents/model-router.ts#L53](../../../src/agents/model-router.ts). `ModelRouter.resolve` is invoked by [src/agents/agent-adapter.ts#L453](../../../src/agents/agent-adapter.ts) and [src/agents/agent-adapter.ts#L477](../../../src/agents/agent-adapter.ts) — i.e. on every planner / executor / reviewer / analyst dispatch.

### (ii) Config-load completion signal

[src/config/environment.ts#L177-L228](../../../src/config/environment.ts) — `loadEnvironment(argv, env)` is **synchronous**. It reads `saivage.json`, runs Zod validation through `saivageConfigSchema.safeParse(...)`, and returns a deeply frozen `Environment`. There is no async completion promise; the function either returns a fully validated `Environment` or throws `EnvironmentLoadError`.

[src/agents/config-schema.ts#L62-L117](../../../src/agents/config-schema.ts) — `modelsSectionSchema`: every per-role key (`planner`, `executor`, `reviewer`, `analyst`, `manager`, `coder`, `researcher`, `data_agent`, `inspector`, `chat`, `default`) is `.optional()`. Combined with [src/agents/config-schema.ts#L228-L237](../../../src/agents/config-schema.ts) defaulting `models` to `{}`, the schema accepts a `models = {}` config without error.

### (iii) Wiring order in `boot/app.ts` / `server.ts`

[src/boot/app.ts#L16-L19](../../../src/boot/app.ts):

```ts
const environment = loadEnvironment(options.argv, options.env ?? process.env);
const scope = createResourceScope('app');
const server = await startServer({ environment, createRuntime: options.createRuntime, scope: scope.child('server') });
```

`loadEnvironment` returns (or throws) **before** `startServer` is awaited.

[src/server/server.ts#L108](../../../src/server/server.ts) — inside the awaited `startServer` flow, an existing `try/catch` wraps `new ActiveRuntime(...)` / `activeRuntime.start()`, swallowing failures into a `runtimeStartupFailure` record so the API stays up in degraded mode. That catch is the wrong attach point for this fix: a missing-role precondition violation must abort boot, not run the server with no runtime.

### (iv) Dispatched-role universe

[src/agents/agent-adapter.ts#L40](../../../src/agents/agent-adapter.ts):

```ts
export type AgentRole = 'planner' | 'executor' | 'reviewer' | 'analyst';
```

These four roles are the entirety of `router.resolve(role, ...)` traffic from `invokeAgent`. The other schema role keys (`manager`, `coder`, `researcher`, `data_agent`, `inspector`, `chat`) are accepted by the schema but never reach the resolver in current code.

## Verdict

- Not a race. The audited sync chain ([src/boot/app.ts#L16-L19](../../../src/boot/app.ts) → [src/server/server.ts#L108](../../../src/server/server.ts) → [src/runtime/active-runtime.ts#L45-L70](../../../src/runtime/active-runtime.ts) → [src/agents/agent-adapter.ts#L173-L178](../../../src/agents/agent-adapter.ts)) precludes one.
- Real defect: **`saivageConfigSchema` accepts a `models` object missing the dispatched roles**, and the resolver's throw is the only enforcement point. Operators only learn the config is incomplete via `errors.jsonl` on the first planner cycle.
- The fix is fail-fast inside `loadEnvironment` itself — refuse to return an `Environment` when `models[r]` is unconfigured for any `r ∈ AgentRole` and there is no usable `models.default`/profile route. That guarantees `loadEnvironment` throws before `startApp` ever awaits `startServer`, so `saivage-v3-getrich.service` enters `failed` cleanly with no half-started server.

## Scope note: "15 roles" in issue text

[`00-issue.md`](00-issue.md) refers to "all 15 roles explicitly populated". `modelsSectionSchema` enumerates 10 per-role keys plus `default` (11 declared keys). Only **4** are dispatched today by `AgentRole` at [src/agents/agent-adapter.ts#L40](../../../src/agents/agent-adapter.ts). Unknown raw keys (e.g. operator-typed `manager_v2`) are silently stripped by Zod's default behaviour and never reach `validateModelRoles`, so this finding can only assert correctness for the 4 dispatched runtime roles.

**Explicit scope statement:** F22 validates the 4 currently-dispatched roles only. It does **not** prove the operator/dashboard 15-role surface is correct, and it does **not** widen the schema. Any operator-facing 15-role surface (and any contract that unknown raw `models` keys should be rejected rather than silently stripped) is **out of scope** here and tracked as a separate follow-up against the operator dashboard / `modelsSectionSchema` strictness, not against the runtime boot path.
