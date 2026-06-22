# S06 — UI mutation removal, read-only preservation, ordered-child rendering — plan

## Working directory

All commands below run from the workspace root
[saivage-v3/](../../../../) unless explicitly noted with
`cd web` (which means `saivage-v3/web/`) or with a different
absolute path. Paths in this document are workspace-relative
to `saivage-v3/` unless they start with `SPEC/` (in which case
they are relative to `saivage-v3/`) or with `/home/` (absolute).

## Phase A — Prep and inventory

A.1 Snapshot the current cumulative ledger
`SPEC/analyst-as-control-surface/PLAN/expected-breakage-ledger.md`
into `tmp/s06-ledger-before.md` so Phase H.4's close-out
comparisons have a fixed point of reference. Verify the file
is shape-correct (each entry has the eight required fields per
S00's ledger schema) before proceeding.

A.2 Snapshot the current baseline snapshot
`SPEC/analyst-as-control-surface/PLAN/baseline-gates.json`
into `tmp/s06-baseline-before.json` (byte-for-byte copy).
Phase H.5 compares the post-edit snapshot to this one.

A.3 Snapshot the four S00 gates as-of S06 start. From
`saivage-v3/`, run
`bash SPEC/analyst-as-control-surface/PLAN/scripts/run-gates.sh --diff SPEC/analyst-as-control-surface/PLAN/baseline-gates.json`
and capture stdout+stderr into `tmp/s06-gates-before.txt`. Confirm
exit code 0; if non-zero, the stage cannot start.

A.4 Inventory every mutating client function call site under
`web/src/`. Run
`grep -RnE '\b(createCard|updateCard|deleteCard|startProject|stopProject|pauseRuntime|resumeRuntime|freezeRuntime|resumeRuntimeFromFreeze|acknowledgeNote|deleteNote|clearAllNotes|acknowledgeNotification|terminateProcess)\b' web/src/ > tmp/s06-call-sites-before.txt`.
Capture for the post-stage comparison; the corresponding
Phase H grep MUST return zero non-test hits.

A.5 Inventory mounting points of `NotificationsPanel.vue`.
Run
`grep -RnE 'NotificationsPanel' web/src/ > tmp/s06-notifications-panel-importers.txt`.
The only importer in current source is
`web/src/views/DebugView.vue` (the import declaration at line
388 and the `<NotificationsPanel />` mount at line 125). The
Phase F.7 batch updates that single importer; F.12 deletes the
component file itself.

A.6 Inventory `notification_acknowledged` ws-event references
(left over after S04's removal). Run
`grep -RnE 'notification_acknowledged' web/src/ > tmp/s06-na-event-refs.txt`.
The Phase F.11 batch deletes each surviving reference.

A.7 Inventory mutating keyboard shortcuts. Run
`grep -RnE 'handleKeydown|onKeydown|keydown\.' web/src/ > tmp/s06-keydown-sites.txt`
and confirm that, post-S05, only `AppShell.vue` and the
read-only navigation handlers in `CardsView.vue` and
`CardsTreeView.vue` appear. Any other handler is reviewed in
Phase F for mutating shortcuts.

A.8 Confirm Phase B's deletions will not collide with S05
edits. Run
`grep -RnE 'sendChatMessage|seedCardContext|issueWebSocketTicket' web/src/`
and confirm each of the three is referenced exactly where
S05's design says it should be (chat composer, analyst chat
store seed action, websocket bootstrap path). Phase B does not
touch these.

## Phase B — Web client mutation removal

B.1 Open `web/src/api/client.ts`. Delete the function
declaration `createCard` and its surrounding doc comment.

B.2 In the same file, delete `updateCard`, `deleteCard`,
`startProject`, `stopProject`, `pauseRuntime`, `resumeRuntime`,
`freezeRuntime`, `resumeRuntimeFromFreeze`.

B.3 In the same file, delete `acknowledgeNote`, `deleteNote`,
`clearAllNotes`, `acknowledgeNotification`, `terminateProcess`.

B.4 Re-grep the file:
`grep -nE '\b(createCard|updateCard|deleteCard|startProject|stopProject|pauseRuntime|resumeRuntime|freezeRuntime|resumeRuntimeFromFreeze|acknowledgeNote|deleteNote|clearAllNotes|acknowledgeNotification|terminateProcess)\b' web/src/api/client.ts`.
Expected: zero hits.

B.5 Re-grep the file for preserved surfaces:
`grep -nE '\b(issueWebSocketTicket|sendChatMessage)\b' web/src/api/client.ts`.
Expected: at least one hit per name; the bounded-bootstrap
mutator and the analyst chat write must still be present.

B.6 Open `web/src/api/types.ts`. Delete `CreateCardPayload`,
`UpdateCardPayload`, `CardCreateResponse`, `CardUpdateResponse`,
`RuntimeCommandResponse`, `FreezeResponse`,
`ResumeFromFreezeResponse`, `NotesClearResponse`,
`NotificationAcknowledgeResponse`, `ProcessTerminateResponse`,
and any helper type used only by the deleted functions
(`SuppressUntil`, narrower per-operation request shapes). Run
`grep -nE 'CreateCardPayload|UpdateCardPayload|CardCreateResponse|CardUpdateResponse|RuntimeCommandResponse|FreezeResponse|ResumeFromFreezeResponse|NotesClearResponse|NotificationAcknowledgeResponse|ProcessTerminateResponse' web/src/api/types.ts`
and confirm zero hits. In the same file, ADD an optional
`position?: number` field to the `CardRecord` interface
(currently declared at lines 46-79; insert the new field
immediately after the existing `parent: string | null` line so
the two ordering-related fields sit together). The field is
declared optional so legacy fixtures that omit it still
compile; the backend already persists `position` on every card
(root cards pinned at `position: 0`, per-parent contiguous
indices, sorted into `parentsAdj` on ties by id — see
`saivage-v3/src/cards/state.ts` lines 126, 192, and 483-496),
so the field is supplied on every card listing response in
practice and C.7's `childrenOf` sort relies on it. Run
`grep -nE 'position\?:\s*number' web/src/api/types.ts` and
confirm at least one hit inside the `CardRecord` interface.

## Phase C — Cards store mutation removal

C.1 Open `web/src/stores/cards.ts`. Delete the named imports
of `createCard`, `updateCard`, `deleteCard` from
`../api/client`. The import statement at the top of the file
becomes the smaller surviving set (e.g. `listCards`,
`getCard`, any read function the store consumes).

C.2 In the same file, delete the entire action function whose
body wraps the deleted `createCard` client. Delete its entry
from the store's returned object literal.

C.3 In the same file, delete the action function wrapping
`updateCard` and its entry from the returned object.

C.4 In the same file, delete the action function wrapping
`deleteCard` and its entry from the returned object.

C.5 Add the `isStale(cardId: string): boolean` getter to the
store per `design.md > ## Approach > Stale-warning-ribbon
rewrite`. Body: `return staleNotificationByCard.value[cardId]
=== true`. The existing `staleNotificationByCard` ref (line
128) and `currentCardHasStaleWarning` computed (lines 168-170)
are left intact; the new getter is a parametric form of the
same predicate. Add the getter to the store's returned object
literal (the block beginning around line 516).

C.6 Add a unit-test arm for the new `isStale` getter to
`web/src/__tests__/card-store.test.ts`. The arm constructs a
cards-store instance with the test harness, calls
`setCardStaleNotification('card-a', true)` and
`setCardStaleNotification('card-b', false)`, then asserts
`cardsStore.isStale('card-a') === true`,
`cardsStore.isStale('card-b') === false`, and
`cardsStore.isStale('card-unknown') === false`. The arm sits
alongside the read-only-projection assertions added in the
same file rewrite (per `design.md > ## Surfaces touched >
Tests > card-store.test.ts`).

C.7 Add the `childrenOf(parentId: string): CardRecord[]` getter
to the store per `design.md > ## Approach > Ordered-child
rendering`. Body filters the full card list (the `cards` ref
declared at line 98) by `c.parent === parentId`, slices to a
fresh array, and sorts ascending by `position` with an id
tiebreaker for null or equal positions. Concretely:
`return cards.value.filter((c) => c.parent === parentId)
.slice().sort((a, b) => { const pa = a.position ??
Number.POSITIVE_INFINITY; const pb = b.position ??
Number.POSITIVE_INFINITY; if (pa !== pb) return pa - pb;
return a.id.localeCompare(b.id); })`. Add the getter to the
store's returned object literal (block beginning around line
497, alongside the new `isStale` entry from C.5). The `position`
field on `CardRecord` is the S03-shipped persisted ordinal;
S06 consumes it without modifying the field's serialization or
the per-card snapshot contract.

C.8 Add a unit-test arm for the new `childrenOf` getter to
`web/src/__tests__/card-store.test.ts`. The arm seeds the
store's `cards` ref with five fixture records sharing
`parent = 'goal-a'` and `position` values `[3, 1, null, 1,
2]` plus distinct ids `['c-e', 'c-b', 'c-d', 'c-a', 'c-c']`,
then asserts `cardsStore.childrenOf('goal-a').map((c) => c.id)`
returns `['c-b', 'c-a', 'c-c', 'c-e', 'c-d']` (position-asc
with id-localeCompare tiebreaker for the two `position = 1`
entries and the null-position entry sinking last with id
tiebreaker). A second assertion asserts
`cardsStore.childrenOf('goal-unknown')` returns `[]`. The arm
sits alongside the `isStale` arm added in C.6.

C.9 Re-grep the file:
`grep -nE '\b(createCard|updateCard|deleteCard)\b' web/src/stores/cards.ts`.
Expected: zero hits. Also confirm the new `isStale` and
`childrenOf` getters are exported by inspecting the file's
bottom-of-file `return { ... }` block (both getter names must
appear in that literal).

## Phase D — Runtime store mutation removal

D.1 Open `web/src/stores/runtime.ts`. Delete the named imports
of `pauseRuntime`, `resumeRuntime`, `startProject`,
`stopProject` from `../api/client`.

D.2 In the same file, delete the `startProject` action
function and its returned-object entry.

D.3 In the same file, delete the `stopProject` action
function and its returned-object entry.

D.4 In the same file, delete the pause / resume action
functions and their returned-object entries.

D.5 In the same file, audit the store's state slice for
any field whose only writer was a deleted action
(`startProjectInFlight`, `stopProjectInFlight`,
`runtimeCommandError`, etc.). Delete any such field and its
initializer.

D.6 Re-grep the file:
`grep -nE '\b(pauseRuntime|resumeRuntime|startProject|stopProject|freezeRuntime|resumeRuntimeFromFreeze)\b' web/src/stores/runtime.ts`.
Expected: zero hits.

## Phase E — Debug store mutation removal

E.1 Open `web/src/stores/debug.ts`. Delete the named imports
of `terminateProcess`, `acknowledgeNote`, `deleteNote`,
`clearAllNotes`, `pauseRuntime`, `resumeRuntime`,
`acknowledgeNotification` from `../api/client`.

E.2 In the same file, delete the `terminateProcess` action
and its returned-object entry.

E.3 In the same file, delete the `acknowledgeNote` action
and its returned-object entry.

E.4 In the same file, delete the `deleteNote` action and its
returned-object entry.

E.5 In the same file, delete the `clearAllNotes` action and
its returned-object entry.

E.6 In the same file, delete the `pauseRuntime` and
`resumeRuntime` actions and their returned-object entries.

E.7 In the same file, delete the `acknowledgeNotification`
action and its returned-object entry.

E.8 Re-grep the file:
`grep -nE '\b(terminateProcess|acknowledgeNote|deleteNote|clearAllNotes|pauseRuntime|resumeRuntime|acknowledgeNotification)\b' web/src/stores/debug.ts`.
Expected: zero hits.

## Phase F — Views and components mutation removal

F.1 Open `web/src/views/CardsView.vue`. Delete the new-card
composer block (the `<form>` or `<section>` that wraps the
title / priority inputs and the Create button) and its
`<script setup>` handler (the function whose body calls the
deleted store action). Delete any `ref()` declaration whose
only readers were the deleted form (`newTitle`,
`newPriority`, `creating`, etc.).

F.2 In the same file, delete the per-row delete button and
its `@click` handler. Delete the action menu component / slot
and its `@select` handler. Delete the drag-to-reparent
plumbing (`@drop`, `@dragover`, `@dragstart` arms whose
handler called a deleted store action). Delete any
mutating-shortcut entry from the file's `handleKeydown` (e.g.
the `N` for new card and `Delete` for delete-selected arms).

F.3 In the same file, rewrite copy / help text that referred
to the deleted controls. Save and verify with
`grep -c '<script setup' web/src/views/CardsView.vue` (must
return `1`, per the workspace SFC-corruption guard).

F.4 Open `web/src/views/DashboardView.vue`. Delete the two
runtime-command buttons at lines 112-113 (the "Start Project"
and "Stop Project" elements identified by their
`runtime-command start-project` /
`runtime-command stop-project` markers). Note that no
`<NotificationsPanel />` mount or `NotificationsPanel` import
exists in this file in current source (`tmp/s06-notifications
-panel-importers.txt` from Phase A.5 confirms `DebugView.vue`
is the only importer); no panel-related edit is applied here.
The NotificationsPanel mount and its import are removed by
Phase F.7 from `DebugView.vue` and the file itself is deleted
by Phase F.12.

F.5 In the same file, delete the `async function
startProject()` and `async function stopProject()` wrappers
near lines 565-580 and any `ref()` declarations whose only
readers were those wrappers. The new dashboard child-of-goal
panel that satisfies the MASTER-PLAN-r7 S06 ordered-child
acceptance is added by F.16 below (sequenced after the F.1-F.13
mutation-affordance deletions so the deletion pass does not
transiently break the new panel's mount).

F.6 Verify the file:
`grep -c '<script setup' web/src/views/DashboardView.vue`
must return `1`;
`grep -nE 'runtime-command start-project|runtime-command stop-project' web/src/views/DashboardView.vue`
must return zero. The `NotificationsPanel` token is NOT
included in this grep because the panel was never present in
this file in S06 baseline source; F.7 owns the panel removal
from DebugView.

F.7 Open `web/src/views/DebugView.vue`. Delete the per-process
Terminate button column, the pause / resume control row, the
per-note Acknowledge and Delete row, the "Clear all notes"
button, and any per-notification Acknowledge surface. Delete
the corresponding `<script setup>` handlers. In the same
edit batch, delete the `<NotificationsPanel />` mount at
line 125 and the `import NotificationsPanel from
'../components/cards/NotificationsPanel.vue'` declaration at
line 388. The new per-card child-list section that satisfies
the MASTER-PLAN-r7 S06 ordered-child acceptance is added in
substep F.18 below (sequenced after F.1-F.13 so the deletion
pass pass does not transiently break the new section's mount).

F.8 Open `web/src/views/FilesView.vue`. Audit-only pass: run
`grep -nE 'createCard|updateCard|deleteCard|terminateProcess|startProject|stopProject|pauseRuntime|resumeRuntime' web/src/views/FilesView.vue`
and confirm zero hits. The new per-card child listing that
satisfies the MASTER-PLAN-r7 S06 ordered-child acceptance is
added by F.17 below (sequenced after F.1-F.13).

F.9 Open `web/src/components/cards/CardsTreeView.vue`. Delete
the drag-to-reparent handlers (`@dragstart`, `@dragover`,
`@drop` arms calling a deleted store action), the per-node
action menu, every context-menu entry that called
`updateCard` or `deleteCard`, and the keyboard shortcuts that
mutate. Do not change the child-rendering source of truth in
this file: the cards tree is an S03-owned surface per
MASTER-PLAN-r7 §4.1 (its child rendering and `position` sort
are S03 contracts), and S06's responsibility ends at deleting
the mutating affordances.

F.10 Open `web/src/components/cards/CardDetailView.vue`.
Delete the Edit / Save / Delete / Restart /
Mark-needing-corrections / Abort-subtree buttons and their
`<script setup>` handlers. Keep the `openAnalystForCard`
seed handler intact (S05 contract). Do not change the child-
listing source of truth: the detail-view child list is an
S03-owned surface per MASTER-PLAN-r7 §4.1.

F.11 Open `web/src/components/cards/CardHistoryPanel.vue`. Run
`grep -nE 'createCard|updateCard|deleteCard|restartCard|terminateProcess' web/src/components/cards/CardHistoryPanel.vue`.
If any hit is found, delete the offending line and any
handler it referenced. Rewrite copy text that referenced
removed controls.

F.12 Delete `web/src/components/cards/NotificationsPanel.vue`
outright:
`git rm web/src/components/cards/NotificationsPanel.vue`. (Use
the editor's file-delete to keep the working tree consistent;
the equivalent shell `rm` is acceptable.) Per Phase A.5's
inventory the only importer is `web/src/views/DebugView.vue`,
and F.7 already removed the mount at line 125 and the import
at line 388 from that file; re-grep the entire `web/src/` tree
with
`grep -RnE 'NotificationsPanel' web/src/`
and confirm zero hits. There is no DashboardView edit to
make here.

F.13 Open `web/src/components/cards/StaleWarningRibbon.vue`.
Delete the ws-event listener arm that consumed
`notification_acknowledged`. Rewrite the ribbon's visibility
condition to `cardsStore.isStale(currentCard.value.id)` (the
getter added in Phase C.5). Delete any explicit
"acknowledge" button and its handler.

F.14 Re-grep the entire `web/src` tree:
`grep -RnE '\b(createCard|updateCard|deleteCard|startProject|stopProject|pauseRuntime|resumeRuntime|freezeRuntime|resumeRuntimeFromFreeze|acknowledgeNote|deleteNote|clearAllNotes|acknowledgeNotification|terminateProcess)\b' web/src/`
Expected: zero hits in any non-test file.

F.15 Verify no Vue SFC was corrupted by the multi-step edits.
Run
`for f in $(git ls-files 'web/src/**/*.vue'); do c=$(grep -c '<script setup' "$f"); [ "$c" != "1" ] && echo "CORRUPT $c $f"; done`.
Expected: empty output.

F.16 Open `web/src/views/DashboardView.vue` again. Add a new
read-only `child-of-goal` panel that lists the children of the
displayed goal card. Concretely:
(a) add `import { useCardStore } from '../stores/cards';` to
the `<script setup>` import block;
(b) instantiate `const cardsStore = useCardStore();` alongside
the existing store wiring;
(c) add a single canonical `const displayedGoalId =
computed<string | null>(() => cardsStore.currentCard?.id ??
null)` const. The cards-store `currentCard` ref is the
selection surface S05 already wired the right-panel to and is
exported as a writable ref on the cards store's returned
object literal (`web/src/stores/cards.ts` line 502); it is
the canonical "currently displayed card" source across all
three S06-owned views;
(d) compute `const goalChildren = computed<CardRecord[]>(()
=> displayedGoalId.value ? cardsStore.childrenOf(displayedGoalId.value) : [])`;
(e) add a `<section class=\"child-of-goal-panel\"
data-testid=\"dashboard-child-of-goal-panel\">` block under
the existing goal-render area whose body is `<ul
data-testid=\"child-of-goal-list\"><li
v-for=\"child in goalChildren\" :key=\"child.id\"
data-testid=\"child-of-goal-item\"><span class=\"title\">{{ child.title }}</span><span class=\"status\">{{ child.status }}</span></li></ul>`;
(f) add zero `@click`, `@drag`, or `@submit` arms — the panel
renders title plus status only and exposes no mutating
affordance, satisfying SPEC-r7's read-only-affordance
preservation rule for the new surface. Re-run
`grep -c '<script setup' web/src/views/DashboardView.vue`
(must return `1`).

F.17 Open `web/src/views/FilesView.vue`. Add a per-card child
listing that renders when the currently-displayed parent card
has children. Concretely:
(a) add `import { useCardStore } from '../stores/cards';` and
`import type { CardRecord } from '../api/types';` to the
`<script setup>` import block (the second import is added only
if `CardRecord` is not already imported);
(b) instantiate `const cardsStore = useCardStore();` alongside
the existing `const fileStore = useFileStore();` declaration
(line 138);
(c) the current FilesView reads `useRoute()` at line 137 but
the `/files` route declaration in `web/src/main.ts` carries no
card-bound param (the view only consumes `route.query.path`),
so there is no route-derived active-card id to reuse; instead
add a canonical `const activeCardId = computed<string | null>(
() => cardsStore.currentCard?.id ?? null)` const. This mirrors
the DashboardView `displayedGoalId` source from F.16 so all
three new sections share one consistent store-driven selection
surface; no router change is required because selection is
store-driven via S05;
(d) compute `const cardChildren = computed<CardRecord[]>(()
=> { const id = activeCardId.value; return id ?
cardsStore.childrenOf(id) : []; })`;
(e) add a `<section class=\"card-children-listing\"
data-testid=\"files-view-card-children\"
v-if=\"cardChildren.length > 0\">` block under the existing
per-card grouping area whose body is `<ul
data-testid=\"files-card-children-list\"><li
v-for=\"child in cardChildren\" :key=\"child.id\"
data-testid=\"files-card-children-item\"><span class=\"title\">{{ child.title }}</span><span class=\"status\">{{ child.status }}</span></li></ul>`;
(f) add zero mutating arms. Re-run
`grep -c '<script setup' web/src/views/FilesView.vue`
(must return `1`).

F.18 Open `web/src/views/DebugView.vue` again. Add a per-card
child-list section that renders, for each card currently shown
in the debug surface, the card's children in `position` order.
Concretely:
(a) DebugView already iterates `debugStore.debugCards` in its
existing card-render `v-for` (see lines 52, 390, and 394 of
`web/src/views/DebugView.vue`) — the new section is added
inside that existing loop and joins each `debugCard.id` into
the cards store via `cardsStore.childrenOf(debugCard.id)`.
This substep adds `import { useCardStore } from
'../stores/cards';` to the `<script setup>` import block (the
existing DebugView imports `useDebugStore` only);
(b) instantiate `const cardsStore = useCardStore();` alongside
the existing `const debugStore = useDebugStore();`;
(c) inside the existing `v-for=\"card in debugStore.debugCards\"`
loop, add a nested block
`<section class=\"card-children-section\"
data-testid=\"debug-view-card-children\"
v-if=\"cardsStore.childrenOf(card.id).length > 0\">` whose
body is `<ul data-testid=\"debug-card-children-list\"><li
v-for=\"child in cardsStore.childrenOf(card.id)\"
:key=\"child.id\"
data-testid=\"debug-card-children-item\"><span class=\"title\">{{ child.title }}</span><span class=\"status\">{{ child.status }}</span></li></ul>`;
(d) add zero mutating arms. The DebugView continues to drive
the outer card loop from `debugStore.debugCards` (the debug
surface's flat card listing); only the inner child rendering
joins into the cards store. Re-run
`grep -c '<script setup' web/src/views/DebugView.vue`
(must return `1`).

## Phase G — Stale-warning rewrite, live probe, test rewrites, conditional baseline refresh

G.1 Confirm Phase C.5's `isStale(cardId)` getter and Phase
C.7's `childrenOf(parentId)` getter are exported and behave
per the design spec. The unit assertions in
`card-store.test.ts` (added by Phase C.6 and Phase C.8)
validate the three-way truth table for `isStale` and the
position-asc plus id-tiebreaker ordering contract for
`childrenOf` (including the empty-result case for an unknown
parent id).

G.2 Open every test file enumerated in
`design.md > ## Surfaces touched > Tests`. For each
rewrite, delete the assertion arms that exercised a removed
control or mocked a deleted client function, and add an arm
asserting absence of the corresponding DOM element. The three
new shuffled-`position` fixture tests for the Dashboard,
Files, and Debug child-render surfaces are introduced as new
standalone test files in G.5 below (not added inline to the
existing per-view test files, to keep the close-out gate
attribution unambiguous). Do add a store-driven `isStale` arm
to `stale-warning-ribbon.test.ts` per `design.md > ## Surfaces
touched > Tests`, and do add the read-only-projection +
`isStale` + `childrenOf` arms to `card-store.test.ts` per
Phase C.6 and C.8.

G.3 Delete `web/src/__tests__/notifications-panel.test.ts`
outright via the editor's file delete.

G.4 Create `web/src/__tests__/read-only-positive-checklist.test.ts`.
Body asserts at least one read-only control of each
SPEC-listed category remains operational on each
representative view (`CardsView`, `DashboardView`,
`FilesView`, `AgentsView`, `DebugView`): refresh, filter,
sort, search, expand / collapse, copy, navigate. The file
uses the same vue-test-utils + pinia harness as the existing
view tests.

G.5 Create three new standalone vitest files under
`web/src/__tests__/` to assert the ordered-child rendering
the MASTER-PLAN-r7 S06 acceptance requires. Each test fixture
seeds the cards store with a shuffled `position` vector across
a parent card's children and asserts the rendered DOM order
matches the position-asc ordering returned by
`cardsStore.childrenOf`. Test ids match the S03 forecast
naming (per `00-MASTER-PLAN-r7.md` §S03):

(a) `web/src/__tests__/dashboard-child-order.test.ts` mounts
`DashboardView.vue`. Setup order: import `useCardStore` from
`../stores/cards`, instantiate the cards store under a fresh
Pinia, seed `cardsStore.cards.value` with a goal card
`{ id: 'goal-a', parent: null, position: 0, type: 'goal',
status, title, priority, depends_on: [], blocks: [] }` plus
five children sharing `parent = 'goal-a'` and `position`
values `[3, 1, null, 1, 2]` with distinct ids
`['c-e', 'c-b', 'c-d', 'c-a', 'c-c']`. Then set
`cardsStore.currentCard = <the goal-a record>` (the cards-
store `currentCard` is a writable ref exposed via the store's
returned object literal at `web/src/stores/cards.ts` line
502; direct ref-write is the documented test-seeding API,
matching how DashboardView's `displayedGoalId` resolves under
F.16). Mount `DashboardView.vue`; await next tick; query the
panel rendered by F.16
(`[data-testid="child-of-goal-list"]
[data-testid="child-of-goal-item"] .title`); assert the
resulting array of titles matches the position-asc plus
id-localeCompare-tiebreaker ordering. The test's vitest id
is `scenario-dashboard-child-order:step-1`.
(b) `web/src/__tests__/files-view-child-order.test.ts` mounts
`FilesView.vue` with no route-param dependency (the `/files`
route declaration in `web/src/main.ts` carries no card-bound
param; the view's active-card source under F.17 is store-
driven). Setup order: instantiate the cards store under a
fresh Pinia, seed `cardsStore.cards.value` with a parent card
`{ id: 'parent-a', parent: null, position: 0, ... }` plus
five children sharing `parent = 'parent-a'` and a shuffled
`position` vector matching (a)'s shape with distinct ids.
Then set `cardsStore.currentCard = <the parent-a record>`
(same writable-ref pattern as (a); this is the source F.17's
`activeCardId` resolves through). Mount `FilesView.vue`;
await next tick; query
`[data-testid="files-card-children-list"]
[data-testid="files-card-children-item"] .title`; assert
position-asc plus id-tiebreaker order. Vitest id is
`scenario-files-view-child-order:step-1`.
(c) `web/src/__tests__/debug-view-child-order.test.ts` mounts
`DebugView.vue`. Setup order: at the top of the test file use
`vi.mock('../api/client', () => ({ getDebugState: vi.fn() }))`
and configure the mock to resolve to `{ runtime: null, cards:
[{ id: 'debug-parent', type: 'goal', parent: null, status,
title, priority, depends_on: [], blocks: [], position: 0 }],
totalCards: 1, processes: [], notes: [], notifications: [] }`
(the full `DebugStateResponse` shape consumed by the debug
store; see `web/src/stores/debug.ts` lines 318-330 where
`fetchState` reads `getDebugState`'s response and populates
`debugCards`). Instantiate `useDebugStore` and
`useCardStore` under a fresh Pinia; `await
debugStore.fetchState()` so `debugStore.debugCards.value`
contains the single `debug-parent` row (the debug store
exposes `debugCards` as `readonly(...)` at
`web/src/stores/debug.ts` line 748, so it cannot be seeded by
direct ref-write — the `fetchState`-via-mocked-client path is
the documented load path). Seed `cardsStore.cards.value`
with five children sharing `parent = 'debug-parent'` and a
shuffled `position` vector with distinct ids (the outer
`v-for` in DebugView iterates `debugStore.debugCards` per
F.18; the inner `cardsStore.childrenOf(card.id)` call reads
the cards store seeded here). Mount `DebugView.vue`; await
next tick; query `[data-testid="debug-card-children-list"]
[data-testid="debug-card-children-item"] .title`; assert
position-asc plus id-tiebreaker order. Vitest id is
`scenario-debug-view-child-order:step-1`.

The three test files contain no mutation mocks and no
`@click` simulations; they exercise only the ordered-render
contract S06 introduces in F.16, F.17, and F.18.

G.6 Provision the throwaway fixture project root for the
phase substep H.7 live probe at
`saivage-v3/tmp/check-mutation-traffic-fixture/` per
`design.md > ## Approach > Bootstrap-boundary live probe`.
This substep does NOT create the directory at plan time —
the phase substep H.7 script (`check-mutation-traffic.sh`,
created in G.7) creates and tears down the directory on
every invocation. This substep merely:
(a) confirms `saivage-v3/.gitignore` already excludes `tmp/`
(run `grep -nE '^tmp/?$|^/tmp/?$' saivage-v3/.gitignore` and
expect at least one hit; if missing, add `tmp/` to the
ignore file as a single-line edit);
(b) confirms no real-state path (the operator's actual
`saivage-v3/.saivage/` directory) appears anywhere in the
script's source by phase substep G.7 close;
(c) records that the fixture seed values are: `auth-profiles
.json` with a single profile `{ "id": "fixture", "label":
"Fixture", "apiKey": "FIXTURE-FAKE-NOT-A-REAL-KEY",
"baseUrl": "http://invalid.test.local", "providerKind":
"stub" }`, `saivage.json` with the minimum schema-valid
project doc the v3 runtime requires for bootstrap (per the
v3 schema in `backend/src/schema/`), and no other files.
The literal string `FIXTURE-FAKE-NOT-A-REAL-KEY` is the only
secret-shaped value the script writes; it is not a real
provider key and the script writes it directly (no env-var
indirection, no copy from any real profile file).

G.7 Add
`SPEC/analyst-as-control-surface/PLAN/scripts/check-mutation-traffic.sh`
per `design.md > ## Approach > Bootstrap-boundary live probe`.
The script must:
(a) accept `--base-url`, `--token`, `--bootstrap-state
{empty,configured}` flags;
(b) `rm -rf saivage-v3/tmp/check-mutation-traffic-fixture/`
and recreate it fresh at the start of every invocation, then
seed `saivage-v3/tmp/check-mutation-traffic-fixture/.saivage/
auth-profiles.json` and `saivage-v3/tmp/check-mutation-
traffic-fixture/.saivage/saivage.json` per the requested
bootstrap state and the seed values declared in G.6
(literal-fake key only; the script MUST NOT read or copy
from any real `.saivage/` directory anywhere on disk);
(c) point the dev server at the fixture root by exporting
`SAIVAGE_PROJECT_ROOT=saivage-v3/tmp/check-mutation-traffic-
fixture` (or the equivalent CLI flag `--project-root`) before
the script's playwright phase begins, so the running v3
backend reads only the throwaway fixture and never the
operator's real state;
(d) spawn a playwright browser, log in, visit each operator
view in sequence, capture every outgoing HTTP request via
`page.on('request', ...)`, and assert each captured
non-`GET` request is in the bounded-bootstrap allow-list
`['POST /api/auth/ws-ticket', 'POST /api/auth/login', 'POST /api/auth/logout', 'POST /api/auth/provider-secret', 'POST /api/chats/']`;
(e) exit 1 with the offending request triple
`(method, url, view)` on any miss;
(f) `rm -rf saivage-v3/tmp/check-mutation-traffic-fixture/`
on exit (both success and failure paths) so no fixture state
lingers between runs;
(g) exit 0 otherwise.
Mark the script executable:
`chmod +x SPEC/analyst-as-control-surface/PLAN/scripts/check-mutation-traffic.sh`.

G.8 Run `cd web && npx vitest run --reporter=json --outputFile=../tmp/web-vitest-report.json --silent`
from `saivage-v3/`. Expected: zero failing tests, including
the three new child-order tests added by G.5 (each must PASS
because F.16, F.17, F.18 added the corresponding panels). If
any test fails, return to Phase F / Phase G.2 / Phase G.5 and
reconcile; do not proceed to Phase H until vitest is green.

G.9 Run `cd web && npm run build` from `saivage-v3/`.
Expected: build succeeds. If the build emits a TypeScript
error pointing at a residual reference to a deleted client
function or store action, return to Phase F.14 / Phase B.4
grep loops and fix.

G.10 Conditional baseline refresh. Read
`tmp/s06-baseline-before.json`. For each rewritten /
deleted test id (the full normalized id produced by the
`web-vitest` gate; the test file names listed in
`design.md > ## Surfaces touched > Tests` × the assertion-arm
substring), check whether the id appears in the `web-vitest`
gate's `failing_ids` array. If yes, edit
`SPEC/analyst-as-control-surface/PLAN/baseline-gates.json`
to remove that id from the array; do not bump `captured_at`,
do not change `comparison_rule`, do not change `command`, do
not change any other field. If no matching id is present in
the array, do not touch the baseline file at all (S00
forbids opportunistic refresh). Confirm with
`diff tmp/s06-baseline-before.json SPEC/analyst-as-control-surface/PLAN/baseline-gates.json`
that the diff is either empty (no matching ids) or limited
to the `failing_ids` array of the `web-vitest` gate.

## Phase H — Close-out

H.1 Autonomy anchor grep across the draft directory, run in
two forms (per S00 cookbook §3) — both must return zero hits.

Anchor-file form (the checked-in canonical list):

```
grep -REn -i -f SPEC/analyst-as-control-surface/PLAN/forbidden-anchors.txt SPEC/analyst-as-control-surface/PLAN/drafts/006-ui-mutation-removal-ordered-rendering/
```

Inline literal form (kept here so the gate is self-contained
even if `forbidden-anchors.txt` is missing or diverges):

```
grep -REn -i -E '(spec-r[1-6]|protocol-r[1-3]|master-plan-r[1-6]|review[-]r|prior[ ]round|earlier[ ]round|previous[ ]version|previous[ ]draft|before[ ]the[ ]refactor|was[ ]superseded|older[ ]revision)' SPEC/analyst-as-control-surface/PLAN/drafts/006-ui-mutation-removal-ordered-rendering/
```

The inline alternation uses single-character classes (for
example `review[-]r`, `prior[ ]round`) so the literal forbidden
anchor strings do not appear verbatim in this plan; the gate is
therefore self-applicable to its own §H.1 without false
positives. The `r[1-6]` digit range deliberately excludes the
currently-active spec/plan revision so this stage may
legitimately reference SPEC sections of that revision in
`design.md` without tripping the gate.

H.2 Host-path guard. Run
`grep -REn '/wo''rk/' SPEC/analyst-as-control-surface/PLAN/drafts/006-ui-mutation-removal-ordered-rendering/`
(the empty single-quote concatenation produces the literal
forward-slash-w-o-r-k-forward-slash without matching this
grep line itself). Expected: zero hits.

H.3 Emoji guard. Run
`grep -RnP '[\x{1F300}-\x{1FAFF}\x{2600}-\x{27BF}]' SPEC/analyst-as-control-surface/PLAN/drafts/006-ui-mutation-removal-ordered-rendering/`.
Expected: zero hits.

H.4 Conditional ledger close-out for the seven inherited
forecast ids (each substep is conditional: act only if
(a) the corresponding entry appears in
`SPEC/analyst-as-control-surface/PLAN/expected-breakage-ledger.md`,
AND (b) its `Target fix stage:` line reads `S06`, AND (c) the
failing id is no longer observed in the gate diff produced
by phase substep H.5 below). If all three conditions are
true, append a single line removing that entry from the
ledger (the cumulative
ledger holds OPEN expected-breakage entries only, per S00's
ledger-as-open-entries-only contract — a closed entry is
gone, not annotated in place). If any condition fails the
substep is a TRUE no-op: it makes ZERO edits to the cumulative
ledger and instead writes a single-line evidence note to a
stage-local file
`SPEC/analyst-as-control-surface/PLAN/drafts/006-ui-mutation-removal-ordered-rendering/implementation-notes.md`
(creating the file on first append) recording which condition
failed and the substep id. The implementer never silently
fabricates a close-out and never amends the cumulative ledger
on a no-op path.

H.4.1 Forecast id
`web-vitest:scenario-dashboard-child-order:step-1` (recorded
by S03): on all-three-conditions-true, remove the entry from
the cumulative ledger and record in
`implementation-notes.md` (the close-out evidence text is
`S06 H.4.1 closed: DashboardView now renders a
child-of-goal panel wired in F.16 via
cardsStore.childrenOf(displayedGoalId);
shuffled-fixture arm added by G.5(a) asserts position-sorted
DOM order; failing id no longer observed in gate diff because
the new test PASSES."). On any condition false, append to
`implementation-notes.md` "S06 H.4.1 no-op (condition X
failed)" with the failing condition's letter; the cumulative
ledger is not touched.

H.4.2 Forecast id
`web-vitest:scenario-files-view-child-order:step-1` (recorded
by S03): on all-three-conditions-true, remove the entry from
the ledger and record in `implementation-notes.md` (the
close-out evidence is `S06 H.4.2 closed: FilesView now renders
the per-card child listing wired in F.17 via cardsStore
.childrenOf(parentId); shuffled-fixture arm added by G.5(b)
asserts position-sorted DOM order; failing id no longer
observed in gate diff because the new test PASSES.").
Otherwise no-op note to
`implementation-notes.md`; cumulative ledger untouched.

H.4.3 Forecast id
`web-vitest:scenario-debug-view-child-order:step-1` (recorded
by S03): on all-three-conditions-true, remove the entry from
the ledger and record in `implementation-notes.md` (the
close-out evidence is `S06 H.4.3 closed: DebugView now renders
a per-card child-list section wired in F.18 via cardsStore
.childrenOf(parentId); shuffled-fixture arm added by G.5(c)
asserts position-sorted DOM order; failing id no longer
observed in gate diff because the new test PASSES.").
Otherwise no-op note to `implementation-notes.md`;
cumulative ledger untouched.

H.4.4 Forecast id
`web-vitest:scenario-notifications-panel:step-1` (recorded
by S04): on all-three-conditions-true, remove the entry from
the ledger and record in `implementation-notes.md` (the
close-out evidence is `S06 H.4.4 closed: NotificationsPanel
.vue deleted by F.12 and notifications-panel.test.ts removed
by G.3; failing id no longer observed because the test file
no longer exists."). Otherwise no-op note to
`implementation-notes.md`; cumulative
ledger untouched.

H.4.5 Forecast id
`web-vitest:scenario-stale-warning-ribbon:step-1` (recorded
by S04): on all-three-conditions-true, remove the entry from
the ledger and record in `implementation-notes.md` (the
close-out evidence is `S06 H.4.5 closed: ribbon visibility
is now a pure function of `cardsStore.isStale(...)` (added
in Phase C.5 and consumed by F.13), and the rewritten test
exercises store-driven clearance (G.2); failing id no longer
observed in gate diff.\"). Otherwise no-op note to
`implementation-notes.md`; cumulative ledger untouched.

H.4.6 Forecast id
`web-vitest:scenario-operator-dashboard-smoke:step-1`
(recorded by S04): on all-three-conditions-true, remove the
entry from the ledger and record in `implementation-notes.md`:
"S06 H.4.6 closed: dashboard smoke test rewritten (G.2) to
assert absence of start/stop and presence of the always-on
chat composer; no `NotificationsPanel` absence arm was added
because DashboardView never mounted the panel (Option A);
failing id no longer observed in gate diff." Otherwise no-op
note to `implementation-notes.md`; cumulative ledger
untouched.

H.4.7 Forecast id
`web-vitest:scenario-operator-events-contract:step-1`
(recorded by S04): on all-three-conditions-true, remove the
entry from the ledger and record in `implementation-notes.md`:
"S06 H.4.7 closed: api-client contracts test rewritten
(Phase B + G.2) to cover only reads, bounded bootstrap, and
sendChatMessage; failing id no longer observed in gate diff."
Otherwise no-op note to `implementation-notes.md`; cumulative
ledger untouched.

H.5 Gate diff. From `saivage-v3/`, run
`bash SPEC/analyst-as-control-surface/PLAN/scripts/run-gates.sh --diff SPEC/analyst-as-control-surface/PLAN/baseline-gates.json`.
Required outcome: exit code 0; zero NEW failing ids on every
gate. REPAIRED rows are permitted only if H.4's conditional
substeps actually fired (i.e. only if the seven failing ids
were present in the baseline before Phase G.10's conditional
refresh). Capture stdout+stderr into `tmp/s06-gates-after.txt`
and `diff tmp/s06-gates-before.txt tmp/s06-gates-after.txt`
for the close-out comment block.

H.6 S07-targeted conditional forecast append. After H.5 has
produced its gate diff, the implementer reviews the diff for
NEW failing ids on the backend-touching gates `tsc-build`,
`web-vite-build`, and `analyst-e2e` (the three gates whose
failure could plausibly trace to a removed UI caller pointing
at a backend route that S07 will delete). For each such NEW
failing id whose root cause is a removed UI caller that
targeted a backend mutation route inside S07's deletion scope
(every legacy v3 mutation endpoint EXCEPT the bounded
bootstrap routes and `POST /api/chats/`), append exactly one
line to
`SPEC/analyst-as-control-surface/PLAN/expected-breakage-ledger.md`
of the shape
`- [ ] <gate>:<failing-id> | Recorded by: S06 / <YYYY-MM-DD> | Target fix stage: S07 | Note: removed UI caller of <route> superseded by S07 backend deletion`.
The paper-plan default outcome is zero such failures observed
(the v2 client deletion in B.6, the mutation-affordance
removal in F.1-F.13, and the test rewrites in G.2 are
self-contained on the frontend; the backend gates have no
UI-driven inputs in this stage), so the cumulative ledger is
byte-unchanged. Confirm by
`diff tmp/s06-ledger-before.md SPEC/analyst-as-control-surface/PLAN/expected-breakage-ledger.md`;
the diff is either empty (default) or a strict-append of
NEW S07-target lines (no removals; H.4.1-H.4.7 already
performed any removals earlier in Phase H). Excluded from
this substep: NEW failing ids that trace to routes the
bounded-bootstrap allow-list preserves (`POST /api/projects`,
`POST /api/cards`, `POST /api/agents`) or to
`POST /api/chats/` (analyst chat write).

H.7 Live-probe gate, two states. From `saivage-v3/`:
- Start the dev server in a background terminal:
  `cd web && SAIVAGE_PROJECT_ROOT=../tmp/check-mutation-traffic-fixture npm run dev`
  (the `web/package.json` owns the `dev` script; the
  `saivage-v3/` root has no `dev` script of its own). The
  `SAIVAGE_PROJECT_ROOT` env var points the backend at the
  throwaway fixture root provisioned by G.6/G.7 so the dev
  server reads only fixture state and NEVER the operator's
  real `saivage-v3/.saivage/` directory. Wait for the server
  to log `ready`.
- Run
  `bash SPEC/analyst-as-control-surface/PLAN/scripts/check-mutation-traffic.sh --base-url http://localhost:5173 --token "$SAIVAGE_OPERATOR_TOKEN" --bootstrap-state empty`.
  Expected: exit code 0; zero non-bootstrap mutating
  requests. The script (per G.7) creates and tears down the
  fixture root on every invocation and never touches the
  operator's real `.saivage/`.
- Re-run with `--bootstrap-state configured`. Expected: exit
  code 0; the bootstrap allow-list now contains only
  `POST /api/chats/` (the analyst chat write).
- Stop the dev server.

H.8 Final guard re-runs. Repeat H.1, H.2, H.3 against the
draft directory to confirm no transient violation slipped in
during H.4–H.7. Expected: zero hits on each.

H.9 Publication via atomic rename. Confirm the draft
directory and the target stages directory are on the same
filesystem:
`stat -c '%d' SPEC/analyst-as-control-surface/PLAN/drafts/006-ui-mutation-removal-ordered-rendering`
and
`stat -c '%d' SPEC/analyst-as-control-surface/PLAN/stages`
must report the same device id. Then publish:
`mv SPEC/analyst-as-control-surface/PLAN/drafts/006-ui-mutation-removal-ordered-rendering SPEC/analyst-as-control-surface/PLAN/stages/006-ui-mutation-removal-ordered-rendering`.
Immediately after the `mv` succeeds, run
`ls -la SPEC/analyst-as-control-surface/PLAN/stages/006-ui-mutation-removal-ordered-rendering/`
and confirm `design.md` and `plan.md` are present and
identical (by `sha256sum`) to the files that left the draft
directory (capture the pre-mv hashes via
`sha256sum SPEC/analyst-as-control-surface/PLAN/drafts/006-ui-mutation-removal-ordered-rendering/{design.md,plan.md} > tmp/s06-pre-publish-hashes.txt`
before the `mv`, and compare with
`sha256sum SPEC/analyst-as-control-surface/PLAN/stages/006-ui-mutation-removal-ordered-rendering/{design.md,plan.md}`
after). The cumulative ledger
(`SPEC/analyst-as-control-surface/PLAN/expected-breakage-ledger.md`)
is NOT amended at stage-close — the per-stage attribution log
lives in the stage-local `implementation-notes.md` file
(written by H.4.1–H.4.7); the cumulative ledger holds OPEN
entries only, per S00's ledger-as-open-entries-only contract.
