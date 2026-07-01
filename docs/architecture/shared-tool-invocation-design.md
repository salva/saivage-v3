# Shared Tool Invocation Design

Status: design proposal.

Date: 2026-07-01

## 1. Purpose

Saivage currently has duplicated tool execution logic across the Analyst chat path and the micro-actor card processors. Parsing, policy checks, error normalization, and workspace tool routing are split across several modules. Tool definitions live in a global catalog of detached functions that receive a context bag and must assert their own role.

This document specifies a tool architecture built on **ToolProviders** — objects that implement the tools for the domain they own. Card management tools are methods on the planner actor. Operator-control tools are methods on the analyst handler. Process, filesystem, web, and inspection tools live in reusable providers constructed with minimal context. There is no global catalog of detached functions and no context bag.

This document is the authority for *how* tools are invoked. `tool-set-reorganization-design.md` remains the authority for *what* the tools are (names, schemas, role assignments) and for the security/scope policy. Where the two conflict on the result contract, this document supersedes (see §3.9).

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

**Domain providers** — the actor itself implements tools for the domain it owns. The tool methods have direct `this` access to actor state. Role isolation comes from **composition**: a tool is reachable only if its provider is in the agent's composition list (§3.5). Because the planner's card tools are methods on the planner actor, they are present only when the planner provider is composed in. That is a construction decision, not a runtime permission check — and it is not a type-level guarantee either. Composing the wrong provider into a surface is a configuration bug that must be caught in review and tests, not papered over with runtime role assertions.

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

The analyst handler is the other domain provider: its operator-control tools (card lifecycle, runtime controls, `get_status`, navigation) are bound methods with direct access to the runtime, card store, and session state.

Only the planner and analyst handler are domain providers. The executor and reviewer have no role-specific tools — their surfaces are generic providers only.

**Generic providers** — reusable bundles for capabilities shared across roles (filesystem, patch, process, web, inspection, MCP, skill). They are constructed with the minimal context they need; their tool methods close over that context. A generic provider never branches on role internally: if a capability is role-restricted, it is a separate provider composed only into the roles that need it.

```ts
function createWorkspaceProvider(ctx: { projectRoot: string; cardId?: string; agentRole: AgentRole }): ToolProvider {
  return {
    providerName: 'workspace',
    tools: [
      { name: 'read',  description: '...', inputSchema: readSchema,  executor: (args) => read(ctx, args) },
      { name: 'write', description: '...', inputSchema: writeSchema, executor: (args) => write(ctx, args) },
      { name: 'edit',  description: '...', inputSchema: editSchema,  executor: (args) => edit(ctx, args) },
      { name: 'glob',  description: '...', inputSchema: globSchema,  executor: (args) => glob(ctx, args) },
      { name: 'grep',  description: '...', inputSchema: grepSchema,  executor: (args) => grep(ctx, args) },
    ],
  };
}
```

`apply_patch` is **not** in the base workspace provider. It is a separate `PatchProvider` composed only into executor and analyst:

```ts
function createPatchProvider(ctx: { projectRoot: string; agentRole: AgentRole }): ToolProvider {
  return {
    providerName: 'patch',
    tools: [
      { name: 'apply_patch', description: '...', inputSchema: applyPatchSchema, executor: (args) => applyPatch(ctx, args) },
    ],
  };
}
```

Process tools are a generic provider too. Process state lives in the durable process store (`processApi(projectRoot)` / `.saivage-work/processes/`), not on any actor instance, so process tools take an owner context rather than living on the executor actor:

```ts
function createProcessProvider(ctx: { projectRoot: string; ownerId: string }): ToolProvider {
  return {
    providerName: 'process',
    tools: [
      { name: 'run_command',  description: '...', inputSchema: runCommandSchema,  executor: (args) => runCommand(ctx, args) },
      { name: 'wait_process', description: '...', inputSchema: waitProcessSchema, executor: (args) => waitProcess(ctx, args) },
      { name: 'kill_process', description: '...', inputSchema: killProcessSchema, executor: (args) => killProcess(ctx, args) },
    ],
  };
}
```

`ownerId` is the card id for executor activations and the session id for the analyst. `wait_process`/`kill_process` reject processes not owned by that context.

The `WorkspaceProvider` enforces the scoped-URL and role-write policy defined in `tool-set-reorganization-design.md` §8: `project://`, `record://`, `tmp://`, `system://` resolution, secret/blocked-path hiding, slot-writer enforcement keyed on `agentRole`, and the rule that executor **and analyst** may write `project://` files while planner/reviewer write only their `record://` slots. The current `project-file-tools.ts` blocks all non-executor project writes; the provider must key on `agentRole` so the analyst is admitted as a project writer. The analyst has no implicit card context (`cardId: undefined`), so analyst `record://` and `tmp://` URLs must carry an explicit card id (e.g. `record://brief.md?card=<id>`); the path resolver uses the URL's card parameter, falling back to the composed `cardId` for card processors. The full policy is not restated here — `tool-set-reorganization-design.md` §8 remains the authority.

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

Duplicate tool names across providers is a configuration bug — throw at construction, not at runtime. The surface is also the aggregate used for LLM prompt/tool export: the model-facing tool list for an activation is `Array.from(surface.tools.values())` mapped to JSON-schema form.

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

`invokeTool` takes already-deserialized args (`unknown`). The LLM gateway delivers tool-call arguments as a JSON string; the caller deserializes that string (`JSON.parse`) before calling `invokeTool`. Schema validation (`inputSchema.safeParse`) happens inside `invokeTool`. JSON deserialization is a trivial call-site step, not a shared concern — the shared concern is schema validation + tool lookup + execution + result normalization.

### 3.5 Composition per role

Inspection is split into a **history** capability (all card roles) and a **navigation** capability (planner/analyst), so composition — not role branching inside a provider — determines what each role sees. `get_status` is an analyst-control method, not an inspection tool. `apply_patch` is a separate `PatchProvider` composed only into executor and analyst. Process tools are a `ProcessProvider` composed into executor and analyst.

```
PlanningCardProcessorActor (domain provider: card-control tools as methods)
  + WorkspaceProvider(projectRoot, cardId, 'planner')
  + CardNavigationProvider(cardStore)   // list_cards, get_card, get_tree
  + CardHistoryProvider(cardStore)      // list_card_history, get_card_history_entry, diff_card
  + WebProvider()
  + TerminalTool (emit_result — processor-owned, not in surface)

TerminalCardProcessorActor (no domain provider — executor has no role-specific tools)
  + WorkspaceProvider(projectRoot, cardId, 'executor')
  + PatchProvider(projectRoot, 'executor')
  + ProcessProvider(projectRoot, cardId)
  + CardHistoryProvider(cardStore)
  + WebProvider()
  + McpProvider(mcpManager)
  + SkillProvider()
  + TerminalTool (emit_result — processor-owned)

Reviewer loop (domain provider: none — reviewer has no role-specific tools)
  + WorkspaceProvider(projectRoot, cardId, 'reviewer')
  + CardHistoryProvider(cardStore)
  + WebProvider()
  + McpProvider(mcpManager)
  + SkillProvider()
  + TerminalTool (emit_result — processor-owned)

AnalystHandler (domain provider: analyst-control tools as methods, incl. get_status)
  + WorkspaceProvider(projectRoot, undefined, 'analyst')
  + PatchProvider(projectRoot, 'analyst')
  + ProcessProvider(projectRoot, sessionId)
  + CardNavigationProvider(cardStore)
  + CardHistoryProvider(cardStore)
  + WebProvider()
  + McpProvider(mcpManager)
  + SkillProvider()
```

The tool vocabulary and per-role assignments above are taken from `tool-set-reorganization-design.md` §6; this diagram shows how those assignments are expressed as provider composition.

### 3.6 What this eliminates

| Eliminated | Replaced by |
| --- | --- |
| Global tool catalog of detached functions | Tool methods on domain owners + generic providers |
| `ToolContext` capability bag | Bound `this` / constructor-captured context |
| Role-typed context union (`AnalystToolContext \| ...`) | Not needed — tools are methods on the right object |
| `agentRole` runtime assertions in tool executors | Composition — a tool is present only if its provider is composed in |
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

One result type, no `code`/`kind`/`metadata` fields. The caller — Analyst handler or card processor — serializes it for the provider.

Transcript shape is derived from `success`, not carried as a separate field:

- `success: true` → a `tool_result` transcript entry containing `data`.
- `success: false` → a `tool_error` transcript entry containing the `error` string.

There is no `code` field on the error. Coarse error categorization (permission vs not-found vs io) is not part of the contract; if a future UI need emerges it can be added as an optional field, but it is not spec'd now. **This supersedes** the `{ error, code? }` wire shape described in `tool-set-reorganization-design.md` §7.

### 3.10 Tool executor contract

`invokeTool` does not catch executor exceptions. Tool executors must follow this rule:

- **Expected/model/project failures** (path denied, slot-writer violation, card not found, command exited non-zero) → return `{ success: false, error }`.
- **Impossible programmer/configuration states** (duplicate tool name, provider constructed without required state) → throw.

This keeps `invokeTool` transparent: it never swallows a bug as a silent tool error, and it never crashes the activation for expected model output.

### 3.11 Relationship to the tool catalog

This design replaces the catalog as the **execution and schema authority**. There is no `tool-catalog.ts`-style module of detached definitions that tools dig through with a context bag. Each `ToolDefinition` carries its own `inputSchema`; schemas live on providers alongside the execution they describe.

What is **preserved** from `tool-set-reorganization-design.md` is the **vocabulary**: the canonical tool names, input schemas, role assignments, scoped-URL rules, and security policy defined there. Those definitions move onto providers unchanged. The tool-set doc remains the authority for *what* the tools are and *who* gets them; this doc is the authority for *how* they are invoked.

The `InvocationSurface` (§3.3) is the only aggregate used at runtime: it collects a surface's provider tools into the `Map` used for both name lookup (`invokeTool`) and LLM prompt/tool export. Runtime model prompts derive **only** from the active `InvocationSurface`, never from a global aggregate. A derived read-only aggregate of all provider tools may exist solely for docs validation and schema export, but it is never used to build runtime prompts.

## 4. Design Goals

1. Keep role orchestration explicit. Analyst chat behavior, planner sequencing, executor process ownership, reviewer assessment, and terminal result validation remain role-specific.
2. Co-locate tool logic with domain ownership. Card tools live on the planner. Operator-control tools live on the analyst handler. Filesystem, patch, process, web, and inspection tools live in generic providers. No detached functions digging through a context bag.
3. Share mechanics below orchestration. Schema validation, tool lookup, invocation, and result normalization are a single function. The provider model determines what tools exist and where their logic lives; `invokeTool` just runs them.
4. Make tool surfaces explicit by construction. A tool is available because a provider in the agent's composition list registered it. Unknown tools return a `ToolResult` error — no catch-all.
5. No compatibility shims. `ToolDispatcher`, `AnalystAdapter`, `processWorkspaceToolCall`, and the global tool catalog are deleted in the same change that introduces providers.

## 5. Migration Plan

One phase. No temporary wrappers.

1. Define `ToolProvider`, `ToolDefinition`, `ToolResult`, `InvocationSurface`, and `invokeTool`.
2. Implement generic providers (`WorkspaceProvider`, `PatchProvider`, `ProcessProvider`, `WebProvider`, `CardHistoryProvider`, `CardNavigationProvider`, `McpProvider`, `SkillProvider`). Each is constructed with the minimal context it needs.
3. Make each domain owner implement `ToolProvider` for its role-specific tools: `PlanningCardProcessorActor` (card control) and `AnalystHandler` (analyst control). Tool logic moves from detached catalog functions to bound methods. The executor and reviewer are not domain providers.
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
- Domain provider isolation: planner card tools are present only when the planner provider is composed into the surface. Composing it into an executor surface is a configuration bug caught by review/tests, not a runtime check — and not a type-level impossibility.
- Patch availability: `PatchProvider` (`apply_patch`) is composed only into executor and analyst; planner and reviewer surfaces must not include it.
- Workspace tool path-scope enforcement (`project://`, `record://`, `tmp://`, `system://`, slot-writer rules) inside the workspace provider's tool executors, keyed on `agentRole`, including the analyst as a permitted project writer.
- Analyst record/tmp addressing: `record://` and `tmp://` URLs without an explicit card id fail fast when the analyst has no implicit card context.
- Process ownership: `ProcessProvider` is constructed with an `ownerId` (card or session); `wait_process`/`kill_process` reject processes not owned by that context.
- Reviewer record-only mutation: `write`/`edit` restricted to `record://review.md` by the workspace provider's path policy keyed on `agentRole`.
- MCP availability: `McpProvider` is included in the composition list or not — no runtime denial.
- Expected failures return `ToolResult`; impossible states throw (no broad catch in `invokeTool`).

End-to-end validation should include:

- One Analyst workspace read or card inspection tool call.
- One planner workspace read and child card mutation.
- One executor file, patch, or process tool call.
- One reviewer workspace read.
- One terminal contract success path for each card role.

## 7. Risks

| Risk | Mitigation |
| --- | --- |
| Provider becomes an adapter with policy logic | Generic providers are named arrays of tool definitions with no dispatch interception (`handles()`, `policyInput()`). Generic providers carry no runtime state beyond constructor-captured context. Domain providers (the planner actor, the analyst handler) carry live domain state by design — that is the point of co-location; their state is the domain they own, not adapter policy. |
| Analyst audit/events drift | Audit and event broadcasting stay in the Analyst handler as pre/post hooks; `invokeTool` has no side effects beyond the tool itself. |
| Process state outlives its owner | Process state lives in the durable process store (`processApi`), scoped by `ownerId`. `wait_process`/`kill_process` reject processes not owned by the current context; the store is the authority, not the provider. |
| Terminal result lifecycle becomes over-generic | `emit_result` stays in processor loops; it is never a provider tool or passed through `invokeTool`. |
| Wrong provider composition exposes a role's tools to another role | Composition is the authority, not a type system. Surface construction is reviewed and tested per role; a derived "all tools" aggregate is read-only and never used for invocation. |

## 8. Explicit Decisions

These are decided, not open. If a concrete need to change them appears later, the provider-based design makes that change additive, not structural.

1. Terminal tools (`emit_result`) stay direct processor validation. They drive card lifecycle transitions; they are not side-effect tools and never pass through `invokeTool`.
2. `activate_card` is a planner provider tool. It flows through `invokeTool` like any other tool — its executor is a bound method on the planner actor that has natural access to the activation callback via `this`.
3. The reviewer has no domain-specific provider. Its tool surface is generic providers only (workspace, web, MCP, skill, card-history) plus the terminal tool.
4. There is no global catalog module that is the execution or schema authority. Tool schemas and execution live together on providers (domain owners and generic providers). See §3.11 for how this relates to the tool vocabulary in `tool-set-reorganization-design.md`.
5. The result contract is `{ success, data?, error? }` with no error `code`. This supersedes the `{ error, code? }` shape in `tool-set-reorganization-design.md` §7 (see §3.9).
6. Process tools are a generic `ProcessProvider`, not executor-actor methods. Both executor and analyst compose it with an owner context (`ownerId`); the durable process store is the authority. The executor is not a domain provider — it has no role-specific tools.
