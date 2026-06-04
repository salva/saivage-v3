# Decisions & Deferred Items


> **Authority status: historical.** This page is retained for provenance only. Prefer `docs/agents.md` for current authority where applicable. See `docs/documentation-inventory.md` for disposition `move-to-docs/historical/`.

> Canonical design document consolidated from `docs/design/decisions.md` during Stage 22. Stage 23 will reconcile detailed source anchors where needed.


This document records architectural decisions and items explicitly
deferred from the initial design.

---

## Decisions

1. **Card templates**: No templates for now. Cards are created
   from scratch by the analyst or planner.

2. **Parallelism**: Execution is sequential by default — one
   planner, executor, or reviewer runs at a time. The analyst is
   the only always-available concurrent agent. Optional parallel
   dispatch is deferred.

3. **Card editing**: Cards can be edited while in `drafting` or
   `backlog`. Once `active` or beyond, changes are expressed as
   notes/directives, or by cancelling and restarting the card.

4. **Notification granularity**: Notify on goal completion, goal
   failure, and escalation by default. Configurable via
   notification filters (see `configuration.md §Notifications`).

5. **Budget tracking**: Not required for now.

6. **Operational work**: No separate functional/operational
   category. Operational work uses `Ops` terminal cards or
   ordinary goals containing `Ops` cards. Operational goals still
   require a plan card and passing review — no special treatment.

7. **Artifact cleanup policy**: Keep the `retain` flag on
   artifacts but do not define an automatic cleanup policy beyond
   the safety rules in `data-model.md §Cleanup Policy`.

8. **Attachment rendering**: Attachments (inline images, charts,
   HTML reports) render only in the web UI. Telegram can link to
   the card or notify that attachments exist, but does not render
   them inline.

9. **Plan diary format**: Planner diary entries are stored as
   structured JSON. Rendered as Markdown on the fly in the UI and
   chat.

10. **Recursion depth limit**: Configurable maximum goal depth
    (default: 5 levels). The planner receives current depth and
    max depth in context and must plan within that limit.

11. **Findings dossiers archived**: The previously separate
    `audit-findings/` and `ui-findings/` dossiers were archived during
    the 2026-05-23 historical-doc cleanup. They remain under
    `old-documents/` for provenance and are not part of the active
    documentation set. Current source-vs-docs and operator-surface
    issues are tracked through the normal stage/issue flow, not
    through dossier-style logs.

---

## Persistence Model

All data is stored as files on the local filesystem. There is no
external database.

- **`.saivage/`**: Persistent project metadata and state:
  `project.json`, `saivage.json`, `auth-profiles.json`, card records,
  plan diaries, notes, agent sessions, runtime state, skills,
  instructions, and indexes.
- **`.saivage-work/`**: Generated work products and disposable or
  retainable outputs: artifacts, attachments, process logs, downloads,
  stash, quarantine payloads, uploads, previews, and temporary runtime
  files.

The authoritative schemas and file tree are defined in
`data-model.md`.

---

## Web UI

The web UI is a **card-centric control room** for supervising the
autonomous runtime. The detailed UX layout, navigation, section
composition, and visual design are defined in `docs/design/ux-design.md`.

Key principles:
- A **left rail** provides section navigation (Dashboard, Cards,
  Agents, Files, Debug).
- The **Dashboard** combines the analyst chat stream and a runtime
  status panel.
- The **Cards** section is the primary workspace: tree view, board,
  leaderboard, and timeline over the card model.
- The **Agents** section shows agent conversations and tool traces.
- The **Files** section browses `.saivage/` metadata and
  `.saivage-work/` outputs.
- The **Debug** section exposes runtime state, errors, and timeline.

Cards created via the web UI go through the analyst agent for
structuring (same flow as Telegram or CLI).

## Design policy: no backward compatibility

Saivage v3 is developed under a workspace-wide, mandatory no-backward-
compatibility rule:

- Clean architecture is the top priority, even when it means more upfront
  work.
- Old on-disk formats, configs, schemas, tests, and APIs are **removed**
  rather than wrapped in migration shims when a new design supersedes
  them.
- "Minimal change" defaults do not apply: refactor broadly when it
  improves the design.
- Old behavior may be preserved only when an operator-facing contract
  still requires it; in that case the contract is the source of truth, not
  legacy code paths.

This policy is the reason most design pages here describe a single current
mechanism rather than "current vs legacy" pairs.

## Stage v3-001 control-flow diagnosis — closed

The Stage v3-001 control-flow diagnosis (runtime-command / activation-ledger
ownership of execution; planner-state is not an executable trigger) is
closed. The current authority for that model is
[`docs/goal-planning-runtime.md`](../goal-planning-runtime.md) and
[`docs/operation.md`](../operation.md); the stale design page
[`docs/design/runtime.md`](./runtime.md) is retained only as a pointer.
