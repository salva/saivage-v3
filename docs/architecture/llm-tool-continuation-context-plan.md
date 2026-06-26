# LLM Tool Continuation Context Design And Plan

Status: proposed.

## Problem

The micro-actor executor can enter a repeated tool-use loop because tool results are persisted for operator inspection but are not reliably included in the next provider request as model-visible context.

The live GetRich v2 run exposed the issue on `executor:card-4`:

- the executor received the correct card instructions;
- the executor was offered the correct process and terminal tools;
- tool calls and tool results were written to `.saivage/agents/messages/`, `.saivage/agents/tool-deliveries/`, and `.saivage/agents/llm-exchanges/`;
- every recorded Codex request still contained only one user input: `Proceed with the task described in the instructions.`;
- prior `run_process` outputs were not present in the next provider request;
- the model repeatedly made first-turn inspection calls because each continuation looked like a fresh request.

This is a context propagation bug, not primarily an executor-quality or turn-budget problem. The turn budget correctly stopped an otherwise unbounded no-progress loop, but the model was effectively operating with amnesia.

## Current Data Flow

Current actor path:

1. `TerminalCardProcessorActor` builds an initial `LlmInvocationInput` with card instructions, tools, terminal tool names, and notification-derived context messages.
2. `LLMActor.turn(...)` calls the provider port.
3. The provider returns a tool call.
4. The owning processor executes the tool.
5. `LLMActor.appendToolResult(...)` records tool delivery and updates `episodeContext.lastToolResult`.
6. `LLMActor.appendToolResult(...)` builds the next input by carrying forward `input.contextMessages` plus notification messages.
7. `InvocationProviderTurnPort` passes only `input.contextMessages` to the invocation service.
8. The provider gateway serializes those `AgentMessage[]` into provider-specific request messages.

The missing step is the creation of model-visible `AgentMessage` entries for the assistant tool call and the matching tool result before the continuation provider call.

`episodeContext.lastToolResult` is useful for runtime policy and tests, but it is not provider-visible. It cannot substitute for model-visible conversation state.

## Design Goals

- Every provider continuation after a nonterminal tool call must include the assistant tool call and corresponding tool result in provider-compatible form.
- The same model-visible transcript should drive planner, executor, and reviewer LLM continuations.
- `LLMActor` remains generic and role-free.
- Card notification delivery remains owned by `CardActor`/processor mechanics; it should be additive context, not a replacement for tool history.
- Persisted logs remain the source for operator inspection and recovery diagnostics.
- No compatibility shims for obsolete transcript shapes.
- Tests prove the exact provider request includes function-call output before diagnosing agent quality or adjusting turn budgets.

## Non-Goals

- Do not remove all turn budgets. Budgets remain a safety circuit breaker until replaced by a stronger runtime-level cost/time/no-progress guard.
- Do not make `LLMActor` understand planner, executor, or reviewer terminal semantics.
- Do not resume arbitrary mid-flight provider calls after restart.
- Do not expose raw provider diagnostics to the model merely because they exist.
- Do not infer model-visible context from UI-only projections.

## Proposed Model-Visible Continuation Contract

For each nonterminal tool call that is delivered back to the model, the next provider request must contain, in order:

1. The prior user/developer/notification messages already in context.
2. The assistant tool-call message that the provider produced.
3. The tool-result message with the exact `tool_call_id` and structured result payload.
4. Any newly delivered card notifications for the continuation input.

For Codex Responses, this serializes to:

- `function_call` with `call_id`, `name`, and `arguments`;
- `function_call_output` with the same `call_id` and the serialized output.

For OpenAI Chat Completions, this serializes to:

- assistant message with `tool_calls`;
- tool message with matching `tool_call_id`.

Provider-specific gateways already have serialization concepts for these entries. The runtime must ensure the correct `AgentMessage[]` is supplied to them.

## Architecture Decision

`LLMActor` owns the active model-visible transcript in memory for the lifetime of a live invocation.

This is the hot-path source for provider continuation calls. Persisted `.saivage/agents/messages/*`, `.saivage/agents/tool-deliveries/*`, and `.saivage/agents/llm-exchanges/*` remain audit, debug, and recovery evidence. They are not used to reconstruct the normal provider request on every turn.

The concrete shape is:

- `LLMActor` owns the in-memory model-visible turn transcript for its active invocation.
- The transcript is initialized from the first `LlmInvocationInput.contextMessages`.
- When a provider returns a tool call, `LLMActor` appends the assistant tool-call `AgentMessage` to that transcript using the same canonical shape persisted by `appendLlmTurnFinished(...)`.
- When `appendToolResult(...)` is called, `LLMActor` appends the matching tool-result `AgentMessage` to that transcript before starting the continuation turn.
- Notification context from the owning card is appended after the tool result for the continuation input.
- `LlmInvocationInput.contextMessages` for continuation turns is derived from the actor-owned transcript, not from persisted file reconstruction.
- The transcript is included in active reconstruction while the invocation is active so diagnostics can inspect what was in flight.
- The transcript is cleared on message-result settlement, error settlement, terminal tool handoff, card settlement, and parked-turn abandonment.

Persisted-file reconstruction is explicitly not the primary design:

- It adds file I/O to the hot path.
- It makes live provider context depend on log reconstruction correctness.
- It complicates eventual compaction and recovery policy.
- It blurs the boundary between audit persistence and active actor state.

Tests may compare persisted messages and actor-owned transcript entries for consistency, but production continuation turns should use the `LLMActor` transcript directly.

## Required Invariants

- A tool result must never be appended without a matching waiting tool call.
- A delivered `tool_call_id` must be delivered exactly once.
- A continuation input must include the matching assistant tool call before its tool result.
- Terminal tool calls are not appended as nonterminal tool results; the owning processor consumes them and settles the card.
- If continuation context cannot be constructed, fail loudly before another provider call.
- If the provider gateway cannot serialize the transcript, fail before sending a malformed request.

## Implementation Plan

### Slice 1: Reproduce The Context Bug In Focused Tests

Add a focused actor/provider test that drives an executor tool loop with a fake provider and asserts the second provider invocation receives model-visible tool history.

Test should fail before implementation:

- first provider turn returns `run_process`;
- processor returns a tool result;
- second provider turn must see an assistant tool-call message and a tool-result message in `contextMessages`;
- without the fix, second provider turn sees only the initial context/notifications.

Also add gateway-level tests:

- `buildOpenAICodexRequest(...)` serializes paired assistant tool call + tool output as `function_call` and `function_call_output`;
- `buildOpenAIChatRequest(...)` or equivalent serializes paired assistant tool call + tool output as assistant/tool messages.

Acceptance:

- The failing test demonstrates the exact live bug without using a real provider.

### Slice 2: Add Canonical Tool Transcript Builders

Add small role-neutral helpers to construct `AgentMessage` records for:

- an assistant tool call from `LLMActorOutcome` or provider `ToolCall`;
- a tool result from `tool_call_id`, tool name, and result payload.

Reuse existing persisted-message schema and session stamping logic where possible. Do not duplicate incompatible message shapes.

Acceptance:

- Builders produce messages accepted by `agentMessageSchema`.
- Message ids, round ids, and block indexes remain deterministic enough for tests and operator inspection.

### Slice 3: Make `LLMActor` Carry Model-Visible Tool History

Update `LLMActor` so active invocation context includes accumulated model-visible messages in an actor-owned transcript.

Add state similar to:

- `modelContextMessages: AgentMessage[]`

Initialization:

- on `turn(input)`, parse and store `input.contextMessages` as `modelContextMessages`;
- store the same transcript in active reconstruction.

When provider returns a nonterminal tool call:

- persist the existing message log as today;
- append the assistant tool-call message to the active model-visible context;
- persist active reconstruction with the updated transcript;
- move to `waiting_tool`.

When `appendToolResult(...)` is called:

- append the tool-result message to the active model-visible context;
- append notification messages for the continuation input after the tool result;
- set the next `LlmInvocationInput.contextMessages` to the full actor-owned transcript;
- update active reconstruction with the new transcript and continuation input;
- continue the provider turn.

Settlement and abandonment:

- clear `modelContextMessages` when the actor settles with a message result or error;
- clear `modelContextMessages` when a processor consumes a terminal tool call and the card activation settles;
- clear `modelContextMessages` in `abandonParkedTurn(...)`.

Acceptance:

- `episodeContext.lastToolResult` may remain for runtime policy, but provider-visible context no longer depends on it.
- The second and later provider turns receive paired tool call/output messages.
- Persisted files are not read to build normal continuation requests.

### Slice 4: Preserve Recovery And Settlement Behavior

Ensure the new transcript state does not reintroduce stale active reconstruction after budget failure or card settlement.

Tests:

- budget failure abandons parked LLM turn and persists `active_reconstruction: null`;
- no stale `waiting_tool` snapshots remain after settlement;
- startup recovery does not treat completed/abandoned transcript context as active work.

Acceptance:

- Existing actor recovery tests continue to pass.

### Slice 5: Add Live Regression Probe

Add or update a local script/test that runs a minimal executor with a real or fake command tool and records the raw request body. The assertion is structural, not provider-dependent:

- request 1 may contain only the task instruction;
- request 2 must contain the prior function call and function output;
- request 2 must not collapse back to only `Proceed with the task described in the instructions.`.

Acceptance:

- The live/raw exchange panel can confirm the model receives tool history.

### Slice 6: Reassess Executor Turn Budget Policy

Only after context propagation is fixed, rerun the GetRich v2 E2E. If the executor still loops while seeing prior tool outputs, then treat it as an executor policy issue.

Potential follow-up changes:

- add no-progress detection for repeated read-only process commands;
- inject a final-turn instruction before budget failure;
- restrict final-turn tools to `emit_executor_result`;
- split broad executable cards into smaller scaffold tasks.

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
3. Reset GetRich v2 preserving only `docs/SPEC.md`, `docs/PLAN.md`, `.saivage/saivage.json`, and `.saivage/auth-profiles.json`.
4. Run the full project-start E2E.
5. Inspect Debug -> Agents -> `executor:card-4` -> Raw LLM Exchange.
6. Confirm continuation requests include tool output from previous turns.

## Observability

The Debug -> Agents tab should be the primary operator view for this issue.

It must allow inspection of:

- normalized messages;
- tool deliveries;
- raw provider exchanges.

Expected post-fix observation:

- `executor:card-4` raw exchange attempt 0 contains the initial instruction;
- attempt 1 contains the previous `run_process` function call and its output;
- later attempts include the accumulated or compacted model-visible context rather than stateless `Proceed` inputs only.

If context compaction is later added, the compacted summary must explicitly include enough recent tool history to prevent repeated no-op inspections.

## Risks

- Sending full process outputs repeatedly can increase token use. Mitigation: keep bounded process output and later add transcript compaction when needed.
- Incorrect message ordering can break provider tool protocols. Mitigation: gateway-level serialization tests.
- Duplicating persistence and in-memory transcript builders can diverge. Mitigation: centralize message construction.
- Fixing context propagation may reveal real executor quality issues. Mitigation: handle no-progress policy after the context fix, not before.

## Done Criteria

- Provider continuation requests contain model-visible tool calls and tool results.
- Focused actor and gateway tests prove the behavior.
- The GetRich v2 executor no longer repeats first-turn inspection solely because it lacks prior tool output.
- Debug -> Agents shows raw exchanges that match the expected continuation contract.
- Runtime actor recovery/settlement remains clean after failed or budgeted activations.
