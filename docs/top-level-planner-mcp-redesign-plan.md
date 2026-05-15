> **Historical/Audit Artifact — Not Current Operator Instructions**  
> This page records a redesign plan from an earlier stage. It is not authoritative for current Saivage v3 behavior unless a current active doc explicitly revalidates it against current source and tests.

# Top-Level Planner MCP Redesign Plan

Status note: this is the current recovery work plan, not an authoritative product spec. Existing specs, historical plans, and docs may be obsolete; validate every design decision against current source code, live runtime behavior, and the user's latest instructions before updating broader documentation.

## Problem Statement

The current Saivage v3 runtime can execute a short sequence of leaf cards, but the control model is still too shallow. After a planner creates terminal cards and those cards run, the system should return control to a strategic planner attached to the project or goal, inspect the current project state, decide whether the objective is complete, and then create or dispatch the next layer of work. That behavior must be an application-level invariant, not a prompt convention.

The live the target project run exposed three related issues:

1. The runtime planner loop is goal-local and card-queue driven. It can re-enter the goal planner after `executeReadyCards`, but the control boundary is implicit and depends on executor result parsing and queue exhaustion.
2. Executors can successfully modify files through tools and still fail the runtime because the final structured JSON result is brittle. That traps the system in retry/fallback churn and delays or prevents strategic replanning.
3. The UI shows card status but does not make generated files first-class evidence that an operator can inspect directly from a card.

## Architectural Direction

Restore the stronger Saivage v2 idea: planners should call explicit control-plane tools for subgoal and task execution through an MCP-style dispatch surface. The planner should not merely emit static cards and hope the runtime scheduler infers the correct next move. Instead, the runtime should expose durable operations such as:

- `plan_get_project_state`
- `plan_get_goal_state`
- `plan_create_goal`
- `plan_create_task`
- `dispatch_goal`
- `dispatch_card`
- `wait_for_dispatch`
- `inspect_artifacts`
- `request_review`

These tools should be backed by the same card store and runtime state, but they should give the planner an observable, transactional loop: inspect, create, dispatch, wait, inspect evidence, then decide whether to continue, finish, or escalate.

## Required Stages

### Stage 1: Diagnose Current Control Flow

- Trace `Runtime.dispatchGoal`, `runGoal`, `executeReadyCards`, planner result application, reviewer invocation, and continuous improvement.
- Document the exact conditions under which control returns to the goal planner.
- Identify where project-level planning is absent or only used for backlog auto-dispatch.
- Add focused tests that reproduce a goal with incomplete acceptance after initial terminal cards finish.

### Stage 2: Define Planner Control MCP Contract

- Design an in-process MCP/control service for card planning and dispatch.
- Specify tool schemas, authorization by role, state transitions, idempotency, and error semantics.
- Decide which planner levels may call which tools: project planner, goal planner, reviewer, and analyst.
- Include a project-level planning loop so the project card can own strategic expansion across goals.

### Stage 3: Refactor Runtime Around Explicit Dispatch Tools

- Replace implicit queue-only orchestration with explicit planner dispatch operations.
- Preserve crash recovery and current card-store compatibility.
- Ensure parent planners can suspend while dispatched subgoals/cards execute and then resume with structured results.
- Prevent leaf-card completion from marking a parent goal done unless reviewer evidence proves acceptance criteria.

### Stage 4: Harden Structured Result Handling

- Make executor completion robust when tools succeeded but final JSON is malformed or incomplete.
- Persist tool evidence and file write evidence as first-class execution records.
- Add a recovery parser or runtime synthesis step that can produce a failed/done executor result from verified tool outcomes without losing provenance.
- Remove noisy provider fallback attempts when configuration says no fallback is allowed.

### Stage 5: Add Generated File Inspection to the UI

- Extend card API responses with generated artifact/file references.
- Add card detail UI controls to open generated files directly.
- Support read-only file preview for workspace-relative files with redaction and path containment.
- Surface verification commands and tool evidence alongside generated files.

### Stage 6: Verification and Live Recreation

- Add unit tests for project-level planner re-entry, goal-level replanning, dispatch-tool suspend/resume, and malformed executor final result recovery.
- Add integration tests where an initial planner creates two leaf cards, both finish, and the parent planner creates the next stage because acceptance remains incomplete.
- Run typecheck, build, docs verification, focused Jest suites, and a full Jest run.
- Redeploy to the LXC service and recreate the the target project project from a clean state.
- Verify through API and UI that planners continue expanding work until the project is actually complete or explicitly blocked.

## Acceptance Criteria

- A project or goal planner can explicitly dispatch subgoals/cards through MCP-style tools and inspect completion evidence before deciding next work.
- Parent planners always regain control after dispatched work finishes, even when no ready leaf queue remains.
- A parent goal cannot be marked done solely because its current child queue is empty.
- Executor tool success and final JSON result handling are robust enough to avoid retry loops after useful work has already been completed.
- The UI lets an operator inspect generated files and evidence directly from card details.
- The live the target project recreation demonstrates multiple planner/executor/replanner cycles without manual nudging.
