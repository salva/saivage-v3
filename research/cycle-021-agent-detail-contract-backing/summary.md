# Cycle 021 Research Summary — `GET /api/agents/:id` Contract Backing

## Executive summary

Mailbox pre-check found no live proposal files: only `README.md`, `done/`, and `rejected/` are present under `proposals-for-review/`.

Current code is safe to contract-back for `GET /api/agents/:id`:

- Detail behavior is already centralized in `AgentOperatorReadModelService.getSession()`.
- The remaining route is a one-line ad-hoc Fastify registration in `runtime-config-notes.ts`.
- Existing contracts cover `agents.list` and `agents.conversation`, but not `agents.detail`.
- Web code does not currently call the detail endpoint, so implementation can add a typed wrapper without UI behavior drift.

Artifacts written for review:

- `architecture-audit/cycle-021-agent-detail-contract-backing/scope-check.md`
- `architecture-audit/cycle-021-agent-detail-contract-backing/proposals/proposal-direct.md`
- `architecture-audit/cycle-021-agent-detail-contract-backing/proposals/proposal-restructure.md`

## Key evidence

- Current ad-hoc route: `src/server/routes/runtime-config-notes.ts:28`.
- Detail read-model owner: `src/application/read-models/agent-operator-read-model.ts:44`.
- Detail-only response fields: `src/application/read-models/agent-operator-read-model.ts:59`.
- Existing agent contracts: `src/contracts/operator-api.ts:215`, `src/contracts/operator-api.ts:216`, `src/contracts/operator-api.ts:251`, `src/contracts/operator-api.ts:254`, `src/contracts/operator-api.ts:509`, `src/contracts/operator-api.ts:519`.
- Web list/conversation clients only: `web/src/api/client.ts:199`, `web/src/api/client.ts:203`.
- Current detail behavior tests: `tests/server/agents-detail-route.test.ts:136`, `tests/server/agents-detail-route.test.ts:153`, `tests/server/agents-detail-route.test.ts:167`, `tests/server/agents-detail-route.test.ts:184`, `tests/server/agents-detail-route.test.ts:203`, `tests/server/agents-detail-route.test.ts:209`.

## Recommendation

Select `proposal-direct.md`: add `agents.detail`, mount through `ContractRuntime`, delete the ad-hoc detail route, update web API types/client, contract tests, focused route tests, and docs anchors. Defer broader conversation-route restructuring.
