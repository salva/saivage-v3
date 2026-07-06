# Tool Recovery Design

Status: approved system architecture.

Date: 2026-07-06

## 1. Purpose

When the runtime process stops while cards are `running`, their activations are interrupted mid-flight: LLM actors are parked in `waiting_tool` (tool call sent, no result yet) or `calling_provider` (provider request sent, no response yet). On the next startup, these interrupted activations must be recovered.

This document specifies the recovery mechanism under the **Top-Down Cascade model**. It is built on a single principle: **recovery mirrors execution**. The `activate_card` tool is the only mechanism for parent-child card relationships, in both normal execution and recovery. There is no separate supervisor-driven tree traversal or bottom-up reactivation sequence.

This doc is the authority for the recovery mechanism. It sits beside [Shared Tool Invocation Design](./shared-tool-invocation-design.md) and [Micro-Actor Runtime Design](./micro-actor-runtime-design.md).

---

## 2. The Recovery Principle

During normal execution, a planner activates a child through the `activate_card` tool. The child runs, settles, and the result returns to the planner's tool call. Recovery uses the same mechanism.

**The supervisor reactivates the root card only.** Everything else cascades through `activate_card`:

1. The root card's processor starts its activation loop.
2. When it encounters `waiting_tool` on `activate_card`, the inline replay resolves the child: either `settled` (child terminal, result delivered) or `redispatch` (child running, executor re-establishes the wait).
3. On `redispatch`, the `activate_card` executor calls `child.recoverCurrentCardState()` — awakening the child — then awaits its settlement.
4. The child starts its own activation loop, cascading to grandchildren.

This produces a **100% unified dispatch path**: recovered tool calls and fresh tool calls flow through the same processor activation loop and the same repair-loop `onNonTerminalTool` handler.

---

## 3. One Gate, Not Three

The `RuntimeGate` is the single pause boundary. The [Micro-Actor Runtime Design](./micro-actor-runtime-design.md) originally specified three gate chokepoints: (1) LLM provider call, (2) process spawn, (3) card dispatch.

**Chokepoint 3 (card dispatch) is removed.** It is redundant. All card dispatches originate from tool calls, which originate from provider responses. If provider calls are gated (chokepoint 1), no new tool calls arrive, so no new card dispatches happen. The chain is:

```
provider call (GATED) → model response → tool calls → activate_card / run_command / etc.
```

Gating at the source automatically gates everything downstream.

Removing chokepoint 3 has two effects:

1. **Normal pause:** when the runtime is paused, already-received provider responses continue to be processed (tool calls execute, cards transition to `running`). No new provider calls start. This is consistent with the existing principle: "already-admitted work may persist facts and settle to durable boundaries while paused."

2. **Recovery cascade:** the top-down cascade flows without any gate bypass. Processors start, replay tools, cascade children through `activate_card` executors, and everything parks naturally at the LLM provider gate. No special cases, no `_on_recover__running` override, no conditional gate logic.

Implementation: remove `await this.deps.gate?.waitUntilOpen()` from `CardActor._on_enter__running()`. The gate remains only in `LLMActor._on_enter__calling_provider()`.

---

## 4. Two-Stage Recovery

### Stage 1: Data tree reconstruction (bottom-up construction)

Pure data loading. No processor loops start, no side effects.

1. **Reconcile processes.** Terminate and clean up unattached running process records. Process re-attachment is completely removed from the app (see §10).
2. **Load snapshots.** Read all persisted card records, processor snapshots, and LLM actor snapshots.
3. **Project persisted terminal outcomes.** If a card's terminal tool call (`emit_result`) was persisted before shutdown but the card was not yet marked terminal, complete the card now (see §11).
4. **Construct all running card actors.** Build `CardActor` instances from snapshots for every `running` card. They exist in memory but are not activated — their processors have not started.
5. **Adopt recovered LLM actors.** Associate each recovered `LLMActor` with its owning processor via `processor.adoptRecoveredLlmActor(actor)`. This ensures processors have their LLMs when they start.

Stage 1 constructs all running card actors bottom-up because LLM actor adoption requires the processor to exist. This is bottom-up **construction** (data loading), not bottom-up **activation** (behavior). Activation is top-down (Stage 2).

### Stage 2: Top-Down root reactivation

1. **Recover the root card actor.** The supervisor calls `recoverCurrentCardState()` on the root card (the project card) only. One call.
2. **The activation loop runs.** The root's processor starts `runActivation`. It recovers the planner LLM actor, resolves its state (§6), and cascades through `activate_card` to children.
3. **Everything parks at provider calls.** The cascade flows through card reactivation and tool replay (no provider calls needed) until it reaches a point where a provider call is needed — then it blocks at the gate.
4. **Operator inspects, then resumes.** Opening the gate lets blocked provider calls proceed. Activations continue from where they stopped.

---

## 5. Why Top-Down

The cascade is top-down by construction. The root recovers first. Its `activate_card` recovery triggers child recovery. The child's `activate_card` recovery triggers grandchild recovery. The processors fire in parent-before-child order because a parent's recovery *causes* its children's recovery through the tool call.

This ordering is correct because of a structural invariant:

**A running child always implies its parent is `waiting_tool` on `activate_card` for that child.**

The parent's `activate_card` tool call is only delivered when the child settles. So if the child is running, the parent must still be waiting. Recovery respects this: cascading from the root through `activate_card` recovery reaches every running card.

If the cascade does not reach a running card (corrupted parent state, manual edits), it is an orphan (see §12).

---

## 6. Resolving the Initial LLM Outcome

The processor's `runActivation` must produce an `initialOutcome` for the contract-bounded repair loop. A single method handles all recovered LLM states:

```ts
private async resolveInitialOutcome(llm, surface, contract, input, signal): Promise<LLMActorOutcome> {
    switch (llm.state()) {
        case 'idle':
            return llm.turn(input, signal);
        case 'calling_provider':
            return llm.awaitPendingTurn();
        case 'waiting_tool':
            return this.resolveWaitingToolOutcome(llm, surface, contract, signal);
    }
}

private async resolveWaitingToolOutcome(llm, surface, contract, signal): Promise<LLMActorOutcome> {
    const pending = llm.waitingToolOutcome();
    if (contract.isTerminalToolName(pending.toolName)) return pending;
    const replay = await replayToolForRecovery(surface, pending.toolName, pending.args);
    if (replay.kind === 'settled') return llm.appendToolResult(pending.toolCallId, replay.result, signal, ...);
    return pending;
}
```

### Terminal tools

If the pending tool call is a terminal tool (`emit_result`, checked via `contract.isTerminalToolName`), the method returns `waitingToolOutcome()` directly. The repair loop routes it to `onTerminalTool`, which re-processes the terminal outcome. This is correct: the model already emitted the terminal; the processor re-evaluates it, potentially resuming a reviewer phase (§9).

### Non-terminal tools with `settled` replay

The replay produced a result from durable state (e.g., `activate_card` with a terminal child). The result is appended via `llm.appendToolResult(...)`. The LLM transitions to `calling_provider`. The resulting provider outcome becomes the `initialOutcome` for the repair loop.

### Non-terminal tools with `redispatch`

The replay determined the tool's operation is still in progress (e.g., `activate_card` with a running child). The method returns `waitingToolOutcome()`. The repair loop routes it to `onNonTerminalTool` → `handleToolCall` → `invokeToolForLlm` → executor. The tool is executed fresh through the **standard dispatch path with full middleware** (error handling, signal checks, audit logging).

### Non-terminal tools with default interrupted error (no `replay` defined)

Same as `settled`: the interrupted error is appended. The LLM transitions to `calling_provider`. On resume, the model sees the error and re-issues the call after inspecting state.

---

## 7. Tool Replay Contract

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

`replayToolForRecovery` is the only replay entry point:

```ts
export async function replayToolForRecovery(surface, name, args): Promise<ToolReplayOutcome> {
  const definition = surface.tools.get(name);
  if (!definition) return { kind: 'settled', result: defaultInterruptedToolResult(name) };
  const parsed = definition.inputSchema.safeParse(args);
  if (!parsed.success) return { kind: 'settled', result: { success: false, error: parsed.error.message } };
  return definition.replay?.(parsed.data) ?? { kind: 'settled', result: defaultInterruptedToolResult(name) };
}
```

Key: `replayToolForRecovery` **never executes `executor`**. It only calls `replay`. For `redispatch`, the processor returns `waitingToolOutcome()` and the repair loop's `onNonTerminalTool` handler executes the tool through `invokeToolForLlm` — the standard path with full middleware. There is no separate `recoverToolCall` function that bypasses middleware.

### Per-tool replay semantics

| Tool | Replay outcome | Why |
| --- | --- | --- |
| `activate_card` | `settled` (child terminal) or `redispatch` (child running). | Child completion is durable when terminal. When running, the executor re-establishes the wait. See §8. |
| All other tools | `settled` (default interrupted error). | No durable handle tying the call to its effect. The model inspects state and re-issues. |

Only `activate_card` defines `replay` initially. Future `replay` implementations are additive — they require no recovery-layer changes, only a `replay` method on the tool definition.

---

## 8. activate_card: Child Card Reactivation

### The replay

```ts
replay: async (args) => {
  const child = store.read(args.card_id);
  if (!child) return { kind: 'settled', result: { success: false, error: `Child card not found.` } };
  if (child.parent !== parentCardId) return { kind: 'settled', result: { success: false, error: `Not an immediate child.` } };
  switch (child.status) {
    case 'done':
    case 'failed':
    case 'blocked':
      return { kind: 'settled', result: reconstructedResult(child) };
    case 'cancelled':
      return { kind: 'settled', result: { success: false, error: `Child was cancelled.` } };
    default:
      return { kind: 'redispatch' };
  }
}
```

### The executor on redispatch

The executor is state-aware. When the child is `running`, it triggers reactivation and awaits settlement:

```ts
async function activateCard(ctx, args, signal): Promise<ToolResult> {
  const child = ctx.store.read(args.card_id);
  const actor = ctx.children.get(args.card_id);

  if (child.status === 'running') {
    actor.recoverCurrentCardState();  // idempotent: no-op if already recovered
    const activation = await actor.awaitSettlement();
    return { success: true, data: { card_id: child.id, outcome: activation.status, summary: activation.summary, result: activation.result } };
  }

  const activation = await actor.activate({ kind: 'parent', cardId: ctx.parentCardId, sessionId: ctx.sessionId });
  return { success: true, data: { card_id: child.id, outcome: activation.status, summary: activation.summary, result: activation.result } };
}
```

During recovery, the child is `running` (it was running before shutdown). The executor calls `actor.recoverCurrentCardState()` — which fires the child's recovery, starting the child processor's activation loop. The child's processor recovers its own LLM actor, resolves its own initial outcome, and potentially cascades to grandchildren.

`awaitSettlement()` resolves when the child settles. The parent's `activate_card` executor returns the result.

`recoverCurrentCardState()` is idempotent:

```ts
recoverCurrentCardState(): void {
  if (this.recovered) return;
  this.recovered = true;
  // ... fire recovery ...
}
```

### Why the executor handles recovery (not pollution)

`activate_card`'s executor is already state-aware: it checks child status to decide between `activate()` (fresh) and `awaitSettlement()` (already running). Adding `recoverCurrentCardState()` for the `running` case is the same pattern: the executor picks the right action based on child state. This is the tool being state-aware, not a recovery leak. The tool IS the parent-child mechanism; using it for recovery is unification.

---

## 9. Processor Active-Phase Recovery

A planning card processor has two distinct LLM actors: planner and reviewer. The processor can be interrupted during either phase.

### How it works

The processor's `runActivation` is the single entry point. It calls `createMainLlm(plannerActorId)` which returns the recovered planner LLM. The planner LLM's state determines the entry:

- **Planner in `waiting_tool` on a non-terminal tool** (e.g., `activate_card`): inline replay handles it (§6). The planner continues its repair loop.
- **Planner in `waiting_tool` on a terminal tool** (`emit_result`): `resolveInitialOutcome` returns the outcome directly (terminal check). The repair loop routes it to `onTerminalTool`. The terminal handler calls `reviewPlannerDone()`, which calls `createMainLlm(reviewerActorId)`. If the reviewer was adopted during Stage 1, it is returned. The reviewer's state is resolved by the same `resolveInitialOutcome` logic.
- **Planner in `calling_provider`**: the provider call is re-issued. On response, the repair loop continues.

### Reviewer session continuity

The reviewer's assessment id and session id must be deterministic across recovery. If `nextReviewerAssessmentId` generates a new id on recovery, the recovered reviewer LLM's session won't match. The processor's active-phase reconstruction record must carry the active assessment id so `reviewPlannerDone` reuses it rather than generating a new one.

---

## 10. Process Recovery

**Process re-attachment is completely removed from the application.** PID re-attachment after restart is unreliable.

Process reconciliation happens in Stage 1:
- Any process records marked `running` with `owner_kind !== 'operator'` are killed by PGID/PID or marked `lost`. They are not resumed.
- Tools with side effects like `run_command` return the default interrupted error. The model inspects state and re-issues if needed.

---

## 11. Terminal Tool Projection

Terminal tools (`emit_result`) are not replayed. If the model emitted a terminal outcome before shutdown but the card was not yet marked terminal, recovery completes the card from the persisted outcome in Stage 1.

- **Executor terminal**: if the executor's `emit_result` was persisted and the card is still `running`, complete the card with the executor's outcome.
- **Paired planner + reviewer terminals**: if both the planner's and reviewer's `emit_result` were persisted and the card is still `running`, complete the card with the reviewer's assessment.

Cards completed by terminal projection are removed from the reactivation set. They do not participate in Stage 2.

If only the planner's `emit_result` was persisted (reviewer hadn't completed), the card is NOT projected. It stays `running` and is recovered. The planner LLM's `waiting_tool` on `emit_result` routes to `onTerminalTool`, which re-enters the reviewer phase (§9).

---

## 12. Robustness: Mid-Operation Crashes

Recovery must handle on-disk state that was caught mid-operation during an unclean termination (crash, SIGKILL, power loss). The system must always reach a stable state.

### The replay IS the repair

The key insight: the inline replay mechanism naturally handles mid-operation crashes. The replay checks the **current durable state** of the child, not the state at the time of the crash. Whatever state the child is in, the replay produces the right outcome.

For `activate_card`, the operation has four phases: (A) parent LLM persists the tool call, (B) executor activates the child, (C) child runs and settles, (D) tool result is delivered to the parent. A crash at any point leaves a parent/child state combination that the replay handles:

| Crash between | Parent LLM state | Child card state | Replay outcome |
| --- | --- | --- | --- |
| A and B | `waiting_tool` | `backlog`/`changed` | `redispatch` → executor activates fresh |
| B and C | `waiting_tool` | `running` | `redispatch` → recover + await settlement |
| C and D | `waiting_tool` | terminal | `settled` with child's result |

No special ordering guarantees between writes are needed. The replay covers every combination.

For all other tools (`write`, `create_card`, `edit`, etc.), the operation is simpler: tool call persisted → executor runs → result delivered. A crash at any point produces a `waiting_tool` LLM with no durable result. The default interrupted error is delivered: `"Runtime restarted before '<tool>' completed."` The model inspects current state and decides whether to re-issue.

### When we can't resume: fail the card

Some crash points leave state that the replay cannot resolve. These are detected during Stage 1 validation. The card is **failed** — moved to a stable terminal state with a clear diagnostic. The system never crashes.

1. **Missing `activeReconstruction`.** The card is `running` in the store but the actor snapshot has no `activeReconstruction` (the activation record was lost mid-write). Without it, the processor cannot know what was in flight. Fail the card: `"Recovery failed: card is running but no active reconstruction record exists."`

2. **Orphaned card.** The card is `running` but its parent is NOT `running` (the parent completed or was never activated). A non-running parent cannot be `waiting_tool` on `activate_card`. Fail the card: `"Recovery failed: parent is not running; card is orphaned."` This propagates: children of failed cards are caught in subsequent validation passes.

3. **Corrupt or unparsable snapshot.** The snapshot file exists but fails schema validation. Fail the card: `"Recovery failed: actor snapshot is corrupt."`

### What "fail the card" means

A simple data operation, not a processor activation:

- Write `failed` status to the card store with lifecycle result `{ kind: 'failed', summary: '<diagnostic>' }`.
- Clear `activeReconstruction` from the actor snapshot.
- Remove from the reactivation set.

If the card's parent is running and waiting on `activate_card`, the replay returns `settled` with the failure. The parent's model sees: `"Child card '<id>' failed during recovery from interruption."` The model handles it — re-plans, creates a replacement, or fails itself.

### Missing LLM snapshot: degrade, don't fail

If the card's `activeReconstruction` IS present but its LLM actor snapshot is missing, the processor creates a fresh LLM (idle state). The model starts a new turn with the system prompt and card context. The accumulated conversation is lost, but the delivery log still persists it — the model can read prior context via `read` tools. Less efficient (re-orientation costs a provider turn) but safe. This is graceful degradation, not a failure.

### Corrupt root card

If the root card record itself is corrupt or missing, the project cannot be recovered. The supervisor reports this to the operator and halts. This is the only unrecoverable condition.

### Write atomicity

JSONL appends and temp-file-then-rename writes are assumed atomic. In the worst case, a partial JSONL append produces a truncated tail record that readers discard. Card store writes and record slot writes should use the same temp-file-then-rename pattern (`writeFileAtomic` / `writeFileSyncDurable`, which already exist in the codebase).

---

## 13. The Supervisor's Role

1. **Stage 1**: reconcile processes → load snapshots → project terminals → validate running cards (fail cards with missing `activeReconstruction`, corrupt snapshots, or non-running parents) → construct valid running card actors → adopt recovered LLM actors.
2. **Stage 2**: call `recoverCurrentCardState()` on the root card. One call. The cascade proceeds. Provider calls park at the gate.
3. **Resume**: the operator inspects the fully reconstructed tree, then opens the gate. Provider calls proceed. Activations continue.

The supervisor has zero knowledge of tools, invocation surfaces, parent-child card relationships, replay semantics, or the card tree structure.

---

## 14. Validation

### Normal recovery

- **Gate removal**: `_on_enter__running()` no longer blocks on the gate. Processor starts immediately. Provider calls still block at `LLMActor._on_enter__calling_provider()`.
- **`activate_card` replayed with child `done`** → settled result appended inline, planner LLM transitions to `calling_provider`, blocks at gate. On resume, model sees child outcome.
- **`activate_card` replayed with child `running`** → redispatch → repair loop routes to executor → `child.recoverCurrentCardState()` cascades child recovery → `awaitSettlement()` resolves when child settles → result delivered.
- **Multi-level cascade**: grandchild, child, parent all interrupted mid-`activate_card`. Root recovery cascades through all three. Grandchild parks at provider gate, child's `awaitSettlement` pending, parent's `awaitSettlement` pending. On resume, grandchild completes, child unblocks, parent unblocks.
- **`calling_provider` recovery** → provider call re-issued, blocks at gate, proceeds on resume.
- **Default interrupted result** → `write` with no `replay` → settled interrupted error appended inline, model sees it in continued turn and re-issues.
- **Terminal tool during recovery** → planner LLM in `waiting_tool` on `emit_result` → terminal check skips replay → repair loop routes to `onTerminalTool` → reviewer phase resumes.
- **Reviewer-phase recovery** → reviewer LLM recovered, `resolveInitialOutcome` handles its state, reviewer continues from recovered context.
- **Terminal projection** → `emit_result` persisted but card not yet terminal → card completed in Stage 1, no reactivation.
- **Idempotent recovery** → `recoverCurrentCardState()` called twice → second call is a no-op.
- **Middleware preserved** → redispatched tool calls flow through `invokeToolForLlm`, not through a bypass function.
- **Normal pause unchanged** → provider calls block at LLM gate. Already-received tool calls complete. No new provider calls start.

### Robustness

- **Mid-operation crash, child not yet activated** → replay sees `backlog` child → redispatch → fresh activation. No data loss.
- **Mid-operation crash, child running** → replay sees `running` child → redispatch → recover + await. Normal recovery.
- **Mid-operation crash, child settled but result not delivered** → replay sees terminal child → settled with result. Result delivered via replay.
- **Missing `activeReconstruction`** → card failed with diagnostic, not crashed.
- **Corrupt actor snapshot** → card failed with diagnostic. System continues.
- **Running card with non-running parent** → orphan pre-check fails the card. Children of failed cards caught in subsequent passes.
- **Missing LLM snapshot** → processor creates fresh LLM. Model re-orients. Graceful degradation.
- **Corrupt root card** → supervisor reports to operator, halts recovery. Only unrecoverable condition.
