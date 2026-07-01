# Tool Set Reorganization Design

Status: current design proposal.

Date: 2026-06-30

## 1. Purpose

Unify the fragmented Saivage v3 tool vocabulary into one coherent tool set that merges the best of v2's OpenCode-aligned naming with v3's card-centered runtime architecture. The previous partial migration left both old and new names in the catalog; nothing was removed. This document specifies the final single tool set, which tools to remove, which to add, and how they map to roles.

## 2. Context

Saivage v2 realigned its builtins to OpenCode/Copilot canonical names (`read`, `write`, `edit`, `apply_patch`, `glob`, `grep`, `webfetch`, `websearch`, `skill`, `run_command`) so frontier LLMs — pretrained on those interfaces — perform better. That alignment was fully completed in v2.

v3 partially ported those names but never removed the old ones (`read_project_file`, `list_project_files`, `run_project_command`, `load_skill`). The catalog now has 58 entries with dual names, dead process-tool duplicates, web tools wired but unreachable from actors, and no git/memory/RAG/notes. This reorg completes the migration: one name per concept, standard names where they exist, old names deleted.

## 3. Design Principles

1. **One tool vocabulary.** No parallel definitions. No dead catalog entries. No actor-inline definitions that duplicate catalog names. The vocabulary below is the single source of tool names, default schemas, and role assignments; actor runtime surfaces are curated subsets of it. Providers own their actual schema instances and may define surface-local variants when roles intentionally differ (see `shared-tool-invocation-design.md` §3.11); the `InvocationSurface` is the runtime authority.

2. **Standard names where they exist.** Use the OpenCode/Copilot-Claude canonical names (`read`, `write`, `edit`, `apply_patch`, `glob`, `grep`, `webfetch`, `websearch`, `skill`, `run_command`) for the high-frequency primitives LLMs are trained on. Remove the v3-specific alternatives (`read_file`, `write_file`, `list_directory`, `read_file_metadata`, `run_shell_command`, `run_project_command`, `start_and_wait`, `load_skill`).

3. **Names describe agent intent, not internal services.** `run_process` is a Saivage runtime concept; for the model, shell execution is `run_command`. Saivage's internal process lifecycle (durable runner, owner activation, log files) is an implementation, not a separate tool.

4. **Role surfaces are curated subsets, not role-tagged catalog filters.** The actor runtime owns which tools each role actually sees; the catalog's `roles` field is advisory and must not be trusted to reflect runtime wiring.

5. **No aliases, no shims, no compatibility.** Per v3 architecture rules, removing a name removes it. Persisted sessions with stale references are invalid; runtime repair handles the failure, not compatibility code.

6. **Defer capabilities v3 doesn't own yet.** Git, memory, RAG, and notes are not added in this reorg. v3 doesn't have built-in RAG infra, durable knowledge memory, or a note inbox. Adding the tool name without the subsystem would lie to the model. They are explicitly listed as future work in section 9.

7. **Analyst uses the same tools when possible.** The Analyst has extra control-surface tools, but overlapping workspace actions should use the same model-facing names as other agents (`read`, `write`, `glob`, `grep`, `run_command`, etc.). Broader host/system access is expressed through URI scopes such as `system://`, not through separate tool names like `read_file` or `run_shell_command`.

8. **Scope is in the URL, not the tool name.** Prefer `project://` URLs for normal project work. Use `record://` for card records and `tmp://` for card-local scratch. Use `system://` only when host-wide inspection is genuinely needed. The tool name stays stable while the path scheme carries the authority boundary.

## 4. Target Tool Set

### 4.1 Agent-Facing Tools (planner / executor / reviewer)

These are the tools autonomous agents see. Names follow the OpenCode-aligned convention where a direct equivalent exists.

| Tool | Args | Roles | Replaces | Notes |
| --- | --- | --- | --- | --- |
| `read` | `path`, `offset?`, `limit?`, `read_mode?` | P, E, R, A | `read_project_file`, `read_file`, `read_file_metadata` | Reads files, directories, records, or metadata through URL scopes. Defaults to `project://` for relative paths. Supports `project://`, `record://`, `tmp://`, and `system://`. Bounded. Truncation metadata. Optional multimodal. |
| `write` | `path`, `content` | P, E, R, A | `write_project_file`, `write_file` | Create/replace files or record slots through URL scopes. All agents write their `record://` slots (planner: `status.md`/`brief.md`; executor: `status.md`; reviewer: `review.md`; analyst: `brief.md`). `project://` file writes are executor and analyst only; slot-writer rules enforce which `record://` slot each role may write. `system://` writes are available but discouraged. |
| `edit` | `path`, `old_string`, `new_string`, `replace_all?` | P, E, R, A | (new in v3) | Exact string replacement. Single file. Planner/reviewer use it only on their own `record://` slots; `project://` edits are executor/analyst-only (see §8). |
| `apply_patch` | `patch` | E, A | (new in v3) | Unified diff. Validates before applying. |
| `glob` | `directory`, `pattern`, `max_results?` | P, E, R, A | `list_project_files`, `list_directory` | Recursive file discovery over URL scopes. Defaults to `project://`. Skips blocked paths. `system://` is available but discouraged for normal work. |
| `grep` | `pattern`, `path?`, `include?`, `max_results?` | P, E, R, A | (new in v3) | Regex content search over URL scopes. Defaults to `project://`. Skips blocked/secret paths. |
| `run_command` | `command`, `cwd?`, `timeout_ms?`, `inactivity_timeout_ms?`, `wait?` | E, A | `run_project_command`, `start_and_wait`, `run_process`, `run_shell_command` | Single shell execution tool. `cwd` is a URL scope and defaults to `project://`. `system://` cwd is available but discouraged. `wait` defaults to `true`; `wait: false` starts a background process. Background control uses `wait_process` and `kill_process`. See §4.2. |
| `websearch` | `query`, `max_results?` | P, E, R, A | (wire into actor surfaces) | Web search. Currently in catalog but not exposed to actors. |
| `webfetch` | `url`, `read_mode?`, `metadata_only?`, `max_bytes?`, `save_as?` | P, E, R, A | (wire into actor surfaces) | Bounded HTTP fetch. Private-IP egress blocked. |
| `skill` | `name?` | E, R, A | `load_skill` | List skills (no arg) or load one (with name). |

### 4.2 Process Management Sub-Surface (executor)

The executor needs background process control for long-running commands (dev servers, watchers). v3 currently has four inline actor tools (`run_process`, `wait_process`, `inspect_process`, `kill_process`) plus four dead catalog entries. Collapse to three:

| Tool | Args | Replaces | Notes |
| --- | --- | --- | --- |
| `run_command` | `command`, `cwd?`, `timeout_ms?`, `inactivity_timeout_ms?`, `wait?` | `run_process`, `run_project_command`, `start_and_wait` | `wait: true` (default) runs to completion. `wait: false` starts in background and returns `process_id`. |
| `wait_process` | `process_id`, `timeout_ms?` | `wait_process`, `wait_for_process`, `inspect_process` | Wait for a background process. `timeout_ms: 0` returns current state without blocking. Non-blocking inspection is just a zero-timeout wait. |
| `kill_process` | `process_id`, `signal?` | `kill_process` (both variants) | Kill or signal a background process. |

This gives the executor one canonical command tool plus two background-control tools, instead of six overlapping names.

### 4.3 Card Lifecycle Tools (planner-control)

Unchanged from current v3. These are v3-specific and have no OpenCode equivalent:

| Tool | Roles | Notes |
| --- | --- | --- |
| `create_card` | P | Create immediate child. Planner-scoped schema. |
| `edit_card` | P | Edit card fields. Planner-scoped. |
| `activate_card` | P | Activate a child card for execution. Sequencing boundary. |
| `cancel_card` | P, A | Cancel dormant work. |
| `delete_card` | P, A | Archive-backed delete. |
| `restart_card` | P, A | Restart a terminal card. |
| `reorder_child` | P, A | Reorder children of a non-running parent. |
| `queue_notification` | P, A | Queue a notification for a future agent session. |

Goal reporting (terminal contract tool): planner, executor, and reviewer use one terminal tool name, `emit_result`, with a common envelope. Each role's contract validates only the statuses that role may emit. The old `report_goal_done` / `report_goal_failed` / `report_goal_blocked` tools are dead code from the retired `AgentExecutionPort` surface and are removed (see section 5).

See section 4.7 for the unified terminal tool design.

### 4.4 Inspection Tools (shared by P, E, R, A)

| Tool | Roles | Notes |
| --- | --- | --- |
| `list_cards` | P, A | List/filter cards. |
| `get_card` | P, A | Full card detail with children + record summaries. |
| `get_tree` | P, A | Card tree. |
| `list_card_history` | P, E, R, A | Card version headers. |
| `get_card_history_entry` | P, E, R, A | Specific card version snapshot. |
| `diff_card` | P, E, R, A | Field-level diff between card versions. |

`get_status` remains Analyst-only. The planner diary subsystem (`get_plan_diary`, `appendDiaryEntry`, `.saivage/diaries/`) is removed; it was dead code with no runtime writers (see section 5).

### 4.5 Analyst Tools And URI Scopes

The Analyst should receive the same high-frequency workspace tools as the autonomous agents wherever possible: `read`, `write`, `glob`, `grep`, `run_command`, `websearch`, `webfetch`, and `skill` when useful. The difference is not the tool name; it is the authority scope encoded in the URL.

Supported URI scopes:

| Scope | Meaning | Default audience | Guidance |
| --- | --- | --- | --- |
| `project://` | Target project root. Relative paths default here. | All agents | Recommended for normal project work. |
| `record://` | Card record slots (`brief.md`, `status.md`, `review.md`). | All agents subject to slot writer rules | Use for durable card records. |
| `tmp://` | Card/session-local scratch. | All agents | Use for temporary artifacts. |
| `system://` | Host/system filesystem or command working directory outside the project root. | All agents; logged; discouraged in prompts | Use only when project/record/tmp scopes are insufficient. Secret and destructive-operation policy still applies. |

This replaces the separate Analyst host-inspection names:

| Removed Analyst-specific name | Replacement |
| --- | --- |
| `read_file` | `read system://...` or `read record://...` |
| `read_file_metadata` | `read system://...` with `metadata_only` / read-mode metadata behavior |
| `write_file` | `write record://...` or available-but-discouraged `write system://...` |
| `list_directory` | `glob system://...` |
| `run_shell_command` | `run_command` with `cwd: 'system://...'` |

The remaining Analyst control tools (`start_project`, `stop_project`, `pause_runtime`, `resume_runtime`, `abort_goal_subtree`, `restart_card_or_subtree`, `restart_goal`, `navigate_workspace`, `navigate_back`, `read_runtime_events`, `read_runtime_errors`, `read_control_actions`, `list_processes_tool`, `list_agent_sessions`, `read_agent_session`, `show_config`, `reconfigure`, `restart_server`, `queue_notification`, `mark_goal_rework`) keep their current names unless simplified later. They are operator control surface tools, not workspace primitives. `terminate_process` is removed — `kill_process` from `ProcessProvider` is the single process-termination tool (see §4.2 and the removals table in §5).

### 4.6 External MCP Wrapper

| Tool | Roles | Notes |
| --- | --- | --- |
| `mcp_tool_call` | E, R, A | Call a tool on a configured MCP server. |

Unchanged. External MCP tools are the extension point; they use their own names via this wrapper.

### 4.7 Unified Terminal Tool

Planner, executor, and reviewer use one terminal tool name: `emit_result`. The model never sees more than one `emit_result` definition at a time because each role runs in its own activation with its own tool list. The analyst does not get `emit_result` because the analyst is not a card processor.

#### Design principle: common envelope, records carry the detail

The runtime only needs two things from the terminal tool call to drive the card lifecycle:
1. **What happened** — the `status` (`done | blocked | failed | rework`).
2. **Why** — a short `summary` text that becomes the card's `status_text` and the one-line display in the UI.

Everything else — executor warnings, free-form result blobs, reviewer achieved criteria, issues with severity, evidence card references — is human-readable evidence that belongs in the card record slots, not in the structured envelope. Agents already write `status.md` (planner/executor) and `review.md` (reviewer) during every activation. That's where the rich detail lives. The envelope is just the sign-off.

The envelope is one common schema for all three roles. Each role's contract simply validates that the emitted `status` is one the role is allowed to use.

This eliminates the current per-role envelope specialization:
- Executor no longer has `status_text` (required), `error`, `result`, `warnings`, `summary` as separate fields — all of that goes into `status.md`. The `summary` field replaces `status_text`.
- Reviewer no longer has a nested `assessment` object (`result`, `summary`, `achieved[]`, `issues[]`, `evidence_card_ids[]`) — all of that goes into `review.md`. The envelope just says `done` (pass) or `rework` (send back for changes).
- Planner no longer has `blocked_reason` as a separate field — it's part of `summary`.

#### Common envelope

```ts
export const ResultEnvelopeSchema = z.object({
  status: z.enum(['done', 'blocked', 'failed', 'rework']),
  summary: z.string().min(1),
}).strict();
```

- `done` — the agent completed its current task/activation. For a planner, this means the current planning task is complete, not that the entire project/process is complete. For the reviewer, `done` means "assessment passed."
- `blocked` — cannot progress due to external state. For the reviewer, this means the review itself cannot proceed.
- `failed` — this card's work is fundamentally not achievable as scoped.
- `rework` — review completed and the work must go back for changes. Only reviewers emit this status.
- `summary` — mandatory reason text. Short, human-readable. This is the only structured field beyond `status`.

There is no planner-specific `continue` status. The planner finishes each planning activation by returning `done`, `blocked`, or `failed`. The runtime/card scheduler decides whether more planning work remains based on the card tree, child states, reviewer state, and queued context. A model that needs to do more work in the same activation should keep using tools before it calls `emit_result`; it should not report a special continuation status.

#### What goes where

| Information | Current location | New location |
| --- | --- | --- |
| Card outcome (done/blocked/failed) | Envelope `status` (per-role) | Envelope `status` (common) |
| One-line reason text | Executor `status_text`; planner `blocked_reason`/`summary`; reviewer `assessment.summary` | Envelope `summary` (common) |
| Executor warnings | Envelope `warnings[]` | `status.md` |
| Executor free-form result/evidence | Envelope `result` (free-form record) | `status.md` |
| Executor error detail | Envelope `error` | `summary` text (short) + `status.md` (detail) |
| Reviewer verdict (pass/send back) | Envelope `assessment.result` | Envelope `status` (`done` = pass, `rework` = send back for changes) |
| Reviewer achieved criteria | Envelope `assessment.achieved[]` | `review.md` |
| Reviewer issues (severity, evidence, recommendation) | Envelope `assessment.issues[]` | `review.md` |
| Reviewer evidence card references | Envelope `assessment.evidence_card_ids[]` | `review.md` |
| Planner block reason | Envelope `blocked_reason` | Envelope `summary` |
| Planner "needs more turns" | Envelope `status: 'continue'` | Removed. Planner returns `done` for its current planning task; the runtime schedules later planning if the card still needs work. |

#### Reviewer evidence

Evidence card references move to `review.md` as prose. The runtime does not parse markdown to validate evidence card IDs. Evidence quality is a review-quality concern enforced by the reviewer prompt and operator inspection, not a runtime invariant. If a future need for structured evidence validation emerges, add a structured field back to the envelope — but don't parse markdown.

#### Record slot strategy: common + per-agent

The current record slots are already organized as common + per-agent:

| Slot | Writers | Scope | Status |
| --- | --- | --- | --- |
| `status.md` | Planner, Executor | Common — per-activation status narrative | Unchanged |
| `review.md` | Reviewer | Per-agent — structured review assessment | Unchanged |
| `brief.md` | Planner, Analyst | Per-agent — card goal/instructions/acceptance definition | Unchanged |
| `card.json` | Runtime (internal) | Internal card state — not agent-facing | Unchanged |

No new slots are needed. If a future role needs its own dedicated record, it can be added as a per-agent slot. The principle is: the envelope carries the sign-off; the record carries the narrative. Agents should write the record before calling `emit_result`, and the runtime already enforces this.

#### Simplified lifecycle results

Currently there are 7 lifecycle result kinds (`executor_success`, `executor_failure`, `executor_needs_verification`, `planner_done`, `planner_blocked`, `planner_failure`, `reviewer_pass`, `reviewer_correction`). With the common envelope, these collapse to 4 (plus 1 internal):

| Lifecycle result | `card.status` | Fields | Replaces |
| --- | --- | --- | --- |
| `DoneResult` | `done` | `summary` | `executor_success`, `planner_done`, `reviewer_pass` |
| `BlockedResult` | `blocked` | `summary` (reason) | `planner_blocked` |
| `FailedResult` | `failed` | `summary` (error/reason) | `executor_failure`, `planner_failure` |
| `ReworkResult` | `rework` | `summary` (reason) | `reviewer_correction` — the correction detail is in `review.md` |
| `NeedsVerificationResult` | `needs_verification` | `reason`, `preserved_result` | `executor_needs_verification` (internal runtime concept, not agent-emitted — keep as-is) |

The `latest_self_report` field currently embedded in executor results is a mirror of `status.md` content. With the detail living in `status.md`, `latest_self_report` can be dropped from the lifecycle result — the record URL is the durable reference.

Runtime-internal fields like `blocker_cause` (`'reviewer_unavailable' | 'generic' | ...`) and `verified_at` are set by the runtime, not emitted by the agent. They stay on the lifecycle result as internal metadata. The `'non_actionable_continue'` cause is removed — with no `continue` status, a planner that returns `done` without useful work is a prompt-quality issue, not a distinct blocker cause.

#### Why one name works

- Each role's tools are sent independently; the model never sees two `emit_result` schemas at once.
- The contract system (`src/contracts/contract.ts`) already verifies per-role. Unifying the name and the envelope changes the contract terminal descriptor and schema, but the projection logic stays per-role (each contract knows its own record slot and which statuses the role may emit).
- `contract.isTerminalToolName(name)` checks `name === 'emit_result'` for the three autonomous contracts. Since each actor runs exactly one contract, there is no ambiguity.
- Transcript entries store `tool_name: 'emit_result'`; the round/role context in the conversation UI disambiguates which role emitted it.
- The common envelope is simpler for the model: one schema shape to learn, not three.
- The analyst has no terminal tool; analyst messages end the analyst turn via a normal chat response, not via `emit_result`.

## 5. Removals

The following names are removed from the catalog. They are either duplicates of the standard names, dead code, or unused:

| Removed name | Replaced by | Reason |
| --- | --- | --- |
| `read_file_metadata` | `read` | Metadata is behavior on the standard `read` tool, selected by read mode/metadata option. |
| `write_file` | `write` | Same operation, standard name. `record://` replaces the Analyst-specific record-write tool. |
| `list_directory` | `glob` or `read` directory mode | Directory listing/discovery uses standard file tools over scoped URLs. |
| `run_shell_command` | `run_command` | Same operation, standard name. `system://` cwd replaces the host-specific tool name. |
| `run_project_command` | `run_command` | Same concept, v3-specific name. |
| `start_and_wait` | `run_command` with `wait: true` | Redundant with `run_command`. |
| `wait_for_process` | `wait_process` | Dead catalog entry; actor had its own. |
| `kill_process` (catalog variant with `signal`) | `kill_process` | Merge the two variants into one with optional `signal`. |
| `inspect_process` | `wait_process` with `timeout_ms: 0` | Non-blocking inspection is a zero-timeout wait. |
| `run_process` (actor-inline) | `run_command` with `wait: false` | Background start is `run_command` with `wait: false`. |
| `wait_process` (actor-inline) | `wait_process` (catalog) | Move from inline to catalog. |
| `read_file` | `read` | The catalog `read_file` was the Analyst host-inspection tool. Replaced by `read` with `system://` or `record://` scope. No separate workspace variant exists. |
| `load_skill` | `skill` | Standard name. |
| `report_goal_done` | `emit_result` | Dead code from the old `AgentExecutionPort` runtime. Never reached the planner LLM. Removed with the dead `AgentExecutionPort` surface. |
| `report_goal_failed` | `emit_result` | Dead code, same as above. The old planner envelope had no `failed` status; the unified terminal tool now adds `failed` to the planner schema (see section 4.7). |
| `report_goal_blocked` | `emit_result` | Dead code, same as above. `emit_result` with `status: 'blocked'` and `blocked_reason` covers this. |
| `emit_planner_result` | `emit_result` | Unified terminal tool name. Common envelope. |
| `emit_executor_result` | `emit_result` | Unified terminal tool name. Common envelope. |
| `emit_reviewer_result` | `emit_result` | Unified terminal tool name. Common envelope. |
| `get_plan_diary` | (removed) | Dead code. No runtime component appends diary entries; the tool always returned an empty array for real goals. The whole planner diary subsystem is removed: `src/cards/diary.ts`, `.saivage/diaries/`, `.saivage/reviews/by-goal/`, the `DiaryEntry`/`DiaryKind` schema, and the `plan_diary` navigation kind. Reviewer assessments already live in the `review.md` record slot. |
| `terminate_process` | `kill_process` | Same concept, same process store. Both called `processApi().terminate()`. `kill_process` from `ProcessProvider` is the single process-termination tool; it also accepts an optional `signal` parameter. Process ownership is scoped by `ownerId` (activation id or session id). |

## 6. Role Tool Surfaces

The actor runtime exposes curated subsets. The catalog's `roles` field is updated to match reality.

### Planner

| Category | Tools |
| --- | --- |
| Card control | `create_card`, `edit_card`, `cancel_card`, `activate_card`, `reorder_child`, `queue_notification` |
| Filesystem | `read`, `write` (`record://status.md`, `record://brief.md` only), `edit` (same record slots), `glob`, `grep` |
| Inspection | `list_cards`, `get_card`, `get_tree`, `list_card_history`, `get_card_history_entry`, `diff_card` |
| Web | `websearch`, `webfetch` |
| Terminal | `emit_result` (`done \| blocked \| failed` + `summary`) |

Planner does **not** get `apply_patch`, `run_command`, `skill`, or `mcp_tool_call`. The planner coordinates; it writes/edits only its card's `status.md`/`brief.md` records, never project files.

### Executor

| Category | Tools |
| --- | --- |
| Filesystem | `read`, `write` (`record://status.md` + `project://` files), `glob`, `grep`, `edit`, `apply_patch` |
| Shell | `run_command`, `wait_process`, `kill_process` |
| Web | `websearch`, `webfetch` |
| Skill | `skill` |
| MCP | `mcp_tool_call` |
| Inspection | `list_card_history`, `get_card_history_entry`, `diff_card` |
| Terminal | `emit_result` (executor: `done \| failed` + `summary`) |

Executor and Analyst may write `project://` files. Record writes follow slot-writer rules.

### Reviewer

| Category | Tools |
| --- | --- |
| Filesystem | `read`, `write` (`record://review.md` only), `edit` (same record slot), `glob`, `grep` |
| Web | `websearch`, `webfetch` |
| Skill | `skill` |
| MCP | `mcp_tool_call` |
| Inspection | `list_card_history`, `get_card_history_entry`, `diff_card` |
| Terminal | `emit_result` (reviewer: `done` = pass, `rework` = send back for changes, `blocked` = cannot review, `failed` = review failed; detail in `review.md`) |

Reviewer does **not** get `apply_patch` or `run_command`. The reviewer writes/edits only its `review.md` record; it does not modify project files.

### Analyst

The Analyst gets the same workspace tools as the autonomous agents, plus its control-surface tools. We are lax about what the Analyst can call — the analyst is the mutation surface and should not be artificially restricted at the app level. Prompt guidance discourages the analyst from doing executor/reviewer work directly and recommends delegating through cards, but the tools are available.

| Category | Tools |
| --- | --- |
| Filesystem | `read`, `write`, `edit`, `apply_patch`, `glob`, `grep` over `project://`, `record://`, `tmp://`, and `system://` |
| Shell | `run_command`, `wait_process`, `kill_process` with `cwd` scoped by `project://` or `system://` |
| Web | `websearch`, `webfetch` |
| Skill | `skill` |
| Card lifecycle | `create_card`, `edit_card`, `cancel_card`, `delete_card`, `reorder_child`, `restart_card`, `queue_notification` |
| Inspection | `list_cards`, `get_card`, `get_tree`, `list_card_history`, `get_card_history_entry`, `diff_card`, `get_status` |
| MCP | `mcp_tool_call` |
| Terminal | (none — analyst is not a card processor) |

The Analyst additionally keeps operator-control tools (`start_project`, `stop_project`, `pause_runtime`, `resume_runtime`, `navigate_workspace`, `navigate_back`, `show_config`, `reconfigure`, `restart_server`, `read_runtime_events`, `read_runtime_errors`, `read_control_actions`, `list_processes_tool`, `list_agent_sessions`, `read_agent_session`, `mark_goal_rework`, `abort_goal_subtree`, `restart_card_or_subtree`, `restart_goal`).

The Analyst does not get `activate_card` — that is a planner-internal sequencing boundary, not an operator action.

## 7. Schema Contracts

All tool schemas use snake_case field names to match the OpenCode/Copilot convention LLMs expect. The internal tool result contract is the discriminated union `{ success: true, data?: unknown } | { success: false, error: string }`; there is no error `code` field. The transcript layer serializes success as a `tool_result` entry and failure as a `tool_error` entry containing the error string. (This supersedes the earlier `{ error, code? }` wire shape; see `shared-tool-invocation-design.md` §3.9.)

| Tool | Schema | Result shape |
| --- | --- | --- |
| `read` | `path: string, offset?: number, limit?: number, read_mode?: 'auto'\|'text'\|'multimodal', metadata_only?: boolean` | `metadata_only` → `{ path, size, mtime, ... }`. File: `{ path, content, offset, limit, total_lines, truncated }`. Dir: `{ path, entries, offset, limit, total_entries, truncated }`. |
| `write` | `path: string, content: string` | `{ path, bytes, written: true }` |
| `edit` | `path: string, old_string: string, new_string: string, replace_all?: boolean` | `{ path, replacements, bytes, edited: true }` |
| `apply_patch` | `patch: string` | `{ changed_files, applied: true }` |
| `glob` | `directory: string, pattern: string, max_results?: number` | `{ directory, pattern, matches, truncated }` |
| `grep` | `pattern: string, path?: string, include?: string, max_results?: number` | `{ pattern, matches, truncated }` (match: `{ path, line, preview }`) |
| `run_command` | `command: string, cwd?: string, timeout_ms?: number, inactivity_timeout_ms?: number, wait?: boolean` | `wait: true` → `{ exit_code, stdout, stderr, truncated, log_path? }` (`log_path` is a scoped URL, usually `tmp://` or `record://`). `wait: false` → `{ process_id, running: true }`. |
| `wait_process` | `process_id: string, timeout_ms?: number` | `{ exit_code, stdout, stderr, truncated, log_path? }` or `{ process_id, still_running: true }` on timeout. |
| `kill_process` | `process_id: string, signal?: string` | `{ process_id, terminated: true, signal? }`. Default signal is SIGTERM. |
| `websearch` | `query: string, max_results?: number` | `{ query, results: [{ title, url, snippet }], skipped? }` |
| `webfetch` | `url: string, read_mode?: 'auto'\|'text'\|'multimodal', metadata_only?: boolean, max_bytes?: number, save_as?: string` | Metadata: `{ status, headers }`. Text: `{ content, truncated, saved_path? }` (`save_as` and `saved_path` are scoped URLs, e.g. `tmp://` or `project://`). |
| `skill` | `name?: string` | No name: `{ skills: [{ name, description }] }`. With name: skill content. |

## 8. Security Policy

All filesystem tools share one path policy:
- Relative paths default to `project://`.
- `project://`, `record://`, and `tmp://` are the normal scopes for project work.
- `system://` allows host/system access for all agents. It is logged and discouraged in prompts in favor of `project://`, but not gated by a permission system.
- Project-agent paths must resolve inside the configured project root.
- Secret-bearing paths and blocked runtime/credential paths are invisible to `glob`, `grep`, and directory reads.
- Direct access to a blocked path fails with a permission error.
- Mutating tools reject blocked paths, `.saivage`, `.saivage-work`, symlink targets outside root, credential files, and unsafe `system://` writes.
- `record://` writes are subject to slot-writer enforcement at the record-write boundary. For card processors, "current card" is the composed activation card and explicit URL card parameters must match it. For the Analyst, there is no implicit current card; an explicit `?card=<id>` parameter is the operation target.
  - `status.md` → planner/executor (current card only)
  - `review.md` → reviewer (current card only)
  - `brief.md` → planner/analyst (current card for planners; explicit `?card=<id>` target for the Analyst)
  - `card.json` → runtime internal (never agent-writable)
- `project://` file writes are restricted by role:
  - Executor and Analyst may write `project://` files (Analyst via `write`/`edit`/`apply_patch` on project paths).
  - Planner and Reviewer may **not** write `project://` files; they only write their `record://` slots.
- `edit` and `apply_patch` on `record://` paths follow the same slot-writer rules as `write`. On `project://` paths they follow the same role restriction as `write`.

Web tools share one egress policy:
- Only `http` and `https`.
- DNS and every redirect target checked against private/internal/metadata ranges.
- Response size, header size, redirect count, and inline text size are bounded.
- `webfetch` with `save_as` uses the same write authorization as `write`.

Process tools share one ownership policy:
- `cwd` defaults to `project://`.
- `system://` command working directories are available but discouraged in prompts.
- Background processes are owned by the activation (executor) or session (analyst) that started them, scoped by `ownerId`.
- `wait_process` and `kill_process` can only act on processes owned by the current context (activation id or session id).
- Process IDs are scoped to the owner context, not global.
- The runtime kills owned processes when the activation settles or the analyst session ends (see `shared-tool-invocation-design.md` §3.2).

## 9. Deferred Capabilities

These v2 capabilities are not added in this reorg because v3 does not have the supporting subsystem. Adding the tool name without the subsystem would lie to the model.

| Capability | v2 tools | v3 status | Decision |
| --- | --- | --- | --- |
| Git | `git_status`, `git_diff`, `git_log`, `git_create_branch`, `git_checkout`, `git_commit`, `git_merge`, `git_delete_branch` | None; agents use `run_command` for git | Defer. Add `git_status`, `git_diff`, `git_log` as read-only tools once there is a concrete need for structured git state beyond shell. Git mutations stay behind explicit authorization. |
| Memory | `create_memory`, `update_memory`, `supersede_memory`, `archive_memory`, `delete_memory`, `list_memories`, `get_memory`, `search_memories` | None; v3 uses record slots (`status.md`, `review.md`) and `queue_notification` | Defer. Add only if v3 introduces a durable cross-session knowledge memory subsystem. |
| RAG | `rag_list`, `rag_stats`, `rag_query`, `rag_register`, `rag_ingest`, `rag_drop`, `rag_admin` | None; v3 has no built-in RAG | Defer. Add only with a v3-native RAG implementation. |
| Notes | `create_note` | None; v3 uses `record://` and `queue_notification` | Defer. Not currently needed. |

## 10. Implementation Phases

The diary subsystem removal (section 5) is already complete; do not redo it.

Implementation should follow `shared-tool-invocation-design.md`: providers own schema and execution, runtime `InvocationSurface`s are composed from provider instances, and there is no detached catalog/context-bag execution path. The phases below describe the implementation order for the final tool vocabulary, not a catalog-centered migration.

Each phase should typecheck and pass focused tests before moving on.

### Phase 1: Delete duplicate/dead model-facing names

- Remove `run_project_command`, `start_and_wait`, `wait_for_process`, and `inspect_process`.
- Remove `read_file_metadata`, `read_file`, `write_file`, `list_directory`, and `run_shell_command` as separate model-facing tool names. Preserve their capabilities through `read`, `write`, `glob`, and `run_command` with scoped URLs (`project://`, `record://`, `tmp://`, `system://`).
- Remove `load_skill`; ensure `skill` supports both list and load.
- Remove `report_goal_done`, `report_goal_failed`, and `report_goal_blocked` from residual definitions and prompts. They are dead names from the retired `AgentExecutionPort` surface and never reach the planner LLM.
- Update tests that reference removed names; add negative tests for the removed names.

### Phase 2: Introduce provider-owned invocation surfaces

- Replace detached catalog execution with provider-owned `ToolDefinition`s and `InvocationSurface` composition as specified in `shared-tool-invocation-design.md`.
- Build `WorkspaceProvider`, `PatchProvider`, `ProcessProvider`, `WebProvider`, `CardHistoryProvider`, `CardNavigationProvider`, `McpProvider`, and `SkillProvider`.
- Move planner card-control tools onto `PlanningCardProcessorActor` and analyst operator-control tools onto `AnalystHandler` as bound methods/providers.
- Keep schemas beside their provider-owned executors; any docs/schema aggregate is read-only and must not drive runtime prompts.

### Phase 3: Compose the role surfaces

- Planner: planner domain tools, workspace, navigation, history, web, and processor-owned `emit_result`.
- Executor: workspace, patch, process, history, web, MCP, skill, and processor-owned `emit_result`.
- Reviewer: workspace, history, web, MCP, skill, and processor-owned `emit_result`.
- Analyst: analyst domain tools, workspace, patch, process, navigation, history, web, MCP, and skill.
- Confirm `websearch` and `webfetch` are present on planner, executor, reviewer, and analyst surfaces, with `webfetch.save_as` using the same write authorization as `write`.

### Phase 4: Unify the terminal contract

- Rename the three terminal tools (`emit_planner_result`, `emit_executor_result`, `emit_reviewer_result`) to one processor-owned terminal operation: `emit_result`.
- Replace the three per-role envelopes with one common envelope: `{ status: 'done' | 'blocked' | 'failed' | 'rework', summary: string }`. Each role's contract validates only the statuses that role may emit (reviewer: `done`/`rework`/`blocked`/`failed`; planner/executor: `done`/`blocked`/`failed`).
- Move executor `warnings`/`result`/`error` and reviewer `assessment`/`achieved`/`issues`/`evidence_card_ids` into the record slots (`status.md`, `review.md`). Replace `status_text` with `summary`.
- Collapse lifecycle results to `DoneResult`, `BlockedResult`, `FailedResult`, and `ReworkResult` plus the internal `needs_verification` state. Drop `latest_self_report` from the lifecycle result; the record URL is the reference.

### Phase 5: Align scoped URL policy, prompts, and specs

- Ensure all workspace, patch, process, and web save paths support the final scoped URL policy (`project://`, `record://`, `tmp://`, `system://`) and role-specific write authorization.
- Ensure Analyst workspace tools use explicit `?card=<id>` for `record://`/`tmp://` card targets and do not depend on implicit card context.
- Update prompts to mention only the final tool names, recommend `project://`, `record://`, and `tmp://` first, and describe `system://` as available, logged, and discouraged unless necessary.
- Update `docs/spec/` and `docs/architecture/` references to removed tool names.

## 11. Relationship To Other Documents

| Document | Relationship |
| --- | --- |
| `docs/architecture/agent-conversation-ui-redesign.md` | This reorg is the Phase 2 prerequisite for the UI redesign. Once tools use standard names, the UI display registry can key directly to them. |
| `docs/architecture/tool-repair-and-agent-conversation-unification-plan.md` | Fixes the runtime `await` bug and unifies the transcript substrate. Independent of tool naming; both can proceed in parallel. |
| `docs/architecture/agent-tool-surfaces-and-information-flow.md` | Proposes the `ActorToolSurface` abstraction for role-curated subsets. This reorg assumes that abstraction exists; the surfaces defined in section 6 are what each `ActorToolSurface` should expose. |
| `docs-old/design/v2-tool-interface-alignment-plan.md` | The original partial migration plan. This reorg supersedes it; the old plan is provenance. |
| `docs-old/design/priority-tool-port-implementation-plan.md` | The original port implementation plan. This reorg supersedes it; the old plan is provenance. |

## 12. Acceptance Criteria

This reorganization is complete when:

- the catalog contains exactly one definition per concept (no dual names);
- `run_command` is the single shell-execution tool for agents, with `wait` controlling foreground/background;
- `wait_process` and `kill_process` are the only background-process control tools;
- `websearch` and `webfetch` are reachable from planner, executor, and reviewer;
- the reviewer surface includes `write` and `edit` (record-only) but not `apply_patch`;
- the catalog `roles` field matches actual actor wiring for every entry;
- removed host-inspection names (`read_file`, `write_file`, `list_directory`, `run_shell_command`, `read_file_metadata`) are absent from the catalog; their capabilities are available through standard tools with scoped URLs;
- removed names (`run_project_command`, `start_and_wait`, `wait_for_process`, `inspect_process`, `run_process` as a separate tool, `load_skill`, `list_project_files`, `read_project_file`, `write_project_file`, `report_goal_done`, `report_goal_failed`, `report_goal_blocked`, `emit_planner_result`, `emit_executor_result`, `emit_reviewer_result`) are absent from the catalog and from all actor tool bundles;
- system prompts mention only tools that exist in the final catalog;
- tests assert the final role tool surfaces and fail if removed names reappear;
- the conversation UI redesign's Phase 2 unblocks because the tool vocabulary is aligned;
- the terminal tool is `emit_result` for planner, executor, and reviewer with a common `{ status: 'done' | 'blocked' | 'failed' | 'rework', summary }` envelope; the analyst has no terminal tool;
- planner `done` means the planner completed its current planning task/activation, not that the entire process is complete;
- lifecycle results are collapsed from 7 kinds to 4 (`DoneResult`, `BlockedResult`, `FailedResult`, `ReworkResult`) plus the internal `NeedsVerificationResult`; reviewer may emit `done`, `rework`, `blocked`, or `failed`;
- executor `warnings`, `result`, and `error` go into `status.md`, not the envelope;
- reviewer `assessment`, `achieved`, `issues`, and `evidence_card_ids` go into `review.md`, not the envelope;
- reviewer evidence is prose in `review.md`; the runtime does not parse it to validate card IDs.
- `system://` access is represented as a scoped URL on standard tools, available to all agents, logged, and discouraged in prompts in favor of `project://`.
