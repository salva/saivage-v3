# Wave 5: Decomposition — Implementation Plan and Design

## Second Review Corrections

This section supersedes both the Reviewed Corrections and any conflicting text below.

1. **HIGH — `messageBadges` initialized as array `[]` but type is `Record<string, TimelineBadge[]>`**: The code block in 5D-2 shows `ref<Record<string, TimelineBadge[]>>([])`. Reviewed Correction #17 says `({})`. Change to `ref<Record<string, TimelineBadge[]>>({})`.
2. **HIGH — `runtimeApplication` must remain optional**: Plan line ~1179 shows `runtimeApplication: RuntimeApplication` (required). Reviewed Correction #23 says "stays optional unless callers change together." Current code has `runtimeApplication?: RuntimeApplication`. Keep optional.
3. **HIGH — `applyPatch` is shared across all command objects, not lifecycle-specific**: Step 5B-3 says "The private `applyPatch` helper moves with it" (to `CardLifecycleCommands`). Actually `applyPatch` is called from `create`, `update`, `mutateCard`, `reorderChildren`, `updateDependsOn`, `appendEvidenceRefs`, `commitTerminalLifecyclePatch`, `repairTerminalLifecycle`, and `setStatus`. It must stay on `CardStore` (or become a shared module function) accessible to all command objects via `deps`. Moving it only to `CardLifecycleCommands` breaks `EvidenceRefService`, `CardHierarchyCommands`, and `CardArchiveService`.
4. **HIGH — `CardStore` 150-line target is optimistic**: After extracting all command objects, `CardStore` still has constructor, `deps()`, `open()`, read methods, mutation delegations, history reads, shared `applyPatch`, and helper methods. Realistic target: ~200-250 lines.
5. **MEDIUM — MCP extraction naming should say SSE, not HTTP**: Plan says `http-lifecycle.ts` with `startHttpServer`. Actual method names and config use `_startSse` and `cfg.transport === 'sse'`. Call the module `sse-lifecycle.ts` or `streamable-http-lifecycle.ts` and use names consistent with the transport module.
6. **MEDIUM — `buildModelMessages` contradicts Reviewed Correction #5**: Step 5A-2 says "`buildModelMessages` becomes `SessionMessageLog.buildModelMessages()`." Correction #5 says "SessionMessageLog extracts round stamping and appends only. Model-message construction stays in an invocation-context service." No standalone `buildModelMessages` exists in current code. Remove this claim; `SessionMessageLog` owns `append()` and round-stamping only.
7. **MEDIUM — `executeActionToolCalls` is a callback, not a method**: Step 5A-4 references "In `executeActionToolCalls`." It's a callback property on `AgentLoopDriverIO` (created inline at line 907 within `invokeAgent`), not a class method. Reference it as "the `executeActionToolCalls` callback in `AgentLoopDriverIO`."
8. **MEDIUM — `discoverTools()` must be called from `start()` in `McpServerRuntime`**: Current `McpManager.startServer()` (lines 113-156) calls `_discoverTools()` automatically. `McpServerRuntime.start()` must include tool discovery, not defer it to a separate call. Make `start()` call `this.discoverTools()` internally.
9. **MEDIUM — `queueNotification` dependency for command objects**: Plan data flow shows `EvidenceRefService` uses `ApplyMutationWithOwnedLockSync + queueNotification`, but `LifecycleCommandDeps` only includes `{ projectRoot, state, projectLock, eventBus }`. Either add `queueNotification` to deps or note it's imported directly by service modules.
10. **MEDIUM — `stores/index.ts` barrel not mentioned in migration**: Step 5D-7 says "find all component files that import from old stores" but doesn't mention `web/src/stores/index.ts`. This barrel re-exports all stores and must be updated to re-export from new store files.
11. **MEDIUM — Debug `fetchState()` comes from single `/api/state` endpoint**: Plan implies separate API calls per store. `debugRuntime`, `debugCards`, `debugTotalCards` all come from one endpoint. `DebugStateStore.fetchState()` should call `/api/state` once and set all three fields.
12. **MEDIUM — `SessionMessageLog.append()` must document `appendPersistentMessage` dependency**: The plan doesn't show how `SessionMessageLog.append()` calls `appendPersistentMessage` (from `session-persistence.ts`). Document this as an import or injected function for testability.
13. **MEDIUM — AgentAdapter facade ~200 lines is optimistic**: Beyond explicit pass-throughs, the facade needs `cancelSession`, `forceCancelSession`, `getHandoffSummary`, `getActiveSessionHandoffs`, `setEventBus`, `setRuntimeLedgerEventBus`, `setActivationLedger`, `getContentSupervisor`, `getMcpManager`, `getToolNamesForRole`, `callMcpTool`, `getSafeFileContent`. Realistic target: ~300-350 lines.
14. **MEDIUM — `PATTERNS_BY_CATEGORY` also needs lazy init (Wave 6 F29)**: Not a Wave 5 issue per se, but if Wave 6 makes `COMPILED_PATTERNS` lazy, `PATTERNS_BY_CATEGORY` (also eagerly built) must also become lazy or be derived from `PATTERN_DEFS`.
15. **LOW — F13 "seven Map/Set fields" is actually eight**: `handles`, `statusOverrides`, `startedAt`, `toolsCache`, `argumentValidatorCache`, `toolsCacheInitialized` (Set), `discoveryErrors`, `_invocationQueues`. Plan Step 5C-2 correctly lists 8; the F13 issue description undercounts.

## Reviewed Corrections

This section supersedes any conflicting text below.

1. This plan is valid only after Waves 2 and 4 have landed. Verify actual seams before starting; otherwise stop and finish missing waves.
2. 5A requires Wave 4 seams. 5B, 5C, 5D, and 5E may proceed first or in parallel.
3. `InvocationRunnerConfig` uses `attemptRecorderFactory`, not a singleton. It must receive every behavior still needed by invocation after Wave 4.
4. Keep `AgentSessionCoordinator` owner of cancellation, notification injection, handoff summaries, and session-start publication. New lifecycle wrapper covers persistence only.
5. `SessionMessageLog` extracts round stamping and appends only. Model-message construction stays in an invocation-context service and preserves `model_spec`/`requested_model_spec`.
6. `AttemptRecorder` is per-invocation and records attempts plus contract outcome (`repairAttempts`, `verdict`).
7. `PlannerEnvelopeTracker` parses accepted tool results and preserves pending envelope on parse failure/unsupported status.
8. Do not add JSDoc noise to facades.
9. Extract `CardPatchService` before card command objects; lifecycle/hierarchy/evidence services call it.
10. Use one `CardStoreDeps` with project root, max depth, state, lock, event bus, and helper ports; avoid stale snapshots.
11. `EvidenceRefService.appendEvidenceRefs()` preserves owned-lock flow and emits history events after lock release.
12. Leave history reads on `CardStore` in Wave 5.
13. `McpServerRuntime` uses `currentPhase` field plus `phase` getter.
14. MCP migration starts with a working wrapper, then moves one transport, then the other, then removes old maps.
15. Do not add transport lifecycle wrapper modules; call existing transport functions.
16. Preserve `McpManager.setEventLogger()`, `next()`, shared message ID source, and stats shape.
17. Frontend `messageBadges` initializes as `{}`.
18. Avoid cyclic analyst store dependencies; WebSocket ingest is an orchestrator/root store.
19. No long-lived compatibility facades; update imports in same commit or keep old file canonical.
20. Debug split needs composed read model for combined errors and sorted timeline.
21. Card split needs one freshness/stale-notification owner.
22. Do not extract `LiveSyncHandler` as a class; keep inline or a plain helper.
23. `runtimeApplication` stays optional in analyst WS handler unless callers change together.
24. Inject outbound sinks into analyst WS handler.
25. Specify `parseRawMessage(raw: Buffer | ArrayBuffer | Buffer[]): string`.
26. Tool activity projection preserves primitive/array data as sanitized unknown.
27. Validation: focused tests first, then routine; store decomposition runs `npm run validate:ui` before smoke.

Generated: 2026-06-06

## Prerequisites (Completed in Earlier Waves)

This wave assumes Waves 2 and 4 are complete:

- **Wave 2 (Card Data Model):** `CardStoreState` is the authoritative in-memory read model. Read methods no longer call `refreshState()`. Mutations update state after durable writes. `deepClone` on reads is removed; card records are immutable at the type level. ID generation is inside the locked mutation (ULID/random source), no scan.
- **Wave 4 (Path Unification):**
  - F02: A shared `AgentInvocationService` owns candidate iteration, recovery, recording, and turn loop. The analyst LLM resolver is deleted. Analyst session handling uses shared session persistence.
  - F10: A `ToolDispatcher` owns parsing, policy check, result envelope, truncation, persistence hooks, and error formatting. Tool call dispatch in `invokeAgent` delegates to the `ToolDispatcher`.
  - F23: A `ContextCompactor` service owns per-session compaction, boundary trimming, and planner-specific context serialization. `compactPlannerModelMessagesForContext`, `buildPlannerHistoryCompactionMessage`, `buildPlannerRecentMessageTail`, and the planner history constants are extracted from `agent-adapter.ts`.
  - F35: A unified `publishRuntimeDiagnostic` owns both event-bus emission and durable logging. Callers provide one diagnostic object once; no separate `emit` + `appendEvent` pairs.
  - F20: One `RuntimeControlCommand` handler computes patches for pause/resume. The runtime calls a single command handler.

These changes mean `invokeAgent` is already shorter and simpler than the current 610-line method. The seams below refer to the post-Wave-4 method, noting which parts are already gone.

---

## Sub-wave Ordering

| Sub-wave | Issue | Target | Estimated Complexity |
|----------|-------|--------|---------------------|
| 5A | F01 | AgentAdapter decomposition | HIGHEST |
| 5B | F04 | CardStore decomposition | HIGH |
| 5C | F13 | MCP Manager decomposition | MEDIUM |
| 5D | F14+F22 | Frontend store decomposition | MEDIUM |
| 5E | F11 | WebSocket handler decomposition | MEDIUM |

Sub-waves 5B–5E have no hard dependency on each other and can proceed in parallel after 5A. Sub-wave 5A should complete first because the AgentAdapter decomposition removes the most tangled code and makes the runtime composition layer cleaner.

---

## 5A: AgentAdapter Decomposition (F01)

### Current State (Pre-Wave 5)

`AgentAdapter` (1340 lines) holds:
- Constructor with extensive wiring (lines 287–376)
- Setter injection: `setLlmCallFn`, `setContentSupervisor`, `setMcpManager`, `setSkillsEngine`, `setAfterSessionCreatedHook` (lines 388–411)
- Planner-specific compaction functions (lines 124–258) — **already extracted to `ContextCompactor` in Wave 4**
- `synthesizeReportGoalEnvelope` (lines 124–155) — planner-specific terminal envelope synthesis
- `invokePlanner`, `invokeExecutor`, `invokeReviewer`, `reinvokeSession` — thin wrappers delegating to `invokeAgent` (lines 450–601)
- Private helpers: `processToolCall`, `buildModelMessages`, `nextFallbackRound`, `stampInCurrentFallbackRound`, `appendSessionMessage`, `compensateActivationBarrierThrow` (lines 603–710)
- `invokeAgent` core (lines 712–1321) — the method to decompose

### Post-Wave-4 State (What invokeAgent Looks Like)

After Wave 4 extractions:
- Compaction logic (`compactPlannerModelMessagesForContext` etc.) → `ContextCompactor`
- Tool dispatch → `ToolDispatcher`
- Diagnostic publishing → unified `publishRuntimeDiagnostic`
- Analyst LLM resolution → deleted (merged into shared `AgentInvocationService`)

The remaining `invokeAgent` will be roughly 400–500 lines. It still handles: candidate resolution, session creation, outer recovery loop, inner candidate iteration, message persistence, contract verification loop coordination, planner envelope tracking, activation barrier, attempt recording, session finalization, and the summary verdict.

### Seams in invokeAgent (Post-Wave-4)

| Seam | Lines (approximate) | Responsibility | Extracted to |
|------|---------------------|----------------|-------------|
| S1: Session creation & notification | 746–760 | `createSession`, `notifySessionCreated`, `publishSessionStarted` | `AgentSessionLifecycle` |
| S2: Context message persistence | 761–775 | Append context messages to session | `SessionMessageLog` |
| S3: Recovery config & counters | 776–792 | `recoveryDelayMs`, `maxRecoveryRetries`, `maxOuterAttempts`, `invocationStart`, attempt counters | `InvocationContext` (data) |
| S4: Attempt recording | 786–792 + 1063–1082 + 1162–1181 | `recordAttemptOutcome`, event emission | `AttemptRecorder` |
| S5: Outer recovery loop | 1211–1257 | `for (let attempt...)` + catch/retry + event emission | `AgentInvocationRunner.run()` |
| S6: Inner candidate iteration | 813–1208 | `for (candidate of candidateChain)` + same-candidate retry | `AgentInvocationRunner.run()` inner loop |
| S7: LLM call & contract verification | 841–1027 | `AgentLoopDriver` instantiation + `driver.run()` | Stays in `AgentInvocationRunner` (delegation to `AgentLoopDriver`) |
| S8: Session message persistence | 831–899 + 968–1001 | `appendSessionMessage` calls inside loop | `SessionMessageLog` |
| S9: Planner envelope tracking | 915–966 | `pendingPlannerRuntimeEnvelope`, `synthesizeReportGoalEnvelope` | `PlannerEnvelopeTracker` |
| S10: Activation barrier | 915–933 | `markSessionWaiting`, `activationBarrier.dispatch`, `compensateActivationBarrierThrow` | Stays inline (activation-specific) |
| S11: Post-invocation summary | 1258–1321 | Verdict computation, session completion, event emission | `AgentInvocationRunner` finalization |
| S12: Getter pass-throughs | 1323–1340 | `getRouter`, `getRegistry`, `getCandidateAvailability`, `flushRecorders`, `createLlmCallFn` | `AgentAdapter` facade |

### New Module Structure

#### `src/agents/invocation-runner.ts` — `AgentInvocationRunner`

Owns the outer recovery loop, inner candidate iteration, contract verification coordination, and post-invocation summary.

```typescript
export interface InvocationRunnerConfig {
  projectRoot: string;
  saivageDir: string;
  runtimeConfig: RuntimeSection;
  router: ModelRouter;
  candidateAvailability: CandidateAvailability;
  sessionLifecycle: AgentSessionLifecycle;
  attemptRecorder: AttemptRecorder;
  messageLog: SessionMessageLog;
  envelopeTracker?: PlannerEnvelopeTracker;
  toolDispatcher: ToolDispatcher;       // from Wave 4
  contextCompactor: ContextCompactor;   // from Wave 4
  contractVerifierFactory: () => ContractVerifier;
  loopDriverFactory: typeof createAgentLoopDriver;
  recoveryPolicy: InvocationRecoveryPolicy;
}

export class AgentInvocationRunner {
  constructor(private readonly config: InvocationRunnerConfig) {}

  async invoke<E, R>(
    role: AgentRole,
    goalId: string,
    cardId: string,
    systemPrompt: string,
    contextMessages: AgentMessage[],
    contract: Contract<E, R>,
    requestedSessionId?: string,
    activationBarrier?: PlannerActivationBarrier,
  ): Promise<R>;
}
```

The `invoke` method contains:
1. Candidate resolution, loop entry
2. Session creation via `AgentSessionLifecycle`
3. Context message persistence via `SessionMessageLog`
4. Outer `for (attempt...)` loop
5. Inner `for (candidate of candidateChain)` loop with same-candidate retry
6. LLM call delegation to `AgentLoopDriver`
7. Planner envelope tracking via `PlannerEnvelopeTracker` (planner role only)
8. Activation barrier handling (inline, activation-specific, small)
9. Attempt recording via `AttemptRecorder`
10. Session finalization via `AgentSessionLifecycle`
11. Verdict computation and event emission

#### `src/agents/session-lifecycle.ts` — `AgentSessionLifecycle`

Owns session creation, status transitions, cancellation, and abort tracking.

```typescript
export class AgentSessionLifecycle {
  constructor(
    private readonly saivageDir: string,
    private readonly coordinator: AgentSessionCoordinator,
    private readonly eventBus?: EventEmitter,
  ) {}

  createSession(role: AgentRole, goalId: string, cardId: string, requestedSessionId?: string): import('../schemas/types').AgentSession;
  notifyCreated(sessionId: string): Promise<void>;
  publishStarted(sessionId: string, role: AgentRole, goalId: string, cardId: string): void;
  markWaiting(sessionId: string): void;
  complete(sessionId: string, outcome: 'done' | 'blocked' | 'failed'): void;
  cancel(sessionId: string): boolean;
  isCancelled(sessionId: string): boolean;
  trackAbortController(sessionId: string, controller: AbortController): void;
  clearAbortController(sessionId: string): void;
  clearCancellation(sessionId: string): void;
}
```

Absorbs the current `AgentSessionCoordinator` methods that are called from invokeAgent. The coordinator itself may become an implementation detail of the lifecycle.

#### `src/agents/attempt-recorder.ts` — `AttemptRecorder`

Owns attempt outcome tracking and event emission.

```typescript
export class AttemptRecorder {
  private attemptOutcomeCount = 0;
  private lastSucceededPayload?: LlmAttemptPayload;
  private lastFailedFailureClass?: LlmFailureClass;
  private lastRepairAttempts = 0;
  private lastContractVerdict?: 'satisfied' | 'repair_exhausted' | 'no_progress';

  constructor(
    private readonly eventBus?: EventEmitter,
    private readonly eventLogger?: EventLogger,
  ) {}

  recordOutcome(payload: LlmAttemptPayload): void;
  getOutcomeCount(): number;
  getLastSucceeded(): LlmAttemptPayload | undefined;
  getLastFailedClass(): LlmFailureClass | undefined;
  getRepairAttempts(): number;
  getContractVerdict(): string | undefined;
  reset(): void;
}
```

Each invocation creates a fresh `AttemptRecorder` instance (no cross-invocation state leakage).

#### `src/agents/session-message-log.ts` — `SessionMessageLog`

Owns message persistence and round tracking for a session.

```typescript
export class SessionMessageLog {
  private readonly fallbackCurrentRoundId = new Map<string, string>();
  private readonly fallbackBlockCounters = new Map<string, number>();

  constructor(
    private readonly saivageDir: string,
  ) {}

  append(sessionId: string, message: MessageAppendInput): void;
  buildModelMessages(sessionId: string, role?: AgentRole, goalId?: string): AgentMessage[];
  nextFallbackRound(sessionId: string, prefix: 'pre' | 'user' | 'assistant' | 'diagnostic'): RoundStamp;
}
```

`MessageAppendInput` is a simplified type for the `{ role, kind, content, tool?, tool_call_id?, links? }` shape currently passed to `appendPersistentMessage` inline. `SessionMessageLog` handles round-id generation and block counting internally.

#### `src/agents/planner-envelope-tracker.ts` — `PlannerEnvelopeTracker`

Owns the planner-specific terminal envelope synthesis and state tracking for one invocation.

```typescript
export class PlannerEnvelopeTracker {
  private pendingEnvelope: PlannerEnvelope | null = null;

  trackTerminalToolResult(toolName: string, goalId: string, resultContent: string): void;
  takeEnvelope<E>(): E | null;
  static synthesizeReportGoalEnvelope(
    toolName: string,
    goalId: string,
    status: string | undefined,
  ): { kind: 'result'; payload: PlannerResultEnvelope } | null;
}
```

The existing `synthesizeReportGoalEnvelope` function moves here. The `pendingPlannerRuntimeEnvelope` mutable state that was a closure variable in `invokeAgent` becomes `this.pendingEnvelope`. The `takeRuntimeDoneEnvelope` callback in `AgentLoopDriverIO` becomes `() => this.tracker.takeEnvelope()`.

#### What Remains in `AgentAdapter` (Facade)

After decomposition, `AgentAdapter` becomes a thin facade:

```typescript
export class AgentAdapter implements AgentExecutionPort {
  readonly projectRoot: string;
  readonly saivageDir: string;
  readonly config: SaivageConfig;
  readonly runtimeConfig: RuntimeSection;
  readonly registry: ProviderRegistry;
  readonly router: ModelRouter;
  readonly candidateAvailability: CandidateAvailability;
  readonly notificationCenter: NotificationCenter;

  private readonly invocationRunner: AgentInvocationRunner;
  private readonly sessionLifecycle: AgentSessionLifecycle;
  private readonly messageLog: SessionMessageLog;
  // ... remaining setter-injection fields until F26 (Wave 6)

  constructor(cfg: AgentAdapterConfig) {
    // Wire up all modules
    this.sessionLifecycle = new AgentSessionLifecycle(cfg.saivageDir, ...);
    this.messageLog = new SessionMessageLog(cfg.saivageDir);
    const attemptRecorderFactory = () => new AttemptRecorder(this.eventBus, this.eventLogger);
    this.invocationRunner = new AgentInvocationRunner({
      projectRoot: cfg.projectRoot,
      saivageDir: cfg.saivageDir,
      runtimeConfig: getRuntimeConfig(cfg.config),
      router: this.router,
      candidateAvailability: this.candidateAvailability,
      sessionLifecycle: this.sessionLifecycle,
      attemptRecorderFactory,
      messageLog: this.messageLog,
      toolDispatcher: /* from Wave 4 */,
      contextCompactor: /* from Wave 4 */,
      ...
    });
  }

  // Delegation methods:
  async invokePlanner(requestOrGoalId, ...): Promise<PlannerResult> { return this.invocationRunner.invoke(...); }
  async invokeExecutor(requestOrCardId, ...): Promise<ExecutorResult> { return this.invocationRunner.invoke(...); }
  async invokeReviewer(requestOrGoalId, ...): Promise<ReviewerResult> { return this.invocationRunner.invoke(...); }
  async reinvokeSession(request): Promise<ExecutorResult | ReviewerResult> { ... }

  // Pass-through accessors:
  getRouter(): ModelRouter { return this.router; }
  getRegistry(): ProviderRegistry { return this.registry; }
  getCandidateAvailability(): CandidateAvailability { return this.candidateAvailability; }
  async flushRecorders(): Promise<void> { ... }
  createLlmCallFn(): LlmCallFn { ... }

  // Setter injection (until F26 in Wave 6):
  setLlmCallFn(fn: LlmCallFn): void { ... }
  setContentSupervisor(supervisor: ContentSupervisor): void { ... }
  setMcpManager(mcpManager: McpToolInvocationPort): void { ... }
  setSkillsEngine(engine: SkillsEngine): void { ... }
  setAfterSessionCreatedHook(hook: SessionCreatedHook | null): void { ... }
}
```

Target final size: ~200 lines.

### Data Flow

```
AgentAdapter (facade)
  ├── AgentInvocationRunner.run()
  │     ├── resolves candidates via ModelRouter
  │     ├── AgentSessionLifecycle.createSession()
  │     ├── SessionMessageLog.append() for context messages
  │     ├── AttemptRecorder.recordOutcome() for each LLM call
  │     ├── PlannerEnvelopeTracker (planner role only)
  │     │     ├── trackTerminalToolResult()
  │     │     └── takeEnvelope() → AgentLoopDriverIO.takeRuntimeDoneEnvelope
  │     ├── AgentLoopDriver.run() for contract verification loop
  │     ├── AgentSessionLifecycle.complete() for session finalization
  │     └── Publishes summary events
  ├── AgentSessionLifecycle
  │     ├── creates/persists session
  │     ├── notifies via AgentSessionCoordinator
  │     └── transitions session status: waiting → active → done/blocked/failed
  ├── AttemptRecorder
  │     └── records outcomes, emits to event bus + event logger
  ├── SessionMessageLog
  │     └── appends messages, manages round IDs, builds model messages
  └── PlannerEnvelopeTracker (planner-role only)
        └── synthesizeReportGoalEnvelope → takeEnvelope
```

### Step-by-Step Implementation Sequence (5A)

Each step is a minimal compilable commit.

#### Step 5A-1: Extract `AttemptRecorder`

- Create `src/agents/attempt-recorder.ts` with the `AttemptRecorder` class.
- Replace the inline `recordAttemptOutcome` closure in `invokeAgent` with an `AttemptRecorder` instance.
- Wire the recorder in `invokeAgent` via `new AttemptRecorder(this.eventBus, this.eventLogger)`.
- Update attemptOutcome/lastSucceeded/lastFailed references to use `recorder.getLastSucceeded()` etc.
- **Validation:** `npm run validate:routine`, `npm test`. All existing tests pass; no behavior change.

#### Step 5A-2: Extract `SessionMessageLog`

- Create `src/agents/session-message-log.ts` with the `SessionMessageLog` class.
- Move `appendSessionMessage`, `nextFallbackRound`, `stampInCurrentFallbackRound`, `fallbackCurrentRoundId`, `fallbackBlockCounters` from `AgentAdapter` to `SessionMessageLog`.
- `AgentAdapter` holds a `messageLog` field and delegates.
- `buildModelMessages` becomes `SessionMessageLog.buildModelMessages()`, which calls `ContextCompactor` (from Wave 4) internally.
- **Validation:** `npm run validate:routine`, `npm test`.

#### Step 5A-3: Extract `AgentSessionLifecycle`

- Create `src/agents/session-lifecycle.ts` with the `AgentSessionLifecycle` class.
- Move `createSession`/`completeSession`/`markSessionWaiting`/`setSessionStatus`/`updateSessionModel` calls, cancellation tracking (`cancelSession`, `forceCancelSession`, `isCancelled`, `trackAbortController`, `clearAbortController`, `clearCancellation`), and session notification (`notifySessionCreated`, `publishSessionStarted`, `publishCancelledRetryStop`) into the lifecycle class.
- The lifecycle wraps `AgentSessionCoordinator` (which remains as a low-level coordinator for cancellation/abort-tracking), or absorbs it entirely if the coordinator is thin enough.
- **Validation:** `npm run validate:routine`, `npm test`. Integration: verify planner, executor, and reviewer invocations still create and complete sessions correctly.

#### Step 5A-4: Extract `PlannerEnvelopeTracker`

- Create `src/agents/planner-envelope-tracker.ts` with `PlannerEnvelopeTracker` class and move `synthesizeReportGoalEnvelope` into it.
- In `invokeAgent`, replace the `pendingPlannerRuntimeEnvelope` mutable closure variable with a tracker instance scoped to the invocation.
- The `takeRuntimeDoneEnvelope` callback becomes `() => tracker.takeEnvelope()`.
- In `executeActionToolCalls`, when `role === 'planner'` and a terminal tool is detected, call `tracker.trackTerminalToolResult(toolName, goalId, msg.content)`.
- **Validation:** `npm run validate:routine`, `npm test`. Planner invocations must still create terminal envelopes correctly.

#### Step 5A-5: Extract `AgentInvocationRunner`

- Create `src/agents/invocation-runner.ts` with `AgentInvocationRunner`.
- Move the core of `invokeAgent` (the outer recovery loop, inner candidate iteration, and finalization) into `AgentInvocationRunner.invoke()`.
- The runner takes `InvocationRunnerConfig` containing all dependencies: router, candidateAvailability, sessionLifecycle, attemptRecorderFactory, messageLog, toolDispatcher, contextCompactor, contractVerifier factory, loopDriver factory, recoveryPolicy, and config.
- `AgentAdapter.invokeAgent` becomes `return this.invocationRunner.invoke(...)` plus `PlannerEnvelopeTracker` creation for planner role.
- Thin delegation wrappers `invokePlanner`, `invokeExecutor`, `invokeReviewer` remain on `AgentAdapter` for API compatibility.
- **Validation:** `npm run validate:routine`, `npm test`. Full integration test: planner loop, executor tool calls, reviewer assessment. Manual: invoke each role end-to-end.

#### Step 5A-6: Clean up `AgentAdapter` facade

- Remove all extracted methods from `AgentAdapter`.
- Verify `AgentAdapter` is now < 250 lines: config, construction, setter injection, thin invoke* delegations, pass-through accessors.
- Remove unused imports.
- Add JSDoc to facade pointing to new modules.
- **Validation:** `npm run validate:routine`, `npm test`, line count check on `agent-adapter.ts`.

---

## 5B: CardStore Decomposition (F04)

### Current State

`CardStore` (750 lines) handles: boot recovery, read APIs, creation/validation, evidence refs and notification queuing, lifecycle status construction, deletion, subtree archive/delete, compaction internals, and patch persistence.

After Wave 2:
- Reads no longer call `refreshState()`.
- `deepClone` on reads is removed (records are immutable).
- ID generation uses ULID/random source, not `generateId` scan.
- `CardStoreState` is the authoritative read model.

### New Module Structure

#### `src/cards/reader.ts` — `CardReader`

Pure read queries against `CardStoreState`. No mutations, no I/O.

```typescript
export class CardReader {
  constructor(private readonly state: CardStoreState) {}

  read(id: string): CardRecord | null;
  list(): CardRecord[];
  listChildren(parentId: string): string[];
  getParent(id: string): string | null;
  getAncestors(id: string): string[];
  isDescendantOf(id: string, ancestorId: string): boolean;
  getDescendantIds(id: string): string[];
  detectCycles(id: string, newDependsOn: string[]): string[];
  canTransition(from: CardStatus, to: CardStatus): boolean;
}
```

History queries (`listCardHistory`, `getCardAt`, `diffCard`) remain on `CardStore` because they read from disk (JSONL files) and don't depend on in-memory state.

#### `src/cards/lifecycle-commands.ts` — `CardLifecycleCommands`

Status transitions and creation.

```typescript
export interface LifecycleCommandDeps {
  projectRoot: string;
  state: CardStoreState;
  projectLock: ProjectLock;
  eventBus: EventBus;
}

export class CardLifecycleCommands {
  constructor(private readonly deps: LifecycleCommandDeps) {}

  create(input: NewCardInput): CardRecord;
  setStatus(id: string, newStatus: CardStatus): CardRecord;
  update(id: string, changes: Partial<CardRecord>): CardRecord;
  mutateCard(id: string, changes: Partial<CardRecord>, ctx: CardMutationContext): CardRecord;
  commitTerminalLifecyclePatch(id: string, changes: Partial<CardRecord>): CardRecord;
  repairTerminalLifecycle(id: string, changes: Partial<CardRecord>): CardRecord;
}
```

`setStatus` currently constructs lifecycle objects inline (lines 525–588). Move the lifecycle construction cases to `lifecycle.ts` as `buildSetStatusLifecycle(card, newStatus)` or discriminated-union helpers.

#### `src/cards/hierarchy-commands.ts` — `CardHierarchyCommands`

Hierarchy operations that modify parent/child relationships.

```typescript
export class CardHierarchyCommands {
  constructor(private readonly deps: LifecycleCommandDeps) {}

  reorderChildren(parentId: string, orderedChildIds: string[], ctx: CardMutationContext): ReorderChildrenResult;
  updateDependsOn(id: string, newDependsOn: string[], ctx?: CardMutationContext): CardRecord;
}
```

#### `src/cards/archive-service.ts` — `CardArchiveService`

Archive, deletion, and subtree operations.

```typescript
export class CardArchiveService {
  constructor(private readonly deps: LifecycleCommandDeps) {}

  delete(id: string): void;
  archiveAndDeleteSubtree(ids: string[]): void;
}
```

The `projectedCompactionOps` helper becomes a private method of `CardArchiveService`. The `archiveCardPath` helper and `writeFileSyncDurable` for archive payload move here.

#### `src/cards/evidence-ref-service.ts` — `EvidenceRefService`

Evidence ref attachment and notification.

```typescript
export class EvidenceRefService {
  constructor(private readonly deps: LifecycleCommandDeps) {}

  appendEvidenceRefs(
    id: string,
    refs: { artifacts?: NewArtifactRef[]; attachments?: NewAttachmentRef[] },
    ctx?: CardMutationContext,
  ): AppendEvidenceRefsResult;
}
```

Notification queuing (`queueNotification`) is called from within `appendEvidenceRefs` and `applyPatch`. The `EvidenceRefService` owns notification for evidence ref operations. The general `applyPatch` notification queuing stays on `CardStore`.

#### What Remains in `CardStore` (Facade)

```typescript
export class CardStore {
  readonly maxDepth: number;
  readonly projectRoot: string;
  private readonly state: CardStoreState;
  private readonly lifecycle: CardLifecycleCommands;
  private readonly hierarchy: CardHierarchyCommands;
  private readonly archive: CardArchiveService;
  private readonly evidence: EvidenceRefService;

  constructor(projectRoot: string, maxGoalDepth?: number, eventBus?: EventBus);

  // Reads delegate to state directly:
  read(id: string): CardRecord | null;
  list(): CardRecord[];
  listChildren(parentId: string): string[];
  // ... etc.

  // Mutations delegate to command objects:
  create(input: NewCardInput): CardRecord { return this.lifecycle.create(input); }
  setStatus(id: string, newStatus: CardStatus): CardRecord { return this.lifecycle.setStatus(id, newStatus); }
  // ... etc.

  // History reads (disk I/O, not in-memory state):
  listCardHistory(id: string): CardHistoryEntry[];
  getCardAt(id: string, versionSeq: number): CardRecord;
  diffCard(id: string, fromSeq: number, toSeq: number): CardDiffEntry[];

  // Boot recovery (constructor only):
  static async open(projectRoot: string, eventBus?: EventBus, maxGoalDepth?: number): Promise<CardStore>;
}
```

Target final size: ~150 lines (constructor, read delegation, mutation delegation, history reads).

### Data Flow

```
CardStore (facade)
  ├── CardReader (reads from CardStoreState)
  ├── CardLifecycleCommands (create/status transitions/updates)
  │     └── uses ApplyMutationSync + ApplyMutationDeps
  ├── CardHierarchyCommands (reorder/depends_on)
  │     └── uses ApplyMutationGroupSync
  ├── CardArchiveService (delete/subtree archive)
  │     └── uses ApplyMutationGroupSync + writeFileSyncDurable
  ├── EvidenceRefService (evidence ref append)
  │     └── uses ApplyMutationWithOwnedLockSync + queueNotification
  └── CardStoreState (in-memory read model)
```

`ApplyMutationDeps` is the shared dependency struct that provides `projectRoot`, `state`, `projectLock`, and `eventBus` — currently `CardStore.deps()`. Each command object receives this struct.

### Step-by-Step Implementation Sequence (5B)

#### Step 5B-1: Extract `CardReader`

- Create `src/cards/reader.ts` with `CardReader` class.
- Move `read`, `list`, `listChildren`, `getParent`, `getAncestors`, `isDescendantOf`, `getDescendantIds`, `detectCycles`, `canTransition` methods.
- After Wave 2, these methods no longer call `refreshState()` and just query `this.state` directly. `CardReader` wraps `CardStoreState` with no I/O.
- `CardStore.read()` etc. become `return this.reader.read(id)`.
- **Validation:** `npm run validate:routine`, `npm test`.

#### Step 5B-2: Extract lifecycle status construction to `lifecycle.ts`

- Move the status-specific lifecycle object construction from `setStatus` (lines 536–582) to `buildSetStatusLifecycle(card: CardRecord, newStatus: CardStatus, stamp: string): CardRecord['lifecycle']` in `lifecycle.ts`.
- This is the only logic currently in `setStatus` that doesn't belong in a generic patch operation.
- `CardLifecycleCommands.setStatus` calls `buildSetStatusLifecycle` then delegates to the shared `applyPatch`.
- **Validation:** `npm run validate:routine`, `npm test`.

#### Step 5B-3: Extract `CardLifecycleCommands`

- Create `src/cards/lifecycle-commands.ts`.
- Move `create`, `update`, `mutateCard`, `commitTerminalLifecyclePatch`, `repairTerminalLifecycle`, `setStatus` into this class.
- The private `applyPatch` helper moves with it.
- `CardStore` holds a `lifecycle: CardLifecycleCommands` and delegates.
- **Validation:** `npm run validate:routine`, `npm test`.

#### Step 5B-4: Extract `CardHierarchyCommands`

- Create `src/cards/hierarchy-commands.ts`.
- Move `reorderChildren`, `updateDependsOn` into this class.
- `detectCycles` is called from `updateDependsOn` and `create`; it stays on `CardReader` and is passed as a dependency.
- **Validation:** `npm run validate:routine`, `npm test`.

#### Step 5B-5: Extract `CardArchiveService`

- Create `src/cards/archive-service.ts`.
- Move `delete`, `archiveAndDeleteSubtree`, `projectedCompactionOps`, `archiveCardPath`.
- `CardStore` holds an `archive: CardArchiveService` and delegates.
- **Validation:** `npm run validate:routine`, `npm test`. Manual: card deletion, subtree archive.

#### Step 5B-6: Extract `EvidenceRefService`

- Create `src/cards/evidence-ref-service.ts`.
- Move `appendEvidenceRefs`, `nextEvidenceSeq`.
- `CardStore` holds an `evidence: EvidenceRefService` and delegates.
- **Validation:** `npm run validate:routine`, `npm test`.

#### Step 5B-7: Clean up `CardStore` facade

- Verify `CardStore` is now ~150 lines: constructor, delegation methods, history reads, `open()`.
- Move history reads (`listCardHistory`, `getCardAt`, `diffCard`) to a `CardHistoryReader` if history complexity warrants, or leave on `CardStore` if simple.
- Remove `refreshState()` (already gone after Wave 2, verify it's not lingering).
- Remove unused imports and private helpers.
- **Validation:** `npm run validate:routine`, `npm test`, line count < 200.

---

## 5C: MCP Manager Decomposition (F13)

### Current State

`McpManager` (626 lines) manages: server lifecycle (start/stop/restart), process management, HTTP connection management, tool discovery, invocation queuing, argument validation, caching, status building, and health checking. State is distributed across seven Map/Set fields with no formal state model.

### New Module Structure

#### `src/mcp/server-runtime.ts` — `McpServerRuntime`

Per-server state machine and lifecycle. Owns all per-server mutable state: handle, status, startedAt, toolsCache, discoveryErrors, argument validator cache, invocation queue.

```typescript
export type McpServerPhase =
  | { phase: 'stopped' }
  | { phase: 'starting' }
  | { phase: 'running'; handle: McpServerHandle; startedAt: string }
  | { phase: 'error'; error: string };

export class McpServerRuntime {
  private phase: McpServerPhase = { phase: 'stopped' };
  private toolsCache: McpToolDefinition[] = [];
  private toolsInitialized = false;
  private discoveryError: string | null = null;
  private argumentValidators: Map<string, CachedMcpArgumentValidator> = new Map();
  private invocationQueue: Promise<void> = Promise.resolve();

  constructor(
    readonly name: string,
    readonly config: McpServerConfig,
    private readonly scope: ResourceScope,
    private readonly stats: McpInvocationStatsRecorder,
  ) {}

  get phase(): McpServerPhase;
  get isRunning(): boolean;
  get tools(): McpToolDefinition[];
  get hasInitializedTools(): boolean;

  // Lifecycle
  async start(): Promise<void>;
  async stop(): Promise<void>;
  async healthCheck(): Promise<boolean>;

  // Discovery
  async discoverTools(): Promise<void>;

  // Invocation
  async invokeTool(toolName: string, args: Record<string, unknown>, options?: { timeoutMs?: number }): Promise<unknown>;

  // Cache management
  clearToolCache(): void;
  clearArgumentValidators(): void;
}
```

Each `McpServerRuntime` dispatches to the existing transport modules (`stdio-transport.ts`, `streamable-http-transport.ts`) for the actual process/HTTP management. The runtime owns the per-server state machine transitions.

#### `src/mcp/stdio-lifecycle.ts` — `StdioServerLifecycle`

Extracts the stdio-specific start/stop/discover/health/invoke logic from `McpManager._startStdio`, `_stopStdio`, `_discoverToolsStdio`, and the stdio branch of `invokeTool`.

```typescript
export interface StdioLifecycleResult {
  process: import('node:child_process').ChildProcess;
}

export async function startStdioServer(
  name: string,
  config: McpServerConfig,
  scope: ResourceScope,
  onExit: (name: string, result: { code: number | null; signal: string | null }) => void,
  onError: (name: string, error: Error) => void,
): Promise<StdioLifecycleResult>;

export async function stopStdioServer(proc: import('node:child_process').ChildProcess): Promise<void>;
export async function discoverStdioServerTools(name: string, handle: McpServerHandle, ids: { next(): number }): Promise<McpToolDefinition[]>;
export async function invokeStdioServerTool(params: InvokeStdioToolParams): Promise<unknown>;
export function healthCheckStdioServer(handle?: McpServerHandle): boolean;
```

These currently exist as `discoverStdioTools`, `healthStdioProcess`, `invokeStdioTool`, `stopStdioProcess` in `stdio-transport.ts`. The change is: exit/error handlers that Currently mutate `McpManager` state become callbacks (`onExit`, `onError`) that `McpServerRuntime` uses to transition its own phase.

#### `src/mcp/http-lifecycle.ts` — `HttpServerLifecycle`

Similar extraction for HTTP/SSE lifecycle.

```typescript
export async function startHttpServer(name: string, config: McpServerConfig): Promise<{ abortController: AbortController }>;
export async function discoverHttpServerTools(params: DiscoverHttpToolsParams): Promise<McpToolDefinition[]>;
export async function invokeHttpServerTool(params: InvokeHttpToolParams): Promise<unknown>;
export function healthCheckHttpServer(params: HealthHttpParams): Promise<boolean>;
```

These already exist in `streamable-http-transport.ts`. The change is: startup results feed back to `McpServerRuntime` phase transitions rather than mutating `McpManager` maps.

#### What Remains in `McpManager` (Registry/Facade)

```typescript
export class McpManager {
  private servers: Record<string, McpServerConfig>;
  private runtimes: Map<string, McpServerRuntime>;

  constructor(projectRoot: string, options?: McpManagerOptions);

  // Registry operations
  reloadServersFromConfig(): void;
  async startAll(): Promise<void>;
  async startServer(name: string): Promise<void>;
  async stopServer(name: string): Promise<void>;
  async stopAll(): Promise<void>;
  async restartServer(name: string): Promise<void>;

  // Read projections (delegate to runtimes)
  getStatus(): McpServerStatus[];
  getServerStatus(name: string): McpServerStatus | undefined;
  getTools(): McpToolDefinition[];
  getServerTools(name: string): McpToolDefinition[] | undefined;
  getToolServers(): string[];
  getToolsReadModel(): ReturnType<typeof buildMcpToolsReadModel>;

  // Invocation (delegate to runtime)
  async invokeTool(serverName: string, toolName: string, args: Record<string, unknown>, options?: { timeoutMs?: number }): Promise<unknown>;

  // Health (delegate to runtime)
  async healthCheck(name: string): Promise<boolean>;

  // Stats
  getInvocationStats(): Record<string, { total: number; success: number; error: number; lastInvokedAt?: string }>;
}
```

Target final size: ~120 lines.

### Data Flow

```
McpManager (facade/registry)
  ├── Map<string, McpServerRuntime>
  │     ├── McpServerRuntime (per-server state machine)
  │     │     ├── phase transitions: stopped → starting → running → stopped/error
  │     │     ├── StdioServerLifecycle (start/stop/discover/health/invoke)
  │     │     ├── HttpServerLifecycle (start/discover/invoke/health)
  │     │     ├── tools cache + argument validator cache
  │     │     ├── invocation queue (stdio serialization)
  │     │     └── McpInvocationStatsRecorder
  │     └── ...
  └── buildMcpServerStatus / buildMcpToolsReadModel (projection)
```

### Step-by-Step Implementation Sequence (5C)

#### Step 5C-1: Define `McpServerPhase` type and `McpServerRuntime` skeleton

- Create `src/mcp/server-runtime.ts` with the `McpServerPhase` discriminated union and `McpServerRuntime` class skeleton.
- Initially, `McpServerRuntime` holds phase, config, and scope. Methods throw "not implemented".
- **Validation:** `npm run validate:routine`, `npm test` (all existing tests still use `McpManager` directly).

#### Step 5C-2: Move per-server state into `McpServerRuntime`

- Move `handles`, `statusOverrides`, `startedAt`, `toolsCache`, `argumentValidatorCache`, `toolsCacheInitialized`, `discoveryErrors`, `invocationQueues` from `McpManager` into per-server `McpServerRuntime` instances.
- `McpManager` holds `Map<string, McpServerRuntime>` instead of seven separate Maps/Sets.
- `McpManager.startServer()` delegates to `runtime.start()`, etc.
- Remaining `McpManager` methods become thin routing over `this.runtimes.get(name)?.method()`.
- **Validation:** `npm run validate:routine`, `npm test`. All MCP tests pass.

#### Step 5C-3: Implement lifecycle methods on `McpServerRuntime`

- Move `startServer`, `stopServer`, `healthCheck`, `discoverTools` logic from `McpManager` into `McpServerRuntime` methods.
- Exit/error callbacks from stdio process become `onExit`/`onError` callbacks that `McpServerRuntime` uses to transition its own phase.
- **Validation:** `npm run validate:routine`, `npm test`. Integration: start/stop MCP servers, invoke tools.

#### Step 5C-4: Move invocation into `McpServerRuntime`

- Move `invokeTool` logic (validation, dispatch, stats) into `McpServerRuntime.invokeTool()`.
- The `_enqueueStdioInvocation` becomes a method on `McpServerRuntime`.
- Argument validation calls `this._validateToolArguments(...)` using the runtime's own `argumentValidators` cache.
- **Validation:** `npm run validate:routine`, `npm test`. Tool invocation works for both stdio and HTTP servers.

#### Step 5C-5: Clean up `McpManager`

- Remove all per-server state Maps/Sets from `McpManager`.
- `McpManager` is now a registry: holds `servers` config and `runtimes` map, delegates all operations.
- Target size: ~120 lines.
- **Validation:** `npm run validate:routine`, `npm test`, `npm run validate:ui-smoke`.

---

## 5D: Frontend Store Decomposition (F14+F22)

### Current State

Three Pinia stores conflate domains:

**`analystChat.ts` (449 lines):** Session lifecycle, message sending, workspace routing, tool tracking, badges, toasts. Has separate loading/error per concern but shares `fetchMessages` across session and message domains.

**`debug.ts` (435 lines):** Runtime state, errors, timeline, processes, doctor, supervision, control actions, operator control. Shares a single `loading`/`error` across `fetchState`, `fetchErrors`, `fetchTimeline` but has separate per-domain loading/error for processes, doctor, supervision, control actions.

**`cards.ts` (339 lines):** Browse (cards list, filters, tree, board), detail (currentCard, evidence, lifecycle, review, planning, dispatches), history (card history, diff, version selection). Shares `loading`/`error` between browse and detail.

### New Store Structure

#### `web/src/stores/analyst-conversation.ts` — `AnalystConversationStore`

```typescript
export const useAnalystConversation = defineStore('analyst-conversation', () => {
  // Session state
  const sessions = ref<ChatSession[]>([]);
  const activeSessionId = ref<string | null>(ANALYST_SESSION_ID);
  const messages = ref<ConversationEntry[]>([]);
  const draft = ref('');
  const sessionsLoading = ref(false);
  const sessionsError = ref<DetailErrorState | null>(null);
  const messagesLoading = ref(false);
  const messagesError = ref<DetailErrorState | null>(null);

  // Send state
  const sending = ref(false);
  const sendError = ref<DetailErrorState | null>(null);

  // Computed
  const hasDraft = computed(() => draft.value.trim().length > 0);
  const activeSession = computed(...);
  const activeSessionWritable = computed(...);

  // Actions
  async function fetchSessions(): Promise<void> { ... }
  async function selectSession(sessionId?: string): Promise<void> { ... }
  async function fetchMessages(sessionId?: string): Promise<void> { ... }
  function createNewChat(): string { ... }
  async function sendMessage(): Promise<void> { ... }
  function setDraft(value: string): void { ... }

  return { sessions, activeSessionId, messages, draft, ... };
});
```

#### `web/src/stores/analyst-workspace-actions.ts` — `AnalystWorkspaceActionsStore`

```typescript
export const useAnalystWorkspaceActions = defineStore('analyst-workspace-actions', () => {
  // Tool invocations
  const pendingToolInvocations = ref<PendingToolInvocation[]>([]);

  // Badges
  const messageBadges = ref<Record<string, TimelineBadge[]>>([]);

  // Card seeding
  const syntheticHint = ref<SyntheticHintState>({ sessionId: null, content: null });
  const pendingCardSeed = ref<{ sessionId: string; cardId: string } | null>(null);

  // Actions
  function addBadgeForActiveSession(label: string, kind: TimelineBadge['kind']): void { ... }
  function seedCardContext(card: CardRecord): string { ... }
  function consumeSyntheticHint(sessionId: string): string | null { ... }
  function ingestWsEvent(payload: Record<string, unknown>): void { ... }

  return { pendingToolInvocations, messageBadges, ... };
});
```

`ingestWsEvent` dispatches to conversation updates via direct store reference (`useAnalystConversation().fetchMessages()`) or event bus. `sendMessage` in `AnalystConversationStore` calls `useWorkspaceRouteStore()` for navigation actions — this cross-store dependency is explicit.

#### `web/src/stores/toast.ts` — `ToastStore`

```typescript
export const useToastStore = defineStore('toast', () => {
  const toasts = ref<AnalystToastItem[]>([]);
  function addToast(item: AnalystToastItem): void { ... }
  function removeToast(id: string): void { ... }
  return { toasts, addToast, removeToast };
});
```

Shared by `AnalystWorkspaceActionsStore` and potentially other stores.

#### `web/src/stores/debug-state.ts` — `DebugStateStore`

```typescript
export const useDebugStateStore = defineStore('debug-state', () => {
  const debugRuntime = ref<RuntimeState | null>(null);
  const debugCards = ref<...>([]);
  const debugTotalCards = ref(0);
  const loading = ref(false);
  const error = ref<string | null>(null);

  async function fetchState(): Promise<void> { ... }
  return { debugRuntime, debugCards, debugTotalCards, loading, error, fetchState };
});
```

#### `web/src/stores/debug-errors.ts` — `DebugErrorsStore`

```typescript
export const useDebugErrorsStore = defineStore('debug-errors', () => {
  const errors = ref<DebugError[]>([]);
  const errorsTotal = ref(0);
  const loading = ref(false);
  const error = ref<string | null>(null);

  async function fetchErrors(): Promise<void> { ... }
  return { errors, errorsTotal, loading, error, fetchErrors };
});
```

#### `web/src/stores/debug-timeline.ts` — `DebugTimelineStore`

```typescript
export const useDebugTimelineStore = defineStore('debug-timeline', () => {
  const timelineEvents = ref<DebugTimelineEvent[]>([]);
  const timelineTotal = ref(0);
  const loading = ref(false);
  const error = ref<string | null>(null);

  async function fetchTimeline(): Promise<void> { ... }
  return { timelineEvents, timelineTotal, loading, error, fetchTimeline };
});
```

#### `web/src/stores/debug-process.ts` — `DebugProcessStore`

```typescript
export const useDebugProcessStore = defineStore('debug-process', () => {
  const processes = ref<ProcessView[]>([]);
  const processesLoading = ref(false);
  const processesError = ref<string | null>(null);
  // ... process control state

  async function fetchProcesses(): Promise<void> { ... }
  function upsertProcess(process: ProcessView): void { ... }
  return { processes, processesLoading, processesError, fetchProcesses, upsertProcess, ... };
});
```

#### `web/src/stores/debug-operator.ts` — `DebugOperatorStore`

```typescript
export const useDebugOperatorStore = defineStore('debug-operator', () => {
  // Doctor
  const doctorStatus = ref(null);
  const doctorChecks = ref([]);
  const doctorIssues = ref([]);
  const doctorLoading = ref(false);
  const doctorError = ref<string | null>(null);

  // Supervision
  const supervisionReviews = ref([]);
  // ... etc.

  // Control actions
  const controlActions = ref([]);
  // ... etc.

  // Runtime control
  const runtimeControlLoading = ref(null);
  const runtimeControlError = ref(null);
  const runtimeControlSuccess = ref(null);
  // ... etc.

  async function fetchDoctor(): Promise<void> { ... }
  async function fetchSupervision(): Promise<void> { ... }
  async function fetchControlActions(): Promise<void> { ... }
  async function fetchOperatorControl(): Promise<void> { ... }

  return { ... };
});
```

The composite `fetchAll` and `fetchOperatorControl` become orchestration functions that call the individual stores:

```typescript
async function fetchAll(): Promise<void> {
  await Promise.allSettled([
    useDebugStateStore().fetchState(),
    useDebugErrorsStore().fetchErrors(),
    useDebugTimelineStore().fetchTimeline(),
  ]);
}
```

#### `web/src/stores/card-browse.ts` — `CardBrowseStore`

```typescript
export const useCardBrowseStore = defineStore('card-browse', () => {
  const cards = ref<CardRecord[]>([]);
  const total = ref(0);
  const loading = ref(false);
  const error = ref<string | null>(null);

  // Filters
  const filterStatus = ref<CardStatus | ''>('');
  const filterType = ref<CardType | ''>('');
  const filterParent = ref<string>('');
  const filterTag = ref<string>('');
  const searchQuery = ref<string>('');

  // Computed
  const filteredCards = computed(...);
  const orderedFilteredCards = computed(...);
  const cardTree = computed(...);
  const board = computed(...);

  async function fetchCards(): Promise<void> { ... }
  function clearFilters(): void { ... }

  return { cards, total, loading, error, ... };
});
```

#### `web/src/stores/card-detail.ts` — `CardDetailStore`

```typescript
export const useCardDetailStore = defineStore('card-detail', () => {
  const currentCard = ref<CardRecord | null>(null);
  const currentChildren = ref<CardRecord[]>([]);
  const currentAncestorIds = ref<string[]>([]);
  const currentEvidence = ref<CardEvidence | null>(null);
  const currentLifecycle = ref<CardLifecycleSummary | null>(null);
  const currentReview = ref<CardReviewSummary | null>(null);
  const currentPlanning = ref<CardPlanningSummary | null>(null);
  const currentDispatches = ref<DispatchSummary | null>(null);
  const loading = ref(false);
  const error = ref<string | null>(null);
  const currentDetailError = ref<DetailErrorState | null>(null);
  const currentDetailFreshness = ref<DetailFreshnessState>(createEmptyDetailState());
  const staleNotificationByCard = ref<Record<string, boolean>>({});

  async function fetchCardDetail(id: string): Promise<void> { ... }
  function clearCurrentDetail(): void { ... }
  function markDetailStale(reason): void { ... }

  return { currentCard, currentChildren, ... };
});
```

#### `web/src/stores/card-history.ts` — `CardHistoryStore`

```typescript
export const useCardHistoryStore = defineStore('card-history', () => {
  const cardHistory = ref<CardHistoryHeader[]>([]);
  const cardHistoryLoading = ref(false);
  const cardHistoryError = ref<DetailErrorState | null>(null);
  const cardHistorySelectedSeq = ref<number | null>(null);
  const cardHistoryEntry = ref<CardHistoryEntry | null>(null);
  const cardHistoryEntryLoading = ref(false);
  const cardHistoryEntryError = ref<DetailErrorState | null>(null);
  const cardHistoryDiff = ref<CardDiffRow[]>([]);
  const cardHistoryDiffLoading = ref(false);
  const cardHistoryDiffError = ref<DetailErrorState | null>(null);

  async function fetchCardHistoryForCard(cardId: string): Promise<void> { ... }
  async function selectCardHistoryVersion(cardId: string, seq: number): Promise<void> { ... }

  return { cardHistory, cardHistoryLoading, ... };
});
```

### Cross-Store Dependencies

| Store | Depends on | How |
|-------|-----------|-----|
| AnalystConversationStore | WorkspaceRouteStore | Direct store call in `sendMessage()` |
| AnalystWorkspaceActionsStore | AnalystConversationStore | `ingestWsEvent` calls `fetchMessages` |
| AnalystWorkspaceActionsStore | ToastStore | `ingestWsEvent` calls `addToast` |
| AnalystConversationStore | AnalystWorkspaceActionsStore | `sendMessage` accesses `consumeSyntheticHint`, `pendingCardSeed` |
| CardDetailStore | CardBrowseStore | `fetchCardDetail` may trigger browse refresh |
| CardHistoryStore | CardDetailStore | `refreshCardHistory` uses `currentCard` for current version |
| DebugOperatorStore | DebugStateStore, DebugProcessStore | `fetchOperatorControl` orchestrates multiple |

Cross-store calls use direct Pinia store composition (`useOtherStore()`). This is explicit and is the standard Pinia pattern. No event bus or provide/inject is needed.

The existing `useDebugStore` and `useCardStore` are kept as **re-exporting facades** for a transition period, composing the new stores and delegating. This avoids breaking all component imports at once.

### Step-by-Step Implementation Sequence (5D)

#### Step 5D-1: Extract `ToastStore`

- Create `web/src/stores/toast.ts`.
- Move `AnalystToastItem` type and `toasts`, `addToast`, `removeToast` from `analystChat.ts`.
- Update `analystChat.ts` to call `useToastStore().addToast(...)` instead of local `addToast`.
- **Validation:** `npm run validate:ui-smoke`.

#### Step 5D-2: Extract `AnalystWorkspaceActionsStore`

- Create `web/src/stores/analyst-workspace-actions.ts`.
- Move `PendingToolInvocation`, `SyntheticHintState`, `TimelineBadge` types, and `pendingToolInvocations`, `messageBadges`, `syntheticHint`, `pendingCardSeed` state.
- Move `addBadgeForActiveSession`, `seedCardContext`, `consumeSyntheticHint`, `ingestWsEvent`, `normalizePendingSummary`, `normalizeToolName`, helper functions.
- `ingestWsEvent` gets conversation updates via `useAnalystConversation().fetchMessages()`.
- **Validation:** `npm run validate:ui-smoke`.

#### Step 5D-3: Slim down `analystChat.ts` to `AnalystConversationStore`

- Remove all extracted state and actions from `analystChat.ts`.
- The store now only contains session/message/send logic.
- Create a re-export facade in the old path: `export { useAnalystChat as useAnalystConversation } from './analyst-conversation'; export { useAnalystWorkspaceActions } from './analyst-workspace-actions';` — Or rename in place if component imports are updated simultaneously.
- **Validation:** `npm run validate:ui-smoke`, manual analyst chat E2E.

#### Step 5D-4: Extract `DebugStateStore`, `DebugErrorsStore`, `DebugTimelineStore`

- Create the three store files.
- Move state and actions for each domain.
- Create `fetchAll` as an async function that calls all three stores.
- Keep `useDebugStore` as a facade that composes the three stores for backward compatibility.
- **Validation:** `npm run validate:ui-smoke`.

#### Step 5D-5: Extract `DebugProcessStore` and `DebugOperatorStore`

- Create the two store files.
- Move process and doctor/supervision/control actions state respectively.
- Operator control orchestration lives in `DebugOperatorStore.fetchOperatorControl`.
- **Validation:** `npm run validate:ui-smoke`.

#### Step 5D-6: Extract `CardBrowseStore`, `CardDetailStore`, `CardHistoryStore`

- Create the three store files.
- Move browse, detail, and history state/actions respectively.
- Keep `useCardStore` as a facade that composes the three stores.
- Cross-store refresh: `refetch()` in the facade calls all three stores.
- **Validation:** `npm run validate:ui-smoke`, manual card browse/detail/history.

#### Step 5D-7: Update component imports

- Find all component files that import from the old stores.
- Replace with imports from the new domain-specific stores.
- Remove the old facades once all imports are updated.
- **Validation:** `npm run validate:ui`, `npm run validate:ui-smoke`.

---

## 5E: WebSocket Handler Decomposition (F11)

### Current State

`registerWebSocket` (lines 89–231) is a 142-line function handling: authentication, LiveSync membership, analyst session creation, turn queuing, both LiveSync and analyst message handling, and manual tool-result serialization with ad-hoc type assertions (`as unknown as Record<string, unknown>` casts).

### New Module Structure

#### `src/server/live-sync-handler.ts` — `LiveSyncHandler`

Handles LiveSync frames. Extracted from the `if (liveSyncSocket.handleClientFrame(ws, rawParsed)) return;` branch.

```typescript
export class LiveSyncHandler {
  constructor(private readonly liveSyncSocket: LiveSyncSocket) {}

  handleFrame(ws: WebSocket, rawParsed: unknown): boolean;
}
```

This is a thin wrapper: `handleFrame` calls `liveSyncSocket.handleClientFrame(ws, rawParsed)` and returns whether it was handled. If LiveSync grows more complex, this is the natural extension point.

#### `src/server/analyst-ws-handler.ts` — `AnalystWsHandler`

Handles analyst inbound messages.

```typescript
export interface AnalystWsHandlerConfig {
  projectRoot: string;
  runtimeApplication: RuntimeApplication;
  requestServerRestart?: () => Promise<void>;
}

export class AnalystWsHandler {
  constructor(private readonly config: AnalystWsHandlerConfig) {}

  async handleMessage(
    sessionId: string,
    rawText: string,
    ws: WebSocket,
    liveSyncSocket: LiveSyncSocket,
  ): Promise<void>;
}
```

`handleMessage` contains:
1. Get or create analyst session
2. Get analyst handler with `runtimeDeps`, `requestServerRestart`, `onActivity` callback
3. Call handler, get response
4. Send response to client
5. If `response.toolInvocations`, project tool activity and broadcast

The `onActivity` callback and tool-activity projection stay in this module.

#### `src/server/tool-activity-projection.ts` — `projectToolActivityResult`

Typed projection function replacing the ad-hoc casts (lines 173–199).

```typescript
export interface ToolActivityProjection {
  event: 'tool_invocation';
  tool: string;
  params: Record<string, unknown>;
  result: {
    success: boolean;
    error?: string;
    preview?: {
      type: string;
      summary: string;
      warnings?: string[];
      classified_as?: string;
    };
    data?: {
      classified_as?: string;
      exit_code?: number;
      duration_ms?: number;
      truncated?: boolean;
      stdout?: string;
      stderr?: string;
      command?: string;
      cwd?: string;
      path?: string;
      binary?: boolean;
      size?: number;
      modified_at?: string;
    };
  };
}

export function projectToolActivityResult(inv: {
  tool: string;
  params: unknown;
  result: { success: boolean; error?: string; preview?: unknown; data?: unknown };
}): ToolActivityProjection;
```

The projection uses explicit field access with type narrowing instead of `as unknown as Record<string, unknown>` casts. The `sanitizeAnalystPayload` call is applied to the projected result.

#### What Remains in `registerWebSocket`

```typescript
export function registerWebSocket(
  fastify: FastifyInstance,
  projectRoot: string,
  liveSyncSocketOrRuntimeApplication?: LiveSyncSocket | RuntimeApplication,
  runtimeApplicationOrRequestRestart?: RuntimeApplication | (() => Promise<void>),
  requestServerRestartArg?: () => Promise<void>,
): void {
  const liveSyncSocket = ...;
  const runtimeApplication = ...;
  const requestServerRestart = ...;
  const analystHandler = new AnalystWsHandler({ projectRoot, runtimeApplication, requestServerRestart });

  fastify.get('/ws', { websocket: true }, (ws, request) => {
    if (!checkAuth(request)) { rejectUnauthorizedWebSocket(ws); return; }
    liveSyncSocket.add(ws);
    const { sessionId } = getOrCreateAnalystSession(projectRoot);
    wsSessions.set(ws, sessionId);
    sendToClient(ws, buildConnectedEnvelope({ sessionId, timestamp: new Date().toISOString(), clientCount: liveSyncSocket.clientCount() }));

    ws.on('message', (raw) => queueAnalystTurn(ws, async () => {
      const data = parseRawMessage(raw);
      const rawParsed = JSON.parse(data);
      if (liveSyncHandler.handleFrame(ws, rawParsed)) return;
      const parsed = InboundAnalystMessageEnvelopeSchema.safeParse(rawParsed);
      if (!parsed.success) throw new Error('Invalid analyst websocket message');
      const currentSessionId = ensureSession(ws);
      await analystHandler.handleMessage(currentSessionId, parsed.data.content.text, ws, liveSyncSocket);
    }));

    ws.on('close', () => { liveSyncSocket.delete(ws); wsSessions.delete(ws); analystTurnQueues.delete(ws); });
    ws.on('error', () => { liveSyncSocket.delete(ws); wsSessions.delete(ws); analystTurnQueues.delete(ws); });
  });
}
```

Target size: ~50 lines.

### Data Flow

```
registerWebSocket (thin connect function)
  ├── Authenticates connection
  ├── Registers LiveSync membership
  ├── Creates analyst session
  ├── ws.on('message')
  │     ├── queueAnalystTurn(ws, ...)
  │     │     ├── LiveSyncHandler.handleFrame() → if handled, return
  │     │     └── AnalystWsHandler.handleMessage()
  │     │           ├── Gets/creates analyst handler
  │     │           ├── Calls handler.handleMessage()
  │     │           ├── Sends response to client
  │     │           └── Projects tool activity via projectToolActivityResult()
  │     │                 └── broadcast() to LiveSync
  │     └── ...
  └── Cleanup on close/error
```

### Step-by-Step Implementation Sequence (5E)

#### Step 5E-1: Extract `projectToolActivityResult`

- Create `src/server/tool-activity-projection.ts`.
- Move the ad-hoc casting block (lines 173–199) into `projectToolActivityResult`.
- Replace `as unknown as Record<string, unknown>` casts with explicit field access and type narrowing.
- **Validation:** `npm run validate:routine`, `npm test`.

#### Step 5E-2: Extract `LiveSyncHandler`

- Create `src/server/live-sync-handler.ts`.
- Move `handleClientFrame` delegation.
- **Validation:** `npm run validate:routine`, `npm test`.

#### Step 5E-3: Extract `AnalystWsHandler`

- Create `src/server/analyst-ws-handler.ts`.
- Move the analyst message handling block (lines 138–205) into `AnalystWsHandler.handleMessage()`.
- This includes session creation, handler retrieval, message sending, and tool activity projection.
- Update `registerWebSocket` to instantiate `AnalystWsHandler` and delegate.
- **Validation:** `npm run validate:routine`, `npm test`, `npm run validate:ui-smoke`. Manual: analyst chat via WebSocket.

#### Step 5E-4: Extract `queueAnalystTurn` and session management

- Move `queueAnalystTurn`, `wsSessions` WeakMap, and `getOrCreateAnalystSession` / `ensureSession` helpers into a small `src/server/ws-session-manager.ts` or inline in `registerWebSocket` if small enough.
- `registerWebSocket` is now ~50 lines.
- **Validation:** `npm run validate:routine`, `npm test`, `npm run validate:ui-smoke`.

---

## Validation Per Sub-wave

| Sub-wave | Validation Commands | Manual Checks |
|----------|-------------------|---------------|
| 5A (AgentAdapter) | `npm run validate:routine`, `npm test` | Full planner loop, executor tool calls, reviewer assessment, session lifecycle |
| 5B (CardStore) | `npm run validate:routine`, `npm test` | Card CRUD, status transitions, archival, position repair, subtree delete |
| 5C (MCP Manager) | `npm run validate:routine`, `npm test` | MCP server start/stop/invoke, tool discovery, health check |
| 5D (Frontend stores) | `npm run validate:ui-smoke` | Analyst chat, debug panels, card browse/detail/history |
| 5E (WebSocket) | `npm run validate:routine`, `npm test`, `npm run validate:ui-smoke` | WebSocket auth, LiveSync, analyst chat over WS, tool activity projection |

Final validation for the entire wave:

```bash
npm run validate:routine
npm test
npm run validate:ui-smoke
npm run validate:ui
```

Manual end-to-end: full planner loop with invocation, compaction, and tool calls; card operations; analyst chat; WebSocket sync; MCP operations.

---

## Design Decisions and Tradeoffs

### AgentAdapter: Facade vs. Elimination

**Decision:** Keep `AgentAdapter` as a facade rather than eliminating it entirely.

**Rationale:** `AgentAdapter` is the primary entry point for the runtime composition layer. `invokePlanner`, `invokeExecutor`, `invokeReviewer`, and `reinvokeSession` are the stable public API. The facade preserves this API while delegating to focused modules. Eliminating `AgentAdapter` would force all callers to wire `AgentInvocationRunner`, `SessionLifecycle`, `AttemptRecorder`, etc. individually, which is worse coupling.

**Tradeoff:** One extra thin class vs. direct dependency injection. The facade is ~200 lines, which is acceptable. Wave 6 (F26) converts setter injection to constructor injection, which simplifies the facade further.

### CardStore: Command Objects vs. Module Functions

**Decision:** Use class-based command objects (`CardLifecycleCommands`, `CardHierarchyCommands`, etc.) rather than standalone module functions.

**Rationale:** The command objects need shared state (`ApplyMutationDeps`: projectRoot, state, projectLock, eventBus). A class holds this as a field, avoiding thread-locals or repeated parameter passing. Standalone functions would need a `deps` parameter on every call or a module-level singleton, both worse patterns.

**Tradeoff:** More classes vs. fewer. But each class is ~30–80 lines and focused on one domain.

### MCP Manager: Per-Server Runtime vs. Flat Methods

**Decision:** `McpServerRuntime` as a per-server state machine class rather than keeping flat Maps in `McpManager`.

**Rationale:** The seven Map/Set fields in `McpManager` represent per-server state that belongs together. A state machine makes invalid states unrepresentable (you can't have a `toolsCache` entry for a stopped server). It also makes exit/error handlers local to each server rather than scattered closures that mutate global Maps.

**Tradeoff:** One new class per server. But each `McpServerRuntime` is ~100 lines vs. the current 626-line monolith with scattered state updates.

### Frontend Stores: Facade Compatibility vs. Clean Break

**Decision:** Keep `useDebugStore` and `useCardStore` as re-exporting facades during the transition, remove them once all component imports are updated.

**Rationale:** The frontend has many components importing `useDebugStore` and `useCardStore`. A single-step rename would break too many files at once. The facade approach lets sub-waves 5D-1 through 5D-6 land independently.

**Tradeoff:** Temporary dual imports. The facades are thin and removed in 5D-7.

### WebSocket: Handler Classes vs. Functions

**Decision:** `AnalystWsHandler` is a class, `LiveSyncHandler` is a class, `projectToolActivityResult` is a function.

**Rationale:** `AnalystWsHandler` holds config (projectRoot, runtimeApplication, requestServerRestart) across calls — natural for a class. `LiveSyncHandler` holds a `LiveSyncSocket` reference. The projection function is pure and stateless — a function is simpler.

**Tradeoff:** More classes for what could be simple functions. But the handlers will grow (error handling, reconnection, session resumption) and the class pattern provides a natural extension point.
