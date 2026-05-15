# V3 planner control MCP contract

## Purpose

This document defines the v3 planner control surface needed to restore durable strategic control to project and goal planners. It is grounded in the current runtime, card store, parser, schema, and MCP manager behavior, plus the completed control-flow diagnosis and stage research artifact.

## Source-grounded current problem

### Confirmed runtime gaps

Current source shows that v3 is still queue-centric instead of parent-planner-centric:

- `src/utils/runtime.ts` drives work through `dispatchGoal()`, `runGoal()`, `executeReadyCards()`, `getReadyQueue()`, and `findNextBacklogGoal()`.
- `runGoal()` applies planner JSON, then either blocks, reviews, or drains ready terminal cards.
- `getReadyQueue()` only represents terminal descendants, not planner-owned suspended child operations.
- `_checkContinuousImprovement()` only revisits `project` after all top-level goals are terminal.

This creates two concrete failures already reproduced in `tests/utils/runtime-project-planner-control-flow.test.ts`:

1. A planner can return `status: "done"` while creating child work, and `runGoal()` will skip `executeReadyCards()` and go straight to review.
2. Project-level planning is not resumed as a first-class parent frame after child goal completion.

### Constraints that must be preserved

The redesign must preserve current durable state and validation behavior:

- Cards remain the persistent planning state in `.saivage/cards/...`.
- `CardStore` in `src/utils/card-store.ts` remains the authority for hierarchy, max depth, lifecycle transitions, and edit restrictions.
- Existing `CardRecord`, `ArtifactRef`, `AttachmentRef`, `ReviewAssessment`, and runtime state types in `src/schemas/types.ts` remain the base domain model.
- Existing MCP transport/tool semantics in `src/mcp/mcp-manager.ts` remain the style for schemas, read-only hints, idempotency hints, and typed errors.

## Design goals

1. Keep cards as durable state.
2. Move strategic control from implicit planner JSON diffs to explicit MCP-style planning tools.
3. Make dispatch and wait/observe first-class, durable operations.
4. Resume the same parent planner frame with structured child results.
5. Prevent completion from empty ready queues or `done` + new work races.
6. Preserve review as explicit acceptance gating backed by observable evidence.

## Control model overview

The runtime adds a durable dispatch ledger and planner frame model on top of cards.

### New durable concepts

#### Planner frame

A planner frame represents a specific project-planner or goal-planner invocation context.

```json
{
  "frame_id": "frm_...",
  "planner_card_id": "project | goal-*",
  "planner_role": "project_planner | goal_planner",
  "status": "running | suspended | resumable | completed | blocked | failed",
  "resume_reason": "dispatch_completed | review_completed | operator_unblocked | none",
  "waiting_on_dispatch_ids": ["dsp_..."],
  "last_resume_cursor": "opaque-string",
  "created_at": "ISO-8601",
  "updated_at": "ISO-8601"
}
```

#### Dispatch record

A dispatch record is the durable handle returned when a planner dispatches child work.

```json
{
  "dispatch_id": "dsp_...",
  "parent_frame_id": "frm_...",
  "parent_card_id": "project | goal-*",
  "target_card_id": "goal-* | code-* | test-* | ...",
  "target_kind": "goal | terminal_card",
  "requested_by_role": "planner",
  "status": "queued | running | completed | failed | blocked | cancelled | timed_out",
  "completion": {
    "outcome": "done | failed | blocked | cancelled | timed_out",
    "summary": "string",
    "child_result": {},
    "review": null,
    "artifacts": [],
    "attachments": [],
    "evidence_card_ids": [],
    "error": null
  },
  "idempotency_key": "caller-key",
  "created_at": "ISO-8601",
  "started_at": "ISO-8601 | null",
  "completed_at": "ISO-8601 | null"
}
```

### Parent planner suspend/resume semantics

1. Parent planner inspects state with read tools.
2. Parent planner creates or updates child cards through explicit mutating tools.
3. Parent planner calls a dispatch tool.
4. Runtime returns `dispatch_id` and marks the parent frame `suspended` on that handle.
5. Child work runs independently.
6. When the dispatch reaches a terminal outcome, runtime marks the parent frame `resumable`.
7. The same parent planner frame is resumed with a structured dispatch completion payload, not just a rebuilt queue snapshot.
8. Parent planner chooses the next action: more planning, another dispatch, request review, or explicit blocked/completed conclusion.

This is the core behavior missing from the current queue-centric runtime.

## Tool contract

Tool names are prefixed `planner.` below for clarity; actual server naming can preserve this namespace or map it to an MCP server-specific prefix.

## Shared output envelopes

### Success envelope

```json
{
  "ok": true,
  "request_id": "optional-caller-request-id",
  "data": {}
}
```

### Error envelope

```json
{
  "ok": false,
  "error": {
    "code": "INVALID_ARGUMENTS | NOT_FOUND | FORBIDDEN | CONFLICT | INVALID_STATE | TIMEOUT | TRANSPORT_ERROR | INTERNAL_ERROR",
    "message": "human readable",
    "retryable": false,
    "details": {}
  }
}
```

## Roles and permissions

For this contract, runtime-facing permissions are:

- `project_planner`: full inspect, create/update, dispatch, wait/observe, artifact inspection, review request on project and descendant scope.
- `goal_planner`: full inspect, create/update, dispatch, wait/observe, artifact inspection, review request within its own goal subtree.
- `reviewer`: inspect state/results/artifacts and submit review outcomes only.
- `executor`: inspect assigned context and publish result/artifact evidence for assigned target only; no strategic create/dispatch.
- `operator`: global inspect plus administrative override tools outside this stage’s core contract.

Permission checks must be explicit per tool and subtree-aware.

## Inspect/state tools

### `planner.get_runtime_state`

Purpose: read runtime-level status, current frame, queue snapshots, and dispatch summary.

Permissions: `project_planner`, `goal_planner`, `reviewer`, `operator`

Idempotency: idempotent, read-only.

Input schema:

```json
{
  "type": "object",
  "properties": {
    "include_dispatches": { "type": "boolean" },
    "include_frames": { "type": "boolean" }
  }
}
```

Output schema:

```json
{
  "type": "object",
  "properties": {
    "runtime": { "type": "object" },
    "current_frame": { "type": ["object", "null"] },
    "dispatch_summary": { "type": "object" },
    "queue": { "type": "array", "items": { "type": "string" } }
  },
  "required": ["runtime", "dispatch_summary", "queue"]
}
```

Errors: `FORBIDDEN`, `TRANSPORT_ERROR`, `INTERNAL_ERROR`.

### `planner.get_card`

Purpose: fetch one card snapshot plus planning metadata.

Permissions: all roles, scope-limited for non-operators.

Idempotency: idempotent, read-only.

Input schema:

```json
{
  "type": "object",
  "required": ["card_id"],
  "properties": {
    "card_id": { "type": "string" },
    "include_children": { "type": "boolean" },
    "include_planning_state": { "type": "boolean" }
  }
}
```

Output includes normalized `CardRecord`, optional child IDs, and any frame/dispatch references attached to the card.

Errors: `NOT_FOUND`, `FORBIDDEN`.

### `planner.list_children`

Purpose: list direct children with status/type summaries.

Permissions: all roles within scope.

Idempotency: idempotent, read-only.

### `planner.list_descendants`

Purpose: inspect a whole subtree for strategic planning decisions.

Permissions: planners, reviewer, operator.

Idempotency: idempotent, read-only.

### `planner.list_dispatches`

Purpose: inspect dispatch records by parent frame, parent card, target, or status.

Permissions: planners in scope, reviewer read-only in scope, operator.

Idempotency: idempotent, read-only.

Input schema:

```json
{
  "type": "object",
  "properties": {
    "parent_card_id": { "type": "string" },
    "parent_frame_id": { "type": "string" },
    "target_card_id": { "type": "string" },
    "status": {
      "type": "string",
      "enum": ["queued", "running", "completed", "failed", "blocked", "cancelled", "timed_out"]
    }
  }
}
```

### `planner.get_dispatch`

Purpose: fetch one dispatch record including completion payload.

Permissions: planners/reviewer/operator in scope.

Idempotency: idempotent, read-only.

Errors: `NOT_FOUND`, `FORBIDDEN`.

## Planning mutation tools

These tools reuse `CardStore` validation rules for type, parent, depth, dependencies, and lifecycle constraints.

### `planner.create_goal`

Purpose: create a goal child under `project` or another goal.

Permissions: `project_planner`, `goal_planner` in scope, `operator`.

Idempotency: idempotent when `idempotency_key` or caller-supplied `card_id` repeats with the same normalized payload; otherwise `CONFLICT`.

Input schema:

```json
{
  "type": "object",
  "required": ["parent_card_id", "title", "description", "acceptance", "priority", "urgency", "idempotency_key"],
  "properties": {
    "parent_card_id": { "type": "string" },
    "card_id": { "type": "string" },
    "title": { "type": "string" },
    "description": { "type": "string" },
    "acceptance": { "type": "string" },
    "priority": { "type": "integer" },
    "urgency": { "type": "string", "enum": ["low", "normal", "high", "critical"] },
    "depends_on": { "type": "array", "items": { "type": "string" } },
    "tags": { "type": "array", "items": { "type": "string" } },
    "idempotency_key": { "type": "string" }
  }
}
```

Output: created card snapshot.

Errors: `INVALID_ARGUMENTS`, `INVALID_STATE`, `CONFLICT`, `FORBIDDEN`.

### `planner.create_task`

Purpose: create terminal or non-terminal child work under a goal, subject to current `CardStore` constraints.

Permissions: `project_planner`, `goal_planner`, `operator`.

Idempotency: same as `create_goal`.

Input schema:

```json
{
  "type": "object",
  "required": ["parent_card_id", "type", "title", "description", "acceptance", "priority", "urgency", "idempotency_key"],
  "properties": {
    "parent_card_id": { "type": "string" },
    "card_id": { "type": "string" },
    "type": {
      "type": "string",
      "enum": ["goal", "architecture", "code", "test", "doc", "data", "research", "ops"]
    },
    "title": { "type": "string" },
    "description": { "type": "string" },
    "acceptance": { "type": "string" },
    "priority": { "type": "integer" },
    "urgency": { "type": "string" },
    "depends_on": { "type": "array", "items": { "type": "string" } },
    "tags": { "type": "array", "items": { "type": "string" } },
    "idempotency_key": { "type": "string" }
  }
}
```

### `planner.update_card`

Purpose: mutate editable fields on an existing card.

Permissions: planners in scope, operator.

Idempotency: idempotent when same normalized patch repeats.

Input schema:

```json
{
  "type": "object",
  "required": ["card_id", "patch", "idempotency_key"],
  "properties": {
    "card_id": { "type": "string" },
    "patch": { "type": "object" },
    "idempotency_key": { "type": "string" }
  }
}
```

Behavior:

- Runtime delegates field and transition validation to `CardStore.update()` and `CardStore.setStatus()`.
- Structural edits forbidden in active/running/blocked states remain forbidden.
- Terminal-state edit restrictions remain in force.

Errors: `NOT_FOUND`, `INVALID_STATE`, `CONFLICT`, `FORBIDDEN`.

## Dispatch tools

These are mandatory because card CRUD alone cannot restore parent planner control.

### `planner.dispatch_goal`

Purpose: dispatch a goal child and suspend the current parent frame on its result.

Permissions: `project_planner`, `goal_planner` within scope, `operator`.

Idempotency: idempotent by `idempotency_key`; repeated identical requests return the existing dispatch record instead of creating duplicate execution.

Input schema:

```json
{
  "type": "object",
  "required": ["parent_frame_id", "goal_card_id", "idempotency_key"],
  "properties": {
    "parent_frame_id": { "type": "string" },
    "goal_card_id": { "type": "string" },
    "idempotency_key": { "type": "string" },
    "resume_mode": {
      "type": "string",
      "enum": ["when_terminal", "when_reviewed"],
      "default": "when_terminal"
    }
  }
}
```

Output schema:

```json
{
  "type": "object",
  "required": ["dispatch_id", "status", "parent_frame", "target_card_id"],
  "properties": {
    "dispatch_id": { "type": "string" },
    "status": { "type": "string", "enum": ["queued", "running"] },
    "parent_frame": { "type": "object" },
    "target_card_id": { "type": "string" }
  }
}
```

Errors:

- `NOT_FOUND` if goal missing.
- `INVALID_ARGUMENTS` if target is not a goal.
- `INVALID_STATE` if target or parent state forbids dispatch.
- `CONFLICT` if target already has an active dispatch.
- `FORBIDDEN` if caller lacks scope.

### `planner.dispatch_card`

Purpose: dispatch one terminal child card explicitly.

Permissions: planners in scope, operator.

Idempotency: same as `dispatch_goal`.

Input schema mirrors `dispatch_goal` but requires `card_id` and target must be a terminal type.

### `planner.dispatch_ready_children`

Purpose: optional convenience tool to dispatch all currently ready terminal children under a planner-owned goal in one explicit step.

Permissions: planners in scope, operator.

Idempotency: returns the same active dispatch set when retried with the same `idempotency_key` and same ready-set fingerprint.

Important rule: this is still explicit dispatch. The runtime must not treat internal queue draining as a substitute for planner-issued dispatch.

## Wait / observe tools

### `planner.wait_for_dispatch`

Purpose: suspend until a dispatched child reaches a terminal outcome, then return the structured completion payload that resumes the same planner frame.

Permissions: planners in scope, operator.

Idempotency: safe to retry. If already completed, returns completion immediately.

Input schema:

```json
{
  "type": "object",
  "required": ["dispatch_id"],
  "properties": {
    "dispatch_id": { "type": "string" },
    "timeout_ms": { "type": "integer", "minimum": 1 },
    "return_partial": { "type": "boolean", "default": false }
  }
}
```

Output schema:

```json
{
  "type": "object",
  "required": ["dispatch_id", "status", "completed"],
  "properties": {
    "dispatch_id": { "type": "string" },
    "status": {
      "type": "string",
      "enum": ["queued", "running", "completed", "failed", "blocked", "cancelled", "timed_out"]
    },
    "completed": { "type": "boolean" },
    "completion": {
      "type": ["object", "null"],
      "properties": {
        "outcome": { "type": "string" },
        "summary": { "type": "string" },
        "child_result": { "type": ["object", "null"] },
        "review": { "type": ["object", "null"] },
        "artifacts": { "type": "array" },
        "attachments": { "type": "array" },
        "evidence_card_ids": { "type": "array", "items": { "type": "string" } },
        "error": { "type": ["string", "null"] }
      }
    },
    "resume_frame": { "type": ["object", "null"] }
  }
}
```

Error behavior:

- `TIMEOUT` only when caller requested blocking wait and timeout elapsed without completion.
- Nonterminal status is not an error when `return_partial=true`.
- `NOT_FOUND`, `FORBIDDEN` remain possible.

### `planner.poll_dispatch`

Purpose: non-blocking version of `wait_for_dispatch`.

Permissions: same.

Idempotency: idempotent, read-only.

Behavior: never blocks; returns current status and completion if present.

## Artifact and result inspection tools

These expose evidence to planners and reviewers.

### `planner.get_child_results`

Purpose: fetch normalized executor/reviewer/goal completion results for a dispatch or subtree.

Permissions: planners/reviewer/operator in scope.

Idempotency: idempotent, read-only.

### `planner.list_artifacts`

Purpose: list `ArtifactRef` records by card or dispatch.

### `planner.get_artifact`

Purpose: return artifact metadata and workspace-relative path.

### `planner.list_attachments`

Purpose: list `AttachmentRef` records by card or dispatch.

### `planner.get_attachment`

Purpose: return attachment metadata and path.

Evidence rule: these tools must work even when an executor’s final JSON is malformed, as long as runtime has verified durable files or tool outputs to register as evidence.

## Review tools

### `planner.request_review`

Purpose: explicitly request reviewer assessment for a goal or project.

Permissions: planners in scope, operator.

Idempotency: one active review request per target card and evidence generation; repeated equivalent requests return existing review handle.

Input schema:

```json
{
  "type": "object",
  "required": ["target_card_id", "idempotency_key"],
  "properties": {
    "target_card_id": { "type": "string" },
    "evidence_card_ids": { "type": "array", "items": { "type": "string" } },
    "idempotency_key": { "type": "string" }
  }
}
```

Behavior:

- Reject if target has active or queued child dispatches.
- Reject if target has newly created but undispatched required child work.
- On success, create or dispatch a reviewer operation and return a review handle.

Errors: `CONFLICT`, `INVALID_STATE`, `FORBIDDEN`, `NOT_FOUND`.

### `planner.get_review`

Purpose: inspect review status and final `ReviewAssessment`.

Permissions: planners/reviewer/operator in scope.

Idempotency: idempotent, read-only.

## Reviewer submission tool

### `reviewer.submit_assessment`

Purpose: persist a structured `ReviewAssessment` for a requested target.

Permissions: `reviewer`, `operator`.

Idempotency: idempotent per review request ID.

Input/output align with `ReviewAssessment` in `src/schemas/types.ts`.

## Invariants

The runtime must enforce these invariants regardless of planner prompt behavior.

### 1. Empty ready queues do not imply parent completion

A `goal` or `project` may only complete after explicit planner conclusion plus satisfied review/acceptance conditions. `getReadyQueue()` or lack of ready terminal descendants is only an execution signal, never a strategic completion signal.

### 2. `done` cannot coexist with undispatched or unfinished child work

If a planner creates or updates child work that still requires execution, the parent frame cannot transition directly to complete/review-ready.

Allowed runtime responses:

- reject with `INVALID_STATE`, or
- normalize to `continue` plus explicit dispatch-required state.

The runtime must not repeat the current `runGoal()` bug where `done` bypasses newly created child execution.

### 3. Parent planners resume from dispatch completion, not from queue side effects

A parent frame becomes resumable only when one of its dispatch handles reaches a terminal outcome or an explicit review request completes.

### 4. Review is blocked while child dispatches are pending

A target cannot be reviewed while it has active/queued child dispatches or undispatched required work.

### 5. Project planner is first-class during active execution

The `project` card is not only a backlog bootstrap or terminal-state continuous-improvement hook. It owns a real planner frame and can dispatch, wait, resume, and replan during normal execution.

### 6. Cards remain durable state while dispatch/frame metadata layers on top

The dispatch ledger and frame state augment cards; they do not replace card persistence.

## Error behavior

The tool layer should map runtime errors into MCP-style structured failures consistent with `src/mcp/mcp-manager.ts`.

### Error codes

- `INVALID_ARGUMENTS`: schema failure, wrong target kind, missing required field.
- `NOT_FOUND`: card/frame/dispatch/review missing.
- `FORBIDDEN`: caller role or scope violation.
- `INVALID_STATE`: invalid lifecycle transition, review before evidence, dispatch of terminal/done/blocked target when forbidden.
- `CONFLICT`: duplicate create with mismatched payload, active dispatch already exists, busy frame.
- `TIMEOUT`: blocking wait expired.
- `TRANSPORT_ERROR`: underlying MCP transport failure.
- `INTERNAL_ERROR`: uncaught runtime failure.

### Retry guidance

- Read tools: always retryable after transport failure.
- Create/update/dispatch/review request: retry only with same `idempotency_key`.
- Wait/poll: always retryable.

## Idempotency semantics

### Read tools

All `get`, `list`, `poll`, and `wait` tools are idempotent. `wait` may block but never duplicates side effects.

### Create/update tools

Each mutating request must accept an `idempotency_key`. Runtime stores the normalized request and result. Replays with the same key:

- return the original result if payload matches,
- return `CONFLICT` if payload differs.

### Dispatch tools

Dispatch keys prevent double execution on planner retries. The identity is at least:

- caller frame,
- target card,
- tool kind,
- idempotency key.

### Review requests

A review request is idempotent per target + evidence generation + idempotency key.

## Migration from current planner JSON results

Current planner outputs come from `src/agents/result-parser.ts`:

```json
{
  "status": "continue | done | blocked",
  "blocked_reason": "optional",
  "created_cards": [],
  "updated_cards": [],
  "summary": "optional"
}
```

The transitional runtime may keep parsing this shape, but it must immediately normalize it into explicit tool-equivalent operations.

### Mapping table

#### `created_cards[]`

Map each item to:

- `planner.create_goal` when `type === "goal"`
- `planner.create_task` otherwise

Normalization rule: created cards are durable card mutations only. They do not imply dispatch.

#### `updated_cards[]`

Map to `planner.update_card`.

#### `status: "continue"`

Meaning in transition:

- planner is not complete,
- parent frame remains open,
- runtime expects either explicit dispatch operations in the same planner turn or a resumable frame that will plan again.

Legacy compatibility fallback:

- if legacy planner only emits create/update diffs and no dispatch tools, runtime may infer `dispatch_required=true` when there are newly ready child cards, but must not mark the parent done or review-ready.

#### `status: "blocked"` + `blocked_reason`

Map to parent frame blocked state and optionally a `planner.update_card` status transition to `blocked` when valid.

#### `status: "done"`

Valid only when all are true:

- no queued/running child dispatches,
- no newly created undispatched required work,
- review preconditions satisfied.

If legacy output violates this, runtime must reject or normalize it to non-done. It must never repeat the current behavior where `done` skips execution.

#### `summary`

Persist as planner-frame audit text and `goal.result.planning.summary`-style metadata, but do not treat it as the primary control signal.

### Transitional execution strategy

1. Parse legacy `PlannerResult`.
2. Apply `created_cards` and `updated_cards` through the same validators used by new tools.
3. Compute whether new child work now requires dispatch.
4. If legacy status is `done` while dispatchable or pending work exists, normalize to `continue` or reject.
5. Require explicit dispatch handles for any actual child execution tracked after this point.
6. Resume parents only through dispatch/review completion records.

This preserves cards as durable state while migrating control semantics away from diff-only planner outputs.

## Test plan

The next implementation stage should cover both runtime semantics and tool-surface behavior.

### Project planner resume tests

1. **Project planner dispatches top-level goal and resumes on completion**
   - project frame creates goal
   - `planner.dispatch_goal` returns `dispatch_id`
   - child goal completes
   - `planner.wait_for_dispatch` returns structured completion
   - same project frame resumes and creates or dispatches follow-up work

2. **Project planner is re-entered during normal execution, not only after all top-level goals are terminal**
   - prove mid-flight resume after a child goal terminal outcome
   - no dependence on `_checkContinuousImprovement()`

3. **Project planner false-completion prevention**
   - empty top-level ready queue but unmet acceptance
   - runtime does not mark project complete
   - project frame remains open or blocked explicitly

### Goal planner resume tests

4. **Goal planner dispatches terminal child card and resumes with executor result**
   - create terminal child
   - explicit `planner.dispatch_card`
   - wait returns `artifacts`, `attachments`, result summary, and outcome
   - parent goal frame resumes

5. **Goal review only after child evidence exists**
   - goal planner requests review after dispatch completion
   - reviewer sees evidence card IDs/artifacts
   - pass/fail loops correctly resume the same goal frame

6. **`done` with newly created child work is rejected or normalized**
   - direct regression for current `runGoal()` bug
   - created terminal card must not remain unexecuted because planner said `done`

### Dispatch/wait semantics tests

7. **Dispatch idempotency**
   - repeated `dispatch_goal` or `dispatch_card` with same key returns same `dispatch_id`
   - no duplicate execution

8. **Wait before completion returns nonterminal state**
   - `poll_dispatch` shows `queued` or `running`
   - `wait_for_dispatch` with timeout returns `TIMEOUT` or partial per flags

9. **Wait after completion returns structured child result**
   - includes outcome, summary, child result payload, evidence cards, artifacts, attachments, and timestamps

10. **Review request while child dispatch is pending is rejected**
    - returns `INVALID_STATE` or `CONFLICT`

### Card and permission enforcement tests

11. **Hierarchy and lifecycle validation stays centralized**
    - invalid child under terminal card rejected
    - invalid depth rejected
    - invalid status transitions rejected

12. **Role scope enforcement**
    - goal planner cannot dispatch sibling subtree outside scope
    - reviewer cannot create or dispatch strategic work
    - executor cannot mutate unrelated cards

### Migration tests

13. **Legacy planner JSON translation preserves card diffs**
    - `created_cards` and `updated_cards` still mutate cards correctly

14. **Legacy `done` + new work is normalized safely**
    - runtime does not review or complete until explicit dispatch/evidence exists

15. **Legacy `blocked` maps to explicit blocked state**
    - `blocked_reason` is preserved in frame/card planning metadata

### Evidence hardening test hook

16. **Malformed executor final JSON with durable evidence still resumes parent with evidence**
    - parent sees artifact/attachment evidence even if structured executor result parse failed
    - this is a forward compatibility requirement for stage-v3-004

## Implementation notes for stage-v3-003

- Add persistent stores for planner frames and dispatch records under `.saivage/runtime` or another project-local durable path.
- Keep `CardStore` as the only authority for card validation.
- Refactor `runGoal()` so planner completion is driven by frame/dispatch state rather than queue exhaustion.
- Preserve `result.planning` metadata on goal/project cards for continuity, but treat it as audit state rather than the active control contract.
- Ensure MCP tool definitions expose `readOnlyHint` and `idempotentHint` consistently with `src/mcp/mcp-manager.ts`.

## Bottom line

The required redesign is not “more card CRUD.” It is a planner-owned control plane with explicit dispatch handles, wait/observe tools, and durable parent frame resumption. Cards stay as durable state, but strategic completion must come from planner and reviewer decisions backed by structured child evidence, never from an empty ready queue or a `done` result that skipped newly created work.
