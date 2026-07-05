# Card Actor State Collapse Design

Status: proposed.

Date: 2026-07-05

F14 identified that `CardActor` mirrors card store status into actor state. The mirror is maintained by hand: a mapping function, a mirroring `writeStatus`, defensive double-checks (`card.status === X || this.state() === X`), and fail-fast guards for unmappable statuses. Every status change must be threaded through both authorities, and the invariant ("actor state == store status") is asserted nowhere.

The mirror exists only to use the micro-actor `on` map as a declarative activation-permission table. But `activate()` already checks `isActivatable(card.status)` imperatively before sending the event. The declarative map is redundant enforcement. Two authorities, same policy, same answer.

## Decision

Collapse `CardActor` states from seven status-mirroring states to three task-lifecycle states. The card store becomes the single status authority. The actor state machine owns only task lifecycle.

This eliminates the entire class of divergence bugs by removing the mirror, not by policing it.

## New State Machine

```
parked (initial, parked): on: { activate: 'running', cancel: 'cancelled' }
running:                  on: { settled: 'parked', cancel: 'cancelled' }
cancelled:                terminal
```

- `parked`: the card is not currently executing. Store status may be `backlog`, `changed`, `blocked`, `failed`, `done`, or `needs_verification`.
- `running`: a processor task is in flight.
- `cancelled`: terminal.

Events:

- `activate`: `parked → running`. Gated by `isActivatable(store.status)` (imperative check, already exists).
- `settled`: `running → parked`. Sent by `commitOutcome(...)` after the terminal store patch is written. Replaces the per-outcome `done`/`failed`/`blocked` events.
- `cancel`: `parked|running → cancelled`.

## What Gets Deleted

- `cardActorState(status)` mapping function and its `needs_verification` fail-fast guards.
- `CardActorStatus` type alias.
- `writeStatus(...)` mirroring logic — store writes become direct. The terminal-to-`changed` lifecycle patch stays but moves to a single `applyStoreStatus(status)` helper or inline at call sites.
- The `changed` actor event and all `on: { changed }` transitions. `markChanged()` writes store status `changed` and persists. The actor stays `parked`. The supervisor reads the store to discover activatable cards.
- All `card.status === X || this.state() === X` defensive double-checks in `cancel()` and `markChanged()`.
- The `needs_verification` recovery throw. A `needs_verification` card is simply `parked` and `isActivatable('needs_verification')` returns false.

## Method Changes

### `activate(caller)`

1. Validate caller ownership from the store record (unchanged).
2. Check `isActivatable(store.status)` — reject if not activatable.
3. Check `this.state() === 'parked'` — reject if already running.
4. Set up deferred, active reconstruction, send `activate`.

No store-status-to-actor-state mapping. No redundant declarative check.

### `cancel(reason)`

1. If `this.state() === 'cancelled'`, return (no-op).
2. If store status is `done`, return (no-op — done cards are not cancelled).
3. Write `cancelled` to store.
4. If running: abort activation, resolve deferred, send `cancel`.
5. If parked: send `cancel`.

One authority per check. No `card.status === 'done' || this.state() === 'done'`.

### `markChanged()`

1. If store status is `cancelled`, return.
2. Write `changed` to store (with terminal lifecycle patch if transitioning from a terminal status).
3. Persist.

No actor event. The actor is already `parked` (or `running`, in which case it persists and the store status will be observed at settlement).

### `commitOutcome(outcome)`

1. Write terminal store patch (done/failed/blocked).
2. Clear active reconstruction.
3. Resolve deferred.
4. Send `settled` (replaces `done`/`failed`/`blocked` events).

### `_on_enter__running()`

Unchanged: writes `running` to store, starts processor task via `runTask`.

### Recovery (`fromCard`)

```
if (card.status === 'running' && activeReconstruction) → recover('running')
else if (card.status === 'cancelled') → recover('cancelled')
else → recover('parked')
```

No `cardActorState(status)` mapping. No `needs_verification` throw.

## Public Read Model

Two consumers currently derive the operator-visible card state from `actor.state()`:

1. `SupervisorRuntimeApi.getActorRuntimeReadModel()` — `toPublicCardActorState(actor.state())`
2. `buildActorRuntimeReadModel(projectRoot)` — `toPublicCardActorState(snapshot.state_value)`

With collapse, `actor.state()` is `parked/running/cancelled` — useless to the operator. Both consumers must derive from the **store status** instead:

- **Live path** (`supervisor-runtime-api.ts`): read `store.read(actor.cardId).status` and convert to `PublicCardActorState`.
- **Snapshot path** (`actor-runtime-read-model.ts`): add `cardStatus` to the actor snapshot `context`. The actor already persists after every store status change. The read model reads `snapshot.context.cardStatus`.

`PublicCardActorState` and `publicCardActorStates` stay unchanged — they are store statuses, which is what the operator should see. `CardActorState` / `cardActorStates` / `parseCardActorState` in `actor-vocabulary.ts` become dead code and are deleted.

## Tests

Update `tests/runtime/actors/card-actor.test.ts`:

- Tests that assert `actor.state() === 'done'` / `'failed'` / `'blocked'` / `'changed'` / `'backlog'` change to assert `store.read(id).status` instead, or `actor.state() === 'parked'` where the point is "not running."
- The `needs_verification` fail-fast test is removed — `needs_verification` cards recover to `parked` and are simply not activatable.
- The `isActivatable` test stays unchanged.
- Activation, cancellation, notification delivery, and recovery behavior tests stay unchanged in intent.

## Implementation Sequence

1. Collapse `_actor` definition to `parked/running/cancelled` with `settled` event.
2. Rewrite `activate`, `cancel`, `markChanged`, `commitOutcome`, and recovery to use store as single authority.
3. Delete `cardActorState()`, `CardActorStatus`, `writeStatus()` mirroring, and dead vocabulary.
4. Add `cardStatus` to snapshot context; update both read model consumers.
5. Update tests.
6. Run focused `CardActor` tests, typecheck, full test suite, and routine validation.
