# Conversation Compaction Design

Status: obsolete planning document. Keep for historical design context only. Current compaction recommendation, drift decisions, and execution order are consolidated in [Remaining Work Consolidated Plan](./remaining-work-consolidated-plan.md). Do not implement compaction from this document directly.

## Context

Saivage now uses one segment-backed conversation substrate for planner, executor, reviewer, and analyst sessions:

```text
.saivage/agents/conversations/<encodeURIComponent(sessionId)>/
  index.json
  seg-001.jsonl
  seg-002.jsonl
```

Current `index.json` contains only:

```json
{
  "schema_version": 1,
  "active_segment": "seg-001.jsonl"
}
```

`LLMActor` keeps the hot provider context in memory as `input.contextMessages`. Segment files are the durable audit transcript and the cold reconstruction source for analyst sessions after restart. There is currently no mechanism to shrink `input.contextMessages`; long conversations can hit provider context limits.

## Goal

When accumulated provider-visible context becomes too large, replace an older prefix with a compact summary while preserving enough evidence for the model, operator UI, and audit trail to remain coherent.

Compaction must never silently drop recent or pending work. If compaction cannot produce a valid bounded summary, the runtime should fail loudly or ask the operator to start a fresh session rather than sending misleading context to the model.

## Non-Goals

- Do not add compatibility readers for old `.saivage/agents/messages` or `.saivage/agents/sessions`.
- Do not introduce a general summarizer framework before the single conversation-compaction use case needs it.
- Do not hide raw historical evidence from operators; old segments remain on disk.
- Do not compact while a tool call is pending unless a later design proves the pending call and its result can be preserved exactly.

## High-Level Shape

When compaction is triggered before a provider call:

1. Select an older provider-visible message prefix for summarization.
2. Preserve a recent verbatim suffix.
3. Ask a model to produce a bounded `context_compaction` summary.
4. Validate that the summary satisfies the compaction contract.
5. Create the next segment file.
6. Write the summary as the first row of the new segment.
7. Atomically update `index.json` to point to the new active segment and record the compaction boundary.
8. Replace the in-memory `input.contextMessages` prefix with the summary plus the preserved suffix.

Old segments stay readable for audit and debugging.

## Required Design Decisions

### Trigger Policy

Specify exact thresholds before implementation:

- byte, approximate-token, or message-count threshold;
- whether the measured input is `input.contextMessages`, the provider payload including tools and system prompt, or both;
- reserved completion budget per role;
- role-specific thresholds for analyst versus card-bound actors;
- whether compaction is disabled for short-lived planner/executor/reviewer activations until a real token-budget failure proves need.

### Compaction Window

Define which rows can be summarized and which must stay verbatim.

Rows that should generally stay verbatim:

- the initial system prompt row is not provider context and should not be summarized into provider messages;
- pending tool calls and any unpaired `tool_call` rows;
- the most recent user/workspace-context turn;
- recent tool calls/results needed for immediate continuation;
- terminal tool calls and model-repair directives from the current activation;
- record/evidence links that the model may still need to act on.

Open question: choose a simple rule such as "compact only complete rounds before the last N rounds" and define N per role.

### Summary Contract

The summary row should use the existing message kind:

```ts
kind: 'context_compaction'
role: 'system'
```

Open questions:

- whether `context_compaction` is provider-visible for all roles through `conversationMessagesForModel()`;
- required summary sections, such as objective, completed actions, open decisions, important files/cards, tool evidence, known failures, and next constraints;
- maximum summary size;
- how to cite source message ids or source segment ranges;
- how to preserve tool-call/result facts without copying huge payloads.

### Index Schema

Current index schema is insufficient. A compaction-capable schema likely needs fields such as:

```ts
{
  schema_version: 2,
  active_segment: 'seg-002.jsonl',
  compaction_generation: 1,
  compacted_through: {
    segment: 'seg-001.jsonl',
    message_id: '...',
    timestamp: '...'
  },
  active_summary_id: '...',
  source_segments: ['seg-001.jsonl']
}
```

Open questions:

- exact schema and validation rules;
- whether every generation records only the latest boundary or a full history;
- whether old `schema_version: 1` indexes are upgraded in place or rejected for compaction until rewritten by the compaction path.

### Atomicity And Restart Safety

Define exact write order. A candidate safe order:

1. Write `seg-002.jsonl.tmp` with the summary row.
2. Atomically rename it to `seg-002.jsonl`.
3. Write `index.json.tmp` pointing to `seg-002.jsonl`.
4. Atomically rename it to `index.json`.
5. Update in-memory `input.contextMessages` only after durable writes succeed.

Tests must simulate restart after each step and verify startup either reads the previous segment or the new segment, never a missing active segment.

### Failure Behavior

Specify behavior for each failure mode:

- summarizer provider unavailable;
- provider admission denied;
- summary output malformed or too large;
- index write fails;
- active segment missing or malformed;
- compaction requested while `LLMActor` is `waiting_tool`;
- compaction would remove all context except a summary.

Default should be fail loud before the provider call, not silently continue with truncated context.

### Provider Selection

Open question: compaction can use the same role model, a dedicated internal model candidate, or a low-cost configured model. The design must specify:

- routing key/config field;
- candidate availability handling;
- whether compaction consumes the same provider admission gate as normal autonomous calls;
- how errors are logged without exposing secrets.

### Reconstruction Rules

Define how readers project compacted histories:

- `readConversationMessages()` should continue returning all segment rows for audit.
- `conversationMessagesForModel()` must decide whether to include old pre-compaction provider-visible rows, only summaries and post-compaction rows, or a reconstruction based on index boundaries.
- Analyst restart reconstruction must not re-expand compacted old rows into provider context.
- Active reconstruction remains primary for interrupted live activations; compaction should not race with active waiting-tool recovery.

### UI Behavior

The UI should render `context_compaction` rows as collapsed compaction clusters with:

- compact summary text;
- source segment/boundary metadata;
- link or raw disclosure to old segment content where safe;
- no hiding of errors, pending tool calls, or mutation evidence.

### Tests Required

Before implementation is complete, add tests for:

- threshold triggers and non-triggers;
- complete-round window selection;
- pending tool calls preventing compaction;
- valid segment rollover and index update;
- restart after each write step;
- malformed index and missing active segment failures;
- summary validation failure;
- `conversationMessagesForModel()` excludes compacted-away old provider rows;
- analyst restart after compaction uses summary plus preserved suffix;
- UI renders `context_compaction` as a bounded cluster;
- raw old segments remain available for audit.

## Relationship To Existing Plans

- [Tool Repair And Agent Conversation Unification Plan](./tool-repair-and-agent-conversation-unification-plan.md) owns the completed Phase 1 segment-backed transcript cutover.
- [Micro-Actor Tool Compliance And Conversation Continuity Plan](./executor-terminal-contract-repair-plan.md) records the original pueblicos terminal-contract repair and now points here for compaction.
- [Agent Conversation UI Redesign](./agent-conversation-ui-redesign.md) defines the eventual UI behavior for compaction clusters.
