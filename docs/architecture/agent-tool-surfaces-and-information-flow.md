# Agent Tool Surfaces And Information Flow Design

Status: proposed. **Superseded by [Shared Tool Invocation Design](./shared-tool-invocation-design.md) and [Tool Set Reorganization Design](./tool-set-reorganization-design.md).** This doc predates the provider-owned invocation architecture, the unified terminal tool (`emit_result`), and the lifecycle-result kind collapse. Lifecycle result kinds, fields, terminal tool names, and the `ActorToolSurface` abstraction described below are no longer current. Read for historical context only.

## Problem

The micro-actor runtime uses inline one-liner system prompts and offers only a curated subset of the tools that the tool catalog defines for each role. The first planner-decomposition slice now exposes `create_card` plus processor-owned `activate_card`, but the broader prompt/context gaps remain:

1. **Planner decomposition must stay actor-owned.** The planner can now create/edit immediate children and activate them, but future planner tools must preserve the same ownership boundary instead of delegating to the legacy control executor.

2. **Executor cannot edit files.** The executor's only non-terminal tools are `run_process`, `wait_process`, `inspect_process`, `kill_process`. It can run shell commands (including `bash -lc`), but the tool catalog already defines proper file tools (`read`, `write`, `edit`, `apply_patch`, `glob`, `grep`) for the executor role. The process-only surface forces the executor to work through shell one-liners.

3. **Reviewer cannot inspect work.** The reviewer's only tool is `emit_reviewer_result`. It gets `contextMessages: []` and no descendant card summaries. It cannot read cards, list children, inspect files, or evaluate evidence. It can only emit pass/fail based on the goal brief alone.

Additionally, the rich system prompt builders (`buildPlannerPrompt`, `buildExecutorPrompt`, `buildReviewerPrompt`) in `src/agents/prompts/system-prompt.ts` are well-designed and generic, but are never called by the live actor runtime — only tests import them.

## Tool Catalog vs Actor Runtime

The codebase has two parallel tool/prompt systems:

| | Tool catalog (`src/tools/definitions/`) | Actor runtime (`src/runtime/actors/`) |
|---|---|---|
| Planner tools | 28 tools with `roles.includes('planner')` | `create_card`, processor-owned `activate_card` |
| Executor tools | 16 tools with `roles.includes('executor')` | `run_process`, `wait_process`, `inspect_process`, `kill_process` |
| Reviewer tools | 10 tools with `roles.includes('reviewer')` | none (terminal only) |
| System prompts | `buildPlannerPrompt`/`buildExecutorPrompt`/`buildReviewerPrompt` | inline one-liners |

The tool catalog already has useful schemas and role assignments, including restricted planner variants (`plannerInput` for `create_card`, `edit_card`, etc.). The actor runtime should reuse those schemas when they match actor semantics, but tool availability must be curated by the actor processors. A tool is not available merely because `roles.includes(role)`.

## Tool Surface Analysis

This section distinguishes **eventual useful capabilities** from the **initial actor-runtime surface**. The implementation phases below intentionally start smaller than the eventual role catalog.

### Planner

The planner is a goal coordinator. It decomposes goals into child cards, activates children, recovers failures, and reports terminal goal outcomes.

**Eventual useful non-terminal tools:**

| Tool | Purpose | Handled by |
|---|---|---|
| `create_card` | Create immediate child cards under the current goal | Actor-owned planner surface |
| `write_file` on `record://brief.md` | Update child goal/instructions/acceptance brief as understanding evolves | Actor-owned planner surface |
| `activate_card` | Activate an immediate child card for execution | Planning processor sequencing boundary |
| `cancel_card` | Cancel obsolete/duplicate/mis-scoped children | Later actor-owned planner surface |
| `delete_card` | Delete cancelled or erroneous children | Later actor-owned planner surface |
| `restart_card` | Restart a failed/blocked child from clean state | Actor-owned planner surface |
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

**Eventual useful non-terminal tools:**

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
- Catalog process tools such as `run_project_command` and `start_and_wait` are not part of the initial actor-runtime surface. The actor runtime already has owned `ProcessActor` tools (`run_process`, `wait_process`, `inspect_process`, `kill_process`) and should not run two process ownership models at once.
- Card mutation tools (`create_card`, `edit_card`, etc.) — executors do not manage the card tree.

**Terminal tools (contract):**
- `emit_executor_result` — already wired.

### Reviewer

The reviewer evaluates whether a goal's acceptance criteria are met by inspecting completed descendant work.

**Eventual useful non-terminal tools:**

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
- `get_card`, `list_cards`, `get_tree` — the reviewer needs descendant card results, but the initial design provides those as a compact context message rather than making the reviewer navigate the card tree. If that context proves insufficient, add focused read-only card inspection tools later.

**Terminal tools (contract):**
- `emit_reviewer_result` — already wired.

## Information Flow Analysis

### Parent → Child (via cards)

The primary information channel from parent to child is the card's **brief record** plus structured card state:

| Card surface | What carries | Target model |
|---|---|---|
| `brief.md` | Goal, instructions, context, and acceptance criteria | Versioned record slot |
| `title` | Short task label if the field audit keeps it | Structured card state |
| `type` | Card type (code/test/doc/data/research/architecture/ops) | Structured card state |
| `depends_on` | Dependencies on sibling cards if the field audit keeps it | Structured card state with narrow semantic mutation |

**What is sufficient:** The card's `brief.md` should carry all project context the child needs. The parent planner is responsible for writing a brief that gives the child enough context to work independently. If the child needs to read project files, it should use `read`/`glob`/`grep` tools, not rely on the parent to inline project content in the brief.

**What is currently missing:** Nothing structurally. The parent/child information channel is card-based and is sufficient for newly created child cards when the planner writes a complete brief with goal, instructions, and acceptance criteria.

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

This is already returned by `PlanningCardProcessorActor.handleToolCall`. The `summary` is the child's self-reported summary. The `result` is the full lifecycle result record (for example `executor_success` with `executor`, `verified_at`, `warnings`; or `planner_blocked` with `blocked_reason`, `resume_reason`). Durable narrative output lives in card-local record slots such as `status.md` and `review.md`.

**This is sufficient for the planner to decide next steps** — it knows the child's outcome, summary, and detailed result.

#### Card `lifecycle.result` (persisted, readable via `get_card` or store)

| Lifecycle result kind | Key fields |
|---|---|
| `executor_success` | `executor` (result record), `verified_at`, `warnings`; durable status details in the card's `status.md` record slot |
| `executor_failure` | `error`, `partial_result` |
| `planner_done` | `summary` |
| `planner_blocked` | `blocked_reason`, `resume_reason`, `blocker_cause` |
| `planner_failure` | `error` |
| `reviewer_pass` | `planning`, `review_summary`, `assessment_id` |

#### Card `status_text` and `latest_self_report`

Current implementation persists `status_text` and `latest_self_report` on the card. The record-backed card storage plan replaces `status_text` with `status.md` as the source of narrative status; structured self-report data remains card state unless a later concrete need justifies a separate structured result record.

#### Card record slots

Agents persist narrative output in versioned record slots under `.saivage/outputs/cards/{cardId}/`, primarily `status.md` for planner/executor status and `review.md` for reviewer assessments. Record URLs are durable references; there is no artifact/attachment registration path.

**What is currently working:**
- The `activate_card` tool result gives the parent planner a good summary of the child's outcome.
- The card lifecycle result is persisted and contains the accepted result record.
- Mandatory record slots preserve the agent-authored status/review text separately from mutable card fields.

**What is currently missing:**
- The planner cannot re-read a child card's state after activation (no `get_card` tool). But the tool result from `activate_card` is sufficient if the planner acts on it immediately — it doesn't need to re-read later because it gets the full result inline.
- The reviewer needs descendant status summaries and record-slot URLs for completed descendant work.

### Reviewer context (special case)

The reviewer is invoked by the parent planner after the planner reports `done`. The reviewer must evaluate whether the goal's acceptance criteria are met by examining the completed work.

**What the reviewer needs:**
1. Goal card: id, title if retained, and `brief.md` content or URL.
2. Descendant card summaries: for each descendant, the `id`, `type`, `title`, `status`, structured lifecycle result summary/error, and latest closed `status.md` record URL.
3. Reviewable evidence: accepted descendant cards plus their status records.
4. Read-only tools to verify work: `read`, `glob`, `grep` — currently NOT provided.

**Design: provide descendant summaries as a context message** (similar to `buildPlannerStateContextMessage`). Add read-only workspace tools later only if summaries are insufficient.

The descendant summary message should include, for each descendant of the goal card:
- `id`, `type`, `title`, `status`
- latest `status.md` summary or snippet
- `result.kind` (e.g. `executor_success`, `planner_done`, `planner_blocked`)
- `result.summary` or `result.error` (the key human-readable outcome)
- latest closed `status.md` record URL, when available
- `lifecycle.completed_at`

This gives the reviewer enough to cite `evidence_card_ids` and `issues[].evidence_card_id` without needing card-inspection tools in the initial implementation.

## System Prompt Design

The existing `buildPlannerPrompt`, `buildExecutorPrompt`, and `buildReviewerPrompt` in `src/agents/prompts/system-prompt.ts` are well-designed, generic, and include:
- Role definition and behavioral guidelines
- Tool surface description (card management, workspace, etc.)
- Contract description (terminal tools)
- Recovery and blockage rules

These should replace the inline one-liners in the actor runtime.

### Prompt assembly per agent

Prompt builders should be refactored to accept the actual actor tool surface instead of hardcoded tool-name arrays. The target shape is:

```typescript
buildPlannerPrompt({ contract, tools: plannerToolSurface.definitions(), depthContext })
buildExecutorPrompt({ contract, tools: executorToolSurface.definitions(), cardType })
buildReviewerPrompt({ contract, tools: reviewerToolSurface.definitions() })
```

The current positional builders and hardcoded prompt tool lists are implementation details to remove. Card-specific data belongs in context messages, not in the generic system prompt.

## Implementation Design

The implementation should avoid both extremes:

- Do **not** patch only `create_card` into `PlanningCardProcessorActor` as an isolated one-off. That would reimplement the same concepts again when executor/reviewer tools are expanded.
- Do **not** dump the entire role tool catalog into the actor runtime at once. That would add capabilities before the actor runtime owns their semantics, process lifecycle, and validation boundaries.

The balanced design is a small reusable **actor-owned tool surface** abstraction. It centralizes tool definition selection, argument validation, dispatch, and result wrapping, but each micro-actor processor still owns the semantics of its tools.

### Actor-Owned Tool Surface

Introduce a lightweight runtime helper, not a new orchestration layer:

```typescript
export interface ActorToolHandlerContext {
  projectRoot: string;
  cardId: string;
  sessionId: string;
}

export interface ActorToolHandler {
  name: string;
  definition: ToolDefinition;
  execute(args: unknown, context: ActorToolHandlerContext): Promise<unknown>;
}

export interface ActorToolSurface {
  definitions(): ToolDefinition[];
  handles(toolName: string): boolean;
  execute(toolName: string, args: unknown, context: ActorToolHandlerContext): Promise<unknown>;
}
```

Rules:

- The tool surface is owned by the processor actor that uses it.
- It has no runtime loop, no activation ledger, and no lifecycle commits.
- It does not call `LLMActor`; it only executes one non-terminal tool call and returns one tool result.
- `CardActor` remains the only lifecycle commit boundary.
- `PlanningCardProcessorActor` remains the owner of planner sequencing.
- `TerminalCardProcessorActor` remains the owner of executor process actors.
- `LLMActor` remains generic and queue-free.

This gives us one reusable dispatch shape without creating a second runtime model on top of micro-actors.

Each processor can extend `ActorToolHandlerContext` with the state it already owns. For example, the planner surface needs the card store and card-actor lookup/registration boundary; the executor surface needs the owned `ProcessActor` map. The shared abstraction standardizes dispatch, not ownership.

### Tool Surface Construction

Use explicit curated surfaces, not unrestricted role dumps:

```typescript
plannerToolSurface = createPlannerActorToolSurface(...);
executorToolSurface = createExecutorActorToolSurface(...);
reviewerToolSurface = createReviewerActorToolSurface(...);
```

Each surface exports definitions and executes only the names it intentionally owns.

The source of tool schemas can still be the existing catalog where appropriate, but actor runtime ownership is explicit. A tool is not available merely because `roles.includes(role)`.

### Planner Actor Tool Surface

Planner tools should be implemented first because this is the current blocker.

Initial planner actor tools:

| Tool | Purpose |
|---|---|
| `create_card` | Create an immediate child under the active planner card. |
| `activate_card` | Activate an immediate child card. |

`edit_card`, `restart_card`, `cancel_card`, and `delete_card` are useful, but can follow after the initial decomposition path is stable. They are not required to unblock normal forward progress.

Planner tool ownership rules:

- `create_card` always creates under the active planner card; any model-provided `parent` is ignored.
- `create_card` cannot create `project` cards.
- `activate_card` can operate only on immediate children of the active planner card.
- Child creation uses the same card store mutation path as analyst-created cards. The existing supervisor child lookup registers a `CardActor` from the store on demand, so a planner can create a child and then activate it in the same planning activation.
- Creating a card does not run it. The planner must call `activate_card` when it wants execution.
- Returning `continue` without creating or activating useful work is non-actionable and should be discouraged in the prompt.

`activate_card` is special. It is not a normal quick tool dispatch because it activates a child `CardActor` and waits for that child's processor to settle. Keep the `activate_card` sequencing in `PlanningCardProcessorActor`; do not hide it behind a generic tool executor. The generic surface handles normal card-control mutations such as `create_card`.

Implementation options:

- Reuse catalog `ToolDefinition` schemas for `create_card` and `activate_card` where they exactly match actor semantics.
- Implement actor-local handlers directly against `CardStore`/the card actor registry. Do not delegate to `PlannerControlExecutor`; it carries a separate control-surface/activation-ledger model and would blur micro-actor ownership.

### Executor Actor Tool Surface

Keep executor tools conservative at first.

Current executor process tools fit the actor model because `TerminalCardProcessorActor` owns `ProcessActor` instances:

| Tool | Purpose |
|---|---|
| `run_process` | Start a process owned by this terminal card activation. |
| `wait_process` | Wait for an owned process. |
| `inspect_process` | Inspect an owned process. |
| `kill_process` | Kill an owned process. |

Do not replace these with catalog `run_project_command`/`start_and_wait` until there is a single actor-owned process abstraction for both paths. Two process systems would be worse than one minimal process surface.

Add project file tools later through the same `ActorToolSurface` abstraction if the process-only surface remains awkward:

| Candidate tool | Purpose |
|---|---|
| `read` | Read project files/directories without shell commands. |
| `write` | Create/replace files. |
| `edit` | Exact text edit. |
| `apply_patch` | Apply text diffs. |
| `glob` | Find files. |
| `grep` | Search files. |

These are good eventual executor tools, but they are not required to solve planner decomposition and should not be mixed into the first runtime fix.

### Reviewer Actor Tool Surface

Do not begin by adding many reviewer tools. The reviewer first needs the right state.

Initial reviewer surface:

| Tool | Purpose |
|---|---|
| `emit_reviewer_result` | Terminal review assessment. |

Add one reviewer context builder:

```typescript
buildReviewerDescendantSummaryMessage(goalCard, descendants)
```

The message should include compact structured summaries:

- `id`
- `type`
- `title`
- `status`
- latest `status.md` summary or snippet
- `lifecycle.result.kind`
- concise summary/error fields
- latest closed `status.md` record URL, when available

This keeps review deterministic and avoids requiring the reviewer to navigate the card tree. If later validation proves the reviewer needs file inspection, add read-only `read`, `glob`, and `grep` through `ActorToolSurface`.

### Prompt Wiring

Prompts must exactly match the offered actor tools. Do not wire the existing rich prompts unchanged if they mention unavailable tools.

Update prompt builders to become the single source of runtime prompts, but make them parameterized by the actual tool surface:

```typescript
buildPlannerPrompt({ contract, tools: plannerToolSurface.definitions(), depthContext })
buildExecutorPrompt({ contract, tools: executorToolSurface.definitions(), cardType })
buildReviewerPrompt({ contract, tools: reviewerToolSurface.definitions() })
```

Guidelines:

- System prompts contain generic role/tool behavior only.
- Card-specific data moves to user context messages.
- Planner state remains in `buildPlannerStateContextMessage`.
- Reviewer descendant summaries live in a reviewer context message.
- No prompt mentions tools not present in `tools`.

### Context Message Builders

Create small reusable context builders:

```typescript
buildCardWorkContextMessage(card, mode: 'plan' | 'execute' | 'review')
buildPlannerStateContextMessage(...existing...)
buildReviewerDescendantSummaryMessage(...)
```

This avoids repeating card id/title/brief assembly in each processor while keeping the information flow explicit.

### Phased Implementation

#### Phase 1: Planner Decomposition

- Add `ActorToolSurface` helper.
- Add planner surface with `create_card`; keep `activate_card` directly in `PlanningCardProcessorActor`.
- Update planner prompt text to match that surface.
- Move planner card-specific text into a context message.
- Test: planner creates a missing child after an existing child completes and then activates it.

#### Phase 2: Reviewer Context

- Add `buildReviewerDescendantSummaryMessage`.
- Use reviewer prompt builder with terminal-only surface.
- Test: reviewer receives acceptance criteria and descendant summaries including status-record URLs and evidence card ids.

#### Phase 3: Executor Prompt Cleanup

- Use executor prompt builder with current process tools.
- Move executor card-specific text into a context message.
- Keep process tools unchanged.

#### Phase 4: Optional File Tools

- Add executor file tools through `ActorToolSurface` if shell-mediated file edits remain problematic.
- Add reviewer read-only file tools only if descendant summaries are insufficient.
- Add planner read-only file tools only if card briefs plus planner state are insufficient for decomposition.

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
   - Runtime advances past G1 scaffold into further decomposition.
   - Reviewer can cite evidence card IDs from completed descendants.
