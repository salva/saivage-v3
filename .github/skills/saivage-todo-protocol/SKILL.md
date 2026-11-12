---
name: saivage-todo-protocol
description: Track Saivage v3 work items through their lifecycle using docs/working/todo.md and docs/working/done.md. Use when adding, updating, completing, or reviewing work items, issues, features, or refactoring tasks.
---

# Saivage v3 Todo/Done Protocol

## Purpose

Maintain a single living view of all active and completed work items for Saivage v3. Every issue, feature, refactoring, or improvement — whether discovered through code review, operational observation, or design discussion — is tracked through this protocol.

## Files

`docs/working/todo.md` and `docs/working/done.md` are checkout-local ignored working artifacts. They are not published issue documentation or a tracked/public issue registry.

### `docs/working/todo.md`

Active work items. Every item the team or agents are working on or plan to work on lives here. Items are organized into sections (Open Issues, UI Responsiveness, Open Refactoring, Reference, etc.) and each carries a status.

### `docs/working/done.md`

Completed items. When an item is finished, its full entry moves from `todo.md` to `done.md`. The entry in `done.md` should preserve enough context (commits, scope, key decisions) to serve as a historical record.

## Item lifecycle

An item progresses through these statuses:

1. **Open** — Identified but not yet analyzed. No root cause or fix direction documented.
2. **Analyzed** — Root cause understood, fix direction documented. An audit, investigation, or findings report exists (either inline or at a `docs/working/` path referenced from the item).
3. **Designed** — An adversarially-reviewed design/implementation plan exists at a `docs/working/<date>-<slug>/` path. The plan has passed the `saivage-issue-fix-adversarial-review` skill's review loop, and the issue fixer has recorded its approval (the final `WORTH_IMPLEMENTING` decision with its approval evidence). Waiting for the implementation lock while approved is a note on a Designed item, not a separate status.
4. **In progress** — An implementation manager is actively executing the approved plan.
5. **Blocked** — Waiting on a prerequisite, user decision, or external resolution. The blocker must be named.

### When an item is completed

1. Move the full entry from `todo.md` to `done.md` (prepend to the appropriate section).
2. Replace the entry in `todo.md` with a one-line pointer: `**[Item name]** — Done. See [done.md](./done.md). Commit(s): <hashes>.`
3. The one-line pointer stays in `todo.md` briefly (days, not weeks) so recent completions are visible. Older pointers may be pruned during periodic cleanup.

## Adding a new item

1. Read `todo.md` to find the appropriate section.
2. Check whether the item already exists (possibly under a different name or as part of a broader item). Merge rather than duplicate.
3. Add the item with status **Open** (or **Analyzed** if investigation was already done).
4. Include: title, status, affected area, concise description, and fix direction if known.
5. If the item has a detailed audit, investigation, or design plan, reference it by path rather than inlining hundreds of lines.

## Updating an item

When status changes (e.g., Open → Analyzed → Designed → In progress → Done):

1. Update the `**Status:**` line in `todo.md`.
2. If moving to **Designed**, reference the plan path.
3. If moving to **In progress**, note who is implementing.
4. If moving to **Done**, follow the completion procedure above.

## Issue-team lifecycle ownership

The issue-fix workflow (`saivage-issue-fix-adversarial-review`) assigns these lifecycle actions. Other sessions tracking work items use the generic rules above.

- **Batch coordinator** (the primary session that accepts an issue batch) performs intake before launching and applies settled lifecycle facts from fixer reports at a safe boundary.
- **Implementation manager** records its own attempt's factual progress while it is the sole implementation writer.
- **Issue fixer** never writes `todo.md` or `done.md`. It reports its lifecycle evidence in its disposition.

Authority comes from each role's effective instructions: its stored body together with the shared instructions that currently take effect for it, under their priority. This skill describes the contract and grants no write authority to a session whose effective instructions do not give it. When a required action lacks authority, or ownership or settlement is unknown, or effective instructions conflict without resolution, report the update as pending or blocked. Never transfer it to another session.

### Intake

Before launching a new issue, the coordinator:

1. Reads this protocol.
2. Finds the issue's existing entry by its identifier. An entry may be a table row inside a section rather than its own heading. Merge into it, keep its identifier, and never create a duplicate.
3. If no entry exists, adds it as **Open**, or as **Analyzed** when investigation already exists, with the issue facts, the evidence path, and the plan path when known.
4. Passes the entry identifier and the tracker paths with the issue assignment.

### Safe timing

The coordinator writes only at a quiescent orchestration boundary:

- every previously launched or resumed issue call has settled. A waiting fixer that has returned counts as settled; a fixer that could still launch a manager does not;
- no implementation manager is active or retains the implementation lock;
- no launch or resume occurs until the bounded update finishes.

Establish settlement from existing task results and reports. Do not inspect, poll, or wait on the lock to create the boundary. If ownership or settlement is unknown, keep the pending facts in session context, report tracker maintenance as pending, and edit nothing. Because the coordinator runs one selected issue run at a time, apply the settled return's update once at that boundary, then select the next run. Do not hold a settled return for an unrelated tracker update beyond the bounded update itself.

Status may lag while the selected issue run is in progress. At the boundary, the coordinator applies each item's latest evidenced lifecycle once, so no intermediate writes or status gates are needed.

### Implementation manager updates

After it acquires the lock, or under the sole-writer exception its instructions grant, the manager reads this protocol and the fresh exact entry:

- A missing, ambiguous, or unmatched identifier is a blocker. Do not invent, guess, or duplicate an entry; make no tracker edit.
- Before implementation delegation, the manager sets the entry to **In progress**, links the approved plan, and notes the implementing manager role.
- After worker settlement, validation, commit, and stabilization, and before releasing the lock, it records only factual progress. Full implementation stays **In progress** with an "implementation complete; fixer reconciliation pending" note and the commit and validation references. A known partial attempt that returns to design becomes **Analyzed** with the remaining work and the plan revision needed. A prerequisite or unsafe settled outcome becomes **Blocked** with its named cause.
- Contention-only attempts edit nothing.

Tracker edits are ignored working artifacts. They are never staged or committed and are not counted as uncommitted issue mutation. Lock release remains the final mutation.

### Settlement mapping

The coordinator applies these actions at a safe boundary:

| Evidence | Tracker action |
| --- | --- |
| Investigation exists; design not approved or needs revision | **Analyzed**; preserve the audit and the current plan links |
| Reviewed, fixer-approved plan, including lock contention | **Designed**; link the plan. Waiting is a note, not a status |
| Named prerequisite, failure needing resolution, cancellation, or unsafe or unknown settled outcome | **Blocked** with the actual cause or cancellation note. Never infer success |
| `COMPLETED` with full approval, manager validation and commits, and stable read-only reconciliation | Move the full entry to `done.md`, prepended in its section. Leave the one-line Done pointer with commit hashes in `todo.md` |
| `ABANDONED`, before implementation or for an explicitly identified remainder after stabilized partial delivery | Keep the full entry in `todo.md` as **Analyzed**, with an explicit terminal ABANDONED note giving the merit reason and the abandoned scope. Retain delivered units, validation and commit references when any exist; state no implementation only when none occurred. No automatic relaunch, no Done move or claim, and no treatment of the remainder as pending work |

Abandonment is a disposition note, not a sixth status. Partial abandonment stays **Analyzed**, not Done: the whole issue is not complete, and its abandoned remainder is terminal rather than pending. Preserve partial commits and historical facts. A design invalidated after a manager return becomes **Analyzed** with the plan revision needed.

### Done evidence

Move an entry to `done.md` only with all of: the unchanged approved-plan record, the manager's validation results, the commit hashes, and stable read-only reconciliation. If any is missing, keep the entry out of Done, name the missing evidence, and report it.

Completion records issue implementation only. Aggregate workflow results stay separate. A later aggregate defect is a new item routed through the normal fix workflow; never erase it silently or describe it as already fixed.

Task IDs, continuity nonces, and handshake records remain session context. They are never tracker fields.

## Relationship to the adversarial review skill

The `saivage-issue-fix-adversarial-review` skill governs how issues are designed and implemented. This protocol governs how items are tracked. An item's status reflects where it is in the adversarial review workflow:

- **Open/Analyzed** = before design
- **Designed** = adversarial review passed, plan approved
- **In progress** = implementation manager executing
- **Done** = implementation complete, validated, and committed

## Conventions

- Both files are under `docs/working/` and are NOT committed to Git. They are local working artifacts.
- Use Markdown headings (`###`) for individual items within sections.
- Keep entries self-contained: a reader should understand the item without reading prior versions.
- Preserve commit hashes and plan paths in `done.md` for traceability.
- When in doubt about whether something belongs in `todo.md`, add it. Pruning is easier than recovering lost items.
