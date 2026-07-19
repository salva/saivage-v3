# Micro-Actor Runtime Implementation Status

This implementation note is subordinate to [System Architecture](./system-architecture.md) and records the current micro-actor cutover. Older snapshot/reconstruction phases are removed, not deferred.

## Current Status

## Current Runtime Shape

- The runtime installs one process-local instance and owns the exact live-card map.
- One `CardActor` owns each live activation and its synchronous result/cancel claim.
- Project/goal restart begins planner; terminal-card restart begins executor; reviewer is nested live work only.
- Pause is one request flag and one parked frontier. Stop interrupts open work for restartable containment; only when domain cancellation already owns the claim does Stop join that exact actor's cancellation settlement.
- Stable planner/executor/reviewer session owners locally settle only the latest interrupted conversation round.
- The micro-actor lifecycle exposes only initial-state `start()`; no recover or rehydrate entrypoint exists.
- Every actor constructor supplies an immutable compiled topology and per-instance generic lifecycle callbacks directly to `BaseActor`. Fixed topologies compile once and are shared; behavior is neither embedded in topology nor discovered through static properties, reflection, or state-named methods.
- Start assigns the initial state and invokes only `enter`. External transitions run `leave`, source-task abort/clear, target assignment, `transition`, then `enter`; unknown events and ordinary same-state transitions run no callback.
- Runtime state, actor snapshots, active reconstruction, recovery diagnostics, and replay coordinators do not exist.

## CardActor Cancellation Contract

Cancellation claims the activation before its first await, revokes all late commits, contains activation-owned process and descendant scopes, publishes the card cancellation, settles the caller exactly once, and removes live ownership last. Result-first and cancel-first races therefore have one winner. A running card without exactly one owner fails fast.

## Commit Boundaries

Every await-before-Saivage-mutation path checks the exact activation/Analyst/runtime owner signal immediately after its final await and immediately before the synchronous commit. Purely synchronous operations complete in their JavaScript turn. This is lifecycle exclusion only; no global writer gate or persistence currentness is introduced.

## Session And Notification Flow

Each stable role session is its sole conversation writer. Source input is a fresh UUID per invocation. Interruption settlement pairs an unmatched latest call with a failed result under its original call identity. Planner/executor terminal acceptance performs the pending-notification gate; reviewer defers all terminal outcomes when pending and never drains card context.

## Persistence Boundary

Actors call `CardService` and named direct file functions. They do not own repositories, stores, snapshots, runtime files, summary caches, availability files, health latches, or recovery coordinators. Hierarchical card-segment identity, publication-temp UUID identity, and invocation UUID identity are separate scopes.

## Validation Focus

Current validation protects exact live-owner cancellation, Stop→Run same-session behavior, notification terminal races, local interruption settlement, two-stage progressive compaction, opaque hierarchical card identity, direct file I/O, and lifecycle-lock-only CLI delegation.

## Completed Remediation R1-R4

The former reconstruction, durable-runtime-state, and indirect persistence phases were removed by the reset-only cutover. The current runtime shape above is the only supported implementation.

## P1 ProcessRunner Owns Truthful Process State And Scoped Termination

Process ownership is process-local and activation-scoped. Stopped runtime instances do not reconstruct or adopt prior process identities.

## P2 Startup Process Reconciliation And Actor Reconstruction Are Removed

Obsolete. Startup begins with an empty process registry and performs no process reconciliation or actor replay.

## P3 CardActor Owns Authoritative Cancellation And Activation ID Settlement

The cancellation contract above is current. The activation claim and exact live-owner map provide the sole running-card cancellation authority.

## P4 RuntimeGate Replaces LLM Admission And Owns The Pause Barrier

The current pause frontier blocks fresh admission while allowing already-admitted synchronous settlement to reach its boundary.

## P5 Reviewer Cannot Reach Main-Agent Notification Delivery

Reviewer work never drains card notifications. Pending context defers every reviewer terminal outcome back to a fresh planner round.

## Boundary Cleanup Folded Into The Slices Above Or Standalone

Boundary cleanup is complete in the singular current contracts above; no compatibility path remains.
