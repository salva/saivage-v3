# Over-Engineering Findings — saivage-v3

Status: investigation report. Every finding below was verified against real code with grep/read (not speculation). Confidence and impact are noted. Nothing here is implemented yet; this is a backlog ordered by leverage.

Method note: "dead" = zero production references (only its own definition, a barrel re-export, or tests). Verified per item.

## Tier 1 — High leverage, low risk (do these first)

### 1. `RuntimeState` interface/schema mismatch drives ~47 reflexive `?? []` guards
- `src/schemas/types.ts:114` declares `runtime_intent?`, `runtime_commands?`, `runtime_runs?`, `runtime_activations?` as **optional**.
- `src/schemas/validators.ts:108` (`runtimeStateSchema`) makes all four **required** (`z.array(...)`, `runtimeIntentSchema`).
- Every `RuntimeState` reaching memory is produced by `AtomicJsonFile.read/writeSync` (schema-validated) or `defaultRuntimeState()` (`src/runtime/state.ts:91`), both of which guarantee the fields are present. No `as RuntimeState` bypass exists.
- Consequence: ~47 `(state.runtime_runs ?? [])` / `runtime_intent?.status ?? 'stopped'` guards in `src/runtime` alone (state.ts, runtime-core.ts, mutations.ts, startup-repair.ts, …) guard a state that cannot occur. Smoking gun: `reduceActivationCompletion` (`runtime-core.ts`) treats `runtime_activations` as present (lines 705/712) yet writes `runtime_runs ?? []` (717) in the same function.
- Fix: make the four fields non-optional in the interface to match the schema, then delete the dead guards. Keep genuinely-nullable fields (`active_card_run?`, `paused_at?`, `last_tick_at?`, `frozen_reason?`). This is one brave refactor that removes the largest body of over-defensive code.
- Confidence: HIGH. Impact: HIGH.

### 2. Triple `cardRecordSchema.parse` per card mutation
- Persist path parses the same in-memory object three times: `src/cards/card-patch-service.ts:53` (safeParse) → `src/cards/apply-mutation.ts:209` (parse `op.next`) → `src/cards/apply-mutation.ts:106` (`stageByIdTmp` parse). Create path likewise: `src/cards/lifecycle-commands.ts:105` → `src/cards/apply-mutation.ts:169` → `src/cards/apply-mutation.ts:106`.
- The object is a typed `CardRecord` from `buildUpdatedCard`/`buildNewCard`, owned in-process, unmutated between calls, all under one held lock. Steps 2/3 cannot see a different value than step 1.
- Fix: validate once. Keep the parse closest to the durable write (`stageByIdTmp`) as the single gate; drop the redundant service-layer/`op` parses (or vice-versa — a design call, but two of three are dead).
- Confidence: HIGH. Impact: MEDIUM (hot path; also a perf win).

## Tier 2 — Dead code removal (safe deletes, verified zero production callers)

### 3. Dead freeze/resume manifest creation cluster
The runtime READS and HANDLES a `'frozen'` status that **nothing ever WRITES** in production. Dead writers/builders:
- `saveFreezeManifest` (`src/runtime/freeze-manifest.ts:22`), `clearFreezeManifest` (:57), `freezeManifestExists` (:70)
- `buildFreezeManifest` (`src/runtime/runtime-core.ts:177`), `buildFreezeRuntimeStatePatch` (:165), `buildResumeFromFreezeRuntimeStatePatch` (:203), `buildResumeHandoffContext` (:219)
- Verified: each has 0 production refs outside its own file/barrel. The only `status: 'frozen'` producers (`src/runtime/runtime-core.ts:170,190`) are inside these dead builders. `readFreezeManifest` is the only live freeze symbol.
- Caveat: live code still *handles* `frozen` (`src/runtime/runtime-shutdown.ts:56`, `src/runtime/runtime-control-commands.ts:37,55`, `src/tools/analyst-runtime-tools.ts:50`, `src/application/read-models/debug-read-model.ts:19`, `sync-hub.ts`). So either freeze was never finished or was abandoned. Decide: delete the whole freeze concept (writers + handlers + status), or keep it as a real feature. Right now it is half-built dead weight.
- Confidence: HIGH that the writers are dead. Impact: MEDIUM. Needs a product decision on the `'frozen'` status itself.

### 4. Dead terminal-commit functions
- `commitReviewerCorrection` (`src/runtime/terminal-commit/commit-reviewer.ts:27`): zero refs anywhere. Reviewer corrections actually flow through `reviewer-assessment-handler.ts` (`{ kind: 'continue_planner' }`). Delete.
- `commitPlannerDone` (`src/runtime/terminal-commit/commit-planner.ts:6`): tests-only. Planner "done" flows via the reviewer → `commitReviewerPass`. Delete (and its test).
- `validateEvidenceCompleteness` (`src/runtime/terminal-commit/validators.ts`): tests-only; the evidence-completeness gate is never enforced in production. Delete (plus orphaned `EvidenceCompleteness` type / `evidenceIdsFromResult` if unused).
- Confidence: HIGH. Impact: LOW–MEDIUM.

### 5. Dead exported symbols (zero refs; safe deletes)
- `RuntimeStateSnapshotPort` (`src/contracts/agent-execution.ts` + barrel `src/contracts/index.ts:242`): declaration + re-export only. Delete.
- `createLlmProviderGateway` (`src/agents/llm-provider-gateway.ts`): 0 callers; everyone uses `new LlmProviderGateway(...)`. Delete.
- `agents/index.ts` + `agents/execution-api.ts`: zero production importers; referenced only by `tests/utils/agents-module-boundary.test.ts`, which exists to assert these barrels exist. Delete both + that test (the other `agents/*-api.ts` facades have real consumers — keep them).
- `mcp/status-api.ts`: zero importers. Delete.
- `agents/default-agent-execution.ts`: zero importers (dead 1-line barrel). Delete.
- `agents/fake-agent.ts`: `export *` path-preservation barrel; only the dead barrels consume it. Delete after #5 barrels go; point tests at `runtime/fake-agent.js`.
- Also dead (analyst-stage6.ts): `runtimeStatusForApi` (:23), `normalizeRuntimeStatus` (:104), `markDescendantChanged` (:46); `ANALYST_TOOL_REGISTRY` alias (`src/agents/analyst-prompt.ts`); `MAX_LIST_RESULTS` (`src/runtime/command-policy.ts:22`); `deleteSession`/`buildConversationContext` (`src/runtime/session-persistence.ts:345,365`, tests-only); the `*_TOOL_DEFINITION(S)` family in `skill-tools.ts` (superseded by `tools/mcp-skill-tools.ts`).
- Confidence: HIGH (each grep-verified zero). Impact: LOW each, MEDIUM cumulatively.

### 6. `process-runner.ts` dead wrapper surface
- Free-function + class-method twins with zero production imports: `saveRegistry`, `registerProcessTerminalSink`, `cleanupProcessOutput`/`cleanupAllCompleted` (+ their `*ForService` cores reached nowhere live), and pure-wrapper `startProcess`/`stopAllRunningForRuntimeShutdown`/`snapshotProcessRuntimeScope`. Production uses only `getProcess`/`killProcess`/`listProcesses`/`tailOutput`/`reconcileProcessRecords`/`disposeProcessRuntimeScope`/`setProcessTerminalBuffering`/`loadRegistry`.
- This 1083-line file (largest in src) is partly a dead facade. Delete the unused twins.
- Confidence: MEDIUM–HIGH (grep-verified per name). Impact: MEDIUM.

## Tier 3 — Unreachable branches (delete the dead arm)

### 7. The `transitionCard` `=== false` / `!transitioned` family
- `transitionCard` (`src/runtime/state-machine.ts:184`) only returns `true` or throws (since "enforce strict terminal transitions"). So these are unreachable:
  - `transitionOrThrow` `=== false` arms: `src/runtime/terminal-commit/commit-planner.ts:54`, `src/runtime/terminal-commit/commit-reviewer.ts:54`, `src/runtime/terminal-commit/commit-executor.ts:127`
  - `if (!transitioned)`: `src/runtime/executor-activation-dispatcher.ts:61`, `src/runtime/phases/planner-activation-runner.ts:44`
  - `handleExecutorCompletion` always returns `transitioned: true` → `!completion.transitioned` at `src/runtime/executor-activation-dispatcher.ts:161` is always false.
- Fix: drop the `transitionOrThrow` helper and the dead guards; `await` the transition directly. Narrow `TerminalCommitEffects.transitionCard` return type (`src/runtime/terminal-commit/commit-executor.ts:6`) from `Promise<boolean | unknown> | boolean | unknown` to `Promise<void>`, removing the type surface that only existed to feed the dead branch.
- Confidence: HIGH. Impact: LOW–MEDIUM (and clarifies a confusing API).

### 8. `runtimeSignalledDone` return value never read
- `executeActionToolCalls` returns `{ runtimeSignalledDone: boolean }` (`src/agents/agent-loop-driver.ts:44`), computed in `src/agents/invocation-runner.ts:333`, but the driver never reads it (calls at :101/127/143 discard it). The live runtime-done path is `io.takeRuntimeDoneEnvelope()`.
- Related: `signalDoneFromRuntime` method + local `runtimeDoneEnvelope` (`src/agents/agent-loop-driver.ts:64,74,203`) are called only by tests. Delete the method/local; keep only `io.takeRuntimeDoneEnvelope`.
- Fix: change `executeActionToolCalls` to `Promise<void>`; delete the dead signalling path.
- Confidence: HIGH. Impact: LOW.

### 9. Dead `_input` parameters on contract factories
- `createExecutorContract` (`src/contracts/executor-contract.ts:22`), `createReviewerContract` (`src/contracts/reviewer-contract.ts:22`), `createPlannerContract` (`src/contracts/planner-contract.ts:28`) each take `_input` that is never read; the returned contract is constant. ~7 call sites each build an argument object that's discarded.
- Fix: drop the parameters (the contracts could be module-level constants).
- Confidence: MEDIUM. Impact: LOW.

## Tier 4 — Indirection collapse (each removes a layer; behavior-neutral)

### 10. `RuntimeSessionPersistencePort` + `createFileRuntimeSessionPersistencePort` (`src/runtime/session-persistence-port.ts:13,28`)
- One impl, a 6-method pass-through binding `saivageDir` to free functions; injected at exactly one site (`src/runtime/runtime.ts:72` → `ActivationUnwindRunner`); zero test fakes. `ActivationUnwindRunner` already takes `projectRoot` and could call the persistence functions directly.
- Fix: delete the port + adapter; pass `projectRoot`.
- Confidence: HIGH. Impact: MEDIUM.

### 11. `ProcessReadModelService` (removed; was `application/read-models/process-read-model.ts`)
- Stateless class; all 4 methods forwarded verbatim to `processApi(this.projectRoot)`. Deleted; callers use `processApi(projectRoot)` directly (see `src/server/routes/operator-process-handlers.ts`).
- Confidence: HIGH. Impact: MEDIUM. Status: DONE (WI-11).

### 12. `*PhaseRunner` classes → functions
- `ReviewerPhaseRunner`, `ExecutorPhaseRunner`, `PlannerPhaseRunner` are stateless single-`run()`-method classes, each `new`'d-and-discarded at exactly one call site. Demote to plain functions `runReviewerPhase(deps, input)` etc.
- Confidence: MEDIUM. Impact: MEDIUM.

### 13. Smaller pass-throughs
- Duplicate identical methods `AgentAdapter.redactModelIssueText` ≡ `redactProviderErrorMessage` (`src/agents/agent-adapter.ts:277,280`, byte-identical) → merge to one.
- `redactTextForOutbound`/`redactSnippetForOutbound` accept an `options` arg then `void options` (`src/redaction/index.ts:296`) → drop the misleading dead parameter.
- Double forwarding `RuntimeApi` ↔ `controls` ↔ `RuntimeLifecycleController` (`src/runtime/runtime.ts:150`, `src/runtime/core-composition.ts:132`) → collapse the redundant `controls` intermediate.
- `agentExecutionFactory` config field is never assigned; `createDefaultAgentExecution` + `default-agent-execution.ts` barrel are a dead seam → inline the `new FakeAgentAdapter` fallback, drop the field.
- Confidence: HIGH (each verified). Impact: LOW each.

## Tier 5 — Policy violations worth a decision (AGENTS.md: no migration/compat code)

### 14. Config legacy-key migration shim
- `LEGACY_RUNTIME_KEYS` / `migrateLegacyRuntimeSection` / `normalizeLegacyRootConfig` (`src/agents/config-schema.ts:5-52`), wired live in `loadConfig` (:376,382,386) and `src/config/environment.ts:170`. CamelCase→snake_case config migration is exactly the "migration code" the project says not to keep.
- Decision: drop it and require snake_case (fail fast on legacy keys), or formally accept the shim. It is reachable, so removing it changes accepted-config behavior — needs sign-off.
- Confidence: MEDIUM (it IS a policy-violating shim; not dead). Impact: MEDIUM.

## Explicitly checked and NOT flagged (avoid false removals)
- `RuntimeStateMutationPort` (one impl but a real shared DI type across ~18 modules) — keep.
- `activationOutcomeFromLifecycle`/`runtimeRunOutcomeFromLifecycle` — both branches reachable (compensation dispatches `completeActivation` without lifecycle).
- Broad try/catch in `crash-recovery.ts`, `tool-dispatcher.ts`, `invocation-recovery-policy.ts`, durable-write, untrusted JSON parsing — legitimate boundaries, not masking.
- `contracts/**` exported functions — consumed by `web/src/api/contracts.ts` (a src-only scan misses these).
- Most `*Dispatcher`/`*Coordinator` classes — real loop/branch logic or instance state.

## Suggested order of execution
1. Tier 2 dead-code deletes (#3–6) — safe, immediate, shrinks surface. (#3 freeze needs the product decision.)
2. Tier 3 unreachable branches (#7–9) — safe, clarifies APIs.
3. Tier 1 #2 (triple parse) then #1 (RuntimeState interface) — highest leverage, slightly larger refactors; run full `npm test` + `validate:routine` after each.
4. Tier 4 indirection collapse (#10–13).
5. Tier 5 #14 — only after a policy decision.

Each item is independent. Land them as separate small commits with the existing gates (`npm run typecheck`, `npm test`, `npm run validate:routine`) green per commit.
