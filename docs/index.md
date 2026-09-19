---
layout: home

hero:
  name: Saivage v3
  text: Autonomous software delivery
  tagline: >-
    Give Saivage the specification for a software project. It carries the work
    from specification to accepted delivery — planning, implementing, testing,
    and reviewing on its own, over long runs, with evidence for every step —
    and asks for you only when a real decision is missing.

actions:
  - theme: brand
    text: What can it do?
    link: /overview
  - theme: alt
    text: Operator runbook
    link: /runbook/
  - theme: alt
    text: System specification
    link: /spec/system-specification

features:
  - icon: 🎯
    title: Whole projects, not task lists
    details: >-
      Describe what the project must achieve. Saivage decomposes the
      specification, sequences the work, and carries it through implementation
      and verification over long runs — without step-by-step instructions.
  - icon: 🔎
    title: Evidence, not promises
    details: >-
      Every command, file change, test run, and review verdict is recorded
      durably. Progress and acceptance rest on inspectable evidence, not on
      claims.
  - icon: 🎛️
    title: You stay in control
    details: >-
      Watch the work unfold live, steer the project through one conversation,
      and pause, resume, or stop at any time.
  - icon: 🛡️
    title: Runs where it is safe
    details: >-
      Designed for an externally isolated container with trusted agents.
      Operator authentication and secret non-disclosure remain product
      boundaries.
  - icon: 💾
    title: Plain-file durability
    details: >-
      All durable state is ordinary files with exact append-only histories. No
      database, no migrations; incompatible format changes are explicit
      reset-only cutovers.
  - icon: 📚
    title: Docs built with the product
    details: >-
      This site is built from the same repository every instance serves at
      /docs/, with drift guards keeping the published pages current.
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
