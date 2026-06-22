# F07 — Fallback chain duplication: Combined (Analysis + Design + Plan) r2

Closes [F07](../F07-fallback-chain-duplication.md). Supersedes [COMBINED-r1.md](COMBINED-r1.md). Self-contained. Zero backward compat.

r2 changes vs r1: Batch B1 now COMPLETES the removal of the top-level `failover` field (root schema strict, schema test inverted, `setFailoverOrder` rewritten to write `models.failover`, analyst-writer test added) and rejects empty per-role model arrays. Live config migration upgraded to also drop a root `failover` key if present.

---

## 1. Analysis

### 1.1 Resolver inventory (verified 2026-05-29)

Role → ordered model-chain resolution lives in two functions:

- [src/agents/config-schema.ts#L372-L401](../../../../src/agents/config-schema.ts#L372) — `getModelListForRole(config, role)`. Lookup order:
  1. `models[role]` if it is an array → return as-is.
  2. `models.routing[role]` → `models.profiles[name]` → `[...preferred, ...allowed]`.
  3. `models.default` (array) → return.
  4. Throw `No model list configured for role '...' and no default.`
- [src/config/validate-model-roles.ts#L11-L43](../../../../src/config/validate-model-roles.ts#L11) — `validateModelRoles(config)`. Same precedence as `getModelListForRole`; used at startup to verify every `REQUIRED_ROLES` entry resolves. Two parallel implementations of the same rule (drift risk; flagged §2.3, out of scope).

Single consumer of the resolver:

- [src/agents/model-router.ts#L53](../../../../src/agents/model-router.ts#L53) — `ModelRouter.resolve(role)` calls `getModelListForRole(this.config, role)` then walks each model through `models.equivalents` and `models.failover`.

Schema for the `models` section:

- [src/agents/config-schema.ts#L60-L92](../../../../src/agents/config-schema.ts#L60) — `modelsSectionSchema`. `passthrough()` record. Reserved keys: `temperature`, `max_tokens`, `profiles`, `routing`, `equivalents`, `failover`. Every other key is normalised to `string[]` with no cross-role or non-empty checks; nothing prevents N roles from carrying byte-identical arrays, and nothing prevents an empty `[]`.

Root schema and top-level failover hook (the duplication source-of-truth gap r1 missed):

- [src/agents/config-schema.ts#L228-L239](../../../../src/agents/config-schema.ts#L228) — `saivageConfigSchema = z.object({ models, providers, …, failover: z.record(z.string(), z.array(z.string())).optional() })`. Non-strict `z.object` strips unknown keys silently but still accepts the documented top-level `failover`.
- [src/agents/model-router.ts#L60-L63](../../../../src/agents/model-router.ts#L60) — `topFailover = (this.config as Record<string, unknown>).failover` is consulted at [L92](../../../../src/agents/model-router.ts#L92) (`failover[model] ?? topFailover?.[model]`). Comment marks it as backwards compat.
- [src/agents/analyst-config-writer.ts#L60-L62](../../../../src/agents/analyst-config-writer.ts#L60) — `setFailoverOrder(projectRoot, role, orderedProviders)` writes `raw.failover[role] = orderedProviders` at the ROOT. The analyst reconfigure tool can therefore persist a chain in a location that the router will ignore after the shim is removed.
- [tests/agents/config-schema.test.ts#L252-L266](../../../../tests/agents/config-schema.test.ts#L252) — `should include failover from top-level key` asserts that the root form loads, locking the dual-source ambiguity into the test suite.

### 1.2 Live duplication (quantified)

Source: `ssh salva@10.0.3.170` → `/work/getrich-v2/.saivage/saivage.json`. Verified 2026-05-29.

- `models.default = ["gpt-5.5", "kimi-k2.6", "deepseek-v4-pro"]` — already set.
- 14 per-role arrays under `models`. Two distinct chains in use:
  - 12 roles repeat `["gpt-5.5","kimi-k2.6","deepseek-v4-pro"]` verbatim — byte-identical to `models.default`.
  - 2 roles (`chat`, `analyst`) carry `["gpt-5.5","kimi-k2.6","glm-5.1"]` — a real divergence.
- `models.failover = {}`, `models.equivalents` absent, `models.routing`/`profiles` absent.
- Root `failover` key: absent on this deployment. The migration step still defensively removes it (other deployments may have one).

12 of 14 role arrays are pure noise: the resolver already falls through to `models.default` if the role key were absent. The issue's worry — "adding a model means touching 13 places; drift between role chains has happened" — is confirmed: `chat`/`analyst` diverged from the rest, and the schema gives no machine-readable signal whether that divergence is intentional or stale.

### 1.3 Risk

- Drift: a future operator updates `models.default` without touching the 12 redundant role entries. The 12 roles silently keep the stale chain.
- Audit blindness: nothing in the schema flags duplication.
- Dual failover source: top-level `failover` and `models.failover` both load today, with `models.failover` winning. The analyst tool writes to the root. Result: the analyst can persist a chain that the router will silently ignore once the shim is removed — or that disagrees with what `models.failover` says today.
- Empty-override foot-gun: `models.<role> = []` is currently accepted by the schema; `getModelListForRole` returns it as-is, and the resolver produces zero candidates while `models.default` is silently bypassed.
- The resolver already supports the clean shape (`models.default` + sparse overrides + `models.failover`). The fix is schema enforcement + dead-shim removal + analyst-writer correction, not a new feature.

---

## 2. Design

### 2.1 Proposal A (Focused) — single source of truth, schema-enforced — RECOMMENDED

Idea: keep the resolver as-is, keep `models.default` as the canonical chain, keep `models.failover` as the only accepted per-model failover map, and add schema-level invariants that block the three failure modes above.

Schema changes ([src/agents/config-schema.ts](../../../../src/agents/config-schema.ts)):

1. Promote `default` to a first-class reserved field on `modelsSectionSchema` (`default: z.array(z.string()).min(1).optional()`) instead of an open-record entry; add `'default'` to `MODELS_RESERVED_KEYS`.
2. Tighten the existing `.superRefine` pass:
   - If a per-role array is byte-equal to `models.default` → emit `models.<role>: identical to models.default; remove the override.`
   - If a per-role array has length 0 → emit `models.<role>: empty array; remove the key to inherit models.default.`
3. Make the root schema strict: `saivageConfigSchema = z.object({ ... }).strict()` AFTER deleting the root `failover: …` field. A top-level `failover` then triggers `Unrecognized key(s) in object: 'failover'`. We add a custom `.superRefine` so the rejection message names the migration path: `Top-level 'failover' is no longer supported. Move entries under 'models.failover'.`

Router changes ([src/agents/model-router.ts](../../../../src/agents/model-router.ts)):

- Delete the `topFailover` block ([L60-L63](../../../../src/agents/model-router.ts#L60)) and its consumer at [L92](../../../../src/agents/model-router.ts#L92) (`failover[model] ?? topFailover?.[model]` → `failover[model]`).

Analyst-writer changes ([src/agents/analyst-config-writer.ts](../../../../src/agents/analyst-config-writer.ts)):

- Rewrite [setFailoverOrder (L60-L65)](../../../../src/agents/analyst-config-writer.ts#L60) to write `models.failover`. Today its argument shape is `(projectRoot, role, orderedProviders)` — but the schema for `failover` is `Record<modelName, modelName[]>` (per-MODEL chain, not per-role). r2 renames the parameter to `forModel` and the function to `setFailoverChain` to match the schema; behaviour: `ensureRecord(ensureRecord(raw, 'models'), 'failover')[forModel] = orderedFailoverModels;`. Any caller passing a role string is now writing a per-model chain keyed by the role name, which the router will simply never look up — but the analyst tool's documented contract was already per-model (the analyst reconfigure surface drives model selection, not role labels), so the rename surfaces a latent mislabel instead of introducing one.

Resolver changes: none. [getModelListForRole](../../../../src/agents/config-schema.ts#L372) and [validateModelRoles](../../../../src/config/validate-model-roles.ts#L11) already prefer per-role → routing/profile → default. After schema rejection lands, all 12 redundant arrays are removed from the live config and the resolver returns `models.default` for them.

Migration path on disk: NO compat shim in code. Startup loads the live `saivage.json`; if the schema rejects, the service exits non-zero with the new messages, naming the offending keys. The deploy step (§3.4) migrates the file once on disk.

Cost: ~40 lines in `config-schema.ts`, two deletions in `model-router.ts`, one function in `analyst-config-writer.ts`, three test files.

### 2.2 Proposal B (Level-up) — capability-tagged provider pool, runtime-derived chains — DEFERRED

Idea: stop hand-maintaining chains entirely. Each provider/model entry declares capability tags (`tool-use`, `long-context`, `vision`, `cheap`, `fast`, …). Each role declares required tags. The resolver computes the chain at runtime by filtering and ordering the pool against the role's tag spec, then de-duping.

Sketch:

```jsonc
{
  "models": {
    "pool": {
      "gpt-5.5":        { "tags": ["tool-use","long-context","general"] },
      "kimi-k2.6":      { "tags": ["tool-use","long-context","cheap"] },
      "deepseek-v4-pro":{ "tags": ["tool-use","reasoning"] },
      "glm-5.1":        { "tags": ["tool-use","cheap","chat"] }
    },
    "roles": {
      "analyst": { "requires": ["tool-use","long-context"], "prefer": ["general"] },
      "chat":    { "requires": ["tool-use"], "prefer": ["chat","cheap"] }
    }
  }
}
```

Why deferred:

- Replaces the entire `models` section shape, not just one constraint. Touches the resolver, `validateModelRoles`, `getModelParamsForRole`, every consumer that reads per-role temperature/max_tokens, and operator docs.
- Tag taxonomy needs design effort (what constitutes `long-context`? operator-defined or `provider-capabilities.ts`-derived?).
- F07's reported pain (12 byte-identical arrays + dual-source failover) is fully solved by Proposal A. B is the right direction for the next architectural pass.

**Decision: ship Proposal A under F07. Capture Proposal B as a future architectural item; do not block this issue on it.**

### 2.3 Out of scope

- Two parallel resolvers ([config-schema.ts#L372](../../../../src/agents/config-schema.ts#L372) and [validate-model-roles.ts#L11](../../../../src/config/validate-model-roles.ts#L11)) duplicate precedence logic — separate cleanup.
- `models.routing`/`profiles` ergonomics — unused in the live config.
- Tagged-pool design — Proposal B.

---

## 3. Plan

### 3.1 Batch B1 — single source of truth + dead-shim removal + analyst-writer correctness

One batch; all edits, tests, deploy, and live-config migration ship together.

**Files to edit**

1. [src/agents/config-schema.ts](../../../../src/agents/config-schema.ts)
   - Line ~67: extend `MODELS_RESERVED_KEYS` to `new Set(['temperature','max_tokens','profiles','routing','equivalents','failover','default'])`.
   - Line ~70: add `default: z.array(z.string()).min(1).optional()` to the `modelsSectionSchema` object body.
   - Extend the existing `.superRefine` clause to emit:
     - `models.<key>: identical to models.default; remove the override.` when `value.default && Array.isArray(parsed.data) && JSON.stringify(parsed.data) === JSON.stringify(value.default)`.
     - `models.<key>: empty array; remove the key to inherit models.default.` when `parsed.data.length === 0`.
   - Line ~228-239 (`saivageConfigSchema`): DELETE the root `failover: z.record(z.string(), z.array(z.string())).optional()` field. Append `.strict()` to the root object so unknown keys are rejected.
   - Append a `.superRefine` on `saivageConfigSchema` that re-issues a precise message when the rejected key is exactly `failover`: `Top-level 'failover' is no longer supported. Move entries under 'models.failover'.` (Implementation: a check on `value` plus the parent raw object via Zod's `ctx.parent`; if that is awkward in the chosen Zod version, do the rejection in the `loadConfig` wrapper at [src/agents/config-loader.ts](../../../../src/agents/config-loader.ts) by inspecting `raw.failover` before `safeParse` and returning the specific diagnostic. Test coverage in §3.2 is identical either way.)
2. [src/agents/model-router.ts](../../../../src/agents/model-router.ts)
   - Delete the `topFailover` block at [L60-L63](../../../../src/agents/model-router.ts#L60).
   - At [L92](../../../../src/agents/model-router.ts#L92), replace `failover[model] ?? topFailover?.[model]` with `failover[model]`.
3. [src/agents/analyst-config-writer.ts](../../../../src/agents/analyst-config-writer.ts)
   - Replace [setFailoverOrder at L60-L65](../../../../src/agents/analyst-config-writer.ts#L60) with:
     ```ts
     export function setFailoverChain(projectRoot: string, forModel: string, orderedFailoverModels: string[]): ConfigWriteResult {
       return readValidateWrite(projectRoot, (raw) => {
         const models = ensureRecord(raw, 'models');
         const failover = ensureRecord(models, 'failover');
         failover[forModel] = orderedFailoverModels;
       });
     }
     ```
   - Update every call site of `setFailoverOrder` (find with `grep -rn "setFailoverOrder" /home/salva/g/ml/saivage-v3/src /home/salva/g/ml/saivage-v3/web 2>/dev/null`) to the new name and per-model semantics. The analyst reconfigure tool's user-facing arg name changes from `role` to `forModel` accordingly.
4. [src/agents/config-schema.ts#L372](../../../../src/agents/config-schema.ts#L372) — `getModelListForRole`: no behavioural change. Drop the `as Record<string, unknown>` cast for `default` now that it is typed.

### 3.2 Tests to add / change

- [tests/agents/config-schema.test.ts](../../../../tests/agents/config-schema.test.ts)
  - Line ~252: REMOVE the existing `should include failover from top-level key` test.
  - REPLACE with `should reject top-level failover with a migration message`: load a config containing `{ models: { default: [...] }, failover: { 'kimi-k2.6': ['deepseek-v4-pro'] } }`; assert `loadConfig` returns an error whose message contains `Top-level 'failover' is no longer supported`.
  - ADD `rejects a role array byte-equal to models.default` — Zod failure with path `[<role>]` and the new "identical to" message.
  - ADD `accepts a role array that differs from models.default`.
  - ADD `accepts roles without an override when models.default is present` — `getModelListForRole(config, role)` returns `models.default`.
  - ADD `rejects models.default of length 0`.
  - ADD `rejects an empty per-role override array` — Zod failure with the new "empty array" message.
- [tests/agents/model-router.test.ts](../../../../tests/agents/model-router.test.ts)
  - ADD `top-level failover is no longer honoured by the router` — instantiate `ModelRouter` directly with a synthetic `SaivageConfig` (bypass schema) where `(config as any).failover = { 'kimi-k2.6': ['deepseek-v4-pro'] }` and `config.models.failover` is undefined; assert the failover candidate is not produced. Replaces any prior test asserting the shim worked.
- [tests/agents/analyst-config-writer.test.ts](../../../../tests/agents/analyst-config-writer.test.ts) (create if absent)
  - ADD `setFailoverChain writes only to models.failover and never to root`:
    1. Seed a `.saivage/saivage.json` with `{ models: { default: ['gpt-5.5'] } }` under a `tmp/` project root.
    2. Call `setFailoverChain(root, 'kimi-k2.6', ['deepseek-v4-pro'])`.
    3. Read the file: assert `raw.models.failover['kimi-k2.6']` equals `['deepseek-v4-pro']` AND `raw.failover === undefined`.
    4. Reload via `loadConfig`: assert `success === true` (i.e. the writer emitted a shape the strict schema accepts).
  - ADD `setFailoverChain output round-trips through loadConfig without diagnostics`.

### 3.3 Green checkpoint

```bash
cd /home/salva/g/ml/saivage-v3
npx tsc --noEmit
npx jest tests/agents/config-schema.test.ts \
         tests/agents/model-router.test.ts \
         tests/agents/analyst-config-writer.test.ts
```

All commands exit 0.

### 3.4 Live config migration (one-off, part of this batch's deploy)

The live file `/work/getrich-v2/.saivage/saivage.json` on `saivage-v3-getrich-v2` (10.0.3.170) holds 12 redundant role arrays. Project rule: NO migration shim in code. The deploy step migrates the file once on disk, then the new schema enforces correctness.

```bash
ssh root@10.0.3.170 'python3 - <<PY
import json, pathlib
p = pathlib.Path("/work/getrich-v2/.saivage/saivage.json")
d = json.loads(p.read_text())
m = d.setdefault("models", {})
default = m.get("default")
removed_roles = []
if isinstance(default, list):
    reserved = {"temperature","max_tokens","profiles","routing","equivalents","failover","default"}
    for k in list(m.keys()):
        if k in reserved: continue
        v = m[k]
        if isinstance(v, list) and (v == default or len(v) == 0):
            del m[k]
            removed_roles.append(k)
# Defensively migrate any root-level failover into models.failover.
moved_failover = None
if isinstance(d.get("failover"), dict):
    moved_failover = list(d["failover"].keys())
    target = m.setdefault("failover", {})
    for k, v in d["failover"].items():
        target.setdefault(k, v)
    del d["failover"]
p.write_text(json.dumps(d, indent=2) + "\n")
print("removed_roles:", removed_roles)
print("moved_failover:", moved_failover)
PY'
```

Expected on the current 10.0.3.170 state: `removed_roles: [<12 role names>]`, `moved_failover: None`. `chat` and `analyst` retain their `glm-5.1` overrides.

### 3.5 Deploy steps

Follow the workspace deploy conventions captured in repo memory (`saivage-v3-build-deploy.json`).

1. Build locally: `cd /home/salva/g/ml/saivage-v3 && npm run build`.
2. Rsync dist: `rsync -a --delete /home/salva/g/ml/saivage-v3/dist/ root@10.0.3.170:/opt/saivage-v3/dist/`.
3. Run the migration script in §3.4.
4. Restart service: `ssh root@10.0.3.170 'systemctl restart saivage-v3-getrich.service'`.
5. Verify:
   - `curl -fsS http://10.0.3.170:8080/health` → 200.
   - `ssh root@10.0.3.170 'journalctl -u saivage-v3-getrich.service --since "1 minute ago" | grep -iE "models\\.|failover|error|fatal"'` → no schema rejections.
6. Re-run the inventory from §1.2 — expect 2 explicit per-role overrides (`chat`, `analyst`), `models.default` set, no root `failover` key.

### 3.6 Rollback path

The migration script keeps no on-disk backup by design (zero-backward-compat). If a rollback is required: `git revert` the code change, redeploy the prior dist, and re-add the role entries by hand — the chain values are public (`gpt-5.5,kimi-k2.6,deepseek-v4-pro`).

### 3.7 Definition of done

- `npx tsc --noEmit` clean.
- New Jest cases green; the prior top-level-failover-accepting test is gone.
- Root schema rejects top-level `failover` with the prescribed migration message.
- `setFailoverChain` is the only function that writes failover state, and it writes under `models.failover`.
- Live 10.0.3.170 service healthy after restart.
- Live `saivage.json` shows 2 role overrides, `models.default` set, no root `failover` key, no schema-rejection diagnostics in journalctl.
- F07 closed; Proposal B captured as a follow-up architectural note.

---

## 4. Cross-links

- [F03](../F03-cooldown-classification.md) — chain depth matters less with proper `Retry-After` handling.
- [F08](../F08-error-classification.md) — accurate classification reduces required chain depth.
- Subsystem map: [00-SUBSYSTEM-MAP.md](../00-SUBSYSTEM-MAP.md).
- Critique addressed: [COMBINED-review-r1.md](COMBINED-review-r1.md).
