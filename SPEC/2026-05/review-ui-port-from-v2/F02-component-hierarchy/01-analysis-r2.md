# F02 — Component hierarchy / UI primitive layer — Functional analysis (r2)

Writer round 2. Addresses every required item in
[01-analysis-review-r1.md](01-analysis-review-r1.md). Binding pattern
surface is [F01 r1](../F01-design-tokens/01-analysis-r1.md) — F01 r2
does not yet exist; this analysis cites r1 and lists every pattern
extension F02 needs F01 r2 to absorb.

Project guideline (binding): architecture-first, no backward
compatibility. Every bespoke v3 class enumerated below is **deleted**
in the same commit that introduces its replacement primitive or
pattern. No aliasing, no `@deprecated` re-exports, no `.legacy-*`
holdovers.

Companion files:
[F02-component-hierarchy.md](../F02-component-hierarchy.md),
[00-SUBSYSTEM-MAP.md](../00-SUBSYSTEM-MAP.md),
[F01-design-tokens.md](../F01-design-tokens.md),
[F01 analysis r1](../F01-design-tokens/01-analysis-r1.md).

---

## 1. Shared layer split into three sublayers

The reviewer was right that "primitive" was overloaded. r1 lumped
12 unrelated components into one folder. r2 carves three sublayers
with explicit composition rules.

```
web/src/components/
  ui/                    ← base primitives, pattern-class shells
    Button.vue
    Pill.vue
    Card.vue
    PanelHeading.vue
    StatusDot.vue
    Overlay.vue
    Spinner.vue
  content/               ← content renderers
    CodeBlock.vue
    MarkdownText.vue
    JsonView.vue
    FormattedContent.vue
  conversation/          ← conversation composites
    MessageBubble.vue
    ToolChip.vue
    DiagnosticRow.vue
    ThinkingDots.vue
    RoundCard.vue
    PendingCallFooter.vue
    CompactedCluster.vue
```

### 1.1 Composition rules

The folders are not merely organisational; the import graph between
them is constrained.

- `ui/*` (base primitives): each file imports zero other `ui/`
  components. A primitive renders one HTML element plus pattern
  classes plus a tiny scoped layout style. Forbidden imports:
  Pinia stores, Vue Router, `useFetch`, the WebSocket client, any
  other `ui/`/`content/`/`conversation/` SFC, `lucide-vue-next`
  glyphs (icons come through the default slot).
- `content/*` (content renderers): may import only `ui/` primitives
  (e.g. `CodeBlock` uses `Button` for the copy action). Forbidden:
  stores, router, WebSocket, other `content/` SFCs, conversation
  composites. `lucide-vue-next` is allowed (the copy icon).
- `conversation/*` (composites): may import `ui/` and `content/`.
  `ToolChip` legitimately composes `Pill`, `Button`, and a slot for
  `JsonView`/`CodeBlock`. Forbidden: stores, router, WebSocket.
  Composites take typed props and emit events; container surfaces
  in `agents/`, `chat/`, `cards/` wire stores to props.

### 1.2 Why this split

- `Button` and `MessageBubble` are not the same kind of thing.
  Reviewer R1.§1 calls this out. Primitives have one job
  (`<button>` plus pattern classes); composites own article
  semantics, role mapping, badge slots, content rendering. Stuffing
  them in one `ui/` is a category error.
- `CodeBlock` already implements behavior — highlight, copy, oversize
  notice, clipboard fallback (see
  [web/src/components/code/CodeBlock.vue](../../../../web/src/components/code/CodeBlock.vue)).
  Treating it as a pattern-class shell would be a lie about its
  surface area; calling it `content/` matches its responsibilities.
- The conversation tier prevents the `ui/` folder from growing
  one-off composites (`PendingCallFooter`, `CompactedCluster`,
  `RoundCard`) that F03 needs. They live with other
  conversation-only shapes.

### 1.3 Discriminator

If a file imports a store, router, or fetch client, it does not
belong in any of these three sublayers — it lives in
`components/<surface>/` (agents, chat, cards, layout, …).
`RawLlmExchangePanel`, `AnalystToaster`, `StaleWarningRibbon`,
`CardHistoryPanel`, `WorkspaceHeader`, every view, every `cards/*`
view stay in their surface folders.

---

## 2. Pattern-class reconciliation against F01

This is the explicit list of F01 patterns r2 expects to find in
`web/src/styles/patterns.css`. **F02 extends F01** with the
sub-bulleted rules: F01 r2 must add them, otherwise F02 cannot
implement. The extensions are listed once, here, not scattered.

### 2.1 Patterns inherited from F01 r1 verbatim

From v2 [patterns.css](../../../../saivage/web/src/styles/patterns.css)
copied unchanged:

- `.btn`, `.btn-primary`, `.btn-danger`
- `.pill`, `.pill-accent`, `.pill-warn`, `.pill-danger`
- `.card`, `.card-active`
- `.entry-user`, `.entry-accent`, `.entry-warn`, `.entry-danger`, `.entry-purple`
- `.code-inline`, `.code-block`
- `.syn-key`, `.syn-string`, `.syn-number`, `.syn-boolean`, `.syn-null`, `.syn-punctuation`
- `.panel-heading` (h2/h3 only)
- `.status-dot` (size + radius only, no tone)
- `.text-muted`, `.text-faint`, `.text-accent`, `.text-warn`, `.text-danger`
- `.overlay`, `.spin`, `.pulse`

### 2.2 F02 extensions to F01 (must land in F01 r2)

The reviewer's instruction is binding: any pattern class not in F01
r1 is either dropped from the primitive API or added explicitly as
an extension here. The list below is the **only** new pattern
surface F02 introduces; everything else uses the v2 set verbatim.

- `.status-dot-ok` → `background: var(--accent)`
- `.status-dot-warn` → `background: var(--warn)`
- `.status-dot-danger` → `background: var(--danger)`
- `.status-dot-accent` → `background: var(--accent-2)`
- `.status-dot-muted` → `background: var(--text-muted)`
- `.card-warn` → `border-color: var(--entry-warn-border); background: var(--entry-warn-bg)`
- `.card-danger` → `border-color: var(--entry-danger-border); background: var(--entry-danger-bg)`
- `.card-accent` → `border-color: var(--entry-accent-border); background: var(--entry-accent-bg)`
- `.card-user` → `border-color: var(--entry-user-border); background: var(--entry-user-bg)`
- `.card-purple` → `border-color: var(--entry-purple-border); background: var(--entry-purple-bg)`
- `.pill-purple` → `border-color: var(--entry-purple-border); color: var(--purple)` (used by diagnostic categories in F03 and the supervision kind chips in DebugView)
- `.panel-heading-h1` modifier OR a separate selector for `h1` (see §3.5: WorkspaceHeader is **removed** from `PanelHeading`'s call sites, so this is unnecessary — listed here only to be explicit that no `h1` variant is added)

### 2.3 Patterns explicitly NOT added (despite r1 promising them)

The following names appeared in r1 §2 and are now **dropped**:

- `btn-sm` — does not exist in v2. The `Button` primitive no longer
  exposes `size`. Icon-only and "small" idioms are handled by an
  `iconOnly` prop that sets `min-width === min-height` via
  scoped layout style, not a new pattern class. See §3.1.
- `thinking-dots` — there is no v2 pattern named this. The
  `ThinkingDots` composite holds its own scoped markup and uses the
  v2 `.pulse` keyframe plus inline children; no new global class.
- `tool-chip`, `tool-chip-row`, `tool-chip-call`, `tool-chip-ok`,
  `tool-chip-error`, `tool-chip-pending`, `tool-chip-details` — F02
  does **not** add these as global pattern classes. `ToolChip` is a
  composite; its visuals come from `.card`, `.pill`, `.btn`, status
  state via `.entry-*` modifiers on the wrapper `.card`. The
  internal layout lives in `ToolChip.vue`'s scoped style.
- `msg`, `msg-meta`, `msg-content`, `msg-badges` — same reasoning.
  `MessageBubble` is a composite. Its outer element uses `.card` +
  `.entry-{user,accent,warn,purple}`; its inner three-row layout is
  scoped to the composite.
- `role-user`, `role-assistant`, `role-system`, `kind-reasoning`,
  `kind-activity`, `kind-plain` — these are `MessageBubble`-local
  layout classes, not pattern classes. They stay in the composite's
  scoped style. They do **not** appear in `patterns.css`.

### 2.4 Why the extension list is the minimum

`Card tone="warn"` is referenced from at least nine call sites
(stale ribbon, files-banner, debug operator banner, dashboard
runtime banner, supervision flags, two doctor states, RawLlm
redaction banner, auth-required banner via danger). Inlining the
`entry-*` rules inside each `Card` consumer is more code than five
`.card-{tone}` rules in `patterns.css`. Same argument for
`.status-dot-{tone}`: 18+ call sites would each repeat
`style="background: var(--accent)"` otherwise. `.pill-purple` is
added because diagnostic-category pills (F03) and `sv-pill-kind`
(DebugView) consume it; without it, we'd add inline `style` to
every purple pill.

---

## 3. Primitive APIs (revised)

### 3.1 `Button.vue` (ui/)

```vue
<script setup lang="ts">
defineProps<{
  variant?: 'default' | 'primary' | 'danger';
  type?: 'button' | 'submit' | 'reset';
  disabled?: boolean;
  iconOnly?: boolean;
  title?: string;
  ariaLabel?: string;
}>();
defineEmits<{ (e: 'click', event: MouseEvent): void }>();
</script>
<template>
  <button
    :type="type ?? 'button'"
    :disabled="disabled"
    :title="title"
    :aria-label="ariaLabel"
    class="btn"
    :class="{
      'btn-primary': variant === 'primary',
      'btn-danger': variant === 'danger',
      'btn-icon': iconOnly,
    }"
    @click="$emit('click', $event)"
  ><slot /></button>
</template>
<style scoped>
.btn-icon {
  min-width: 32px;
  padding: 0;
}
</style>
```

Changes vs r1: `size` prop dropped (no `btn-sm` in F01). `iconOnly`
added as a pure layout modifier; the `.btn-icon` class is
**not** a pattern class — it is scoped to this SFC. The primitive
still renders `.btn` + variant class only, which IS a pattern
class. Refresh / fetch / retry / close buttons all become
`<Button icon-only :aria-label="…"><Icon /></Button>`.

### 3.2 `Pill.vue` (ui/)

```vue
<script setup lang="ts">
defineProps<{
  tone?: 'default' | 'accent' | 'warn' | 'danger' | 'purple';
  as?: 'span' | 'button';
  active?: boolean;
  disabled?: boolean;
  title?: string;
  ariaLabel?: string;
  ariaPressed?: boolean;
}>();
defineEmits<{ (e: 'click', event: MouseEvent): void }>();
</script>
```

Renders `.pill` plus one of `pill-accent | pill-warn | pill-danger |
pill-purple` (purple requires the F02 extension in §2.2). The `active`
prop adds `.pill-active` — wait: this would be another extension.
Decision: drop `active`. Filter chips that need a pressed state use
`as="button" :aria-pressed="…"` and surface-local scoped style for the
visual "selected" affordance OR use `.card-active` semantics on a
wrapper. We do not add `.pill-active` to patterns.css; F03's filter
chips can express selection through `aria-pressed` plus a local
scoped border-color override that reads from `--accent`.

### 3.3 `Card.vue` (ui/)

```vue
<script setup lang="ts">
defineProps<{
  active?: boolean;
  tone?: 'default' | 'user' | 'accent' | 'warn' | 'danger' | 'purple';
  as?: 'div' | 'section' | 'article' | 'li';
}>();
</script>
<template>
  <component
    :is="as ?? 'div'"
    class="card"
    :class="{
      'card-active': active,
      'card-user':   tone === 'user',
      'card-accent': tone === 'accent',
      'card-warn':   tone === 'warn',
      'card-danger': tone === 'danger',
      'card-purple': tone === 'purple',
    }"
  ><slot /></component>
</template>
```

F01 r2 patterns required (already enumerated in §2.2):
`.card-warn`, `.card-danger`, `.card-accent`, `.card-user`,
`.card-purple`. `.card-active` is in F01 r1 verbatim.

### 3.4 `PanelHeading.vue` (ui/)

```vue
<script setup lang="ts">
defineProps<{ level?: 2 | 3 }>();
</script>
<template>
  <header class="panel-heading">
    <component :is="`h${level ?? 3}`" class="panel-heading-title">
      <slot name="title" /><slot />
    </component>
    <div class="panel-heading-meta"><slot name="meta" /></div>
    <div class="panel-heading-actions"><slot name="actions" /></div>
  </header>
</template>
```

Heading levels stay `2 | 3` (v2 `.panel-heading h2, h3` rules).
`WorkspaceHeader` is **excluded** from this primitive's call-site
list (see [web/src/components/layout/WorkspaceHeader.vue](../../../../web/src/components/layout/WorkspaceHeader.vue));
that file is the top app bar with `h1`-level page title plus
status-chip cluster, which has different layout demands.
WorkspaceHeader stays in `layout/`, becomes layout-only scoped CSS,
and composes `StatusDot` + `Pill` + `Button` directly.

### 3.5 `StatusDot.vue` (ui/)

```vue
<script setup lang="ts">
defineProps<{
  tone: 'ok' | 'warn' | 'danger' | 'accent' | 'muted';
  ariaLabel?: string;
  title?: string;
}>();
</script>
<template>
  <span
    class="status-dot"
    :class="`status-dot-${tone}`"
    :aria-hidden="ariaLabel ? undefined : 'true'"
    :role="ariaLabel ? 'img' : undefined"
    :aria-label="ariaLabel"
    :title="title"
  />
</template>
```

`aria-hidden="true"` by default — the dot is decorative when adjacent
visible text already names the state (the common case in
`WorkspaceHeader`, `DashboardView`, `AgentsView`, `DebugView`). Only
when consumed standalone (no companion label) does the caller pass
`ariaLabel`, which switches the element to `role="img"`.

### 3.6 `Overlay.vue` (ui/)

See §9 for the accessibility strategy. Props:

```ts
{
  open: boolean;
  closeOnBackdrop?: boolean;
  ariaLabel: string;          // required
  initialFocus?: 'first' | 'container';
  restoreFocus?: boolean;     // default true
}
```

Emits: `close()` (Escape, backdrop click when allowed, or programmatic).

### 3.7 `Spinner.vue` (ui/)

`{ size?: 'sm' | 'md' | 'lg'; ariaLabel?: string }`. Renders a
`Loader2` glyph from `lucide-vue-next` with the `.spin` keyframe.
When `ariaLabel` omitted, renders `aria-hidden="true"` and relies on
the surrounding caption (state-panel pattern, see §6.4).

### 3.8 `MessageBubble.vue` (conversation/)

Props (revised; `tool` role removed):

```ts
{
  role: 'user' | 'assistant' | 'system';
  kind?: 'reasoning' | 'activity' | 'plain';
  timestamp?: string;
  modelLabel?: string;
}
```

Reviewer R1.§3 said the `tool` role was the wrong abstraction.
Confirmed: tool-call and tool-result entries are rendered by
`ToolChip` exclusively. `MessageBubble` only renders human/assistant/
system text. `entryClass(role)` mapping becomes:

| role        | wrapper class added         |
| ----------- | --------------------------- |
| `user`      | `card-user`                 |
| `assistant` | `card-accent`               |
| `system`    | `card-purple` (or none, depending on `kind`) |

(`MessageBubble` renders an `<article class="card …">`; the `.card-*`
classes are the F02 extensions from §2.2.)

### 3.9 `ToolChip.vue` (conversation/)

```ts
import type { ToolPresentationView } from '../../utils/tool-presenters';

defineProps<{
  view: ToolPresentationView;
  status: 'call' | 'ok' | 'error' | 'pending';
  expanded: boolean;
  detailsId?: string;
  timestamp?: string;
}>();
defineEmits<{ (e: 'toggle'): void }>();
```

`ToolPresentationView` is the **unified F05 output** — F05 (tool
presenter port) introduces this type in
[web/src/utils/tool-presenters.ts](../../../../web/src/utils/tool-presenters.ts)
as a discriminated union or normalised view:

```ts
export interface ToolPresentationView {
  icon: string;       // glyph character from v2 toolFormatters
  name: string;       // tool name (read_file, edit_file, …)
  headline: string;   // single-line summary
  detail?: string;    // optional pill content (path, url, exit code)
  detailTone?: 'accent' | 'warn' | 'danger';
  parts?: InlinePart[]; // v2 InlinePart[] for richer rendering
}
```

`ToolChip` composes `Card` (tone derived from `status`), a header
`Button` (the toggle, with `aria-expanded`/`aria-controls`), inline
glyph + name + headline, a `Pill` for `view.detail`, and a `<slot
name="details">` rendered when `expanded`. No new pattern classes;
`.card`, `.btn`, `.pill`, plus this composite's scoped layout.

### 3.10 Other composites (sketch only)

- `DiagnosticRow.vue` — `model_issue`/`model_repair`/`model_recovered`
  rows for F03. Composes `Card tone="purple"` + `Pill tone="purple"`.
- `RoundCard.vue` — round wrapper for F03 timelines. Composes
  `Card` + `PanelHeading level="3"`.
- `PendingCallFooter.vue` — live pending-call footer (F03). Composes
  `Card tone="warn"` + `Spinner` + `Pill`.
- `CompactedCluster.vue` — F03 compacted-history cluster.
  Composes `Card tone="warn"` + `Pill`.
- `ThinkingDots.vue` — three `<span>`s riding `.pulse`. No pattern
  class. Layout-only scoped style.

These composites are listed for completeness; their API design lives
in F03's analysis. They are mentioned here so the directory layout
does not surprise F03's reviewer.

---

## 4. Deletion / migration matrix

Per the project guideline, every selector in this matrix is **deleted
in the same commit as its replacement** — no aliases. Rows are
grouped by surface for readability. Columns:

| old selector | owning file | replacement | impact class |

`impact class` is `V` = visual-only (color/border/radius), `B` =
behavioral (interaction/state), `A` = accessibility-critical
(`role`, `aria-*`, focus management).

### 4.1 AppShell + auth banner

| old selector | owning file | replacement | impact |
| --- | --- | --- | --- |
| `.auth-required-banner` | [layout/AppShell.vue](../../../../web/src/components/layout/AppShell.vue) | `<Card tone="danger" data-testid="auth-required-banner">` | V + A |
| `.auth-banner-action`   | AppShell.vue | `<Button variant="default" data-testid="auth-banner-action">` | V + B |
| `.auth-banner-dismiss`  | AppShell.vue | `<Button icon-only aria-label="Dismiss" data-testid="auth-banner-dismiss">` | V + B |
| `.app-shell`            | AppShell.vue | layout-only scoped class retained (grid) | V |
| `.workspace-content`    | AppShell.vue | layout-only scoped class retained | V |

### 4.2 ApiTokenEntry

| old selector | owning file | replacement | impact |
| --- | --- | --- | --- |
| `.token-overlay`        | [auth/ApiTokenEntry.vue](../../../../web/src/components/auth/ApiTokenEntry.vue) | `<Overlay>` (renders `.overlay`, has `role="dialog"`) | V + A |
| `.token-dialog`         | ApiTokenEntry.vue | scoped layout inside Overlay's default slot | V |
| `.token-btn`            | ApiTokenEntry.vue | `<Button>` | V |
| `.token-btn-save`       | ApiTokenEntry.vue | `<Button variant="primary" data-testid="token-save">` | V + B |
| `.token-btn-clear`      | ApiTokenEntry.vue | `<Button variant="danger" data-testid="token-clear">` | V + B |
| `.token-btn-cancel`     | ApiTokenEntry.vue | `<Button data-testid="token-cancel">` | V + B |
| `.token-toggle`         | ApiTokenEntry.vue | `<Button icon-only aria-label="Show/hide">` | V + B |
| `.api-token-btn`        | [nav/NavRail.vue](../../../../web/src/components/nav/NavRail.vue) | `<Button icon-only aria-label="API token settings" data-testid="api-token-btn">` | V + B |

### 4.3 WorkspaceHeader

| old selector | owning file | replacement | impact |
| --- | --- | --- | --- |
| `.ws-chip`              | [layout/WorkspaceHeader.vue](../../../../web/src/components/layout/WorkspaceHeader.vue) | `<Pill tone="accent">` with adjacent `<StatusDot tone="…">` | V |
| `.runtime-chip`         | WorkspaceHeader.vue | `<Pill tone="accent">` (composition rule: tone derived in caller) | V |
| `.pause-chip`           | WorkspaceHeader.vue | `<Pill tone="warn">` | V |
| `.chip-dot`             | WorkspaceHeader.vue | `<StatusDot tone="…">` sibling to Pill (NOT inside) | V + A |
| `.app-header` (bespoke) | WorkspaceHeader.vue | layout-only scoped grid | V |

WorkspaceHeader stays a layout component; it does **not** use
`PanelHeading` (different heading level, different slots).

### 4.4 NavRail

| old selector | owning file | replacement | impact |
| --- | --- | --- | --- |
| `.nav-rail`             | NavRail.vue | layout-only scoped class retained | V |
| `.nav-rail-link.active` | NavRail.vue | `<RouterLink class="…">` with `:class="{ active: … }"` plus surface-local style reading `--accent` | V + B |

NavRail tabs do **not** become `Pill` — they are large block links,
not pill-shaped. They stay as `<RouterLink>` with surface-local
scoped styles (which is layout-only colour-via-tokens, allowed).

### 4.5 DashboardView

| old selector | owning file | replacement | impact |
| --- | --- | --- | --- |
| `.refresh-btn`          | [views/DashboardView.vue](../../../../web/src/views/DashboardView.vue) | `<Button icon-only aria-label="Refresh">` | V + B |
| `.runtime-banner.banner-error` | DashboardView.vue | `<Card tone="danger">` | V |
| `.runtime-banner.banner-warning` | DashboardView.vue | `<Card tone="warn">` | V |
| `.error-banner`         | DashboardView.vue | `<Card tone="danger">` | V |
| `.actionable-error`     | DashboardView.vue | `<Card tone="danger" role="alert">` | V + A |
| `.actionable-message`/`.actionable-next`/`.actionable-meta` | DashboardView.vue | layout-only inside Card | V |
| `.status-loading`       | DashboardView.vue | `<Spinner>` + caption (see §6.4) | V + A |
| `.status-section`       | DashboardView.vue | layout-only (section spacing) | V |
| `.status-grid`/`.status-item`/`.status-key`/`.status-value` | DashboardView.vue | layout-only (no colour) | V |
| `.section-label`        | DashboardView.vue | layout-only `<h3>` styling | V |
| `.csb-*` (count/fill/label/row/track) | DashboardView.vue | layout-only progress markup | V |
| `.dc-*` (deps/item/priority/status/title/type) | DashboardView.vue | `<Card>` + `<Pill>` composition for child-of-goal items | V |
| `.cue-chip`             | DashboardView.vue | `<Pill tone="…">` (tone via `cueClass`) | V |
| `.detail-callout`       | DashboardView.vue | `<Card tone="accent">` | V |

### 4.6 FilesView

| old selector | owning file | replacement | impact |
| --- | --- | --- | --- |
| `.files-global-banner.banner-error`   | [views/FilesView.vue](../../../../web/src/views/FilesView.vue) | `<Card tone="danger" data-testid="files-global-banner">` | V + A |
| `.files-global-banner.banner-warning` | FilesView.vue | `<Card tone="warn" data-testid="files-global-banner">` | V |
| `.file-panel`           | FilesView.vue | layout-only scoped class | V |
| `.file-list`/`.file-entry`/`.entry-icon` | FilesView.vue | layout-only (no colour); selection state via `aria-current` | V + A |
| `.crumb`/`.crumb-link`/`.crumb-sep` | FilesView.vue | layout-only breadcrumb | V |
| `.viewer-state`         | FilesView.vue | `<Card tone="warn">` (preview-blocked, not-found, denied) | V + A |
| `.file-viewer`          | FilesView.vue | layout-only wrapper around `<CodeBlock>` / `<MarkdownText>` | V |
| `.viewer-close-btn`     | FilesView.vue | `<Button icon-only aria-label="Close viewer">` | V + B |
| `.sv-fetch-btn`         | FilesView.vue | `<Button icon-only aria-label="Fetch">` (quarantine footer) | V + B |

### 4.7 DebugView

| old selector | owning file | replacement | impact |
| --- | --- | --- | --- |
| `.debug-tab`            | [views/DebugView.vue](../../../../web/src/views/DebugView.vue) | `<Pill as="button" :aria-pressed="…">` with `aria-pressed` driving the F02-local active style (see §6.5 navigation/tabs decision) | V + B + A |
| `.debug-tabs`           | DebugView.vue | layout-only flex row | V |
| `.debug-tab-content`    | DebugView.vue | layout-only `<section>` | V |
| `.debug-section`/`.debug-section-header`/`.debug-section-title` | DebugView.vue | `<PanelHeading level="3">` | V |
| `.debug-loading`        | DebugView.vue | `<Spinner>` + caption inside a state-panel `<Card>` | V + A |
| `.debug-error`          | DebugView.vue | `<Card tone="danger" role="alert">` | V + A |
| `.debug-empty`          | DebugView.vue | `<Card>` (default tone) with muted-text caption | V |
| `.debug-grid`/`.dg-item` | DebugView.vue | layout-only grid of `<Card>` | V |
| `.operator-banner-error` | DebugView.vue | `<Card tone="danger">` | V |
| `.operator-banner-warning` | DebugView.vue | `<Card tone="warn">` | V |
| `.mcp-server-badge`     | DebugView.vue | `<Pill tone="accent" data-testid="mcp-server-badge">` | V |
| `.mcp-server-transport` | DebugView.vue | `<Pill>` (default tone) | V |
| `.mcp-tool-count`       | DebugView.vue | `<Pill tone="accent">` | V |
| `.mcp-tool-card`        | DebugView.vue | `<Card>` | V |
| `.mcp-tool-desc`        | DebugView.vue | layout-only text | V |
| `.mcp-stats-header`/`-cell`/`-row` | DebugView.vue | layout-only table | V |
| `.mcp-stat-success`     | DebugView.vue | `<Pill tone="accent">` | V |
| `.mcp-stat-error`       | DebugView.vue | `<Pill tone="danger">` | V |
| `.sv-stat-card`/`.sv-stat-num` | DebugView.vue | `<Card>` + scoped numeric layout | V |
| `.sv-pill.risk-low`     | DebugView.vue | `<Pill tone="accent" data-testid="risk-pill" data-risk="low">` | V + B |
| `.sv-pill.risk-high`    | DebugView.vue | `<Pill tone="danger" data-testid="risk-pill" data-risk="high">` | V + B |
| `.sv-pill-kind`         | DebugView.vue | `<Pill tone="purple" data-testid="sv-pill-kind">` | V |
| `.sv-review-item`/`.sv-q-item` | DebugView.vue | `<Card>` rows | V |
| `.sv-q-browse-btn`      | DebugView.vue | `<Button data-testid="sv-q-browse-btn">` | V + B |
| `.doctor-status-banner` | DebugView.vue | `<Card tone="warn|danger" data-testid="doctor-status-banner">` | V |
| `.doctor-check-item`    | DebugView.vue | `<Card>` rows with `<StatusDot tone="ok\|danger">` | V + A |
| `.doctor-issues`/`.doctor-ok` | DebugView.vue | tone of the `<Card>` above | V |
| `.check-passed`/`.check-failed`/`.check-icon`/`.check-name`/`.check-body`/`.check-details` | DebugView.vue | layout-only inside `<Card>` | V |
| `.process-link-btn` (and similar) | DebugView.vue | `<Button>` | V + B |

### 4.8 AgentsView + AgentConversationView

| old selector | owning file | replacement | impact |
| --- | --- | --- | --- |
| `.conv-tb-btn`          | [agents/AgentConversationView.vue](../../../../web/src/components/agents/AgentConversationView.vue) | `<Button>` (raw-LLM toggle, copy, …) | V + B |
| `.conv-toolbar`         | AgentConversationView.vue | layout-only flex row | V |
| `.conv-header`          | AgentConversationView.vue | `<PanelHeading level="2">` | V |
| `.conv-model`/`.conv-role`/`.conv-info` | AgentConversationView.vue | `<Pill tone="…">` inside `PanelHeading meta` slot | V |
| `.conv-status-badge.s-active` | AgentConversationView.vue | `<Pill tone="accent" data-testid="conv-status" data-state="active">` | V + B |
| `.conv-status-badge.s-waiting` | AgentConversationView.vue | `<Pill tone="warn" data-testid="conv-status" data-state="waiting">` | V + B |
| `.conv-status-badge.s-done` | AgentConversationView.vue | `<Pill data-testid="conv-status" data-state="done">` | V + B |
| `.conv-status-badge.s-blocked` | AgentConversationView.vue | `<Pill tone="warn" data-testid="conv-status" data-state="blocked">` | V + B |
| `.conv-status-badge.s-failed` | AgentConversationView.vue | `<Pill tone="danger" data-testid="conv-status" data-state="failed">` | V + B |
| `.conv-step`            | AgentConversationView.vue | conversation composites (`RoundCard`, `MessageBubble`, `ToolChip`) from F03 | V + B |
| `.conv-message`         | AgentConversationView.vue | `<MessageBubble>` | V |
| `.conv-empty`/`.conv-loading`/`.conv-error`/`.conv-warning` | AgentConversationView.vue | `<Card tone="…">` state panels | V + A |
| `.tc-header`/`.tc-toggle`/`.tc-tool`/`.tc-icon`/`.tc-name`/`.tc-headline`/`.tc-detail`/`.tc-time` | AgentConversationView.vue | `<ToolChip>` composite | V + B + A |
| `.tr-*` (tool-result family) | AgentConversationView.vue | `<ToolChip>` (status='ok'/'error') | V + B |
| `.agents-empty`/`.agents-unauthorized`/`.agents-stale`/`.agents-loading`/`.agents-error`/`.agents-warning` | [views/AgentsView.vue](../../../../web/src/views/AgentsView.vue) | `<Card tone="…">` state panels (preserve `data-testid` matching each role) | V + A |
| `.session-card`         | AgentsView.vue | `<Card>` with click behavior | V + B |
| `.detail-header-bar`    | AgentsView.vue | layout-only inside `<PanelHeading>` | V |
| `.msg-link`             | AgentsView.vue | `<a class="msg-link" data-testid="msg-link">` — markdown link inside `MessageBubble`; class becomes layout-only (text-decoration), no colour | V + B |
| `.agents-layout`/`.agents-content`/`.agents-state` | AgentsView.vue | layout-only scoped grids | V |

### 4.9 RawLlmExchangePanel

The reviewer correctly noted r1 mis-treated this as an overlay
candidate. It is an **inline panel** below the conversation header;
that interaction model is preserved. Selectors:

| old selector | owning file | replacement | impact |
| --- | --- | --- | --- |
| `.rlp-refresh`          | [agents/RawLlmExchangePanel.vue](../../../../web/src/components/agents/RawLlmExchangePanel.vue) | `<Button icon-only aria-label="Refresh raw LLM" data-testid="rlp-refresh">` | V + B |
| `.rlp-tabs`/`.rlp-tab`/`.rlp-tab--active` | RawLlmExchangePanel.vue | `<Pill as="button" :aria-pressed=… data-testid="rlp-tab">` | V + B + A |
| `.rlp-status--error`    | RawLlmExchangePanel.vue | `<Pill tone="danger" data-testid="rlp-status">` | V |
| `.rlp-error-box`        | RawLlmExchangePanel.vue | `<Card tone="danger" role="alert" data-testid="rlp-error-box">` | V + A |
| `.rlp-redaction-banner` | RawLlmExchangePanel.vue | `<Card tone="warn" data-testid="rlp-redaction-banner">` | V |
| panel body              | RawLlmExchangePanel.vue | `<Card>` containing two `<CodeBlock>`s + `<PanelHeading level="3">` | V |

### 4.10 AnalystChatPanel + AnalystToaster

| old selector | owning file | replacement | impact |
| --- | --- | --- | --- |
| `.primary-btn`          | [chat/AnalystChatPanel.vue](../../../../web/src/components/chat/AnalystChatPanel.vue) | `<Button variant="primary" data-testid="analyst-send">` | V + B |
| `.tool-chip*` (entire family in this file) | AnalystChatPanel.vue | `<ToolChip>` composite | V + B |
| `.tool-chip-tag`/`.pending-tool-tag` | AnalystChatPanel.vue | `<Pill tone="accent\|danger">` inside `ToolChip` | V |
| `.pending-tool-main`/`.pending-tool-meta` | AnalystChatPanel.vue | rendered by `ToolChip` with status='pending' | V + B |
| `.message-bubble` / `.msg.role-*` / `.msg-meta` / `.msg-content` | AnalystChatPanel.vue | `<MessageBubble>` | V |
| `.on-screen-children`   | AnalystChatPanel.vue | layout-only inside `<Card>` | V |
| `.analyst-toaster`/`.toast` | [chat/AnalystToaster.vue](../../../../web/src/components/chat/AnalystToaster.vue) | `<Card tone="…">` per toast, no new primitive (see §6.8) | V + A |
| `.analyst-chip`         | AnalystToaster.vue (referenced by `app-shell-persistent-panel.test.ts`) | `<Pill>` | V |
| `.chat-body`/`.chat-composer`/`.composer-footer`/`.composer-input` | AnalystChatPanel.vue | layout-only scoped classes | V |

### 4.11 Cards surface

| old selector | owning file | replacement | impact |
| --- | --- | --- | --- |
| `.nav-pill`             | [cards/CardDetailView.vue](../../../../web/src/components/cards/CardDetailView.vue) | `<Pill as="button" :aria-pressed=…>` (see §6.5) | V + B + A |
| `.retry-btn`            | CardDetailView.vue | `<Button data-testid="retry-btn">` | V + B |
| `.discuss-btn`          | CardDetailView.vue | `<Button data-testid="discuss-btn">` | V + B |
| `.detail-status-chip`   | CardDetailView.vue | `<Pill tone="…">` | V |
| `.detail-type-badge`    | CardDetailView.vue | `<Pill>` (default tone) | V |
| `.badge`/`.badge.warning`/`.badge.error` | CardDetailView.vue | `<Pill tone="warn\|danger">` | V |
| `.child-row`            | CardDetailView.vue | `<Card>` row | V |
| `.card-header-row`/`.card-meta`/`.card-id-path`/`.card-title`/`.card-summary-bars`/`.card-tag`/`.card-tag-more`/`.card-tags`/`.card-deps`/`.card-priority`/`.card-type-icon`/`.card-children-listing`/`.card-children-section` | CardDetailView.vue | layout-only inside `<Card>` and `<Pill>` compositions | V |
| `.board-card`/`.board-column`/`.board-columns`/`.board-container`/`.board-empty` | [cards/CardsBoardView.vue](../../../../web/src/components/cards/CardsBoardView.vue) | `<Card>` + layout-only scoped grid | V |
| `.column-header`/`.column-title`/`.column-dot`/`.column-count`/`.column-cards` | CardsBoardView.vue | `<PanelHeading level="3">` + `<StatusDot>` + `<Pill>` | V |
| `.col-metric`/`.col-rank`/`.col-score`/`.col-title`/`.col-type` (leaderboard) | [cards/CardsLeaderboardView.vue](../../../../web/src/components/cards/CardsLeaderboardView.vue) | layout-only table; status pills become `<Pill>` | V |
| `.node-title`/`.node-children` | [cards/CardsTreeView.vue](../../../../web/src/components/cards/CardsTreeView.vue) | layout-only tree; rows are `<Card>` | V |
| `.filter-chip`          | [cards/CardHistoryPanel.vue](../../../../web/src/components/cards/CardHistoryPanel.vue) | `<Pill as="button" :aria-pressed="analystOnly" data-testid="filter-chip">` | V + B + A |
| `.analyst-badge`        | CardHistoryPanel.vue | `<Pill tone="accent" data-testid="analyst-badge">` | V |
| stale ribbon            | [cards/StaleWarningRibbon.vue](../../../../web/src/components/cards/StaleWarningRibbon.vue) | `<Card tone="warn">` | V |

### 4.12 Catch-all (selector families the reviewer enumerated explicitly)

For completeness, the reviewer required: every `.tc-*`, `.tr-*`,
`.conv-*`, `.primary-btn`, `.console-button`, `.token-btn*`,
`.retry-btn`, `.discuss-btn`, `.stab`, `.refresh-btn`,
`.panel-refresh-btn`, `.rlp-refresh`, `.sv-fetch-btn`. All are in the
matrix above. The `.console-button` and `.stab` selectors do not
appear in current v3 grep output — they are listed only because the
reviewer mentioned them; the matrix tolerates absence.

### 4.13 Selectors that survive (allowed as layout-only)

Some scoped class names survive but lose all colour/border/radius;
they keep only `display/grid/flex/gap/padding/position`. Examples
(non-exhaustive): `.dashboard-layout`, `.agents-layout`,
`.agents-content`, `.board-columns`, `.cards-layout`, `.debug-layout`,
`.workspace-content`, `.app-shell`, `.nav-rail`, `.chat-body`,
`.chat-composer`, `.composer-input`, `.composer-footer`,
`.card-detail-container`, `.column-cards`, `.file-list`,
`.file-panel`, `.file-viewer`, `.viewer-state`, `.crumb*`,
`.actionable-*`, `.csb-*`, `.cards-toolbar`. None of these are
pattern classes; they are surface-local layout classes.

---

## 5. Selector / test migration plan

Existing tests under [web/src/__tests__/](../../../../web/src/__tests__/)
assert against the old selectors. Per project guideline they are
**rewritten**, not aliased. The plan is:

### 5.1 Three rewrite categories

- **(a)** Add `data-testid` on the primitive's root element whenever
  the test is **behavioral** (click, trigger, value entry). The
  `data-testid` value matches the old class name minus the leading
  dot (e.g. `.primary-btn` → `data-testid="analyst-send"` — see
  matrix; we use semantic ids not bespoke-class ids). Tests then
  query with `wrapper.get('[data-testid="analyst-send"]')`.
- **(b)** Move pattern-class assertions into **primitive unit tests
  only**. Surface tests stop asserting `.btn` / `.pill` / `.card`.
  Primitive unit tests under `web/src/__tests__/ui/`,
  `web/src/__tests__/content/`, `web/src/__tests__/conversation/`
  cover prop → emitted class mapping.
- **(c)** Behavioral surface tests use **role/text queries** where
  natural (`getByRole('button', { name: /Send/ })`), falling back to
  `data-testid` when the element has no native role/name.

### 5.2 Affected test files (from grep over `wrapper.find/findAll/get('.…')`)

| Test file | Selectors to rewrite | Rewrite strategy |
| --- | --- | --- |
| [app-shell-auth-banner.test.ts](../../../../web/src/__tests__/app-shell-auth-banner.test.ts) | `.auth-required-banner`, `.auth-banner-action`, `.auth-banner-dismiss`, `.token-overlay`, `.token-btn-cancel` | (a) `data-testid="auth-required-banner"`, `data-testid="auth-banner-action"`, `data-testid="auth-banner-dismiss"`, `[role="dialog"]` (Overlay), `data-testid="token-cancel"` |
| [analyst-chat-panel.test.ts](../../../../web/src/__tests__/analyst-chat-panel.test.ts) | `button.primary-btn`, `.tool-chip`, `.code-block` | (a) `data-testid="analyst-send"`; (c) `data-testid="tool-chip"` from ToolChip composite; `.code-block` survives as pattern class but assertion moves to checking via `CodeBlock` testid `data-testid="code-block"` |
| [analyst-toaster.test.ts](../../../../web/src/__tests__/analyst-toaster.test.ts) | `.analyst-toaster`, `.toast` | (a) `data-testid="analyst-toaster"`, `data-testid="toast"` |
| [agents-view.test.ts](../../../../web/src/__tests__/agents-view.test.ts) | `.conv-tb-btn`, `.tool-call`, `.tool-result`, `.code-block`, `.agents-empty`, `.agents-unauthorized`, `.agents-stale`, `.session-card`, `.detail-header-bar`, `.msg-link` | (a) `data-testid="raw-llm-toggle"`, `data-testid="conv-status"`, `data-testid="tool-chip"`, `data-testid="session-card"`, `data-testid="agents-empty\|agents-unauthorized\|agents-stale"`; `.code-block` and `.msg-link` survive |
| [raw-llm-exchange-panel.test.ts](../../../../web/src/__tests__/raw-llm-exchange-panel.test.ts) | `.rlp-refresh`, `.rlp-tabs`, `.rlp-tab`, `.rlp-error-box`, `.rlp-status--error`, `.rlp-redaction-banner` | (a) all become `data-testid="rlp-refresh"`, `data-testid="rlp-tab"` with `data-active`, `data-testid="rlp-error-box"`, `data-testid="rlp-status"` |
| [api-token-entry.test.ts](../../../../web/src/__tests__/api-token-entry.test.ts) | `.token-overlay`, `.token-dialog`, `.token-btn-save\|clear\|cancel`, `.token-toggle` | (a) `[role="dialog"]`, `data-testid="token-save\|clear\|cancel"`, `data-testid="token-toggle"` |
| [files-view.test.ts](../../../../web/src/__tests__/files-view.test.ts) | `.files-global-banner.banner-error`, `.file-panel`, `.file-list`, `.file-entry`, `.viewer-state`, `.code-block`, `.file-viewer`, `.entry-icon` | (a) `data-testid="files-global-banner"` with `data-tone`; layout classes survive; `.code-block` survives |
| [dashboard-view.test.ts](../../../../web/src/__tests__/dashboard-view.test.ts), [dashboard-child-order.test.ts](../../../../web/src/__tests__/dashboard-child-order.test.ts) | `.refresh-btn`, `.runtime-banner.banner-*`, `.actionable-error`, `.status-section`, `.status-grid`, `.section-label`, `.dc-*`, `.csb-*` | (a) `data-testid="dashboard-refresh"`, `data-testid="runtime-banner"`, `data-testid="actionable-error"`; pure layout classes survive |
| [debug-view.integration.test.ts](../../../../web/src/__tests__/debug-view.integration.test.ts) and the four sibling debug-view tests | `.debug-tab`, `.debug-tab-content`, `.debug-section`, `.debug-section-title`, `.debug-loading`, `.debug-error`, `.debug-empty`, `.dg-item`, `.mcp-server-badge`, `.mcp-server-transport`, `.mcp-tool-count`, `.mcp-stats-*`, `.mcp-stat-success\|error`, `.mcp-tool-card`, `.mcp-tool-desc`, `.sv-stat-card`, `.sv-pill.risk-*`, `.sv-pill-kind`, `.sv-review-item`, `.sv-q-item`, `.sv-q-browse-btn`, `.doctor-status-banner`, `.doctor-check-item` | (a) every selector gets a corresponding `data-testid`; risk and tab-active state via `data-state`/`data-active`/`data-risk` data-attrs on the new primitive |
| [card-detail-view.test.ts](../../../../web/src/__tests__/card-detail-view.test.ts), [card-detail-view-child-order.test.ts](../../../../web/src/__tests__/card-detail-view-child-order.test.ts) | `.nav-pill`, `.retry-btn`, `.discuss-btn`, `.detail-status-chip`, `.detail-type-badge`, `.badge.warning\|error`, `.child-row`, `.card-*` family | (a) testids on each primitive; layout classes survive |
| [card-history-panel*.test.ts](../../../../web/src/__tests__/) | `.filter-chip`, `.analyst-badge` | (a) `data-testid="filter-chip"` + `aria-pressed`; `data-testid="analyst-badge"` |
| [cards-view.test.ts](../../../../web/src/__tests__/cards-view.test.ts), [cards-tree-view-order.test.ts](../../../../web/src/__tests__/cards-tree-view-order.test.ts) | `.node-title`, `.board-card`, `.column-title` | (c) text/role queries where possible; testids where not |
| [workspace-header.test.ts](../../../../web/src/__tests__/workspace-header.test.ts) | `.ws-chip`, `.runtime-chip`, `.pause-chip` | (a) `data-testid="ws-chip"`, `data-testid="runtime-chip"`, `data-testid="pause-chip"` on the `<Pill>` |
| [nav-rail.test.ts](../../../../web/src/__tests__/nav-rail.test.ts) | `.api-token-btn`, `.nav-rail` | (a) `data-testid="api-token-btn"`; `.nav-rail` survives |
| [code-block.test.ts](../../../../web/src/__tests__/code-block.test.ts) | `.highlighting-disabled` | (b) becomes part of `CodeBlock`'s own unit test under `__tests__/content/CodeBlock.test.ts`; selector stays internal |
| [stale-warning-ribbon.test.ts](../../../../web/src/__tests__/stale-warning-ribbon.test.ts) | bespoke ribbon classes | (a) `data-testid="stale-warning-ribbon"` |
| [components/AnalystChatPanel.children.test.ts](../../../../web/src/__tests__/components/AnalystChatPanel.children.test.ts) | `.on-screen-children` | survives as layout-only; assertion unchanged |
| [app-shell-persistent-panel.test.ts](../../../../web/src/__tests__/app-shell-persistent-panel.test.ts) | `.nav-rail`, `.workspace-content`, `.analyst-chip` | first two survive; (a) `data-testid="analyst-chip"` |
| [markdown-text.test.ts](../../../../web/src/__tests__/markdown-text.test.ts) | internal | no change (becomes `__tests__/content/MarkdownText.test.ts`) |

### 5.3 New primitive/content/conversation unit tests

The convention:

- `web/src/__tests__/ui/Button.test.ts`, `Pill.test.ts`, `Card.test.ts`,
  `PanelHeading.test.ts`, `StatusDot.test.ts`, `Overlay.test.ts`,
  `Spinner.test.ts`.
- `web/src/__tests__/content/CodeBlock.test.ts`, `MarkdownText.test.ts`,
  `JsonView.test.ts`, `FormattedContent.test.ts`.
- `web/src/__tests__/conversation/MessageBubble.test.ts`,
  `ToolChip.test.ts`, `DiagnosticRow.test.ts`, `RoundCard.test.ts`,
  `PendingCallFooter.test.ts`, `CompactedCluster.test.ts`,
  `ThinkingDots.test.ts`.

Each unit test covers prop → emitted class mapping, slot rendering,
event emission, ARIA attributes. **Pattern-class assertions live
here and only here.** Surface tests no longer assert `.btn`, `.pill`,
`.card`; they assert behavior via role/text/testid.

### 5.4 Overlay test contract (specific)

Required cases in `Overlay.test.ts`:

- Escape key closes once (not twice when AppShell also listens).
- Backdrop click closes when `closeOnBackdrop !== false`; does not
  close otherwise.
- Focus moves to the first focusable descendant on `open` transition
  (initialFocus default).
- Tab from the last focusable wraps to the first; Shift+Tab from the
  first wraps to the last.
- Focus is restored to the previously focused element when `open`
  flips false.
- Body gets `data-modal-open="true"` while open; AppShell's
  shortcuts are suppressed (see §9).
- Background is `inert` (siblings of the dialog host) while open.

### 5.5 ToolChip test contract

- `aria-expanded` reflects `expanded`.
- `aria-controls` matches the rendered details panel id.
- Clicking the header `Button` emits `toggle`.
- Status class mapping: each of `call|ok|error|pending` produces the
  expected `<Card>` tone (`accent|accent|danger|warn`).
- Default slot `details` only renders when `expanded`.
- `view.detail` renders inside a `<Pill>` with the configured tone.

---

## 6. Duplicated idioms — coverage

### 6.1 Auth banner

Composition (not a new primitive):

```vue
<Card tone="danger" role="alert" data-testid="auth-required-banner">
  <span>API token required to use Saivage.</span>
  <Pill tone="danger">read-only</Pill>
  <Button data-testid="auth-banner-action" @click="openOverlay">Enter token</Button>
  <Button icon-only aria-label="Dismiss" data-testid="auth-banner-dismiss" @click="dismiss"><X /></Button>
</Card>
```

The `Card + Pill + Button` trio recurs in `WorkspaceHeader` (read-only
state), `AppShell` (token-required strip), and `RawLlmExchangePanel`
(redaction banner). No `Banner` primitive is added; this is just
composition.

### 6.2 Status chips

The convention is **two adjacent primitives**, not a new composite:

```vue
<span class="status-chip">
  <StatusDot tone="ok" />
  <Pill tone="accent">Running</Pill>
</span>
```

We do **not** introduce a `StatusChip` composite, even though the
pattern repeats in ten+ places. Reasons:

- The composition is two lines of markup and zero behavior. A
  composite would hide the Pill tone behind a derived prop, making
  custom labels and additional pill content (counts, durations)
  awkward.
- Surfaces that combine the dot with a `<RouterLink>` or a
  non-pill text label (e.g. NavRail) would not fit a `StatusChip`
  signature.

The `.status-chip` wrapper is a surface-local layout class (flex,
gap: 6px). It is not a pattern class.

### 6.3 Refresh / icon buttons

Convention: `<Button icon-only :aria-label="…"><Icon /></Button>`.
The `iconOnly` prop sets `min-width: 32px; padding: 0` via the
`Button` SFC's scoped style. The icon comes from `lucide-vue-next`,
imported by the caller. No new pattern class.

Affected selectors: `.refresh-btn`, `.panel-refresh-btn`,
`.rlp-refresh`, `.sv-fetch-btn`, `.viewer-close-btn`,
`.auth-banner-dismiss`, `.token-toggle`, `.api-token-btn`, plus every
icon-only invocation under cards/* (close, retry, expand).

### 6.4 Spinner / loading state

Convention: a state-panel composition.

```vue
<Card class="state-panel" data-testid="loading">
  <Spinner aria-hidden="true" />
  <span>Loading workspace state…</span>
</Card>
```

The `.state-panel` class is **not** a pattern class. It is a
surface-local layout class (flex, gap, centered). The `<Card>`
provides the background; `<Spinner>` provides the icon; the span
provides the accessible name. The Spinner is `aria-hidden` because
the visible text already names the state.

Loading places: `DashboardView`, `AgentsView`, `CardsView`,
`DebugView`, `FilesView`, `RawLlmExchangePanel`, `CardHistoryPanel`.

### 6.5 Navigation / tabs

**Decision: a documented `.pill[as="button"][aria-pressed="true"]`
convention, not a new `Tabs` primitive.** Reasoning:

- Tabs in v3 are a horizontal row of pill-shaped buttons that toggle
  a single active state. The behavior is just `aria-pressed` plus
  `role="tab"`/`role="tablist"`/`role="tabpanel"` markup contributed
  by the caller (AgentConversationView's view selector, DebugView's
  category tabs, RawLlmExchangePanel's request/response tabs,
  CardDetailView's `.nav-pill` row, CardsView's view switcher).
- `Pill` already supports `as="button"` and `ariaPressed`. The
  visual "active" state is expressed by a surface-local rule
  reading `--accent` — one line of CSS per surface, or one shared
  selector `.tablist .pill[aria-pressed="true"]` in `patterns.css`.
- A `Tabs` primitive would need to own keyboard navigation
  (`ArrowLeft`/`ArrowRight`), focus management, and selection state
  syncing — duplicating logic each consumer already implements
  inside its store. None of the consumers want that loss of
  control.

We add **one** F02 extension to patterns.css if needed:
`.tablist > .pill[aria-pressed="true"] { border-color: var(--accent); color: var(--accent); }`.
This is the only place in F02 where a pattern rule targets an ARIA
attribute selector.

NavRail's left rail links are not tabs (they are router-driven, full
block links); they keep their own surface styling and do **not**
consume `Pill`.

### 6.6 Callouts / banners / state panels

All become `<Card tone="…">`. Tone selection table:

| state               | tone     |
| ------------------- | -------- |
| error / failure / actionable | `danger` |
| warning / stale / redacted   | `warn`   |
| success / running   | `accent` |
| diagnostic          | `purple` |
| info / informational| default  |

This collapses `.runtime-banner`, `.error-banner`, `.actionable-error`,
`.files-global-banner`, `.operator-banner-*`, `.debug-error`,
`.debug-empty`, `.doctor-status-banner`, stale ribbon,
`.rlp-error-box`, `.rlp-redaction-banner`, `.viewer-state` into one
mechanism. No `Banner` / `Callout` / `StatePanel` primitive added.

### 6.7 Form controls (textarea, input, select)

**Excluded from F02.** Reasoning:

- v2's `patterns.css` does not define `.input`/`.textarea`/`.select`;
  the v2 chat composer styles its own textarea inline. There is
  nothing to port for form primitives.
- v3 has at most three textareas (analyst composer, API token entry,
  card discuss form) and zero shared selects. Wrapping native
  `<input>`/`<textarea>` for three call sites would be premature.
- Form controls retain their layout-local scoped styles, which after
  F01 use `var(--surface-2)`/`var(--border)` only.

If future surfaces need a shared form primitive, it is a separate
issue.

### 6.8 Toaster / list-row surfaces

Toaster: `<Card tone="…">` per toast, layout-only `.analyst-toaster`
wrapper around them. No `Toast` primitive — each toast is a one-off
composition of Card + (optional) Pill + (optional) Button.

List rows (file list, debug stats rows, card children): `<Card>` rows
where state matters; layout-only `<li>` / `<div>` rows where it
does not. No `ListRow` primitive.

---

## 7. Transversal impact

**Container components retain data / routing / store / WebSocket
responsibility; only their visual scoped CSS is removed.** Reviewer
R1.§6 was correct that r1 mis-framed them as "pure layout shells".
The correct framing is:

> Each container keeps every Pinia/router/WS line it has today. F02
> removes the colour/border/radius from its scoped `<style>` block,
> replaces bespoke selectors with primitive + pattern composition,
> and otherwise leaves the file untouched.

After F02 the only `<style scoped>` declarations allowed in
container files are `display`, `grid-*`, `flex-*`, `gap`, padding
for pure spacing, `position`, `min/max-{width,height}`, `inset`,
`z-index`. Forbidden: any `color`, `background`, `border` (except
`border: none` resets), `border-radius`, hex literals,
pattern-class redefinition.

### 7.1 DashboardView sub-surface families

[views/DashboardView.vue](../../../../web/src/views/DashboardView.vue) breaks into:

- Runtime console header: `<PanelHeading level="2">` + refresh
  `<Button icon-only>`.
- Runtime banner row: `<Card tone="danger|warn">` per state.
- Actionable error block: `<Card tone="danger" role="alert">` with
  title `<h3>` + message + next-action + meta children.
- Status grid: layout-only grid; key/value pairs use plain `<span>`s.
- Child-of-goal panel: `<Card>` listing rows; each row is
  `<Card>` + `<Pill>` (status), `<Pill>` (type), `<Pill>` (priority).
- Cue chips: `<Pill tone="warn|accent|…">`.
- Summary bars: layout-only progress markup.

### 7.2 FilesView sub-surface families

[views/FilesView.vue](../../../../web/src/views/FilesView.vue) breaks into:

- File panels (two — tree + viewer): layout-only `.file-panel`.
- Global banner: `<Card tone="danger|warn">` (stale, unauthorized,
  permission).
- Breadcrumbs: layout-only `.crumb*`.
- File list rows: layout-only `<li>` with `aria-current` on the
  selected row.
- Viewer state (preview blocked, not found, denied):
  `<Card tone="warn">` per state.
- Viewer body: `<CodeBlock>` or `<MarkdownText>`.
- Quarantine footer: `<Button icon-only>` for fetch action.

### 7.3 DebugView sub-surface families

[views/DebugView.vue](../../../../web/src/views/DebugView.vue) breaks into:

- Tab row: row of `<Pill as="button" :aria-pressed>` (see §6.5).
- Operator banner: `<Card tone="danger|warn">`.
- Per-tab section: `<PanelHeading level="3">` + content.
- Loading / error / empty: state-panel `<Card>` per §6.4.
- MCP grid: `<Card>` items; server badges become `<Pill tone="accent">`;
  transport pills become `<Pill>`; tool count becomes `<Pill tone="accent">`.
- Supervision section: stat cards `<Card>` + numeric layout; risk
  pills `<Pill tone="accent|danger">`; kind pills `<Pill tone="purple">`.
- Doctor section: status banner `<Card tone="warn|danger">`; check
  items `<Card>` rows with `<StatusDot>` per check.
- Process section: `<Card>` rows; process-link `<Button>`.
- Fetch button: `<Button icon-only>`.

### 7.4 v2 cross-check (StatusPanel, PlanView, AgentsView, ChatWindow)

The v2 components named by the reviewer inform F02 thus:

- [saivage/web/src/components/StatusPanel.vue](../../../../../saivage/web/src/components/StatusPanel.vue) — its
  metric/queue/stage-row idioms are the model for DashboardView's
  status grid and DebugView's stat cards. Both surfaces collapse
  onto `<Card>` + `<Pill>` + `<StatusDot>` per the rules above.
- [saivage/web/src/components/PlanView.vue](../../../../../saivage/web/src/components/PlanView.vue) — stage
  rows are the model for `RoundCard` (F03) and for DashboardView's
  child-of-goal panel.
- [saivage/web/src/components/AgentsView.vue](../../../../../saivage/web/src/components/AgentsView.vue) and
  [saivage/web/src/components/ChatWindow.vue](../../../../../saivage/web/src/components/ChatWindow.vue) — message
  bubble + composer + thinking dots; consumed by F03's grouping
  spec, and inform `MessageBubble` / `ThinkingDots` / `Spinner` here.
- [saivage/web/src/components/FormattedContent.vue](../../../../../saivage/web/src/components/FormattedContent.vue) and
  [saivage/web/src/components/JsonHighlight.vue](../../../../../saivage/web/src/components/JsonHighlight.vue) — direct
  ports under `content/` (§1).

---

## 8. Alternatives considered

### 8.1 CSS-class-only (no Vue wrappers)

Port F01 patterns and rewrite templates to use raw classes:
`<button class="btn btn-primary">Send</button>`,
`<span class="pill pill-warn">…</span>`.

Rejection reasons:

- **No typed API.** Vue's compile-time prop typing catches
  `variant="dnger"` typos. Class-string concatenation does not.
- **Slot ergonomics.** `PanelHeading`'s three named slots
  (`title`/`meta`/`actions`) and `ToolChip`'s `details` slot are
  expressed naturally as Vue slots; replicating them in raw markup
  forces every consumer to repeat the layout's flex/grid scaffolding.
- **Props-driven ARIA.** `Overlay`'s focus-trap, `Button`'s
  `aria-label`, `ToolChip`'s `aria-expanded`/`aria-controls`
  contracts are easy to centralise in a wrapper and inconsistent in
  raw markup.
- **Composite logic.** `ToolChip` (status mapping, expansion state,
  details panel) and `MessageBubble` (role→tone mapping) are not
  expressible as class strings; they need a component.

CSS-class-only would also reintroduce the drift problem v3 has today
in a slightly nicer-looking form (one canonical class instead of
five, but still no place to attach behavior).

### 8.2 Thin Vue wrappers (the selection)

Each `ui/` primitive is a 15-to-60-line SFC that emits pattern
classes and exposes a typed prop API. `content/` and `conversation/`
add the small amount of behavior the primitives cannot express.

Strengths:

- Typed API (`Button.variant: 'primary' | 'danger' | 'default'`).
- Slot ergonomics (`<PanelHeading><template #actions>…`).
- ARIA centralised (`Overlay` owns focus trap, `Button` owns
  `aria-label`, `StatusDot` owns `aria-hidden`/`role="img"` logic).
- Zero new dependencies; the pattern stylesheet is the design
  source.
- One source of truth per pattern; F01 changes flow through to all
  consumers automatically.

Cost: thirteen small SFCs plus seven small composites. Roughly the
same line count as the current scoped styles, but consolidated.

### 8.3 Headless dialog/tabs library (radix-vue, headlessui-vue, reka-ui)

Considered for `Overlay` and `Tabs` only — the two surfaces where
ARIA correctness is hardest to hand-roll.

- `radix-vue` (now `reka-ui`): provides `Dialog`, `Tabs`, accordion,
  focus trap, escape handling, inert siblings. ~30 KB minified.
- `@headlessui/vue`: similar surface, smaller. `Dialog` is
  accessible, well-tested.

Rejection (for `Tabs`): §6.5 already shows we don't need a tab
primitive. Adding a library to express
`<Pill as="button" :aria-pressed>` is overkill.

Rejection (for `Overlay`): the hand-roll is approximately 60 lines
including focus trap (see §9). The dependency cost (added bundle,
upgrade discipline, API churn, training cost) exceeds the
maintenance cost of 60 lines we control. **However**, this is the
only place where the trade-off is genuinely close. If during
implementation we find a corner case (e.g. nested overlays,
portal'd menus inside a dialog), the fallback is `radix-vue`'s
`<Dialog>` alone, leaving every other primitive untouched. We do
not pre-commit to that fallback.

Decision: hand-roll `Overlay`, no library.

---

## 9. `Overlay` accessibility strategy

**Choice: hand-roll with explicit focus trap.** No library.

### 9.1 Behavior

- **Open transition:** when `open` goes false→true, record
  `document.activeElement` as `previouslyFocused`. After Vue's next
  tick, set focus to the first focusable descendant of the dialog
  (matches selector
  `'[autofocus], button:not([disabled]), [href], input:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'`).
  If `initialFocus === 'container'`, focus the dialog root with
  `tabindex="-1"` instead.
- **Tab cycling:** keydown listener on the dialog root. On `Tab`
  from the last focusable, prevent default and focus the first. On
  `Shift+Tab` from the first focusable, prevent default and focus
  the last.
- **Escape close:** keydown listener on the dialog root catches
  `Escape`, emits `close`, calls `event.stopPropagation()` so
  AppShell's window listener does not see it.
- **Backdrop close:** when `closeOnBackdrop !== false`, click on the
  `.overlay` element itself (not its children) emits `close`.
  Implemented as `@click.self="onBackdrop"`.
- **Inert background:** while open, the dialog sets
  `inert` on every direct child of `<body>` that is not the
  Teleport target. This is one line at open/close time. Modern
  browsers support `inert`.
- **Focus restoration:** when `open` goes true→false, restore focus
  to `previouslyFocused` (guarded against the element being detached).

### 9.2 AppShell shortcut suppression

[web/src/components/layout/AppShell.vue](../../../../web/src/components/layout/AppShell.vue)
installs a window-level keydown listener for global shortcuts. While
an Overlay is open, those shortcuts must not fire.

Mechanism (single source of truth):

- `Overlay.vue` on open: `document.body.dataset.modalOpen = 'true'`.
- `Overlay.vue` on close: `delete document.body.dataset.modalOpen`.
- `AppShell.vue`'s keydown handler short-circuits at the top:
  ```ts
  function handleKeydown(event: KeyboardEvent) {
    if (document.body.dataset.modalOpen === 'true') return;
    // existing logic
  }
  ```

Alternative considered: inspect `event.composedPath()` for a
`[role="dialog"]` element. Rejected because it is more code, slower,
and brittle to nested portals. The `data-modal-open` flag is one
line at each end and is easy to reason about.

### 9.3 Multiple overlays

If a second overlay opens on top of the first (rare; only the API
token entry overlapping a future confirm dialog), the flag remains
`true` for both. Each overlay's `close` removes the flag only when
no other overlay is open. Implementation: a module-level counter in
`Overlay.vue`:

```ts
let openCount = 0;
function onOpen() {
  if (openCount === 0) document.body.dataset.modalOpen = 'true';
  openCount++;
}
function onClose() {
  openCount = Math.max(0, openCount - 1);
  if (openCount === 0) delete document.body.dataset.modalOpen;
}
```

### 9.4 Test coverage

Covered by §5.4 Overlay test contract.

---

## 10. Non-goals

Explicitly out of scope:

- No headless-UI library (decision in §8.3).
- No Tailwind / UnoCSS / Windi.
- No theme switcher.
- No Pinia-store refactor; stores stay byte-identical.
- No router changes.
- No WebSocket protocol changes; F02 is presentation-only.
- No icon-set change; `lucide-vue-next` stays.
- No animation framework; reuse Vue `<Transition>`.
- No barrel `index.ts` under `ui/`, `content/`, or `conversation/`;
  Vue SFCs need explicit paths and a barrel breaks tree-shaking.
- No backward-compatibility shims; every selector in §4 is **deleted
  in the same commit** that introduces its replacement.

---

## 11. Expected file outcomes (informational)

- New SFCs:
  - `ui/`: Button, Pill, Card, PanelHeading, StatusDot, Overlay, Spinner (7).
  - `content/`: CodeBlock (relocated), MarkdownText (relocated), JsonView (new from v2), FormattedContent (new from v2) (4).
  - `conversation/`: MessageBubble, ToolChip, DiagnosticRow, ThinkingDots, RoundCard, PendingCallFooter, CompactedCluster (7).
- Modified: every container in §4 plus every test file in §5.2.
- Deleted: [web/src/components/code/](../../../../web/src/components/code/) directory; every bespoke class in §4 (no aliases).
- Tests: new `__tests__/ui/*.test.ts`, `__tests__/content/*.test.ts`,
  `__tests__/conversation/*.test.ts`; existing surface tests rewritten
  per §5.

Exact migration commit order belongs in `02-design-r2.md` / `03-plan-r2.md`.
