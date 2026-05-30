# F02 — Component hierarchy / UI primitive layer — Design (r3)

Writer round 3 of the design phase. Addresses every blocking and
required item in
[02-design-review-r2.md](02-design-review-r2.md) (VERDICT:
CHANGES_REQUESTED). Implements the approved analysis
[01-analysis-r2.md](01-analysis-r2.md) and consumes the sibling
designs
[F01 design r2](../F01-design-tokens/02-design-r2.md),
[F03 design r2](../F03-conversation-rounds/02-design-r2.md),
[F04 r3 analysis](../F04-chat-surface-style/01-analysis-r3.md),
[F05 design r2](../F05-tool-detail-rendering/02-design-r2.md).

**Project guideline (binding, repeated for emphasis):** architecture-
first, no backward compatibility. Every bespoke v3 selector
enumerated in analysis §4 is **deleted in the same commit** that
introduces its replacement primitive. No `@deprecated` re-exports,
no `.legacy-*` holdovers, no alias period, no `index.ts` barrels
under `ui/` / `content/` / `conversation/` (analysis §10). The one
explicit barrel in the cross-issue graph is the F05 r2 §3 public
presenter surface, `web/src/utils/tool-presenters/index.ts`; the
old single-file `web/src/utils/tool-presenters.ts` is **deleted**
in C4 (no re-export shim — see §0).

---

## Coverage map (review r2 → r3 section)

| Review r2 item | Status | r3 section(s) |
| --- | --- | --- |
| **Blocking 1** — `ToolChip` prop bag missing `callContent: string` / `resultContent: string \| null`; markup references undefined `callContentRaw` / `resultContentRaw`; not aligned with F03 design r2 §7.2 + F05 design r2 §4.1 | Fixed | [§0 cross-input table — F03 r2 §7.2 row](#0-inputs-consumed-from-sibling-designs); [§1.3.14 chip prop API](#1314-conversationtoolchipvue-final-api-ships-in-f03-pr) — full eight-prop bag; [§1.3.14 markup contract](#1314-conversationtoolchipvue-final-api-ships-in-f03-pr) — `<FormattedContent :content="callContent" />` / `<FormattedContent :content="resultContent" />` bound directly to props (no derived "raw" variables); [§3 verbatim interface block](#3-per-primitive-typescript-prop-interfaces-verbatim) — eight-prop signature; [§1.5 ToolChip.test.ts](#15-test-reorganisation) — adds `callContent` / `resultContent` assertions and adapter-driven prop-delivery cases; [§1.6 cross-batch coordination](#16-cross-batch-coordination-f03--f04--f05) — restates the eight-prop binding and the C4→C5 ordering. |
| **Blocking 1 (b)** — F05 canonical import path: `'../../utils/tool-presenters'` is the **barrel directory**, not the deleted single file | Fixed | [§0 cross-input table — F05 r2 §1.2 / §3 rows](#0-inputs-consumed-from-sibling-designs); [§1.1 file layout](#11-file-layout-final) (footnote on `utils/tool-presenters/`); [§1.3.12 InlineParts import](#1312-contentinlinepartsvue-new-per-f05-r2-6); [§1.3.14 ToolChip imports](#1314-conversationtoolchipvue-final-api-ships-in-f03-pr); [§3 verbatim block](#3-per-primitive-typescript-prop-interfaces-verbatim); [§1.4 deletion matrix — C4 row](#14-deletion-matrix-commit-bound) — explicit deletion of `web/src/utils/tool-presenters.ts` co-committed with directory creation, no re-export shim. |
| r2 Required 1 — chip API alignment with latest binding designs | Fixed (now eight props) | [§1.3.14](#1314-conversationtoolchipvue-final-api-ships-in-f03-pr), [§3](#3-per-primitive-typescript-prop-interfaces-verbatim) |
| r2 Required 2 — `FormattedContent` vs `InlineParts` separation | Already satisfied in r2; preserved | [§1.3.10–1.3.12](#1310-contentjsonviewvue-new-per-f05-r2-72) |
| r2 Required 3 — chip-swap landing boundary (C5) | Already satisfied in r2; preserved verbatim | [§1.4](#14-deletion-matrix-commit-bound), [§1.6](#16-cross-batch-coordination-f03--f04--f05) |
| r2 Required 4 — two real proposals | Preserved | [§1](#1-proposal-a--three-layer-split-ui-content-conversation), [§2](#2-proposal-b--feature-slice-with-role-based-co-location), [§9](#9-recommendation) |
| r2 Required 5 — per-primitive TS prop interfaces (incl. ToolChip eight-prop bag) | Fixed | [§1.3](#13-new-primitives--exact-prop-signatures-verbatim), [§3](#3-per-primitive-typescript-prop-interfaces-verbatim) |
| r2 Required 6 — deletion matrix and landing sequence | Preserved + C4 deletion of single-file presenters | [§1.4](#14-deletion-matrix-commit-bound) |
| r2 Required 7 — composition rules / ESLint overrides | Preserved verbatim | [§1.2](#12-composition-rules-enforced-by-code-review--eslint-no-restricted-imports) |
| r2 Required 8 — test reorganisation; ToolChip lifecycle + new `callContent` / `resultContent` cases | Fixed | [§1.5](#15-test-reorganisation), [§5.1](#51-new-tests-proposal-a-paths) |
| r2 Required 9 — cross-issue alignment with F03 r2 / F05 r2 final prop bag | Fixed | [§0](#0-inputs-consumed-from-sibling-designs), [§1.3.14](#1314-conversationtoolchipvue-final-api-ships-in-f03-pr), [§1.6](#16-cross-batch-coordination-f03--f04--f05) |
| r2 Required 10 — open questions | Preserved | [§8](#8-risks-and-open-questions) |
| r2 Non-blocking — `JsonView` / `FormattedContent` path correction (`content/`) | Preserved | [§1.3.10–1.3.11](#1310-contentjsonviewvue-new-per-f05-r2-72), [§8 last risk row](#8-risks-and-open-questions) |
| r2 Non-blocking — composition-rule prose around `content/*` importing other content files | Fixed (table row explicit) | [§1.2 table — `content/*` row](#12-composition-rules-enforced-by-code-review--eslint-no-restricted-imports) |
| r2 Non-blocking — architectural cleanup (no shims, no barrels, no alias period) | Preserved | this header + [§10](#10-out-of-scope-carry-overs-to-other-batches) |

This document otherwise inherits r2's structure verbatim where no
substantive change is needed. The r3 corrections are concentrated in
§0, §1.1, §1.3.12, §1.3.14, §1.4 (C4 row), §1.5 (chip tests), §1.6,
§3 (chip block), §5.1 (chip + adapter test files), and §8 (chip
drift risk). Proposal B (§2) inherits the same chip eight-prop bag
by reference.

---

## 0. Inputs consumed from sibling designs

Cross-issue contracts F02 must satisfy. r3 replaces the r2 table
verbatim; the changed rows are F03 r2 §7.2, F05 r2 §1.2 / §3, and
F05 r2 §4.1.

| Source | Contract F02 owns |
| --- | --- |
| [F01 r2 §3.2](../F01-design-tokens/01-analysis-r2.md#32-semantic-layer-semanticcss--zero-hex-literals) | Semantic tokens (`--accent`, `--accent-2`, `--warn`, `--danger`, `--purple`, `--entry-*-{bg,border}`, `--btn-primary-*`) consumed only via pattern classes. F02 introduces zero new tokens; the pattern extensions listed below land in F01 r2's `patterns.css`. |
| [F01 r2 §2 (patterns.css)](../F01-design-tokens/01-analysis-r2.md#3-variable-inventory) | Extensions listed in analysis [§2.2](01-analysis-r2.md#22-f02-extensions-to-f01-must-land-in-f01-r2) (`.status-dot-{ok,warn,danger,accent,muted}`, `.card-{warn,danger,accent,user,purple}`, `.pill-purple`, and the conditional `.tablist > .pill[aria-pressed="true"]`). |
| [F03 r2 §3.1](../F03-conversation-rounds/01-analysis-r2.md#31-folder-layout-binding-to-f02-r2) | `web/src/components/conversation/` folder shape; ownership map of `RoundCard` / `DiagnosticRow` / `PendingCallFooter` / `CompactedCluster` / `ContextBlock` (F03 fills bodies). F02 owns the directory; F02 r3's API contribution to the conversation tier is `MessageBubble` + `ThinkingDots` only — `ToolChip.vue` is shipped by **the F03 PR** (per F03 r2 §8.2) with the F02 r3 API written here. |
| [F03 r2 §3.3 (`ToolPairStatus`)](../F03-conversation-rounds/01-analysis-r2.md#33-type-contracts-final) | `ToolPairStatus = 'pending' \| 'ok' \| 'error' \| 'orphan' \| 'missing'`. **This** is the chip's `status` union. F02 r3 imports it from `'../../utils/agent-timeline/types'` (F03's barrel; F03 r2 §3.1). |
| **[F03 r2 §7.2 (pair composition — eight-prop bag, BINDING)](../F03-conversation-rounds/02-design-r2.md#72-toolchipvue--prop-bag-and-template-fixed)** | **`ToolChip` prop bag (eight props, no slots): `call: ToolCallPresentation`, `result: ToolResultPresentation \| null`, `callContent: string`, `resultContent: string \| null`, `status: ToolPairStatus`, `expanded: boolean`, `detailsId: string`, `timestamp?: string`; emits `toggle` only.** The chip body renders `<FormattedContent :content="callContent" />` (always when expanded) and `<FormattedContent :content="resultContent" />` (only when `expanded && resultContent !== null`). File/url click routing is handled by `<InlineParts>` via `<router-link>` and `<a>` rendered as DOM siblings of the toggle inside the chip group (per F05 r2 §6 "no nested interactive elements"). |
| [F03 r2 §8.2 (chip-swap binding)](../F03-conversation-rounds/01-analysis-r2.md#82-analystchatpanel-toolchip-swap-resolution-to-r1-contradiction) | The F03 PR ships `conversation/ToolChip.vue` together with the swap of `chat/AnalystChatPanel.vue` from its in-line `.tool-chip*` markup to `<ToolChip v-bind="adaptChatMessageToToolChip(…)">`. F02's commit sequence (§1.4) reflects this: the analyst `.tool-chip*` family is deleted in the same commit (C5) that introduces the shared `ToolChip`. |
| [F04 r3 §3.3 / §4.0 / §4.1](../F04-chat-surface-style/01-analysis-r3.md#33-chatmessageitemvue) | `MessageBubble` and `ToolChip` are imported by `chat/MessageItem.vue` exactly as F02 r3 ships them. F04's adapter `chat/tool-chip-adapter.ts` exposes `adaptChatMessageToToolChip(call, result, expanded)` and `adaptPendingInvocationToToolChip(pending, expanded)`; both return the **eight-prop** bag above (including `callContent` / `resultContent`). F04 binds with `v-bind`. No `:view`, no `:message`, no chat-local chip API. |
| **[F05 r2 §1.2 / §3 (public presenter surface, BARREL)](../F05-tool-detail-rendering/02-design-r2.md#12-public-presenter-contract-unchanged-from-r1)** | **Public presenter exports live at `web/src/utils/tool-presenters/index.ts` (the barrel). The single file `web/src/utils/tool-presenters.ts` is *deleted* in C4 with no re-export shim (F05 r2 §3, review item 3).** Every F02-owned import resolves to the directory: `import type { ToolCallPresentation, ToolResultPresentation, InlinePart } from '../../utils/tool-presenters'`. The directory contains `index.ts`, `types.ts`, `registry.ts`, and per-tool modules registered via side-effect imports (F05 r2 §3.4); `package.json` marks `"./web/src/utils/tool-presenters/**"` as `sideEffects` to preserve registration under Rollup/Vite. F02 imports only the public re-exports from `index.ts`; F02 never imports a per-tool file. |
| [F05 r2 §4.1 (chip prop bag)](../F05-tool-detail-rendering/02-design-r2.md) | F05 r2 §4.1 cites the **eight-prop** chip bag verbatim. F02 r3 §1.3.14 ships exactly that signature; no drift. The presenter objects (`ToolCallPresentation`, `ToolResultPresentation`) carry only `{ icon, name, headline, detail, status }` — they do **not** carry `rawContent`. Raw payloads enter the chip through the `callContent` / `resultContent` props, supplied by `RoundCard` (F03 §7.3) or the F04 adapter (`tool-chip-adapter.ts`). |
| [F05 r2 §6 (chip markup)](../F05-tool-detail-rendering/01-analysis-r2.md#6-chip-markup-no-nested-interactive-elements) | Inline parts are rendered by `content/InlineParts.vue` (file → `<router-link>`, url → `<a>`, code → `<code>`, text → `<span>`). The chip is a `role="group"` `<div>` whose only `<button>` is the expand toggle; file/url links are DOM siblings of the toggle. F02 r3 ships `content/InlineParts.vue` with this exact contract. |
| [F05 r2 §7.3 (FormattedContent)](../F05-tool-detail-rendering/01-analysis-r2.md#73-websrccomponentsuiformattedcontentvue) | `content/FormattedContent.vue` accepts `content: string` (and an optional `maxHeight`), parses it as JSON-or-prose, and delegates to `content/JsonView.vue` or `content/MarkdownText.vue`. F02 r3 ships this SFC at `web/src/components/content/FormattedContent.vue` with the F05 r2 contract. |

Discriminator from analysis §1.3 (binding): any file importing
Pinia, Vue Router JS, fetch client, or the WebSocket client cannot
live in `ui/`, `content/`, or `conversation/`. It lives in its
surface folder. The single carve-out is `content/InlineParts.vue`,
which uses `<router-link>` (a globally registered Vue Router
template component) **in template only**; it does not import
`vue-router` JS or any store. This carve-out is documented in §1.2
block #4 and is the F05 r2 §6 contract — not new in this design.

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
      ToolChip.vue            ← F03 PR (uses F02 r3 eight-prop API; ships together with AnalystChatPanel swap)
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
  utils/
    tool-presenters/          ← F05 r2 §3 directory + index.ts barrel (single canonical import path '../../utils/tool-presenters')
      index.ts                ← public exports (InlinePart, ToolCallPresentation, ToolResultPresentation, presentToolCall, presentToolResult)
      types.ts
      registry.ts
      <per-tool>.ts …         ← side-effect-imported by index.ts (F05 r2 §3.4)
    tool-presenters.ts        ← DELETED in C4 (no re-export shim; F05 r2 review item 3)
    agent-timeline/           ← F03 r2 §3.1 directory; exports ToolPairStatus from index.ts
```

No `index.ts` barrel under any of the three new component folders
(analysis §10): each consumer writes an explicit import path. The
**only** barrel referenced across F02/F03/F04/F05 lives at
`web/src/utils/tool-presenters/index.ts` (F05-owned). F02 imports
through that barrel; never through a per-tool file.

### 1.2 Composition rules (enforced by code review + ESLint `no-restricted-imports`)

| Layer | May import from | Forbidden imports |
| --- | --- | --- |
| `ui/*` (except `ui/Spinner.vue`) | (nothing in this repo) | other `ui/*`, `content/*`, `conversation/*`, any `stores/*`, `vue-router`, `utils/api-client`, `lucide-vue-next` |
| `ui/Spinner.vue` (exception) | `lucide-vue-next` (for `Loader2` only) | same as the rest of `ui/*` except `lucide-vue-next` |
| `content/*` (general rule, applies to `CodeBlock`, `MarkdownText`, `JsonView`, `FormattedContent`) | `ui/*`, `utils/*`, `lucide-vue-next`, **and other `content/*` files** (the only inter-content imports allowed are: `FormattedContent → JsonView`; `FormattedContent → MarkdownText`; `MarkdownText → CodeBlock`. Other directions are forbidden by code review — there are no cycles.) | `stores/*`, `vue-router` JS, `utils/api-client`, `conversation/*` |
| `content/InlineParts.vue` (exception) | `ui/*`, `utils/*` (including the `tool-presenters/` barrel), `lucide-vue-next`, **and `<router-link>` as a globally registered template component** | `stores/*`, importing `vue-router` JS, `utils/api-client`, other `content/*`, `conversation/*` |
| `conversation/*` | `ui/*`, `content/*`, `utils/*` (including `tool-presenters/` and `agent-timeline/` barrels), `lucide-vue-next` | `stores/*`, `vue-router` JS, `utils/api-client`. Composition emits events; callers wire stores. |
| Surface folders (`agents/*`, `chat/*`, `cards/*`, `layout/*`, `nav/*`, `auth/*`, `views/*`) | anything | redefining pattern classes (`.btn`, `.pill`, `.card`, `.entry-*`) in their `<style scoped>` is forbidden |

ESLint config (added in this batch, lives in
[`web/.eslintrc.cjs`](../../../web/.eslintrc.cjs) or equivalent).
The five override blocks below are the **complete** machine-
checkable specification; unchanged verbatim from r2 except that the
`content/*` block's allowance for intra-content imports is now
explicit in the prose above (the ESLint blocks did not need to be
relaxed — they already permit it by omission).

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
//    Intra-content imports (FormattedContent → JsonView/MarkdownText; MarkdownText → CodeBlock)
//    are permitted by omission; code review enforces the no-cycle direction.
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

// 5) conversation/* composites — may import ui/, content/, utils/, lucide-vue-next, and F03/F05 utils barrels.
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

### 1.3 New primitives — exact prop signatures (verbatim)

Each file ships with `<script setup lang="ts">` plus a strict
`defineProps<{…}>()` generic. No `withDefaults` for required props.
No optional emit names. No PropTypes runtime layer.

Sections §1.3.1–§1.3.13 are unchanged verbatim from r2; reproduced
in compressed form here for diffability. The only substantive
rewrites in r3 are §1.3.12 (import-path tightening) and §1.3.14
(eight-prop chip bag).

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

#### 1.3.4 `ui/PanelHeading.vue`

```ts
defineProps<{ level?: 2 | 3; as?: 'header' | 'div' }>();
// slots: 'title', 'meta', 'actions'
```

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
  closeOnBackdrop?: boolean;
  ariaLabel: string;
  initialFocus?: 'first' | 'container';
  restoreFocus?: boolean;
}>();
defineEmits<{ (e: 'close'): void }>();
```

#### 1.3.7 `ui/Spinner.vue`

```ts
defineProps<{ size?: 'sm' | 'md' | 'lg'; ariaLabel?: string }>();
```

Renders a `Loader2` glyph from `lucide-vue-next` (single-file
ESLint exception per §1.2 block #2).

#### 1.3.8 `content/CodeBlock.vue` (relocated)

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
defineProps<{ text: string; inline?: boolean }>();
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
plain `<pre class="json-raw">`. Token classes are F01 r2 patterns
(`.syn-*`). F02 r3 introduces **no** new pattern classes here.

#### 1.3.11 `content/FormattedContent.vue` (new, per F05 r2 §7.3)

```ts
defineProps<{
  content: string;
  maxHeight?: string;
}>();
```

Behaviour (verbatim from F05 r2 §7.3):

1. Empty input → renders nothing (or an empty `<MarkdownText :text="" />`).
2. Trimmed starts with `{` / `[` → try `JSON.parse`; on success
   delegate to `<JsonView :data=… :max-height=… />`.
3. Otherwise locate the first `{` or `[` in `content`. If the
   leading prefix is empty OR matches `/^(Tool call|Tool result|Result|Error|Response|Request)\b/i`,
   try `JSON.parse(suffix)`; on success delegate to `<JsonView>`.
4. Otherwise delegate to `<MarkdownText :text="content" />`.

No emits. The chip body calls this with raw `callContent` and
(when non-null) raw `resultContent` strings; routing of file/url
clicks remains the responsibility of `InlineParts.vue` (used for
chip-header headline/detail), **not** of `FormattedContent`.

#### 1.3.12 `content/InlineParts.vue` (new, per F05 r2 §6)

```ts
import type { InlinePart } from '../../utils/tool-presenters';

defineProps<{ parts: InlinePart[] }>();
```

`'../../utils/tool-presenters'` resolves to the F05 r2 §3 directory
barrel `web/src/utils/tool-presenters/index.ts`. The deleted single
file `web/src/utils/tool-presenters.ts` is no longer present at
HEAD after C4 (see §1.4).

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
component; the SFC does **not** import `vue-router` JS (§1.2 block
#4). Click routing is therefore handled by Vue Router itself, with
no component-level emit, no store touch, and no chip-level emit
crossing component boundaries.

#### 1.3.13 `conversation/MessageBubble.vue`

```ts
defineProps<{
  role: 'user' | 'assistant' | 'system';
  kind?: 'reasoning' | 'activity' | 'plain';
  timestamp?: string;
  modelLabel?: string;
}>();
// slots: 'default' (content), 'meta', 'badges'
```

Renders `<article class="card card-{tone}">` with three rows
(meta / content / badges) as scoped flex layout. Role → tone table
from analysis §3.8.

#### 1.3.14 `conversation/ToolChip.vue` (final API; ships in F03 PR)

**Prop bag (eight props, no slots; verbatim from F03 r2 §7.2 and
F05 r2 §4.1):**

```ts
import type {
  ToolCallPresentation,
  ToolResultPresentation,
} from '../../utils/tool-presenters';                  // barrel: web/src/utils/tool-presenters/index.ts (F05 r2 §3)
import type { ToolPairStatus } from '../../utils/agent-timeline/types'; // F03 r2 §3.1/§3.3

defineProps<{
  call: ToolCallPresentation;            // F05 r2 §2 — always present (synthesised for orphan results, see F04 r3 §4.1)
  result: ToolResultPresentation | null; // F05 r2 §2 — null when no result yet (pending or missing)
  callContent: string;                   // RAW producer payload for the expanded body (call entry .content)
  resultContent: string | null;          // RAW producer payload for the expanded body (result entry .content, or null)
  status: ToolPairStatus;                // 'pending' | 'ok' | 'error' | 'orphan' | 'missing'
  expanded: boolean;
  detailsId: string;                     // `tool-detail-${toolUseId}` or `tool-detail-pending-${pending.id}` (F04 r3 §4.1)
  timestamp?: string;
}>();
defineEmits<{ (e: 'toggle'): void }>();
```

Status → `<Card>` tone mapping (verbatim from F03 r2 §7.2):

| `status`    | `<Card>` tone | rationale |
| ---         | ---           | --- |
| `'pending'` | `warn`        | in-flight, no result yet |
| `'ok'`      | `accent`      | successful result |
| `'error'`   | `danger`      | failed result |
| `'orphan'`  | `warn`        | result with no call (surfaced as warning, not error) |
| `'missing'` | `warn`        | call present, no result yet; headline gets a muted "(no result yet)" suffix |

**Markup contract (verbatim from F05 r2 §6 / F03 r2 §7.2):**

- The chip root is `<Card :tone role="group" :aria-label data-testid="tool-chip" :data-status>`.
- The chip header `<div class="tool-chip-head">` contains exactly
  ONE `<button class="tool-chip-toggle">` (the expand toggle) with
  `:aria-expanded="expanded"` and `:aria-controls="detailsId"`.
  Clicking emits `toggle`. Around (not inside) this button, the
  header renders `<InlineParts :parts="call.headline" />` and, when
  `call.detail.length > 0`, `<InlineParts :parts="call.detail" />`
  inside a `<Pill>` with the appropriate detail tone. The
  `<router-link>` / `<a>` elements produced by `<InlineParts>` are
  DOM siblings of the toggle inside the chip group — never nested
  inside the button.
- The chip body `<div :id="detailsId" v-show="expanded">` renders:
  - `<FormattedContent :content="callContent" />` — always when
    expanded (`callContent: string` is required; never null).
  - `<FormattedContent :content="resultContent" />` — only when
    `resultContent !== null`. When `resultContent === null` (status
    `pending` or `missing`), no result `FormattedContent` is
    rendered.

The chip emits **only** `toggle`. No `navigateFile`, no
`navigateUrl`, no `openFile`, no `copyContent` — file/url routing
happens through `<router-link>` / `<a>` inside `<InlineParts>`;
the copy affordance for raw JSON is on `<JsonView>` (its own
`copyable` prop), reached only when `FormattedContent` delegates
to `<JsonView>`.

**Adapter contract (F04 r3 §4.1, restated):** the F04 adapter
`chat/tool-chip-adapter.ts` returns the eight-prop bag; callers
spread it with `v-bind`:

```vue
<ToolChip v-bind="adaptChatMessageToToolChip(callMsg, resultMsg, expandedSet.has(toolUseId))"
          @toggle="onToggle(toolUseId)" />
<ToolChip v-bind="adaptPendingInvocationToToolChip(pending, expandedSet.has(`pending-${pending.id}`))"
          @toggle="onToggle(`pending-${pending.id}`)" />
```

Both adapters supply `callContent` (the raw `.content` string of
the call message, or the synthesised string for orphan results)
and `resultContent` (the raw `.content` string of the result
message, or `null` when no result is present). The adapter — not
the chip — is the seam between the surface and the eight-prop
bag.

**Landing:** `conversation/ToolChip.vue` is committed in the **F03
PR** (per F03 r2 §8.2 and F04 r3 §11.2), together with the swap
that retires `chat/AnalystChatPanel.vue`'s in-line `.tool-chip*`
markup and scoped styles. F02 r3 owns only the API written above;
the file's first appearance at HEAD is inside the F03 batch's PR.
This is the binding cross-batch coordination that resolves r1
Blocking 2 and r2 Blocking 1.

#### 1.3.15 `conversation/ThinkingDots.vue`

```ts
defineProps<{ ariaLabel?: string }>();
```

Three `<span>` children riding `.pulse` (F01 r1). Layout-only scoped
style. No pattern-class extensions.

#### 1.3.16 F03-owned composites (API placeholders only)

`RoundCard.vue`, `DiagnosticRow.vue`, `PendingCallFooter.vue`,
`CompactedCluster.vue`, `ContextBlock.vue` ship in the F03 batch
(F03 r2 §3.4). F02 owns only the directory + composition rules
(§1.2). All five satisfy the §1.2 discriminator (no
store/router/transport imports; F03 confirms). `RoundCard` is the
producer of the eight-prop chip bag inside the agent surface (it
forwards each `ToolPair` view-model into a `<ToolChip v-bind=…>`
with the raw `callContent` / `resultContent` strings carried on
the pair view-model per F03 r2 §7.3).

### 1.4 Deletion matrix (commit-bound)

The exhaustive deletion matrix lives in
[analysis r2 §4.1–4.13](01-analysis-r2.md#4-deletion--migration-matrix).
This design adds commit-level grouping. r3 changes vs r2:

1. C4 now explicitly **deletes** `web/src/utils/tool-presenters.ts`
   (the single file) in the same commit that creates the
   `web/src/utils/tool-presenters/` directory with `index.ts`,
   `types.ts`, `registry.ts`, and the per-tool modules (F05 r2 §3,
   review item 3). No `.ts` re-export shim, no alias period.
2. The C5 row reaffirms that the chip ships with the **eight-prop**
   bag.

| Commit | New primitive(s) introduced | Selector blocks / files deleted in same commit |
| --- | --- | --- |
| C1 | `ui/Button.vue` | additive |
| C2 | `ui/Pill.vue`, `ui/StatusDot.vue`, `ui/Card.vue`, `ui/PanelHeading.vue`, `ui/Spinner.vue`, `ui/Overlay.vue` + the F01 r2 extension patterns | additive (F01 extensions land here) |
| C3 | `content/CodeBlock.vue` + `content/MarkdownText.vue` (moves) | delete `web/src/components/code/CodeBlock.vue`, `code/MarkdownText.vue`, and the now-empty `web/src/components/code/` directory; update consumer imports atomically. No alias. |
| **C4** | `content/JsonView.vue`, `content/FormattedContent.vue`, `content/InlineParts.vue` + `web/src/utils/json-tokenize.ts` extraction (F05 r2 §7.1) + **the F05 r2 §3 `web/src/utils/tool-presenters/` directory with `index.ts` / `types.ts` / `registry.ts` and the per-tool modules** | **delete `web/src/utils/tool-presenters.ts` (single file) and any test that imported it directly; replace with imports from the directory barrel.** No re-export shim. Adds `"sideEffects": ["./web/src/utils/tool-presenters/**"]` to `web/package.json` per F05 r2 §3.4. |
| **C5** | **`conversation/MessageBubble.vue`, `conversation/ThinkingDots.vue`, `conversation/ToolChip.vue` (the shared chip with the eight-prop bag including `callContent` / `resultContent`) + the `AnalystChatPanel.vue` chip swap + the new adapter file `chat/tool-chip-adapter.ts` and the pairing utility `chat/analyst-timeline.ts`** | **delete the `<button class="tool-chip">…</button>` markup block in `chat/AnalystChatPanel.vue` and its scoped `.tool-chip*` block in the same commit (analysis §4.10 `.tool-chip*` family, `.pending-tool-*`). Migrate `analyst-chat-panel.test.ts` selectors to `data-testid="tool-chip"` + `data-status` in the same commit. After C5 there is exactly one chip renderer at HEAD, with one prop bag (eight props).** Coordinated with the F03 PR per F03 r2 §8.2. |
| C6 | `auth/ApiTokenEntry.vue` rewritten on `Overlay` + `Button` | analysis §4.2 — `.token-overlay`, `.token-dialog`, `.token-btn*`, `.token-toggle`, `nav/NavRail.vue`'s `.api-token-btn` |
| C7 | `layout/AppShell.vue` (auth banner) + `layout/WorkspaceHeader.vue` | analysis §4.1, §4.3 — `.auth-required-banner`, `.auth-banner-*`, `.ws-chip`, `.runtime-chip`, `.pause-chip`, `.chip-dot` |
| C8 | `views/DashboardView.vue` rewrite | analysis §4.5 |
| C9 | `views/FilesView.vue` rewrite | analysis §4.6 |
| C10 | `views/DebugView.vue` rewrite | analysis §4.7 |
| C11 | `components/agents/AgentConversationView.vue` rewrite (F03 lands the round bodies; F02 lands the toolbar/state-panel migration here) | analysis §4.8 |
| C12 | `components/agents/RawLlmExchangePanel.vue` rewrite | analysis §4.9 — `.rlp-*` |
| C13 | `components/chat/AnalystChatPanel.vue` non-chip rewrite (F04 owns the broader chat decomposition; F02 lands the primitive migration of the surviving panel scope) **— the chip swap already happened in C5; this commit does NOT touch `.tool-chip*` (already gone)** | analysis §4.10 (minus the chip family) |
| C14 | `components/cards/*.vue` rewrites | analysis §4.11 |
| C15 | `components/nav/NavRail.vue` rewrite | analysis §4.4 |

C5 is the binding boundary: it adds `MessageBubble.vue`,
`ThinkingDots.vue`, **`ToolChip.vue` (eight-prop bag)**, the F04
adapter, the F03 pairing utility, swaps `AnalystChatPanel.vue` to
consume the shared chip, and deletes the `.tool-chip*` family in
`AnalystChatPanel.vue` in the same commit. After C5 there is
exactly one chip renderer at HEAD, with exactly one prop bag.

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
    InlineParts.test.ts        ← new (F02 r3; renders the InlinePart kinds; matches F05 r2 §6)
  conversation/
    MessageBubble.test.ts
    ToolChip.test.ts           ← F02 r3 chip-contract + F03 r2 §10.5 lifecycle (committed in F03 PR)
    ThinkingDots.test.ts
  utils/
    json-tokenize.test.ts      ← F05 r2 §8.1
    tool-presenters/
      barrel-integrity.test.ts ← F05 r2 §6.5 — asserts every file in the directory is imported by index.ts
      registry.test.ts         ← F05 r2 §6.5 — default + every EXPECTED_TOOL_NAMES is registered after one barrel import
      coverage.test.ts         ← F05 r2 §6.5
  (existing surface tests, rewritten per analysis §5.2)
```

`code-block.test.ts` and `markdown-text.test.ts` move via `git mv`
into the new `content/` test folder. Pattern-class assertions live
in `ui/`/`content/`/`conversation/` unit tests only.

**F04 adapter tests live with the F03 PR (binding).** Per F04 r3
§11.2, `chat/tool-chip-adapter.test.ts` ships in the same PR as
the AnalystChatPanel chip swap (C5). r3 expands the case list to
assert eight-prop delivery:

- `adaptChatMessageToToolChip > forwards callContent verbatim from the call message`.
- `adaptChatMessageToToolChip > forwards resultContent verbatim from the result message when result is non-null`.
- `adaptChatMessageToToolChip > emits resultContent: null when result is null`.
- `adaptChatMessageToToolChip > emits status="missing" when result is null and call is real`.
- `adaptChatMessageToToolChip > emits status="orphan" + synthesised call when call message is missing but result is present; callContent is the synthesised placeholder`.
- `adaptChatMessageToToolChip > emits status="ok"|"error" matching the F05 result presenter`.
- `adaptPendingInvocationToToolChip > emits status="pending", result=null, resultContent=null`.
- `adaptPendingInvocationToToolChip > detailsId is "tool-detail-pending-${pending.id}"`.
- `adaptPendingInvocationToToolChip > callContent is the JSON-serialised pending request body`.

`ToolChip.test.ts` ships the F03 r2 §10.5 cases plus the F02 r3
chip-contract additions:

- Lifecycle (status → Card tone):
  - `ToolChip > maps status pending → wrapper Card tone warn`.
  - `ToolChip > maps status ok → tone accent`.
  - `ToolChip > maps status error → tone danger`.
  - `ToolChip > maps status orphan → tone warn`.
  - `ToolChip > maps status missing → tone warn with "(no result yet)" muted suffix`.
- Eight-prop expanded body (NEW in r3):
  - `ToolChip > when expanded, renders <FormattedContent :content="callContent" /> exactly once`.
  - `ToolChip > when expanded and resultContent !== null, renders <FormattedContent :content="resultContent" /> exactly once`.
  - `ToolChip > when expanded and resultContent === null, does NOT render a result <FormattedContent>`.
  - `ToolChip > when not expanded, renders zero <FormattedContent> instances regardless of callContent / resultContent values`.
  - `ToolChip > forwards callContent string verbatim to FormattedContent.content prop (mount/find FormattedContent stub)`.
  - `ToolChip > forwards resultContent string verbatim to FormattedContent.content prop when non-null`.
- Headline/detail rendering:
  - `ToolChip > renders <InlineParts :parts="call.headline" /> always`.
  - `ToolChip > renders <InlineParts :parts="call.detail" /> inside a <Pill> when call.detail.length > 0`.
  - `ToolChip > links produced by InlineParts are DOM siblings of the toggle, not descendants of the toggle (no nested interactive elements)`.
- A11y / chip contract:
  - `ToolChip > aria-expanded reflects expanded`.
  - `ToolChip > aria-controls matches detailsId`.
  - `ToolChip > clicking the toggle <button> emits 'toggle' exactly once`.
  - `ToolChip > chip root is role="group" with the toggle as the only nested <button>` (F05 r2 §6).
  - `ToolChip > root carries data-testid="tool-chip" and data-status reflects the status prop`.

The "wrong" r1 cases (`status: 'call'|…`, `view: ToolPresentationView`,
five-prop bag) are withdrawn; the r2 cases that referenced the
undefined `callContentRaw` / `resultContentRaw` template variables
are rewritten to assert directly against the `callContent` /
`resultContent` props.

CI gate: a custom test job `web:no-bespoke-class-assertions` runs
`rg -n "find\\('\\.[a-z]" web/src/__tests__/` and fails on any new
matches outside the `ui/`/`content/`/`conversation/` test folders.

### 1.6 Cross-batch coordination (F03 / F04 / F05)

Binding cross-issue ordering, restated for clarity. r3 changes vs
r2: the C4 commit now explicitly creates the
`web/src/utils/tool-presenters/` directory + deletes the single
file, and C5's chip ships with the **eight-prop** bag including
`callContent` / `resultContent`.

```
F01 r2 ─► F02 r3 (C1–C3, the additive ui/ + content/code-move) ─►
F05 r2 batch (C4: JsonView/FormattedContent/InlineParts + tokenizeJson
              + the tool-presenters/ directory creation + per-tool
              modules + index.ts barrel + deletion of the single
              file web/src/utils/tool-presenters.ts (no re-export
              shim) + package.json sideEffects entry) ─►
F03 r2 batch (C5: combined commit containing
              · conversation/ToolChip.vue (final F02 r3 eight-prop
                  API; callContent + resultContent are required
                  inputs, no derived "raw" variables)
              · conversation/MessageBubble.vue + ThinkingDots.vue
              · chat/tool-chip-adapter.ts (F04 r3 §4.1 adapters —
                  return the eight-prop bag including callContent
                  / resultContent)
              · chat/analyst-timeline.ts (F03 r2 §3.4 pairAnalystMessages)
              · AnalystChatPanel.vue chip swap (in-line .tool-chip*
                  markup + scoped CSS deleted, replaced with
                  <ToolChip v-bind="adaptChatMessageToToolChip(...)" />)
              · analyst-chat-panel.test.ts selector migration
              · F03's round/diagnostic/pending/compacted/context bodies
              · AgentConversationView .tc-*/.tr-*/.conv-step/.conv-message
                  deletion
              · ToolChip.test.ts + tool-chip-adapter.test.ts +
                  RoundCard.test.ts + … new tests) ─►
F02 r3 (C6–C15) ─►
F04 batch (the analyst-surface decomposition: ChatHeader / MessageList /
           MessageItem / JumpToLatest / ChatComposer + composables;
           the chip swap has already happened, F04 just relocates the
           v-bind="adapt…" call site from AnalystChatPanel.vue into the
           decomposed MessageItem.vue).
```

Four invariants the sequence preserves end-to-end:

- **One chip renderer at HEAD.** From C5 onward, `conversation/ToolChip.vue`
  is the only chip in the tree; `chat/AnalystChatPanel.vue` and
  `components/agents/AgentConversationView.vue` (when its body is
  rewritten in F03's part of C5) both consume the shared chip.
- **One chip prop bag at HEAD.** From C5 onward, every call site
  spreads the **eight-prop** bag (`call`, `result`, `callContent`,
  `resultContent`, `status`, `expanded`, `detailsId`, `timestamp?`).
  There is no commit at which a five-prop or six-prop chip bag
  exists.
- **One `InlinePart` definition.** F05 r2 §3 exports `InlinePart`
  from the `tool-presenters/` directory barrel
  (`web/src/utils/tool-presenters/index.ts`). C4 ships this and
  deletes the legacy single-file presenter; C5 consumes it. No
  re-definition in F02, F03, or F04.
- **One `FormattedContent` definition.** F05 r2 §7.3 owns the
  `content: string` contract. F02 r3 §1.3.11 places the SFC under
  `content/`. F03's chip body, F04's chip body call site, and any
  future surface call import from the same path. No competing
  parts-renderer also named `FormattedContent` exists at any HEAD
  state.

### 1.7 Build / typecheck impact

- **Net SFC count:** +14 new SFCs in `ui/` (7) + `content/` (3 new
  + 2 moved) + `conversation/` (2 in F02; F03 adds 6 more in its
  batch including `ToolChip.vue` with the eight-prop bag). Net
  deletions: `web/src/components/code/` directory (2 files) +
  `web/src/utils/tool-presenters.ts` (1 file, replaced by the
  directory) plus the bespoke `<style scoped>` blocks across 15+
  consumer files.
- **Bundle size:** projected slight decrease.
- **`npx vue-tsc --noEmit`:** must stay green commit-by-commit.
  The eight-prop chip bag typechecks at every call site (analyst
  surface + agent surface) because the adapter returns the full
  bag and `v-bind` propagates required props.
- **Vitest:** new `ui/`/`content/`/`conversation/` unit tests +
  the F05 r2 §6.5 barrel-integrity / registry / coverage tests
  under `utils/tool-presenters/`; ≤ 2 s wall-clock impact.
- **ESLint:** the five `no-restricted-imports` overrides in §1.2
  run in the existing pipeline.

### 1.8 Story / visual-diff plan

**Decision: no Storybook, no Histoire, no Chromatic.** Unchanged
from r2.

### 1.9 Selector survival cheatsheet (informational)

Unchanged from r2. A scoped class is allowed to survive iff its
rule body, after F02 lands, contains only layout properties
(see r2 §1.9 for the exhaustive allow/forbid lists).

---

## 2. Proposal B — Feature-slice with role-based co-location

Treatment is essentially r1's; r3 propagates the chip-API correction
(eight-prop bag) and the `tool-presenters/` barrel path through
Proposal B as well. The `features/conversation/ToolChip.vue` API is
identical to the Proposal A signature in §1.3.14.

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
      ToolChip.vue                       (eight-prop bag)
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
      tool-chip-adapter.ts               (returns the eight-prop bag)
      analyst-timeline.ts
      useStickToBottom.ts
      useDebouncedConnectionState.ts
      __tests__/
    cards/      …
    files/      …
    dashboard/  …
    debug/      …
    agents-list/…
    auth/       …
    shell/      …
  router/
  stores/
  utils/
    tool-presenters/                     (F05 r2 §3 barrel)
      index.ts
      types.ts
      registry.ts
      <per-tool>.ts …
  styles/
```

`MessageBubble`/`ToolChip` live with `features/conversation/`; the
flat `lib/` only holds genuinely cross-feature primitives.

### 2.2 New primitives

Same prop signatures as Proposal A for every primitive listed in
§1.3.1–§1.3.15 — including the eight-prop `ToolChip` bag and the
import from `web/src/utils/tool-presenters/index.ts`. `ToolChip` and
`MessageBubble` move from a shared folder into
`features/conversation/`; their APIs are unchanged.

### 2.3 Deletion matrix

Verbatim from §1.4. C4 still creates the `utils/tool-presenters/`
directory and deletes the single file. Import paths change but
selectors deleted are identical. Under Proposal B, the chip file
is `features/conversation/ToolChip.vue` and the analyst panel lives
at `features/chat/AnalystChatPanel.vue`. Net additional deletions:
whole-tree file moves.

### 2.4 Test reorganisation

`__tests__/` folders co-locate inside each feature slice.
`ToolChip.test.ts` ships under `features/conversation/__tests__/`
with the same r3 expanded case list (callContent / resultContent
forwarding + lifecycle); adapter tests under
`features/chat/__tests__/`.

### 2.5 Build / typecheck impact

- Barrel re-export cost: HMR invalidation expands to every importer.
- Whole-tree import churn (~70+ imports across the codebase).
- ~12 router definition changes (`views/` paths).

### 2.6 Story / visual-diff plan

Same as A (no Storybook).

### 2.7 Why this proposal is plausible

Unchanged from r2.

### 2.8 Why this proposal still falls short

Unchanged from r2 (cross-feature composition pulls `MessageBubble`/
`ToolChip` between `features/chat/` and `features/conversation/`;
discriminator drift; net-neutral test discovery; large re-review
surface).

### 2.9 Variants of B considered and rejected within B

Unchanged from r2.

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
defineProps<{ level?: 2 | 3; as?: 'header' | 'div' }>();
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
defineProps<{ size?: 'sm' | 'md' | 'lg'; ariaLabel?: string }>();
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
defineProps<{ text: string; inline?: boolean }>();
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
// Import path resolves to web/src/utils/tool-presenters/index.ts (the F05 r2 §3 barrel).
import type { InlinePart } from '../../utils/tool-presenters';
defineProps<{ parts: InlinePart[] }>();
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
// conversation/ToolChip.vue       (final API; ships in F03 PR; eight-prop bag)
// Import paths resolve to the F05 r2 §3 directory barrel
// (web/src/utils/tool-presenters/index.ts) and the F03 r2 §3.1 directory
// barrel (web/src/utils/agent-timeline/index.ts re-exporting types.ts).
import type {
  ToolCallPresentation,
  ToolResultPresentation,
} from '../../utils/tool-presenters';
import type { ToolPairStatus } from '../../utils/agent-timeline/types';

defineProps<{
  call: ToolCallPresentation;            // F05 r2 §2
  result: ToolResultPresentation | null; // F05 r2 §2
  callContent: string;                   // F03 r2 §7.2 — raw call payload for the expanded body
  resultContent: string | null;          // F03 r2 §7.2 — raw result payload (or null)
  status: ToolPairStatus;                // F03 r2 §3.3 — 'pending' | 'ok' | 'error' | 'orphan' | 'missing'
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
their prop signatures from F03 r2 §3.4 / §7.3.

---

## 4. Pattern extensions to F01 r2 (binding)

Unchanged from r2. F02 introduces no new tokens; the pattern-class
extension rules (`.status-dot-*`, `.card-*`, `.pill-purple`,
`.tablist > .pill[aria-pressed="true"]`) listed in analysis r2 §2.2
land in C2 inside F01 r2's `patterns.css`.

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
| `web/src/__tests__/ui/Overlay.test.ts` | 200 | seven cases from analysis §5.4 |
| `web/src/__tests__/content/CodeBlock.test.ts` | 150 | rewritten from existing `code-block.test.ts`; oversize emit; copy button |
| `web/src/__tests__/content/MarkdownText.test.ts` | 90 | rewritten from existing `markdown-text.test.ts` |
| `web/src/__tests__/content/JsonView.test.ts` | 80 | F05 r2 §8.2 cases |
| `web/src/__tests__/content/FormattedContent.test.ts` | 120 | F05 r2 §8.3 cases (JSON object / array; invalid leading `{` → text; extract after "Tool result:" / "Error:"; non-allowlisted prose with braces stays text; plain prose routes through MarkdownText; empty input) |
| `web/src/__tests__/content/InlineParts.test.ts` | 100 | each `InlinePart.kind` renders correctly; `shortPath` shrinkage on long file paths |
| `web/src/__tests__/utils/json-tokenize.test.ts` | 120 | F05 r2 §8.1 cases |
| `web/src/__tests__/utils/tool-presenters/barrel-integrity.test.ts` | 50 | F05 r2 §6.5 — every file in `utils/tool-presenters/` is imported by `index.ts`; no orphan files |
| `web/src/__tests__/utils/tool-presenters/registry.test.ts` | 80 | F05 r2 §6.5 — default + every `EXPECTED_TOOL_NAMES` entry is registered after one barrel import |
| `web/src/__tests__/utils/tool-presenters/coverage.test.ts` | 50 | F05 r2 §6.5 — every expected tool has BOTH a call and a result presenter (no `__default__` fall-through) |
| `web/src/__tests__/conversation/MessageBubble.test.ts` | 90 | role → tone class; slots; reasoning kind layout |
| `web/src/__tests__/conversation/ToolChip.test.ts` | 220 | F03 r2 §10.5 lifecycle cases (pending/ok/error/orphan/missing → Card tone) + F02 r3 chip contract (aria-expanded reflects `expanded`; aria-controls === `detailsId`; toggle emit; chip root role="group" + single nested `<button>`; data-testid + data-status) + **F02 r3 expanded-body cases (callContent forwarded verbatim to FormattedContent; resultContent forwarded verbatim when non-null; no result FormattedContent when resultContent === null; zero FormattedContent when not expanded)** + headline/detail rendering via InlineParts (sibling-not-nested links) |
| `web/src/__tests__/conversation/ThinkingDots.test.ts` | 30 | three children riding `.pulse` |
| `web/src/__tests__/components/chat/tool-chip-adapter.test.ts` | 180 | F04 r3 §4.1 cases (`adaptChatMessageToToolChip` missing/orphan/ok/error; `adaptPendingInvocationToToolChip` always pending + null result; `detailsId` format) + **r3 eight-prop forwarding cases (callContent verbatim from call message; resultContent verbatim from result message or null; callContent synthesised for orphan results)** — committed in F03 PR per F04 r3 §11.2 |

Total ≈ 1,830 lines of new unit + utility tests (≈ 230 lines added
in r3 vs r2 for the expanded chip and adapter cases + the three
`tool-presenters/` directory tests), replacing roughly 1,800 lines
of fragile bespoke-class surface assertions across the existing
test files (per analysis §5.2).

### 5.2 Rewritten surface tests

Unchanged from r2. Each surface test file in analysis §5.2 stops
asserting bespoke classes and starts asserting via `data-testid` /
`role` / text. `analyst-chat-panel.test.ts` migrates its
`.tool-chip` queries to `[data-testid="tool-chip"]` + `data-status`
in the C5 commit (same PR as the chip swap), per F03 r2 §8.2.

---

## 6. Build / typecheck / lint impact (consolidated)

- **`npx vue-tsc --noEmit`:** must stay green commit-by-commit.
  ~15 new SFCs. Per-SFC compile time ~20 ms in vue-tsc 2.x. Net
  delta ≤ 350 ms.
- **`npm run build` (Vite production):** projected slight bundle
  size decrease. No new dependencies; `Spinner` consumes
  `lucide-vue-next` already in the bundle.
- **`npm test` (Vitest):** ~1,830 new lines of unit tests; ≤ 2 s
  wall-clock impact.
- **`npx eslint`:** five new `no-restricted-imports` blocks, all
  scoped via `overrides[*].files`. Adds ~50 ms to a full lint.

---

## 7. Story / visual-diff plan (consolidated)

Unchanged from r2. No story tooling.

---

## 8. Risks and open questions

| Risk | Mitigation |
| --- | --- |
| `Spinner` violates the "ui/ may not import lucide-vue-next" rule. | Single-file ESLint exception (§1.2 block #2). Fallback (CSS-only spinner) ready if reviewer rejects. |
| `ToolChip` consumes `ToolPairStatus` (from `agent-timeline/types`) and `ToolCallPresentation`/`ToolResultPresentation` (from the `tool-presenters/` directory barrel). Drift between F03/F05/F04 batches could break the chip. | C5 explicitly imports from the F05-final `tool-presenters/` barrel (committed in C4) and from F03-final `utils/agent-timeline/types.ts`. C4 is committed before C5; the F03 PR contains both `ToolChip.vue` and the `AnalystChatPanel` swap so the adapter typechecks before merge. |
| **r3 risk: the eight-prop bag adds two required string-shaped props (`callContent`, `resultContent`) that every chip call site must supply. If a call site forgets one, vue-tsc fails noisily; if a runtime caller bypasses the adapter, the chip silently renders an empty expanded body.** | All chip call sites flow through `v-bind="adaptChatMessageToToolChip(...)"` / `v-bind="adaptPendingInvocationToToolChip(...)"` (F04 r3 §4.1) or through `RoundCard.vue`'s typed `ToolPair` view-model (F03 r2 §7.3). Both adapters and the round view-model are mandatory seams typed against the eight-prop bag; vue-tsc catches missing props at compile time. The `ToolChip.test.ts` cases in §1.5 cover both the "callContent forwards verbatim" and the "no result FormattedContent when resultContent is null" paths. |
| `Overlay` hand-rolled focus trap is subtle. | Tests in §5.1 enumerate seven cases. Fallback to `radix-vue` `<Dialog>` recorded in analysis §8.3. |
| F03 owns five composites inside `conversation/`. If F03 slips, F02 ships a partial subset of the folder. | Acceptable: C1–C2 ships `MessageBubble` + `ThinkingDots` only; the directory exists with two files initially. C5 (the F03 PR) fills the rest. |
| Stylelint / `rg` gate for surviving-scoped-style colour properties might over-flag legitimate `outline` rules for focus-visible. | F01 r2 owns `.focus-visible` pattern; the gate is allowed to flag any `outline` outside `styles/`. |
| F04 expects `MessageBubble` and `ToolChip` to be ready BEFORE its chat decomposition. | F02 C1–C2 ships `MessageBubble` early; the shared `ToolChip` lands in C5 inside the F03 PR. F04 begins after C5. |
| Removing `web/src/components/code/` could break IDE bookmarks / external docs. | Acceptable per project guideline. Docs and SPEC files referencing the old path are updated in C3. |
| **r3 risk: deleting the single file `web/src/utils/tool-presenters.ts` in C4 breaks any consumer that imported it directly (bypassing the barrel) at any prior HEAD.** | The existing v3 codebase has exactly one such file (the single-file presenter itself); after C4 the directory barrel is the only resolution path. `barrel-integrity.test.ts` plus a `grep` CI gate `rg -n "from ['\"].*utils/tool-presenters\\.ts['\"]"` is added in C4 to prevent regression. No re-export shim — per project guideline. |
| F05 r2 places `JsonView` and `FormattedContent` under `components/content/` (the F02-canonical path); F05 design r2 already aligns to this. | Path bookkeeping resolved; the F05 batch (C4) creates the files under `content/`. |

Open questions for the reviewer (Q3 closed since r2; Q1 / Q2
preserved):

- **(Q1)** Does the F01 r2 `patterns.css` deliverable include the
  extension rules in §4, or should this design land them inline as
  F02-owned and merge them into F01 in a follow-up?
- **(Q2)** Is the `.tablist > .pill[aria-pressed="true"]` ARIA-
  selector pattern acceptable? Alternative: a `.pill-pressed`
  modifier toggled by Vue.
- **(Q3, closed)** `FormattedContent` parses raw tool-detail content
  (F05 r2 §7.3); inline headline/detail parts are rendered by
  `InlineParts.vue` (F05 r2 §6); raw payloads enter the chip via
  the `callContent` / `resultContent` props (F03 r2 §7.2). r1's
  parts-renderer-named-FormattedContent confusion is withdrawn.

---

## 9. Recommendation

**Adopt Proposal A.**

Reasoning unchanged from r2 (clean architecture, F01 token
consumption parity, F03/F04/F05 alignment, smaller test surface
delta, smaller migration footprint, ESLint discriminator
enforceable per directory). The r3 corrections to the chip prop
bag (eight props), the `tool-presenters/` barrel path, and the
expanded `ToolChip.test.ts` / `tool-chip-adapter.test.ts` case
lists all preserve A's advantage over B.

**Chosen letter: A.**

---

## 10. Out of scope (carry-overs to other batches)

- Tokenization utility extraction (`tokenizeJson`) — F05 r2 §7.1;
  ships in C4.
- F05 r2 §3 `tool-presenters/` directory creation + per-tool
  modules + the deletion of the single file
  `web/src/utils/tool-presenters.ts` — ships in C4.
- F03's round bodies (`RoundCard`, `DiagnosticRow`,
  `PendingCallFooter`, `CompactedCluster`, `ContextBlock`) — F03
  batch (C5). Note: `RoundCard.vue` is the producer of the
  eight-prop `ToolChip` bag for the agent surface; it carries the
  raw `callContent` / `resultContent` strings through its typed
  `ToolPair` view-model (F03 r2 §7.3).
- F04's chat decomposition (`ChatHeader`, `MessageList`,
  `MessageItem`, `ChatComposer`, `JumpToLatest`) — F04 batch (post
  C15). The eight-prop chip bag has already landed in C5; F04 only
  relocates the `v-bind="adapt…"` call site.
- Form-control primitives (input, textarea, select) — explicitly
  excluded per analysis §6.7.
- Headless-UI dependency adoption (radix-vue / reka-ui /
  @headlessui/vue) — explicitly rejected per analysis §8.3.

---

## 11. File outcomes (informational, Proposal A)

- **Created (SFCs):** 7 in `ui/`, 5 in `content/` (3 new + 2
  moved), 2 in `conversation/` owned by F02 (`MessageBubble`,
  `ThinkingDots`); 6 more in `conversation/` shipped by F03 PR
  (`ToolChip` with the eight-prop bag, `RoundCard`,
  `DiagnosticRow`, `PendingCallFooter`, `CompactedCluster`,
  `ContextBlock`).
- **Created (utils, F05-owned):** `web/src/utils/tool-presenters/`
  directory with `index.ts` (barrel), `types.ts`, `registry.ts`,
  per-tool modules; `web/src/utils/json-tokenize.ts`.
- **Relocated:** `web/src/components/code/CodeBlock.vue` →
  `web/src/components/content/CodeBlock.vue`,
  `web/src/components/code/MarkdownText.vue` →
  `web/src/components/content/MarkdownText.vue`. `code/` directory
  removed.
- **Modified:** every consumer file enumerated in
  [analysis §4](01-analysis-r2.md#4-deletion--migration-matrix);
  `chat/AnalystChatPanel.vue` is swapped to the shared `ToolChip`
  (with the eight-prop bag) in C5 (inside the F03 PR);
  `web/package.json` adds the `"sideEffects": ["./web/src/utils/tool-presenters/**"]`
  entry in C4.
- **Deleted:** `web/src/components/code/` directory (in C3);
  `web/src/utils/tool-presenters.ts` (the single file, in C4, with
  no re-export shim); the bespoke `<style scoped>` blocks across
  15+ consumer files (per the deletion matrix).
- **F01 r2 `patterns.css`:** extension rules listed in §4.
- **ESLint config:** five `no-restricted-imports` overrides
  (§1.2).
- **No barrels added under `components/`.** No `index.ts` under
  `ui/`, `content/`, or `conversation/`. The only barrel in the
  cross-issue graph is the F05-owned `utils/tool-presenters/index.ts`.

Exact landing order is §1.4's 15-commit sequence, with C4
introducing the `tool-presenters/` directory (and deleting the
single file) and C5 as the combined "shared `ToolChip` (eight-prop
bag) + AnalystChatPanel swap" boundary co-owned with the F03 PR.
The reviewer-phase document (`02-design-review-r3.md`) will
critique this; the implementation plan (`03-plan-r1.md`) will
translate this into checklists, test commands, and per-commit
acceptance criteria.
