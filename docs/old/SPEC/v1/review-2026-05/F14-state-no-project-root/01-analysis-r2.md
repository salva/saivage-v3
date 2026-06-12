# F14 r2 — Analysis: `/api/state` has no `projectRoot` field

> r2 changes vs r1: relative-link depth corrected (`../../../../` from this
> directory reaches the repo `src/`), no other substantive analysis change.

## Issue restated

`GET /api/state` (operator-session contract `runtime.getState`) returns
`{ runtime, cardIndex, cardStoreHealth?, serverAvailability? }` only. The
Phase-2 test matrix (G2/T23) and the historical contract expectation include a
top-level `projectRoot` field for deployment identity. Combined with F08
(hard-coded `'saivage-v3'` header subtitle) and F18 (`runtime.pid` null),
operators auditing three deployments (`saivage` 10.0.3.111, `saivage-v3`
10.0.3.112, `saivage-v3-getrich-v2` 10.0.3.170) cannot read the API and tell
which target project the server was started against without inspecting the
systemd `EnvironmentFile`.

## Current behavior (cited)

### Contract schema

[../../../../src/contracts/operator-api.ts#L132-L137](../../../../src/contracts/operator-api.ts)
```ts
export const RuntimeGetStateResponseSchema = z.object({
  runtime: runtimeStateSchema.nullable(),
  cardIndex: CardIndexSummarySchema,
  cardStoreHealth: CardStoreHealthSchema.optional(),
  serverAvailability: ServerAvailabilitySchema.optional(),
});
```

Route definition [../../../../src/contracts/operator-api.ts#L259-L268](../../../../src/contracts/operator-api.ts):
```ts
'runtime.getState': {
  operationId: 'runtime.getState',
  method: 'GET',
  path: '/api/state',
  success: RuntimeGetStateResponseSchema,
  …
}
```
No `projectRoot`, no `projectId`, no deployment identifier on this schema.

### Handler

[../../../../src/server/routes/operator-contracts.ts#L81-L88](../../../../src/server/routes/operator-contracts.ts)
assembles the body from `readRuntimeState(projectRoot)`, `store.list()`, and an
optional `serverAvailability` — `options.projectRoot` (the same `projectRoot`
already plumbed into the handler factory at line 51 `const { fastify,
projectRoot } = options;`) is never copied into the response.

### Related, in-scope identifiers that already exist

- `runtime.project_id` inside `RuntimeState` (persisted in
  `.saivage/runtime/runtime-state.json`, surfaced as `body.runtime.project_id`
  whenever the runtime row exists).
- `health.liveness` returns a hard-coded `project: 'saivage-v3'`
  ([../../../../src/server/routes/operator-contracts.ts#L72](../../../../src/server/routes/operator-contracts.ts))
  — irrelevant for operators because every deployment serves the same literal.

### Front-end consumer

[../../../../web/src/components/layout/AppShell.vue#L100](../../../../web/src/components/layout/AppShell.vue)
hard-codes `const projectName = computed(() => 'saivage-v3');` because no API
field exposes the live identity. This is F08; F14 unblocks F08's data source.

## Root cause

`registerOperatorContractRoutes(options)` already receives `projectRoot` in
[../../../../src/server/routes/operator-contracts.ts#L46-L51](../../../../src/server/routes/operator-contracts.ts);
the value is consumed for `readRuntimeState`, `new CardStore(projectRoot)`, and
the `runMutatingRoute` wrappers, but the `runtime.getState` handler never
projects it onto the response, and the Zod schema would reject it if it did.
This is a missed contract field, not a data-flow gap.

## Impact

- **Operator multi-deployment audit (P3, informational).** Identifying which
  project a server is serving currently requires reading
  `/etc/systemd/system/saivage-v3-getrich.service` EnvironmentFile or running
  `ps -ef | grep 'serve '` over SSH — both privileged and out of band.
- **Front-end identity (F08 enabler).** Once `projectRoot` is exposed, the web
  shell can stop hard-coding `'saivage-v3'`.
- **Contract drift (the stated category).** The Phase-2 matrix asserts a field
  the server does not provide; either the matrix is wrong or the server is.
  Architecture-first says the server is wrong: deployment identity is a
  legitimate first-class field of `/api/state`.

## Scope (transversality)

- **Local:**
  - `src/contracts/operator-api.ts` (schema)
  - `src/server/routes/operator-contracts.ts` (handler — both null-runtime and
    populated-runtime branches)
  - `src/contracts/operator-events.ts` if `RuntimeGetStateResponseSchema`
    shape-references propagate (the `state` envelope reuses
    `RuntimeGetStateResponseSchema.shape.runtime` but does **not** embed the
    new field; verify in r2 implementation reading).
- **Tests touched:**
  - `web/src/__tests__/api-client-contracts.test.ts` (parses
    `runtime.getState` with `projectRoot`).
  - `web/src/__tests__/runtime-store.test.ts` (mock payloads include
    `projectRoot`).
  - `web/src/__tests__/operator-dashboard-smoke.test.ts` (state mocks).
  - Any backend Jest test that parses `RuntimeGetStateResponseSchema`
    strict-mode (sweep in implementation).
- **Out of scope for F14:** F08 front-end consumption; F18 PID; F22 fail-fast
  config; F19 state machine wiring; F23 goal activation.

## Security / redaction considerations

`projectRoot` is the canonical absolute path the server was started with (e.g.,
`/work/saivage-v3`). It is **not** treated as a secret — workspace policy lists
`.saivage/auth-profiles.json`, provider configs, env files, and tokens as
sensitive; `projectRoot` is not in that set. `redactOperatorErrorMessage`
([../../../../src/workspace/file-access-security.ts#L83](../../../../src/workspace/file-access-security.ts))
strips `projectRoot` from **error messages** (defence-in-depth against
serializing file-system paths into operator-visible exceptions); deliberately
publishing the path as a typed field on a session-authenticated route is a
different category — it is identity data the operator already has access to
out of band. Exposing it does not weaken the redaction surface because:

1. `/api/state` is operator-session-authenticated (`operatorSessionContract`
   in [../../../../src/contracts/operator-api.ts#L264](../../../../src/contracts/operator-api.ts)).
2. The same operator can read the systemd unit and the
   `.saivage/saivage.json` already.
3. No new exception path emits `projectRoot`; the redaction helper continues
   to strip it from error messages — and r2 plan adds a focused regression
   test proving that the typed identity field and the redaction path stay on
   their separate channels.

### Why these two channels do not collide

| Channel | Carries `projectRoot`? | Why |
|---|---|---|
| `/api/state` success body (`projectRoot`, `projectId` typed fields) | Yes, deliberately | Identity data; operator-session-authenticated; not error text |
| Error messages serialised to operators (e.g., `4xx`/`5xx` JSON `message`) | No, `[PROJECT_ROOT]` redacted by `redactOperatorErrorMessage` | Defence-in-depth against accidental path leakage in stack traces or filesystem errors |

The new test in `tests/utils/file-access-security.test.ts` pins this invariant:
`redactOperatorErrorMessage('ENOENT at /work/saivage-v3/missing.json',
'/work/saivage-v3')` must return a string that contains `[PROJECT_ROOT]` and
never the raw `/work/saivage-v3` substring.

## Alternatives considered (full design in r2 design doc)

- (A) Expose `projectRoot` only — minimal, matches the issue verbatim.
- (B) Expose `projectId` (basename) only — friendlier to UI but loses the
  unambiguous identifier when two deployments share a basename (e.g.,
  `/work/saivage-v3` vs `/var/saivage-v3`).
- (C) Expose both `projectRoot` and `projectId` — most useful, two cheap
  strings, no migration cost given the no-backward-compat rule.

Design r2 picks **(C)** with `projectRoot` as the canonical identity and
`projectId = path.basename(projectRoot)` as a UI affordance.

## Coordination with binding decisions

- **F13** (card-store reshape): F14 is orthogonal — only adds two scalar
  response fields. Lands cleanly either order.
- **F19** (RuntimeStateMachine + async `transitionCard`): F14 does not touch
  the runtime/state-machine seam.
- **F22** (fail-fast `loadEnvironment`): F22 strengthens the precondition that
  `environment.projectRoot` is always a valid absolute path at server boot;
  F14 relies on that exact invariant.
- **F23** (goal activation via state machine): independent.

## Open questions for the orchestrator

1. Should `health.liveness` `project: 'saivage-v3'` literal also be replaced
   with the live `projectId`? Probably yes (one-liner), but it touches the
   liveness contract — defer to a reviewer note unless the orchestrator wants
   it folded into F14.
2. Do any third-party automation scripts under `getrich-v2/tools/` parse
   `/api/state` strict-mode and would reject an additional required field?
   Grep during implementation; if found, schema stays as `projectRoot`
   required (the rule is no-backward-compat) and the scripts must be updated.
