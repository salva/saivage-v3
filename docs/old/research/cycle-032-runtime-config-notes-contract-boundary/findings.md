# Cycle 032 route-boundary research findings

## Executive summary

- Mailbox was empty for wave purposes: only `README.md`, `done/`, and `rejected/` were present in `proposals-for-review/`.
- `GET /api/config`, `GET /api/providers`, and `GET /api/control-actions` are currently the remaining target hand-mounted routes in `src/server/routes/runtime-config-notes.ts`.
- Contract migration is safe if implementation preserves redaction, permissive query strings, provider summary projection, and exact legacy 500 error envelopes.
- Prefer the restructure proposal if the wave should create a real read-model layer; otherwise the direct proposal is sufficient and still deletes the legacy route owner.

## Key implementation pointers

- Current route owner: `src/server/routes/runtime-config-notes.ts:7-22`.
- Current registration: `src/server/composition/route-composition.ts:30-58`.
- Contract route mounting pattern: `src/server/routes/operator-contracts.ts:90-104`, `src/server/contract-runtime.ts:231-260`.
- Events/process examples: `src/contracts/operator-api-events.ts:27-43`, `src/server/routes/operator-events-handlers.ts:1-20`, `tests/server/events-operator-contract-routes.test.ts:12-43`.
- Control-action persistence semantics: `src/persistence/control-action-audit.ts:52-70`.
- Config/provider schema optionality and secret-bearing fields: `src/agents/config-schema.ts:227-249`, `src/agents/config-schema.ts:350-360`.
- Web clients currently bypass contract parsing for these endpoints: `web/src/api/client.ts:216-226`; manual types at `web/src/api/types.ts:846-853`.

## Produced cycle artifacts

- `architecture-audit/cycle-032-runtime-config-notes-contract-boundary/scope-check.md`
- `architecture-audit/cycle-032-runtime-config-notes-contract-boundary/proposals/proposal-direct.md`
- `architecture-audit/cycle-032-runtime-config-notes-contract-boundary/proposals/proposal-restructure.md`

## Gaps/risks

- No live API probes were run in this research task; validation is for the implementation task.
- Provider response schema must not make optional server fields required, despite current web type doing so.
- `ContractRuntime` will change error behavior unless handlers catch and return declared legacy 500 bodies.
