# Fail-Fast Startup Composition Design

Date: 2026-06-06

## Problem

Saivage v3 startup is over-decomposed into defensive phases that keep the HTTP server alive even when core runtime services fail. This makes failures look like degraded availability instead of startup failures. It also encourages fallback service construction, which already caused a production bug: the Analyst/API path and runtime path observed different `CardStore` instances.

The current shape is roughly:

- `server.ts` creates Fastify, `LiveSyncSocket`, `SyncHub`, and request restart glue.
- `startRuntimeApplication()` optionally creates `RuntimeApplication`, catches failures, and returns `{ startupFailure }` instead of throwing.
- `server.ts` falls back to `new CardStore(projectRoot)` when runtime startup failed or was disabled.
- `registerWebSocket()` falls back to a private `LiveSyncSocket` when one is not provided.
- `startMcpManager()` catches failures and returns `{ startupFailure }` instead of throwing.
- `registerServerRoutes()` accepts provider functions and optional runtime/MCP dependencies.
- `stopServerResources()` accepts optional dependencies and swallows stop failures.
- Availability endpoints expose the resulting partial graph.

This is too defensive for the primary product mode. If the runtime cannot start, the operator should not get a half-working control room with stale or divergent services.

## Goals

- Use one fail-fast startup path for the server product.
- Create one explicit service graph at startup and pass it to components.
- Remove fallback `CardStore`, fallback runtime application, and fallback MCP manager behavior from production startup.
- Make dependency absence impossible by type for runtime-enabled server routes and WebSocket handlers.
- Keep tests free to instantiate small units directly, but avoid production-style optional dependency scaffolding in tests.
- Preserve local development ergonomics: configuration errors should be clear and early.

## Non-Goals

- No compatibility layer for the current optional-runtime server mode.
- No server mode where `/api/cards` remains available when runtime startup fails.
- No file watching or polling to compensate for multiple stores.
- No new dependency injection framework.
- No broad UI redesign.

## Current Issues

### Partial Startup Hides Fatal Problems

`startRuntimeApplication()` and `startMcpManager()` catch errors and return structured startup failures. `server.ts` then registers routes anyway. This creates an HTTP server whose core service graph is incomplete.

That design makes sense for a health-dashboard-only server, but Saivage's operator server is not just a dashboard. Runtime, analyst, cards, events, and sync are one product surface.

### Fallback Services Create Split-Brain State

`server.ts` currently falls back to a standalone `CardStore` if `runtimeApplication` is absent. This repeats the exact category of bug we just fixed: more than one service instance can become authoritative depending on which code path handles the request.

`registerWebSocket()` also constructs a fallback `LiveSyncSocket`. That is the same split-brain shape for live updates: websocket clients may attach to one socket set while runtime/card invalidations publish through another. Runtime-enabled server startup must provide the single socket instance explicitly.

The correct invariant is:

```text
If the server is running in operator mode, there is exactly one runtime service graph.
All cards, analyst tools, runtime dispatch, API routes, websocket sync, and Telegram share it.
```

### Provider Functions Spread Optionality

`registerServerRoutes()` takes `runtimeApplicationProvider` and `mcpManagerProvider`. Those providers mostly exist because startup allows missing dependencies. Once startup is fail-fast, route registration should receive concrete services.

### Shutdown Mirrors Defensive Startup

`stopServerResources()` accepts many optional services and catches individual stop failures. In fail-fast startup, the service graph should own disposal order. Shutdown can still be best-effort for cleanup, but optional dependencies should disappear from the normal path.

## Proposed Architecture

Introduce a single server composition root that returns a concrete `ServerServices` graph.

```ts
export interface ServerServices {
  projectRoot: string;
  config: SaivageConfig;
  fastify: FastifyInstance;
  scope: ResourceScope;

  eventBus: EventBus;
  eventLogger: EventLogger;
  errorLogger: ErrorLogger;
  cardStore: CardStore;
  runtimeApplication: RuntimeApplication;
  mcpManager: McpManager;
  liveSyncSocket: LiveSyncSocket;
  syncHub: SyncHub;
  telegramBot?: TelegramBot;

  requestRestart(): Promise<void>;
  stop(): Promise<void>;
}
```

The normal startup order should be:

1. Load and validate environment/config.
2. Configure auth policy.
3. Create `ResourceScope`.
4. Create shared primitives:
   - `EventBus`
   - `EventLogger`
   - `ErrorLogger`
   - `CardStore(projectRoot, maxDepth, eventBus)`
   - `LiveSyncSocket`
   - `SyncHub(liveSyncSocket)`
5. Create runtime application from those primitives. Runtime-local collaborators such as the skills engine, session stamper, context compactor, candidate availability store, and agent adapter may remain internal to runtime application assembly unless another server component needs to share them.
6. Start runtime application. If this throws, abort startup.
7. Wire `SyncHub` to `runtimeApplication.runtimeApi`.
8. Create and start `McpManager`. If this throws, abort startup.
9. Attach MCP manager to runtime application.
10. Start optional Telegram only if configured. Telegram startup failure should be a policy decision; see below.
11. Create Fastify app.
12. Register routes with concrete services.
13. Register one scope disposer for `ServerServices.stop()`.
14. Listen.

The key difference is that services are created before route registration and are required by route registration.

## Composition Boundary

Replace the current `server.ts` orchestration plus `runtime-lifecycle.ts`, `mcp-lifecycle.ts`, and `server-shutdown.ts` with a smaller composition module, for example:

```text
src/server/composition/server-services.ts
```

This module should export:

```ts
export async function createServerServices(input: {
  environment: Environment;
  scope?: ResourceScope;
  createRuntime?: boolean;
}): Promise<ServerServices>
```

But `createRuntime?: boolean` should be transitional only for tests. The production `startServer()` path should call it with runtime enabled. If tests need no-runtime route registration, they should use route-level harnesses, not production startup.

The target production signature should become:

```ts
export async function createServerServices(input: {
  environment: Environment;
  scope?: ResourceScope;
}): Promise<ServerServices>
```

## Publishing Common Services

Use a small explicit service object, not global singletons.

### Runtime Application

Change `createRuntimeApplication()` from a self-contained constructor to a graph assembler that receives shared primitives:

```ts
export interface RuntimeApplicationServices {
  projectRoot: string;
  config: SaivageConfig;
  eventBus: EventBus;
  eventLogger: EventLogger;
  errorLogger: ErrorLogger;
  cardStore: CardStore;
}

export function createRuntimeApplication(services: RuntimeApplicationServices): RuntimeApplication
```

This removes remaining hidden ownership of shared server primitives from `runtime-composition.ts`. Runtime-private collaborators should stay inside `createRuntimeApplication()` unless they are deliberately promoted to shared server services. Do not lift every internal runtime collaborator into `ServerServices`; that would make the server composition root larger without improving ownership clarity.

### Runtime Core

`RuntimeConfig` should stop accepting optional shared services. Optional injection is still a fallback smell. Make the shared runtime services required for production runtime assembly:

```ts
export interface RuntimeConfig {
  projectRoot: string;
  eventBus: EventBus;
  cardStore: CardStore;
  eventLogger: EventLogger;
  errorLogger: ErrorLogger;
  ...
}
```

Then remove fallback construction and ownership flags from `Runtime` for these services, including `new CardStore(...)`, `new EventLogger(...)`, `new ErrorLogger(...)`, `_ownsEventLogger`, and `_ownsErrorLogger` branches. Tests that need isolated runtime cores should construct a test service graph explicitly.

### Routes

Replace provider-based route registration:

```ts
runtimeApplicationProvider: () => RuntimeApplication | undefined
mcpManagerProvider: () => McpManager | undefined
cardStore: CardStore
```

with concrete service dependencies:

```ts
runtimeApplication: RuntimeApplication
mcpManager: McpManager
cardStore: CardStore
```

Then delete `requireCardStore()` style defensive helpers where they only support the missing-runtime mode.

### WebSocket

`registerWebSocket()` should require `runtimeApplication`, `liveSyncSocket`, and `requestServerRestart`. A WebSocket without a runtime-backed Analyst is not useful and should not be registered. It must not construct its own `LiveSyncSocket` fallback.

### Analyst Tools

`ToolContext.eventBus` should become required, not optional. `recordControlAction()` can still default to a fresh `EventBus` for low-level tests or CLI-only use, but runtime analyst paths should always pass the shared bus.

Preferred target:

```ts
export interface ToolContext {
  projectRoot: string;
  store: CardStore;
  eventBus: EventBus;
  runtime: Pick<RuntimeApi, 'startProject' | 'stopProject' | 'pause' | 'resume'>;
  ...
}
```

## Failure Policy

### Runtime

Runtime startup failure is fatal. Throw and do not bind the HTTP port.

### MCP

MCP startup failure should be fatal in the operator server if configured MCP servers fail to initialize. The operator can disable or fix MCP config explicitly. Silent degraded MCP mode causes analyst/runtime tools to differ from the configured project.

If optional MCP is needed later, model it explicitly as config:

```json
{ "mcp": { "startupPolicy": "required" | "disabled" } }
```

Do not infer optionality from caught exceptions.

### Telegram

Telegram is notification/remote-control integration, not core runtime execution. Two acceptable policies:

- Preferred: fatal only when Telegram is enabled in config and credentials are invalid.
- Simpler first step: keep Telegram optional, but isolate that optionality inside `startTelegramNotifications()` and keep it out of core service availability.

The fail-fast startup cleanup should not wait on Telegram policy. Keep Telegram as the only optional service if needed.

## API Shape After Simplification

`createServer()` should be short and linear:

```ts
export async function createServer(options: CreateServerOptions): Promise<ServerInstance> {
  const services = await createServerServices(options);
  registerServerRoutes({
    fastify: services.fastify,
    projectRoot: services.projectRoot,
    runtimeApplication: services.runtimeApplication,
    cardStore: services.cardStore,
    mcpManager: services.mcpManager,
    liveSyncSocket: services.liveSyncSocket,
    requestServerRestart: services.requestRestart,
    saivageConfig: services.config,
    configWarnings: options.environment.configWarnings,
  });
  return toServerInstance(services);
}
```

No `runtimeStartupFailure`, no `mcpStartupFailure`, no fallback `CardStore`.

## Availability Endpoints

Remove startup-failure availability plumbing from normal server routes.

Current `ServerAvailabilityInputs` is built around optional components and startup-failure objects. Replace it with a required-service health projection:

```ts
export interface ServerAvailabilityInputs {
  projectRoot: string;
  runtimeApplication: RuntimeApplication;
  mcpManager: McpManager;
  readRuntimeHealth?: () => RuntimeHealthSnapshot;
}
```

If startup fails, `/health/ready` is not available because the server never started. That is correct.

Do not reduce availability to object presence alone. A constructed `RuntimeApplication` means startup succeeded, but availability should still project runtime liveness from runtime state or a runtime health callback so a mid-process runtime failure can be reported as degraded or unavailable. Remove only the startup-failure diagnostic plumbing, not useful live health diagnostics.

## Tests To Remove Or Rewrite

Remove tests whose only purpose is verifying degraded startup behavior:

- runtime startup failure continues without runtime
- MCP startup failure continues without MCP
- route handlers tolerate missing card store/runtime application
- WebSocket analyst mode without runtime application
- server availability reports startup failure objects for components that should be required

Rewrite tests to assert fail-fast behavior instead:

- runtime construction failure rejects `createServerServices()`
- MCP start failure rejects `createServerServices()`
- route composition requires concrete services by type
- `createServerServices()` exposes one shared `CardStore` used by runtime, analyst, API, and routes
- shared `EventBus` broadcasts card mutations to `SyncHub`

It is acceptable to delete broad mocks that recreate the old optional service graph. Prefer a small `createTestServerServices()` helper that returns concrete fake services.

## Migration Plan

### Step 1: Introduce `ServerServices`

- Add `src/server/composition/server-services.ts`.
- Move service construction from `server.ts` into it.
- Keep behavior initially equivalent if needed, but centralize ownership.

### Step 2: Make Runtime Services Explicit

- Change `createRuntimeApplication(projectRoot, config)` to `createRuntimeApplication(services)`.
- Move `EventBus`, `EventLogger`, `ErrorLogger`, and `CardStore` construction out of runtime composition.
- Make `RuntimeConfig.eventBus` and `RuntimeConfig.cardStore` required.
- Make `RuntimeConfig.eventLogger` and `RuntimeConfig.errorLogger` required.
- Remove fallback construction and ownership flags from `Runtime` for shared services.

This step has a large type surface in tests. Either land it together with Step 3 in one coherent commit, or update runtime test helpers first so every direct runtime assembly passes explicit shared services.

### Step 3: Remove Runtime Startup Fallback

- Delete `RuntimeStartupResult` and `StartupFailure` from runtime lifecycle.
- Make `startRuntimeApplication()` either return `RuntimeApplication` or throw.
- Inline it into `createServerServices()` if it becomes trivial.

### Step 4: Remove MCP Startup Fallback

- Make `startMcpManager()` return `McpManager` or throw.
- Delete `McpStartupResult` and optional attach logic.
- Attach MCP unconditionally after both runtime and MCP exist.

### Step 5: Simplify Route Composition

- Change `registerServerRoutes()` to accept concrete `runtimeApplication` and `mcpManager`.
- Remove provider functions where not required for dynamic reload.
- Remove `requireCardStore()` defensive branches that only support absent runtime.
- Change `registerWebSocket()` options so `liveSyncSocket`, `runtimeApplication`, and `requestServerRestart` are required.
- Delete the fallback `new LiveSyncSocket()` branch in websocket registration.

### Step 6: Simplify Shutdown

- Replace `stopServerResources({ optional... })` with `services.stop()`.
- Stop order should be deterministic:
  1. dispose websocket/sync hub so clients cannot receive events through a partially stopping graph
  2. stop accepting connections / close Fastify
  3. stop Telegram if started
  4. stop MCP
  5. shutdown runtime
  6. close loggers / dispose candidate availability through runtime application
  7. dispose scope

Shutdown can log cleanup failures, but startup dependencies are no longer optional.

### Step 7: Delete Degraded-Mode Tests

- Remove tests that assert partial startup continues.
- Remove mocks that pass `runtimeApplication: undefined` into route registration.
- Add direct route-unit tests only where a route is intentionally independent from runtime.
- Remove the transitional `createRuntime` parameter from production startup and `createServerServices()` once degraded-mode route tests are gone.

## Expected Touch Points

This will be wide-touching. Likely files:

- `src/server/server.ts`
- `src/server/composition/runtime-lifecycle.ts`
- `src/server/composition/mcp-lifecycle.ts`
- `src/server/composition/route-composition.ts`
- `src/server/composition/server-shutdown.ts`
- `src/server/availability.ts`
- `src/server/routes/operator-contracts.ts`
- `src/server/routes/operator-runtime-card-handlers.ts`
- `src/server/routes/operator-files-debug-handlers.ts`
- `src/server/websocket.ts`
- `src/server/analyst-ws-handler.ts`
- `src/application/runtime-composition.ts`
- `src/runtime/runtime-config.ts`
- `src/runtime/runtime.ts`
- `src/agents/analyst-handler.ts`
- `src/tools/analyst-tool-types.ts`
- server, route, websocket, runtime startup, and availability tests

## Success Criteria

- Production server startup has one obvious linear service graph.
- There is no production fallback `new CardStore(projectRoot)` outside the service graph.
- There is no production fallback `new LiveSyncSocket()` outside the service graph.
- `server.ts` and route composition do not construct fallback `CardStore` instances.
- Runtime startup failure rejects server startup.
- MCP startup failure rejects server startup unless explicitly disabled by config.
- `registerServerRoutes()` receives concrete runtime/MCP/card services, not optional providers.
- The live GetRich v2 deployment starts, `/health` passes, `/api/state` reports runtime availability, and card mutations update Cards view through live sync.

## Preferred Final Shape

The desired mental model is:

```text
createServerServices()
  owns all shared primitives
  owns runtime application
  owns MCP
  owns route dependencies
  owns shutdown order

server.ts
  loads environment
  calls createServerServices()
  registers routes
  listens
```

Anything else should be a test helper or a deliberate separate CLI path, not production startup behavior.
