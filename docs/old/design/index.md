# Design documentation


This section is the design and planning index for Saivage v3. It preserves design-era concept pages, current remediation plans, and architecture proposals. It is not the functional specification authority; approved product contracts live under [Functional Specifications](/specifications/), and current runtime/card/agent behavior lives in [Agents and runtime architecture](/agents).

Use these pages for design-era context or active implementation planning. For current operator behavior, start with the runbook and active reference docs.

## Concepts

- [Card Model](./card-model.md)
- [Card Lifecycle](./card-lifecycle.md)
- [Agents](./agents.md)
- [Runtime](./runtime.md)
- [Terminal Commit Layer](./terminal-commit-layer.md)
- [Card Runner XState Porting Plan](./card-runner-xstate-porting-plan.md)
- [Card-Attached Agent Lifetime Plan](./card-attached-agent-lifetime-plan.md)
- [Duplicate Child Block Fix](./duplicate-child-block-fix.md)
- [Over-Engineering Findings](./over-engineering-findings.md)
- [Over-Engineering Remediation Plan](./over-engineering-remediation-plan.md)
- [Security](./security.md)
- [Configuration](./configuration.md)
- [Skills](./skills.md)
- [Server API](./server-api.md)
- [Data Model](./data-model.md)
- [UX Design](./ux-design.md)
- [Decisions](./decisions.md)
- [Implementation Plan](./implementation-plan.md)

## Design policies

Three workspace-wide policies apply to every design page below and to all
Saivage v3 source changes:

- **No overfeaturism.** New abstractions, options, or flags must be motivated
  by a concrete current need. Optionality is treated as a cost — generic
  hooks, "for future use" parameters, and dual code paths kept "just in
  case" are rejected unless they remove asymmetry that already exists.
- **JSON / JSONL coherence.** Operator state and audit trails are persisted as
  human-readable JSON / JSONL on disk. Alternative stores (SQLite, custom
  binary formats) are explicitly out of scope; consolidate hand-rolled
  helpers onto `JsonlLedger<T>` + `PersistentQueue<T>` and atomic JSON
  primitives rather than introducing a different storage tier.
- **One idea per file.** Mega-classes and mega-statements obscure ownership.
  Decompose god classes into typed run-hosts + ports, and prefer short,
  one-statement-per-line code over densely chained constructors.

A separate, mandatory policy — **no backward compatibility** — is recorded
in [decisions.md](./decisions.md#design-policy-no-backward-compatibility)
because it materially affects how new features replace old ones.
