# Wave 011 research findings — public contract sharing and web type cleanup

Date: 2026-05-27  
Task: `t1-scope-and-proposals`

## Executive summary

- The Wave 011 premise is current: backend operator contracts now cover the main web-consumed operator API payloads, while `web/src/api/types.ts` still redeclares card/runtime/agent/API/MCP types by hand.
- The existing web bridge (`web/src/api/contracts.ts`) and `web/tsconfig.json` already permit direct backend contract imports, so the smallest clean implementation is to export missing contract-derived types and alias web types to them.
- The most explicit acceptance issue remains `McpToolsResponse.tools: any[]` in `web/src/api/types.ts` and `ref<any[]>([])` in `web/src/stores/mcp.ts`.
- A broader generated/public-contract artifact is possible, but it should be selected only if review rejects direct source sharing; otherwise it adds package/generation complexity better suited to later boundary-tightening work.

## Key evidence

- Backend operator contracts define `/api/state`, cards, runtime status/card-runs, MCP status/tools, chats, files, and debug state/errors/timeline schemas in `src/contracts/operator-api.ts`.
- Backend MCP tools already have a concrete schema: `McpToolDefinitionSchema` and `McpToolsResponseSchema` in `src/contracts/operator-api.ts:181-212`.
- Web imports backend contract helpers through `web/src/api/contracts.ts:1-16`, and `web/tsconfig.json:20-27` includes `../src/contracts/**/*.ts` and `../src/schemas/**/*.ts`.
- Web still duplicates major public types in `web/src/api/types.ts`, including card types (`1-81`), runtime types (`401-507`), availability/response wrappers (`516-538`, `732-767`), and MCP (`654-684`).
- Drift is visible: backend runtime run/activation/result unions include `needs_verification`, and command source includes `analyst`; web equivalents omit these values.

## Artifacts written

- `architecture-audit/cycle-011-public-contract-sharing-web-types/scope-check.md`
- `architecture-audit/cycle-011-public-contract-sharing-web-types/proposals/proposal-direct.md`
- `architecture-audit/cycle-011-public-contract-sharing-web-types/proposals/proposal-restructure.md`

## Recommendation for reviewer/manager

Prefer `proposal-direct.md` unless direct source imports are judged unacceptable. It achieves the Wave 011 success criteria with fewer moving parts: export missing shared types, alias web API types to `OperatorApiSuccess`/schema-derived types, remove `any[]`, and update focused tests.
