# Saivage v3 System Functional Specification

Status: current functional authority.

Last updated: 2026-07-07.

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

Most operator HTTP routes are backed by explicit API contracts. All `/api/debug/*` routes (currently `POST /api/debug/runtime/start`, `GET /api/debug/doctor`, `GET /api/debug/supervision`, `GET /api/debug/state`, `GET /api/debug/errors`, and `GET /api/debug/timeline`) are an intentional exception: they are authenticated internal diagnostics that expose local repair and inspection surfaces for the bundled operator UI, are not stable operator API contracts, and may change with storage/recovery internals. They are documented in the internal-debug inventory rather than the operator-route inventory by design.

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
- Analyst-owned card management while runtime status is `stopped` or `paused` through semantic card operations and `write` for `record:///brief.md`;
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

Every card has structured state and authored document records. Structured state includes identity, type, parent, order, title, lifecycle status, dependencies, retries, metrics, and other scheduler-visible fields. The current goal, instructions, and acceptance criteria live in the latest closed `record:///brief.md` record for the card rather than separate long-form card fields.

Cards may also carry dependencies, history, result data, and agent-maintained working status.

`working_status` is free text for agents attached to the card to record ongoing advancement when that write path is available. It is not the accepted completion result.

`result` is the data returned by the card's main agent to its parent and attached to the card when accepted. The system must not mirror mid-run progress, rejected reports, reviewer correction requests, or failed validation attempts into `result` as if they were accepted outcomes. Specialized agents may also store their own result fields, such as `reviewer_result`, for feedback that must be visible to later planner turns.

Card storage is record-backed. The latest closed internal `card.json` record is the canonical structured card state, but `card.json` is not exposed as a functional `record:///card.json` file to agents. Primary card information is read through `get_card`, which returns structured state plus associated record URLs and snippets. Authored card documents are versioned record slots: `record:///brief.md` for goal/instructions/acceptance intent, `record:///status.md` for planner/executor status or completion narrative, and `record:///review.md` for reviewer assessment. Record metadata and version history let the UI expose current values and older versions when available. Scoped path URLs use the canonical triple-slash `<scheme>:///` form and are parsed/emitted by a shared string-based helper; old two-slash forms are invalid. Record document operations use `record:///<filename>?card=<id>&v=<n>` URLs, while record discovery uses `glob record:///<cardId>` and `read record:///<cardId>` to return the logical exposed-record set rather than raw version files.

The project card is mostly a regular goal card. Its special properties are structural and activation-related: it has no parent, and the runtime activates it directly when the user asks the Analyst to run/continue the system. It carries project-level context, global constraints, and the user's top-level objective summary.

If the user asks the Analyst to replace the project objective, the expected path is to update the existing project card's `record:///brief.md` while runtime status is `stopped` or `paused` and queue notifications so the active planner chain observes the change on resume/start. Direct destructive replacement of the project card is not an Analyst capability.

Archiving is not a card status. To archive a card, the system moves its on-disk representation to a card archive directory and removes it from the runtime's active card tree.

Goal and project cards carry their own planning state: decomposition, assumptions, sequencing notes, reviewer feedback, and relevant correction history, held in card records and card state.

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

The Analyst has limited card authority on behalf of the user. All Analyst card mutations require runtime status `stopped` or `paused`. In those states, the Analyst may manage cards through semantic operations such as create card, reorder direct children where supported, cancel dormant work, and delete cards/subtrees from the active tree with archive-backed preservation. It may also update the goal/instructions/acceptance brief of an existing non-terminal card by calling `write` on `record:///brief.md?card=<id>` or an equivalent concrete `record:///brief.md` URL. Terminal `cancelled` cards cannot be edited; replacement work requires creating a new card. Analyst writes to `brief.md` create and close a new record version immediately, require the latest version to be closed, validate the writer/schema, and queue affected-card notifications for delivery when the runtime resumes or starts.

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

Pause is a global provider-admission gate. It stops the runtime from starting new LLM/provider calls. Pause itself does not mutate card statuses, active-card-run state, session lifecycle state, or process state.

Already-running provider calls and shell processes may continue while the system is paused. Already-received provider responses continue to drain: their tool calls may execute, cards may transition to `running`, and runtime-owned processes may spawn until in-flight responses drain and the next provider call parks at the gate. Completion facts produced by already-admitted work may be persisted and settled while paused.

Resume reopens the gate. Work already blocked at provider calls proceeds exactly once in normal runtime ordering. Resume must not require a manual second Run for work that was already waiting behind the pause gate.

The single global `RuntimeGate` implements this behavior at `LLMActor` provider-call admission: provider calls await the gate before starting, so pause waits rather than failing the turn.

`Stopped` and `paused` are the normal intervention states. While stopped or paused, the Analyst can manage cards within its supported authority, update `record:///brief.md` through `write`, queue notifications, change configuration, and inspect state.

### Shutdown

Shutdown is the hard lifecycle operation. It first pauses scheduling, then terminates running processes owned by the runtime. Shutdown is for stopping autonomous activity and cleaning up live process work, not for rewriting card outcomes by itself.

Shutdown should report what was paused, which processes were terminated, which could not be terminated, and what the user can do next.

The old user-facing concept "stop" is too ambiguous. The functional contract should use Pause for non-destructive interruption and Shutdown for pause-plus-process-termination.

## 8. Active Work And `activate_card`

At most one active leaf does real work at a time. The active work can still form a chain of `running` cards from the project root to the leaf; ancestors are waiting.

Planners do not directly run child planners or executors. A planner calls `activate_card(card_id)`. From the parent planner's perspective, this is a synchronous logical barrier: one tool call eventually receives exactly one activation outcome. Main-agent outcomes are `done`, `failed`, or `blocked`; runtime cancellation may instead produce parent-visible `cancelled`.

`activate_card` is valid only when the caller is the responsible parent planner, the requested card is an immediate child of that planner's goal, and the child is in an activatable state. Activatable statuses are `backlog`, `changed`, and `blocked`. Activating a card in any activatable state transitions it to `running`, so reactivating a `changed` card clears the durable `changed` status by replacing it with `running`. A `done` card is not activatable; it must first be modified into `changed` or replaced by new work. A `failed` card is not activatable; the parent must cancel it, replace it, edit it into `changed`, or escalate/report failure. Invalid activations fail before dispatch and leave card status unchanged.

The runtime persists durable activation facts and `active_reconstruction` records across service restarts. On startup recovery, runtime-owned OS processes are reconciled first: runtime/agent-owned records are killed or marked lost (terminal, retained for inspection), operator-owned records still alive are matched and remain `running` (not terminal), and operator-owned records missing/skewed are marked lost (terminal, retained). The root card record is then validated; if the project card record is missing, unreadable, or fails the card schema, startup throws and the operator must repair the record before retrying. Running card actors are constructed without starting their processors. The runtime (`SupervisorRuntimeApi`, the runtime/composition root) calls `recoverCurrentCardState()` on the root card only; the root's activation cascades through `activate_card`, where a running child is recovered and awaited. Processors start lazily when the cascade reaches their card, LLM actors recover lazily inside `processor.recoverActive`, in-flight provider calls are reissued from persisted `calling_provider` state, and waiting tool calls are resolved inline through `resolveInitialOutcome` and each tool's replay entrypoint. Safe terminal decisions may still be projected from complete durable terminal records. A replayed process-tool wait resolves to an interrupted outcome the owning agent re-issues after inspecting current state. A `blocked` card status may still arise from safe terminal projection when the persisted planner terminal is itself `blocked`. The parent planner observes one outcome for the activation:

- `done`
- `failed`
- `blocked`
- `cancelled` (runtime-produced only; never emitted by a main agent)

The main agent for every card type may report `done`, `failed`, or `blocked`. Before the parent planner receives a main-agent activation outcome, the child card first transitions to the matching card status. Runtime-produced `cancelled` is not emitted by a main agent.

The Analyst does not directly set cards to `blocked`. `blocked` is reported by a card's main agent as an activation outcome. Analyst intervention uses supported objective/instruction edits or card-addressed notifications.

Reviewer `rework` is handled inside the child activation. It is not a parent-visible activation result unless review retries are exhausted and the child activation ultimately returns `failed`.

## 9. Changed Cards

When a non-active card is modified by the Analyst, or when a direct child is modified by its parent planner, its card status must become `changed`. Terminal `cancelled` cards are excluded: they cannot be edited or reactivated. To replace cancelled work, create a new card.

If the modified card is already `running`, it remains `running`. Running status is not overwritten by `changed` because it is part of the active activation chain.

In every case, the runtime queues a notification to the modified card so that the main agent handling that card becomes aware of the change. If the card is currently active, the notification is delivered once the LLM becomes active again and reaches a point where it can accept delivered notification context. If the card is not active, the notification is delivered to the next future main agent session for that card. If that future session never starts, the notification is never delivered.

`changed` is a parent-visible durable signal. It tells the parent planner that the child or descendant changed after the planner last observed it. A planner cannot successfully report a goal `done` while any executable descendant is not in a completion-compatible state.

When an inactive descendant changes, the runtime also records changed-subtree context for the direct ancestor path up to the first running ancestor or the project root. Resting ancestors on that path become `changed`; running ancestors remain `running` and receive notification/context instead of having their status overwritten. This propagation is part of the same modification rule: direct edits change the edited card, and descendant edits also mark inactive ancestors that must re-observe the subtree.

If a goal is under review and the goal or any descendant changes before the reviewer pass commits, the reviewer pass is invalidated. The goal returns to planner ownership with correction/change context; stale reviewer approval must not mark the goal `done`.

The `changed` state does not by itself dispatch work. For activation and cancellation purposes, `changed` behaves like `backlog`: the responsible planner can reactivate the changed child or cancel it, but the runtime does not clear `changed` merely because the status exists.

## 10. Planner Completion Gates

A planner can report a goal `done`, `failed`, or `blocked`. Planner, executor, and reviewer terminal reports are accepted only through the unified `emit_result` terminal tool, with each role's contract validating the statuses that role may emit. Plain prose, ad-hoc JSON, or unsupported tool calls must not be treated as accepted card outcomes.

Terminal `emit_result` validation validates only the terminal call, required records, completion gates, and reviewer rework. It must not inspect or gate on pending main-agent notifications after the model has emitted `emit_result`. If a terminal report is invalid, the failed `emit_result` tool result carries the terminal repair guidance: invalid arguments ask the model to call `emit_result` again with valid JSON; missing `status.md` or `review.md` asks it to create the required record and call `emit_result` again; completion-gate failures report the descendant/evidence condition that blocks `done`; reviewer rework reports the reviewer guidance. Pending notifications are not terminal validation errors and must not be combined into those repair messages.

Before accepting `done`, the runtime must verify:

- every executable descendant card is in a completion-compatible state;
- required evidence references are valid;
- reviewer assessment passes after readiness and evidence gates pass.

If any executable descendant remains `changed`, `blocked`, `backlog`, `running`, `failed`, or otherwise non-compatible with successful completion, the parent cannot close the goal. Only `done` and `cancelled` descendants are completion-compatible and do not block `done`. `blocked` is unresolved rather than final: the parent planner must fix the blocking condition and reactivate the card, send a notification explaining the unblocked condition before reactivation, edit the card so it becomes `changed` under the changed-card rules in section 9, cancel the card, or report `blocked` itself so the responsibility moves upward. `failed` blocks `done` until the parent takes explicit action, such as replacing the failed work, editing the card into `changed`, cancelling the failed child where supported, or reporting/escalating failure upward. The runtime reports a readiness error that identifies the descendant state that must be handled.

Goal planning state must reflect the latest accepted planner and reviewer state before the enclosing goal can close.

If a reviewer interrupts a completion by requesting corrections, the goal returns to planner ownership with reviewer feedback in context. The parent planner remains behind the same `activate_card` barrier until that child activation ultimately reports `done`, `failed`, or `blocked`, or until runtime cancellation resolves it as `cancelled`. The planner rework continuation is a failed planner `emit_result` repair turn: the failed tool result contains reviewer guidance only, while any queued notifications for that next planner turn are delivered as separate provider-input context rows.

Notifications have no acknowledgement gate. A valid terminal report is not deferred merely because main-agent notifications are pending after the report was emitted. Notifications are delivered only at safe pre-provider-call points: initial planner/executor turns, continuations after non-terminal tool results, continuations after failed terminal `emit_result` repair tool results, and continuations after plain-text repair directives. If terminal validation succeeds and no further provider call is made, notifications that arrived after the last safe point remain queued for future delivery and do not block completion.

## 11. Cancellation

Cancellation can be initiated by the Analyst or by the parent planner responsible for the target card. Cancellation is authoritative for inactive and running cards; it is not committed through a downstream notification/voluntary-failure protocol.

If the target card is not `running`, the runtime may mark it and its cancellable descendants `cancelled` directly. Recursive cancellation changes descendants in non-completion-compatible states, including `failed` and `blocked`, to `cancelled`. Descendants that are already `done` remain `done`. If a non-running cancelled card has runtime-owned processes attached, those processes are terminated as part of the cancellation process through canonical process controls.

If the project card is cancelled, autonomous project progress becomes paused. The user decides the next project-level action through the Analyst.

If the target card is running, or if its subtree contains the active leaf, `CardActor.cancel()` cancels the current activation authoritatively (see [Implementation Plan P3](../architecture/micro-actor-runtime-implementation-plan.md#p3-cardactor-owns-authoritative-cancellation-and-activation-id-settlement)). The runtime writes `cancelled` to the card store immediately, resolves the pending activation as `{ status: "cancelled" }`, clears active reconstruction data, stops activation-owned runtime process scope, and drops late provider/process/tool outcomes through the CardActor cancellation flag. Running children are cancelled through their own `CardActor.cancel()` so each live actor cancels its own current activation; inactive descendants are converted to `cancelled` through canonical card-store writes. A planner may request recursive cancellation only by targeting one of its direct children; the recursive effect belongs to runtime semantics, not to the planner directly controlling grandchildren.

`cancelled` is the parent-visible activation outcome for running cancellation. Notifications may still be used as ordinary context for non-cancellation changes, but cancellation correctness must not depend on agent cooperation, provider abort support, or a later `failed` report.

Abort is not a separate required user capability. Restart/reset of planner state is not a required user capability. Obsolete work is replaced by creating new cards, cancelling old work where possible, and queueing context/correction notifications.

## 12. Notifications

Notifications are the primary context-delivery and steering mechanism. They let the runtime, the operator (through the Analyst), and edit propagation inform agents about situations the runtime does not encode as lifecycle state. Because notifications can target a card in any lifecycle state, agents can decide what to do — edit a card, re-activate it, create replacement work, or report an outcome — without the runtime needing a dedicated state for every scenario. The `changed` state is exclusively a durable edit/subtree-mutation signal for completion gates and activation decisions; it is not a delivery mechanism.

Notifications are ephemeral card-addressed delivery items.

A notification is queued onto a card. The card runtime delivers it to that card's main agent session:

- the currently active card's main agent session, once the LLM becomes active again and reaches a point where it can accept delivered notification context; or
- the next future main agent session for that card, if that session is ever started.

Notifications are immutable after queueing. To correct one, queue another notification that supersedes it.

Notifications are forgotten as queue items after delivery. The platform does not expose a notification inbox, list, get, edit, delete, acknowledge, clear-all, or management UI.

The runtime records delivery markers for delivered notifications so operators can distinguish delivered context from still-pending context in runtime diagnostics. Delivery happens while constructing the next provider input, not while validating a terminal result. Safe delivery points are initial main-agent turns, non-terminal tool continuations, failed terminal `emit_result` repair continuations, and plain-text repair continuations. Terminal validation does not sample pending notification state, does not deliver notifications, and does not reject or defer a terminal result solely because notifications are pending. Notifications arriving on an already-done card after settlement are queued for future delivery and do not mutate lifecycle state. `changed` is produced only by card edits/subtree mutations, never by notification delivery. The runtime must not silently discard pending context.

If a card is deleted or archived with undelivered notifications, those notifications remain with the deleted or archived card representation and are no longer deliverable through the active runtime.

If a user phrases a notification in role terms, such as "tell the executor for goal-7," the Analyst resolves that request to the relevant card or asks one clarifying question.

Delivery can be confirmed only by inspecting the receiving agent session transcript and seeing whether the content appeared and how the agent responded.

## 13. Analyst Capabilities

The Analyst must let the user complete these tasks in natural language:

- inspect cards, runtime state, runtime events, errors, control actions, agent sessions, process registry, process logs, directory listings, file contents, configuration, credentials, and secret-bearing state when needed;
- navigate the workspace to cards, files, debug views, processes, runtime cards, and agent sessions;
- manage cards while runtime status is `stopped` or `paused` through supported semantic operations, including card creation, child reordering, dormant cancellation, and delete/archive-backed removal where allowed;
- update card goal/instructions/acceptance content while runtime status is `stopped` or `paused` by using `write` for `record:///brief.md?card=<id>` or an equivalent concrete `record:///brief.md` URL;
- queue card-addressed notifications;
- run/continue, pause, and shutdown the runtime;
- steer active or future card work by queueing notifications and objective/instruction edits;
- terminate live runtime processes through canonical process controls;
- change model/provider routing, failover, MCP entries, runtime settings, and server settings;
- diagnose failures by correlating cards, runtime events, agent sessions, process output, files, configuration, and credentials;
- apply accepted repair actions in the same conversation.

When a request is ambiguous, the Analyst asks one clarifying question rather than guessing.

For operator-directed repair, the Analyst may use canonical workspace tools directly. `read`, `write`, `edit`, `glob`, and `grep` operate over scoped `project:///`, `record:///`, `tmp:///`, read-only `work:///`, or `system:///` paths. Records are discovered via `glob record:///<cardId>`, read, written, or edited as documents via `record:///<filename>?card=<id>&v=<n>` when applicable, and content-searched via `grep record:///<cardId>`, which searches the latest closed versions of exposed record slots (`brief.md`, `status.md`, and `review.md`) and returns record URLs as `path`. `work:///` content is redacted while record content is not redacted because records are agent-authored content, like project files. `apply_patch` paths are project-relative only and reject scoped URL diff paths. This authority is for inspection, diagnosis, and repair, not for replacing executor delivery work. Card objective changes still use semantic card tools or `write(record:///brief.md?card=<id>&v=next)` when that is the correct operation.

`read` inline content is hard-capped by line length and total bytes; files above roughly 10MB return metadata and guidance rather than content, and `metadata_only` returns `{ size, mtime, is_directory, entries_count? }` without content.

All scoped file URLs use canonical triple-slash form (`<scheme>:///...`). `read` and `glob` accept the root forms `project:///`, `work:///`, and `system:///` and return directory listings; `tmp:///` and `record:///` still require a leading segment. `read record:///<cardId>` returns the same logical exposed-record projection as `get_card`'s `records` field, not raw slot version files. `grep record:///<cardId>` searches the latest closed record versions only, not open or discarded versions. Scoped URL parse failures, invalid record slots, and invalid `grep` regular expressions are returned as model-visible tool errors. Runtime-owned process output and oversized webfetch stashes are addressed through read-only `work:///` URLs under `.saivage-work`; `read` and `grep` redact `work:///` content before returning it to agents because command output and fetched content may contain secrets.

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

The Analyst may inspect process state and terminate processes owned by its current session when canonical process control supports it. Analyst-started commands are session-owned operator work; websocket session cleanup terminates running processes owned by that session. Shutdown also terminates runtime-owned running processes after pausing scheduling.

Process handling uses a launch-and-monitor model rather than unbounded synchronous shell tools. An agent may launch a project command, inspect its evolving status and logs over time, wait for completion with a bounded `wait_process` operation, and then decide whether to wait again, terminate the process, or continue other work. A wait timeout must not by itself kill the process.

`run_command`, `wait_process`, and `kill_process` all return the same process result contract: `process_id`, `exit_code` (`null` while running), `status`, `stdout_url`, `stderr_url`, `stdout_bytes`, `stderr_bytes`, redacted `stdout_tail`/`stderr_tail`, and `tail_truncated`. The output URLs are canonical `work:///processes/<id>/stdout.log` and `work:///processes/<id>/stderr.log` values that can be passed back to `read` or `grep` for paged output. Background starts, wait timeouts, kills, and interrupted foreground commands return this same partial-result shape.

Process-list projections, including `list_processes_tool` and the operator process API, expose `process.logs.stdout` and `process.logs.stderr` as canonical `work:///processes/<id>/{stdout,stderr}.log` URLs, never as bare `.saivage-work` paths. There is no duplicate combined process log. Oversized `webfetch` text stores the body under `.saivage-work/tmp/stash/` and returns `stash_url: work:///tmp/stash/<file>`.

The specification does not impose a process concurrency limit for now. Future runtime settings may add per-card, per-goal, or per-runtime limits.

## 17. Recovery

Startup recovery validates the root card record before recovery planning. If the project card record is corrupt or missing, startup throws before actor recovery so the operator can repair the card record and restart.

Recovery diagnostics are persisted under runtime state and projected through `actorRuntime.recovery` in the runtime status read model. They must not include provider payloads, auth data, prompts, raw actor context, or other secret-bearing fields.

`GET /api/runtime/status` is a live runtime projection. It requires the runtime API and does not fall back to disk snapshots or return `runtime: "unknown"`. `runtime` uses the `RuntimeStatus` vocabulary (`stopped`, `running`, `paused`, `error`). `actorRuntime.cards[].actorState` uses the public card actor vocabulary (`backlog`, `changed`, `blocked`, `failed`, `done`, `running`, `cancelled`, `needs_verification`). `actorRuntime.agents[]` exposes structured identity and phase fields: `agentId`, `role`, `cardId`, and `phase`, where `phase` is `idle`, `requesting_admission`, `calling_provider`, or `waiting_for_tool`.

Known interrupted running card work with valid `active_reconstruction` is recovered by a top-down cascade. Startup constructs running card actors with deferred processor start, then recovers the root card only. Child recovery is driven by the parent's replayed `activate_card` tool call: a running child receives `recoverCurrentCardState()` and is awaited through normal activation settlement. Each reached processor starts lazily, adopts its recovered LLM snapshots inside `processor.recoverActive`, reissues in-flight provider calls, and resolves waiting tool calls inline through tool replay. A `blocked` card status may still arise from safe terminal projection when the persisted planner terminal is itself `blocked`. Persisted running/killing process records are reconciled before actor recovery (see [Implementation Plan P1](../architecture/micro-actor-runtime-implementation-plan.md#p1-processrunner-owns-truthful-process-state-and-scoped-termination) and [P2](../architecture/micro-actor-runtime-implementation-plan.md#p2-startup-reconciles-processes-before-actor-recovery)): runtime/agent-owned records are killed by PID/process-group or marked lost, while operator-owned records are observed best-effort or marked lost. Live process reattachment is not intended and no `reattach_state` fiction is written.

If startup finds a persisted LLM waiting on a terminal tool call and the logged tool-call message contains a complete validated terminal decision, the runtime may project that terminal decision directly into the owning card outcome. This is limited to safe terminal projections, such as executor terminal outcomes, planner `blocked`/`failed` outcomes, and planner `done` outcomes only when paired with a matching persisted reviewer terminal result. Planner `done` must not be projected as completed merely because the planner emitted a done terminal tool.

Actor snapshots may include `active_reconstruction` records for active card, processor, and LLM work. Those records are the durable basis recovery uses to construct running cards, lazily recover reached processors and LLMs, reissue in-flight provider calls, and replay waiting tool calls rather than depending on in-memory queues or raw actor internals. Process reattachment remains excluded: runtime/agent-owned processes are reconciled as killed or marked lost (terminal, retained), operator-owned processes still alive are matched and remain `running` (not terminal), and operator-owned missing/skewed processes are marked lost (terminal, retained). The records are reconstruction inputs, not OS-process handles.

## 18. Reviewer Assessment

Reviewer assessment happens after the planner reports a goal ready for completion and after runtime readiness and evidence gates pass. For now, the reviewer receives the project card data, the goal subtree being assessed, and the return value from the planner agent. The reviewer records an assessment for that snapshot.

Reviewer approval is valid only for the card tree snapshot it assessed. The invalidation rule is defined with changed-card propagation: if the goal or any descendant changes before approval commits, the runtime detects the stale assessment through actual card/subtree/record currentness changes and returns the goal to planner ownership. Reviewer sessions must never drain the card's main-agent notification queue; notifications queued during review remain pending for the next planner/executor safe provider-input delivery. Pending main-agent notification state alone does not invalidate reviewer success (see [Implementation Plan P5](../architecture/micro-actor-runtime-implementation-plan.md#p5-reviewer-cannot-reach-main-agent-notification-delivery)).

Reviewer results are stored locally with the assessed card. If the reviewer result is negative, it is injected back into the planner context through the response to the planner's completion-return tool call. If the reviewer result is positive, the reviewer text is attached to the card for recordkeeping but is otherwise ignored by the planner flow.

## 19. Agent Session Resumption

All agent roles use card-lifetime conversation threads. Planner, executor, and reviewer session ids are deterministic from the card (`planner:<cardId>`, `executor:<cardId>`, and the stable reviewer assessment id for the card), and Analyst sessions are user-facing conversations with the same active-version load-back contract. The persisted thread accumulates across activations until compaction replaces older history with summaries.

The conversation log follows the encapsulation principle: it is a complete record of everything sent to the model. Assistant text, tool calls, tool results including file-read bodies/process stdout or stderr/webfetch bodies, model repairs, notifications delivered at safe pre-provider points, continuation-hook directives, planner-state snapshots, and reviewer descendant context are transcript rows. Reviewer currentness is checked from an in-memory snapshot of the reviewed subtree and included descendant `status.md` record versions; that snapshot is not a separate model-visible transcript row. Failed terminal repair guidance is recorded in the failed `emit_result` tool result, while notification rows for the repair turn are separate provider-input context rows. No side ledgers are kept for tool delivery or tool-call status; pending state is derived from conversation rows, and terminal-projected or abandoned settlements are written as `tool_result` rows. The only persistence-time special case is system-prompt deduplication once per session.

On each idle-path activation, the agent loads the complete active persisted conversation version from disk into provider context, appends a non-provider-visible activation marker, persists the current turn's runtime-provided context rows, and then calls the provider with that loaded thread plus the newly persisted rows. During the turn, in-memory provider context and transcript persistence grow in lockstep. Recovery branches for in-flight provider calls or waiting tool calls do not construct a fresh input.

One runtime activation of a card agent is one conversation round. Compaction operates on the card-lifetime thread across these activation rounds. The only content removal anywhere is compaction-time removal of recoverable `tool_result` bodies; compaction keeps the recovery pointer so the model can re-fetch the content with `read`.

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
- `activate_card` is valid for child cards in `backlog`, `changed`, or `blocked`, and activation transitions the child to `running`;
- main-agent child activation outcomes update the child card to `done`, `failed`, or `blocked` before the parent planner receives the tool result; runtime cancellation may instead resolve the tool result as `cancelled`;
- the Analyst cannot directly set a card to `blocked`; blocked status is produced by a card main-agent activation outcome;
- modifying a non-active, non-terminal card makes it `changed` and queues a notification to that card; terminal `cancelled` cards cannot be edited or reactivated;
- modifying a running card keeps it `running` and queues a notification to that card;
- `changed`, `blocked`, `backlog`, `running`, and `failed` descendants block parent `done` reports until handled;
- `done` and `cancelled` descendants do not block parent `done` reports;
- inactive descendant edits propagate changed-subtree context to inactive ancestors up to the first running ancestor or project root;
- cancellation of running work is authoritative through the current `CardActor` activation (see [Implementation Plan P3](../architecture/micro-actor-runtime-implementation-plan.md#p3-cardactor-owns-authoritative-cancellation-and-activation-id-settlement)): durable status becomes `cancelled` immediately, pending activation resolves as cancelled, activation-owned process scope is stopped, and late outcomes are dropped by the CardActor cancellation flag;
- recursive cancellation of inactive subtrees preserves already-`done` descendants;
- recursive cancellation converts `failed` and `blocked` descendants to `cancelled`;
- cancellation of a non-running card terminates attached runtime-owned processes through canonical process controls;
- card `result` reflects accepted main-agent results only, while `working_status` is a separate free field for agent usage;
- card documents are record-backed: structured card state is read through `get_card`, while `brief.md`, `status.md`, and `review.md` are versioned record slots;
- Analyst card mutations require runtime status `stopped` or `paused`, with `write(record:///brief.md?card=<id>)` as the supported path for updating card goal/instructions/acceptance content;
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
