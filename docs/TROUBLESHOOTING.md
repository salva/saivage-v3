# Saivage v3 — Troubleshooting Guide

Common issues and their solutions.

## Server Won't Start

### Port Conflict

**Symptom:** `EADDRINUSE` error on startup.

**Solution:**
```bash
# Check what's using the port
lsof -i :8080

# Change the port in .saivage/saivage.json
# {
#   "server": { "port": 3000 }
# }
```

### Missing Config File

**Symptom:** `Configuration not found at /path/.saivage/saivage.json`

**Solution:** Create `.saivage/saivage.json` with at minimum a `server` section:
```json
{
  "server": { "host": "0.0.0.0", "port": 8080 }
}
```

### Invalid Config JSON

**Symptom:** `Failed to parse saivage.json: ...`

**Solution:** Validate the JSON with `node -e "JSON.parse(require('fs').readFileSync('.saivage/saivage.json','utf-8'))"` or `cat .saivage/saivage.json | python3 -m json.tool`.

### Config Validation Failure

**Symptom:** `Configuration validation failed: ...`

**Solution:** The error message includes the path and issue (e.g., `server.port: Expected number, received string`). Fix the field in `.saivage/saivage.json`.

### Stale Runtime Lock

**Symptom:** `Runtime lock is held by PID 12345 (started ...). Cannot acquire lock.`

**Solution:** If PID 12345 is no longer running (verify with `ps aux | grep 12345`), remove the lock:
```bash
rm .saivage-work/tmp/runtime/runtime.lock
```
Then restart. Locks older than 14 days are automatically treated as stale.

### Missing API Token

**Symptom:** Server starts but all `/api/*` requests return `401 Unauthorized`.

**Solution:** Either:
1. Set `SAIVAGE_API_TOKEN` when starting the server, or
2. If you intentionally want open access, leave `SAIVAGE_API_TOKEN` unset (the server runs with no auth).

---

## API Returns 401

**Symptom:** `{"error":"Unauthorized","statusCode":401}`

**Solution:**
1. Verify `SAIVAGE_API_TOKEN` is set in the server's environment.
2. Verify you're sending the correct token in the `Authorization: Bearer <token>` header.
3. If using query parameter, ensure `?token=<value>` matches exactly.
4. The `/health` endpoint does not require auth — test it first to confirm the server is running.

---

## Health Endpoint Shows Unexpected Runtime Status

**Symptom:** `/health` returns `runtime: "idle"` but you expect `running`.

**Solution:** The health endpoint reads from `.saivage/runtime/state.json`. Check the file directly:
```bash
cat .saivage/runtime/state.json
```
If the file is stale or doesn't exist, the `/health` endpoint returns `"unknown"`. This is expected behavior — the health endpoint reports truthfully what's on disk, not a guess.

---

## Card Operations Fail

**Symptom:** `POST /api/cards` returns `400` with a validation message.

**Solution:** Check the card fields:
- `type` must be a valid card type (`architecture`, `code`, `test`, `doc`, `data`, `research`, `ops`, `plan`, `project`).
- `parent` must be an existing card ID if provided.
- Plan cards (`type: "plan"`) cannot be created without a parent.

### Card Not Found

**Symptom:** `{"error":"Card not found","cardId":"..."}`

**Solution:** List all cards to verify the ID:
```bash
curl -H "Authorization: Bearer token" http://localhost:8080/api/cards
```

### Card Store Integrity

If card operations fail unexpectedly, check the card store files:
```bash
ls .saivage/cards/by-id/
cat .saivage/cards/index.json
```
Verify that every card referenced in the index has a corresponding file under `by-id/`.

---

## Agent Produces No Output

**Symptom:** Cards stuck in `running` or `active` status, no agent output.

**Solutions:**
1. **Check model configuration**: Verify the model names in `models` match what's in `providers`. Model strings should be provider-specific.
2. **Check provider API keys**: If using `${ENV_VAR}` references, verify the environment variable is set in the server's environment.
3. **Check network**: The server needs outbound HTTPS access to LLM provider APIs.
4. **Check logs**: Look for API error responses in the server's stdout logs.
5. **Check debug state**: `GET /api/debug/state` shows current card statuses and execution state.

---

## MCP Servers Fail to Start

**Symptom:** `MCP manager initialization failed (continuing without MCP): ...`

**Solutions:**
1. **Check command path**: The `command` field in `mcpServers.<name>` must be an executable on the server's PATH or an absolute path.
2. **Check transport type**: Must be `"stdio"` or `"sse"`.
3. **Check environment**: Use the `env` field to pass needed environment variables.
4. **Check MCP status**: `GET /api/mcp/status` shows which servers are running and their statuses.
5. **Disable problematic servers**: Set `"disabled": true` on a server to prevent startup.

---

## Telegram Bot Doesn't Respond

**Symptom:** Bot starts but doesn't respond to messages.

**Solutions:**
1. **Check bot token**: Verify the `botToken` is correct and not expired.
2. **Check allowed user IDs**: If `allowedUserIds` is set, only those users can interact with the bot. Add your user ID to the list.
3. **Check network**: The bot uses long polling — outbound HTTPS to `api.telegram.org` is required.
4. **Check logs**: Look for Telegram API errors in the server stdout.

---

## WebSocket Disconnects

**Symptom:** WebSocket connection drops frequently.

**Solutions:**
1. **Check auth**: WebSocket connections require authentication (same token as API). Include `?token=<value>` in the WebSocket URL.
2. **Check network stability**: WebSocket connections expect a stable connection. Proxy servers with short idle timeouts may drop them.
3. **Check server logs**: Look for WebSocket-related errors.

---

## Large Files Can't Be Read via API

**Symptom:** `GET /api/files/content?path=largefile.log` returns `413`.

**Solution:** The file content API has a 1 MB limit (`MAX_FILE_SIZE_BYTES = 1_048_576`). For larger files, read them directly from the filesystem:
```bash
cat .saivage-work/tmp/processes/<procId>/output.txt
```

---

## Config Changes Don't Take Effect

**Symptom:** Updated `.saivage/saivage.json` but changes aren't reflected.

**Solution:** Most configuration is loaded at server startup and cached in memory. Restart the server for changes to take effect:
```bash
# Stop (Ctrl+C), then start again
SAIVAGE_API_TOKEN=your-token node dist/src/server/server.js
```

Exception: The `/api/runtime/pause` and `/api/runtime/resume` endpoints change runtime state at runtime — these don't require restart.

---

## Runtime Stuck After Crash

**Symptom:** Server won't start after a crash, lock-related error.

**Solution:**
```bash
# 1. Verify the process is truly dead
ps aux | grep saivage

# 2. If dead, remove the stale lock
rm .saivage-work/tmp/runtime/runtime.lock

# 3. Restart (crash recovery will run automatically)
SAIVAGE_API_TOKEN=your-token node dist/src/server/server.js
```

---

## Where to Find Logs

| Log Type | Location |
|---|---|
| Server logs | stdout (pino JSON or pretty-printed) |
| Process output | `.saivage-work/tmp/processes/<procId>/` |
| Error log | `.saivage/runtime/errors.jsonl` |
| Event timeline | `.saivage/runtime/events.jsonl` |
| Content reviews | `.saivage/supervision/reviews.jsonl` |

### Increasing Log Verbosity

```bash
LOG_LEVEL=debug SAIVAGE_API_TOKEN=test node dist/src/server/server.js
```

For trace-level (very verbose):
```bash
LOG_LEVEL=trace NODE_ENV=development SAIVAGE_API_TOKEN=test node dist/src/server/server.js
```

---

## File Access Security Issues

### auth-profiles.json Blocked

**Symptom:** `GET /api/files/content?path=.saivage/auth-profiles.json` returns `403`.

**Solution:** This is by design. `auth-profiles.json` contains OAuth credentials and is blocked from all API read access. Access it directly on the filesystem if needed (with appropriate filesystem permissions).

### saivage.json Secrets Redacted

**Symptom:** `GET /api/config` shows `"[REDACTED]"` for API key values.

**Solution:** This is by design. The config API redacts literal secret values. Use environment variable references (`${ENV_VAR}`) for secrets so they are never in the config file as plaintext. The API serves redacted config to prevent secret leakage.
