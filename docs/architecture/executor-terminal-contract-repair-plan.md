# Micro-Actor Tool Compliance And Conversation Continuity Plan

Status: proposed. This document records the pueblicos runtime failure observed on 2026-06-30 and the implementation plan for two related issues: terminal-tool compliance and card-scoped LLM conversation storage and continuity.

## Problem

Micro-actor processors fail immediately when a model returns plain assistant text instead of the required terminal tool. In pueblicos, terminal executors returned prose, claimed to have simulated file writes, never called `write`, and never called `emit_executor_result`. The runtime then failed the child cards with:

```text
Expected terminal tool 'emit_executor_result'. Plain executor messages are not accepted as terminal results.
```

The failure is contract-strict, but too brittle: a model gets no repair turn even though the runtime already has a repair pattern for missing `status.md` records.

There is a second issue in the same path. Micro-actor sessions persist messages under `.saivage/agents/messages/*.jsonl` as a flat append-only log, and `LLMActor` accumulates live conversation in `input.contextMessages` across tool calls. But plain text has no explicit continuation method equivalent to `appendToolResult`, and the persisted log is only a delivery/debug log: it does not persist every provider input, repair directive, or current-state context that would be needed for exact reconstruction. It also has no compaction boundary, so long conversations grow without limit.

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

### 2. Plain Text Has No Explicit Continuation Path

`LLMActor` accumulates conversation across tool calls through `continuationContextMessages()` at `src/runtime/actors/llm-actor.ts:266`:

```ts
return [...input.contextMessages, toolCallMessage, toolResultAgentMessage(delivery), ...extraMessages];
```

Each `appendToolResult` extends `input.contextMessages` with the prior tool call and its result. The model sees prior conversation within one activation for tool-call turns.

But when `outcome.type === 'result'`, the actor resolves and goes idle. Current code keeps `this.input`, but it clears `activeReconstruction` and exposes no method to append the assistant text plus a repair directive and re-enter the provider call. A repair turn started by building a fresh `LlmInvocationInput` would lose the conversation unless the processor manually copies it.

### 3. Conversation Storage Is Not A Reconstructable Transcript

Micro-actor sessions currently persist messages to a single flat JSONL file per agent (`agents/messages/<agentId>.jsonl`). That file logs system prompts, turn activity, assistant text, tool calls, and tool results. It does not log every `input.contextMessages` entry, current-state message, notification message, or repair directive sent to the provider. It is therefore not an exact provider-prompt transcript.

There is also no mechanism to close a segment, compact older conversation into a summary, and continue in a new segment. Long-lived or chatty sessions grow without limit, and there is no explicit boundary for recovery or context budgeting.

Startup recovery remains different: if recovery projects a persisted terminal tool call and validation fails, there is no live turn to repair. Recovery may continue to project a failed outcome.

## Conversation Invariant

For a card-scoped agent session, every live LLM call within one activation must see the full session conversation since that activation started (or since the last compaction boundary), plus fresh current-state context for the current turn.

The in-memory `input.contextMessages` accumulated by `LLMActor` is the authority for live turns. The active LLM actor snapshot (`active_reconstruction.input`) is the primary and normally only recovery authority for an interrupted live activation; it already stores the full `input.contextMessages` at the point of interruption. Persisted conversation segments are audit, debugging, and cold reconstruction for rebuilding history after compaction removed it from active reconstruction.

Runtime state, card state, notifications, and planner/reviewer context are additional current-state inputs appended each turn. If those messages are sent to the provider and are expected to survive restart or compaction, they must also be persisted as transcript rows. Do not assume the current delivery log already contains them.

If the in-memory conversation becomes too large, compaction creates an explicit compacted summary, replaces the in-memory prefix with that summary, and opens a new persisted segment so future messages append to the compacted boundary. Do not silently drop old messages.

## Storage Model

Conversation storage mirrors card record storage: segment-based, with an index pointing to the active segment and compaction boundary. It replaces the flat message log for micro-actor conversation messages and must preserve every read path that currently depends on `agents/messages/*.jsonl`.

### File Layout

```
.saivage/agents/conversations/<sessionId>/
  index.json
  seg-001.jsonl
  seg-002.jsonl
  ...
```

Each segment is an append-only JSONL of `AgentMessage` rows. Segment rows are a provider transcript plus activity metadata, not just delivery events. When the provider receives a user/system/context/repair message, the segment must contain a corresponding `AgentMessage` row.

Use existing message kinds where possible:

- `system_prompt` for the system prompt row;
- `activity` for lifecycle rows that are not sent to the provider;
- `text` for normal assistant/user text;
- `tool_call` and `tool_result` for tool turns;
- `model_repair` for repair directives;
- `context_compaction` for compacted summaries;
- `model_issue` for provider errors.

`index.json` records:

- the active segment filename;
- the compaction boundary: the message id or sequence after which the active segment holds uncompacted conversation;
- optional compacted summary pointer if older segments were summarized.

The index must be updated atomically enough that startup sees either the previous active segment or the new active segment, never a half-written pointer to a missing file.

### Required Reader Updates

The old flat files are not kept as a compatibility path, so every current reader must move to the segment API in the same change:

- `appendActorMessage(...)` writes to the active segment for `input.sessionId` rather than `agents/messages/<agentId>.jsonl`.
- `appendActorSystemPromptIfMissing(...)` checks the session index/segments for the system prompt row.
- `readLoggedToolCall(...)` takes or derives the session id from `active_reconstruction.input.sessionId` and searches conversation segments for the session/agent tool call row instead of `actorMessagesPath(...)`.
- `actor-recovery.ts` paths that project waiting terminal tool calls must use the new segment-backed `readLoggedToolCall(...)`.

Tool delivery and tool-call status ledgers remain separate under `agents/tool-deliveries/` and `agents/tool-call-statuses/`. They are operational ledgers with their own schemas and query paths (e.g. `abandonStalePendingToolCalls`), not the conversation transcript. Segments contain provider-visible `AgentMessage` rows; ledgers contain `ToolDeliveryRecord` and `ToolCallStatusRecord` rows. They coexist by design, not by compatibility or duplication.

### Compaction

When a live conversation exceeds a critical size:

1. Compact older messages into a summary `AgentMessage` (role `system`, kind `context_compaction`).
2. Close the current segment file.
3. Open a new segment file.
4. Write the compacted summary as the first message of the new segment.
5. Update `index.json` to point at the new active segment and record the compaction boundary.
6. Replace the in-memory `input.contextMessages` prefix with the compacted summary.

Future turns append to the new segment. Old segments remain on disk for audit and recovery.

### Recovery

Active reconstruction is the primary and normally only recovery authority. `actor-recovery.ts` reads waiting tool call arguments from `active_reconstruction` and already has the full `input.contextMessages` at the point of interruption. Segments are audit and debugging; cold segment reconstruction is for restoring history after compaction removed it from active reconstruction, or for inspecting a completed session.

Do not add migration or compatibility logic for the old flat `agents/messages/*.jsonl` files. Fail loudly if the index or active segment is malformed.

Remove `actorMessagesPath(...)` and `actorToolDeliveriesPath(...)` flat-log dead code after the cutover. The segment API and the separate tool delivery/status ledgers fully replace them.

## Target Behavior

For live planner, executor, and reviewer activations:

1. The model may call role action tools.
2. The model must write the required `record://status.md?v=next` when that processor requires it.
3. The model must finish with exactly one valid terminal tool for its role.
4. Plain text, invalid terminal arguments, wrong terminal envelopes, and missing required status records get a bounded repair turn.
5. If the repair budget is exhausted, the card fails with a precise terminal-contract error.
6. Each live LLM call sees the accumulated in-memory conversation for the current activation, plus fresh current-state context.
7. Conversation messages are persisted as segment-backed provider-visible transcript rows.

The runtime must still never accept prose as a terminal result and must never synthesize a terminal result from prose.

## Implementation Plan

The plan is split into two phases. Phase 1 fixes the pueblicos production bug and the conversation persistence gap. Phase 2 adds compaction. Phase 1 is the immediate target; Phase 2 is deferred until Phase 1 is stable and compaction is proven necessary.

### Phase 1: Terminal Repair And Segment Storage

#### 1. Extend In-Memory Continuation To Plain Text

`LLMActor` already accumulates conversation across tool calls through `continuationContextMessages()`. Extend the same mechanism to plain assistant text.

Add a method on `LLMActor` for continuing after a plain-text result:

- require `this.input` to be present, the actor state to be `idle`, the previous outcome to be `result`, and no pending turn;
- append the assistant's plain text as a synthetic assistant message to `input.contextMessages`;
- append a user repair directive to `input.contextMessages`;
- use a fresh `inputId`;
- call `turn()` again with the updated input so the normal turn path recreates `activeReconstruction` and prepares provider-call reconstruction.

This mirrors `appendToolResult` but without a tool call. The key change is not preserving `this.input` (current code already does that); it is adding an explicit, snapshot-safe way to append the plain assistant message and repair directive, create the next input id, and re-enter the provider call through the normal turn path.

Because the assistant text and repair directive are appended to `input.contextMessages` before `turn()` is called, the next `activeReconstruction` snapshot captures them in `input.contextMessages`. Recovery therefore works immediately even before segment persistence lands.

Repair directive content should be short and role-specific. Executor example:

```text
Your previous response was plain assistant text, not an executor terminal result. Do not summarize, simulate file writes, or describe what you would do. Use tools. Write record://status.md?v=next if needed, then call emit_executor_result with valid JSON arguments.
```

Planner and reviewer variants should name `emit_planner_result` and `emit_reviewer_result` respectively.

If `this.input` is unexpectedly missing while repairing a live result, throw. That is an impossible live-state bug, not a recoverable condition.

#### 2. Use One Repair Counter Per Activation

Use one local counter for terminal contract repairs in each processor activation loop. Include plain text, invalid terminal envelopes, and missing status records in the same budget. The reviewer still keeps its separate stale-currentness relaunch budget; terminal-contract repair does not replace reviewer relaunch handling.

```ts
const MAX_TERMINAL_CONTRACT_REPAIRS = 2;
let repairAttempts = 0;
```

Do not make the budget configurable yet.

#### 3. Repair Plain Assistant Text

In each processor activation loop, when `outcome.type === 'result'`:

- if budget remains, call the new `LLMActor` continuation method with a role-specific repair directive;
- continue the processor loop;
- if budget is exhausted, fail with the current protocol error.

#### 4. Repair Invalid Terminal Envelopes

In live activation loops, validate terminal tool calls before projecting the terminal outcome. If `verifyTerminalToolOutcome(...)` rejects:

- consume one repair attempt;
- deliver `{ success: false, error: <validation message> }` to the model with `llm.appendToolResult(outcome.toolCallId, ...)`;
- include a user repair directive that tells the model to call the same terminal tool again with valid arguments;
- continue the processor loop.

Keep recovery projection strict: recovery can still convert invalid persisted terminal calls into failed outcomes because no live model turn can be repaired.

#### 5. Keep Status Record Enforcement

Keep the existing missing-`status.md` repair behavior, but count it against the same repair budget. Do not auto-create `status.md`; the processor must force the model to write it.

#### 6. Add Segment-Based Conversation Storage

Replace the flat `agents/messages/<agentId>.jsonl` append/read path for micro-actor conversation messages with segment-based storage under `agents/conversations/<sessionId>/`.

- Each append writes to the active segment JSONL.
- `index.json` tracks the active segment and compaction boundary.
- The existing delivery-log functions (`appendLlmTurnStarted`, `appendLlmTurnFinished`, `appendToolDelivery`, `appendLlmTurnError`) should write to the active segment.
- Provider-visible context messages, current-state messages, notification messages, and repair directives must also be written to the active segment when they are added to `input.contextMessages`.
- Recovery readers, especially `readLoggedToolCall(...)`, must read from segments in the same change and must use the active reconstruction session id for reviewer sessions where `sessionId !== agentId`.
- Activity and system-prompt rows may stay in the segment or move to a separate metadata file; pick whichever is simpler during implementation.

Do not keep the old flat file as a compatibility path. Cut over by writing new conversation rows to segments.

### Phase 2: Compaction (Deferred)

Compaction is deferred until Phase 1 is stable and compaction is proven necessary. Do not implement Phase 2 in the same change as Phase 1.

When the in-memory `input.contextMessages` exceeds a critical size:

- compact older messages into a summary message;
- close the current segment file;
- open a new segment file;
- write the summary as the first message of the new segment;
- update `index.json`;
- replace the in-memory conversation prefix with the summary.

Compaction may be triggered before a provider call when the accumulated context size is known. Keep the compaction trigger simple: a byte or message-count threshold checked in `LLMActor` before calling the provider.

Do not introduce a separate summarizer framework. Use the existing provider through a small internal compaction call. Segment rollover without summary is acceptable as an intermediate step only if it does not claim to reduce provider context.

### Avoid A Framework

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
- Provider-visible context, notification, and repair messages are persisted as transcript rows, not only delivery-log activity.
- `readLoggedToolCall(...)` finds tool calls from segments, including reviewer sessions where `sessionId !== agentId`.
- Recovery uses `active_reconstruction.input` for interrupted live activations; segments are audit and debugging.
- `actorMessagesPath(...)` and `actorToolDeliveriesPath(...)` flat-log dead code is removed.
- Malformed index or active segment fails loudly.

Compaction tests are deferred to Phase 2 with the compaction implementation.

Update the existing executor test named `does not accept plain executor prose as terminal result` so it proves prose is not accepted directly but is repairable. It should no longer assert first-turn card failure.

## Expected Result

The pueblicos failure class should become a repairable terminal-contract violation. Models that can correct themselves after a direct instruction proceed; models that keep returning prose still fail loudly after a bounded number of attempts.

Every micro-actor LLM call should see the accumulated in-memory conversation for the current activation, plus fresh current-state context for the current turn. Conversation storage should be segment-based with exact provider-visible transcript rows and segment-backed recovery readers. Compaction is deferred to Phase 2.
