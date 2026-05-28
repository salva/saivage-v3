# Cycle 031 Events Route Scope Research

## Executive summary

- Mailbox was empty except `README.md`, `done/`, and `rejected/`; no mailbox proposal was read or moved.
- `GET /api/events` is currently the last observed hand-mounted events operator route: `src/server/routes/events.ts` owns `fastify.get('/api/events')`, and `src/server/composition/route-composition.ts` imports/calls `registerEventsRoute`.
- Moving it into `ContractRuntime` is safe if behavior is preserved exactly: accept string query fields, keep current limit/offset parsing, compute `total` before pagination, return `{ events, total }`, and preserve the 500 error envelope.
- The direct proposal is recommended: add `operator-api-events.ts`, an events read-model, and `operator-events-handlers.ts`; aggregate/mount through `operatorApiContracts`; delete `src/server/routes/events.ts`; update docs verifier and `docs/operation.md` anchor.

Detailed artifacts:

- `architecture-audit/cycle-031-events-route-contract-boundary/scope-check.md`
- `architecture-audit/cycle-031-events-route-contract-boundary/proposals/proposal-direct.md`
- `architecture-audit/cycle-031-events-route-contract-boundary/proposals/proposal-restructure.md`

## Key evidence

- Current route/query/defaults: `src/server/routes/events.ts:8-30`, `src/server/routes/events.ts:42-83`.
- Current hand mount: `src/server/composition/route-composition.ts:10`, `src/server/composition/route-composition.ts:36`.
- Current contract aggregate excludes events: `src/contracts/operator-api.ts:6-11`, `src/contracts/operator-api.ts:144-151`.
- Contract runtime can validate query and response schemas: `src/server/contract-runtime.ts:111-137`, `src/server/contract-runtime.ts:178-188`, `src/server/contract-runtime.ts:214-231`.
- Docs currently anchor `GET /api/events` to old route: `docs/operation.md:280`.
- Docs verifier hard-codes contract slices and must be updated for a new events slice: `scripts/verify-doc-routes.js:48-60`.
