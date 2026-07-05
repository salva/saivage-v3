# Analyst Micro-Actor Design

Status: target design. This document describes the analyst as a first-class participant in the micro-actor runtime. It is the target architecture, not an implementation plan; phasing, migration, and file-level changes are out of scope here.

Date: 2026-07-05.

## Purpose And Scope

The analyst is Saivage's user-facing conversational control surface. Today it is implemented as a plain imperative class (`AnalystHandler`) that constructs `LLMActor` instances and drives them through an inline `for(;;)` tool loop with its own anti-loop guard. That makes the analyst the largest parallel approach to the micro-actor runtime: it reuses the LLM actor but none of the orchestration, projection, cancellation, or recovery patterns that the autonomous side uses.

This design puts the analyst fully on top of the micro-actor framework. The analyst becomes a real actor hierarchy with a state machine, the same sanctioned cross-actor wait pattern used by `CardActor`/processors, the same conversation-loop skeleton as the autonomous processors, and the same conversation store. The result removes the parallel tool-loop and gives the analyst capabilities it cannot have today: authoritative in-flight cancellation, operator-visible projection, and clean recovery semantics.

Scope: the conversational analyst that serves the web chat, the operator REST chat, and the Telegram bot. The autonomous runtime (planner/executor/reviewer), the `ProcessRunner`, the `RuntimeGate`, and the conversation store are unchanged by this design.

## Design Goals

- The analyst's conversational behavior is driven by micro-actor state machines and `runTask(...)`, not by an imperative loop in a plain class.
- The analyst reuses the existing `LLMActor` for provider turns and the existing conversation store for transcript persistence.
- The tool-loop skeleton is shared with the autonomous processors; only role policy differs.
- The analyst remains **operator-owned**: it must run while the autonomous runtime is `stopped` or `paused`, so it never waits on the autonomous `RuntimeGate`, and its processes stay `owner_kind: 'operator'`.
- The analyst remains transport-agnostic. WebSocket, REST, and Telegram are thin adapters over one actor boundary.
- In-flight analyst turns become cancellable, projectable, and recoverable to a well-defined idle state.

## Non-Goals

- Unifying analyst semantics with autonomous card processors. The analyst has no card, no activation-outcome vocabulary (`done`/`failed`/`blocked`), no contract terminal tools, and no reviewer. It is a conversation, not a card activation.
- Mid-flight resume of an interrupted analyst turn across a server restart. The conversation transcript is durable; an interrupted turn is not.
- Changing the analyst's tool surface or its authority over the autonomous runtime. Control tools remain the only mutation path and continue to call the autonomous `RuntimeApi`.

## Current State (What This Replaces)

- `AnalystHandler` is a plain class. It owns a `Map<sessionId, LLMActor>`, serializes messages per session with an external promise chain (`sessionQueues`), and runs `runAnalystLoop` — an imperative `for(;;)` that calls `actor.turn()` and `actor.appendToolResult()` with a fingerprint-based anti-loop guard.
- It is constructed per request via `getAnalystHandler(...)` and invoked from three transports: the WebSocket handler, the operator REST chat route, and the Telegram bot.
- It emits activity (tool call/result/thinking) through a synchronous `onActivity` callback.
- It has no cancellation: an in-flight turn cannot be stopped, and a late provider result can still settle.
- It is invisible to the operator runtime read model; there is no `actorRuntime` projection for analyst sessions.

## Actor Model Overview

```text
AnalystRuntime (composition root; non-actor registry and lifecycle owner)
  AnalystSessionActor(sessionId)        one per conversation session
    LLMActor(analyst:<sessionId>)       the main agent; reused as-is
```

`AnalystRuntime` is the analyst analogue of `SupervisorRuntimeApi`: it owns the session-actor registry, routes inbound turns, and manages shutdown. It is not itself an actor, mirroring the autonomous composition root. `AnalystSessionActor` is a micro-actor that owns one `LLMActor` and drives the conversation loop.

## AnalystSessionActor

One `AnalystSessionActor` exists per conversation session, identified by a stable session id (e.g. `analyst:<sessionId>`). It is created lazily by `AnalystRuntime` the first time a message arrives for a session that has no live actor, rehydrated from the persisted conversation transcript, and `start()`-ed into `idle`.

### State Machine

```text
idle        parked    on: { submit -> conversing }
conversing  active    on: { done -> idle, failed -> idle, cancel -> idle }
```

- `idle` is parked: the session is waiting for the next user message. External code advances it through `submitTurn(...)`.
- `conversing` is active: the session is running one full user turn — driving the `LLMActor` through zero or more tool cycles until it produces an assistant message, errors out, or is cancelled.

The state names are deliberately coarse. The fine-grained sub-states (`calling_provider`, `waiting_tool`) live on the owned `LLMActor`, exactly as they do for autonomous processors. The session actor does not duplicate them.

### Public Methods

- `submitTurn(input: AnalystTurnInput): Promise<AnalystResponse>`. The single entry point. Validates that the actor is `idle`, stores the turn input and a promise resolver on private fields, and `parkedSendEvent('submit')`. Resolves with the final `AnalystResponse` when the turn completes. This is the sanctioned promise side-channel pattern already used by `CardActor.activate(...)`, `BaseCardProcessorActor.activate(...)`, and `LLMActor.turn(...)`: the promise is resolved from inside the actor main loop's task callback, never from outside.
- `cancelTurn(reason: string): boolean`. Authoritative in-flight cancellation. Sets a private cancellation flag, resolves the pending turn (the response notes cancellation), abandons the owned `LLMActor`'s parked turn, and `sendEvent('cancel')`. A late provider result that arrives after cancellation is dropped by the cancellation flag, mirroring `CardActor.commitOutcome()`. Valid only from `conversing`.
- `abandon(): void`. Shutdown hook. Cancels any in-flight turn, abandons the `LLMActor`, and leaves the actor inert. Used by `AnalystRuntime.shutdown()`.

A second `submitTurn(...)` while `conversing` is rejected. Per-session serialization is therefore expressed directly by the actor's single-pending-event invariant; the composition root no longer needs an external promise chain.

### Entry Handler

`_on_enter__conversing` runs the conversation loop as a single `runTask(...)`:

1. Build the `LlmInvocationInput` from the turn input plus the session's accumulated conversation context (read from the conversation store).
2. Drive the shared conversation-loop driver (see below) with analyst-specific policy until it yields a final assistant message, an error, or the cancellation flag is observed.
3. Persist the assistant message to the conversation store.
4. On the task's `on_done` callback, resolve the pending turn promise and `sendEvent('done')`. On `on_failed`, synthesize an error assistant message, persist it, resolve the promise, and `sendEvent('failed')`.

The loop body inspects the cancellation flag before each provider turn and each tool dispatch; if it is set, the loop stops and the turn resolves as cancelled. Because the frozen main loop aborts state-scoped tasks on transition, `cancelTurn(...)` queues `sendEvent('cancel')` synchronously so the actor never finds itself in a non-terminal state with no event and no task.

### LLMActor Usage

The session actor owns exactly one `LLMActor` with id `analyst:<sessionId>`, created lazily on the first turn and reused across turns for that session. It calls `llm.turn(input)` and `llm.appendToolResult(toolCallId, result, continuationHook)` exactly as the autonomous processors do. The session actor never calls `LLMActor` internals; it uses only its public methods and observes its public state.

### Snapshot And Persistence

`_on_state_changed(oldState, newState)` persists a small analyst actor snapshot (session id, current state, active turn metadata, last outcome). This snapshot feeds the operator read model (`actorRuntime`) so analyst sessions appear alongside autonomous agents. The conversation transcript continues to be persisted by the conversation-loop driver through the conversation store; the actor snapshot is a projection/diagnostics record, not a second transcript.

## The Conversation Loop

The tool-loop skeleton becomes a shared primitive used by both the autonomous processors and the analyst. Today the processors use `runContractBoundedRepairLoop` and the analyst uses an inline `runAnalystLoop`; these are the same shape — drive an `LLMActor` through `turn`/`appendToolResult` until a terminal condition — with different policy.

The shared driver keeps the skeleton (advance one outcome at a time; route result/tool-call/error; bound the loop) and delegates policy to injected hooks:

- **Terminal decision.** Autonomous processors terminate on role contract terminal tools (`emit_result`) with a bounded repair budget. The analyst terminates on a plain assistant message (`LLMActorOutcome` `result`); it has no terminal tools and no repair budget.
- **Anti-loop.** Autonomous cards rely on the contract budget and completion gates. The analyst keeps its fingerprint anti-loop guard: a tool call whose `(tool, arguments)` fingerprint repeats without an intervening change is treated as no-progress and the turn ends with a no-progress assistant message.
- **Tool dispatch.** Both compose an `InvocationSurface` and invoke tools through the same surface executor. The analyst surface is unchanged: analyst control tools, card inspection/history, workspace, patch, process, web, skill, and MCP.
- **Activity.** The analyst emits `tool_call`/`tool_result`/`thinking` activity through an activity port (see below). Autonomous processors do not emit this stream.
- **Continuation context.** Autonomous processors inject planner/reviewer notification context into tool-result continuations. The analyst has no main-agent notification queue; its continuation context is only the assistant/tool/tool-result message pair.

The driver is a free function invoked from inside each actor's `runTask(...)`, not an actor. It does not own state; the owning actor owns the `LLMActor`, the pending turn, the cancellation flag, and the loop policy.

## Composition Root: AnalystRuntime

`AnalystRuntime` replaces the actor-management role of `AnalystHandler`. It is constructed once at server startup with the project root, provider port, card store, process runner, MCP manager, config, and a reference to the autonomous `RuntimeApi` (so control tools can drive the runtime).

- `submitTurn(sessionId, content, context): Promise<AnalystResponse>`. Get-or-create the `AnalystSessionActor` for `sessionId` (rehydrating prior conversation context on first use), then call `submitTurn(...)`. Per-session serialization is the actor's responsibility; `AnalystRuntime` does not add a second queue.
- `cancelTurn(sessionId, reason): boolean`. Look up the live session actor and call `cancelTurn(...)`.
- `listSessions(): AnalystSessionReadModel[]`. Project live sessions and their phase for the operator read model.
- `shutdown(): Promise<void>`. Cancel every live turn, abandon every owned `LLMActor`, and terminate operator-owned processes per session through `ProcessRunner.stopByOwner(...)`.

`getAnalystHandler(...)` and the per-request handler construction disappear. A single `AnalystRuntime` instance is wired into the server composition root alongside the autonomous `RuntimeApplication`.

## Transport Adapters

The three transports become thin adapters that resolve a session id and call `AnalystRuntime.submitTurn(...)`:

- **WebSocket** (`analyst-ws-handler`): one session per connection, resolved on connect. Forwards inbound chat envelopes and streams activity back over the socket. Cancel on socket close.
- **REST operator chat** (`operator-chat-handlers`): uses the global analyst session id. Returns the final `AnalystResponse` in the HTTP response; activity is not streamed (request/response only).
- **Telegram bot**: uses `telegram-<chatId>` sessions. Maps analyst responses to outbound Telegram messages.

Adapters do no orchestration. They translate between their transport and `submitTurn`/`cancelTurn`/activity subscriptions.

## Provider Gate Policy

The analyst is operator-owned. Its `LLMActor` is **not** injected with the autonomous `RuntimeGate`; it uses an always-open gate so the analyst can converse while the autonomous runtime is `stopped` or `paused`. This is the same policy as today and is non-negotiable: pausing autonomous work must not silence the user's control surface.

Analyst-launched processes remain `owner_kind: 'operator'` and are likewise outside the autonomous pause gate. The process tool provider already exempts operator-owned spawns from the gate; this design preserves that.

The analyst's own concurrency (one turn per session) is enforced by the actor state machine, not by a gate.

## Tool Surface And Control Authority

The analyst's tool surface is unchanged in shape. It is composed into an `InvocationSurface` owned by the session actor and invoked from the conversation-loop driver:

- Control tools (`start_project`, `stop_project`, `pause_runtime`, `resume_runtime`, `queue_notification`, `reconfigure`, `restart_server`, navigation, etc.) call the autonomous `RuntimeApi` and canonical services. The actor does not mutate cards directly.
- Inspection, workspace, patch, process, web, skill, and MCP tools are unchanged.
- Partial-success reporting (multi-step actions report which steps succeeded/failed) stays in the tool layer.

Control tools remain the only mutation surface. The actor itself owns no card mutation; it only owns the conversation turn. This keeps the analyst's authority identical to today while making its lifecycle actor-driven.

## Activity Streaming And Projection

The synchronous `onActivity` callback is replaced by an **AnalystActivityPort**. The conversation-loop driver emits `tool_call`, `tool_result`, and `thinking` events to the port; the composition root wires the port to the transports (WebSocket broadcast, REST omission, Telegram omission) and, where useful, to the event bus for diagnostics.

This decouples the loop from the transport: the actor and the driver do not know whether a turn was initiated over WebSocket, REST, or Telegram. They only emit activity; adapters subscribe.

The operator runtime read model gains an analyst section derived from session-actor snapshots: active sessions, their phase (`idle`/`conversing`), the tool currently in flight, and the last outcome. Analyst sessions appear as first-class agents in the control room.

## Persistence And Recovery

- **Conversation transcript.** Persisted to the existing conversation store by the driver, unchanged. This is the durable record of an analyst session.
- **Actor snapshots.** The session actor persists a small projection snapshot on each transition. On restart, `actorRuntime` reflects analyst state from these snapshots.
- **Turn recovery.** There is none. An interrupted analyst turn (server crash mid-turn) is abandoned on restart. The next message to that session id creates a fresh `idle` `AnalystSessionActor` rehydrated from the conversation transcript; the user re-asks. This is the conservative recovery posture already used by the autonomous runtime for in-flight LLM work, and it is correct for a user-driven conversation: the transcript is the truth, not an in-flight provider call.
- **Process cleanup.** On restart, operator-owned analyst processes are handled by the existing `ProcessRunner` reconciliation (`owner_kind: 'operator'` → observed best-effort or marked lost). No new recovery path is introduced.

This deliberately mirrors the autonomous runtime's "block-on-restart for in-flight work" policy rather than inventing a mid-flight resume for analyst turns.

## Concurrency And Serialization

- **One turn per session at a time.** Enforced by the `AnalystSessionActor` state machine: a session in `conversing` rejects a second `submitTurn`. The external `sessionQueues` promise chain is removed.
- **Many sessions in parallel.** Sessions are independent actors; the composition root does not lock across sessions.
- **Single pending event.** The frozen core allows exactly one pending event per actor. Because the session is single-turn-at-a-time, this is sufficient; no inbox or queue is added to the actor. (The now-deleted `SlaveActor` job queue is deliberately not reintroduced.)

## Cancellation And Shutdown

- `cancelTurn(reason)` is authoritative and immediate. It sets the cancellation flag, resolves the pending turn as cancelled, abandons the owned `LLMActor`'s parked turn, and queues `sendEvent('cancel')`. A provider result that lands after cancellation is dropped by the flag in the loop's settle path, exactly as `CardActor.commitOutcome()` drops late outcomes. The session returns to `idle`, ready for the next message.
- WebSocket disconnect calls `cancelTurn(...)` for that connection's session, so a closed tab stops the in-flight turn rather than letting it run unconstrained.
- `AnalystRuntime.shutdown()` cancels every live turn, abandons every `LLMActor`, and terminates operator-owned processes per session. This is the analyst analogue of `SupervisorRuntimeApi.shutdown()` calling `ProcessRunner.stopRuntimeOwned(...)`.

Cancellation is a capability the actor model enables that the current imperative loop cannot express cleanly.

## Relationship To Autonomous Processors

**Shared with autonomous card processors:**

- The `LLMActor` for provider turns and tool waits.
- The conversation-loop driver skeleton (turn → tool-call → appendToolResult → terminal condition), with policy injected.
- The conversation store for transcript persistence.
- The micro-actor patterns: state machine, `runTask(...)`, `_on_state_changed` snapshots, and the promise side-channel for cross-actor waiting.
- The conservative "no mid-flight resume" recovery posture.

**Intentionally different from autonomous card processors:**

- The analyst is session-scoped, not card-scoped. There is no card, no activation outcome vocabulary, and no reviewer.
- The analyst has no contract terminal tools; a turn ends on a plain assistant message. Its anti-loop guard is the fingerprint check, not a bounded repair budget.
- The analyst is operator-owned: it bypasses the autonomous `RuntimeGate` and spawns `owner_kind: 'operator'` processes.
- The analyst has no main-agent notification queue; continuation context is just the tool exchange.
- The analyst is user-driven (`submitTurn` from external transports), not runtime-dispatched (`activate` from a parent card).

These differences are policy, not architecture. The architecture — actors, the loop driver, the store, the patterns — is unified.

## Invariants

- At most one analyst turn is active per session; a second `submitTurn` while `conversing` is rejected.
- The analyst never waits on the autonomous `RuntimeGate`.
- Analyst-launched processes are always `owner_kind: 'operator'`.
- Control tools remain the only mutation surface; the `AnalystSessionActor` never mutates cards directly.
- Activity is emitted through the activity port; the actor and driver are transport-agnostic.
- A cancelled turn resolves exactly once; late provider results after cancellation are dropped.
- On restart, an analyst session is rehydrated from its conversation transcript into `idle`; in-flight turns are not resumed.
- The conversation transcript is the single durable record of an analyst session; actor snapshots are projection/diagnostics only.

## Open Questions

- Whether idle analyst sessions should be evicted after a bounded inactivity window to bound memory, and if so, whether eviction persists a "last seen" marker so the session id still resolves after eviction.
- Whether analyst activity should also be surfaced on the runtime event bus for diagnostic correlation, or kept on a dedicated activity port.
- Whether the global REST analyst session and per-connection WebSocket sessions should converge on a single session model, or remain distinct to preserve the request/response semantics of the REST chat.
- The exact projection fields for the analyst section of `actorRuntime` (phase vocabulary, current-tool-in-flight, last outcome).
