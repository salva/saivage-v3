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

- `idle` is parked: the session is waiting for the next user message. External code advances it through `submit(...)` via `parkedSendEvent('submit')`. This is exactly the frozen-core mechanism for an externally initiated transition: the main loop returns while parked, and `parkedSendEvent` re-enters it. No promise and no task are needed to advance the actor.
- `conversing` is active: the session is running one full user turn — driving the owned `LLMActor` through zero or more tool cycles until it produces an assistant message, errors out, or is cancelled.

The state names are deliberately coarse. The fine-grained sub-states (`calling_provider`, `waiting_tool`) live on the owned `LLMActor`, exactly as they do for autonomous processors. The session actor does not duplicate them.

### External Interface: Events, Not Promises

The session actor has **no parent actor**. Its caller is a transport (WebSocket / REST / Telegram). The promise side-channel is the framework's mechanism for **actor-to-actor** composition (`CardActor` awaits its processor; the processor awaits its `LLMActor`). Using it here would force a request/response shape onto an actor that is fundamentally event-driven. Instead the session actor uses the framework's other mechanism — parked states for inbound transitions and an outward event port for results:

- **Inbound.** Transitions are initiated by public methods that call `parkedSendEvent(...)` from parked states (or `sendEvent(...)` from active states for cancellation). `submit(...)` does not return a promise.
- **Outbound.** Results flow through the session's **activity port**: streaming `tool_call` / `tool_result` / `thinking` events during the turn, and one terminal event (`turn_complete` or `cancelled`) when the turn settles. Transports subscribe to the port.

This places each mechanism where it belongs: events at the transport↔actor boundary, promises at the actor↔actor boundary (the session actor still awaits `llm.turn(...)` through a `runTask` promise, see below).

### Public Methods

- `submit(input: AnalystTurnInput): void`. Stores the turn input on a private field and `parkedSendEvent('submit')` from `idle`. Returns immediately; the terminal response arrives later through the activity port. This is the same parked-advance pattern `LLMActor.turn(...)` and `appendToolResult(...)` use, minus the promise — there is no parent actor to resolve one.
- `cancel(reason: string): boolean`. In-flight cancellation. Emits a `cancelling` activity event immediately (so interactive transports can reflect it) and queues `sendEvent('cancel')`. The conversation-loop settle callback is the settlement gate: when it runs it checks the cancellation flag, emits the terminal `cancelled` event through the port, and sends **no** normal event, so the queued `cancel` dispatches cleanly back to `idle`. Late provider/tool results after cancellation are dropped by the flag. Valid from `conversing`; a no-op from `idle`.
- `abandon(): void`. Shutdown hook. Cancels any in-flight turn, abandons the `LLMActor`, and leaves the actor inert. Used by `AnalystRuntime.shutdown()`.

A `submit(...)` while `conversing` is rejected (the actor is not parked, so `parkedSendEvent` throws). Per-session serialization is therefore expressed directly by the actor's state; the composition root adds no external queue.

### Entry Handler

`_on_enter__conversing` runs the conversation loop as a single `runTask(...)`:

1. Build the `LlmInvocationInput` from the turn input plus the session's accumulated conversation context (read from the conversation store).
2. Drive the conversation loop (see below) with analyst-specific policy until it yields a final assistant message, an error, or the cancellation flag is observed.
3. Persist the assistant message to the conversation store.
4. The task's `on_done`/`on_failed` callbacks are the single settlement gate. They check the cancellation flag first: if it is set, they emit the terminal `cancelled` event through the port and send **no** event — the `cancel` queued by `cancel(...)` then dispatches. If it is not set, they emit the terminal `turn_complete` event through the port and `sendEvent('done')` (or `sendEvent('failed')` after synthesizing and persisting an error assistant message, with the error carried on that terminal event).

This settlement gate is the crux of cancellation. It mirrors `CardActor.commitOutcome()`, which returns without sending an event when its cancellation flag is set. Without it, the loop's settle callback would queue a second event while `cancel` is pending and crash the actor main loop. Because there is no submit-time promise, the gate is the one and only place a terminal response is produced — there is no earlier promise resolution to race with it.

The loop body observes the cancellation flag before each provider turn and each tool dispatch; if it is set, the loop stops and hands control to the settlement gate. Cancellation therefore takes effect within one provider-call or tool-execution latency. It cannot preempt an in-flight provider call (see Cancellation And Shutdown).

### LLMActor Usage

The session actor owns exactly one `LLMActor` with id `analyst:<sessionId>`, created lazily on the first turn and reused across turns for that session. It calls `llm.turn(input)` and `llm.appendToolResult(toolCallId, result, continuationHook)` exactly as the autonomous processors do. The session actor never calls `LLMActor` internals; it uses only its public methods and observes its public state.

### State, Projection, And Persistence

The session actor keeps its current state, the tool in flight, and the last outcome in memory only. It does **not** write to the autonomous actor snapshot store and it is **not** part of the autonomous `actorRuntime` projection. Analyst projection is live and separate: `AnalystRuntime.listSessions()` reads the in-memory session actors directly, and the activity port streams tool call/result/thinking events as they happen. The control room composes this analyst read model alongside `actorRuntime`; the two are not merged.

This keeps the analyst out of the autonomous `actor_kind` vocabulary, out of autonomous recovery, and out of the snapshot schema. The conversation transcript (persisted by the loop through the conversation store) remains the single durable record of an analyst session.

### State Boundaries

The analyst uses parked states for what they are designed for: externally initiated transitions. `idle` is parked, and `submit(...)` advances it through `parkedSendEvent('submit')` with no promise and no task — the frozen-core main loop returns while parked and is re-entered by the parked event. This is the same pattern `LLMActor` uses for `turn(...)` from `idle` and `appendToolResult(...)` from `waiting_tool`.

What parked states do **not** do is await async results. The only sanctioned way to scope an async await to a state is `runTask(...)`, which requires an active state and whose task is aborted on transition. The provider call is therefore awaited in the active `conversing` state through the promise returned by `llm.turn(...)` — that promise is actor-to-actor composition between the session actor and its owned `LLMActor`, which is exactly where the promise side-channel belongs.

The session actor has no intra-turn external-command boundary (tools are dispatched by the session actor itself, not delivered by external events), so `idle` is the only parked state. This mirrors the autonomous processors, which run a whole activation in one active `executing` state and delegate the fine-grained `calling_provider`/`waiting_tool` sub-states to their owned `LLMActor`. The difference from the processors is the external interface: processors expose a promise because they are composed by a parent `CardActor`; the analyst exposes events because it is driven by transports.

## The Conversation Loop

The analyst owns its conversation loop. It does **not** share a generic loop-control function with the autonomous processors. The autonomous `runContractBoundedRepairLoop` and the analyst loop have different domains — contract-terminal card activation with a bounded repair budget versus an open-ended user conversation with a fingerprint anti-loop — and collapsing them into one hook-driven engine would build a small workflow framework beside the actors, which is exactly the kind of abstraction to avoid.

What they share is the building blocks beneath the loop, which is where the real duplication was:

- the `LLMActor` for provider turns and tool waits;
- the `InvocationSurface` and its tool executor;
- the conversation store for transcript persistence;
- the micro-actor patterns (state machine, `runTask`, the promise side-channel).

The analyst loop itself stays analyst-specific. It drives `llm.turn(...)` / `llm.appendToolResult(...)` until the model returns a plain assistant message (`LLMActorOutcome` `result`), an error, or the cancellation flag is observed, and it enforces its own anti-loop rule: a tool call whose `(tool, arguments)` fingerprint repeats without an intervening change ends the turn with a no-progress assistant message. There is no terminal contract tool and no repair budget. The loop is a method on the session actor (or a small analyst-specific helper it calls), not a shared abstraction.

## Composition Root: AnalystRuntime

`AnalystRuntime` replaces the actor-management role of `AnalystHandler`. It is constructed once at server startup with the project root, provider port, card store, process runner, MCP manager, config, and a reference to the autonomous `RuntimeApi` (so control tools can drive the runtime).

- `submit(sessionId, input, subscriber): void`. Get-or-create the `AnalystSessionActor` for `sessionId` (rehydrating prior conversation context on first use), attach the caller's `subscriber` to that session's activity port, and call `submit(...)`. Returns immediately; the caller receives results through the subscriber. Per-session serialization is the actor's responsibility; `AnalystRuntime` adds no queue.
- `cancel(sessionId, reason): boolean`. Look up the live session actor and call `cancel(...)`.
- `listSessions(): AnalystSessionReadModel[]`. Project live sessions and their phase for the operator read model.
- `shutdown(): Promise<void>`. Cancel every live turn, abandon every owned `LLMActor`, and terminate operator-owned processes per session through `ProcessRunner.stopByOwner(...)`.

`getAnalystHandler(...)` and the per-request handler construction disappear. A single `AnalystRuntime` instance is wired into the server composition root alongside the autonomous `RuntimeApplication`.

## Transport Adapters

The three transports become thin adapters that resolve a session id, subscribe to that session's activity port, and call `AnalystRuntime.submit(...)`:

- **WebSocket** (`analyst-ws-handler`): one session per connection, resolved on connect. Forwards inbound chat envelopes; streams every port event (`tool_call`/`tool_result`/`thinking`/`cancelling`/`turn_complete`/`cancelled`) back over the socket. Calls `cancel(...)` on socket close.
- **REST operator chat** (`operator-chat-handlers`): uses the global analyst session id. Subscribes to the port, calls `submit(...)`, awaits the one terminal event (`turn_complete`/`cancelled`), and returns its payload as the HTTP response. Streaming activity is ignored (request/response only).
- **Telegram bot**: uses `telegram-<chatId>` sessions. Same bridge as REST: subscribe, submit, await the terminal event, map its payload to an outbound Telegram message.

The request/response bridging for REST and Telegram lives in the adapters — which is correct, because those transports genuinely are request/response. The actor and the runtime are event-driven and carry no request/response assumption. Adapters do no orchestration beyond this one-shot terminal-event await.

## Provider Gate Policy

The analyst is operator-owned. Its `LLMActor` is **not** injected with the autonomous `RuntimeGate`; it uses an always-open gate so the analyst can converse while the autonomous runtime is `stopped` or `paused`. This is the same policy as today and is non-negotiable: pausing autonomous work must not silence the user's control surface.

Analyst-launched processes remain `owner_kind: 'operator'` and are likewise outside the autonomous pause gate. The process tool provider already exempts operator-owned spawns from the gate; this design preserves that.

The analyst's own concurrency (one turn per session) is enforced by the actor state machine, not by a gate.

## Tool Surface And Control Authority

The analyst's tool surface is unchanged in shape. It is composed into an `InvocationSurface` owned by the session actor and invoked from the conversation loop:

- Control tools (`start_project`, `stop_project`, `pause_runtime`, `resume_runtime`, `queue_notification`, `reconfigure`, `restart_server`, navigation, etc.) call the autonomous `RuntimeApi` and canonical services. The actor does not mutate cards directly.
- Inspection, workspace, patch, process, web, skill, and MCP tools are unchanged.
- Partial-success reporting (multi-step actions report which steps succeeded/failed) stays in the tool layer.

Control tools remain the only mutation surface. The actor itself owns no card mutation; it only owns the conversation turn. This keeps the analyst's authority identical to today while making its lifecycle actor-driven.

## Activity Streaming And Projection

The synchronous `onActivity` callback is replaced by an **AnalystActivityPort** — the single outward channel for a session. The conversation loop emits `tool_call`, `tool_result`, and `thinking` events during the turn, and the settlement gate emits exactly one terminal event (`turn_complete` or `cancelled`) when the turn ends. `cancel(...)` also emits a `cancelling` event immediately so interactive transports can reflect the cancellation before the in-flight provider call settles.

This decouples the loop from the transport: the actor and loop do not know whether a turn was initiated over WebSocket, REST, or Telegram. They only emit events; adapters subscribe. Because the terminal response is one of these events, there is no separate "response" path — the same port carries streaming activity and the final outcome.

The operator control room gains an analyst read model from `AnalystRuntime.listSessions()`: active sessions, their phase (`idle`/`conversing`), the tool currently in flight, and the last outcome — all read live from the in-memory session actors, not from the autonomous snapshot store. Analyst sessions appear as first-class agents in the control room via a composed read model, not by being merged into `actorRuntime`.

## Persistence And Recovery

- **Conversation transcript.** Persisted to the existing conversation store by the loop, unchanged. This is the durable record of an analyst session.
- **No actor snapshots.** The session actor keeps state in memory only and is not persisted to the autonomous snapshot store. There is therefore no stale-snapshot recovery problem and no analyst entry in autonomous recovery.
- **Turn recovery.** There is none. An interrupted analyst turn (server crash mid-turn) is abandoned on restart. The next message to that session id creates a fresh `idle` `AnalystSessionActor` rehydrated from the conversation transcript; the user re-asks. This is the conservative posture already used by the autonomous runtime for in-flight LLM work, and it is correct for a user-driven conversation: the transcript is the truth, not an in-flight provider call.
- **Process cleanup.** On restart, operator-owned analyst processes are handled by the existing `ProcessRunner` reconciliation (`owner_kind: 'operator'` → observed best-effort or marked lost). No new recovery path is introduced.

This deliberately mirrors the autonomous runtime's "no mid-flight resume for in-flight work" policy, and avoids inventing snapshot/recovery machinery for a control surface that is naturally reconstructed from its transcript.

## Concurrency And Serialization

- **One turn per session at a time.** Enforced by the `AnalystSessionActor` state machine: a session in `conversing` rejects a second `submit(...)` because the actor is not parked. The external `sessionQueues` promise chain is removed.
- **Many sessions in parallel.** Sessions are independent actors; the composition root does not lock across sessions.
- **Single pending event.** The frozen core allows exactly one pending event per actor. Because the session is single-turn-at-a-time, this is sufficient; no inbox or queue is added to the actor. (The now-deleted `SlaveActor` job queue is deliberately not reintroduced.)

## Cancellation And Shutdown

- `cancel(reason)` takes effect within one provider-call or tool-execution latency. It emits a `cancelling` activity event immediately and queues `sendEvent('cancel')`. The conversation-loop settle callback checks the flag, emits the terminal `cancelled` event through the port, and sends no normal event, so the queued `cancel` dispatches cleanly back to `idle`. A provider/tool result that lands after cancellation is dropped by the flag. This is the same settlement discipline as `CardActor.commitOutcome()`. Because there is no submit-time promise, the gate is the only place a terminal response is produced — nothing races it.
- `cancel` does **not** abort the in-flight provider HTTP call. The frozen core cannot preempt a running `runTask`, and the `LLMActor` owns the provider call in its own active state. The provider result completes and is discarded. This is the same limitation as autonomous card cancellation; true provider-call preemption would require extending the `LLMActor`/provider contract and is out of scope.
- WebSocket disconnect calls `cancel(...)` for that connection's session, so a closed tab resolves the in-flight turn cleanly rather than leaving it dangling. The underlying provider call, if any, still completes and is discarded.
- `AnalystRuntime.shutdown()` cancels every live turn, abandons every owned `LLMActor`, and terminates operator-owned processes per session. This is the analyst analogue of `SupervisorRuntimeApi.shutdown()` calling `ProcessRunner.stopRuntimeOwned(...)`.

Cancellation that ends the turn and drops late outcomes is the capability the actor model adds over the current imperative loop, which cannot express it at all.

## Relationship To Autonomous Processors

**Shared with autonomous card processors:**

- The `LLMActor` for provider turns and tool waits.
- The `InvocationSurface` and tool executor used to dispatch tools.
- The conversation store for transcript persistence.
- The micro-actor patterns: state machine, `runTask(...)`, and the promise side-channel for cross-actor waiting.
- The conservative "no mid-flight resume" recovery posture.
- The cancellation-gate settlement discipline (`commitOutcome`-style flag check in the task settle callback).

**Intentionally different from autonomous card processors:**

- The analyst is session-scoped, not card-scoped. There is no card, no activation outcome vocabulary, and no reviewer.
- The analyst owns its own conversation loop; it does not share a generic loop-control function with the contract-terminal bounded repair loop. The loops serve different domains.
- The analyst has no contract terminal tools; a turn ends on a plain assistant message. Its anti-loop guard is the fingerprint check, not a bounded repair budget.
- The analyst is operator-owned: it bypasses the autonomous `RuntimeGate` and spawns `owner_kind: 'operator'` processes.
- The analyst is projected live via `AnalystRuntime.listSessions()` and the activity port; it is not part of the autonomous snapshot store, `actor_kind` schema, or `actorRuntime` recovery.
- The analyst has no main-agent notification queue; continuation context is just the tool exchange.
- The analyst is user-driven (`submit` from external transports, advanced through parked states), not runtime-dispatched (`activate` from a parent card).
- The analyst exposes events at its external boundary (parked-state advance in, activity port out) because it has no parent actor; processors expose promises because they are composed by a parent `CardActor`. Both use the promise side-channel for actor-to-actor composition with their owned `LLMActor`.

The architecture — actors, `LLMActor`, the invocation surface, the store, the micro-actor patterns — is unified. The domain policy and the projection boundary stay separate, which is simpler than forcing them together.

## Invariants

- At most one analyst turn is active per session; a `submit(...)` while `conversing` is rejected because the actor is not parked.
- The transport↔session boundary is event-driven: `submit(...)` advances the parked `idle` actor via `parkedSendEvent`, and results flow out only through the activity port. No promise crosses this boundary.
- The session↔`LLMActor` boundary is actor-to-actor composition: the active `conversing` state awaits `llm.turn(...)` through a `runTask` promise.
- The analyst never waits on the autonomous `RuntimeGate`.
- Analyst-launched processes are always `owner_kind: 'operator'`.
- Control tools remain the only mutation surface; the `AnalystSessionActor` never mutates cards directly.
- Activity and session state are emitted through the activity port and `AnalystRuntime.listSessions()`; the actor and loop are transport-agnostic and are not coupled to the autonomous snapshot store.
- The conversation-loop settle callback is the single settlement gate: it checks the cancellation flag before sending any event and before emitting the terminal port event, so a queued `cancel` never collides with a normal `done`/`failed`.
- A cancelled turn emits exactly one terminal event; late provider/tool results after cancellation are dropped. The provider HTTP call itself is not aborted.
- `AnalystSessionActor` keeps state in memory only; it writes no autonomous snapshots and participates in no autonomous recovery.
- On restart, an analyst session is rehydrated from its conversation transcript into `idle`; in-flight turns are not resumed.
- The conversation transcript is the single durable record of an analyst session.

## Open Questions

- Whether idle analyst sessions should be evicted after a bounded inactivity window to bound memory, and if so, whether eviction persists a "last seen" marker so the session id still resolves after eviction.
- Whether analyst activity should also be surfaced on the runtime event bus for diagnostic correlation, or kept on the dedicated activity port only.
- Whether the global REST analyst session and per-connection WebSocket sessions should converge on a single session model, or remain distinct to preserve the request/response semantics of the REST chat.
- Whether provider-call preemption is ever worth extending the `LLMActor`/provider contract for; until then, analyst cancellation shares the autonomous limitation that the underlying HTTP call is not aborted.
