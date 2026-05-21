# Incidents

<!-- doc-authority
status: current
disposition: keep
owner: docs-maintainers
superseded_by: none
last_verified_against: src/server/routes/chats-files-debug.ts:341
-->

Use this page when runtime, UI, auth, evidence, or agent behavior is degraded. Start with [Operations](./operations.md) for normal procedures.

## First response checklist

1. Check public health:

```bash
curl http://localhost:8080/health
```

2. Check authenticated state:

```bash
curl -H "Authorization: Bearer $SAIVAGE_API_TOKEN" \
  http://localhost:8080/api/state
```

3. Open Debug and inspect errors, timeline, doctor, supervision, processes, notifications, MCP, and control actions.
4. Open affected card detail or agent conversation for evidence and history.
5. Pause or freeze before manual intervention if state is still mutating.

## Unauthorized API or WebSocket access

Symptoms:

- `401 Unauthorized` from `/api/*`.
- WebSocket does not connect.
- UI shows unauthorized/no-token state.
- Card detail shows `Unauthorized`.

What to do:

1. Confirm `SAIVAGE_API_TOKEN` is configured on the server.
2. Confirm REST/API clients send `Authorization: Bearer <token>`.
3. Confirm clients are not sending URL/query API bearer credentials such
   as `?token=<token>`; those are prohibited and rejected.
4. For browser WebSocket failures, confirm the client obtains a
   short-lived, one-use ticket from `POST /api/auth/ws-ticket` using the
   bearer REST header and connects to `/ws?ticket=<ticket>`.
5. Confirm `/health` works without auth.
6. Confirm `/docs/` remains public.
7. Re-enter the token in the Web Control Room token modal when needed.

## Stale, reconnecting, or offline UI

A stale banner means a relevant notification arrived after the last successful fetch. Reconnecting/offline states mean WebSocket freshness is degraded; REST reloads remain authoritative.

What to do:

1. Refresh the relevant view.
2. Use `/api/state`, card detail, and Debug as the source of truth after reconnect.
3. If offline persists, verify the service process, port binding, and journal logs.

## Preview-only or denied control action

Mutating controls use a static authorization table keyed by actor, surface, and safety class.

- `deny` fails and writes a denied audit entry.
- `preview_only` returns a preview and `preview_hash`; commit requires `confirmed: true` and the matching hash.
- `allow` commits immediately through the canonical service.

What to do:

1. Confirm the intended surface: `web-chat`, `web-ui`, `rest`, `cli`, `runtime`, or `telegram`.
2. Re-submit with `confirmed: true` and the matching preview hash when appropriate.
3. Inspect `/api/control-actions` to see whether the request was denied, rejected, previewed, or committed.
4. Change the authz table in `src/agents/authz.ts` rather than bypassing individual routes if policy is wrong.

## Frozen, paused, or error runtime state

Generic resume is intentionally rejected for `frozen` and `error` states. This is a safety rule.

What to do:

1. If paused, use `POST /api/runtime/resume`.
2. If frozen, use `POST /api/runtime/resume-from-freeze`.
3. If error, inspect Debug errors/timeline and fix the underlying failure before attempting recovery.
4. Freeze before disruptive filesystem or deployment intervention.

## Running agent ignored a change or cannot finish

Likely causes:

- Operator changed a card while an agent was running.
- A directive or escalation note arrived.
- A blocking notification was not acknowledged.
- Executor/reviewer dispatch was held for notification delivery.

What to do:

1. Inspect card history and notes.
2. Inspect the session conversation for synthetic operator-update messages.
3. Ensure the agent used `diff_card`, `get_card_history_entry`, `get_note`, or similar read tools as needed.
4. Ensure blocking notifications are acknowledged before accepting terminal results.
5. Treat repeated failure after reinvocation as an agent/tooling issue rather than forcing completion.

## Generated file preview is blocked or redacted

Expected causes include secret-path policy, containment violation, oversize content, binary files, or symlinks resolving outside the project root.

Examples:

- `.saivage/auth-profiles.json` is blocked.
- `.saivage/saivage.json` is redacted-only.

What to do:

- Treat blocked/redacted states as intentional safety behavior first.
- Use card detail and Files view blocked reasons before raw filesystem reads.
- Do not bypass API preview policy during routine operation.

## Card detail evidence or review is incomplete

Different states mean different things:

- `No operator-facing evidence is recorded yet` — active/running work has not produced evidence yet.
- Incomplete evidence on a blocked/done/failed card — completion is not operator-verified.
- Missing files — evidence references were recorded, but the file is gone.
- `Review failed` or `Not reviewed` — card completion is not accepted by reviewer evidence alone.

What to do:

1. Check verification commands, review result, dispatch summary, and evidence cards.
2. Inspect cited evidence-card IDs.
3. Inspect card history for acceptance changes after evidence was produced.
4. Do not accept completion based on status alone.

## Agent/tool invocation failures

Use Debug before manual repair:

- `GET /api/debug/errors`
- `GET /api/debug/timeline`
- `GET /api/debug/doctor`
- `GET /api/debug/supervision`
- `GET /api/processes`

Correlate failed sessions in Agents with runtime events and process views. Provider errors should be redacted before persistence and notification.

## Validation-command confusion

Root `npm test` runs backend Jest under `tests/`. Web UI suites run under Vitest from `web/` or via root wrappers.

Preferred analyst UI validation wrapper:

```bash
npm run web:test:analyst-ui
```

Core validation commands:

```bash
npm run typecheck
npm run docs:verify
npm test
```
