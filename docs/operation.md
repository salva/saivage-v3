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

Pause stops new dispatch. Running processes are not forcibly killed by pause alone. The response body is the updated `RuntimeState`.

### Resume

```bash
curl -X POST http://localhost:8080/api/runtime/resume \
  -H "Authorization: Bearer $SAIVAGE_API_TOKEN"
```

Resume re-enables dispatch. Depending on queued work, the runtime may settle into `idle` or continue in `running`. The response body is the updated `RuntimeState`.

### Dispatch and corrections

Legacy explicit dispatch endpoints are not part of the current §14 API surface.
Operators start or correct work by recording directives instead:

- `POST /api/runtime/lets_dance` records a project kickoff directive.
- `POST /api/runtime/goals/:id/needs_corrections` records goal corrections.
- `POST /api/runtime/project/needs_corrections` records project-level corrections.

The runtime consumes eligible directives on its scheduler safe tick and owns any
subsequent card activation.

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

`npm run docs:verify` runs the VitePress build, checks expected output pages, and semantically verifies operator-facing HTTP routes mentioned in active docs against the Fastify route table. Removed legacy dispatch guidance fails verification if it reappears in current operator instructions.

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

<!-- saivage:operator-routes:start -->
## Operator-facing HTTP route inventory

Every current operator-facing Fastify route is listed exactly once here. `npm run docs:verify` compares this table with `src/server/server.ts` and `src/server/routes/**`.

| Route | Purpose | Code anchor |
|---|---|---|
| `DELETE /api/cards/:id` | Delete a card through audited mutating control flow. | `src/server/routes/cards.ts:175` |
| `DELETE /api/notes/:id` | Delete one unhandled note. | `src/server/routes/runtime-config-notes.ts:194` |
| `DELETE /api/notes` | Clear all unhandled notes. | `src/server/routes/runtime-config-notes.ts:195` |
| `GET /api/agents/:id/conversation` | Read one persisted agent conversation. | `src/server/routes/runtime-config-notes.ts:191` |
| `GET /api/agents` | List persisted agent sessions. | `src/server/routes/runtime-config-notes.ts:190` |
| `GET /api/cards/:id/diff` | Diff card versions. | `src/server/routes/cards.ts:105` |
| `GET /api/cards/:id/history/:seq` | Read one card-history snapshot. | `src/server/routes/cards.ts:91` |
| `GET /api/cards/:id/history` | List card-history headers. | `src/server/routes/cards.ts:80` |
| `GET /api/cards/:id` | Read card detail with children and ancestors. | `src/server/routes/cards.ts:79` |
| `GET /api/cards` | List cards. | `src/server/routes/cards.ts:78` |
| `GET /api/chats/:sessionId` | Read an analyst chat transcript. | `src/server/routes/chats-files-debug.ts:114` |
| `GET /api/chats` | List analyst chat sessions. | `src/server/routes/chats-files-debug.ts:81` |
| `GET /api/config` | Return redacted loaded configuration and warnings. | `src/server/routes/runtime-config-notes.ts:197` |
| `GET /api/control-actions` | List control-action audit entries. | `src/server/routes/runtime-config-notes.ts:175` |
| `GET /api/debug/doctor` | Run persisted-card consistency checks. | `src/server/routes/chats-files-debug.ts:389` |
| `GET /api/debug/errors` | Read runtime error records. | `src/server/routes/chats-files-debug.ts:341` |
| `GET /api/debug/state` | Dump runtime and card-index debug state. | `src/server/routes/chats-files-debug.ts:306` |
| `GET /api/debug/supervision` | Read content-supervision review/quarantine summary. | `src/server/routes/chats-files-debug.ts:535` |
| `GET /api/debug/timeline` | Read runtime event timeline records. | `src/server/routes/chats-files-debug.ts:365` |
| `GET /api/events` | Query runtime/agent events with filters and pagination. | `src/server/routes/events.ts:42` |
| `GET /api/files/content` | Preview contained text files with safety checks. | `src/server/routes/chats-files-debug.ts:238` |
| `GET /api/files` | List contained project files. | `src/server/routes/chats-files-debug.ts:178` |
| `GET /api/mcp/status` | Show MCP server status. | `src/server/server.ts:86 "fastify.get('/api/mcp/status'"` |
| `GET /api/mcp/tools` | Show MCP tool inventory and invocation stats. | `src/server/server.ts:87 "fastify.get('/api/mcp/tools'"` |
| `GET /api/notes` | List unhandled notes. | `src/server/routes/runtime-config-notes.ts:192` |
| `GET /api/notifications` | List notifications. | `src/server/routes/runtime-config-notes.ts:146` |
| `GET /api/processes/:id` | Read one safe process view. | `src/server/routes/processes.ts:112` |
| `GET /api/processes` | List safe process views. | `src/server/routes/processes.ts:100` |
| `GET /api/providers` | Return redacted provider summaries. | `src/server/routes/runtime-config-notes.ts:198` |
| `GET /api/runtime/card-runs` | List runtime card-run records. | `src/server/server.ts:51 "fastify.get('/api/runtime/card-runs'"` |
| `GET /api/runtime/status` | Read compact runtime status. | `src/server/server.ts:53 "fastify.get('/api/runtime/status'"` |
| `GET /api/state` | Read RuntimeState plus card-index summary. | `src/server/routes/runtime-config-notes.ts:145` |
| `GET /health` | Public health and runtime-status summary. | `src/server/server.ts:28 "fastify.get('/health'"` |
| `PATCH /api/cards/:id` | Update allowed card fields through audited mutation. | `src/server/routes/cards.ts:145` |
| `POST /api/cards` | Create a card through audited mutation. | `src/server/routes/cards.ts:123` |
| `POST /api/chats/:sessionId` | Send an analyst chat message. | `src/server/routes/chats-files-debug.ts:148` |
| `POST /api/notes/:id/acknowledge` | Mark an unhandled note handled. | `src/server/routes/runtime-config-notes.ts:193` |
| `POST /api/notifications/:id/acknowledge` | Acknowledge a notification. | `src/server/routes/runtime-config-notes.ts:154` |
| `POST /api/runtime/freeze` | Freeze runtime for handoff. | `src/server/routes/runtime-config-notes.ts:195` |
| `POST /api/runtime/goals/:id/needs_corrections` | Record goal correction directive. | `src/server/server.ts:36 "fastify.post('/api/runtime/goals/:id/needs_corrections'"` |
| `POST /api/runtime/lets_dance` | Record project kickoff directive. | `src/server/server.ts:32 "fastify.post('/api/runtime/lets_dance'"` |
| `POST /api/runtime/pause` | Pause runtime and return RuntimeState. | `src/server/routes/runtime-config-notes.ts:193` |
| `POST /api/runtime/project/needs_corrections` | Record project correction directive. | `src/server/server.ts:44 "fastify.post('/api/runtime/project/needs_corrections'"` |
| `POST /api/runtime/resume-from-freeze` | Resume from freeze manifest. | `src/server/routes/runtime-config-notes.ts:196` |
| `POST /api/runtime/resume` | Resume runtime and return RuntimeState. | `src/server/routes/runtime-config-notes.ts:194` |
<!-- saivage:operator-routes:end -->

<!-- saivage:runtime-controls:start -->
## Runtime control request/response shapes

`npm run docs:verify` checks these shapes against the implemented runtime-control routes.

| Route | Request body | Success response | Code anchor |
|---|---|---|---|
| `POST /api/runtime/pause` | `empty-or-null-json-object` | `RuntimeState` | `src/server/routes/runtime-config-notes.ts:193` |
| `POST /api/runtime/resume` | `empty-or-null-json-object` | `RuntimeState` | `src/server/routes/runtime-config-notes.ts:194` |
| `POST /api/runtime/freeze` | `optional-object:{reason?:string}` | `freeze-summary` | `src/server/routes/runtime-config-notes.ts:195` |
| `POST /api/runtime/resume-from-freeze` | `empty-or-null-json-object` | `resume-from-freeze-summary` | `src/server/routes/runtime-config-notes.ts:196` |
<!-- saivage:runtime-controls:end -->
