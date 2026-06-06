# Saivage v3 Architecture Review — Metaplan

Generated: 2026-06-06

## Wave Ordering Principle

Each wave is a cohesive batch of related changes that can be validated end-to-end before proceeding. Earlier waves establish concrete seams that later waves must consume rather than redesign. The order reflects: persistence and utility primitives first, card read/write semantics before CardStore decomposition, path unification before AgentAdapter decomposition, and targeted cleanup after the main ownership boundaries are stable.

Forward compatibility has zero weight. Delete parallel paths rather than bridge them. Prefer small ownership corrections over compatibility shims or broad abstraction layers.

---

## Wave 1: Persistence & Utility Primitives

**Goal:** Establish clean, shared persistence primitives and utility functions that all later waves depend on.

**Issues:** F05, F12, F17, F31

**Why first:** Later waves touch durable writes, locks, JSONL helpers, timestamps, equality checks, and diary/runtime state reads. Consolidating these primitives first prevents later waves from preserving duplicated helpers in newly extracted modules.

| Issue | What changes | Key files |
|-------|-------------|-----------|
| F05 | Create `src/persistence/durable-write.ts` as the single owner of `fsyncDir`, `fsyncDirAsync`, `fsyncFile`, `writeFileAtomic`, and `writeFileSyncDurable`. Export these directly from `persistence/index.ts`; `file-tree.ts` may import them but must not re-export them. | `src/persistence/durable-write.ts`, `src/persistence/atomic-json-file.ts`, `src/persistence/file-tree.ts`, `src/cards/apply-mutation.ts`, `src/cards/commit-marker.ts`, `src/auth/auth-profile-store.ts` |
| F12 | Keep `ProjectLock.withLockSync`. Add stale-lock detection to both sync and async acquisition. Default `staleLockAction` to `'error'`; explicit recovery paths may opt into same-host dead-PID removal. | `src/persistence/project-lock.ts`, `src/persistence/errors.ts` |
| F17 | Add one `now()` helper and one `valuesEqual()` helper. Use `src/cards/value-equality.ts`, not a catch-all shared module. Replace `invocation-recovery-policy.ts` secret regex duplication with the existing `redactTextForOutbound` path. | `src/utils/clock.ts`, `src/cards/value-equality.ts`, `src/agents/invocation-recovery-policy.ts` |
| F31 | Keep `JsonlLedger` as the versioned ledger class and move raw idempotent append/tail helpers to `src/persistence/raw-jsonl.ts`. Make diary read failures explicit with `DiaryReadError` and `DiaryIntegrityError`. | `src/persistence/jsonl-ledger.ts`, `src/persistence/raw-jsonl.ts`, `src/cards/diary.ts` |

**Validation:** `npm run validate:routine`, `npm test`. Manual/focused checks: local fsync helpers removed, `now()` and `valuesEqual()` duplicates removed, raw JSONL helpers import from `raw-jsonl.ts`, stale-lock error/removal behavior works, diary missing-directory vs indexed-missing-file behavior is explicit.

---

## Wave 2: Card Data Model

**Goal:** Make `CardStoreState` the authoritative in-memory read model. Eliminate full-filesystem-scan-on-read. Move I/O and validation out of state.

**Issues:** F03, F24, F30

**Why second:** Card reads and mutations are core runtime infrastructure. Decomposing `CardStore` in Wave 5 requires the state model, loader, validator, and mutation-time consistency rules to be stable first.

| Issue | What changes | Key files |
|-------|-------------|-----------|
| F03 | Remove `refreshState()` from reads and mutation methods that no longer need it. Reads do zero I/O. Add explicit `invalidate()` that immediately reloads from disk. Keep defensive `deepClone` in this wave. | `src/cards/card-store.ts`, `src/cards/state.ts` |
| F24 | Split `CardStoreState` into pure read model, filesystem loader, validator, and error modules. Remove denormalized persisted `blocks` from `CardRecord`; expose derived blockers through `CardStore.blocksFor(id)`. Normalize legacy `blocks` in card files and history snapshots during load. | `src/cards/state.ts`, `src/cards/validator.ts`, `src/cards/errors.ts`, `src/persistence/card-loader.ts`, `src/schemas/types.ts`, `src/schemas/validators.ts` |
| F30 | Keep sequential `card-N` IDs. Move existing `generateId` into the `create()` project-lock body and reload state inside that lock before ID/parent/depth/position validation. Do not add `ulid` or random IDs. | `src/cards/card-store.ts`, `src/cards/apply-mutation.ts` |

**Validation:** `npm run validate:routine`, `npm test`. Manual/focused checks: sequential unique `card-N` under concurrent create, no filesystem reads on normal reads, two-store stale-before-invalidate and fresh-after-invalidate behavior, card CRUD/status/archive/position repair still work, persisted/history `blocks` normalization works.

---

## Wave 3: Architecture Boundaries

**Goal:** Enforce clean module boundaries. Web imports server-owned contracts through explicit aliases. HTTP contract routes have one auth authority. Misplaced mutable implementation code moves out of `contracts/` without deleting legitimate cross-boundary contracts.

**Issues:** F09, F08, F34

**Why third:** Boundary cleanup prevents later unification/decomposition from creating more fragile relative imports, duplicated auth paths, or mutable runtime implementation code in contract modules. Wave 4 does not strictly depend on Wave 3, but boundary drift found after Wave 3 must be reflected in later plans before implementation continues.

| Issue | What changes | Key files |
|-------|-------------|-----------|
| F09 | Add web TypeScript/Vite aliases for `@saivage/contracts` and `@saivage/schemas`. This is a web-only source-alias boundary, not a new package or generated contract build. Keep `web/src/api/contracts.ts` as the curated web barrel. | `web/tsconfig.json`, `web/vite.config.ts`, `web/src/api/contracts.ts`, `web/src/api/types.ts` |
| F08 | Make `ContractRuntime` the single HTTP contract auth authority. Move `/api/auth/ws-ticket` into operator contracts. Remove `auth.ts`, `routes/auth.ts`, duplicate `requiresAuth` storage, and the Fastify broad `/api` auth plugin. | `src/server/auth.ts`, `src/server/routes/auth.ts`, `src/server/contract-runtime.ts`, `src/contracts/operator-api*.ts`, `src/server/routes/operator-contracts.ts` |
| F34 | Split session stamper into runtime-owned pure types and mutable counter. Move system prompt implementation to `src/agents/prompts/`. Keep `llm-failure.ts` and `persisted-tool-call.ts` canonical in contracts. Keep `candidate-availability.ts`/`provider-candidate.ts` contract types for now while moving/removing mutable implementation exports. | `src/contracts/session-stamper.ts`, `src/runtime/session-stamper.ts`, `src/runtime/session-stamp-counter.ts`, `src/contracts/candidate-availability.ts`, `src/contracts/provider-candidate.ts`, `src/contracts/system-prompt.ts`, `src/agents/prompts/system-prompt.ts` |

**Validation:** `npm run validate:routine`, `npm test`, `npm run validate:ui-smoke`. Verify web builds without `../../../src/` imports while still explicitly depending on server source through aliases. Verify public routes, protected routes, and ws-ticket route auth behavior.

---

## Wave 4: Path Unification

**Goal:** Make each domain have exactly one owner. Merge parallel LLM transport/recovery, tool dispatch, pause/resume command construction, compaction, and diagnostic publishing into single paths.

**Issues:** F02, F10, F20, F23, F35

**Why fourth:** Unification must happen before decomposition. Decomposing parallel paths preserves duplication; decomposing unified paths creates clean modules.

| Issue | What changes | Key files |
|-------|-------------|-----------|
| F02 | Create a shared `InvocationService` for raw LLM completion orchestration, candidate selection/recovery where shared, recorder/gateway caching, and availability marking. It does not own `AgentLoopDriver`, contract verification, activation barriers, or the full agent turn loop. Analyst-specific session/UI handling remains in analyst code but uses shared persistence where applicable. | `src/agents/agent-adapter.ts`, `src/agents/analyst-llm-resolver.ts`, `src/agents/analyst-handler.ts`, `src/agents/invocation-service.ts` |
| F10 | Create a `ToolDispatcher` that parses args, applies policy, calls adapters, constructs standardized result envelopes, applies truncation policy, and formats errors. Caller loops own assistant/tool-result persistence timing. Planner-control remains a domain adapter and is exempt from unsafe activation/terminal truncation. | `src/agents/agent-tool-executor.ts`, `src/agents/analyst-handler.ts`, `src/agents/planner-control-executor.ts`, `src/agents/tool-dispatcher.ts` |
| F20 | Create pause/resume command handlers that compute state patches and accept effect ports. Keep `control.ts` as the CLI/analyst persisted-state boundary; live runtime uses the same command handler with richer effects and no `runtimeApi` recursion. | `src/runtime/control.ts`, `src/runtime/runtime-pause-resume.ts`, `src/runtime/runtime-control-commands.ts` |
| F23 | Create one `ContextCompactor` with per-session serialization and per-call planner parameters. Extract boundary pruning into `pruneToolBoundary`. Remove module-level compaction state and duplicated boundary trimming. | `src/agents/compaction.ts`, `src/agents/agent-adapter.ts`, `src/agents/context-compactor.ts` |
| F35 | Create `publishRuntimeDiagnostic` as the single runtime diagnostic publisher. It emits on the event bus first, then best-effort appends to `.saivage/runtime/events.jsonl`. Startup-only helpers use `buildRuntimeDiagnosticEvent`. | `src/runtime/runtime-event-publisher.ts`, `src/runtime/runtime-services.ts`, `src/runtime/runtime-planner-dispatcher.ts`, `src/runtime/executor-activation-dispatcher.ts`, `src/runtime/phases/planner-failure-handler.ts` |

**Validation:** `npm run validate:routine`, `npm test`, `npm run validate:ui-smoke`. Key integration tests: analyst chat, planner invocation, tool execution, runtime pause/resume, context compaction, diagnostic event logging. Manual check: full planner loop with invocation, compaction, and tool calls.

---

## Wave 5: Decomposition

**Goal:** Break up god classes and overloaded functions into focused modules without changing the ownership decisions made in Waves 2 and 4.

**Issues:** F01, F04, F13, F14+F22, F11

**Why fifth:** Wave 5 decomposes already-stabilized paths. It assumes Wave 2 card semantics and Wave 4 unification seams. It must not reintroduce read-time filesystem scans, parallel tool dispatch, parallel diagnostic publishing, or alternate pause/resume paths.

| Issue | What changes | Key files |
|-------|-------------|-----------|
| F01 | Split post-Wave-4 `AgentAdapter` around real seams: `AgentInvocationRunner`, `AgentSessionLifecycle`, `AttemptRecorder`, `SessionMessageLog`, and `PlannerEnvelopeTracker`. Keep `AgentAdapter` as a facade; do not move full turn-loop ownership into `InvocationService`. | `src/agents/agent-adapter.ts`, `src/agents/invocation-runner.ts`, `src/agents/session-lifecycle.ts`, `src/agents/attempt-recorder.ts`, `src/agents/session-message-log.ts`, `src/agents/planner-envelope-tracker.ts` |
| F04 | Keep `CardStore` as a facade over focused command/reader services. Extract `CardPatchService` first so lifecycle, hierarchy, archive, and evidence services share patch behavior. Keep shared `applyPatch`/queue-notification behavior accessible to all command objects. | `src/cards/card-store.ts`, `src/cards/reader.ts`, `src/cards/card-patch-service.ts`, `src/cards/lifecycle-commands.ts`, `src/cards/hierarchy-commands.ts`, `src/cards/archive-service.ts`, `src/cards/evidence-ref-service.ts` |
| F13 | Introduce per-server `McpServerRuntime` state machine while keeping `McpManager` as registry/facade. Call existing stdio and streamable-HTTP transport functions directly; do not add lifecycle wrapper modules. | `src/mcp/mcp-manager.ts`, `src/mcp/server-runtime.ts`, `src/mcp/stdio-transport.ts`, `src/mcp/streamable-http-transport.ts` |
| F14+F22 | Split overloaded frontend stores while preserving a single freshness owner, sequence-token cancellation semantics, store barrel exports, and UI behavior. | `web/src/stores/analystChat.ts`, `web/src/stores/debug.ts`, `web/src/stores/cards.ts`, `web/src/stores/index.ts`, new store files |
| F11 | Extract `AnalystWsHandler`, raw-message parsing, analyst session management, and tool-activity projection. Keep live sync dispatch inline/plain-helper rather than extracting a `LiveSyncHandler` class. | `src/server/websocket.ts`, `src/server/analyst-ws-handler.ts`, `src/server/ws-session-manager.ts`, `src/server/tool-activity-projection.ts` |

**Validation:** `npm run validate:routine`, `npm test`, `npm run validate:ui-smoke`, `npm run validate:ui`. Manual check: full end-to-end flows through card operations, agent invocation, analyst chat, WebSocket sync, MCP operations.

---

## Wave 6: Targeted Fixes & Cleanup

**Goal:** Address remaining focused issues and cleanup without reopening the structural ownership decisions from Waves 1-5.

**Issues:** F06, F07, F15, F16, F18, F19, F21, F25, F26, F27, F28, F29, F32, F33

**Why last:** These batches are mostly local or cleanup-oriented, but not all are low-risk. F07 is structurally significant, F32 requires cooperative cancellation design, and F21/F27/F26 have sequencing constraints. Each batch must check whether earlier waves already resolved the target before implementing.

| Issue | What changes | Key files |
|-------|-------------|-----------|
| F07 | Move unbounded runtime arrays behind a locked ledger/projection path owned by runtime state/mutation persistence. Keep `.saivage/tmp/state/runtime.json` as a compact bounded snapshot and add `.saivage/tmp/state/runtime-events.jsonl`. | `src/runtime/state.ts`, `src/runtime/mutations.ts`, `src/runtime/runtime-event-ledger.ts`, `src/runtime/runtime-state-view.ts` |
| F06 | Extract composable effects ports while preserving literal event constraints and existing test-facing effect type names. Use the post-Wave-4 diagnostic publisher shape; do not revive separate emit+append paths. | `src/runtime/effects-ports.ts`, `src/runtime/phases/*.ts`, `src/runtime/startup-repair.ts` |
| F15 | Add a small route factory that reduces boilerplate while preserving explicit auth class, response overrides, route errors, permissions functions, and audit metadata. | `src/contracts/operator-api-core.ts`, `src/contracts/operator-api*.ts` |
| F16 | Delete pure re-export barrels and single-use wrappers after counting importers with `rg`. Preserve/move `redactProviderErrorText` and current tool-catalog exports before deleting barrels. | `src/agents/llm-errors.ts`, `src/agents/system-prompt.ts`, `src/agents/session-persistence.ts`, `src/agents/tool-api.ts`, `src/agents/agent-tool-catalog.ts` |
| F18 | Add `blocker_cause` to `PlannerBlockedResult` in `src/schemas/lifecycle.ts` and set it at blocker creation time. Use free text only as display detail. | `src/schemas/lifecycle.ts`, `src/runtime/planning-blockers.ts`, `src/runtime/phases/planner-phase.ts` |
| F19 | Fold frontend `SyncClient` class into Pinia store while preserving `SyncResourceRegistration` type location/migration, `useAnalystChat` coupling, and direct `WsConnectionManager` lifecycle ownership. | `web/src/sync/client.ts`, `web/src/stores/sync.ts`, `web/src/api/websocket.ts` |
| F21 | Split config schema into schema/load/migrations/selectors modules and update `config-api.ts` with targeted re-exports. Avoid open-ended compatibility barrels. | `src/agents/config-schema.ts`, `src/agents/config-api.ts`, `src/agents/config/*.ts` |
| F25 | Keep `ProcessRunnerService`; merge duplicate module-level behavior into class methods and inject optional `EventLogger` instead of constructing one per audit call. | `src/runtime/process-runner.ts` |
| F26 | Eliminate only `setLlmCallFn`; `config` and `projectRoot` are already constructor-injected. Cache `analystDeps` and invalidate/update it on `setMcpManager()`. | `src/agents/agent-adapter.ts`, `src/application/runtime-composition.ts` |
| F27 | Extract provider credential refreshers from `llm-transport.ts` while preserving the existing `CredentialSourceResolver` integration and project-root-backed persistence. | `src/agents/llm-transport.ts`, `src/agents/credential-source-resolver.ts`, `src/agents/credential-refreshers.ts` |
| F28 | Make pass recording configurable with default off; guard all pass-recording call sites. Change quarantine JSONL to append-only descriptor writes with fsync under lock. | `src/workspace/content-supervisor.ts`, `src/workspace/quarantine.ts` |
| F29 | Move pattern definitions to `heuristic-patterns.ts`; lazy-compile through `getCompiledPatterns()` and add `validatePatterns()`. Keep scanner public API (`scanContent`, `isInjectionSuspicious`, exported types). | `src/workspace/heuristic-scanner.ts`, `src/workspace/heuristic-patterns.ts` |
| F32 | Add cooperative `AbortSignal` cancellation through runtime planner loop, planner phase runner, and `AgentAdapter`. Bare `Promise.race` is not sufficient. Make `RepairBudget` immutable as a separate change. | `src/runtime/runtime-planner-dispatcher.ts`, `src/runtime/phases/planner-iteration-runner.ts`, `src/runtime/phases/planner-phase-runner.ts`, `src/agents/agent-adapter.ts`, `src/agents/invocation-outcome.ts` |
| F33 | Disable stuck-agent supervisor by default until a real checks provider exists. Do not start a no-op timer/listener in production. | `src/runtime/stuck-agent-supervisor.ts`, `src/agents/config-schema.ts`, `src/runtime/runtime-startup.ts` |

**Validation:** `npm run validate:routine`, `npm test`, `npm run validate:ui-smoke`, `npm run validate:ui`, and for release-risk batches `npm run validate:release`. Manual check: runtime state persistence, config loading, WebSocket sync, credential refresh, scanner startup validation.

---

## Dependency Graph

```
Wave 1 (Persistence & Utilities)
  │
  ├──→ Wave 2 (Card Data Model) ──→ Wave 5B (CardStore Decomposition)
  │
  ├──→ Wave 4 (Path Unification) ──→ Wave 5A (AgentAdapter Decomposition)
  │                                   └──→ Wave 5E (WebSocket Handler Decomposition)
  │
  └──→ Wave 3 (Architecture Boundaries) ──→ boundary-sensitive cleanup in Waves 4-6

Wave 5B-5E can proceed independently once their actual prerequisites are present.
Wave 6 batches can start when their local prerequisites are satisfied, but each batch must run its gate first.
```

Waves 2 and 3 can proceed in parallel after Wave 1. Wave 4 depends primarily on Wave 1 and its internal order is **F35 → F23 → F20 → F10 → F02**. Wave 5 assumes Waves 2 and 4; Wave 3 is a boundary hygiene input, not a hard prerequisite for all Wave 5 sub-waves. Wave 6 is not a single linear wave; it is a set of targeted batches with local prerequisites.

---

## Inter-Wave Consistency Gates

These gates are mandatory before starting the next dependent work. Their purpose is to keep the wave plans aligned with the code that actually landed. If a gate finds drift, update the affected wave plan body text and, if needed, this metaplan before implementing more work. Do not add separate review blocks; fix the plan text directly.

| Gate | What to inspect | If drift is found, update | Purpose to preserve |
|------|-----------------|---------------------------|--------------------|
| After Wave 1 | Actual persistence primitive names/exports, `ProjectLock` sync/async behavior, JSONL helper split, diary error behavior, shared `now()`/`valuesEqual()`, redaction consolidation. Confirm `withLockSync` remains unless implementation deliberately replaced all sync callers. | Fix Wave 2/6 references that assume removed sync locking, old atomic-write names, or raw helpers still living in `jsonl-ledger.ts`. Fix Wave 5 service extraction text if it imports stale persistence helpers. | Wave 1 remains about one-owner primitives and utility consolidation, not broad async conversion or card data-model work. |
| After Wave 2 | `CardStoreState` read semantics, explicit `invalidate()`, lock-scoped create reload, loader/validator/errors split, `blocks` removal/normalization, final ID format, whether defensive cloning remains. | Fix Wave 5 prerequisites and CardStore decomposition text if they assume immutable records, removed `deepClone`, ULID/random IDs, old `loadCardStoreState` imports, or read-time filesystem scans. | Wave 2 preserves authoritative in-memory card reads and mutation-time consistency. Later decomposition must not reintroduce implicit reloads. |
| After Wave 3 | Web alias decisions, ws-ticket contract route, single HTTP contract auth authority, removed auth plugin/tests, actual `contracts/` files retained vs moved. | Fix Wave 4/5/6 import assumptions if they expect a real shared package, deleted `provider-candidate` contracts, old `authPlugin`, or removed contract types that were intentionally retained. | Wave 3 preserves clean ownership boundaries without adding package infrastructure or deleting legitimate cross-boundary contracts. |
| After Wave 4 | Canonical seams: `publishRuntimeDiagnostic`, `ContextCompactor`, `ToolDispatcher`, pause/resume command handlers, `InvocationService`, analyst resolver deletion, and whether `setLlmCallFn` remains. Confirm `control.ts` is still the CLI/analyst persisted-state boundary if implemented that way. | Fix Wave 5 prerequisites and Wave 6 F06/F26 text if they reference `emitRuntimeDiagnostic` + `appendRuntimeDiagnostic`, free `compactSession`, inline tool dispatch, whole-turn `AgentInvocationService`, `runtimeApi` pause/resume recursion, or `setLlmCallFn` as future work after it was already removed. | Wave 4 preserves one path per concern. Later waves may decompose unified paths but must not recreate parallel diagnostic, tool, compaction, LLM, or pause/resume routes. |
| Before Wave 5 | Reconcile Wave 5's prerequisite section against actual Waves 2 and 4. Verify `AgentAdapter`, `CardStore`, MCP, frontend stores, and websocket seams in current code. | Fix Wave 5 before implementation if it describes stale seams. Adjust module extraction targets to the landed code shape. Remove assumptions about immutable records, ULID IDs, full-turn `InvocationService`, or future setter work already completed. | Wave 5 remains decomposition of stabilized paths, not redesign of Wave 2 card semantics or Wave 4 unification. |
| Before each Wave 6 batch | Check whether earlier waves already resolved the target. Special checks: F06 uses post-Wave-4 diagnostic publisher; F26 does not duplicate Wave 4 setter removal; F16 respects Wave 3/4 file moves; F19 respects Wave 5 frontend store names; F07 stays behind runtime mutation/state persistence. | Fix the specific Wave 6 batch plan before implementing. If a target is already resolved, convert it to verification/cleanup or delete it from scope. If names changed, update imports and validation criteria rather than adding compatibility barrels. | Wave 6 remains targeted cleanup and must not reopen structural design, add compatibility shims, or invalidate one-owner architecture from Waves 1-5. |

---

## Risk Notes

- **Wave 2 is the highest behavioral-risk wave.** Card state model changes touch every read/write path. Validate thoroughly before proceeding and run the After Wave 2 gate before Wave 5B.
- **Wave 4 is the most architecturally significant wave.** Merging parallel paths is where the biggest quality gains come from and where regressions are most likely. Validate each sub-wave independently before merging the next.
- **Wave 5 should be decomposition-only.** If a Wave 5 implementation needs to change card semantics, auth semantics, or tool/LLM ownership, stop and update the earlier wave plan or metaplan first.
- **Wave 6 is not uniformly low risk.** F07 and F32 are high-risk. F15/F16 are cleanup candidates that should be deferred if earlier waves shift file ownership. F21/F27/F26 should run in that order.

## Validation Strategy Per Wave

| Wave | Primary validation | Additional |
|------|-------------------|------------|
| 1 | `npm run validate:routine`, `npm test` | Manual/focused: stale lock cases, atomic/durable write helpers, raw JSONL imports, diary error semantics, grep for duplicate helpers |
| 2 | `npm run validate:routine`, `npm test` | Manual/focused: card CRUD, status transitions, archival, position repair, no-read-I/O tests, explicit invalidate tests, sequential `card-N` concurrency checks |
| 3 | `npm run validate:routine`, `npm test`, `npm run validate:ui-smoke` | Manual: public/protected/ws-ticket auth, web alias build, no fragile relative server imports from web |
| 4 | `npm run validate:routine`, `npm test`, `npm run validate:ui-smoke` | Integration: analyst chat, planner invocation, tool execution, pause/resume, compaction, diagnostic logging |
| 5 | `npm run validate:routine`, `npm test`, `npm run validate:ui-smoke`, `npm run validate:ui` | Manual: full E2E flow through card operations, agent invocation, analyst chat, WS sync, MCP |
| 6 | `npm run validate:routine`, `npm test`, `npm run validate:ui`, `npm run validate:release` | Full validation suite, plus focused runtime state, config, credential, scanner, sync-store checks per batch |
