> **Historical/Audit Artifact — Not Current Operator Instructions**  
> This page records a pre-repair control-flow review. It is not authoritative for current Saivage v3 behavior unless a current active doc explicitly revalidates it against current source and tests.

# Top-Level Planner Control Flow Review

<!-- doc-authority
status: historical
disposition: keep
owner: docs-maintainers
superseded_by: none
last_verified_against: src/runtime/runtime.ts:1
-->

> **Authority status: historical.** This page is retained for provenance only and has no current replacement yet. See `docs/documentation-inventory.md` for disposition `keep`.

Status note: this is a working recovery note, not an authoritative specification. Existing specs, plans, and docs may be stale; source code, live runtime behavior, and the user's latest instructions take precedence until the documentation is audited and updated.

## Summary

The current Saivage v3 runtime is not yet organized around a durable strategic planner that stays in control of a project until the project is actually complete. It can create child cards, execute ready terminal cards, and then re-enter the same goal loop, but the architecture is still queue-centric rather than planner-centric.

The older Saivage v2 design had the stronger idea: the planner calls subgoal and task execution through explicit MCP-style dispatch tools. That model makes the planner an active controller that can inspect, dispatch, wait, and replan. Saivage v3 currently approximates that behavior by having the planner emit cards and the runtime execute whichever terminal cards are ready. This loses an important control boundary.

## What Happened In The Live Run

The the target project live run did show partial progress:

- The planner created `architecture-1` and `research-1`.
- Executors wrote real files and marked those cards done.
- The goal planner later created `code-1` and `code-2`.
- `code-1` completed and `code-2` started.

That means the runtime can perform at least one goal-local replan. The deeper failure is that this behavior is accidental and fragile:

- Parent control returns only through the `runGoal` loop after `executeReadyCards` returns.
- There is no explicit project-level planner dispatch cycle attached to the `project` card.
- There is no first-class MCP control tool for `dispatch_goal`, `dispatch_card`, `wait_for_dispatch`, or `inspect_artifacts`.
- Executor final-result parsing can fail even after tool writes succeed, trapping the runtime in retries and provider fallback attempts.
- The UI shows statuses but not the generated workspace files as directly inspectable evidence.

## Current Runtime Shape

In `src/runtime/runtime.ts`, `dispatchGoal` starts `runGoal(goalId)`. `runGoal` then:

1. Activates the goal.
2. Invokes the planner for that goal.
3. Applies `created_cards` and `updated_cards`.
4. Executes ready terminal cards through `executeReadyCards`.
5. Loops back to the same goal planner while `status` remains `continue`.
6. Invokes reviewer only when the planner says `done`.

This is useful but insufficient. It treats planning as a JSON-producing step inside a scheduler loop. The planner cannot explicitly call a subgoal/task execution tool, observe the tool result, and then continue reasoning in the same control conversation.

## Main Design Gap

The project card is not a live strategic control point. Project-level planning exists mostly as backlog auto-dispatch and continuous-improvement behavior after top-level goals complete. A long-running project with one active goal does not have a project planner that can inspect the whole tree, decide the only goal is incomplete, and create further goals or tasks through control tools.

The application needs a control-plane layer where planning and dispatch are explicit runtime operations. Cards should remain the durable data model, but the planner should operate through validated tools rather than only returning a static JSON diff.

## Secondary Gaps

### Structured Result Brittleness

Executors can call tools, write files, and verify output, then return final text that fails `ExecutorResult` validation. The runtime currently treats that as invocation failure and tries fallbacks. This is wasteful and can prevent the parent planner from regaining control.

### Evidence Not First-Class Enough

Generated files are not surfaced as first-class card evidence in the UI. Operators should be able to inspect files directly from the card that generated them, along with verification commands and tool output summaries.

### Fallback Configuration Leakage

The live run repeatedly tried providers that were known unavailable. For focused recovery work, the configured provider set must be authoritative: Codex-only should mean no Copilot/opencode fallback attempts.

## Recommended Direction

Use explicit planner-dispatch control as the design target for v3:

- Add an in-process planning/control MCP service in v3.
- Give planners explicit tools for state inspection, card/subgoal creation, dispatch, wait, review, and artifact inspection.
- Let parent planners suspend while child work executes and resume with structured results.
- Keep cards as durable state, but stop relying on implicit queue exhaustion as the main planning boundary.
- Add UI file evidence inspection so card completion is auditable by humans.
