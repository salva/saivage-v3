# Wave 4: Path Unification — Implementation Plan

## Second Review Corrections

This section supersedes both the Reviewed Corrections and any conflicting text below.

### F35: Diagnostic Publishing

1. **HIGH — Do NOT keep `emitRuntimeDiagnostic` as deprecated shim**: Reviewed Correction #2 says "Do not keep `emitRuntimeDiagnostic` as a compatibility alias." Step 4A-1 suggests `@deprecated`. Remove `emitRuntimeDiagnostic` and migrate all callers in the same commit. No deprecated interim.
2. **HIGH — Add `planner-failure-handler.ts` to migration steps**: `PlannerFailureHandler` at `src/runtime/phases/planner-failure-handler.ts:39-40` provides `emitRuntimeDiagnostic` and `appendRuntimeDiagnostic` to `handlePlannerInvocationFailure`. Add explicit step: migrate PlannerFailureHandler to provide `publishRuntimeDiagnostic`, then remove `emitRuntimeDiagnostic` from its deps.
3. **MEDIUM — `runtime-project-commands.ts` should gain `publishRuntimeDiagnostic`**: It currently calls `eventLogger.appendEvent({ kind: 'runtime_diagnostic' })` directly (lines 99-104, 158-172). It is not early startup. Add `publishRuntimeDiagnostic` to `RuntimeProjectCommandRunner` deps Pick.

### F23: Context Compaction

4. **HIGH — Remove `CompactionMode` from design**: The design shows `export type CompactionMode = 'session' | 'planner_in_memory' | 'analyst_boundary'` but Reviewed Correction #6 says "Remove unused `CompactionMode`." No `CompactionMode` type exists in current code. The design introduces dead code.
5. **HIGH — Per-call params must NOT be in `ContextCompactorDeps` constructor**: Reviewed Correction #6. `projectRoot`, `goalId`, `cardStore`, `runtimeStateProvider` are per-call parameters for planner compaction. They must be method params on `compactPlannerInMemory`, not constructor deps.
6. **HIGH — No temporary-instance shim for `compactSession`**: Reviewed Correction #8. Step 4B-1 suggests a re-export barrel creating a temporary instance. Either migrate callers atomically or use a module-level singleton for one compiling step. A temporary instance per call loses compaction state tracking.

### F20: Pause/Resume

7. **HIGH — Preserve `mutations.apply` best-effort error swallowing**: `runtime-pause-resume.ts` wraps `deps.mutations.apply(...)` in try/catch with empty catch. The unified command must preserve this. `PauseResumeEffects.applyStatePatch` for the live path must catch and log (not throw) on state-file write failures.
8. **MEDIUM — Live path currently does NOT send notifications**: Adding `sendNotification` to live pause/resume is a behavior change. Either document as intentional or make `sendNotification` optional in live effects.
9. **LOW — `logEvent` event kind typing**: Use the existing `EventKind` discriminated union, not `string`, for the `logEvent` effect's `kind` parameter.

### F10: Tool Dispatch

10. **HIGH — Adapter interface must include parsed `args`**: Reviewed Correction #13. Change signature to `dispatch(envelope: ToolCallEnvelope, args: Record<string, unknown>, context: ToolDispatchContext): Promise<AdapterResult>`. The dispatcher parses `JSON.parse(envelope.arguments)` and passes both raw envelope and parsed args.
11. **HIGH — Adapters return domain result, not envelope**: Reviewed Correction #14. Define `AdapterResult = { success: boolean; data?: unknown; error?: string; metadata?: Record<string, unknown> }`. The dispatcher wraps this into `ToolDispatchResult` with envelope-level fields (`tool_call_id`, `tool`, truncation).
12. **HIGH — Planner-control envelopes exempt from truncation**: Reviewed Correction #17. The 16K default `maxResultLength` must NOT apply to planner-control activation/terminal envelopes. Add `categoryMaxResultLength` or an exemption to `ToolDispatchPolicy`.
13. **HIGH — Remove `persistToolCall` from `ToolDispatchPersistence`**: Reviewed Correction #18. Assistant tool-call persistence stays in the caller loop. `ToolDispatchPersistence` should not include `persistToolCall`.
14. **MEDIUM — Add `knownRuntimeTool`/`knownPlannerTool` to `ToolDispatchContext`**: Reviewed Correction #16. `AgentToolExecutor.decideToolInvocation` uses these for policy decisions. Include them in the context or policy check input.
15. **MEDIUM — Analyst surface must not be hardcoded `'web'`**: Reviewed Correction #15. When constructing `ToolDispatchContext` for analyst calls, populate `surface` from `AnalystHandler`'s actual surface, not a hardcoded `'web'`.

### F02: LLM Invocation

16. **MEDIUM — Preserve fake-LLM injection before removing `setLlmCallFn`**: Reviewed Correction #23. Add constructor injection of `LlmCallFn` or `InvocationService` to `AgentAdapter` before removing the setter.
17. **MEDIUM — Use `LlmCompleteResult` directly, not a new `InvocationResult`**: Reviewed Correction #22. Remove the separate `InvocationResult` type. `invokeWithRecovery` returns `LlmCompleteResult` directly.
18. **MEDIUM — `InvocationServiceConfig.candidateAvailability` needs explicit default**: `AgentAdapter` and `LlmIntentResolver` create `MemoryCandidateAvailability` if none provided. Document that `InvocationService` defaults to `MemoryCandidateAvailability` if omitted.
19. **LOW — `ANALYST_TOOL_REGISTRY` re-export alias**: `analyst-llm-resolver.ts:226` exports `ANALYST_TOOL_REGISTRY = TOOL_REGISTRY`. Any importer of this alias needs path update if the module moves.

## Reviewed Corrections

This section supersedes any conflicting text below.

1. F02 does not need F10 for model transport. Tool dispatch precedes analyst loop migration, but `InvocationService` is limited to routing/client/recorder concerns and must not depend on `ToolDispatcher`.
2. Add `publishRuntimeDiagnostic` and migrate callers in the same step. Do not keep `emitRuntimeDiagnostic` as a compatibility alias.
3. `publishRuntimeDiagnostic` emits first, then best-effort appends durable events.
4. Add `buildRuntimeDiagnosticEvent(input)` for direct EventLogger-only startup helpers. Do not force publisher wiring into early-start modules.
5. Include `runtime/phases/planner-failure-handler.ts` in diagnostic migration. Durable path is `.saivage/runtime/events.jsonl`.
6. `ContextCompactor` constructor owns long-lived deps only; per-call planner compaction receives project/card/runtime providers. Remove unused `CompactionMode`.
7. Implement `pruneToolBoundary(messages)` for orphan result/error rows and unmatched calls. Use it in session compaction and analyst cleanup.
8. No temporary-instance shim for `compactSession`. Migrate callers atomically or keep a module-level singleton for a single compiling step.
9. Pass `contextCompactor` to analyst deps or construct it in `AnalystHandler`.
10. Keep `control.ts` as CLI/analyst persisted-state boundary unless all callers move to a new non-recursive boundary. Live runtime calls the full command; analyst/CLI keep calling control with `{ projectRoot, runtimeApi }`.
11. Avoid pause/resume recursion through `runtimeApi`.
12. Preserve live pause/resume best-effort behavior for lifecycle/process-buffering and swallowed/diagnosed state/context failures.
13. Tool adapters receive parsed args: `dispatch({ envelope, args, context })`.
14. Dispatcher owns result envelopes; adapters return domain output/error/metadata. Planner-control is a special exception only if explicitly designed.
15. Analyst policy uses `assertAnalystSurfaceTool(toolName, surface)` or a real analyst surface in `RoleToolPolicy`.
16. Runtime tool authorization passes `knownRuntimeTool`.
17. Do not truncate planner-control activation/terminal envelopes before runtime parsing.
18. Assistant tool-call persistence stays in caller loop; dispatcher returns result rows only.
19. Analyst handler keeps UI/broadcast metadata and `responseTextForResult` handling.
20. Keep `findRecentDuplicateResponse` where it is.
21. `InvocationService` owns raw `complete()` only. AgentAdapter keeps recovery decisions, candidate availability, `llm_attempt`, model issue persistence, and contract outcome success/failure.
22. Use `LlmCompleteResult` directly.
23. Preserve fake-LLM injection by replacing `setLlmCallFn` with constructor/test injection before removing it.
24. Preserve analyst prompt/tool filtering by actual surface (`web`/`telegram`).

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

**Call sites that call both:**
- `runtime-planner-dispatcher.ts:68-75` and `:100-107`
- `executor-activation-dispatcher.ts:80-88` and `:125-127`
- `runtime-reviewer-dispatcher.ts:95-104`
- `phases/planner-invocation-failure.ts:70-72`
- `phases/executor-invocation-failure.ts:24-25`
- `phases/reviewer-invocation-failure.ts:22-23`
- `runtime-project-commands.ts:100,158,167`

**Additional standalone `appendEvent({ kind: 'runtime_diagnostic' })` calls:**
- `analyst-handler.ts:228` (logBoundaryDiagnostic)
- `startup-run-reconciliation.ts:41`
- `persisted-planner-history.ts:83`

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
```

`publishRuntimeDiagnostic` owns both channels:
1. Emits on the event bus via `this.emit('runtime_diagnostic', { ... })`
2. Appends to the durable event log via `this.eventLogger.appendEvent({ kind: 'runtime_diagnostic', goal_id, card_id, phase, error_message, error_name })`
3. Derives `error_message` and `error_name` from the `error` field internally (same logic currently in `emitRuntimeDiagnostic`)

#### Effects interfaces simplified

Every phase-level effects interface that currently has both `emitRuntimeDiagnostic` and `appendRuntimeDiagnostic` collapses to just:

```typescript
export interface PlannerInvocationFailureEffects {
  publishRuntimeDiagnostic(input: DiagnosticInput): void;
  // appendError remains separate — it appends to the error log, not the event log
  // ... other effects unchanged
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

- The `emitRuntimeDiagnostic` method on `RuntimeEventPublisher`
- The `emitRuntimeDiagnostic` field on `RuntimeServices`
- The `appendRuntimeDiagnostic` method from every phase effects interface
- The `emitRuntimeDiagnostic` field from every dispatcher deps type that currently lists it separately
- The separate `emitRuntimeDiagnostic` line at every dual call site

#### What survives as canonical

- `publishRuntimeDiagnostic` on `RuntimeEventPublisher` — the single entry point
- `RuntimeServices.publishRuntimeDiagnostic` replaces `RuntimeServices.emitRuntimeDiagnostic`
- Phase effects interfaces have a single `publishRuntimeDiagnostic` method
- Standalone `appendEvent({ kind: 'runtime_diagnostic' })` call sites (analyst handler, startup reconciliation, etc.) migrate to calling `publishRuntimeDiagnostic` where they have access to a publisher, or keep their own best-effort pattern where they don't

#### Key decisions

- **No backward compatibility.** Remove `emitRuntimeDiagnostic` from `RuntimeServices` and all call sites in one commit.
- **Error extraction is internal.** `publishRuntimeDiagnostic` extracts `error_message` and `error_name` from the `error` field. Callers never pass `error_message` separately.
- **Standalone call sites** (analyst-handler, startup-reconciliation, persisted-planner-history) that call `eventLogger.appendEvent` directly will migrate. Where a publisher is available, they use it. Where it isn't (early startup), they call the event logger directly but through a helper that documents the exception.

### Implementation Steps

**Step 4A-1:** Add `publishRuntimeDiagnostic` to `RuntimeEventPublisher`. It calls both `this.emit` and `this.eventLogger.appendEvent`. Keep `emitRuntimeDiagnostic` temporarily but mark it `@deprecated`. Update `RuntimeServices` interface to add `publishRuntimeDiagnostic` alongside the existing `emitRuntimeDiagnostic`. All callers compile.

**Step 4A-2:** Migrate all dual call sites in dispatchers and phases to use `publishRuntimeDiagnostic`. Update `PlannerInvocationFailureEffects`, `ExecutorInvocationFailureEffects`, `ReviewerInvocationFailureEffects` to use single `publishRuntimeDiagnostic` instead of both `emitRuntimeDiagnostic` and `appendRuntimeDiagnostic`. Migrate `runtime-planner-dispatcher.ts`, `executor-activation-dispatcher.ts`, `runtime-reviewer-dispatcher.ts`. Migrate `runtime-project-commands.ts`.

**Step 4A-3:** Delete `emitRuntimeDiagnostic` from `RuntimeEventPublisher`, `RuntimeServices`, and the `RuntimeServices` type. Remove `emitRuntimeDiagnostic` from all dispatcher dependency types. Remove `appendRuntimeDiagnostic` from all phase effects interfaces. Migrate standalone call sites: `analyst-handler.ts` logBoundaryDiagnostic, `startup-run-reconciliation.ts`, `persisted-planner-history.ts`.

### Validation

```bash
npm run validate:routine
npm test
```

**Manual checks:**
- Trigger a planner invocation that produces an error — verify single diagnostic event appears in both event bus and durable log.
- Trigger an executor failure — verify the error is recorded once, not twice.
- Check `runtime_events.jsonl` for no duplicate `runtime_diagnostic` entries with identical timestamps.

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
  summarizeFn?: (messages: AgentMessage[]) => Promise<string>;
}

export type CompactionMode = 'session' | 'planner_in_memory' | 'analyst_boundary';

export interface ContextCompactorDeps {
  saivageDir: string;
  sessionStamper: SessionStamper;
  projectRoot?: string;
  goalId?: string;
  cardStore?: PlannerStateCardStore;
  runtimeStateProvider?: () => RuntimeState | null;
}

export interface CompactionResult { /* same shape as current, minus module-level state */ }

export class ContextCompactor {
  private readonly stateMap = new Map<string, CompactionState>();

  constructor(private readonly deps: ContextCompactorDeps) {}

  needsCompaction(estimatedTokens: number, policy: CompactionPolicy): boolean;
  compactSession(sessionId: string, policy: CompactionPolicy): Promise<CompactionResult>;
  compactPlannerInMemory(sessionId: string, messages: AgentMessage[], role: AgentRole, policy: CompactionPolicy): AgentMessage[];
  trimOrphanToolRows(messages: AgentMessage[]): AgentMessage[];
  resetState(sessionId: string): void;
  getCompactionCount(sessionId: string): number;
}
```

#### What each mode does

- **`compactSession`**: The current `compaction.ts:compactSession` logic, but state is per-instance instead of module-level. Persists by calling `replaceSessionMessages`. Used by analyst handler.
- **`compactPlannerInMemory`**: The current `buildPlannerHistoryCompactionMessage` + `buildPlannerRecentMessageTail` + `buildPlannerStateContextMessage` logic from `agent-adapter.ts`. Returns the compacted message array. Does not persist. Used by planner invocation.
- **`trimOrphanToolRows`**: Unified boundary trimming. Merges `trimToCleanToolBoundary` (analyst-handler) and `trimLeadingOrphanToolRows` (compaction.ts). One implementation, one name. Pure function, also available as a method for convenience.

#### What gets deleted

- `compaction.ts:compactionStates` module-level Map
- `compaction.ts:getCompactionState`, `resetCompactionState`, `getCompactionCount`, `getCompactionStateForSession` as free functions (move to class methods)
- `compaction.ts:compactSession` as a free function (move to class method)
- `compaction.ts:trimLeadingOrphanToolRows` internal function (replaced by shared `trimOrphanToolRows`)
- `agent-adapter.ts:compactPlannerModelMessagesForContext` (move to class method)
- `agent-adapter.ts:buildPlannerHistoryCompactionMessage` (move to class)
- `agent-adapter.ts:buildPlannerRecentMessageTail` (move to class)
- `analyst-handler.ts:trimToCleanToolBoundary` (use `ContextCompactor.trimOrphanToolRows`)

#### What survives as canonical

- `src/agents/context-compactor.ts` — the new service module
- `compaction.ts` is deleted; its contents move to `context-compactor.ts`
- `agent-adapter.ts` loses its compaction functions entirely; `invokeAgent` receives a `ContextCompactor` instance and calls `compactor.compactPlannerInMemory(...)`
- `analyst-handler.ts` loses `trimToCleanToolBoundary`; it calls `compactor.trimOrphanToolRows(...)` and `compactor.compactSession(...)`

#### Key decisions

- **Per-instance state, not module-level.** The `ContextCompactor` is constructed per-project and owned by the runtime composition. No more interleaved-async global Map.
- **Clean re-export from `compaction.ts` for one step.** In step 4B-2, `compaction.ts` re-exports from `context-compactor.ts` to keep imports compiling. In step 4B-3, all callers are updated and `compaction.ts` is deleted.
- **Planner in-memory compaction remains in-memory.** It never writes to session files. The planner's model messages are built fresh each invocation. The `ContextCompactor.compactPlannerInMemory` method returns the compacted array without side effects.
- **Boundary trimming is a shared pure helper.** Both `compactSession` (fallback path) and the analyst handler's pre-send boundary cleanup call the same `trimOrphanToolRows`.

### Implementation Steps

**Step 4B-1:** Create `src/agents/context-compactor.ts` with the `ContextCompactor` class. Move all logic from `compaction.ts` into it (session compaction, fallback creation, boundary trimming, state tracking). Add the `compactPlannerInMemory` method that wraps the current `compactPlannerModelMessagesForContext` logic. Add the `trimOrphanToolRows` static/instance method that unifies both boundary trimming implementations. Make `compaction.ts` a thin re-export barrel that imports from `context-compactor.ts` and re-exports `compactSession` as a compatibility shim (creating a temporary instance). All existing imports continue to compile.

**Step 4B-2:** Update `agent-adapter.ts` to accept and use a `ContextCompactor` instance. Remove `compactPlannerModelMessagesForContext`, `buildPlannerHistoryCompactionMessage`, `buildPlannerRecentMessageTail`, and the planner compaction constants from `agent-adapter.ts`. The `invokeAgent` method (or its tool loop) calls `compactor.compactPlannerInMemory(...)`. Wire `ContextCompactor` construction in `runtime-composition.ts` or wherever `AgentAdapter` is constructed.

**Step 4B-3:** Update `analyst-handler.ts` to accept a `ContextCompactor` instead of calling `compactSession` and `trimToCleanToolBoundary` directly. Remove the `trimToCleanToolBoundary` export from `analyst-handler.ts`. Wire `ContextCompactor` in `AnalystHandler` construction. Delete `compaction.ts`. Update all remaining import paths.

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

Key difference: The live controller has effects (lifecycle flags, process buffering, planner context, tick request) that the offline path lacks. The offline path has validation (frozen check, unavailable check) and notification that the live path lacks.

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
  updateLifecyclePaused(paused: boolean): void;
  setProcessTerminalBuffering(enabled: boolean): void;
  applyStatePatch(patch: Partial<RuntimeState>): void;
  emitEvent(eventName: 'paused' | 'resumed'): void;
  logEvent(event: { kind: string; ... }): void;
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
3. Compute the state patch via `buildPauseRuntimeStatePatch(now())` / `buildResumeRuntimeStatePatch(state)`
4. Apply the patch through `effects.applyStatePatch(patch)`
5. Call effect hooks:
   - **Pause:** `effects.updateLifecyclePaused(true)`, `effects.setProcessTerminalBuffering(true)`, `effects.emitEvent('paused')`, `effects.logEvent({ kind: 'paused' })`, `effects.sendNotification('Runtime was paused.')`
   - **Resume:** `effects.updateLifecyclePaused(false)`, `effects.setProcessTerminalBuffering(false)`, planner context injection if active planner run, `effects.applyStatePatch(resumePatch)`, `effects.emitEvent('resumed')`, `effects.logEvent({ kind: 'resumed' })`, `effects.requestImmediateTick?.()`, `effects.sendNotification('Runtime was resumed.')`

**Live runtime** provides full effects (lifecycle, buffering, planner context, tick, notification). **Offline/API path** provides a minimal effects set that only does `applyStatePatch` + `sendNotification`. The frozen/unavailable validation is shared.

#### What gets deleted

- `control.ts:pauseRuntimeControl` function (body becomes the core validation logic in `pauseRuntimeCommand`)
- `control.ts:resumeRuntimeControl` function (body becomes the core validation logic in `resumeRuntimeCommand`)
- `runtime-pause-resume.ts:RuntimePauseResumeController` (logic moves to the effects-based command handler)
- `control.ts` file itself (re-export from `control-api.ts` pointed to `runtime-control-commands.ts`)

#### What survives as canonical

- `src/runtime/runtime-control-commands.ts` — `pauseRuntimeCommand` and `resumeRuntimeCommand` are the single authority
- `control-api.ts` re-exports `pauseRuntimeCommand`, `resumeRuntimeCommand`, and `FROZEN_RUNTIME_RECOVERY_MESSAGE`
- `buildPauseRuntimeStatePatch` / `buildResumeRuntimeStatePatch` stay in `runtime-core.ts` (shared pure functions, unchanged)

#### Callers migrate

| Current caller | Current path | Migration |
|---|---|---|
| `cli.ts` | `pauseRuntimeControl({ projectRoot })` | `pauseRuntimeCommand(projectRoot, minimalEffects)` where `minimalEffects` only does `applyStatePatch` + `sendNotification` |
| `analyst-runtime-tools.ts` | `pauseRuntimeControl({ projectRoot, runtimeApi })` | `pauseRuntimeCommand(projectRoot, runtimeEffects)` where `runtimeEffects` wraps the live controller's behavior |
| `runtime-pause-resume.ts` consumer | `controller.pause()` / `controller.resume()` | `pauseRuntimeCommand(projectRoot, fullEffects)` / `resumeRuntimeCommand(projectRoot, fullEffects)` where `fullEffects` has all hooks including lifecycle, buffering, planner context, tick |

#### Key decisions

- **Effects ports, not inheritance.** No base class or interface hierarchy. Just a bag of function callbacks. Some are optional (`injectPlannerResumeContext`, `injectQueuedPlannerNotes`, `requestImmediateTick`) because the offline path doesn't need them and they're undefined.
- **Frozen detection is shared.** The frozen/unavailable validation currently in `control.ts` is kept in the unified command handler. It's not an "effect" — it's a precondition check that always runs.
- **Notification is an effect, not inline.** The `queueNotification` call currently inlined in `control.ts` becomes `effects.sendNotification(...)`. Offline path provides it; live runtime path provides it; tests can mock it.
- **The `FROZEN_RUNTIME_RECOVERY_MESSAGE` constant moves** from `control.ts` to `runtime-control-commands.ts`.

### Implementation Steps

**Step 4C-1:** Create `src/runtime/runtime-control-commands.ts`. Copy the validation logic from `control.ts` (frozen check, unavailable check) into `pauseRuntimeCommand` and `resumeRuntimeCommand`. Define `PauseResumeEffects` interface. Implement both functions to: validate, compute patch, call effects. Make `control.ts` a thin re-export that delegates to `pauseRuntimeCommand`/`resumeRuntimeCommand` with appropriate effects wrappers (preserving exact current behavior for both offline and live paths). All callers compile unchanged.

**Step 4C-2:** Update `runtime-pause-resume.ts` to construct `PauseResumeEffects` and call `pauseRuntimeCommand`/`resumeRuntimeCommand` instead of having its own inline pause/resume logic. The `createRuntimePauseResumeController` factory returns an object whose `pause()`/`resume()` methods call the unified commands with full effects. Update the runtime composition layer that creates the controller.

**Step 4C-3:** Update `cli.ts` and `analyst-runtime-tools.ts` to call `pauseRuntimeCommand`/`resumeRuntimeCommand` directly with their respective effects. For CLI: construct `minimalEffects` that only does `applyStatePatch` + `sendNotification`. For analyst tools: construct effects that wrap `runtimeApi` (which calls `controller.pause()/resume()` under the hood, which itself uses full effects). Delete `control.ts`. Update `control-api.ts` to re-export from `runtime-control-commands.ts`.

### Validation

```bash
npm run validate:routine
npm test
```

**Manual checks:**
- CLI pause/resume works: `SAIVAGE_API_TOKEN=test node dist/src/cli.js pause --project-root ...`
- Analyst pause/resume tool works through the web UI
- Live runtime pause/resume preserves lifecycle flags, planner context injection, and tick request
- Frozen runtime rejects resume with actionable error
- Uninitialized runtime rejects pause with actionable error

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

export interface ToolDispatchResult {
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
  toolCallIdPrefix?: string;
}

export interface ToolDispatchAdapter {
  category: string;
  handles(toolName: string): boolean;
  dispatch(envelope: ToolCallEnvelope, context: ToolDispatchContext): Promise<ToolDispatchResult>;
}

export interface ToolDispatchPolicy {
  maxResultLength: number;
  persistToolCalls: boolean;
  persistToolResults: boolean;
}

export class ToolDispatcher {
  private readonly adapters: ToolDispatchAdapter[];
  private readonly policy: ToolDispatchPolicy;
  private readonly persistence: ToolDispatchPersistence | null;

  constructor(config: {
    adapters: ToolDispatchAdapter[];
    policy?: Partial<ToolDispatchPolicy>;
    persistence?: ToolDispatchPersistence;
  });

  async dispatch(envelope: ToolCallEnvelope, context: ToolDispatchContext): Promise<ToolDispatchResult>;
}
```

**Registered adapter categories:**
- **`runtime`** — wraps the current `ToolRuntime` invocation from `agent-tool-executor.ts`
- **`planner-control`** — wraps `PlannerControlExecutor` with its domain-specific logic preserved intact
- **`mcp`** — wraps MCP tool invocation
- **`skill`** — wraps skill loading
- **`workspace`** — wraps workspace tool invocation
- **`analyst`** — wraps the analyst `TOOL_REGISTRY` lookup

#### What the ToolDispatcher owns

- **Argument parsing**: `JSON.parse(envelope.arguments)` with error handling
- **Policy check**: `RoleToolPolicy.decide(...)` for every tool call
- **Result envelope construction**: consistent `{ kind, content, tool, tool_call_id }` shape
- **Truncation**: unified `maxResultLength` policy (default 16K, configurable)
- **Error formatting**: consistent envelope for parse errors, unknown tools, policy denials
- **Persistence hooks**: optional `persistToolCall` / `persistToolResult` on the `ToolDispatchPersistence` interface

#### What each adapter owns

- **`PlannerControlAdapter`**: owns `PlannerToolsService` creation, direct-child validation, planner-specific argument semantics. Returns domain-specific result objects. The adapter wraps `PlannerControlExecutor.execute()` and returns `ToolDispatchResult`. Planner-control semantics (card mutations, notifications) are entirely within the adapter.
- **`RuntimeToolAdapter`**: owns `ToolRuntime` invocation, role filtering.
- **`McpAdapter`**: owns MCP server discovery, invocation, content supervision.
- **`SkillAdapter`**: owns skill loading logic.
- **`WorkspaceAdapter`**: owns workspace tool invocation.
- **`AnalystAdapter`**: owns `TOOL_REGISTRY` lookup and analyst-specific tool context construction.

#### What gets deleted

- `analyst-handler.ts`: inline tool dispatch loop (lines 272-368). The loop body that parses args, looks up `TOOL_REGISTRY`, calls the function, formats result, truncates, persists, and broadcasts. All of this moves to the `AnalystAdapter` and `ToolDispatcher`.
- `analyst-handler.ts`: `TOOL_REGISTRY` import and direct usage. The `AnalystAdapter` encapsulates it.
- `analyst-handler.ts`: `findRecentDuplicateResponse` dedup check. This moves to the analyst handler's outer loop or is handled as a pre-dispatch concern.
- `agent-tool-executor.ts:processToolCall` method. The `AgentToolExecutor` class becomes a thin composition that constructs a `ToolDispatcher` with the right adapters.
- `planner-control-executor.ts:execute` is called from inside the `PlannerControlAdapter`, not from `processToolCall` directly. The `PlannerControlExecutor` class itself is preserved; only the dispatch envelope cruft around it is removed.

#### What survives as canonical

- `src/agents/tool-dispatcher.ts` — the `ToolDispatcher` class with pluggable adapters
- `src/agents/planner-control-executor.ts` — preserved as the domain-specific handler, but called through the `PlannerControlAdapter`
- `src/agents/agent-tool-executor.ts` — refactored to delegate to `ToolDispatcher`
- `src/agents/analyst-handler.ts` — loses its tool loop, keeps the outer LLM call loop

#### Key decisions

- **Planner-control is not "just another tool".** Its handler has domain semantics (direct-child validation, card mutation side effects, reviewer invocation). The adapter pattern preserves this. The dispatcher handles envelope concerns; the adapter handles domain logic.
- **Truncation is a dispatcher policy, not per-path logic.** The 16K char limit in the analyst handler becomes the default `maxResultLength` in `ToolDispatchPolicy`. All paths use the same truncation rule. Planner-control results that need to be longer get a category-specific override.
- **Policy checking is unified.** Every tool call goes through `RoleToolPolicy.decide(...)` in the dispatcher. The analyst handler currently bypasses policy for analyst tools (they're on a different surface). The dispatcher accepts a `surface` parameter in context and uses it for policy routing.
- **The analyst dedup fingerprint check** is not a dispatcher concern. It's a higher-level loop concern. The analyst handler keeps it in its outer loop.
- **Session persistence of tool calls/results** is a `ToolDispatchPersistence` interface: `{ persistToolCall(sessionId, msg): void; persistToolResult(sessionId, msg): void; }`. The analyst handler provides one implementation; the agent adapter provides another.

### Implementation Steps

**Step 4D-1:** Create `src/agents/tool-dispatcher.ts` with `ToolDispatcher`, `ToolDispatchAdapter`, `ToolCallEnvelope`, `ToolDispatchResult`, `ToolDispatchContext`, `ToolDispatchPolicy`, and `ToolDispatchPersistence`. Implement the `dispatch` method: parse arguments, run policy check, find matching adapter, call adapter, truncate result, call persistence hooks, return result. Create adapter registrations for each category. Do not yet remove any existing code — just add the new module with exports.

**Step 4D-2:** Create adapter implementations: `PlannerControlAdapter`, `RuntimeToolAdapter` (wrapping `ToolRuntime`), `McpAdapter`, `SkillAdapter`, `WorkspaceAdapter`, `AnalystAdapter`. Each wraps its existing domain logic. Wire `AgentToolExecutor` to construct a `ToolDispatcher` with runtime, planner-control, MCP, skill, and workspace adapters. Add a compatibility method `processToolCall(tc, role, sessionId, invocation)` on `AgentToolExecutor` that delegates to `dispatcher.dispatch(...)`. All existing callers compile unchanged. Test with `npm test`.

**Step 4D-3:** Refactor `analyst-handler.ts` to use the `ToolDispatcher` with the `AnalystAdapter`. Replace the inline tool dispatch loop in `runAnalystLoop` with: (1) parse LLM result, (2) for each tool call, call `dispatcher.dispatch(...)`, (3) persist results. Move `findRecentDuplicateResponse` out of the loop concern. Wire `ToolDispatchPersistence` for analyst session persistence. Remove `TOOL_REGISTRY` import from `analyst-handler.ts` (moved into `AnalystAdapter`).

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
- Tool result truncation at 16K chars applies uniformly
- Tool call persistence works for both agent and analyst sessions

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

export interface InvocationResult {
  kind: 'message' | 'tool_calls';
  content?: string;
  tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }>;
  usedCandidate?: Candidate;
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

export class InvocationService {
  private readonly llmGateway: AgentLlmInvocationGateway;

  constructor(config: InvocationServiceConfig);

  async resolveCandidates(role: AgentRole, capabilityRequest: CapabilityRequest): Promise<Candidate[]>;
  async invokeCall(request: InvocationRequest, candidate: Candidate): Promise<LlmCompleteResult>;
  async invokeWithRecovery(request: InvocationRequest): Promise<InvocationResult>;
}
```

#### How both paths use it

**Agent path (`AgentAdapter.invokeAgent`):**
- Calls `invocationService.resolveCandidates(role, capabilityRequest)` for the candidate chain
- In the `AgentLoopDriver` turn body, calls `invocationService.invokeCall(request, candidate)` for each individual LLM call
- Recovery logic stays in `invokeAgent` / `AgentLoopDriver` (it's agent-specific: repair budget, contract verification, multiple attempts)
- Session management, tool loop, and contract verification remain in `AgentAdapter` — those are agent-specific orchestration, not LLM transport

**Analyst path (`AnalystHandler`):**
- No more `LlmIntentResolver` class
- `AnalystHandler` calls `invocationService.invokeWithRecovery(request)` which handles the candidate chain, availability marking, and error recovery
- The analyst tool loop stays in `AnalystHandler` (it's the same pattern as the agent tool loop but with different loop control and tool dispatch)
- `AnalystHandler.runAnalystLoop` calls the invocation service for the LLM turn, then dispatches tools through `ToolDispatcher`

#### What the InvocationService owns

- **Candidate resolution**: `router.resolve(role, capabilityRequest)` and `router.getLastCapabilitySkips()`
- **LLM call execution**: `AgentLlmInvocationGateway.createLlmCallFn()` or direct `client.complete()`
- **Availability marking**: `candidateAvailability.markSucceeded/markFailed` after each call
- **Recovery on transport errors**: iterating over the candidate chain, applying `defaultInvocationRecoveryPolicy`, marking availability

#### What stays in the callers

- **Agent path**: session creation, context message building, tool loop (`AgentLoopDriver`), contract verification, planner compaction, attempt recording, retry orchestration
- **Analyst path**: tool loop orchestration, session read/write, dedup check, broadcast/emit events

#### What gets deleted

- `analyst-llm-resolver.ts` — the entire `LlmIntentResolver` class and its candidate iteration/recovery logic
- `analyst-llm-resolver.ts:TOOL_REGISTRY` — moved into `AnalystAdapter` (from sub-wave 4D)
- `analyst-llm-resolver.ts:ANALYST_SYSTEM_PROMPT`, `getAnalystSystemPrompt`, `getAnalystToolDefinitions`, `ANALYST_NO_MODEL_REPLY`, `AnalystOfflineError` — these move to `analyst-handler.ts` or a new `analyst-prompt.ts`
- `analyst-handler.ts` direct session read/write methods (`readSession`, `writeSession`, `sessionFilePath`, `sessionsDir`) — migrate to use `session-persistence.ts` functions

#### What survives as canonical

- `src/agents/invocation-service.ts` — the unified service
- `src/agents/agent-llm-gateway.ts` — preserved, used by `InvocationService`
- `src/agents/agent-adapter.ts` — simplified, delegates LLM concerns to `InvocationService`
- `src/agents/analyst-handler.ts` — simplified, uses `InvocationService` for LLM calls

#### Key decisions

- **The agent loop is NOT LLM invocation.** The `AgentLoopDriver` turn logic (contract verification, tool dispatch, repair budget) is agent-specific orchestration. It is not duplicated — it simply doesn't exist in the analyst path. What's duplicated is the LLM transport layer: resolve candidate → get client → call → handle transport error → mark availability. That's what `InvocationService` owns.
- **`invokeWithRecovery` is for the analyst.** The analyst needs a simple "try candidates, recover on failures, return result" flow. The agent needs finer control (per-attempt recovery in the loop). The service provides both: `invokeWithRecovery` for the analyst case, and `invokeCall` for individual calls that the agent loop manages.
- **No backward compat for `LlmIntentResolver`.** Delete it. `AnalystOfflineError` moves to `analyst-handler.ts` or becomes `AnalystInvocationError` in `invocation-service.ts`. The `ANALYST_NO_MODEL_REPLY` string is analyst-specific and stays in the analyst handler.
- **Session management unification is out of scope for this wave.** The analyst's `readSession`/`writeSession` and `getOrCreateAnalystSession` use different file paths and schema than `session-persistence.ts`. They can be unified later (Wave 5 or 6). For now, the analyst handler keeps its session methods but delegates LLM call orchestration to `InvocationService`.

### Implementation Steps

**Step 4E-1:** Create `src/agents/invocation-service.ts` with `InvocationService`. Extract the LLM transport orchestration that's currently in `LlmIntentResolver.chat` (candidate chain iteration, availability marking, gateway call) and the same pattern from `AgentAdapter.invokeAgent` (the inner candidate loop portion). The service provides `resolveCandidates` and `invokeCall` (single candidate) and `invokeWithRecovery` (full chain). Wire `InvocationService` construction in `runtime-composition.ts` or `AgentAdapter` constructor. Do not yet remove `LlmIntentResolver`. All existing callers compile.

**Step 4E-2:** Refactor `AgentAdapter.invokeAgent` to use `InvocationService` for candidate resolution and individual LLM calls. Replace the inline `this.router.resolve(...)` + `for (const candidate of candidateChain)` loop with `invocationService.resolveCandidates(...)` and `invocationService.invokeCall(...)`. The `AgentLoopDriver` turn body still constructs turn messages and calls `this.llmCallFn`, but `llmCallFn` now delegates to `invocationService.invokeCall` instead of `AgentLlmInvocationGateway` directly. Keep `AgentLlmInvocationGateway` as the underlying transport.

**Step 4E-3:** Refactor `AnalystHandler` to use `InvocationService.invokeWithRecovery` for LLM calls. Remove the `LlmIntentResolver` dependency. Move analyst-specific concerns (`ANALYST_SYSTEM_PROMPT`, `getAnalystToolDefinitions`, `AnalystOfflineError`) into `AnalystHandler` or a helper module. Delete `analyst-llm-resolver.ts`. Update all imports. The `AnalystHandler` loop now: (1) compacts via `ContextCompactor`, (2) calls `invocationService.invokeWithRecovery(...)` for the LLM turn, (3) dispatches tools via `ToolDispatcher`, (4) loops if tool_calls result.

**Step 4E-4:** Clean up `AgentLlmInvocationGateway` and `AgentAdapter`. Since `InvocationService` now wraps `AgentLlmInvocationGateway`, the `AgentAdapter.llmCallFn` setter and the `llmGateway` field can be simplified. The `AgentAdapter` constructs an `InvocationService` and delegates to it. Remove the `setLlmCallFn` setter pattern. The `InvocationService` owns the gateway.

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
