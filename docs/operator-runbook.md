# Saivage v3 — Operator Runbook

This runbook is the current operator workflow guide for the Web Control Room and runtime recovery.

## 1. Open the system safely

### Public surfaces

These remain available without API auth:

- `/health`
- `/`
- `/docs/`

### Protected surfaces

When `SAIVAGE_API_TOKEN` is configured, `/api/*` and `/ws` require the token.

In the Web Control Room:

- use the token control when API requests are unauthorized;
- the Docs link remains usable even if API auth is missing.

## 2. Read health before changing state

Quick checks:

```bash
curl http://localhost:8080/health
curl -H "Authorization: Bearer $SAIVAGE_API_TOKEN" http://localhost:8080/api/runtime/status
```

Interpret runtime states conservatively:

- `unknown` — runtime state is missing or unreadable
- `idle` — no active dispatch is running
- `running` — active dispatch or goal work is in progress
- `paused` — new dispatch is paused
- `frozen` — operator freeze/handoff state is recorded
- `error` — degraded or failed runtime state needs attention

## 3. Use the Web Control Room by workflow

### Dashboard

Use Dashboard as the operating picture.

Look for:

- runtime summary and current state
- queue and activity context where shown
- analyst chat state
- degraded or unauthorized banners

Expected UI states include:

- connected/live
- reconnecting
- unauthorized
- no-token
- stale
- degraded

These states are intentional signals. They are not success states.

### Cards and card detail

Use Cards to:

- browse by status or type;
- open card detail;
- inspect parent/child context where shown;
- identify blocked, failed, or stale work.

Use **card detail** for evidence review. This is the supported surface for:

- generated file metadata
- verification commands
- tool errors
- parse-failure context

Do not use an empty queue alone as evidence that planning is complete.

### Generated files and evidence

When reviewing generated files in card detail, expect one of these outcomes:

- previewable text file
- redacted-only preview
- blocked preview
- missing file
- binary or unpreviewable file

Examples:

- `.saivage/auth-profiles.json` is blocked
- `.saivage/saivage.json` is redacted-only

### Agents

Use Agents to inspect planner, executor, reviewer, and analyst sessions.

Operators should be able to:

- find running or failed sessions
- open a conversation
- inspect linked cards, files, and process context
- distinguish model/tool failure from successful completion

Conversation links may route to:

- card detail
- Files view
- Debug process context

### Files

Use Files for contained project browsing and safe text preview.

Operators should expect explicit states for:

- unauthorized API access
- blocked preview
- not found
- binary/unpreviewable content
- redacted content

Prefer Files or card-detail evidence links over raw filesystem inspection during routine operations.

### Debug

Use Debug for recovery and diagnostics:

- runtime state
- recent errors
- event timeline
- doctor checks
- supervision and quarantine information
- MCP status/tools
- processes

If the UI reports degraded, frozen, stale, or repeated agent failures, Debug is the first operator destination.

### Docs

Docs are public and separately served under `/docs/` when built. They remain available even if the API token is missing or invalid.

## 4. Runtime control procedures

Pause/resume semantics are shared across REST endpoints and analyst chat tools. Choose the surface that fits your workflow, but expect the same validation results.

### Pause before low-risk maintenance

```bash
curl -X POST http://localhost:8080/api/runtime/pause \
  -H "Authorization: Bearer $SAIVAGE_API_TOKEN"
```

Use pause when you want to stop new dispatch without creating a freeze handoff.

- With a live `ActiveRuntime`, pause updates the live in-memory runtime authority.
- Without a live runtime authority, pause updates persisted runtime state only.
- If runtime state is missing entirely, pause now fails with an actionable error instead of inventing replacement state.

### Resume only from pause or idle

```bash
curl -X POST http://localhost:8080/api/runtime/resume \
  -H "Authorization: Bearer $SAIVAGE_API_TOKEN"
```

Generic resume is for paused or idle runtime state.

- With a live `ActiveRuntime`, resume propagates through the live runtime authority.
- Without a live runtime authority, resume updates persisted runtime state only.
- If the runtime is `frozen`, this endpoint rejects the request with `400` and instructs you to use `/api/runtime/resume-from-freeze`.
- If runtime state is unavailable, resume returns an actionable unavailable-state error.

### Freeze before handoff or disruptive maintenance

```bash
curl -X POST http://localhost:8080/api/runtime/freeze \
  -H "Authorization: Bearer $SAIVAGE_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"reason":"operator handoff"}'
```

Use freeze when you want a recorded handoff manifest and a clear `frozen` state.

### Resume from freeze

```bash
curl -X POST http://localhost:8080/api/runtime/resume-from-freeze \
  -H "Authorization: Bearer $SAIVAGE_API_TOKEN"
```

Resume from freeze restores queue and process references from the freeze manifest when present.

## 5. Operator notes queue

Unhandled notes are stored per card and indexed in `.saivage/notes/queue.json`.

Current backend behavior:

- queue reads/writes are schema-validated;
- `GET /api/notes` returns only reconciled unhandled notes with an attached `note` record;
- stale queue entries that point at missing or handled notes are removed during reconciliation;
- malformed persisted queue files return a controlled `500` instead of returning partial `note: undefined` rows.

Use note actions with this meaning:

- acknowledge: preserves the note in card history and removes it from the unhandled queue;
- delete: removes an unhandled note from both card history and queue;
- clear unhandled: deletes only currently unhandled queued notes.

## 6. Degraded-state workflow

If runtime or UI state is degraded:

1. Check `/health`.
2. Check `/api/runtime/status`.
3. Open Debug and inspect errors, timeline, doctor, supervision, and processes.
4. Open affected card detail or agent conversation for evidence.
5. Pause or freeze before manual intervention if state is still mutating.
6. Only then consider direct filesystem inspection.

## 7. Unauthorized, stale, and offline workflow

### Unauthorized

- verify `SAIVAGE_API_TOKEN` on the server;
- re-enter the token in the UI;
- confirm `/health` still works publicly;
- confirm Docs remain reachable under `/docs/`.

### Stale or reconnecting

- refresh the relevant view;
- treat REST reload as authoritative after reconnect;
- use Debug if stale or reconnecting state persists.

### Offline

- verify the server process and port binding;
- verify docs and SPA serving separately from API runtime state;
- use process inspection and logs if the server is up but runtime is not advancing.

## 8. Safe process inspection

Inspect processes through Debug or process APIs rather than raw registry files.

Expect process views to show:

- redacted commands
- contained relative cwd/log refs
- whether logs are viewable
- whether a running process is terminable

Do not treat the process API as a general shell interface.

## 9. Local verification commands

```bash
npm run docs:verify
npm run web:typecheck
npm run web:test:sweep
npm run typecheck
```

Focused web checks:

```bash
npm run web:test:dashboardview
npm run web:test:cardsview
npm run web:test:agentsview
npm run web:test:filesview
npm run web:test:debugview
```

## 10. When manual filesystem access is justified

Manual `.saivage/` or `.saivage-work/` inspection is a fallback, not the normal workflow.

Use it only when:

- the server is unavailable,
- the Debug/API surfaces are degraded or insufficient,
- you are performing controlled repair after pausing or freezing,
- you need direct backup or forensic capture.
