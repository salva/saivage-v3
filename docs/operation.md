# Saivage v3 — Operation Guide

This guide covers current runtime behavior, health and control endpoints, docs and web serving, evidence inspection, process views, and operator verification commands.

## Server startup modes

### API/server only

```bash
SAIVAGE_API_TOKEN=your-token node dist/src/server/server.js
```

This starts the Fastify server, public docs/SPA serving, auth-protected API routes, WebSocket support, MCP startup, and optional Telegram startup, but **does not** create an `ActiveRuntime` dispatch loop.

### Server with runtime creation

```bash
SAIVAGE_API_TOKEN=your-token node dist/src/server/server.js --create-runtime
```

With runtime creation enabled, Saivage initializes `ActiveRuntime`, reads or creates runtime state, performs runtime startup behavior, and can dispatch backlog work.

## Public vs protected surfaces

Public when the server is up:

- `GET /health`
- `/` SPA assets
- `/docs/` built VitePress docs

Protected when `SAIVAGE_API_TOKEN` is configured:

- all `/api/*`
- `/ws`

Accepted auth methods:

- `Authorization: Bearer <token>`
- `?token=<token>`

If no API token is configured, the server only allows tokenless startup on localhost-style bindings.

## Runtime status surfaces

### `/health`

`GET /health` is the fastest operator-safe runtime summary. It reports:

- `status: "ok"`
- server version and project name
- `runtime`: `unknown`, `idle`, `running`, `paused`, `error`, or `frozen`
- `frozen_reason` when the runtime is frozen and a freeze manifest is present

`/health` reads runtime state from the configured `projectRoot`, not from `process.cwd()`.

### `/api/runtime/status`

Returns runtime-focused status data:

- `runtime`
- `paused`
- `currentCardId`
- `goalCount`

If no `ActiveRuntime` is attached, the server falls back to runtime state on disk.

## Runtime control endpoints

Accepted shared pause/resume validation now applies to REST controls and analyst tools. Live in-memory propagation applies when the caller is wired to the server-owned `ActiveRuntime` (REST routes and server-hosted analyst chat/WebSocket when runtime creation is enabled):

- **live + `ActiveRuntime` available**: pause/resume propagates through the live runtime authority and updates in-memory dispatch state;
- **no injected `ActiveRuntime`**: pause/resume operates on persisted runtime state only, which is valid for server-only inspection/control setups and direct utility contexts;
- **frozen**: generic resume is rejected and operators must use `POST /api/runtime/resume-from-freeze`;
- **runtime state unavailable**: pause/resume returns an actionable error instead of creating replacement state implicitly.

### Pause

```bash
curl -X POST http://localhost:8080/api/runtime/pause \
  -H "Authorization: Bearer $SAIVAGE_API_TOKEN"
```

Pause stops new dispatch. Running processes are not forcibly killed by pause alone.

### Resume

```bash
curl -X POST http://localhost:8080/api/runtime/resume \
  -H "Authorization: Bearer $SAIVAGE_API_TOKEN"
```

Resume re-enables dispatch. Depending on queued work, the runtime may settle into `idle` or continue in `running`.

### Dispatch a goal explicitly

```bash
curl -X POST http://localhost:8080/api/runtime/dispatch \
  -H "Authorization: Bearer $SAIVAGE_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"goalId":"goal-123"}'
```

This requires an active runtime and a readable goal card.

### Freeze

```bash
curl -X POST http://localhost:8080/api/runtime/freeze \
  -H "Authorization: Bearer $SAIVAGE_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"reason":"operator handoff before maintenance"}'
```

Freeze is an intentional operator handoff. Saivage records a freeze manifest and moves runtime state to `frozen` with pause semantics.

### Resume from freeze

```bash
curl -X POST http://localhost:8080/api/runtime/resume-from-freeze \
  -H "Authorization: Bearer $SAIVAGE_API_TOKEN"
```

If a freeze manifest exists, Saivage restores queued work, clears the manifest, and returns the restored queue and current card reference. Durable process reattach and termination are deferred and are not restored from freeze manifests in this cycle.

## Planner control and completion semantics

Current accepted behavior after Stage 07 is:

- goal cards own planning state;
- planner-control frames and dispatch records persist under `.saivage/runtime/`;
- parent planners suspend while child work runs and resume when child dispatches complete;
- terminal dispatches are expected to produce completion evidence;
- operators must not treat an empty ready queue alone as proof of strategic project completion.

See [Goal Planning Runtime](/goal-planning-runtime) for the model-level explanation.

## Evidence and generated-file inspection

`GET /api/cards/:id` returns card detail plus an `evidence` object. Current evidence surfaces include:

- `generatedFiles`
- `verificationCommands`
- `artifactPaths`
- `toolErrors`
- optional `parseFailure`

Important operational constraints:

- generated-file evidence enrichment is a **detail-route** behavior, not a list-route behavior;
- the Web Control Room card detail view is the supported operator surface for inspecting this evidence;
- file preview is text-only and subject to containment, secret blocking/redaction, size limits, and binary rejection.

Examples from the current safety model:

- `.saivage/auth-profiles.json` is blocked from preview;
- `.saivage/saivage.json` may be previewed only in redacted form;
- large or binary files return non-previewable states.

## File browsing and generated preview safety

`GET /api/files` lists contained directories and files.

`GET /api/files/content?path=...` returns text preview only when the file is:

- inside the project containment boundary,
- not blocked by secret policy,
- not oversized,
- not binary.

Operators should prefer the Files view and card-detail evidence links over manual `.saivage` file spelunking during normal operation.

## Safe process views

`GET /api/processes` and `GET /api/processes/:id` expose operator-safe `ProcessView` responses rather than raw process-registry records.

A safe process view includes:

- status and timestamps
- redacted command text
- contained relative `cwd` when available
- contained relative log refs when available
- read-only control metadata such as `can_view_logs` and `termination_available: false`

It intentionally does **not** expose arbitrary absolute paths or raw secret-bearing command strings.

## Debug and inspection endpoints

Useful operator endpoints:

- `GET /api/debug/state`
- `GET /api/debug/errors`
- `GET /api/debug/timeline`
- `GET /api/debug/doctor`
- `GET /api/debug/supervision`
- `GET /api/mcp/status`
- `GET /api/mcp/tools`

Use these before editing runtime files manually.

## Web Control Room freshness model

The current UI model is:

- REST fetches remain authoritative after page load, refresh, and reconnect.
- WebSocket events improve freshness and live UX but are not the only source of truth.
- Unauthorized, offline, stale, and degraded states are intentional UI states, not implicit success states.

## Verification commands

### Documentation

```bash
npm run docs:verify
npm run docs:build
```

`npm run docs:verify` already runs the VitePress build and then checks expected output pages.

### Web Control Room

```bash
npm run web:typecheck
npm run web:test:control-room
npm run web:test:stores
npm run web:test:sweep
```

### Core project checks

```bash
npm run typecheck
npm test
```

## Backup and recovery guidance

Persistent state lives primarily in `.saivage/`. Generated and temporary work outputs live in `.saivage-work/`.

Recommended operator sequence for maintenance or backup:

1. Pause or freeze the runtime.
2. Confirm current runtime health and queue state.
3. Back up `.saivage/`.
4. Back up `.saivage-work/` if you need process logs or generated artifacts.
5. Resume or `resume-from-freeze` when the maintenance window ends.

For recovery and incident workflows, use the [Operator Runbook](/operator-runbook) and [Troubleshooting](/troubleshooting).
