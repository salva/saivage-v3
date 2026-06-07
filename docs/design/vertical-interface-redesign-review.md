# Vertical Interface Redesign Review

Date: 2026-06-06

Scope: Saivage v3 internal boundaries across runtime, application/read-models, server contracts, tool dispatch, agent adapters, live sync, and the Vue operator client. This is an analysis report only; no implementation code was changed.

Current relevance rechecked against source after parallel source changes on 2026-06-07.

## Executive Summary

Yes, there is meaningful room for improvement through vertical redesigns. The repo has already improved several individual layers, especially lifecycle typing and contract validation, but many seams still preserve older layer-shaped interfaces. The most valuable next changes are not another round of local refactors; they are boundary changes that let adjacent layers speak the same domain language.

The main pattern is that Saivage v3 often has strong native abstractions inside a layer, then crosses into another layer through a thinner, less semantic facade. Examples include a typed card lifecycle being flattened into broad API/card views, rich runtime command/run/activation ledgers being consumed by UI selectors as raw arrays, authorized mutations being assembled from separate authz/audit helpers, and tool definitions being split into multiple adapters plus manually mirrored web presenters.

The highest-impact vertical redesigns are:

1. Introduce a first-class operator application service/read-model boundary that owns `runtime`, `cards`, `agents`, `timeline`, `processes`, and `availability` projections as coherent vertical queries.
2. Collapse the duplicate tool invocation abstractions into one canonical tool contract, with generated or data-driven web presentations derived from the same registry.
3. Move runtime command/control APIs upward into a domain command service, and push low-level pause/resume/file-state details downward so analyst tools and REST/CLI controls do not bypass the same boundary differently.
4. Continue the lifecycle redesign vertically into API responses and UI state, so clients consume `CardLifecycleState` semantics instead of reconstructing status, error, result, freshness, and action state in several places.
5. Add a unified authorized-command boundary for authz, permissions, audit, and mutation execution.

Note: live-sync was initially identified as a possible seam. Treat it as intentionally good as-is for now. This report keeps the observation for context but removes live-sync redesign from the recommended priority path.

## Current Boundary Map

The current architecture documents say the runtime should be the only dispatcher and the AgentAdapter should hand tools back to runtime for authoritative execution ([`docs/agents.md`](agents.md#L47-L48)). The source largely follows this at runtime execution boundaries, but operator-facing and analyst-facing boundaries are less unified.

Current major seams:

- Runtime composition builds `RuntimeApi`, `CardStore`, and analyst deps in one application object (`src/application/runtime-composition.ts`, `src/application/runtime-composition.ts`).
- Server route registration mounts zod-backed operator contracts and handler maps (`src/server/routes/operator-contracts.ts`, `src/server/contract-runtime.ts`).
- Card/runtime read models are request-time services over `CardStore` plus persisted runtime state (`src/application/read-models/cards-read-model.ts`).
- Agent execution crosses through `AgentExecutionPort`, while the concrete `AgentAdapter` also owns model routing, session lifecycle, tool dispatch, skills, MCP, and redaction (`src/contracts/agent-execution.ts`, `src/agents/agent-adapter.ts`).
- Tool invocation is split between `ToolRuntime`, planner-control, MCP, skill, workspace, and analyst adapters (`src/agents/tool-dispatcher.ts`, `src/agents/tool-dispatcher.ts`).
- Web REST client wrappers import shared contract types, but still manually map operation IDs to methods and URL strings (`web/src/api/client.ts`).
- Live sync maps domain events to coarse invalidation resources, then the client refetches REST read models (`src/server/sync-hub.ts`, `web/src/sync/client.ts`).
- Web stores reconstruct presentation read models from API payloads and separate selectors (`web/src/stores/runtime.ts`, `web/src/stores/card-presentation.ts`).

## Finding 1: Operator API Handlers Are Contract-Mounted But Not Application-Oriented

Severity: High. Transversality: server, application read models, runtime, web stores.

The route contract runtime is a good technical boundary: it validates auth, request params, responses, and response contract violations (`src/server/contract-runtime.ts`, `src/server/contract-runtime.ts`). However, the handler layer below it is not a cohesive application API. For example, runtime/card handlers create a new `CardsReadModelService` per operation and pass low-level providers for `CardStore`, runtime application, and availability (`src/server/routes/operator-runtime-card-handlers.ts`).

This preserves impedance mismatch in both directions:

- The server contract layer talks in operation IDs, HTTP params, and bodies.
- The application layer exposes small read-model helpers rather than a domain-oriented operator facade.
- The UI consumes separate `runtime`, `cards`, `agents`, `timeline`, and `processes` snapshots and recombines them locally.

Recommended vertical redesign:

- Prefer a light `OperatorProjectionServices` bundle assembled once in runtime/server composition before introducing a broad application service.
- Let that bundle own composed read-model instances for `cards`, `runtime`, `agents`, `timeline`, `processes`, and `availability`, then pass it into handler builders.
- Add task-shaped methods such as `getDashboardSnapshot`, `getCardBrowser`, `getCardDetail`, `getRuntimeConsole`, `getAgentConversation`, `getTimeline`, or `sendAnalystMessage` only when a route genuinely needs cross-resource orchestration.
- Let route handlers become trivial contract adapters: parse already-typed contract input, call one application method, return its result.
- Move server availability composition, redaction, allowed actions, and runtime/card joins into that service instead of scattering them across route handlers and web stores.

Why this is better than another layer-local refactor: it would let the backend publish native operator projections rather than forcing the web client to adapt raw persisted/runtime structures. It also reduces repeated provider plumbing and the habit of recreating read model services at the HTTP boundary.

## Finding 2: Tool Boundaries Are The Clearest Impedance Mismatch

Severity: High. Transversality: agents, tools, runtime, analyst chat, web tool display.

Saivage has a single `UnifiedToolDefinition` shape, but execution is not actually unified. `UnifiedToolDefinition` includes name, input schema, roles, executor, and category flags (`src/tools/tool-catalog.ts`). Those definitions are then transformed into runtime LLM tool definitions and runtime `defineTool` entries (`src/tools/definitions/index.ts`). The dispatcher then has separate adapters for runtime tools, planner control, MCP, skills, workspace, and analyst tools (`src/agents/tool-dispatcher.ts`).

The problem is that the contexts differ materially:

- Generic runtime tools receive `ToolRuntime` context with `projectRoot`, `cardStore`, role, surface, scope, and bus (`src/tools/runtime.ts`).
- Analyst tools expect `ToolContext` with `store`, runtime controls, MCP manager, restart hook, actor, and control-action surface (`src/tools/analyst-tool-types.ts`).
- `AGENT_TOOL_DEFINITIONS` adapts unified tool executors into runtime tools but passes only a reduced context, omitting runtime/MCP/restart capabilities (`src/tools/definitions/index.ts`).
- `AnalystHandler` separately constructs the richer analyst `ToolContext` and routes through `AnalystAdapter` (`src/agents/analyst-handler.ts`).

This means tool execution semantics depend on the surface-specific dispatcher/context path: runtime agents and analyst chat adapt the same registry concepts differently. The web then mirrors tool names again through a manual presenter registry with side-effect imports (`web/src/utils/tool-presenters/index.ts`, `web/src/utils/tool-presenters/registry.ts`).

Recommended vertical redesign:

- First make the tool boundary capability-driven; introduce a full `ToolInvocationService` only if the capability executor becomes more than a function.
- Give each tool definition an explicit capability requirement, such as `cardStore`, `runtimeControl`, `mcp`, `workspace`, `restartServer`, `contentSupervisor`, rather than relying on adapter category and optional fields.
- Have the composition root supply one capability object per surface: planner, executor, analyst chat, REST/operator, direct tests. Tool execution should fail before dispatch when required capabilities are unavailable.
- Generate LLM tool schemas, role policy metadata, audit metadata, and web display metadata from the same registry.
- Keep specialized web presenter files where useful, but generate or verify the side-effect import registry from `stableToolOrder` so tool and presenter inventories cannot silently drift.

Expected payoff: fewer hidden unsupported paths, less duplicated policy, and much easier addition/removal of tools because execution, authorization, audit, and UI presentation would all depend on one tool contract.

## Finding 3: Live Sync Is A Thin Bridge That Throws Away Domain Semantics

Severity: Medium-High. Transversality: runtime events, server WebSocket, web stores, operator UX.

Disposition: Do not act now. The current live-sync system is intentionally acceptable and should not be redesigned as part of this review.

The current live-sync design maps many rich domain events to coarse resources like `runtime`, `cards`, `agents`, `timeline`, and `processes` (`src/server/sync-hub.ts`). The client registers refetch functions and runs single-flight REST refetches after invalidation (`web/src/sync/client.ts`, `web/src/sync/client.ts`).

This is robust and simple, but it locks the system into a REST-snapshot-first mental model. The runtime already emits typed ledger events such as runtime command, run, activation, actionable error, card history, and analyst tool invocation (`src/schemas/types.ts`). The UI still often only learns “cards changed” or “runtime changed” and then reconstructs what happened by refetching.

Potential vertical redesign if this ever becomes painful:

- Keep coarse invalidation as a fallback, but add typed projection events for high-value operator surfaces.
- Publish domain-specific deltas such as `card.changed`, `runtime.ledger.appended`, `agent.activity.appended`, `process.status.changed`, each with enough identity for the client to update or mark exactly the affected view stale.
- Let the backend operator read-model service own event-to-projection mapping, not the WebSocket hub alone.
- Update stores to consume a `ProjectionEvent` stream that can either apply deltas or request a scoped refetch.

Expected payoff if revisited later: less unnecessary refetching, more precise stale indicators, and fewer duplicated selectors trying to infer runtime state from snapshots.

## Finding 4: Runtime Control Has Both Native Commands And Lower-Level State Helpers

Severity: Medium-High. Transversality: runtime, analyst tools, CLI/server controls, tests.

`RuntimeApi` exposes high-level controls like `startProject`, `stopProject`, `pause`, and `resume` (`src/runtime/runtime-api.ts`). Analyst runtime tools still split their control path: `start_project` and `stop_project` call `ctx.runtime.startProject/stopProject`, while `pause_runtime` and `resume_runtime` call persisted control helpers and `readRuntimeState` directly (`src/tools/analyst-runtime-tools.ts`, `src/runtime/control.ts`). Current source reduces semantic drift because both persisted pause/resume helpers and runtime pause/resume delegate to shared command functions in `src/runtime/runtime-control-commands.ts`, but there is still no single surface-facing runtime command service.

This indicates the native runtime abstraction is not yet the only vertical client boundary. Instead of pushing all expected APIs into one runtime command surface, analyst tools still reach around `RuntimeApi.pause()`/`resume()` into persistence/control helpers.

Recommended vertical redesign:

- First route analyst `pause_runtime` and `resume_runtime` through the existing `RuntimeApi.pause()`/`resume()` methods, since shared pause/resume command functions already exist.
- Add a `RuntimeCommandService` only if command receipts, restart requests, diagnostics, and future REST/CLI control handlers need one surface-facing boundary.
- Keep diagnostic reads such as runtime events, errors, control actions, and process lists as explicit read-model operations rather than forcing them into the command service.
- Return one command receipt type across surfaces with command id, actionability, audit id, runtime/run changes, and operator-safe message.
- Keep low-level file helpers private to runtime/persistence modules except for explicit diagnostic read-model services.

Expected payoff: consistent audit/control receipts and fewer boundary-specific control paths. It would also make operator APIs easier to add because command semantics would no longer be embedded inside tool functions.

## Finding 5: Card Lifecycle Typing Improved, But API/UI Still Consume Broad Card Views

Severity: Medium. Transversality: schemas, card store, API contracts, web stores.

The lifecycle redesign is partially implemented. `CardRecord` now contains a `lifecycle: CardLifecycleState`, and validation enforces top-level `status` matching `lifecycle.status` (`src/schemas/types.ts`, `src/schemas/validators.ts`). The lifecycle union is strong and precise (`src/schemas/lifecycle.ts`). Terminal commit helpers construct lifecycle patches instead of arbitrary terminal overlays (`src/runtime/terminal-commit/commit-executor.ts`, `src/runtime/terminal-commit/lifecycle-patch.ts`).

The vertical follow-through is incomplete. The operator API still returns `CardView` as `CardRecord` plus `display_path` (`src/application/read-models/card-view.ts`, `src/contracts/operator-api-runtime-cards.ts`). `CardsReadModelService` appends `allowedActions` server-side, but lifecycle/detail projections remain broad. The web card store and detail view model then derive detail summary objects, freshness, review, planning, evidence, tree, board columns, filters, and stale state locally (`web/src/stores/cards.ts`, `web/src/stores/card-detail-view-model.ts`, `web/src/stores/card-presentation.ts`).

Recommended vertical redesign:

- Start by porting what `card-detail-view-model.ts` and `card-presentation.ts` already compute into a backend or shared pure projection, then promote only stable fields into the operator contract.
- Introduce operator-specific card projections that expose lifecycle semantics directly, such as `terminalState`, `executionSummary`, `reviewSummary`, `planningSummary`, `operatorActions`, `freshness`, and `evidenceSummary`, only after confirming the field list against current UI usage.
- Keep raw `CardRecord` available only on debug/history endpoints, not as the default operator card payload.
- Move `allowedActions`, lifecycle-derived summaries, stale/error normalization, and display path into backend projections.
- Let the web store hold backend projection state and reserve client selectors for purely local concerns like currently selected tab or search text.

Expected payoff: the UI would stop reverse-engineering domain state from broad records, and future lifecycle changes would require fewer coordinated frontend edits.

## Finding 6: AgentAdapter Is A Composition Hub Masquerading As A Port Adapter

Severity: Medium. Transversality: agent runtime, tools, model routing, runtime composition.

`AgentExecutionPort` is small and appropriate as a runtime dependency (`src/contracts/agent-execution.ts`). Some split components already exist, including `AgentToolExecutor`, `AgentSessionCoordinator`, `AgentSessionLifecycle`, `InvocationService`, and `AgentInvocationRunner`. The concrete `AgentAdapter`, however, still constructs or owns provider registry, model router, candidate availability, notification center, card store, planner control executor, tool runtime, session coordinator, lifecycle, message log, model context, tool executor, invocation service, and invocation runner (`src/agents/agent-adapter.ts`). It also has post-construction setters for event bus, runtime ledger event bus, content supervisor, MCP manager, and skills engine (`src/agents/agent-adapter.ts`).

This is not necessarily wrong, and the extraction of helper classes means the issue is less about one oversized file than about composition ownership. Multiple vertical boundaries still terminate at `AgentAdapter`: it is simultaneously a runtime port implementation, an agent subsystem composition root, a tool integration host, and a late-bound bridge to MCP/skills/runtime events.

Recommended vertical redesign:

- Split the concept, not necessarily the file immediately: `AgentInvocationGateway` for `AgentExecutionPort`, `AgentToolHost` for tool/MCP/skill capabilities, and `AgentSessionRepository` for session lifecycle/message operations.
- Prefer constructor-supplied capability bundles over setters. If late binding is required, represent it as a mutable capability provider object owned by application composition.
- Let runtime composition depend only on `AgentExecutionPort`; let analyst/server composition depend on a separate `AnalystGateway` or `ToolInvocationService`.

Expected payoff: fewer cycles in composition, easier tests for each boundary, and less risk that a future feature reaches into `AgentAdapter` because “everything is already there.”

## Finding 7: API Contracts Are Shared, But Client Wrappers Still Duplicate Route Inventory

Severity: Medium. Transversality: contracts, server, web API client, tests.

The contract package exports `operatorApiContracts`, `OperatorApiOperationId`, and typed response parsing (`src/contracts/operator-api.ts`). The web client imports those types and parses successful responses by operation ID (`web/src/api/contracts.ts`, `web/src/api/client.ts`). However, each wrapper still hard-codes method and path strings, including path parameter interpolation (`web/src/api/client.ts`, `web/src/api/client.ts`).

Recommended vertical redesign:

- Generate or implement a contract-driven client from `operatorApiContracts` that builds URLs from contract path templates and typed params/query/body.
- The first step should be small: make `operatorRequest` derive the HTTP method from `operatorApiContracts[operationId]` and interpolate path templates from typed params.
- Keep named convenience functions if desired, but make them call `operatorRequest('cards.get', { params: { id } })`, not duplicate `GET /api/cards/${id}`.
- Use the same route inventory for contract tests, docs, client wrappers, and server mounting.

Expected payoff: fewer contract drift points and less need for client-contract tests that mostly detect manual duplication mistakes.

## Finding 8: Read Models Are Split Between Backend And Frontend Without A Clear Ownership Rule

Severity: Medium. Transversality: application read models, web stores/composables.

There are backend read models such as `CardsReadModelService` and `buildRuntimeStatusReadModel`, and frontend read models/selectors such as `runtime-read-model`, `card-presentation`, and composables (`src/application/read-models/cards-read-model.ts`, `web/src/stores/runtime-read-model.ts`, `web/src/composables/useCardBrowserReadModel.ts`). Some frontend selectors are genuinely presentation-local, but others encode domain decisions, such as current agent session by runtime phase, runtime stale/detail messaging, card ordering, and availability explanations.

Recommended vertical redesign:

- Define ownership: backend owns domain projections and operator-safe interpretations; frontend owns layout state, selection state, transient filters, and formatting.
- Move only domain selectors that are independent of browser connection state into backend or shared pure modules consumed by both backend and frontend.
- Keep browser-state selectors such as live-update state, staleness, and local detail text in the web layer, but share schema-derived constants such as `CardStatus` and `CardType` values instead of hardcoding arrays in composables.
- Keep web selectors small and UI-native.

Expected payoff: clearer changes when runtime semantics evolve, less duplicated test coverage, and fewer mismatches between CLI/API/web interpretation.

## Finding 9: Authz, Card Permissions, Audit, And Mutations Are Not One Command Boundary

Severity: High. Transversality: analyst tools, REST/operator actions, card permissions, audit log, runtime controls.

Mutating analyst tools call `runAuditedAnalystTool`, which evaluates actor/surface/safety authz, records control-action audit entries, and then runs a supplied mutation callback (`src/agents/analyst-tool-runner.ts`). Card action permissions live separately in a role/action/state matrix (`src/permissions/card-permissions.ts`). The audit writer separately sanitizes and emits audit events (`src/persistence/control-action-audit.ts`). Current operator card routes are read/status/history/diff/card-run surfaces, not card mutation routes; the active mismatch is therefore in analyst tools, planner tools, CLI/runtime control paths, and any future REST mutation surfaces.

This creates a vertical mismatch: the product concept is “an actor requests a command against a target and the system either denies, previews, applies, and audits it,” but the code exposes several smaller utilities. That makes it easy for new mutating surfaces to forget one part of the contract or to encode subtly different denial/error/audit behavior.

Recommended vertical redesign:

- Extend the existing `MutatingSpec` first, rather than introducing a new gateway immediately.
- Model command metadata once: action, target kind/id, actor, surface, safety class, optional permission requirement, preview builder, mutation function, audit summary.
- Add a small mapping from `NoteAuthor`/`ActorRole` to `PermissionRole` for card mutations, and let `runAuditedAnalystTool` evaluate authz, optional permission checks, mutation, and audit in one place.
- Make analyst tools, planner tools, REST mutation handlers when added, and CLI commands call this gateway instead of directly composing `evaluateAuthz`, `allowedActions`, `recordControlAction`, and domain mutation helpers.
- Return a typed command receipt with `outcome`, `auditEntry`, `target`, `message`, optional `preview`, and optional domain payload.

Expected payoff: consistent denial and audit semantics across all control surfaces, less duplicated command boilerplate, and a clearer place to add preview/confirmation behavior if needed.

## Finding 10: Process Execution And Process Projection Cross Too Many Layers

Severity: Medium-High. Transversality: runtime process runner, workspace tools, operator process API, debug UI.

The process runner is a substantial runtime subsystem. It owns durable process records, child processes, output streams, lifecycle scope, terminal sinks, cleanup, reconcile, wait, kill, and output tailing (`src/runtime/process-runner.ts`). The operator read model then imports low-level runtime process API functions and maps raw `ProcessRecord` into redacted process views (`src/application/read-models/process-read-model.ts`, `src/application/read-models/process-read-model.ts`). `src/runtime/process-api.ts` is only a re-export facade today, not a semantic process gateway. Workspace tools expose process-related commands as generic workspace tools by name (`src/tools/workspace-tools.ts`).

The mismatch is that process management is simultaneously a runtime capability, workspace tool capability, and operator debug projection. Each layer adapts raw process records instead of talking through one process domain API.

Recommended vertical redesign:

- Expand `src/runtime/process-api.ts` from a re-export facade into the semantic process API before adding another gateway class.
- Give that API command methods (`start`, `startAndWait`, `wait`, `terminate`, `tail`, `reconcile`) and projection methods (`listForOperator`, `getForOperator`, `listForAgent`).
- Let the gateway own redaction, contained log paths, termination availability, and durable/live attachment status.
- Have workspace tools and operator routes use this gateway rather than different adapters around `ProcessRunnerService` and `ProcessReadModelService`.
- Keep `ProcessRunnerService` as the low-level runtime implementation behind the gateway.

Expected payoff: fewer raw `ProcessRecord` leaks, one place for process safety/visibility rules, and cleaner future support for operator termination or richer process logs.

## Finding 11: Agent Session Persistence Is Read Differently By Operator, Chat, And Analyst Tools

Severity: Medium-High. Transversality: session persistence, operator agent API, chat API, analyst inspection tools.

Session files and message logs are persisted under `.saivage/agents`. The canonical persistence module handles session creation, status changes, message appends, active-session reconciliation, and schema validation (`src/runtime/session-persistence.ts`, `src/runtime/session-persistence.ts`). The operator agent read model separately reads manifests and message JSONL, parses role from session IDs, filters non-canonical analyst sessions, and derives listed status from runtime state (`src/application/read-models/agent-operator-read-model.ts`, `src/application/read-models/agent-operator-read-model.ts`). The chat read model separately reads the canonical analyst JSONL with a looser parse path (`src/application/read-models/chat-read-model.ts`). Analyst tools also read session manifests and message logs directly for `list_agent_sessions` and `read_agent_session` (`src/tools/analyst-misc-tools.ts`).

This is a vertical mismatch because “agent transcript/session” is a domain concept, but each surface reconstructs it from files with its own safety, filtering, and normalization behavior.

Recommended vertical redesign:

- Introduce an `AgentSessionRepository` for raw session/message persistence and an `AgentTranscriptReadModel` for operator-safe projections.
- Include an explicit `ensureAnalystSession()` operation so chat can preserve its current create-if-missing behavior without open-coded file access.
- Make chat read models, operator agent routes, and analyst inspection tools use the same read model.
- Move role derivation, safe ID checks, canonical analyst filtering, activity-status joining, and message parse/recovery policy into that shared boundary.
- Keep runtime session persistence focused on writes and lifecycle invariants.

Expected payoff: consistent transcript visibility across chat, agents, and analyst tools; fewer file-format assumptions outside the repository; safer future changes to session IDs or compaction storage.

## Finding 12: Configuration Mutation, Provider Routing, And Runtime Reload Are Split

Severity: Medium. Transversality: config writer, provider/model routing, MCP lifecycle, operator config API, analyst reconfigure tool.

Provider routing and capabilities are modeled in `ProviderRegistry`, `ModelRouter`, and `LlmProviderGateway` (`src/agents/provider.ts`, `src/agents/model-router.ts`, `src/agents/llm-provider-gateway.ts`). Analyst reconfiguration mutates raw config JSON through `analyst-config-writer`, then manually triggers MCP reload/restart for MCP-related actions (`src/agents/analyst-config-writer.ts`, `src/tools/analyst-misc-tools.ts`). The operator providers endpoint builds a separate provider summary with `status: 'unknown'` from static config only (`src/server/routes/operator-config-handlers.ts`).

The mismatch is that config is treated as a file to patch in one layer, a routing graph in another layer, a runtime reload trigger in another layer, and an operator read model in another layer.

Recommended vertical redesign:

- First make `providers.list` consult runtime routing/candidate availability instead of returning `status: 'unknown'`.
- Then add a `ConfigurationService` only if config mutation side effects keep expanding; otherwise keep `analyst-config-writer` as the file mutation boundary and add an explicit post-mutation reload callback/receipt for MCP and other subsystems.
- Add a `ProviderRoutingReadModel` that derives provider/account/model/capability/availability summaries from the same registry and candidate availability used by runtime routing.
- Make `reconfigure`, operator config routes, and runtime reload paths call this service/read model rather than patching config and manually refreshing individual subsystems.
- Return typed config mutation receipts with `requiresRestart`, `reloadedSubsystems`, and redacted operator summary.

Expected payoff: safer reconfiguration, more useful provider diagnostics, and less divergence between what routing will actually do and what the operator UI reports.

## Finding 13: MCP Has A Useful Facade But Its Capability Projection Is Not Shared Across Consumers

Severity: Medium. Transversality: MCP manager, agent tool dispatch, operator MCP API, tool policy.

`McpManager` is already a clear facade for server lifecycle, tool discovery, invocation, status, and tool read models (`src/mcp/mcp-manager.ts`, `src/mcp/mcp-manager.ts`). It also already has an operator-facing tools projection via `buildMcpToolsReadModel`, which includes tools, servers, server details, input schemas, and invocation stats (`src/mcp/status-projection.ts`). The operator API exposes status and tools through separate provider interfaces (`src/server/routes/operator-mcp-handlers.ts`). Agent tool dispatch calls MCP through `McpAdapter`, deriving policy input by querying server/tool definitions directly (`src/agents/tool-dispatcher.ts`). The MCP tool wrapper is still represented as one generic `mcp_tool_call` in the unified tool list (`src/tools/mcp-skill-tools.ts`).

The mismatch is smaller than in the main tool system, and the original concern should not be read as "no MCP projection exists." The real issue is that the existing projection is operator-facing only; role policy and agent invocation still shape MCP capabilities differently and do not consume one shared capability catalog.

Recommended vertical redesign:

- Keep `McpManager`, and evolve the existing tools read model into a stable capability projection before adding a new catalog class.
- Use that projection for operator MCP routes, `McpAdapter.policyInput()`, `mcp_tool_call` validation, and LLM tool descriptions if the project later wants per-MCP-tool dynamic tool exposure.
- Avoid redesigning MCP lifecycle itself; the manager facade is already adequate.

Expected payoff: clearer MCP policy/display behavior without replacing the current manager or operator read model, plus easier future movement from one generic wrapper tool to native MCP tool exposure.

## Finding 14: Runtime Ledger Writes Have A Mutation Port, But Some Services Still Plan Semantic Updates Outside It

Severity: Medium. Transversality: runtime state, run ledger, activation ledger, persistence invariants.

Runtime mutations are centralized behind `RuntimeStateMutationPort` and `applyRuntimeMutation`, which is a good seam (`src/runtime/mutations.ts`, `src/runtime/mutations.ts`). Current state update helpers such as `updateRuntimeRun`, `upsertRuntimeIntent`, and `upsertRuntimeActivation` use locked deriving updates in `src/runtime/state.ts`. However, some higher-level ledger helpers still read runtime state directly, plan an update outside the reducer, then apply a mutation, such as `RuntimeRunLedger` reading state before binding/finishing planner runs (`src/runtime/runtime-run-ledger.ts`). Similar read-plan-mutate patterns also exist in some runtime project-command and startup/dispatcher paths.

This may be acceptable today, but the vertical API is incomplete: a caller wants to “finish open planner run” or “bind planner session to open run,” while the service computes that semantic update from a state snapshot before entering the locked mutation reducer.

Recommended vertical redesign:

- Move semantic ledger operations into mutation kinds or into locked mutation reducers.
- Let `RuntimeRunLedger` call `mutations.apply({ kind: 'finishOpenPlannerRun', ... })` rather than reading state outside the mutation boundary.
- Keep pure planning functions, but execute them inside the locked state update so read/write consistency is guaranteed by construction.

Expected payoff: stronger runtime ledger consistency and fewer opportunities for stale reads if runtime mutation concurrency grows.

## Implementation Sequence

Prefer the smallest boundary changes that make the existing code speak the right domain language. Avoid adding broad service classes before the narrower capability/read-model/contract seams are exhausted.

1. Tool capability unification. Replace adapter/category context assumptions with explicit capability requirements, then generate or verify web presenter imports from the same inventory.
2. Operator projection composition. Compose read-model services once at route registration and pass a projection bundle into handlers before inventing a broad `OperatorApplicationService`.
3. Authorized mutation spec. Extend `MutatingSpec` with optional permission checks and role mapping before introducing a new command gateway.
4. Contract-driven web request helper. Derive method and path interpolation from `operatorApiContracts`; this is independent, cheap, and removes route duplication quickly.
5. Agent session repository/read model. Centralize validated reads and preserve chat's create-if-missing behavior through an explicit repository method.
6. Provider routing read model. Fix `providers.list` to use runtime routing/availability data before building a full configuration service.
7. Runtime command consistency. Route analyst pause/resume through `RuntimeApi` first; add a command service only if future REST/CLI control receipt needs justify it.
8. Process semantic API. Expand `process-api.ts` into a real process API before adding a separate gateway class.
9. Lifecycle projection follow-through. Build projections from existing web selector usage, then stabilize the operator contract.
10. MCP capability projection sharing. Reuse and harden the existing MCP tools read model for policy and agent consumers.
11. Runtime ledger semantic mutations. Move semantic planning into mutation reducers when concurrency risk or runtime churn justifies it.
12. AgentAdapter split. Continue opportunistically while unifying tool/agent capabilities; avoid standalone class proliferation.

## Current Relevance Assessment

Each finding was revalidated against the current source code after parallel source changes. This section records current relevance, factual corrections, and any overstated claims.

### Finding 1: Confirmed

`CardsReadModelService` is instantiated per handler invocation (`new CardsReadModelService(...)`) rather than composed once. The class is stateless and lightweight, so this is not a performance problem, but it confirms the absence of a composed application service layer. Handler context interfaces expose infrastructure providers (`CardStore`, `RuntimeApplication`, `ServerAvailability`) rather than use-case-oriented methods. The contract runtime provides valuable plumbing (auth, validation, envelope), but the handler layer below it lacks domain-oriented composition.

### Finding 2: Still relevant, with nuance

Three distinct `ToolContext` types exist: `runtime.ts` (narrowest), `analyst-tool-types.ts` (richer, with runtime controls, MCP, restart), and `tool-dispatcher.ts` (`ToolDispatchContext`, widest union). A bridging layer in `definitions/index.ts` still maps between `runtime.ToolContext` and `analyst-tool-types.ToolContext`. `AnalystAdapter.handles()` returns `true` unconditionally, making it a catch-all that must be last in the adapter order. `WorkspaceAdapter.handles()` hardcodes tool names as a string comparison chain. The 47-import presenter registry is manually maintained and could be auto-generated from `stableToolOrder`. The mismatches are evolutionary layering rather than a single design mistake, but the impact is real: new tools require coordinated changes across multiple registries and adapter categories.

### Finding 3: Confirmed as intentionally deferred

No change needed; live-sync is documented as acceptable.

### Finding 4: Changed, still partially relevant

`RuntimeApi` does expose `pause()` and `resume()` methods, but analyst tools call persisted control helpers directly instead. The source has improved since the original review: runtime pause/resume and persisted pause/resume now share command functions in `src/runtime/runtime-control-commands.ts`, so the concern is no longer wholly separate pause/resume semantics. The remaining issue is boundary consistency: start/stop go through `RuntimeApi`, pause/resume go through persisted helpers, and diagnostics/read-only operations (`listProcesses`, `readRuntimeState`, `readJsonlTail`, `listControlActions`) still live outside a single runtime command/read boundary.

### Finding 5: Still relevant

`CardLifecycleState` is a well-structured 10-variant discriminated union with status-specific type narrowing. `CardView` is exactly `CardRecord + display_path` with no lifecycle projection. `CardsReadModelService` appends `allowedActions` server-side, but lifecycle/detail projections are still mostly reconstructed in web stores and `card-detail-view-model.ts`. Detail-level decomposition exists, but list and board views remain broad.

### Finding 6: Changed, still relevant

`AgentExecutionPort` has 8 methods focused on agent invocation and handoff/session control, one of which (`reinvokeSession`) is optional. Some split components already exist (`AgentToolExecutor`, `AgentSessionCoordinator`, `AgentSessionLifecycle`, `InvocationService`, `AgentInvocationRunner`), so the original “masquerading as a port adapter” label should not imply all logic lives in one class. `AgentAdapter` still acts as the composition root and late-bound capability bridge: it constructs/owns many subsystems and uses setters (`setEventBus`, `setContentSupervisor`, `setMcpManager`, etc.) for two-phase initialization.

### Finding 7: Confirmed, with nuance

Method duplication (`GET`, `POST`) in the client is especially unnecessary since methods could trivially be derived from the contract. Path template interpolation is a real engineering gap that explains some duplication, but does not explain method duplication. Three endpoints (`getHealth`, `getDoctor`, `getDebugSupervision`) bypass contract response parsing entirely. The contract system already exposes `operatorRouteInventory()` which contains the full route table, but the client never calls it.

### Finding 8: Partially confirmed (original claim overstated)

The wire-format schema for runtime state **does** exist in the backend (`RuntimeGetStateResponseSchema` in `operator-api-runtime-cards.ts`), so the implied claim that "there is no backend contract for raw state" is incorrect. The real concern is about domain **projection logic**: which run counts as "current" (priority rule: active root run > last root run), status label mapping (`frozen`/`paused`/raw status), "last actionable error" priority, the 6-state live-update state machine, and availability detail strings — all of which are frontend-only and lack backend test coverage. Additionally, `useCardBrowserReadModel` hardcodes `statuses` and `cardTypes` arrays that duplicate schema-defined enums, creating drift risk.

### Finding 9: Changed, still relevant

Two separate authorization/permission systems use **different role taxonomies**: `authz.ts` uses `NoteAuthor`/`ActorRole` (includes `user`, `runtime`) and `card-permissions.ts` uses `PermissionRole` (includes `operator`). Audit entries also store `actor: NoteAuthor`, so audit follows the authz taxonomy rather than defining a third actor type. There is no mapping layer between the `NoteAuthor` and `PermissionRole` taxonomies. `runAuditedAnalystTool` composes authz + audit, while card permission checks are composed manually inside individual analyst/planner tool callbacks where needed. Current operator card routes are not card mutation surfaces, so the REST-handler part of the original risk should be framed as future REST mutation surfaces rather than an existing REST card mutation gap.

### Finding 10: Still relevant, with clarification

`ProcessRunnerService` is a large stateful subsystem holding 11+ state maps/sets and delegating behavior to module-scoped functions. `ProcessReadModelService` imports from `process-api.ts`, but `process-api.ts` is currently only a re-export facade, not a semantic process gateway. The operator projection explicitly hardcodes `termination_available: false` with the note "not available in this redesign cycle," acknowledging deliberately withheld capability. Workspace tools expose process operations at the tool-catalog level as a third, independent surface.

### Finding 11: Still relevant

Four distinct pathways diverge significantly: canonical persistence validates through Zod schemas; the operator read model does a union scan of messages and sessions directories (not just sessions), validates message JSONL, derives role from session ID prefix heuristics rather than manifest data, and joins runtime activity state; the chat read model uses `getOrCreateAnalystSession()` which creates a session as a side effect of listing and reads JSONL with loose parsing; analyst tools use raw manifest parsing and tail-based message reads. The divergence covers session discovery, validation, role resolution, message reading strategy, and side effects — not just projection differences.

### Finding 12: Still relevant, strengthened

`providers.list` hardcodes `status: 'unknown'` rather than consulting `MemoryCandidateAvailability` or `ModelRouter`. Config writes via `analyst-config-writer.ts` and MCP reloads via `mcpManager` are in separate modules with no transactional guarantee: a config write can succeed while the subsequent reload fails, leaving the system in split-brain. The operator config handler reads from the in-memory config object, which may become stale after a file write until server restart or manual reload.

### Finding 13: Partially confirmed (original claim slightly overstated)

`buildMcpToolsReadModel` in `status-projection.ts` is a reasonable unified read model for the operator API, so the claim that MCP "does not have a unified capability projection" is too broad. However, the projection is only consumed by the operator API. Agent tools still expose a raw `mcp_tool_call` wrapper whose input uses `z.record(z.unknown())` for tool args, while `McpAdapter.policyInput()` separately queries the manager for annotations. The real gap is that capability information (schemas, constraints, availability) does not reach all operator, agent, and policy consumers through one shared catalog, even though much of it already exists in the manager/read model.

### Finding 14: Changed, still relevant

The pattern is more precisely "read-plan-mutate" than "read-plan-write": the ledger does apply mutations through the port, but the planning phase reads state outside the semantic reducer, so the mutation input may be stale. The earlier claim that `updateRuntimeRun`, `upsertRuntimeIntent`, and `upsertRuntimeActivation` do not use locked deriving updates is no longer correct; current `src/runtime/state.ts` uses `updateRuntimeStateLockedDeriving` for those helpers. The remaining issue is that callers such as `RuntimeRunLedger` and some runtime project-command/startup/dispatcher paths compute semantic update plans from snapshots before entering locked mutation helpers.

## Approach Corrections

The opportunities are real, but several original recommendations were heavier than needed. In particular, prefer capability objects, read-model bundles, existing API methods, and contract-derived helpers before introducing broad `*Gateway` or `*Service` classes. New named services are appropriate only when the smaller seam starts coordinating multiple independent capabilities or receipts.

## Non-Recommendations

- Do not add more thin facades that simply rename existing helpers. The current issue is not lack of named layers; it is that boundaries do not carry enough domain semantics.
- Do not make the frontend smarter to compensate for backend rawness. That would deepen the current mismatch.
- Do not generate every UI component from contracts. Generate or derive the stable parts: route clients, tool metadata, simple presenter defaults, and projection event schemas.
- Do not merge runtime, cards, agents, and tools into a monolith. The better direction is vertical application services with explicit capability ports beneath them.
- Do not redesign live-sync as part of this work. It is currently good enough and should remain stable unless concrete product pain appears later.

## Bottom Line

Saivage v3 would benefit from vertical redesigns. The strongest candidates are the tool invocation boundary, the operator application/read-model boundary, and the authorized-command boundary. These would reduce impedance mismatch more than another isolated refactor of server routes, web stores, or runtime classes. The goal should be to make each cross-layer API carry the native domain concept at that seam: tool invocation, operator projection, runtime command, lifecycle projection, process control, session transcript, or configuration change.
