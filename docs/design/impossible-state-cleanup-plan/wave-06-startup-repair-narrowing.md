# Wave 6: Startup Repair Narrowing

Findings covered: C19, R02, R03.

## Objective

Keep startup repair explicit and narrow. Startup may repair persisted process-death fallout, but it must fail on contradictory card/runtime truth and must not leak stale repair metadata into normal planning.

This wave depends on the Wave 2 dispatch ownership model. Startup repair decisions must use ownership metadata when deciding whether an open run can be reconciled.

## Architecture Decision

Startup repair is allowed only for known persisted states left by interrupted runtime ownership. Repair decisions must name the exact contradiction they handle. Anything outside those shapes is a startup invariant failure.

Normal planner phase should not treat stale repair metadata as authoritative unless card status/lifecycle explicitly say the card is currently blocked.

## Implementation Design

### Step 1: Tighten Blocked-Planning Metadata Semantics

Current normal planner block check: `src/runtime/phases/planner-phase.ts#L156-L164`.

Blocked-planning metadata should be valid only when card status/lifecycle currently represent blocked planning. Options:

Preferred simple option:
- if `getBlockedPlanning(card)` returns metadata and card is not blocked, throw invariant error
- clear blocked-planning metadata explicitly when resuming/unblocking a card

Do not silently re-block from stale metadata.

### Step 2: Narrow Startup Blocked-Planning Alignment

Current startup alignment: `src/runtime/startup-blocked-planning.ts#L18-L42`.

Change behavior:
- if card is already blocked with blocked-planning metadata: align open planner run if needed
- if card is active/planning-compatible with blocked metadata from an interrupted planner: block it
- if card is terminal with blocked metadata: throw startup invariant error
- if card status/lifecycle disagree: throw startup invariant error

### Step 3: Narrow Idle/Open-Run Reconciliation

Current broad reconciliation: `src/runtime/runtime-core.ts#L542-L597`, startup caller `src/runtime/runtime-startup.ts#L86-L94`.

Expected repair shape:
- root run open, runtime idle, project terminal: close root run with project lifecycle outcome

Unexpected shape:
- child/non-root run open while runtime idle/no active run
- multiple open runs with no active run
- open run ownership cannot be reconstructed

Unexpected shapes should fail startup unless a specific repair function is written for that exact case.

If an open run lacks ownership metadata after Wave 2, startup may reconstruct ownership only from matching runtime activations, runtime runs, card parentage, and persisted session metadata. If the relation cannot be proven, startup fails.

### Step 4: Keep Repair Code Out Of Normal Planner Phase

Audit any calls from normal runtime phases into startup/repair helpers. Move repair-only interpretation into startup modules.

## Tests

Add/update:

- terminal card with blocked-planning metadata fails startup
- active/planning-compatible interrupted blocked planner can be repaired if status/lifecycle match expected repair shape
- normal planner phase throws on stale blocked metadata/status mismatch
- idle runtime with open child run fails startup
- idle runtime with terminal project/open root run reconciles narrowly
- idle runtime with open child run or run lacking provable ownership fails startup

Focused command:

```bash
NODE_OPTIONS=--experimental-vm-modules npx jest tests/runtime/startup-blocked-planning.test.ts tests/runtime/startup-repair.test.ts tests/runtime/planner-phase.test.ts tests/runtime/startup-repair.test.ts --runInBand --forceExit
```

## Validation

```bash
npm run typecheck
npm test
npm run validate:docs
```

## Stop Criteria

Wave 6 is complete when startup repair handles only named repair shapes, contradictory persisted state fails startup, and normal planner phase does not re-block from stale metadata.
