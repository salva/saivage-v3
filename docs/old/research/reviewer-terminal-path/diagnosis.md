# Reviewer terminal acceptance path diagnosis

Access date: 2026-06-01  
Scope: `saivage-v3` source trace for planner-done / `report_goal_done` terminal acceptance and reviewer invocation/capacity selection. No raw live card bodies, logs, HTTP bodies, or secret values are included.

## Executive summary

The terminal acceptance path has two reviewer invocation surfaces:

1. **Planner tool path (`report_goal_done`)**: planner emits the control tool; `PlannerControlExecutor.execute()` forwards it to `PlannerToolsService.reportGoalAsync()`; that service validates the goal/subtree/evidence and, for `report_goal_done`, invokes the configured reviewer callback before accepting completion.
2. **Runtime post-planner-done path**: after `Runtime.dispatchGoal()` receives a planner contract result with `status === 'done'`, no child goal dispatch, and no unfinished child work, it independently invokes `Runtime.invokeReviewer()` before marking the goal/project done.

The current explicit blocker shape (`planning.resume_reason='reviewer_unavailable'`, `planning.failure_kind='reviewer_invocation_failed'`) is written by the **runtime post-planner-done catch block** in `src/runtime/runtime.ts`, not by `PlannerToolsService.reportGoalAsync()`. That means the likely failing source path is:

`Runtime.dispatchGoal()` → `Runtime.invokeReviewer()` → `AgentAdapter.invokeReviewer()` → `AgentAdapter.invokeAgent('reviewer', ...)` → `ModelRouter.resolve('reviewer', capabilityRequest)` / provider call + recovery.

The most likely immediate cause for `reviewer_unavailable` is one of:

- no currently healthy candidate for role `reviewer` after availability cooldown/block filtering;
- all reviewer candidates skipped for capability mismatch with the reviewer tool/terminal requirements;
- a provider/auth/rate-limit/timeout/protocol failure that exhausted recovery/failover and bubbled back to `Runtime.dispatchGoal()`;
- an existing active reviewer session assertion or stale session state preventing new reviewer session creation.

## Source trace

### A. Planner tool `report_goal_done` path

1. Planner-visible tool definition requires `goalId` and non-empty `status_text`; optional evidence and report payload are accepted. See `src/agents/agent-tool-catalog.ts` for `report_goal_done` definition.
2. `PlannerControlExecutor.execute()` handles `report_goal_done`, `report_goal_failed`, and `report_goal_blocked` by calling `plannerTools.reportGoalAsync(...)` with status text, summary, evidence card IDs, report object, and the planner session ID. Source: `src/agents/planner-control-executor.ts:164-172`.
3. `PlannerToolsService.reportGoalAsync()` delegates to `reportGoalSync()`. For `report_goal_done`, it first rejects blocked/changed descendants (`subtree_not_ready`) and validates evidence IDs are done and durable. Source: `src/tools/planner-tools.ts` around `reportGoalSync()`.
4. If a reviewer callback is configured, `reportGoalSync()` creates an assessment id/session id and calls `this.reviewer(goalId, assessmentId, reviewerSessionId, report, sessionId)` before accepting done. Source: `src/tools/planner-tools.ts:288-295`.
5. `AgentAdapter` supplies that callback while constructing `PlannerControlExecutor`; it marks the parent planner session waiting, invokes `AgentAdapter.invokeReviewer(...)`, then marks the parent active again in `finally`. Source: `src/agents/agent-adapter.ts:98-105`.
6. A reviewer pass calls `acceptReport(..., 'report_goal_done', ...)`; reviewer `needs_corrections` increments retries and may set goal status `changed` after `maxReviewRetries`. Source: `src/tools/planner-tools.ts:302-329`.

Important distinction: this path returns a `tool_error` to the planner if `reportGoalAsync()` throws inside `PlannerControlExecutor.execute()` (`src/agents/planner-control-executor.ts:177-180`). It does not appear to be the code that persists `planning.resume_reason='reviewer_unavailable'`.

### B. Runtime post-planner-done reviewer gate

`Runtime.dispatchGoal()` also has a separate acceptance gate after the planner invocation result is processed:

1. Runtime invokes planner and applies planner result. Source: `src/runtime/runtime.ts:800-850`.
2. It dispatches pending child activations, then computes unfinished child work and whether a child goal was dispatched. Source: `src/runtime/runtime.ts:852-858`.
3. If planner result is `blocked`, runtime persists a planner blocker and terminates. Source: `src/runtime/runtime.ts:859-864`.
4. If planner returns non-actionable `continue`, runtime persists a non-actionable-continue blocker. Source: `src/runtime/runtime.ts:866-890`.
5. Runtime treats the goal as terminally ready only when `plannerResult.status === 'done'`, no child goal was dispatched, and there is no unfinished child work. Source: `src/runtime/runtime.ts:892-893`.
6. It then allocates an assessment id/session id and calls `this.invokeReviewer(goalId, planCard.id, assessmentId, reviewerSessionId)`. Source: `src/runtime/runtime.ts:893-899`.
7. If reviewer invocation throws, runtime persists the exact blocker family under investigation: top-level status blocked; planning status blocked; `resume_reason: 'reviewer_unavailable'`; `failure_kind: 'reviewer_invocation_failed'`; then closes the planner run and transitions card terminated with reason `reviewer_invocation_failed`. Source: `src/runtime/runtime.ts:899-924`.
8. If reviewer passes, runtime persists review state, sets planning status done, appends child unwind result, transitions reviewer finished, emits goal completed, and for the project card emits project run completed. Source: `src/runtime/runtime.ts:935-944`.
9. If reviewer returns needs-corrections, runtime persists review failed and loops planner again. Source: `src/runtime/runtime.ts:945-950`.

This is the source path matching the live blocker metadata described by supervision-cycle-024.

### C. Reviewer invocation and candidate/capacity selection

`Runtime.invokeReviewer()` builds the reviewer prompt and sets runtime state to reviewer phase before calling the agent runtime:

- builds `createReviewerContract({ goalId, assessmentId })` and `buildReviewerPrompt(...)`;
- optionally appends reviewer skills;
- appends compacted goal context and evidence context;
- transitions runtime to `reviewer_started` with `active_card_run.phase='reviewer'`;
- calls `this.agentRuntime.invokeReviewer({ goalId, systemPrompt, contextMessages: [], assessmentId, reviewerSessionId, contract })`.

Source: `src/runtime/runtime.ts:1053-1061`.

`AgentAdapter.invokeReviewer()` forwards to `invokeAgent('reviewer', goalId, goalId, ..., requestedSessionId)`. Source: `src/agents/agent-adapter.ts:187-196`.

`AgentAdapter.invokeAgent()` does candidate/capacity selection as follows:

1. Requires an LLM call function registered; otherwise throws `No LLM call function registered...`.
2. Builds role model params, role tools, and capability request from tools/stream=false.
3. Calls `this.router.resolve(role, capabilityRequest)`. If no candidates, throws a no-candidate recovery-policy message. Source: `src/agents/agent-adapter.ts:292-298`.
4. Asserts no active agent session for the same role, then creates the requested reviewer session. Source: `src/agents/agent-adapter.ts` around the start of `invokeAgent()`.
5. For each resolved candidate, skips if `candidateAvailability.isAvailable(candidate)` is false, then tries an LLM turn with the reviewer contract terminal (`emit_reviewer_result`) and reviewer tools. Source: `src/agents/agent-adapter.ts:301-330`.
6. Failures are classified by `defaultInvocationRecoveryPolicy`; rate limits/auth/timeouts/transient/protocol errors can mark candidates failed/cooling/blocked and then fail over or abort. The final failed invocation is completed as failed and thrown to runtime. Source: `src/agents/agent-adapter.ts` failure handling after the tool loop.

`ModelRouter.resolve()` is network-free and role-config driven. It uses `getModelListForRole(config, role)`, provider candidates for each model, capability compatibility, and `CandidateAvailability.isAvailable()`. It records only capability skip diagnostics; unavailability/cooldown skips do not produce the same diagnostic list. Source: `src/agents/model-router.ts:55-124`.

`InvocationRecoveryPolicy.decideNoCandidates()` emits either:

- `No capability-compatible candidates available for role 'reviewer'. Skipped reasons: ...`, when capability skips exist; or
- `No healthy candidates available for role 'reviewer'.`, when candidates are absent or filtered unavailable.

Source: `src/agents/invocation-recovery-policy.ts:154-177`.

## Likely causes for reviewer_unavailable / reviewer_invocation_failed

Ranked by fit to the observed blocker family:

| Rank | Cause | Why it fits | How to confirm without secrets |
|---:|---|---|---|
| 1 | All reviewer role candidates unavailable due to cooldown/block after recent provider failures | `ModelRouter.resolve()` filters candidates via `CandidateAvailability.isAvailable()`; no candidates throws `No healthy candidates available for role 'reviewer'.` which the runtime catch persists as `reviewer_unavailable` | Inspect redacted event categories: recent `llm_attempt` for role reviewer with failure class (rate_limit/auth/timeout/protocol/unknown) and cooldown metadata, plus `llm_invocation_summary` verdict exhausted/cancelled. Do not copy provider payloads or tokens. |
| 2 | Reviewer model/provider capability mismatch | Reviewer requires read-only tools plus contract terminal; candidates not supporting requested tool capabilities are skipped and no candidates throws capability-compatible message | Inspect `llm_attempt`/summary capability skip reason names only, or router diagnostic output without config values. |
| 3 | Provider/auth configuration issue specific to reviewer model list | Planner/executor can be healthy while reviewer points to a model/provider/account with missing/expired auth or unsupported model | Inspect config schema shape/key presence and model role names only; inspect redacted failure class `auth_permanent`/provider status, not auth values. |
| 4 | Existing active reviewer session / stale session lock | `invokeAgent()` asserts no active session for role before creating a session; stale active session can throw before candidate attempts | Inspect session metadata counts/statuses and active role/session IDs only; do not include message contents. |
| 5 | Reviewer prompt/context still exceeds provider budget | Runtime reviewer prompt appends goal context and evidence context; previous repair compacted planner context, but reviewer path still uses both context blocks | Look for reviewer `llm_attempt` failure class `token_budget_exceeded` or provider status code only. If present, add focused compaction for reviewer prompt/evidence. |
| 6 | Stale blocked planning guard prevents redispatch after a transient reviewer-capacity blocker expires | Prior stage intentionally prevents redispatch of persisted `planning.status='blocked'`; if reviewer capacity was transient, runtime may not retry automatically without an explicit unblock/clear path | Inspect top-level/project planning status and scheduler active run metadata only. If no retry occurs after cooldown, Coder should add a precise unblock/retry policy for transient reviewer blockers or an operator-visible durable blocker. |

## Potential source-level concerns for the Coder task

1. **Duplicate reviewer gates**: `report_goal_done` can invoke the reviewer through `PlannerToolsService`, while `Runtime.dispatchGoal()` also invokes a reviewer when planner result status is done. The current live blocker matches the runtime gate, but tests should clarify intended ownership: either planner tool terminal reports are the source of terminal done, or planner contract `status='done'` is. Avoid double-reviewing or inconsistent persistence.
2. **No-candidate diagnostics are too coarse at persistence point**: runtime writes the full thrown message into blocked reason. That is useful but may not distinguish cooldown, capability mismatch, auth, active-session lock, or provider failure in structured metadata. A minimal fix could persist non-secret structured reason fields (e.g., `reviewer_failure_class`, `candidate_skip_category`, cooldown horizon if already redacted) while preserving redaction rules.
3. **Transient reviewer capacity plus blocked-planning redispatch guard**: once `reviewer_unavailable` is persisted as planning blocked, the recent guard may correctly stop automatic loops but also prevent retry after cooldown. The system needs an explicit policy: durable precise blocker requiring operator/capacity repair, or safe scheduled retry when the block is known transient.
4. **Reviewer context not separately compacted**: `Runtime.invokeReviewer()` appends both `buildGoalContextBlock()` and `buildGoalEvidenceContext()`. If live reviewer attempts show token-budget failure, the next fix should compact reviewer prompt context similarly to planner context.

## Recommended next checks for live data agent / coder

Metadata-only checks, no raw payload copying:

- Project card: top-level status, planning status, planning resume_reason/failure_kind names, status_text category only.
- Runtime events tail: event kind counts and for reviewer-role `llm_attempt`/`llm_invocation_summary`, capture role, verdict, failure_class, recovery_action, cooldown_ms bucket, capability skip reason names, final terminal tool name if succeeded. Do not copy provider response bodies or secret-shaped values.
- Session metadata: active sessions by role/status/id prefix and whether any active reviewer session exists.
- Candidate/config shape: reviewer role model list count/names and provider candidate count/status categories only; do not include keys/tokens/provider config values.
- Review directory: count/mtime only unless reading assessment metadata is necessary; avoid copying assessment content.

## Bottom line

The explicit terminal acceptance blocker is most likely not caused by HTTP/service health or lesson product state. It is produced by `Runtime.dispatchGoal()` after planner declares the project done and the runtime reviewer gate cannot obtain a reviewer assessment. The Coder should focus on `src/runtime/runtime.ts` reviewer catch/persistence and `src/agents/agent-adapter.ts` / `src/agents/model-router.ts` reviewer candidate selection, then either repair a concrete bug (e.g., stale session/capability/context/retry policy) or persist a more precise non-secret reviewer-capacity blocker.
