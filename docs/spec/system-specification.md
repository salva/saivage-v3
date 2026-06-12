# Saivage v3 System Functional Specification

Status: current functional authority.

Last updated: 2026-06-12.

## 1. Vision

Saivage is an autonomous software-development system controlled through a conversation.

It has two coupled parts:

- An autonomous runtime that owns project progress.
- An Analyst chat that is the user's way to inspect, steer, configure, and repair that runtime.

The runtime does the work. The Analyst is how the user controls the runtime. The operator UI exists to show what is happening and to host the Analyst; it is not a second control panel.

The user's mental model should be simple: tell the Analyst what you want to know or change, and the Analyst uses the system's canonical services to inspect or mutate state. If work needs to be done, the Analyst delegates it to the autonomous runtime through cards, notifications, configuration changes, or lifecycle controls.

## 2. System Layers

The runtime, the Analyst, and the worker agents are not the same kind of thing.

### Infrastructure Layer

The runtime is infrastructure. It owns scheduling, activation, persistence, process management, notification delivery, and recovery. It is the only dispatcher. It is not an agent role and should not be described as a peer of planner, executor, or reviewer.

The operator UI and HTTP/WebSocket server are also infrastructure surfaces. They expose projections, chat transport, and authenticated access to canonical services. They do not define runtime behavior.

### Control Layer

The Analyst is the user-facing control agent. It is an agent in the sense that it reasons over user requests, tool results, and system state, but functionally it is the control surface for the autonomous runtime.

The Analyst can inspect anything the authenticated user is allowed to inspect, including secrets. Secret access is not hidden from the Analyst by default. The UI may still redact or avoid displaying secrets unnecessarily, and chat responses should avoid gratuitous disclosure, but the Analyst must be able to inspect secret-bearing files or configuration when the user's requested diagnosis, configuration, or repair requires it.

The Analyst does not perform delivery work directly. It does not replace the executor by editing project source, running builds as delivery, or deploying. It creates/edits/cancels cards, queues notifications, changes configuration, controls lifecycle, and explains what happened.

### Work Agent Layer

Planner, executor, and reviewer are worker agent roles.

- A planner owns one goal subtree and decides how to decompose, activate, and report that goal.
- An executor performs one terminal card activation.
- A reviewer assesses a completed goal after runtime acceptance gates pass.

These roles are dispatched by the runtime. They do not directly invoke each other.

## 3. Core Product Scope

Saivage manages software-development work through a durable card tree.

The system must support:

- autonomous planner, executor, and reviewer work through cards;
- explicit user lifecycle control through the Analyst;
- card creation, editing, ordering, movement, cancellation, and deletion where supported;
- correction-aware goal revisiting through `changed` cards and correction context;
- card-addressed notifications for delivering short-lived instructions/context to card agents;
- process execution, process inspection, and process termination;
- model/provider routing, failover, MCP server, runtime, and server configuration;
- full system inspection by the Analyst, including secrets when needed;
- read-only UI projections of cards, agents, runtime state, files, timeline/debug data, and processes.

## 4. Non-Goals

The system does not provide:

- direct user mutation controls outside the Analyst, except authentication/bootstrap controls required to make the Analyst available;
- a second operator console, fallback keyword command parser, or programmatic user-facing mutation API that bypasses the Analyst;
- a user-managed note or notification object class;
- notification inbox, list, get, edit, delete, acknowledge, clear-all, or bulk-handle operations;
- hard scheduling guarantees from displayed child order;
- resetting/restarting planner internal state as a required user capability;
- the Analyst acting as a substitute executor for delivery work.

## 5. Cards

Cards are the durable units of project work. They form a parent-child tree rooted at the current project card.

A card can describe a project, a goal, or a terminal task. Goal cards are worked by planners. Terminal cards are worked by executors. Reviewers assess completed goals.

Every card may carry title, description, acceptance criteria, tags, dependencies, priority, urgency, history, result data, and a runtime-written `status_text` summarizing the most recent accepted terminal report.

The project card is mostly a regular goal card. Its special properties are structural and activation-related: it has no parent, and the runtime activates it directly when the user asks the Analyst to run/continue the system. It carries project-level context, global constraints, and the user's top-level objective summary.

If the user asks the Analyst to replace the project objective, the system may delete or archive the current project card and create a new parentless project card. Replacement is a deliberate destructive project-level change and should be confirmed in conversation before execution.

Goal and project cards carry their own planning diary state: decomposition, assumptions, sequencing notes, reviewer feedback, and relevant correction history.

Terminal card types include `architecture`, `code`, `test`, `doc`, `data`, `research`, and `ops`. The system may support additional terminal types, but every terminal card must still use the executor activation flow.

### Card Statuses

- `backlog`: planned but not running.
- `running`: part of the active in-flight activation chain. Only the leaf does real work; running ancestors wait for their active child.
- `changed`: the card was modified after the responsible planner last observed it.
- `done`: accepted complete.
- `failed`: ended in failure.
- `blocked`: cannot proceed without external change.
- `cancelled`: cancelled work.

`AwaitingChild` is not a card status. It is a planner/session lifecycle state for an active ancestor waiting on a child or process wait.

`status_text` is written only by the runtime from an accepted terminal report. The system must not mirror mid-run progress, rejected reports, reviewer correction requests, or failed validation attempts into `status_text` as if they were accepted outcomes.

## 6. Card Ordering And Movement

Children under a parent form an explicit ordered list. Creation appends to the end by default.

The Analyst has global card authority on behalf of the user. It may create, edit, reorder, move, cancel, delete, archive, or replace any card when the requested operation is supported and any required destructive-action confirmation has been satisfied.

A planner's card authority is local to the goal it owns. It may interact only with that goal's direct children: create them, edit them, reorder them, cancel/delete them where supported, and activate them. A planner may not mutate ancestors, siblings, unrelated cards, or descendants below one of its children. Larger tree reshaping is Analyst-owned.

Displayed child order is for presentation and comprehension. It is not a hard scheduling contract. A planner may dispatch children out of displayed order if its reasoning says that is appropriate.

## 7. Lifecycle Controls

From the user and Analyst point of view, there are three lifecycle controls:

- **Run**: start or resume autonomous progress.
- **Pause**: stop scheduling new autonomous work without killing state or processes.
- **Shutdown**: pause and then terminate running processes.

### Run

Run is the user-facing operation for both initial start and resume. If the project has never been started or has no active root run, Run starts root project execution. If the system is paused, Run resumes it. If the system is already running, Run returns an already-running warning and creates no second root run.

Implementation may keep separate internal commands such as `start_project` and `resume_runtime`, but the Analyst should present a unified user concept: "run/continue the system."

### Pause

Pause is a global scheduling gate. It stops the runtime from admitting new LLM turns. It does not mutate card statuses, active-card-run state, session lifecycle state, or process state.

Already-running shell processes may continue while the system is paused. Tool dispatch that is already in flight reaches the next safe point. Pending process results are buffered until the runtime can safely deliver them.

Pause is the normal intervention state. While paused, the Analyst can edit cards, queue notifications, change configuration, inspect state, or mark goals as needing corrections.

### Shutdown

Shutdown is the hard lifecycle operation. It first pauses scheduling, then terminates running processes owned by the runtime. Shutdown is for stopping autonomous activity and cleaning up live process work, not for rewriting card outcomes by itself.

Shutdown should report what was paused, which processes were terminated, which could not be terminated, and what the user can do next.

The old user-facing concept "stop" is too ambiguous. The functional contract should use Pause for non-destructive interruption and Shutdown for pause-plus-process-termination.

## 8. Active Work And `activate_card`

At most one active leaf does real work at a time. The active work can still form a chain of `running` cards from the project root to the leaf; ancestors are waiting.

Planners do not directly run child planners or executors. A planner calls `activate_card(card_id)`. From the parent planner's perspective, this is a synchronous logical barrier: one tool call eventually receives exactly one terminal outcome.

`activate_card` is valid only when the caller is the responsible parent planner, the requested card is an immediate child of that planner's goal, the child is in an activatable state, and no other active child is already running for that parent. Invalid activation attempts fail before dispatch and leave card status unchanged.

The runtime may persist, recover, and resume the physical work across service restarts. The parent planner still observes one outcome for the activation:

- `done`
- `failed`
- `blocked`

Reviewer `needs_corrections` is handled inside the child activation. It is not a parent-visible activation result unless review retries are exhausted and the child activation ultimately returns `failed`.

## 9. Changed Cards

When a non-active card is modified by the Analyst, or when a direct child is modified by its parent planner, its card status must become `changed`.

If the modified card is already `running`, it remains `running`. Running status is not overwritten by `changed` because it is part of the active activation chain.

In every case, the runtime queues a notification to the modified card so that the main agent handling that card becomes aware of the change. If the card is currently active and paused, the notification is delivered when the agent next accepts injected context. If the card is not active, the notification is delivered to the next future main agent session for that card.

`changed` is a parent-visible durable signal. It tells the parent planner that the child or descendant changed after the planner last observed it. A planner cannot successfully report a goal `done` while any executable descendant is not in a terminal accepted state compatible with completion.

When an inactive descendant changes, the runtime also records changed-subtree context for the direct ancestor path up to the first running ancestor or the project root. Resting ancestors on that path become `changed`; running ancestors remain `running` and receive notification/context instead of having their status overwritten.

If a goal is under review and the goal or any descendant changes before the reviewer pass commits, the reviewer pass is invalidated. The goal returns to planner ownership with correction/change context; stale reviewer approval must not mark the goal `done`.

The `changed` state does not by itself dispatch work. The responsible planner must see the changed child in context and decide whether to reactivate it.

## 10. Planner Completion Gates

A planner can report a goal `done`, `failed`, or `blocked`.

Before accepting `done`, the runtime must verify:

- every executable descendant card is in a terminal accepted state compatible with completion;
- required evidence references are valid;
- reviewer assessment passes after readiness and evidence gates pass.

If any executable descendant remains `changed`, `blocked`, `backlog`, `running`, `failed`, `cancelled`, or otherwise non-terminal for successful completion, the parent cannot close the goal. The runtime reports a readiness error that identifies the descendant state that must be handled.

Goal planning diary state must reflect the latest accepted planner and reviewer state before the enclosing goal can close.

If a reviewer interrupts a completion by requesting corrections, the goal returns to planner ownership with reviewer feedback in context. The parent planner remains behind the same `activate_card` barrier until that child activation ultimately reports `done`, `failed`, or `blocked`.

Notifications never block goal completion and have no acknowledgement gate.

## 11. Cancellation

Cancellation is collaborative when the target is running.

If the target card is not running and is safe to cancel, the runtime may mark it `cancelled` directly.

If the target card is running, or if its subtree contains the active leaf, the runtime cannot simply cancel it by fiat. Instead, it queues cancellation-request notifications to the target card and every active downstream card in the activation chain below it.

Those notifications ask the responsible agents to voluntarily stop their work and report back failure. The expected flow is:

1. The active downstream agent receives a cancellation request.
2. It stops at the next safe point and reports a failure/cancelled outcome.
3. That failure unwinds to its parent planner.
4. The parent planner handles the failed child and may itself report failure upward.
5. Eventually the failure chain reaches the planner responsible for the card originally requested for cancellation.
6. That planner handles the cancellation request in its own goal context.

This preserves agent ownership of work and keeps `activate_card` as the barrier through which outcomes flow.

Abort is not a separate required user capability. Restart/reset of planner state is not a required user capability. Obsolete work is replaced by creating new cards, cancelling old work where possible, and queueing context/correction notifications.

## 12. Notifications

Notifications are ephemeral card-addressed delivery items.

A notification is queued onto a card. The card runtime delivers it to that card's main agent session:

- the currently running but paused main agent session for that card, when it resumes or next accepts injected context; or
- the next future main agent session for that card.

Notifications are immutable after queueing. To correct one, queue another notification that supersedes it.

Notifications are forgotten as queue items after delivery. The platform does not expose a notification inbox, list, get, edit, delete, acknowledge, clear-all, or management UI.

If a user phrases a notification in role terms, such as "tell the executor for goal-7," the Analyst resolves that request to the relevant card or asks one clarifying question.

Delivery can be confirmed only by inspecting the receiving agent session transcript and seeing whether the content appeared and how the agent responded.

## 13. Analyst Capabilities

The Analyst must let the user complete these tasks in natural language:

- inspect cards, runtime state, runtime events, errors, control actions, agent sessions, process registry, process logs, directory listings, file contents, configuration, credentials, and secret-bearing state when needed;
- navigate the workspace to cards, files, debug views, processes, runtime cards, and agent sessions;
- create, edit, reorder, move, cancel, and delete cards where supported;
- queue card-addressed notifications;
- run/continue, pause, and shutdown the runtime;
- request card or subtree cancellation;
- mark goals as needing corrections;
- terminate live runtime processes through canonical process controls;
- change model/provider routing, failover, MCP entries, runtime settings, and server settings;
- diagnose failures by correlating cards, runtime events, agent sessions, process output, files, configuration, and credentials;
- apply accepted repair actions in the same conversation.

When a request is ambiguous, the Analyst asks one clarifying question rather than guessing.

For destructive or hard-to-reverse actions, the Analyst confirms in conversation before executing. Confirmation is conversational, not a modal.

## 14. UI Integration

The UI requirements are specified separately in [Operator UI specification](./operator-ui.md).

At the system level, only these UI facts are part of the core contract:

- the Analyst must be reachable from the operator UI;
- the workspace is a projection surface, not a parallel mutation surface;
- any mutating user action outside bounded authentication/bootstrap must route through the Analyst;
- UI navigation can be driven by the Analyst so the conversational answer and visible workspace stay in sync.

## 15. Inspection And Secrets

The Analyst can see everything the authenticated operator can authorize it to inspect, including secrets.

This includes secret-bearing files, provider configuration, auth profiles, environment files, and credentials when those are relevant to the user's request. The system should avoid unnecessary secret disclosure in casual responses and UI projections, but it must not make secrets categorically invisible to the Analyst.

The UI and logs may still use redaction by default. Redaction is an output-safety and display policy, not a claim that the Analyst lacks inspection authority.

API bearer tokens must not be placed in URLs.

## 16. Process Handling

Agents may start bounded project commands through runtime-owned process facilities. Process records expose safe read models: status, timestamps, command text, contained working directory, logs, and termination availability.

The Analyst may inspect process state and terminate a live runtime process when the canonical process control supports it. Shutdown also terminates runtime-owned running processes after pausing scheduling.

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
- Run starts idle work, resumes paused work, and refuses duplicate root starts while already running;
- Pause behaves as a global scheduling gate and does not mutate card/session lifecycle state;
- Shutdown pauses scheduling and terminates runtime-owned running processes;
- exactly one active leaf does real work at a time;
- `activate_card` behaves as a synchronous logical barrier from the parent planner perspective;
- modifying a non-active card makes it `changed` and queues a notification to that card;
- modifying a running card keeps it `running` and queues a notification to that card;
- `changed` descendants block parent `done` reports until handled;
- cancellation of running work is collaborative through downstream notifications and voluntary failed outcomes;
- terminal card `status_text` reflects accepted terminal reports only;
- goal completion rejects any executable descendant state that is not compatible with accepted completion;
- notifications are card-addressed, ephemeral, immutable, and non-inspectable as objects;
- restart/reset of planner state is not required;
- the Analyst can inspect, diagnose, configure, and repair through canonical services, including secret inspection when needed;
- UI details are governed by the operator UI specification and remain subordinate to the Analyst-as-control-surface model.
