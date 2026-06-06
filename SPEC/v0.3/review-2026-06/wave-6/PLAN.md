# Wave 6: Targeted Fixes & Cleanup — Implementation Plan

## Second Review Corrections

This section supersedes both the Reviewed Corrections and any conflicting text below.

### F07: Runtime Ledger

1. **HIGH — `RuntimeRunLedger` does NOT have its own JSONL**: Plan says "Adapt `RuntimeEventLedger` for run persistence, dropping its own JSONL append." `RuntimeRunLedger` (src/runtime/runtime-run-ledger.ts) uses `RuntimeStateMutationPort.mutations.apply()` — it does NOT write its own JSONL. Correct: "Adapt `RuntimeRunLedger` to emit ledger events instead of mutation calls."
2. **MEDIUM — Runtime state path clarification**: Reviewed Correction #2 says `.saivage/tmp/state/runtime.json` but actual code uses `.saivage/runtime.json` (`AUTHORITATIVE_STATE_FILE = 'runtime.json'` in `src/runtime/state.ts`). Ledger path should be `.saivage/runtime-events.jsonl` or `.saivage/runtime/runtime-events.jsonl`. Do NOT use `.saivage/tmp/state/runtime.json`.
3. **MEDIUM — Ledger injection goes through deps pattern, not RuntimeServices**: `RuntimeStateMutationPort` is created standalone. Phase handlers (`RuntimePlannerDispatcherDeps` etc.) pick from `RuntimeServices`-derived deps. The ledger needs to be injected similarly — add ledger/view fields to dispatcher deps, not to `RuntimeServices` directly.

### F06: Effects Ports

4. **HIGH — `RuntimeDiagnosticEffects` cannot have fixed signature**: Callers use discriminated `phase` literal types. `ReviewerInvocationFailureEffects` passes `{ goal_id, phase: 'reviewer', error }`, `ExecutorInvocationFailureEffects` passes `{ card_id, goal_id, phase: 'executor', error }`, `PlannerInvocationFailureEffects` passes `{ goal_id, phase: 'planner', error }`. A single `emitRuntimeDiagnostic(input: { goal_id: string; phase: string; error: unknown })` loses type narrowing. Use a union input type or per-phase type narrowing.
5. **MEDIUM — Phase-specific `transitionCard` event types**: `ReviewerInvocationFailureEffects.transitionCard` uses `'block'`, `PlannerInvocationFailureEffects` uses `'block' | 'fail'`, `ExecutorCompletionEffects` uses `'executor_finish' | 'executor_partial_finish'`. The broad `CardTransitionEffects.transitionCard(cardId: string, event: string, ...)` is compatible but loses narrowing. Document that callers widen literal types at the port boundary.
6. **MEDIUM — `StartupActiveRunRepairEffects` has unlisted methods**: Beyond `ClockEffects & CardTransitionEffects & CardPatchEffects`, it also has: `repairOrphanActivateCardToolCalls`, `repairTerminalLifecycle`, `appendChildUnwindToolResult`, `parentPlannerRunFor`, `findCallerEdge`, `synthesizeTerminalActivationResult`, `finishOpenPlannerRun`, `queueSyntheticPlannerNote`, `saveState`. List these explicitly.

### F18: Blocker Cause

7. **HIGH — `PlannerBlockedResult` is in `src/schemas/lifecycle.ts`, not `src/schemas/runtime-state.ts`**: Target file for `blocker_cause` field is `lifecycle.ts:45-49`.
8. **MEDIUM — `classifyBlockerCause` needs card state, not just reason string**: `isReviewerCapacityPlannerBlocker` checks `card?.lifecycle.error` and `card?.status_text`. Better design: set `blocker_cause` at blocker creation time (in `buildPlannerBlockedDecision`/`buildPlannerInvocationFailureBlocker`), then runtime just reads the field. No runtime classification function needed.

### F32: Planner Timeout

9. **HIGH — Bare `Promise.race` is explicitly insufficient**: Reviewed Correction #10 says "cannot be bare `Promise.race`." The plan's implementation still uses `Promise.race([iterationPromise, timeoutPromise])`. Must pass `AbortSignal` through to `AgentAdapter.invokeAgent()` and cancel the underlying LLM call on timeout. At minimum, create an `AbortController` on timeout and pass its signal through to the iteration.

### F27: Credential Refreshers

10. **HIGH — `CredentialSourceResolver` already exists**: `src/agents/credential-source-resolver.ts` (251 lines) handles provider resolution AND delegates to `usableProfileAccessToken` for token refresh. The new `CredentialRefreshers` interface overlaps. Specify the relationship: extract `refreshOpenAICodexProfile` and `refreshGitHubCopilotProfile` to `credential-refreshers.ts`, with `CredentialSourceResolver` holding a refresher reference or `usableProfileAccessToken` being injected with a refresher.

### F16: Barrel Cleanup

11. **HIGH — `llm-errors.ts` has 9 source importers, not 3**: `src/llm-openai-codex-gateway.ts`, `src/llm-openai-chat-gateway.ts`, `src/llm-failure-classifiers.ts`, `src/llm-codex-parser.ts`, `src/llm-recording.ts`, `src/llm-stream-parser.ts`, `src/llm-provider-gateway.ts`, `src/runtime/invocation-recovery-policy.ts`, `src/scripts/probe-llm-contract.ts`. All 9 must update imports. Only `llm-failure-classifiers.ts` and `llm-codex-parser.ts` import `redactProviderErrorText`; others import `LlmRequestError` or `unwrapFailure`. Move `redactProviderErrorText` to `llm-failure.ts` or `redaction/index.ts`.

### F19: Sync Store

12. **HIGH — `SyncResourceRegistration` type is in `sync/client.ts`, not `api/types`**: Plan says "import from `../api/types`" but `SyncResourceRegistration` is defined at `web/src/sync/client.ts:11-14`. Only `LiveSyncInvalidateFrame` and `WsConnectionState` are in `api/types.ts`. Move `SyncResourceRegistration` to the store or to `api/types.ts`.
13. **MEDIUM — `SyncClient` imports `useAnalystChat`**: `web/src/sync/client.ts:6` imports `useAnalystChat`. When folding into `useSyncStore`, this coupling must be preserved — either import in the store or emit an event that analyst chat subscribes to.
14. **MEDIUM — `SyncClient` has module-level singleton**: `syncClient` at line 151 is imported by `stores/sync.ts`. When deleting `SyncClient` class, the Pinia store must manage `WsConnectionManager` lifecycle directly.

### F28: Content Supervisor

15. **MEDIUM — Three `recordContentPass` call sites, not one**: `screenContent` calls `recordContentPass` on lines 142, 158, and 230. All three need the `recordPasses` guard.

### F29: Scanner Extract

16. **MEDIUM — `PATTERNS_BY_CATEGORY` also eagerly built**: `COMPILED_PATTERNS` (line 687) and `PATTERNS_BY_CATEGORY` (line 697) are both module-level eager state. Both must become lazy or be derived from `PATTERN_DEFS`.
17. **MEDIUM — Scanner exports more than `validatePatterns` and `getCompiledPatterns`**: Current exports: `scanContent`, `isInjectionSuspicious`, `SensitivityLevel`, `ScanResult`, `InjectionCategory`, `Pattern`, `PatternDef`, `PATTERNS_BY_CATEGORY`, `compile`. Only `PATTERN_DEFS` moves to `heuristic-patterns.ts`. Scanning functions stay in scanner.

### F15: Contract Factory

18. **MEDIUM — `permissions` is a function, not convention-derivable**: `OperatorRouteContract.permissions` is a complex async function type (line 49). A `defineRoute` factory cannot derive permissions by convention — it must preserve the function signature.

### Cross-cutting

19. **MEDIUM — F32 needs design decision on cancellation**: The plan batches F32 with F18+F33 but F32 requires an abort/cancellation design that isn't specified. Consider deferring F32 until the cancellation design is decided, or split: make `RepairBudget` immutable now, defer timeout wrapper.

## Reviewed Corrections

This section supersedes any conflicting text below.

1. F07 runtime ledger is a locked projection refactor behind `RuntimeStateMutationPort`, not a long-lived in-memory view.
2. Runtime state path is `.saivage/tmp/state/runtime.json`; state ledger path should be clearly distinct such as `.saivage/tmp/state/runtime-ledger.jsonl` with schema/version envelope.
3. Ledger events cover all array-affecting mutations; scalar patches stay in `runtime.json` unless fully event-sourcing runtime state.
4. Do not add ledger/view to `RuntimeServices`; keep behind `createRuntimeStateMutationPort(projectRoot)`.
5. Runtime compaction/migration runs in `performRuntimeStartup()` after read/init and before repair/reconciliation.
6. Keep runtime arrays as bounded current-state projection fields because API contracts consume them.
7. Use internal caps unless config demand exists; migration must be idempotent.
8. F06 effect ports preserve literal constraints and keep exported effect type names as aliases for tests.
9. F18 blocker field is an optional structured enum in `src/schemas/lifecycle.ts`; delete substring helper after call sites update.
10. F32 timeout cannot be bare `Promise.race`; add cooperative cancellation/abort or freeze/block dispatch and diagnose. Immutable `RepairBudget` is separate.
11. F33 validation includes config parsing and no-start-event default.
12. F21 split updates `src/agents/config-api.ts`; avoid open-ended compatibility barrels.
13. F27 refreshers need `projectRoot`; move all provider-specific constants out of `llm-transport.ts`; preserve fallback behavior.
14. F26 only eliminates `setLlmCallFn`; `config` and `projectRoot` already are constructor-injected. Cached `analystDeps` must update on `setMcpManager()`.
15. F15 factory preserves current `ContractAuthClass`, explicit response overrides, route errors, permissions, and audit metadata.
16. F16 importer counts require `rg`; preserve/move `redactProviderErrorText` and current tool-catalog exports before deletion.
17. F25 inject optional `eventLogger` into `ProcessRunnerService` and delete wrappers only when unused.
18. F28 pass recording default off means passed content has no review. Lock quarantine JSONL appends with sync append/fsync under `ProjectLock`.
19. F29 move/export pattern types or use `satisfies`; export only `validatePatterns()` and `getCompiledPatterns()` from scanner.
20. F19 preserves public sync store API and rewrites `sync-client.test.ts` into store tests.
21. Recommended sequence: F33, F29, F28, F18, F32 after cancellation design, F21, F27, F26, F06, F07, F25, F19. Defer F15 and large barrel deletion unless a cleanup-only window exists.

Generated: 2026-06-06

Batched into 6 independent groups by file proximity and dependency. Each batch is a minimal compilable commit.

---

## Batch A: Runtime State Ledger Migration (F07)

This is the most structurally significant Wave 6 item. The goal: stop growing `runtime_commands`, `runtime_runs`, and `runtime_activations` as unbounded arrays in the runtime state file. Instead, maintain an append-only event ledger and a compact current-state view.

### Design

**Data model:**

- New file: `src/persistence/runtime-event-ledger.ts` — append-only JSONL ledger for `runtime_command`, `runtime_run`, `runtime_activation` events.
- New file: `src/persistence/runtime-state-view.ts` — reads the ledger at startup, produces a compact `RuntimeState` with only current/active entries for each array, plus a `ledger_seqno` watermark.

**Ledger event types (discriminated union):**

```
runtime_command_accepted  { command_id, command, status, requested_at, source }
runtime_command_updated  { command_id, status, completed_at?, error? }
runtime_run_appended     { ...RuntimeRunRecord }
runtime_run_updated      { run_id, ...partial updates }
runtime_activation_upserted { ...RuntimeActivationRecord }
```

**Current-state view derivation:**

- `runtime_commands`: keep only the latest N (configurable, default 50), ordered by `requested_at`.
- `runtime_runs`: keep only runs with `runtime_status` in `['running', 'pending']`, plus the latest N terminal runs for history.
- `runtime_activations`: keep only activations with status in unresolved set, plus the latest N terminal activations.
- View is rebuilt on startup from ledger, then incrementally maintained from events arriving through `mutations.apply()`.

**Migration:**

- At startup, if `runtime.json` has legacy full arrays, compact them: write the historical entries to the ledger, then rewrite the state file with only the current-view entries.
- The ledger file is `.saivage/runtime/runtime-events.jsonl`. Every append uses the project lock.

**File changes:**

| File | Action |
|------|--------|
| `src/persistence/runtime-event-ledger.ts` | **New.** `RuntimeEventLedger` class: `append(event)`, `read(fromSeqno?)`, `compact()`. Uses project lock for atomic appends. |
| `src/persistence/runtime-state-view.ts` | **New.** `RuntimeStateView` class: `rebuildFromLedger()`, `applyEvent()`, `current()`. Produces compact `RuntimeState` arrays. |
| `src/runtime/state.ts` | **Modify.** Remove `appendRuntimeCommand`, `appendRuntimeRun`, `updateRuntimeRun`, `upsertRuntimeActivation` as state-array mutators. Replace with calls to `RuntimeEventLedger.append()` + `RuntimeStateView.applyEvent()`. Keep `readRuntimeState`, `saveRuntimeState`, `updateRuntimeState`, `initRuntimeState` as thin wrappers over the view. Add `migrateLegacyRuntimeStateArrays()` that writes arrays to ledger and rewrites state file compact. |
| `src/runtime/mutations.ts` | **Modify.** Mutation handlers for `runtime_command`, `runtime_run`, `runtime_activation` patches emit ledger events instead of mutating arrays. |
| `src/runtime/runtime-run-ledger.ts` | **Modify.** Adapt to use `RuntimeEventLedger` for run persistence, dropping its own JSONL append if it duplicates the new ledger. |
| `src/runtime/runtime-services.ts` | **Modify.** Wire `RuntimeEventLedger` and `RuntimeStateView` into `RuntimeServices`. |
| `src/runtime/runtime.ts` | **Modify.** On init, call `migrateLegacyRuntimeStateArrays()`. |
| `src/schemas/runtime-state.ts` | **Modify.** Keep array types for backward compat but document they are now bounded current-state views. `RuntimeState` gains optional `ledger_seqno: number`. |

**Key function signatures:**

```typescript
// src/persistence/runtime-event-ledger.ts
export type RuntimeLedgerEvent =
  | { kind: 'runtime_command_accepted'; ... }
  | { kind: 'runtime_command_updated'; ... }
  | { kind: 'runtime_run_appended'; ... }
  | { kind: 'runtime_run_updated'; ... }
  | { kind: 'runtime_activation_upserted'; ... };

export class RuntimeEventLedger {
  constructor(projectRoot: string, lock: ProjectLock);
  append(event: RuntimeLedgerEvent): number; // returns seqno
  read(fromSeqno?: number): RuntimeLedgerEvent[];
  compact(keepFromSeqno: number): void;
}

// src/persistence/runtime-state-view.ts
export class RuntimeStateView {
  private current: RuntimeState;
  private seqno: number;

  static rebuildFromLedger(ledger: RuntimeEventLedger): RuntimeStateView;
  applyEvent(event: RuntimeLedgerEvent): void;
  current(): RuntimeState;
}
```

**Validation:** `npm run validate:routine`, `npm test`. Manual: start runtime, dispatch goals, kill/restart, verify `runtime-events.jsonl` grows, verify `runtime.json` stays bounded, verify `/api/state` returns correct current entries.

---

## Batch B: Effects Ports & Phase Refactoring (F06)

Extract composable effects interfaces to eliminate partial overlap between phase handler effects.

### Design

Define small, focused port interfaces. Each phase composes exactly the ports it needs. Phase files import ports and compose them into their local effects interface.

**File changes:**

| File | Action |
|------|--------|
| `src/runtime/effects-ports.ts` | **New.** Define composable ports: `ClockEffects { now(): string }`, `CardTransitionEffects { transitionCard(...): Promise<unknown> }`, `CardPatchEffects { updateCard(...): Promise<unknown> \| unknown }`, `RuntimeDiagnosticEffects { emitRuntimeDiagnostic(...): void; appendRuntimeDiagnostic(...): void }`, `ErrorAppendEffects { appendError(...): void }`, `RuntimeRunEffects { updateRuntimeRun(...): RuntimeRunRecord \| null; publishRuntimeRun(...): void }`, `RuntimeTransitionEffects { transitionRuntime(...): Promise<unknown> }`, `CardReadEffects { readCard(cardId): CardRecord \| null }`, `CardCompletionEffects { appendChildUnwindToolResult(...): void; emitCardFailed(...): void }`. |
| `src/runtime/phases/reviewer-invocation-failure.ts` | **Modify.** `ReviewerInvocationFailureEffects` becomes an intersection type of `CardTransitionEffects & CardPatchEffects & RuntimeDiagnosticEffects & ErrorAppendEffects & RuntimeTransitionEffects` plus local `finishOpenPlannerRun`. Remove the explicit interface definition; import ports from `effects-ports.ts`. |
| `src/runtime/phases/executor-invocation-failure.ts` | **Modify.** `ExecutorInvocationFailureEffects` becomes intersection of `ClockEffects & CardTransitionEffects & CardPatchEffects & RuntimeDiagnosticEffects & ErrorAppendEffects & CardCompletionEffects` plus `clearActiveCardRun`. |
| `src/runtime/phases/executor-completion-handler.ts` | **Modify.** `ExecutorCompletionEffects` becomes intersection of `ClockEffects & CardTransitionEffects & CardPatchEffects & CardReadEffects & CardCompletionEffects`. |
| `src/runtime/phases/planner-invocation-failure.ts` | **Modify.** `PlannerInvocationFailureEffects` becomes intersection of `ClockEffects & CardTransitionEffects & CardPatchEffects & RuntimeDiagnosticEffects & ErrorAppendEffects & RuntimeRunEffects & RuntimeTransitionEffects`. |
| `src/runtime/phases/reviewer-assessment-handler.ts` | **Modify.** `ReviewerAssessmentEffects` becomes intersection of `ClockEffects & CardReadEffects & CardTransitionEffects & CardPatchEffects & RuntimeTransitionEffects` plus local event emissions. |
| `src/runtime/startup-repair.ts` | **Modify.** `StartupActiveRunRepairEffects` uses `ClockEffects & CardTransitionEffects & CardPatchEffects` plus its unique `repairTerminalLifecycle`, `parentPlannerRunFor`, etc. |

**Key function signatures:**

```typescript
// src/runtime/effects-ports.ts
export interface ClockEffects { now(): string }
export interface CardTransitionEffects {
  transitionCard(cardId: string, event: string, details: Record<string, unknown>): Promise<unknown>;
}
export interface CardPatchEffects {
  updateCard(cardId: string, patch: Partial<CardRecord>): Promise<unknown> | unknown;
}
export interface RuntimeDiagnosticEffects {
  emitRuntimeDiagnostic(input: { goal_id: string; phase: string; error: unknown }): void;
  appendRuntimeDiagnostic(input: { goal_id: string; phase: string; error_message: string }): void;
}
export interface ErrorAppendEffects {
  appendError(input: { message: string; goalId?: string; cardId?: string; phase: string }): void;
}
export interface RuntimeRunEffects {
  updateRuntimeRun(runId: string, updates: Partial<RuntimeRunRecord>): RuntimeRunRecord | null;
  publishRuntimeRun(run: RuntimeRunRecord): void;
}
export interface RuntimeTransitionEffects {
  transitionRuntime(event: string, details: Record<string, unknown>): Promise<unknown>;
}
export interface CardReadEffects { readCard(cardId: string): CardRecord | null }
export interface CardCompletionEffects {
  appendChildUnwindToolResult(cardId: string, outcome: string, summary: string): void;
  emitCardFailed(cardId: string, goalId: string): void;
}
```

**Validation:** `npm run validate:routine`, `npm test`. Phase handlers are well-tested; type checking confirms composition is correct.

---

## Batch C: Planning Blockers Structured Matching (F18) + Agent Loop Timeout (F32) + Stuck Agent Supervisor Disable (F33)

These three runtime-dispatch fixes share file proximity in `src/runtime/`.

### F18: Replace substring matching with discriminated union

**File changes:**

| File | Action |
|------|--------|
| `src/schemas/runtime-state.ts` (or wherever `PlannerBlockedResult` lives) | **Modify.** Add a `blocker_cause` discriminated-union field to `PlannerBlockedResult`: `blocker_cause?: 'reviewer_unavailable' \| 'token_budget_exceeded' \| 'terminal_tool_exhaustion' \| 'generic'`. Use `resume_reason` as string display detail. |
| `src/runtime/planning-blockers.ts` | **Modify.** Replace `isReviewerCapacityPlannerBlocker` substring matching with `blocker_cause === 'reviewer_unavailable'`. Add a `classifyBlockerCause(reason: string \| null \| undefined, error?: string): BlockerCause` function that sets `blocker_cause` from known patterns, falling back to `'generic'`. Keep the old `isReviewerCapacityPlannerBlocker` as a deprecated wrapper for one release. |
| `src/runtime/phases/planner-phase.ts` | **Modify.** Use `classifyBlockerCause` to set `blocker_cause` in `buildPlannerInvocationFailureBlocker`, `buildPlannerBlockedDecision`. |
| `src/runtime/phases/planner-invocation-failure.ts` | **Modify.** Set `blocker_cause` in planner failure handling. |

### F32: Per-iteration timeout for planner loop

**File changes:**

| File | Action |
|------|--------|
| `src/runtime/runtime-planner-dispatcher.ts` | **Modify.** Add `ITERATION_TIMEOUT_MS = 600_000` (10 min, configurable via `RuntimeConfig`). In `runPlannerLoop`, wrap each iteration with `Promise.race([iterationPromise, timeoutPromise])`. On timeout, emit a diagnostic and treat as `planner_failure_handled`. |
| `src/agents/invocation-outcome.ts` | **Modify.** Make `RepairBudget` immutable: change `consumed: number` to `readonly consumed: number`, add `withConsumed(n: number): RepairBudget` that returns a new instance. All callers that mutate `consumed` now use `budget = budget.withConsumed(budget.consumed + 1)` or similar. |
| `src/runtime/runtime-config.ts` | **Modify.** Add `iterationTimeoutMs?: number` to `RuntimeConfig`. Default `600_000`. |

### F33: Disable stuck-agent supervisor in production

**File changes:**

| File | Action |
|------|--------|
| `src/runtime/stuck-agent-supervisor.ts` | **Modify.** Change `DEFAULT_SUPERVISOR_CONFIG.enabled` from `true` to `false`. Add a code-level comment: "The stuck supervisor is dormant until a real ChecksProvider is wired. Starting a no-op timer in production wastes resources and logs noise." |
| `src/agents/config-schema.ts` | **Modify.** Change `supervisorSectionSchema` `enabled` default from `true` to `false`. |
| `src/runtime/runtime.ts` | **No change needed.** The `start()` method already checks `this._config.enabled` and returns early if false. Setting the default to false means production creates but never starts the timer. |

**Validation:** `npm run validate:routine`, `npm test`. Add a test that `DEFAULT_SUPERVISOR_CONFIG.enabled === false`. Add a test that `classifyBlockerCause` on known strings returns the correct cause.

---

## Batch D: Config Schema Split (F21) + LLM Transport Credential Extraction (F27) + Agent Setter Injection (F26)

These share proximity in `src/agents/` and concern separation.

### F21: Split config-schema.ts into focused modules

**File changes:**

| File | Action |
|------|--------|
| `src/agents/config/schema.ts` | **New.** Pure Zod schemas, type exports, and `SaivageConfig` type. Contents: legacy-key normalization preprocessors, `modelsSectionSchema`, `providerEntrySchema`, `serverSectionSchema`, `runtimeSectionSchema`, `securitySectionSchema`, `supervisorSectionSchema`, `telegramSectionSchema`, `notificationsSectionSchema`, `mcpServerEntrySchema`, `saivageConfigSchema`, derived types. |
| `src/agents/config/load.ts` | **New.** `loadConfig(projectRoot, env): ConfigLoadResult` — file reading, env interpolation, Zod validation, legacy migration call. Imports schemas from `./schema.js`. |
| `src/agents/config/migrations.ts` | **New.** `migrateLegacyRuntimeSection`, `normalizeLegacyRootConfig`, `LEGACY_RUNTIME_KEYS`. Called by `load.ts`. |
| `src/agents/config/selectors.ts` | **New.** `getModelParamsForRole`, `getModelListForRole`, `resolveTokenEndpoint`, `ModelParams` type. Pure functions that take `SaivageConfig` and role string. |
| `src/agents/config-schema.ts` | **Modify.** Replace entire file with re-exports: `export * from './config/schema.js'; export * from './config/load.js'; export * from './config/migrations.js'; export * from './config/selectors.js';` This preserves all external imports. Remove in a later cleanup pass. |

New `src/agents/config/` directory must be created.

### F27: Extract OAuth credential refreshers from llm-transport.ts

**File changes:**

| File | Action |
|------|--------|
| `src/agents/credential-refreshers.ts` | **New.** Move `refreshOpenAICodexProfile` and `refreshGitHubCopilotProfile` from `llm-transport.ts`. Export a `CredentialRefreshers` interface: `{ refresh(profileName: string, profile: AuthProfile): Promise<AuthProfile \| null> }`. Implementations: `OpenAICodexCredentialRefresher`, `GitHubCopilotCredentialRefresher`. |
| `src/agents/llm-transport.ts` | **Modify.** Remove `refreshOpenAICodexProfile`, `refreshGitHubCopilotProfile`, and the two hardcoded OAuth constants. `usableProfileAccessToken` calls the injected `CredentialRefreshers` instead. `resolveLlmTransportConfig` accepts an optional `CredentialRefreshers` parameter. |

### F26: Constructor-inject required AgentAdapter dependencies

**File changes:**

| File | Action |
|------|--------|
| `src/agents/agent-adapter.ts` | **Modify.** Move `llmCallFn`, `config`, and `projectRoot` from setter injection to constructor parameters. Make them `readonly` fields. Remove `setLlmCallFn()`, `setConfig()`, `setProjectRoot()` setters (or deprecate with a log warning). Keep optional setters for `setActivationLedger`, `setContentSupervisor`, `setMcpManager`, `setSkillsEngine`, `setAfterSessionCreatedHook` (these are legitimately late-bound). |
| `src/application/runtime-composition.ts` | **Modify.** Construction of `AgentAdapter` now passes required deps through constructor. Remove `RuntimeApplication.analystDeps` re-building on every access — cache the result or compute once. |

**Validation:** `npm run validate:routine`, `npm test`. Imports across codebase are preserved by the barrel re-export.

---

## Batch E: Operator API Boilerplate (F15) + Re-export Barrel Cleanup (F16) + Process Runner (F25) + Content Supervisor (F28) + Heuristic Scanner (F29)

These are local refactorings with no cross-cutting dependencies.

### F15: Route factory for operator API contracts

**File changes:**

| File | Action |
|------|--------|
| `src/contracts/operator-api-core.ts` | **Modify.** Add a `defineRoute<D, R>(spec: { id: string; method: string; path: string; params?: ZodType<D>; query?: ZodType<Q>; body?: ZodType<B>; response: ZodType<R>; auth?: 'public' \| 'protected'; summary?: string })` function that derives `successSchemaName`, `responseMap`, and auth metadata from the compact spec. Helper derives `201/200` success and `400/401/403/500` error maps by convention. |
| `src/contracts/operator-api-runtime-cards.ts` and all other `operator-api-*.ts` files | **Modify.** Replace verbose route definitions with `defineRoute()` calls. Reduce ~30–40% boilerplate per route. |

### F16: Delete re-export barrels and convert stateless classes to functions

**Files to delete (and update their importers):**

| File to delete | Importers to update |
|---|---|
| `src/agents/llm-errors.ts` | 3 files: `tests/runtime/planner-context-length-blocker.test.ts`, `tests/agents/llm-codex-parser-context-length.test.ts`, `src/scripts/probe-llm-contract.ts`. Change to import from `./llm-failure.js` and `../redaction/index.js` directly. |
| `src/agents/default-agent-execution.ts` | No importers found. Delete. |
| `src/agents/fake-agent.ts` | 14 test files import from this. Change all to import from `../runtime/fake-agent.js` directly. |
| `src/agents/system-prompt.ts` | 3 test files import from this. Change to import from `../contracts/system-prompt.js` directly. |
| `src/agents/session-persistence.ts` | 11 test files import from this. Change to import from `../runtime/session-persistence.js` directly. |
| `src/agents/tool-api.ts` | 3 files: `tests/analyst.test.ts`, `src/cli.ts`, `tests/utils/agents-module-boundary.test.ts`. Change to import from `../tools/analyst-card-tools.js`, `../tools/definitions/index.js`, etc. directly. |
| `src/agents/agent-tool-catalog.ts` | Convert `AgentToolCatalog` class to plain named functions: `roleToolNames(role)`, `isPlannerTool(name)`, `isPlannerControlTool(name)`, `isWorkspaceTool(name)`, `toolDefinitionFor(name)`. Update `src/agents/agent-tool-executor.ts` (6 call sites) and 3 test files. |

**Runner classes to convert:**

| File | Action |
|---|---|
| `src/runtime/phases/planner-iteration-runner.ts` | Convert `PlannerIterationRunner` class (1 method: `run`) to `runPlannerIteration(deps, input)` plain function. Update caller in `runtime-planner-dispatcher.ts`. |
| `src/runtime/phases/planner-activation-runner.ts` | Convert `PlannerActivationRunner` class (1 method: `activate`) to `runPlannerActivation(deps, goalId)` plain function. Update caller in `runtime-planner-dispatcher.ts`. |

### F25: Process runner cleanup

**File changes:**

| File | Action |
|------|--------|
| `src/runtime/process-runner.ts` | **Modify.** (1) Extract `auditProcessReconciliation` to use an injected `EventLogger` instead of constructing a new one per call (lines 780–813). Pass `EventLogger` as a parameter. (2) Merge `ProcessRunnerService` class methods with their module-level `*ForService` function counterparts — move the function bodies into the class methods and delete the `*ForService` functions. The class already stores `projectRoot` and `processRecords`; the module-level functions just pass `service.projectRoot` or `service` as first arg. Keep the module-level `serviceFor()` factory and `disposeProcessRuntimeScope()` for backward compat, but mark them `@internal`. |

### F28: Content supervisor pass-recording off by default

**File changes:**

| File | Action |
|------|--------|
| `src/workspace/content-supervisor.ts` | **Modify.** Add `recordPasses?: boolean` to `ContentSupervisorConfig` (default `false`). In `screenContent`, only call `recordContentPass` when `this.config.recordPasses === true`. |
| `src/workspace/quarantine.ts` | **Modify.** `appendJsonl` — switch from read-whole-file-rewrite to append-only file descriptor write using `fs.createWriteStream(path, { flags: 'a' })` wrapped in the project lock. This is safe for single-writer under lock. Eliminates the quadratic cost of reading the full file on every append. |

### F29: Heuristic scanner pattern data extraction

**File changes:**

| File | Action |
|------|--------|
| `src/workspace/heuristic-patterns.ts` | **New.** Export `PATTERN_DEFS: PatternDef[]` — the full pattern definition array moved from `heuristic-scanner.ts`. This is a data-only module. |
| `src/workspace/heuristic-scanner.ts` | **Modify.** Remove the inline `PATTERN_DEFS` array (lines 89–662). Import from `./heuristic-patterns.js`. Change `COMPILED_PATTERNS` from module-level eager compile to a lazy singleton: `let compiled: Pattern[] | null = null; export function getCompiledPatterns(): Pattern[] { return compiled ??= compile(PATTERN_DEFS); }`. Update `scanContent` to call `getCompiledPatterns()` instead of `COMPILED_PATTERNS`. Keep `compile()` function as a local utility for the export. Add a `validatePatterns(): void` function that eagerly compiles and throws if any pattern is invalid — call this only from tests. |
| `tests/workspace/heuristic-scanner.test.ts` (or similar) | **Modify.** Call `validatePatterns()` in a dedicated test case. |

**Validation:** `npm run validate:routine`, `npm test`, `npm run validate:ui-smoke`. Each sub-change is independently testable.

---

## Batch F: Frontend Sync Flatten (F19)

### F19: Remove SyncClient class, fold into Pinia store

**File changes:**

| File | Action |
|------|--------|
| `web/src/sync/client.ts` | **Delete.** Move all logic into `web/src/stores/sync.ts`. |
| `web/src/stores/sync.ts` | **Modify.** Replace `SyncClient` pass-through with direct Vue reactivity. Import `WsConnectionManager` from `../api/websocket.ts`. Use `ref()` for `connectionState`, `lastConnectedAt`, `lastEventAt`. Use a `Map<string, SyncResourceRegistration>` and `Map<string, () => Promise<void>>` for resource/conversation registration. Port the flight deduplication (`runSingleFlight`) logic directly. Remove the dependency on `SyncClient`. |
| `web/src/api/websocket.ts` | **No change needed.** `WsConnectionManager` already exposes `onState`, `onOpen`, `onSyncFrame`, `onEvent`, `connect`, `disconnect`, `sendRaw`, `sendMessage`, and `makeRef` state observation. The Pinia store directly uses these methods. |
| All files importing from `web/src/sync/client.ts` | **Modify.** Change imports to `web/src/stores/sync.ts`. This includes any component or store that uses `syncClient` or `SyncClient`. Search the codebase for `sync/client` or `SyncClient`. |

**Key design:**

```typescript
// web/src/stores/sync.ts
import { ref, computed } from 'vue';
import { getWsConnection } from '../api/websocket';
import type { SyncResourceRegistration, LiveSyncInvalidateFrame, WsConnectionState } from '../api/types';

export const useSyncStore = defineStore('sync', () => {
  const connectionState = ref<WsConnectionState>('offline');
  const lastConnectedAt = ref<string | null>(null);
  const lastEventAt = ref<string | null>(null);
  const resources = new Map<string, SyncResourceRegistration>();
  const conversations = new Map<string, () => Promise<void>>();
  const flights = new Map<string, FlightState>();
  let started = false;
  let conn: WsConnectionManager | null = null;

  function start(): void { ... }   // sets up conn.onState, conn.onOpen, conn.onSyncFrame, conn.onEvent
  function stop(): void { ... }
  function registerResource(reg: SyncResourceRegistration): () => void { ... }
  function openConversation(sessionId: string, refetch: () => Promise<void>): () => void { ... }
  // ... runSingleFlight ported directly
});
```

**Validation:** `npm run validate:ui-smoke`, `npm run validate:ui`. Manual: open control room, verify sync reactivity, conversation opening, resource refetch.

---

## Implementation Sequence

Steps are ordered by dependency and risk. Each step is a minimal compilable commit.

| Step | Batch | Issue(s) | Summary |
|------|-------|---------|---------|
| 1 | C | F33 | Disable stuck agent supervisor by default. Low risk, one-line config change. |
| 2 | E | F29 | Extract heuristic patterns to data module, lazy-compile. Self-contained module split. |
| 3 | E | F28 | Make content pass-recording opt-in. Add `recordPasses` config flag. Fix quarantine append. |
| 4 | E | F16 | Delete re-export barrels, update importers. Convert `AgentToolCatalog` class to functions. Convert runner classes to functions. |
| 5 | B | F06 | Create `effects-ports.ts`, refactor phase effects interfaces. |
| 6 | C | F18 | Add `blocker_cause` discriminated union, replace substring matching. |
| 7 | C | F32 | Add iteration timeout to planner loop, make `RepairBudget` immutable. |
| 8 | D | F21 | Split `config-schema.ts` into `config/` directory. |
| 9 | D | F27 | Extract credential refreshers from `llm-transport.ts`. |
| 10 | D | F26 | Constructor-inject required `AgentAdapter` dependencies. Cache `analystDeps`. |
| 11 | A | F07 | Create `runtime-event-ledger.ts` and `runtime-state-view.ts`. Add migration. |
| 12 | A | F07 | Wire ledger into `state.ts` and `mutations.ts`. Replace array-append mutations with ledger events. |
| 13 | E | F15 | Add `defineRoute` factory, refactor operator API contracts. |
| 14 | E | F25 | Inject `EventLogger` into `auditProcessReconciliation`, merge class/function indirection in process-runner. |
| 15 | F | F19 | Delete `SyncClient`, fold into Pinia store. |

---

## Dependency Notes

- **F07 depends on nothing else in Wave 6** but is the largest change. Steps 11–12 should be reviewed carefully.
- **F06** (effects ports) should be done before or alongside any phase refactor that might add more phase handlers.
- **F21** (config split) must preserve all existing import paths through the barrel re-export until all importers are migrated.
- **F16** (barrel cleanup) can be done independently but should be done before F26 since F26 changes `agent-adapter.ts` imports.
- **F19** (frontend sync) is entirely frontend-scoped and can happen in parallel with any backend change.

---

## Validation Per Batch

| Batch | Commands | Manual checks |
|-------|----------|---------------|
| A | `npm run validate:routine`, `npm test` | Start runtime, dispatch goals, kill/restart, verify ledger growth and bounded state |
| B | `npm run validate:routine`, `npm test` | Phase handler tests pass |
| C | `npm run validate:routine`, `npm test` | Planner loop, blocker classification, supervisor disabled |
| D | `npm run validate:routine`, `npm test` | Config loading, credential resolution, agent construction |
| E | `npm run validate:routine`, `npm test`, `npm run validate:ui-smoke` | API routes, pattern scanning, quarantine I/O |
| F | `npm run validate:ui`, `npm run validate:ui-smoke` | Control room sync, conversation, resource refetch |

Final validation: `npm run validate:release`.
