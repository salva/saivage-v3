# Cycle 023 Agent LLM Exchange Boundary — Research Notes

## Executive summary

Mailbox was empty except `README.md`, `done/`, and `rejected/`, so wave research proceeded without reading or moving any proposal files.

The remaining `GET /api/agents/:id/llm-exchange` route is safe to contract-back. It is currently the only adjacent agent endpoint still owned by `runtime-config-notes.ts`; agent list/detail/conversation are already behind `operatorApiContracts` and mounted by `ContractRuntime`. The LLM exchange payload already has a precise shared Zod schema (`llmExchangeSchema`) and is consumed by the web control-room client/store, but the client currently bypasses `parseOperatorResponse()` for this endpoint.

Recommended proposal: select `architecture-audit/cycle-023-agent-llm-exchange-boundary/proposals/proposal-direct.md`.

## Key evidence

- Mailbox pre-check: `/work/saivage-v3/proposals-for-review/` contained only `README.md`, `done/`, `rejected/`.
- Current route owner: `src/server/routes/runtime-config-notes.ts:26-41` registers and implements `/api/agents/:id/llm-exchange` inline.
- Persistence/schema owner: `src/contracts/llm-exchange.ts:3-44` defines the payload schema; `src/agents/llm-exchange-log.ts:18-41` reads/validates persisted exchange files.
- Adjacent contract owner: `src/server/routes/operator-contracts.ts:82-84` handles agent list/detail/conversation through contract runtime; `src/contracts/operator-api.ts:252-266` defines their schemas.
- Web consumer: `web/src/api/client.ts:212-214` calls raw request for llm-exchange; `web/src/stores/agents.ts:88` uses it and treats 404 as empty state.
- Tests: `tests/server/agents-llm-exchange-route.test.ts:44-137` covers success, 404, invalid ID, unauthenticated 401, and corrupted JSON.
- Docs: `docs/operation.md:263` currently anchors llm-exchange to `runtime-config-notes.ts:26`.

## Artifacts produced

- `architecture-audit/cycle-023-agent-llm-exchange-boundary/scope-check.md`
- `architecture-audit/cycle-023-agent-llm-exchange-boundary/proposals/proposal-direct.md`
- `architecture-audit/cycle-023-agent-llm-exchange-boundary/proposals/proposal-restructure.md`

## Implementation recommendation

Add `agents.llmExchange` to `operatorApiContracts` with success schema `{ exchange: llmExchangeSchema }`, mount it in `operator-contracts.ts`, delete the ad-hoc route from `runtime-config-notes.ts`, and update the web client to use `operatorRequest('agents.llmExchange', ...)`. Preserve wire semantics and avoid any compatibility shim or duplicate route owner.
