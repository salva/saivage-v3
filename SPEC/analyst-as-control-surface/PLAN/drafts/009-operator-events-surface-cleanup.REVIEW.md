# S09 REVIEW - Operator events surface cleanup

Verdict: APPROVED

Finding counts: BLOCKER 0, MAJOR 0, NIT 0

Single most important issue: No outstanding issues; S09 is ready for publication.

## Findings

No findings.

## S09 Conformance Check

S09 is correctly framed as an effort-S cleanup stage. The draft chooses the deletion branch, not a partial rename branch: S06 already removed `NotificationsPanel.vue`, and S09 deletes the remaining web client, type, store, and stale test-mock residue that still treats notifications or notes as listable objects.

The design and plan keep `notification_added` narrowly correct. It remains a websocket/event-registry event name and schema, while S09 removes the web-side consumer path that lists, fetches, or renders notification content as an inspectable object. The analyst-side `terminate_process` tool is explicitly out of scope and preserved.

`DebugView.vue` is handled as verify-only for the S09 charter. The source spot-check shows no live terminate-process button, no note acknowledge/delete/clear-all handler, and no `NotificationsPanel` import or mount. S09 adds tests and static checks around that absence without adding DebugView behavior.

## Writer Claims

MAJOR 1 is closed. The draft no longer claims the cumulative ledger is empty at S09 start. It states that exactly one open S08-targeted entry exists at S09 start, that S09 has zero S09-targeted entries to close, that H.4 is a true no-op for S09 purposes, and that S10 owns final reconciliation of remaining other-stage-targeted entries.

MAJOR 2 is closed. The plan now includes E.6 for `web/src/__tests__/debug-view-child-order.test.ts`, precisely removing only the stale `listNotes` and `listNotifications` mock keys and requiring a post-edit grep with zero matches. The close-out dead-residue grep is broadened to all of `web/src`, includes the full pinned token set, and asserts zero hits.

MINOR 3 is closed. The H-phase count is 13, and the total A-H substep count is 51. The increase from the prior total is explained by the legitimate new E.6 substep, and the H.4 prose continuation now starts with `Phase H.4 is conditional`, so it no longer inflates the H count.

## Mechanical Checks

File hygiene: the existing `REVIEW.md` was removed on disk before this file was created afresh. No append was used.

Static hygiene over `design.md` and `plan.md`: file-form forbidden-anchor grep produced no output; inline forbidden-anchor count was 0; emoji count was 0; host-path literal count was 0; workspace-change-dir literal count was 0; `result.data.intent` and `noop: true` count was 0.

Design headings present: `Goal`, `Scope`, `Dependencies`, `Approach`, `Surfaces touched`, `Test plan`, `Expected breakage forecast`, `Done-definition cross-reference`, `Downstream impact`, and `Open issues`.

Plan structure: `Breakage triage` appears once; `grep -Ec '^H\.[0-9]+[[:space:]]' plan.md` returned 13; `grep -Ec '^[A-H]\.[0-9]+[[:space:]]' plan.md` returned 51.

Required source greps: the list/get/inbox notification-form grep across `src`, `web/src`, and `src/contracts` returned 0 hits. The broadened dead-residue grep across `web/src` currently returns 66 hits in exactly four files: `web/src/api/client.ts`, `web/src/api/types.ts`, `web/src/stores/debug.ts`, and `web/src/__tests__/debug-view-child-order.test.ts`. S09's edit-set covers all four.

Vue SFC check: the notification-named SFC search under `web/src` returned 0 hits. No live `Notification*` or `Notifications*` component remains.

Stage-link checker: `check-stage-links.sh` against the S09 draft directory exited 0 and produced no output.

S08-looking references were reviewed. The remaining S08 mentions are ledger/dependency context, plus contextual references to the published S08 close-out/register-check shape; no stale temp names, command captures, or wrong-stage publication paths were found.

## Source Spot-Check Matrix

| File | Current evidence | S09 coverage |
| --- | --- | --- |
| `web/src/api/client.ts` | Still imports `NotesListResponse` and `NotificationsListResponse`; still exports `listNotes` and `listNotifications`; only route strings for the retired endpoints are here, not in server/contracts. | B.1-B.4 delete wrappers, dead imports, and any re-export residue. |
| `web/src/api/types.ts` | Still defines `NoteQueueEntry`, `NotificationRecord`, `NotesListResponse`, and `NotificationsListResponse`. | B.3 deletes those interfaces and any now-private helper residue. |
| `web/src/api/index.ts` | Barrel re-export only. | B.4 verifies no named residue after type/client deletion. |
| `web/src/stores/debug.ts` | Still imports the dead client/type symbols, exposes operator notes and notifications state, computes `eventNotificationRollups`, fetches notes/notifications, includes those fetches in the operator bundle, and reacts to `notification_added` by fetching notifications. | C.1-C.3 delete/narrow the store residue and require terminal grep count 0. |
| `web/src/__tests__/debug-view-child-order.test.ts` | The single API mock still contains stale `listNotes` and `listNotifications` keys. | E.6 removes exactly those two mock keys and verifies zero matches. |
| `web/src/views/DebugView.vue` | No `NotificationsPanel` mount/import; no terminate-process click handler; no note acknowledge/delete/clear-all handler. It keeps refresh, filters, process inspection, and copy/browse-style read-only affordances. | D.1-D.3 and E.3 verify absence without editing the SFC. |
| `src/contracts/operator-events.ts` | `notification_added` remains in `AnalystActivityEventNames` and `NotificationAddedContentSchema`; registry spot-check shows `notification_added` is an event name with broadcast/audit metadata. | G.4 preserves the event type/schema so S09 does not over-delete producer-side event semantics. |

## Ledger State

The live cumulative ledger currently contains one open entry: `analyst-e2e:scenario-analyst-chat-context-child-order:step-1`, with target fix stage S08 and recorded by S03 on 2026-05-25.

No S09-targeted open ledger entry is present. The S09 draft correctly treats H.4 as a no-op for S09, leaves the existing S08-targeted entry untouched, and does not assert final ledger reconciliation. S10 remains the owner of the final empty-ledger condition.
