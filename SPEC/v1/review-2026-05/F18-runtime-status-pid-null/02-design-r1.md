# F18 — Design (round 1, WRITER)

## Principle

`pid` is **process-runtime state**, not persisted project state. The only
correct source is `process.pid` evaluated inside the running Saivage server
process. Persisting it in `runtime.json` was the bug; surfacing it from
on-disk state was the consequence. The design removes the persisted field
and synthesizes the value at every route boundary that exposes it.

## Surface contracts

### `GET /api/runtime/status`

Both branches (with and without `activeRuntime`) emit `pid` from
`process.pid`. Response shape:

```jsonc
{
  "runtime": "running" | "idle" | "paused" | "frozen" | "stopped" | "stopping" | "starting" | "unknown",
  "paused": boolean,
  "currentCardId": string | null,
  "goalCount": number,        // 0 in the disk-fallback branch
  "pid": number,              // NEW — always process.pid, always a positive integer
  "serverAvailability": { ... } // optional, unchanged
}
```

`pid` is added to **both** branches symmetrically so the response shape
does not depend on whether the server was constructed with an
`ActiveRuntime`. Type widens from omitted-or-undefined to `number`
(strict, never nullable).

### `GET /api/debug/state`

The `runtime` payload is the persisted `RuntimeState` minus `pid`, with
`pid: process.pid` **overlaid** server-side before send. Response shape:

```jsonc
{
  "runtime": {
    "status": "...",
    "project_id": "project",
    "started_at": "...",
    "current_card_id": "...",
    "current_agent_session_id": "...",
    "active_card_run": ...,
    "paused": ...,
    "queue": [...],
    "running_processes": [...],
    "updated_at": "...",
    "frozen_reason": null | string,
    "pid": <process.pid>     // NEW: overlay, not stored
  } | null,
  "cards": [ ... ],
  "totalCards": <int>
}
```

Existing web consumer
[DebugView.vue#L28](../../../web/src/views/DebugView.vue#L28)
(`debugRuntime.pid`) keeps working unchanged. The pid value is now always
live and always matches the systemd `MainPID` of
`saivage-v3-getrich.service`.

### `saivage status` CLI

Renders the lock-holder pid (from `.saivage/.lock`) rather than the
persisted runtime pid. Output gains a clear "(not running)" line when no
lock is held.

```
Project root: /work/saivage-v3-getrich
Status:       running
PID:          5485        # holder pid from .saivage/.lock, or "(not running)" when no live holder
Paused:       false
Current card: card-abc
Started at:   2026-05-23T13:50:01.123Z
Queue length: 0
```

## Schema and type changes

### `src/schemas/types.ts` — `RuntimeState`

Remove `pid: number;` from the interface
([types.ts#L94](../../../src/schemas/types.ts#L94)). `FreezeManifest.pid`
([types.ts#L93](../../../src/schemas/types.ts#L93)) is **kept** —
distinct file, distinct semantics ("process that produced this freeze").

### `src/schemas/validators.ts` — `runtimeStateSchema`

Remove `pid: z.number().int().positive(),` from the object literal
([validators.ts#L115](../../../src/schemas/validators.ts#L115)).
`runtimeStateSchema` has no `.strict()` modifier, so existing on-disk
`runtime.json` files containing a stray `pid` key parse cleanly — Zod
default behaviour is to strip unknown keys. No migration code.

`freezeManifestSchema` ([validators.ts#L117](../../../src/schemas/validators.ts#L117))
is unchanged.

### `src/runtime/state.ts`

`defaultRuntimeState()` no longer sets `pid`
([state.ts#L82](../../../src/runtime/state.ts#L82)). All other functions in
the file are unaffected because they construct partial updates that already
do not mention pid.

### `src/runtime/runtime.ts`

Three `updateRuntimeState({..., pid: process.pid, ...})` calls drop the
`pid` key:

- `Runtime.shutdown()` ([runtime.ts#L609](../../../src/runtime/runtime.ts#L609))
- `Runtime.freeze()` ([runtime.ts#L612](../../../src/runtime/runtime.ts#L612))
- `Runtime.resumeFromFreeze()` ([runtime.ts#L613](../../../src/runtime/runtime.ts#L613))

`Runtime.freeze()` still writes `pid: process.pid` into the
**FreezeManifest** payload — that file's `pid` is intentionally
process-of-record at freeze time and stays.

## Route assembly changes

### `src/server/server.ts` (`registerRuntimeDispatchRoutes`, line 64)

Both branches add `pid: process.pid`:

```ts
// activeRuntime branch
return reply.send({
  runtime: status.status,
  paused: status.paused,
  currentCardId: status.currentCardId,
  goalCount: status.goalCount,
  pid: process.pid,
  ...(serverAvailability ? { serverAvailability } : {}),
});

// fallback (no activeRuntime) branch
return reply.send({
  runtime: state?.status ?? 'unknown',
  paused: state?.paused ?? false,
  currentCardId: state?.current_card_id ?? null,
  goalCount: 0,
  pid: process.pid,
  ...(serverAvailability ? { serverAvailability } : {}),
});
```

The error branch (500) is unchanged — pid is only meaningful when the
response is success.

### `src/server/routes/chats-files-debug.ts` (`/api/debug/state`)

Overlay live pid onto the persisted runtime object before send:

```ts
const runtimePayload = state ? { ...state, pid: process.pid } : null;
return reply.send({ runtime: runtimePayload, cards: cardIndex, totalCards: cards.length });
```

Wrapped so that when `state === null` the response stays `runtime: null`
(no synthetic object with only pid).

## CLI change

### `src/runtime/lock.ts`

Add a tiny read-only accessor (new export) that reads
`.saivage/.lock`, parses the `{ pid, started_at }` payload, and returns
the holder's pid only when `isPidAlive(pid)` is true:

```ts
export function readLiveLockHolder(projectRoot: string): { pid: number; started_at: string } | null {
  // implementation mirrors the existing read path used by acquireLock, exposing only the
  // happy-path payload when the holder is still alive; no lock acquisition, no mutation.
}
```

No change to `acquireLock` / `releaseLock` semantics.

### `src/cli.ts`

`handleStatus()` replaces `state.pid` with the lock-holder pid:

```ts
const holder = readLiveLockHolder(projectRoot);
console.log(`PID:          ${holder ? holder.pid : '(not running)'}`);
```

## Test fixtures

Four hand-built `RuntimeState` literals in tests drop the `pid:` key:

- [tests/agents/planner-control-executor.test.ts#L19](../../../tests/agents/planner-control-executor.test.ts#L19)
- [tests/server/generated-file-inspection.test.ts#L17](../../../tests/server/generated-file-inspection.test.ts#L17)
- [tests/api/cards-history.test.ts#L37](../../../tests/api/cards-history.test.ts#L37)
- [tests/utils/runtime-state-layout.test.ts#L37](../../../tests/utils/runtime-state-layout.test.ts#L37)

Tests that interact with `.saivage/.lock` directly (e.g.
[tests/utils/runtime-integration.test.ts#L719,#L734,#L748,#L757](../../../tests/utils/runtime-integration.test.ts#L719))
are unaffected — different file, different schema.

## New tests

### `tests/server/runtime-status-pid.test.ts` (Jest)

Pure HTTP-level assertion suite, modelled on
[tests/server/agents-llm-exchange-route.test.ts](../../../tests/server/agents-llm-exchange-route.test.ts)
and [tests/server/server-availability-contract.test.ts](../../../tests/server/server-availability-contract.test.ts).

Cases:

1. **`/api/runtime/status` (activeRuntime branch)** — `response.pid ===
   process.pid` and is a positive integer.
2. **`/api/runtime/status` (disk-fallback branch, no activeRuntime)** —
   same assertion; pid is independent of any persisted state.
3. **`/api/runtime/status` after persisted state has a stale pid** —
   write a `runtime.json` literal with an explicit `pid: 99999` key (using
   raw `writeFileSync`, bypassing the schema-stripping read), then probe;
   `response.pid === process.pid`, **not** `99999`. Locks in the
   "live-not-stored" semantics.
4. **`/api/debug/state.runtime.pid === process.pid`** — analogous overlay
   test against the debug route.

### `tests/schemas/runtime-state-pid.test.ts` (Jest)

Two cases:

1. `runtimeStateSchema.parse({...validState, pid: 12345})` succeeds and
   the parsed object has **no** `pid` property (unknown key stripped).
2. `runtimeStateSchema.parse({...validState})` (no `pid`) succeeds —
   field is no longer required.

## Alternatives considered

1. **Keep `RuntimeState.pid` and always overwrite to `process.pid` on
   every persistence write.**
   Rejected: would require threading pid through every
   `updateRuntimeState({...})` call site (currently most of them do not
   pass pid), or wrapping `updateRuntimeState` to always inject. Either way
   the field stays in the on-disk schema while being authoritatively
   redundant with `process.pid` — violates "Architecture-first, no
   backward compatibility". Stale-on-disk windows remain between writes.

2. **Populate via systemd `MainPID` lookup
   (`systemctl show -p MainPID saivage-v3-getrich.service`).**
   Rejected: introduces an out-of-process dependency, fails in dev /
   non-systemd environments, and is strictly less authoritative than
   `process.pid` in the very process that answers the HTTP request.
   `process.pid === MainPID` is guaranteed by the single-process,
   non-forking unit configuration.

3. **Document `pid` as "may be null, often null" and leave the route
   unchanged.**
   Rejected by the issue text ("preferred: populate with the live systemd
   `MainPID`") and by the architecture-first guideline — documenting
   broken behaviour preserves it.

4. **Add `pid` to `ActiveRuntime.getStatus()` return type and source it
   from there.**
   Rejected as unnecessary indirection. `process.pid` is a process-global
   constant; reading it inside the route handler avoids growing
   `ActiveRuntime`'s status surface, which F19 is actively refactoring.

## Sequencing with F19

F19's `RuntimeStateMachine` is the single writer for runtime status fields
(`status`, `current_card_id`, `paused`, etc.); it does not touch `pid`.
F18 strictly shrinks `RuntimeState`. The two changes are commutative; F18
can land before, after, or alongside F19 with no merge interlock beyond
trivial conflict resolution on the schema and `runtime.ts` files.
