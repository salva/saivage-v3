# S06 — UI mutation removal, read-only preservation, ordered-child rendering

## Goal

Strip every mutating affordance from the operator web UI and from the
generated web client so that, after this stage lands, no code path under
[saivage-v3/web/src](saivage-v3/web/src) issues a `POST`, `PUT`,
`PATCH`, or `DELETE` request to any operator HTTP route outside the
bounded authentication-bootstrap exception (login, sign-out, initial
analyst-provider-secret entry) and the always-on analyst chat write
endpoint (`POST /api/chats/<sessionId>`). Read-only affordances stay
fully functional. The MASTER-PLAN-r7 §4.1 ordered-child-rendering
acceptance for the three S06-owned matrix rows (Dashboard
child-of-goal panels, Files view card-bound child listings, Debug view
child lists) is satisfied by adding the three missing read-only
surfaces in this stage. S06 introduces a parametric
`childrenOf(parentId: string): CardRecord[]` getter on the cards
store whose body filters cards by `parent === parentId`, sorts
ascending by `position` with `null` treated as `+Infinity`, and uses
`a.id.localeCompare(b.id)` as the deterministic tiebreaker. The three
workspace views (`DashboardView.vue`, `FilesView.vue`,
`DebugView.vue`) each mount a strictly read-only section that renders
the appropriate parent card's children via `cardsStore.childrenOf`,
exposing zero mutating affordances on the new surfaces (title plus
status text only; no `@click`, `@drag`, or `@submit` arms). The
matrix conditional (`any panel grouping card children`, `where files
are grouped by card`, `whenever the debug surface renders a card's
children`) becomes true on these surfaces after S06, and three new
vitest files assert the position-sorted DOM order under
shuffled-`position` fixtures. The stage removes
UI callers BEFORE S07 removes the corresponding backend routes, so
that the application is never in an intermediate state where a
clickable affordance points at a missing handler. Per MASTER-PLAN
§4 the route-pruning and UI-mutation-affordance stages were
intentionally swapped relative to an earlier revision precisely so
this ordering holds.

The deliverable is a `saivage-v3/web` tree in which
`cd web && npm run build` (from `saivage-v3/`) succeeds,
`cd web && npm test` (from `saivage-v3/`) succeeds, and the live-probe
gate pinned by SPEC-r7 `### Acceptance Criteria — UI removal` and
`### Bounded authentication-bootstrap exception` observes zero
non-bootstrap mutating HTTP requests across every view in both
bootstrap states.

## Scope

In scope:

- Delete every mutating function from
  [saivage-v3/web/src/api/client.ts](saivage-v3/web/src/api/client.ts):
  `createCard`, `updateCard`, `deleteCard`, `startProject`,
  `stopProject`, `pauseRuntime`, `resumeRuntime`, `freezeRuntime`,
  `resumeRuntimeFromFreeze`, `acknowledgeNote`, `deleteNote`,
  `clearAllNotes`, `acknowledgeNotification`, `terminateProcess`.
  Preserve the three bounded-bootstrap mutators and the analyst
  chat write: `issueWebSocketTicket` (`POST /api/auth/ws-ticket`,
  part of the login flow), the auth-token entry path implemented
  by [saivage-v3/web/src/api/auth.ts](saivage-v3/web/src/api/auth.ts)
  (no `POST/PUT/PATCH/DELETE` is issued from that module today; it
  stays as-is), and `sendChatMessage` (`POST /api/chats/<id>`,
  the always-on analyst chat write).
- Delete the corresponding payload type aliases from
  [saivage-v3/web/src/api/types.ts](saivage-v3/web/src/api/types.ts):
  `CreateCardPayload`, `UpdateCardPayload`, `CardCreateResponse`,
  `CardUpdateResponse`, `RuntimeCommandResponse`, `FreezeResponse`,
  `ResumeFromFreezeResponse`, `NotesClearResponse`,
  `NotificationAcknowledgeResponse`, `ProcessTerminateResponse`,
  and any narrower per-operation request shape used only by the
  removed functions. Response types used by the listing/read routes
  (`NotesListResponse`, `NotificationsListResponse`,
  `NoteRecord`, `ProcessDetailResponse`) stay.
- Strip mutation actions from the pinia stores:
  [saivage-v3/web/src/stores/cards.ts](saivage-v3/web/src/stores/cards.ts)
  loses the `createCard`, `updateCard`, `deleteCard` imports and
  the corresponding action functions in the store factory;
  [saivage-v3/web/src/stores/runtime.ts](saivage-v3/web/src/stores/runtime.ts)
  loses `startProject`, `stopProject`, `pause`, `resume`, the
  imports for the four removed client functions, and their entries
  in the store's returned object;
  [saivage-v3/web/src/stores/debug.ts](saivage-v3/web/src/stores/debug.ts)
  loses `terminateProcess`, `acknowledgeNote`, `deleteNote`,
  `clearAllNotes`, `acknowledgeNotification`, `pauseRuntime`, and
  `resumeRuntime` imports and the seven corresponding actions.
  The cards store's `seedCardContext` and analyst-chat plumbing
  added by S05 stays untouched.
- Delete every mutating UI control and its event wiring from the
  workspace views and card components:
  - [saivage-v3/web/src/views/CardsView.vue](saivage-v3/web/src/views/CardsView.vue):
    the "New Card" composer block, the priority/title submission
    form, the per-row delete button, the action menu (`...`)
    triggering `delete` / `move` / `archive`, the drag-to-reparent
    plumbing on the card list, every keyboard shortcut that
    mutates (e.g. `N` for new card), and the helper text that
    instructs the operator to use them. The view becomes a
    read-only browser of cards with refresh, filter, sort, search,
    expand/collapse, copy-card-id-to-clipboard, and direct
    navigation as the only operator-facing controls.
  - [saivage-v3/web/src/views/DashboardView.vue](saivage-v3/web/src/views/DashboardView.vue):
    the "Start Project" and "Stop Project" buttons (`runtime-command
    start-project` and `runtime-command stop-project` at lines
    112-113), the `startProject` / `stopProject` async wrappers
    (lines 565-580), and any companion telemetry that exists only
    to report the result of those commands. Refresh, copy, and
    direct-navigation affordances stay. DashboardView does not
    import or mount `NotificationsPanel.vue` in the current source
    (the only mount lives in `DebugView.vue`); no
    `NotificationsPanel`-related edit applies to this file.
    Additionally, a new strictly read-only `child-of-goal` panel
    is added to this view to satisfy the MASTER-PLAN-r7 §4.1
    Dashboard ordered-child-rendering acceptance: the panel
    renders the children of the displayed goal card via
    `cardsStore.childrenOf(displayedGoalId)` as a `<ul>` of
    `<li>` items showing title plus status; the panel exposes
    zero mutating affordances (no `@click`, `@drag`, or
    `@submit` arms).
  - [saivage-v3/web/src/views/DebugView.vue](saivage-v3/web/src/views/DebugView.vue):
    the per-process Terminate button and its handler, the
    pause/resume control row, every per-note Acknowledge and
    Delete row, the "Clear all notes" control, and any
    per-notification Acknowledge control still mounted by the
    debug surface. The current `<NotificationsPanel />` mount at
    line 125 and its `import NotificationsPanel from
    '../components/cards/NotificationsPanel.vue'` declaration at
    line 388 are deleted in the same edit batch. The view keeps
    doctor output, supervision tree, error timeline, process
    listing, MCP tool listing, and every read-only diagnostic
    affordance. Additionally, a new strictly read-only
    per-card child-list section is added under the existing
    card-render loop in this view to satisfy the
    MASTER-PLAN-r7 §4.1 Debug ordered-child-rendering
    acceptance: for each card the view already renders, the
    new section calls `cardsStore.childrenOf(card.id)` and
    renders the resulting array as a `<ul>` of `<li>` items
    showing title plus status. The section exposes zero
    mutating affordances and renders conditionally when the
    parent card has at least one child.
  - [saivage-v3/web/src/views/FilesView.vue](saivage-v3/web/src/views/FilesView.vue):
    no mutating affordances exist in this view today; the
    mutation-removal pass is audit-only. Additionally, a new
    strictly read-only per-card child listing is added to
    this view to satisfy the MASTER-PLAN-r7 §4.1 Files
    ordered-child-rendering acceptance: the listing calls
    `cardsStore.childrenOf(activeCardId)` and renders the
    resulting array as a `<ul>` of `<li>` items showing title
    plus status, mounted conditionally on the active parent
    card having at least one child. The listing exposes zero
    mutating affordances.
  - [saivage-v3/web/src/components/cards/CardsTreeView.vue](saivage-v3/web/src/components/cards/CardsTreeView.vue):
    the drag-to-reparent handlers, the per-node action menu,
    every context-menu entry that calls `updateCard` or
    `deleteCard`, and the keyboard shortcuts that mutate. The
    tree keeps expand/collapse, selection, and the navigation
    click that routes to `CardDetailView`. Tree node children are
    rendered in persisted `position` order per S03's contract.
  - [saivage-v3/web/src/components/cards/CardDetailView.vue](saivage-v3/web/src/components/cards/CardDetailView.vue):
    the "Edit" / "Save" / "Delete" / "Restart" / "Mark goal as
    needing corrections" / "Abort subtree" controls and their
    handlers. The "Discuss with analyst" button stays (it stages
    a seed via S05 wiring; it is not a mutation). The detail view
    becomes a read-only render of the card record, its tags,
    its parent link, its child listing (ordered by `position`),
    and the per-card history button.
  - [saivage-v3/web/src/components/cards/CardHistoryPanel.vue](saivage-v3/web/src/components/cards/CardHistoryPanel.vue):
    no mutating affordances exist today; this stage only audits
    the file and rewrites copy that refers to removed controls
    (no "Restart from version N" affordance is added).
  - [saivage-v3/web/src/components/cards/NotificationsPanel.vue](saivage-v3/web/src/components/cards/NotificationsPanel.vue):
    the per-notification Acknowledge button and any "Clear all"
    affordance, plus the `listNotifications` /
    `acknowledgeNotification` calls. SPEC-r7 forbids treating
    notifications as an inspectable object class, so the
    options for this component are (a) delete the file outright
    (S09's renaming-to-`RuntimeEventsPanel` work then has nothing
    to redirect from) or (b) convert it in-stage to a strictly
    read-only most-recent-events tail bound to the websocket
    activity stream. S06 chooses (a): the file is deleted in this
    stage, every importer is updated to no longer mount it, and
    S09 owns the introduction of any replacement
    `RuntimeEventsPanel` (if SPEC-r7's "recent runtime events
    surface" option is ultimately exercised at all).
  - [saivage-v3/web/src/components/cards/StaleWarningRibbon.vue](saivage-v3/web/src/components/cards/StaleWarningRibbon.vue):
    the ribbon's clearance path currently depends on a
    `notification_acknowledged` ws event kind that S04 removed.
    S06 rewrites the ribbon so its visibility is a pure function
    of a new cards-store getter `isStale(cardId: string):
    boolean`. The current store exposes the per-card flag map
    `staleNotificationByCard` and a single-card computed
    `currentCardHasStaleWarning` (see
    [web/src/stores/cards.ts](saivage-v3/web/src/stores/cards.ts)
    lines 128, 168-170, 225, 516-517) but no parametric
    `isStale(cardId)` getter. S06 adds that getter in Phase C
    (`return staleNotificationByCard.value[cardId] === true`) and
    exports it via the store's returned object literal, so the
    ribbon and any future caller can resolve staleness for an
    arbitrary card id. The ribbon then mounts when
    `cardsStore.isStale(currentCard.value.id)` is true and
    unmounts when the underlying state transitions to fresh
    (driven by the existing `card.snapshot.replaced` and
    `card.snapshot.added` ws kinds, which S04 keeps). No explicit
    "acknowledge" affordance is added; the ribbon is informational
    only.
- Ordered-child rendering in workspace views (MASTER-PLAN-r7 §4.1
  rows owned by S06): satisfied by adding the three missing
  read-only surfaces. S06 introduces the parametric getter
  `childrenOf(parentId: string): CardRecord[]` on the cards
  store (filter by `parent === parentId`, sort ascending by
  `position` with `null` mapped to `+Infinity`, tiebreak by
  `a.id.localeCompare(b.id)`) and wires it into
  `DashboardView.vue` (child-of-goal panel), `FilesView.vue`
  (per-card child listing), and `DebugView.vue` (per-card
  child-list section). Each surface is strictly read-only and
  exposes title plus status only. The three inherited S03
  forecast ids close TRUE in this stage because the new
  surfaces exist, the new shuffled-`position` vitest fixtures
  PASS, and the failing ids are no longer observed in the
  `web-vitest` gate diff.
- Bootstrap-boundary live probe.
  A small probe script
  `SPEC/analyst-as-control-surface/PLAN/scripts/check-mutation-traffic.sh`
  is added in this stage. The script accepts the dev server's
  base URL plus an auth token, spawns a headless browser
  (re-using the playwright runtime already installed in
  `saivage-e2e-checkers/` so no new dependency is introduced),
  visits every operator view (`/dashboard`, `/cards`, `/files`,
  `/agents`, `/debug`) in two bootstrap states, captures every
  outgoing HTTP request, and asserts that every non-bootstrap
  request is `GET`. The probe NEVER reads, writes, prints, or
  copies any file under the host workspace's real `.saivage/`
  tree, nor any other credential-bearing file. Instead it
  operates against a throwaway fixture project root at
  `saivage-v3/tmp/check-mutation-traffic-fixture/` containing a
  minimal `.saivage/` skeleton populated by the probe itself
  with fake values: an empty `.saivage/auth-profiles.json`
  (literal `{ "profiles": {} }`) and a `.saivage/saivage.json`
  whose `providers` map is either empty (bootstrap-state
  `empty`) or populated with a single literal-fake
  `opencode-go` entry whose `apiKey` is the string
  `"FIXTURE-FAKE-NOT-A-REAL-KEY"` (bootstrap-state
  `configured`). The fixture directory is created fresh by the
  probe on every invocation (`rm -rf` of the fixture dir
  followed by `mkdir -p` and `cat <<EOF > ...` here-doc
  seeding) and contains no other files; it is not git-tracked
  (`saivage-v3/.gitignore` already excludes `tmp/`). The dev
  server is started with the fixture project root as its
  argument (`cd web && npm run dev -- --project ../tmp/check-mutation-traffic-fixture`
  or the equivalent `SAIVAGE_PROJECT_ROOT` env var the existing
  CLI honours), so the running app reads only fixture state.
  Real `.saivage/auth-profiles.json` and real
  `.saivage/saivage.json` are NEVER touched. The bootstrap
  states are (a) no analyst-capable provider configured (the
  fixture's `providers` object is empty so the only reachable
  mutation surface is the bounded bootstrap), and (b) at least
  one analyst-capable provider configured (the fixture's
  `providers` object contains the fake-credentialled
  `opencode-go` profile so the bootstrap surface is gone and
  only the analyst chat write endpoint remains as a permitted
  mutation). The probe's pass predicate is "zero
  `POST|PUT|PATCH|DELETE` requests outside the bounded-bootstrap
  set and `sendChatMessage`". The bounded-bootstrap set is
  enumerated literally in the script:
  `POST /api/auth/ws-ticket`, `POST /api/auth/login`,
  `POST /api/auth/logout`, `POST /api/auth/provider-secret`
  (initial entry only). The probe is invoked once per phase in
  `plan.md` Phase H.
- Delete or rewrite every vitest under
  [saivage-v3/web/src/__tests__](saivage-v3/web/src/__tests__)
  that exercised a removed UI control or client function. The
  list is enumerated in `## Surfaces touched > Tests` below.
  Tests are removed in-stage (not skipped) per MASTER-PLAN
  section 3 rule (4) and the baseline snapshot is updated
  per `## Surfaces touched > Baseline`.

Out of scope (declared as forecast entries for the owning later
stage where they introduce NEW failures):

- Backend HTTP route removal for the mutations whose UI callers
  are deleted in this stage: owned by S07 per MASTER-PLAN §S07.
  After S06 lands, the routes still exist and still respond
  successfully; the live-probe gate proves no code path under
  `web/src` calls them, so S07 can delete them without breaking
  the running application.
- Removal of the per-card "Discuss with analyst" affordance: S05
  repurposed it as a contextual seed and S06 keeps that
  behaviour unchanged.
- Analyst-driven navigation (`navigate_workspace` tool wiring)
  and full contextual-awareness payload: S08.
- The optional `RuntimeEventsPanel` (the SPEC-r7 "recent runtime
  events" surface that is allowed as a notification-agnostic
  read-only view): S09 owns the decision to introduce it and the
  rename of any residual notification-named surface.
- Bootstrap-surface relocation (moving the
  `ApiTokenEntry` modal into the analyst chat for the
  not-yet-configured case): SPEC-r7's bounded-bootstrap
  exception explicitly permits the current overlay, so S06
  leaves it untouched. S09 owns any further consolidation if
  SPEC-r7 grows a follow-up requirement.

Upstream stages S06 depends on:

- S00 (gates baseline).
  `SPEC/analyst-as-control-surface/PLAN/baseline-gates.json`
  and `PLAN/scripts/run-gates.sh` are the gate inputs S06 reads
  and conditionally refreshes per S00's lifecycle rule.
- S01 (real-LLM analyst resolver). S06 does not touch the
  analyst session machinery; the always-on chat write endpoint
  is preserved.
- S02 (tool-surface alignment). The analyst tool registry is
  the canonical mutation path; S06 deletes only operator-side
  callers and leaves the analyst-side tool surface untouched.
  No S02 file is edited by S06.
- S03 (ordered children and bounded move). S03 is the
  upstream paper-planned stage that defines the persisted
  `position` field on `CardRecord` and the matrix acceptance
  for ordered child rendering. The published S03 plan names
  the cards-store getter `childrenOf(parentId)` as the
  contract surface but does not pre-supply its implementation
  on the current cards-store source (the live store ships
  `currentChildren` scoped to the active card only, not a
  parametric getter). S06 owns the introduction of the
  parametric `childrenOf(parentId): CardRecord[]` getter on
  the cards store in this stage (see
  `## Approach > Ordered-child rendering` and
  `## Surfaces touched > Frontend stores > cards.ts`) and
  wires it into the three workspace views, closing S03's
  forecasts `web-vitest:scenario-dashboard-child-order:step-1`,
  `web-vitest:scenario-files-view-child-order:step-1`, and
  `web-vitest:scenario-debug-view-child-order:step-1` at S06
  close-out per the conditional close-out skeleton in
  `plan.md` Phase H. The bounded-move action S03 also
  forecasts on the cards store is not in S06's scope; S03's
  implementation stage owns it.
- S04 (notifications: queue-only, ephemeral). S06 consumes the
  thinned operator/analyst activity event contract S04 shipped.
  S04's forecasts
  `web-vitest:scenario-notifications-panel:step-1`,
  `web-vitest:scenario-stale-warning-ribbon:step-1`,
  `web-vitest:scenario-operator-dashboard-smoke:step-1`, and
  `web-vitest:scenario-operator-events-contract:step-1` close
  at S06 close-out per the same conditional skeleton.
- S05 (persistent right-side analyst panel + workspace shell).
  S06 consumes the always-on chat composer (so the
  Discuss-with-analyst seed lands in a visible composer) and
  the drawer-free shell. S06 does not edit
  `AppShell.vue`, `WorkspaceHeader.vue`,
  `AnalystChatPanel.vue`, or the drawer-state-free
  `analystChat.ts` slice.

S06 is otherwise independent of S00–S05's internal details and
relies only on the published contracts listed above.

## Approach

### Removal order within the stage

Per MASTER-PLAN's "Risk" entry for S06 ("hidden mutating callers
in nav, layout, or context-menus"), the in-stage edit order is
bottom-up: delete client functions and store actions first, then
delete components and views that called those store actions, then
rewrite tests, then run the live probe. This ordering means that
between Phase B (client deletion) and Phase F (view deletion) the
TypeScript build is intentionally broken on the precise set of
imports that the view-deletion phase removes; `npx vue-tsc
--noEmit` is therefore not invoked until Phase F completes. The
plan pins this and the corresponding deferred build verification
explicitly.

### Bounded-bootstrap preservation

The bounded bootstrap isThe current source does not yet render
card children on any of these three surfaces (`DashboardView.vue`
renders runtime links plus activation records;
`FilesView.vue` is a file browser over per-card metadata and
output paths; `DebugView.vue` renders a flat `debugCards` list
plus supervision data). S06 adds the three missing surfaces in
this stage.

The shared infrastructure is a single new parametric getter on
the cards store, `childrenOf(parentId: string): CardRecord[]`.
Its body is:

```ts
function childrenOf(parentId: string): CardRecord[] {
  return cards.value
    .filter((c) => c.parent === parentId)
    .slice()
    .sort((a, b) => {
      const ap = a.position === null ? Infinity : a.position;
      const bp = b.position === null ? Infinity : b.position;
      if (ap !== bp) return ap - bp;
      return a.id.localeCompare(b.id);
    });
}
```

The getter is exported via the cards-store returned object
literal and unit-tested for: (a) position-asc primary order,
(b) `null` position last, (c) `id.localeCompare` tiebreaker on
equal positions, (d) empty array for an unknown parent id, and
(e) stable output across re-invocations on the same input.

The three workspace views each mount a read-only section that
binds to this getter. The chosen displayed-card source is the
same `cardsStore.currentCard?.id` selection surface S05 wired
the right-panel to, so all three new sections share one
consistent data source:

- `DashboardView.vue` mounts a `child-of-goal-panel` section
  under the existing goal-render area. `displayedGoalId`
  resolves to `cardsStore.currentCard?.id` (the canonical
  "displayed goal" selection; current source has no other
  `currentGoal` ref). The panel calls
  `cardsStore.childrenOf(displayedGoalId.value)` and renders
  title plus status for each child. When
  `cardsStore.currentCard` is null the panel renders an empty
  list with no error.
- `FilesView.vue` mounts a `card-children-listing` section
  under the existing per-card grouping area. `activeCardId`
  resolves to `cardsStore.currentCard?.id` (same fallback as
  DashboardView; no router change is needed because the
  current `web/src/main.ts` route declaration for `/files`
  carries no card-bound param and `cardsStore.currentCard` is
  the store-driven selection surface S05 already wired). The
  listing calls `cardsStore.childrenOf(activeCardId.value)`
  and renders title plus status for each child, gated on at
  least one child.
- `DebugView.vue` mounts a `card-children-section` block
  inside the existing `v-for` over `debugStore.debugCards`
  (the flat debug-card list at
  `web/src/stores/debug.ts` line 128, returned from
  `getDebugState`). For each `debugCard` the block calls
  `cardsStore.childrenOf(debugCard.id)` and renders title
  plus status for each child, gated on at least one child.
  The debug view continues to iterate `debugStore.debugCards`
  (not the cards store) because the existing card-render
  loop is debug-store-driven; the new section reuses the
  outer loop and joins on `debugCard.id` into the cards
  store's parent-keyed map.

None of the three surfaces introduces a mutating affordance; the
rendered items are bound to readable card fields only and
expose zero `@click`, `@drag`, or `@submit` arms. The
SPEC-r7 read-only-affordance preservation rule is upheld on
the new surfaces by construction.

The three inherited S03 forecast ids
(`web-vitest:scenario-dashboard-child-order:step-1`,
`web-vitest:scenario-files-view-child-order:step-1`,
`web-vitest:scenario-debug-view-child-order:step-1`) close TRUE
at S06 close-out: three new vitest files
(`dashboard-child-order.test.ts`, `files-view-child-order.test.ts`,
`debug-view-child-order.test.ts`) seed the cards store with a
shuffled-`position` vector under a parent card, mount the
corresponding view, and assert the rendered DOM child order
matches the position-asc plus id-tiebreaker output of
`cardsStore.childrenOf`. Each new test PASSES in this stage, so
the failing id is no longer observed in the `web-vitest` gate
diff and the cumulative ledger entry (if S03's implementation
stage had appended one) is removed by Phase H.4.1–H.4.3 via the
conditional close-out skeleton in `plan.md`. The remaining four
S04-inherited forecast ids (notifications-panel,
stale-warning-ribbon, operator-dashboard-smoke,
operator-events-contract) close per the same skeleton in
Phase H.4.4–H.4.7 against the surfaces S04 already specified.
No-op evidence (when a failing id is absent from baseline) is
recorded in the stage-local `implementation-notes.md` rather
than the cumulative ledger (per the MEDIUM 4 fix in this
revision: no-op close-out substeps touch the cumulative ledger
zero times). Ordered-child rendering is required only on the
three S06-owned surfaces (Dashboard child-of-goal panel, Files
per-card child listing, Debug per-card child-list section);
the SPEC does not require children to be rendered on every
view, and surfaces that do not render children today are
left untouched by S06.

### NotificationsPanel deletion vs. RuntimeEventsPanel rename

SPEC-r7 explicitly forbids treating notifications as an
inspectable object class. The current
`NotificationsPanel.vue` mounts a list whose items ARE
notifications (with per-item Acknowledge controls). Renaming it
in-stage would be a half-measure: the renamed panel would still
be coupled to the deleted `listNotifications` /
`acknowledgeNotification` client and would still mount items
whose source-of-truth is the deleted notifications HTTP route.
S06 therefore deletes the file outright. The only importer in
current source is `DebugView.vue` (mount at line 125, import
statement at line 388); the Phase A.5 inventory grep is the
safety net that catches any second importer if one exists.
The Phase F edit batch removes the `<NotificationsPanel />`
mount from `DebugView.vue`, drops the import statement, and
rewrites the debug-view test arm that referenced the panel to
assert its absence. `DashboardView.vue` has no current
`NotificationsPanel` import or mount and is not edited on this
basis. S09's `design.md` may reintroduce a strictly read-only
`RuntimeEventsPanel.vue` driven by the websocket activity
stream if SPEC-r7's optional "recent runtime events surface" is
exercised; that decision is out of scope for S06.

### Stale-warning-ribbon rewrite

`StaleWarningRibbon.vue` currently listens for a
`notification_acknowledged` websocket event kind to clear
itself. S04 removed that event kind. S06 rewrites the ribbon to
key off `cardsStore.isStale(currentCard.value.id)`. The current
cards store does NOT export `isStale`; it exports
`staleNotificationByCard` (the underlying flag map at
[web/src/stores/cards.ts](saivage-v3/web/src/stores/cards.ts)
line 128, mutated at line 225) and `currentCardHasStaleWarning`
(a computed scoped to the active card, lines 168-170). S06 adds
the parametric getter `isStale(cardId: string): boolean` in
Phase C with body `return staleNotificationByCard.value[cardId]
=== true` (the same predicate `currentCardHasStaleWarning`
already uses, generalised to take an arbitrary id), exports it
via the store's returned object literal, and adds a unit test
for it in the same phase. Phase F.13 then rewrites the ribbon
to consume this getter. The ribbon mounts when the getter
returns true and unmounts when the underlying state transitions
to fresh (driven by the existing `card.snapshot.replaced` and
`card.snapshot.added` ws kinds, which S04 keeps). No explicit
"acknowledge" affordance is added; the ribbon is informational
only.

### Test rewrites and baseline refresh

Every vitest under
[saivage-v3/web/src/__tests__](saivage-v3/web/src/__tests__)
that mocks or invokes a deleted client function is either
deleted (when the entire test file existed only to exercise a
removed control) or rewritten (when the file mixes removed and
still-valid surfaces). The enumeration is in `## Surfaces
touched > Tests`. Per MASTER-PLAN section 3 rule (4), removals
are real (not ledgered); per S00's lifecycle rule, the
baseline snapshot is conditionally refreshed to drop the
deleted test ids from the `web-vitest` gate's `failing_ids`
array, with no `captured_at` bump.

### Audit and surfaces

S06 introduces zero new analyst-side mutating tools and zero
new planner-control tools; it only deletes operator-side
mutation paths. No `recordControlAction` call sites are added.
No `safety_class` slot is introduced. The stage as a whole has
`safety_class: N/A` per MASTER-PLAN section 3 rule (1) ("Stages
that only delete code, restructure layout, or add read-only
views do not introduce new audit entries but MUST NOT regress
the rule"). The stage's edit set does not move any existing
mutating call across the analyst/operator boundary; it only
removes operator callers.

### Cookbook V.1–V.11 mapping

The `V.1`–`V.11` labels referenced throughout S06 are S00's
stage plan validation items at
`SPEC/analyst-as-control-surface/PLAN/stages/000-breakage-detection-harness/plan.md`
under `## Validation gate`. They are the canonical close-out
checklist S06 runs. See
`## Done-definition cross-reference to S00 plan.md V.1–V.11`
below for the explicit per-item mapping.

## Surfaces touched

Frontend client:

- `saivage-v3/web/src/api/client.ts` — `createCard`,
  `updateCard`, `deleteCard`, `startProject`, `stopProject`,
  `pauseRuntime`, `resumeRuntime`, `freezeRuntime`,
  `resumeRuntimeFromFreeze`, `acknowledgeNote`, `deleteNote`,
  `clearAllNotes`, `acknowledgeNotification`,
  `terminateProcess` deleted; `issueWebSocketTicket` and
  `sendChatMessage` preserved.
- `saivage-v3/web/src/api/types.ts` — `CreateCardPayload`,
  `UpdateCardPayload`, `CardCreateResponse`,
  `CardUpdateResponse`, `RuntimeCommandResponse`,
  `FreezeResponse`, `ResumeFromFreezeResponse`,
  `NotesClearResponse`, `NotificationAcknowledgeResponse`,
  `ProcessTerminateResponse` deleted; listing/read response
  types preserved. The `CardRecord` interface (lines 46-79)
  gains an optional `position?: number` field to mirror the
  backend record. The backend persists `position` on every
  card (root cards pinned at `position: 0`; per-parent
  contiguous indices; sorted into `parentsAdj` in id order on
  ties — see `saivage-v3/src/cards/state.ts` lines 126, 192,
  483-496), so card listing responses already carry the field;
  the type is declared optional purely so any legacy test
  fixture that omits the field still compiles. C.7's
  `childrenOf` sort reads `c.position ?? Infinity`.

Frontend stores:

- `saivage-v3/web/src/stores/cards.ts` — imports of `createCard`,
  `updateCard`, `deleteCard` removed; the action functions in
  the store factory that wrap them deleted; the corresponding
  entries removed from the store's returned object.
- `saivage-v3/web/src/stores/runtime.ts` — imports of
  `pauseRuntime`, `resumeRuntime`, `startProject`,
  `stopProject` removed; the four action wrappers (`startProject`,
  `stopProject`, the pause action, the resume action) deleted
  along with their entries in the store's returned object.
- `saivage-v3/web/src/stores/debug.ts` — imports of
  `terminateProcess`, `acknowledgeNote`, `deleteNote`,
  `clearAllNotes`, `pauseRuntime`, `resumeRuntime`,
  `acknowledgeNotification` removed; the seven action wrappers
  deleted; the seven corresponding entries removed from the
  store's returned object. The debug-store websocket listener
  arms that read the deleted `notification_acknowledged` event
  kind (already absent post-S04) stay absent.
- `saivage-v3/web/src/stores/cards.ts` — `isStale(cardId:
  string): boolean` getter added per
  `## Approach > Stale-warning-ribbon rewrite`. Body is
  `return staleNotificationByCard.value[cardId] === true`. The
  existing `currentCardHasStaleWarning` computed and the
  underlying `staleNotificationByCard` flag map stay (the new
  getter is a parametric form of the same predicate).
  Additionally, the parametric
  `childrenOf(parentId: string): CardRecord[]` getter is added
  per `## Approach > Ordered-child rendering`. Body filters
  `cards.value` by `c.parent === parentId`, slices to a fresh
  array, sorts ascending by `position` with `null` mapped to
  `+Infinity`, and uses `a.id.localeCompare(b.id)` as the
  deterministic tiebreaker. Both getters are exported via the
  cards-store returned object literal.

Frontend views and components:

- `saivage-v3/web/src/views/CardsView.vue` — new-card composer,
  per-row delete button, action menu, drag-to-reparent
  plumbing, mutating keyboard shortcuts deleted; helper text
  updated; reads stay.
- `saivage-v3/web/src/views/DashboardView.vue` — start/stop
  runtime command buttons (lines 112-113) and the
  `startProject` / `stopProject` async wrappers (lines 565-580)
  deleted. No `NotificationsPanel` import or mount exists in
  this file in current source, so no `NotificationsPanel`-
  related edit applies here. A new strictly read-only
  `child-of-goal-panel` section is added, bound to
  `cardsStore.childrenOf(displayedGoalId)` per
  `## Approach > Ordered-child rendering`.
- `saivage-v3/web/src/views/DebugView.vue` — per-process
  terminate, pause/resume, per-note acknowledge / delete /
  clear-all, per-notification acknowledge controls deleted;
  the `<NotificationsPanel />` mount at line 125 and the
  import `NotificationsPanel from
  '../components/cards/NotificationsPanel.vue'` at line 388
  are deleted in the same edit batch. A new strictly read-only
  `card-children-section` block is added inside the existing
  card-render loop, bound per iteration to
  `cardsStore.childrenOf(card.id)` per
  `## Approach > Ordered-child rendering`.
- `saivage-v3/web/src/views/FilesView.vue` — audit-only for
  the mutation-removal pass: confirm zero mutating
  client-function call sites. A new strictly read-only
  `card-children-listing` section is added under the existing
  per-card grouping area, bound to
  `cardsStore.childrenOf(activeCardId)` per
  `## Approach > Ordered-child rendering` and rendered
  conditionally on the active parent card having at least one
  child.
- `saivage-v3/web/src/components/cards/CardsTreeView.vue` —
  drag-to-reparent handlers, action menu, mutating context-menu
  entries, mutating keyboard shortcuts deleted. Ordered-child
  rendering on this component is NOT in S06's scope — the
  SPEC-r7 ordered-child requirement scopes the three S06-owned
  surfaces (Dashboard child-of-goal panel, Files per-card
  listing, Debug per-card section), not the cards tree. S03's
  implementation stage owns any sort-key change on this file;
  the parametric `childrenOf` getter S06 introduces on the
  cards store is available to S03 (and any future caller) for
  reuse without modification.
- `saivage-v3/web/src/components/cards/CardDetailView.vue` —
  edit / save / delete / restart / mark-corrections /
  abort-subtree controls and handlers deleted; the
  `openAnalystForCard` seed handler (S05) is preserved. The
  card-detail child listing is NOT in S06's scope; S03's
  implementation stage owns any ordered-rendering change to
  this component.
- `saivage-v3/web/src/components/cards/CardHistoryPanel.vue` —
  no mutating affordance today; copy referencing removed
  controls is rewritten if any survives the Phase A grep.
- `saivage-v3/web/src/components/cards/NotificationsPanel.vue`
  — file deleted; every importer updated to drop the import
  and the mount.
- `saivage-v3/web/src/components/cards/StaleWarningRibbon.vue`
  — `notification_acknowledged` listener and any related
  acknowledge handler deleted; visibility rewritten to key off
  `cardsStore.isStale(currentCard.value.id)`.

Frontend tests:

- `web/src/__tests__/cards-view.test.ts` — rewritten: the
  create-card flow assertions and `expect(createCard)...` arms
  are deleted in-stage; the test file becomes a read-only
  filter/sort/expand/copy/navigation suite. The mock import
  block at lines 66-67 (`createCard`, `updateCard`,
  `deleteCard`) is collapsed to the read-only set.
- `web/src/__tests__/card-store.test.ts` — rewritten: the
  `deleteCard` and any other mutating-call assertion arms are
  deleted; the file becomes a read-only-projection assertion
  suite. In the same rewrite, an assertion arm is added for
  the new `isStale(cardId)` getter: feeds two fixture card ids
  through `setCardStaleNotification(id, true|false)` and
  asserts `cardsStore.isStale(id)` returns the expected
  boolean for each. A second new arm asserts the
  `childrenOf(parentId)` getter's full ordering contract:
  seeds the store with a known shuffled-`position` vector,
  calls `cardsStore.childrenOf(parentId)`, and asserts the
  returned array matches the position-asc plus
  `id.localeCompare` tiebreaker, with `null` positions last;
  also asserts the empty-array case for an unknown parent id.
- `web/src/__tests__/card-store-burst.test.ts` — rewritten:
  mutation mocks removed; the store's burst-debouncing
  behaviour is asserted only on read operations.
- `web/src/__tests__/card-detail-view.test.ts` — rewritten:
  every assertion that the detail view called `updateCard` /
  `deleteCard` is replaced with an assertion that the
  corresponding control no longer exists in the rendered DOM.
  The S05 `seedCardContext` assertion stays. No child-order
  assertion is added (the detail view child list is an
  S03-owned surface).
- `web/src/__tests__/card-history-panel.test.ts`,
  `web/src/__tests__/card-history-panel-analyst-filter.test.ts`
  — mock import blocks (which list `createCard`, `updateCard`,
  `deleteCard` for completeness) are collapsed; behavioural
  assertions stay because the panel is read-only.
- `web/src/__tests__/dashboard-view.test.ts` — rewritten: the
  `startProject` / `stopProject` mock setup (lines 57, 60,
  109-110) and the corresponding click-then-assert arms (lines
  205, 209) are deleted; the test becomes a read-only mount
  suite asserting that the start/stop buttons no longer exist
  in the rendered DOM. A child-of-goal-panel presence arm is
  added: mounts the view, seeds the cards store with a goal
  card plus children, and asserts the rendered DOM contains
  the `[data-testid="dashboard-child-of-goal-panel"]` section.
  The detailed ordering assertion under shuffled-`position`
  lives in the dedicated new file
  `dashboard-child-order.test.ts` below. The inherited S03
  forecast id
  `web-vitest:scenario-dashboard-child-order:step-1` closes
  TRUE per `plan.md` Phase H.4.1 because the new test PASSES
  and the failing id is no longer observed.
- `web/src/__tests__/debug-view.integration.test.ts` —
  rewritten: every `terminateProcess`, `acknowledgeNote`,
  `deleteNote`, `clearAllNotes`, `pauseRuntime`,
  `resumeRuntime`, `acknowledgeNotification` mock and the
  corresponding click-then-assert arms (lines 138-143,
  189, 215, 226, 237, 248-249, 279) are deleted; the test
  asserts the absence of those controls in the rendered DOM
  and asserts the `<NotificationsPanel />` mount is absent
  (the Phase F edit removed it from `DebugView.vue`). A
  per-card child-list presence arm is added: mounts the view,
  seeds the cards store with a parent card visible in
  `debugCards` plus children, and asserts the rendered DOM
  contains the `[data-testid="debug-view-card-children"]`
  section. The detailed ordering assertion under
  shuffled-`position` lives in the dedicated new file
  `debug-view-child-order.test.ts` below. The inherited S03
  forecast id `web-vitest:scenario-debug-view-child-order:step-1`
  closes TRUE per `plan.md` Phase H.4.3.
- `web/src/__tests__/debug-view.processes.test.ts` —
  rewritten: `terminateProcess` mock and the click-then-assert
  arm (lines 165, 221, 227) deleted; the test becomes a
  read-only processes-listing suite asserting that no
  Terminate button is rendered.
- `web/src/__tests__/notifications-panel.test.ts` — deleted
  (185 lines, every `it` case exercises behaviour the deleted
  component owned). Closes S04's
  `web-vitest:scenario-notifications-panel:step-1` forecast.
- `web/src/__tests__/stale-warning-ribbon.test.ts` — rewritten:
  every arm that emits a `notification_acknowledged` ws event
  to assert ribbon clearance is replaced with an arm that
  drives the new `isStale(cardId)` getter through
  `setCardStaleNotification`; ribbon mount/unmount is asserted
  as a pure function of store state. Closes S04's
  `web-vitest:scenario-stale-warning-ribbon:step-1` forecast.
- `web/src/__tests__/operator-dashboard-smoke.test.ts` —
  rewritten: the `pauseRuntime`, `resumeRuntime`,
  `listNotifications`, `acknowledgeNotification` mocks (the
  partial list around line 290 and the
  `listNotifications` / `acknowledgeNotification` mocks
  surviving from S05's edit) are deleted; the test becomes a
  read-only smoke that mounts the dashboard, asserts the
  start/stop buttons are absent, asserts the always-on chat
  panel is present, and proceeds with the
  session-picker / composer-disabled checks the file already
  covers. No `NotificationsPanel`-absence arm is added on
  the dashboard mount because the panel was never mounted in
  `DashboardView.vue` in current source; the `<NotificationsPanel />`
  absence is instead asserted by the rewritten
  `debug-view.integration.test.ts`. Closes S04's
  `web-vitest:scenario-operator-dashboard-smoke:step-1`
  forecast.
- `web/src/__tests__/api-client-contracts.test.ts` —
  rewritten: every reference to the deleted client functions
  (`pauseRuntime`, `startProject`, `stopProject` at lines
  2, 37, 40, 50-51, 70, 73) is deleted; the file becomes a
  contracts test only for the read endpoints and the
  bounded-bootstrap / chat write endpoints. Closes S04's
  `web-vitest:scenario-operator-events-contract:step-1`
  forecast (the operator events typed contract is now exposed
  only via the read surface).
- `web/src/__tests__/files-view.test.ts` — audit-only for the
  mutation-removal pass; no rewrite of existing arms is
  required because the file does not exercise any deleted
  client function. A per-card child-listing presence arm is
  added: mounts the view with route params pointing at a
  parent card, seeds the cards store with children for that
  parent, and asserts the rendered DOM contains the
  `[data-testid="files-view-card-children"]` section. The
  detailed ordering assertion under shuffled-`position` lives
  in the dedicated new file `files-view-child-order.test.ts`
  below. The inherited S03 forecast id
  `web-vitest:scenario-files-view-child-order:step-1` closes
  TRUE per `plan.md` Phase H.4.2.
- `web/src/__tests__/dashboard-child-order.test.ts` — new
  file added in this stage. Mounts `DashboardView.vue`, seeds
  the cards store with a goal card plus five children sharing
  the goal as parent and `position` values `[3, 1, null, 1, 2]`
  with distinct ids `['c-e', 'c-b', 'c-d', 'c-a', 'c-c']`,
  awaits next tick, queries the panel rendered by the new
  child-of-goal section, and asserts the rendered title array
  matches the position-asc plus id-tiebreaker ordering.
  Vitest id: `scenario-dashboard-child-order:step-1`.
- `web/src/__tests__/files-view-child-order.test.ts` — new
  file added in this stage. Mounts `FilesView.vue` with route
  params pointing at a parent card, seeds the cards store with
  five children of that parent under a shuffled `position`
  vector matching the dashboard test's shape, awaits next
  tick, queries the rendered `files-card-children-list`, and
  asserts position-asc plus id-tiebreaker order. Vitest id:
  `scenario-files-view-child-order:step-1`.
- `web/src/__tests__/debug-view-child-order.test.ts` — new
  file added in this stage. Mounts `DebugView.vue`, seeds the
  cards store with a single debug-visible parent card plus
  five children under a shuffled `position` vector, awaits
  next tick, queries the rendered `debug-card-children-list`,
  and asserts position-asc plus id-tiebreaker order. Vitest
  id: `scenario-debug-view-child-order:step-1`.
- `web/src/__tests__/read-only-positive-checklist.test.ts` —
  new file added in this stage. The suite walks each
  representative view (`CardsView`, `DashboardView`,
  `FilesView`, `AgentsView`, `DebugView`) and asserts at least
  one read-only control of each SPEC-listed category remains
  operational on that view: refresh button click triggers a
  read fetch, the filter / sort / search inputs update the
  rendered set, expand / collapse toggles the rendered
  subtree, the copy-to-clipboard handler writes the expected
  value, and direct navigation via `router.push` updates the
  rendered view. This is the positive checklist required by
  MASTER-PLAN §S06 acceptance.

Frontend gate scripts:

- `SPEC/analyst-as-control-surface/PLAN/scripts/check-mutation-traffic.sh`
  — added in this stage. The script implements the
  bootstrap-boundary live probe described in
  `## Approach > Bootstrap-boundary live probe`. It is invoked
  by `plan.md` Phase H once per bootstrap state and exits
  non-zero on any non-bootstrap mutating request.

Baseline:

- `SPEC/analyst-as-control-surface/PLAN/baseline-gates.json` —
  edited only if the deleted vitest ids (the full ids
  produced by the gate's normalization rule for the rewritten
  / deleted test files) currently appear in the `web-vitest`
  gate's `failing_ids` array. If no such id is present, the
  baseline file is not edited at all (no `captured_at` bump,
  no `comparison_rule` change, no `command` change, no
  whitespace touch); S00's lifecycle rule forbids
  opportunistic baseline refresh. If matching ids are
  present, they are removed from `failing_ids` and every other
  field of the snapshot is left untouched.

Backend:

- None. S06 makes no edit under `saivage-v3/src/`. The
  operator HTTP mutation routes still exist and still respond
  successfully after S06; S07 deletes them.

## Test plan

Unit (Vue SFC + store):

- `cards-view.test.ts` (rewritten): asserts no new-card
  composer, no per-row delete button, no action menu, no
  drag-to-reparent zone; filter / sort / search / expand /
  collapse / copy / navigation each exercise the corresponding
  read-only control and assert the expected effect.
- `card-detail-view.test.ts` (rewritten): asserts no edit /
  save / delete / restart / mark-corrections / abort controls
  in the rendered DOM; asserts the Discuss-with-analyst seed
  handler from S05 still calls `seedCardContext`. No
  child-order assertion is added (the detail view child list
  is an S03-owned surface per MASTER-PLAN-r7 §4.1).
- `card-store.test.ts`, `card-store-burst.test.ts`
  (rewritten): assert the store has no `createCard`,
  `updateCard`, `deleteCard` actions; assert the new
  `isStale(cardId)` getter returns the boolean derived from
  `staleNotificationByCard` for fixture ids; assert the new
  `childrenOf(parentId)` getter returns the position-asc plus
  id-tiebreaker ordering for a shuffled-`position` fixture
  (including `null`-position-last and empty-array-for-unknown
  -parent); assert the burst path still debounces snapshot
  reads.
- `dashboard-view.test.ts` (rewritten): asserts no
  start/stop controls; asserts the new
  `dashboard-child-of-goal-panel` section is mounted when the
  goal card has children. The detailed shuffled-`position`
  ordering assertion lives in the new file
  `dashboard-child-order.test.ts`; the
  `scenario-dashboard-child-order:step-1` failing id is no
  longer observed because the new test PASSES.
- `debug-view.integration.test.ts`,
  `debug-view.processes.test.ts`,
  `debug-view.supervision.test.ts`,
  `debug-view.mcp.test.ts` (rewritten where the file imports
  a deleted client function; otherwise untouched): the four
  files collectively assert no terminate / pause / resume /
  acknowledge / delete / clear controls; the rewritten
  integration test asserts the absence of the
  `<NotificationsPanel />` mount and the presence of the new
  `debug-view-card-children` section under cards with
  children. The detailed shuffled-`position` ordering
  assertion lives in the new file
  `debug-view-child-order.test.ts`; the
  `scenario-debug-view-child-order:step-1` failing id is no
  longer observed because the new test PASSES.
- `files-view.test.ts` (audit-only for mutation removal): a
  per-card child-listing presence arm is added asserting the
  new `files-view-card-children` section is mounted on a
  parent card with children. The detailed shuffled-`position`
  ordering assertion lives in the new file
  `files-view-child-order.test.ts`; the
  `scenario-files-view-child-order:step-1` failing id is no
  longer observed because the new test PASSES.
- `stale-warning-ribbon.test.ts` (rewritten): asserts the
  ribbon mounts / unmounts purely as a function of
  `cardsStore.isStale(...)`; no `notification_acknowledged`
  ws event is emitted by the test; the
  `scenario-stale-warning-ribbon:step-1` failing id is no
  longer observed.
- `operator-dashboard-smoke.test.ts` (rewritten): asserts no
  start/stop, always-on chat present; the
  `scenario-operator-dashboard-smoke:step-1` failing id is
  no longer observed.
- `api-client-contracts.test.ts` (rewritten): asserts the
  contract surface contains only reads, bounded bootstrap,
  and `sendChatMessage`; the
  `scenario-operator-events-contract:step-1` failing id is no
  longer observed.
- `read-only-positive-checklist.test.ts` (new): the positive
  checklist required by MASTER-PLAN §S06 acceptance.
- `dashboard-child-order.test.ts`,
  `files-view-child-order.test.ts`,
  `debug-view-child-order.test.ts` (new): each test seeds the
  cards store with a shuffled-`position` vector across a
  parent card's children, mounts the corresponding view, and
  asserts the rendered DOM child order matches the
  position-asc plus `id.localeCompare` tiebreaker output of
  `cardsStore.childrenOf`. The three tests close the
  S03-inherited forecast ids
  `scenario-dashboard-child-order:step-1`,
  `scenario-files-view-child-order:step-1`, and
  `scenario-debug-view-child-order:step-1` as TRUE closes.
- `notifications-panel.test.ts`: deleted in-stage; the
  `scenario-notifications-panel:step-1` failing id is no
  longer observed because the test file no longer exists and
  cannot fail.

Integration:

- `operator-dashboard-smoke.test.ts`'s rewritten body is the
  integration arm; no new playwright scenario is added in
  this stage. S10 owns playwright reconciliation.

Live probe (gate):

- `check-mutation-traffic.sh` is invoked twice in Phase H,
  once per bootstrap state. Each invocation asserts zero
  non-bootstrap `POST|PUT|PATCH|DELETE` requests across
  `/dashboard`, `/cards`, `/files`, `/agents`, `/debug`.

Gates:

- The four S00 gates (`tsc-build`, `web-vite-build`,
  `web-vitest`, `analyst-e2e`) run via
  `bash SPEC/analyst-as-control-surface/PLAN/scripts/run-gates.sh
  --diff SPEC/analyst-as-control-surface/PLAN/baseline-gates.json`
  from `saivage-v3/`. Expected output: zero NEW failing ids
  on every gate, optional REPAIRED ids for the seven forecast
  ids if those failing ids appeared in baseline (they do not
  in the current snapshot, so the REPAIRED column is also
  empty), and exit code 0. S06 does not append any entry to
  the cumulative ledger because no NEW failure is
  intentionally left behind by this stage.

## Expected breakage forecast

S06 leaves **no NEW failing ids** behind in the paper-plan
default outcome. The seven forecast entries that S03 and S04
authored naming `S06` as their target fix stage are
conditionally closed at S06 close-out per `plan.md` Phase H:
three S03-inherited ids (`dashboard-child-order`,
`files-view-child-order`, `debug-view-child-order`) close TRUE
because S06 adds the missing surfaces (Dashboard child-of-goal
panel, Files per-card child listing, Debug per-card child-list
section) and the corresponding new vitest files PASS; four
S04-inherited ids (`notifications-panel`,
`stale-warning-ribbon`, `operator-dashboard-smoke`,
`operator-events-contract`) close per the same skeleton against
the S04-specified surfaces (panel deletion, ribbon
`isStale`-driven, smoke rewritten, contracts narrowed). On an
empty cumulative ledger (the paper-plan world before any
implementation actually runs the gates), no-op close-out
substeps make ZERO edits to the cumulative ledger (per S00's
ledger-as-open-entries-only contract); any no-op evidence is
written to the stage-local file
`SPEC/analyst-as-control-surface/PLAN/drafts/006-ui-mutation-removal-ordered-rendering/implementation-notes.md`
instead. Phase H's gate diff at H.5 shows the seven ids as
absent on both sides of the diff when the baseline is empty,
so neither NEW nor REPAIRED rows appear for them.

If, at implementation time, the gate diff observes a NEW
failing id that S06 cannot fix in-stage (for example, a hidden
caller of a deleted client function inside a non-test file the
Phase A grep missed), the stage does not close: the implementer
returns to the metaplan owner per MASTER-PLAN section 3 rule
(3) rather than silently appending a new forecast that would
require yet another stage to repair.

S07-targeted forecasts ARE permitted by `plan.md` Phase H.6.
The paper-plan default outcome is zero such forecasts: the v2
client deletion in B.6, the mutation-affordance removal in
F.1–F.13, and the test rewrites in G.2 are self-contained on
the frontend; the backend gates (`tsc-build`, `web-vite-build`,
`analyst-e2e`) have no UI-driven inputs in this stage. If, at
implementation time, a NEW failing id on `tsc-build`,
`web-vite-build`, or `analyst-e2e` is observed whose root cause
is a removed UI caller pointing at a backend mutation route
that S07 will delete (excluding the bounded-bootstrap routes
and `sendChatMessage`), Phase H.6 appends a strict-append
single-line forecast entry to the cumulative ledger naming S07
as the target fix stage. No removals are performed by H.6;
H.4.1–H.4.7 already performed any removals earlier in Phase H.

## Downstream impact

Per MASTER-PLAN §6.1, the following consumers are affected by
S06's contract changes; S06 fixes each consumer in this stage.

- The operator-side mutation HTTP routes
  (`saivage-v3/src/server/routes/cards.ts`,
  `runtime-config-notes.ts`, `processes.ts`,
  `chats-files-debug.ts`): unchanged in S06 (deletion belongs
  to S07). The live-probe gate proves no UI caller remains, so
  S07 can delete them without breaking the running
  application.
- The operator-API contract validator
  (`saivage-v3/src/contracts/operator-api.ts`): unchanged in
  S06; S07 prunes the contract entries for the routes it
  deletes.
- Any external integrations (Telegram bot scripts, sibling
  project dashboards) that still poke the operator HTTP
  surface: S06 does not affect them because the backend
  routes remain operational. S07 is the breaking change for
  external integrations.
- Vue child components transitively used by the removed forms
  (per-row action menus, drag-handle components,
  context-menu primitives): each such component is either
  deleted with its parent or, if it has read-only uses
  elsewhere, retained and its mutation props are dropped at
  the call site. The Phase F edit batch enumerates each one;
  any component that becomes unused after Phase F is deleted
  in the same batch.
- Toast / notification stores that consumed events emitted by
  the removed forms (e.g. "card deleted" toast): the emitters
  are deleted; the listener arms that read those event kinds
  are deleted from `web/src/stores/analystChat.ts` if any
  survived. The Phase F grep `analyst-toast|analyst-notify`
  catches stragglers.
- Keyboard-shortcut registry: `AppShell.vue`'s
  `handleKeydown` (after S05) handles digit shortcuts and `/`
  focus only; S06 audits it once more to confirm no mutating
  shortcut survived.
- `web/src/__tests__` files that simulated click-to-mutate
  flows: enumerated in `## Surfaces touched > Tests` above
  and rewritten or deleted in-stage per MASTER-PLAN section 3
  rule (4).
- E2E scenarios that depended on a clickable mutating
  affordance: S10 owns the playwright reconciliation. S06
  does not run playwright in Phase H beyond the existing
  baseline gate; if the `analyst-e2e` baseline gate observes
  a NEW failure caused by a removed UI caller pointing at a
  backend mutation route that S07 will delete (excluding
  bounded-bootstrap and `sendChatMessage`), S06 closes with a
  conditional forecast entry naming S07 via Phase H.6 (see
  `## Expected breakage forecast` for why this is not
  expected in the paper-plan world).

## Done-definition cross-reference to S00 plan.md V.1–V.11

The `V.1`–`V.11` labels below are S00's stage plan validation
items at
`SPEC/analyst-as-control-surface/PLAN/stages/000-breakage-detection-harness/plan.md`
under `## Validation gate`. They are the canonical close-out
checklist S06 runs. The orthogonal
`PLAN/VALIDATION-COOKBOOK.md` (numbered sections 1–10) supplies
the procedural definitions referenced by these V-items.

- V.1 (S00 baseline shape `jq` check): not S06's concern to
  re-run end-to-end; S06 reads `PLAN/baseline-gates.json` and
  edits it conditionally per `## Surfaces touched > Baseline`
  above (no-op against the current baseline).
- V.2 (gates run end-to-end via `validate-baseline.sh`): S06
  does not run the S00 baseline-capture validator; the
  equivalent S06 close-out check is the per-stage gate diff
  under V.3.
- V.3 (driver `--diff` invocation): four gates run via
  `PLAN/scripts/run-gates.sh --diff PLAN/baseline-gates.json`
  from `saivage-v3/`. Expected outcome: zero NEW failing ids
  on every gate and exit code 0.
- V.4 (cookbook sections present): not S06's concern;
  `PLAN/VALIDATION-COOKBOOK.md` is S00-owned and immutable
  after S00's publication.
- V.5 (ledger shape and emptiness): S06 reads the cumulative
  ledger to verify (a) it is shape-correct, (b) every entry
  whose `Target fix stage` is `S06` is conditionally closed
  per Phase H, and (c) no NEW entry is appended by S06. Per
  `## Expected breakage forecast` the ledger is empty at S06
  start and is also empty at S06 close.
- V.6 (preflight terminates parseably): not S06's concern; S06
  does not invoke `preflight.sh`.
- V.7 (preflight fail-closed under bad env-vars): not S06's
  concern.
- V.8 (S00 product-code untouched): S06 touches only
  `saivage-v3/web/src` and the new
  `PLAN/scripts/check-mutation-traffic.sh`; neither is part
  of S00's product-code set.
- V.9 (S00 doc surface stable): S06 does not edit
  `PLAN/VALIDATION-COOKBOOK.md` or any other S00-published
  doc.
- V.10 (S00 baseline immutability except via lifecycle rule):
  S06 conditionally refreshes `baseline-gates.json` only per
  the rule and only if the deleted/rewritten test ids are
  present in `failing_ids`.
- V.11 (S00 ledger procedure honoured): S06's Phase H runs the
  procedure (read, conditionally close, never silently
  fabricate, never silently append).
