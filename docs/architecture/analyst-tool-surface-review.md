# Analyst Tool Surface Review

Status: proposal. Authority: [`docs/spec/system-specification.md`](../spec/system-specification.md), [`docs/spec/operator-ui.md`](../spec/operator-ui.md), [`docs/architecture/system-architecture.md`](./system-architecture.md), and [`docs/architecture/micro-actor-runtime-design.md`](./micro-actor-runtime-design.md). This review updates the Analyst card-management model; where this proposal conflicts with current authoritative specs, update the specs before implementing code.

## Goal

The Analyst is the operator-facing control surface for card steering and runtime diagnosis. The current implementation is too narrow: it lets the Analyst inspect the tree, edit objective fields, and bootstrap the missing root project card, but it does not let the operator directly manage non-running cards. That forces simple operator intent through planners even when no active agent owns the card and no runtime safety issue exists.

Target model:

- The Analyst may manage any non-running card, including cards outside the active planner's immediate scope.
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

The Analyst card-management boundary should be state-sensitive. "Allowed" means the Analyst may directly mutate durable card state through audited tools. "Notify" means the Analyst should send context to the running card/planner or use runtime controls, not mutate lifecycle state directly.

| Card status | Create child | Write records/metadata | Reorder siblings | Cancel | Archive | Notes |
|---|---:|---:|---:|---:|---:|---|
| `backlog` | allowed | allowed | allowed | allowed | allowed | Dormant work can be reshaped freely. |
| `changed` | allowed | allowed | allowed | allowed | allowed | Changed work can be reshaped before it is picked up again. |
| `blocked` | allowed | allowed | allowed | allowed | allowed | Operator can unblock by changing scope or cancelling obsolete work. |
| `done` | allowed | allowed | allowed | no | allowed | Edits should flip this card/ancestors to `changed`; cancellation of completed work is not meaningful. |
| `failed` | allowed | allowed | allowed | no | allowed | Edit to change future retry context, or archive if no longer useful. |
| `cancelled` | allowed | allowed | allowed | no | allowed | Edit/archive only; cancelled work is not cancelled again. |
| `needs_verification` | allowed | allowed | allowed | allowed | allowed | Treat as non-running review/rework state. |
| `running` | no | notify | no | notify | no | Direct lifecycle mutation is unsafe; send guidance or pause/shutdown runtime. |

Subtree operations inherit the strictest state in the subtree. If any descendant is `running`, direct archive, reorder, and cancel are denied for the subtree root. Record or metadata writes to a non-running ancestor that contains running work should be permitted only when propagation reaches the running descendant's active planner/session and the tool response says active work was notified.

## Proposed Tool Surface

This section is intentionally limited to card handling. It does not propose removing or changing non-card Analyst tools such as runtime controls, workspace inspection, configuration, navigation, process inspection, or general runtime/debug inspection. Those surfaces remain separate and should be reviewed independently.

### Card Management

| Tool | Analyst scope | Behavior |
|---|---|---|
| `create_card` | Any non-running parent; root `project` when missing. | Create a child under an existing non-running parent with initial metadata and required initial records. Does not dispatch work. Runs propagation for the parent/ancestor chain. |
| `write_card_record` | Approved record slots on non-running cards. | Write a new version of a card record, such as planner goal/instructions/status or acceptance content. Records are versioned and exposed as `record://` URLs. Writes validate the slot, audit the change, and propagate. |
| `edit_card_metadata` | Any non-running card. | Edit structured metadata only: title, tags, priority, urgency, dependencies, related links, and other non-output fields. Lifecycle/output state is not metadata. |
| `reorder_child` | Any non-running parent whose children are not running. | Reorder children by permutation. Propagate on the parent. |
| `cancel_card` | Non-running `backlog`, `changed`, `blocked`, `needs_verification`. | Mark obsolete dormant work as `cancelled`. Deny running and terminal cards. Propagate on parent/ancestors. |
| `archive_card` | Any subtree with no running member and status in deletable states. | Archive then remove from active tree using the same archive path as planner deletion. Prefer this over raw delete. |

Do not expose low-level `delete_card` as the primary Analyst tool. The operator intent is to remove active plan items while preserving auditability, so `archive_card` should be the public tool and it should use `archiveAndDeleteSubtree`.

Detailed card-tool availability:

| Tool | Should be available when | Should be denied when | Replacement guidance |
|---|---|---|---|
| `create_card` | Root `project` is missing; or target parent exists, is non-running, and no running descendant would be structurally disrupted. | Parent is `running`; parent is missing; requested type/parent would violate tree invariants; creation would imply dispatching work immediately. | If parent is running, `queue_notification` to the active planner/card. |
| `write_card_record` | Target exists, is non-running, and the requested slot is an approved operator-writable record. | Target is `running`; slot is lifecycle/output evidence owned by another role; content fails validation; write bypasses record versioning. | For running target, `queue_notification`; for metadata-only changes, use `edit_card_metadata`. |
| `edit_card_metadata` | Target exists and is non-running; fields are structured metadata such as title, tags, priority, urgency, dependencies, or related links. | Target is `running`; fields rewrite record content, lifecycle/output/result/process state, parent, type, or invalid dependencies. | For record content, use `write_card_record`; for running target, use `queue_notification`. |
| `reorder_child` | Parent exists and is non-running; child list is a permutation of current children; no listed child is running. | Parent or any reordered child is `running`; child set mismatch. | Notify active planner with preferred order. |
| `cancel_card` | Target/subtree is non-running and status is `backlog`, `changed`, `blocked`, or `needs_verification`. | Target/subtree includes `running`; target is `done`, `failed`, or `cancelled`; target is root project unless the whole runtime is stopped and operator confirms. | For running work, `queue_notification`; for global stop, `pause_runtime` or `stop_project`. |
| `archive_card` | Target/subtree has no running card and every card is in a deletable non-running state; operator intent is removal from active plan. | Target/subtree includes `running`; target is root project; archive would orphan dependencies without explicit handling. | `cancel_card` if the work should remain visible as cancelled; `write_card_record`, `edit_card_metadata`, or `create_card` if the work should be redone differently. |

### Card Inspection And Coordination

Keep card inspection and card-steering coordination tools available to the Analyst:

- `list_cards`, `get_card`, `get_tree`, `get_plan_diary` while planner diary remains outside records, and generic file reads/metadata reads for `record://` URLs.
- `queue_notification` for running work, ambiguous intent, or cases where collaboration is safer than direct mutation.

These are card-handling tools for this discussion because they inspect card state, durable card records, card history, or deliver card-scoped steering context. They do not directly mutate card lifecycle state except through notification delivery into active sessions.

`get_card` should return the card plus a compact list of durable card records. Each record entry should include a `record://` URL, current version, size/mtime metadata, owning role/slot, and a bounded inline snippet for the main records when useful. The card itself should also be exposed as `record://card.json`, so the same generic read/metadata APIs can inspect the card document and its history.

Do not add a separate `get_card_record` if generic file tools can read `record://` URLs. Record history and metadata should also be generic file concerns: for example `read_file_metadata("record://review.md")`, or an equivalent `read_file("record://review.md?metadata=true")` shape. This replaces card-specific history tools over time.

Detailed card-inspection and card-coordination availability:

| Tool group | Tools | Should be available when | Should be denied when |
|---|---|---|---|
| Tree/list reads | `list_cards`, `get_tree` | Analyst is online. | Only if card storage is unreadable. |
| Single-card reads | `get_card`, `get_plan_diary` | Target card exists; `get_plan_diary` targets a goal/project. | Target card is missing. |
| Card and record reads | Generic `read_file` over `record://card.json` and record URLs returned by `get_card`. | Target card/record exists and the URL resolves inside that card's record namespace. | Target card or record is missing; requested URL is not a valid `record://` URL for the card context. |
| Card and record metadata/history | Generic file metadata/history over `record://card.json` and record URLs. | Target card/record exists and history metadata is available. | Target card/record/version is missing. |
| Card-scoped notification | `queue_notification` | Recipient resolves to an existing card, active role, or active session; body is operator guidance, correction, cancellation request, or coordination context. | Unknown recipient; request tries to list/manage/delete notifications; body asks an agent to violate its own authority. |

### Card Tools That Should Not Be Available

| Tool or class | Reason |
|---|---|
| `abort_goal_subtree` | Legacy broad cancellation primitive. Replace with state-gated `cancel_card` for dormant work and `queue_notification`/runtime controls for running work. |
| `restart_card`, `restart_goal`, `restart_card_or_subtree` | Restart is not needed as an Analyst card tool. Use `write_card_record`, `edit_card_metadata`, `create_card`, `cancel_card`, or `archive_card` to express the desired plan change without resetting lifecycle state. |
| `move_card` | Reparenting is structural churn that agents do not need for normal operation. Use `create_card`, `write_card_record`, `edit_card_metadata`, `reorder_child`, `cancel_card`, or `archive_card` instead. |
| `delete_card` as public Analyst tool | Raw deletion is the wrong operator concept. Use audited `archive_card` backed by archive storage. |
| `get_card_output` | Process-output shaped reads should be replaced by durable record URLs returned by `get_card` and generic reads of those URLs. |
| `get_card_record` | A card-specific record reader is unnecessary if generic file reads support `record://` URLs. |
| `list_card_history`, `get_card_history_entry`, `diff_card` as card-specific history tools | History should be generalized to file/record metadata for `record://card.json` and every durable record URL. |
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

1. Run propagation after create, card record writes, metadata edits, reorder, cancel, and archive.
2. Flip resting ancestors/subtree goals from terminal or blocked states to `changed` when their premise was altered.
3. Stop upward status mutation at the first `running` card.
4. Queue live or synthetic planner notes for the containing planner chain.
5. If a running card is affected, do not force its status. Notify it or its active containing planner and report that the running work must observe and adapt cooperatively.
6. Preserve card history and control-action audit entries for every direct Analyst mutation.

The existing `propagateChange` implements most of this for edits. It should be generalized or wrapped for structural mutations so all tools share one propagation contract.

## Prompt Policy

The Analyst prompt should describe both authority and restraint.

Required guidance:

- You may directly manage non-running cards when the operator asks for a concrete tree change.
- You have broader card-tree authority than planners; planners are scoped to their active planning context.
- Prefer `queue_notification` over direct mutation when a card is running, when intent is advisory, or when an active agent can resolve the issue better than a forced tree edit.
- Never directly cancel, archive, or delete a running card or a subtree containing running work.
- Use Pause or Shutdown for immediate runtime control; do not emulate those controls with card mutations.
- Explain after a direct mutation which running ancestor or planner was notified, if any.

This keeps the Analyst powerful for dormant cards while avoiding surprise interference with active agents.

## Implementation Plan

1. Update specs to authorize Analyst direct management of non-running cards and notification-first handling of running cards.
2. Extend `cardActionValues` and permission logic for `card.create`, `card.write_record`, `card.edit_metadata`, `card.reorder_child`, `card.archive`, and state-sensitive Analyst `card.cancel`.
3. Replace public Analyst `delete_card` semantics with audited `archive_card` backed by `archiveAndDeleteSubtree`.
4. Expose Analyst `create_card`, `write_card_record`, `edit_card_metadata`, `reorder_child`, `cancel_card`, and `archive_card` with subtree-running preflight checks.
5. Generalize propagation so every structural mutation returns the common propagation result.
6. Remove `get_card_output` and card-specific record/history readers once generic file read and metadata APIs support `record://` URLs.
7. Update `get_card` to include `record://card.json`, record summaries, and bounded inline main-record content.
8. Update planner cards so planner goals/instructions are durable records rather than only card JSON fields.
9. Update `analyst-prompt.ts` and tool descriptions with the prompt policy above.
10. Add focused tests for every status in the authority matrix, including subtree denial when any descendant is running.
11. Add integration tests proving direct mutations notify active planner chains and stop status mutation at the first running card.

No compatibility aliases are needed. Remove or rename old internal tool paths as part of the implementation rather than preserving duplicate surfaces.

## Open Questions

| Question | Proposed answer |
|---|---|
| Should Analyst edit running card text directly? | No by default. Treat running cards as notification-first to avoid changing instructions underneath an active model without an explicit delivery event. |
| Should `done` cards be cancellable? | No. Use archive to remove them or restart/edit to reopen work. |
| Should create under terminal parents be allowed? | Yes, but the parent should flip to `changed` so the new child is incorporated into resumed planning/review. |
| Should archive be reversible? | Not in this proposal. Archive preserves audit state, but restoring archived cards needs a separate design. |
| Should Analyst move/reparent cards? | No. The surface should prefer simpler create/edit/reorder/cancel/archive operations. |
| Should Analyst restart cards? | No. Restart resets lifecycle state and is not needed for normal card steering. |
| Should card output be process-oriented? | No. Card output should be durable record-oriented: `get_card` summarizes/inlines records and generic file reads open the returned `record://` URLs. |
| Should card history remain card-specific? | No. Card and record history should be exposed through generic file metadata/history over `record://card.json` and other record URLs. |
| Should Analyst manage notification inboxes? | No. Delivery is confirmed through sessions/events; notifications remain delivery items, not managed records. |

## Conclusion

The Analyst should become the global operator for non-running card management, not merely an objective editor. Running cards remain protected: the Analyst communicates with them, pauses/shuts down the runtime, or waits for cooperative handling instead of forcing lifecycle state. The main implementation work is not a new runtime path; it is making cards and their records addressable through `record://` URLs, exposing state-sensitive audited card mutations, and applying the existing propagation model consistently to every Analyst card mutation.
