# Role Invocation Surface Design

Status: design proposal.

Date: 2026-07-05

## Problem

Planner, reviewer, executor, and analyst each assemble an `InvocationSurface` by hand from the same provider family:

- `src/runtime/actors/planning-card-processor-actor.ts` builds planner and reviewer surfaces.
- `src/runtime/actors/terminal-card-processor-actor.ts` builds the executor surface.
- `src/agents/analyst-handler.ts` builds the analyst surface.

The role differences are intentional capability boundaries. The scattered assembly is not. Adding, removing, or reconfiguring a provider currently requires editing several unrelated classes that should be focused on role behavior, not provider wiring.

Current role/provider matrix:

| Provider | Planner | Reviewer | Executor | Analyst |
| --- | --- | --- | --- | --- |
| planner-control | yes | no | no | no |
| analyst-control | no | no | no | yes |
| card-inspection | yes | no | no | yes |
| workspace | yes | yes | yes | yes |
| patch | no | no | yes | yes |
| process | no | no | yes, agent-owned | yes, operator-owned |
| card-history | yes | yes | yes | yes |
| web | yes | yes | yes | yes |
| skill | no | yes | yes | yes |
| mcp | no | yes | yes | yes |

The matrix is current behavior and should not change as part of F09.

## Decision

Create a small role-surface factory module with one explicit builder per role:

```ts
buildPlannerInvocationSurface(args: PlannerInvocationSurfaceArgs): InvocationSurface
buildReviewerInvocationSurface(args: ReviewerInvocationSurfaceArgs): InvocationSurface
buildExecutorInvocationSurface(args: ExecutorInvocationSurfaceArgs): InvocationSurface
buildAnalystInvocationSurface(args: AnalystInvocationSurfaceArgs): InvocationSurface
```

The public API is intentionally not `buildRoleSurface(role, ctx)`. A single generic function would force a wide optional context where most fields are invalid for most roles. Four narrow functions make the required dependencies obvious and let TypeScript reject missing role-specific inputs without runtime assertions.

The factory module becomes the one production place where role capabilities are assembled. Processor and analyst code keep small wrapper methods only when they need a convenient local name or parameter adaptation; those wrappers must delegate directly to the factory and must not construct providers.

## New module layout

### `src/tools/analyst-control-provider.ts`

Move the local Analyst control provider from `analyst-handler.ts` into its own provider module:

```ts
export function createAnalystControlProvider(ctx: ToolContext): ToolProvider
```

This mirrors `planner-control-provider.ts`. It uses the existing `ANALYST_CONTROL_TOOLS`, `ToolContext`, `defineTool`, and `ToolProvider` types. It does not import `AnalystSessionActor`, `AnalystRuntime`, or runtime session state.

### `src/tools/role-invocation-surfaces.ts`

This module imports provider constructors and exports the four role builders. It does not replace `buildInvocationSurface`; it uses it.

Suggested argument shapes:

```ts
export interface PlannerInvocationSurfaceArgs {
  projectRoot: string;
  parentCardId: string;
  sessionId: string;
  store: PlannerControlProviderContext['store'] & CardInspectionProviderContext['store'];
  children: PlannerControlProviderContext['children'];
  notifyCard?: PlannerControlProviderContext['notifyCard'];
}

export interface ReviewerInvocationSurfaceArgs {
  projectRoot: string;
  cardId: string;
  sessionId: string;
  mcpManagerProvider: () => McpToolInvocationPort | undefined;
}

export interface ExecutorInvocationSurfaceArgs {
  projectRoot: string;
  cardId: string;
  processRunner: ProcessRunner;
  processOwnerId: string;
  runtimeGate: RuntimeGate;
  mcpManagerProvider: () => McpToolInvocationPort | undefined;
}

export interface AnalystInvocationSurfaceArgs {
  projectRoot: string;
  ctx: ToolContext;
  mcpManagerProvider: () => McpToolInvocationPort | undefined;
}
```

The exact type imports can be adjusted to avoid cycles, but the public shape should stay narrow. Do not introduce a catch-all context object with many optional fields.

## Role builders

### Planner

`buildPlannerInvocationSurface(...)` returns:

```ts
buildInvocationSurface('planner', [
  createPlannerControlProvider({ projectRoot, parentCardId, sessionId, store, children, notifyCard }),
  createCardInspectionProvider({ projectRoot, store, agentRole: 'planner' }),
  createWorkspaceProvider({ projectRoot, cardId: parentCardId, agentRole: 'planner' }),
  createCardHistoryProvider({ projectRoot, sessionId, agentRole: 'planner' }),
  createWebProvider({ projectRoot, cardId: parentCardId, agentRole: 'planner' }),
])
```

Planner still lacks patch, process, skill, and MCP. That is deliberate.

### Reviewer

`buildReviewerInvocationSurface(...)` returns:

```ts
buildInvocationSurface('reviewer', [
  createWorkspaceProvider({ projectRoot, cardId, agentRole: 'reviewer' }),
  createCardHistoryProvider({ projectRoot, sessionId, agentRole: 'reviewer' }),
  createWebProvider({ projectRoot, cardId, agentRole: 'reviewer' }),
  createSkillProvider({ projectRoot, agentRole: 'reviewer' }),
  createMcpProvider({ mcpManagerProvider, agentRole: 'reviewer' }),
])
```

Reviewer still lacks card-inspection, patch, process, and planner-control. Reviewer MCP restrictions remain inside `createMcpProvider`, where they are today.

### Executor

`buildExecutorInvocationSurface(...)` returns:

```ts
buildInvocationSurface('executor', [
  createWorkspaceProvider({ projectRoot, cardId, agentRole: 'executor' }),
  createPatchProvider({ projectRoot, cardId, agentRole: 'executor' }),
  createProcessProvider({ projectRoot, processRunner, ownerId: processOwnerId, ownerKind: 'agent', cardId, runtimeGate }),
  createCardHistoryProvider({ projectRoot, sessionId: processOwnerId, agentRole: 'executor' }),
  createWebProvider({ projectRoot, cardId, agentRole: 'executor' }),
  createSkillProvider({ projectRoot, agentRole: 'executor' }),
  createMcpProvider({ mcpManagerProvider, agentRole: 'executor' }),
])
```

Executor process ownership remains agent-owned and runtime-gated.

### Analyst

`buildAnalystInvocationSurface(...)` returns:

```ts
buildInvocationSurface('analyst', [
  createAnalystControlProvider(ctx),
  createCardInspectionProvider({ projectRoot, store: ctx.store, agentRole: 'analyst' }),
  createCardHistoryProvider({ projectRoot, store: ctx.store, sessionId: ctx.sessionId, agentRole: 'analyst' }),
  createWorkspaceProvider({ projectRoot, agentRole: 'analyst', store: ctx.store }),
  createPatchProvider({ projectRoot, agentRole: 'analyst', store: ctx.store }),
  createProcessProvider({ projectRoot, processRunner: ctx.processRunner, ownerId: ctx.sessionId ?? 'analyst', agentRole: 'analyst', ownerKind: 'operator', launchReason: 'analyst workspace run_command' }),
  createWebProvider({ projectRoot, agentRole: 'analyst', store: ctx.store }),
  createSkillProvider({ projectRoot, agentRole: 'analyst' }),
  createMcpProvider({ mcpManagerProvider, agentRole: 'analyst' }),
])
```

Analyst process ownership remains operator-owned and intentionally not runtime-gated by `ProcessProvider`.

## Call-site changes

- `PlanningCardProcessorActor.plannerInvocationSurface(...)` delegates to `buildPlannerInvocationSurface(...)`.
- `PlanningCardProcessorActor.reviewerInvocationSurface(...)` delegates to `buildReviewerInvocationSurface(...)`.
- `TerminalCardProcessorActor.executorInvocationSurface(...)` delegates to `buildExecutorInvocationSurface(...)`.
- `analyst-handler.ts` deletes local `analystControlProvider` and `analystInvocationSurface`, then calls `buildAnalystInvocationSurface(...)`.
- `AnalystSessionActor.shutdownSessionProcesses(...)` may continue to call `createProcessProvider(...).cleanup(...)` directly. That is process cleanup, not invocation-surface assembly.

## What this design deliberately does not do

### No generic provider plugin system

Providers should not declare `roles: AgentRole[]`, and `buildInvocationSurface` should not filter a global provider registry by role. That would push role policy into every provider and make role-specific providers carry redundant self-descriptions. The role surface module is the policy boundary.

### No loose `buildRoleSurface(role, ctx)` API

A single generic builder with optional `cardId`, `store`, `children`, `processRunner`, `runtimeGate`, `mcpManagerProvider`, and control-tool fields would be easier to call incorrectly. It would also force runtime assertions for role-specific requirements. Four explicit builders are less clever and cleaner.

### No old policy list revival

Do not reintroduce `RoleToolPolicy` or a separate permission matrix that duplicates provider composition. The provider list for each role is the executable capability policy.

### No behavior changes

F09 is a refactor. It must not add tools to planner/reviewer/executor/analyst or remove existing tools. In particular:

- Planner still has no `apply_patch`, `skill`, or `mcp_tool_call`.
- Reviewer still has no `apply_patch`, `run_command`, or card-inspection tools.
- Executor still has `apply_patch`, `run_command`, `skill`, and `mcp_tool_call`.
- Analyst still has control tools plus the shared provider tools.

## Tests

Add a focused test file for the factory, e.g. `tests/tools/role-invocation-surfaces.test.ts`.

The tests should assert exact tool-name sets for all four roles. Use real providers with minimal fake dependencies; do not mock the factory internals.

Expected provider-derived tools:

- Planner: `create_card`, `edit_card`, `cancel_card`, `activate_card`, `reorder_child`, `queue_notification`, `list_cards`, `get_card`, `get_tree`, `read`, `write`, `edit`, `glob`, `grep`, `list_card_history`, `get_card_history_entry`, `diff_card`, `websearch`, `webfetch`.
- Reviewer: `read`, `write`, `edit`, `glob`, `grep`, `list_card_history`, `get_card_history_entry`, `diff_card`, `websearch`, `webfetch`, `skill`, `mcp_tool_call`.
- Executor: reviewer tools plus `apply_patch`, `run_command`, `wait_process`, `kill_process`.
- Analyst: Analyst control tools plus `list_cards`, `get_card`, `get_tree`, `read`, `write`, `edit`, `apply_patch`, `glob`, `grep`, `run_command`, `wait_process`, `kill_process`, `list_card_history`, `get_card_history_entry`, `diff_card`, `websearch`, `webfetch`, `skill`, `mcp_tool_call`.

Also update `tests/agents/analyst-tool-surface.test.ts` so its production-shaped Analyst surface uses `buildAnalystInvocationSurface(...)` rather than hand-building the same provider list. That test should not preserve a second copy of the assembly logic.

## Validation

- `npm run typecheck`
- `NODE_OPTIONS=--experimental-vm-modules npx jest tests/tools/role-invocation-surfaces.test.ts tests/agents/analyst-tool-surface.test.ts tests/runtime/actors/planning-card-processor-actor.test.ts tests/runtime/actors/terminal-card-processor-actor.test.ts --runInBand --forceExit`
- `npm run validate:routine`
- `npm test`
- `npm run build`
