# Planner Session Compaction And Duplicate-Card Prevention

Date: 2026-06-04

Status: design proposal

Related current authority:

- `docs/agents.md`
- `docs/goal-planning-runtime.md`
- `docs/v3-planner-control-mcp-contract.md`

## Summary

The current planner-session compaction behavior is not a real planner memory
procedure. It can keep requests under the model context limit, but it does not
preserve enough task-specific state for a planner to continue safely after a
long or troubled planning loop. The observed GetRich v2 run shows two connected
failure modes:

1. The planner repeatedly emitted `created_cards` for the same intended child
   work.
2. The runtime applied those `created_cards` as new cards whenever the cards did
   not include explicit ids.

The immediate duplicate-card bug is idempotence failure in planner-result
application. The broader process bug is that compacted planner turns can lose
working memory about already-created, already-activated, already-completed, and
already-cancelled child work.

This document analyzes the observed failure and proposes a durable planner
compaction design that treats the card tree and runtime ledger as authoritative
state, then injects a structured planner memory into future turns.

## Observed Failure

The live GetRich v2 Saivage v3 deployment showed repeated cards under
`goal-2` (`G1.1 Define the common experiment and validation standard`). The
direct child set contained six repeated triplets:

| Triplet | Architecture card | Doc card | Code card |
| --- | --- | --- | --- |
| 1 | `architecture-1` done | `doc-1` done | `code-1` backlog |
| 2 | `architecture-2` cancelled | `doc-2` cancelled | `code-2` cancelled |
| 3 | `architecture-3` cancelled | `doc-3` backlog | `code-3` backlog |
| 4 | `architecture-4` backlog | `doc-4` backlog | `code-4` backlog |
| 5 | `architecture-5` backlog | `doc-5` backlog | `code-5` backlog |
| 6 | `architecture-6` backlog | `doc-6` backlog | `code-6` backlog |

The repeated card titles were effectively identical:

- `Design experiment standard structure`
- `Write docs/EXPERIMENT_STANDARD.md`
- `Write schemas/experiment_config.schema.json`

The runtime ledger did not show those duplicate cards being activated. It showed
only the first architecture and doc cards being activated and completed:

- `architecture-1` activation requested at `2026-06-04T14:55:49.951Z` and
  completed at `2026-06-04T14:59:33.234Z`.
- `doc-1` activation requested at `2026-06-04T15:10:02.650Z` and completed at
  `2026-06-04T15:14:11.211Z`.

That means the duplicates were not caused by the runtime dispatching the same
cards repeatedly. They were caused by the planner creating additional sibling
cards.

## Timeline Evidence

The relevant `planner:goal-2` message log had a continuous persisted transcript
with 138 messages. The first correct decomposition happened through direct
planner tool calls:

- `14:55:38` `create_card` created `architecture-1`.
- `14:55:44` `create_card` created `doc-1`.
- `14:55:48` `create_card` created `code-1`.
- `14:55:49` `activate_card` activated `architecture-1`.

After `architecture-1` completed, the planner repeatedly emitted terminal
planner results containing the same child work in `created_cards`:

- `15:01:16` `emit_planner_result` with `created_cards` serialized as a string.
- `15:02:01` same schema-invalid shape again.
- `15:03:07` same schema-invalid shape again.
- `15:03:36` schema-valid `created_cards` array with the same three child
  definitions.
- `15:03:51` another schema-valid `created_cards` array with the same three
  child definitions.

The schema-invalid turns were rejected by contract repair. The schema-valid
turns were applied by the runtime, producing duplicate cards. Later, after
`doc-1` completed, the same pattern repeated:

- `15:15:31` schema-invalid repeated `created_cards` string.
- `15:16:59` schema-valid repeated `created_cards` array.
- `15:19:55` schema-valid repeated `created_cards` array.
- `15:22:24` schema-valid repeated `created_cards` array.
- `15:25:16` schema-valid repeated `created_cards` array.

The runtime also recorded state-machine invariant errors around terminal child
completion:

- `state_machine_invariant I2 violated (architecture-1)` at
  `2026-06-04T14:59:35.594Z`.
- `state_machine_invariant I2 violated (doc-1)` at
  `2026-06-04T15:14:15.714Z`.

These invariant errors are not the direct duplicate-card cause, but they show
the planner/runtime was already in a degraded lifecycle state while duplicate
planning continued.

## Session Context Evidence

The persisted `planner:goal-2` message file remained continuous, but the session
metadata was overwritten:

- Current `planner:goal-2.started_at`: `2026-06-04T15:25:17.906Z`.
- Original planner work began around `2026-06-04T14:55:23Z`.

The LLM exchange file for `planner:goal-2` had 60 attempts. Before
`15:25:17`, attempts generally included a growing model context. Example
message counts:

- attempt 7: 16 messages
- attempt 13: 31 messages
- attempt 23: 54 messages
- attempt 33: 83 messages

After `15:25:17`, attempts generally included only 2 messages. This means the
model was no longer seeing the persisted detailed transcript. It was seeing the
system prompt plus a small compacted or regenerated context. The exchange also
showed that the service was still exposing the older planner tool schema and
prompt, including `create_card` with a `parent` field and `move_card`, because
the current code changes had not yet been restarted into the deployment.

This matters because the planner had two ways to forget prior work:

1. It could emit repeated `created_cards` even while the transcript was still
   large enough to include previous details.
2. Once the transcript exceeded the memory policy threshold, the model context
   was reduced to a weak compaction message that did not reliably enumerate the
   current child set and did not say which creations were already done,
   cancelled, duplicated, or pending.

## Code-Level Evidence

The direct duplicate-creation behavior is explained by
`src/runtime/phases/planner-result-applier.ts`:

```ts
if (plannerResult.created_cards) {
  for (const cardDef of plannerResult.created_cards) {
    if (this.deps.cardStore.read(cardDef.id ?? '')) continue;
    this.deps.cardStore.create({
      id: cardDef.id,
      type: cardDef.type as CardRecord['type'],
      parent: goalId,
      title: cardDef.title,
      ...
    });
  }
}
```

This only deduplicates by explicit `id`. Planner result cards generally omit
ids, so `cardDef.id ?? ''` becomes `''`, `read('')` returns nothing, and the
runtime creates a new generated card every time.

The compaction behavior is explained by
`compactPlannerModelMessagesForContext()` in `src/agents/agent-adapter.ts`:

```ts
if (estimateMessageTokens(messages) < PLANNER_HISTORY_CONTEXT_LIMIT_TOKENS) {
  return messages;
}
return [buildPlannerHistoryCompactionMessage(sessionId, messages)];
```

The fallback message says that persisted history was too large and that the
current system prompt contains authoritative goal context. That statement is too
weak for planner resumption because it does not persist a structured summary of
planner decisions, existing direct children, prior activations, duplicate
cleanup, current ledger state, or next action.

The session metadata overwrite is explained by `createSession()` in
`src/runtime/session-persistence.ts`. It always writes a new `AgentSession` to
the same planner session path for `planner:<goalId>`, including a fresh
`started_at`. That makes a resumed planner session look newly started even when
its message log persists.

## Root Cause Analysis

### Root Cause 1: Planner Result Application Is Not Idempotent

Planner `created_cards` are treated as commands to create cards, not as desired
state declarations. When the same desired child card appears repeatedly without
an explicit id, the runtime creates a new sibling every time.

The system needs idempotence by semantic identity, at least within a planner's
direct child set. A repeated `created_cards` entry with the same normalized
title and type under the same parent should resolve to the existing card unless
the planner explicitly requests a materially different card and there is no
collision.

### Root Cause 2: Compaction Is Transcript-Safety, Not Planner-Memory

The current compaction approach prevents context overflow but does not preserve
the planner's operational memory. It does not encode:

- direct children already created
- cards already completed
- cards already cancelled as duplicates
- outstanding activations
- planner decisions already made
- next intended action
- explicit do-not-repeat constraints

When a planner receives only a weak compaction diagnostic, it can reasonably
repeat the initial decomposition because the authoritative state is not present
in a concise, planner-specific form.

### Root Cause 3: Session Metadata Is Recreated On Resume

Planner sessions are keyed by deterministic session id (`planner:<goalId>`), but
`createSession()` overwrites session metadata each time an invocation starts.
That is misleading for diagnosis and can mask whether a session is new, resumed,
or compacted. The message log survives, but metadata suggests a fresh session.

### Root Cause 4: Planner Prompt And Tool Surface Were Too Permissive In The
Live Deployment

The live service still advertised old planner tools and schema fields. The
planner saw `create_card(parent, ...)` and `move_card`, so it had broader tree
authority than intended. Separately committed changes now restrict planner card
tools to direct children and remove `move_card`, but those changes were not live
at the time of the observed duplicate creation.

## Design Goals

1. A compacted planner turn must continue from current work state, not from the
   original goal statement.
2. Planner result application must be idempotent even when `created_cards` omit
   ids.
3. The card tree remains the authoritative work-state source.
4. Runtime runs and activations remain the authoritative execution-state source.
5. Planner compaction memory preserves decisions and next action, not raw
   transcript prose.
6. Planner sessions distinguish first start, resume, and compaction in metadata.
7. The planner is explicitly forbidden from recreating existing direct children.

## Non-Goals

1. Do not preserve full conversation history indefinitely in model context.
2. Do not let compacted memory override card/runtime state.
3. Do not introduce cross-subtree planner authority.
4. Do not reintroduce planner reparenting or broad parent arguments.
5. Do not rely on model self-discipline alone for duplicate prevention.

## Proposed Architecture

### 1. Durable Planner Compaction Records

Add a durable compaction record per planner session:

```text
.saivage/agents/compactions/<session-id>.json
.saivage/agents/compactions/history/<session-id>.jsonl
```

The current JSON file contains the latest compacted memory. The JSONL history is
append-only for diagnosis.

Suggested TypeScript shape:

```ts
export interface PlannerCompactionRecord {
  version: 1;
  session_id: string;
  goal_id: string;
  generated_at: string;
  source: {
    first_message_index: number;
    last_message_index: number;
    message_count: number;
    estimated_tokens: number;
    reason: 'context_limit' | 'manual' | 'startup_repair' | 'pre_turn_refresh';
  };
  goal_snapshot: PlannerCompactionGoalSnapshot;
  direct_children: PlannerCompactionChildSnapshot[];
  runtime_snapshot: PlannerCompactionRuntimeSnapshot;
  decisions: PlannerCompactionDecision[];
  completed_work: PlannerCompactionWorkItem[];
  pending_work: PlannerCompactionWorkItem[];
  blocked_or_failed_work: PlannerCompactionWorkItem[];
  duplicate_or_cancelled_cards: PlannerCompactionDuplicate[];
  outstanding_activation: PlannerCompactionActivation | null;
  next_action: PlannerCompactionNextAction;
  do_not_repeat: string[];
  warnings: string[];
}

export interface PlannerCompactionChildSnapshot {
  id: string;
  type: CardRecord['type'];
  title: string;
  normalized_title: string;
  status: CardRecord['status'];
  position: number;
  depends_on: string[];
  created_at: string;
  updated_at: string;
  activated: boolean;
  latest_run_status: string | null;
  terminal_outcome: string | null;
}
```

The record should be generated from authoritative state first, with transcript
analysis as a secondary source.

### 2. Authoritative State Builder

Add `buildPlannerCompactionRecord(input)` that reads:

- goal card
- direct child cards
- runtime runs
- runtime activations
- session messages
- recent event/error summaries

It should not ask the LLM to summarize authoritative facts. It should compute
them deterministically.

Core derived fields:

- `direct_children`: every current immediate child, sorted by position.
- `completed_work`: direct children with terminal success or done state.
- `pending_work`: direct children in backlog/active/running/changed.
- `blocked_or_failed_work`: direct children in blocked/failed/needs_verification.
- `duplicate_or_cancelled_cards`: title/type groups where multiple direct
  children share a normalized title and type, plus cancelled duplicate cards.
- `outstanding_activation`: unresolved activation for this goal, if any.
- `next_action`: deterministic recommendation based on current children and
  activations.
- `do_not_repeat`: generated constraints, including existing titles.

### 3. Optional LLM-Aided Decision Summary

Transcript prose can still be useful for decisions that are not represented in
cards. Add an optional summarizer, but make it non-authoritative. The LLM may
produce candidate `decisions`; the builder validates and stores them separately
from computed state.

If the summarizer fails, compaction still succeeds using deterministic state.

### 4. Planner Context Injection

Replace the current single diagnostic fallback with structured compacted memory.
When a planner session is compacted, the model receives:

1. Current system prompt.
2. Current goal context block.
3. Compacted planner memory block.
4. A small tail of recent messages, if token budget allows.

The injected block should be concise and explicit. Example:

```md
## Compacted Planner Memory

You are resuming planner session planner:goal-2 for goal-2.

Authoritative direct children under this goal:
- architecture-1 [architecture] done: Design experiment standard structure
- doc-1 [doc] done: Write docs/EXPERIMENT_STANDARD.md
- code-1 [code] backlog: Write schemas/experiment_config.schema.json
- architecture-2 [architecture] cancelled duplicate: Design experiment standard structure
- doc-2 [doc] cancelled duplicate: Write docs/EXPERIMENT_STANDARD.md
- code-2 [code] cancelled duplicate: Write schemas/experiment_config.schema.json

Outstanding activation: none.

Do not recreate:
- Design experiment standard structure
- Write docs/EXPERIMENT_STANDARD.md
- Write schemas/experiment_config.schema.json

Next action:
- Continue with existing child code-1. Re-read it and activate it if it still
  needs execution; otherwise report the goal result.

Rules:
- Existing direct children are authoritative.
- If a needed child exists, edit/restart/activate that child; do not create a
  replacement sibling.
- Grandchildren belong to child planners.
```

### 5. Idempotent Planner Result Application

Change `PlannerResultApplier` from create-command semantics to desired-state
semantics for `created_cards`.

Before creating a card without an explicit id, it should look for an existing
direct child under the same goal with matching semantic identity:

- same parent (`goalId`)
- same type
- same normalized title

If found:

- Treat the card as already created.
- Optionally apply safe metadata updates (`description`, `acceptance`,
  `priority`, `tags`, `depends_on`) if they are non-conflicting and the card is
  not terminal.
- Include the existing id in the planner result summary or generated note.
- Do not create a duplicate.

If multiple matches exist:

- Prefer non-cancelled, non-failed cards.
- Prefer active/running/backlog over cancelled.
- Prefer earliest created card for stability.
- Emit a runtime diagnostic about duplicate semantic children.
- Do not create another duplicate.

If an explicit id is provided and the id exists:

- Keep current behavior: skip creation and optionally treat as existing.

If an explicit id is provided and semantic match exists under a different id:

- Reject or convert to existing card with diagnostic. Do not create a duplicate
  unless a future explicit operator-controlled override exists.

### 6. Planner Session Resume Semantics

Change `createSession()` or add `getOrResumeSession()` for deterministic planner
session ids.

Desired metadata behavior:

- `started_at`: first time the deterministic planner session was created.
- `last_resumed_at`: most recent invocation start for that session.
- `resume_count`: number of resumed invocations.
- `compaction_count`: count of durable compactions applied.
- `last_compacted_at`: latest compaction timestamp.

Do not overwrite the session file as if it were new when `planner:<goalId>`
already exists.

### 7. Runtime Ledger Hygiene

The observed runtime retained open root and child planner runs while global
state was idle. Separate fixes already address active-run status and stale-run
reconciliation, but planner compaction should also include ledger state so the
planner does not infer work from stale transcript alone.

The compaction builder should flag:

- open planner runs for the same goal
- unresolved activations
- completed activations missing final handoff notes
- global idle/running-intent mismatch

These should become warnings in the compaction record and diagnostics for the
operator/debug UI.

## Implementation Plan

### Phase 1: Schemas And Persistence

1. Add `PlannerCompactionRecord` schema/types under `src/schemas/`.
2. Add persistence helpers under `src/agents/planner-compaction-store.ts`:
   - `plannerCompactionPath(saivageDir, sessionId)`
   - `readPlannerCompaction(saivageDir, sessionId)`
   - `writePlannerCompaction(saivageDir, record)`
   - `appendPlannerCompactionHistory(saivageDir, record)`
3. Add tests for strict schema validation and history append behavior.

### Phase 2: Deterministic Compaction Builder

1. Add `src/agents/planner-compaction-builder.ts`.
2. Implement normalized title matching:
   - trim
   - lowercase
   - collapse whitespace
   - normalize punctuation that does not affect identity
3. Build `direct_children` from `CardStore.listChildren(goalId)` plus
   `CardStore.read()`.
4. Build activation/run annotations from runtime state.
5. Detect duplicate groups by `(type, normalized_title)` under the goal.
6. Derive `next_action` with deterministic rules:
   - if unresolved activation exists, wait/defer to that activation
   - else if direct child is running/active, continue/inspect it
   - else choose first backlog/changed child whose dependencies are satisfied
   - else if all children are terminal done, report goal done
   - else report blocked with reasons
7. Generate `do_not_repeat` entries for all direct child titles and duplicate
   groups.
8. Add focused unit tests using synthetic card/runtime state.

### Phase 3: Context Injection

1. Replace `buildPlannerHistoryCompactionMessage()` with a builder that writes a
   durable compaction record and returns a model message rendered from that
   record.
2. Keep a bounded recent tail if token budget allows. The tail is useful for
   immediate tool results, but the structured compaction block must come first.
3. Ensure queued notifications are not lost. They should be merged into the
   compaction input or injected separately after compaction.
4. Add tests for `compactPlannerModelMessagesForContext()`:
   - below threshold returns full messages
   - above threshold returns structured compaction plus optional tail
   - compaction includes direct children and do-not-repeat titles
   - outstanding activation is preserved

### Phase 4: Idempotent Planner Result Application

1. Add semantic matching helper:
   - `findExistingDirectChildForPlannerCreate(goalId, cardDef)`
2. Update `PlannerResultApplier.apply()`:
   - explicit id exists: skip
   - no id and semantic match exists: reuse existing, do not create
   - no match: create
   - multiple matches: reuse preferred existing and emit diagnostic
3. Add event/diagnostic emission for duplicate create suppression.
4. Add tests:
   - repeated `created_cards` without ids creates only one child
   - repeated result after child is done does not create a replacement
   - duplicate cancelled card plus active/backlog card prefers non-cancelled
   - explicit id is still honored
   - semantic collision with different explicit id is rejected or suppressed

### Phase 5: Planner Session Resume Metadata

1. Add `getOrResumeSession()` or change planner path in `createSession()`.
2. Preserve `started_at` when deterministic session exists.
3. Add `last_resumed_at`, `resume_count`, `last_compacted_at`, and
   `compaction_count` to session schema.
4. Add migration/strict handling for current session files if needed.
5. Add tests proving planner resume does not overwrite `started_at`.

### Phase 6: Prompt And Tool Surface Alignment

1. Update planner prompt text to describe compacted memory as authoritative
   resume context.
2. Ensure planner tool schemas no longer expose `parent`, `parentId`, or
   `move_card` in the built deployment.
3. Add docs/source parity tests that fail if planner `create_card` advertises a
   parent field again.

### Phase 7: Live Repair Procedure

After code lands and is validated:

1. Stop or pause the live runtime using the approved operator path.
2. Back up the current GetRich v2 `.saivage` state.
3. Preserve legitimate cards:
   - `architecture-1` done
   - `doc-1` done
   - `code-1` backlog
4. Remove or cancel duplicate cards:
   - `architecture-2..6`
   - `doc-2..6`
   - `code-2..6`
5. Rebuild or repair `goal-2` child ordering to contain only the intended
   direct children.
6. Close stale open root/goal planner runs or let startup reconciliation close
   them under the new code.
7. Restart service and verify:
   - health and readiness
   - no duplicate child recreation after several planner turns
   - runtime ledger has no idle/open-running-run contradiction

## Test Plan

Required focused tests:

- `tests/agents/planner-compaction-builder.test.ts`
- `tests/agents/planner-compaction-store.test.ts`
- `tests/agents/agent-adapter-planner-compaction.test.ts`
- `tests/runtime/planner-result-applier.test.ts`
- `tests/agents/session-persistence.test.ts`

Required validation commands:

```bash
NODE_OPTIONS=--experimental-vm-modules npx jest \
  tests/agents/planner-compaction-builder.test.ts \
  tests/agents/planner-compaction-store.test.ts \
  tests/agents/agent-adapter-planner-compaction.test.ts \
  tests/runtime/planner-result-applier.test.ts \
  tests/agents/session-persistence.test.ts \
  --runInBand --forceExit

npm run validate:routine
npm run build
```

## Acceptance Criteria

1. A compacted planner turn always receives a direct-child table for its current
   goal.
2. A compacted planner turn always receives an explicit `do_not_repeat` list.
3. Repeated planner `created_cards` payloads without ids do not create duplicate
   cards under the same goal.
4. Planner session metadata preserves original `started_at` across resumes.
5. Runtime diagnostics record suppressed duplicate create attempts.
6. The planner tool surface no longer advertises parent arguments or `move_card`.
7. The GetRich v2 duplicate-card scenario is covered by regression tests.

## Risks And Tradeoffs

### Semantic Deduplication Can Suppress Intentional Similar Cards

Two legitimate cards can have similar titles and types. The initial design uses
strict normalized title plus type under the same parent, not fuzzy matching. If a
planner needs two similar cards, it must give them distinct titles.

### Compaction Records Can Become Stale

The compaction record must be regenerated before use or rendered together with a
fresh direct-child snapshot. Do not rely on an old compaction record alone.

### LLM-Aided Summaries Can Hallucinate

LLM summaries must never override card/runtime state. They can add human-readable
decision notes only after deterministic state is computed.

### More Context Can Increase Token Use

The direct-child table is intentionally concise. It should list all direct
children but only enough fields for planning continuity.

## Open Questions

1. Should semantic duplicate suppression be hard fail or silent reuse?
2. Should duplicate suppression create a synthetic planner note so the planner
   sees that its attempted create mapped to an existing child?
3. Should compaction happen only at token threshold, or before every planner
   turn as a cheap state refresh?
4. Should duplicate backlog cards be automatically cancelled during startup
   repair when they match a done/backlog canonical sibling?

## Recommended Sequence

1. Implement idempotent planner result application first. This stops new
   duplicate cards even before compaction is perfect.
2. Implement deterministic compaction builder and context injection.
3. Fix planner session resume metadata.
4. Update prompt/tool docs and tests.
5. Repair live GetRich v2 state.
6. Restart the GetRich v2 service with the validated build.
