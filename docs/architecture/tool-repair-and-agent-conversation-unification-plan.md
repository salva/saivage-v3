# Tool Repair And Agent Conversation Unification Plan

Date: 2026-06-30

## Context

The Phase 1 terminal contract repair fixed the failure where a planner/executor/reviewer returned plain text instead of its required terminal tool. The `pueblicos` reset verified that: `executor:card-4` returned plain text, Saivage appended a `model_repair` message, and the model continued instead of failing with `Plain executor messages are not accepted as terminal results`.

The same run exposed the next defect: after the repair directive the executor called a non-terminal workspace tool incorrectly:

```json
{"tool":"write","arguments":{}}
```

The `write` tool requires `path` and `content`, so the card failed with a Zod validation error. This bug has been root-caused (see issue 1) and the fix is a one-word-per-line change, not a new repair category.

The same investigation exposed an observability defect: the Debug/Agents UI does not show system prompts (or any conversation) for planner/executor/reviewer sessions, while it does for the analyst.

Root cause: Saivage persists agent conversations in two formats, and the UI/read path only understands the old one.

```text
analyst      -> .saivage/agents/messages/analyst.jsonl          (old)
micro-actors -> .saivage/agents/conversations/<id>/seg-001.jsonl (new; invisible to UI)
```

Per the workspace architecture rules there is no backward compatibility, no compatibility shims, no migration code, no adapters/bridges. The fix is to make the segment format the single transcript authority, port the analyst and every UI/read component to it, and delete the old format and every code path that reads it.

## Non-goals and preserved constraints

- Startup recovery has no live model turn and cannot perform repair. It must keep failing fast / blocking interrupted non-terminal waiting-tool states. This is correct existing behavior; this plan preserves it and does not add recovery-time repair.
- Compaction for LLMActor conversations is deferred to Phase 2. The micro-actors already run without compaction (context grows in memory until the activation ends). The analyst will join this behavior. Long analyst conversations may hit the provider context limit; the operator can start a new session. This is a known Phase 1 limitation.
- Card processor loop shapes (planner vs executor vs reviewer) stay role-specific. Only the LLM turn engine and transcript substrate are unified.

## Issues

1. **Executor `handleToolCall` drops promise rejections.** `src/runtime/actors/terminal-card-processor-actor.ts:112` returns async calls without `await`:

   ```ts
   if (WORKSPACE_TOOL_NAMES.has(outcome.toolName)) return processWorkspaceToolCall(...);
   ```

   When `processWorkspaceToolCall` rejects (e.g. Zod validation on `write {}`), the rejection bypasses the surrounding `try/catch` because the promise is returned, not awaited. The rejection propagates to `runActivation`, which fails the card through `activationFailureOutcome`. The planner (`src/runtime/actors/planning-card-processor-actor.ts:155`) and reviewer (`src/runtime/actors/planning-card-processor-actor.ts:391`) versions of the same method already use `return await ...` and are not affected.

   This bug is verified: `return processWorkspaceToolCall(...)` rejects past the catch; `return await processWorkspaceToolCall(...)` is caught correctly.

2. **The UI read path only understands the old transcript format.** `AgentOperatorReadModelService` → `AgentSessionRepository.getMessages()` reads `.saivage/agents/messages/*.jsonl`. Micro-actors write `.saivage/agents/conversations/<id>/seg-001.jsonl`. The UI therefore sees no micro-actor conversations or system prompts.

3. **Session listing only knows classic manifests + classic message files.** `AgentSessionRepository.listKnownSessionIds()` unions `.saivage/agents/sessions/*.json` and `.saivage/agents/messages/*.jsonl`. Micro-actor sessions have neither, so they are absent from `/api/agents`.

4. **The Debug Agents view scans an obsolete directory.** `DebugView.vue` lists `.saivage/agents/messages`, `.saivage/agents/tool-deliveries`, and `.saivage/agents/llm-exchanges`, and never `.saivage/agents/conversations`. The frontend also duplicates on-disk layout knowledge it should not have.

5. **The conversation timeline hides `system_prompt` entries.** `web/src/utils/agent-timeline/timeline.ts` puts only `text` and `activity` into `round.texts`. Even a correctly returned `system_prompt` is not rendered.

6. **The analyst runs on a separate LLM engine and transcript.** `AnalystHandler` uses `InvocationService` + `AgentSessionRepository` + `.saivage/agents/messages`. Planner/executor/reviewer use `LLMActor` + segments. This split is the source of the dual format and of inconsistent prompt visibility, repair, and recovery semantics.

## Desired architecture

One transcript substrate for every LLM-backed agent:

```text
.saivage/agents/conversations/<encodeURIComponent(sessionId)>/seg-001.jsonl
```

One LLM turn engine: `LLMActor`. Planner, executor, reviewer, and analyst all call `LLMActor.turn()` / `LLMActor.appendToolResult()` / `LLMActor.continueAfterPlainText()`. Role-specific loop logic stays in the processors/analyst handler.

Sessions are derived, not manifest-backed. A session exists iff its conversation directory exists. `role`, `card_id`, and `assessment_id` are parsed from the session id; `started_at` is the first conversation message timestamp; live `status` comes from runtime actor snapshots; `model` comes from the latest LLM exchange record. `.saivage/agents/sessions` and `.saivage/agents/messages` stop being created and stop being read.

The single-active-session manifest invariant is replaced by the supervisor's provider-call admission (`RuntimeSupervisorActor.requestProviderCall`), which enforces a strictly stronger invariant: at most one global in-flight LLM call. The manifest-based `assertNoActiveAgentSession` / `reconcileOrphanedAgentSessions` / `ConcurrentAgentSessionError` are deleted.

Every operator/UI surface reads conversations through `/api/agents/:id/conversation` (segment-backed). No frontend component knows segment paths. Internal operational ledgers (`agents/llm-exchanges`, `agents/tool-deliveries`) remain separate and are not eliminated; only `agents/messages` and `agents/sessions` are eliminated as transcript/manifest authorities.

## Implementation

### 1. Fix executor `handleToolCall` missing `await`

Add `await` to every async return in `TerminalCardProcessorActor.handleToolCall`:

```ts
private async handleToolCall(outcome: Extract<LLMActorOutcome, { type: 'tool_call' }>): Promise<unknown> {
  try {
    if (outcome.toolName === 'run_process') return await this.runProcess(outcome.args, outcome.toolCallId);
    if (outcome.toolName === 'wait_process') return await this.waitProcess(outcome.args);
    if (outcome.toolName === 'inspect_process') return await this.inspectProcess(outcome.args);
    if (outcome.toolName === 'kill_process') return await this.killProcess(outcome.args);
    if (WORKSPACE_TOOL_NAMES.has(outcome.toolName)) return await processWorkspaceToolCall(outcome.toolName, JSON.stringify(outcome.args), { projectRoot: this.projectRoot, cardId: this.cardId, sessionId: executorActorId(this.cardId), agentRole: 'executor' });
    throw new Error(`Unsupported executor tool call '${outcome.toolName}'.`);
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}
```

With this fix, a malformed `write {}` call is caught by the try/catch, returned as `{ success: false, error }`, and delivered to the model via the existing `appendToolResult` path. The model sees the validation error and can retry with valid arguments. No new repair category, no fingerprint guard, no error classification helper is needed.

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

### 3. Migrate the analyst onto `LLMActor` and segments

The analyst loop currently re-reads all messages from disk every iteration, compacts, filters, injects workspace context, and sends the full history to the provider via `InvocationService.invokeWithRecovery()`. `LLMActor` keeps context in memory and appends to it through state-machine transitions.

Migration approach:

- Build a `LlmInvocationInput` from the existing analyst loop state:

  ```text
  agentId: 'analyst'
  role: 'analyst'
  sessionId: 'analyst'  (or the resolved per-conversation session id)
  systemPrompt: getAnalystSystemPrompt() + projectContext
  contextMessages: history (from segment) + workspace-context system message
  tools: getAnalystToolDefinitions()
  terminalToolNames: []
  ```

- `AnalystHandler.runAnalystLoop` calls `llmActor.turn(input)` for the first call. For each tool call, it dispatches via the existing `ToolDispatcher`, then calls `llmActor.appendToolResult(toolCallId, result, hook)`. For plain-text results, the loop ends (the analyst has no terminal tool contract).

- The workspace-context system message is part of the initial `contextMessages`, not re-injected per iteration. It may become stale during a long conversation; this is acceptable for Phase 1.

- Compaction is not wired. The context grows until the conversation ends or the provider rejects an oversized request. This is a known Phase 1 limitation.

- `filterAgentMessagesForModel` stays as-is. It hides `system_prompt` and `model_issue` from provider input because the system prompt is passed separately as `input.systemPrompt`. This is correct and must not change; the UI visibility fix is a separate concern (section 5).

- Duplicate tool-call prevention (`previousToolCallFingerprints`) and control-action auditing stay in the analyst handler. Transcript appends (system prompt, assistant text, tool calls, tool results) move to `LLMActor` and land in `agents/conversations/analyst/seg-001.jsonl`.

- `InvocationService` stays as the `LLMProviderPort` adapter (already wired in `src/application/micro-actor-runtime-api-factory.ts:28`). It handles model routing, candidate resolution, and retry. Only the analyst's direct `invokeWithRecovery` call and its session/message persistence are removed.

- Because there is no bridge, a running `analyst` session with old `.saivage/agents/messages/analyst.jsonl` history is simply reset: the operator starts a new conversation or the old file is ignored.

### 4. Replace the agent read model with a segment-backed, derived model

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
- `model` from the latest `.saivage/agents/llm-exchanges/<id>.json` if present, else null. This is an operational ledger read, not a transcript read.

No `AgentSession` manifest is created or read. `/api/agents/:id/conversation` returns `system_prompt` entries by default (operator APIs are debugging surfaces).

The analyst tools `list_agent_sessions` and `read_agent_session` use the same read model. No duplicate implementation.

### 5. Port the UI off raw file discovery and render system prompts

`AgentsView.vue` already uses `/api/agents/:id/conversation`; once the backend is segment-backed it gets micro-actor conversations for free. No frontend change there beyond testing.

`DebugView.vue` "Persisted Agent Conversations": stop scanning `.saivage/agents/messages`, `.saivage/agents/sessions`. Drive the message view from `/api/agents` + `/api/agents/:id/conversation` (the same API the main Agents page uses). Keep Tool Deliveries and Raw LLM Exchange as raw file views if useful, since those are separate operational ledgers; if kept, list `.saivage/agents/tool-deliveries` and `.saivage/agents/llm-exchanges` only — never `messages` or `sessions`.

In `web/src/utils/agent-timeline/timeline.ts`, include `system_prompt` in the rendered text set:

```ts
texts: sorted.filter((entry) => entry.kind === 'text' || entry.kind === 'activity' || entry.kind === 'system_prompt')
```

Add a compact `SystemPromptBlock.vue` (or extend `ContextBlock.vue`) that renders a collapsed `System prompt` header by default, expanding to the full text on click. System prompts are long; they must not dump thousands of tokens inline.

### 6. Cleanup

- Remove `agents/messages` and `agents/sessions` from `file-tree.ts` (both the `SAIVAGE_DIRS` list and the `isNewSaivageState` probe). `initProjectTree()` creates `agents/conversations` only. Update tests that assert their creation.
- Delete from `src/runtime/session-persistence.ts`: `appendMessage`, `appendSystemPromptMessageIfMissing`, `getSessionMessages`, `replaceSessionMessages`, `messagesPath`, `messagesDir`, `MESSAGES_DIR`, `createSession`, `getSession`, `listSessions`, `sessionPath`, `sessionsDir`, `SESSIONS_DIR`, manifest-based `completeSession`/`setSessionStatus`/`markSessionWaiting`/`updateSessionModel`, `reconcileOrphanedAgentSessions`, `assertNoActiveAgentSession`, `ConcurrentAgentSessionError`.
- Delete `AgentSessionRepository` (`src/agents/agent-session-repository.ts`).
- Delete `AgentSessionCoordinator` (`src/agents/agent-session-coordinator.ts`).
- Delete `AgentInvocationRunner` (`src/agents/invocation-runner.ts`) — it was only used by the old analyst/invocation path.
- Delete `InvocationModelContext` (`src/agents/invocation-model-context.ts`) — it was only used by `AgentInvocationRunner`.
- Delete `compactPersistedPlannerHistoryForRetry` (`src/runtime/persisted-planner-history.ts`) — it reads/writes the old format while the planner already writes to segments; it is dead code.
- Delete `ContextCompactor` (`src/agents/context-compactor.ts`) — it depends on `replaceSessionMessages` which is being removed. Compaction is Phase 2.
- Update tests that write fixtures to `agents/messages/*` (e.g. `tests/application/read-models.test.ts`) to write to `agents/conversations/<id>/seg-001.jsonl`.

## Execution order

1. Failing test: executor emits `write {}` → expect model gets error as tool result and can continue (not card failure). After fix, same test passes.
2. Fix `handleToolCall` missing `await` in `terminal-card-processor-actor.ts`.
3. Add `conversation-store.ts`; route `LLMActor`/`llm-delivery-log` through it.
4. Migrate `AnalystHandler` onto `LLMActor` + segments.
5. Replace `AgentOperatorReadModelService` with the segment-backed derived model; update `/api/agents` and analyst tools; remove `AgentSessionRepository`.
6. Port `DebugView.vue` Messages to `/api/agents/:id/conversation`.
7. Timeline `system_prompt` rendering + `SystemPromptBlock`; web tests.
8. Remove `agents/messages` and `agents/sessions` from `file-tree.ts`; update fixtures; delete dead code listed in section 6.

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
malformed non-terminal write -> tool result delivered -> model retries or continues
no .saivage/agents/messages or .saivage/agents/sessions created
```

## Acceptance criteria

1. A malformed non-terminal tool call during a live activation is delivered to the model as a tool result (not card failure); the model can retry with valid arguments.
2. Terminal-contract repair (plain text, invalid terminal envelope, missing record) remains intact.
3. Startup recovery still fails/blocks interrupted non-terminal waiting-tool states; no recovery-time repair is added.
4. `/api/agents` lists micro-actor sessions derived from `.saivage/agents/conversations`.
5. `/api/agents/:id/conversation` returns `system_prompt` for every role.
6. The Agents page and Debug view show system prompts for planner/executor/reviewer.
7. The analyst uses `LLMActor` and writes `agents/conversations/analyst/seg-001.jsonl`.
8. No code reads or writes `.saivage/agents/messages` or `.saivage/agents/sessions`; `initProjectTree` does not create them; no fallback/bridge remains.
9. `assertNoActiveAgentSession` / `reconcileOrphanedAgentSessions` / `ConcurrentAgentSessionError` are deleted; the supervisor's provider-call admission is the sole active-call invariant.