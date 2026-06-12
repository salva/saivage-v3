# Wave 008 research findings — backend read-model extraction

Date: 2026-05-27  
Task: `t1-scope-and-proposals`

## Executive summary

Current code confirms Wave 008 is still needed. Runtime/card/debug/file/chat read-model assembly is spread across `src/server/server.ts`, `src/server/routes/operator-contracts.ts`, `src/server/routes/chats-files-debug.ts`, `src/server/websocket.ts`, `src/server/availability.ts`, and the agent-layer `src/agents/analyst-stage6.ts`. The direct proposal recommends extracting endpoint-shaped backend read-model services first, keeping routes thin and deferring contract/route consolidation to Wave 009.

## Key evidence

- `src/server/server.ts:53-56` registers `/api/runtime/card-runs` and `/api/runtime/status` with inline handlers; `/api/runtime/status` manually branches between `ActiveRuntime` and persisted runtime state.
- `src/server/routes/operator-contracts.ts:47-65` constructs `CardStore`, reads runtime state, lists cards, and computes `cardIndex` inside contract handlers.
- `src/server/routes/operator-contracts.ts:66-102` handles card list/detail/history/diff projections and errors inline.
- `src/server/routes/chats-files-debug.ts:205-322` implements file listing/content reads directly in route code.
- `src/server/routes/chats-files-debug.ts:326-472` implements debug state, errors, timeline, and doctor read models directly in route code.
- `src/server/websocket.ts:92-96` sends a runtime-state websocket snapshot that ignores the passed `ActiveRuntime` and contains no shared REST status projection.
- `src/agents/analyst-stage6.ts:180-193` owns the card-runs response builder even though it is consumed by `src/server/server.ts:24,54` for a backend runtime endpoint.
- `src/runtime/ports.ts:3-13` exposes mutation/runtime state ports but not application read-model services.

## Recommendation

Prefer `proposal-direct.md`: add a backend application read-model package with focused services and narrow ports, update existing server/route/websocket consumers minimally, and delete route-local duplicated assembly. The restructure proposal is cleaner conceptually but likely too broad for a single cycle and risks premature abstraction before Wave 009 route consolidation.

## Local evidence artifacts

- `architecture-audit/cycle-008-backend-application-services-read-models/logs/current-code-excerpts.txt`
- `architecture-audit/cycle-008-backend-application-services-read-models/logs/current-read-model-grep.txt`
- `architecture-audit/cycle-008-backend-application-services-read-models/logs/card-runs-grep.stdout.log`
- `architecture-audit/cycle-008-backend-application-services-read-models/logs/dirty-diff-name-status.txt`
