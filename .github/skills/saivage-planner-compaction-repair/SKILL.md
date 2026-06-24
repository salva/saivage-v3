---
name: saivage-planner-compaction-repair
description: Use when implementing or diagnosing Saivage v3 planner session compaction, duplicate created_cards, planner-result idempotence, planner resume metadata, or GetRich v2 duplicate card repair.
---

# Saivage Planner Compaction Repair

Use this skill when working on Saivage v3 planner-session memory, planner
`created_cards` idempotence, duplicate card cleanup, planner resume metadata, or
the GetRich v2 duplicate-card incident observed on 2026-06-04.

This is an internal workspace implementation note. Do not put this material into
Saivage v3 product docs unless the user explicitly asks for product-facing
documentation.

## Issue Summary

The GetRich v2 Saivage v3 deployment showed repeated direct children under
`goal-2` (`G1.1 Define the common experiment and validation standard`). The
planner repeatedly emitted terminal planner results containing the same
`created_cards` definitions. The runtime applied the repeated entries as new
cards because they omitted explicit ids and planner-result application deduped
only by explicit id.

Two bugs interacted:

- `PlannerResultApplier` treated `created_cards` as create commands, not
  desired-state declarations.
- Planner history compaction preserved token safety but did not preserve enough
  structured planner memory to prevent repeating already-created work.

Immediate fix priority: make planner-result card creation idempotent by semantic
identity. Broader fix priority: replace weak planner transcript compaction with
durable structured planner memory derived from authoritative card/runtime state.

## Observed GetRich v2 State

Direct children under `goal-2` had six repeated triplets:

| Triplet | Architecture card | Doc card | Code card |
| --- | --- | --- | --- |
| 1 | `architecture-1` done | `doc-1` done | `code-1` backlog |
| 2 | `architecture-2` cancelled | `doc-2` cancelled | `code-2` cancelled |
| 3 | `architecture-3` cancelled | `doc-3` backlog | `code-3` backlog |
| 4 | `architecture-4` backlog | `doc-4` backlog | `code-4` backlog |
| 5 | `architecture-5` backlog | `doc-5` backlog | `code-5` backlog |
| 6 | `architecture-6` backlog | `doc-6` backlog | `code-6` backlog |

Repeated titles:

- `Design experiment standard structure`
- `Write docs/EXPERIMENT_STANDARD.md`
- `Write schemas/experiment_config.schema.json`

Runtime ledger showed only the first architecture and doc cards were activated
and completed:

- `architecture-1`: activated `2026-06-04T14:55:49.951Z`, completed
  `2026-06-04T14:59:33.234Z`.
- `doc-1`: activated `2026-06-04T15:10:02.650Z`, completed
  `2026-06-04T15:14:11.211Z`.

Conclusion: duplicates were not from repeated runtime dispatch of the same card;
they were from repeated sibling card creation by the planner/result applier.

## Timeline Evidence

The `planner:goal-2` message log had 138 persisted messages. Initial correct
decomposition was through direct planner tools:

- `14:55:38`: `create_card` created `architecture-1`.
- `14:55:44`: `create_card` created `doc-1`.
- `14:55:48`: `create_card` created `code-1`.
- `14:55:49`: `activate_card` activated `architecture-1`.

After `architecture-1` completed, planner terminal results repeated the same
child work:

- `15:01:16`: `emit_planner_result` with `created_cards` serialized as a string.
- `15:02:01`: same schema-invalid shape.
- `15:03:07`: same schema-invalid shape.
- `15:03:36`: schema-valid `created_cards` array with same three child definitions.
- `15:03:51`: another schema-valid array with same three definitions.

After `doc-1` completed, pattern repeated:

- `15:15:31`: schema-invalid repeated `created_cards` string.
- `15:16:59`: schema-valid repeated `created_cards` array.
- `15:19:55`: schema-valid repeated `created_cards` array.
- `15:22:24`: schema-valid repeated `created_cards` array.
- `15:25:16`: schema-valid repeated `created_cards` array.

Schema-invalid turns were rejected by contract repair. Schema-valid turns were
applied and created duplicates.

Runtime errors also appeared around terminal completion:

- `state_machine_invariant I2 violated (architecture-1)` at
  `2026-06-04T14:59:35.594Z`.
- `state_machine_invariant I2 violated (doc-1)` at
  `2026-06-04T15:14:15.714Z`.

Those invariant errors were not the direct duplicate-card cause, but they are a
signal that runtime lifecycle state had degraded while duplicate planning
continued.

## Session Context Evidence

The persisted `planner:goal-2` message file remained continuous, but session
metadata was overwritten:

- Current `planner:goal-2.started_at`: `2026-06-04T15:25:17.906Z`.
- Original planner activity began around `2026-06-04T14:55:23Z`.

The `planner:goal-2` LLM exchange file had 60 attempts. Before `15:25:17`,
attempts had growing contexts, for example:

- attempt 7: 16 messages
- attempt 13: 31 messages
- attempt 23: 54 messages
- attempt 33: 83 messages

After `15:25:17`, attempts generally had only 2 messages. The model was no
longer seeing the persisted detailed transcript. It saw the system prompt plus a
small compacted/regenerated context. The live service still exposed old planner
tool schema/prompt details, including `create_card` with `parent` and
`move_card`, because current direct-child/no-move changes had not been restarted
into the deployment.

Implications:

- Planner could repeat `created_cards` while transcript was still visible.
- Once context was compacted, it lacked a direct-child table and do-not-repeat
  memory, making initial decomposition repetition likely.

## Code-Level Root Causes

### Planner Result Application

File: `src/runtime/phases/planner-result-applier.ts`

Problem pattern:

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

This dedupes only by explicit `id`. For idless planner result cards,
`cardDef.id ?? ''` becomes `''`, `read('')` returns nothing, and a new generated
card is created every time.

### Planner History Compaction

File: `src/agents/agent-adapter.ts`

Problem pattern:

```ts
if (estimateMessageTokens(messages) < PLANNER_HISTORY_CONTEXT_LIMIT_TOKENS) {
  return messages;
}
return [buildPlannerHistoryCompactionMessage(sessionId, messages)];
```

The fallback message says persisted history was too large and the system prompt
has authoritative goal context. That is too weak. It does not preserve:

- direct children already created
- cards already completed
- cards already cancelled as duplicates
- outstanding activations
- planner decisions already made
- next intended action
- explicit do-not-repeat constraints

### Session Metadata

File: `src/runtime/session-persistence.ts`

`createSession()` writes a fresh `AgentSession` to the deterministic
`planner:<goalId>` path, including new `started_at`. This makes a resumed
planner session look newly started even when message logs persisted.

## Design Goals

- Compacted planner turns continue from current work state, not original goal
  text.
- Planner-result `created_cards` application is idempotent even when ids are
  omitted.
- Card tree remains authoritative work-state source.
- Runtime runs/activations remain authoritative execution-state source.
- Compaction memory preserves decisions and next action, not raw transcript
  prose.
- Planner sessions distinguish first start, resume, and compaction.
- Planner is explicitly forbidden from recreating existing direct children.

## Non-Goals

- Do not preserve full conversation history indefinitely in model context.
- Do not let compacted memory override card/runtime state.
- Do not introduce cross-subtree planner authority.
- Do not reintroduce planner reparenting or broad parent arguments.
- Do not rely on model self-discipline alone for duplicate prevention.

## Proposed Durable Planner Compaction

Store latest compaction plus history per planner session:

```text
.saivage/agents/compactions/<session-id>.json
.saivage/agents/compactions/history/<session-id>.jsonl
```

Suggested shape:

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

Build the record from authoritative state first. Transcript analysis is
secondary and optional.

## Context Source Policy

Planner compaction is not ordinary chat summarization. The compacted story must
be assembled from multiple context sources with explicit source-specific policy.
Each source needs code that decides whether it is always included, conditionally
included, summarized, referenced by id/path only, or excluded.

The key rule: durable task authority is not compacted away. Volatile transcript
detail can be compacted, but the active agent contract and current card contract
must always be present in full or in an equivalent canonical rendering.

Recommended source policy:

| Source | Include Policy | Rationale |
| --- | --- | --- |
| Agent system prompt | Always include | Defines role, tool contract, safety, and output rules for the current agent. Do not summarize it into weaker prose. |
| Active card content | Always include | Defines the current job. Include title, description/instructions, acceptance criteria, dependencies, parent/child scope, and current lifecycle. |
| Current direct child table | Always include for planners | This is the authoritative local work state and prevents duplicate decomposition. |
| Runtime ledger slice | Always include as concise facts | Include active run, outstanding activation, recent terminal outcomes, stale/open run warnings, and runtime intent/status mismatches. |
| Tool schemas/policies | Always include through the normal tool-definition channel | Do not summarize tool schemas into memory if the model call already carries actual tool definitions. The compaction should instead note important constraints such as direct-child-only authority. |
| Skills | Include only relevant active skills | Skills are large and often irrelevant. Include skills selected by current agent role, current card type/title/body, explicit user/operator request, and tool/task needs. Prefer full skill text for active skills; otherwise include only skill name and why it was not loaded. |
| Workspace/project instructions | Include applicable authority, usually summarized | Include rules that govern the current repo/task, especially safety and validation requirements. Avoid copying broad handoff text unless it materially affects this job. |
| Operator/user recent directives | Always include if current and unresolved | User constraints override stale assumptions. Preserve explicit approvals, prohibitions, and preferences such as no restart, no product-doc design notes, or no backward compatibility. |
| Recent transcript tail | Include conditionally | Keep recent tool results and immediate back-and-forth when token budget allows. It is evidence, not authority. |
| Old transcript body | Summarize or drop | Convert into decisions, completed work, blocked work, and do-not-repeat facts. Do not preserve raw old messages by default. |
| Files read during work | Include conditionally as references plus findings | Include path, relevant facts, and whether the file is authoritative. Do not paste full files unless the active card requires exact text. |
| Skills not relevant now | Exclude | Irrelevant skills increase distraction and can pollute planning. |
| Secrets/provider config | Exclude values; include only operational facts | Preserve facts like provider route availability or auth failure class. Never include secret values in compacted memory. |

This implies a dedicated compaction source assembler, not one generic
`summarize(messages)` function. Suggested structure:

```ts
export interface PlannerContextSourceDecision {
  source: 'system_prompt' | 'active_card' | 'direct_children' | 'runtime_ledger' |
    'tool_contract' | 'skill' | 'workspace_instruction' | 'user_directive' |
    'transcript_tail' | 'transcript_summary' | 'file_evidence';
  id: string;
  policy: 'include_full' | 'include_rendered' | 'include_summary' |
    'include_reference' | 'exclude';
  reason: string;
  token_budget: number | null;
}
```

The planner compaction builder should emit both the rendered compacted context
and an audit list of `PlannerContextSourceDecision` records. That audit is useful
for debugging why a skill, instruction file, or transcript fragment was or was
not included.

### Skill Selection Policy

Skills should be selected for compaction using deterministic gates before any
LLM-assisted ranking:

1. Include a skill if the current card title/body explicitly mentions its trigger
   keywords, target files, or workflow.
2. Include a skill if the current agent role requires it for validation or live
   operations, such as Saivage development validation after TypeScript/runtime
   changes.
3. Include a skill if the operator explicitly asked to use it or the current
   session already loaded it for this job.
4. Exclude skills whose scope is adjacent but not active. For example, LXC
   operations should not enter a pure local code-design planner turn unless live
   service inspection/restart is part of the active card.
5. If multiple skills match and token budget is tight, include the most specific
   skill in full and include short references for broader background skills.

The compaction record should store selected skills separately from transcript
memory:

```ts
export interface PlannerCompactionSkillContext {
  name: string;
  source_path: string | null;
  inclusion: 'full' | 'summary' | 'reference';
  reason: string;
  rendered_tokens_estimate: number;
}
```

### System Prompt And Card Contract Policy

The active agent system prompt and current card contract are baseline inputs, not
history. They should be rendered fresh for every planner call, compacted or not.
If token pressure is severe, reduce optional context first in this order:

1. old transcript body
2. non-authoritative file evidence
3. broad workspace background
4. non-active skill summaries
5. recent transcript tail

Do not drop the system prompt, active card instructions, direct-child table, or
runtime activation facts. If those cannot fit, fail closed with a context-budget
diagnostic instead of sending an under-specified planner turn.

## Authoritative State Builder

Implement `buildPlannerCompactionRecord(input)` that reads:

- goal card
- direct child cards
- runtime runs
- runtime activations
- session messages
- recent event/error summaries

Derived fields:

- `direct_children`: every immediate child sorted by position.
- `completed_work`: terminal success/done direct children.
- `pending_work`: backlog/active/running/changed direct children.
- `blocked_or_failed_work`: blocked/failed/needs_verification children.
- `duplicate_or_cancelled_cards`: title/type groups sharing normalized title
  and type, plus cancelled duplicates.
- `outstanding_activation`: unresolved activation for this goal.
- `next_action`: deterministic recommendation from current state.
- `do_not_repeat`: existing titles and duplicate-group titles.

Do not ask the LLM to summarize authoritative facts. An optional LLM-aided
decision summary may add non-authoritative decision notes only.

## Planner Context Injection

Replace the weak diagnostic fallback with structured compacted memory. A
compacted planner turn should receive:

1. Current system prompt.
2. Current goal context block.
3. Compacted planner memory block.
4. Small recent message tail if token budget allows.

Example injected block:

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

## Idempotent Planner Result Application

Change `created_cards` from create-command semantics to desired-state semantics.

Before creating a card without explicit id, look for an existing direct child
under the same goal with matching semantic identity:

- same parent (`goalId`)
- same type
- same normalized title

If found:

- Treat it as already created.
- Optionally apply safe metadata updates if non-conflicting and nonterminal.
- Include/reuse the existing id in result summaries or notes.
- Do not create a duplicate.

If multiple matches exist:

- Prefer non-cancelled/non-failed cards.
- Prefer active/running/backlog over cancelled.
- Prefer earliest created card for stability.
- Emit runtime diagnostic about duplicate semantic children.
- Do not create another duplicate.

If explicit id exists, skip creation as today. If explicit id is new but a
semantic match exists under a different id, reject or suppress with diagnostic;
do not create a duplicate unless a future explicit operator override exists.

## Planner Session Resume Semantics

Change `createSession()` or add `getOrResumeSession()` for deterministic planner
session ids.

Desired metadata:

- `started_at`: first creation time for this deterministic planner session.
- `last_resumed_at`: most recent invocation start.
- `resume_count`: number of resumed invocations.
- `compaction_count`: number of durable compactions applied.
- `last_compacted_at`: latest compaction timestamp.

Do not overwrite `planner:<goalId>` as if it were new when it already exists.

## Runtime Ledger Hygiene

The observed runtime retained open root and child planner runs while global
state was idle. Separate fixes handle active-run status and stale-run
reconciliation, but planner compaction should still include ledger state.

Flag in compaction warnings:

- open planner runs for the same goal
- unresolved activations
- completed activations missing final handoff notes
- global idle/running-intent mismatch

## Implementation Sequence

1. Implement idempotent planner result application first.
2. Add planner compaction schema/types and persistence helpers:
   `readPlannerCompaction`, `writePlannerCompaction`, and history append.
3. Add deterministic compaction builder from card/runtime/session state.
4. Replace `compactPlannerModelMessagesForContext()` generic fallback with
   structured memory injection and optional recent tail.
5. Fix planner session resume metadata.
6. Align planner prompt/tool text so compacted memory is authoritative and
   planner schemas do not expose parent arguments or `move_card`.
7. Repair live GetRich v2 state after validated code lands and restart is
   explicitly approved.

## Focused Tests To Add

- `tests/agents/planner-compaction-builder.test.ts`
- `tests/agents/planner-compaction-store.test.ts`
- `tests/agents/agent-adapter-planner-compaction.test.ts`
- `tests/runtime/planner-result-applier.test.ts`
- `tests/agents/session-persistence.test.ts`

Required cases:

- Compaction includes current direct children.
- Compaction includes explicit do-not-repeat titles.
- Outstanding activation survives compaction.
- Repeated idless `created_cards` creates only one direct child.
- Repeated result after a child is done does not create a replacement.
- Duplicate cancelled card plus active/backlog card prefers non-cancelled.
- Explicit id is honored.
- Semantic collision with a different explicit id is rejected or suppressed.
- Fixed planner session resume preserves original `started_at`.

## Validation Commands

Run from `/home/salva/g/ml/saivage-v3`:

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

## Live Repair Procedure After Code Lands

Only do this after explicit approval to restart/pause the live service.

1. Stop or pause runtime through approved operator path.
2. Back up GetRich v2 `.saivage` state.
3. Preserve legitimate cards:
   `architecture-1`, `doc-1`, `code-1`.
4. Remove or cancel duplicates:
   `architecture-2..6`, `doc-2..6`, `code-2..6`.
5. Rebuild/repair `goal-2` child ordering to only intended direct children.
6. Close stale open root/goal planner runs or let startup reconciliation close
   them under fixed code.
7. Restart service and verify health/readiness and no duplicate recreation.

## Acceptance Criteria

- Compacted planner turns always receive direct-child table for current goal.
- Compacted planner turns always receive explicit `do_not_repeat` list.
- Repeated idless planner `created_cards` do not create duplicates.
- Planner session metadata preserves original `started_at` across resumes.
- Runtime diagnostics record suppressed duplicate create attempts.
- Planner tool surface does not advertise parent arguments or `move_card`.
- GetRich v2 duplicate-card scenario is covered by regression tests.

## Open Questions

- Should semantic duplicate suppression hard-fail or silently reuse?
- Should duplicate suppression create a planner-visible synthetic note mapping
  attempted create to an existing child?
- Should compaction happen only at token threshold or before every planner turn
  as a cheap state refresh?
- Should duplicate backlog cards be automatically cancelled during startup repair
  when they match a canonical done/backlog sibling?
