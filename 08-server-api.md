# Server & API

## HTTP Server

The server uses **Fastify** and binds to the configured host and
port (see `06-configuration.md §Server`). It serves:

- REST API endpoints under `/api/*`.
- WebSocket endpoint at `/ws`.
- Static files for the Vue SPA from `web/dist/`.
- Optional VitePress documentation at `/docs/`.

---

## Authentication

All `/api/*` endpoints require authentication:

- **Token source**: `SAIVAGE_API_TOKEN` environment variable.
- **Delivery**: `Authorization: Bearer <token>` header or
  `?token=<token>` query parameter.
- **Public**: `/health` does not require authentication.
- **WebSocket**: Auth is checked on connection upgrade. Invalid
  auth → close with code `1008`.

See `05-security.md` for details.

---

## Endpoints

### Health

```
GET /health
```

Response:

```json
{
  "status": "ok",
  "version": "3.0.0",
  "project": "acme-search",
  "runtime": "idle"
}
```

No authentication required.

### Cards

```
GET    /api/cards              List/filter cards (query params: status, type, parent, tag)
GET    /api/cards/:id          Get full card details (including notes, artifacts, attachments)
POST   /api/cards              Create a card (routed through analyst validation)
PATCH  /api/cards/:id          Update card fields (respects state permissions)
DELETE /api/cards/:id          Delete a card (and its children)
```

Card creation via the API goes through the same validation path as
the analyst — the card structure, required fields, and hierarchy
rules are enforced.

### Runtime

```
GET    /api/state              Runtime state + card index summary
POST   /api/runtime/pause      Pause runtime dispatch
POST   /api/runtime/resume     Resume runtime dispatch
```

### Agents

```
GET    /api/agents/:id/conversation    Get conversation snapshot for an agent session
```

Returns the agent's recent conversation history (subject to context
compaction — only the current window is available).

### Configuration

```
GET    /api/config             Get configuration (secrets redacted)
GET    /api/providers          List configured providers and their status
```

Sensitive fields (`apiKey`, tokens) are replaced with `"***"` in
the response.

### Notes

```
GET    /api/notes              List all unacknowledged notes across cards
POST   /api/notes/:id/acknowledge   Mark a note as handled
DELETE /api/notes/:id          Delete an unhandled note
DELETE /api/notes              Clear all unhandled notes
```

### Chat Sessions

```
GET    /api/chats              List analyst chat sessions
GET    /api/chats/:sessionId   Get messages for a specific session
POST   /api/chats/:sessionId   Send a message to a chat session (as user)
```

### Files

```
GET    /api/files?path=        List directory contents (project-relative path)
GET    /api/files/content?path=   Get file content (project-relative path)
```

Security enforced:
- Path traversal (`..`, absolute paths outside project) → 403.
- Sensitive files (`.saivage/auth-profiles.json`) → 403.
- Files larger than 1 MB → 413.

### Debug

```
GET    /api/debug/state        Full runtime state dump
GET    /api/debug/errors       Recent errors and warnings
GET    /api/debug/timeline     Event timeline (filterable by time range)
```

Debug endpoints expose internal state for troubleshooting. They are
authenticated but not rate-limited (intended for operator use, not
public exposure).

---

## WebSocket

### Connection

```
ws://host:port/ws
```

Auth is checked on upgrade. Invalid or missing auth → close `1008`.

### Message envelope

All messages use a JSON envelope:

```json
{
  "type": "message | activity | thinking | status | error",
  "content": { ... }
}
```

### Event types

| Type       | Direction      | Content                                    |
|------------|----------------|--------------------------------------------|
| `message`  | server → client | Chat message from an agent or system       |
| `activity` | server → client | Agent activity update (tool call, progress) |
| `thinking` | server → client | Agent reasoning trace (if enabled)         |
| `status`   | server → client | Runtime status change                      |
| `error`    | server → client | Error notification                         |
| `message`  | client → server | User chat message to the analyst           |

The web UI subscribes to all types and renders them in the
appropriate panels (chat, activity feed, status bar).

---

## Telegram Channel

The Telegram bot provides an alternative chat interface to the
analyst.

### Message formatting

Markdown from agent responses is converted to Telegram HTML:

| Markdown           | HTML                         |
|--------------------|------------------------------|
| `` `code` ``       | `<code>code</code>`          |
| ` ```block``` `    | `<pre>block</pre>`           |
| `**bold**`         | `<b>bold</b>`                |
| `*italic*`         | `<i>italic</i>`              |
| `~~strike~~`       | `<s>strike</s>`              |
| `[text](url)`      | `<a href="url">text</a>`    |
| `# Header`         | `<b>Header</b>`             |
| `- item`           | `• item`                     |

### Message splitting

Telegram enforces a 4096-character message limit. Long messages are
split at paragraph boundaries. Each chunk is sent as a separate
message with minimal delay between sends.

### Session management

- Each Telegram chat ID maps to a separate analyst session.
- Sessions persist across bot restarts (chat logs are stored on
  disk).
- Only user IDs in `allowedUserIds` can interact. Messages from
  other users are silently dropped.

---

## Static File Serving

The server serves the Vue SPA from `web/dist/`:

- All non-API, non-WebSocket requests that don't match a static
  file are rewritten to `index.html` (SPA routing).
- If VitePress docs are built and available at `docs/.vitepress/dist/`,
  they are served under `/docs/`.
