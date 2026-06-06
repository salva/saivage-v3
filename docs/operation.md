<!-- Role: route inventory and API/auth/contract reference only. Procedural operator workflows belong in docs/runbook/operations.md. -->

# Saivage v3 — Route Inventory


This page is the route inventory and API/auth/contract reference for operator-facing HTTP and WebSocket surfaces. Use [Runbook Operations](/runbook/operations) for startup, runtime control, maintenance, backup, incident procedure, and validation walkthroughs.

## Public vs protected route surfaces

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

The `/ws` transport carries two frame families:

- analyst chat envelopes use `{ "type": "message" | "activity" | "status" | "error", "content": { ... } }` and preserve the existing chat response/activity/error contract;
- live-state synchronization uses invalidate frames only: `{ "t": "invalidate", "resource": "runtime" | "cards" | "agents" | "timeline" | "processes" | "files" }` or `{ "t": "invalidate", "resource": "conversation", "id": "<session-id>" }`.

The server does not stream runtime/card snapshots over WebSocket. Clients treat invalidate frames as hints and refetch authoritative REST resources. Core resources are `runtime`, `cards`, and `agents`; active view resources are `timeline`, `processes`, `files`, and scoped `conversation`. Conversation subscriptions are explicit client frames: `{ "t": "subscribe", "resource": "conversation", "id": "<session-id>" }` and matching `unsubscribe`.

## Runtime status surfaces

### `/health`

`GET /health` is the fastest operator-safe liveness probe. It reports only:

- `status: "ok"`
- server version and project name

It intentionally does not read runtime state and does not include readiness, runtime, frozen, or availability fields.

### `/health/ready`

`GET /health/ready` is the readiness probe. It reports `status: "ready"` or `status: "not_ready"` and may include `serverAvailability`, an additive component map with `api`, `runtime`, and `mcp` entries. Each component has `state: available | degraded | idle | unavailable | unknown`, a `source`, `checkedAt`, and an optional redacted diagnostic `{ code, summary }`. Diagnostics are bounded synthetic startup summaries, not token/env/stack dumps. The `idle` state signals an informational not-yet-engaged component (for example, an MCP manager with no servers configured) and does not contribute to readiness failure.

### `/api/runtime/status`

Returns runtime-focused status data:

- `runtime`
- `paused`
- `currentCardId`
- `goalCount`
- runtime command/run/activation and intent metadata when available through detailed runtime surfaces
- optional `serverAvailability` with the same component contract as `/health`

If no live runtime authority is attached, the server falls back to runtime state on disk.

## Runtime control route status

The current mounted operator HTTP surface exposes runtime observation routes rather than mutating runtime-control POST routes:

- `GET /api/runtime/status` returns the compact runtime status read model.
- `GET /api/runtime/card-runs` returns persisted runtime card-run records.
- `GET /api/state` returns the broader runtime/card-index state snapshot.

Legacy explicit dispatch endpoints and stale mutating REST runtime-control routes are not part of the current operator HTTP route inventory. Root execution and goal corrections are runtime-owned commands surfaced through the current runtime/control-room architecture, not through directive-file scanning or obsolete compatibility endpoints.

Card status is never an execution trigger. Runtime execution starts from explicit runtime controls and planner activations, not from status edits.

## Evidence and generated-file inspection

`GET /api/cards/:id` returns card detail plus an `evidence` object. Current evidence surfaces include:

- `generatedFiles` for project files created or modified by executor workspace tools;
- `verificationCommands`;
- `artifactPaths` for registered Saivage process metadata/output under `.saivage-work`;
- `toolErrors`;
- optional `parseFailure`.

Project source, config, test, data, and documentation files remain project state. Saivage does not register or copy them as artifacts; agents should list those paths in generated-file/result metadata and pair them with verification commands. Registered artifacts and attachments are reserved for Saivage process metadata such as validation reports, command logs, run manifests, and similar generated process outputs.

Contract constraints:

- generated-file evidence enrichment is a **detail-route** behavior, not a list-route behavior;
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

Diagnostic endpoints:

- `GET /api/debug/state`
- `GET /api/debug/errors`
- `GET /api/debug/timeline`
- `GET /api/debug/doctor`
- `GET /api/debug/supervision`
- `GET /api/mcp/status`
- `GET /api/mcp/tools`

`GET /api/mcp/status` preserves the historical `{ servers: [] }` response when no MCP manager is attached, and now may include optional `serverAvailability.components.mcp` so operators can distinguish startup failure, unknown/not-attempted state, an informational empty manager (state `idle`, no servers configured), and a configured-but-impaired manager (state `degraded`). `GET /api/state` likewise accepts optional `serverAvailability` beside `runtime`, `cardIndex`, and `cardStoreHealth`; older clients can ignore the field. `GET /api/state` also includes top-level `projectRoot` (absolute resolved path of the active project) and `projectId` (basename of the project root) for operator tooling that needs to identify the project without parsing the runtime payload.

## Web Control Room freshness model

The current UI model is:

- `GET /api/state` REST fetches remain authoritative after page load, refresh, reconnect, and whenever an operator needs a fresh complete snapshot.
- Runtime command responses (the start-project runtime command and the stop-project runtime command) are authoritative for the command just submitted.
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

<!-- saivage:operator-routes:start -->
## Operator-facing HTTP route inventory

Every current operator-facing Fastify or contract-mounted route is listed exactly once here. `npm run docs:verify` compares this table with `src/server/server.ts`, `src/server/routes/**`, and the operator contract aggregate/slices under `src/contracts/operator-api*.ts`.

| Route | Purpose | Code anchor |
|---|---|---|
| `GET /api/agents/:id/conversation` | Read one persisted agent conversation. | `src/contracts/operator-api-agents.ts:101 "path: '/api/agents/:id/conversation'"` |
| `GET /api/agents/:id/llm-exchange` | Read the latest raw LLM exchange for an agent session. | `src/contracts/operator-api-agents.ts:112 "path: '/api/agents/:id/llm-exchange'"` |
| `GET /api/agents/:id` | Read one persisted agent-session summary. | `src/contracts/operator-api-agents.ts:90 "path: '/api/agents/:id'"` |
| `GET /api/agents` | List persisted agent sessions. | `src/contracts/operator-api-agents.ts:80 "path: '/api/agents'"` |
| `POST /api/auth/ws-ticket` | Issue a short-lived one-use browser WebSocket ticket after bearer REST auth. | `src/server/routes/auth.ts:5 "fastify.post('/api/auth/ws-ticket'"` |
| `GET /api/cards/:id/diff` | Diff card versions. | `src/contracts/operator-api-runtime-cards.ts:216 "path: '/api/cards/:id/diff'"` |
| `GET /api/cards/:id/history/:seq` | Read one card-history snapshot. | `src/contracts/operator-api-runtime-cards.ts:205 "path: '/api/cards/:id/history/:seq'"` |
| `GET /api/cards/:id/history` | List card-history headers. | `src/contracts/operator-api-runtime-cards.ts:194 "path: '/api/cards/:id/history'"` |
| `GET /api/cards/:id` | Read card detail with children and ancestors. | `src/contracts/operator-api-runtime-cards.ts:182 "path: '/api/cards/:id'"` |
| `GET /api/cards` | List cards. | `src/contracts/operator-api-runtime-cards.ts:172 "path: '/api/cards'"` |
| `GET /api/chats/:sessionId` | Read an analyst chat transcript. | `src/contracts/operator-api-chats.ts:64 "path: '/api/chats/:sessionId'"` |
| `POST /api/chats/:sessionId` | Send an analyst chat message. | `src/contracts/operator-api-chats.ts:75 "path: '/api/chats/:sessionId'"` |
| `GET /api/chats` | List analyst chat sessions. | `src/contracts/operator-api-chats.ts:54 "path: '/api/chats'"` |
| `GET /api/config` | Return redacted loaded configuration and warnings. | `src/contracts/operator-api-config.ts:65 "operationId: 'config.get'"` |
| `GET /api/control-actions` | List control-action audit entries. | `src/contracts/operator-api-config.ts:85 "operationId: 'controlActions.list'"` |
| `GET /api/debug/errors` | Read runtime error records. | `src/contracts/operator-api-files-debug.ts:85 "path: '/api/debug/errors'"` |
| `GET /api/debug/state` | Dump runtime and card-index debug state. | `src/contracts/operator-api-files-debug.ts:75 "path: '/api/debug/state'"` |
| `GET /api/debug/timeline` | Read runtime event timeline records. | `src/contracts/operator-api-files-debug.ts:95 "path: '/api/debug/timeline'"` |
| `GET /api/events` | Query runtime/agent events with filters and pagination. | `src/contracts/operator-api-events.ts:35 "path: '/api/events'"` |
| `GET /api/files/content` | Preview contained text files with safety checks. | `src/contracts/operator-api-files-debug.ts:64 "path: '/api/files/content'"` |
| `GET /api/files` | List contained project files. | `src/contracts/operator-api-files-debug.ts:53 "path: '/api/files'"` |
| `GET /api/mcp/status` | Show MCP server status plus optional serverAvailability. | `src/contracts/operator-api-mcp.ts:77 "path: '/api/mcp/status'"` |
| `GET /api/mcp/tools` | Show MCP tool inventory and invocation stats. | `src/contracts/operator-api-mcp.ts:87 "path: '/api/mcp/tools'"` |
| `GET /api/processes/:id` | Read one safe process view. | `src/contracts/operator-api-processes.ts:64 "path: '/api/processes/:id'"` |
| `GET /api/processes` | List safe process views. | `src/contracts/operator-api-processes.ts:54 "path: '/api/processes'"` |
| `GET /api/providers` | Return provider summaries. | `src/contracts/operator-api-config.ts:75 "operationId: 'providers.list'"` |
| `GET /api/runtime/card-runs` | List runtime card-run records. | `src/contracts/operator-api-runtime-cards.ts:238 "path: '/api/runtime/card-runs'"` |
| `GET /api/runtime/status` | Read compact runtime status plus optional serverAvailability. | `src/contracts/operator-api-runtime-cards.ts:228 "path: '/api/runtime/status'"` |
| `GET /api/state` | Read RuntimeState plus card-index summary and optional availability. | `src/contracts/operator-api-runtime-cards.ts:162 "path: '/api/state'"` |
| `GET /health` | Public liveness probe. | `src/contracts/operator-api-runtime-cards.ts:140 "path: '/health'"` |
| `GET /health/ready` | Public readiness probe with optional availability summary. | `src/contracts/operator-api-runtime-cards.ts:151 "path: '/health/ready'"` |
<!-- saivage:operator-routes:end -->


<!-- saivage:internal-debug-routes:start -->
## Internal diagnostic/debug HTTP route inventory

These routes are mounted by `registerInternalDebugRoutes` for operator diagnostics, but are intentionally outside `operatorApiContracts` and the main operator contract inventory.

| Route | Purpose | Code anchor |
|---|---|---|
| `GET /api/debug/doctor` | Run persisted-card consistency checks. | `src/server/routes/chats-files-debug.ts:26 "fastify.get('/api/debug/doctor'"` |
| `GET /api/debug/supervision` | Read content-supervision review/quarantine summary. | `src/server/routes/chats-files-debug.ts:80 "fastify.get('/api/debug/supervision'"` |
<!-- saivage:internal-debug-routes:end -->

<!-- saivage:runtime-controls:start -->
## Runtime control request/response shapes

Current mounted operator HTTP routes expose runtime state and card-run read models (`GET /api/runtime/status`, `GET /api/runtime/card-runs`) rather than mutating runtime-control POST routes. CLI pause/resume remain local/runtime-backed controls; the unsupported CLI freeze command has been deleted.

| Route | Request body | Success response | Code anchor |
|---|---|---|---|
<!-- saivage:runtime-controls:end -->
