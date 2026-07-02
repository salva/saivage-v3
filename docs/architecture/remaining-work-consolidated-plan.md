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

These are cleanup and simplification opportunities on the existing implementation. They are not new features.

### High Priority

1. **Remove or retire structured reviewer assessment code.**

   The active reviewer terminal contract is `emit_result` with `{ status, summary }`, and review detail belongs in `review.md`. `runtime/reviewer-assessment.ts`, reviewer assessment schemas, and related tests preserve older structured `pass` / `needs_corrections` / `evidence_card_ids` behavior.

   Work:

   - Update `src/agents/prompts/system-prompt.ts` reviewer prompt to use `done | rework | blocked | failed` and direct evidence narrative to `review.md`.
   - Remove or quarantine `validateReviewerAssessment` and `buildReviewAssessment` if no production path needs them.
   - Remove stale schema fields only after checking event/API compatibility.
   - Delete or rewrite tests that assert the obsolete structured assessment path.

2. **Delete dead `runtime/terminal-commit` abstraction if still tests-only.**

   Audit `src/runtime/terminal-commit/*`. If the module is no longer imported by production source, delete it and the tests that keep it alive. If any code path still needs it, reconnect it deliberately and document ownership.

3. **Collapse Analyst control-tool result envelopes.**

   Analyst control tools return preview/error-envelope shapes that the handler strips to the shared invocation `ToolResult`. Replace the Analyst-specific result envelope with the common result type unless a concrete UI preview path exists.

4. **Replace stale Analyst prompt/tool-list generation.**

   The Analyst prompt's static `<TOOL_LIST>` is based on control-tool definitions, while the actual surface is composed from providers. Either derive the visible tool list from the active `InvocationSurface` or make the prompt explicitly say the static list covers control tools only.

### Medium Priority

5. **Reduce duplicate role/tool policy lists.**

   Provider composition is now the authority. Remove or shrink `RoleToolPolicy` and tests where they duplicate provider surfaces. Keep only concrete Analyst surface gating that is still active.

6. **Rename or split `tool-catalog.ts`.**

   The file name implies an execution catalog, but execution authority now lives in providers and `InvocationSurface`. Move vocabulary constants and schema helpers into narrower modules such as `tool-vocabulary.ts`; move Analyst `UnifiedToolDefinition` types near the Analyst registry.

7. **Remove tests-only `ToolRuntime` and package-root barrels if unnecessary.**

   Production source now uses provider invocation. If `src/tools/runtime.ts`, `src/tools/index.ts`, `src/runtime/index.ts`, or `src/boot/index.ts` exist only to satisfy boundary tests, delete or shrink them. Keep public barrels only where the web/package boundary really uses them.

8. **Clean stale current docs/spec vocabulary.**

   Known stale references to update or mark historical:

   - `wait_for_process` in the system spec; canonical tool is `wait_process`.
   - `read_file` / `read_file_metadata` in Analyst tool-surface review docs.
   - `ToolDispatcher` in tool repair/conversation docs.
   - `ActorToolSurface` assumptions in old tool-set relationship notes.
   - Architecture index entries that omit the consolidated remaining-work plan.

9. **Harden current tests around removed names and provider surfaces.**

   Add tests that assert the actual Analyst surface excludes the full retired vocabulary and never includes `emit_result`. Add surface tests proving planner/reviewer do not get `apply_patch` through composition.

10. **Add websocket-level Analyst process cleanup test.**

   `AnalystHandler.shutdownSessionProcesses` is tested, but the websocket `close`/`error` cleanup path should also be covered so the actual socket lifecycle remains wired.

### Low Priority

11. **Process API cleanup.**

   Operator process read models still expose termination availability as unavailable even though agent-owned `kill_process` exists. Decide whether operator process API should expose termination or remove misleading control availability fields. Keep ownership scoped by `owner_id` either way.

12. **Legacy runtime-state layout cleanup.**

   If the project no longer needs legacy `.saivage/runtime/state.json` diagnostics, simplify runtime state handling to the authoritative path only. This is a cleanup candidate, not a compatibility requirement.

13. **Lessons module audit.**

   If `src/lessons/*` is not part of the Saivage runtime product and is only test-supported, move it out of `src/` or delete it with tests.

## Execution Plan

### Stage 1: Clean Current Docs, Prompts, And Tests

Goal: remove stale planning noise so future agents do not reimplement completed work.

Tasks:

1. Update `agent-invocation-output-slots.md` phase/status section to reflect implemented reviewer currentness and discard/relaunch behavior.
2. Update `record-backed-card-storage-plan.md` remaining-work section to remove already-landed items and move field cleanup to a separate future plan.
3. Mark structured reviewer evidence validation as superseded by `review.md` narrative evidence, unless a new design explicitly reintroduces structured evidence.
4. Update reviewer prompt text to match `emit_result` and `review.md` narrative evidence.
5. Add focused missing-record repair tests for planner and executor if coverage is still thin.
6. Add actual-surface tests for retired tool names, planner/reviewer `apply_patch` absence, and websocket Analyst process cleanup.

Validation:

- `npm run test:direct -- tests/runtime/actors/planning-card-processor-actor.test.ts tests/runtime/actors/planning-card-processor-currentness.test.ts tests/runtime/actors/terminal-card-processor-actor.test.ts --runInBand`
- `npm run validate:routine`

### Stage 2: Remove Dead Current-Code Abstractions

Goal: remove code that exists only because of superseded intermediate designs.

Tasks:

1. Delete or reconnect tests-only `runtime/terminal-commit` modules.
2. Remove tests-only `ToolRuntime` and unnecessary package-root barrels if no production boundary uses them.
3. Collapse Analyst-specific result envelopes into the common invocation result type.
4. Shrink or remove duplicate `RoleToolPolicy` static lists.
5. Rename or split `tool-catalog.ts` into vocabulary/schema helper modules.

Validation:

- Focused tests for any touched module.
- `npm run test:direct -- tests/agents/analyst-tool-surface.test.ts tests/tools/workspace-provider.test.ts --runInBand`
- `npm run validate:routine`.

### Stage 3: Process And Runtime-State Cleanup Decisions

Goal: remove stale defensive or misleading current-code behavior without introducing new capabilities.

Tasks:

1. Audit operator API, UI, notifications, process read models, and tests for `card_id` assumptions.
2. Decide whether to keep required `ProcessRecord.card_id` and remove stale nullable assumptions, or make it nullable in one focused schema/API change.
3. Decide whether operator process termination controls should remain unavailable or be represented differently now that agent `kill_process` exists.
4. Remove legacy runtime-state layout compatibility diagnostics only if no deployment/runtime path still needs them.

Validation:

- Process provider tests.
- Operator API process contract tests.
- UI smoke if process views are touched.

## Non-Goals

- No compatibility shims for removed tool names.
- No global tool execution catalog revival.
- No new feature work in the current cleanup backlog; see [Future Capabilities Plan](./future-capabilities-plan.md).
- No broad card schema cleanup bundled into record-slot work.

## Recommended Next Action

Start with Stage 1. It is low risk and prevents future agents from chasing stale remaining-work text. Then proceed to Stage 2 dead-code removal in small, separately validated slices.
