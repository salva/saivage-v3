# F17 — Design (round 1, WRITER)

## Route

```
GET /api/agents/:id
```

Registered in [src/server/routes/runtime-config-notes.ts](../../../src/server/routes/runtime-config-notes.ts)
**after** the `GET /api/agents` list route and **before** `GET /api/agents/:id/conversation`,
so Fastify's radix tree resolves the bare `:id` only when no static sub-path
matches.

Authentication: inherits the global `authPlugin` bearer-token guard the same
way `/api/agents/:id/conversation` does (the plugin is registered for the
whole instance — see
[tests/server/agents-llm-exchange-route.test.ts#L58-L62](../../../tests/server/agents-llm-exchange-route.test.ts#L58-L62)).

## Request

- Path param `id` — must match `SAFE_AGENT_ID_RE = /^[a-zA-Z0-9_:-]+$/`
  ([runtime-config-notes.ts#L75](../../../src/server/routes/runtime-config-notes.ts#L75)).
- No query parameters in r1. (Future r2 could add `?include=last_message_role`;
  out of scope.)
- No body.

## Response (200)

```jsonc
{
  "session": {
    "id": "planner:card-abc",
    "role": "planner",
    "status": "active",                       // listedStatus() result
    "card_id": "card-abc" | null,
    "goal_card_id": "card-abc" | null,
    "started_at": "2026-05-22T13:45:01.123Z",
    "completed_at": "2026-05-22T13:59:11.000Z" | null,
    "model": "gpt-5-codex" | null,            // omitted if not in manifest
    "message_count": 42,                      // integer >= 0
    "last_activity_at": "2026-05-22T13:58:55.444Z" | null
  }
}
```

Field derivations:

| Field | Source |
|---|---|
| `id`, `role`, `status`, `card_id`, `goal_card_id`, `started_at`, `completed_at`, `model` | `buildListedAgentSession(projectRoot, id, state)` — already produced for the list endpoint; identical semantics, identical defaults (role parsed from id prefix if no manifest) |
| `message_count` | `readAgentMessages(projectRoot, id).length` — number of valid JSON lines parsed from `.saivage/agents/messages/<id>.jsonl`; `0` if the file is absent |
| `last_activity_at` | Last message line with a string `timestamp` field; fallback to `completed_at`, then `started_at`. `null` if the session has no manifest and no messages (cannot happen post 404 check) |

**No payloads.** Specifically: no `messages[]`, no `tool` strings, no
`content`, no `request`/`response` bodies. This is a deliberate inversion of
`/api/agents/:id/conversation`'s heavy shape.

## Error semantics

Aligned with the sibling routes:

| Condition | Status | Body |
|---|---|---|
| `id` fails `SAFE_AGENT_ID_RE` | `400` | `{"error":"Invalid agent session ID"}` |
| No manifest *and* no messages file for `id` | `404` | `{"error":"Agent session not found","sessionId":"<id>"}` |
| No auth bearer | `401` | (produced by `authPlugin`; identical to all other `/api/*` routes) |
| Unexpected fs / JSON error | `500` | `{"error":"Failed to read agent session","message":"<redacted>"}` |

400 / 404 / 401 wording exactly mirrors what
`GET /api/agents/:id/conversation` already returns
([runtime-config-notes.ts#L180](../../../src/server/routes/runtime-config-notes.ts#L180)),
so operator clients can treat all three agent endpoints with one error path.

## `last_activity_at` algorithm

A new private helper next to `firstMessageTimestamp` ([runtime-config-notes.ts#L98-L102](../../../src/server/routes/runtime-config-notes.ts#L98-L102)):

```ts
function lastMessageTimestamp(projectRoot: string, sessionId: string): string | null {
  const messages = readAgentMessages(projectRoot, sessionId);
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m && typeof m === 'object') {
      const ts = (m as Record<string, unknown>)['timestamp'];
      if (typeof ts === 'string') return ts;
    }
  }
  return null;
}
```

We deliberately scan in-process per request rather than maintaining a
side-index — message files for one session are small (tens to low thousands of
lines, JSONL with short objects); the cost is bounded and matches the existing
profile of `/api/agents/:id/conversation`, which already reads the entire file.
If profiling later shows this hot, an LRU cache keyed by `(path, mtime)` is the
obvious follow-up (out of scope for r1).

## Alternatives considered

1. **Extend `GET /api/agents` to include `message_count` / `last_activity_at`
   for every session.**
   Rejected: O(N·M) cost on the list path (currently list is O(N) header-only),
   and operators that want a single session would still pay the cost of
   enumerating all of them. Detail-level fields belong on the detail endpoint.

2. **Add `?summary=1` query flag to `GET /api/agents/:id/conversation`.**
   Rejected: violates REST conventions (changes response shape under a query
   flag), keeps the heavy-payload code path on the hot path, and complicates
   the operator-route inventory table in [docs/operation.md](../../../docs/operation.md).

3. **Expose a contract-mounted route in `src/contracts/operator-api.ts`
   instead of an inline Fastify handler.**
   Rejected for r1: every other `/api/agents/*` endpoint is currently inline in
   `runtime-config-notes.ts`; adding the new route there keeps the surface
   cohesive. Migrating all four agent endpoints into the contract layer is a
   broader refactor that this finding does not require, and the
   "architecture-first, no backward compat" rule applies to removing legacy
   structures, not to mass-relocating still-current code.

4. **Mirror `/api/processes/:id` shape verbatim.**
   `ProcessView` (see [src/server/routes/processes.ts#L66-L90](../../../src/server/routes/processes.ts#L66-L90))
   includes `command`, `cwd`, `logs`, `control`. None apply to an agent
   session; we keep the agent payload focused on identity + history fingerprint
   instead of trying to harmonize an unrelated resource.

## Security / privacy

- The handler returns **no** message content, tool names, or LLM payloads;
  only counts and ISO timestamps. No further redaction wiring required.
- `SAFE_AGENT_ID_RE` already prevents path traversal (verified by the existing
  `..%2Fevil` test case in [tests/server/agents-llm-exchange-route.test.ts#L100-L108](../../../tests/server/agents-llm-exchange-route.test.ts#L100-L108)).
- Bearer-token auth from `authPlugin` is enforced uniformly.

## Web UI consumers

No Vue components currently call `/api/agents/:id`. Adding the route is
strictly additive; no `web/src/` changes are required in r1. A future UI
enhancement may use it to show per-session size in the agent picker (out of
scope).
