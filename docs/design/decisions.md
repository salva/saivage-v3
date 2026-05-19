# Decisions & Deferred Items

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