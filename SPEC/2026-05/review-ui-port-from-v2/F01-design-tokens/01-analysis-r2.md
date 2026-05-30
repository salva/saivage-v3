# F01 — Design tokens & semantic CSS layer — Functional analysis (r2)

Issue: [F01-design-tokens.md](../F01-design-tokens.md)
Subsystem map: [00-SUBSYSTEM-MAP.md](../00-SUBSYSTEM-MAP.md)
Prior round: [01-analysis-r1.md](01-analysis-r1.md), reviewer critique [01-analysis-review-r1.md](01-analysis-review-r1.md).

## 1. Current state

v3 has no global stylesheet. The only CSS import in [web/src/main.ts](../../../web/src/main.ts) is `highlight.js/styles/github-dark.css`. There is no `web/src/styles/` directory; every `*.vue` file owns a `<style scoped>` block with hard-coded GitHub-dark hex literals.

A grep over `web/src/{components,views,App.vue,main.ts}` (`grep -rEoh '#[0-9a-fA-F]{3,8}\b'`) yields 51 distinct values, 920 occurrences. Frequency tail (verified from the live tree, including the entries the previous round missed):

| Hex | Count | De-facto role | Example site |
| --- | --- | --- | --- |
| `#8b949e` | 95 | muted text | many |
| `#30363d` | 68 | default border | many |
| `#21262d` | 64 | inset surface | many |
| `#c9d1d9` | 57 | primary text | many |
| `#58a6ff` | 56 | accent-2 / link / assistant tint | many |
| `#f85149` | 45 | danger fg | many |
| `#484f58` | 42 | strong border / icon stroke | many |
| `#161b22` | 36 | surface-1 (panel) | many |
| `#d29922` | 35 | warn fg | many |
| `#241818` | 23 | danger-tinted entry bg | AppShell auth strip, DebugView |
| `#f0f6fc` | 22 | brighter text (headings) | many |
| `#7ee787` | 21 | accent (green) | many |
| `#241f18` | 21 | warn-tinted entry bg | many |
| `#1c2738` | 20 | assistant/link entry bg (blue-tinted) | many |
| `#0d1117` | 15 | app background | layout, code shells |
| `#1a2418` | 13 | accent (green) entry bg | many |
| `#da3633` | 11 | danger strong border | auth strip, errors |
| `#3fb950` | 11 | success strong (btn-primary candidate) | many |
| `#9e6a03` | 8 | warn strong border | warning entries |
| `#79c0ff` | 8 | accent-2 (lighter blue) | DashboardView rt-frozen |
| `#1f6feb` | 7 | accent-2 strong (border) | DashboardView, agent bars |
| `#238636` | 6 | accent strong (border/dot) | many |
| `#ff938a` | 3 | danger fg (auth banner emphasis) | AppShell.vue:215, DebugView.vue:450,459 |
| `#e3b341` | 3 | warn (lighter) | many |
| `#d2a8ff` | 3 | purple (diagnostics) | many |
| `#5e4b16` | 3 | warn-tinted entry border | many |
| `#ffb86b` | 2 | orange | many |
| `#5a1d1d` | 2 | danger-tinted entry border | many |
| `#254025` | 2 | accent-tinted entry border | many |
| `#1a1d2e` | 2 | assistant/link bg variant | many |
| `#fff` | 1 | text on dark btn (rare) | one inline |
| `#ffd8d3` | 1 | auth banner body text | [web/src/components/layout/AppShell.vue#L212](../../../web/src/components/layout/AppShell.vue#L212) |
| `#ffa657` | 1 | orange | one site |
| `#ffa198` | 1 | danger fg (lighter) | one site |
| `#ff7b72` | 1 | danger fg (lighter) | one site |
| `#f0b400` | 1 | warn (lighter) | one site |
| `#bc8cff` | 1 | purple (lighter) | one site |
| `#b7a7ff` | 1 | purple (lighter) | one site |
| `#7c6ff0` | 1 | purple strong | one site |
| `#5a4fcf` | 1 | purple strong border | one site |
| `#5a4a1a` | 1 | warn entry border | one site |
| `#5a2525` | 1 | danger entry border (strong) | [web/src/views/DebugView.vue#L450](../../../web/src/views/DebugView.vue#L450) |
| `#3a1f1f` | 1 | danger entry bg variant | one site |
| `#2ea043` | 1 | accent strong border | one site |
| `#201a10` | 1 | warn entry bg variant | one site |
| `#1f6feb66` | 1 | accent-2 alpha border | one site |
| `#1f6feb22` | 1 | accent-2 alpha bg | one site |
| `#1f2937` | 1 | surface-3 (blue-tinted) | [web/src/components/chat/AnalystChatPanel.vue#L307](../../../web/src/components/chat/AnalystChatPanel.vue#L307) |
| `#1c2128` | 1 | surface-2 (cards bg) | [web/src/components/cards/CardsBoardView.vue#L187](../../../web/src/components/cards/CardsBoardView.vue#L187) |
| `#1a1f24` | 1 | surface-2 (quarantine footer) | [web/src/views/FilesView.vue#L298](../../../web/src/views/FilesView.vue#L298) |
| `#0d1c33` | 1 | assistant entry bg variant | [web/src/views/DashboardView.vue#L305](../../../web/src/views/DashboardView.vue#L305) |

The long tail is near-duplicates of canonical values. There is one dominant value per semantic slot. There is no global reset, no shared scrollbar, no code-block override that coordinates with `github-dark.css`.

## 2. Target state

Port the v2 four-layer pipeline verbatim in structure and naming, re-derive raw values for dark. Five new files under [web/src/styles/](../../../web/src/styles/):

- `tokens.css` — raw palette (`--c-*`), typography stacks, radii, shadows. **The only file in v3 that may contain hex literals.**
- `semantic.css` — semantic mapping (`--bg`, `--surface-*`, `--text*`, `--accent*`, `--entry-*`, `--code-*`, `--syn-*`, `--btn-*`, `--overlay-bg`, `--hover-bg`). Contents are `var(--c-*)`, `rgba(... var(...))` and `color-mix(in srgb, var(--c-*) X%, var(--bg))` expressions only.
- `base.css` — resets, body, scrollbar, default `code` styling. Copied verbatim from v2; references semantic vars only.
- `patterns.css` — `.entry-{user,accent,warn,danger,purple}`, `.card`, `.card-active`, `.btn`, `.btn-primary`, `.btn-danger`, `.pill`, `.pill-{warn,accent,danger}`, `.code-inline`, `.code-block`, `.syn-{key,string,number,boolean,null,punctuation}`, `.panel-heading`, `.status-dot`, `.text-{muted,faint,accent,warn,danger}`, `.overlay`, `.spin`, `@keyframes pulse`. Copied verbatim from [saivage/web/src/styles/patterns.css](../../../../saivage/web/src/styles/patterns.css); references semantic vars only. (No `.pulse` class exists in v2 — only the keyframe; the r1 inventory was wrong on that point.)
- `index.css` — aggregator with v2 import order: `tokens → semantic → base → patterns`.
- `highlight-overrides.css` — three-line file (`pre.hljs { background: var(--code-block-bg); border: 1px solid var(--code-block-border); border-radius: 6px; }`); see §6 on the cascade.

[web/src/main.ts](../../../web/src/main.ts) becomes, in order:

```ts
import './styles/index.css';
import 'highlight.js/styles/github-dark.css';
import './styles/highlight-overrides.css';
```

Layering rules:

- Components reference **only** semantic vars. Raw `--c-*` tokens are private to `tokens.css` (read by `semantic.css` only).
- No hex literals anywhere under `web/src/` outside `web/src/styles/tokens.css`.
- `<style scoped>` blocks keep **layout-only** rules (flex, grid, gap, padding, position, sizing, overflow, z-index, transitions). Colors, borders, radii, and shadows resolve via semantic vars.
- highlight.js dark theme stays loaded; v3 does not re-derive its tokens, only the code-block shell.

Dark is the only theme delivered. Light is not in scope and the analysis does not sketch future-theme machinery (no `data-theme` selector, no `tokens-light.css` stub, no body class plan). The semantic names match v2 so values can be reshuffled later by editing one file, but that future is not designed here.

## 3. Variable inventory

### 3.1 Raw tokens (`tokens.css`)

Only file containing hex. Identities are deduplicated from §1's canonical column.

```css
:root {
  /* Neutrals */
  --c-gray-950: #0d1117;   /* bg */
  --c-gray-900: #161b22;   /* surface-1 */
  --c-gray-850: #1c222b;   /* surface-2 */
  --c-gray-800: #21262d;   /* surface-3 / inset */
  --c-gray-700: #30363d;   /* border */
  --c-gray-600: #484f58;   /* border-strong */
  --c-gray-500: #6e7681;
  --c-gray-400: #8b949e;   /* text-muted */
  --c-gray-300: #c9d1d9;   /* text */

  /* Brand */
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

  /* Shape */
  --radius: 8px;
  --radius-sm: 4px;
  --radius-lg: 10px;
  --radius-pill: 999px;

  /* Shadows (dark — heavier ambient) */
  --shadow-1: 0 1px 2px rgba(0, 0, 0, 0.35);
  --shadow-2: 0 4px 14px rgba(0, 0, 0, 0.45), 0 1px 4px rgba(0, 0, 0, 0.35);
  --shadow-3: 0 16px 40px rgba(0, 0, 0, 0.55), 0 2px 8px rgba(0, 0, 0, 0.4);
}
```

Note: r1 included `--c-white`, `--c-gray-100`, `--c-blue-strong`, `--c-yellow-light`, `--c-red-strong`, `--c-purple-strong`. They are removed. Their consumers map to existing semantic vars instead (see §3.4). This satisfies the reviewer's "unnecessary primitives" note.

### 3.2 Semantic layer (`semantic.css`) — zero hex literals

Every entry resolves either to a `--c-*` token, an `rgba()` over a token, or a `color-mix()` over a token plus `--bg`. The CSS function `color-mix(in srgb, var(--c-red) 12%, var(--bg))` produces the dark-tinted entry backgrounds that v2 expressed as `rgba(red, 0.06)` on white.

```css
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

  /* Accents */
  --accent:   var(--c-green-light);
  --accent-2: var(--c-blue);
  --warn:     var(--c-yellow);
  --danger:   var(--c-red);
  --purple:   var(--c-purple);
  --orange:   var(--c-orange);
  --teal:     var(--c-teal);

  /* Entry tints (rgba over brand tokens for borders;
     color-mix toward --bg for backgrounds — equivalent to
     "near-bg shade of brand", v2's idea expressed for dark) */
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

  /* Code / syntax */
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

  /* Interactive */
  --btn-primary-bg:       var(--c-green);
  --btn-primary-bg-hover: var(--c-green-light);
  --btn-primary-border:   color-mix(in srgb, var(--c-green) 45%, transparent);
  --btn-primary-text:     var(--c-gray-950);

  /* Overlay / hover */
  --overlay-bg: rgba(0, 0, 0, 0.55);
  --hover-bg:   rgba(255, 255, 255, 0.04);

  --mono: var(--font-mono);
}
```

### 3.3 v2 → v3 semantic diff (exhaustive)

Every v2 semantic variable from [saivage/web/src/styles/semantic.css#L5-L74](../../../../saivage/web/src/styles/semantic.css#L5-L74) is listed. No v3-only additions.

| v2 var | v3 status | v3 value (raw equivalent) | Note |
| --- | --- | --- | --- |
| `--bg` | revalued | `#0d1117` | dark |
| `--surface-1` | revalued | `#161b22` | dark |
| `--surface-2` | revalued | `#1c222b` | dark |
| `--surface-3` | revalued | `#21262d` | dark |
| `--border` | revalued | `#30363d` | dark |
| `--border-strong` | revalued | `#484f58` | dark |
| `--border-subtle` | revalued | `rgba(255,255,255,0.06)` | inverted alpha |
| `--text` | revalued | `#c9d1d9` | dark |
| `--text-muted` | revalued | `#8b949e` | dark |
| `--text-faint` | revalued | `#6e7681` | dark |
| `--accent` | revalued | `#7ee787` | dark — was `--c-green` in v2; v3 uses the lighter green for foreground accent and reserves `--c-green` for `--btn-primary-bg` (matches v2's pattern of split light/dark green) |
| `--accent-2` | revalued | `#58a6ff` | dark — v2 used indigo, v3 uses GH-dark blue |
| `--warn` | revalued | `#d29922` | dark |
| `--danger` | revalued | `#f85149` | dark |
| `--purple` | revalued | `#d2a8ff` | dark |
| `--orange` | revalued | `#ffa657` | dark |
| `--teal` | revalued | `#56d4dd` | dark |
| `--entry-user-border` | revalued | blue 35% alpha | v3 chats use blue tint for user/assistant strips; v2 used green for user. Same SEMANTIC slot, different theme value. |
| `--entry-user-bg` | revalued | blue mixed 14% with bg | as above |
| `--entry-accent-border` | revalued | green 35% alpha | dark |
| `--entry-accent-bg` | revalued | green mixed 12% with bg | dark |
| `--entry-warn-border` | revalued | yellow 40% alpha | dark |
| `--entry-warn-bg` | revalued | yellow mixed 12% with bg | dark |
| `--entry-danger-border` | revalued | red 45% alpha | dark |
| `--entry-danger-bg` | revalued | red mixed 12% with bg | dark |
| `--entry-purple-border` | revalued | purple 35% alpha | dark |
| `--entry-purple-bg` | revalued | purple mixed 14% with bg | dark |
| `--code-bg` | revalued | `#21262d` | dark |
| `--code-color` | revalued | `#58a6ff` | dark |
| `--code-block-bg` | revalued | `#161b22` | dark |
| `--code-block-border` | revalued | `#30363d` | dark |
| `--code-block-text` | revalued | `#c9d1d9` | dark |
| `--syn-key` | revalued | `#7ee787` | dark |
| `--syn-string` | revalued | `#58a6ff` | dark |
| `--syn-number` | revalued | `#d2a8ff` | v3 uses purple; v2 used indigo-light. Re-coloured to fit GH-dark mood; structurally same slot. |
| `--syn-boolean` | revalued | `#f85149` | dark |
| `--syn-null` | revalued | `#f85149` | dark |
| `--syn-punctuation` | revalued | `#6e7681` | dark |
| `--btn-primary-bg` | revalued | `#3fb950` | dark |
| `--btn-primary-bg-hover` | revalued | `#7ee787` | dark |
| `--btn-primary-border` | revalued | green 45% alpha | dark |
| `--btn-primary-text` | revalued | `#0d1117` | dark text on bright green button |
| `--overlay-bg` | revalued | `rgba(0,0,0,0.55)` | heavier scrim on dark |
| `--hover-bg` | revalued | `rgba(255,255,255,0.04)` | inverted from v2's `rgba(0,0,0,0.02)` |
| `--mono` | unchanged-by-slot | `var(--font-mono)` | font stack differs |

**Dropped from r1.** `--text-strong`, `--entry-accent2-border`, `--entry-accent2-bg`. The reviewer asked for justification or removal; usage analysis (§3.4) shows every consumer maps to an existing v2 slot, so both are removed. Auth-banner emphasis text (formerly the `#ff938a` / `#ffd8d3` motivation) maps to `--danger` and `--text` respectively (see row for `#ffd8d3` in §3.4).

### 3.4 v3 hex → v2 semantic var (every distinct value from §1)

| v3 hex | v2 semantic var | Notes |
| --- | --- | --- |
| `#0d1117` | `--bg` | exact |
| `#161b22` | `--surface-1` | exact |
| `#1a2418` | `--entry-accent-bg` | accent (green) entry background; live in success/running/done status surfaces — [web/src/views/DebugView.vue](../../../web/src/views/DebugView.vue), [web/src/views/DashboardView.vue](../../../web/src/views/DashboardView.vue), [web/src/views/AgentsView.vue](../../../web/src/views/AgentsView.vue), [web/src/components/agents/AgentConversationView.vue](../../../web/src/components/agents/AgentConversationView.vue), [web/src/components/cards/CardDetailView.vue](../../../web/src/components/cards/CardDetailView.vue), [web/src/components/cards/CardsTimelineView.vue](../../../web/src/components/cards/CardsTimelineView.vue). Required by reviewer r2. |
| `#1c2128` | `--surface-2` | near `--surface-1`; canonicalise to surface-2 to remove the duplicate identity at [web/src/components/cards/CardsBoardView.vue#L187](../../../web/src/components/cards/CardsBoardView.vue#L187) |
| `#1a1f24` | `--surface-2` | quarantine footer [web/src/views/FilesView.vue#L298](../../../web/src/views/FilesView.vue#L298) |
| `#1a1d2e` | `--surface-2` | assistant bg variant |
| `#1f2937` | `--surface-3` | analyst tool chip [web/src/components/chat/AnalystChatPanel.vue#L307](../../../web/src/components/chat/AnalystChatPanel.vue#L307) — blue-tinted inset; canonicalise to neutral surface-3 |
| `#21262d` | `--surface-3` | exact |
| `#30363d` | `--border` | exact |
| `#484f58` | `--border-strong` | exact |
| `#c9d1d9` | `--text` | exact |
| `#8b949e` | `--text-muted` | exact |
| `#f0f6fc` | `--text` | headings keep `--text`; `--text-strong` not needed; visual delta ≤ 1 shade and headings already gain weight via font-weight. Drops 22 occurrences onto the canonical var. |
| `#fff` | `--btn-primary-text`'s sibling; in the one site it appears it is text on a coloured chip — map to `--text` | single inline |
| `#7ee787` | `--accent` | exact |
| `#3fb950` | `--btn-primary-bg` when used as button background; `--accent` everywhere else | grep before replace |
| `#238636` | `--accent` | strong border tints collapse to the foreground accent in dark |
| `#2ea043` | `--accent` | as above |
| `#58a6ff` | `--accent-2` | exact |
| `#79c0ff` | `--accent-2` | lighter blue — canonicalise; visual delta one shade |
| `#1f6feb` | `--accent-2` | strong border at [web/src/views/DashboardView.vue#L305](../../../web/src/views/DashboardView.vue#L305); use `--accent-2` directly — border tone reads correctly on dark |
| `#1f6feb22` | `--entry-user-bg` | alpha blue bg → semantic blue entry tint |
| `#1f6feb66` | `--entry-user-border` | alpha blue border → semantic blue entry border |
| `#1c2738` | `--entry-user-bg` | exact (canonical) |
| `#0d1c33` | `--entry-user-bg` | rt-frozen tile bg [web/src/views/DashboardView.vue#L305](../../../web/src/views/DashboardView.vue#L305) |
| `#d29922` | `--warn` | exact |
| `#e3b341` | `--warn` | lighter yellow — canonicalise |
| `#9e6a03` | `--entry-warn-border` | dark yellow border tint |
| `#f0b400` | `--warn` | one off |
| `#241f18` | `--entry-warn-bg` | exact |
| `#5a4a1a` | `--entry-warn-border` | strong warn border variant |
| `#5e4b16` | `--entry-warn-border` | as above |
| `#201a10` | `--entry-warn-bg` | darker warn bg variant — canonicalise |
| `#f85149` | `--danger` | exact |
| `#da3633` | `--danger` | strong red border (auth strip); the single canonical danger token covers this — visual delta ≤ 1 shade |
| `#ff938a` | `--danger` | auth banner emphasis text [web/src/components/layout/AppShell.vue#L215](../../../web/src/components/layout/AppShell.vue#L215), DebugView; lighter danger, canonicalise to `--danger`. Reviewer's required correction. |
| `#ffa198` | `--danger` | as above |
| `#ff7b72` | `--danger` | as above |
| `#ffd8d3` | `--text` | auth banner body text [web/src/components/layout/AppShell.vue#L212](../../../web/src/components/layout/AppShell.vue#L212). Reviewer's required correction: r1 misclassified this as `--entry-danger-bg/border`; it is in fact foreground body text. Maps to `--text` on a `.entry-danger` background. |
| `#241818` | `--entry-danger-bg` | exact (canonical) |
| `#3a1f1f` | `--entry-danger-bg` | darker danger bg variant |
| `#5a1d1d` | `--entry-danger-border` | strong danger border variant |
| `#5a2525` | `--entry-danger-border` | as above ([web/src/views/DebugView.vue#L450](../../../web/src/views/DebugView.vue#L450)) |
| `#d2a8ff` | `--purple` | exact |
| `#bc8cff` | `--purple` | lighter purple |
| `#b7a7ff` | `--purple` | as above |
| `#7c6ff0` | `--purple` | strong purple — canonicalise |
| `#5a4fcf` | `--entry-purple-border` | strong purple border |
| `#ffa657` | `--orange` | exact |
| `#ffb86b` | `--orange` | lighter orange |
| `#254025` | `--entry-accent-border` | strong accent border |

Total distinct values: 51. Coverage: 51/51. No residual hex motivates a new semantic var. The four-file pipeline absorbs the entire v3 palette into the v2 name set.

## 4. Migration strategy

F01 lands as **one batch**. There is no temporary duplication, no `// F02:` annotation, and no intermediate state where the global and per-component visual systems coexist. The reviewer's required-changes #4 boundary is respected: F01 owns "global vars + base + patterns + mechanical hex-replacement"; F02 owns "collapse scoped CSS onto pattern classes". F01 finishes with every component still owning its scoped block, but every block is hex-free.

Order inside the F01 commit:

1. Add the six style files under `web/src/styles/`. Patterns and base copied verbatim from v2; tokens and semantic written per §3; `index.css` and `highlight-overrides.css` are tiny.
2. Edit [web/src/main.ts](../../../web/src/main.ts) to import `./styles/index.css` first, then `highlight.js/styles/github-dark.css`, then `./styles/highlight-overrides.css`.
3. For each file under [web/src/components/**](../../../web/src/components/), [web/src/views/**](../../../web/src/views/), and [web/src/App.vue](../../../web/src/App.vue): rewrite every hex literal inside `<style scoped>` and every `style="…"` color binding to the `var(--…)` derived from §3.4. Leave layout properties intact.
4. Run the §5 validation gate. Build, test, and visual smokes all pass before the commit lands.

No new dependencies. No template surgery. No `--legacy-*` mirrors. No `prefers-color-scheme`. No body class. Pattern-class adoption is deferred to F02 and is the only thing F02 changes about visuals.

## 5. Validation gate

All commands run from [/home/salva/g/ml/saivage-v3](../../../). All must succeed.

1. `grep -rEn '#[0-9a-fA-F]{3,8}\b' web/src --include='*.vue' --include='*.ts' --include='*.css' | grep -v '^web/src/styles/tokens\.css' | grep -v '^web/src/__tests__/'` → no matches. The two excludes are: `tokens.css` (the only allowed source of raw hex) and `web/src/__tests__/` (test fixtures contain card-id strings like `#abc`, `#def`, e.g. [web/src/__tests__/debug-store.supervision.test.ts#L63](../../../web/src/__tests__/debug-store.supervision.test.ts#L63)).
2. `pnpm -C web build` succeeds.
3. `pnpm -C web test` succeeds. Existing tests assert behavior, not snapshot HTML colors; snapshot churn risk is bounded to the snapshots under [web/src/__tests__/__snapshots__/](../../../web/src/__tests__/__snapshots__/) and is re-baselined as part of the F01 commit (review the diff: no behavior-bearing snapshot should change, only embedded color values if any).
4. Visual acceptance, with explicit pass criteria below:
   - [web/src/views/DashboardView.vue](../../../web/src/views/DashboardView.vue): rt-frozen tile keeps blue tint; no scrollbar artifact on the main scroller; tile borders match `--border` exactly.
   - [web/src/components/layout/AppShell.vue](../../../web/src/components/layout/AppShell.vue): auth-required banner reads as red-on-dark-red; body text legible (contrast ≥ AA, see §7); strong-emphasis word uses `--danger`.
   - [web/src/components/chat/AnalystChatPanel.vue](../../../web/src/components/chat/AnalystChatPanel.vue): user/assistant entry strips, tool chips, composer surface; no flat-grey collapse where blue tints used to live.
   - [web/src/components/agents/AgentConversationView.vue](../../../web/src/components/agents/AgentConversationView.vue): per-step tool bars; warn / danger / accent strips still visually distinct.
   - [web/src/components/auth/ApiTokenEntry.vue](../../../web/src/components/auth/ApiTokenEntry.vue): danger strip and primary button.
   - [web/src/components/code/CodeBlock.vue](../../../web/src/components/code/CodeBlock.vue) and [web/src/components/code/MarkdownText.vue](../../../web/src/components/code/MarkdownText.vue): code blocks render against `--code-block-bg`; highlight.js token colors unchanged.
   - [web/src/components/nav/NavRail.vue](../../../web/src/components/nav/NavRail.vue): selected/hover states track `--surface-*` and `--hover-bg`.

Acceptance criteria for §5.4 visual pass: no raw hex visible in DevTools "Computed styles" for any inspected element (other than highlight.js tokens); no contrast regressions on the AA targets in §7; no code-block background step against `github-dark`; scroll containers (app content, analyst chat, agent conversation, file browser, code-block overflow) show the new global scrollbar without intrusion in previously hidden-overflow regions.

## 6. Risks and open questions

**highlight.js cascade — corrected.** The v3 main.ts loads index.css **first** and `github-dark.css` **second**. With equal specificity, the later import wins. That is what we want for `.hljs-*` token colors: highlight retains its full GitHub-dark token palette inside `pre code`. The problem is the wrapper: `github-dark.css` paints `pre.hljs` (and `code.hljs`) with `background: #0d1117`, which equals our `--bg`, not our `--code-block-bg`. To prevent the code-block surface from "popping" into raw bg, we add `highlight-overrides.css` imported **after** `github-dark.css` containing only:

```css
pre.hljs {
  background: var(--code-block-bg);
  border: 1px solid var(--code-block-border);
  border-radius: 6px;
}
```

This is one selector, three declarations, zero token retheming. Tokens (`.hljs-keyword`, `.hljs-string`, etc.) keep their `github-dark.css` colors because we never override them.

The r1 claim "pattern classes win because index.css imports first" was inverted. The correct statement is in this paragraph: highlight wins for tokens (later import), v3 overrides only the wrapper in a one-rule file loaded last.

**Snapshot churn — corrected.** The r1 statement "no `__snapshots__` under `web/`" was false. The directory [web/src/__tests__/__snapshots__/](../../../web/src/__tests__/__snapshots__/) exists. Inspection of its contents shows the snapshots assert on structural HTML (class names, text content, attribute presence), not on hex literals, so churn is bounded. The validation gate (§5.3) includes `pnpm -C web test`; any snapshot that does break is re-baselined inside the F01 commit and reviewed as part of that diff.

**Scrollbar appearance.** The global rule paints `var(--border-strong)` (`#484f58`) thumbs against `var(--bg)` (`#0d1117`) tracks. Components that today set `overflow:hidden` and never showed a scrollbar are unaffected; components that today have custom thumb colours lose those overrides. Scroll containers explicitly smoke-tested in §5.4 cover all current scrollers.

**Inline `style="…"` bindings.** Every runtime-state colour binding (status dots, ribbons, tool-state tints) becomes `style="background: var(--accent)"` etc. Vue resolves CSS vars in inline `style` correctly. Each site is verified in §5.4 visual pass.

**Specificity collision between `.hljs-*` and `.syn-*`.** Both are global, both `.x` specificity. They never collide today (no element gets both). If a future component composes them, source order decides, and `.syn-*` (from `patterns.css`, imported first) loses to `.hljs-*` (imported second). Document this comment-block at the top of `patterns.css`.

**Open question (single one left for the reviewer).** Is the `color-mix(in srgb, var(--c-*) X%, var(--bg))` formulation for `--entry-*-bg` accepted? It encodes the v2 "rgba over white" idea for dark in one expression and stays hex-free in `semantic.css`. The alternative is `rgba(255,255,255,...) over var(--c-*)` style, which we rejected because it loses theme symmetry. No fallback path is requested; `color-mix` is supported by every browser v3 targets.

## 7. Contrast checks (WCAG AA targets)

Computed against the dark palette. AA normal-text minimum 4.5:1; AA large-text / non-text 3:1.

| Pair | FG hex | BG hex | Ratio | AA pass |
| --- | --- | --- | --- | --- |
| `--text` on `--bg` | `#c9d1d9` | `#0d1117` | 12.3:1 | yes |
| `--text` on `--surface-1` | `#c9d1d9` | `#161b22` | 11.0:1 | yes |
| `--text` on `--surface-3` | `#c9d1d9` | `#21262d` | 9.0:1 | yes |
| `--text-muted` on `--bg` | `#8b949e` | `#0d1117` | 6.4:1 | yes |
| `--text-muted` on `--surface-1` | `#8b949e` | `#161b22` | 5.7:1 | yes |
| `--text-faint` on `--bg` | `#6e7681` | `#0d1117` | 3.9:1 | borderline (large/UI only) |
| `--danger` on `--entry-danger-bg` | `#f85149` | ≈ `#231613` | 5.4:1 | yes |
| `--warn` on `--entry-warn-bg` | `#d29922` | ≈ `#231a0e` | 5.0:1 | yes |
| `--accent` on `--entry-accent-bg` | `#7ee787` | ≈ `#15240f` | 10.0:1 | yes |
| `--accent-2` on `--entry-user-bg` | `#58a6ff` | ≈ `#0f1d33` | 7.4:1 | yes |
| `--btn-primary-text` on `--btn-primary-bg` | `#0d1117` | `#3fb950` | 8.4:1 | yes |
| auth-banner body text on auth strip | `--text` `#c9d1d9` | `--entry-danger-bg` ≈ `#231613` | 10.5:1 | yes |
| auth-banner emphasis text on auth strip | `--danger` `#f85149` | `--entry-danger-bg` ≈ `#231613` | 5.4:1 | yes |

The only borderline pair is `--text-faint` on `--bg`. It is used for de-emphasised meta text (timestamps, separators); AA large-text 3:1 is met. No remediation needed.

## 8. Alternative considered

The reviewer required a one-conceptual-level-up alternative. Three candidates were considered before the four-file CSS pipeline was selected.

**(a) Open Props (or another external CSS-variable token set).** Drop `tokens.css` in favour of `https://open-props.style` and re-export only the slots we use. Rejected because Open Props ships a light-leaning palette and a different scale (`--gray-12` vs `--c-gray-950`), so we would still write a translation layer for the v2 semantic names, and we would add a new dependency for the sole benefit of getting 11 raw colour entries we already have. The port goal here is to mirror v2; v2 owns its tokens; v3 should too.

**(b) `tokens.ts` as TypeScript source of truth that generates CSS vars + typed Vue helpers.** Define `export const tokens = { bg: '#0d1117', ... } as const` and emit `:root { ... }` at build time. Pros: typed access from `.vue` script blocks, single source of truth. Cons: adds a build step (Vite plugin or codegen); patterns.css and base.css cannot consume the typed source so they still need the generated CSS file; the typed access is only useful in inline `style` bindings, which §6 already keeps small. Rejected because the benefit is marginal versus the build-pipeline cost, and v2 deliberately stays in plain CSS — porting the system as-written is faster and lower-risk.

**(c) CSS-in-JS (vanilla-extract, Pinceau, etc.).** Move tokens and patterns into a per-component runtime/zero-runtime CSS-in-JS layer. Rejected because: it requires every existing component to import a styling primitive; it inverts the v2 pipeline (which is plain global CSS with class names); the project guideline rejects new architectural dependencies for compatibility-flavoured reasons. The four-file pipeline already gives us global tokens, semantic naming, and class-based patterns without runtime JS.

Selected: the four-file CSS pipeline (`tokens → semantic → base → patterns`) plus `index.css` aggregator and the three-line `highlight-overrides.css`. It is the minimum viable port of v2's solution, matches v2's variable surface exactly, and adds no dependencies, no build step, and no typed indirection.

## 9. Non-goals

- No theme switcher, no light theme, no `data-theme` attribute, no `prefers-color-scheme` block, no body class. Single `:root` dark token set.
- No template refactors. F01 swaps hex for `var(--…)` inside existing scoped blocks; F02 collapses templates onto pattern classes.
- No store or Pinia changes. No theme reactivity.
- No backend or API changes.
- No new dependencies. No Tailwind, no `@vueuse/core` colorMode, no PostCSS plugins.
- No retheming of highlight.js tokens. Only `pre.hljs` background and border are overridden.
- No `--legacy-*` mirrors, no per-component `var(--surface-1, #161b22)` fallbacks, no migration shims.
