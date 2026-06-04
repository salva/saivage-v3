# Operations


Use this page for day-to-day Saivage operation. Incident recovery lives in [Incidents](./incidents.md); release validation lives in [Release](./release.md).

## Supported local runtime

Run Saivage with Node.js 24. The root and web `package.json` engines declare `node >=24 <25` and `npm >=10 <12`, matching the CI `actions/setup-node@v4` validation profile. Check `node --version` and `npm --version` before `npm install`, `npm ci`, builds, or runtime startup.

## Startup modes

### API/server only

```bash
SAIVAGE_API_TOKEN=your-token node dist/src/server/server.js
```

This starts Fastify, public docs/SPA serving, auth-protected API routes, `/ws`, MCP startup, and optional Telegram startup. It does **not** create a live runtime dispatch loop.

### Server with runtime creation

```bash
SAIVAGE_API_TOKEN=your-token node dist/src/server/server.js --create-runtime
```

With `--create-runtime`, Saivage initializes the live runtime authority, reads or creates runtime state, runs startup repair/settle behavior, and can dispatch queued work. The CLI start path exposes the same flag:

```bash
SAIVAGE_API_TOKEN=your-token ./bin/saivage.js start --create-runtime
```

Use `--create-runtime` when the operator intends this process to own dispatch. Use server-only mode for read-only inspection/control setups where persisted-state controls are enough.

## LXC/systemd units

The LXC deployments use these unit names:

- `saivage.service` — default Saivage v3 service.
- `saivage-v3-target.service` — per-workspace harness service.

Common checks:

```bash
systemctl status saivage.service
journalctl -u saivage.service -n 100 --no-pager
systemctl status saivage-v3-target.service
journalctl -u saivage-v3-target.service -n 100 --no-pager
```

See [LXC operations](./lxc-operations.md) for deployment-specific restart and log guidance.

## Public and protected surfaces

Public when the server is up:

- `GET /health`
- `/` Web Control Room assets
- `/docs/` built VitePress docs

Protected when `SAIVAGE_API_TOKEN` is configured:

- all `/api/*`
- `/ws`

Accepted REST/API bearer transport:

- `Authorization: Bearer <token>`

URL/query API bearer credentials such as `?token=<token>` are prohibited
and rejected. Do not put API bearer tokens in links, bookmarks, curl
URLs, WebSocket URLs, logs, or incident notes.

Browser WebSocket clients must first request a short-lived, one-use
ticket through authenticated REST and then use that ticket for the
WebSocket upgrade:

```bash
curl -X POST http://localhost:8080/api/auth/ws-ticket \
  -H "Authorization: Bearer <synthetic-api-token>"
# {"ticket":"wst_<opaque-ticket>","expiresAt":"2026-01-01T00:00:30.000Z"}
```

The browser then connects to `/ws?ticket=wst_<opaque-ticket>`. The ticket
is not an API bearer token, expires quickly, and can be used only once.

If no API token is configured, tokenless startup is only allowed on localhost-style bindings.

## Health and state contracts

### Health

```bash
curl http://localhost:8080/health
```

Expected status: `200`.

Expected top-level JSON keys: `status`, `version`, `project`.

`/health` is a liveness-only probe. It does not include runtime readiness, runtime state, or server availability fields. Use `/health/ready` for readiness.

### Readiness

```bash
curl http://localhost:8080/health/ready
```

Expected status: `200` when ready, or `503` when not ready.

Expected top-level JSON keys: `status`.

`status` is `ready` or `not_ready`; ready responses may also include `serverAvailability` component diagnostics.

### Runtime state

```bash
curl -H "Authorization: Bearer $SAIVAGE_API_TOKEN" \
  http://localhost:8080/api/state
```

Expected status: `200`.

Expected top-level JSON keys: `runtime`, `cardIndex`.

`runtime` is the current `RuntimeState` or `null` when no runtime state exists. `cardIndex` includes `total`, `byStatus`, and `byType`. The persisted source of truth is `.saivage/tmp/state/runtime.json` (`src/runtime/state.ts#symbol:runtimeStatePath`). On first read, a supported legacy `.saivage/runtime/state.json` migrates once only when the authoritative file is absent; if both files exist, Saivage refuses startup/control reads with `RuntimeStateLayoutError` rather than risking split-brain state (`src/runtime/state.ts#symbol:assertNoMixedRuntimeStateLayout`, `tests/utils/runtime-state-layout.test.ts:81` and `tests/server/runtime-layout-startup-api.test.ts`).

### Compact runtime status

```bash
curl -H "Authorization: Bearer $SAIVAGE_API_TOKEN" \
  http://localhost:8080/api/runtime/status
```

This returns `runtime`, `paused`, `currentCardId`, and `goalCount` and falls back to persisted state if no live runtime authority is attached.

## Runtime control contracts

Pause/resume validation is shared across CLI commands, web UI controls, analyst tools, and persisted runtime-control utilities. Server-hosted analyst chat/WebSocket controls receive the live `RuntimeApi` when the server was started with `--create-runtime`; direct utility use without a live runtime falls back to canonical persisted-state control and records that only disk state changed.

### Pause

```text
runtime pause control
Authorization: Bearer <synthetic-api-token>
```

Expected status: `200`.

Expected top-level JSON keys: `status`, `project_id`, `started_at`, `paused`, `updated_at`.

Pause stops new dispatch. Running processes are not forcibly killed by pause alone. The response body is the updated `RuntimeState`.

### Resume

```text
runtime resume control
Authorization: Bearer <synthetic-api-token>
```

Expected status: `200`.

Expected top-level JSON keys: `status`, `project_id`, `started_at`, `paused`, `updated_at`.

Resume re-enables dispatch. Depending on open runtime runs and intent, the runtime may settle into `idle` or continue in `running`. The response body is the updated `RuntimeState`.

### Frozen state

Generic resume is intentionally rejected from `frozen` or `error` states. The current operator HTTP route inventory does not expose freeze or dedicated frozen-state recovery controls; freeze manifests are retained as schema/persistence helpers only. Treat a frozen state as an incident: inspect runtime/debug state, repair the underlying condition, and use project-specific recovery rather than generic resume.

## Directives instead of legacy dispatch

Legacy explicit dispatch endpoints are not part of the current operator API. Start or correct work by recording directives:

- Root project kickoff uses explicit runtime start controls (`start_project`/operator runtime controls); directive kickoff routes are removed.
- `goal-scoped correction control` records goal corrections.
- Project-level correction directives are no longer executable runtime triggers; use goal-scoped correction notes and explicit runtime controls.

The runtime consumes eligible directives on scheduler safe ticks and owns subsequent card activation.

## Analyst chat WebSocket

The analyst chat WebSocket endpoint is `/ws`.

Browser clients authenticate by obtaining a short-lived, one-use ticket
from `POST /api/auth/ws-ticket` with the REST bearer header, then
connecting with that ticket:

```bash
WS_TICKET=$(curl -s -X POST http://localhost:8080/api/auth/ws-ticket \
  -H "Authorization: Bearer <synthetic-api-token>" | jq -r .ticket)
websocat "ws://localhost:8080/ws?ticket=${WS_TICKET}"
```

Do not use `/ws?token=<token>` or any other URL/query API bearer
credential; bearer tokens in WebSocket URLs are rejected.

Messages are serialized per connection. The server preserves sanitization and either processes turns in send order or rejects overlap according to the analyst WebSocket contract.

## Evidence, files, and safe process views

`GET /api/cards/:id` returns card detail plus an `evidence` object with generated project files, verification commands, Saivage process artifact paths, tool errors, and optional parse-failure information. Generated-file enrichment is a detail-route behavior, not a list-route behavior.

Project source, config, test, data, and documentation files are not registered or copied as artifacts. They stay in the project workspace and should be represented through `generatedFiles`/executor result metadata plus verification commands. Registered artifacts and attachments are reserved for Saivage process metadata/output under `.saivage-work`, such as validation reports, command logs, and run manifests.

`GET /api/files` lists contained directories and files. `GET /api/files/content?path=...` returns text previews only inside the project boundary and subject to secret blocking/redaction, size limits, and binary rejection.

`GET /api/processes` and `GET /api/processes/:id` expose safe redacted process views instead of raw process-registry records.

## Backup and maintenance

Persistent state lives primarily in `.saivage/`; the authoritative runtime-state file is `.saivage/tmp/state/runtime.json`. Generated and temporary work outputs live in `.saivage-work/`.

Recommended maintenance sequence:

1. Pause the runtime.
2. Confirm `/health`, `/api/state`, runtime intent/run/activation ledgers, `/api/processes`, and current-card state.
3. Back up `.saivage/`.
4. Back up `.saivage-work/` if process logs or generated artifacts are needed.
5. Resume when the maintenance window ends.


## Runtime Console and Planning Tree split

Use the Dashboard Runtime Console for `start_project`, `stop_project`, runtime intent, command/run/activation ledgers, and recovery signals. Use the Planning Tree for card hierarchy, planner state, dependencies, and evidence. Editing planner state or moving cards does not start or stop execution; child work starts only through parent-planner `activate_card`.
