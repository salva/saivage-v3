# Architecture

This directory contains only current Saivage v3 architecture documentation. Superseded design provenance lives under `docs-old/` and is not implementation authority.

The canonical main documentation set is `docs/spec/system-specification.md`, `docs/spec/operator-ui.md`, `docs/architecture/system-architecture.md`, and `README.md`. Use [System architecture](./system-architecture.md) as the canonical architecture entry point.

## Current architecture authority

- [System architecture](./system-architecture.md) — current design summary and canonical architecture entry point.
- [Micro-actor runtime implementation status](./micro-actor-runtime-implementation-plan.md) — current actor ownership and removed-recovery status.

Activation ownership is plain callback-free supervisor state in one map. `CardProcessActor` and `ConversationLLMActor` remain actors, connected to supervisor structure through one concrete invocation-bound child lease and one exact parent-bound planner port.
