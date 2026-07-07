# Tool Recovery Design

Status: implemented for the core top-down cascade (§2–§11). Robustness handling in §12,
including corrupt-snapshot recovery and orphan detection, is deferred to a follow-up changeset.

Date: 2026-07-06

## 1. Purpose

When the runtime process stops while cards are `running`, their activations are interrupted mid-flight: LLM actors are parked in `waiting_tool` (tool call sent, no result yet) or `calling_provider` (provider request sent, no response yet). On the next startup, these interrupted activations must be recovered.

This document describes the recovery mechanism under the **Top-Down Cascade model**. It is built on a single principle: **recovery mirrors execution**. The `activate_card` tool is the only mechanism for parent-child card relationships, in both normal execution and recovery. There is no separate supervisor-driven tree traversal or bottom-up reactivation sequence.

This doc is the design authority for the implemented core recovery mechanism. It sits beside [Shared Tool Invocation Design](./shared-tool-invocation-design.md) and [Micro-Actor Runtime Design](./micro-actor-runtime-design.md).

---

## 2. The Recovery Principle

During normal execution, a planner activates a child through the `activate_card` tool. The child runs, settles, and the result returns to the planner's tool call. Recovery uses the same mechanism.

The implemented runtime uses root-only recovery that cascades through `activate_card`. The
cascade is possible because the runtime has a single gate at the LLM provider call (see §3);
there is no separate deepest-first supervisor replay pass.

**The runtime reactivates the root card only.** Everything else cascades through `activate_card`:

1. The root card's processor starts its activation loop.
2. When it encounters `waiting_tool` on `activate_card`, the inline replay resolves the child: either `settled` (child terminal, result delivered) or `redispatch` (child running, executor re-establishes the wait).
3. On `redispatch`, the `activate_card` executor calls `child.recoverCurrentCardState()` — awakening the child — then awaits its settlement.
4. The child starts its own activation loop, cascading to grandchildren.

This produces a **100% unified dispatch path**: recovered tool calls and fresh tool calls flow through the same processor activation loop and the same repair-loop `onNonTerminalTool` handler.

---

## 3. One Gate

> **Change vs. current code.** [Micro-Actor Runtime Design](./micro-actor-runtime-design.md)
> and [System Specification §7](../spec/system-specification.md) currently specify **three**
> gate chokepoints: (1) LLM provider call, (2) runtime-owned process spawn, (3) card/root
> dispatch. The implemented runtime enforces all three: provider call
> (`LLMActor._on_enter__calling_provider`), process spawn
> (`process-provider` gates spawns whose `owner_kind !== 'operator'`), and card dispatch
> (`CardActor._on_enter__running` and root dispatch in `supervisor-runtime-api`). This
> redesign collapses them to one.

**The gate has exactly one chokepoint: the LLM provider call.** Chokepoints 2 and 3 are removed. They are redundant. All process spawns and card dispatches originate from tool calls, which originate from provider responses. If provider calls are gated, no new tool calls arrive, so no new spawns or dispatches happen. The chain is:

```
provider call (GATED) → model response → tool calls → activate_card / run_command / etc.
```

Gating at the source automatically gates everything downstream.

**Pause-semantics change.** This is a real behavior change, not a pure simplification. Under one gate, when the runtime is paused, already-received provider responses continue to be processed: tool calls may execute, cards may transition to `running`, and runtime-owned processes may spawn, until the in-flight responses drain and the next provider call parks. Today's three-gate model blocks those spawns and dispatches at their own seams. The weaker guarantee is intentional and consistent with the existing principle "already-admitted work may persist facts and settle to durable boundaries while paused"; shutdown still terminates runtime-owned processes via `ProcessRunner.stopRuntimeOwned`, so in-flight work cannot run away unbounded. Operators and the runbook must reflect the weaker pause guarantee (see §A).

**Coupling with the cascade.** The root-only recovery cascade in §4.2 is only reachable because card dispatch is no longer gated. With today's card-dispatch gate, root recovery could not cascade through `activate_card` while paused. The single-gate and the root-only cascade are one package.

This has two effects:

1. **Normal pause:** no new provider calls start; already-received responses drain through to durable boundaries.
2. **Recovery cascade:** the top-down cascade flows without any gate bypass. Processors start lazily when the cascade reaches each card, replay tools, cascade children through `activate_card` executors, and everything parks naturally at the LLM provider gate. The recovery-vs-fresh routing uses the micro-actor framework's native `recover` vs `enter` dispatch: `CardActor._on_recover__running` routes recovery to `processor.recoverActive`, while `CardActor._on_enter__running` routes fresh activation to `processor.activate`. No conditional gate logic.

Implementation: the gate exists only in `LLMActor._on_enter__calling_provider()`. The gate checks in `CardActor._on_enter__running()`, root dispatch, and runtime-owned process spawn paths have been removed.

---

## 4. Two-Stage Recovery

### Stage 1: Data tree reconstruction (bottom-up construction)

Pure data loading. No processor loops start, no side effects.

1. **Reconcile processes.** Terminate and clean up unattached running process records. Process re-attachment is completely removed from the app (see §10).
2. **Load snapshots.** Read all persisted card records, processor snapshots, and LLM actor snapshots.
3. **Project persisted terminal outcomes.** If a card's terminal tool call (`emit_result`) was persisted before shutdown but the card was not yet marked terminal, complete the card now (see §11).
4. **Construct all running card actors.** Build `CardActor` instances from snapshots for every `running` card with deferred recovery; their processors are constructed but not started, so no processor snapshot is written during Stage 1.

Stage 1 constructs all running card actors bottom-up as data/tree loading. Processors are constructed but not started. Activation is top-down (Stage 2), and LLMs are recovered lazily inside `processor.recoverActive` when the cascade reaches each card.

### Stage 2: Top-Down root reactivation

1. **Recover the root card actor.** The runtime (`SupervisorRuntimeApi`) calls `recoverCurrentCardState()` on the root card (the project card) only. One call.
2. **The activation loop runs.** The root card's processor starts lazily if deferred, then `processor.recoverActive` adopts recovered LLM snapshots and `runActivation` resolves the adopted planner LLM state (§6). Each child reached by the cascade follows the same path: `_on_recover__running` → lazy processor start → `processor.recoverActive` → LLM adoption.
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

> **Change vs. current code.** Today there are two replay hooks: the surface-level
> `replayToolForRecovery` (per-tool `replay`, `invocation.ts`) and a processor-level
> hook driven by the supervisor's separate waiting-tool replay pass. This redesign removes the processor-level hook and
> the supervisor's separate replay pass; `replayToolForRecovery` invoked from
> `resolveInitialOutcome` (§6/§9) is the single replay path.

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

> **Change vs. current code.** Today the `activate_card` executor calls only
> `actor.awaitSettlement()` for a running child (recovery is driven from the supervisor's
> deepest-first pass, not from the executor). Under this redesign the executor becomes the
> cascade driver: for a running child it calls `child.recoverCurrentCardState()` first, then
> `awaitSettlement()`.

The executor is state-aware. When the child is `running`, it triggers reactivation and awaits settlement:

```ts
async function activateCard(ctx, args, signal): Promise<ToolResult> {
  const child = ctx.store.read(args.card_id);
  if (!child) return { success: false, error: `Child card not found.` };
  const actor = ctx.children.get(args.card_id);
  if (!actor) return { success: false, error: `No CardActor for child '${args.card_id}'.` };

  if (child.status === 'running') {
    actor.recoverCurrentCardState();  // fire the child's recovery (cascades further if needed)
    const activation = await actor.awaitSettlement();
    return { success: true, data: { card_id: child.id, outcome: activation.status, summary: activation.summary, result: activation.result } };
  }

  const activation = await actor.activate({ kind: 'parent', cardId: ctx.parentCardId, sessionId: ctx.sessionId });
  return { success: true, data: { card_id: child.id, outcome: activation.status, summary: activation.summary, result: activation.result } };
}
```

During recovery, the child is `running` (it was running before shutdown). The executor calls `actor.recoverCurrentCardState()` — which fires the child's recovery, starting the child processor's activation loop. The child's processor recovers its own LLM actor, resolves its own initial outcome, and potentially cascades to grandchildren.

`awaitSettlement()` resolves when the child settles. The parent's `activate_card` executor returns the result.

Each card is recovered exactly once: the root by the runtime/composition root (`SupervisorRuntimeApi`), each child by its parent's `activate_card` executor during the cascade. `recoverCurrentCardState()` therefore does not need to be idempotent. (The current implementation in `card-actor.ts` is not idempotent, and this redesign keeps that.)

`recoverCurrentCardState()` does not need to be idempotent (see above: each card is recovered exactly once).

### Why the executor handles recovery (not pollution)

`activate_card`'s executor is already state-aware: it checks child status to decide between `activate()` (fresh) and `awaitSettlement()` (already running). Adding `recoverCurrentCardState()` for the `running` case is the same pattern: the executor picks the right action based on child state. This is the tool being state-aware, not a recovery leak. The tool IS the parent-child mechanism; using it for recovery is unification.

---

## 9. Processor Active-Phase Recovery

A planning card processor has two distinct LLM actors: planner and reviewer. The processor can be interrupted during either phase.

### How it works

The processor's `runActivation` is the single entry point. It calls `createMainLlm(plannerActorId)` which returns the recovered planner LLM. The planner LLM's state determines the entry:

- **Planner in `waiting_tool` on a non-terminal tool** (e.g., `activate_card`): inline replay handles it (§6). The planner continues its repair loop.
- **Planner in `waiting_tool` on a terminal tool** (`emit_result`): `resolveInitialOutcome` returns the outcome directly (terminal check). The repair loop routes it to `onTerminalTool`. The terminal handler calls `reviewPlannerDone()`, which calls `createMainLlm(reviewerActorId)`. If the reviewer was adopted during `processor.recoverActive` because its snapshot existed with non-null `active_reconstruction`, it is returned; otherwise `createMainLlm` creates a fresh reviewer. The reviewer's initial outcome is resolved by the same `resolveInitialOutcome` method — not by a separate helper. This ensures the reviewer's `waiting_tool` state gets the same inline replay as the planner's.
- **Planner in `calling_provider`**: the provider call is re-issued. On response, the repair loop continues.

`resolveInitialOutcome` is the single method used to resolve the initial outcome for ALL LLM actors — planner, reviewer, and executor alike.

> **Superseded helper.** This role used to be filled by a base LLM resume/start helper, which for
> `waiting_tool` returned `waitingToolOutcome()` directly (no inline replay). It was called from
> `planning-card-processor-actor.ts` (planner and reviewer) and `terminal-card-processor-actor.ts`
> (executor), and is documented in [resume-or-start-llm-design.md](./resume-or-start-llm-design.md).
> This redesign uses `resolveInitialOutcome`, which adds inline
> replay for `waiting_tool` (§6). The old helper is removed and its three call sites move
> to `resolveInitialOutcome`.

### Reviewer session continuity

The reviewer's assessment id and session id must be deterministic across recovery. The assessment id is recomputed with `nextReviewerAssessmentId(goalId)`, which is a pure function of `goalId`; it is not persisted on the processor active reconstruction record.

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
- **Paired planner + reviewer terminals**: if both the planner's and reviewer's `emit_result` were persisted and the card is still `running`, complete the card with the reviewer's assessment. To locate the reviewer's delivery log, Stage 1 recomputes the assessment id with `nextReviewerAssessmentId(goalId)` and derives the reviewer session id from it.

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
| C and D | `waiting_tool` | `done`/`failed`/`blocked` | `settled` with child's stored result |

The replay covers every parent-was-waiting-on-a-non-terminal-child combination without special ordering guarantees between writes. One edge is not "covered" in the strong sense: a child that **already had a stored result at call time** (i.e. the parent called `activate_card` on a child that was already `done`/`failed`/`blocked` when the call was made — an invalid or no-op activation). In normal execution the executor rejects non-activatable children before dispatch; a crash in that validation window leaves the tool call persisted with no result, and recovery's replay returns `settled` with the child's existing stored result. This degrades rather than corrupts:

- **`done`/`failed` (non-activatable):** the planner receives a benign stale outcome instead of the "not activatable" error it would have gotten. Rare (requires a crash in the validation window). Acceptable.
- **`blocked` (activatable):** normal execution would have re-run the child; recovery returning the prior blocked result silently skips that fresh re-activation. Self-correcting (the planner can inspect and retry), but a real discrepancy.

An optional hardening (not required to close this design): require the child's lifecycle result to record the parent activation id that settled it; the replay returns `settled` only on id match, otherwise the default interrupted error.

For all other tools (`write`, `create_card`, `edit`, etc.), the operation is simpler: tool call persisted → executor runs → result delivered. A crash at any point produces a `waiting_tool` LLM with no durable result. The default interrupted error is delivered: `"Runtime restarted before '<tool>' completed."` The model inspects current state and decides whether to re-issue.

### When we can't resume: fail the card

Some crash points leave state that the replay cannot resolve. These are detected during Stage 1 validation. The card is **failed** — moved to a stable terminal state with a clear diagnostic. The system never crashes.

1. **Missing `activeReconstruction`.** The card is `running` in the store but the actor snapshot has no `activeReconstruction` (the activation record was lost mid-write). Without it, the processor cannot know what was in flight. Fail the card: `"Recovery failed: card is running but no active reconstruction record exists."`

2. **Orphaned or stranded card.** The §5 invariant says a running child implies its parent is `waiting_tool` on `activate_card` for **that child**. Checking only "is the parent running?" is insufficient: a parent can be `running` while waiting on a different child, on a provider call, or on another tool. Stage 1 must fail (or strand) a running card when **either** (a) its parent is not `running`, **or** (b) the parent is running but is not `waiting_tool` on an `activate_card` whose target is this child. The target is reconstructable from the parent processor's `activeReconstruction` and the persisted tool call / delivery log. If the parent's waiting tool call cannot be reconstructed, treat the child as stranded (degraded diagnostic), not silently reachable by the cascade. Fail-stranded cards with: `"Recovery failed: parent is not waiting on this card; card is orphaned/stranded."` This propagates: children of failed cards are caught in subsequent validation passes.

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

If the root card record itself is corrupt or missing, the project cannot be recovered. The runtime reports this to the operator and halts. This is the only unrecoverable condition.

### Write atomicity

JSONL appends and temp-file-then-rename writes are assumed atomic. In the worst case, a partial JSONL append produces a truncated tail record that readers discard. Card store writes and record slot writes should use the same temp-file-then-rename pattern (`writeFileAtomic` / `writeFileSyncDurable`, which already exist in the codebase).

---

## 13. The Runtime's Role

1. **Stage 1**: `SupervisorRuntimeApi` (the runtime/composition root) reconciles processes → loads snapshots → projects terminals → validates running cards (fail cards with missing `activeReconstruction`, corrupt snapshots, or orphaned/stranded parentage per §12 — deferred robustness) → constructs valid running card actors with deferred processor start. There is no LLM adoption in Stage 1.
2. **Stage 2**: `SupervisorRuntimeApi` calls `recoverCurrentCardState()` on the root card. The cascade reaches children via `activate_card`; each reached card's processor starts lazily and `processor.recoverActive` adopts its recovered LLMs. Provider calls park at the gate.
3. **Resume**: the operator inspects the fully reconstructed tree, then `SupervisorRuntimeApi` opens the gate. Provider calls proceed. Activations continue.

The runtime/composition root has no knowledge of tool semantics, replay logic, or activation traversal. It performs root activation plus Stage 1 structural validation (parent/child status consistency and orphan/stranded propagation per §12). It does not traverse the card tree to recover individual non-root cards; the cascade does that.

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
- **Middleware preserved** → redispatched tool calls flow through `invokeToolForLlm`, not through a bypass function.
- **Normal pause (changed)** → provider calls block at the LLM gate; already-received tool calls complete and may spawn processes or dispatch cards until in-flight responses drain. No new provider calls start. (Weaker than today's three-gate pause; see §3.)

### Robustness

- **Mid-operation crash, child not yet activated** → replay sees `backlog` child → redispatch → fresh activation. No data loss.
- **Mid-operation crash, child running** → replay sees `running` child → redispatch → recover + await. Normal recovery.
- **Mid-operation crash, child settled but result not delivered** → replay sees a child with a stored result → settled with that result.
- **Already-settled `done`/`failed` child at call time** → replay returns `settled` with the stored result; planner gets a benign stale outcome instead of the "not activatable" error.
- **Already-settled `blocked` child at call time** → replay returns `settled` with the prior blocked result, skipping a valid re-activation; self-correcting via inspect/retry.
- **Missing `activeReconstruction`** → card failed with diagnostic, not crashed.
- **Corrupt actor snapshot** → card failed with diagnostic. System continues.
- **Running card whose parent is not running, or whose parent is not `waiting_tool` on this child** → orphan/stranded pre-check fails (or strands) the card. Children of failed cards caught in subsequent passes.
- **Missing LLM snapshot** → processor creates fresh LLM. Model re-orients. Graceful degradation.
- **Corrupt root card** → runtime reports to operator, halts recovery. Only unrecoverable condition.

---

## A. Implementation documentation plan

This section records the implementation documentation plan used to land the top-down cascade.
Each item is tagged **[drift]** (pre-existing drift versus the implemented runtime that had to be corrected regardless of this redesign) and/or **[redesign]** (updates required because of this redesign's changes).

### Where this design lives

`docs/architecture/tool-recovery-design.md` (this file). It stays an architecture doc.

### Docs to update when the redesign lands

- `docs/spec/system-specification.md`
  - §7 (Pause) **[redesign]** — pause guarantee weakens under the single gate.
  - §8 line 173 **[drift + redesign]** — currently states recovery does not resume running actors/tool waits/provider calls; the implemented runtime already does, and this redesign changes the model further.
  - §17 lines 320/324 **[drift + redesign]** — same no-resumption drift, plus the cascade model.
  - §19 line 336 **[drift + redesign]** — same no-resumption drift, plus session resumption under recovery.
- `docs/architecture/micro-actor-runtime-design.md`
  - System Shape gate chokepoints (~line 111), `RuntimeGate`, `CardActor._on_enter__running`, runtime recovery responsibilities, `LLMActor` states, and old helper removal **[redesign]**.
  - Recovery procedure (lines 533-554): block-on-restart described as "current policy" and mid-flight resume as "deferred future work (NOT current policy)" **[drift]** — must be corrected regardless of this redesign.
- `docs/architecture/system-architecture.md:127` **[drift + redesign]** — "Recovery does not recreate in-flight provider calls, process waits, tool waits, or running card actors."
- `docs/architecture/shared-tool-invocation-design.md` §3.1 / §3.4 **[drift]** — `ToolDefinition` shown without `signal`/`replay`; code (`invocation.ts`) already has both. Independent drift, flagged here.
- `docs/architecture/resume-or-start-llm-design.md` **[redesign]** — becomes stale/superseded when the old helper is removed (§9).
- `docs/architecture/interrupted-activation-recovery-design.md` **[status fix]** — currently the most accurate reference for *implemented* recovery; its "superseded by tool-recovery-design.md" label has been reverted (it will be superseded for real only when this redesign lands and is proven in code).
- `README.md` **[redesign]** — authority map / validation profiles if authority changes.
- `docs/runbook/` **[redesign]** — operator procedure for pause/resume/recovery, since pause semantics change.

### Optional sweep (non-authoritative docs that repeat the no-resumption posture)

Review during implementation: `docs/architecture/micro-actor-runtime-implementation-plan.md` (lines 335, 372, 386, 397-398, 400, 606), `docs/architecture/analyst-actor-design.md` (179, 207), and `docs/architecture/tool-repair-and-agent-conversation-unification-plan.md` (43, 350). A grep over `docs/architecture/` for the no-resumption claim returns no other matches beyond the docs listed above.

### Note on pre-existing drift

The no-resumption drift in `system-specification.md`, `micro-actor-runtime-design.md`, and `system-architecture.md` existed **independently** of this redesign: the previous runtime already reconstructed running cards and replayed tool waits through a supervisor-driven reconstruction plus separate replay pass. Correcting that drift was required whenever those docs were next updated, whether or not this redesign was adopted.
