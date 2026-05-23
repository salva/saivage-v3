# F15 — Implementation plan (round 2)

Round-2 changes vs [03-plan-r1.md](03-plan-r1.md):

- Replaced the root-level server test commands. Backend tests in this repo run under **Jest** (root `package.json` `"test": "NODE_OPTIONS=--experimental-vm-modules jest"`), not Vitest. Vitest is only used inside `web/`. The previous `npx vitest run tests/server/...` invocations were wrong.
- Made the deployment step explicit: host `npm run build` first, then SSH restart, then health probes. The container at 10.0.3.170 reads the host `dist/` via bind mount, so no rsync is required, but the build itself must happen before the restart.

Branch: `stage-44-permissions-by-state-matrix` (current). Target deployment: `saivage-v3-getrich.service` on 10.0.3.170.

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

Run from `/home/salva/g/ml/saivage-v3` unless noted. Backend = Jest; web = Vitest. Reference: [.github/skills/saivage-development-validation/SKILL.md](../../../../.github/skills/saivage-development-validation/SKILL.md).

1. Typecheck (server):
   ```bash
   cd /home/salva/g/ml/saivage-v3 && npx tsc -p tsconfig.json
   ```
2. Server-side targeted tests (Jest):
   ```bash
   cd /home/salva/g/ml/saivage-v3 && \
     NODE_OPTIONS=--experimental-vm-modules npx jest \
       tests/server/server-availability-contract.test.ts \
       tests/server/operator-api-contracts.test.ts \
       --runInBand --forceExit
   ```
3. Full server test suite (Jest, regression sweep):
   ```bash
   cd /home/salva/g/ml/saivage-v3 && npm test -- --runInBand --forceExit
   ```
4. Web Vue SFC corruption guard (per user memory `vue-sfc-corruption.md` — only if any `.vue` is edited; this plan does not edit `.vue` files, so this step is a no-op but kept for completeness):
   ```bash
   cd /home/salva/g/ml/saivage-v3/web && for f in src/components/*.vue src/App.vue; do echo "$(grep -c 'script setup' "$f" 2>/dev/null) $f"; done
   ```
5. Web type/build (Vite + tsc):
   ```bash
   cd /home/salva/g/ml/saivage-v3/web && npm run build
   ```
6. Web unit tests (Vitest):
   ```bash
   cd /home/salva/g/ml/saivage-v3/web && npx vitest run
   ```

## Deployment (10.0.3.170, `saivage-v3-getrich.service`)

The host repo at `/home/salva/g/ml/saivage-v3` is bind-mounted into the container at `/work/saivage-v3` (per `/memories/repo/saivage-v3-getrich-v2-bind-mounts.json`), so the built `dist/` is visible to the systemd unit immediately after the host build completes. No rsync, no scp.

1. Build the server on the host (produces `dist/` consumed by the container):
   ```bash
   cd /home/salva/g/ml/saivage-v3 && npm run build
   ```
2. (Optional, only if web changed) Rebuild the dashboard on the host:
   ```bash
   cd /home/salva/g/ml/saivage-v3/web && npm run build
   ```
3. Restart the service inside the container:
   ```bash
   ssh root@10.0.3.170 'systemctl restart saivage-v3-getrich.service'
   ```
4. Probe health and the MCP availability shape:
   ```bash
   curl -fsS http://10.0.3.170:8080/health
   curl -fsS http://10.0.3.170:8080/health/ready | jq '.serverAvailability.components.mcp'
   curl -fsS http://10.0.3.170:8080/api/mcp/status -H "Authorization: Bearer $TOKEN" | jq '.serverAvailability.components.mcp'
   ```
   Expect `state: "idle"`, `source: "mcp-manager"`, `diagnostic.code: "mcp-manager-empty"`, `diagnostic.summary: "No MCP servers configured."`.

## Acceptance checklist

- [ ] `AvailabilityStateSchema` includes `'idle'` and no other new values.
- [ ] `buildServerAvailability` emits `state: 'idle'` only when `mcpManager` is attached and `getStatus()` returns an empty array; emits `degraded` only when status length > 0 with zero running.
- [ ] `tests/server/server-availability-contract.test.ts` and `tests/server/operator-api-contracts.test.ts` pass under Jest and assert `idle`, not `degraded`, for the empty case.
- [ ] Web Vitest run passes.
- [ ] `docs/operation.md` lists five enum values and disambiguates `idle` vs `degraded` for MCP.
- [ ] After host `npm run build` + SSH restart, probing `/api/mcp/status` on 10.0.3.170 returns `state: "idle"` and the diagnostic code remains `mcp-manager-empty`.
- [ ] No occurrence of `'MCP manager is degraded or empty.'` remains in `web/src/**`.
- [ ] `grep -R "state: 'degraded'" src/server/availability.ts` reports exactly one occurrence (the configured-but-not-running case).
