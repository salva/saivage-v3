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

Use **card detail** as the supported operator inspection surface for:

- lifecycle explanation and completion/blocker state
- parent/child hierarchy and evidence-card navigation
- generated file metadata and preview eligibility
- verification commands and process IDs
- review result summary and evidence-card IDs
- planner status and dispatch completion summaries
- tool errors and parse-failure recovery

Do not use an empty queue alone as evidence that planning is complete.

### Card detail evidence and review workflow

Read card detail in this order:

1. **Lifecycle / Completion & blockers** — confirms whether the card is only marked done, actively blocked, failed, or independently reviewed.
2. **Hierarchy** — shows ancestors and children so operators can inspect related work without raw state-file reads.
3. **Evidence & generated files** — shows aggregate evidence state:
   - `No operator-facing evidence is recorded yet`
   - `This terminal or blocked card has no operator-facing evidence recorded`
   - missing files
   - blocked files with reasons
   - redacted evidence
   - parse-recovered / tool-error partial evidence
4. **Verification commands** — confirms pass/fail/unknown/timed-out command results.
5. **Review result** — confirms whether a reviewer passed or failed the card and which evidence-card IDs were cited.
6. **Dispatch summary** — confirms child dispatch outcomes where recorded.

If the detail view shows **This card detail may be stale**, refresh the card before acting on evidence or completion state.

### Generated files and evidence

When reviewing generated files in card detail, expect one of these outcomes:

- previewable text file
- redacted-only preview
- blocked preview with a reason
- missing file
- binary or unpreviewable file
- incomplete/no-evidence warning for a blocked/done/failed card

Examples:

- `.saivage/auth-profiles.json` is blocked
- `.saivage/saivage.json` is redacted-only
- symlinks that resolve outside the project root are blocked or omitted from safe operator flows

Card evidence and file APIs expose canonical project-relative paths only. Operators should not expect absolute workspace paths in successful file or generated-artifact responses.

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

A redacted preview is a successful preview with sensitive values removed by the server; it is not an error state.

Prefer Files or card-detail evidence links over raw filesystem inspection during routine operations.

### Debug

Use Debug for recovery and diagnostics:

- runtime state
- Operator Control panel for runtime pause/resume and notes queue actions
- recent errors
- event timeline
- doctor checks
- supervision and quarantine information
- MCP status/tools
- processes

If the UI reports degraded, frozen, stale, or repeated agent failures, Debug is the first operator destination.

## 4. Runtime control procedures

Pause/resume validation is shared across REST endpoints and analyst tools. Server-hosted analyst chat/WebSocket controls receive the live `ActiveRuntime` when the server was started with runtime creation, so they have the same in-memory pause/resume effect as REST. Direct analyst-tool utility use without an injected live runtime falls back to canonical persisted-state control and returns the same frozen/unavailable validation results.

### Pause before low-risk maintenance

```bash
curl -X POST http://localhost:8080/api/runtime/pause \
  -H "Authorization: Bearer $SAIVAGE_API_TOKEN"
```

### Resume only from pause or idle

```bash
curl -X POST http://localhost:8080/api/runtime/resume \
  -H "Authorization: Bearer $SAIVAGE_API_TOKEN"
```

### Freeze before handoff or disruptive maintenance

```bash
curl -X POST http://localhost:8080/api/runtime/freeze \
  -H "Authorization: Bearer $SAIVAGE_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"reason":"operator handoff"}'
```

### Resume from freeze

```bash
curl -X POST http://localhost:8080/api/runtime/resume-from-freeze \
  -H "Authorization: Bearer $SAIVAGE_API_TOKEN"
```

## 5. Operator notes queue

Unhandled notes are stored per card and indexed in `.saivage/notes/queue.json`.

Current backend behavior:

- queue reads/writes are schema-validated;
- `GET /api/notes` returns only reconciled unhandled notes with an attached `note` record;
- stale queue entries that point at missing or handled notes are removed during reconciliation;
- malformed persisted queue files return a controlled `500` instead of returning partial `note: undefined` rows.

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
- in card detail, `Unauthorized` means the detail API could not be read; it does not mean the card has no evidence.

### Stale or reconnecting

- refresh the relevant view;
- treat REST reload as authoritative after reconnect;
- use Debug if stale or reconnecting state persists.
- in card detail, a stale banner after a card-updated event means status may have changed after the last evidence fetch.

### Offline

- verify the server process and port binding;
- verify docs and SPA serving separately from API runtime state;
- use process inspection and logs if the server is up but runtime is not advancing.
