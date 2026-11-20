---
name: saivage-todo-protocol
description: Track Saivage v3 work items through their lifecycle using docs/working/todo.md and docs/working/done.md. Use when adding, updating, completing, or reviewing work items, issues, features, or refactoring tasks.
---

# Saivage v3 Todo/Done Protocol

## Purpose

Track active Saivage v3 work, completed deliveries, and terminal assessments without confusing closure with delivery. Use this protocol for issues, features, refactorings, and improvements, however discovered.

## Files

`docs/working/todo.md` and `docs/working/done.md` are checkout-local ignored working artifacts. They are not published issue documentation or a tracked/public issue registry.

### `docs/working/todo.md`

Active work items. Every item the team or agents are working on or plan to work on lives here. Items are organized into sections (Open Issues, UI Responsiveness, Open Refactoring, Reference, etc.) and each carries a status.

### `docs/working/done.md`

Archive for completed deliveries and, separately, terminal assessments under `## Closed without implementation`. That heading describes the closed scope, not the item's entire implementation history. Archive placement alone conveys neither implementation nor acceptance.

### `docs/working/discarded.md`

Permanent discard decisions in `docs/working/discarded.md` are a read-only input to scope eligibility. Preserve their original disposition.

## Item lifecycle

An item progresses through these statuses:

1. **Open** — Identified but not yet analyzed. No root cause or fix direction documented.
2. **Analyzed** — Root cause understood, fix direction documented. An audit, investigation, or findings report exists (either inline or at a `docs/working/` path referenced from the item).
3. **Designed** — An adversarially-reviewed design/implementation plan exists at a `docs/working/<date>-<slug>/` path. The plan has passed the `saivage-issue-fix-adversarial-review` skill's review loop, and the issue fixer has recorded its approval (the final `WORTH_IMPLEMENTING` decision with its approval evidence). Waiting for the implementation lock while approved is a note on a Designed item, not a separate status.
4. **In progress** — An implementation manager is actively executing the approved plan.
5. **Blocked** — Waiting on a prerequisite, user decision, or external resolution. The blocker must be named.

## Scope eligibility

Before adding or merging work, selecting scheduled work (including an existing row), or launching, match the proposed scope, not just its identifier, against explicit terminal evidence. Use the coordinator's already-held substantive disposition reports and pending tracker facts, the local `todo.md` and `done.md`, and the permanent decisions in `docs/working/discarded.md`. Use those sources as they stand; do not search for sessions, exhaustively hunt for evidence, or create a registry.

A settled `ABANDONED` report excludes its stated scope even before filing, including when `todo.md` still shows active or manager-progress facts. Explicit terminal evidence already in `todo.md` or archived in `done.md` has the same effect. A permanent discard alone excludes its stated scope under its original disposition, even under another identifier. A missing or stale row overrides none of these decisions.

Exclude the whole item only on whole-item evidence. For a mixed parent, exclude the terminal part from intake, selection, and launch; only independently actionable work remains eligible under the existing rules. This decision is read-only: decline terminal scope without reconciling trackers or editing or reclassifying a discard. Partial or uncertain reports, dormancy, blocking, and nonselection do not establish abandonment. Keep the existing settlement and no-automatic-relaunch rules. Genuinely new scope follows ordinary intake.

## Adding a new item

1. Apply [Scope eligibility](#scope-eligibility) to the proposed work, then find the appropriate section in `todo.md` for eligible scope.
2. Check whether the item already exists (possibly under a different name or as part of a broader item). Merge rather than duplicate.
3. Add the item with status **Open** (or **Analyzed** if investigation was already done).
4. Include: title, status, affected area, concise description, and fix direction if known.
5. If the item has a detailed audit, investigation, or design plan, reference it by path rather than inlining hundreds of lines.

## Updating an item

For active status changes (e.g., Open → Analyzed → Designed → In progress):

1. Update the `**Status:**` line in `todo.md`.
2. If moving to **Designed**, reference the plan path.
3. If moving to **In progress**, note who is implementing.

For a final disposition, use [Settlement mapping](#settlement-mapping), subject to the lifecycle ownership below.

## Issue-team lifecycle ownership

The issue-fix workflow (`saivage-issue-fix-adversarial-review`) assigns these lifecycle actions. Other sessions tracking work items use the generic intake and update rules within their existing authority.

- **Batch coordinator** (the primary session that accepts an issue batch) performs intake before launching and applies settled lifecycle facts from fixer reports at a safe boundary.
- **Implementation manager** records its own attempt's factual progress while it is the sole implementation writer.
- **Issue fixer** never writes `todo.md` or `done.md`. It reports its lifecycle evidence in its disposition.

Authority comes from each role's effective instructions: its stored body together with the shared instructions that currently take effect for it, under their priority. This skill describes the contract and grants no write authority to a session whose effective instructions do not give it. When a required action lacks authority, or ownership or settlement is unknown, or effective instructions conflict without resolution, report the update as pending or blocked. Never transfer it to another session.

### Intake

Before launching, the coordinator applies [Scope eligibility](#scope-eligibility), including when selecting an existing entry. For eligible work:

1. Find the issue's existing entry by its identifier. An entry may be a table row inside a section rather than its own heading. For intake, merge eligible scope into that entry and keep its identifier rather than duplicating it.
2. If no entry exists, add the eligible new work as **Open**, or as **Analyzed** when investigation already exists, with the issue facts, the evidence path, and the plan path when known.
3. Pass only eligible work in the issue assignment, with the entry identifier and tracker paths.

### Safe timing

The coordinator writes only at a quiescent orchestration boundary:

- every previously launched or resumed issue call has settled. A waiting fixer that has returned counts as settled; a fixer that could still launch a manager does not;
- no implementation manager is active or retains the implementation lock;
- no launch or resume occurs until the bounded update finishes.

Establish settlement from existing task results and reports. Do not inspect, poll, or wait on the lock to create the boundary. If ownership or settlement is unknown, keep the pending facts in session context, report tracker maintenance as pending, and edit nothing. Because the coordinator runs one selected issue run at a time, apply the settled return's update once at that boundary, then select the next run. Do not hold a settled return for an unrelated tracker update beyond the bounded update itself.

Status may lag while the selected issue run is in progress. At the boundary, the coordinator applies each item's latest evidenced lifecycle once, so no intermediate writes or status gates are needed.

Historical reconciliation belongs to the coordinator alone. Edit only when reports establish settled calls, a stable worktree, and no manager active or holding the lock, and your effective instructions authorize the moves with any conflict resolved. Delivery, lock release, and reading updated source do not replace previously loaded instructions. If either prerequisite is missing or uncertain, or an item's evidence or scope is unclear, report the affected reconciliation as pending and leave it untouched. Do not probe, poll, start a replacement session, or transfer authority.

### Implementation manager updates

After it acquires the lock, the manager reads this protocol and the fresh exact entry:

- A missing, ambiguous, or unmatched identifier is a blocker. Do not invent, guess, or duplicate an entry; make no tracker edit.
- Before implementation delegation, the manager sets the entry to **In progress**, links the approved plan, and notes the implementing manager role.
- After worker settlement, validation, commit, and stabilization, and before releasing the lock, it records only factual progress. Full implementation stays **In progress** with an "implementation complete; fixer reconciliation pending" note and the commit and validation references. A known partial attempt that returns to design becomes **Analyzed** with the remaining work and the plan revision needed. A prerequisite or unsafe settled outcome becomes **Blocked** with its named cause.
- Contention-only attempts edit nothing.

Tracker edits are ignored working artifacts. They are never staged or committed and are not counted as uncommitted issue mutation. Lock release remains the final mutation.

### Settlement mapping

For issue-team runs, the coordinator applies these actions at a safe boundary:

| Evidence | Tracker action |
| --- | --- |
| Investigation exists; design not approved or needs revision | **Analyzed**; preserve the audit and the current plan links |
| Reviewed, fixer-approved plan, including lock contention | **Designed**; link the plan. Waiting is a note, not a status |
| Settled `BLOCKED`, `FAILED`, or `CANCELLED` return, or an otherwise settled attempt with a named prerequisite, failure needing resolution, or unsafe or unknown outcome | **Blocked** with the actual cause or cancellation note. Never infer success |
| `COMPLETED` with [Done evidence](#done-evidence) | Move the full entry to the top of the appropriate completed-delivery section of `done.md`. Replace it in `todo.md` with `**[Item name]** — Done. See [done.md](./done.md). Commit(s): <hashes>.` Keep the pointer briefly (days, not weeks); prune older pointers during periodic cleanup |
| Settled `ABANDONED` | Archive the full assessment of the identified terminal scope under `## Closed without implementation` in `done.md`, label it `ABANDONED`, and remove that scope from the active queue without a Done pointer. Keep any independently actionable parent scope in `todo.md` under its existing identifier and cross-link the entries rather than duplicating work or erasing delivery history |

For an `ABANDONED` assessment, preserve the identifier, plan and review references, merit evidence and reason, exact closed scope, and any stabilized units, commits, and validation including failures and limits, or links that establish them. Distinguish no implementation from **abandoned remainder after partial delivery** across the full history, not just the last attempt. Abandonment is a disposition, not a new status, Done, or work to relaunch automatically.

### Done evidence

For completed delivery, require the unchanged approved-plan record, the manager's validation results, the commit hashes, and stable read-only reconciliation. If any is missing, do not file or mark the entry as Done; name the missing evidence and report it.

Completion records issue implementation only. Aggregate workflow results stay separate. A later aggregate defect is a new item routed through the normal fix workflow; never erase it silently or describe it as already fixed.

Task and session IDs remain useful session context. They are never tracker fields.

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
- For eligible new work, prefer recording it to losing it. Do not use intake to reopen terminal scope.
