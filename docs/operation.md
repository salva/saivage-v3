# Saivage v3 — Operation Guide

<!-- doc-authority
status: current
disposition: keep
owner: docs-maintainers
superseded_by: none
last_verified_against: src/server/server.ts:1
-->

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

With runtime creation enabled, Saivage initializes `ActiveRuntime`, reads or creates runtime state, repairs restart-visible runtime ledgers, and then runs only work authorized by explicit runtime intent or parent-planner activation records. Runtime creation does not scan status buckets or backlog queues to discover new work.

## Public vs protected surfaces

Public when the server is up:

- `GET /health`
- `/` SPA assets
- `/docs/` built VitePress docs

Protected when `SAIVAGE_API_TOKEN` is configured:

- all `/api/*`
- `/ws`

Accepted REST API bearer transport:

- `Authorization: Bearer <token>`

URL/query API bearer credentials such as `?token=<token>` are prohibited and rejected when token auth is enabled, even if a valid bearer header is also present. Existing scripts and bookmarks that placed API tokens in URLs must switch to bearer headers or the web UI's manual token entry.

Browser WebSocket clients cannot attach custom authorization headers. They must first request a short-lived, one-use ticket through authenticated REST, then use that ticket for the WebSocket upgrade:

```bash
curl -X POST http://localhost:8080/api/auth/ws-ticket \
  -H "Authorization: Bearer <synthetic-api-token>"
# {"ticket":"wst_<opaque-ticket>","expiresAt":"2026-01-01T00:00:30.000Z"}
```

The browser then connects to `/ws?ticket=wst_<opaque-ticket>`. The ticket is not an API bearer token, is process-local, expires quickly, and can be used only once. Do not put API bearer tokens in REST or WebSocket URLs.

If no API token is configured, the server only allows tokenless startup on localhost-style bindings.

## Runtime status surfaces

### `/health`

`GET /health` is the fastest operator-safe liveness probe. It reports only:

- `status: "ok"`
- server version and project name

It intentionally does not read runtime state and does not include readiness, runtime, frozen, or availability fields.

### `/health/ready`

`GET /health/ready` is the readiness probe. It reports `status: "ready"` or `status: "not_ready"` and may include `serverAvailability`, an additive component map with `api`, `runtime`, and `mcp` entries. Each component has `state: available | degraded | unavailable | unknown`, a `source`, `checkedAt`, and an optional redacted diagnostic `{ code, summary }`. Diagnostics are bounded synthetic startup summaries, not token/env/stack dumps.

### `/api/runtime/status`

Returns runtime-focused status data:

- `runtime`
- `paused`
- `currentCardId`
- `goalCount`
- runtime command/run/activation and intent metadata when available through detailed runtime surfaces
- optional `serverAvailability` with the same component contract as `/health`

If no `ActiveRuntime` is attached, the server falls back to runtime state on disk.

## Runtime control endpoints

Accepted shared pause/resume validation now applies to REST controls and analyst tools. Live in-memory propagation applies when the caller is wired to the server-owned `ActiveRuntime` (REST routes and server-hosted analyst chat/WebSocket when runtime creation is enabled):

- **live + `ActiveRuntime` available**: pause/resume propagates through the live runtime authority and updates in-memory dispatch state;
- **no injected `ActiveRuntime`**: pause/resume operates on persisted runtime state only, which is valid for server-only inspection/control setups and direct utility contexts;
- **frozen**: generic resume is rejected and operators must use `POST /api/runtime/resume-from-freeze`;
- **runtime state unavailable**: pause/resume returns an actionable error instead of creating replacement state implicitly.

### Start project

```bash
curl -X POST http://localhost:8080/api/runtime/start_project \
  -H "Authorization: Bearer $SAIVAGE_API_TOKEN"
```

Starts root project execution through an explicit runtime command. The success response is a `RuntimeCommandResponse`: `success: true`, a `command` record, the updated runtime `intent`, and a root `run` record. If no `ActiveRuntime` is attached or start preconditions fail, the route returns `success: false` with an actionable error envelope.

### Stop project

```bash
curl -X POST http://localhost:8080/api/runtime/stop_project \
  -H "Authorization: Bearer $SAIVAGE_API_TOKEN"
```

Stops root project execution intent through an explicit runtime command. The success response is a `RuntimeCommandResponse`: `success: true`, the stop `command` record, the stopped runtime `intent`, and, when an open root run existed, `run` containing the authoritative terminalized root `RuntimeRunRecord`. The `run` field is intentionally optional: it is omitted when there was no open root run to terminalize, but command and intent still describe the accepted stop request.

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
Operators start root work with explicit runtime controls and record corrections as planner context:

- Root project kickoff uses explicit runtime start controls (`start_project`/operator runtime controls); directive kickoff routes are removed.
- `POST /api/runtime/goals/:id/needs_corrections` records goal corrections.
- Project-level correction directives are no longer executable runtime triggers; use goal-scoped correction notes and explicit runtime controls.

The runtime no longer scans directive files, status buckets, or status-derived dispatch queues to discover executable work. It runs root work from explicit runtime commands and child work from parent-planner activation records.

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
- operators must not treat an empty status-derived dispatch queue alone as proof of strategic project completion.

See [Goal Planning Runtime](/goal-planning-runtime) for the model-level explanation.

## Evidence and generated-file inspection

`GET /api/cards/:id` returns card detail plus an `evidence` object. Current evidence surfaces include:

- `generatedFiles` for project files created or modified by executor workspace tools;
- `verificationCommands`;
- `artifactPaths` for registered Saivage process metadata/output under `.saivage-work`;
- `toolErrors`;
- optional `parseFailure`.

Project source, config, test, data, and documentation files remain project state. Saivage does not register or copy them as artifacts; agents should list those paths in generated-file/result metadata and pair them with verification commands. Registered artifacts and attachments are reserved for Saivage process metadata such as validation reports, command logs, run manifests, and similar generated process outputs.

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

`GET /api/mcp/status` preserves the historical `{ servers: [] }` response when no MCP manager is attached, and now may include optional `serverAvailability.components.mcp` so operators can distinguish startup failure, unknown/not-attempted state, and an empty/degraded manager. `GET /api/state` likewise accepts optional `serverAvailability` beside `runtime`, `cardIndex`, and `cardStoreHealth`; older clients can ignore the field.

Use these before editing runtime files manually.

## Web Control Room freshness model

The current UI model is:

- `GET /api/state` REST fetches remain authoritative after page load, refresh, reconnect, and whenever an operator needs a fresh complete snapshot.
- Runtime command responses (`POST /api/runtime/start_project` and `POST /api/runtime/stop_project`) are authoritative for the command just submitted.
- WebSocket events improve freshness and live UX but are observational projections, not the only source of truth.
- Unauthorized, offline, stale, and degraded states are intentional UI states, not implicit success states.

Runtime Console and Planning Tree responsibilities are separate. Use the Runtime Console and runtime API for root `start_project` / `stop_project`, runtime intent, command/run/activation ledgers, and actionable runtime errors. Use the Planning Tree for card hierarchy, planner-owned state, dependencies, evidence, and discussion. Moving a card, editing planner state, writing notes or directive files, or satisfying a preview confirmation never starts, stops, or activates runtime work.

### Runtime ledger WebSocket events

The operator WebSocket emits live observational projections of runtime ledger and actionable-error updates:

| Event | Envelope type | Payload | Meaning |
|---|---|---|---|
| `runtime.command` | `activity` | `command` | A runtime command ledger record was persisted, including accepted `start_project` / `stop_project` commands or command errors. |
| `runtime.run` | `status` | `run` | A root or child runtime run record changed, including terminalized root runs produced by `stop_project`. |
| `runtime.activation` | `activity` | `activation` | A parent-planner `activate_card` activation ledger record changed. |
| `runtime.actionable_error` | `error` | `actionable_error` | A runtime-control or activation precondition failure was recorded with a stable code and next action. |

These events are not execution authority. They do not start root work, stop root work, activate child cards, or confirm mutations by themselves; they only let operators and the Runtime Console observe persisted command/run/activation/actionable-error changes sooner. For authoritative freshness, clients must still reconcile through `GET /api/state` after page load, reconnect, stale live updates, or command completion, and command callers should trust the REST command response for the just-submitted mutation.

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

The canonical web test namespace is `web:test*`. Ergonomic `test:web` and `test:web:*` aliases are accepted only when they delegate to the matching canonical `web:test*` package script; docs verification fails if a documented alias is missing or drifts from that target.

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

Every current operator-facing Fastify or contract-mounted route is listed exactly once here. `npm run docs:verify` compares this table with `src/server/server.ts`, `src/server/routes/**`, and `src/contracts/operator-api.ts`.

| Route | Purpose | Code anchor |
|---|---|---|
| `DELETE /api/cards/:id` | Delete a card through audited mutating control flow. | `src/contracts/operator-api.ts:371 "path: '/api/cards/:id'"` |
| `DELETE /api/notes/:id` | Delete one unhandled note. | `src/server/routes/runtime-config-notes.ts:177` |
| `DELETE /api/notes` | Clear all unhandled notes. | `src/server/routes/runtime-config-notes.ts:180` |
| `GET /api/agents/:id/conversation` | Read one persisted agent conversation. | `src/server/routes/runtime-config-notes.ts:179` |
| `GET /api/agents` | List persisted agent sessions. | `src/server/routes/runtime-config-notes.ts:178` |
| `POST /api/auth/ws-ticket` | Issue a short-lived one-use browser WebSocket ticket after bearer REST auth. | `src/server/routes/auth.ts:4` |
| `GET /api/cards/:id/diff` | Diff card versions. | `src/contracts/operator-api.ts:359 "path: '/api/cards/:id/diff'"` |
| `GET /api/cards/:id/history/:seq` | Read one card-history snapshot. | `src/contracts/operator-api.ts:348 "path: '/api/cards/:id/history/:seq'"` |
| `GET /api/cards/:id/history` | List card-history headers. | `src/contracts/operator-api.ts:337 "path: '/api/cards/:id/history'"` |
| `GET /api/cards/:id` | Read card detail with children and ancestors. | `src/contracts/operator-api.ts:325 "path: '/api/cards/:id'"` |
| `GET /api/cards` | List cards. | `src/contracts/operator-api.ts:315 "path: '/api/cards'"` |
| `GET /api/chats/:sessionId` | Read an analyst chat transcript. | `src/server/routes/chats-files-debug.ts:114` |
| `GET /api/chats` | List analyst chat sessions. | `src/server/routes/chats-files-debug.ts:81` |
| `GET /api/config` | Return redacted loaded configuration and warnings. | `src/server/routes/runtime-config-notes.ts:180` |
| `GET /api/control-actions` | List control-action audit entries. | `src/server/routes/runtime-config-notes.ts:165` |
| `GET /api/debug/doctor` | Run persisted-card consistency checks. | `src/server/routes/chats-files-debug.ts:389` |
| `GET /api/debug/errors` | Read runtime error records. | `src/server/routes/chats-files-debug.ts:341` |
| `GET /api/debug/state` | Dump runtime and card-index debug state. | `src/server/routes/chats-files-debug.ts:306` |
| `GET /api/debug/supervision` | Read content-supervision review/quarantine summary. | `src/server/routes/chats-files-debug.ts:535` |
| `GET /api/debug/timeline` | Read runtime event timeline records. | `src/server/routes/chats-files-debug.ts:365` |
| `GET /api/events` | Query runtime/agent events with filters and pagination. | `src/server/routes/events.ts:42` |
| `GET /api/files/content` | Preview contained text files with safety checks. | `src/server/routes/chats-files-debug.ts:238` |
| `GET /api/files` | List contained project files. | `src/server/routes/chats-files-debug.ts:178` |
| `GET /api/mcp/status` | Show MCP server status plus optional serverAvailability. | `src/server/server.ts:113 "fastify.get('/api/mcp/status'"` |
| `GET /api/mcp/tools` | Show MCP tool inventory and invocation stats. | `src/server/server.ts:114 "fastify.get('/api/mcp/tools'"` |
| `GET /api/notes` | List unhandled notes. | `src/server/routes/runtime-config-notes.ts:180` |
| `GET /api/notifications` | List notifications. | `src/server/routes/runtime-config-notes.ts:165` |
| `GET /api/processes/:id` | Read one safe process view. | `src/server/routes/processes.ts:112` |
| `GET /api/processes` | List safe process views. | `src/server/routes/processes.ts:100` |
| `GET /api/providers` | Return redacted provider summaries. | `src/server/routes/runtime-config-notes.ts:177` |
| `GET /api/runtime/card-runs` | List runtime card-run records. | `src/server/server.ts:64 "fastify.get('/api/runtime/card-runs'"` |
| `GET /api/runtime/status` | Read compact runtime status plus optional serverAvailability. | `src/server/server.ts:66 "fastify.get('/api/runtime/status'"` |
| `GET /api/state` | Read RuntimeState plus card-index summary and optional availability. | `src/contracts/operator-api.ts:260 "path: '/api/state'"` |
| `GET /health` | Public liveness probe. | `src/contracts/operator-api.ts:239 "path: '/health'"` |
| `GET /health/ready` | Public readiness probe with optional availability summary. | `src/contracts/operator-api.ts:250 "path: '/health/ready'"` |
| `PATCH /api/cards/:id` | Update allowed card fields through audited mutation. | `src/contracts/operator-api.ts:395 "path: '/api/cards/:id'"` |
| `POST /api/cards` | Create a card through audited mutation. | `src/contracts/operator-api.ts:383 "path: '/api/cards'"` |
| `POST /api/chats/:sessionId` | Send an analyst chat message. | `src/server/routes/chats-files-debug.ts:148` |
| `POST /api/notes/:id/acknowledge` | Mark an unhandled note handled. | `src/server/routes/runtime-config-notes.ts:180` |
| `POST /api/notifications/:id/acknowledge` | Acknowledge a notification. | `src/server/routes/runtime-config-notes.ts:145` |
| `POST /api/runtime/freeze` | Freeze runtime for handoff. | `src/server/routes/runtime-config-notes.ts:174` |
| `POST /api/runtime/start_project` | Start root project execution via explicit runtime command. | `src/contracts/operator-api.ts:271 "path: '/api/runtime/start_project'"` |
| `POST /api/runtime/stop_project` | Stop root project execution intent via explicit runtime command. | `src/contracts/operator-api.ts:282 "path: '/api/runtime/stop_project'"` |
| `POST /api/runtime/goals/:id/needs_corrections` | Record goal correction directive. | `src/server/server.ts:56 "fastify.post('/api/runtime/goals/:id/needs_corrections'"` |
| `POST /api/runtime/pause` | Pause runtime and return RuntimeState. | `src/contracts/operator-api.ts:294 "path: '/api/runtime/pause'"` |
| `POST /api/runtime/resume-from-freeze` | Resume from freeze manifest. | `src/server/routes/runtime-config-notes.ts:175` |
| `POST /api/runtime/resume` | Resume runtime and return RuntimeState. | `src/contracts/operator-api.ts:305 "path: '/api/runtime/resume'"` |
<!-- saivage:operator-routes:end -->

<!-- saivage:runtime-controls:start -->
## Runtime control request/response shapes

`npm run docs:verify` checks these shapes against the implemented runtime-control routes.

| Route | Request body | Success response | Code anchor |
|---|---|---|---|
| `POST /api/runtime/start_project` | `empty-or-null-json-object` | `RuntimeCommandResponse` | `src/contracts/operator-api.ts:271 "path: '/api/runtime/start_project'"` |
| `POST /api/runtime/stop_project` | `empty-or-null-json-object` | `RuntimeCommandResponse` | `src/contracts/operator-api.ts:282 "path: '/api/runtime/stop_project'"` |
| `POST /api/runtime/pause` | `empty-or-null-json-object` | `RuntimeState` | `src/contracts/operator-api.ts:294 "path: '/api/runtime/pause'"` |
| `POST /api/runtime/resume` | `empty-or-null-json-object` | `RuntimeState` | `src/contracts/operator-api.ts:305 "path: '/api/runtime/resume'"` |
| `POST /api/runtime/freeze` | `optional-object:{reason?:string}` | `freeze-summary` | `src/server/routes/runtime-config-notes.ts:174` |
| `POST /api/runtime/resume-from-freeze` | `empty-or-null-json-object` | `resume-from-freeze-summary` | `src/server/routes/runtime-config-notes.ts:175` |
<!-- saivage:runtime-controls:end -->
