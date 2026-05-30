# F04 — Chat / analyst surface style — Implementation plan (r1)

Writer round 1. Binds to the approved design
[02-design-r2.md](02-design-r2.md) and the approved analysis
[01-analysis-r3.md](01-analysis-r3.md). Cross-issue binding:
[F01 design r2 (APPROVED)](../F01-design-tokens/02-design-r2.md),
[F02 design r3 (APPROVED)](../F02-component-hierarchy/02-design-r2.md),
[F03 design r3 (APPROVED)](../F03-conversation-rounds/02-design-r3.md),
[F05 design r3 (APPROVED)](../F05-tool-detail-rendering/02-design-r3.md).

Project guideline (binding): **architecture-first, NO backward
compatibility.** Every change in this plan removes the legacy
markup/CSS it replaces in the same commit; nothing is aliased,
parallel-pathed, or staged behind a flag. There are no
`.tool-chip*` survivors, no `.message-bubble`/`.primary-btn`/
`.composer-input`/`.pending-tool-*`/`.message-badges`/
`.on-screen-section`/`.state-panel` aliases, no chat-local chip
API, and no shims around the F02 primitives or the F03 shared
`<ToolChip>`.

---

## 0. Scope reminder (binding)

**In scope for the F04 PR (this plan):**

- Decompose
  [web/src/components/chat/AnalystChatPanel.vue](../../../web/src/components/chat/AnalystChatPanel.vue)
  into a layout-only container plus six surface-local SFCs under
  `web/src/components/chat/`:
  `ChatHeader.vue`, `MessageList.vue`, `MessageItem.vue`,
  `JumpToLatest.vue`, `ChatComposer.vue`, `UnauthorizedNotice.vue`
  (design r2 §1.1, §1.2–§1.8).
- Introduce two leaf composables:
  `web/src/composables/useDebouncedConnectionState.ts` and
  `web/src/composables/useStickToBottom.ts` (design r2 §1.9).
- Introduce one pure utility:
  `web/src/utils/model-label.ts` (design r2 §1.11).
- Extend [`web/src/api/types.ts`](../../../web/src/api/types.ts):
  add four optional model fields to `ChatMessage`; export
  `PendingToolInvocation` (design r2 §1.1.1, §1.11).
- Switch
  [`web/src/stores/analystChat.ts`](../../../web/src/stores/analystChat.ts)
  to import `PendingToolInvocation` from `../api/types` and delete
  its private declaration (design r2 §1.1.1).
- Apply the narrow-rail layout rules (design r2 §1.12).
- Rewrite / extend the test files enumerated in design r2 §1.13.

**Already landed before F04 (F03 PR; not in this plan):**

- `web/src/components/conversation/ToolChip.vue` (the shared chip),
- `web/src/components/chat/tool-chip-adapter.ts` (eight-prop bag
  per F04 design r2 §1.10, with `callContent` / `resultContent`),
- `web/src/utils/analyst-timeline.ts`
  (`pairAnalystMessages`, `synthesizeCallFromResult`,
  `isSynthesisedCall`),
- The in-place chip swap inside the monolithic
  `AnalystChatPanel.vue` (F03 design r3 §8.2),
- The migration of `analyst-chat-panel.test.ts`'s chip selectors to
  `[data-testid="tool-chip"]` + `data-status`.

F04 inherits a HEAD where `AnalystChatPanel.vue` already imports
`ToolChip`, the adapter, and the timeline utility, and where the
`.tool-chip*` scoped CSS family is already gone. F04 relocates
those call sites into the decomposed components and removes the
remaining bespoke chat-surface CSS.

**Out of scope (binding):**

- Any port of v2's `useWebSocket` / `useAuthState` (analysis r3
  §10, §12).
- Any port of v2's `ChatWindow.vue` (analysis r3 §10).
- Any `ApiTokenEntry` redesign or inline v2-style token input.
- Toaster changes (owned by F01/F02 cleanup).
- `analyst-chat-error-states.test.ts` (file does not exist;
  do not create — analysis r3 §9.5).
- F03 round/timeline structure on the analyst surface
  (analysis r3 §12).
- `requestedModelSpec` UI rendering (analysis r3 §7.3).

---

## 1. Approved-design coverage map

Each numbered subsection of design r2 §1 maps to one or more
implementation batches below. The table is the contract between
this plan and the approved design — every row must be discharged
by the listed batch.

| Design r2 § | Subject | Batch(es) |
| --- | --- | --- |
| §1.1 | File layout under `chat/`, composables, utils | B0, B1, B2, B3 |
| §1.1.1 | Promote `PendingToolInvocation` to `api/types.ts` | B0 |
| §1.2 | `AnalystChatPanel.vue` rewrite (container; local `thinking` derivation; B1 resolution) | B5 |
| §1.3 | `chat/ChatHeader.vue` (P1: no `unauthorized` prop) | B4 |
| §1.4 | `chat/MessageList.vue` (B3 resize-emit invariant) | B4 |
| §1.5 | `chat/MessageItem.vue` (B2 model-pill gating via `modelLabel`) | B4 |
| §1.6 | `chat/JumpToLatest.vue` | B4 |
| §1.7 | `chat/ChatComposer.vue` (resize-to-content, keymap, send) | B4 |
| §1.8 | `chat/UnauthorizedNotice.vue` | B4 |
| §1.9 | `useDebouncedConnectionState` (P2: Readonly-ref param) + `useStickToBottom` | B2 |
| §1.10 | Eight-prop adapter contract (`callContent` / `resultContent`, P3) | inherited from F03 PR; F04 consumes verbatim — verified in B7 |
| §1.11 | `ChatMessage` additive metadata + `model-label.ts` (B2 gate contract) | B0, B3 |
| §1.12 | Narrow-rail layout rules (`min-width: 0`, `--chat-jump-bottom`, jump-pill clamp, composer caps) | B4, B5 |
| §1.13 | Test inventory (rewrites + new files) | B6 |

The reviewer items B1/B2/B3/C1/P1/P2/P3/P4 from design r2 §0 are
all discharged inside design r2 itself; this plan inherits them and
only restates the corresponding implementation actions:

- **B1** (no `thinking` field on the live store) — discharged by
  the local `thinking = computed(() => sending.value ||
  pendingToolInvocationsForActiveSession.value.length > 0)` in B5,
  by the prop on `MessageList` in B4, and by the unit case in B6.
- **B2** (`modelLabel` gates the pill, `shortModelLabel` is text
  only) — discharged by `model-label.ts` in B3, the gate template
  in B4 (`MessageItem.vue`), and the test cases in B6.
- **B3** (`MessageList` emits `resize: 0` synchronously when
  `pendingTools` empties; element watcher cleanup also emits `0`)
  — discharged by the `MessageList.vue` script in B4 and the
  `MessageList.resize.test.ts` cases in B6.
- **C1** (`on-screen-children` keeps the layout class AND adds the
  `data-testid`; raw-source guard rewritten to target the new
  container) — discharged in B4 (`MessageList.vue` template) and
  B6 (`AnalystChatPanel.children.test.ts`).
- **P1** (`ChatHeader` does not accept an `unauthorized` prop) —
  discharged by the `ChatHeader.vue` props in B4 and by the
  container's `v-if="unauthorized"` on the `#state` slot in B5.
- **P2** (`useDebouncedConnectionState` accepts
  `Readonly<Ref<…>>`) — discharged in B2.
- **P3** (adapter ships eight-prop bag with `callContent` /
  `resultContent`) — inherited from F03 PR; F04 consumes via
  `v-bind="…"` only. The B6 adapter cases assert the contract
  exists at the F04 PR's HEAD.
- **P4** (Proposal B template binding; documentation-only) — not
  applicable to the plan; Proposal A is selected (design r2 §3).

---

## 2. Selected approach — Proposal A verbatim

Design r2 §3 selects Proposal A: focused decomposition, no
`useChatSurface` wrapper. The container holds the store wiring
and the derived refs; the leaf composables own one behavior each.

This plan implements Proposal A literally. The container script
in §B5 is the script from design r2 §1.2 verbatim. The child
components in §B4 are the SFCs from design r2 §1.3–§1.8 verbatim.
No deviation, no "improvements", no extra abstractions.

---

## 3. File inventory (final HEAD state after F04 PR)

```
web/src/components/chat/
  AnalystChatPanel.vue       REWRITE  (container; layout + store wiring only; design r2 §1.2)
  ChatHeader.vue             NEW      (design r2 §1.3)
  MessageList.vue            NEW      (design r2 §1.4)
  MessageItem.vue            NEW      (design r2 §1.5)
  JumpToLatest.vue           NEW      (design r2 §1.6)
  ChatComposer.vue           NEW      (design r2 §1.7)
  UnauthorizedNotice.vue     NEW      (design r2 §1.8)
  tool-chip-adapter.ts       INHERIT  (F03 PR; eight-prop bag; design r2 §1.10)

web/src/composables/
  useDebouncedConnectionState.ts   NEW   (design r2 §1.9, Readonly-ref param)
  useStickToBottom.ts              NEW   (design r2 §1.9)

web/src/utils/
  analyst-timeline.ts        INHERIT  (F03 PR; analysis r3 §3.4)
  model-label.ts             NEW      (design r2 §1.11)

web/src/api/types.ts         EDIT     (extend ChatMessage with 4 optional fields;
                                       export PendingToolInvocation; design r2 §1.1.1, §1.11)
web/src/stores/analystChat.ts EDIT    (import PendingToolInvocation from ../api/types;
                                       delete the local copy; design r2 §1.1.1)

web/src/__tests__/                   (per design r2 §1.13 — see §6 below)
```

`AnalystChatPanel.vue` is a REWRITE rather than a NEW file: the
existing file path is preserved (consumers under
[AppShell.vue](../../../web/src/components/layout/AppShell.vue)
and [cards/CardDetailView.vue](../../../web/src/components/cards/CardDetailView.vue#L491)
keep their imports unchanged), but the contents are replaced
wholesale by design r2 §1.2's container script + template. All
hex literals and all four removed scoped class families are gone
in the same commit.

There are **no** auxiliary files (no `chat/index.ts` barrel, no
shared `chat/types.ts`, no `chat/styles.ts`). The chat surface
has six SFCs, two composables, one util, two type/store edits, and
nothing else.

---

## 4. Implementation order (sequenced batches)

The work is broken into eight batches. Each batch is a coherent
commit. The order is the only safe sequence: each batch's HEAD
must type-check and lint clean before the next is started, but the
**PR ships as one unit** — no batch is independently mergeable
because B5 deletes the monolithic SFC body.

### Batch B0 — Type surface (foundation)

Files: `web/src/api/types.ts`,
`web/src/stores/analystChat.ts`.

Steps:

1. In `web/src/api/types.ts`:
   - Add the `PendingToolInvocation` export verbatim from design
     r2 §1.1.1.
   - Extend the existing `ChatMessage` interface with the four
     optional model fields (`provider?`, `model?`, `modelSpec?`,
     `requestedModelSpec?`) per design r2 §1.11.
2. In `web/src/stores/analystChat.ts`:
   - Delete the local `PendingToolInvocation` declaration.
   - Add `import type { PendingToolInvocation } from '../api/types';`.
   - No runtime change: the structural type is identical, and the
     reviewer notes (design r2 §0 B1) that the live store already
     produces this exact shape.

Exit criteria:

- `npm run typecheck` (or equivalent `vue-tsc`) passes against the
  HEAD that still contains the monolithic `AnalystChatPanel.vue`.
- `analyst-chat-store.test.ts` continues to pass with the new
  import path (the existing pending-tool fixtures are structurally
  unchanged — design r2 §1.13).

### Batch B1 — `PendingToolInvocation` consumers (none beyond store)

A grep verification step, not a code change. Before progressing,
confirm that no other file imports the old private
`PendingToolInvocation` from `stores/analystChat`. If any consumer
appears (none expected per analysis r3 §2 and design r2 §1.1.1),
its import is rewritten to `api/types` in this batch.

This batch exists to make the absence of such imports an explicit
checkpoint rather than an unverified assumption.

### Batch B2 — Composables

Files (NEW):

- `web/src/composables/useDebouncedConnectionState.ts`
- `web/src/composables/useStickToBottom.ts`

Steps:

1. Create `useDebouncedConnectionState.ts` per design r2 §1.9.
   - Signature accepts
     `Readonly<Ref<WsConnectionState>> | Ref<WsConnectionState>`
     (P2 fix).
   - `TO_OPEN_IMMEDIATE = ['connected'] as const`,
     `DEBOUNCE_MS = 400`.
   - `onUnmounted(clear)` clears any in-flight timer.
2. Create `useStickToBottom.ts` per design r2 §1.9.
   - `thresholdPx = 60` default; matches v2 (analysis r3 §1.7).
   - `markIncoming()` schedules `el.scrollTop = el.scrollHeight`
     on `nextTick` when stuck; bumps `unseen` otherwise.
   - `jumpToLatest()` is async, resets `unseen = 0` and
     `stuck = true` before the scroll write.

Exit criteria:

- Files exist, are tree-shake-clean (no side effects at module
  load), and pass `vue-tsc`.
- Unit tests in B6 will exercise them; no mounting consumer
  exists yet in this batch.

### Batch B3 — Pure utility

File (NEW): `web/src/utils/model-label.ts`.

Steps:

1. Implement `modelLabel(msg, defaultModelSpec)` and
   `shortModelLabel(msg)` per design r2 §1.11.
   - `modelLabel` returns `null` when the message is not an
     assistant message, when no spec is available, or when the
     spec equals the default AND no `requestedModelSpec` is set.
   - `shortModelLabel` returns the substring after the last `/`,
     or the whole spec when no `/` is present, or `null` for
     non-assistant.
2. Document in the file header that callers MUST gate on
   `modelLabel(...)` first — this is the B2 gate contract.

Exit criteria:

- File compiles in isolation.
- No consumer yet; the import lands in B4 (`MessageItem.vue`).

### Batch B4 — Six chat-surface SFCs (children)

Files (NEW), in implementation order:

1. `web/src/components/chat/UnauthorizedNotice.vue`
   (design r2 §1.8) — smallest, no dependencies on other new
   SFCs; emits `openTokenEntry`.
2. `web/src/components/chat/JumpToLatest.vue`
   (design r2 §1.6) — pure presentational; props `unseen`,
   `bottomOffsetPx`; emits `jump`.
3. `web/src/components/chat/ChatHeader.vue`
   (design r2 §1.3) — props `sessionId`, `connectionState`,
   `sessionsLoading`, `sessionsError` (no `unauthorized` prop —
   P1); composes `PanelHeading`, `Pill`, `StatusDot`, `Card`,
   `Spinner` from F02. Inline `chipIcon` / `chipDotTone` /
   `chipLabel` helpers are module-local.
4. `web/src/components/chat/ChatComposer.vue`
   (design r2 §1.7) — owns the textarea, `resizeInput()`, the
   keydown matrix (Enter sends; Shift/Ctrl/Meta+Enter or
   `isComposing` newlines), the Send button
   (`<Button variant="primary" data-testid="analyst-send">`),
   the read-only tooltip wiring, and the inline `sendError` Card.
   Exposes `focus()` via `defineExpose`. Emits
   `update:draft`, `submit`, `resize`.
5. `web/src/components/chat/MessageItem.vue`
   (design r2 §1.5) — branches on `item.kind`:
   - `'tool_pair'`: `<ToolChip v-bind="adaptChatMessageToToolChip(item.call, item.result, expanded)" @toggle="…" />`.
   - `'message'`: `<MessageBubble>` with `MarkdownText` for
     assistant content and a plain `<span class="message-text">`
     for user/system; the `#meta` slot renders the
     `<Pill data-testid="model-pill">` only when
     `fullLabel = modelLabel(item.message, defaultModelSpec)` is
     non-null (B2 gate contract); the visible text is
     `shortModelLabel(item.message)` and `title` is `fullLabel`.
   - Badges render as `<ul class="message-badges"><li><Pill tone="accent">…</Pill></li></ul>`.
   Owns no `expandedIds` state; the container does.
6. `web/src/components/chat/MessageList.vue`
   (design r2 §1.4) — owns the scroll body, the on-screen-children
   `<section class="on-screen-children" data-testid="on-screen-children">`
   (C1: keeps class **and** adds testid), the state Cards
   (loading / unauthorized / other error / empty), the
   `<MessageItem v-for>` iteration, the `<ThinkingDots
   data-testid="thinking-dots">` footer when `thinking === true`,
   the pending-tool footer
   `<section ref="pendingFooterEl" class="pending-tool-list" data-testid="pending-tool-list">`
   rendering one `<ToolChip>` per pending invocation via
   `adaptPendingInvocationToToolChip(p, expandedIds.has(p.id))`,
   the `useStickToBottom(scrollEl)` integration, and the
   pending-footer `ResizeObserver` wiring with the **B3 invariant**:
   - A `watch(() => props.pendingTools.length === 0, isEmpty => {
       if (isEmpty) emit('resize', 0); }, { immediate: true })`
     emits `0` synchronously whenever the list empties (and on
     mount when already empty).
   - The `pendingFooterEl` element watcher emits `resize: 0` when
     the element transitions to `null` (defence in depth).
   - The single `ResizeObserver` is the only path that emits
     non-zero values; it is created lazily and disconnected on
     `onBeforeUnmount`.
   `defineExpose({ jumpToLatest: stick.jumpToLatest })` so the
   container's `JumpToLatest` proxy works.

Per-file checklist (every SFC):

- No hex literals; all colours flow from F01 tokens (`--bg`,
  `--surface-1`, `--surface-2`, `--border`, `--text`,
  `--text-muted`, `--accent`).
- Every flex/grid container that holds potentially wide content
  declares `min-width: 0` (design r2 §1.12).
- Every interactive element has either an explicit `aria-label`
  or a visible label, or it is a `<button>` with text content.
- All `data-testid` values match design r2 §1.13 verbatim.
- `<script setup lang="ts">` only; no Options API.
- No store imports inside child SFCs except where explicitly
  required by design (none in F04 — only the container reads
  stores).

Exit criteria:

- Each SFC compiles in isolation against the F02 / F03 / F05
  primitives already at HEAD.
- Single `<script setup>` block per file
  (per the workspace Vue-SFC-corruption note —
  `grep -c "<script setup" web/src/components/chat/*.vue` is
  exactly 1 per file).
- No SFC imports another sibling that has not yet been created
  in batch order.

### Batch B5 — Container rewrite (`AnalystChatPanel.vue`)

File (REWRITE): `web/src/components/chat/AnalystChatPanel.vue`.

Steps:

1. Replace the entire SFC body with design r2 §1.2 verbatim.
   - Imports: `ChatHeader`, `MessageList`, `JumpToLatest`,
     `ChatComposer`, `UnauthorizedNotice`,
     `useDebouncedConnectionState`, `pairAnalystMessages` from
     `../../utils/analyst-timeline`, store hooks.
   - `storeToRefs(chat)` destructures only fields that exist on
     the live store (verified inline in §1.2's comment): no
     `thinking`, no `pairedTimeline`, no
     `pendingToolInvocationsForActiveSession`. Those are derived
     locally.
   - Local `thinking = computed(() => sending.value ||
     pendingToolInvocationsForActiveSession.value.length > 0)`
     (B1 resolution).
   - `unauthorized = computed(() => ws.connectionState ===
     'unauthorized' || ws.connectionState === 'no-token' ||
     runtime.unauthorized)`.
   - `debouncedConnectionState` is bound from
     `useDebouncedConnectionState(toRef(ws, 'connectionState'))`.
   - `jumpBottomOffsetPx = composerHeightPx + pendingFooterPx`,
     bound on the panel as
     `:style="{ '--chat-jump-bottom': jumpBottomOffsetPx + 'px' }"`.
   - `saivage:focus-chat` listener installed on `onMounted` and
     removed on `onBeforeUnmount`; forwards to
     `composerRef.value?.focus()`.
   - `submitMessage` calls `chat.sendMessage()` and refocuses the
     composer on `nextTick`.
   - `openTokenEntry` dispatches
     `new CustomEvent('saivage:open-token-entry')` against
     `window` (the existing app-level event used by
     [`ApiTokenEntry.vue`](../../../web/src/components/auth/ApiTokenEntry.vue)).
2. Replace the `<style scoped>` block with the minimal grid:
   `.analyst-chat-panel { position: relative; display: grid;
   grid-template-rows: auto 1fr auto; width: 100%; height: 100%;
   background: var(--surface-1); border-left: 1px solid
   var(--border); overflow: hidden; }`.
3. **Delete in the same commit:**
   - Every hex literal in the prior scoped style block.
   - The four legacy class families
     (`.message-bubble`, `.primary-btn`, `.chat-composer`,
     `.composer-input`, `.pending-tool-*`, `.message-badges`,
     `.on-screen-section`, `.state-panel`).
   - Any residual `.tool-chip*` rules (the bulk are already gone
     from the F03 PR; this step verifies and removes any tail).

Exit criteria:

- The `AnalystChatPanel.vue` file shrinks to roughly the size of
  design r2 §1.2 (container script + minimal grid CSS).
- `grep -nE "(#[0-9a-f]{3,8}|message-bubble|primary-btn|composer-input|pending-tool-|message-badges|state-panel|on-screen-section|tool-chip)" web/src/components/chat/AnalystChatPanel.vue`
  prints nothing.
- `grep -c "<script setup" web/src/components/chat/AnalystChatPanel.vue` is exactly 1.
- The Vue compile succeeds and the container template references
  exactly the five children created in B4.

### Batch B6 — Tests (rewrites + new files)

All paths are relative to `web/src/__tests__/`. Files are
ordered to match design r2 §1.13.

1. `analyst-chat-panel.test.ts` — **rewrite** (existing file):
   - Send-button selector → `[data-testid="analyst-send"]`.
   - Chip selectors → `[data-testid="tool-chip"]`, status via
     `data-status` attribute.
   - Pending chip → `[data-testid="tool-chip"][data-status="pending"]`.
   - Expansion reveals `[data-testid="formatted-content"]` whose
     rendered content matches `callContent`/`resultContent`
     produced by the adapter (P3 contract check).
   - `saivage:focus-chat` dispatch → composer textarea is active
     element (preserved from prior tests).
   - Read-only tooltip: send-button `title` equals
     `'Read-only — switch to analyst to send messages'` when
     `activeSessionWritable === false`.
   - Empty / loading / unauthorized / other-error state assertions
     via text queries against the F02 `<Card>` outputs.
   - Connection chip → `[data-testid="connection-chip"]`
     `data-state` reflects the debounced state.
   - **B2 model-pill gating cases:** one fixture where spec
     equals the default and `requestedModelSpec` is unset → no
     `[data-testid="model-pill"]` in DOM. One fixture where the
     spec differs → pill present, visible text equals the short
     form, `title` equals the full string.
   - **B1 thinking-dots cases:** three fixtures —
     (a) `sending=true`, `pendingTools=[]` → `[data-testid="thinking-dots"]`
     present; (b) `sending=false`, `pendingTools=[…active session…]`
     → present; (c) both empty/false → absent.

2. `analyst-chat-store.test.ts` — **fixtures + assertion edits**:
   - Add `provider?`, `model?`, `modelSpec?`,
     `requestedModelSpec?` to existing chat-message fixtures
     where useful; no test asserts they are required.
   - Pending-tool dedupe assertions: unchanged behavior.
   - New assertion: the `PendingToolInvocation` imported from
     `api/types` is structurally equivalent to the previous
     in-store private type — verified by re-using existing
     fixtures without type errors (compile-time check).

3. `components/AnalystChatPanel.children.test.ts` —
   **rewrite (C1)**:
   - The three existing behavior tests mount the rewritten
     container and locate the on-screen block via
     `wrapper.find('[data-testid="on-screen-children"]')`. The
     legacy `wrapper.find('.on-screen-children li')` selector
     must also continue to work (the class is preserved).
   - `aria-labelledby="on-screen-title"` continues to hold.
   - The raw-source guard test is rewritten to read the new
     container source
     (`web/src/components/chat/AnalystChatPanel.vue`) and assert
     `useCardStore` is still imported from `../../stores/cards`.

4. `jump-to-latest.test.ts` — **NEW**:
   - `bottomOffsetPx === 48` → inline `style.bottom` equals
     `'calc(48px + 8px)'`.
   - `unseen === 0` → label `'Jump to latest'`; `unseen === 3`
     → `'3 new'`; `.unseen` class applied; `aria-label`
     reflects unseen count.
   - Click emits `jump`.
   - The component carries `max-width: calc(100% - 24px)` and
     the `.label` rule includes `text-overflow: ellipsis`
     (asserted via the computed style or via a class-presence
     check, depending on jsdom limits — pick the more robust of
     the two at implementation time).

5. `components/chat/MessageList.resize.test.ts` — **NEW (B3)**:
   - Mounting with `pendingTools: []` emits `resize: 0`
     immediately (from `{ immediate: true }`).
   - Transition `[a, b] → []` emits `resize: 0` synchronously on
     the empty transition.
   - Transition `[] → [a]` does NOT emit a spurious `0`; the
     next `resize` event carries a non-zero footer height once
     the observer fires (use a mocked `ResizeObserver` to drive
     the test deterministically).
   - When the component unmounts mid-pending, `onBeforeUnmount`
     disconnects the observer and the element watcher emits
     `resize: 0` if the element ref transitions to `null` first.

6. `components/chat/tool-chip-adapter.test.ts` — **adds eight-prop
   cases (P3)**:
   - `adaptChatMessageToToolChip(call, result, false)` returns
     `callContent === call.content` and
     `resultContent === result.content`.
   - `adaptChatMessageToToolChip(call, null, false)` returns
     `resultContent === null`.
   - `adaptPendingInvocationToToolChip(pending, false)` returns
     `callContent === JSON.stringify({ tool, summary,
     classifiedAs, relatedCardId, startedAt }, null, 2)` and
     `resultContent === null`.

   The adapter file itself ships in the F03 PR. F04's B6 only
   *asserts* the contract; if the F03 PR's adapter is missing
   `callContent`/`resultContent`, this test fails loudly and the
   F04 PR cannot land (which is the intended HEAD-protection
   property of P3).

7. `composables/useStickToBottom.test.ts` — **NEW**:
   - `stuck` flips false when scroll distance exceeds threshold.
   - `stuck` flips true when within threshold; `unseen` resets to
     0 on the false-to-true transition.
   - `markIncoming` bumps `unseen` only when not stuck; schedules
     a scroll-to-bottom on `nextTick` when stuck.
   - `jumpToLatest` resets `unseen = 0`, sets `stuck = true`, and
     writes `scrollTop = scrollHeight`.

8. `composables/useDebouncedConnectionState.test.ts` — **NEW**:
   - `offline → connected` is immediate (no 400 ms wait).
   - `connected → connecting` takes 400 ms.
   - Re-flap (`connected → offline → connected` within 400 ms)
     emits only the final `connected`.
   - **P2 case:** invoked with `readonly(ref('connected'))`
     produces the same debounced output (asserts the widened
     parameter type at runtime).
   - Use `vi.useFakeTimers()` to drive the 400 ms boundary
     deterministically.

9. `utils/analyst-timeline.test.ts` — **NEW**:
   - `pairAnalystMessages` pairs `tool_call`+`tool_result` by
     `tool_call_id`.
   - Emits `result: null` when only a call exists.
   - Emits an orphan pair (`call = synthesized`, `result = real`,
     `kind === 'tool_pair'`) when only a result exists.

   Note: this file tests a utility introduced by the F03 PR.
   F04 adds the test only if it is not already present at HEAD;
   otherwise F04 extends the existing file with the
   `orphan`/`missing` cases that F04's adapters depend on.

10. `utils/model-label.test.ts` — **NEW (B2 gate contract)**:
    - `modelLabel` returns null for non-assistant messages.
    - `modelLabel` returns null when no spec is available.
    - `modelLabel` returns null when `spec === defaultModelSpec`
      and no `requestedModelSpec`.
    - `modelLabel` returns the full spec when
      `requestedModelSpec` is set, even if
      `spec === defaultModelSpec`.
    - `modelLabel` returns the full spec when
      `spec !== defaultModelSpec`.
    - `shortModelLabel`: returns suffix after last `/`; returns
      the whole spec when no `/` is present; returns null for
      non-assistant.
    - **Gate divergence case:** one fixture where `modelLabel`
      returns null while `shortModelLabel` returns a non-null
      suffix. The test comment documents that callers MUST gate
      on `modelLabel` first.

11. `analyst-toaster.test.ts` — **NOT touched** (F01/F02 own
    toaster cleanup).

12. `analyst-chat-error-states.test.ts` — **NOT created** (file
    does not exist; analysis r3 §9.5).

13. `components/conversation/ToolChip.test.ts` — **NOT duplicated**
    in F04 (F03 PR owns it; design r2 §1.13).

Exit criteria:

- `npm run test -- --run` (or the workspace's equivalent
  vitest invocation) is green.
- No test relies on the legacy `.tool-chip*` or `.primary-btn`
  selectors.

### Batch B7 — Cross-issue contract verification

Pure verification batch (no code edits). Before opening the PR:

1. **Eight-prop adapter contract is present at HEAD** (F03 PR
   landed first):
   - `grep -n "callContent\|resultContent" web/src/components/chat/tool-chip-adapter.ts`
     prints both fields in both adapter functions.
   - If the contract is missing, do not proceed — the F03 PR
     must be amended before F04 can land (design r2 §1.10
     binding).
2. **Shared `ToolChip` is the only chip renderer at HEAD**:
   - `rg -n "class=\"tool-chip" web/src/` prints nothing.
   - `rg -n "tool-chip-(ok|err|pending)" web/src/` prints nothing.
3. **F02 primitives exist at HEAD** (consumed by the new SFCs):
   `ui/Button.vue`, `ui/Pill.vue`, `ui/StatusDot.vue`,
   `ui/PanelHeading.vue`, `ui/Card.vue`, `ui/Spinner.vue`,
   `content/MarkdownText.vue`, `conversation/MessageBubble.vue`,
   `conversation/ThinkingDots.vue`, `conversation/ToolChip.vue`.
4. **F05 `FormattedContent` is the chip's body renderer at HEAD**
   (so the B6 expansion test can assert against
   `[data-testid="formatted-content"]`).
5. **`analyst-timeline.ts` exports `pairAnalystMessages`,
   `synthesizeCallFromResult`, `isSynthesisedCall`** (the
   adapter and the container both depend on the first;
   `adaptChatMessageToToolChip` depends on `isSynthesisedCall`).

If any of these checks fails, the failure is filed back at the
upstream PR (F03 or F02 or F05) — F04 does not patch around it
(architecture-first, no compatibility shims).

---

## 5. Per-batch acceptance commands

| Batch | Commands |
| --- | --- |
| B0 | `npx vue-tsc --noEmit` (or `npm run typecheck`); `npx vitest run analyst-chat-store.test.ts` |
| B1 | `rg -n "from '\\.\\./stores/analystChat'.*PendingToolInvocation" web/src/`; expect no matches (no stray consumers) |
| B2 | `npx vue-tsc --noEmit`; `npx vitest run composables/` (no tests yet — green by absence) |
| B3 | `npx vue-tsc --noEmit`; `npx vitest run utils/` (no tests yet) |
| B4 | `npx vue-tsc --noEmit`; `for f in web/src/components/chat/*.vue; do echo $(grep -c '<script setup' "$f") $f; done` — every line starts with `1`; `rg -n "#[0-9a-fA-F]{3,8}" web/src/components/chat/` prints nothing |
| B5 | as B4 plus `rg -n "(tool-chip\|message-bubble\|primary-btn\|composer-input\|pending-tool-\|message-badges\|state-panel\|on-screen-section)" web/src/components/chat/AnalystChatPanel.vue` prints nothing |
| B6 | `npx vitest run` — full suite green |
| B7 | the five `rg`/`grep` checks in §4 B7 |

---

## 6. Test plan (consolidated)

The test inventory below is the consolidated view from §B6; it is
restated here so the plan can be read top-down without flipping
back to the batch list. **Same files, same cases — no additions
beyond design r2 §1.13.**

| Test file | Status | Owner test cases (high level) |
| --- | --- | --- |
| `analyst-chat-panel.test.ts` | REWRITE | selectors migration; B2 model-pill gating (positive + negative); B1 thinking-dots (3 fixtures); read-only tooltip; connection chip `data-state`; state-panel text queries; `saivage:focus-chat`; P3 expansion-body content check |
| `analyst-chat-store.test.ts` | EDIT | accept additive `ChatMessage` fields in fixtures; `PendingToolInvocation` import path |
| `components/AnalystChatPanel.children.test.ts` | REWRITE | three behavior tests via `[data-testid="on-screen-children"]`; raw-source guard targets new container; legacy `.on-screen-children li` selector continues to work |
| `jump-to-latest.test.ts` | NEW | offset style, label text, unseen class, click → `jump`, aria-label, ellipsis rules |
| `components/chat/MessageList.resize.test.ts` | NEW | B3 invariant: initial `0`, empty-transition `0`, non-empty transition does not emit spurious `0`, element-null watcher emits `0` |
| `components/chat/tool-chip-adapter.test.ts` | EDIT | P3 eight-prop bag: `callContent` / `resultContent` for both adapters (paired, missing-result, pending) |
| `composables/useStickToBottom.test.ts` | NEW | threshold flip, `markIncoming` semantics, `jumpToLatest` semantics |
| `composables/useDebouncedConnectionState.test.ts` | NEW | immediate `→ connected`, 400 ms otherwise, re-flap cancellation, P2 Readonly-ref input |
| `utils/analyst-timeline.test.ts` | NEW or EDIT (F03 may have added the file) | pair by `tool_call_id`, `result: null` when only call, orphan when only result |
| `utils/model-label.test.ts` | NEW | B2 gate contract cases (all six bullets in §B6.10) |
| `analyst-toaster.test.ts` | NOT TOUCHED | — |
| `analyst-chat-error-states.test.ts` | NOT CREATED | — |
| `components/conversation/ToolChip.test.ts` | NOT TOUCHED | owned by F03 PR |

Vitest configuration is unchanged; no new test utilities are
required beyond the existing `@vue/test-utils` mount helpers.
`ResizeObserver` is mocked locally in `MessageList.resize.test.ts`
and `useStickToBottom.test.ts` (jsdom does not provide it).

---

## 7. Validation and rollout

### 7.1 Local validation (before PR open)

Per the workspace's
[`saivage-development-validation`](/home/salva/g/ml/.github/skills/saivage-development-validation/SKILL.md)
skill, in order:

1. `cd /home/salva/g/ml/saivage-v3`.
2. `npm run typecheck` — must be green.
3. `npm run lint` — must be green (no new ESLint disables).
4. `npm run test -- --run` — full vitest suite green.
5. `npm run build` — must succeed (catches Vite SFC parse
   issues that vitest jsdom can miss).
6. Vue-SFC corruption check (workspace-mandated; see user memory
   note `vue-sfc-corruption.md`):

   ```bash
   for f in web/src/components/chat/*.vue; do
     count=$(grep -c "<script setup" "$f" 2>/dev/null || echo 0)
     echo "$count $f"
   done
   ```

   Every line must start with `1`. Re-run after every edit
   round; do **not** run `npm run build` until this passes.

### 7.2 Deployment validation (after PR merge)

Deploy to the `saivage-v3-getrich-v2` container per the
[`saivage-lxc-operations`](/home/salva/g/ml/.github/skills/saivage-lxc-operations/SKILL.md)
skill:

1. `ssh root@10.0.3.170 'systemctl restart saivage-v3-getrich.service'`.
2. `curl -fsS http://10.0.3.170:8080/health`.
3. Open the dashboard in a browser; verify:
   - Analyst chat header shows the session-id slice and the
     debounced connection chip.
   - Sending a message produces thinking dots, then the assistant
     reply; the model pill is visible only when the assistant
     message's spec differs from the session's default.
   - Triggering a tool call shows a pending chip in the pending
     footer; the chip transitions to `data-status="ok"` (or
     `"error"`) once the result arrives.
   - The on-screen-children block renders inside `MessageList`
     when a card is open in the main view.
   - The composer resizes to content; Enter sends; Shift+Enter
     inserts a newline.
   - The `JumpToLatest` pill appears when scrolled away from the
     bottom; clicking it scrolls to the latest and clears unseen.
   - The `UnauthorizedNotice` Card renders when the WS connection
     reports `unauthorized` / `no-token`, and its button opens
     the existing `ApiTokenEntry` modal.

### 7.3 Rollback

The F04 PR is a single commit set (architecture-first guideline);
rollback is `git revert <merge-commit>` plus a redeploy. No data
migrations occur, no on-disk format changes, no API additions are
made beyond the four optional `ChatMessage` fields (which are
wire-additive — older payloads continue to type-check).

---

## 8. Risks and mitigations

| Risk | Likelihood | Impact | Mitigation |
| --- | --- | --- | --- |
| F03 PR did not ship the eight-prop adapter (missing `callContent`/`resultContent`) | low | high (P3 contract broken) | B7 grep gate halts F04 PR until F03 is amended. F04 does not patch around the gap. |
| F03 PR shipped `analyst-timeline.ts` without `synthesizeCallFromResult` / `isSynthesisedCall` | low | medium | B7 grep gate; F04 PR's `MessageItem.vue` template depends on these via the adapter. |
| Vue SFC buffer drift produces a duplicate `<script setup>` block after edits | medium | high (silent build break) | Per-batch acceptance command in §5 includes the `grep -c '<script setup'` check. Workspace memory `vue-sfc-corruption.md` is the operational reference. |
| `ResizeObserver` is unavailable in jsdom and tests use real observers | medium | medium | `MessageList.resize.test.ts` and `useStickToBottom.test.ts` mock `ResizeObserver` at the top of the file. |
| `useStickToBottom` scroll writes race the resize-driven layout shift after a new pending chip appears (`stick` reads stale `scrollHeight`) | medium | low | `markIncoming` schedules the scroll write on `nextTick`, after the DOM update. Existing v2 behavior; analysis r3 §1.7 verified. |
| Container's local `thinking` derivation is wrong: it goes false the instant `sending` flips false but the model is still streaming tokens | low | low | The store's `sending` ref already covers the streaming window (verified during analysis r3 §2.1). If a future store extension separates send-completion from stream-completion, F04's local computed becomes a one-line edit, not a re-architecture. |
| `JumpToLatest` jitters when `composerHeightPx` or `pendingFooterPx` thrash on every keystroke | low | low | `ResizeObserver` fires at frame cadence; design r2 §1.7 rounds the emitted height (`Math.round(h)`), which dampens single-px oscillations. |
| Two `<script setup>` blocks land in a child SFC after a multi-edit round | medium | high | Per-batch grep check; `multi_replace_string_in_file` preferred over chained single-edit calls (per workspace memory `vue-sfc-corruption.md`). |
| `analyst-toaster.test.ts` accidentally breaks because of a shared mount helper change | low | low | F04 does not touch the toaster; if a shared helper is mutated, the change is reverted before the PR opens. |

---

## 9. Exit criteria (PR-merge gates)

The F04 PR is ready to merge when **all** of the following hold:

1. Every batch's acceptance command in §5 has been run and is
   green at the PR's tip commit.
2. `npm run typecheck && npm run lint && npm run test -- --run &&
   npm run build` all green.
3. `rg -n "(#[0-9a-fA-F]{3,8})" web/src/components/chat/`
   prints nothing.
4. `rg -n "(tool-chip|message-bubble|primary-btn|composer-input|
   pending-tool-|message-badges|state-panel|on-screen-section)"
   web/src/components/chat/` prints nothing.
5. The B7 cross-issue verification (§4 B7) succeeds.
6. The
   [`saivage-v3-build-deploy`](/memories/repo/saivage-v3-build-deploy.json)
   commands run cleanly against the `saivage-v3-getrich-v2`
   container, and `curl http://10.0.3.170:8080/health` returns
   200.
7. Manual visual check in §7.2 confirms the seven listed
   behaviours.
8. No regressions in `analyst-chat-panel.test.ts`,
   `analyst-chat-store.test.ts`, or
   `components/AnalystChatPanel.children.test.ts`.

If any gate fails, the PR does not merge — there is no "merge and
fix forward" path for an architecture-first change.

---

## 10. Cross-issue ordering (binding restatement)

Per analysis r3 §11 and design r2 §4:

```
F01 r2 (tokens, base, patterns)
   └─► F02 r2 (ui/, content/, conversation/ primitives)
          └─► F05 r2 (ToolPresentationView, FormattedContent, JsonView)
                 └─► F03 r3 (rounds, timeline, ToolChip, adapter, analyst-timeline,
                              AnalystChatPanel in-place chip swap)
                        └─► F04 (THIS PLAN — decomposition, composables,
                                 model-label, layout rules, tests)
```

F04 does not start until the F03 PR is merged. The F03 PR's
`AnalystChatPanel.vue` chip-swap leaves the SFC monolithic but
with shared-chip markup; F04's B5 then decomposes the SFC into
the six children defined here. There is no intermediate HEAD
where two chip renderers coexist.
