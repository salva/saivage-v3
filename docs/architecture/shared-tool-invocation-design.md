# Shared Tool Invocation Design

Status: implemented design proposal with obsolete phase checklist. Keep for provider-owned invocation architecture rationale. Current remaining work, drift decisions, and execution order are consolidated in [Remaining Work Consolidated Plan](./remaining-work-consolidated-plan.md).

Date: 2026-07-01

## 1. Purpose

Saivage currently has duplicated tool execution logic across the Analyst chat path and the micro-actor card processors. Parsing, policy checks, error normalization, and workspace tool routing are split across several modules. Tool definitions live in a global catalog of detached functions that receive a context bag and must assert their own role.

This document specifies a tool architecture built on **ToolProviders** — objects that implement the tools for the domain they own. Card management tools are methods on the planner actor. Operator-control tools are methods on the analyst handler. Process, filesystem, web, and inspection tools live in reusable providers constructed with minimal context. There is no global catalog of detached functions and no context bag.

This document is the authority for *how* tools are invoked and for the runtime result contract. Providers own their schema instances; the `InvocationSurface` is the runtime authority for what schema the model sees (§3.11). `tool-set-reorganization-design.md` remains the authority for *what* the tools are (names, default schemas, role assignments) and for the security/scope policy. Where a provider defines a surface-local schema variant, the provider's schema wins at runtime. Where the two docs conflict on the result contract, this document supersedes (see §3.9).

## 2. Pre-Refactor Shape

### Analyst path

Before the provider migration, the Analyst is handled by `src/agents/analyst-handler.ts`.

- It owns a global conversational loop backed by `LLMActor`.
- It builds Analyst-specific system prompts and workspace context.
- It uses `ToolDispatcher` with `AnalystAdapter`.
- It passes an Analyst `ToolContext` containing project root, card store, runtime controls, MCP manager, event bus, and restart hooks.
- It enforces Analyst control-surface policy with `ControlActionSurface` and `RoleToolPolicy.assertAnalystSurfaceTool`.
- It emits Analyst activity and broadcasts `analyst_tool_invoked` events.
- It shapes some tool results into operator-facing final replies.

### Card processor paths

Before the provider migration, planner, executor, and reviewer tool calls are handled inside runtime actors under `src/runtime/actors/`.

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
export type ToolReplayOutcome =
  | { kind: 'settled'; result: ToolResult }
  | { kind: 'redispatch' };

export type ToolProviderCleanupReason =
  | { kind: 'activation_settled'; status: 'done' | 'blocked' | 'failed' | 'cancelled' }
  | { kind: 'session_closed' }
  | { kind: 'runtime_shutdown' };

export interface ToolDefinition<Args = unknown> {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: z.ZodType<Args>;
  readonly executor: (args: Args, signal: AbortSignal) => Promise<ToolResult>;
  readonly replay?: (args: Args) => Promise<ToolReplayOutcome>;
}

export interface ToolProvider {
  readonly providerName: string;
  readonly tools: readonly ToolDefinition<any>[]; // heterogeneous; erased at provider level
  cleanup?(reason: ToolProviderCleanupReason): Promise<void> | void;
}
```

The executor signature takes `args` and an `AbortSignal` — no `ctx`. The context is already bound: it is the instance state of the object that implements the provider. The invocation layer passes the signal to every executor; a provider may ignore it when the operation is synchronous or non-abortable.

`ToolDefinition` is generic over `Args` so that each definition's executor receives the correct type inferred from its `inputSchema`. A `defineTool` factory infers `Args` from the schema at the definition site; when tools are collected into a provider's array, the generic is erased to `any` (the array is heterogeneous), but each executor remains internally typed. `invokeTool` calls `executor(parsed.data, signal)` where `parsed.data` is typed by the schema — at runtime the erasure is harmless because `safeParse` already validated the shape. The optional `replay` is the recovery entrypoint invoked by `replayToolForRecovery(surface, name, args)` during startup recovery to re-drive a tool call whose result was lost to a restart; a tool without `replay` resolves to a default interrupted result, while `redispatch` means the caller should re-invoke `executor`.

### 3.2 Two kinds of providers

**Domain providers** — the actor itself implements tools for the domain it owns. The tool methods have direct `this` access to actor state. Role isolation comes from **composition**: a tool is reachable only if its provider is in the agent's composition list (§3.5). Because the planner's card tools are methods on the planner actor, they are present only when the planner provider is composed in. That is a construction decision, not a runtime permission check — and it is not a type-level guarantee either. Composing the wrong provider into a surface is a configuration bug that must be caught in review and tests, not papered over with runtime role assertions.

```ts
class PlanningCardProcessorActor implements ToolProvider {
  readonly providerName = 'planner-card-control';

  get tools(): ToolDefinition<any>[] {
    return [
      defineTool({ name: 'create_card', description: '...', inputSchema: createCardSchema, executor: this.createCard.bind(this) }),
      defineTool({ name: 'edit_card',   description: '...', inputSchema: editCardSchema,   executor: this.editCard.bind(this) }),
      defineTool({ name: 'activate_card', description: '...', inputSchema: activateCardSchema, executor: this.activateCard.bind(this) }),
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

The analyst handler is the other domain provider: its operator-control tools (card lifecycle, runtime controls, `get_status`, `navigate_workspace`, `navigate_back`) are bound methods with direct access to the runtime, card store, and session state.

Only the planner and analyst handler are domain providers. The executor and reviewer have no role-specific tools — their surfaces are generic providers only.

**Generic providers** — reusable bundles for capabilities shared across roles (filesystem, patch, process, web, card inspection/history, MCP, skill). They are constructed with the minimal context they need; their tool methods close over that context. A generic provider owns its schemas and implementation directly. A generic provider never uses role to decide **which tools to expose** — that is composition's job (a role-restricted tool is a separate provider composed only into the roles that need it). Path and action **authorization** inside a tool (e.g., which file paths `write` may touch, which record slots are permitted) is legitimately keyed on `agentRole`; that is authorization policy enforced at the path-resolution boundary, not availability filtering.

```ts
function createWorkspaceProvider(ctx: { projectRoot: string; cardId?: string; agentRole: AgentRole }): ToolProvider {
  return {
    providerName: 'workspace',
    tools: [
      defineTool({ name: 'read',  description: '...', inputSchema: readSchema,  executor: (args, _signal) => read(ctx, args) }),
      defineTool({ name: 'write', description: '...', inputSchema: writeSchema, executor: (args, _signal) => write(ctx, args) }),
      defineTool({ name: 'edit',  description: '...', inputSchema: editSchema,  executor: (args, _signal) => edit(ctx, args) }),
      defineTool({ name: 'glob',  description: '...', inputSchema: globSchema,  executor: (args, _signal) => glob(ctx, args) }),
      defineTool({ name: 'grep',  description: '...', inputSchema: grepSchema,  executor: (args, _signal) => grep(ctx, args) }),
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
      defineTool({ name: 'apply_patch', description: '...', inputSchema: applyPatchSchema, executor: (args, _signal) => applyPatch(ctx, args) }),
    ],
  };
}
```

Process tools are a generic provider too. Process state lives in the durable process store (`processApi(projectRoot)` / `.saivage-work/processes/`), not on any actor instance, so process tools take an owner context rather than living on the executor actor:

```ts
function createProcessProvider(ctx: { projectRoot: string; ownerId: string; cardId?: string }): ToolProvider {
  return {
    providerName: 'process',
    tools: [
      defineTool({ name: 'run_command',  description: '...', inputSchema: runCommandSchema,  executor: async (args, signal) => runCommand(ctx, args, signal) }),
      defineTool({ name: 'wait_process', description: '...', inputSchema: waitProcessSchema, executor: async (args, signal) => waitProcess(ctx, args, signal) }),
      defineTool({ name: 'kill_process', description: '...', inputSchema: killProcessSchema, executor: async (args, _signal) => killProcess(ctx, args) }),
    ],
  };
}
```

`ownerId` is the **activation id** for executor activations (unique per activation instance, not the card id) and the **session id** for the analyst. `cardId` is optional provenance metadata in the provider context: executors pass their activation card id, while Analyst command records currently use the session id as schema-compatible non-card scope metadata because `ProcessRecord.card_id` is still required. A new activation of the same card must not see the prior activation's processes; the process store scopes ownership to `ownerId`, and the runtime clears that ownership when the activation or session ends. This matches the current source, where the executor actor kills all owned processes on settlement (`onActivationSettled` → `shutdownOwnedProcesses`).

**Process store ownership.** `ProcessRecord` carries `owner_id`, `card_id`, `agent_session_id`, and `owner_kind` (`'agent' | 'operator' | 'runtime'`). The executor passes its activation id as `owner_id`; the analyst passes its session id. `wait_process` and `kill_process` verify that the caller's `ownerId` matches the record's `owner_id`. The runtime kills processes by `owner_id` scope on activation settlement or session cleanup. `card_id` is **kept** as non-authoritative provenance metadata: the operator API exposes it in `ProcessView`, analyst preview helpers filter by it to show affected processes during card delete/abort/restart, and notification messages reference it. Ownership is checked only via `owner_id`; `card_id` is never used as an ownership key. Executors stamp `card_id` from the provider context's activation card id. Analysts have no implicit card context, so the current schema-compatible record uses the Analyst session id as the process scope in `card_id` while `owner_kind: 'operator'` and `agent_session_id` preserve the real provenance.

The analyst handler owns session-scoped process cleanup: when an analyst session ends (explicitly closed, server restart, or a configurable idle TTL), the runtime kills processes owned by that `sessionId`, paralleling the executor's activation-settlement cleanup. This prevents durable process leaks from long-lived analyst sessions.

The web provider takes the same write-policy context as workspace tools, because `webfetch.save_as` writes to the project filesystem and uses the same scoped write authorization as `write` (per `tool-set-reorganization-design.md` §8):

```ts
function createWebProvider(ctx: { projectRoot: string; cardId?: string; agentRole: AgentRole }): ToolProvider {
  return {
    providerName: 'web',
    tools: [
      defineTool({ name: 'websearch', description: '...', inputSchema: websearchSchema, executor: async (args, signal) => websearch(ctx, args, signal) }),
      defineTool({ name: 'webfetch',  description: '...', inputSchema: webfetchSchema,  executor: async (args, signal) => webfetch(ctx, args, signal) }),
    ],
  };
}
```

The invocation layer passes an `AbortSignal` to every executor; a provider may ignore it when the operation is synchronous or non-abortable (as the workspace, patch, and `kill_process` helpers do). Process run/wait and web tools observe the signal because their operations are abortable.

The `WorkspaceProvider` enforces the scoped-URL and role-write policy defined in `tool-set-reorganization-design.md` §8: `project://`, `record://`, `tmp://`, `system://` resolution, secret/blocked-path hiding, slot-writer enforcement keyed on `agentRole`, and the rule that executor **and analyst** may write `project://` files while planner/reviewer write only their `record://` slots. The current `project-file-tools.ts` blocks all non-executor project writes; the provider must key on `agentRole` so the analyst is admitted as a project writer.

**Analyst record/tmp addressing.** The analyst has no implicit card context (`cardId: undefined`). For card processors, the composed `cardId` is the "current card" and record/tmp URLs must target that card (the path resolver rejects URLs pointing elsewhere). For the analyst, the URL's explicit `?card=<id>` parameter is the operation's target card — the analyst may write `record://brief.md?card=<id>` for any card, because the analyst is the operator mutation surface and is not artificially restricted (per `tool-set-reorganization-design.md` §6). The path resolver uses the URL's card parameter as the authority when no composed `cardId` is present; if both are present (card processors), they must match. The full policy is not restated here — `tool-set-reorganization-design.md` §8 remains the authority.

### 3.3 The invocation surface

Each agent composes its provider list at construction time. The surface is the flattened union of all provider tools — a `Map<string, ToolDefinition<any>>` for name lookup.

```ts
export interface InvocationSurface {
  readonly role: AgentRole;
  readonly tools: ReadonlyMap<string, ToolDefinition<any>>;
  readonly providers: readonly ToolProvider[];
}

export function buildInvocationSurface(role: AgentRole, providers: readonly ToolProvider[]): InvocationSurface {
  const tools = new Map<string, ToolDefinition<any>>();
  for (const provider of providers) {
    for (const tool of provider.tools) {
      if (tools.has(tool.name)) throw new Error(`Duplicate tool '${tool.name}' from provider '${provider.providerName}'.`);
      tools.set(tool.name, tool);
    }
  }
  return { role, tools, providers };
}
```

Duplicate tool names across providers is a configuration bug — throw at construction, not at runtime. The surface is also the aggregate used for LLM prompt/tool export: the model-facing tool list for an activation is `Array.from(surface.tools.values())` mapped to JSON-schema form.

### 3.4 The invocation function

```ts
export async function invokeTool(surface: InvocationSurface, name: string, args: unknown, signal: AbortSignal = new AbortController().signal): Promise<ToolResult> {
  if (signal.aborted) throw abortError(signal);
  const definition = surface.tools.get(name);
  if (!definition) return { success: false, error: `Unsupported tool '${name}' for role '${surface.role}'.` };
  const parsed = definition.inputSchema.safeParse(args);
  if (!parsed.success) return { success: false, error: parsed.error.message };
  if (signal.aborted) throw abortError(signal);
  return definition.executor(parsed.data, signal);
}
```

No `ctx` parameter. The executor is a pre-bound method — context is already captured.

The shared layer also includes these siblings:

- `invokeTool` passes `signal` through to the executor; the executor may observe the signal and abort on it, or ignore it for synchronous operations (see §3.2). `invokeTool` checks the signal before lookup and after schema parse, and does not catch executor exceptions — executors must return `ToolResult` for expected/model/project failures and throw for impossible programmer/configuration states (§3.10).
- `invokeToolForLlm(surface, name, args, signal?)` wraps `invokeTool` and does catch: a thrown error is converted to `{ success: false, error }` unless `signal?.aborted`, in which case it re-throws so the abort propagates.
- `replayToolForRecovery(surface, name, args)` is the recovery-side sibling: it invokes the tool's optional `replay` (or resolves to a default interrupted result) so a waiting-tool call whose result was lost to a restart is re-driven during startup recovery.
- `invokeToolCall(surface, name, rawArgs: string, signal?)` parses the JSON string (returning a `ToolResult` error on malformed JSON) and delegates to `invokeTool`. The `signal?` parameter is threaded through. Tests and callers that already hold parsed args call `invokeTool` or `invokeToolForLlm` directly; the production LLM-call path uses `invokeToolCall`.
- `cleanupInvocationSurface(surface, reason: ToolProviderCleanupReason)` calls each provider's optional `cleanup?(reason)`. It is used in production at `src/runtime/actors/terminal-card-processor-actor.ts:113`, which calls `cleanupInvocationSurface(surface, { kind: 'activation_settled', status: signal.aborted ? 'cancelled' : cleanupStatus })` in a `finally` block on every terminal activation; providers use it to free activation/session-scoped resources.

Schema validation (`inputSchema.safeParse`) happens inside all invocation entry points before executor invocation.

### 3.5 Composition per role

Inspection is split into **card inspection** (`list_cards`, `get_card`, `get_tree`) and **card history** (`list_card_history`, `get_card_history_entry`, `diff_card`), so composition — not role branching inside a provider — determines what each role sees. `get_status`, `navigate_workspace`, and `navigate_back` are analyst-control methods, not generic inspection tools. `apply_patch` is a separate `PatchProvider` composed only into executor and analyst. Process tools are a `ProcessProvider` composed into executor and analyst. Web tools take `{ projectRoot, cardId?, agentRole }` so `webfetch.save_as` enforces the same scoped write policy as `write`, including `record://` slot rules and analyst explicit `?card=<id>` targets.

```
PlanningCardProcessorActor (domain provider: card-control tools as methods)
  + WorkspaceProvider(projectRoot, cardId, 'planner')
  + CardInspectionProvider(cardStore)   // list_cards, get_card, get_tree
  + CardHistoryProvider(cardStore)      // list_card_history, get_card_history_entry, diff_card
  + WebProvider(projectRoot, cardId, 'planner')
  + TerminalTool (emit_result — processor-owned, not in surface)

TerminalCardProcessorActor (no domain provider — executor has no role-specific tools)
  + WorkspaceProvider(projectRoot, cardId, 'executor')
  + PatchProvider(projectRoot, 'executor')
  + ProcessProvider(projectRoot, activationId, cardId)
  + CardHistoryProvider(cardStore)
  + WebProvider(projectRoot, cardId, 'executor')
  + McpProvider(mcpManager)
  + SkillProvider()
  + TerminalTool (emit_result — processor-owned)

Reviewer loop (domain provider: none — reviewer has no role-specific tools)
  + WorkspaceProvider(projectRoot, cardId, 'reviewer')
  + CardHistoryProvider(cardStore)
  + WebProvider(projectRoot, cardId, 'reviewer')
  + McpProvider(mcpManager)
  + SkillProvider()
  + TerminalTool (emit_result — processor-owned)

AnalystHandler (domain provider: analyst-control tools as methods, incl. get_status)
  + WorkspaceProvider(projectRoot, undefined, 'analyst')
  + PatchProvider(projectRoot, 'analyst')
  + ProcessProvider(projectRoot, sessionId, undefined)
  + CardInspectionProvider(cardStore)   // list_cards, get_card, get_tree
  + CardHistoryProvider(cardStore)
  + WebProvider(projectRoot, undefined, 'analyst')
  + McpProvider(mcpManager)
  + SkillProvider()
```

The tool vocabulary and per-role assignments above are taken from `tool-set-reorganization-design.md` §6; this diagram shows how those assignments are expressed as provider composition.

### 3.6 What this eliminates

| Eliminated | Replaced by |
| --- | --- |
| Global tool catalog of detached functions | Tool methods on domain providers + generic providers |
| `ToolContext` capability bag | Bound `this` / constructor-captured context |
| Role-typed context union (`AnalystToolContext \| ...`) | Not needed — tools are methods on the right object |
| `agentRole` runtime assertions in tool executors | Composition — a tool is present only if its provider is composed in |
| `activate_card` processor-owned carve-out | It is a planner method, flows through `invokeTool` naturally |
| MCP special-case in surface builder | `McpProvider` is included or not — no special-case |
| Flat string arrays per role (`['read', 'write', ...]`) | Provider composition |

### 3.7 Terminal tools

`emit_result` stays in the processor loops. It is not a provider tool and not passed through `invokeTool`. Terminal validation is role-specific contract logic that closes the card activation and drives lifecycle transitions. The status enum is role-specific: planner/executor use `done | blocked | failed`; reviewer adds `rework`.

### 3.8 Analyst audit and events

The Analyst handler wraps `invokeToolCall` with its own pre/post hooks for audit logging, `analyst_tool_invoked` event broadcasts, and response shaping. The production LLM-call path delivers raw JSON args, so the analyst wraps `invokeToolCall` (which handles JSON parsing internally) rather than `invokeTool` (which takes pre-parsed args). This avoids duplicating the JSON-parse logic in the analyst path. These are Analyst-specific concerns; they live in the Analyst handler, not in the shared function. Card processors do not need them.

The current Analyst `ToolResult` type carries `preview` and `errorEnvelope` (with a typed `kind`) for UI shaping. This refactor deletes those fields from the shared `ToolResult` (§3.9). Analyst shaping derives from `data` content (tool-specific shapes inspected inside the post-hook) rather than from typed envelope fields on the result type. This is an intentional simplification: the `preview`/`errorEnvelope` machinery was analyst-specific complexity leaking into the shared contract. If a future tool genuinely needs to return structured shaping hints, they go in `data`, not in new top-level fields.

### 3.9 The result

```ts
type ToolResult =
  | { success: true; data?: unknown; error?: never }
  | { success: false; error: string; data?: unknown };
```

A discriminated union on `success`. This makes `{ success: true, error }` and `{ success: false }` (no error) into compile-time type errors: the success branch forbids `error` via `error?: never`, and the failure branch requires `error: string`. The failure branch may also carry an optional `data` field so a tool can return a structured diagnostic payload alongside the error string (for example partial results, validation details, or delivery metadata). The previous claim that `{ data, error }` is a compile-time error is retracted; that combination is valid on the failure branch. The success branch carries `data` only; `error` is forbidden on success.

One result type, no `code`/`kind`/`metadata`/`preview`/`errorEnvelope` fields. The caller — Analyst handler or card processor — serializes it for the provider.

Transcript shape is derived from `success`:

- `success: true` → a `tool_result` transcript entry containing `data`.
- `success: false` → a `tool_error` transcript entry containing the `error` string.

There is no `code` field on the error. Coarse error categorization (permission vs not-found vs io) is not part of the contract; if a future UI need emerges it can be added as an optional field, but it is not spec'd now. **This supersedes** the `{ error, code? }` wire shape described in `tool-set-reorganization-design.md` §7.

### 3.10 Tool executor contract

`invokeTool` does not catch executor exceptions. Tool executors must follow this rule:

- **Expected/model/project failures** (path denied, slot-writer violation, card not found, command exited non-zero) → return `{ success: false, error }`.
- **Impossible programmer/configuration states** (duplicate tool name, provider constructed without required state) → throw.

This keeps `invokeTool` transparent: it never swallows a bug as a silent tool error, and it never crashes the activation for expected model output.

`invokeToolForLlm`, the LLM-call-path sibling, does catch and converts thrown errors to `{ success: false, error }` unless the signal aborted (see §3.4). Call sites that need exceptions to surface as activation/session failures use `invokeTool` directly; call sites that need every error shaped as a model-visible `ToolResult` use `invokeToolForLlm`.

### 3.11 Relationship to the tool catalog

This design replaces the catalog as the **execution and schema authority**. There is no `tool-catalog.ts`-style module of detached definitions that tools dig through with a context bag. Each `ToolDefinition` carries its own `inputSchema`; schemas live on providers alongside the execution they describe.

What is **preserved** from `tool-set-reorganization-design.md` is the **vocabulary**: the canonical tool names, role assignments, scoped-URL rules, and security policy defined there. Those definitions move onto providers. The tool-set doc remains the authority for *what* the tools are and *who* gets them; this doc is the authority for *how* they are invoked.

**Tool names are global; schemas are surface-local.** The same tool name may carry a different schema on different surfaces when roles intentionally differ. For example, the planner's `create_card` is scoped to immediate non-project children with a `brief` field; the analyst's `create_card` allows any parent. Each provider defines its own `inputSchema` for the tools it exposes; the `InvocationSurface` is the authority for what schema the model actually sees. A derived read-only aggregate of all provider tools (for docs validation and schema export) must account for surface-local schema variants — it is never used to build runtime prompts.

The `InvocationSurface` (§3.3) is the only aggregate used at runtime: it collects a surface's provider tools into the `Map` used for both name lookup (`invokeTool`) and LLM prompt/tool export. Runtime model prompts derive **only** from the active `InvocationSurface`, never from a global aggregate.

## 4. Design Goals

1. Keep role orchestration explicit. Analyst chat behavior, planner sequencing, executor process ownership, reviewer assessment, and terminal result validation remain role-specific.
2. Co-locate tool logic with domain ownership. Card tools live on the planner. Operator-control tools live on the analyst handler. Filesystem, patch, process, web, and inspection tools live in generic providers. No detached functions digging through a context bag.
3. Share mechanics below orchestration. JSON deserialization, schema validation, tool lookup, invocation, and result normalization are shared. The provider model determines what tools exist and where their logic lives; `invokeTool` just runs them.
4. Make tool surfaces explicit by construction. A tool is available because a provider in the agent's composition list registered it. Unknown tools return a `ToolResult` error — no catch-all.
5. No compatibility shims. `ToolDispatcher`, `AnalystAdapter`, `processWorkspaceToolCall`, and the global tool catalog are deleted.

## 5. Migration Plan

No temporary wrappers, aliases, or adapter providers over old catalog functions survive into the accepted endpoint.

1. Define `ToolResult`, `ToolDefinition`, `ToolReplayOutcome`, `ToolProviderCleanupReason`, `ToolProvider`, `InvocationSurface`, `defineTool`, `buildInvocationSurface`, `invokeTool`, `invokeToolForLlm`, `replayToolForRecovery`, `invokeToolCall`, and `cleanupInvocationSurface`.
2. Implement generic providers (`WorkspaceProvider`, `PatchProvider`, `ProcessProvider`, `WebProvider`, `CardInspectionProvider`, `CardHistoryProvider`, `McpProvider`, `SkillProvider`). Each is constructed with the minimal context it needs.
3. Make each domain owner implement `ToolProvider` for its role-specific tools: `PlanningCardProcessorActor` (card control) and `AnalystHandler` (analyst control). Tool logic moves from detached catalog functions to bound methods. The executor and reviewer are not domain providers.
4. Compose each agent's provider list and build its invocation surface at construction time.
5. Point Analyst handler and card processors at `invokeToolCall`. Delete `ToolDispatcher`, `AnalystAdapter`, `processWorkspaceToolCall`, and the global tool catalog.
6. Move Analyst audit logging and event broadcasting into Analyst-handler pre/post hooks around `invokeToolCall`. Derive shaping from `data` content instead of `preview`/`errorEnvelope`.
7. Delete duplicated result types (`AdapterResult`, `ToolDispatchResult`, `ToolErrorEnvelope`, `ActionPreview`). Everything returns `ToolResult`.
8. Update tests to assert `invokeTool` behavior per role surface instead of old adapter internals.

### 5.1 Current Implementation Audit

As of 2026-07-02, the provider migration and result-contract collapse are implemented. Confirmed status:

- `ToolDispatcher`, `AnalystAdapter`, `processWorkspaceToolCall`, `ActorToolSurface`, and the old actor tool-definition module are gone from active source.
- Planner, executor, reviewer, and Analyst runtime model tool advertisements derive from each active `InvocationSurface` plus each role's contract terminal where applicable.
- `ToolResult` is the clean discriminated union, and `WorkspaceProvider` only converts expected workspace/input/filesystem failures into model-visible tool errors.
- `write_file` is removed from active source; Analyst explicit-card brief writes use canonical `write`.
- The stale global catalog (`src/tools/definitions/index.ts`), catalog-only wrappers, `agent-tool-catalog.ts`, and the legacy planner-control executor are deleted. `InvocationSurface` and provider-owned schemas are the only runtime tool schema/execution authority.

Confirmed completed cleanup:

- The Analyst active surface now matches §3.5 for inspection/history: `CardInspectionProvider` and `CardHistoryProvider` are composed into the Analyst `InvocationSurface`, while the Analyst control registry owns only operator-control tools.
- Terminal unification is implemented: planner, executor, and reviewer use `emit_result` with role-specific status subsets over the common `{ status, summary }` envelope. Legacy `report_goal_*` support and role-specific `emit_*_result` names are removed from active prompts, repair prompts, schemas, and tests.
- `webfetch.save_as` now pre-authorizes and writes through the same scoped URL write path used by `write` (`project://`, `record://`, `tmp://`, and role/slot policy), including analyst explicit-card `brief.md` writes.
- Lifecycle storage/API shape is collapsed to `done`, `blocked`, `failed`, and `rework` result kinds, plus the internal `executor_needs_verification` runtime result. Legacy persisted result kinds such as `executor_success`, `planner_done`, `planner_blocked`, `planner_failure`, `reviewer_pass`, and `reviewer_correction` are removed from active schemas and tests.

## 6. Validation Strategy

Focused tests should cover:

- Duplicate tool name across providers → `buildInvocationSurface` throws.
- Unknown tool from model → `invokeTool` returns `{ success: false, error }`.
- Invalid arguments → schema parse failure returns a model-visible tool error, not a thrown exception.
- Malformed JSON arguments → `invokeToolCall` returns `{ success: false, error }`, not a thrown exception.
- `ToolResult` discriminated union: `{ success: true, error }` and `{ success: false }` (no error) are compile-time type errors.
- Domain provider isolation: planner card tools are present only when the planner provider is composed into the surface. Composing it into an executor surface is a configuration bug caught by review/tests, not a runtime check — and not a type-level impossibility.
- Patch availability: `PatchProvider` (`apply_patch`) is composed only into executor and analyst; planner and reviewer surfaces must not include it.
- Workspace tool path-scope enforcement (`project://`, `record://`, `tmp://`, `system://`, slot-writer rules) inside the workspace provider's tool executors, keyed on `agentRole`, including the analyst as a permitted project writer.
- `webfetch.save_as` path authorization uses the same scoped write policy as `write`, keyed on the web provider's `{ projectRoot, cardId?, agentRole }` context.
- Analyst record/tmp addressing: analyst `record://` and `tmp://` URLs carry an explicit `?card=<id>`; card processors reject URLs targeting a card other than their activation card.
- Process ownership: `ProcessProvider` is constructed with an `ownerId` (activation id or session id) and optional `cardId` provenance metadata; `wait_process`/`kill_process` reject processes not owned by that context. A new activation of the same card starts with no inherited processes. Analyst session cleanup terminates owned processes. `card_id` is retained on `ProcessRecord` as provenance metadata only, never used for ownership checks; Analyst command records use the session id there until `ProcessRecord.card_id` becomes nullable.
- Surface-local schemas: planner `create_card` schema differs from analyst `create_card` schema; each surface exposes the correct variant.
- Reviewer record-only mutation: `write`/`edit` restricted to `record://review.md` by the workspace provider's path policy keyed on `agentRole`.
- MCP availability: `McpProvider` is included in the composition list or not. Dynamic MCP capability policy is still enforced inside the provider (for example reviewer calls require read-only, non-destructive tool metadata), because MCP tool identity is runtime data supplied through the wrapper.
- Expected failures return `ToolResult`; impossible states throw (no broad catch in `invokeTool`).
- Call sites must not catch all exceptions from `invokeTool` and convert them into model-visible tool errors. Expected/model/project failures are already `ToolResult`s. Exceptions are bugs or impossible states and should fail the activation/session at the normal boundary.

End-to-end validation should include:

- One Analyst workspace read or card inspection tool call.
- One planner workspace read and child card mutation.
- One executor file, patch, or process tool call.
- One reviewer workspace read.
- One terminal contract success path for each card role.

## 7. Risks

| Risk | Mitigation |
| --- | --- |
| Provider becomes an adapter with policy logic | Generic providers are named arrays of tool definitions with no dispatch interception (`handles()`, `policyInput()`). Generic providers carry no runtime state beyond constructor-captured context and own their implementation directly. Domain providers (the planner actor, the analyst handler) carry live domain state by design — that is the point of co-location; their state is the domain they own, not adapter policy. |
| Analyst audit/events drift | Audit and event broadcasting stay in the Analyst handler as pre/post hooks around `invokeToolCall`; `invokeTool` has no side effects beyond the tool itself. Shaping derives from `data`, not from deleted typed envelope fields. |
| Process state outlives its owner | Process state lives in the durable process store (`processApi`), scoped by `owner_id` (activation id or session id). Executor activations kill owned processes on settlement; Analyst websocket cleanup kills owned session processes. A new activation of the same card starts with no inherited processes. `card_id` is kept on `ProcessRecord` as provenance metadata for UI and notifications, but is never used as an ownership key. |
| Terminal result lifecycle becomes over-generic | `emit_result` stays in processor loops; it is never a provider tool or passed through `invokeTool`. |
| Wrong provider composition exposes a role's tools to another role | Composition is the authority, not a type system. Surface construction is reviewed and tested per role; a derived "all tools" aggregate is read-only and never used for invocation. |

## 8. Explicit Decisions

These are decided, not open. If a concrete need to change them appears later, the provider-based design makes that change additive, not structural.

1. Terminal tools (`emit_result`) stay direct processor validation. They drive card lifecycle transitions; they are not side-effect tools and never pass through `invokeTool`.
2. `activate_card` is a planner provider tool. It flows through `invokeTool` like any other tool — its executor is a bound method on the planner actor that has natural access to the activation callback via `this`.
3. The reviewer has no domain-specific provider. Its tool surface is generic providers only (workspace, web, MCP, skill, card-history) plus the terminal tool.
4. There is no global catalog module that is the execution or schema authority. Tool schemas and execution live together on providers (domain providers and generic providers). See §3.11 for how this relates to the tool vocabulary in `tool-set-reorganization-design.md`.
5. The result contract is a discriminated union `{ success: true; data?: unknown; error?: never } | { success: false; error: string; data?: unknown }` with no error `code`, no `preview`, no `errorEnvelope`. This supersedes the `{ error, code? }` shape in `tool-set-reorganization-design.md` §7 (see §3.9). Analyst shaping moves into the handler's post-hook, deriving from `data`.
6. Process tools are a generic `ProcessProvider`, not executor-actor methods. Both executor and analyst compose it with an owner context (`ownerId`) and optional provenance context (`cardId`). For the executor, `ownerId` is the unique **activation id** (not the card id) and `cardId` is the activation card id, so a new activation of the same card starts with no inherited processes while process listings still show the associated card. For the analyst, `ownerId` is the **session id** and command records are marked `owner_kind: 'operator'`; because `ProcessRecord.card_id` is still required, Analyst records use the session id in `card_id` as non-authoritative scope metadata. The handler kills owned processes on session cleanup. The durable process store is the authority. `card_id` is retained on `ProcessRecord` as provenance metadata for UI, notifications, and analyst preview filtering, but is never used for ownership checks.
7. Tool names are global; schemas are surface-local. The same tool name may carry a different schema on different surfaces (e.g., planner `create_card` vs analyst `create_card`). The `InvocationSurface` is the authority for what schema the model sees.
8. `ToolDefinition` is generic over `Args`; a `defineTool` factory infers the executor's argument type from the schema. The generic is erased to `any` in heterogeneous provider arrays, but each executor remains internally typed.
9. `WebProvider` takes `{ projectRoot, cardId?, agentRole }` — the same write-policy context as workspace tools — because `webfetch.save_as` writes to the project filesystem under the same scoped authorization as `write`, including `record://` slot rules and analyst explicit `?card=<id>` targets.
