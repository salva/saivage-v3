# Notification Delivery Fix Design

Status: current design document for fixing broken agent-facing notification delivery.

Last reviewed: 2026-07-02.

## Problem

The system spec (§12 Notifications, §9 Changed Cards) promises two critical behaviors:

1. **`queue_notification`** queues a notification onto a card. The card runtime delivers it to that card's main agent session.
2. **Analyst card edits** queue a change notification so affected running planners become aware of the change.

Neither works today. Three disconnected notification subsystems exist in the codebase, and no path connects the queuing tools to the working delivery mechanism.

## Current State

### Subsystem A — `queue_notification` → `NotificationCenter` (BROKEN for agents)

```
queue_notification tool
  → queueNotification()                          [notification-triggers.ts:95]
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

`SupervisorRuntimeApi` already maintains `private readonly cardActors = new Map<string, CardActor>()` and a private `cardActor(cardId)` method that lazily creates/recovers CardActors for any card. This is the existing registry that tools and propagation need to reach. It just needs to be exposed through a port.

File: `src/runtime/actors/supervisor-runtime-api.ts:44,277-285`.

## Design Goals

1. `queue_notification` must deliver notifications to the target card's main agent via the CardActor.
2. Analyst card edits must notify affected running planners via CardActor.markChanged().
3. Notifications for inactive cards must persist durably until the card is next activated.
4. The working cancellation-while-running path must not break.
5. Telegram/operator notification delivery must continue to work.
6. Old remnant plumbing is deleted only after the new path is proven.

## Design

### 1. Card Notification Port

Expose CardActor access for notification routing without breaking encapsulation.

```typescript
// New port interface (in card-actor.ts or a new file)
export interface CardNotificationPort {
  /** Find the CardActor for a card, creating it lazily if needed. */
  getCardActor(cardId: string): CardActor | null;
  /** Check whether a card currently has a live (running or parked) CardActor. */
  hasLiveActor(cardId: string): boolean;
}
```

`SupervisorRuntimeApi` implements this port by exposing its existing `cardActor()` method. The port is passed to:

- `queue_notification` tool executors (planner and Analyst).
- `propagateChange`.

Implementation in `SupervisorRuntimeApi`:

```typescript
// Add to SupervisorRuntimeApi
getCardActor(cardId: string): CardActor | null {
  const card = this.options.actorStore.read(cardId);
  if (!card) return null;
  return this.cardActor(cardId); // existing private method, now exposed via port
}

hasLiveActor(cardId: string): boolean {
  return this.cardActors.has(cardId);
}
```

The port is threaded through the same dependency injection paths that already carry `actorStore`, `provider`, etc.:

- For the **planner** `queue_notification`: the planner's `PlannerControlProviderContext` already has a `children: PlannerChildActorPort` that returns CardActors for immediate children. Extend the context to also accept a `CardNotificationPort` for non-child card addressing.
- For the **Analyst** `queue_notification`: the `ToolContext` gains an optional `cardNotification?: CardNotificationPort` field.
- For **`propagateChange`**: the function signature gains a `cardNotification: CardNotificationPort` parameter (or it is resolved from the project-root singleton).

### 2. Rewire `queue_notification`

**Current path (broken):**

```
queueNotification() → resolveSessionIds() → NotificationCenter.enqueue(sessionId, ...)
```

**New path:**

```
queueNotification() → resolveRecipientCard() → cardNotification.getCardActor(cardId)?.notify(notification)
                                              → ALSO: NotificationDeliveryService for external adapters (Telegram)
```

Step-by-step:

1. **Resolve recipient to a card ID.** The existing `resolveRecipient()` already supports `{ kind: 'card', cardId }`. For `{ kind: 'role' }` and `{ kind: 'session' }`, resolve to affected card IDs using the existing `findAffectedActiveSessionsForCard` logic (which reads actor snapshots to find which cards have active sessions for that role).

2. **For each target card ID**, call `cardNotification.getCardActor(cardId)?.notify(notification)`. This calls `CardActor.enqueueNotification()`, which:
   - Pushes the notification to `this.notifications[]`.
   - Persists via `saveActorSnapshot()`.
   - If the card is currently running (has an active processor), the notification will be drained on the next LLM input via `deliverNotificationsForInput()`.
   - If the card is not running, the notification persists in the actor snapshot and will be restored when the card is next activated.

3. **Keep `NotificationDeliveryService` for external adapters only.** The Telegram adapter and any future external adapters still receive the notification through `NotificationCenter.enqueue()`. But the session-keyed in-memory queue is no longer the agent delivery path — it is the external-adapter fan-out host.

4. **Remove `drainPendingForSession` from the agent delivery path.** It was never called. If a future need arises for session-keyed delivery (e.g., analyst session notifications), it can be re-evaluated. For now, card-addressed delivery is the only agent path.

Changes to `notification-triggers.ts`:

```typescript
export function queueNotification(
  projectRoot: string,
  recipient: Recipient,
  kind: string,
  body: string,
  source: NotificationSourceMeta,
  store?: CardStore,
  cardNotification?: CardNotificationPort, // NEW
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
      const actor = cardNotification.getCardActor(cardId);
      if (actor) actor.notify(notification);
    }
  }

  // External adapter delivery (Telegram, etc.) — unchanged
  const delivery = createNotificationDeliveryService(projectRoot);
  const queuedAt = createdAt;
  for (const sessionId of resolveSessionIds(projectRoot, recipient, store)) {
    delivery.enqueue(sessionId, { kind, body, queued_at: queuedAt, source_actor: source.actor, source_surface: source.surface });
  }
}
```

### 3. Rewire `propagateChange`

**Current path (broken):**

```
propagateChange()
  → flip resting cards to 'changed' (works)
  → stop at running ancestor (stops, does not notify)
  → queuePlannerNote() → ActiveGoalNoteSinks (dead) / synthetic-notes (undrained)
```

**New path:**

```
propagateChange()
  → for each card in ancestor path:
    → if running: cardNotification.getCardActor(cardId)?.markChanged({ reason })
    → if resting (done/failed/blocked/cancelled): store.setStatus('changed')
```

Step-by-step:

1. **Walk the ancestor path** `[edited, ...ancestors]` as today.

2. **For each card in the path:**
   - If the card is `running`: call `cardNotification.getCardActor(cardId)?.markChanged({ reason: summary })`. `CardActor.markChanged()` enqueues a change notification to the active processor (if running) or flips to `changed` (if not running). This replaces the current `stopped_at_running` dead-end.
   - If the card is resting (`done`/`failed`/`blocked`/`cancelled`): flip to `changed` via `store.setStatus('changed')` as today. This is the durable parent-visible signal.

3. **Stop walking** after the first running card (its `markChanged` notification will propagate context; the runtime's sequential execution model means the running card's planner will observe the change and decide whether to activate changed descendants).

4. **Delete the old plumbing:** Remove `queuePlannerNote()`, the `ActiveGoalNoteSinks` import, the `findContainingPlannerChain` import, and the `notified_planner_session_ids` return field. The notification is now delivered through the CardActor, not through session-keyed queues.

Changes to `changed-propagation.ts`:

```typescript
export function propagateChange(
  projectRoot: string,
  store: CardStore,
  editedCardId: string,
  origin: ChangeOrigin,
  cardNotification: CardNotificationPort, // NEW
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
      const actor = cardNotification.getCardActor(cardId);
      if (actor) actor.markChanged({ reason: summary });
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

The `notified_planner_session_ids` field is removed from `ChangedPropagation` because delivery is now through CardActor (which handles its own delivery tracking via `notificationDeliveryMarkers`). Callers that ignored this field are unaffected; any caller that read it should be updated.

### 4. Durable Pending Notifications For Inactive Cards

When a notification is queued for a card that has no live CardActor, we need the notification to persist until the card is next activated.

**Current behavior:** `SupervisorRuntimeApi.cardActor(cardId)` lazily creates a CardActor via `CardActor.fromCard()`. The CardActor is created in the card's current lifecycle state. When `notify()` is called, the notification is pushed to `this.notifications[]` and persisted via `saveActorSnapshot()`.

**What needs to happen:** When the CardActor is later activated (or the runtime restarts and recovers), the persisted notifications must be restored.

**Fix:** Modify `CardActor.fromCard()` (or `SupervisorRuntimeApi.cardActor()`) to restore `notifications` and `notificationDeliveryMarkers` from the persisted actor snapshot:

```typescript
// In SupervisorRuntimeApi.cardActor():
private cardActor(cardId: string): CardActor {
  const existing = this.cardActors.get(cardId);
  if (existing) return existing;
  const card = this.options.actorStore.read(cardId);
  if (!card) throw new Error(`Card '${cardId}' not found.`);
  const actor = CardActor.fromCard({ projectRoot: this.options.projectRoot, card, store: this.options.actorStore, processor: this.processorFor(card) });
  // Restore persisted notification state from snapshot
  const snapshot = readActorSnapshot(this.options.projectRoot, cardActorId(cardId));
  if (snapshot?.context?.notifications) actor.notifications = snapshot.context.notifications;
  if (snapshot?.context?.notificationDeliveryMarkers) actor.notificationDeliveryMarkers = snapshot.context.notificationDeliveryMarkers;
  this.cardActors.set(cardId, actor);
  return actor;
}
```

This ensures notifications queued for inactive cards survive until the card is activated and its processor receives them via `deliverNotificationsForInput()`.

### 5. What Stays, What Is Deleted

**Stays (Subsystem C — the working delivery mechanism):**
- `CardActor.notify()`, `enqueueNotification()`, `deliverNotificationsForInput()`, `hasPendingNotifications()`.
- `CardActor.markChanged()` (now called by `propagateChange`).
- `CardActor.cancel()` notification path (unchanged).
- `CardActor.reopenDoneWithPendingNotifications()` (unchanged).
- `BaseMainLLMCardProcessorActor.notificationContextMessages()` (unchanged).
- All notification delivery markers and snapshot persistence (unchanged).

**Stays (external adapter delivery):**
- `NotificationCenter` (as adapter host for Telegram and future external adapters).
- `NotificationDeliveryService` (for external adapter fan-out).
- `NotificationDeliveryAdapter` interface and Telegram adapter.

**Deleted (old remnant plumbing — after the fix is proven):**
- `src/runtime/actors/active-goal-note-sinks.ts` — entire file.
- `src/runtime/synthetic-planner-notes.ts` — entire file.
- `queuePlannerNote()` and the note-routing branches in `changed-propagation.ts`.
- `notified_planner_session_ids` from `ChangedPropagation` return type.
- `drainPendingForSession()` usage from any test that simulates agent delivery (tests should use CardActor delivery instead).
- The unused `queueNotification` import in `analyst-card-tools.ts`.

### 6. Recipient Resolution

`queue_notification` accepts a `recipient` string that `resolveRecipient()` parses into:
- `{ kind: 'card', cardId }` — direct card targeting.
- `{ kind: 'role', role }` — all active sessions of that role.
- `{ kind: 'session', sessionId }` — a specific session id.

For the new card-addressed delivery, we need to resolve all recipient kinds to card IDs:

```typescript
function resolveRecipientCardIds(
  projectRoot: string,
  recipient: Recipient,
  store?: CardStore,
): string[] {
  if (recipient.kind === 'card') return [recipient.cardId];
  if (recipient.kind === 'session') {
    // Parse the session id to extract the card id
    // e.g., "planner:card-7" → card-7, "executor:card-9" → card-9
    return parseCardIdFromSessionId(recipient.sessionId);
  }
  if (recipient.kind === 'role' && store) {
    // Find all cards with active sessions for that role
    return findAffectedActiveSessionsForCard(projectRoot, store, ...)
      .map((target) => parseCardIdFromSessionId(target.sessionId))
      .filter((id): id is string => id !== null);
  }
  return [];
}
```

The existing `parseAgentSessionId()` in `notification-triggers.ts` already parses session ids into `{ card_id, goal_card_id }`. For notification delivery, the relevant card is:
- For `planner:*` → the goal card id.
- For `executor:*` → the executor card id.
- For `reviewer:*` → the goal card id.

## Migration Sequence

### Phase 1: Wire The Bridge

1. Define `CardNotificationPort` interface.
2. Add `getCardActor()`/`hasLiveActor()` to `SupervisorRuntimeApi`.
3. Thread the port to `queue_notification` tool executors (planner and Analyst) and to `propagateChange`.
4. Fix `CardActor` snapshot restore for notifications in `SupervisorRuntimeApi.cardActor()`.
5. Rewire `queueNotification()` in `notification-triggers.ts` to call `actor.notify()` for agent delivery.
6. Rewire `propagateChange()` to call `actor.markChanged()` for running cards.
7. Add end-to-end tests (see Test Plan below).

### Phase 2: Delete Old Plumbing

1. Delete `active-goal-note-sinks.ts`.
2. Delete `synthetic-planner-notes.ts`.
3. Strip `queuePlannerNote()` and note-routing from `changed-propagation.ts`.
4. Remove `notified_planner_session_ids` from `ChangedPropagation`.
5. Remove unused `queueNotification` import in `analyst-card-tools.ts`.
6. Update or delete tests that depended on the old note-sink/synthetic-note path.

### Phase 3: Clean Up NotificationCenter Role

1. Document that `NotificationCenter` is the external-adapter host, not the agent delivery path.
2. Remove `drainPendingForSession()` if no remaining consumer exists.
3. Update any test that used `drainPendingForSession` to simulate agent delivery — those tests should assert via CardActor delivery instead.

## Test Plan

### Phase 1 Tests (Must Pass Before Phase 2)

1. **`queue_notification` to a running card delivers to the next LLM input.**
   - Setup: runtime running, card-7 is active with a planner.
   - Action: call `queue_notification` with recipient `card-7`.
   - Assert: the planner's next LLM input includes the notification message as a user context message.

2. **`queue_notification` to an inactive card persists and delivers on next activation.**
   - Setup: runtime stopped, card-7 is in `backlog`.
   - Action: call `queue_notification` with recipient `card-7`.
   - Start runtime; card-7 gets activated.
   - Assert: the planner's first LLM input includes the notification.

3. **Analyst edits a brief → running ancestor planner receives change notification.**
   - Setup: runtime running, goal-1/card-7 chain active, goal-1 planner running.
   - Action: analyst writes `record://brief.md?card=card-7` (paused runtime).
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

### Phase 2 Tests (After Old Plumbing Deletion)

8. **Old note-sink code is absent from source.**
   - Assert: `active-goal-note-sinks.ts` does not exist.
   - Assert: `synthetic-planner-notes.ts` does not exist.
   - Assert: `changed-propagation.ts` does not import them.

9. **`propagateChange` return type no longer has `notified_planner_session_ids`.**
   - Assert: callers compile without it.

## Files Changed

### Phase 1

| File | Change |
| --- | --- |
| `src/runtime/actors/card-actor.ts` | Export `CardNotificationPort` interface. |
| `src/runtime/actors/supervisor-runtime-api.ts` | Implement `CardNotificationPort`; fix snapshot restore for notifications in `cardActor()`. |
| `src/notifications/notification-triggers.ts` | Rewire `queueNotification()` to call `actor.notify()` via `CardNotificationPort`; add `resolveRecipientCardIds()`. |
| `src/runtime/changed-propagation.ts` | Accept `CardNotificationPort`; call `actor.markChanged()` for running cards; remove old note-routing. |
| `src/tools/planner-control-provider.ts` | Thread `CardNotificationPort` to `queueNotificationTool`. |
| `src/tools/analyst-misc-tools.ts` | Thread `CardNotificationPort` to `queue_notification`. |
| `src/agents/analyst-handler.ts` | Thread `CardNotificationPort` into Analyst `ToolContext`. |
| `src/tools/analyst-card-tools.ts` | Thread `CardNotificationPort` to `propagateChange` calls. |
| `src/agents/analyst-stage6.ts` | Thread `CardNotificationPort` to `propagateChange` calls. |
| `src/runtime/actors/planner-control-provider.ts` | Thread `CardNotificationPort` into planner context. |
| `src/application/runtime-composition.ts` | Wire `SupervisorRuntimeApi` as `CardNotificationPort` source. |

### Phase 2

| File | Change |
| --- | --- |
| `src/runtime/actors/active-goal-note-sinks.ts` | Delete entire file. |
| `src/runtime/synthetic-planner-notes.ts` | Delete entire file. |
| `src/runtime/changed-propagation.ts` | Remove `queuePlannerNote`, old imports, `notified_planner_session_ids`. |
| `src/tools/analyst-card-tools.ts` | Remove unused `queueNotification` import. |
| Tests referencing old note sinks | Delete or rewrite. |

## Spec Cross-Reference

This design implements:

- **§12 Notifications:** "A notification is queued onto a card. The card runtime delivers it to that card's main agent session." → CardActor.notify() + deliverNotificationsForInput().
- **§12 Notifications:** "the next future main agent session for that card, if that session is ever started" → snapshot-persisted notifications restored on CardActor materialization.
- **§12 Notifications:** "If a card settles while notifications remain pending, the runtime must not silently discard that context." → CardActor.reopenDoneWithPendingNotifications() (already implemented).
- **§9 Changed Cards:** "the runtime queues a notification to the modified card so that the main agent handling that card becomes aware of the change" → propagateChange calls actor.markChanged().
- **§9 Changed Cards:** "Running ancestors remain running and receive notification/context instead of having their status overwritten" → propagateChange calls actor.markChanged() on running ancestors.
