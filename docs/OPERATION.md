# Saivage v3 — Operations Guide

This guide covers day-to-day operations: starting and stopping the server, managing runtime state, monitoring, backup and recovery, and understanding the file layout.

## Starting and Stopping

### Starting the Server

```bash
SAIVAGE_API_TOKEN=your-token node dist/src/server/server.js
```

The server listens on the configured host and port (from `.saivage/saivage.json`, defaults to `0.0.0.0:8080`).

On startup:
1. The runtime state file (`.saivage/runtime/state.json`) is initialized with `status: "idle"`.
2. The runtime lock (`.saivage-work/tmp/runtime/runtime.lock`) is acquired.
3. Crash recovery runs: any cards stuck in `active` or `running` status are reset to `backlog`.
4. MCP servers with `autostart: true` are launched.
5. If a Telegram bot token is configured, the bot starts polling.

### Stopping the Server

Send `SIGINT` or `SIGTERM` to the process (`Ctrl+C` in the terminal). The server performs a graceful shutdown:

1. Freezes new card dispatch.
2. Kills orphaned running processes.
3. Writes final idle state to `.saivage/runtime/state.json`.
4. Releases the runtime lock.
5. Runs safe cleanup (removes stale temp files, stash items older than 24 hours, stale previews/uploads).

To stop forcefully, send `SIGKILL`. This skips the graceful shutdown — the next startup will run crash recovery to reset any stuck cards.

## Runtime States

The runtime operates in these states, visible via `GET /health` and `GET /api/state`:

| State | Meaning |
|---|---|
| `idle` | No active dispatch. Ready to process goals. |
| `running` | Actively processing a goal (planner/executor/reviewer loop). |
| `paused` | Dispatch is paused. Running processes are NOT killed. |
| `error` | An unrecoverable error occurred. |

Transitions:

- **idle → running**: A goal dispatch begins.
- **running → idle**: Goal completes or all work is done.
- **running → paused**: Operator calls pause (via API or UI).
- **paused → idle**: Operator calls resume; if no work was pending, returns to idle.
- **paused → running**: Operator calls resume; pending work resumes.

## Pause and Resume

Pausing stops new card dispatch but does not kill any running processes. Cards currently executing will finish.

### Pause via API

```bash
curl -X POST http://localhost:8080/api/runtime/pause \
  -H "Authorization: Bearer your-token"
```

### Resume via API

```bash
curl -X POST http://localhost:8080/api/runtime/resume \
  -H "Authorization: Bearer your-token"
```

When to pause:
- Before backing up the project.
- When investigating unexpected behavior.
- Before performing manual card repairs.

## Logs and Debugging

### Logs

Saivage uses [pino](https://getpino.io) for structured JSON logging, output to stdout.

- Set `LOG_LEVEL` to control verbosity: `info` (default), `debug`, `trace`, `warn`, `error`.
- Set `NODE_ENV=development` for pretty-printed logs (uses pino-pretty).
- Runtime process output logs are stored under `.saivage-work/tmp/processes/<procId>/`.

### Debug Endpoints

These endpoints require authentication:

| Endpoint | Description |
|---|---|
| `GET /api/debug/state` | Runtime state + full card index (no secrets) |
| `GET /api/debug/errors` | Recent errors from `.saivage/runtime/errors.jsonl` |
| `GET /api/debug/timeline` | Event timeline from `.saivage/runtime/events.jsonl` |
| `GET /api/mcp/status` | MCP server statuses |

### Monitoring

| Endpoint | Auth Required | Description |
|---|---|---|
| `GET /health` | No | Basic health: status, version, runtime state |
| `GET /api/state` | Yes | Full runtime state + card index counts |

What to watch for:
- `/health` returning non-200 or runtime status showing `error`.
- `/api/state` showing a growing number of cards stuck in `running` or `active` without progress.
- `/api/debug/errors` growing rapidly.

## Backup and Recovery

### What to Back Up

| Directory | Contents | Importance |
|---|---|---|
| `.saivage/` | Cards, config, notes, plan history, runtime state, auth profiles | **Critical** — this is all persistent metadata |
| `.saivage-work/` | Process outputs, artifacts, quarantine, stash, cache | **Optional** — can be regenerated |

Specifically, `.saivage/` contains:
- `saivage.json` — configuration (with secrets — store backups securely!)
- `cards/` — card data files (by-id, index)
- `notes/` — analyst notes
- `plan.json` / `plan-history.json` — planning state
- `runtime/state.json` — runtime state file
- `runtime/errors.jsonl` — error log
- `runtime/events.jsonl` — event timeline
- `agents/sessions/` — agent session metadata
- `agents/messages/` — agent conversation messages
- `supervision/` — content review and quarantine index
- `auth-profiles.json` — OAuth credentials (encrypted/sensitive)
- `stages/` — stage reports and summaries

### Backup Procedure

```bash
# 1. Pause the runtime (optional but recommended)
curl -X POST http://localhost:8080/api/runtime/pause \
  -H "Authorization: Bearer your-token"

# 2. Stop the server (Ctrl+C)

# 3. Copy persistent state
cp -a .saivage .saivage-backup-$(date +%Y%m%d)

# 4. Optionally back up work outputs
cp -a .saivage-work .saivage-work-backup-$(date +%Y%m%d)

# 5. Restart the server
SAIVAGE_API_TOKEN=your-token node dist/src/server/server.js
```

### Recovery Procedure

```bash
# 1. Stop the server if running

# 2. Restore from backup
rm -rf .saivage
cp -a .saivage-backup-20260510 .saivage

# 3. Start the server
SAIVAGE_API_TOKEN=your-token node dist/src/server/server.js

# 4. Verify state
curl http://localhost:8080/health
curl -H "Authorization: Bearer your-token" http://localhost:8080/api/state

# 5. Resume if needed
curl -X POST http://localhost:8080/api/runtime/resume \
  -H "Authorization: Bearer your-token"
```

### Crash Recovery

Crash recovery runs automatically on every server startup. It:

1. Resets all cards with status `active` or `running` to `backlog`.
2. Sweeps stale `.tmp` files from `.saivage-work/tmp/runtime/` (except `runtime.lock`).
3. Cleans stale stash files, previews, and uploads older than 24 hours.

This means: if the server crashes or is killed with `SIGKILL`, simply restart it. Cards will not be duplicated and no state corruption occurs because all state mutations are atomic (write-to-temp-then-rename).

### Manual Lock Cleanup

If a stale runtime lock prevents startup:

```bash
# 1. Verify the process is truly dead
cat .saivage-work/tmp/runtime/runtime.lock
# → {"pid":12345,"started_at":"..."}

ps aux | grep 12345
# If PID is dead, remove:

# 2. Remove the lock
rm .saivage-work/tmp/runtime/runtime.lock

# 3. Start normally
```

The lock has a 14-day maximum age — locks older than this are treated as stale even if the PID appears alive.

## File Layout Summary

```
saivage-v3/
├── .saivage/                    # Persistent metadata (CRITICAL for backup)
│   ├── saivage.json             # Configuration
│   ├── auth-profiles.json       # OAuth credentials (blocked from API reads)
│   ├── plan.json                # Active plan
│   ├── plan-history.json        # Completed plan stages
│   ├── cards/                   # Card store
│   │   ├── by-id/               # Individual card JSON files
│   │   └── index.json           # Card index
│   ├── notes/                   # Analyst notes per card
│   ├── runtime/                 # Runtime state
│   │   ├── state.json           # Current runtime state
│   │   ├── errors.jsonl         # Error log
│   │   └── events.jsonl         # Event timeline
│   ├── agents/                  # Agent data
│   │   ├── sessions/            # Session metadata (JSON)
│   │   └── messages/            # Conversation messages (JSONL)
│   ├── supervision/             # Content supervisor
│   │   ├── reviews.jsonl        # ContentReview records
│   │   └── quarantine-index.json
│   ├── stages/                  # Stage reports
│   └── tmp/                     # Temporary state
│
├── .saivage-work/               # Generated outputs (can be regenerated)
│   └── tmp/
│       ├── runtime/             # Runtime lock + temp files
│       │   └── runtime.lock
│       ├── processes/           # Process output logs
│       ├── stash/               # Agent stash files
│       ├── previews/            # Generated previews
│       └── quarantine/          # Quarantined content
│
├── src/                         # TypeScript source
├── dist/                        # Compiled JavaScript (from npx tsc)
├── web/                         # Vue SPA (Web Control Room)
│   ├── src/
│   └── dist/                    # Built SPA (served by Fastify static)
├── tests/                       # Test suite
├── docs/                        # Documentation
└── package.json
```

## API Authentication

All `/api/*` routes require authentication when `SAIVAGE_API_TOKEN` is set. If the env var is not set, the server runs in open mode.

Accepted authentication methods:
- `Authorization: Bearer <token>` header
- `?token=<token>` query parameter

The `/health` endpoint is always public (no auth required).

### Verifying Auth

```bash
# With token
curl -H "Authorization: Bearer your-token" http://localhost:8080/api/state

# With query parameter
curl http://localhost:8080/api/state?token=your-token
```
