# Wave 009 route consolidation research findings

Date: 2026-05-27  
Task: `t1-scope-check-and-proposals`  
Scope: current on-disk code only; no discarded historical audits used.

## Executive summary

Wave 009 premises are still valid. The project already has a useful `ContractRuntime` and `operatorApiContracts`, but they only cover health/state/cards/history/diff. Runtime status/card-runs, MCP status/tools, chat, file, and debug read endpoints are still mounted inline or by hand. Wave 008 supplied read-model services for those payloads, and Wave 006 supplied the MCP facade/read model. The recommended implementation is to extend the existing contract runtime and route registrar directly, not to create a larger route-manifest framework unless review decides docs/route taxonomy must be fixed at a higher level first.

Primary artifacts:

- `architecture-audit/cycle-009-contract-backed-http-mcp-debug-routes/scope-check.md`
- `architecture-audit/cycle-009-contract-backed-http-mcp-debug-routes/proposals/proposal-direct.md`
- `architecture-audit/cycle-009-contract-backed-http-mcp-debug-routes/proposals/proposal-restructure.md`

## Key code evidence

- Current contract definitions: `src/contracts/operator-api.ts:134-155`, `src/contracts/operator-api.ts:161-250`, `src/contracts/operator-api.ts:266-280`.
- Contract runtime validation: `src/server/contract-runtime.ts:82-131`, `src/server/contract-runtime.ts:144-180`.
- Contract registrar uses Wave 008 card read model: `src/server/routes/operator-contracts.ts:13-39`.
- Inline runtime/MCP routes remain in server composition: `src/server/server.ts:53-56`, `src/server/server.ts:102-105`.
- Hand-mounted chat/file/debug routes remain: `src/server/routes/chats-files-debug.ts:74`, `:86`, `:99`, `:141`, `:154`, `:167`, `:178`, `:189`, `:200`, `:265`.
- Wave 008 read models are available: `src/application/read-models/index.ts:1-8`.
- Wave 006 MCP facade/read model is available: `src/mcp/mcp-manager.ts:224`, `src/mcp/mcp-manager.ts:605-609`, `src/mcp/status-projection.ts:30`.
- Docs verification currently combines source regex and contracts, then requires operator inventory rows: `scripts/verify-doc-routes.js:44-60`, `scripts/verify-doc-routes.js:326-334`.

## Recommended implementation notes for Coder

1. Add contracts for the Wave 009 endpoint set in `src/contracts/operator-api.ts`.
2. Mount them through `ContractRuntime` with provider functions for active runtime, server availability, and MCP manager so server startup ordering remains safe.
3. Keep read-model logic in `src/application/read-models`; do not recreate payload assembly in routes.
4. Delete the inline server route helper functions and inline MCP route registrations after contract registrars replace them.
5. Split or rename internal debug endpoints if possible so `/api/debug/doctor` and `/api/debug/supervision` are not accidentally mixed with public operator contracts.
6. Update docs route inventory anchors away from removed implementation-line anchors.

## Risks to carry into review

- Existing docs verification has unrelated drift; Wave 009 should fix only route-anchor/inventory failures attributable to moved endpoints.
- MCP/debug schemas need precision without overfitting heterogeneous diagnostic payloads.
- Chat send body validation must preserve existing 400/404 behavior from `tests/server/chats-route-workspace-context.test.ts`.
- The working tree is already dirty; implementation must stage only scoped Wave 009 files.
