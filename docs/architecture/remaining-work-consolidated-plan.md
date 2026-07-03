# Remaining Work Consolidated Plan

Status: current planning document.

Last reviewed: 2026-07-02.

This plan consolidates the still-relevant follow-up work from the record-slot, tool-surface, deferred-capability, and conversation-compaction plans. It intentionally filters out tasks that have drifted, have already been implemented, or would now conflict with the current Saivage v3 architecture.

The active execution backlog in this document is limited to improvements of the current codebase: simplification, dead-code removal, test hardening, and documentation cleanup. Completely new capabilities such as Git tools, RAG, memory, notes, and conversation compaction are parked in [Future Capabilities Plan](./future-capabilities-plan.md).

Current authorities:

- [System Specification](../spec/system-specification.md)
- [Operator UI Specification](../spec/operator-ui.md)
- [System Architecture](./system-architecture.md)
- [Remaining Work Consolidated Plan](./remaining-work-consolidated-plan.md) (this document)
- [Tool Set Reorganization Design](./tool-set-reorganization-design.md) (implemented rationale; obsolete checklist)
- [Shared Tool Invocation Design](./shared-tool-invocation-design.md) (implemented rationale; obsolete checklist)
- [Mandatory Output Files](./agent-invocation-output-slots.md) (historical design context; obsolete checklist)
- [Record-Backed Card Storage Plan](./record-backed-card-storage-plan.md) (historical design context; obsolete checklist)
- [Conversation Compaction Design](./conversation-compaction-design.md) (deferred design context; not active backlog)
- [Future Capabilities Plan](./future-capabilities-plan.md) (deferred capabilities; not active cleanup backlog)

## Current Baseline

The following are implemented and should not be replanned as missing work:

- Provider-owned invocation surfaces are the active tool authority.
- Canonical tools are active: `read`, `write`, `edit`, `apply_patch`, `glob`, `grep`, `run_command`, `wait_process`, `kill_process`, `websearch`, `webfetch`, `skill`, and `mcp_tool_call`.
- Retired model-facing names are absent from active source, including `write_file`, `load_skill`, `terminate_process`, `report_goal_*`, and role-specific terminal tools.
- Planner, executor, and reviewer use the unified `emit_result` terminal tool.
- Lifecycle result kinds are collapsed to `done`, `blocked`, `failed`, and `rework`, plus internal `executor_needs_verification`.
- Mandatory `status.md` and `review.md` record-slot enforcement is implemented for planner, executor, and reviewer terminal flows.
- Record-backed `card.json` loading/storage and `brief.md` prompt sourcing are implemented.
- Analyst `write(record://brief.md?card=<id>&v=next)` is implemented, runtime-state gated, and tested.
- Analyst explicit-card `record://` read/search and `tmp://` access are implemented.
- Analyst workspace repair policy is implemented for `project://` and `system://` writes where allowed.
- Analyst process ownership is session-scoped and operator-marked; websocket cleanup terminates owned running processes.
- Legacy `PlannerToolsService` is removed.

## Decisions

### Keep

Keep these ideas as active remaining work because they still match the architecture and have clear value.

1. **Clarify and test reviewer currentness/status documentation.**

   The implementation already captures reviewed subtree currentness, discards stale open review records, and relaunches reviewers. The remaining work is to update stale phase lists and add any missing narrow tests around edge cases, not to design a new mechanism.

   References:

   - `src/runtime/actors/planning-card-processor-actor.ts`
   - `tests/runtime/actors/planning-card-processor-currentness.test.ts`
   - `docs/architecture/agent-invocation-output-slots.md`

2. **Add focused mandatory-record repair tests where coverage is thin.**

   Current coverage is strong for reviewer currentness and many actor flows, but planner/executor missing `status.md` repair can be made more explicit with tests that do not rely on helper auto-insertion.

   Acceptance criteria:

   - Planner emitting `emit_result` without required `status.md` receives same-session repair.
   - Executor emitting `emit_result` without required `status.md` receives same-session repair.
   - Repair success closes the expected record slot and accepts the terminal result.

3. **Keep record slots as the durable evidence and narrative channel.**

   `brief.md`, `status.md`, and `review.md` remain the right place for human-readable durable intent, progress, and review content. Do not reintroduce artifact/attachment/generated-file evidence registries unless a new concrete use case appears.

4. **Simplify current tool/runtime architecture after the provider refactor.**

   The provider-owned invocation cutover made several intermediate abstractions obsolete. Cleanup should remove dead modules and duplicate policy lists rather than keeping them as compatibility layers.

   Candidate targets:

   - tests-only `runtime/terminal-commit` abstractions if they are not production-owned;
   - tests-only `ToolRuntime` and package-root barrels;
   - stale static role/tool policy lists that duplicate provider composition;
   - misleading `tool-catalog.ts` naming now that it is vocabulary/schema helper code, not execution authority.

5. **Simplify current Analyst control-tool result plumbing.**

   Analyst control tools still have preview/error-envelope types that are projected away before reaching the shared invocation contract. Remove or collapse that machinery unless a real preview/confirmation UI consumes it.

6. **Fix current prompt/spec/test drift.**

   Current docs and prompts still contain pockets of stale vocabulary such as `wait_for_process`, `read_file`, `read_file_metadata`, `ToolDispatcher`, `ActorToolSurface`, and old reviewer `pass` / `needs_corrections` structured-output guidance. These should be updated or marked historical so current agents are not misled.

### Revise

Revise these original ideas before implementing anything, because the architecture or implementation has moved.

1. **Reviewer evidence gate.**

   Original idea: reviewer acceptance should validate structured `evidence_card_ids`.

   Current direction: reviewer evidence detail belongs in `review.md` prose; the terminal envelope is only `{ status, summary }`. The runtime should not parse markdown to enforce evidence IDs unless a future product need justifies structured evidence again.

   Decision: revise docs to mark `validateReviewerAssessment` and structured evidence validation as stale unless explicitly reintroduced by a new design. Also evaluate removing the unused production code and tests for structured reviewer assessment.

2. **Planner/reviewer workspace write policy descriptions.**

   Original idea: planner writes only `status.md`; reviewer writes only `review.md`.

   Current implementation: planner can also write `brief.md` where slot-writer rules allow it. Reviewer remains record-only. Docs should describe the slot-writer rules rather than hardcoding outdated per-role prose.

3. **Record commit primitive.**

   Original idea: introduce a named `commitRecord` primitive.

   Current implementation: equivalent behavior is split across `writeCardRecordVersion`, `writeBriefRecordVersion`, `openRecordSlot`, `closeOpenRecordSlot`, and `discardOpenRecordSlot`.

   Decision: do not create `commitRecord` just to match an old plan. Extract a shared primitive only if duplication, audit requirements, or bugs make the need concrete.

4. **Card JSON field cleanup.**

   Original idea: aggressively remove fields such as `updated_at` unless audit finds consumers.

   Current finding: consumers exist for many fields including `updated_at`, `status_text`, tags, priority, urgency, related links, metadata, and estimate.

   Decision: treat field cleanup as a separate field-by-field schema migration plan. Do not bundle it into record-slot cleanup.

5. **Process schema cleanup.**

   Original idea: make Analyst process records omit `card_id`.

   Current implementation: `ProcessRecord.card_id` is required, and Analyst records use the session id there as schema-compatible non-authoritative provenance while `owner_id` remains the ownership authority.

   Decision: do not change this opportunistically. First audit operator API, UI, notifications, and process read models. Either keep the current invariant and remove stale null/optional defensive code, or make `card_id` nullable in one focused process-schema change.

### Drop

Drop these tasks because they are done, stale, or now conflict with the architecture.

1. **Implement Analyst `brief.md` writes.**

   Already implemented and tested.

2. **Implement `effective_updated_at` in card inspection.**

   Already implemented in card inspection paths.

3. **Remove active `get_card_output` / old evidence surfaces.**

   Already absent from active Analyst tool surfaces; tests assert removed tools are not exposed.

4. **Reintroduce artifact/attachment/generated-file evidence registration.**

   Conflicts with the record-slot evidence model. Keep old references only as historical problem statements.

### Defer

Defer these items until a concrete need or telemetry justifies them.

1. **Dedicated record metadata tool.**

   Current `get_card` record summaries and `record://` reads cover most needs. A generic metadata tool can wait until a caller needs standalone metadata for arbitrary URLs.

2. **Nullable Analyst `ProcessRecord.card_id`.**

   Current schema requires `card_id`, so Analyst processes use the session id there as non-authoritative scope metadata and mark `owner_kind: 'operator'`. Making `card_id` nullable is cleaner, but it touches API contracts and UI assumptions. Defer to a focused process-schema cleanup.

## Current-Code Improvement Backlog

These are cleanup and simplification opportunities on the existing implementation. They are not new features. Each item is classified as one of:

- **FIX**: a feature that should work but is broken or incomplete. Must be repaired, not deleted.
- **DELETE-OLD-REMNANT**: code from a previous implementation that has a working replacement. Safe to remove.
- **DELETE-NEVER-IMPLEMENTED**: scaffolding for a feature that was never built and is not in the spec. Safe to remove.
- **SIMPLIFY**: working code that can be cleaner.

### 0. Broken Features That Need Fixing

These are not dead code. They are features the spec promises and tools expose, but the implementation is broken or unwired. They must be fixed before the dead plumbing around them is removed.

1. **FIX: Agent-facing notification delivery is broken.** `[HIGH PRIORITY]`

   The spec promises that `queue_notification` delivers content into the next agent session, and that analyst card edits notify affected running planners. Neither works today.

   **Full design:** [Notification Delivery Fix Design](./notification-delivery-fix-design.md).

   The working delivery mechanism (`CardActor.enqueueNotification` → `deliverNotificationsForInput` → LLM context) already exists for cancellation-while-running. Nothing connects the queuing tools to it. `queue_notification` writes to a session-keyed `NotificationCenter` that no agent drains. `propagateChange` routes through dead `ActiveGoalNoteSinks` / synthetic-planner-notes.

   The fix adds `notifyCard(cardId, notification)` to `RuntimeApi` — the runtime owns the `CardActor` registry and tools already have runtime access. Live actor → `enqueueNotification`. Inactive card → append to actor snapshot (no processor allocation). `CardActor.fromCard()` is fixed to restore notification state from snapshots so persisted notifications survive restart.

   `propagateChange`'s `flipped` field IS read by `analyst-stage6.ts` and must be kept. `notified_planner_session_ids` and `stopped_at_running` become dead after the fix and are removed.

   References: `src/notifications/*`, `src/runtime/changed-propagation.ts`, `src/runtime/actors/card-actor.ts`, `src/runtime/actors/snapshots.ts`, `src/runtime/actors/supervisor-runtime-api.ts`, `src/tools/planner-control-provider.ts`, `src/tools/analyst-misc-tools.ts`, `src/tools/analyst-card-tools.ts`, `src/agents/analyst-stage6.ts`.

### A. Dead Subsystems — Old Remnants With Working Replacements `[DELETE-OLD-REMNANT]`

Whole modules from the pre-micro-actor runtime that were replaced by working equivalents. These are the highest-leverage, lowest-risk deletions.

1. **Delete dead `ProcessActor` and its recovery path.**

   `src/runtime/actors/process-actor.ts` is never instantiated in production; process execution goes through `process-runner.ts` + `ProcessProvider`. Cascading dead surface: `processActorId`/`parseProcessActorId` in `ids.ts`, the `'process'` actor kind in `actor-vocabulary.ts`, the `process/` snapshot scan in `snapshots.ts`, and the `processes` recovery branch in `actor-recovery.ts`. Spec §17 confirms live process reattachment is intentionally not required.

   Status: completed in the ProcessActor cleanup slice.

2. **Delete dead `runtime/context-builder.ts` and `runtime/goal-context.ts`.**

   Both files are vestigial pre-micro-actor prompt assembly. The live planner prompt path uses `buildPlannerStateContextMessage` in `agents/planner-state-context.ts`. `goal-context.ts` also duplicates a type union already present in `context-builder.ts`.

   Status: completed in the Stage 1 cleanup slice after the notification fix.

3. **Delete dead `runtime/transition-policy.ts`.**

   The legacy state-machine dispatch policy was superseded by the micro-actor `CardActor` state machine and `cards/lifecycle.ts` validation. No production caller imports it.

   Status: completed in the Stage 1 cleanup slice after the notification fix.

4. **Delete dead `RuntimeEventPublisher` class — but relocate `buildRuntimeDiagnosticEvent` first.**

   `RuntimeEventPublisher` is never instantiated in production. It was superseded by direct `appendEvent` calls. Its test even asserts that `emitAgentEvent` is a forbidden API. **Important:** the same file exports `buildRuntimeDiagnosticEvent`, which IS live (called from `analyst-handler.ts`). Relocate that helper before deleting the class.

   Status: completed in the Stage 1 cleanup slice after the notification fix; helper now lives in `src/runtime/runtime-diagnostic-event.ts`.
5. **Delete dead worker/stage/clearance normalizer modules.**

   `schemas/worker-report-normalizer.ts`, `schemas/worker-dispatch-envelope-normalizer.ts`, and `schemas/sanitized-clearance-report.ts` have zero production callers and belong to an abandoned worker/dispatch/clearance concept not present in the card-centered spec.

   Status: completed in the Stage 1 cleanup slice after the notification fix.

6. **Delete tests-only `runtime/terminal-commit` abstraction.**

   `src/runtime/terminal-commit/*` has no production imports and is kept alive by `tests/runtime/terminal-commit.test.ts`. Delete the source module and its tests; do not preserve a compatibility facade.

   Status: completed in the Stage 1 cleanup slice after the notification fix.

7. **Delete dead server lifecycle composition modules.**

   `server/composition/mcp-lifecycle.ts`, `runtime-lifecycle.ts`, and `server-shutdown.ts` are source-dead duplicates of logic inlined in `server-services.ts`. Delete only those lifecycle files. Keep live route/server composition modules (`route-composition.ts`, `fastify-app.ts`, `server-services.ts`, `telegram-lifecycle.ts`).

   Status: completed in the Stage 1 cleanup slice after the notification fix.

8. **Delete old notification remnant plumbing — only after fixing notifications (§0.1).**

   After `queue_notification` and `propagateChange` are rewired to `CardActor`: delete `ActiveGoalNoteSinks` (`active-goal-note-sinks.ts`), `synthetic-planner-notes.ts`, and the `queuePlannerNote`/live-sink branches in `changed-propagation.ts`. These are old-runtime remnants whose consumers were deleted during the micro-actor refactor.

   Status: completed in `69b5845a`.

### B. Never-Implemented Scaffolding `[DELETE-NEVER-IMPLEMENTED]`

Config, events, and modules for features that were never built and are not in the spec.

1. **Delete `ContentSupervisor` module first; decide supervision storage/UI separately.**

   `src/workspace/content-supervisor.ts` is never constructed in production. The spec does not mention content supervision. Its `eventBus` field, `emitBlocked` method, and silent error swallowing are dead. However, `/api/debug/supervision` does not call `ContentSupervisor`; it reads quarantine/review files directly, and file-tree initialization creates those files independently. Clean cut: delete the dead module/export first. If removing the supervision concept entirely, delete the storage files, route, `web/src/views/DebugView.vue` supervision tab, debug store/read-model state, and supervision tests in the same focused change.

   Status: completed in the ContentSupervisor cleanup slice; supervision storage/API/UI remain as a separate decision.

 2. **Delete the unwired `supervisor` config section.**

    `config-schema.ts` defines `supervisorSectionSchema` with five fields, none of which are read by any production code. This is the upstream cause of the dead stuck-supervisor event chain. The micro-actor `RuntimeSupervisorActor` is an unrelated name collision — it has no stuck-detection.

    **Deployment blocker:** as of 2026-07-02, checked-in and local target-project configs (`diedrico`, `diedrico-lessons`, `getrich`, `getrich-v2`, `pm`, `pueblicos`, `saivage-e2e-checkers`) still contain a top-level `supervisor` key. The schema is strict, so removing the key will reject these configs on startup. This cleanup must either update all deployed `.saivage/saivage.json` files in the same change, or the cleanup must be sequenced after confirming no running deployment reads the old key.

    Status: completed in the Stage 2 config cleanup slice; listed local target-project configs were updated in the same change.

3. **Split runtime config cleanup into persisted fields vs transform-only defaults.**

   The persisted `runtime` schema currently accepts only a small set of fields, including live `candidateAvailabilityCompactBytes` (read at `src/application/runtime-composition.ts:71`). `recoveryDelayMs` and `maxRecoveryRetries` are transform-added runtime defaults, not persisted `runtime.*` config fields, and are live (read at `src/application/runtime-composition.ts:89-90`). Clean cut: remove unused transform-only defaults separately from auditing persisted runtime fields. `maxGoalDepth` remains misleading if still accepted anywhere while `CardStore` hardcodes `5`; either thread it or delete it.

   Status: completed in the Stage 2 config cleanup slice; persisted runtime config now exposes only persisted fields, and invocation recovery uses `InvocationService` defaults.

 4. **Remove dead config catchalls.**

    `rag: z.unknown().optional()` and `notifications.filters` are accepted by the schema but never read.

    **Deployment blocker:** as of 2026-07-02, several deployed configs contain `rag` (`diedrico`, `diedrico-lessons`, `getrich`, `pm`) and `notifications.filters` (`pm`). Same caveat as B.2 applies.

    Status: completed in the Stage 2 config cleanup slice; listed local target-project configs were updated in the same change.

### C. Dead Event And Schema Surface `[DELETE-OLD-REMNANT]`

All ~32 unwired event catalog kinds are old remnants — they had emitters in the deleted pre-micro-actor runtime (XState/controller/dispatcher/legacy-session stack). The micro-actor runtime replaced event-driven notification with snapshot-persisted state + live projections. The spec never promises specific event kinds; it uses live projections (§17).

1. **Remove unwired event kinds from the catalog.**

   Dead clusters (all traced to deleted code via git history):
   - Lifecycle: `started`/`paused`/`resumed`/`shutdown` — replaced by `RuntimeStatus` live projection.
   - Goal/card/review/dispatch: `goal_completed`/`goal_failed`/`card_failed`/`review_complete`/`review_failed`/`dispatch_blocked`/`dispatch_interrupted`/`project_run_completed`/`plan_updated`/`escalation`/`goal_report_rejected` — replaced by `CardActor` state machine + card store.
   - Ledger: `runtime_command`/`runtime_run`/`runtime_activation` — replaced by in-memory tracking. Only emitted via dead `RuntimeEventPublisher`.
   - Session/LLM: `session_started`/`session_cancelled`/`session_force_cancelled`/`llm_attempt`/`llm_invocation_summary`/`llm_verifier_rejection`/`compaction_triggered` — deleted legacy agent-session stack. Note: if detailed LLM call auditing becomes a product requirement, `llm_attempt`/`llm_invocation_summary` would need re-implementation, not rewiring.
   - Stuck-supervisor: `stuck_supervisor_started`/`stuck_supervisor_stopped`/`stuck_verdict`/`abort_target_selected`/`force_cancel_sent` — tied to dead supervisor config.
   - Diagnostic: `runtime_fatal_error`/`startup_session_sweep` — replaced by `runtime_diagnostic` (still emitted) and snapshot-based recovery.

    **Compile dependency:** `src/server/sync-hub.ts` `liveSyncEventKinds` array and `mapLiveSyncEvent` switch reference many of these kinds. They must be stripped from `sync-hub.ts` in the same change, or TypeScript compilation will fail.

   Status: completed in the event catalog cleanup slice.

   **Note:** `model_issue` was removed as an *event kind* but remains live as a *conversation message kind* (`MessageKind` in `schemas/types.ts`, persisted in agent messages). The two are independent — do not remove the message kind.

2. **Delete remaining hand-written per-event schemas.**

    After the event catalog cleanup, only 5 hand-written per-event schemas remain in `schemas/validators.ts` (`processReconciledDeadEventSchema`, `processReattachRejectedEventSchema`, `runtimeDiagnosticEventSchema`, `runtimeActionableErrorEventSchema`, `mcpToolInvocationEventSchema`) plus their `baseEventSchema`/`passthroughBaseEventSchema` helpers. All 5 are redundant with catalog-derived `loggedEventSchemaByKind`/`payloadSchemaByKind` and have zero production importers. Two are exercised by `tests/schemas.test.ts`; the other three are only re-exported. Delete the hand-written schemas, their `schemas/index.ts` re-exports, and update tests to use catalog-derived validators.

   Status: completed in the per-event schema cleanup slice.

3. **Remove dead `runtime_activation` redaction allowlist.**

    After removing the `runtime_activation` event kind, the redaction exception in `src/redaction/index.ts` is dead: `preserveRuntimeActivationIdempotencyKey` (interface field, line 33), the `observability.log` policy setting (line 70), `isRuntimeActivationLedgerIdempotencyKey()` (lines 198-206), and the `shouldRedactKey` branch (line 209) can never match because no emitted event has `kind === 'runtime_activation'`. Delete all four.

    Status: completed in the redaction cleanup slice.

4. **Remove stale reviewer assessment code, then schema surface.**

   The active reviewer terminal contract is `emit_result` with `{ status, summary }`. `runtime/reviewer-assessment.ts` (`buildReviewAssessment`, `validateReviewerAssessment`), reviewer assessment schema fields (`achieved`, `issues`, `evidence_card_ids`), and related tests preserve the older structured `pass` / `needs_corrections` path. Also update the reviewer prompt to use `done | rework | blocked | failed` and direct evidence narrative to `review.md`.

   **Important:** `reviewer-assessment.ts` also exports `nextReviewerAssessmentId` and `reviewerSessionId`, which ARE live (called from `src/runtime/actors/planning-card-processor-actor.ts:191-192`). Relocate these before deleting the file. Also account for `reviewAssessmentSchema` being embedded in `activationCompletionEnvelopeV1Schema.review`; remove that schema only after the activation-completion envelope no longer references structured reviewer assessment.

   Status: completed in the reviewer assessment cleanup slice.

### C. Config And Provider Duplication

1. **Unify config loading.**

   `loadConfig` in `config-schema.ts` duplicates `loadEnvironment` in `config/environment.ts` and is re-read per `AnalystHandler` instance. Make `loadEnvironment` the single source and thread the parsed config through.

2. **Unify model-role resolution.**

   `getModelListForRole` and `validateModelRoles` are two parallel implementations of the same precedence rule. Extract one shared resolver.

3. **Collapse `Candidate` / `candidateKey` duplication.**

   Defined in both `agents/provider.ts` and `contracts/provider-candidate.ts`. Pick one canonical home and re-export from the other.

4. **Remove triple-duplicated OAuth token-endpoint inference.**

   Three independent copies exist; only `credential-source-resolver.ts` is live. Delete the dead `resolveTokenEndpoint` in `config-schema.ts` and the `Account.effectiveTokenEndpoint` method if the probe script is inlined.

5. **Remove dead provider/router accessors and parameters.**

   `ModelRouter._projectRoot` (unused param), `ModelRouter.getRegistry/getConfig/nextCandidate` (dead), `getRuntimeConfig` (dead wrapper), `Account.effective*` (probe-script only).

6. **Replace over-defensive `ProviderRegistry` fallback with fail-fast.**

   `getEffectiveCapabilities` falls back to built-in capabilities when the provider is missing, but the provider is guaranteed to exist by construction. Per AGENTS.md, this should throw.

### D. Persistence And Server Cleanup

1. **Delete `cards.ts` 180-line padding block.**

   `server/routes/cards.ts` has 180 lines of padding comments kept for a source-anchor checker. This violates the no-compatibility rule. Delete the padding and evaluate sunsetting `check-source-anchors.js`.

2. **Remove dead persistence primitives.**

   `PersistentQueue` is never used in production. `appendSyncIdempotent` (entry-id variant) is dead. `JsonlLedger` read API is test-only (production reads bypass it). `byIdDir`/`historyDir` are dead and identical. `loadProjectConfig`/`findSaivageDir` are test-only.

3. **Remove no-op logger lifecycle methods.**

   `EventLogger` and `ErrorLogger` `flush`/`flushSync`/`close` are empty bodies with live callers. Delete the methods and all call sites, including `src/application/runtime-composition.ts:151-152`, `src/runtime/process-runner.ts:784-786`, and `src/application/read-models/events-read-model.ts:40`.

4. **Remove dead server barrels and exports.**

   `server/index.ts` is a dead duplicate of `server-api.ts`. `stopServer` and `getServerConfig` are dead exports. `registerChatsFilesDebugRoutes` is a redundant alias.

5. **Contract-back debug routes or document the exception.**

   `/api/debug/doctor` and `/api/debug/supervision` bypass the contract system. Either contract-back them or document why they are intentionally outside.

### E. Web UI Cleanup

1. **Delete dead UI components.**

   `PanelHeading.vue`, `Spinner.vue`, `Pill.vue`, `StatusDot.vue` have zero production renderers (some are kept alive only by a primitives test).

   Status: completed in the UI primitive cleanup slice.

2. **Delete dead API client functions.**

   `getHealth`, `getConfig`, `getProviders`, `getProcess` have zero callers in `web/src/`.

   Status: completed in the web API client cleanup slice.

3. **Remove dead websocket surface.**

   `WsConnectionManager.onType` is dead. `reconnectAttempts` is exposed but unconsumed.

   Status: completed in the websocket cleanup slice.

 4. **Remove over-defensive environment guards.**

    `web/src/api/auth.ts` guards `typeof localStorage` / `typeof import.meta` in a Vite SPA with no SSR.

    Status: completed in the auth cleanup slice.

 5. **Remove dead `terminal_tool` timeline rendering in `DebugView.vue`.**

    After the event catalog cleanup removed `llm_attempt`/`llm_invocation_summary` events, the `eventTerminalTool()` helper (`web/src/views/DebugView.vue`), the template chip, the CSS rule (`.tl-event-terminal-tool`), and the `'terminal_tool'` filter key in `timelineDetails` are all dead — no emitted event carries `outcome.terminal_tool`, `final_terminal_tool`, or legacy `terminal_tool`. The test that covered this path (`event-log-terminal-tool.test.ts`) was already deleted. Note: `RawLlmExchangePanel`'s `terminal_tool` badge is a separate live feature reading raw LLM exchange files, not timeline events.

    Status: completed in the DebugView timeline cleanup slice.

### F. Actor And Card Simplification

1. **Shrink `evaluateReviewerTerminalOutcome` inputs.**

   Five fields in `ReviewerTerminalEvaluationInput` (`card`, `candidatePlanning`, `sessionId`, `store`, `assessmentId`) are never read. Shrink to `{ outcome }` and update both call sites.

   Status: completed in the reviewer terminal evaluation cleanup slice.

2. **Remove `apply-mutation.ts` async wrappers.**

   `applyMutation` and `applyMutationGroup` are async functions that only `return applyMutationSync(...)`. The file comment admits they exist "solely for API stability" — a compatibility shim.

   Status: completed in the apply-mutation cleanup slice.

3. **Extract shared contract-bounded repair loop.**

   Both processor actors duplicate the same repair-loop skeleton (`result`→repair, `error`→fail, terminal→validate, `MAX_TERMINAL_CONTRACT_REPAIRS = 2`). Extract a shared helper.

   Status: completed in `bfd85de3` (`contract-bounded-repair-loop.ts`). The reviewer relaunch/stale path uses a sentinel `'stale'` value threaded through the generic loop result.

4. **Remove dead `CardStore` and `current-run` exports.**

   `CardStore.open`, `validateHistoryEntry`, `loadCardHistoryEntries` are dead. `deriveCurrentAgentSessionId*` in `current-run.ts` are dead.

 5. **Remove dead `changed-propagation` return fields.**

    Both `stopped_at_running` and `notified_planner_session_ids` have been removed from code — `propagateChange` now returns only `{ flipped }`. Stage 0's notification fix (`69b5845a`) eliminated the need for `notified_planner_session_ids`, and both fields were deleted in the same change. `flipped` remains live (`src/agents/analyst-stage6.ts:15`).

    Status: completed.

6. **Narrow over-broad `catch {}` in record-slot helpers.**

   Bare `catch {}` blocks in record-slot close/recover paths hide genuine filesystem failures. Narrow to expected failure shapes and rethrow the rest.

### G. Tool Surface And Prompt Cleanup

1. **Collapse Analyst control-tool result envelopes.**

   Analyst control tools return preview/error-envelope shapes that the handler strips to the shared invocation `ToolResult`. Replace with the common result type unless a concrete UI preview path exists.

   Status: partially completed in `04dd30ee`. The `ActionPreview`, `ToolErrorEnvelope`, and the audit-runner `preview` callback were correctly removed as dead. **Rework needed (K.1):** the shared `ToolResult` (`src/tools/invocation.ts`) was widened from a discriminated union to `{ success: boolean; data?: unknown; error?: string }`, which lost type-safety narrowing and made `error` optional on failures. It must be tightened to `{ success: true; data?: unknown } | { success: false; error: string; data?: unknown }`. This preserves diagnostic `data` on failures (needed by `reorder_set_mismatch`, `unknown_recipient`, etc.) without weakening the contract. As a consequence, `toolFailure` at `src/tools/analyst-tool-helpers.ts:75` currently discards `_kind`/`_details`/`_retryable` and `classifyToolError` at `:79` computes a `kind` that is immediately discarded — both must be cleaned up (either remove the dead params or route `details` into the failure `data`).

2. **Replace stale Analyst prompt/tool-list generation.**

   The Analyst prompt's static `<TOOL_LIST>` is based on control-tool definitions, while the actual surface is composed from providers. Derive from `InvocationSurface` or document the static list as control-tools-only.

   Status: partially completed in `04dd30ee`. `getAnalystSystemPrompt(tools)` now renders the composed invocation surface definitions in production (`src/agents/analyst-handler.ts` line 305); the dead `getAvailableAnalystToolNames` helper was removed. **Rework needed (K.2):** `getAnalystSystemPrompt` at `src/agents/analyst-prompt.ts` line 70 still defaults to static `ANALYST_TOOL_DEFINITIONS` when called with no args, and two tests (`tests/agents/analyst-tool-surface.test.ts` and `tests/agents/analyst-system-prompt.test.ts`) use that default. This leaves a reusable footgun that can reintroduce the exact stale-tool-list issue. The `tools` argument must be made required, and the tests updated to pass explicit definitions.

3. **Reduce duplicate role/tool policy lists.**

   Provider composition is now the authority. Remove or shrink `RoleToolPolicy` where it duplicates provider surfaces.

   Status: completed in `a1c3c411`. Divergence: `RoleToolPolicy` was deleted entirely (not just shrunk) along with its two test files, since provider composition is the sole authority and the only production call site (Analyst handler filter) was a redundant re-check of already-Analyst control tools. Stage 5 H.1 restored explicit negative-surface coverage for the actual Analyst, planner, reviewer, and executor invocation surfaces.

4. **Rename or split `tool-catalog.ts`.**

   The file is not an execution catalog anymore, but it is more than vocabulary constants: it defines shared tool definition/executor types and schema helpers used across production tool providers. Do not inline everything. Clean cut: rename it to a neutral home such as `tool-definition.ts`, or split shared definition/schema helpers from Analyst-only vocabulary. Also consolidate the duplicated `AgentRole` type (defined in both `schemas/types.ts` and `tool-catalog.ts`) — keep only the `schemas/types.ts` one and update `record-slots.ts`'s import.

   Status: completed in `80783f66`. Renamed to `tool-definition.ts`; `AgentRole` is now re-exported from `schemas` (single source) with `tool-definition.ts` re-exporting it. **Note:** `src/tools/tool-definition.ts` still imports `ToolContext` from `analyst-tool-types.ts`, and `ToolExecutor` is Analyst-context-shaped, so the "neutral home" is still partly Analyst-specific. This is not broken, but if the file grows it should be split: vocabulary/schema helpers separate from Analyst control-tool definition types. Tracked as low-priority; no immediate rework needed.

5. **Remove tests-only `ToolRuntime` and package-root barrels.**

   `src/tools/runtime.ts` is dead production code (only `tool-definition-serializer.ts` imports a type from it). Delete or inline.

   Status: completed in `855aceeb`. The `ToolRegistrySchemaEntry` type was inlined into `tool-definition-serializer.ts`; `src/tools/index.ts`, `src/tools/runtime.ts`, and both test files were deleted.

### H. Test Hardening

1. Completed: add actual-surface tests for retired tool names.

   Tests now assert the Analyst active surface excludes the retired vocabulary and never includes `emit_result`, planner/reviewer actual LLM inputs lack `apply_patch`, and executor retains only its expected composed surface.

2. Completed: add websocket-level Analyst process cleanup test.

   `AnalystHandler.shutdownSessionProcesses` is tested directly, and websocket `close`/`error` paths now verify cleanup for the initialized Analyst session.

3. **Delete dead `_llm-test-helpers.ts` and consolidate duplicated test helpers.**

   `tests/agents/_llm-test-helpers.ts` is never imported. The same logic (`toolsOpts`, `asMessage`, `*Result` builders) is hand-copied in 4+ test files. Delete the dead file and consolidate the duplicates.

4. **Add focused missing-record repair tests.**

   Planner/executor missing `status.md` repair is currently indirect (helpers auto-insert records). Add explicit tests without helper auto-insertion.

### I. Documentation And Spec Cleanup

1. **Clean stale current docs/spec vocabulary.**

   `wait_for_process` (canonical: `wait_process`), `read_file`/`read_file_metadata`, `ToolDispatcher`, `ActorToolSurface` in current docs.

2. **Update architecture index.**

   Add entries for the consolidated remaining-work plan and future-capabilities plan.

### J. Miscellaneous Low Priority

1. **Process API cleanup.** Remove misleading termination-availability fields or wire operator termination now that agent `kill_process` exists.

2. **Legacy runtime-state layout cleanup.** Remove `.saivage/runtime/state.json` diagnostics if no deployment needs them.

3. **Lessons module audit.** Move `src/lessons/*` out of `src/` or delete if only test-supported.

4. **`EventsReadModelService` allocation churn.** It constructs a fresh `EventLogger` per request. Hoist to the service constructor.

5. **Dead `MAX_ANALYST_OUTPUT_BYTES`.** Unused constant in `command-policy.ts`.

6. **Dead derived-type exports.** `config-schema.ts` exports six types nobody imports.

### K. Rework From Review

These items were discovered during a full review of the Stage 3–4 work. They must be done before Stage 5 so that the cleanup does not ship with weakened contracts or stale defaults.

1. **Tighten `ToolResult` back to a discriminated union.**

   `src/tools/invocation.ts:7` currently uses `{ success: boolean; data?: unknown; error?: string }`. Restore type-safety narrowing and keep `error` required on failures:
   ```ts
   export type ToolResult =
     | { success: true; data?: unknown }
     | { success: false; error: string; data?: unknown };
   ```
   Then clean up `toolFailure` (`src/tools/analyst-tool-helpers.ts` line 75) and `classifyToolError` (`src/tools/analyst-tool-helpers.ts` line 79): either remove the now-dead `_kind`/`_details`/`_retryable` parameters or route `details` into the failure `data` field. Remove the `?? 'failed'` / `?? 'Web tool failed.'` fallbacks that were added to work around optional `error`.

2. **Make `getAnalystSystemPrompt(tools)` require its argument.**

   Remove the `= ANALYST_TOOL_DEFINITIONS` default at `src/agents/analyst-prompt.ts:70`. Update the two tests that call it with no args (`tests/agents/analyst-tool-surface.test.ts` and `tests/agents/analyst-system-prompt.test.ts`) to pass explicit definitions. This prevents accidental reintroduction of the stale static tool list.

3. Completed: fix pre-existing web Vitest failures.

   The Stage 4 web gate is green after restoring the canonical analyst session id (`analyst:global`), adding the missing process `owner_id` fixture, and mounting content/tool-chip tests with Pinia where components use `useCardStore`.

## Execution Plan

Stages are ordered by priority and dependency. Notification fixing comes first because it is a broken spec-promised feature. Dead-code deletion follows. Each stage should be done in small, separately validated slices.

### Stage 0: Fix Broken Notification Delivery

Goal: make `queue_notification` and analyst card edits actually reach agents.

Tasks (backlog §0.1):

1. Add `notifyCard(cardId, notification)` to `RuntimeApi` interface; implement in `SupervisorRuntimeApi` (live actor → enqueueNotification; inactive → snapshot write + done→changed flip).
2. Add `readActorSnapshot` and `appendNotificationToActorSnapshot` helpers to `snapshots.ts`.
3. Fix `CardActor.fromCard()` to restore notification state from snapshot.
4. Add `notifyCard` forwarding to `createComposedRuntimeApi`.
5. Rewire `queueNotification()` to resolve recipients to card IDs and call `notifyCard`; keep external adapter delivery.
6. Rewire `propagateChange()` to call `notifyCard` for the edited card and the first running ancestor; drop dead return fields.
7. Update `markGoalNeedsCorrections` callers for the dropped `notified_planner_session_ids`.
8. After tests pass, delete old remnant plumbing (`ActiveGoalNoteSinks`, `synthetic-planner-notes.ts`, `queuePlannerNote` branches).

Validation:

- End-to-end test: analyst queues a notification → running planner receives it in next LLM input.
- End-to-end test: analyst edits a brief → running ancestor planner receives a change notification.
- Existing cancellation-while-running test still passes.
- `npm run validate:routine`

### Stage 1: Dead Subsystem And Whole-File Deletions

Goal: remove entire modules that exist only in tests or were superseded by the micro-actor runtime.

Tasks (backlog group A, excluding A.8 which depends on Stage 0):

1. Completed: delete dead `ProcessActor` + recovery path + actor kind.
2. Completed: delete dead `context-builder.ts`, `goal-context.ts`, `transition-policy.ts`.
3. Completed: relocate `buildRuntimeDiagnosticEvent`, then delete dead `RuntimeEventPublisher` class + `logged-event.ts`.
4. Completed: delete dead worker/clearance normalizer modules.
5. Completed: delete tests-only `runtime/terminal-commit` source and tests.
6. Completed: delete only the dead server lifecycle composition modules (`mcp-lifecycle.ts`, `runtime-lifecycle.ts`, `server-shutdown.ts`).
7. Completed: after Stage 0 lands, delete old notification remnant plumbing (A.8).

Validation:

- `npm run typecheck`
- Focused tests for any touched module.
- `npm run validate:routine`

### Stage 2: Never-Implemented Scaffolding And Dead Event Surface

Goal: remove config/events/schemas for features that were never built or were replaced by projections.

Tasks (backlog groups B and C):

1. Completed: delete `ContentSupervisor` module/export; remove supervision route/storage/UI only if intentionally deleting the whole supervision concept.
2. Completed: remove unwired `supervisor` config section and split runtime config cleanup into persisted fields vs transform-only defaults.
3. Completed: remove dead config catchalls (`rag`, `notifications.filters`).
4. Completed: remove unwired event kinds from the catalog (all confirmed old-remnant).
5. Completed: delete remaining 5 hand-written per-event schemas (C.2).
6. Completed: remove dead `runtime_activation` redaction allowlist (C.3).
7. Completed: remove stale reviewer assessment schemas and code; update reviewer prompt (C.4).

Validation:

- `npm run test:direct -- tests/schemas.test.ts tests/runtime/actors/planning-card-processor-actor.test.ts --runInBand`
- `npm run validate:routine`

### Stage 3: Config, Provider, And Persistence Deduplication

Goal: eliminate duplicated loading/routing/persistence paths.

Tasks (backlog groups D and E):

1. Unify config loading (`loadConfig` → `loadEnvironment`).
2. Unify model-role resolution and `Candidate` types.
3. Remove dead provider/router accessors and triple-duplicated OAuth inference.
4. Replace over-defensive `ProviderRegistry` fallback with fail-fast.
5. Delete `cards.ts` padding block and dead persistence primitives.
6. Remove no-op logger lifecycle methods and dead server barrels.

Validation:

- `npm run test:direct -- tests/agents tests/persistence tests/server --runInBand`
- `npm run validate:routine`

### Stage 4: Web, Actor, And Tool-Surface Cleanup

Goal: remove dead UI, shrink actor interfaces, and simplify tool plumbing.

Tasks (backlog groups F, G, H, K):

1. Partially completed: delete dead UI components, dead API client functions, dead websocket surface, and auth environment guards.
2. Completed: shrink `evaluateReviewerTerminalOutcome` inputs and remove async mutation wrappers.
3. Completed (`bfd85de3`): extract shared contract-bounded repair loop.
4. Completed (`04dd30ee`): collapse Analyst control-tool result envelopes and fix prompt tool-list generation.
5. Completed (`a1c3c411`, `80783f66`, `855aceeb`): remove duplicate `RoleToolPolicy`, rename `tool-catalog.ts` → `tool-definition.ts`, and remove dead `ToolRuntime`.
6. Completed: tighten `ToolResult` back to a discriminated union with optional `data` on failures; clean up `toolFailure`/`classifyToolError` dead params.
7. Completed: make `getAnalystSystemPrompt(tools)` require its argument; update tests.
8. Completed (`c6269faa`): remove dead `CardStore.open`, `validateHistoryEntry`, `loadCardHistoryEntries`, and `deriveCurrentAgentSessionId*` in `current-run.ts`.
9. Completed: narrow over-broad `catch {}` in record-slot close/recover paths.
10. Completed: fix pre-existing web Vitest failures so the web gate is green.

Validation:

- `cd web && npx vitest run` — passing: 109 files, 372 tests.
- `npm run test:direct -- tests/runtime/actors tests/tools tests/agents/analyst-tool-surface.test.ts --runInBand` — passing.
- `npm run validate:routine` — passing.

### Stage 5: Test Hardening, Docs, And Misc

Goal: lock in the cleanup with proper tests and current documentation.

Tasks (backlog groups I, J, K):

1. Completed: add actual-surface tests for retired tool names and planner/reviewer `apply_patch` absence.
2. Completed: add websocket-level Analyst process cleanup test.
3. Delete dead `_llm-test-helpers.ts` and consolidate duplicated test helpers.
4. Add focused missing-record repair tests.
5. Clean stale doc/spec vocabulary and update the architecture index.
6. Process API cleanup, runtime-state layout, lessons module, and other low-priority items.

Validation:

- Full focused suites per touched area.
- `npm run validate:routine`
- `npm run validate:ui-smoke`

## Non-Goals

- No compatibility shims for removed tool names.
- No global tool execution catalog revival.
- No new feature work in the current cleanup backlog; see [Future Capabilities Plan](./future-capabilities-plan.md).
- No broad card schema cleanup bundled into record-slot work.
- No deletion of `CardActor.notify()` / `markChanged()` / notification delivery mechanics — they are the intended design and must be wired, not removed.

## Recommended Next Action

Stages 0–4 are complete and Stage 5 H.1-H.2 are complete. Continue with H.3 test-helper cleanup.
