# Architecture

This directory contains only current Saivage v3 architecture documentation. Superseded design provenance lives under `docs-old/` and is not implementation authority.

The canonical main documentation set is `docs/spec/system-specification.md`, `docs/spec/operator-ui.md`, `docs/architecture/system-architecture.md`, and `README.md`. Use [System architecture](./system-architecture.md) as the canonical architecture entry point.

## Current architecture authority

- [System architecture](./system-architecture.md) — current design summary and canonical architecture entry point.

Ordinary activation state, transition, persistence, and lease coordination is plain callback-free supervisor state in one map. `CardProcessActor` remains the micro-actor, while `ConversationLLMActor` is the direct provider/tool phase owner; they remain connected to supervisor structure through one concrete invocation-bound child lease and one exact parent-bound planner port. The sole callback exception reports terminal CardProcess actor-main failure to its exact current/frozen owner, which starts or joins the singular halt used by Stop and application close. Outcome-unknown publication exits before that halt. [System architecture](./system-architecture.md) is authoritative for those ownership boundaries.
## Publication fatal boundary

An outcome-unknown Saivage durable publication reaches its first injected fatal
boundary and exits the process before `SupervisorRuntimeApi.beginHalt()` or any
runtime-status mutation. Ordinary **Stop project**, application close, and terminal
CardProcess actor-main failure continue to start or join the singular Supervisor halt
and retain `closing -> stopped | error`. See [System architecture](./system-architecture.md).
