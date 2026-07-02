# Remaining Work Consolidated Plan

Status: current planning document.

Last reviewed: 2026-07-02.

This plan consolidates the still-relevant follow-up work from the record-slot, tool-surface, deferred-capability, and conversation-compaction plans. It intentionally filters out tasks that have drifted, have already been implemented, or would now conflict with the current Saivage v3 architecture.

Current authorities:

- [System Specification](../spec/system-specification.md)
- [Operator UI Specification](../spec/operator-ui.md)
- [System Architecture](./system-architecture.md)
- [Tool Set Reorganization Design](./tool-set-reorganization-design.md)
- [Shared Tool Invocation Design](./shared-tool-invocation-design.md)
- [Mandatory Output Files](./agent-invocation-output-slots.md)
- [Record-Backed Card Storage Plan](./record-backed-card-storage-plan.md)
- [Conversation Compaction Design](./conversation-compaction-design.md)

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

4. **Plan read-only Git tools as the only near-term deferred capability.**

   Add a small read-only Git provider later for `git_status`, `git_diff`, and `git_log` if the operator UI or agents need structured Git inspection beyond `run_command`.

   Constraints:

   - No branch, commit, merge, checkout, reset, or delete tools in the first slice.
   - No mutation without explicit authorization and a separate design.
   - Tool results must be structured and redacted where needed.

### Revise

Revise these original ideas before implementing anything, because the architecture or implementation has moved.

1. **Reviewer evidence gate.**

   Original idea: reviewer acceptance should validate structured `evidence_card_ids`.

   Current direction: reviewer evidence detail belongs in `review.md` prose; the terminal envelope is only `{ status, summary }`. The runtime should not parse markdown to enforce evidence IDs unless a future product need justifies structured evidence again.

   Decision: revise docs to mark `validateReviewerAssessment` and structured evidence validation as stale unless explicitly reintroduced by a new design.

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

5. **Conversation compaction.**

   Original idea: general role-wide compaction.

   Current direction: keep compaction deferred and, if implemented, start with measured Analyst-only compaction. Analyst sessions are the clearest unbounded context risk; planner/executor/reviewer activations are shorter-lived.

   Required design updates before implementation:

   - Decide whether compacted summaries are provider-visible system messages, user messages, or boundary-aware reconstruction data.
   - Update `conversationMessagesForModel()` behavior deliberately; `context_compaction` rows are schema-valid but not currently provider-visible.
   - Ensure active reconstruction snapshots and in-memory actor context are compacted consistently.
   - Define a real backend compaction state before exposing `compacting` in UI read models.

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

5. **Make `create_note` a model-facing capability.**

   The product spec rejects a user-managed notes object class and notification inbox. Durable context belongs in card records and card history; transient coordination belongs in `queue_notification`.

6. **Implement RAG or memory tools by name only.**

   Tool names without a native subsystem would mislead models and operators. Keep them out of the active surface until the subsystem exists.

### Defer

Defer these items until a concrete need or telemetry justifies them.

1. **Conversation compaction implementation.**

   Defer until token-budget diagnostics or operator reports show recurring failures. When needed, implement Analyst-only first.

2. **Dedicated record metadata tool.**

   Current `get_card` record summaries and `record://` reads cover most needs. A generic metadata tool can wait until a caller needs standalone metadata for arbitrary URLs.

3. **Structured RAG subsystem.**

   Requires strict config, embeddings/provider routing, storage lifecycle, ingestion, secret filtering, diagnostics, tests, and docs. Do not expose `rag_*` first.

4. **Durable memory subsystem.**

   Requires product semantics, lifecycle, visibility, ACLs, and compaction interactions. Current card-centered records are sufficient.

5. **Git mutation tools.**

   Read-only Git inspection may be planned soon; mutating Git tools remain deferred pending explicit operator-confirmation and dirty-worktree policy.

6. **Nullable Analyst `ProcessRecord.card_id`.**

   Current schema requires `card_id`, so Analyst processes use the session id there as non-authoritative scope metadata and mark `owner_kind: 'operator'`. Making `card_id` nullable is cleaner, but it touches API contracts and UI assumptions. Defer to a focused process-schema cleanup.

## Execution Plan

### Stage 1: Clean Current Docs And Tests

Goal: remove stale planning noise so future agents do not reimplement completed work.

Tasks:

1. Update `agent-invocation-output-slots.md` phase/status section to reflect implemented reviewer currentness and discard/relaunch behavior.
2. Update `record-backed-card-storage-plan.md` remaining-work section to remove already-landed items and move field cleanup to a separate future plan.
3. Mark structured reviewer evidence validation as superseded by `review.md` narrative evidence, unless a new design explicitly reintroduces structured evidence.
4. Add focused missing-record repair tests for planner and executor if coverage is still thin.

Validation:

- `npm run test:direct -- tests/runtime/actors/planning-card-processor-actor.test.ts tests/runtime/actors/planning-card-processor-currentness.test.ts tests/runtime/actors/terminal-card-processor-actor.test.ts --runInBand`
- `npm run validate:routine`

### Stage 2: Decide Read-Only Git Tools

Goal: determine whether structured Git inspection is useful enough now.

Tasks:

1. Design a read-only `GitProvider` with `git_status`, `git_diff`, and `git_log` only.
2. Define result schemas suitable for model use and UI rendering.
3. Decide role composition: likely executor and Analyst; planner/reviewer only if a concrete review/planning use case exists.
4. Keep all Git mutation tools out of scope.

Validation if implemented:

- Focused provider tests with temporary Git repositories.
- Role-surface tests proving mutation tools are absent.
- `npm run validate:routine`.

### Stage 3: Process Schema Cleanup Decision

Goal: decide whether to make `ProcessRecord.card_id` nullable.

Tasks:

1. Audit operator API, UI, notifications, process read models, and tests for `card_id` assumptions.
2. If nullable is worth it, update schemas and API contracts in one focused change.
3. Otherwise keep the current session-id provenance behavior documented and tested.

Validation:

- Process provider tests.
- Operator API process contract tests.
- UI smoke if process views are touched.

### Stage 4: Measured Analyst Compaction Design

Goal: keep compaction ready but avoid speculative implementation.

Tasks:

1. Add or review token-budget diagnostics for long Analyst sessions.
2. Update `conversation-compaction-design.md` with an Analyst-first trigger and provider-visible summary decision.
3. Do not implement compaction until diagnostics show recurring need or the operator explicitly prioritizes it.

Validation if later implemented:

- Conversation reconstruction tests.
- Provider request serialization tests showing compacted summaries are included exactly once.
- UI transcript tests for compaction rows.

## Non-Goals

- No compatibility shims for removed tool names.
- No global tool execution catalog revival.
- No model-facing notes object class.
- No RAG or memory tool names without native subsystems.
- No Git mutation tools in the read-only Git slice.
- No broad card schema cleanup bundled into record-slot work.

## Recommended Next Action

Start with Stage 1. It is low risk and prevents future agents from chasing stale remaining-work text. Then decide whether read-only Git inspection is useful enough to implement now.
