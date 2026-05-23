# F17 — Analysis (round 1, WRITER)

## Root cause / current behavior

The agent-session HTTP surface in Saivage v3 exposes three endpoints, all registered inline as one-liners in [src/server/routes/runtime-config-notes.ts](../../../src/server/routes/runtime-config-notes.ts#L179-L249):

- `GET /api/agents` — lists every session id discovered under either
  `.saivage/agents/sessions/<id>.json` (manifests) or
  `.saivage/agents/messages/<id>.jsonl` (message logs), and projects each through
  the local helper `buildListedAgentSession` ([runtime-config-notes.ts#L122-L132](../../../src/server/routes/runtime-config-notes.ts#L122-L132)).
- `GET /api/agents/:id/conversation` — returns `{ session, messages }` where
  `messages` is the full parsed `.jsonl` ([runtime-config-notes.ts#L180](../../../src/server/routes/runtime-config-notes.ts#L180)).
- `GET /api/agents/:id/llm-exchange` — returns only the latest captured LLM
  request/response pair ([runtime-config-notes.ts#L181-L196](../../../src/server/routes/runtime-config-notes.ts#L181-L196)).

There is **no** `GET /api/agents/:id` route. Fastify therefore returns its
default 404 (`{"message":"Route GET:/api/agents/SESSION-ID not found","error":"Not Found","statusCode":404}`)
when an operator hits the natural identifier URL.

Indirect consequence: the only way to ask the server "does this agent session
still exist after a restart, and roughly how big is it?" is to fetch
`/api/agents/:id/conversation`, which streams the entire JSONL payload back —
heavy, payload-leaky, and over-permissive for restart-persistence probes that
just need a structural fingerprint.

## What the data already supports

The on-disk shape of a persisted session, as written by
[src/agents/session-persistence.ts](../../../src/agents/session-persistence.ts#L66-L88):

```ts
// agentSessionSchema, src/schemas/validators.ts:46
{
  id: string,
  role: 'analyst' | 'planner' | 'reviewer' | 'executor' | ...,
  goal_card_id: string | null,
  card_id: string | null,
  status: 'active' | 'waiting' | 'done' | 'blocked' | 'failed' | ...,
  started_at: string,           // ISO datetime
  completed_at?: string | null,
  model?: string,
}
```

The message log at `.saivage/agents/messages/<id>.jsonl` is one JSON object per
line; each line typically carries a `timestamp` field (used by
`firstMessageTimestamp` at [runtime-config-notes.ts#L98-L102](../../../src/server/routes/runtime-config-notes.ts#L98-L102)).

So the proposed detail payload `{ id, role, card_id, started_at, message_count,
last_activity_at }` is derivable from data already on disk with **no schema
change** and **no new write paths**. Status, `goal_card_id`, and `model` are
trivially included for free.

## Impact

- **Observability gap (P3, per F17 issue).** Restart-persistence tests
  (Phase-2 §G4 / T37 — see
  [tmp/saivage-v3-checkers-e2e-artifacts-20260523-phase2/G4-report.md](../../../../tmp/saivage-v3-checkers-e2e-artifacts-20260523-phase2/G4-report.md))
  can confirm "session id appears in `/api/agents`" but not "the message history
  for that session survived the restart". This forces the test to fall back to
  the heavy conversation endpoint or to private filesystem inspection.
- **REST surface inconsistency.** Every other id-addressed resource in the API
  inventory exposes a bare detail endpoint:
  `/api/cards/:id`, `/api/processes/:id` ([src/server/routes/processes.ts#L106-L131](../../../src/server/routes/processes.ts#L106-L131)),
  `/api/chats/:sessionId`. Agents are the lone exception.
- **Payload-leak risk for monitoring tools.** A monitor that only needs
  liveness/age/size of a session is currently forced to retrieve the full
  conversation, which may contain redactable user content.
- **No external-client downstream.** Web UI (`web/src/components/`) does not
  currently call `/api/agents/:id` — UI consumes `/api/agents` and
  `/api/agents/:id/conversation`. Adding the detail route is a strictly
  additive surface change.

## Scope

- **Server (Fastify):** one new handler in
  [src/server/routes/runtime-config-notes.ts](../../../src/server/routes/runtime-config-notes.ts),
  reusing existing helpers (`readAgentSession`, `readAgentMessages`,
  `buildListedAgentSession`, `SAFE_AGENT_ID_RE`, `readRuntimeState`).
- **Tests:** new
  `tests/server/agents-detail-route.test.ts`, modelled on the existing
  [tests/server/agents-llm-exchange-route.test.ts](../../../tests/server/agents-llm-exchange-route.test.ts).
- **Docs:** add a row to the operator-route inventory in
  [docs/operation.md](../../../docs/operation.md) (the
  `<!-- saivage:operator-routes:start -->` table, enforced by
  `npm run docs:verify`), and a short paragraph in
  [docs/design/server-api.md](../../../docs/design/server-api.md#L154).
- **Out of scope:** no contract change in `src/contracts/operator-api.ts` (the
  existing agent endpoints are inline Fastify routes, not contract-mounted, so
  the new sibling stays consistent with current architecture). No web/UI
  change — Phase-2 finding is observability-only.

## Non-goals (per binding decisions)

- No migration shim: there is nothing to migrate; the route is new.
- No new docstrings/comments in untouched code: helper functions stay as they
  are; only the new route block gets necessary inline structure.
- No backward-compat with the 404-on-`/api/agents/:id` behavior — by definition
  the new route replaces a missing route, not a deprecated one.
