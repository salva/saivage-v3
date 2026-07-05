# Saivage v3 System Architecture

Status: current design summary.

Last updated: 2026-06-22.

## 1. Architectural Shape

Saivage is a card-centered autonomous runtime with a conversational control surface.

The major subsystems are:

- Operator web UI: read-only workspace plus always-visible Analyst panel.
- Analyst agent: user-facing inspection and mutation orchestrator.
- Runtime supervisor: root intent, run/resume, pause mode tracking, active-work ownership, recovery coordination. Shutdown process termination is performed at the runtime/composition root (`SupervisorRuntimeApi.shutdown()` → `ProcessRunner.stopRuntimeOwned`); the supervisor actor only records stopped mode.
- Canonical card service: Analyst-owned card mutation validation, durable tree updates, audit/projection events, and active-runtime change notification.
- Card store: durable project hierarchy and card history.
- Agent sessions: planner, executor, reviewer, and analyst transcripts.
- Agent services: LLM invocation, tool dispatch, model-visible message construction, and transcript persistence.
- Process registry: durable process records, safe process read models, restart reconciliation.
- Notification queue: card-addressed ephemeral context delivery.
- HTTP/WebSocket server: authenticated projections, chat transport, and invalidate/event delivery.

## 2. Semantic Layers

Runtime is infrastructure. Operator UI and HTTP/WebSocket transport are infrastructure surfaces. Analyst is the user-facing control agent. Planner, executor, and reviewer are worker agent roles.

This distinction matters: the runtime should not be described as a peer of planner/executor/reviewer. It owns dispatch and persistence. Worker agents perform card work under runtime control. The Analyst controls the system on behalf of the user through canonical services.

The detailed micro-actor module architecture is specified in [Declarative micro-actor module architecture](./declarative-micro-actor-module.md).

## 3. Ownership Boundaries

The runtime is the only dispatcher. Agents request work through tools; they do not directly invoke other agents.

Planner/card state owns hierarchy, objectives, dependencies, evidence, status, result data, working status, and history. Runtime execution state owns root intent, command/run/activation ledgers, active-card-run state, process records, and recovery metadata.

Changing planner/card state does not by itself dispatch work. Root work starts through explicit runtime control; child work starts through parent-planner `activate_card`.

The Analyst is the global card mutation authority for user-requested changes. Analyst card mutations go through the canonical card service, which must not start autonomous work directly. Planners have local card authority only over direct children of the goal they own; they do not directly target ancestors, siblings, unrelated cards, or deeper descendants. Recursive operations such as cancelling or deleting a direct child may affect that child's subtree as a runtime consequence. Cards may be reordered among siblings where supported, but cross-parent movement is not a supported operation.

## 4. Active Work Model

At most one leaf card is doing real work at a time. The active work chain can contain multiple cards with durable status `running`, but only the leaf receives scheduling, LLM turns, or process work.

Ancestors hold activation context for their active child. That context is actor data, not a separate card state.

The runtime persists enough active-card-run and activation-ledger information to unwind one child activation outcome back to its parent planner.

Activation validation happens before dispatch. A parent planner can activate only an immediate child in `backlog`, `changed`, or `blocked`. Activation transitions the child to `running`; child main-agent `done`, `failed`, or `blocked` outcomes update the child card before the parent planner receives the activation tool result. Runtime cancellation can instead resolve the parent-visible activation as `cancelled`; processors do not emit `cancelled`. `done` cards are not activatable unless later modification changes them to `changed`; `failed` cards are not activatable and require explicit planner/operator handling such as cancellation, replacement, edit-to-`changed`, or escalation.

## 5. Agent Lifecycle

Planner sessions are goal-lived and should have deterministic identity derived from the goal card. A planner is created lazily the first time it is needed, can become inactive after reporting done, failed, or blocked, and can later be resumed by activation of the same goal as the same logical agent session.

Executor sessions are one-shot per terminal card activation.

Reviewer sessions are one-shot per assessment.

Reviewer assessment happens after runtime readiness and evidence gates pass. The reviewer receives the project card data, the assessed goal subtree, and the planner return value. Reviewer approval is valid only for the card tree snapshot it assessed. If the goal or any descendant changes before approval commits, the runtime invalidates the reviewer pass and returns the goal to planner ownership with correction/change context. Reviewer sessions must never drain the card's main-agent notification queue; notifications queued during review remain pending for planner/main-agent delivery and may invalidate reviewer success through currentness checks (P5, not yet implemented; today the reviewer non-terminal-tool continuation drains the main-agent queue — see Implementation Plan P5). Negative reviewer results are stored with the card and injected back into the planner context through the completion-return response; positive reviewer text is only attached to the card.

Analyst sessions are user-facing conversational sessions. Analyst mutations go through canonical runtime, card, config, process, and notification services.

## 6. Runtime Control Flow

Run:

1. Analyst receives a user request to run, start, continue, or resume.
2. If the runtime is paused, the runtime opens the global admission gate so waiters blocked at provider/spawn/dispatch seams proceed before new autonomous work is admitted (P4, not yet implemented; today resume only flips supervisor mode).
3. If no root run exists, the supervisor records durable running intent and creates the root runtime run.
4. If the project is already running, the supervisor returns an already-running warning and creates no duplicate root run.
5. When needed, the supervisor activates the parentless project card.

Child execution:

1. Planner calls `activate_card(child_id)`.
2. Runtime validates parent ownership and child readiness.
3. Runtime records an activation edge from parent run/tool call to child run.
4. Runtime dispatches the child to planner/executor/reviewer flow.
5. Runtime returns exactly one activation outcome to the parent planner.

Pause:

1. Pause closes the global admission gate.
2. Existing provider calls and already-running OS processes reach the next durable safe point.
3. No new LLM/provider call, runtime-owned process spawn, or card/processor dispatch is admitted while paused.
4. Completion facts from already-admitted work may persist and settle to durable boundaries while paused; any follow-up autonomous work waits at the same provider/spawn/dispatch gate before starting.
5. Running processes are not killed by pause.

Resume reopens the same gate. Existing waiters blocked at provider calls, runtime-owned process spawns, or card dispatch proceed exactly once in normal actor order without requiring a second Run, while preserving the one-active-leaf invariant. Already-admitted completions may have settled to durable boundaries while paused; the gate prevents their follow-up autonomous work from starting until resume.

Shutdown:

1. Shutdown first sets the pause gate.
2. The runtime enumerates owned running processes.
3. The runtime terminates those processes through canonical process control.
4. The runtime reports which processes terminated and which could not be terminated.

## 7. Card-Addressed Notifications

Notifications are queued on cards. The card runtime is responsible for delivering queued content to that card's main agent session.

Notification content is not a durable user-managed object. Persistence exists only to deliver it once. After delivery the platform forgets it as a queue item; delivery evidence is the receiving session transcript.

## 8. Changed-State Propagation

Analyst mutation or parent-planner mutation sets a non-active, non-terminal card to `changed`. Terminal `cancelled` cards cannot be edited or reactivated. If the modified card is already `running`, it remains `running`. In both cases the runtime queues a notification to the modified card so the card's main agent becomes aware of the change.

When a modification affects an inactive descendant, inactive ancestors on the direct path to the project root receive changed-subtree context and become `changed` until the first running ancestor. Running ancestors stay `running` and receive notification/context instead of status overwrite. In practice, deep propagation is most often needed for Analyst edits because parent-planner edits target direct children of the active goal. Ancestors are not automatically dispatched by the status change.

The acceptance gate prevents a planner from closing a goal while any executable descendant is not in a completion-compatible state. This forces the planner to observe and handle changed, blocked, backlog, running, failed, or otherwise incomplete executable descendants before claiming completion. Done and `cancelled` descendants are completion-compatible and do not block `done`.

`result` is attached from accepted main-agent results only. It is not updated from progress chatter, rejected reports, or reviewer correction requests. `working_status` is separate free text for agents attached to the card.

## 9. Cancellation

Cancellation is immediate only for inactive cards. Recursive cancellation preserves descendants that are already `done` and converts inactive non-completion-compatible descendants, including `failed`, `blocked`, `backlog`, and `changed`, to `cancelled`.

Cancelling a running card is authoritative: `CardActor.cancel()` cancels the current activation, writes `cancelled` to the card store immediately, resolves the pending activation as cancelled, stops activation-owned runtime process scope, and drops late provider/tool/process outcomes through the CardActor cancellation flag (P3, not yet implemented; today running cancel only enqueues a notification and late outcomes can still overwrite `cancelled`). Running children are cancelled through their own `CardActor.cancel()` so they are cancelled too. Shutdown remains the hard operation for forcibly stopping all runtime-owned process scopes.

Project-card cancellation is the root case of the same operation. Inactive project work is cancelled immediately; running project work is cancelled via the same activation path, which marks the card store `cancelled` immediately and rejects late outcomes.

## 10. Persistence

Durable state remains project-local. Saivage state must live under the project `.saivage/` and `.saivage-work/` directories, not under user-global state.

Startup recovery is conservative and process-first (target; P1/P2 not yet implemented — today reconcile runs after actor recovery and `reattach_state` is still written). The runtime reconciles persisted running process records before actor recovery: runtime/agent-owned process records are killed by PID/process-group or marked lost, operator-owned records are observed best-effort or marked lost, and no `reattach_state` or live process reattachment fiction is used. After process reconciliation, actor recovery projects only safe persisted terminal decisions; remaining interrupted active card work becomes explicit `blocked` outcomes with sanitized diagnostics. Recovery does not recreate in-flight provider calls, process waits, tool waits, or running card actors.

Expected persisted concerns include:

- card tree and history;
- record-backed card state, including internal structured card versions plus authored document records such as `brief.md`, `status.md`, and `review.md`;
- agent messages and manifests;
- runtime state, intent, commands, runs, and activations;
- process registry and safe process logs;
- event and error timelines;
- redacted audit/control-action records;
- pending card-addressed notifications until delivery, or until their card leaves the active runtime through deletion/archival.

## 11. API And UI Projection

HTTP routes and WebSocket frames are projection and transport surfaces. They do not define runtime semantics.

The UI fetches authoritative read models through REST and receives freshness hints through WebSocket invalidation or event frames. WebSocket does not replace REST as source of truth.

The Analyst can drive workspace navigation by asking the webapp to show a specific card, file, process, debug view, runtime view, or agent session. The UI also sends enough active view/entity/filter context for the Analyst to reason about what the user is seeing.

Internal actor state and compiled transition tables must not leak directly through operator APIs. Public responses expose Saivage read models.

## 12. Security Architecture

All protected API and WebSocket routes require authenticated access when a token is configured.

API bearer tokens are accepted in `Authorization: Bearer` headers, not URL query strings. Browser WebSocket connections use short-lived one-use tickets rather than bearer tokens in URLs.

The Analyst may inspect secrets when the authenticated user request requires it. UI projections and logs may redact secrets by default, but that redaction is a display/output policy rather than a limit on Analyst authority.

File inspection and process output are filtered through containment, binary/size checks, and safe command rendering. Secret display should be deliberate and minimized, not categorically unavailable to the Analyst.

Provider diagnostics, account details, runtime internals, and raw error metadata must not be injected into planner, executor, reviewer, or analyst model context merely because they exist. Agent-visible context is deliberately constructed: include actionable recovery information when needed, sanitize diagnostic detail, and preserve raw data in logs or projections with appropriate access controls.

## 13. Implementation Direction

The runtime implementation direction is micro-actor-centered: actor states, submitted jobs, and pending internal events drive behavior, not imperative orchestration loops. The micro-actor module contract, delivery model, and persistence boundary are defined in [Declarative micro-actor module architecture](./declarative-micro-actor-module.md). The target runtime design is defined in [Micro-Actor Runtime Design](./micro-actor-runtime-design.md).

Target actor ownership:

- `CardActor`s own direct child `CardActor` instances and the associated processor actor for that card type;
- `BaseCardProcessorActor` owns shared processor mechanics: activation, settlement, outcome reporting to the owning `CardActor`, and processor snapshot mechanics. It has no cancellation API; running cancellation is owned by `CardActor` (see P3);
- `BaseMainLLMCardProcessorActor` owns shared main-agent LLM loop mechanics and per-turn notification delivery without role-specific policy;
- `PlanningCardProcessorActor` owns project/goal planner and reviewer semantics;
- `TerminalCardProcessorActor` owns executor semantics for terminal cards; it constructs card-scoped capabilities and does not own child cards.

Process execution follows a launch-and-monitor model through the process runner, process registry, and process tool provider. Agents launch project commands, inspect status/logs over time, use bounded waits for completion, and explicitly terminate processes when needed. The functional specification does not impose process concurrency limits for now.

Controllers that advance runtime behavior are disallowed by default. A retained `RuntimeApi` may accept commands, call actor public methods, wait on projections, and project read models; it must not execute workflow logic itself.
