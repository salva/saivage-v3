# F01 — Design tokens & semantic CSS layer — Functional analysis (r1)

Issue: [F01-design-tokens.md](../F01-design-tokens.md)
Subsystem map: [00-SUBSYSTEM-MAP.md](../00-SUBSYSTEM-MAP.md)

## 1. Current state

v3 has **no global stylesheet**. The only CSS pulled in [web/src/main.ts](../../../web/src/main.ts) is `highlight.js/styles/github-dark.css`. There is no `web/src/styles/` directory; every `*.vue` file owns a `<style scoped>` block that hard-codes GitHub-dark hex literals.

A grep over `web/src/**` (`grep -rEho '#[0-9a-fA-F]{3,8}\b' --include='*.vue' --include='*.ts' --include='*.css'`) yields roughly 920 hex occurrences. The frequency tail is heavily concentrated:

| Hex | Occurrences | De-facto role |
| --- | --- | --- |
| `#8b949e` | 95 | muted text |
| `#30363d` | 68 | default border |
| `#21262d` | 64 | surface-2 / inset surface |
| `#c9d1d9` | 57 | primary text |
| `#58a6ff` | 56 | link / accent-2 (blue) |
| `#f85149` | 45 | danger fg |
| `#484f58` | 42 | strong border / icon |
| `#161b22` | 36 | surface-1 (panel) |
| `#d29922` | 35 | warn fg |
| `#241818` | 23 | danger background tint |
| `#f0f6fc` | 22 | text-strong / heading |
| `#7ee787` | 21 | success / accent green |
| `#241f18` | 21 | warn background tint |
| `#1c2738` | 20 | accent-2 background tint |
| `#0d1117` | 15 | app background |
| `#1a2418` | 13 | accent (green) background tint |
| `#da3633` | 11 | danger-strong (token-entry border, errors) |
| `#3fb950` | 11 | success-strong |
| `#d2a8ff` | 3 | purple (diagnostics) |

The long tail (`#ff938a`, `#ffd8d3`, `#5a1d1d`, `#3a1f1f`, `#bc8cff`, `#7c6ff0`, `#1f6feb22`, …) is mostly one-off near-duplicates of the values above — proof that the same semantic concept is being re-mixed by hand in each component.

Distribution by directory:

| Directory | Hex count |
| --- | --- |
| [web/src/views/](../../../web/src/views/) | 353 |
| [web/src/components/cards/](../../../web/src/components/cards/) | 175 |
| [web/src/components/agents/](../../../web/src/components/agents/) | 80 |
| [web/src/components/layout/](../../../web/src/components/layout/) | 41 |
| [web/src/components/chat/](../../../web/src/components/chat/) | 35 |
| [web/src/components/auth/](../../../web/src/components/auth/) | 25 |
| [web/src/components/nav/](../../../web/src/components/nav/) | 11 |
| [web/src/components/code/](../../../web/src/components/code/) | 5 |

Concrete examples confirming the categories above:

- [web/src/components/layout/AppShell.vue](../../../web/src/components/layout/AppShell.vue) — `background:#0d1117` (app bg), `background:#161b22` (header strip), `border-bottom:1px solid #da3633`, `background:#241818` (token-required strip).
- [web/src/components/chat/AnalystChatPanel.vue](../../../web/src/components/chat/AnalystChatPanel.vue) — full GitHub-dark inline palette for bubbles, composer, tool chips, badges.
- [web/src/components/agents/AgentConversationView.vue](../../../web/src/components/agents/AgentConversationView.vue) — per-step tool bars use `#161b22`, `#30363d`, `#8b949e`, `#7ee787`, `#f85149`, plus state-tint backgrounds `#1a2418` / `#241f18` / `#241818`.

Findings:

- The current palette is internally consistent enough to map cleanly onto v2's semantic taxonomy — there is one dominant value per semantic slot.
- Variance comes from accidental near-duplicates (`#21262d` vs `#1f262e`, `#241818` vs `#5a1d1d`, `#1f6feb` vs `#58a6ff`), not from genuine new semantics.
- There is no global reset and no scrollbar/code styling outside per-component overrides; `body` inherits browser defaults.
- highlight.js dark theme is loaded but nothing else coordinates with it.

## 2. Target state

We port v2's four-layer pipeline verbatim in structure and naming, but re-derive the raw palette for a dark UI. New files under v3:

- [web/src/styles/tokens.css](../../../web/src/styles/tokens.css) — raw palette (`--c-*`), typography stacks, radii, shadows. **Dark values.**
- [web/src/styles/semantic.css](../../../web/src/styles/semantic.css) — semantic mapping (`--bg`, `--surface-*`, `--text*`, `--accent*`, `--entry-*`, `--code-*`, `--syn-*`, `--btn-*`, `--overlay-bg`, `--hover-bg`). **Same names as v2.**
- [web/src/styles/base.css](../../../web/src/styles/base.css) — resets, body, scrollbar, default `code` styling.
- [web/src/styles/patterns.css](../../../web/src/styles/patterns.css) — `.entry-*`, `.card`, `.btn`, `.pill`, `.code-*`, `.syn-*`, `.panel-heading`, `.status-dot`, text utils, `.overlay`, `.spin`, `.pulse`. **Verbatim copy** from [saivage/web/src/styles/patterns.css](../../../../saivage/web/src/styles/patterns.css) — every rule references semantic variables, never raw hex, so it is theme-portable as-is.
- [web/src/styles/index.css](../../../web/src/styles/index.css) — aggregator with the v2 import order: tokens → semantic → base → patterns.
- [web/src/main.ts](../../../web/src/main.ts) gets one new line: `import './styles/index.css'` (placed **before** `highlight.js/styles/github-dark.css` so component-level overrides win where required, see §5).

### Light vs dark — recommendation

**Ship dark only.** Justification:

- v3 has been dark-only since inception; every component, the planner UI, debug surfaces, and operator-facing flows are wired against a dark backdrop. Producing a light variant inside F01 means re-deriving every `--entry-*` tint, validating contrast on planner timelines and tool chips, and integrating a theme switcher — that is a separate, much larger workstream.
- The project guideline explicitly forbids minimal-change defaults and migration shims. Half-finishing a light theme so a future switcher can be bolted on is exactly that anti-pattern.
- v2's light tokens are not the source of truth we want to preserve; v2's **semantic variable names** are. By matching names but providing dark values we keep patterns portable: a future light theme is a single new tokens file plus a body class, never a refactor of components.

`tokens.css` therefore defines a single `:root` block of dark values. If we ever want light, we add a `tokens-light.css` that redefines only `--c-*` raw tokens under a `:root[data-theme="light"]` selector; semantic, base, and patterns layers stay untouched. That path is explicitly **not** delivered here.

### Layering rules (enforced by review, not by tooling)

- Components reference **only** semantic variables. Raw `--c-*` tokens are private to `tokens.css` and `semantic.css`.
- No hex literals in `web/src/**` outside `web/src/styles/`.
- `<style scoped>` blocks keep layout/positioning only; visuals come via `class="…"` on the element using pattern classes, or via semantic vars.
- highlight.js theme stays in `main.ts`; we do **not** re-derive its tokens here.

## 3. Variable inventory

Raw tokens (`--c-*`) — dark palette aligned to v3's existing GitHub-dark hues, deduplicated against the grep table in §1. These are the **only** new identities; everything else maps via semantic vars.

```css
:root {
  /* Neutral surfaces (dark) */
  --c-gray-950: #0d1117;   /* bg */
  --c-gray-900: #161b22;   /* surface-1 */
  --c-gray-850: #1c222b;   /* surface-2 */
  --c-gray-800: #21262d;   /* surface-3 / inset */
  --c-gray-700: #30363d;   /* border */
  --c-gray-600: #484f58;   /* border-strong */
  --c-gray-500: #6e7681;
  --c-gray-400: #8b949e;   /* text-muted */
  --c-gray-300: #c9d1d9;   /* text */
  --c-gray-100: #f0f6fc;   /* text-strong */
  --c-white:    #ffffff;

  /* Brand / accent palette (dark-tuned) */
  --c-green:        #3fb950;   /* success strong */
  --c-green-light:  #7ee787;   /* success / accent */
  --c-blue:         #58a6ff;   /* accent-2 / link */
  --c-blue-strong:  #1f6feb;   /* accent-2 strong */
  --c-yellow:       #d29922;   /* warn */
  --c-yellow-light: #e3b341;
  --c-red:          #f85149;   /* danger */
  --c-red-strong:   #da3633;   /* danger strong (entry borders, errors) */
  --c-purple:       #d2a8ff;   /* purple (diagnostics) */
  --c-purple-strong:#bc8cff;
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

Semantic layer — **names match [saivage/web/src/styles/semantic.css](../../../../saivage/web/src/styles/semantic.css) one-for-one**, only values change. Anything v3 needs that v2 did not name is added at the end (`--accent-2-*`, `--text-strong`).

```css
:root {
  /* Surfaces */
  --bg:         var(--c-gray-950);
  --surface-1:  var(--c-gray-900);
  --surface-2:  var(--c-gray-850);
  --surface-3:  var(--c-gray-800);

  /* Borders */
  --border:        var(--c-gray-700);
  --border-strong: var(--c-gray-600);
  --border-subtle: rgba(255, 255, 255, 0.06);

  /* Text */
  --text:        var(--c-gray-300);
  --text-muted:  var(--c-gray-400);
  --text-faint:  var(--c-gray-500);
  --text-strong: var(--c-gray-100);   /* v3 addition, used by headings */

  /* Accents (semantic) */
  --accent:    var(--c-green-light);
  --accent-2:  var(--c-blue);
  --warn:      var(--c-yellow);
  --danger:    var(--c-red);
  --purple:    var(--c-purple);
  --orange:    var(--c-orange);
  --teal:      var(--c-teal);

  /* Entry / message state colors */
  --entry-user-border:   rgba(88, 166, 255, 0.35);
  --entry-user-bg:       #1c2738;
  --entry-accent-border: rgba(126, 231, 135, 0.35);
  --entry-accent-bg:     #1a2418;
  --entry-warn-border:   rgba(210, 153, 34, 0.40);
  --entry-warn-bg:       #241f18;
  --entry-danger-border: rgba(248, 81, 73, 0.45);
  --entry-danger-bg:     #241818;
  --entry-purple-border: rgba(210, 168, 255, 0.35);
  --entry-purple-bg:     #201a2e;

  /* Accent-2 entry tint — v3 addition (auth / link strips) */
  --entry-accent2-border: rgba(218, 54, 51, 0.55);  /* token-required strip */
  --entry-accent2-bg:     #241818;

  /* Code / syntax theme */
  --code-bg:          var(--c-gray-800);
  --code-color:       var(--c-blue);
  --code-block-bg:    var(--c-gray-900);
  --code-block-border: var(--c-gray-700);
  --code-block-text:  var(--c-gray-300);

  /* JSON / syntax highlighting */
  --syn-key:         var(--c-green-light);
  --syn-string:      var(--c-blue);
  --syn-number:      var(--c-purple);
  --syn-boolean:     var(--c-red);
  --syn-null:        var(--c-red);
  --syn-punctuation: var(--c-gray-500);

  /* Interactive / button */
  --btn-primary-bg:       var(--c-green);
  --btn-primary-bg-hover: var(--c-green-light);
  --btn-primary-border:   rgba(63, 185, 80, 0.45);
  --btn-primary-text:     var(--c-gray-950);

  /* Overlay / modal */
  --overlay-bg: rgba(0, 0, 0, 0.55);

  /* Hover / subtle interaction */
  --hover-bg: rgba(255, 255, 255, 0.04);

  /* Shorthand */
  --mono: var(--font-mono);
}
```

Mapping cheat sheet (current hex → semantic var) — drives the §4 migration:

| Current hex | Semantic var |
| --- | --- |
| `#0d1117` | `--bg` |
| `#161b22` | `--surface-1` |
| `#1c222b`, `#1a1d2e` | `--surface-2` |
| `#21262d` | `--surface-3` |
| `#30363d` | `--border` |
| `#484f58` | `--border-strong` |
| `#c9d1d9` | `--text` |
| `#8b949e` | `--text-muted` |
| `#6e7681` | `--text-faint` |
| `#f0f6fc`, `#fff` | `--text-strong` |
| `#7ee787`, `#3fb950`, `#2ea043`, `#238636` | `--accent` (use `--c-green` only for `--btn-primary-bg`) |
| `#58a6ff`, `#1f6feb`, `#79c0ff` | `--accent-2` |
| `#d29922`, `#e3b341`, `#9e6a03`, `#f0b400` | `--warn` |
| `#f85149`, `#ff938a`, `#ffa198`, `#ff7b72`, `#da3633` | `--danger` (with `--danger` strong vs `--c-red-strong` for the auth strip border) |
| `#d2a8ff`, `#bc8cff`, `#b7a7ff`, `#7c6ff0`, `#5a4fcf` | `--purple` |
| `#ffa657`, `#ffb86b` | `--orange` |
| `#241818`, `#3a1f1f`, `#5a1d1d`, `#5a2525`, `#ffd8d3` | `--entry-danger-bg` / `--entry-danger-border` |
| `#241f18`, `#5a4a1a`, `#5e4b16`, `#201a10` | `--entry-warn-bg` / `--entry-warn-border` |
| `#1a2418`, `#254025` | `--entry-accent-bg` / `--entry-accent-border` |
| `#1c2738`, `#1f6feb22`, `#1f6feb66` | `--entry-user-bg` / `--entry-user-border` |

The orange / teal entries in v2's `semantic.css` are preserved by name even though current v3 hex traffic for them is sparse; keeping the slot reserved avoids re-introducing the same gap later.

## 4. Migration strategy

In-scope deletions (F01 itself, before any component refactor in F02):

- Every hex literal under [web/src/components/**](../../../web/src/components/) and [web/src/views/**](../../../web/src/views/) is removed and replaced with a `var(--…)` reference using the §3 mapping. The grep `grep -rEn '#[0-9a-fA-F]{3,8}\b' web/src/components web/src/views` must return zero after F01 lands, except for explicit highlight.js overrides that F01 keeps verbatim (none expected — highlight.js owns its own classes).
- Per-component re-implementations of patterns (custom `.pill`, custom `.card`-shaped wrappers, custom `.btn`) are deleted. F01 lands the global patterns; F02 collapses templates onto them. F01 itself keeps the temporary duplication only where removing it would require template surgery — every such site is annotated in the diff with a `// F02:` comment for the follow-up issue, with no new code paths added.
- Inline `style="background:#…"` attributes are removed; if a value is state-derived (e.g. status dot tint) the surface keeps the inline style but the value becomes `var(--accent)` / `var(--danger)` / …
- Per-component scrollbar overrides are deleted in favor of the global `::-webkit-scrollbar` rule from `base.css`.

Consolidated (added in `web/src/styles/` only):

- Tokens, semantic, base, patterns, index — five new files, no other location.
- One-line `import './styles/index.css'` in [web/src/main.ts](../../../web/src/main.ts), placed before the highlight.js theme import.

Kept verbatim from v2:

- `patterns.css` content — copied as-is from [saivage/web/src/styles/patterns.css](../../../../saivage/web/src/styles/patterns.css). It references only semantic vars, so the dark mapping in §3 makes it work without edits.
- `base.css` content — same justification; the scrollbar rule references `--border-strong` and `--bg`, both defined for dark.
- `index.css` — identical import order.
- All semantic variable **names** in `semantic.css` (no silent renames). `--text-strong`, `--entry-accent2-*` are the only **additions**; nothing v2 ships is removed.

Explicitly **not** added:

- No `--legacy-*` mirrors, no `.dark` / `.light` body class, no `prefers-color-scheme` block, no per-component fallback like `var(--surface-1, #161b22)`. The project guideline forbids backward-compat shims; dark is the only theme delivered.
- No CSS-in-JS, no Tailwind utility layer, no PostCSS plugin beyond what Vite already does. The four-file pipeline is the entire delivery.

Validation gate (must all pass before F01 closes):

1. `grep -rEn '#[0-9a-fA-F]{3,8}\b' web/src/components web/src/views` → no matches.
2. `grep -rEn '#[0-9a-fA-F]{3,8}\b' web/src/styles` → only matches inside `tokens.css`.
3. `pnpm -C web build` succeeds.
4. Visual smoke on [web/src/views/DashboardView.vue](../../../web/src/views/DashboardView.vue), [web/src/components/layout/AppShell.vue](../../../web/src/components/layout/AppShell.vue), [web/src/components/chat/AnalystChatPanel.vue](../../../web/src/components/chat/AnalystChatPanel.vue), [web/src/components/agents/AgentConversationView.vue](../../../web/src/components/agents/AgentConversationView.vue), [web/src/components/auth/ApiTokenEntry.vue](../../../web/src/components/auth/ApiTokenEntry.vue): backgrounds, borders, accents, danger strip, code blocks, scrollbar visually match (or improve) the pre-F01 state.

## 5. Risks and open questions

- **highlight.js dark theme.** The bundled `github-dark.css` paints code spans with its own hex palette. F01 keeps it loaded after our pipeline so highlight wins inside `pre code`. Risk: highlight's background (`#0d1117`) and our `--code-block-bg` (`--c-gray-900` = `#161b22`) disagree, producing a visible step. Decision: override only the `.hljs` background in `base.css` to `var(--code-block-bg)`; do not retheme tokens. Open question for the reviewer: is one-line override acceptable, or should we vendor a tokens-driven theme? Recommendation: one-line override, defer full retheme.
- **Scrollbar appearance.** v2's `base.css` paints the thumb with `var(--border-strong)` on a `var(--bg)`-bordered track. On dark that is `#484f58` on `#0d1117` — high contrast, intentional. Risk: components that today hide scrollbars (`overflow:hidden` panels) suddenly show them in places where they previously did not. Mitigation: audit during F02 surface refactors; F01 itself ships only the global rule.
- **Transition flicker during the conversion.** Until every component is migrated, removing the global stylesheet's hex literals from one file at a time can produce flashes of un-themed surfaces during dev hot-reload. Mitigation: F01 lands the four CSS files and the `main.ts` import **first** in one commit, then the hex-to-var rewrites land in subsequent commits per directory. Each intermediate commit is buildable and visually consistent.
- **Test snapshot churn.** Any test that asserts on inline `style` attributes or DOM hex strings will break. There are no current v3 snapshot tests of that shape (no `__snapshots__` under `web/`), but the planner has light end-to-end Playwright coverage. Mitigation: re-baseline screenshots once F01 lands; do not edit Playwright assertions to look for old hex.
- **CSS specificity collision with highlight.js.** highlight.js classes (`.hljs-*`) are global. Pattern classes (`.syn-*`) are also global. They do not name-collide today but a future component may apply both. Risk is low; pattern classes win by source order because `index.css` is imported before `github-dark.css`. Document this in a comment at the top of `patterns.css`.
- **CSS variable resolution in inline `style="…"`.** All current inline styles that bind to runtime state (status dot color, ribbon tint) need to switch from `style="background:#7ee787"` to `style="background: var(--accent)"`. Vue binds those correctly, but reviewers must confirm during component edits that the binding still reads from the right state.
- **Open question on `--accent-2-*` family.** v2's `semantic.css` does not define `--entry-accent2-*`; v3 needs one for the auth-token-required strip (currently `#241818` with a `#da3633` border, which is structurally an entry tint, not the danger pattern). Recommendation in §3: add `--entry-accent2-*` as a v3 extension with the values shown. Reviewer should confirm this naming, or propose folding it into `--entry-danger-*` with a stronger border variant.

## 6. Non-goals

- **No theme switcher.** No light theme delivered, no `data-theme` attribute, no `prefers-color-scheme` block, no toggle UI. Only a single `:root` token set.
- **No template refactors.** F01 does not rewrite component markup to use pattern classes. It only swaps hex for `var(--…)` references inside existing `<style scoped>` blocks and lands the four global CSS files. Replacing per-component scoped CSS with pattern classes is **F02**'s job.
- **No store / Pinia changes.** No reactivity, no theme store, no persisted preference. Stores are not touched by F01.
- **No backend or API changes.** The four CSS files and one `main.ts` line are the entire surface area.
- **No new dependencies.** No Tailwind, no `@vueuse/core` colorMode, no PostCSS plugins. Vite's default CSS pipeline is sufficient.
- **No retheming of highlight.js tokens.** Only the `.hljs` background is overridden so the code block surface matches `--code-block-bg`; token colors remain whatever `github-dark.css` ships.
- **No accessibility audit beyond contrast spot-checks.** A full WCAG sweep is a separate workstream; F01 only commits to keeping the visible contrast no worse than today's hard-coded palette.
- **No removal of [highlight.js/styles/github-dark.css](../../../web/src/main.ts) import.** That import remains; only its load order relative to the new `styles/index.css` is fixed.
