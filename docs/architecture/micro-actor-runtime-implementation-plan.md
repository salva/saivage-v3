# Micro-Actor Runtime Implementation Status

This implementation note is subordinate to [System Architecture](./system-architecture.md) and records the current micro-actor cutover. Older snapshot/reconstruction phases are removed, not deferred.

## Current Status

## Current Runtime Shape

- The runtime installs one process-local instance and owns the exact live-card map.
- One `CardActor` owns each live activation and its synchronous result/cancel claim.
- Project/goal restart begins planner; terminal-card restart begins executor; reviewer is nested live work only.
- Pause is one request flag and one parked frontier. Stop closes the instance and cancels through exact actors.
- Stable planner/executor/reviewer sessions recover only their latest local conversation round.
- Runtime state, actor snapshots, active reconstruction, recovery diagnostics, and replay coordinators do not exist.

## CardActor Cancellation Contract

Cancellation claims the activation before its first await, revokes all late commits, contains activation-owned process and descendant scopes, publishes the card cancellation, settles the caller exactly once, and removes live ownership last. Result-first and cancel-first races therefore have one winner. A running card without exactly one owner fails fast.

## Commit Boundaries

Every await-before-Saivage-mutation path checks the exact activation/Analyst/runtime owner signal immediately after its final await and immediately before the synchronous commit. Purely synchronous operations complete in their JavaScript turn. This is lifecycle exclusion only; no global writer gate or persistence currentness is introduced.

## Session And Notification Flow

Each stable role session is its sole conversation writer. Source input is a fresh UUID per invocation. Interruption settlement pairs an unmatched latest call with a failed result under its original call identity. Planner/executor terminal acceptance performs the pending-notification gate; reviewer defers all terminal outcomes when pending and never drains card context.

## Persistence Boundary

Actors call `CardService` and named direct file functions. They do not own repositories, stores, snapshots, runtime files, summary caches, availability files, health latches, or recovery coordinators. Card identity, publication-temp identity, and invocation identity are separate UUID scopes.

## Validation Focus

Current validation protects exact live-owner cancellation, Stop→Run same-session behavior, notification terminal races, local interruption settlement, two-stage progressive compaction, opaque UUID card identity, direct file I/O, and lifecycle-lock-only CLI delegation.

## Completed Remediation R1-R4

The former reconstruction, durable-runtime-state, and indirect persistence phases were removed by the reset-only cutover. The current runtime shape above is the only supported implementation.

## P1 ProcessRunner Owns Truthful Process State And Scoped Termination

Process ownership is process-local and activation-scoped. Stopped runtime instances do not reconstruct or adopt prior process identities.

## P2 Startup Reconciles Processes Before Actor Recovery

Obsolete. Startup begins with an empty process registry and performs no process reconciliation or actor replay.

## P3 CardActor Owns Authoritative Cancellation And Activation ID Settlement

The cancellation contract above is current. The activation claim and exact live-owner map provide the sole running-card cancellation authority.

## P4 RuntimeGate Replaces LLM Admission And Owns The Pause Barrier

The current pause frontier blocks fresh admission while allowing already-admitted synchronous settlement to reach its boundary.

## P5 Reviewer Cannot Reach Main-Agent Notification Delivery

Reviewer work never drains card notifications. Pending context defers every reviewer terminal outcome back to a fresh planner round.

## Boundary Cleanup Folded Into The Slices Above Or Standalone

Boundary cleanup is complete in the singular current contracts above; no compatibility path remains.
