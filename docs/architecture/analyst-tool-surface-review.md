# Analyst Tool Surface Review

Status: review. Authoritative behavior contract: [`docs/spec/system-specification.md`](../spec/system-specification.md), [`docs/spec/operator-ui.md`](../spec/operator-ui.md), [`docs/architecture/system-architecture.md`](./system-architecture.md), and [`docs/architecture/micro-actor-runtime-design.md`](./micro-actor-runtime-design.md). This review proposes tool organization and identifies implementation gaps; where this review conflicts with those documents, they win.

## Scope

The Analyst is the user-facing control surface for the autonomous runtime. It is not a delivery agent and not a planner substitute. The specs fix the Analyst's authority precisely:

- §5 line 117: the Analyst "may edit the objectives, instructions, acceptance criteria, and descriptive metadata of any existing card, and it may queue card-addressed notifications. It must not directly create, reorder, cancel, delete, restart, archive, replace, move, or rewrite lifecycle/output state for cards. Structural card management belongs to planners and runtime lifecycle controls."
- §13 line 254–265 enumerates the Analyst's mandatory tasks.
- §11 line 209 grants the Analyst a separate cancellation-initiation right (collaborative).
- §16 line 298 grants the Analyst process inspection and termination.
- §13 line 342 authorizes restart-via-chat when a config change requires it.
- `system-architecture.md` §3 and §6 establish that the runtime is the only dispatcher; card edits do not dispatch work, and Analyst mutations go through canonical services.
- `micro-actor-runtime-design.md` §External Command Mapping requires Analyst/operator commands to map to supervisor/card public methods, not to internal actor hooks or workflow logic.

This review does not redefine the Analyst's authority. It accepts the spec boundary as authoritative and reviews only (a) tool organization/ergonomics within that boundary, and (b) implementation gaps where the live tool surface does not satisfy a spec-required capability.

### Runtime coordination rules

These coordination rules are the hard limits on any Analyst tool:

| Rule | Consequence for Analyst tools |
|---|---|
| Runtime is the only autonomous dispatcher (`system-architecture.md` §3). | No Analyst card mutation may start work directly. It may only update durable card state, queue notifications, or call runtime lifecycle commands. |
| Public command surfaces map to actor public methods (`micro-actor-runtime-design.md` §External Command Mapping). | Tools may call `RuntimeSupervisorActor.run/pause/shutdown/cancelProject()` or `CardActor.cancel()` through the runtime boundary; they must not run workflow logic, call internal hooks, or reinterpret card outcomes. |
| `activate_card` is parent-planner-owned. | Analyst must not activate children or otherwise step through the card tree on behalf of planners. |
| Running cancellation is best-effort notification-driven. | Analyst can request cancellation, but cannot force running card status, kill arbitrary work as cancellation, or treat a cancellation request as a terminal outcome. |
| Notifications are ephemeral delivery items. | Analyst can queue notifications and inspect delivery through sessions/events; it cannot manage a notification inbox. |
| Pause is an admission gate, not a card state. | Analyst pause tools must not mutate card lifecycle state or process records. |

### Operator intent model

The Analyst must support these operator intents (frequency order) per §13:

| Intent | Spec source |
|---|---|
| I1. "What's happening right now?" | §13 "inspect cards, runtime state, runtime events, errors, control actions, agent sessions, process registry, process logs…" |
| I2. "Why did card X fail/block?" | Same inspection set; diagnose-by-correlation §13 line 264. |
| I3. "Change what the active agent should do" | edit existing card objective/instructions/acceptance; queue card-addressed notifications. |
| I4. "Stop / pause / resume / shutdown" | §7 Run/Pause/Shutdown. |
| I5. "Request cancellation for work that should not continue" | §11: cancellation initiated by Analyst, collaborative when target is running. |
| I6. "Steer routing / MCP / runtime / server settings" | §13 line 263 + §13 reconfigure block. |
| I7. "Did my nudge get delivered?" | §12 line 250: confirm by inspecting `read_agent_session`. |
| I8. "Add a new independent goal" | Spec resolution below; **not** an Analyst `create_card`. |

This model is derived from the specs; intents not present in §13 are out of scope for this surface.

### Current deployed Analyst tools (post `restrict card mutation tools`)

| Group | Tools |
|---|---|
| Card objective steering | `edit_card`, `queue_notification` |
| Card inspection | `list_cards`, `get_card`, `get_tree`, `get_plan_diary`, `get_card_output`, `list_card_history`, `get_card_history_entry`, `diff_card` |
| Runtime inspection | `get_status`, `read_runtime_events`, `read_runtime_errors`, `read_control_actions`, `list_processes_tool`, `list_agent_sessions`, `read_agent_session` |
| Runtime control | `start_project`, `stop_project`, `pause_runtime`, `resume_runtime`, `terminate_process`, `restart_server` |
| Workspace inspection | `read_file`, `list_directory`, `run_shell_command` |
| UI navigation | `navigate_workspace`, `navigate_back` |
| Configuration | `show_config`, `reconfigure` |

## Findings

### F1. Authority boundary: spec is authoritative; one implementation gap exists

Spec §5 line 117 is unambiguous: the Analyst does not create cards. The earlier-draft proposal to add a "goal-scoped `create_card`" for the Analyst **violates the spec and is rejected**.

The I8 "add a new independent goal" scenario is real (an operator wants a new top-level goal while the runtime is busy on a subtree), but the spec resolves it deliberately: top-level goals are children of the `project` card and are created by the project's planner during its planning turn. The Analyst's path to influence that is §5 line 91–93: edit the `project` card's objective/instructions to declare the new intent, and queue notifications to the active project planner chain so the change is observed. If there is no active project planner, the operator runs/pauses via §7 controls so the next root activation picks up the updated project objective.

This is the documented contract. The review's job is not to propose breaking it.

**Implementation gap (not authority gap):** `edit_card` on the `project` card works today, but the prompt and the tool surface do not *call out* the project card as a first-class steering knob for I8. The fix belongs in prompt/UX guidance, not in a new tool.

### F2. A spec-required capability is missing: cancellation-initiation

Spec §11 line 209: "Cancellation can be initiated by the Analyst or by the parent planner responsible for the target card. Cancellation is collaborative when the target is running."

The earlier "restrict card mutation tools" change removed `abort_goal_subtree`, `restart_card_or_subtree`, `restart_goal`, and `mark_goal_needs_corrections` from the Analyst surface. The first three had to go (§11 line 229: "Abort is not a separate required user capability. Restart/reset of planner state is not a required user capability"). **But removal overshot by dropping the Analyst's cancellation-initiation capability, which §11 line 209 explicitly requires.**

The spec's cancellation is collaborative, not a force-at-cancel:
- If the target is not `running`, the runtime may mark it `cancelled` directly.
- If the target is running, the runtime queues cancellation-request notifications down the active chain and agents voluntarily stop at the next safe point and report `failed` (§11 lines 217–227).

`system-architecture.md` §9 and `micro-actor-runtime-design.md` §Pause, Cancellation, And Shutdown sharpen the limit: running cancellation is best-effort, notification-driven, and leaves the public card status `running` until the running agent reports an actual outcome. Best-effort cancellation does not close provider admission, block child activation, kill processes, abort tool waits, or reinterpret late results. Shutdown remains the hard operation for forcibly terminating runtime-owned work.

So the missing tool should be named `request_card_cancellation`, not `cancel_card`. The name should make clear that the Analyst requests cancellation through the runtime boundary; it does not directly write `cancelled` status for running cards. The tool must map only to:

| Target | Runtime method |
|---|---|
| Project card | `RuntimeSupervisorActor.cancelProject()` |
| Non-project card/subtree | `CardActor.cancel()` through the runtime command boundary |

Recommendation: add `request_card_cancellation` to the Analyst surface, scoped to the runtime's cancellation path per §11. This is a **bug fix against spec**, not a new affordance. Its result should report the runtime-mediated effect: inactive subtree cancelled immediately, or running-chain cancellation notifications queued, with no direct terminal outcome claim.

### F3. Lifecycle controls must align with §7's Run/Pause/Shutdown, not with implementation tools

Spec §7 says the user sees three lifecycle controls: **Run, Pause, Shutdown**. Implementation may keep separate internal commands. The current six tools map to that surface as:

| Spec control | Current tools |
|---|---|
| Run | `start_project`, `resume_runtime` (unified under §7 line 135: "Implementation may keep separate internal commands … the Analyst should present a unified user concept: 'run/continue the system.'") |
| Pause | `pause_runtime` |
| Shutdown | `stop_project` (per §7 line 147, Shutdown = pause + terminate running processes) |

Separately per §16 line 298, the Analyst "may inspect process state and terminate a live runtime process when the canonical process control supports it." That authorizes `terminate_process` as a *single-process* escape hatch distinct from project-wide Shutdown.

`restart_server` is justified by §13 line 342: "If a restart is required, the Analyst must say so and ask before restarting." It is a config-flow companion to `reconfigure`, not a lifecycle control.

Recommendation: keep all six implementation tools, but realign the **prompt-visible grouping** with the spec:

| Class | Tools | Default preference |
|---|---|---|
| Run / continue | `start_project`, `resume_runtime` | Prefer as the default "continue the system" pair. |
| Pause | `pause_runtime` | Prefer over shutdown for temporary intervention. |
| Shutdown | `stop_project` | Destructive; confirm conversationally (§13 line 269). |
| Single-process control | `terminate_process` | Only for a specific runaway runtime process; not card lifecycle. |
| Config-required restart | `restart_server` | Only when a `reconfigure` action reports `requires_restart`; confirm before executing (§13 line 342). |

This removes the spec-groundless "emergency/process control" class from the earlier draft and demotes `restart_server` precedence strictly to the config-flow case the spec defines it for.

The tool implementations must also preserve `system-architecture.md` §6 and `micro-actor-runtime-design.md` §External Command Mapping: `start_project`/`resume_runtime` call supervisor `run()`, `pause_runtime` calls supervisor `pause()`, and `stop_project` maps to supervisor `shutdown()`. None of these tools should inspect card state and advance workflow manually.

### F4. Workspace inspection is necessary and stays non-delivery

Spec §13 line 256 explicitly requires the Analyst to "inspect … directory listings, file contents, configuration, credentials, and secret-bearing state when needed." §13 line 36 / §15 make clear the Analyst does not edit source, run delivery builds, or deploy. `read_file`, `list_directory`, and bounded `run_shell_command` are all required and correctly bounded by the existing secret-path and classification guards.

`read_file`/`list_directory` vs. `run_shell_command` overlap with `cat`/`ls`/`head`, but the structured tools return byte-safe, secret-guarded, truncated structured output the shell tool does not. Keep all three.

Do not add write/edit/apply-patch/build-test tools to the Analyst per §13 line 36. If a fix requires delivery work, the Analyst edits card objectives or notifies the active planner/executor.

### F5. `reconfigure` should split into discriminated tools per §13's enum

Spec §13 lines 263 + 334–342 enumerate exactly five distinct reconfigure actions: role routing, failover, MCP entries, runtime settings, server settings. `reconfigure` exposes all five as one broad union schema, which is the wrong shape for an LLM-targeted tool.

Recommended split (~4 tools, each discriminated):

| Proposed tool | Actions covered |
|---|---|
| `set_routing` | `set_role_routing`, `set_failover_chain` |
| `configure_mcp_server` | `mcp_add` / `mcp_edit` / `mcp_remove` (one tool with an `action` field) |
| `set_runtime_setting` | runtime settings |
| `set_server_setting` | server settings (reports `requires_restart` per §13 line 342) |

No compatibility alias is required; remove the broad `reconfigure` when the split lands. This stays well inside §13's enumerated actions and does not add any authority the spec does not already grant.

### F6. Navigation is a required Analyst capability; only its *implementation shape* is in question

Spec §14 line 280 and `operator-ui.md` §6 make Analyst-driven workspace navigation a **required** Analyst capability. The earlier draft's framing that navigation "does not belong in the model tool list" was wrong about authority; navigation *must* stay an Analyst capability.

What *is* a legitimate question is *implementation shape*: `navigate_workspace` / `navigate_back` currently return `{ intent: '...' }` with no data. A data-less tool consumes model context and tool-selection budget without returning information. Two valid shapes:

| Shape | Trade-off |
|---|---|
| Keep as model-callable tools | Simple; costs context and a tool-call round-trip for a UI-only signal. |
| Move to a separate UI-command channel the client emits without an LLM round-trip | Cleaner separation; the Analyst still "drives navigation" on the user's behalf per spec, but the model emits a UI command rather than running a tool that returns `intent`-only data. |

Either shape satisfies the spec. The shell-only data-less shape is an implementation choice; this review recommends the second shape (UI-command channel) as the cleaner target but does not treat the current shape as a spec violation.

### F7. Consolidate redundant card-history tools

The Analyst currently has three tools that all read `store.listCardHistory`:

| Tools | Same intent? | Recommendation |
|---|---|---|
| `list_card_history`, `get_card_history_entry`, `diff_card` | Yes (card version history views) | Fold into one `card_history` tool with a `view` enum: `summary` (headers), `entry` (one version), `diff` (between two versions). Three tools → one. |

Spec §13 line 256 requires the Analyst to "inspect cards, runtime state,…" — it does not require the three to be separate tools. Consolidation is inside-spec and reduces the surface count from 31 to 29. Behavior lossless: the consolidated tool's three views are exactly the three current tool shapes.

Reconsider `list_cards` + `get_tree` later: `get_tree` is the privileged shape for plan-shape diagnosis (I1/I2); `list_cards` is the filter view. Both are inside §13 inspection authority. Keep both for now.

### F8. Renames: keep log namespaces, fix only `list_processes_tool`

The earlier draft proposed renaming `read_runtime_events` → `read_event_log` etc. That **strips the `runtime` namespace** that tells the model which log it is tailing, and the current names describe *content* (runtime events, runtime errors, control actions) rather than merely "a log file." Drop that rename.

Only `list_processes_tool` → `list_processes` is justified. The `_tool` suffix is an implementation leak no other tool carries.

### F9. I7 "Did my nudge get delivered?" — spec's solution is `read_agent_session`, not a notification tool

Spec §12 line 242 is explicit: "The platform does not expose a notification inbox, list, get, edit, delete, acknowledge, clear-all, or management UI." The earlier draft's `list_pending_notifications` recommendation **violates the spec and is rejected.**

Spec §12 line 250 gives the privileged path for I7: "Delivery can be confirmed only by inspecting the receiving agent session transcript and seeing whether the content appeared and how the agent responded." That is `read_agent_session`, which the surface already has. No new tool. The `queue_notification` destroy-on-deliver invariant stays intact.

Spec §12 line 244 separately guarantees that pending-ness is observable indirectly: a settled `done` card with pending notifications becomes `changed`, so the pending context re-observes on a later activation. The runtime records delivery markers in runtime diagnostics, which are read through the existing `read_runtime_events` / `read_control_actions` tools. No notification-management surface is required.

### F10. Future capability (not in current spec): usage/cost visibility

A `get_usage` read tool (per-model/per-role token spend, quota state) is not present in spec §13 and is therefore **out of scope for the current tool surface.** The known future direction ("provider routing should become quota/cost/usage-aware") is a spec-extension proposal, not a found gap in the current authority. If adopted, it would be added to §13 deliberately; this review does not gate on it.

## Excluded tools — re-confirmed against spec

| Tool | Reason (spec source) |
|---|---|
| `create_card` | §5 line 117: Analyst must not create cards. Structural management belongs to planners. |
| `delete_card` | §5 line 117: Analyst must not delete. |
| `reorder_child` | §5 line 117: Analyst must not reorder. |
| `abort_goal_subtree` | §11 line 229: "Abort is not a separate required user capability." (Cf. F2 for the §11-authorized *cancellation* replacement.) |
| `restart_card_or_subtree` / `restart_goal` | §11 line 229: "Restart/reset of planner state is not a required user capability." |
| `mark_goal_needs_corrections` | Reviewer/planner correction loop §10; not an Analyst authority. |
| Workspace write/edit/apply-patch/build-test | §13 line 36: Analyst does not perform delivery work. |

Note the difference between **abort** (excluded by §11 line 229) and **cancellation** (required by §11 line 209). The live surface overshot by removing both. F2 reinstates the collaborative cancellation-initiation capability.

## Recommended target surface

| Group | Tools |
|---|---|
| Card steering | `edit_card`, `queue_notification`, `request_card_cancellation` (new per F2) |
| Card inspection | `list_cards`, `get_card`, `get_tree`, `get_plan_diary`, `get_card_output`, `card_history` (consolidated, F7) |
| Runtime/debug inspection | `get_status`, `read_runtime_events`, `read_runtime_errors`, `read_control_actions`, `list_processes` (renamed, F8), `list_agent_sessions`, `read_agent_session` |
| Run / continue | `start_project`, `resume_runtime` |
| Pause | `pause_runtime` |
| Shutdown | `stop_project` |
| Single-process control | `terminate_process` |
| Config-required restart | `restart_server` |
| Workspace inspection | `read_file`, `list_directory`, `run_shell_command` |
| UI navigation | `navigate_workspace`, `navigate_back` (shape reconsidered per F6, capability retained) |
| Config | `show_config`, `set_routing`, `configure_mcp_server`, `set_runtime_setting`, `set_server_setting` (F5 split) |

Net: ~30 tools (after one consolidation removes three and adds one; F5 swap keeps count constant; F2 adds one). The deltas versus the current surface: +1 (`request_card_cancellation`), −2 (consolidate history trio→one), one rename, one tool family re-split.

## Surface policy must be first-class

`run_shell_command` is already disabled on Telegram in the source (`if (ctx.surface === 'telegram') return toolFailure('permission', ...)`). The review treats that not as a one-off but as evidence the Analyst already needs a per-surface capability subset. The system spec's inspection authority and the architecture's command/projection split already presuppose that some surfaces are constrained. Documenting the subset prevents further ad-hoc denials:

| Class | Web control room | Telegram (constrained) |
|---|---|---|
| Card steering | yes | yes (text edits, queue notification, request cancellation) |
| Card inspection | full | summary subset (`get_status`, `get_card`, `get_tree`) |
| Runtime/debug inspection | full | error-only tail (`read_runtime_errors`) |
| Run / continue / Pause / Shutdown | yes | Pause + Shutdown only (emergency) |
| Single-process control | yes | no |
| Config-required restart | yes | no |
| Workspace inspection | full | no shell; `read_file` of safe paths only |
| Config | full | `show_config` only |
| UI navigation | yes | n/a (no workspace pane) |

This is server-side filtering the Analyst already enforces ad hoc; making it explicit prevents further one-off denials and is inside §13 authority.

## Prioritized actions

1. **F2 — Add `request_card_cancellation` for Analyst-initiated collaborative cancellation per §11 line 209.** This is a *spec-compliance* fix for an overshot removal; ship it before any ergonomics work. It must map to runtime/card public methods only and must not implement workflow logic in the tool runner.
2. **F7 — Consolidate `list_card_history` + `get_card_history_entry` + `diff_card` into `card_history`.** Pure reduction, no behavior loss.
3. **F3 — Realign prompt grouping with §7 Run / Pause / Shutdown; demote `restart_server` to the config-required case per §13 line 342.**
4. **F5 — Split `reconfigure` into ~4 discriminated tools, remove the broad union tool.**
5. **F8 — Rename `list_processes_tool` → `list_processes`.** Keep all log-tool names.
6. **F6 — Reconsider navigation tool shape** (UI-command channel); keep the capability per §14.
7. **F1 — Add prompt/UX guidance that editing the `project` card objective + notifications is the Analyst's I8 path**, since the spec deliberately puts new top-level goal creation in the project planner.
8. **Make surface policy explicit** per the table above.

Out of scope (spec-extension proposals, do not gate this surface): `get_usage` / cost-visibility tool (F10).

## Conclusion

Revised against the authoritative specs, this review retains the good parts of the earlier draft (history-tool consolidation, the `list_processes_tool` rename, the non-delivery boundary, surface-policy explicitness) and drops three recommendations that contradicted the spec:

- Goal-scoped `create_card` (violates §5 line 117).
- `list_pending_notifications` (violates §12 line 242).
- Treating navigation as not-a-required-Analyst-capability (contradicts §14 line 280).

It also identifies a real spec-compliance gap the earlier review missed: **the Analyst currently lacks a collaborative cancellation-initiation tool, which §11 line 209 explicitly requires.** That is the one item that needs to ship before any ergonomic work; the rest is consolidation, prompt grouping, and one rename. The target surface stays inside the spec's authority boundary and shrinks slightly while gaining the missing cancellation capability through runtime/card public methods, not through Analyst-owned workflow control.
