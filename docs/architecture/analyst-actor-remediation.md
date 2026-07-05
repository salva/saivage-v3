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

Add a plain `cancellationReason: string | null` field on `AnalystSessionActor`. `cancel()` sets it. The loop checks it before each provider turn and each tool dispatch. When set, the loop returns immediately with a cancelled result; it does not throw — the task settles as `on_done`, the settlement gate sees the flag, and the queued `cancel` dispatches.

The `AbortSignal` from `runTask` is no longer used for cancellation probing. It remains available for provider-call propagation if that is ever added, but the loop does not check `signal.aborted`.

Cancellation timeline:
1. Provider call or tool execution in progress.
2. `cancel()` sets `cancellationReason`, resolves caller promise, queues `sendEvent('cancel')`.
3. Current step completes.
4. Loop checks `cancellationReason` before the next step. It is set. Loop returns cancelled result.
5. Task settles. `on_done` checks `pendingTurn` — already nulled by `cancel()`. Returns without sending event.
6. Main loop picks up queued `cancel`. Dispatches. Transitions to `idle`.

This gives cancellation latency of at most one provider call or one tool execution — exactly what the original design specified.

### Settlement Gate: Use A Dedicated Flag

Replace the current `pendingTurn !== turn` identity check with an explicit `cancellationReason` field, matching `CardActor.#cancellation`. This is more readable and resets cleanly.

`cancel()`:
1. Set `cancellationReason = reason`.
2. Resolve `pendingTurn` promise with a cancelled result.
3. Set `pendingTurn = null`.
4. If owned LLM is parked in `waiting_tool`, call `abandonParkedTurn()`.
5. `sendEvent('cancel')`.

`on_done(result)` / `on_failed(error)` (the settlement gate):
1. If `cancellationReason !== null`, return without sending an event or settling the promise (already settled by `cancel()`). The queued `cancel` dispatches.
2. Otherwise resolve/reject `pendingTurn`, set `pendingTurn = null`, send `done`/`failed`.

Reset at settlement: `cancellationReason = null`, `toolInFlight = null`. This guarantees `idle` never carries stale cancellation state into the next turn.

## Issue 2: Out-Of-Band Transcript Writes

### Problem

`AnalystLoopRunner` writes transcript rows directly via `appendAssistantTextMessage` in four paths: unsupported action, no-progress, error response, and partial-success contract text. The design says the LLM actor is the sole transcript writer and no terminal outcome writes a synthetic row.

### Target

Remove all direct transcript writes from session-side code. Each path is handled as follows:

**Error response**: The `ConversationLLMActor` already writes an error row via `appendLlmTurnError` when the provider call fails. The loop maps the error outcome to an `AnalystResponse` for the caller but does not write a second row. If `actor.turn(...)` rejects (precondition failure, not a provider error), there is no transcript row to write — the loop returns the error text to the caller only.

**No-progress (fingerprint repeat)**: The design specifies driving one final provider turn with a stop directive through the existing tool-result/repair path, so the terminal message is a real provider output. The loop appends a stop-directive tool result via `actor.appendToolResult(toolCallId, stopDirectiveResult)`, lets the LLM actor produce the final message, and returns that. If the model still returns a tool call after the stop directive, the loop ends immediately and returns an error result to the caller — the transcript keeps the honest record.

**Unsupported action**: Feed a repair directive back to the LLM actor via `appendToolResult`, not a synthesized assistant row. The LLM actor continues the turn. This mirrors the autonomous repair pattern (`continueAfterPlainText` / `appendToolResult` with a directive).

**Partial-success contract text**: Do not persist. The tool result is already in the transcript via the LLM actor's tool-delivery path. The formatted partial-success text is a caller-facing presentation concern, returned in `AnalystResponse` but not written to the conversation store.

`appendAssistantTextMessage` and `errorResponse` (in their current form) are removed from session-side code. The LLM actor's existing transcript paths cover all durable writes.

## Issue 3: ConversationLLMActor Carries Dead Reconstruction Weight

### Problem

`ConversationLLMActor` (the minimal base) still has the `activeReconstruction` field, `snapshot()` method, and four no-op protected overrides for reconstruction. This is conditionally skipping recovery via inheritance no-ops, not removing it by construction.

### Target

Move all reconstruction concern to `LLMActor`:

- Remove `activeReconstruction` field from `ConversationLLMActor`. Move it to `LLMActor`.
- Remove `snapshot()` from `ConversationLLMActor`. Move it to `LLMActor` (only autonomous LLM actors are snapshotted).
- Remove the four no-op overrides (`persistState`, `prepareTurnReconstruction`, `updateActiveReconstruction`, `prepareProviderCallReconstruction`) from the base.
- Replace direct `this.activeReconstruction = null` writes in base methods (`completeWithProviderResult`, `completeWithError`, `abandonParkedTurn`) with a single protected hook `clearTurnReconstruction()` that the base implements as empty and `LLMActor` overrides to clear its own field.

`ConversationLLMActor` becomes a truly minimal conversation/provider engine: provider calls, tool waits, transcript writes, state machine. No recovery fields, no snapshot method, no no-op overrides.

`LLMActor` adds snapshot persistence and active reconstruction as a cohesive recovery specialization. It overrides `clearTurnReconstruction` and the state-change hook to add persistence.

## Issue 4: toolInFlight Projection Is A Stub

### Problem

`readModel()` always returns `toolInFlight: null`. The design's read model includes the tool currently in flight.

### Target

`AnalystSessionActor` tracks `toolInFlight: string | null`. The loop sets it to the tool name before dispatching each tool call and clears it after the tool returns. The settlement gate resets it to `null`. `readModel()` reads the field directly.

## Structural Recommendation: Dissolve AnalystLoopRunner

### Current State

`AnalystLoopRunner` is a 220-line non-actor class that carries session state (project root, config, runtime deps, surface, actor role) and the conversation loop. `AnalystSessionActor` constructs one per instance and delegates the loop to it via `runTask`.

### Problem

This reintroduces the "plain class with an imperative loop" that the design called out as the largest parallel approach to the micro-actor runtime. The indirection adds no value: the loop runner has no independent lifecycle, no independent state machine, and no caller other than the session actor.

### Target

Dissolve `AnalystLoopRunner` into `AnalystSessionActor`. The loop, tool-surface building, context building, and error mapping become private methods on the session actor. The session actor owns the loop, the LLM actor, the cancellation flag, the tool-in-flight tracker, and the settlement gate as a single cohesive unit.

This is consistent with the autonomous side, where `CardActor` owns the processor invocation and outcome settlement directly.

`AnalystRuntime.getAvailableToolNames()` currently constructs a throwaway `AnalystLoopRunner` to list tools. After dissolution it calls a static or free function that builds the analyst tool surface without requiring a full actor instance.

## Summary Of Changes

| Issue | What Changes |
| --- | --- |
| Loop cancellation | Add `cancellationReason` flag; loop checks it before each provider turn and tool dispatch |
| Settlement gate | Replace identity check with explicit flag, matching `CardActor.#cancellation` |
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
