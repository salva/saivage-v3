# S04 — Notifications: queue-only, ephemeral, single producer

## Goal

Replace the v2 note-plus-notification stack with the SPEC-r7 notification
primitive: a queue-only, immutable, ephemeral, in-memory delivery channel
with no inbox, no list, no get, no acknowledge, no delete, no edit, and
no read-only operator surface. Collapse every existing producer
(planner, executor, reviewer, runtime, error-reporter, analyst) onto one
internal entry point. Make the analyst's `queue_notification` tool the
only public producer and replace the S02 `not_yet_available` stub with
the real queue mechanic. Audit-wrap analyst queueing through the S02
audit wrapper with `actor='analyst'` and the calling surface; record
only the fact of queueing, not the notification content.

## Scope

In scope:

- Delete the v2 note store and its on-disk artefacts:
  - `saivage-v3/src/cards/notes.ts` (the file and every export).
  - `noteRecordSchema`, `notesQueueEntrySchema`, `notesQueueSchema`,
    `NoteRecord`, `NotesQueue`, `NotesQueueEntry`,
    `NotesQueueResolvedEntry` from
    `saivage-v3/src/schemas/validators.ts` and
    `saivage-v3/src/schemas/types.ts` and the re-export block in
    `saivage-v3/src/schemas/index.ts`.
  - `.saivage/notes/` directory creation, validation, and read paths
    in `saivage-v3/src/persistence/file-tree.ts` (the
    `defaultNotesQueue` helper at line 69, the `notesQueueSchema`
    import at line 7, the `isValidJsonFile` check at line 123, and
    the `writeFileAtomic(... 'notes', 'queue.json' ...)` seed at
    line 154 all go away).
  - `add_note`, `list_notes`, `get_note`, `mark_note_handled` and
    their `addNoteInput`/`listNotesInput`/`getNoteInput`/
    `markNoteHandledInput` zod inputs from
    `saivage-v3/src/tools/agent-tools.ts` (imports at lines 5/11/15/17;
    inputs at lines 97/104/105/106; tool registrations at lines 115
    and 122-124). The corresponding role grants for `planner`,
    `executor`, `reviewer`, and `analyst` in
    `saivage-v3/src/agents/role-tool-policy.ts` are removed in the
    same commit (planner row: `add_note`; executor and reviewer rows:
    `list_notes`, `get_note`, `mark_note_handled`; analyst row:
    `list_notes`, `get_note`, `mark_note_handled`).
- Delete the durable notification ledger:
  - On-disk paths `.saivage/runtime/notifications/by-session/*.jsonl`
    and `.saivage/runtime/notifications/operator.jsonl` are no longer
    written. The `notificationsRoot`,
    `sessionNotificationsPath`, and `operatorNotificationsPath`
    helpers in `saivage-v3/src/notifications/notification-center.ts`
    (lines ~28-39) are removed.
  - The `notificationRecordSchema`-backed `JsonlLedger` factory
    `notificationLedger` in
    `saivage-v3/src/projections/ledger-projections.ts` (lines 44-45)
    is removed. The `LedgerProjection`-style class that subscribes to
    `notification_record_appended` (lines 76-87) is removed.
  - The event `notification_record_appended` is removed from
    `saivage-v3/src/events/registry.ts` (line 63). The event kind
    `notification_acknowledged` is also removed (it is a no-op after
    this stage because the only acknowledge path is gone). The
    `notification_added` event is kept as a transient broadcast hint;
    its payload schema is narrowed to omit `payload_summary`,
    `related_note_id`, and any field whose presence would constitute
    a "second notification-reading surface" per SPEC-r7
    `## Terminology: from "notes" to "notifications"` clause
    "No direct inspection".
- Rewrite `NotificationCenter` as an in-memory FIFO queue keyed by
  receiving session id. The class replaces every method that returned
  or mutated a persisted record with a single `enqueue` plus a
  `drainPendingForSession(sessionId)` that removes and returns the
  pending entries for that session in FIFO order, after which the
  entries are no longer reachable from the queue. There is no
  `markDeliveredForSession`, no `acknowledge`, no `acknowledgeForOperator`,
  no `listForOperator`, no `classifyForSession`, no
  `listUnacknowledgedBlockingForSession`, no
  `hasBlockingPendingForSession`.
- Replace the per-producer wrappers
  `enqueueCardMutationNotifications`,
  `enqueueNoteNotifications`,
  `enqueueRuntimeStateNotifications`,
  `enqueueProcessReconciliationNotification` in
  `saivage-v3/src/notifications/notification-triggers.ts` with one
  internal producer entry point
  `queueNotification(projectRoot, recipient, kind, body, source)`
  that the planner, executor, reviewer, runtime, and error-reporter
  all call. The `enqueueNoteNotifications` call site in
  `saivage-v3/src/cards/notes.ts` line 264 goes away with the file.
  The `enqueueCardMutationNotifications` call site in
  `saivage-v3/src/cards/card-store.ts` line 691 becomes a call to
  the new internal producer.
- Make `queue_notification` real in
  `saivage-v3/src/agents/analyst-tools.ts`: replace the S02 stub
  `{ success: false, data: { reason: 'not_yet_available',
  stage_owner: 'S04', recipient } }` with a call into the internal
  producer plus an audit envelope through `runAuditedAnalystTool`
  with `actor='analyst'`, `surface=ctx.surface`,
  `action='notification.queue'`, `target_kind='notification_recipient'`,
  `target_id=params.recipient`. The audit record stores `{ recipient,
  kind }` only; the `body` field is never written to the audit log
  (per SPEC-r7 "the entry references the queueing action only; it
  does not retain notification content as a retrievable object").
- Wire `queue_notification` into the planner-control tool surface per
  the S03 precedent (S03 `design.md` `## Approach > Audit and surfaces`
  paragraph). The planner-control surface in
  `saivage-v3/src/agents/agent-adapter.ts` registers the tool in
  `PLANNER_TOOL_DEFINITIONS` (around lines 97-126), adds the name to
  `PLANNER_CONTROL_TOOL_NAMES` (around lines 127-135), and the
  dispatch switch in
  `saivage-v3/src/agents/planner-control-executor.ts` (around lines
  131-152) gains a `case 'queue_notification':` arm that calls into
  `plannerTools.queueNotification(...)` with the literal
  `surface: 'runtime'` so the recorded
  `ControlActionAuditEntry` carries the correct surface.
- Delete the operator HTTP routes that exposed notification content:
  - `fastify.get('/api/notifications', ...)` at
    `saivage-v3/src/server/routes/runtime-config-notes.ts` line 149.
  - `fastify.post('/api/notifications/:id/acknowledge', ...)` at
    `saivage-v3/src/server/routes/runtime-config-notes.ts` line 157.
  - The `NotificationCenter` instantiation at line 148 is removed
    along with its `redactValue` adornment.
  - The startup notification produced by
    `createNotificationDeliveryService(projectRoot, []).enqueueForOperator({...})`
    in `saivage-v3/src/server/server.ts` line 124 is removed; the
    operator-target queue no longer exists, so a per-operator
    startup notification is meaningless.
- Cut the runtime's blocking-notification injection path
  (`saivage-v3/src/runtime/runtime.ts` lines 437-454,
  `saivage-v3/src/agents/agent-adapter.ts` lines 419-433 plus
  surrounding helpers `formatNotificationGuidance`,
  `buildNotificationInjectionMessage`,
  `buildBlockingNotificationInstruction`). The replacement is a
  single `drainPendingForSession`-driven injection block that
  surfaces only `kind` and `body` (no content rendering of card
  diffs, no `list_notes`/`get_note` follow-up hint). The
  `severity` axis goes away with the durable record.

Out of scope (declared as ledger forecast for the owning later stage):

- The operator-side `NotificationsPanel.vue` and its API client
  helpers `listNotifications` / `acknowledgeNotification`: owner S06
  per MASTER-PLAN §S04 acceptance bullet "UI-side note-inbox panels
  are removed by S06/S09".
- The `stale-warning-ribbon` UI that listens for
  `notification_acknowledged` ws events: owner S06.
- The `operator-dashboard-smoke` test fixture that mocks
  `listNotifications` and `acknowledgeNotification`: owner S06.
- End-to-end coverage across every surface: owner S10.
- UI removal of per-notification acknowledge / clear-all controls:
  owner S06 (MASTER-PLAN §S06 Acceptance line "per-note acknowledge /
  delete / clear-all, per-notification acknowledge").
- Operator API contract pruning of generic mutating routes in
  `saivage-v3/src/contracts/operator-api.ts`: owner S07. Source
  spot-check at S04 close-out time shows zero notification-named
  entries in that contract file, so S04 owns a zero-hit guard on
  the file (Phase H) rather than a content edit; if any
  notification entry appears at S04 implementation time the gate
  fails and S04 deletes those entries in-stage.

## Dependencies

- S00 (breakage-detection harness).
  `SPEC/analyst-as-control-surface/PLAN/baseline-gates.json` and
  `PLAN/scripts/run-gates.sh` are the only gate inputs S04 reads or
  refreshes.
- S02 (tool-surface alignment). S04 consumes the
  `queue_notification` schema slot and the
  `runAuditedAnalystTool` helper. The S02-recorded ledger entry
  `### analyst-e2e:scenario-queue-notification:step-1`
  whose `Target fix stage` is `S04` is the conditional close-out
  in Phase H.

S04 is independent of S03 per MASTER-PLAN §S04 Dependencies. S01 is a
transitive dependency through S02; S04 reads no S01-only construct.

## Approach

### Queue data structure

The in-memory queue lives on a single `NotificationCenter` instance
per project (the same instance attached to `runtime.notificationCenter`
in `saivage-v3/src/runtime/runtime.ts` line 101). Internally:

```
private readonly queues = new Map<string, NotificationQueueEntry[]>();
```

`NotificationQueueEntry` is a structurally narrow record:

```
{ kind: string; body: string; queued_at: string; source_actor: NoteAuthor; source_surface: ControlActionSurface }
```

There is no `id` field exposed to consumers; the entry's only handle
is its FIFO position. The map is private; no method returns the map
or a slice of it for inspection. The set of recipient keys is
`session-id` strings (recipients are agent sessions). When the
analyst addresses a `card-id` or a `role`, the producer at queue time
resolves it to the set of currently-active session ids using
`findAffectedActiveSessionsForCard` (already present in
`notification-triggers.ts` line 67) for card targets, and
`getActiveSessions(projectRoot).filter(role match)` for role
targets. The resolution is performed at queue time, not at drain
time, so a session that becomes active after queueing does not see
the entry. This matches SPEC-r7 "queued to be injected, as soon as
possible, into the next agent session targeting a given card or
role"; the SPEC's "as soon as possible" wording is satisfied by the
existing-session-set snapshot.

### Drain semantics

`drainPendingForSession(sessionId)` is the only consumer interface:

- It atomically removes the recipient's queue entry array from the
  map (replacing it with an empty array) and returns the removed
  entries in FIFO order.
- The returned entries are not retained anywhere else by the
  `NotificationCenter`. Callers MAY copy them into the receiving
  session transcript; the platform itself does not.
- After a successful drain there is no operation that returns the
  drained entries again. The S04 `NotificationCenter` exposes no
  `peek`, no `list`, no `count` (other than an internal
  `queueLengthForSession` used only by the integration test).

The current `agent-adapter.ts` injection loop at lines 419-507
already consumes `drainPendingForSession` and
`markDeliveredForSession`. S04 narrows the loop: only
`drainPendingForSession` is called; the entries are inlined as a
single user-role agent message
(`msg-${sessionId}-notification-injection`); there is no follow-up
`markDeliveredForSession` because the entries left the queue at
drain time. The blocking-hold path (`agent-adapter.ts` lines
419-433, 560 and `runtime.ts` lines 437-454) is deleted in full;
without a durable record there is no concept of an
"unacknowledged blocking notification" to wait on. SPEC-r7
`## Terminology: from "notes" to "notifications"` is the source:
"Once a notification has been delivered to an agent session it is
forgotten by the platform" leaves no surface to block on.

### Retention bound

The queue is bounded per recipient. The bound is `MAX_PENDING = 64`
entries per session id. When a producer attempts to queue against a
session whose pending entry count is already at the bound, the
oldest entry is dropped before the new one is appended. The drop is
emitted as a single `notifications_overflow_dropped` event with
`{ sessionId, dropped_kind }`; the dropped entry's body is not
broadcast. The bound is a project-local constant defined in
`saivage-v3/src/notifications/notification-center.ts` (top of file);
it is not user-configurable, and no `.saivage/config.json` field is
added for it. Empirically the worst v2 burst observed in
`enqueueCardMutationNotifications` plus
`enqueueRuntimeStateNotifications` plus
`enqueueProcessReconciliationNotification` against a single session
during one runtime cycle is well below 64; the bound exists to make
the in-memory footprint deterministic, not to ration normal traffic.

### Single internal producer

`saivage-v3/src/notifications/notification-triggers.ts` is rewritten
to export exactly one public function:

```
export function queueNotification(
  projectRoot: string,
  recipient: { kind: 'card'; cardId: string } | { kind: 'role'; role: AgentRole } | { kind: 'session'; sessionId: string },
  kind: string,
  body: string,
  source: NotificationSourceMeta,
): void
```

`source` keeps the existing
`{ actor: NoteAuthor; surface: ControlActionSurface }` shape.
The function resolves the recipient to a list of session ids via the
same `getActiveSessions` and `findAffectedActiveSessionsForCard`
helpers that already exist in this file (S04 keeps the helpers and
deletes only the per-producer wrappers around them). It calls
`notificationCenter.enqueue(sessionId, { kind, body, source })` for
each resolved session and returns. There is no operator-target
fan-out: the SPEC removes the operator-side notification surface
entirely.

The card-mutation producer at
`saivage-v3/src/cards/card-store.ts` line 691 becomes:

```
queueNotification(this.projectRoot, { kind: 'card', cardId: persisted.id }, 'card_changed', `${persisted.id} updated (${changedFields.join(', ')}) at v${persisted.version_seq}`, { actor: ctx.actor, surface: ctx.surface });
```

The runtime-state producer at
`saivage-v3/src/runtime/control.ts` lines 71 and 123 becomes:

```
queueNotification(ctx.projectRoot, { kind: 'role', role: 'planner' }, 'runtime_state', event === 'paused' ? 'Runtime was paused.' : 'Runtime was resumed.', { actor: 'runtime', surface: 'runtime' });
```

The process-reconciliation producer at
`saivage-v3/src/runtime/process-runner.ts` line 787 becomes a single
call to `queueNotification` with recipient
`{ kind: 'session', sessionId: processRecord.agent_session_id }`
when that field is non-null. When the field is null, no notification
is queued; the SPEC has no operator-side recipient.

The error-reporter path (currently scattered in
`saivage-v3/src/runtime/`) is touched only where it called the
deleted wrappers; the audit shows three usage sites and each is
rewritten in this stage.

### Analyst tool surface

`saivage-v3/src/agents/analyst-tools.ts` `queue_notification`
becomes:

```
export async function queue_notification(ctx, params: { recipient: string; kind: string; body: string }) {
  return runAuditedAnalystTool({
    actor: 'analyst',
    surface: ctx.surface,
    action: 'notification.queue',
    target_kind: 'notification_recipient',
    target_id: params.recipient,
    safety_class: 'low',
    run: async () => {
      const resolved = resolveRecipient(ctx.projectRoot, params.recipient);
      if (resolved === null) {
        return { success: false, data: { reason: 'unknown_recipient', recipient: params.recipient } };
      }
      queueNotification(ctx.projectRoot, resolved, params.kind, params.body, { actor: 'analyst', surface: ctx.surface });
      return { success: true, data: { queued: true, recipient: params.recipient } };
    },
  });
}
```

`resolveRecipient(projectRoot, recipient)` (new helper in
`notification-triggers.ts`) returns:

- `{ kind: 'card', cardId }` when `recipient` matches a known card id,
- `{ kind: 'role', role }` when `recipient` matches an `AgentRole`,
- `{ kind: 'session', sessionId }` when `recipient` matches a known
  active session id,
- `null` otherwise.

The C1 failure shape `{ success: false, data: { reason:
'unknown_recipient', recipient } }` is the SPEC-r7-aligned typed
error: the analyst surface returns it without paraphrase. C2
partial-success does not apply because `queue_notification` is
single-recipient per SPEC-r7 `## Analyst Capability Classes > Queue
notifications` (the SPEC's example utterances target one
card-or-role at a time and the SPEC forbids list/edit/delete/ack
of notifications). The S02
`design.md` `## Approach > Tool surface > queue_notification`
paragraph already records this exclusion; S04 inherits it.

The audit envelope passes `{ recipient: params.recipient, kind:
params.kind }` as `outcome_summary` metadata; `body` is not
included. SPEC-r7 forbids the audit log from "returning notification
content as a queryable object"; recording `kind` is admissible
because `kind` is a discrete enumeration value (not user content),
recording `recipient` is admissible because the audit entry already
records `target_id`, and recording `body` is forbidden.

`safety_class: 'low'`. The action is a non-destructive append to an
in-memory queue; SPEC-r7 reserves confirmation for delete-class
operations and queueing is explicitly described as a low-friction
producer surface. The S02 authz matrix
(`saivage-v3/src/agents/authz.ts` lines 39-42 and 63-66) already
permits `low` for `analyst` and `planner` execution paths.

### Planner-control surface

The planner-control surface gets `queue_notification` per the S03
precedent. Three sites change in lockstep:

1. `saivage-v3/src/agents/agent-adapter.ts` `PLANNER_TOOL_DEFINITIONS`
   (lines 97-126): append one `tool(...)` entry:

   ```
   tool('queue_notification', 'Queue an ephemeral notification for delivery into the next agent session targeting a given card or role. The platform forgets the notification once it has been delivered; there is no list/get/acknowledge/delete.', { recipient: str('A card id, an agent role, or an active session id.'), kind: str('A short categorical label for the notification.'), body: str('The notification text to inject.') }, ['recipient', 'kind', 'body'])
   ```

2. `saivage-v3/src/agents/agent-adapter.ts` `PLANNER_CONTROL_TOOL_NAMES`
   (lines 127-135): add `'queue_notification'`.

3. `saivage-v3/src/agents/planner-control-executor.ts` `execute()`
   switch (lines 131-152): add

   ```
   case 'queue_notification': {
     const recipient = String(args.recipient ?? '');
     const resolved = resolveRecipient(this.context.projectRoot, recipient);
     if (resolved === null) {
       result = { success: false, data: { reason: 'unknown_recipient', recipient } };
       break;
     }
     plannerTools.queueNotification(resolved, String(args.kind ?? ''), String(args.body ?? ''), { actor: 'planner', surface: 'runtime', toolCallId: invocation.toolCallId, sessionId: invocation.sessionId });
     result = { success: true, data: { queued: true, recipient } };
     break;
   }
   ```

   The literal `surface: 'runtime'` is set at this dispatch site so
   the persisted `ControlActionAuditEntry` carries it; this matches
   the S03 precedent for `move_card` / `reorder_child` recorded in
   `stages/003-ordered-children-and-bounded-move/design.md`
   `## Approach > Audit and surfaces`.

`saivage-v3/src/tools/planner-tools.ts` adds a service method
`queueNotification(recipient, kind, body, ctx)` that wraps the
internal producer and emits a
`recordControlAction({ actor: 'planner', surface: 'runtime',
action: 'notification.queue', target_kind:
'notification_recipient', target_id: <recipient-id-or-role> })`
audit row. Body is not recorded.

### Role-tool-policy

`saivage-v3/src/agents/role-tool-policy.ts` adds
`'queue_notification'` to the `planner` and `analyst` rows of
`ROLE_TOOL_NAMES`. It is not added to `executor` or `reviewer`:
those roles produce notifications only through the internal
producer (`queueNotification(...)` called from runtime code paths
they execute), not through a tool call. The deletion of
`list_notes` / `get_note` / `mark_note_handled` from every role's
row is part of the v2 note retirement above.

### Wire-up checks

- `saivage-v3/src/agents/agent-adapter.ts` no longer imports
  `NotificationRecord` from `../schemas`; the schemas barrel
  re-export of `NotificationRecord` is preserved for now (it is
  consumed only by tests slated for S06 removal, which will close
  as ledger entries).
- The notification-delivery adapter chain
  (`NotificationDeliveryService`, the
  `setProjectNotificationDeliveryAdapters` registry, the
  `TelegramNotificationDeliveryAdapter` integration) is preserved.
  These adapters fire on enqueue, which is the right hook for an
  ephemeral queue: side-channel delivery (Telegram) is still
  permitted because Telegram is an external recipient, not a
  platform-side read surface. The adapter is reached from the
  in-memory `enqueue` path; once the in-memory queue accepts the
  entry, the adapter is invoked with the queue entry data (no
  durable record). The adapter contract narrows from
  `NotificationRecord` to `NotificationQueueEntry`; the Telegram
  adapter's `deliver(record, context)` signature is updated in this
  stage.

### Cookbook V.1–V.11 mapping

Same as S03; see `## Done-definition cross-reference to S00
V.1–V.11` below for the explicit mapping.

## Surfaces touched

Backend:

- `saivage-v3/src/cards/notes.ts` — file deleted.
- `saivage-v3/src/schemas/types.ts` — `NoteRecord`, `NotesQueue`,
  `NotesQueueEntry`, `NotesQueueResolvedEntry`, and any
  `NotificationRecord` field that referenced
  `payload_summary`/`related_note_id`/`severity`/`acknowledged_at`/
  `delivered_at` are deleted. The new in-memory
  `NotificationQueueEntry` interface is declared in
  `saivage-v3/src/notifications/notification-center.ts` (not in
  `schemas/`) because the queue entry is a runtime-only shape and
  is never persisted.
- `saivage-v3/src/schemas/validators.ts` — `noteRecordSchema`,
  `notesQueueEntrySchema`, `notesQueueSchema`, and
  `notificationRecordSchema` are deleted. The
  `notification_record_appended` event schema in
  `saivage-v3/src/events/registry.ts` (line 63) is deleted along
  with the kind.
- `saivage-v3/src/schemas/index.ts` — re-exports of the deleted
  symbols are removed (lines around 47-49 and the
  `notificationRecordSchema` export from validators).
- `saivage-v3/src/persistence/file-tree.ts` — `defaultNotesQueue`,
  the `notesQueueSchema` import, the `isValidJsonFile` check on
  `notes/queue.json`, and the `writeFileAtomic(... 'notes',
  'queue.json' ...)` seed are deleted.
- `saivage-v3/src/notifications/notification-center.ts` — rewritten
  to back an in-memory `Map<string, NotificationQueueEntry[]>`. All
  durable-record methods (`acknowledge`, `acknowledgeForOperator`,
  `listForOperator`, `classifyForSession`,
  `listUnacknowledgedBlockingForSession`,
  `hasBlockingPendingForSession`, `markDeliveredForSession`) are
  deleted.
- `saivage-v3/src/notifications/notification-triggers.ts` — the four
  per-producer wrappers are deleted; the helpers
  `findAffectedActiveSessionsForCard`, `getActiveSessions`,
  `buildAncestorScope`, `redactNotificationSummary`,
  `sessionIsAffectedByCardChange`, and `makeNotificationId` are
  kept where used by the new single producer. `makeNotificationId`
  is deleted (queue entries have no id).
- `saivage-v3/src/notifications/notification-delivery.ts` —
  `enqueueForOperator` is removed; `enqueueForSession` is renamed
  `enqueue(sessionId, entry)` taking
  `NotificationQueueEntry` rather than the legacy
  `NotificationInput`.
- `saivage-v3/src/notifications/index.ts` — barrel re-exports
  narrowed to `NotificationCenter`, `queueNotification`,
  `NotificationDeliveryAdapter`, `NotificationQueueEntry`. The
  removed names
  (`enqueueCardMutationNotifications`,
  `enqueueNoteNotifications`,
  `enqueueProcessReconciliationNotification`,
  `enqueueRuntimeStateNotifications`,
  `NotificationInput`, `NotificationOwnership`) are no longer
  exported.
- `saivage-v3/src/projections/ledger-projections.ts` —
  `notificationLedger` factory and the
  `notification_record_appended` projection class are removed.
- `saivage-v3/src/events/registry.ts` — the entries for
  `notification_record_appended` and `notification_acknowledged`
  are removed. The `notification_added` entry stays; its payload
  schema narrows to `{ session_id: z.string().nullable(), kind:
  z.string() }`.
- `saivage-v3/src/server/websocket.ts` — the `case
  'notification_acknowledged':` arm is removed (lines 302-303
  drop to a single `case 'notification_added':` arm). The
  broadcaster forwards only `{ session_id, kind }` (no
  `payload_summary`, no `related_card_id` content), in line with
  SPEC-r7 "no second notification-reading surface".
- `saivage-v3/src/contracts/operator-events.ts` — the typed
  operator/analyst activity event contract is thinned in lockstep
  with the runtime registry edits in `src/events/registry.ts`.
  Concretely: the literal `'notification_acknowledged'` is removed
  from `AnalystActivityEventNames` (line 111); the
  `NotificationAcknowledgedContentSchema` declaration is deleted
  in full (lines 137-145) and its entry in the
  `AnalystActivityContentSchema` `z.discriminatedUnion(...)` array
  is removed (line 181); the `NotificationAddedContentSchema`
  declaration (lines 125-134) is replaced with the narrowed shape
  `z.object({ event: z.literal('notification_added'), session_id:
  z.string().nullable(), kind: z.string().min(1) }).passthrough()`,
  dropping `id`, `severity`, `related_card_id`, `related_note_id`,
  `related_process_id`, `related_version_seq`, and `created_at`,
  per the Q3 resolution that the websocket hint surfaces only
  `{ session_id, kind }`. `related_note_id` in
  `AnalystToolInvokedContentSchema` (line 167) is not edited by
  S04 because it is a tool-invocation field rather than a
  notification surface; if it becomes orphaned after S06's web
  cleanup it falls under that stage's mandate.
- `saivage-v3/src/contracts/index.ts` lines 98-99 — the barrel
  re-export of `NotificationAcknowledgedContentSchema` is removed.
  The `NotificationAddedContentSchema` re-export stays (it now
  points at the narrowed schema).
- `saivage-v3/src/cards/card-store.ts` line 691 — the
  `enqueueCardMutationNotifications` call is replaced by a single
  `queueNotification(...)` call against the
  `{ kind: 'card', cardId }` recipient.
- `saivage-v3/src/runtime/control.ts` lines 71 and 123 —
  `enqueueRuntimeStateNotifications` calls become
  `queueNotification(...)` against `{ kind: 'role', role:
  'planner' }`.
- `saivage-v3/src/runtime/process-runner.ts` line 787 —
  `enqueueProcessReconciliationNotification` call becomes
  `queueNotification(...)` against the
  `{ kind: 'session', sessionId }` recipient when the session id
  is non-null; otherwise no notification is queued.
- `saivage-v3/src/runtime/runtime.ts` lines 437-454 — the
  `buildBlockingNotificationInstruction` helper, the
  `hasBlockingPendingForSession` check, and the
  `listUnacknowledgedBlockingForSession` follow-up block are
  deleted. The runtime no longer has a "blocking notification"
  concept.
- `saivage-v3/src/agents/agent-adapter.ts` —
  `formatNotificationGuidance` and
  `buildNotificationInjectionMessage` are simplified to surface
  only `kind` and `body`; `buildModelMessages` no longer carries a
  `drainedIds` return because there is no follow-up delivery
  marker. The blocking-hold branch around line 419 and the
  `buildBlockingNotificationHoldMessage` flow are deleted. The
  `markDeliveredForSession` call around line 507 is removed.
  Adds `tool('queue_notification', ...)` to
  `PLANNER_TOOL_DEFINITIONS` and `'queue_notification'` to
  `PLANNER_CONTROL_TOOL_NAMES`.
- `saivage-v3/src/agents/analyst-tools.ts` — `queue_notification`
  body becomes the real producer call wrapped in
  `runAuditedAnalystTool`. The S02 stub returning
  `{ success: false, data: { reason: 'not_yet_available',
  stage_owner: 'S04' } }` is deleted.
- `saivage-v3/src/agents/analyst-tool-schemas.ts` — the
  `queue_notification` schema slot is unchanged (S02 declares the
  final shape `recipient`/`kind`/`body`); only the
  `not_yet_available` marker is removed from the implementation
  side.
- `saivage-v3/src/agents/analyst-llm-resolver.ts` — the dispatch
  table already includes `queue_notification: queue_notification`
  from S02; no change beyond ensuring the import resolves to the
  new implementation.
- `saivage-v3/src/agents/planner-control-executor.ts` lines 131-152
  — add `case 'queue_notification':` arm per the S03 precedent.
- `saivage-v3/src/agents/role-tool-policy.ts` —
  `'queue_notification'` is added to the `planner` and `analyst`
  role rows; `'add_note'`, `'list_notes'`, `'get_note'`, and
  `'mark_note_handled'` are removed from every role row.
- `saivage-v3/src/tools/agent-tools.ts` — `add_note`,
  `list_notes`, `get_note`, `mark_note_handled` tool registrations
  and their imports/inputs are removed.
- `saivage-v3/src/tools/planner-tools.ts` — adds
  `queueNotification(recipient, kind, body, ctx)` service method.
- `saivage-v3/src/server/routes/runtime-config-notes.ts` — the
  `/api/notifications` GET and `/api/notifications/:id/acknowledge`
  POST handlers and the `NotificationCenter` import/instantiation
  are removed. The file's remaining handlers (runtime config and
  control-actions) are untouched.
- `saivage-v3/src/server/server.ts` — the operator startup
  notification at line 124
  (`createNotificationDeliveryService(...).enqueueForOperator(...)`)
  is removed; the
  `setProjectNotificationDeliveryAdapters` /
  `clearProjectNotificationDeliveryAdapters` calls and the
  Telegram readiness check are kept but the delivery adapter is
  updated to the new `NotificationQueueEntry` contract.
- `saivage-v3/src/telegram/index.ts` — the
  `TelegramNotificationDeliveryAdapter.deliver` signature narrows
  from `NotificationRecord` to `NotificationQueueEntry`; the
  formatter loses fields that no longer exist
  (`payload_summary`, `severity`, `related_*`). The Telegram
  message body is constructed from `{ kind, body }` only.

Frontend (S04 declares forecasts; no S04-owned edits):

- `saivage-v3/web/src/components/cards/NotificationsPanel.vue` and
  its `NotificationsPanel.test.ts`: forecasted to S06.
- `saivage-v3/web/src/__tests__/stale-warning-ribbon.test.ts`:
  forecasted to S06 (the `notification_acknowledged` ws event is
  gone after S04).
- `saivage-v3/web/src/__tests__/operator-dashboard-smoke.test.ts`:
  forecasted to S06 (the test mocks
  `listNotifications`/`acknowledgeNotification`).
- `saivage-v3/web/src/api/client.ts` `listNotifications` and
  `acknowledgeNotification` exports, and the
  `NotificationsListResponse`/`NotificationAcknowledgeResponse`
  types in `saivage-v3/web/src/api/types.ts`: forecasted to S06
  (the web client mutation pruning is S06's mandate per
  MASTER-PLAN §S06 acceptance).

Tests (backend, S04-owned):

- Rewrites in `saivage-v3/tests/notifications.test.ts` (existing
  file, to be repurposed): assert queue-and-drain round-trip,
  retraction follow-up, ephemerality (drained entries are not
  recoverable), bounded retention drop.
- New `saivage-v3/tests/analyst.test.ts` cases covering analyst
  `queue_notification` happy path, `unknown_recipient` C1, audit
  entry presence with `actor='analyst'` and the calling surface,
  and audit entry absence of the `body` field.
- New `saivage-v3/tests/integration/queue-notification-roundtrip.test.ts`
  asserting: queue at the producer side, run one agent turn, find
  the kind+body strings in the receiving session transcript, and
  assert a second drain returns nothing.
- Deletions: every test asserting against
  `noteRecordSchema`-backed records, the
  `.saivage/notes/queue.json` seed, the
  `add_note`/`list_notes`/`get_note`/`mark_note_handled` tool
  surface, `acknowledge`-based blocking semantics, or the
  `/api/notifications` operator route is deleted (not skipped)
  with a corresponding baseline update.

## Test plan

Unit:

- `NotificationCenter.enqueue` appends to the queue keyed by
  `sessionId` in FIFO order.
- `NotificationCenter.drainPendingForSession` returns the queued
  entries in FIFO order and empties the recipient's queue; a
  second call against the same session returns `[]`.
- `NotificationCenter.enqueue` honours `MAX_PENDING = 64`: the
  65th enqueue drops the oldest entry and emits one
  `notifications_overflow_dropped` event.
- `queueNotification` with `{ kind: 'card', cardId }` resolves to
  the set of session ids returned by
  `findAffectedActiveSessionsForCard`.
- `queueNotification` with `{ kind: 'role', role }` resolves to
  the set of session ids whose `role` matches.
- `queueNotification` with `{ kind: 'session', sessionId }` queues
  exactly one entry against that session id.
- `resolveRecipient` returns `null` for an unknown recipient
  string.
- `queue_notification` analyst tool returns
  `{ success: true, data: { queued: true, recipient } }` on the
  happy path and
  `{ success: false, data: { reason: 'unknown_recipient',
  recipient } }` on a missing recipient.

Integration:

- Queue-and-deliver round-trip: producer queues; receiving session
  drains as part of `buildModelMessages`; the kind and body strings
  appear in the receiving session transcript exactly once; the
  drained entry is not retrievable on a second call.
- Retraction follow-up: producer queues `kind='card_changed'`
  followed by `kind='retraction'` against the same session; both
  appear in the transcript in FIFO order; the SPEC's
  retract-by-follow-up semantics are satisfied without any
  `markDeliveredForSession` or `acknowledge` step.
- Audit: invoking `queue_notification` from the analyst surface
  appends a `ControlActionAuditEntry` with `actor='analyst'`,
  `surface=<call-site>`, `action='notification.queue'`,
  `target_kind='notification_recipient'`,
  `target_id=<recipient>`, and an
  `outcome_summary` that does NOT contain the body string.
- Planner-control audit: planner-control dispatching
  `queue_notification` appends an entry with `actor='planner'` and
  `surface='runtime'`.
- Ephemeral on-disk check: after the test scenarios above run, the
  paths `.saivage/runtime/notifications/by-session/*.jsonl`,
  `.saivage/runtime/notifications/operator.jsonl`, and
  `.saivage/notes/queue.json` do not exist on disk.

E2E:

- The S02-forecast `analyst-e2e:scenario-queue-notification:step-1`
  flips green: the analyst issues `queue_notification(recipient,
  kind, body)`, the backend queues, and the e2e checker observes
  the kind+body strings in the receiving session transcript.

Gates:

- The four S00 gates (`tsc-build`, `web-vite-build`, `web-vitest`,
  `analyst-e2e`) run via
  `bash SPEC/analyst-as-control-surface/PLAN/scripts/run-gates.sh
  --diff SPEC/analyst-as-control-surface/PLAN/baseline-gates.json`
  from `saivage-v3/`. Expected diffs are limited to the four
  S06-forecast entries below plus the
  S02 close-out (`analyst-e2e:scenario-queue-notification:step-1`
  transitions from FAILING to PASSING); everything else stays at
  the baseline.

## Expected breakage forecast

Each H3 below is the verbatim block S04's close-out will append to
`SPEC/analyst-as-control-surface/PLAN/expected-breakage-ledger.md`
for any gate failure that S04 intentionally does not fix. The
`<YYYY-MM-DD>` placeholder is replaced with the actual UTC date at
S04 close-out time.

### web-vitest:scenario-notifications-panel:step-1

Failure mode: vitest mount of NotificationsPanel.vue calls listNotifications and acknowledgeNotification against routes deleted by S04, so the panel test fails on a mocked-route 404 plus an unmocked client method.
Reason acceptable now: S04 removes the durable notification surface and the operator HTTP routes that exposed it; the operator UI panel and its API client helpers are owned by S06 per MASTER-PLAN §S04 acceptance line "UI-side note-inbox panels are removed by S06/S09".
Target fix stage: S06
Recorded by: S04 / <YYYY-MM-DD>

### web-vitest:scenario-stale-warning-ribbon:step-1

Failure mode: the stale-warning-ribbon test emits notification_acknowledged ws events to assert ribbon clearance, but S04 removes the notification_acknowledged event kind and its websocket arm, so the emit is silently ignored and the ribbon never clears.
Reason acceptable now: S04 removes the acknowledge surface entirely per SPEC-r7 "no per-notification acknowledge action"; the ribbon's clearance behaviour is owned by S06 along with the UI mutation removal.
Target fix stage: S06
Recorded by: S04 / <YYYY-MM-DD>

### web-vitest:scenario-operator-dashboard-smoke:step-1

Failure mode: the operator-dashboard smoke test mocks listNotifications and acknowledgeNotification, both of which are no longer exported by the api client wrapper used by the dashboard, so the test setup fails before the dashboard mounts.
Reason acceptable now: S04 removes the operator notification routes and forecasts the web client helper removal to S06 per MASTER-PLAN §S06 web-client mutation pruning.
Target fix stage: S06
Recorded by: S04 / <YYYY-MM-DD>

### web-vitest:scenario-operator-events-contract:step-1

Failure mode: web vitest suites that import `NotificationAcknowledgedContentSchema` (deleted in S04) or that emit synthetic activity envelopes shaped against the pre-S04 `NotificationAddedContentSchema` (with `id`, `severity`, `related_card_id`, `related_note_id`, `related_process_id`, `related_version_seq`, `created_at`) fail at `parseKnownWsContent` validation because the discriminated union no longer accepts those shapes. Concrete known consumers: `web/src/__tests__/notifications-panel.test.ts`, `web/src/__tests__/stale-warning-ribbon.test.ts`, and the `web/src/stores/{debug,cards,analystChat}.ts` listeners that read `related_card_id`.
Reason acceptable now: S04 thins the typed operator/analyst activity event contract to match the SPEC-r7 "no second notification-reading surface" rule and the narrowed websocket payload; the web stores and tests that still consume the rich payload are owned by S06 along with `NotificationsPanel.vue` and the `notification_acknowledged` ribbon clearance path.
Target fix stage: S06
Recorded by: S04 / <YYYY-MM-DD>

## Downstream impact

Per MASTER-PLAN §6.1, the following consumers are affected by S04's
contract changes; S04 either fixes the consumer in this stage or
records the gap as a forecast entry above.

- Planner / executor / reviewer note producers
  (`add_note`-driven flows in
  `saivage-v3/src/cards/notes.ts` and the corresponding
  `agent-tools.ts` registrations): deleted in S04.
- `saivage-v3/src/notifications/*`: rewritten in S04.
- `saivage-v3/src/projections/ledger-projections.ts`
  (`notificationLedger` and its projection class): deleted in
  S04.
- `saivage-v3/src/persistence/file-tree.ts` (`defaultNotesQueue`
  and the `.saivage/notes/queue.json` seed): deleted in S04.
- `saivage-v3/src/workspace/write-territories.ts`: audited;
  no notes-specific territory is currently registered, so no edit
  is required. If a territory naming the `.saivage/notes/`
  directory appears during implementation, S04 deletes it.
- `saivage-v3/src/schemas/*`: deleted entries listed in
  `## Surfaces touched > Backend`.
- Runtime-state schema: no field referenced notifications outside
  the event-bus shape; the `notification_record_appended` and
  `notification_acknowledged` event-bus entries are removed in
  S04.
- On-disk persistence: durable notification records and the
  legacy notes queue are removed. Pre-S04 `.saivage/` state is
  invalidated; `saivage init` rebuilds the project tree without
  the legacy directories. Architecture-first applies: there is no
  migration shim.
- Operator notes API: deleted in S04. The operator API contract
  file `saivage-v3/src/contracts/operator-api.ts` currently has
  zero notification-named entries; S04 pins this with a Phase H
  zero-hit guard (`grep -nE 'notification' src/contracts/operator-api.ts`
  yields zero matches). S07 separately prunes the remaining
  mutating routes in that contract.
- Tests and skill files that read the legacy note store: deleted
  in S04 with a baseline-snapshot update; no skipped tests.
- Debug-view widgets that listed notes
  (`saivage-v3/web/src/views/DebugView.vue` per MASTER-PLAN §S04
  Likely downstream impact): owned by S06; S04 does not touch the
  view.

## Done-definition cross-reference to S00 V.1–V.11

S00's validation cookbook V.1–V.11 are the canonical close-out
checklist. S04's close-out runs them in this mapping:

- V.1 (baseline present): unchanged; S04 reads
  `PLAN/baseline-gates.json` without modifying it.
- V.2 (gates green or forecasted): four gates run via
  `PLAN/scripts/run-gates.sh --diff PLAN/baseline-gates.json`;
  the only allowed diff entries are the four H3 forecasts above
  plus the S02 close-out
  (`analyst-e2e:scenario-queue-notification:step-1` transitions
  from FAILING to PASSING).
- V.3 (autonomy anchors absent): S04's close-out runs the writer
  autonomy grep against this stage's `design.md` and `plan.md`
  using `PLAN/forbidden-anchors.txt`; zero hits required.
- V.4 (host-path guard): the host-path grep returns zero hits;
  every host-relative path in both drafted files is rooted at
  `saivage-v3/...`.
- V.5 (emoji absent): zero unicode emoji codepoints in either
  drafted file.
- V.6 (cumulative ledger format): the four H3 entries follow the
  shape declared in
  `PLAN/expected-breakage-ledger.md` `## Entry shape`
  (`### <failing-id>` plus four named lines), with
  `Target fix stage` strictly in `{S05..S10}`.
- V.7 (ledger entry closure): the S04 close-out deletes the H3
  block `### analyst-e2e:scenario-queue-notification:step-1` from
  `PLAN/expected-breakage-ledger.md` only if all three conditions
  hold at close-out time:
  (1) the cumulative ledger currently contains that exact H3,
  (2) its `Target fix stage` line reads `S04`,
  (3) the fresh gate diff under `--diff PLAN/baseline-gates.json`
  no longer observes that failure. If any condition fails, S04
  proceeds without closing the entry and does not fabricate it.
  The cumulative ledger may be empty when S04 starts.
- V.8 (stage dir name): the publish step uses the literal stage
  dir name `004-notifications-queue-ephemeral` matching the
  protocol regex.
- V.9 (atomic publication): per PROTOCOL-r4, the directory
  rename from `drafts/` to `stages/` is the publication act; no
  in-place edits to a published stage.
- V.10 (singular baseline path): no per-stage baseline file is
  created; the only baseline is `PLAN/baseline-gates.json`.
- V.11 (immutability of predecessors): S04 reads S00, S01, S02,
  S03 stage artifacts but never modifies them.
