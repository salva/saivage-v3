# Saivage v3 Runtime Subsystem Map

## Scope

`src/runtime/` and `src/application/xstate-runtime-api-factory.ts` + `src/application/runtime-composition.ts`.

## Layers

### Layer 1: Foundation (no intra-runtime deps)

| Module | Lines | Purpose | Key Exports |
|--------|-------|---------|-------------|
| `state.ts` | 258 | Runtime state persistence (runtime.json) | `readRuntimeState`, `updateRuntimeState`, `appendRuntimeCommand`, `appendRuntimeRun`, `upsertRuntimeActivation` |
| `lock.ts` | 222 | PID lock for preventing concurrent instances | `acquireLock`, `releaseLock`, `isLocked` |
| `session-stamper.ts` | 19 | Stamp interfaces | `RoundStamp`, `SessionStamper` |
| `lifecycle.ts` | 198 | Resource lifecycle scope (timers, listeners, processes) | `RuntimeLifecycleScope` |
| `command-policy.ts` | 44 | Command env sanitization and output truncation | `sanitizedCommandEnv`, `truncateCommandOutput` |
| `current-run.ts` | 21 | Derive current card/session from runtime state | `deriveCurrentCardId` |
| `context-builder.ts` | 188 | Build goal/card/evidence context for LLM prompts | `buildGoalContextPayload`, `buildGoalContextBlock` |
| `goal-context.ts` | 25 | Infer planner resume reason | `inferGoalResumeReason` |
| `planning-blockers.ts` | 29 | Planner-blocked result helpers | `getBlockedPlanning`, `shouldPreservePrecisePlanningBlocker` |
| `activation-reducer.ts` | 135 | Reduce activation state to snapshots | `activeRunFromActivationState` |
| `reviewer-assessment.ts` | 60 | Build/validate reviewer assessment | `buildReviewAssessment`, `validateReviewerAssessment` |
| `transition-policy.ts` | 123 | Card transition state machine | `planCardTransition`, `RuntimeCardAction` |
| `runtime-lifecycle-state.ts` | 17 | Lifecycle flags interface | `LifecycleFlags` |
| `runtime-command-state.ts` | 49 | Build command state patches | `buildCompletedRuntimeCommandState` |
| `runtime-control-state.ts` | 15 | Build pause/resume state patches | `buildPauseRuntimeStatePatch` |
| `fake-agent.ts` | 122 | Test double for agent execution | `FakeAgentAdapter` |
| `runtime-api.ts` | 37 | RuntimeApi interface | `RuntimeApi`, `RuntimeCommandSource` |
| `session-persistence.ts` | 436 | Persist/read agent sessions | `createSession`, `getSession`, `replaceSessionMessages` |
| `runtime-event-publisher.ts` | 105 | Publish runtime/diagnostic events | `RuntimeEventPublisher` |
| `candidate-availability-store.ts` | 202 | FsCandidateAvailability (duplicate of agents/) | `FsCandidateAvailability` |

### Layer 2: Core Logic (depends on Layer 1)

| Module | Lines | Purpose | Key Exports |
|--------|-------|---------|-------------|
| `mutations.ts` | 168 | Typed runtime state mutation port | `applyRuntimeMutation`, `RuntimeStateMutationPort` |
| `control.ts` | 37 | High-level pause/resume with side effects | `pauseRuntimeControl`, `resumeRuntimeControl` |
| `session-persistence-port.ts` | 40 | Port interface for session persistence | `RuntimeSessionPersistencePort` |
| `session-stamp-counter.ts` | 80 | Concrete SessionStamper | `SessionStampCounter` |
| `activation-completion-reducer.ts` | 45 | Reduce activation completion state | `reduceActivationCompletion` |
| `planner-run-reducers.ts` | 80 | Plan planner run updates | `planPlannerRunSessionBinding` |
| `changed-propagation.ts` | 111 | Propagate card changes up ancestry | `propagateChange` |
| `synthetic-planner-notes.ts` | 86 | Queue/drain synthetic planner notes | `queueSyntheticPlannerNote`, `drainSyntheticPlannerNotes` |
| `runtime-goal-context.ts` | 75 | Build goal context for planner prompts | `createRuntimeGoalContextCoordinator` |
| `control-api.ts` | 3 | Re-export control + lock + api | `RuntimeApi`, `pauseRuntimeControl` |
| `state-api.ts` | 2 | Re-export state reads | `readRuntimeState` |
| `terminal-commit/` | 6 files | Terminal lifecycle commit patches | `commitExecutorSuccess`, `commitPlannerBlocked`, etc. |
| `process-runner.ts` | 1055 | Managed child process service | `ProcessRunnerService` |
| `process-api.ts` | 120 | Operator-facing process read model | `ProcessApi` |
| `crash-recovery.ts` | 57 | Crash recovery: drop running cards, clean stale files | `performRuntimeCrashRecovery` |
| `stuck-agent-supervisor.ts` | 571 | Background stuck-agent detection | `StuckAgentSupervisor`, `createRuntimeSupervisor` |
| `runtime-diagnostics.ts` | 37 | Track background dispatch promises | `createRuntimeDiagnostics` |
| `runtime-config.ts` | 80 | RuntimeConfig, RuntimeAssembly, DI interfaces | `RuntimeConfig`, `RuntimeAssembly` |
| `agent-runtime-factory.ts` | 53 | Create/configure AgentExecutionPort (real or fake) | `createDefaultAgentExecution`, `createConfiguredAgentRuntime` |
| `persisted-planner-history.ts` | 88 | Compact oversized planner history | `compactPersistedPlannerHistoryForRetry` |

### Layer 3: XState Actor Runtime (depends on Layer 2)

| Module | Lines | Purpose | Key Exports |
|--------|-------|---------|-------------|
| `actors/ids.ts` | 33 | Actor ID naming conventions | `supervisorActorId`, `cardActorId`, `plannerActorId` |
| `actors/snapshots.ts` | 94 | Persist/read actor snapshots | `readActorSnapshots`, `saveActorSnapshot` |
| `actors/actor-tool-definitions.ts` | 64 | Planner/executor tool definitions | `XSTATE_PLANNER_TOOL_DEFINITIONS`, `XSTATE_PROCESS_TOOL_DEFINITIONS` |
| `actors/actor-input-builders.ts` | 94 | Build LlmInvocationInput for each role | `buildXStatePlannerInput`, `buildXStateExecutorInput`, `buildXStateReviewerInput` |
| `actors/llm-delivery-log.ts` | 226 | Append/read LLM turn logs and tool delivery | `appendLlmTurnStarted`, `appendToolDelivery` |
| `actors/active-goal-note-sinks.ts` | 44 | Per-goal note sink registry | `ActiveGoalNoteSinks`, `getActiveGoalNoteSinks` |
| `actors/runtime-supervisor.ts` | 134 | XState supervisor (running/paused/stopping) | `RuntimeSupervisorController` |
| `actors/llm-runner.ts` | 175 | XState LLM runner (run provider turns) | `LlmRunnerController`, `ProviderTurnPort` |
| `actors/invocation-provider-turn.ts` | 39 | InvocationService adapter for ProviderTurnPort | `InvocationProviderTurnPort` |
| `actors/card-runner.ts` | 266 | XState terminal card runner (execute tools) | `TerminalCardRunnerController` |
| `actors/terminal-card-status-port.ts` | 88 | Create TerminalCardStatusPort | `createTerminalCardStatusPort` |
| `actors/goal-card-runner.ts` | 311 | XState goal card runner (plan/review) | `GoalCardRunnerController` |
| `actors/goal-card-status-port.ts` | 45 | Create GoalCardStatusPort | `createGoalCardStatusPort` |
| `actors/xstate-child-activation.ts` | 87 | Dispatch goal/terminal card runners | `createXStateChildActivation` |
| `actors/process-runner.ts` | 172 | XState process runner actor | `ProcessRunnerController` |
| `actors/actor-recovery.ts` | 90 | Build recovery plan from snapshots | `buildActorRecoveryPlan` |
| `actors/supervisor-runtime-api.ts` | 224 | RuntimeApi backed by XState supervisor | `SupervisorRuntimeApi` |

### Layer 4: Application Integration

| Module | Lines | Purpose | Key Exports |
|--------|-------|---------|-------------|
| `application/xstate-runtime-api-factory.ts` | 28 | Create SupervisorRuntimeApi wired to deps | `createXStateRuntimeApi` |
| `application/runtime-composition.ts` | 174 | Wire up full RuntimeApplication | `createRuntimeApplication` |

## Data Flow

```
Operator/API → RuntimeApi (SupervisorRuntimeApi)
  → RuntimeSupervisorController (pause/resume/admission)
  → GoalCardRunnerController (planning loop)
    → LlmRunnerController (provider turn)
    → ChildActivationPort (dispatch children)
      → TerminalCardRunnerController (executor loop)
        → ProcessRunnerController (child processes)
      → GoalCardRunnerController (recursive for sub-goals)
    → GoalCardStatusPort (commit outcomes)
  → EventBus (events)
  → ActorSnapshot persistence
  → LLM delivery log persistence
```