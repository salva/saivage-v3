# Analyst Tool Surface Review

Status: proposal. Authority: [`docs/spec/system-specification.md`](../spec/system-specification.md), [`docs/spec/operator-ui.md`](../spec/operator-ui.md), [`docs/architecture/system-architecture.md`](./system-architecture.md), and [`docs/architecture/micro-actor-runtime-design.md`](./micro-actor-runtime-design.md). This review updates the Analyst card-management model; where this proposal conflicts with current authoritative specs, update the specs before implementing code.

## Goal

The Analyst is the operator-facing control surface for card steering and runtime diagnosis. The current implementation is too narrow: it lets the Analyst inspect the tree, edit objective fields, and bootstrap the missing root project card, but it does not let the operator directly manage cards while the runtime is paused. That forces simple operator intent through planners even when no actor is executing and no runtime-safety issue exists.

Target model:

- The Analyst may manage cards while the runtime is paused, including cards outside the active planner's immediate scope.
- The Analyst must not directly dispatch work or bypass runtime lifecycle ownership.
- The Analyst must not directly cancel or mutate the lifecycle state of a running card.
- For running work, the Analyst should prefer notifications to the responsible card/planner and use Pause or Shutdown when immediate runtime control is needed.
- Direct Analyst card mutations must notify the card chain upward until a running card is reached, so active agents can react to changed context.

This deliberately gives the Analyst broader tree authority than a planner. A planner manages its own goal subtree and immediate children during runtime. The Analyst represents the operator and can reshape dormant work anywhere in the project.

## Current Mechanics

The implementation already has useful pieces but does not expose the desired model consistently.

| Area | Current state |
|---|---|
| `create_card` | Analyst can only bootstrap missing root `project`; planners create child cards. |
| `edit_card` | Analyst can edit objective/metadata fields only: `title`, `description`, `tags`, `priority`, `urgency`, `acceptance`, `depends_on`. Status, parent, type, lifecycle, and structure are denied. |
| `delete_card` | Implementation exists and uses the permission matrix, but the tool is not exposed to the Analyst surface. It deletes records directly instead of using the archive path used by planner deletion. |
| `reorder_child` | Implementation exists but is planner-only. |
| Restart | Permission matrix allows Analyst restart for `done`, `failed`, and `cancelled`, but no Analyst restart tool is exposed. |
| Propagation | `propagateChange` walks the edited card plus ancestors, flips resting `done`/`failed`/`cancelled`/`blocked` cards to `changed`, stops at first `running` card, and queues planner notes for active containing planners. |
| Notifications | `queueNotification` resolves card recipients to affected active sessions; there is no durable notification inbox. |

The existing `propagateChange` behavior is the right foundation for Analyst edits. Expanded structural tools should use the same propagation concept instead of inventing a parallel notification path.

## Authority Matrix

The Analyst card-management boundary should be state-sensitive and runtime-state-sensitive. Analyst card mutations require a paused runtime. "Allowed" means the Analyst may directly mutate durable card state through audited tools while paused. "Notify" means the Analyst should queue context for delivery when the runtime is unpaused.

| Card status | Create child | Write brief | Reorder siblings | Cancel | Delete | Notes |
|---|---:|---:|---:|---:|---:|---|
| `backlog` | allowed | allowed | allowed | allowed | allowed | Dormant work can be reshaped freely. |
| `changed` | allowed | allowed | allowed | allowed | allowed | Changed work can be reshaped before it is picked up again. |
| `blocked` | allowed | allowed | allowed | allowed | allowed | Operator can unblock by changing scope or cancelling obsolete work. |
| `done` | allowed | allowed | allowed | no | allowed | Edits should flip this card/ancestors to `changed`; cancellation of completed work is not meaningful. |
| `failed` | allowed | allowed | allowed | no | allowed | Edit to change future retry context, or delete if no longer useful. |
| `cancelled` | allowed | allowed | allowed | no | allowed | Edit/delete only; cancelled work is not cancelled again. |
| `needs_verification` | allowed | allowed | allowed | allowed | allowed | Treat as non-running review/rework state. |
| `running` | no | allowed while paused | no | notify | no | Runtime is paused, so the actor is not executing; touched records must be closed and resume notifications are queued. |

Subtree operations inherit the strictest state in the subtree. If any descendant is `running`, direct delete, reorder, and cancel are denied for the subtree root. `brief.md` writes may target running cards while paused when the touched record is closed and schema-valid. Resume notifications are queued for affected cards.

## Proposed Tool Surface

This section is intentionally limited to card handling. It does not propose removing or changing non-card Analyst tools such as runtime controls, workspace inspection, configuration, navigation, process inspection, or general runtime/debug inspection. Those surfaces remain separate and should be reviewed independently.

### Card Management

| Tool | Analyst scope | Behavior |
|---|---|---|
| `create_card` | Any non-running parent; root `project` when missing. | Create a child under an existing non-running parent with initial metadata and required initial records. Does not dispatch work. Runs propagation for the parent/ancestor chain. |
| `write_file` for `record://brief.md` | Any card while runtime is paused. | Commit approved `brief.md` updates. Touched records must be closed. Validation, commit, notification registration, and propagation run once. |
| `reorder_child` | Any non-running parent whose children are not running. | Reorder children by permutation. Propagate on the parent. |
| `cancel_card` | Non-running `backlog`, `changed`, `blocked`, `needs_verification`. | Mark obsolete dormant work as `cancelled`. Deny running and terminal cards. Propagate on parent/ancestors. |
| `delete_card` | Any subtree with no running member and status in deletable states. | Remove from the active tree and move the full card record namespaces to archive storage for forensics. |

Expose `delete_card` as the public operator tool. Under the hood it archives full record namespaces instead of destroying data.

Detailed card-tool availability:

| Tool | Should be available when | Should be denied when | Replacement guidance |
|---|---|---|---|
| `create_card` | Root `project` is missing; or target parent exists, is non-running, and no running descendant would be structurally disrupted. | Parent is `running`; parent is missing; requested type/parent would violate tree invariants; creation would imply dispatching work immediately. | If parent is running, `queue_notification` to the active planner/card. |
| `write_file` for `record://brief.md` | Runtime is paused; target exists; latest brief is closed; slot is approved for Analyst writes. | Runtime is not paused; touched slot is open; content fails schema validation; slot is not Analyst-writable. | For unpaused runtime, pause first or use `queue_notification`. |
| `reorder_child` | Parent exists and is non-running; child list is a permutation of current children; no listed child is running. | Parent or any reordered child is `running`; child set mismatch. | Notify active planner with preferred order. |
| `cancel_card` | Target/subtree is non-running and status is `backlog`, `changed`, `blocked`, or `needs_verification`. | Target/subtree includes `running`; target is `done`, `failed`, or `cancelled`; target is root project unless the whole runtime is stopped and operator confirms. | For running work, `queue_notification`; for global stop, `pause_runtime` or `stop_project`. |
| `delete_card` | Runtime is paused; target/subtree has no running card; operator intent is removal from active plan. | Runtime is not paused; target/subtree includes `running`; target is root project; deletion would orphan dependencies without explicit handling. | `cancel_card` if the work should remain visible as cancelled; `write_file` to update `brief.md` or `create_card` if the work should be redone differently. |

### Card Inspection And Coordination

Keep card inspection and card-steering coordination tools available to the Analyst:

- `list_cards`, `get_card`, `get_tree`, `get_plan_diary` while planner diary remains outside records, and generic file reads/metadata reads for `record://` URLs.
- `queue_notification` for running work, ambiguous intent, or cases where collaboration is safer than direct mutation.

These are card-handling tools for this discussion because they inspect card state, durable card records, card history, or deliver card-scoped steering context. They do not directly mutate card lifecycle state except through notification delivery into active sessions.

`get_card` should return primary card information plus a compact list of durable card records. Each record entry should include a concrete `record://` URL with card id and version, current version, size/mtime metadata, owning role/slot, and a bounded inline snippet for the main records when useful. Agents do not read primary card state through `record://card.json`.

Do not add a separate `get_card_record` if generic file tools can read `record://` URLs. Record history and metadata should be generic file concerns through `read_file_metadata("record://review.md?card=card-1")`. Card mutation history is internal `card.json` version history exposed through card read/history surfaces, not by reading `record://card.json`.

Detailed card-inspection and card-coordination availability:

| Tool group | Tools | Should be available when | Should be denied when |
|---|---|---|---|
| Tree/list reads | `list_cards`, `get_tree` | Analyst is online. | Only if card storage is unreadable. |
| Single-card reads | `get_card`, `get_plan_diary` | Target card exists; `get_plan_diary` targets a goal/project. | Target card is missing. |
| Record reads | Generic `read_file` over document record URLs returned by `get_card`. | Target card/record exists and the URL resolves inside that card's record namespace. | Target card or record is missing; requested URL is not a valid `record://` URL for the card context, or attempts to read primary card info as `record://card.json`. |
| Record metadata/history | `read_file_metadata` over document record URLs. | Target card/record exists and record version metadata is available. | Target card/record/version is missing. |
| Card-scoped notification | `queue_notification` | Recipient resolves to an existing card, active role, or active session; body is operator guidance, correction, cancellation request, or coordination context. | Unknown recipient; request tries to list/manage/delete notifications; body asks an agent to violate its own authority. |

### Card Tools That Should Not Be Available

| Tool or class | Reason |
|---|---|
| `abort_goal_subtree` | Legacy broad cancellation primitive. Replace with state-gated `cancel_card` for dormant work and `queue_notification`/runtime controls for running work. |
| `restart_card`, `restart_goal`, `restart_card_or_subtree` | Restart is not needed as an Analyst card tool. Use `write_file` on `brief.md`, `create_card`, `cancel_card`, or `delete_card` to express the desired plan change without resetting lifecycle state. |
| `move_card` | Reparenting is structural churn that agents do not need for normal operation. Use `create_card`, `write_file` on `brief.md`, `reorder_child`, `cancel_card`, or `delete_card` instead. |
| `archive_card` | Public operator intent is deletion from the active project; the implementation archives data under the hood. |
| `get_card_output` | Process-output shaped reads should be replaced by durable record URLs returned by `get_card` and generic reads of those URLs. |
| `get_card_record` | A card-specific record reader is unnecessary if generic file reads support `record://` URLs. |
| `activate_card` | Planner/runtime dispatcher authority. Analyst must not manually step through card execution. |
| Planner report tools: `report_goal_done`, `report_goal_failed`, `report_goal_blocked` | Planner self-report authority; Analyst must not forge lifecycle results. |
| Notification management: list/get/ack/delete notification inbox tools | Notifications are delivery events, not durable operator-managed records. Delivery is verified through session/event inspection. |

## Propagation Contract

Every successful Analyst card mutation must return propagation details and write audited history.

Required response fields:

| Field | Meaning |
|---|---|
| `changed_card_ids` | Cards directly changed by the tool. |
| `flipped` | Cards changed to `changed`, with previous statuses. |
| `stopped_at_running` | First running card where upward propagation stopped, or `null`. |
| `notified_planner_session_ids` | Active planner sessions that received context. |
| `warnings` | Non-fatal coordination notes, such as "running ancestor notified; active work may continue until it observes the message." |

Propagation rules:

1. Run propagation after create, record write, reorder, cancel, and delete.
2. Flip resting ancestors/subtree goals from terminal or blocked states to `changed` when their premise was altered.
3. Stop upward status mutation at the first `running` card.
4. Queue live or synthetic planner notes for the containing planner chain.
5. If a running card is affected, do not force its status. Notify it or its active containing planner and report that the running work must observe and adapt cooperatively.
6. Preserve card history and control-action audit entries for every direct Analyst mutation.

The existing `propagateChange` implements most of this for edits. It should be generalized or wrapped for structural mutations so all tools share one propagation contract.

## Prompt Policy

The Analyst prompt should describe both authority and restraint.

Required guidance:

- You may directly manage cards while the runtime is paused when the operator asks for a concrete tree change.
- You have broader card-tree authority than planners; planners are scoped to their active planning context.
- Prefer `queue_notification` over direct mutation when a card is running, when intent is advisory, or when an active agent can resolve the issue better than a forced tree edit.
- Mutating tools require paused runtime.
- Running-card `brief.md` writes are permitted while paused if touched records are closed; structural delete/reorder/cancel of running subtrees remains denied.
- Use Pause or Shutdown for immediate runtime control; do not emulate those controls with card mutations.
- Explain after a direct mutation which running ancestor or planner was notified, if any.

This keeps the Analyst powerful for dormant cards while avoiding surprise interference with active agents.

## Implementation Plan

1. Update specs to authorize Analyst direct management of cards while the runtime is paused, including permissive `brief.md` writes to running cards whose touched records are closed.
2. Extend `cardActionValues` and permission logic for `card.create`, `card.reorder_child`, `card.delete`, and state-sensitive Analyst `card.cancel`.
3. Implement public `delete_card` as archive-backed active-tree removal.
4. Expose Analyst `create_card`, `reorder_child`, `cancel_card`, and `delete_card` with runtime-paused and state preflight checks; use generic `write_file` for `brief.md` edits.
5. Generalize propagation so every structural mutation returns the common propagation result.
6. Remove `get_card_output` and card-specific record readers once generic file read and metadata APIs support `record://` URLs.
7. Update `get_card` to include authored record summaries and bounded inline main-record content.
8. Update planner cards so planner goals/instructions are durable records and existing card text fields are temporary projection caches.
9. Update `analyst-prompt.ts` and tool descriptions with the prompt policy above.
10. Add focused tests for every status in the authority matrix, including subtree denial when any descendant is running.
11. Add integration tests proving direct mutations notify active planner chains and stop status mutation at the first running card.

No compatibility aliases are needed. Remove or rename old internal tool paths as part of the implementation rather than preserving duplicate surfaces.

## Open Questions

| Question | Proposed answer |
|---|---|
| Should Analyst edit running card text directly? | Yes while the runtime is paused, but only through closed, schema-valid writable records such as `brief.md`, with resume notifications queued for affected cards. |
| Should `done` cards be cancellable? | No. Use `delete_card` to remove them from the active project, or update `brief.md`/create replacement work when the scope changes. |
| Should create under terminal parents be allowed? | Yes, but the parent should flip to `changed` so the new child is incorporated into resumed planning/review. |
| Should archive be reversible? | Not in this proposal. Archive preserves audit state, but restoring archived cards needs a separate design. |
| Should Analyst move/reparent cards? | No. The surface should prefer simpler create, record write, reorder, cancel, and delete operations. |
| Should Analyst restart cards? | No. Restart resets lifecycle state and is not needed for normal card steering. |
| Should card output be process-oriented? | No. Card output should be durable record-oriented: `get_card` summarizes/inlines records and generic file reads open the returned `record://` URLs. |
| Should card mutation history remain card-specific? | No separate card-history store is needed; card mutation history is `card.json` version history. |
| Should Analyst manage notification inboxes? | No. Delivery is confirmed through sessions/events; notifications remain delivery items, not managed records. |

## Conclusion

The Analyst should become the global operator for card management while the runtime is paused. Running cards are not executing while paused, so their closed writable document records may be updated through `write_file`, but structural delete/reorder/cancel of running subtrees remains protected. The main implementation work is making card documents addressable through `record://` URLs, exposing audited paused-runtime card mutations, and notifying affected cards on resume.
