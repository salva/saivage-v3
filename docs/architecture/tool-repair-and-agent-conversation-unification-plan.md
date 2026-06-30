# Tool Repair And Agent Conversation Unification Plan

Date: 2026-06-30

## Context

The Phase 1 terminal contract repair fixed the failure where a planner/executor/reviewer returned plain text instead of its required terminal tool. The `pueblicos` reset verified that: `executor:card-4` returned plain text, Saivage appended a `model_repair` message, and the model continued instead of failing with `Plain executor messages are not accepted as terminal results`.

The same run exposed the next defect: after the repair directive the executor called a non-terminal workspace tool incorrectly:

```json
{"tool":"write","arguments":{}}
```

The `write` tool requires `path` and `content`, so the card failed with a validation error. This is not the old terminal-contract bug. There is no bounded repair path for malformed non-terminal tool calls.

The same investigation exposed an observability defect: the Debug/Agents UI does not show system prompts (or any conversation) for planner/executor/reviewer sessions, while it does for the analyst.

Root cause: Saivage persists agent conversations in two formats, and the UI/read path only understands the old one.

```text
analyst      -> .saivage/agents/messages/analyst.jsonl          (old)
micro-actors -> .saivage/agents/conversations/<id>/seg-001.jsonl (new; invisible to UI)
```

Per the workspace architecture rules there is no backward compatibility, no compatibility shims, no migration code, no adapters/bridges. The fix is to make the segment format the single transcript authority, port the analyst and every UI/read component to it, and delete the old format and every code path that reads it.

## Non-goals and preserved constraints

- Startup recovery has no live model turn and cannot perform repair. It must keep failing fast / blocking interrupted non-terminal waiting-tool states. This is correct existing behavior; this plan preserves it and does not add recovery-time repair.
- The single active non-analyst session invariant stays. It is enforced by the micro-actor runtime supervisor and actor snapshots; it does not require the legacy `AgentSession` manifest.
- Card processor loop shapes (planner vs executor vs reviewer) stay role-specific. Only the LLM turn engine and transcript substrate are unified.

## Issues

1. **Malformed non-terminal tool calls end the card too early.** After the repaired model emits a bad non-terminal call (e.g. `write {}`), the processor can still settle the card as failed on the tool argument validation error. A live activation must give the model one bounded retry directive describing exactly which non-terminal tool call was malformed, then fail deterministically if it repeats.

2. **Repeated identical invalid tool calls can loop.** Without a fingerprint check, the bounded retry budget can be consumed by the model emitting the same bad call.

3. **The UI read path only understands the old transcript format.** `AgentOperatorReadModelService` → `AgentSessionRepository.getMessages()` reads `.saivage/agents/messages/*.jsonl`. Micro-actors write `.saivage/agents/conversations/<id>/seg-001.jsonl`. The UI therefore sees no micro-actor conversations or system prompts.

4. **Session listing only knows classic manifests + classic message files.** `AgentSessionRepository.listKnownSessionIds()` unions `.saivage/agents/sessions/*.json` and `.saivage/agents/messages/*.jsonl`. Micro-actor sessions have neither, so they are absent from `/api/agents`.

5. **The Debug Agents view scans an obsolete directory.** `DebugView.vue` lists `.saivage/agents/messages`, `.saivage/agents/tool-deliveries`, and `.saivage/agents/llm-exchanges`, and never `.saivage/agents/conversations`. The frontend also duplicates on-disk layout knowledge it should not have.

6. **The conversation timeline hides `system_prompt` entries.** `web/src/utils/agent-timeline/timeline.ts` puts only `text` and `activity` into `round.texts`. Even a correctly returned `system_prompt` is not rendered.

7. **The analyst runs on a separate LLM engine and transcript.** `AnalystHandler` uses `InvocationService` + `AgentSessionRepository` + `.saivage/agents/messages`. Planner/executor/reviewer use `LLMActor` + segments. This split is the source of the dual format and of inconsistent prompt visibility, repair, and recovery semantics.

## Desired architecture

One transcript substrate for every LLM-backed agent:

```text
.saivage/agents/conversations/<encodeURIComponent(sessionId)>/seg-001.jsonl
```

One LLM turn engine: `LLMActor`. Planner, executor, reviewer, and analyst all call `LLMActor.turn()` / `LLMActor.appendToolResult()` / `LLMActor.continueAfterPlainText()`. Role-specific loop logic stays in the processors/analyst handler.

Sessions are derived, not manifest-backed. A session exists iff its conversation directory exists. `role`, `card_id`, and `assessment_id` are parsed from the session id; `started_at` is the first conversation message timestamp; live `status` comes from runtime actor snapshots; `model` comes from the latest LLM exchange record. `.saivage/agents/sessions` and `.saivage/agents/messages` stop being created and stop being read.

Every operator/UI surface reads conversations through `/api/agents/:id/conversation` (segment-backed). No frontend component knows segment paths.

## Implementation

### 1. Live non-terminal tool-call repair (executor and planner)

Keep the existing `repairAttempts` integer per activation, shared across the existing repair kinds. Do not add a budget class or named repair categories.

Add one tiny inline helper near the processors. It should recognize argument/schema/protocol failures, not every ordinary tool failure:

```ts
function isMalformedToolCallFailure(result: unknown): result is { success: false; error: string } {
  const error = typeof result === 'object' && result !== null ? (result as { error?: unknown }).error : null;
  const kind = typeof result === 'object' && result !== null ? (result as { errorEnvelope?: { kind?: unknown } }).errorEnvelope?.kind : null;
  return typeof result === 'object' && result !== null
    && (result as { success?: unknown }).success === false
    && typeof error === 'string'
    && (kind === 'validation' || kind === 'protocol' || /required|invalid|schema|arguments/i.test(error));
}
```

Executor loop (`TerminalCardProcessorActor.runActivation`), in the non-terminal branch, before the normal `appendToolResult`:

```ts
const toolResult = await this.handleToolCall(outcome);
if (isMalformedToolCallFailure(toolResult) && toolResult.error.length > 0 && repairAttempts < MAX_TERMINAL_CONTRACT_REPAIRS) {
  if (repeatedInvalidFingerprint.has(fingerprintOf(outcome))) return this.executorFailure(`Repeated invalid tool call '${outcome.toolName}'. ${toolResult.error}`);
  repairAttempts++;
  repeatedInvalidFingerprint.add(fingerprintOf(outcome));
  outcome = await llm.appendToolResult(outcome.toolCallId, toolResult, () => [{
    role: 'user',
    content: `Tool '${outcome.toolName}' failed: ${toolResult.error}. Retry with valid arguments, use another available tool, or call emit_executor_result. Do not repeat the same arguments.`,
  }]);
  continue;
}
outcome = await llm.appendToolResult(outcome.toolCallId, toolResult, (inputId) => this.notificationContextMessages(input, inputId));
```

Ordinary non-terminal tool failures, such as a command exiting non-zero or a file genuinely not existing, should still be appended as normal tool results. The model can react to them through the normal loop without spending the malformed-call repair budget.

`fingerprintOf(outcome) = outcome.toolName + ':' + stableStringify(outcome.args)`. Reset the repeat-set is unnecessary; a repeated identical invalid call fails immediately regardless of remaining budget.

Apply the same structure to `PlanningCardProcessorActor.runActivation` and its planner/reviewer loops, with role-specific directive text. Reviewers that currently only use terminal + record tools keep using the existing terminal repair path; add tests proving malformed reviewer terminal calls still route there.

Startup recovery is unchanged: no live turn, no repair. Interrupted non-terminal waiting-tool states keep blocking/failing.

### 2. Make segments the only conversation store

Promote the segment helpers already in `src/runtime/actors/llm-delivery-log.ts` into one neutral module `src/runtime/actors/conversation-store.ts`:

```ts
conversationDir(projectRoot, sessionId)
conversationIndexPath(projectRoot, sessionId)
readConversationMessages(projectRoot, sessionId)
listConversationSessionIds(projectRoot)   // readdir conversations/, decodeURIComponent
appendConversationMessage(projectRoot, message)
```

`LLMActor` and `llm-delivery-log.ts` import from this module. No other transcript read path remains.

Remove from `src/persistence/file-tree.ts` the directory entries `agents/messages` and `agents/sessions` (both the `SAIVAGE_DIRS` list and the `isNewSaivageState` probe). `initProjectTree()` creates `agents/conversations` only.

### 3. Replace the agent read model with a segment-backed, derived model

Delete the legacy `AgentSessionRepository` readers (`listMessageSessionIds`, `readEncodedSessionMessages`) and the manifest-backed listing. The new read model derives sessions:

```ts
listSessions():
  ids = listConversationSessionIds(projectRoot)
  return ids.map(id => deriveSessionSummary(id, readConversationMessages(projectRoot, id), readActorSnapshots(projectRoot)))

getConversation(sessionId):
  messages = readConversationMessages(projectRoot, sessionId)
  if (messages.length === 0) 404
  return { session: deriveSessionSummary(...), entries: messages, activity_status: ... }
```

`deriveSessionSummary(id, messages, snapshots)`:
- `role` from id prefix (`analyst` / `planner:` / `executor:` / `reviewer:`).
- `card_id` parsed from id; `assessment_id` from reviewer id suffix.
- `started_at` = first message `timestamp`.
- `status` = active/waiting from a matching live LLM actor snapshot; else inactive/done/blocked/failed inferred from the card lifecycle of the referenced card (failed/blocked) or last message.
- `model` from the latest `.saivage/agents/llm-exchanges/<id>.json` if present, else null.

No `AgentSession` manifest is created or read. `/api/agents/:id/conversation` returns `system_prompt` entries by default (operator APIs are debugging surfaces).

The analyst tools `list_agent_sessions` and `read_agent_session` use the same read model. No duplicate implementation.

### 4. Migrate the analyst onto `LLMActor` and segments

Add a small analyst LLM turn builder that builds a `LlmInvocationInput` from the existing analyst loop:

```text
agentId: 'analyst'
role: 'analyst'
sessionId: 'analyst'
systemPrompt: getAnalystSystemPrompt() + projectContext
contextMessages: history + workspace-context system message
tools: getAnalystToolDefinitions()
terminalToolNames: []
```

`AnalystHandler.runAnalystLoop` calls `llmActor.turn(input)` instead of `invocationService.invokeWithRecovery(...)`. Tool-call dispatch, surface allowlist checks, duplicate tool-call prevention, duplicate-response suppression, control-action auditing, activity status, and the final assistant response contract all stay in the analyst handler. Transcript appends move to `LLMActor` (system prompt, assistant text, tool calls, tool results) and land in `agents/conversations/analyst/seg-001.jsonl`.

Remove from `src/runtime/session-persistence.ts` everything that reads or writes `agents/messages` or `agents/sessions`:
- `appendMessage`, `appendSystemPromptMessageIfMissing`, `getSessionMessages`, `replaceSessionMessages`, `messagesPath`, `messagesDir`, `MESSAGES_DIR`.
- `createSession`, `getSession`, `listSessions`, `sessionPath`, `sessionsDir`, `SESSIONS_DIR`, and the manifest-based `completeSession`/`setSessionStatus`/`markSessionWaiting`/`updateSessionModel`.
- `reconcileOrphanedAgentSessions`/`assertNoActiveAgentSession`/`ConcurrentAgentSessionError` if the single-active-session invariant is already enforced by the supervisor/card-actor structure — verify, then remove; if still needed, move it onto actor snapshots, not manifests.

Analyst compaction (`ContextCompactor`) reads/writes through `conversation-store` instead of `session-persistence`. Existing compact/summary semantics are preserved; only the storage target changes.

Because there is no bridge, a running `analyst` session with old `.saivage/agents/messages/analyst.jsonl` history is simply reset: the user resets the project (already the supported workflow) or the old file is ignored (and removed by `initProjectTree` no longer creating the dir). No reader ever falls back to it.

### 5. Port the UI off raw file discovery

`AgentsView.vue` already uses `/api/agents/:id/conversation`; once the backend is segment-backed it gets micro-actor conversations for free. No frontend change there beyond testing.

`DebugView.vue` "Persisted Agent Conversations": stop scanning `.saivage/agents/messages`, `.saivage/agents/sessions`. Drive the message view from `/api/agents` + `/api/agents/:id/conversation` (the same API the main Agents page uses). Keep Tool Deliveries and Raw LLM Exchange as raw file views if useful, since those are separate operational ledgers; if kept, list `.saivage/agents/tool-deliveries` and `.saivage/agents/llm-exchanges` only — never `messages` or `sessions`.

### 6. Render system prompts in the timeline

In `web/src/utils/agent-timeline/timeline.ts`, include `system_prompt` in the rendered text set:

```ts
texts: sorted.filter((entry) => entry.kind === 'text' || entry.kind === 'activity' || entry.kind === 'system_prompt')
```

Add a compact `SystemPromptBlock.vue` (or extend `ContextBlock.vue`) that renders a collapsed `System prompt` header by default, expanding to the full text on click. System prompts are long; they must not dump thousands of tokens inline.

### 7. Cleanup

- Remove `agents/messages` and `agents/sessions` from `file-tree.ts` and any tests that assert their creation.
- Remove `agent-message-visibility.ts`'s special-casing of `system_prompt` for the model-input filter only if needed; keep `model_issue` filtering. The UI visibility is handled by the timeline change above, not by the model-input filter.
- Delete `AgentSessionRepository` once sections 3 and 4 are done.
- Update tests that write fixtures to `agents/messages/*` (e.g. `tests/application/read-models.test.ts`) to write to `agents/conversations/<id>/seg-001.jsonl`.

## Execution order

1. Failing tests for non-terminal repair (executor `write {}` → repair → valid retry → done; repeated identical invalid → immediate fail; planner malformed `create_card` → repair; startup stays blocked).
2. Implement repair in executor and planner processors (inline helper + fingerprint + shared counter).
3. Add `conversation-store.ts`; route `LLMActor`/`llm-delivery-log` through it.
4. Replace `AgentOperatorReadModelService` with the segment-backed derived model; update `/api/agents` and analyst tools; remove `AgentSessionRepository` legacy readers.
5. Port `DebugView.vue` Messages to `/api/agents/:id/conversation`.
6. Timeline + `SystemPromptBlock` for prompt visibility; web tests.
7. Migrate `AnalystHandler` onto `LLMActor`; remove `session-persistence` message/manifest functions; compaction through `conversation-store`.
8. Remove `agents/messages` and `agents/sessions` from `file-tree.ts`; update fixtures.

## Validation

Focused:

```bash
npm run test:direct -- tests/runtime/actors/terminal-card-processor-actor.test.ts tests/runtime/actors/planning-card-processor-actor.test.ts tests/runtime/actors/llm-delivery-log.test.ts tests/server/agents-detail-route.test.ts --runInBand
npm run web:test:operator-smoke
```

Broad:

```bash
npm run typecheck
npm test -- --runInBand
npm run validate:routine
npm run validate:docs
npm run build
git diff --check
```

Live (`pueblicos`):

```text
reset project; start through analyst/UI
planner/executor sessions appear in /api/agents and Debug
executor system_prompt visible in timeline
plain-text executor response -> model_repair
malformed non-terminal write -> repair turn -> retry or bounded fail
no .saivage/agents/messages or .saivage/agents/sessions created
```

## Acceptance criteria

1. A malformed non-terminal tool call during a live activation gets one bounded repair directive; repeating the identical invalid call fails immediately.
2. Terminal-contract repair (plain text, invalid terminal envelope, missing record) remains intact, sharing one per-activation counter.
3. Startup recovery still fails/blocks interrupted non-terminal waiting-tool states; no recovery-time repair is added.
4. `/api/agents` lists micro-actor sessions derived from `.saivage/agents/conversations`.
5. `/api/agents/:id/conversation` returns `system_prompt` for every role.
6. The Agents page and Debug view show system prompts for planner/executor/reviewer.
7. The analyst uses `LLMActor` and writes `agents/conversations/analyst/seg-001.jsonl`.
8. No code reads or writes `.saivage/agents/messages` or `.saivage/agents/sessions`; `initProjectTree` does not create them; no fallback/bridge remains.
