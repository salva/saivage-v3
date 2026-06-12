# F14 r1 — Plan: add `projectRoot` + `projectId` to `/api/state`

## Ordering

F14 is independent of F13/F19/F22/F23 and can land at any point in the
sequence. If F22 lands first, the `z.string().min(1)` guard on `projectRoot`
in the response schema is redundant with config-validation fail-fast (we keep
it anyway as a typed contract).

## Step-by-step

### Step 1 — Schema

[src/contracts/operator-api.ts](../../../src/contracts/operator-api.ts)
around line 132:

- Edit `RuntimeGetStateResponseSchema` to add two required string fields:

```ts
export const RuntimeGetStateResponseSchema = z.object({
  projectRoot: z.string().min(1),
  projectId: z.string().min(1),
  runtime: runtimeStateSchema.nullable(),
  cardIndex: CardIndexSummarySchema,
  cardStoreHealth: CardStoreHealthSchema.optional(),
  serverAvailability: ServerAvailabilitySchema.optional(),
});
```

No other schema edits in this file. The `operator-events.ts` envelope
([src/contracts/operator-events.ts#L40-L41](../../../src/contracts/operator-events.ts))
references only `RuntimeGetStateResponseSchema.shape.runtime` and
`CardIndexSummarySchema`, so it picks up no breakage; verify by inspection.

### Step 2 — Handler

[src/server/routes/operator-contracts.ts](../../../src/server/routes/operator-contracts.ts):

- Add at the top of the import block:

```ts
import { basename } from 'node:path';
```

- Inside `registerOperatorContractRoutes`, after the existing
  `const { fastify, projectRoot } = options;` (line 51):

```ts
const projectId = basename(projectRoot);
```

- Replace the `'runtime.getState'` handler body (line 81-88) with the version
  in the design doc — both `if (!state)` and the populated branch include
  `projectRoot` and `projectId` at the top of `body`. The handler does **not**
  log, redact, or transform either value.

### Step 3 — Backend unit / integration tests

Search for backend tests that assert `RuntimeGetStateResponseSchema`-shaped
payloads:

```bash
rg --vimgrep "RuntimeGetStateResponseSchema|runtime\\.getState|/api/state" tests/ src/server/__tests__/ src/contracts/__tests__/ 2>/dev/null
```

For each match, augment the expected body / mock to include `projectRoot` and
`projectId`. If none exist, add one new test:

- New file
  `tests/server/operator-state-identity.test.ts`:
  - Boot a fastify instance via the existing test harness for
    `registerOperatorContractRoutes` (mirror the test pattern already in
    `tests/server/` — pattern lookup in r2 before writing).
  - Pass `projectRoot = '/tmp/saivage-v3-test-fixture'`.
  - `GET /api/state` (operator-auth bypassed in dev mode).
  - Assert `body.projectRoot === '/tmp/saivage-v3-test-fixture'` and
    `body.projectId === 'saivage-v3-test-fixture'`.
  - Assert in null-runtime branch and in populated-runtime branch (seed a
    minimal `runtime-state.json` between requests).

### Step 4 — Web tests

Augment the three mocks identified in the design:

- `web/src/__tests__/api-client-contracts.test.ts` line ~54: extend the
  `runtime.getState` call to include `projectRoot: '/tmp/test',
  projectId: 'test'`.
- `web/src/__tests__/runtime-store.test.ts`:
  - `mockCardIndex` already exists; add an adjacent `mockIdentity = {
    projectRoot: '/work/saivage-v3', projectId: 'saivage-v3' }`.
  - Spread `...mockIdentity` into every `getRuntimeState` mock return value
    (lines 290, 295, 351, 400, 414, 502).
  - Assert `store.projectRoot === '/work/saivage-v3'` and
    `store.projectId === 'saivage-v3'` after a successful fetch.
- `web/src/__tests__/operator-dashboard-smoke.test.ts` lines 57 and 372:
  spread identity fields into the dashboard mock.

### Step 5 — Web store wiring

[web/src/stores/runtime.ts](../../../web/src/stores/runtime.ts) (file
location confirmed via the import in
[web/src/__tests__/runtime-store.test.ts](../../../web/src/__tests__/runtime-store.test.ts)
— exact line numbers to read in r2):

- Add reactive state `projectRoot: string | null = null;` and
  `projectId: string | null = null;`.
- In the `fetch`/`refresh` reducer, copy the new top-level fields off the
  parsed `runtime.getState` payload.
- Reset both to `null` on the 401 path (event
  `API_AUTH_REQUIRED_EVENT`).
- Do **not** consume the values in `AppShell.vue` in this round — F08 owns
  that.

### Step 6 — Front-end build sanity

After Step 4–5 edits, confirm no duplicate SFC `<script setup>` blocks were
appended to any `.vue` file:

```bash
for f in web/src/components/**/*.vue web/src/App.vue; do
  count=$(grep -c "<script setup" "$f" 2>/dev/null || echo 0)
  [[ "$count" -gt 1 ]] && echo "CORRUPTED: $count $f"
done
```

### Step 7 — Build, lint, typecheck

Per the saivage-development-validation skill, on the host
(`/home/salva/g/ml/saivage-v3`):

```bash
cd /home/salva/g/ml/saivage-v3
npm run build               # tsc + tsup
npm run lint                # eslint (zero warnings allowed)
npm run typecheck           # tsc --noEmit if separate target
```

If `npm run build` fails because the web `dist/` is stale, also run:

```bash
(cd web && npm run build)
```

### Step 8 — Targeted unit tests

```bash
cd /home/salva/g/ml/saivage-v3
npx vitest run tests/server/operator-state-identity.test.ts
(cd web && npx vitest run \
  src/__tests__/api-client-contracts.test.ts \
  src/__tests__/runtime-store.test.ts \
  src/__tests__/operator-dashboard-smoke.test.ts)
```

All must pass before deploy.

### Step 9 — Local dev-server probe (optional sanity)

```bash
cd /home/salva/g/ml/saivage-v3
node dist/cli.js serve /work/saivage-v3 &
SERVER_PID=$!
sleep 2
curl -fsS http://127.0.0.1:8080/api/state | jq '.projectRoot, .projectId'
kill "$SERVER_PID"
```

Expected: `"/work/saivage-v3"` and `"saivage-v3"`.

### Step 10 — Deploy to `saivage-v3-getrich-v2` (10.0.3.170)

Per workspace handoff (no rsync; host build + SSH restart):

```bash
# Build on host (already done in Step 7).
ssh root@10.0.3.170 'systemctl restart saivage-v3-getrich.service'
sleep 3
ssh root@10.0.3.170 'systemctl status saivage-v3-getrich.service --no-pager | head -15'
curl -fsS http://10.0.3.170:8080/health | jq .
curl -fsS http://10.0.3.170:8080/api/state \
  -H "Authorization: Bearer $(ssh root@10.0.3.170 'cat /etc/saivage/api-token' 2>/dev/null || echo SKIP)" \
  | jq '.projectRoot, .projectId'
```

(If the bearer token retrieval step is not pre-approved, skip the
authenticated probe and rely on `/health` + the systemd status. Do **not**
print the token.)

### Step 11 — Probe the other containers (no deploy)

To prove F14 distinguishes deployments:

```bash
curl -fsS http://10.0.3.111:8080/health    # baseline (won't have F14 until deployed there)
curl -fsS http://10.0.3.112:8080/health    # saivage-v3 v2 harness; deploy if needed
curl -fsS http://10.0.3.170:8080/health    # getrich-v2 v3
```

After F14 is rolled to the targets that need it, `/api/state` on each will
show its own `projectRoot`.

## File path summary

| Path | Edit |
|---|---|
| `src/contracts/operator-api.ts` | Add `projectRoot` + `projectId` to `RuntimeGetStateResponseSchema` |
| `src/server/routes/operator-contracts.ts` | Add `basename` import; compute `projectId` once; project both fields in `runtime.getState` body (both branches) |
| `tests/server/operator-state-identity.test.ts` | New test (null-runtime + populated branches) |
| `web/src/__tests__/api-client-contracts.test.ts` | Extend `runtime.getState` mock |
| `web/src/__tests__/runtime-store.test.ts` | Extend mocks + assert store fields |
| `web/src/__tests__/operator-dashboard-smoke.test.ts` | Extend dashboard mocks |
| `web/src/stores/runtime.ts` | Add `projectRoot` / `projectId` state + reducer wiring + 401 reset |

## Validation commands (consolidated)

```bash
# Build
cd /home/salva/g/ml/saivage-v3 && npm run build && npm run lint

# Backend targeted tests
npx vitest run tests/server/operator-state-identity.test.ts

# Web build + targeted tests
(cd web && npm run build && npx vitest run \
  src/__tests__/api-client-contracts.test.ts \
  src/__tests__/runtime-store.test.ts \
  src/__tests__/operator-dashboard-smoke.test.ts)

# Local dev probe (optional)
node dist/cli.js serve /work/saivage-v3 &
sleep 2 && curl -fsS http://127.0.0.1:8080/api/state | jq '.projectRoot, .projectId'
kill %1

# Deploy + remote health probe
ssh root@10.0.3.170 'systemctl restart saivage-v3-getrich.service'
sleep 3 && curl -fsS http://10.0.3.170:8080/health | jq .
```

## Acceptance checklist

- [ ] `RuntimeGetStateResponseSchema` includes required `projectRoot` (non-empty string) and `projectId` (non-empty string).
- [ ] `runtime.getState` handler emits both fields in **both** the null-runtime and populated-runtime branches.
- [ ] `basename` is imported from `node:path`; no `path.posix` / `path.win32` confusion (`basename(projectRoot)` is correct on Linux servers).
- [ ] No log/error path emits `projectRoot`. `redactOperatorErrorMessage` continues to strip it from exception text.
- [ ] All three web test files updated; web build is green; no duplicate SFC `<script setup>` blocks introduced.
- [ ] `npm run build` and `npm run lint` are green in `/home/salva/g/ml/saivage-v3`.
- [ ] New backend test `tests/server/operator-state-identity.test.ts` passes locally (null and populated branches).
- [ ] Targeted vitest commands above are all green.
- [ ] Local `curl http://127.0.0.1:8080/api/state | jq '.projectRoot, .projectId'` returns the live values.
- [ ] After deploy to 10.0.3.170, `/health` is 200 and `/api/state` (authenticated probe) returns the deployment's own `projectRoot` and `projectId`.
- [ ] No F08, F18, F19, F22, F23 surface is touched (scope discipline).
- [ ] No new docstrings/comments in untouched code.
