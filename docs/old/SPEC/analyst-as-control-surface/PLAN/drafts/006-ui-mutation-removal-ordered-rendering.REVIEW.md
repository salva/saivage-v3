# S06 Fourth-Pass Review

Verdict: APPROVED

Finding counts: HIGH 0, MEDIUM 0, LOW 0.

Single most important issue: none.

## Targeted re-checks

### R-HIGH-1 - Option B consistency

PASS.

Required negative-form grep:

`grep -nE 'does not add|does not edit Dashboard|does not edit Files|does not edit Debug|second copy|do not exist in current source' design.md`

Result: zero hits.

Manual line-range re-read:

- `design.md` lines 297-318: upstream dependency language is consistent with S06 adding only the shared getter/type support and the three S06-owned ordered-rendering surfaces.
- `design.md` lines 326-340: Dashboard, Files, and Debug are stated as the three missing surfaces S06 adds.
- `design.md` lines 448-471: ordered-child rendering is scoped to the three S06-owned surfaces; other child-rendering surfaces stay with their owning stage.
- `design.md` lines 573-612: `CardRecord.position`, backend persistence, and `childrenOf` are described as shared support for the three surfaces.
- `design.md` lines 660-673: carry-over forecast close-out is scoped to the three S06-owned ordered-child surfaces, and other child-rendering surfaces are left untouched.

No inconsistent Option B statement was found.

### R-HIGH-2 - Data sources

PASS.

- DashboardView: F.16(c) uses `displayedGoalId = computed<string | null>(() => cardsStore.currentCard?.id ?? null)`. G.5(a) seeds `cardsStore.currentCard = goalARecord` before mount. `web/src/stores/cards.ts` declares `const currentCard = ref<CardRecord | null>(null)` and returns `currentCard` from the setup store, so Pinia exposes a writable store property for the test seed.
- FilesView: F.17(c) uses `activeCardId = computed<string | null>(() => cardsStore.currentCard?.id ?? null)`. G.5(b) seeds the same writable `currentCard` surface before mount.
- DebugView: F.18 joins the debug-card list to `cardsStore.childrenOf(card.id)`. Current `DebugView.vue` destructures the store ref and iterates `v-for="card in debugCards"`; the plan prose says `debugStore.debugCards`, but the source of truth is still the debug store. G.5(c) correctly mocks `getDebugState`, calls `debugStore.fetchState()`, and then mounts the view.
- `web/src/stores/debug.ts` lines 318-330: `fetchState()` assigns `response.cards` into `debugCards.value`.
- `web/src/stores/debug.ts` line 748: the store returns `debugCards: readonly(debugCards)`, so test seeding through `fetchState()` is the correct path.

The DebugView alias difference is not a functional blocker because the component's `debugCards` template ref is populated from the same readonly store field after `fetchState()`.

### R-HIGH-3 - `position` field

PASS.

- `web/src/api/types.ts` has `CardRecord` at lines 46-79 in current source. The current interface does not yet declare `position`, so B.6 has a real insertion point and explicitly adds `position?: number` immediately after `parent: string | null`.
- Backend model validation already requires `position`: `src/schemas/types.ts` declares `position: number` on backend `CardRecord`, and `src/schemas/validators.ts` validates `position` as a nonnegative integer.
- Backend state already consumes persisted positions: `saivage-v3/src/cards/state.ts` line 126 compares `card.position`, line 192 sorts child edges by `position` with id tie-break, and lines 483-496 enforce root position `0` plus per-parent contiguous child positions.

The frontend optional field extension is consistent with the backend model and with legacy fixture tolerance.

### R-MEDIUM-1 - H.10 removed and H.9 folded audit

PASS.

Required grep:

`grep -nE '^H\.10 ' plan.md`

Result: zero hits.

H.9 now contains publication and audit content: same-filesystem confirmation, atomic `mv`, post-move `ls`, pre/post `sha256sum` comparison, and an explicit note that the cumulative ledger is not amended at stage close.

## Mechanical re-runs

- Autonomy literal grep: zero hits for `SPEC-r[1-6]`, `PROTOCOL-r[1-3]`, `MASTER-PLAN-r[1-6]`, `REVIEW-r`, and the requested prior-version phrases.
- Emoji-only grep with `rg -nP '[\x{1F300}-\x{1FAFF}]' design.md plan.md`: zero hits.
- Broader emoji/fence scan with `rg -nP '[\x{1F300}-\x{1FAFF}]|```.*```|^```' design.md plan.md`: no emoji hits; code-fence hits remain at `design.md` lines 382 and 394 and `plan.md` lines 677, 679, 684, and 686 because those files contain command/code blocks.
- Host-path grep `grep -R -n '/work/' design.md plan.md`: zero hits.
- Top-level substep count `grep -cE '^[A-Z]\.[0-9]+ ' plan.md`: 74.
- Nested substep count `grep -cE '^[A-Z]\.[0-9]+\.[0-9]+ ' plan.md`: 7.

## Carry-over checks

- HIGH 2, `isStale` getter: PASS. Phase C.5 adds the getter, C.6 adds the unit-test truth table, and F.13 rewires `StaleWarningRibbon.vue` to `cardsStore.isStale(currentCard.value.id)`.
- HIGH 3, live-probe fixture: PASS. G.6/G.7/H.7 use `saivage-v3/tmp/check-mutation-traffic-fixture/`, seed fake fixture state only, point the dev server at that fixture root, and clean it up on exit.
- MEDIUM 4, no ledger mutation on no-op: PASS. H.4 states no-op paths make zero cumulative-ledger edits and write evidence only to stage-local `implementation-notes.md`.
- MEDIUM 5, `NotificationsPanel` equals DebugView: PASS. F.4 explicitly says DashboardView has no `NotificationsPanel` edit. F.7 removes the DebugView mount/import, and F.12 deletes the component after confirming DebugView is the only importer.
- Downstream impact forecasts target S07: PASS. Plan H.6's strict-append forecast shape uses `Target fix stage: S07`; no `Target fix stage: S10` entry was found. `design.md` still contains non-forecast S10 playwright-reconciliation ownership notes, which I did not count as downstream impact forecast entries.

## File spot checks

- `web/src/views/DashboardView.vue`: PASS. Current source still has the mutation controls that F.4/F.5 remove; no `NotificationsPanel` import or mount was found. The F.16 data source is planned against the writable cards-store `currentCard` ref.
- `web/src/views/FilesView.vue`: PASS. Current source uses `useRoute()` only for file browsing; no card-bound route param exists in the checked section, so F.17's store-driven `activeCardId` source is appropriate.
- `web/src/views/DebugView.vue`: PASS with alias note. Current source mounts `<NotificationsPanel />` and imports it from `../components/cards/NotificationsPanel.vue`, matching F.7/F.12. The current card list template iterates the `storeToRefs` alias `debugCards`, not the literal expression `debugStore.debugCards`, but the underlying source is the same debug-store field populated by `fetchState()`.
- `web/src/stores/cards.ts`: PASS. `currentCard` is declared as `ref<CardRecord | null>(null)` and returned from the setup store, making `cardsStore.currentCard = ...` a writable Pinia test-seeding path.
- `web/src/stores/debug.ts`: PASS. `fetchState()` assigns `response.cards` to `debugCards.value`, and the returned store exposes `debugCards: readonly(debugCards)`.
- `web/src/api/types.ts`: PASS. `CardRecord` is located at the expected interface region and is the correct place for B.6's optional `position?: number` insertion.
- `saivage-v3/src/cards/state.ts`: PASS. Position participates in reorder detection, child-edge sorting, and persisted-state invariants exactly where the draft references it.
