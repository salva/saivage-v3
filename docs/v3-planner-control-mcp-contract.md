# Planner Control MCP Contract

<!-- doc-authority
status: current
disposition: keep
owner: docs-maintainers
superseded_by: none
last_verified_against: src/agents/planner-control-executor.ts:1
-->

Planner control tools mutate planner/card state or request child runtime activation. They do not start the root project.

## Tool ownership

- `create_card`, `read_card`, `update_card`, `cancel_card`, `delete_card`, and `restart_card` operate on planner/card state through canonical services.
- `report_goal_done`, `report_goal_failed`, and `report_goal_blocked` report goal outcomes and reviewer-facing evidence.
- `activate_card` is the only child-start edge. It is accepted only from the active parent planner runtime run.

Root work is outside this contract and is controlled by runtime `start_project` / `stop_project`.

## `activate_card` request

The planner calls:

```json
{ "cardId": "child-card-id" }
```

The runtime derives parent context from the active planner session/tool call and validates that the target child exists, dependencies are complete, and the parent planner run is active. Card status alone cannot satisfy this precondition.

## Success response

A successful call returns a durable activation record and a linked child runtime run:

```json
{
  "success": true,
  "activation": {
    "activation_id": "act-...",
    "parent_card_id": "goal-a",
    "parent_run_id": "run-parent",
    "parent_tool_call_id": "call-1",
    "child_card_id": "code-a",
    "status": "pending",
    "runtime_run_id": "run-child",
    "idempotency_key": "run-parent:planner:goal-a:call-1:code-a"
  }
}
```

If the same unresolved tool call is replayed, the runtime returns the existing activation and run id rather than creating a duplicate.

## Actionable precondition errors

Failures return `tool_error` content with `actionable_error`:

- `activate_card_parent_not_active` — no running parent planner run/session owns the call. Next action: wait for the runtime to invoke the parent planner or inspect recovery state.
- `activate_card_child_missing` — target card id does not exist. Next action: inspect the Planning Tree and retry with an existing child.
- `activate_card_dependencies_blocked` — one or more dependencies are not complete. Next action: complete or resolve dependencies before retrying.

The envelope includes stable `code`, message, parent/child/session ids where known, current state, and `nextAction`.

## Non-goals and removed rituals

This contract intentionally excludes legacy start rituals: no analyst chat start tool, no project directive file wakeup, no status-derived dispatch scan, and no interactive destructive-confirmation gate for planner/card/runtime control — authz reduces to `allow` or `deny`.
