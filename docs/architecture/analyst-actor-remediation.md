# Analyst Actor Remediation

Status: target design. This document supersedes specific sections of `analyst-actor-design.md` where the implementation diverged during the initial landing. It describes only the changes; everything else in the original design stands.

Date: 2026-07-05.

## Context

The initial implementation (`8ed2c6d9`) landed the `AnalystSessionActor`, `AnalystRuntime`, `ConversationLLMActor`/`LLMActor` split, and transport wiring. Review found four divergences from the design that need correction. This document specifies the target for each.

## What Already Works (No Change Needed)

The settlement-gate pattern already matches `CardActor`:
- `cancel()` resolves the caller promise and queues `sendEvent('cancel')`.
- `on_done`/`on_failed` return without sending when the turn was already cancelled.
- The queued `cancel` then dispatches cleanly back to `idle`.

The `AnalystSessionActor` state machine (`idle` parked, `conversing` active), the promise side-channel, the `ConversationLLMActor`/`LLMActor` split preventing analyst snapshots, system-prompt-logged seeding from transcript, and transport session convergence are all correct.

## Issue 1: The Loop Does Not Observe Cancellation

### Problem

`cancel()` resolves the caller promise but the conversation loop (`AnalystLoopRunner.runAnalystLoop`) keeps running to completion. The `signal.aborted` checks in the loop are dead code: the `AbortSignal` from `runTask` is tied to the frozen core's `AbortController`, which is only aborted on state transition — and the state has not transitioned yet (the `cancel` event is queued, not dispatched, until the task settles). So every provider call and tool dispatch after cancellation runs uselessly.

### Target

Two mechanisms work together: a `cancellationReason` flag for between-step checks, and a per-turn `AbortSignal` for mid-tool cancellation. The signal flows into tool executors, so long-running tools (process spawns, HTTP requests) can stop immediately instead of running to completion.

**Tool-surface change (defined in `interrupted-activation-recovery-design.md` §3.10):**

The `executor` signature gains an `AbortSignal` parameter, complementing `replay`. Together they give the tool surface authority over all three phases of a tool call: invocation (`executor`), interruption (`signal`), and recovery (`replay`). Signal-aware tools (`run_command`, `webfetch`, etc.) stop immediately when cancelled; fast tools ignore the signal and rely on between-step flag checks.

**Analyst session actor:**

`AnalystSessionActor` creates a per-turn `AbortController`. The loop passes `controller.signal` to `invokeToolCall`. The loop also checks `cancellationReason` before each provider turn and each tool dispatch as a fallback for tools that don't check the signal.

The `AbortSignal` from the frozen core's `runTask` is NOT used for cancellation probing. It is tied to the frozen core's `AbortController`, which is only aborted on state transition — too late. The session actor's own controller is the propagation path.

The owned LLM actor may be in `calling_provider` when `cancel()` is called. The provider call completes, the LLM transitions to `waiting_tool` (tool call) or `idle` (message/error), and then the loop observes the flag and stops. At that point the LLM may be parked in `waiting_tool`. Abandonment must therefore happen in the settlement gate, not in `cancel()`.

Cancellation timeline:
1. Provider call or tool execution in progress.
2. `cancel()` sets `cancellationReason`, aborts `turnAbort`, resolves caller promise, queues `sendEvent('cancel')`.
3. If a signal-aware tool is in flight, it receives the abort and returns early with an aborted error. Otherwise the current step completes naturally.
4. Loop checks `cancellationReason` before the next step. It is set. Loop returns cancelled result.
5. Task settles. Settlement gate sees `cancellationReason`, abandons any parked LLM turn, resets per-turn state, sends no event.
6. Main loop picks up queued `cancel`. Dispatches. Transitions to `idle`.

This gives cancellation latency of at most one provider call (which is not abortable) or near-zero for signal-aware tools — better than the "one step" bound from the original design.

### Settlement Gate: Use A Dedicated Flag

Replace the current `pendingTurn !== turn` identity check with an explicit `cancellationReason` field, matching `CardActor.#cancellation`. This is more readable and resets cleanly.

`cancel()`:
1. Set `cancellationReason = reason`.
2. Abort `turnAbort` with the reason (triggers signal-aware tools to return early).
3. Resolve `pendingTurn` promise with a cancelled result.
4. Set `pendingTurn = null`.
5. `sendEvent('cancel')`. Do not touch the owned LLM here — it may be mid-provider-call and its final state is not yet known.

`on_done(result)` / `on_failed(error)` (the settlement gate):
1. If `cancellationReason !== null`: abandon any parked LLM turn via `abandonParkedTurn()` (the LLM may have transitioned to `waiting_tool` after `cancel()` ran), reset `cancellationReason = null`, `toolInFlight = null`, `turnAbort = null`, and return without sending an event. The promise was already settled by `cancel()`. The queued `cancel` dispatches.
2. Otherwise: resolve/reject `pendingTurn`, set `pendingTurn = null`, reset `toolInFlight = null`, `turnAbort = null`, send `done`/`failed`.

Both paths reset all per-turn state. `idle` never carries stale cancellation state into the next turn.

## Issue 2: Out-Of-Band Transcript Writes

### Problem

`AnalystLoopRunner` writes transcript rows directly via `appendAssistantTextMessage` in four paths: unsupported action, no-progress, error response, and partial-success contract text. The design says the LLM actor is the sole transcript writer and no terminal outcome writes a synthetic row.

### Target

Remove all direct transcript writes from session-side code. Each path is handled as follows:

**Error response**: The `ConversationLLMActor` already writes an error row via `appendLlmTurnError` when the provider call fails. The loop maps the error outcome to an `AnalystResponse` for the caller but does not write a second row. If `actor.turn(...)` rejects (precondition failure, not a provider error), there is no transcript row to write — the loop returns the error text to the caller only.

**No-progress (fingerprint repeat)**: The design specifies driving one final provider turn with a stop directive through the existing tool-result/repair path, so the terminal message is a real provider output. The loop appends a stop-directive tool result via `actor.appendToolResult(toolCallId, stopDirectiveResult)`, lets the LLM actor produce the final message, and returns that. If the model still returns a tool call after the stop directive, the loop ends immediately and returns an error result to the caller — the transcript keeps the honest record.

**Unsupported action**: Feed a repair directive back to the LLM actor via `appendToolResult`, not a synthesized assistant row. The LLM actor continues the turn. This mirrors the autonomous repair pattern (`continueAfterPlainText` / `appendToolResult` with a directive).

**Partial-success contract text**: Do not persist as a separate transcript row. The tool result is already in the transcript via the LLM actor's tool-delivery path. The formatted partial-success text is returned to the caller as tool-invocation presentation metadata, not as a synthesized assistant `message`. The caller sees it as part of the tool result projection, not as a chat message that would need transcript continuity.

`appendAssistantTextMessage` and `errorResponse` (in their current form) are removed from session-side code. The LLM actor's existing transcript paths cover all durable writes.

## Issue 3: ConversationLLMActor Carries Dead Reconstruction Weight

### Problem

`ConversationLLMActor` (the minimal base) still has the `activeReconstruction` field, `snapshot()` method, and four no-op protected overrides for reconstruction. This is conditionally skipping recovery via inheritance no-ops, not removing it by construction.

### Target

Move all reconstruction concern to `LLMActor`:

- Remove `activeReconstruction` field from `ConversationLLMActor`. Move it to `LLMActor`.
- Remove `snapshot()` from `ConversationLLMActor`. Move it to `LLMActor` (only autonomous LLM actors are snapshotted).
- Remove `persistState` and the three reconstruction methods (`prepareTurnReconstruction`, `updateActiveReconstruction`, `prepareProviderCallReconstruction`) from the base entirely.
- Replace direct `this.activeReconstruction = null` writes in base methods (`completeWithProviderResult`, `completeWithError`, `abandonParkedTurn`) with a single protected lifecycle hook `clearTurnReconstruction()`. The base implementation is empty; `LLMActor` overrides it to clear its own `activeReconstruction` field and persist a snapshot. This is a generic lifecycle hook (like `_on_state_changed`), not a reconstruction-specific no-op: the base class has no knowledge of recovery.

`ConversationLLMActor` becomes a truly minimal conversation/provider engine: provider calls, tool waits, transcript writes, state machine, and one generic lifecycle hook. No recovery fields, no snapshot method, no reconstruction API.

## Issue 4: toolInFlight Projection Is A Stub

### Problem

`readModel()` always returns `toolInFlight: null`. The design's read model includes the tool currently in flight.

### Target

`AnalystSessionActor` tracks `toolInFlight: string | null`. The loop sets it to the tool name before dispatching each tool call and clears it after the tool returns. The settlement gate resets it to `null`. `readModel()` reads the field directly.

## Required Structural Change: Dissolve AnalystLoopRunner

### Current State

`AnalystLoopRunner` is a 220-line non-actor class that carries session state (project root, config, runtime deps, surface, actor role) and the conversation loop. `AnalystSessionActor` constructs one per instance and delegates the loop to it via `runTask`.

### Problem

This reintroduces the "plain class with an imperative loop" that the design called out as the largest parallel approach to the micro-actor runtime. The indirection adds no value: the loop runner has no independent lifecycle, no independent state machine, and no caller other than the session actor.

### Target

Dissolve `AnalystLoopRunner` into `AnalystSessionActor`. The loop, tool-surface building, context building, and error mapping become private methods on the session actor. The session actor owns the loop, the LLM actor, the cancellation flag, the tool-in-flight tracker, and the settlement gate as a single cohesive unit.

This is consistent with the autonomous side, where `CardActor` owns the processor invocation and outcome settlement directly.

`AnalystRuntime.getAvailableToolNames()` currently constructs a throwaway `AnalystLoopRunner` to list tools. After dissolution it calls a free function that builds the analyst tool surface without requiring a full actor instance.

## Summary Of Changes

| Issue | What Changes |
| --- | --- |
| Loop cancellation | Per-turn `AbortController` aborted by `cancel()`; signal flows to tool executors; `cancellationReason` flag checked between steps as fallback |
| Tool surface | `executor` gains `AbortSignal` parameter — defined in `interrupted-activation-recovery-design.md` §3.10 |
| Settlement gate | Explicit `cancellationReason` flag matching `CardActor.#cancellation`; both paths reset all per-turn state |
| Transcript writes | Remove `appendAssistantTextMessage`; feed repair directives through LLM actor; don't persist partial-success or duplicate error rows |
| ConversationLLMActor | Move `activeReconstruction`, `snapshot()`, and reconstruction methods to `LLMActor`; base is truly minimal |
| toolInFlight | Track and project the tool currently being dispatched |
| AnalystLoopRunner | Dissolve into `AnalystSessionActor`; loop and helpers become private methods |

## What Does Not Change

- `AnalystSessionActor` state machine: `idle` (parked) / `conversing` (active).
- Promise side-channel for `submit(...)`.
- `ConversationLLMActor`/`LLMActor` inheritance split (just cleaned up).
- Analyst bypasses autonomous `RuntimeGate`; processes are `owner_kind: 'operator'`.
- REST/WS share `analyst:global`; Telegram is per-chat.
- Live in-memory LLM context is master; disk transcript is durable reconstruction record.
- No analyst snapshots, no analyst recovery, no mid-flight resume.
