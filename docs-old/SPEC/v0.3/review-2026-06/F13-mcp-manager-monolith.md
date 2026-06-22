# F13: MCP Manager Is a 626-Line Class With Distributed State

**Severity:** MEDIUM  
**Transversality:** LOCAL  
**Category:** Missing abstractions (partial)  
**Verdict:** PARTLY SOUND — monolith is real but some delegation already exists

## Summary

`McpManager` manages server lifecycle, process management, HTTP connection management, tool discovery, invocation queuing, argument validation, caching, status building, and health checking. Its state is distributed across seven Map/Set fields with no formal state model.

## Corrected Evidence

- `src/mcp/mcp-manager.ts:30-65` — Seven stateful fields: `_handles`, `_statusOverrides`, `_startedAt`, `_toolsCache`, `_argumentValidatorCache`, `_toolsCacheInitialized`, `_discoveryErrors`
- `src/mcp/mcp-manager.ts:281-356` — `invokeTool` does validation, transport dispatch, and statistics in one method
- `src/mcp/mcp-manager.ts:113-202,457-551,615-623` — Lifecycle management scattered across multiple methods

Overstatement corrected: transport work is delegated to `stdio-transport.ts` and `streamable-http-transport.ts`, status projection to `status-projection.ts`, stats to `invocation-stats.ts`, and argument validation to `mcp-argument-validator.ts`. The manager aggregates these, not re-implements them.

## Clean Architecture Approach

Introduce a per-server runtime object/state machine that owns one server's handle, status, tools, discovery errors, validator cache, and invocation queue. Keep `McpManager` as a registry/facade over server runtimes. Each server runtime has an explicit `McpServerState` discriminated union.