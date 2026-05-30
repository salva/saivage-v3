# S09 — Operator events surface cleanup (no notification-content read surface) — design

## Goal

Remove the dead operator-side notification and operator-note
read surfaces from the saivage-v3 web layer so that no
client code can list, fetch, or render notification content
as an inspectable object class. After S09 the web layer's
inbox-style code paths (`listNotifications`, `listNotes`,
`fetchNotifications`, `fetchNotes`, `NotificationRecord`,
`NotificationsListResponse`, `NoteQueueEntry`,
`NotesListResponse`, the corresponding store state and
exports, and the `notification_added` listener that drives
those fetches) are deleted, and the per-stage mechanical
gate confirmed by

```
grep -REn 'list[_-]?notification|get[_-]?notification|notification[_-]?inbox' saivage-v3/src saivage-v3/web/src saivage-v3/src/contracts
```

reports zero hits. The `notification_added` event TYPE on
the event bus (declared in
`saivage-v3/src/contracts/operator-events.ts`) is preserved
because that event is emitted by the runtime regardless of
whether any UI consumes it; S09 removes the CONSUMER side
of the operator notification surface, not the producer
side.

S09 does NOT preserve any "recent runtime events" panel
under a notification-agnostic name because no such panel
is currently mounted in the source — S06 already deleted
`saivage-v3/web/src/components/cards/NotificationsPanel.vue`
and removed the per-notification Acknowledge and Clear-all
affordances along with it (see the published S06 stage
`saivage-v3/SPEC/analyst-as-control-surface/PLAN/stages/006-ui-mutation-removal-ordered-rendering/design.md`
section "NotificationsPanel deletion vs. RuntimeEventsPanel rename"
for the precedence). S09 therefore takes the second branch
of the master plan's S09 charter (delete-or-convert): pure
deletion of the residual dead read surface, no rename.

The corresponding charter sub-goal for `DebugView.vue` —
"remove terminate-process control and per-note
acknowledge/delete/clear-all" — is a verify-only step in
S09 because S06 already removed every UI mutation
affordance from that view. S09 confirms the absence with
a vitest assertion and adds no behavior to DebugView; the
file keeps its existing filters, refresh button, and
copy-to-clipboard control unchanged.

The analyst-side `terminate_process` audited tool (declared
in `saivage-v3/src/agents/analyst-tools.ts`, schemaed in
`saivage-v3/src/agents/analyst-tool-schemas.ts`, role-gated
in `saivage-v3/src/agents/role-tool-policy.ts`, registered
in `saivage-v3/src/tools/agent-tools.ts`) is NOT touched
by S09 — it is an analyst control verb explicitly listed
in master-plan-r7 §S02 and is invoked via the analyst
chat, not via any operator UI button.

## Scope

### In scope

- Deletion of dead web-client API functions
  `listNotifications` and `listNotes` from
  `saivage-v3/web/src/api/client.ts`.
- Deletion of dead web-client type declarations
  `NotificationRecord`, `NotificationsListResponse`,
  `NoteQueueEntry`, and `NotesListResponse` from
  `saivage-v3/web/src/api/types.ts` (and from any
  `web/src/api/index.ts` re-export if it re-exported
  them).
- Removal of the dead notification and operator-notes
  state, computed values, async fetcher functions, and
  exports from `saivage-v3/web/src/stores/debug.ts`. The
  affected symbols (verified by grep against the
  pre-S09 source) are at least:
  `serverNotifications`, `notificationsLoading`,
  `notificationsError`, `notificationsState`,
  `notificationActionLoading`, `eventNotificationRollups`,
  `notifications`, `notificationsTotal`,
  `fetchNotifications`, `operatorNotes`,
  `operatorNotesTotal`, `operatorNotesLoading`,
  `operatorNotesError`, `fetchNotes`. The exact set of
  symbols deleted is fixed by the pre-edit grep captured
  in plan.md Phase A.
- Removal of the `notification_added` event-bus listener
  block in `saivage-v3/web/src/stores/debug.ts` that
  triggered `fetchNotifications()` on every event. The
  listener body becomes either a deletion (preferred,
  per the architecture-first / no-backward-compat
  workspace rule) or, if the same listener handler also
  reacts to non-notification event kinds in the pre-edit
  source, a narrowing edit that removes only the
  `notification_added` branch.
- Removal of the corresponding `Promise.allSettled([…])`
  entries in `fetchOperatorBundle` (or whatever the
  current bundle-fetch is named in `debug.ts`) so the
  bundle no longer dispatches calls into dead client
  functions.
- A new vitest module that asserts the deleted surfaces
  are absent — see "Test plan" below.
- A new jest module that asserts `GET /api/notifications`
  and `GET /api/notes` return 404 (or, if Fastify reports
  "Route not found" as a 404 by default, that the
  expected 404 is in fact what comes back).
- An updated forbidden-token vitest assertion that
  extends the existing read-only positive checklist with
  the deleted exports so future re-introduction of
  `listNotifications`/`listNotes`/`NotificationRecord`/
  `NotificationsListResponse`/`NoteQueueEntry`/
  `NotesListResponse` is caught by the test gate.

### Out of scope

- The analyst-side `terminate_process` tool wiring in
  `saivage-v3/src/agents/`. Master-plan-r7 §S02 keeps this
  verb. Touching it would be a scope violation.
- The `notification_added` event TYPE in
  `saivage-v3/src/contracts/operator-events.ts`,
  `NotificationAddedContentSchema`, and every backend
  emitter call site. S09 removes the operator UI's
  consumption of inbox-style notification content, not
  the event-bus event name itself.
- Any rename of an existing read-only "recent runtime
  events" panel to `RuntimeEventsPanel`. No such panel
  currently exists in the source. The S09 charter's
  "if a read-only panel is preserved it MUST be
  renamed" clause is vacuously satisfied because the
  precondition (preserved panel) is false.
- Any edit to `DebugView.vue` template, script, or style
  beyond what is required to compile cleanly after the
  store-side deletions. The expected DebugView edit
  count is zero (verify-only); the vitest assertion that
  no `acknowledge`/`delete`-style per-note click handler
  exists is added in `web/src/__tests__/` and not in
  `DebugView.vue` itself.
- Any new analyst tool, new contract type, new ws event
  kind, or new route. S09 is a deletion stage.
- The cumulative ledger entry
  `analyst-e2e:scenario-analyst-chat-context-child-order:step-1`
  (`Target fix stage: S08`, `Recorded by: S03 / 2026-05-25`).
  That entry is the single OPEN entry the cumulative
  ledger carries at the moment S09 starts (S08 has been
  paper-published but its implementation has not been
  executed, so the entry has not been closed). It targets
  S08, not S09; S09 H.4 only closes S09-targeted entries
  and per MASTER-PLAN-r7 only S10 owns the final
  reconciliation. S09 does not touch the entry.

## Dependencies

S00 — the breakage-detection harness and the four
  baseline gates (vitest, jest, anchors, scripts) that
  plan.md Phase H uses for the close-out diff and the
  baseline-refresh conditional. The scripts
  `run-gates.sh`, `check-stage-links.sh`, and
  `validate-baseline.sh` referenced in plan.md Phase H
  are S00 artefacts.

S04 — the queue-only ephemeral notifications model.
  S04 removed the persistent operator-notification
  store; the dead client-side code S09 deletes is
  residue from before S04 (the API endpoints already
  do not exist on the backend, so the dead fetch
  functions in the store have been silently 404ing).

S06 — the UI mutation removal and ordered rendering
  stage. S06 deleted `NotificationsPanel.vue` and every
  per-notification mutating affordance. S09 finishes
  the cleanup by removing the dead client/store
  references that S06 left behind as deliberate
  deferred work; the S06 design.md flags this in its
  "Downstream impact" section.

S09 has no dependency on S07 or S08. S07's
ledger-as-OPEN-only and S08's analyst-chat-context work
do not interact with the operator events surface; the
two stages can be re-ordered or run in parallel from a
DAG perspective.

## Approach

S09 is a deletion stage: every concrete edit removes
code, removes a type, removes an export, or removes a
test fixture entry. No new behavior, no new tool, no
new schema is authored. The stage is sequenced so the
deletions can be made in a single pass with one tsc
check and one web build at the end, because the
deletion ordering is forced by TypeScript's strict
mode: client functions and types must be deleted
together (or the store will fail to compile against a
type that no longer exists), and the store-side
exports must be deleted together with their consumer
references (or DebugView/other views will fail to
compile against a missing import).

The approach has six steps, executed in the order
given:

1. Pre-edit inventory and anchor. plan.md Phase A
   captures the exact set of dead symbols and call
   sites with a single `grep` so the edits in Phase B
   are mechanical and the diff in Phase H is
   predictable. The inventory is written to a
   `tmp/s09-*` capture file so the post-edit grep is
   directly diffable against the pre-edit baseline.

2. Delete client functions and types together. Phase B
   edits `web/src/api/client.ts` and `web/src/api/types.ts`
   in a single transactional pass (one
   `multi_replace_string_in_file` call, per the
   workspace memory note on multi-spot edits in
   long files). The type deletion includes any
   re-export in `web/src/api/index.ts` if the export
   list references the deleted names.

3. Delete store state and exports. Phase C edits
   `web/src/stores/debug.ts` to strip every dead
   notification/operator-notes ref, computed,
   function, and exported readonly. The
   `notification_added` listener body is narrowed (if
   it handled multiple event kinds) or deleted (if it
   only triggered `fetchNotifications()`).

4. Verify DebugView. Phase D runs the existing test
   suite and a fresh forbidden-token grep against
   `web/src/views/DebugView.vue` to confirm no edit
   is required there. The expected outcome of Phase D
   is zero file edits and zero diagnostic findings.

5. Tests. Phase E adds the vitest module asserting
   the deleted symbols are absent, extends the
   existing read-only-positive-checklist test with the
   newly forbidden tokens, and adds the jest module
   asserting the backend 404 for
   `/api/notifications` and `/api/notes`.

6. Close-out. Phase H follows the published S08 H.1–
   H.13 skeleton: autonomy anchors, host-path guard,
   emoji guard, conditional ledger close-out
   (paper-plan: no S09-targeted entries — true no-op),
   build/test gates, gate diff, conditional baseline
   refresh (paper-plan: no-op because the new test
   files start green), S10-targeted conditional
   forecast append, final guard re-runs, atomic
   rename publication with device-id and hash
   verification.

The architecture-first / no-backward-compat workspace
rule applies to every deletion in this stage: dead
code is removed in full, not stubbed; deleted types
are not preserved as aliases; deleted exports are not
preserved as no-op functions. Any consumer that breaks
because of the deletion must be fixed in S09 under the
holistic-fix-first discipline (MASTER-PLAN-r7 §3 rule
(3)) — not deferred to S10.

## Surfaces touched

Files edited:

- `saivage-v3/web/src/api/client.ts` — delete
  `listNotifications` and `listNotes` function bodies
  and their exports.
- `saivage-v3/web/src/api/types.ts` — delete
  `NotificationRecord`, `NotificationsListResponse`,
  `NoteQueueEntry`, and `NotesListResponse` interface
  declarations and any related helper types referenced
  only by them.
- `saivage-v3/web/src/api/index.ts` — delete any
  re-export entries for the four type names and two
  function names if present in the re-export list.
- `saivage-v3/web/src/stores/debug.ts` — delete the
  imports for the four type names and two function
  names; delete the listed refs/computed/functions
  (`serverNotifications`, `notificationsLoading`,
  `notificationsError`, `notificationsState`,
  `notificationActionLoading`,
  `eventNotificationRollups`, `notifications`,
  `notificationsTotal`, `fetchNotifications`,
  `operatorNotes`, `operatorNotesTotal`,
  `operatorNotesLoading`, `operatorNotesError`,
  `fetchNotes`); delete the corresponding
  `Promise.allSettled` entries; narrow or delete the
  `notification_added` listener; delete every entry
  from the store's `return { … }` export object that
  references the removed symbols.
- `saivage-v3/web/src/__tests__/read-only-positive-checklist.test.ts`
  — extend the `removedMutationTokens` regex with
  `listNotifications`, `listNotes`, `fetchNotifications`,
  `fetchNotes`, `NotificationRecord`,
  `NotificationsListResponse`, `NoteQueueEntry`,
  `NotesListResponse` so future re-introduction is
  caught by the existing gate.
- `saivage-v3/web/src/__tests__/debug-view-child-order.test.ts`
  — delete the `listNotifications:` and `listNotes:`
  keys from the single `vi.mock('../api/client', () => ({ … }))`
  mock object literal (currently at line 9 of the file —
  verified at draft-authoring time by
  `grep -REn 'listNotifications|listNotes' saivage-v3/web/src`).
  The test's purpose is to assert DebugView's ordered
  child rendering; the two mock keys are residue from
  before S04 and serve no role in the scenario the test
  exercises. The minimal edit is the removal of those
  two keys from the mock map; no other change to the
  test is needed.

Files created:

- `saivage-v3/web/src/__tests__/debug-store.events-surface.test.ts`
  — vitest assertions that the debug store does not
  expose `notifications`, `notificationsTotal`,
  `notificationsState`, `fetchNotifications`,
  `operatorNotes`, `operatorNotesTotal`,
  `operatorNotesLoading`, `operatorNotesError`, or
  `fetchNotes`. Also asserts that the source of
  `web/src/stores/debug.ts` (read via `readFileSync`)
  does not import `listNotifications`,
  `listNotes`, `NotificationRecord`,
  `NotificationsListResponse`, `NoteQueueEntry`, or
  `NotesListResponse` from `../api/client` or
  `../api/types`.
- `saivage-v3/web/src/__tests__/api-client-events-surface.test.ts`
  — vitest assertions that the API client module does
  not export `listNotifications` or `listNotes` and
  that the types module does not export
  `NotificationRecord`, `NotificationsListResponse`,
  `NoteQueueEntry`, or `NotesListResponse`. The
  assertions are runtime imports (`import * as client`
  / `import * as types`) plus the existing
  source-string regex pattern used elsewhere in
  `web/src/__tests__/`.
- `saivage-v3/web/src/__tests__/debug-view-events-surface.test.ts`
  — vitest assertions on the source of
  `web/src/views/DebugView.vue` (read via
  `readFileSync`) that the SFC contains zero matches
  for `acknowledgeNotification`, `clearAllNotes`,
  `acknowledgeNote`, `deleteNote`, or
  `@click="[^"]*acknowledge` (case-insensitive).
  Distinct from S06's existing
  `web/src/__tests__/debug-view.integration.test.ts`
  (which only forbids `terminateProcess` and
  `@click="[^"]*terminate`).
- `saivage-v3/tests/server/notifications-endpoint-removed.test.ts`
  — jest assertion that `GET /api/notifications` and
  `GET /api/notes` return 404 (or whatever the
  Fastify "route not found" response code is on this
  codebase — assert against the actual production
  behavior).

Files NOT touched (verify-only):

- `saivage-v3/web/src/views/DebugView.vue` — verified
  by `debug-view-events-surface.test.ts`; no edits
  expected.
- `saivage-v3/SPEC/analyst-as-control-surface/PLAN/expected-breakage-ledger.md`
  — at S09 start the cumulative ledger carries exactly
  one OPEN entry targeted at S08 (not S09); H.4 closes
  only S09-targeted entries and finds zero. The ledger
  is byte-unchanged by S09.
- `saivage-v3/src/agents/analyst-tools.ts`,
  `analyst-tool-schemas.ts`, `role-tool-policy.ts`,
  `saivage-v3/src/tools/agent-tools.ts` — the
  analyst-side `terminate_process` tool is out of
  scope.
- `saivage-v3/src/contracts/operator-events.ts` —
  `notification_added` event type and
  `NotificationAddedContentSchema` remain.

Files possibly deleted in full (not partially edited):

- None expected. If the inventory in plan.md Phase A
  surfaces a file (for example a tiny
  `web/src/components/cards/Notification*.vue` that
  was missed by the precondition grep), the file is
  deleted in full and the inventory captured in
  `tmp/s09-*-files-deleted.txt`.

## Test plan

Backend (jest, root) — adds one new file:

`saivage-v3/tests/server/notifications-endpoint-removed.test.ts`
asserts:

- (a) A Fastify test server built from the production
  route registration returns 404 for
  `GET /api/notifications`.
- (b) Same server returns 404 for `GET /api/notes`.
- (c) The combined route listing (Fastify's
  `printRoutes()` or the equivalent introspection used
  in other server tests under `tests/server/`) contains
  no entry whose path begins with `/api/notifications`
  or `/api/notes`.

Backend (jest, root) — existing tests under
`tests/agents/` and `tests/server/` MUST continue to
pass byte-unchanged. S09 adds no edits to the
analyst-side terminate-process tests
(`tests/agents/analyst-tools.test.ts` or whatever
covers them). The pre-existing
`tests/server/operator-contracts.test.ts` (and any
`tests/server/runtime-config-notes.test.ts`) MUST
continue to pass.

Web (vitest, `web/`) — adds three new files (per
"Surfaces touched") and extends the existing
`read-only-positive-checklist.test.ts`:

- `web/src/__tests__/debug-store.events-surface.test.ts`
  exercises a fresh `useDebugStore()` from a
  `createPinia()` setup and asserts that
  `(store as any).notifications`,
  `(store as any).notificationsTotal`,
  `(store as any).notificationsState`,
  `(store as any).fetchNotifications`,
  `(store as any).operatorNotes`,
  `(store as any).operatorNotesTotal`,
  `(store as any).operatorNotesLoading`,
  `(store as any).operatorNotesError`, and
  `(store as any).fetchNotes` are all `undefined`.
  The test additionally reads
  `web/src/stores/debug.ts` via `readFileSync` and
  asserts that the file body does not contain
  `listNotifications`, `listNotes`,
  `fetchNotifications`, or `fetchNotes` (verbatim).
- `web/src/__tests__/api-client-events-surface.test.ts`
  imports `web/src/api/client.ts` and asserts
  `client.listNotifications` and `client.listNotes`
  are `undefined`. The companion source-string
  assertion confirms neither name appears in the file
  text (catches the edge case of a default-exported
  alias).
- `web/src/__tests__/debug-view-events-surface.test.ts`
  reads `web/src/views/DebugView.vue` via
  `readFileSync` and asserts the source matches none
  of: `/acknowledgeNotification/i`,
  `/clearAllNotes/i`, `/acknowledgeNote/i`,
  `/deleteNote/i`, `/@click="[^"]*acknowledge/i`.
- The existing
  `web/src/__tests__/read-only-positive-checklist.test.ts`
  is edited in place: the `removedMutationTokens`
  regex literal grows to include the eight new
  forbidden tokens listed above (the existing tokens
  `acknowledgeNotification`, `clearAllNotes`,
  `deleteNote`, `acknowledgeNote` are already
  present per the pre-S09 source; S09 adds
  `listNotifications`, `listNotes`,
  `fetchNotifications`, `fetchNotes`,
  `NotificationRecord`,
  `NotificationsListResponse`, `NoteQueueEntry`,
  `NotesListResponse`).

Mechanical gate (S00 anchors gate, run via the
existing `run-gates.sh` script): the close-out grep

```
grep -REn 'list[_-]?notification|get[_-]?notification|notification[_-]?inbox' saivage-v3/src saivage-v3/web/src saivage-v3/src/contracts
```

must report zero hits after S09's edits. As of S09's
start the grep already reports zero hits (verified at
draft-authoring time on the workspace by running the
command and observing exit 1) because the dead client
functions use camelCase
`listNotifications`/`listNotes` rather than the
underscore/hyphen forms the grep matches. S09's edits
do not change the verdict; the gate is verified
unchanged.

## Expected breakage forecast

S09 forecasts NO new breakage. The stage is a deletion
stage covering symbols that are already unreferenced
by any rendered view (verified by the pre-S09 grep in
plan.md Phase A). Every deleted symbol is consumed
only inside `web/src/stores/debug.ts` (the
self-contained dead-bundle), inside the API client
itself, or inside the four type files being deleted
together — there is no third party consumer to break.

The corresponding S00 baseline gates
(`vitest:read-only-positive-checklist:step-1`,
`vitest:debug-view-mutation-shape:step-1`, the anchor
grep, and the script gates) are expected to stay green
across the edit. The new vitest and jest files added
in Phase E start green (they assert deletions that
have already been performed by the same stage's
preceding phases), so the baseline file
`SPEC/analyst-as-control-surface/PLAN/baseline-gates.json`
does NOT need an entry added in Phase H's conditional
baseline refresh — the paper-plan default is no-op on
the baseline file.

In the unlikely event a Phase D run surfaces an
unanticipated consumer of one of the deleted symbols
in a view or component the inventory missed, the
holistic-fix-first rule applies: the consumer is
fixed in S09 (deleted, narrowed, or rewired to the
event-bus directly without going through the dead
store path), not deferred to S10. Phase H.11's
conditional forecast append is therefore expected to
remain a no-op.

## Done-definition cross-reference

Per MASTER-PLAN-r7 §S09 acceptance criteria, S09 is
done when:

- (1) Every mutation-only operator surface listed in
  §S09 is deleted or converted. S09 deletes the dead
  read-only consumer side of the operator
  notifications surface; the mutation-only client
  functions and per-note action handlers were already
  deleted by S04 and S06 (verified). DebugView's
  terminate-process control was already removed by
  S06 (verified). Status: satisfied (the deletion is
  inherited; S09 only removes the residue).
- (2) Any preserved read-only "recent runtime events"
  panel is renamed to a notification-agnostic name.
  S09 preserves no such panel (no
  `Notification*.vue` SFC and no events-panel SFC
  exists in the source). Status: vacuously satisfied.
- (3) The mechanical gate
  `grep -REn 'list[_-]?notification|get[_-]?notification|notification[_-]?inbox' saivage-v3/src saivage-v3/web/src saivage-v3/src/contracts`
  returns zero hits. Status: confirmed at S09 start
  (the gate is verified, not newly satisfied).
- (4) DebugView retains its filters, refresh button,
  and copy-to-clipboard control unchanged. Status:
  asserted by the new
  `debug-view-events-surface.test.ts` and confirmed
  by the absence of any DebugView edit in this
  stage.

S09 additionally satisfies the master plan's §3 rule
(3) (holistic-fix-first) by deleting the residue in
one stage rather than spreading it across multiple
later stages.

## Downstream impact

S10 (and later stages) inherit a web layer in which
the API client module exports exactly the set of
functions actually used by views or stores. Future
stages that introduce a new "recent runtime events"
read surface (under any name) MUST NOT call any
notifications endpoint — only the event-bus
subscription path remains. The
`notification_added` event TYPE is still emitted on
the bus and can be consumed by future stages
(badging in analyst chat, runtime diagnostics, etc.);
S09 does not constrain what those consumers do, only
that they cannot rely on a `listNotifications`-style
inbox endpoint, because no such endpoint exists.

The cumulative ledger
`SPEC/analyst-as-control-surface/PLAN/expected-breakage-ledger.md`
is byte-unchanged by S09 in the paper-plan default
(no S09-targeted close-out entries, no
S10-targeted forecast appends). At S09 start the
ledger carries exactly one OPEN entry —
`analyst-e2e:scenario-analyst-chat-context-child-order:step-1`
with `Target fix stage: S08` and
`Recorded by: S03 / 2026-05-25` — which is OUTSIDE
S09's scope (S08 owns it; per MASTER-PLAN-r7 only S10
owns the final reconciliation). S09 H.4 closes only
S09-targeted entries, of which there are zero, so S09
ends with the ledger carrying the same single S08-
targeted OPEN entry it started with, byte-identical.

## Open issues

None known at S09 draft time. The pre-S09 inventory
grep performed against the workspace at draft
authoring confirmed (a) no `Notification*.vue` SFC
exists in `web/src/`, (b) no `/api/notifications` or
`/api/notes` backend route is registered, (c) the
forbidden-identifier grep already reports zero hits,
and (d) the live references to the targeted symbols
are located in exactly four files. The broadened
`grep -REn 'listNotifications|listNotes' saivage-v3/web/src`
run at draft-authoring time returned:

- `web/src/api/client.ts:221:export function listNotes(): Promise<NotesListResponse> {`
- `web/src/api/client.ts:228:export function listNotifications(): Promise<NotificationsListResponse> {`
- `web/src/stores/debug.ts:44:  listNotes,`
- `web/src/stores/debug.ts:45:  listNotifications,`
- `web/src/stores/debug.ts:420:      const response: NotesListResponse = await listNotes();`
- `web/src/stores/debug.ts:443:      const response: NotificationsListResponse = await listNotifications();`
- `web/src/__tests__/debug-view-child-order.test.ts:9: vi.mock('../api/client', () => ({ … listNotes: …, listNotifications: …, … }))`

These are the four files S09 edits (the three originally
inventoried plus
`web/src/__tests__/debug-view-child-order.test.ts`,
added to Phase E.6 of plan.md after the reviewer's
broadened grep). Line numbers may drift between draft
authoring and stage execution; the implementer
re-runs the same grep in Phase A.5 and uses the
captured line set as the authoritative target.

The cumulative ledger at S09 start carries exactly one
OPEN entry —
`analyst-e2e:scenario-analyst-chat-context-child-order:step-1`
with `Target fix stage: S08` and
`Recorded by: S03 / 2026-05-25`. That entry is OUTSIDE
S09's scope and is not closed by S09's H.4 (which only
closes S09-targeted entries). The ledger is byte-
unchanged by S09 in the paper-plan default.

If Phase A's grep surfaces a fifth consumer that the
draft inventory missed (for example a Vue component
under `web/src/components/` that imports
`notificationsTotal` for a badge counter), the
implementer follows the holistic-fix-first rule and
fixes the consumer in S09 rather than deferring to
S10. The "Surfaces touched" list above is then
extended in the implementation-notes capture and
recorded as a paper-plan-vs-actual divergence; no
re-publication of design.md is required because the
stage's goal, scope, and acceptance criteria do not
change.
