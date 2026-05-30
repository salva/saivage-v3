# F01 — Design tokens & semantic CSS layer — Design (r2)

Issue: [F01-design-tokens.md](../F01-design-tokens.md)
Approved analysis: [01-analysis-r2.md](01-analysis-r2.md) (approved by [ANALYSIS-APPROVED.md](ANALYSIS-APPROVED.md)).
Binding critique: [02-design-review-r1.md](02-design-review-r1.md).
Previous draft: [02-design-r1.md](02-design-r1.md).
Cross-issue alignment: [F02 r2](../F02-component-hierarchy/01-analysis-r2.md), [F05 r2](../F05-tool-detail-rendering/01-analysis-r2.md).
v2 sources: [saivage/web/src/styles/](../../../../../saivage/web/src/styles/).
v3 target: [web/src/](../../../../web/src/).

This revision preserves r1's two-proposal structure, concrete code skeletons, grep gates, and validation matrix, and corrects two blocking issues raised by the r1 review:

- F01 — not F02 — now owns the F02-required `.status-dot-{ok,warn,danger,accent,muted}`, `.card-{warn,danger,accent,user,purple}`, and `.pill-purple` extensions. The patterns layer is "v2 `patterns.css` plus this fixed extension set", not a purely verbatim copy.
- All references to a global `.tool-chip*` pattern family (and the recipe-layer `--tool-chip-*` variables in Proposal B) are removed. `ToolChip` is a conversation composite owned by F02 / consumed by F03/F04/F05; F01 ships only the semantic vars and primitive tones that `ToolChip` composes via `Card`, `Pill`, `Button`.

Project guideline (binding): **architecture-first, no backward compatibility.** No `--legacy-*` mirrors, no transitional dual visual system, no `@deprecated` re-exports. Everything below lands in one batch.

---

## Coverage map — r1 review required changes

| r1-review item | Where addressed in r2 |
| --- | --- |
| Required #1 — Add F02 tone extensions (`.status-dot-{ok,warn,danger,accent,muted}`, `.card-{warn,danger,accent,user,purple}`, `.pill-purple`) to the chosen Proposal A `patterns.css` skeleton | §A.1 "Added" file list, §A.2.4 "Extension delta block", §A.3 step 1 (write the extensions, not just `cp`), §A.4.2 "grep gate" updated, §A.6 (consumers), §Recommendation §What this commits us to |
| Required #1 — Update implementation steps to write (not `cp`) `patterns.css` | §A.3 step 1, with the explicit "patterns.css is v2 contents + §A.2.4 extension delta" instruction |
| Required #1 — Add grep gates that **assert** the extensions exist and that no global `.tool-chip*` selectors leak in | §A.4.2 has two new gates: positive (extensions present) + negative (no `tool-chip` global classes) |
| Required #1 — Update A.6 cross-issue contract to reflect F01 owning the tone extensions | §A.6 rewritten: lists exactly which F02/F03/F04/F05 consumers read which tone classes |
| Required #1 — Stop describing F01 as "purely verbatim `patterns.css` copy" | §A.1 / §A.2.4 / §A.3 / §Recommendation language updated; the verbatim claim is restricted to `base.css` only |
| Required #2 — Remove the claim that F02 introduces global `.tool-chip*` patterns | §A.6 "F05" bullet rewritten; mention of "F02 will introduce `.tool-chip*`" deleted; the recommendation's `tool-chip*` sentence removed |
| Required #2 — Reframe F03/F04/F05 chip narrative around shared ToolChip composite using F01 semantic vars + primitive tones | §A.6 has explicit bullets per F03/F04/F05 describing the consumed semantic vars and the tone classes ToolChip composes (`.card`, `.card-accent`, `.card-danger`, `.card-warn`, `.pill-*`, `.btn`, `.status-dot-*`) |
| Required #2 — If Proposal B remains, mark its `--tool-chip-*` recipe as rejected for cutting across F02/F04/F05 | §B.2.3 strips `--tool-chip-*` from recipes; §B.7-new explicitly rejects per-component chip recipes for the same reason; §Recommendation cites this as additional evidence for choosing A |
| Non-blocking — Prose about "every rgba() over a token" was inaccurate | §A.2.2 prose corrected; `--border-subtle`, `--overlay-bg`, `--hover-bg` are explicitly called out as direct rgba constants (allowed under the "zero hex outside tokens" rule) |
| Non-blocking — Playwright screenshot diff would strengthen the matrix | §A.4.5 adds an optional Playwright-backed step (gated as "if available") without making it a blocker for F01 design approval |
| Non-blocking — Relative markdown links from F01 are off | All links in this file are re-rooted from `/home/salva/g/ml/saivage-v3/SPEC/2026-05/review-ui-port-from-v2/F01-design-tokens/` — five `..` to reach repo root, six to reach the workspace, so `web/src/...` is `../../../../web/src/...` and `saivage/web/src/styles/` is `../../../../../saivage/web/src/styles/`. Verified against directory depth. |

---

## Proposal A — Focused CSS port with F02 tone extensions

### A.1 Scope (files added / changed / deleted)

**Added** (six files, all under [web/src/styles/](../../../../web/src/styles/) — new directory):

- [web/src/styles/tokens.css](../../../../web/src/styles/tokens.css) — raw `--c-*` palette + type stacks + radii + shadows. The **only** v3 file allowed to contain raw hex.
- [web/src/styles/semantic.css](../../../../web/src/styles/semantic.css) — semantic mapping. Resolves to `--c-*` tokens, direct `rgba(...)` literals where the analysis explicitly approves them (`--border-subtle`, `--overlay-bg`, `--hover-bg`), or `color-mix(in srgb, var(--c-*) X%, var(--bg))` for the `--entry-*` tints. Zero hex.
- [web/src/styles/base.css](../../../../web/src/styles/base.css) — verbatim from [saivage/web/src/styles/base.css](../../../../../saivage/web/src/styles/base.css). References semantic vars only.
- [web/src/styles/patterns.css](../../../../web/src/styles/patterns.css) — **v2 [patterns.css](../../../../../saivage/web/src/styles/patterns.css) verbatim PLUS the F02-required tone extensions in §A.2.4**. Not a `cp`. References semantic vars only.
- [web/src/styles/index.css](../../../../web/src/styles/index.css) — aggregator: `@import "./tokens.css"; @import "./semantic.css"; @import "./base.css"; @import "./patterns.css";`.
- [web/src/styles/highlight-overrides.css](../../../../web/src/styles/highlight-overrides.css) — three-rule file overriding `pre.hljs` shell only.

**Changed:**

- [web/src/main.ts](../../../../web/src/main.ts): imports reordered to `./styles/index.css` → `highlight.js/styles/github-dark.css` → `./styles/highlight-overrides.css`, **before** any Vue/Pinia/router setup.
- Every file under [web/src/components/](../../../../web/src/components/), [web/src/views/](../../../../web/src/views/), and [web/src/App.vue](../../../../web/src/App.vue): every hex literal inside `<style scoped>` and every color-bearing `style="…"` / `:style="{ … }"` binding rewritten to `var(--…)` per the §3.4 mapping table from the approved analysis. **No template/markup changes** (those belong to F02).

**Deleted:** none. F01 leaves `<style scoped>` blocks in place; F02 collapses them onto pattern classes and adds `data-testid` markup.

Verbatim-from-v2 claim is restricted to `base.css`. `patterns.css` is **v2 content plus the additive tone extensions in §A.2.4**; this is the only deviation from the v2 stylesheet shape, and it is intentional and required by F02 r2 §2.2.

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

#### A.2.2 `semantic.css` — full skeleton, zero hex

Three resolution shapes are used inside this file:

1. Direct reference to a `--c-*` token (most entries).
2. **Direct `rgba()` literal** for three values where the analysis (§3.2) explicitly approves a constant alpha over white/black not tied to a brand token: `--border-subtle` (`rgba(255,255,255,0.06)`), `--overlay-bg` (`rgba(0,0,0,0.55)`), `--hover-bg` (`rgba(255,255,255,0.04)`). These are not "rgba over a token" — they are flat constants. Allowed under the "zero hex outside `tokens.css`" rule because they contain no hex literals.
3. **`color-mix(in srgb, var(--c-*) X%, var(--bg))`** for the `--entry-*` tints, encoding v2's "rgba(brand, 0.06) over white" idea for dark.

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
  --border-subtle: rgba(255, 255, 255, 0.06);   /* flat rgba, not over a token */

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
     Dark equivalent of v2's "rgba(brand, 0.06) over white":
       border = color-mix toward transparent (alpha-equivalent)
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

  /* Overlay / hover (flat rgba constants) */
  --overlay-bg: rgba(0, 0, 0, 0.55);
  --hover-bg:   rgba(255, 255, 255, 0.04);

  /* Shorthand */
  --mono: var(--font-mono);
}
```

#### A.2.3 `base.css` — verbatim from v2

Copied unchanged from [saivage/web/src/styles/base.css](../../../../../saivage/web/src/styles/base.css). Contains:

- `* { box-sizing: border-box }`.
- `html, body, #app { height: 100% }`.
- `body { margin:0; background: var(--bg); color: var(--text); font-family: var(--font-sans); letter-spacing: 0 }`.
- `button, input { font: inherit }`, `button { letter-spacing: 0 }`.
- `code, pre, .mono { font-family: var(--mono) }`.
- `::-webkit-scrollbar { width: 10px; height: 10px }`, thumb `background: var(--border-strong)`, `border: 2px solid var(--bg)`, `border-radius: var(--radius-pill)`; track transparent.
- Default `code` element: padding, `var(--radius-sm)`, `var(--code-bg)`, `var(--code-color)`; `pre code { padding:0; background:none; color:inherit }`.

Every selector already references semantic vars compatible with `semantic.css`. No edits required.

#### A.2.4 `patterns.css` — v2 contents PLUS F02 tone extensions

The file is the union of two contiguous blocks. Block 1 is v2 verbatim. Block 2 is the F02-required extension delta. Both blocks reference semantic vars only.

**Block 1 — v2 `patterns.css` verbatim.** Selectors (full inventory):

- Entries: `.entry-user`, `.entry-accent`, `.entry-warn`, `.entry-danger`, `.entry-purple`.
- Cards: `.card`, `.card-active`.
- Buttons: `.btn`, `.btn:hover:not(:disabled)`, `.btn:disabled`, `.btn-primary`, `.btn-primary:hover:not(:disabled)`, `.btn-danger`.
- Pills: `.pill`, `.pill-warn`, `.pill-accent`, `.pill-danger`.
- Code: `.code-inline`, `.code-block`.
- Syntax: `.syn-key`, `.syn-string`, `.syn-number`, `.syn-boolean`, `.syn-null`, `.syn-punctuation`.
- Panel: `.panel-heading`, `.panel-heading h2`, `.panel-heading h3`.
- Status: `.status-dot` (size + radius only, no tone).
- Text utilities: `.text-muted`, `.text-faint`, `.text-accent`, `.text-warn`, `.text-danger`.
- Overlay: `.overlay`.
- Animations: `@keyframes spin`, `.spin`, `@keyframes pulse` (keyframe only; no `.pulse` class in v2).

**Block 2 — F02 extension delta (additive, written by F01).** Required by [F02 r2 §2.2](../F02-component-hierarchy/01-analysis-r2.md). These selectors are the **complete** F01-owned extension surface; no other v3-only pattern class is added at F01.

```css
/* ─── F02 tone extensions (added by F01) ─────────────────────────────────── */

/* Status-dot tone modifiers. .status-dot itself (size+radius) lives in
   Block 1; these set the background color for each semantic tone. */
.status-dot-ok      { background: var(--accent); }
.status-dot-warn    { background: var(--warn); }
.status-dot-danger  { background: var(--danger); }
.status-dot-accent  { background: var(--accent-2); }
.status-dot-muted   { background: var(--text-muted); }

/* Card tone modifiers. The .card primitive (Block 1) supplies border-radius
   and the default surface; these add per-tone border + background. */
.card-warn   { border-color: var(--entry-warn-border);   background: var(--entry-warn-bg); }
.card-danger { border-color: var(--entry-danger-border); background: var(--entry-danger-bg); }
.card-accent { border-color: var(--entry-accent-border); background: var(--entry-accent-bg); }
.card-user   { border-color: var(--entry-user-border);   background: var(--entry-user-bg); }
.card-purple { border-color: var(--entry-purple-border); background: var(--entry-purple-bg); }

/* Pill tone modifier — purple is the only one missing from v2. */
.pill-purple { border-color: var(--entry-purple-border); color: var(--purple); }
```

**What is explicitly NOT added.** Per the r1 review and F02 r2 §2.3:

- No `.tool-chip`, `.tool-chip-row`, `.tool-chip-call`, `.tool-chip-ok`, `.tool-chip-error`, `.tool-chip-pending`, `.tool-chip-details`. `ToolChip` is a conversation composite (F02 `conversation/`), not a global pattern; its surface is built from `.card` + `.card-{accent,danger,warn}` + `.pill-*` + `.btn` + a scoped layout block local to the SFC.
- No `.btn-sm` (F02 r2 §2.3 dropped the `size` prop; icon-only is a primitive-local layout class).
- No `.msg`, `.msg-meta`, `.msg-content`, `.msg-badges`. `MessageBubble` is a composite that uses `.card` + `.card-{user,accent,purple,warn,danger}` plus its own scoped layout.
- No `.role-*`, `.kind-*`. Composite-local layout classes; not pattern classes.
- No `.thinking-dots`. `ThinkingDots` is a composite using the `@keyframes pulse` from Block 1 plus its own scoped layout.
- No `.pill-active`. F02 r2 §3.2 deliberately drops this; pressed-pill styling comes from `[aria-pressed="true"]` plus a surface-local rule.
- No `.panel-heading-h1`. F02 r2 §3.4 keeps `WorkspaceHeader` outside `PanelHeading`, so an `h1` selector is unnecessary.

The extension set above is **closed**. F02 cannot ship if any of the §2.2 patterns are missing; conversely, F02 r2 has agreed this is the entire set it needs from F01.

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

1. **Add the six style files** under [web/src/styles/](../../../../web/src/styles/).
   - `base.css` is a `cp` from v2.
   - `patterns.css` is **NOT a `cp`** — it is written by concatenating v2's `patterns.css` (Block 1) with the F02 extension delta (Block 2, §A.2.4). Concretely: copy v2's file, then append §A.2.4's block at the end with the comment header shown.
   - `tokens.css`, `semantic.css` are written per §A.2.1–§A.2.2.
   - `index.css`, `highlight-overrides.css` are written verbatim per §A.2.5–§A.2.6.
   - Positive grep gate (extension presence):
     ```bash
     grep -En '^\.(status-dot-(ok|warn|danger|accent|muted)|card-(warn|danger|accent|user|purple)|pill-purple)\b' web/src/styles/patterns.css
     ```
     Must show 11 matches.
   - Negative grep gate (no global chip pattern):
     ```bash
     grep -rEn 'tool-chip' web/src/styles
     ```
     Must show zero matches.
   - Hex gate: `grep -rEn '#[0-9a-fA-F]{3,8}\b' web/src/styles | grep -v '^web/src/styles/tokens\.css'` → zero matches.
2. **Edit [web/src/main.ts](../../../../web/src/main.ts)** to the import block in §A.2.7. Verify with `head -3 web/src/main.ts`.
3. **Mechanical hex replacement** across [web/src/components/](../../../../web/src/components/), [web/src/views/](../../../../web/src/views/), [web/src/App.vue](../../../../web/src/App.vue). Use the §3.4 mapping table from [01-analysis-r2.md](01-analysis-r2.md) as the authoritative source. For each hex `H` in the table:
   - `grep -rln "${H}" web/src --include='*.vue' --include='*.ts'` to enumerate sites.
   - Per site: replace inside `<style scoped>` blocks, `style="…"` inline bindings, and `:style="{ … }"` object bindings (which use raw strings) with the mapped `var(--…)`.
   - The two ambiguous values (`#3fb950` — accent vs btn-primary-bg, `#fff` — single inline) require grep-and-decide per call site; both rules are spelled out in §3.4 of the analysis.
   - Two grep contexts where hex is allowed and must be skipped: `web/src/styles/tokens.css` and test fixtures under `web/src/__tests__/` that use card-id strings beginning with `#` (these aren't CSS hex; the validation grep already excludes the tests directory).
   - **No template surgery, no `data-testid` additions, no class swaps** — those are F02's job. F01 only swaps hex for `var(--…)`.
4. **Grep gates (full repo)** — all four must pass; see §A.4.2.
5. **Run validation** (see §A.4) before committing. Snapshot re-baselining is part of the same commit.

No intermediate commit. No `// TODO F02:` comments. Pattern-class adoption is F02's job in a later commit.

### A.4 Validation

All from [/home/salva/g/ml/saivage-v3](../../../../). All must succeed:

#### A.4.1 Typecheck

`pnpm -C web typecheck` — passes. F01 does not touch `.ts` types.

#### A.4.2 Grep gates (four)

1. **Hex outside tokens** (zero matches required):
   ```bash
   grep -rEn '#[0-9a-fA-F]{3,8}\b' web/src --include='*.vue' --include='*.ts' --include='*.css' \
     | grep -v '^web/src/styles/tokens\.css' \
     | grep -v '^web/src/__tests__/'
   ```
2. **F02 extensions present in patterns.css** (11 matches required):
   ```bash
   grep -En '^\.(status-dot-(ok|warn|danger|accent|muted)|card-(warn|danger|accent|user|purple)|pill-purple)\b' \
     web/src/styles/patterns.css
   ```
3. **No global `.tool-chip*` styles leaked into the style layer** (zero matches required):
   ```bash
   grep -rEn '\.tool-chip|tool-chip-' web/src/styles
   ```
4. **No `.msg-*`, `.role-*`, `.kind-*`, `.btn-sm`, `.thinking-dots`, `.pill-active`, `.panel-heading-h1` patterns** (zero matches required):
   ```bash
   grep -rEn '\.(msg-(meta|content|badges)|role-(user|assistant|system)|kind-(reasoning|activity|plain)|btn-sm|thinking-dots|pill-active|panel-heading-h1)\b' \
     web/src/styles
   ```

#### A.4.3 Tests

`pnpm -C web test` — passes. Existing tests assert behavior (class names, text, attribute presence), not hex literals; snapshot churn risk is bounded to [web/src/__tests__/__snapshots__/](../../../../web/src/__tests__/__snapshots__/) and is re-baselined inside the F01 commit (review the diff; no behavior-bearing snapshot should change).

#### A.4.4 Build

`pnpm -C web build` — passes. Vite resolves the `@import` chain and inlines the four CSS files; `highlight.js/styles/github-dark.css` is resolved from node_modules; `highlight-overrides.css` lands after it.

#### A.4.5 Visual diff matrix — manual

Every surface, against the dark-mode preview:

- [web/src/views/DashboardView.vue](../../../../web/src/views/DashboardView.vue): rt-frozen tile keeps blue tint; tile borders match `--border`.
- [web/src/components/layout/AppShell.vue](../../../../web/src/components/layout/AppShell.vue): auth-required banner red-on-dark-red; emphasis word uses `--danger`; body text legible.
- [web/src/components/chat/AnalystChatPanel.vue](../../../../web/src/components/chat/AnalystChatPanel.vue): user/assistant strips and tool chips retain blue/grey contrast; composer surface unchanged.
- [web/src/components/agents/AgentConversationView.vue](../../../../web/src/components/agents/AgentConversationView.vue): per-step tool bars; warn / danger / accent strips distinct.
- [web/src/components/auth/ApiTokenEntry.vue](../../../../web/src/components/auth/ApiTokenEntry.vue): danger strip + primary button.
- [web/src/components/code/CodeBlock.vue](../../../../web/src/components/code/CodeBlock.vue), [web/src/components/code/MarkdownText.vue](../../../../web/src/components/code/MarkdownText.vue): code blocks render against `--code-block-bg`; highlight.js token colors unchanged.
- [web/src/components/nav/NavRail.vue](../../../../web/src/components/nav/NavRail.vue): hover/selected states drive from `--surface-*` and `--hover-bg`.
- [web/src/views/FilesView.vue](../../../../web/src/views/FilesView.vue): quarantine footer reads as surface-2.
- [web/src/views/DebugView.vue](../../../../web/src/views/DebugView.vue): per-process entry strips warn/danger/accent.

#### A.4.5.opt — Optional Playwright screenshot baseline

(Non-blocking for F01 design approval; recommended for the implementation commit.) If a Playwright runner is wired into the repo by the time F01 lands, capture a full-page screenshot of each surface in §A.4.5 before and after the commit. A pixel diff against the pre-commit baseline should show **only colour-channel differences inside surfaces and borders** — no layout shift, no missing text, no missing elements. If Playwright is not available, the manual matrix in §A.4.5 is sufficient.

#### A.4.6 Contrast spot-check

Every pair from §7 of the analysis is met on the dark palette; AA pass count is 11/12, with `--text-faint` on `--bg` borderline at 3.9:1 (acceptable for de-emphasised meta text under AA large-text 3:1).

#### A.4.7 Computed-style spot-check

Open DevTools on the visual-diff surfaces; no raw hex appears in "Computed" other than highlight.js `.hljs-*` token rules.

### A.5 Risks and rollback

| Risk | Mitigation |
| --- | --- |
| `color-mix(in srgb, …, transparent)` browser support | Targeted browsers (Chromium ≥ 111, Firefox ≥ 113, Safari ≥ 16.2) all support `color-mix`. Vite/Vue 3 baseline already implies modern evergreen. No fallback needed. |
| highlight.js cascade collision | Resolved by import order: `index.css` first (so patterns lose `pre.hljs` to highlight.js), then `github-dark.css`, then `highlight-overrides.css` (one rule, wins for the shell). `.hljs-*` token rules are not touched. |
| Snapshot churn | Bounded — snapshots assert on class names / text / attribute presence; the F01 commit re-baselines any embedded color values as part of its diff. |
| Scrollbar regression on hidden-overflow surfaces | The global `::-webkit-scrollbar` only paints when scrollbars actually appear; `overflow:hidden` regions are unaffected. Visual matrix covers all live scrollers. |
| Inline `style` bindings with hex | Step 3 explicitly covers `style="…"` and `:style="{ … }"` strings. Gate A.4.2#1 catches any miss. |
| `.syn-*` vs `.hljs-*` specificity | Documented at the top of `patterns.css` as a code comment: source order wins; `.hljs-*` (later import) takes priority when both are applied to one element. Today there is no such overlap. |
| F01 ships tone extensions, F02 never lands → orphan classes | Acceptable. The 11 extensions read only semantic vars; if no consumer adopts them, they sit unused but break nothing. F02 is queued to land immediately after F01. |
| F02 needs additional tone selectors we haven't anticipated | F02 r2 §2.2 is the source of truth and is reviewer-vetted. Any new pattern selector F02 turns out to need lands in F02's own commit as an explicit extension; nothing in this design forbids that. F01's responsibility is to ship exactly the closed set above. |

**Rollback.** Single commit. `git revert <sha>` returns v3 to the pre-F01 state in one operation. There is no schema, no data migration, no on-disk format change.

### A.6 Cross-issue impact — corrected

The r1 review's blocking issue #2 was that F01 r1 framed F03/F04/F05 chip styling around an F02-introduced `.tool-chip*` family. That framing is removed here. The corrected contract:

**F02 (component hierarchy).** F02 r2 §2.1 lists exactly the Block-1 patterns it expects to consume verbatim — F01 ships them. F02 r2 §2.2 lists exactly the additive tones F01 must add — §A.2.4 ships them. F02 r2 §2.3 enumerates patterns F02 will NOT introduce as global styles (the `.tool-chip*`, `.msg*`, `.role-*`, `.kind-*` families); F01 mirrors that by also not adding them. The contract is closed in both directions.

**F03 (conversation rounds).** Round cards consume `.card` + `.card-active`. Round filter chips consume `.pill as="button"` plus `aria-pressed` plus F02's local tablist convention (no global `.pill-active`). Diagnostic categories (`model_issue`, `model_repair`, `model_recovered`) consume `.pill-purple` and `.card-purple` from §A.2.4. Pending-call footer consumes `.card-warn` plus `.pill-warn`. Compacted clusters consume `.card-warn` plus `.pill`. Round status dots consume `.status-dot` + `.status-dot-{ok,warn,danger,accent,muted}` from §A.2.4. **No `.tool-chip*` patterns are introduced or consumed.**

**F04 (chat surface style).** Composer surface and message strips consume `--surface-1`, `--surface-2`, plus the message-bubble composite which itself composes `.card` + `.card-{user,accent,purple,warn,danger}` from §A.2.4. No second chip implementation, no `.tool-chip-pending` global. F04 r2's decision to keep ToolChip styling component-scoped and primitive-composed is honoured here.

**F05 (tool-detail rendering).** Tool chips are rendered by the F02 `ToolChip` conversation composite. Inside `ToolChip.vue` the markup is a non-button `<div role="group">` (per F05 r2 §6) whose visuals come from: `.card` (Block 1) + `.card-accent` / `.card-danger` / `.card-warn` (§A.2.4) for the status tone of the wrapper; `.btn` (Block 1) for the single expand button; `.pill` + `.pill-accent` / `.pill-warn` / `.pill-danger` (Block 1) for the detail badge; F05's `InlineParts.vue` renders `.inline-file`, `.inline-url`, `.inline-code`, `.inline-text` scoped to that SFC (those are local classes, not pattern classes). F05's `InlinePart` `tone` values (`'ok' | 'warn' | 'danger' | 'muted'`) map to `--accent` / `--warn` / `--danger` / `--text-muted` — all semantic vars defined in §A.2.2. F01 makes these vars available; F02 owns the `ToolChip` composite; F05 owns the markup and the presenter contract. **F01 does not ship and does not pre-authorize any global chip pattern.**

Cross-issue grep guarantees (positive): every var name listed in §A.2.2 appears in `web/src/styles/semantic.css`. Cross-issue grep guarantee (negative): `grep -rEn '\.tool-chip|tool-chip-' web/src/styles` returns no matches (§A.4.2#3).

---

## Proposal B — "Tokens + recipes + tones" three-layer split (revised)

This is the higher-leverage alternative from r1 with two corrections required by the r1 review:

- The `--tool-chip-*` recipe block is **removed**. Per F02 r2 §2.3 / F04 r2 / F05 r2, `ToolChip` styling is component-scoped and primitive-composed; promoting it to a recipe layer would cut across that decision.
- The F02 tone extensions from §A.2.4 are still owned by F01 in Proposal B as well — `patterns.css` is **not** a verbatim copy under B either.

`recipes.css` sits between `semantic.css` and component consumers and composes the semantic vars into component-level CSS variables (e.g., `--message-bubble-bg`, `--card-active-border`, `--btn-fg-hover`) that are read by either pattern classes or `<style scoped>` blocks. Component-level vars give a tighter contract: swapping the semantic mapping later does not silently re-tone a single component.

### B.1 Scope

**Added** (seven files):

- `tokens.css` — same as §A.2.1.
- `semantic.css` — same as §A.2.2.
- `recipes.css` — new file, see §B.2.3.
- `base.css` — verbatim from v2.
- `patterns.css` — **v2 patterns plus the F02 extension delta from §A.2.4**, but the `.entry-*` / `.card*` / button selectors now resolve from recipe-level vars (`--message-bubble-bg` etc.) rather than directly from semantic vars.
- `index.css` — aggregator: `tokens → semantic → recipes → base → patterns`.
- `highlight-overrides.css` — same as §A.2.6.

**Changed**: same as A (main.ts import block; hex replacement across components). In components, the **semantic var or the recipe-level var may be used**, with this rule: if the value belongs to a recognised component "recipe" (message bubble, card tone, button, code surface, panel heading, status dot), prefer the recipe-level var; otherwise use the semantic var.

**Deleted**: none.

### B.2 Concrete code skeletons

#### B.2.1, B.2.2 `tokens.css`, `semantic.css`

Identical to §A.2.1 and §A.2.2.

#### B.2.3 `recipes.css` — new file (no `--tool-chip-*`)

```css
/* ─── Component Recipes ─────────────────────────────────────────────────────
   Compose semantic vars into component-level variables. Pattern classes and
   scoped blocks read these instead of raw semantic vars. Zero hex.
   NOTE: there is no --tool-chip-* recipe family. ToolChip is a conversation
   composite whose internal visuals are component-scoped (F02 r2 §2.3,
   F04 r2, F05 r2). Promoting chip variants to recipes would cut across that
   decision; recipe-vetted surfaces are limited to message-bubble / card /
   button / code / panel / status-dot.
   ────────────────────────────────────────────────────────────────────────── */

:root {
  /* Message bubble (chat) */
  --message-bubble-user-bg:          var(--entry-user-bg);
  --message-bubble-user-border:      var(--entry-user-border);
  --message-bubble-assistant-bg:     var(--entry-accent-bg);
  --message-bubble-assistant-border: var(--entry-accent-border);
  --message-bubble-system-bg:        var(--entry-purple-bg);
  --message-bubble-system-border:    var(--entry-purple-border);
  --message-bubble-warn-bg:          var(--entry-warn-bg);
  --message-bubble-warn-border:      var(--entry-warn-border);
  --message-bubble-meta-fg:          var(--text-muted);

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
  --status-dot-accent:  var(--accent-2);
  --status-dot-idle:    var(--text-faint);
}
```

#### B.2.4 `patterns.css` — Block 1 selectors rewritten to recipe vars; Block 2 (F02 extension delta) reads recipe vars

Block 1 examples:

```css
.entry-user      { border-color: var(--message-bubble-user-border);      background: var(--message-bubble-user-bg); }
.entry-accent    { border-color: var(--message-bubble-assistant-border); background: var(--message-bubble-assistant-bg); }
.entry-warn      { border-color: var(--message-bubble-warn-border);      background: var(--message-bubble-warn-bg); }
/* … */
.card            { border: 1px solid var(--card-border); background: var(--card-bg); border-radius: var(--radius); }
.card-active     { border-color: var(--card-active-border); }
.btn             { border: 1px solid var(--btn-border); background: var(--btn-bg); color: var(--btn-fg); /* …layout… */ }
```

Block 2 (F02 extension delta) is identical in selector to §A.2.4 but reads through the recipe layer when it has a recipe entry:

```css
.status-dot-ok     { background: var(--status-dot-running); }
.status-dot-warn   { background: var(--status-dot-warn); }
.status-dot-danger { background: var(--status-dot-error); }
.status-dot-accent { background: var(--status-dot-accent); }
.status-dot-muted  { background: var(--status-dot-idle); }
.card-warn         { border-color: var(--entry-warn-border);   background: var(--entry-warn-bg); }
.card-danger       { border-color: var(--entry-danger-border); background: var(--entry-danger-bg); }
.card-accent       { border-color: var(--entry-accent-border); background: var(--entry-accent-bg); }
.card-user         { border-color: var(--entry-user-border);   background: var(--entry-user-bg); }
.card-purple       { border-color: var(--entry-purple-border); background: var(--entry-purple-bg); }
.pill-purple       { border-color: var(--entry-purple-border); color: var(--purple); }
```

`.card-*` tone modifiers deliberately read the semantic `--entry-*` vars directly rather than introducing a `--card-warn-bg` recipe — there is no per-call-site retoning need for warn/danger/accent cards beyond what the semantic layer expresses.

#### B.2.5 `index.css`

```css
@import "./tokens.css";
@import "./semantic.css";
@import "./recipes.css";
@import "./base.css";
@import "./patterns.css";
```

### B.3 Implementation steps

1. Add the seven files (§B.1).
2. Edit [web/src/main.ts](../../../../web/src/main.ts) identical to §A.2.7.
3. **Mechanical hex replacement**, identical to A step 3, except: per component, choose between the **semantic var** and the **recipe var** using this decision rule: if the call site is a known recipe (chat bubble background, card surface, button surface, code surface, panel heading, status dot), use the recipe var; otherwise use the semantic var. The decision rule is encoded in §B.3.a.
4. Grep gates: A's four gates (no hex outside tokens, F02 extensions present, no global chip pattern, no forbidden patterns) **plus** a B-only sanity grep, `grep -rEn 'var\(--(entry-user|entry-accent|entry-warn|entry-danger|surface-[12]|btn-primary-)' web/src --include='*.vue'`, used as a **lint advisory**: hits inside chat / card / button regions should be converted to recipe vars before commit.

**B.3.a — Recipe assignment per call site (delta over the §3.4 analysis table; chip row removed):**

| Surface | Component file(s) | Recipe var |
| --- | --- | --- |
| User message strip | [AnalystChatPanel.vue](../../../../web/src/components/chat/AnalystChatPanel.vue), [AgentConversationView.vue](../../../../web/src/components/agents/AgentConversationView.vue) | `--message-bubble-user-*` |
| Assistant message strip | as above | `--message-bubble-assistant-*` |
| System / diagnostic message | as above + [DebugView.vue](../../../../web/src/views/DebugView.vue) | `--message-bubble-system-*` |
| Warn message / stale ribbon | many | `--message-bubble-warn-*` |
| **Tool chip surfaces** | **NOT a recipe — composed inside `ToolChip.vue` from `.card` + `.card-{accent,danger,warn}` + `.pill-*` + `.btn`** | — |
| Card surfaces (board, detail, timeline) | [CardsBoardView.vue](../../../../web/src/components/cards/CardsBoardView.vue), [CardDetailView.vue](../../../../web/src/components/cards/CardDetailView.vue), [CardsTimelineView.vue](../../../../web/src/components/cards/CardsTimelineView.vue) | `--card-*` |
| Secondary buttons | many | `--btn-*` |
| Code shells | [CodeBlock.vue](../../../../web/src/components/code/CodeBlock.vue), [MarkdownText.vue](../../../../web/src/components/code/MarkdownText.vue) | `--code-block-*` / `--code-inline-*` |
| Panel headings | [AppShell.vue](../../../../web/src/components/layout/AppShell.vue) and sub-views | `--panel-heading-*` |
| Status dots | [DashboardView.vue](../../../../web/src/views/DashboardView.vue), agent views | `--status-dot-*` |

Everything else uses the semantic var directly, as in Proposal A.

### B.4 Validation

Same gates as §A.4 (including the four greps in §A.4.2), plus:

- `recipes.css` and `patterns.css` contain zero hex (§A.4.2#1 already covers this).
- `pnpm -C web build` shows the import chain resolving in order `tokens → semantic → recipes → base → patterns`. No `@import` cycle.
- Computed-styles spot check: clicking a chat bubble in DevTools shows the computed `background-color` resolves via `--message-bubble-user-bg → --entry-user-bg → color-mix(...)`. (CSS DevTools displays the var chain.)
- Visual diff matrix identical to §A.4.5.
- Contrast table identical to §A.4.6 — recipe layer is pure indirection, no value change.
- **No `tool-chip` recipe slipped in**: `grep -E 'tool-chip' web/src/styles/recipes.css` returns zero matches.

### B.5 Risks and rollback

| Risk | Mitigation |
| --- | --- |
| One more layer of indirection — diagnosing "why is this colour wrong?" requires walking three vars deep. | DevTools shows the var resolution chain inline; the recipe layer file is short (≈45 lines); each recipe name is component-shaped so the chain is self-documenting. |
| Recipe names risk drifting from real component names as F02 / F03 / F04 / F05 refactor. | Recipe names are derived from F02 r2's `ui/` and `conversation/` tree (§B.2.3 mirrors that naming), so they stay in sync as F02 lands. |
| Two ways to spell the same colour at a call site. | §B.3.a's decision rule is mechanical; the B-only lint advisory grep flags violations. |
| `recipes.css` adds a runtime cost. | Zero. CSS custom properties resolve once per declaration, no JS, no cascade re-evaluation. |
| F02 cannot start until recipes are stable. | F02 r2 lists exactly the pattern surface F01 must ship; §B.2.3 covers exactly those surfaces; the contract is the same. |
| Recipe layer might be tempted to grow `--tool-chip-*` later. | Comment header in `recipes.css` (§B.2.3) explicitly forbids it. The grep gate in §B.4 enforces it. |

**Rollback.** Single commit. `git revert <sha>` returns v3 to the pre-F01 state.

### B.6 Cross-issue impact

- **F02.** Recipe vars make F02 easier where a per-component retoning is desired (e.g., a single bubble can do `style="--message-bubble-user-bg: var(--entry-accent-bg)"`). They do **not** apply to `ToolChip` — that composite stays scoped, per F02 r2 §2.3.
- **F03 / F04.** Chat surfaces consume `--message-bubble-*` instead of `--entry-*` directly. Round cards still consume `.card` / `.card-active` and the F02 tone extensions; no new recipe is introduced for round cards (the existing card recipe is enough).
- **F05.** Tool chips consume the same semantic vars and primitive tone classes as in Proposal A. The recipe layer does **not** introduce `--tool-chip-*`.

### B.7 Why `--tool-chip-*` recipes are explicitly rejected (added per r1 review)

The r1 design floated `--tool-chip-{bg,border,fg,call,ok,error,pending}` recipe vars. The r1 design review correctly identified that this cuts across the F02/F04/F05 decision to keep `ToolChip` styling component-scoped and primitive-composed. Specifically:

- F02 r2 §2.3 explicitly **drops** all `.tool-chip*` global classes and frames `ToolChip` as a `conversation/` composite that uses `.card` + status-tone classes + `.pill` + `.btn`.
- F04 r2 makes the chat-side chip implementation a single shared `ToolChip`, with no `.tool-chip-pending` global and no second implementation.
- F05 r2 §6 defines chip markup with the toggle button as the only nested interactive element and the visual surface composed from `Card` + `Pill` + `Button`.

Promoting chip variants to recipe-level CSS variables would create a parallel styling contract for a composite the rest of the system has agreed lives entirely inside its SFC. The compatibility-flavoured "let's predefine vars in case F05 wants them" reasoning is exactly the kind of speculative architecture the project guideline forbids. If a future refactor needs a chip-level variable, it lands as a scoped CSS variable inside `ToolChip.vue` — not as a global recipe.

### B.8 Why option (a) was rejected

Option (a) (a `theme/` module exported from `index.ts` that synthesizes `:root` declarations at runtime from a typed `Theme` object) was considered. Rejected because:

- `patterns.css` and `base.css` cannot consume a TypeScript value — they would still need a generated CSS file, so the typed source isn't a single source of truth, just a parallel one.
- The typed access is only useful in inline `style` bindings. Inline bindings already work with `var(--…)` and Vue resolves them correctly.
- Adds a Vite plugin or codegen step. The workspace preference is to mirror v2's plain-CSS pipeline, not invent a new build dependency.
- Multi-theme would still require swapping the generated `:root` block. The plain-CSS approach can do the same with a body class or `data-theme` selector when (and only when) a second theme is in scope, which is explicitly **not** the case for F01.

---

## Recommendation: Proposal A

Choose **Proposal A** (v2 four-file pipeline plus the closed F02 tone extension delta).

### Reasoning against the mandatory criteria

1. **Architecture-first.** A delivers exactly v2's architecture in v3, extended by the closed set of F02-required tones. Same file names, same import order, same layering rules. The architectural win F01 is meant to deliver — global tokens + semantic mapping + pattern classes + base reset — is realised at the same depth as v2, with the additive tones living in the patterns layer where F02 r2 already wants them. B adds a fourth indirection (`recipes.css`); that indirection is architecture-adjacent, not architecture-essential. The right time to add a component-level recipe layer is when component-level needs emerge that the semantic layer cannot express; F03/F04/F05 r2 explicitly do not request one, and they explicitly forbid one for `ToolChip` (B.7).

2. **No backward compatibility.** A drops every hex literal from non-token files in a single batch. No shims, no `--legacy-*`, no dual-write phase. The F02 tone extensions are added in the same commit. B does the same.

3. **F02 hierarchical decomposition.** F02 r2 §2.1 lists the inherited verbatim patterns; A ships them. F02 r2 §2.2 lists the additive tones; §A.2.4 ships them. F02 r2 §2.3 enumerates patterns NOT to add (the `.tool-chip*`, `.msg*`, `.role-*`, `.kind-*`, `.btn-sm`, `.thinking-dots`, `.pill-active`, `.panel-heading-h1` families); A mirrors that exclusion in §A.2.4 and enforces it with the grep gates in §A.4.2#3 and §A.4.2#4. The contract is closed in both directions.

4. **Contrast table from the analysis.** A's value mapping is the analysis table verbatim. Every WCAG AA pair in §7 of the analysis is preserved (11 of 12 pairs above 4.5:1; the single 3.9:1 `--text-faint` on `--bg` borderline meets the 3:1 large-text minimum). B preserves the same values — recipes are pure indirection — so this criterion does not differentiate the two; it confirms either is acceptable, and the simpler one wins.

5. **Single batch landing.** Both A and B land in one commit with no temporary dual visual system. A's diff is smaller (six files added + N component edits); B's diff is larger (seven files added + same N component edits + a recipe-vs-semantic decision per chat/card/button site). Smaller diff under identical guarantees is preferred.

6. **F03/F04/F05 chip narrative honoured.** A treats `ToolChip` as a conversation composite whose styling is built from `.card` + tone classes + `.pill-*` + `.btn`. There is no global `.tool-chip*` pattern, no `--tool-chip-*` recipe, no second chip implementation. This is what F02 r2 §2.3, F04 r2, and F05 r2 require. B would honour this too, but the absence of a chip recipe in B (per §B.7) means B's only conceptual delta from A is the message-bubble / card / button / code / panel / status-dot recipe layer — which is real indirection without a motivating consumer.

7. **Future optionality.** A does **not** foreclose B. If, three issues from now, F03 or F04 discovers a component-level contract that benefits from a recipe layer, `recipes.css` can be inserted between `semantic.css` and `patterns.css` with one `@import` line and a targeted set of selector rewrites. The cost of adding recipes later is bounded; the cost of stripping them out if they turn out to be over-engineering is higher.

### What this commits us to

- The exact six files in §A.1, written per §A.2.1–§A.2.7.
- **`patterns.css` = v2 verbatim + the closed F02 tone delta in §A.2.4.** Not a `cp`.
- The mechanical hex replacement in §A.3, gated by the four greps in §A.4.2.
- The validation matrix in §A.4.3 through §A.4.7.
- No `.tool-chip*`, `.msg-*`, `.role-*`, `.kind-*`, `.btn-sm`, `.thinking-dots`, `.pill-active`, `.panel-heading-h1` selectors in `patterns.css` at the F01 commit. F02 owns the composites; F01 owns the semantic vars plus the closed tone delta.

### Final artifacts

**Chosen proposal:** A
**This document path:** `/home/salva/g/ml/saivage-v3/SPEC/2026-05/review-ui-port-from-v2/F01-design-tokens/02-design-r2.md`
