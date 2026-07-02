# Notification Delivery Fix Design

Status: current design document for fixing broken agent-facing notification delivery.

Last reviewed: 2026-07-02. Revised after deep code review.

## Problem

The system spec (§12 Notifications, §9 Changed Cards) promises two critical behaviors:

1. **`queue_notification`** queues a notification onto a card. The card runtime delivers it to that card's main agent session.
2. **Analyst card edits** queue a change notification so affected running planners become aware of the change.

Neither works today. Three disconnected notification subsystems exist in the codebase, and no path connects the queuing tools to the working delivery mechanism.

## Current State

### Subsystem A — `queue_notification` → `NotificationCenter` (BROKEN for agents)

```
queue_notification tool
  → queueNotification()                          [src/notifications/notification-triggers.ts:95]
  → resolveSessionIds()                           resolves to SESSION ids
  → createNotificationDeliveryService().enqueue() [notification-delivery.ts:46]
     → NotificationCenter.enqueue(sessionId, ...)  in-memory Map<sessionId, entries>
     → adapters.deliver(...)                       only Telegram adapter registered
```

`NotificationCenter.drainPendingForSession()` is never called in production. The in-memory queue is written and lost on restart. Only Telegram (human operator) delivery works.

Files: `src/notifications/notification-triggers.ts`, `src/notifications/notification-delivery.ts`, `src/notifications/notification-center.ts`.

### Subsystem B — analyst edits → `propagateChange` → note sinks (BROKEN for agents)

```
analyst edit (create/delete/cancel/reorder/brief)
  → propagateChange()                              [changed-propagation.ts:35]
     → status flip to 'changed' for resting cards  (WORKS)
     → stop at first running ancestor              (stops, does NOT notify)
     → queuePlannerNote()                          [changed-propagation.ts:98]
        → ActiveGoalNoteSinks.addNote()            (never registered → returns false)
        → queueSyntheticPlannerNote()              (writes to disk, never drained)
```

The status-flip part works. The notification delivery is broken on both branches. `ActiveGoalNoteSinks` is never registered. Synthetic notes accumulate in `.saivage/runtime/synthetic-notes.json` and are never consumed.

Files: `src/runtime/changed-propagation.ts`, `src/runtime/actors/active-goal-note-sinks.ts`, `src/runtime/synthetic-planner-notes.ts`.

### Subsystem C — `CardActor` delivery → LLM context (WORKS, but underused)

```
CardActor.enqueueNotification(notification)
  → this.notifications.push(notification)
  → this.persist()                                [saves to actor snapshot]
  ↓
BaseMainLLMCardProcessorActor.notificationContextMessages(input, inputId)
  → input.notificationDelivery.deliverNotificationsForInput(inputId)
     (notificationDelivery === the CardActor itself)
  → drains this.notifications, records delivery markers
  → returns notifications as { role: 'user', content: notification.message }
```

This is the endorsed design from the micro-actor runtime plan. It works correctly for the one path that feeds it: cancellation-while-running (`CardActor.cancel()` → `enqueueNotification`).

But `CardActor.notify()` and `CardActor.markChanged()` — the intended public entry points for external callers — have zero production callers. Nothing connects Subsystem A or B to Subsystem C.

Files: `src/runtime/actors/card-actor.ts`, `src/runtime/actors/base-main-llm-card-processor-actor.ts`.

### The `SupervisorRuntimeApi.cardActors` registry

`SupervisorRuntimeApi` maintains `private readonly cardActors = new Map<string, CardActor>()` and a private `cardActor(cardId)` method that lazily creates CardActors for any card. However, directly exposing this method is unsafe (see Hazards below). The port design below avoids that.

File: `src/runtime/actors/supervisor-runtime-api.ts:44,277-285`.

## Design Goals

1. `queue_notification` must deliver notifications to the target card's main agent via the CardActor.
2. Analyst card edits must notify affected running planners.
3. Notifications for inactive cards must persist durably until the card is next activated.
4. The working cancellation-while-running path must not break.
5. Telegram/operator notification delivery must continue to work.
6. Old remnant plumbing is deleted only after the new path is proven.

## Design

### Key Insight: One Primitive, Not Two

Both `queue_notification` and `propagateChange` need the same primitive: **notify a card**. `CardActor.markChanged()` is redundant for external callers because:

- On a **running** card, `markChanged()` just calls `enqueueNotification(changeNotification(...))` — identical to `notify()`.
- On a **resting** card, `markChanged()` flips to `changed` — but `propagateChange` already does `store.setStatus('changed')` directly.

Therefore both subsystems reduce to a single port method: `notify(cardId, notification)`.

### 1. Card Notification Port (Single Method)

```typescript
export interface CardNotificationPort {
  /**
   * Queue a notification for delivery to a card's main agent.
   * If the card has a live CardActor, the notification is enqueued immediately
   * and will be delivered on the next LLM input.
   * If the card has no live actor, the notification is persisted to the
   * actor snapshot and will be restored when the card is next activated.
   */
  notify(cardId: string, notification: CardNotification): void;
}
```

No `getCardActor()`, no `hasLiveActor()`, no `markChanged()`. The port does not expose the `CardActor` type at all. This prevents callers from calling `.activate()`/`.cancel()`/mutating internals, and lets the implementation hide the live-actor-vs-snapshot decision.

### 2. Implementation In `SupervisorRuntimeApi`

```typescript
notify(cardId: string, notification: CardNotification): void {
  const liveActor = this.cardActors.get(cardId);
  if (liveActor) {
    liveActor.enqueueNotification(notification);
    return;
  }
  // No live actor: persist directly to the card's actor snapshot.
  // Do NOT materialize a CardActor — that would allocate a processor,
  // pollute the registry, and risk throws for running-in-store cards.
  appendNotificationToSnapshot(this.options.projectRoot, cardActorId(cardId), notification);
}
```

`appendNotificationToSnapshot` is a new helper in `snapshots.ts` that reads the card-actor snapshot (if it exists), appends the notification to `context.notifications`, and writes it back. If no snapshot exists, it creates a minimal one with the notification. This avoids all lazy-materialization hazards.

**Hazards avoided by not materializing CardActors for notifications:**

1. **No registry pollution.** Inactive-card notifications do not add entries to `cardActors`, so the operator UI and `shutdownOwnedProcesses` are unaffected.
2. **No processor allocation.** No `processorFor()` call, no `processor.start()`.
3. **No throw for running-in-store cards.** A card the store thinks is `running` but has no live actor gets a snapshot-persisted notification, not a `fromCard('running')` recovery that throws.
4. **No duplicate-actor notification loss.** A notification written to the snapshot of the real actor (not a stale duplicate) will be restored when the real CardActor is materialized.

### 3. Snapshot Restore In `CardActor.fromCard()`

Currently `CardActor.fromCard()` recovers only the state-machine state. It does NOT restore `notifications`, `notificationDeliveryMarkers`, `lastChange`, or `cancelReason` from the persisted snapshot. This means:

- **Even the existing cancellation-while-running path loses pending notifications across a runtime restart.**
- Any notification persisted by the port's snapshot-write path would be lost when the CardActor is later materialized.

Fix: modify `CardActor.fromCard()` to read its own snapshot and repopulate context fields before `recover()`:

```typescript
static fromCard(args: { projectRoot: string; card: CardRecord; store: CardActorStorePort; processor: CardProcessorActor }): CardActor {
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

`readActorSnapshot(projectRoot, actorId)` is a new helper in `snapshots.ts` (the existing `readActorSnapshots` reads ALL snapshots; this filters to one). This single-location fix:

- Fixes all materialization paths, not just the notification port.
- Fixes the pre-existing restart-loss bug for cancellation notifications.
- Keeps `SupervisorRuntimeApi` simple — no snapshot logic in the registry.

### 4. Rewire `queue_notification`

**Current path (broken):**

```
queueNotification() → resolveSessionIds() → NotificationCenter.enqueue(sessionId, ...)
```

**New path:**

```
queueNotification() → resolveRecipientCardIds() → port.notify(cardId, notification) for each
                    → (unchanged) NotificationDeliveryService for external adapters (Telegram)
```

Step-by-step:

1. **Resolve recipient to card IDs.** The existing `resolveRecipient()` supports `{ kind: 'card', cardId }`, `{ kind: 'role', role }`, and `{ kind: 'session', sessionId }`. For card recipients, use directly. For session recipients, parse the session id to extract the card id using the existing `parseAgentSessionId()` logic in `src/notifications/notification-triggers.ts:35-54`:
   - `planner:<goalId>` → goalId
   - `executor:<cardId>` → cardId
   - `reviewer:<goalId>:<assessmentId>` → goalId
   - `analyst:<sessionId>` → no card target (analyst has no card)

   For role recipients, find all active LLM actor snapshots of that role and map each to its card id using the same parsing.

2. **For each target card ID**, call `port.notify(cardId, notification)`.

3. **Keep `NotificationDeliveryService` for external adapters.** The Telegram adapter still receives the notification. The session-keyed `NotificationCenter` continues as the adapter host — its `drainPendingForSession` was never called and can be removed later.

Changes to `notification-triggers.ts`:

```typescript
export function queueNotification(
  projectRoot: string,
  recipient: Recipient,
  kind: string,
  body: string,
  source: NotificationSourceMeta,
  store?: CardStore,
  cardNotification?: CardNotificationPort,
): void {
  const createdAt = new Date().toISOString();
  const notification: CardNotification = {
    id: `notify:${kind}:${createdAt}:${Math.random().toString(36).slice(2, 8)}`,
    message: body,
    created_at: createdAt,
    reason: kind,
  };

  // Agent delivery via CardActor (Subsystem C)
  if (cardNotification) {
    for (const cardId of resolveRecipientCardIds(projectRoot, recipient, store)) {
      cardNotification.notify(cardId, notification);
    }
  }

  // External adapter delivery (Telegram, etc.) — unchanged
  const delivery = createNotificationDeliveryService(projectRoot);
  for (const sessionId of resolveSessionIds(projectRoot, recipient, store)) {
    delivery.enqueue(sessionId, { kind, body, queued_at: createdAt, source_actor: source.actor, source_surface: source.surface });
  }
}
```

### 5. Rewire `propagateChange`

**Current path (broken):**

```
propagateChange()
  → flip resting cards to 'changed' (works)
  → stop at running ancestor (stops, does NOT notify)
  → queuePlannerNote() → ActiveGoalNoteSinks (dead) / synthetic-notes (undrained)
```

**New path:**

```
propagateChange()
  → for each card in ancestor path:
    → if running: port.notify(cardId, changeNotification(reason))
    → if resting (done/failed/blocked/cancelled): store.setStatus('changed')
  → stop after first running card
```

Changes to `changed-propagation.ts`:

```typescript
export function propagateChange(
  projectRoot: string,
  store: CardStore,
  editedCardId: string,
  origin: ChangeOrigin,
  cardNotification?: CardNotificationPort, // NEW
): ChangedPropagation {
  const edited = store.read(editedCardId);
  if (!edited) throw new Error(`Card '${editedCardId}' not found.`);

  const path = [editedCardId, ...store.getAncestors(editedCardId).reverse()];
  const flipped: ChangedPropagation['flipped'] = [];
  let stopped_at_running: string | null = null;

  const summary = originSummary(origin);

  for (const cardId of path) {
    const card = store.read(cardId);
    if (!card) continue;
    if (card.status === 'running') {
      stopped_at_running = cardId;
      if (cardNotification) {
        cardNotification.notify(cardId, {
          id: `change:${cardId}:${new Date().toISOString()}`,
          message: `Card changed: ${summary}`,
          created_at: new Date().toISOString(),
          reason: 'card_changed',
        });
      }
      break;
    }
    if (FLIPPABLE_RESTING.has(card.status)) {
      store.setStatus(cardId, 'changed');
      flipped.push({ card_id: cardId, previous_status: card.status });
    }
  }

  return { flipped, stopped_at_running };
}
```

**Important:** `notified_planner_session_ids` is removed from the return type. This affects `src/agents/analyst-stage6.ts:15-17`, which reads both `flipped` and `notified_planner_session_ids`. The `flipped` field IS still live (used to derive `status_transition`) and must be kept. The `notified_planner_session_ids` field must be removed from `markGoalNeedsCorrections` and its callers. Audit all callers of `markGoalNeedsCorrections` during implementation.

### 6. Spec §9 Gap: The Edited Card Itself

Spec §9 line 185 says: "the runtime queues a notification to the **modified card** so that the main agent handling that card becomes aware of the change." The current `propagateChange` starts the path at the edited card but only acts on it if it is `running` or resting-flippable. A `backlog` edited card is neither — it gets no notification and no status change, yet the spec says it should be notified for its next session.

This is a pre-existing gap. The fix should add: if the edited card itself is not running and not flipped, still call `port.notify(editedCardId, changeNotification(reason))` so the notification persists for the card's next activation. This does not change the status (backlog stays backlog) but queues the context.

### 7. Reviewer Currentness Interaction

`captureReviewerCurrentness` in `src/runtime/actors/planning-card-processor-actor.ts:337-341` records `hasPendingNotifications: input.notificationDelivery.hasPendingNotifications?.()`. When a notification is enqueued via `port.notify()` on a card under review, `hasPendingNotifications` flips to `true`, which triggers review invalidation via `reviewerCurrentnessStaleReason`. This is **correct** per spec §9 line 191.

**Known pre-existing limitation:** the CardActor's `notifications` array is shared between planner and reviewer within one activation. If the reviewer's `notificationContextMessages` drains the change notification before the currentness check re-runs, both snapshots see `hasPendingNotifications === false` and the change goes undetected. This is a pre-existing race in the shared-queue design, not introduced by this fix, but the fix amplifies its frequency. A clean solution would route review-relevant change signals through the currentness snapshot's own state rather than through the shared notification queue — but that is a separate, larger change that should be acknowledged as a known limitation.

### 8. Runtime State Nuance: Stopped vs Paused

Analyst card-edit operations sit behind `requireMutableRuntime` which requires runtime status `stopped` or `paused`:

- **When paused:** `cardActors` Map is still populated. A live actor exists for any running ancestor. `port.notify()` calls `liveActor.enqueueNotification()` which will be delivered when the runtime resumes and the processor reaches its next LLM input. This is the primary intended path.

- **When stopped:** there is no live `SupervisorRuntimeApi` or `cardActors` at all. `port.notify()` writes to the snapshot directly. When the runtime next starts and `cardActor(cardId)` is called, `CardActor.fromCard()` restores the notification from the snapshot. The notification is then delivered on the card's first LLM input.

Both paths work correctly with the proposed design.

## Threading The Port

The port must reach:

1. **`queue_notification` tool** (planner and Analyst): Add `cardNotification?: CardNotificationPort` to `PlannerControlProviderContext` and `ToolContext`. Wire the concrete `SupervisorRuntimeApi` instance as the port in `runtime-composition.ts` where the runtime API and analyst deps are assembled.

2. **`propagateChange` callers** (`analyst-card-tools.ts`, `analyst-stage6.ts`): These already receive `projectRoot` and `store` from `ToolContext`. Add `cardNotification` to the function signature and pass `ctx.cardNotification` from each call site.

Note: `ToolContext` intentionally does not see runtime internals. Adding `cardNotification` as a narrow port (one method) is the minimal cross-cutting change. The analyst runs outside the runtime's sequential execution, but the port only writes to actor state (either live or snapshot) — it does not trigger execution.

## What Stays, What Is Deleted

**Stays (Subsystem C — the working delivery mechanism):**
- `CardActor.enqueueNotification()`, `deliverNotificationsForInput()`, `hasPendingNotifications()`.
- `CardActor.cancel()` notification path (unchanged).
- `CardActor.markChanged()` — stays as an internal method; not part of the port, not called externally.
- `CardActor.reopenDoneWithPendingNotifications()` (unchanged).
- `BaseMainLLMCardProcessorActor.notificationContextMessages()` (unchanged).
- All notification delivery markers and snapshot persistence (unchanged).

**Stays (external adapter delivery):**
- `NotificationCenter` (as adapter host for Telegram).
- `NotificationDeliveryService` (for external adapter fan-out).

**Deleted (old remnant plumbing — after the fix is proven):**
- `src/runtime/actors/active-goal-note-sinks.ts` — entire file.
- `src/runtime/synthetic-planner-notes.ts` — entire file.
- `queuePlannerNote()` and the note-routing branches in `changed-propagation.ts`.
- `notified_planner_session_ids` from `ChangedPropagation` return type.
- `drainPendingForSession()` usage from any test that simulates agent delivery.
- The unused `queueNotification` import in `analyst-card-tools.ts`.

## Migration Sequence

### Phase 1: Wire The Bridge

1. Define `CardNotificationPort` interface (one method: `notify`).
2. Add `readActorSnapshot(projectRoot, actorId)` helper to `snapshots.ts`.
3. Add `appendNotificationToSnapshot(projectRoot, actorId, notification)` helper to `snapshots.ts`.
4. Fix `CardActor.fromCard()` to restore notifications/markers/change/cancel from snapshot.
5. Implement `CardNotificationPort` in `SupervisorRuntimeApi` (live actor or snapshot write).
6. Rewire `queueNotification()` in `notification-triggers.ts` to call `port.notify()`.
7. Rewire `propagateChange()` to call `port.notify()` for running ancestors.
8. Add notification for the edited card itself (§9 gap fix).
9. Thread the port to planner/Analyst tool contexts via `runtime-composition.ts`.
10. Update `markGoalNeedsCorrections` and its callers to drop `notified_planner_session_ids`.
11. Add end-to-end tests (see Test Plan below).

### Phase 2: Delete Old Plumbing

1. Delete `active-goal-note-sinks.ts`.
2. Delete `synthetic-planner-notes.ts`.
3. Strip `queuePlannerNote()` and note-routing from `changed-propagation.ts`.
4. Remove unused `queueNotification` import in `analyst-card-tools.ts`.
5. Rewrite `changed-propagation.test.ts` to assert via the port + CardActor delivery.

## Test Plan

### Phase 1 Tests (Must Pass Before Phase 2)

1. **`queue_notification` to a running card delivers to the next LLM input.**
   - Setup: runtime running, card-7 is active with a planner.
   - Action: call `queue_notification` with recipient `card-7`.
   - Assert: the planner's next LLM input includes the notification message.

2. **`queue_notification` to an inactive card persists and delivers on next activation.**
   - Setup: runtime stopped, card-7 is in `backlog`.
   - Action: call `queue_notification` with recipient `card-7`.
   - Start runtime; card-7 gets activated.
   - Assert: the planner's first LLM input includes the notification.

3. **Analyst edits a brief → running ancestor planner receives change notification.**
   - Setup: runtime running, goal-1/card-7 chain active, goal-1 planner running.
   - Action: pause runtime; analyst writes `record://brief.md?card=card-7`.
   - Resume runtime.
   - Assert: goal-1 planner's next LLM input includes a "Card changed" notification.

4. **Analyst edits a brief → resting ancestor is flipped to changed.**
   - Setup: runtime stopped, goal-1 is `done`.
   - Action: analyst edits child card-7's brief.
   - Assert: goal-1 status becomes `changed`.

5. **Cancellation-while-running still works (regression test).**
   - Setup: runtime running, card-7 executor active.
   - Action: planner calls `cancel_card` for card-7.
   - Assert: executor receives cancellation notification as before.

6. **Done card with pending notifications reopens as changed.**
   - Setup: card completes `done` while notifications are pending.
   - Assert: card status becomes `changed`, not `done`.

7. **Telegram delivery still works (regression test).**
   - Setup: Telegram adapter configured.
   - Action: call `queue_notification`.
   - Assert: Telegram adapter receives the notification.

8. **Notifications survive runtime restart (new regression test).**
   - Setup: runtime running, card-7 receives a cancellation notification.
   - Stop runtime (not clean shutdown — simulate restart).
   - Start runtime; card-7 gets activated.
   - Assert: the notification is delivered to the first LLM input.

### Phase 2 Tests (After Old Plumbing Deletion)

9. **Old note-sink code is absent from source.**
   - Assert: `active-goal-note-sinks.ts` does not exist.
   - Assert: `synthetic-planner-notes.ts` does not exist.

## Known Limitations

1. **Shared planner/reviewer notification queue.** Within one activation, the planner and reviewer share the CardActor's `notifications` array. A change notification enqueued during a review may be drained by the reviewer's `notificationContextMessages` before the currentness check detects it, causing a missed invalidation. This is a pre-existing race amplified by the fix. A clean solution requires separate currentness-tracking state, which is a separate change.

2. **External adapter fan-out.** Every agent-targeted `queue_notification` is also pushed to Telegram (unchanged from today). If agent and operator delivery should be disjoint, that requires a recipient-model change, not just a delivery-path change.

## Spec Cross-Reference

- **§12:** "A notification is queued onto a card. The card runtime delivers it to that card's main agent session." → `port.notify()` → `CardActor.enqueueNotification()` → `deliverNotificationsForInput()`.
- **§12:** "the next future main agent session for that card, if that session is ever started" → snapshot-persisted notifications restored via `CardActor.fromCard()`.
- **§12:** "If a card settles while notifications remain pending, the runtime must not silently discard that context." → `CardActor.reopenDoneWithPendingNotifications()` (already implemented).
- **§9:** "the runtime queues a notification to the modified card" → `port.notify(editedCardId, ...)` (§9 gap fix in Phase 1 step 8).
- **§9:** "Running ancestors remain running and receive notification/context" → `port.notify(runningAncestorId, ...)` in `propagateChange`.
- **§9:** "If a goal is under review and the goal or any descendant changes before the reviewer pass commits, the reviewer pass is invalidated." → `hasPendingNotifications` in currentness check (see Known Limitations for race condition).
