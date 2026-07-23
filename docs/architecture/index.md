# Architecture

This directory contains only current Saivage v3 architecture documentation. Superseded design provenance lives under `docs-old/` and is not implementation authority.

The canonical main documentation set is `docs/spec/system-specification.md`, `docs/spec/operator-ui.md`, `docs/architecture/system-architecture.md`, and `README.md`. Use [System architecture](./system-architecture.md) as the canonical architecture entry point.

## Current architecture authority

- [System architecture](./system-architecture.md) — current design summary and canonical architecture entry point.

Activation ownership is plain callback-free supervisor state in one map. `CardProcessActor` remains the micro-actor, while `ConversationLLMActor` is the direct provider/tool phase owner; they remain connected to supervisor structure through one concrete invocation-bound child lease and one exact parent-bound planner port. [System architecture](./system-architecture.md) is authoritative for those ownership boundaries.
