# Saivage v3 System Architecture

Status: current design summary.

Last updated: 2026-06-12.

## 1. Architectural Shape

Saivage is a card-centered autonomous runtime with a conversational control surface.

The major subsystems are:

- Operator web UI: read-only workspace plus always-visible Analyst panel.
- Analyst agent: user-facing inspection and mutation orchestrator.
- Runtime supervisor: root intent, run/resume, pause, shutdown, active-work ownership, recovery coordination.
- Card store: durable project hierarchy and card history.
- Agent sessions: planner, executor, reviewer, and analyst transcripts.
- Agent adapter: LLM invocation, tool dispatch, model-visible message construction, and transcript persistence.
- Process registry: durable process records, safe process read models, restart reconciliation.
- Notification queue: card-addressed ephemeral context delivery.
- HTTP/WebSocket server: authenticated projections, chat transport, and invalidate/event delivery.

## 2. Semantic Layers

Runtime is infrastructure. Operator UI and HTTP/WebSocket transport are infrastructure surfaces. Analyst is the user-facing control agent. Planner, executor, and reviewer are worker agent roles.

This distinction matters: the runtime should not be described as a peer of planner/executor/reviewer. It owns dispatch and persistence. Worker agents perform card work under runtime control. The Analyst controls the system on behalf of the user through canonical services.

## 3. Ownership Boundaries

The runtime is the only dispatcher. Agents request work through tools; they do not directly invoke other agents.

Planner/card state owns hierarchy, objectives, dependencies, evidence, status, and history. Runtime execution state owns root intent, command/run/activation ledgers, active-card-run state, process records, and recovery metadata.

Changing planner/card state does not by itself dispatch work. Root work starts through explicit runtime control; child work starts through parent-planner `activate_card`.

## 4. Active Work Model

At most one leaf card is doing real work at a time. The active work chain can contain multiple cards with durable status `running`, but only the leaf receives scheduling, LLM turns, or process work.

Ancestors are waiting for their active child. Their runner/session lifecycle state is `AwaitingChild`; this is not a durable card status.

The runtime persists enough active-card-run and activation-ledger information to unwind one terminal child outcome back to its parent planner.

Activation validation happens before dispatch. A parent planner can activate only an immediate child that is ready to run, and only when that parent has no active child already in flight.

## 5. Agent Lifecycle

Planner sessions are long-lived per goal and should have deterministic identity derived from the goal card. A planner can become dormant after reporting done, failed, or blocked, and can later be resumed by activation of the same goal.

Executor sessions are one-shot per terminal card activation.

Reviewer sessions are one-shot per assessment.

Reviewer approval is valid only for the card tree snapshot it assessed. If the goal or any descendant changes before approval commits, the runtime invalidates the reviewer pass and returns the goal to planner ownership with correction/change context.

Analyst sessions are user-facing conversational sessions. Analyst mutations go through canonical runtime, card, config, process, and notification services.

## 6. Runtime Control Flow

Run:

1. Analyst receives a user request to run, start, continue, or resume.
2. If the runtime is paused, the supervisor lifts the scheduling gate.
3. If no root run exists, the supervisor records durable running intent and creates the root runtime run.
4. If the project is already running, the supervisor returns an already-running warning and creates no duplicate root run.
5. When needed, the supervisor activates the project planner.

Child execution:

1. Planner calls `activate_card(child_id)`.
2. Runtime validates parent ownership and child readiness.
3. Runtime records an activation edge from parent run/tool call to child run.
4. Runtime dispatches the child to planner/executor/reviewer flow.
5. Runtime returns exactly one terminal outcome to the parent planner.

Pause:

1. Pause sets a global scheduling gate.
2. Existing synchronous tool dispatch reaches a safe point.
3. No new LLM turns are admitted while paused.
4. Running processes are not killed by pause.

Shutdown:

1. Shutdown first sets the pause gate.
2. The runtime enumerates owned running processes.
3. The runtime terminates those processes through canonical process control.
4. The runtime reports which processes terminated and which could not be terminated.

## 7. Card-Addressed Notifications

Notifications are queued on cards. The card runtime is responsible for delivering queued content to that card's main agent session.

Notification content is not a durable user-managed object. Persistence exists only to deliver it once. After delivery the platform forgets it as a queue item; delivery evidence is the receiving session transcript.

## 8. Changed-State Propagation

Analyst mutation or parent-planner mutation sets a non-active card to `changed`. If the modified card is already `running`, it remains `running`. In both cases the runtime queues a notification to the modified card so the card's main agent becomes aware of the change.

Inactive ancestors on the direct path to the project root receive changed-subtree context and become `changed` until the first running ancestor. Running ancestors stay `running` and receive notification/context instead of status overwrite. Ancestors are not automatically dispatched by the status change.

The acceptance gate prevents a planner from closing a goal while any executable descendant is not in a terminal accepted state. This forces the planner to observe and handle changed, blocked, backlog, running, failed, cancelled, or otherwise incomplete executable descendants before claiming completion. Goal cards carry their own planning diary state.

`status_text` is a runtime projection from accepted terminal reports only. It is not updated from progress chatter, rejected reports, or reviewer correction requests.

## 9. Collaborative Cancellation

Direct cancellation is only safe for inactive cancellable cards.

For running cards or subtrees containing the active leaf, cancellation is represented as notifications sent to the requested card and downstream active cards. Agents are expected to stop voluntarily at safe points and report failure/cancelled outcomes. Those outcomes unwind through normal activation barriers until they reach the planner responsible for the originally requested cancellation.

## 10. Persistence

Durable state remains project-local. Saivage state must live under the project `.saivage/` and `.saivage-work/` directories, not under user-global state.

Expected persisted concerns include:

- card tree and history;
- agent messages and manifests;
- runtime state, intent, commands, runs, and activations;
- process registry and safe process logs;
- event and error timelines;
- redacted audit/control-action records;
- pending card-addressed notifications only until delivery.

## 11. API And UI Projection

HTTP routes and WebSocket frames are projection and transport surfaces. They do not define runtime semantics.

The UI fetches authoritative read models through REST and receives freshness hints through WebSocket invalidation or event frames. WebSocket does not replace REST as source of truth.

XState or internal actor snapshots must not leak directly through operator APIs. Public responses expose Saivage read models.

## 12. Security Architecture

All protected API and WebSocket routes require authenticated access when a token is configured.

API bearer tokens are accepted in `Authorization: Bearer` headers, not URL query strings. Browser WebSocket connections use short-lived one-use tickets rather than bearer tokens in URLs.

The Analyst may inspect secrets when the authenticated user request requires it. UI projections and logs may redact secrets by default, but that redaction is a display/output policy rather than a limit on Analyst authority.

File inspection and process output are filtered through containment, binary/size checks, and safe command rendering. Secret display should be deliberate and minimized, not categorically unavailable to the Analyst.

Provider diagnostics, account details, runtime internals, and raw error metadata must not be injected into planner, executor, reviewer, or analyst model context merely because they exist. Agent-visible context is deliberately constructed: include actionable recovery information when needed, sanitize diagnostic detail, and preserve raw data in logs or projections with appropriate access controls.

## 13. Implementation Direction

The runtime implementation direction is XState-centered: machine states and actor events should drive behavior, not imperative controller loops decorated with snapshots.

Target actor ownership:

- supervisor owns root runtime mode, pause gate, shutdown process termination, and root project actor;
- goal card actor owns planner turns, reviewer turns, active child activation, and process waits for planner tools;
- terminal card actor owns executor turns and process actors;
- LLM turn actors own provider invocation/admission/cancellation boundaries;
- process actors own OS process lifecycle.

Controllers that advance runtime behavior are legacy by default. A retained `RuntimeApi` may accept commands, send events, wait on snapshots, and project read models; it must not execute workflow logic itself.
