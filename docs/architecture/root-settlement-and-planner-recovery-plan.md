# Root Settlement And Planner Recovery Plan

Status: provenance. The root-settlement projection fix and CardActor cleanup are tracked in [Micro-Actor Runtime Implementation Plan — Boundary cleanup](./micro-actor-runtime-implementation-plan.md#boundary-cleanup-folded-into-the-slices-above-or-standalone). The supervisor state machine below predates R3 (which removed `shutting_down`) and is not current authority.

Card-editing note: the root-settlement findings in this plan remain useful, but the planner recovery tool details predate the record-backed card storage design. Any implementation of planner recovery edits should follow [Record-Backed Card Storage Plan](./record-backed-card-storage-plan.md): planner intent text is written through `write(record://brief.md?card=...)`, broad card field patching is not a target surface, and structural/lifecycle changes use semantic operations.

## Review Outcome

This plan replaces the earlier receiver-first proposal. The review found that a typed `CardActivationReceiver` abstraction is not required for the current bugs and would mostly wrap the existing parent-private promise with no behavioral gain. That is not consistent with the repository rules: no compatibility constructions, no dead infrastructure, and simple clean architecture first.

The primary fix is root settlement/projection. Planner recovery tools are the next slice. `CardActor` can still be cleaned up by removing its unused activation rejection slot, but that cleanup should not introduce a new receiver interface unless a concrete caller needs behavior that a private promise cannot express.

## Problem

The actor runtime has two current gaps:

- A root project card can settle `blocked` while the runtime still projects `running` with `currentCardId = 'project'`. The root activation is already settled, so the supervisor should no longer report active running work.
- A planner can create and activate child cards, but cannot recover from failed/blocked/obsolete child work by editing or cancelling immediate children.

There is also a smaller cleanup opportunity: `CardActor` stores a pending activation `reject` callback that is never called. Processor exceptions are converted into failed card outcomes, and activation precondition failures return rejected promises before a pending activation exists.

## Goals

- Fix root project settlement so every root terminal outcome leaves the supervisor out of active `running` projection.
- Preserve precise root outcome in the runtime run record.
- Add planner-owned `edit_card` and `cancel_card` for immediate children only.
- Keep `activate_card` directly owned by `PlanningCardProcessorActor` because it is the planner sequencing boundary.
- Remove `CardActor`'s unused pending activation rejection slot.
- Tighten planner tool definitions so schemas match actor-owned handler semantics.
- Remove misleading/dead create-card inputs such as planner-created `depth: 0`.

## Non-Goals

- Do not modify `src/runtime/micro-actor/micro-actor.ts`.
- Do not add `CardActivationReceiver`, `activateWithReceiver`, callback adapters, or future-facing parent-reaction abstractions in this slice.
- Do not add a parallel orchestration layer above the actor runtime.
- Do not introduce a new `edited` status. The existing `changed` status is the reactivatable edited state.
- Do not add `restart_card`. Editing a non-done child to `changed`, then activating it again, is the restart path.
- Do not make `LLMActor` aware of planner queues, card recovery, or card-tree semantics.
- Do not expand reviewer or executor tool surfaces in this slice.
- Do not add runtime status enum values unless a separate API/schema design requires them.

## Validated Findings

### Receiver abstraction is unnecessary

The current parent contract is already a parent-private promise:

- `PlanningCardProcessorActor.handleToolCall(...)` awaits `actor.activate(...)` and returns an inline tool result to the planner LLM loop.
- `SupervisorRuntimeApi.startProject(...)` awaits `actor.activate(...)` and finalizes the runtime run/projection.

The root projection bug is in `SupervisorRuntimeApi.startProject(...)`, not in `CardActor` outcome delivery. Adding a typed receiver would not fix the bug. It would add an interface and adapter around behavior already provided by a promise.

### CardActor reject is dead code

`CardActor.#pendingActivation.reject` is stored but never called. Existing behavior is:

- activation precondition failures return `Promise.reject(...)` before pending activation is created.
- processor exceptions become a failed `CardActivationOutcome` through `commitOutcome(...)`.
- cancellation resolves the pending activation with `{ status: 'cancelled' }`.

The cleanup is to remove `reject` from `PendingActivation`; do not replace it with `onCardActivationFailed` or equivalent unused structure.

### Runtime schemas already carry root blocked/failed outcome

`RuntimeRunPhase` already includes `failed`, `blocked`, and `cancelled`. `RuntimeRunStatus` already includes `stopped` and `cancelled`. Therefore the smallest correct root-settlement projection is:

- precise outcome in `run.phase` and `run.outcome`.
- `run.runtime_status = 'stopped'` for blocked/failed root outcomes.
- `run.runtime_status = 'cancelled'` for cancelled root outcomes.
- `run.runtime_status = 'idle'` for completed root outcomes.
- `RuntimeStatus` returned by `getStatus()` is not extended in this slice.

### Planner edit must respect lifecycle rules

Existing card mutation rules make this non-trivial:

- `failed`, `done`, and `cancelled` are terminal states for ordinary edits.
- `blocked` is lifecycle-locked but not terminal for the ordinary edit terminal-state branch.
- `depends_on` is a critical field outside `backlog`.
- `setStatus('changed')` is already the lifecycle-owned reopen transition.

The actor planner edit tool must use a narrow runtime-owned mutation path instead of pretending a generic `update(...)` can atomically edit every state.

### Running child edits should be rejected

`CardActor.markChanged(...)` only enqueues a change notification. It does not carry or persist field patches. Therefore `edit_card` must reject running children in this slice. A later design can add deferred patch delivery if that becomes necessary.

### Cancel fallback is unnecessary

`SupervisorRuntimeApi.childrenPort().get(cardId)` constructs a `CardActor` for any existing child. Planner `cancel_card` should require that actor path and not carry a fallback mutation path for an unavailable actor.

## Root Settlement Design

### Supervisor state machine

Add a neutral settlement event to `RuntimeSupervisorActor`.

Current `running -> idle` transition is named `cancel`, which is correct for operator stop but wrong for a naturally settled root. Add `settle`:

```ts
states: {
  idle: { parked: true, on: { run: 'running', shutdown: 'shutting_down' } },
  running: { parked: true, on: { pause: 'paused', cancel: 'idle', settle: 'idle', shutdown: 'shutting_down' } },
  paused: { parked: true, on: { run: 'running', cancel: 'idle', settle: 'idle', shutdown: 'shutting_down' } },
}
```

Expose it as:

```ts
settleProject(): boolean
```

Keep `cancelProject()` for operator stop/cancellation only.

### Runtime finalization

Refactor `SupervisorRuntimeApi.startProject(...)` so root activation finalization is centralized in a private method:

```ts
private finalizeRootRun(outcome: CardActivationOutcome, finishedAt: string): RuntimeRunRecord
```

Finalization rules:

| Root outcome | phase | runtime_status | finished_at | outcome |
|---|---|---|---|---|
| `done` | `completed` | `idle` | timestamp | `{ kind: 'completed', result: 'done', finished_at }` |
| `failed` | `failed` | `stopped` | timestamp | `{ kind: 'completed', result: 'failed', error, finished_at }` |
| `blocked` | `blocked` | `stopped` | `null` | `{ kind: 'blocked', error }` |
| `cancelled` | `cancelled` | `cancelled` | timestamp | `{ kind: 'completed', result: 'cancelled', finished_at }` |

After every root outcome:

- assign the finalized run record to `activeRun`.
- set `currentCardId = null`.
- call `supervisor.settleProject()` for `done`, `failed`, and `blocked`.
- call `supervisor.cancelProject()` only for a root cancellation outcome caused by cancellation semantics.
- return the finalized run in `StartProjectResult`.

`getStatus()` will then return `idle` after settled blocked/failed root outcomes because supervisor mode is idle.

### Read-model audit

As part of this root-settlement slice, check projections that derive runtime activity from supervisor mode. In particular, `actorPauseMode()` currently maps every non-paused/non-shutting-down mode to `running`; ensure idle supervisor mode does not appear as active/running in operator read models after root settlement.

## CardActor Cleanup

Remove dead pending-activation rejection state.

Current shape:

```ts
type PendingActivation = {
  caller: CardActivationCaller;
  resolve: (outcome: CardActivationOutcome) => void;
  reject: (error: Error) => void;
};
```

Target shape:

```ts
type PendingActivation = {
  caller: CardActivationCaller;
  resolve: (outcome: CardActivationOutcome) => void;
};
```

No new abstraction replaces `reject`. If activation setup fails, continue returning `Promise.reject(...)` before installing pending activation. If processing fails after activation starts, continue committing a failed outcome.

## Planner Recovery Tools

### Shared scope rules

Both `edit_card` and `cancel_card` are scoped to immediate children of the active planner card.

Rules:

- The target card must exist.
- The target card must have `parent === this.cardId`.
- The target card must not be the project card.
- The planner cannot edit or cancel unrelated descendants or siblings.
- The tool result must be compact and must not expose unrelated card state.

### `edit_card`

Purpose: refine or recover an immediate child so it can be activated again.

Allowed fields for this slice:

- `title`
- `description`
- `acceptance`
- `tags`
- `priority`
- `urgency`
- `related`

Do not include `depends_on` in planner `edit_card` for this slice. Existing lifecycle rules treat `depends_on` as a critical field outside `backlog`, and recovery edits should stay focused on executable instructions/acceptance. If dependency editing is needed later, design it explicitly as a dependency-management tool.

State rules:

- `backlog`: patch allowed fields; leave status `backlog` unless the patch explicitly needs recovery semantics.
- `changed`: patch allowed fields; keep status `changed`.
- `blocked`: patch allowed fields and transition to `changed`.
- `failed`: transition to `changed`, then patch allowed fields through a narrow runtime-owned command that validates the final patch against `changed` rules.
- `running`: reject. Running card edits need deferred patch delivery, which is out of scope.
- `done`: reject. Completed evidence invalidation needs an explicit later workflow.
- `cancelled`: reject. Cancelled child replacement should be a new child card.
- `needs_verification`: reject in this slice.

Implementation options, in preferred order:

1. Add a narrow store command for planner child recovery edits, e.g. `plannerEditChild(cardId, patch)`, that performs reopen-to-`changed` and allowed field patching under one store-owned mutation path.
2. If the existing store cannot support one atomic command cleanly, pre-validate the patch fields, call `setStatus(cardId, 'changed')` for `failed`/`blocked`, then call `mutateCard(...)` for allowed non-critical fields. This is acceptable only if tests cover failure behavior and no critical fields are allowed.

The first option is cleaner and should be attempted first.

Return shape:

```json
{
  "success": true,
  "card": {
    "id": "card-7",
    "status": "changed",
    "type": "code",
    "title": "..."
  }
}
```

### `cancel_card`

Purpose: remove obsolete, duplicate, or mis-scoped immediate children from further execution.

State rules:

- `backlog`, `changed`, `blocked`, `failed`: call the child `CardActor.cancel(...)`; expect immediate durable cancellation for parked states.
- `running`: call the child `CardActor.cancel(...)`; expect authoritative activation cancellation. The card store is marked `cancelled` immediately, the pending activation resolves as cancelled, activation-owned process scope is stopped, and late outcomes are rejected by activation id.
- `done`: reject. Completed work invalidation is out of scope.
- `cancelled`: reject as already cancelled.
- `needs_verification`: reject in this slice. `CardActor` does not currently recover `needs_verification` cards into an actor state.

Do not include a store-only fallback. The child actor registry path can construct the `CardActor` from store for existing children.

Return shape:

```json
{
  "success": true,
  "card_id": "card-9",
  "status": "cancelled",
  "summary": "Cancellation requested."
}
```

For a running child, return the new durable `cancelled` status and a summary that cancellation was applied through the child actor's activation.

### Tool definitions and prompt

Update curated actor planner definitions, not the broad role catalog blindly:

- `create_card`: schema must allow only planner-created child semantics. Its optional `status` must be `backlog` only, or removed.
- `edit_card`: schema must contain only fields supported by the actor handler above. Do not expose `status` or `depends_on`.
- `cancel_card`: schema should require target id and may accept an optional reason.

Update the planner prompt only after handlers exist. It should mention exactly available tools:

- `create_card` for new immediate children.
- `edit_card` for correcting or refining non-running immediate children.
- `cancel_card` for obsolete immediate children.
- `activate_card` for running immediate children.
- `emit_result` for terminal planner outcomes.

## Create Card Cleanup

While touching planner recovery tools, clean up known create-card drift:

- Remove or avoid the misleading planner-created `depth: 0` assignment. The card store computes depth from parent state.
- Tighten the planner `create_card` schema so it does not advertise arbitrary statuses that the handler rejects.
- Keep project-card creation rejected by both schema/description and handler.
- Keep dependency validation through the card store; it already detects dependency cycles on create and patch paths.

## Implementation Plan

### Commit 1: Root settlement projection

Files:

- `src/runtime/actors/runtime-supervisor.ts`
- `src/runtime/actors/supervisor-runtime-api.ts`
- `tests/runtime/actors/supervisor-runtime-api.test.ts`

Steps:

1. Add supervisor `settle` transition and `settleProject()` method.
2. Extract root run finalization in `SupervisorRuntimeApi`.
3. Use `runtime_status='stopped'` for blocked/failed root outcomes.
4. Clear `currentCardId` for every root outcome.
5. Move supervisor out of `running` for every root outcome.
6. Ensure operator read models do not project idle supervisor as running active work.
7. Add tests for root `done`, `failed`, `blocked`, and `cancelled` outcomes.

Validation:

```bash
NODE_OPTIONS=--experimental-vm-modules npx jest tests/runtime/actors/supervisor-runtime-api.test.ts --runInBand --forceExit
npx tsc --noEmit
```

### Commit 2: CardActor pending activation cleanup

Files:

- `src/runtime/actors/card-actor.ts`
- `tests/runtime/actors/card-actor.test.ts` if existing tests need adjustment or a focused cleanup test is useful.

Steps:

1. Remove `reject` from `PendingActivation`.
2. Keep activation precondition failures as immediate `Promise.reject(...)` returns.
3. Keep processor failures converted to failed outcomes.
4. Keep cancellation resolving with `{ status: 'cancelled' }`.

Validation:

```bash
NODE_OPTIONS=--experimental-vm-modules npx jest tests/runtime/actors/card-actor.test.ts --runInBand --forceExit
npx tsc --noEmit
```

### Commit 3: Planner `edit_card`

Files:

- `src/runtime/actors/planning-card-processor-actor.ts`
- `src/runtime/actors/actor-tool-definitions.ts`
- card store/lifecycle files if a narrow planner recovery edit command is added.
- `tests/runtime/actors/planning-card-processor-actor.test.ts`

Steps:

1. Add actor-specific `edit_card` definition with only supported fields.
2. Add the narrow store mutation path if needed for clean reopen-and-patch semantics.
3. Validate immediate-child scope.
4. Reject running, done, cancelled, and needs-verification targets.
5. Reopen failed/blocked targets to `changed` while applying allowed patch fields.
6. Keep backlog targets backlog unless a transition is required by implementation.
7. Add tests for failed child -> edit to `changed` -> activate again.
8. Add tests for running/done/non-immediate rejection.

Validation:

```bash
NODE_OPTIONS=--experimental-vm-modules npx jest tests/runtime/actors/planning-card-processor-actor.test.ts --runInBand --forceExit
npx tsc --noEmit
```

### Commit 4: Planner `cancel_card` and create-card cleanup

Files:

- `src/runtime/actors/planning-card-processor-actor.ts`
- `src/runtime/actors/actor-tool-definitions.ts`
- `tests/runtime/actors/planning-card-processor-actor.test.ts`

Steps:

1. Add actor-specific `cancel_card` definition.
2. Validate immediate-child scope.
3. Reject done and already-cancelled targets.
4. Use child `CardActor.cancel(...)`; do not add a store fallback.
5. Return immediate `cancelled` status for parked and running children; running children are cancelled through their `CardActor` activation.
6. Tighten planner `create_card` schema to backlog-only status or no status.
7. Remove misleading `depth: 0` from planner-created card input if the store input type allows it; otherwise document why the value remains required and consider changing the type.
8. Update planner prompt to include exactly the implemented planner tools.
9. Add tests for immediate child cancellation, running child activation cancellation, done/cancelled rejection, and non-immediate rejection.

Validation:

```bash
NODE_OPTIONS=--experimental-vm-modules npx jest tests/runtime/actors/planning-card-processor-actor.test.ts --runInBand --forceExit
npx tsc --noEmit
```

### Commit 5: Broad actor-runtime validation

Run:

```bash
npx tsc --noEmit
NODE_OPTIONS=--experimental-vm-modules npx jest tests/runtime/actors --runInBand --forceExit
npm run build
npm run validate:docs
```

If this slice is deployed to the GetRich v2 container, build on the host, restart `saivage-v3-getrich.service`, and probe `/health`. Do not print provider or auth configuration values.

## Test Matrix

| Behavior | Test location | Expected assertion |
|---|---|---|
| Root blocked stops runtime projection | `supervisor-runtime-api.test.ts` | status is not `running`; `currentCardId` is `null`; run phase/outcome is blocked |
| Root failed stops runtime projection | `supervisor-runtime-api.test.ts` | status is not `running`; `currentCardId` is `null`; run phase/outcome is failed |
| Root done settles neutrally | `supervisor-runtime-api.test.ts` | supervisor uses neutral settlement, not cancellation semantics |
| Root cancelled projects cancellation | `supervisor-runtime-api.test.ts` | run status is cancelled and current card is cleared |
| Idle supervisor read model is not active running | relevant read-model test | idle mode does not project active work |
| CardActor pending activation has no reject slot | `card-actor.test.ts` or typecheck | no unused reject path remains |
| Planner edits failed child | `planning-card-processor-actor.test.ts` | child status becomes `changed`; later `activate_card` can run it |
| Planner rejects running edit | `planning-card-processor-actor.test.ts` | tool result is unsuccessful and card fields are unchanged |
| Planner rejects done edit | `planning-card-processor-actor.test.ts` | tool result is unsuccessful |
| Planner rejects non-immediate edit | `planning-card-processor-actor.test.ts` | tool result is unsuccessful with scope error |
| Planner cancels parked child | `planning-card-processor-actor.test.ts` | child becomes cancelled |
| Planner requests running child cancellation | `planning-card-processor-actor.test.ts` | child remains running initially and has cancellation notification |
| Planner rejects done/cancelled cancellation | `planning-card-processor-actor.test.ts` | tool result is unsuccessful |
| Planner create schema matches handler | `planning-card-processor-actor.test.ts` or schema test | no advertised non-backlog create status |

## Rollout Notes

- Fix root settlement first because it addresses the live misleading runtime projection.
- Keep `CardActor` cleanup separate from behavior changes.
- Add planner recovery tools after lifecycle mutation rules are respected by design and tests.
- Do not add future-facing abstractions unless a concrete implementation path uses them immediately.
- After planner recovery tools land, reset/restart a live GetRich v2 run only if needed for validation, preserving `docs/SPEC.md`, `docs/PLAN.md`, `.saivage/saivage.yaml`, and `.saivage/auth-profiles.json`.

## Open Questions

- Should planner `edit_card` preserve `backlog` status for backlog children or always move edited children to `changed` for uniform activation semantics? The implementation should choose one and test it.
- Should `cancel_card` require a planner-provided reason, or should the runtime generate a standard reason with an optional planner detail?
- Should dependency editing be introduced later as a dedicated tool rather than overloading recovery-oriented `edit_card`?
