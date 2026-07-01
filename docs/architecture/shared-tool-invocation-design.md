# Shared Tool Invocation Design

Status: design proposal.

Date: 2026-07-01

## 1. Purpose

Saivage currently has duplicated tool execution logic across the Analyst chat path and the micro-actor card processors. Parsing, policy checks, error normalization, and workspace tool routing are split across several modules.

This document specifies a shared invocation layer that removes the duplication while preserving the semantic difference between:

- Analyst as the global operator-facing chat/control surface.
- Planner, executor, and reviewer as card-scoped runtime workers.

The target is a single function backed by the unified tool catalog — not a service object, an adapter registry, or a compatibility layer.

## 2. Current Shape

### Analyst path

The Analyst is handled by `src/agents/analyst-handler.ts`.

- It owns a global conversational loop backed by `LLMActor`.
- It builds Analyst-specific system prompts and workspace context.
- It uses `ToolDispatcher` with `AnalystAdapter`.
- It passes an Analyst `ToolContext` containing project root, card store, runtime controls, MCP manager, event bus, and restart hooks.
- It enforces Analyst control-surface policy with `ControlActionSurface` and `RoleToolPolicy.assertAnalystSurfaceTool`.
- It emits Analyst activity and broadcasts `analyst_tool_invoked` events.
- It shapes some tool results into operator-facing final replies.

### Card processor paths

Planner, executor, and reviewer tool calls are handled inside runtime actors under `src/runtime/actors/`.

- Planner uses `ActorToolSurface` for planner-owned card mutation tools and direct `processWorkspaceToolCall(...)` calls for workspace tools.
- Executor owns process lifetimes directly through `ProcessActor` and also calls `processWorkspaceToolCall(...)` for workspace tools.
- Reviewer calls `processWorkspaceToolCall(...)` for its inspection tools.
- The terminal tool `emit_result` is a contract tool validated by the processor loops, not a generic tool. Each role receives its own valid status subset.

### Duplication

| Concern | Analyst today | Card processors today | Problem |
| --- | --- | --- | --- |
| Tool envelope parsing | `ToolDispatcher` parses JSON envelopes | Processors receive `LLMActorOutcome.args` and stringify for workspace tools | Different error behavior and validation boundaries. |
| Policy checks | `ToolDispatcher` + Analyst surface policy | Role-specific code paths and workspace tool processors | Same authority concepts are expressed in different places. |
| Workspace tools | Analyst uses `TOOL_REGISTRY` through `AnalystAdapter` | Processors call `processWorkspaceToolCall(...)` | Similar file/search/record behavior is not invoked through one path. |
| Error normalization | `ToolResult`, `AdapterResult`, `ToolDispatchResult` | Ad hoc `{ success: false, error }` objects | Tool results have inconsistent shape and metadata. |
| Tool definitions | Analyst prompt registry, actor tool definitions, contract tool definitions | Actor-local arrays and surfaces | The catalog is not a single execution source. |
| Unknown tools | Analyst adapter catches all names and returns Analyst text | Processors return or throw unsupported-tool errors | Unknown-tool semantics differ by accident rather than design. |

## 3. Design Goals

1. Keep role orchestration explicit. Analyst chat behavior, planner sequencing, executor process ownership, reviewer assessment, and terminal result validation remain role-specific.
2. Share mechanics below orchestration. Argument parsing, tool lookup, invocation, and result normalization should be a single function, not a service hierarchy.
3. Make tool surfaces explicit. A tool is available because the role's tool list registers it — not because an adapter silently accepts every name.
4. Preserve actor ownership boundaries. Executor background processes remain owned by the executor activation. Planner child activation remains owned by the planner processor. Analyst runtime control remains Analyst/operator scoped.
5. No compatibility shims. This is an internal refactor. `ToolDispatcher` is deleted in the same change that introduces the shared path. Dead aliases are removed, not wrapped.

## 4. Non-Goals

- Do not merge Analyst into the card runtime. Analyst remains a global operator-facing agent.
- Do not let Analyst call terminal contract tools.
- Do not let planner/executor/reviewer call Analyst-only runtime control or navigation tools.
- Do not introduce a new compatibility layer for retired tool names.
- Do not move process ownership out of the executor actor in the initial refactor.
- Do not introduce an adapter registry, a service object, or a normalized-request type. The shared layer is a function plus the catalog.
- Do not introduce provider-visible tool-name changes as part of this design. Naming changes belong to [Tool Set Reorganization Design](./tool-set-reorganization-design.md); this shared invocation layer uses that document's final names.

## 5. Design

A single function, backed by the unified tool catalog, replaces the duplicated dispatch paths.

### 5.1 The catalog

The tool reorganization ([Tool Set Reorganization Design](./tool-set-reorganization-design.md)) produces one catalog where each tool name maps to an executor function:

```ts
type ToolExecutor = (ctx: ToolContext, args: Record<string, unknown>) => Promise<ToolResult>;

interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: ZodSchema;
  executor: ToolExecutor;
}
```

The catalog is the single source of tool schemas and executor functions. Role surfaces are curated subsets of it — plain arrays of tool names per role, already represented by `actor-tool-definitions.ts` and the Analyst surface.

### 5.2 The invocation function

```ts
async function invokeTool(ctx: ToolContext, name: string, args: Record<string, unknown>): Promise<ToolResult> {
  const definition = TOOL_CATALOG.get(name);
  if (!definition) return { success: false, error: `Unknown tool '${name}'.` };
  const parsed = definition.inputSchema.safeParse(args);
  if (!parsed.success) return { success: false, error: parsed.error.message };
  return definition.executor(ctx, parsed.data);
}
```

That is the entire shared layer. Unknown names and invalid arguments are tool errors, not thrown exceptions. Authority is enforced by:

- The per-role tool list (what the provider is allowed to see and call).
- The path-scope policy inside filesystem/process tools (`project://`, `record://`, `tmp://`, `system://`, slot-writer rules, role-restricted `project://` writes).
- The semantic policy already encoded in executor functions that branch on `ctx.agentRole` where it matters (e.g. `create_card` is planner-scoped, `activate_card` is planner-only).

No second policy gate, no adapter category lookup, no normalized request type.

### 5.3 The context

Each role constructs the context it actually needs. The context is role-typed, not a bag of optional capabilities:

```ts
interface ToolContext {
  projectRoot: string;
  agentRole: 'planner' | 'executor' | 'reviewer' | 'analyst';
  cardId?: string;
  cardStore?: CardStore;
  runtime?: RuntimeControlPort;
  mcpManager?: McpManager;
  eventBus?: EventBus;
  processOwner?: ExecutorProcessOwner;
  analystSurface?: ControlActionSurface;
}
```

Callers populate the fields they own. The executor functions access what they need and ignore the rest. An executor that requires a capability not present (e.g. `processOwner` for `run_command` outside the executor) throws — fail fast, no silent denial.

### 5.4 The result

```ts
interface ToolResult {
  success: boolean;
  data?: unknown;
  error?: string;
}
```

One result type. The caller — Analyst handler or card processor — serializes it for the provider. No separate `modelContent` field, no `errorKind`, no `metadata` bag. Information the caller needs for UI events or control decisions (e.g. process start, card mutation) is returned in `data` as a plain object.

### 5.5 Terminal tools

`emit_result` stays in the processor loops. It is not a catalog tool, not an adapter, and not passed through `invokeTool`. Terminal validation is role-specific contract logic that drives card lifecycle transitions; it does not belong in a shared side-effect tool path.

### 5.6 Analyst audit and events

The Analyst handler wraps `invokeTool` with its own pre/post hooks for audit logging, `analyst_tool_invoked` event broadcasts, and response shaping. These are Analyst-specific concerns; they live in the Analyst handler, not in the shared function or the catalog. Card processors do not need them.

## 6. Role Orchestration After Refactor

### Analyst

`AnalystHandler` keeps responsibility for:

- Session queueing.
- Workspace context note insertion.
- Analyst prompt construction.
- Analyst activity callbacks.
- `analyst_tool_invoked` event broadcasts.
- Mapping selected tool results to final operator replies.
- Pre/post audit hooks around `invokeTool`.

It delegates execution mechanics to `invokeTool` with an Analyst-flavored context. Unknown tools return a normal `ToolResult` error — no catch-all adapter.

### Planner

`PlanningCardProcessorActor` keeps responsibility for:

- Parent/child ownership checks.
- Active child actor lookup.
- Activation result delivery.
- Planner terminal contract validation and reviewer launch.

It delegates workspace and card-mutation tools to `invokeTool`. `activate_card` remains direct processor code — it is a sequencing boundary, not a side-effect tool.

### Executor

`TerminalCardProcessorActor` keeps responsibility for:

- Process actor retention and shutdown.
- Owned process lifecycle.
- Executor terminal contract validation.

It delegates `run_command`, `wait_process`, and `kill_process` to `invokeTool`. The activation-local `processOwner` is passed in the executor context; generic code cannot outlive the activation because the context is constructed per activation and discarded on settlement.

### Reviewer

The reviewer loop keeps responsibility for:

- Review prompt construction.
- Review record-slot expectations.
- Reviewer terminal contract validation, including `rework` as the send-back result.

It delegates workspace/record/MCP tools to `invokeTool`. Reviewer filesystem access is not read-only: the reviewer may `write`/`edit` only its own `record://review.md` slot, while `project://` mutation and `apply_patch` remain unavailable (enforced by the path-scope policy inside `write`/`edit`, not by a reviewer-specific adapter).

## 7. Migration Plan

One phase. No temporary wrappers.

1. Build the unified `TOOL_CATALOG` from the tool reorganization (one entry per tool name, with executor function and input schema).
2. Add `invokeTool(ctx, name, args) → ToolResult`.
3. Point card processors at `invokeTool` for workspace tools; delete `processWorkspaceToolCall` ad-hoc dispatch where it now duplicates the catalog.
4. Point the Analyst handler at `invokeTool`; delete `ToolDispatcher` and `AnalystAdapter` in the same change. Move audit logging and event broadcasting into Analyst-handler pre/post hooks.
5. Delete the duplicated result types (`AdapterResult`, `ToolDispatchResult`). Everything returns `ToolResult`.
6. Update tests that asserted old adapter internals to assert `invokeTool` behavior instead.

## 8. Validation Strategy

Focused tests should cover:

- Unknown tool handling: `invokeTool` returns `{ success: false, error }` for names not in the catalog, for every role surface.
- Invalid arguments: schema parse failure returns a model-visible tool error, not a thrown exception.
- Workspace tool validation errors return model-visible tool errors, not thrown activation failures.
- Analyst policy denials by `ControlActionSurface` ( Analyst-handler pre-hook, not `invokeTool`).
- Planner immediate-child card mutation policy (inside the card tool executor, branching on `ctx.agentRole`).
- Executor process lifecycle ownership and cleanup after activation settlement (context constructed per activation, `processOwner` discarded on settlement).
- Reviewer record-only mutation policy: `write`/`edit` may touch only `record://review.md`; `project://` mutation and `apply_patch` are denied (enforced inside the filesystem tool executors, not by a reviewer adapter).
- MCP invocation denial when MCP is unavailable (inside the `mcp_tool_call` executor).

End-to-end validation should include:

- One Analyst workspace read or card inspection tool call.
- One planner workspace read and child card mutation.
- One executor file or process tool call.
- One reviewer workspace read.
- One terminal contract success path for each card role.

## 9. Risks

| Risk | Mitigation |
| --- | --- |
| Shared function hides role-specific authority | Authority lives in the per-role tool list and the path-scope policy inside tool executors, not in the shared function. The function does one thing: look up and run. |
| Analyst audit/events drift | Audit and event broadcasting stay in the Analyst handler as pre/post hooks; `invokeTool` has no side effects beyond the tool itself. |
| Executor process actors outlive activation | Context is constructed per activation and discarded on settlement; `processOwner` is not global. |
| Terminal result lifecycle becomes over-generic | Terminal tools stay in processor loops; they are never passed through `invokeTool`. |

## 10. Open Questions

1. Should terminal tools ever be unified with the catalog, or is direct processor validation permanently clearer? Current answer: direct processor validation. `emit_result` drives lifecycle transitions; it is not a side-effect tool.
2. Should `activate_card` stay direct processor code permanently, or become a catalog tool that calls a processor-owned activation port? Current answer: direct processor code. It is a sequencing boundary.

These are answered with the simplest option. If a concrete need to unify appears later, the function-based design makes that change additive, not structural.