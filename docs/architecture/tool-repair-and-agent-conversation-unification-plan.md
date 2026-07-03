# Tool Repair And Agent Conversation Unification Plan

Date: 2026-06-30

## Current status

Phase 1 is functionally implemented and validated. Conversation compaction is not part of Phase 1; its planning and open design work now live in [Conversation Compaction Design](./conversation-compaction-design.md).

Completed non-compaction Phase 1 follow-up work:

1. **Adapter cleanup is complete.** The old `AgentAdapter` invocation/session/tool facade was removed; runtime composition now constructs provider routing and `InvocationService` directly.
2. **Activity-status cleanup is complete.** The segment-backed agent read model derives `activity_status` from actor snapshots directly; the old stamper/runtime activity-status plumbing is gone.
3. **System prompts are visible without flooding the view.** Segment-backed conversations include `system_prompt` entries, the timeline includes them in rendered text blocks, and `ContextBlock` collapses system prompts by default.
4. **Live `pueblicos` verification is complete.** After rebuilding and restarting `saivage-pueblicos.service`, `/api/agents` listed planner/executor sessions, checked conversations included `system_prompt` entries, and the old `.saivage/agents/messages` and `.saivage/agents/sessions` artifacts were confirmed as pre-existing files from before the restart rather than newly created outputs.

Remaining Phase 1 follow-up work: none. Conversation compaction remains deferred and out of scope for Phase 1.

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
- Compaction for LLMActor conversations is deferred to [Conversation Compaction Design](./conversation-compaction-design.md). The micro-actors already run without compaction (context grows in memory until the activation ends). The analyst joins this behavior. Long analyst conversations may hit the provider context limit; the operator can start a new session. This is a known Phase 1 limitation.
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

7. **Dead `AgentExecutionPort` surface lingered in `AgentAdapter`.** `AgentAdapter` implemented `AgentExecutionPort` (`invokePlanner`/`invokeExecutor`/`invokeReviewer`/`reinvokeSession`) via `AgentInvocationRunner`. The micro-actor runtime replaced this entire surface — it uses `LLMActor` directly. No production code called these methods; only tests did. The dead surface kept `AgentInvocationRunner`, `AgentSessionCoordinator`, `AgentSessionLifecycle`, `SessionMessageLog`, `InvocationModelContext`, and `ContextCompactor` alive as transitive dependencies.

## Desired architecture

One transcript substrate for every LLM-backed agent:

```text
.saivage/agents/conversations/<encodeURIComponent(sessionId)>/seg-001.jsonl
```

One LLM turn engine: `LLMActor`. Planner, executor, reviewer, and analyst all call `LLMActor.turn()` / `LLMActor.appendToolResult()` / `LLMActor.continueAfterPlainText()`. Role-specific loop logic stays in the processors/analyst handler.

`LLMActor` is role-generic. It does not assume every turn belongs to a card. The actor vocabulary and ID grammar include `analyst` alongside planner/reviewer/executor. The active-reconstruction record supports both card-bound turns (planner/executor/reviewer) and free turns (analyst).

Sessions are derived, not manifest-backed. A session exists iff its conversation directory exists. `role`, `card_id`, and `assessment_id` are parsed from the session id; `started_at` is the first conversation message timestamp; live `status` comes from runtime actor snapshots; `model` comes from the latest LLM exchange record. `.saivage/agents/sessions` and `.saivage/agents/messages` stop being created and stop being read.

The single-active-session manifest invariant is deleted. Autonomous card work uses the supervisor's provider-call admission (`RuntimeSupervisorActor.requestProviderCall`), which enforces at most one in-flight autonomous LLM call. The analyst bypasses supervisor admission in Phase 1 so operator chat works while the autonomous runtime is stopped; if global serialization between analyst and autonomous work becomes necessary, add the planned `ModelCallGate` rather than restoring session manifests. The manifest-based `assertNoActiveAgentSession` / `reconcileOrphanedAgentSessions` / `ConcurrentAgentSessionError` are deleted.

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
appendConversationMessage(projectRoot, message)  // creates dir on first append
buildContextTextMessage(sessionId, role, content)   // caller-appended context row (user/system) with valid id/round/index/timestamp
```

`appendConversationMessage` creates the conversation directory on first write. No public `ensureConversationDir`; empty sessions never exist. `LLMActor` and `llm-delivery-log.ts` import from this module. No other transcript read path remains. `buildContextTextMessage` constructs a valid `AgentMessage` (with `id`, `round_id`, `message_index`, `block_index`, `timestamp`) for any caller-side context row — the analyst handler uses it for both the per-turn workspace-context note (`role: 'system'`) and the operator user message (`role: 'user'`) — so the old `SessionStamper` is not needed. `LLMActor`-internal rows continue to use the stamping helpers already in `llm-delivery-log.ts`.

The current `appendActorSystemPromptIfMissing` in `llm-delivery-log.ts` calls `readConversationMessages()` — reading the entire segment from disk — on every `turn()` just to check if the system prompt was already logged. For short-lived card-processor actors this is negligible, but for the analyst's long-lived actor it reads a growing transcript on every turn, contradicting the "normal live turns do not reread the transcript from disk" invariant. Fix this by moving system-prompt dedup ownership into `LLMActor`: each actor tracks whether it has already logged its system prompt for its current session and passes that decision to the logging helper. The flag starts `false` for newly created actors, is set `true` after the first successful append attempt, and is initialized from the segment transcript only on explicit disk reconstruction/reset paths. Do not check `contextMessages` for a system-prompt id: `system_prompt` rows are intentionally filtered out of provider context. The disk read in the live `appendActorSystemPromptIfMissing` path is removed.

Add one projection helper:

```ts
conversationMessagesForModel(messages: AgentMessage[]): AgentMessage[]
```

This filters out `system_prompt`, `model_issue`, and `activity` entries — the operator/audit rows that must not be sent back to the provider as context. It preserves `text`, `tool_call`, `tool_result`, and `model_repair` entries. This helper is used only when reconstructing an actor from disk (after server restart or conversation reset) and in any read/replay path that projects segments into provider context. During normal operation, `LLMActor` uses its accumulated in-memory context, not a disk reconstruction.

### 3. Generalize `LLMActor` beyond card processors

`LLMActor` is currently created and owned by `BaseMainLLMCardProcessorActor`, which lives inside the card-processor tree. The analyst needs `LLMActor` as a standalone persistent conversation engine — owned directly by the analyst handler, not by a card processor. The key architectural change is making `LLMActor` a general-purpose LLM conversation actor that works in both contexts.

**Actor vocabulary and ID grammar.** Add `'analyst'` to `llmActorRoles` in `src/runtime/actors/actor-vocabulary.ts`. Add the `analyst:` prefix to `actorKindFromId` in `src/runtime/actors/ids.ts`. Update `parseLlmActorId` to return `{ role: LlmActorRole; cardId: string | null }` — `cardId` is the parsed id suffix for planner/reviewer/executor, and `null` for analyst. Update all `parseLlmActorId` consumers (recovery, read model, supervisor API) to handle the nullable `cardId`.

**Reconstruction record.** Make `card_id` nullable in `LlmActiveReconstructionRecord` and `llmActiveReconstructionSchema` (`z.string().min(1)` → `z.string().nullable()`). Remove the `card_id` validation throw in `LLMActor.createActiveReconstruction`; pass `null` for analyst turns. In `readLlmActiveReconstruction`, skip the `card_id !== identity.cardId` check when `identity.cardId === null`.

**Session-id grammar.** Define one exact grammar, shared by recovery, read model, UI, and session-id validation:
- `planner:<cardId>`
- `executor:<cardId>`
- `reviewer:<cardId>:<assessmentId>`
- `analyst:<id>` (e.g. `analyst:global`, `analyst:telegram-<chatId>`)

`agentId` equals `sessionId` for all roles. Move `GLOBAL_ANALYST_SESSION_ID` (`'analyst:global'`) and `isSafeAgentSessionId` to `src/agents/session-ids.ts` since `AgentSessionRepository` is being deleted.

**Persistent multi-turn context.** `LLMActor` already maintains in-memory conversation context across `turn` → `appendToolResult` → `turn` cycles within a single activation. For the analyst, the actor persists across user requests, so context accumulates across the entire conversation.

However, `LLMActor.completeWithProviderResult()` currently sets `this.outcome` and resolves the turn, but does NOT update `this.input.contextMessages` with the assistant text response. `continueAfterPlainText()` works around this for the repair path by manually appending the assistant message before calling `turn()`. For the card processors this is not a problem because the processor discards the actor after each activation — the card result is the terminal tool call, not the text. For the analyst's persistent actor, losing the assistant text from context would break multi-turn conversations.

Fix: make `completeWithProviderResult()` update `this.input.contextMessages` to include the assistant text when the result is a message, before setting `this.outcome`. Then `continueAfterPlainText()` should NOT separately append the assistant message (it would double-append). This makes in-memory context complete after every turn for all callers — card processors, analyst, and repair.

**Per-turn tool-delivery scoping.** `deliveredToolCallIds` currently accumulates for the lifetime of the actor. For card processors this is fine (short-lived actors). For a persistent analyst actor, stale IDs could cause false rejection if a provider reuses tool-call IDs across turns. Fix: clear `deliveredToolCallIds` at the start of each top-level `turn()` call (not during tool-call continuations within the same turn). Tool-call IDs only need to be unique within one turn chain, not across the entire actor lifetime.

**Subsequent analyst turns.** For every operator message, the handler builds and persists two provider-visible context rows before calling `LLMActor`: the current `[workspace-context]` note and the operator's user message. The first user message creates a full `LlmInvocationInput` with `contextMessages: [workspaceContextMessage, userMessage]` and calls `llmActor.turn(input)`. Later user messages reuse the same actor and call `llmActor.turn({ ...actor.input, inputId: newInputId, contextMessages: [...actor.input.contextMessages, workspaceContextMessage, newUserMessage] })`. This preserves the full accumulated conversation while keeping deictic UI references such as "this card" tied to the current operator focus for each user turn. Tool continuations do not re-inject workspace context; they continue from the context already established for the current user turn.

**Why generalize, not subclass.** `LLMActor` is already the right abstraction: a state machine for LLM turns with provider call, tool-call continuation, and segment logging. The role-specific loop logic (terminal contracts, repair, child activation, assessment currentness) lives in the surrounding handlers, not in `LLMActor`. The analyst handler wraps `LLMActor` the same way the card processors do — it owns the loop, `LLMActor` owns the turn. The only changes needed are nullable `cardId`, analyst in the ID grammar, and the persistent-context fix described above. Creating `CardLLMActor`/`AnalystLLMActor` subclasses would duplicate the state machine and all turn/tool/continuation logic for a one-field difference. If the loop skeletons later converge enough to justify a `BaseLLMConversationHandler` shared base, that would be a separate refactor — but the card processor loops (terminal contract + repair + child activation) and the analyst loop (no terminal, no repair) are different enough that a shared loop base now would be premature.

### 4. Migrate the analyst onto `LLMActor` and segments

The analyst loop currently re-reads all messages from disk every iteration, compacts, filters, injects workspace context, and sends the full history to the provider via `InvocationService.invokeWithRecovery()`. `LLMActor` keeps context in memory and appends to it through state-machine transitions.

**Provider and admission wiring.** Export `createInvocationServiceProvider(invocationService): LLMProviderPort` from `src/application/micro-actor-runtime-api-factory.ts` (currently a private function) so both the micro-actor runtime and the analyst use the same adapter. For admission: the analyst should not be blocked when the autonomous runtime is stopped (the supervisor's `requestProviderCall` returns false when not running). In Phase 1, pass no `admission` to the analyst `LLMActor` — the analyst can call the provider at any time. If call serialization becomes necessary, introduce a global `ModelCallGate` shared by both the supervisor and the analyst in a follow-up. `AnalystRuntimeDeps` gains `provider: LLMProviderPort`. It loses `contextCompactor`, `stamper`, and `admission`.

**LLMActor lifecycle.** The `AnalystHandler` owns a `Map<sessionId, LLMActor>`. On the first user message for a session, it creates an `LLMActor`, calls `start()`, and builds the initial `LlmInvocationInput` with `systemPrompt`, `contextMessages: [workspaceContextMessage, userMessage]`, and analyst tools. On subsequent user messages to the same session, it reuses the existing actor: appends the per-turn workspace-context note and user message to `conversation-store`, then calls `llmActor.turn(newInput)` where `newInput.contextMessages` is the actor's accumulated in-memory context plus the current workspace-context note and new user message. The actor is discarded only when the conversation is explicitly reset or the handler is disposed.

**Turn input.** Build the initial `LlmInvocationInput`:

```text
agentId: sessionId   (e.g. 'analyst:global')
role: 'analyst'
sessionId: sessionId
systemPrompt: getAnalystSystemPrompt() + projectContext
contextMessages: [workspace-context system message, user message]
tools: getAnalystToolDefinitions()
terminalToolNames: []
episodeContext: { cardId: null }
```

For subsequent turns, the actor's `input.contextMessages` already contains the accumulated conversation. The handler appends the current workspace-context note and the new user message:

```text
contextMessages: [...actor.input.contextMessages, workspaceContextMessage, newUserMessage]
```

This is the natural `LLMActor` continuation pattern — the same way `appendToolResult` builds on `input.contextMessages`.

When reconstructing an analyst actor after restart/reset, the handler reads the segment transcript, projects it through `conversationMessagesForModel`, appends the current workspace-context note and new user message, and starts the next turn from that reconstructed context. The reconstructed `LlmInvocationInput` also needs `systemPrompt`, `tools`, `terminalToolNames`, and `episodeContext: { cardId: null }`; the handler rebuilds these deterministically (`getAnalystSystemPrompt() + projectContext`, analyst tool definitions, empty terminal set) rather than extracting them from the transcript, since they are stable inputs, not conversation history. Normal live turns do not reread the transcript from disk.

**User message and workspace-context persistence.** `LLMActor` logs model-side entries (system prompt, assistant text, tool calls, tool results) but not arbitrary caller-provided context messages. The analyst handler appends the per-turn workspace-context note and the operator's user message to `conversation-store` directly before calling `llmActor.turn(...)`. Persisting the workspace-context note is required because it is provider-visible context needed to reconstruct deictic user turns after restart. The conversation directory is created by `appendConversationMessage` on the first persisted context row — no pre-creation step, no empty-session problem.

Replace `getOrCreateAnalystSession()` with a simple pure resolver in `src/agents/session-ids.ts`:

```ts
function resolveAnalystSessionId(sessionId?: string): string {
  return sessionId ?? GLOBAL_ANALYST_SESSION_ID;
}
```

No filesystem side effects, no `AgentSession` manifest. Consumers (websocket, telegram, chat routes) call this to normalize the id; the conversation directory is created on first `appendConversationMessage`.

**Loop shape.** `LLMActor.turn()` / `appendToolResult()` return `LLMActorOutcome` with three variants; the analyst loop handles each:
- `{ type: 'result' }` — plain text; the loop ends (the analyst has no terminal tool contract). The handler returns the assistant text as the `AnalystResponse`.
- `{ type: 'tool_call' }` — the handler dispatches through the active `InvocationSurface` via `invokeToolCall`, then calls `llmActor.appendToolResult(toolCallId, result)` and loops.
- `{ type: 'error' }` — provider failure (offline, rate limit, parse error). The handler returns an error `AnalystResponse` to the operator, preserving the current `ANALYST_NO_MODEL_REPLY` / `AnalystOfflineError` behavior. The loop ends; no retry at the `LLMActor` level.

Duplicate tool-call prevention (`previousToolCallFingerprints`), unavailable-tool rejection, and control-action auditing stay in the analyst handler.

**Context management.** Compaction is not wired. The context grows until the conversation ends or the provider rejects an oversized request. This is a known Phase 1 limitation. A fresh workspace-context note is injected once per operator user turn, immediately before that user message. It is not re-injected for tool continuations within the same turn.

**Recovery.** Analyst `LLMActor` instances are in-memory and owned by `AnalystHandler`. Durable analyst conversation state is the segment transcript, not the actor snapshot — the snapshot is only in-flight execution state. If the server restarts mid-conversation, the actor is gone. On startup, `abandonStalePendingToolCalls` already clears stale pending tool-call statuses. Analyst LLM snapshots (if any exist from a crash) are unconditionally removed by recovery — no card lifecycle patch, no recovery diagnostics. On the next user message, `AnalystHandler` re-creates the actor and reconstructs context from `conversationMessagesForModel(readConversationMessages(projectRoot, sessionId))`, rebuilds `systemPrompt`/`tools`/`episodeContext` deterministically (as in section 4's continuation flow), appends the current workspace-context note and new user message, and starts the next turn.

**Live status.** Analyst sessions do not appear in `getActorRuntimeReadModel()` (which walks card processors). The segment read model derives analyst session status from actor snapshots directly: if a matching `analyst:*` snapshot exists and is active, the session is active; otherwise it is inactive. This is a snapshot read, not a card processor lookup.

Because there is no bridge, a running `analyst` session with old `.saivage/agents/messages/analyst.jsonl` history is simply reset: the operator starts a new conversation or the old file is ignored.

### 5. Replace agent and chat read models with one segment-backed, derived model

Delete the legacy `AgentSessionRepository` readers (`listMessageSessionIds`, `readEncodedSessionMessages`) and the manifest-backed listing. Delete `ChatReadModelService` (`src/application/read-models/chat-read-model.ts`) entirely — it is a parallel read model that duplicates the agent read model for the analyst session. Chat routes (`chats.list`, `chats.get`) call the same segment-backed `AgentOperatorReadModelService` filtered to `analyst:*`. One backend read model, no parallel implementation.

The new read model derives sessions:

```ts
listSessions():
  ids = listConversationSessionIds(projectRoot)
  return ids.map(id => deriveSessionSummary(id, readConversationMessages(projectRoot, id), readActorSnapshots(projectRoot)))

getConversation(sessionId):
  messages = readConversationMessages(projectRoot, sessionId)
  if (messages.length === 0) 404
  return { session: deriveSessionSummary(...), entries: messages, activity_status: deriveActivityStatus(sessionId, readActorSnapshots(projectRoot)) }
```

`deriveSessionSummary(id, messages, snapshots)`:
- `role` from id prefix (`analyst:` / `planner:` / `executor:` / `reviewer:`).
- `card_id` parsed from id for planner/executor/reviewer; `null` for analyst.
- `assessment_id` from reviewer id suffix.
- `started_at` = first message `timestamp`.
- `status` = active/waiting from a matching live LLM actor snapshot; else inactive/done/blocked/failed inferred from the card lifecycle of the referenced card (failed/blocked) or last message.
- `model` from the latest `.saivage/agents/llm-exchanges/<id>.json` if present, else null. This is an operational ledger read, not a transcript read.

`deriveActivityStatus(sessionId, snapshots)`:
- Find the matching LLM actor snapshot by `actor_id === sessionId`.
- If the snapshot state is `calling_provider`, return `{ status: 'thinking', pending_calls: [], updated_at: snapshot.updated_at }`.
- If the snapshot state is `waiting_tool`, return `{ status: 'tool_calling', pending_calls: [], updated_at: snapshot.updated_at }`.
- If no matching snapshot exists, return `{ status: 'idle', pending_calls: [], updated_at: new Date(0).toISOString() }`.
- This replaces the old stamper-based runtime activity surface. The read model derives `activity_status` from snapshots directly.

No `AgentSession` manifest is created or read. `/api/agents/:id/conversation` returns `system_prompt` entries by default (operator APIs are debugging surfaces).

The analyst tools `list_agent_sessions` and `read_agent_session` use the same read model.

### 6. Remove the old adapter facade

Status: completed for Phase 1. The old `AgentExecutionPort` implementation, session lifecycle stack, compaction dependencies, and test-only tool/MCP facades are gone. `AgentAdapter` was first slimmed to a provider-routing service container, then removed entirely once `runtime-composition.ts` became the sole production caller. Runtime composition now directly constructs `ProviderRegistry`, `ModelRouter`, and `InvocationService`, and passes the same `InvocationService` to the micro-actor runtime and analyst provider port.

### 7. Port the UI off raw file discovery and render system prompts

`AgentsView.vue` already uses `/api/agents/:id/conversation`; once the backend is segment-backed it gets micro-actor conversations for free. No frontend change there beyond testing.

`DebugView.vue` "Persisted Agent Conversations": stop scanning `.saivage/agents/messages`, `.saivage/agents/sessions`. Drive the message view from `/api/agents` + `/api/agents/:id/conversation` (the same API the main Agents page uses). Keep Tool Deliveries and Raw LLM Exchange as raw file views if useful, since those are separate operational ledgers; if kept, list `.saivage/agents/tool-deliveries` and `.saivage/agents/llm-exchanges` only — never `messages` or `sessions`.

In `web/src/utils/agent-timeline/timeline.ts`, include `system_prompt` in the rendered text set:

```ts
texts: sorted.filter((entry) => entry.kind === 'text' || entry.kind === 'activity' || entry.kind === 'system_prompt')
```

Add a compact `SystemPromptBlock.vue` (or extend `ContextBlock.vue`) that renders a collapsed `System prompt` header by default, expanding to the full text on click. System prompts are long; they must not dump thousands of tokens inline.

When displaying example paths or raw file links, always URI-encode the session id (`analyst%3Aglobal`, not `analyst:global`) because the on-disk directory name is `<encodeURIComponent(sessionId)>`.

### 8. Cleanup

- Remove `agents/messages` and `agents/sessions` from `file-tree.ts` (both the `SAIVAGE_DIRS` list and the `isNewSaivageState` probe). `initProjectTree()` creates `agents/conversations` only. Update tests that assert their creation.
- Delete from `src/runtime/session-persistence.ts`: `appendMessage`, `appendSystemPromptMessageIfMissing`, `getSessionMessages`, `replaceSessionMessages`, `messagesPath`, `messagesDir`, `MESSAGES_DIR`, `createSession`, `getSession`, `listSessions`, `sessionPath`, `sessionsDir`, `SESSIONS_DIR`, manifest-based `completeSession`/`setSessionStatus`/`markSessionWaiting`/`updateSessionModel`, `reconcileOrphanedAgentSessions`, `assertNoActiveAgentSession`, `ConcurrentAgentSessionError`. If nothing useful remains in the file, delete it.
- Delete `AgentSessionRepository` (`src/agents/agent-session-repository.ts`).
- Delete `AgentSessionCoordinator` (`src/agents/agent-session-coordinator.ts`).
- Delete `AgentInvocationRunner` (`src/agents/invocation-runner.ts`).
- Delete `InvocationModelContext` (`src/agents/invocation-model-context.ts`).
- Delete `SessionMessageLog` (`src/agents/session-message-log.ts`).
- Delete `AgentSessionLifecycle` (`src/agents/session-lifecycle.ts`).
- Delete `compactPersistedPlannerHistoryForRetry` (`src/runtime/persisted-planner-history.ts`) — it reads/writes the old format while the planner already writes to segments; it is dead code.
- Delete `ContextCompactor` (`src/agents/context-compactor.ts`) — it depends on `replaceSessionMessages` which is being removed. Compaction is Phase 2.
- Delete `ChatReadModelService` (`src/application/read-models/chat-read-model.ts`) — chat routes use the segment-backed agent read model.
- Delete `SessionInvariantError` if no longer referenced after the `AgentAdapter` slim.
- Update tests that write fixtures to `agents/messages/*` (e.g. `tests/application/read-models.test.ts`) to write to `agents/conversations/<id>/seg-001.jsonl`.

## Execution order

1. Failing test: executor emits `write {}` → expect model gets error as tool result and can continue (not card failure). After fix, same test passes.
2. Fix `handleToolCall` missing `await` in `terminal-card-processor-actor.ts`.
3. Add `conversation-store.ts`; route `LLMActor`/`llm-delivery-log` through it.
4. Add `'analyst'` to actor vocabulary and ID grammar; make `LlmActiveReconstructionRecord.card_id` nullable; update `readLlmActiveReconstruction` to skip card validation for analyst.
5. Migrate `AnalystHandler` onto `LLMActor` + segments (user message persistence, session creation in `session-ids.ts`, `AnalystRuntimeDeps` changes).
6. Replace `AgentOperatorReadModelService` and `ChatReadModelService` with the segment-backed derived model; update `/api/agents`, `/api/agents/:id/conversation`, chat routes, and analyst tools; remove `AgentSessionRepository`.
7. Slim `AgentAdapter`: delete `AgentExecutionPort` surface, `AgentInvocationRunner`, session lifecycle, coordinator, context compactor; update `runtime-composition.ts`; delete dead tests.
8. Port `DebugView.vue` Messages to `/api/agents/:id/conversation`.
9. Timeline `system_prompt` rendering + `SystemPromptBlock`; web tests.
10. Remove `agents/messages` and `agents/sessions` from `file-tree.ts`; update fixtures; delete dead code listed in section 8.

## Validation

Focused:

```bash
npm run test:direct -- tests/runtime/actors/terminal-card-processor-actor.test.ts tests/runtime/actors/planning-card-processor-actor.test.ts tests/runtime/actors/llm-delivery-log.test.ts tests/server/agents-detail-route.test.ts --runInBand
npm run web:test:operator-smoke
```

Specific regression coverage to add/update:
- `LLMActor.completeWithProviderResult()` appends assistant text to in-memory context, and `continueAfterPlainText()` does not double-append it.
- `LLMActor.turn()` clears `deliveredToolCallIds` for a new top-level turn while preserving duplicate-delivery protection inside one tool-continuation chain.
- Analyst first and subsequent turns include both the per-turn workspace-context note and the operator user message in `LLMActor.turn()` input.
- Analyst restart reconstruction uses `conversationMessagesForModel(readConversationMessages(...))` once, appends the current workspace-context note plus user message, then continues from in-memory context.
- `/api/agents` and chat route tests use encoded segment paths and never create `.saivage/agents/messages` or `.saivage/agents/sessions` fixtures.

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
4. `/api/agents` lists micro-actor and analyst sessions derived from `.saivage/agents/conversations`.
5. `/api/agents/:id/conversation` returns `system_prompt` for every role.
6. The Agents page and Debug view show system prompts for planner/executor/reviewer.
7. The analyst uses `LLMActor` and writes `agents/conversations/<encodeURIComponent(analyst:<id>)>/seg-001.jsonl`.
8. No code reads or writes `.saivage/agents/messages` or `.saivage/agents/sessions`; `initProjectTree` does not create them; no fallback/bridge remains.
9. `assertNoActiveAgentSession` / `reconcileOrphanedAgentSessions` / `ConcurrentAgentSessionError` are deleted; autonomous card work is serialized by supervisor provider-call admission, and analyst calls either remain independently admitted for Phase 1 or are serialized later by an explicit `ModelCallGate`.
10. `AgentAdapter` no longer implements `AgentExecutionPort`; `AgentInvocationRunner`, `AgentSessionCoordinator`, `AgentSessionLifecycle`, `SessionMessageLog`, `InvocationModelContext`, and `ContextCompactor` are deleted.
11. Chat routes (`chats.list`, `chats.get`) return data from the segment-backed read model.

## Compaction

Conversation compaction is intentionally not implemented in Phase 1. Its planning and open design questions now live in [Conversation Compaction Design](./conversation-compaction-design.md).
