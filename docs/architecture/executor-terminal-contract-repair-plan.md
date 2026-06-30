# Micro-Actor Terminal Contract Repair Plan

Status: proposed. This document records the pueblicos runtime failure observed on 2026-06-30 and the minimal repair plan.

## Problem

Micro-actor processors fail immediately when a model returns plain assistant text instead of the required terminal tool. In pueblicos, terminal executors returned prose, claimed to have simulated file writes, never called `write`, and never called `emit_executor_result`. The runtime then failed the child cards with:

```text
Expected terminal tool 'emit_executor_result'. Plain executor messages are not accepted as terminal results.
```

The failure is contract-strict, but too brittle: a model gets no repair turn even though the runtime already has a repair pattern for missing `status.md` records.

## Scope Correction

The observed production failure was executor-specific, but the code pattern is shared by all micro-actor terminal processors:

- `src/runtime/actors/terminal-card-processor-actor.ts`: executor plain text fails immediately.
- `src/runtime/actors/planning-card-processor-actor.ts`: planner plain text fails immediately.
- `src/runtime/actors/planning-card-processor-actor.ts`: reviewer plain text fails immediately.

The same processors also convert invalid terminal tool envelopes into immediate failure after `verifyTerminalToolOutcome()` rejects them.

Fix the shared pattern for planner, executor, and reviewer unless implementation shows one path cannot safely repair. The implementation may still be simple per-processor code; do not add a generic framework just to remove three small duplicated branches.

## Root Cause

The micro-actor processor loops handle normal action tools with `llm.appendToolResult(...)`, and they already repair one terminal precondition: missing `record://status.md?v=next`. But they treat these terminal contract failures as final card failures:

- plain assistant text instead of any tool call;
- invalid terminal tool arguments;
- wrong terminal envelope shape.

These are verifier failures, not completed task failures. They should be repairable while a live LLM actor/session still exists.

Startup recovery remains different: if recovery projects a persisted terminal tool call and validation fails, there is no live turn to repair. Recovery may continue to project a failed outcome.

## Target Behavior

For live planner, executor, and reviewer activations:

1. The model may call role action tools.
2. The model must write the required `record://status.md?v=next` when that processor requires it.
3. The model must finish with exactly one valid terminal tool for its role.
4. Plain text, invalid terminal arguments, wrong terminal envelopes, and missing required status records get a bounded repair turn.
5. If the repair budget is exhausted, the card fails with a precise terminal-contract error.

The runtime must still never accept prose as a terminal result and must never synthesize a terminal result from prose.

## Implementation Plan

### 1. Use One Repair Counter Per Activation

Use one local counter for terminal contract repairs in each processor activation loop. Include plain text, invalid terminal envelopes, and missing status records in the same budget.

Example shape:

```ts
const MAX_TERMINAL_CONTRACT_REPAIRS = 2;
let repairAttempts = 0;
```

Do not make the budget configurable yet.

### 2. Repair Plain Assistant Text

When `outcome.type === 'result'`, do not fail immediately. If budget remains, build a new `LlmInvocationInput` from the current `llm.input`:

- keep the existing `systemPrompt`, tools, terminal tool names, model params, and episode context;
- use a fresh `inputId` from the processor's `nextInvocationInputId(...)`;
- append the assistant's plain text to `contextMessages`;
- append a user repair directive telling the model that plain text is not accepted and that it must use tools and re-emit the terminal tool.

Then call `llm.turn(repairInput)` and continue the processor loop.

Repair directive content should be short and role-specific. Executor example:

```text
Your previous response was plain assistant text, not an executor terminal result. Do not summarize, simulate file writes, or describe what you would do. Use tools. Write record://status.md?v=next if needed, then call emit_executor_result with valid JSON arguments.
```

Planner and reviewer variants should name `emit_planner_result` and `emit_reviewer_result` respectively.

If `llm.input` is unexpectedly missing while repairing a live result, throw. That is an impossible live-state bug, not a recoverable condition.

### 3. Repair Invalid Terminal Envelopes

In live activation loops, validate terminal tool calls before projecting the terminal outcome. If `verifyTerminalToolOutcome(...)` rejects:

- consume one repair attempt;
- deliver `{ success: false, error: <validation message> }` to the model with `llm.appendToolResult(outcome.toolCallId, ...)`;
- include a user repair directive that tells the model to call the same terminal tool again with valid arguments;
- continue the processor loop.

Keep recovery projection strict: recovery can still convert invalid persisted terminal calls into failed outcomes because no live model turn can be repaired.

### 4. Keep Status Record Enforcement

Keep the existing missing-`status.md` repair behavior, but count it against the same repair budget. Do not auto-create `status.md`; the processor must force the model to write it.

### 5. Avoid A Framework

Do not route micro-actor processors through `AgentLoopDriver` for this fix. That runner belongs to the older invocation path and would add avoidable lifecycle/session coupling. The micro-actor loops already have the correct place to repair: the current `for`/`while` processor loop around `LLMActor` outcomes.

Small local helper functions are acceptable only if they remove actual duplication in the final diff. Do not introduce new abstractions before the code needs them.

## Rejected Alternative: Force Tool Choice

Adding provider-level `tool_choice: required` could prevent plain-text responses by requiring some tool call on each turn. That is broader than this bug fix:

- it requires provider gateway and capability changes;
- not all providers support required tool choice;
- it does not repair invalid terminal arguments;
- it changes behavior for every tool turn, not just terminal contract failures.

This may be worth considering later, but the immediate fix should repair terminal contract failures at the processor boundary.

## Tests

Update focused processor tests.

Required executor tests:

- Plain executor prose gets a repair turn and succeeds when the next turn writes `status.md` and emits `emit_executor_result`.
- Plain executor prose exhausts the repair budget and then fails.
- Invalid `emit_executor_result` arguments get a repair turn instead of immediate failure.
- Missing `status.md` still repairs and counts against the same budget.

Required planner/reviewer coverage:

- Plain planner prose gets a repair turn before planner failure.
- Plain reviewer prose gets a repair turn before reviewer failure.
- Invalid planner/reviewer terminal arguments get repair turns before failure.

Update the existing executor test named `does not accept plain executor prose as terminal result` so it proves prose is not accepted directly but is repairable. It should no longer assert first-turn card failure.

## Expected Result

The pueblicos failure class should become a repairable terminal-contract violation. Models that can correct themselves after a direct instruction proceed; models that keep returning prose still fail loudly after a bounded number of attempts.
