# Stage 002 — Tool Surface Alignment — Design

## Goal

Bring the analyst tool surface into 1:1 correspondence with the SPEC-r7 Analyst Capability Classes: add every tool the SPEC requires, retire every tool the SPEC removes, and route every mutating analyst tool through one shared audit-wrapped invocation entry point. Pin the four response-shape contracts S01 deferred (unsupported action, partial success, unknown internal capability, conversational confirmation) and enforce the SPEC-r7 non-secret boundary on every inspect, file, directory, transcript, and process-output tool through a single secret-classification module. The analyst LLM resolver system prompt, the tool registry consumed by the resolver, the tool schemas advertised to the LLM, the planner/runtime role policy, and the shared agent-tool registry must stay in sync after S02 lands.

## Inputs (immutable)

- `saivage-v3/SPEC/analyst-as-control-surface/SPEC-r7.md` sections: "Analyst Capability Classes", "Acceptance Criteria — Conversational equivalence", "Failure and audit".
- `saivage-v3/SPEC/analyst-as-control-surface/PLAN/PROTOCOL-r4.md` (draft/stage/ledger lifecycle, atomic publication).
- `saivage-v3/SPEC/analyst-as-control-surface/PLAN/00-MASTER-PLAN-r7.md` §S02 (verbatim scope, dependencies S00 and S01, effort L).
- `saivage-v3/SPEC/analyst-as-control-surface/PLAN/stages/000-breakage-detection-harness/{design,plan}.md` (four-gate driver, ledger format, baseline snapshot).
- `saivage-v3/SPEC/analyst-as-control-surface/PLAN/stages/001-real-llm-analyst-resolver/{design,plan}.md` (resolver contract, `getAnalystToolDefinitions`, `getAnalystSystemPrompt`, exported `AnalystOfflineError` and `ANALYST_OFFLINE_REPLY`, deletion of `parseIntent`/`runOfflineFallback`/`HELP_TEXT`/`lastIntent`/`deterministicIntent` from `analyst-handler.ts`).
- `saivage-v3/SPEC/analyst-as-control-surface/PLAN/scripts/run-gates.sh` (driver, single source of truth for failing-id diff).
- `saivage-v3/SPEC/analyst-as-control-surface/PLAN/baseline-gates.json` (S00 snapshot; read only).
- `saivage-v3/SPEC/analyst-as-control-surface/PLAN/VALIDATION-COOKBOOK.md` (operator-runnable gate command catalogue).

## Scope

### Included

- Bring the analyst tool inventory into 1:1 correspondence with SPEC-r7 Analyst Capability Classes (Inspect; Navigate the workspace area; Mutate cards; Queue notifications; Control the runtime; Reconfigure; Investigate and repair; Multi-turn conversation; Batch and set-based operations; Chained reasoning).
- Extract one shared audit-wrapped tool entry point `runAuditedAnalystTool()` in `saivage-v3/src/agents/analyst-tool-runner.ts` (new module). Every mutating analyst tool funnels through it. Every inspect tool that consumes file/directory/transcript/process-output goes through one shared `assertAnalystInspectionTarget()` non-secret boundary in the same new module.
- Extract the non-secret classification policy into a single module `saivage-v3/src/agents/analyst-secret-classifier.ts` (new module) that wraps `assertNotSecretPath` and `looksLikeSecretPath` from `saivage-v3/src/workspace/secret-paths.ts` and is the single source of truth consumed by every analyst inspect tool. No analyst tool may call the workspace-layer helpers directly after S02.
- Define and enforce the four response-shape contracts owned by S02: unsupported-action reply, partial-success reporting, unknown-internal-capability reply, and the conversational confirmation flow (Affirmation, Cancellation/refusal, Amendment, Stale affirmation).
- Add the destructive-confirmation flow primitive used by every destructive tool (`delete_card`, `abort_goal_subtree`, `restart_card_or_subtree`, `mark_goal_needs_corrections`, `terminate_process`, `stop_project`, `restart_server`) on top of `runAuditedAnalystTool()`.
- Add missing runtime-control tools required by SPEC-r7 "Control the runtime": `start_project`, `stop_project`, `abort_goal_subtree`, `restart_card_or_subtree`, `terminate_process`, `mark_goal_needs_corrections`. Keep `pause_runtime` and `resume_runtime`.
- Add the `queue_notification` tool surface (single-recipient per SPEC-r7 "Queue notifications to agent sessions" — the SPEC's example utterances target one card-or-role at a time and the SPEC explicitly forbids list/edit/delete/ack of notifications, so batch fan-out is not a queue-notification concern). Retire the v2 note-inbox tools (`add_note`, `list_notes`, `get_note`, `mark_note_handled`) from the analyst surface. The persistent queue mechanic is S04's responsibility; S02 declares the surface only and returns a typed `not_yet_available` shape until S04 lands.
- Add the `reorder_child` tool surface for Mutate-cards/ordered-children. The bounded-move data-model contract is S03's responsibility; S02 declares the surface only and returns a typed `not_yet_available` reply until S03 lands.
- Add the `navigate_workspace` tool surface (Navigate capability class) and the `navigate_back` go-back affordance (SPEC-r7 §"Navigate the workspace area": "Go back to where I was before." -> the left panel returns to the previously active view and entity). The actual SPA route change is S08's responsibility; S02 declares the tool surface and a typed return shape only and stores no navigation history of its own.
- Add the `reconfigure` Reconfigure-class tool surface as a single discriminated tool with the seven SPEC-r7 sub-actions: `set_role_routing`, `set_failover_order`, `mcp_add`, `mcp_edit`, `mcp_remove`, `set_runtime_setting`, `set_server_setting`. Add `restart_server` as a separate destructive tool (so the confirmation flow applies and it is auditable independently). Add `show_config` as an inspect-class tool that returns the redacted project config view, routed through `analyst-secret-classifier.ts`. All seven `reconfigure` sub-actions, `restart_server`, and `show_config` are implemented for real this stage: a new config persistence module (see "Config persistence module" below) provides atomic typed setters for `models.routing`, `models.failover`, `mcpServers` (add/edit/remove), `runtime.*` settings, and `server.*` settings; a new server self-restart primitive (see "Server restart primitive" below) backs `restart_server`. There is no `not_yet_available` deferral for any S02-owned Reconfigure sub-action.
- Update the system prompt returned by `getAnalystSystemPrompt()` to enumerate every capability class with its tool(s), the four response-shape contracts, the destructive-confirmation flow, and the SPEC-r7 non-secret boundary.
- Wire the new tools and the retired tools into `saivage-v3/src/agents/role-tool-policy.ts` so the role policy stays in 1:1 correspondence with the analyst tool registry; wire equivalent updates into `saivage-v3/src/tools/agent-tools.ts` so the shared agent-tool registry stays consistent.

### Excluded — deferred to later stages

- Card data-model changes including ordered children, bounded move, status enum changes, or hard removal of legacy fields — S03 owns this.
- The persistent notification queue, its on-disk shape, queue retention, queue depth bounds, and acknowledgment semantics — S04 owns this.
- The right-panel persistent UI surface (the always-visible Analyst panel, the 70/30 layout grid, the absence of any toggle/drawer affordance) — S05 owns this. S02 does not touch any Vue file.
- Removal of analyst-driven mutations from the dashboard UI buttons and the operator UI shortcuts — S06 owns this.
- Pruning of the operator API to a per-capability-class minimum and the per-route minimum-actor matrix — S07 owns this.
- Analyst-driven SPA navigation: the actual route change in the left panel when the analyst calls `navigate_workspace` or `navigate_back`, the propagation of current view / active entity / refinement back to the analyst on each turn, and the wiring of the analyst chat panel's contextual-awareness lists — S08 owns this. S02 declares only the typed tool surface and the audit wrapper; no Vue component is touched.
- `analyst_tool_invoked` event payload cleanup and the events-API surface — S09 owns this.
- Final test-suite consolidation and ledger reconciliation across all stages — S10 owns this.

## Capability classes from SPEC-r7 mapped to tools and contracts

Each row cites the SPEC-r7 section that scopes the capability, names the S02 tool or discriminated sub-action that implements it, the response-shape contracts that apply, and the downstream stage that owns the corresponding consumer surface (if any). Where SPEC-r7 uses example utterances (lines beginning with `- "..."`), the citation quotes the utterance verbatim so the mapping is mechanically auditable.

| SPEC-r7 capability class (section header verbatim) | SPEC-r7 anchor / cited line | S02 tool name or discriminated sub-action | Response-shape contracts | Later-stage hand-off |
|---|---|---|---|---|
| Inspect | SPEC-r7 \u00a7"Inspect": "Inspect commands also bring the inspected artifact into view ..." | `get_status`, `get_card`, `get_tree`, `get_plan_diary`, `get_card_output`, `list_cards`, `list_card_history`, `get_card_history_entry`, `diff_card`, `read_runtime_events`, `read_runtime_errors`, `read_control_actions`, `list_processes`, `list_agent_sessions`, `read_agent_session`, `read_file`, `list_directory`, `show_config` | C1 (unsupported-action when a path is off-limits or the inspected entity does not exist); non-secret boundary on every path-bearing tool | The inspect-implies-navigate side-effect ("bring the inspected artifact into view") is S08 (SPA route wiring). S02 returns the inspected payload only. |
| Inspect \u2014 redacted config view | SPEC-r7 \u00a7"Reconfigure": '"Show me the current config." -> the Analyst returns the project configuration with secrets redacted.' | `show_config` (inspect) | C1; non-secret boundary via `analyst-secret-classifier.ts` | None. S02 returns the redacted payload directly. |
| Navigate the workspace area | SPEC-r7 \u00a7"Navigate the workspace area": "switch between view categories ... open a specific entity in the appropriate view ... return to a previous view, and combine navigation with a subsequent action in the same turn." | `navigate_workspace(target: { kind, id, refinement? })` | C1 (unknown target kind or id) | S08 owns the SPA route change and the "active view + entity + refinement" propagation back to the analyst on each turn (MASTER-PLAN-r7 \u00a7S08 "consumes the `navigate_workspace` and `navigate_back` schemas; wires the SPA route change"). S02 returns `{ success: true, data: { navigated_to: params.target, deferred_to: 'S08' } }`; C1 still applies for unknown target kinds or ids; the destructive-confirmation contract C4 does not apply (non-destructive). |
| Navigate \u2014 go back | SPEC-r7 \u00a7"Navigate the workspace area": '"Go back to where I was before." -> the left panel returns to the previously active view and entity; the Analyst confirms.' | `navigate_back()` (no params) | C1 (no prior view recorded) | S08 owns the back-stack itself and the route change (same MASTER-PLAN-r7 \u00a7S08 clause cited above). S02 returns `{ success: true, data: { navigated_back: true, deferred_to: 'S08' } }`. |
| Mutate cards | SPEC-r7 \u00a7"Mutate cards": "create cards (individually or in batches ...) ... edit ... reorder cards within their parent's child list ... move cards along the parent-child axis ... delete cards individually or by a described set." | `create_card`, `edit_card`, `move_card`, `delete_card`, `reorder_child` | C2 for batch/set fan-out (`delete_card` always accepts `ids: string[]`, multi-create); C4 for destructive `delete_card` | S03 owns ordered-children persistence and bounded-move semantics (MASTER-PLAN-r7 \u00a7S03 "consumes the `reorder_child` and `move_card` schemas; replaces the typed `not_yet_available` reply with a real bounded-move implementation"). S02 declares the schema; `reorder_child` returns `{ success: false, data: { reason: 'not_yet_available', stage_owner: 'S03' } }`; cross-tree validation in `move_card` is also deferred to S03. S02 replaces the existing single-`id` analyst-surface schema with `{ ids: string[] }` (length >= 1) in the same commit; the destructive-confirmation contract C4 still applies and the partial-success contract C2 still applies to its `ids: string[]` fan-out (both contracts are S02-owned). The single-card analyst-surface caller `tests/analyst.test.ts` is rewritten to `delete_card({ ids: [theId] })` in the same commit. The planner-control `delete_card` surface (`src/agents/agent-adapter.ts` and `src/agents/planner-control-executor.ts`, which uses field name `cardId` and is a separate schema from the analyst tool) is NOT touched by S02. |
| Queue notifications | SPEC-r7 \u00a7"Queue notifications to agent sessions": "queue a notification, addressed to a given card or role ... The Analyst does not offer 'edit notification', 'delete notification', 'list pending notifications', 'mark notification handled', or any equivalent management operation, because notifications are not a managed object class." | `queue_notification(recipient, kind, body)` (single recipient per SPEC) | C1 (unknown recipient id) | S04 owns the persistent queue mechanic (MASTER-PLAN-r7 \u00a7S04 "consumes the `queue_notification` schema; replaces the typed `not_yet_available` reply with the persistent queue mechanic"). S02 returns `{ success: false, data: { reason: 'not_yet_available', stage_owner: 'S04' } }` after the C1 recipient-id check. |
| Control the runtime | SPEC-r7 \u00a7"Control the runtime": "start root project execution; stop it; pause and resume the runtime globally; abort a goal subtree ... restart a card or a goal subtree ... mark a goal as needing corrections ... terminate a live runtime process." | `start_project`, `stop_project`, `pause_runtime`, `resume_runtime`, `abort_goal_subtree`, `restart_card_or_subtree`, `mark_goal_needs_corrections`, `terminate_process` | C4 for destructive verbs (`stop_project`, `abort_goal_subtree`, `restart_card_or_subtree`, `mark_goal_needs_corrections`, `terminate_process`) | None. S02 wires every verb to `ctx.activeRuntime.runtime.*` directly. |
| Reconfigure \u2014 role/model routing | SPEC-r7 \u00a7"Reconfigure": '"Route the planner role to gpt-5.5-mini." -> the routing is changed and the next planner invocation uses the new candidate.' | `reconfigure({ action: "set_role_routing", role, model_candidate })` | C1 (unknown role or candidate); C4 not required (non-destructive) | None. S02 persists via the new `analyst-config-writer.ts` module (atomic write to `.saivage/saivage.json`, full-document Zod re-validation against `saivageConfigSchema`). Implemented this stage. |
| Reconfigure \u2014 failover order | SPEC-r7 \u00a7"Reconfigure": '"Make Anthropic the second failover for the executor role, after OpenAI." -> the failover order for that role is updated ...' | `reconfigure({ action: "set_failover_order", role, ordered_providers })` | C1 (unknown role or provider id) | None. S02 persists via `analyst-config-writer.setFailoverOrder`. The schema field is the top-level `failover: Record<role, string[]>` defined by `saivageConfigSchema` (`src/agents/config-schema.ts` line 265). Implemented this stage. |
| Reconfigure \u2014 MCP add | SPEC-r7 \u00a7"Reconfigure": '"Add an MCP server called weather that runs the following command ..." -> the entry is added ...' | `reconfigure({ action: "mcp_add", name, command, args?, env? })` | C1 (duplicate name) | None. S02 persists via `analyst-config-writer.mcpAdd` (writes the `mcpServers` map per `saivageConfigSchema` line 264), then refreshes the manager's in-memory server map from disk via the new `McpManager.reloadServersFromConfig()` helper, then calls `await ctx.activeRuntime.mcpManager.startServer(name)` (existing method at `src/mcp/mcp-manager.ts` line 610) so the new entry becomes live without a server restart. Implemented this stage. |
| Reconfigure \u2014 MCP edit | SPEC-r7 \u00a7"Reconfigure": "manage MCP server entries (add, edit, remove)" | `reconfigure({ action: "mcp_edit", name, command?, args?, env? })` | C1 (unknown name) | None. S02 persists via `analyst-config-writer.mcpEdit`, then refreshes the manager's in-memory map via `McpManager.reloadServersFromConfig()`, then calls `await ctx.activeRuntime.mcpManager.restartServer(name)` (existing stop-then-start at `src/mcp/mcp-manager.ts` line 713) so the edited command/args/env are live. Implemented this stage. |
| Reconfigure \u2014 MCP remove | SPEC-r7 \u00a7"Reconfigure": '"Remove the MCP server called weather." -> the entry is removed ...' | `reconfigure({ action: "mcp_remove", name })` | C1 (unknown name); C4 not required (the SPEC scopes confirmation to `restart_server` and to destructive runtime verbs, not to config edits) | None. S02 first calls `await ctx.activeRuntime.mcpManager.stopServer(name)` (existing method at `src/mcp/mcp-manager.ts` line 663) so the live entry is retired, then persists via `analyst-config-writer.mcpRemove`, then refreshes the in-memory map via `McpManager.reloadServersFromConfig()` so the entry is dropped from `getStatus()`. Implemented this stage. |
| Reconfigure \u2014 runtime setting | SPEC-r7 \u00a7"Reconfigure": '"Set the runtime autonomous-progress interval to 30 seconds." -> the runtime setting ... is updated ...' | `reconfigure({ action: "set_runtime_setting", key, value })` | C1 (unknown key per `runtimeSectionSchema`); C1 (invalid value per Zod) | None. S02 persists via `analyst-config-writer.setRuntimeSetting`, which mutates the `runtime` section of `saivage.json` and re-validates the whole document against `saivageConfigSchema` before atomic write. Allowed keys are exactly the keys of `runtimeSectionSchema` in `src/agents/config-schema.ts` line 176; unknown keys return C1. The next `loadConfig` caller observes the new value; no restart is required for keys consumed lazily. Implemented this stage. |
| Reconfigure \u2014 server setting | SPEC-r7 \u00a7"Reconfigure": '"Raise the maximum number of concurrent executor processes the server will allow to four." -> the server-level concurrency setting is updated ...' | `reconfigure({ action: "set_server_setting", key, value })` | C1 (unknown key per `serverSectionSchema`); C1 (invalid value per Zod) | None. S02 persists via `analyst-config-writer.setServerSetting` (writes the `server` section per `saivageConfigSchema` line 258). Keys whose live application requires a server restart (e.g. `port`, `host`) cause the tool result to include `data.requires_restart: true` so the resolver prompts the user to also call `restart_server`. Implemented this stage. |
| Reconfigure \u2014 restart server | SPEC-r7 \u00a7"Reconfigure": "unless the specific change cannot be applied without a restart; in that case the Analyst says so explicitly and asks the user before restarting." | `restart_server()` (separate tool, destructive) | C4 (confirmation flow); audit-wrapped | None. S02 calls the new `Server.requestRestart()` primitive (see \"Server restart primitive\" below). Implemented this stage. |
| Investigate and repair | SPEC-r7 \u00a7"Investigate and repair": "correlate a card failure with the originating planner or executor session, runtime events, and process output; ask for a diagnosis; and apply the fix in the same conversation." | `run_shell_command` plus chained use of every Inspect, Mutate, and Reconfigure tool above | C1 when the surface forbids shell (e.g. `surface === 'telegram'`); non-secret boundary on shell output | None. S02 keeps `run_shell_command`; surface-restricted denial lives in `role-tool-policy.ts`. |
| Multi-turn conversation | SPEC-r7 \u00a7"Multi-turn conversation": "the Analyst asks one clarifying question rather than guessing." | All of the above (the resolver loop) | C4 drives the multi-turn confirmation flow; C1 covers the one-clarification refusal path when the analyst cannot resolve a referent | S08 (deictic resolution) and S01 (one-clarification rule) own the resolver behavior; S02 wires C4 into the handler. |
| Batch and set-based operations | SPEC-r7 \u00a7"Batch and set-based operations": "A single natural-language request that describes a set ... is resolved in one user turn, not by asking the user to list ids." | `delete_card` (described set), `create_card` (multi-create), `reorder_child` (one-call set-update), `reconfigure` (multi-action discriminated batch when the resolver chains several sub-actions in one turn) | C2 (partial-success when at least one sub-target succeeds and at least one fails) | None at S02; underlying fan-out semantics deferred to S03 for cards. |
| Chained reasoning across artifacts | SPEC-r7 \u00a7"Chained reasoning across artifacts": "A single request can walk across multiple artifacts ... and produce a coherent answer or coordinated set of mutations." | All of the above | C3 (unknown-internal-capability) when the resolver proposes a tool name not in `TOOL_REGISTRY` during a chain | None. S02 wires C3 into the handler's tool-dispatch loop. |

## Response-shape contracts

Each contract is implemented in `analyst-tool-runner.ts` (the entry point) or in `analyst-llm-resolver.ts` (the resolver wrapper), as noted. All user-visible strings are ASCII and use literal templates so e2e and unit tests can match them exactly.

### Contract C1 — Unsupported-action reply

- Trigger: the resolver decides on a verb the analyst is asked to perform but the verb maps to no tool in the registry returned by `getAnalystToolDefinitions()` OR maps to a tool that returns the typed-but-stubbed `not_yet_available` shape OR maps to a tool whose role policy denies it for the active actor/surface tuple.
- Tool-state effect: no audit-log entry is written; no card store mutation; no runtime intent change.
- Literal user-facing template (single line, ASCII): `"That action is not supported by the Analyst on this surface. Closest available capability: <CAPABILITY-CLASS-NAME>. Available tools in that class: <COMMA-SEPARATED-TOOL-NAMES>."` When no closest capability class can be inferred the second sentence is omitted.
- Implementation: `analyst-llm-resolver.ts` checks the tool name against `Object.keys(TOOL_REGISTRY)` and the role policy verdict from `RoleToolPolicy.decide` before dispatching; on a negative verdict it returns the unsupported-action reply without invoking the tool. The `analyst-handler.ts` final-response builder echoes the reply verbatim.

### Contract C2 — Partial-success reporting

- Trigger: a single tool invocation that fans out across N sub-targets and at least one sub-target succeeds while at least one fails. SPEC-r7 §"Batch and set-based operations" mandates partial-success for described-set fan-out. Concrete in-scope fan-out tools at S02: `delete_card` (described-set of cards), `create_card` (multi-create), `reorder_child` (one-call set-update over a child list), `reconfigure` (multi-action discriminated batch when the resolver chains several sub-actions in one turn — e.g. "add MCP server X and route the planner role to gpt-5.5-mini"). `queue_notification` is single-recipient per SPEC and is NOT a C2 fan-out tool; its failure mode is C1 (unknown recipient id) or a hard error.
- Tool-state effect: every successful sub-target is committed; every failing sub-target is recorded in the audit entry's `outcome_summary` with the per-sub-target reason; the overall `ToolResult.success` is `true` if at least one sub-target succeeded, with the flat payload `data: { partial: true, total: number, succeeded: number, failures: Array<{ id: string; reason: string }> }`. No nested `totals` object. Field names are exactly `partial`, `total`, `succeeded`, `failures`; each failure entry uses exactly `id` and `reason`. Every handler, tool implementation, tool schema, and test reads and writes those exact field names.
- Literal user-facing template (single line, ASCII): `"Partial success: <SUCCEEDED> of <TOTAL> succeeded. Failed: <COMMA-SEPARATED-IDS>. Reasons: <SEMICOLON-SEPARATED-REASONS>."`
- Implementation: every fan-out tool returns the partial-success payload through `runAuditedAnalystTool()`; the handler maps `data.partial === true` to the literal template.

### Contract C3 — Unknown-internal-capability reply

- Trigger: the resolver returns a tool call whose `function.name` is not a key in `TOOL_REGISTRY`. The resolver MUST surface this to the user rather than silently dropping the call.
- Tool-state effect: no audit entry; no mutation. The unknown tool name is recorded in the analyst session message stream as a `tool_result` with `success=false` so post-hoc inspection can see what the LLM proposed.
- Literal user-facing template: `"The Analyst cannot perform <PROPOSED-TOOL-NAME>; it is not a registered capability. Available capability classes: Inspect, Navigate, Mutate cards, Queue notifications, Control the runtime, Reconfigure, Investigate and repair."`
- Implementation: `analyst-handler.ts` already checks `TOOL_REGISTRY[tc.function.name]` and emits `Unknown tool: <name>`; S02 replaces that string with the literal C3 template and adds a unit test.

### Contract C4 — Conversational confirmation flow

- Trigger: any tool whose `safety_class` is `destructive` (`delete_card`, `abort_goal_subtree`, `restart_card_or_subtree`, `terminate_process`, `stop_project`, `mark_goal_needs_corrections`, `restart_server`). On the first turn the tool MUST NOT execute; the handler stores a `PendingDestructiveInvocation { sessionId, tool, params, createdAt }` keyed by `sessionId` in the per-process `PendingDestructiveStore` and returns the first-turn preview template below.
- The handler observes four distinct outcomes from the user's next message in the same session, with no out-of-band confirmation field on the tool call. Lowercase trimming is applied before set-matching.

First-turn preview (single line, ASCII; emitted on every destructive tool's first invocation):

```
About to <ACTION-VERB> <TARGET-DESCRIPTION>. This will affect <N> item(s): <COMMA-SEPARATED-IDS>. Reply 'yes' to proceed, 'no' to cancel, or describe an amendment.
```

Outcome 1 — **Affirmation**:

- Trigger: trimmed-lowercase next user message matches the literal set `{"yes","y","confirm","proceed","do it","ok"}`.
- Template (single line, ASCII): `"Confirmed. <ACTION-VERB> applied to <N> item(s): <COMMA-SEPARATED-IDS>."`
- Tool-state effect: the stored pending invocation is dequeued and executed through `runAuditedAnalystTool()`; the audit entry records `outcome="ok"` (or `outcome="error"` on a downstream failure) and the actual mutation is applied. After execution the pending invocation is removed from the store.
- Audit: one new control-action entry whose `outcome` is `ok` or `error`.

Outcome 2 — **Cancellation / refusal**:

- Trigger: trimmed-lowercase next user message matches the literal set `{"no","n","cancel","stop","abort","never mind"}`.
- Template (single line, ASCII): `"Cancelled. No changes were made."`
- Tool-state effect: the pending invocation is discarded; no mutation; one audit entry is written with `outcome="cancelled"` referencing the originally proposed tool name and params.
- Audit: one new control-action entry whose `outcome` is `cancelled`.

Outcome 3 — **Amendment**:

- Trigger: the next user message does not match the Affirmation or Cancellation sets AND the resolver maps it to a different tool, or to the same tool with different parameters.
- Template (single line, ASCII): `"Amended. New proposal: <NEW-ACTION-VERB> <NEW-TARGET-DESCRIPTION>. Reply 'yes' to proceed, 'no' to cancel, or describe a further amendment."`
- Tool-state effect: the previously stored pending invocation is discarded WITHOUT an `outcome="cancelled"` audit entry (the user replaced the proposal rather than rejecting it); a fresh `PendingDestructiveInvocation` is stored for the new tool if it is destructive, otherwise the new tool runs immediately through its own contract path.
- Audit: one new control-action entry whose `outcome` is `amended` and whose payload references both the prior tool name and the new tool name, so post-hoc inspection can reconstruct the chain.

Outcome 4 — **Stale affirmation**:

- Trigger: a previously stored pending invocation exists but `now() - pending.createdAt > CONFIRMATION_TTL_MS` (where `CONFIRMATION_TTL_MS = 300_000`, i.e. 5 minutes). On every incoming message the store first prunes any pending invocation past its TTL.
- Template (single line, ASCII), only emitted when the user message that triggered the prune is an Affirmation: `"The previous confirmation expired. Restate the request if you still want it."`
- Tool-state effect: the expired pending invocation is removed silently; no mutation; one audit entry is written with `outcome="expired"` referencing the originally proposed tool name and params. If the user message is itself a normal request, that request is dispatched through its own contract path.
- Audit: one new control-action entry whose `outcome` is `expired`.

Implementation: a new in-memory `PendingDestructiveStore` lives in `analyst-tool-runner.ts`, owned by the `AnalystHandler` and reset on session deletion. The store is per-process; persistence across server restarts is explicitly out of scope (the stale-affirmation TTL covers operator restarts). The store API is `recordPending(sessionId, tool, params)`, `consumePending(sessionId)`, `discardPending(sessionId)`, and `pruneExpired(now)`.

## Audit-wrapped invocation entry point — single source of truth

- New module: `saivage-v3/src/agents/analyst-tool-runner.ts`.
- Public API:
  - `runAuditedAnalystTool<P>(ctx: ToolContext, params: P, spec: MutatingSpec<P>): Promise<ToolResult>` — same shape as the existing private `runMutatingTool` in `analyst-tools.ts`, moved out of that file so every analyst entry point is a single import.
  - `assertAnalystInspectionTarget(absolutePath: string): void` — single secret-classification gate. Throws `SecretPathError` on a deny. Wraps `assertNotSecretPath` from `saivage-v3/src/workspace/secret-paths.ts`.
  - `PendingDestructiveStore` — see Contract C4.
- Every mutation tool currently exported from `analyst-tools.ts` is rewritten to import `runAuditedAnalystTool` from the new module. The private `runMutatingTool` in `analyst-tools.ts` is deleted.
- Every inspect tool that reads filesystem paths (`read_file`, `list_directory`, `run_shell_command`, `read_runtime_events`, `read_runtime_errors`, `read_control_actions`, `read_agent_session`) is rewritten to call `assertAnalystInspectionTarget` once before any I/O.

## Config persistence module

- New module: [saivage-v3/src/agents/analyst-config-writer.ts](../../../src/agents/analyst-config-writer.ts). This file did not exist before S02; the existing `loadConfig(projectRoot, env)` in [saivage-v3/src/agents/config-schema.ts](../../../src/agents/config-schema.ts) (line 350) is a reader-only surface and has no writer counterpart, so every Reconfigure sub-action backed an MCP / role / failover write through ad-hoc JSON manipulation in the prototype. S02 replaces that with a single typed writer module.
- Storage model: every setter reads `<projectRoot>/.saivage/saivage.json` as raw text, parses it with `JSON.parse`, applies the patch on the parsed object (read-modify-write semantics; no field-level diffing or merging beyond the targeted key), re-validates the full document with `saivageConfigSchema.safeParse(...)`, and on a successful parse writes the new document via `writeFileAtomic` from [saivage-v3/src/persistence/index.ts](../../../src/persistence/index.ts) (atomic temp-file + rename). The setter never touches `.saivage/auth-profiles.json` and never reads secret-classified fields; the `show_config` redaction path uses the secret classifier the same way as `read_file`.
- Public API (every function is synchronous if `writeFileAtomic` is synchronous in this codebase; otherwise `Promise<ConfigWriteResult>`):
  - `setRoleRouting(projectRoot: string, role: string, modelCandidate: string): ConfigWriteResult` -> writes `models.routing[role] = modelCandidate` (`saivageConfigSchema` line 113).
  - `setFailoverOrder(projectRoot: string, role: string, orderedProviders: string[]): ConfigWriteResult` -> writes the top-level `failover[role] = orderedProviders` (`saivageConfigSchema` line 265).
  - `mcpAdd(projectRoot: string, name: string, command: string, args?: string[], env?: Record<string,string>): ConfigWriteResult` -> writes `mcpServers[name] = { command, args, env }`; returns C1 if `name` already exists.
  - `mcpEdit(projectRoot: string, name: string, patch: { command?: string; args?: string[]; env?: Record<string,string> }): ConfigWriteResult` -> shallow-merges into `mcpServers[name]`; returns C1 if `name` is unknown.
  - `mcpRemove(projectRoot: string, name: string): ConfigWriteResult` -> deletes `mcpServers[name]`; returns C1 if `name` is unknown.
  - `setRuntimeSetting(projectRoot: string, key: string, value: unknown): ConfigWriteResult` -> validates `key` is one of `Object.keys(runtimeSectionSchema.shape)` (`saivageConfigSchema` line 176); writes `runtime[key] = value`; the full-document re-validation catches type mismatches and returns C1 with the offending `fieldPath`.
  - `setServerSetting(projectRoot: string, key: string, value: unknown): ConfigWriteResult` -> validates `key` is one of `Object.keys(serverSectionSchema.shape)`; writes `server[key] = value`; full-document re-validation as above. Keys whose live application requires restarting the HTTP server (e.g. `port`, `host`) cause the result to include `requires_restart: true`.
  - `getRedactedConfig(projectRoot: string): RedactedConfig` -> backs `show_config`. Reads the same file, walks the object, replaces every value at a path matched by `analyst-secret-classifier.ts` with the literal string `"<redacted>"`, and returns the resulting object. Never writes.
- Result shape: `type ConfigWriteResult = { success: true; config: SaivageConfig } | { success: false; fieldPath: string; message: string }`. The `fieldPath` is a JSON-pointer-style string (e.g. `models/routing/planner`) so the analyst can quote it back to the user when emitting C1.
- Concurrency: each setter takes a per-projectRoot promise lock for the read-modify-write window, so two concurrent analyst sessions (or one analyst call racing a runtime-internal writer) never overwrite each other. The lock is held only across the `read -> parse -> patch -> validate -> atomic-write` sequence; it does NOT cover network IO or external command execution.
- No `not_yet_available` branch exists in this module; every setter is implemented end-to-end this stage.

## MCP manager plumbing

- Current source: `ToolContext.activeRuntime` is an `ActiveRuntime` ([saivage-v3/src/runtime/active-runtime.ts](../../../src/runtime/active-runtime.ts)); the class exposes `runtime`, `eventLogger`, `errorLogger`, `agentAdapter`, and `skillsEngine` accessors, but neither `mcpManager` nor `server`. The constructor accepts an optional `mcpManager` parameter but only uses it to wire `agentAdapter.setMcpManager(mcpManager)` and `mcpManager.setEventLogger(this._eventLogger)` and then drops the reference. The reconfigure MCP sub-actions and `restart_server` both need a typed accessor on `ActiveRuntime` to reach the live `McpManager` and the live `ServerInstance` respectively.
- Plumbing (Option A, additive, no `ToolContext` shape change): extend `ActiveRuntime` with two post-construction setters and matching accessors:
  - `setMcpManager(mcpManager: McpManager): void` and `get mcpManager(): McpManager | undefined`. The setter stores the reference on a private field and also performs the existing `agentAdapter.setMcpManager(mcpManager)` plus `mcpManager.setEventLogger(this._eventLogger)` wiring so the legacy constructor-time wiring becomes a one-line forward to the setter (no behavior change for the test caller `tests/runtime/runtime-activation-ledger.test.ts` line 140, which constructs `ActiveRuntime` without an MCP manager and never touches MCP).
  - `setServer(server: ServerInstance): void` and `get server(): ServerInstance | undefined`. Imported from `../server/server.js` as a type-only import to avoid a runtime cycle (ActiveRuntime is constructed before the ServerInstance object literal exists in `createServer`, so the setter is called after the literal is built and before `createServer` returns).
- Wiring in [saivage-v3/src/server/server.ts](../../../src/server/server.ts): in `createServer`, the existing `if (activeRuntime && mcpManager) { activeRuntime.agentAdapter.setMcpManager(mcpManager); mcpManager.setEventLogger(activeRuntime.eventLogger); }` block (line 111) is replaced wholesale with `if (activeRuntime && mcpManager) { activeRuntime.setMcpManager(mcpManager); }` so the new accessor is populated and the prior two-statement wiring is reissued from inside the setter (per `setMcpManager` semantics below). The setter call MUST stay inside the `activeRuntime && mcpManager` guard because `mcpManager` is typed `McpManager | undefined`. Immediately before the `return { fastify, ..., stop }` statement (line 136), build the instance literal into a `const instance: ServerInstance = { ... }`, call `if (activeRuntime) activeRuntime.setServer(instance)` (this setter only needs the `activeRuntime` guard because it takes only the `ServerInstance`), then `return instance`. The instance literal now carries `requestRestart` alongside `stop` per "Server restart primitive" below.
- McpManager refresh helper: `McpManager` currently reads `loadConfig(projectRoot)` once at construction (line 513) and never refreshes the in-memory `this.servers` map. After `analyst-config-writer` writes a new MCP entry to disk, `mcpManager.startServer(name)` would throw `MCP server '<name>' not found in configuration.` because `this.servers[name]` is still stale. S02 adds one new public method on `McpManager`:
  - `reloadServersFromConfig(): void` -- re-runs `loadConfig(this.projectRoot)`, re-runs `normalizeMcpServers(config)`, and assigns the result to `this.servers`. The handles, tool caches, discovery errors, and invocation queues are NOT touched (they are keyed by name, and the per-name lifecycle methods `startServer` / `stopServer` / `restartServer` continue to manage them). Synchronous; no I/O beyond `loadConfig`'s file read. This is the single new primitive the three MCP sub-actions rely on.
- After S02 lands, the literal method names called by `reconfigure` are exactly: `McpManager.startServer(name)`, `McpManager.stopServer(name)`, `McpManager.restartServer(name)`, `McpManager.reloadServersFromConfig()`. No `reload(name)` method exists on `McpManager` after S02; the design's earlier draft naming was incorrect and has been removed.

## Server restart primitive

- New method: `Server.requestRestart(): Promise<void>` added to the `ServerInstance` interface in [saivage-v3/src/server/server.ts](../../../src/server/server.ts) (current interface exposes only `stop()`). The new method is the single in-process entry point used by `restart_server` and by any future caller (e.g. `set_server_setting` with `requires_restart: true` that the user has confirmed).
- Implementation: `requestRestart()` resolves to the caller immediately (so the analyst tool's HTTP response and the audit entry can flush first), then schedules the actual shutdown via `setImmediate`. `createServer` already binds `stop` as a local closure (not a method on the returned object literal), so the new primitive closes over that local function directly rather than relying on an arrow function's `this`. Inserted inside `createServer` immediately before the `return` statement:

```ts
const requestRestart = async (): Promise<void> => {
  setImmediate(async () => {
    try { await stop(); } finally { process.exit(75); }
  });
};
```

  The returned object literal then carries `requestRestart` alongside `stop`. The `setImmediate` is what guarantees the HTTP response and audit-log write have already flushed by the time shutdown begins: `requestRestart()` returns to its `runAuditedAnalystTool` caller on the next microtask, the audit entry is appended, the tool result is serialized to the response stream, and only afterwards does the scheduled callback run `stop()` then `process.exit(75)`. Exit code `75` (`EX_TEMPFAIL` from `<sysexits.h>`) is reserved for "temporary failure, please retry" and is treated by systemd's `Restart=on-failure` directive as a failure that triggers the supervisor restart, consistent with the SPEC-r7 description of `restart_server` as a planned cycle.
- Process supervisor: every Saivage deployment that supports `restart_server` runs the server under a supervisor configured with `Restart=on-failure` (or equivalent). The active `saivage-v3` LXC container's systemd unit (`saivage.service`) already declares `Restart=on-failure` together with a fixed `RestartSec` delay, so a non-zero exit triggers the supervisor restart. Saivage's existing SIGTERM handler in [saivage-v3/src/boot/app.ts](../../../src/boot/app.ts) (line 27) calls `scope.dispose()` then `process.exit(0)`, which would NOT trigger systemd's `Restart=on-failure`; therefore `requestRestart()` must use the non-zero exit code, NOT the existing SIGTERM path.
- Confirmation: `restart_server` is destructive, so the C4 confirmation flow ALWAYS applies. The C4 store records the pending invocation; only after the user replies "yes" does the runner call `requestRestart()`. The first-turn C4 preview template references `restart server` with `N=1` and the target description `"the Saivage server"`.
- Availability check: `restart_server` does NOT precondition itself on "systemd is present"; the contract is that the operator configured supervisor restart at deployment time. On a misconfigured deployment (no supervisor restart) the process simply exits non-zero and the operator must restart it manually — the same outcome the SPEC describes ("the Analyst says so explicitly and asks the user before restarting").

## Resolver / handler architecture changes

- `saivage-v3/src/agents/analyst-handler.ts`:
  - Replace the literal `Unknown tool: ${name}` string in the tool-dispatch loop with the literal C3 template, exported as `ANALYST_UNKNOWN_CAPABILITY_TEMPLATE(toolName)`.
  - Replace the bare `'Error: ' + msg` string with a contract-C1 unsupported-action template when the error originates from a role-policy deny.
  - Add a pre-dispatch hook that consults `PendingDestructiveStore` for contract C4 affirmation / cancellation / amendment / stale-affirmation handling.
  - Wire the partial-success template into `buildResponse` so any tool returning `data.partial === true` produces the literal C2 template.
- `saivage-v3/src/agents/analyst-llm-resolver.ts`:
  - Update `ANALYST_SYSTEM_PROMPT` to enumerate the SPEC-r7 capability classes, every tool in each class, and the four response-shape contracts.
  - Add `getAnalystToolDefinitions()` re-export so the system prompt can expand `<TOOL_LIST>` exactly as defined by S01.
  - Add `RoleToolPolicy.decide` consultation before returning a tool call; on deny return the contract-C1 unsupported-action reply.
- `saivage-v3/src/agents/analyst-tools.ts`:
  - Delete the private `runMutatingTool` (now in `analyst-tool-runner.ts`).
  - Delete the analyst-surface exports `add_note`, `list_notes`, `get_note`, `mark_note_handled` (retired). The shared cards-layer note primitives in `saivage-v3/src/cards/` stay (planner/executor still use notes through their own surfaces in S03/S04 scope; S02 only retires the analyst-tool exports).
  - Rename `abort_goal` to `abort_goal_subtree`; rename `restart_card` to `restart_card_or_subtree`; keep `restart_goal` only as an internal alias used by `restart_card_or_subtree` when the target id is a goal. Update every call site and every test that imports these names.
  - Add `start_project(ctx, _params)`, `stop_project(ctx, _params)`, `terminate_process(ctx, params: { processId: string })` thin wrappers around `ctx.activeRuntime.runtime.startProject('analyst')`, `ctx.activeRuntime.runtime.stopProject('analyst')`, and `killProcess(ctx.projectRoot, params.processId, 'SIGTERM')` — each goes through `runAuditedAnalystTool`.
  - Add `queue_notification(ctx, params: { recipient: string; kind: string; body: string })` returning `{ success: false, data: { reason: 'not_yet_available', stage_owner: 'S04' } }` until S04 lands.
  - Add `reorder_child(ctx, params: { parentId: string; orderedChildIds: string[] })` returning `{ success: false, data: { reason: 'not_yet_available', stage_owner: 'S03' } }` until S03 lands.
  - Add `navigate_workspace(ctx, params: { target: { kind: 'card' | 'transcript' | 'process' | 'plan_diary' | 'process_list' | 'agent_session_list' | 'config'; id?: string; refinement?: string } })` returning `{ success: true, data: { navigated_to: params.target } }` — the SPA route change is S08; the tool surface is final at S02.
  - Add `navigate_back(ctx, _params)` returning `{ success: true, data: { navigated_back: true } }` — the back-stack itself lives in S08; S02 only emits the audit entry.
  - Add `show_config(ctx, _params)`: reads the project config under `ctx.projectRoot/.saivage/`, redacts every value whose key matches the secret-classifier policy or whose path component matches the secret-classifier policy, and returns `{ success: true, data: { config: <REDACTED> } }`. No mutation; routed through `assertAnalystInspectionTarget` and `analyst-secret-classifier.ts`.
  - Add `restart_server(ctx, _params)`: destructive runtime control. Calls the new `Server.requestRestart()` primitive on `ctx.activeRuntime.server` (see "Server restart primitive" below) through `runAuditedAnalystTool`; participates in contract C4 (confirmation flow) via the destructive `safety_class`.
  - Add `reconfigure(ctx, params: { action: 'set_role_routing' | 'set_failover_order' | 'mcp_add' | 'mcp_edit' | 'mcp_remove' | 'set_runtime_setting' | 'set_server_setting'; ...action-specific fields })` as a single discriminated tool. Every sub-action is dispatched to the matching setter on `analyst-config-writer.ts` (see "Config persistence module" below): `set_role_routing` -> `setRoleRouting`, `set_failover_order` -> `setFailoverOrder`, `mcp_add` -> `mcpAdd`, `mcp_edit` -> `mcpEdit`, `mcp_remove` -> `mcpRemove`, `set_runtime_setting` -> `setRuntimeSetting`, `set_server_setting` -> `setServerSetting`. The setter's `ConfigWriteResult` is mapped to a `ToolResult`: `{ success: true }` propagates directly; `{ success: false, fieldPath, message }` becomes a C1 reply citing the offending field. The three MCP sub-actions also bring the live `McpManager` into sync (see "MCP manager plumbing" below): `mcp_add` calls `reloadServersFromConfig()` then `startServer(name)`; `mcp_edit` calls `reloadServersFromConfig()` then `restartServer(name)`; `mcp_remove` calls `stopServer(name)` then `reloadServersFromConfig()`. There is no `not_yet_available` branch in `reconfigure`.
- `saivage-v3/src/agents/analyst-tool-schemas.ts`:
  - Delete the four note-inbox schemas (`add_note`, `list_notes`, `get_note`, `mark_note_handled`).
  - Add schemas for `start_project`, `stop_project`, `terminate_process`, `queue_notification`, `reorder_child`, `navigate_workspace`, `navigate_back`, `show_config`, `restart_server`, `reconfigure` (discriminated union over the seven sub-actions), `abort_goal_subtree`, `restart_card_or_subtree`.
  - The exported `ANALYST_TOOL_NAMES` list MUST equal the sorted union of registry keys; an invariant test asserts this.
- `saivage-v3/src/agents/role-tool-policy.ts`:
  - Update `ROLE_TOOL_NAMES.analyst` to equal the sorted union of S02 analyst tool registry keys, minus tools that are surface-restricted (`run_shell_command` on `surface === 'telegram'`).
  - Add `RoleToolPolicy.assertAnalystSurfaceTool(toolName, surface)` helper used by the resolver pre-dispatch hook.
- `saivage-v3/src/tools/agent-tools.ts`:
  - Remove the entries for the retired note-inbox tools.
  - Add zod schemas and entries for every new tool listed above.
  - The exported `AGENT_TOOL_DEFINITIONS` must include the new tools with their per-tool `roles` arrays matching `role-tool-policy.ts`.

## Test design

Backend Jest tests (one file, one `describe` block per contract / inventory area, public APIs only, no private state inspection):

- `saivage-v3/tests/agents/analyst-tool-surface.test.ts` — new file.
  - `describe('Tool inventory mirrors SPEC-r7 capability classes')`:
    - asserts `Object.keys(TOOL_REGISTRY).sort()` matches the enumerated list above (capability-class fixture).
    - asserts retired tool names (`add_note`, `list_notes`, `get_note`, `mark_note_handled`) are not in `TOOL_REGISTRY`.
    - asserts `ANALYST_TOOL_NAMES.sort()` equals `Object.keys(TOOL_REGISTRY).sort()`.
    - asserts `RoleToolPolicy.listToolNamesForRole('analyst').sort()` equals `Object.keys(TOOL_REGISTRY).sort()`.
  - `describe('Contract C1 unsupported-action reply')`:
    - calls `handler.handleMessage(sessionId, "please write to my email")` and asserts the response content matches the literal C1 template.
    - calls with a request that maps to a registered tool but with a role-policy deny; asserts the same template.
  - `describe('Contract C2 partial-success reporting')`:
    - seeds a card subtree containing three cards, calls `delete_card({ ids: ['code-1', 'code-2', 'code-3'] })` where `code-2` has an open running process (deny by permission matrix) and `code-1`, `code-3` are deletable; asserts `success === true`, `data.partial === true`, `data.total === 3`, `data.succeeded === 2`, `data.failures` equals `[{ id: 'code-2', reason: <permission-matrix message> }]`, and the response text matches the literal C2 template. The chosen tool is `delete_card` accepting `ids: string[]` because MASTER-PLAN-r7 \u00a7S02 line 115 names `delete_card` and "a reconfigure batch" as the canonical batch-capable examples for the C2 unit-test coverage; `queue_notification` stays single-recipient per SPEC-r7 and is not used for the C2 test.
  - `describe('Contract C3 unknown-internal-capability reply')`:
    - stubs `globalThis.fetch` (via the same transport-mock pattern as `tests/agents/analyst-llm-resolver.integration.test.ts`) to return a chat-completion response whose first `tool_calls[0].function.name = 'invent_a_tool'`; asserts the response content matches the literal C3 template and that no audit-log entry was written.
  - `describe('Contract C4 conversational confirmation flow')`:
    - sends `delete card code-1`; asserts the response is the C4 preview template with `N=1` and no mutation.
    - sends `yes`; asserts the deletion is committed.
    - resets, sends `delete card code-1`, then sends `no`; asserts no mutation and audit entry `outcome === "cancelled"`.
    - resets, sends `delete card code-1`, then sends `delete card code-2`; asserts the first invocation is discarded and the second begins a new C4 cycle.
    - resets, sends `delete card code-1`, advances mocked clock by `CONFIRMATION_TTL_MS + 1`, sends `yes`; asserts the stored invocation is discarded and the `yes` is treated as a free-standing C1 unsupported-action message.
- `saivage-v3/tests/agents/analyst-tool-runner.test.ts` — new file.
  - asserts `runAuditedAnalystTool` records exactly one control-action audit entry per invocation, with `outcome` in `{"ok","error","cancelled","denied","rejected"}`.
  - asserts the secret-classifier gate denies `.saivage/auth-profiles.json` reads in `read_file`, `list_directory`, and `run_shell_command` without exposing the file contents in the error message.
- `saivage-v3/tests/agents/role-tool-policy.test.ts` — extend existing file.
  - asserts the analyst tool list in `ROLE_TOOL_NAMES.analyst` matches the S02 capability-class fixture.
  - asserts `assertAnalystSurfaceTool('run_shell_command', 'telegram')` denies.
- `saivage-v3/tests/analyst.test.ts` — extend existing file.
  - replace any reference to `add_note`/`list_notes`/`get_note`/`mark_note_handled` with the new `queue_notification` surface where the test intent is to verify the analyst can queue planner work; remove tests that only exercised the v2 note-inbox semantics.

Test conventions inherited from the existing files: `@jest/globals` imports, `.js` extensions on TS path imports, `mkdtempSync(join(tmpdir(), 'saivage-...-'))` for ephemeral project roots, `setupProject(root)` to seed `.saivage` directories, `ctx(root, surface?)` factory.

**Test injection seam.** S02 does NOT change the `AnalystHandler` constructor signature; S01 explicitly chose Option A ("resolver-owned local `ProviderRegistry`… no constructor signature changes on `AnalystHandler` or on `getAnalystHandler`") and S02 keeps that contract. Tests that need to drive specific tool-call sequences from a fake LLM use the public transport-mock seam S01 already established: stub `globalThis.fetch` (or the per-provider transport already mocked in `tests/agents/analyst-llm-resolver.integration.test.ts`) to return a chat-completion response containing the desired `tool_calls` array. This keeps the resolver, the registry, and the role policy fully exercised by every test rather than bypassed by a constructor-injected fake resolver.

## Acceptance criteria

Each criterion is a host-runnable command and an expected outcome. Commands assume cwd is `/home/salva/g/ml` unless noted.

- **A1** — Type check passes after S02 edits.
  - Command: `( cd saivage-v3 && npx tsc -p . )`
  - Expected: exit 0, no `error TS<code>` lines.
- **A2** — Jest passes the analyst surface tests.
  - Command: `( cd saivage-v3 && npx jest tests/agents/analyst-tool-surface.test.ts tests/agents/analyst-tool-runner.test.ts tests/agents/role-tool-policy.test.ts tests/analyst.test.ts )`
  - Expected: exit 0, every suite green, no `--testPathIgnorePatterns` skips.
- **A3** — Tool registry is in 1:1 correspondence with SPEC-r7 capability classes.
  - Command: `( cd saivage-v3 && node -e "const t = require('./dist/agents/analyst-llm-resolver.js'); console.log(JSON.stringify(Object.keys(t.TOOL_REGISTRY).sort()))" )` after `npx tsc -p .`
  - Expected: emits the sorted JSON array equal to the capability-class fixture asserted by the test in A2.
- **A4** — Retired v2 note-inbox tools are gone from every exported surface.
  - Command: `grep -RnE "\b(add_note|list_notes|get_note|mark_note_handled)\b" saivage-v3/src/agents saivage-v3/src/tools | grep -v '/cards/' | grep -v 'role-tool-policy' || true`
  - Expected: zero matches (the `grep -v` clauses allow shared `cards/` primitives used by non-analyst surfaces; `role-tool-policy.ts` is allowed to mention retired names only inside a non-analyst role list).
- **A5** — Every analyst inspect tool routes through the single non-secret classifier.
  - Command: `grep -nE "assertNotSecretPath|looksLikeSecretPath" saivage-v3/src/agents/analyst-tools.ts`
  - Expected: zero matches (all calls now sit in `analyst-tool-runner.ts` or `analyst-secret-classifier.ts`).
- **A6** — Every mutating analyst tool routes through one shared audit wrapper.
  - Command: `grep -nE "\brunMutatingTool\b" saivage-v3/src/agents/analyst-tools.ts`
  - Expected: zero matches (the private wrapper is gone; all mutations import `runAuditedAnalystTool`).
- **A7** — The system prompt enumerates every capability class.
  - Command: `node -e "const t = require('./saivage-v3/dist/agents/analyst-llm-resolver.js'); for (const c of ['Inspect','Navigate','Mutate cards','Queue notifications','Control the runtime','Reconfigure','Investigate and repair']) { if (!t.getAnalystSystemPrompt().includes(c)) { console.error('missing: ' + c); process.exit(1); } } console.log('ok')"`
  - Expected: prints `ok` and exits 0.
- **A8** — Four-gate harness diff against S00 baseline records every new failure in the cumulative ledger and records no untriaged regressions.
  - Command: `bash saivage-v3/SPEC/analyst-as-control-surface/PLAN/scripts/run-gates.sh --diff saivage-v3/SPEC/analyst-as-control-surface/PLAN/baseline-gates.json`
  - Expected: exits 0 when every NEW failing-id (any id not in the baseline `failing_ids` array for the same gate) is appended as an H3 entry under `## Open entries` in `saivage-v3/SPEC/analyst-as-control-surface/PLAN/expected-breakage-ledger.md` with the S00-pinned four-line shape and a `Target fix stage:` in `S03..S10`. The driver also exits non-zero if any prior-stage H3 block whose `Target fix stage:` is `S02` is still present after S02 lands and the corresponding failing-id is no longer observed in the fresh snapshot (S02 must have removed it).

## Downstream impact

This section enumerates every workspace file or directory whose contract S02 perturbs, names the holistic fix S02 commits to (so the perturbation is not deferred behind a migration shim), and lists the validation gate that will catch the perturbation if the holistic fix is incomplete. The list follows MASTER-PLAN-r7 §6.1 "Downstream impact statements".

- [saivage-v3/src/agents/analyst-handler.ts](../../../src/agents/analyst-handler.ts) — the tool-dispatch loop's literal strings (`'Unknown tool:'`, `'Error: '`) are replaced by the C3 and C1 templates; the pre-dispatch hook for contract C4 is added.
  - Holistic fix: replace both literals in the same commit; export `ANALYST_UNKNOWN_CAPABILITY_TEMPLATE(name)` and `ANALYST_UNSUPPORTED_ACTION_TEMPLATE(class, names)` from a new `analyst-response-templates.ts` so callers (tests and the resolver) reference one source of truth.
  - Catching gate: `tsc-build` (export name change), `analyst-e2e` (the existing `Unknown tool:` checker scenario must be updated in the same stage).
- [saivage-v3/src/agents/analyst-llm-resolver.ts](../../../src/agents/analyst-llm-resolver.ts) — `TOOL_REGISTRY`, `ANALYST_TOOL_DEFINITIONS`, and `ANALYST_SYSTEM_PROMPT` gain/lose entries; `RoleToolPolicy.decide` is consulted before returning a tool call.
  - Holistic fix: every retired tool is removed from all three exports in one commit; every new tool is added to all three. The invariant test in `analyst-tool-surface.test.ts` asserts the three lists agree.
  - Catching gate: `tsc-build`, `web-vitest` (UI imports of `ANALYST_TOOL_NAMES`), `analyst-e2e`.
- [saivage-v3/src/agents/analyst-tools.ts](../../../src/agents/analyst-tools.ts) — retired exports removed, new exports added, the private `runMutatingTool` deleted and re-imported from the new runner module.
  - Holistic fix: every import of a retired symbol in the repo is rewritten in the same commit. Detection: `grep -RnE '\b(add_note|list_notes|get_note|mark_note_handled)\b' saivage-v3/src saivage-v3/tests saivage-v3/web/src` must report only non-analyst (`cards/`) call sites or zero hits.
  - Catching gate: `tsc-build` (broken imports), `web-vite-build` (Vue imports), `web-vitest`.
- [saivage-v3/src/agents/analyst-tool-schemas.ts](../../../src/agents/analyst-tool-schemas.ts) — schema list reshaped; `ANALYST_TOOL_NAMES` reshaped.
  - Holistic fix: regenerate `ANALYST_TOOL_NAMES` from `Object.keys(TOOL_REGISTRY).sort()` programmatically; never hand-list. The invariant test asserts the two lists agree.
  - Catching gate: `tsc-build`, the inventory test in `analyst-tool-surface.test.ts`.
- [saivage-v3/src/agents/role-tool-policy.ts](../../../src/agents/role-tool-policy.ts) — `ROLE_TOOL_NAMES.analyst` is rebuilt from the new analyst registry.
  - Holistic fix: `ROLE_TOOL_NAMES.analyst = Object.keys(TOOL_REGISTRY).sort()` (filtered by surface restrictions); the new `assertAnalystSurfaceTool` helper centralizes the surface deny.
  - Catching gate: `tsc-build`, the role-policy test extension in `tests/agents/role-tool-policy.test.ts`.
- [saivage-v3/src/tools/agent-tools.ts](../../../src/tools/agent-tools.ts) — the shared agent-tool registry must agree with the analyst registry.
  - Holistic fix: removed/added entries land in the same commit as `analyst-tool-schemas.ts`; `AGENT_TOOL_DEFINITIONS[*].roles` arrays mirror `role-tool-policy.ts`.
  - Catching gate: `tsc-build`, `web-vite-build` (the UI builds AGENT_TOOL_DEFINITIONS into the bundle through `web/src/lib/tool-registry.ts` or similar).
- [saivage-v3/src/workspace/secret-paths.ts](../../../src/workspace/secret-paths.ts) — no edits; the file remains the implementation source of truth. The new `analyst-secret-classifier.ts` wraps it.
  - Holistic fix: every direct import of `assertNotSecretPath` or `looksLikeSecretPath` in `saivage-v3/src/agents/` is rewritten to import from `analyst-secret-classifier.ts`. Detection: `grep -nE 'assertNotSecretPath|looksLikeSecretPath' saivage-v3/src/agents/*.ts` must report only `analyst-secret-classifier.ts`.
  - Catching gate: A5; `tsc-build`.
- [saivage-v3/tests/analyst.test.ts](../../../tests/analyst.test.ts) — every reference to the four retired note-inbox tool names is deleted or rewritten against `queue_notification`.
  - Holistic fix: the tests are rewritten in the same commit; no test is `xit`'d or skipped. Tests that asserted the v2 note-inbox semantics (which the SPEC removes) are deleted outright.
  - Catching gate: `analyst-e2e` regression (the e2e checker must still pass) and the test execution in A2.
- [saivage-v3/tests/agents/analyst-llm-resolver.integration.test.ts](../../../tests/agents/analyst-llm-resolver.integration.test.ts) — the transport-mock pattern remains the test seam for new contract tests.
  - Holistic fix: no edits required at S02; new contract tests reuse the same `globalThis.fetch` stub helper.
  - Catching gate: A2.
- [saivage-v3/src/agents/analyst-config-writer.ts](../../../src/agents/analyst-config-writer.ts) — new module; see "Config persistence module" above. Adds the 8 exported functions and the `ConfigWriteResult` type.
  - Holistic fix: the module lands in the same commit as `analyst-tools.ts`'s `reconfigure` and `show_config` handlers; every sub-action is wired to the corresponding setter so no `not_yet_available` reply remains.
  - Catching gate: `tsc-build` (new module compiles), A2 (handler tests exercise every sub-action against a tmpdir project root), the inventory test asserts `TOOL_REGISTRY.reconfigure` is present.
- [saivage-v3/src/server/server.ts](../../../src/server/server.ts) — the `ServerInstance` interface gains `requestRestart(): Promise<void>`; the concrete implementation in `createServer` is extended to match, and the `createServer` body is restructured to build the return value into `const instance: ServerInstance = { ... }` so that `activeRuntime.setServer(instance)` can be called before the function returns.
  - Holistic fix: the interface change, the `requestRestart` closure, and the `activeRuntime.setMcpManager(mcpManager)` / `activeRuntime.setServer(instance)` wiring all land in the same commit; every existing implementer or mock of `ServerInstance` (tests, the `boot/app.ts` wiring) adds the new method or imports the real `createServer`.
  - Catching gate: `tsc-build` (interface change forces every implementer to compile against the new shape).
- [saivage-v3/src/runtime/active-runtime.ts](../../../src/runtime/active-runtime.ts) — the class gains `setMcpManager(m: McpManager)`, `setServer(s: ServerInstance)`, and matching `mcpManager` / `server` accessors (currently only `runtime`, `eventLogger`, `errorLogger`, `agentAdapter`, `skillsEngine` are exposed). The existing constructor-time wiring of `agentAdapter.setMcpManager(mcpManager)` and `mcpManager.setEventLogger(...)` is forwarded through `setMcpManager` so the two construction call sites (`src/server/server.ts:108` and `tests/runtime/runtime-activation-ledger.test.ts:140`) keep working unchanged at the constructor signature.
  - Holistic fix: the two new setters and accessors land in the same commit as the `reconfigure` MCP sub-action wiring and the `requestRestart` wiring; the existing constructor parameter is preserved so the ledger test does not need to change.
  - Catching gate: `tsc-build`, A2 (handler tests for `reconfigure` exercise `ctx.activeRuntime.mcpManager` via a real `ActiveRuntime`).
- [saivage-v3/src/mcp/mcp-manager.ts](../../../src/mcp/mcp-manager.ts) — the class gains one new public method, `reloadServersFromConfig(): void`, which re-runs `loadConfig(this.projectRoot)` then `normalizeMcpServers(config)` and reassigns `this.servers`. The per-name lifecycle methods `startServer`, `stopServer`, `restartServer` are unchanged.
  - Holistic fix: the new method lands in the same commit as the `reconfigure` MCP sub-actions that depend on it; the existing in-memory caches (`handles`, `toolsCache`, `discoveryErrors`, `_invocationQueues`) are explicitly NOT touched because they are keyed by server name and are managed by the per-name lifecycle methods.
  - Catching gate: `tsc-build`, A2 (the new MCP sub-action tests assert that `mcpManager.getStatus()` reports the added entry after `mcp_add`, the new command after `mcp_edit`, and drops the entry after `mcp_remove`).
- [saivage-v3/src/runtime/runtime.ts](../../../src/runtime/runtime.ts) — the `RuntimeCommandSource` union (line 545 `startProject(source)`, line 587 `stopProject(source)`) is extended to include `'analyst'`, matched in [saivage-v3/src/runtime/state.ts](../../../src/runtime/state.ts) (line 168 `appendRuntimeCommand(projectRoot, command, source)`).
  - Holistic fix: the union extension lands in the same commit as the analyst `start_project` / `stop_project` / `terminate_process` wrappers; every existing call site that destructures the union is checked at compile time. No exhaustive `switch` on this union currently exists in the codebase, so no `default: never` branch must be added.
  - Catching gate: `tsc-build`.
- Downstream stages (S03..S10) consume the surfaces S02 freezes:
  - **S03** consumes the `reorder_child` and `move_card` schemas; replaces the typed `not_yet_available` reply with a real bounded-move implementation.
  - **S04** consumes the `queue_notification` schema; replaces the typed `not_yet_available` reply with the persistent queue mechanic.
  - **S05** owns the persistent right-panel layout (no analyst tool change) — S02 must not touch any Vue file in `saivage-v3/web/src/`.
  - **S06** consumes `runAuditedAnalystTool` as the sole mutation entry point; removes Vue button mutations.
  - **S07** consumes the per-tool role-policy minimums S02 sets.
  - **S08** consumes the `navigate_workspace` and `navigate_back` schemas; wires the SPA route change and the per-turn current-view propagation back to the analyst.
  - **S09** consumes the audit-entry shape S02 freezes (the new `outcome` values `cancelled`, `amended`, `expired`).
  - **S10** reconciles every cumulative-ledger entry S02 carried forward.

## Breakage forecast — predicted NEW failing-ids

The four-gate harness runs `tsc-build`, `web-vite-build`, `web-vitest`, `analyst-e2e`. Each predicted entry below is conditional: if the gate run after S02 lands does NOT add the id to the new set, do not write the entry. If it does, append exactly the block below, verbatim, under the `## Open entries` H2 heading in `saivage-v3/SPEC/analyst-as-control-surface/PLAN/expected-breakage-ledger.md`. Every block uses the S00-pinned shape with `Target fix stage:` restricted to `S03..S10`. The `Recorded by:` date placeholder `<YYYY-MM-DD>` is filled with the actual UTC date observed at close-out time.

### tsc-build:saivage-v3/tests/agents/analyst-inspection-tools.test.ts:1:TS2305

Failure mode: An existing inspection test imports `assertNotSecretPath` / `looksLikeSecretPath` from `analyst-tools.ts` for a regression assertion that no longer holds after the classifier moves to `analyst-tool-runner.ts` (the re-export through `analyst-tools.ts` is intentionally removed to enforce the single-source-of-truth classifier).
Reason acceptable now: S02 deliberately removes the analyst-tool re-export to enforce the single-source-of-truth secret classifier; re-anchoring this test on the new module is part of the broader S10 test reconciliation.
Target fix stage: S10
Recorded by: S02 / <YYYY-MM-DD>

### analyst-e2e:scenario-queue-notification:step-1

Failure mode: The conversational e2e flow that asks the analyst to notify a planner returns the typed `not_yet_available` reply S02 declares, which the e2e checker does not yet recognize as a valid terminal state.
Reason acceptable now: The persistent notification queue is owned by S04; S02 only declares the tool surface. The checker needs the queue mechanic before this scenario can pass.
Target fix stage: S04
Recorded by: S02 / <YYYY-MM-DD>

### analyst-e2e:scenario-reorder-child:step-1

Failure mode: The conversational e2e flow that asks the analyst to reorder children of a goal returns the typed `not_yet_available` reply S02 declares.
Reason acceptable now: The bounded-move data model is owned by S03; S02 only declares the tool surface so the response-shape contract pinning is complete.
Target fix stage: S03
Recorded by: S02 / <YYYY-MM-DD>

### analyst-e2e:scenario-navigate-workspace:step-2

Failure mode: The conversational e2e flow that asks the analyst to focus a transcript expects the left-panel route to change and the analyst's next turn to observe the new current-view; S02 returns the navigation payload but the SPA does not yet observe it.
Reason acceptable now: The SPA route change and the per-turn current-view propagation back to the analyst are owned by S08; the persistent right-panel surface is owned by S05.
Target fix stage: S08
Recorded by: S02 / <YYYY-MM-DD>

### web-vitest:web/src/__tests__/dashboard-mutations.test.ts:1

Failure mode: A vitest case asserts that clicking a "Pause Runtime" button in the dashboard mutates runtime state directly; after S02 the only mutation entry point is the analyst tool, so the test exercises a path that is being retired.
Reason acceptable now: Dashboard mutation buttons are removed in S06; the test will be deleted alongside the button.
Target fix stage: S06
Recorded by: S02 / <YYYY-MM-DD>

## Out of scope (explicit deferral)

- Card data-model and ordered-children mutations: S03.
- Persistent notification queue mechanic: S04.
- Right-panel persistence and selection storage: S05.
- Dashboard UI mutation button removal: S06.
- Operator API pruning to per-capability-class minimums: S07.
- Analyst-driven dashboard navigation observer wiring: S08.
- `analyst_tool_invoked` event payload cleanup and events surface: S09.
- Test-suite consolidation and ledger reconciliation: S10.
