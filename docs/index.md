---
layout: home

hero:
  name: Saivage v3
  text: Autonomous multi-agent runtime for software-development work
  tagline: >-
    Saivage turns a software objective into a visible tree of cards. Planners
    decompose work, executors perform terminal cards, reviewers assess results,
    and the runtime alone dispatches them. The operator steers everything
    through one Analyst conversation.

actions:
  - theme: brand
    text: What is Saivage?
    link: /overview
  - theme: alt
    text: Operator runbook
    link: /runbook/
  - theme: alt
    text: System specification
    link: /spec/system-specification

features:
  - icon: 🗂️
    title: Card-centered work
    details: >-
      Every objective is a tree of cards with brief, status, and review records.
      Planners own goal subtrees; executors own terminal cards; every card keeps
      an exact append-only history.
  - icon: 🤖
    title: Named agents with exact authority
    details: >-
      Planner, Executor, Reviewer, Analyst, and Oversight agents each get a
      compiled prompt, tool inventory, and model route. Creation, activation,
      and reopening authority is configured per role.
  - icon: 🧭
    title: One operator surface
    details: >-
      A web control room shows the card tree, agent sessions, files, processes,
      and debug state. Ordinary operator mutations go through the global Analyst
      conversation.
  - icon: 🔒
    title: Explicit trust model
    details: >-
      Saivage runs inside an externally isolated container with trusted
      root-capable agents. External operator authentication and outbound secret
      non-disclosure remain product boundaries.
  - icon: 💾
    title: Plain-file persistence
    details: >-
      Durable state is ordinary files: append-only JSONL streams with strict
      envelopes. No database, no migrations; incompatible format cutovers are
      reset-only.
  - icon: 🔍
    title: Searchable current docs
    details: >-
      This site is served by every running instance at /docs/ and published on
      GitHub Pages from the same build.
---

## Documentation map

Each authority owns its subject exactly; nothing on this site overrides them.

| Document | Role |
| --- | --- |
| [Overview](overview.md) | Orientation: what Saivage is, the card model, agent roles, the run loop, and vocabulary. Not an authority. |
| [System specification](spec/system-specification.md) | Sole authority for product, runtime, CLI-visible behavior, and exact functional contracts. |
| [Operator UI specification](spec/operator-ui.md) | Sole authority for operator web UI behavior and presentation. |
| [System architecture](architecture/system-architecture.md) | Sole authority for component ownership, dependency direction, internal architecture, and source-derived inventories. |
| [Operator runbook](runbook/index.md) | Sole authority for deployment, startup, lifecycle, recovery, reset, and other operator procedures. |

## Reading paths

- **New operator** — start with the [Overview](overview.md), then the
  [runbook](runbook/index.md) for deployment and lifecycle procedures.
- **Contributor or reviewer** — read the [Overview](overview.md), then the
  [system architecture](architecture/system-architecture.md).
- **Exact behavior question** — go straight to the
  [system specification](spec/system-specification.md) or the
  [operator UI specification](spec/operator-ui.md).
