# Shared Tool Invocation Design

Status: design proposal.

Date: 2026-07-01

## 1. Purpose

Saivage currently has duplicated tool execution logic across the Analyst chat path and the micro-actor card processors. Parsing, policy checks, error normalization, and workspace tool routing are split across several modules. Tool definitions live in a global catalog of detached functions that receive a context bag and must assert their own role.

This document specifies a tool architecture built on **ToolProviders** — objects that implement the tools for the domain they own. Card management tools are methods on the planner actor. Process tools are methods on the executor actor. Generic tools (filesystem, web, inspection) live in reusable providers constructed with minimal context. There is no global catalog of detached functions and no context bag.

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

### Problems

| Concern | Problem |
| --- | --- |
| Tool definitions | A global catalog of detached functions. Each receives a `ToolContext` bag and must assert its own role. Card tools, process tools, and filesystem tools are all in the same flat file with no cohesion. |
| Context bag | `ToolContext` is a bag of optional capabilities. Tools dig through it and assert what they need. Role is a runtime check, not a structural guarantee. |
| Duplication | Analyst uses `ToolDispatcher` + `AnalystAdapter`. Card processors use `processWorkspaceToolCall`. Same workspace behavior runs through two paths. |
| Error normalization | `ToolResult`, `AdapterResult`, `ToolDispatchResult` — three result shapes. |
| Unknown tools | Analyst adapter catches all names. Processors throw. Inconsistent by accident. |

## 3. Design

### 3.1 Core idea: tools are methods on the object that owns the domain

A `ToolProvider` is any object that exposes a set of tool definitions. Tool executors are bound methods with natural `this` access to their domain state. There is no context bag, no role assertion, no global catalog of detached functions.

```ts
interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: ZodSchema;
  executor: (args: Record<string, unknown>) => Promise<ToolResult>;
}

interface ToolProvider {
  readonly providerName: string;
  readonly tools: readonly ToolDefinition[];
}
```

The executor signature takes only `args` — no `ctx`. The context is already bound: it is the instance state of the object that implements the provider.

### 3.2 Two kinds of providers

**Domain providers** — the actor itself implements tools for the domain it owns. The tool methods have direct `this` access to actor state. They cannot be called from another role because they are methods on that actor.

```ts
class PlanningCardProcessorActor implements ToolProvider {
  readonly providerName = 'planner-card-control';

  get tools(): ToolDefinition[] {
    return [
      { name: 'create_card', description: '...', inputSchema: createCardSchema, executor: this.createCard.bind(this) },
      { name: 'edit_card',   description: '...', inputSchema: editCardSchema,   executor: this.editCard.bind(this) },
      { name: 'activate_card', description: '...', inputSchema: activateCardSchema, executor: this.activateCard.bind(this) },
      // ...
    ];
  }

  private async createCard(args: CreateCardArgs): Promise<ToolResult> {
    // `this` is the planner actor. Direct access to this.cardStore,
    // this.cardId, this.projectRoot, the parent/child tree.
    // No context bag. No role assertion.
  }
}
```

```ts
class TerminalCardProcessorActor implements ToolProvider {
  readonly providerName = 'executor-process';

  get tools(): ToolDefinition[] {
    return [
      { name: 'run_command',  description: '...', inputSchema: runCommandSchema,  executor: this.runCommand.bind(this) },
      { name: 'wait_process', description: '...', inputSchema: waitProcessSchema, executor: this.waitProcess.bind(this) },
      { name: 'kill_process', description: '...', inputSchema: killProcessSchema, executor: this.killProcess.bind(this) },
    ];
  }
}
```

**Generic providers** — reusable bundles for capabilities shared across roles (filesystem, web, inspection, MCP, skill). They are constructed with the minimal context they need; their tool methods close over that context.

```ts
function createWorkspaceProvider(ctx: { projectRoot: string; cardId?: string; agentRole: AgentRole }): ToolProvider {
  return {
    providerName: 'workspace',
    tools: [
      { name: 'read',  description: '...', inputSchema: readSchema,  executor: (args) => read(ctx, args) },
      { name: 'write', description: '...', inputSchema: writeSchema, executor: (args) => write(ctx, args) },
      { name: 'edit',  description: '...', inputSchema: editSchema,  executor: (args) => edit(ctx, args) },
      // glob, grep, apply_patch ...
    ],
  };
}
```

### 3.3 The invocation surface

Each agent composes its provider list at construction time. The surface is the flattened union of all provider tools — a `Map<string, ToolDefinition>` for name lookup.

```ts
interface InvocationSurface {
  readonly role: AgentRole;
  readonly tools: ReadonlyMap<string, ToolDefinition>;
}

function buildInvocationSurface(role: AgentRole, providers: readonly ToolProvider[]): InvocationSurface {
  const tools = new Map();
  for (const provider of providers) {
    for (const tool of provider.tools) {
      if (tools.has(tool.name)) throw new Error(`Duplicate tool '${tool.name}' from provider '${provider.providerName}'.`);
      tools.set(tool.name, tool);
    }
  }
  return { role, tools };
}
```

Duplicate tool names across providers is a configuration bug — throw at construction, not at runtime.

### 3.4 The invocation function

```ts
async function invokeTool(surface: InvocationSurface, name: string, args: unknown): Promise<ToolResult> {
  const definition = surface.tools.get(name);
  if (!definition) return { success: false, error: `Unsupported tool '${name}' for role '${surface.role}'.` };
  const parsed = definition.inputSchema.safeParse(args);
  if (!parsed.success) return { success: false, error: parsed.error.message };
  return definition.executor(parsed.data);
}
```

No `ctx` parameter. The executor is a pre-bound method — context is already captured. This is the entire shared layer.

### 3.5 Composition per role

```
PlanningCardProcessorActor (domain provider: card control tools as methods)
  + WorkspaceProvider(projectRoot, cardId, 'planner')
  + InspectionProvider(projectRoot, cardStore)
  + WebProvider()
  + TerminalTool (emit_result — processor-owned, not in surface)

TerminalCardProcessorActor (domain provider: process tools as methods)
  + WorkspaceProvider(projectRoot, cardId, 'executor')
  + WebProvider()
  + McpProvider(mcpManager)
  + SkillProvider()
  + TerminalTool (emit_result — processor-owned)

Reviewer loop (domain provider: none — reviewer has no role-specific tools)
  + WorkspaceProvider(projectRoot, cardId, 'reviewer')
  + WebProvider()
  + McpProvider(mcpManager)
  + SkillProvider()
  + TerminalTool (emit_result — processor-owned)

AnalystHandler (domain provider: analyst control tools as methods)
  + WorkspaceProvider(projectRoot, undefined, 'analyst')
  + InspectionProvider(projectRoot, cardStore)
  + WebProvider()
  + McpProvider(mcpManager)
  + SkillProvider()
```

### 3.6 What this eliminates

| Eliminated | Replaced by |
| --- | --- |
| Global tool catalog of detached functions | Tool methods on domain owners + generic providers |
| `ToolContext` capability bag | Bound `this` / constructor-captured context |
| Role-typed context union (`AnalystToolContext \| ...`) | Not needed — tools are methods on the right object |
| `agentRole` runtime assertions in tool executors | Structural guarantee — a planner method can only be called from the planner |
| `activate_card` processor-owned carve-out | It is a planner method, flows through `invokeTool` naturally |
| MCP special-case in surface builder | `McpProvider` is included or not — no special-case |
| Flat string arrays per role (`['read', 'write', ...]`) | Provider composition |

### 3.7 Terminal tools

`emit_result` stays in the processor loops. It is not a provider tool and not passed through `invokeTool`. Terminal validation is role-specific contract logic that closes the card activation and drives lifecycle transitions. The status enum is role-specific: planner/executor use `done | blocked | failed`; reviewer adds `rework`.

### 3.8 Analyst audit and events

The Analyst handler wraps `invokeTool` with its own pre/post hooks for audit logging, `analyst_tool_invoked` event broadcasts, and response shaping. These are Analyst-specific concerns; they live in the Analyst handler, not in the shared function. Card processors do not need them.

### 3.9 The result

```ts
interface ToolResult {
  success: boolean;
  data?: unknown;
  error?: string;
}
```

One result type. The caller — Analyst handler or card processor — serializes it for the provider. No separate `modelContent` field, no `errorKind`, no `metadata` bag.

### 3.10 Tool executor contract

`invokeTool` does not catch executor exceptions. Tool executors must follow this rule:

- **Expected/model/project failures** (path denied, slot-writer violation, card not found, command exited non-zero) → return `{ success: false, error }`.
- **Impossible programmer/configuration states** (duplicate tool name, provider constructed without required state) → throw.

This keeps `invokeTool` transparent: it never swallows a bug as a silent tool error, and it never crashes the activation for expected model output.

## 4. Design Goals

1. Keep role orchestration explicit. Analyst chat behavior, planner sequencing, executor process ownership, reviewer assessment, and terminal result validation remain role-specific.
2. Co-locate tool logic with domain ownership. Card tools live on the planner. Process tools live on the executor. Filesystem tools live in a generic provider. No detached functions digging through a context bag.
3. Share mechanics below orchestration. Argument parsing, tool lookup, invocation, and result normalization are a single function. The provider model determines what tools exist and where their logic lives; `invokeTool` just runs them.
4. Make tool surfaces explicit by construction. A tool is available because a provider in the agent's composition list registered it. Unknown tools return a `ToolResult` error — no catch-all.
5. No compatibility shims. `ToolDispatcher`, `AnalystAdapter`, `processWorkspaceToolCall`, and the global tool catalog are deleted in the same change that introduces providers.

## 5. Migration Plan

One phase. No temporary wrappers.

1. Define `ToolProvider`, `ToolDefinition`, `ToolResult`, `InvocationSurface`, and `invokeTool`.
2. Implement generic providers (`WorkspaceProvider`, `WebProvider`, `InspectionProvider`, `McpProvider`, `SkillProvider`). Each is constructed with the minimal context it needs.
3. Make each domain owner implement `ToolProvider` for its role-specific tools: `PlanningCardProcessorActor` (card control), `TerminalCardProcessorActor` (process), `AnalystHandler` (analyst control). Tool logic moves from detached catalog functions to bound methods.
4. Compose each agent's provider list and build its invocation surface at construction time.
5. Point Analyst handler and card processors at `invokeTool`. Delete `ToolDispatcher`, `AnalystAdapter`, `processWorkspaceToolCall`, and the global tool catalog in the same change.
6. Move Analyst audit logging and event broadcasting into Analyst-handler pre/post hooks around `invokeTool`.
7. Delete duplicated result types (`AdapterResult`, `ToolDispatchResult`). Everything returns `ToolResult`.
8. Update tests to assert `invokeTool` behavior per role surface instead of old adapter internals.

## 6. Validation Strategy

Focused tests should cover:

- Duplicate tool name across providers → `buildInvocationSurface` throws.
- Unknown tool from model → `invokeTool` returns `{ success: false, error }`.
- Invalid arguments → schema parse failure returns a model-visible tool error, not a thrown exception.
- Domain provider isolation: planner card tools are methods on the planner; calling them from an executor surface is structurally impossible (the method doesn't exist on the executor).
- Workspace tool path-scope enforcement (`project://`, `record://`, slot-writer rules) inside the workspace provider's tool executors.
- Executor process lifecycle: process tools are methods on the executor actor; ownership is instance state, not a context field.
- Reviewer record-only mutation: `write`/`edit` restricted to `record://review.md` by the workspace provider's path policy keyed on `agentRole`.
- MCP availability: `McpProvider` is included in the composition list or not — no runtime denial.
- Expected failures return `ToolResult`; impossible states throw (no broad catch in `invokeTool`).

End-to-end validation should include:

- One Analyst workspace read or card inspection tool call.
- One planner workspace read and child card mutation.
- One executor file or process tool call.
- One reviewer workspace read.
- One terminal contract success path for each card role.

## 7. Risks

| Risk | Mitigation |
| --- | --- |
| Provider becomes an adapter with policy logic | A provider is a named array of tool definitions. It carries no runtime state beyond what its constructor captured. No `handles()`, no `policyInput()`, no dispatch interception. |
| Analyst audit/events drift | Audit and event broadcasting stay in the Analyst handler as pre/post hooks; `invokeTool` has no side effects beyond the tool itself. |
| Executor process actors outlive activation | Process tools are methods on the executor actor; the actor and its process state are discarded on settlement. |
| Terminal result lifecycle becomes over-generic | `emit_result` stays in processor loops; it is never a provider tool or passed through `invokeTool`. |

## 8. Explicit Decisions

These are decided, not open. If a concrete need to change them appears later, the provider-based design makes that change additive, not structural.

1. Terminal tools (`emit_result`) stay direct processor validation. They drive card lifecycle transitions; they are not side-effect tools and never pass through `invokeTool`.
2. `activate_card` is a planner provider tool. It flows through `invokeTool` like any other tool — its executor is a bound method on the planner actor that has natural access to the activation callback via `this`.
3. The reviewer has no domain-specific provider. Its tool surface is generic providers only (workspace, web, MCP, skill) plus the terminal tool.
4. There is no global tool catalog. Tools are defined where they belong: on domain owners and in generic providers.
