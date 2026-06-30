# Saivage v3 System Functional Specification

Status: current functional authority.

Last updated: 2026-06-29.

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

The Analyst does not perform delivery work directly. It does not replace the executor by editing project source, running builds as delivery, or deploying. It edits existing card objectives/instructions, queues notifications, changes configuration, controls runtime lifecycle, and explains what happened.

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
- planner-owned card creation, editing, reordering, cancellation, deletion, and archival where supported;
- record-backed card documents, including `brief.md`, `status.md`, and `review.md` record slots;
- Analyst-owned card management while runtime status is `stopped` or `paused` through semantic card operations and `write_file` for `record://brief.md`;
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
- broad card-field editing or raw writes into card storage outside scheme-aware record tools and semantic card operations;
- the Analyst acting as a substitute executor for delivery work.

## 5. Cards

Cards are the durable units of project work. They form a parent-child tree rooted at the project card.

A card can describe a project, a goal, or a terminal task. Goal cards are worked by planners. Terminal cards are worked by executors. Reviewers assess completed goals.

Every card has structured state and authored document records. Structured state includes identity, type, parent, order, title, lifecycle status, dependencies, retries, metrics, and other scheduler-visible fields. The current goal, instructions, and acceptance criteria live in the latest closed `record://brief.md` record for the card rather than separate long-form card fields.

Cards may also carry dependencies, history, result data, and agent-maintained working status.

`working_status` is free text for agents attached to the card to record ongoing advancement when that write path is available. It is not the accepted completion result.

`result` is the data returned by the card's main agent to its parent and attached to the card when accepted. The system must not mirror mid-run progress, rejected reports, reviewer correction requests, or failed validation attempts into `result` as if they were accepted outcomes. Specialized agents may also store their own result fields, such as `reviewer_result`, for feedback that must be visible to later planner turns.

Card storage is record-backed. The latest closed internal `card.json` record is the canonical structured card state, but `card.json` is not exposed as a functional `record://card.json` file to agents. Primary card information is read through `get_card`, which returns structured state plus associated record URLs and snippets. Authored card documents are versioned record slots: `record://brief.md` for goal/instructions/acceptance intent, `record://status.md` for planner/executor status or completion narrative, and `record://review.md` for reviewer assessment. Record metadata and version history let the UI expose current values and older versions when available.

The project card is mostly a regular goal card. Its special properties are structural and activation-related: it has no parent, and the runtime activates it directly when the user asks the Analyst to run/continue the system. It carries project-level context, global constraints, and the user's top-level objective summary.

If the user asks the Analyst to replace the project objective, the expected path is to update the existing project card's `record://brief.md` while runtime status is `stopped` or `paused` and queue notifications so the active planner chain observes the change on resume/start. Direct destructive replacement of the project card is not an Analyst capability.

Archiving is not a card status. To archive a card, the system moves its on-disk representation to a card archive directory and removes it from the runtime's active card tree.

Goal and project cards carry their own planning diary state: decomposition, assumptions, sequencing notes, reviewer feedback, and relevant correction history.

Terminal card types include `architecture`, `code`, `test`, `doc`, `data`, `research`, and `ops`. The system may support additional terminal types, but every terminal card must still use the executor activation flow.

### Card Statuses

- `backlog`: planned but not running.
- `running`: part of the active in-flight activation chain. Only the leaf does real work; running ancestors wait for their active child.
- `changed`: the card was modified after the responsible planner last observed it.
- `done`: accepted complete.
- `failed`: ended in failure.
- `blocked`: cannot proceed until a blocking condition is fixed.
- `cancelled`: cancelled work.

The durable card status records lifecycle state. `working_status` records ongoing progress text. `result` records the accepted result returned by the card's main agent.

## 6. Card Reordering And Archival

Children under a parent form an explicit ordered list. Creation appends to the end by default.

The Analyst has limited card authority on behalf of the user. All Analyst card mutations require runtime status `stopped` or `paused`. In those states, the Analyst may manage cards through semantic operations such as create card, reorder direct children where supported, cancel dormant work, and delete cards/subtrees from the active tree with archive-backed preservation. It may also update the goal/instructions/acceptance brief of an existing card by calling `write_file` on `record://brief.md?card=<id>` or an equivalent concrete `record://brief.md` URL. Analyst writes to `brief.md` create and close a new record version immediately, require the latest version to be closed, validate the writer/schema, and queue affected-card notifications for delivery when the runtime resumes or starts.

The Analyst must not directly rewrite primary card state, lifecycle/output state, `status.md`, or `review.md`. Analyst structural mutations that would invalidate a running subtree remain denied unless a later design explicitly allows them. A running card's `brief.md` may be updated while runtime status is `paused` if the latest version is closed and the new content passes validation. Cross-parent card movement, restart/reset, direct activation, and raw archive manipulation are not Analyst card operations.

A planner's card authority is local to the goal it owns. It may directly target only that goal's direct children: create them, edit them, reorder them, cancel/delete them where supported, and activate them. Some supported operations, such as cancelling or deleting a direct child, may recursively affect that child's descendants. The planner still targets only the direct child; it may not directly mutate ancestors, siblings, unrelated cards, or descendants below one of its children. Larger tree changes are Analyst-owned, but cross-parent card movement is not a supported card operation.

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

`Stopped` and `paused` are the normal intervention states. While stopped or paused, the Analyst can manage cards within its supported authority, update `record://brief.md` through `write_file`, queue notifications, change configuration, and inspect state.

### Shutdown

Shutdown is the hard lifecycle operation. It first pauses scheduling, then terminates running processes owned by the runtime. Shutdown is for stopping autonomous activity and cleaning up live process work, not for rewriting card outcomes by itself.

Shutdown should report what was paused, which processes were terminated, which could not be terminated, and what the user can do next.

The old user-facing concept "stop" is too ambiguous. The functional contract should use Pause for non-destructive interruption and Shutdown for pause-plus-process-termination.

## 8. Active Work And `activate_card`

At most one active leaf does real work at a time. The active work can still form a chain of `running` cards from the project root to the leaf; ancestors are waiting.

Planners do not directly run child planners or executors. A planner calls `activate_card(card_id)`. From the parent planner's perspective, this is a synchronous logical barrier: one tool call eventually receives exactly one activation outcome.

`activate_card` is valid only when the caller is the responsible parent planner, the requested card is an immediate child of that planner's goal, and the child is in an activatable state. Activatable statuses are `backlog`, `changed`, `blocked`, and `failed`. Activating a card in any activatable state transitions it to `running`, so reactivating a `changed` card clears the durable `changed` status by replacing it with `running`. A `done` card is not activatable; it must first be modified into `changed` or replaced by new work. Invalid activation attempts fail before dispatch and leave card status unchanged.

The runtime may persist, recover, and resume the physical work across service restarts. The parent planner still observes one outcome for the activation:

- `done`
- `failed`
- `blocked`

The main agent for every card type may report `done`, `failed`, or `blocked`. Before the parent planner receives the activation outcome, the child card first transitions to the matching card status.

The Analyst does not directly set cards to `blocked`. `blocked` is reported by a card's main agent as an activation outcome. Analyst intervention uses supported objective/instruction edits or card-addressed notifications.

Reviewer `needs_corrections` is handled inside the child activation. It is not a parent-visible activation result unless review retries are exhausted and the child activation ultimately returns `failed`.

## 9. Changed Cards

When a non-active card is modified by the Analyst, or when a direct child is modified by its parent planner, its card status must become `changed`.

If the modified card is already `running`, it remains `running`. Running status is not overwritten by `changed` because it is part of the active activation chain.

In every case, the runtime queues a notification to the modified card so that the main agent handling that card becomes aware of the change. If the card is currently active, the notification is delivered once the LLM becomes active again and reaches a point where it can accept delivered notification context. If the card is not active, the notification is delivered to the next future main agent session for that card. If that future session never starts, the notification is never delivered.

`changed` is a parent-visible durable signal. It tells the parent planner that the child or descendant changed after the planner last observed it. A planner cannot successfully report a goal `done` while any executable descendant is not in a completion-compatible state.

When an inactive descendant changes, the runtime also records changed-subtree context for the direct ancestor path up to the first running ancestor or the project root. Resting ancestors on that path become `changed`; running ancestors remain `running` and receive notification/context instead of having their status overwritten. This propagation is part of the same modification rule: direct edits change the edited card, and descendant edits also mark inactive ancestors that must re-observe the subtree.

If a goal is under review and the goal or any descendant changes before the reviewer pass commits, the reviewer pass is invalidated. The goal returns to planner ownership with correction/change context; stale reviewer approval must not mark the goal `done`.

The `changed` state does not by itself dispatch work. For activation and cancellation purposes, `changed` behaves like `backlog`: the responsible planner can reactivate the changed child or cancel it, but the runtime does not clear `changed` merely because the status exists.

## 10. Planner Completion Gates

A planner can report a goal `done`, `failed`, or `blocked`. Planner, executor, and reviewer terminal reports are accepted only through their role-specific terminal tools. Plain prose, ad-hoc JSON, or unsupported tool calls must not be treated as accepted card outcomes.

Before accepting `done`, the runtime must verify:

- every executable descendant card is in a completion-compatible state;
- required evidence references are valid;
- reviewer assessment passes after readiness and evidence gates pass.

If any executable descendant remains `changed`, `blocked`, `backlog`, `running`, `failed`, or otherwise non-compatible with successful completion, the parent cannot close the goal. Only `done` and `cancelled` descendants are completion-compatible and do not block `done`. `blocked` is unresolved rather than final: the parent planner must fix the blocking condition and reactivate the card, send a notification explaining the unblocked condition before reactivation, edit the card so it becomes `changed` under the changed-card rules in section 9, cancel the card, or report `blocked` itself so the responsibility moves upward. `failed` blocks `done` until the parent takes explicit action, such as retrying through reactivation, replacing the failed work, or marking the failed child as cancelled where supported. The runtime reports a readiness error that identifies the descendant state that must be handled.

Goal planning diary state must reflect the latest accepted planner and reviewer state before the enclosing goal can close.

If a reviewer interrupts a completion by requesting corrections, the goal returns to planner ownership with reviewer feedback in context. The parent planner remains behind the same `activate_card` barrier until that child activation ultimately reports `done`, `failed`, or `blocked`.

Notifications never block goal completion and have no acknowledgement gate.

## 11. Cancellation

Cancellation can be initiated by the Analyst or by the parent planner responsible for the target card. Cancellation is collaborative when the target is running.

If the target card is not `running`, the runtime may mark it and its cancellable descendants `cancelled` directly. Recursive cancellation changes descendants in non-completion-compatible states, including `failed` and `blocked`, to `cancelled`. Descendants that are already `done` remain `done`. If a non-running cancelled card has runtime-owned processes attached, those processes are terminated as part of the cancellation process through canonical process controls.

If the project card is cancelled, autonomous project progress becomes paused. The user decides the next project-level action through the Analyst.

If the target card is running, or if its subtree contains the active leaf, the runtime cannot simply cancel it by fiat. Instead, it queues cancellation-request notifications to the target card and every active downstream card in the activation chain below it. A planner may request this recursive cancellation only by targeting one of its direct children; the recursive effect belongs to runtime semantics, not to the planner directly controlling grandchildren.

Those notifications ask the responsible agents to voluntarily stop their work and report back failure. The expected flow is:

1. The active downstream agent receives a cancellation request.
2. It stops at the next safe point and reports `failed` through the normal activation outcome path.
3. The runtime applies `cancelled` as card status for the requested cancellation target/subtree; `cancelled` is not a parent-visible activation outcome.
4. That failure unwinds to its parent planner.
5. The parent planner handles the failed child and may itself report failure upward.
6. Eventually the failure chain reaches the planner responsible for the card originally requested for cancellation.
7. That planner handles the cancellation request in its own goal context.

This preserves agent ownership of work and keeps `activate_card` as the barrier through which outcomes flow.

Abort is not a separate required user capability. Restart/reset of planner state is not a required user capability. Obsolete work is replaced by creating new cards, cancelling old work where possible, and queueing context/correction notifications.

## 12. Notifications

Notifications are ephemeral card-addressed delivery items.

A notification is queued onto a card. The card runtime delivers it to that card's main agent session:

- the currently active card's main agent session, once the LLM becomes active again and reaches a point where it can accept delivered notification context; or
- the next future main agent session for that card, if that session is ever started.

Notifications are immutable after queueing. To correct one, queue another notification that supersedes it.

Notifications are forgotten as queue items after delivery. The platform does not expose a notification inbox, list, get, edit, delete, acknowledge, clear-all, or management UI.

The runtime records delivery markers for delivered notifications so operators can distinguish delivered context from still-pending context in runtime diagnostics. If a card settles while notifications remain pending, the runtime must not silently discard that context. A settled `done` card with pending notifications becomes `changed` so the pending context can be observed on a later activation.

If a card is deleted or archived with undelivered notifications, those notifications remain with the deleted or archived card representation and are no longer deliverable through the active runtime.

If a user phrases a notification in role terms, such as "tell the executor for goal-7," the Analyst resolves that request to the relevant card or asks one clarifying question.

Delivery can be confirmed only by inspecting the receiving agent session transcript and seeing whether the content appeared and how the agent responded.

## 13. Analyst Capabilities

The Analyst must let the user complete these tasks in natural language:

- inspect cards, runtime state, runtime events, errors, control actions, agent sessions, process registry, process logs, directory listings, file contents, configuration, credentials, and secret-bearing state when needed;
- navigate the workspace to cards, files, debug views, processes, runtime cards, and agent sessions;
- manage cards while runtime status is `stopped` or `paused` through supported semantic operations, including card creation, child reordering, dormant cancellation, and delete/archive-backed removal where allowed;
- update card goal/instructions/acceptance content while runtime status is `stopped` or `paused` by using `write_file` for `record://brief.md?card=<id>` or an equivalent concrete `record://brief.md` URL;
- queue card-addressed notifications;
- run/continue, pause, and shutdown the runtime;
- steer active or future card work by queueing notifications and objective/instruction edits;
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
- any mutating user action outside authentication/bootstrap must route through the Analyst;
- UI navigation can be driven by the Analyst so the conversational answer and visible workspace stay in sync.

Analyst-driven navigation means the Analyst can ask the webapp to show a particular card, file, debug view, process, runtime view, or agent session to illustrate the answer. The Analyst also receives enough current workspace context to answer with awareness of what the user is seeing.

## 15. Inspection And Secrets

The Analyst can see everything the authenticated operator can authorize it to inspect, including secrets.

This includes secret-bearing files, provider configuration, auth profiles, environment files, and credentials when those are relevant to the user's request. The system should avoid unnecessary secret disclosure in casual responses and UI projections, but it must not make secrets categorically invisible to the Analyst.

The UI and logs may still use redaction by default. Redaction is an output-safety and display policy, not a claim that the Analyst lacks inspection authority.

API bearer tokens must not be placed in URLs.

## 16. Process Handling

Agents may start project commands through runtime-owned process facilities. Process records expose safe read models: status, timestamps, command text, contained working directory, logs, and termination availability.

The Analyst may inspect process state and terminate a live runtime process when the canonical process control supports it. Shutdown also terminates runtime-owned running processes after pausing scheduling.

Process handling uses a launch-and-monitor model rather than unbounded synchronous shell tools. An agent may launch a project command, inspect its evolving status and logs over time, wait for completion with a bounded `wait_for_process` operation, and then decide whether to wait again, terminate the process, or continue other work. A wait timeout must not by itself kill the process.

The specification does not impose a process concurrency limit for now. Future runtime settings may add per-card, per-goal, or per-runtime limits.

## 17. Recovery

Startup recovery is conservative. If the runtime cannot prove a safe active-chain continuation, it records sanitized recovery diagnostics instead of silently resuming ambiguous work.

Recovery diagnostics are persisted under runtime state and projected through `actorRuntime.recovery` in the runtime status read model. They must not include provider payloads, auth data, prompts, raw actor context, or other secret-bearing fields.

`GET /api/runtime/status` is a live runtime projection. It requires the runtime API and does not fall back to disk snapshots or return `runtime: "unknown"`. `runtime` uses the `RuntimeStatus` vocabulary (`stopped`, `running`, `paused`, `error`). `actorRuntime.cards[].actorState` uses the public card actor vocabulary (`backlog`, `changed`, `blocked`, `failed`, `done`, `running`, `cancelled`, `needs_verification`). `actorRuntime.agents[]` exposes structured identity and phase fields: `agentId`, `role`, `cardId`, and `phase`, where `phase` is `idle`, `calling_provider`, or `waiting_for_tool`.

Known interrupted running card work may be converted into an explicit blocked card outcome when the owning card and valid transition are known. Running or killing process snapshots are abandoned with diagnostics by default; live process reattachment is not required unless a later design explicitly adds it.

If startup finds a persisted LLM waiting on a terminal tool call and the logged tool-call message contains a complete validated terminal decision, the runtime may project that terminal decision directly into the owning card outcome. This is limited to safe terminal projections, such as executor terminal outcomes, planner blocked/continue outcomes, and planner `done` outcomes only when paired with a matching persisted reviewer terminal result. Planner `done` must not be projected as completed merely because the planner emitted a done terminal tool.

Actor snapshots may include `active_reconstruction` records for active card, processor, and LLM work. Those records exist so future active recovery can be implemented from durable facts rather than in-memory queues or raw actor internals. They do not by themselves mean active provider calls or process waits are automatically resumed.

## 18. Reviewer Assessment

Reviewer assessment happens after the planner reports a goal ready for completion and after runtime readiness and evidence gates pass. For now, the reviewer receives the project card data, the goal subtree being assessed, and the return value from the planner agent. The reviewer records an assessment for that snapshot.

Reviewer approval is valid only for the card tree snapshot it assessed. The invalidation rule is defined with changed-card propagation: if the goal or any descendant changes before approval commits, the runtime detects the stale assessment through the pending change notification/context and returns the goal to planner ownership.

Reviewer results are stored locally with the assessed card. If the reviewer result is negative, it is injected back into the planner context through the response to the planner's completion-return tool call. If the reviewer result is positive, the reviewer text is attached to the card for recordkeeping but is otherwise ignored by the planner flow.

## 19. Agent Session Resumption

Planner sessions are goal-lived. A goal planner uses deterministic identity derived from the goal card, is created lazily the first time the goal needs an LLM agent, and receives multiple activation requests over that goal's lifetime as the same logical agent session. When reactivated, the planner resumes with its prior session context plus new runtime-provided activation, notification, correction, and changed-subtree context. Future implementations may unload dormant planner agents from memory and recover them from durable session/card storage; that is not a user-facing restart/reset capability.

Executor sessions are activation-lived for terminal cards. Reviewer sessions are assessment-lived. Analyst sessions are user-facing conversation sessions.

## 20. Configuration

The Analyst can reconfigure:

- model and provider routing for planner, executor, reviewer, and analyst roles;
- provider failover ordering;
- MCP server entries;
- runtime settings;
- server settings.

Configuration changes apply to subsequent relevant work without server restart unless the specific change requires a restart. Runtime components should reevaluate dynamically changeable settings at their relevant use/admission boundaries rather than requiring restart or long-lived cached configuration. If a restart is required, the Analyst must say so and ask before restarting.

## 21. Failure Modes

If the Analyst provider is unavailable, mutation is unavailable. The system must report that the Analyst is offline and must not fall back to a keyword parser or degraded non-LLM mutation mode.

If a requested action is unsupported, the Analyst explains the limitation and may suggest the closest supported path.

If a multi-step action partially succeeds, the Analyst reports which steps succeeded, which failed, and why.

If the user confirms a destructive action after context has gone stale, the Analyst must restate and reconfirm before executing.

## 22. Acceptance Criteria

The system satisfies this specification when:

- all user-visible mutations are reachable through the Analyst and not through separate workspace controls;
- Run starts stopped work, resumes paused work, and refuses duplicate root starts while already running;
- Pause behaves as a global scheduling gate and does not mutate card/session lifecycle state;
- Shutdown pauses scheduling and terminates runtime-owned running processes;
- exactly one active leaf does real work at a time;
- `activate_card` behaves as a synchronous logical barrier from the parent planner perspective;
- `activate_card` is valid for child cards in `backlog`, `changed`, `blocked`, or `failed`, and activation transitions the child to `running`;
- child activation outcomes update the child card to `done`, `failed`, or `blocked` before the parent planner receives the tool result;
- the Analyst cannot directly set a card to `blocked`; blocked status is produced by a card main-agent activation outcome;
- modifying a non-active card makes it `changed` and queues a notification to that card;
- modifying a running card keeps it `running` and queues a notification to that card;
- `changed`, `blocked`, `backlog`, `running`, and `failed` descendants block parent `done` reports until handled;
- `done` and `cancelled` descendants do not block parent `done` reports;
- inactive descendant edits propagate changed-subtree context to inactive ancestors up to the first running ancestor or project root;
- cancellation of running work is collaborative through downstream notifications and voluntary failed outcomes;
- recursive cancellation of inactive subtrees preserves already-`done` descendants;
- recursive cancellation converts `failed` and `blocked` descendants to `cancelled`;
- cancellation of a non-running card terminates attached runtime-owned processes through canonical process controls;
- card `result` reflects accepted main-agent results only, while `working_status` is a separate free field for agent usage;
- card documents are record-backed: structured card state is read through `get_card`, while `brief.md`, `status.md`, and `review.md` are versioned record slots;
- Analyst card mutations require runtime status `stopped` or `paused`, with `write_file(record://brief.md?card=<id>)` as the supported path for updating card goal/instructions/acceptance content;
- goal completion rejects any executable descendant state that is not compatible with accepted completion;
- reviewer approval is invalidated if the assessed goal or any descendant changes before approval commits;
- negative reviewer results are stored with the card and injected into planner context, while positive reviewer text is attached for recordkeeping only;
- notifications are card-addressed, ephemeral, immutable, and non-inspectable as objects;
- undelivered notifications remain with deleted or archived card representations and are no longer delivered through the active runtime;
- restart/reset of planner state is not required;
- planner sessions are goal-lived and resume as the same logical session when the same goal is reactivated;
- process execution follows launch, monitor, bounded wait, and explicit termination semantics;
- process concurrency is unlimited by the functional specification for now;
- the Analyst can inspect, diagnose, configure, repair, navigate the workspace, and mutate supported card state through canonical services, including secret inspection when needed;
- the Analyst can drive workspace navigation and receives enough UI context to reason about what the user is seeing;
- sibling reorder is supported where allowed, but cross-parent card movement is not supported;
- archiving removes a card from active runtime state by moving its on-disk representation to an archive directory rather than setting an `archived` status;
- UI details are governed by the operator UI specification and remain subordinate to the Analyst-as-control-surface model.
