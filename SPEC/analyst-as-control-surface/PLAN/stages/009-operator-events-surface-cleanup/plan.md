# S09 — Operator events surface cleanup (no notification-content read surface) — plan

## Working directory

All commands below run from the workspace root
[saivage-v3/](../../../../) unless explicitly noted with
`cd web` (which means `saivage-v3/web/`) or with an absolute
path beginning `/home/`. Paths in this document are
workspace-relative to `saivage-v3/` unless they start with
`SPEC/` (in which case they are relative to `saivage-v3/`)
or with `/home/` (absolute).

## Phase A — Prep and inventory

A.1 Snapshot the current cumulative ledger
`SPEC/analyst-as-control-surface/PLAN/expected-breakage-ledger.md`
into `tmp/s09-ledger-before.md` so Phase H's close-out
comparisons have a fixed point of reference. Verify the
file is shape-correct (each OPEN entry has the required
H3 + four labeled fields per S00's ledger schema) before
proceeding.

A.2 Snapshot the current baseline
`SPEC/analyst-as-control-surface/PLAN/baseline-gates.json`
into `tmp/s09-baseline-before.json` (byte-for-byte copy).
Phase H compares the post-edit snapshot to this one.

A.3 Snapshot the four S00 gates as-of S09 start. From
`saivage-v3/`, run
`bash SPEC/analyst-as-control-surface/PLAN/scripts/run-gates.sh --diff SPEC/analyst-as-control-surface/PLAN/baseline-gates.json`
and capture stdout+stderr into `tmp/s09-gates-before.txt`.
Confirm exit code 0; if non-zero, the stage cannot start.

A.4 Inventory the dead notification and operator-notes
client/store surface. Run the precondition grep:

```
grep -REn 'list[_-]?notification|get[_-]?notification|notification[_-]?inbox' src web/src src/contracts > tmp/s09-forbidden-grep-before.txt
```

Required outcome: zero matches (file is empty). This
matches the S09 mechanical gate exactly and confirms the
gate is satisfied at the start of the stage.

A.5 Inventory the actual symbols to be deleted (the
camelCase set the forbidden grep does NOT match). Run
the focused per-file grep:

```
grep -nE 'listNotifications|listNotes|fetchNotifications|fetchNotes|NotificationRecord|NotificationsListResponse|NoteQueueEntry|NotesListResponse|notificationActionLoading|serverNotifications|eventNotificationRollups|operatorNotes' web/src/api/client.ts web/src/api/types.ts web/src/api/index.ts web/src/stores/debug.ts web/src/__tests__/debug-view-child-order.test.ts > tmp/s09-dead-symbols-before.txt
```

and the broadened whole-tree grep that S09's Phase G.2
will re-run at close-out:

```
grep -REn 'listNotifications|listNotes|NotificationRecord|NotificationsListResponse|NoteQueueEntry|NotesListResponse|fetchNotifications|fetchNotes|operatorNotes|serverNotifications|notificationsLoading|notificationsError|notificationsState|notificationActionLoading|eventNotificationRollups|notificationsTotal' web/src > tmp/s09-dead-symbols-tree-before.txt
```

Required outcome: both files non-empty. The captured
line sets are the exact target of Phase B/C/E.6 edits.
The expected file set at S09 draft-authoring time is
`web/src/api/client.ts`, `web/src/api/types.ts`,
`web/src/stores/debug.ts`, and
`web/src/__tests__/debug-view-child-order.test.ts`
(verified by the reviewer's broadened grep against the
workspace). Any additional file named in
`tmp/s09-dead-symbols-tree-before.txt` is a surface
the draft design.md missed and must be triaged
in-stage under the holistic-fix-first rule
(MASTER-PLAN-r7 §3 rule (3)) before Phase B may
proceed.

A.6 Confirm no view, component, or other store consumes
the dead store exports. Run:

```
grep -REn 'notifications|operatorNotes|fetchNotifications|fetchNotes' web/src/views web/src/components web/src/stores | grep -v 'stores/debug.ts' | grep -v 'staleNotificationByCard\|setCardStaleNotification\|clearCurrentCardStaleNotification\|notification_added' > tmp/s09-store-consumers-before.txt
```

Required outcome: file is empty. The grep deliberately
excludes (a) the file being edited and (b) the
distinct stale-card-notification surface and the
event-bus `notification_added` event name, which are
not in S09's scope. A non-empty file means an
unexpected consumer exists; the implementer adds the
file to "Surfaces touched" in `implementation-notes.md`
and edits it under the holistic-fix-first rule.

A.7 Confirm no backend route serves the dead endpoints.
Run:

```
grep -REn "'/api/notifications'|\"/api/notifications\"|'/api/notes'|\"/api/notes\"" src/server > tmp/s09-backend-routes-before.txt
```

Required outcome: file is empty. The new jest assertion
in Phase E.4 codifies this.

A.8 Run
`bash SPEC/analyst-as-control-surface/PLAN/scripts/check-stage-links.sh SPEC/analyst-as-control-surface/PLAN/drafts/009-operator-events-surface-cleanup/`
and capture to `tmp/s09-links-before.txt`. Required
outcome: exit code 0.

A.9 SFC corruption pre-check on `DebugView.vue` (S09
does not edit the SFC, but the Phase E.3 vitest reads
its source and a corrupted SFC would produce a
spurious false-positive on the
`@click="[^"]*acknowledge` regex). Run:

```
for f in web/src/views/DebugView.vue; do count=$(grep -c '<script setup' "$f"); echo "$count $(basename $f)"; done
```

Required outcome: exactly one `<script setup>` block.
Any count greater than 1 is a pre-existing VS Code SFC
duplication that must be fixed before any later
phase reads the file.

## Phase B — Delete client functions and types

B.1 Edit `saivage-v3/web/src/api/client.ts`: delete the
function declarations `listNotifications` (currently at
the line captured in `tmp/s09-dead-symbols-before.txt`)
and `listNotes` in a single
`multi_replace_string_in_file` call (per the workspace
memory note on multi-spot edits in long files). The
deletion removes the function body, the `export`
keyword if present on the declaration, and any
JSDoc/comment block immediately preceding the
declaration.

B.2 In the same file, delete any `import` line that
referenced types only used by the deleted functions
(for example `NotificationsListResponse` or
`NotesListResponse` if they appeared in the type
import block). The post-edit import list MUST be
exactly the set of types still referenced by the
surviving function bodies; verify with
`npx tsc --noEmit` in Phase B.6.

B.3 Edit `saivage-v3/web/src/api/types.ts`: delete the
interface declarations `NotificationRecord`,
`NotificationsListResponse`, `NoteQueueEntry`, and
`NotesListResponse` in a single
`multi_replace_string_in_file` call. The deletion
removes the full interface body and any
JSDoc/comment block immediately preceding the
declaration. If any of the four declarations
references a private helper type that is now
unreferenced, delete the helper type in the same
call.

B.4 Edit `saivage-v3/web/src/api/index.ts` (if it
exists and re-exports any of the deleted names):
delete the corresponding re-export entries. If the
file does not re-export any of the deleted names,
this substep is a no-op; verify with
`grep -nE 'listNotifications|listNotes|NotificationRecord|NotificationsListResponse|NoteQueueEntry|NotesListResponse' web/src/api/index.ts`
which must report zero matches after B.4.

B.5 Save all VS Code buffers
(`workbench.action.files.saveAll` via the command
palette or the keyboard shortcut) before running
the type-check, per the workspace memory note that VS
Code buffer edits do not auto-save and stale buffers
cause incorrect build verdicts.

B.6 Run `npx tsc --noEmit` and capture
output to `tmp/s09-tsc-after-phase-B.txt`. Expected
outcome: NON-zero exit code with diagnostic errors
pointing into `web/src/stores/debug.ts` (the store
still imports the deleted symbols). This is the
expected intermediate failure state; Phase C resolves
it. If the exit code is unexpectedly 0 at this point,
the inventory in Phase A.5 was incomplete and the
store-side dead code is not where the design.md
located it; pause and re-grep.

## Phase C — Delete store state and exports

C.1 Edit `saivage-v3/web/src/stores/debug.ts` with a
single `multi_replace_string_in_file` call covering:

C.1.a — the import block at the top of the file:
delete `NotificationRecord`,
`NotificationsListResponse`, `NoteQueueEntry`, and
`NotesListResponse` from the `../api/types` import
list; delete `listNotifications` and `listNotes` from
the `../api/client` import list. If any import line
becomes empty (no remaining named imports), delete
the entire line.

C.1.b — the ref/state declarations:
`serverNotifications`, `notificationsLoading`,
`notificationsError`, `notificationsState`,
`notificationActionLoading`, `operatorNotes`,
`operatorNotesTotal`, `operatorNotesLoading`, and
`operatorNotesError`. Delete every line and any
inline JSDoc/comment.

C.1.c — the computed declarations:
`eventNotificationRollups`, `notifications`, and
`notificationsTotal`. Delete each declaration in
full.

C.1.d — the async function declarations
`fetchNotifications()` and `fetchNotes()`. Delete
each function body and any preceding comment.

C.1.e — the `Promise.allSettled([…])` block inside
the bundle fetcher (`fetchOperatorBundle` or the
current equivalent). Remove the `fetchNotifications()`
and `fetchNotes()` entries from the array; if the
array becomes empty, the entire bundle fetcher is
itself dead and must be deleted along with every
caller (verify caller absence with
`grep -nE 'fetchOperatorBundle' web/src` after the
edit). If the array still has surviving entries,
keep the surrounding `await Promise.allSettled` and
the failure-collection block intact.

C.1.f — the
`if (event === 'notification_added') { void fetchNotifications().catch(() => {}); }`
listener block. If the surrounding handler reacts
ONLY to `notification_added`, delete the entire
handler registration. If the handler covers multiple
event kinds, narrow the body by deleting the
`'notification_added'` branch and any internal
state it touched.

C.1.g — the `hadPriorData` calculation: remove the
`notifications.value.length > 0` and
`operatorNotes.value.length > 0` operands. If the
expression becomes a single operand, simplify; if it
becomes empty, delete the variable and every reference
to it. Capture the chosen path in
`implementation-notes.md`.

C.1.h — the store's `return { … }` export object at
the end of the setup function: delete the entries
`notifications`, `notificationsTotal`,
`notificationsState`, `fetchNotifications`,
`operatorNotes`, `operatorNotesTotal`,
`operatorNotesLoading`, `operatorNotesError`, and
`fetchNotes`. Preserve every other entry byte-for-byte
(diff against the C.1 pre-edit version).

C.2 Save all VS Code buffers
(`workbench.action.files.saveAll`) and verify the
edit landed with a terminal grep — per the workspace
memory note that `replace_string_in_file` can report
success while the disk file is unchanged on
long/dense files:

```
grep -cE 'listNotifications|listNotes|fetchNotifications|fetchNotes|NotificationRecord|NotificationsListResponse|NoteQueueEntry|NotesListResponse|notificationActionLoading|serverNotifications|eventNotificationRollups|operatorNotes' web/src/stores/debug.ts
```

Required outcome: 0.

C.3 Run `npx tsc --noEmit` and capture
to `tmp/s09-tsc-after-phase-C.txt`. Required outcome:
exit code 0. If non-zero, the most likely diagnostics
are (a) a remaining unused import line that lints as
an error, or (b) an unreferenced
`hadPriorData`-related variable. Fix in-stage under
the holistic-fix-first rule.

## Phase D — Verify DebugView and other consumers

D.1 Re-run the consumer-inventory grep from A.6:

```
grep -REn 'notifications|operatorNotes|fetchNotifications|fetchNotes' web/src/views web/src/components web/src/stores | grep -v 'stores/debug.ts' | grep -v 'staleNotificationByCard\|setCardStaleNotification\|clearCurrentCardStaleNotification\|notification_added' > tmp/s09-store-consumers-after.txt
```

Required outcome: empty file (same as A.6).

D.2 Run
`grep -nE 'acknowledgeNotification|clearAllNotes|acknowledgeNote|deleteNote' web/src/views/DebugView.vue web/src/components/cards/*.vue 2>/dev/null`
and confirm zero matches. The pre-S09 source already
satisfies this; D.2 documents the verification, it
does not perform an edit.

D.3 Confirm DebugView still compiles cleanly. Save all
VS Code buffers and run
`grep -c '<script setup' web/src/views/DebugView.vue`
to catch any incidental SFC corruption introduced
during the session.

## Phase E — Tests

E.1 Create
`saivage-v3/web/src/__tests__/api-client-events-surface.test.ts`
covering (a) runtime: `import * as client from '../api/client';`
asserts `(client as any).listNotifications` and
`(client as any).listNotes` are `undefined`;
(b) source: `readFileSync(join(__dirname, '../api/client.ts'), 'utf8')`
does not contain `listNotifications` or `listNotes`;
(c) runtime: `import * as types from '../api/types';`
asserts the four deleted type names are undefined;
(d) source: `readFileSync(join(__dirname, '../api/types.ts'), 'utf8')`
does not contain `NotificationRecord`,
`NotificationsListResponse`, `NoteQueueEntry`, or
`NotesListResponse`.

E.2 Create
`saivage-v3/web/src/__tests__/debug-store.events-surface.test.ts`
covering (a) `createPinia()` setup, then
`const store = useDebugStore();` and assert the nine
deleted exports listed in design.md "Surfaces
touched" are all `undefined`;
(b) source: `readFileSync(...)` of
`web/src/stores/debug.ts` does not contain any of
`listNotifications`, `listNotes`,
`fetchNotifications`, `fetchNotes`,
`NotificationRecord`, `NotificationsListResponse`,
`NoteQueueEntry`, `NotesListResponse`,
`notificationActionLoading`, `serverNotifications`,
or `eventNotificationRollups`; (c) source: the
remaining `notification_added` event references in
the file (if any) MUST NOT call any function whose
name contains `fetchNotification` — verify with a
regex match.

E.3 Create
`saivage-v3/web/src/__tests__/debug-view-events-surface.test.ts`
covering source: `readFileSync(...)` of
`web/src/views/DebugView.vue` does not match any of
`/acknowledgeNotification/i`, `/clearAllNotes/i`,
`/acknowledgeNote/i`, `/deleteNote/i`, or
`/@click="[^"]*acknowledge/i`. Each regex gets its
own `expect(source).not.toMatch(...)` assertion so
the failure messages are precise.

E.4 Create
`saivage-v3/tests/server/notifications-endpoint-removed.test.ts`
covering (a) a Fastify test server instantiated from
the production route registration (the same shape
used by other tests under `tests/server/`) returns
404 for `GET /api/notifications`;
(b) the same server returns 404 for `GET /api/notes`;
(c) `server.printRoutes()` (or the equivalent
introspection method used by other server tests on
this codebase) returns a route list containing no
path that starts with `/api/notifications` or
`/api/notes`. The exact assertion style mirrors the
existing `tests/server/operator-contracts.test.ts`.

E.5 Edit
`saivage-v3/web/src/__tests__/read-only-positive-checklist.test.ts`
in place: extend the `removedMutationTokens` regex
to include `listNotifications`, `listNotes`,
`fetchNotifications`, `fetchNotes`,
`NotificationRecord`, `NotificationsListResponse`,
`NoteQueueEntry`, and `NotesListResponse`. The
existing tokens
(`createCard|updateCard|deleteCard|startProject|stopProject|pauseRuntime|resumeRuntime|acknowledgeNotification|terminateProcess|clearAllNotes|deleteNote|acknowledgeNote`)
remain untouched.

E.6 Edit
`saivage-v3/web/src/__tests__/debug-view-child-order.test.ts`
in place: delete the `listNotes: vi.fn(async () => ({ notes: [], total: 0 })),`
and `listNotifications: vi.fn(async () => ({ notifications: [], total: 0 })),`
keys from the single `vi.mock('../api/client', () => ({ … }))`
mock object literal (currently at line 9 of the file,
verified by
`grep -nE 'listNotifications|listNotes' web/src/__tests__/debug-view-child-order.test.ts`
in Phase A). The mock keys exist only as residue from
before S04; the test exercises DebugView's ordered
child rendering and does not assert any notifications
or notes behavior, so the two keys can be removed
without altering the scenario the test exercises. The
minimal edit is the removal of those two keys from
the mock map; no other change to the test is needed.
After the edit, verify with
`grep -nE 'listNotifications|listNotes' web/src/__tests__/debug-view-child-order.test.ts`
which must report zero matches.

E.7 Save all VS Code buffers and run
`grep -c '<script setup' web/src/components/chat/*.vue web/src/components/cards/*.vue web/src/views/*.vue`
to confirm zero duplications introduced during the
test-authoring session.

E.8 Run `cd web && npm test` and capture to
`tmp/s09-vitest-after-phase-E.txt`. Required outcome:
exit code 0; zero failing tests.

E.9 Run `npm test` and capture to
`tmp/s09-jest-after-phase-E.txt`. Required outcome:
exit code 0; zero failing tests.

## Phase F — Build and lint

F.1 Run `cd web && npm run build` and capture to
`tmp/s09-web-build-after-phase-F.txt`. Required
outcome: exit code 0. If the build fails for a
non-S09 reason (cascade from an earlier stage), the
issue must be tracked back to the cascading source
and fixed in-stage under the holistic-fix-first rule.

F.2 Run `npm run build` and capture to
`tmp/s09-build-after-phase-F.txt`. Required outcome:
exit code 0.

F.3 Run any existing lint task that gates the
read-only-positive-checklist if the repo configures
one separately from vitest (for example
`npm run lint`); capture to
`tmp/s09-lint-after-phase-F.txt`. If the repo does
not configure a separate lint task, this substep is
a no-op and a single-line note is appended to
`implementation-notes.md`.

## Phase G — Static analysis + manual reviews

G.1 Re-run the precondition grep:

```
grep -REn 'list[_-]?notification|get[_-]?notification|notification[_-]?inbox' src web/src src/contracts
```

Required outcome: zero matches (same as A.4).

G.2 Re-run the dead-symbols grep, broadened to scan
the whole `web/src/` tree (including `__tests__/`)
rather than only the inventory-listed files, so any
stale reference left behind by an incomplete edit is
caught:

```
grep -REn 'listNotifications|listNotes|NotificationRecord|NotificationsListResponse|NoteQueueEntry|NotesListResponse|fetchNotifications|fetchNotes|operatorNotes|serverNotifications|notificationsLoading|notificationsError|notificationsState|notificationActionLoading|eventNotificationRollups|notificationsTotal' web/src
```

Required outcome: zero matches.

G.3 Re-run the backend-routes grep:

```
grep -REn "'/api/notifications'|\"/api/notifications\"|'/api/notes'|\"/api/notes\"" src/server
```

Required outcome: zero matches (same as A.7).

G.4 Confirm `notification_added` event TYPE still
exists in the contracts (regression check that the
event-bus side was not over-deleted):

```
grep -nE "'notification_added'|NotificationAddedContentSchema" src/contracts/operator-events.ts
```

Required outcome: at least one match per identifier
(the literal event-name plus the schema declaration).

G.5 Confirm the analyst-side `terminate_process`
audited tool is still wired (regression check that the
analyst path was not touched):

```
grep -nE 'terminate_process' src/agents/analyst-tools.ts src/agents/analyst-tool-schemas.ts src/agents/role-tool-policy.ts src/tools/agent-tools.ts
```

Required outcome: at least one match per file (the
same registration matrix that S08's A.4 and G.1
inventoried for navigation tools, scoped to
`terminate_process`).

## Phase H — Close-out

H.1 Autonomy anchor grep across the draft directory,
run in two forms (per S00 cookbook §3) — both must
return zero hits.

Anchor-file form (the checked-in canonical list):

```
grep -REn -i -f SPEC/analyst-as-control-surface/PLAN/forbidden-anchors.txt SPEC/analyst-as-control-surface/PLAN/drafts/009-operator-events-surface-cleanup/
```

Inline literal form (kept here so the gate is self-
contained even if the anchor file is missing or
diverges):

```
grep -REn -i -E '(spec-r[1-6]|protocol-r[1-3]|master-plan-r[1-6]|review[-]r|prior[ ]round|earlier[ ]round|previous[ ]version|previous[ ]draft|before[ ]the[ ]refactor|was[ ]superseded|older[ ]revision)' SPEC/analyst-as-control-surface/PLAN/drafts/009-operator-events-surface-cleanup/
```

The inline alternation uses single-character classes
(for example `review[-]r`, `prior[ ]round`) so the
literal forbidden anchor strings do not appear
verbatim. The `r[1-6]` digit range excludes the
currently-active spec/master-plan revision (r7) and
the `protocol-r[1-3]` digit range excludes the
currently-active protocol revision (r4), so this
stage may legitimately reference SPEC sections of the
active revisions in `design.md` without tripping the
gate.

H.2 Host-path guard. Run
`grep -REn '/wo''rk/' SPEC/analyst-as-control-surface/PLAN/drafts/009-operator-events-surface-cleanup/`
(the empty single-quote concatenation produces the
literal forward-slash-w-o-r-k-forward-slash without
matching this grep line itself). Expected: zero hits.

H.3 Emoji guard. Run
`grep -RnP '[\x{1F300}-\x{1FAFF}\x{2600}-\x{27BF}]' SPEC/analyst-as-control-surface/PLAN/drafts/009-operator-events-surface-cleanup/`.
Expected: zero hits. The `-P` flag invokes PCRE for
the Unicode range; do not substitute `-E` (it does
not support Unicode ranges in this form).

H.4 Conditional ledger close-out. Read
`SPEC/analyst-as-control-surface/PLAN/expected-breakage-ledger.md`
and identify every OPEN entry whose
`Target fix stage:` field reads `S09`. For each such
entry, verify the corresponding failing id is no
longer observed in the gate diff produced by H.9
below (this substep runs after H.9 in real time even
though it appears earlier in the plan's numbering —
Phase H.4 is conditional on H.9's diff, so the implementer
runs Phase H.9 first, returns to Phase H.4 with the
diff in hand, then proceeds to Phase H.5 through
H.8).

The paper-plan default for S09 is: zero S09-targeted
OPEN entries match. The cumulative ledger may contain
other-stage-targeted OPEN entries; per the live state
at S09 start, exactly one such entry exists —
`analyst-e2e:scenario-analyst-chat-context-child-order:step-1`
with `Target fix stage: S08` and
`Recorded by: S03 / 2026-05-25`. S09 H.4 only closes
S09-targeted entries (zero observed), so this substep
is a true no-op for S09's own purposes. Per
MASTER-PLAN-r7 only S10 owns the final reconciliation
of other-stage-targeted entries; S09 does not touch
the S08-targeted entry, does not assert anything
about its resolution, and does not claim the ledger
is empty. The substep is therefore a TRUE no-op:
zero edits to the cumulative ledger, with a single-
line note appended to
`SPEC/analyst-as-control-surface/PLAN/drafts/009-operator-events-surface-cleanup/implementation-notes.md`
(creating it on first append) of the shape
`- ledger close-out: no S09-targeted OPEN entries; true no-op.`

If the ledger as of S09 start unexpectedly carries
one or more `Target fix stage: S09` entries (paper-
plan-vs-actual divergence), the substep verifies
each entry's failing id against the gate diff and
removes the entry from the cumulative ledger if and
only if the diff confirms the failing id is no
longer observed. The corresponding single-line
evidence note in `implementation-notes.md` records
the closed id, the gate that observed the
disappearance, and the date.

H.5 Run `cd web && npm run build` and capture to
`tmp/s09-web-build-after.txt`. Required outcome: exit
code 0.

H.6 Run `npm run build` and capture to
`tmp/s09-build-after.txt`. Required outcome: exit code
0.

H.7 Run `cd web && npm test` and capture to
`tmp/s09-vitest-after-H.txt`. Required outcome: exit
code 0; zero failing tests.

H.8 Run `npm test` and capture to
`tmp/s09-jest-after-H.txt`. Required outcome: exit
code 0; zero failing tests.

H.9 Gate diff. From `saivage-v3/`, run
`bash SPEC/analyst-as-control-surface/PLAN/scripts/run-gates.sh --diff SPEC/analyst-as-control-surface/PLAN/baseline-gates.json`
and capture to `tmp/s09-gates-after.txt`. Required
outcome: exit code 0; zero NEW failing ids on every
gate. REPAIRED rows are permitted only if H.10's
conditional baseline edit actually fires (which the
paper-plan default forbids).
`diff tmp/s09-gates-before.txt tmp/s09-gates-after.txt`
for the close-out comment block.

H.10 Conditional baseline refresh. Read
`tmp/s09-baseline-before.json`. S09 adds new vitest
files (Phase E.1, E.2, E.3) and a new jest file
(Phase E.4). For each new file, check whether any
gate `failing_ids` entry references the file (the
paper-plan default: no — new test files start green
and the baseline does not pre-record green files).
The condition is therefore guaranteed false; the
paper-plan default outcome is a no-op on
`baseline-gates.json`. Confirm via
`diff tmp/s09-baseline-before.json SPEC/analyst-as-control-surface/PLAN/baseline-gates.json`
which must produce an empty diff.

H.11 **Breakage triage** — S10-targeted conditional
forecast append.
After H.9 has produced its gate diff, the implementer
reviews the diff for NEW failing ids on the four
gates. For each such NEW failing id whose root cause
is NOT inside S09's scope and which holistic-fix-first
(MASTER-PLAN section 3 rule (3)) cannot resolve
in-stage, append exactly one H3-headed block to
`SPEC/analyst-as-control-surface/PLAN/expected-breakage-ledger.md`
following the authoritative schema in
`expected-breakage-ledger.md` and MASTER-PLAN
section 6.1: one H3 entry per failing id, followed by
four labeled single-line fields in this exact order:

```md
### <gate>:<failing-id>
Failure mode: <one sentence>
Reason acceptable now: <SPEC requirement or earlier-stage decision>
Target fix stage: S10
Recorded by: S09 / <YYYY-MM-DD>
```

The `Target fix stage:` value is exactly `S10` —
NEVER `S09` itself per MASTER-PLAN section 3 rule
(8): a stage never forecasts breakage for its own
scope. The append shape is NEVER a single-line
checklist (`- [ ] ...`) — the cumulative ledger uses
only the H3/labeled-line schema above. The paper-plan
default outcome is zero such failures observed (S09
is a pure deletion stage covering symbols verified by
the Phase A inventory grep to be unreferenced outside
the files being edited; the four new test files
start green; the read-only-positive-checklist
extension is byte-additive to a regex that already
covers the deleted tokens' siblings; and the
`debug-view-child-order.test.ts` mock-keys deletion
is a narrow removal of two unused mock entries the
test scenario does not exercise), so the
cumulative ledger is byte-unchanged from H.4's
post-state. Confirm by
`diff tmp/s09-ledger-before.md SPEC/analyst-as-control-surface/PLAN/expected-breakage-ledger.md`
which is expected to show ZERO diff lines.

H.12 Final guard re-runs. Repeat H.1, H.2, H.3 against
the draft directory to confirm no transient violation
slipped in during H.4–H.11. Expected: zero hits on
each. Also re-run
`bash SPEC/analyst-as-control-surface/PLAN/scripts/check-stage-links.sh SPEC/analyst-as-control-surface/PLAN/drafts/009-operator-events-surface-cleanup/`
to confirm all in-draft links still resolve. Required
outcome: exit code 0.

H.13 Publication via atomic rename. Confirm the draft
directory and the target stages directory are on the
same filesystem:
`stat -c '%d' SPEC/analyst-as-control-surface/PLAN/drafts/009-operator-events-surface-cleanup`
and
`stat -c '%d' SPEC/analyst-as-control-surface/PLAN/stages`
must report the same device id. Capture pre-publication
file hashes:
`sha256sum SPEC/analyst-as-control-surface/PLAN/drafts/009-operator-events-surface-cleanup/{design.md,plan.md} > tmp/s09-pre-publish-hashes.txt`
(and include `implementation-notes.md` in the hash set
if H.4 created it). Publish:
`mv SPEC/analyst-as-control-surface/PLAN/drafts/009-operator-events-surface-cleanup SPEC/analyst-as-control-surface/PLAN/stages/009-operator-events-surface-cleanup`.
Verify post-publication:
`ls -la SPEC/analyst-as-control-surface/PLAN/stages/009-operator-events-surface-cleanup/`
shows `design.md` and `plan.md` present (and
`implementation-notes.md` if H.4 created it), and
`sha256sum SPEC/analyst-as-control-surface/PLAN/stages/009-operator-events-surface-cleanup/{design.md,plan.md}`
matches the pre-publication hashes byte-for-byte.

The cumulative ledger
(`SPEC/analyst-as-control-surface/PLAN/expected-breakage-ledger.md`)
is the only file outside the draft directory that S09
modifies (via H.4's conditional close-out and H.11's
conditional forecast append). The cumulative ledger
holds OPEN entries only, per S00's
ledger-as-open-entries-only contract; the per-stage
attribution log lives in the stage-local
`implementation-notes.md` file (written by H.4, if
at all).
