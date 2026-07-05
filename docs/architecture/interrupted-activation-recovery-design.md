# Interrupted Activation Recovery Design

Status: design proposal.

Date: 2026-07-05

## 1. Purpose

When the runtime stops while cards are `running`, their activations are interrupted mid-flight: processors are inside their tool loops, `LLMActor`s are parked in `waiting_tool` or `calling_provider`, and provider tool calls are pending without delivered results. On the next startup, these interrupted activations must be recovered.

Today `runActorStartupRecovery` in `src/runtime/actors/actor-recovery.ts` handles this as a **settlement** problem: it changes card statuses (blocks or reopens them), synthesizes tool results in recovery-specific code, and lets the supervisor re-drive cards from scratch via fresh activations. The band-aid (`recoverActorBackedToolCalls`, lines 299-352) hardcodes `activate_card` reconstruction inside the recovery layer. Interrupted work — the accumulated LLM context, the in-flight tool sequence, the processor loop position — is discarded.

This document specifies the replacement: **reconstruct the same actor state the runtime had before shutdown, settle pending tool calls in place, start paused, then unpause to continue.** Cards that were `running` stay `running`. `LLMActor`s that were `waiting_tool` are reconstructed as `waiting_tool`. The activation resumes from where it stopped, not from a fresh start.

This doc is the authority for *how interrupted activations and their pending tool calls are recovered*. It sits below [Shared Tool Invocation Design](./shared-tool-invocation-design.md) and beside [Root Settlement and Planner Recovery Plan](./root-settlement-and-planner-recovery-plan.md). Terminal tool projection (`recoverProjectedTerminalToolOutcomes`) is unaffected: terminal tools are processor-loop contract logic, not provider tools. Terminal projection does not violate "reconstruct, don't transform" — it completes a terminal outcome the model already emitted before shutdown. The card status change (`running` → `done`/`blocked`/`failed`) is the delayed effect of a decision already made, not a recovery-layer invention.

## 2. Why settlement is the wrong model

The current recovery architecture treats interruption as something to clean up and re-drive:

- `convertActorRecoveryOutcomes` **blocks** every `running` card whose activation was interrupted. The operator must manually reactivate.
- `recoverActorBackedToolCalls` (the band-aid) **reopens** `activate_card` calls specifically: it synthesizes a tool result from the child card lifecycle and flips the parent to `changed`. The supervisor then re-activates the parent from scratch — a fresh `LLMActor`, a fresh context, the prior turn's accumulated work discarded.
- `abandonStalePendingToolCalls` marks all other pending tool calls `abandoned`.

This is fundamentally a discard-and-restart model. It changes card statuses, discards in-flight processor state, and puts reconstruction logic in the recovery layer where it doesn't belong (hardcoded tool names, synthetic delivery ids, lifecycle mutations).

The clean model is the opposite: **don't change anything, just recreate it and continue.**

## 3. Design: reconstruct and resume

### 3.1 Recovery reconstructs, does not transform

Recovery reconstructs the actor tree from snapshots exactly as it was before shutdown:

- Cards keep their pre-shutdown status. A `running` card stays `running`. A `changed` card stays `changed`. Recovery does not block, reopen, or change any card status.
- `CardActor`s are recovered into their pre-shutdown actor state via `CardActor.fromCard` + `actor.recover(...)`.
- `LLMActor`s are reconstructed from active-reconstruction snapshots in their pre-shutdown state (`waiting_tool` or `calling_provider`).
- Processor active-reconstruction records are restored.

The supervisor then resumes `running` cards by re-entering their processor activations — not by creating fresh activations. The processor picks up the reconstructed `LLMActor` and continues the loop from its current state.

**Contingency repair path.** Normal recovery never changes card lifecycle state. If a `running` card has corrupt, missing, or internally inconsistent active-reconstruction state, exact resume is impossible. Recovery then enters the contingency repair path, which restores the affected card/subtree to the nearest stable state from which execution can continue:

1. **Complete an already-determined transition** if enough evidence exists (e.g., the LLM emitted a terminal outcome before shutdown but the card status was not yet persisted).
2. **Backtrack to a previous stable executable state** if the current state is unrecoverable but a prior checkpoint is sound.
3. **Block with diagnostics** if operator input is needed to determine the correct repair.
4. **Fail** only for hard irrecoverable conditions where no safe continuation or operator-actionable stable state exists.

Each contingency repair records a diagnostic explaining why exact reconstruction was impossible and what repair was applied. This path is for corrupted persisted state only; it is never used for ordinary interrupted activations.

### 3.2 The gate is the pause boundary

The runtime starts with the gate **closed** (paused). All provider calls pass through `gate.waitUntilOpen()` before executing (`src/runtime/actors/llm-actor.ts:142`). While the gate is closed:

- Recovery reconstructs the actor tree.
- Recovery settles pending tool calls (§3.3).
- Recovery re-issues lost provider calls (§3.4).
- The supervisor wires up the reconstructed actors.
- The operator can inspect the recovered state.

When the gate opens (unpause), every waiting provider call proceeds. The activations continue from where they stopped. The gate is the single synchronization point; there is no separate "recovery mode" flag.

### 3.3 Settling pending tool calls via replay

For each `LLMActor` reconstructed in `waiting_tool`, the pending tool call needs a result so the activation can continue. Recovery settles it using an optional **`replay`** method on `ToolDefinition`:

```ts
export type ToolReplayOutcome =
  | { kind: 'settled'; result: ToolResult }
  | { kind: 'redispatch' };

export interface ToolDefinition<Args = unknown> {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: z.ZodType<Args>;
  readonly executor: (args: Args, signal: AbortSignal) => Promise<ToolResult>;
  readonly replay?: (args: Args) => Promise<ToolReplayOutcome>;
}
```

`replay` takes only the original `args` (same type as `executor`, inferred from the same schema). No recovery context envelope — no `agentId`, `sourceInputId`, `toolCallId`. It closes over the provider's existing `projectRoot`-keyed context and reads durable state.

The `signal` parameter on `executor` is a runtime cancellation concern, not a recovery one. It is specified in [Tool Cancellation Design](./tool-cancellation-design.md). `replay` does not take a signal — it is a read-only operation with no side effects to cancel.

- **`{ kind: 'settled', result }`** — durable state determines the result. Recovery delivers it via `llm.appendToolResult(toolCallId, result)`. The `LLMActor` transitions to `calling_provider` and waits at the gate. When the gate opens, the provider call proceeds and the model sees the settled result in its continued turn.
- **`{ kind: 'redispatch' }`** — the tool's operation is still genuinely in progress (e.g., the child activation hasn't completed). Recovery leaves the `LLMActor` in `waiting_tool`. The processor re-dispatches the tool call through `executor` when the activation resumes (§3.6).
- **No `replay` defined** — recovery applies the default: `{ kind: 'settled', result: defaultInterruptedToolResult(name) }`. The model sees an error explaining the call was interrupted and should be re-issued.

```ts
function defaultInterruptedToolResult(toolName: string): ToolResult {
  return {
    success: false,
    error: `Runtime restarted before '${toolName}' completed. Re-issue the call after inspecting current state.`,
  };
}
```

Because the activation continues (not restarts), the settled result **reaches the model**. This is the key difference from the settlement model: the model sees the replayed result in its next turn and continues the same conversation, preserving all accumulated context.

### 3.4 Lost provider calls: `calling_provider`

An `LLMActor` in `calling_provider` had a provider call in flight when the process died. The HTTP call is gone and cannot be re-attached. The input is preserved in the active-reconstruction snapshot.

Recovery restores the `LLMActor` to `calling_provider` with the snapshot input. The actor's normal `_on_enter__calling_provider` handler calls `gate.waitUntilOpen()` then `provider.completeTurn(input, signal)`. Since the gate is closed during recovery, the call parks. When the gate opens (unpause), the call is re-issued naturally by the actor's own flow — recovery does not call `provider.completeTurn` directly. The model may produce a different response (non-determinism); this is the best possible recovery for a lost in-flight call. A recovery diagnostic records the re-issue.

### 3.5 activate_card: settled for terminal children, redispatch for non-terminal

`activate_card` is the one tool today whose side effect — driving a child card to completion — is fully recorded in durable state, but only when the child has reached a terminal status.

```ts
replay: async (args) => {
  const child = store.read(args.card_id);
  if (!child) return { kind: 'settled', result: { success: false, error: `Child card '${args.card_id}' not found.` } };
  switch (child.status) {
    case 'done':
    case 'failed':
    case 'blocked':
      return { kind: 'settled', result: reconstructedActivateResult(child) };
    case 'cancelled':
      return { kind: 'settled', result: { success: false, error: `Child card '${args.card_id}' was cancelled.` } };
    default:
      // running / changed / backlog: the child activation is still in progress.
      // Recovery cannot produce a result. The processor re-dispatches through
      // executor on resume; executor awaits the child's completion naturally.
      return { kind: 'redispatch' };
  }
}
```

- **Child terminal** → `settled` with the reconstructed result from the child card record. The parent's activation continues; the model sees the child's outcome.
- **Child non-terminal** → `redispatch`. Recovery leaves the call pending. When the activation resumes, the processor re-dispatches `activate_card` through `executor`. The child is also `running` (reconstructed), so the supervisor resumes the child first (bottom-up, §3.7). The executor calls `childCardActor.awaitSettlement()`, which resolves when the child's resumed activation completes, and returns the real result.

No ordering bug: `redispatch` does not require the child to be settled during recovery. The child and parent are both reconstructed as `running`; the supervisor resumes them bottom-up; the parent's re-dispatched `executor` call naturally awaits the child's completion.

### 3.6 Processor resume: state-aware activation entry

Today `processor.activate(input)` always creates a fresh `LLMActor` via `createMainLlm(agentId)` and starts with `llm.turn(input)`. For resume, the processor must instead pick up the reconstructed `LLMActor` and continue from its state:

- **`calling_provider`** — the provider call was re-issued by recovery (§3.4) or a settled tool call started a new one (§3.3). The processor awaits the pending turn outcome.
- **`waiting_tool`** — the tool call was marked `redispatch`. The processor re-dispatches through `executor` using the `waitingToolCall` record on the `LLMActor`, then calls `appendToolResult` and continues the loop. For `activate_card`, the executor finds the child `running` and calls `awaitSettlement()` instead of `activate()`.
- **`idle`** — no reconstructed actor; the processor creates a fresh one (clean activation, not a resume).

`BaseMainLLMCardProcessorActor.createMainLlm(agentId)` is modified: if a reconstructed `LLMActor` already exists in `activeLlmActors` (populated by recovery from snapshots), it returns it instead of creating a new one.

The `CardActor` resume path: for a `running` card with active reconstruction, the supervisor creates a synthetic pending activation (caller from the active-reconstruction record), sets the activation id, and re-enters the processor activation. `_on_enter__running` already runs `processor.activate(input)` — it just needs the pending activation set, which recovery provides.

### 3.7 Bottom-up resume order

The supervisor resumes `running` cards in **descending card depth** order (deepest first). This guarantees children resume before parents. When a parent's re-dispatched `activate_card` executor runs, the child has already been resumed and is progressing toward completion. The executor calls `childCardActor.awaitSettlement()` — a new `CardActor` method that resolves the current in-flight activation's outcome without starting a new activation. For a fresh (non-resume) activation where the child is activatable, the executor calls `activate()` as today. The executor checks the child's status and picks the right path.

This is the same parent→child tree dependency that `activate_card` always represents. Descending-depth order covers it. If a non-tree dependency ever appears, the order generalizes at the supervisor level — never in the tool.

### 3.8 Reconstructed providers, not a recovery surface

Recovery reconstructs the real provider instances with their durable context — the same providers used by live execution. The `InvocationSurface` is obtained from the reconstructed actors, not from a recovery-specific factory. `replay` methods read durable state through the provider's normal closed-over handles (card store, process store, project root).

Live-only structures (the `children` map, `notifyCard`) are wired by the supervisor after reconstruction and before resume. `replay` is called during recovery (while paused) and reads durable state only, so missing live-only fields are irrelevant. `executor` is called only on resume, after the supervisor has wired up all live structures.

There is no separate recovery surface, no context bag, and no reduced context. The same provider instances serve both `replay` (during recovery) and `executor` (after resume).

### 3.9 Scope: autonomous card processors only

Recovery applies to autonomous card processors (planner, executor, reviewer) whose `LLMActor` instances are snapshotted and reconstructed. The analyst's `LLMActor` is in-memory and not persisted; on restart, analyst actors are gone and their stale tool-call status records are cleaned up by the defensive tail. Recovery does not apply to the analyst.

## 4. Removal

Deleted from `src/runtime/actors/actor-recovery.ts`:

- `recoverActorBackedToolCalls` (lines 299-339).
- `activateCardRecoveryResult` (lines 341-352).
- `activeActorIdsForCard` (lines 354-360).
- `convertActorRecoveryOutcomes` (lines 246-262) — no longer needed. Cards stay `running`; they are resumed, not blocked.
- `cleanupConvertedRecoverySnapshots` — no longer needed (nothing to convert).

`abandonStalePendingToolCalls` stays as a defensive tail for orphan tool-call status records (analyst sessions, corrupt snapshots). Its role narrows but it is not deleted.

The synthetic `delivery_input_id` suffix `:tool:recovered` is removed. Replayed deliveries use the standard `appendToolDelivery` path, indistinguishable from normal deliveries. The recovery diagnostics gain a `kind: 'replayed_tool_call'` incident for settled calls and `kind: 'redispatched_tool_call'` for redispatch calls.

The per-role surface builders in `planning-card-processor-actor.ts`, `terminal-card-processor-actor.ts`, and `analyst-handler.ts` are unchanged — recovery obtains the surface from the reconstructed actors' existing builders.

`CardActor` gains `awaitSettlement(): Promise<CardActivationOutcome>` — resolves the current in-flight activation's outcome without starting a new activation. Used by `activate_card`'s executor when the child is already `running`.

`runActorStartupRecovery` is restructured:

1. Close the gate (force paused).
2. Reconstruct the actor tree from snapshots. `running` cards stay `running`.
3. For each `waiting_tool` `LLMActor`: look up `replay` via the reconstructed actor's surface, call it, and either `appendToolResult` (settled) or leave pending (redispatch). Log a diagnostic either way.
4. For each `calling_provider` `LLMActor`: restore it to `calling_provider` with the snapshot input. The actor parks at `gate.waitUntilOpen()` and re-issues the call naturally when the gate opens. Log a diagnostic.
5. Run `abandonStalePendingToolCalls` for orphan records only.
6. Write recovery diagnostics.
7. The supervisor initializes with the reconstructed actors.
8. The operator inspects, then unpauses (opens the gate). The supervisor resumes `running` cards bottom-up.

## 5. What each provider does

| Provider / tool | Replay outcome | Why |
| --- | --- | --- |
| `planner-control` / `activate_card` | **settled** (child terminal) or **redispatch** (child non-terminal). | Child completion is durable when terminal. When non-terminal, the executor re-establishes the wait on resume. |
| `planner-control` / `create_card`, `edit_card`, `cancel_card`, `reorder_child`, `queue_notification` | settled (default error). | No durable handle tying the call to its effect; cannot reconstruct. |
| `workspace` / `read`, `glob`, `grep` | settled (default error). | Read-only; the model re-issues in its continued turn. |
| `workspace` / `write`, `edit`; `patch` / `apply_patch` | settled (default error). | File may be partially written; the model re-reads and re-issues. |
| `process` / `run_command`, `wait_process`, `kill_process` | settled (default error). Future candidate for richer replay. | Process handles are durable; a future `replay` could match by owner+command. |
| `web` / `websearch`, `webfetch` | settled (default error). | External; no durable footprint. |
| `card-inspection`, `card-history` | settled (default error). | Read-only. |
| `mcp`, `skill` | settled (default error). | External/auxiliary. |

Only `activate_card` defines `replay` initially. `redispatch` is only returned by `activate_card` when the child is non-terminal. All other tools take the default settled-error. Future replay implementations are additive.

**Design expectation: mutating tools should provide `replay`.** The default interrupted error is a fallback for tools that have not yet defined `replay`. Tools with side effects (`write`, `edit`, `apply_patch`, `run_command`) should eventually provide `replay` that determines whether the side effect happened, so the model can decide whether to retry. Until then, the default error explicitly instructs inspection before re-issue; processors and prompts treat it as "the operation's effect is unknown — inspect state before retrying," never as a blind retry signal.

## 6. Validation

- `activate_card` replayed with child `done` → settled result delivered, parent `LLMActor` in `calling_provider`, on unpause the model continues with the child's outcome in context.
- `activate_card` replayed with child `failed` / `blocked` → settled result carrying child lifecycle result.
- `activate_card` replayed with child `cancelled` → settled error.
- `activate_card` redispatch: child non-terminal → `LLMActor` stays `waiting_tool`. On resume, processor re-dispatches through executor. Child is `running`; executor calls `awaitSettlement()`, child completes first (bottom-up), executor returns real result, `appendToolResult` delivers it.
- **Multi-level interruption**: grandchild (depth N+2), child (N+1), parent (N) all interrupted mid-`activate_card`. All reconstructed as `running`. Supervisor resumes bottom-up. Grandchild settles first, child's redispatched executor sees terminal grandchild, parent's redispatched executor sees terminal child. No throws, no ordering bug.
- `calling_provider` → provider call re-issued with snapshot input, waits at gate, proceeds on unpause.
- Default error: `write` with no `replay` → settled error delivered, model sees it in continued turn and re-issues after reading current file state.
- `emit_result` pending → still handled by terminal projection, untouched by replay.
- Cards not `running` before shutdown → untouched by recovery, driven normally by supervisor.
- Orphan tool-call status records → cleaned by defensive tail.
- Gate stays closed during recovery; nothing executes until unpause.
- Surface parity: reconstructed actor's surface tool-name set equals live processor's for each role.

## 7. Risks

| Risk | Mitigation |
| --- | --- |
| Processor resume entry is complex (state-aware) | The processor checks `LLMActor.state()` on entry: `calling_provider` → await, `waiting_tool` → re-dispatch, `idle` → fresh turn. Three cases, no branching on tool name. |
| `calling_provider` re-issue produces different model output | The original call is lost; re-issue with identical input is the best recovery. Non-determinism is inherent. The diagnostic records the re-issue. |
| Re-dispatched executor has side effects | Only `activate_card` returns `redispatch`. Its executor is state-aware (checks child status before acting). Tools with side effects return `settled` (default error), never `redispatch`. |
| Supervisor can't resume a `running` card | Recovery sets the synthetic pending activation and activation id from the active-reconstruction record. `_on_enter__running` runs `processor.activate(input)` which picks up the reconstructed `LLMActor`. |
| Cards with corrupt/missing snapshots | The contingency repair path (§3.1) handles these: complete determined transitions, backtrack to stable state, or block with diagnostics. Only hard irrecoverable conditions fail. |
| Card cancelled mid-shutdown (store says `cancelled`, snapshot says `running`) | The card store is authoritative. A `cancelled` card is terminal and is never resumed. Stale actor snapshots are cleaned up by the defensive tail. See [Tool Cancellation Design](./tool-cancellation-design.md) §6. |
| Replay reconstructs from stale state | Replay reads durable state during recovery (while paused). For `activate_card`, the child card record is authoritative. For default-error tools, no reconstruction happens. |

## 8. Explicit Decisions

1. Recovery reconstructs pre-shutdown state. Cards keep their status. `LLMActor`s keep their state. Recovery does not block, reopen, or transform card statuses.
2. The runtime starts paused (gate closed). Recovery, reconstruction, and settlement happen while paused. Unpause triggers continuation.
3. `replay` is an optional method on `ToolDefinition` taking only `args`. It returns `{ kind: 'settled' }` or `{ kind: 'redispatch' }`. No recovery context envelope.
4. Settled results reach the model. The activation continues from the settled tool call; the model sees the result in its next turn. Prior accumulated context is preserved.
5. `redispatch` means "the processor should re-run `executor` on resume." Only tools whose executors are state-aware (check current state before acting) may return `redispatch`. `activate_card` is the only one today.
6. `calling_provider` actors get their provider call re-issued with the snapshot input. The original call is lost; this is a retry, not a re-attachment.
7. The supervisor resumes `running` cards bottom-up (descending depth). Children settle before parents' re-dispatched executors run.
8. `convertActorRecoveryOutcomes` is deleted. `abandonStalePendingToolCalls` stays as a defensive tail for orphans and corrupt snapshots only.
9. `activate_card` is the only tool with `replay` initially. Future additions are additive (define `replay`) and require no recovery-layer changes.
10. Recovery applies only to autonomous card processors. The analyst is out of scope.
11. The card store is authoritative for card status. A terminal card (`cancelled`, `done`, `failed`, `blocked`) is never resumed regardless of stale actor snapshots.
12. Normal recovery never changes card lifecycle state. The contingency repair path (§3.1) applies only to corrupt/missing/inconsistent persisted state and prefers stable-and-continuable repair (complete, backtrack, block) over failure.
