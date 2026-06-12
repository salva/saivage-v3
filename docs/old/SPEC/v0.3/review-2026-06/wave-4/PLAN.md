# Wave 4: Path Unification — Implementation Plan

**Goal:** Make each domain have exactly one owner. Delete parallel paths rather than bridge them.

**Issues:** F02, F10, F20, F23, F35

**Ordering principle:** Dependencies first. Diagnostic publishing (F35) has zero inbound dependencies. Compaction (F23) depends on nothing from other waves. Pause/resume (F20) is self-contained. Tool dispatch (F10) should come before LLM invocation (F02) because the unified dispatcher becomes a dependency of the shared invocation service.

Sub-wave order: **F35 → F23 → F20 → F10 → F02**.

Forward compatibility has zero weight. We delete parallel paths rather than bridge them.

---

## Sub-wave 4A: Diagnostic Publishing Unification (F35)

### Current State

Two call-site patterns for diagnostics:
1. `deps.emitRuntimeDiagnostic(input)` — emits to the event bus via `RuntimeEventPublisher.emit`
2. `deps.eventLogger.appendEvent({ kind: 'runtime_diagnostic', ... })` — appends to the durable event log

Every dispatcher that needs diagnostics calls **both** separately, with slightly different shapes (`emitRuntimeDiagnostic` passes the raw `error: unknown`; `appendEvent` passes `error_message: string` and optionally `error_name`). Three phase-level effects interfaces (`PlannerInvocationFailureEffects`, `ExecutorInvocationFailureEffects`, `ReviewerInvocationFailureEffects`) define both `emitRuntimeDiagnostic` and `appendRuntimeDiagnostic` as separate methods, forcing every call site to remember both.

**Call sites that currently require both channels:**
- `runtime-planner-dispatcher.ts:68-75` and `:100-107`
- `executor-activation-dispatcher.ts:80-88` and `:125-127`
- `runtime-reviewer-dispatcher.ts:95-104`
- `phases/planner-invocation-failure.ts:70-72`
- `phases/executor-invocation-failure.ts:24-25`
- `phases/reviewer-invocation-failure.ts:22-23`

**Additional standalone `appendEvent({ kind: 'runtime_diagnostic' })` calls:**
- `analyst-handler.ts:228` (logBoundaryDiagnostic)
- `startup-run-reconciliation.ts:41`
- `persisted-planner-history.ts:83`
- `runtime-project-commands.ts:100,158,167`
- `runtime-planner-dispatcher.ts:171-173` (replan diagnostic)

### Design

#### New unified API

```typescript
// src/runtime/runtime-event-publisher.ts (modify existing)

export interface DiagnosticInput {
  goal_id?: string;
  card_id?: string;
  phase?: string;
  error: unknown;
}

publishRuntimeDiagnostic(input: DiagnosticInput): void;
buildRuntimeDiagnosticEvent(input: DiagnosticInput): RuntimeEvent;
```

`publishRuntimeDiagnostic` owns both channels:
1. Emits on the event bus via `this.emit('runtime_diagnostic', { ... })` first
2. Best-effort appends to the durable event log via `this.eventLogger.appendEvent({ kind: 'runtime_diagnostic', goal_id, card_id, phase, error_message, error_name })`. This append must not re-emit through `emitLoggedEvent`; the event bus already received the diagnostic in step 1. Errors during durable-log append are caught and logged, not propagated.
3. Derives `error_message` and `error_name` from the `error` field internally (same logic currently in `emitRuntimeDiagnostic`)

`buildRuntimeDiagnosticEvent(input)` constructs a `RuntimeEvent` for direct `EventLogger`-only use by early-startup modules that do not have a `RuntimeEventPublisher` yet. This avoids forcing publisher wiring into early-start modules.

#### Effects interfaces simplified

Every phase-level effects interface that currently has both `emitRuntimeDiagnostic` and `appendRuntimeDiagnostic` collapses to just:

```typescript
export interface PlannerInvocationFailureEffects {
  publishRuntimeDiagnostic(input: DiagnosticInput): void;
  // appendError remains separate — it appends to the error log, not the event log
  // ...other effects unchanged
}
```

Same for `ExecutorInvocationFailureEffects` and `ReviewerInvocationFailureEffects`.

#### Call sites simplified

Before:
```typescript
this.deps.emitRuntimeDiagnostic({ goal_id: goalId, phase: 'activate', error: err });
this.deps.eventLogger.appendEvent({ kind: 'runtime_diagnostic', goal_id: goalId, phase: 'activate', error_message: errorMessage });
```

After:
```typescript
this.deps.publishRuntimeDiagnostic({ goal_id: goalId, phase: 'activate', error: err });
```

#### What gets deleted

- The `emitRuntimeDiagnostic` method on `RuntimeEventPublisher` — removed, not deprecated
- The `emitRuntimeDiagnostic` field on `RuntimeServices` — removed
- The `appendRuntimeDiagnostic` method from every phase effects interface — removed
- The `emitRuntimeDiagnostic` field from every dispatcher deps type that currently lists it separately — removed
- The separate `emitRuntimeDiagnostic` line at every dual call site — removed

#### What survives as canonical

- `publishRuntimeDiagnostic` on `RuntimeEventPublisher` — the single entry point
- `RuntimeServices.publishRuntimeDiagnostic` replaces `RuntimeServices.emitRuntimeDiagnostic`
- Phase effects interfaces have a single `publishRuntimeDiagnostic` method
- `runtime-project-commands.ts` gains `publishRuntimeDiagnostic` in its deps `Pick`; its direct `eventLogger.appendEvent({ kind: 'runtime_diagnostic' })` calls move to `publishRuntimeDiagnostic`
- Standalone `appendEvent({ kind: 'runtime_diagnostic' })` call sites (analyst handler, startup reconciliation, etc.) migrate to `publishRuntimeDiagnostic` where they have access to a publisher, or use `buildRuntimeDiagnosticEvent` + direct `eventLogger.appendEvent` for early-startup modules that lack publisher access

#### Key decisions

- **No backward compatibility.** Remove `emitRuntimeDiagnostic` from `RuntimeEventPublisher`, `RuntimeServices`, and all call sites in one commit. No `@deprecated` interim.
- **Error extraction is internal.** `publishRuntimeDiagnostic` extracts `error_message` and `error_name` from the `error` field. Callers never pass `error_message` separately.
- **Emit-first, best-effort durable append.** `publishRuntimeDiagnostic` emits on the event bus first, then best-effort appends to the durable log. If durable-log append fails, the error is caught and logged, not propagated.
- **Startup helpers use `buildRuntimeDiagnosticEvent`.** Early-startup modules that lack a `RuntimeEventPublisher` use `buildRuntimeDiagnosticEvent(input)` to construct the event object and call `eventLogger.appendEvent` directly. This avoids forcing publisher wiring into early-start modules.
- **Durable log path.** Diagnostic events are appended to `.saivage/runtime/events.jsonl`.
- **Standalone call sites** (analyst-handler, startup-reconciliation, persisted-planner-history) that call `eventLogger.appendEvent` directly will migrate. Where a publisher is available, they use it. Where it isn't (early startup), they call `buildRuntimeDiagnosticEvent(input)` and append via `eventLogger.appendEvent` directly.

### Implementation Steps

**Step 4A-1:** Add `publishRuntimeDiagnostic` and `buildRuntimeDiagnosticEvent` to `RuntimeEventPublisher`. `publishRuntimeDiagnostic` calls both `this.emit` and `this.eventLogger.appendEvent` (with best-effort error swallowing on the durable append, and no second bus emission from the append). `buildRuntimeDiagnosticEvent` constructs a `RuntimeEvent` for direct `EventLogger`-only use. Remove `emitRuntimeDiagnostic` from `RuntimeEventPublisher` and `RuntimeServices`. Update `RuntimeServices` interface to replace `emitRuntimeDiagnostic` with `publishRuntimeDiagnostic`. Migrate all dual call sites in dispatchers and phases to use `publishRuntimeDiagnostic`. Update `PlannerInvocationFailureEffects`, `ExecutorInvocationFailureEffects`, `ReviewerInvocationFailureEffects` to use single `publishRuntimeDiagnostic` instead of both `emitRuntimeDiagnostic` and `appendRuntimeDiagnostic`. Migrate `runtime-planner-dispatcher.ts`, including its replan diagnostic, `executor-activation-dispatcher.ts`, and `runtime-reviewer-dispatcher.ts`. Add `publishRuntimeDiagnostic` to `RuntimeProjectCommandRunner` deps `Pick` in `runtime-project-commands.ts` and migrate its direct `eventLogger.appendEvent({ kind: 'runtime_diagnostic' })` calls to `publishRuntimeDiagnostic`. Migrate `phases/planner-failure-handler.ts` to provide `publishRuntimeDiagnostic` and remove `emitRuntimeDiagnostic`/`appendRuntimeDiagnostic` from its deps. All callers compile in one commit.

**Step 4A-2:** Migrate standalone call sites: `analyst-handler.ts` logBoundaryDiagnostic, `startup-run-reconciliation.ts`, `persisted-planner-history.ts`. Where the call site has a `RuntimeEventPublisher`, use `publishRuntimeDiagnostic`. Where it doesn't (early startup), use `buildRuntimeDiagnosticEvent(input)` to construct the event and call `eventLogger.appendEvent` directly. Delete all remaining `appendRuntimeDiagnostic` references. Clean up.

### Validation

```bash
npm run validate:routine
npm test
```

**Manual checks:**
- Trigger a planner invocation that produces an error — verify single diagnostic event appears in both event bus and durable log (`.saivage/runtime/events.jsonl`).
- Trigger an executor failure — verify the error is recorded once, not twice.
- Check `events.jsonl` for no duplicate `runtime_diagnostic` entries with identical timestamps.

---

## Sub-wave 4B: Context Compaction Unification (F23)

### Current State

Three compaction paths:
1. **`compaction.ts:compactSession`** — session-level compaction with in-memory state tracking, token budget, threshold, summarization fallback, and `replaceSessionMessages`. Global module-level `compactionStates` Map. Called by `analyst-handler.ts`.
2. **`agent-adapter.ts:compactPlannerModelMessagesForContext`** — in-memory only compaction for planner history. Computes a compaction message + recent tail + planner state context. Does not persist.
3. **`analyst-handler.ts:trimToCleanToolBoundary`** — standalone pure function that cleans orphan tool_call/tool_result pairs from a message slice. This is also independently reimplemented as `compaction.ts:trimLeadingOrphanToolRows` (internal to `createFallbackMessages`).

Key problems:
- `compactionStates` is a global module-level Map. Interleaved async calls for the same session see stale `state.count` decisions.
- Planner compaction is in `agent-adapter.ts` instead of the compaction module.
- Boundary trimming has two implementations doing the same thing differently.

### Design

#### New ContextCompactor service

```typescript
// src/agents/context-compactor.ts

export interface CompactionPolicy {
  contextLimit: number;
  threshold: number;
  maxCompactions: number;
  keepFraction: number;
  cooldownMs?: number;
  summarizeFn?: (messages: AgentMessage[]) => Promise<string>;
}

export interface ContextCompactorDeps {
  saivageDir: string;
  sessionStamper: SessionStamper;
}

export interface CompactionResult { /* same shape as current, minus module-level state */ }

export class ContextCompactor {
  private readonly stateMap = new Map<string, CompactionState>();
  private readonly sessionQueues = new Map<string, Promise<unknown>>();

  constructor(private readonly deps: ContextCompactorDeps) {}

  needsCompaction(estimatedTokens: number, policy: CompactionPolicy): boolean;
  compactSession(sessionId: string, policy: CompactionPolicy): Promise<CompactionResult>;
  compactPlannerInMemory(sessionId: string, messages: AgentMessage[], role: AgentRole, policy: CompactionPolicy, params: { projectRoot: string; goalId: string; cardStore: PlannerStateCardStore; runtimeStateProvider: () => RuntimeState | null }): AgentMessage[];
  pruneToolBoundary(messages: AgentMessage[]): AgentMessage[];
  resetState(sessionId: string): void;
  getCompactionCount(sessionId: string): number;
}
```

#### What each method does

- **`compactSession`**: The current `compaction.ts:compactSession` logic, but state is per-instance and per-session serialized instead of module-level. Persists by calling `replaceSessionMessages`. Used by analyst handler.
- **`compactPlannerInMemory`**: The current `buildPlannerHistoryCompactionMessage` + `buildPlannerRecentMessageTail` + `buildPlannerStateContextMessage` logic from `agent-adapter.ts`. Per-call parameters (`projectRoot`, `goalId`, `cardStore`, `runtimeStateProvider`) are passed as method arguments, not constructor deps. Returns the compacted message array. Does not persist. Used by planner invocation.
- **`pruneToolBoundary`**: Unified boundary pruning. Merges `trimToCleanToolBoundary` (analyst-handler) and `trimLeadingOrphanToolRows` (compaction.ts). One implementation, one name. Handles orphan result/error rows and unmatched calls. Pure function, also available as a method for convenience. Used in session compaction and analyst cleanup.

#### What gets deleted

- `compaction.ts:compactionStates` module-level Map
- `compaction.ts:getCompactionState`, `resetCompactionState`, `getCompactionCount`, `getCompactionStateForSession` as free functions (move to class methods)
- `compaction.ts:compactSession` as a free function (move to class method)
- `compaction.ts:trimLeadingOrphanToolRows` internal function (replaced by `pruneToolBoundary`)
- `agent-adapter.ts:compactPlannerModelMessagesForContext` (move to class method)
- `agent-adapter.ts:buildPlannerHistoryCompactionMessage` (move to class)
- `agent-adapter.ts:buildPlannerRecentMessageTail` (move to class)
- `analyst-handler.ts:trimToCleanToolBoundary` (use `ContextCompactor.pruneToolBoundary`)

#### What survives as canonical

- `src/agents/context-compactor.ts` — the new service module
- `compaction.ts` is deleted; its contents move to `context-compactor.ts`
- `agent-adapter.ts` loses its compaction functions entirely; `invokeAgent` receives a `ContextCompactor` instance and calls `compactor.compactPlannerInMemory(...)`
- `analyst-handler.ts` loses `trimToCleanToolBoundary`; it calls `compactor.pruneToolBoundary(...)` and `compactor.compactSession(...)`

#### Key decisions

- **Per-instance state, not module-level.** The `ContextCompactor` is constructed per-project and owned by the runtime composition. No more interleaved-async global Map.
- **Per-session serialization.** `compactSession` serializes work by `sessionId` inside the instance so concurrent analyst turns for the same session cannot both read the same compaction count, compact, and then overwrite each other's state. Different sessions can compact independently.
- **Per-call params on `compactPlannerInMemory`, not in constructor.** `projectRoot`, `goalId`, `cardStore`, and `runtimeStateProvider` are per-invocation parameters passed as method arguments to `compactPlannerInMemory`, not stored in `ContextCompactorDeps`. The constructor deps only hold long-lived shared resources (`saivageDir`, `sessionStamper`).
- **No temporary-instance shim for `compactSession`.** Either migrate callers atomically or use a module-level singleton for a single compiling step. A temporary instance per call loses compaction state tracking.
- **Planner in-memory compaction remains in-memory.** It never writes to session files. The planner's model messages are built fresh each invocation. The `ContextCompactor.compactPlannerInMemory` method returns the compacted array without side effects.
- **Boundary pruning is a shared pure helper.** Both `compactSession` (fallback path) and the analyst handler's pre-send boundary cleanup call the same `pruneToolBoundary`. It handles orphan result/error rows and unmatched calls.
- **Pass `ContextCompactor` to analyst deps or construct it in `AnalystHandler`.** The `analyst-handler.ts` receives a `ContextCompactor` instance via its deps or constructs one internally. It no longer calls `compactSession` and `trimToCleanToolBoundary` as free functions.

### Implementation Steps

**Step 4B-1:** Create `src/agents/context-compactor.ts` with the `ContextCompactor` class. Move all logic from `compaction.ts` into it (session compaction, fallback creation, boundary pruning, state tracking, `cooldownMs`). Add per-session queueing around `compactSession`. Add the `compactPlannerInMemory` method that wraps the current `compactPlannerModelMessagesForContext` logic with per-call params (`projectRoot`, `goalId`, `cardStore`, `runtimeStateProvider`) and keeps `buildPlannerStateContextMessage` in `planner-state-context.ts`. Add the `pruneToolBoundary` method that unifies both boundary trimming implementations and handles orphan result/error rows and unmatched calls. Delete `compaction.ts` entirely. Migrate all callers to import from `context-compactor.ts` directly. If a module-level singleton is needed for a single compiling step, use one; do not create a temporary instance per call.

**Step 4B-2:** Update `agent-adapter.ts` to accept and use a `ContextCompactor` instance. Remove `compactPlannerModelMessagesForContext`, `buildPlannerHistoryCompactionMessage`, `buildPlannerRecentMessageTail`, and the planner compaction constants from `agent-adapter.ts`. The `invokeAgent` method (or its tool loop) calls `compactor.compactPlannerInMemory(...)` with per-call params. Wire `ContextCompactor` construction in `runtime-composition.ts` or wherever `AgentAdapter` is constructed.

**Step 4B-3:** Update `analyst-handler.ts` to accept a `ContextCompactor` instead of calling `compactSession` and `trimToCleanToolBoundary` directly. Remove the `trimToCleanToolBoundary` export from `analyst-handler.ts`. Wire `ContextCompactor` in `AnalystHandler` construction (pass via analyst deps or construct internally). Verify all callers compile.

### Validation

```bash
npm run validate:routine
npm test
```

**Manual checks:**
- Start a planner invocation with long history that triggers compaction — verify planner still produces valid results.
- Run analyst chat with enough turns to trigger session compaction — verify history compacts correctly and no orphan tool_call/tool_result pairs survive.
- Verify `compactionStates` Map is no longer module-level by checking that two separate `ContextCompactor` instances have isolated state.

---

## Sub-wave 4C: Pause/Resume Command Unification (F20)

### Current State

Two paths:
1. **`control.ts:pauseRuntimeControl/resumeRuntimeControl`** — Offline/operator API calls. Reads persisted state, checks frozen/unavailable, and either:
   - Delegates to `runtimeApi.pause()/resume()` when runtime is available
   - Directly applies `createRuntimeStateMutationPort(...).apply(patch)` when runtime is not available
   - Sends a notification via `queueNotification`
   - Returns a `RuntimeControlResult`
2. **`runtime-pause-resume.ts:createRuntimePauseResumeController`** — Live runtime controller. A `RuntimePauseResumeController` object with `pause()`/`resume()` methods that:
   - Sets `deps.lifecycle.paused = true/false`
   - Calls `setProcessTerminalBuffering(...)`
   - Applies `buildPauseRuntimeStatePatch/buildResumeRuntimeStatePatch` via `mutations.apply(...)`
   - Emits `paused`/`resumed` events
   - Logs to `eventLogger`
   - Resume also injects planner resume context and queued planner notes via `goalContext`
   - Resume calls `stateMachine.requestImmediateTick()`

Key difference: The live controller has effects (lifecycle flags, process buffering, planner context, tick request) that the offline path lacks. The offline path has validation (frozen check, unavailable check) and notification that the live path currently does not send.

### Design

#### Unified command handler

```typescript
// src/runtime/runtime-control-commands.ts

export interface RuntimeControlResult {
  ok: boolean;
  code: 'paused' | 'resumed' | 'frozen' | 'unavailable' | 'error';
  statusCode?: number;
  status?: string;
  paused?: boolean;
  error?: string;
  message?: string;
  action?: 'inspect-frozen-state';
  state?: RuntimeState;
}

export interface PauseResumeEffects {
  now?: () => string;
  updateLifecyclePaused?(paused: boolean): void;
  setProcessTerminalBuffering?(enabled: boolean): void;
  applyStatePatch(patch: Partial<RuntimeState>): void;
  emitEvent?(eventName: 'paused' | 'resumed'): void;
  logEvent?(event: { kind: 'paused' | 'resumed'; ... }): void;
  injectPlannerResumeContext?(goalId: string, sessionId: string, reason: string): void;
  injectQueuedPlannerNotes?(sessionId: string): void;
  requestImmediateTick?(): void;
  sendNotification?(message: string): void;
}

export function pauseRuntimeCommand(
  projectRoot: string,
  effects: PauseResumeEffects,
): RuntimeControlResult;

export function resumeRuntimeCommand(
  projectRoot: string,
  effects: PauseResumeEffects,
): RuntimeControlResult;
```

#### How it works

Both `pauseRuntimeCommand` and `resumeRuntimeCommand`:
1. Read current state via `readRuntimeState(projectRoot)`
2. Validate: check for frozen, check for unavailable
3. Compute the state patch via `buildPauseRuntimeStatePatch(effects.now?.() ?? new Date().toISOString())` / `buildResumeRuntimeStatePatch(state)`
4. Apply the patch through `effects.applyStatePatch(patch)`
5. Call effect hooks:
   - **Pause:** `effects.updateLifecyclePaused?.(true)`, `effects.setProcessTerminalBuffering?.(true)`, `effects.emitEvent?.('paused')`, `effects.logEvent?.({ kind: 'paused', ... })`, `effects.sendNotification?.('Runtime was paused.')`
   - **Resume:** `effects.updateLifecyclePaused?.(false)`, `effects.setProcessTerminalBuffering?.(false)`, planner context injection if active planner run, `effects.applyStatePatch(resumePatch)`, `effects.emitEvent?.('resumed')`, `effects.logEvent?.({ kind: 'resumed', ... })`, `effects.requestImmediateTick?.()`, `effects.sendNotification?.('Runtime was resumed.')`

**Live runtime** provides full effects (lifecycle, buffering, planner context, tick). The live path currently does NOT send notifications; `sendNotification` is optional in `PauseResumeEffects` and is not wired for the live path. Adding it to the live path would be a behavior change that must be documented if done. **Offline/API path** provides a minimal effects set that does `applyStatePatch` + `sendNotification`. The frozen/unavailable validation is shared and remains reachable through `control.ts`.

#### Live path error handling

`PauseResumeEffects.applyStatePatch` for the live path must catch and not throw on state-file write failures. If a diagnostic channel is available, log the failure best-effort; otherwise preserve the current `runtime-pause-resume.ts` behavior of swallowing `mutations.apply(...)` failures so pause/resume side effects still run.

#### Avoiding recursion through `runtimeApi`

The offline path (`control.ts`) currently calls `runtimeApi.pause()/resume()` which delegates to the live controller. The unified commands must not recurse through `runtimeApi`. The live path calls the unified command with full effects; the offline path calls it with minimal effects. Both paths go directly through `pauseRuntimeCommand`/`resumeRuntimeCommand`, not through `runtimeApi`.

#### Preserving `control.ts` as boundary

`control.ts` remains as the CLI/analyst persisted-state boundary and exported API. Its `pauseRuntimeControl`/`resumeRuntimeControl` functions call `pauseRuntimeCommand`/`resumeRuntimeCommand` with minimal effects (`applyStatePatch` + `sendNotification`) and no longer delegate through `runtimeApi`. Live runtime calls the same commands with full effects. Both avoid recursion through `runtimeApi`.

#### What gets deleted

- The inline implementation inside `runtime-pause-resume.ts:createRuntimePauseResumeController` (logic moves to the effects-based command handler; the small controller facade can remain for `RuntimeApi.pause()/resume()` wiring)
- The inline pause/resume logic in `control.ts:pauseRuntimeControl/resumeRuntimeControl` is replaced by calls to `pauseRuntimeCommand`/`resumeRuntimeCommand`

#### What survives as canonical

- `src/runtime/runtime-control-commands.ts` — `pauseRuntimeCommand` and `resumeRuntimeCommand` are the single authority
- `control.ts` — preserved as CLI/analyst persisted-state boundary, now calls `pauseRuntimeCommand`/`resumeRuntimeCommand` with minimal effects
- `control-api.ts` continues to re-export `pauseRuntimeControl` and `resumeRuntimeControl`; `FROZEN_RUNTIME_RECOVERY_MESSAGE` is re-exported from `runtime-control-commands.ts`
- `buildPauseRuntimeStatePatch` / `buildResumeRuntimeStatePatch` stay in `runtime-core.ts` (shared pure functions, unchanged)

#### Callers migrate

| Current caller | Current path | Migration |
|---|---|---|
| `cli.ts` | `pauseRuntimeControl({ projectRoot })` | Keep calling `pauseRuntimeControl`; `control.ts` delegates to `pauseRuntimeCommand(projectRoot, minimalEffects)` |
| `analyst-runtime-tools.ts` | `pauseRuntimeControl({ projectRoot, runtimeApi })` | Keep calling `pauseRuntimeControl`; remove the `runtimeApi` delegation inside `control.ts` so it uses minimal effects directly |
| `runtime-pause-resume.ts` consumer | `controller.pause()` / `controller.resume()` | Keep the controller facade; its methods call `pauseRuntimeCommand(projectRoot, fullEffects)` / `resumeRuntimeCommand(projectRoot, fullEffects)` where `fullEffects` has all hooks including lifecycle, buffering, planner context, tick |

#### Key decisions

- **Effects ports, not inheritance.** No base class or interface hierarchy. Just a bag of function callbacks. Some are optional (`injectPlannerResumeContext`, `injectQueuedPlannerNotes`, `requestImmediateTick`, `sendNotification`) because different paths don't need them and they're undefined.
- **Frozen detection is shared.** The frozen/unavailable validation currently in `control.ts` is kept in the unified command handler. It's not an "effect" — it's a precondition check that always runs.
- **Notification is an effect, not inline.** The `queueNotification` call currently inlined in `control.ts` becomes `effects.sendNotification?.(...)`. Offline path provides it; live runtime path does not currently provide it. `sendNotification` is optional in `PauseResumeEffects`. Adding it to the live path would be a documented behavior change.
- **`logEvent` uses runtime event literals.** The `kind` parameter is `'paused' | 'resumed'`, matching the existing `eventLogger.appendEvent({ kind: 'paused' })` / `{ kind: 'resumed' }` calls.
- **The `FROZEN_RUNTIME_RECOVERY_MESSAGE` constant moves** from `control.ts` to `runtime-control-commands.ts`.
- **Best-effort state patch for live path.** `effects.applyStatePatch(patch)` for the live path catches failures rather than throwing. Log best-effort if a diagnostic channel is available, but do not make logging a new failure path. This preserves the current `mutations.apply(...)` behavior from `runtime-pause-resume.ts`.

### Implementation Steps

**Step 4C-1:** Create `src/runtime/runtime-control-commands.ts`. Copy the validation logic from `control.ts` (frozen check, unavailable check) into `pauseRuntimeCommand` and `resumeRuntimeCommand`. Define `PauseResumeEffects` interface with optional live-only hooks and `'paused' | 'resumed'` event literals. Implement both functions to: validate, compute patch, call effects. Make `control.ts` delegate to `pauseRuntimeCommand`/`resumeRuntimeCommand` with minimal effects wrappers (`applyStatePatch` + `sendNotification`) and remove its `runtimeApi.pause()/resume()` delegation. `cli.ts` and `analyst-runtime-tools.ts` keep using the `control.ts` boundary. All callers compile unchanged.

**Step 4C-2:** Update `runtime-pause-resume.ts` to construct `PauseResumeEffects` and call `pauseRuntimeCommand`/`resumeRuntimeCommand` instead of having its own inline pause/resume logic. The `createRuntimePauseResumeController` factory returns an object whose `pause()`/`resume()` methods call the unified commands with full effects. The live path `applyStatePatch` wraps `mutations.apply(...)` with try/catch and does not throw; diagnostic logging is best-effort only. Update the runtime composition layer only if constructor deps change.

**Step 4C-3:** Confirm `cli.ts` and `analyst-runtime-tools.ts` still call the `control.ts` boundary and do not pass behavior through `runtimeApi.pause()/resume()`. Keep `RuntimePauseResumeController` as a thin facade if that is the smallest compile-safe runtime API wiring. Update `control-api.ts` to re-export `FROZEN_RUNTIME_RECOVERY_MESSAGE` from `runtime-control-commands.ts` while continuing to export `pauseRuntimeControl` and `resumeRuntimeControl` from `control.ts`.

### Validation

```bash
npm run validate:routine
npm test
```

**Manual checks:**
- CLI pause/resume works: `SAIVAGE_API_TOKEN=test node dist/src/cli.js pause --project-root ...`
- Analyst pause/resume tool works through the web UI
- Live runtime pause/resume preserves lifecycle flags, planner context injection, tick request, and best-effort state writes (failures are logged, not thrown)
- Frozen runtime rejects resume with actionable error
- Uninitialized runtime rejects pause with actionable error
- No recursion through `runtimeApi` in any path

---

## Sub-wave 4D: Tool Dispatch Unification (F10)

### Current State

Three tool dispatch paths:
1. **`agent-tool-executor.ts:processToolCall`** — 53-line if/else chain for runtime tools, planner-control tools, MCP tools, skill tools, workspace tools. Returns `AgentToolMessage`. Handles argument parsing, policy checking via `RoleToolPolicy`, content supervision for MCP, and error formatting.
2. **`analyst-handler.ts:runAnalystLoop`** — Own `TOOL_REGISTRY` lookup, tool call persistence, result formatting, truncation (16K chars), dedup fingerprint check. Tools come from `TOOL_REGISTRY` map built from `TOOL_DEFINITIONS`.
3. **`planner-control-executor.ts:execute`** — Inline switch for planner-specific domain tools (create_card, edit_card, cancel_card, etc.). Has stateful domain-specific side effects via `PlannerToolsService` and `CardStore`. Own argument parsing and response enveloping.

Key duplication:
- Argument parsing (`JSON.parse(tc.function.arguments)`) appears in all three
- Result enveloping (`{ role: 'tool', kind: 'tool_result'|'tool_error', content, tool, tool_call_id }`) appears in all three
- Truncation logic is ad hoc (analyst: 16K chars, no truncation elsewhere)
- Error formatting is inconsistent
- Policy checking via `RoleToolPolicy` is only in `agent-tool-executor.ts`, not in analyst or planner

### Design

#### ToolDispatcher with pluggable adapters

```typescript
// src/agents/tool-dispatcher.ts

export interface ToolCallEnvelope {
  id: string;
  name: string;
  arguments: string;
}

export interface AdapterResult {
  success: boolean;
  data?: unknown;
  error?: string;
  metadata?: Record<string, unknown>;
}

export interface ToolDispatchResult {
  role: 'tool';
  kind: 'tool_result' | 'tool_error';
  content: string;
  tool: string;
  tool_call_id: string;
}

export interface ToolDispatchContext {
  role: AgentRole;
  sessionId: string;
  goalId?: string;
  cardId?: string;
  surface?: RoleToolPolicySurface;
  analystSurface?: ControlActionSurface;
  knownRuntimeTool?: (name: string) => boolean;
  knownPlannerTool?: (name: string) => boolean;
  toolCallIdPrefix?: string;
}

export interface ToolDispatchAdapter {
  category: string;
  handles(toolName: string): boolean;
  dispatch(envelope: ToolCallEnvelope, args: Record<string, unknown>, context: ToolDispatchContext): Promise<AdapterResult>;
}

export interface ToolDispatchPolicy {
  maxResultLength: number;
  categoryMaxResultLength?: Record<string, number>;
}

export interface ToolDispatchPersistence {
  persistToolResult(sessionId: string, msg: AgentToolMessage): void;
}
```

`dispatch(...)` returns a `ToolDispatchResult`/`AgentToolMessage` and does not automatically write to session storage. The persistence port is a caller-owned hook for the loops that decide when a result is safe to append. This preserves planner activation-barrier behavior, where an accepted `activate_card` result is consumed by the barrier and not always appended immediately.

**Registered adapter categories:**
- **`runtime`** — wraps the current `ToolRuntime` invocation from `agent-tool-executor.ts`
- **`planner-control`** — wraps `PlannerControlExecutor` with its domain-specific logic preserved intact
- **`mcp`** — wraps MCP tool invocation
- **`skill`** — wraps skill loading
- **`workspace`** — wraps workspace tool invocation
- **`analyst`** — wraps the analyst `TOOL_REGISTRY` lookup

#### What the ToolDispatcher owns

- **Argument parsing**: `JSON.parse(envelope.arguments)` with error handling. The parsed args are passed to adapters alongside the raw envelope.
- **Policy check**: `RoleToolPolicy.decide(...)` for agent-runtime, planner-control, MCP, skill, workspace, and contract-terminal tools, using `knownRuntimeTool`/`knownPlannerTool` from context for authorization routing. Analyst surface restrictions use the existing `RoleToolPolicy.assertAnalystSurfaceTool(toolName, analystSurface)` because `RoleToolPolicySurface` is a tool-category surface, not `web-chat`/`telegram`.
- **Result envelope construction**: consistent `{ kind, content, tool, tool_call_id }` shape, wrapping the `AdapterResult` from the adapter. The dispatcher owns `tool_call_id`, `tool`, and truncation.
- **Truncation**: unified `maxResultLength` policy (default 16K, configurable). Planner-control activation/terminal envelopes are exempt from truncation via `categoryMaxResultLength`. All paths use the same truncation rule.
- **Error formatting**: consistent envelope for parse errors, unknown tools, policy denials

#### What each adapter owns

- **`PlannerControlAdapter`**: owns `PlannerToolsService` creation, direct-child validation, planner-specific argument semantics. Returns domain-specific result objects as `AdapterResult`. The adapter wraps `PlannerControlExecutor.execute()` and returns `AdapterResult`. Planner-control semantics (card mutations, notifications) are entirely within the adapter.
- **`RuntimeToolAdapter`**: owns `ToolRuntime` invocation, role filtering.
- **`McpAdapter`**: owns MCP server discovery, invocation, content supervision.
- **`SkillAdapter`**: owns skill loading logic.
- **`WorkspaceAdapter`**: owns workspace tool invocation.
- **`AnalystAdapter`**: owns `TOOL_REGISTRY` lookup and analyst-specific tool context construction. Analyst surface comes from `AnalystHandler`'s actual `ControlActionSurface` (`web-chat`, `telegram`, etc.), not the current hardcoded `'web'` policy check in `LlmIntentResolver`.

#### What gets deleted

- `analyst-handler.ts`: inline tool dispatch loop (lines 272-368). The loop body that parses args, looks up `TOOL_REGISTRY`, calls the function, formats result, and truncates moves to the `AnalystAdapter` and `ToolDispatcher`. Broadcast/activity metadata and `responseTextForResult` handling stay in `AnalystHandler`.
- `analyst-handler.ts`: `TOOL_REGISTRY` import and direct usage. The `AnalystAdapter` encapsulates it.
- `agent-tool-executor.ts:processToolCall` method. The `AgentToolExecutor` class becomes a thin composition that constructs a `ToolDispatcher` with the right adapters.
- `planner-control-executor.ts:execute` is called from inside the `PlannerControlAdapter`, not from `processToolCall` directly. The `PlannerControlExecutor` class itself is preserved; only the dispatch envelope cruft around it is removed.

#### What survives as canonical

- `src/agents/tool-dispatcher.ts` — the `ToolDispatcher` class with pluggable adapters
- `src/agents/planner-control-executor.ts` — preserved as the domain-specific handler, but called through the `PlannerControlAdapter`
- `src/agents/agent-tool-executor.ts` — refactored to delegate to `ToolDispatcher`
- `src/agents/analyst-handler.ts` — loses its tool loop, keeps the outer LLM call loop, keeps `findRecentDuplicateResponse`, keeps UI/broadcast metadata and `responseTextForResult` handling

#### Key decisions

- **Adapters receive parsed args.** The dispatcher parses `JSON.parse(envelope.arguments)` and passes both the raw `envelope` and the parsed `args` to `dispatch(envelope, args, context)`. Adapters never parse arguments themselves.
- **Adapters return domain results, not envelopes.** `AdapterResult = { success, data?, error?, metadata? }`. The dispatcher constructs `ToolDispatchResult` with `tool_call_id`, `tool`, truncation, and wrapping.
- **Planner-control is not "just another tool."** Its handler has domain semantics (direct-child validation, card mutation side effects, reviewer invocation). The adapter pattern preserves this. The dispatcher handles envelope concerns; the adapter handles domain logic. Planner-control activation/terminal envelopes are exempt from the 16K truncation default via `categoryMaxResultLength`.
- **Truncation is a dispatcher policy, not per-path logic.** The 16K char limit in the analyst handler becomes the default `maxResultLength` in `ToolDispatchPolicy`. All paths use the same truncation rule. `categoryMaxResultLength` allows per-category overrides.
- **Policy checking is unified.** Every non-analyst tool call goes through `RoleToolPolicy.decide(...)` in the dispatcher. The `ToolDispatchContext` provides `knownRuntimeTool` and `knownPlannerTool` for authorization routing. Analyst calls use `RoleToolPolicy.assertAnalystSurfaceTool(toolName, analystSurface)` with the actual `AnalystHandler` surface (`web-chat`, `telegram`, etc.), not the hardcoded `'web'` currently used by `LlmIntentResolver`.
- **The analyst dedup fingerprint check** (`findRecentDuplicateResponse`) stays in the analyst handler's outer loop. It is not a dispatcher concern.
- **Assistant tool-call persistence stays in the caller loop.** `ToolDispatchPersistence` includes `persistToolResult` only. Tool-call persistence (`persistToolCall`) is not in `ToolDispatchPersistence`; it remains in the caller loops that manage LLM turn iteration.
- **Tool-result persistence timing stays in caller loops.** The dispatcher standardizes the result shape and truncation; the caller decides when to invoke `persistToolResult`. Agent code must keep the activation-barrier special case before appending results. Analyst code persists after activity/broadcast bookkeeping and before the next LLM turn.
- **Analyst handler keeps UI/broadcast metadata and `responseTextForResult` handling.** These are analyst-specific concerns that belong in `AnalystHandler`, not in the dispatcher.

### Implementation Steps

**Step 4D-1:** Create `src/agents/tool-dispatcher.ts` with `ToolDispatcher`, `ToolCallEnvelope`, `AdapterResult`, `ToolDispatchResult`, `ToolDispatchContext` (including `knownRuntimeTool`, `knownPlannerTool`, and optional `analystSurface`), `ToolDispatchAdapter`, `ToolDispatchPolicy` (including `categoryMaxResultLength`), and `ToolDispatchPersistence` (including only `persistToolResult`, not `persistToolCall`). Implement the `dispatch` method: parse arguments, run policy check, find matching adapter, call adapter with both raw `envelope` and parsed `args`, construct `ToolDispatchResult` from `AdapterResult`, truncate result per policy (exempt planner-control envelopes via `categoryMaxResultLength`), and return the result without automatically writing session storage. Create adapter registrations for each category. Do not yet remove any existing code — just add the new module with exports.

**Step 4D-2:** Create adapter implementations: `PlannerControlAdapter`, `RuntimeToolAdapter` (wrapping `ToolRuntime`), `McpAdapter`, `SkillAdapter`, `WorkspaceAdapter`, `AnalystAdapter`. Each wraps its existing domain logic. The `AnalystAdapter` gets its surface from `AnalystHandler`'s actual `ControlActionSurface`, not a hardcoded `'web'`. Wire `AgentToolExecutor` to construct a `ToolDispatcher` with runtime, planner-control, MCP, skill, and workspace adapters. Add a compatibility method `processToolCall(tc, role, sessionId, invocation)` on `AgentToolExecutor` that delegates to `dispatcher.dispatch(...)` and returns the message for the existing caller to append. All existing callers compile. Test with `npm test`.

**Step 4D-3:** Refactor `analyst-handler.ts` to use the `ToolDispatcher` with the `AnalystAdapter`. Replace the inline tool dispatch loop in `runAnalystLoop` with: (1) parse LLM result, (2) persist assistant tool-call rows in the caller loop, (3) for each tool call, call `dispatcher.dispatch(...)`, (4) emit activity/broadcast metadata, persist the returned tool result, and apply `responseTextForResult` handling. Keep `findRecentDuplicateResponse` in the analyst handler's outer loop (not a dispatcher concern). Wire `ToolDispatchPersistence` for analyst session persistence (only `persistToolResult`). Remove `TOOL_REGISTRY` import from `analyst-handler.ts` (moved into `AnalystAdapter`). Preserve analyst prompt/tool filtering by actual `ControlActionSurface` (`web-chat`, `telegram`, etc.).

**Step 4D-4:** Remove `AgentToolExecutor.processToolCall` dispatch body. The method becomes a one-liner delegating to `this.dispatcher.dispatch(...)`. Remove the 53-line if/else chain. Remove the individual method-level tool dispatch logic (MCP, skill, workspace inline paths). All of that lives in adapters now.

### Validation

```bash
npm run validate:routine
npm test
```

**Manual checks:**
- Planner invocation with tool calls: create_card, edit_card, report_goal_done — all work through dispatcher
- Analyst tool calls: get_card, create_card, navigate_workspace — all work through dispatcher
- MCP tool calls work through dispatcher
- Denied tool calls (policy) return correct tool_error envelope
- Tool result truncation at 16K chars applies uniformly (planner-control envelopes exempt via `categoryMaxResultLength`)
- Tool call result persistence works for both agent and analyst sessions
- Analyst surface comes from `AnalystHandler`'s actual surface, not hardcoded `'web'`

---

## Sub-wave 4E: LLM Invocation Unification (F02)

### Current State

Two LLM invocation paths:

1. **`AgentAdapter.invokeAgent`** (lines 712-1060+) in `agent-adapter.ts`. This is the canonical path that:
   - Resolves model candidates via `this.router.resolve(role, capabilityRequest)`
   - Iterates over candidate chain with recovery via `defaultInvocationRecoveryPolicy`
   - Creates session via `createSession` + `appendPersistentMessage`
   - Uses `AgentLoopDriver` for the tool-call/message loop
   - Uses `createContractVerifier` for contract verification
   - Uses `buildLlmOptions` for LLM call construction
   - Records attempts via `eventLogger.appendEvent` and `eventBus.emit`
   - Uses `AgentLlmInvocationGateway` for actual LLM calls
   - Does planner-specific in-memory compaction

2. **`AnalystHandler → LlmIntentResolver.chat`** (lines 100-223 of `analyst-llm-resolver.ts`). This is the analyst path that:
   - Resolves model candidates with its own `ModelRouter` instance
   - Iterates over candidate chain with its own recovery logic (inlined, no `AgentLoopDriver`)
   - Creates its own `LlmProviderGateway` client per-candidate (cached per `cacheKey`)
   - Builds its own LLM options via `buildLlmOptions`
   - Creates its own `LlmExchangeRecorder` per session
   - Has no contract verification (analyst responses are free-form)
   - Has no tool loop — returns `LlmCompleteResult` directly to `AnalystHandler` which runs its own tool loop

Key shared infrastructure they already use:
- `LlmProviderGateway` — actual HTTP call
- `resolveLlmTransportConfig` — transport config resolution
- `buildLlmOptions` — LLM options construction
- `createLlmExchangeRecorder` — recording
- `defaultInvocationRecoveryPolicy` — availability/recovery decisions

Key duplication:
- Candidate iteration with availability/recovery tracking (analyst does it inline; agent does it in `invokeAgent`)
- Session-level client caching (analyst: `clientCache`, `recorderCache`; agent: `AgentLlmInvocationGateway.llmClientCache`, `recorderCache`)
- LLM call orchestration (resolve candidate → get/create client → call → handle result → mark availability)

### Design

#### Shared InvocationService

```typescript
// src/agents/invocation-service.ts

export interface InvocationRequest {
  role: AgentRole;
  sessionId: string;
  systemPrompt: string;
  contextMessages: AgentMessage[];
  tools: ToolDefinition[];
  terminalToolNames: string[];
  modelParams: { temperature?: number; maxTokens?: number };
  capabilityRequest: ReturnType<typeof capabilityRequestForLlmOptions>;
  abortSignal?: AbortSignal;
  candidateChain?: Candidate[];
}

export interface InvocationServiceConfig {
  projectRoot: string;
  saivageDir: string;
  registry: ProviderRegistry;
  router: ModelRouter;
  eventLogger?: EventLogger;
  candidateAvailability?: CandidateAvailability;
  runtimeConfig: RuntimeSection;
}
```

Note: `InvocationServiceConfig.candidateAvailability` defaults to `MemoryCandidateAvailability` if omitted.

The `InvocationService` provides:

```typescript
export class InvocationService {
  private readonly llmGateway: AgentLlmInvocationGateway;

  constructor(config: InvocationServiceConfig);

  async resolveCandidates(role: AgentRole, capabilityRequest: CapabilityRequest): Promise<Candidate[]>;
  async invokeCall(request: InvocationRequest, candidate: Candidate): Promise<LlmCompleteResult>;
  async invokeWithRecovery(request: InvocationRequest): Promise<LlmCompleteResult>;
}
```

`invokeWithRecovery` returns `LlmCompleteResult` directly, not a separate `InvocationResult` type.

`InvocationService` is the shared LLM-turn transport/recovery service. It owns candidate resolution, client/recorder caching through `AgentLlmInvocationGateway`, LLM option construction, and candidate availability marking around raw `complete()` calls. It does not own `AgentLoopDriver`, contract verification, planner activation barriers, or analyst response/broadcast logic.

#### How both paths use it

**Agent path (`AgentAdapter.invokeAgent`):**
- Calls `invocationService.resolveCandidates(role, capabilityRequest)` for candidate resolution
- In the `AgentLoopDriver` turn body, calls `invocationService.invokeCall(request, candidate)` for each individual LLM call
- Recovery logic stays in `invokeAgent` / `AgentLoopDriver` (it's agent-specific: repair budget, contract verification, multiple attempts)
- Session management, tool loop, and contract verification remain in `AgentAdapter` — those are agent-specific orchestration, not LLM transport
- `AgentAdapter` keeps recovery decisions for contract/protocol failures, `llm_attempt` event persistence, model-issue session messages, and contract outcome success/failure handling
- `InvocationService` owns raw LLM `complete()` execution, transport client/recorder caching, and availability marking for the candidate passed to `invokeCall`

**Analyst path (`AnalystHandler`):**
- No more `LlmIntentResolver` class
- `AnalystHandler` calls `invocationService.invokeWithRecovery(request)` which handles the candidate chain, availability marking, and error recovery
- The analyst tool loop stays in `AnalystHandler` (it's the same pattern as the agent tool loop but with different loop control and tool dispatch)
- `AnalystHandler.runAnalystLoop` calls the invocation service for the LLM turn, then dispatches tools through `ToolDispatcher`
- `AnalystHandler` keeps `findRecentDuplicateResponse`, UI/broadcast metadata, `responseTextForResult` handling, and prompt/tool filtering by actual `ControlActionSurface` (`web-chat`, `telegram`, etc.)
- `AnalystHandler` replaces its private `readSession`/`writeSession` helpers with the existing `session-persistence.ts` session helpers (`getSession`, `createSession`, message append/read functions)

#### What the InvocationService owns

- **Candidate resolution**: `router.resolve(role, capabilityRequest)` and `router.getLastCapabilitySkips()`
- **LLM call execution**: `AgentLlmInvocationGateway.createLlmCallFn()`; do not duplicate `LlmProviderGateway`/`resolveLlmTransportConfig`/recorder caches in the service
- **Availability marking**: `candidateAvailability.markSucceeded/markFailed` after each call
- **Recovery on transport errors**: iterating over the candidate chain, applying `defaultInvocationRecoveryPolicy`, marking availability

#### What stays in the callers

- **Agent path**: session creation, context message building, tool loop (`AgentLoopDriver`), contract verification, planner compaction, attempt recording, retry orchestration for contract/protocol failures, `llm_attempt` model issue persistence, contract outcome success/failure
- **Analyst path**: tool loop orchestration, analyst session lifecycle via shared session-persistence helpers, dedup check, broadcast/emit events, `findRecentDuplicateResponse`, UI/broadcast metadata, `responseTextForResult`, prompt/tool filtering by actual `ControlActionSurface`

#### What gets deleted

- `analyst-llm-resolver.ts` — the entire `LlmIntentResolver` class and its candidate iteration/recovery logic
- `analyst-llm-resolver.ts:ANALYST_TOOL_REGISTRY` — moved into `AnalystAdapter` (from sub-wave 4D). Any importer of this alias needs path update.
- `analyst-llm-resolver.ts:ANALYST_SYSTEM_PROMPT`, `getAnalystSystemPrompt`, `getAnalystToolDefinitions`, `ANALYST_NO_MODEL_REPLY`, `AnalystOfflineError` — these move to `analyst-handler.ts` or a new `analyst-prompt.ts`
- `analyst-handler.ts` direct session read/write methods (`readSession`, `writeSession`, `sessionFilePath`, `sessionsDir`) — migrate to use `session-persistence.ts` functions (`getSession`, `createSession`, `appendMessage`, `getSessionMessages`)

#### What survives as canonical

- `src/agents/invocation-service.ts` — the unified service
- `src/agents/agent-llm-gateway.ts` — preserved, used by `InvocationService`
- `src/agents/agent-adapter.ts` — simplified, delegates LLM transport concerns to `InvocationService`. Constructor injection of `LlmCallFn` or `InvocationService` replaces the `setLlmCallFn` setter pattern. `AgentAdapter` keeps contract/protocol recovery decisions, `llm_attempt` model issue persistence, and contract outcome success/failure. `InvocationService` owns raw `complete()` execution and availability updates for LLM transport calls.
- `src/agents/analyst-handler.ts` — simplified, uses `InvocationService` for LLM calls. Keeps `findRecentDuplicateResponse`, UI/broadcast metadata, `responseTextForResult`, and analyst prompt/tool filtering by actual `ControlActionSurface`.

#### Key decisions

- **The agent contract loop is NOT the shared invocation boundary.** The `AgentLoopDriver` turn logic (contract verification, tool dispatch, repair budget, planner activation barriers) is agent-specific orchestration. It is not duplicated — it simply doesn't exist in the analyst path. What's duplicated is the LLM turn transport layer: resolve candidate → get client/recorder → call → handle transport error → mark availability. That's what `InvocationService` owns. `InvocationService` must not depend on `ToolDispatcher`.
- **`invokeWithRecovery` is for the analyst.** The analyst needs a simple "try candidates, recover on failures, return result" flow. The agent needs finer control (per-attempt recovery in the loop). The service provides both: `invokeWithRecovery` for the analyst case, and `invokeCall` for individual calls that the agent loop manages. `invokeWithRecovery` returns `LlmCompleteResult` directly.
- **No `InvocationResult` type.** Use `LlmCompleteResult` directly. No separate `InvocationResult` type is introduced.
- **No backward compat for `LlmIntentResolver`.** Delete it. `AnalystOfflineError` moves to `analyst-handler.ts` or becomes `AnalystInvocationError` in `invocation-service.ts`. The `ANALYST_NO_MODEL_REPLY` string is analyst-specific and stays in the analyst handler.
- **Constructor injection for test fakes.** `AgentAdapter` takes `LlmCallFn` or `InvocationService` via constructor injection. The `setLlmCallFn` setter is removed. Fake-LLM injection for tests uses constructor injection.
- **`InvocationServiceConfig.candidateAvailability` defaults to `MemoryCandidateAvailability`.** If omitted, the service creates a `MemoryCandidateAvailability` internally. Callers don't need to provide one unless they want shared availability tracking.
- **AgentAdapter keeps agent-specific concerns.** Contract/protocol recovery decisions, `llm_attempt` model issue persistence, model-issue session messages, and contract outcome success/failure stay in `AgentAdapter`. `InvocationService` owns raw `complete()` execution and candidate availability updates for transport calls.
- **Analyst handler keeps analyst-specific concerns.** UI/broadcast metadata, `responseTextForResult` handling, `findRecentDuplicateResponse`, and prompt/tool filtering by actual `ControlActionSurface` (`web-chat`, `telegram`, etc.) stay in `AnalystHandler`.
- **Analyst session helpers are in scope.** The analyst already stores sessions/messages under the same `.saivage/agents/` tree. Replace its private file-path/read/write helpers with the existing `session-persistence.ts` helpers while keeping analyst-specific session IDs (`analyst`, `telegram-<chatId>`) and dedup logic in `AnalystHandler`.

### Implementation Steps

**Step 4E-1:** Create `src/agents/invocation-service.ts` with `InvocationService`. Extract the LLM transport orchestration currently in `LlmIntentResolver.chat` (candidate chain iteration, availability marking, gateway call) and the same transport-call path from `AgentAdapter.invokeAgent` (candidate resolution and `AgentLlmInvocationGateway` use, not `AgentLoopDriver` or contract verification). The service provides `resolveCandidates`, `invokeCall` (single candidate), and `invokeWithRecovery` (full chain). `invokeWithRecovery` returns `LlmCompleteResult` directly. `InvocationServiceConfig.candidateAvailability` defaults to `MemoryCandidateAvailability` if omitted. Wire `InvocationService` construction in `runtime-composition.ts` or `AgentAdapter` constructor. Add constructor injection for `LlmCallFn`/`InvocationService` to `AgentAdapter` (replacing the `setLlmCallFn` setter pattern). Do not yet remove `LlmIntentResolver`. All existing callers compile.

**Step 4E-2:** Refactor `AgentAdapter.invokeAgent` to use `InvocationService` for candidate resolution and individual LLM calls. Replace the inline `this.router.resolve(...)` + transport-call path with `invocationService.resolveCandidates(...)` and `invocationService.invokeCall(...)`, while keeping the agent-specific candidate loop/retry decisions around `AgentLoopDriver`. The `AgentLoopDriver` turn body still constructs turn messages and calls a `LlmCallFn`, but that function now delegates to `invocationService.invokeCall` instead of `AgentLlmInvocationGateway` directly. Keep `AgentLlmInvocationGateway` as the underlying transport. `AgentAdapter` keeps contract/protocol recovery decisions, `llm_attempt` model issue persistence, and contract outcome success/failure.

**Step 4E-3:** Refactor `AnalystHandler` to use `InvocationService.invokeWithRecovery` for LLM calls. Remove the `LlmIntentResolver` dependency. Move analyst-specific concerns (`ANALYST_SYSTEM_PROMPT`, `getAnalystToolDefinitions`, `AnalystOfflineError`) into `AnalystHandler` or a helper module. Replace private `readSession`/`writeSession`/path helpers with `session-persistence.ts` helpers while preserving analyst-specific session IDs. Delete `analyst-llm-resolver.ts`. Update all imports. `AnalystHandler` keeps `findRecentDuplicateResponse`, UI/broadcast metadata, `responseTextForResult` handling, and prompt/tool filtering by actual `ControlActionSurface` (`web-chat`, `telegram`, etc.). The `AnalystHandler` loop now: (1) compacts via `ContextCompactor`, (2) calls `invocationService.invokeWithRecovery(...)` for the LLM turn, (3) dispatches tools via `ToolDispatcher`, (4) loops if tool_calls result. Any importers of `ANALYST_TOOL_REGISTRY` alias from `analyst-llm-resolver.ts` need path updates.

**Step 4E-4:** Clean up `AgentLlmInvocationGateway` and `AgentAdapter`. Since `InvocationService` now wraps `AgentLlmInvocationGateway`, the `AgentAdapter.llmCallFn` field can be simplified. The `AgentAdapter` constructs or receives an `InvocationService` and delegates to it. Remove the `setLlmCallFn` setter pattern entirely. Fake-LLM injection for tests uses constructor injection. `InvocationService` owns the gateway.

### Validation

```bash
npm run validate:routine
npm test
```

**Manual checks:**
- Planner loop: invoke agent → LLM call → tool call → LLM call → contract result — works through `InvocationService`
- Analyst chat: message → LLM call → tool call → LLM call → text response — works through `InvocationService`
- Candidate failover: configure a bad provider → verify recovery to next candidate works for both planner and analyst
- Session recording: verify LLM exchange records appear in `.saivage/agents/exchanges/` for both paths
- Availability tracking: verify `candidateAvailability.markSucceeded/markFailed` is called correctly for both paths
- Fake-LLM injection: verify tests that inject fake LLM calls work via constructor injection

---

## Full Wave Validation

After all sub-waves are complete:

```bash
npm run validate:routine
npm test
npm run validate:ui-smoke
```

**Integration verification checklist:**

1. **Full planner cycle**: start runtime → planner invokes → creates cards → uses planner-control tools → executor runs → reviewer assesses → goal completes. Verify tool dispatch, LLM invocation, compaction, pause/resume, and diagnostics all work through unified paths.

2. **Analyst cycle**: send chat message → LLM responds → tool call dispatched → result persisted → followup LLM call → text response. Verify the analyst uses `InvocationService`, `ToolDispatcher`, `ContextCompactor`, and unified diagnostics.

3. **Pause/resume round-trip**: pause runtime via CLI → verify state persisted, lifecycle paused, buffering enabled. Resume via API → verify state restored, planner context injected, tick requested. Pause via analyst tool → same verification.

4. **Compaction**: trigger planner session compaction by exceeding token limit. Verify `ContextCompactor.compactPlannerInMemory` produces valid compacted context. Trigger analyst session compaction. Verify `ContextCompactor.compactSession` persists correctly. Verify no orphan tool pairs in either.

5. **Diagnostics**: trigger each failure path (planner invocation, executor invocation, reviewer invocation). Verify exactly one diagnostic event per failure in both event bus and durable log. No duplicates.

6. **No dead code**: grep for `emitRuntimeDiagnostic`, `appendRuntimeDiagnostic`, `LlmIntentResolver`, `compactSession` as free function, `pauseRuntimeControl`, `resumeRuntimeControl`, `trimToCleanToolBoundary`, `processToolCall` dispatch chain. All should be absent or point to unified replacements.
