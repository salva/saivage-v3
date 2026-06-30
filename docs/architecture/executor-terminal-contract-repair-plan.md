# Micro-Actor Tool Compliance And Conversation Continuity Plan

Status: proposed. This document records the pueblicos runtime failure observed on 2026-06-30 and the implementation plan for two related issues: terminal-tool compliance and card-scoped LLM conversation storage and continuity.

## Problem

Micro-actor processors fail immediately when a model returns plain assistant text instead of the required terminal tool. In pueblicos, terminal executors returned prose, claimed to have simulated file writes, never called `write`, and never called `emit_executor_result`. The runtime then failed the child cards with:

```text
Expected terminal tool 'emit_executor_result'. Plain executor messages are not accepted as terminal results.
```

The failure is contract-strict, but too brittle: a model gets no repair turn even though the runtime already has a repair pattern for missing `status.md` records.

There is a second issue in the same path. Micro-actor sessions persist messages under `.saivage/agents/messages/*.jsonl` as a flat append-only log, and `LLMActor` accumulates live conversation in `input.contextMessages` across tool calls. But plain text breaks the in-memory continuation chain because there is no `appendToolResult` path for it, and the persisted log has no compaction boundary, so long conversations grow without limit.

## Scope Correction

The observed production failure was executor-specific, but the code pattern is shared by all micro-actor terminal processors:

- `src/runtime/actors/terminal-card-processor-actor.ts`: executor plain text fails immediately.
- `src/runtime/actors/planning-card-processor-actor.ts`: planner plain text fails immediately.
- `src/runtime/actors/planning-card-processor-actor.ts`: reviewer plain text fails immediately.

The same processors also convert invalid terminal tool envelopes into immediate failure after `verifyTerminalToolOutcome()` rejects them.

Fix the shared pattern for planner, executor, and reviewer unless implementation shows one path cannot safely repair. The implementation may still be simple per-processor code; do not add a generic framework just to remove three small duplicated branches.

## Root Causes

### 1. Tool Compliance Is Only Requested, Not Enforced

The micro-actor processor requests tool-capable models and passes terminal tools, but provider options use automatic tool choice. Tool support does not guarantee tool use. A model can still return plain text.

When that happens, the processor currently treats the plain text as a final card failure rather than a repairable verifier failure.

### 2. Plain Text Breaks The In-Memory Continuation Chain

`LLMActor` accumulates conversation across tool calls through `continuationContextMessages()` at `src/runtime/actors/llm-actor.ts:266`:

```ts
return [...input.contextMessages, toolCallMessage, toolResultAgentMessage(delivery), ...extraMessages];
```

Each `appendToolResult` extends `input.contextMessages` with the prior tool call and its result. The model sees prior conversation within one activation for tool-call turns.

But when `outcome.type === 'result'`, the actor resolves and goes idle. There is no continuation path and the accumulated `input.contextMessages` is discarded. A repair turn started with a fresh `LlmInvocationInput` loses the conversation unless the processor manually copies it.

### 3. Conversation Storage Has No Compaction Boundary

Micro-actor sessions currently persist messages to a single flat JSONL file per agent (`agents/messages/<agentId>.jsonl`). There is no mechanism to close a segment, compact older conversation into a summary, and continue in a new segment. Long-lived or chatty sessions grow without limit, and there is no explicit boundary for recovery or context budgeting.

Startup recovery remains different: if recovery projects a persisted terminal tool call and validation fails, there is no live turn to repair. Recovery may continue to project a failed outcome.

## Conversation Invariant

For a card-scoped agent session, every live LLM call within one activation must see the full session conversation since that activation started (or since the last compaction boundary), plus fresh current-state context for the current turn.

The in-memory `input.contextMessages` accumulated by `LLMActor` is the authority for live turns. Persisted conversation segments are the authority for recovery and compaction. Runtime state, card state, notifications, and planner/reviewer context are additional current-state inputs appended each turn; they do not replace the conversation.

If the in-memory conversation becomes too large, compaction creates an explicit compacted summary, replaces the in-memory prefix with that summary, and opens a new persisted segment so future messages append to the compacted boundary. Do not silently drop old messages.

## Storage Model

Conversation storage mirrors card record storage: segment-based, with an index pointing to the active segment and compaction boundary.

### File Layout

```
.saivage/agents/conversations/<sessionId>/
  index.json
  seg-001.jsonl
  seg-002.jsonl
  ...
```

Each segment is an append-only JSONL of `AgentMessage` rows.

`index.json` records:

- the active segment filename;
- the compaction boundary: the message id or sequence after which the active segment holds uncompacted conversation;
- optional compacted summary pointer if older segments were summarized.

### Compaction

When a live conversation exceeds a critical size:

1. Compact older messages into a summary `AgentMessage` (role `system`, kind `compacted_summary` or similar).
2. Close the current segment file.
3. Open a new segment file.
4. Write the compacted summary as the first message of the new segment.
5. Update `index.json` to point at the new active segment and record the compaction boundary.
6. Replace the in-memory `input.contextMessages` prefix with the compacted summary.

Future turns append to the new segment. Old segments remain on disk for audit and recovery.

### Recovery

To reconstruct conversation after restart:

1. Read `index.json` for the session.
2. Load messages from the compaction boundary forward in the active segment.
3. Replace the in-memory conversation prefix with the compacted summary if present.
4. Continue the activation with the reconstructed conversation plus fresh current-state context.

Do not add migration or compatibility logic for the old flat `agents/messages/*.jsonl` files. Fail loudly if the index or active segment is malformed.

## Target Behavior

For live planner, executor, and reviewer activations:

1. The model may call role action tools.
2. The model must write the required `record://status.md?v=next` when that processor requires it.
3. The model must finish with exactly one valid terminal tool for its role.
4. Plain text, invalid terminal arguments, wrong terminal envelopes, and missing required status records get a bounded repair turn.
5. If the repair budget is exhausted, the card fails with a precise terminal-contract error.
6. Each live LLM call sees the accumulated in-memory conversation for the current activation, plus fresh current-state context.
7. When conversation size exceeds the critical threshold, compaction replaces the in-memory prefix and opens a new persisted segment.

The runtime must still never accept prose as a terminal result and must never synthesize a terminal result from prose.

## Implementation Plan

### 1. Extend In-Memory Continuation To Plain Text

`LLMActor` already accumulates conversation across tool calls through `continuationContextMessages()`. Extend the same mechanism to plain assistant text.

Add a method on `LLMActor` for continuing after a plain-text result:

- keep `this.input` (do not clear it on `result` outcome);
- append the assistant's plain text as a synthetic assistant message to `input.contextMessages`;
- append a user repair directive to `input.contextMessages`;
- use a fresh `inputId`;
- call `turn()` again with the updated input.

This mirrors `appendToolResult` but without a tool call. The key change is that `outcome.type === 'result'` no longer clears `this.input`; instead the processor can request a continuation.

Repair directive content should be short and role-specific. Executor example:

```text
Your previous response was plain assistant text, not an executor terminal result. Do not summarize, simulate file writes, or describe what you would do. Use tools. Write record://status.md?v=next if needed, then call emit_executor_result with valid JSON arguments.
```

Planner and reviewer variants should name `emit_planner_result` and `emit_reviewer_result` respectively.

If `this.input` is unexpectedly missing while repairing a live result, throw. That is an impossible live-state bug, not a recoverable condition.

### 2. Use One Repair Counter Per Activation

Use one local counter for terminal contract repairs in each processor activation loop. Include plain text, invalid terminal envelopes, and missing status records in the same budget.

```ts
const MAX_TERMINAL_CONTRACT_REPAIRS = 2;
let repairAttempts = 0;
```

Do not make the budget configurable yet.

### 3. Repair Plain Assistant Text

In each processor activation loop, when `outcome.type === 'result'`:

- if budget remains, call the new `LLMActor` continuation method with a role-specific repair directive;
- continue the processor loop;
- if budget is exhausted, fail with the current protocol error.

### 4. Repair Invalid Terminal Envelopes

In live activation loops, validate terminal tool calls before projecting the terminal outcome. If `verifyTerminalToolOutcome(...)` rejects:

- consume one repair attempt;
- deliver `{ success: false, error: <validation message> }` to the model with `llm.appendToolResult(outcome.toolCallId, ...)`;
- include a user repair directive that tells the model to call the same terminal tool again with valid arguments;
- continue the processor loop.

Keep recovery projection strict: recovery can still convert invalid persisted terminal calls into failed outcomes because no live model turn can be repaired.

### 5. Keep Status Record Enforcement

Keep the existing missing-`status.md` repair behavior, but count it against the same repair budget. Do not auto-create `status.md`; the processor must force the model to write it.

### 6. Add Segment-Based Conversation Storage

Replace the flat `agents/messages/<agentId>.jsonl` append path for micro-actor conversation messages with segment-based storage under `agents/conversations/<sessionId>/`.

- Each append writes to the active segment JSONL.
- `index.json` tracks the active segment and compaction boundary.
- The existing delivery-log functions (`appendLlmTurnStarted`, `appendLlmTurnFinished`, `appendToolDelivery`, `appendLlmTurnError`) should write to the active segment.
- Activity and system-prompt rows may stay in the segment or move to a separate metadata file; pick whichever is simpler during implementation.

Do not keep the old flat file as a compatibility path. Cut over by writing new conversation rows to segments.

### 7. Add Compaction

When the in-memory `input.contextMessages` exceeds a critical size:

- compact older messages into a summary message;
- close the current segment file;
- open a new segment file;
- write the summary as the first message of the new segment;
- update `index.json`;
- replace the in-memory conversation prefix with the summary.

Compaction may be triggered before a provider call when the accumulated context size is known. Keep the compaction trigger simple: a byte or message-count threshold checked in `LLMActor` before calling the provider.

### 8. Avoid A Framework

Do not route micro-actor processors through `AgentLoopDriver` for this fix. That runner belongs to the older invocation path and would add avoidable lifecycle/session coupling. The micro-actor loops already have the correct place to repair: the current `for`/`while` processor loop around `LLMActor` outcomes.

Small local helper functions are acceptable only if they remove actual duplication in the final diff. Do not introduce new abstractions before the code needs them.

## Rejected Alternative: Force Tool Choice

Adding provider-level `tool_choice: required` could prevent plain-text responses by requiring some tool call on each turn. That is broader than this bug fix:

- it requires provider gateway and capability changes;
- not all providers support required tool choice;
- it does not repair invalid terminal arguments;
- it changes behavior for every tool turn, not just terminal contract failures.

This may be worth considering later, but the immediate fix should repair terminal contract failures at the processor boundary.

## Rejected Alternative: Disk Reconstruction Every Turn

Reading the persisted JSONL from disk before every provider call would replace a working in-memory mechanism with unnecessary I/O and parsing complexity. `LLMActor` already accumulates conversation across tool calls through `continuationContextMessages()`. The only missing case is plain text continuation, which is solved by extending the in-memory path. Disk is for persistence, recovery, and compaction, not for rebuilding live context on every turn.

## Tests

Update focused processor tests.

Required executor tests:

- A plain-text repair turn preserves prior conversation in `input.contextMessages`.
- Plain executor prose gets a repair turn and succeeds when the next turn writes `status.md` and emits `emit_executor_result`.
- Plain executor prose exhausts the repair budget and then fails.
- Invalid `emit_executor_result` arguments get a repair turn instead of immediate failure.
- Missing `status.md` still repairs and counts against the same budget.

Required planner/reviewer coverage:

- Plain planner prose gets a repair turn before planner failure.
- Plain reviewer prose gets a repair turn before reviewer failure.
- Invalid planner/reviewer terminal arguments get repair turns before failure.

Required conversation storage coverage:

- Conversation messages append to segment JSONL files under `agents/conversations/<sessionId>/`.
- `index.json` tracks the active segment.
- Compaction closes the current segment, opens a new one with a summary, and updates the index.
- Recovery loads conversation from the compaction boundary forward.
- Malformed index or active segment fails loudly.

Update the existing executor test named `does not accept plain executor prose as terminal result` so it proves prose is not accepted directly but is repairable. It should no longer assert first-turn card failure.

## Expected Result

The pueblicos failure class should become a repairable terminal-contract violation. Models that can correct themselves after a direct instruction proceed; models that keep returning prose still fail loudly after a bounded number of attempts.

Every micro-actor LLM call should see the accumulated in-memory conversation for the current activation, plus fresh current-state context for the current turn. Conversation storage should be segment-based with explicit compaction boundaries so long sessions do not grow without limit and recovery can reconstruct from the compaction boundary forward.