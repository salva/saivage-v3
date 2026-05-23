# F15 — Implementation plan (round 1)

Branch: `stage-44-permissions-by-state-matrix` (current). Target deployment: `saivage-v3-getrich.service` on 10.0.3.170. No rsync — host build + SSH restart + health probe.

## File-level changes

### 1. Add `'idle'` to the availability enum

- File: [src/contracts/operator-api.ts](../../../src/contracts/operator-api.ts)
- Edit at line 105: change
  ```ts
  export const AvailabilityStateSchema = z.enum(['available', 'degraded', 'unavailable', 'unknown']);
  ```
  to
  ```ts
  export const AvailabilityStateSchema = z.enum(['available', 'degraded', 'idle', 'unavailable', 'unknown']);
  ```

### 2. Emit `idle` from the empty-MCP branch

- File: [src/server/availability.ts](../../../src/server/availability.ts)
- Edit at lines 85-95: replace the third arm of the ternary so that the `!hasConfigured` branch emits `state: 'idle'` and the diagnostic summary becomes `'No MCP servers configured.'`. Leave the `code: 'mcp-manager-empty'` unchanged so existing log greps still match.

### 3. Mirror the enum in the web client types

- File: [web/src/api/types.ts](../../../web/src/api/types.ts)
- Edit at line 550: extend the union literal type with `'idle'`.

### 4. Update the dashboard label builder

- File: [web/src/stores/runtime.ts](../../../web/src/stores/runtime.ts)
- Edit at lines 117-119: keep `unavailable` and `degraded` branches; do NOT add a message for `idle` (intentional silence). The existing `unknown` branch remains.
- Do not edit other parts of the file. No new comments.

### 5. Update server tests

- File: [tests/server/server-availability-contract.test.ts](../../../tests/server/server-availability-contract.test.ts)
- Line ~95-96: change the assertion block for the empty-MCP case to expect `state: 'idle'`, `source: 'mcp-manager'`, `diagnostic.code: 'mcp-manager-empty'`, `diagnostic.summary: 'No MCP servers configured.'`.
- Add one additional assertion in the same test that `state` is not `'degraded'` (regression guard).

### 6. Update operator-api contract test fixture

- File: [tests/server/operator-api-contracts.test.ts](../../../tests/server/operator-api-contracts.test.ts)
- Line 30: change the fixture `mcp` block to `state: 'idle'` and `summary: 'No MCP servers configured.'`. Keep the diagnostic code.

### 7. Update web store unit test (if it pins a value)

- File: [web/src/__tests__/runtime-store.test.ts](../../../web/src/__tests__/runtime-store.test.ts)
- Around lines 279-283: the fixture only sets `runtime.state = 'degraded'`. If any other assertion in that file references mcp `degraded` for the empty case, switch it to `idle`. Otherwise no change.

### 8. Update operator docs

- File: [docs/operation.md](../../../docs/operation.md)
- Line 75: extend the enum list `available | degraded | unavailable | unknown` to `available | degraded | idle | unavailable | unknown`.
- Line 241 paragraph: rewrite the trailing clause "an empty/degraded manager" as two distinct cases — "an empty manager (`idle`)" and "a configured-but-impaired manager (`degraded`)".

### 9. (No change) Do not touch

- `src/mcp/*` — classifier is the only thing that needs the new value.
- `src/observability/*` — does not touch `mcp.state`.
- `src/runtime/*`, `src/server/server.ts`, `src/server/routes/operator-contracts.ts` — they thread `buildServerAvailability` through; new enum value rides along.
- `web/dist/*`, `dist/*` — build artifacts; regenerated.

## Validation commands

Run from `/home/salva/g/ml/saivage-v3` unless noted. Reference: [.github/skills/saivage-development-validation/SKILL.md](../../../../.github/skills/saivage-development-validation/SKILL.md).

1. Typecheck + build (server):
   ```bash
   cd /home/salva/g/ml/saivage-v3 && npx tsc -p tsconfig.json
   ```
2. Server-side targeted tests:
   ```bash
   cd /home/salva/g/ml/saivage-v3 && npx vitest run tests/server/server-availability-contract.test.ts tests/server/operator-api-contracts.test.ts
   ```
3. Full server test suite (regression sweep):
   ```bash
   cd /home/salva/g/ml/saivage-v3 && npx vitest run
   ```
4. Web Vue SFC corruption guard (per user memory `vue-sfc-corruption.md` — only if any `.vue` is edited; this plan does not edit `.vue` files, so this step is a no-op but kept for completeness):
   ```bash
   cd /home/salva/g/ml/saivage-v3/web && for f in src/components/*.vue src/App.vue; do echo "$(grep -c 'script setup' "$f" 2>/dev/null) $f"; done
   ```
5. Web type/build:
   ```bash
   cd /home/salva/g/ml/saivage-v3/web && npm run build
   ```
6. Web unit tests:
   ```bash
   cd /home/salva/g/ml/saivage-v3/web && npm run test -- --run
   ```

## Deployment (10.0.3.170, `saivage-v3-getrich.service`)

1. Confirm bind-mount layout (per `/memories/repo/saivage-v3-getrich-v2-bind-mounts.json`).
2. From host, after a clean build:
   ```bash
   ssh root@10.0.3.170 'systemctl restart saivage-v3-getrich.service'
   ```
3. Wait a moment, then probe:
   ```bash
   curl -fsS http://10.0.3.170:8080/health
   curl -fsS http://10.0.3.170:8080/health/ready | jq '.serverAvailability.components.mcp'
   curl -fsS http://10.0.3.170:8080/api/mcp/status -H "Authorization: Bearer $TOKEN" | jq '.serverAvailability.components.mcp'
   ```
   Expect `state: "idle"`, `source: "mcp-manager"`, `diagnostic.code: "mcp-manager-empty"`, `diagnostic.summary: "No MCP servers configured."`.

No rsync. No file copy. Just host build + SSH restart.

## Acceptance checklist

- [ ] `AvailabilityStateSchema` includes `'idle'` and no other new values.
- [ ] `buildServerAvailability` emits `state: 'idle'` only when `mcpManager` is attached and `getStatus()` returns an empty array; emits `degraded` only when status length > 0 with zero running.
- [ ] `tests/server/server-availability-contract.test.ts` and `tests/server/operator-api-contracts.test.ts` pass and assert `idle`, not `degraded`, for the empty case.
- [ ] Web `npm run test -- --run` passes.
- [ ] `docs/operation.md` lists five enum values and disambiguates `idle` vs `degraded` for MCP.
- [ ] Probing `/api/mcp/status` on 10.0.3.170 after deploy returns `state: "idle"` and the diagnostic code remains `mcp-manager-empty`.
- [ ] No occurrence of `'MCP manager is degraded or empty.'` remains in `web/src/**`.
- [ ] `grep -R "state: 'degraded'" src/server/availability.ts` reports exactly one occurrence (the configured-but-not-running case).
