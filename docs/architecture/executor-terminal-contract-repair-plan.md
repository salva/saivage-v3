# Micro-Actor Tool Compliance And Conversation Continuity Plan

Status: proposed. This document records the pueblicos runtime failure observed on 2026-06-30 and the implementation plan for two related issues: terminal-tool compliance and card-scoped LLM conversation continuity.

## Problem

Micro-actor processors fail immediately when a model returns plain assistant text instead of the required terminal tool. In pueblicos, terminal executors returned prose, claimed to have simulated file writes, never called `write`, and never called `emit_executor_result`. The runtime then failed the child cards with:

```text
Expected terminal tool 'emit_executor_result'. Plain executor messages are not accepted as terminal results.
```

The failure is contract-strict, but too brittle: a model gets no repair turn even though the runtime already has a repair pattern for missing `status.md` records.

There is a second issue in the same path. Micro-actor sessions persist messages under `.saivage/agents/messages/*.jsonl`, but later LLM turns are driven only by the `contextMessages` field passed in the current `LlmInvocationInput`. The persisted transcript is observable state, not the source used to rebuild every model call. A card-scoped agent can therefore lose prior conversation unless the current continuation path manually preserved it.

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

### 2. Persisted Transcript Is Not The Model Context Authority

The micro-actor processor loops handle normal action tools with `llm.appendToolResult(...)`, and they already repair one terminal precondition: missing `record://status.md?v=next`. But they treat these terminal contract failures as final card failures:

- plain assistant text instead of any tool call;
- invalid terminal tool arguments;
- wrong terminal envelope shape.

These are verifier failures, not completed task failures. They should be repairable while a live LLM actor/session still exists.

Separately, `LLMActor` appends messages to the agent transcript through `appendLlmTurnStarted(...)`, `appendLlmTurnFinished(...)`, and `appendToolDelivery(...)`. But the next provider call receives whatever `contextMessages` are present in the current `LlmInvocationInput`. It does not reload the session transcript from disk. This makes the LLM actor's actual context depend on manual context-message threading rather than the card session transcript.

Startup recovery remains different: if recovery projects a persisted terminal tool call and validation fails, there is no live turn to repair. Recovery may continue to project a failed outcome.

## Conversation Invariant

For a card-scoped agent session, every LLM call must be built from the session conversation for that card since the agent was instantiated, unless compaction has replaced older messages with an explicit compacted summary.

The persisted transcript must be the authority for what the model has already said and what tool results it has received. Runtime state, card state, notifications, and planner/reviewer context are additional current-state inputs; they do not replace the transcript.

Initial card activation starts a new role/card session such as `planner:project`, `executor:<card-id>`, or `reviewer:<assessment-id>`. Later turns for that same session must include:

- the system prompt or its current equivalent;
- prior assistant tool calls and text messages;
- prior tool results;
- model repair messages;
- current state/context messages that are intentionally regenerated for the new turn.

If the conversation is too large, compaction must create an explicit compacted message or summary artifact and the next LLM input must use that compacted boundary. Do not silently drop old messages.

## Target Behavior

For live planner, executor, and reviewer activations:

1. The model may call role action tools.
2. The model must write the required `record://status.md?v=next` when that processor requires it.
3. The model must finish with exactly one valid terminal tool for its role.
4. Plain text, invalid terminal arguments, wrong terminal envelopes, and missing required status records get a bounded repair turn.
5. If the repair budget is exhausted, the card fails with a precise terminal-contract error.

The runtime must still never accept prose as a terminal result and must never synthesize a terminal result from prose.

## Implementation Plan

### 1. Make Session Transcript Reconstruction Explicit

Add a small transcript assembly function for micro-actor LLM calls. It should read the persisted session messages for the target `agentId/sessionId`, apply compaction boundaries when present, and return valid `AgentMessage[]` context for the next provider call.

The first implementation should be simple:

- read `.saivage/agents/messages/${encodeURIComponent(agentId)}.jsonl`;
- parse existing `AgentMessage` rows using the current schema;
- exclude the persisted `system_prompt` row from `contextMessages` because the provider call already receives `systemPrompt` separately;
- preserve assistant text, assistant tool calls, tool results, model repair messages, and model issue messages in order;
- append fresh current-state messages for the specific turn after the transcript-derived messages.

Do not add migration or compatibility logic for malformed historical transcripts. Fail loudly if the active transcript is malformed.

### 2. Route Micro-Actor Provider Calls Through Transcript Assembly

Before each `LLMActor` provider call, rebuild `input.contextMessages` from persisted session transcript plus the turn's current-state extras. This keeps the model scope aligned with the card-scoped session rather than with an in-memory continuation chain.

The simplest implementation point is inside `LLMActor._on_enter__calling_provider()` before `provider.completeTurn(...)`:

- take the requested `input`;
- build the effective context for `input.agentId` / `input.sessionId`;
- pass an effective input to `provider.completeTurn(...)`;
- persist the effective input in active reconstruction so recovery sees what the provider actually received.

If that makes `LLMActor` too dependent on transcript storage, put the assembly in a small runtime/actors helper called by `LLMActor`. Do not route through the old `AgentLoopDriver`.

### 3. Represent Fresh Current-State Messages Separately

The current `contextMessages` field mixes durable conversation history with fresh state snapshots and notifications. Split the intent in code, even if the public type remains simple initially:

- transcript messages come from persisted session history;
- fresh messages come from processor context builders such as planner state, reviewer currentness, and notification delivery;
- effective provider context is `transcript + freshMessages`.

Avoid persisting regenerated state snapshots as if they were permanent conversation history unless they are intentionally part of the session conversation. The model should see current state each turn, but the transcript should not accumulate duplicate stale snapshots indefinitely.

### 4. Use One Repair Counter Per Activation

Use one local counter for terminal contract repairs in each processor activation loop. Include plain text, invalid terminal envelopes, and missing status records in the same budget.

Example shape:

```ts
const MAX_TERMINAL_CONTRACT_REPAIRS = 2;
let repairAttempts = 0;
```

Do not make the budget configurable yet.

### 5. Repair Plain Assistant Text

When `outcome.type === 'result'`, do not fail immediately. If budget remains, append a model repair message to the session transcript and start another LLM turn for the same session.

Because the next provider call is rebuilt from the transcript, the repair turn does not need to hand-copy the full conversation into `contextMessages`. It only needs a fresh current-state context and a persisted repair directive.

Then call `llm.turn(repairInput)` and continue the processor loop.

Repair directive content should be short and role-specific. Executor example:

```text
Your previous response was plain assistant text, not an executor terminal result. Do not summarize, simulate file writes, or describe what you would do. Use tools. Write record://status.md?v=next if needed, then call emit_executor_result with valid JSON arguments.
```

Planner and reviewer variants should name `emit_planner_result` and `emit_reviewer_result` respectively.

If `llm.input` is unexpectedly missing while repairing a live result, throw. That is an impossible live-state bug, not a recoverable condition.

### 6. Repair Invalid Terminal Envelopes

In live activation loops, validate terminal tool calls before projecting the terminal outcome. If `verifyTerminalToolOutcome(...)` rejects:

- consume one repair attempt;
- deliver `{ success: false, error: <validation message> }` to the model with `llm.appendToolResult(outcome.toolCallId, ...)`;
- include a user repair directive that tells the model to call the same terminal tool again with valid arguments;
- continue the processor loop.

Keep recovery projection strict: recovery can still convert invalid persisted terminal calls into failed outcomes because no live model turn can be repaired.

### 7. Keep Status Record Enforcement

Keep the existing missing-`status.md` repair behavior, but count it against the same repair budget. Do not auto-create `status.md`; the processor must force the model to write it.

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

## Rejected Alternative: Keep Context In Memory Only

Another possible fix is to continue manually threading `contextMessages` through `LLMActor.input`, appending plain text and repair messages in memory. That is smaller for the immediate executor failure, but it keeps the unclear semantics that triggered this review: the transcript is persisted but not authoritative. It also makes recovery and compaction harder to reason about.

Use persisted session transcript reconstruction instead.

## Tests

Update focused processor tests.

Required executor tests:

- A second executor provider call sees the first assistant text from the persisted transcript.
- Plain executor prose gets a repair turn and succeeds when the next turn writes `status.md` and emits `emit_executor_result`.
- Plain executor prose exhausts the repair budget and then fails.
- Invalid `emit_executor_result` arguments get a repair turn instead of immediate failure.
- Missing `status.md` still repairs and counts against the same budget.

Required planner/reviewer coverage:

- A second planner/reviewer provider call sees prior same-session conversation from the persisted transcript.
- Plain planner prose gets a repair turn before planner failure.
- Plain reviewer prose gets a repair turn before reviewer failure.
- Invalid planner/reviewer terminal arguments get repair turns before failure.

Required transcript/context coverage:

- Effective provider context excludes duplicate `system_prompt` rows because `systemPrompt` is supplied separately.
- Effective provider context includes prior assistant text, assistant tool calls, tool results, and model repair messages in order.
- Fresh state messages are appended after transcript-derived messages.
- Malformed active transcript rows fail loudly.

Update the existing executor test named `does not accept plain executor prose as terminal result` so it proves prose is not accepted directly but is repairable. It should no longer assert first-turn card failure.

## Expected Result

The pueblicos failure class should become a repairable terminal-contract violation. Models that can correct themselves after a direct instruction proceed; models that keep returning prose still fail loudly after a bounded number of attempts.

Every micro-actor LLM call should also have clear scope: the model sees the card-scoped session conversation since instantiation, or an explicit compacted replacement, plus fresh current-state context for the current turn.
