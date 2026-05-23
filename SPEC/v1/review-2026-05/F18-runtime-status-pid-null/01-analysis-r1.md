# F18 — Analysis (round 1, WRITER)

## Root cause / current behavior

Two cooperating defects make `runtime.pid` appear as `null` and (per F05)
stale, despite the Saivage v3 runtime being a single Node.js process under
systemd:

### 1. `/api/runtime/status` never emits `pid`

The route is inlined in
[src/server/server.ts](../../../src/server/server.ts) at line 64 inside
`registerRuntimeDispatchRoutes`. Both branches assemble a response that
**omits `pid` entirely**:

```ts
// activeRuntime branch
return reply.send({ runtime: status.status, paused: status.paused,
                    currentCardId: status.currentCardId, goalCount: status.goalCount,
                    ...(serverAvailability ? { serverAvailability } : {}) });

// fallback branch (no activeRuntime)
return reply.send({ runtime: state?.status ?? 'unknown',
                    paused: state?.paused ?? false,
                    currentCardId: state?.current_card_id ?? null,
                    goalCount: 0,
                    ...(serverAvailability ? { serverAvailability } : {}) });
```

`ActiveRuntime.getStatus()`
([src/runtime/active-runtime.ts#L197-L213](../../../src/runtime/active-runtime.ts#L197-L213))
returns `{ status, paused, currentCardId, goalCount }` — no pid field. The
JSON response therefore has no `pid` key; any client that reads
`response.pid` sees `undefined`, which surfaces as `null` in the dashboard's
`<span>{{ debugRuntime.pid }}</span>` style readouts and in JSON-as-`?: null`
operator probes.

### 2. Persisted `RuntimeState.pid` is structurally stale

`RuntimeState.pid` is declared `z.number().int().positive()` in
[src/schemas/validators.ts#L115](../../../src/schemas/validators.ts#L115)
and typed at
[src/schemas/types.ts#L94](../../../src/schemas/types.ts#L94). It is written
to `.saivage/tmp/state/runtime.json` from exactly four call sites — all of
them passing `process.pid`:

- `defaultRuntimeState()` at
  [src/runtime/state.ts#L82](../../../src/runtime/state.ts#L82) — only on
  first-time init or when `updateRuntimeState` finds the file missing
  ([state.ts#L147-L149](../../../src/runtime/state.ts#L147-L149)).
- `Runtime.shutdown()`
  ([src/runtime/runtime.ts#L609](../../../src/runtime/runtime.ts#L609)).
- `Runtime.freeze()`
  ([src/runtime/runtime.ts#L612](../../../src/runtime/runtime.ts#L612)).
- `Runtime.resumeFromFreeze()`
  ([src/runtime/runtime.ts#L613](../../../src/runtime/runtime.ts#L613)).

Every other persistence path (`appendRuntimeCommand`, `appendRuntimeRun`,
`upsertRuntimeActivation`, `upsertRuntimeIntent`, dispatcher tick writes via
`updateRuntimeState({...})` without `pid:` key) preserves the **previous**
`pid` value. Across a `systemctl restart`, the new process reads the old
file, the schema accepts the previous-process pid as valid, and `pid` is
only refreshed when shutdown/freeze/resume happens to run. Phase-2 evidence
shows `MainPID` cycled `4983 → 5485` but the persisted/exposed pid did not
update — consistent with this code path.

The persisted `pid` is therefore **the writer's process pid at the moment of
last shutdown/freeze/init**, not "the live runtime pid". It only ever
matches reality by coincidence.

## Impact

- **`/api/runtime/status.pid` is always `null`** (P3, observability) — the
  field is never emitted; operator dashboards and external monitors that
  cross-reference `MainPID` see no truth source.
- **`/api/debug/state.runtime.pid` is stale** (F05, P2, *Phase-1, out of
  scope for this finding* but mechanically caused by the same broken design).
  Phase-2 §G4/T37 reproduces both gaps from one restart cycle.
- **`saivage status` CLI**
  ([src/cli.ts#L32](../../../src/cli.ts#L32)) prints the same stale field —
  a developer running `saivage status` outside the running server sees the
  last-written pid, not the live server pid (which lives in `.saivage/.lock`,
  see [src/runtime/lock.ts#L85](../../../src/runtime/lock.ts#L85) where the
  *live holder's* pid is correctly written and probed with
  `process.kill(pid, 0)` for liveness).

## What the data already supports

`process.pid` in the Saivage server process **is** the systemd `MainPID`,
because:

- `saivage-v3-getrich.service` is configured as a non-forking unit running
  `node dist/cli.js serve <root>` (per workspace handoff for service
  `saivage-v3-getrich.service` at `10.0.3.170`).
- The runtime is single-process by design — there are no worker children
  whose pids would diverge from systemd's tracked main pid. The "embedded
  child process PID" framing in the issue is hypothetical; no such embedded
  process is created by the runtime layer.

Therefore the route can synthesize an always-correct `pid` by reading
`process.pid` at request time. No new I/O, no schema, no persistence.

The independent `.saivage/.lock` file already records the holder's pid and
already validates liveness with `isPidAlive` — that is the authoritative
record of "which process owns this Saivage project", and is the right source
for any out-of-process consumer (CLI, recovery tools) that needs to ask
"who is currently running".

## Scope

- **Server (Fastify):** the `/api/runtime/status` route in
  [src/server/server.ts#L64](../../../src/server/server.ts#L64) — both
  branches add `pid: process.pid` to the response. The `/api/debug/state`
  route in
  [src/server/routes/chats-files-debug.ts#L307-L342](../../../src/server/routes/chats-files-debug.ts#L307-L342)
  overlays `pid: process.pid` onto the `runtime` field before sending, so
  the persisted (stripped) state still surfaces as live truth.
- **Schemas:** drop `pid` from `runtimeStateSchema`
  ([src/schemas/validators.ts#L115](../../../src/schemas/validators.ts#L115))
  and `RuntimeState`
  ([src/schemas/types.ts#L94](../../../src/schemas/types.ts#L94)).
  `runtimeStateSchema` is non-strict (default `.strip` mode) so existing
  on-disk `runtime.json` files with a residual `pid` key parse cleanly — the
  field is dropped on read, never written again.
- **Runtime writes:** remove `pid: process.pid` from
  [src/runtime/state.ts#L82](../../../src/runtime/state.ts#L82) (defaults),
  and from the three `updateRuntimeState({..., pid: process.pid, ...})`
  call sites in
  [src/runtime/runtime.ts#L609,#L612,#L613](../../../src/runtime/runtime.ts#L609).
  `FreezeManifest.pid` is **retained**
  ([validators.ts#L117](../../../src/schemas/validators.ts#L117),
  [types.ts#L93](../../../src/schemas/types.ts#L93)) — it documents
  "process that produced this freeze" across restart and is read by
  recovery, not by liveness probes.
- **CLI:** `saivage status`
  ([src/cli.ts#L32](../../../src/cli.ts#L32)) switches from `state.pid` to
  reading the lock-holder pid from `.saivage/.lock` via a small helper added
  to [src/runtime/lock.ts](../../../src/runtime/lock.ts) (`readLockHolder`
  or similar), or it omits the PID line when no lock is held.
- **Test fixtures:** the four test files that hand-build a `RuntimeState`
  object with `pid: process.pid` drop the field
  ([tests/agents/planner-control-executor.test.ts#L19](../../../tests/agents/planner-control-executor.test.ts#L19),
  [tests/server/generated-file-inspection.test.ts#L17](../../../tests/server/generated-file-inspection.test.ts#L17),
  [tests/api/cards-history.test.ts#L37](../../../tests/api/cards-history.test.ts#L37),
  [tests/utils/runtime-state-layout.test.ts#L37](../../../tests/utils/runtime-state-layout.test.ts#L37)).
  Lock-file tests
  ([tests/utils/runtime-integration.test.ts#L719,#L734,#L748,#L757](../../../tests/utils/runtime-integration.test.ts#L719))
  are unaffected — they touch `runtime.lock`, not `runtime.json`.
- **Web UI:** no change needed.
  [web/src/views/DebugView.vue#L28](../../../web/src/views/DebugView.vue#L28)
  reads `debugRuntime.pid` from the `/api/debug/state.runtime` field; that
  field is now overlaid with `process.pid` by the route.
- **Out of scope:** no changes to `/api/state` operator-contract assembly
  (F14 owns that surface); no changes to `RuntimeStateMachine` (F19 owns
  runtime status writes, which do not touch pid); no UI redesign of the
  Debug → State widget.

## Coordination with F19

F19's `RuntimeStateMachine` is the new single writer for `status`,
`current_card_id`, `current_agent_session_id`, `active_card_run`, `paused`,
`paused_at`. F19 explicitly does **not** own `pid`. Dropping `pid` from the
persisted schema simplifies F19's invariant set by removing a field that
both the state machine and the legacy `updateRuntimeState` would otherwise
have to coordinate on. The two findings are independent in code; sequencing
is flexible.

## Non-goals (per binding decisions)

- **No migration shim.** Existing on-disk `runtime.json` files keep
  parsing because the field is silently stripped; we do **not** add a
  one-shot upgrade step or a "legacy pid accepted" code path.
- **No new docstrings or comments in untouched code.** Only the changed
  blocks get whatever inline structure is minimally necessary.
- **No backward-compat with the old "pid in RuntimeState" surface.** The
  field is removed from the type, from the schema, from `defaultRuntimeState`,
  from runtime callsites, and from test fixtures in the same change set —
  not deprecated and not aliased.
