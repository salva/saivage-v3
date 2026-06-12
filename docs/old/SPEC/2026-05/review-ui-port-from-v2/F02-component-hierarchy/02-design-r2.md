# F02 — Component hierarchy / UI primitive layer — Design (r2)

Writer round 2 of the design phase. Addresses every item in
[02-design-review-r1.md](02-design-review-r1.md) (VERDICT:
CHANGES_REQUESTED). Implements the approved analysis
[01-analysis-r2.md](01-analysis-r2.md) and consumes the sibling
analyses [F01 r2](../F01-design-tokens/01-analysis-r2.md),
[F03 r2](../F03-conversation-rounds/01-analysis-r2.md),
[F04 r3](../F04-chat-surface-style/01-analysis-r3.md),
[F05 r2](../F05-tool-detail-rendering/01-analysis-r2.md).

**Project guideline (binding, repeated for emphasis):** architecture-
first, no backward compatibility. Every bespoke v3 selector
enumerated in analysis §4 is **deleted in the same commit** that
introduces its replacement primitive. No `@deprecated` re-exports,
no `.legacy-*` holdovers, no alias period, no `index.ts` barrels
under `ui/` / `content/` / `conversation/` (analysis §10).

---

## Coverage map (review r1 → r2 section)

| Review r1 item | Status | r2 section(s) |
| --- | --- | --- |
| **Blocking 1** — `ToolChip` API uses wrong contract (`view:` prop, wrong status union, wrong emits) | Fixed | [§1.3.13](#1313-conversationtoolchipvue) chip prop API; [§3 (verbatim interface)](#3-per-primitive-typescript-prop-interfaces-verbatim); [§0 cross-input table](#0-inputs-consumed-from-sibling-analyses) row for F03/F04/F05 rewritten |
| **Blocking 1** — `FormattedContent` claims a conflicting parts-renderer API | Fixed | [§1.3.10–1.3.12](#1310-contentjsonviewvue-new-ported-from-v2-jsonhighlightvue) split: `content/FormattedContent.vue` matches F05 r2 §7.3 (parses raw content); the inline-parts renderer is renamed to `content/InlineParts.vue` per F05 r2 §6; [§3](#3-per-primitive-typescript-prop-interfaces-verbatim) repeats the corrected signatures |
| **Blocking 2** — chip-swap landing boundary leaves two chip renderers at HEAD | Fixed | [§1.4 commit matrix](#14-deletion-matrix-commit-bound) rewritten: C5 is the **combined "shared `ToolChip` + AnalystChatPanel swap"** boundary that lands inside the F03 PR (per F03 r2 §8.2 / F04 r3 §11.2); the analyst `.tool-chip*` family is deleted in C5, not C13; [§1.6 cross-batch coordination](#16-cross-batch-coordination-f03--f04--f05) restates the F02↔F03↔F04↔F05 ordering and the "no two chip renderers at HEAD" invariant; the chip-row deletion in the matrix is paired with the correct commit. |
| Required: Two real proposals | Already satisfied; preserved | [§1 Proposal A](#1-proposal-a--three-layer-split-ui-content-conversation), [§2 Proposal B](#2-proposal-b--feature-slice-with-role-based-co-location), [§9 Recommendation](#9-recommendation) |
| Required: Per-primitive TS prop interfaces (14 SFCs + `InlineParts`) | Fixed for the three corrected primitives | [§1.3](#13-new-primitives--exact-prop-signatures-verbatim), [§3](#3-per-primitive-typescript-prop-interfaces-verbatim) |
| Required: Deletion matrix | Fixed (chip-row commit binding corrected) | [§1.4](#14-deletion-matrix-commit-bound) |
| Required: Landing sequence | Fixed (C5 boundary corrected) | [§1.4](#14-deletion-matrix-commit-bound), [§1.6](#16-cross-batch-coordination-f03--f04--f05) |
| Required: Composition rules — make ESLint overrides for `content/` and `conversation/` as concrete as `ui/`; make `Spinner` lucide exception machine-checkable | Fixed | [§1.2](#12-composition-rules-enforced-by-code-review--eslint-no-restricted-imports) now contains the full four-override block; the `Spinner` exception is expressed as a single-file `overrides` entry on `ui/Spinner.vue` |
| Required: Test reorganization — `ToolChip.test.ts` aligned with F03 r2 §10.5 lifecycle cases; F04 adapter tests live with the F03 PR | Fixed | [§1.5](#15-test-reorganisation), [§5.1](#51-new-tests-proposal-a-paths), [§5.2](#52-rewritten-surface-tests) |
| Required: Cross-issue alignment — `InlinePart` / `FormattedContent` naming fix; F03/F04 chip contract; F05 file/url routing | Fixed | [§0](#0-inputs-consumed-from-sibling-analyses), [§1.3.10–1.3.12](#1310-contentjsonviewvue-new-ported-from-v2-jsonhighlightvue), [§1.3.13](#1313-conversationtoolchipvue), [§1.6](#16-cross-batch-coordination-f03--f04--f05) |
| Required: Open questions — Q3 promoted from "open" to bound by F05 r2 | Fixed | [§8 open questions](#8-risks-and-open-questions) — Q3 closed, Q1/Q2 preserved |
| Non-blocking: "nine" pattern extensions vs actual count | Fixed | [§2 of analysis](01-analysis-r2.md#22-f02-extensions-to-f01-must-land-in-f01-r2) is the source of truth; this design refers to them as "the extension rules" without a numeric claim. [§4](#4-pattern-extensions-to-f01-r2-binding) lists each rule explicitly. |
| Non-blocking: `Spinner` exception scoping | Fixed | [§1.2](#12-composition-rules-enforced-by-code-review--eslint-no-restricted-imports) override names only `ui/Spinner.vue` |
| Non-blocking: Proposal B's barrel rejection | Preserved | [§2.1](#21-file-layout), [§2.8](#28-why-this-proposal-still-falls-short) |

This document otherwise inherits r1's structure; sections that did
not need substantive change keep their r1 wording so the reviewer
can diff. The corrections are concentrated in §0, §1.2, §1.3.10–
1.3.13, §1.4, §1.5, §1.6, §3, §5, §8.

---

## 0. Inputs consumed from sibling analyses

Cross-issue contracts F02 must satisfy:

| Source | Contract F02 owns |
| --- | --- |
| [F01 r2 §3.2](../F01-design-tokens/01-analysis-r2.md#32-semantic-layer-semanticcss--zero-hex-literals) | Semantic tokens (`--accent`, `--accent-2`, `--warn`, `--danger`, `--purple`, `--entry-*-{bg,border}`, `--btn-primary-*`) consumed only via pattern classes. F02 introduces zero new tokens; the pattern extensions listed below land in F01 r2's `patterns.css`. |
| [F01 r2 §2 (patterns.css)](../F01-design-tokens/01-analysis-r2.md#3-variable-inventory) | Extensions listed in analysis [§2.2](01-analysis-r2.md#22-f02-extensions-to-f01-must-land-in-f01-r2) (`.status-dot-{ok,warn,danger,accent,muted}`, `.card-{warn,danger,accent,user,purple}`, `.pill-purple`, and the conditional `.tablist > .pill[aria-pressed="true"]`). |
| [F03 r2 §3.1](../F03-conversation-rounds/01-analysis-r2.md#31-folder-layout-binding-to-f02-r2) | `web/src/components/conversation/` folder shape; ownership map of `RoundCard` / `DiagnosticRow` / `PendingCallFooter` / `CompactedCluster` / `ContextBlock` (F03 fills bodies). F02 owns the directory; F02 r2's API contribution to the conversation tier is `MessageBubble` + `ThinkingDots` only — `ToolChip.vue` is shipped by **the F03 PR** (per F03 r2 §8.2) with the F02 r2 API written here. |
| [F03 r2 §3.3 (`ToolPairStatus`)](../F03-conversation-rounds/01-analysis-r2.md#33-type-contracts-final) | `ToolPairStatus = 'pending' \| 'ok' \| 'error' \| 'orphan' \| 'missing'`. **This** is the chip's `status` union — not `'call' \| 'ok' \| 'error' \| 'pending'`. F02 r2 imports it from F03's types module. |
| [F03 r2 §7.2 (pair composition)](../F03-conversation-rounds/01-analysis-r2.md#72-pair-composition-view-level-only) | `ToolChip` prop bag: `call: ToolCallPresentation`, `result: ToolResultPresentation \| null`, `status: ToolPairStatus`, `expanded: boolean`, `detailsId: string`, `timestamp?: string`; emits `toggle` only. The chip body renders two `FormattedContent` calls (call payload + optional result payload) when `expanded`; file/url click routing is handled by `InlineParts.vue` via `<router-link>` and `<a>`, **not** by chip-level emits (per F05 r2 §6 "no nested interactive elements" — links are siblings of the toggle inside the chip group). |
| [F03 r2 §8.2 (chip-swap binding)](../F03-conversation-rounds/01-analysis-r2.md#82-analystchatpanel-toolchip-swap-resolution-to-r1-contradiction) | The F03 PR ships `conversation/ToolChip.vue` together with the swap of `chat/AnalystChatPanel.vue` from its in-line `.tool-chip*` markup to `<ToolChip v-bind="adaptChatMessageToToolChip(…)">`. F02's commit sequence (§1.4) reflects this: the analyst `.tool-chip*` family is deleted in the same commit (C5) that introduces the shared `ToolChip`. |
| [F04 r3 §3.3 / §4.0 / §4.1](../F04-chat-surface-style/01-analysis-r3.md#33-chatmessageitemvue) | `MessageBubble` and `ToolChip` are imported by `chat/MessageItem.vue` exactly as F02 r2 ships them; F04's `chat/MessageList.vue` and the adapter `chat/tool-chip-adapter.ts` (`adaptChatMessageToToolChip`, `adaptPendingInvocationToToolChip`) bind to the F02 r2 prop bag using `v-bind`. No `:view`, no `:message`, no chat-local chip API. |
| [F05 r2 §2 (presenter contract)](../F05-tool-detail-rendering/01-analysis-r2.md#2-presenter-contract-independent-no-hidden-pair-state) | `ToolCallPresentation`, `ToolResultPresentation`, and `InlinePart` are owned by F05 in `web/src/utils/tool-presenters.ts`. F02 imports them; F02 does not redefine them. There is **no** `ToolPresentationView`. |
| [F05 r2 §6 (chip markup)](../F05-tool-detail-rendering/01-analysis-r2.md#6-chip-markup-no-nested-interactive-elements) | Inline parts are rendered by `content/InlineParts.vue` (file → `<router-link>`, url → `<a>`, code → `<code>`, text → `<span>`). The chip is a `role="group"` `<div>` whose only `<button>` is the expand toggle; file/url links are DOM siblings of the toggle. F02 r2 ships `content/InlineParts.vue` with this exact contract. |
| [F05 r2 §7.3 (FormattedContent)](../F05-tool-detail-rendering/01-analysis-r2.md#73-websrccomponentsuiformattedcontentvue) | `content/FormattedContent.vue` accepts `content: string` (and an optional `maxHeight`), parses it as JSON-or-prose, and delegates to `content/JsonView.vue` or `content/MarkdownText.vue`. **F02 r2 §1.3.11's r1 signature (`parts: InlinePart[]`) is withdrawn**; that renderer is `content/InlineParts.vue`. |

Discriminator from analysis §1.3 (binding): any file importing
Pinia, Vue Router, fetch client, or the WebSocket client cannot
live in `ui/`, `content/`, or `conversation/`. It lives in its
surface folder. The single carve-out is `content/InlineParts.vue`,
which uses `<router-link>` (a global registered component) **in
template only**; it does not import `vue-router` JS or any store.
This carve-out is documented in §1.2 and is the F05 r2 §6
contract — not new in this design.

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
    content/                  (F02-owned; 5 SFCs)
      CodeBlock.vue           ← moved from components/code/CodeBlock.vue
      MarkdownText.vue        ← moved from components/code/MarkdownText.vue
      JsonView.vue            ← new, F05 r2 §7.2
      FormattedContent.vue    ← new, F05 r2 §7.3 (parses raw content, delegates to JsonView/MarkdownText)
      InlineParts.vue         ← new, F05 r2 §6 (renders InlinePart[]; <router-link>/<a> for file/url)
    conversation/             (F02 API; bodies fill in F03 PR; 8 SFCs at final HEAD)
      MessageBubble.vue       ← F02 (this design)
      ThinkingDots.vue        ← F02 (this design)
      ToolChip.vue            ← F03 PR (uses F02 r2 API; ships together with AnalystChatPanel swap)
      RoundCard.vue           ← F03 PR
      DiagnosticRow.vue       ← F03 PR
      PendingCallFooter.vue   ← F03 PR
      CompactedCluster.vue    ← F03 PR
      ContextBlock.vue        ← F03 PR
    agents/                   (unchanged surface folder)
    auth/                     (unchanged surface folder)
    cards/                    (unchanged surface folder)
    chat/                     (F04 expands to ChatHeader / MessageItem / MessageList / JumpToLatest / ChatComposer + tool-chip-adapter.ts + analyst-timeline.ts)
    layout/                   (unchanged surface folder)
    nav/                      (unchanged surface folder)
    code/                     ← DELETED in the CodeBlock relocation commit (no re-export shim)
```

No `index.ts` barrel under any of the three new folders (analysis
§10): each consumer writes an explicit import path.

### 1.2 Composition rules (enforced by code review + ESLint `no-restricted-imports`)

| Layer | May import from | Forbidden imports |
| --- | --- | --- |
| `ui/*` (except `ui/Spinner.vue`) | (nothing in this repo) | other `ui/*`, `content/*`, `conversation/*`, any `stores/*`, `vue-router`, `utils/api-client`, `lucide-vue-next` |
| `ui/Spinner.vue` (exception) | `lucide-vue-next` (for `Loader2` only) | same as the rest of `ui/*` except `lucide-vue-next` |
| `content/*` (except `content/InlineParts.vue`) | `ui/*`, `utils/*`, `lucide-vue-next` | `stores/*`, `vue-router`, `utils/api-client`, other `content/*`, `conversation/*` |
| `content/InlineParts.vue` (exception) | `ui/*`, `utils/*`, `lucide-vue-next`, **and `<router-link>` as a globally registered template component** | `stores/*`, importing `vue-router` JS, `utils/api-client`, other `content/*`, `conversation/*` |
| `content/CodeBlock.vue`, `content/MarkdownText.vue`, `content/JsonView.vue`, `content/FormattedContent.vue` | `ui/*`, `utils/*`, `lucide-vue-next`, other `content/*` (e.g. `FormattedContent → JsonView, MarkdownText`; `MarkdownText → CodeBlock`) | `stores/*`, `vue-router`, `utils/api-client`, `conversation/*` |
| `conversation/*` | `ui/*`, `content/*`, `utils/*`, `lucide-vue-next`, F03's `utils/agent-timeline/*`, F05's `utils/tool-presenters.ts` | `stores/*`, `vue-router`, `utils/api-client`. Composition emits events; callers wire stores. |
| Surface folders (`agents/*`, `chat/*`, `cards/*`, `layout/*`, `nav/*`, `auth/*`, `views/*`) | anything | redefining pattern classes (`.btn`, `.pill`, `.card`, `.entry-*`) in their `<style scoped>` is forbidden |

ESLint config (added in this batch, lives in
[`web/.eslintrc.cjs`](../../../web/.eslintrc.cjs) or equivalent).
The five overrides below are the **complete** machine-checkable
specification:

```js
// 1) Base ui/ primitives — no Spinner here; Spinner.vue is excluded by negation.
{
  files: ['web/src/components/ui/**/*.vue'],
  excludedFiles: ['web/src/components/ui/Spinner.vue'],
  rules: {
    'no-restricted-imports': ['error', {
      patterns: [
        { group: ['*/stores/*', 'pinia'],          message: 'ui/ primitives must not import stores' },
        { group: ['vue-router'],                   message: 'ui/ primitives must not import the router' },
        { group: ['*/components/ui/*',
                  '*/components/content/*',
                  '*/components/conversation/*'],   message: 'ui/ primitives must not import other primitives' },
        { group: ['lucide-vue-next'],              message: 'ui/ primitives receive icons through slots' },
        { group: ['*/utils/api-client', '*/utils/ws-client'],
                                                    message: 'ui/ primitives must not import transport clients' },
      ],
    }],
  },
}

// 2) Spinner.vue — single-file exception for lucide-vue-next.
{
  files: ['web/src/components/ui/Spinner.vue'],
  rules: {
    'no-restricted-imports': ['error', {
      patterns: [
        { group: ['*/stores/*', 'pinia'],          message: 'Spinner must not import stores' },
        { group: ['vue-router'],                   message: 'Spinner must not import the router' },
        { group: ['*/components/ui/*',
                  '*/components/content/*',
                  '*/components/conversation/*'],   message: 'Spinner must not import other primitives' },
        { group: ['*/utils/api-client', '*/utils/ws-client'],
                                                    message: 'Spinner must not import transport clients' },
        // lucide-vue-next is intentionally permitted here only.
      ],
    }],
  },
}

// 3) content/* renderers — base rule, excludes InlineParts which has its own router-link carve-out.
{
  files: ['web/src/components/content/**/*.vue'],
  excludedFiles: ['web/src/components/content/InlineParts.vue'],
  rules: {
    'no-restricted-imports': ['error', {
      patterns: [
        { group: ['*/stores/*', 'pinia'],          message: 'content/ renderers must not import stores' },
        { group: ['vue-router'],                   message: 'content/ renderers must not import the router' },
        { group: ['*/components/conversation/*'],  message: 'content/ renderers must not import conversation composites' },
        { group: ['*/utils/api-client', '*/utils/ws-client'],
                                                    message: 'content/ renderers must not import transport clients' },
      ],
    }],
  },
}

// 4) content/InlineParts.vue — same as 3) but adds an additional message reminding
//    that the file/url routing target uses <router-link> as a template-global
//    component; importing vue-router JS is still forbidden.
{
  files: ['web/src/components/content/InlineParts.vue'],
  rules: {
    'no-restricted-imports': ['error', {
      patterns: [
        { group: ['*/stores/*', 'pinia'],          message: 'InlineParts must not import stores' },
        { group: ['vue-router'],                   message: 'InlineParts uses <router-link> as a globally registered component; do not import vue-router JS' },
        { group: ['*/components/conversation/*'],  message: 'content/ renderers must not import conversation composites' },
        { group: ['*/utils/api-client', '*/utils/ws-client'],
                                                    message: 'InlineParts must not import transport clients' },
      ],
    }],
  },
}

// 5) conversation/* composites — may import ui/, content/, utils/, lucide-vue-next, and F03/F05 utils.
{
  files: ['web/src/components/conversation/**/*.vue'],
  rules: {
    'no-restricted-imports': ['error', {
      patterns: [
        { group: ['*/stores/*', 'pinia'],          message: 'conversation/ composites must not import stores' },
        { group: ['vue-router'],                   message: 'conversation/ composites must not import the router (callers wire navigation)' },
        { group: ['*/utils/api-client', '*/utils/ws-client'],
                                                    message: 'conversation/ composites must not import transport clients' },
      ],
    }],
  },
}
```

The `Spinner` exception is now expressed as a dedicated override
block (#2 above) — the rule fires on `ui/Spinner.vue` only, and the
exclusion in block #1 is mechanical (`excludedFiles`). The reviewer's
"machine-checkable rather than only prose" requirement is met.

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
(F01 r2 patterns), plus the scoped `.btn-icon` layout class. The
ARIA props pass through as attributes only when defined.

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
when `active`) + tone modifier from analysis §2.2.

#### 1.3.4 `ui/PanelHeading.vue`

```ts
defineProps<{
  level?: 2 | 3;
  as?: 'header' | 'div';
}>();
```

Three slots, all optional: `title`, `meta`, `actions`. Renders
`.panel-heading` (F01 r1) + internal scoped grid (`auto 1fr auto`).

#### 1.3.5 `ui/StatusDot.vue`

```ts
defineProps<{
  tone: 'ok' | 'warn' | 'danger' | 'accent' | 'muted';
  ariaLabel?: string;
  title?: string;
}>();
```

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

#### 1.3.7 `ui/Spinner.vue`

```ts
defineProps<{
  size?: 'sm' | 'md' | 'lg';
  ariaLabel?: string;
}>();
```

Renders a `Loader2` glyph from `lucide-vue-next` (single-file
ESLint exception per §1.2 block #2).

#### 1.3.8 `content/CodeBlock.vue` (relocated)

Moves from
[web/src/components/code/CodeBlock.vue](../../../web/src/components/code/CodeBlock.vue)
to `web/src/components/content/CodeBlock.vue`. Public surface
preserved verbatim:

```ts
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

#### 1.3.9 `content/MarkdownText.vue` (relocated)

```ts
defineProps<{
  text: string;
  inline?: boolean;
}>();
```

#### 1.3.10 `content/JsonView.vue` (new, per F05 r2 §7.2)

```ts
const props = withDefaults(defineProps<{
  data: unknown;
  maxHeight?: string;
  copyable?: boolean;
}>(), { maxHeight: '60vh', copyable: false });
```

Internally uses the F05 r2 `tokenizeJson` utility
([F05 r2 §7.1](../F05-tool-detail-rendering/01-analysis-r2.md#71-websrcutilsjson-tokenizets)).
Above 1 MB the renderer drops tokenisation and falls back to a
plain `<pre class="json-raw">` ([F05 r2 §7.2](../F05-tool-detail-rendering/01-analysis-r2.md#72-websrccomponentsuijsonviewvue)).
Token classes are F01 r2 patterns (`.syn-*`). F02 r2 introduces
**no** new pattern classes here.

**Reconciliation with F05 r2:** F05 r2 places this SFC under
`components/ui/JsonView.vue`. F02 r2 places it under
`components/content/`. Both are the same SFC. The path under
F02 r2 wins because the analysis r2 ANALYSIS-APPROVED §1 made
`content/` the canonical home for content renderers, and F05 r2
§7.3 already references `content/MarkdownText.vue`. F05 batch
imports update the path in the same commit that moves the file
there (C4 below). This is a path correction inside F05's
implementation, not a contract change.

#### 1.3.11 `content/FormattedContent.vue` (new, per F05 r2 §7.3)

```ts
defineProps<{
  content: string;
  maxHeight?: string;            // forwarded to JsonView when delegating
}>();
```

Behaviour (verbatim from
[F05 r2 §7.3](../F05-tool-detail-rendering/01-analysis-r2.md#73-websrccomponentsuiformattedcontentvue)):

1. Empty input → renders nothing (or an empty `<MarkdownText :source="" />`).
2. Trimmed starts with `{` / `[` → try `JSON.parse`; on success
   delegate to `<JsonView :data=… :max-height=… />`.
3. Otherwise locate the first `{` or `[` in `content`. If the
   leading prefix is empty OR matches `/^(Tool call|Tool result|Result|Error|Response|Request)\b/i`,
   try `JSON.parse(suffix)`; on success delegate to `<JsonView>`.
4. Otherwise delegate to `<MarkdownText :source="content" />`.

No emits. The chip's body and the round body call this with
raw tool/message content strings; routing of file/url clicks is
the responsibility of `InlineParts.vue` rendered separately
(headline / detail parts inside the chip header), **not** of
`FormattedContent`.

**This withdraws the r1 design's `FormattedContent.vue` that
took `parts: InlinePart[]` and emitted `navigateFile` /
`navigateUrl`.** That renderer is `content/InlineParts.vue`
(§1.3.12). The r1 design's confused naming is the F02 r2
contract bug the reviewer flagged.

#### 1.3.12 `content/InlineParts.vue` (new, per F05 r2 §6)

The inline-parts renderer:

```ts
import type { InlinePart } from '../../utils/tool-presenters';

defineProps<{
  parts: InlinePart[];
}>();
```

No emits. The template (verbatim from F05 r2 §6) is:

```vue
<template>
  <span class="inline-parts">
    <template v-for="(part, i) in parts" :key="i"><router-link
      v-if="part.kind === 'file'"
      class="inline-file"
      :to="{ name: 'files', query: { path: part.path, root: part.root } }"
    >{{ shortPath(part.path) }}</router-link><a
      v-else-if="part.kind === 'url'"
      class="inline-url"
      :href="part.url"
      target="_blank"
      rel="noopener noreferrer"
    >{{ part.url }}</a><code
      v-else-if="part.kind === 'code'"
      class="inline-code"
    >{{ part.value }}</code><span
      v-else
      :class="['inline-text', part.tone ? `tone-${part.tone}` : null]"
    >{{ part.value }}</span></template>
  </span>
</template>
```

`<router-link>` is a globally registered Vue Router template
component; the SFC does **not** import `vue-router` (§1.2 block #4).
Click routing is therefore handled by Vue Router itself, with no
component-level emit, no store touch, and no chip-level emit
crossing component boundaries. F02 r2 §3 lists this signature
verbatim.

#### 1.3.13 `conversation/MessageBubble.vue`

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

#### 1.3.14 `conversation/ToolChip.vue` (final API; ships in F03 PR)

```ts
import type {
  ToolCallPresentation,
  ToolResultPresentation,
} from '../../utils/tool-presenters';
import type { ToolPairStatus } from '../../utils/agent-timeline/types';

defineProps<{
  call: ToolCallPresentation;
  result: ToolResultPresentation | null;
  status: ToolPairStatus;          // 'pending' | 'ok' | 'error' | 'orphan' | 'missing'
  expanded: boolean;
  detailsId: string;               // `tool-detail-${pair.toolUseId}`
  timestamp?: string;
}>();
defineEmits<{ (e: 'toggle'): void }>();
```

Status → `<Card>` tone mapping (verbatim from F03 r2 §7.2 / F04 r3
§4.2):

| `status`  | `<Card>` tone | rationale |
| --- | --- | --- |
| `'pending'` | `warn`   | in-flight, no result yet |
| `'ok'`      | `accent` | successful result |
| `'error'`   | `danger` | failed result |
| `'orphan'`  | `warn`   | result with no call (surfaced as warning, not error) |
| `'missing'` | `warn`   | call present, no result yet; headline gets a muted "(no result yet)" suffix |

Markup contract (verbatim from F05 r2 §6 / F03 r2 §7.2):

- The chip root is `<div class="tool-chip" role="group" :aria-label=… >`.
- The only `<button>` inside the chip group is the expand toggle,
  with `aria-expanded` reflecting `expanded` and `aria-controls`
  matching `detailsId`. Clicking emits `toggle`.
- The chip header renders `<InlineParts :parts="call.headline">`
  and, when `call.detail.length > 0`, `<InlineParts :parts="call.detail">`
  inside a `<Pill>` with the appropriate detail tone. File/url
  clicks are routed by `InlineParts.vue` via `<router-link>` and
  `<a>` — sibling DOM nodes of the toggle, not nested inside it.
- The chip body, rendered when `expanded`, contains
  `<FormattedContent :content="callContentRaw" />` and, when
  `result !== null`, `<FormattedContent :content="resultContentRaw" />`
  (raw payload strings forwarded from the caller's `ToolPair`
  view-model; see F03 r2 §7.2).

The chip emits **only** `toggle`. No `navigateFile`, no
`navigateUrl`, no `openFile` emits — those would require the chip
to know about the file store / router, breaking the §1.2
discriminator. The r1 design's chip emits are withdrawn.

**Landing:** `conversation/ToolChip.vue` is committed in the **F03
PR** (per F03 r2 §8.2 and F04 r3 §11.2), together with the swap
that retires `chat/AnalystChatPanel.vue`'s in-line `.tool-chip*`
markup and scoped styles. F02 r2 owns only the API written above;
the file's first appearance at HEAD is inside the F03 batch's PR.
This is the binding cross-batch coordination that resolves
Blocking 2.

#### 1.3.15 `conversation/ThinkingDots.vue`

```ts
defineProps<{ ariaLabel?: string }>();
```

Three `<span>` children riding `.pulse` (F01 r1). Layout-only scoped
style. No pattern-class extensions (analysis §2.3).

#### 1.3.16 F03-owned composites (API placeholders only)

`RoundCard.vue`, `DiagnosticRow.vue`, `PendingCallFooter.vue`,
`CompactedCluster.vue`, `ContextBlock.vue` ship in the F03 batch
([F03 r2 §3.4](../F03-conversation-rounds/01-analysis-r2.md#34-component-sketch)).
F02 owns only the directory + composition rules (§1.2). All five
satisfy the §1.2 discriminator (no store/router/transport imports;
F03 confirms).

### 1.4 Deletion matrix (commit-bound)

The exhaustive deletion matrix lives in
[analysis r2 §4.1–4.13](01-analysis-r2.md#4-deletion--migration-matrix).
This design adds commit-level grouping. The change vs r1 is that
**C5 is now the combined "shared `ToolChip` + AnalystChatPanel
swap" boundary**, which lands inside the F03 PR. C13 keeps the
rest of the analyst panel primitive migration (composer, badges,
toaster), but **not** the chip swap — the chip swap is in C5.

| Commit | New primitive(s) introduced | Selector blocks deleted in same commit (file paths) |
| --- | --- | --- |
| C1 | `ui/Button.vue` | additive |
| C2 | `ui/Pill.vue`, `ui/StatusDot.vue`, `ui/Card.vue`, `ui/PanelHeading.vue`, `ui/Spinner.vue`, `ui/Overlay.vue` + the F01 r2 extension patterns | additive (F01 extensions land here) |
| C3 | `content/CodeBlock.vue` + `content/MarkdownText.vue` (moves) | delete `web/src/components/code/CodeBlock.vue`, `code/MarkdownText.vue`, and the now-empty `web/src/components/code/` directory; update consumer imports atomically. No alias. |
| C4 | `content/JsonView.vue`, `content/FormattedContent.vue`, `content/InlineParts.vue` + `web/src/utils/json-tokenize.ts` extraction (F05 r2 §7.1) | additive (F05 r2 batch); tool-presenters port to `presentToolCall` / `presentToolResult` / `InlinePart` is co-committed (F05 r2 §2) |
| **C5** | **`conversation/MessageBubble.vue`, `conversation/ThinkingDots.vue`, `conversation/ToolChip.vue`** (the shared chip ships HERE inside the F03 PR) **+ the `AnalystChatPanel.vue` chip swap + the new adapter file `chat/tool-chip-adapter.ts` and the pairing utility `chat/analyst-timeline.ts`** | **delete the `<button class="tool-chip">…</button>` markup block in `chat/AnalystChatPanel.vue` and its scoped `.tool-chip*` block in the same commit (analysis §4.10 `.tool-chip*` family, `.pending-tool-*`). Migrate `analyst-chat-panel.test.ts` selectors to `data-testid="tool-chip"` + `data-status` in the same commit. After C5 there is exactly one chip renderer at HEAD.** Coordinated with the F03 PR per F03 r2 §8.2. |
| C6 | `auth/ApiTokenEntry.vue` rewritten on `Overlay` + `Button` | analysis §4.2 — `.token-overlay`, `.token-dialog`, `.token-btn*`, `.token-toggle`, `nav/NavRail.vue`'s `.api-token-btn` |
| C7 | `layout/AppShell.vue` (auth banner) + `layout/WorkspaceHeader.vue` | analysis §4.1, §4.3 — `.auth-required-banner`, `.auth-banner-*`, `.ws-chip`, `.runtime-chip`, `.pause-chip`, `.chip-dot` |
| C8 | `views/DashboardView.vue` rewrite | analysis §4.5 — `.refresh-btn`, `.runtime-banner.banner-*`, `.error-banner`, `.actionable-error`, `.status-loading`, `.cue-chip`, `.detail-callout`, `.dc-*`, `.csb-*`. Pure-layout `.status-section`, `.status-grid`, `.section-label`, `.csb-*` survive but lose all colour/border |
| C9 | `views/FilesView.vue` rewrite | analysis §4.6 — `.files-global-banner.banner-*`, `.viewer-state`, `.viewer-close-btn`, `.sv-fetch-btn`. Layout-only `.file-panel`, `.file-list`, `.file-entry`, `.crumb*`, `.file-viewer` survive |
| C10 | `views/DebugView.vue` rewrite | analysis §4.7 — every `.debug-*`, `.dg-item`, `.mcp-*`, `.sv-*`, `.doctor-*`, `.check-*`, `.operator-banner-*` listed there |
| C11 | `components/agents/AgentConversationView.vue` rewrite (F03 lands the round bodies; F02 lands the toolbar/state-panel migration here) | analysis §4.8 — `.conv-tb-btn`, `.conv-toolbar`, `.conv-header`, `.conv-model`, `.conv-role`, `.conv-info`, `.conv-status-badge.*`, `.conv-empty`, `.conv-loading`, `.conv-error`, `.conv-warning`. The `.tc-*`/`.tr-*` families and `.conv-step`/`.conv-message` are deleted in the F03 batch (coordinated; see §1.6). |
| C12 | `components/agents/RawLlmExchangePanel.vue` rewrite | analysis §4.9 — `.rlp-*` |
| C13 | `components/chat/AnalystChatPanel.vue` non-chip rewrite (F04 owns the broader chat decomposition; F02 lands the primitive migration of the surviving panel scope) **— the chip swap already happened in C5; this commit does NOT touch `.tool-chip*` (already gone)** | analysis §4.10 (minus the chip family): `.primary-btn`, `.message-bubble`, `.msg.role-*`, `.msg-meta`, `.msg-content`. Layout-only `.chat-body`, `.chat-composer`, `.composer-footer`, `.composer-input` survive. `AnalystToaster.vue`'s `.toast` becomes `<Card>` per toast. |
| C14 | `components/cards/*.vue` rewrites (in this order: `StaleWarningRibbon`, `CardHistoryPanel`, `CardDetailView`, `CardsBoardView`, `CardsLeaderboardView`, `CardsTreeView`, `CardsTimelineView`) | analysis §4.11 |
| C15 | `components/nav/NavRail.vue` rewrite | analysis §4.4 |

The 15-commit sequence is the **landing order**. C5 is the binding
boundary: it adds `MessageBubble.vue`, `ThinkingDots.vue`,
**`ToolChip.vue`** (the shared chip), the F04 adapter, the F03
pairing utility, swaps `AnalystChatPanel.vue` to consume the shared
chip, and deletes the `.tool-chip*` family in `AnalystChatPanel.vue`
in the same commit. After C5 there is exactly one chip renderer at
HEAD, satisfying the F03 r2 §8.2 invariant.

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
    JsonView.test.ts           ← new (F05 r2 §8.2)
    FormattedContent.test.ts   ← new (F05 r2 §8.3)
    InlineParts.test.ts        ← new (F02 r2; renders the InlinePart kinds; matches F05 r2 §6)
  conversation/
    MessageBubble.test.ts
    ToolChip.test.ts           ← F02 r2 §5 + F03 r2 §10.5 lifecycle cases (committed in F03 PR alongside the SFC)
    ThinkingDots.test.ts
    (F03 batch adds: RoundCard.test.ts, DiagnosticRow.test.ts, PendingCallFooter.test.ts, …)
  utils/
    json-tokenize.test.ts      ← F05 r2 §8.1
  (existing surface tests, rewritten per analysis §5.2)
```

`code-block.test.ts` and `markdown-text.test.ts` move via `git mv`
into the new `content/` test folder; the contents are rewritten to
the new prop API (relocated SFC, identical surface).

**Pattern-class assertions live in `ui/`/`content/`/`conversation/`
unit tests only.** Surface tests stop asserting `.btn`/`.pill`/`.card`;
they assert via `getByRole`, `getByText`, or the new `data-testid`
column in analysis §5.2.

**F04 adapter tests live with the F03 PR (binding).** Per F04 r3
§11.2, `chat/tool-chip-adapter.test.ts` (covering
`adaptChatMessageToToolChip`, `adaptPendingInvocationToToolChip`,
`synthesizeCallFromResult`) ships in the same PR as the
AnalystChatPanel chip swap (C5). Test cases (F04 r3 §10
references):

- `adaptChatMessageToToolChip emits status="missing" when result is null`.
- `adaptChatMessageToToolChip emits status="orphan" when call is synthesised from a result`.
- `adaptChatMessageToToolChip emits status="ok"|"error" when both call and result are present, forwarding the F05 presenter's `status`.
- `adaptPendingInvocationToToolChip emits status="pending" and result=null`.
- `adaptPendingInvocationToToolChip's detailsId is "tool-detail-pending-${pending.id}"`.

`ToolChip.test.ts` ships the F03 r2 §10.5 cases verbatim:

- `ToolChip > maps chipStatus pending → wrapper card tone warn`.
- `ToolChip > maps chipStatus ok → tone accent`.
- `ToolChip > maps chipStatus error → tone danger`.
- `ToolChip > maps chipStatus orphan → tone warn`.
- `ToolChip > maps chipStatus missing → tone warn with "(no result yet)" muted suffix`.
- `ToolChip > renders call FormattedContent only when expanded and call exists`.
- `ToolChip > renders result FormattedContent when expanded and result is non-null`.
- `ToolChip > does not render result FormattedContent when result is null`.
- `ToolChip > aria-expanded reflects expanded` (carried from F02 analysis §5.5).
- `ToolChip > aria-controls matches detailsId` (carried from F02 analysis §5.5).
- `ToolChip > clicking the header button emits 'toggle'` (carried from F02 analysis §5.5).
- `ToolChip > chip root is role="group" with the toggle as the only nested <button>` (F05 r2 §6).

The "wrong" r1 cases (`status: 'call'|…`, `view: ToolPresentationView`)
are withdrawn.

### 1.6 Cross-batch coordination (F03 / F04 / F05)

Binding cross-issue ordering, restated for clarity. This is the
authoritative answer to review r1 Blocking 2.

```
F01 r2 ─► F02 r2 (C1–C3, the additive ui/ + content/code-move) ─►
F05 r2 batch (C4: JsonView/FormattedContent/InlineParts + tokenizeJson
              + tool-presenters port to presentToolCall/Result + InlinePart) ─►
F03 r2 batch (C5: combined commit containing
              · conversation/ToolChip.vue (final F02 r2 API)
              · conversation/MessageBubble.vue + ThinkingDots.vue
              · chat/tool-chip-adapter.ts (F04 r3 §4.1 adapters)
              · chat/analyst-timeline.ts (F03 r2 §3.4 pairAnalystMessages)
              · AnalystChatPanel.vue chip swap (in-line .tool-chip*
                  markup + scoped CSS deleted, replaced with
                  <ToolChip v-bind="adaptChatMessageToToolChip(...)" />)
              · analyst-chat-panel.test.ts selector migration
              · F03's round/diagnostic/pending/compacted/context bodies
              · AgentConversationView .tc-*/.tr-*/.conv-step/.conv-message
                  deletion
              · ToolChip.test.ts + RoundCard.test.ts + … new tests) ─►
F02 r2 (C6–C15) ─►
F04 batch (the analyst-surface decomposition: ChatHeader / MessageList /
           MessageItem / JumpToLatest / ChatComposer + composables;
           the chip swap has already happened, F04 just relocates the
           v-bind="adapt…" call site from AnalystChatPanel.vue into the
           decomposed MessageItem.vue).
```

Three invariants the sequence preserves end-to-end:

- **One chip renderer at HEAD.** From C5 onward, `conversation/ToolChip.vue`
  is the only chip in the tree; `chat/AnalystChatPanel.vue` and
  `components/agents/AgentConversationView.vue` (when its body is
  rewritten in F03's part of C5) both consume the shared chip. There
  is no commit at which two chip renderers coexist.
- **One `InlinePart` definition.** F05 r2 §3 exports `InlinePart`
  from `web/src/utils/tool-presenters.ts`. C4 ships this; C5
  consumes it. No re-definition in F02, F03, or F04.
- **One `FormattedContent` definition.** F05 r2 §7.3 owns the
  `content: string` contract. F02 r2 §1.3.11 places the SFC under
  `content/`. F03's chip body, F04's chip body call site, and any
  future surface call import from the same path. No competing
  parts-renderer also named `FormattedContent` exists at any HEAD
  state.

### 1.7 Build / typecheck impact

- **Net SFC count:** +14 new SFCs in `ui/` (7) + `content/` (3 new
  + 2 moved) + `conversation/` (2 in F02; F03 adds 6 more in its
  batch including `ToolChip.vue`). Net deletions:
  `web/src/components/code/` directory (2 files) plus the bespoke
  `<style scoped>` blocks across 15+ consumer files.
- **Bundle size:** projected slight decrease.
- **`npx vue-tsc --noEmit`:** must stay green commit-by-commit.
- **Vitest:** new `ui/`/`content/`/`conversation/` unit tests are
  pure-component tests; ≤ 2 s wall-clock impact.
- **ESLint:** the five `no-restricted-imports` overrides in §1.2 run
  in the existing pipeline.

### 1.8 Story / visual-diff plan

**Decision: no Storybook, no Histoire, no Chromatic.** Reasoning
unchanged from r1: pattern stylesheet is the design source of
truth; visual regressions caught by `__tests__/ui/*` prop→class
unit tests + the existing
[saivage-e2e-checkers/](../../../../saivage-e2e-checkers/) Playwright
suite + the dual-LLM review process.

### 1.9 Selector survival cheatsheet (informational)

Unchanged from r1. A scoped class is allowed to survive iff its
rule body, after F02 lands, contains only `display`, `position`,
`top/right/bottom/left/inset`, `z-index`, `grid-*`, `flex-*`, `gap`,
`row-gap`, `column-gap`, `justify-*`, `align-*`, `place-*`, `order`,
`padding/padding-*`, `margin/margin-*`, `width/height`,
`min/max-width`, `min/max-height`, `overflow/overflow-*`,
`white-space`, `word-break`, `overflow-wrap`, `text-overflow`,
`cursor`, `user-select`, `pointer-events`, `box-sizing`, `transform`,
layout-only `transition`, `opacity`.

Forbidden: `color`, `background`, `background-color`, `border`
(except `none`), `border-*`, `border-radius`, `box-shadow`,
`outline` (move to F01's `.focus-visible` pattern), hex literals,
`rgb()`/`rgba()` literals, named colours.

CI gate: a custom `stylelint` rule (or a shell `rg` check) flags
any surviving file under `components/` whose `<style scoped>` block
contains a forbidden property.

---

## 2. Proposal B — Feature-slice with role-based co-location

The "one level up" alternative. Treatment is essentially r1's; the
chip-API correction propagates to Proposal B as well (the
`features/conversation/ToolChip.vue` API is identical to the
Proposal A signature in §1.3.14).

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
    InlineParts.vue
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
      AgentConversationView.vue
      RawLlmExchangePanel.vue
      useAgentTimeline.ts
      timeline.ts
      round-id.ts
      types.ts
      __tests__/
    chat/
      AnalystChatPanel.vue
      AnalystToaster.vue
      ChatHeader.vue
      MessageItem.vue
      MessageList.vue
      ChatComposer.vue
      JumpToLatest.vue
      tool-chip-adapter.ts
      analyst-timeline.ts
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
    files/      …
    dashboard/  …
    debug/      …
    agents-list/…
    auth/       …
    shell/      …
  router/
  stores/
  utils/
  styles/
```

`MessageBubble`/`ToolChip` live with `features/conversation/`; the
flat `lib/` only holds genuinely cross-feature primitives.

### 2.2 New primitives

Same prop signatures as Proposal A for every primitive listed in
§1.3.1–1.3.7 and §1.3.10–1.3.12. `ToolChip` and `MessageBubble`
move from a shared folder into `features/conversation/`; their
APIs are unchanged.

### 2.3 Deletion matrix

Verbatim from §1.4. Import paths change but selectors deleted are
identical. C5 (chip swap) is the same binding boundary; under
Proposal B, the file is `features/conversation/ToolChip.vue` and
the analyst panel lives at `features/chat/AnalystChatPanel.vue`.
Net additional deletions: whole-tree file moves.

### 2.4 Test reorganisation

`__tests__/` folders co-locate inside each feature slice.
`ToolChip.test.ts` ships under `features/conversation/__tests__/`;
adapter tests under `features/chat/__tests__/`.

### 2.5 Build / typecheck impact

- Barrel re-export cost: HMR invalidation expands to every importer.
- Whole-tree import churn (~70+ imports across the codebase).
- ~12 router definition changes (`views/` paths).

### 2.6 Story / visual-diff plan

Same as A (no Storybook).

### 2.7 Why this proposal is plausible

- Discoverability: "where is chat?" → `features/chat/`.
- Refactor locality.
- Mirrors F03 r2 §3.2's utility split style.
- Shorter import paths.

### 2.8 Why this proposal still falls short

- Cross-feature composition: `MessageBubble` and `ToolChip` are
  consumed by both `features/chat/` (F04) and `features/conversation/`
  (F03). Either feature-slice rule is violated (sibling imports) or
  the conversation composites move to `lib/` (lib is no longer just
  primitives).
- Discriminator drift: `features/<slice>/` mixes container files
  (store-importing) and presentation files. We lose the
  structural enforcement that ESLint provides per directory.
- Test discovery: net neutral.
- Migration churn: same F02 work + whole-tree `git mv`.
- F01/F03/F04/F05 contracts cite `components/ui|content|conversation/`
  by path; re-review surface is large.

### 2.9 Variants of B considered and rejected within B

- `components/lib/` flat (no `features/`): loses discoverability.
- Prefixed flat names: no tooling enforces the convention.

---

## 3. Per-primitive TypeScript prop interfaces (verbatim)

These apply to both Proposal A and Proposal B (B only changes file
paths, not signatures).

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
// slots: 'title', 'meta', 'actions'
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
const props = withDefaults(defineProps<{
  data: unknown;
  maxHeight?: string;
  copyable?: boolean;
}>(), { maxHeight: '60vh', copyable: false });
```

```ts
// content/FormattedContent.vue   (F05 r2 §7.3 — parses raw content; delegates)
defineProps<{
  content: string;
  maxHeight?: string;
}>();
```

```ts
// content/InlineParts.vue        (F05 r2 §6 — renders InlinePart[])
import type { InlinePart } from '../../utils/tool-presenters';
defineProps<{
  parts: InlinePart[];
}>();
// no emits — file/url click routing uses <router-link>/<a> from the template
```

```ts
// conversation/MessageBubble.vue
defineProps<{
  role: 'user' | 'assistant' | 'system';
  kind?: 'reasoning' | 'activity' | 'plain';
  timestamp?: string;
  modelLabel?: string;
}>();
// slots: 'default', 'meta', 'badges'
```

```ts
// conversation/ToolChip.vue       (final API; ships in F03 PR)
import type {
  ToolCallPresentation,
  ToolResultPresentation,
} from '../../utils/tool-presenters';
import type { ToolPairStatus } from '../../utils/agent-timeline/types';
defineProps<{
  call: ToolCallPresentation;
  result: ToolResultPresentation | null;
  status: ToolPairStatus;     // 'pending' | 'ok' | 'error' | 'orphan' | 'missing'
  expanded: boolean;
  detailsId: string;
  timestamp?: string;
}>();
defineEmits<{ (e: 'toggle'): void }>();
```

```ts
// conversation/ThinkingDots.vue
defineProps<{ ariaLabel?: string }>();
```

F03-owned composites (`RoundCard`, `DiagnosticRow`,
`PendingCallFooter`, `CompactedCluster`, `ContextBlock`) inherit
their prop signatures from
[F03 r2 §3.4](../F03-conversation-rounds/01-analysis-r2.md#34-component-sketch).

---

## 4. Pattern extensions to F01 r2 (binding)

F02 introduces no new tokens. It introduces the following pattern-
class extension rules, all enumerated in
[analysis r2 §2.2](01-analysis-r2.md#22-f02-extensions-to-f01-must-land-in-f01-r2)
and restated here as a concrete patch against F01 r2's
`patterns.css`:

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

These rules land in C2, in F01 r2's `patterns.css`. They are the
**only** F02→F01 contributions.

---

## 5. Test surface summary

### 5.1 New tests (Proposal A paths)

| File | Lines (est.) | Asserts |
| --- | --- | --- |
| `web/src/__tests__/ui/Button.test.ts` | 80 | variant → class; iconOnly → `.btn-icon`; aria-pass-through; emit `click` |
| `web/src/__tests__/ui/Pill.test.ts` | 90 | tone → class; `as="button"` → `<button>` root; aria-pressed pass-through |
| `web/src/__tests__/ui/Card.test.ts` | 60 | tone → class; `as` → element; active → `.card-active` |
| `web/src/__tests__/ui/PanelHeading.test.ts` | 50 | level → `<h2>`/`<h3>`; three named slots render |
| `web/src/__tests__/ui/StatusDot.test.ts` | 40 | tone → class; aria-hidden by default; aria-label flips to role="img" |
| `web/src/__tests__/ui/Spinner.test.ts` | 30 | size → scoped class; aria-label / aria-hidden |
| `web/src/__tests__/ui/Overlay.test.ts` | 200 | seven cases from analysis §5.4 (focus trap, restore, escape, backdrop, inert, modal flag, multi-overlay) |
| `web/src/__tests__/content/CodeBlock.test.ts` | 150 | rewritten from existing `code-block.test.ts`; oversize emit; copy button |
| `web/src/__tests__/content/MarkdownText.test.ts` | 90 | rewritten from existing `markdown-text.test.ts` |
| `web/src/__tests__/content/JsonView.test.ts` | 80 | F05 r2 §8.2 cases (token spans; >1 MB plain pre fallback; undefined data) |
| `web/src/__tests__/content/FormattedContent.test.ts` | 120 | F05 r2 §8.3 cases (direct JSON object; direct JSON array; invalid leading `{` falls back to text; extracts after "Tool result:"; extracts after "Error:"; non-allowlisted prose with braces stays text; plain prose routes through MarkdownText; empty input) |
| `web/src/__tests__/content/InlineParts.test.ts` | 100 | each `InlinePart.kind` renders correctly (`file` → `<router-link>` with `query.path` + `query.root`; `url` → `<a target="_blank" rel="noopener noreferrer">`; `code` → `<code class="inline-code">`; `text` → `<span class="inline-text">` with optional `.tone-*` class); `shortPath` shrinkage on long file paths |
| `web/src/__tests__/utils/json-tokenize.test.ts` | 120 | F05 r2 §8.1 cases (12 tokeniser cases) |
| `web/src/__tests__/conversation/MessageBubble.test.ts` | 90 | role → tone class; slots; reasoning kind layout |
| `web/src/__tests__/conversation/ToolChip.test.ts` | 180 | F03 r2 §10.5 lifecycle cases (pending/ok/error/orphan/missing → Card tone; call/result `FormattedContent` rendering) + F02 r2 chip contract (aria-expanded reflects `expanded`; aria-controls === `detailsId`; toggle emit; chip root role="group" + single nested `<button>`) |
| `web/src/__tests__/conversation/ThinkingDots.test.ts` | 30 | three children riding `.pulse` |
| `web/src/__tests__/components/chat/tool-chip-adapter.test.ts` | 140 | F04 r3 §4.1 cases (`adaptChatMessageToToolChip` missing/orphan/ok/error; `adaptPendingInvocationToToolChip` always pending + null result; `detailsId` format) — committed in F03 PR per F04 r3 §11.2 |

Total ≈ 1,600 lines of new unit + utility tests, replacing
roughly 1,800 lines of fragile bespoke-class surface assertions
across the existing test files (per analysis §5.2).

### 5.2 Rewritten surface tests

Each surface test file in
[analysis §5.2](01-analysis-r2.md#52-affected-test-files-from-grep-over-wrapperfindfindallget)
stops asserting bespoke classes and starts asserting via
`data-testid` / `role` / text. Strategy column (a/b/c from analysis
§5.1) is preserved.

`analyst-chat-panel.test.ts` migrates its `.tool-chip` queries to
`[data-testid="tool-chip"]` + `data-status` **in the C5 commit**
(same PR as the chip swap), per F03 r2 §8.2.

CI gate: a custom test job `web:no-bespoke-class-assertions` runs
`rg -n "find\\('\\.[a-z]" web/src/__tests__/` and fails on any new
matches outside the `ui/`/`content/`/`conversation/` test folders.

---

## 6. Build / typecheck / lint impact (consolidated)

- **`npx vue-tsc --noEmit`:** must stay green commit-by-commit.
  ~15 new SFCs (3 added in C4 — `JsonView`, `FormattedContent`,
  `InlineParts` — extra vs r1's count). Per-SFC compile time
  ~20 ms in vue-tsc 2.x. Net delta ≤ 350 ms.
- **`npm run build` (Vite production):** projected slight bundle
  size decrease. No new dependencies; `Spinner` consumes
  `lucide-vue-next` already in the bundle.
- **`npm test` (Vitest):** ~1,600 new lines of unit tests; ≤ 2 s
  wall-clock impact. Surface tests get faster on average because
  role/text queries are quicker than CSS selector traversal.
- **`npx eslint`:** five new `no-restricted-imports` blocks, all
  scoped via `overrides[*].files`. Adds ~50 ms to a full lint.

---

## 7. Story / visual-diff plan (consolidated)

No story tooling. Visual regressions caught by:

1. `__tests__/ui/*` prop→class unit tests (catch tone misroutes).
2. The existing
   [saivage-e2e-checkers/](../../../../saivage-e2e-checkers/) Playwright
   suite, which renders each major surface and screenshots them.
3. Pattern stylesheet is the single source of truth.

---

## 8. Risks and open questions

| Risk | Mitigation |
| --- | --- |
| `Spinner` violates the "ui/ may not import lucide-vue-next" rule. | Single-file ESLint exception (§1.2 block #2). Fallback (CSS-only spinner) ready if reviewer rejects. |
| `ToolChip` consumes `ToolPairStatus` (from F03's types module) and `ToolCallPresentation`/`ToolResultPresentation` (from F05's `tool-presenters.ts`). Drift between F03/F05/F04 batches could break the chip. | C5 explicitly imports from the F05-final `tool-presenters.ts` (committed in C4) and from the F03-final `utils/agent-timeline/types.ts`. C4 is committed before C5; F03 PR contains both ToolChip.vue and AnalystChatPanel swap so the adapter typechecks before merge. |
| `Overlay` hand-rolled focus trap is subtle. | Tests in §5.1 enumerate seven cases. Fallback to `radix-vue` `<Dialog>` recorded in analysis §8.3. |
| F03 owns five composites inside `conversation/`. If F03 slips, F02 ships a partial subset of the folder. | Acceptable: C1–C2 ships `MessageBubble` + `ThinkingDots` only; the directory exists with two files initially. C5 (the F03 PR) fills the rest. |
| Stylelint / `rg` gate for surviving-scoped-style colour properties might over-flag legitimate `outline` rules for focus-visible. | F01 r2 owns `.focus-visible` pattern; consumers reference it. The gate is allowed to flag any `outline` outside `styles/`. |
| F04 expects `MessageBubble` and `ToolChip` to be ready BEFORE its chat decomposition. | F02 C1–C2 ships `MessageBubble` early; the shared `ToolChip` lands in C5 inside the F03 PR. F04 begins after C5. |
| Removing `web/src/components/code/` could break IDE bookmarks / external docs. | Acceptable per project guideline. Docs and SPEC files referencing the old path are updated in C3. |
| Proposal B's whole-tree import churn risks merge conflicts. | N/A to Proposal A; documented for completeness. |
| F05 r2 places `JsonView` and `FormattedContent` under `components/ui/`. F02 r2 places them under `components/content/`. | F02 r2 path wins (analysis r2 §1; F05 r2 §7.3 already cites `MarkdownText` under `content/`). The F05 batch (C4) creates the files under `content/` and updates F05's references accordingly. This is path bookkeeping, not a contract change. |

Open questions for the reviewer (Q3 from r1 is **closed**, see
review r1 non-blocking note "Q3 already answered by F05 r2"):

- **(Q1)** Does the F01 r2 `patterns.css` deliverable include the
  extension rules in §4, or should this design land them inline
  as F02-owned and merge them into F01 in a follow-up?
- **(Q2)** Is the `.tablist > .pill[aria-pressed="true"]` ARIA-
  selector pattern acceptable? Alternative: a `.pill-pressed`
  modifier toggled by Vue. Tradeoff: ARIA selector lets the CSS
  follow the source-of-truth attribute; the class toggle is more
  conventional but introduces an `aria-pressed`-driven `watch` in
  every tablist consumer.
- **(Q3, closed)** `FormattedContent` parses raw tool-detail
  content (F05 r2 §7.3); inline headline/detail parts are rendered
  by `InlineParts.vue` (F05 r2 §6). This design adopts both names
  verbatim; the r1 confusion is withdrawn.

---

## 9. Recommendation

**Adopt Proposal A.**

Reasoning unchanged from r1 (clean architecture, F01 token
consumption parity, F03/F04/F05 alignment, smaller test surface
delta, smaller migration footprint, ESLint discriminator
enforceable per directory). The r2 corrections to chip API,
`FormattedContent` naming, and the C5 boundary all preserve A's
advantage over B.

**Chosen letter: A.**

---

## 10. Out of scope (carry-overs to other batches)

- Tokenization utility extraction (`tokenizeJson`) — F05 r2 §7.1;
  ships in C4.
- F03's round bodies (`RoundCard`, `DiagnosticRow`,
  `PendingCallFooter`, `CompactedCluster`, `ContextBlock`) — F03
  batch (C5).
- F04's chat decomposition (`ChatHeader`, `MessageList`,
  `MessageItem`, `ChatComposer`, `JumpToLatest`) — F04 batch (post
  C15).
- Form-control primitives (input, textarea, select) — explicitly
  excluded per analysis §6.7.
- Headless-UI dependency adoption (radix-vue / reka-ui /
  @headlessui/vue) — explicitly rejected per analysis §8.3.

---

## 11. File outcomes (informational, Proposal A)

- **Created (SFCs):** 7 in `ui/`, 5 in `content/` (3 new + 2
  moved), 2 in `conversation/` owned by F02 (`MessageBubble`,
  `ThinkingDots`); 6 more in `conversation/` shipped by F03 PR
  (`ToolChip`, `RoundCard`, `DiagnosticRow`, `PendingCallFooter`,
  `CompactedCluster`, `ContextBlock`).
- **Relocated:** `web/src/components/code/CodeBlock.vue` →
  `web/src/components/content/CodeBlock.vue`,
  `web/src/components/code/MarkdownText.vue` →
  `web/src/components/content/MarkdownText.vue`. `code/` directory
  removed.
- **Modified:** every consumer file enumerated in
  [analysis §4](01-analysis-r2.md#4-deletion--migration-matrix);
  `chat/AnalystChatPanel.vue` is swapped to the shared `ToolChip`
  in C5 (inside the F03 PR).
- **F01 r2 `patterns.css`:** extension rules listed in §4.
- **ESLint config:** five `no-restricted-imports` overrides
  (§1.2).
- **No barrels added.** No `index.ts` under `ui/`, `content/`, or
  `conversation/`.

Exact landing order is §1.4's 15-commit sequence, with C5 as the
combined "shared `ToolChip` + AnalystChatPanel swap" boundary
co-owned with the F03 PR. The reviewer-phase document
(`02-design-review-r2.md`) will critique this; the implementation
plan (`03-plan-r1.md`) will translate this into checklists, test
commands, and per-commit acceptance criteria.
