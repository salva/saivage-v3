# Micro-Actor Runtime Implementation Status

This implementation note is subordinate to [System Architecture](./system-architecture.md) and records the current micro-actor cutover. Older snapshot/reconstruction phases are removed, not deferred.

## Current Status

## Current Runtime Shape

- The runtime installs one process-local instance and the supervisor owns one exact `activationOwners` map.
- One plain `CardActivationOwner` holds each activation's phase, result/cancel winner, independent containment owner, ready processor, relationship, publication task, and retained failure. It is not a `BaseActor`.
- The one `CardProcessActor` implementation remains the sole micro-actor over a narrow `BaseActor`. `ConversationLLMActor` is the direct provider/tool phase owner.
  The direct owner has no compiled topology, event queue, `start()`, or actor lifecycle settlement. It alone constructs the complete LLM invocation context and concrete child lease; supervisor transitions coordinate that lease with owner structure.
- Backlog, changed, blocked, and stopped card admission select configured `BACKLOG | CHANGED | BLOCKED | STOPPED` entries respectively; each entry routes to its configured ordinary node. Reviewer remains configured nested work rather than a code-selected lifecycle entry.
- Pause is one request flag and one parked frontier. Stop contains open work; only when domain cancellation already owns the claim does Stop join that exact actor's cancellation settlement.
- Stable planner/executor/reviewer session owners locally settle only the latest interrupted conversation round.
- `BaseActor` exposes one-use initial-state `start()` and explicit parked-state event activation; no recover or rehydrate entrypoint exists.
- Configured planning and terminal workflows compile once at startup per family into shared entry/node/terminal definitions. There is no sequence shorthand, wrapper graph loop, or cursor; accepted result events route through the definition, including explicit same-state reentry.
- Live process position and zero-based node ordinal are process-local projections only. STOPPED recovery constructs a fresh actor and does not rehydrate prior process state.
- `BaseActor` owns the immutable topology, one pending event, one task slot, and lifecycle settlement. `CardProcessActor` supplies direct transition and state-entry hooks; behavior is not embedded in topology or supplied as generic bindings. Conversation LLM completion and cancellation instead use exact direct phase replacement, operation-local settlement, and provider lifecycle containment.
- Start assigns the initial parked ready state and invokes state entry directly. Activation sends the selected configured entry event. Node entry fills the sole task slot; settlement clears that slot before the matching completion or failure function runs. The activation tracker owns cancellation of the node operation.
- A matching tracker consumer stages an accepted result and sends its event. Dispatch assigns the target, runs the direct transition hook, then runs target entry. Same-node reentry therefore orders settled and cleared old task, staged accepted result, accepted event, transition, and one new node entry/task. Unknown events and ordinary non-reentering same-state transitions run no hooks.
- Ordinary node failure stages `execution:failed` and routes to the code-owned failed terminal. App-log publication failure is distinct: it sends no event, halts the current task state during failure delivery, rejects the process result, and leaves containment joining to Supervisor.
- Runtime state, actor snapshots, active reconstruction, recovery diagnostics, and replay coordinators do not exist.

## Card Activation Cancellation Contract

Cancellation claims the activation before its first await, revokes all late commits, contains activation-owned process and descendant scopes, publishes the card cancellation, settles the caller exactly once, and removes live ownership last. Result-first and cancel-first races therefore have one winner. A running card without exactly one owner fails fast.

## Commit Boundaries

Every await-before-Saivage-mutation path checks the exact activation/Analyst/runtime owner signal immediately after its final await and immediately before the synchronous commit. Purely synchronous operations complete in their JavaScript turn. This is lifecycle exclusion only; no global writer gate or persistence currentness is introduced.

## Session And Notification Flow

Each stable role session is its sole conversation writer. Source input is a fresh UUID per invocation. Interruption settlement pairs an unmatched latest call with a failed result under its original call identity. Planner/executor terminal acceptance performs the pending-notification gate; reviewer defers all terminal outcomes when pending and never drains card context.

## Persistence Boundary

Actors call `CardService` and named direct file functions. They do not own repositories, stores, snapshots, runtime files, summary caches, availability files, health latches, or recovery coordinators. Hierarchical card-segment identity, publication-temp UUID identity, and invocation UUID identity are separate scopes.

## Validation Focus

Current validation protects exact live-owner cancellation, direct Conversation LLM completion/cancellation ownership, Stop→Run same-session behavior, notification terminal races, local interruption settlement, two-stage progressive compaction, opaque hierarchical card identity, direct file I/O, and lifecycle-lock-only CLI delegation.

## Completed Remediation R1-R4

The former reconstruction, durable-runtime-state, and indirect persistence phases were removed by the reset-only cutover. The current runtime shape above is the only supported implementation.

## P1 ProcessRunner Owns Truthful Process State And Scoped Termination

Process ownership is process-local and activation-scoped. Stopped runtime instances do not reconstruct or adopt prior process identities.

## P2 Startup Process Reconciliation And Actor Reconstruction Are Removed

Obsolete. Startup begins with an empty process registry and performs no process reconciliation or actor replay.

## P3 Supervisor Owns Authoritative Cancellation And Activation Settlement

The cancellation contract above is current. The activation claim and exact live-owner map provide the sole running-card cancellation authority.

## P4 RuntimeGate Replaces LLM Admission And Owns The Pause Barrier

The current pause frontier blocks fresh admission while allowing already-admitted synchronous settlement to reach its boundary.

## P5 Reviewer Cannot Reach Main-Agent Notification Delivery

Reviewer work never drains card notifications. Pending context defers every reviewer terminal outcome back to a fresh planner round.

## Boundary Cleanup Folded Into The Slices Above Or Standalone

Boundary cleanup is complete in the singular current contracts above; no compatibility path remains.
