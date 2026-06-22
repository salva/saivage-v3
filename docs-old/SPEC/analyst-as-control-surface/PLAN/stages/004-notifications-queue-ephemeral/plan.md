# S04 — Notifications: queue-only, ephemeral, single producer — Plan

Working directory for every shell command in this file is
`/home/salva/g/ml/saivage-v3`. Paths in this plan are relative to that
directory unless they start with `SPEC/analyst-as-control-surface/`.

## Phase A — Prep and inventory

A.1 Read [design.md](./design.md) end-to-end and confirm
`## Surfaces touched > Backend` enumerates every file this plan
edits or deletes.

A.2 Confirm the S00 gate harness is in place: `test -x
SPEC/analyst-as-control-surface/PLAN/scripts/run-gates.sh && test -f
SPEC/analyst-as-control-surface/PLAN/baseline-gates.json`.

A.3 Confirm the S02 stub and helper are in the working tree:
`grep -n "queue_notification" src/agents/analyst-tools.ts` returns a
hit, and `grep -n "runAuditedAnalystTool" src/agents/analyst-tool-runner.ts`
returns a hit. If either grep is empty, abort the stage and record a
follow-up note for the metaplan owner; do not attempt an in-stage
recovery.

A.4 Confirm S02's analyst-tool schema slot for `queue_notification`
is final: `grep -n "queue_notification" src/agents/analyst-tool-schemas.ts`
returns a hit and the schema declares
`recipient: string, kind: string, body: string`.

A.5 Capture a fresh pre-edit gate run to confirm the working tree
matches the baseline:
`bash SPEC/analyst-as-control-surface/PLAN/scripts/run-gates.sh
--diff SPEC/analyst-as-control-surface/PLAN/baseline-gates.json > tmp/s04-pre.txt`.
Exit code 0 means no unexpected drift. Non-zero indicates either a
predecessor regression or an unrecorded forecast entry; in either
case, stop and surface to the metaplan owner before continuing.

A.6 Read [expected-breakage-ledger.md](../../expected-breakage-ledger.md)
once. Record locally (in a scratch file, not in the repo) whether
the H3 block `### analyst-e2e:scenario-queue-notification:step-1`
exists and whether its `Target fix stage` line reads `S04`. Phase H
re-reads this state before close-out.

A.7 Verify the S03 stage dir publication is complete:
`test -d SPEC/analyst-as-control-surface/PLAN/stages/003-ordered-children-and-bounded-move`
returns success. S04 does not consume S03 logic but does inherit the
S03 plan template structure; if S03 has not been published, halt and
surface to the metaplan owner.

A.8 Create `tmp/s04/` for in-progress notes and grep snapshots.

## Phase B — Schema and persistence cleanup

B.1 Delete from `src/schemas/types.ts`: `NoteRecord` (line 74),
`NotesQueueEntry` (line 76), `NotesQueueResolvedEntry` (line 77),
and `NotesQueue` (line 75). Re-run `npx tsc -p tsconfig.json
--noEmit` and confirm every resulting error names a file slated for
edit in this plan.

B.2 Delete from `src/schemas/validators.ts`: `noteRecordSchema`
(line 38), `notesQueueEntrySchema`, `notesQueueSchema`. Remove the
`NotificationRecord`-related schema fields no longer used after
this stage: `payload_summary`, `severity`, `related_*`, `delivered_at`,
`acknowledged_at`. The remaining `notificationRecordSchema`
declaration is deleted in full; the in-memory queue entry lives in
`src/notifications/notification-center.ts`.

B.3 Update `src/schemas/index.ts`: remove the re-exports of the
deleted symbols around line 48.

B.4 Update `src/persistence/file-tree.ts`: remove the `notesQueueSchema`
import (line 7); remove the `defaultNotesQueue` helper (line 69);
remove the `'notes'/'queue.json'` validation arm inside
`isValidJsonFile` (line 123); remove the
`writeFileAtomic(join(saivageDir, 'notes', 'queue.json'), ...)`
seed call (line 154). The `'notes'` directory creation in
`ensureProjectTreeAt` (the same file) is also removed.

B.5 Remove the `notification_record_appended` and
`notification_acknowledged` entries from
`src/events/registry.ts` (line 63 and its sibling). The
`notification_added` entry stays, with its payload schema narrowed
to `{ session_id: z.string().nullable(), kind: z.string() }`.

B.6 Remove the `notificationLedger` factory and its projection
class from `src/projections/ledger-projections.ts` (lines 44-87).
Remove imports that become unused after that deletion.

B.7 Re-run `npx tsc -p tsconfig.json --noEmit`. The remaining
errors should be confined to:
`src/notifications/`, `src/agents/agent-adapter.ts`,
`src/agents/planner-control-executor.ts`,
`src/agents/analyst-tools.ts`, `src/agents/role-tool-policy.ts`,
`src/cards/card-store.ts`, `src/cards/notes.ts`,
`src/runtime/control.ts`, `src/runtime/process-runner.ts`,
`src/runtime/runtime.ts`, `src/server/routes/runtime-config-notes.ts`,
`src/server/server.ts`, `src/server/websocket.ts`,
`src/telegram/index.ts`, `src/tools/agent-tools.ts`,
`src/tools/planner-tools.ts`. Any error outside this set indicates
a missed surface in `design.md`; pause and update the design before
continuing.

## Phase C — Notification center, producer, and delivery rewrite

C.1 Rewrite `src/notifications/notification-center.ts`. The new
shape:

- Private `queues: Map<string, NotificationQueueEntry[]>`.
- `enqueue(sessionId: string, entry: NotificationQueueEntry): void`
  appends with `MAX_PENDING = 64` overflow drop semantics; emits
  one `notifications_overflow_dropped` log line on drop (no
  durable event).
- `drainPendingForSession(sessionId: string):
  NotificationQueueEntry[]` removes the recipient's array atomically
  and returns it in FIFO order.
- `queueLengthForSession(sessionId: string): number` is exposed only
  for tests in `src/notifications/notification-center.ts` and is
  not re-exported from the barrel.
- No `acknowledge`, no `markDelivered`, no `listForOperator`,
  no `classifyForSession`, no `hasBlockingPendingForSession`,
  no `listUnacknowledgedBlockingForSession`, no
  `notificationsRoot`/`sessionNotificationsPath`/`operatorNotificationsPath`.

C.2 Rewrite `src/notifications/notification-triggers.ts`. Export
exactly:

- `queueNotification(projectRoot, recipient, kind, body, source): void`
- `resolveRecipient(projectRoot, recipientLiteral): Recipient | null`

Keep the internal helpers `findAffectedActiveSessionsForCard`,
`getActiveSessions`, `buildAncestorScope`,
`sessionIsAffectedByCardChange` where the new producer uses them.
Delete `enqueueCardMutationNotifications`,
`enqueueNoteNotifications`,
`enqueueRuntimeStateNotifications`,
`enqueueProcessReconciliationNotification`,
`enqueueProcessKillNotifications`, `redactNotificationSummary`,
`makeNotificationId`.

C.3 Update `src/notifications/notification-delivery.ts`:
`NotificationDeliveryService.enqueueForSession` becomes
`enqueue(sessionId, entry)`. Delete `enqueueForOperator`. Update
`NotificationDeliveryAdapter.deliver(entry, context)` signature to
`NotificationQueueEntry`.

C.4 Update `src/notifications/index.ts` barrel: re-export only
`NotificationCenter`, `NotificationDeliveryService`,
`NotificationDeliveryAdapter`, `NotificationQueueEntry`,
`queueNotification`, `resolveRecipient`,
`setProjectNotificationDeliveryAdapters`,
`clearProjectNotificationDeliveryAdapters`.

C.5 Update `src/telegram/index.ts`
`TelegramNotificationDeliveryAdapter.deliver` to accept
`NotificationQueueEntry`. The formatted Telegram message reads
`[<kind>] <body>` only; no `payload_summary`, no `severity`, no
`related_*`.

C.6 Run `npx tsc -p tsconfig.json --noEmit` and confirm errors are
now confined to the call-site files listed in Phase D, plus the
`src/agents/agent-adapter.ts` injection helpers (cleaned in Phase D).

## Phase D — Producer call sites and tool surface

D.1 Update `src/cards/card-store.ts` line 691: replace the
`enqueueCardMutationNotifications` call with a single
`queueNotification(this.projectRoot, { kind: 'card', cardId:
persisted.id }, 'card_changed', <summary>, { actor: ctx.actor,
surface: ctx.surface })`. Remove the now-unused import of the
deleted wrapper.

D.2 Update `src/runtime/control.ts` lines 71 and 123: replace
`enqueueRuntimeStateNotifications` with `queueNotification`
against `{ kind: 'role', role: 'planner' }`. Remove the wrapper
import.

D.3 Update `src/runtime/process-runner.ts` line 787: replace
`enqueueProcessReconciliationNotification` with `queueNotification`
against `{ kind: 'session', sessionId: <agent_session_id> }` when
the session id is non-null. If the session id is null, queue
nothing.

D.4 Delete `src/cards/notes.ts` entirely. Remove all references in
`src/index.ts`, in `src/agents/agent-adapter.ts` (the
`notification.guidance` clause that called
`list_notes`/`get_note`), and in any module that imported
`NotesQueue` / `NoteRecord` / `addNote` / `getNotes` / `getUnhandledNotes`
/ `markNoteHandled` / `parseNoteLines` / `writeAllNotes`. Run
`grep -RIn "src/cards/notes" src/ tests/ web/src/` and confirm
zero hits.

D.5 Update `src/tools/agent-tools.ts`: remove the imports
(`add_note`, `list_notes`, `get_note`, `mark_note_handled`) on
lines 5-17 and 15; remove the `addNoteInput`, `listNotesInput`,
`getNoteInput`, `markNoteHandledInput` declarations on lines
97-106; remove the four `tool({...})` registrations on lines 115
and 122-124.

D.6 Update `src/agents/role-tool-policy.ts`:

- Remove `'add_note'` from the `planner` row.
- Remove `'list_notes'`, `'get_note'`, `'mark_note_handled'` from
  the `executor`, `reviewer`, and `analyst` rows.
- Add `'queue_notification'` to the `planner` and `analyst` rows.

D.7 Update `src/agents/analyst-tools.ts` `queue_notification`:
replace the S02 stub body with the audited producer call (see
`design.md` `## Approach > Analyst tool surface` for the verbatim
shape). The handler returns
`{ success: true, data: { queued: true, recipient } }` on the happy
path and `{ success: false, data: { reason: 'unknown_recipient',
recipient } }` on a missing recipient. Audit metadata records
`{ recipient, kind }` only.

D.8 Update `src/agents/analyst-tool-schemas.ts`: remove any
inline comment text marking the schema slot as "until S04 lands"
or "not_yet_available" if present; the schema shape itself is
unchanged.

D.9 Update `src/agents/agent-adapter.ts` `PLANNER_TOOL_DEFINITIONS`
(around lines 97-126): append a single `tool('queue_notification',
...)` entry per `design.md` `## Approach > Planner-control surface`.

D.10 Update `src/agents/agent-adapter.ts` `PLANNER_CONTROL_TOOL_NAMES`
(around lines 127-135): add `'queue_notification'`.

D.11 Update `src/agents/planner-control-executor.ts` `execute()`
switch (around lines 131-152): add a `case 'queue_notification':`
arm per `design.md` `## Approach > Planner-control surface`. The
literal `surface: 'runtime'` is set at this dispatch site.

D.12 Update `src/tools/planner-tools.ts`: add a
`queueNotification(recipient, kind, body, ctx)` service method that
calls the internal producer plus
`recordControlAction(this.projectRoot, { actor: 'planner', surface:
'runtime', action: 'notification.queue', target_kind:
'notification_recipient', target_id: <resolved-id>,
outcome: 'ok', outcome_summary: <kind only> })`. Body is not
recorded.

D.13 Update `src/agents/agent-adapter.ts`:

- Simplify `formatNotificationGuidance(entry)` to render
  `- [${entry.kind}] ${entry.body}` only. No
  `list_notes`/`get_note` hint.
- Simplify `buildNotificationInjectionMessage(entries, sessionId)`
  similarly.
- Drop `buildBlockingNotificationInstruction`,
  `buildBlockingNotificationHoldMessage`, and every call site of
  `hasBlockingPendingForSession`,
  `listUnacknowledgedBlockingForSession`, and
  `markDeliveredForSession`. The injection loop near line 503
  collapses to a single
  `notificationCenter.drainPendingForSession(session.id)` call;
  there is no follow-up `markDeliveredForSession` call.
- Remove the dead `model_issue` message at line 560 that announced
  blocked-on-acknowledge.

D.14 Update `src/runtime/runtime.ts`: remove lines 437-454
(`buildBlockingNotificationInstruction` and its
`hasBlockingPendingForSession` / `listUnacknowledgedBlockingForSession`
callers). Confirm no other runtime path refers to the blocking
concept.

## Phase E — Operator API and websocket

E.1 In `src/server/routes/runtime-config-notes.ts` lines 148-170:
delete the `fastify.get('/api/notifications', ...)` handler and the
`fastify.post('/api/notifications/:id/acknowledge', ...)` handler.
Remove the `NotificationCenter` import and instantiation that
backed them. The remaining handlers (runtime config and
control-actions) are untouched.

E.2 In `src/server/websocket.ts` lines 302-303: remove the
`case 'notification_acknowledged':` arm. The
`case 'notification_added':` arm stays; broadcast only
`{ session_id, kind }`.

E.3 In `src/server/server.ts` line 124: delete the
`createNotificationDeliveryService(projectRoot, []).enqueueForOperator(...)`
operator-startup notification. Keep
`setProjectNotificationDeliveryAdapters` and Telegram adapter
wiring (still useful for the Telegram side-channel; not a platform
read surface).

E.4 Run `npx tsc -p tsconfig.json --noEmit`. Errors should be zero.

E.5 Run `node --test --import tsx tests/notifications.test.ts`
once to surface the test failures that Phase F repairs.

E.6 Edit `src/contracts/operator-events.ts` line 111: remove the
literal `'notification_acknowledged'` from the
`AnalystActivityEventNames` tuple. After the edit the tuple
contains six entries (`card_history_appended`,
`notification_added`, `control_action_recorded`,
`analyst_tool_invoked`, `tool_invocation`).

E.7 Edit `src/contracts/operator-events.ts` lines 125-134: replace
the existing `NotificationAddedContentSchema` declaration with the
narrowed shape

```
export const NotificationAddedContentSchema = z.object({
  event: z.literal('notification_added'),
  session_id: z.string().nullable(),
  kind: z.string().min(1),
}).passthrough();
```

so the typed contract matches the narrowed runtime event shape from
Phase B.5 and the narrowed websocket payload from Phase E.2. Drop
the `id`, `severity`, `related_card_id`, `related_note_id`,
`related_process_id`, `related_version_seq`, and `created_at`
fields. Do not edit `related_note_id` on
`AnalystToolInvokedContentSchema` (line 167); that field is a
tool-invocation reference, not a notification surface, and is out
of S04 scope.

E.8 Edit `src/contracts/operator-events.ts` lines 137-145: delete
the entire `NotificationAcknowledgedContentSchema` declaration. Then
in the `AnalystActivityContentSchema` `z.discriminatedUnion('event',
[...])` array (line 181) remove the
`NotificationAcknowledgedContentSchema` entry. After the edit the
union has five members; the line that previously held
`NotificationAcknowledgedContentSchema,` is gone.

E.9 Edit `src/contracts/index.ts` lines 98-99: remove the
`NotificationAcknowledgedContentSchema` re-export. Keep the
`NotificationAddedContentSchema` re-export (it now points at the
narrowed schema). Re-run `npx tsc -p tsconfig.json --noEmit` and
confirm errors are confined to the call-site files already named in
Phase D, plus any web-side files forecasted to S06.

## Phase F — Tests

F.1 Replace `tests/notifications.test.ts` with the new queue
tests: enqueue/drain FIFO, drain-and-vanish, overflow drop,
recipient resolution (`card` / `role` / `session`),
`resolveRecipient` returning null.

F.2 Add a new `tests/integration/queue-notification-roundtrip.test.ts`
that spins up a `NotificationCenter` plus a test agent-session
adapter, queues from the producer side, drains via
`buildModelMessages`, asserts the kind+body strings appear in the
receiving session transcript exactly once, and asserts a second
drain returns nothing.

F.3 Update `tests/analyst.test.ts`: remove every
`add_note`/`list_notes`/`get_note`/`mark_note_handled` case (S02
already started this; confirm done). Add:

- happy-path `queue_notification` returning `{ success: true,
  data: { queued: true, recipient } }`.
- `unknown_recipient` C1 path.
- audit-entry presence with `actor='analyst'`,
  `surface=<surface>`,
  `action='notification.queue'`, `target_id=<recipient>`.
- audit-entry absence of the body string in
  `outcome_summary`.

F.4 Add a planner-control test in
`tests/planner-control.test.ts` exercising the
`queue_notification` dispatch arm: asserts the
`ControlActionAuditEntry` row carries `actor='planner'` and
`surface='runtime'`.

F.5 Delete every test asserting against the
`/api/notifications` GET and POST routes
(`tests/server/notifications-routes.test.ts` if present), and any
test asserting the legacy `acknowledge`/`listForOperator` flow.

F.6 Delete tests that read `.saivage/notes/queue.json` or the
deleted `addNote`/`getNotes` helpers.

F.7 Add an ephemeral on-disk assertion in
`tests/integration/queue-notification-roundtrip.test.ts`:
after the scenario, the paths
`.saivage/runtime/notifications/by-session/`,
`.saivage/runtime/notifications/operator.jsonl`, and
`.saivage/notes/` do not exist (or are absent of files matching
the legacy schema).

F.8 Run `npx vitest run` and `node --test --import tsx tests/`
(the project's existing test entry points). Backend tests pass;
web tests show the four forecasted vitest failures and nothing
else.

F.9 Re-confirm the analyst-e2e harness:
`bash SPEC/analyst-as-control-surface/PLAN/scripts/run-gates.sh`
shows `analyst-e2e:scenario-queue-notification:step-1` flips from
FAILING to PASSING.

## Phase G — Gate diff and forecast registration

G.1 Run the gate diff:
`bash SPEC/analyst-as-control-surface/PLAN/scripts/run-gates.sh
--diff SPEC/analyst-as-control-surface/PLAN/baseline-gates.json
> tmp/s04/gate-diff.txt`. Inspect.

G.2 Allowed NEW failures: only the four
`web-vitest:scenario-*` ids listed in
[design.md](./design.md) `## Expected breakage forecast`
(`scenario-notifications-panel:step-1`,
`scenario-stale-warning-ribbon:step-1`,
`scenario-operator-dashboard-smoke:step-1`,
`scenario-operator-events-contract:step-1`). Any other
NEW failure is a stop-the-line for S04.

G.3 Allowed REPAIRED ids: only
`analyst-e2e:scenario-queue-notification:step-1` (the S02
forecast). Any other REPAIRED id is fine (it strictly improves the
baseline) but must be re-confirmed against the cumulative ledger
in Phase H.

## Phase H — Close-out

H.1 Re-run the writer-autonomy grep on this stage's drafts using
both the checked-in anchor list (per S00 cookbook §3) and a
self-contained inline literal pattern. Both must return zero hits.

Anchor-file form:

```
grep -REn -i -f SPEC/analyst-as-control-surface/PLAN/forbidden-anchors.txt SPEC/analyst-as-control-surface/PLAN/drafts/004-notifications-queue-ephemeral/
```

Inline literal form (kept in this plan so the gate is
self-contained even if `forbidden-anchors.txt` is missing or
diverges):

```
grep -REn -i -E '(spec-r[1-6]|protocol-r[1-3]|master-plan-r[1-6]|review[-]r|prior[ ]round|earlier[ ]round|previous[ ]version|previous[ ]draft|before[ ]the[ ]refactor|was[ ]superseded|older[ ]revision)' SPEC/analyst-as-control-surface/PLAN/drafts/004-notifications-queue-ephemeral/
```

Zero hits required from both invocations. The inline alternation
uses single-character classes (for example `review[-]r`,
`prior[ ]round`) so the literal forbidden anchor strings do not
appear verbatim in this plan; the gate is therefore self-applicable
to its own §H.1 without false positives.

H.2 Re-run the host-path guard:

```
grep -REn '/wo''rk/' SPEC/analyst-as-control-surface/PLAN/drafts/004-notifications-queue-ephemeral/
```

Zero hits required. Every host-relative path in these two files is
rooted at `saivage-v3/...`.

H.3 Re-run the emoji grep:

```
grep -RnP '[\x{1F300}-\x{1FAFF}\x{2600}-\x{27BF}]' SPEC/analyst-as-control-surface/PLAN/drafts/004-notifications-queue-ephemeral/
```

Zero hits required.

H.4 Append the four forecast entries verbatim from
[design.md](./design.md) `## Expected breakage forecast` to the
end of
`SPEC/analyst-as-control-surface/PLAN/expected-breakage-ledger.md`,
replacing each `<YYYY-MM-DD>` with the actual UTC date at append
time. The order of the four entries matches the order in
`design.md`
(`web-vitest:scenario-notifications-panel:step-1`,
`web-vitest:scenario-stale-warning-ribbon:step-1`,
`web-vitest:scenario-operator-dashboard-smoke:step-1`,
`web-vitest:scenario-operator-events-contract:step-1`).
Append, do not edit existing entries.

H.5 Conditional S02 close-out. Re-read
`SPEC/analyst-as-control-surface/PLAN/expected-breakage-ledger.md`.
If all three conditions hold:

  (a) the file currently contains the H3 block
      `### analyst-e2e:scenario-queue-notification:step-1`,
  (b) its `Target fix stage` line reads `S04` exactly,
  (c) the fresh
      `bash SPEC/analyst-as-control-surface/PLAN/scripts/run-gates.sh
      --diff SPEC/analyst-as-control-surface/PLAN/baseline-gates.json`
      from `saivage-v3/` no longer observes that failing id,

then delete the entire H3 block (the heading plus its four named
lines `Failure mode`, `Reason acceptable now`,
`Target fix stage`, `Recorded by`). Otherwise leave the block
untouched and do not fabricate it.

H.6 Re-run the autonomy grep, host-path grep, and emoji grep
(steps H.1, H.2, H.3) after the ledger edits. Zero hits required
on the drafts dir; the ledger file is exempt from the autonomy
regex because it may legitimately reference older stages by `S0x`
shorthand.

H.7 Re-run the gate diff one final time:

```
bash SPEC/analyst-as-control-surface/PLAN/scripts/run-gates.sh
  --diff SPEC/analyst-as-control-surface/PLAN/baseline-gates.json
```

Expected output:

- NEW failures: exactly the four `web-vitest:scenario-*` ids
  forecasted in `design.md` `## Expected breakage forecast`
  (`web-vitest:scenario-notifications-panel:step-1`,
  `web-vitest:scenario-stale-warning-ribbon:step-1`,
  `web-vitest:scenario-operator-dashboard-smoke:step-1`,
  `web-vitest:scenario-operator-events-contract:step-1`).
- REPAIRED ids: `analyst-e2e:scenario-queue-notification:step-1`
  (the S02 close-out) plus any incidental improvements.
- Exit code: 0 if and only if every NEW failure has a matching
  open ledger entry naming a later stage. The S04 acceptance
  closes only if exit code 0 holds.

H.8 Operator API contract zero-hit guard. Run the self-contained
inline pattern check against `src/contracts/operator-api.ts`:

```
grep -nE 'notification' saivage-v3/src/contracts/operator-api.ts
```

The match set must be empty. Acceptable noise is limited to
incidental matches inside comments that do not name a notification
contract entry; any schema, route entry, or exported type whose
name contains `notification` makes S04 fail at close-out. If any
such match appears, S04 deletes those entries in-stage (the file
is re-edited, Phase E gates are re-run, then this guard is
re-executed). This step replaces the earlier S07 deferral; S04
owns notification-specific contract removal per MASTER-PLAN
§S04 acceptance, S07 still owns the broader operator-API mutating
route pruning.

H.9 Publication. Rename
`SPEC/analyst-as-control-surface/PLAN/drafts/004-notifications-queue-ephemeral`
to
`SPEC/analyst-as-control-surface/PLAN/stages/004-notifications-queue-ephemeral`
as one atomic mv. Do not edit the published files in place; per
PROTOCOL-r4 the rename is the publication act.

H.10 Final close-out check: run `grep -RnP
'[\x{1F300}-\x{1FAFF}\x{2600}-\x{27BF}]'
SPEC/analyst-as-control-surface/PLAN/stages/004-notifications-queue-ephemeral/`
and the autonomy regex from H.1 (both the `-f` and the inline
literal form) against the now-published files; all three
invocations must remain at zero hits.
