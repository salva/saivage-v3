# F22 — Analysis r1

## Root cause

Neither (a) "ordering race" nor (b) "missing sibling fallback" describes the real defect. The audited code path is **synchronously sequenced** — config is fully parsed by `loadEnvironment` before any agent is wired — and the resolver `getModelListForRole` already implements a `models.default` fallback. The defect is a **boot-time validation gap**: configuration completeness for the dispatched roles is *never* asserted at boot. The first code path that learns the config is incomplete is the resolver, deep inside agent dispatch, and it surfaces as an `errors.jsonl` line on the first planner cycle.

This is variant (b) with a precise diagnosis: the fallback chain is `models.planner → routing/profiles → models.default → throw`. If the operator's `.saivage/saivage.json` does not contain `models.planner` **and** does not contain `models.default`, every planner dispatch throws. The "subsequent cycles succeeded" observation in [SPEC/v1/review-2026-05/F22-planner-no-default-model/00-issue.md](../F22-planner-no-default-model/00-issue.md) cannot be reproduced by the audited in-process state machine — no code path mutates the `SaivageConfig` after `ActiveRuntime` construction (see "no race" evidence below). The most plausible real-world explanation is that the operator wrote `models.planner` to `saivage.json` between the first and the second planner cycle, then the resolver started returning it. Either way the structural defect is the same: **configuration completeness is checked lazily, per-call, by throwing.**

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

This is the **only** throw site that matches the `errors.jsonl` string ([grep result](#)).

Called from [src/agents/model-router.ts#L53](../../../src/agents/model-router.ts):

```ts
async resolve(role: string, request?: CapabilityRequest): Promise<Candidate[]> {
  ...
  const modelList = getModelListForRole(this.config, role);
```

`ModelRouter.resolve` is invoked by [src/agents/agent-adapter.ts#L453](../../../src/agents/agent-adapter.ts) and [src/agents/agent-adapter.ts#L477](../../../src/agents/agent-adapter.ts), both inside `invokeAgent` — i.e. on every planner / executor / reviewer / analyst dispatch.

### (ii) Config-load completion signal

[src/config/environment.ts#L177-L227](../../../src/config/environment.ts) — `loadEnvironment(argv, env)` is **synchronous**. It reads `saivage.json`, runs Zod validation through `saivageConfigSchema.safeParse(...)`, and returns a frozen `Environment`. There is no async completion promise; the function either returns a fully validated `Environment` or throws `EnvironmentLoadError`.

[src/agents/config-schema.ts#L62-L117](../../../src/agents/config-schema.ts) — `modelsSectionSchema`: every per-role key (`planner`, `executor`, `reviewer`, `analyst`, `manager`, `coder`, `researcher`, `data_agent`, `inspector`, `chat`, `default`) is marked `.optional()`. The schema validates **fine** when `models = {}` is on disk; nothing in the schema enforces that the four dispatched roles have model lists.

### (iii) Wiring order in `active-runtime.ts` / `server.ts`

[src/boot/app.ts#L19-L21](../../../src/boot/app.ts):

```ts
const environment = loadEnvironment(options.argv, options.env ?? process.env);
const scope = createResourceScope('app');
const server = await startServer({ environment, createRuntime: options.createRuntime, scope: scope.child('server') });
```

`loadEnvironment` returns before `startServer` is awaited — **no race**.

[src/server/server.ts#L108](../../../src/server/server.ts) — inside the awaited `startServer` flow:

```ts
if (createRuntime) {
  try {
    activeRuntime = new ActiveRuntime(projectRoot, saivageConfig);
    await activeRuntime.start();
    ...
```

[src/runtime/active-runtime.ts#L46-L70](../../../src/runtime/active-runtime.ts):

```ts
if (!config) throw new Error('ActiveRuntime requires validated SaivageConfig from Environment.');
this._config = config;
...
this._agentAdapter = new AgentAdapter({ projectRoot, saivageDir, config: this._config, eventLogger: this._eventLogger });
```

[src/agents/agent-adapter.ts#L173-L178](../../../src/agents/agent-adapter.ts):

```ts
this.config = cfg.config;
...
this.router = new ModelRouter(cfg.config, this.registry, cfg.projectRoot);
```

The `SaivageConfig` reference flows: `loadEnvironment` (sync) → `ActiveRuntime` ctor → `AgentAdapter` ctor → `ModelRouter` ctor. **No async hand-off, no post-construction config mutation** anywhere on this chain (`rg "setConfig|reloadConfig|refreshConfig|updateConfig"` returns zero hits in `runtime/` and `agents/`).

### (iv) Dispatched-role universe

[src/agents/agent-adapter.ts#L40](../../../src/agents/agent-adapter.ts):

```ts
export type AgentRole = 'planner' | 'executor' | 'reviewer' | 'analyst';
```

Only these four roles ever flow into `router.resolve(role, ...)` from `invokeAgent`. The other schema role keys (`manager`, `coder`, `researcher`, `data_agent`, `inspector`, `chat`) are accepted by the schema but never reach the resolver in current code — they are dead config surface for now.

## Why "first cycle fails, subsequent succeed" is not explainable in-process

- `SaivageConfig` is a deeply frozen object ([src/config/environment.ts#L228](../../../src/config/environment.ts) — `deepFreeze`). It cannot be mutated.
- `AgentAdapter.config` is assigned once in the constructor and never reassigned. No `setConfig` method exists.
- `ModelRouter.config` is captured once in its constructor.
- Therefore: if `getModelListForRole(config, 'planner')` throws on call N, it throws on call N+1 with the same input. The only way subsequent cycles succeed is if `saivage.json` is rewritten **on disk** by another process **and** the server is restarted, OR a separate codepath we haven't seen reloads the config.

`rg "saivageConfigSchema|readConfigFile" src/` confirms `readConfigFile` is only called from `loadEnvironment`, which only runs in `startApp` boot. There is no live reload.

## Verdict

- Not a race. The audited sync chain ([src/boot/app.ts#L19](../../../src/boot/app.ts) → [src/server/server.ts#L108](../../../src/server/server.ts) → [src/runtime/active-runtime.ts#L67](../../../src/runtime/active-runtime.ts) → [src/agents/agent-adapter.ts#L178](../../../src/agents/agent-adapter.ts)) precludes one.
- Real defect: **`saivageConfigSchema` accepts a `models` object missing the dispatched roles**, and the resolver's throw is the only enforcement point. Operators only learn the config is incomplete via `errors.jsonl` on the first planner cycle.
- The fix that actually addresses the architecture (not the symptom) is fail-fast at boot — refuse to start the server when `models[r]` is unconfigured for any `r ∈ AgentRole` and `models.default` is absent. F13 r5's switch to `Runtime.open` factory is the natural attach point.

## Discrepancy note: "15 roles" in issue text

[SPEC/v1/review-2026-05/F22-planner-no-default-model/00-issue.md](../F22-planner-no-default-model/00-issue.md) says "all 15 roles explicitly populated". `modelsSectionSchema` enumerates **10** per-role keys plus `default`. Only **4** are dispatched today ([src/agents/agent-adapter.ts#L40](../../../src/agents/agent-adapter.ts)). The "15" likely refers to an operator-dashboard view (not audited here). The fix should validate the 4 dispatched roles (the contract surface of the in-process resolver) and treat operator-facing extra roles as informational; flagging this for the reviewer.
