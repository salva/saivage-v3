# Card-Attached Agent Lifetime Plan

Status: proposed design and implementation plan. This document is not current
runtime behavior until the implementation lands. Current behavior remains
documented in [Agents and runtime architecture](../agents.md).

## 1. Objective

Saivage should stop treating executor and reviewer agents as one-shot workers.
Operational agents should be attached to cards, and each attached agent should
live for the lifetime of its owning card.

The goal is continuity without cross-card contamination:

- A reviewer for a goal keeps its prior review context while the planner fixes
  earlier `needs_corrections` findings.
- An executor for a terminal card keeps prior attempt context when that same
  card is restarted or reactivated.
- Agents attached to different cards never share conversation history.
- A terminal outcome still belongs to one activation or review attempt, not to
  the whole agent lifetime.

This plan intentionally excludes the analyst. The analyst is operator-facing,
does not have a card lifecycle, and keeps its existing independent behavior.

## 2. Non-Goals

- Do not redesign the Agent tab or operator UI in this work. Existing API/UI
  surfaces should not be made worse, but a full agent-tab overhaul is deferred.
- Do not design the definitive compaction algorithm now. Add the minimum
  structure required for future episode-boundary-aware compaction.
- Do not add migration or backward-compatibility code for old `.saivage` state.
  Old state may be ignored or rejected under the repository's no-compatibility
  policy.
- Do not make analyst sessions card-attached.
- Do not synthesize fake tool calls to deliver runtime notes or episode
  context.

## 3. Vocabulary

### 3.1 Attached Agent

An attached agent is a durable LLM conversation owned by one card and one role.
It is lazily created the first time runtime needs that card-role pair.

Attached-agent identity:

```text
<role>:<card_id>
```

Examples:

```text
planner:project
planner:G-12
reviewer:G-12
executor:T-7
```

### 3.2 Episode

An episode is one runtime invocation inside an attached agent's conversation.
It is not a first-class runtime object in the initial implementation. It is a
marked region in the agent message history.

Examples:

- One planner turn or planner activation resume.
- One executor activation for a terminal card.
- One reviewer assessment attempt for a goal card.

The episode marker exists so future compaction and debugging can find coherent
boundaries. Runtime correctness must still be derived from card state,
`active_card_run`, runtime runs, activations, assessment ids, terminal tool
results, and persisted messages.

### 3.3 Terminal Outcome

A terminal outcome completes one episode or card activation. It does not close
or complete the attached agent.

Examples:

- `emit_executor_result` completes the current executor episode.
- `emit_reviewer_result` completes the current reviewer episode.
- `report_goal_done`, `report_goal_failed`, or `report_goal_blocked` completes
  the current planner episode or goal activation path.

## 4. Target Role Slots

Conceptually, card type defines normal attached-agent slots:

| Card type | Attached agent slots |
|---|---|
| `project` | `planner`, `reviewer` |
| `goal` | `planner`, `reviewer` |
| terminal card types | `executor` |

Implementation may keep this generic. The important rule is that every
operational role uses the same session infrastructure and deterministic
card-attached identity.

The analyst role is outside this table.

## 5. Agent Session Model

Use the existing `AgentSession` infrastructure as the attached-agent record.
Do not introduce a separate `AttachedAgent` store.

`AgentSession` should represent identity and ownership, not work completion.
Cards and terminal outcomes carry completion state. Runtime state carries what
is currently active.

Target fields:

```ts
interface AgentSession {
  id: string;
  role: 'planner' | 'executor' | 'reviewer' | 'analyst';
  card_id: string | null;
  goal_card_id?: string | null;
  assessment_id?: string | null;
  started_at: string;
  model?: string;
}
```

Implementation notes:

- For card-attached agents, `id` is always `<role>:<card_id>`.
- For a reviewer, `card_id` and `goal_card_id` are the same goal/project card.
- For an executor, `card_id` is the terminal card and `goal_card_id` is the
  nearest owning goal/project at invocation time.
- `assessment_id` should not identify the reviewer session. It may remain on
  result records or invocation context for the current review attempt.
- Remove or stop relying on session lifecycle statuses such as `done`,
  `failed`, `blocked`, `active`, and `waiting` for operational runtime
  correctness. If deleting the field is too large for the first patch, make it
  non-authoritative and follow up by removing it.
- Do not add an `archived` session status. A deleted/archived card determines
  whether attached agent history is active or archived.

## 6. Session Id Rules

All card-attached operational agents must use deterministic ids:

```text
planner:<goal_or_project_card_id>
reviewer:<goal_or_project_card_id>
executor:<terminal_card_id>
```

Rules:

- `createSession` should become `ensureSession` for operational agents.
- `ensureSession(role, cardId, goalCardId?)` returns the existing attached
  session if present, otherwise creates it.
- Runtime must never allocate timestamp-based executor or reviewer sessions.
- `reviewer:<goal_id>:<assessment_id>` must be removed from the runtime path.
- `assessment_id` remains a review-result/attempt id, not an agent id.
- Existing `planner:<goal_id>` behavior should be normalized into this same
  generic `ensureSession` path.

## 7. Message History

Keep one message log per attached agent:

```text
.saivage/agents/messages/<role>:<card_id>.jsonl
```

Do not split message storage by episode in the first implementation.

Reasons:

- Current provider request assembly already reads one session message stream.
- Tool-call/tool-result boundary validation is simpler in one stream.
- Future compaction points may be better persistence boundaries than episode
  boundaries.
- Runtime state already tracks active activations and review assessment ids.

## 8. Episode Markers

Every invocation of a card-attached operational agent must append an episode
start marker before model-visible episode context is appended.

Add a machine-readable message kind if practical:

```ts
type MessageKind =
  | existing kinds
  | 'episode_marker';
```

The marker should be persisted but should not need to be model-visible. The
model-visible context is a separate normal context message.

Example marker content:

```json
{
  "event": "episode_start",
  "role": "reviewer",
  "agent_id": "reviewer:G-12",
  "card_id": "G-12",
  "goal_card_id": "G-12",
  "assessment_id": "assessment-G-12-2",
  "activation_id": null,
  "reason": "correction_review"
}
```

Executor example:

```json
{
  "event": "episode_start",
  "role": "executor",
  "agent_id": "executor:T-7",
  "card_id": "T-7",
  "goal_card_id": "G-12",
  "assessment_id": null,
  "activation_id": "activation-abc",
  "reason": "card_activation"
}
```

If adding a new message kind is too large for the first patch, use a temporary
existing model-filtered diagnostic kind only if it is not sent to the provider
and is clearly documented. Do not overload `context_compaction` for episode
markers.

## 9. Model-Visible Episode Context

The marker is metadata. The LLM still needs clear instructions for the current
episode. Append a runtime-authored context message after the episode marker and
before invocation.

Initial implementation may keep using provider-facing `user` messages, but the
content must clearly identify itself as runtime context, not an operator command.

Reviewer context should include:

- The current goal card id, title, description, acceptance, status, children,
  evidence context, latest self report, and latest review result.
- The current `assessment_id`.
- Whether this is an initial review or correction review.
- An instruction to compare against prior reviewer findings when prior findings
  exist in the same conversation.
- A reminder that one valid reviewer terminal result is required.

Executor context should include:

- The terminal card id, title, description, acceptance, status, tags, and parent
  goal context.
- The current activation id when available.
- Whether this is a fresh activation, restart, or retry of the same terminal
  card.
- An instruction to inspect prior attempts in the same conversation when useful
  and avoid repeating known failures.
- A reminder that one valid executor terminal result is required.

Do not deliver notes by faking a `get_notes` assistant tool call. Tool messages
must only answer real assistant tool calls.

Future work may introduce an internal `runtime_context` role/kind and map it to
provider `developer` when supported. That is optional and not required for the
first implementation.

## 10. Terminal Tool Handling

Provider protocol remains unchanged:

- Every assistant tool call must receive a matching tool result or tool error.
- Terminal tool calls are still closed with normal tool results.
- Closing a terminal tool call ends the current episode, not the attached
  agent's lifetime.
- Runtime must not append standalone `tool` messages without a matching prior
  assistant tool call.

Example reviewer sequence:

```json
[
  { "role": "system", "content": "reviewer role and contract" },
  { "role": "user", "content": "## Runtime Review Episode\nassessment_id: assessment-G-12-1" },
  {
    "role": "assistant",
    "tool_calls": [
      {
        "id": "call_review_1",
        "type": "function",
        "function": {
          "name": "emit_reviewer_result",
          "arguments": "{\"assessment\":{\"result\":\"needs_corrections\",\"summary\":\"Missing test evidence.\",\"achieved\":[],\"issues\":[{\"severity\":\"blocker\",\"summary\":\"No test output cited.\"}],\"evidence_card_ids\":[\"G-12\"]}}"
        }
      }
    ]
  },
  {
    "role": "tool",
    "tool_call_id": "call_review_1",
    "name": "emit_reviewer_result",
    "content": "{\"accepted\":true,\"assessment_id\":\"assessment-G-12-1\"}"
  },
  { "role": "user", "content": "## Runtime Review Episode\nassessment_id: assessment-G-12-2\nThe planner addressed prior reviewer findings. Compare against your previous assessment." }
]
```

The second `user` message starts a new episode in the same `reviewer:G-12`
conversation.

## 11. Reviewer Implementation

Current behavior creates one reviewer session per assessment:

```text
reviewer:<goal_id>:<assessment_id>
```

Target behavior uses one reviewer session per goal/project card:

```text
reviewer:<goal_id>
```

Implementation steps:

1. Change reviewer session id generation to `reviewer:<goal_id>`.
2. Keep `assessment_id` generation as-is or replace it only if needed, but do
   not include it in the session id.
3. Change `ReviewerInvocationRequest` so `reviewerSessionId` is either removed
   or always derived from `goalId` by the agent runtime.
4. In `AgentAdapter.invokeReviewer`, call the generic `ensureSession` path with
   role `reviewer` and card id `goalId`.
5. Before each review invocation, append an episode marker and a review episode
   context message to `reviewer:<goal_id>`.
6. Preserve prior review messages in the same conversation.
7. When the reviewer returns `needs_corrections`, persist the assessment as
   today, resume the planner as today, and keep `reviewer:<goal_id>` available
   for the next review episode.
8. When the next review starts after planner corrections, append a new episode
   marker/context to the same reviewer session.
9. Ensure runtime events and card `result.review.reviewer_session_id` point to
   `reviewer:<goal_id>`.

Acceptance checks:

- Two correction cycles for the same goal must produce one reviewer session id
  and multiple assessment ids.
- The second reviewer model request must include prior reviewer conversation
  history unless compaction has summarized it.
- Assessment persistence must still distinguish attempts by `assessment_id`.

## 12. Executor Implementation

Current behavior creates timestamp-based executor sessions and may disagree
with runtime's predicted `executor-${card.id}` active-run id.

Target behavior uses one executor session per terminal card:

```text
executor:<terminal_card_id>
```

Implementation steps:

1. Change executor session id generation to `executor:<card_id>`.
2. In `AgentAdapter.invokeExecutor`, call the generic `ensureSession` path with
   role `executor`, card id `request.cardId`, and goal id `request.goalId`.
3. Before each executor invocation, append an episode marker and an executor
   episode context message to `executor:<card_id>`.
4. Fix runtime active-run construction so `executor_session_id` equals
   `executor:<card_id>`.
5. Remove timestamp-based executor session creation from operational runtime
   paths.
6. On terminal-card restart/reactivation, reuse `executor:<card_id>` and append
   a new episode marker/context.
7. Preserve prior executor messages in the same conversation.
8. Keep executor result attribution on the terminal card. The result belongs to
   the activation/card, not to a completed session.

Acceptance checks:

- Restarting a failed terminal card must reuse the same executor session id.
- The model request for the restarted card must include the prior executor
  attempt unless compaction has summarized it.
- Runtime `active_card_run.executor_session_id` must match the actual executor
  session id.

## 13. Planner Normalization

Planner already mostly conforms to card-attached lifetime through
`planner:<goal_id>`.

Implementation work:

1. Route planner creation through the same generic `ensureSession` helper used
   for reviewer and executor.
2. Add episode markers for planner invocations if they are useful and do not
   disrupt existing planner recovery. This may be a second patch if reviewer
   and executor continuity are the primary first milestone.
3. Do not preserve planner-specific session lifecycle semantics that conflict
   with the attached-agent model.

Planner behavior must continue to satisfy the existing `activate_card` barrier
and single-active-operational-agent invariants.

## 14. Runtime State and Recovery

Runtime correctness must not depend on an agent status field.

Use existing authoritative sources:

- `RuntimeState.active_card_run` for the active card and phase.
- Runtime runs and activations for caller edges and activation ownership.
- Card lifecycle and terminal results for card status.
- Review assessments for reviewer outcomes.
- Session messages for conversation history and episode markers.

Interrupted executor:

- Keep the current behavior that an interrupted executor activation is repaired
  as a synthetic failed outcome when appropriate.
- On the next restart/reactivation of that terminal card, reuse
  `executor:<card_id>` and append a new episode marker/context.

Interrupted reviewer:

- Keep the current behavior that an interrupted reviewer resumes the planner
  through a `reviewer_interrupted` note/path when appropriate.
- When the planner reports done again, reuse `reviewer:<goal_id>` and append a
  new review episode marker/context with the new `assessment_id`.

Startup repair must never infer that an attached agent is complete because a
prior episode completed. Only cards and activation/review outcomes complete.

## 15. Card Deletion and Archive

If a card is deleted, its attached agents must be archived with the card for
consistency.

Initial implementation requirements:

- Identify attached agent ids by deterministic prefix/id:
  - `planner:<card_id>`
  - `reviewer:<card_id>`
  - `executor:<card_id>`
- When archiving a card record, also archive existing attached agent session
  manifests and message logs for that card.
- When deleting a subtree, archive attached agents for every archived card in
  the subtree.
- Do not use an `archived` agent status. Archived location/card archive state is
  the source of truth.

If existing card deletion support is incomplete, implement agent archive only
where deletion already archives card records. Do not add a new destructive
operation solely for this plan.

## 16. Unified Compaction Bases

Compaction is not the first implementation focus, but the lifetime work must
not make compaction harder.

Set these bases now:

- One conceptual compaction strategy applies to planner, reviewer, and
  executor.
- Compaction may have conservative, balanced, aggressive, and emergency modes
  later.
- System prompts that define role, policy, contracts, tools, or safety behavior
  must be preserved byte-for-byte and never summarized, truncated, reordered, or
  removed.
- `context_compaction` diagnostic messages are not protected system prompts.
- Tool-call/tool-result validity must be preserved. A compacted model request
  must not contain orphan assistant tool calls or orphan tool messages.
- Episode markers should let future compaction prefer cuts at episode
  boundaries.
- Future compaction should try to keep full recent episodes by selecting a cut
  within a token/message range rather than blindly keeping the last N messages.
- Future layered compaction may keep recent episodes in full, middle history as
  episode-level summaries, and old history as a global summary.
- Do not implement the definitive layered algorithm in the first agent-lifetime
  patch unless token-budget failures require it.

Current planner-only emergency compaction should eventually become a strategy
inside the unified compaction service, but that consolidation can follow after
card-attached reviewer/executor lifetimes are working.

## 17. Provider Protocol Invariants

All implementation agents must preserve these invariants:

- Do not synthesize assistant tool calls unless the model actually produced
  them.
- Do not append standalone tool messages.
- Every assistant tool call included in a provider request must have its
  matching tool result/error included unless both sides were compacted away.
- Never split the active/current episode during compaction.
- Never split a terminal tool call from its terminal tool result in retained
  history.
- If protected system prompts plus required current context exceed the provider
  context budget, fail loudly instead of compacting protected prompts.

## 18. Implementation Sequence

Follow this sequence. Do not skip ahead to UI redesign or definitive
compaction.

1. Add/normalize attached-agent session helpers.
   - Implement `attachedAgentId(role, cardId)`.
   - Implement `ensureAttachedAgentSession(role, cardId, goalCardId?)`.
   - Ensure planner, reviewer, and executor can all use it.

2. Add episode markers.
   - Add `episode_marker` message kind if practical.
   - Add helper to append episode-start markers.
   - Ensure marker append uses existing session stamping/idempotence patterns.

3. Rework reviewer identity.
   - Replace `reviewer:<goal_id>:<assessment_id>` with `reviewer:<goal_id>`.
   - Keep assessment ids separate.
   - Append review episode marker/context before each review invocation.
   - Update reviewer result attribution and tests.

4. Rework executor identity.
   - Replace timestamp executor session ids with `executor:<card_id>`.
   - Align `active_card_run.executor_session_id` with actual session id.
   - Append executor episode marker/context before each executor invocation.
   - Update restart/reactivation tests.

5. Normalize planner path.
   - Route planner session creation through the same helper.
   - Add planner episode marker only if it is low-risk and useful.

6. Archive attached agents on card deletion.
   - Extend existing card archive/delete code to include attached agent session
     manifests and message logs.
   - Cover subtree deletion.

7. Establish compaction guardrails.
   - Make sure new episode markers are preserved or intentionally summarized by
     current compaction paths.
   - Ensure protected system prompt preservation is documented in code comments
     or compaction tests if touched.
   - Do not implement full layered compaction yet.

8. Keep API/UI stable.
   - Existing `/api/agents` should still list sessions.
   - It is acceptable if it shows fewer reviewer/executor sessions because they
     are now reused.
   - Do not redesign Agent tab in this work.

## 19. Test Plan

Add focused tests before broad validation.

Reviewer tests:

- A goal that receives `needs_corrections`, planner correction, and second
  review uses one session id: `reviewer:<goal_id>`.
- The two review attempts have distinct assessment ids.
- The second review request includes prior reviewer conversation or a compaction
  summary of it.
- `result.review.reviewer_session_id` is `reviewer:<goal_id>`.

Executor tests:

- A terminal card execution uses `executor:<card_id>`.
- Restarting/reactivating the same terminal card reuses `executor:<card_id>`.
- Runtime `active_card_run.executor_session_id` matches the actual session id.
- Result attribution remains on the terminal card.

Protocol tests:

- Retained message histories have no orphan tool calls or tool results.
- Terminal tool calls are closed with matching tool results.
- Episode markers do not get sent to providers if they are intended to be
  metadata-only.

Archive tests:

- Deleting a card archives its attached agent manifest and message log.
- Deleting a subtree archives attached agents for descendants.

Compaction-basis tests, only if compaction code is touched:

- Protected system prompts are preserved unchanged.
- Episode markers survive conservative compaction or are summarized only by an
  explicit compaction message.
- Tool-call/tool-result integrity is preserved after truncation.

## 20. Validation Commands

For implementation changes, run focused tests first, then broaden.

Minimum expected validation for a docs-only update to this plan:

```bash
npm run validate:docs
```

Minimum expected validation for code implementing this plan:

```bash
npm run typecheck
npm test -- --runInBand
npm run validate:routine
```

If web/API read models are touched, also run the relevant operator UI/API tests
and `npm run validate:ui-smoke`.

## 21. Implementation Checklist

Use this checklist when implementing.

- [ ] Analyst remains excluded.
- [ ] `planner:<goal_id>` still works.
- [ ] `reviewer:<goal_id>` replaces per-assessment reviewer sessions.
- [ ] `executor:<card_id>` replaces timestamp executor sessions.
- [ ] Agents are lazily allocated.
- [ ] Runtime does not treat agent sessions as done/failed/blocked.
- [ ] Every invocation appends an episode-start marker.
- [ ] Every invocation appends current model-visible runtime context.
- [ ] Terminal tool result ends the episode, not the agent lifetime.
- [ ] Assessment ids remain separate from reviewer session ids.
- [ ] Activation ids remain separate from executor session ids.
- [ ] Card deletion archives attached agent histories.
- [ ] System prompts are not compacted or rewritten.
- [ ] Provider tool-call protocol remains valid.
- [ ] No migration/backward compatibility code is added.
- [ ] Agent tab redesign is not included.
