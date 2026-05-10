# Saivage v3 — Operator Runbook

A concise runbook for operators managing a Saivage v3 instance in production.

## Daily Operations

### Check Runtime Health

```bash
curl http://localhost:8080/health
```

Expected: HTTP 200 with `status: "ok"` and `runtime` reporting `idle`, `running`, or `paused`. Investigate if `runtime` is `"error"` or `"unknown"`.

### Check Running State

```bash
curl -H "Authorization: Bearer $SAIVAGE_API_TOKEN" http://localhost:8080/api/state
```

Review:
- `runtime.status` — should not be stuck in `running` for extended periods without progress.
- `cardIndex.total` — growing without corresponding `done` cards may indicate a loop.
- `cardIndex.byStatus` — large numbers in `active`/`running` without progress suggest a problem.

### Review Recent Errors

```bash
curl -H "Authorization: Bearer $SAIVAGE_API_TOKEN" http://localhost:8080/api/debug/errors
```

Look for:
- Repeated API failures to model providers.
- MCP server crashes.
- Card store integrity errors.

### Review Event Timeline

```bash
curl -H "Authorization: Bearer $SAIVAGE_API_TOKEN" http://localhost:8080/api/debug/timeline
```

Shows recent runtime events: goal starts, card transitions, agent invocations, errors.

## Incident Response

### 1. Server Not Responding

**Checklist:**

```bash
# Is the process running?
ps aux | grep saivage

# Is the port open?
lsof -i :8080
# or
ss -tlnp | grep 8080

# Check the lock file
cat .saivage-work/tmp/runtime/runtime.lock

# Check recent logs (if logging to file)
journalctl -u saivage --since "5 minutes ago"
```

**If process is dead:**
1. Check for stale lock: if PID in lock file doesn't match any running process, remove the lock.
2. Restart: `SAIVAGE_API_TOKEN=... node dist/src/server/server.js`.
3. Crash recovery resets stuck cards automatically.

**If process is alive but not responding:**
1. Check system resource usage (CPU, memory).
2. Check for infinite loops or runaway processes.
3. Send `SIGTERM` for graceful shutdown, wait 30 seconds, then `SIGKILL` if needed.
4. Restart.

### 2. Runtime Stuck or Paused Unexpectedly

**Check state:**

```bash
curl -H "Authorization: Bearer $SAIVAGE_API_TOKEN" http://localhost:8080/api/debug/state
```

**If paused:**
```bash
curl -X POST http://localhost:8080/api/runtime/resume \
  -H "Authorization: Bearer $SAIVAGE_API_TOKEN"
```

**If running but stuck:**
1. Check `.saivage/runtime/state.json` for `current_card_id`.
2. Check the card's status and result:
   ```bash
   curl -H "Authorization: Bearer $SAIVAGE_API_TOKEN" \
     http://localhost:8080/api/cards/<card-id>
   ```
3. If the card has `error` set, fix the underlying issue and reset the card to `backlog`:
   ```bash
   curl -X PATCH http://localhost:8080/api/cards/<card-id> \
     -H "Authorization: Bearer $SAIVAGE_API_TOKEN" \
     -H "Content-Type: application/json" \
     -d '{"status":"backlog"}'
   ```

**If stale lock prevents restart:**
```bash
# Verify PID is dead
cat .saivage-work/tmp/runtime/runtime.lock
# → {"pid":12345,"started_at":"..."}
ps aux | grep 12345

# If PID is dead, remove lock
rm .saivage-work/tmp/runtime/runtime.lock
```

### 3. Card Corruption or Inconsistency

**Check integrity:**

```bash
# List all cards
curl -H "Authorization: Bearer $SAIVAGE_API_TOKEN" http://localhost:8080/api/cards

# Check a specific card
curl -H "Authorization: Bearer $SAIVAGE_API_TOKEN" \
  http://localhost:8080/api/cards/<card-id>
```

**Manual repair:**

Card files are stored under `.saivage/cards/by-id/<card-id>.json`. The index is at `.saivage/cards/index.json`. To fix a card:

1. Stop the server.
2. Edit the card's JSON file directly:
   ```bash
   nano .saivage/cards/by-id/<card-id>.json
   ```
3. Fix the `status` field or other corrupted data.
4. Restart the server.

**After repair:**
```bash
curl -H "Authorization: Bearer $SAIVAGE_API_TOKEN" http://localhost:8080/api/state
```

### 4. Security Incident (Suspected Injection)

**Immediate steps:**

1. **Check quarantine:**
   ```bash
   ls .saivage-work/quarantine/
   ```
   Each subdirectory is a quarantined content item. Check `meta.json` for the reason and source.

2. **Review supervision logs:**
   ```bash
   cat .saivage/supervision/reviews.jsonl | tail -20
   ```

3. **Review quarantine index:**
   ```bash
   cat .saivage/supervision/quarantine-index.json
   ```

4. **Disable external content sources if needed:**
   - Set MCP servers to `"disabled": true` in `.saivage/saivage.json`.
   - Restart the server.

5. **Review agent conversations for signs of compromise:**
   ```bash
   ls .saivage/agents/sessions/
   ls .saivage/agents/messages/
   ```

### 5. Model Provider Outage

**Symptom:** Cards stuck, error logs showing API failures to a provider.

**Response:**
1. Check `/api/debug/errors` for the specific error.
2. If a provider is down, configure an alternative provider in `.saivage/saivage.json`:
   - Add a new provider entry or account.
   - Update `failover` chains to route around the down provider.
3. Restart the server.
4. Reset stuck cards to `backlog`.

## Backup Procedure

```bash
# 1. Pause if you want a consistent snapshot
curl -X POST http://localhost:8080/api/runtime/pause \
  -H "Authorization: Bearer $SAIVAGE_API_TOKEN"

# 2. Copy persistent state
cp -a .saivage .saivage-backup-$(date +%Y%m%d)

# 3. Optionally copy work outputs
cp -a .saivage-work .saivage-work-backup-$(date +%Y%m%d)

# 4. Resume
curl -X POST http://localhost:8080/api/runtime/resume \
  -H "Authorization: Bearer $SAIVAGE_API_TOKEN"
```

> **Note:** `.saivage/saivage.json` may contain plaintext API keys. Store backups securely!

## Recovery from Backup

```bash
# 1. Stop the server (Ctrl+C or kill)

# 2. Restore
rm -rf .saivage
cp -a .saivage-backup-20260510 .saivage

# 3. Start server
SAIVAGE_API_TOKEN=your-token node dist/src/server/server.js &

# 4. Verify
curl http://localhost:8080/health
curl -H "Authorization: Bearer $SAIVAGE_API_TOKEN" http://localhost:8080/api/state

# 5. Resume if needed
curl -X POST http://localhost:8080/api/runtime/resume \
  -H "Authorization: Bearer $SAIVAGE_API_TOKEN"
```

## Quick Reference: Key Endpoints

| Endpoint | Method | Auth | Purpose |
|---|---|---|---|
| `/health` | GET | No | Health check |
| `/api/state` | GET | Yes | Runtime state + card index |
| `/api/cards` | GET/POST | Yes | List/create cards |
| `/api/cards/:id` | GET/PATCH/DELETE | Yes | Read/update/delete a card |
| `/api/config` | GET | Yes | Config (secrets redacted) |
| `/api/providers` | GET | Yes | Provider status summary |
| `/api/runtime/pause` | POST | Yes | Pause dispatch |
| `/api/runtime/resume` | POST | Yes | Resume dispatch |
| `/api/debug/state` | GET | Yes | Full debug state dump |
| `/api/debug/errors` | GET | Yes | Recent error log |
| `/api/debug/timeline` | GET | Yes | Event timeline |
| `/api/chats` | GET | Yes | List chat sessions |
| `/api/chats/:id` | GET/POST | Yes | Read/post chat messages |
| `/api/files` | GET | Yes | List directory |
| `/api/files/content` | GET | Yes | Read file (blocked/redacted) |
| `/api/notes` | GET/DELETE | Yes | List/clear notes |
| `/api/mcp/status` | GET | Yes | MCP server statuses |
| `/api/agents/:id/conversation` | GET | Yes | Agent session + messages |

## Environment Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `SAIVAGE_API_TOKEN` | For production | (none) | API auth token. If unset, no auth required. |
| `LOG_LEVEL` | No | `info` | Pino log level: `trace`, `debug`, `info`, `warn`, `error` |
| `NODE_ENV` | No | — | Set to `development` for pretty-printed logs |
