# F22 — Implementation plan r2

## Independence from F13

This plan does **not** depend on F13 r5. The fail-fast hook lives in [src/config/environment.ts](../../../src/config/environment.ts#L177-L228), one layer above any `ActiveRuntime.open` / sync-ctor question. F13's resolution is orthogonal.

## Step 1 — `validateModelRoles` in `src/config/`

New file: `src/config/validate-model-roles.ts`.

```ts
import type { SaivageConfig } from '../agents/config-schema.js';
import type { AgentRole } from '../agents/agent-adapter.js';

export const REQUIRED_ROLES = ['planner', 'executor', 'reviewer', 'analyst'] as const satisfies readonly AgentRole[];

export type ValidateModelRolesResult =
  | { ok: true; configuredRoles: Record<AgentRole, string[]> }
  | { ok: false; missingRoles: AgentRole[]; configuredRoles: Partial<Record<AgentRole, string[]>> };

export function validateModelRoles(config: SaivageConfig): ValidateModelRolesResult {
  const models = config.models;
  const defaultList = Array.isArray(models.default) && models.default.length > 0 ? models.default : null;
  const profiles = models.profiles ?? {};
  const routing = models.routing ?? {};

  const configuredRoles: Partial<Record<AgentRole, string[]>> = {};
  const missingRoles: AgentRole[] = [];

  for (const role of REQUIRED_ROLES) {
    const direct = (models as Record<string, unknown>)[role];
    if (Array.isArray(direct) && direct.length > 0) { configuredRoles[role] = direct as string[]; continue; }
    const profileName = routing[role];
    const profile = profileName ? profiles[profileName] : undefined;
    if (profile) {
      const merged = [...profile.preferred, ...profile.allowed];
      if (merged.length > 0) { configuredRoles[role] = merged; continue; }
    }
    if (defaultList) { configuredRoles[role] = defaultList; continue; }
    missingRoles.push(role);
  }

  if (missingRoles.length > 0) return { ok: false, missingRoles, configuredRoles };
  return { ok: true, configuredRoles: configuredRoles as Record<AgentRole, string[]> };
}
```

**Success result includes `configuredRoles`** — this matches Test 3 below and gives the diagnostic block in Step 2 a complete inventory to print on failure (`configuredRoles` is partial in the failure branch, full in the success branch). `REQUIRED_ROLES` is `as const satisfies readonly AgentRole[]` so any future change to `AgentRole` either widens or narrows this list explicitly.

Export from existing barrel: add to [src/config/index.ts](../../../src/config/index.ts):

```ts
export { validateModelRoles, REQUIRED_ROLES } from './validate-model-roles.js';
export type { ValidateModelRolesResult } from './validate-model-roles.js';
```

## Step 2 — Call from `loadEnvironment` before freezing

In [src/config/environment.ts](../../../src/config/environment.ts#L177-L228), inside `loadEnvironment`, between the existing `environmentSchema.safeParse(candidate)` success branch and the `return deepFreeze(parsed.data as Environment)`:

```ts
const roleCheck = validateModelRoles(parsed.data.config);
if (!roleCheck.ok) {
  const missing = roleCheck.missingRoles.join(', ');
  const lines = [`Configuration validation failed: missing model role(s): ${missing}.`];
  for (const r of roleCheck.missingRoles) {
    lines.push(`  models.${r} = (unset) — set "models.${r}" to a non-empty string[] in .saivage/saivage.json`);
  }
  lines.push('  or set "models.default" as a shared fallback');
  const present = Object.entries(roleCheck.configuredRoles).map(([r, ms]) => `${r} = ${JSON.stringify(ms)}`);
  if (present.length > 0) lines.push(`Roles defined in this config: ${present.join(', ')}`);
  throw new EnvironmentLoadError(lines.join('\n'), {
    field: `models.${roleCheck.missingRoles[0]}`,
    expected: 'non-empty string[] or models.default',
    received: 'unset',
    source: 'file',
  });
}
```

Add the import at the top of the file:

```ts
import { validateModelRoles } from './validate-model-roles.js';
```

**Strictly before `deepFreeze`** — the precondition belongs to the `Environment` contract, not to anything downstream. **No edits in [src/server/server.ts](../../../src/server/server.ts#L108)** — the existing `try { … new ActiveRuntime(...) } catch { runtimeStartupFailure = ... }` is untouched, because by the time `startServer` would run, `loadEnvironment` has already thrown synchronously from inside `startApp` at [src/boot/app.ts#L16-L19](../../../src/boot/app.ts) and the Node process is exiting non-zero. `saivage-v3-getrich.service` enters `failed`. No degraded-runtime path.

## Step 3 — Existing test at `tests/agents/config-schema.test.ts#L348`

**Keep the existing message `No model list configured for role '...' and no default.` unchanged**, and **keep [tests/agents/config-schema.test.ts L348](../../../tests/agents/config-schema.test.ts#L348) (`toThrow(/No model list configured/)`) unchanged**. Rationale: the resolver throw at [src/agents/config-schema.ts#L427](../../../src/agents/config-schema.ts) becomes a defence-in-depth invariant (per [02-design-r2.md#what-survives-what-dies](02-design-r2.md#what-survives-what-dies)), and the workspace guideline forbids adding new docstrings/comments in untouched code. Leaving the message alone means **zero edits** at that throw site, and the test keeps proving the invariant fires for unknown roles. The decision is deliberate: no `Internal invariant violated: ...` rewording, no `assert(false, ...)` conversion — the throw stays exactly as-is.

## Step 4 — Tests

### Unit: `tests/config/validate-model-roles.test.ts` (new file)

Cases:

1. All four roles directly populated → `{ ok: true, configuredRoles: { planner: [...], executor: [...], reviewer: [...], analyst: [...] } }`.
2. `models = {}` → `{ ok: false, missingRoles: ['planner','executor','reviewer','analyst'], configuredRoles: {} }`.
3. `models.default = ['gpt-4.1']` covers all → `{ ok: true, configuredRoles: { planner: ['gpt-4.1'], executor: ['gpt-4.1'], reviewer: ['gpt-4.1'], analyst: ['gpt-4.1'] } }`. **(Matches the Step 1 success-shape; the r1 mismatch is fixed.)**
4. `models.planner = []` (empty array) treated as unset → planner is in `missingRoles`.
5. Routing/profile path: `routing.executor = 'fast'`, `profiles.fast.preferred = ['gpt-5']` → executor satisfied via profile.
6. Routing/profile path with empty `preferred ∪ allowed` → role still missing.
7. Partial: only `models.planner` set, no default → `missingRoles = ['executor','reviewer','analyst']`, `configuredRoles.planner = [...]`.

### Integration: `tests/runtime/boot-missing-role.test.ts` (new file)

Server-startup integration, asserting `loadEnvironment` rejection propagates and `/api/runtime/status` is never reachable.

- Build a temp project root with a minimal `.saivage/saivage.json` carrying `models: {}` (everything else schema-valid).
- Call `loadEnvironment(argv, env)` directly and assert it throws `EnvironmentLoadError` whose `message` matches `/missing model role\(s\): planner, executor, reviewer, analyst/`.
- Call `startApp({ argv, env, createRuntime: true })` and assert the returned promise **rejects** with the same `EnvironmentLoadError` — i.e. `startServer` is never reached and `/api/runtime/status` is not bound on any port.
- Positive control: same temp project with `models.default = ['gpt-4.1']` → `loadEnvironment` returns a frozen `Environment`, `startApp` resolves, `/api/runtime/status` becomes reachable (then tear down).
- Assert no `events.jsonl` is written in the broken case (proves we abort before runtime construction).

## Step 5 — Resolver throw site (`config-schema.ts:427`) disposition

**Keep the throw exactly as-is** as a defence-in-depth invariant. After F22, `validateModelRoles` guarantees the boot path never reaches this throw for `r ∈ AgentRole`. The throw still protects against unknown role strings (e.g. a future code path calling `getModelListForRole(config, 'oracle')`).

- No new comment, no message change, no `assert(false, ...)` conversion. Per workspace guideline ("no new docstrings/comments in untouched code"), the surrounding code stays byte-identical.
- The invariant is documented in [02-design-r2.md#what-survives-what-dies](02-design-r2.md#what-survives-what-dies) and exercised by the existing test at [tests/agents/config-schema.test.ts L348](../../../tests/agents/config-schema.test.ts#L348).

## Validation

### Local

```bash
cd /home/salva/g/ml/saivage-v3
npm run typecheck
npm run lint
npm run test:direct -- tests/config/validate-model-roles.test.ts tests/runtime/boot-missing-role.test.ts
npm run test:direct
npm run build
```

The `test:direct` invocation names the two new focused tests first so a failure there is immediately attributable; the second `test:direct` is the full sweep gate.

### LXC live probe (per [saivage-lxc-operations](/home/salva/g/ml/.github/skills/saivage-lxc-operations/SKILL.md) and [saivage-development-validation](/home/salva/g/ml/.github/skills/saivage-development-validation/SKILL.md))

Healthy boot (regression guard) — current good `saivage.json` is already deployed at `/work/getrich-v2/.saivage/saivage.json`:

```bash
ssh root@10.0.3.170 'systemctl restart saivage-v3-getrich.service && sleep 2 && systemctl is-active saivage-v3-getrich.service'
# Expect: active
curl -fsS --max-time 3 http://10.0.3.170:8080/health
# Expect: 200 with body
ssh root@10.0.3.170 'journalctl -u saivage-v3-getrich.service -n 30 --no-pager'
# Expect: no "missing model role" line, no EnvironmentLoadError
```

Broken-config fail-fast proof. Operator-supervised; agent does not read or print `saivage.json` contents (provider keys are sensitive):

```bash
# 1. Operator (NOT the agent) backs up the live config and writes an intentionally-broken variant
#    with models = {} into /work/getrich-v2/.saivage/saivage.json on the container.
#    The agent does not display, copy, or echo the file contents.

ssh root@10.0.3.170 'systemctl restart saivage-v3-getrich.service && sleep 2 && systemctl is-active saivage-v3-getrich.service || echo FAILED'
# Expect: "failed" or "FAILED" (non-active)
ssh root@10.0.3.170 'journalctl -u saivage-v3-getrich.service -n 30 --no-pager'
# Expect: "missing model role(s): planner, executor, reviewer, analyst" in the log
curl -fsS --max-time 3 http://10.0.3.170:8080/health || echo unreachable
# Expect: unreachable — HTTP server never bound

# 2. Operator restores the original saivage.json (agent does not touch it).
ssh root@10.0.3.170 'systemctl restart saivage-v3-getrich.service && sleep 2 && systemctl is-active saivage-v3-getrich.service'
# Expect: active
```

Pass criteria:

- Healthy boot: `systemctl is-active` returns `active`; `/health` returns 200; `journalctl` shows no missing-role error.
- Broken boot: `systemctl is-active` is **not** `active`; `journalctl` carries the `Configuration validation failed: missing model role(s): ...` diagnostic; `/health` is unreachable.
- Restoration: returns to the healthy-boot state.

**No `tail -f`, no `sleep 5`.** All probes are bounded (`sleep 2`, `--max-time 3`, `journalctl -n 30 --no-pager`) and non-interactive.
