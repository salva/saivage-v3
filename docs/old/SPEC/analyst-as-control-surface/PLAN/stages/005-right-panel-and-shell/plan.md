# S05 — Persistent right-side analyst panel + workspace shell restructure — Plan

Working directory for every shell command in this file is
`/home/salva/g/ml/saivage-v3`. Paths in this plan are relative to
that directory unless they start with
`SPEC/analyst-as-control-surface/`.

## Phase A — Prep and inventory

A.1 Read [design.md](./design.md) end-to-end and confirm
`## Surfaces touched > Frontend` enumerates every file this plan
edits or deletes.

A.2 Confirm the S00 gate harness is in place:
`test -x SPEC/analyst-as-control-surface/PLAN/scripts/run-gates.sh
&& test -f SPEC/analyst-as-control-surface/PLAN/baseline-gates.json`.

A.3 Confirm S01–S04 are published (immutable predecessors):
`test -d SPEC/analyst-as-control-surface/PLAN/stages/001-real-llm-analyst-resolver`,
`test -d SPEC/analyst-as-control-surface/PLAN/stages/002-tool-surface-alignment`,
`test -d SPEC/analyst-as-control-surface/PLAN/stages/003-ordered-children-and-bounded-move`,
`test -d SPEC/analyst-as-control-surface/PLAN/stages/004-notifications-queue-ephemeral`.
Any failed test indicates a missing predecessor; halt and surface
to the metaplan owner before continuing.

A.4 Snapshot the current drawer-toggle surface for the deletion
diff:
`grep -REn 'toggleAnalyst|analyst-drawer|openAnalyst|closeAnalyst' web/src > tmp/s05/pre-toggle-anchor.txt`
and
`grep -REn 'drawerOpen|setDrawerOpen|toggleDrawer|drawerWidth|DRAWER_STORAGE_KEY' web/src > tmp/s05/pre-drawer-state.txt`.
The first file is expected to be empty against the current tree
(MASTER-PLAN §S05 acceptance pre-requisite); the second file is
expected to be non-empty because the store still owns drawer
state.

A.5 Capture a fresh pre-edit gate run to confirm the working
tree matches the baseline:
`bash SPEC/analyst-as-control-surface/PLAN/scripts/run-gates.sh
--diff SPEC/analyst-as-control-surface/PLAN/baseline-gates.json > tmp/s05/pre.txt`.
Exit code 0 means no unexpected drift. Non-zero indicates either
a predecessor regression or an unrecorded forecast entry; in
either case, stop and surface to the metaplan owner before
continuing.

A.6 Read [expected-breakage-ledger.md](../../expected-breakage-ledger.md)
once. Record locally (in a scratch file under `tmp/s05/`, not in
the repo) every H3 block whose `Target fix stage` line reads
`S05`. Phase H re-reads this state before close-out. The ledger
is expected to be empty per S04's close-out review; if any S05-
targeted entry exists, Phase H's conditional close-out is
exercised.

A.7 Verify the SFC corruption guard tooling is on hand. The
risk note in MASTER-PLAN §S05 calls out duplicate-`<script setup>`
corruption; the per-file verification command pinned for this
stage is:
`for f in web/src/components/layout/AppShell.vue web/src/components/layout/WorkspaceHeader.vue web/src/components/chat/AnalystChatPanel.vue web/src/components/cards/CardDetailView.vue; do echo "$(grep -c '<script setup' "$f") $f"; done`.
Each line must show exactly `1 <path>` before any Vite build is
invoked.

A.8 Create `tmp/s05/` for in-progress notes, grep snapshots, and
the gate-diff outputs.

## Phase B — Analyst chat store: drop the drawer slice

B.1 Open `web/src/stores/analystChat.ts`. Delete the
`DRAWER_STORAGE_KEY` constant declaration at line 11 and the
`DEFAULT_DRAWER_WIDTH` constant at line 12. Both constants are
no longer referenced after this phase.

B.2 In the same file, delete the `DrawerState` interface
declaration at lines 17-20.

B.3 Delete the `parseStoredDrawerState` helper function at lines
72-91 and the `persistDrawerState` helper function at lines 93-96.

B.4 Inside the `defineStore('analyst-chat', () => { ... })`
factory: delete the `const storedDrawer = parseStoredDrawerState();`
line; delete the `const drawerOpen = ref(storedDrawer.open);` and
`const drawerWidth = ref(storedDrawer.width);` declarations (lines
184-185 in the current file); delete the
`watch([drawerOpen, drawerWidth], ([open, width]) => { persistDrawerState(open, width); }, { immediate: true });`
block (lines 201-203).

B.5 Delete the action declarations `setDrawerOpen` (lines
234-236), `toggleDrawer` (lines 238-240), and `setDrawerWidth`
(lines 242-244).

B.6 In the `return { ... }` block at the bottom of the factory
(lines 514-548 in the current file), remove `drawerOpen`,
`drawerWidth`, `setDrawerOpen`, `toggleDrawer`, and
`setDrawerWidth` from the returned object.

B.7 Run
`grep -n 'drawerOpen\|setDrawerOpen\|toggleDrawer\|drawerWidth\|DRAWER_STORAGE_KEY\|DEFAULT_DRAWER_WIDTH\|parseStoredDrawerState\|persistDrawerState\|DrawerState' web/src/stores/analystChat.ts`.
Zero hits required after the edits land.

B.8 Run `npx vue-tsc --noEmit -p web/tsconfig.json`. The
remaining errors should be confined to the call-site files
listed in Phase C (`AppShell.vue`, `AnalystChatPanel.vue`,
`CardDetailView.vue`). Any error outside this set indicates a
missed call site; pause and update the design before continuing.

## Phase C — AppShell layout rewrite

C.1 Open `web/src/components/layout/AppShell.vue`. In the
`<template>` block, rewrite the root so the `.app-shell` element
contains **exactly two direct grid children plus the existing
overlay surfaces** (which are taken out of grid flow by their
own `position: fixed` styles). The post-edit structure is:

```
<template>
  <div class="app-shell" @keydown="handleKeydown">
    <div class="workspace-shell">
      <NavRail
        :nav-items="navItems"
        :docs-href="docsHref"
        @open-token="showTokenDialog = true"
      />
      <div class="workspace-stack">
        <WorkspaceHeader ... />
        <main class="workspace-content">
          <div v-if="showAuthBanner" class="auth-required-banner" ...>...</div>
          <router-view v-slot="{ Component }">
            <transition name="fade" mode="out-in">
              <component :is="Component" />
            </transition>
          </router-view>
        </main>
      </div>
    </div>
    <AnalystChatPanel />
    <AnalystToaster />
    <ApiTokenEntry
      :visible="showTokenDialog"
      @close="showTokenDialog = false"
      @saved="showTokenDialog = false"
    />
  </div>
</template>
```

Mapping for every current direct child of `.app-shell`:

- `<NavRail>` (currently lines 3-7) moves **into**
  `.workspace-shell` as its first nested-grid track.
- The current `<div class="main-area">` wrapper (currently lines
  9-43) is **deleted**; its children migrate as follows.
- `<WorkspaceHeader>` (currently lines 10-25, inside `.main-area`)
  moves **into** `.workspace-stack` as the first row of that
  flex column. The `:analyst-drawer-open` and `@toggle-analyst`
  bindings are removed per C.2.
- The current `<div class="workspace-row">` wrapper (currently
  lines 27-42) is **deleted**; its children migrate as follows.
- `<main class="workspace-content">` plus the optional
  `.auth-required-banner` and the `<router-view>` `<transition>`
  block move **into** `.workspace-stack` directly under
  `<WorkspaceHeader>`.
- `<AnalystChatPanel>` (currently line 41, guarded by
  `v-if="analystChat.drawerOpen"`) moves to become the **second
  direct grid child of `.app-shell`** and the `v-if` is removed
  per C.3.
- `<AnalystToaster>` (currently line 45) stays as a direct
  child of `.app-shell` in source order **after**
  `<AnalystChatPanel>`. Because its own scoped style declares
  `position: fixed` (toaster pinned to a viewport corner), it
  does not consume a grid cell; the two-track grid contract is
  preserved.
- `<ApiTokenEntry>` (currently lines 47-51) stays as a direct
  child of `.app-shell` in source order **after**
  `<AnalystToaster>`. Its own scoped style declares
  `position: fixed; inset: 0` for the modal overlay; it does
  not consume a grid cell.

After this edit, `.app-shell`'s two **grid-participating**
children are exactly `.workspace-shell` and `<AnalystChatPanel>`,
in that left-to-right order, mapped to the two `grid-template-columns`
tracks declared in C.8.

C.2 In the same template block, remove the `:analyst-drawer-open`
attribute (line 23) and the `@toggle-analyst` listener (line 24)
from `<WorkspaceHeader>`. The `<WorkspaceHeader>` props slot
narrows by one entry.

C.3 Remove the `v-if="analystChat.drawerOpen"` attribute from
`<AnalystChatPanel>` (line 41 in the current file). The panel
renders unconditionally.

C.4 In the `<script setup>` block, delete the
`toggleAnalystDrawer()` function (lines 124-126).

C.5 In `handleKeydown` (the function around line 130 in the
current file), delete the entire `if ((event.ctrlKey || event.metaKey) && key.toLowerCase() === 'j') { ... }`
branch (lines 130-136). The remaining branches (digit shortcuts
and `/` focus hand-off) stay.

C.6 Delete the
`watch(() => route.fullPath, () => { if (analystChat.drawerOpen) { analystChat.setDrawerOpen(false); } });`
block (lines 165-170 in the current file). Route changes no
longer have any effect on the analyst panel's visibility.

C.7 In the same `<script setup>` block, narrow the import line
`import { useAnalystChat } from '../../stores/analystChat';` so
the `analystChat` binding is only used by code paths that still
need it (the synthetic-hint focus listener stays; the
drawer-state references are gone). If no remaining reference
exists, delete the `const analystChat = useAnalystChat();` line.

C.8 In the `<style scoped>` block, replace the `.app-shell`,
`.main-area`, `.workspace-row`, and `.workspace-content` rule
sets so they implement the grid layout pinned in design.md
`## Approach > Grid layout`. The complete post-edit CSS for the
shell layout is:

```
.app-shell {
  display: grid;
  grid-template-columns: minmax(0, 1fr) clamp(20rem, 25vw, 30vw);
  grid-template-rows: 1fr;
  height: 100%;
  width: 100%;
  outline: none;
}

.workspace-shell {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  grid-template-rows: 1fr;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
}

.workspace-stack {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
}

.workspace-content {
  flex: 1;
  overflow: auto;
  background: #0d1117;
}
```

Track placement is positional (no explicit `grid-area` /
`grid-column` declarations needed): the outer `.app-shell`
grid auto-places its two grid-participating children in source
order — `.workspace-shell` lands in column 1, `<AnalystChatPanel>`
lands in column 2 (its scoped `.analyst-chat-panel` style after
Phase E sizes to `width: 100%; height: 100%;`, so it fills the
right track). Inside `.workspace-shell`, `<NavRail>` lands in
column 1 (auto-sized to the rail's intrinsic width via its own
scoped style) and `.workspace-stack` lands in column 2
(`minmax(0, 1fr)`, taking the remaining width). The
`<AnalystToaster>` and `<ApiTokenEntry>` overlay surfaces are
removed from grid flow by their **own existing**
`position: fixed` declarations (in their respective
`<style scoped>` blocks); they paint above the shell but claim
no grid cell. The S05 edit does not modify either component's
CSS.

The `.nav-rail` rule set in `NavRail.vue` and the
`<WorkspaceHeader>` scoped styles are unchanged.

C.9 Save the file. Run
`grep -c '<script setup' web/src/components/layout/AppShell.vue`
and confirm exactly `1`. If `2`, the SFC has been duplicated;
restore from `git checkout` and redo the edits per
`memory:/memories/vue-sfc-corruption.md`.

C.10 Run
`grep -nE 'analyst-drawer|toggleAnalyst|openAnalyst|closeAnalyst|drawerOpen|setDrawerOpen|toggleDrawer|drawerWidth' web/src/components/layout/AppShell.vue`.
Zero hits required.

## Phase D — WorkspaceHeader chip removal

D.1 Open `web/src/components/layout/WorkspaceHeader.vue`. In the
`<template>` block, delete the entire
`<button class="status-chip analyst-chip" ...>` element (lines
9-21 in the current file) including its `<span class="chip-icon">`
child. The `.header-right` flex row keeps its remaining children
(`.ws-chip`, `.runtime-chip`, the optional `.cue-chip`).

D.2 In the `<script setup>` block, delete the
`analystDrawerOpen?: boolean;` entry from the `defineProps<{ ... }>()`
declaration (line 65 in the current file).

D.3 In the same block, delete the
`'toggle-analyst': [];` entry from the `defineEmits<{ ... }>()`
declaration (line 69 in the current file). If `defineEmits` then
has no remaining entries, delete the entire `defineEmits` call.

D.4 If there are any computed properties or helpers that exist
only to render the deleted chip (`analystButtonTitle`,
`analystExpanded`, etc., searched by
`grep -nE 'analystButton|analystExpanded|analystChip' web/src/components/layout/WorkspaceHeader.vue`),
delete them in the same edit batch.

D.5 In the `<style scoped>` block, delete the `.analyst-chip`
rule set (lines 181-193), the `.chip-icon` rule set (lines
194-205), and the `.analyst-chip:hover` rule set (lines 253-258).
The remaining `.status-chip`, `.ws-chip`, `.runtime-chip`,
`.cue-chip`, and `.chip-dot` rule sets stay.

D.6 Save. Run
`grep -c '<script setup' web/src/components/layout/WorkspaceHeader.vue`
and confirm exactly `1`.

D.7 Run
`grep -nE 'analyst-chip|analystDrawerOpen|toggle-analyst|chip-icon' web/src/components/layout/WorkspaceHeader.vue`.
Zero hits required.

## Phase E — AnalystChatPanel as a static aside

E.1 Open `web/src/components/chat/AnalystChatPanel.vue`. In the
`<template>` block, rewrite the `<aside>` root opening tag:

```
<aside
  id="analyst-chat-panel"
  class="analyst-chat-panel"
  role="region"
  aria-labelledby="analyst-chat-title"
>
```

The attributes `:class="{ open: drawerOpen }"`,
`:style="panelStyle"`, `role="dialog"`, `aria-modal="false"`, and
`aria-label="Analyst chat panel"` are removed. The
`<h2 id="analyst-chat-title">Analyst</h2>` already inside the
`.chat-header` block satisfies the labelled-region requirement.

E.2 In the `<script setup>` block, remove `drawerOpen` and
`drawerWidth` from the `storeToRefs(chat)` destructuring
(lines 143-144 in the current file).

E.3 Delete the `panelStyle` computed property declaration:
`const panelStyle = computed(() => ({ width: `${drawerWidth.value}px` }));`
(line 159 in the current file).

E.4 Delete the `watch(drawerOpen, ...)` block (line 267 in the
current file). An `onMounted` handler **already exists** in this
file at lines 273-281 of the current source (it calls
`chat.fetchSessions()`, optionally `chat.fetchMessages(...)`, and
contains a gated `if (drawerOpen.value) { void nextTick(() => focusComposer()); }`
branch). The edit is therefore: **extend the existing
`onMounted` block, do not duplicate it**. Delete the
`if (drawerOpen.value) { void nextTick(() => focusComposer()); }`
gated branch and replace it with an unconditional
`void nextTick(() => focusComposer());` (or call
`composerRef.value?.focus()` directly if `focusComposer` is the
thin wrapper around that) so the composer is focused on first
paint per SPEC-r7 `### Persistent panel layout`. The post-edit
`onMounted` block reads:

```
onMounted(() => {
  chat.fetchSessions().catch(() => {});
  if (activeSessionId.value) {
    chat.fetchMessages(activeSessionId.value).catch(() => {});
  }
  void nextTick(() => focusComposer());
});
```

Verify there is exactly one `onMounted(` call site in the file
after the edit:
`grep -c 'onMounted(' web/src/components/chat/AnalystChatPanel.vue`
must print `1`.

E.5 Confirm the existing `'saivage:focus-chat'` `CustomEvent`
listener stays. The listener already lives in this file (it
focuses the composer when other surfaces dispatch the event);
S05 reuses it as the focus hand-off for "Discuss with analyst".
If the listener was previously gated by `drawerOpen.value`,
remove that gate so the focus call always lands.

E.6 In the `<style scoped>` block, replace the `.analyst-chat-panel`
rule set so it sizes to the parent grid track (full width,
full height) and drops every `transform`, `transition`, or
`right: 0` declaration that implied slide-in behaviour. The
final rule set is:

```
.analyst-chat-panel {
  display: flex;
  flex-direction: column;
  width: 100%;
  height: 100%;
  background: #161b22;
  border-left: 1px solid #30363d;
  overflow: hidden;
}
```

The `.analyst-chat-panel.open` selector is deleted.

E.7 Save. Run
`grep -c '<script setup' web/src/components/chat/AnalystChatPanel.vue`
and confirm exactly `1`.

E.8 Run
`grep -nE 'drawerOpen|drawerWidth|panelStyle|aria-modal|role="dialog"|analyst-chat-panel\.open' web/src/components/chat/AnalystChatPanel.vue`.
Zero hits required.

## Phase F — Discuss with analyst becomes a seed

F.1 Open `web/src/components/cards/CardDetailView.vue`. In the
`<template>` block, update the `.discuss-btn` element at line
15: change `aria-label="Discuss card with analyst"` to
`aria-label="Seed analyst chat with this card"`. The visible
button label text ("Discuss with analyst") is unchanged.

F.2 In the `<script setup>` block, rewrite `openAnalystForCard`
(lines 487-498 in the current file) per design.md `## Approach
> Discuss with analyst becomes a seed`. The function calls
`seedCardContext` and `fetchMessages` and dispatches one
`'saivage:focus-chat'` `CustomEvent`; it does not call
`setDrawerOpen` (which no longer exists on the store after
Phase B).

F.3 Run
`grep -n 'setDrawerOpen\|toggleDrawer' web/src/components/cards/CardDetailView.vue`.
Zero hits required.

F.4 Run a workspace-wide grep for the deleted drawer-toggle
constructs to catch any missed call site:
`grep -REn 'setDrawerOpen|toggleDrawer|drawerOpen|drawerWidth|DRAWER_STORAGE_KEY|DEFAULT_DRAWER_WIDTH|analystDrawerOpen|toggle-analyst|analyst-chip|analyst-drawer' web/src > tmp/s05/post-deletion.txt`.
Acceptable hits: zero. If a hit appears, fix the call site in
the same Phase F batch (the file is part of Frontend in
design.md `## Surfaces touched`); if a hit appears in a file
outside design.md's surfaces list, pause and update the design
before continuing.

F.5 Save. Run
`grep -c '<script setup' web/src/components/cards/CardDetailView.vue`
and confirm exactly `1`.

## Phase G — Test rewrite and baseline refresh

G.1 Delete `web/src/__tests__/app-shell-analyst-drawer.test.ts`
(185 lines). The behaviours it asserts (`Ctrl+J` toggle,
route-change drawer-close, drawer-state localStorage persistence)
are no longer part of SPEC-r7; per MASTER-PLAN section 3 rule
(4) the test is removed in-stage rather than ledgered.

G.2 Add `web/src/__tests__/app-shell-persistent-panel.test.ts`.
The file mounts `AppShell` exactly once and asserts:

- on first paint, `wrapper.find('.nav-rail').exists()`,
  `wrapper.find('.workspace-content').exists()`, and
  `wrapper.find('#analyst-chat-panel').exists()` are all `true`;
- `wrapper.find('.analyst-chip').exists()` is `false`;
- `wrapper.find('[aria-controls="analyst-chat-panel"]').exists()`
  is `false`;
- `localStorage.getItem('analyst-chat:drawer-state')` is `null`
  after mount;
- after dispatching
  `new KeyboardEvent('keydown', { key: 'j', ctrlKey: true })`,
  `wrapper.find('#analyst-chat-panel').exists()` is still
  `true` and `localStorage.getItem('analyst-chat:drawer-state')`
  is still `null`;
- after `router.push('/files'); await flushPromises();`,
  `wrapper.find('#analyst-chat-panel').exists()` is still
  `true`;
- the composer (`wrapper.find('textarea[aria-label="Analyst chat composer"]').element`)
  exists on first paint and is not disabled (allowing for the
  read-only-when-no-session case by selecting a session in the
  test setup, mirroring the predecessor file's mock harness).

The mock shape mirrors the deleted
`app-shell-analyst-drawer.test.ts` so the existing
`vi.mock('../api/auth', ...)`,
`vi.mock('../api/client', ...)`,
`vi.mock('../stores/ws', ...)`, and
`vi.mock('../stores/runtime', ...)` blocks carry over verbatim;
the route table also carries over verbatim.

G.3 Edit `web/src/__tests__/operator-dashboard-smoke.test.ts`.
At line 414, delete the
`await wrapper.get('.analyst-chip').trigger('click');` step.
In its place, assert
`expect(wrapper.find('#analyst-chat-panel').exists()).toBe(true);`
without any prior interaction. Save. Run
`grep -nE 'analyst-chip|toggle-analyst|setDrawerOpen|toggleDrawer' web/src/__tests__/operator-dashboard-smoke.test.ts`;
zero hits required. The existing
`listNotifications` / `acknowledgeNotification` `vi.fn` mocks at
`web/src/__tests__/operator-dashboard-smoke.test.ts` lines
324-325 already cover the dashboard's notification client
path, so after this edit the smoke test passes with zero NEW
failing ids and no S05 forecast entry is appended to design.md
`## Expected breakage forecast`.

G.4 Edit `web/src/__tests__/card-detail-view.test.ts`. Update
the test case that mounts CardDetailView so the asserted
`aria-label` text is `"Seed analyst chat with this card"`.
Replace any `setDrawerOpen` spy assertion with a `seedCardContext`
spy assertion. Save. Run
`grep -nE 'setDrawerOpen|toggleDrawer' web/src/__tests__/card-detail-view.test.ts`;
zero hits required.

G.5 Re-record the snapshot file
`web/src/__tests__/__snapshots__/card-detail-view.test.ts.snap`
via
`cd web && npx vitest run --update src/__tests__/card-detail-view.test.ts`
from `saivage-v3/`. The diff against the previous snapshot is
the new `aria-label` string on the `.discuss-btn` element at
the three render points (the three snapshot blocks in the
current file). No other diff is permitted; if vitest reports
additional snapshot updates, pause and inspect the cause
before committing.

G.6 Run `cd web && npm test` from the declared working directory
`/home/salva/g/ml/saivage-v3` (which runs the same vitest command
as the `web-vitest` gate). Confirm the new
`app-shell-persistent-panel.test.ts` passes, the rewritten
`card-detail-view.test.ts` passes, and the rewritten
`operator-dashboard-smoke.test.ts` passes. With the chip-click
step removed by G.3 and the existing `listNotifications` /
`acknowledgeNotification` `vi.fn` mocks already present at
`operator-dashboard-smoke.test.ts` lines 324-325 covering the
dashboard's notification client path, no `web-vitest` failure
is expected from this stage.

G.7 Conditionally refresh the baseline. Open
`SPEC/analyst-as-control-surface/PLAN/baseline-gates.json` and
inspect the `web-vitest` gate's `failing_ids` array for any id
rooted at the deleted `app-shell-analyst-drawer.test.ts` path.
If **no** such id is present (the current baseline does not
list any), **make no edit** to `baseline-gates.json` — leave
the file untouched (no `captured_at` bump, no `comparison_rule`
edit, no `command` edit, no whitespace change). S00 forbids
opportunistic baseline refresh. If a matching id **is**
present, remove only that id from the `failing_ids` array and
leave every other field (including `captured_at`) untouched.
Verify the result with
`jq '.gates[] | select(.id=="web-vitest") | .failing_ids' SPEC/analyst-as-control-surface/PLAN/baseline-gates.json`;
the array must not contain any `app-shell-analyst-drawer.test.ts`
entry after this step.

G.8 Re-run the SFC corruption guard from A.7:
`for f in web/src/components/layout/AppShell.vue web/src/components/layout/WorkspaceHeader.vue web/src/components/chat/AnalystChatPanel.vue web/src/components/cards/CardDetailView.vue; do echo "$(grep -c '<script setup' "$f") $f"; done`.
Each line must show exactly `1 <path>`. Then run
`cd web && npm run build` from the declared working directory
`/home/salva/g/ml/saivage-v3` and confirm the Vite build
succeeds.

## Phase H — Close-out

H.1 Re-run the writer-autonomy grep on this stage's drafts using
both the checked-in anchor list (per S00 cookbook §3) and a
self-contained inline literal pattern. Both must return zero
hits.

Anchor-file form:

```
grep -REn -i -f SPEC/analyst-as-control-surface/PLAN/forbidden-anchors.txt SPEC/analyst-as-control-surface/PLAN/drafts/005-right-panel-and-shell/
```

Inline literal form (kept in this plan so the gate is
self-contained even if `forbidden-anchors.txt` is missing or
diverges):

```
grep -REn -i -E '(spec-r[1-6]|protocol-r[1-3]|master-plan-r[1-6]|review[-]r|prior[ ]round|earlier[ ]round|previous[ ]version|previous[ ]draft|before[ ]the[ ]refactor|was[ ]superseded|older[ ]revision)' SPEC/analyst-as-control-surface/PLAN/drafts/005-right-panel-and-shell/
```

Zero hits required from both invocations. The inline alternation
uses single-character classes (for example `review[-]r`,
`prior[ ]round`) so the literal forbidden anchor strings do not
appear verbatim in this plan; the gate is therefore
self-applicable to its own §H.1 without false positives.

H.2 Re-run the host-path guard:

```
grep -REn '/wo''rk/' SPEC/analyst-as-control-surface/PLAN/drafts/005-right-panel-and-shell/
```

Zero hits required. Every host-relative path in these two files
is rooted at `saivage-v3/...`.

H.3 Re-run the emoji grep:

```
grep -RnP '[\x{1F300}-\x{1FAFF}\x{2600}-\x{27BF}]' SPEC/analyst-as-control-surface/PLAN/drafts/005-right-panel-and-shell/
```

Zero hits required.

H.4 Re-run the toggle / drawer-state grep guard on the post-edit
web tree:

```
grep -REn 'toggleAnalyst|analyst-drawer|openAnalyst|closeAnalyst' web/src
```

and

```
grep -REn 'drawerOpen|setDrawerOpen|toggleDrawer|drawerWidth|DRAWER_STORAGE_KEY|DEFAULT_DRAWER_WIDTH|analystDrawerOpen|toggle-analyst|analyst-chip' web/src
```

Zero hits required from both. The first grep is the literal
guard pinned by MASTER-PLAN §S05 acceptance; the second is the
S05-internal completeness guard for the store-side deletion.

H.5 Conditional S05 close-out skeleton. Re-read
`SPEC/analyst-as-control-surface/PLAN/expected-breakage-ledger.md`.
S05 does not append any new entry to the cumulative ledger
(design.md `## Expected breakage forecast` leaves no NEW
failing id behind, so there is nothing to append). For every
existing H3 block in the ledger: if all three conditions hold,

  (a) its `Target fix stage` line reads `S05` exactly,
  (b) the fresh
      `bash SPEC/analyst-as-control-surface/PLAN/scripts/run-gates.sh
      --diff SPEC/analyst-as-control-surface/PLAN/baseline-gates.json`
      from `saivage-v3/` no longer observes that failing id,
  (c) the block exists at close-out time,

then delete the entire H3 block (the heading plus its four named
lines `Failure mode`, `Reason acceptable now`,
`Target fix stage`, `Recorded by`). Otherwise leave the block
untouched and do not fabricate it. The ledger is empty at S05
start per A.6; if no S05-targeted entry exists, this step is a
no-op. The skeleton is kept in this plan so that any
implementation-time appearance of an S05-targeted entry (e.g.
authored by a predecessor revision that lands between A.6 and
this step) is handled deterministically.

H.6 Re-run the autonomy grep, host-path grep, and emoji grep
(steps H.1, H.2, H.3) after the (no-op) ledger inspection. Zero
hits required on the drafts dir; the ledger file is exempt from
the autonomy regex because it may legitimately reference older
stages by `S0x` shorthand.

H.7 Run the full per-stage gate diff one final time:

```
bash SPEC/analyst-as-control-surface/PLAN/scripts/run-gates.sh
  --diff SPEC/analyst-as-control-surface/PLAN/baseline-gates.json
```

Expected output:

- NEW failures: **zero** new failing ids on every gate. With the
  smoke-test chip click removed by G.3 and no other intentional
  breakage left behind, every gate's `NEW` section under the
  `--diff` output must be empty.
- REPAIRED ids: any incidental improvements (allowed; they
  strictly improve the baseline).
- Exit code: **0**. Per
  `PLAN/scripts/run-gates.sh` lines 71-82, `--diff` sets
  `has_new=1` and exits with that value whenever any gate's
  `NEW` file is non-empty; an exit code of 0 therefore means
  zero NEW failures across all four gates. The S05 acceptance
  closes only if exit code 0 holds. If any NEW id appears at
  this step, the stage does not close: the implementer returns
  to the metaplan owner rather than appending a new forecast.

H.8 Publication. Verify the build location is on the same
filesystem as the publication destination:
`stat -c '%d' SPEC/analyst-as-control-surface/PLAN/drafts SPEC/analyst-as-control-surface/PLAN/stages`
must report the same device number. Then rename
`SPEC/analyst-as-control-surface/PLAN/drafts/005-right-panel-and-shell`
to
`SPEC/analyst-as-control-surface/PLAN/stages/005-right-panel-and-shell`
as one atomic `mv`. Do not edit the published files in place;
per PROTOCOL-r4 the rename is the publication act.

H.9 Final close-out check: run
`grep -RnP '[\x{1F300}-\x{1FAFF}\x{2600}-\x{27BF}]' SPEC/analyst-as-control-surface/PLAN/stages/005-right-panel-and-shell/`
and the autonomy regex from H.1 (both the `-f` and the inline
literal form) against the now-published files; all three
invocations must remain at zero hits.
