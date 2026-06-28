# Analyst Tool Surface Review

Status: review.

## Scope

This note reviews the current Analyst tool surface for functional necessity, sufficiency, and organization. It assumes the Analyst is the user's conversational control surface for observing and steering autonomous runtime work, not a delivery agent and not a planner substitute.

Current deployed Analyst tools:

| Group | Tools |
|---|---|
| Card objective steering | `edit_card`, `queue_notification` |
| Card inspection | `list_cards`, `get_card`, `get_tree`, `get_plan_diary`, `get_card_output`, `list_card_history`, `get_card_history_entry`, `diff_card` |
| Runtime inspection | `get_status`, `read_runtime_events`, `read_runtime_errors`, `read_control_actions`, `list_processes_tool`, `list_agent_sessions`, `read_agent_session` |
| Runtime control | `start_project`, `stop_project`, `pause_runtime`, `resume_runtime`, `terminate_process`, `restart_server` |
| Workspace inspection | `read_file`, `list_directory`, `run_shell_command` |
| UI navigation | `navigate_workspace`, `navigate_back` |
| Configuration | `show_config`, `reconfigure` |

The Analyst no longer exposes structural card-management tools such as `create_card`, `delete_card`, `reorder_child`, `abort_goal_subtree`, `restart_card_or_subtree`, `restart_goal`, or `mark_goal_needs_corrections`.

## Findings

### F1. The current authority boundary is correct

The Analyst should be able to steer and inspect any active work, but should not directly own the plan tree. The current surface matches that boundary:

| Capability | Assessment |
|---|---|
| Edit objectives/instructions on existing cards | Keep. This is the minimum direct card mutation needed for operator steering. |
| Queue notifications | Keep. This is the right channel for active sessions that need context without rewriting plan structure. |
| Create/delete/reorder/restart card subtrees | Keep excluded. These are planner/runtime responsibilities and create ownership ambiguity when exposed through Analyst chat. |
| Abort/restart individual goals | Keep excluded from Analyst for now. Runtime control can stop/pause/resume globally; finer structural recovery should be planner-owned. |

This is sufficient for common operator interventions: clarify instructions, update acceptance criteria, change priority/urgency, nudge active agents, pause/resume, and inspect failure evidence.

### F2. Inspection is powerful enough, but the naming is uneven

The inspection surface has enough coverage for real diagnosis:

| Need | Current support | Assessment |
|---|---|---|
| Understand plan shape | `get_tree`, `list_cards`, `get_card` | Sufficient. |
| Understand changes to a card | `list_card_history`, `get_card_history_entry`, `diff_card` | Sufficient. |
| Understand generated process output | `get_card_output`, `list_processes_tool` | Sufficient, but the name `list_processes_tool` is awkward. |
| Understand runtime behavior | `get_status`, `read_runtime_events`, `read_runtime_errors`, `read_control_actions` | Sufficient. |
| Understand agent reasoning/transcripts | `list_agent_sessions`, `read_agent_session` | Sufficient. |
| Inspect project files | `read_file`, `list_directory`, `run_shell_command` | Sufficient, with current secret-path protections. |

The main issue is operator/LLM ergonomics rather than missing power. `list_processes_tool` carries an implementation suffix that other tools do not. Runtime log tools and agent-session tools are separate even though they are all debug evidence sources.

Recommendation: keep behavior, but rename or alias in the next breaking cleanup:

| Current | Preferred |
|---|---|
| `list_processes_tool` | `list_processes` |
| `read_runtime_events` | `read_event_log` |
| `read_runtime_errors` | `read_error_log` |
| `read_control_actions` | `read_control_log` |

No compatibility alias is recommended unless there is a concrete external consumer.

### F3. Runtime control is necessary, but mixed in one prompt class

Runtime control tools are needed for a conversational control surface:

| Tool | Assessment |
|---|---|
| `start_project` | Keep. Required because the Analyst is the primary operator surface. |
| `stop_project` | Keep. Required emergency/intent control. |
| `pause_runtime` / `resume_runtime` | Keep. Better than stop/start for temporary intervention. |
| `terminate_process` | Keep, but emphasize it is for runaway managed processes, not card lifecycle control. |
| `restart_server` | Keep for local deployments, but keep audited and destructive. |

The prompt currently groups these under "Control the runtime", which is accurate. However, the same group mixes gentle control (`pause_runtime`) with destructive control (`stop_project`, `terminate_process`, `restart_server`). The LLM should be prompted to prefer the least disruptive control that satisfies the user's request.

Recommendation: split the prompt-visible class into:

| Class | Tools |
|---|---|
| Runtime lifecycle | `start_project`, `pause_runtime`, `resume_runtime`, `stop_project` |
| Emergency/process control | `terminate_process`, `restart_server` |

This is a prompt/documentation change only unless the UI wants separate sections.

### F4. Workspace inspection is necessary but should remain non-delivery

`read_file`, `list_directory`, and bounded `run_shell_command` are necessary because many runtime failures require inspecting repository files, process logs, package scripts, or generated artifacts. The current safety rule that Analyst shell commands must not mutate source, deploy, run delivery builds/tests, or perform planner/executor work is the correct boundary.

Recommendation: keep all three. Do not add write/edit/apply-patch/build-test tools to the Analyst. If a fix requires delivery work, the Analyst should modify card objectives or notify the active planner/executor rather than doing the work directly.

### F5. Reconfiguration is useful but too broad as a single schema

`show_config` is necessary and appropriately redacted. `reconfigure` is functionally useful for role routing, failover, MCP, runtime, and server settings, but it is a broad union-like tool with many optional parameters. That shape makes invalid calls easier for the model.

Recommendation: keep `reconfigure` for now, but split it during the next config cleanup into narrower tools:

| Proposed tool | Purpose |
|---|---|
| `set_role_routing` | Set one role's model candidate. |
| `set_failover_chain` | Set ordered fallback models for one candidate. |
| `configure_mcp_server` | Add/edit/remove one MCP server. |
| `set_runtime_setting` | Set a runtime setting. |
| `set_server_setting` | Set a server setting and report restart requirement. |

This would reduce schema ambiguity and improve model reliability. Because no backward compatibility is required, the broad tool can be removed when the split lands.

### F6. UI navigation tools are only useful for the web control room

`navigate_workspace` and `navigate_back` are not semantic runtime operations. They are UI commands that help the chat drive the surrounding workspace pane. They are valid on the web surface, but less meaningful elsewhere.

Recommendation: keep them on the web Analyst surface. If surface-specific filtering expands, exclude navigation tools from non-visual surfaces that cannot honor them.

## Missing Capabilities

### M1. A focused "current focus" read tool would reduce ambiguity

The prompt already resolves deictic references against the workspace-context header. A small `get_workspace_focus` tool or explicit focus object in every Analyst request would make references like "this card" more deterministic and testable.

Preferred direction: pass focus context as request metadata instead of adding another model-callable tool. The LLM should not need to ask the runtime what the current focus is if the server already knows it.

### M2. A card notification read model may be useful later

`queue_notification` intentionally has no list/get/ack/delete surface. That is acceptable for ephemeral delivery. If operators later need to audit pending undelivered notifications, add a read-only `list_pending_notifications` tool rather than expanding `queue_notification`.

Do not add this until there is evidence of operator confusion or lost steering context.

### M3. Runtime restart/recovery should stay explicit

The Analyst currently has global runtime control but not card/subtree restart tools. That is intentional. If fine-grained recovery becomes necessary, prefer a planner-owned recovery tool that preserves card ownership and writes a reviewable recovery plan, not an Analyst direct mutation.

## Recommended Target Surface

Keep these tools:

| Group | Tools |
|---|---|
| Card steering | `edit_card`, `queue_notification` |
| Card inspection | `list_cards`, `get_card`, `get_tree`, `get_plan_diary`, `get_card_output`, `list_card_history`, `get_card_history_entry`, `diff_card` |
| Runtime/debug inspection | `get_status`, `read_runtime_events`, `read_runtime_errors`, `read_control_actions`, `list_processes_tool`, `list_agent_sessions`, `read_agent_session` |
| Runtime/process control | `start_project`, `stop_project`, `pause_runtime`, `resume_runtime`, `terminate_process`, `restart_server` |
| Workspace inspection | `read_file`, `list_directory`, `run_shell_command` |
| UI navigation | `navigate_workspace`, `navigate_back` |
| Config | `show_config`, `reconfigure` |

Remove or keep excluded:

| Tool | Reason |
|---|---|
| `create_card` | Planner owns decomposition and card creation. |
| `delete_card` | Structural/destructive tree mutation belongs to planner/runtime recovery. |
| `reorder_child` | Low operator value and planner-owned structure. |
| `abort_goal_subtree` | Direct subtree lifecycle control bypasses planner/runtime ownership. |
| `restart_card_or_subtree` / `restart_goal` | Fine-grained recovery should be planner-owned. |
| `mark_goal_needs_corrections` | Reviewer/planner correction loop should own this semantic transition. |
| Workspace write/edit/apply-patch tools | Analyst must not perform delivery work. |

Prioritized improvements:

1. Split prompt-visible runtime control into `Runtime lifecycle` and `Emergency/process control`.
2. Rename awkward/debug-oriented tool names in the next breaking cleanup, especially `list_processes_tool`.
3. Split `reconfigure` into narrower schema-specific tools.
4. Pass workspace focus as explicit request metadata so deictic references are deterministic.
5. Add read-only pending-notification inspection only if operators need it.

## Conclusion

The current Analyst tool surface is functionally sufficient and now has the right ownership boundary. The next work should be mostly ergonomic: clearer capability grouping, cleaner names, narrower configuration schemas, and stronger focus-context plumbing. No structural card mutation tools should be reintroduced to the Analyst surface without a concrete product requirement.
