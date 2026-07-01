# Shared Tool Invocation Design

Status: design proposal.

Date: 2026-07-01

## 1. Purpose

Saivage currently has duplicated tool execution logic across the Analyst chat path and the micro-actor card processors. The duplication is not just cosmetic: parsing, policy checks, error normalization, result envelopes, workspace tool routing, and tool definition ownership are split across several modules.

This document proposes a shared invocation layer that removes duplicated mechanics while preserving the important semantic difference between:

- Analyst as the global operator-facing chat/control surface.
- Planner, executor, and reviewer as card-scoped runtime workers.

The target is not to make Analyst use card processor code directly. The target is to make both Analyst and card processors use the same lower-level tool invocation primitives where their capabilities overlap.

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
- Terminal tools such as `emit_planner_result`, `emit_executor_result`, and `emit_reviewer_result` are contract tools validated by the processor loops, not generic tools.

### Duplication

The following mechanics are duplicated or fragmented:

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

2. Share mechanics below orchestration. Argument parsing, policy evaluation, dispatch adapter lookup, result normalization, truncation, and common workspace/card/runtime tool execution should be reusable.

3. Make tool surfaces explicit. A tool should be available because the role surface registered it, not because an adapter silently accepts every name.

4. Preserve actor ownership boundaries. Executor background processes remain owned by the executor activation. Planner child activation remains owned by the planner processor. Analyst runtime control remains Analyst/operator scoped.

5. Avoid compatibility shims. This is an internal refactor. Existing dead aliases should not be preserved just to keep old paths alive.

## 4. Non-Goals

- Do not merge Analyst into the card runtime. Analyst remains a global operator-facing agent.
- Do not let Analyst call terminal contract tools.
- Do not let planner/executor/reviewer call Analyst-only runtime control or navigation tools.
- Do not introduce a new compatibility layer for retired tool names.
- Do not move process ownership out of the executor actor in the initial refactor.
- Do not change provider-visible tool names as part of this design. Naming changes belong to [Tool Set Reorganization Design](./tool-set-reorganization-design.md).

## 5. Desired Architecture

Introduce a shared `ToolInvocationService` that sits below role orchestration and above concrete tool implementations.

```text
AnalystHandler
  -> ToolInvocationService
       -> registered adapters
       -> RoleToolPolicy
       -> normalized result

PlanningCardProcessorActor
  -> ToolInvocationService
       -> planner card adapter
       -> workspace adapter
       -> normalized result

TerminalCardProcessorActor
  -> ToolInvocationService
       -> executor process adapter
       -> workspace adapter
       -> normalized result

Reviewer loop
  -> ToolInvocationService
       -> workspace adapter
       -> normalized result
```

The service owns common invocation mechanics. Callers still own what happens before and after a tool call.

### 5.1 Invocation input

```ts
interface ToolInvocationRequest {
  toolName: string;
  toolCallId: string;
  rawArguments?: string;
  args?: Record<string, unknown>;
  role: 'analyst' | 'planner' | 'executor' | 'reviewer';
  sessionId: string;
  cardId?: string;
  surface: ToolInvocationSurface;
  projectRoot: string;
  context: ToolInvocationContext;
}
```

`rawArguments` supports Analyst and any future envelope-based caller. `args` supports current `LLMActorOutcome.args` callers. Exactly one is required. The service parses or validates once and produces a normalized argument object.

### 5.2 Invocation context

```ts
interface ToolInvocationContext {
  cardStore?: CardStore;
  runtime?: RuntimeControlPort;
  mcpManager?: McpManager;
  eventBus?: EventBus;
  requestServerRestart?: () => Promise<void>;
  processOwner?: ExecutorProcessOwner;
  analystSurface?: ControlActionSurface;
}
```

The context is capability injection, not global state. Adapters fail fast if required context is missing.

### 5.3 Invocation result

```ts
interface ToolInvocationResult {
  success: boolean;
  toolName: string;
  toolCallId: string;
  data?: unknown;
  error?: string;
  errorKind?: string;
  metadata?: Record<string, unknown>;
  modelContent: string;
}
```

`modelContent` is the provider-visible tool result content. Role callers can additionally inspect `data`, `errorKind`, and metadata for UI events or control decisions.

## 6. Adapter Model

Adapters implement concrete capabilities. They are registered explicitly per role surface.

```ts
interface ToolInvocationAdapter {
  readonly category: string;
  readonly toolNames: readonly string[];
  policyInput?(request: NormalizedToolInvocationRequest): RolePolicyInput;
  invoke(request: NormalizedToolInvocationRequest): Promise<ToolInvocationAdapterResult>;
}
```

No adapter should use `handles(): true`. Catch-all dispatch hides stale tool names and makes policy hard to reason about. Unknown tools should be an invocation-service error based on the registered surface.

### Adapter categories

| Adapter | Used by | Notes |
| --- | --- | --- |
| Workspace adapter | Planner, executor, reviewer, Analyst | Wraps `processWorkspaceToolCall(...)` or its successor. Handles file/search/record tools. |
| Planner card adapter | Planner | Owns `create_card`, `edit_card`, `cancel_card`, and similar immediate-child mutations. Calls processor-owned methods or a narrow card mutation port. |
| Planner activation adapter | Planner | Optional thin wrapper for `activate_card`; sequencing remains processor-owned. |
| Executor process adapter | Executor | Wraps `run_process`, `wait_process`, `inspect_process`, `kill_process` through the executor actor's `ProcessActor` ownership. |
| Analyst card/control adapter | Analyst | Wraps Analyst card-management and runtime-control tools through canonical services. |
| Analyst navigation/read-model adapter | Analyst | Wraps UI navigation and debug/read-model tools. |
| MCP adapter | Executor, reviewer, Analyst where enabled | Calls configured MCP manager with role policy. |
| Terminal contract tools | Planner, executor, reviewer | Not generic adapters initially. Processor loops should continue validating terminal outcomes directly. |

Terminal tools are deliberately excluded from the first shared service pass because they are not ordinary side-effect tools. They close a card activation and drive runtime lifecycle transitions.

## 7. Role-Specific Orchestration After Refactor

### Analyst

`AnalystHandler` keeps responsibility for:

- Session queueing.
- Workspace context note insertion.
- Analyst prompt construction.
- Analyst activity callbacks.
- `analyst_tool_invoked` event broadcasts.
- Mapping selected tool results to final operator replies.

It delegates only execution mechanics:

```ts
const result = await toolInvocationService.invoke({
  role: 'analyst',
  surface: 'analyst-web-chat',
  analystSurface: this.surface,
  toolName: toolCall.toolName,
  toolCallId: toolCall.toolCallId,
  rawArguments,
  sessionId,
  projectRoot: this.projectRoot,
  context: analystContext,
});
```

### Planner

`PlanningCardProcessorActor` keeps responsibility for:

- Parent/child ownership checks.
- Active child actor lookup.
- Activation result delivery.
- Planner terminal contract validation and reviewer launch.

It delegates planner card mutations and workspace tools to the shared service. If `activate_card` is adapted, the adapter must call back into a processor-owned activation port rather than directly dispatching child actors from generic code.

### Executor

`TerminalCardProcessorActor` keeps responsibility for:

- Process actor retention and shutdown.
- Owned process lifecycle.
- Executor terminal contract validation.

It delegates common invocation mechanics, but the executor process adapter receives an activation-local `processOwner` so generic code cannot outlive the activation.

### Reviewer

The reviewer loop keeps responsibility for:

- Review prompt construction.
- Review record-slot expectations.
- Reviewer terminal contract validation.

It delegates read-only workspace/record/MCP inspection tools to the shared service.

## 8. Policy Model

`RoleToolPolicy` should remain the central policy evaluator, but the inputs should be normalized by the invocation service.

Policy inputs should include:

- Role.
- Surface.
- Tool name.
- Card id, when card-scoped.
- Analyst control surface, when Analyst-scoped.
- Whether the tool is registered for the current surface.
- Adapter-provided operation metadata, such as target scope or card action.

The first policy gate is registration: if the current role surface did not register the tool, the call is denied as unknown/unsupported. The second gate is semantic policy: if the tool is registered but the request exceeds authority, return a structured policy denial.

## 9. Migration Plan

### Phase 1: Extract shared result and parsing mechanics

- Add `ToolInvocationService` with explicit adapter registration.
- Port `ToolDispatcher` tests to the new service where they test generic behavior.
- Keep `ToolDispatcher` as a thin temporary wrapper only if needed during the branch, then delete it before completion.
- Do not change provider-visible tool names or role surfaces.

### Phase 2: Port workspace tools

- Add a `WorkspaceToolAdapter` around `processWorkspaceToolCall(...)`.
- Replace planner, executor, and reviewer direct workspace calls with service calls.
- Replace Analyst workspace-tool entries in `TOOL_REGISTRY` with the same adapter-backed path.
- Verify malformed workspace arguments return consistent model-visible errors for all roles.

### Phase 3: Make Analyst adapters explicit

- Replace `AnalystAdapter` catch-all behavior with explicit Analyst adapters and registered tool names.
- Unknown Analyst tools become normal unsupported-tool results.
- Keep Analyst activity broadcasting and response shaping in `AnalystHandler`.

### Phase 4: Port planner and executor local tools

- Wrap planner card mutation tools with a planner card adapter that calls processor-owned ports.
- Wrap executor process tools with an executor process adapter injected with activation-local process ownership.
- Keep `activate_card` and terminal contracts processor-owned unless a narrow activation adapter proves simpler and equally explicit.

### Phase 5: Delete obsolete surfaces

- Delete `ToolDispatcher` if fully superseded.
- Delete duplicated helper result types that were only needed by `ToolDispatcher`/`AnalystAdapter`.
- Delete any tests that assert old adapter internals rather than public behavior.

## 10. Validation Strategy

Focused tests should cover:

- Unknown tool handling per role surface.
- Invalid JSON and invalid argument-object handling.
- Workspace tool validation errors returning model-visible tool errors, not thrown activation failures.
- Analyst policy denials by `ControlActionSurface`.
- Planner immediate-child card mutation policy.
- Executor process lifecycle ownership and cleanup after activation settlement.
- Reviewer read-only tool restrictions.
- MCP adapter registration and denial behavior where MCP is unavailable.

End-to-end validation should include:

- One Analyst workspace read or card inspection tool call.
- One planner workspace read and child card mutation.
- One executor file or process tool call.
- One reviewer workspace read.
- One terminal contract success path for each card role.

## 11. Risks

| Risk | Mitigation |
| --- | --- |
| Generic service becomes a new god object | Keep orchestration out of the service. It invokes one tool and returns one normalized result. |
| Analyst authority leaks to card agents | Register role surfaces explicitly and require semantic policy input for sensitive tools. |
| Executor process actors outlive activation | Inject activation-local `processOwner`; no global process adapter state. |
| Terminal result lifecycle becomes over-generic | Keep terminal contract validation in processor loops for the initial refactor. |
| Result shaping changes model behavior | Preserve provider-visible tool names and content in early phases; change one adapter family at a time. |

## 12. Open Questions

1. Should `activate_card` remain direct processor code forever, or become an adapter that calls a processor-owned activation port?
2. Should terminal tools eventually be represented as adapters with a `terminal: true` flag, or is direct processor validation clearer?
3. Should `ToolInvocationResult.modelContent` always be JSON, or should some tools keep plain text for provider ergonomics?
4. Should Analyst control tools and card-management tools share one adapter or be split by authority domain?

The initial implementation should answer none of these with broad abstractions. Start by unifying workspace tool invocation and explicit Analyst adapter registration; those changes remove duplication without weakening role boundaries.
