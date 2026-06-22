# F18 — Implementation plan (round 1, WRITER)

Branch: `stage-44-permissions-by-state-matrix` (current).
Deployment target: container `saivage-v3-getrich-v2` @ `10.0.3.170`,
service `saivage-v3-getrich.service`. Host-side build + SSH restart, **no
rsync**, per workspace handoff and
[/home/salva/g/ml/.github/skills/saivage-development-validation/SKILL.md](../../../../.github/skills/saivage-development-validation/SKILL.md).

Backend tests are **Jest** (saivage-v3 root `package.json` uses
`NODE_OPTIONS=--experimental-vm-modules jest`); the web SPA uses Vitest —
no web changes are in scope here.

## Changes

### 1. `src/schemas/types.ts`

Delete the `pid: number;` field from the `RuntimeState` interface
(currently at line 94). Leave `FreezeManifest.pid` (line 93) untouched.

### 2. `src/schemas/validators.ts`

In `runtimeStateSchema` (line 115), remove
`pid: z.number().int().positive(),` from the object literal.
`freezeManifestSchema` (line 117) is unchanged.

### 3. `src/runtime/state.ts`

In `defaultRuntimeState()` around line 82, remove the line
`pid: process.pid,`. All other functions in the file are unaffected.

### 4. `src/runtime/runtime.ts`

In the three `updateRuntimeState({...})` calls inside `shutdown()`,
`freeze()`, `resumeFromFreeze()` (lines 609, 612, 613), remove the
`pid: process.pid,` key. The `FreezeManifest` literal in `freeze()` keeps
its `pid: process.pid` — the freeze file documents process-of-record at
freeze time.

### 5. `src/runtime/lock.ts`

Add an exported read-only helper next to the existing read paths (around
the current `acquireLock` / `releaseLock` block):

```ts
export function readLiveLockHolder(projectRoot: string): { pid: number; started_at: string } | null {
  const path = lockPath(projectRoot);  // reuse the existing module-local helper
  if (!existsSync(path)) return null;
  let payload: { pid: number; started_at: string };
  try {
    payload = JSON.parse(readFileSync(path, 'utf-8')) as { pid: number; started_at: string };
  } catch {
    return null;
  }
  if (typeof payload.pid !== 'number' || !isPidAlive(payload.pid)) return null;
  return { pid: payload.pid, started_at: payload.started_at };
}
```

No change to the locking semantics or to existing exports.

### 6. `src/server/server.ts` — `/api/runtime/status`

Inside `registerRuntimeDispatchRoutes` at line 64, add
`pid: process.pid,` to both `reply.send({...})` branches (activeRuntime
branch and disk-fallback branch). The 500 error branch is unchanged.

### 7. `src/server/routes/chats-files-debug.ts` — `/api/debug/state`

In the handler at line 307, after the `state` and `cards` blocks compute
their values, build the response runtime payload with the pid overlay:

```ts
const runtimePayload = state ? { ...state, pid: process.pid } : null;
return reply.send({ runtime: runtimePayload, cards: cardIndex, totalCards: cards.length });
```

(Replaces the current `return reply.send({ runtime: state, cards: cardIndex, totalCards: cards.length });`.)

### 8. `src/cli.ts` — `handleStatus`

Replace `console.log(\`PID:          ${state.pid}\`);` with:

```ts
const { readLiveLockHolder } = await import('./runtime/lock.js');
const holder = readLiveLockHolder(projectRoot);
console.log(`PID:          ${holder ? holder.pid : '(not running)'}`);
```

Use a dynamic `import` only if the existing file is already ESM-import-only
at top of file (it likely is); a static import at the top is equivalent
and preferable if it does not introduce a cycle.

### 9. Test-fixture cleanup (drop `pid:` from RuntimeState literals)

- [tests/agents/planner-control-executor.test.ts#L19](../../../tests/agents/planner-control-executor.test.ts#L19) — drop `pid: process.pid,`.
- [tests/server/generated-file-inspection.test.ts#L17](../../../tests/server/generated-file-inspection.test.ts#L17) — drop `pid: process.pid,` from the inline `writeFileSync(JSON.stringify({...}))`.
- [tests/api/cards-history.test.ts#L37](../../../tests/api/cards-history.test.ts#L37) — same edit.
- [tests/utils/runtime-state-layout.test.ts#L37](../../../tests/utils/runtime-state-layout.test.ts#L37) — drop `pid: 12345,`.

### 10. `tests/server/runtime-status-pid.test.ts` (new, Jest)

Modelled on the structure of
[tests/server/agents-llm-exchange-route.test.ts](../../../tests/server/agents-llm-exchange-route.test.ts).

Cases:

1. **Active-runtime branch.** Build a Fastify instance via the standard
   server bootstrap with a real `ActiveRuntime`, `GET /api/runtime/status`
   with auth bearer, assert `body.pid === process.pid` (positive integer).
2. **Disk-fallback branch.** Build the server without `activeRuntime`,
   probe the same route, same assertion.
3. **Stale-on-disk does not poison the response.** Write
   `.saivage/tmp/state/runtime.json` directly via `writeFileSync` with an
   explicit `pid: 99999` key in the JSON literal (bypassing the schema —
   the parser will strip it on read). Probe `/api/runtime/status`; assert
   `body.pid === process.pid` and `body.pid !== 99999`.

### 11. `tests/server/debug-state-pid.test.ts` (new, Jest)

One case: write a `runtime.json` with `status: 'running'`, probe
`GET /api/debug/state`, assert `body.runtime.pid === process.pid`. Locks
in the overlay.

### 12. `tests/schemas/runtime-state-pid.test.ts` (new, Jest)

Two cases:

1. `runtimeStateSchema.parse({...validState, pid: 12345})` succeeds; the
   parsed object has no `pid` property.
2. `runtimeStateSchema.parse({...validState})` (no `pid`) succeeds.

Reuse the validation-fixture builder pattern from the closest existing
schema test (search `tests/schemas` for an analogous validator test; if
none, hand-build a minimal `RuntimeState` literal mirroring the schema's
remaining required fields).

### 13. Docs

`docs/operation.md`: the `<!-- saivage:operator-routes:start -->` table
already lists `/api/runtime/status` and `/api/debug/state`; the response
shape is not enumerated in that table (it tracks routes, not payloads),
so no edit is required. If
[docs/design/server-api.md](../../../docs/design/server-api.md) describes
the `/api/runtime/status` response body (search for "runtime/status" in
that file), add a one-line note that `pid` is `process.pid` of the live
server process; otherwise leave it alone.

`docs/historical/*` is intentionally untouched.

## Validation commands

Run from `/home/salva/g/ml/saivage-v3`. Order matters — type-check first
to catch the schema/interface fan-out.

```bash
cd /home/salva/g/ml/saivage-v3

# 1. Type-check and full build (catches every callsite that reads RuntimeState.pid).
npm run build

# 2. New, targeted Jest suites.
npx jest tests/server/runtime-status-pid.test.ts --runInBand
npx jest tests/server/debug-state-pid.test.ts --runInBand
npx jest tests/schemas/runtime-state-pid.test.ts --runInBand

# 3. All touched suites — fixture changes ripple through these.
npx jest tests/server --runInBand
npx jest tests/agents/planner-control-executor.test.ts --runInBand
npx jest tests/api/cards-history.test.ts --runInBand
npx jest tests/utils/runtime-state-layout.test.ts --runInBand
npx jest tests/utils/runtime-integration.test.ts --runInBand   # lock-file tests — should remain green untouched

# 4. CLI smoke (manual; the `saivage status` change is small).
node dist/cli.js status        # in a project where the server is not running -> "(not running)"

# 5. Docs guard (catches stale operator-route inventory drift).
npm run docs:verify
```

No Vitest run is required — `web/` consumes `debugRuntime.pid` from the
overlay path; the type is unchanged from the UI's perspective.

## Deployment

Per workspace handoff (no rsync; host build + SSH restart; health probe).

```bash
# Host build
cd /home/salva/g/ml/saivage-v3
npm run build

# Container-side rebuild + restart on 10.0.3.170
ssh root@10.0.3.170 'systemctl stop saivage-v3-getrich.service'
ssh root@10.0.3.170 'cd /work/saivage-v3-getrich && git fetch && git checkout stage-44-permissions-by-state-matrix && git pull --ff-only && npm ci && npm run build'
ssh root@10.0.3.170 'systemctl start saivage-v3-getrich.service'

# Wait briefly for boot, then probe.
sleep 2
curl -fsS --max-time 5 http://10.0.3.170:8080/health

# Verify the F18 fix end-to-end.
LIVE_PID=$(ssh root@10.0.3.170 'systemctl show -p MainPID --value saivage-v3-getrich.service')
echo "systemd MainPID: $LIVE_PID"
curl -fsS -H "Authorization: Bearer $SAIVAGE_TOKEN" http://10.0.3.170:8080/api/runtime/status | tee /tmp/f18-status.json | jq -r '.pid'
curl -fsS -H "Authorization: Bearer $SAIVAGE_TOKEN" http://10.0.3.170:8080/api/debug/state | jq -r '.runtime.pid'
# Both pid values must equal $LIVE_PID and must be positive integers.
```

If the deployment topology in
[/home/salva/g/ml/.github/skills/saivage-development-validation/SKILL.md](../../../../.github/skills/saivage-development-validation/SKILL.md)
ships the host-built `dist/` to the container instead of building inside
the container, substitute step 2's `npm ci && npm run build` with the
documented dist-copy step — but still **no `rsync`** (use `scp`, `tar |
ssh`, or `git pull` on the container, per the skill).

## Acceptance checklist

- [ ] `npm run build` is clean (no new TypeScript errors; fan-out callsites updated).
- [ ] `npx jest tests/server/runtime-status-pid.test.ts` — 3/3 green.
- [ ] `npx jest tests/server/debug-state-pid.test.ts` — 1/1 green.
- [ ] `npx jest tests/schemas/runtime-state-pid.test.ts` — 2/2 green.
- [ ] `npx jest tests/server` — no regressions.
- [ ] `npx jest tests/agents/planner-control-executor.test.ts tests/api/cards-history.test.ts tests/utils/runtime-state-layout.test.ts tests/utils/runtime-integration.test.ts` — all green.
- [ ] `npm run docs:verify` passes.
- [ ] `curl http://10.0.3.170:8080/health` returns 200 after restart.
- [ ] `curl http://10.0.3.170:8080/api/runtime/status | jq .pid` equals systemd `MainPID` of `saivage-v3-getrich.service` and is a positive integer.
- [ ] `curl http://10.0.3.170:8080/api/debug/state | jq .runtime.pid` equals the same value.
- [ ] After `ssh root@10.0.3.170 systemctl restart saivage-v3-getrich.service && sleep 2`, both endpoints' `pid` values change in lockstep with the new `MainPID` (no stale value).
- [ ] Web Debug → State widget shows the live PID and no longer matches the F05 stale-pid reproduction (incidental win; F05 stays open until its own owner closes it).
- [ ] `RuntimeState` no longer has a `pid` field in `src/schemas/types.ts` or `src/schemas/validators.ts`; grep `RuntimeState.*pid|pid: process\.pid` in `src/` returns only `FreezeManifest`-related hits and the lock file.
- [ ] `node dist/cli.js status` outside the server prints either the live lock-holder pid or `(not running)`, never a stale persisted value.
