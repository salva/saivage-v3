# Role Invocation Surface Design

Status: design proposal (third review, data-driven).

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

Create `src/tools/role-invocation-surfaces.ts` with a single data-driven builder. The capability matrix is declarative data — a table mapping each role to its ordered provider list. The builder looks up the list and constructs each provider from a shared context.

```ts
function buildRoleSurface(role: AgentRole, ctx: RoleSurfaceContext): InvocationSurface {
  const providers = ROLE_PROVIDER_ORDER[role].map((name) => PROVIDER_CONSTRUCTORS[name](ctx, role));
  return buildInvocationSurface(role, providers);
}
```

The function body is one line of meaningful logic. Everything else is data.

### Why data-driven, not four builders

Four explicit builders (`buildPlannerInvocationSurface`, etc.) would work but add unnecessary ceremony: four function signatures, four argument interfaces, four near-identical function bodies. The only real information is **which providers each role gets** — and that is data, best expressed as a table.

A table-driven builder is simpler:

- The matrix is reviewable at a glance as declarative data.
- Adding or removing a provider for a role is a one-line table edit.
- One public function, one call pattern.
- Adding a new provider is one entry in the constructor map plus one string in the relevant role arrays.

### The non-null assertion tradeoff

`RoleSurfaceContext` has optional fields. The constructor map uses non-null assertions (`ctx.children!`, `ctx.processRunner!`, etc.) where a provider requires a field. These assertions are safe because the table guarantees each provider is only constructed for roles whose callers pass the required deps. A focused test asserting exact tool-name sets per role pins the contract.

This is preferred over four narrow argument interfaces because the table — not the type system — is the source of truth for which providers belong to which role. TypeScript cannot express "this field is required only when this provider is in the role's list" without per-role types, and per-role types defeat the purpose of the table.

### Third-review corrections

The data-driven approach is still the right direction, but the constructor map must preserve exact current provider arguments. Two details are load-bearing:

- **Process metadata:** executor currently omits `agentRole` and `launchReason`, so `ProcessProvider` defaults to `agent process provider run_command`. Analyst currently passes `agentRole: 'analyst'` and `launchReason: 'analyst workspace run_command'`. The generic `process` constructor must branch by role to preserve this.
- **Store forwarding:** Analyst currently passes its concrete `CardStore` to card-history, workspace, patch, web, and card-inspection providers. Processor surfaces generally do not pass their processor store to card-history/web/workspace; planner passes its store only to planner-control and card-inspection. The generic constructors must not forward `ctx.store` blindly to every provider for every role.

The table says **which providers exist** for a role. The constructor map still owns the exact per-provider argument derivation needed to preserve current behavior.

## New module layout

### `src/tools/analyst-control-provider.ts`

Move the local Analyst control provider from `analyst-handler.ts` into its own provider module:

```ts
export function createAnalystControlProvider(ctx: ToolContext): ToolProvider
```

This mirrors `planner-control-provider.ts`. It uses the existing `ANALYST_CONTROL_TOOLS`, `ToolContext`, `defineTool`, and `ToolProvider` types. It does not import `AnalystSessionActor`, `AnalystRuntime`, or runtime session state.

### `src/tools/role-invocation-surfaces.ts`

This module exports the capability table, the context type, and the builder. It imports provider constructors and uses `buildInvocationSurface`.

## The capability table

```ts
type ProviderName =
  | 'plannerControl'
  | 'analystControl'
  | 'cardInspection'
  | 'workspace'
  | 'patch'
  | 'process'
  | 'cardHistory'
  | 'web'
  | 'skill'
  | 'mcp';

const ROLE_PROVIDER_ORDER: Record<AgentRole, readonly ProviderName[]> = {
  planner:  ['plannerControl', 'cardInspection', 'workspace', 'cardHistory', 'web'],
  reviewer: ['workspace', 'cardHistory', 'web', 'skill', 'mcp'],
  executor: ['workspace', 'patch', 'process', 'cardHistory', 'web', 'skill', 'mcp'],
  analyst:  ['analystControl', 'cardInspection', 'cardHistory', 'workspace', 'patch', 'process', 'web', 'skill', 'mcp'],
};
```

This table IS the capability policy. It must not change as part of F09.

## Context

```ts
interface RoleSurfaceContext {
  projectRoot: string;
  cardId?: string;
  sessionId?: string;
  store?: unknown;
  processRunner?: ProcessRunner;
  ownerId?: string;
  runtimeGate?: RuntimeGate;
  mcpManagerProvider?: () => McpToolInvocationPort | undefined;
  children?: PlannerChildActorPort;
  notifyCard?: (cardId: string, notification: CardNotification) => NotifyCardResult;
  toolContext?: ToolContext;
}
```

All fields except `projectRoot` are optional. Each caller passes only what its role needs. `store` is intentionally typed broadly in this design because the current processor store and Analyst `CardStore` are different structural ports. Implementation should narrow or cast only inside the provider constructor that needs a specific store shape.

## Provider constructor map

A `Record<ProviderName, (ctx: RoleSurfaceContext, role: AgentRole) => ToolProvider>` map adapts the common context to each provider's narrow constructor args. Each provider constructor appears exactly once:

```ts
const PROVIDER_CONSTRUCTORS: Record<ProviderName, (ctx: RoleSurfaceContext, role: AgentRole) => ToolProvider> = {
  plannerControl: (ctx, _) =>
    createPlannerControlProvider({
      projectRoot: ctx.projectRoot, parentCardId: ctx.cardId!, sessionId: ctx.sessionId!,
      store: ctx.store!, children: ctx.children!, notifyCard: ctx.notifyCard,
    }),
  analystControl: (ctx, _) =>
    createAnalystControlProvider(ctx.toolContext!),
  cardInspection: (ctx, role) =>
    createCardInspectionProvider({ projectRoot: ctx.projectRoot, store: ctx.store as CardInspectionProviderContext['store'], agentRole: role }),
  workspace: (ctx, role) =>
    createWorkspaceProvider({ projectRoot: ctx.projectRoot, cardId: ctx.cardId, agentRole: role, store: role === 'analyst' ? ctx.store as WorkspaceProviderContext['store'] : undefined }),
  patch: (ctx, role) =>
    createPatchProvider({ projectRoot: ctx.projectRoot, cardId: ctx.cardId, agentRole: role, store: role === 'analyst' ? ctx.store as WorkspaceProviderContext['store'] : undefined }),
  process: (ctx, role) =>
    role === 'analyst'
      ? createProcessProvider({ projectRoot: ctx.projectRoot, processRunner: ctx.processRunner!, ownerId: ctx.ownerId ?? ctx.sessionId ?? 'analyst', agentRole: 'analyst', ownerKind: 'operator', launchReason: 'analyst workspace run_command' })
      : createProcessProvider({ projectRoot: ctx.projectRoot, processRunner: ctx.processRunner!, ownerId: ctx.ownerId ?? ctx.sessionId!, ownerKind: 'agent', cardId: ctx.cardId, runtimeGate: ctx.runtimeGate }),
  cardHistory: (ctx, role) =>
    createCardHistoryProvider({ projectRoot: ctx.projectRoot, store: role === 'analyst' ? ctx.store as CardHistoryProviderContext['store'] : undefined, sessionId: ctx.sessionId, agentRole: role }),
  web: (ctx, role) =>
    createWebProvider({ projectRoot: ctx.projectRoot, cardId: ctx.cardId, agentRole: role, store: role === 'analyst' ? ctx.store as WebProviderContext['store'] : undefined }),
  skill: (ctx, role) =>
    createSkillProvider({ projectRoot: ctx.projectRoot, agentRole: role as 'executor' | 'reviewer' | 'analyst' }),
  mcp: (ctx, role) =>
    createMcpProvider({ mcpManagerProvider: ctx.mcpManagerProvider!, agentRole: role as 'executor' | 'reviewer' | 'analyst' }),
};
```

The non-null assertions are safe: the table guarantees `plannerControl` is only constructed for planner (whose caller always passes `cardId`, `sessionId`, `store`, `children`), `process` only for executor and analyst (whose callers always pass `processRunner`), and `mcp` only for reviewer, executor, and analyst (whose callers always pass `mcpManagerProvider`).

The role checks inside the `process`, `workspace`, `patch`, `cardHistory`, and `web` constructors are not a second policy layer. They preserve current constructor arguments where the same provider name has role-specific wiring. The role/provider **membership** remains solely in `ROLE_PROVIDER_ORDER`.

The `as` casts on `skill` and `mcp` are safe because the table excludes planner from those providers, and the provider type signatures accept the remaining three roles.

## Call-site changes

Each caller constructs a `RoleSurfaceContext` from its own fields and calls `buildRoleSurface`:

```ts
// PlanningCardProcessorActor — planner
buildRoleSurface('planner', {
  projectRoot: this.projectRoot, cardId: parentCardId, sessionId: plannerActorId(parentCardId),
  store: this.store, children: this.children, notifyCard: this.notifyCard,
})

// PlanningCardProcessorActor — reviewer
buildRoleSurface('reviewer', {
  projectRoot: this.projectRoot, cardId, sessionId,
  mcpManagerProvider: this.mcpManagerProvider,
})

// TerminalCardProcessorActor — executor
buildRoleSurface('executor', {
  projectRoot: this.projectRoot, cardId: this.cardId, sessionId: processOwnerId, ownerId: processOwnerId,
  processRunner: this.processRunner, runtimeGate: this.gate, mcpManagerProvider: this.mcpManagerProvider,
})

// analyst-handler — analyst
buildRoleSurface('analyst', {
  projectRoot: this.args.projectRoot, toolContext: ctx,
  store: ctx.store, processRunner: ctx.processRunner,
  sessionId: ctx.sessionId, ownerId: ctx.sessionId ?? 'analyst',
  mcpManagerProvider: () => ctx.mcpManager,
})
```

The processor classes may keep thin private wrapper methods (`plannerInvocationSurface(parentCardId)`, `executorInvocationSurface(processOwnerId)`) that adapt local fields to the context and delegate. Those wrappers must not construct providers.

`analyst-handler.ts` deletes local `analystControlProvider` and `analystInvocationSurface`. `AnalystSessionActor.shutdownSessionProcesses` may continue to call `createProcessProvider(...).cleanup(...)` directly — that is process cleanup, not surface assembly.

## What this design deliberately does not do

### No providers-as-plugins

Providers should not declare `roles: AgentRole[]`, and `buildInvocationSurface` should not filter a global provider registry by role. That would push role policy into every provider and make role-specific providers carry redundant self-descriptions. The role surface module is the policy boundary.

### No old policy list revival

Do not reintroduce `RoleToolPolicy` or a separate permission matrix that duplicates provider composition. The `ROLE_PROVIDER_ORDER` table is the executable capability policy.

### No behavior changes

F09 is a refactor. It must not add tools to planner/reviewer/executor/analyst or remove existing tools. In particular:

- Planner still has no `apply_patch`, `skill`, or `mcp_tool_call`.
- Reviewer still has no `apply_patch`, `run_command`, or card-inspection tools.
- Executor still has `apply_patch`, `run_command`, `skill`, and `mcp_tool_call`.
- Analyst still has control tools plus the shared provider tools.

## Tests

Add `tests/tools/role-invocation-surfaces.test.ts`.

Assert exact tool-name sets for all four roles. Use real providers with minimal fake dependencies; do not mock the factory internals.

Expected provider-derived tools:

- Planner: `create_card`, `edit_card`, `cancel_card`, `activate_card`, `reorder_child`, `queue_notification`, `list_cards`, `get_card`, `get_tree`, `read`, `write`, `edit`, `glob`, `grep`, `list_card_history`, `get_card_history_entry`, `diff_card`, `websearch`, `webfetch`.
- Reviewer: `read`, `write`, `edit`, `glob`, `grep`, `list_card_history`, `get_card_history_entry`, `diff_card`, `websearch`, `webfetch`, `skill`, `mcp_tool_call`.
- Executor: reviewer tools plus `apply_patch`, `run_command`, `wait_process`, `kill_process`.
- Analyst: Analyst control tools plus `list_cards`, `get_card`, `get_tree`, `read`, `write`, `edit`, `apply_patch`, `glob`, `grep`, `run_command`, `wait_process`, `kill_process`, `list_card_history`, `get_card_history_entry`, `diff_card`, `websearch`, `webfetch`, `skill`, `mcp_tool_call`.

Also update `tests/agents/analyst-tool-surface.test.ts` so its production-shaped Analyst surface uses `buildRoleSurface('analyst', ...)` rather than hand-building the same provider list.

## Validation

- `npm run typecheck`
- `NODE_OPTIONS=--experimental-vm-modules npx jest tests/tools/role-invocation-surfaces.test.ts tests/agents/analyst-tool-surface.test.ts tests/runtime/actors/planning-card-processor-actor.test.ts tests/runtime/actors/terminal-card-processor-actor.test.ts --runInBand --forceExit`
- `npm run validate:routine`
- `npm test`
- `npm run build`
