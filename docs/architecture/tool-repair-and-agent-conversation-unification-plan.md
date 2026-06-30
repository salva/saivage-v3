# Tool Repair And Agent Conversation Unification Plan

Date: 2026-06-30

## Context

The Phase 1 terminal contract repair work fixed the immediate failure where a planner, executor, or reviewer returned plain text instead of its required terminal tool. The `pueblicos` reset verified that path: `executor:card-4` returned plain text, Saivage appended a `model_repair` message, and the model continued instead of immediately failing with `Plain executor messages are not accepted as terminal results`.

The same run exposed the next issue: after the repair directive, the executor called a non-terminal workspace tool incorrectly:

```json
{"tool":"write","arguments":{}}
```

The workspace `write` tool requires `path` and `content`, so the card failed with a validation error. That is not the old terminal-contract bug. It is a missing bounded repair path for malformed non-terminal tool calls.

The same investigation exposed an observability mismatch: the Debug/Agents UI does not consistently show system prompts for planner/executor/reviewer conversations, while it does for the analyst. The analyst uses the older `AgentSessionRepository` and `.saivage/agents/messages/*.jsonl` path. Micro-actors now use segment-backed conversations under `.saivage/agents/conversations/<sessionId>/seg-001.jsonl`. Several read paths still only understand the old message file layout.

## Issues To Fix

1. Malformed non-terminal tool calls end the card too early.

Processor loops currently execute a non-terminal tool and append the tool result back to the model. If the tool handler returns `{ success: false, error: ... }`, the loop generally continues. However, a malformed non-terminal call can still become a terminal card failure through processor-specific behavior or downstream activation failure. The observed `pueblicos` case failed the executor after the repaired model called `write` with missing fields. The intended behavior is a bounded repair turn: tell the model exactly which non-terminal tool call was invalid and ask it to retry with valid arguments or call the proper terminal tool.

2. Repair budgets are too coarse.

The current repair budget is focused on terminal contract violations and missing required record files. It does not clearly distinguish plain-text repair, invalid terminal envelope repair, missing-record repair, and invalid non-terminal tool repair. Without a single activation-scoped budget and explicit categories, future fixes can either loop too much or fail too early.

3. Tool execution results are not classified.

Processor code receives generic `unknown` results from non-terminal tools. It needs a consistent way to recognize a tool validation failure versus a normal failed operation. Validation failures should be repairable when a live model session exists. Real execution failures can still be delivered to the model, but the repair directive should be different from ordinary tool output.

4. Startup recovery cannot repair malformed non-terminal tool calls.

This is acceptable, but it must be explicit. Startup recovery has no live model continuation and should continue to fail fast or block interrupted non-terminal waiting-tool states. Only live activations can perform bounded repair turns.

5. Backend agent read models ignore segment-backed micro-actor conversations.

`AgentOperatorReadModelService` uses `AgentSessionRepository.getMessages(sessionId)`, and `AgentSessionRepository` reads `.saivage/agents/messages/*.jsonl`. That works for the analyst, but it does not read `.saivage/agents/conversations/<sessionId>/seg-001.jsonl`. As a result, `/api/agents/:id/conversation` can miss planner, executor, and reviewer messages, including their system prompts.

6. Backend agent session listing ignores segment-only sessions.

`AgentSessionRepository.listKnownSessionIds()` combines session manifests and old message files. Micro-actor segment conversations may have no old message file and may not have a classic session manifest. Those sessions can be absent or incomplete in `/api/agents`.

7. Debug Agents UI scans the obsolete messages directory.

`web/src/views/DebugView.vue` lists `.saivage/agents/messages`, `.saivage/agents/tool-deliveries`, and `.saivage/agents/llm-exchanges`. It does not scan `.saivage/agents/conversations`. Micro-actor message files therefore do not appear in the debug file browser.

8. Conversation timeline rendering hides `system_prompt` entries.

`web/src/utils/agent-timeline/timeline.ts` includes only `text` and `activity` entries in `round.texts`. Even if the backend returns a `system_prompt`, `RoundCard.vue` will not display it. Analyst prompts can appear through debug raw file views, but the normalized conversation timeline should have an explicit system prompt row for all roles.

9. Analyst is not using the micro-actor LLM infrastructure.

`AnalystHandler` directly uses `InvocationService`, `AgentSessionRepository`, `ContextCompactor`, and `ToolDispatcher`. Planner, executor, and reviewer use `LLMActor` and segment-backed delivery logs. This split causes different persistence, prompt visibility, tool-call repair, activity tracking, and recovery semantics. The analyst is conversational and operator-facing, so it has different control flow, but it should still use the same LLM turn engine and transcript substrate.

10. There are two transcript authorities.

The current system has old `.saivage/agents/messages/*.jsonl` for analyst-style sessions and new `.saivage/agents/conversations/<sessionId>/seg-001.jsonl` for micro-actors. Keeping both as separate authorities creates UI drift, read-model drift, and inconsistent debugging behavior.

## Desired Architecture

All LLM-backed agents should share one conversation transcript substrate:

```text
.saivage/agents/conversations/<encodeURIComponent(sessionId)>/
  index.json
  seg-001.jsonl
```

All operator surfaces should read conversations through one backend read model, not by knowing physical paths in the frontend.

The `LLMActor` should remain the owner of provider turns, transcript append semantics, active reconstruction metadata, tool-delivery logging, and bounded continuation after repair directives.

Planner, executor, reviewer, and analyst can keep role-specific loop logic, but they should all call the same LLM turn primitive. The analyst may remain a long-lived global session, but it should not maintain a separate transcript and invocation implementation.

## Implementation Design

### A. Add live non-terminal tool-call repair

1. Introduce a small helper in the card processor layer, for example `class LiveToolRepairBudget` or a function-local counter object.

The helper should track one activation-scoped budget, initially `2`, shared across:

```text
plain_text_terminal_repair
invalid_terminal_arguments_repair
missing_required_record_repair
invalid_non_terminal_tool_repair
```

2. Add a typed classifier for tool results returned by processor tool handlers.

Use a minimal shape rather than a large framework:

```ts
type ToolExecutionResult = {
  success?: boolean;
  error?: string;
  errorEnvelope?: { kind?: string; message?: string };
};
```

Add a helper:

```ts
function toolResultErrorMessage(result: unknown): string | null
```

This returns a message when the result is an object with `success === false` and a string error/message.

3. In `TerminalCardProcessorActor.runActivation`, after `handleToolCall(outcome)`, inspect the tool result before blindly appending it.

Current shape:

```ts
const toolResult = await this.handleToolCall(outcome);
outcome = await llm.appendToolResult(outcome.toolCallId, toolResult, ...);
```

New shape:

```ts
const toolResult = await this.handleToolCall(outcome);
const repairableError = toolResultErrorMessage(toolResult);
if (repairableError && repairAttempts < MAX_TERMINAL_CONTRACT_REPAIRS) {
  repairAttempts++;
  outcome = await llm.appendToolResult(outcome.toolCallId, toolResult, () => [{
    role: 'user',
    content: `Tool ${outcome.toolName} failed validation: ${repairableError}. Retry with valid arguments, use another available tool, or call emit_executor_result if you can complete or fail the card. Do not repeat the same invalid arguments.`,
  }]);
  continue;
}
outcome = await llm.appendToolResult(outcome.toolCallId, toolResult, ...);
```

4. Apply the same pattern to `PlanningCardProcessorActor.handleToolCall` for planner non-terminal tools.

The planner repair directive should be role-specific:

```text
Tool <name> failed validation: <error>. Retry with valid arguments, choose another available planner tool, activate a valid child, or call emit_planner_result with a valid blocked/done/continue result. Do not repeat the same invalid arguments.
```

5. Apply the same pattern to reviewer tool calls if/when reviewers have non-terminal tools. If reviewers only use terminal and record tools today, add tests proving malformed reviewer terminal calls still use the existing terminal repair path.

6. Detect exact repeated invalid tool calls.

Within an activation, keep a set of fingerprints:

```text
<toolName>:<stable-json-args>
```

If a model repeats the same invalid non-terminal call after one repair, fail with a concise message rather than consuming all retries on identical output.

7. Keep startup recovery strict.

Do not add recovery-time non-terminal repair. If an LLM snapshot is waiting on a non-terminal tool call after restart, the existing recovery should block/fail because there is no live model turn to continue safely.

### B. Unify conversation reads around segment-backed transcripts

1. Promote `readConversationMessages(projectRoot, sessionId)` from `llm-delivery-log.ts` into a neutral module or re-export it from a neutral API.

Candidate path:

```text
src/runtime/actors/conversation-store.ts
```

Keep implementation small. It should expose:

```ts
conversationDir(projectRoot, sessionId)
conversationIndexPath(projectRoot, sessionId)
readConversationMessages(projectRoot, sessionId)
listConversationSessionIds(projectRoot)
appendConversationMessage(projectRoot, message)
```

2. Update `LLMActor` and `llm-delivery-log.ts` to use this neutral module.

Do not reintroduce `.saivage/agents/messages` readers for micro-actors.

3. Update `AgentSessionRepository` or replace it in read-models with a conversation-aware repository.

Minimal Phase 1 option:

```ts
listKnownSessionIds() = union(classic sessions, classic messages, segment conversation dirs)
getMessages(sessionId) = segment messages if present else classic messages
```

This is a temporary bridge for operator read models. The long-term endpoint should use only the segment store after the analyst migrates.

4. Synthesize session summaries for segment-only micro-agent sessions.

If no `AgentSession` manifest exists, derive:

```text
id: sessionId
role: parseRole(sessionId)
status: active/waiting/inactive from runtime actor snapshots if available, otherwise inactive
started_at: first conversation message timestamp or Unix epoch
model: null unless available from LLM exchange metadata
card_id: parsed card id for planner/executor/reviewer session ids
```

5. Update `/api/agents/:id/conversation` to return segment messages for planner/executor/reviewer sessions.

The response should include `system_prompt` entries by default. Operator APIs are debugging surfaces and must not silently hide prompts.

6. Update `read_agent_session` and `list_agent_sessions` analyst tools to use the same conversation-aware repository.

Analyst should be able to inspect micro-agent sessions exactly as the UI can.

### C. Fix Debug and Agents UI prompt visibility

1. Update `DebugView.vue` to stop scanning `.saivage/agents/messages` as the primary conversation source.

Preferred design: use `/api/agents` and `/api/agents/:id/conversation` instead of raw file discovery for the Messages tab. Keep Raw LLM Exchange and Tool Deliveries as raw file views if useful.

2. If raw file browsing remains in Debug, add support for segment directories.

The UI must list `.saivage/agents/conversations`, treat directories as sessions, and read the selected session's active segment from `index.json`. Since the current file listing helper only accepts files, the API/UI may need a small helper endpoint or frontend logic that recursively lists one level.

3. Update `entriesToTimeline` so `system_prompt` is visible.

Add `system_prompt` to displayed text-like entries or add a separate `systemPrompts` collection in the timeline model.

Minimal change:

```ts
texts: sorted.filter((entry) => entry.kind === 'text' || entry.kind === 'activity' || entry.kind === 'system_prompt')
```

4. Update `ContextBlock.vue` or add `SystemPromptBlock.vue` so prompts are visually distinct and collapsed by default.

System prompts can be long. The UI should show a compact header such as `System prompt` with expand/collapse, not dump thousands of tokens inline by default.

5. Add UI tests for prompt visibility.

Test that a conversation containing `system_prompt`, `text`, `tool_call`, and `tool_result` renders the system prompt row for planner/executor/reviewer just as it does for analyst.

### D. Move Analyst to the shared LLM turn infrastructure

1. Add an analyst-specific `LLMActor` adapter rather than rewriting the whole analyst feature at once.

The adapter should build `LlmInvocationInput` from the existing analyst loop:

```text
agentId: analyst
role: analyst
sessionId: analyst
systemPrompt: getAnalystSystemPrompt() + project context
contextMessages: conversation history plus workspace context
tools: getAnalystToolDefinitions()
terminalToolNames: []
```

2. Make the analyst loop call `LLMActor.turn()` instead of `InvocationService.invokeWithRecovery()` directly.

The analyst can still own multi-tool dispatch, duplicate tool-call prevention, unsupported-surface checks, and final assistant response generation. The provider invocation and transcript append should move to `LLMActor`.

3. Persist analyst messages into segment conversations.

`appendMessage` and `appendSystemPromptMessageIfMissing` should no longer write analyst messages to `.saivage/agents/messages`. They should write to the same conversation store. During the bridge phase, `AgentSessionRepository.getMessages()` can read old messages for already-existing sessions, but new writes should go to segments.

4. Replace analyst-specific tool-call append logic with the shared transcript helpers.

When the analyst receives tool calls from the model, transcript rows should be produced through the same schema and round semantics as micro-actors. Tool results should be appended through the same helper used by `LLMActor.appendToolResult()` or a shared lower-level `appendToolResultMessage()`.

5. Preserve analyst-specific behavior.

The migration must preserve:

```text
workspace context injection
surface-specific tool allowlist
context compaction
duplicate response suppression
duplicate tool-call prevention
control-action auditing
live activity status
web-chat request/response contract
```

6. Remove or narrow the old message substrate after analyst migration.

Once analyst writes to segments and read models use segments, remove `.saivage/agents/messages` from `initProjectTree()` and from frontend/debug assumptions. Because workspace rules prefer no backward compatibility, do not keep fallback readers indefinitely. During the implementation PR, use a short bridge only if needed to avoid breaking already-running local sessions; otherwise reset local runtime state and remove old readers.

## Execution Plan

1. Add focused failing tests for non-terminal tool repair.

Test cases:

```text
executor plain text -> model_repair -> malformed write {} -> tool_result with validation error -> model retries valid write -> emit_executor_result -> done
executor malformed write repeated exactly -> fails after bounded repair
planner malformed create_card/activate_card -> repair -> valid retry
startup recovery with waiting non-terminal tool remains blocked/fails, no repair attempted
```

2. Implement the non-terminal tool repair loop in executor and planner processors.

Keep it local and small. Do not introduce a generic framework unless duplicate code becomes hard to read.

3. Add conversation-store read/list functions for segment conversations.

Move or re-export the existing segment helpers from `llm-delivery-log.ts`.

4. Update `AgentSessionRepository`, `AgentOperatorReadModelService`, and analyst tools to read segment conversations.

Add tests for:

```text
listSessions includes executor:card-4 from .saivage/agents/conversations
getConversation('executor:card-4') returns system_prompt and model_repair
read_agent_session can read segment-backed executor messages
```

5. Update Debug UI and main Agents UI prompt rendering.

Start with backend-driven `/api/agents/:id/conversation` in the main Agents page. For Debug, either switch Messages to the same API or add segment-directory file discovery. Prefer backend-driven messages because it avoids leaking persistence layout into the UI.

6. Add web tests for system prompt visibility.

Test `entriesToTimeline()` and the conversation component with a `system_prompt` entry.

7. Migrate analyst invocation onto `LLMActor`.

Do this after segment read models are stable. Keep the analyst response API unchanged. Add tests that verify analyst messages and system prompt are written to `.saivage/agents/conversations/analyst/seg-001.jsonl` and visible through `/api/agents/analyst/conversation`.

8. Remove old transcript assumptions.

After analyst migration, remove `.saivage/agents/messages` from runtime initialization, Debug UI scans, and repository write paths. If tests still need legacy message fixtures, update them to segment fixtures.

## Validation Plan

Run focused tests first:

```bash
npm run test:direct -- tests/runtime/actors/terminal-card-processor-actor.test.ts tests/runtime/actors/planning-card-processor-actor.test.ts tests/runtime/actors/llm-delivery-log.test.ts tests/server/agents-detail-route.test.ts --runInBand
```

Run web/UI focused tests after UI changes:

```bash
npm run web:test:operator-smoke
```

Run broad validation before merging:

```bash
npm run typecheck
npm test -- --runInBand
npm run validate:routine
npm run validate:docs
npm run build
```

Live verification on `pueblicos`:

```text
reset pueblicos
start project through analyst/UI
verify planner/executor sessions appear in Agents and Debug
verify executor system prompt is visible
verify plain-text executor response produces model_repair
verify malformed non-terminal write gets a repair turn rather than immediate card failure
verify successful retry or bounded repeated-failure behavior
```

## Acceptance Criteria

1. A malformed non-terminal tool call during a live planner/executor activation gets a bounded repair turn with a clear tool-specific directive.

2. Repeating the same malformed non-terminal tool call fails deterministically with a concise error.

3. The terminal contract repair behavior remains intact for plain text and invalid terminal envelopes.

4. `/api/agents` lists micro-actor sessions backed only by `.saivage/agents/conversations`.

5. `/api/agents/:id/conversation` returns system prompts for analyst, planner, executor, and reviewer sessions.

6. The main Agents page and Debug Agents view can display system prompts for executor sessions.

7. Analyst uses the shared LLM turn/transcript substrate, or the implementation contains a short documented bridge with tests and a removal task in the same plan.

8. No new long-term fallback to obsolete `.saivage/agents/messages` remains after the analyst migration phase.
