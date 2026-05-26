# mailbox-002 D-operator-only-flags — research findings

Checked against current source on 2026-05-26. This is a mailbox-cycle scope/proposal task; no source implementation was performed.

## Executive summary

`D-operator-only-flags.md` contains four deferred residuals. Current-code review shows only one is both live and small enough for a coherent mailbox cycle: **Analyst `list_cards` scalar-or-array filters**.

The runtime implementation already accepts scalar or array filters for `status` and `type` in `src/agents/analyst-tools.ts:106`, and the planner/internal Zod tool input also accepts either shape in `src/tools/agent-tools.ts:104`. The analyst-facing LLM JSON tool schema is the drift point: `src/agents/analyst-tool-schemas.ts:27` advertises only scalar enum fields. The bounded proposal is therefore to make the analyst tool schema truthfully expose `oneOf`/`anyOf` scalar-or-array filter shapes and add tests.

## Residual-by-residual scope check

| Residual | Current-code status | Recommendation |
| --- | --- | --- |
| Audit-artifact manifest / status boundary | Proposal points to old architecture-audit history. Current mission says old audit history is discarded and must not be mined for direction. No current-code requirement was established in this task. | Reject/defer for this mailbox cycle unless re-filed as a current-code proposal with explicit desired artifact contract. |
| Analyst `list_cards` scalar-or-array filters | Live current-code mismatch: implementation accepts scalar/array (`src/agents/analyst-tools.ts:106`); internal Zod accepts scalar/array (`src/tools/agent-tools.ts:104`); analyst LLM schema advertises scalar only (`src/agents/analyst-tool-schemas.ts:27`). | Select for mailbox-002. |
| CI24 error-logger fixture follow-up | Current tests already include broad ErrorLogger behavior and redaction coverage (`tests/utils/error-logger.test.ts`, `tests/utils/redaction-port.test.ts`). Additional permutations could be useful but are fixture-only and less central than a live tool-contract mismatch. | Defer. |
| CardStore health remote-clear / diagnostic endpoint | Current `CardStore` source has no `getAndClearWarnings` symbol and grep found no CardStore warning API; only config warnings are exposed at `src/server/routes/runtime-config-notes.ts:111`. The mailbox premise appears stale against current code. | Reject/defer for this cycle; do not add an endpoint for a nonexistent domain API. |

## Key evidence

- `src/agents/analyst-tools.ts:106` — `list_cards` TypeScript params and runtime code normalize `status` and `type` with `Array.isArray(...) ? ... : [...]`.
- `src/tools/agent-tools.ts:104` — planner/internal tool input uses `z.union([cardStatusSchema, z.array(cardStatusSchema)])` and equivalent for `type`.
- `src/agents/analyst-tool-schemas.ts:27` — analyst LLM JSON schema exposes `status` and `type` through `strEnum(...)`, so the model sees only scalar enum values.
- `src/cards/card-store.ts:1-80` plus grep for `getAndClearWarnings` — no CardStore warning/clear API exists in current source.
- `src/server/routes/runtime-config-notes.ts:111` — `/api/config` returns configuration warnings only; it is not a CardStore warning endpoint.
- `src/observability/error-logger.ts:92-105` — `appendError` redacts through `redactForOutbound` before emitting/persisting.
- `src/observability/error-logger.ts:112-150` — `getErrors` supports filtering and limit behavior already covered by existing tests.

## Artifacts written

- `architecture-audit/mailbox-002-d-operator-only-flags/scope-check.md`
- `architecture-audit/mailbox-002-d-operator-only-flags/proposals/proposal-direct.md`
- `architecture-audit/mailbox-002-d-operator-only-flags/proposals/proposal-restructure.md`
