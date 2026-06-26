# Agent Tool Surfaces And Information Flow Design

Status: proposed.

## Problem

The micro-actor runtime uses inline one-liner system prompts and offers only a tiny subset of the tools that the tool catalog already defines for each role. This causes three failures:

1. **Planner cannot create cards.** The planner's only non-terminal tool is `activate_card`. When a goal needs decomposition, the planner has no tool to create child cards. It returns `continue`, which the runtime translates to `blocked` with `blocker_cause: 'non_actionable_continue'`.

2. **Executor cannot edit files.** The executor's only non-terminal tools are `run_process`, `wait_process`, `inspect_process`, `kill_process`. It can run shell commands (including `bash -lc`), but the tool catalog already defines proper file tools (`read`, `write`, `edit`, `apply_patch`, `glob`, `grep`) for the executor role. The process-only surface forces the executor to work through shell one-liners.

3. **Reviewer cannot inspect work.** The reviewer's only tool is `emit_reviewer_result`. It gets `contextMessages: []` and no descendant card summaries. It cannot read cards, list children, inspect files, or evaluate evidence. It can only emit pass/fail based on the goal description alone.

Additionally, the rich system prompt builders (`buildPlannerPrompt`, `buildExecutorPrompt`, `buildReviewerPrompt`) in `src/agents/prompts/system-prompt.ts` are well-designed and generic, but are never called by the live actor runtime — only tests import them.

## Tool Catalog vs Actor Runtime

The codebase has two parallel tool/prompt systems:

| | Tool catalog (`src/tools/definitions/`) | Actor runtime (`src/runtime/actors/`) |
|---|---|---|
| Planner tools | 28 tools with `roles.includes('planner')` | `activate_card` only |
| Executor tools | 16 tools with `roles.includes('executor')` | `run_process`, `wait_process`, `inspect_process`, `kill_process` |
| Reviewer tools | 10 tools with `roles.includes('reviewer')` | none (terminal only) |
| System prompts | `buildPlannerPrompt`/`buildExecutorPrompt`/`buildReviewerPrompt` | inline one-liners |

The tool catalog already has correct role assignments and restricted planner variants (`plannerInput` for `create_card`, `edit_card`, etc.). The design is to wire the catalog into the actor runtime, not to redefine tools.

## Tool Surface Analysis

### Planner

The planner is a goal coordinator. It decomposes goals into child cards, activates children, recovers failures, and reports terminal goal outcomes.

**Required non-terminal tools:**

| Tool | Purpose | Handled by |
|---|---|---|
| `create_card` | Create immediate child cards under the current goal | `PlannerControlExecutor` or store directly |
| `edit_card` | Update child card description/acceptance/title as understanding evolves | `PlannerControlExecutor` or store directly |
| `activate_card` | Activate an immediate child card for execution | Already handled in actor runtime |
| `cancel_card` | Cancel obsolete/duplicate/mis-scoped children | `PlannerControlExecutor` or store directly |
| `delete_card` | Delete cancelled or erroneous children | `PlannerControlExecutor` or store directly |
| `restart_card` | Restart a failed/blocked child from clean state | `PlannerControlExecutor` or store directly |
| `read` | Read project files to understand context for decomposition | workspace tool executor |
| `glob` | Find files in the project | workspace tool executor |
| `grep` | Search file contents | workspace tool executor |
| `list_card_history` | Inspect child card history for recovery decisions | workspace tool executor |
| `get_card_history_entry` | Read a specific card version | workspace tool executor |
| `diff_card` | Compare card versions | workspace tool executor |
| `websearch` | Research context for decomposition | web tool executor |
| `webfetch` | Fetch web resources | web tool executor |

**Excluded (deliberate):**
- `write`, `edit`, `apply_patch` — the planner coordinates, it does not write code. That is executor work.
- `run_project_command`, `start_and_wait`, `wait_for_process`, `kill_process` — process execution is executor work.
- `reorder_child` — low value; position is managed by the store.
- `queue_notification` — useful but not blocking; can be added later if cross-session communication is needed.
- `list_cards`, `get_card`, `get_tree` — the planner state context message already provides the current subtree state. If the planner needs to re-read a card after a tool result, `read` + the state context message are sufficient. Adding `get_card` is optional but low-cost.
- `skill`, `mcp_tool_call` — the planner does not need skill loading or MCP tools.

**Terminal tools (contract):**
- `emit_planner_result` — already wired.

### Executor

The executor performs terminal card work: writing code, running tests, scaffolding files, executing commands.

**Required non-terminal tools:**

| Tool | Purpose | Handled by |
|---|---|---|
| `read` | Read project files | workspace tool executor |
| `write` | Write new files | workspace tool executor |
| `glob` | Find files | workspace tool executor |
| `grep` | Search file contents | workspace tool executor |
| `edit` | Edit existing files | workspace tool executor |
| `apply_patch` | Apply structured patches | workspace tool executor |
| `run_project_command` | Run build/test/lint commands | workspace tool executor |
| `start_and_wait` | Start a process and wait for output | workspace tool executor |
| `wait_for_process` | Wait for a previously started process | workspace tool executor |
| `kill_process` | Kill a previously started process | workspace tool executor |
| `list_card_history` | Inspect card history | workspace tool executor |
| `get_card_history_entry` | Read a specific card version | workspace tool executor |
| `diff_card` | Compare card versions | workspace tool executor |
| `websearch` | Research implementation approaches | web tool executor |
| `webfetch` | Fetch documentation/resources | web tool executor |
| `skill` | Load project-specific skills | skill tool executor |
| `mcp_tool_call` | Call MCP tools (e.g. Playwright) | MCP wrapper |

**Excluded (deliberate):**
- `run_process`, `inspect_process` — the catalog's `start_and_wait` + `wait_for_process` cover this. The actor runtime's local process tools are a simpler subset that can be replaced by the catalog equivalents. However, this requires the workspace tool executors to be wired into the actor runtime, which needs a `ToolContext`.
- Card mutation tools (`create_card`, `edit_card`, etc.) — executors do not manage the card tree.

**Terminal tools (contract):**
- `emit_executor_result` — already wired.

### Reviewer

The reviewer evaluates whether a goal's acceptance criteria are met by inspecting completed descendant work.

**Required non-terminal tools:**

| Tool | Purpose | Handled by |
|---|---|---|
| `read` | Read project files to verify work | workspace tool executor |
| `glob` | Find files | workspace tool executor |
| `grep` | Search file contents | workspace tool executor |
| `list_card_history` | Inspect card history | workspace tool executor |
| `get_card_history_entry` | Read a specific card version | workspace tool executor |
| `diff_card` | Compare card versions | workspace tool executor |
| `websearch` | Research standards/context | web tool executor |
| `webfetch` | Fetch documentation | web tool executor |
| `skill` | Load project-specific skills | skill tool executor |
| `mcp_tool_call` | Call MCP tools for verification | MCP wrapper |

**Excluded (deliberate):**
- `write`, `edit`, `apply_patch` — the reviewer evaluates, it does not modify.
- `run_project_command`, `start_and_wait`, `wait_for_process`, `kill_process` — the reviewer should not execute work. If it needs to run verification commands, that is executor work that should have been done by the executor.
- `get_card`, `list_cards`, `get_tree` — the reviewer needs descendant card summaries, but these should be provided as context messages, not as tools. The reviewer's job is to evaluate, not to navigate the card tree. If it needs to inspect a specific card's result, `read` + `diff_card` are sufficient because card results are persisted in the card store and can be read via the workspace file tools or through a compact summary in context.

Actually, rethinking: the reviewer DOES need to inspect card results. The card store is not a file — `read` can't read card records. The reviewer needs either `get_card` or the descendant summaries must be in context. The simplest correct design is to put descendant summaries in `contextMessages`, so the reviewer does not need card-inspection tools.

**Terminal tools (contract):**
- `emit_reviewer_result` — already wired.

## Information Flow Analysis

### Parent → Child (via cards)

The primary information channel from parent to child is the **card record itself**:

| Card field | What carries | Currently provided? |
|---|---|---|
| `title` | Short task description | Yes |
| `description` | Full task instructions, context, intent | Yes |
| `acceptance` | Acceptance criteria | Yes |
| `type` | Card type (code/test/doc/data/research/architecture/ops) | Yes |
| `depends_on` | Dependencies on sibling cards | Yes |
| `tags` | Optional tags | Yes |
| `priority` | Priority | Yes |
| `urgency` | Urgency | Yes |

**What is sufficient:** The card's `description` and `acceptance` should carry all project context the child needs. The parent planner is responsible for writing a description that gives the child enough context to work independently. If the child needs to read project files, it should use `read`/`glob`/`grep` tools — not rely on the parent to inline project content in the description.

**What is currently missing:** Nothing structurally. The gap is that the planner cannot create cards (missing `create_card` tool), not that the information channel is broken.

### Child → Parent (via card results and tool results)

The primary information channel from child to parent is the **`activate_card` tool result** plus the **card lifecycle result**:

#### `activate_card` tool result (in-line, in the planner LLM conversation)

```
{
  success: boolean,
  card_id: string,
  outcome: 'done' | 'failed' | 'blocked' | 'cancelled',
  summary: string,
  result: DoneResult | FailureResult | BlockedResult | null
}
```

This is already returned by `PlanningCardProcessorActor.handleToolCall` (line 128). The `summary` is the child's self-reported summary. The `result` is the full lifecycle result record (e.g. `executor_success` with `executor`, `generated_files`, `verified_at`, `warnings`; or `planner_blocked` with `blocked_reason`, `resume_reason`).

**This is sufficient for the planner to decide next steps** — it knows the child's outcome, summary, and detailed result.

#### Card `lifecycle.result` (persisted, readable via `get_card` or store)

| Lifecycle result kind | Key fields |
|---|---|
| `executor_success` | `executor` (result record), `generated_files`, `verified_at`, `warnings` |
| `executor_failure` | `error`, `partial_result` |
| `planner_done` | `summary` |
| `planner_blocked` | `blocked_reason`, `resume_reason`, `blocker_cause` |
| `planner_failure` | `error` |
| `reviewer_pass` | `planning`, `review_summary`, `assessment_id` |

#### Card `status_text` and `latest_self_report`

`status_text` is the agent's last status string. `latest_self_report` is the structured self-report payload. Both are persisted on the card and readable by the parent.

#### Card `artifacts` and `attachments`

Evidence registered by executors via `appendEvidenceRefs`. Persisted on the card. Readable by the reviewer.

**What is currently working:**
- The `activate_card` tool result gives the parent planner a good summary of the child's outcome.
- The card lifecycle result is persisted and contains the full result record.

**What is currently missing:**
- The planner cannot re-read a child card's state after activation (no `get_card` tool). But the tool result from `activate_card` is sufficient if the planner acts on it immediately — it doesn't need to re-read later because it gets the full result inline.
- The reviewer gets NO descendant information at all.

### Reviewer context (special case)

The reviewer is invoked by the parent planner after the planner reports `done`. The reviewer must evaluate whether the goal's acceptance criteria are met by examining the completed work.

**What the reviewer needs:**
1. Goal card: id, title, description, acceptance — currently in system prompt.
2. Descendant card summaries: for each descendant, the `id`, `type`, `title`, `status`, `status_text`, `result.kind`, `result.summary` or `result.error`, `generated_files` — **currently NOT provided**.
3. Evidence: artifacts and attachments on descendant cards — currently NOT provided.
4. Read-only tools to verify work: `read`, `glob`, `grep` — currently NOT provided.

**Design: provide descendant summaries as a context message** (similar to `buildPlannerStateContextMessage`), plus read-only workspace tools.

The descendant summary message should include, for each descendant of the goal card:
- `id`, `type`, `title`, `status`
- `status_text`
- `result.kind` (e.g. `executor_success`, `planner_done`, `planner_blocked`)
- `result.summary` or `result.error` (the key human-readable outcome)
- `result.generated_files` (for executor results)
- `lifecycle.completed_at`

This gives the reviewer enough to cite `evidence_card_ids` and `issues[].evidence_card_id` without needing card-inspection tools. The reviewer can then use `read`/`glob`/`grep` to verify file-based evidence.

## System Prompt Design

The existing `buildPlannerPrompt`, `buildExecutorPrompt`, and `buildReviewerPrompt` in `src/agents/prompts/system-prompt.ts` are well-designed, generic, and include:
- Role definition and behavioral guidelines
- Tool surface description (card management, workspace, etc.)
- Contract description (terminal tools)
- Recovery and blockage rules

These should replace the inline one-liners in the actor runtime.

### Prompt assembly per agent

**Planner system prompt:**
```
buildPlannerPrompt(contract, skills, currentDepth, maxDepth)
  → SAIVAGE_INTRO
  → Role definition, responsibilities, behavioral guidelines
  → Tool and state rules (card management, activate_card, cancellation)
  → Contract description (emit_planner_result)
  → Skills (if any)
```

Plus a **goal context message** in `contextMessages`:
```
Plan and coordinate card ${card.id}: ${card.title}

${card.description}

Acceptance:
${card.acceptance}
```

Plus the **planner state context message** (already built by `buildPlannerStateContextMessage`):
```
## Current Planner State (compacted turn)
{ goal, direct_children, runtime, candidate_next_action }
```

**Executor system prompt:**
```
buildExecutorPrompt(contract, cardType, skills)
  → SAIVAGE_INTRO
  → Role definition, responsibilities, constraints
  → Contract description (emit_executor_result)
  → Card type guidance (code/test/doc/data/research/architecture/ops)
  → Skills (if any)
```

Plus a **card context message** in `contextMessages`:
```
Execute terminal card ${card.id}: ${card.title}

${card.description}

Acceptance:
${card.acceptance}

Card type: ${card.type}
Parent goal: ${caller.cardId}
```

**Reviewer system prompt:**
```
buildReviewerPrompt(contract, skills)
  → SAIVAGE_INTRO
  → Role definition, responsibilities
  → Contract description (emit_reviewer_result)
  → Skills (if any)
```

Plus a **goal context message** and **descendant summary message** in `contextMessages`:
```
Review goal card ${card.id}: ${card.title}

${card.description}

Acceptance:
${card.acceptance}

Assessment id: ${assessmentId}
```

Plus:
```
## Descendant Card Summaries
[ { id, type, title, status, status_text, result_kind, result_summary, generated_files } ]
```

## Implementation Design

### Step 1: Wire Rich System Prompts

Replace inline one-liners with calls to `buildPlannerPrompt`/`buildExecutorPrompt`/`buildReviewerPrompt`.

**Files:**
- `src/runtime/actors/planning-card-processor-actor.ts` — `plannerPrompt(card)` and `reviewerPrompt(card, assessmentId)`
- `src/runtime/actors/terminal-card-processor-actor.ts` — executor system prompt in `buildLlmInput`

**Planner prompt change:**
```typescript
private plannerPrompt(card: CardRecord): string {
  return buildPlannerPrompt(createPlannerContract());
}
```

The goal-specific context (id, title, description, acceptance) moves to `contextMessages` as a user message, so the system prompt stays generic and reusable.

**Executor prompt change:**
```typescript
private buildSystemPrompt(input: CardActivationInput): string {
  return buildExecutorPrompt(createExecutorContract(), input.card.type);
}
```

The card-specific context (id, title, description, acceptance) moves to `contextMessages`.

**Reviewer prompt change:**
```typescript
private reviewerPrompt(card: CardRecord, assessmentId: string): string {
  return buildReviewerPrompt(createReviewerContract());
}
```

The goal context and assessment id move to `contextMessages`.

### Step 2: Add Planner Card Management Tools

Add `create_card`, `edit_card`, `cancel_card`, `delete_card`, `restart_card` to the planner's tool surface and handle them in `handleToolCall`.

**Tool definitions:** Use the planner variants from `src/tools/definitions/index.ts`. These already have restricted `plannerInput` schemas (e.g. `create_card` omits `parent` and restricts `type` to non-project types).

**Handling:** The planner's `handleToolCall` currently only handles `activate_card`. Add handlers for the planner control tools. The simplest approach is to delegate to the card store directly (the `CardActorStorePort` already has `read`, `setStatus`, `commitTerminalLifecyclePatch`). But `create`, `update`, `delete`, `restart` need more store operations than `CardActorStorePort` currently exposes.

**Store port expansion:** Expand `CardActorStorePort` to include `create`, `update`, `delete` operations, or create a `PlannerControlPort` that wraps the full `CardStore` and is passed to the planner actor.

The cleaner design: create a `PlannerToolPort` interface that the planner actor uses for card mutations:

```typescript
export interface PlannerToolPort {
  createChild(parentId: string, input: NewCardInput): CardRecord;
  updateCard(cardId: string, changes: Partial<CardRecord>): CardRecord;
  deleteCard(cardId: string): void;
  cancelCard(cardId: string, reason: string): CardRecord;
  restartCard(cardId: string): CardRecord;
  readCard(cardId: string): CardRecord | null;
  listChildren(cardId: string): string[];
}
```

The runtime supervisor implements this port using `CardStore`. The planner actor's `handleToolCall` delegates to it.

**Validation rules (enforced in the handler):**
- `create_card`: `parent` must equal the current goal card id. `type` must not be `project`. Depth must not exceed max depth.
- `edit_card`: target must be an immediate child of the current goal. Cannot change `parent` or `type`.
- `cancel_card`/`delete_card`/`restart_card`: target must be an immediate child.
- `activate_card`: already enforced (immediate child only).

### Step 3: Add Workspace Tools To Executor

Wire the catalog's executor-role workspace tools (`read`, `write`, `glob`, `grep`, `edit`, `apply_patch`, `run_project_command`, `start_and_wait`, `wait_for_process`, `kill_process`) into the terminal processor's tool surface.

**Tool definitions:** Use `AGENT_TOOL_DEFINITIONS` from `src/tools/definitions/index.ts`, filtered for `roles.includes('executor')` and `!plannerControl && !skill && !mcpWrapper`. Keep the existing actor-local process tools (`run_process`, `wait_process`, `inspect_process`, `kill_process`) as the process management surface, since they use the local `ProcessActor` map. The catalog's `start_and_wait`/`run_project_command` can be added as alternatives or replacements.

**Tool context:** The workspace tools need a `ToolContext` with `projectRoot`, `cardStore`, `cardId`, `processRegistry`, etc. The terminal processor already has `projectRoot` and `processes`. Build a `ToolContext` adapter that maps the actor's local state to the catalog's expected context.

**Handling:** The terminal processor's `handleToolCall` currently handles only process tools. Add a delegation path for workspace tools: look up the tool by name in `AGENT_TOOL_DEFINITIONS`, call its `executor` with the `ToolContext`, and return the result.

### Step 4: Add Reviewer Context And Tools

**Descendant summary message:** Add a `buildReviewerDescendantSummaryMessage` function that walks the goal card's descendants and produces a compact JSON summary of each descendant's id, type, title, status, status_text, result kind, result summary/error, and generated_files.

Add this message to `contextMessages` in `buildReviewerLlmInput`.

**Reviewer tools:** Add read-only workspace tools (`read`, `glob`, `grep`, `list_card_history`, `get_card_history_entry`, `diff_card`, `websearch`, `webfetch`, `skill`, `mcp_tool_call`) to the reviewer's tool surface. Handle them by delegation to the catalog's tool executors, same as the executor.

### Step 5: Add Planner Read-Only Workspace Tools

Add `read`, `glob`, `grep`, `websearch`, `webfetch`, `list_card_history`, `get_card_history_entry`, `diff_card` to the planner's tool surface. Handle them by delegation to the catalog's tool executors, using the same `ToolContext` adapter as the executor.

## Tool Context Adapter

The catalog's workspace tools expect a `ToolContext` with:
- `projectRoot`
- `cardStore` (for card-history tools)
- `cardId` (for card-scoped operations)
- `processRegistry` (for process tools)
- `mcpManager` (for MCP tools)
- `skillsProvider` (for skill tools)

The actor runtime has:
- `this.projectRoot`
- `this.store` (card store port)
- `this.cardId`
- `this.processes` (for executor process management)

Create a `ToolContextAdapter` that maps actor runtime state to the catalog's `ToolContext`:

```typescript
function buildToolContext(args: {
  projectRoot: string;
  cardStore: CardActorStorePort;
  cardId: string;
  processes?: Map<string, ProcessActor>;
}): ToolContext {
  return {
    projectRoot: args.projectRoot,
    cardStore: args.cardStore,
    cardId: args.cardId,
    // processRegistry and mcpManager adapters as needed
  };
}
```

## Validation Plan

```bash
npx tsc --noEmit
NODE_OPTIONS=--experimental-vm-modules npx jest tests/runtime/actors --runInBand --forceExit
NODE_OPTIONS=--experimental-vm-modules npx jest tests/agents --runInBand --forceExit
npm run build
npm run validate:docs
```

Live GetRich v2 validation:
1. Build Saivage v3.
2. Reset GetRich v2 preserving SPEC/PLAN/config/auth.
3. Restart `saivage-v3-getrich.service`.
4. Run full project-start E2E.
5. Confirm:
   - Planner creates child cards (not just activates existing ones).
   - Executor uses file tools (not only `run_process` via shell).
   - Reviewer sees descendant summaries and can cite evidence card IDs.
   - Runtime advances past G1 scaffold into further decomposition.