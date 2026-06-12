# Saivage v3 System Architecture

Status: current design summary.

Last updated: 2026-06-12.

## 1. Architectural Shape

Saivage is a card-centered autonomous runtime with a conversational control surface.

The major subsystems are:

- Operator web UI: read-only workspace plus always-visible Analyst panel.
- Analyst agent: user-facing inspection and mutation orchestrator.
- Runtime supervisor: explicit root intent, pause/resume/stop, active-work ownership, recovery coordination.
- Card store: durable project hierarchy and card history.
- Agent sessions: planner, executor, reviewer, and analyst transcripts.
- Agent adapter: LLM invocation, tool dispatch, model-visible message construction, and transcript persistence.
- Process registry: durable process records, safe process read models, restart reconciliation.
- Notification queue: card-addressed ephemeral context delivery.
- HTTP/WebSocket server: authenticated projections, chat transport, and invalidate/event delivery.

## 2. Ownership Boundaries

The runtime is the only dispatcher. Agents request work through tools; they do not directly invoke other agents.

Planner/card state owns hierarchy, objectives, dependencies, evidence, status, and history. Runtime execution state owns root intent, command/run/activation ledgers, active-card-run state, process records, and recovery metadata.

Changing planner/card state does not by itself dispatch work. Root work starts through explicit runtime control; child work starts through parent-planner `activate_card`.

## 3. Active Work Model

At most one leaf card is doing real work at a time. The active work chain can contain multiple cards with durable status `running`, but only the leaf receives scheduling, LLM turns, or process work.

Ancestors are waiting for their active child. Their runner/session lifecycle state is `AwaitingChild`; this is not a durable card status.

The runtime persists enough active-card-run and activation-ledger information to unwind one terminal child outcome back to its parent planner.

## 4. Agent Lifecycle

Planner sessions are long-lived per goal. A planner can become dormant after reporting done, failed, or blocked, and can later be resumed by activation of the same goal.

Executor sessions are one-shot per terminal card activation.

Reviewer sessions are one-shot per assessment.

Analyst sessions are user-facing conversational sessions. Analyst mutations go through canonical runtime, card, config, process, and notification services.

## 5. Runtime Control Flow

Root execution:

1. Analyst requests `start_project`.
2. Runtime verifies no root run is already active.
3. Runtime records durable running intent and a root runtime run.
4. Runtime activates the project planner.

Child execution:

1. Planner calls `activate_card(child_id)`.
2. Runtime validates parent ownership and child readiness.
3. Runtime records an activation edge from parent run/tool call to child run.
4. Runtime dispatches the child to planner/executor/reviewer flow.
5. Runtime returns exactly one terminal outcome to the parent planner.

Pause/resume:

1. Pause sets a global scheduling gate.
2. Existing synchronous tool dispatch reaches a safe point.
3. No new LLM turns are admitted while paused.
4. Resume lifts the gate and pending deliverable context is injected at the next safe turn.

## 6. Card-Addressed Notifications

Notifications are queued on cards. The card runtime is responsible for delivering queued content to that card's main agent session.

Notification content is not a durable user-managed object. Persistence exists only to deliver it once. After delivery the platform forgets it as a queue item; delivery evidence is the receiving session transcript.

## 7. Changed-State Propagation

Analyst mutation or correction context can set a card to `changed`. Ancestors receive `subtree_changed` context, but are not automatically dispatched by the status change.

The acceptance gate prevents a planner from closing a goal while any descendant is `changed`. This forces the planner to observe and handle the modification before claiming completion.

## 8. Persistence

Durable state remains project-local. Saivage state must live under the project `.saivage/` and `.saivage-work/` directories, not under user-global state.

Expected persisted concerns include:

- card tree and history;
- agent messages and manifests;
- runtime state, intent, commands, runs, and activations;
- process registry and safe process logs;
- event and error timelines;
- redacted audit/control-action records;
- pending card-addressed notifications only until delivery.

## 9. API And UI Projection

HTTP routes and WebSocket frames are projection and transport surfaces. They do not define runtime semantics.

The UI fetches authoritative read models through REST and receives freshness hints through WebSocket invalidation or event frames. WebSocket does not replace REST as source of truth.

XState or internal actor snapshots must not leak directly through operator APIs. Public responses expose Saivage read models.

## 10. Security Architecture

All protected API and WebSocket routes require authenticated access when a token is configured.

API bearer tokens are accepted in `Authorization: Bearer` headers, not URL query strings. Browser WebSocket connections use short-lived one-use tickets rather than bearer tokens in URLs.

File inspection and process output are filtered through containment, redaction, secret-path blocking, binary/size checks, and safe command rendering.

## 11. Implementation Direction

The runtime implementation direction is XState-centered: machine states and actor events should drive behavior, not imperative controller loops decorated with snapshots.

Target actor ownership:

- supervisor owns root runtime mode and root project actor;
- goal card actor owns planner turns, reviewer turns, active child activation, and process waits for planner tools;
- terminal card actor owns executor turns and process actors;
- LLM turn actors own provider invocation/admission/cancellation boundaries;
- process actors own OS process lifecycle.

Controllers that advance runtime behavior are legacy by default. A retained `RuntimeApi` may accept commands, send events, wait on snapshots, and project read models; it must not execute workflow logic itself.
