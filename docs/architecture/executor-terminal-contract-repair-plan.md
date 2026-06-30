# Executor Terminal Contract Repair Plan

Status: proposed. This document records the pueblicos runtime failure observed on 2026-06-30 and the minimal implementation plan to fix it.

## Problem

Terminal executors sometimes return plain assistant text instead of calling the required `emit_executor_result` terminal tool. The current terminal-card actor immediately marks the card failed with:

```text
Expected terminal tool 'emit_executor_result'. Plain executor messages are not accepted as terminal results.
```

That behavior is contract-strict, but operationally brittle. A model that understands the task but misses the tool protocol gets no repair turn. The parent planner then sees a failed child, tries to reactivate the failed card, receives `Card '<id>' in status 'failed' is not activatable`, and eventually blocks the root goal.

## Evidence

Observed in `/home/salva/g/ml/pueblicos` after reset and project start:

- `executor%3Acard-1.jsonl` returned a long prose response, claimed it had simulated `record://status.md?v=next`, and never called `write` or `emit_executor_result`.
- `executor%3Acard-2.jsonl` repeated the same pattern.
- Both cards failed with the same terminal-tool error.
- `planner%3Aproject.jsonl` shows the planner then retried `activate_card` on failed card `card-1`, received a non-activatable error, moved to `card-2`, and finally blocked on the executor format mismatch.

Relevant code:

- `src/runtime/actors/terminal-card-processor-actor.ts:61-63` immediately converts `outcome.type === 'result'` into executor failure.
- `src/runtime/actors/terminal-card-processor-actor.ts:169-176` immediately converts invalid terminal tool envelopes into executor failure.
- `src/agents/agent-loop-driver.ts` already has the desired higher-level pattern: persist bad output, append a model repair message, and retry until a terminal envelope verifies.
- `tests/runtime/actors/terminal-card-processor-actor.test.ts` currently locks in the bad behavior with `does not accept plain executor prose as terminal result` expecting immediate failure.

## Root Cause

The micro-actor terminal executor path has its own one-shot tool loop instead of using a contract-verification repair loop.

The prompt and provider request already say tools are required:

- The executor prompt says to write `record://status.md?v=next` and end with `emit_executor_result`.
- `buildLlmInput()` passes the terminal tool and `capabilityRequest: { requiresTools: true }`.

However, provider tool support is not the same as guaranteed terminal-tool compliance. Some providers can still return a plain message even when tools are available. The runtime must reject that output, but it should reject it as a repairable contract violation before failing the card.

## Design Principles

- Do not accept plain text as an executor result.
- Do not synthesize `emit_executor_result` from prose.
- Do not add compatibility shims or legacy fallback behavior.
- Do not hide provider/model protocol failures.
- Do add a small bounded repair loop at the contract boundary.
- Keep terminal execution owned by `TerminalCardProcessorActor`; do not add another scheduler, queue, or wrapper service.

## Target Behavior

For a terminal card activation:

1. Executor may call workspace/process tools.
2. Executor must write `record://status.md?v=next`.
3. Executor must call `emit_executor_result` exactly once with a valid executor envelope.
4. If the executor returns plain text, invalid terminal arguments, the wrong terminal tool, or a terminal result before writing `status.md`, the actor appends a repair instruction and gives the same executor session a bounded retry.
5. If repair attempts are exhausted, the card fails with a precise protocol error.

This preserves the hard contract while avoiding preventable first-turn failures.

## Minimal Implementation Plan

### 1. Add A Local Repair Budget

In `TerminalCardProcessorActor.runActivation()`, introduce one explicit budget for terminal contract repair, for example:

```ts
const MAX_EXECUTOR_CONTRACT_REPAIRS = 2;
let contractRepairAttempts = 0;
```

Keep the existing status-record repair budget, or fold it into the same repair budget only if the implementation remains simpler. Do not make the budget configurable until there is a real need.

### 2. Repair Plain Assistant Messages

Replace the immediate `outcome.type === 'result'` failure with a repair turn.

When the provider returns a plain message:

- persist has already happened through `LLMActor` delivery logging;
- build a repair context that includes the assistant text and an explicit user repair directive;
- call `llm.turn()` again with a new `LlmInvocationInput` for the same executor session.

Repair directive shape:

```text
Your previous response was plain assistant text, which is not a terminal executor result. Do not summarize, simulate file writes, or describe what you would do. Use tools. First write record://status.md?v=next with the actual status. Then call emit_executor_result with valid JSON arguments.
```

If the repair budget is exhausted, then fail with the current protocol error.

### 3. Repair Invalid Terminal Envelopes

Replace `projectExecutorTerminal()` immediate failure for invalid terminal envelopes with a repair result delivered to the model via `llm.appendToolResult()`.

Current behavior:

- terminal tool is present;
- `verifyTerminalToolOutcome()` throws;
- card fails immediately.

Target behavior:

- terminal tool is present;
- validation failure is returned as the tool result for that terminal call;
- a repair context says to re-emit `emit_executor_result` with valid arguments;
- only after the repair budget is exhausted does the card fail.

This should use the existing `verifyTerminalToolOutcome()` and `expectedTerminalToolMessage()` functions. Do not introduce a second executor schema checker.

### 4. Keep Missing Status Record Repair

The actor already repairs missing `record://status.md?v=next` by delivering a failed tool result and asking the executor to create the record. Keep that behavior, but make it consistent with the new contract repair failure message and budget accounting.

Do not auto-create `status.md`. The executor must write the record itself so the session log and card records reflect actual executor behavior.

### 5. Factor Small Helpers Only If They Reduce Duplication

Acceptable helper candidates inside `terminal-card-processor-actor.ts`:

- `executorPlainTextRepairMessage(content: string): string`
- `executorTerminalRepairMessage(error: string): string`
- `contractFailure(error: string): TerminalProcessorOutcome`

Do not add a new generic framework unless planner/reviewer actors need the same code in this change. The immediate production failure is terminal executor specific.

## Tests

Update `tests/runtime/actors/terminal-card-processor-actor.test.ts`.

Required tests:

- Plain executor prose gets one repair turn and succeeds when the second turn writes `status.md` and emits `emit_executor_result`.
- Plain executor prose exhausts the repair budget and then fails with the protocol error.
- Invalid `emit_executor_result` arguments get a repair turn instead of immediate card failure.
- Missing `status.md` still repairs by asking the executor to write `record://status.md?v=next` before emitting the terminal result.

Change the existing `does not accept plain executor prose as terminal result` test so it proves prose is not accepted directly but is repairable. It should not keep asserting first-turn failure.

## Non-Goals

- Do not accept text-only executor results.
- Do not parse Markdown/prose into executor result JSON.
- Do not add model-specific prompt hacks.
- Do not add provider-specific fallback behavior.
- Do not make failed terminal cards automatically activatable.
- Do not add a broad compatibility layer around executor output.

## Expected Outcome

After the fix, the pueblicos failure class should behave as follows:

- First executor prose response is recorded as a protocol violation.
- The executor receives an explicit repair turn.
- If the model can comply, it writes `record://status.md?v=next`, calls `emit_executor_result`, and the card completes or fails according to the terminal envelope.
- If the model cannot comply after bounded repairs, the card fails with a clear exhausted-contract-repair error.

The architecture remains strict: terminal cards still complete only through verified terminal tools.
