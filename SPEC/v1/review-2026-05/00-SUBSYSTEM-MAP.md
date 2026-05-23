# Saivage v3 Subsystem Map (review-2026-05)

Scope: subsystems touched by the 12 Phase-2 findings (F12–F23) raised by the Checkers E2E audit on 2026-05-23. All paths are relative to repo root `saivage-v3/`.

## Layers

### `src/cards/` — Card store, history, diary
- [src/cards/card-store.ts](../../../src/cards/card-store.ts) — canonical hierarchy validator, `cards/index.json` ↔ `cards/by-id/<id>.json` consistency, history append (`cards/history/<id>.history.jsonl`). Source of the `Canonical hierarchy invariant failed` errors (F13). Owns `version_seq` bumps and the by-id↔index write transaction (F12, F13).
- [src/cards/index.ts](../../../src/cards/index.ts) — public API for card mutations and reads consumed by routes + runtime.
- [src/cards/diary.ts](../../../src/cards/diary.ts), [src/cards/notes.ts](../../../src/cards/notes.ts), [src/cards/artifacts.ts](../../../src/cards/artifacts.ts) — sibling stores.
- [src/projections/index.ts](../../../src/projections/index.ts) — `registerCardHistoryProjection` (consumed by card-store).

### `src/runtime/` — Runtime lifecycle, control, state
- [src/runtime/active-runtime.ts](../../../src/runtime/active-runtime.ts) — in-process runtime singleton; surfaces `getStatus()` to `/api/runtime/status` (F18, F19).
- [src/runtime/control.ts](../../../src/runtime/control.ts) — pause/resume/start/stop/recover; orchestrates card lifecycle transitions (F19, F20, F23).
- [src/runtime/lifecycle.ts](../../../src/runtime/lifecycle.ts) — card-level lifecycle hooks; likely site of the executor "report success vs report failed" decision (F20).
- [src/runtime/state.ts](../../../src/runtime/state.ts) — persisted runtime snapshot (`current_card_id`, status, pid). PID is sourced here (F18).
- [src/runtime/process-runner.ts](../../../src/runtime/process-runner.ts), [src/runtime/lock.ts](../../../src/runtime/lock.ts), [src/runtime/stuck-agent-supervisor.ts](../../../src/runtime/stuck-agent-supervisor.ts) — adjacent.

### `src/server/` — HTTP/WS routes (Fastify)
- [src/server/server.ts](../../../src/server/server.ts) — bootstrap + a large inline `registerRuntimeDispatchRoutes` containing `/api/runtime/status` (F14, F18, F19).
- [src/server/routes/cards.ts](../../../src/server/routes/cards.ts) — `/api/cards`, `/api/cards/:id`, `/api/cards/:id/history`, `/api/cards/:id/diff` (F12, F21).
- [src/server/routes/operator-contracts.ts](../../../src/server/routes/operator-contracts.ts) — `/api/state` payload assembly (F14).
- [src/server/routes/processes.ts](../../../src/server/routes/processes.ts) — agent listing + `llm-exchange` endpoints; missing `/api/agents/:id` detail route (F17).
- [src/server/routes/auth.ts](../../../src/server/routes/auth.ts), [src/server/routes/chats-files-debug.ts](../../../src/server/routes/chats-files-debug.ts), [src/server/routes/events.ts](../../../src/server/routes/events.ts).

### `src/agents/` — Role agents (planner, executor, reviewer, analyst, …)
- Used by F20 (executor declares failed despite success-on-disk) and F22 (planner role missing default model list).
- Look for the role registry and the per-role model-routing resolution in this folder + `src/config/`.

### `src/config/` — Saivage configuration loader
- Owns the `models` map per role + the provider registry. F22 traces here (no default model list).

### `src/mcp/` — Model Context Protocol manager
- Source of `serverAvailability.components.mcp.state` classification (F15).

### `src/observability/` — Server availability builder
- [src/observability](../../../src/observability) — `buildServerAvailability` consumed by `/api/state` and `/api/runtime/status`; classifies MCP as `degraded` when empty (F15).

### `src/permissions/` — Card-status state machine
- The `failed → active` invalid transition (F23) is rejected here; allowed-transition set was reported as `{backlog, cancelled}`. Likely owner of the state matrix.

### `src/contracts/`, `src/schemas/`
- Zod schemas + operator API contracts referenced by F14 (matrix expected `projectRoot`).

## Cross-cutting Concerns

- **Atomic card writes:** `card-store.ts` writes the by-id record, the index file, and the history file as separate fs operations. Race / partial-write windows are the most likely root cause for F12 (history empty) and F13 (index drift).
- **Runtime ↔ Card lifecycle bridge:** `runtime/control.ts` and `runtime/lifecycle.ts` jointly decide when to mark a card terminal vs replan. Findings F19, F20, F23 all sit on this seam.
- **Operator API surface contracts:** routes in `src/server/routes/*` and the inline routes in `src/server/server.ts` share schema responsibilities with `src/contracts/operator-contracts.ts`. Drift between docs and code surfaces (F14, F17, F21).
- **Config defaults:** `src/config/` + `src/agents/` resolve role → models. Missing defaults manifest as the F22 boot-cycle error.

## Out of Scope

- Web Vue dashboard (`web/`) — not touched by these findings (UI gaps F02/F11/F08 are Phase-1, excluded per user scope).
- `src/telegram/`, `src/notifications/` — not in any F12–F23 evidence.
- Phase-1 findings F01–F11 — excluded per user scope.
