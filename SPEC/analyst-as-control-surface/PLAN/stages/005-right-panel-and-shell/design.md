# S05 — Persistent right-side analyst panel + workspace shell restructure

## Goal

Restructure the operator web UI shell so the analyst chat is always
rendered as the right 20–30% of the viewport and the autonomous-runtime
workspace area is always rendered as the left 70–80%, with no drawer,
modal, slide-over, popover, or toggle in between. Remove every UI
control whose action is to open, close, expand, hide, or otherwise
change the visibility of the analyst panel. Repurpose the
"Discuss with analyst" affordance on inspectable entities to stage a
contextual seed in the always-visible composer rather than open or
reveal anything. Strip the persisted drawer-state slot from the
analyst chat store so neither localStorage nor the in-memory store
can put the panel into a hidden state.

The deliverable is a shell in which `cd web && npm run build`
(from `saivage-v3/`) succeeds, `cd web && npm test` (from
`saivage-v3/`) succeeds, and the
acceptance criteria pinned in SPEC-r7 `## Persistent panel layout and
contextual awareness`, `### Persistent panel layout`, and the
"no `toggleAnalyst` / `openAnalyst` / `closeAnalyst` / `analyst-drawer`
symbols" grep in MASTER-PLAN §S05 acceptance are satisfied.

## Scope

In scope:

- Rewrite the application shell root layout
  `saivage-v3/web/src/components/layout/AppShell.vue` so the
  `.workspace-row` becomes a CSS-grid container with two columns:
  the workspace area at `minmax(0, 1fr)` (70–80% of the viewport)
  and the analyst panel at `minmax(20rem, 25vw)` clamped between
  20% and 30% of the viewport at typical desktop widths. Both
  regions render unconditionally on first paint. The `v-if`
  guard on `<AnalystChatPanel>` is removed.
- Delete the analyst-drawer chip and its event wiring from
  `saivage-v3/web/src/components/layout/WorkspaceHeader.vue`: the
  `<button class="status-chip analyst-chip">` template block
  (lines 9-21 in the current file), the `analystDrawerOpen` prop
  declaration (line 65), the `'toggle-analyst': []` emit
  declaration (line 69), the `analyst-chip` / `chip-icon` styles
  (lines 181-205 and 253-258 in the current `<style>` block), and
  any helper computed property that exists only to render the chip.
- Delete the drawer-toggle plumbing from
  `saivage-v3/web/src/components/layout/AppShell.vue`:
  the `:analyst-drawer-open` and `@toggle-analyst` attributes on
  `<WorkspaceHeader>` (lines 23-24), the `toggleAnalystDrawer()`
  function (lines 124-126), the `Ctrl/Cmd+J` toggle branch in
  `handleKeydown` (lines 130-136 in the current file), and the
  `watch(() => route.fullPath, ...)` that auto-closed the drawer
  on route changes (lines 165-170 in the current file).
- Rewrite the drawer-state slice of
  `saivage-v3/web/src/stores/analystChat.ts`: delete the
  `DRAWER_STORAGE_KEY` constant (line 11), the
  `DEFAULT_DRAWER_WIDTH` constant (line 12), the `DrawerState`
  interface (lines 17-20), the `parseStoredDrawerState` helper
  (lines 72-91), the `persistDrawerState` helper
  (lines 93-96), the `drawerOpen` ref (line 184), the
  `drawerWidth` ref (line 185), the
  `watch([drawerOpen, drawerWidth], ...)` persistence watcher
  (lines 201-203), the `setDrawerOpen` action (lines 234-236),
  the `toggleDrawer` action (lines 238-240), the `setDrawerWidth`
  action (lines 242-244), and the corresponding store exports
  (lines 524-525 and 538-539). The store no longer owns any
  visibility-or-width state for the panel; CSS owns the width.
- Rewrite the per-entity "Discuss with analyst" affordance on
  `saivage-v3/web/src/components/cards/CardDetailView.vue` line 15
  so its click handler `openAnalystForCard` stages a contextual
  seed via `analystChat.seedCardContext(currentCard.value)` and
  calls `analystChat.fetchMessages(...)`, but no longer calls
  `setDrawerOpen(true)` (lines 491-492 and 496 in the current
  file). The button's `aria-label` text changes from
  `"Discuss card with analyst"` to
  `"Seed analyst chat with this card"`; the visible label text
  ("Discuss with analyst") stays per SPEC-r7
  `## Persistent panel layout and contextual awareness` paragraph
  on the contextual seed. A focus hand-off remains: after the
  seed is staged, the per-entity click also dispatches a
  `'saivage:focus-chat'` `CustomEvent` so the chat composer (which
  is already on screen) takes focus.
- Rewrite the `<aside>` root of
  `saivage-v3/web/src/components/chat/AnalystChatPanel.vue`
  (lines 2-9 of the current file) so it no longer presents itself
  as a togglable dialog: drop the `:class="{ open: drawerOpen }"`,
  drop the `:style="panelStyle"` width binding (line 6), drop the
  `role="dialog"` and `aria-modal="false"` attributes (lines 7-9),
  drop the `aria-label="Analyst chat panel"` shim, and replace
  the wrapper element with a plain `<aside>` that takes its full
  width from the parent grid track. Remove the
  `panelStyle` / `drawerWidth` / `drawerOpen` references in
  `<script setup>` (lines 143-144 and 159 in the current file) and
  the `watch(drawerOpen, ...)` block (line 267) plus its
  `if (drawerOpen.value)` branch (line 278).
- Delete the now-orphaned vitest file
  `saivage-v3/web/src/__tests__/app-shell-analyst-drawer.test.ts`
  (185 lines, all four `it(...)` cases assert toggle, drawer
  open-on-route-change closure, and `Ctrl+J` toggle — behaviours
  removed from SPEC-r7). The replacement test
  `saivage-v3/web/src/__tests__/app-shell-persistent-panel.test.ts`
  is added in this stage and asserts the inverse: first paint
  renders both regions, no `.analyst-chip` exists in the rendered
  DOM, no `localStorage` key `analyst-chat:drawer-state` is
  written, `Ctrl+J` is a no-op (i.e. does not change visibility
  or focus when the composer is not the focus target), and a
  route change leaves the analyst region visible.
- Rewrite the `.analyst-chip`-clicking arm of
  `saivage-v3/web/src/__tests__/operator-dashboard-smoke.test.ts`
  (line 414 in the current file): the click is removed because
  the chip is gone; the assertion is replaced with "the analyst
  panel is present in the DOM on first paint without any user
  click". The remainder of the file (the listNotifications /
  acknowledgeNotification mock setup) is owned by S06 per
  MASTER-PLAN §S06 acceptance "UI-side note-inbox panels are
  removed by S06/S09"; S05's edit only removes the chip click
  step and leaves the unrelated mock setup untouched.
- Update `saivage-v3/web/src/__tests__/card-detail-view.test.ts`
  and its snapshot
  `saivage-v3/web/src/__tests__/__snapshots__/card-detail-view.test.ts.snap`
  so that the "Discuss with analyst" button's `aria-label`
  matches the new copy and any assertion that asserted
  `setDrawerOpen` was invoked is rewritten to assert
  `seedCardContext` was invoked. Snapshot files are re-recorded
  in-stage with `npx vitest --update` confined to the affected
  tests.
- Conditionally refresh
  `SPEC/analyst-as-control-surface/PLAN/baseline-gates.json`
  per S00's baseline lifecycle rule: the only allowed edit is to
  drop the deleted `app-shell-analyst-drawer.test.ts` failing ids
  from the `web-vitest` gate's `failing_ids` array if they appear
  there. If no such id is present (the current baseline does not
  list any such id), `baseline-gates.json` is **not edited at
  all** — no `captured_at` bump, no comment edit, no field
  changes. Opportunistic baseline refresh is forbidden by S00 and
  S05 honours that rule. The new
  `app-shell-persistent-panel.test.ts` test ids are not added to
  any `failing_ids` list because the test passes after the S05
  changes land.

Out of scope (declared as forecast entries for the owning later
stage where they introduce NEW failures):

- The web-side notification panel
  `saivage-v3/web/src/components/cards/NotificationsPanel.vue`
  and the cross-cutting analyst-side notification listeners in
  `saivage-v3/web/src/stores/{analystChat,debug,cards}.ts`: owned
  by S06 per MASTER-PLAN §S06 acceptance.
- Removal of any other mutating affordance not on the analyst
  panel itself (new-card buttons, action menus, drag-to-reparent,
  per-note acknowledge, keyboard shortcuts that mutate, etc.):
  S06.
- Operator HTTP route pruning: S07.
- Analyst-driven navigation (`navigate_workspace` tool wiring) and
  full contextual-awareness payload: S08.
- Provider-secret-bootstrap surface relocation per SPEC-r7
  `### Bounded authentication-bootstrap exception`: out of scope
  for S05; the existing `<ApiTokenEntry>` modal continues to mount
  as an overlay above the persistent shell because it is the
  bounded bootstrap exception that SPEC-r7 explicitly permits.
- E2E coverage across every surface: S10.

## Dependencies

- S00 (breakage-detection harness).
  `SPEC/analyst-as-control-surface/PLAN/baseline-gates.json` and
  `PLAN/scripts/run-gates.sh` are the gate inputs S05 reads and
  refreshes. The four cheap baseline gates (`tsc-build`,
  `web-vite-build`, `web-vitest`, `analyst-e2e`) are the close-out
  gates.
- S01 (real-LLM analyst resolver). S05 consumes the analyst
  session that S01 made live. No S01 file is edited by S05.
- S02 (tool-surface alignment). The analyst tool registry remains
  the canonical analyst surface; S05 keeps the analyst panel
  pointed at the registry without modification. No S02 file is
  edited by S05.
- S03 (ordered children and bounded move). S05 does not edit the
  ordered-children rendering; the `CardDetailView.vue` change is
  limited to the "Discuss with analyst" handler. No S03 file is
  edited by S05.
- S04 (notifications: queue-only, ephemeral). S05 does not edit
  the notification primitive; the web-side
  `NotificationsPanel.vue` is owned by S06. No S04 file is edited
  by S05.

S05 is otherwise independent. The only construct from S00–S04 it
actively relies on at runtime is the analyst session that S01 and
S02 made live, plus the unchanged chat-message API surface
(`getChatMessages`, `sendChatMessage`,
`listAgentSessions`).

## Approach

### Grid layout

`AppShell.vue` switches from a nested flex layout to a single CSS
grid at the `.app-shell` level. The grid has **exactly two direct
grid children**: a left wrapper `<div class="workspace-shell">` and
the right-side `<AnalystChatPanel>`. All other current direct
children of the AppShell root (the `<AnalystToaster>` and
`<ApiTokenEntry>` overlays) become non-grid-participating overlay
surfaces by positioning them `position: fixed`, so they paint above
the grid but do not claim a grid cell. The AppShell's current
`<NavRail>`, `<WorkspaceHeader>`, `<router-view>` block, and
optional `.auth-required-banner` all move under `.workspace-shell`.

```
.app-shell {
  display: grid;
  grid-template-columns: minmax(0, 1fr) clamp(20rem, 25vw, 30vw);
  grid-template-rows: 1fr;
  height: 100%;
  width: 100%;
}

.workspace-shell {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  grid-template-rows: 1fr;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
}
```

The outer `.app-shell` grid's first track hosts `.workspace-shell`;
the second track hosts `<AnalystChatPanel>`. Inside
`.workspace-shell` there is a nested two-column grid whose first
(auto-sized) track hosts `<NavRail>` and whose second
(`minmax(0, 1fr)`) track hosts `.workspace-stack` (the
`<WorkspaceHeader>` + optional `.auth-required-banner` +
`<router-view>` flex column). The `clamp(20rem, 25vw, 30vw)`
expression keeps the analyst panel between 20rem (a readable
composer floor) and 30vw (the SPEC-r7 upper bound) at typical
desktop widths, with a 25vw nominal width landing inside the 20–30%
band the SPEC pins. The 20rem floor is a non-toggle accommodation
for narrow desktop widths only; behaviour at narrower widths is
intentionally unspecified per SPEC-r7
`### Persistent panel layout` (which only contracts the
typical-desktop-width band).

`<AnalystToaster>` and `<ApiTokenEntry>` remain as **overlay
surfaces, not grid children**. After the rewrite, both are still
mounted as direct children of `.app-shell` in source order, but
their own `<style scoped>` already declares `position: fixed` (the
toaster pins to a viewport corner; the token entry is a modal
overlay centred via `position: fixed; inset: 0`). Because both are
taken out of grid-track flow by `position: fixed`, they do not
auto-place into any of `.app-shell`'s two declared columns, and the
two-child grid contract above is preserved. The S05 rewrite does
not move, teleport, or restyle either component; it only verifies
that their existing fixed-positioning is still in effect after the
shell rewrite.

### No toggle, no drawer state

The visibility of the analyst panel is no longer a function of any
JavaScript state. The store's drawer-state slice is deleted
entirely (no `drawerOpen`, no `drawerWidth`, no
`DRAWER_STORAGE_KEY`, no `setDrawerOpen` / `toggleDrawer` /
`setDrawerWidth`). The panel renders unconditionally. The chip
in `WorkspaceHeader.vue` and the `Ctrl+J` keyboard shortcut in
`AppShell.vue` are deleted, not refactored. Per SPEC-r7
`### Persistent panel layout`, the absence is contract: any
mechanism that could put the panel into a hidden state is a
violation.

The two SPEC-r7 greps from MASTER-PLAN §S05 acceptance must hold
after this stage:

```
grep -RE 'toggleAnalyst|analyst-drawer|openAnalyst|closeAnalyst' \
  saivage-v3/web/src
```

returns zero matches. The plan's Phase H pins both this anchored
grep and a `drawerOpen|setDrawerOpen|toggleDrawer|drawerWidth|DRAWER_STORAGE_KEY`
guard to make the deletion symmetric on the store side too.

### Discuss with analyst becomes a seed

The current `openAnalystForCard` in `CardDetailView.vue` does two
things: it calls `setDrawerOpen(true)` (now meaningless) and it
calls `seedCardContext`. After S05 the function does only the
second, plus a focus hand-off:

```
async function openAnalystForCard(): Promise<void> {
  if (!currentCard.value) return;
  if (analystChat.hasDraft && typeof window !== 'undefined') {
    const shouldReseed = window.confirm(
      'You have an in-progress analyst draft. Reseed the chat with this card context?'
    );
    if (!shouldReseed) {
      window.dispatchEvent(new CustomEvent('saivage:focus-chat'));
      return;
    }
  }
  analystChat.seedCardContext(currentCard.value);
  await analystChat.fetchMessages(analystChat.activeSessionId).catch(() => {});
  window.dispatchEvent(new CustomEvent('saivage:focus-chat'));
}
```

The `saivage:focus-chat` event is already listened to by
`AnalystChatPanel.vue` (the existing focus-on-Ctrl+/ flow); this
stage repurposes it as the user-visible hand-off for a Discuss
click. No new global event channel is introduced.

The button label "Discuss with analyst" is unchanged on screen.
The `aria-label` becomes "Seed analyst chat with this card" to
match the new behaviour, per SPEC-r7 `## Persistent panel layout
and contextual awareness` paragraph on the contextual seed.

### Analyst chat panel as a fixed grid track

`AnalystChatPanel.vue` becomes a static aside that fills its grid
track. The `aside` root keeps its `id="analyst-chat-panel"` (used
by anchor links from elsewhere in the app) but drops every
attribute that implied togglability:

- `class="analyst-chat-panel"` is kept; `:class="{ open: drawerOpen }"`
  is removed.
- `:style="panelStyle"` is removed; the panel's width is the grid
  track's width.
- `role="dialog"` and `aria-modal="false"` are removed; the panel
  is structural chrome, not a modal surface. ARIA semantics narrow
  to a labelled region:
  `role="region" aria-labelledby="analyst-chat-title"`. The
  existing `<h2 id="analyst-chat-title">Analyst</h2>` already
  exists in the header.
- The internal `watch(drawerOpen, ...)` that conditionally focused
  the composer is replaced by a single
  `onMounted(() => composerRef.value?.focus())` so the composer
  is focusable on first paint per SPEC-r7
  `### Persistent panel layout`.

### Bootstrap exception is preserved

The `<ApiTokenEntry>` modal in
`saivage-v3/web/src/components/auth/ApiTokenEntry.vue` continues
to mount above the persistent shell on demand. SPEC-r7
`### Bounded authentication-bootstrap exception` permits exactly
this surface as the minimum needed to bring an unauthenticated
user to the analyst. No additional bootstrap relocation is part
of S05; that work is owned by S06's "two bootstrap states" live
probe.

### Audit and surfaces

S05 introduces zero new analyst-side mutating tools and zero new
planner-control tools. There is no analyst tool registered for
the persistent-panel work; the new "stage a seed" affordance is
a local, client-side hand-off that does not mutate server state
(`seedCardContext` already only writes to the in-memory analyst
chat store; it sends no HTTP request and emits no platform event).
No `recordControlAction` call sites are added. No `safety_class`
slot is introduced; the stage as a whole is `safety_class: 'low'`
per MASTER-PLAN §S05 (UI shell mutations are non-destructive).

### Cookbook V.1–V.11 mapping

The `V.1`–`V.11` labels referenced throughout S05 are **not**
sections of `PLAN/VALIDATION-COOKBOOK.md`. That file is numbered as
sections 1 through 10 (Purpose, Pre-conditions, Gate command
blocks, Driver invocation, Comparison rule, Close criterion, Ledger
update procedure, Ledger entry shape, Activation preflight,
Pre-publication forbidden-anchor grep). The `V.1`–`V.11` labels
live in **S00's stage plan**
(`SPEC/analyst-as-control-surface/PLAN/stages/000-breakage-detection-harness/plan.md`
under `## Validation gate`), which is the canonical close-out
checklist S05 runs. See
`## Done-definition cross-reference to S00 plan.md V.1–V.11` below
for the explicit mapping.

## Surfaces touched

Frontend:

- `saivage-v3/web/src/components/layout/AppShell.vue` — rewritten:
  flex layout replaced with CSS grid, header chip wiring removed,
  Ctrl+J branch removed, route-change drawer-close watch removed,
  `<AnalystChatPanel>` rendered unconditionally.
- `saivage-v3/web/src/components/layout/WorkspaceHeader.vue` —
  `<button class="status-chip analyst-chip">` block removed; the
  `analystDrawerOpen` prop removed; the `toggle-analyst` emit
  removed; the `.analyst-chip` and `.chip-icon` styles removed.
- `saivage-v3/web/src/components/chat/AnalystChatPanel.vue` — aside
  attributes narrowed (no `role="dialog"`, no
  `aria-modal`, no `panelStyle`, no `:class="{ open: drawerOpen }"`);
  `drawerOpen` and `drawerWidth` no longer imported from the store;
  `watch(drawerOpen, ...)` replaced by `onMounted` composer focus.
- `saivage-v3/web/src/stores/analystChat.ts` — drawer-state slice
  removed: `DRAWER_STORAGE_KEY`, `DEFAULT_DRAWER_WIDTH`,
  `DrawerState`, `parseStoredDrawerState`, `persistDrawerState`,
  `drawerOpen`, `drawerWidth`, `setDrawerOpen`, `toggleDrawer`,
  `setDrawerWidth`, and the persistence `watch(...)`. Exports
  list narrows accordingly.
- `saivage-v3/web/src/components/cards/CardDetailView.vue` —
  `openAnalystForCard` rewritten as described above; the button's
  `aria-label` updated.

Tests:

- `saivage-v3/web/src/__tests__/app-shell-analyst-drawer.test.ts`
  — deleted.
- `saivage-v3/web/src/__tests__/app-shell-persistent-panel.test.ts`
  — added; covers first-paint visibility of both regions, no
  `.analyst-chip` in the rendered DOM, no
  `analyst-chat:drawer-state` key in `localStorage` after mount,
  `Ctrl+J` is a no-op for visibility, route change preserves
  analyst region.
- `saivage-v3/web/src/__tests__/operator-dashboard-smoke.test.ts`
  — `.analyst-chip` click step at line 414 removed; an assertion
  is added that `wrapper.find('#analyst-chat-panel').exists()` is
  `true` on first paint. The listNotifications /
  acknowledgeNotification mock setup is owned by S06 and is not
  touched here.
- `saivage-v3/web/src/__tests__/card-detail-view.test.ts` and its
  snapshot file — button `aria-label` re-recorded; any
  `setDrawerOpen` assertion replaced with `seedCardContext`
  assertion.

Baseline:

- `SPEC/analyst-as-control-surface/PLAN/baseline-gates.json` —
  edited only if the deleted `app-shell-analyst-drawer.test.ts`
  ids currently appear in the `web-vitest` gate's `failing_ids`
  array. The current baseline does not list any such id, so the
  expected outcome is **no edit at all**: no `captured_at` bump,
  no `comparison_rule` change, no `command` change, no
  whitespace touch. S00's lifecycle rule forbids opportunistic
  baseline refresh; S05 obeys that rule rather than treating the
  baseline as a stage-close timestamp surface.

Backend: none. S05 makes no edit under `saivage-v3/src/`.

## Test plan

Unit (Vue SFC + store):

- `app-shell-persistent-panel.test.ts`:
  - first paint mounts both regions; `wrapper.find('.nav-rail').exists()`,
    `wrapper.find('.workspace-content').exists()`, and
    `wrapper.find('#analyst-chat-panel').exists()` are all `true`
    without any click;
  - the rendered DOM has no `.analyst-chip` element and no
    `aria-controls="analyst-chat-panel"` button;
  - `localStorage.getItem('analyst-chat:drawer-state')` is `null`
    after mount and after a Ctrl+J keyboard event;
  - route change from `/dashboard` to `/files` leaves
    `#analyst-chat-panel` mounted;
  - the chat composer (`textarea[aria-label="Analyst chat composer"]`)
    is focusable on first paint (i.e. exists and is not
    `disabled`).
- `card-detail-view.test.ts`: the existing case that renders the
  detail view also asserts the new `aria-label` text on
  `.discuss-btn`; the new case asserts that clicking the button
  calls `seedCardContext` on the analyst chat store exactly once
  and dispatches one `'saivage:focus-chat'` event.

Integration (vitest, mounted shell):

- `operator-dashboard-smoke.test.ts` after the S05 edit:
  the smoke flow opens `/dashboard`, asserts the analyst panel is
  present without any chip click, and proceeds with the rest of
  the dashboard mock. The `.analyst-chip` click and its
  follow-up `expect(analystPanel.classes()).toContain('open')`
  assertion are removed because the chip no longer exists; the
  surrounding session-picker / composer-disabled assertions
  remain because they exercise the always-visible panel. The
  pre-existing `listNotifications` / `acknowledgeNotification`
  `vi.fn` mocks in the test's `vi.mock('../api/client', ...)`
  block already cover the dashboard's notification client path
  (they return empty notification arrays); S05 does not depend
  on or modify any other behaviour of the surrounding
  `NotificationsPanel.vue` mount. The test must pass after S05's
  edits land; no `web-vitest` failure for this id is forecast.

E2E: none owned by S05. The persistent panel is exercised
incidentally by every analyst-e2e scenario; if the playwright
config currently expects a Ctrl+J open step to reach the chat
composer, the test author for that scenario updates it in S10
when the suite is reconciled. S05 does not introduce a new
playwright scenario.

Gates:

- The four S00 gates (`tsc-build`, `web-vite-build`, `web-vitest`,
  `analyst-e2e`) run via
  `bash SPEC/analyst-as-control-surface/PLAN/scripts/run-gates.sh
  --diff SPEC/analyst-as-control-surface/PLAN/baseline-gates.json`
  from `saivage-v3/`. Expected output: zero NEW failing ids on
  every gate, optional REPAIRED ids if the in-stage test
  rewrites incidentally clear prior baseline failures, and
  exit code 0. S05 does not append any entry to the cumulative
  ledger because no NEW failure is intentionally left behind by
  this stage.

## Expected breakage forecast

S05 leaves **no NEW failing ids** behind. An earlier writer
iteration of this section had forecasted one
`operator-dashboard-smoke` `web-vitest` failure on the assumption
that the test's notification-mock setup would still break after the
chip click was removed; the reviewer confirmed the mocks at `operator-dashboard-smoke.test.ts` lines 324–325 already
cover the dashboard's notification client path, so the in-stage
test rewrite (G.3) leaves the smoke test green. The cumulative
ledger
(`SPEC/analyst-as-control-surface/PLAN/expected-breakage-ledger.md`)
therefore receives **no append** from S05's close-out. If at
implementation time the gate diff observes a NEW failing id that
S05 cannot fix in-stage, the stage does not close: the implementer
returns to the metaplan owner instead of silently appending a new
forecast.

## Downstream impact

Per MASTER-PLAN §6.1, the following consumers are affected by S05's
contract changes; S05 fixes each consumer in this stage.

- Root layout grid in
  `saivage-v3/web/src/components/layout/AppShell.vue`: rewritten in
  S05.
- CSS variables / theming files used by `.workspace-row` and
  `.workspace-content` (currently inline `<style scoped>`; no
  shared CSS-variable file exists): no shared-token edit is
  required because the layout uses literal `clamp()` and
  `minmax()` expressions that do not reference theme tokens.
- Nav rail interaction with the now-persistent panel
  (`saivage-v3/web/src/components/nav/NavRail.vue`): audited; the
  nav rail does not currently subscribe to drawer state, so no
  edit is required. The keyboard shortcut handler in `AppShell.vue`
  drops the `Ctrl+J` branch but keeps the digit-shortcut branches
  (`1`..`5`) intact.
- Focus / keyboard accessibility on the always-visible chat
  (`saivage-v3/web/src/components/chat/AnalystChatPanel.vue`): the
  composer is focusable on first paint via an `onMounted` focus
  call; the existing `'saivage:focus-chat'` `CustomEvent` listener
  is the focus hand-off used by Discuss-with-analyst and by the
  global `/` keyboard shortcut (line 145 in the current
  `AppShell.vue`).
- Any Vue component that imported the drawer-toggle store
  (`drawerOpen`, `drawerWidth`, `setDrawerOpen`, `toggleDrawer`,
  `setDrawerWidth`): the only callers in the current tree are
  `AppShell.vue`, `AnalystChatPanel.vue`, and
  `CardDetailView.vue`, all rewritten in S05. The Phase H
  `drawerOpen|setDrawerOpen|toggleDrawer|drawerWidth|DRAWER_STORAGE_KEY`
  grep guard pins this to zero remaining hits.
- Web tests that asserted the toggle / drawer behaviour
  (`app-shell-analyst-drawer.test.ts`, the `.analyst-chip` click
  arm of `operator-dashboard-smoke.test.ts`,
  `card-detail-view.test.ts`'s `setDrawerOpen` assertion): the
  first is deleted in-stage, the second and third are rewritten
  in-stage per MASTER-PLAN section 3 rule (4) ("tests are removed
  only when the behaviour they describe is genuinely no longer
  part of SPEC-r7; that removal is a real (not ledgered)
  change").

## Done-definition cross-reference to S00 plan.md V.1–V.11

The `V.1`–`V.11` labels below are S00's stage plan validation
items at
`SPEC/analyst-as-control-surface/PLAN/stages/000-breakage-detection-harness/plan.md`
under `## Validation gate`. They are the canonical close-out
checklist S05 runs. The orthogonal
`PLAN/VALIDATION-COOKBOOK.md` (numbered sections 1–10) supplies
the procedural definitions referenced by these V-items (in
particular section 4 "Driver invocation", section 5 "Comparison
rule", section 6 "Close criterion", section 7 "Ledger update
procedure", and section 10 "Pre-publication forbidden-anchor
grep"); the cookbook does not itself carry V-labels.

- V.1 (S00 baseline shape `jq` check): not S05's concern to
  re-run end-to-end; S05 reads `PLAN/baseline-gates.json` and
  edits it conditionally per
  `## Surfaces touched > Baseline` above (no-op against the
  current baseline).
- V.2 (gates run end-to-end via `validate-baseline.sh`): S05 does
  not run the S00 baseline-capture validator; the equivalent
  S05 close-out check is the per-stage gate diff under V.3.
- V.3 (driver `--diff` invocation): four gates run via
  `PLAN/scripts/run-gates.sh --diff PLAN/baseline-gates.json`
  from `saivage-v3/`. Expected outcome: zero NEW failing ids on
  every gate and exit code 0. No diff entries are forecast for
  S05.
- V.4 (cookbook sections present): not S05's concern;
  `PLAN/VALIDATION-COOKBOOK.md` is S00-owned and immutable
  after S00's publication.
- V.5 (ledger shape and emptiness): S05 reads the cumulative
  ledger to verify (a) it is shape-correct and (b) no S05-
  targeted H3 entry remains open at close-out time. Per A.6 the
  ledger is empty at S05 start; S05 does not append any new
  entry (no forecast); the close-out check therefore reduces to
  "no S05-targeted entry exists at close-out".
- V.6 (preflight terminates parseably): not S05's concern; S05
  does not invoke `preflight.sh`.
- V.7 (preflight fail-closed under bad env-vars): not S05's
  concern.
- V.8 (S00 product-code untouched): S05 may touch
  `saivage-v3/web/src` (which V.8 specifically allows for later
  stages — V.8 is an S00-local guard against product churn
  during baseline capture, not a workspace-wide read-only rule).
- V.9 (no forbidden anchor in this stage's draft): S05's
  close-out runs the writer-autonomy grep against this stage's
  `design.md` and `plan.md` using
  `PLAN/forbidden-anchors.txt` and the inline literal
  alternation; zero hits required from both.
- V.10 (every link in this stage's docs resolves): S05's
  close-out runs `PLAN/scripts/check-stage-links.sh` against the
  draft (and again against the published) stage directory; all
  links resolve.
- V.11 (fresh snapshot vs baseline shows zero NEW failures): the
  per-stage gate diff under V.3 must show zero NEW failing ids
  and exit code 0. This is the S05 close-out's primary gate.

Additional S05-local guards that are not numbered V-items but are
pinned by Phase H:

- Host-path grep on the drafts directory returns zero hits
  (every host-relative path in `design.md` and `plan.md` is
  rooted at `saivage-v3/...`).
- Emoji grep on the drafts directory returns zero hits.
- Stage directory name uses the literal
  `005-right-panel-and-shell` matching the PROTOCOL-r4 regex.
- Atomic publication via a single directory rename from
  `drafts/` to `stages/` on the same filesystem; no in-place
  edits to a published stage (PROTOCOL-r4 immutability rule).
- The cumulative ledger path is the singular
  `PLAN/expected-breakage-ledger.md`; no per-stage ledger file
  is created.
- Predecessor stages S00–S04 are read but never modified.
