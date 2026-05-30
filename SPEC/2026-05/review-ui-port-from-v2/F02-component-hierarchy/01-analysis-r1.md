# F02 — Component hierarchy / UI primitive layer — Functional analysis (r1)

Writer round 1. Pre-review. Bound by the workspace project guideline:
architecture-first, no backward compatibility. Bespoke v3-only class
names listed below are to be **removed**, not aliased.

This is a functional analysis: inventory, API shape, directory layout,
container-component contract, risks. The implementation plan lives in
sibling `02-design-r1.md` / `03-plan-r1.md` (out of scope here).

Companion files:
[F02-component-hierarchy.md](../F02-component-hierarchy.md),
[00-SUBSYSTEM-MAP.md](../00-SUBSYSTEM-MAP.md),
[F01-design-tokens.md](../F01-design-tokens.md).

---

## 1. Why a primitive layer is needed

v3 has zero UI primitives. Every surface re-implements the same
idioms inline in scoped `<style>`, with slightly different class
names, markup, paddings, and hex colors. N copies of "a button", N
copies of "a status badge", N copies of "a tool chip", no single
place to change any of them.

### 1.1 Duplicated button styles

The same "small dark button with a 1px border" exists under at least
five different class names, each defined locally:

- `.conv-tb-btn` in [agents/AgentConversationView.vue](../../../web/src/components/agents/AgentConversationView.vue#L205) hard-codes `background:#21262d; border:1px solid #30363d; color:#c9d1d9`.
- `.primary-btn` in [chat/AnalystChatPanel.vue](../../../web/src/components/chat/AnalystChatPanel.vue#L252) is defined twice (lines 252 and 410); second block overrides the first.
- `.auth-banner-action` / `.auth-banner-dismiss` in [layout/AppShell.vue](../../../web/src/components/layout/AppShell.vue#L217) re-tint to `color:#58a6ff`.
- `.retry-btn`, `.discuss-btn`, `.nav-pill`, `.child-row` in [cards/CardDetailView.vue](../../../web/src/components/cards/CardDetailView.vue).
- `.token-btn`, `.token-btn-save`, `.token-btn-clear`, `.token-btn-cancel`, `.token-toggle` in [auth/ApiTokenEntry.vue](../../../web/src/components/auth/ApiTokenEntry.vue) — five button styles in one file.

v2 collapses all into `.btn` / `.btn-primary` / `.btn-danger` in
[saivage/web/src/styles/patterns.css](../../../../saivage/web/src/styles/patterns.css#L46)
(F01 ports this). The Vue-side layer v2 lacks, and v3 must add, is a
`<Button>` component so surfaces write `<Button variant="primary">Send</Button>`.

### 1.2 Duplicated pill / badge / tag styles

Reinvented at least four times:

- `.conv-status-badge.s-{active,waiting,done,blocked,failed}` in [agents/AgentConversationView.vue](../../../web/src/components/agents/AgentConversationView.vue#L198-L203) — five hard-coded bg/fg pairs.
- `.tool-chip-tag`, `.pending-tool-tag` in [chat/AnalystChatPanel.vue](../../../web/src/components/chat/AnalystChatPanel.vue#L331).
- `.detail-type-badge` (per-type), `.detail-status-chip` (per-status), `.badge`, `.badge.warning`, `.badge.error`, `.nav-pill` in [cards/CardDetailView.vue](../../../web/src/components/cards/CardDetailView.vue) — four pill families in one file.

v2 collapses all into `.pill`, `.pill-accent`, `.pill-warn`,
`.pill-danger`, `.pill-purple`. v3 should expose `<Pill tone="warn">…</Pill>`.

### 1.3 Duplicated tool-chip implementations

The "tool call/result row with icon + name + headline + caret"
exists twice with disjoint CSS: AgentConversationView's `.tc-*`/`.tr-*`
family (`tc-header`, `tc-toggle`, `tc-tool`, `tc-icon`, `tc-name`,
`tc-headline`, `tc-detail`, `tc-time`) and AnalystChatPanel's
`.tool-chip-{row,icon,name,headline,tag,caret}` plus status modifiers
`.tool-chip-{call,ok,error}` and the `.pending-tool-{main,meta}` pair.
Both consume the same `tool-presenters` utility but render with
different paddings. Worst single case of drift in the codebase.

### 1.4 Duplicated panel headings, status dots, overlays

- `.panel-heading` only exists in v2 ([patterns.css](../../../../saivage/web/src/styles/patterns.css#L168)); in v3 every panel re-implements its header (`.conv-header` in AgentConversationView, the chat heading in AnalystChatPanel, WorkspaceHeader's bespoke top bar, per-view `<header>` blocks in every `cards/*` file).
- Connection/liveness dots are open-coded in AppShell, NavRail, WorkspaceHeader, AnalystChatPanel, CardsBoardView. v2's `.status-dot` is one class plus a tone token.
- [auth/ApiTokenEntry.vue](../../../web/src/components/auth/ApiTokenEntry.vue#L151) defines its own `.token-overlay { position: fixed; inset: 0; … }` + `.token-dialog`; [agents/RawLlmExchangePanel.vue](../../../web/src/components/agents/RawLlmExchangePanel.vue) defines its own drawer scaffolding. v2 standardises `.overlay`; v3 wraps it as `<Overlay>`.

### 1.5 Conclusion

~30 places in v3 web duplicate the same visual. Without a primitive
layer, F01 (semantic tokens) is necessary but insufficient: components
would still re-implement the same compositions of those tokens. The
primitive layer turns "every component owns its own design system"
into "every component composes shared primitives".

---

## 2. Primitive inventory

All primitives live under `web/src/components/ui/`. Thin Vue SFCs:
typed `<script setup lang="ts">`, a `<template>` that renders
canonical markup using v2 pattern classes (F01), and a `<style
scoped>` restricted to positioning — never colors, borders, or radii.

Primitives MUST NOT import any Pinia store, router, or fetch /
WebSocket client. They take props and emit events.

### 2.1 `Button.vue`

Path: `web/src/components/ui/Button.vue`. Emits: `click(MouseEvent)`.
Slots: default. Classes: `btn`, plus `btn-primary` / `btn-danger` /
`btn-sm` per variant/size (`btn-sm` added to patterns.css under F01).
F01 deps: `--surface-2`, `--surface-3`, `--text`, `--text-muted`,
`--border`, `--border-strong`, `--btn-primary-{bg,bg-hover,border,text}`,
`--danger`, `--entry-danger-border`.

Sketch:

```vue
<script setup lang="ts">
defineProps<{
  variant?: 'default' | 'primary' | 'danger';
  size?: 'sm' | 'md';
  type?: 'button' | 'submit' | 'reset';
  disabled?: boolean; title?: string; ariaLabel?: string;
}>();
defineEmits<{ (e: 'click', event: MouseEvent): void }>();
</script>
<template>
  <button
    :type="type ?? 'button'" :disabled="disabled"
    :title="title" :aria-label="ariaLabel"
    class="btn"
    :class="[variant === 'primary' && 'btn-primary',
             variant === 'danger'  && 'btn-danger',
             size === 'sm' && 'btn-sm']"
    @click="$emit('click', $event)"
  ><slot /></button>
</template>
```

### 2.2 `Pill.vue`

Path: `web/src/components/ui/Pill.vue`. Emits: `click(MouseEvent)`
only when `as === 'button'`. Slots: default. Classes: `pill` +
`pill-{accent,warn,danger,purple}` per tone. F01 deps: `--surface-2`,
`--border`, `--text-muted`, `--radius-pill`, `--entry-{accent,warn,danger,purple}-border`,
`--accent`, `--warn`, `--danger`.

Sketch:

```vue
<script setup lang="ts">
defineProps<{
  tone?: 'default' | 'accent' | 'warn' | 'danger' | 'purple';
  as?: 'span' | 'button';
  disabled?: boolean; title?: string;
}>();
defineEmits<{ (e: 'click', event: MouseEvent): void }>();
</script>
<template>
  <component
    :is="as ?? 'span'"
    :type="as === 'button' ? 'button' : undefined"
    :disabled="as === 'button' ? disabled : undefined"
    :title="title"
    class="pill"
    :class="[tone === 'accent' && 'pill-accent',
             tone === 'warn'   && 'pill-warn',
             tone === 'danger' && 'pill-danger',
             tone === 'purple' && 'pill-purple']"
    @click="as === 'button' && $emit('click', $event)"
  ><slot /></component>
</template>
```

### 2.3 `Card.vue`

Path: `web/src/components/ui/Card.vue`. Emits: none. Slots: default.
Classes: `card`, `card-active` when `active`. F01 deps: `--surface-1`,
`--border`, `--radius`, `--entry-accent-border`.

Sketch:

```vue
<script setup lang="ts">
defineProps<{ active?: boolean; as?: 'div' | 'section' | 'article' | 'li' }>();
</script>
<template>
  <component
    :is="as ?? 'div'"
    class="card"
    :class="{ 'card-active': active }"
  ><slot /></component>
</template>
```

### 2.4 `PanelHeading.vue`

Path: `web/src/components/ui/PanelHeading.vue`. Emits: none. Slots:
`title`, `meta` (status dots / model chips), `actions` (toolbar
buttons); default slot accepted as plain title text. Classes:
`panel-heading`. F01 deps: `--surface-1`, `--border`, `--text`. Props
`{ level?: 2 | 3 }` chooses heading tag so callers keep the document
outline correct.

Sketch:

```vue
<script setup lang="ts">
defineProps<{ level?: 2 | 3 }>();
</script>
<template>
  <header class="panel-heading">
    <component :is="`h${level ?? 3}`"><slot name="title" /><slot /></component>
    <div class="panel-heading-meta"><slot name="meta" /></div>
    <div class="panel-heading-actions"><slot name="actions" /></div>
  </header>
</template>
<style scoped>
.panel-heading-meta { display: flex; gap: 8px; align-items: center; }
.panel-heading-actions { display: flex; gap: 6px; align-items: center; margin-left: auto; }
</style>
```

### 2.5 `StatusDot.vue`

Path: `web/src/components/ui/StatusDot.vue`. Emits/slots: none.
Classes: `status-dot` + `status-dot-{tone}` (rules in patterns.css,
not here). F01 deps: `--ok`/`--success`, `--warn`, `--danger`,
`--accent`, `--text-muted`.

Sketch:

```vue
<script setup lang="ts">
defineProps<{
  tone: 'ok' | 'warn' | 'danger' | 'accent' | 'muted';
  title?: string; ariaLabel?: string;
}>();
</script>
<template>
  <span class="status-dot" :class="`status-dot-${tone}`"
        :title="title" :aria-label="ariaLabel ?? title" role="img" />
</template>
```
```

The `.status-dot-{tone}` rules belong in patterns.css (F01), not here.

### 2.6 `Overlay.vue`

Path: `web/src/components/ui/Overlay.vue`. Emits: `close()`. Slots:
default. Classes: `overlay`. F01 deps: `--overlay-bg`. Behavior:
teleports to `body`, traps focus (§5.3), closes on backdrop click
when `closeOnBackdrop !== false`, and on Escape. Props
`{ open: boolean; closeOnBackdrop?: boolean; ariaLabel?: string }`.
Sketch: `<Teleport to="body"><Transition name="overlay">` wrapping
`<div v-if="open" class="overlay" role="dialog" aria-modal="true"
@click.self="closeOnBackdrop !== false && $emit('close')"><slot/></div>`,
with a `keydown` window listener emitting `close` on Escape.

### 2.7 `Spinner.vue`

Path: `web/src/components/ui/Spinner.vue`. Emits/slots: none. Classes:
`spin`. F01 deps: `--text-muted`, `--accent`. Renders
`lucide-vue-next`'s `Loader2` (already used by v2's ChatWindow) with
the `spin` keyframe from patterns.css. Props
`{ size?: 'sm' | 'md' | 'lg'; ariaLabel?: string }`; size maps to
svg dimensions `{sm:14, md:18, lg:24}`.

### 2.8 `ThinkingDots.vue`

Path: `web/src/components/ui/ThinkingDots.vue`. Props:
`{ ariaLabel?: string }`. Emits/slots: none. Classes:
`thinking-dots` + three child `<span>`s riding the `pulse` keyframe
from patterns.css. F01 deps: `--text-muted`. The `.thinking-dots`
rule and `:nth-child` delays move to patterns.css under F01,
removed from
[saivage/web/src/components/ChatWindow.vue](../../../../saivage/web/src/components/ChatWindow.vue#L508)
during the port.

### 2.9 `JsonView.vue`

Path: `web/src/components/ui/JsonView.vue`. Direct relocation of
[saivage/web/src/components/JsonHighlight.vue](../../../../saivage/web/src/components/JsonHighlight.vue).
Props: `{ data: unknown; maxHeight?: string }`. Emits/slots: none.
Classes: `json-hl` + `jt-{key|string|number|boolean|null|brace|bracket|colon|comma}`.
F01 deps: `--code-block-{bg,border}`, `--syn-{key,string,number,boolean,null,punctuation}`.
Tokeniser logic copied as-is.

The tokeniser logic is copied as-is; the only edit is the file
location, so all surfaces consume one JSON-rendering primitive
rather than 4 inlined copies.

### 2.10 `FormattedContent.vue`

Path: `web/src/components/ui/FormattedContent.vue`. Direct port of
[saivage/web/src/components/FormattedContent.vue](../../../../saivage/web/src/components/FormattedContent.vue).

Props: `{ content: string; maxHeight?: string }`. Emits/slots: none.

Auto-detects JSON vs markdown (`{` / `[` prefix → JsonView; otherwise
MarkdownText). Replaces the ad-hoc "stringify-then-pre" in
AnalystChatPanel and the per-tool inline parts in AgentConversationView.

F01 dependencies: as JsonView, plus `--code-bg`, `--code-color`,
`--code-block-*`.

### 2.11 `MarkdownText.vue` (keep, relocate)

Action: **relocate** [components/code/MarkdownText.vue](../../../web/src/components/code/MarkdownText.vue)
to `web/src/components/ui/MarkdownText.vue`. All importers update;
content preserved. Props (existing): `{ source: string }`.

### 2.12 `CodeBlock.vue` (keep, relocate)

Action: **relocate** [components/code/CodeBlock.vue](../../../web/src/components/code/CodeBlock.vue)
to `web/src/components/ui/CodeBlock.vue`. Delete the now-empty
`code/` directory. All importers (DebugView, FilesView,
CardDetailView, CardHistoryPanel, AgentConversationView,
RawLlmExchangePanel, AnalystChatPanel, MarkdownText) update import
path. Props: `{ code: string; language?: string; copyable?: boolean; wrap?: boolean }`.

### 2.13 `ToolChip.vue`

Path: `web/src/components/ui/ToolChip.vue`. Single source of truth
for tool-call / tool-result rows. Replaces both the `.tc-*` family in
AgentConversationView and the `.tool-chip*` family in AnalystChatPanel.

Props: `{ view: ToolPresenterView; status: 'call'|'ok'|'error'|'pending'; expanded: boolean; timestamp?: string }`
(where `ToolPresenterView` carries `icon`, `name`, `headline`,
`detail` — see `web/src/utils/tool-presenters.ts`). Emits:
`toggle()`. Slots: `details` (rendered when `expanded`, typically a
`<JsonView>` or `<CodeBlock>`). Classes: `tool-chip` +
`tool-chip-{call,ok,error,pending}`. F01 deps: `--surface-2`,
`--border`, `--text`, `--text-muted`, `--accent`, `--accent-2`,
`--ok`, `--danger`. Sketch: a `<button class="tool-chip-row"
@click="$emit('toggle')">` containing icon, name, headline, an inner
`<Pill tone="accent|danger">{{ view.detail }}</Pill>`, optional
timestamp, and a caret; wrapped in `<div class="tool-chip"
:class="`tool-chip-${status}`">` and followed by
`<div v-if="expanded" class="tool-chip-details"><slot name="details"/></div>`.

### 2.14 `MessageBubble.vue`

Path: `web/src/components/ui/MessageBubble.vue`. Replaces the
`.msg.*` / `.message-bubble` markup in AnalystChatPanel, the inline
bubbles in v2's ChatWindow we are porting, and the `.conv-message`
block in AgentConversationView.

Props: `{ role: 'user'|'assistant'|'system'|'tool'; kind?: 'reasoning'|'activity'|'plain'; timestamp?: string; modelLabel?: string }`.
Emits: none. Slots: `meta` (defaults to role + model chip +
timestamp), default (content, typically `<FormattedContent>` or
`<MarkdownText>`), `badges` (post-content pill list). Classes: `msg`,
`role-{role}`, `kind-{kind}`, plus `entry-{user,accent,warn,purple}`
driving the role-coloured background. F01 deps:
`--entry-{user,accent,warn,danger,purple}-{bg,border}`. Sketch:
`<article class="msg" :class="[`role-${role}`, kind && `kind-${kind}`,
entryClass(role)]">` containing `<div class="msg-meta"><slot name="meta">
... defaults ...</slot></div>`, `<div class="msg-content"><slot/></div>`,
`<div class="msg-badges"><slot name="badges"/></div>`; helper
`entryClass(role)` maps role → `entry-user|entry-accent|entry-warn|entry-purple`.

---

## 3. Container components — pure layout shells

After the port, the components below keep their position but lose
all colour / border / radius from their scoped `<style>`. Their job
is layout (grid / flex / sticky / gap), not visuals. Allowed in
scoped `<style>`: `display`, `grid-*`, `flex-*`, `gap`, `padding`
for pure spacing, `position`, `min/max-{width,height}`. Forbidden:
any `color`, `background`, `border` (except `border: none` resets),
`border-radius`, hex literal, or pattern-class redefinition.

| Container | Composition after port |
| --- | --- |
| [App.vue](../../../web/src/App.vue) | mounts shell (already empty) |
| [layout/AppShell.vue](../../../web/src/components/layout/AppShell.vue) | grid: rail / header / main / right rail |
| [layout/WorkspaceHeader.vue](../../../web/src/components/layout/WorkspaceHeader.vue) | `<PanelHeading>` + nav links |
| [nav/NavRail.vue](../../../web/src/components/nav/NavRail.vue) | vertical list of nav `<Button>`/`<RouterLink>` |
| [views/DashboardView.vue](../../../web/src/views/DashboardView.vue) | grid of `<Card>` widgets |
| [views/CardsView.vue](../../../web/src/views/CardsView.vue) | tab strip + child view slot |
| [views/AgentsView.vue](../../../web/src/views/AgentsView.vue) | sessions sidebar + conversation panel |
| [views/FilesView.vue](../../../web/src/views/FilesView.vue) | tree + viewer (`<CodeBlock>`/`<MarkdownText>`) |
| [views/DebugView.vue](../../../web/src/views/DebugView.vue) | tab strip + panes (`<CodeBlock>` + `<Pill>`) |
| [views/NotFound.vue](../../../web/src/views/NotFound.vue) | centered empty state |
| [agents/AgentConversationView.vue](../../../web/src/components/agents/AgentConversationView.vue) | `<PanelHeading>` + round timeline of `<MessageBubble>`/`<ToolChip>` (grouping spec in F03) |
| [agents/RawLlmExchangePanel.vue](../../../web/src/components/agents/RawLlmExchangePanel.vue) | `<Overlay>` + `<PanelHeading>` + `<CodeBlock>` panes |
| [chat/AnalystChatPanel.vue](../../../web/src/components/chat/AnalystChatPanel.vue) | `<PanelHeading>` + list of `<MessageBubble>`/`<ToolChip>` + composer + `<Button variant="primary">` |
| [chat/AnalystToaster.vue](../../../web/src/components/chat/AnalystToaster.vue) | stack of `<Pill>` toasts |
| [cards/CardsBoardView.vue](../../../web/src/components/cards/CardsBoardView.vue) | columns of `<Card>` |
| [cards/CardsLeaderboardView.vue](../../../web/src/components/cards/CardsLeaderboardView.vue) | table of `<Pill>` rows |
| [cards/CardsTimelineView.vue](../../../web/src/components/cards/CardsTimelineView.vue) | vertical strip of `<Card>` |
| [cards/CardsTreeView.vue](../../../web/src/components/cards/CardsTreeView.vue) | tree of `<Card>` rows |
| [cards/CardDetailView.vue](../../../web/src/components/cards/CardDetailView.vue) | `<PanelHeading>` + meta grid + `<Pill>` list + `<CodeBlock>` + `<Button>` actions |
| [cards/CardHistoryPanel.vue](../../../web/src/components/cards/CardHistoryPanel.vue) | diff rows of `<CodeBlock>` + `<Pill>` |
| [cards/StaleWarningRibbon.vue](../../../web/src/components/cards/StaleWarningRibbon.vue) | `<Card tone="warn">` ribbon (see §5.5) |
| [auth/ApiTokenEntry.vue](../../../web/src/components/auth/ApiTokenEntry.vue) | `<Overlay>` + form + `<Button>` group |

Hard rule: after the port, `grep -rnE '#[0-9a-fA-F]{3,8}'
web/src/components web/src/views web/src/App.vue` must return zero
hits. The only file allowed to contain hex literals is
`web/src/styles/tokens.css` (F01).

---

## 4. Naming and directory convention

### 4.1 Directory layout

```
web/src/components/
  ui/                ← primitives only; no Pinia, no router, no fetch
    Button.vue
    Pill.vue
    Card.vue
    PanelHeading.vue
    StatusDot.vue
    Overlay.vue
    Spinner.vue
    ThinkingDots.vue
    JsonView.vue
    FormattedContent.vue
    MarkdownText.vue        (relocated from components/code/)
    CodeBlock.vue           (relocated from components/code/)
    ToolChip.vue
    MessageBubble.vue
  layout/            ← AppShell, WorkspaceHeader
  nav/               ← NavRail (+ existing types.ts)
  agents/            ← AgentConversationView, RawLlmExchangePanel
  chat/              ← AnalystChatPanel, AnalystToaster
  cards/             ← CardsBoardView, CardsLeaderboardView,
                       CardsTimelineView, CardsTreeView,
                       CardDetailView, CardHistoryPanel,
                       StaleWarningRibbon
  auth/              ← ApiTokenEntry
```

The `components/code/` directory is deleted at the end of the port
(see §2.11, §2.12) — no shim, no re-export file. Consumers update
their imports directly. This is mandatory per the project guideline
(no backward compatibility).

### 4.2 Surface composites

Surface composites bigger than a primitive but reused within one
surface (e.g. a future `chat/MessageList.vue` tying together
MessageBubble + ToolChip + pagination) live under
`components/<surface>/`, not `ui/`. Discriminator: if a component
imports a Pinia store / router / WebSocket, it is **not** a primitive.

### 4.3 Tests

Tests live under `web/src/__tests__/`
([example](../../../web/src/__tests__/code-block.test.ts)). Convention
for new primitives:

- One spec per primitive: `web/src/__tests__/ui/Button.test.ts`,
  `ui/Pill.test.ts`, `ui/ToolChip.test.ts`, etc.
- Cover prop → emitted class mapping, slot rendering, emitted events
  on user interaction, ARIA attributes (Overlay's `aria-modal`,
  StatusDot's `role="img"`, Spinner's accessible name).
- Existing tests asserting removed classes (`.conv-tb-btn`,
  `.primary-btn`, `.tool-chip-tag`, `.detail-status-chip`,
  `.token-btn-save`, …) are **rewritten** to target new primitive
  selectors (`.btn`, `.btn-primary`, `.pill`, `.tool-chip`, …), not
  kept as legacy assertions.
- No DOM snapshot tests; each test asserts the smallest meaningful
  selector + behaviour.

### 4.4 Imports

Relative paths (`import Button from '../ui/Button.vue';`). No barrel
`index.ts` — Vue SFCs need an explicit file path for the SFC
compiler, and a barrel breaks tree-shaking.

---

## 5. Risks and open questions

### 5.1 Vue scoped-style leakage

The primitive layer relies on **global** pattern classes from F01.
If a primitive declares its visuals under `<style scoped>`, Vue
rewrites those rules with a `[data-v-xxxx]` selector and they will
not match elements emitted by descendants reusing the same class.

Mitigation: pattern CSS ships exclusively from
`web/src/styles/patterns.css` (imported once in `main.ts` per F01).
Primitive scoped styles are layout helpers only and MUST NOT declare
any rule whose selector starts with a pattern class (`.btn`,
`.pill`, `.card`, `.panel-heading`, `.status-dot`, `.overlay`,
`.code-block`, `.code-inline`, `.entry-*`, `.syn-*`, `.spin`,
`.thinking-dots`, `.text-*`).

Open for reviewer: enforce via stylelint `selector-disallowed-list`?

### 5.2 Pinia / router / fetch coupling — forbidden in `ui/`

A primitive that imports `useAgentStore`, `useRouter`, `useFetch`,
or the WebSocket client is mis-categorised and belongs under a
surface folder. Concretely:

- `ToolChip` takes a presented view as a prop and emits `toggle`;
  does **not** read `expandedToolCalls` from `useAgentStore`.
- `MessageBubble` takes role/timestamp/modelLabel as props; does
  **not** read messages from `useAnalystChat`.
- `Overlay` owns Escape + backdrop, but the parent decides `open`.

Wiring (store → props) happens in surface containers.

### 5.3 ARIA / accessibility per primitive

| Primitive | ARIA contract |
| --- | --- |
| `Button` | Native `<button>`; supports `aria-label` and `title` props. When `variant === 'danger'`, no extra ARIA — the caller may add `aria-describedby` to a confirmation text. |
| `Pill` | `<span>` by default (decorative); when `as === 'button'`, becomes a focusable `<button type="button">`. Caller provides label. |
| `Card` | No implicit ARIA. If used as a clickable card, caller wraps content in a `<button>` or adds `role="button"` + `tabindex="0"`. |
| `PanelHeading` | Renders `<header>` containing an `<h2>` or `<h3>`; default level is `h3`. Caller chooses level to keep the document heading outline correct. |
| `StatusDot` | `role="img"` + `aria-label`. The dot is non-interactive. |
| `Overlay` | `role="dialog"`, `aria-modal="true"`, `aria-label` required; Escape closes, backdrop click closes when allowed, focus is moved to the first focusable element inside on open, and restored to the previously focused element on close. |
| `Spinner` | `role="img"` + `aria-label` (default `"Loading"`). |
| `ThinkingDots` | `role="status"` + `aria-label` (default `"Thinking"`). |
| `JsonView` / `FormattedContent` / `MarkdownText` / `CodeBlock` | Content surfaces; `CodeBlock`'s copy button needs `aria-label="Copy code"`. |
| `ToolChip` | Header is a `<button>` with `aria-expanded` reflecting `expanded` and `aria-controls` pointing at the details panel id. |
| `MessageBubble` | `<article>` with `aria-label` derived from role + timestamp (caller-supplied). |

Open question: focus trap implementation in `Overlay`. The smallest
correct implementation listens to Tab/Shift+Tab and cycles within the
dialog; an alternative is to use `inert` on siblings of the overlay
host. The reviewer is asked to pick one approach.

### 5.4 Global keyboard shortcuts

`AppShell.vue` listens to `keydown` at the shell
(`@keydown="handleKeydown"`). When `Overlay` is open, Escape must not
bubble to the shell, otherwise both handlers fire. Mitigation:
`Overlay`'s key handler calls `event.stopPropagation()` after
emitting `close`.

### 5.5 Tests targeting removed selectors

Tests like
[api-token-entry.test.ts](../../../web/src/__tests__/api-token-entry.test.ts),
[agents-view.test.ts](../../../web/src/__tests__/agents-view.test.ts),
[dashboard-view.test.ts](../../../web/src/__tests__/dashboard-view.test.ts),
[card-detail-view.test.ts](../../../web/src/__tests__/card-detail-view.test.ts),
[code-block.test.ts](../../../web/src/__tests__/code-block.test.ts)
assert against bespoke selectors that disappear. Per project guideline,
they are rewritten to new primitive selectors, not kept as legacy.

### 5.6 Where do `.entry-*` modifiers live?

`MessageBubble` applies `.entry-user` / `.entry-accent` /
`.entry-warn` / `.entry-purple` per role. Surfaces sometimes want a
non-message container with the same colouring (e.g. the
auth-required banner: `.entry-danger` Card). Proposal: let `Card`
accept `tone?: 'user' | 'accent' | 'warn' | 'danger' | 'purple'`
applying the corresponding `.entry-*` class. Adding a fifteenth
primitive (`<Banner>`) for a one-line composition would be overkill.
Reviewer to confirm.

### 5.7 Move `CodeBlock` now or later?

`CodeBlock` is used by 8 files. Recommendation: move as part of F02
(atomic move + import rewrite in one commit) so "all primitives live
under `ui/`" holds without a follow-up sweep. Reviewer to confirm.

---

## 6. Non-goals

Explicitly out of scope:

- **No headless-UI library.** No `radix-vue`, `@headlessui/vue`,
  `reka-ui`, `naive-ui`, `vuetify`, `primevue`. Primitives are
  15-to-60-line SFCs over v2 pattern classes; a third-party library
  would reintroduce the design-token coupling we are removing.
- **No Tailwind / UnoCSS / Windi.** The pattern layer from F01 is
  the styling source; parallel styling pathways are forbidden.
- **No theme switcher.** v3 stays dark. F01 keeps semantic variable
  names so a future light theme is mechanical, but none ships now.
- **No Pinia-store refactor.** `useAgentStore`, `useAnalystChat`,
  `useCards`, `useRuntime`, `useDebug`, `useFiles`, `useMcp`,
  `useWs`, `useWorkspaceRoute` stay byte-identical.
- **No router changes.** Routes and `useWorkspaceRoute` unchanged.
- **No WebSocket protocol changes.** F02 is presentation-only.
- **No icon-set change.** `lucide-vue-next` stays. Tool-chip glyphs
  remain the characters supplied by `tool-presenters.ts` (F05 may revisit).
- **No animation framework.** `Overlay` reuses `<Transition
  name="modal">` already used by ApiTokenEntry.
- **No backward-compatibility shims.** `.conv-tb-btn`, `.primary-btn`,
  `.auth-banner-action`, `.auth-banner-dismiss`, `.tool-chip-tag`,
  `.pending-tool-tag`, `.detail-status-chip`, `.detail-type-badge`,
  `.token-btn*`, `.retry-btn`, `.discuss-btn`, `.nav-pill`,
  `.child-row`, `.tc-*`, `.tr-*`, `.stab`, `.console-button` are
  **deleted** in the same commit that introduces the replacing
  primitive. They are not aliased to `.btn` / `.pill` / `.tool-chip`.

---

## 7. Expected file outcomes (informational)

- New: 14 SFCs under `web/src/components/ui/` (12 new + 2 relocated).
- Modified: every container in §3.
- Deleted: `web/src/components/code/`; every bespoke class in §6.
- Tests: new `web/src/__tests__/ui/*.test.ts`; existing tests updated.

Exact migration order belongs in `02-design-r1.md` / `03-plan-r1.md`.
