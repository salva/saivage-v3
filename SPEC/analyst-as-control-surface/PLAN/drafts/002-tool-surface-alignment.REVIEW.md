VERDICT: APPROVED

Fifth-pass targeted review of `design.md` and `plan.md` for S02, focused on R1, R2, the required autonomy grep, and the pass-4 carry-over checks.

## Findings

None.

## Targeted Re-checks

- R1 resolved. In [plan.md](plan.md#L60), A.5d now replaces the existing `if (activeRuntime && mcpManager) { ... }` block wholesale with `if (activeRuntime && mcpManager) { activeRuntime.setMcpManager(mcpManager); }`. The `setMcpManager` call stays inside the `activeRuntime && mcpManager` guard, and the old adapter/event-logger wiring is explicitly owned by the setter.
- R1 resolved. In [plan.md](plan.md#L53), `activeRuntime.setServer(instance)` is guarded only by `if (activeRuntime)`, which is correct because `setServer` takes only the `ServerInstance`.
- R1 resolved. In [design.md](design.md#L171), the server wiring section matches the corrected plan wording: replace the old guarded block with the guarded `activeRuntime.setMcpManager(mcpManager)` call, then build `const instance: ServerInstance = { ... }`, call `if (activeRuntime) activeRuntime.setServer(instance)`, and return `instance`.
- R2 resolved. In [plan.md](plan.md#L105), D.8b uses `{ ids: { ...arr(str('Card id to delete.')), minItems: 1 } }`, not `.min(1)`.
- R2 source check passed. In [src/agents/analyst-tool-schemas.ts](../../../../../src/agents/analyst-tool-schemas.ts#L16), `arr()` returns a plain `Record<string, unknown>` JSON-schema object, so the spread form in D.8b is valid.

## Autonomy Grep

Command run from the draft scope, with absolute paths to avoid terminal cwd state:

`grep -E -in 'SPEC-r[1-6]|PROTOCOL-r[1-3]|MASTER-PLAN-r[1-6]|REVIEW-r|prior round|earlier round|previous version|previous draft|before the refactor|was superseded|older revision' design.md plan.md`

Result: zero matches. The writer-reported four matches were not reproduced with the requested command.

Literal hit list with classification:

- None. No Substantive hits and no Meta hits.

## Carry-over Checks

- Substep count remains 67.
- Host-path guard passed: no `/work/` paths were found in `design.md` or `plan.md`.
- Ledger discipline remains intact: ledger-reference grep reports only the cumulative `saivage-v3/SPEC/analyst-as-control-surface/PLAN/expected-breakage-ledger.md` path or the final guard that enforces that rule; no stage-local ledger path is introduced.
- R1 Option A, MCP lifecycle ordering, requestRestart closure, delete-card `{ ids: string[] }` contract, C2 flat partial-success shape, planner-control boundary, downstream deferrals, validation gates, and breakage-forecast ledger shape remain consistent with the pass-4 approved items.

## Finding Counts

- BLOCKER: 0
- MAJOR: 0
- NIT: 0

Single most important issue: none.VERDICT: CHANGES_REQUESTED

Fourth-pass review of `design.md` and `plan.md` for S02, against MASTER-PLAN-r7 §S02, published S00/S01 stage designs, and the requested source spot-checks.

## Findings

1. MAJOR / [plan.md](plan.md#L60), [src/server/server.ts](../../../../../src/server/server.ts#L108), [src/runtime/active-runtime.ts](../../../../../src/runtime/active-runtime.ts#L104) / The R1 MCP plumbing is now conceptually correct, but the concrete server wiring substep is not type-safe. A.5d says to add `if (activeRuntime) activeRuntime.setMcpManager(mcpManager);` after the existing `if (activeRuntime && mcpManager) { ... }` block. In current `createServer`, `mcpManager` is `McpManager | undefined`; if MCP startup fails while `activeRuntime` exists, this line passes `undefined` to a setter whose planned signature requires `McpManager`. Under strict TypeScript this should fail to compile, and at runtime it would also corrupt the new accessor path. Fix by replacing the existing guarded block with `if (activeRuntime && mcpManager) activeRuntime.setMcpManager(mcpManager);`, or by moving the setter call inside the existing `activeRuntime && mcpManager` guard. The setter can own the adapter/event-logger wiring, so duplicated old wiring is unnecessary.

2. NIT / [plan.md](plan.md#L105), [src/agents/analyst-tool-schemas.ts](../../../../../src/agents/analyst-tool-schemas.ts#L17) / D.8b uses `arr(str(...)).min(1)` for the new `delete_card` JSON schema. The current `arr()` helper returns a plain JSON-schema object, not a Zod array, so `.min(1)` is not valid code. The intended schema is sound; express it as JSON schema, e.g. `{ ...arr(str(...)), minItems: 1 }`, or extend the helper to accept `minItems`. This is small, but it is worth correcting before publication because D.8b is an exact atomic edit step.

## Checks Passed

- R1 Option A is now described concretely: `ActiveRuntime` gains `setMcpManager` / `setServer` plus `mcpManager` / `server` accessors, with no constructor signature change.
- R1 constructor call-site count is correct: `new ActiveRuntime(...)` appears only in [src/server/server.ts](../../../../../src/server/server.ts#L108) and [tests/runtime/runtime-activation-ledger.test.ts](../../../../../tests/runtime/runtime-activation-ledger.test.ts#L140).
- R1 MCP lifecycle method names exist in current source: `startServer(name)`, `stopServer(name)`, and `restartServer(name)` are present on `McpManager`.
- R1 `reloadServersFromConfig()` is a coherent addition as scoped: reloading `this.servers` after the config write is sufficient when paired with the specified per-name lifecycle calls. `mcp_add` correctly orders `mcpAdd -> reloadServersFromConfig -> startServer`; `mcp_edit` reloads before `restartServer`; `mcp_remove` stops before removing and reloading.
- R2 is resolved: the `requestRestart` closure closes over local `stop()`, appears in both `design.md` and `plan.md` A.5, is placed before the returned instance literal, is included as `requestRestart,`, and `ServerInstance` is planned to gain `requestRestart(): Promise<void>`.
- R3 is resolved at the contract level: the analyst surface chooses `{ ids: string[] }` with length >= 1; no real `{ id: string }` branch remains except references to the current pre-S02 source and the required migration note.
- R3 planner-control boundary is preserved: planner control still uses `cardId` in [src/agents/agent-adapter.ts](../../../../../src/agents/agent-adapter.ts) and [src/agents/planner-control-executor.ts](../../../../../src/agents/planner-control-executor.ts), and the draft says not to touch that surface.
- R3 test migration is correctly identified: [tests/analyst.test.ts](../../../../../tests/analyst.test.ts#L173), [tests/analyst.test.ts](../../../../../tests/analyst.test.ts#L186), and [tests/analyst.test.ts](../../../../../tests/analyst.test.ts#L199) are current `delete_card({ id: '...' })` invocations and are listed for migration.
- R3 E.7b loops over `params.ids`, expands descendants per id, applies the permission-matrix denial, and returns the canonical C2 flat shape `{ partial, total, succeeded, failures: [{ id, reason }] }`.
- Carry-over scope is still clean: no pre-emption beyond declared S03..S10 deferrals; S00 dependency paths are intact; S01 is a hard dependency and S01-deleted targets are treated as absent.
- Carry-over ledger forecast is shape-correct: five predicted H3 entries, each with the four labeled lines, target stages in S03..S10, and `Recorded by: S02 / <YYYY-MM-DD>`.
- Mechanical checks passed: forbidden-anchor grep produced no output; emoji grep produced no output; host-path guard produced no output; ledger references point only to the cumulative `expected-breakage-ledger.md` path or to the guard that forbids stage-local ledgers.
- C2 canonical shape is consistent everywhere checked; no `data.totals` payload remains except as explicit prohibition text.

## Spot-check Results

| File | Result |
| --- | --- |
| [src/runtime/active-runtime.ts](../../../../../src/runtime/active-runtime.ts) | PASS on feasibility: current class exposes no `mcpManager` / `server`, so additive setters/accessors are straightforward and constructor call sites need not change. Plan A.5d still needs the guard fix in Finding 1. |
| [src/server/server.ts](../../../../../src/server/server.ts) | PASS: `stop` is a local closure inside `createServer`, the function currently returns a literal, and the revised requestRestart snippet closes over `stop()` correctly. |
| [src/mcp/mcp-manager.ts](../../../../../src/mcp/mcp-manager.ts) | PASS: lifecycle methods exist; adding `reloadServersFromConfig()` to reassign `this.servers` is coherent when followed by the planned start/stop/restart operations. |
| [src/agents/analyst-tools.ts](../../../../../src/agents/analyst-tools.ts) | PASS: `ToolContext` already carries optional `activeRuntime`; the current analyst `delete_card` surface is single-`id` and needs exactly the planned analyst-only schema migration. |
| [tests/analyst.test.ts](../../../../../tests/analyst.test.ts) | PASS: the three cited call sites are current `{ id }` delete invocations and are correctly listed for migration to `{ ids: [...] }`. |

## Finding Counts

- BLOCKER: 0
- MAJOR: 1
- NIT: 1

Single most important issue: A.5d must guard `mcpManager` before calling `activeRuntime.setMcpManager(mcpManager)`; otherwise the revised R1 plumbing can still fail TypeScript or pass `undefined` on MCP startup failure.

Substep count verified: 67.