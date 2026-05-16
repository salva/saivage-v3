# Saivage v3 — Operator Runbook

This runbook is the current operator workflow guide for the Web Control Room, analyst control surface, and runtime recovery.

For the dedicated analyst operator guide covering the chat panel, shell policy, secret-path denylist, card-detail entry point, live attribution behavior, and focused web validation cadence, see [Analyst Operator Guide](/analyst).

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
- operator notifications and pending confirmations where shown

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
- **card history** via the `CardHistoryPanel`
- **Discuss with analyst** one-click entry into a context-seeded analyst chat

Do not use an empty queue alone as evidence that planning is complete.

### Card history

Tracked card changes create a versioned history entry before the new card record is written. Tracked fields include operator-intent fields such as title, description, acceptance, instructions file, type/subtype, parentage, tags, priority/urgency/estimate, dependencies/relationships, assignment, artifacts, and attachments.

Use card history when you need to answer:

- what changed on a card;
- who changed it;
- whether a running agent may be stale;
- which prior version the agent was likely following.

Operator surfaces:

- **UI:** card detail → `CardHistoryPanel`
- **REST:** `GET /api/cards/:id/history`, `GET /api/cards/:id/history/:seq`, `GET /api/cards/:id/diff?from=&to=`
- **Chat/tools:** `list_card_history`, `get_card_history_entry`, `diff_card`

If an agent is still running after a tracked edit, expect a notification at its next safe point and do not trust a `done` result until the blocking notification is acknowledged when required.

### Notifications and stale-work warnings

Notifications exist for both operator surfaces and active agent sessions.

Primary triggers in the current system:

- tracked card mutations;
- note creation;
- runtime pause/resume/freeze/resume-from-freeze;
- process termination through canonical controls;
- redacted config/provider changes when supported by the canonical write path.

Severity rules you should remember:

- `card_changed`: `block` when `acceptance`, `description`, `instructions_file`, or `depends_on` changed; otherwise `warn`
- `note_added`: `warn` for `directive`, `block` for `escalation`, operator-only `info` for `comment`/`progress`
- `runtime_state`: `block` for pause/freeze, `info` for resume/resume-from-freeze
- `process_state`: `warn`
- `config_changed`: `info`

Operator surfaces:

- **UI:** `NotificationsPanel`, `PendingConfirmationsPanel`, stale ribbon on active-card views
- **REST:** `GET /api/notifications`, `POST /api/notifications/:id/acknowledge`
- **Chat/tools:** agent sessions use `acknowledge_notification`; operators acknowledge operator-surface notifications via UI or REST

A stale ribbon or stale banner means a relevant notification arrived after the view last refreshed. Refresh first, then act.

### Notes: directives vs escalations

Notes are not interchangeable with card edits.

Use a **card edit** when the objective, instructions, acceptance criteria, dependency graph, or ownership changed.

Use a **note** when the operator is adding runtime guidance or observations:

- `comment` — operator/context note; operator notification only
- `progress` — progress/status note; operator notification only
- `directive` — present-tense steering for a running or queued agent; session notification severity `warn`
- `escalation` — something is wrong or blocking; session notification severity `block`

A directive or escalation should be preferred over direct analyst→agent messaging. There is no direct analyst→running-agent chat lane in this design.

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
7. **Card history** — confirms whether the work was edited after the agent began.

If the detail view shows **This card detail may be stale**, refresh the card before acting on evidence or completion state.

### Analyst secret-path denylist

Analyst filesystem inspection uses one centralized secret-path policy. Requests that target secret-bearing paths are denied before file contents are read. The denylist covers auth profiles, env files, SSH keys, cloud credential locations, `.npmrc`, `.pypirc`, and similar secret material.

For directory listings, secret-bearing child entries are omitted entirely. The response includes `redacted_count`, and when one or more entries were suppressed the listing appends a single `<redacted>` summary row with the hidden count. Operators should treat that as an intentional safety boundary, not missing data.

For shell-command classification, commands that target denylisted secret-bearing paths are treated as unsafe and denied on web chat by default. See [Analyst Operator Guide](/analyst) for the full analyst shell and chat behavior.

### Focused analyst web validation

When validating shipped analyst UI behavior from Waves L-M, run the focused suites with **Vitest from `/work/saivage-v3/web`** (or the root wrapper that delegates there), not root Jest.

Relevant suites:

- `analyst-chat-panel.test.ts`
- `analyst-chat-store.test.ts`
- `app-shell-analyst-drawer.test.ts`
- `analyst-toaster.test.ts`
- `card-detail-view.test.ts`
- `card-history-panel-analyst-filter.test.ts`
- `ws-store.test.ts`

Preferred commands:

```bash
cd /work/saivage-v3/web
npm test -- src/__tests__/analyst-chat-panel.test.ts src/__tests__/analyst-chat-store.test.ts src/__tests__/app-shell-analyst-drawer.test.ts src/__tests__/analyst-toaster.test.ts src/__tests__/card-detail-view.test.ts src/__tests__/card-history-panel-analyst-filter.test.ts src/__tests__/ws-store.test.ts
```

or:

```bash
npm run web:test:analyst-ui
```

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
- see when an operator update should have reached the session

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
- `NotificationsPanel` for operator-surface queue review and acknowledgement
- `PendingConfirmationsPanel` for preview-only rejected actions awaiting explicit confirmation
- recent errors
- event timeline
- doctor checks
- supervision and quarantine information
- MCP status/tools
- processes
- control-action audit reads

If the UI reports degraded, frozen, stale, or repeated agent failures, Debug is the first operator destination.

## 4. Runtime control procedures

Pause/resume validation is shared across REST endpoints, CLI commands, web UI controls, and analyst tools. Server-hosted analyst chat/WebSocket controls receive the live `ActiveRuntime` when the server was started with runtime creation, so they have the same in-memory pause/resume effect as REST and web UI. Direct CLI or utility use without a live runtime falls back to canonical persisted-state control and emits an explicit notice when only disk state changed.

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

### Resume-from-freeze distinction

Do **not** use generic resume from `frozen` or `error` states.

Expected behavior:

- generic `resume` is for paused/idle dispatch state;
- `frozen` requires `resume-from-freeze`;
- a rejected generic resume from `frozen` or `error` is an intentional safety response, not a bug.

## 5. Authorization, preview, and audit

Mutating controls use a static authorization table keyed by `(actor, surface, safety_class) -> allow | deny | preview_only`.

Current default policy summary:

- analyst on `web-chat`: `allow` for `read_only`/`low`, `preview_only` for `high` and `destructive`, `deny` for `deployment`
- analyst on `telegram`: `allow` for `read_only`/`low`, `preview_only` for `high`, `deny` for `destructive` and `deployment`
- user on `rest` and `cli`: more permissive by default, including `allow` for most `high`/`destructive` operations and `preview_only` for `deployment`
- runtime on `runtime`: internal canonical mutations are allowed except `deployment`

Operational rules:

- **deny**: action fails and is audited as denied
- **preview_only**: action returns a preview and preview hash; commit requires `confirmed: true` plus the matching hash
- **allow**: action commits immediately via the canonical service

Customization:

- edit the static authz rule table in source (`src/agents/authz.ts`)
- keep the table aligned across chat, REST, CLI, and web UI expectations
- prefer changing the verdict table instead of adding one-off confirmation logic in individual tools/routes

Every mutating call writes one control-action audit entry to `.saivage/runtime/control-actions.jsonl`.

Use audit reads when you need to answer:

- who changed state;
- whether a preview was rejected vs confirmed;
- whether authz denied a request;
- whether a pause/freeze/process kill came from chat, REST, CLI, runtime, or web UI.

## 6. Operator notes queue

Unhandled notes are stored per card and indexed in `.saivage/notes/queue.json`.

Current backend behavior:

- queue reads/writes are schema-validated;
- `GET /api/notes` returns only reconciled unhandled notes with an attached `note` record;
- stale queue entries that point at missing or handled notes are removed during reconciliation;
- malformed persisted queue files return a controlled `500` instead of returning partial `note: undefined` rows;
- note IDs are stable and sequence-based, not renumbered after deletion/handling.

## 7. Degraded-state workflow

If runtime or UI state is degraded:

1. Check `/health`.
2. Check `/api/runtime/status`.
3. Open Debug and inspect errors, timeline, doctor, supervision, processes, notifications, and control actions.
4. Open affected card detail or agent conversation for evidence and history.
5. Pause or freeze before manual intervention if state is still mutating.
6. Only then consider direct filesystem inspection.

## 8. Unauthorized, stale, and offline workflow

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
- in card detail, a stale banner after a card-updated or notification event means status may have changed after the last evidence fetch.

### Offline

- verify the server process and port binding;
- verify docs and SPA serving separately from API runtime state;
- use process inspection and logs if the server is up but runtime is not advancing.
