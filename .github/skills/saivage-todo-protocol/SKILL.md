---
name: saivage-todo-protocol
description: Track Saivage v3 work items through their lifecycle using docs/working/todo.md and docs/working/done.md. Use when adding, updating, completing, or reviewing work items, issues, features, or refactoring tasks.
---

# Saivage v3 Todo/Done Protocol

## Purpose

Maintain a single living view of all active and completed work items for Saivage v3. Every issue, feature, refactoring, or improvement — whether discovered through code review, operational observation, or design discussion — is tracked through this protocol.

## Files

### `docs/working/todo.md`

Active work items. Every item the team or agents are working on or plan to work on lives here. Items are organized into sections (Open Issues, UI Responsiveness, Open Refactoring, Reference, etc.) and each carries a status.

### `docs/working/done.md`

Completed items. When an item is finished, its full entry moves from `todo.md` to `done.md`. The entry in `done.md` should preserve enough context (commits, scope, key decisions) to serve as a historical record.

### `known_issues.md` (repo root)

Points to `docs/working/todo.md`. Do not add content here; it is a signpost only.

## Item lifecycle

An item progresses through these statuses:

1. **Open** — Identified but not yet analyzed. No root cause or fix direction documented.
2. **Analyzed** — Root cause understood, fix direction documented. An audit, investigation, or findings report exists (either inline or at a `docs/working/` path referenced from the item).
3. **Designed** — An adversarially-reviewed design/implementation plan exists at a `docs/working/<date>-<slug>/` path. The plan has passed the `saivage-issue-fix-adversarial-review` skill's review loop.
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
