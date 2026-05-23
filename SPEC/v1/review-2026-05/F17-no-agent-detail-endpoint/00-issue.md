# F17 — No agent-detail endpoint exposes per-session message/turn count

## Summary

`GET /api/agents/<id>` returns 404. Only `/api/agents` (list) and `/api/agents/<id>/llm-exchange` (latest exchange only) are addressable. This makes externally-verifiable restart-persistence tests (G4/T37) weak: we can confirm a session id survived a restart but not that its message history is intact. The proposed shape is a small `/api/agents/:id` returning `{ id, role, card_id, started_at, message_count, last_activity_at }` (no payloads).

## Evidence

- Phase-2 G4/T37: [tmp/saivage-v3-checkers-e2e-artifacts-20260523-phase2/G4-report.md](../../../../tmp/saivage-v3-checkers-e2e-artifacts-20260523-phase2/G4-report.md) §T37.
- Owner code: [src/server/routes/processes.ts](../../../src/server/routes/processes.ts) (agent routes); [src/agents/](../../../src/agents/) (session message storage).

## Category

half-implemented (route surface)

## Severity

P3 — observability gap, not blocking.

## Transversality

Local: add one route + one read path. May require touching the agent message store to expose a counter.
