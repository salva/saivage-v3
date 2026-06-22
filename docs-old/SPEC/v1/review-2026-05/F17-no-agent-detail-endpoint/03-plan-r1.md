# F17 — Implementation plan (round 1, WRITER)

Branch: `stage-44-permissions-by-state-matrix` (current).
Deployment target: container `saivage-v3-getrich-v2` @ `10.0.3.170`, service
`saivage-v3-getrich.service`. Host-side build + SSH restart, **no rsync**, per
workspace handoff.

## Changes

### 1. `src/server/routes/runtime-config-notes.ts`

a. Add helper `lastMessageTimestamp` next to `firstMessageTimestamp`
   (around [line 98-102](../../../src/server/routes/runtime-config-notes.ts#L98-L102)):

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

b. Register the new route **between** the `GET /api/agents` and
   `GET /api/agents/:id/conversation` handlers
   (between [line 179](../../../src/server/routes/runtime-config-notes.ts#L179) and
   [line 180](../../../src/server/routes/runtime-config-notes.ts#L180)). Style matches the
   surrounding single-line handlers in the file:

```ts
fastify.get('/api/agents/:id', async (request, reply) => {
  try {
    const params = request.params as { id: string };
    const sessionId = params.id;
    if (!SAFE_AGENT_ID_RE.test(sessionId)) return reply.status(400).send({ error: 'Invalid agent session ID' });
    const manifest = readAgentSession(projectRoot, sessionId);
    const messages = readAgentMessages(projectRoot, sessionId);
    if (!manifest && messages.length === 0) return reply.status(404).send({ error: 'Agent session not found', sessionId });
    const session = buildListedAgentSession(projectRoot, sessionId, readRuntimeState(projectRoot));
    if (!session) return reply.status(404).send({ error: 'Agent session not found', sessionId });
    const lastActivity = lastMessageTimestamp(projectRoot, sessionId)
      ?? (typeof manifest?.['completed_at'] === 'string' ? (manifest['completed_at'] as string) : null)
      ?? (typeof session['started_at'] === 'string' ? (session['started_at'] as string) : null);
    return reply.send({ session: { ...session, message_count: messages.length, last_activity_at: lastActivity } });
  } catch (err) {
    return reply.status(500).send({ error: 'Failed to read agent session', message: err instanceof Error ? err.message : String(err) });
  }
});
```

No other code in this file is touched; existing helpers
(`readAgentSession`, `readAgentMessages`, `buildListedAgentSession`,
`SAFE_AGENT_ID_RE`, `readRuntimeState`) are reused unchanged.

### 2. `tests/server/agents-detail-route.test.ts` (new)

Mirror [tests/server/agents-llm-exchange-route.test.ts](../../../tests/server/agents-llm-exchange-route.test.ts)
structure (Jest + Fastify + `initProjectTree` + `configureAuthPolicy`). Cases:

1. **200** with manifest + messages — returns
   `{ session: { id, role, card_id, started_at, message_count: N, last_activity_at: <last ts> } }`.
   Seed `.saivage/agents/sessions/<id>.json` (use `createSession` from
   `src/agents/session-persistence.ts`) and append N message lines with
   increasing `timestamp` values.
2. **200** with messages only (no manifest) — role inferred from id prefix
   (e.g. `executor-2026-05-23-1`); `message_count` matches lines;
   `last_activity_at` = last timestamp.
3. **200** with manifest only (no messages file) — `message_count: 0`,
   `last_activity_at` falls back to `completed_at` or `started_at`.
4. **400** for id violating `SAFE_AGENT_ID_RE` (`..%2Fevil`).
5. **404** for an id with neither manifest nor messages.
6. **401** when no auth bearer is provided.

No fixtures or contract-helpers need editing; the test composes Fastify
in-process exactly as the sibling test does.

### 3. `docs/operation.md` — operator-route inventory

Insert a row into the `<!-- saivage:operator-routes:start -->` table
(`docs/operation.md` around [line 322](../../../docs/operation.md#L322)), kept
alphabetical with the other `GET /api/agents*` entries:

```
| `GET /api/agents/:id` | Read one persisted agent-session summary (counts, timestamps; no payload). | `src/server/routes/runtime-config-notes.ts:<NEW_LINE>` |
```

`<NEW_LINE>` resolved at edit-time. `npm run docs:verify` will fail until this
row is present and the line anchor matches.

### 4. `docs/design/server-api.md` — design narrative

Add a one-line entry to the route listing around
[line 154](../../../docs/design/server-api.md#L154):

```
GET    /api/agents/:id                 Read agent-session summary (counts + timestamps; no payload)
```

And a sentence near the existing `/api/agents/:id/conversation` description
clarifying that the detail endpoint is the cheap shape used by
restart-persistence and external-monitor checks.

`docs/historical/2026-pre-consolidation/08-server-api.md` is intentionally
**not** touched (historical snapshot).

## Validation commands

Run from `/home/salva/g/ml/saivage-v3`. Follow
[/home/salva/g/ml/.github/skills/saivage-development-validation/SKILL.md](../../../../.github/skills/saivage-development-validation/SKILL.md).

```bash
# 1. Type / lint / build
cd /home/salva/g/ml/saivage-v3
npm run build          # tsc -p tsconfig.json; must be clean

# 2. Targeted test
npx jest tests/server/agents-detail-route.test.ts --runInBand

# 3. Full server test suite (catches regressions in inventory/routing)
npx jest tests/server --runInBand

# 4. Docs verifier (validates operator-routes table line anchors)
npm run docs:verify
```

## Deployment

```bash
# host-side (assumes build succeeded above)
ssh root@10.0.3.170 'systemctl stop saivage-v3-getrich.service'
ssh root@10.0.3.170 'cd /work/saivage-v3-getrich && git fetch && git checkout stage-44-permissions-by-state-matrix && git pull --ff-only && npm ci && npm run build'
ssh root@10.0.3.170 'systemctl start saivage-v3-getrich.service'
sleep 2
curl -fsS --max-time 5 http://10.0.3.170:8080/health
```

(Per workspace handoff: no `rsync`; the container builds from its own checkout.
If the actual deployment topology builds on host and ships `dist/`, substitute
the in-container build step with the standard SSH-copy used elsewhere in this
review series — but still **no `rsync`**.)

## Acceptance checklist

- [ ] `GET /api/agents/<existing-id>` returns **200** with the documented body shape.
- [ ] `GET /api/agents/<existing-id>` body contains `message_count` (number) and `last_activity_at` (ISO string or null) and **no** `messages[]`, no `content`, no `request`/`response` fields.
- [ ] `GET /api/agents/<nonexistent>` returns **404** with `{"error":"Agent session not found","sessionId":"<nonexistent>"}`.
- [ ] `GET /api/agents/..%2Fevil` returns **400** with `{"error":"Invalid agent session ID"}`.
- [ ] Unauthenticated `GET /api/agents/<id>` returns **401**.
- [ ] `npm run build` passes with no new TypeScript errors.
- [ ] `npx jest tests/server/agents-detail-route.test.ts` — 6/6 green.
- [ ] `npx jest tests/server` — no regressions.
- [ ] `npm run docs:verify` passes (operator-routes table accepts the new row).
- [ ] `curl http://10.0.3.170:8080/health` returns 200 after restart.
- [ ] Manual probe against the live container:
      `curl -H "Authorization: Bearer $TOKEN" http://10.0.3.170:8080/api/agents | jq '.sessions[0].id'`
      then
      `curl -H "Authorization: Bearer $TOKEN" "http://10.0.3.170:8080/api/agents/$ID"`
      returns 200 with the summary shape.
- [ ] G4/T37 restart-persistence check (Phase-2) can be tightened to assert
      `message_count > 0` survived restart — follow-up note logged for the test
      author; no test change is in scope for this finding.
