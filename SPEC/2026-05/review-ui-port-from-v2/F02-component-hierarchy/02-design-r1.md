# F02 — Component hierarchy / UI primitive layer — Design (r1)

Writer round 1 of the design phase. Implements the approved analysis
[01-analysis-r2.md](01-analysis-r2.md) (ANALYSIS-APPROVED) and consumes
the F01 r2 / F03 r2 / F04 r3 / F05 r2 approved analyses
([F01](../F01-design-tokens/01-analysis-r2.md),
[F03](../F03-conversation-rounds/01-analysis-r2.md),
[F04](../F04-chat-surface-style/01-analysis-r3.md),
[F05](../F05-tool-detail-rendering/01-analysis-r2.md)).

**Project guideline (binding, repeated for emphasis):** architecture-first,
no backward compatibility. Every bespoke v3 selector enumerated in
analysis §4 is **deleted in the same commit** that introduces its
replacement primitive. No `@deprecated` re-exports, no `.legacy-*`
holdovers, no alias period, no `index.ts` barrels under `ui/` /
`content/` / `conversation/` (analysis §10).

This design proposes two alternatives:

- **Proposal A — Three-layer split (`components/ui/`, `components/content/`,
  `components/conversation/`)**, exactly the structure approved in
  analysis r2.
- **Proposal B — Feature-slice with role-based co-location
  (`features/{conversation,chat,cards,...}` plus a single
  `components/lib/` flat folder)**, evaluated seriously as the
  "one-level-up" alternative.

[§9 Recommendation](#9-recommendation) selects **Proposal A**.

---

## 0. Inputs consumed from sibling analyses

Cross-issue contracts F02 must satisfy:

| Source                                                                                   | Contract F02 owns                                                                  |
| ---------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| [F01 r2 §3.2](../F01-design-tokens/01-analysis-r2.md#32-semantic-layer-semanticcss--zero-hex-literals) | Semantic tokens (`--accent`, `--warn`, `--danger`, `--purple`, `--entry-*-{bg,border}`, `--btn-primary-*`) consumed only via pattern classes. F02 introduces zero new tokens; the pattern extensions listed below land in F01 r2's `patterns.css`. |
| F01 r2 patterns.css                                                                       | Extensions listed in analysis §2.2 (`.status-dot-{ok,warn,danger,accent,muted}`, `.card-{warn,danger,accent,user,purple}`, `.pill-purple`, and the conditional `.tablist > .pill[aria-pressed="true"]`). |
| [F03 r2 §3.1](../F03-conversation-rounds/01-analysis-r2.md#31-folder-layout-binding-to-f02-r2) | `web/src/components/conversation/` folder shape, ownership map of `RoundCard` / `DiagnosticRow` / `PendingCallFooter` / `CompactedCluster` / `ContextBlock` (F03 fills bodies; F02 owns the directory + `MessageBubble` + `ThinkingDots` + `ToolChip` API). |
| [F03 r2 §7.2](../F03-conversation-rounds/01-analysis-r2.md#72-pair-composition-view-level-only) | `ToolChip` prop signature (`view: ToolPresentationView`, `status: 'call'\|'ok'\|'error'\|'pending'`, `expanded: boolean`, emits `toggle`). |
| [F04 r3 §3.3 / §4.0](../F04-chat-surface-style/01-analysis-r3.md#33-chatmessageitemvue) | `MessageBubble` and `ToolChip` are imported by `chat/MessageItem.vue` exactly as F02 ships them — no chat-local copies. |
| [F05 r2 §2 / §3](../F05-tool-detail-rendering/01-analysis-r2.md#2-presenter-contract-independent-no-hidden-pair-state) | `ToolPresentationView` (the `InlinePart[]` view-model) is what `ToolChip` receives. F02 imports it from `utils/tool-presenters.ts`; F02 does not redefine it. |

Discriminator from analysis §1.3 (binding): any file importing Pinia,
Vue Router, fetch client, or the WebSocket client cannot live in
`ui/`, `content/`, or `conversation/`. It lives in its surface folder.

---

## 1. Proposal A — Three-layer split (`ui/`, `content/`, `conversation/`)

This is the **focused fix** implementing analysis r2 exactly. The
primitive layer is structurally identical to the analysis; this
section pins exact APIs, the deletion matrix, test relocation, and
commit-order, all of which were left to the design phase.

### 1.1 File layout (final)

```
web/src/
  components/
    ui/                       (F02-owned; 7 SFCs)
      Button.vue
      Pill.vue
      Card.vue
      PanelHeading.vue
      StatusDot.vue
      Overlay.vue
      Spinner.vue
    content/                  (F02-owned; 4 SFCs)
      CodeBlock.vue           ← moved from components/code/CodeBlock.vue
      MarkdownText.vue        ← moved from components/code/MarkdownText.vue
      JsonView.vue            ← new, ported from saivage/web/src/components/JsonHighlight.vue
      FormattedContent.vue    ← new, ported from saivage/web/src/components/FormattedContent.vue
    conversation/             (F02 API, F03 fills round bodies; 7 SFCs)
      MessageBubble.vue
      ToolChip.vue
      ThinkingDots.vue
      RoundCard.vue           ← F03
      DiagnosticRow.vue       ← F03
      PendingCallFooter.vue   ← F03
      CompactedCluster.vue    ← F03
      ContextBlock.vue        ← F03 (not in analysis §1 but bound by F03 r2 §3.1)
    agents/                   (unchanged surface folder)
    auth/                     (unchanged surface folder)
    cards/                    (unchanged surface folder)
    chat/                     (F04 expands to ChatHeader / MessageItem / MessageList / JumpToLatest / ChatComposer)
    layout/                   (unchanged surface folder)
    nav/                      (unchanged surface folder)
    code/                     ← DELETED in the CodeBlock relocation commit (no re-export shim)
```

No `index.ts` barrel under any of the three new folders (analysis
§10): each consumer writes an explicit import path, which keeps
tree-shaking trivial and avoids the implicit cycle risk that barrels
introduce in Vite SFC graphs.

### 1.2 Composition rules (enforced by code review + ESLint `no-restricted-imports`)

| Layer            | May import from                          | Forbidden imports                                                                                  |
| ---------------- | ---------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `ui/*`           | (nothing in this repo)                   | other `ui/*`, `content/*`, `conversation/*`, any `stores/*`, `vue-router`, `utils/api-client`, `lucide-vue-next`. |
| `content/*`      | `ui/*`, `utils/*`, `lucide-vue-next`     | `stores/*`, `vue-router`, `utils/api-client`, other `content/*`, `conversation/*`.                 |
| `conversation/*` | `ui/*`, `content/*`, `utils/*`, `lucide-vue-next`, F03's `utils/agent-timeline/*` | `stores/*`, `vue-router`, `utils/api-client`. Composition emits events; callers wire stores.       |
| Surface folders (`agents/*`, `chat/*`, `cards/*`, `layout/*`, `nav/*`, `auth/*`, `views/*`) | anything | redefining pattern classes (`.btn`, `.pill`, `.card`, `.entry-*`) in their `<style scoped>` is forbidden. |

ESLint rule (added in this batch, lives in
[`web/.eslintrc.cjs`](../../../web/.eslintrc.cjs) or equivalent):

```js
{
  files: ['web/src/components/ui/**/*.vue'],
  rules: {
    'no-restricted-imports': ['error', {
      patterns: [
        { group: ['*/stores/*', 'pinia'], message: 'ui/ primitives must not import stores' },
        { group: ['vue-router'],         message: 'ui/ primitives must not import the router' },
        { group: ['*/components/ui/*', '*/components/content/*', '*/components/conversation/*'],
          message: 'ui/ primitives must not import other primitives' },
        { group: ['lucide-vue-next'],    message: 'ui/ primitives receive icons through slots' },
      ],
    }],
  },
}
```

Equivalent blocks restrict `content/` and `conversation/`.

### 1.3 New primitives — exact prop signatures (verbatim)

Each file ships with `<script setup lang="ts">` plus a strict
`defineProps<{…}>()` generic. No `withDefaults` for required props.
No optional emit names. No PropTypes runtime layer.

#### 1.3.1 `ui/Button.vue`

```ts
defineProps<{
  variant?: 'default' | 'primary' | 'danger';
  type?: 'button' | 'submit' | 'reset';
  disabled?: boolean;
  iconOnly?: boolean;
  title?: string;
  ariaLabel?: string;
  ariaPressed?: boolean;
  ariaExpanded?: boolean;
  ariaControls?: string;
}>();
defineEmits<{ (e: 'click', event: MouseEvent): void }>();
```

Template emits `.btn` plus optional `.btn-primary` / `.btn-danger`
(F01 r1 patterns), plus the scoped `.btn-icon` layout class. The
ARIA props pass through as attributes only when defined. No `size`
prop (analysis §3.1).

#### 1.3.2 `ui/Pill.vue`

```ts
defineProps<{
  tone?: 'default' | 'accent' | 'warn' | 'danger' | 'purple';
  as?: 'span' | 'button';
  type?: 'button' | 'submit';
  disabled?: boolean;
  title?: string;
  ariaLabel?: string;
  ariaPressed?: boolean;
  ariaExpanded?: boolean;
  ariaControls?: string;
}>();
defineEmits<{ (e: 'click', event: MouseEvent): void }>();
```

Renders `.pill` + one of `.pill-accent | .pill-warn | .pill-danger |
.pill-purple` (purple is the F01 r2 extension). When `as === 'button'`
the root becomes a `<button>` with the relevant ARIA pass-through.
No `active` prop (analysis §3.2): "selected" affordance is expressed
by `ariaPressed` + the conditional `.tablist > .pill[aria-pressed="true"]`
pattern rule.

#### 1.3.3 `ui/Card.vue`

```ts
defineProps<{
  active?: boolean;
  tone?: 'default' | 'user' | 'accent' | 'warn' | 'danger' | 'purple';
  as?: 'div' | 'section' | 'article' | 'li' | 'aside';
  role?: string;
  ariaLabel?: string;
  ariaLabelledby?: string;
}>();
```

Renders the configured element with `.card` + (`.card-active`
when `active`) + tone modifier from analysis §2.2. `aside` is added
to the `as` union because `chat/MessageItem.vue`'s F04 r3 §3.3 renders
the assistant footer as `<aside>` semantics.

#### 1.3.4 `ui/PanelHeading.vue`

```ts
defineProps<{
  level?: 2 | 3;
  as?: 'header' | 'div';
}>();
```

Three slots, all optional: `title` (renamed slot, also default-slot
compatible), `meta`, `actions`. Renders `.panel-heading` (F01 r1) +
internal scoped grid (`auto 1fr auto`).

#### 1.3.5 `ui/StatusDot.vue`

```ts
defineProps<{
  tone: 'ok' | 'warn' | 'danger' | 'accent' | 'muted';
  ariaLabel?: string;
  title?: string;
}>();
```

Renders `<span class="status-dot status-dot-{tone}">`. Default
`aria-hidden="true"`; when `ariaLabel` is supplied, role flips to
`img` (analysis §3.5).

#### 1.3.6 `ui/Overlay.vue`

```ts
defineProps<{
  open: boolean;
  closeOnBackdrop?: boolean;     // default true
  ariaLabel: string;             // required
  initialFocus?: 'first' | 'container';  // default 'first'
  restoreFocus?: boolean;        // default true
}>();
defineEmits<{ (e: 'close'): void }>();
```

Owns the focus-trap, Escape handling, `data-modal-open` flag, and
`inert`-sibling bookkeeping per analysis §9.

#### 1.3.7 `ui/Spinner.vue`

```ts
defineProps<{
  size?: 'sm' | 'md' | 'lg';
  ariaLabel?: string;
}>();
```

Renders a `Loader2` glyph from `lucide-vue-next` … wait — `ui/`
forbids `lucide-vue-next` per §1.2. Resolution: `Spinner` is the
**single allowed exception**, documented in the ESLint comment. The
icon is conceptually intrinsic to a Spinner; pushing it to a slot
would make every caller import the icon for a one-line component.
Alternative considered: render a CSS-only spinner (`border` +
`@keyframes spin`). Rejected: the v2 `.spin` keyframe is already
defined and `Loader2` matches the visual idiom of every other use
of `lucide-vue-next` in the app.

(If the reviewer pushes back, fallback is to make `Spinner` a CSS-
only `<span>` with no glyph dep; either is one-line change.)

#### 1.3.8 `content/CodeBlock.vue` (relocated)

The existing
[web/src/components/code/CodeBlock.vue](../../../web/src/components/code/CodeBlock.vue)
moves to `web/src/components/content/CodeBlock.vue`. Its current
public surface is preserved verbatim. The known props (read from
the live source):

```ts
defineProps<{
  code: string;
  language?: string;
  filename?: string;
  copyable?: boolean;            // default true
  maxBytes?: number;             // default 65536; oversize notice fires above
  showCopy?: boolean;            // default true
  ariaLabel?: string;
}>();
defineEmits<{ (e: 'oversize'): void }>();
```

Internal scoped layout retained. Replaces the bespoke copy `<button>`
with `<Button icon-only aria-label="Copy" @click="copy">`.

#### 1.3.9 `content/MarkdownText.vue` (relocated)

Moves from `code/` to `content/` with no API change:

```ts
defineProps<{
  text: string;
  inline?: boolean;
}>();
```

`MarkdownText` may import `CodeBlock` (both in `content/`, which is
permitted by §1.2).

#### 1.3.10 `content/JsonView.vue` (new, ported from v2 `JsonHighlight.vue`)

```ts
defineProps<{
  json: string | unknown;        // string passes through tokenizeJson; object is JSON.stringify'd first
  maxDepth?: number;             // default 6
  collapsed?: boolean;           // initial fold state for nested objects/arrays
  ariaLabel?: string;
}>();
```

Internally uses the F05-extracted `tokenizeJson` utility (F05 r2
§8). The renderer emits `.syn-*` pattern classes (F01 r1). No
pattern-class extensions.

#### 1.3.11 `content/FormattedContent.vue` (new, ported from v2)

```ts
import type { InlinePart } from '../../utils/tool-presenters';
defineProps<{
  parts: InlinePart[];
}>();
defineEmits<{
  (e: 'navigateFile', payload: { path: string; root: 'meta' | 'output' }): void;
  (e: 'navigateUrl', url: string): void;
}>();
```

Renders the F05 `InlinePart[]` discriminated union into inline
`<span class="text-*">` / `<a class="msg-link">` /
`<code class="code-inline">` elements. The two emits keep this SFC
free of router/store imports (composition §1.2). Callers wire the
emits to `useRouter`/`fileStore` themselves.

#### 1.3.12 `conversation/MessageBubble.vue`

```ts
defineProps<{
  role: 'user' | 'assistant' | 'system';
  kind?: 'reasoning' | 'activity' | 'plain';
  timestamp?: string;
  modelLabel?: string;
}>();
```

Renders `<article class="card card-{tone}">` with three rows
(meta / content / badges) as scoped flex layout. Slots: `default`
(content), `meta`, `badges`. Role → tone table from analysis §3.8.

#### 1.3.13 `conversation/ToolChip.vue`

```ts
import type { ToolPresentationView } from '../../utils/tool-presenters';

defineProps<{
  view: ToolPresentationView;
  status: 'call' | 'ok' | 'error' | 'pending';
  expanded: boolean;
  detailsId?: string;
  timestamp?: string;
}>();
defineEmits<{
  (e: 'toggle'): void;
  (e: 'navigateFile', payload: { path: string; root: 'meta' | 'output' }): void;
  (e: 'navigateUrl', url: string): void;
}>();
```

The `navigate*` emits propagate `FormattedContent`'s emits because
`ToolChip` renders `FormattedContent` for the headline/detail inline
parts. Status → Card tone mapping is F03 r2 §7.2 verbatim (`call`
→ `default`/`accent`; `ok` → `accent`; `error` → `danger`; `pending`
→ `warn`). The chip renders the `<button>` toggle as `<Button>`,
preserving the F05 r2 §6 "no nested interactives" rule by keeping
the toggle as the only interactive element inside the chip root —
inline `<a>` links are rendered by `FormattedContent` as siblings
of the toggle, NOT inside it.

#### 1.3.14 `conversation/ThinkingDots.vue`

```ts
defineProps<{ ariaLabel?: string }>();
```

Three `<span>` children riding `.pulse` (F01 r1). Layout-only scoped
style. No pattern-class extensions (analysis §2.3).

#### 1.3.15 F03-owned composites (API placeholders only)

`RoundCard.vue`, `DiagnosticRow.vue`, `PendingCallFooter.vue`,
`CompactedCluster.vue`, `ContextBlock.vue` ship in the F03 batch.
F02 owns only the directory and the composition rules. Their prop
signatures live in
[F03 r2 §3.4](../F03-conversation-rounds/01-analysis-r2.md#34-component-sketch).
F02 sanity-checks them (must obey §1.2): no store, router, or fetch
imports. All five satisfy this in F03's analysis.

### 1.4 Deletion matrix (commit-bound)

The exhaustive deletion matrix lives in
[analysis r2 §4.1–4.13](01-analysis-r2.md#4-deletion--migration-matrix).
This design adds commit-level grouping: which deletions land in
which commit, so the "no alias period" guarantee holds.

| Commit | New primitive(s) introduced | Selector blocks deleted in same commit (file paths) |
| ------ | -------------------------- | --------------------------------------------------- |
| C1     | `ui/Button.vue`            | `.btn`-redefining scoped blocks: none in v3 (v3 has no `.btn` class today). C1 is additive; deletions start at C2. |
| C2     | `ui/Pill.vue`, `ui/StatusDot.vue`, `ui/Card.vue`, `ui/PanelHeading.vue`, `ui/Spinner.vue`, `ui/Overlay.vue` + the F01 r2 extension patterns | none yet (still additive); F01 extensions land here |
| C3     | `content/CodeBlock.vue` + `content/MarkdownText.vue` (moves) + delete `web/src/components/code/` | `code/CodeBlock.vue` and `code/MarkdownText.vue` files removed; consumer imports updated atomically. No alias. |
| C4     | `content/JsonView.vue`, `content/FormattedContent.vue` | n/a (new files) |
| C5     | `conversation/MessageBubble.vue`, `conversation/ToolChip.vue`, `conversation/ThinkingDots.vue` | n/a (new files); `tool-presenters.ts` migrates to F05 contract in the same commit (coordinated with F05 batch) |
| C6     | `auth/ApiTokenEntry.vue` rewritten on `Overlay` + `Button` | analysis §4.2 — `.token-overlay`, `.token-dialog`, `.token-btn*`, `.token-toggle`, `nav/NavRail.vue`'s `.api-token-btn` |
| C7     | `layout/AppShell.vue` (auth banner) + `layout/WorkspaceHeader.vue` | analysis §4.1, §4.3 — `.auth-required-banner`, `.auth-banner-*`, `.ws-chip`, `.runtime-chip`, `.pause-chip`, `.chip-dot` |
| C8     | `views/DashboardView.vue` rewrite | analysis §4.5 — `.refresh-btn`, `.runtime-banner.banner-*`, `.error-banner`, `.actionable-error`, `.status-loading`, `.cue-chip`, `.detail-callout`, `.dc-*`, `.csb-*`. Pure-layout `.status-section`, `.status-grid`, `.section-label`, `.csb-*` survive but lose all colour/border |
| C9     | `views/FilesView.vue` rewrite | analysis §4.6 — `.files-global-banner.banner-*`, `.viewer-state`, `.viewer-close-btn`, `.sv-fetch-btn`. Layout-only `.file-panel`, `.file-list`, `.file-entry`, `.crumb*`, `.file-viewer` survive |
| C10    | `views/DebugView.vue` rewrite | analysis §4.7 — every `.debug-*`, `.dg-item`, `.mcp-*`, `.sv-*`, `.doctor-*`, `.check-*`, `.operator-banner-*` listed there |
| C11    | `components/agents/AgentConversationView.vue` rewrite (F03 lands the round bodies; F02 lands the toolbar/state-panel migration here) | analysis §4.8 — `.conv-tb-btn`, `.conv-toolbar`, `.conv-header`, `.conv-model`, `.conv-role`, `.conv-info`, `.conv-status-badge.*`, `.conv-empty`, `.conv-loading`, `.conv-error`, `.conv-warning`. The `.tc-*`/`.tr-*` families and `.conv-step`/`.conv-message` are deleted in the F03 batch (coordinated; see §1.6 below). |
| C12    | `components/agents/RawLlmExchangePanel.vue` rewrite | analysis §4.9 — `.rlp-*` |
| C13    | `components/chat/AnalystChatPanel.vue` rewrite (F04 owns the broader chat decomposition; F02 lands the primitive migration of the surviving panel scope) | analysis §4.10 — `.primary-btn`, `.tool-chip*`, `.message-bubble`, `.msg.role-*`, `.msg-meta`, `.msg-content`, `.pending-tool-*`. Layout-only `.chat-body`, `.chat-composer`, `.composer-footer`, `.composer-input` survive. `AnalystToaster.vue`'s `.toast` becomes `<Card>` per toast (no `.toast` selector remains). |
| C14    | `components/cards/*.vue` rewrites (in this order: `StaleWarningRibbon`, `CardHistoryPanel`, `CardDetailView`, `CardsBoardView`, `CardsLeaderboardView`, `CardsTreeView`, `CardsTimelineView`) | analysis §4.11 — `.nav-pill`, `.retry-btn`, `.discuss-btn`, `.detail-status-chip`, `.detail-type-badge`, `.badge.warning`, `.badge.error`, `.child-row`, `.board-card`, `.column-header`, `.column-title`, `.column-dot`, `.column-count`, `.col-*` (leaderboard non-layout), `.filter-chip`, `.analyst-badge`, stale ribbon. Pure-layout `.board-columns`, `.board-container`, `.column-cards`, `.card-detail-container`, `.cards-toolbar`, `.card-children-*` survive. |
| C15    | `components/nav/NavRail.vue` rewrite | analysis §4.4 — `.nav-rail-link.active`'s colour rule rewritten to consume `--accent`; `.nav-rail` layout survives; `.api-token-btn` already removed in C6. |

The 15-commit sequence is the **landing order**. Each commit is the
atomic boundary: it adds the new primitive(s) if any, deletes the
bespoke selectors and their `<style scoped>` blocks for the
surface(s) it touches, and rewrites tests for the same surfaces in
the same commit (so CI stays green commit-by-commit). No commit
leaves dangling selectors.

### 1.5 Test reorganisation

Two test trees:

```
web/src/__tests__/
  ui/
    Button.test.ts
    Pill.test.ts
    Card.test.ts
    PanelHeading.test.ts
    StatusDot.test.ts
    Spinner.test.ts
    Overlay.test.ts
  content/
    CodeBlock.test.ts          ← moved from web/src/__tests__/code-block.test.ts
    MarkdownText.test.ts       ← moved from web/src/__tests__/markdown-text.test.ts
    JsonView.test.ts
    FormattedContent.test.ts
  conversation/
    MessageBubble.test.ts
    ToolChip.test.ts
    ThinkingDots.test.ts
    (F03 batch adds: RoundCard.test.ts, DiagnosticRow.test.ts, …)
  (existing surface tests, rewritten per analysis §5.2)
  …
```

The "moved from" rows are file moves with `git mv`; the file
contents are rewritten (per analysis §5.4, §5.5 contracts).

**Pattern-class assertions live in `ui/`/`content/`/`conversation/`
unit tests only.** Surface tests (`agents-view.test.ts`,
`dashboard-view.test.ts`, etc.) stop asserting `.btn`/`.pill`/`.card`;
they assert via `getByRole`, `getByText`, or the new `data-testid`
column in analysis §5.2. Each surface-test rewrite ships in the
same commit as the surface refactor.

### 1.6 Cross-batch coordination (F03 / F04 / F05)

Three places where the F02 commit sequence interleaves with sibling
batches; resolution is binding so the "no alias period" rule holds
end-to-end:

- **F02 C5 ↔ F05 batch.** `ToolChip` consumes `ToolPresentationView`.
  F05 lands the `InlinePart[]`-based presenter rewrite in the same
  commit as C5; the F05 batch chip-markup commit IS C5. F05's
  pre-r2 string-headline contract is removed in the same commit.
- **F02 C11 ↔ F03 batch.** `AgentConversationView` is rewritten in
  two passes: the toolbar / state-panel / status-badge migration is
  F02 C11 (purely primitive consumption); the conversation-body
  refactor (rounds, `RoundCard`, `MessageBubble` insertion,
  `.conv-step`/`.tc-*`/`.tr-*` deletion) is the F03 batch. C11
  lands BEFORE the F03 body refactor so the new primitives exist
  when F03 imports them. No selector survives between C11 and the
  F03 commit because the toolbar selectors C11 deletes are
  disjoint from the body selectors F03 deletes.
- **F02 C13 ↔ F04 batch.** Same pattern: F02 C13 lands the
  primitive-only migration of `AnalystChatPanel.vue` (header buttons,
  composer button, surrounding state-panel cards). F04 then
  decomposes the body into `ChatHeader` / `MessageList` /
  `MessageItem` / `ChatComposer` / `JumpToLatest`. The F04
  decomposition imports F02's `MessageBubble`, `ToolChip`,
  `Card`, `Pill`, `Button` directly — no chat-local primitive
  copies (F04 r3 §3.3 binds this).

### 1.7 Build / typecheck impact

- **Net SFC count:** +13 new SFCs in `ui/` (7) + `content/` (2 new
  + 2 moved) + `conversation/` (3 in F02; F03 adds 5 more in its
  batch). Net deletions: `web/src/components/code/` directory
  (2 files) plus the bespoke `<style scoped>` blocks across 15
  consumer files (no SFC deletions; only style blocks shrink).
- **Bundle size:** projected slight decrease. The deleted scoped
  CSS bytes outweigh the added SFC scaffolding bytes (each primitive
  is 15–60 lines per analysis §8.2). Pattern classes were already
  in the bundle via F01.
- **`npx vue-tsc --noEmit`:** the new SFCs each carry an explicit
  `<script setup lang="ts">` with `defineProps<{…}>()`. Type errors
  surface during the prop signature migration of each consumer
  (e.g. `<Button variant="dnger">` is a compile error). Each
  commit must leave `vue-tsc` green; the existing pre-push hook
  enforces this.
- **Vitest:** new `ui/`/`content/`/`conversation/` unit tests are
  pure-component tests using `@vue/test-utils` `mount` with no store
  injection. Runtime per file ≤ 50 ms; CI wall-clock impact ≤ 2 s.
- **ESLint:** the four `no-restricted-imports` rules (§1.2) run in
  the existing pipeline. No new dependencies.

### 1.8 Story / visual-diff plan

**Decision: no Storybook, no Histoire, no Chromatic.** Reasoning:

- Each primitive's visual surface is one short scoped style + a
  pattern class; the design language source of truth is F01's
  pattern stylesheet. A story platform would duplicate F01.
- The codebase currently has no story tooling. Adding it is a
  larger dependency footprint than the entire F02 batch.
- Visual regressions are caught by:
  1. The `__tests__/ui/*.test.ts` unit tests asserting prop →
     class mapping (so a tone misroute is caught).
  2. Playwright e2e specs under
     [saivage-e2e-checkers/](../../../../saivage-e2e-checkers/)
     which screenshot the deployed UI for the chat, agents,
     dashboard, cards, and debug surfaces.
  3. The dual-LLM review process itself (the next batch's review
     round consumes the same source).

If, during implementation, a primitive's visual presentation drifts
from F01 (e.g. `Card tone="warn"` looks different from `.entry-warn`
in v2), the fix is in F01's pattern rule, not in a per-primitive
story. The system has one source of truth by design.

### 1.9 Selector survival cheatsheet (informational)

To shorten review of containers post-F02: a scoped class is
**allowed** to survive if and only if its rule body, after F02
lands, contains only properties from this whitelist:

```
display, position, top, right, bottom, left, inset, z-index,
grid-*, flex, flex-*, gap, row-gap, column-gap, justify-*, align-*,
place-*, order, padding, padding-*, margin, margin-*, width, height,
min-width, min-height, max-width, max-height, overflow, overflow-*,
white-space, word-break, overflow-wrap, text-overflow, cursor,
user-select, pointer-events, box-sizing, transform, transition (for
layout properties only — no colour transitions), opacity.
```

Forbidden in surviving scoped styles: `color`, `background`,
`background-color`, `border` (except `none`), `border-*`,
`border-radius`, `box-shadow`, `outline` (move to F01's
`.focus-visible` pattern), hex literals, `rgb()`/`rgba()` literals,
named colours.

CI gate: a custom `stylelint` rule (or a shell `rg` check in the
test job) flags any surviving file under `components/` whose
`<style scoped>` block contains a forbidden property. Pattern files
in `web/src/styles/` are exempt (they define the patterns).

---

## 2. Proposal B — Feature-slice with role-based co-location

The "one level up" alternative. Instead of three primitive folders
shared across the app, every domain feature owns its
components AND its primitives, with one cross-feature flat library.

### 2.1 File layout

```
web/src/
  lib/                                  (replaces shared "ui/" + "content/")
    Button.vue
    Pill.vue
    Card.vue
    StatusDot.vue
    PanelHeading.vue
    Overlay.vue
    Spinner.vue
    CodeBlock.vue
    MarkdownText.vue
    JsonView.vue
    FormattedContent.vue
    index.ts                            (barrel — exports every above)
  features/
    conversation/
      MessageBubble.vue
      ToolChip.vue
      ThinkingDots.vue
      RoundCard.vue
      DiagnosticRow.vue
      PendingCallFooter.vue
      CompactedCluster.vue
      ContextBlock.vue
      AgentConversationView.vue         (was components/agents/)
      RawLlmExchangePanel.vue           (was components/agents/)
      useAgentTimeline.ts
      timeline.ts
      round-id.ts
      types.ts
      __tests__/
    chat/
      AnalystChatPanel.vue              (was components/chat/)
      AnalystToaster.vue
      ChatHeader.vue                    (F04 r3 §3.2)
      MessageItem.vue
      MessageList.vue
      ChatComposer.vue
      JumpToLatest.vue
      useStickToBottom.ts
      useDebouncedConnectionState.ts
      __tests__/
    cards/
      CardDetailView.vue
      CardHistoryPanel.vue
      CardsBoardView.vue
      CardsLeaderboardView.vue
      CardsTimelineView.vue
      CardsTreeView.vue
      StaleWarningRibbon.vue
      __tests__/
    files/
      FilesView.vue                     (was views/)
      __tests__/
    dashboard/
      DashboardView.vue                 (was views/)
      __tests__/
    debug/
      DebugView.vue                     (was views/)
      __tests__/
    agents-list/
      AgentsView.vue                    (was views/)
      __tests__/
    auth/
      ApiTokenEntry.vue                 (was components/auth/)
      __tests__/
    shell/
      AppShell.vue                      (was components/layout/)
      WorkspaceHeader.vue
      NavRail.vue
      __tests__/
  router/
  stores/
  utils/
  styles/
```

Feature slices co-locate UI, composables, utilities, and tests
("feature-slice design", related to Feature-Sliced Design from the
Vue / React community). The shared layer collapses to **one** flat
`lib/` folder; primitives are imported via barrel:

```ts
import { Button, Card, Pill, MessageBubble } from '@/lib';
```

`MessageBubble` and `ToolChip` would NOT be in `lib/` — they are
conversation-specific composites. So Proposal B's "single flat
library" only contains the truly cross-feature primitives. The
conversation composites live with their feature.

### 2.2 New primitives (subset; many overlap with A)

Same prop signatures as Proposal A for every primitive listed under
A §1.3.1–1.3.7 and A §1.3.10–1.3.11. Conversation composites
(`MessageBubble`, `ToolChip`, `ThinkingDots`) move from a shared
folder into `features/conversation/`. Chat-only or cards-only or
debug-only composites that don't exist in A would not exist in B
either (analysis §6 ruled them out; this is preserved).

### 2.3 Deletion matrix

The deletion matrix from A §1.4 / analysis §4 still applies
verbatim. **What changes** is the consumer's import path:

```diff
- import Card from '@/components/ui/Card.vue';
+ import { Card } from '@/lib';
```

and the file lives under `features/<slice>/` instead of
`components/<surface>/`. Surface-name deletions (the bespoke `.btn`,
`.pill`, `.card`, `.entry-*` selectors) are identical.

Net additional deletions vs A: the **entire** `web/src/components/`
tree and `web/src/views/` tree (file moves, not content deletions).

### 2.4 Test reorganisation

`__tests__/` folders co-locate inside each feature slice. Tests
that today live at `web/src/__tests__/<name>.test.ts` move to
`web/src/features/<slice>/__tests__/<name>.test.ts`. The shared
primitive tests live at `web/src/lib/__tests__/Button.test.ts`,
etc.

### 2.5 Build / typecheck impact

- **Barrel re-export cost:** the `lib/index.ts` barrel re-exports
  ~11 SFCs. Vite tree-shaking through `index.ts` barrels for SFCs
  is generally fine but can interact badly with `defineAsyncComponent`
  and HMR. Concretely: an HMR cycle on `lib/Button.vue` invalidates
  every importer (transitively, every feature slice), where in
  Proposal A only the SFC's direct importers invalidate. Dev-loop
  cost: small but observable on slower hosts.
- **Tree-shaking:** acceptable for SFCs because each export is a
  separately-compiled chunk; the barrel adds zero runtime weight
  in production. But Vue SFC analyzer warns about side-effectful
  barrels if `lib/index.ts` ever imports a `.css` file at module
  top-level. We would need to ensure pattern CSS is imported once
  in `main.ts` (already true today), not via the barrel.
- **`vue-tsc` impact:** identical to A; same SFCs, same props.
- **Import-path churn:** every existing import (~70+ across the
  codebase per `rg -n "from '\\.\\.\\/" web/src/`) is rewritten in
  the same batch. The aliased imports (`@/components/...`) all
  change. This is one git mv-heavy refactor.
- **Router definitions:** `router/index.ts` rewrites every `import
  XxxView from '@/views/...'` to `import { XxxView } from
  '@/features/.../XxxView.vue'`. ~12 routes.

### 2.6 Story / visual-diff plan

Same as A (no Storybook, see §1.8). Co-located tests give a
slightly nicer "show me everything for the chat feature" answer
(open one folder), but that's an IDE ergonomic, not a regression
guard.

### 2.7 Why this proposal is plausible

- **Discoverability:** "where is the chat composer?" → `features/chat/`.
  No hopping between `components/chat/`, `components/ui/`,
  `views/`, `composables/`, `__tests__/`.
- **Refactor locality:** changes that span chat alone touch one
  directory tree. The "delete chat" or "extract chat to a separate
  package" thought-experiments become trivial.
- **Mirror of F03 r2 §3.2 utility split:** F03 already co-locates
  `composables/useAgentTimeline.ts` near `utils/agent-timeline/*`.
  Proposal B regularises that pattern across all features.
- **One less hierarchy level for primitives:** `lib/Card.vue` vs
  `components/ui/Card.vue`. Imports are shorter.

### 2.8 Why this proposal still falls short

- **Cross-feature composition.** `MessageBubble` is consumed by
  both `features/chat/` (F04) and `features/conversation/` (F03).
  If we put it in `features/conversation/`, then `features/chat/`
  imports from a sibling feature — which violates the feature-slice
  doctrine (siblings should be independent). The alternative —
  pushing `MessageBubble` and `ToolChip` into `lib/` — turns `lib/`
  into a misnomer (it's no longer just primitives) and re-creates
  the conversation/UI split inside `lib/` informally. Proposal A's
  three-layer split admits this cleanly.
- **Discriminator drift.** F02 r2 §1.3 says "anything importing a
  store is in the surface folder, not in `ui|content|conversation`".
  In Proposal B, every feature slice mixes container files (that
  import stores/router) and presentation files (that should not).
  We lose the structural enforcement that ESLint provides today by
  pinning forbidden imports per directory.
- **Test discovery cost.** A primitive contract change (e.g. add
  a tone to `Card`) needs its test updated. In B that test lives at
  `web/src/lib/__tests__/Card.test.ts`. In A it lives at
  `web/src/__tests__/ui/Card.test.ts`. Equivalent. But surface
  tests in A all live under one `web/src/__tests__/` root, which
  CI can run as one pool with one config. In B each feature slice
  needs Vitest to find its `__tests__/` (Vitest does this via
  globbing, no config change needed) but the visual output of
  `npm test` interleaves tests by slice rather than by surface. Net
  neutral.
- **Migration churn.** Proposal B is the same F02 work PLUS a
  whole-tree file move PLUS rewriting every import. That doubles
  the surface area of this batch for no behavior change.
- **F01 / F03 / F04 / F05 contracts assume `components/ui|content|
  conversation/`.** Each of those approved analyses cites those
  paths verbatim (e.g. F03 r2 §3.1 "F03 introduces no new
  locations; it consumes the F02-approved tree"). Proposal B
  forces re-review of those analyses — they were approved on the
  assumption Proposal A is the structure.
- **No backward compatibility carveout** is allowed. A whole-tree
  rename is fine under that guideline, but each consumer surface
  tests' import paths churn together with the structural rewrite.
  The probability of a merge conflict over the F02 batch
  doubles.

### 2.9 Variants of B considered and rejected within B

- **B-flat:** `components/lib/` flat, no `features/`. Imports
  become `import Button from '@/lib/Button.vue'`. Loses the
  discoverability win (chat code is again scattered across
  `components/chat/`, `views/DashboardView.vue` etc.) and keeps
  the import-path churn cost. Rejected.
- **B-prefixed:** flat `components/lib/ui-Button.vue`,
  `content-CodeBlock.vue`, `conversation-MessageBubble.vue`. Reads
  like an old Yahoo intranet. No tooling enforces the prefix
  conventions; the same things `ui/`, `content/`, `conversation/`
  folders do for free. Rejected.

---

## 3. Per-primitive TypeScript prop interfaces (verbatim)

Repeated here so the reviewer has one place to copy from. These
apply to **both** Proposal A and Proposal B (B only changes file
paths, not signatures). All interfaces use `<script setup lang="ts">`
`defineProps<{…}>()` syntax. `defineEmits` calls are shown
verbatim where applicable.

```ts
// ui/Button.vue
defineProps<{
  variant?: 'default' | 'primary' | 'danger';
  type?: 'button' | 'submit' | 'reset';
  disabled?: boolean;
  iconOnly?: boolean;
  title?: string;
  ariaLabel?: string;
  ariaPressed?: boolean;
  ariaExpanded?: boolean;
  ariaControls?: string;
}>();
defineEmits<{ (e: 'click', event: MouseEvent): void }>();
```

```ts
// ui/Pill.vue
defineProps<{
  tone?: 'default' | 'accent' | 'warn' | 'danger' | 'purple';
  as?: 'span' | 'button';
  type?: 'button' | 'submit';
  disabled?: boolean;
  title?: string;
  ariaLabel?: string;
  ariaPressed?: boolean;
  ariaExpanded?: boolean;
  ariaControls?: string;
}>();
defineEmits<{ (e: 'click', event: MouseEvent): void }>();
```

```ts
// ui/Card.vue
defineProps<{
  active?: boolean;
  tone?: 'default' | 'user' | 'accent' | 'warn' | 'danger' | 'purple';
  as?: 'div' | 'section' | 'article' | 'li' | 'aside';
  role?: string;
  ariaLabel?: string;
  ariaLabelledby?: string;
}>();
```

```ts
// ui/PanelHeading.vue
defineProps<{
  level?: 2 | 3;
  as?: 'header' | 'div';
}>();
// slots: 'title' (or default), 'meta', 'actions'
```

```ts
// ui/StatusDot.vue
defineProps<{
  tone: 'ok' | 'warn' | 'danger' | 'accent' | 'muted';
  ariaLabel?: string;
  title?: string;
}>();
```

```ts
// ui/Overlay.vue
defineProps<{
  open: boolean;
  closeOnBackdrop?: boolean;
  ariaLabel: string;
  initialFocus?: 'first' | 'container';
  restoreFocus?: boolean;
}>();
defineEmits<{ (e: 'close'): void }>();
```

```ts
// ui/Spinner.vue
defineProps<{
  size?: 'sm' | 'md' | 'lg';
  ariaLabel?: string;
}>();
```

```ts
// content/CodeBlock.vue
defineProps<{
  code: string;
  language?: string;
  filename?: string;
  copyable?: boolean;
  maxBytes?: number;
  showCopy?: boolean;
  ariaLabel?: string;
}>();
defineEmits<{ (e: 'oversize'): void }>();
```

```ts
// content/MarkdownText.vue
defineProps<{
  text: string;
  inline?: boolean;
}>();
```

```ts
// content/JsonView.vue
defineProps<{
  json: string | unknown;
  maxDepth?: number;
  collapsed?: boolean;
  ariaLabel?: string;
}>();
```

```ts
// content/FormattedContent.vue
import type { InlinePart } from '../../utils/tool-presenters';
defineProps<{
  parts: InlinePart[];
}>();
defineEmits<{
  (e: 'navigateFile', payload: { path: string; root: 'meta' | 'output' }): void;
  (e: 'navigateUrl', url: string): void;
}>();
```

```ts
// conversation/MessageBubble.vue
defineProps<{
  role: 'user' | 'assistant' | 'system';
  kind?: 'reasoning' | 'activity' | 'plain';
  timestamp?: string;
  modelLabel?: string;
}>();
// slots: 'default' (content), 'meta', 'badges'
```

```ts
// conversation/ToolChip.vue
import type { ToolPresentationView } from '../../utils/tool-presenters';
defineProps<{
  view: ToolPresentationView;
  status: 'call' | 'ok' | 'error' | 'pending';
  expanded: boolean;
  detailsId?: string;
  timestamp?: string;
}>();
defineEmits<{
  (e: 'toggle'): void;
  (e: 'navigateFile', payload: { path: string; root: 'meta' | 'output' }): void;
  (e: 'navigateUrl', url: string): void;
}>();
// slots: 'details'
```

```ts
// conversation/ThinkingDots.vue
defineProps<{ ariaLabel?: string }>();
```

F03-owned composites (`RoundCard`, `DiagnosticRow`,
`PendingCallFooter`, `CompactedCluster`, `ContextBlock`) inherit
their prop signatures from
[F03 r2 §3.4](../F03-conversation-rounds/01-analysis-r2.md#34-component-sketch).
F02 does not duplicate them here; the binding is "ships in the F03
batch, lives in `components/conversation/`".

---

## 4. Pattern extensions to F01 r2 (binding)

F02 introduces no new tokens. It introduces nine new pattern-class
rules (already enumerated in analysis §2.2; restated here as a
concrete patch against F01 r2's `patterns.css`):

```css
/* status dot tones */
.status-dot-ok      { background: var(--accent); }
.status-dot-warn    { background: var(--warn); }
.status-dot-danger  { background: var(--danger); }
.status-dot-accent  { background: var(--accent-2); }
.status-dot-muted   { background: var(--text-muted); }

/* card tones */
.card-warn   { border-color: var(--entry-warn-border);   background: var(--entry-warn-bg); }
.card-danger { border-color: var(--entry-danger-border); background: var(--entry-danger-bg); }
.card-accent { border-color: var(--entry-accent-border); background: var(--entry-accent-bg); }
.card-user   { border-color: var(--entry-user-border);   background: var(--entry-user-bg); }
.card-purple { border-color: var(--entry-purple-border); background: var(--entry-purple-bg); }

/* purple pill (diagnostic categories + supervision kind chips) */
.pill-purple { border-color: var(--entry-purple-border); color: var(--purple); }

/* tablist convention (analysis §6.5) */
.tablist > .pill[aria-pressed="true"] {
  border-color: var(--accent);
  color: var(--accent);
}
```

These rules land in the F02 C2 commit, in F01 r2's `patterns.css`.
They are the **only** F02→F01 contributions.

---

## 5. Test surface summary

### 5.1 New tests (Proposal A paths)

| File                                                | Lines (est.) | Asserts                                                                     |
| --------------------------------------------------- | ------------ | --------------------------------------------------------------------------- |
| `web/src/__tests__/ui/Button.test.ts`               | 80           | variant → class; iconOnly → `.btn-icon`; aria-pass-through; emit `click`    |
| `web/src/__tests__/ui/Pill.test.ts`                 | 90           | tone → class; `as="button"` → `<button>` root; aria-pressed pass-through    |
| `web/src/__tests__/ui/Card.test.ts`                 | 60           | tone → class; `as` → element; active → `.card-active`                        |
| `web/src/__tests__/ui/PanelHeading.test.ts`         | 50           | level → `<h2>`/`<h3>`; three named slots render                              |
| `web/src/__tests__/ui/StatusDot.test.ts`            | 40           | tone → class; aria-hidden by default; aria-label flips to role="img"        |
| `web/src/__tests__/ui/Spinner.test.ts`              | 30           | size → scoped class; aria-label / aria-hidden                                |
| `web/src/__tests__/ui/Overlay.test.ts`              | 200          | seven cases from analysis §5.4 (focus trap, restore, escape, backdrop, inert, modal flag, multi-overlay) |
| `web/src/__tests__/content/CodeBlock.test.ts`       | 150          | rewritten from existing `code-block.test.ts`; oversize emit; copy button     |
| `web/src/__tests__/content/MarkdownText.test.ts`    | 90           | rewritten from existing `markdown-text.test.ts`                              |
| `web/src/__tests__/content/JsonView.test.ts`        | 80           | tokenizeJson integration; `.syn-*` classes per token                        |
| `web/src/__tests__/content/FormattedContent.test.ts`| 120          | each `InlinePart` kind renders correctly; emits `navigateFile`/`navigateUrl` |
| `web/src/__tests__/conversation/MessageBubble.test.ts` | 90        | role → tone class; slots; reasoning kind layout                              |
| `web/src/__tests__/conversation/ToolChip.test.ts`   | 150          | seven cases from analysis §5.5 (status→tone, expand state, aria-expanded/controls, `view.detail` → Pill, slot gating, navigate emits) |
| `web/src/__tests__/conversation/ThinkingDots.test.ts` | 30         | three children riding `.pulse`                                               |

Total ≈ 1,260 lines of new unit tests, replacing roughly 1,800
lines of fragile bespoke-class surface assertions across the
existing test files (per analysis §5.2).

### 5.2 Rewritten surface tests

Each surface test file in analysis §5.2 stops asserting bespoke
classes and starts asserting via `data-testid` / `role` / text.
Strategy column (a/b/c from analysis §5.1) is preserved.

CI gate: a custom test job `web:no-bespoke-class-assertions` runs
`rg -n "find\\('\\.[a-z]" web/src/__tests__/` and fails on any new
matches outside the `ui/`/`content/`/`conversation/` test folders.

---

## 6. Build / typecheck / lint impact (consolidated)

- **`npx vue-tsc --noEmit`:** must stay green commit-by-commit
  (existing pre-push hook). Type-checking adds ~13 new SFCs to the
  graph; per-SFC compile time is ~20 ms in vue-tsc 2.x. Net delta
  ≤ 300 ms.
- **`npm run build` (Vite production):** projected slight bundle
  size decrease (deleted scoped CSS > added SFC JS). No new
  dependencies (`Spinner` consumes the already-imported
  `lucide-vue-next`).
- **`npm test` (Vitest):** ~1,260 new lines of unit tests, ~50 ms
  per file, ≤ 2 s wall-clock impact. Surface tests get faster
  on average because role/text queries are quicker than CSS
  selector traversal.
- **`npx eslint`:** four new `no-restricted-imports` blocks, all
  scoped via `overrides[*].files`. Adds ~50 ms to a full lint.

---

## 7. Story / visual-diff plan (consolidated)

No story tooling. Visual regressions caught by:

1. `__tests__/ui/*` prop→class unit tests (catch tone misroutes).
2. The existing
   [saivage-e2e-checkers/](../../../../saivage-e2e-checkers/) Playwright
   suite, which renders each major surface (chat, agents, dashboard,
   cards, debug) and screenshots them. F02 lands the new primitives;
   the e2e suite is re-run against the deployed UI before each
   commit closes.
3. Pattern stylesheet is the single source of truth; if a
   regression appears, the fix is in `patterns.css` (F01 r2), not
   in a per-primitive story.

If a future batch needs richer visual diffing (e.g. dark/light
contrast checks beyond the F01 r2 §7 contrast-check matrix), it
becomes its own issue.

---

## 8. Risks and open questions

| Risk                                                                                                                                                                          | Mitigation                                                                                                                          |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `Spinner` violates the "ui/ may not import lucide-vue-next" rule.                                                                                                             | Single, documented ESLint exception. Fallback (CSS-only spinner with `border` + `@keyframes`) ready if reviewer rejects.            |
| `ToolChip` consumes `ToolPresentationView` whose shape is owned by F05. Drift between F02 C5 and F05 batch could break the chip.                                              | F02 C5 explicitly imports `ToolPresentationView` from the **F05-final** `tool-presenters.ts`; the two batches share the same commit window (§1.6). |
| `Overlay` hand-rolled focus trap is subtle. Tests in §5.1 enumerate seven cases but a portal'd menu inside a dialog might escape the trap.                                    | The portal carve-out is recorded in analysis §8.3 as the fallback to `radix-vue` `<Dialog>`. We do not pre-commit; we monitor.       |
| F03 owns five composites inside `conversation/`. If F03 slips, F02 ships an empty subset of the folder.                                                                       | Acceptable: F02 C5 only ships `MessageBubble`, `ToolChip`, `ThinkingDots`. F03 fills the rest. The folder exists with three files initially. |
| Stylelint / `rg` gate for surviving-scoped-style colour properties might over-flag legitimate `outline` rules for focus-visible.                                              | F01 r2 owns `.focus-visible` pattern; consumers reference it instead of writing their own `outline`. The gate is allowed to flag any `outline` outside `styles/`. |
| F04 expects `MessageBubble` to be ready BEFORE its chat decomposition (F04 r3 §11). If F02 C5 lands too late, F04 stalls.                                                     | C5 is in the early half of the F02 sequence (commit 5 of 15). F04 starts its decomposition after C5 lands.                          |
| Removing `web/src/components/code/` could break IDE bookmarks / external links / docs.                                                                                        | Acceptable per project guideline (no backward compat). Docs and SPEC files that reference `components/code/` are updated in C3.     |
| Proposal B's import-path churn during transition is risky if any in-flight feature branch references the old paths.                                                           | Not applicable to Proposal A (it preserves paths). Proposal B would need to land at a freeze point.                                 |

Open questions for the reviewer:

- **(Q1)** Does the F01 r2 `patterns.css` deliverable include the
  nine extension rules in §4, or should this design land them
  inline as F02-owned and merge them into F01 in a follow-up?
- **(Q2)** Is the `.tablist > .pill[aria-pressed="true"]` ARIA-
  selector pattern acceptable? Alternative: a `.pill-pressed`
  modifier toggled by Vue. Tradeoff: ARIA selector lets the CSS
  follow the source-of-truth attribute; the class toggle is more
  conventional but introduces an `aria-pressed`-driven `watch` in
  every tablist consumer.
- **(Q3)** Should `FormattedContent` accept `(text → string)` and
  parse internally as a fallback when the caller hasn't built the
  `InlinePart[]` yet? Design currently says no (parts in only,
  caller is responsible for tokenisation via F05). Confirmation
  requested.

---

## 9. Recommendation

**Adopt Proposal A.**

Reasoning against each axis:

- **Clean architecture.** Proposal A separates concerns along the
  natural seam of UI primitive vs content renderer vs conversation
  composite. The composition rules in §1.2 are enforceable per
  directory via `no-restricted-imports`. Proposal B's feature
  slices mix container (store-importing) and presentation (store-
  free) files in the same folder, weakening the discriminator
  guarantee F02 r2 §1.3 establishes. Without the discriminator we
  lose the structural reason an `<style scoped>` audit succeeds.
- **F01 token consumption.** Identical between proposals (both
  consume pattern classes from F01 r2 `patterns.css`; neither
  introduces new tokens; both ship the nine extension rules of §4).
  No advantage to B.
- **F03 / F04 / F05 consumer alignment.** F03 r2 §3.1, F04 r3 §3.3,
  F05 r2 §2 each cite `components/ui|content|conversation/` by
  path. Proposal A satisfies these contracts without re-review.
  Proposal B forces every approved analysis to be amended for
  import-path changes, expanding the review surface and the merge
  conflict window.
- **Test surface.** A's surface is the smallest delta: new tests
  in three folders mirroring the three primitive folders, existing
  surface tests rewritten in place. B's surface includes the same
  changes PLUS rewriting `import` paths in every existing test
  file (~30+ files), which is bookkeeping mass for no behavior
  gain.
- **Migration footprint.** A is ~1,260 LOC of new tests, 15 commits
  of consumer migration, zero file moves outside the planned
  `components/code/ → components/content/` rename. B is the same
  delta PLUS a whole-tree `git mv` of every component, view, store
  import path. The probability of an in-flight branch colliding
  with B is much higher; A is a strictly safer landing.
- **Discoverability (B's main advantage).** Genuine but small: a
  developer searching for the chat composer can run
  `rg -n "ChatComposer" web/src/` in either layout and find it
  immediately. The "feature folder" idiom is nice; the cost of
  achieving it is not justified by F02's scope.

Net: Proposal A delivers every architectural property the analysis
demands at lower migration cost, with stronger structural
enforcement, and without forcing re-review of any sibling analysis.
Proposal B is a defensible reorganisation but better suited to a
future, dedicated batch if it's ever desired — not bundled with
F02.

**Chosen letter: A.**

---

## 10. Out of scope (carry-overs to other batches)

- Tokenization utility extraction (`tokenizeJson`) — F05 r2 §8.
- F03's round bodies (`RoundCard`, `DiagnosticRow`,
  `PendingCallFooter`, `CompactedCluster`, `ContextBlock`) — F03
  batch. F02 only ships the directory plus the three composites
  it explicitly owns (`MessageBubble`, `ToolChip`, `ThinkingDots`).
- F04's chat decomposition (`ChatHeader`, `MessageList`,
  `MessageItem`, `ChatComposer`, `JumpToLatest`) — F04 batch.
- Form-control primitives (input, textarea, select) — explicitly
  excluded per analysis §6.7.
- Headless-UI dependency adoption (radix-vue / reka-ui /
  @headlessui/vue) — explicitly rejected per analysis §8.3.

---

## 11. File outcomes (informational, Proposal A)

- **Created (SFCs):** 13 files under
  `web/src/components/{ui,content,conversation}/`, plus 14 new
  unit-test files under `web/src/__tests__/{ui,content,conversation}/`.
- **Relocated:** `web/src/components/code/CodeBlock.vue` →
  `web/src/components/content/CodeBlock.vue`,
  `web/src/components/code/MarkdownText.vue` →
  `web/src/components/content/MarkdownText.vue` (with their tests
  moving accordingly). `web/src/components/code/` directory
  removed.
- **Modified:** every consumer file enumerated in
  [analysis §4](01-analysis-r2.md#4-deletion--migration-matrix) —
  template body updated to render primitives, `<style scoped>`
  blocks trimmed to the §1.9 whitelist.
- **F01 r2 patterns.css:** + 9 extension rules listed in §4.
- **ESLint config:** + 4 `no-restricted-imports` overrides.
- **No barrels added.** No `index.ts` under `ui/`, `content/`, or
  `conversation/`.

Exact landing order is §1.4's 15-commit sequence. The reviewer-
phase document (`02-design-review-r1.md`) will critique this; the
implementation plan (`03-plan-r1.md`) will translate this into
checklists, test commands, and per-commit acceptance criteria.
