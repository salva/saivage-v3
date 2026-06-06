# Wave 6: Targeted Fixes & Cleanup — Implementation Plan

Generated: 2026-06-06

Batched into 6 independent groups by file proximity and dependency. Each batch is a minimal compilable commit.

---

## Batch A: Runtime State Ledger Migration (F07)

This is the most structurally significant Wave 6 item. The goal: refactor runtime state array management as a locked projection behind `RuntimeStateMutationPort`. Rather than growing `runtime_commands`, `runtime_runs`, and `runtime_activations` as unbounded arrays in `.saivage/tmp/state/runtime.json`, maintain an append-only event ledger and derive a compact current-state view. Runtime arrays stay as bounded current-state projection fields because API contracts consume them. Use internal caps unless config demand exists. Migration must be idempotent.

### Design

**Data model:**

- New file: `src/runtime/runtime-event-ledger.ts` — append-only JSONL ledger for `runtime_command`, `runtime_run`, `runtime_activation` events, backed by `ProjectLock` on `.saivage/.lock`.
- New file: `src/runtime/runtime-state-view.ts` — reads the ledger at startup and produces a compact `RuntimeState` with only current/active entries for each array, plus a `ledger_seqno` watermark. This is a locked projection behind `RuntimeStateMutationPort`, not a long-lived global view.

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

- At startup, if `.saivage/tmp/state/runtime.json` has legacy full arrays, compact them: write the historical entries to the ledger, then rewrite the state file with only the current-view entries. This runs in `performRuntimeStartup()` (`src/runtime/runtime-startup.ts`) after read/init and before startup repair/reconciliation. Migration must be idempotent.
- The ledger file is `.saivage/tmp/state/runtime-events.jsonl`. Every append uses the project lock at `.saivage/.lock`.

**File changes:**

| File | Action |
|------|--------|
| `src/runtime/runtime-event-ledger.ts` | **New.** `RuntimeEventLedger` class: `append(event)`, `read(fromSeqno?)`, `compact()`. Uses `ProjectLock(join(projectRoot, '.saivage', '.lock'))` for atomic appends to `.saivage/tmp/state/runtime-events.jsonl`. |
| `src/runtime/runtime-state-view.ts` | **New.** Pure projection helpers: `rebuildRuntimeStateView(baseState, events)`, `applyRuntimeLedgerEvent(state, event)`, `compactRuntimeStateArrays(state)`. Produces compact `RuntimeState` arrays; do not introduce a singleton in-memory view. |
| `src/runtime/state.ts` | **Modify.** Keep `runtimeStatePath()` authoritative path as `.saivage/tmp/state/runtime.json` (`AUTHORITATIVE_STATE_FILE = 'runtime.json'` under `.saivage/tmp/state`). Replace `appendRuntimeCommand`, `appendRuntimeRun`, `updateRuntimeRun`, `upsertRuntimeActivation` state-array writes with locked ledger append plus compact snapshot rewrite. Keep `readRuntimeState`, `saveRuntimeState`, `updateRuntimeState`, `updateRuntimeStateLockedDeriving`, `initRuntimeState` as file-backed APIs. Add `migrateLegacyRuntimeStateArrays()` that writes arrays to ledger and rewrites state file compact. |
| `src/runtime/mutations.ts` | **Modify.** Mutation handlers for `appendRuntimeCommand`, `completeRuntimeCommand`, `rejectRuntimeCommand`, `appendRuntimeRun`, `updateRuntimeRun`, `upsertRuntimeActivation`, `completeActivation`, and `mergeRuntimeStateSnapshot` preserve scalar snapshot behavior but route array history through ledger events and compact projection fields. |
| `src/runtime/runtime-run-ledger.ts` | **Modify.** Keep `RuntimeRunLedger` using the injected `RuntimeStateMutationPort` (`deps.mutations.apply(...)`); do not give it its own JSONL append path. Its existing `updateRuntimeRun` mutations will emit ledger events through the mutation/state layer. |
| `src/runtime/runtime-services.ts` | **No change.** Do not add ledger/view to `RuntimeServices` or phase deps. Runtime dispatchers already depend on `RuntimeStateMutationPort`; put ledger/projection ownership behind `createRuntimeStateMutationPort()` and the state persistence helpers so phase handlers remain unaware of storage mechanics. |
| `src/runtime/runtime-startup.ts` | **Modify.** In `performRuntimeStartup()`, after read/init and before startup repair/reconciliation, call `migrateLegacyRuntimeStateArrays()`. |
| `src/schemas/types.ts` | **Modify.** Keep array types for backward compat but document they are now bounded current-state views. `RuntimeState` gains optional `ledger_seqno: number`. |
| `src/schemas/validators.ts` | **Modify.** Add optional `ledger_seqno` to `runtimeStateSchema`. |

**Key function signatures:**

```typescript
// src/runtime/runtime-event-ledger.ts
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

// src/runtime/runtime-state-view.ts
export function rebuildRuntimeStateView(baseState: RuntimeState, events: RuntimeLedgerEvent[]): RuntimeState;
export function applyRuntimeLedgerEvent(state: RuntimeState, event: RuntimeLedgerEvent): RuntimeState;
export function compactRuntimeStateArrays(state: RuntimeState): RuntimeState;
```

**Validation:** `npm run validate:routine`, `npm test`. Manual: start runtime, dispatch goals, kill/restart, verify `.saivage/tmp/state/runtime-events.jsonl` grows, verify `.saivage/tmp/state/runtime.json` stays bounded, verify `/api/state` returns correct current entries.

---

## Batch B: Effects Ports & Phase Refactoring (F06)

Extract composable effects interfaces to eliminate partial overlap between phase handler effects. Effect ports preserve literal constraints and keep exported effect type names as aliases for tests.

### Design

Define small, focused port interfaces. Each phase composes exactly the ports it needs. Phase files import ports and compose them into their local effects interface.

**File changes:**

| File | Action |
|------|--------|
| `src/runtime/effects-ports.ts` | **New.** Define composable ports: `ClockEffects { now(): string }`, `CardTransitionEffects<E extends string = string> { transitionCard(cardId: string, event: E, details: Record<string, unknown>): Promise<unknown> }`, `CardPatchEffects { updateCard(cardId: string, patch: Partial<CardRecord>): Promise<unknown> \| unknown }`, `RuntimeDiagnosticEffects<I extends RuntimeDiagnosticInput = RuntimeDiagnosticInput> { emitRuntimeDiagnostic(input: I): void; appendRuntimeDiagnostic(input: RuntimeDiagnosticLogInput<I>): void }`, `ErrorAppendEffects<I extends ErrorAppendInput = ErrorAppendInput> { appendError(input: I): void }`, `RuntimeRunEffects { updateRuntimeRun(runId: string, updates: Partial<RuntimeRunRecord>): RuntimeRunRecord \| null; publishRuntimeRun(run: RuntimeRunRecord): void }`, `RuntimeTransitionEffects<E extends string = string> { transitionRuntime(event: E, details: Record<string, unknown>): Promise<unknown> }`, `CardReadEffects { readCard(cardId: string): CardRecord \| null }`, `ChildUnwindEffects<O extends string = string> { appendChildUnwindToolResult(cardId: string, outcome: O, summary: string): void }`, and `CardFailureEventEffects { emitCardFailed(cardId: string, goalId: string): void }`. Use generics to preserve literal constraints instead of widening every call site to `string`. |
| `src/runtime/phases/reviewer-invocation-failure.ts` | **Modify.** `ReviewerInvocationFailureEffects` becomes an intersection type of `CardTransitionEffects<'block'> & CardPatchEffects & RuntimeDiagnosticEffects<{ goal_id: string; phase: 'reviewer'; error: unknown }> & ErrorAppendEffects<{ message: string; goalId: string; phase: 'reviewer' }> & RuntimeTransitionEffects<'card_terminated'>` plus local `finishOpenPlannerRun`. Remove the explicit interface definition; import ports from `effects-ports.ts`. Do not include `ClockEffects`; this handler does not call `now()`. |
| `src/runtime/phases/executor-invocation-failure.ts` | **Modify.** `ExecutorInvocationFailureEffects` becomes intersection of `ClockEffects & CardTransitionEffects<'fail'> & CardPatchEffects & RuntimeDiagnosticEffects<{ card_id: string; goal_id: string; phase: 'executor'; error: unknown }> & ErrorAppendEffects<{ message: string; cardId: string; goalId: string; phase: 'executor' }> & ChildUnwindEffects<'failed'> & CardFailureEventEffects` plus `clearActiveCardRun`. |
| `src/runtime/phases/executor-completion-handler.ts` | **Modify.** `ExecutorCompletionEffects` becomes intersection of `ClockEffects & CardTransitionEffects<'executor_finish' \| 'executor_partial_finish'> & CardPatchEffects & CardReadEffects & ChildUnwindEffects<ActivationCompletionOutcome> & CardFailureEventEffects` plus local optional `recordChildActivationLifecycle`. |
| `src/runtime/phases/planner-invocation-failure.ts` | **Modify.** `PlannerInvocationFailureEffects` becomes intersection of `ClockEffects & CardTransitionEffects<'block' \| 'fail'> & CardPatchEffects & RuntimeDiagnosticEffects<{ goal_id: string; phase: 'planner'; error: unknown }> & ErrorAppendEffects<{ message: string; goalId: string; phase: 'planner' }> & RuntimeRunEffects & RuntimeTransitionEffects<'card_terminated' \| 'goal_exit'>`. |
| `src/runtime/phases/reviewer-assessment-handler.ts` | **Modify.** `ReviewerAssessmentEffects` becomes intersection of `ClockEffects & CardReadEffects & CardTransitionEffects<'complete'> & CardPatchEffects & RuntimeTransitionEffects<'reviewer_finished'> & ChildUnwindEffects<'done'>` plus local event emissions: `emitReviewFailed`, `emitGoalCompleted`, `emitProjectRunCompleted`. |
| `src/runtime/startup-repair.ts` | **Modify.** `StartupActiveRunRepairEffects` uses `ClockEffects & CardTransitionEffects<'reviewer_repair_resume' \| 'fail'>` plus its unique methods: `repairOrphanActivateCardToolCalls`, `repairTerminalLifecycle`, `appendChildUnwindToolResult`, `parentPlannerRunFor`, `findCallerEdge`, `synthesizeTerminalActivationResult`, `finishOpenPlannerRun`, `queueSyntheticPlannerNote`, `saveState`. Do not force it into `CardPatchEffects`; the existing method name is `repairTerminalLifecycle`, not `updateCard`. |

**Key function signatures:**

```typescript
// src/runtime/effects-ports.ts
export type RuntimeDiagnosticInput =
  | { goal_id: string; phase: 'reviewer'; error: unknown }
  | { card_id: string; goal_id: string; phase: 'executor'; error: unknown }
  | { goal_id: string; phase: 'planner'; error: unknown };
export type RuntimeDiagnosticLogInput<I extends RuntimeDiagnosticInput> =
  Omit<I, 'error'> & { error_message: string };

export interface ClockEffects { now(): string }
export interface CardTransitionEffects<E extends string = string> {
  transitionCard(cardId: string, event: E, details: Record<string, unknown>): Promise<unknown>;
}
export interface CardPatchEffects {
  updateCard(cardId: string, patch: Partial<CardRecord>): Promise<unknown> | unknown;
}
export interface RuntimeDiagnosticEffects<I extends RuntimeDiagnosticInput = RuntimeDiagnosticInput> {
  emitRuntimeDiagnostic(input: I): void;
  appendRuntimeDiagnostic(input: RuntimeDiagnosticLogInput<I>): void;
}
export type ErrorAppendInput = { message: string; goalId?: string; cardId?: string; phase: string };
export interface ErrorAppendEffects<I extends ErrorAppendInput = ErrorAppendInput> {
  appendError(input: I): void;
}
export interface RuntimeRunEffects {
  updateRuntimeRun(runId: string, updates: Partial<RuntimeRunRecord>): RuntimeRunRecord | null;
  publishRuntimeRun(run: RuntimeRunRecord): void;
}
export interface RuntimeTransitionEffects<E extends string = string> {
  transitionRuntime(event: E, details: Record<string, unknown>): Promise<unknown>;
}
export interface CardReadEffects { readCard(cardId: string): CardRecord | null }
export interface ChildUnwindEffects<O extends string = string> {
  appendChildUnwindToolResult(cardId: string, outcome: O, summary: string): void;
}
export interface CardFailureEventEffects {
  emitCardFailed(cardId: string, goalId: string): void;
}
```

**Validation:** `npm run validate:routine`, `npm test`. Phase handlers are well-tested; type checking confirms composition is correct. Keep exported effect type names as aliases for tests.

---

## Batch C: Planning Blockers Structured Matching (F18) + Agent Loop Timeout (F32) + Stuck Agent Supervisor Disable (F33)

These three runtime-dispatch fixes share file proximity in `src/runtime/`.

### F18: Replace substring matching with discriminated union

`PlannerBlockedResult` is in `src/schemas/lifecycle.ts` (lines 45–49), not a runtime-state schema file. Set `blocker_cause` at blocker creation time in `src/runtime/phases/planner-phase.ts` (`buildPlannerBlockedDecision`, `buildPlannerInvocationFailureBlocker`, and the non-actionable-continue blocker), then runtime just reads the field. No runtime `classifyBlockerCause` function is needed. Delete the substring helper after call sites update.

**File changes:**

| File | Action |
|------|--------|
| `src/schemas/lifecycle.ts` | **Modify.** Add a `blocker_cause` discriminated-union field to `PlannerBlockedResult`: `blocker_cause?: 'reviewer_unavailable' \| 'token_budget_exceeded' \| 'terminal_tool_exhaustion' \| 'non_actionable_continue' \| 'generic'`. Keep `resume_reason` as legacy/display detail. |
| `src/runtime/planning-blockers.ts` | **Modify.** Replace `isReviewerCapacityPlannerBlocker` substring matching with `planning?.blocker_cause === 'reviewer_unavailable'`. Delete `isReviewerCapacityPlannerBlocker` after all callers are updated; do not keep a deprecated substring wrapper because Wave 6 removes parallel paths. |
| `src/runtime/phases/planner-phase.ts` | **Modify.** Set `blocker_cause` in `buildPlannerBlockedDecision`, `buildPlannerInvocationFailureBlocker`, and the `shouldBlockNonActionableContinue` branch in `decidePlannerPostDispatch`. Preserve existing `resume_reason` values (`reviewer_unavailable`, `planner_context_length_exceeded`, `planner_terminal_tool_exhausted`, `planner_blocked`) as string detail. |
| `src/runtime/phases/planner-invocation-failure.ts` | **No direct `blocker_cause` assignment.** It calls `buildPlannerInvocationFailureBlocker`; update tests around this handler to assert the returned planner blocker carries the creation-time cause. |

### F32: Per-iteration timeout for planner loop

Bare `Promise.race` is explicitly insufficient. The current `AgentAdapter.invokeAgent()` already creates an inner `AbortController` per LLM turn and passes `abortController.signal` into `buildLlmOptions()`. The missing design is an outer runtime-supplied `AbortSignal` that can cancel that controller and the planner iteration. `plannerIterationTimeoutMs` is a default fallback in `RuntimeConfig`, not a standalone constant. Make `RepairBudget` immutable now regardless.

**File changes:**

| File | Action |
|------|--------|
| `src/runtime/runtime-config.ts` | **Modify.** Add `plannerIterationTimeoutMs?: number` to `RuntimeConfig`. Default fallback is `600_000` ms in dispatcher/composition code; do not persist it through the agent config split unless an operator-facing config requirement is added. |
| `src/contracts/agent-execution.ts` | **Modify.** Add optional `signal?: AbortSignal` to `PlannerInvocationRequest`, `ExecutorInvocationRequest`, and `ReviewerInvocationRequest` only if executor/reviewer need the same cancellation path; otherwise start with `PlannerInvocationRequest.signal`. |
| `src/runtime/phases/planner-iteration-runner.ts` | **Modify.** Add `signal?: AbortSignal` to `run(input)` and pass it through to `PlannerPhaseRunner.run()` and then `agentRuntime.invokePlanner({ ..., signal })`. |
| `src/runtime/phases/planner-phase-runner.ts` | **Modify.** Accept and forward `signal` to `agentRuntime.invokePlanner`. |
| `src/agents/agent-adapter.ts` | **Modify.** `invokePlanner()` accepts `request.signal`; `invokeAgent()` accepts an optional external `AbortSignal`. When a turn creates its inner `AbortController`, bridge external abort to `abortController.abort()`, remove the listener in `finally`, and check `signal.aborted` before starting candidate attempts. Keep the existing session cancellation controller tracking. |
| `src/runtime/runtime-planner-dispatcher.ts` | **Modify.** In `runPlannerLoop`, create an `AbortController` per iteration, arm a timer that aborts it after `plannerIterationTimeoutMs`, and pass `signal` to `PlannerIterationRunner.run`. On timeout, emit a runtime diagnostic/error log and route through planner failure handling so the open run/card is closed consistently; do not merely return `planner_failure_handled` without cleanup. |
| `src/agents/invocation-outcome.ts` | **Modify.** Make `RepairBudget` immutable: change `consumed: number` to `readonly consumed: number`, add `consumeRepairAttempt(budget: RepairBudget, n = 1): RepairBudget` (or `withConsumed(budget, n)`) that returns a new object. All callers that mutate `consumed` now replace the budget value. This change is independent of the timeout mechanism. |

### F33: Disable stuck-agent supervisor in production

**File changes:**

| File | Action |
|------|--------|
| `src/runtime/stuck-agent-supervisor.ts` | **Modify.** Change `DEFAULT_SUPERVISOR_CONFIG.enabled` from `true` to `false`. Add a code-level comment: "The stuck supervisor is dormant until a real ChecksProvider is wired. Starting a no-op timer in production wastes resources and logs noise." |
| `src/agents/config-schema.ts` | **Modify.** Change `supervisorSectionSchema` `enabled` default from `true` to `false`. |
| `src/runtime/runtime-startup.ts` | **No change needed.** `performRuntimeStartup()` calls `input.supervisor.start()`, and `StuckAgentSupervisor.start()` returns early when `enabled` is false. Setting the default false means production creates but never starts the timer. |

**Validation:** `npm run validate:routine`, `npm test`. Add a test that `DEFAULT_SUPERVISOR_CONFIG.enabled === false`. Add a test that `blocker_cause` on known blocker patterns returns the correct cause when set at creation time. Include config parsing validation and no-start-event default coverage.

---

## Batch D: Config Schema Split (F21) + LLM Transport Credential Extraction (F27) + Agent Setter Injection (F26)

These share proximity in `src/agents/` and concern separation.

### F21: Split config-schema.ts into focused modules

Must update `src/agents/config-api.ts` — it currently re-exports only `loadConfig`, `normalizeLegacyRootConfig`, `saivageConfigSchema`, `ProviderEntry`, and `SaivageConfig` from `config-schema.js`. The new `config/selectors.ts` owns `getModelParamsForRole`, `getModelListForRole`, and `getRuntimeConfig`. Avoid open-ended compatibility barrels.

**File changes:**

| File | Action |
|------|--------|
| `src/agents/config/schema.ts` | **New.** Pure Zod schemas, type exports, and `SaivageConfig` type. Contents: `modelsSectionSchema`, `providerEntrySchema`, `serverSectionSchema`, `runtimeSectionSchema`, `securitySectionSchema`, `supervisorSectionSchema`, `telegramSectionSchema`, `notificationsSectionSchema`, `mcpServerEntrySchema`, `saivageConfigSchema`, derived types, and schema-only helpers such as `resolveTokenEndpoint` if still needed by config parsing. Do not put filesystem reads or legacy file rewriting here. |
| `src/agents/config/load.ts` | **New.** `loadConfig(projectRoot, env): ConfigLoadResult` — file reading, env interpolation, Zod validation, legacy migration call, and migration file rewrite. Imports schemas from `./schema.js` and migration helpers from `./migrations.js`. |
| `src/agents/config/migrations.ts` | **New.** `migrateLegacyRuntimeSection`, `normalizeLegacyRootConfig`, `LEGACY_RUNTIME_KEYS`. Called by `load.ts`. |
| `src/agents/config/selectors.ts` | **New.** `getModelParamsForRole`, `getModelListForRole`, `getRuntimeConfig`, `ModelParams` type. Pure functions that take `SaivageConfig` and role string where applicable. |
| `src/agents/config-schema.ts` | **Modify.** Replace entire file with targeted re-exports used by existing importers: `loadConfig`, `normalizeLegacyRootConfig` from `./config/load.js`; `saivageConfigSchema`, `providerCapabilitySchema`, `runtimeSectionSchema`, `notificationChannelSchema`, `notificationSeveritySchema` from `./config/schema.js`; `getModelParamsForRole`, `getModelListForRole`, `getRuntimeConfig` from `./config/selectors.js`; and the named types currently exported. Do not create an open-ended `export *` barrel. Remove in a later cleanup pass. |
| `src/agents/config-api.ts` | **Modify.** Update targeted re-exports to point to the new `config/` modules. Preserve its current public exports and add selectors only if callers should import through `config-api.ts` after the split. |

New `src/agents/config/` directory must be created.

### F27: Extract OAuth credential refreshers from llm-transport.ts

`CredentialSourceResolver` already exists in `src/agents/credential-source-resolver.ts` (251 lines) and handles provider/account/profile source resolution. Refresh logic is currently in `src/agents/llm-transport.ts` as `usableProfileAccessToken`, `refreshOpenAICodexProfile`, and `refreshGitHubCopilotProfile`; the resolver receives `usableProfileAccessToken` as an injected callback. Extract provider refreshers from `llm-transport.ts` and keep resolver responsibility limited to source resolution. `projectRoot` is needed for persistence. Move all provider-specific refresh constants out of `llm-transport.ts`.

**File changes:**

| File | Action |
|------|--------|
| `src/agents/credential-refreshers.ts` | **New.** Extract `refreshOpenAICodexProfile`, `refreshGitHubCopilotProfile`, `OPENAI_CODEX_TOKEN_URL`, `OPENAI_CODEX_CLIENT_ID`, and the GitHub Copilot token URL from `llm-transport.ts`. Export `CredentialRefreshers` with `usableProfileAccessToken(profileName: string, profile: AuthProfile): Promise<string \| undefined>` or equivalent. Implement provider-specific refreshers behind this interface and persist refreshed profiles with `saveAuthProfile(projectRoot, profileName, refreshed)`. |
| `src/agents/credential-source-resolver.ts` | **Modify.** Keep provider/account/profile source resolution. Continue accepting `usableProfileAccessToken` as an injected callback, or type it as the new `CredentialRefreshers['usableProfileAccessToken']`. Do not move provider refresh constants into this resolver. |
| `src/agents/llm-transport.ts` | **Modify.** Remove `refreshOpenAICodexProfile`, `refreshGitHubCopilotProfile`, `OPENAI_CODEX_TOKEN_URL`, `OPENAI_CODEX_CLIENT_ID`, and the inline GitHub Copilot token URL. Build a default `CredentialRefreshers` for `projectRoot` and inject its `usableProfileAccessToken` into `CredentialSourceResolver`. `resolveLlmTransportConfig` may accept an optional refresher for tests. |

### F26: Constructor-inject required AgentAdapter dependencies

Only `setLlmCallFn` is eliminated. `config` and `projectRoot` are already constructor-injected, but `llmCallFn` is nullable and asserted at invocation time. Cached `analystDeps` must update on `setMcpManager()`.

**File changes:**

| File | Action |
|------|--------|
| `src/agents/agent-adapter.ts` | **Modify.** Add `llmCallFn?: LlmCallFn` to `AgentAdapterConfig`; initialize `this.llmCallFn = cfg.llmCallFn ?? this.createLlmCallFn()` or require `cfg.llmCallFn` explicitly if tests can provide one. Remove `setLlmCallFn()` setter and the runtime error that says to call it first. Keep `config` and `projectRoot` as constructor-injected fields. Keep optional setters for `setActivationLedger`, `setContentSupervisor`, `setMcpManager`, `setSkillsEngine`, `setAfterSessionCreatedHook`, `setEventBus`, and `setRuntimeLedgerEventBus` because these are late-bound by runtime composition. |
| `src/application/runtime-composition.ts` | **Modify.** Construction of `AgentAdapter` already passes `config` and `projectRoot`; pass `llmCallFn` in the constructor if the adapter no longer defaults it internally, and remove `agentAdapter.setLlmCallFn(agentAdapter.createLlmCallFn())`. Replace the `analystDeps` getter that rebuilds on every access with a cached value; invalidate/rebuild the cache when `setMcpManager()` updates `mcpManager`. |

**Validation:** `npm run validate:routine`, `npm test`. Imports across codebase are preserved by the targeted re-exports in `config-schema.ts` and `config-api.ts`.

---

## Batch E: Operator API Boilerplate (F15) + Re-export Barrel Cleanup (F16) + Process Runner (F25) + Content Supervisor (F28) + Heuristic Scanner (F29)

These are local refactorings with no cross-cutting dependencies.

### F15: Route factory for operator API contracts

The factory must preserve the current `ContractAuthClass`, explicit response overrides, route errors, permissions, and audit metadata. `permissions` may return a boolean, allow/deny object, or a promise of either; it is not convention-derivable.

**File changes:**

| File | Action |
|------|--------|
| `src/contracts/operator-api-core.ts` | **Modify.** Add a `defineRoute<TParams, TQuery, TBody, TSuccess, TError>(spec)` helper returning `OperatorRouteContract`. `spec.auth` must use the existing `ContractAuthClass` values (`'public'`, `'operator-session'`, `'agent-session'`, `'mcp-tool-token'`), not a new `'protected'` alias. Preserve explicit `response`, `error`, `successSchemaName`, `permissions`, `audit`, and `describe` fields. The helper may derive default response maps and `successSchemaName` when unambiguous, but it must not reintroduce a stored `requiresAuth` field. |
| `src/contracts/operator-api-runtime-cards.ts` and the 9 other `operator-api-*.ts` files | **Modify.** Replace verbose route definitions with `defineRoute()` calls where it reduces boilerplate without hiding route-specific auth, audit, permissions, error schemas, or response statuses. There are 10 operator API files including `operator-api-core.ts`. |

### F16: Delete re-export barrels and convert stateless classes to functions

Use `rg` to count importers before deletion. Preserve/move `redactProviderErrorText` before deleting the `llm-errors.ts` barrel. Current reality: `llm-errors.ts` has 9 source importers plus 2 test importers.

**Files to delete (and update their importers):**

| File to delete | Importers to update |
|---|---|
| `src/agents/llm-errors.ts` | Use `rg` again before deleting; Wave 3 already moved canonical failure types to `src/contracts/llm-failure.ts` and deleted the agent-local `llm-failure.ts`. Source importers that need `LlmRequestError` or `unwrapFailure` import from `../contracts/llm-failure.js` (or `../../contracts/llm-failure.js` by relative path). Only `llm-failure-classifiers.ts` and `llm-codex-parser.ts` should need `redactProviderErrorText`; move that helper to `src/agents/llm-failure-classifiers.ts` or `src/redaction/index.ts` before deleting the barrel. |
| `src/agents/default-agent-execution.ts` | No importers found. Delete. |
| `src/agents/fake-agent.ts` | 14 test files import from this. Change all to import from `../runtime/fake-agent.js` directly. |
| `src/agents/system-prompt.ts` | Wave 3 made this a barrel over `src/agents/prompts/system-prompt.ts`. If deleting the barrel, update importers to use `src/agents/prompts/system-prompt.js` directly. Do not import from contracts; the implementation no longer lives there. |
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
| `src/runtime/process-runner.ts` | **Modify.** (1) Extend `ProcessReconcileOptions` with required composition-supplied logging where reconciliation is called from runtime-owned services, and with an optional logger only for tests that intentionally exercise the function in isolation. Do not keep a hidden temporary `EventLogger` construction path in normal runtime code. Thread the logger through `markLost()` and `reconcileProcessRecordsForService()`. (2) Merge `ProcessRunnerService` class methods with their module-level `*ForService` function counterparts — move the function bodies into the class methods and delete the `*ForService` functions. The class already stores `projectRoot` and process records; the module-level functions mostly pass `service` or `service.projectRoot`. Delete wrapper functions once imports are updated; do not retain compatibility wrappers. |

### F28: Content supervisor pass-recording off by default

There are three `recordContentPass` call sites in `screenContent` (lines 142, 158, 230), not one. All three need the `recordPasses` guard. When pass recording is off, returned `ScreenContentResult.review` is omitted for passed content; blocked/quarantined decisions continue to persist reviews.

**File changes:**

| File | Action |
|------|--------|
| `src/workspace/content-supervisor.ts` | **Modify.** Add `recordPasses?: boolean` to `ContentSupervisorConfig` (default `false`). In `screenContent`, guard all three `recordContentPass` call sites with `this.config.recordPasses === true`; if false, return passed status/summary without a `review`. |
| `src/workspace/quarantine.ts` | **Modify.** `appendJsonl` — switch from read-whole-file-rewrite to append-only descriptor write (`openSync(path, 'a')`, `writeSync`, `fsyncSync`, `closeSync`) under a project/supervision lock. `createWriteStream` is asynchronous and does not pair cleanly with sync `fsync`, so avoid it for this sync module. Eliminates the quadratic cost and lost-update risk of reading the full file on every append. |

### F29: Heuristic scanner pattern data extraction

`COMPILED_PATTERNS` (line 687) and `PATTERNS_BY_CATEGORY` (line 697) are both module-level eager state. Both must become lazy or be derived from `PATTERN_DEFS`. Scanner continues to export `scanContent`, `isInjectionSuspicious`, `SensitivityLevel`, `ScanResult`, `InjectionCategory`, and `PATTERNS_BY_CATEGORY` as public API. Only `PATTERN_DEFS` moves to `heuristic-patterns.ts`.

**File changes:**

| File | Action |
|------|--------|
| `src/workspace/heuristic-patterns.ts` | **New.** Export `PATTERN_DEFS: PatternDef[]` — the full pattern definition array moved from `heuristic-scanner.ts`. This is a data-only module. |
| `src/workspace/heuristic-scanner.ts` | **Modify.** Remove the inline `PATTERN_DEFS` array (lines 89–662). Import from `./heuristic-patterns.js`. Change `COMPILED_PATTERNS` from module-level eager compile to a lazy singleton: `let compiled: Pattern[] \| null = null; export function getCompiledPatterns(): Pattern[] { return compiled ??= compile(PATTERN_DEFS); }`. Make `PATTERNS_BY_CATEGORY` either a lazy getter/function or a derived exported constant that does not compile regexes. Update `scanContent` to call `getCompiledPatterns()` instead of `COMPILED_PATTERNS`. Keep `compile()` as a local utility unless tests require exporting compiled patterns. Add `validatePatterns(): void` that eagerly compiles and throws if any pattern is invalid — call this only from tests/startup validation. Continue exporting `scanContent`, `isInjectionSuspicious`, `SensitivityLevel`, `ScanResult`, `InjectionCategory`, and `PATTERNS_BY_CATEGORY` as public API. |
| `tests/workspace/heuristic-scanner.test.ts` (or similar) | **Modify.** Call `validatePatterns()` in a dedicated test case. |

**Validation:** `npm run validate:routine`, `npm test`, `npm run validate:ui-smoke`. Each sub-change is independently testable.

---

## Batch F: Frontend Sync Flatten (F19)

### F19: Remove SyncClient class, fold into Pinia store

`SyncResourceRegistration` type is in `web/src/sync/client.ts` (lines 11–14), not in `api/types.ts`. Move it to `web/src/stores/sync.ts` unless a cross-API consumer needs it. `SyncClient` imports `useAnalystChat` — this coupling must be preserved in the store. `SyncClient` has a module-level singleton (line 151). When deleting `SyncClient`, the Pinia store manages `WsConnectionManager` lifecycle directly. Preserve public sync store API and rewrite `sync-client.test.ts` into store tests.

**File changes:**

| File | Action |
|------|--------|
| `web/src/sync/client.ts` | **Delete.** Move all logic into `web/src/stores/sync.ts`. Move `SyncResourceRegistration`, `SyncResourceScope`, and `SyncResourceKey` types to `web/src/stores/sync.ts` unless another module needs them. |
| `web/src/stores/sync.ts` | **Modify.** Replace `SyncClient` pass-through with direct Vue reactivity. Import `getWsConnection` and type `WsConnectionManager` from `../api/websocket`. Import `useAnalystChat` and `isAnalystActivityContent` (preserving the coupling from `SyncClient`). Use `ref()` for `connectionState`, `lastConnectedAt`, `lastEventAt`. Use `Map<SyncResourceKey, SyncResourceRegistration>` and `Map<string, () => Promise<void>>` for resource/conversation registration. Port the flight deduplication (`runSingleFlight`) logic directly. Manage `WsConnectionManager` lifecycle directly instead of delegating to a module-level `SyncClient` singleton. Remove the dependency on `SyncClient`. Preserve public sync store API: `connectionState`, `lastConnectedAt`, `lastEventAt`, `connect`, `disconnect`, `registerResource`, `openConversation`, `sendMessage`. |
| `web/src/api/websocket.ts` | **No change needed.** `WsConnectionManager` already exposes `state`, `onState`, `onOpen`, `onSyncFrame`, `onEvent`, `connect`, `disconnect`, `sendRaw`, and `sendMessage`. The Pinia store directly uses these methods. |
| `web/src/api/types.ts` | **No change unless external API types need `SyncResourceRegistration`.** `LiveSyncInvalidateFrame`, `LiveSyncUnscopedResource`, and `WsConnectionState` already come from API contracts/types. |
| `web/src/stores/runtime.ts` | **Modify comment only if needed.** It currently mentions `SyncClient` in documentation text; update wording to "sync store invalidation + REST refetch". |
| Tests importing `web/src/sync/client.ts` | **Modify.** Rewrite `web/src/__tests__/sync-client.test.ts` into store tests that instantiate Pinia and mock `getWsConnection()`. |

**Key design:**

```typescript
// web/src/stores/sync.ts
import { ref, computed } from 'vue';
import { getWsConnection, type WsConnectionManager } from '../api/websocket';
import type { LiveSyncInvalidateFrame, LiveSyncUnscopedResource, WsConnectionState } from '../api/types';

export type SyncResourceScope = 'core' | 'active';
export type SyncResourceKey = LiveSyncUnscopedResource;
export interface SyncResourceRegistration {
  resource: SyncResourceKey;
  scope: SyncResourceScope;
  refetch: () => Promise<void>;
}

export const useSyncStore = defineStore('sync', () => {
  const connectionState = ref<WsConnectionState>('offline');
  const lastConnectedAt = ref<string | null>(null);
  const lastEventAt = ref<string | null>(null);
  const resources = new Map<SyncResourceKey, SyncResourceRegistration>();
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
| 4 | C | F18 | Add `blocker_cause` discriminated union to `lifecycle.ts`, set at creation time in planner blocker builders and non-actionable continue. No runtime `classifyBlockerCause` function. |
| 5 | C | F32 | Make `RepairBudget` immutable and add planner iteration abort-signal plumbing from `RuntimeConfig` through `PlannerIterationRunner`, `PlannerPhaseRunner`, and `AgentAdapter`. Enable the timeout only with cooperative cancellation, not bare `Promise.race`. |
| 6 | D | F21 | Split `config-schema.ts` into `config/` directory. Update `config-api.ts` re-exports. Avoid open-ended compatibility barrels. |
| 7 | D | F27 | Extract credential refreshers from `llm-transport.ts`; keep `CredentialSourceResolver` focused on source resolution and inject the refresher callback. Move provider-specific constants. |
| 8 | D | F26 | Remove `setLlmCallFn`. Constructor/default-initialize `llmCallFn`. Cache `analystDeps`; invalidate on `setMcpManager()`. |
| 9 | B | F06 | Create `effects-ports.ts`, refactor phase effects interfaces with union `RuntimeDiagnosticInput` type. List all `StartupActiveRunRepairEffects` methods explicitly. |
| 10 | A | F07 | Create `runtime-event-ledger.ts` and `runtime-state-view.ts`. Keep ledger/projection ownership behind state/mutation persistence, not `RuntimeServices` or phase deps. |
| 11 | A | F07 | Wire ledger into `state.ts` and `mutations.ts`. Replace array-append mutations with ledger events. Run migration in `performRuntimeStartup()` after read/init, before repair/reconciliation. |
| 12 | E | F25 | Inject `EventLogger` into `auditProcessReconciliation`, merge class/function indirection in process-runner. |
| 13 | F | F19 | Delete `SyncClient`, fold into Pinia store. Move `SyncResourceRegistration` type. Preserve `useAnalystChat` coupling. Rewrite `sync-client.test.ts` into store tests. |
| 14 | E | F15 | Add `defineRoute` factory preserving `ContractAuthClass`, explicit overrides, permissions (async function type), and audit metadata. (Defer unless cleanup-only window.) |
| 15 | E | F16 | Delete re-export barrels, update all 9 source plus 2 test `llm-errors.ts` importers. Move `redactProviderErrorText` before deleting barrel. Convert `AgentToolCatalog` class to functions. (Defer unless cleanup-only window.) |

---

## Dependency Notes

- **F07 depends on nothing else in Wave 6** but is the largest change. Steps 10–11 should be reviewed carefully. Ledger/projection ownership stays behind `RuntimeStateMutationPort` and state persistence helpers, not `RuntimeServices` or phase deps.
- **F06** (effects ports) should be done before or alongside any phase refactor that might add more phase handlers.
- **F21** (config split) must preserve all existing import paths through targeted re-exports until all importers are migrated. Avoid open-ended compatibility barrels.
- **F16** (barrel cleanup) can be done independently. Use `rg` to count source and test importers; preserve/move `redactProviderErrorText` before deleting the `llm-errors.ts` barrel.
- **F19** (frontend sync) is entirely frontend-scoped and can happen in parallel with any backend change. Preserve `useAnalystChat` coupling and public sync store API.
- **F32** timeout wrapper must use cooperative cancellation through `AbortSignal`; `RepairBudget` immutability is independent and can land first within the same step.

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
