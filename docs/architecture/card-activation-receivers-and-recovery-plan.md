# Card Activation Receivers And Recovery Plan

Status: proposed.

## Problem

Card activation settlement is currently delivered through an anonymous promise resolver stored inside `CardActor`. That works mechanically, but it hides the parent role at the exact boundary where parent-specific behavior matters:

- a planner activates an immediate child through `activate_card` and needs an inline tool result for the ongoing planner LLM conversation.
- the runtime activates the root project card and needs a durable runtime/run projection when the project card settles.

The hidden parent boundary has already caused an observable projection bug: a root project card can settle `blocked` while the runtime still reports `running` with no active card run. The root outcome is terminal for the runtime activation and must be projected as such.

The planner also lacks the recovery tools needed after a child fails or becomes obsolete. It can create and activate child cards, but cannot edit a failed/blocked child into a reactivatable `changed` state or cancel a duplicate/mis-scoped immediate child.

## Goals

- Keep `BaseActor` unchanged. It is frozen and does not need additional support for this slice.
- Make the card activation parent boundary explicit in `CardActor` using a typed receiver slot.
- Preserve actor ownership: parent reactions should resolve parent-private promises as the normal path.
- Fix root project settlement so `done`, `failed`, `blocked`, and `cancelled` all move the supervisor out of active `running` projection.
- Add planner-owned recovery tools for immediate children: `edit_card` and `cancel_card`.
- Keep `activate_card` owned by `PlanningCardProcessorActor`, because it is the sequencing boundary for child execution.

## Non-Goals

- Do not modify `src/runtime/micro-actor/micro-actor.ts` or add features to `BaseActor`.
- Do not add a parallel orchestration layer above the actor runtime.
- Do not introduce a new `edited` card status. The existing `changed` status is the edited/reactivatable state.
- Do not add `restart_card`. Editing a non-done child to `changed`, then activating it again, is the restart path.
- Do not make `LLMActor` aware of planner queues, activation receivers, or card-tree semantics.
- Do not implement broad reviewer/executor tool expansion in this slice.

## Design Principles

### CardActor owns activation settlement

`CardActor` remains the single lifecycle commit boundary. It validates activation, enters `running`, invokes the processor, commits the terminal lifecycle patch, records the last outcome, clears active reconstruction, and only then notifies the activation receiver.

### Receivers resolve parent-private promises

The primary receiver behavior is to resolve or reject a parent-private promise. That keeps parent advancement in the parent-owned async flow:

- `PlanningCardProcessorActor.handleToolCall(...)` awaits child activation and returns the resulting tool result to the planner LLM loop.
- `SupervisorRuntimeApi.startProject(...)` awaits root activation and then finalizes the runtime run/projection.

Receivers should not synchronously mutate unrelated parent actor state as their normal behavior. Submitting tasks or entering actor work remains the role of actor entry methods such as `_on_enter__running()`. A receiver may be implemented as a small promise adapter, but the continuation logic should remain in the awaiting parent method.

### Root settlement is not cancellation

A root project card that naturally settles `blocked`, `failed`, or `cancelled` has already reached a terminal activation outcome. The runtime should project that outcome directly. Calling `cancelProject()` as the primary settlement mechanism for `blocked` or `failed` blurs causality.

The runtime may still clear active work and move the supervisor out of `running`, but the run outcome must remain the root outcome:

- `done` -> completed run, idle runtime projection.
- `failed` -> failed run, idle or error-like stopped projection.
- `blocked` -> blocked run, stopped/idle projection with blocked reason.
- `cancelled` -> cancelled run, cancelled/stopped projection.

## Proposed API Changes

### Card activation receiver

Add a receiver interface in `src/runtime/actors/card-actor.ts`:

```ts
export interface CardActivationReceiver {
  readonly caller: CardActivationCaller;
  onCardSettled(outcome: CardActivationOutcome): void;
  onCardActivationFailed?(error: Error): void;
}
```

Then replace the pending activation resolver slot with a receiver-aware slot:

```ts
type PendingActivation = {
  receiver: CardActivationReceiver;
};
```

`CardActor.activate(...)` should keep its current public shape and internally wrap the caller in a promise receiver:

```ts
activate(caller: CardActivationCaller): Promise<CardActivationOutcome>;
```

That public method remains the primary parent-facing contract: parent code awaits a promise, and settlement resolves that parent-private promise. The receiver is the typed slot inside `CardActor`, not a requirement that every caller manually build a receiver object.

If a future parent needs a named receiver for diagnostics, add an overload or separate method then. This slice does not need it.

Implementation shape:

- construct a `PromiseCardActivationReceiver` inside `activate(caller)`.
- store that receiver in `#pendingActivation`.
- validate `receiver.caller` through the existing caller validation path.
- return the promise owned by that receiver.

### Promise receiver helper

Add a small local receiver implementation near `CardActor` or in `card-activation-receiver.ts`:

```ts
export class PromiseCardActivationReceiver implements CardActivationReceiver {
  readonly promise: Promise<CardActivationOutcome>;
  #resolve!: (outcome: CardActivationOutcome) => void;
  #reject!: (error: Error) => void;

  constructor(
    readonly caller: CardActivationCaller,
  ) {
    this.promise = new Promise<CardActivationOutcome>((resolve, reject) => {
      this.#resolve = resolve;
      this.#reject = reject;
    });
  }

  onCardSettled(outcome: CardActivationOutcome): void {
    this.#resolve(outcome);
  }

  onCardActivationFailed(error: Error): void {
    this.#reject(error);
  }
}
```

This is deliberately boring. Its job is not orchestration; it is a typed adapter around the parent-private promise.

### CardActor settlement flow

`commitOutcome(...)` should remain ordered as:

1. compute stamp.
2. commit lifecycle patch to the store.
3. update `lastOutcome`.
4. clear `activeReconstruction`.
5. clear pending activation slot.
6. call `receiver.onCardSettled(outcome)`.
7. send the card state event for the outcome.
8. persist through existing state-change path.

The receiver should be copied to a local variable before clearing the slot so a callback cannot accidentally observe stale pending state.

Cancellation should use the same settlement path for pending activation:

- if a parked non-done card is cancelled, construct `{ status: 'cancelled', summary: reason.reason }` and notify the pending receiver if present.
- if a running card receives cancellation, it remains best-effort notification-only as today; the running processor/LLM sees the cancellation notification on the next input.

### Error path

The processor `on_failed` path currently converts processor exceptions into a failed card outcome. Keep that behavior. Receiver `onCardActivationFailed` is only for activation setup failures before the card reaches processor-owned settlement, or for future impossible-state failures where `CardActor` cannot produce a lifecycle outcome.

For this slice, most failures should still become `CardActivationOutcome` values rather than promise rejections.

## Runtime Root Settlement

### Current problem

`SupervisorRuntimeApi.startProject(...)` awaits root activation and writes a run record. For `blocked`, it leaves `currentCardId` set and leaves the supervisor in `running`; `getStatus()` then projects `running` despite there being no useful active root activation.

### Desired behavior

After root activation settles with any terminal activation status, the runtime root run should be finalized and the supervisor should no longer project active running work.

Recommended projection:

| Root outcome | Run phase | Run runtime_status | finished_at | Runtime status projection | currentCardId |
|---|---|---|---|---|---|
| `done` | `completed` | `idle` | timestamp | `idle` | `null` |
| `failed` | `failed` | `error` or `idle` | timestamp | `idle` or `error` | `null` |
| `blocked` | `blocked` | `blocked` or `idle` | `null` or timestamp | `idle` with blocked run detail, or `blocked` if schema is extended | `null` |
| `cancelled` | `cancelled` | `cancelled` | timestamp | `idle` or `cancelled` | `null` |

The implementation should prefer the smallest schema-safe change. If `RuntimeStatus` and `RuntimeRunRecord.runtime_status` do not currently allow `blocked`/`failed`, then use existing schema values for now and preserve precise outcome in `run.phase` and `run.outcome`. A later schema slice can add first-class blocked/failed runtime statuses if desired.

### Supervisor mode transition

Add an explicit supervisor method if one already fits the vocabulary, or use the smallest clear existing transition. The important behavior is:

- `running` root activation ends.
- `currentCardId = null` for every root outcome.
- active run is finalized before returning from `startProject(...)`.
- `getStatus()` no longer returns `running` for a settled root.

Do not use cancellation as the primary mechanism for `done`, `failed`, or `blocked`. If an existing method named `cancelProject()` is the only way to move the supervisor out of running, rename or replace it with a neutral settlement method such as `finishProject()` or `settleProject()`.

### Root receiver role

The root receiver should be a promise adapter, not the owner of runtime finalization:

```ts
const outcome = await actor.activate({ kind: 'root' });
finalizeRootRun(outcome);
```

If a named root receiver is useful later for diagnostics, it should still only resolve the `startProject(...)` private promise. The `startProject(...)` method should remain the place where run records and supervisor projection are finalized.

## Planner Recovery Tools

### Tool surface

Extend the curated planner actor surface to include:

- `edit_card`
- `cancel_card`

Keep `activate_card` in `PlanningCardProcessorActor.handleToolCall(...)`, not in the general actor tool surface, because activation is sequencing work.

### Edit card semantics

`edit_card` is planner-owned and scoped to immediate children of the active planner card.

Rules:

- The target card must exist.
- The target card must have `parent === this.cardId`.
- The target card must not be the project card and must not be an unrelated descendant.
- The target card must not be `done` unless a later explicit design permits invalidating completed work. For this slice, fail fast on done children.
- Allowed patch fields: `title`, `description`, `acceptance`, `tags`, `priority`, `urgency`, `depends_on`, `related`.
- `depends_on` may reference only immediate children of the same parent.
- Editing a child in `backlog`, `changed`, `failed`, or `blocked` transitions it to `changed`.
- Editing a running child should not patch the record immediately; it should call `childActor.markChanged(...)` so the running child receives a notification and can settle/reopen through existing notification semantics.

Implementation note: prefer using existing lifecycle/card-store mutation functions if they already centralize edit semantics. If no store port exists for patching cards, add the narrow method needed by `CardActorStorePort` rather than reaching around the store.

Suggested port addition:

```ts
update?(cardId: string, patch: PlannerEditableCardPatch): CardRecord;
```

If the canonical card store already exposes a differently named update method, use that and reflect it in the port.

Return a compact result:

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

### Cancel card semantics

`cancel_card` is planner-owned and scoped to immediate children of the active planner card.

Rules:

- The target card must exist.
- The target card must have `parent === this.cardId`.
- The target card must not be `done`; cancelling completed evidence should be a later explicit design.
- For parked cards, call `childActor.cancel(...)` when an actor is available, otherwise update the store through lifecycle cancellation rules.
- For running cards, call `childActor.cancel(...)`; cancellation is best-effort notification-only and the tool result should say cancellation was requested, not that execution stopped synchronously.
- Cancelling a card cancels non-done descendants through existing `CardActor.cancelDescendants()` behavior.

Return a compact result:

```json
{
  "success": true,
  "card_id": "card-9",
  "status": "cancelled",
  "summary": "Cancellation requested."
}
```

For a running child, use `status: "running"` and `summary: "Cancellation requested."` if the durable record has not settled yet.

### Planner prompt

Update the planner prompt only after the tools are implemented. It should mention exactly the available tools:

- `create_card` for new immediate children.
- `edit_card` for correcting or refining immediate children.
- `cancel_card` for obsolete immediate children.
- `activate_card` for running immediate children.
- terminal `emit_planner_result` for `done`, `blocked`, or `continue`.

Do not mention unavailable tools. Keep the prompt generic and project-agnostic.

## Implementation Plan

### Commit 1: Typed activation receiver, behavior-preserving

Files:

- `src/runtime/actors/card-actor.ts`
- focused tests in `tests/runtime/actors/card-actor.test.ts`

Steps:

1. Add `CardActivationReceiver` and `PromiseCardActivationReceiver`.
2. Reimplement `activate(caller)` by constructing a promise receiver.
3. Change `#pendingActivation` to store the receiver instead of a raw `resolve` function.
4. Route terminal and parked-cancel settlement through `receiver.onCardSettled(...)`.
5. Keep processor failures converted to failed card outcomes.
6. Add tests that verify receiver is called after lifecycle commit and pending activation is cleared.

Validation:

```bash
NODE_OPTIONS=--experimental-vm-modules npx jest tests/runtime/actors/card-actor.test.ts --runInBand --forceExit
npx tsc --noEmit
```

### Commit 2: Root project settlement/projection fix

Files:

- `src/runtime/actors/supervisor-runtime-api.ts`
- `src/runtime/actors/runtime-supervisor.ts` if a neutral settlement method is needed.
- `src/runtime/runtime-api.ts` and schema files only if an explicit status enum extension is chosen.
- `tests/runtime/actors/supervisor-runtime-api.test.ts`

Steps:

1. Keep root activation on `await actor.activate({ kind: 'root' })`; the receiver remains internal to `CardActor`.
2. Extract root run finalization into a small private method such as `finalizeRootRun(outcome, finishedAt)`.
3. Clear `currentCardId` for every root outcome.
4. Move supervisor mode out of `running` for every root outcome using a neutral method.
5. Preserve precise root outcome in `activeRun.phase` and `activeRun.outcome`.
6. Make `getStatus()` project non-running after blocked/failed root settlement.
7. Add tests for root `blocked`, `failed`, `cancelled`, and `done` projection.

Validation:

```bash
NODE_OPTIONS=--experimental-vm-modules npx jest tests/runtime/actors/supervisor-runtime-api.test.ts --runInBand --forceExit
npx tsc --noEmit
```

### Commit 3: Planner `edit_card`

Files:

- `src/runtime/actors/planning-card-processor-actor.ts`
- `src/runtime/actors/actor-tool-definitions.ts`
- card store/lifecycle files as needed for a narrow update port.
- `tests/runtime/actors/planning-card-processor-actor.test.ts`

Steps:

1. Add or reuse the planner `edit_card` tool definition with a schema matching actor semantics.
2. Add the narrow mutable store port needed to update allowed fields.
3. Validate immediate-child scope.
4. Validate `depends_on` only points to immediate children.
5. Reject done-card edits in this slice.
6. For parked children, update allowed fields and mark status/lifecycle `changed`.
7. For running children, call `markChanged(...)` and return a notification-requested result.
8. Add planner prompt text for `edit_card`.
9. Add tests for failed child -> edit to `changed` -> activate again.

Validation:

```bash
NODE_OPTIONS=--experimental-vm-modules npx jest tests/runtime/actors/planning-card-processor-actor.test.ts --runInBand --forceExit
npx tsc --noEmit
```

### Commit 4: Planner `cancel_card`

Files:

- `src/runtime/actors/planning-card-processor-actor.ts`
- `src/runtime/actors/actor-tool-definitions.ts`
- card store/lifecycle files as needed for a narrow cancellation port.
- `tests/runtime/actors/planning-card-processor-actor.test.ts`

Steps:

1. Add or reuse the planner `cancel_card` tool definition with a schema matching actor semantics.
2. Validate immediate-child scope.
3. Reject done-card cancellation in this slice.
4. Use child actor cancellation when the actor exists.
5. Use lifecycle/store cancellation for parked children if actor reconstruction is not available.
6. Return whether cancellation completed immediately or was requested for a running child.
7. Add planner prompt text for `cancel_card`.
8. Add tests for immediate child cancellation and non-immediate child rejection.

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
| Receiver called after lifecycle commit | `card-actor.test.ts` | store shows terminal patch before receiver observes outcome |
| Pending activation cleared before callback | `card-actor.test.ts` | a callback cannot observe stale pending activation through a second activation attempt |
| Parked cancellation settles receiver | `card-actor.test.ts` | pending activation receives `cancelled` if cancellation wins before running |
| Root blocked stops runtime projection | `supervisor-runtime-api.test.ts` | status is not `running`; `currentCardId` is `null`; run outcome is blocked |
| Root failed stops runtime projection | `supervisor-runtime-api.test.ts` | status is not `running`; `currentCardId` is `null`; run outcome is failed |
| Root cancelled stops runtime projection | `supervisor-runtime-api.test.ts` | status is not `running`; `currentCardId` is `null`; run outcome is cancelled |
| Planner edits failed child | `planning-card-processor-actor.test.ts` | child status becomes `changed`; later `activate_card` can run it |
| Planner rejects non-immediate edit | `planning-card-processor-actor.test.ts` | tool result is unsuccessful with scope error |
| Planner cancels immediate child | `planning-card-processor-actor.test.ts` | child becomes cancelled or receives cancellation request |
| Planner rejects done child cancellation | `planning-card-processor-actor.test.ts` | tool result is unsuccessful |

## Rollout Notes

- Keep the receiver refactor behavior-preserving before changing runtime projection.
- Fix root settlement before planner recovery tools so live runs do not remain misleadingly active after blocked project outcomes.
- Keep each commit independently typechecked and covered by focused tests.
- After planner recovery tools land, reset/restart a live GetRich v2 run only if needed for validation, preserving `docs/SPEC.md`, `docs/PLAN.md`, `.saivage/saivage.json`, and `.saivage/auth-profiles.json`.

## Open Questions

- Should runtime status schemas gain first-class `blocked` and `failed` values, or should this slice keep schema changes minimal and expose exact root outcome only through the run record?
- Should editing a `done` child be allowed later as an explicit invalidation workflow? This plan rejects it for now.
- Should `cancel_card` require a free-form reason from the planner, or should the runtime generate a standard reason and keep the planner's optional reason as detail?
