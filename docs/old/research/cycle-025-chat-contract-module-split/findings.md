# Cycle 025 chat contract module split — research findings

Access date: 2026-05-28. Sources are local repository files under `/work/saivage-v3`; no external web research was needed.

## Executive summary

Mailbox pre-check was empty: only `README.md`, `done/`, and `rejected/` were present in `proposals-for-review/`. A safe chat module split exists. Chat contracts and handlers are cohesive inline blocks in the central operator API files and can follow the Cycle 024 agent-slice pattern.

Artifacts produced:

- `architecture-audit/cycle-025-chat-contract-module-split/scope-check.md`
- `architecture-audit/cycle-025-chat-contract-module-split/proposals/proposal-direct.md`
- `architecture-audit/cycle-025-chat-contract-module-split/proposals/proposal-restructure.md`

## Key evidence

- Chat schemas/types are inline in `src/contracts/operator-api.ts:226-310`.
- Chat contract entries are inline in `src/contracts/operator-api.ts:447-478`.
- Chat handlers and workspace-context validation are inline in `src/server/routes/operator-contracts.ts:20-39` and `src/server/routes/operator-contracts.ts:82-103`.
- Chat read-model logic is already isolated in `src/application/read-models/chat-read-model.ts:12-34`.
- Web uses the public aggregate operation ids/imports, especially `web/src/api/client.ts:229-240` and `web/src/api/contracts.ts:1-34`.
- Contract tests assert aggregate order and chat response behavior in `tests/server/operator-api-contracts.test.ts:104-140` and `tests/server/operator-api-contracts.test.ts:291-293`.
- Docs/verifier must be updated because chat route anchors still cite `src/contracts/operator-api.ts` at `docs/operation.md:272-274`, while `scripts/verify-doc-routes.js:19` and `scripts/verify-doc-routes.js:49` currently scan only central + agent contract files.

## Recommendation

Select `proposal-direct.md`: create `operator-api-chats.ts` and `operator-chat-handlers.ts`, then aggregate/spread/re-export from the central modules. Do not select the broader restructuring proposal yet; it risks premature application-service design beyond the bounded cycle objective.
