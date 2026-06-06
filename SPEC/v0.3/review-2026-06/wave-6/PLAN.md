# Wave 6: Targeted Fixes & Cleanup — Implementation Plan

Generated: 2026-06-06

Batched into 6 independent groups by file proximity and dependency. Each batch is a minimal compilable commit.

---

## Batch A: Runtime State Ledger Migration (F07)

This is the most structurally significant Wave 6 item. The goal: refactor runtime state array management as a locked projection behind `RuntimeStateMutationPort`. Rather than growing `runtime_commands`, `runtime_runs`, and `runtime_activations` as unbounded arrays, maintain an append-only event ledger and derive a compact current-state view. Runtime arrays stay as bounded current-state projection fields because API contracts consume them. Use internal caps unless config demand exists. Migration must be idempotent.

### Design

**Data model:**

- New file: `src/persistence/runtime-event-ledger.ts` — append-only JSONL ledger for `runtime_command`, `runtime_run`, `runtime_activation` events.
- New file: `src/persistence/runtime-state-view.ts` — reads the ledger at startup, produces a compact `RuntimeState` with only current/active entries for each array, plus a `ledger_seqno` watermark. This is a locked projection behind `RuntimeStateMutationPort`, not a long-lived in-memory view.

**Ledger event types (discriminated union):**

```
runtime_command_accepted  { command_id, command, status, requested_at, source }
runtime_command_updated  { command_id, status, completed_at?, error? }
runtime_run_appended     { ...RuntimeRunRecord }
runtime_run_updated      { run_id, ...partial updates }
runtime_activation_upserted { ...RuntimeActivationRecord }
```

**Current-state view derivation:**

- `runtime_commands`: keep only the latest N (internal cap, default 50), ordered by `requested_at`.
- `runtime_runs`: keep only runs with `runtime_status` in `['running', 'pending']`, plus the latest N terminal runs for history.
- `runtime_activations`: keep only activations with status in unresolved set, plus the latest N terminal activations.
- View is rebuilt on startup from ledger, then incrementally maintained from events arriving through `mutations.apply()`.
- Ledger events cover all array-affecting mutations. Scalar patches stay in `runtime.json` unless fully event-sourcing runtime state.

**Migration:**

- At startup, if `runtime.json` has legacy full arrays, compact them: write the historical entries to the ledger, then rewrite the state file with only the current-view entries. This runs in `performRuntimeStartup()` after read/init and before repair/reconciliation. Migration must be idempotent.
- The ledger file is `.saivage/runtime-events.jsonl`. Every append uses the project lock.

**File changes:**

| File | Action |
|------|--------|
| `src/persistence/runtime-event-ledger.ts` | **New.** `RuntimeEventLedger` class: `append(event)`, `read(fromSeqno?)`, `compact()`. Uses project lock for atomic appends. |
| `src/persistence/runtime-state-view.ts` | **New.** `RuntimeStateView` class: `rebuildFromLedger()`, `applyEvent()`, `current()`. Produces compact `RuntimeState` arrays. |
| `src/runtime/state.ts` | **Modify.** Remove `appendRuntimeCommand`, `appendRuntimeRun`, `updateRuntimeRun`, `upsertRuntimeActivation` as state-array mutators. Replace with calls to `RuntimeEventLedger.append()` + `RuntimeStateView.applyEvent()`. Keep `readRuntimeState`, `saveRuntimeState`, `updateRuntimeState`, `initRuntimeState` as thin wrappers over the view. Add `migrateLegacyRuntimeStateArrays()` that writes arrays to ledger and rewrites state file compact. Authoritative state file is `.saivage/runtime.json` (`AUTHORITATIVE_STATE_FILE = 'runtime.json'`). |
| `src/runtime/mutations.ts` | **Modify.** Mutation handlers for `runtime_command`, `runtime_run`, `runtime_activation` patches emit ledger events instead of mutating arrays. |
| `src/runtime/runtime-run-ledger.ts` | **Modify.** Adapt `RuntimeRunLedger` to emit ledger events instead of mutation calls. `RuntimeRunLedger` uses `RuntimeStateMutationPort.mutations.apply()` — it does not have its own JSONL append. |
| `src/runtime/runtime-services.ts` | **No change.** Do not add ledger/view to `RuntimeServices`. Ledger injection goes through the deps pattern: add ledger/view fields to `RuntimePlannerDispatcherDeps` and other phase handler deps, not to `RuntimeServices` directly. |
| `src/runtime/runtime.ts` | **Modify.** In `performRuntimeStartup()`, after read/init and before repair/reconciliation, call `migrateLegacyRuntimeStateArrays()`. |
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

Extract composable effects interfaces to eliminate partial overlap between phase handler effects. Effect ports preserve literal constraints and keep exported effect type names as aliases for tests.

### Design

Define small, focused port interfaces. Each phase composes exactly the ports it needs. Phase files import ports and compose them into their local effects interface.

**File changes:**

| File | Action |
|------|--------|
| `src/runtime/effects-ports.ts` | **New.** Define composable ports: `ClockEffects { now(): string }`, `CardTransitionEffects { transitionCard(cardId: string, event: string, details: Record<string, unknown>): Promise<unknown> }`, `CardPatchEffects { updateCard(cardId: string, patch: Partial<CardRecord>): Promise<unknown> \| unknown }`, `RuntimeDiagnosticEffects { emitRuntimeDiagnostic(input: RuntimeDiagnosticInput): void; appendRuntimeDiagnostic(input: { goal_id: string; phase: string; error_message: string }): void }`, `ErrorAppendEffects { appendError(input: { message: string; goalId?: string; cardId?: string; phase: string }): void }`, `RuntimeRunEffects { updateRuntimeRun(runId: string, updates: Partial<RuntimeRunRecord>): RuntimeRunRecord \| null; publishRuntimeRun(run: RuntimeRunRecord): void }`, `RuntimeTransitionEffects { transitionRuntime(event: string, details: Record<string, unknown>): Promise<unknown> }`, `CardReadEffects { readCard(cardId): CardRecord \| null }`, `CardCompletionEffects { appendChildUnwindToolResult(cardId: string, outcome: string, summary: string): void; emitCardFailed(cardId: string, goalId: string): void }`. `RuntimeDiagnosticInput` is a union type: `{ goal_id: string; phase: 'reviewer'; error: unknown } \| { card_id: string; goal_id: string; phase: 'executor'; error: unknown } \| { goal_id: string; phase: 'planner'; error: unknown }` etc., where each phase narrows the type. `transitionCard` uses `string` at the port boundary; callers widen their literal types (`'block'`, `'fail'`, `'executor_finish'`). |
| `src/runtime/phases/reviewer-invocation-failure.ts` | **Modify.** `ReviewerInvocationFailureEffects` becomes an intersection type of `ClockEffects & CardTransitionEffects & CardPatchEffects & RuntimeDiagnosticEffects & ErrorAppendEffects & RuntimeTransitionEffects` plus local `finishOpenPlannerRun`. Remove the explicit interface definition; import ports from `effects-ports.ts`. |
| `src/runtime/phases/executor-invocation-failure.ts` | **Modify.** `ExecutorInvocationFailureEffects` becomes intersection of `ClockEffects & CardTransitionEffects & CardPatchEffects & RuntimeDiagnosticEffects & ErrorAppendEffects & CardCompletionEffects` plus `clearActiveCardRun`. |
| `src/runtime/phases/executor-completion-handler.ts` | **Modify.** `ExecutorCompletionEffects` becomes intersection of `ClockEffects & CardTransitionEffects & CardPatchEffects & CardReadEffects & CardCompletionEffects`. |
| `src/runtime/phases/planner-invocation-failure.ts` | **Modify.** `PlannerInvocationFailureEffects` becomes intersection of `ClockEffects & CardTransitionEffects & CardPatchEffects & RuntimeDiagnosticEffects & ErrorAppendEffects & RuntimeRunEffects & RuntimeTransitionEffects`. |
| `src/runtime/phases/reviewer-assessment-handler.ts` | **Modify.** `ReviewerAssessmentEffects` becomes intersection of `ClockEffects & CardReadEffects & CardTransitionEffects & CardPatchEffects & RuntimeTransitionEffects` plus local event emissions. |
| `src/runtime/startup-repair.ts` | **Modify.** `StartupActiveRunRepairEffects` uses `ClockEffects & CardTransitionEffects & CardPatchEffects` plus its unique methods: `repairOrphanActivateCardToolCalls`, `repairTerminalLifecycle`, `appendChildUnwindToolResult`, `parentPlannerRunFor`, `findCallerEdge`, `synthesizeTerminalActivationResult`, `finishOpenPlannerRun`, `queueSyntheticPlannerNote`, `saveState`. |

**Key function signatures:**

```typescript
// src/runtime/effects-ports.ts
export type RuntimeDiagnosticInput =
  | { goal_id: string; phase: 'reviewer'; error: unknown }
  | { card_id: string; goal_id: string; phase: 'executor'; error: unknown }
  | { goal_id: string; phase: 'planner'; error: unknown };

export interface ClockEffects { now(): string }
export interface CardTransitionEffects {
  transitionCard(cardId: string, event: string, details: Record<string, unknown>): Promise<unknown>;
}
export interface CardPatchEffects {
  updateCard(cardId: string, patch: Partial<CardRecord>): Promise<unknown> | unknown;
}
export interface RuntimeDiagnosticEffects {
  emitRuntimeDiagnostic(input: RuntimeDiagnosticInput): void;
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

**Validation:** `npm run validate:routine`, `npm test`. Phase handlers are well-tested; type checking confirms composition is correct. Keep exported effect type names as aliases for tests.

---

## Batch C: Planning Blockers Structured Matching (F18) + Agent Loop Timeout (F32) + Stuck Agent Supervisor Disable (F33)

These three runtime-dispatch fixes share file proximity in `src/runtime/`.

### F18: Replace substring matching with discriminated union

`PlannerBlockedResult` is in `src/schemas/lifecycle.ts` (lines 45–49), not `src/schemas/runtime-state.ts`. Set `blocker_cause` at blocker creation time in `buildPlannerBlockedDecision`/`buildPlannerInvocationFailureBlocker`, then runtime just reads the field. No runtime `classifyBlockerCause` function is needed. Delete the substring helper after call sites update.

**File changes:**

| File | Action |
|------|--------|
| `src/schemas/lifecycle.ts` | **Modify.** Add a `blocker_cause` discriminated-union field to `PlannerBlockedResult`: `blocker_cause?: 'reviewer_unavailable' \| 'token_budget_exceeded' \| 'terminal_tool_exhaustion' \| 'generic'`. Use `resume_reason` as string display detail. |
| `src/runtime/planning-blockers.ts` | **Modify.** Replace `isReviewerCapacityPlannerBlocker` substring matching with `blocker_cause === 'reviewer_unavailable'`. Set `blocker_cause` in `buildPlannerBlockedDecision`/`buildPlannerInvocationFailureBlocker`. Delete the `classifyBlockerCause` function — cause is assigned at creation time, not classified after the fact. Keep the old `isReviewerCapacityPlannerBlocker` as a deprecated wrapper for one release. |
| `src/runtime/phases/planner-phase.ts` | **Modify.** Set `blocker_cause` in `buildPlannerInvocationFailureBlocker`, `buildPlannerBlockedDecision`. |
| `src/runtime/phases/planner-invocation-failure.ts` | **Modify.** Set `blocker_cause` in planner failure handling. |

### F32: Per-iteration timeout for planner loop

Bare `Promise.race` is explicitly insufficient. Must pass `AbortController` / `AbortSignal` through to `AgentAdapter.invokeAgent()` and cancel the underlying LLM call on timeout. `ITERATION_TIMEOUT_MS` is a default fallback in `RuntimeConfig`, not a standalone constant. Consider deferring the timeout wrapper until the cancellation design is decided; make `RepairBudget` immutable now regardless.

**File changes:**

| File | Action |
|------|--------|
| `src/runtime/runtime-planner-dispatcher.ts` | **Modify.** Add `iterationTimeoutMs` to `RuntimeConfig` (default fallback 600 000 ms, i.e. 10 min). In `runPlannerLoop`, create an `AbortController` on timeout and pass its signal through to the iteration. On timeout, emit a diagnostic and treat as `planner_failure_handled`. (Consider deferring this timeout wrapper until cancellation design is decided; at minimum, ensure the AbortSignal plumbing is in place.) |
| `src/agents/agent-adapter.ts` | **Modify.** `invokeAgent()` accepts an optional `AbortSignal` parameter, passed through to the underlying LLM call for cooperative cancellation. |
| `src/agents/invocation-outcome.ts` | **Modify.** Make `RepairBudget` immutable: change `consumed: number` to `readonly consumed: number`, add `withConsumed(n: number): RepairBudget` that returns a new instance. All callers that mutate `consumed` now use `budget = budget.withConsumed(budget.consumed + 1)` or similar. This change is independent of the timeout mechanism. |
| `src/runtime/runtime-config.ts` | **Modify.** Add `iterationTimeoutMs?: number` to `RuntimeConfig`. Default `600_000`. |

### F33: Disable stuck-agent supervisor in production

**File changes:**

| File | Action |
|------|--------|
| `src/runtime/stuck-agent-supervisor.ts` | **Modify.** Change `DEFAULT_SUPERVISOR_CONFIG.enabled` from `true` to `false`. Add a code-level comment: "The stuck supervisor is dormant until a real ChecksProvider is wired. Starting a no-op timer in production wastes resources and logs noise." |
| `src/agents/config-schema.ts` | **Modify.** Change `supervisorSectionSchema` `enabled` default from `true` to `false`. |
| `src/runtime/runtime.ts` | **No change needed.** The `start()` method already checks `this._config.enabled` and returns early if false. Setting the default to false means production creates but never starts the timer. |

**Validation:** `npm run validate:routine`, `npm test`. Add a test that `DEFAULT_SUPERVISOR_CONFIG.enabled === false`. Add a test that `blocker_cause` on known blocker patterns returns the correct cause when set at creation time. Include config parsing validation and no-start-event default coverage.

---

## Batch D: Config Schema Split (F21) + LLM Transport Credential Extraction (F27) + Agent Setter Injection (F26)

These share proximity in `src/agents/` and concern separation.

### F21: Split config-schema.ts into focused modules

Must update `src/agents/config-api.ts` — it re-exports `loadConfig`, `normalizeLegacyRootConfig`, `saivageConfigSchema` and types from `config-schema.js`. The new `config/selectors.ts` adds `getModelParamsForRole` and `getModelListForRole`. Avoid open-ended compatibility barrels.

**File changes:**

| File | Action |
|------|--------|
| `src/agents/config/schema.ts` | **New.** Pure Zod schemas, type exports, and `SaivageConfig` type. Contents: legacy-key normalization preprocessors, `modelsSectionSchema`, `providerEntrySchema`, `serverSectionSchema`, `runtimeSectionSchema`, `securitySectionSchema`, `supervisorSectionSchema`, `telegramSectionSchema`, `notificationsSectionSchema`, `mcpServerEntrySchema`, `saivageConfigSchema`, derived types. |
| `src/agents/config/load.ts` | **New.** `loadConfig(projectRoot, env): ConfigLoadResult` — file reading, env interpolation, Zod validation, legacy migration call. Imports schemas from `./schema.js`. |
| `src/agents/config/migrations.ts` | **New.** `migrateLegacyRuntimeSection`, `normalizeLegacyRootConfig`, `LEGACY_RUNTIME_KEYS`. Called by `load.ts`. |
| `src/agents/config/selectors.ts` | **New.** `getModelParamsForRole`, `getModelListForRole`, `ModelParams` type. Pure functions that take `SaivageConfig` and role string. |
| `src/agents/config-schema.ts` | **Modify.** Replace entire file with targeted re-exports matching `config-api.ts` needs: `export { loadConfig, normalizeLegacyRootConfig } from './config/load.js'; export { saivageConfigSchema } from './config/schema.js'; export type { SaivageConfig, ... } from './config/schema.js';`. Do not create an open-ended `export *` barrel. Remove in a later cleanup pass. |
| `src/agents/config-api.ts` | **Modify.** Update re-exports to point to the new `config/` modules. Preserve `loadConfig`, `normalizeLegacyRootConfig`, `saivageConfigSchema` and type exports. Add re-exports for `getModelParamsForRole` and `getModelListForRole` from `./config/selectors.js`. |

New `src/agents/config/` directory must be created.

### F27: Extract OAuth credential refreshers from llm-transport.ts

`CredentialSourceResolver` already exists in `src/agents/credential-source-resolver.ts` (251 lines) and handles provider resolution, delegating to `usableProfileAccessToken` for token refresh. The new `CredentialRefreshers` interface is extracted from `CredentialSourceResolver`. `projectRoot` is needed for persistence. Move all provider-specific constants out of `llm-transport.ts`.

**File changes:**

| File | Action |
|------|--------|
| `src/agents/credential-refreshers.ts` | **New.** Extract `refreshOpenAICodexProfile` and `refreshGitHubCopilotProfile` from `credential-source-resolver.ts`. Export a `CredentialRefreshers` interface: `{ refresh(profileName: string, profile: AuthProfile): Promise<AuthProfile \| null> }`. Implementations: `OpenAICodexCredentialRefresher`, `GitHubCopilotCredentialRefresher`. `CredentialSourceResolver` holds a refresher reference (or `usableProfileAccessToken` is injected with a refresher). `projectRoot` is required for persistence. |
| `src/agents/credential-source-resolver.ts` | **Modify.** Remove `refreshOpenAICodexProfile` and `refreshGitHubCopilotProfile`. Hold a `CredentialRefreshers` reference or inject it into `usableProfileAccessToken`. |
| `src/agents/llm-transport.ts` | **Modify.** Remove `refreshOpenAICodexProfile`, `refreshGitHubCopilotProfile`, and all provider-specific constants: `OPENAI_CODEX_TOKEN_URL` and `OPENAI_CODEX_CLIENT_ID` (named constants) plus the inline GitHub Copilot URL. `usableProfileAccessToken` calls the injected `CredentialRefreshers` instead. `resolveLlmTransportConfig` accepts an optional `CredentialRefreshers` parameter. |

### F26: Constructor-inject required AgentAdapter dependencies

Only `setLlmCallFn` is eliminated. `config` and `projectRoot` are already constructor-injected. Cached `analystDeps` must update on `setMcpManager()`.

**File changes:**

| File | Action |
|------|--------|
| `src/agents/agent-adapter.ts` | **Modify.** Remove `setLlmCallFn()` setter entirely. Keep `config` and `projectRoot` as `readonly` constructor-injected fields (they already are). Keep optional setters for `setActivationLedger`, `setContentSupervisor`, `setMcpManager`, `setSkillsEngine`, `setAfterSessionCreatedHook` (these are legitimately late-bound). |
| `src/application/runtime-composition.ts` | **Modify.** Construction of `AgentAdapter` already passes `config` and `projectRoot` through constructor. Remove dead `setConfig()`/`setProjectRoot()` calls if any remain. Cache `analystDeps` result or compute once; invalidate the cache when `setMcpManager()` is called. |

**Validation:** `npm run validate:routine`, `npm test`. Imports across codebase are preserved by the targeted re-exports in `config-schema.ts` and `config-api.ts`.

---

## Batch E: Operator API Boilerplate (F15) + Re-export Barrel Cleanup (F16) + Process Runner (F25) + Content Supervisor (F28) + Heuristic Scanner (F29)

These are local refactorings with no cross-cutting dependencies.

### F15: Route factory for operator API contracts

The factory must preserve the current `ContractAuthClass`, explicit response overrides, route errors, permissions, and audit metadata. `permissions` is an async function type, not convention-derivable.

**File changes:**

| File | Action |
|------|--------|
| `src/contracts/operator-api-core.ts` | **Modify.** Add a `defineRoute<D, R>(spec: { id: string; method: string; path: string; params?: ZodType<D>; query?: ZodType<Q>; body?: ZodType<B>; response: ZodType<R>; auth?: 'public' \| 'protected'; summary?: string; permissions?: (ctx: RequestContext) => Promise<boolean> })` function that preserves `ContractAuthClass`, explicit response overrides, route errors, permissions (as the async function type), and audit metadata. Helper derives `201/200` success and `400/401/403/500` error maps by convention, but `permissions` and auth metadata are passed through as-is. |
| `src/contracts/operator-api-runtime-cards.ts` and all other `operator-api-*.ts` files | **Modify.** Replace verbose route definitions with `defineRoute()` calls. Reduce ~30–40% boilerplate per route. |

### F16: Delete re-export barrels and convert stateless classes to functions

Use `rg` to count importers before deletion. Preserve/move `redactProviderErrorText` before deleting the `llm-errors.ts` barrel. `llm-errors.ts` has 9 source importers, not 3.

**Files to delete (and update their importers):**

| File to delete | Importers to update |
|---|---|
| `src/agents/llm-errors.ts` | 9 files: `src/llm-openai-codex-gateway.ts`, `src/llm-openai-chat-gateway.ts`, `src/llm-failure-classifiers.ts`, `src/llm-codex-parser.ts`, `src/llm-recording.ts`, `src/llm-stream-parser.ts`, `src/llm-provider-gateway.ts`, `src/runtime/invocation-recovery-policy.ts`, `src/scripts/probe-llm-contract.ts`. Only `llm-failure-classifiers.ts` and `llm-codex-parser.ts` import `redactProviderErrorText`; move `redactProviderErrorText` to `llm-failure.ts` or `redaction/index.ts`. Others import `LlmRequestError` or `unwrapFailure` — change to import from `./llm-failure.js` and `../redaction/index.js` directly. |
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
| `src/runtime/process-runner.ts` | **Modify.** (1) Extract `auditProcessReconciliation` to use an injected `EventLogger` instead of constructing a new one per call (lines 780–813). Pass `EventLogger` as a parameter — make it optional, inject it only when available. (2) Merge `ProcessRunnerService` class methods with their module-level `*ForService` function counterparts — move the function bodies into the class methods and delete the `*ForService` functions. The class already stores `projectRoot` and `processRecords`; the module-level functions just pass `service.projectRoot` or `service` as first arg. Keep the module-level `serviceFor()` factory and `disposeProcessRuntimeScope()` for backward compat, but mark them `@internal`. |

### F28: Content supervisor pass-recording off by default

There are three `recordContentPass` call sites in `screenContent` (lines 142, 158, 230), not one. All three need the `recordPasses` guard.

**File changes:**

| File | Action |
|------|--------|
| `src/workspace/content-supervisor.ts` | **Modify.** Add `recordPasses?: boolean` to `ContentSupervisorConfig` (default `false`). In `screenContent`, guard all three `recordContentPass` call sites (lines 142, 158, 230) with `this.config.recordPasses === true`. |
| `src/workspace/quarantine.ts` | **Modify.** `appendJsonl` — switch from read-whole-file-rewrite to append-only file descriptor write using `fs.createWriteStream(path, { flags: 'a' })` wrapped in the project lock with sync `fsync`. This is safe for single-writer under lock. Eliminates the quadratic cost of reading the full file on every append. |

### F29: Heuristic scanner pattern data extraction

`COMPILED_PATTERNS` (line 687) and `PATTERNS_BY_CATEGORY` (line 697) are both module-level eager state. Both must become lazy or be derived from `PATTERN_DEFS`. Scanner continues to export `scanContent`, `isInjectionSuspicious`, `SensitivityLevel`, `ScanResult`, `InjectionCategory` as public API. Only `PATTERN_DEFS` moves to `heuristic-patterns.ts`.

**File changes:**

| File | Action |
|------|--------|
| `src/workspace/heuristic-patterns.ts` | **New.** Export `PATTERN_DEFS: PatternDef[]` — the full pattern definition array moved from `heuristic-scanner.ts`. This is a data-only module. |
| `src/workspace/heuristic-scanner.ts` | **Modify.** Remove the inline `PATTERN_DEFS` array (lines 89–662). Import from `./heuristic-patterns.js`. Change `COMPILED_PATTERNS` from module-level eager compile to a lazy singleton: `let compiled: Pattern[] \| null = null; export function getCompiledPatterns(): Pattern[] { return compiled ??= compile(PATTERN_DEFS); }`. Similarly make `PATTERNS_BY_CATEGORY` lazy or derive it from `PATTERN_DEFS`. Update `scanContent` to call `getCompiledPatterns()` instead of `COMPILED_PATTERNS`. Keep `compile()` function as a local utility for the export. Add a `validatePatterns(): void` function that eagerly compiles and throws if any pattern is invalid — call this only from tests. Continue exporting `scanContent`, `isInjectionSuspicious`, `SensitivityLevel`, `ScanResult`, `InjectionCategory` as public API. |
| `tests/workspace/heuristic-scanner.test.ts` (or similar) | **Modify.** Call `validatePatterns()` in a dedicated test case. |

**Validation:** `npm run validate:routine`, `npm test`, `npm run validate:ui-smoke`. Each sub-change is independently testable.

---

## Batch F: Frontend Sync Flatten (F19)

### F19: Remove SyncClient class, fold into Pinia store

`SyncResourceRegistration` type is in `web/src/sync/client.ts` (lines 11–14), not in `api/types.ts`. Move it to the store or `api/types.ts`. `SyncClient` imports `useAnalystChat` — this coupling must be preserved in the store. `SyncClient` has a module-level singleton (line 151). When deleting `SyncClient`, the Pinia store manages `WsConnectionManager` lifecycle directly. Preserve public sync store API and rewrite `sync-client.test.ts` into store tests.

**File changes:**

| File | Action |
|------|--------|
| `web/src/sync/client.ts` | **Delete.** Move all logic into `web/src/stores/sync.ts`. Move `SyncResourceRegistration` type to `web/src/stores/sync.ts` or `web/src/api/types.ts`. |
| `web/src/stores/sync.ts` | **Modify.** Replace `SyncClient` pass-through with direct Vue reactivity. Import `WsConnectionManager` from `../api/websocket`. Import `useAnalystChat` (preserving the coupling from `SyncClient`). Use `ref()` for `connectionState`, `lastConnectedAt`, `lastEventAt`. Use a `Map<string, SyncResourceRegistration>` and `Map<string, () => Promise<void>>` for resource/conversation registration. Port the flight deduplication (`runSingleFlight`) logic directly. Manage `WsConnectionManager` lifecycle directly instead of delegating to a module-level `SyncClient` singleton. Remove the dependency on `SyncClient`. Preserve public sync store API. |
| `web/src/api/websocket.ts` | **No change needed.** `WsConnectionManager` already exposes `onState`, `onOpen`, `onSyncFrame`, `onEvent`, `connect`, `disconnect`, `sendRaw`, `sendMessage`, and `makeRef` state observation. The Pinia store directly uses these methods. |
| `web/src/api/types.ts` | **Modify.** Add `SyncResourceRegistration` type here (moved from `sync/client.ts`), or leave it in the store. |
| All files importing from `web/src/sync/client.ts` | **Modify.** Change imports to `web/src/stores/sync.ts`. This includes any component or store that uses `syncClient` or `SyncClient`. Search the codebase for `sync/client` or `SyncClient`. |
| `web/src/sync/client.test.ts` or equivalent | **Modify.** Rewrite tests into store tests in `web/src/stores/sync.test.ts`. |

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
  // ... runSingleFlight ported directly, useAnalystChat coupling preserved
});
```

**Validation:** `npm run validate:ui-smoke`, `npm run validate:ui`. Manual: open control room, verify sync reactivity, conversation opening, resource refetch.

---

## Implementation Sequence

Steps are ordered by dependency and risk. Each step is a minimal compilable commit. Defer F15 and large barrel deletion (F16 runner-class conversions) unless a cleanup-only window exists.

| Step | Batch | Issue(s) | Summary |
|------|-------|---------|---------|
| 1 | C | F33 | Disable stuck agent supervisor by default. Low risk, one-line config change. |
| 2 | E | F29 | Extract heuristic patterns to data module, lazy-compile both `COMPILED_PATTERNS` and `PATTERNS_BY_CATEGORY`. |
| 3 | E | F28 | Make content pass-recording opt-in. Add `recordPasses` config flag. Fix quarantine append with sync/fsync. Guard all three `recordContentPass` call sites. |
| 4 | C | F18 | Add `blocker_cause` discriminated union to `lifecycle.ts`, set at creation time in `buildPlannerBlockedDecision`/`buildPlannerInvocationFailureBlocker`. No runtime `classifyBlockerCause` function. |
| 5 | C | F32 (partial) | Make `RepairBudget` immutable (independent of timeout). Defer timeout wrapper until cancellation/abort design is decided. |
| 6 | D | F21 | Split `config-schema.ts` into `config/` directory. Update `config-api.ts` re-exports. Avoid open-ended compatibility barrels. |
| 7 | D | F27 | Extract credential refreshers from `credential-source-resolver.ts` and `llm-transport.ts`. Move provider-specific constants. |
| 8 | D | F26 | Remove `setLlmCallFn`. Cache `analystDeps`; invalidate on `setMcpManager()`. |
| 9 | B | F06 | Create `effects-ports.ts`, refactor phase effects interfaces with union `RuntimeDiagnosticInput` type. List all `StartupActiveRunRepairEffects` methods explicitly. |
| 10 | A | F07 | Create `runtime-event-ledger.ts` and `runtime-state-view.ts`. Injection through deps pattern, not `RuntimeServices`. |
| 11 | A | F07 | Wire ledger into `state.ts` and `mutations.ts`. Replace array-append mutations with ledger events. Run migration in `performRuntimeStartup()` after read/init, before repair/reconciliation. |
| 12 | E | F25 | Inject `EventLogger` into `auditProcessReconciliation`, merge class/function indirection in process-runner. |
| 13 | F | F19 | Delete `SyncClient`, fold into Pinia store. Move `SyncResourceRegistration` type. Preserve `useAnalystChat` coupling. Rewrite `sync-client.test.ts` into store tests. |
| 14 | E | F15 | Add `defineRoute` factory preserving `ContractAuthClass`, explicit overrides, permissions (async function type), and audit metadata. (Defer unless cleanup-only window.) |
| 15 | E | F16 | Delete re-export barrels, update all 9 `llm-errors.ts` importers. Move `redactProviderErrorText` before deleting barrel. Convert `AgentToolCatalog` class to functions. (Defer unless cleanup-only window.) |

---

## Dependency Notes

- **F07 depends on nothing else in Wave 6** but is the largest change. Steps 10–11 should be reviewed carefully. Ledger injection goes through the deps pattern, not `RuntimeServices` directly.
- **F06** (effects ports) should be done before or alongside any phase refactor that might add more phase handlers.
- **F21** (config split) must preserve all existing import paths through targeted re-exports until all importers are migrated. Avoid open-ended compatibility barrels.
- **F16** (barrel cleanup) can be done independently but should be done before F26 since F26 changes `agent-adapter.ts` imports. Use `rg` to count importers; preserve/move `redactProviderErrorText` before deleting barrel.
- **F19** (frontend sync) is entirely frontend-scoped and can happen in parallel with any backend change. Preserve `useAnalystChat` coupling and public sync store API.
- **F32** timeout wrapper is deferred until cancellation/abort design is decided. `RepairBudget` immutability proceeds independently.

---

## Validation Per Batch

| Batch | Commands | Manual checks |
|-------|----------|---------------|
| A | `npm run validate:routine`, `npm test` | Start runtime, dispatch goals, kill/restart, verify ledger growth and bounded state |
| B | `npm run validate:routine`, `npm test` | Phase handler tests pass |
| C | `npm run validate:routine`, `npm test` | Planner loop, blocker creation, supervisor disabled |
| D | `npm run validate:routine`, `npm test` | Config loading, credential resolution, agent construction |
| E | `npm run validate:routine`, `npm test`, `npm run validate:ui-smoke` | API routes, pattern scanning, quarantine I/O |
| F | `npm run validate:ui`, `npm run validate:ui-smoke` | Control room sync, conversation, resource refetch |

Final validation: `npm run validate:release`.