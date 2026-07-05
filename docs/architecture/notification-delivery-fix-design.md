# Notification Delivery Fix Design

Status: provenance. The notification-delivery mechanics (`CardActor.enqueueNotification` → `deliverNotificationsForInput` → LLM context) have landed. The done-to-changed flip described here is superseded: `changed` is now exclusively an edit/subtree-mutation signal, not a notification-delivery side effect. See [Micro-Actor Runtime Design — Notifications](./micro-actor-runtime-design.md#notifications) and [Implementation Plan P3](./micro-actor-runtime-implementation-plan.md#p3-cardactor-owns-authoritative-cancellation-and-activation-id-settlement) for the current target.

## Problem

Spec §12 and §9 promise two behaviors that don't work:

1. **`queue_notification`** queues a notification onto a card for delivery to that card's main agent. Currently it writes to a session-keyed `NotificationCenter` in-memory map that no agent ever drains. Only Telegram (operator) delivery works.

2. **Analyst card edits** must notify affected running planners. `propagateChange` flips resting cards to `changed` (works), but notification delivery to running ancestors routes through `ActiveGoalNoteSinks` (never registered) and `synthetic-planner-notes` (written to disk, never drained). Dead on both branches.

The working delivery mechanism already exists for ordinary card-addressed context: `CardActor.enqueueNotification()` → `deliverNotificationsForInput()` → LLM context. The problem is that nothing connects the queuing tools to it. Cancellation is no longer a notification-delivery use case; running cancellation is authoritative through the `CardActor` activation attempt.

## Solution

Add `notifyCard(cardId, notification)` to `RuntimeApi`. Both `queue_notification` and `propagateChange` call it. The runtime owns the `CardActor` registry, so it can reach live actors directly. For inactive cards, the notification is persisted to the actor snapshot.

### 1. `RuntimeApi.notifyCard(cardId, notification)`

```typescript
// RuntimeApi interface — add:
notifyCard(cardId: string, notification: CardNotification): void;
```

`SupervisorRuntimeApi` implementation:

```typescript
notifyCard(cardId: string, notification: CardNotification): void {
  const actor = this.cardActors.get(cardId);
  if (actor) {
    actor.enqueueNotification(notification);
    return;
  }
  // Inactive card: persist directly to snapshot (no processor allocation).
  appendNotificationToActorSnapshot(this.options.projectRoot, cardActorId(cardId), notification);
  // done cards are not activatable — flip to changed so the notification can be delivered.
  const card = this.options.actorStore.read(cardId);
  if (card?.status === 'done') this.options.actorStore.setStatus(cardId, 'changed');
}
```

No new interface, no port abstraction. `RuntimeApi` is the runtime contract; tools already have runtime access.

Forwarding in `createComposedRuntimeApi` (`src/application/runtime-composition.ts:146-161`): add one line `notifyCard: (cardId, n) => input.runtimeApi.notifyCard(cardId, n)`.

### 2. Fix `CardActor.fromCard()` — restore notification state from snapshot

Currently `fromCard()` only recovers the state machine state (`src/runtime/actors/card-actor.ts:114-118`). It does NOT restore `notifications`, `notificationDeliveryMarkers`, `lastChange`, or `cancelReason` — even though `snapshot()` persists them (`src/runtime/actors/card-actor.ts:234-251`). This means pending notifications are lost across runtime restart, including existing cancellation notifications.

Fix: read the actor snapshot in `fromCard()` and repopulate context fields before `recover()`:

```typescript
static fromCard(args): CardActor {
  const actor = new CardActor({ ...args });
  const snapshot = readActorSnapshot(args.projectRoot, cardActorId(args.card.id));
  if (snapshot?.context) {
    actor.notifications = snapshot.context.notifications ?? [];
    actor.notificationDeliveryMarkers = snapshot.context.notificationDeliveryMarkers ?? [];
    actor.lastChange = snapshot.context.lastChange ?? null;
    actor.cancelReason = snapshot.context.cancelReason ?? null;
  }
  actor.recover(cardActorState(args.card.status));
  return actor;
}
```

Add `readActorSnapshot(projectRoot, actorId)` to `snapshots.ts` (singular version of existing `readActorSnapshots`).

### 3. Snapshot helper for inactive cards

Add `appendNotificationToActorSnapshot(projectRoot, actorId, notification)` to `snapshots.ts`. Reads the existing snapshot (or creates a minimal one), appends the notification to `context.notifications`, writes back.

This avoids materializing a `CardActor` for inactive cards, which would allocate and start a processor — the hazard that motivated not using `children.get(cardId)` for notifications.

### 4. Rewire `queueNotification()`

In `notification-triggers.ts`, replace session-keyed `NotificationCenter` routing with card-addressed delivery:

- Card recipient: use `cardId` directly.
- Session recipient: parse the session ID to extract the card ID (`planner:<goalId>` → goalId, `executor:<cardId>` → cardId, `reviewer:<goalId>:<assessmentId>` → goalId, `analyst:<sessionId>` → no card target).
- Role recipient: find active sessions of that role, extract card IDs.

For each resolved card ID, call `runtime.notifyCard(cardId, notification)`.

External adapter delivery (Telegram) continues unchanged via `NotificationDeliveryService`.

Signature change: `queueNotification()` gains a `notifyCard?: (cardId: string, notification: CardNotification) => void` parameter. Callers pass `ctx.runtime?.notifyCard` (Analyst) or the planner admission's `notifyCard` (planner).

### 5. Rewire `propagateChange()`

In `changed-propagation.ts`:

- **Keep** the flip loop. `FLIPPABLE_RESTING` already includes `done`, so resting ancestors (including done) become `changed`.
- **Replace** the dead note-routing (`queuePlannerNote` / `ActiveGoalNoteSinks` / `queueSyntheticPlannerNote`) with `notifyCard(stoppedRunningAncestorId, changeNotification)` for the first running ancestor.
- **Add** `notifyCard(editedCardId, changeNotification)` for the edited card itself (§9 gap: the modified card must get a notification regardless of status).

Signature change: `propagateChange()` gains a `notifyCard?` parameter. Return type drops `notified_planner_session_ids` and `stopped_at_running` (both dead after this change). `flipped` stays as the changed-card summary returned by the propagation helper.

## Threading

Both tools already have runtime access:

- **Analyst:** `ToolContext.runtime?: Pick<RuntimeApi, ...>`. Add `'notifyCard'` to the Pick. `analyst-misc-tools.ts` passes `ctx.runtime?.notifyCard` to `queueNotification`. `analyst-card-tools.ts` passes it to `propagateChange`.
- **Planner:** `PlanningCardProcessorActor` gets `admission: this` (SupervisorRuntimeApi). Add `notifyCard` to `PlannerControlProviderContext` and pass `admission.notifyCard.bind(admission)` from the processor.

Add forwarding to `createComposedRuntimeApi` (`src/application/runtime-composition.ts:146-161`).

## What Gets Deleted (After Fix Is Proven)

- `src/runtime/actors/active-goal-note-sinks.ts` — entire file.
- `src/runtime/synthetic-planner-notes.ts` — entire file.
- `queuePlannerNote()` and note-routing branches in `changed-propagation.ts`.
- `notified_planner_session_ids` and `stopped_at_running` from `ChangedPropagation`.
- Unused `queueNotification` import in `analyst-card-tools.ts`.

## What Stays

- `CardActor.enqueueNotification()`, `deliverNotificationsForInput()`, `hasPendingNotifications()`, `reopenDoneWithPendingNotifications()` — the working delivery mechanism.
- `NotificationCenter` as external adapter host (Telegram). Its `drainPendingForSession` was never called in production and can be removed.
- `NotificationDeliveryService` for external adapter fan-out.
- `CardActor.notify()` and `markChanged()` as internal methods (not part of any external interface).

## Test Plan

1. `queue_notification` to a running card → next LLM input includes the notification.
2. `queue_notification` to an inactive card → notification persists → delivered on next activation.
3. Analyst edits a brief → running ancestor planner receives change notification.
4. Analyst edits a brief → resting ancestor flipped to `changed`.
5. Running cancellation remains independent of notification delivery and still works through the `CardActor` activation attempt (regression).
6. Done card with pending notifications reopens as `changed` (regression).
7. Telegram delivery still works (regression).
8. Notifications survive runtime restart (new — `fromCard()` restore).
9. Old note-sink code is absent from source after deletion.

## Required Reviewer Isolation

Reviewer turns must not drain the planner/main-agent notification queue. Within one activation, planner and reviewer share the owning `CardActor`, but notifications are addressed to the card's main agent (planner for project/goal cards, executor for terminal cards), not to reviewer sessions. Change notifications enqueued during review stay pending for planner delivery and are represented to the reviewer flow through currentness invalidation instead of by appending notification context to reviewer tool continuations. See [Micro-Actor Runtime Implementation Plan P5](./micro-actor-runtime-implementation-plan.md#p5-reviewer-cannot-reach-main-agent-notification-delivery).

## Spec Cross-Reference

- **§12:** "queued onto a card... delivered to that card's main agent session" → `runtime.notifyCard()` → `CardActor.enqueueNotification()` → `deliverNotificationsForInput()`.
- **§12:** "next future main agent session" → snapshot-persisted notifications restored via `fromCard()`.
- **§12:** "done card with pending notifications becomes changed" → `reopenDoneWithPendingNotifications()` (entering done) + `notifyCard` done→changed flip (already-done inactive cards).
- **§9:** "notification to the modified card" → `notifyCard(editedCardId, ...)`.
- **§9:** "running ancestors receive notification/context" → `notifyCard(runningAncestorId, ...)` in `propagateChange`.
