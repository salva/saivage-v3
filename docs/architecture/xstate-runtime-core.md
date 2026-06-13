# XState Runtime Core Architecture

Status: current runtime-core implementation architecture.

Last updated: 2026-06-12.

## 1. Purpose

This document defines how the Saivage v3 autonomous runtime core is implemented on top of XState. It rescues the useful parts of the prior runtime-core plans while aligning them with the current functional specifications:

- [System functional specification](../spec/system-specification.md)
- [Operator UI specification](../spec/operator-ui.md)
- [System architecture](./system-architecture.md)

This document is implementation architecture, not a second product contract. If it conflicts with the functional specs, the specs win and this document must be updated.

## 2. Design Directive

XState is load-bearing infrastructure for the runtime core. Runtime behavior is driven by machine states, typed events, invoked services, and owned actors. It is not driven by imperative orchestration loops that call `start()`, `runTurn()`, `activateChild()`, `review()`, or `wait()` methods while XState snapshots are attached afterward.

The runtime must stay simple:

- no custom command bus around XState;
- no event-sourcing layer;
- no generic workflow framework;
- no detached actor islands used to emulate parent-child behavior;
- no compatibility path for discarded runtime state shapes, discarded run-ledger shapes, or discarded orchestration contracts;
- no generic actor registry unless the first direct actor tree proves it is needed.

Use the smallest machines that make invalid states hard to represent. A machine state should normally be a durable wait point, cancellation boundary, recovery boundary, or externally meaningful lifecycle phase. Synchronous card-store writes can be machine actions unless they need retry or recovery semantics.

## 3. Core Invariants

The implementation must preserve these functional invariants:

- The runtime is the only dispatcher.
- The Analyst is the user-facing mutation surface; UI mutation controls remain projection-only except authentication/bootstrap.
- At most one leaf card does real work at a time.
- A running chain may contain several `running` cards, but only the leaf receives scheduling, LLM turns, or process work.
- Parent planners activate only immediate children through `activate_card`.
- `activate_card` is a synchronous logical barrier from the parent planner perspective.
- Activatable child statuses are `backlog`, `changed`, `blocked`, and `failed`.
- Activating a child transitions it to `running`.
- `done` cards are not activatable unless later modification changes them to `changed`.
- Child activation outcomes update the child card to `done`, `failed`, or `blocked` before the parent receives the tool result.
- The Analyst cannot directly set a card to `blocked`; `blocked` is a main-agent activation outcome.
- Only `done` and `cancelled` descendants are completion-compatible for parent `done`.
- `changed`, `blocked`, `backlog`, `running`, and `failed` descendants block parent `done` until handled.
- `working_status` is free text for agents attached to the card.
- `result` is attached only from accepted main-agent results.
- Reviewer-negative results are stored with the card and injected into the planner context; positive reviewer text is only attached to the card.
- Notifications are card-addressed, immutable, ephemeral delivery items, not user-managed note objects.
- Run starts idle work or resumes paused work; duplicate Run returns an already-running warning.
- Pause is a scheduling gate and does not mutate card/session/process state.
- Shutdown pauses first, then terminates runtime-owned running processes.
- Process handling uses launch, inspect, bounded wait, and explicit termination; wait timeout does not kill the process.
- Configuration changes apply to future relevant work. Runtime components should read dynamically changeable settings at their relevant use/admission boundary rather than caching them indefinitely. In-flight LLM/provider calls keep the provider/configuration they were admitted with; later LLM/provider calls read the latest effective configuration at admission time.
- Operator APIs and UI expose Saivage read models, never raw XState snapshots.

## 4. Actor Tree

The runtime actor tree has one root supervisor actor. The supervisor owns the parentless project `CardNodeActor`. `CardNodeActor`s are the durable card status/projection boundary. Each node delegates type-specific behavior to a `CardInternalActor`, and project/goal internal actors own their child `CardNodeActor` references. Planner and executor `LLMActor`s own the LLM/tool loop for one card activation.

```mermaid
graph TD
  api[RuntimeApi adapter] --> supervisor[Supervisor actor]
  supervisor --> projectNode

  projectNode[Project CardNodeActor] --> projectInternal[Project CardInternalActor]
  projectInternal --> projectChildren[children array]
  projectChildren --> goalNode[Goal CardNodeActor]

  goalNode --> goalInternal[Goal CardInternalActor]
  goalInternal --> goalChildren[children array]
  goalChildren --> terminalNode[Terminal CardNodeActor]

  terminalNode --> terminalInternal[Terminal CardInternalActor]

  projectInternal --> projectActivate[activate_card tool-handler actor]
  projectInternal --> projectTools[other tool-handler actors]
  projectInternal --> projectLlm[Planner LLMActor]
  goalInternal --> goalActivate[activate_card tool-handler actor]
  goalInternal --> goalTools[other tool-handler actors]
  goalInternal --> goalLlm[Planner LLMActor]
  terminalInternal --> terminalTools[terminal tool-handler actors]
  terminalInternal --> terminalLlm[Executor LLMActor]

  projectTools --> projectProcess[Process actors]
  goalTools --> goalProcess[Process actors]
  terminalTools --> terminalProcess[Process actors]

  projectInternal -. provide registry .-> projectLlm
  projectLlm -. LLM returns activate_card .-> projectLlm
  projectLlm -. invoke handler .-> projectActivate
  projectActivate -. route to child .-> goalNode
  goalNode -. delegate to internal .-> goalInternal
  goalInternal -. provide registry .-> goalLlm
  goalLlm -. LLM returns activate_card .-> goalLlm
  goalLlm -. invoke handler .-> goalActivate
  goalActivate -. route to child .-> terminalNode
  terminalNode -. delegate to internal .-> terminalInternal
  terminalInternal -. provide registry .-> terminalLlm

  classDef nodeActor fill:#e8f1ff,stroke:#2f5fa8,stroke-width:2px,color:#14213d
  classDef internalActor fill:#fff4df,stroke:#b36b00,stroke-width:2px,color:#3a2300
  classDef llmActor fill:#f7e9ff,stroke:#7a2fa8,stroke-width:2px,color:#24113a
  classDef toolHandler fill:#fff9d8,stroke:#9a7a00,stroke-width:2px,color:#332600
  classDef resourceActor fill:#e9f8ef,stroke:#287a42,stroke-width:2px,color:#0f2a18
  classDef support fill:#f2f2f2,stroke:#777,stroke-width:1px,color:#222

  class projectNode,goalNode,terminalNode nodeActor
  class projectInternal,goalInternal,terminalInternal internalActor
  class projectLlm,goalLlm,terminalLlm llmActor
  class projectActivate,projectTools,goalActivate,goalTools,terminalTools toolHandler
  class projectProcess,goalProcess,terminalProcess resourceActor
  class api,supervisor,projectChildren,goalChildren support
```

The diagram shows one representative branch. Solid arrows show actor ownership. Dotted arrows show registry handoff and a sample `activate_card` invocation chain from an LLM response inside its owning planner `LLMActor`, through the registered `activate_card` tool-handler actor constructed by the parent `CardInternalActor`, to the selected child `CardNodeActor`. Blue nodes are `CardNodeActor`s, orange nodes are type-specific `CardInternalActor`s, purple nodes are planner/executor `LLMActor`s, yellow nodes are tool-handler actors, and green nodes are process/resource actors. Project and goal internal actors own a `children` array of child-node references, while terminal internal actors are leaves. `CardInternalActor`s construct and own the card-scoped tool-handler actors; `LLMActor`s own LLM/provider calls, the ReAct loop, the passed tool-handler actor registry, and tool-result context.

Actor ownership:

- The supervisor actor owns runtime mode, root run intent, pause gate, shutdown, the parentless project `CardNodeActor`, and recovery coordination.
- `CardNodeActor`s own durable card identity, public card status projection, and the type-specific `CardInternalActor` for that card.
- Project and goal `CardInternalActor`s own child-node references, child activation authority, readiness/review gates, planning diary updates, and construction of card-scoped tool-handler actors.
- Terminal `CardInternalActor`s own terminal-card semantic execution and construction of terminal tool-handler actors for one activation; they do not own children.
- Planner and executor `LLMActor`s own LLM/provider calls, tool-call loop states, the passed tool-handler actor registry, tool-result waits, turn budgets, provider admission/cancellation, and tool-result context passed into later LLM calls.
- Tool-handler actors own one tool's execution semantics and may own or address process actors when that tool requires process work.
- Process actors own OS process lifecycle, process status, waits, termination, and safe log read models.

Child card activations are invoked through a registered `activate_card` tool-handler actor constructed by the owning `CardInternalActor` because `activate_card` needs exactly one completion or failure outcome delivered to the waiting parent planner under the single-active-leaf model. The planner `LLMActor` owns the tool-call loop and invokes the handler from its tool registry; it does not own child references. Longer-lived owned resources such as process actors may be spawned by registered tool-handler actors when their lifecycle outlives one tool call. If Saivage later lifts the single-active-leaf model, child activation ownership can be reconsidered. Actor-to-actor runtime behavior flows through XState events, actor completion, and typed outputs. Event/timeline infrastructure may publish projections and audit records, but it must not become an internal workflow bus.

LLM actors never own card hierarchy traversal. An LLM/provider response may contain a typed tool-call request such as `activate_card`; the planner `LLMActor` receives that request, looks up `activate_card` in its tool-handler actor registry, and invokes the registered handler actor. For `activate_card`, the handler actor is constructed by the owning `CardInternalActor`, which validates and routes to the appropriate immediate child `CardNodeActor` from its owned children. This keeps child node actors as children of their parent card's internal actor, not children of LLM actors.

The dynamic call sequence for `activate_card(child_id)` is:

```mermaid
sequenceDiagram
  participant ParentInternal as Parent CardInternalActor
  participant PlannerLlm as Planner LLMActor
  participant ActivateHandler as activate_card tool-handler actor
  participant ChildNode as Child CardNodeActor
  participant ChildInternal as Child CardInternalActor

  activate ParentInternal
  ParentInternal->>ActivateHandler: construct with child refs and authority
  ParentInternal->>+PlannerLlm: invoke planner LLM actor
  ParentInternal->>PlannerLlm: provide tool-handler actor registry
  PlannerLlm->>PlannerLlm: call LLM provider
  PlannerLlm->>PlannerLlm: receive tool request activate_card child_id
  PlannerLlm->>+ActivateHandler: invoke activate_card handler
  ActivateHandler->>ActivateHandler: validate immediate child and activatable status
  ActivateHandler->>+ChildNode: activate child
  ChildNode->>ChildNode: commit status running
  ChildNode->>+ChildInternal: delegate active work
  ChildInternal-->>-ChildNode: outcome done failed or blocked
  ChildNode->>ChildNode: commit durable outcome
  ChildNode-->>-ActivateHandler: activation result
  ActivateHandler-->>-PlannerLlm: return activate_card tool result
  PlannerLlm->>PlannerLlm: call LLM provider with tool result
  PlannerLlm->>PlannerLlm: receive assistant message or next tool request
  PlannerLlm-->>-ParentInternal: final planner outcome or correction request
  deactivate ParentInternal
```

The `activate_card(child_id)` request is a message returned by an LLM/provider call inside the planner `LLMActor`. It is not a recursive call into the parent. The planner LLM actor owns the ReAct loop, resolves `activate_card` through its tool-handler actor registry, and invokes the handler actor constructed by the parent `CardInternalActor`. The tool-handler actor owns the activation barrier while the child runs, then returns the child result to the planner LLM actor as the tool result. The planner LLM actor makes a later LLM/provider call with that result as tool-result context. The child `CardNodeActor` owns durable status transitions, and the child `CardInternalActor` owns type-specific planner or executor work. The LLM actor does not hold child references or drive descendant workflow directly.

## 5. RuntimeApi Boundary

`RuntimeApi` is the only production wrapper around the actor tree. It is an adapter for external callers such as HTTP routes, CLI commands, the Analyst service, and application composition.

The Analyst is not part of the autonomous runtime actor tree. Analyst sessions are user-facing agent sessions that inspect projections and call canonical services. Analyst tools translate user intent into runtime, card, notification, process, and configuration operations; lifecycle operations enter the runtime actor tree as typed events through `RuntimeApi`, while card mutations go through the canonical card service.

The canonical card service owns Analyst-initiated card create, edit, reorder, archive, delete, and non-running cancellation requests. It validates authority and destructive-action confirmation, mutates the durable card tree, emits audit/projection events, and sends typed change/cancellation notifications to affected active runtime actors. It must not start autonomous work directly.

Allowed responsibilities:

- construct or attach to the supervisor actor;
- send accepted commands as supervisor events;
- reject commands that are invalid before they enter the actor tree;
- optionally wait for a state condition by subscribing to actor snapshots;
- project supervisor/card/session/process snapshots into Saivage read models.

Forbidden responsibilities:

- instantiate goal, terminal, LLM, reviewer, child-activation, or process workflow actors directly;
- call workflow methods such as `start()`, `cancel()`, `runTurn()`, `activateChild()`, or `wait()` on runtime objects;
- synthesize child activation completion outside the actor tree;
- expose raw XState snapshots over public APIs;
- preserve discarded orchestration behavior to satisfy discarded tests.

If a public method needs completion-return semantics, it sends an event and waits by observing actor state. It must not run the workflow itself.

## 6. Supervisor Machine

The supervisor machine owns runtime-level control. Minimal states:

- `idle`: no root actor is running.
- `running`: the root project `CardNodeActor` exists and the pause gate is open.
- `paused`: the root project `CardNodeActor` may exist, but no new LLM/provider calls are admitted.
- `shutting_down`: pause gate is closed and runtime-owned processes are being terminated.
- `failed`: unrecoverable supervisor-level failure, if needed.

Primary events:

- `RUN_REQUESTED`
- `PAUSE_REQUESTED`
- `SHUTDOWN_REQUESTED`
- `PROJECT_ACTOR_DONE`
- `PROJECT_ACTOR_FAILED`
- `PROJECT_ACTOR_BLOCKED`
- `RUNNING_WORK_CANCEL_REQUESTED`
- `PROCESS_TERMINATION_REPORTED`
- `RECOVERY_RECONCILED`

Responsibilities:

- Run starts the parentless project `CardNodeActor` when idle. The project node delegates admitted work to its project `CardInternalActor`.
- Run from `paused` lifts the pause gate.
- Run from `running` returns an already-running warning and creates no duplicate root run.
- Pause blocks new LLM/provider-call admission without killing running processes or mutating card status.
- Shutdown first pauses, then sends termination events to runtime-owned running process actors and reports results.
- `RUNNING_WORK_CANCEL_REQUESTED` coordinates cancellation only when the target is running or contains the active leaf. Non-running card/subtree cancellation is handled by the canonical card service.
- Supervisor recovery rebuilds safe actor state or records diagnostics for abandoned unsafe state.

The supervisor should not know planner/executor logic. It coordinates root lifecycle and owns the top of the actor tree.

## 7. Goal CardInternalActor Machine

The goal `CardInternalActor` machine handles card-level semantics for regular goal cards and the parentless project card. It is private runtime state, not the public card lifecycle. Durable card status remains the fixed card-store state set (`backlog`, `running`, `changed`, `done`, `failed`, `blocked`, `cancelled`) and is exposed through projections. The card internal actor must not own the LLM/tool-call loop. It constructs card-scoped tool-handler actors such as child activation, direct-child mutation, process-tool access, and working-status updates, then invokes a planner `LLMActor` with that registry.

Minimal externally meaningful phases:

- `running_planner_llm`: the planner `LLMActor` is active with its card-scoped tool-handler actor registry. The internal actor may be called by registered handlers such as `activate_card`, but it does not model tool-call states itself.
- `checking_readiness`: runtime completion gates are being evaluated. This is intentionally a named local phase so readiness diagnostics and recovery boundaries are visible; it can be collapsed to guards later without changing the product contract if it proves trivial.
- `reviewing`: reviewer assessment is active.
- `returning_outcome`: accepted `done`, `failed`, or `blocked` result is being returned to the owning `CardNodeActor` for durable status/result bookkeeping.

Non-active cards do not need an active internal execution phase. Public statuses such as `done`, `failed`, `blocked`, `cancelled`, and `changed` are durable card-store statuses, not goal `CardInternalActor` phases.

Planner LLM tool-handler handling:

- `activate_card(child_id)` is emitted by an LLM/provider response as a typed tool-call request, handled by the planner `LLMActor` tool loop, resolved from the LLM actor's tool-handler registry, and implemented by a handler actor constructed by the owning goal `CardInternalActor`. The planner LLM actor does not own child card references.
- Activation validates responsible parent planner, immediate-child relationship, and child status in `backlog`, `changed`, `blocked`, or `failed`.
- Activation transitions the child card to `running`, then the child `CardNodeActor` delegates active behavior to its appropriate `CardInternalActor`.
- Child actor completion returns exactly one typed outcome: `done`, `failed`, or `blocked`.
- The child `CardNodeActor` commits the matching durable status before the planner LLM actor receives the tool result.
- Process tools are requested through the planner LLM actor tool loop and resolved through registered handler actors. Process lifecycle remains owned by process actors, while the registered handler carries only the card-scoped authority and containment context needed to create or address them.
- Card create/edit/reorder/cancel tools are requested through the planner LLM actor tool loop, resolved through registered handler actors, and limited to direct children. Created children enter the tree in `backlog` unless the card API defines a stricter initial status. Recursive cancellation effects belong to runtime semantics, not planner authority over grandchildren.

Completion handling:

- Planner `done` reports go through readiness gates before review.
- Readiness rejects any executable descendant that is not completion-compatible.
- Required evidence references are validated before review. Evidence validation verifies that referenced evidence belongs to the assessed subtree or project context, still exists in the active card representation, and points to durable card result data, artifacts, attachments, process records, or file evidence that the reviewer can inspect.
- Reviewer assessment happens after readiness/evidence gates.
- If the reviewer requests corrections, the goal invokes or resumes planner LLM ownership inside the same activation barrier.
- If the goal or any descendant changes before reviewer approval commits, the review pass is invalidated.
- Reviewer-negative text is stored as a specialized result and injected into planner context.
- Reviewer-positive text is attached for recordkeeping only.

Changed handling:

- `changed` is durable card status, not a long-running actor phase. A changed non-active goal is dormant until the responsible parent planner or Analyst action changes it again or the parent planner reactivates it.
- Activating a `changed` card transitions it to `running`, clearing the durable `changed` status.
- A goal cannot report `done` while any executable descendant remains `changed`.
- Change notifications and changed-subtree context are delivered when the goal actor next accepts context.

Planning diary:

- Planning diary state lives on goal/project card fields.
- Do not reintroduce a separate plan-card type.

Planner session lifecycle:

- Planner sessions use deterministic identity derived from the goal card.
- A planner LLM session is created lazily the first time the goal needs LLM work.
- The same logical planner LLM session receives repeated activation requests over that goal's lifetime.
- When reactivated after `changed` or `blocked`, the planner LLM actor resumes with prior session context plus new runtime-provided activation, notification, correction, and changed-subtree context.

Reviewer turn input:

- Reviewer LLM input includes the project card data, the assessed goal subtree, and the planner return value for that completion attempt.
- Reviewer-negative results include assessment details, cited evidence, and correction context for the next planner LLM call.

## 8. Terminal CardInternalActor Machine

The terminal `CardInternalActor` machine handles terminal-card semantics for terminal task cards. It is private runtime state, not the public card lifecycle. It constructs terminal tool-handler actors, invokes one executor `LLMActor` with that registry, and returns that LLM actor's accepted outcome to the owning `CardNodeActor`. It must not model executor tool-call states itself.

Minimal phases:

- `executing_llm`: the executor `LLMActor` is active and owns the LLM/tool loop.
- `returning_outcome`: accepted `done`, `failed`, or `blocked` result is being returned to the owning `CardNodeActor` for durable status/result bookkeeping.

Non-active terminal cards do not need an active internal execution phase. Public statuses such as `done`, `failed`, `blocked`, `cancelled`, and `changed` are durable card-store statuses, not terminal `CardInternalActor` phases.

Responsibilities:

- Construct card-scoped tool-handler actors and invoke one executor `LLMActor` with their registry for the terminal activation.
- Provide containment context through the registered tool-handler actors.
- Keep executor tool-call states inside the executor LLM actor, not this card internal actor.
- Update `working_status` only through LLM-visible write paths.
- Return `result` only after an accepted executor outcome; the owning `CardNodeActor` attaches it durably.
- Preserve raw diagnostics in logs/read models, not in unsanitized model context.
- Treat `changed` as durable card status, not a long-running actor phase. A changed non-active terminal card waits in the card store until the responsible parent planner or Analyst action changes it again or the parent planner reactivates it.
- On cancellation request while active, deliver cancellation context and let the executor voluntarily stop and report `failed`. `cancelled` is a runtime-applied card status, not a parent-visible activation outcome.

The executor LLM actor should enforce a turn budget through machine context and events, not through an external `for` loop.

## 9. LLMActor Machine

Planner and executor `LLMActor`s own the LLM/tool-call loop for one card activation. They are LLM-session actors, not durable card actors. A card internal actor constructs tool-handler actors, invokes an LLM actor, and passes a dictionary from tool name to tool-handler actor. The LLM actor calls the provider, resolves tool calls by name from that registry, invokes the matching handler actor, and feeds tool results into later provider calls until it returns an accepted card-level result or fails.

Minimal phases:

- `thinking`: one LLM/provider call is active, or the agent is ready to start the next call with new context.
- `running_tool`: exactly one requested tool is being handled by the registered tool-handler actor for that tool name.
- `applying_tool_result`: the tool result is being appended to agent context for the next LLM/provider call; this can be collapsed into actions if trivial.
- `returning_outcome`: the agent has accepted an outcome and is returning it to the owning card internal actor.
- `failed`: provider, protocol, tool, or budget failure that should become a failed card-level outcome unless the owning card internal actor handles it differently.

Responsibilities:

- Make one LLM/provider call at a time.
- Admit each provider call at its use boundary and retain that call's provider/configuration until it returns or is cancelled.
- Interpret LLM outputs as either one tool request or one accepted outcome.
- Resolve tool requests by name from a tool-handler actor registry supplied when the LLM actor is invoked.
- Reject unsupported multiple-tool-call output in the first implementation pass.
- Invoke exactly one registered tool-handler actor at a time and wait for its returned tool result.
- Treat unknown tool names as protocol failures.
- Require card-scoped tools such as `activate_card` to be registered by the owning `CardInternalActor`.
- Store tool results in LLM-session context for the next LLM/provider call.
- Enforce turn budgets and protocol limits.
- Own provider-call cancellation and sanitized provider failure handling.
- Preserve raw diagnostics in logs/read models, not in unsanitized model context.

`LLMActor` states may mention tool calls. `CardInternalActor` states should not, except for constructing tool-handler actors and invoking the LLM actor with the appropriate registry.

## 10. Process Machine

The process machine owns one OS process lifecycle.

Minimal phases:

- `starting`
- `running`
- `waiting`
- `killing`
- `exited`
- `failed`
- `abandoned`, if recovery cannot safely reattach or terminate

Responsibilities:

- Launch project commands in a contained working directory.
- Publish safe process read models: status, timestamps, rendered command, working directory, logs, and termination availability.
- Implement bounded waits. A wait timeout returns control to the calling `LLMActor` tool loop and does not kill the process.
- Handle explicit termination from Analyst, card cancellation, or Shutdown.
- On cancellation, terminate gracefully when possible, then force-kill or record an abandoned diagnostic when needed.
- Reconcile persisted running process state during startup recovery.

The functional spec imposes no process concurrency limit for now.

## 11. Card Changes And Notifications

Card changes enter the runtime as events. Direct store mutation without actor notification is not part of the active runtime path.

Change behavior:

- Non-running edited cards become `changed`.
- Running edited cards remain `running`.
- Every edit queues a card-addressed notification for the modified card.
- Inactive ancestors on the path to the project root become `changed` until the first running ancestor.
- Running ancestors receive notification/context instead of status overwrite.
- Creating a new backlog child marks the parent/ancestor chain changed as needed.

Notification behavior:

- Notifications are queued to cards, not roles.
- Role phrasing from the user is resolved by the Analyst to the relevant card before runtime queueing.
- The card runtime delivers pending notifications to that card's main agent session when it is active and can accept context, or to the next future main agent session if one starts.
- Notifications are immutable and forgotten as queue items after delivery.
- Undelivered notifications on deleted/archived cards remain with that card representation and are no longer delivered through the active runtime.
- There is no notification inbox, list/get/edit/delete/acknowledge API, or bulk-management UI.

## 12. Cancellation And Quiescence

Pause and cancellation are separate.

- Pause is a scheduling gate. It blocks new LLM/provider-call admission and leaves card/session/process state unchanged.
- Cancellation changes work intent for a card/subtree.
- Shutdown is pause plus process termination.

Inactive cancellation:

- A card that is not `running` can be cancelled directly.
- Recursive cancellation preserves already-`done` descendants.
- Recursive cancellation converts non-completion-compatible descendants, including `failed` and `blocked`, to `cancelled`.
- Runtime-owned processes attached to non-running cancelled cards are terminated through process actors.

Running cancellation:

- The runtime queues cancellation-request notifications to the requested card and active downstream cards.
- Active agents stop at safe points and report `failed` through their normal activation outcome path.
- The runtime marks the cancelled requested card/subtree status as `cancelled` as part of fulfilling the cancellation request; `cancelled` is not a parent-visible activation outcome.
- Failed outcomes unwind through normal activation barriers so parent planners can handle the interrupted work in context.
- The runtime should reach a bounded quiescent state or report that unsafe work was abandoned.

Do not add a separate user-facing Abort operation. Cancel is the required operation.

## 13. Persistence And Recovery

Persist state at meaningful machine boundaries. Do not persist snapshots merely to mirror imperative code after it already ran.

When persisting actor state, prefer XState persisted snapshots plus Saivage metadata needed for actor identity, projection, and recovery classification. Do not expose persisted XState snapshots as public read models.

Card-store writes that must commit before the state changes are invoked services with explicit success/failure transitions. Purely synchronous writes may be machine actions only when a write failure can safely fail the transition loudly rather than leaving the machine in a misleading externally visible state.

Persisted concerns:

- card tree and versioned card fields;
- agent messages and manifests;
- runtime state, root intent, command records, runs, and activation edges;
- meaningful actor state and minimal context required for recovery classification;
- process registry and safe logs;
- event/error/control-action timelines;
- pending card-addressed notifications until delivery, or until their card leaves the active runtime through deletion/archival.

Every persisted actor state should have one recovery classification before implementation:

- `resume_safe`: rebuild and continue;
- `reconcile_then_resume`: inspect card/process state before continuing;
- `abandon_with_diagnostic`: cannot safely resume; write a diagnostic and reconcile card/process state;
- `terminal`: no recovery work needed.

Examples:

- A process actor in `running` may be `reconcile_then_resume` if the OS process can be found.
- A provider call in progress at crash time is usually `abandon_with_diagnostic` because the external request cannot be safely reattached.
- A planner `LLMActor` waiting on a registered activation tool-handler actor is `reconcile_then_resume` if the child actor and durable card state can be rebuilt.
- A committed `done`, `failed`, `blocked`, or `cancelled` actor state is `terminal`.

## 14. Projections And Events

Internal XState snapshots are not public API.

Projection responsibilities:

- build card read models with status, `working_status`, `result`, specialized results, and field history availability;
- expose runtime mode, pause gate, active chain, command outcomes, process records, agent sessions, timeline, and errors;
- emit WebSocket/event freshness hints without making WebSocket the source of truth;
- let the Analyst drive workspace navigation by projecting route/view changes to the UI;
- keep secret redaction as output/display policy, not Analyst authority limitation.

Event/timeline mechanisms may carry projection updates and audit records. They must not coordinate internal runtime workflow.

## 15. File And Module Shape

Prefer machine and actor files over controller classes:

- `src/runtime/actors/supervisor.machine.ts`
- `src/runtime/actors/supervisor.actor.ts`
- `src/runtime/actors/supervisor.projection.ts`
- `src/runtime/actors/card-node.machine.ts`
- `src/runtime/actors/card-node.actor.ts`
- `src/runtime/actors/goal-card-internal.machine.ts`
- `src/runtime/actors/goal-card-internal.actor.ts`
- `src/runtime/actors/terminal-card-internal.machine.ts`
- `src/runtime/actors/terminal-card-internal.actor.ts`
- `src/runtime/actors/planner-llm.machine.ts`
- `src/runtime/actors/planner-llm.actor.ts`
- `src/runtime/actors/executor-llm.machine.ts`
- `src/runtime/actors/executor-llm.actor.ts`
- `src/runtime/actors/tool-handlers/*.actor.ts`
- `src/runtime/actors/process.machine.ts`
- `src/runtime/actors/process.actor.ts`

Avoid controller classes by default. A class or module is suspect if it owns loops, branching, or methods that advance runtime workflow. Keep wrappers only at real external boundaries.

## 16. Testing Strategy

Do not preserve orchestration-heavy tests solely because they are familiar. Prefer smaller tests that protect the new architecture.

Required test groups:

- direct machine transition tests for supervisor Run/Pause/Shutdown;
- goal `CardInternalActor` machine tests for registered child activation handler success/failure/blocked, invalid activation, changed handling, readiness rejection, reviewer pass/correction/invalidation;
- terminal `CardInternalActor` machine tests proving it constructs tool-handler actors, invokes the executor LLM actor, returns accepted outcomes, and does not own tool-loop states;
- planner/executor `LLMActor` machine tests for provider admission before each LLM call, provider cancellation, provider failure, one-tool-at-a-time loops, tool-handler actor invocation, tool-result context delivery to the next LLM call, unsupported multiple tool calls, tool failure handling, turn budget exhaustion, and accepted outcomes;
- process machine tests for launch, wait timeout without kill, inspect, terminate, failure, and abandoned recovery;
- RuntimeApi boundary tests proving it sends events and projects read models but does not instantiate/call card/LLM/process workflow actors;
- API/projection tests proving public responses expose Saivage read models, not raw XState snapshots;
- UI smoke tests when projection contracts change.

## 17. Implementation Sequence

### P0: Actor Contracts And RuntimeApi Boundary

- Define typed events and outputs for supervisor, `CardNodeActor`, goal `CardInternalActor`, terminal `CardInternalActor`, planner/executor `LLMActor`s, tool-handler actors, and process actors.
- Collapse `RuntimeApi` into event sender, snapshot waiter, and projection adapter.
- Add boundary tests proving runtime behavior cannot advance through wrapper-owned orchestration methods.
- Define the permanent module ownership map: actor/machine modules own workflow, projection modules own read models, canonical services own validated external requests, and no additional layer owns autonomous work sequencing.

P0 is complete when runtime workflow cannot advance except through supervisor events, `CardNodeActor` events, `CardInternalActor`-constructed tool-handler actors, `LLMActor` events, invoked services, child-card activation barriers, spawned resource actors, and machine transitions.

### P1: Supervisor Machine

- Implement Run/Pause/Shutdown.
- Own parentless project `CardNodeActor` creation.
- Enforce duplicate Run warning.
- Gate LLM admission while paused.
- Terminate process actors during Shutdown.
- Project supervisor status into read models.

### P2: LLMActor Provider Calls

- Implement provider admission, provider invocation, typed outputs, cancellation, provider failure, and unsupported output inside planner/executor `LLMActor`s.
- Fail fast on multiple tool calls unless a later explicit protocol supports them.

### P3: Process Machine And LLM Loop Machines

- Implement process lifecycle first if terminal tools need it.
- Implement planner/executor `LLMActor` LLM/tool loops with one tool result fed into the next LLM call.
- Implement process-tool handling through registered tool-handler actors and process actor events.

### P4: CardInternalActor Machines

- Implement terminal `CardInternalActor` as tool-handler actor construction, executor LLM invocation, and accepted outcome handling.
- Implement goal `CardInternalActor` child activation tool-handler actors, planner LLM invocation, readiness gates, reviewer turns, reviewer corrections, and returned outcomes for the owning `CardNodeActor` to commit.
- Keep planning diary on goal/project card fields.
- Do not reintroduce plan cards.

### P5: Changed Propagation, Notifications, And Cancellation

- Implement card edit events, changed propagation, notification delivery, and cancellation request delivery.
- Implement direct inactive cancellation and collaborative running cancellation.

### P6: Projections, Analyst, And UI Integration

- Wire Analyst tools to canonical services backed by the actor tree.
- Ensure UI remains read-only for Analyst-owned mutations.
- Project cards, active chain, sessions, processes, timeline, errors, and navigation context.

### P7: Startup Recovery

- Classify recovery behavior for every persisted actor state.
- Rebuild safe actor state on startup.
- Reconcile card/process state before admitting new LLM/provider calls.
- Emit diagnostics for abandoned unsafe work.

Do not begin broad goal/terminal rewrites before P0/P1 make the supervisor boundary stable.
