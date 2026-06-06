# Wave 5: Decomposition — Implementation Plan and Design

## Prerequisites (Completed in Earlier Waves)

This wave assumes Waves 2 and 4 are complete. Verify actual seams before starting; otherwise stop and finish missing waves.

- **Wave 2 (Card Data Model):** `CardStoreState` is the authoritative in-memory read model. Read methods no longer call `refreshState()`. Mutations update state after durable writes. Defensive `deepClone` remains in this wave. ID generation keeps the sequential `card-N` format but runs inside the locked `create()` mutation after a lock-scoped state reload.
- **Wave 4 (Path Unification):**
  - F02: A shared `InvocationService` owns raw LLM transport, candidate resolution, gateway/recorder caching, and analyst candidate recovery. The analyst LLM resolver is deleted. Analyst session handling uses shared session persistence.
  - F10: A `ToolDispatcher` owns parsing, policy check, result envelope, truncation, persistence hooks, and error formatting. Tool call dispatch in `invokeAgent` delegates to the `ToolDispatcher`.
  - F23: A `ContextCompactor` service owns per-session compaction, boundary trimming, and planner-specific context serialization. `compactPlannerModelMessagesForContext`, `buildPlannerHistoryCompactionMessage`, `buildPlannerRecentMessageTail`, and the planner history constants are extracted from `agent-adapter.ts`.
  - F35: A unified `publishRuntimeDiagnostic` owns both event-bus emission and durable logging. Callers provide one diagnostic object once; no separate `emit` + `appendEvent` pairs.
  - F20: One `RuntimeControlCommand` handler computes patches for pause/resume. The runtime calls a single command handler.

These changes mean `invokeAgent` is already shorter and simpler than the current 610-line method. The seams below refer to the post-Wave-4 method, noting which parts are already gone.

Sub-wave 5A requires Wave 4 seams. Sub-waves 5B, 5C, 5D, and 5E may proceed first or in parallel.

---

## Sub-wave Ordering

| Sub-wave | Issue | Target | Estimated Complexity |
|----------|-------|--------|---------------------|
| 5A | F01 | AgentAdapter decomposition | HIGHEST |
| 5B | F04 | CardStore decomposition | HIGH |
| 5C | F13 | MCP Manager decomposition | MEDIUM |
| 5D | F14+F22 | Frontend store decomposition | MEDIUM |
| 5E | F11 | WebSocket handler decomposition | MEDIUM |

Sub-wave 5A requires Wave 4 seams. Sub-waves 5B–5E have no hard dependency on 5A or on each other and can proceed first or in parallel once their local prerequisites are present. Before starting any sub-wave, reconcile this plan against the code that actually landed in Waves 2 and 4; if a prerequisite seam changed, fix this plan body first rather than implementing against stale assumptions.

---

## 5A: AgentAdapter Decomposition (F01)

### Current State (Pre-Wave 5)

`AgentAdapter` (1340 lines) holds:
- Constructor with extensive wiring, including `InvocationService`, `ToolDispatcher`, `ContextCompactor`, session coordination, and planner-control wiring
- Setter injection: `setContentSupervisor`, `setMcpManager`, `setSkillsEngine`, `setAfterSessionCreatedHook`, plus runtime/event-bus setters. `setLlmCallFn` is already removed; fake LLM injection is constructor-based.
- Planner-specific compaction functions (lines 124–258) — **already extracted to `ContextCompactor` in Wave 4**
- `synthesizeReportGoalEnvelope` (lines 124–155) — planner-specific terminal envelope synthesis
- `invokePlanner`, `invokeExecutor`, `invokeReviewer`, `reinvokeSession` — thin wrappers delegating to `invokeAgent`
- Private helpers: `processToolCall` delegation, `buildModelMessages`, `nextFallbackRound`, `stampInCurrentFallbackRound`, `appendSessionMessage`, `compensateActivationBarrierThrow`
- `invokeAgent` core — the method to decompose

### Post-Wave-4 State (What invokeAgent Looks Like)

After Wave 4 extractions:
- Compaction logic (`compactPlannerModelMessagesForContext` etc.) → `ContextCompactor`
- Tool dispatch → `ToolDispatcher`
- Diagnostic publishing → unified `publishRuntimeDiagnostic`
- Analyst LLM resolution → deleted (merged into shared `InvocationService`)

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
| S12: Getter pass-throughs | approximate tail | `getRouter`, `getRegistry`, `getCandidateAvailability`, `flushRecorders` | `AgentAdapter` facade |

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
  attemptRecorderFactory: () => AttemptRecorder;
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

Each invocation creates a fresh `AttemptRecorder` via `attemptRecorderFactory`; no cross-invocation state leakage.

#### `src/agents/session-lifecycle.ts` — `AgentSessionLifecycle`

Owns session creation, status transitions, and session-start notification. Delegates to `AgentSessionCoordinator` for cancellation, notification injection, handoff summaries, and session-start publication. The coordinator remains a distinct class.

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

`AgentSessionCoordinator` remains as a distinct class owning cancellation, notification injection, handoff summaries, and session-start publication. `AgentSessionLifecycle` wraps it for session lifecycle management.

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

Each invocation creates a fresh `AttemptRecorder` instance via `attemptRecorderFactory` (no cross-invocation state leakage).

#### `src/agents/session-message-log.ts` — `SessionMessageLog`

Owns message persistence and round tracking for a session. Extracts round stamping and appends only; model-message construction stays in an invocation-context service.

```typescript
export class SessionMessageLog {
  private readonly fallbackCurrentRoundId = new Map<string, string>();
  private readonly fallbackBlockCounters = new Map<string, number>();

  constructor(
    private readonly saivageDir: string,
  ) {}

  append(sessionId: string, message: MessageAppendInput): void;
  nextFallbackRound(sessionId: string, prefix: 'pre' | 'user' | 'assistant' | 'diagnostic'): RoundStamp;
}
```

`MessageAppendInput` is a simplified type for the `{ role, kind, content, tool?, tool_call_id?, links?, model_spec?, requested_model_spec? }` shape currently passed to `appendPersistentMessage` inline. `SessionMessageLog.append()` calls `appendPersistentMessage` under the hood and handles round-id generation and block counting internally. Model-message construction stays in an invocation-context service and preserves `model_spec`/`requested_model_spec` when appending prebuilt context messages.

#### `src/agents/planner-envelope-tracker.ts` — `PlannerEnvelopeTracker`

Owns the planner-specific terminal envelope synthesis and state tracking for one invocation. Parses accepted tool results and preserves pending envelope on parse failure/unsupported status.

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

  // Other delegation methods (not all listed):
  cancelSession(sessionId: string): boolean { ... }
  forceCancelSession(sessionId: string): void { ... }
  getHandoffSummary(sessionId: string): HandoffSummary | undefined { ... }
  getActiveSessionHandoffs(): HandoffSummary[] { ... }
  setEventBus(eventBus: EventEmitter): void { ... }
  setRuntimeLedgerEventBus(eventBus: EventEmitter): void { ... }
  setActivationLedger(ledger: ActivationLedger): void { ... }
  getContentSupervisor(): ContentSupervisor { ... }
  getMcpManager(): McpToolInvocationPort { ... }
  getToolNamesForRole(role: string): string[] { ... }
  callMcpTool(serverName: string, toolName: string, args: Record<string, unknown>): Promise<unknown> { ... }
  getSafeFileContent(path: string): Promise<string | null> { ... }

  // Late-bound runtime wiring that remains after Wave 4:
  setContentSupervisor(supervisor: ContentSupervisor): void { ... }
  setMcpManager(mcpManager: McpToolInvocationPort): void { ... }
  setSkillsEngine(engine: SkillsEngine): void { ... }
  setAfterSessionCreatedHook(hook: SessionCreatedHook | null): void { ... }
}
```

Target final size: ~300-350 lines.

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
  │     └── appends messages, manages round IDs
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
- `SessionMessageLog` owns `append()` and round-stamping only. `append()` calls `appendPersistentMessage` under the hood. Model-message construction stays in an invocation-context service and is not part of `SessionMessageLog`.
- **Validation:** `npm run validate:routine`, `npm test`.

#### Step 5A-3: Extract `AgentSessionLifecycle`

- Create `src/agents/session-lifecycle.ts` with the `AgentSessionLifecycle` class.
- Move `createSession`/`completeSession`/`markSessionWaiting`/`setSessionStatus`/`updateSessionModel` calls into the lifecycle class.
- Keep `AgentSessionCoordinator` as the distinct owner of cancellation, notification injection, handoff summaries, and session-start publication. `AgentSessionLifecycle` delegates to the coordinator for these concerns.
- **Validation:** `npm run validate:routine`, `npm test`. Integration: verify planner, executor, and reviewer invocations still create and complete sessions correctly.

#### Step 5A-4: Extract `PlannerEnvelopeTracker`

- Create `src/agents/planner-envelope-tracker.ts` with `PlannerEnvelopeTracker` class and move `synthesizeReportGoalEnvelope` into it.
- In `invokeAgent`, replace the `pendingPlannerRuntimeEnvelope` mutable closure variable with a tracker instance scoped to the invocation.
- The `takeRuntimeDoneEnvelope` callback becomes `() => tracker.takeEnvelope()`.
- In the `executeActionToolCalls` callback in `AgentLoopDriverIO`, when `role === 'planner'` and a terminal tool is detected, call `tracker.trackTerminalToolResult(toolName, goalId, msg.content)`.
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
- Verify `AgentAdapter` is now ~300-350 lines: config, construction, setter injection, thin invoke* delegations, pass-through accessors, and other delegation methods.
- Remove unused imports.
- **Validation:** `npm run validate:routine`, `npm test`, line count check on `agent-adapter.ts`.

---

## 5B: CardStore Decomposition (F04)

### Current State

`CardStore` (750 lines) handles: boot recovery, read APIs, creation/validation, evidence refs and notification queuing, lifecycle status construction, deletion, subtree archive/delete, compaction internals, and patch persistence.

After Wave 2:
- Reads no longer call `refreshState()`.
- Defensive `deepClone` remains in place; public read results are still cloned.
- ID generation keeps the sequential `card-N` format but runs inside the locked `create()` mutation after a lock-scoped state reload.
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

#### `src/cards/card-patch-service.ts` — `CardPatchService`

Shared partial-card patch application logic used by update/status/dependency command paths. Extracted before card command objects so lifecycle and hierarchy services can call it without making `CardStore` own the mutation details.

```typescript
export interface CardPatchService {
  applyPatch(
    state: CardStoreState,
    id: string,
    changes: Partial<CardRecord>,
    historyKind: 'update' | 'status' | 'mutate' | 'depends',
    ctx?: CardMutationContext,
  ): CardRecord;
}
```

`CardPatchService` is accessible through shared `deps` for command objects that perform partial updates. It preserves the current mutation-with-notification flow: refresh/read existing card, prune no-op fields, build and validate the updated card, detect dependency cycles when `depends_on` changes, persist via `applyMutationSync`, then queue notification for the affected card.

Do not route every command through `applyPatch`. `create` remains a create mutation, `reorderChildren` and archive/delete remain grouped operations, and `appendEvidenceRefs` keeps its owned-lock flow because it assigns evidence IDs and emits history events after lock release.

#### `src/cards/lifecycle-commands.ts` — `CardLifecycleCommands`

Status transitions and creation.

```typescript
export interface CardStoreDeps {
  projectRoot: string;
  maxDepth: number;
  state: CardStoreState;
  projectLock: ProjectLock;
  eventBus: EventBus;
  applyPatch: CardPatchService['applyPatch'];
  queueNotification: QueueNotificationFn;
  detectCycles: (id: string, newDependsOn: string[]) => string[];
}

export class CardLifecycleCommands {
  constructor(private readonly deps: CardStoreDeps) {}

  create(input: NewCardInput): CardRecord;
  setStatus(id: string, newStatus: CardStatus): CardRecord;
  update(id: string, changes: Partial<CardRecord>): CardRecord;
  mutateCard(id: string, changes: Partial<CardRecord>, ctx: CardMutationContext): CardRecord;
  commitTerminalLifecyclePatch(id: string, changes: Partial<CardRecord>): CardRecord;
  repairTerminalLifecycle(id: string, changes: Partial<CardRecord>): CardRecord;
}
```

`queueNotification` is either included in `CardStoreDeps` or imported directly by service modules that need it. The single `CardStoreDeps` interface avoids stale snapshots by including `maxDepth`, `state`, `projectLock`, `eventBus`, `applyPatch`, and `detectCycles` together.

`setStatus` currently constructs lifecycle objects inline (lines 525–588). Move the lifecycle construction cases to `lifecycle.ts` as `buildSetStatusLifecycle(card, newStatus)` or discriminated-union helpers.

#### `src/cards/hierarchy-commands.ts` — `CardHierarchyCommands`

Hierarchy operations that modify parent/child relationships.

```typescript
export class CardHierarchyCommands {
  constructor(private readonly deps: CardStoreDeps) {}

  reorderChildren(parentId: string, orderedChildIds: string[], ctx: CardMutationContext): ReorderChildrenResult;
  updateDependsOn(id: string, newDependsOn: string[], ctx?: CardMutationContext): CardRecord;
}
```

#### `src/cards/archive-service.ts` — `CardArchiveService`

Archive, deletion, and subtree operations.

```typescript
export class CardArchiveService {
  constructor(private readonly deps: CardStoreDeps) {}

  delete(id: string): void;
  archiveAndDeleteSubtree(ids: string[]): void;
}
```

The `projectedCompactionOps` helper becomes a private method of `CardArchiveService`. The `archiveCardPath` helper and `writeFileSyncDurable` for archive payload move here.

#### `src/cards/evidence-ref-service.ts` — `EvidenceRefService`

Evidence ref attachment and notification.

```typescript
export class EvidenceRefService {
  constructor(private readonly deps: CardStoreDeps) {}

  appendEvidenceRefs(
    id: string,
    refs: { artifacts?: NewArtifactRef[]; attachments?: NewAttachmentRef[] },
    ctx?: CardMutationContext,
  ): AppendEvidenceRefsResult;
}
```

`EvidenceRefService.appendEvidenceRefs()` preserves the owned-lock flow and emits history events after lock release. Notification queuing is called from within `appendEvidenceRefs`.

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

  // Shared patch application for partial-update command objects via deps:
  private applyPatch(id: string, changes: Partial<CardRecord>, historyKind: 'update' | 'status' | 'mutate' | 'depends', ctx: CardMutationContext): CardRecord;

  // History reads (disk I/O, not in-memory state):
  listCardHistory(id: string): CardHistoryEntry[];
  getCardAt(id: string, versionSeq: number): CardRecord;
  diffCard(id: string, fromSeq: number, toSeq: number): CardDiffEntry[];

  // Boot recovery (constructor only):
  static async open(projectRoot: string, eventBus?: EventBus, maxGoalDepth?: number): Promise<CardStore>;
}
```

Target final size: ~200-250 lines. Still needs constructor, `deps()`, `open()`, read methods, mutation delegations, history reads, private shared `applyPatch`, and helper methods.

Card detail freshness and stale-notification need a single owner. `CardDetailStore` (in 5D) owns the freshness/stale-notification concern for cards.

### Data Flow

```
CardStore (facade)
  ├── CardReader (reads from CardStoreState)
  ├── CardPatchService (shared applyPatch used by partial-update command objects via deps)
  ├── CardLifecycleCommands (create/status transitions/updates)
  │     └── uses CardStoreDeps + applyPatch via deps for update/status/dependency-style patches
  ├── CardHierarchyCommands (reorder/depends_on)
  │     └── uses CardStoreDeps + applyPatch via deps for updateDependsOn; reorderChildren keeps grouped position ops
  ├── CardArchiveService (delete/subtree archive)
  │     └── uses CardStoreDeps + grouped delete/archive ops
  ├── EvidenceRefService (evidence ref append)
  │     └── uses CardStoreDeps + owned-lock flow, emits history events after lock release
  └── CardStoreState (in-memory read model)
```

`CardStoreDeps` is the shared dependency struct: `projectRoot`, `maxDepth`, `state`, `projectLock`, `eventBus`, `applyPatch`, `detectCycles`, and `queueNotification`. Each command object receives this struct. Avoid stale snapshots by keeping all deps in one object.

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

#### Step 5B-3: Extract `CardPatchService`

- Create `src/cards/card-patch-service.ts` with `CardPatchService`.
- Move the shared partial-update `applyPatch` logic to this service. `applyPatch` is called from `update`, `mutateCard`, `updateDependsOn`, `commitTerminalLifecyclePatch`, `repairTerminalLifecycle`, and `setStatus` after lifecycle construction. It must stay accessible to partial-update command objects via `deps`.
- `CardStore` holds a `CardPatchService` instance and exposes a private `applyPatch` delegate for command objects that receive it via `deps`; it does not become a public facade API.
- Define `CardStoreDeps` with `projectRoot`, `maxDepth`, `state`, `projectLock`, `eventBus`, `applyPatch`, `detectCycles`, and `queueNotification`.
- **Validation:** `npm run validate:routine`, `npm test`.

#### Step 5B-4: Extract `CardLifecycleCommands`

- Create `src/cards/lifecycle-commands.ts`.
- Move `create`, `update`, `mutateCard`, `commitTerminalLifecyclePatch`, `repairTerminalLifecycle`, `setStatus` into this class.
- `CardLifecycleCommands` receives `CardStoreDeps`. `create` keeps the create mutation flow; update/status/terminal repair methods use `deps.applyPatch` for partial patch application.
- `CardStore` holds a `lifecycle: CardLifecycleCommands` and delegates.
- **Validation:** `npm run validate:routine`, `npm test`.

#### Step 5B-5: Extract `CardHierarchyCommands`

- Create `src/cards/hierarchy-commands.ts`.
- Move `reorderChildren`, `updateDependsOn` into this class.
- `detectCycles` is called from `updateDependsOn` and `create`; it stays on `CardReader` and is passed as a dependency.
- `CardHierarchyCommands` receives `CardStoreDeps`; `updateDependsOn` uses `deps.applyPatch`, while `reorderChildren` keeps grouped position operations.
- **Validation:** `npm run validate:routine`, `npm test`.

#### Step 5B-6: Extract `CardArchiveService`

- Create `src/cards/archive-service.ts`.
- Move `delete`, `archiveAndDeleteSubtree`, `projectedCompactionOps`, `archiveCardPath`.
- `CardStore` holds an `archive: CardArchiveService` and delegates.
- `CardArchiveService` receives `CardStoreDeps` and keeps grouped delete/archive mutation operations; it does not use `deps.applyPatch`.
- **Validation:** `npm run validate:routine`, `npm test`. Manual: card deletion, subtree archive.

#### Step 5B-7: Extract `EvidenceRefService`

- Create `src/cards/evidence-ref-service.ts`.
- Move `appendEvidenceRefs`, `nextEvidenceSeq`.
- `CardStore` holds an `evidence: EvidenceRefService` and delegates.
- `EvidenceRefService` receives `CardStoreDeps` and preserves the owned-lock flow, emitting history events after lock release.
- **Validation:** `npm run validate:routine`, `npm test`.

#### Step 5B-8: Clean up `CardStore` facade

- Verify `CardStore` is now ~200-250 lines: constructor, delegation methods, history reads, `open()`, private shared `applyPatch`, and helper methods.
- Move history reads (`listCardHistory`, `getCardAt`, `diffCard`) to a `CardHistoryReader` if history complexity warrants, or leave on `CardStore` if simple.
- Remove `refreshState()` (already gone after Wave 2, verify it's not lingering).
- Remove unused imports and private helpers.
- **Validation:** `npm run validate:routine`, `npm test`, line count within target range.

---

## 5C: MCP Manager Decomposition (F13)

### Current State

`McpManager` (626 lines) manages: server lifecycle (start/stop/restart), process management, HTTP connection management, tool discovery, invocation queuing, argument validation, caching, status building, and health checking. State is distributed across eight Map/Set fields (`handles`, `statusOverrides`, `startedAt`, `toolsCache`, `argumentValidatorCache`, `toolsCacheInitialized` (Set), `discoveryErrors`, `_invocationQueues`) with no formal state model.

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
  private currentPhase: McpServerPhase = { phase: 'stopped' };
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
  async start(): Promise<void>;   // calls this.discoverTools() internally after transport start
  async stop(): Promise<void>;
  async healthCheck(): Promise<boolean>;

  // Discovery (called internally by start; also callable for re-discovery)
  async discoverTools(): Promise<void>;

  // Invocation
  async invokeTool(toolName: string, args: Record<string, unknown>, options?: { timeoutMs?: number }): Promise<unknown>;

  // Cache management
  clearToolCache(): void;
  clearArgumentValidators(): void;
}
```

`McpServerRuntime.start()` calls `this.discoverTools()` internally after transport start, matching current behavior. Discovery is not a separate required call but is available for re-discovery.

`McpServerRuntime` calls existing transport functions from `stdio-transport.ts` and `streamable-http-transport.ts` directly — no separate lifecycle wrapper modules. Exit/error handlers from stdio become callbacks (`onExit`, `onError`) that `McpServerRuntime` uses to transition its own phase.

`McpManager.setEventLogger()`, `next()`, the shared message ID source, and the stats shape are preserved on the `McpManager` facade.

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

  // Preserved from original
  setEventLogger(logger: EventLogger): void;
  next(): number;   // shared message ID source
}
```

Target final size: ~120 lines.

### Data Flow

```
McpManager (facade/registry)
  ├── Map<string, McpServerRuntime>
  │     └── McpServerRuntime (per-server state machine)
  │           ├── currentPhase: stopped → starting → running → stopped/error
  │           ├── start() calls discoverTools() internally, then transitions to running
  │           ├── Creates stdio processes through ResourceScope, then calls stdio-transport functions directly (discoverStdioTools, invokeStdioTool, stopStdioProcess, healthStdioProcess)
  │           ├── Calls streamable-http-transport functions directly (probeStreamableHttpStartup, discoverStreamableHttpTools, invokeStreamableHttpTool, healthStreamableHttpServer)
  │           ├── tools cache + argument validator cache
  │           ├── invocation queue (stdio serialization)
  │           └── McpInvocationStatsRecorder
  ├── setEventLogger() / next() / shared message ID source / stats shape (preserved)
  └── buildMcpServerStatus / buildMcpToolsReadModel (projection)
```

### Step-by-Step Implementation Sequence (5C)

#### Step 5C-1: Define `McpServerPhase` type and `McpServerRuntime` skeleton

- Create `src/mcp/server-runtime.ts` with the `McpServerPhase` discriminated union and `McpServerRuntime` class skeleton using `currentPhase` field plus `phase` getter.
- Initially, `McpServerRuntime` holds currentPhase, config, and scope. Methods throw "not implemented".
- **Validation:** `npm run validate:routine`, `npm test` (all existing tests still use `McpManager` directly).

#### Step 5C-2: Move per-server state into `McpServerRuntime`

- Move `handles`, `statusOverrides`, `startedAt`, `toolsCache`, `argumentValidatorCache`, `toolsCacheInitialized`, `discoveryErrors`, `invocationQueues` from `McpManager` into per-server `McpServerRuntime` instances.
- `McpManager` holds `Map<string, McpServerRuntime>` instead of eight separate Maps/Sets.
- `McpManager.startServer()` delegates to `runtime.start()`, etc.
- Remaining `McpManager` methods become thin routing over `this.runtimes.get(name)?.method()`.
- **Validation:** `npm run validate:routine`, `npm test`. All MCP tests pass.

#### Step 5C-3: Implement stdio lifecycle on `McpServerRuntime`

- Move stdio start/stop/health logic from `McpManager` into `McpServerRuntime.start()`, `stop()`, `healthCheck()`, and `discoverTools()` for stdio-configured servers.
- Create stdio processes through the existing `ResourceScope.spawn()` flow, then call existing transport functions from `stdio-transport.ts` directly: `discoverStdioTools`, `invokeStdioTool`, `stopStdioProcess`, and `healthStdioProcess`. There is no `startStdioServer` wrapper today and no separate `stdio-lifecycle.ts` wrapper module.
- Exit/error callbacks from stdio process become `onExit`/`onError` callbacks that `McpServerRuntime` uses to transition its own phase.
- Verify `McpServerRuntime.start()` calls `this.discoverTools()` internally.
- **Validation:** `npm run validate:routine`, `npm test`. Integration: start/stop/invoke MCP stdio servers.

#### Step 5C-4: Implement streamable-HTTP lifecycle on `McpServerRuntime`

- Move streamable-HTTP/SSE start/stop/health logic from `McpManager` into `McpServerRuntime` for `cfg.transport === 'sse'` servers.
- Call existing transport functions from `streamable-http-transport.ts` directly: `probeStreamableHttpStartup`, `discoverStreamableHttpTools`, `invokeStreamableHttpTool`, and `healthStreamableHttpServer`. Startup still creates the `AbortController`/handle in `McpServerRuntime`; there is no `startSseServer` wrapper today and no separate `streamable-http-lifecycle.ts` wrapper module.
- Startup results feed back to `McpServerRuntime` phase transitions rather than mutating `McpManager` maps.
- **Validation:** `npm run validate:routine`, `npm test`. Integration: start/stop/invoke MCP HTTP/SSE servers.

#### Step 5C-5: Move invocation into `McpServerRuntime`

- Move `invokeTool` logic (validation, dispatch, stats) into `McpServerRuntime.invokeTool()`.
- The `_enqueueStdioInvocation` becomes a method on `McpServerRuntime`.
- Argument validation calls `this._validateToolArguments(...)` using the runtime's own `argumentValidators` cache.
- **Validation:** `npm run validate:routine`, `npm test`. Tool invocation works for both stdio and HTTP servers.

#### Step 5C-6: Clean up `McpManager`

- Remove all per-server state Maps/Sets from `McpManager`.
- Preserve `McpManager.setEventLogger()`, `next()`, shared message ID source, and stats shape.
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
  let messagesRequestSeq = 0;

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

`fetchMessages()` increments `messagesRequestSeq` before awaiting `getChatEntries()` and applies the response only if the sequence still matches the latest request and the requested session is still active. The current API client does not accept `AbortSignal`, so sequence tokens are the first F22 guard; add abort plumbing only if `web/src/api/client.ts` is extended to accept signals.

#### `web/src/stores/analyst-workspace-actions.ts` — `AnalystWorkspaceActionsStore`

```typescript
export const useAnalystWorkspaceActions = defineStore('analyst-workspace-actions', () => {
  // Tool invocations
  const pendingToolInvocations = ref<PendingToolInvocation[]>([]);

  // Badges
  const messageBadges = ref<Record<string, TimelineBadge[]>>({});

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

`DebugStateStore.fetchState()` calls `/api/state` once, which returns `{ runtime, cards, totalCards }`. The split stores share this single endpoint response — `fetchState()` sets all three fields from the one API call.

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

The debug store split needs a composed read model for combined errors and sorted timeline (e.g., an `allDebugEvents` computed that merges errors + timeline entries sorted by timestamp). This can live in `useDebugStore` facade or a small composable.

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
  let detailRequestSeq = 0;

  async function fetchCardDetail(id: string): Promise<void> { ... }
  function clearCurrentDetail(): void { ... }
  function markDetailStale(reason): void { ... }

  return { currentCard, currentChildren, ... };
});
```

`CardDetailStore` is the single owner of card freshness/stale-notification state. `fetchCardDetail()` increments `detailRequestSeq` before awaiting `getCard(id)` and discards success/error writes unless the sequence still matches the latest request. This prevents stale detail responses from overwriting rapid navigation targets without requiring API-level cancellation.

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

The existing `useDebugStore` and `useCardStore` are kept as **re-exporting facades** for a transition period, composing the new stores and delegating. No long-lived compatibility facades — update imports in the same commit or keep the old file canonical.

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
- `messageBadges` initializes as `ref<Record<string, TimelineBadge[]>>({})` (empty object, not array).
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
- `DebugStateStore.fetchState()` calls `/api/state` once and sets `debugRuntime`, `debugCards`, and `debugTotalCards` from the single response.
- Provide a composed read model (e.g., `allDebugEvents` computed) that merges errors + timeline entries sorted by timestamp for components that need combined debug data.
- Keep `useDebugStore` as a facade that composes the three stores for backward compatibility until all imports are updated.
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
- `CardDetailStore` is the single owner of card freshness/stale-notification state.
- **Validation:** `npm run validate:ui-smoke`, manual card browse/detail/history.

#### Step 5D-7: Update component imports and barrel file

- Find all component files that import from the old stores.
- Replace with imports from the new domain-specific stores.
- Update `web/src/stores/index.ts` barrel to re-export from new store files.
- Remove the old facades once all imports are updated.
- **Validation:** `npm run validate:ui`, `npm run validate:ui-smoke`.

---

## 5E: WebSocket Handler Decomposition (F11)

### Current State

`registerWebSocket` (lines 89–231) is a 142-line function handling: authentication, LiveSync membership, analyst session creation, turn queuing, both LiveSync and analyst message handling, and manual tool-result serialization with ad-hoc type assertions (`as unknown as Record<string, unknown>` casts).

### New Module Structure

#### LiveSync Frame Dispatch (inline)

Do not create `src/server/live-sync-handler.ts` in this wave. The LiveSync frame dispatch stays inline in `registerWebSocket` (it is already a single `if (liveSyncSocket.handleClientFrame(ws, rawParsed)) return;` branch). If extraction becomes necessary, a plain helper function is preferred over a class.

#### `src/server/analyst-ws-handler.ts` — `AnalystWsHandler`

Handles analyst inbound messages.

```typescript
export interface AnalystWsHandlerConfig {
  projectRoot: string;
  runtimeApplication?: RuntimeApplication;
  requestServerRestart?: () => Promise<void>;
  outboundSinks?: OutboundSinks;
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

`runtimeApplication` stays optional at the `registerWebSocket` signature boundary because server startup supports an absent runtime application. `AnalystWsHandler.handleMessage()` must check it before creating the analyst handler and throw the existing `Runtime application unavailable for analyst websocket.` error when absent; `getAnalystHandler()` requires concrete `runtimeDeps` and does not accept null. Outbound sinks are injected via `config.outboundSinks`.

`handleMessage` contains:
1. Get or create analyst session
2. Require `runtimeApplication`, then get analyst handler with `runtimeApplication.analystDeps`, `requestServerRestart`, and `onActivity` callback
3. Call handler, get response
4. Send response to client
5. If `response.toolInvocations`, project tool activity and send it to the current client

The `onActivity` callback still broadcasts live activity to `LiveSyncSocket`. The `response.toolInvocations` projection is sent to the current client with `sendToClient`, matching the current response path.

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
    data?: unknown;
  };
}

export function projectToolActivityResult(inv: {
  tool: string;
  params: unknown;
  result: { success: boolean; error?: string; preview?: unknown; data?: unknown };
}): ToolActivityProjection;
```

The projection uses explicit field access with type narrowing instead of `as unknown as Record<string, unknown>` casts. Primitive and array data values are preserved as sanitized `unknown`. The `sanitizeAnalystPayload` call is applied to the projected result.

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
      if (liveSyncSocket.handleClientFrame(ws, rawParsed)) return;
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

The `parseRawMessage` function signature: `parseRawMessage(raw: Buffer | ArrayBuffer | Buffer[]): string`.

Target size: ~50 lines.

### Data Flow

```
registerWebSocket (thin connect function)
  ├── Authenticates connection
  ├── Registers LiveSync membership
  ├── Creates analyst session
  ├── ws.on('message')
  │     ├── queueAnalystTurn(ws, ...)
  │     │     ├── LiveSync frame dispatch (inline, not extracted as class)
  │     │     └── AnalystWsHandler.handleMessage()
  │     │           ├── Gets/creates analyst handler
  │     │           ├── Calls handler.handleMessage()
  │     │           ├── Sends response to client
  │     │           └── Projects response tool activity via projectToolActivityResult()
  │     │                 └── sendToClient(ws, activity)
  │     └── ...
  └── Cleanup on close/error
```

### Step-by-Step Implementation Sequence (5E)

#### Step 5E-1: Extract `projectToolActivityResult`

- Create `src/server/tool-activity-projection.ts`.
- Move the ad-hoc casting block (lines 173–199) into `projectToolActivityResult`.
- Replace `as unknown as Record<string, unknown>` casts with explicit field access and type narrowing.
- Preserve primitive/array data as sanitized `unknown` in the `data` field.
- **Validation:** `npm run validate:routine`, `npm test`.

#### Step 5E-2: Extract `AnalystWsHandler`

- Create `src/server/analyst-ws-handler.ts`.
- Move the analyst message handling block (lines 138–205) into `AnalystWsHandler.handleMessage()`.
- This includes session creation, handler retrieval, message sending, and tool activity projection.
- `runtimeApplication` stays optional in `AnalystWsHandlerConfig`, but `handleMessage()` checks it before calling `getAnalystHandler()` because `AnalystHandler` requires concrete `AnalystRuntimeDeps`.
- Inject outbound sinks via `config.outboundSinks`.
- Update `registerWebSocket` to instantiate `AnalystWsHandler` and delegate.
- **Validation:** `npm run validate:routine`, `npm test`, `npm run validate:ui-smoke`. Manual: analyst chat via WebSocket.

#### Step 5E-3: Extract `queueAnalystTurn` and session management

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

**Tradeoff:** One extra thin class vs. direct dependency injection. The facade is ~300-350 lines, which is acceptable given the many delegation methods required beyond the explicitly listed ones. Wave 6 (F26) converts setter injection to constructor injection, which simplifies the facade further.

### CardStore: Command Objects vs. Module Functions

**Decision:** Use class-based command objects (`CardLifecycleCommands`, `CardHierarchyCommands`, etc.) rather than standalone module functions.

**Rationale:** The command objects need shared state (`CardStoreDeps`: projectRoot, maxDepth, state, projectLock, eventBus, applyPatch, queueNotification). A class holds this as a field, avoiding thread-locals or repeated parameter passing. Standalone functions would need a `deps` parameter on every call or a module-level singleton, both worse patterns.

**Tradeoff:** More classes vs. fewer. But each class is ~30–80 lines and focused on one domain.

### CardPatchService: Shared Patch Application

**Decision:** Extract `CardPatchService` before card command objects. `applyPatch` is shared across partial-update command paths, not lifecycle-specific.

**Rationale:** `applyPatch` is called from partial-update paths: `update`, `mutateCard`, `updateDependsOn`, `commitTerminalLifecyclePatch`, `repairTerminalLifecycle`, and `setStatus` after lifecycle construction. Moving it only to `CardLifecycleCommands` would break `CardHierarchyCommands.updateDependsOn`. It must stay as a private `CardStore` delegate or become a shared service accessible to partial-update command objects via `deps`.

**Tradeoff:** One extra small service class vs. duplicating patch logic.

### MCP Manager: Per-Server Runtime vs. Flat Methods

**Decision:** `McpServerRuntime` as a per-server state machine class rather than keeping flat Maps in `McpManager`.

**Rationale:** The eight Map/Set fields in `McpManager` represent per-server state that belongs together. A state machine makes invalid states unrepresentable (you can't have a `toolsCache` entry for a stopped server). It also makes exit/error handlers local to each server rather than scattered closures that mutate global Maps.

**Tradeoff:** One new class per server. But each `McpServerRuntime` is ~100 lines vs. the current 626-line monolith with scattered state updates.

### MCP Manager: No Lifecycle Wrapper Modules

**Decision:** `McpServerRuntime` calls existing transport functions directly from `stdio-transport.ts` and `streamable-http-transport.ts`. No separate `stdio-lifecycle.ts` or `streamable-http-lifecycle.ts` wrapper modules.

**Rationale:** The existing transport modules already provide `discoverStdioTools`, `invokeStdioTool`, `stopStdioProcess`, `healthStdioProcess`, `probeStreamableHttpStartup`, `discoverStreamableHttpTools`, `invokeStreamableHttpTool`, and `healthStreamableHttpServer` (matching `_startSse` and `cfg.transport === 'sse'` config). Creating wrapper modules adds indirection without benefit. `McpServerRuntime` can create handles/startup probes itself, call these functions directly, and manage phase transitions.

**Tradeoff:** `McpServerRuntime` imports from two transport modules instead of one lifecycle module. This is acceptable since the transport modules are stable and the calls are straightforward.

### Frontend Stores: Facade Compatibility vs. Clean Break

**Decision:** Keep `useDebugStore` and `useCardStore` as re-exporting facades during the transition, remove them once all component imports are updated. No long-lived compatibility facades — update imports in the same commit or keep the old file canonical.

**Rationale:** The frontend has many components importing `useDebugStore` and `useCardStore`. A single-step rename would break too many files at once. The facade approach lets sub-waves 5D-1 through 5D-6 land independently.

**Tradeoff:** Temporary dual imports. The facades are thin and removed in 5D-7.

### WebSocket: Handler Class vs. Plain Helper

**Decision:** `AnalystWsHandler` is a class, `LiveSyncHandler` stays inline (not extracted as a class), `projectToolActivityResult` is a function.

**Rationale:** `AnalystWsHandler` holds config (projectRoot, optional runtimeApplication, requestServerRestart) across calls — natural for a class. LiveSync dispatch is a single `if` check that doesn't warrant a separate class module. The projection function is pure and stateless — a function is simpler.

**Tradeoff:** More structure for `AnalystWsHandler` but less indirection for LiveSync. The handler will grow (error handling, reconnection, session resumption) and the class pattern provides a natural extension point.
