# Saivage v3 System Functional Specification

Status: current functional authority.

Last updated: 2026-07-13.

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

- A planner owns one planning card subtree and decides how to decompose, activate, and report that project or goal.
- An executor performs one terminal card activation.
- A reviewer assesses a completed planning card after runtime acceptance gates pass: goal reviewers assess completed goal subtrees, and the project reviewer assesses the completed project/root tree outcome.

These roles are dispatched by the runtime. They do not directly invoke each other.

## 3. Core Product Scope

Saivage manages software-development work through a durable card tree.

The system must support:

- autonomous planner, executor, and reviewer work through cards;
- explicit user lifecycle control through the Analyst;
- planner-owned card creation, editing, reordering, cancellation, deletion, and archival where supported;
- record-backed card documents, including `brief.md`, `status.md`, and `review.md` record slots;
- Analyst-owned card management while runtime status is `stopped` or `paused` through semantic card operations and `write`/`edit` for `record:///brief.md?card=<id>&v=next`;
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

A card can describe a project, a goal, or a terminal task. Project and goal cards are worked by planners. Terminal cards are worked by executors. Reviewers assess completed project or goal planning cards.

Every card has structured state and authored document records. Structured state includes identity, type, parent, order, title, lifecycle status, dependencies, retries, metrics, and other scheduler-visible fields. The current goal, instructions, and acceptance criteria live in the latest closed `record:///brief.md` record for the card rather than separate long-form card fields.

Cards may also carry dependencies, history, result data, and agent-maintained working status.

`working_status` is free text for agents attached to the card to record ongoing advancement when that write path is available. It is not the accepted completion result.

`result` is the data returned by the card's main agent to its parent and attached to the card when accepted. The system must not mirror mid-run progress, rejected reports, reviewer correction requests, or failed validation attempts into `result` as if they were accepted outcomes. Specialized agents may also store their own result fields, such as `reviewer_result`, for feedback that must be visible to later planner turns.

Card storage uses self-contained canonical JSON artifacts. Card versions under `.saivage/cards/<id>/card/versions/` contain structured state and history; authored versions under `.saivage/cards/<id>/<slot>/versions/` contain state, content, writer, slot-local version, and commit timestamps. Adjacent indexes are deterministic disposable projections rebuilt from canonical artifacts. Indexes and separate Markdown bodies are never authority, and there is no project-wide record ordinal. Primary card information is read through `get_card`; authored documents remain available through logical `record:///<filename>?card=<id>&v=<n>` URLs and never expose writable physical artifact paths.

The project card is mostly a regular goal card. Its special properties are structural and activation-related: it has no parent, and the runtime activates it directly when the user asks the Analyst to run/continue the system. It carries project-level context, global constraints, and the user's top-level objective summary.

If the user asks the Analyst to replace the project objective, the expected path is to update the existing project card's `record:///brief.md?card=project&v=next` with `write` or `edit` while runtime status is `stopped` or `paused`, subject to the same card-status gate as other brief edits. Direct destructive replacement of the project card is not an Analyst capability.

Archiving is not a card status. Deleting or archiving a card removes it from the active card tree and removes its live `.saivage/cards/<id>/` record namespace. Deleted card ids remain reserved in `.saivage/state/deleted-card-ids.json`; there is no card restore or archive-content contract.

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

The Analyst has limited card authority on behalf of the user. All Analyst card mutations require runtime status `stopped` or `paused`. In those states, the Analyst may manage cards through semantic operations such as create card, reorder direct children where supported, cancel dormant work, and delete cards/subtrees from the active tree with deleted-id reservation. It may also update the goal/instructions/acceptance brief of any existing card whose current status is exactly `backlog`, `done`, `failed`, or `running` by calling `write` or `edit` on `record:///brief.md?card=<id>&v=next`, or by committing fetched content with `webfetch.save_as` to that same record URL. Direct brief edits to `changed`, `blocked`, or `cancelled` cards fail before publication. Brief close and lifecycle propagation occupy one authority-serialized request: the brief is accepted first, then card/ancestor propagation is attempted as independently durable publications. A propagation failure reports accepted partial completion; startup does not replay or converge it. `edit` loads the latest closed brief as its source and never rewrites a historical closed version in place.

The Analyst must not directly rewrite primary card state, lifecycle/output state, `status.md`, or `review.md`. Analyst structural mutations that would invalidate a running subtree remain denied unless a later design explicitly allows them. A running card's `brief.md` may be updated while runtime status is `stopped` or `paused`; the card remains `running` and only that card is notified. Cross-parent card movement, restart/reset, direct activation, and direct deleted-id state manipulation are not Analyst card operations.

A planner's card authority is local to the goal it owns. It may directly target only that goal's direct children: create them, edit them, reorder them, cancel/delete them where supported, and activate them. Some supported operations, such as cancelling or deleting a direct child, may recursively affect that child's descendants. The planner still targets only the direct child; it may not directly mutate ancestors, siblings, unrelated cards, or descendants below one of its children. Larger tree changes are Analyst-owned, but cross-parent card movement is not a supported card operation.

Displayed child order is for presentation and comprehension. It is not a hard scheduling contract. A planner may dispatch children out of displayed order if its reasoning says that is appropriate.

## 7. Lifecycle Controls

From the user and Analyst point of view, there are two runtime lifecycle controls:

- **Run**: start or resume autonomous progress.
- **Pause**: stop scheduling new autonomous work without killing state or processes.

### Run

Run is the user-facing operation for both initial start and resume. If the project has never been started or has no active root run, Run starts root project execution. If the system is paused, Run resumes it. If the system is already running, Run returns an already-running warning and creates no second root run.

Implementation may keep separate internal commands such as `start_project` and `resume_runtime`, but the Analyst should present a unified user concept: "run/continue the system."

### Pause

Pause is a global provider-admission gate. It stops the runtime from starting new LLM/provider calls. Pause itself does not mutate card statuses, active-card-run state, session lifecycle state, or process state.

Already-running provider calls and shell processes may continue while the system is paused. Already-received provider responses continue to drain: their tool calls may execute, cards may transition to `running`, and runtime-owned processes may spawn until in-flight responses drain and the next provider call parks at the gate. Completion facts produced by already-admitted work may be persisted and settled while paused.

Resume reopens the gate. Work already blocked at provider calls proceeds exactly once in normal runtime ordering. Resume must not require a manual second Run for work that was already waiting behind the pause gate.

The single global `RuntimeGate` implements this behavior at `LLMActor` provider-call admission: provider calls await the gate before starting, so pause waits rather than failing the turn. A blocked admission is owned by its active invocation abort signal; cancellation rejects it immediately and removes its gate waiter without requiring a later Resume.

The gate has a distinct terminal closure used only by internal runtime disposal. Terminal closure rejects every current and future provider-admission waiter with the interruption reason and cannot be reopened; ordinary Pause remains the reversible `close` operation. For every initial, repair, post-tool, and compaction-bearing provider turn, the LLM actor creates one combined task/activation signal before preprocessing and passes that exact signal through compaction/summarization, gate admission, and the main provider call.

Each provider-bearing turn has one immutable invocation lease. A revoked turn cannot deliver a late provider result, tool call, conversation notification, actor transition, or continuation. Successful completion persistence is linearized through the callback-only `CompletionPersistenceAdmission.admit(invocation, persist)` boundary. Losing admission invokes no persistence callback. Winning admission invokes it once and keeps actor/session settlement joined until its internal release. For OpenAI Responses, that one callback contains the paired private replay row and visible assistant/tool-call projection append; Responses has no separate completion-commit lease or interruption fence.

LLM candidate unavailability is handled after provider-call admission and is separate from pause. For a role with at least one configured, capability-compatible candidate, `InvocationService` owns a single per-invocation recovery state machine. A candidate is tried in configured route order and, for non-rate-limit transient failures (`server_transient`, timeout, retryable parse failures, or unstructured unknown transport failures), is retried on the same candidate first until its bounded retry budget is exhausted; the invocation waits for that candidate's retry time and does not try later alternates during that non-rate-limit wait. Each candidate may be attempted once plus three recovery retries, and the independent provider-turn deadline is two hours. `rate_limit`/`Retry-After` is the exception: the rate-limited candidate cools, but currently eligible later untried candidates are attempted before sleeping or retrying the throttled candidate, even if the first candidate's cooldown becomes ready meanwhile. HTTP/SSE provider failures are fail-fast unless they carry explicit temporary evidence: 429/rate-limit maps to `rate_limit`, 500/502/503/504 or explicit temporary server evidence maps to `server_transient`, token/context signals map to `token_budget_exceeded`, and ordinary 400/404/422 invalid input/model/schema/protocol responses map to permanent `provider_protocol_error`. No configured/capability-compatible candidate, capability mismatch, permanent authentication/configuration/input/protocol failures, and typed local setup failures remain fail-fast conditions with no retry and no alternate failover.

`ProviderTurnFailure` is the only ordinary provider-failure contract. A raw provider rejection, or a `provider_attempt` failure without a provider-exchange envelope, is a strict contract violation: it rejects the direct turn without retry, normalization, invented exchange metadata, or `model_issue`. Once a turn is armed, that strict rejection and any non-abort pre-provider failure still settle the LLM from `calling_provider` to `idle` before card-processing consumers run; the card and its parent `activate_card` barrier therefore receive their ordinary single failed activation outcome rather than remaining active. Valid typed provider failures retain their normal model-visible failure behavior, and active-invocation aborts retain cancellation behavior.

`Stopped` and `paused` are the normal intervention states. While stopped or paused, the Analyst can manage cards within its supported authority, update `record:///brief.md?card=<id>&v=next` through `write` or `edit`, queue notifications, change configuration, and inspect state.

### Internal Shutdown

Internal shutdown is server/application-disposal cleanup, not an Analyst control. It is terminal for that runtime instance: it synchronously closes admission before awaiting cleanup, cancels every live card through `CardActor.cancel()`, terminates runtime-owned process groups, clears actors/current markers, and persists `stopped` with no active run. It is not a conversational tool, operator HTTP endpoint, or UI mutation.

### Server Restart

`restart_server` is a distinct destructive Analyst capability. It is available only when HTTP/WebSocket operator authentication is enabled by the deployment API token. When authentication is disabled, ordinary development chat remains available, but the restart tool is omitted from its catalog and prompt; a direct or stale invocation fails with `restart unavailable: operator authentication disabled` and records the denied audit action.

All authenticated normal web access to `analyst:global` represents one singular operator authority. Authentication admits access to that authority; it does not establish an individual identity. The actor owns one pending confirmation for that global session, not for a bearer token, browser, connection, device, or transport. Consequently, either authenticated normal web transport may supply the exact next confirmation.

The initial successful `restart_server` call is non-mutating: it returns `confirmation_required` with the literal `RESTART SERVER`, records the normal allowed audit action with outcome `restart confirmation required`, settles without a model continuation, and schedules nothing. The actor consumes pending state on the next turn. Only an exact `RESTART SERVER` next turn appends the canonical raw message, records the accepted `runtime.restart_server` audit action naming `analyst:global` as the operator authority, and schedules shutdown. Any other next turn cancels the pending confirmation and follows ordinary Analyst processing.

Scheduling alone does not tear down the application. The REST handler acknowledges only after the scheduled response finishes writing, and the WebSocket handler acknowledges only after its terminal acknowledgement frame send callback succeeds. That acknowledgement disposes the application and exits with status 75 exactly once. It records that shutdown was accepted and scheduled; it does not establish replacement-process availability or readiness.

## 8. Active Work And `activate_card`

At most one active leaf does real work at a time. The active work can still form a chain of `running` cards from the project root to the leaf; ancestors are waiting.

Planners do not directly run child planners or executors. A planner calls `activate_card(card_id)`. From the parent planner's perspective, this is a synchronous logical barrier: one tool call eventually receives exactly one activation outcome. Main-agent outcomes are `done`, `failed`, or `blocked`; runtime cancellation may instead produce parent-visible `cancelled`.

An armed child LLM turn that fails fatally, including a strict provider-contract violation, cannot leave this barrier pending: the child commits `failed` and the parent receives exactly one failed `activate_card` tool result through its normal continuation.

`activate_card` is valid only when the caller is the responsible parent planner, the requested card is an immediate child of that planner's goal, and the child is in an activatable state. Activatable statuses are `backlog`, `changed`, and `blocked`. Activating a card in any activatable state transitions it to `running`, so reactivating a `changed` card clears the durable `changed` status by replacing it with `running`. A `done` card is not activatable; it must first be modified into `changed` or replaced by new work. A `failed` card is not activatable; the parent must cancel it, replace it, edit it into `changed`, or escalate/report failure. Invalid activations fail before dispatch and leave card status unchanged.

Startup recovery classifies, repairs, and globally tool-settles planner, reviewer, and executor card work only. It excludes Analyst conversations, leaving their active conversation versions unchanged.

The runtime persists card, processor, LLM, active conversation, and current-work cursor state across service restarts. On startup recovery, the in-memory process registry starts empty: previous process ids are unknown, persisted PID/process-group reconciliation does not run, and any abrupt-crash OS-process survivors are outside Saivage's model. Startup validates the nested actor hierarchy child-first: durable card status is the outer truth, active processor/LLM snapshots must be compatible with that card, and each planner/reviewer/executor conversation is classified from its active version before reconstruction. Interrupted provider-visible tool calls receive actionable failed `tool_result` rows before provider reissue; valid `tool_error` rows remain recovery-visible only, so a tool call settled only by `tool_error` receives a provider-visible failed `tool_result` for the same `(session_id, source_input_id, tool_call_id)` triple before the model sees the transcript again. Dangling `activate_card` calls are inspected before generic stale-tool settlement. Recovery keeps a running child linked only when the parent already has a compatible adoptable `waiting_tool` snapshot or active reconstruction for that exact parent conversation triple; absent, idle, removed, or unreconstructable parent LLM sessions instead get an actionable interrupted-activation result, and any compatible child may continue as root-level running work with a recovery incident. Activation edges are derived from active parent conversation `activate_card` rows, not from runtime-state cursor ownership, run ledgers, or activation ledgers. Safe terminal decisions may still be projected from complete durable terminal records. A replayed process-tool wait resolves to an interrupted outcome the owning agent re-issues after inspecting current state. A `blocked` card status may still arise from safe terminal projection when the persisted planner terminal is itself `blocked`. The parent planner observes one outcome for the activation:

- `done`
- `failed`
- `blocked`
- `cancelled` (runtime-produced only; never emitted by a main agent)

The main agent for every card type may report `done`, `failed`, or `blocked`. Before the parent planner receives a main-agent activation outcome, the child card first transitions to the matching card status. Runtime-produced `cancelled` is not emitted by a main agent.

The Analyst does not directly set cards to `blocked`. `blocked` is reported by a card's main agent as an activation outcome. Analyst intervention uses supported objective/instruction edits or card-addressed notifications.

Reviewer `rework` is handled inside the child activation. It is not a parent-visible activation result unless review retries are exhausted and the child activation ultimately returns `failed`.

## 9. Changed Cards

For Analyst `brief.md` edits, only direct targets currently in `backlog`, `done`, `failed`, or `running` are editable. A direct `backlog` brief edit leaves that card in `backlog` and does not notify that unstarted card. A direct `done` or `failed` brief edit changes that card to `changed`; a direct `running` brief edit leaves the card `running`. Direct `changed`, `blocked`, and `cancelled` brief edits fail before writing. Terminal `cancelled` cards cannot be edited or reactivated. To replace cancelled work, create a new card.

If the modified card is already `running`, it remains `running`. Running status is not overwritten by `changed` because it is part of the active activation chain.

For `done`, `failed`, and `running` targets, the runtime queues a notification to the modified card so that the main agent handling that card becomes aware of the change. Backlog targets are unstarted and receive no self-notification. If a notified card is currently active, the notification is delivered once the LLM becomes active again and reaches a point where it can accept delivered notification context. If the card is not active, the notification is delivered to the next future main agent session for that card. If that future session never starts, the notification is never delivered.

`changed` is a parent-visible durable signal. It tells the parent planner that the child or descendant changed after the planner last observed it. A planner cannot successfully report a goal `done` while any executable descendant is not in a completion-compatible state.

When an inactive descendant changes through an Analyst brief edit, the runtime walks the direct ancestor path up to the first running ancestor or the project root. Backlog target edits start walking at the parent and exclude the edited backlog card from recipients. `done` and `failed` target edits start at the edited card. Only `done` and `failed` cards on the walked path become `changed`; `backlog`, `changed`, and `blocked` ancestors remain unchanged, and a running ancestor remains `running` and stops propagation. The runtime queues fire-and-forget card notifications to every `goal`/`project` ancestor on the walked path through the first running ancestor, and also to the edited card for `done`/`failed` targets, with duplicate recipients removed. Notification callback results do not affect the already-accepted edit.

If a planning card is under review and that card or any descendant changes before the reviewer pass commits, the reviewer pass is invalidated. The planning card returns to planner ownership with correction/change context; stale reviewer approval must not mark the card `done`.

The `changed` state does not by itself dispatch work. For activation and cancellation purposes, `changed` behaves like `backlog`: the responsible planner can reactivate the changed child or cancel it, but the runtime does not clear `changed` merely because the status exists.

## 10. Planner Completion Gates

A planner can report a project or goal `done`, `failed`, or `blocked`. Planner, executor, and reviewer terminal reports are accepted only through the unified `emit_result` terminal tool, with each role's contract validating the statuses that role may emit. Plain prose, ad-hoc JSON, or unsupported tool calls must not be treated as accepted card outcomes.

Terminal `emit_result` validation validates only the terminal call, required records, completion gates, and reviewer rework. It must not inspect or gate on pending main-agent notifications after the model has emitted `emit_result`. If a terminal report is invalid, the failed `emit_result` tool result carries the terminal repair guidance: invalid arguments ask the model to call `emit_result` again with valid JSON; missing `status.md` or `review.md` asks it to create the required record and call `emit_result` again; completion-gate failures report the descendant/evidence condition that blocks `done`; reviewer rework reports the reviewer guidance. Pending notifications are not terminal validation errors and must not be combined into those repair messages.

Before accepting `done`, the runtime must verify:

- every executable descendant card is in a completion-compatible state;
- required evidence references are valid;
- reviewer assessment passes after readiness and evidence gates pass.

If any executable descendant remains `changed`, `blocked`, `backlog`, `running`, `failed`, or otherwise non-compatible with successful completion, the parent cannot close the planning card. Only `done` and `cancelled` descendants are completion-compatible and do not block `done`. `blocked` is unresolved rather than final: the parent planner must fix the blocking condition and reactivate the card, send a notification explaining the unblocked condition before reactivation, edit the card so it becomes `changed` under the changed-card rules in section 9, cancel the card, or report `blocked` itself so the responsibility moves upward. `failed` blocks `done` until the parent takes explicit action, such as replacing the failed work, editing the card into `changed`, cancelling the failed child where supported, or reporting/escalating failure upward. The runtime reports a readiness error that identifies the descendant state that must be handled.

Planning-card state must reflect the latest accepted planner and reviewer state before the project or goal can close.

If a reviewer interrupts a completion by requesting corrections, the assessed planning card returns to planner ownership with reviewer feedback in context. When the assessed card is a child goal, the parent planner remains behind the same `activate_card` barrier until that child activation ultimately reports `done`, `failed`, or `blocked`, or until runtime cancellation resolves it as `cancelled`. The planner rework continuation is a failed planner `emit_result` repair turn: the failed tool result contains reviewer guidance only, while any queued notifications for that next planner turn are delivered as separate provider-input context rows.

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

If a card is deleted or archived with undelivered notifications, those notifications are removed with the live card namespace and are no longer deliverable through the active runtime.

If a user phrases a notification in role terms, such as "tell the executor for goal-7," the Analyst resolves that request to the relevant card or asks one clarifying question.

Delivery can be confirmed only by inspecting the receiving agent session transcript and seeing whether the content appeared and how the agent responded.

## 13. Analyst Capabilities

The Analyst must let the user complete these tasks in natural language:

- inspect cards, runtime state, runtime events, errors, control actions, agent sessions, live process projections, process logs, directory listings, file contents, configuration, credentials, and secret-bearing state when needed;
- navigate the workspace to cards, files, debug views, processes, runtime cards, and agent sessions;
- manage cards while runtime status is `stopped` or `paused` through supported semantic operations, including card creation, child reordering, dormant cancellation, and delete/archive removal where allowed;
- update card goal/instructions/acceptance content while runtime status is `stopped` or `paused` by using `write`, `edit`, or `webfetch.save_as` for `record:///brief.md?card=<id>&v=next` when the card is `backlog`, `done`, `failed`, or `running`;
- queue card-addressed notifications;
- run/continue and pause the runtime, and request a server restart where needed;
- steer active or future card work by queueing notifications and objective/instruction edits;
- terminate live runtime processes through canonical process controls;
- change model/provider routing, failover, MCP entries, runtime settings, and server settings;
- diagnose failures by correlating cards, runtime events, agent sessions, process output, files, configuration, and credentials;
- apply accepted repair actions in the same conversation.

When a request is ambiguous, the Analyst asks one clarifying question rather than guessing.

For operator-directed repair, the Analyst may use canonical workspace tools directly. `read`, `write`, `edit`, `glob`, and `grep` operate over scoped `project:///`, `record:///`, `tmp:///`, read-only `work:///`, or `system:///` paths. Records are discovered via `glob record:///<cardId>`, read as documents via `record:///<filename>?card=<id>&v=<n>`, and content-searched via `grep record:///<cardId>`, which searches the latest closed versions of exposed record slots (`brief.md`, `status.md`, and `review.md`) and returns record URLs as `path`. Analyst `write` and `edit` to `record:///brief.md?card=<id>&v=next` are the only supported Analyst record mutation path and share the same new-version card-edit contract; unsupported Analyst record edit paths fail rather than raw-writing record files. `work:///` content is redacted while record content is not redacted because records are agent-authored content, like project files. `apply_patch` paths are project-relative only and reject scoped URL diff paths. This authority is for inspection, diagnosis, and repair, not for replacing executor delivery work.

`read` inline content is hard-capped by line length and total bytes; files above roughly 10MB return metadata and guidance rather than content, and `metadata_only` returns `{ size, mtime, is_directory, entries_count? }` without content. `grep` streams text incrementally, so it can search files above the inline-read size limit without retaining the whole file. It returns at most the requested result count with 500-character previews and searches at most the retained 2000-character prefix of each logical line. If any scanned line exceeds that bound, the result includes `content_truncated: true` and `max_line_chars: 2000`; `truncated` is true for either that content truncation or a result-limit stop.

All scoped file URLs use canonical triple-slash form (`<scheme>:///...`). `read` and `glob` accept the root forms `project:///`, `work:///`, and `system:///` and return directory listings; `tmp:///` and `record:///` still require a leading segment. `record:///` resolves durable card records under `.saivage/cards`, `tmp:///<cardId>/...` resolves disposable card scratch under `.saivage/work/cards/<cardId>/tmp/...`, and `work:///` resolves disposable operational state under `.saivage/work`. `read record:///<cardId>` returns the same logical exposed-record projection as `get_card`'s `records` field, not raw slot version files. `grep record:///<cardId>` searches the latest closed record versions only, not open or discarded versions. Scoped URL parse failures, invalid record slots, and invalid `grep` regular expressions are returned as model-visible tool errors. Runtime-owned process output and oversized webfetch stashes are addressed through read-only `work:///` URLs; `read` and `grep` redact `work:///` content before returning it to agents because command output and fetched content may contain secrets.

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

Agents may start project commands through runtime-owned process facilities. In-memory process records expose safe read models during the current server instance: status, timestamps, command text, contained working directory, logs, and termination availability. Every launch is bound to one opaque direct capability and exactly one category: `runtime_card`, `operator_session`, or `service_infrastructure`. Scope labels and `owner_id` / `owner_kind` are provenance for diagnostics and visibility; they are not termination authority.

The Analyst may inspect process state and terminate processes launched through its current session's exact direct capability and `operator_session` category. A same-owner sibling capability cannot terminate them. Analyst-started commands are session-owned operator work; losing a browser WebSocket does not clean up the shared `analyst:global` session or its processes. Application disposal owns that cleanup, while internal runtime cleanup selects the runtime-root `runtime_card` scope tree.

Process handling uses a launch-and-monitor model rather than unbounded synchronous shell tools. Each managed POSIX launch owns a detached process group for the current server-instance lifetime, not merely its shell leader. The group remains live and controllable after the leader exits while descendants remain. Exact-scope kill and scope-tree cleanup use one TERM, grace, KILL, final-probe schedule. Only `kill(-pgid, 0)` returning `ESRCH` proves absence; wrapper `exit` / `close`, `ChildProcess.killed`, status mutation, and successful signal dispatch do not. `EPERM`, an unknown probe result, or a thrown probe makes the group permanently `unverifiable` for this instance: it remains retained for diagnostics, receives no later probe or signal, and cannot be reported stopped. `timeout_ms: 0` is non-blocking inspection; a positive timeout returns the running view without killing the group when the deadline expires. A terminal result is published only after the group is proved absent. The registry, capabilities, PIDs, and PGIDs are never persisted or adopted; a successor starts empty and never scans or signals predecessor groups.

`run_command`, `wait_process`, and `kill_process` all return the same metadata-only process result contract: `process_id`, `exit_code` (`null` while running), `status`, `stdout_url`, `stderr_url`, `stdout_bytes`, and `stderr_bytes`. Card-owned output URLs are canonical `work:///cards/<cardId>/processes/<id>/stdout.log` and `work:///cards/<cardId>/processes/<id>/stderr.log`; non-card Analyst/operator/runtime output URLs are canonical `work:///processes/<id>/stdout.log` and `work:///processes/<id>/stderr.log`. Background starts, wait timeouts, kills, and interrupted foreground commands return this same partial-result shape.

Process-list projections, including `list_processes_tool` and the operator process API, expose `card_id: string | null`, `owner_kind`, `owner_id`, and `process.logs.stdout` / `process.logs.stderr` as canonical card-owned or non-card `work:///` URLs, never as bare `.saivage/work` paths. They do not expose a duplicate `owner` shorthand. There is no duplicate combined process log. Oversized `webfetch` text stores the body under `.saivage/work/tmp/stash/` and returns `stash_url: work:///tmp/stash/<file>`. `.saivage/work` is disposable operational state and may be removed while the runtime is stopped; startup recreates it without deleting durable `.saivage/cards` metadata.

The specification does not impose a process concurrency limit for now. Future runtime settings may add per-card, per-goal, or per-runtime limits.

## 17. Operator API And Live Projections

`/api/state` returns the persisted runtime-state projection from `.saivage/state/runtime.json`; the `runtime` field may be `null` when that file is absent. Live server availability is a separate projection sourced from the running runtime application. If that live runtime-status read fails, availability reports a degraded diagnostic for `runtime-application`; `runtime-state` is not an availability component source. Runtime event, error, control-action, and content-supervision review APIs are logical projections from the single application log at `.saivage/logs/app.jsonl`. When supervision blocks content, it appends only a sanitized `content_review` summary; the blocked raw content is not stored, no quarantine side files are created, and no browseable quarantine path is exposed.

The current project-local `.saivage/` layout separates durable operator input, generated state, logs, locks, and disposable work. Durable inputs include `.saivage/saivage.yaml`, `.saivage/auth-profiles.json`, `.saivage/project.json`, `.saivage/config/prompts/<cardType>/<role>.md`, `.saivage/skills/index.json`, and `.saivage/instructions/`. Generated state lives under `.saivage/cards/`, `.saivage/agents/`, and `.saivage/state/`; the application log is `.saivage/logs/app.jsonl`; process/runtime locks live under `.saivage/locks/`; disposable process and stash output lives under `.saivage/work/`.

CLI initialization uses the same invariant as runtime startup: `.saivage/project.json` alone is not an initialized project. A project is initialized only when the current generated layout and canonical root project card exist. Fresh-root `saivage init` is the sole project-identity creator: it acquires bootstrap-unbound ownership, creates strict project identity through `ProjectIdentityStore` and the command's synchronous mutation lane, atomically binds that same lock owner, and only then creates generated state. On an identified project, Init uses bound ownership and completes missing generated layout while preserving durable inputs and prompt overrides; it reports “already initialized” only when the full invariant holds. `saivage start --create-runtime` requires existing strict project identity, acquires a bound lock, and may fill only missing generated runtime layout before loading config and starting the server. Plain `start` also requires bound ownership and does not initialize missing projects. Runtime-tree initialization does not create a configuration file. For `--create-runtime`, the resolved configuration authority creates a missing canonical default at the selected CLI, environment, or default path and never overwrites an existing selected file.

`runtime.lock` has one strict version-1 owner schema. Both bootstrap-unbound and bound records contain a fresh instance id, PID, exact OS process-start identity, diagnostic ISO timestamp, and SHA-256 identity of the canonical real project root. Only bootstrap-unbound has null project identity; bound records contain the digest of strict project `id` and `created_at`. The control endpoint is null before listen and the same bound owner atomically publishes its actual URL origin and `disabled`/`bearer` auth mode after listen; this metadata is not yet consumed by the current Pause/Resume CLI routing contract. Acquisition makes exactly one `O_CREAT|O_EXCL` attempt. Every existing path blocks Init, reset, and start without unlink, retry, takeover, rename, or normalization. Read-only status classifies a blocker as live, dead/stale, or malformed/unreadable; `EPERM` and indeterminate liveness are conservatively live. Classification grants no mutation authority. For dead/stale or malformed/unreadable records, the instruction is: `Verify that no Saivage process owns '<canonical-project-root>', then remove the abandoned lock manually with: rm -- '<absolute-runtime-lock-path>'; rerun the command.` Only a matching owner instance/PID-start/root handle may bind, publish its endpoint, or release; missing or changed on-disk ownership fails closed and preserves the path.

`saivage reset` uses the same bound direct-command composition as Init: it creates one private composition authority and process-local synchronous mutation lane, removes generated roots (`cards`, `agents`, `state`, `logs`, `locks` contents except its held runtime lock, `work`, and optional `stages`), the external generated `.saivage-work/` root, and obsolete/generated legacy roots (`runtime`, `tmp`, `archive`, `supervision`, `notes`, `outputs`, and `views`), reinitializes while retaining the exact lock, then performs matching-owner release. There is no supported raw helper composition. After success, durable credentials/config/operator inputs and source/docs are preserved, `.saivage/state/runtime.json` contains default runtime state, `.saivage/logs/app.jsonl` exists and is empty, `.saivage/locks/` exists without `runtime.lock`, and `.saivage/cards/project/` exists as the root project card.

Runtime events are read through paginated operator endpoints. Missing `limit` and `offset` use their defaults, but malformed present values such as negative numbers, decimals, or non-numeric strings fail request validation instead of being silently defaulted.

Chat send responses and Analyst websocket responses are not transcript sources and do not carry assistant `message` rows. Operator transcripts are read through canonical conversation fetches and refreshed through direct semantic live-sync invalidations. Every changed durable live conversation mutation, including appended rows and compaction active-version replacement, publishes scoped conversation and `agents` freshness after persistence. The separate canonical `conversation_changed` event is timeline/debug metadata and does not produce core freshness. Canonical transcript reads return the active conversation version/current projection and do not merge inactive pre-compaction versions.

Live freshness hints are process-local, lossy, and coalescible; they cause an authoritative REST refetch rather than carrying state. Successful changed conversation mutations target their scoped conversation and `agents`, and successful provider-exchange appends target `agents`. Card mutations always target `cards` when changed, adding `runtime` for creation, deletion, status, or mutable-type changes and adding `agents` for deletion or status changes. Actor snapshot changes target `runtime`; LLM snapshots additionally target `agents` and the actor conversation. Semantic no-ops, unsuccessful removal, and persistence failures publish nothing.

Event metadata is independently useful for timeline and Debug projections, but `conversation_changed`, Analyst tool activity, control actions, notifications, and diagnostics do not infer core projection freshness. Core freshness comes only from the server-composed semantic mutation owners.

While the server is ready, successful project start, REST/Analyst pause or resume, active-run transitions, and completion/failure settlement publish `runtime`. A lock-held `saivage pause` or `saivage resume` delegates to the canonical REST route and therefore uses that owner; it fails rather than falling back to direct persistence. Without a live lock, the CLI persists directly and performs no REST request. Startup recovery runs before live delivery is subscribed and shutdown writes after delivery closes, so startup, shutdown, and unlocked CLI changes are observed on authoritative initial load or reconnect rather than through guaranteed immediate hints.

## 18. Recovery

Startup recovery validates the root card record before recovery planning. If the project card record is corrupt or missing, startup throws before actor recovery so the operator can repair the card record and restart.

Recovery diagnostics are persisted at `.saivage/state/recovery-diagnostics.json` and projected through `actorRuntime.recovery` in the runtime status read model. They must not include provider payloads, auth data, prompts, raw actor context, or other secret-bearing fields.

Startup recovery and global tool settlement read only autonomous planner, reviewer, and executor sessions. They do not read, classify, repair, or append to Analyst conversation active versions.

`GET /api/runtime/status` is a live runtime projection. It requires the runtime API and does not fall back to disk snapshots or return `runtime: "unknown"`. `runtime` uses the `RuntimeStatus` vocabulary (`stopped`, `running`, `paused`, `error`). `actorRuntime.cards[].actorState` uses the public card actor vocabulary (`backlog`, `changed`, `blocked`, `failed`, `done`, `running`, `cancelled`). `actorRuntime.agents[]` exposes structured identity and phase fields: `agentId`, `role`, `cardId`, and `phase`, where `phase` is `idle`, `calling_provider`, or `waiting_for_tool`.

While the server is ready, every successful runtime-state write owned by project start, REST/Analyst pause or resume, active-run transitions, or autonomous completion/failure emits one lossy process-local runtime freshness hint. Rejected/no-write branches and failed persistence emit none. A CLI pause/resume detecting the live runtime lock must POST the canonical REST control route, including configured bearer authentication, and must fail on server errors without direct-persistence fallback. Without a live lock, the CLI directly persists control state and makes no REST request. Startup reconciliation, shutdown, and unlocked CLI writes have no immediate-hint guarantee; initial load or reconnect reads their authoritative state.

Known interrupted running card work is recovered in two stages. Before actor reconstruction, startup builds role/session-local conversation recovery entries for planner, reviewer, and executor conversations from the active conversation version, classifies each entry, removes inner snapshots that conflict with the durable outer card state, appends model-visible failed `tool_result` rows for unrelinked dangling tool calls, and adds a repair directive when an assistant plain-text response must be retried with tools. A dangling parent `activate_card` call is inspected before generic stale-tool settlement; if recovery cannot reconstruct a concrete parent continuation, the call receives an actionable failed activation result rather than being preserved as a dead edge. Startup then constructs running card actors with deferred processor start and recovers the root card only. Child recovery is driven by the parent's replayed `activate_card` tool call when that wait remains recoverable. Each reached processor starts lazily, adopts compatible recovered LLM snapshots inside `processor.recoverActive`, reissues in-flight provider calls, and resolves waiting tool calls inline through tool replay. A `blocked` card status may still arise from safe terminal projection when the persisted planner terminal is itself `blocked`. Process registry state is not recovered; interrupted process-tool waits resolve as failed/unknown and the owning agent must inspect current state and launch new work when needed.

If startup finds a persisted LLM waiting on a terminal tool call and the logged tool-call message contains a complete validated terminal decision, the runtime may project that terminal decision directly into the owning card outcome. This is limited to safe terminal projections, such as executor terminal outcomes, planner `blocked`/`failed` outcomes, and planner `done` outcomes only when paired with a matching persisted reviewer terminal result. Planner `done` must not be projected as completed merely because the planner emitted a done terminal tool.

Actor snapshots may include `active_reconstruction` records for active card, processor, and autonomous planner/executor/reviewer LLM work. Snapshot-owning `LLMActor` is limited to those card roles; Analyst turns use `ConversationLLMActor` and persist their durable conversation without an LLM cursor snapshot. Card status is the outer durable truth: terminal, changed, backlog, or cancelled cards do not keep active inner processor/LLM snapshots after startup recovery. Running cards keep only compatible processor/LLM reconstruction records. Process reattachment remains excluded: process records are live runtime state only, not reconstruction inputs or OS-process handles.

## 19. Reviewer Assessment

Reviewer assessment happens after the planner reports a planning card ready for completion and after runtime readiness and evidence gates pass. Goal reviewers receive the project card data, the goal subtree being assessed, and the return value from the planner agent. The project reviewer assesses the completed project/root tree outcome against the project card brief and acceptance criteria. The reviewer records an assessment for that snapshot.

Reviewer approval is valid only for the card tree snapshot it assessed. The invalidation rule is defined with changed-card propagation: if the assessed planning card or any descendant changes before approval commits, the runtime detects the stale assessment through actual card/subtree/record currentness changes and returns the assessed card to planner ownership. Reviewer sessions must never drain the card's main-agent notification queue; notifications queued during review remain pending for the next planner/executor safe provider-input delivery. Pending main-agent notification state alone does not invalidate reviewer success (see [Implementation Plan P5](../architecture/micro-actor-runtime-implementation-plan.md#p5-reviewer-cannot-reach-main-agent-notification-delivery)).

Reviewer results are stored locally with the assessed card. If the reviewer result is negative, it is injected back into the planner context through the response to the planner's completion-return tool call. If the reviewer result is positive, the reviewer text is attached to the card for recordkeeping but is otherwise ignored by the planner flow.

## 20. Agent Session Resumption

Planner, executor, and reviewer roles use card-lifetime conversation threads. Planner and executor session ids are deterministic from the card (`planner:<cardId>`, `executor:<cardId>`), and reviewer assessment sessions are card-owned sessions under the reviewed card's conversation directory. Card-scoped conversations persist under `.saivage/cards/<cardId>/conversations/<encoded-session-id>/`; Analyst conversations are user-facing sessions with the same active-version load-back contract under `.saivage/agents/conversations/<encoded-session-id>/`. The persisted thread accumulates across activations until compaction replaces older history with summaries.

Actor cursor snapshots are owned by autonomous card actors only. Card, processor, and card-scoped planner/executor/reviewer LLM snapshots persist under `.saivage/cards/<cardId>/runtime/actors/<kind>/<encoded-actor-id>.json`; Analyst turns use `ConversationLLMActor` and persist only their durable conversation under `.saivage/agents/conversations/<encoded-session-id>/`. The old global `.saivage/runtime/actors` cursor root is not supported current state.

The conversation log follows the encapsulation principle: it is the complete durable home for model-visible transcript rows plus runtime-significant non-model-visible rows attached to those turns. Assistant text, tool calls, tool results including file-read bodies/process stdout or stderr/webfetch bodies, model repairs, notifications delivered at safe pre-provider points, continuation-hook directives, and reviewer descendant context are transcript rows. Runtime activity rows remain durable; at minimum `activation_open` markers are persisted because compaction uses them as activation/round boundaries, while keeping them out of model-visible token-budget rows. Provider exchange metadata is not a conversation row: each settled attempt is appended by `InvocationService` as a sanitized `provider_exchange` app-log entry in `.saivage/logs/app.jsonl` containing session id, source input id, attempt index, timestamp, and the existing provider-exchange payload. Attempt identity is `(session_id, source_input_id, attempt_index)`, indexes are seeded from existing app-log entries for that source input, and duplicate identities are fatal. Raw HTTP request/response bodies are not persisted. Successful provider exchanges are written when the provider attempt settles, before the LLM actor writes assistant text or tool-call rows, so their required `assistant_output_ids` array is `[]` and is not later mutated or duplicated. App-log-backed provider exchanges are surfaced through the Raw LLM Exchange API/UI and latest-model projection, but they do not count against context-window estimates, do not trigger or reshape compaction, and generated `context_compaction` text must not include provider-exchange payload data. Reviewer currentness is checked from an in-memory snapshot of the reviewed subtree and included descendant `status.md` record versions; that snapshot is not a separate model-visible transcript row. Failed terminal repair guidance is recorded in the failed `emit_result` tool result, while notification rows for the repair turn are separate provider-input context rows. No side ledgers are kept for tool delivery or tool-call status; pending state is derived from conversation rows, and terminal-projected or abandoned settlements are written as `tool_result` rows. The only persistence-time special case is system-prompt deduplication once per session.

OpenAI `openai-responses` turns add one provider-private `provider_private` replay row plus one visible assistant text/tool-call projection row marked with `provider_projection.kind: openai_responses`. The private row stores the completed OpenAI `response.output` array unchanged, including reasoning items and `reasoning.encrypted_content`, so stateless tool continuations can replay exact prior Responses output and append local `function_call_output` tool results. Generic Chat/Codex prompts, token-budget summaries, operator conversation APIs, Raw LLM Exchange, logs, and provider exchange metadata must not expose provider-private rows, private row ids, raw `response.output`, encrypted reasoning, API keys, or tool result bodies through diagnostics. A marked visible Responses row without its paired private row, an orphan private row, duplicate pairs for a source input, or mismatched bidirectional ids is fatal malformed transcript state; unmarked assistant/tool-call rows remain valid generic history and never imply a missing private row.

The public OpenAI Responses transport sends `/v1/responses` requests with API-key authorization only, `store: false`, `include: ["reasoning.encrypted_content"]`, non-strict flat function tools, `parallel_tool_calls: false` when tools are present, and `max_output_tokens`. It never uses `previous_response_id`, provider-side stored responses, Codex backend headers, Codex OAuth profiles, or Chat Completions request fields. Responses results are successful only when the final provider status is exactly `completed`; `incomplete` due to max output maps to token-budget failure, provider-returned `cancelled` and `failed` map to provider transient failures rather than local cancellation, nonterminal terminal payloads map to provider protocol failure, and unknown/malformed statuses map to parse failure. Failed/noncompleted Responses payloads do not persist private output or visible assistant/tool projections.

Current conversation directories use `index.json`, numbered `<N>.jsonl` version files, and optional `summaries.jsonl`. Legacy v1 `seg-NNN.jsonl` conversation files are not supported current state and are rejected with other obsolete global card-agent conversation and actor-cursor roots during clean-slate boot.

Active conversation versions must not contain duplicate durable rows for the same logical message id. Rows introduced through provider-turn `turnMessages` are appended once, then consumed before tool-result, repair, or continuation-hook provider calls append only their new rows.

On each idle-path activation, the agent loads the complete active persisted conversation version from disk into provider context, appends a non-provider-visible activation marker, persists any current turn runtime-provided provider context rows such as notifications, reviewer context, or continuation directives, and then calls the provider with that loaded thread plus the newly persisted rows. During the turn, in-memory provider context and transcript persistence grow in lockstep. Recovery branches for in-flight provider calls or waiting tool calls do not construct a fresh input.

One runtime activation of a card agent is one conversation round. Compaction operates on the card-lifetime thread across these activation rounds. The only content removal anywhere is compaction-time removal of recoverable `tool_result` bodies; compaction keeps the recovery pointer so the model can re-fetch the content with `read`.

## 21. Configuration

The Analyst can reconfigure:

- model and provider routing for planner, executor, reviewer, and analyst roles;
- provider failover ordering;
- MCP server entries;
- runtime settings;
- server settings;
- agent prompts by writing replacement Markdown files under
  `.saivage/config/prompts/<cardType>/<role>.md`.

MCP server configuration supports `stdio` and `streamable-http` transports. Streamable HTTP uses the MCP Streamable HTTP request/response contract and may parse `text/event-stream` response frames; the transport configuration value is `streamable-http`.

Persisted MCP entries are desired state, not proof of an active server. MCP startup and every later convergence attempt use one serialized `reconcilePersistedConfig()` operation that freshly loads the startup-selected configuration, validates it before lifecycle mutation, and reports secret-free deterministic desired revisions, active running/stopped revisions, and pending add/remove/replace/start/stop work. Disabled or non-autostart entries have `shouldRun: false`. One reconciliation may start or stop independent servers but preflights and rejects more than one destructive remove/replace target before changing lifecycle state. Replacement contains the old per-server runtime before installing its successor: a failed old stop retains the old revision, while a failed successor leaves no old running revision and can be retried from persisted desired state. Reconciliation never rolls configuration back.

An Analyst MCP add/edit/remove writes desired state exactly once through the configuration authority and then reconciles. A converged result distinguishes `persisted: true` and `reconciled: true`; a persisted but pending result returns `persisted: true`, `reconciled: false`, the reconciliation report, and `retry_action: "mcp_reconcile"`. The `mcp_reconcile` tool performs no config mutation and is the only retry for activation drift; its result has `persisted: false`. A validation or write failure has `persisted: false` and performs no reconciliation.

Project configuration defaults to `.saivage/saivage.yaml`, but `--config` takes precedence over `SAIVAGE_CONFIG`, which takes precedence over that default. Startup resolves this choice once to an absolute path and records the winning source. Every server-side config view, Analyst mutation, and MCP initialization/reload addresses only that selected file; a missing or invalid selected file never probes or falls back to another path. Startup also snapshots the interpolation environment once, so later process-environment changes do not change effective interpolation. Mutations read the latest raw YAML inside one composition-owned FIFO queue, apply one typed change, run canonical schema and model-role validation against the startup snapshot, and atomically replace the same file. The queue waits rather than returning a write-in-progress error, and a failed turn does not poison later turns. Raw YAML placeholders, comments, and unrelated ordering survive mutation rather than interpolated credentials being serialized. Agent prompt overrides are file-level replacements in `.saivage/config/prompts/` using the same `<cardType>/<role>.md` paths as the shipped defaults; omitted files use built-in defaults. The rendered `(cardType, role)` template is the complete provider-visible system prompt for that agent slot. Before its first provider turn, every newly created conversation actor resolves its once-per-actor/session prompt identity from indexed active and frozen session-version rows, including provider reissue during recovery and an ordinary later activation. A row with that exact id but a non-`system_prompt` kind fails the turn before provider I/O. Operator and model transcript reads remain active-version-only.

Configuration changes apply to subsequent relevant work without server restart unless the specific change requires a restart. Runtime components should reevaluate dynamically changeable settings at their relevant use/admission boundaries rather than requiring restart or long-lived cached configuration. If a restart is required, the Analyst must say so and ask before restarting.

## 22. Failure Modes

If the Analyst provider is unavailable, mutation is unavailable. The system must report that the Analyst is offline and must not fall back to a keyword parser or degraded non-LLM mutation mode.

If a requested action is unsupported, the Analyst explains the limitation and may suggest the closest supported path.

If a multi-step action partially succeeds, the Analyst reports which steps succeeded, which failed, and why.

If the user confirms a destructive action after context has gone stale, the Analyst must restate and reconfirm before executing.

## 23. Acceptance Criteria

The system satisfies this specification when:

- all user-visible mutations are reachable through the Analyst and not through separate workspace controls;
- Run starts stopped work, resumes paused work, and refuses duplicate root starts while already running;
- Pause behaves as a global scheduling gate and does not mutate card/session lifecycle state;
- internal server/application disposal terminates runtime-owned running processes and is not an Analyst, UI, or HTTP control;
- exactly one active leaf does real work at a time;
- `activate_card` behaves as a synchronous logical barrier from the parent planner perspective;
- `activate_card` is valid for child cards in `backlog`, `changed`, or `blocked`, and activation transitions the child to `running`;
- main-agent child activation outcomes update the child card to `done`, `failed`, or `blocked` before the parent planner receives the tool result; runtime cancellation may instead resolve the tool result as `cancelled`;
- the Analyst cannot directly set a card to `blocked`; blocked status is produced by a card main-agent activation outcome;
- Analyst `brief.md` edits are allowed only for direct targets in `backlog`, `done`, `failed`, or `running`; backlog targets remain `backlog` without self-notification, `done`/`failed` targets become `changed`, `running` targets remain `running`, and `changed`/`blocked`/`cancelled` targets fail before writing;
- modifying a running card keeps it `running` and queues a notification to that card;
- `changed`, `blocked`, `backlog`, `running`, and `failed` descendants block parent `done` reports until handled;
- `done` and `cancelled` descendants do not block parent `done` reports;
- inactive descendant brief edits propagate changed-subtree context to `done`/`failed` ancestors and notify goal/project ancestors up to the first running ancestor or project root, with backlog targets starting propagation at the parent;
- cancellation of running work is authoritative through the current `CardActor` activation (see [Implementation Plan P3](../architecture/micro-actor-runtime-implementation-plan.md#p3-cardactor-owns-authoritative-cancellation-and-activation-id-settlement)): durable status becomes `cancelled` immediately, pending activation resolves as cancelled, activation-owned process scope is stopped, and late outcomes are dropped by the CardActor cancellation flag;
- recursive cancellation of inactive subtrees preserves already-`done` descendants;
- recursive cancellation converts `failed` and `blocked` descendants to `cancelled`;
- cancellation of a non-running card terminates attached runtime-owned processes through canonical process controls;
- card `result` reflects accepted main-agent results only, while `working_status` is a separate free field for agent usage;
- card documents are record-backed: structured card state is read through `get_card`, while `brief.md`, `status.md`, and `review.md` are versioned record slots;
- Analyst card mutations require runtime status `stopped` or `paused`, with `write` or `edit` on `record:///brief.md?card=<id>&v=next` as the supported path for updating card goal/instructions/acceptance content;
- project/goal completion rejects any executable descendant state that is not compatible with accepted completion;
- reviewer approval is invalidated if the assessed planning card or any descendant changes before approval commits;
- negative reviewer results are stored with the card and injected into planner context, while positive reviewer text is attached for recordkeeping only;
- notifications are card-addressed, ephemeral, immutable, and non-inspectable as objects;
- undelivered notifications on deleted or archived cards are no longer delivered through the active runtime;
- restart/reset of planner state is not required;
- planner sessions are planning-card-lived and resume as the same logical session when the same project or goal card is reactivated;
- process execution follows launch, monitor, bounded wait, and explicit termination semantics;
- process concurrency is unlimited by the functional specification for now;
- the Analyst can inspect, diagnose, configure, repair, navigate the workspace, and mutate supported card state through canonical services, including secret inspection when needed;
- the Analyst can drive workspace navigation and receives enough UI context to reason about what the user is seeing;
- sibling reorder is supported where allowed, but cross-parent card movement is not supported;
- archiving removes a card from active runtime state and reserves its id in `.saivage/state/deleted-card-ids.json` rather than setting an `archived` status or writing archive side files;
- UI details are governed by the operator UI specification and remain subordinate to the Analyst-as-control-surface model.
