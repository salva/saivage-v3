# Interrupted Activation Recovery Design

Status: design proposal.

Date: 2026-07-05

## 1. Purpose

When the runtime stops while cards are `running`, their activations are interrupted mid-flight: processors are inside their tool loops, `LLMActor`s are parked in `waiting_tool` or `calling_provider`, and provider tool calls are pending without delivered results. On the next startup, these interrupted activations must be recovered.

Today `runActorStartupRecovery` in `src/runtime/actors/actor-recovery.ts` handles this as a **settlement** problem: it changes card statuses (blocks or reopens them), synthesizes tool results in recovery-specific code, and lets the supervisor re-drive cards from scratch via fresh activations. The band-aid (`recoverActorBackedToolCalls`, lines 299-352) hardcodes `activate_card` reconstruction inside the recovery layer. Interrupted work — the accumulated LLM context, the in-flight tool sequence, the processor loop position — is discarded.

This document specifies the replacement: **reconstruct the same actor state the runtime had before shutdown, settle pending tool calls in place, start paused, then unpause to continue.** Cards that were `running` stay `running`. `LLMActor`s that were `waiting_tool` are reconstructed as `waiting_tool`. The activation resumes from where it stopped, not from a fresh start.

This doc is the authority for *how interrupted activations and their pending tool calls are recovered*. It sits below [Shared Tool Invocation Design](./shared-tool-invocation-design.md) and beside [Root Settlement and Planner Recovery Plan](./root-settlement-and-planner-recovery-plan.md). Terminal tool projection (`recoverProjectedTerminalToolOutcomes`) is unaffected: terminal tools are processor-loop contract logic, not provider tools.

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

The `signal` on `executor` is defined here because the `ToolDefinition` interface lives here, but it serves a runtime concern, not a recovery one. See §3.10.

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

Recovery re-issues the provider call by re-entering the `calling_provider` state with the same input. The `LLMActor` calls `gate.waitUntilOpen()` then `provider.completeTurn(input, signal)` — a fresh call with identical input. The model may produce a different response (non-determinism); this is the best possible recovery for a lost in-flight call. A recovery diagnostic records the re-issue.

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
- **Child non-terminal** → `redispatch`. Recovery leaves the call pending. When the activation resumes, the processor re-dispatches `activate_card` through `executor`. The executor calls `childCardActor.activate()` — the child is also `running` (reconstructed), so the supervisor resumes the child first (bottom-up, §3.7), the child completes, and the parent's executor returns the real result.

No ordering bug: `redispatch` does not require the child to be settled during recovery. The child and parent are both reconstructed as `running`; the supervisor resumes them bottom-up; the parent's re-dispatched `executor` call naturally awaits the child's completion.

### 3.6 Processor resume: state-aware activation entry

Today `processor.activate(input)` always creates a fresh `LLMActor` via `createMainLlm(agentId)` and starts with `llm.turn(input)`. For resume, the processor must instead pick up the reconstructed `LLMActor` and continue from its state:

- **`calling_provider`** — the provider call was re-issued by recovery (§3.4) or a settled tool call started a new one (§3.3). The processor awaits the pending turn outcome.
- **`waiting_tool`** — the tool call was marked `redispatch`. The processor re-dispatches through `executor` using the `waitingToolCall` record on the `LLMActor`, then calls `appendToolResult` and continues the loop.
- **`idle`** — no reconstructed actor; the processor creates a fresh one (clean activation, not a resume).

`BaseMainLLMCardProcessorActor.createMainLlm(agentId)` is modified: if a reconstructed `LLMActor` already exists in `activeLlmActors` (populated by recovery from snapshots), it returns it instead of creating a new one.

The `CardActor` resume path: for a `running` card with active reconstruction, the supervisor creates a synthetic pending activation (caller from the active-reconstruction record), sets the activation id, and re-enters the processor activation. `_on_enter__running` already runs `processor.activate(input)` — it just needs the pending activation set, which recovery provides.

### 3.7 Bottom-up resume order

The supervisor resumes `running` cards in **descending card depth** order (deepest first). This guarantees children resume before parents. When a parent's re-dispatched `activate_card` executor runs, the child has already been resumed and is progressing toward completion. The executor's `childCardActor.activate()` call (or equivalent await of the child's current activation) resolves when the child settles.

This is the same parent→child tree dependency that `activate_card` always represents. Descending-depth order covers it. If a non-tree dependency ever appears, the order generalizes at the supervisor level — never in the tool.

### 3.8 Shared surface factory

Recovery needs the `InvocationSurface` to look up `replay` for pending tool calls. The processor needs it to re-dispatch `redispatch` calls through `executor`. Both use the same surface. The existing per-role surface builders (private methods on the processor actors and the analyst handler) are refactored into a single shared factory:

```ts
function buildSurfaceForRole(role: OperationalAgentRole, cardId: string, ctx: SurfaceContext): InvocationSurface
```

Live execution passes the full context (including live `children` map and `notifyCard`). Recovery passes `projectRoot` and durable stores; `replay` methods read durable state only and never touch live-only fields. This is a single source of truth for provider composition per role; there is no second recovery surface and no drift.

### 3.9 Scope: autonomous card processors only

Recovery applies to autonomous card processors (planner, executor, reviewer) whose `LLMActor` instances are snapshotted and reconstructed. The analyst's `LLMActor` is in-memory and not persisted; on restart, analyst actors are gone and their stale tool-call status records are cleaned up by the defensive tail. Recovery does not apply to the analyst.

### 3.10 Tool executor signal: runtime cancellation

The `signal` parameter on `executor` gives the tool surface authority over runtime cancellation — complementing `replay`, which gives it authority over recovery. Together, the tool owns all three phases of a tool call: invocation (`executor`), interruption (`signal`), and recovery (`replay`). No external layer kills processes or synthesizes results on the tool's behalf.

The `AbortSignal` comes from the caller that owns the tool dispatch lifecycle:

- **Analyst**: `AnalystSessionActor` creates a per-turn `AbortController`. `cancel()` aborts it. Signal-aware tools stop immediately; between-step flag checks cover the rest. See `analyst-actor-remediation.md` Issue 1.
- **Autonomous card processors**: `CardActor.cancel()` currently kills processes via `processRunner.stopByOwner` directly. With the signal in place, process-killing moves into the `run_command` executor (pass the signal to `child_process.spawn({ signal })`), and `CardActor` just aborts the controller. This replaces the CardActor-level workaround with tool-level cancellation.

Tools opt into cancellation individually:

- `run_command`: pass to `child_process.spawn({ signal })`. Node kills the process.
- `websearch` / `webfetch`: pass to `fetch({ signal })`. The request aborts.
- `wait_process`: check `signal.aborted` in the polling loop.
- Fast tools (`read`, `write`, `glob`, etc.): ignore. Between-step or between-activation checks are sufficient.

Existing executors that ignore the signal simply don't name the parameter; TypeScript allows fewer parameters, so the change is non-breaking in practice.

`invokeTool` and `invokeToolCall` gain an optional `signal` parameter they forward to the executor.

## 4. Removal

Deleted from `src/runtime/actors/actor-recovery.ts`:

- `recoverActorBackedToolCalls` (lines 299-339).
- `activateCardRecoveryResult` (lines 341-352).
- `activeActorIdsForCard` (lines 354-360).
- `convertActorRecoveryOutcomes` (lines 246-262) — no longer needed. Cards stay `running`; they are resumed, not blocked.
- `cleanupConvertedRecoverySnapshots` — no longer needed (nothing to convert).

`abandonStalePendingToolCalls` stays as a defensive tail for orphan tool-call status records (analyst sessions, corrupt snapshots). Its role narrows but it is not deleted.

The synthetic `delivery_input_id` suffix `:tool:recovered` is removed. Replayed deliveries use the standard `appendToolDelivery` path, indistinguishable from normal deliveries. The recovery diagnostics gain a `kind: 'replayed_tool_call'` incident for settled calls and `kind: 'redispatched_tool_call'` for redispatch calls.

The per-role surface builders in `planning-card-processor-actor.ts`, `terminal-card-processor-actor.ts`, and `analyst-handler.ts` are refactored to delegate to the shared `buildSurfaceForRole` factory.

`runActorStartupRecovery` is restructured:

1. Close the gate (force paused).
2. Reconstruct the actor tree from snapshots. `running` cards stay `running`.
3. For each `waiting_tool` `LLMActor`: look up `replay` via `buildSurfaceForRole`, call it, and either `appendToolResult` (settled) or leave pending (redispatch). Log a diagnostic either way.
4. For each `calling_provider` `LLMActor`: re-issue the provider call (re-enter `calling_provider` with the snapshot input). Log a diagnostic.
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

## 6. Validation

- `activate_card` replayed with child `done` → settled result delivered, parent `LLMActor` in `calling_provider`, on unpause the model continues with the child's outcome in context.
- `activate_card` replayed with child `failed` / `blocked` → settled result carrying child lifecycle result.
- `activate_card` replayed with child `cancelled` → settled error.
- `activate_card` redispatch: child non-terminal → `LLMActor` stays `waiting_tool`. On resume, processor re-dispatches through executor. Child completes first (bottom-up), executor returns real result, `appendToolResult` delivers it.
- **Multi-level interruption**: grandchild (depth N+2), child (N+1), parent (N) all interrupted mid-`activate_card`. All reconstructed as `running`. Supervisor resumes bottom-up. Grandchild settles first, child's redispatched executor sees terminal grandchild, parent's redispatched executor sees terminal child. No throws, no ordering bug.
- `calling_provider` → provider call re-issued with snapshot input, waits at gate, proceeds on unpause.
- Default error: `write` with no `replay` → settled error delivered, model sees it in continued turn and re-issues after reading current file state.
- `emit_result` pending → still handled by terminal projection, untouched by replay.
- Cards not `running` before shutdown → untouched by recovery, driven normally by supervisor.
- Orphan tool-call status records → cleaned by defensive tail.
- Gate stays closed during recovery; nothing executes until unpause.
- Surface parity: `buildSurfaceForRole` tool-name set equals live processor's for each role.

## 7. Risks

| Risk | Mitigation |
| --- | --- |
| Processor resume entry is complex (state-aware) | The processor checks `LLMActor.state()` on entry: `calling_provider` → await, `waiting_tool` → re-dispatch, `idle` → fresh turn. Three cases, no branching on tool name. |
| `calling_provider` re-issue produces different model output | The original call is lost; re-issue with identical input is the best recovery. Non-determinism is inherent. The diagnostic records the re-issue. |
| Re-dispatched executor has side effects | Only `activate_card` returns `redispatch`. Its executor is state-aware (checks child status before acting). Tools with side effects return `settled` (default error), never `redispatch`. |
| Supervisor can't resume a `running` card | Recovery sets the synthetic pending activation and activation id from the active-reconstruction record. `_on_enter__running` runs `processor.activate(input)` which picks up the reconstructed `LLMActor`. |
| Cards with corrupt/missing snapshots | `abandonStalePendingToolCalls` + a recovery diagnostic handle these edge cases. A `running` card with no active reconstruction is blocked with a diagnostic (the only remaining block path). |
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
