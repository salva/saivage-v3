# Saivage v3 System Functional Specification

Status: current functional authority.

Last updated: 2026-06-12.

## 1. Product Model

Saivage v3 is two coupled systems:

- An autonomous card-centered runtime that advances project work without user intervention once started.
- An Analyst chat that is the user's sole mutating control surface for inspecting, steering, configuring, and repairing the runtime.

The operator UI is a read-only workspace plus an always-visible Analyst panel. The UI may navigate, filter, refresh, expand/collapse, copy displayed values, and authenticate/bootstrap the Analyst. Any user-visible server-state mutation must be requested through the Analyst.

## 2. Core Scope

Saivage manages software-development work through a durable card tree.

The system must support:

- creating, editing, ordering, moving, cancelling, and deleting cards through the Analyst where those operations are supported;
- autonomous planner, executor, and reviewer agents working through cards;
- explicit root project start and stop;
- global pause and resume;
- card-addressed notifications for delivering short-lived context to card agents;
- correction-aware goal revisiting through `changed` cards and correction context;
- process execution and safe process inspection/termination;
- redacted inspection of runtime state, files, agent sessions, events, errors, control actions, configuration, and process output;
- model/provider routing, failover, MCP server, runtime, and server configuration through the Analyst.

## 3. Non-Goals

The system does not provide:

- direct user mutation controls outside the Analyst, except authentication/bootstrap controls required to make the Analyst available;
- a second operator console, fallback keyword command parser, or programmatic user-facing mutation API that bypasses the Analyst;
- a user-managed note or notification object class;
- notification inbox, list, get, edit, delete, acknowledge, clear-all, or bulk-handle operations;
- arbitrary cross-tree card reparenting;
- hard scheduling guarantees from displayed child order;
- resetting/restarting planner internal state as a required user capability;
- the Analyst acting as a substitute executor that writes project code, runs builds, or deploys delivery work directly.

## 4. Roles

### Runtime

The runtime owns card execution, runtime intent, runtime commands, runtime runs, activation records, process records, event logs, notification delivery, and recovery metadata. It is the only dispatcher.

### Analyst

The Analyst is the user-facing mutation surface. It can inspect system state, navigate the workspace, change cards, queue card-addressed notifications, configure the platform, and issue canonical runtime controls. It delegates delivery work to planners, executors, reviewers, and runtime services.

### Planner

A planner owns one goal subtree. It can create and edit immediate children, order children, cancel safe children, queue card-addressed notifications, activate immediate children, and report the goal outcome.

### Executor

An executor performs one terminal card activation. A re-activation of the same terminal card opens a new executor session.

### Reviewer

A reviewer assesses a completed goal after runtime acceptance gates pass. Reviewer sessions are one-shot.

## 5. Card Model

Cards form the durable project hierarchy.

Card statuses:

- `backlog`: planned but not running.
- `running`: part of the active in-flight activation chain. Only the leaf does real work; running ancestors wait for their active child.
- `changed`: externally modified since the responsible planner last observed it. This is a real durable state for parent-planner visibility.
- `done`: accepted complete.
- `failed`: ended in failure.
- `blocked`: cannot proceed without external change.
- `cancelled`: cancelled work.

`AwaitingChild` is not a card status. It is a planner/session lifecycle state for a running ancestor waiting on its active child or process wait.

Every card may carry title, description, acceptance criteria, tags, dependencies, priority, urgency, history, result data, and a runtime-written `status_text` summarizing the most recent accepted terminal report.

## 6. Card Hierarchy And Ordering

Children under a parent form an explicit ordered list. Creation appends to the end by default. The Analyst and planners may reorder children under the same parent.

Displayed child order is a presentation and comprehension convention, not a hard scheduling contract. The planner may dispatch children out of displayed order when its reasoning says that is appropriate.

Moving a card to a different parent is restricted to the parent-child axis:

- Move down into one of the card's current siblings.
- Move up to become a sibling of the card's current parent.

Moving a card under an unrelated parent is not supported.

## 7. Runtime Start, Stop, Pause, And Resume

The runtime starts idle. It does not auto-activate the project card on server boot.

Root execution starts only through explicit `start_project` runtime control requested through the Analyst. The runtime records durable intent, creates a root runtime run, and dispatches the project planner from that run.

If `start_project` is requested while root execution is already running, the runtime must not create a second root run. It returns an already-running error or warning for the Analyst to report to the user.

Root execution stops only through explicit `stop_project` runtime control. Stop records durable intent and stops autonomous progress.

Pause is a global scheduling gate. While paused, the runtime stops admitting new LLM turns. It does not change card status, active-card-run state, or session lifecycle state. Resume lifts the gate and lets the runtime continue from the next safe scheduling point.

## 8. Active Work And `activate_card`

The runtime has at most one active leaf doing real work at any time. The active work may form a chain of `running` cards from project root to leaf; ancestors are waiting.

Planners do not directly run child planners or executors. A planner asks the runtime to `activate_card(card_id)`. From the parent planner's point of view this is a synchronous logical barrier: one tool call eventually receives exactly one terminal result.

The runtime may persist and resume physical work across service restarts, but the caller sees one terminal outcome per activation:

- `done`
- `failed`
- `blocked`

Reviewer `needs_corrections` is not a parent-visible activation outcome. The runtime handles it inside the child activation by resuming the same goal planner until review retries are exhausted.

## 9. Planner Completion Gates

A planner can report a goal `done`, `failed`, or `blocked`.

Before accepting `done`, the runtime must verify:

- no descendant card remains `blocked`;
- no descendant card remains `changed`;
- required evidence references are valid;
- reviewer assessment passes after readiness and evidence gates pass.

If any descendant remains `changed`, the parent cannot close the goal. The `subtree_not_ready` error tells the planner which descendant state must be handled.

Notifications never block goal completion and have no acknowledgement gate.

## 10. Changed Cards And Corrections

The Analyst may mark a goal as needing corrections or edit card state while the runtime is paused. This records correction context and may set the affected card to `changed`.

`changed` exists so parent planners can see that a child or descendant was modified after their last observation. It does not by itself wake or dispatch runtime work. The responsible parent planner sees `subtree_changed` context and decides whether to reactivate the changed descendant.

A planner cannot successfully report `done` while a descendant remains `changed`.

## 11. Cancellation

Cancel is the required stop-work operation for cards and subtrees.

Cancellation is allowed only when the target is safe to cancel. In the current functional model, cancellation of a running active leaf or a subtree containing the active leaf may be refused. When cancellation is refused, the Analyst must explain the limitation and perform zero mutation.

Obsolete work should normally be handled by cancelling the old card when allowed and creating replacement work.

Abort and restart/reset are not separate required user capabilities.

## 12. Notifications

Notifications are ephemeral card-addressed delivery items.

A notification is queued onto a card. The card runtime delivers it to the card's main agent session:

- the currently running but paused main agent session for that card, when it resumes or next accepts injected context; or
- the next future main agent session for that card.

Notifications are immutable after queueing. To correct one, queue another notification that supersedes it.

Notifications are forgotten after delivery. The platform does not expose a notification inbox, list, get, edit, delete, acknowledge, clear-all, or management UI.

If a user phrases a notification in role terms, such as "tell the executor for goal-7," the Analyst resolves that request to the relevant card or asks one clarifying question.

Delivery can be confirmed only by inspecting the receiving agent session transcript and seeing whether the content appeared and how the agent responded.

## 13. Analyst Control Surface

The Analyst must support these user capabilities end-to-end through natural language:

- inspect cards, runtime state, runtime events, errors, control actions, agent sessions, process registry, process logs, directory listings, and non-secret file contents;
- navigate the left workspace to cards, files, debug views, processes, runtime cards, and agent sessions;
- create, edit, reorder, move, cancel, and delete cards where supported;
- queue card-addressed notifications;
- start, stop, pause, and resume the runtime;
- cancel cards or goal subtrees when cancellation is supported;
- mark goals as needing corrections;
- terminate live runtime processes;
- change model/provider routing, failover, MCP entries, runtime settings, and server settings;
- diagnose failures by correlating cards, runtime events, agent sessions, and process output;
- apply accepted repair actions in the same conversation.

When the user asks for something ambiguous, the Analyst asks one clarifying question rather than guessing.

For destructive or hard-to-reverse actions, the Analyst confirms in conversation before executing. Confirmation is conversational, not modal.

## 14. Operator UI

The operator web UI is a single screen with two always-visible regions at typical desktop widths:

- left workspace area for read-only projections of runtime state;
- right Analyst panel for chat history and composer.

The Analyst panel is not a drawer, modal, popover, slide-over, or toggled region. There is no open/close/expand/collapse control for it.

The UI may contain read-only views, filters, search, sort, expand/collapse, refresh, copy-to-clipboard, route switching, and "Discuss with analyst" affordances that stage contextual chat drafts. It must not contain controls that mutate server state outside the Analyst, except bounded authentication/bootstrap controls.

## 15. Inspection And Security

The Analyst can inspect non-secret project and runtime artifacts.

Secret-bearing paths must be blocked or redacted before content reaches the Analyst or UI. Examples include auth profiles, provider tokens, environment files, SSH keys, cloud credentials, npm/pypi credentials, and credential blobs.

Configuration inspection returns secret values absent or visibly redacted.

API bearer tokens must not be placed in URLs.

## 16. Process Handling

Agents may start bounded project commands through runtime-owned process facilities. Process records expose safe read models: status, timestamps, redacted command text, contained working directory, contained logs, and termination availability.

The Analyst may inspect process state and terminate a live runtime process when the canonical process control supports it.

## 17. Configuration

The Analyst can reconfigure:

- model and provider routing for planner, executor, reviewer, and analyst roles;
- provider failover ordering;
- MCP server entries;
- runtime settings;
- server settings.

Configuration changes apply to subsequent relevant work without server restart unless the specific change requires a restart. If a restart is required, the Analyst must say so and ask before restarting.

## 18. Failure Modes

If the Analyst provider is unavailable, mutation is unavailable. The system must report that the Analyst is offline and must not fall back to a keyword parser or degraded non-LLM mutation mode.

If a requested action is unsupported, the Analyst explains the limitation and may suggest the closest supported path.

If a multi-step action partially succeeds, the Analyst reports which steps succeeded, which failed, and why.

If the user confirms a destructive action after context has gone stale, the Analyst must restate and reconfirm before executing.

## 19. Acceptance Criteria

The system satisfies this specification when:

- all user-visible mutations are reachable through the Analyst and not through separate workspace controls;
- the runtime starts only through explicit `start_project` and refuses duplicate root starts while already running;
- pause behaves as a global scheduling gate and does not mutate card/session lifecycle state;
- exactly one active leaf does real work at a time;
- `activate_card` behaves as a synchronous logical barrier from the parent planner perspective;
- `changed` descendants block parent `done` reports until handled;
- notifications are card-addressed, ephemeral, immutable, and non-inspectable as objects;
- cancellation is the only required card/subtree stop-work operation;
- restart/reset of planner state is not required;
- the Analyst can inspect, diagnose, configure, and repair through canonical services without doing delivery work directly;
- the UI remains a read-only projection surface except authentication/bootstrap.
