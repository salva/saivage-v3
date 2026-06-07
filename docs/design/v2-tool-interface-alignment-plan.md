# Saivage v2 Tool Interface Alignment Plan

This plan compares Saivage v2's model-facing non-runtime tool vocabulary with the current Saivage v3 unified tool catalog and proposes how v3 should be reshaped. Runtime access, planning, card creation, card mutation, card control, and operator control-room tools are intentionally excluded.

## Comparison Table

| v2 tool | v2 interface summary | Current v3 equivalent | Mismatch | Planned v3 action |
| --- | --- | --- | --- | --- |
| `read` | `{ path, offset?, limit?, read_mode? }`; reads project files or directories with line/entry windows and optional multimodal images. | `read_project_file { path }`, analyst-only `read_file { path, maxBytes? }`, `list_directory`. | v3 splits file and directory reads, lacks offset/limit/read_mode on project reads, and exposes different names by role. | Replace agent-facing project read tools with one `read` definition and implementation. Keep analyst host-inspection tools separate or outside the agent catalog. |
| `write` | `{ path, content }`; writes project file content. | `write_project_file { path, content }`. | Name differs; policy text differs but behavior is close. | Rename to `write` and keep v3's stricter blocked-path rules. |
| `glob` | `{ directory, pattern, max_results? }`; recursive project file search, skipping `.git` and `node_modules`. | `list_project_files { path?, maxResults? }`. | v3 lists all files under a path and lacks glob pattern matching. | Add `glob` with v2 fields. Remove `list_project_files` from agent-facing vocabulary after replacement. |
| `grep` | `{ pattern, path?, include?, max_results? }`; regex content search under a file or directory. | No direct unified-catalog tool. | Missing core research/coding primitive. | Add `grep` with v2 fields and project-root path confinement. |
| `edit` | `{ path, old_string, new_string, replace_all? }`; exact string replacement in one project file. | No direct unified-catalog tool; only full-file `write_project_file`. | v3 pushes small edits through whole-file writes. | Add `edit` with exact-match semantics and blocked-path rules. |
| `apply_patch` | `{ patch }`; pure unified diff, supports adds/deletes. | No direct unified-catalog tool. | Missing low-friction multi-file edit primitive. | Add `apply_patch` with v2 name and v3 blocked-path enforcement. |
| `run_command` | `{ command, cwd?, timeout_ms?, inactivity_timeout_ms? }`; shell command with log files and capped tail; inactivity timeout preferred. | `run_project_command { command, cwd?, timeoutMs? }`, `start_and_wait { command, cwd?, timeoutMs? }`, analyst-only `run_shell_command { command, cwd?, timeoutMs?, maxOutputBytes? }`. | Name and timeout fields differ; v3 has duplicate process-runner tools and no inactivity timeout. | Collapse agent-facing command execution to `run_command` using snake_case fields. Preserve durable process evidence and add `inactivity_timeout_ms` if the runner supports it, otherwise record it as implementation work. |
| `websearch` | `{ query, max_results? }`; returns candidate URLs/snippets. | No direct unified-catalog tool. | Missing web research primitive except through external MCP wrapper if configured. | Add direct `websearch` or require a built-in MCP server mounted as this exact tool name; prefer direct built-in for stable agent prompts. |
| `webfetch` | `{ url, read_mode?, metadata_only?, max_bytes?, max_inline_bytes?, save_as? }`; bounded HTTP fetch with optional project save. | No direct unified-catalog tool. | Missing web/data fetch primitive except through MCP wrapper if configured. | Add direct `webfetch` with v2 fields, v3 secret/path mutation checks, and explicit save authorization. |
| `git_status` | `{}`; structured modified/added/deleted/untracked lists. | No direct unified-catalog tool. | Git access requires shell or MCP wrapper. | Add direct git read tool with v2 name and envelope. |
| `git_diff` | `{ files?, ref1?, ref2? }`; returns diff text. | No direct unified-catalog tool. | Git access requires shell or MCP wrapper. | Add direct git read tool with v2 name and project-root confinement. |
| `git_log` | `{ n?, branch? }`; returns recent commits. | No direct unified-catalog tool. | Git access requires shell or MCP wrapper. | Add direct git read tool with v2 name. |
| `git_create_branch` | `{ name }`; create and checkout branch. | No direct unified-catalog tool. | Missing branch-control primitive. | Add only if v3 wants agents to own branch lifecycle; otherwise document as intentionally omitted. |
| `git_checkout` | `{ ref }`; checkout branch/ref. | No direct unified-catalog tool. | Potentially disruptive in dirty worktrees. | Require an authorization decision before adding. Do not hide behind generic shell. |
| `git_commit` | `{ files, message, task_id? }`; stages explicit files and commits. | No direct unified-catalog tool. | v3 relies on shell; commit ownership is not modeled as a tool. | Add only after defining v3 commit ownership, card/session attribution, and dirty-worktree policy. |
| `git_merge` | `{ branch }`; merge branch. | No direct unified-catalog tool. | Potential conflict/destructive behavior. | Treat as out of the first implementation wave unless there is a concrete branch workflow. |
| `git_delete_branch` | `{ name }`; delete branch. | No direct unified-catalog tool. | Destructive branch mutation. | Treat as out of the first implementation wave unless there is a concrete branch workflow. |
| `rag_list` | `{}`; list registered RAG collections. | No direct unified-catalog tool. | RAG is not exposed directly in v3 agent catalog. | Add only if v3 ships built-in RAG; otherwise document RAG as absent and remove from prompts. |
| `rag_stats` | `{ collection_id }`; read RAG collection stats. | No direct unified-catalog tool. | RAG is not exposed directly in v3 agent catalog. | Same as `rag_list`. |
| `rag_query` | `{ collection_id, text, topK?, filter? }`; semantic search. | No direct unified-catalog tool. | RAG is not exposed directly in v3 agent catalog. | Same as `rag_list`; this is the highest-value RAG tool if built-in RAG is added. |
| `rag_register` | `{ collection_id, source, provider?, chunker, exclusions?, sources, watch?, persist? }`; admin collection registration. | No direct unified-catalog tool. | RAG admin is absent. | Add only with explicit admin authorization and operator confirmation policy. |
| `rag_ingest` | `{ collection_id }`; ingest registered collection. | No direct unified-catalog tool. | RAG admin is absent. | Add only with RAG implementation and admin policy. |
| `rag_drop` | `{ collection_id, persist? }`; drop collection. | No direct unified-catalog tool. | Destructive RAG admin is absent. | Add only with operator confirmation or deny from autonomous agents. |
| `rag_admin` | `{ collection_id, action }`; `reconcile`, `watch_arm`, `watch_disarm`. | No direct unified-catalog tool. | RAG control plane is absent. | Add only with RAG implementation and admin policy. |
| `skill` | `{ name? }`; omit name to list skills, provide name to load one. | `load_skill { name }`. | v3 cannot list through the same tool and uses a different name. | Replace `load_skill` with `skill`; support omitted `name` for listing. |
| `list_memories` | `{ scope?, topic_domain?, include_archived?, older_than_days? }`. | No direct unified-catalog tool. | Memory knowledge tools are absent. | Add only if v3 has durable knowledge memory, otherwise omit from prompts. |
| `get_memory` | `{ id?, topic? }`. | No direct unified-catalog tool. | Memory knowledge tools are absent. | Same as `list_memories`. |
| `search_memories` | `{ query, scope?, limit? }`. | No direct unified-catalog tool. | Memory knowledge tools are absent. | Same as `list_memories`; highest-value read primitive. |
| `create_memory` | `{ topic, keys?, body, target_agents?, scope, scope_ref?, expires_at?, ttl_ms?, survive_compaction?, source_ref?, reason }`. | No direct unified-catalog tool. | Memory knowledge tools are absent. | Add only with v3 memory lifecycle, ACLs, and compaction semantics. |
| `update_memory` | `{ id, body?, keys?, target_agents?, expires_at?, ttl_ms?, reason }`. | No direct unified-catalog tool. | Memory knowledge tools are absent. | Same as `create_memory`. |

## Out Of Scope

The alignment target excludes v2 and v3 tools whose purpose is runtime orchestration, planning, card creation, card mutation, card control, or operator control-room operation.

Excluded v2 examples: `plan_get`, `plan_get_stage`, `plan_get_current_stage`, `plan_set_stages`, `plan_add_stage`, `plan_remove_stage`, `plan_set_current`, `plan_complete_stage`, `plan_get_history`, `plan_init`, `plan_commit`, `plan_done`, `stage_write_tasks`, `task_write_report`, `stage_write_summary`, `stage_get_run`, `stage_list_reports`, `run_manager`, and `run_inspector`.

Excluded v3 examples: `create_card`, `edit_card`, `reorder_child`, `activate_card`, `cancel_card`, `delete_card`, `restart_card`, `report_goal_done`, `report_goal_failed`, `report_goal_blocked`, `mark_goal_needs_corrections`, `get_card`, `list_cards`, `get_tree`, `get_card_output`, `list_card_history`, `get_card_history_entry`, `diff_card`, `start_project`, `stop_project`, `terminate_process`, `pause_runtime`, `resume_runtime`, `abort_goal_subtree`, `restart_card_or_subtree`, `restart_goal`, `read_runtime_events`, `read_runtime_errors`, `read_control_actions`, `list_processes_tool`, `navigate_workspace`, `navigate_back`, `show_config`, `restart_server`, and `reconfigure`.

## Target Shape

The v3 agent-facing non-runtime vocabulary should be small and direct:

- Filesystem/editing: `read`, `write`, `glob`, `grep`, `edit`, `apply_patch`.
- Command execution: `run_command`.
- Web/data access: `websearch`, `webfetch`.
- Git read tools: `git_status`, `git_diff`, `git_log`.
- Optional git mutation tools: `git_create_branch`, `git_checkout`, `git_commit`, `git_merge`, `git_delete_branch`, gated by explicit authorization policy.
- Optional RAG tools: `rag_list`, `rag_stats`, `rag_query`, `rag_register`, `rag_ingest`, `rag_drop`, `rag_admin`, only if v3 has built-in RAG.
- Skill access: `skill`.
- Optional memory tools: `list_memories`, `get_memory`, `search_memories`, `create_memory`, `update_memory`, only if v3 has durable knowledge memory.

The model-facing names should not be aliases. Replace the old v3 names in the catalog rather than keeping both `read_project_file` and `read`, or both `load_skill` and `skill`.

## Implementation Sequence

1. Introduce v2-named definitions in `src/tools/definitions/index.ts` through focused modules, not by extending `mcp_tool_call`.
2. Replace workspace tool definitions in `src/tools/workspace-tools.ts` so executor/reviewer/planner project access uses `read`, `write`, `glob`, `grep`, `edit`, `apply_patch`, and `run_command`.
3. Remove `list_project_files`, `read_project_file`, `write_project_file`, `run_project_command`, and `start_and_wait` from agent-facing role lists once their replacements are implemented.
4. Replace `load_skill` with `skill` in `src/tools/mcp-skill-tools.ts`; support listing when `name` is omitted.
5. Add direct web tools or a built-in server bridge that registers exact `websearch` and `webfetch` names in the unified catalog.
6. Add git read tools first. Defer git mutation tools until branch/commit ownership and authorization are explicitly specified.
7. Decide whether v3 owns built-in RAG and memory. If yes, add exact v2 tool names with v3 lifecycle/ACL semantics. If no, remove those names from prompts and role expectations.
8. Update prompt templates, role policies, tests, and docs to mention only the new v2-aligned names.
9. Add catalog tests asserting the final role tool names and JSON schemas for each non-runtime tool.

## Open Decisions

- Whether v3 should implement built-in RAG/memory now or intentionally omit those v2 capabilities.
- Whether git mutation tools belong to autonomous agents or only to an operator-mediated workflow.
- Whether `run_command` should support v2's `inactivity_timeout_ms` immediately or whether the process runner needs a prerequisite timeout refactor.
- Whether analyst host-inspection tools should retain their current names outside the agent-facing compatibility surface.
