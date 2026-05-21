# Goal Planning Runtime

<!-- doc-authority
status: stale
disposition: merge-into
owner: docs-maintainers
superseded_by: docs/agents.md
last_verified_against: src/utils/runtime.ts:1
-->

> **Authority status: stale.** This page is retained for context only and is not current operator guidance. Prefer `docs/agents.md` for current authority where applicable. See `docs/documentation-inventory.md` for disposition `merge-into`.

This document describes the current accepted Saivage v3 planning model after the planner-control and evidence repair waves.

## Core model

Saivage coordinates work through three runtime roles:

- **Planner** — decomposes goal work and decides whether the goal should continue, block, or move toward review.
- **Executor** — performs concrete terminal work.
- **Reviewer** — validates a goal against its acceptance criteria before goal completion.

The key current rule is:

- **planning state is owned by goals**;
- **operators should not model planning as separate visible plan cards**.

## Durable control state

Current runtime behavior persists control state under `.saivage/runtime/`, including planner-control frames and dispatch records. This allows parent planners to suspend while child work runs and then resume with durable evidence.

Current accepted semantics include:

- parent planners can suspend around child dispatches;
- child completion can make a parent planner resumable;
- dispatch completion is expected to preserve evidence rather than silently disappearing into queue churn.

## Goal-level contract

A goal is not complete merely because it has no ready child work at a moment in time. Instead:

1. the planner inspects current goal state;
2. the planner creates or updates child work;
3. child goal or terminal-card work is dispatched;
4. completion evidence is gathered;
5. the parent planner resumes if further planning is needed;
6. review gates final goal completion.

This means an empty ready queue is only an execution snapshot, not a completion proof.

## Planner outcomes

Current planner behavior still uses the familiar `continue | done | blocked` outcome pattern, but runtime semantics are stricter than the string alone.

### `continue`

The planner believes more work is required.

### `blocked`

The planner or child work has identified a blocking condition that must be surfaced.

### `done`

`done` is meaningful only when acceptance and review conditions are actually satisfied. It must not be treated as valid proof if child work still requires execution or evidence is missing.

## Review gate

Reviewer behavior remains part of the completion contract:

- a goal should not be treated as complete solely because planning stopped creating more children;
- review is the final acceptance gate for goal completion;
- failed review can send the goal back into further planning.

## Evidence expectations

Current accepted behavior requires durable evidence around child execution and goal review. Relevant evidence may include:

- generated files
- verification commands
- tool errors
- attachments and artifacts
- parse-failure context when an executor response is malformed after useful work already occurred

Operators inspect this evidence primarily through card detail rather than by reading raw runtime files.

## Relationship to project-level planning

Project-level planning remains strategic, but goal-level planning is the main current durable owner for planning state. The runtime should preserve parent control across child work rather than relying on incidental queue exhaustion.

## Operator implications

Operators should use this model when interpreting runtime state:

- do not infer completion from empty queues alone;
- inspect card detail evidence for generated work;
- inspect agent and debug views when a planner appears stuck or when evidence is incomplete;
- treat blocked, degraded, and frozen states as explicit runtime signals.

## Source grounding

This page reflects the repaired system shape established across stages 07-10, especially:

- planner-control durability and derived-state/card validation;
- evidence preservation and malformed-result handling improvements;
- generated-file inspection and safe preview behavior;
- operator-facing UI workflows for current state inspection.
