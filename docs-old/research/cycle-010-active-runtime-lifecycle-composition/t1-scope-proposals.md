# Wave 010 scope/proposal research notes

Date: 2026-05-27  
Task: `t1-scope-proposals`

## 30-second summary

- Mailbox was empty except `README.md`, `done/`, and `rejected/`, so Wave 010 can proceed.
- Wave 010 premise still holds: `src/runtime/active-runtime.ts` imports `ServerInstance` from `../server/server.js`, stores it, exposes `setServer`, and `src/server/server.ts` calls that setter.
- `src/server/server.ts` is still a dense composition module even after Wave 009 route consolidation: Fastify/static setup, runtime startup, MCP startup, Telegram startup, route registration, shutdown, restart, and instance construction are inline.
- Direct proposal is recommended as the smaller implementation: remove runtime→server backlink and extract named lifecycle composition modules while keeping `createServer` as composition root.
- Restructure alternative introduces an explicit server application context and may narrow `ServerInstance`, but carries higher churn.

## Evidence files written

- `architecture-audit/cycle-010-active-runtime-lifecycle-composition/scope-check.md`
- `architecture-audit/cycle-010-active-runtime-lifecycle-composition/proposals/proposal-direct.md`
- `architecture-audit/cycle-010-active-runtime-lifecycle-composition/proposals/proposal-restructure.md`

## Current-code evidence logs

- `architecture-audit/cycle-010-active-runtime-lifecycle-composition/logs/t1-current-lifecycle-lines.stdout.log`
- `architecture-audit/cycle-010-active-runtime-lifecycle-composition/logs/t1-scoped-dirty-diff.stdout.log`
- `architecture-audit/cycle-010-active-runtime-lifecycle-composition/logs/t1-lifecycle-grep.stdout.log`

## Notable findings

- Runtime/server leak:
  - `src/runtime/active-runtime.ts:25` imports `ServerInstance`.
  - `src/runtime/active-runtime.ts:40`, `128-130`, and `252-254` store/expose the server instance.
  - `src/server/server.ts:117-118` passes the concrete server instance back into runtime.
- Server composition density:
  - `src/server/server.ts:60-81` handles Fastify, plugins, docs/web static serving.
  - `src/server/server.ts:82-97` handles runtime/MCP availability and startup.
  - `src/server/server.ts:98-108` handles Telegram/notification readiness.
  - `src/server/server.ts:109-110` embeds ordered shutdown.
- Lower lifecycle primitives already exist in `src/lifecycle/resource-scope.ts:29-41`; Wave 010 should use/exercise them through named server lifecycle modules rather than inventing a second disposal primitive.

## Implementation guidance for coder

- Do not touch unrelated dirty files. The repository has substantial pre-existing unrelated changes.
- Avoid broadening into web contract sharing, runtime compatibility deletion, route contract expansion, or docs-only cleanup.
- Prefer direct proposal unless review selects the context restructure.
- Add a static runtime-import boundary test so future runtime→server imports fail.
- Keep existing HTTP integration tests; add focused lifecycle tests for extracted modules rather than deleting route tests wholesale.
