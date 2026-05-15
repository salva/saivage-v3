> **Historical/Audit Artifact — Not Current Operator Instructions**  
> This page records a pre-implementation contract from an earlier stage. It is not authoritative for current Saivage v3 behavior unless a current active doc explicitly revalidates it against current source and tests.

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
  "planner_role": "planner",
  "planner_scope": "project | goal",
  "status": "running | suspended | resumable | completed | blocked | failed",
  "resume_reason": "dispatch_completed | review_completed | operator_unblocked | none",
  "waiting_on_dispatch_ids": ["dsp_..."],
  "last_resume_cursor": "opaque-string",
  "created_at": "ISO-8601",
  "updated_at": "ISO-8601"
}
```

`planner_role` is source-grounded in the current `AgentRole` model, which only has a single `planner` role in `src/schemas/types.ts`. The project-vs-goal distinction in this contract is a proposed `planner_scope` (or equivalent frame metadata) layered on top of that current role, not a claim that separate `project_planner` and `goal_planner` runtime `AgentRole` values already exist.

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
  "requested_by_scope": "project | goal",
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

## Bottom line

The required redesign is not “more card CRUD.” It is a planner-owned control plane with explicit dispatch handles, wait/observe tools, and durable parent frame resumption. Cards stay as durable state, but strategic completion must come from planner and reviewer decisions backed by structured child evidence, never from an empty ready queue or a `done` result that skipped newly created work.
