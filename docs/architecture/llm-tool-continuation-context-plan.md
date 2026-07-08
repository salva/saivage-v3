# LLM Tool Continuation Context Design And Plan

Status: implemented.

## Problem

The micro-actor executor enters a repeated tool-use loop because tool results are persisted for operator inspection but are not included in the next provider request as model-visible context.

The live GetRich v2 run exposed the issue on `executor:card-4`:

- the executor received the correct card instructions;
- the executor was offered the correct process and terminal tools;
- tool calls and tool results were written to the agent conversation transcript, `.saivage/agents/tool-deliveries/`, and `.saivage/agents/llm-exchanges/`;
- every recorded Codex request still contained only one user input: `Proceed with the task described in the instructions.`;
- prior `run_process` outputs were not present in the next provider request;
- the model repeatedly made first-turn inspection calls because each continuation looked like a fresh request.

This is a context propagation bug, not primarily an executor-quality or turn-budget problem. The turn budget correctly stopped an otherwise unbounded no-progress loop, but the model was effectively operating with amnesia.

## Current Data Flow

Current actor path:

1. `TerminalCardProcessorActor` builds an initial `LlmInvocationInput` with card instructions, tools, terminal tool names, and notification-derived context messages.
2. `LLMActor.turn(input)` stores `input` as `this.input` and calls the provider port.
3. The provider returns a tool call.
4. `completeWithProviderResult(...)` stores `waitingToolCall` and updates active reconstruction with `waiting_tool_call` only. It does not modify `this.input`.
5. The owning processor executes the tool.
6. `LLMActor.appendToolResult(...)` calls `continuationContextMessages(input, deliveryInputId, hook)` which returns `[...input.contextMessages, ...extraNotificationMessages]`. The assistant tool call and tool result are not appended.
7. `appendToolResult(...)` sets `this.input = { ...input, contextMessages, ... }`, preserving only the original context plus notifications.
8. `InvocationProviderTurnPort` passes `input.contextMessages` (validated as `AgentMessage[]`) to the invocation service.
9. The provider gateway serializes those `AgentMessage[]` into provider-specific request messages.

The missing step: `LLMActor` never appends model-visible `AgentMessage` entries for the assistant tool call and the matching tool result to `this.input.contextMessages` before the continuation provider call.

## Code Investigation Findings

The gateways already serialize tool history correctly. No gateway changes are needed:

- `codexMessages(...)` in `llm-openai-codex-gateway.ts` maps assistant `kind: 'tool_call'` messages to `function_call` entries and `role: 'tool'` messages to `function_call_output` entries. It uses a `callIdsWithOutput` pre-scan: a tool call is only included if its matching tool result is also present. This means the assistant tool-call message and the tool-result message must both be in context before the next provider call, or the Codex gateway drops both.
- `buildOpenAIChatRequest(...)` in `llm-openai-chat-gateway.ts` maps assistant `kind: 'tool_call'` messages to `{ role: 'assistant', tool_calls: [...] }` and `role: 'tool'` messages to `{ role: 'tool', content, tool_call_id }`. It includes `sanitizeToolCallSequences(...)` which drops assistant `tool_calls` entries without matching tool results.
- Both gateways already handle the full paired-call/output protocol. The bug is exclusively in `LLMActor` not feeding the messages into `this.input.contextMessages`.

The message-building logic already exists in `llm-delivery-log.ts`:

- `appendToolCallMessage(...)` builds an `AgentMessage` with `role: 'assistant'`, `kind: 'tool_call'`, canonical `content: { role: 'assistant', tool_calls: [...] }`, `tool: toolCall.function.name`, `tool_call_id: toolCall.id`, and persists it to the segment-backed conversation transcript.
- `appendToolDelivery(...)` builds an `AgentMessage` with `role: 'tool'`, `kind: 'tool_result'`, `content: JSON.stringify(result)`, `tool: tool_name`, `tool_call_id: tool_call_id`, and persists it.

Both functions currently persist to disk but return `void`. The message construction logic needs to be extracted into reusable helpers that return `AgentMessage` objects.

The active reconstruction schema already supports full context persistence:

- `LlmActiveReconstructionRecord.input` contains `contextMessages: z.array(z.unknown())`.
- `this.input.contextMessages` is already stored in active reconstruction via `activeReconstruction.input`.
- No schema change is needed. If `this.input.contextMessages` is updated and `updateActiveReconstruction({ input: this.input })` is called, the snapshot automatically reflects the new transcript.

## Architecture Decision

`LLMActor` appends model-visible `AgentMessage` entries directly to `this.input.contextMessages`. No separate transcript field is needed.

`this.input.contextMessages` is already the live provider context. It is already passed to `InvocationProviderTurnPort` for every provider call. It is already persisted in active reconstruction via `input`. Adding a parallel `modelContextMessages` field would duplicate state and violate the simple-architecture principle.

The concrete implemented change is:

- In `completeWithProviderResult(...)`, when a nonterminal tool call is returned, preserve the waiting tool call id, name, and raw argument string.
- In `appendToolResult(...)`, build the continuation transcript by appending the assistant tool-call `AgentMessage`, then the matching tool-result `AgentMessage`, then any notification hook messages.
- Both `AgentMessage` objects are built using extracted helpers that share the same construction logic as `appendToolCallMessage(...)` and `appendToolDelivery(...)` in `llm-delivery-log.ts`.
- `this.input.contextMessages` already holds `unknown[]`; the appended `AgentMessage` objects are validated by `agentMessageArraySchema` in `InvocationProviderTurnPort` before they reach the gateway.

No active reconstruction schema change is needed. No gateway change is needed. No new actor state field is needed.

Settlement and abandonment need no new cleanup code:

- `abandonParkedTurn(...)` already sets `this.input = null`, which clears the transcript.
- `completeWithProviderResult(...)` for message results already sets `activeReconstruction = null`.
- `completeWithError(...)` already sets `activeReconstruction = null`.
- `onActivationSettled(...)` in `BaseMainLLMCardProcessorActor` abandons parked LLM turns and clears the actor map. A fresh `createMainLlm(...)` call creates a new `LLMActor` per activation, so no transcript leaks across activations.

Persisted segment-backed conversation transcripts, `.saivage/agents/tool-deliveries/*`, and `.saivage/agents/llm-exchanges/*` remain audit, debug, and recovery evidence. They are not read to reconstruct the normal provider request. The in-memory `this.input.contextMessages` is the hot-path source.

## Required Invariants

- The assistant tool-call message and its tool-result message must both be in `this.input.contextMessages` before the next provider call. The Codex gateway drops tool calls whose results are absent.
- A tool-result message must never be appended without a matching waiting tool call.
- A delivered `tool_call_id` must be delivered exactly once.
- A continuation input must include the matching assistant tool call before its tool result.
- Terminal tool calls are not appended as nonterminal tool results. The owning processor consumes the terminal tool call directly and settles the card. The `LLMActor` is then abandoned or cleared.
- If the tool-result `AgentMessage` cannot be constructed, fail loudly before another provider call.
- The appended `AgentMessage` objects must pass `agentMessageSchema` validation.

## Implementation Plan

### Slice 1: Extract Reusable Message Builders From Delivery Log

Status: implemented.

Extract the `AgentMessage` construction logic from `llm-delivery-log.ts` into small role-neutral helpers that return `AgentMessage` objects:

- `toolCallAgentMessage(input, toolCall, index)`: returns the assistant tool-call `AgentMessage` using the same id, round_id, and field patterns currently in `appendToolCallMessage(...)`.
- `toolResultAgentMessage(delivery)`: returns the tool-result `AgentMessage` using the same patterns currently in `appendToolDelivery(...)`.

Refactor `appendToolCallMessage(...)` and `appendToolDelivery(...)` to call these helpers and then persist the returned message. This centralizes message construction and avoids duplication.

Acceptance:

- `appendLlmTurnFinished(...)` and `appendToolDelivery(...)` still persist the same message shapes.
- Delivery-log tests assert the canonical persisted tool-call content.
- The new helpers produce messages accepted by `agentMessageSchema`.

### Slice 2: Append Tool History To LLMActor Context

Status: implemented.

`LLMActor` appends model-visible messages to the continuation input in `appendToolResult(...)`. The waiting tool call keeps the raw argument string returned by the provider, so the assistant tool-call row can be built exactly once the matching tool result is ready. `continuationContextMessages(...)` returns `[...input.contextMessages, assistantToolCallMessage, toolResultMessage, ...notificationMessages]`.

No changes to `abandonParkedTurn(...)`, `completeWithError(...)`, or message-result settlement: they already clear `this.input` or `activeReconstruction`.

Acceptance:

- The second and later provider turns receive paired assistant tool-call and tool-result messages in `contextMessages`.
- `episodeContext.lastToolResult` remains available for runtime policy and tests.
- Active reconstruction snapshots reflect the accumulated tool history.

### Slice 3: Focused Regression Tests

Add a focused actor/provider test that drives a tool loop with a fake provider:

- First provider turn returns a `run_process`-style tool call.
- Processor returns a tool result.
- Assert the second `completeTurn(input)` call receives `input.contextMessages` containing both an assistant `kind: 'tool_call'` message and a `role: 'tool'` `kind: 'tool_result'` message with the matching `tool_call_id`.
- Without the fix, the second turn sees only the initial context/notifications.

Add a Codex gateway serialization test:

- `codexMessages(...)` with paired assistant tool-call + tool-result messages produces `function_call` and `function_call_output` entries.
- This test already passes today; it is regression coverage, not a new behavior test.

Add a Chat gateway serialization test:

- `buildOpenAIChatRequest(...)` with paired messages produces assistant `tool_calls` and tool `tool_call_id` entries.
- This test already passes today; it is regression coverage.

Acceptance:

- The failing actor test demonstrates the exact live bug without a real provider.
- The gateway tests prove the serialized request includes tool history.

### Slice 4: Preserve Recovery And Settlement Behavior

Ensure the new tool history in `this.input.contextMessages` does not reintroduce stale active reconstruction after budget failure or card settlement.

Tests:

- Budget failure abandons the parked LLM turn and persists `active_reconstruction: null`.
- No stale `waiting_tool` snapshots remain after settlement.
- Startup recovery does not treat completed/abandoned transcript context as active work.
- `abandonParkedTurn(...)` clears `this.input` (including the transcript).

Acceptance:

- Existing actor recovery tests pass unchanged.
- No stale active reconstruction snapshots contain tool history after settlement.

### Slice 5: Live Regression Probe

Add or update a local script/test that runs a minimal executor with a fake command tool and records exactly what reaches `InvocationProviderTurnPort.completeTurn(...)` or the fake provider. The assertion is structural:

- Turn 1 may contain only the initial context.
- Turn 2 must contain the prior assistant tool-call message and its tool-result message.
- Turn 2 must not collapse back to only the initial context.

Acceptance:

- The live/raw exchange panel confirms the model receives tool history on continuation turns.

### Slice 6: Reassess Executor Turn Budget Policy

Only after context propagation is fixed, rerun the GetRich v2 E2E. If the executor still loops while seeing prior tool outputs, then treat it as an executor policy issue.

Potential follow-up changes:

- Add no-progress detection for repeated read-only process commands.
- Inject a final-turn instruction before budget failure.
- Restrict final-turn tools to `emit_result`.
- Split broad executable cards into smaller scaffold tasks.

Acceptance:

- Any turn-budget adjustment is based on a model that is receiving correct context.

## Validation Plan

Focused local validation:

```bash
npx tsc --noEmit
NODE_OPTIONS=--experimental-vm-modules npx jest tests/runtime/actors/llm-actor.test.ts tests/runtime/actors/terminal-card-processor-actor.test.ts --runInBand --forceExit
NODE_OPTIONS=--experimental-vm-modules npx jest tests/agents/llm-client-integration.test.ts --runInBand --forceExit
```

Broader runtime validation:

```bash
NODE_OPTIONS=--experimental-vm-modules npx jest tests/runtime/actors --runInBand --forceExit
npm run build
```

Live GetRich v2 validation:

1. Build Saivage v3.
2. Restart `saivage-v3-getrich.service`.
3. Reset GetRich v2 preserving only `docs/SPEC.md`, `docs/PLAN.md`, `.saivage/saivage.yaml`, and `.saivage/auth-profiles.json`.
4. Run the full project-start E2E.
5. Inspect Debug -> Agents -> `executor:card-4` -> Raw LLM Exchange.
6. Confirm continuation requests include tool output from previous turns.

## Observability

The Debug -> Agents tab is the primary operator view for this issue.

It allows inspection of:

- normalized messages;
- tool deliveries;
- raw provider exchanges.

Expected post-fix observation:

- `executor:card-4` raw exchange attempt 0 contains the initial instruction;
- attempt 1 contains the previous `run_process` function call and its output;
- later attempts include accumulated model-visible context rather than stateless `Proceed` inputs only.

If context compaction is later added, the compacted summary must explicitly include enough recent tool history to prevent repeated no-op inspections.

## Risks

- Appending full process outputs to `this.input.contextMessages` increases both token use for provider calls and snapshot I/O for active reconstruction persistence. Process output is already bounded by `PROCESS_OUTPUT_TAIL_BYTES`; the accumulated transcript may still grow across many tool turns. Mitigation: keep bounded process output and add transcript compaction when needed.
- Incorrect message ordering can break provider tool protocols. The Codex gateway's `callIdsWithOutput` filter drops unpaired tool calls. Mitigation: the appended assistant tool-call message and tool-result message are always added in order, and both are present before the next provider call.
- Diverging the extracted message builders from the original persistence logic could cause the in-memory transcript and persisted messages to disagree. Mitigation: reuse the same extracted helpers for both persistence and in-memory context.

## Done Criteria

- Provider continuation requests contain model-visible tool calls and tool results.
- Focused actor tests prove `this.input.contextMessages` on continuation turns includes paired tool-call/tool-result messages.
- Gateway regression tests prove the serialized request includes tool history.
- The GetRich v2 executor no longer repeats first-turn inspection solely because it lacks prior tool output.
- Debug -> Agents shows raw exchanges that match the expected continuation contract.
- Runtime actor recovery/settlement remains clean after failed or budgeted activations.
- No new actor state field, no schema change, no gateway change, no compatibility shim.
