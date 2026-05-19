# Server & API

## HTTP Server

The server uses **Fastify** and binds to the configured host and
port (see `docs/design/configuration.md §Server`). It serves:

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

See `docs/design/security.md` for details.

---

## Mutating control rules

Mutating REST endpoints participate in the same control plane as chat,
CLI, web UI, and runtime helpers.

This means:

- each mutating route declares a safety class;
- authz is evaluated against `(actor, surface='rest', safety_class)`;
- `preview_only` responses return previews plus preview hashes and do
  not mutate until explicitly confirmed;
- `deny` responses do not mutate;
- every mutating call writes one control-action audit entry;
- the route must call the canonical service rather than mutating
  runtime/card/note/process/config state ad hoc.

Read-only routes skip authz/audit and rely on API auth plus redaction.

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
GET    /api/cards              List/filter cards
GET    /api/cards/:id          Get full card details
GET    /api/cards/:id/history  List card history entry headers
GET    /api/cards/:id/history/:seq   Get one full history entry
GET    /api/cards/:id/diff?from=&to= Diff two versions
POST   /api/cards              Create a card
PATCH  /api/cards/:id          Update card fields
DELETE /api/cards/:id          Delete a card
```

Card creation and updates via the API go through the same validation
and canonical mutation path as the analyst.

Tracked card-field updates route through `CardStore.mutateCard` and
produce history entries. Status/timing/result/metrics updates remain
on the untracked path.

### Runtime

```
GET    /api/state                      Runtime state + card index summary
POST   /api/runtime/pause              Pause runtime dispatch
POST   /api/runtime/resume             Resume runtime dispatch
POST   /api/runtime/freeze             Freeze runtime and write freeze manifest
POST   /api/runtime/resume-from-freeze Resume from freeze manifest
```

Pause/resume/freeze routes use canonical runtime-control helpers and
must stay in parity with analyst, CLI, and web UI behavior.

Generic resume from `frozen` is intentionally rejected; the operator
must use `resume-from-freeze`.

### Notifications

```
GET    /api/notifications
POST   /api/notifications/:id/acknowledge
```

These endpoints operate on the **operator-surface** notification queue.
Session-scoped acknowledgement for running agents uses the
`acknowledge_notification` tool instead.

### Control actions audit

```
GET    /api/control-actions?card_id=&since=
```

Returns recent control-action audit entries, optionally filtered.
Use this to inspect preview-only rejections, authz denials, and
mutation provenance across chat/REST/CLI/runtime/web UI.

### Agents

```
GET    /api/agents/:id/conversation    Get conversation snapshot for an agent session
```

Returns the agent's recent conversation history (subject to context
compaction — only the current window is available).

Synthetic operator-update injections may appear in this conversation
history when pending notifications were delivered to the session.

### Configuration

```
GET    /api/config             Get configuration (secrets redacted)
GET    /api/providers          List configured providers and their status
```

Sensitive fields (`apiKey`, tokens) are replaced with redacted values
in the response.

### Notes

```
GET    /api/notes                   List all reconciled unacknowledged notes across cards
POST   /api/notes/:id/acknowledge   Mark a note as handled
DELETE /api/notes/:id               Delete an unhandled note
DELETE /api/notes                   Clear all unhandled notes
```

Directive and escalation notes also trigger notifications. Notes queue
reads are schema-validated and reconciled so ghost `note: undefined`
rows should not be exposed.

### Chat Sessions

```
GET    /api/chats              List analyst chat sessions
GET    /api/chats/:sessionId   Get messages for a specific session
POST   /api/chats/:sessionId   Send a message to a chat session (as user)
```

### Files

```
GET    /api/files?path=           List directory contents (project-relative path)
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
GET    /api/debug/timeline     Event timeline
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
| `card_history_appended` | server → client | A tracked card mutation appended history |
| `notification_added` | server → client | Operator/session notification added |
| `notification_acknowledged` | server → client | Operator notification acknowledged |
| `control_action_recorded` | server → client | Mutating control action audited |

The web UI subscribes to all types and renders them in the
appropriate panels (chat, activity feed, status bar, history and
notification surfaces).

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
- Telegram authz defaults are stricter than web-chat for destructive
  and deployment-class actions.

---

## Static File Serving

The server serves the Vue SPA from `web/dist/`:

- All non-API, non-WebSocket requests that don't match a static
  file are rewritten to `index.html` (SPA routing).
- If VitePress docs are built and available at `docs/.vitepress/dist/`,
  they are served under `/docs/`.
