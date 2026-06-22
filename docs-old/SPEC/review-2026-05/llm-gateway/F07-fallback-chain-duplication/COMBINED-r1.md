# F07 — Fallback chain duplication: Combined (Analysis + Design + Plan) r1

Closes [F07](../F07-fallback-chain-duplication.md). Self-contained. No backward compat.

---

## 1. Analysis

### 1.1 Resolver inventory (verified)

Role → ordered model-chain resolution lives in two functions:

- [src/agents/config-schema.ts#L372-L401](../../../../src/agents/config-schema.ts#L372) — `getModelListForRole(config, role)`. Lookup order:
  1. `models[role]` if it is an array → return as-is.
  2. `models.routing[role]` → `models.profiles[name]` → `[...preferred, ...allowed]`.
  3. `models.default` (array) → return.
  4. Throw `No model list configured for role '...' and no default.`
- [src/config/validate-model-roles.ts#L11-L43](../../../../src/config/validate-model-roles.ts#L11) — `validateModelRoles(config)`. Same precedence as `getModelListForRole`, used at startup to verify every `REQUIRED_ROLES` entry resolves. Two parallel implementations of the same rule (drift risk; out of scope for F07 beyond noting it).

Only consumer of the resolver:

- [src/agents/model-router.ts#L53](../../../../src/agents/model-router.ts#L53) — `ModelRouter.resolve(role)` calls `getModelListForRole(this.config, role)` then walks each model through `models.equivalents` and `models.failover`.

Schema for the `models` section:

- [src/agents/config-schema.ts#L60-L92](../../../../src/agents/config-schema.ts#L60) — `modelsSectionSchema`. Passthrough record. Reserved keys: `temperature`, `max_tokens`, `profiles`, `routing`, `equivalents`, `failover`. Every other key is normalised to `string[]` with no cross-role checks; nothing prevents N roles from carrying byte-identical arrays.

Top-level failover legacy hook:

- [src/agents/model-router.ts#L60-L63](../../../../src/agents/model-router.ts#L60) — reads `config.failover` (top-level) in addition to `config.models.failover`. Marked `// Also support top-level failover (backwards compat)`. To be deleted under the workspace zero-backward-compat rule (tracked as part of the cleanup in §3.1).

### 1.2 Live duplication (quantified)

Source: `ssh salva@10.0.3.170` → `/work/getrich-v2/.saivage/saivage.json`. Verified 2026-05-29.

- `models.default = ["gpt-5.5", "kimi-k2.6", "deepseek-v4-pro"]` — already set.
- 14 per-role arrays under `models`. Two distinct chains in use:
  - 12 roles repeat `["gpt-5.5","kimi-k2.6","deepseek-v4-pro"]` verbatim — byte-identical to `models.default`.
  - 2 roles (`chat`, `analyst`) carry `["gpt-5.5","kimi-k2.6","glm-5.1"]` — a real divergence.
- `models.failover = {}`, `models.equivalents` absent, `models.routing`/`profiles` absent.

So 12 of 14 role arrays are pure noise: the resolver already falls through to `models.default` if the role key were absent. The issue's worry — "adding a model means touching 13 places; drift between role chains has happened" — is confirmed: `chat`/`analyst` diverged from the rest, and there is no machine-readable signal whether that divergence is intentional or stale.

### 1.3 Risk

- Drift: a future operator updates `models.default` without touching the 12 redundant role entries. The 12 roles keep the stale chain silently.
- Audit blindness: nothing in the schema flags the duplication.
- The resolver already supports the clean shape (`models.default` + sparse overrides). The fix is hygiene + schema enforcement, not a new feature.

---

## 2. Design

### 2.1 Proposal A (Focused) — schema enforces `models.default` + sparse overrides — RECOMMENDED

Idea: keep the resolver as-is (it is already correct), keep `models.default` as the canonical chain, and add a schema-level invariant: a per-role array is forbidden if it is byte-equal to `models.default`. Operators must either delete the role entry (resolver falls through to default) or make it genuinely different.

Schema changes ([src/agents/config-schema.ts#L60-L92](../../../../src/agents/config-schema.ts#L60)):

- Promote `default` to a first-class reserved field on `modelsSectionSchema` (`default: z.array(z.string()).min(1).optional()`) instead of an open-record entry.
- Add a `.superRefine` pass:
  - If a role array is byte-equal to `models.default` → emit `models.<role>: identical to models.default; remove the override`.
  - If `models.default` is absent and any role lacks an override → already caught by `validateModelRoles`; keep that.
- Drop the `// Also support top-level failover (backwards compat)` block at [src/agents/model-router.ts#L60-L63](../../../../src/agents/model-router.ts#L60). Per the project's zero-backward-compat rule, top-level `failover` is removed; `models.failover` is the only accepted form.

Resolver changes: none. [getModelListForRole](../../../../src/agents/config-schema.ts#L372) and [validateModelRoles](../../../../src/config/validate-model-roles.ts#L11) already prefer per-role → routing/profile → default. After the schema rejection lands, all 12 redundant arrays are deleted from the live config and the resolver returns `models.default` for them.

Migration path on disk: NO compat shim. Startup loads the live `saivage.json`; if the schema rejects with the "identical to models.default" diagnostic, the service exits non-zero with a message listing the offending roles. Operator removes them (or the deploy step migrates the file once, see §3.4).

Cost: ~30 lines in `config-schema.ts`, one resolver-block deletion in `model-router.ts`, two test files. Resolver behaviour and `validateModelRoles` are untouched.

### 2.2 Proposal B (Level-up) — capability-tagged provider pool, runtime-derived chains — DEFERRED

Idea: stop hand-maintaining chains entirely. Each provider/model entry declares capability tags (`tool-use`, `long-context`, `vision`, `cheap`, `fast`, …). Each role declares required tags (e.g. `analyst: { requires: ["tool-use","long-context"], prefer: ["cheap"] }`). The resolver computes the chain at runtime by filtering and ordering the pool against the role's tag spec, then de-duping.

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

- Replaces the entire `models` section shape, not just one constraint. Touches the resolver, `validateModelRoles`, `getModelParamsForRole`, every consumer that reads per-role temperature/max_tokens, and the operator-facing docs.
- Tag taxonomy needs design effort (what constitutes `long-context`? operator-defined or `provider-capabilities.ts`-derived?). Premature for one issue.
- F07's reported pain (12 byte-identical arrays) is fully solved by Proposal A. B is the right direction for the next architectural pass.

**Decision: ship Proposal A under F07. Flag Proposal B as a future architectural item; do not block this issue on it.**

### 2.3 Out of scope

- The two parallel resolvers ([config-schema.ts#L372](../../../../src/agents/config-schema.ts#L372) and [validate-model-roles.ts#L11](../../../../src/config/validate-model-roles.ts#L11)) duplicate precedence logic — separate cleanup, not F07.
- `models.routing`/`profiles` ergonomics — unused in the live config; out of scope.
- Tagged-pool design — Proposal B, deferred.

---

## 3. Plan

### 3.1 Batch B1 — promote `models.default`, reject duplication, drop top-level-failover shim

Single batch; all edits, tests, deploy, and live config migration ship together.

**Files to edit**

1. [src/agents/config-schema.ts](../../../../src/agents/config-schema.ts)
   - Add `default` to `MODELS_RESERVED_KEYS` (line ~67).
   - Add `default: z.array(z.string()).min(1).optional()` to `modelsSectionSchema` (line ~70).
   - Add a `.superRefine` clause: for each non-reserved key whose value (post-normalisation) is a `string[]` byte-equal to `value.default`, emit `ctx.addIssue({ code: custom, path: [key], message: 'models.${key} duplicates models.default; remove the override.' })`.
2. [src/agents/model-router.ts](../../../../src/agents/model-router.ts)
   - Delete the `topFailover` block at L60-L63 and its use at L92 (`failover[model] ?? topFailover?.[model]` → `failover[model]`).
3. [src/agents/config-schema.ts#L372](../../../../src/agents/config-schema.ts#L372) — `getModelListForRole`: no behavioural change, but tighten the typed access to `models.default` now that it is a typed field (drop the `as Record<string, unknown>` cast for `default`).

**Tests to add**

- `tests/agents/config-schema.test.ts` (extend or create):
  - `rejects a role array byte-equal to models.default` — expects Zod failure with path `[role]` and the new message.
  - `accepts a role array that differs from models.default` — passes.
  - `accepts roles without an override when models.default is present` — `getModelListForRole` returns `models.default`.
  - `rejects models.default of length 0`.
- `tests/agents/model-router.test.ts` (extend):
  - `top-level failover is no longer honoured` — config with `{ failover: {...} }` at root + no `models.failover` → no failover candidates produced (replaces any existing test that asserted the shim worked).

**Green checkpoint**

- `cd /home/salva/g/ml/saivage-v3 && npx tsc --noEmit` → 0 errors.
- `cd /home/salva/g/ml/saivage-v3 && npx jest tests/agents/config-schema.test.ts tests/agents/model-router.test.ts` → all green.

**Live config migration** (one-off, part of this batch's deploy)

The live file `/work/getrich-v2/.saivage/saivage.json` on `saivage-v3-getrich-v2` (10.0.3.170) holds 12 redundant role arrays. Project rule: NO migration shim in code. The deploy step migrates the file once on disk, then the new schema enforces correctness from there on.

Migration script (run from host, executed before service restart):

```bash
ssh root@10.0.3.170 'python3 - <<PY
import json, pathlib
p = pathlib.Path("/work/getrich-v2/.saivage/saivage.json")
d = json.loads(p.read_text())
m = d["models"]
default = m.get("default")
removed = []
if isinstance(default, list):
    for k in list(m.keys()):
        v = m[k]
        if k in {"temperature","max_tokens","profiles","routing","equivalents","failover","default"}:
            continue
        if isinstance(v, list) and v == default:
            del m[k]
            removed.append(k)
p.write_text(json.dumps(d, indent=2) + "\n")
print("removed:", removed)
PY'
```

Expected output: `removed: [<12 role names>]`. `chat` and `analyst` retain their `glm-5.1` overrides.

**Live deploy step** (per [/memories/repo/saivage-v3-build-deploy.json](../../../../) conventions)

1. Build locally: `cd /home/salva/g/ml/saivage-v3 && npm run build` (or `npx tsup`, whichever the repo's deploy memory specifies).
2. Rsync dist to container:
   `rsync -a --delete dist/ root@10.0.3.170:/opt/saivage-v3/dist/`
3. Run the migration script above.
4. Restart service: `ssh root@10.0.3.170 'systemctl restart saivage-v3-getrich.service'`.
5. Verify:
   - `curl -fsS http://10.0.3.170:8080/health` → 200 with `ok` body.
   - `ssh root@10.0.3.170 'journalctl -u saivage-v3-getrich.service --since "1 minute ago" | grep -iE "models\\.|error|fatal"'` → no schema errors.
6. Re-run the live-config check from §1.2 — expect `distinct_chains: 2` with 2 explicit overrides and 12 fallthroughs (i.e. `roles: 2`).

**Rollback path** (file-only; code rollback is `git revert` + redeploy):

The migration script keeps no backup by design (zero-backward-compat). If a rollback is needed, restore from the host-side git working tree by re-running `saivage-cli init` against `/work/getrich-v2` or by re-adding the role keys by hand — the chain values are public knowledge (`gpt-5.5,kimi-k2.6,deepseek-v4-pro`).

**Definition of done**

- `npx tsc --noEmit` clean.
- New Jest cases green.
- Service healthy on 10.0.3.170 after restart.
- Live `saivage.json` shows 2 role overrides + `models.default`; no schema-rejection diagnostics in journalctl.
- F07 closed; Proposal B captured as a follow-up architectural note (not a code task).

---

## 4. Cross-links

- [F03](../F03-cooldown-classification.md) — chain depth matters less with proper `Retry-After` handling.
- [F08](../F08-error-classification.md) — accurate classification reduces required chain depth.
- Subsystem map: [00-SUBSYSTEM-MAP.md](../00-SUBSYSTEM-MAP.md).
