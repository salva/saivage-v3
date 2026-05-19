# Operations

Use this page for day-to-day Saivage operation. Incident recovery lives in [Incidents](./incidents.md); release validation lives in [Release](./release.md).

## Startup modes

### API/server only

```bash
SAIVAGE_API_TOKEN=your-token node dist/src/server/server.js
```

This starts Fastify, public docs/SPA serving, auth-protected API routes, `/ws`, MCP startup, and optional Telegram startup. It does **not** create an `ActiveRuntime` dispatch loop.

### Server with runtime creation

```bash
SAIVAGE_API_TOKEN=your-token node dist/src/server/server.js --create-runtime
```

With `--create-runtime`, Saivage initializes `ActiveRuntime`, reads or creates runtime state, runs startup repair/settle behavior, and can dispatch queued work. The CLI start path exposes the same flag:

```bash
SAIVAGE_API_TOKEN=your-token ./bin/saivage.js start --create-runtime
```

Use `--create-runtime` when the operator intends this process to own dispatch. Use server-only mode for read-only inspection/control setups where persisted-state controls are enough.

## LXC/systemd units

The LXC deployments use these unit names:

- `saivage.service` — default Saivage v3 service.
- `saivage-v3-target.service` — target workspace service.

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

Accepted auth methods:

- `Authorization: Bearer <token>`
- `?token=<token>`

If no API token is configured, tokenless startup is only allowed on localhost-style bindings.

## Health and state contracts

### Health

```bash
curl http://localhost:8080/health
```

Expected status: `200`.

Expected top-level JSON keys: `status`, `version`, `project`, `runtime`.

`runtime` is `unknown`, `idle`, `running`, `paused`, `error`, or `frozen`. When the runtime is frozen and a freeze manifest is present, the response can also include `frozen_reason`.

### Runtime state

```bash
curl -H "Authorization: Bearer $SAIVAGE_API_TOKEN" \
  http://localhost:8080/api/state
```

Expected status: `200`.

Expected top-level JSON keys: `runtime`, `cardIndex`.

`runtime` is the current `RuntimeState` or `null` when no runtime state exists. `cardIndex` includes `total`, `byStatus`, and `byType`.

### Compact runtime status

```bash
curl -H "Authorization: Bearer $SAIVAGE_API_TOKEN" \
  http://localhost:8080/api/runtime/status
```

This returns `runtime`, `paused`, `currentCardId`, and `goalCount` and falls back to persisted state if no live `ActiveRuntime` is attached.

## Runtime control contracts

Pause/resume validation is shared across REST endpoints, CLI commands, web UI controls, and analyst tools. Server-hosted analyst chat/WebSocket controls receive the live `ActiveRuntime` when the server was started with `--create-runtime`; direct utility use without a live runtime falls back to canonical persisted-state control and records that only disk state changed.

### Pause

```bash
curl -X POST http://localhost:8080/api/runtime/pause \
  -H "Authorization: Bearer $SAIVAGE_API_TOKEN"
```

Expected status: `200`.

Expected top-level JSON keys: `status`, `project_id`, `pid`, `started_at`, `paused`, `queue`, `running_processes`, `updated_at`.

Pause stops new dispatch. Running processes are not forcibly killed by pause alone. The response body is the updated `RuntimeState`.

### Resume

```bash
curl -X POST http://localhost:8080/api/runtime/resume \
  -H "Authorization: Bearer $SAIVAGE_API_TOKEN"
```

Expected status: `200`.

Expected top-level JSON keys: `status`, `project_id`, `pid`, `started_at`, `paused`, `queue`, `running_processes`, `updated_at`.

Resume re-enables dispatch. Depending on queued work, the runtime may settle into `idle` or continue in `running`. The response body is the updated `RuntimeState`.

### Freeze

```bash
curl -X POST http://localhost:8080/api/runtime/freeze \
  -H "Authorization: Bearer $SAIVAGE_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"reason":"operator handoff before maintenance"}'
```

Expected status: `200`.

Expected top-level JSON keys: `status`, `freeze_id`, `reason`, `created_at`.

Freeze is an intentional operator handoff. Saivage records a freeze manifest and moves runtime state to `frozen` with pause semantics.

### Resume from freeze

```bash
curl -X POST http://localhost:8080/api/runtime/resume-from-freeze \
  -H "Authorization: Bearer $SAIVAGE_API_TOKEN"
```

Expected status: `200`.

Expected top-level JSON keys: `status`, `freeze_id`, `restored_queue`, `restored_processes`, `restored_card_id`.

If a freeze manifest exists, Saivage restores queued work, clears the manifest, and returns the restored queue and current-card reference. Do not use generic resume from `frozen` or `error` states.

## Directives instead of legacy dispatch

Legacy explicit dispatch endpoints are not part of the current operator API. Start or correct work by recording directives:

- `POST /api/runtime/lets_dance` records a project kickoff directive.
- `POST /api/runtime/goals/:id/needs_corrections` records goal corrections.
- `POST /api/runtime/project/needs_corrections` records project-level corrections.

The runtime consumes eligible directives on scheduler safe ticks and owns subsequent card activation.

## Analyst chat WebSocket

The analyst chat WebSocket endpoint is `/ws`.

Auth is the same as protected API routes:

- `ws://localhost:8080/ws?token=<token>`
- or an `Authorization: Bearer <token>` header from clients that can set WebSocket headers.

Example with query-token auth:

```bash
websocat "ws://localhost:8080/ws?token=$SAIVAGE_API_TOKEN"
```

Messages are serialized per connection. The server preserves sanitization and either processes turns in send order or rejects overlap according to the analyst WebSocket contract.

## Evidence, files, and safe process views

`GET /api/cards/:id` returns card detail plus an `evidence` object with generated files, verification commands, artifact paths, tool errors, and optional parse-failure information. Generated-file enrichment is a detail-route behavior, not a list-route behavior.

`GET /api/files` lists contained directories and files. `GET /api/files/content?path=...` returns text previews only inside the project boundary and subject to secret blocking/redaction, size limits, and binary rejection.

`GET /api/processes` and `GET /api/processes/:id` expose safe redacted process views instead of raw process-registry records.

## Backup and maintenance

Persistent state lives primarily in `.saivage/`. Generated and temporary work outputs live in `.saivage-work/`.

Recommended maintenance sequence:

1. Pause or freeze the runtime.
2. Confirm `/health`, `/api/state`, and the queue/current-card state.
3. Back up `.saivage/`.
4. Back up `.saivage-work/` if process logs or generated artifacts are needed.
5. Resume or `resume-from-freeze` when the maintenance window ends.
