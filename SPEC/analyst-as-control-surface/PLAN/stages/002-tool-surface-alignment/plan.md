# Stage 002 — Tool Surface Alignment — Plan

## Pre-conditions

- `saivage-v3/SPEC/analyst-as-control-surface/PLAN/stages/000-breakage-detection-harness/` is published and immutable.
- `saivage-v3/SPEC/analyst-as-control-surface/PLAN/stages/001-real-llm-analyst-resolver/` is published and immutable. Open S01 ledger entries that name `S02` as the target fix stage live as H3 blocks under `## Open entries` in `saivage-v3/SPEC/analyst-as-control-surface/PLAN/expected-breakage-ledger.md` (the single cumulative, mutable ledger outside any stage directory) and are S02's to repair (delete the H3 block at close-out) or carry forward (leave the H3 block untouched).
- `saivage-v3/SPEC/analyst-as-control-surface/PLAN/baseline-gates.json` exists and is read-only for S02.
- `saivage-v3/SPEC/analyst-as-control-surface/PLAN/VALIDATION-COOKBOOK.md` is the source of truth for every gate command; do not paraphrase.
- `saivage-v3/SPEC/analyst-as-control-surface/PLAN/scripts/run-gates.sh` runs cleanly on the host (verify with `--help`).
- Node and npm versions match `saivage-v3/package.json` engines (`node >=22.12.0`, `npm >=10`).
- `saivage-v3/node_modules/`, `saivage-v3/web/node_modules/`, and `saivage-e2e-checkers/node_modules/` are populated.
- `npx --prefix saivage-e2e-checkers playwright install --with-deps chromium` has been run on this host.
- `tmp/` inside the workspace exists and is writable.
- `jq` is on `PATH`.
- `getAnalystToolDefinitions()` and `getAnalystSystemPrompt()` are exported from `saivage-v3/src/agents/analyst-llm-resolver.ts` (S01 contract).
- `AnalystOfflineError` and `ANALYST_OFFLINE_REPLY` are exported from `saivage-v3/src/agents/analyst-llm-resolver.ts` (S01 contract).
- The private `parseIntent`, `runOfflineFallback`, `HELP_TEXT`, `lastIntent`, and `deterministicIntent` are NOT present in `saivage-v3/src/agents/analyst-handler.ts` (S01 deletion).

## Step-by-step implementation

Each phase is a sequence of atomic substeps. Each substep is either one file edit or one shell command. No prose between substeps. Apply substeps in the listed order within each phase; phases must be applied in order A through H.

### Phase A — Extract the audit wrapper and the secret classifier into shared modules

- **A.1** — Create `saivage-v3/src/agents/analyst-secret-classifier.ts` exporting `assertAnalystInspectionTarget(absolutePath: string): void` that wraps `assertNotSecretPath` from `saivage-v3/src/workspace/secret-paths.ts` and rethrows `SecretPathError` with the literal message `"Access denied: secret-bearing path is off-limits."`.
- **A.2** — Create `saivage-v3/src/agents/analyst-tool-runner.ts` exporting `runAuditedAnalystTool` (moved verbatim from the private `runMutatingTool` in `analyst-tools.ts`), `PendingDestructiveStore`, the `CONFIRMATION_TTL_MS = 300_000` constant, and the four response-shape template builders `ANALYST_UNSUPPORTED_ACTION_TEMPLATE(capabilityClass?, toolNames?)`, `ANALYST_PARTIAL_SUCCESS_TEMPLATE(succeeded, total, failedIds, reasons)`, `ANALYST_UNKNOWN_CAPABILITY_TEMPLATE(proposedToolName)`, `ANALYST_DESTRUCTIVE_PREVIEW_TEMPLATE(actionVerb, targetDescription, n, ids)`.
- **A.3** — Create `saivage-v3/src/agents/analyst-config-writer.ts` exporting `setRoleRouting`, `setFailoverOrder`, `mcpAdd`, `mcpEdit`, `mcpRemove`, `setRuntimeSetting`, `setServerSetting`, `getRedactedConfig`, and the `ConfigWriteResult` type per design.md §"Config persistence module". Every setter reads `<projectRoot>/.saivage/saivage.json` as raw text, parses it with `JSON.parse`, applies the patch on the parsed object, re-validates with `saivageConfigSchema.safeParse(...)` from `./config-schema.js`, and on success writes via `writeFileAtomic` from `../persistence/index.js`. On a Zod failure return `{ success: false, fieldPath: <JSON-pointer-style string>, message: <zod issue message> }`. Each setter takes a per-projectRoot promise lock around the read-modify-write window.
- **A.4** — Edit `saivage-v3/src/runtime/runtime.ts`: extend the `source` parameter union on `Runtime.startProject` (line 545) and `Runtime.stopProject` (line 587) from `'operator' | 'tool' | 'runtime'` to `'operator' | 'tool' | 'runtime' | 'analyst'`. The default value stays `'operator'`. Edit `saivage-v3/src/runtime/state.ts`: extend the `source` parameter union on `appendRuntimeCommand` (line 168) the same way. No call site needs to change because there is no exhaustive `switch` on this union (verify with `grep -nE "source.*===.*'(operator|tool|runtime)'" saivage-v3/src/runtime/`).
- **A.5** — Edit `saivage-v3/src/server/server.ts`: extend the `ServerInstance` interface to include `requestRestart(): Promise<void>`. In `createServer`, insert the following closure immediately before the `return { fastify, ... }` statement, where `stop` is the local `async function stop(): Promise<void>` already declared higher in the function body:

  ```ts
  const requestRestart = async (): Promise<void> => {
    setImmediate(async () => {
      try { await stop(); } finally { process.exit(75); }
    });
  };
  ```

  Then restructure the return statement to first build the instance into a `const`:

  ```ts
  const instance: ServerInstance = {
    fastify,
    config,
    saivageConfig,
    scope,
    mcpManager,
    telegramBot,
    activeRuntime,
    stop,
    requestRestart,
  };
  if (activeRuntime) activeRuntime.setServer(instance);
  return instance;
  ```

  (Exit code 75 = `EX_TEMPFAIL`; systemd's `Restart=on-failure` triggers the supervisor restart. `setImmediate` defers the shutdown to the next event-loop iteration so the analyst tool's HTTP response and the audit-log write flush first. The existing SIGTERM handler in `boot/app.ts` that calls `process.exit(0)` must NOT be reused for restarts because exit 0 does not satisfy `Restart=on-failure`.)
- **A.5b** — Edit `saivage-v3/src/mcp/mcp-manager.ts`: add a new public method `reloadServersFromConfig(): void` that re-runs `loadConfig(this.projectRoot)`, re-runs `normalizeMcpServers(config)`, and reassigns `this.servers = normalizeMcpServers(config)`. Do NOT touch `this.handles`, `this.toolsCache`, `this.discoveryErrors`, or `this._invocationQueues` (these are keyed by name and remain managed by the per-name lifecycle methods). This is the single new primitive the three `reconfigure` MCP sub-actions depend on; the existing methods `startServer(name)` (line 610), `stopServer(name)` (line 663), and `restartServer(name)` (line 713) are unchanged.
- **A.5c** — Edit `saivage-v3/src/runtime/active-runtime.ts`: add a private field `_mcpManager?: McpManager` and a private field `_server?: ServerInstance` (the latter imported as a type-only import from `../server/server.js`). Add a public method `setMcpManager(mcpManager: McpManager): void` that assigns `this._mcpManager = mcpManager`, calls `this._agentAdapter.setMcpManager(mcpManager)`, and calls `mcpManager.setEventLogger(this._eventLogger)`. Add a public method `setServer(server: ServerInstance): void` that assigns `this._server = server`. Add public getters `get mcpManager(): McpManager | undefined { return this._mcpManager; }` and `get server(): ServerInstance | undefined { return this._server; }`. Rewrite the existing constructor-time wiring so that the optional `mcpManager` constructor parameter, when present, is forwarded through `this.setMcpManager(mcpManager)` (so the two existing construction call sites — `src/server/server.ts:108` and `tests/runtime/runtime-activation-ledger.test.ts:140` — keep working without signature change; the latter does not pass an MCP manager and is unaffected).
- **A.5d** — Edit `saivage-v3/src/server/server.ts` `createServer`: replace the existing block `if (activeRuntime && mcpManager) { activeRuntime.agentAdapter.setMcpManager(mcpManager); mcpManager.setEventLogger(activeRuntime.eventLogger); }` (line 111) with `if (activeRuntime && mcpManager) { activeRuntime.setMcpManager(mcpManager); }` so the new `ActiveRuntime.mcpManager` accessor introduced in A.5c is populated for the lifetime of the server. The `setMcpManager` call MUST live inside the same `activeRuntime && mcpManager` guard because `mcpManager` is typed `McpManager | undefined` and the setter signature requires a defined `McpManager`; the new setter already performs the `agentAdapter.setMcpManager(mcpManager)` and `mcpManager.setEventLogger(this._eventLogger)` wiring internally (per A.5c), so the prior two-statement body is replaced wholesale with no behavior loss. (The `activeRuntime.setServer(instance)` call is performed in A.5 inside an `if (activeRuntime)` guard only — that setter does not need the `mcpManager` guard because it takes only the `ServerInstance`.)
- **A.6** — Edit `saivage-v3/src/agents/analyst-tools.ts`: delete the private `runMutatingTool`; replace every call site with `runAuditedAnalystTool` imported from `./analyst-tool-runner.js`.
- **A.7** — Edit `saivage-v3/src/agents/analyst-tools.ts`: replace every direct call to `assertNotSecretPath` and `looksLikeSecretPath` in `read_file`, `list_directory`, `run_shell_command`, `read_runtime_events`, `read_runtime_errors`, `read_control_actions`, `read_agent_session` with a call to `assertAnalystInspectionTarget` imported from `./analyst-secret-classifier.js`.
- **A.8** — Run `( cd saivage-v3 && npx tsc -p . )`; expect exit 0. If non-zero, fix and re-run before moving to Phase B.

### Phase B — Retire v2 note-inbox tools from the analyst surface

- **B.1** — Edit `saivage-v3/src/agents/analyst-tools.ts`: delete the `export async function add_note`, `export async function list_notes`, `export async function get_note`, `export async function mark_note_handled` definitions.
- **B.2** — Edit `saivage-v3/src/agents/analyst-tool-schemas.ts`: delete the `tool('add_note', ...)`, `tool('list_notes', ...)`, `tool('get_note', ...)`, `tool('mark_note_handled', ...)` entries from `ANALYST_TOOL_DEFINITIONS`.
- **B.3** — Edit `saivage-v3/src/agents/analyst-llm-resolver.ts`: remove `add_note`, `list_notes`, `get_note`, `mark_note_handled` from the import list and from `TOOL_REGISTRY`.
- **B.4** — Edit `saivage-v3/src/agents/role-tool-policy.ts`: remove `list_notes`, `get_note`, `mark_note_handled` from `ROLE_TOOL_NAMES.analyst`.
- **B.5** — Edit `saivage-v3/src/tools/agent-tools.ts`: remove the `tool({ name: 'add_note', ... })`, `tool({ name: 'list_notes', ... })`, `tool({ name: 'get_note', ... })`, `tool({ name: 'mark_note_handled', ... })` entries from `AGENT_TOOL_DEFINITIONS`.
- **B.6** — Run `( cd saivage-v3 && npx tsc -p . )`; expect exit 0.

### Phase C — Add the SPEC-r7 runtime-control tools

- **C.1** — Edit `saivage-v3/src/agents/analyst-tools.ts`: add `export async function start_project(ctx, _params: Record<string, never> = {})` that calls `ctx.activeRuntime.runtime.startProject('analyst')` through `runAuditedAnalystTool` with `action: 'runtime.start_project'`, `safety_class: 'low'`, `target_kind: 'runtime'`, `target_id: () => 'project'`. (The `'analyst'` source value was added to `RuntimeCommandSource` in A.4.)
- **C.2** — Edit `saivage-v3/src/agents/analyst-tools.ts`: add `export async function stop_project(ctx, _params: Record<string, never> = {})` analogous to C.1 with `safety_class: 'destructive'`.
- **C.3** — Edit `saivage-v3/src/agents/analyst-tools.ts`: add `export async function terminate_process(ctx, params: { processId: string })` that calls `killProcess(ctx.projectRoot, params.processId, 'SIGTERM')` through `runAuditedAnalystTool` with `action: 'process.terminate'`, `safety_class: 'destructive'`, `target_kind: 'process'`.
- **C.4** — Edit `saivage-v3/src/agents/analyst-tools.ts`: rename `abort_goal` to `abort_goal_subtree` and `restart_card` to `restart_card_or_subtree`; keep `restart_goal` as an internal helper called by `restart_card_or_subtree` when the target id resolves to a `goal`-type card.
- **C.5** — Edit `saivage-v3/src/agents/analyst-tool-schemas.ts`: add `tool('start_project', ...)`, `tool('stop_project', ...)`, `tool('terminate_process', ...)`, `tool('abort_goal_subtree', ...)`, `tool('restart_card_or_subtree', ...)` entries; remove the now-renamed `abort_goal` and `restart_card`.
- **C.6** — Edit `saivage-v3/src/agents/analyst-llm-resolver.ts`: update the imports and `TOOL_REGISTRY` to match C.1-C.5.
- **C.7** — Run `( cd saivage-v3 && npx tsc -p . )`; expect exit 0.

### Phase D — Add the SPEC-r7 capability-class tool surfaces

- **D.1** — Edit `saivage-v3/src/agents/analyst-tools.ts`: add `export async function queue_notification(ctx, params: { recipient: string; kind: string; body: string })` returning `{ success: false, data: { reason: 'not_yet_available', stage_owner: 'S04', recipient: params.recipient } }`. (Single-recipient per SPEC-r7 §"Queue notifications to agent sessions"; partial-success contract C2 does not apply here.)
- **D.2** — Edit `saivage-v3/src/agents/analyst-tools.ts`: add `export async function reorder_child(ctx, params: { parentId: string; orderedChildIds: string[] })` returning `{ success: false, data: { reason: 'not_yet_available', stage_owner: 'S03', parent_id: params.parentId } }`.
- **D.3** — Edit `saivage-v3/src/agents/analyst-tools.ts`: add `export async function navigate_workspace(ctx, params: { target: { kind: 'card' | 'transcript' | 'process' | 'plan_diary' | 'process_list' | 'agent_session_list' | 'config'; id?: string; refinement?: string } })` returning `{ success: true, data: { navigated_to: params.target } }`.
- **D.4** — Edit `saivage-v3/src/agents/analyst-tools.ts`: add `export async function navigate_back(ctx, _params: Record<string, never> = {})` returning `{ success: true, data: { navigated_back: true } }` — the back-stack itself lives in S08; S02 only emits the audit entry.
- **D.5** — Edit `saivage-v3/src/agents/analyst-tools.ts`: add `export async function show_config(ctx, _params: Record<string, never> = {})` that reads the project config under `ctx.projectRoot/.saivage/` (planner-config, mcp-config, server-config), redacts every value whose key OR whose containing path component matches `isSecretLikeKey`/`looksLikeSecretPath` from `analyst-secret-classifier.ts`, and returns `{ success: true, data: { config: <REDACTED> } }`. Routed through `assertAnalystInspectionTarget` for every file path it reads.
- **D.6** — Edit `saivage-v3/src/agents/analyst-tools.ts`: add `export async function restart_server(ctx, _params: Record<string, never> = {})` calling `ctx.activeRuntime.server!.requestRestart()` (the new primitive added in A.5 and the new accessor added in A.5c) through `runAuditedAnalystTool` with `action: 'runtime.restart_server'`, `safety_class: 'destructive'`, `target_kind: 'server'`, `target_id: () => 'server'`. (Participates in contract C4 via `safety_class: 'destructive'`.)
- **D.7** — Edit `saivage-v3/src/agents/analyst-tools.ts`: add `export async function reconfigure(ctx, params: { action: 'set_role_routing' | 'set_failover_order' | 'mcp_add' | 'mcp_edit' | 'mcp_remove' | 'set_runtime_setting' | 'set_server_setting'; role?: string; model_candidate?: string; ordered_providers?: string[]; name?: string; command?: string; args?: string[]; env?: Record<string, string>; key?: string; value?: unknown })` as a single discriminated tool. The function dispatches on `params.action` to the matching setter in the `analyst-config-writer.ts` module created in A.3:
  - `set_role_routing` -> `setRoleRouting(ctx.projectRoot, params.role!, params.model_candidate!)`
  - `set_failover_order` -> `setFailoverOrder(ctx.projectRoot, params.role!, params.ordered_providers!)`
  - `mcp_add` -> see substep D.7a
  - `mcp_edit` -> see substep D.7b
  - `mcp_remove` -> see substep D.7c
  - `set_runtime_setting` -> `setRuntimeSetting(ctx.projectRoot, params.key!, params.value)`
  - `set_server_setting` -> `setServerSetting(ctx.projectRoot, params.key!, params.value)`; if the setter's result includes `requires_restart: true`, the tool result is `{ success: true, data: { applied: true, requires_restart: true, key: params.key } }` so the resolver can prompt the user to confirm a `restart_server` call.
  - On any setter returning `{ success: false, fieldPath, message }`, the tool returns `{ success: false, data: { reason: 'invalid_argument', fieldPath, detail: message } }` (contract C1). There is NO `not_yet_available` branch in `reconfigure`. Every sub-action is wrapped in `runAuditedAnalystTool` with `safety_class: 'low'` (non-destructive) and the appropriate `action`/`target_kind`/`target_id` per sub-action.
- **D.7a** — Inside the `reconfigure` body added in D.7, implement the `mcp_add` branch as: `const writeResult = await mcpAdd(ctx.projectRoot, params.name!, params.command!, params.args, params.env);` then on `writeResult.success === true` call `ctx.activeRuntime.mcpManager!.reloadServersFromConfig()` (the synchronous primitive added in A.5b that re-reads the on-disk config into the in-memory `this.servers` map) and then `await ctx.activeRuntime.mcpManager!.startServer(params.name!)` (the existing method at `src/mcp/mcp-manager.ts` line 610). The audit entry's `action` field is the literal `'reconfigure.mcp_add'`; `target_kind` is `'mcp_server'`; `target_id` is `() => params.name!`.
- **D.7b** — Inside the `reconfigure` body added in D.7, implement the `mcp_edit` branch as: `const writeResult = await mcpEdit(ctx.projectRoot, params.name!, { command: params.command, args: params.args, env: params.env });` then on `writeResult.success === true` call `ctx.activeRuntime.mcpManager!.reloadServersFromConfig()` (so the edited command/args/env in `this.servers[name]` reflect what was just written to disk) and then `await ctx.activeRuntime.mcpManager!.restartServer(params.name!)` (the existing stop-then-start method at `src/mcp/mcp-manager.ts` line 713 that reads the now-refreshed `this.servers[name]`). The audit entry's `action` field is the literal `'reconfigure.mcp_edit'`; `target_kind` is `'mcp_server'`; `target_id` is `() => params.name!`.
- **D.7c** — Inside the `reconfigure` body added in D.7, implement the `mcp_remove` branch as: `await ctx.activeRuntime.mcpManager!.stopServer(params.name!)` first (the existing method at `src/mcp/mcp-manager.ts` line 663, idempotent if the server is not running), then `const writeResult = await mcpRemove(ctx.projectRoot, params.name!);` and on `writeResult.success === true` call `ctx.activeRuntime.mcpManager!.reloadServersFromConfig()` so the removed entry is dropped from the in-memory `this.servers` map and no longer reported by `getStatus()`. The audit entry's `action` field is the literal `'reconfigure.mcp_remove'`; `target_kind` is `'mcp_server'`; `target_id` is `() => params.name!`.
- **D.8** — Edit `saivage-v3/src/agents/analyst-tool-schemas.ts`: add `tool('queue_notification', ...)`, `tool('reorder_child', ...)`, `tool('navigate_workspace', ...)`, `tool('navigate_back', ...)`, `tool('show_config', ...)`, `tool('restart_server', ...)`, `tool('reconfigure', ...)` entries. The `reconfigure` schema uses a discriminated `oneOf` on `action` with per-action property requirements.
- **D.8b** — Edit `saivage-v3/src/agents/analyst-tool-schemas.ts`: replace the existing `delete_card` schema entry (currently `tool('delete_card', { id: str(...) })` with `id` required) with `tool('delete_card', 'Delete one or more cards (and all their descendants) in a single call.', { ids: { ...arr(str('Card id to delete.')), minItems: 1 } }, ['ids'])` (single required `ids` field, `string[]` with `minItems: 1`; the `arr()` helper at `src/agents/analyst-tool-schemas.ts` line ~17 returns a plain JSON Schema object, so `minItems` is spread onto the returned object rather than chained as a Zod method). The deletion of a single card is now expressed as `delete_card({ ids: ['<id>'] })`. (S02-owned. The planner-control `delete_card` surface at `src/agents/agent-adapter.ts` and `src/agents/planner-control-executor.ts`, which uses the field name `cardId` instead of `id`, is a separate schema on a separate surface and is NOT touched by this substep.)
- **D.9** — Edit `saivage-v3/src/agents/analyst-llm-resolver.ts`: update imports and `TOOL_REGISTRY` to include the seven new tools from D.1-D.7.
- **D.10** — Edit `saivage-v3/src/agents/role-tool-policy.ts`: update `ROLE_TOOL_NAMES.analyst` to equal the sorted union of analyst-registry keys (use a literal sorted array, do not compute at runtime).
- **D.11** — Edit `saivage-v3/src/tools/agent-tools.ts`: add `tool({ name: 'queue_notification', ... })`, `tool({ name: 'reorder_child', ... })`, `tool({ name: 'navigate_workspace', ... })`, `tool({ name: 'navigate_back', ... })`, `tool({ name: 'show_config', ... })`, `tool({ name: 'restart_server', ... })`, `tool({ name: 'reconfigure', ... })`, `tool({ name: 'start_project', ... })`, `tool({ name: 'stop_project', ... })`, `tool({ name: 'terminate_process', ... })`, `tool({ name: 'abort_goal_subtree', ... })`, `tool({ name: 'restart_card_or_subtree', ... })` entries with appropriate `roles` arrays.
- **D.12** — Run `( cd saivage-v3 && npx tsc -p . )`; expect exit 0.

### Phase E — Wire the four response-shape contracts into the handler and the resolver

- **E.1** — Edit `saivage-v3/src/agents/analyst-handler.ts`: in the tool-dispatch loop where `result = { success: false, error: 'Unknown tool: ' + tc.function.name }`, replace the string with `ANALYST_UNKNOWN_CAPABILITY_TEMPLATE(tc.function.name)` imported from `./analyst-tool-runner.js`.
- **E.2** — Edit `saivage-v3/src/agents/analyst-handler.ts`: in `buildResponse`, add a branch `if (result.success && typeof result.data === 'object' && result.data !== null && (result.data as Record<string, unknown>)['partial'] === true) return ANALYST_PARTIAL_SUCCESS_TEMPLATE(...)` using the `succeeded`, `total`, `failures` fields on `result.data`.
- **E.3** — Edit `saivage-v3/src/agents/analyst-handler.ts`: add a `PendingDestructiveStore` field, initialized from `analyst-tool-runner.ts`, and a pre-dispatch hook that for `safety_class === 'destructive'` tools intercepts the first turn to emit `ANALYST_DESTRUCTIVE_PREVIEW_TEMPLATE` and stores `PendingDestructiveInvocation { sessionId, tool, params, createdAt }`.
- **E.4** — Edit `saivage-v3/src/agents/analyst-handler.ts`: in `handleMessageSerial`, before LLM dispatch, prune any pending invocation older than `CONFIRMATION_TTL_MS` (recording one audit entry with `outcome: 'expired'` per pruned entry, then emitting the literal stale-affirmation template ONLY if the triggering user message matches the Affirmation set). Then check the trimmed-lowercase user message against the Affirmation set `{"yes","y","confirm","proceed","do it","ok"}` and the Cancellation set `{"no","n","cancel","stop","abort","never mind"}`: on Affirmation with a non-stale pending invocation, execute it through `runAuditedAnalystTool` and emit the literal `"Confirmed. <ACTION-VERB> applied to <N> item(s): <COMMA-SEPARATED-IDS>."` reply; on Cancellation with a non-stale pending invocation, discard, record one audit entry with `outcome: 'cancelled'`, and emit the literal `"Cancelled. No changes were made."` reply; otherwise treat as Amendment (record one audit entry with `outcome: 'amended'` referencing the prior tool name, discard the pending invocation, dispatch normally), recognizing that the new tool may itself be destructive and re-enter contract C4.
- **E.5** — Edit `saivage-v3/src/agents/analyst-handler.ts`: when consulting `PendingDestructiveStore`, drop any entry whose `Date.now() - createdAt > CONFIRMATION_TTL_MS`.
- **E.6** — Edit `saivage-v3/src/agents/analyst-llm-resolver.ts`: before returning a tool call from `LlmIntentResolver.chat`, consult `RoleToolPolicy.assertAnalystSurfaceTool(toolName, surface)`; on deny, return a synthetic `assistant` message with the `ANALYST_UNSUPPORTED_ACTION_TEMPLATE` string and no `toolCalls`.
- **E.7** — Edit the fan-out tools `delete_card`, `restart_card_or_subtree`, `reorder_child`, `create_card`, `reconfigure` in `saivage-v3/src/agents/analyst-tools.ts` to return `{ success: true, data: { partial: true, total, succeeded, failures: [{ id, reason }] } }` (flat fields; NO nested `totals` object) when any sub-target fails AND at least one sub-target succeeds. Field names are exactly `partial`, `total`, `succeeded`, `failures`; each failure entry uses exactly `id` and `reason`. (Single-recipient `queue_notification` is intentionally excluded — partial-success does not apply.)
- **E.7b** — Edit `saivage-v3/src/agents/analyst-tools.ts`: replace the existing `export async function delete_card(ctx: ToolContext, params: { id: string })` (line 122) with `export async function delete_card(ctx: ToolContext, params: { ids: string[] })`. The new body iterates over `params.ids`, and for each id (a) expands `[id, ...store.getDescendantIds(id)]` for the destructive-confirmation preview that contract C4 will surface on the first turn, (b) applies the existing permission-matrix denial check, (c) on confirmation, deletes the card and its descendants and writes one audit entry per top-level id (with the full descendant list captured in the audit entry's `targets` field). The whole loop is wrapped in a single `runAuditedAnalystTool` invocation with `safety_class: 'destructive'`, `target_kind: 'card'`, and `target_id: () => params.ids.join(',')` so contract C4's destructive preview enumerates every id in one prompt and the affirmation reply applies to the whole set. Partial-success contract C2 fan-out per E.7 still applies: if at least one id deletes and at least one is denied, return `{ success: true, data: { partial: true, total: params.ids.length, succeeded, failures: [{ id, reason }] } }`. The destructive-preview template `ANALYST_DESTRUCTIVE_PREVIEW_TEMPLATE` is invoked once with `n = params.ids.length` and `ids = params.ids`.
- **E.8** — Run `( cd saivage-v3 && npx tsc -p . )`; expect exit 0.

### Phase F — Update the analyst system prompt

- **F.1** — Edit `saivage-v3/src/agents/analyst-llm-resolver.ts`: rewrite `ANALYST_SYSTEM_PROMPT` to begin with a list of the seven SPEC-r7 capability classes (Inspect; Navigate the workspace area; Mutate cards; Queue notifications; Control the runtime; Reconfigure; Investigate and repair), each followed by its registered tool names from `getAnalystToolDefinitions()` expanded via a `<TOOL_LIST>` placeholder.
- **F.2** — Edit `saivage-v3/src/agents/analyst-llm-resolver.ts`: append to `ANALYST_SYSTEM_PROMPT` a "Response shapes" section that documents contracts C1, C2, C3, C4 with their literal templates so the LLM never paraphrases them.
- **F.3** — Edit `saivage-v3/src/agents/analyst-llm-resolver.ts`: append a "Safety" section that mandates `assertAnalystInspectionTarget` semantics in plain language (no secret-bearing paths, no executor/planner workload, no out-of-band confirmation fields).
- **F.4** — Run `( cd saivage-v3 && npx tsc -p . )`; expect exit 0.

### Phase G — Add and adapt tests

- **G.1** — Create `saivage-v3/tests/agents/analyst-tool-surface.test.ts` containing the five `describe` blocks listed in design.md §"Test design". The Contract C2 test seeds a card subtree with three cards, calls `delete_card({ ids: ['code-1', 'code-2', 'code-3'] })` where `code-2` has an open running process (deny by permission matrix) and `code-1`, `code-3` are deletable, and asserts `success === true`, `data.partial === true`, `data.total === 3`, `data.succeeded === 2`, `data.failures` deep-equals `[{ id: 'code-2', reason: <permission-matrix message> }]`, and the response text matches the literal C2 template (no `data.totals` nesting anywhere). Use the public transport-mock seam established by S01 (`tests/agents/analyst-llm-resolver.integration.test.ts`): stub `globalThis.fetch` to return a chat-completion response containing the desired `tool_calls` array. Do NOT add a new constructor parameter to `AnalystHandler` and do NOT inject a fake `LlmIntentResolver`; S01 explicitly chose Option A ("no constructor signature changes on `AnalystHandler` or on `getAnalystHandler`") and S02 must not break that contract.
- **G.2** — Create `saivage-v3/tests/agents/analyst-tool-runner.test.ts` covering audit-entry shape and secret-classifier denials. These tests call `runAuditedAnalystTool` directly with a synthesized `ToolContext`; no LLM is involved.
- **G.3** — Edit `saivage-v3/tests/agents/role-tool-policy.test.ts`: add an assertion `expect(RoleToolPolicy.listToolNamesForRole('analyst').sort()).toEqual(Object.keys(TOOL_REGISTRY).sort())` and add the `assertAnalystSurfaceTool('run_shell_command', 'telegram')` deny case.
- **G.4** — Edit `saivage-v3/tests/analyst.test.ts`: delete any test case that asserts on `add_note`, `list_notes`, `get_note`, or `mark_note_handled` through the analyst surface; replace with equivalents that go through `queue_notification` where the test intent is queuing planner work. In the same commit, update every existing `delete_card` call site in this file (currently 3 call sites at lines 173, 186, 199 invoking `delete_card({ id: 'goal-1' })`) to the new schema shape `delete_card({ ids: ['goal-1'] })`.
- **G.4b** — Edit `saivage-v3/tests/agents/analyst-tool-surface.test.ts` (created in G.1): add three new `it` blocks that exercise the live `McpManager` state after each `reconfigure` MCP sub-action. (a) After `reconfigure({ action: 'mcp_add', name: 'test-server', command: '/bin/true', args: [] })`, assert `ctx.activeRuntime.mcpManager!.getStatus().some(s => s.name === 'test-server') === true`. (b) After `reconfigure({ action: 'mcp_edit', name: 'test-server', command: '/bin/false', args: [] })`, assert that the on-disk `.saivage/saivage.json` has the new command AND that `ctx.activeRuntime.mcpManager!.getStatus().find(s => s.name === 'test-server')` reflects the restart cycle (status transitions through stopping then starting). (c) After `reconfigure({ action: 'mcp_remove', name: 'test-server' })`, assert `ctx.activeRuntime.mcpManager!.getStatus().some(s => s.name === 'test-server') === false`. Construct the test `ActiveRuntime` with a real `McpManager(projectRoot)` and wire `activeRuntime.setMcpManager(mcpManager)` so the new A.5c accessor is populated.
- **G.5** — Run `( cd saivage-v3 && npx jest tests/agents/analyst-tool-surface.test.ts tests/agents/analyst-tool-runner.test.ts tests/agents/role-tool-policy.test.ts tests/analyst.test.ts )`; expect exit 0.

### Phase H — Verify the autonomy boundary on the published source

- **H.1** — Run the writer's standing autonomy-boundary grep (the regex set defined by the writer's operating rules; never embed the regex inside any drafted file, since the regex literally contains the forbidden tokens) against `saivage-v3/SPEC/analyst-as-control-surface/PLAN/drafts/002-tool-surface-alignment/`; expect zero matches across `design.md` and `plan.md`. (S02 does NOT create a stage-local `ledger.md`; the cumulative `expected-breakage-ledger.md` outside the draft directory is the only ledger.)
- **H.2** — Run the host-path guard `grep -REn '/wo''rk/' saivage-v3/SPEC/analyst-as-control-surface/PLAN/drafts/002-tool-surface-alignment/`; expect zero matches (host-relative `saivage-v3/...` or absolute `/home/salva/g/ml/...` only).

## Validation

The validation gate definitions are the canonical commands in `saivage-v3/SPEC/analyst-as-control-surface/PLAN/VALIDATION-COOKBOOK.md`. Run them in this order, all from cwd `/home/salva/g/ml`:

- Gate `tsc-build`: `( cd saivage-v3 && npx tsc -p . )` — expected exit 0, no `error TS<code>` lines.
- Gate `web-vite-build`: `( cd saivage-v3/web && npm run build )` — expected exit 0, no vue-tsc or vite errors.
- Gate `web-vitest`: per cookbook §3 — expected exit 0.
- Gate `analyst-e2e`: per cookbook §3 — expected exit 0 OR any new failing-id is recorded in the ledger per the Close-out rule.

Then run the acceptance commands from `design.md` §"Acceptance criteria" in order A1, A2, A3, A4, A5, A6, A7, A8. A1, A2, A3, A4, A5, A6, A7 must all succeed before A8 is run. A8 is the authoritative gate-diff command and is the single source of truth for the ledger append/delete decisions in Close-out.

## Close-out

### Breakage triage

Runs the four cheap baseline gates, captures the fresh failing-id snapshot, diffs against `baseline-gates.json`, classifies every diff into NEW / REPAIRED / CARRY-FORWARD, attempts a holistic fix for every NEW entry before accepting it as deferred, and only then mutates the cumulative ledger. This follows MASTER-PLAN-r7 §6.2 "Breakage triage at the end of every stage".

- **Triage.1** — Run `bash saivage-v3/SPEC/analyst-as-control-surface/PLAN/scripts/run-gates.sh --diff saivage-v3/SPEC/analyst-as-control-surface/PLAN/baseline-gates.json` from `/home/salva/g/ml`. The driver writes the fresh snapshot to `tmp/s02-fresh-gates.json` and prints a NEW / REPAIRED / CARRY-FORWARD classification per gate.
- **Triage.2** — For every failing-id classified as NEW, attempt a holistic fix in the current stage commit (do NOT defer as a matter of habit): re-inspect the relevant source file, decide whether the breakage is in S02's owned surface area, and if so fix it and re-run Triage.1. Only failing-ids that cannot be holistically fixed within S02's scope are eligible to become deferred ledger entries.
- **Triage.3** — For each NEW failing-id that survives Triage.2 as a genuine downstream deferral, append a fresh H3 block under `## Open entries` in `saivage-v3/SPEC/analyst-as-control-surface/PLAN/expected-breakage-ledger.md` (the single cumulative ledger) using the S00-pinned shape:

```
### <failing-id>

Failure mode: <one-line description grounded in the gate output>
Reason acceptable now: <one-line reason tied to S02 scope or a downstream stage>
Target fix stage: S<NN>   # one of S03..S10
Recorded by: S02 / <YYYY-MM-DD>
```

  The `Target fix stage:` line MUST be in `S03..S10` (never `S00`, `S01`, or `S02`). The `<YYYY-MM-DD>` is the UTC date at append time.

- **Triage.4** — For each failing-id classified as REPAIRED that the cumulative ledger already names with `Target fix stage: S02`, delete the entire H3 block (heading and the four content lines) from `saivage-v3/SPEC/analyst-as-control-surface/PLAN/expected-breakage-ledger.md`. Do NOT touch any H3 block whose `Target fix stage:` is not `S02`.
- **Triage.5** — For each failing-id classified as CARRY-FORWARD (still failing AND already in the ledger with a non-`S02` target), leave the H3 block untouched.
- **Triage.6** — Record the delta against the design.md `## Breakage forecast` (which entries were predicted-and-observed, predicted-and-not-observed, observed-but-not-predicted). The delta is the closing summary in the writer's hand-off message to the reviewer; it does NOT live in any drafted file.

### Final hand-off checks

- Re-run the writer's standing autonomy-boundary grep (per Phase H.1) and confirm zero matches across `design.md` and `plan.md`.
- Re-run the host-path guard (per Phase H.2) and confirm zero matches.
- Confirm that the only ledger reference anywhere in the draft is the cumulative `saivage-v3/SPEC/analyst-as-control-surface/PLAN/expected-breakage-ledger.md` path: `grep -nE 'ledger\.md|ledger\.json|drafts/[0-9]+-[a-z0-9-]+/ledger' saivage-v3/SPEC/analyst-as-control-surface/PLAN/drafts/002-tool-surface-alignment/{design,plan}.md` must report only matches that include the cumulative path.
- Hand the draft to the reviewer for the S02 review pass; do NOT publish (atomic rename into `stages/002-tool-surface-alignment/`) until the reviewer approves.
