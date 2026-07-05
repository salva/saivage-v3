# Tool Cancellation Design

Status: design proposal.

Date: 2026-07-05

## 1. Purpose

Today, cancellation does not reach tool executors. `CardActor.cancel()` cancels card state and stops activation-owned processes, but a long-running tool currently in progress may keep running until it returns. The analyst loop has dead cancellation checks (see [Analyst Actor Remediation](./analyst-actor-remediation.md) Issue 1). Tools cannot stop mid-execution when their activation or turn is cancelled.

This document specifies the smallest cancellation model: an `AbortSignal` on every tool executor, sourced from the activation owner (`CardActor` for autonomous processors, `AnalystSessionActor` for the analyst), plus one optional provider cleanup hook. Signal-aware tools stop immediately or register cleanup for resources they create; all others rely on between-step checks. The actor layer decides **that** cancellation or settlement happened. Tool providers decide **how** their resources are stopped.

This doc is the authority for *how tool execution is cancelled*. It modifies `ToolDefinition` from [Shared Tool Invocation Design](./shared-tool-invocation-design.md). The analyst-side implementation timeline is in [Analyst Actor Remediation](./analyst-actor-remediation.md) Issue 1; this doc specifies the autonomous-processor side and the shared tool-surface contract. The `replay` method added to `ToolDefinition` by [Interrupted Activation Recovery Design](./interrupted-activation-recovery-design.md) is unaffected — replay is a read-only operation that takes no signal.

## 2. The signal on `executor`

```ts
export interface ToolDefinition<Args = unknown> {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: z.ZodType<Args>;
  readonly executor: (args: Args, signal: AbortSignal) => Promise<ToolResult>;
  readonly replay?: (args: Args) => Promise<ToolReplayOutcome>;
}
```

`signal` is the second parameter, after `args`. Every executor accepts it. `invokeTool` and `invokeToolCall` gain a `signal` parameter they forward to the executor. All existing executors are updated to accept the parameter; signal-aware ones use it, the rest accept and ignore it.

The activation owner — not the tool — decides when to cancel. The tool reacts to the signal if it has an in-flight operation worth aborting. The `replay` method defined in the recovery design is separate and takes no signal.

Providers that own durable or long-lived resources may also expose cleanup:

```ts
export interface ToolProvider {
  readonly providerName: string;
  readonly tools: readonly ToolDefinition<any>[];
  cleanup?(reason: ToolProviderCleanupReason): Promise<void>;
}

export type ToolProviderCleanupReason =
  | { kind: 'activation_settled'; status: 'done' | 'blocked' | 'failed' | 'cancelled' }
  | { kind: 'session_closed' }
  | { kind: 'runtime_shutdown' };
```

Most providers do not implement `cleanup`. `ProcessProvider` does.

**Provider instances are per-owner.** Each activation/session constructs its own provider instances with closed-over owner identity (`activationId` or `sessionId`). `cleanup(...)` acts only on the closed-over owner scope — no owner identity is needed in the reason.

## 3. Autonomous processor cancellation

### 3.1 AbortController per activation

`CardActor` owns an `AbortController` per activation:

```ts
#activationAbort: AbortController | null = null;
```

`_on_enter__running` creates it and passes the signal to the processor:

```ts
this.#activationAbort = new AbortController();
this.runTask(async () => {
  await this.deps.gate?.waitUntilOpen();
  return this.processor.activate(input, this.#activationAbort.signal);
}, { on_done, on_failed });
```

`cancel()` aborts it immediately:

```ts
this.#activationAbort?.abort(reason);
```

The abort fires during `cancel()`, not on state transition. This is the same insight as the analyst side: the frozen-core `runTask` signal fires only when the task settles — too late for mid-execution cancellation.

### 3.2 Signal flow through the processor

`CardProcessorActor.activate(input, signal)` receives the signal. `BaseMainLLMCardProcessorActor` stores it for the activation's duration and passes it to the `LLMActor`. The `LLMActor` forwards it into `provider.completeTurn(input, signal)`.

The processor checks `signal.aborted` at two points in the loop:

- **Before each `llm.turn()` / `llm.appendToolResult()`**: if aborted, the loop exits with a cancelled outcome.
- **Before each `handleToolCall()`**: if aborted, the loop skips the dispatch and exits.

When dispatching a tool call: `handleToolCall` passes the signal to `invokeToolForLlm(surface, name, args, signal)`, which forwards it to `executor(args, signal)`.

If the signal fires while a tool or provider call is in flight, the operation throws `AbortError`. The error propagates to the processor — it is **not** caught by the invocation layer. The processor catches the `AbortError`, checks `signal.aborted`, recognizes cancellation, and exits with a cancelled outcome. Cancellation never becomes a `ToolResult` and never enters the model transcript.

On activation settlement (`done`, `blocked`, `failed`, or `cancelled`), the processor calls `cleanup(...)` on the providers used by that activation. This is the only settlement cleanup API; the actor does not know process internals.

### 3.3 What happens when the signal fires mid-operation

Signal-aware tools (`run_command`, `webfetch`, `websearch`) and provider calls abort immediately. The `AbortError` propagates through `invokeTool` — the invocation layer does **not** catch it and does **not** convert it to a `ToolResult`. The processor catches the `AbortError`, checks `signal.aborted`, and exits with a cancelled outcome.

**Invariant: cancellation never enters the model transcript.** The processor checks `signal.aborted` after every tool dispatch and after every provider turn. If aborted, it exits the loop without calling `appendToolResult`. The model never sees a tool error or provider error caused by cancellation.

Non-signal-aware tools complete naturally. After they return, the processor checks `signal.aborted` before the next step and exits.

### 3.4 Provider calls are signal-aware

The activation signal flows from the processor into the `LLMActor`, which passes it to `provider.completeTurn(input, signal)`. When the signal fires, the provider call aborts — the HTTP request is dropped and `AbortError` propagates to the processor.

The `LLMActor` must pass the **activation signal**, not the frozen core's `runTask` signal. The `runTask` signal fires on state transition, which happens after the provider call returns — too late for mid-call cancellation (same insight as the analyst side, `analyst-actor-remediation.md` Issue 1). The `LLMActor` composes both via `AbortSignal.any([runTaskSignal, activationSignal])` so framework lifecycle and cancellation both work.

### 3.5 Process cleanup belongs to ProcessProvider

Two mechanisms serve two different purposes:

- **Signal** — "stop what you are doing right now." Passed to `child_process.spawn({ signal })` for the current spawn, to `fetch({ signal })` for the current HTTP request, checked in `wait_process`'s polling loop. The signal fires on `cancel()`.
- **Cleanup hook** — "clean up durable resources you left behind." `ProcessProvider.cleanup({ kind: 'activation_settled', ... })` stops any remaining process records owned by the activation. Called on settlement (done, blocked, failed, or cancelled). Analyst/session cleanup uses `session_closed`.

`CardActor.cancel()` does not call `ProcessRunner.stopByOwner`. It aborts the signal (stops the current tool operation) and lets settlement call provider cleanup (stops durable resources). The actor layer never touches process internals.

### 3.6 cancelDescendants

`CardActor.cancelDescendants()` iterates children and calls `child.cancel()` on each. Each child has its own `#activationAbort`. The parent's signal does NOT propagate to children — each child's own `cancel()` is the propagation path. This is the same tree-recursive cancellation model as today.

## 4. Signal-aware tools

| Tool | Signal usage |
| --- | --- |
| `run_command` | Pass to `child_process.spawn({ signal })` for the current spawn. Background processes are stopped by provider cleanup on settlement. |
| `wait_process` | Check `signal.aborted` in the polling loop. Return early if aborted. |
| `websearch` / `webfetch` | Pass to `fetch({ signal })`. The HTTP request aborts. |
| All others (`read`, `write`, `glob`, `grep`, `apply_patch`, `create_card`, `activate_card`, etc.) | Accept and ignore. Between-step checks by the processor handle cancellation. |

Provider calls are also signal-aware: `provider.completeTurn(input, signal)` aborts the HTTP request when the signal fires (see §3.4).

## 5. Analyst cancellation

The analyst cancellation model is specified in [Analyst Actor Remediation](./analyst-actor-remediation.md) Issue 1. Summary: `AnalystSessionActor` creates a per-turn `AbortController`. `cancel()` sets `cancellationReason`, aborts the controller, resolves the caller promise, and queues `sendEvent('cancel')`. The loop passes `controller.signal` to `invokeToolCall`. The settlement gate resets all per-turn state.

The analyst model and the autonomous model share the same tool-surface contract: `executor(args, signal)`. The signal source differs (per-turn for analyst, per-activation for autonomous) but the executor sees the same `AbortSignal` type either way.

## 6. Interaction with recovery

If a card was being cancelled when the process died, the card store may show `cancelled` while the actor snapshot shows `running` with an active `LLMActor`. Recovery trusts the **card store** as authoritative: a `cancelled` card is terminal and is never resumed, regardless of stale actor snapshots. Stale actor snapshots for terminal cards are cleaned up by the defensive tail (`abandonStalePendingToolCalls` + recovery diagnostics).

If the card store shows `running` (cancellation had not persisted), recovery reconstructs the `running` card per the normal reconstruct-and-resume model. The `#activationAbort` is recreated fresh — prior cancellation intent is lost. This is correct: the cancellation did not complete before shutdown, so the card continues.

## 7. Removal

- `CardActor.cancel()`: create/abort `#activationAbort`; remove direct `processRunner.stopByOwner(activationId, ...)` from the actor layer.
- `CardProcessorActor.activate(input)`: signature gains `signal: AbortSignal`.
- `BaseMainLLMCardProcessorActor`: store activation signal; pass it to the `LLMActor`; pass to `invokeToolForLlm` in `handleToolCall`; check `signal.aborted` before each `llm.turn()` / `llm.appendToolResult()` and before each tool dispatch; call provider `cleanup(...)` on activation settlement.
- `LLMActor._on_enter__calling_provider`: pass the activation signal to `provider.completeTurn`, composed with the `runTask` signal via `AbortSignal.any(...)`. The `runTask` signal alone is insufficient — it fires on state transition, too late for mid-call cancellation.
- `invokeTool` / `invokeToolForLlm` / `invokeToolCall`: gain `signal` parameter, forward to executor. `invokeToolForLlm` must **not** catch `AbortError` — let it propagate to the processor as a cancellation signal. Other exceptions continue to be caught per the shared invocation contract.
- All `defineTool` executor functions: accept `signal` parameter.
- All analyst catalog executors (`analyst-misc-tools.ts`, `analyst-card-tools.ts`, `analyst-workspace-tools.ts`): accept `signal` parameter; the analyst handler wrapper forwards it.

## 8. Validation

- `run_command` with `wait=false` → cancel after launch while another tool/provider call is in flight → current spawn (if any) observes the signal; remaining owned processes stopped by provider `cleanup(...)` on settlement.
- `webfetch` → cancel mid-fetch → request aborted, executor returns early.
- Cancel during `calling_provider` → provider call completes, processor checks signal before next turn, exits with cancelled outcome.
- Cancel during `waiting_tool` (between tool dispatch and `appendToolResult`) → processor checks signal before next step, exits.
- `cancelDescendants` → each child's own `#activationAbort` fires independently.
- Process cleanup: signal stops the current spawn/wait; provider `cleanup(...)` stops remaining owned processes on activation/session settlement. Verify no orphaned processes after cancelled or settled activation.
- Recovery: card `cancelled` in store, snapshot shows `running` → recovery does not resume; defensive tail cleans up.
- Recovery: card `running` in store, prior cancellation did not persist → reconstructed and resumed; fresh `AbortController`.

## 9. Explicit Decisions

1. `signal: AbortSignal` is the second parameter on every `executor`. All executors are updated — no exceptions, no backward-compatibility framing.
2. `CardActor` owns a per-activation `AbortController`, aborted immediately in `cancel()`. The framework's `runTask` signal is not used for cancellation probing (fires too late).
3. The processor checks `signal.aborted` before each provider turn and tool dispatch. Provider calls and signal-aware tools abort immediately when the signal fires; non-signal-aware tools complete naturally. The `AbortError` propagates to the processor — it is never caught by the invocation layer and never becomes a `ToolResult`.
4. Signal-aware tools stop immediately. Non-signal-aware tools complete; the processor exits at the next between-step check.
5. Process cleanup belongs to `ProcessProvider`: `CardActor.cancel()` only aborts the activation signal. `run_command` observes the signal for the current spawn/wait. Provider `cleanup(...)` handles durable resource cleanup on activation/session settlement.
6. `replay` does not take a signal — it is a read-only operation.
7. The card store is authoritative for card status. Stale actor snapshots for terminal cards are cleaned up, not resumed.
8. Each child in `cancelDescendants` gets its own `cancel()` with its own `AbortController`. The parent's signal does not propagate to children directly.
