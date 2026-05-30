# F01 — Design tokens & semantic CSS layer — Design (r1)

Issue: [F01-design-tokens.md](../F01-design-tokens.md)
Approved analysis: [01-analysis-r2.md](01-analysis-r2.md) (approved by [ANALYSIS-APPROVED.md](ANALYSIS-APPROVED.md)).
Cross-issue alignment: [F02 r2](../F02-component-hierarchy/01-analysis-r2.md), [F05 r2](../F05-tool-detail-rendering/01-analysis-r2.md).
v2 sources: [saivage/web/src/styles/](../../../../saivage/web/src/styles/).
v3 target: [web/src/](../../../web/src/).

This design enumerates two implementation proposals — a direct verbatim port (A) and a structurally upgraded "tokens + recipes" two-layer split (B) — then picks one. Both proposals land in a **single batch**, with no transitional dual visual system and no `--legacy-*` mirrors.

---

## Proposal A — Focused four-file CSS port

### A.1 Scope (files added / changed / deleted)

**Added** (six files, all under [web/src/styles/](../../../web/src/styles/) — new directory):

- [web/src/styles/tokens.css](../../../web/src/styles/tokens.css) — raw `--c-*` palette + type stacks + radii + shadows. The **only** v3 file allowed to contain raw hex.
- [web/src/styles/semantic.css](../../../web/src/styles/semantic.css) — semantic mapping. Resolves to `--c-*` tokens, `rgba()` over a token, or `color-mix(in srgb, var(--c-*) X%, var(--bg))`. Zero hex.
- [web/src/styles/base.css](../../../web/src/styles/base.css) — verbatim from [saivage/web/src/styles/base.css](../../../../saivage/web/src/styles/base.css). References semantic vars only.
- [web/src/styles/patterns.css](../../../web/src/styles/patterns.css) — verbatim from [saivage/web/src/styles/patterns.css](../../../../saivage/web/src/styles/patterns.css). References semantic vars only.
- [web/src/styles/index.css](../../../web/src/styles/index.css) — aggregator: `@import "./tokens.css"; @import "./semantic.css"; @import "./base.css"; @import "./patterns.css";`.
- [web/src/styles/highlight-overrides.css](../../../web/src/styles/highlight-overrides.css) — three-rule file overriding `pre.hljs` shell only.

**Changed:**

- [web/src/main.ts](../../../web/src/main.ts): imports reordered to `./styles/index.css` → `highlight.js/styles/github-dark.css` → `./styles/highlight-overrides.css`, **before** any Vue/Pinia/router setup.
- Every file under [web/src/components/](../../../web/src/components/), [web/src/views/](../../../web/src/views/), and [web/src/App.vue](../../../web/src/App.vue): every hex literal inside `<style scoped>` and every color-bearing `style="…"` binding rewritten to `var(--…)` per the §3.4 mapping table from the approved analysis. **No template/markup changes** (those belong to F02).

**Deleted:** none. F01 leaves `<style scoped>` blocks in place; F02 collapses them onto pattern classes.

### A.2 Concrete code skeletons

#### A.2.1 `tokens.css` — full skeleton with every var name

```css
/* ─── Design Tokens ─────────────────────────────────────────────────────────
   Raw palette values. Change only this file to swap themes.
   This is the ONLY file in v3 that may contain hex literals.
   ────────────────────────────────────────────────────────────────────────── */

:root {
  /* Neutrals (GitHub-dark scale) */
  --c-gray-950: #0d1117;   /* bg */
  --c-gray-900: #161b22;   /* surface-1 */
  --c-gray-850: #1c222b;   /* surface-2 */
  --c-gray-800: #21262d;   /* surface-3 / inset */
  --c-gray-700: #30363d;   /* border */
  --c-gray-600: #484f58;   /* border-strong */
  --c-gray-500: #6e7681;   /* text-faint */
  --c-gray-400: #8b949e;   /* text-muted */
  --c-gray-300: #c9d1d9;   /* text */

  /* Brand / accent palette */
  --c-green:        #3fb950;
  --c-green-light:  #7ee787;
  --c-blue:         #58a6ff;
  --c-yellow:       #d29922;
  --c-red:          #f85149;
  --c-purple:       #d2a8ff;
  --c-orange:       #ffa657;
  --c-teal:         #56d4dd;

  /* Typography */
  --font-sans: -apple-system, BlinkMacSystemFont, "Segoe UI", Inter,
               Roboto, "Helvetica Neue", Arial, sans-serif;
  --font-mono: ui-monospace, "SF Mono", "Cascadia Code", "Fira Code",
               Menlo, Monaco, Consolas, monospace;

  /* Spacing / Shape */
  --radius: 8px;
  --radius-sm: 4px;
  --radius-lg: 10px;
  --radius-pill: 999px;

  /* Shadows (dark — heavier ambient than v2 light) */
  --shadow-1: 0 1px 2px rgba(0, 0, 0, 0.35);
  --shadow-2: 0 4px 14px rgba(0, 0, 0, 0.45), 0 1px 4px rgba(0, 0, 0, 0.35);
  --shadow-3: 0 16px 40px rgba(0, 0, 0, 0.55), 0 2px 8px rgba(0, 0, 0, 0.4);
}
```

#### A.2.2 `semantic.css` — full skeleton, every semantic var, zero hex

```css
/* ─── Semantic Variables ─────────────────────────────────────────────────────
   Map raw tokens to meaning. Components reference ONLY these.
   No hex literals permitted in this file.
   ────────────────────────────────────────────────────────────────────────── */

:root {
  /* Surfaces */
  --bg:        var(--c-gray-950);
  --surface-1: var(--c-gray-900);
  --surface-2: var(--c-gray-850);
  --surface-3: var(--c-gray-800);

  /* Borders */
  --border:        var(--c-gray-700);
  --border-strong: var(--c-gray-600);
  --border-subtle: rgba(255, 255, 255, 0.06);

  /* Text */
  --text:       var(--c-gray-300);
  --text-muted: var(--c-gray-400);
  --text-faint: var(--c-gray-500);

  /* Accents (semantic) */
  --accent:   var(--c-green-light);
  --accent-2: var(--c-blue);
  --warn:     var(--c-yellow);
  --danger:   var(--c-red);
  --purple:   var(--c-purple);
  --orange:   var(--c-orange);
  --teal:     var(--c-teal);

  /* Entry / message state colors
     Dark-side equivalent of v2's "rgba(brand, 0.06) over white":
       border = rgba(brand, alpha) — translucent so it reads against any bg
       bg     = color-mix(in srgb, brand X%, --bg) — near-bg shade of brand */
  --entry-user-border:   color-mix(in srgb, var(--c-blue)        35%, transparent);
  --entry-user-bg:       color-mix(in srgb, var(--c-blue)        14%, var(--bg));
  --entry-accent-border: color-mix(in srgb, var(--c-green-light) 35%, transparent);
  --entry-accent-bg:     color-mix(in srgb, var(--c-green-light) 12%, var(--bg));
  --entry-warn-border:   color-mix(in srgb, var(--c-yellow)      40%, transparent);
  --entry-warn-bg:       color-mix(in srgb, var(--c-yellow)      12%, var(--bg));
  --entry-danger-border: color-mix(in srgb, var(--c-red)         45%, transparent);
  --entry-danger-bg:     color-mix(in srgb, var(--c-red)         12%, var(--bg));
  --entry-purple-border: color-mix(in srgb, var(--c-purple)      35%, transparent);
  --entry-purple-bg:     color-mix(in srgb, var(--c-purple)      14%, var(--bg));

  /* Code / syntax theme */
  --code-bg:           var(--c-gray-800);
  --code-color:        var(--c-blue);
  --code-block-bg:     var(--c-gray-900);
  --code-block-border: var(--c-gray-700);
  --code-block-text:   var(--c-gray-300);

  --syn-key:         var(--c-green-light);
  --syn-string:      var(--c-blue);
  --syn-number:      var(--c-purple);
  --syn-boolean:     var(--c-red);
  --syn-null:        var(--c-red);
  --syn-punctuation: var(--c-gray-500);

  /* Interactive / button */
  --btn-primary-bg:       var(--c-green);
  --btn-primary-bg-hover: var(--c-green-light);
  --btn-primary-border:   color-mix(in srgb, var(--c-green) 45%, transparent);
  --btn-primary-text:     var(--c-gray-950);

  /* Overlay / hover */
  --overlay-bg: rgba(0, 0, 0, 0.55);
  --hover-bg:   rgba(255, 255, 255, 0.04);

  /* Shorthand */
  --mono: var(--font-mono);
}
```

#### A.2.3 `base.css` — verbatim from v2

Copied unchanged from [saivage/web/src/styles/base.css](../../../../saivage/web/src/styles/base.css). For reference, the file contains: `* { box-sizing: border-box }`; `html, body, #app { height: 100% }`; body background/color/font-family from `--bg` / `--text` / `--font-sans`; `button, input { font: inherit }`; `code, pre, .mono { font-family: var(--mono) }`; `::-webkit-scrollbar*` rules using `--border-strong` / `--bg` / `--radius-pill`; `code { padding/border-radius/background/color/font-size }` and `pre code { padding:0; background:none; color:inherit }`. No edits required — every selector already references semantic vars compatible with the new `semantic.css`.

#### A.2.4 `patterns.css` — verbatim from v2

Copied unchanged from [saivage/web/src/styles/patterns.css](../../../../saivage/web/src/styles/patterns.css). Full inventory (every selector v2 ships):

- Entries: `.entry-user`, `.entry-accent`, `.entry-warn`, `.entry-danger`, `.entry-purple`.
- Cards: `.card`, `.card-active`.
- Buttons: `.btn`, `.btn:hover:not(:disabled)`, `.btn:disabled`, `.btn-primary`, `.btn-primary:hover:not(:disabled)`, `.btn-danger`.
- Pills: `.pill`, `.pill-warn`, `.pill-accent`, `.pill-danger`.
- Code: `.code-inline`, `.code-block`.
- Syntax: `.syn-key`, `.syn-string`, `.syn-number`, `.syn-boolean`, `.syn-null`, `.syn-punctuation`.
- Panel: `.panel-heading`, `.panel-heading h2`, `.panel-heading h3`.
- Status: `.status-dot`.
- Text utilities: `.text-muted`, `.text-faint`, `.text-accent`, `.text-warn`, `.text-danger`.
- Overlay: `.overlay`.
- Animations: `@keyframes spin`, `.spin`, `@keyframes pulse` (no `.pulse` class — keyframe only).

#### A.2.5 `index.css`

```css
/* ─── Style Entry Point ──────────────────────────────────────────────────────
   Import order matters: tokens → semantic → base → patterns
   ────────────────────────────────────────────────────────────────────────── */

@import "./tokens.css";
@import "./semantic.css";
@import "./base.css";
@import "./patterns.css";
```

#### A.2.6 `highlight-overrides.css`

```css
/* Override only the code-block shell. Token colors (.hljs-keyword etc.)
   are intentionally left to highlight.js/styles/github-dark.css. */
pre.hljs {
  background: var(--code-block-bg);
  border: 1px solid var(--code-block-border);
  border-radius: 6px;
}
```

#### A.2.7 `main.ts` import block

```ts
import './styles/index.css';
import 'highlight.js/styles/github-dark.css';
import './styles/highlight-overrides.css';
import { createApp } from 'vue';
// …unchanged from here…
```

### A.3 Implementation steps

Single commit. Order inside the commit:

1. **Add the six style files** under [web/src/styles/](../../../web/src/styles/). `base.css` and `patterns.css` are `cp` from v2; `tokens.css` and `semantic.css` are written per A.2.1–A.2.2; `index.css` and `highlight-overrides.css` are written verbatim per A.2.5–A.2.6.
   - Grep gate: `grep -rEn '#[0-9a-fA-F]{3,8}\b' web/src/styles | grep -v '^web/src/styles/tokens\.css'` → no matches.
2. **Edit [web/src/main.ts](../../../web/src/main.ts)** to the import block in A.2.7. Verify with `head -3 web/src/main.ts`.
3. **Mechanical hex replacement** across [web/src/components/](../../../web/src/components/), [web/src/views/](../../../web/src/views/), [web/src/App.vue](../../../web/src/App.vue). Use the §3.4 mapping table from the approved analysis as the authoritative source. For each hex H in the table:
   - `grep -rln "${H}" web/src --include='*.vue' --include='*.ts'` to enumerate sites.
   - Per site: replace inside `<style scoped>` blocks, `style="…"` inline bindings, and `:style="{ … }"` object bindings (which use raw strings) with the mapped `var(--…)`.
   - The two ambiguous values (`#3fb950` — accent vs btn-primary-bg, `#fff` — single inline) require grep-and-decide per call site; both rules are spelled out in §3.4 of the analysis.
   - Two grep contexts where hex is allowed and must be skipped: `web/src/styles/tokens.css` and any test fixture under `web/src/__tests__/` that uses card-id strings beginning with `#` (these aren't CSS hex; the validation grep already excludes the tests directory).
4. **Grep gate (full repo)**: `grep -rEn '#[0-9a-fA-F]{3,8}\b' web/src --include='*.vue' --include='*.ts' --include='*.css' | grep -v '^web/src/styles/tokens\.css' | grep -v '^web/src/__tests__/'` → no matches. This is the hard pass criterion for the commit.
5. **Run validation** (see A.4) before committing. Snapshot re-baselining is part of the same commit.

No intermediate commit. No `// TODO F02:` comments. Pattern-class adoption is F02's job and happens in a later commit.

### A.4 Validation

All from [/home/salva/g/ml/saivage-v3](../../../). All must succeed:

1. `pnpm -C web typecheck` — passes. F01 does not touch `.ts` types.
2. `grep -rEn '#[0-9a-fA-F]{3,8}\b' web/src --include='*.vue' --include='*.ts' --include='*.css' | grep -v '^web/src/styles/tokens\.css' | grep -v '^web/src/__tests__/'` — zero matches.
3. `pnpm -C web test` — passes. Snapshots under [web/src/__tests__/__snapshots__/](../../../web/src/__tests__/__snapshots__/) re-baselined inside the F01 commit; the diff is reviewed for behavior-bearing changes (none expected; assertions are on class names, text, and attribute presence, not on hex values).
4. `pnpm -C web build` — passes. Vite resolves the `@import` chain and inlines the four CSS files; `highlight.js/styles/github-dark.css` is resolved from node_modules; `highlight-overrides.css` lands after it.
5. **Visual diff matrix** — manual check, every surface, against the dark-mode preview:
   - [web/src/views/DashboardView.vue](../../../web/src/views/DashboardView.vue): rt-frozen tile keeps blue tint; tile borders match `--border`.
   - [web/src/components/layout/AppShell.vue](../../../web/src/components/layout/AppShell.vue): auth-required banner red-on-dark-red; emphasis word uses `--danger`; body text legible.
   - [web/src/components/chat/AnalystChatPanel.vue](../../../web/src/components/chat/AnalystChatPanel.vue): user/assistant strips and tool chips retain blue/grey contrast; composer surface unchanged.
   - [web/src/components/agents/AgentConversationView.vue](../../../web/src/components/agents/AgentConversationView.vue): per-step tool bars; warn / danger / accent strips distinct.
   - [web/src/components/auth/ApiTokenEntry.vue](../../../web/src/components/auth/ApiTokenEntry.vue): danger strip + primary button.
   - [web/src/components/code/CodeBlock.vue](../../../web/src/components/code/CodeBlock.vue), [web/src/components/code/MarkdownText.vue](../../../web/src/components/code/MarkdownText.vue): code blocks render against `--code-block-bg`; highlight.js token colors unchanged.
   - [web/src/components/nav/NavRail.vue](../../../web/src/components/nav/NavRail.vue): hover/selected states drive from `--surface-*` and `--hover-bg`.
   - [web/src/views/FilesView.vue](../../../web/src/views/FilesView.vue): quarantine footer reads as surface-2.
   - [web/src/views/DebugView.vue](../../../web/src/views/DebugView.vue): per-process entry strips warn/danger/accent.
6. **Contrast spot-check** — every pair from §7 of the analysis is met on the dark palette; AA pass count is 11/12, with `--text-faint` on `--bg` borderline at 3.9:1 (acceptable for de-emphasised meta text under AA large-text 3:1).
7. **Computed-style spot-check** — open DevTools on the visual-diff surfaces; no raw hex appears in "Computed" other than highlight.js `.hljs-*` token rules.

### A.5 Risks and rollback

| Risk | Mitigation |
| --- | --- |
| `color-mix(in srgb, …, transparent)` browser support | Targeted browsers (Chromium ≥ 111, Firefox ≥ 113, Safari ≥ 16.2) all support `color-mix`. Vite/Vue 3 baseline already implies modern evergreen. No fallback needed. |
| highlight.js cascade collision | Resolved by import order: `index.css` first (so patterns lose `pre.hljs` to highlight.js), then `github-dark.css`, then `highlight-overrides.css` (one rule, wins for the shell). `.hljs-*` token rules are not touched. |
| Snapshot churn | Bounded — snapshots assert on class names / text / attribute presence; the F01 commit re-baselines any embedded color values as part of its diff. |
| Scrollbar regression on hidden-overflow surfaces | The global `::-webkit-scrollbar` only paints when scrollbars actually appear; `overflow:hidden` regions are unaffected. Visual matrix covers all live scrollers. |
| Inline `style` bindings with hex | Step 3 explicitly covers `style="…"` and `:style="{ … }"` strings. Grep gate (step 4) catches any miss. |
| `.syn-*` vs `.hljs-*` specificity | Documented at the top of `patterns.css` as a code comment: source order wins; `.hljs-*` (later import) takes priority when both are applied to one element. Today there is no such overlap. |

**Rollback.** Single commit. `git revert <sha>` returns v3 to the pre-F01 state in one operation. There is no schema, no data migration, no on-disk format change.

### A.6 Cross-issue impact

- **F02 (component hierarchy).** F02 r2 §2.1 lists exactly the pattern classes it expects to find in `patterns.css` — all are present in v2's file and therefore in this port. F02 r2 §2.2 lists the **only** v3-only extension F02 itself will add (`.tool-chip*` family + a handful of pattern aliases). F01 does not pre-add those; F02 ships them in its own commit.
- **F03 (conversation rounds).** Round chips and filter pills consume `.pill-{warn,accent,danger}`, `--accent-2`, and `--entry-user-*` — all defined here.
- **F04 (chat surface style).** Composer surface and message strips consume `--surface-1`, `--surface-2`, `--entry-user-*`, `--entry-accent-*` — all defined here.
- **F05 (tool-detail rendering).** Tool chips read `--accent-2` (call), `--accent` (ok), `--danger` (error), `--warn` (pending) for the `tool-chip-{call,ok,error,pending}` variants F02 will introduce. F01 makes those vars available; F02 binds them to class selectors; F05 keeps the markup contract.

---

## Proposal B — "Tokens + Recipes" two-layer split

A higher-leverage alternative that introduces a third CSS file, `recipes.css`, sitting **between** `semantic.css` and component consumers. `recipes.css` composes the semantic vars into **component-level CSS variables** (e.g., `--message-bubble-bg`, `--tool-chip-pending-fg`, `--card-active-border`) that are read by either pattern classes or `<style scoped>` blocks. The intent is to give F02's hierarchical decomposition a sturdier seam: component-level vars define a tighter contract than raw semantic vars, so swapping the semantic mapping later does not silently re-tone a single component.

This is option (b) from the writer prompt. Option (a) (TS theme module emitting `:root` at runtime) was considered and rejected for the same reason analysis §8(b) rejected the TypeScript token approach: adds a build/runtime step without buying anything `patterns.css` / `base.css` can consume.

### B.1 Scope

**Added** (seven files):

- [web/src/styles/tokens.css](../../../web/src/styles/tokens.css) — same as A.2.1.
- [web/src/styles/semantic.css](../../../web/src/styles/semantic.css) — same as A.2.2.
- [web/src/styles/recipes.css](../../../web/src/styles/recipes.css) — **new file**, see B.2.3.
- [web/src/styles/base.css](../../../web/src/styles/base.css) — verbatim from v2.
- [web/src/styles/patterns.css](../../../web/src/styles/patterns.css) — v2 patterns, but `entry-*` / `card` / `tool-chip-*` selectors now resolve from recipe-level vars (`--message-bubble-bg` etc.) rather than directly from semantic vars.
- [web/src/styles/index.css](../../../web/src/styles/index.css) — aggregator: `tokens → semantic → recipes → base → patterns`.
- [web/src/styles/highlight-overrides.css](../../../web/src/styles/highlight-overrides.css) — same as A.2.6.

**Changed**: same as A (main.ts import block; hex replacement across components). In components, the **semantic var or the recipe-level var may be used**, with this rule: if the value belongs to a recognised component "recipe" (message bubble, tool chip, card tone, button), prefer the recipe-level var; otherwise use the semantic var.

**Deleted**: none.

### B.2 Concrete code skeletons

#### B.2.1, B.2.2 `tokens.css`, `semantic.css`

Identical to A.2.1 and A.2.2.

#### B.2.3 `recipes.css` — new file

```css
/* ─── Component Recipes ─────────────────────────────────────────────────────
   Compose semantic vars into component-level variables. Pattern classes and
   scoped blocks read these instead of raw semantic vars. Zero hex.
   ────────────────────────────────────────────────────────────────────────── */

:root {
  /* Message bubble (chat) */
  --message-bubble-bg:           var(--entry-user-bg);
  --message-bubble-border:       var(--entry-user-border);
  --message-bubble-fg:           var(--text);
  --message-bubble-meta-fg:      var(--text-muted);

  --message-bubble-assistant-bg:     var(--entry-user-bg);   /* same blue tint */
  --message-bubble-assistant-border: var(--entry-user-border);

  --message-bubble-system-bg:     var(--entry-warn-bg);
  --message-bubble-system-border: var(--entry-warn-border);
  --message-bubble-system-fg:     var(--warn);

  /* Tool chip (F05) */
  --tool-chip-bg:             var(--surface-2);
  --tool-chip-border:         var(--border);
  --tool-chip-fg:             var(--text-muted);
  --tool-chip-name-fg:        var(--text);

  --tool-chip-call-border:    var(--entry-user-border);
  --tool-chip-call-fg:        var(--accent-2);
  --tool-chip-ok-border:      var(--entry-accent-border);
  --tool-chip-ok-fg:          var(--accent);
  --tool-chip-error-border:   var(--entry-danger-border);
  --tool-chip-error-fg:       var(--danger);
  --tool-chip-pending-border: var(--entry-warn-border);
  --tool-chip-pending-fg:     var(--warn);

  /* Card (board / detail) */
  --card-bg:            var(--surface-1);
  --card-border:        var(--border);
  --card-active-border: var(--entry-accent-border);
  --card-meta-fg:       var(--text-muted);

  /* Button */
  --btn-bg:                var(--surface-2);
  --btn-bg-hover:          var(--surface-3);
  --btn-border:            var(--border);
  --btn-border-hover:      var(--border-strong);
  --btn-fg:                var(--text-muted);
  --btn-fg-hover:          var(--text);

  /* Code surfaces */
  --code-inline-bg:     var(--code-bg);
  --code-inline-fg:     var(--code-color);
  --code-block-surface: var(--code-block-bg);
  --code-block-edge:    var(--code-block-border);
  --code-block-fg:      var(--code-block-text);

  /* Panel heading */
  --panel-heading-bg:     var(--surface-1);
  --panel-heading-border: var(--border);
  --panel-heading-fg:     var(--text);

  /* Status dots — re-exported by tone */
  --status-dot-running: var(--accent);
  --status-dot-warn:    var(--warn);
  --status-dot-error:   var(--danger);
  --status-dot-idle:    var(--text-faint);
}
```

#### B.2.4 `patterns.css` — selectors rewritten to recipe vars

```css
.entry-user      { border-color: var(--message-bubble-border);           background: var(--message-bubble-bg); }
.entry-accent    { border-color: var(--message-bubble-assistant-border); background: var(--message-bubble-assistant-bg); }
.entry-warn      { border-color: var(--message-bubble-system-border);    background: var(--message-bubble-system-bg); }
.entry-danger    { border-color: var(--tool-chip-error-border);          background: var(--entry-danger-bg); }  /* error tint */
.entry-purple    { border-color: var(--entry-purple-border);             background: var(--entry-purple-bg); }

.card            { border: 1px solid var(--card-border); background: var(--card-bg); border-radius: var(--radius); }
.card-active     { border-color: var(--card-active-border); }

.btn             { /* …layout… */ border: 1px solid var(--btn-border); background: var(--btn-bg); color: var(--btn-fg); }
.btn:hover:not(:disabled) { color: var(--btn-fg-hover); border-color: var(--btn-border-hover); background: var(--btn-bg-hover); }
.btn-primary     { border-color: var(--btn-primary-border); background: var(--btn-primary-bg); color: var(--btn-primary-text); }
.btn-primary:hover:not(:disabled) { background: var(--btn-primary-bg-hover); }
.btn-danger      { color: var(--danger); border-color: var(--tool-chip-error-border); }

.pill            { /* …layout… */ border: 1px solid var(--border); color: var(--text-muted); background: var(--surface-2); }
/* …pill-warn / pill-accent / pill-danger unchanged from v2… */

.code-inline     { background: var(--code-inline-bg); color: var(--code-inline-fg); /* … */ }
.code-block      { background: var(--code-block-surface); border: 1px solid var(--code-block-edge); color: var(--code-block-fg); /* … */ }

.panel-heading   { background: var(--panel-heading-bg); border-bottom: 1px solid var(--panel-heading-border); /* … */ }

/* …syn-*, text-*, overlay, spin, pulse: unchanged from v2 because there is
   nothing recipe-shaped about them — they are direct semantic exports. */
```

#### B.2.5 `index.css`

```css
@import "./tokens.css";
@import "./semantic.css";
@import "./recipes.css";
@import "./base.css";
@import "./patterns.css";
```

### B.3 Implementation steps

1. Add the seven files (B.1).
2. Edit [web/src/main.ts](../../../web/src/main.ts) identical to A.2.7.
3. **Mechanical hex replacement**, identical to A step 3, except: per component, choose between the **semantic var** and the **recipe var** using this decision rule: if the call site is a known recipe (chat bubble background, tool-chip status fg/border, card surface, button surface, code surface, panel heading, status dot), use the recipe var; otherwise use the semantic var. The decision rule is encoded in §A.6 of the analysis mapping table extended with one extra column "recipe (if any)" — written into this design as B.3.a below.
4. Grep gates: A's gate (no hex outside tokens.css) **plus** a B-only sanity grep, `grep -rEn 'var\(--(entry-user|entry-accent|entry-warn|entry-danger|surface-[12]|btn-primary-)' web/src --include='*.vue'`, used as a **lint advisory**: hits inside chat / chip / card / button regions should be converted to recipe vars before commit.

**B.3.a — Recipe assignment per call site (delta over the §3.4 analysis table):**

| Surface | Component file(s) | Recipe var |
| --- | --- | --- |
| User message strip | [AnalystChatPanel.vue](../../../web/src/components/chat/AnalystChatPanel.vue), [AgentConversationView.vue](../../../web/src/components/agents/AgentConversationView.vue) | `--message-bubble-*` |
| Assistant message strip | as above | `--message-bubble-assistant-*` |
| System / warn message | as above + [DebugView.vue](../../../web/src/views/DebugView.vue) | `--message-bubble-system-*` |
| Tool chip surfaces | as above | `--tool-chip-*` |
| Card surfaces | [CardsBoardView.vue](../../../web/src/components/cards/CardsBoardView.vue), [CardDetailView.vue](../../../web/src/components/cards/CardDetailView.vue), [CardsTimelineView.vue](../../../web/src/components/cards/CardsTimelineView.vue) | `--card-*` |
| Secondary buttons | many | `--btn-*` |
| Code shells | [CodeBlock.vue](../../../web/src/components/code/CodeBlock.vue), [MarkdownText.vue](../../../web/src/components/code/MarkdownText.vue) | `--code-block-*` / `--code-inline-*` |
| Panel headings | [AppShell.vue](../../../web/src/components/layout/AppShell.vue) and sub-views | `--panel-heading-*` |
| Status dots | [DashboardView.vue](../../../web/src/views/DashboardView.vue), agent views | `--status-dot-*` |

Everything else uses the semantic var directly, as in Proposal A.

### B.4 Validation

Same gates as A.4, plus:

- `recipes.css` and `patterns.css` contain zero hex (grep gate of A.4.2 already covers this).
- `pnpm -C web build` shows the import chain resolving in order `tokens → semantic → recipes → base → patterns`. No `@import` cycle.
- Computed-styles spot check: clicking a chat bubble in DevTools shows the computed `background-color` resolves via `--message-bubble-bg → --entry-user-bg → color-mix(...)`. (CSS DevTools displays the var chain.)
- Visual diff matrix identical to A.4.5.
- Contrast table identical to A.4.6 — recipe layer is pure indirection, no value change.

### B.5 Risks and rollback

| Risk | Mitigation |
| --- | --- |
| One more layer of indirection — diagnosing "why is this colour wrong?" requires walking three vars deep. | DevTools shows the var resolution chain inline; the recipe layer file is short (≈60 lines); each recipe name is component-shaped so the chain is self-documenting. |
| Recipe names risk drifting from real component names as F02 / F03 / F04 / F05 refactor components. | Recipe names are derived from F02 r2's `ui/` and `composites/` tree (B.2.3 mirrors F02's component naming), so they stay in sync as F02 lands. |
| Two ways to spell the same colour at a call site (semantic var vs recipe var) — invites inconsistency. | B.3.a's decision rule is mechanical; the B-only lint advisory grep flags violations. |
| `recipes.css` adds a runtime cost. | Zero. CSS custom properties resolve once per declaration, no JS, no cascade re-evaluation. |
| F02 cannot start until recipes are stable. | F02 r2 already lists the pattern surface F01 must ship; B.2.3 covers exactly those surfaces, so the contract is the same. |

**Rollback.** Single commit. `git revert <sha>` returns v3 to the pre-F01 state.

### B.6 Cross-issue impact

- **F02.** Recipe vars **make F02 easier**: when F02 collapses a scoped `<style>` block onto a pattern class, it can also bind the recipe var at the component root if it needs a tone variant, e.g., `style="--message-bubble-bg: var(--entry-accent-bg)"` on a single bubble. This is the "tighter contract" benefit.
- **F03 / F04.** Same as A; chat surfaces consume `--message-bubble-*` instead of `--entry-user-*` directly.
- **F05.** Tool chips consume `--tool-chip-*` instead of `--accent-2` / `--accent` / `--danger` / `--warn` directly. F05's contract changes by one indirection but its behavior does not.

### B.7 Why option (a) was rejected

Option (a) (a `theme/` module exported from `index.ts` that synthesizes `:root` declarations at runtime from a typed `Theme` object) was considered. Rejected because:

- `patterns.css` and `base.css` cannot consume a TypeScript value — they would still need a generated CSS file, so the typed source isn't a single source of truth, just a parallel one.
- The typed access is only useful in inline `style` bindings. Inline bindings already work with `var(--…)` and Vue resolves them correctly.
- Adds a Vite plugin or codegen step. The workspace preference is to mirror v2's plain-CSS pipeline, not invent a new build dependency.
- Multi-theme would still require swapping the generated `:root` block. The plain-CSS approach can do the same with a body class or `data-theme` selector when (and only when) a second theme is in scope, which is explicitly **not** the case for F01.

---

## Recommendation: Proposal A

Choose **Proposal A** (the focused four-file CSS port).

### Reasoning against the mandatory criteria

1. **Architecture-first.** A delivers exactly v2's architecture in v3: same file names, same import order, same layering rules, same pattern surface. The architectural win F01 is meant to deliver — global tokens + semantic mapping + pattern classes + base reset — is realised at the same depth as v2. B adds a fourth indirection (`recipes.css`) on top of `semantic.css`; that indirection is **architecture-adjacent**, not architecture-essential. The right time to add a component-level recipe layer is when component-level needs emerge that the semantic layer cannot express, and the analysis §3.4 mapping table shows the semantic layer absorbs the entire v3 palette without remainder. No motivating gap exists today.

2. **No backward compatibility.** A drops every hex literal from non-token files in a single batch. No shims, no `--legacy-*`, no dual-write phase. B does the same. Both are equally clean on this axis.

3. **F02 hierarchical decomposition.** F02 r2 §2.1 lists exactly the v2 patterns it expects F01 to ship; A ships them. F02 r2 §2.2 names the **only** v3-specific extension F02 itself will add (`.tool-chip*` family). Neither F02 r2 nor any analysis upstream requests a recipe layer. Adding recipes pre-emptively, without an F02 / F03 / F04 / F05 design that consumes them, is speculative — and the project guideline rejects speculative architecture. If F02 (or F03/F04/F05) at the **design** stage discovers a recipe-shaped need, it can introduce `recipes.css` as a targeted addition in its own commit; F01 does not need to pre-allocate that future.

4. **Contrast table from the analysis.** A's value mapping is the analysis table verbatim. Every WCAG AA pair in §7 of the analysis is preserved (11 of 12 pairs above 4.5:1, plus the single 3.9:1 `--text-faint` on `--bg` borderline that meets the 3:1 large-text minimum). B preserves the same values — recipes are pure indirection — so this criterion does not differentiate the two; it confirms either is acceptable, and the simpler one wins.

5. **Single batch landing.** Both A and B land in one commit with no temporary dual visual system. A's diff is smaller (six files added + N component edits); B's diff is larger (seven files added + same N component edits + a recipe-vs-semantic decision per chat/chip/card/button site). Smaller diff under identical guarantees is preferred.

6. **Future optionality.** A does **not** foreclose B. If, three issues from now, F03 or F05 discovers a component-level contract that benefits from a recipe layer, `recipes.css` can be inserted between `semantic.css` and `patterns.css` with one `@import` line and a targeted set of selector rewrites. The cost of adding recipes later is bounded; the cost of stripping them out if they turn out to be over-engineering is higher (every consumer site has to be re-pointed at the semantic var). Defer the decision until a real consumer asks for it.

### What this commits us to

- The exact six files in A.1, written per A.2.
- The mechanical hex replacement in A.3, gated by the grep in A.4.2.
- The validation matrix in A.4.5 through A.4.7.
- No `.tool-chip*` selectors in `patterns.css` at the F01 commit; F02 adds them in its own commit.

### Final artifacts

**Chosen proposal:** A
**Path:** `/home/salva/g/ml/saivage-v3/SPEC/2026-05/review-ui-port-from-v2/F01-design-tokens/02-design-r1.md`
