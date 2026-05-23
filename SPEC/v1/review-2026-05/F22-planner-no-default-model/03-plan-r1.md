# F22 — Implementation plan r1

## Dependency on F13 r5

This plan rebases onto F13 r5's async `Runtime.open` / `ActiveRuntime.open` factories ([SPEC/v1/review-2026-05/F13-canonical-index-drift/03-plan-r5.md](../F13-canonical-index-drift/03-plan-r5.md)). Concretely:

- `new ActiveRuntime(projectRoot, saivageConfig)` at [src/server/server.ts#L108](../../../src/server/server.ts) becomes `await ActiveRuntime.open(projectRoot, saivageConfig)` (F13 deliverable).
- F22's `validateModelRoles` call is inserted **inside** the new `ActiveRuntime.open`, after the `config` non-null check (currently at [src/runtime/active-runtime.ts#L49-L52](../../../src/runtime/active-runtime.ts)) and **before** any `EventLogger`/`AgentAdapter`/`Runtime.open` construction.
- If F13 r5 is not yet merged when F22 starts, F22 lands the validation in the existing **synchronous** `ActiveRuntime` constructor at the same position and is rebased to `open` in the F13 follow-up commit. The behaviour is identical because both forms run before `AgentAdapter` is instantiated.

## Step 1 — `validateModelRoles` in `src/config/`

New file: [src/config/validate-model-roles.ts](../../../src/config/validate-model-roles.ts).

```ts
import type { SaivageConfig } from '../agents/config-schema.js';

export const REQUIRED_ROLES = ['planner', 'executor', 'reviewer', 'analyst'] as const;
export type RequiredRole = typeof REQUIRED_ROLES[number];

export type ValidateModelRolesResult =
  | { ok: true }
  | { ok: false; missingRoles: RequiredRole[]; configuredRoles: Record<string, string[]> };

export function validateModelRoles(config: SaivageConfig): ValidateModelRolesResult {
  const models = config.models;
  const defaultList = Array.isArray(models.default) && models.default.length > 0 ? models.default : null;
  const profiles = models.profiles ?? {};
  const routing = models.routing ?? {};

  const configuredRoles: Record<string, string[]> = {};
  const missingRoles: RequiredRole[] = [];

  for (const role of REQUIRED_ROLES) {
    const direct = (models as Record<string, unknown>)[role];
    if (Array.isArray(direct) && direct.length > 0) {
      configuredRoles[role] = direct as string[];
      continue;
    }
    const profileName = routing[role];
    const profile = profileName ? profiles[profileName] : undefined;
    if (profile) {
      const merged = [...profile.preferred, ...profile.allowed];
      if (merged.length > 0) {
        configuredRoles[role] = merged;
        continue;
      }
    }
    if (defaultList) {
      configuredRoles[role] = defaultList;
      continue;
    }
    missingRoles.push(role);
  }

  if (missingRoles.length > 0) {
    return { ok: false, missingRoles, configuredRoles };
  }
  return { ok: true };
}

export class ModelRoleConfigError extends Error {
  readonly missingRoles: readonly RequiredRole[];
  constructor(missingRoles: readonly RequiredRole[], configuredRoles: Record<string, string[]>) {
    const lines: string[] = [];
    lines.push(`Saivage config is missing model lists for required role(s): ${missingRoles.join(', ')}.`);
    for (const role of missingRoles) {
      lines.push(`  models.${role} = (unset)`);
    }
    lines.push('Fix by either:');
    lines.push('  - setting "models.<role>" to a non-empty string[] in .saivage/saivage.json, or');
    lines.push('  - setting "models.default" as a shared fallback.');
    const present = Object.entries(configuredRoles).map(([r, ms]) => `${r} = ${JSON.stringify(ms)}`);
    if (present.length > 0) lines.push(`Roles defined in this config: ${present.join(', ')}`);
    super(lines.join('\n'));
    this.name = 'ModelRoleConfigError';
    this.missingRoles = missingRoles;
  }
}
```

Export from [src/config/index.ts](../../../src/config/index.ts):

```ts
export { validateModelRoles, ModelRoleConfigError, REQUIRED_ROLES } from './validate-model-roles.js';
export type { ValidateModelRolesResult, RequiredRole } from './validate-model-roles.js';
```

Rationale: `REQUIRED_ROLES` mirrors `AgentRole` at [src/agents/agent-adapter.ts#L40](../../../src/agents/agent-adapter.ts). A future refactor could import `AgentRole` directly; the duplication is intentional and one-line so `src/config/` does not gain a reverse dep on `src/agents/`.

## Step 2 — Call from `ActiveRuntime.open`

In [src/runtime/active-runtime.ts](../../../src/runtime/active-runtime.ts), inside the new `static async open` (per F13 r5), immediately after the existing `if (!config) throw …` block at L49-L52:

```ts
const validation = validateModelRoles(config);
if (!validation.ok) {
  throw new ModelRoleConfigError(validation.missingRoles, validation.configuredRoles);
}
```

Add the import at the top of the file:

```ts
import { validateModelRoles, ModelRoleConfigError } from '../config/index.js';
```

Place the call **strictly before** `new EventLogger(...)`, `new AgentAdapter(...)`, `Runtime.open(...)`, and any subscriber wiring — so a missing-role boot leaves no half-initialized resources.

`server.ts` requires no change beyond what F13 r5 already does: the existing `try { await ActiveRuntime.open(...) } catch (err) { runtimeStartupFailure = { code: 'active-runtime-start-failed', error: err }; ... }` at [src/server/server.ts#L108](../../../src/server/server.ts) already catches construction failures and reports them through `serverAvailability`. The new `ModelRoleConfigError` flows through this exact path and surfaces in `/api/runtime/status` as a startup failure with a clean message — no silent fallback, no first-cycle `errors.jsonl` line.

## Step 3 — Tests

### Unit: `tests/config/validate-model-roles.test.ts` (new file)

Cases:

1. All four roles directly populated → `{ ok: true }`.
2. `models = {}` → `{ ok: false, missingRoles: ['planner','executor','reviewer','analyst'] }`.
3. `models.default = ['gpt-4.1']` covers all → `{ ok: true }`, `configuredRoles` lists `default` value for each.
4. `models.planner = []` (empty array) is treated as unset → planner is missing.
5. Routing/profile path: `routing.executor = 'fast'`, `profiles.fast.preferred = ['gpt-5']` → executor satisfied.
6. Routing/profile path with empty `preferred ∪ allowed` → role still missing.
7. Partial: `models.planner` set, others unset, no default → `missingRoles = ['executor','reviewer','analyst']`.
8. `ModelRoleConfigError.message` contains each missing role name and the `Roles defined in this config:` listing for partially-configured cases.

### Integration: `tests/runtime/boot-missing-role.test.ts` (new file)

- Build a minimal `SaivageConfig` fixture (reuse helpers in `tests/_setup/` if any; otherwise construct via `saivageConfigSchema.parse`) with `models = {}`.
- Assert `await ActiveRuntime.open(projectRoot, config)` **rejects** with `ModelRoleConfigError`.
- Assert no `EventLogger` artifacts (e.g. `events.jsonl`) were created in the temp project dir — proves we abort before resource construction.
- Positive control: same fixture with `models.default = ['gpt-4.1']` resolves.

### Existing tests

- [tests/agents/config-schema.test.ts#L348](../../../tests/agents/config-schema.test.ts) (`getModelListForRole(..., 'planner').toThrow(/No model list configured/)`) — keep unchanged; reframed in a comment as "internal invariant trap, unreachable in production after F22".

## Step 4 — Error message format

See `ModelRoleConfigError` body in Step 1. Operator-facing fields:

- Header line lists missing roles.
- Per-missing-role line: `  models.<role> = (unset)`.
- Fix block: two bullets — set `models.<role>` or `models.default`.
- Inventory line: `Roles defined in this config: <role> = <json-array>, …`.

Single newline-joined string, thrown as the `message` of `ModelRoleConfigError`. No localization, no ANSI. The server logs it once via the existing `runtimeStartupFailure` path; the operator sees it on `/api/runtime/status` via the failure reporter at [src/server/server.ts#L109](../../../src/server/server.ts).

## Step 5 — Dead-code / unreachable-code disposition

- **Keep** the throw at [src/agents/config-schema.ts#L426](../../../src/agents/config-schema.ts) as an internal invariant. After F22, `validateModelRoles` guarantees the boot path never reaches this throw for `AgentRole` ∈ `{planner, executor, reviewer, analyst}`. The throw still protects against unknown role strings (e.g. a future code path calling `getModelListForRole(config, 'oracle')`). Convert the message to `Internal invariant violated: ...` so operators don't misread it as a config bug. No "deprecated fallback" wording — there was no fallback to deprecate; the function already supports `models.default`.

- **No dead code to delete.** Audit before writing this plan (`rg "setConfig|reloadConfig|refreshConfig|updateConfig" src/runtime src/agents` → zero hits) confirmed there are no stale config-hot-swap paths, no half-built default-resolver helpers, and no second resolver implementation. The fix is purely additive on the boot path plus a single message tweak.

- **No new docstrings or comments** in untouched code (per workspace guideline). The one-line comment at the surviving throw site is replacing the unchanged predecessor comment in the same function, not adding to unrelated code.

## Validation commands

Per [package.json](../../../package.json) and [/home/salva/g/ml/.github/skills/saivage-development-validation/SKILL.md](../../../../../.github/skills/saivage-development-validation/SKILL.md):

```bash
cd /home/salva/g/ml/saivage-v3
npm run typecheck
npm run lint
npm run test:direct
```

Then, per [/memories/repo/saivage-v3-build-deploy.json](memory:saivage-v3-build-deploy):

```bash
npm run build
sudo lxc-attach -n saivage-v3-getrich-v2 -- systemctl restart saivage-v3-getrich.service
```

### Live LXC cold-boot probe

Goal: prove `errors.jsonl` has zero "No model list configured" entries on a healthy cold boot and that an intentionally broken config aborts startup cleanly.

1. **Healthy cold boot** (regression guard):

   ```bash
   sudo lxc-attach -n saivage-v3-getrich-v2 -- systemctl restart saivage-v3-getrich.service
   sleep 5
   ssh root@10.0.3.170 'tail -n 0 -f /work/getrich-v2/.saivage/errors.jsonl' &
   curl -fsS http://10.0.3.170:8080/health
   # Wait for one planner cycle (≤ planner timeout from runtime config).
   ssh root@10.0.3.170 'grep -c "No model list configured" /work/getrich-v2/.saivage/errors.jsonl || echo 0'
   # Expect: 0
   ```

2. **Broken config** (fail-fast proof):

   - On host, temporarily move `models.planner` out of `/work/getrich-v2/.saivage/saivage.json` (operator-supervised — do **not** print file contents, the file may carry secrets).
   - Restart the service; expect the service to enter `failed` state.
   - `sudo lxc-attach -n saivage-v3-getrich-v2 -- journalctl -u saivage-v3-getrich.service -n 50 --no-pager` should contain the `ModelRoleConfigError` text including `models.planner = (unset)`.
   - `ssh root@10.0.3.170 'wc -l /work/getrich-v2/.saivage/errors.jsonl'` — line count must be **unchanged** compared to before the restart attempt (the runtime never came up, so it wrote nothing).
   - Restore the original `saivage.json` (operator-driven, content not displayed by the agent) and confirm step 1 still passes.

Pass criteria:

- Healthy boot: zero `No model list configured` lines, `/api/runtime/status` reports `runtime: started` (or whatever the running label is on this build).
- Broken boot: systemd unit `failed`; `journalctl` carries the new diagnostic; `errors.jsonl` not appended.

## F13 r5 ordering recap

F22 is **rebase-only** on F13 r5: the validation call lands inside `ActiveRuntime.open` after the `config` null-check. No other F13 r5 surface (`Runtime.open`, `CardStore.open`) is touched. If F22 lands first (sync ctor variant), the rebase onto `open` is a one-line move.
