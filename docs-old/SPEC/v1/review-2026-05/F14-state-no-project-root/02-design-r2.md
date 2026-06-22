# F14 r2 — Design: surface deployment identity on `/api/state`

> r2 changes vs r1: relative-link depth corrected (`../../../../` from this
> directory reaches the repo `src/`), and the security section is reinforced
> with the explicit redaction-channel separation that r2 plan now tests.

## Goal

Expose the live deployment identity (canonical project root + derived id) as
two required top-level fields on `runtime.getState` so operators auditing
multiple `saivage-v3` deployments can read it directly from `/api/state` and
the front-end can stop hard-coding `'saivage-v3'`.

## Contract change

### Schema delta

[../../../../src/contracts/operator-api.ts](../../../../src/contracts/operator-api.ts)
`RuntimeGetStateResponseSchema` (line 132-137) becomes:

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

Both fields are **required** (architecture-first, no backward compatibility).
Existing optional shape of `cardStoreHealth` / `serverAvailability` is
preserved unchanged.

- `projectRoot`: absolute filesystem path the server was started with (the
  same `environment.projectRoot` plumbed everywhere, e.g.,
  [../../../../src/server/server.ts#L34](../../../../src/server/server.ts)).
- `projectId`: `path.basename(projectRoot)`; UI-friendly identifier for the
  header / browser title / WS event prefix.

### Field semantics

| Field | Source | Mutable | Why both? |
|---|---|---|---|
| `projectRoot` | `options.projectRoot` already injected into `registerOperatorContractRoutes` | No (process-lifetime constant) | Unambiguous identity even when two deployments share a basename |
| `projectId` | `path.basename(options.projectRoot)` computed once at route-mount | No | Cheap, friendly to humans and the header subtitle |

### Handler change

[../../../../src/server/routes/operator-contracts.ts#L81-L88](../../../../src/server/routes/operator-contracts.ts):

```ts
'runtime.getState': () => {
  const serverAvailability = options.serverAvailabilityProvider?.();
  const state = readRuntimeState(projectRoot);
  const identity = { projectRoot, projectId };
  if (!state) return { body: { ...identity, runtime: null, cardIndex: { total: 0, byStatus: {}, byType: {} }, ...(serverAvailability ? { serverAvailability } : {}) } };
  const cards = store.list();
  const byStatus: Record<string, number> = {};
  const byType: Record<string, number> = {};
  for (const card of cards) { byStatus[card.status] = (byStatus[card.status] || 0) + 1; byType[card.type] = (byType[card.type] || 0) + 1; }
  return { body: { ...identity, runtime: state, cardIndex: { total: cards.length, byStatus, byType }, cardStoreHealth: { canonical: 'ok' }, ...(serverAvailability ? { serverAvailability } : {}) } };
},
```

`projectId` is computed once at the top of `registerOperatorContractRoutes`:

```ts
const projectId = basename(projectRoot);
```

with `import { basename } from 'node:path';` added to the import block.

## Why not just one field?

| Option | Pro | Con |
|---|---|---|
| `projectRoot` only | Matches the literal issue wording | UI must `basename()` client-side; basename logic duplicated and not part of the contract |
| `projectId` only | UI-friendly | Loses unambiguous identity when two hosts run `/foo/saivage-v3` vs `/bar/saivage-v3` |
| Both (chosen) | Identity + UX in one round-trip | Two strings of payload |

Two strings cost nothing and the contract becomes the single source of truth.

## Alternatives considered

1. **Add only `projectRoot`, derive `projectId` in the web client.** Rejected:
   F08 will need to import a `basename` shim or copy logic; the contract
   should be definitive.
2. **Promote `runtime.project_id` to the top level via a getter on the
   front-end.** Rejected: `runtime` is `null` whenever the runtime state file
   has not been written yet (cold-boot, factory reset). Identity must survive
   a null runtime row.
3. **New `/api/project` route.** Rejected: extra round-trip for a tiny piece
   of always-relevant identity data; `/api/state` is the canonical entry point
   already polled by the dashboard.
4. **Expose `projectRoot` only inside `cardStoreHealth` or `serverAvailability`.**
   Rejected: those structures describe component health, not identity.
5. **Expose `hostname` / `pid` here too.** Out of scope (F18 owns `pid`); avoid
   scope creep.

## Integration with binding decisions

- **F13** (card-store reshape, no derived files): F14 does not touch the
  store; the handler still calls `store.list()`. Lands independently in
  either merge order.
- **F19** (RuntimeStateMachine + async `transitionCard`,
  `STARTABLE_STATES`/`RESTARTABLE_STATES`): F14 does not touch the state
  machine. The `readRuntimeState(projectRoot)` call inside `runtime.getState`
  is preserved verbatim; F19 changes the *writer* of that state, not its
  reader.
- **F22** (fail-fast `loadEnvironment`): F22 guarantees
  `environment.projectRoot` is a non-empty absolute path at boot. F14 leans on
  that: `z.string().min(1)` is a belt-and-braces check, not a substitute for
  F22's validation.
- **F23** (goal activation via RuntimeStateMachine): unrelated.

## Security / redaction

`projectRoot` is exposed deliberately and **only** on the typed success body
of `/api/state`. It is **never** added to error messages, logs, or any
contract field whose semantics are "human-readable diagnostic text".

### Two-channel invariant

| Channel | Carries `projectRoot`? | Mechanism |
|---|---|---|
| `/api/state` success body | Yes, typed `projectRoot` + `projectId` | Schema-validated, operator-session-authenticated |
| `redactOperatorErrorMessage(message, projectRoot)` output | No, replaced with `[PROJECT_ROOT]` | [../../../../src/workspace/file-access-security.ts#L83](../../../../src/workspace/file-access-security.ts) |

The r2 plan adds a Jest regression test in `tests/utils/file-access-security.test.ts`
that pins this separation: any error message containing the project root is
redacted to `[PROJECT_ROOT]` and the raw root substring never appears in the
redacted output; the `/api/state` route test (separately) pins that the
typed identity field **does** appear on success.

### Authentication

- `/api/state` requires operator session
  ([../../../../src/contracts/operator-api.ts#L264](../../../../src/contracts/operator-api.ts)
  inherits `operatorSessionContract`). No anonymous probe can read these
  fields.
- The same operator can read the systemd unit, `ps -ef`, and the
  `.saivage/saivage.json` already; exposing the path on the API surface is
  not a privilege escalation.
- No new code path emits `projectRoot` into logs, error messages, or
  unauthenticated routes.

## Backward-compatibility (deliberate break)

Per workspace policy, we make `projectRoot` and `projectId` required and
update all consumers. We do **not** add them as optional and we do **not**
keep a parallel `/api/state-v1` route. Consumers that need updating:

- `web/src/__tests__/api-client-contracts.test.ts` — augment the `runtime.getState` mock.
- `web/src/__tests__/runtime-store.test.ts` — augment `getRuntimeState` mocks.
- `web/src/__tests__/operator-dashboard-smoke.test.ts` — augment the
  dashboard mocks.
- `web/src/stores/runtime.ts` (consumer surface) — add `projectRoot` /
  `projectId` to the store state and expose getters (F08 may consume them in
  a later round; F14 only wires the data through).
- Any backend Jest test that parses
  `RuntimeGetStateResponseSchema` (search during implementation; expected:
  zero or few).

## Non-goals (explicit)

- F14 does **not** update `AppShell.vue` to consume `projectId` for the
  header. That is F08; this design only makes the field available.
- F14 does **not** change `health.liveness`'s hard-coded `project:
  'saivage-v3'`. Documented in r2 analysis as an open question.
- F14 does **not** add a WS broadcast on `projectRoot` change (it never
  changes during a process lifetime).

## Contracts emitted

After implementation, a manual `curl` looks like:

```json
{
  "projectRoot": "/work/saivage-v3",
  "projectId": "saivage-v3",
  "runtime": { "status": "running", "project_id": "saivage-v3", "pid": 12345, ... },
  "cardIndex": { "total": 7, "byStatus": { "running": 1, "done": 6 }, "byType": { "project": 1, "code": 6 } },
  "cardStoreHealth": { "canonical": "ok" },
  "serverAvailability": { ... }
}
```

When the runtime state file is missing:

```json
{
  "projectRoot": "/work/saivage-v3",
  "projectId": "saivage-v3",
  "runtime": null,
  "cardIndex": { "total": 0, "byStatus": {}, "byType": {} }
}
```

## Acceptance signal

`curl -fsS http://10.0.3.170:8080/api/state -H "Authorization: …" | jq
'.projectRoot, .projectId'` returns `"/work/getrich-v2"` and
`"getrich-v2"` (or equivalent for the live deployment) — and the same probe
on `saivage-v3` 10.0.3.112 returns its own values. The operator can now tell
the deployments apart from the API alone.
