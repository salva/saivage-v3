# Tool Set Reorganization Design

Status: current design proposal.

Date: 2026-06-30

## 1. Purpose

Unify the fragmented Saivage v3 tool vocabulary into one coherent tool set that merges the best of v2's OpenCode-aligned naming with v3's card-centered runtime architecture. The previous partial migration left both old and new names in the catalog; nothing was removed. This document specifies the final single tool set, which tools to remove, which to add, and how they map to roles.

## 2. Context

### Background

Saivage v2 had ~50 tool names optimized for a manager/worker dispatch hierarchy. v2 then realigned to mimic the OpenCode builtins (`read`, `write`, `edit`, `apply_patch`, `glob`, `grep`, `webfetch`, `websearch`, `skill`, `run_command`) so standard LLMs — pretrained on those tool interfaces — would perform better. That alignment was fully completed in v2 and documented in `saivage/docs/internals/remediation/opencode-aligned-builtin-tools-plan.md`.

Saivage v3 started with native workspace tools (`read_project_file`, `list_project_files`, `run_project_command`, `load_skill`) plus a richer card lifecycle / analyst control surface. A partial port (`docs-old/design/priority-tool-port-implementation-plan.md` and `docs-old/design/v2-tool-interface-alignment-plan.md`) added the v2 names (`read`, `write`, `glob`, `grep`, `edit`, `apply_patch`, `websearch`, `webfetch`, `skill`) into the v3 catalog but **did not remove the old names** — both co-exist, doubling the surface and creating drift.

### Why Standard Tool Names Matter

LLM training corpora now include vast numbers of examples using GitHub Copilot, Claude Code, OpenCode, and similar assistant toolsets. Their canonical tool names and argument shapes are highly familiar to frontier models. Adhering to those names reduces the model's chance of hallucinating arguments, calling a nonexistent tool, or needing multiple turns to discover the right surface.

This is not about copying OpenCode's architecture. It is about using model-friendly names where they already exist.

### Current v3 Tool Catalog (58 entries)

The catalog in `src/tools/definitions/index.ts` currently exposes 58 tool names, of which:

- ~6 filesystem/web/skill tools are **partially migrated** (both old and new names present):
  `read`/`read_file`, `write`/`write_file`, `glob`/`list_directory`, `grep`, `edit`, `apply_patch`, `run_project_command`/`run_shell_command`, `websearch`, `webfetch`, `skill`
- ~4 process tools are **duplicated** across catalog and actor runtime:
  `run_process`/`run_project_command`/`start_and_wait`, `wait_process`/`wait_for_process`, `inspect_process`, `kill_process`
- ~29 are analyst-only / operator runtime control surface (not affected by this reorg)
- ~9 are card lifecycle / planner-control (not affected by this reorg)
- 0 git, 0 memory, 0 RAG, 0 notes (deferred capabilities)

### Key Findings From The Half-Done Migration

1. **Dual names confuse the model.** Both `read` and `read_file` exist; the model sees both depending on context. The spec required old names be removed (`priority-tool-port-implementation-plan.md` line 17: "Add tests that fail if both old and new names are exposed together" — still unimplemented).

2. **Process tools are forked.** The catalog declares `run_project_command`/`start_and_wait`/`wait_for_process`/`kill_process` as workspace tools (no executor field, excluded from `AGENT_TOOL_DEFINITIONS`), while the executor actor defines its own `run_process`/`wait_process`/`inspect_process`/`kill_process` inline. The catalog entries never fire. This is dead code.

3. **Web tools are unreachable from agents.** `websearch` and `webfetch` are in the catalog with `roles: [planner, executor, reviewer]` but no actor surface actually exposes them. The analyst surface excludes them (not in `roles`). They exist but no agent can call them today.

4. **Reviewer has no write capability by design** but the catalog gives it `write`/`edit`/`apply_patch` in `roles`. The actor runtime filters these out correctly, but the catalog is misleading.

5. **Git, memory, RAG, notes are absent.** v2 has them. v3 has none. v3 relies on `run_shell_command` for git and on the records subsystem (`record://status.md`, `record://brief.md`, `record://review.md`) for durable notes.

6. **Analyst catalog is oversized but coherent.** The 29+ analyst tools follow a different dispatch path (`runAuditedAnalystTool`), are properly role-filtered, and the Analyst Surface Alignment (Stage 002) shipped. This surface is not the problem; it just needs its vocabulary cleaned up where it overlaps with agent-facing tools.

## 3. Design Principles

1. **One tool catalog.** No parallel definitions. No dead catalog entries. No actor-inline definitions that duplicate catalog names. The catalog is the single source of tool schemas; actor runtime surfaces are curated subsets of it.

2. **Standard names where they exist.** Use the OpenCode/Copilot-Claude canonical names (`read`, `write`, `edit`, `apply_patch`, `glob`, `grep`, `webfetch`, `websearch`, `skill`, `run_command`) for the high-frequency primitives LLMs are trained on. Remove the v3-specific alternatives (`read_file`, `write_file`, `list_directory`, `read_file_metadata`, `run_shell_command`, `run_project_command`, `start_and_wait`, `load_skill`).

3. **Names describe agent intent, not internal services.** `run_process` is a Saivage runtime concept; for the model, shell execution is `run_command`. Saivage's internal process lifecycle (durable runner, owner activation, log files) is an implementation, not a separate tool.

4. **Role surfaces are curated subsets, not role-tagged catalog filters.** The actor runtime owns which tools each role actually sees; the catalog's `roles` field is advisory and must not be trusted to reflect runtime wiring.

5. **No aliases, no shims, no compatibility.** Per v3 architecture rules, removing a name removes it. Persisted sessions with stale references are invalid; runtime repair handles the failure, not compatibility code.

6. **Defer capabilities v3 doesn't own yet.** Git, memory, RAG, and notes are not added in this reorg. v3 doesn't have built-in RAG infra, durable knowledge memory, or a note inbox. Adding the tool name without the subsystem would lie to the model. They are explicitly listed as future work in section 9.

7. **Analyst surface is separate.** The Analyst has its own dispatch path and a control-surface vocabulary that doesn't need to match the agent vocabulary. Host-inspection tools (`read_file`, `list_directory`, `run_shell_command`) are legitimate Analyst-only tools; they are NOT renamed to `read`/`glob`/`run_command` because they have different scope (host-wide, not project-scoped) and different authorization (audited analyst control actions).

## 4. Target Tool Set

### 4.1 Agent-Facing Tools (planner / executor / reviewer)

These are the tools autonomous agents see. Names follow the OpenCode-aligned convention where a direct equivalent exists.

| Tool | Args | Roles | Replaces | Notes |
| --- | --- | --- | --- | --- |
| `read` | `path`, `offset?`, `limit?`, `read_mode?` | P, E, R | `read_project_file`, analyst `read_file` stays separate | Reads project files/dirs. Bounded. Truncation metadata. Optional multimodal. |
| `write` | `path`, `content` | P, E | `write_project_file` | Create/replace project files. Blocked paths enforced. |
| `edit` | `path`, `old_string`, `new_string`, `replace_all?` | P, E | (new in v3) | Exact string replacement. Single file. |
| `apply_patch` | `patch` | E | (new in v3) | Unified diff. Validates before applying. Executor only. |
| `glob` | `directory`, `pattern`, `max_results?` | P, E, R | `list_project_files`, `list_directory` (analyst keeps its own) | Recursive file discovery. Skips blocked paths. |
| `grep` | `pattern`, `path?`, `include?`, `max_results?` | P, E, R | (new in v3) | Regex content search. Confined to project root. |
| `run_command` | `command`, `cwd?`, `timeout_ms?`, `inactivity_timeout_ms?` | E | `run_project_command`, `start_and_wait`, `run_process`, `wait_process`, `inspect_process`, `kill_process` | Single shell execution tool. Process management (start, wait, inspect, kill) collapses into this plus `wait_process` and `kill_process` when the model needs background control. See §4.2. |
| `websearch` | `query`, `max_results?` | P, E, R | (wire into actor surfaces) | Web search. Currently in catalog but not exposed to actors. |
| `webfetch` | `url`, `read_mode?`, `metadata_only?`, `max_bytes?`, `save_as?` | P, E, R | (wire into actor surfaces) | Bounded HTTP fetch. Private-IP egress blocked. |
| `skill` | `name?` | E, R | `load_skill` | List skills (no arg) or load one (with name). |

### 4.2 Process Management Sub-Surface (executor)

The executor needs background process control for long-running commands (dev servers, watchers). v3 currently has four inline actor tools (`run_process`, `wait_process`, `inspect_process`, `kill_process`) plus four dead catalog entries. Collapse to three:

| Tool | Args | Replaces | Notes |
| --- | --- | --- | --- |
| `run_command` | `command`, `cwd?`, `timeout_ms?`, `inactivity_timeout_ms?`, `wait?` | `run_process`, `run_project_command`, `start_and_wait` | `wait: true` (default) runs to completion. `wait: false` starts in background and returns `process_id`. |
| `wait_process` | `process_id`, `timeout_ms?` | `wait_process`, `wait_for_process` | Wait for a background process. |
| `kill_process` | `process_id`, `signal?` | `kill_process` (both variants), `inspect_process` | Kill or signal a background process. `inspect_process` is folded in: without `signal`, returns process state; with `signal`, terminates. |

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
| `restart_card` | P | Restart a terminal card. |
| `reorder_child` | P, A | Reorder children of a non-running parent. |
| `queue_notification` | P, A | Queue a notification for a future agent session. |

Goal reporting (terminal contract tools) stay as-is:
`report_goal_done`, `report_goal_failed`, `report_goal_blocked` (planner-only terminal tools).

### 4.4 Inspection Tools (shared by P, E, R, A)

| Tool | Roles | Notes |
| --- | --- | --- |
| `list_cards` | P, A | List/filter cards. |
| `get_card` | P, A | Full card detail with children + record summaries. |
| `get_tree` | P, A | Card tree. |
| `list_card_history` | P, E, R, A | Card version headers. |
| `get_card_history_entry` | P, E, R, A | Specific card version snapshot. |
| `diff_card` | P, E, R, A | Field-level diff between card versions. |

`get_plan_diary` and `get_status` remain Analyst-only.

### 4.5 Analyst-Only Tools (not affected by this reorg)

The Analyst control surface keeps its own vocabulary. These tools are **not** renamed because they have different scope, authorization, and dispatch paths:

| Current name | Scope | Why it stays |
| --- | --- | --- |
| `read_file` | Host-wide, audited | Reads any host file the service can see, including `record://`. Different from project-scoped `read`. |
| `read_file_metadata` | Host-wide | Metadata-only. No agent equivalent. |
| `write_file` | `record://` only | Writes closed card records, not project files. Different from project-scoped `write`. |
| `list_directory` | Host-wide | Lists any host directory. Different from project-scoped `glob`. |
| `run_shell_command` | Host-wide, audited | Bounded inspection shell. Different from project-scoped `run_command`. |

The remaining analyst tools (`start_project`, `stop_project`, `terminate_process`, `pause_runtime`, `resume_runtime`, `abort_goal_subtree`, `restart_card_or_subtree`, `restart_goal`, `navigate_workspace`, `navigate_back`, `read_runtime_events`, `read_runtime_errors`, `read_control_actions`, `list_processes_tool`, `list_agent_sessions`, `read_agent_session`, `show_config`, `reconfigure`, `restart_server`, `queue_notification`, `mark_goal_needs_corrections`) keep their current names. They are operator control surface tools, not agent workspace tools.

### 4.6 External MCP Wrapper

| Tool | Roles | Notes |
| --- | --- | --- |
| `mcp_tool_call` | E, R | Call a tool on a configured MCP server. |

Unchanged. External MCP tools are the extension point; they use their own names via this wrapper.

## 5. Removals

The following names are removed from the catalog. They are either duplicates of the standard names, dead code, or unused:

| Removed name | Replaced by | Reason |
| --- | --- | --- |
| `read_file_metadata` (workspace) | — | Not a standard primitive; only the Analyst host-inspection variant stays. |
| `write_file` (workspace) | `write` | Project-scoped write uses the standard name. Analyst `write_file` stays. |
| `list_directory` (workspace) | `glob` | Project file discovery uses `glob`. Analyst `list_directory` stays. |
| `run_shell_command` (workspace) | `run_command` | Agent shell execution uses the standard name. Analyst `run_shell_command` stays. |
| `run_project_command` | `run_command` | Same concept, v3-specific name. |
| `start_and_wait` | `run_command` with `wait: true` | Redundant with `run_command`. |
| `wait_for_process` | `wait_process` | Dead catalog entry; actor had its own. |
| `kill_process` (catalog variant with `signal`) | `kill_process` | Merge the two variants into one with optional `signal`. |
| `inspect_process` | `kill_process` (no signal = inspect) | Folded: `kill_process` without `signal` returns state. |
| `run_process` (actor-inline) | `run_command` with `wait: false` | Background start is `run_command` with `wait: false`. |
| `wait_process` (actor-inline) | `wait_process` (catalog) | Move from inline to catalog. |
| `read_file` (workspace) | `read` | If a workspace `read_file` exists separate from analyst. Audit needed. |
| `load_skill` | `skill` | Standard name. |

## 6. Role Tool Surfaces

The actor runtime exposes curated subsets. The catalog's `roles` field is updated to match reality.

### Planner

| Category | Tools |
| --- | --- |
| Card control | `create_card`, `edit_card`, `cancel_card`, `activate_card`, `reorder_child`, `queue_notification` |
| Filesystem (read-only) | `read`, `glob`, `grep` |
| Inspection | `list_cards`, `get_card`, `get_tree`, `list_card_history`, `get_card_history_entry`, `diff_card` |
| Web | `websearch`, `webfetch` |
| Terminal | `report_goal_done`, `report_goal_failed`, `report_goal_blocked` |

Planner does **not** get `write`, `edit`, `apply_patch`, `run_command`, `skill`, or `mcp_tool_call`. The planner coordinates; it does not write code or run commands.

### Executor

| Category | Tools |
| --- | --- |
| Filesystem | `read`, `write`, `glob`, `grep`, `edit`, `apply_patch` |
| Shell | `run_command`, `wait_process`, `kill_process` |
| Web | `websearch`, `webfetch` |
| Skill | `skill` |
| MCP | `mcp_tool_call` |
| Inspection | `list_card_history`, `get_card_history_entry`, `diff_card` |
| Terminal | `emit_executor_result` |

### Reviewer

| Category | Tools |
| --- | --- |
| Filesystem (read-only) | `read`, `glob`, `grep` |
| Web | `websearch`, `webfetch` |
| Skill | `skill` |
| MCP | `mcp_tool_call` |
| Inspection | `list_card_history`, `get_card_history_entry`, `diff_card` |
| Terminal | `emit_reviewer_result` |

Reviewer does **not** get `write`, `edit`, `apply_patch`, or `run_command`. The reviewer evaluates; it does not modify.

### Analyst

Unchanged from the current shipped Stage 002 alignment, except:
- workspace duplicates removed from the catalog (no effect on analyst dispatch since it uses its own tools)
- `read_file`, `write_file`, `list_directory`, `run_shell_command`, `read_file_metadata` remain as Analyst-only host-inspection tools

## 7. Schema Contracts

All tool schemas use snake_case field names to match the OpenCode/Copilot convention LLMs expect.

| Tool | Schema | Result shape |
| --- | --- | --- |
| `read` | `path: string, offset?: number, limit?: number, read_mode?: 'auto'\|'text'\|'multimodal'` | File: `{ path, content, offset, limit, total_lines, truncated }`. Dir: `{ path, entries, offset, limit, total_entries, truncated }`. |
| `write` | `path: string, content: string` | `{ path, bytes, written: true }` |
| `edit` | `path: string, old_string: string, new_string: string, replace_all?: boolean` | `{ path, replacements, bytes, edited: true }` |
| `apply_patch` | `patch: string` | `{ changed_files, applied: true }` |
| `glob` | `directory: string, pattern: string, max_results?: number` | `{ directory, pattern, matches, truncated }` |
| `grep` | `pattern: string, path?: string, include?: string, max_results?: number` | `{ pattern, matches, truncated }` (match: `{ path, line, preview }`) |
| `run_command` | `command: string, cwd?: string, timeout_ms?: number, inactivity_timeout_ms?: number, wait?: boolean` | `wait: true` → `{ exit_code, stdout, stderr, truncated, log_path? }`. `wait: false` → `{ process_id, running: true }`. |
| `wait_process` | `process_id: string, timeout_ms?: number` | `{ exit_code, stdout, stderr, truncated, log_path? }` or `{ process_id, still_running: true }` on timeout. |
| `kill_process` | `process_id: string, signal?: string` | Without signal: `{ process_id, status, pid, command, running }`. With signal: `{ process_id, terminated: true }`. |
| `websearch` | `query: string, max_results?: number` | `{ query, results: [{ title, url, snippet }], skipped? }` |
| `webfetch` | `url: string, read_mode?: 'auto'\|'text'\|'multimodal', metadata_only?: boolean, max_bytes?: number, save_as?: string` | Metadata: `{ status, headers }`. Text: `{ content, truncated, saved_path? }`. |
| `skill` | `name?: string` | No name: `{ skills: [{ name, description }] }`. With name: skill content. |

## 8. Security Policy

All filesystem tools share one path policy:
- Project-agent paths must resolve inside the configured project root.
- Secret-bearing paths and blocked runtime/credential paths are invisible to `glob`, `grep`, and directory reads.
- Direct access to a blocked path fails with a permission error.
- Mutating tools reject blocked paths, `.saivage`, `.saivage-work`, symlink targets outside root, and credential files.

Web tools share one egress policy:
- Only `http` and `https`.
- DNS and every redirect target checked against private/internal/metadata ranges.
- Response size, header size, redirect count, and inline text size are bounded.
- `webfetch` with `save_as` uses the same write authorization as `write`.

Process tools share one ownership policy:
- Background processes are owned by the card activation that started them.
- `wait_process` and `kill_process` can only act on processes owned by the current activation.
- Process IDs are scoped to the activation, not global.

## 9. Deferred Capabilities

These v2 capabilities are not added in this reorg because v3 does not have the supporting subsystem. Adding the tool name without the subsystem would lie to the model.

| Capability | v2 tools | v3 status | Decision |
| --- | --- | --- | --- |
| Git | `git_status`, `git_diff`, `git_log`, `git_create_branch`, `git_checkout`, `git_commit`, `git_merge`, `git_delete_branch` | None; agents use `run_command` for git | Defer. Add `git_status`, `git_diff`, `git_log` as read-only tools once there is a concrete need for structured git state beyond shell. Git mutations stay behind explicit authorization. |
| Memory | `create_memory`, `update_memory`, `supersede_memory`, `archive_memory`, `delete_memory`, `list_memories`, `get_memory`, `search_memories` | None; v3 uses record slots (`status.md`, `review.md`) and `queue_notification` | Defer. Add only if v3 introduces a durable cross-session knowledge memory subsystem. |
| RAG | `rag_list`, `rag_stats`, `rag_query`, `rag_register`, `rag_ingest`, `rag_drop`, `rag_admin` | None; v3 has no built-in RAG | Defer. Add only with a v3-native RAG implementation. |
| Notes | `create_note` | None; v3 uses `record://` and `queue_notification` | Defer. Not currently needed. |

## 10. Implementation Phases

### Phase 1: Remove duplicates and dead code

- Remove `run_project_command`, `start_and_wait`, `wait_for_process`, `inspect_process` from the catalog.
- Remove the actor-inline `run_process`/`wait_process`/`inspect_process`/`kill_process` definitions; move `wait_process` and `kill_process` into the catalog.
- Add `run_command` to the catalog with the `wait` parameter; wire it into the executor actor as the unified shell tool.
- Remove `read_file_metadata` from the workspace tools (keep analyst variant).
- Remove `list_directory` from the workspace tools (keep analyst variant).
- Remove `run_shell_command` from the workspace tools (keep analyst variant).
- Remove `load_skill`; ensure `skill` supports both list and load.
- Update all tests that reference removed names.
- Add negative tests asserting removed names are absent from agent-facing surfaces.

### Phase 2: Wire web tools into actor surfaces

- Add `websearch` and `webfetch` to the planner, executor, and reviewer actor tool bundles in `actor-tool-definitions.ts`.
- They already exist in the catalog; they just need to be exposed.

### Phase 3: Align catalog `roles` with actual wiring

- Update `roles` field on every catalog entry to match what the actor runtime actually exposes.
- Reviewer: remove `write`, `edit`, `apply_patch` from `roles`.
- Ensure `list_card_history`, `get_card_history_entry`, `diff_card` are wired into the executor and reviewer actor surfaces (currently in `roles` but not offered by the actors).

### Phase 4: Align analyst workspace tool names with host-scope semantics

- Confirm `read_file`, `write_file`, `list_directory`, `run_shell_command`, `read_file_metadata` in the catalog are Analyst-only and never appear in any agent-facing surface.
- Add tests asserting they are absent from `AGENT_TOOL_DEFINITIONS`, `PLANNER_TOOL_DEFINITIONS`, and all actor tool bundles.

### Phase 5: Update docs and prompts

- Update system prompts to mention only the final tool set.
- Update the conversation UI redesign's Phase 2 note: the tool vocabulary is now aligned.
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
- the reviewer surface does not include `write`, `edit`, or `apply_patch`;
- the catalog `roles` field matches actual actor wiring for every entry;
- analyst-only host-inspection tools (`read_file`, `write_file`, `list_directory`, `run_shell_command`, `read_file_metadata`) never appear in agent-facing surfaces;
- removed names (`run_project_command`, `start_and_wait`, `wait_for_process`, `inspect_process`, `run_process` as a separate tool, `load_skill`, `list_project_files`, `read_project_file`, `write_project_file`) are absent from the catalog and from all actor tool bundles;
- system prompts mention only tools that exist in the final catalog;
- tests assert the final role tool surfaces and fail if removed names reappear;
- the conversation UI redesign's Phase 2 unblocks because the tool vocabulary is aligned.