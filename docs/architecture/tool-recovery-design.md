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

## 3. Two-Stage Recovery

### Stage 1: Data tree reconstruction

Pure data loading. No actors start, no tasks run, no side effects.

1. **Reconcile processes.** Terminate and clean up unattached running process records. Process re-attachment is completely removed from the app (see §9).
2. **Load snapshots.** Read all persisted card records, processor snapshots, and LLM actor snapshots. Build an in-memory recovery plan.
3. **Project persisted terminal outcomes.** If a card's terminal tool call (`emit_result`) was persisted before shutdown but the card was not yet marked terminal, complete the card now (see §10).
4. **Construct card actors.** Build `CardActor` instances from snapshots. They exist in memory but are not reactivated — their processors have not started.

### Stage 2: Top-Down root reactivation

1. **Recover the root card actor.** The supervisor calls `recoverCurrentCardState()` on the root card only.
2. **The activation loop runs.** The root's processor starts `runActivation`. It recovers the planner LLM actor, handles its state (§5), and cascades through `activate_card` to children.
3. **Everything parks at provider calls.** The cascade flows through card reactivation and tool replay (no provider calls needed) until it reaches a point where a provider call is needed — then it blocks at the gate.
4. **Operator inspects, then resumes.** Opening the gate lets blocked provider calls proceed.

---

## 4. Recovery Bypasses the Card-Level Gate

This is the critical architectural requirement that makes the top-down cascade work.

The `RuntimeGate` has three chokepoints in normal execution (per [Micro-Actor Runtime Design](./micro-actor-runtime-design.md)):
1. `LLMActor` before provider invocation.
2. Process tool provider before `ProcessRunner.spawn(...)`.
3. `CardActor._on_enter__running()` before processor dispatch.

During recovery, **chokepoint 3 must be bypassed.** Recovery reconstructs already-dispatched work — the dispatch happened before shutdown. The processor's activation loop must run freely to perform inline replay and cascade children through `activate_card`. Only chokepoints 1 (provider calls) and 2 (process spawns) apply during recovery.

If chokepoint 3 is NOT bypassed, the root card's `runTask` blocks on `gate.waitUntilOpen()` before the processor starts. The processor never runs, the inline replay never happens, and the cascade never flows. The system is stuck with only the root card in memory.

Implementation: `_on_enter__running()` must distinguish recovery from fresh activation. During recovery (`activeReconstruction` present, `processor.recoverActive` path), skip the gate. During fresh activation (`processor.activate` path), the gate applies normally.

---

## 5. LLM Actor Recovery States

A recovered LLM actor is in one of two states. The processor's activation loop handles each.

### `calling_provider`: re-issue the provider call

The provider call was in flight when the process died. The input is preserved in the active-reconstruction snapshot. `resumeOrStartLlm` calls `llm.awaitPendingTurn()`. The LLM's `_on_enter__calling_provider` handler calls `gate.waitUntilOpen()` then `provider.completeTurn(...)`. While paused, the call parks. On resume, it is re-issued.

### `waiting_tool`: inline replay before the loop

The model made a tool call before shutdown. Recovery must produce a result so the activation can continue. The processor handles this inline before entering the repair loop.

**Terminal tools are not replayed.** If the pending tool call is a terminal tool (`emit_result`, checked via `contract.isTerminalToolName`), the processor skips inline replay and returns `waitingToolOutcome()` directly. The repair loop routes it to `onTerminalTool`, which re-processes the terminal outcome. This is correct: the model already emitted the terminal; the processor re-evaluates it, potentially resuming a reviewer phase.

**Non-terminal tools are replayed inline.** The processor calls `replayToolForRecovery(surface, toolName, args)`, which invokes the tool's optional `replay` method:

- **`settled`** (including default interrupted error) → The processor appends the result via `llm.appendToolResult(toolCallId, result)`. The LLM transitions to `calling_provider`. The resulting provider outcome becomes the `initialOutcome` for the repair loop.
- **`redispatch`** → The processor returns `llm.waitingToolOutcome()` as the `initialOutcome`. The repair loop routes it to `onNonTerminalTool` → `handleToolCall` → `invokeToolForLlm` → executor. The tool is executed fresh through the **standard dispatch path with full middleware** (error handling, signal checks, audit logging).

```ts
async runActivation(input, signal) {
  const llm = this.createMainLlm(agentId);
  const surface = this.buildSurface(...);
  const contract = this.buildContract(...);

  const initialOutcome = await this.resolveInitialOutcome(llm, surface, contract, input, signal);

  return runContractBoundedRepairLoop({
    initialOutcome,
    isTerminalToolName: (name) => contract.isTerminalToolName(name),
    onNonTerminalTool: async (toolOutcome) => {
      const toolResult = await this.handleToolCall(toolOutcome, surface, signal);
      return llm.appendToolResult(toolOutcome.toolCallId, toolResult, signal, ...);
    },
    onTerminalTool: ...,
    ...
  });
}

protected async resolveInitialOutcome(llm, surface, contract, input, signal) {
  if (llm.state() === 'calling_provider') return llm.awaitPendingTurn();
  if (llm.state() === 'waiting_tool') {
    const pending = llm.waitingToolOutcome();
    if (contract.isTerminalToolName(pending.toolName)) return pending; // terminal → repair loop handles
    const replay = await replayToolForRecovery(surface, pending.toolName, pending.args);
    if (replay.kind === 'settled') return llm.appendToolResult(pending.toolCallId, replay.result, signal, ...);
    return pending; // redispatch → repair loop handles via onNonTerminalTool
  }
  return llm.turn(input, signal);
}
```

This replaces the old `resumeOrStartLlm` helper entirely. The branching is explicit and covers all three LLM states with no separate recovery dispatch path.

---

## 6. Tool Replay Contract

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

`replayToolForRecovery` is the only replay entry point. It resolves replay semantics into a `ToolReplayOutcome`:

```ts
export async function replayToolForRecovery(surface, name, args): Promise<ToolReplayOutcome> {
  const definition = surface.tools.get(name);
  if (!definition) return { kind: 'settled', result: defaultInterruptedToolResult(name) };
  const parsed = definition.inputSchema.safeParse(args);
  if (!parsed.success) return { kind: 'settled', result: { success: false, error: parsed.error.message } };
  return definition.replay?.(parsed.data) ?? { kind: 'settled', result: defaultInterruptedToolResult(name) };
}
```

Key: `replayToolForRecovery` **never executes `executor`**. It only calls `replay`. For `redispatch`, the processor returns `waitingToolOutcome()` and the repair loop's `onNonTerminalTool` handler executes the tool through `invokeToolForLlm` — the standard path with full middleware (error wrapping, signal handling, audit logging).

There is no separate `recoverToolCall` function that bypasses middleware.

### Per-tool replay semantics

| Tool | Replay outcome | Why |
| --- | --- | --- |
| `activate_card` | `settled` (child terminal) or `redispatch` (child running). | Child completion is durable when terminal. When running, the executor re-establishes the wait. See §7. |
| All other tools | `settled` (default interrupted error). | No durable handle tying the call to its effect. The model inspects state and re-issues. |

Only `activate_card` defines `replay` initially. Future `replay` implementations are additive — they require no recovery-layer changes.

---

## 7. activate_card: Child Card Reactivation

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

The `activate_card` executor is state-aware. When the child is `running`, it triggers reactivation and awaits settlement:

```ts
async function activateCard(ctx, args): Promise<ToolResult> {
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

During recovery, the child is `running` (it was running before shutdown). The executor calls `actor.recoverCurrentCardState()` — which fires the child's `_on_recover__running`, starting the child processor's activation loop. The child's processor recovers its own LLM actor, replays its own tools, and potentially cascades to grandchildren.

`awaitSettlement()` resolves when the child settles. The parent's `activate_card` executor returns the result. The parent continues its repair loop.

`recoverCurrentCardState()` is idempotent:

```ts
recoverCurrentCardState(): void {
  if (this.recovered) return;
  this.recovered = true;
  // ... fire _on_recover__running ...
}
```

### Child actor construction is lazy

Child actors are not pre-constructed in Stage 1. They are constructed on demand when `activate_card`'s executor calls `ctx.children.get(card_id)`, which delegates to `CardActor.childCardActor(cardId)` → `CardActor.fromCard(...)`. `fromCard` loads the persisted snapshot (including `activeReconstruction`), so the actor is fully reconstructed from durable state.

---

## 8. Processor Active-Phase Recovery

A planning card processor has two distinct LLM actors: planner and reviewer. The processor can be interrupted during either phase. Recovery must resume the correct phase.

### How it works

The processor's `runActivation` is the single entry point for both fresh activation and recovery. It calls `createMainLlm(plannerActorId)` which returns the recovered planner LLM if one was adopted during Stage 1. The planner LLM's state determines the entry:

- If the planner is in `waiting_tool` on a **non-terminal** tool (e.g., `activate_card`): inline replay handles it (§5). The planner continues its repair loop.
- If the planner is in `waiting_tool` on a **terminal** tool (`emit_result`): the repair loop routes it to `onTerminalTool`. The terminal handler calls `reviewPlannerDone()`, which creates/reuses the reviewer LLM via `createMainLlm(reviewerActorId)`. If the reviewer was adopted during Stage 1, it is returned. `resumeOrStartLlm` handles the reviewer's state (`calling_provider` → await, `waiting_tool` → inline replay, `idle` → fresh turn).
- If the planner is in `calling_provider`: the provider call is re-issued. On response, the repair loop continues.

### Reviewer session continuity

The reviewer's assessment id and session id are derived from the card's lifecycle state. For recovery to resume the correct reviewer session, the assessment id must be deterministic based on persisted state, not freshly generated. The processor's active-phase reconstruction record must carry the active assessment id so `reviewPlannerDone` reuses it rather than generating a new one.

---

## 9. Process Recovery

**Process re-attachment is completely removed from the application.** PID re-attachment after restart is unreliable.

Process reconciliation happens in Stage 1:
- Any process records marked `running` with `owner_kind !== 'operator'` are killed by PGID/PID or marked `lost`. They are not resumed.
- Tools with side effects like `run_command` return the default interrupted error. The model inspects state and re-issues if needed.

---

## 10. Terminal Tool Projection

Terminal tools (`emit_result`) are not replayed. If the model emitted a terminal outcome before shutdown but the card was not yet marked terminal, recovery completes the card from the persisted outcome in Stage 1.

- **Executor terminal**: if the executor's `emit_result` was persisted and the card is still `running`, complete the card with the executor's outcome.
- **Paired planner + reviewer terminals**: if both the planner's and reviewer's `emit_result` were persisted and the card is still `running`, complete the card with the reviewer's assessment.

Cards completed by terminal projection are removed from the reactivation set. They do not participate in Stage 2.

If only the planner's `emit_result` was persisted (reviewer hadn't completed), the card is NOT projected. It stays `running` and is recovered. The planner LLM's `waiting_tool` on `emit_result` routes to `onTerminalTool`, which re-enters the reviewer phase (§8).

---

## 11. Anomaly Handling

### Orphaned running cards

Under correct operation, a running child implies its parent is `waiting_tool` on `activate_card`. If the cascade does not reach a running card (corrupted parent state, manual edits), the supervisor detects it: after the cascade has fired (all reachable actors constructed and parked), the supervisor scans for cards marked `running` in the store whose actors were never recovered (`recovered === false`). These are orphans. The supervisor logs a diagnostic and blocks them for operator inspection.

### Corrupt or missing snapshots

If a running card has corrupt or missing active-reconstruction state, exact resume is impossible. Recovery enters a contingency repair path: complete a determined transition if evidence exists, or block with diagnostics. This path is for corrupted persisted state only; it is never used for ordinary interrupted activations.

---

## 12. The Supervisor's Role

1. **Stage 1**: reconstruct data (reconcile processes, load snapshots, project terminals, construct root card actor).
2. **Stage 2**: call `recoverCurrentCardState()` on the root card. One call. The cascade proceeds. Provider calls park at the gate.
3. **Orphan sweep**: after the cascade has fired, scan for unreconstructed running cards. Block and diagnose.
4. **Resume**: the operator inspects the fully reconstructed tree, then opens the gate. Provider calls proceed. Activations continue.

The supervisor has zero knowledge of tools, invocation surfaces, parent-child card relationships, replay semantics, or the card tree structure.

---

## 13. Validation

- **`activate_card` replayed with child `done`** → settled result delivered inline, planner LLM transitions to `calling_provider`, blocks at gate. On resume, model sees child outcome in continued turn.
- **`activate_card` replayed with child `running`** → redispatch → repair loop routes to executor → `child.recoverCurrentCardState()` cascades child recovery → `awaitSettlement()` resolves when child settles → result delivered.
- **Multi-level cascade**: grandchild, child, parent all interrupted mid-`activate_card`. Root recovery cascades through all three. Grandchild parks at provider gate, child's `awaitSettlement` pending, parent's `awaitSettlement` pending. On resume, grandchild completes, child unblocks, parent unblocks. No deadlocks.
- **Gate bypass during recovery**: root card's processor runs while gate is closed. Inline replay executes. Children cascade. Only provider calls and process spawns block.
- **`calling_provider` recovery** → provider call re-issued, blocks at gate, proceeds on resume.
- **Default interrupted result** → `write` with no `replay` → settled interrupted error appended inline, model sees it in continued turn and re-issues after inspecting state.
- **Terminal tool during recovery** → planner LLM in `waiting_tool` on `emit_result` → skip inline replay → repair loop routes to `onTerminalTool` → reviewer phase resumes.
- **Reviewer-phase recovery** → reviewer LLM recovered, `resumeOrStartLlm` handles its state, reviewer continues from recovered context.
- **Terminal projection** → `emit_result` persisted but card not yet terminal → card completed in Stage 1, no reactivation.
- **Idempotent recovery** → `recoverCurrentCardState()` called twice → second call is a no-op.
- **Orphaned card** → running card not reachable from root → diagnostic logged, card blocked.
- **Middleware preserved** → redispatched tool calls flow through `invokeToolForLlm`, not through a bypass function.
