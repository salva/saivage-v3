# F01 — Design tokens & semantic CSS layer — Implementation plan (r1)

Issue: [F01-design-tokens.md](../F01-design-tokens.md)
Approved analysis: [01-analysis-r2.md](01-analysis-r2.md) ([ANALYSIS-APPROVED.md](ANALYSIS-APPROVED.md))
Approved design: [02-design-r2.md](02-design-r2.md) ([DESIGN-APPROVED.md](DESIGN-APPROVED.md))
Cross-issue approved designs: [F02 r3](../F02-component-hierarchy/02-design-r3.md), [F03 r3](../F03-conversation-rounds/02-design-r3.md), [F04 r2](../F04-chat-surface-style/02-design-r2.md), [F05 r3](../F05-tool-detail-rendering/02-design-r3.md).
v2 sources: [saivage/web/src/styles/](../../../../../saivage/web/src/styles/).
v3 target root: [/home/salva/g/ml/saivage-v3](../../../../).

Project rule (binding): **architecture-first, no backward compatibility.** No `--legacy-*` mirrors, no `var(--…, #fallback)` shims, no `@deprecated` re-exports, no transitional dual visual system, no `// TODO F02:` annotations. F01 lands in one batch.

This plan is executable end-to-end by another engineer or sub-agent. It follows Proposal A of the approved design (chosen at [02-design-r2.md](02-design-r2.md) §Recommendation).

---

## 1. Preconditions

Before starting:

- Current branch is the F01 implementation branch, clean (`git status` returns no modified files outside the in-progress F01 work). All four other batches (F02/F03/F04/F05) are **unstarted**: F01 is **first in the sequence** because every later batch consumes the semantic vars and the tone extensions added here.
- Repository state at [/home/salva/g/ml/saivage-v3](../../../../) currently has:
  - No `web/src/styles/` directory.
  - [web/src/main.ts](../../../../web/src/main.ts) importing only `highlight.js/styles/github-dark.css`.
  - Every `*.vue` file owning a `<style scoped>` block with hard-coded GitHub-dark hex literals.
  - Verify: `test -d web/src/styles || echo "absent (expected)"`, `grep -rEoh '#[0-9a-fA-F]{3,8}\b' web/src --include='*.vue' --include='*.ts' | sort -u | wc -l` ≈ 51.
- pnpm workspace is bootstrapped (`pnpm -C web typecheck` and `pnpm -C web test` succeed on `main`).
- v2 reference files exist at [saivage/web/src/styles/base.css](../../../../../saivage/web/src/styles/base.css) and [saivage/web/src/styles/patterns.css](../../../../../saivage/web/src/styles/patterns.css) — they are read by this plan but never modified.
- No work-in-progress F02/F03/F04/F05 edits live on the F01 branch. F01 must not touch:
  - Templates, `data-testid` attributes, or class names in any `.vue` file (F02).
  - The conversation `ToolChip` composite (F02 owns it; F03/F04/F05 consume it).
  - `MessageBubble`, `ThinkingDots`, `PanelHeading`, `Card`, `Pill`, `Button`, `StatusDot` composites (F02 owns them).

If any precondition fails, stop and reconcile before continuing.

---

## 2. Files added

All paths absolute under [/home/salva/g/ml/saivage-v3](../../../../).

### 2.1 `web/src/styles/` — new directory (six files)

- [web/src/styles/tokens.css](../../../../web/src/styles/tokens.css) — raw `--c-*` palette, typography stacks, radii, shadows. **The only file in v3 allowed to contain hex literals.** Content is verbatim §A.2.1 of the design.
- [web/src/styles/semantic.css](../../../../web/src/styles/semantic.css) — semantic mapping (`--bg`, `--surface-*`, `--text*`, `--accent*`, `--entry-*`, `--code-*`, `--syn-*`, `--btn-primary-*`, `--overlay-bg`, `--hover-bg`, `--border-subtle`). Content is verbatim §A.2.2 of the design. Zero hex.
- [web/src/styles/base.css](../../../../web/src/styles/base.css) — verbatim copy of [saivage/web/src/styles/base.css](../../../../../saivage/web/src/styles/base.css). References semantic vars only. No edits.
- [web/src/styles/patterns.css](../../../../web/src/styles/patterns.css) — v2 [patterns.css](../../../../../saivage/web/src/styles/patterns.css) verbatim (Block 1) **plus** the F02-required tone extensions (Block 2) at §A.2.4 of the design. References semantic vars only.
- [web/src/styles/index.css](../../../../web/src/styles/index.css) — aggregator. Exact content (four lines plus the leading comment block) per §A.2.5 of the design:
  ```css
  @import "./tokens.css";
  @import "./semantic.css";
  @import "./base.css";
  @import "./patterns.css";
  ```
- [web/src/styles/highlight-overrides.css](../../../../web/src/styles/highlight-overrides.css) — three declarations on the `pre.hljs` selector per §A.2.6 of the design.

No other files are added by F01.

---

## 3. Files modified

### 3.1 [web/src/main.ts](../../../../web/src/main.ts)

Replace the existing single highlight.js import with the three-line block from §A.2.7 of the design. Final shape of the **first three lines** of the file:

```ts
import './styles/index.css';
import 'highlight.js/styles/github-dark.css';
import './styles/highlight-overrides.css';
```

Everything below the import block (the existing Vue/Pinia/router setup) is unchanged.

### 3.2 Every `.vue` file under [web/src/](../../../../web/src/) that currently embeds hex

Scope: [web/src/App.vue](../../../../web/src/App.vue), and every file under [web/src/components/](../../../../web/src/components/) and [web/src/views/](../../../../web/src/views/). Test files under `web/src/__tests__/` are explicitly excluded; the card-id string fixtures (`#abc`, …) are not CSS.

Exact change shape — **mechanical hex → CSS var replacement only**:

- Inside `<style scoped>` blocks: replace every hex literal with the `var(--…)` listed in §3.4 of [01-analysis-r2.md](01-analysis-r2.md).
- Inside `style="…"` static attributes: same substitution.
- Inside `:style="{ … }"` object bindings: same substitution (the value side of each property is a string; replace the hex in that string).
- Inside `:style="\`…\`"` or computed-style expressions (any pattern that emits a hex-bearing string at runtime): same substitution.

Forbidden in F01:

- No template/markup changes (no `data-testid` additions, no class swaps, no element changes).
- No `<script setup>` changes other than rewriting an inline hex string used in a `style`-related computed/expression.
- No removal of existing classes or scoped layout rules. F01 keeps `<style scoped>` blocks intact aside from value rewrites.
- No "while I'm here" refactors. If an ambiguous mapping arises (`#3fb950` button-bg vs accent-fg; `#fff` text-on-coloured-chip), resolve **strictly** per §3.4 of the analysis — grep the call site, decide, do not invent a new var.

---

## 4. Files deleted

None.

The existing `<style scoped>` blocks remain in place (F02 collapses them onto pattern classes in a later commit). No legacy color file is removed because none exists. No fallback path or shim file is introduced or torn down.

---

## 5. Step-by-step numbered command/edit list

All commands run from [/home/salva/g/ml/saivage-v3](../../../../). All edits go through the VS Code editing tools per the workspace's Vue-SFC-corruption note in user memory.

### Step 1 — Create `web/src/styles/tokens.css`

- Action: create file with content from §A.2.1 of [02-design-r2.md](02-design-r2.md) (the full skeleton, copied verbatim).
- File(s): [web/src/styles/tokens.css](../../../../web/src/styles/tokens.css).
- Verification:
  ```bash
  test -f web/src/styles/tokens.css
  grep -c '^  --c-' web/src/styles/tokens.css   # 17 raw palette entries expected (9 grey + 8 brand)
  grep -c '^  --radius' web/src/styles/tokens.css  # 4 radius entries
  grep -c '^  --shadow-' web/src/styles/tokens.css  # 3 shadow entries
  ```

### Step 2 — Create `web/src/styles/semantic.css`

- Action: create file with content from §A.2.2 of the design.
- File(s): [web/src/styles/semantic.css](../../../../web/src/styles/semantic.css).
- Verification:
  ```bash
  test -f web/src/styles/semantic.css
  # zero hex literals in this file
  grep -En '#[0-9a-fA-F]{3,8}\b' web/src/styles/semantic.css   # must be empty
  # the ten entry-* tints must all use color-mix
  grep -c 'color-mix' web/src/styles/semantic.css   # >= 11 (10 entry-* + 1 btn-primary-border)
  # required semantic vars are present
  for v in '--bg' '--surface-1' '--surface-2' '--surface-3' '--border' '--border-strong' '--border-subtle' \
           '--text' '--text-muted' '--text-faint' '--accent' '--accent-2' '--warn' '--danger' '--purple' \
           '--orange' '--teal' '--entry-user-bg' '--entry-user-border' '--entry-accent-bg' \
           '--entry-accent-border' '--entry-warn-bg' '--entry-warn-border' '--entry-danger-bg' \
           '--entry-danger-border' '--entry-purple-bg' '--entry-purple-border' '--code-bg' '--code-color' \
           '--code-block-bg' '--code-block-border' '--code-block-text' '--syn-key' '--syn-string' \
           '--syn-number' '--syn-boolean' '--syn-null' '--syn-punctuation' '--btn-primary-bg' \
           '--btn-primary-bg-hover' '--btn-primary-border' '--btn-primary-text' '--overlay-bg' \
           '--hover-bg' '--mono'; do
    grep -q "^  ${v}:" web/src/styles/semantic.css || echo "MISSING ${v}"
  done
  # the above loop must print nothing.
  ```

### Step 3 — Create `web/src/styles/base.css`

- Action: copy verbatim from v2.
- File(s): [web/src/styles/base.css](../../../../web/src/styles/base.css).
- Command:
  ```bash
  cp /home/salva/g/ml/saivage/web/src/styles/base.css web/src/styles/base.css
  ```
- Verification:
  ```bash
  diff -q web/src/styles/base.css /home/salva/g/ml/saivage/web/src/styles/base.css   # must report 'identical'
  grep -En '#[0-9a-fA-F]{3,8}\b' web/src/styles/base.css   # must be empty
  ```

### Step 4 — Create `web/src/styles/patterns.css`

- Action: write `patterns.css` as **v2 contents (Block 1) followed by the F02 extension delta (Block 2)** per §A.2.4 of the design.
  1. `cp /home/salva/g/ml/saivage/web/src/styles/patterns.css web/src/styles/patterns.css`.
  2. Append the §A.2.4 extension block (verbatim from the design — comment header `/* ─── F02 tone extensions (added by F01) … */` followed by the 11 rules) to the end of the file, using `create_file`/editor tools (do not `cat >>` through terminal on a Vue/CSS-adjacent VS Code session — but `.css` files are safe; either is acceptable). The VS Code edit tools are preferred.
- File(s): [web/src/styles/patterns.css](../../../../web/src/styles/patterns.css).
- Verification:
  ```bash
  test -f web/src/styles/patterns.css
  # Positive gate — extensions present (11 rules):
  grep -En '^\.(status-dot-(ok|warn|danger|accent|muted)|card-(warn|danger|accent|user|purple)|pill-purple)\b' \
    web/src/styles/patterns.css | wc -l
  # must print 11
  # Negative gate — no global chip pattern leaked in:
  grep -En '\.tool-chip|tool-chip-' web/src/styles/patterns.css   # must be empty
  # Negative gate — no F02-forbidden patterns leaked in:
  grep -En '\.(msg-(meta|content|badges)|role-(user|assistant|system)|kind-(reasoning|activity|plain)|btn-sm|thinking-dots|pill-active|panel-heading-h1)\b' \
    web/src/styles/patterns.css   # must be empty
  # No hex in patterns.css:
  grep -En '#[0-9a-fA-F]{3,8}\b' web/src/styles/patterns.css   # must be empty
  ```

### Step 5 — Create `web/src/styles/index.css`

- Action: create the aggregator file with the four `@import` lines from §A.2.5.
- File(s): [web/src/styles/index.css](../../../../web/src/styles/index.css).
- Verification:
  ```bash
  cat web/src/styles/index.css
  # must show exactly four @import lines in order: tokens, semantic, base, patterns
  grep -c '^@import "\./' web/src/styles/index.css   # must print 4
  ```

### Step 6 — Create `web/src/styles/highlight-overrides.css`

- Action: create the three-declaration override file from §A.2.6.
- File(s): [web/src/styles/highlight-overrides.css](../../../../web/src/styles/highlight-overrides.css).
- Verification:
  ```bash
  cat web/src/styles/highlight-overrides.css
  grep -c '^pre\.hljs' web/src/styles/highlight-overrides.css   # must print 1
  grep -En '#[0-9a-fA-F]{3,8}\b' web/src/styles/highlight-overrides.css   # must be empty
  ```

### Step 7 — Rewrite `web/src/main.ts` import block

- Action: replace the existing single `import 'highlight.js/styles/github-dark.css';` (or whatever the current head of file is) with the three-line block from §3.1 of this plan. Leave the rest of the file unchanged.
- File(s): [web/src/main.ts](../../../../web/src/main.ts).
- Verification:
  ```bash
  head -3 web/src/main.ts
  # must print, exactly:
  # import './styles/index.css';
  # import 'highlight.js/styles/github-dark.css';
  # import './styles/highlight-overrides.css';
  grep -c "^import './styles/index.css';" web/src/main.ts   # 1
  grep -c "^import 'highlight.js/styles/github-dark.css';" web/src/main.ts   # 1
  grep -c "^import './styles/highlight-overrides.css';" web/src/main.ts   # 1
  ```

### Step 8 — Enumerate all hex sites once

- Action: build a workspace-wide list of hex occurrences across `.vue` and `.ts` files inside `web/src/`, excluding `web/src/styles/tokens.css` and `web/src/__tests__/`. This is the worklist for steps 9–11.
- Verification command (also serves as the running progress indicator):
  ```bash
  grep -rEn '#[0-9a-fA-F]{3,8}\b' web/src --include='*.vue' --include='*.ts' \
    | grep -v '^web/src/styles/tokens\.css' \
    | grep -v '^web/src/__tests__/' \
    | sort -u
  ```
  Save the list (do **not** commit it). Each line is a `(file:line:hex)` triple to address in steps 9–11.

### Step 9 — Apply the §3.4 mapping table

- Action: for each distinct hex value in §3.4 of [01-analysis-r2.md](01-analysis-r2.md), replace every site in the worklist from Step 8 with the mapped `var(--…)`.
- Tooling: prefer `multi_replace_string_in_file` per file (one transaction per file) over chained single replacements. Save buffers after editing each file (`workbench.action.files.saveAll`) before moving on, per the user-memory note on Vue SFC edits.
- File(s): every site emitted by Step 8.
- Rules:
  - Replace inside `<style scoped>` blocks, inline `style="…"` attributes, and `:style="{ … }"` object bindings (raw strings).
  - **Do not** touch markup, classes, attributes, or computed logic that doesn't carry a hex.
  - **Do not** add `var(--…, #fallback)` fallbacks.
  - For the two ambiguous values, grep-and-decide per call site:
    - `#3fb950`: if the site is `background:` (or equivalent) on a primary button surface, map to `var(--btn-primary-bg)`; otherwise `var(--accent)`. The analysis lists 11 occurrences; expect ~1–2 button surfaces and the rest accent.
    - `#fff`: the single inline occurrence is text on a coloured chip; map to `var(--text)`.
- Per-hex verification after each pass (run after every distinct hex has been processed):
  ```bash
  # the hex must no longer appear outside tokens.css / tests
  grep -rEn '#3fb950' web/src --include='*.vue' --include='*.ts' \
    | grep -v '^web/src/styles/tokens\.css' \
    | grep -v '^web/src/__tests__/'   # must be empty
  ```
  Repeat for each of the 51 distinct values.

### Step 10 — Full-tree hex gate

- Action: run the comprehensive zero-hex grep.
- Verification (must be empty):
  ```bash
  grep -rEn '#[0-9a-fA-F]{3,8}\b' web/src \
    --include='*.vue' --include='*.ts' --include='*.css' \
    | grep -v '^web/src/styles/tokens\.css' \
    | grep -v '^web/src/__tests__/'
  ```
  If any line is reported, return to Step 9 for that file. Do not proceed until the grep is empty.

### Step 11 — F02 extension gates

- Action: run the three F02-contract gates.
- Verification:
  ```bash
  # 1. Extensions present (must print 11):
  grep -En '^\.(status-dot-(ok|warn|danger|accent|muted)|card-(warn|danger|accent|user|purple)|pill-purple)\b' \
    web/src/styles/patterns.css | wc -l

  # 2. No global .tool-chip* leaked into the style layer (must be empty):
  grep -rEn '\.tool-chip|tool-chip-' web/src/styles

  # 3. No F02-forbidden global patterns (must be empty):
  grep -rEn '\.(msg-(meta|content|badges)|role-(user|assistant|system)|kind-(reasoning|activity|plain)|btn-sm|thinking-dots|pill-active|panel-heading-h1)\b' \
    web/src/styles
  ```

### Step 12 — Typecheck

- Action: run TypeScript typecheck.
- Verification:
  ```bash
  pnpm -C web typecheck
  ```
- Expectation: passes unchanged. F01 introduces no `.ts` type changes.

### Step 13 — Tests

- Action: run the web test suite.
- Verification:
  ```bash
  pnpm -C web test
  ```
- Expectation: passes. Snapshot churn, if any, is bounded to embedded color values inside [web/src/__tests__/__snapshots__/](../../../../web/src/__tests__/__snapshots__/). Re-baseline by running with the project's snapshot-update flag (vitest `--update` or equivalent) **only after** manually reviewing every snapshot diff and confirming that:
  - No class name changed.
  - No text content changed.
  - No attribute presence changed.
  - The only delta is an embedded color string (which becomes a CSS var reference in the rendered output, or — if the snapshot captures computed styles — the var-resolved value).
  Re-baselining lands inside the F01 commit.

### Step 14 — Build

- Action: run the web build.
- Verification:
  ```bash
  pnpm -C web build
  ```
- Expectation: Vite resolves the `@import` chain, inlines the four imported CSS files, and emits a single CSS bundle. `highlight.js/styles/github-dark.css` resolves from `node_modules`; `highlight-overrides.css` is bundled after it.

### Step 15 — Visual diff matrix

- Action: serve the built UI (or run `pnpm -C web dev`) and walk through every surface listed in §8 of this plan. Compare against the pre-F01 baseline. Document any unexpected delta and reconcile before committing.

### Step 16 — Commit

- Action: commit the entire F01 worktree (new `styles/` files, modified `main.ts`, hex-rewrites across components/views/App, snapshot re-baseline if any).
- Commit message (suggested):
  ```
  F01: introduce design tokens & semantic CSS layer
  
  Add web/src/styles/{tokens,semantic,base,patterns,index,highlight-overrides}.css.
  Patterns is v2 verbatim + F02 tone extensions (.status-dot-*, .card-*, .pill-purple).
  Rewrite main.ts import order to load index.css first, github-dark second, overrides third.
  Replace every hex literal under web/src outside tokens.css with the mapped var(--...).
  
  See SPEC/2026-05/review-ui-port-from-v2/F01-design-tokens/{01-analysis-r2,02-design-r2,03-plan-r1}.md.
  ```
- Single commit (see §6).

---

## 6. Commit boundary

**One commit.** F01 lands as a single, atomic commit covering:

- All six new files under [web/src/styles/](../../../../web/src/styles/).
- The [web/src/main.ts](../../../../web/src/main.ts) import-block rewrite.
- Every hex-to-`var(--…)` rewrite across [web/src/components/](../../../../web/src/components/), [web/src/views/](../../../../web/src/views/), and [web/src/App.vue](../../../../web/src/App.vue).
- Any snapshot re-baseline inside [web/src/__tests__/__snapshots__/](../../../../web/src/__tests__/__snapshots__/).

No intermediate commits. No staging branches. No `// TODO F02:` comments. No partial WIP commit between Step 9 and Step 13 — the gates are part of the same commit's verification.

---

## 7. Validation commands

Final pre-commit validation suite (all must succeed, in order):

```bash
# Hex outside tokens — zero matches:
grep -rEn '#[0-9a-fA-F]{3,8}\b' web/src --include='*.vue' --include='*.ts' --include='*.css' \
  | grep -v '^web/src/styles/tokens\.css' \
  | grep -v '^web/src/__tests__/'

# F02 extensions present — 11 matches:
grep -En '^\.(status-dot-(ok|warn|danger|accent|muted)|card-(warn|danger|accent|user|purple)|pill-purple)\b' \
  web/src/styles/patterns.css | wc -l

# No global .tool-chip* in styles — zero matches:
grep -rEn '\.tool-chip|tool-chip-' web/src/styles

# No F02-forbidden global patterns — zero matches:
grep -rEn '\.(msg-(meta|content|badges)|role-(user|assistant|system)|kind-(reasoning|activity|plain)|btn-sm|thinking-dots|pill-active|panel-heading-h1)\b' \
  web/src/styles

# Build pipeline:
pnpm -C web typecheck
pnpm -C web test
pnpm -C web build
```

If any of the four grep gates is non-empty, or any of the three pnpm commands fails, the commit is **not ready**.

---

## 8. Visual diff matrix

Every surface below is manually inspected against the dark-mode preview after Step 14, before Step 16. Expected outcome: no raw hex in DevTools "Computed styles" outside highlight.js token rules; no layout shift; tones distinct per §A.4.5 of the design.

| # | Surface | File | What to check |
| --- | --- | --- | --- |
| 1 | Dashboard | [web/src/views/DashboardView.vue](../../../../web/src/views/DashboardView.vue) | rt-frozen tile keeps blue tint; tile borders match `--border`; no scrollbar artefact on the main scroller. |
| 2 | App shell + auth banner | [web/src/components/layout/AppShell.vue](../../../../web/src/components/layout/AppShell.vue) | auth-required banner red-on-dark-red; emphasis word uses `--danger`; body text reads as `--text` (≥ 10:1 contrast). |
| 3 | Nav rail | [web/src/components/nav/NavRail.vue](../../../../web/src/components/nav/NavRail.vue) | hover/selected states drive from `--surface-*` and `--hover-bg`. |
| 4 | Analyst chat | [web/src/components/chat/AnalystChatPanel.vue](../../../../web/src/components/chat/AnalystChatPanel.vue) | user / assistant entry strips retain blue/grey contrast; tool chips unchanged in tone; composer surface unchanged. |
| 5 | Agents conversation | [web/src/components/agents/AgentConversationView.vue](../../../../web/src/components/agents/AgentConversationView.vue) | per-step tool bars; warn / danger / accent strips visually distinct. |
| 6 | Agents list | [web/src/views/AgentsView.vue](../../../../web/src/views/AgentsView.vue) | per-row status tints match `--entry-{accent,warn,danger}` family. |
| 7 | API token entry | [web/src/components/auth/ApiTokenEntry.vue](../../../../web/src/components/auth/ApiTokenEntry.vue) | danger strip; primary button uses `--btn-primary-bg` + `--btn-primary-text` (#0d1117 on green). |
| 8 | Files view | [web/src/views/FilesView.vue](../../../../web/src/views/FilesView.vue) | quarantine footer reads as `--surface-2`; row hover from `--hover-bg`. |
| 9 | Debug view | [web/src/views/DebugView.vue](../../../../web/src/views/DebugView.vue) | per-process entry strips warn / danger / accent; supervisor row separators on `--border`. |
| 10 | Cards board | [web/src/components/cards/CardsBoardView.vue](../../../../web/src/components/cards/CardsBoardView.vue) | column surfaces on `--surface-2`; card surfaces on `--surface-1`; active card border on `--entry-accent-border`. |
| 11 | Cards timeline | [web/src/components/cards/CardsTimelineView.vue](../../../../web/src/components/cards/CardsTimelineView.vue) | timeline track on `--border`; event chips by status — accent / warn / danger consistent with row 9. |
| 12 | Card detail | [web/src/components/cards/CardDetailView.vue](../../../../web/src/components/cards/CardDetailView.vue) | meta on `--text-muted`; body on `--text`; status block uses entry-* tints. |
| 13 | Code block | [web/src/components/code/CodeBlock.vue](../../../../web/src/components/code/CodeBlock.vue) | wrapper background `--code-block-bg`, border `--code-block-border`; highlight.js token colors unchanged. |
| 14 | Markdown text | [web/src/components/code/MarkdownText.vue](../../../../web/src/components/code/MarkdownText.vue) | inline code on `--code-bg` / `--code-color`; block code as row 13. |
| 15 | Root | [web/src/App.vue](../../../../web/src/App.vue) | global background `--bg`; default text `--text`; no orphaned hex in Computed styles. |
| 16 | Scrollers (cross-surface) | n/a | global scrollbar paints `--border-strong` thumb on `--bg` track on every long surface (rows 1, 4, 5, 8, 9, 11, 13). Overflow-hidden regions unaffected. |

If a row reveals an unmapped colour, return to Step 9 for the offending file, re-run Step 10, and re-validate.

Optional, non-blocking: a Playwright pixel-diff over rows 1–15 if a runner is available in the repo at implementation time (per §A.4.5.opt of the design).

---

## 9. Rollback

Single `git revert <F01-sha>`. The commit is atomic; revert restores:

- The pre-F01 [web/src/main.ts](../../../../web/src/main.ts) (highlight.js-only import).
- The pre-F01 `*.vue` files with their hex-literal `<style scoped>` blocks.
- Removes [web/src/styles/](../../../../web/src/styles/) entirely.

No schema, no on-disk format, no migration, no data file is touched. There is no second commit to revert; there is no fallback path to clean up; there is no shim to remove. The revert returns v3 to the exact pre-F01 state.

---

## 10. Risks and mitigations

| Risk | Likelihood | Mitigation |
| --- | --- | --- |
| Hex-rewrite misses a site (typo, dynamic-string, ternary). | Medium | Step 10's full-tree grep gate is the backstop; it must be empty before commit. Step 9 also runs per-hex grep after each value pass. |
| Ambiguous `#3fb950` mapping (accent vs btn-primary-bg) collapses both onto the same var. | Medium | Step 9 explicit rule: grep the site, decide by CSS role. The design §3.4 enumerates each occurrence's role. |
| Snapshot churn explodes (vitest snapshots include rendered HTML with embedded styles). | Low | Snapshots assert on class names / text / attribute presence per the analysis §6; the analysis verified the directory contents. Re-baseline inside the F01 commit, reviewing every diff. |
| `color-mix(in srgb, …)` unsupported by a target browser. | Very low | v3 targets Chromium ≥ 111, Firefox ≥ 113, Safari ≥ 16.2 — all support `color-mix`. No fallback path designed. |
| highlight.js wrapper "pops" against `--bg` (background mismatch with `--code-block-bg`). | Low | `highlight-overrides.css` (Step 6) overrides only `pre.hljs` background / border / border-radius. Token rules (`.hljs-*`) remain from github-dark.css. |
| Scrollbar regression on previously hidden-overflow surfaces. | Very low | Global `::-webkit-scrollbar` only paints when a scrollbar exists; `overflow:hidden` regions are unaffected. Row 16 of the visual matrix covers this explicitly. |
| Specificity collision between `.syn-*` (patterns.css, imported first) and `.hljs-*` (highlight, imported second). | Very low | No element today composes both. Source order wins; documented at the top of `patterns.css` as a comment block during Step 4. |
| Vue SFC buffer corruption during long edit sequences (per user-memory note). | Medium | Step 9 explicitly says: prefer `multi_replace_string_in_file` per file (single transaction); save all buffers (`workbench.action.files.saveAll`) before moving to next file; run `grep -c '<script setup'` on touched `.vue` files between files as a sanity check. |
| F02 needs a tone selector not anticipated by §A.2.4 of the design. | Low | The §A.2.4 set was reviewer-vetted against F02 r3. Any additional selector F02 actually needs lands in F02's own commit as an explicit extension — F01 will not preemptively add it. |
| Re-running `pnpm -C web build` re-imports `github-dark.css` in a different order. | Very low | Vite preserves source order of static imports in `main.ts`. Verified in Step 7. |

---

## 11. Out of scope

The following are explicitly **not** F01's responsibility. Touching any of them inside the F01 commit is a plan violation.

- **F02 — Component hierarchy.** Collapsing `<style scoped>` blocks onto pattern classes; adding `data-testid` markup; introducing the conversation composites `ToolChip`, `MessageBubble`, `ThinkingDots`, `PanelHeading`, `Card`, `Pill`, `Button`, `StatusDot`. See [F02 02-design-r3.md](../F02-component-hierarchy/02-design-r3.md).
- **F03 — Conversation rounds.** Round filter chips, round status dots, diagnostic categories, pending-call footer, compacted clusters, round card layout. F03 consumes `.card`, `.card-active`, `.card-purple`, `.card-warn`, `.pill-purple`, `.pill-warn`, `.status-dot-{ok,warn,danger,accent,muted}` from F01. See [F03 02-design-r3.md](../F03-conversation-rounds/02-design-r3.md).
- **F04 — Chat surface style.** Message-bubble composite, composer surface, chat-internal layout. F04 consumes `.card`, `.card-{user,accent,purple,warn,danger}`, and the `--surface-*` / `--entry-*` semantic vars from F01. See [F04 02-design-r2.md](../F04-chat-surface-style/02-design-r2.md).
- **F05 — Tool-detail rendering.** `ToolChip` markup (`<div role="group">`), `InlineParts.vue`, presenter contract, expand-button behaviour. F05 consumes `.card`, `.card-accent`, `.card-danger`, `.card-warn`, `.btn`, `.pill-accent`, `.pill-warn`, `.pill-danger` from F01, and the semantic vars `--accent`, `--warn`, `--danger`, `--text-muted`. See [F05 02-design-r3.md](../F05-tool-detail-rendering/02-design-r3.md).

Explicit non-additions in F01 (per design §A.2.4 "What is explicitly NOT added"):

- No `.tool-chip*` global patterns (composite-local in F02).
- No `.btn-sm` (dropped by F02 r3).
- No `.msg`, `.msg-meta`, `.msg-content`, `.msg-badges` (composite-local in F02).
- No `.role-*`, `.kind-*` (composite-local in F02).
- No `.thinking-dots` (composite-local in F02; reuses `@keyframes pulse` from Block 1).
- No `.pill-active` (replaced by `[aria-pressed="true"]` in F03 / F02).
- No `.panel-heading-h1` (F02 r3 keeps `WorkspaceHeader` outside `PanelHeading`).

Also out of scope: theme switcher, light theme, `data-theme` attribute, `prefers-color-scheme` block, body class for theming, store/Pinia changes, backend or API changes, new dependencies (Tailwind, Open Props, PostCSS plugins, CSS-in-JS), build-step changes, retheming of highlight.js token colours, `--legacy-*` mirrors, per-component fallback `var(--x, #hex)`, migration shims of any kind.

---

**Absolute path of this plan:** `/home/salva/g/ml/saivage-v3/SPEC/2026-05/review-ui-port-from-v2/F01-design-tokens/03-plan-r1.md`
