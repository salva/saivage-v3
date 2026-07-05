# Analyst Micro-Actor Design

Status: target design. This document describes the analyst as a first-class participant in the micro-actor runtime. It is the target architecture, not an implementation plan; phasing, migration, and file-level changes are out of scope here.

Date: 2026-07-05.

## Purpose And Scope

The analyst is Saivage's user-facing conversational control surface. Today it is implemented as a plain imperative class (`AnalystHandler`) that constructs `LLMActor` instances and drives them through an inline `for(;;)` tool loop with its own anti-loop guard. That makes the analyst the largest parallel approach to the micro-actor runtime: it reuses the LLM actor but none of the orchestration, projection, cancellation, or recovery patterns that the autonomous side uses.

This design puts the analyst fully on top of the micro-actor framework. The analyst becomes a real actor hierarchy with a state machine, the same sanctioned cross-actor wait pattern used by `CardActor`/processors, the same conversation store, and the same LLM-actor conversation engine. The result removes the parallel tool-loop and gives the analyst capabilities it cannot have today: authoritative cleanup of cancelled turns, operator-visible projection, and clean recovery semantics.

Scope: the conversational analyst that serves the web chat, the operator REST chat, and the Telegram bot. The autonomous runtime (planner/executor/reviewer), the `ProcessRunner`, the `RuntimeGate`, and the conversation store are unchanged by this design.

## Design Goals

- The analyst's conversational behavior is driven by micro-actor state machines and `runTask(...)`, not by an imperative loop in a plain class.
- The analyst reuses the LLM-actor conversation/provider engine for provider turns and the existing conversation store for transcript persistence.
- The building blocks beneath the loop (`LLMActor`, invocation surface, conversation store, micro-actor patterns) are shared with the autonomous processors; the loop policy stays analyst-specific.
- The analyst remains **operator-owned**: it must run while the autonomous runtime is `stopped` or `paused`, so it never waits on the autonomous `RuntimeGate`, and its processes stay `owner_kind: 'operator'`.
- The analyst remains transport-agnostic. WebSocket, REST, and Telegram are thin callers over one actor boundary.
- In-flight analyst turns can be cancelled as transcript-preserving turn termination, projected live, and rebuilt from transcript context to a well-defined idle state after restart.
- Cancellation favors robust return to a stable state over chasing every late-edge interleaving. The transcript remains durable truth, actor state returns to a reusable idle state, and the next turn can continue from the transcript even if late provider/tool activity made the cancelled turn's caller-facing status differ from the final visible transcript rows.

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
  AnalystSessionActor                   one per conversation session; keyed by session id in the registry
    LLMActor                            conversation/provider engine; id = canonical analyst:<key>
```

`AnalystRuntime` is the analyst analogue of `SupervisorRuntimeApi`: it owns the session-actor registry, routes inbound turns, and manages shutdown. It is not itself an actor, mirroring the autonomous composition root. `AnalystSessionActor` is a micro-actor that owns one LLM actor and drives the conversation loop.

## AnalystSessionActor

One `AnalystSessionActor` exists per conversation session, identified by its canonical session id (e.g. `analyst:global`, `analyst:telegram-<chatId>`). It is created lazily by `AnalystRuntime` the first time a message arrives for a session that has no live actor. The runtime loads prior transcript context from the conversation store and `start()`s a fresh actor into `idle`.

### State Machine

```text
idle        parked    on: { submit -> conversing }
conversing  active    on: { done -> idle, failed -> idle, cancel -> idle }
```

- `idle` is parked: the session is waiting for the next user message. External code advances it through `submit(...)` via `parkedSendEvent('submit')`. This is exactly the frozen-core mechanism for an externally initiated transition: the main loop returns while parked, and `parkedSendEvent` re-enters it. No task is needed to advance the actor; the promise `submit(...)` returns is settled later by the settlement gate, not awaited here.
- `conversing` is active: the session is running one full user turn — driving the owned `LLMActor` through zero or more tool cycles until it produces an assistant message, errors out, or is cancelled.

The state names are deliberately coarse. The fine-grained sub-states (`calling_provider`, `waiting_tool`) live on the owned `LLMActor`, exactly as they do for autonomous processors. The session actor does not duplicate them.

### External Interface

The session actor exposes the same promise-backed turn API the rest of the actor system uses. `submit(...)` returns a `Promise<AnalystTurnResult>` that the settlement gate resolves or rejects — exactly the side-channel pattern `LLMActor.turn(...)` and `appendToolResult(...)` use: store the resolver on the instance, advance the state machine via `parkedSendEvent(...)`, and settle from the task callback. The caller is a transport or the composition root, never another actor, but that does not change the API shape; `LLMActor` likewise returns promises despite being a leaf actor.

Streaming activity during the turn (tool calls, tool results, thinking) flows through an optional `onActivity` callback supplied by the caller. Request/response transports ignore it; the WebSocket transport uses it to stream segments as they happen. The callback is scoped to a single turn: the settlement gate clears it when the turn ends, so an idle session actor never holds a stale transport callback.

### Public Methods

- `submit(input: AnalystTurnInput, onActivity?: (event: AnalystActivityEvent) => void): Promise<AnalystTurnResult>`. Stores the turn input and the activity callback on the instance, `parkedSendEvent('submit')` from `idle`, and returns a promise. The settlement gate resolves it with an assistant message, an error result, or a cancelled result. Cancellation is an expected terminal result, not a thrown/fatal condition. This is the same parked-advance-plus-side-channel pattern `LLMActor.turn(...)` uses; the only difference is the caller is a transport/composition root rather than a parent actor.
- `cancel(reason: string): boolean`. Marks the in-flight turn cancelled and queues `sendEvent('cancel')`. The settlement gate then ends the turn, resolves the `submit` promise with a cancelled result, and sends **no** normal event, so the queued `cancel` dispatches cleanly back to `idle`. Valid from `conversing`; a no-op from `idle`.

`submit(...)` validates state up front and rejects its returned promise for precondition failures (a second `submit(...)` while `conversing`, or a call before the actor has started), matching `LLMActor.turn(...)`; it never lets the framework's `parkedSendEvent` assertion throw through the public API. Per-session serialization is therefore expressed directly by the actor's state; the composition root adds no external queue.

### Entry Handler

`_on_enter__conversing` runs the conversation loop as a single `runTask(...)`:

1. Build the `LlmInvocationInput` from the turn input plus the session's accumulated conversation context (read from the conversation store).
2. Drive the conversation loop (see below) with analyst-specific policy until it yields a final assistant message, an error, or the cancellation flag is observed.
3. The LLM actor is the sole transcript writer, and it writes only through its own state-machine-driven paths (turn start, turn finish, turn error, and tool delivery). The session actor never writes transcript rows itself; it supplies enriched context and tool results to the LLM actor. There are no out-of-band transcript writes — policy-driven repair/tool-result rows the anti-loop uses flow through the LLM actor like any other tool result, mirroring the autonomous repair pattern.
4. The task's `on_done`/`on_failed` callbacks are the single settlement gate. They check the cancellation flag first: if it is set, they abandon any parked LLM turn via its existing `abandon` transition (returning it to `idle` in-memory), resolve the `submit` promise with a cancelled result, and send **no** event — the `cancel` queued by `cancel(...)` then dispatches. If it is not set, they resolve the `submit` promise with the assistant message and `sendEvent('done')` (or, on failure, resolve the promise with an error result and `sendEvent('failed')`).

This settlement gate is the crux of cancellation. It mirrors `CardActor.commitOutcome()`, which returns without sending an event when its cancellation flag is set. Without it, the loop's settle callback would queue a second event while `cancel` is pending and crash the actor main loop. The gate is the single place the `submit` promise settles, so a queued `cancel` can never collide with a normal completion. The gate also resets all per-turn session-actor state — the cancellation flag/reason, the stored promise resolver, the `onActivity` callback, and any tool-in-flight projection — so `idle` is a clean, reusable state that never carries stale turn data into the next `submit(...)` (a stale cancellation flag would otherwise stop the next turn immediately).

The loop body observes the cancellation flag before each provider turn and each tool dispatch; if it is set, the loop stops and hands control to the settlement gate. Cancellation therefore takes effect within one provider-call or tool-execution latency. It cannot preempt an in-flight provider call (see Cancellation And Shutdown), and it never rolls the transcript back. The design does not try to normalize every possible late interleaving into a perfectly matched caller result and transcript ending. Instead, the settlement gate guarantees a stable state: the caller receives one terminal result, the session actor returns to `idle`, any parked LLM turn is abandoned to `idle` in-memory, durable transcript rows already written remain the truth, and the next turn rebuilds context from that transcript. If the transcript contains an incomplete tool exchange, the provider gateway filters it when the next turn rebuilds context.

### LLMActor Usage

The session actor owns one LLM actor for the session, created lazily on the first turn and reused across turns. Its id is the canonical analyst session id (e.g. `analyst:global`, `analyst:telegram-<chatId>`), which already satisfies the `analyst:` LLM-actor id convention. It calls only public LLM-actor turn/tool-result APIs, exactly as the autonomous processors do, and never touches LLM-actor internals.

The analyst does not use the autonomous LLM-actor specialization unchanged. Today `LLMActor` writes an actor snapshot on every state change and builds active-reconstruction records so interrupted provider calls can be recovered; the analyst wants neither, because it has no mid-flight resume. The LLM actor is therefore split into a minimal conversation/provider engine (no snapshots, no active reconstruction) used by the analyst, and a recoverable specialization that adds snapshot persistence and active reconstruction for the autonomous card processors. This keeps the analyst out of the autonomous snapshot store and recovery substrate by construction, not by conditionally skipping them — which is also why cancel and shutdown have no analyst snapshot to clean up.

When an LLM actor is created with prior transcript context (after restart, or the first message to an existing session), its system-prompt-logged state is seeded from the transcript so the system-prompt row is not duplicated. This is a contract on the LLM-actor/context-loading path, not analyst-specific logic.

The LLM actor owns the master conversation transcript. Analyst-specific enrichment — workspace context, UI context, and external tool results — is fed into that transcript through LLM-actor-owned APIs or helper functions. There is no second AnalystSessionActor transcript writer and no reconciliation between two transcript authorities, and no terminal outcome (cancellation, error) writes a synthetic row.

### State, Projection, And Persistence

The session actor and its LLM actor keep state in memory only and write nothing to the autonomous snapshot store, so the analyst is absent from the autonomous `actorRuntime` projection and recovery by construction. Analyst projection is live and separate: `AnalystRuntime.listSessions()` reads the in-memory session actors directly (phase, tool in flight, last outcome). The control room composes this analyst read model alongside `actorRuntime`; the two are not merged.

This keeps the analyst out of the autonomous `actor_kind` vocabulary, out of autonomous recovery, and out of the snapshot schema. The LLM-actor-owned conversation transcript remains the single durable record of an analyst session.

### State Boundaries

The analyst uses parked states for what they are designed for: externally initiated transitions. `idle` is parked, and `submit(...)` advances it through `parkedSendEvent('submit')` with no task — the frozen-core main loop returns while parked and is re-entered by the parked event. The `Promise` `submit(...)` returns is not awaited here; its resolver is stored on the instance and settled later by the settlement gate. This is the same pattern `LLMActor` uses for `turn(...)` from `idle` and `appendToolResult(...)` from `waiting_tool`.

What parked states do **not** do is await async results. The only sanctioned way to scope an async await to a state is `runTask(...)`, which requires an active state and whose task is aborted on transition. The provider call is therefore awaited in the active `conversing` state through the promise returned by `llm.turn(...)` — the same promise side-channel pattern, used here for actor-to-actor composition with the owned LLM actor.

The session actor has no intra-turn external-command boundary (tools are dispatched by the session actor itself, not delivered by external events), so `idle` is the only parked state. This mirrors the autonomous processors, which run a whole activation in one active `executing` state and delegate the fine-grained `calling_provider`/`waiting_tool` sub-states to their owned `LLMActor`.

## The Conversation Loop

The analyst owns its conversation loop. It does **not** share a generic loop-control function with the autonomous processors. The autonomous `runContractBoundedRepairLoop` and the analyst loop have different domains — contract-terminal card activation with a bounded repair budget versus an open-ended user conversation with a fingerprint anti-loop — and collapsing them into one hook-driven engine would build a small workflow framework beside the actors, which is exactly the kind of abstraction to avoid.

What they share is the building blocks beneath the loop, which is where the real duplication was:

- the `LLMActor` for provider turns and tool waits;
- the `InvocationSurface` and its tool executor;
- the conversation store for transcript persistence;
- the micro-actor patterns (state machine, `runTask`, the promise side-channel).

The analyst loop itself stays analyst-specific. It drives `llm.turn(...)` / `llm.appendToolResult(...)` until the model returns a plain assistant message (`LLMActorOutcome` `result`), an error, or the cancellation flag is observed, and it enforces its own anti-loop rule: a tool call whose `(tool, arguments)` fingerprint repeats without an intervening change ends the turn by driving one final provider turn with a stop directive (through the existing tool-result/repair path), so the terminal no-progress message is a real provider output, not a synthesized row. That stop-directive turn is attempted once; if the model still returns a tool call instead of a terminal message, the turn ends immediately (the parked LLM turn is abandoned, the caller receives an error result with a no-progress reason, and the transcript keeps the honest record), so the anti-loop can never re-enter itself. There is no terminal contract tool and no repair budget. The loop is a method on the session actor (or a small analyst-specific helper it calls), not a shared abstraction.

## Composition Root: AnalystRuntime

`AnalystRuntime` replaces the actor-management role of `AnalystHandler`. It is constructed once at server startup with the project root, provider port, card store, process runner, MCP manager, config, and a reference to the autonomous `RuntimeApi` (so control tools can drive the runtime).

- `submit(sessionId, input, onActivity?): Promise<AnalystTurnResult>`. Get-or-create the session actor for `sessionId` (loading prior transcript context on first use) and delegate to its `submit(...)`, forwarding the optional `onActivity` callback. Returns the same promise as the session actor. Per-session serialization is the actor's responsibility; `AnalystRuntime` adds no queue.
- `cancel(sessionId, reason): boolean`. Look up the live session actor and call `cancel(...)`.
- `listSessions(): AnalystSessionReadModel[]`. Project live sessions and their phase for the operator read model.
- `shutdown(): Promise<void>`. Terminate operator-owned analyst processes per session through `ProcessRunner.stopByOwner(...)`. Analyst actors are in-memory only and die with the process; there are no snapshots to flush and no turns to drain.

`getAnalystHandler(...)` and the per-request handler construction disappear. A single `AnalystRuntime` instance is wired into the server composition root alongside the autonomous `RuntimeApplication`.

## Transport Adapters

The three transports become thin callers of `AnalystRuntime.submit(...)`:

- **WebSocket** (`analyst-ws-handler`): one session per connection, resolved on connect. Calls `submit(...)` with an `onActivity` callback that forwards each streaming event (`tool_call`/`tool_result`/`thinking`) over the socket, and awaits the returned promise to send the final message. Calls `cancel(...)` on socket close.
- **REST operator chat** (`operator-chat-handlers`): uses the global analyst session id. Calls `submit(...)` with no activity callback, awaits the promise, and returns the assistant message as the HTTP response.
- **Telegram bot**: uses `telegram-<chatId>` sessions. Same as REST: `await submit(...)`, map the result to an outbound Telegram message.

Because `submit(...)` returns the terminal result as a promise, REST and Telegram need no streaming/terminal-event machinery — they just `await` it. The actor keeps a single outbound shape (a promise plus an optional activity callback); there is no separate event channel to bridge.

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

Streaming activity (tool calls, tool results, thinking) reaches the initiating transport through the `onActivity` callback passed to `submit(...)`. The terminal result reaches it through the returned promise. The actor therefore has one outbound shape — a promise plus an optional callback — and does not know which transport initiated the turn. The session actor isolates `onActivity` callback exceptions (catches and logs them), so a transport callback failure can never fail the turn or corrupt the transcript.

The operator control room observes analyst sessions through a separate live read model: `AnalystRuntime.listSessions()` returns each session's phase (`idle`/`conversing`), the tool currently in flight, and the last outcome, read directly from the in-memory session actors (not the autonomous snapshot store). The control room composes this analyst read model alongside `actorRuntime`; the two are not merged. (Observing a foreign session's live streaming from the control room is not in scope here; see Open Questions.)

## Persistence And Recovery

- **Conversation transcript.** Persisted by the LLM actor through the existing conversation store, unchanged. This is the durable record of an analyst session and the single master transcript.
- **No actor snapshots.** Neither the session actor nor its LLM actor writes to the autonomous snapshot store (see LLMActor Usage). There is no stale-snapshot recovery problem and no analyst entry in autonomous recovery, by construction.
- **Turn recovery.** There is none. An interrupted analyst turn (server crash mid-turn) is abandoned on restart. The next message to that session id creates a fresh `idle` session actor with a fresh LLM actor, context loaded from the conversation transcript; the user re-asks. This is the conservative posture already used by the autonomous runtime for in-flight LLM work, and it is correct for a user-driven conversation: the transcript is the truth, not an in-flight provider call.
- **Process cleanup.** On restart, operator-owned analyst processes are handled by the existing `ProcessRunner` reconciliation (`owner_kind: 'operator'` → observed best-effort or marked lost). No new recovery path is introduced.

This deliberately mirrors the autonomous runtime's "no mid-flight resume for in-flight work" policy, and avoids inventing snapshot/recovery machinery for a control surface that is naturally reconstructed from its transcript.

## Concurrency And Serialization

- **One turn per session at a time.** Enforced by the `AnalystSessionActor` state machine: a session in `conversing` rejects a second `submit(...)` because the actor is not parked. The external `sessionQueues` promise chain is removed.
- **Many sessions in parallel.** Sessions are independent actors; the composition root does not lock across sessions.
- **Single pending event.** The frozen core allows exactly one pending event per actor. Because the session is single-turn-at-a-time, this is sufficient; no inbox or queue is added to the actor. (The now-deleted `SlaveActor` job queue is deliberately not reintroduced.)

## Cancellation And Shutdown

- `cancel(reason)` is primarily cleanup for disconnects and explicit user aborts. It marks the in-flight turn cancelled and queues `sendEvent('cancel')`. The conversation-loop settle callback checks the flag, abandons any parked LLM turn back to `idle` in-memory (the existing `abandon` transition), resolves the `submit` promise with a cancelled result, and sends no normal event, so the queued `cancel` dispatches cleanly back to `idle`. This is the same settlement discipline as `CardActor.commitOutcome()`.
- `cancel` does **not** abort the in-flight provider HTTP call. The frozen core cannot preempt a running `runTask`, and the LLM actor owns the provider call in its own active state. If late provider/tool activity already produced transcript rows, those rows remain. The cancelled promise result is the caller-facing status of the interrupted turn; the transcript is the durable truth. If cancellation leaves a `tool_call` without a result, the transcript keeps the honest record (no synthetic closure row); the LLM actor's parked turn is abandoned to `idle`, and the provider gateway filters the incomplete exchange on the next turn. True provider-call preemption would require extending the provider contract and is out of scope.
- WebSocket disconnect calls `cancel(...)` for that connection's session, so a closed tab resolves the in-flight turn cleanly rather than leaving it dangling. The underlying provider call, if any, still completes; any transcript-visible work it produced remains in the conversation.
- `AnalystRuntime.shutdown()` terminates operator-owned analyst processes per session. Analyst actors carry no persistent state, so there is nothing to flush, drain, or abandon — the actors die with the process. This is the analyst analogue of `SupervisorRuntimeApi.shutdown()` calling `ProcessRunner.stopRuntimeOwned(...)`, scoped to operator-owned analyst processes.

Cancellation that ends the turn without rolling back completed transcript work is the capability the actor model adds over the current imperative loop, which cannot express it at all.

## Relationship To Autonomous Processors

**Shared with autonomous card processors:**

- The LLM-actor conversation/provider engine (the minimal base; card processors add the recoverable specialization).
- The `InvocationSurface` and tool executor used to dispatch tools.
- The conversation store for LLM-actor-owned transcript persistence.
- The micro-actor patterns: state machine, `runTask(...)`, and the promise side-channel.
- The conservative "no mid-flight resume" recovery posture.
- The cancellation-gate settlement discipline (`commitOutcome`-style flag check in the task settle callback).

**Intentionally different from autonomous card processors:**

- The analyst is session-scoped, not card-scoped. There is no card, no activation outcome vocabulary, and no reviewer.
- The analyst owns its own conversation loop; it does not share a generic loop-control function with the contract-terminal bounded repair loop. The loops serve different domains.
- The analyst has no contract terminal tools; a turn ends on a plain assistant message. Its anti-loop guard is the fingerprint check, not a bounded repair budget.
- The analyst is operator-owned: it bypasses the autonomous `RuntimeGate` and spawns `owner_kind: 'operator'` processes.
- The analyst is projected live via `AnalystRuntime.listSessions()`; `onActivity` is per-turn streaming to the initiating transport, not a general projection channel. The analyst is not part of the autonomous snapshot store, `actor_kind` schema, or `actorRuntime` recovery.
- The analyst has no main-agent notification queue; continuation context is just the tool exchange.
- The analyst is user-driven (`submit` from external transports, advanced through parked states), not runtime-dispatched (`activate` from a parent card).
- The analyst uses the minimal LLM actor (no snapshots, no active reconstruction); card processors use the recoverable LLM-actor specialization.
- Both analyst and processors expose a promise-backed turn API built on the same side-channel pattern; the analyst's caller is a transport/composition root rather than a parent `CardActor`, but the API shape is identical.

The architecture — actors, the LLM-actor engine, the invocation surface, the store, the micro-actor patterns — is unified. The domain policy and the projection boundary stay separate, which is simpler than forcing them together.

## Invariants

- At most one analyst turn is active per session; a `submit(...)` while `conversing` is rejected because the actor is not parked.
- The transport↔session boundary uses the same promise side-channel as the rest of the actor system: `submit(...)` advances the parked `idle` actor via `parkedSendEvent` and returns a `Promise<AnalystTurnResult>` that the settlement gate resolves or rejects. Streaming activity flows only through the optional `onActivity` callback.
- The session↔LLM-actor boundary is actor-to-actor composition: the active `conversing` state awaits `llm.turn(...)` through a `runTask` promise.
- The analyst never waits on the autonomous `RuntimeGate`.
- Analyst-launched processes are always `owner_kind: 'operator'`.
- Control tools remain the only mutation surface; the `AnalystSessionActor` never mutates cards directly.
- Streaming activity flows to the initiating transport through the `onActivity` callback; session phase/state is projected live through `AnalystRuntime.listSessions()`. The actor and loop are transport-agnostic and are not coupled to the autonomous snapshot store.
- The conversation-loop settle callback is the single settlement gate: it checks the cancellation flag before sending any actor event and before settling the `submit` promise, so a queued `cancel` never collides with a normal `done`/`failed`.
- A cancelled turn resolves the `submit` promise exactly once with a cancelled result; completed transcript rows are preserved, any parked LLM turn is abandoned to `idle`, and incomplete tool exchanges are filtered by the provider gateway on the next turn. No synthetic closure row is written. The provider HTTP call itself is not aborted, and the system does not try to reconcile every late caller-result/transcript mismatch beyond preserving durable truth and returning actors to stable reusable states.
- The session actor and its LLM actor keep state in memory only; neither writes autonomous snapshots or participates in autonomous recovery.
- On restart, the next message for an analyst session creates fresh `idle` session and LLM actors using context loaded from the conversation transcript; in-flight turns are not resumed.
- The LLM-actor-owned conversation transcript is the single durable record of an analyst session.

## Open Questions

- Whether idle analyst sessions should be evicted after a bounded inactivity window to bound memory. If needed, eviction is memory-only: the transcript remains the single durable record and a fresh actor is rebuilt from it on the next message, so no second persisted "last seen" marker is introduced.
- Whether live streaming of a session the caller did not initiate (e.g. the control room watching an active turn) should be surfaced on the runtime event bus, or whether the `listSessions()` phase projection is enough.
- Whether the global REST analyst session and per-connection WebSocket sessions should converge on a single session model, or remain distinct to preserve the request/response semantics of the REST chat.
- Whether provider-call preemption is ever worth extending the provider contract for; until then, analyst cancellation shares the autonomous limitation that the underlying HTTP call is not aborted.
