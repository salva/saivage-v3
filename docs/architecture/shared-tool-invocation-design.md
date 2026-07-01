# Shared Tool Invocation Design

Status: design proposal.

Date: 2026-07-01

## 1. Purpose

Saivage currently has duplicated tool execution logic across the Analyst chat path and the micro-actor card processors. Parsing, policy checks, error normalization, and workspace tool routing are split across several modules.

This document specifies a shared invocation layer that removes the duplication while preserving the semantic difference between:

- Analyst as the global operator-facing chat/control surface.
- Planner, executor, and reviewer as card-scoped runtime workers.

The target is a single function backed by the unified tool catalog — not a service object, an adapter registry, or a compatibility layer.

This design depends on the unified tool catalog from [Tool Set Reorganization Design](./tool-set-reorganization-design.md). It lands after that catalog exists.

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

The catalog is the single source of tool schemas and executor functions for ordinary side-effect tools. The provider-visible tool surface for each role is the union of:

1. The **invocation surface** — ordinary catalog tools dispatched through `invokeTool`.
2. **Processor-owned control tools** — handled directly by the card processor loops, never passed through `invokeTool`.

Two provider-visible tools are processor-owned:

| Tool | Class | Reason |
| --- | --- | --- |
| `activate_card` | Processor-owned | Sequencing boundary that dispatches a child actor; not a side-effect tool. |
| `emit_result` | Processor-owned | Terminal contract that closes the activation and drives card lifecycle transitions. |

Everything else the provider sees is a catalog tool dispatched through `invokeTool`.

### 5.2 Invocation surfaces

An invocation surface is the ordinary-tool subset of the catalog for one role, built once. It is distinct from the full provider-visible surface, which additionally includes processor-owned control tools (`activate_card`, `emit_result`). Building the surface is a setup-time operation that fails fast: if a configured tool name is missing from the catalog, the surface constructor throws — a code/configuration error, not a model error.

```ts
interface InvocationSurface {
  readonly role: AgentRole;
  readonly tools: ReadonlyMap<string, ToolDefinition>;
}

function buildInvocationSurface(role: AgentRole, names: readonly string[], capabilities: { mcpAvailable: boolean }): InvocationSurface {
  const tools = new Map();
  for (const name of names) {
    const definition = TOOL_CATALOG.get(name);
    if (!definition) throw new Error(`Tool '${name}' for role '${role}' is not in the catalog.`);
    if (name === 'mcp_tool_call' && !capabilities.mcpAvailable) throw new Error(`'mcp_tool_call' registered for role '${role}' but MCP is unavailable; omit it from the tool list instead of denying at runtime.`);
    tools.set(name, definition);
  }
  return { role, tools };
}
```

Invocation surfaces are constructed once per role/capability configuration and reused across activations. Activation-local state such as `processOwner` lives only in `ExecutorToolContext`, never in the surface.

### 5.3 The invocation function

```ts
async function invokeTool(surface: InvocationSurface, ctx: ToolContext, name: string, args: unknown): Promise<ToolResult> {
  if (surface.role !== ctx.role) throw new Error(`Tool surface role '${surface.role}' does not match context role '${ctx.role}'.`);
  const definition = surface.tools.get(name);
  if (!definition) return { success: false, error: `Unsupported tool '${name}' for role '${surface.role}'.` };
  const parsed = definition.inputSchema.safeParse(args);
  if (!parsed.success) return { success: false, error: parsed.error.message };
  return definition.executor(ctx, parsed.data);
}
```

That is the entire shared layer. The `surface.role !== ctx.role` check is fail-fast for a programmer error (mismatched caller wiring), not a model error.

Three failure modes, all explicit:

- **Setup/configuration error** — `buildInvocationSurface` throws if a configured tool name is missing from the catalog, or if a tool requiring a capability (e.g. `mcp_tool_call`) is registered when that capability is unavailable. These are code/config bugs; fail fast.
- **Programmer error** — `invokeTool` throws if the surface role and context role do not match, or if a tool executor is called with the wrong role/context (e.g. `run_command` with a planner context). These are impossible states under correct wiring; throw.
- **Model error** — `invokeTool` returns `{ success: false, error }` if the model calls a tool absent from the role surface, passes invalid arguments, or hits a legitimate runtime denial (path policy, slot-writer rule, permission). These are model output or legitimate runtime state; surface a tool error, do not crash the activation.

Authority is enforced by three explicit boundaries, no policy engine:

1. The invocation surface (which ordinary tools the provider sees and `invokeTool` accepts).
2. The path-scope policy inside filesystem/process tools (`project://`, `record://`, `tmp://`, `system://`, slot-writer rules, role-restricted `project://` writes).
3. Tool executors assert the context they require and throw if called with the wrong role/context (e.g. `create_card` asserts planner/analyst context; `run_command` asserts executor context with `processOwner`). Tools do not branch broadly on role — they assert the single context shape they need.

**Tool executor contract.** `invokeTool` does not catch executor exceptions. Tool executors must follow this rule:

- Expected/model/project failures (path denied, slot-writer violation, card not found, command failed) → return `{ success: false, error }`.
- Impossible programmer/configuration states (wrong context role, missing required capability that should have been enforced at surface construction) → throw.

This keeps `invokeTool` transparent: it never swallows a bug as a silent tool error, and it never crashes the activation for expected model output.

### 5.4 The context

The context is a discriminated union of role-specific contexts, not an optional capability bag. Each role constructs the context it actually has; tools assert the context shape they require and throw otherwise.

```ts
type ToolContext = AnalystToolContext | PlannerToolContext | ExecutorToolContext | ReviewerToolContext;

interface AnalystToolContext {
  role: 'analyst';
  projectRoot: string;
  cardStore: CardStore;
  runtime: RuntimeControlPort;
  mcpManager: McpManager;
  eventBus: EventBus;
  analystSurface: ControlActionSurface;
}

interface PlannerToolContext {
  role: 'planner';
  projectRoot: string;
  cardId: string;
  cardStore: CardStore;
}

interface ExecutorToolContext {
  role: 'executor';
  projectRoot: string;
  cardId: string;
  cardStore: CardStore;
  processOwner: ExecutorProcessOwner;
  mcpManager: McpManager;
}

interface ReviewerToolContext {
  role: 'reviewer';
  projectRoot: string;
  cardId: string;
  cardStore: CardStore;
  mcpManager: McpManager;
}
```

A tool that needs `processOwner` accepts `ExecutorToolContext` and throws on any other role — statically executor-only, no optional field, no silent denial.

### 5.5 The result

```ts
interface ToolResult {
  success: boolean;
  data?: unknown;
  error?: string;
}
```

One result type. The caller — Analyst handler or card processor — serializes it for the provider. No separate `modelContent` field, no `errorKind`, no `metadata` bag. Information the caller needs for UI events or control decisions (e.g. process start, card mutation) is returned in `data` as a plain object.

### 5.6 Terminal tools

`emit_result` stays in the processor loops. It is not a catalog tool, not an adapter, and not passed through `invokeTool`. Terminal validation is role-specific contract logic that drives card lifecycle transitions; it does not belong in a shared side-effect tool path.

### 5.7 Analyst audit and events

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

It delegates execution mechanics to `invokeTool` passing the Analyst invocation surface and an `AnalystToolContext`. Unknown tools return a normal `ToolResult` error — no catch-all adapter.

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
2. Add `InvocationSurface` and `invokeTool(surface, ctx, name, args) → ToolResult`.
3. Point card processors at `invokeTool` for workspace tools; delete `processWorkspaceToolCall`. Move any useful logic that lived only inside it into the canonical `read`/`write`/`glob`/`grep` executors so there is one dispatch path, not two.
4. Point the Analyst handler at `invokeTool`; delete `ToolDispatcher` and `AnalystAdapter` in the same change. Move audit logging and event broadcasting into Analyst-handler pre/post hooks.
5. Delete the duplicated result types (`AdapterResult`, `ToolDispatchResult`). Everything returns `ToolResult`.
6. Update tests that asserted old adapter internals to assert `invokeTool` behavior instead.

## 8. Validation Strategy

Focused tests should cover:

- Unknown tool handling: `buildInvocationSurface` throws if a configured name is missing from the catalog; `invokeTool` returns `{ success: false, error }` for names absent from the role invocation surface (even if they exist in the global catalog); nonexistent names from the model also return `{ success: false, error }`.
- Invalid arguments: schema parse failure returns a model-visible tool error, not a thrown exception.
- Workspace tool validation errors return model-visible tool errors, not thrown activation failures.
- Analyst policy denials by `ControlActionSurface` ( Analyst-handler pre-hook, not `invokeTool`).
- Planner immediate-child card mutation invariant: planner card tools assert planner/analyst context and reject non-immediate-child targets (inside the card tool executor).
- Executor process lifecycle ownership and cleanup after activation settlement (context constructed per activation, `processOwner` discarded on settlement).
- Reviewer record-only mutation policy: `write`/`edit` may touch only `record://review.md`; `project://` mutation and `apply_patch` are denied (enforced inside the filesystem tool executors, not by a reviewer adapter).
- MCP surface construction: `buildInvocationSurface` throws if `mcp_tool_call` is registered without MCP available; the tool is omitted from the surface instead of denied at runtime.

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

## 10. Explicit Decisions

These are decided, not open. If a concrete need to change them appears later, the function-based design makes that change additive, not structural.

1. Terminal tools (`emit_result`) stay direct processor validation. They drive card lifecycle transitions; they are not side-effect tools and never pass through `invokeTool`.
2. `activate_card` stays direct processor code. It is a sequencing boundary that dispatches a child actor, not a catalog tool.