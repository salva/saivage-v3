# F02 — Component hierarchy / UI primitive layer — Implementation plan (r2)

Writer round 2 of the implementation phase. Addresses every
blocking item in
[03-plan-review-r1.md](03-plan-review-r1.md) (VERDICT:
CHANGES_REQUESTED) while preserving the 15-commit shape, the
deletion matrix, and the project guideline.

Inputs:

- Approved analysis: [01-analysis-r2.md](01-analysis-r2.md).
- Approved design: [02-design-r3.md](02-design-r3.md).
- Binding critique: [03-plan-review-r1.md](03-plan-review-r1.md).
- Sibling designs (cross-issue contracts, all DESIGN-APPROVED):
  [F01 02-design-r2](../F01-design-tokens/02-design-r2.md),
  [F03 02-design-r3](../F03-conversation-rounds/02-design-r3.md),
  [F04 02-design-r2](../F04-chat-surface-style/02-design-r2.md),
  [F05 02-design-r3](../F05-tool-detail-rendering/02-design-r3.md).

**Project guideline (binding, repeated for emphasis):**
**ARCHITECTURE-FIRST, NO BACKWARD COMPATIBILITY.** Every bespoke
v3 selector enumerated in analysis §4 is **deleted in the same
commit** that introduces its replacement primitive. No
`@deprecated` re-exports, no `.legacy-*` holdovers, no alias
period, no `index.ts` barrels under `ui/` / `content/` /
`conversation/`. The single explicit barrel in the cross-issue
graph is `web/src/utils/tool-presenters/index.ts` (F05-owned, lands
in C4 of this plan together with the deletion of the old single
file `web/src/utils/tool-presenters.ts`).

---

## Coverage map (review r1 → r2 section)

| Review r1 item | Status | r2 section(s) |
| --- | --- | --- |
| **Blocking 1** — C4 `sideEffects` path was the bespoke `./web/src/utils/tool-presenters/**`; must match F05 r3 §3.4 canonical package-relative `["src/utils/tool-presenters/**/*.ts", "*.css"]`; gate only checked key existence | Fixed | [§1.3 row for `web/package.json`](#13-modified) — exact JSON value; [§2 C4 Adds/Modifies block](#c4--utilstool-presenters-directory--jsonview--formattedcontent--inlineparts--json-tokenizets--delete-single-file-presenter) — exact `sideEffects` array; [§2 C4 verification](#c4--utilstool-presenters-directory--jsonview--formattedcontent--inlineparts--json-tokenizets--delete-single-file-presenter) — gate asserts exact entries (including the `*.css` row); [§3 (i)](#3-validation-after-every-commit-and-at-the-end-of-c15) — full-suite recheck. |
| **Blocking 2** — C4 grep used PCRE lookahead `(?!/)` (not supported by default `rg`); pipeline `! … \| … \| tee` masks exit status; temp files written to `/tmp/...` violating the workspace rule | Fixed | [§0 conventions](#0-preconditions) — `tmp/` rule restated; [§2 C2 grep gates](#c2--uipillcardpanelheadingstatusdotspinneroverlayvue--f01-r2-extension-patterns--eslint-blocks-25), [§2 C4 grep gates](#c4--utilstool-presenters-directory--jsonview--formattedcontent--inlineparts--json-tokenizets--delete-single-file-presenter), and [§3 (f)](#3-validation-after-every-commit-and-at-the-end-of-c15) rewritten to use portable positive/negative checks (or explicit `rg -P` when PCRE is actually required) and write to `tmp/` not `/tmp/`. |
| **Blocking 3** — C6's grep gate required AppShell to short-circuit on `document.body.dataset.modalOpen`, but C6's modified-file list excluded `AppShell.vue` (assigned to C7); commit sequence ambiguous | Fixed | [§1.3 modified table](#13-modified) — `AppShell.vue` keydown short-circuit moved from C7 to C6; C7 row reduced to auth-banner rewrite only; [§2 C6](#c6--authapitokenentryvue-rewrite-on-overlay--button--appshellvue-keydown-suppression) — adds the AppShell short-circuit edit explicitly and verifies it; [§2 C7](#c7--layoutappshellvue-auth-banner--layoutworkspaceheadervue-chip-cluster) — verification scoped to the auth-banner rewrite only. |
| **Blocking 4** — Rollback notes overstated independence for overlapping commits (C5/C11 AgentConversationView; C5/C13 AnalystChatPanel; C6/C15 NavRail; under fix to Blocking 3 also C6/C7 AppShell) | Fixed | [§4 rollback table](#4-rollback) — adds a per-pair "revert-first" column listing every overlapping later commit that MUST be reverted before reverting the earlier one, with the explicit no-alias constraint preserved. |
| Coverage check — implementability, ordering, no-alias, validation, cross-issue | Preserved | structure unchanged; gates tightened in C2/C4/C6/C7 and in §3. |

This document otherwise inherits r1's structure verbatim where no
substantive change is needed. The r2 corrections are concentrated
in: this coverage map, §1.3 (table rows for `web/package.json`,
`AppShell.vue`, `WorkspaceHeader.vue`), §2 (C2 / C4 / C6 / C7
verification + grep gates), §3 (validation block (f) and (i)), and
§4 (rollback dependency table).

---

## 0. Preconditions

Before this plan can begin, the following must be true at HEAD:

1. **F01 r2 has landed.** `web/src/styles/patterns.css` and
   `semantic.css` exist with the F01 r2 token + pattern surface
   (analysis [§2.1](01-analysis-r2.md#21-patterns-inherited-from-f01-r1-verbatim)).
   Verification:

   ```bash
   test -f web/src/styles/patterns.css
   test -f web/src/styles/semantic.css
   rg -n '\.btn[^-]|\.pill[^-]|\.card[^-]|\.entry-user|\.code-block|\.syn-key|\.panel-heading|\.status-dot|\.overlay|\.spin|\.pulse' web/src/styles/patterns.css
   ```

   All listed selectors must be present. If F01 r2 has not landed,
   stop and merge F01 first.

2. **F01 r2 must absorb the F02 extension list** ([analysis §2.2](01-analysis-r2.md#22-f02-extensions-to-f01-must-land-in-f01-r2)):
   `.status-dot-{ok,warn,danger,accent,muted}`,
   `.card-{warn,danger,accent,user,purple}`, `.pill-purple`, and
   the conditional selector
   `.tablist > .pill[aria-pressed="true"]`. If those rules are not
   in `web/src/styles/patterns.css` yet, this plan's **C2** lands
   them inline as F02-owned (open question Q1, [design §8](02-design-r3.md#8-risks-and-open-questions));
   open question Q1 is resolved by the reviewer of this plan
   choosing one of the two paths. The default this plan assumes is
   **C2 lands them inline in `patterns.css`** so F02 unblocks
   itself.

3. **No F02 work has started.** Verification:

   ```bash
   test ! -d web/src/components/ui
   test ! -d web/src/components/content
   test ! -d web/src/components/conversation
   test -d web/src/components/code   # still the OLD location
   test -f web/src/utils/tool-presenters.ts  # still the OLD single file
   ```

4. **Cross-issue PRs are NOT in flight in conflicting order.** The
   F03 PR (which co-owns C5) and the F05 commit set (C4) are
   sequenced inside this plan; no separate parallel branches for
   F03/F05 may be merged ahead of this plan's C4/C5.

5. **`web/package.json` / lockfile clean.** `npm ci` succeeds and
   `npx vue-tsc --noEmit && npm run lint && npm test && npm run build`
   are all green on the base branch.

6. **Working tree clean** (`git status --porcelain` empty) before
   starting any commit in this plan.

**Workspace temp-file convention (binding, per workspace operating
rules):** every temporary artifact written by a grep gate or a
verification command in this plan goes under the workspace-local
`tmp/` directory (e.g. `tmp/f02-c2-lucide.txt`,
`tmp/f02-c4-leaks.txt`, `tmp/f02-style-leaks.txt`), **never** under
`/tmp/`. This applies to every `tee`, redirection, or scratch path
referenced in §2 and §3. The operator is expected to `mkdir -p tmp`
once before running the gates.

---

## 1. Files added / modified / deleted (consolidated)

### 1.1 Added (SFCs)

| Path | Owner | Commit |
| --- | --- | --- |
| `web/src/components/ui/Button.vue` | F02 | C1 |
| `web/src/components/ui/Pill.vue` | F02 | C2 |
| `web/src/components/ui/Card.vue` | F02 | C2 |
| `web/src/components/ui/PanelHeading.vue` | F02 | C2 |
| `web/src/components/ui/StatusDot.vue` | F02 | C2 |
| `web/src/components/ui/Spinner.vue` | F02 | C2 |
| `web/src/components/ui/Overlay.vue` | F02 | C2 |
| `web/src/components/content/CodeBlock.vue` | F02 (relocated) | C3 |
| `web/src/components/content/MarkdownText.vue` | F02 (relocated) | C3 |
| `web/src/components/content/JsonView.vue` | F05 (committed here) | C4 |
| `web/src/components/content/FormattedContent.vue` | F05 (committed here) | C4 |
| `web/src/components/content/InlineParts.vue` | F05 (committed here) | C4 |
| `web/src/components/conversation/MessageBubble.vue` | F02 | C5 |
| `web/src/components/conversation/ThinkingDots.vue` | F02 | C5 |
| `web/src/components/conversation/ToolChip.vue` | F02 r3 API, ships in F03 PR | C5 |
| `web/src/components/conversation/RoundCard.vue` | F03 (committed in C5) | C5 |
| `web/src/components/conversation/DiagnosticRow.vue` | F03 | C5 |
| `web/src/components/conversation/PendingCallFooter.vue` | F03 | C5 |
| `web/src/components/conversation/CompactedCluster.vue` | F03 | C5 |
| `web/src/components/conversation/ContextBlock.vue` | F03 | C5 |
| `web/src/components/chat/tool-chip-adapter.ts` | F04 (committed in C5) | C5 |
| `web/src/components/chat/analyst-timeline.ts` | F03 (committed in C5) | C5 |

### 1.2 Added (utils, F05-owned, lands in C4)

| Path | Notes |
| --- | --- |
| `web/src/utils/tool-presenters/index.ts` | barrel (F05 r3 §3) |
| `web/src/utils/tool-presenters/types.ts` | `InlinePart`, `ToolCallPresentation`, `ToolResultPresentation` |
| `web/src/utils/tool-presenters/registry.ts` | registry + `EXPECTED_TOOL_NAMES` |
| `web/src/utils/tool-presenters/<per-tool>.ts` | per-tool modules, side-effect imported by `index.ts` |
| `web/src/utils/json-tokenize.ts` | F05 r3 §7.1 extraction |
| `web/src/utils/agent-timeline/types.ts` | F03 r3 §3.1 — exports `ToolPairStatus` (F03 owns; landed before C5) |

### 1.3 Modified

| Path | Reason | Commit |
| --- | --- | --- |
| `web/.eslintrc.cjs` (or `eslint.config.*`) | five `no-restricted-imports` overrides (design [§1.2](02-design-r3.md#12-composition-rules-enforced-by-code-review--eslint-no-restricted-imports)) | C1 (block 1) + C2 (blocks 2–5 land alongside `ui/` + `content/` shells) |
| `web/package.json` | Add `"sideEffects": ["src/utils/tool-presenters/**/*.ts", "*.css"]` — the **F05 r3 §3.4 canonical package-relative array** (Blocking 1 fix). If a `*.css` side-effect entry already exists on the base branch, it MUST be preserved verbatim and the `src/utils/tool-presenters/**/*.ts` entry inserted alongside it; the final array MUST contain at least these two entries. | C4 |
| `web/src/styles/patterns.css` | extension rules listed in analysis §2.2 (status-dot tones, card tones, pill-purple, tablist active-pill rule) — only if F01 r2 has not absorbed them already | C2 |
| `web/src/components/layout/AppShell.vue` (keydown short-circuit) | Add the `document.body.dataset.modalOpen === 'true'` short-circuit at the top of AppShell's global keydown handler (design [§9.2](02-design-r3.md) / analysis [§9.2](01-analysis-r2.md#92-appshell-shortcut-suppression)). **Moved from C7 to C6 (Blocking 3 fix)** because C6 is the first commit at which `<Overlay>` becomes a real auth-dialog dependency and the chip-suppression flag must be honoured immediately. | C6 |
| `web/src/components/layout/AppShell.vue` (auth banner rewrite) | Rewrite the auth-required banner onto `<Card tone="danger">` + `<Button>` (analysis §4.1, §6.1). The keydown short-circuit landed in C6 is not re-touched here. | C7 |
| `web/src/components/layout/WorkspaceHeader.vue` | chip cluster rewrite | C7 |
| `web/src/components/auth/ApiTokenEntry.vue` | rewrite on `Overlay` + `Button` | C6 |
| `web/src/components/nav/NavRail.vue` | `<Button icon-only>` for `.api-token-btn` (only that one line in C6); the rest of NavRail's surface-local layout styles land in C15 | C6 + C15 |
| `web/src/views/DashboardView.vue` | rewrite per analysis §4.5 | C8 |
| `web/src/views/FilesView.vue` | rewrite per analysis §4.6 | C9 |
| `web/src/views/DebugView.vue` | rewrite per analysis §4.7 | C10 |
| `web/src/components/agents/AgentConversationView.vue` | non-round migration (toolbar, state panels); F03's round bodies already landed in C5 | C11 |
| `web/src/components/agents/RawLlmExchangePanel.vue` | rewrite per analysis §4.9 | C12 |
| `web/src/components/chat/AnalystChatPanel.vue` | (a) C5: chip swap + delete `.tool-chip*` family. (b) C13: rewrite the non-chip surface (composer, header, message list) on primitives | C5, C13 |
| `web/src/components/cards/*.vue` (CardDetailView, CardsBoardView, CardsLeaderboardView, CardsTreeView, CardHistoryPanel, StaleWarningRibbon) | rewrites per analysis §4.11 | C14 |
| consumer imports for `components/code/*` → `components/content/*` | atomic update in C3 | C3 |

### 1.4 Deleted (no re-export shim, no alias period — project guideline)

| Path | Commit |
| --- | --- |
| `web/src/components/code/CodeBlock.vue` | C3 |
| `web/src/components/code/MarkdownText.vue` | C3 |
| `web/src/components/code/` (now-empty directory) | C3 |
| `web/src/utils/tool-presenters.ts` (the single file) | C4 |
| In-line `.tool-chip*` / `.pending-tool-*` markup + scoped CSS inside `chat/AnalystChatPanel.vue` | C5 (same commit as `ToolChip.vue`) |
| Every bespoke selector enumerated in analysis [§4.1–§4.11](01-analysis-r2.md#4-deletion--migration-matrix) — deleted in the same commit as its replacement (C6–C15 per matrix in design [§1.4](02-design-r3.md#14-deletion-matrix-commit-bound)) | C6–C15 |

---

## 2. Step-by-step landing sequence (15 commits)

Every commit below MUST:

1. Leave `npx vue-tsc --noEmit` green.
2. Leave `npm run lint` green (the `no-restricted-imports` overrides
   from design §1.2 must pass on every file the commit creates or
   modifies).
3. Leave `npm test -- --run` green.
4. Pass the grep gates listed under "verification" for that commit.

If any gate fails, the commit is amended (or split) before
proceeding. The plan does NOT continue to the next commit while a
gate is red. **All temporary artifacts the gates write go under
the workspace-local `tmp/` directory (see §0); the operator runs
`mkdir -p tmp` once before C1.**

### C1 — `ui/Button.vue` + ESLint block 1 (`ui/*` base rule)

**Adds:** `web/src/components/ui/Button.vue`,
`web/src/__tests__/ui/Button.test.ts`, ESLint override block #1
(design §1.2, base `ui/*` rule excluding Spinner) in
`web/.eslintrc.cjs` (or the project's equivalent ESLint config
entry point).

**Deletes:** nothing.

**Modifies:** ESLint config only.

**Verification:**

```bash
test -f web/src/components/ui/Button.vue
test -f web/src/__tests__/ui/Button.test.ts
rg -n "no-restricted-imports" web/.eslintrc.cjs web/eslint.config.* 2>/dev/null | head
npx vue-tsc --noEmit
npm run lint -- web/src/components/ui web/src/__tests__/ui
npm test -- --run Button.test
```

**Grep gates:**

```bash
# Button.vue must not import other primitives, stores, router, or lucide.
! rg -n "from\s+['\"](.*/components/(ui|content|conversation)/|pinia|vue-router|.*stores/|lucide-vue-next)" web/src/components/ui/Button.vue
# defineProps signature is the typed generic; no withDefaults on required props.
rg -n "defineProps<\{" web/src/components/ui/Button.vue
```

**Commit message shape:**
`F02 C1: add ui/Button.vue + ESLint ui/* base override`.

### C2 — `ui/{Pill,Card,PanelHeading,StatusDot,Spinner,Overlay}.vue` + F01 r2 extension patterns + ESLint blocks 2–5

**Adds:**

- `web/src/components/ui/Pill.vue`
- `web/src/components/ui/Card.vue`
- `web/src/components/ui/PanelHeading.vue`
- `web/src/components/ui/StatusDot.vue`
- `web/src/components/ui/Spinner.vue`
- `web/src/components/ui/Overlay.vue`
- `web/src/__tests__/ui/{Pill,Card,PanelHeading,StatusDot,Spinner,Overlay}.test.ts`
- ESLint override blocks #2 (Spinner exception), #3 (content base),
  #4 (InlineParts exception), #5 (conversation/) — all the rules
  exist now even though `content/` and `conversation/` are empty;
  ESLint allows them as no-op overrides without files yet.
- The F01 r2 extension rules listed in analysis §2.2 are appended
  to `web/src/styles/patterns.css` if and only if F01 r2 did not
  already include them (Preconditions §0 step 2).

**Deletes:** nothing.

**Modifies:** ESLint config, `web/src/styles/patterns.css` (only if
extensions were not already in F01 r2).

**Verification:**

```bash
mkdir -p tmp
for f in Pill Card PanelHeading StatusDot Spinner Overlay; do
  test -f "web/src/components/ui/$f.vue" || echo "MISSING: $f"
  test -f "web/src/__tests__/ui/$f.test.ts" || echo "MISSING test: $f"
done
npx vue-tsc --noEmit
npm run lint
npm test -- --run "ui/(Pill|Card|PanelHeading|StatusDot|Spinner|Overlay).test"
# Pattern-class extensions present:
rg -n '\.status-dot-(ok|warn|danger|accent|muted)\b' web/src/styles/patterns.css
rg -n '\.card-(warn|danger|accent|user|purple)\b' web/src/styles/patterns.css
rg -n '\.pill-purple\b' web/src/styles/patterns.css
rg -n '\.tablist > \.pill\[aria-pressed="true"\]' web/src/styles/patterns.css
```

**Grep gates (portable; no PCRE lookaround):**

```bash
# No primitive imports another primitive.
! rg -n "from\s+['\"](.*/components/(ui|content|conversation)/)" web/src/components/ui/Pill.vue
! rg -n "from\s+['\"](.*/components/(ui|content|conversation)/)" web/src/components/ui/Card.vue
! rg -n "from\s+['\"](.*/components/(ui|content|conversation)/)" web/src/components/ui/PanelHeading.vue
! rg -n "from\s+['\"](.*/components/(ui|content|conversation)/)" web/src/components/ui/StatusDot.vue
! rg -n "from\s+['\"](.*/components/(ui|content|conversation)/)" web/src/components/ui/Overlay.vue
# Spinner is the ONLY ui/ file allowed to import lucide-vue-next.
# Portable: collect every ui/ file mentioning lucide, then diff against the single allow-listed path.
rg -l "lucide-vue-next" web/src/components/ui | LC_ALL=C sort > tmp/f02-c2-lucide.txt
printf 'web/src/components/ui/Spinner.vue\n' > tmp/f02-c2-lucide.expected
diff tmp/f02-c2-lucide.expected tmp/f02-c2-lucide.txt \
  || { echo "Lucide leak in ui/ (see tmp/f02-c2-lucide.txt)"; exit 1; }
# Overlay test enumerates the seven cases from analysis §5.4.
rg -n "Escape|backdrop|focus|inert|previouslyFocused|wrap|restore" web/src/__tests__/ui/Overlay.test.ts | wc -l   # expect >= 7
```

### C3 — Relocate `code/` → `content/`; delete `components/code/`

**Adds:** `web/src/components/content/CodeBlock.vue`,
`web/src/components/content/MarkdownText.vue` (via `git mv`),
`web/src/__tests__/content/CodeBlock.test.ts`,
`web/src/__tests__/content/MarkdownText.test.ts` (via `git mv` from
the old `code-block.test.ts` / `markdown-text.test.ts`).

**Deletes:** `web/src/components/code/CodeBlock.vue`,
`web/src/components/code/MarkdownText.vue`, the directory
`web/src/components/code/` itself, and the old test paths.

**Modifies:** every consumer import. List of consumers:

```bash
rg -l "from\s+['\"].*components/code/(CodeBlock|MarkdownText)" web/src
```

Each match is rewritten to `from '…/components/content/CodeBlock'`
/ `…/MarkdownText'`. No re-export shim under the old path.

**Verification:**

```bash
test ! -e web/src/components/code   # directory must be GONE
test -f web/src/components/content/CodeBlock.vue
test -f web/src/components/content/MarkdownText.vue
npx vue-tsc --noEmit
npm run lint
npm test -- --run "content/(CodeBlock|MarkdownText).test"
```

**Grep gates:**

```bash
# No surviving import of the old path.
! rg -n "from\s+['\"].*components/code/" web/src
# No re-export shim, no alias.
! test -e web/src/components/code
! rg -n "code/CodeBlock|code/MarkdownText" web/src
```

### C4 — `utils/tool-presenters/` directory + `JsonView` / `FormattedContent` / `InlineParts` + `json-tokenize.ts` + delete single-file presenter

**Adds:**

- `web/src/utils/tool-presenters/index.ts` (barrel)
- `web/src/utils/tool-presenters/types.ts`
- `web/src/utils/tool-presenters/registry.ts`
- `web/src/utils/tool-presenters/<per-tool>.ts` for every tool in
  F05 r3 §3 `EXPECTED_TOOL_NAMES`
- `web/src/utils/json-tokenize.ts`
- `web/src/components/content/JsonView.vue`
- `web/src/components/content/FormattedContent.vue`
- `web/src/components/content/InlineParts.vue`
- `web/src/__tests__/content/{JsonView,FormattedContent,InlineParts}.test.ts`
- `web/src/__tests__/utils/json-tokenize.test.ts`
- `web/src/__tests__/utils/tool-presenters/{barrel-integrity,registry,coverage}.test.ts`

**Modifies (Blocking 1 fix — canonical F05 r3 §3.4 path):**
`web/package.json` ships the exact array

```json
"sideEffects": [
  "src/utils/tool-presenters/**/*.ts",
  "*.css"
]
```

If the base branch already has a `*.css` entry (or any other
side-effect entry the v3 build depends on), the C4 edit MUST
preserve every existing entry and add `src/utils/tool-presenters/**/*.ts`
to the array. The package-relative path (no leading `./web/`)
matches F05 r3 §3.4. Every consumer import of
`'../../utils/tool-presenters'` resolves to the new directory (no
path change at the call site, since the analysis-canonical path
was always the directory).

**Deletes:** `web/src/utils/tool-presenters.ts` (the single file)
and any test that imported it directly via the `.ts` suffix. NO
re-export shim.

**Verification:**

```bash
mkdir -p tmp
test ! -f web/src/utils/tool-presenters.ts
test -f web/src/utils/tool-presenters/index.ts
test -f web/src/utils/tool-presenters/types.ts
test -f web/src/utils/tool-presenters/registry.ts
test -f web/src/utils/json-tokenize.ts
for f in JsonView FormattedContent InlineParts; do
  test -f "web/src/components/content/$f.vue" || echo "MISSING: $f"
done

# sideEffects assertion — exact canonical entries, package-relative
# (Blocking 1 fix). Use jq to read the array and verify each required
# entry is present verbatim; reject the legacy "./web/..." path.
node -e '
  const pkg = JSON.parse(require("fs").readFileSync("web/package.json","utf8"));
  const se = pkg.sideEffects;
  if (!Array.isArray(se)) { console.error("web/package.json sideEffects must be an array"); process.exit(1); }
  const required = ["src/utils/tool-presenters/**/*.ts", "*.css"];
  for (const r of required) {
    if (!se.includes(r)) { console.error("missing sideEffects entry:", r); process.exit(1); }
  }
  const forbidden = se.filter(s => /^\.\/web\//.test(s) || /utils\/tool-presenters\/\*\*$/.test(s));
  if (forbidden.length) { console.error("forbidden non-canonical sideEffects entries:", forbidden); process.exit(1); }
'

npx vue-tsc --noEmit
npm run lint
npm test -- --run "(content/(JsonView|FormattedContent|InlineParts)|utils/(json-tokenize|tool-presenters/(barrel-integrity|registry|coverage)))"
```

**Grep gates (portable; Blocking 2 fix):**

```bash
mkdir -p tmp

# (1) No consumer imports the deleted single file by its .ts suffix.
! rg -n "from\s+['\"].*utils/tool-presenters\.ts['\"]" web/src

# (2) Every surviving import of `utils/tool-presenters` resolves to the
#     directory (no trailing slash, the bare module path), never to a
#     deep per-tool file. Replace r1's PCRE lookahead with two portable
#     scans:
#       (a) collect every line that imports anything matching utils/tool-presenters
#       (b) filter out the canonical bare-module import shapes; whatever
#           remains is a violation.
rg -n "from\s+['\"][^'\"]*utils/tool-presenters[^'\"]*['\"]" web/src \
   > tmp/f02-c4-import-lines.txt || true
# Allowed shapes:
#   from '../../utils/tool-presenters'
#   from '../../../utils/tool-presenters'
#   from '@/utils/tool-presenters'         (if the repo uses the @ alias)
# Anything ending with /<file>.ts or with a subpath beyond the directory is forbidden.
rg -v -e "utils/tool-presenters['\"]$" \
       -e "utils/tool-presenters['\"];?$" \
       tmp/f02-c4-import-lines.txt > tmp/f02-c4-leaks.txt || true
if [ -s tmp/f02-c4-leaks.txt ]; then
  echo "Non-canonical tool-presenters import shapes:"
  cat tmp/f02-c4-leaks.txt
  exit 1
fi

# (3) barrel-integrity test passes (every file in the directory is reachable from index.ts).
npm test -- --run utils/tool-presenters/barrel-integrity

# (4) registry.test passes (default + every EXPECTED_TOOL_NAMES is registered after one barrel import).
npm test -- --run utils/tool-presenters/registry

# (5) InlineParts template uses <router-link>/<a> but the SFC does NOT import vue-router.
! rg -n "from\s+['\"]vue-router['\"]" web/src/components/content/InlineParts.vue
rg -n "<router-link" web/src/components/content/InlineParts.vue
```

### C5 — Combined: shared `ToolChip.vue` (eight-prop bag) + `MessageBubble` + `ThinkingDots` + `AnalystChatPanel` chip swap + F03 round bodies + F04 chat adapter + F03 pairing utility

This is the **binding cross-batch commit** (design §1.4 C5 row,
§1.6). It is owned by the F03 PR (per F03 r3 §8.2) but is described
here in F02's plan because it deletes the analyst `.tool-chip*`
family that F02 owns the migration of.

**Adds:**

- `web/src/components/conversation/MessageBubble.vue` (F02)
- `web/src/components/conversation/ThinkingDots.vue` (F02)
- `web/src/components/conversation/ToolChip.vue` (F02 r3 eight-prop
  API; ships with the F03 PR)
- `web/src/components/conversation/RoundCard.vue` (F03)
- `web/src/components/conversation/DiagnosticRow.vue` (F03)
- `web/src/components/conversation/PendingCallFooter.vue` (F03)
- `web/src/components/conversation/CompactedCluster.vue` (F03)
- `web/src/components/conversation/ContextBlock.vue` (F03)
- `web/src/components/chat/tool-chip-adapter.ts` (F04 r2 §4.1 —
  returns the eight-prop bag)
- `web/src/components/chat/analyst-timeline.ts` (F03 r3 §3.4)
- `web/src/__tests__/conversation/{MessageBubble,ToolChip,ThinkingDots}.test.ts`
- `web/src/__tests__/conversation/{RoundCard,DiagnosticRow,PendingCallFooter,CompactedCluster,ContextBlock}.test.ts`
- `web/src/__tests__/components/chat/tool-chip-adapter.test.ts`

**Modifies:**

- `web/src/components/chat/AnalystChatPanel.vue`: in-line
  `<button class="tool-chip">…</button>` block + `.pending-tool-*`
  block + scoped `.tool-chip*` / `.pending-tool-*` styles are
  DELETED; replaced with
  `<ToolChip v-bind="adaptChatMessageToToolChip(call, result, expandedSet.has(toolUseId))" @toggle="onToggle(toolUseId)" />`
  and the pending variant per design §1.3.14.
- `web/src/components/agents/AgentConversationView.vue`: F03's
  body rewrite (round/diagnostic/pending/compacted/context) and the
  deletion of `.tc-*` / `.tr-*` / `.conv-step` / `.conv-message`
  scoped styles. The agent surface from C5 onward consumes
  `<ToolChip>` (with raw `callContent` / `resultContent` from the
  `ToolPair` view-model — F03 r3 §7.3).
- `web/src/__tests__/analyst-chat-panel.test.ts`: selector
  migration `.tool-chip` → `[data-testid="tool-chip"]` and
  `data-status` (matrix in analysis §5.2 row for this file).

**Deletes:**

- The `<button class="tool-chip">…</button>` markup family inside
  `chat/AnalystChatPanel.vue` (analysis §4.10 `.tool-chip*` and
  `.pending-tool-*` rows).
- The `.tc-*` and `.tr-*` scoped style blocks in
  `agents/AgentConversationView.vue` (analysis §4.8 catch-all).

**Verification:**

```bash
test -f web/src/components/conversation/ToolChip.vue
test -f web/src/components/conversation/MessageBubble.vue
test -f web/src/components/conversation/ThinkingDots.vue
test -f web/src/components/chat/tool-chip-adapter.ts
test -f web/src/components/chat/analyst-timeline.ts
npx vue-tsc --noEmit
npm run lint
npm test -- --run "(conversation/(MessageBubble|ToolChip|ThinkingDots|RoundCard|DiagnosticRow|PendingCallFooter|CompactedCluster|ContextBlock)|components/chat/tool-chip-adapter|analyst-chat-panel)"
```

**Grep gates (post-commit):**

```bash
# Exactly ONE chip renderer at HEAD.
[ "$(rg -l '<ToolChip\b|class="tool-chip-toggle"' web/src/components/conversation/ToolChip.vue | wc -l)" -eq 1 ]
# No in-line .tool-chip* in any surface file.
! rg -n '\.tool-chip|\.pending-tool-(main|meta|tag)|\.tc-(header|toggle|tool|icon|name|headline|detail|time)|\.tr-' web/src --glob '!web/src/components/conversation/ToolChip.vue'
# Every chip call site uses v-bind with one of the two adapters or RoundCard's ToolPair view-model.
rg -n '<ToolChip\b' web/src --glob '*.vue' | rg -v 'v-bind="(adaptChatMessageToToolChip|adaptPendingInvocationToToolChip|toolChipPropsFor)' && { echo "Chip call site missing v-bind adapter"; exit 1; } || true
# ToolChip emits ONLY 'toggle'.
rg -n "defineEmits" web/src/components/conversation/ToolChip.vue | rg -v "toggle" && { echo "ToolChip emits leak"; exit 1; } || true
# ToolChip prop bag is the eight-prop signature.
rg -n "callContent:\s*string|resultContent:\s*string \| null" web/src/components/conversation/ToolChip.vue | wc -l | awk '$1 >= 2 {exit 0} {exit 1}'
# adapter returns the eight-prop bag (compile-time enforced by the test).
npm test -- --run components/chat/tool-chip-adapter
# AnalystChatPanel.vue no longer contains chip scoped CSS.
! rg -n '\.tool-chip|\.pending-tool-' web/src/components/chat/AnalystChatPanel.vue
# Selector migration in analyst-chat-panel.test.ts.
rg -n 'data-testid="tool-chip"' web/src/__tests__/analyst-chat-panel.test.ts
! rg -n "find\('\.tool-chip" web/src/__tests__/analyst-chat-panel.test.ts
```

### C6 — `auth/ApiTokenEntry.vue` rewrite on `Overlay` + `Button` + `AppShell.vue` keydown suppression

**Blocking 3 fix.** C6 is the first commit at which `<Overlay>`
becomes a real auth-dialog dependency, so the `data-modal-open`
shortcut-suppression contract (design §9.2) MUST land here, not in
C7. The AppShell global keydown handler is edited to short-circuit
on the body flag set by `Overlay.vue`'s `onOpen` / `onClose`
helpers (already shipped in C2 as part of `ui/Overlay.vue`).

**Adds:** updated SFC for `auth/ApiTokenEntry.vue`; no new tests
beyond rewrite of
[api-token-entry.test.ts](../../../../web/src/__tests__/api-token-entry.test.ts)
per analysis §5.2.

**Modifies:**

- `web/src/components/auth/ApiTokenEntry.vue` (full rewrite on
  `Overlay` + `Button`).
- `web/src/components/layout/AppShell.vue` — **only** the
  top-of-handler short-circuit:

  ```ts
  function handleKeydown(event: KeyboardEvent) {
    if (document.body.dataset.modalOpen === 'true') return;
    // existing logic
  }
  ```

  No other AppShell change in this commit; the auth-banner rewrite
  is C7.
- `web/src/components/nav/NavRail.vue` — only the `.api-token-btn`
  line (`<Button icon-only>`); the rest of NavRail is deferred to
  C15.
- `web/src/__tests__/api-token-entry.test.ts`.

**Deletes (same commit):** every selector in analysis §4.2
(`.token-overlay`, `.token-dialog`, `.token-btn*`, `.token-toggle`)
and the NavRail row `.api-token-btn` (rest of NavRail's classes are
deleted in C15).

**Verification:**

```bash
npx vue-tsc --noEmit
npm run lint
npm test -- --run "api-token-entry"
```

**Grep gates:**

```bash
! rg -n '\.token-(overlay|dialog|btn|toggle)' web/src
rg -n '<Overlay\b' web/src/components/auth/ApiTokenEntry.vue
rg -n 'data-testid="token-(save|clear|cancel|toggle)"' web/src/components/auth/ApiTokenEntry.vue
# AppShell's keydown handler short-circuits on document.body.dataset.modalOpen.
rg -n "document\.body\.dataset\.modalOpen|modalOpen" web/src/components/layout/AppShell.vue
rg -n "document\.body\.dataset\.modalOpen" web/src/components/ui/Overlay.vue
```

### C7 — `layout/AppShell.vue` auth banner + `layout/WorkspaceHeader.vue` chip cluster

**Scope (Blocking 3 fix):** this commit is now reduced to the
**auth-banner rewrite and the WorkspaceHeader chip cluster only**.
The AppShell keydown short-circuit already landed in C6 and is
NOT re-touched here.

**Modifies:**

- `web/src/components/layout/AppShell.vue` — auth-required banner
  now `<Card tone="danger" role="alert">` + `<Pill tone="danger">`
  + `<Button>` + icon-only dismiss `<Button>` per analysis §6.1.
  No edit to the keydown handler (already in C6).
- `web/src/components/layout/WorkspaceHeader.vue` — chip cluster
  now `<Pill>` + `<StatusDot>` siblings per analysis §4.3.
- `web/src/__tests__/app-shell-auth-banner.test.ts` and
  `web/src/__tests__/workspace-header.test.ts` — selector rewrites.

**Deletes:** every selector in analysis §4.1 + §4.3
(`.auth-required-banner`, `.auth-banner-action`, `.auth-banner-dismiss`,
`.ws-chip`, `.runtime-chip`, `.pause-chip`, `.chip-dot`).

**Verification + grep gates:**

```bash
npx vue-tsc --noEmit
npm run lint
npm test -- --run "(app-shell-auth-banner|workspace-header|app-shell-persistent-panel)"
! rg -n '\.auth-required-banner|\.auth-banner-(action|dismiss)|\.ws-chip|\.runtime-chip|\.pause-chip|\.chip-dot' web/src
rg -n 'data-testid="auth-required-banner"|data-testid="auth-banner-(action|dismiss)"' web/src/components/layout/AppShell.vue
rg -n 'data-testid="ws-chip"|data-testid="runtime-chip"|data-testid="pause-chip"' web/src/components/layout/WorkspaceHeader.vue
# Regression check: the C6 keydown short-circuit must still be present.
rg -n "document\.body\.dataset\.modalOpen" web/src/components/layout/AppShell.vue
# Layout-only survivors (.app-shell, .workspace-content) keep only display/grid/flex/gap/padding/position.
rg -n 'color:|background:|border-radius:|border:[^n]' web/src/components/layout/AppShell.vue && { echo "AppShell.vue carries non-layout properties"; exit 1; } || true
```

### C8 — `views/DashboardView.vue` rewrite

**Modifies:** `views/DashboardView.vue`, `dashboard-view.test.ts`,
`dashboard-child-order.test.ts`.

**Deletes:** every selector in analysis §4.5.

**Verification + grep gates:**

```bash
npx vue-tsc --noEmit
npm run lint
npm test -- --run "dashboard"
! rg -n '\.refresh-btn|\.runtime-banner|\.error-banner|\.actionable-(error|message|next|meta)|\.status-(loading|section|grid|item|key|value)|\.section-label|\.csb-|\.dc-(deps|item|priority|status|title|type)|\.cue-chip|\.detail-callout' web/src/views/DashboardView.vue
rg -n 'data-testid="dashboard-refresh"|data-testid="runtime-banner"|data-testid="actionable-error"' web/src/views/DashboardView.vue
```

### C9 — `views/FilesView.vue` rewrite

**Modifies:** `views/FilesView.vue`, `files-view.test.ts`.

**Deletes:** every selector in analysis §4.6.

**Verification + grep gates:**

```bash
npx vue-tsc --noEmit
npm run lint
npm test -- --run "files-view"
! rg -n '\.files-global-banner|\.viewer-state|\.viewer-close-btn|\.sv-fetch-btn' web/src/views/FilesView.vue
rg -n 'data-testid="files-global-banner"' web/src/views/FilesView.vue
```

### C10 — `views/DebugView.vue` rewrite

**Modifies:** `views/DebugView.vue` and all `debug-view*.test.ts`
files.

**Deletes:** every selector in analysis §4.7 (very large list:
`.debug-*`, `.dg-*`, `.operator-banner-*`, `.mcp-*`, `.sv-*`,
`.doctor-*`, `.check-*`, `.process-link-btn`).

**Verification + grep gates:**

```bash
npx vue-tsc --noEmit
npm run lint
npm test -- --run "debug-view"
! rg -n '\.debug-(tab|section|loading|error|empty)|\.dg-item|\.operator-banner|\.mcp-(server|tool|stats|stat)|\.sv-(stat|pill|review|q)|\.doctor-(status|check)|\.check-(passed|failed|icon|name|body|details)|\.process-link-btn' web/src/views/DebugView.vue
rg -n 'data-testid=' web/src/views/DebugView.vue | wc -l   # expect a substantial count (>= 20)
# tablist active-pill rule is exercised.
rg -n 'class="tablist"' web/src/views/DebugView.vue
```

### C11 — `components/agents/AgentConversationView.vue` non-round rewrite

C5 already landed the round bodies. C11 handles the toolbar, state
panels, header, and status badges per analysis §4.8.

**Modifies:** `agents/AgentConversationView.vue`,
`agents-view.test.ts`.

**Deletes:** the remaining selectors in analysis §4.8 (`.conv-tb-btn`,
`.conv-toolbar`, `.conv-header`, `.conv-model`, `.conv-role`,
`.conv-info`, `.conv-status-badge.*`, `.conv-empty`, `.conv-loading`,
`.conv-error`, `.conv-warning`, `.agents-empty`, `.agents-unauthorized`,
`.agents-stale`, `.agents-loading`, `.agents-error`, `.agents-warning`,
`.session-card`, `.detail-header-bar`, layout-only survivors).

**Verification + grep gates:**

```bash
npx vue-tsc --noEmit
npm run lint
npm test -- --run "agents-view"
! rg -n '\.conv-(tb-btn|toolbar|header|model|role|info|status-badge|empty|loading|error|warning)|\.agents-(empty|unauthorized|stale|loading|error|warning)|\.session-card|\.detail-header-bar' web/src/components/agents/AgentConversationView.vue web/src/views/AgentsView.vue
rg -n 'data-testid="conv-status"' web/src/components/agents/AgentConversationView.vue
```

### C12 — `components/agents/RawLlmExchangePanel.vue` rewrite

**Modifies:** `agents/RawLlmExchangePanel.vue`,
`raw-llm-exchange-panel.test.ts`.

**Deletes:** every selector in analysis §4.9 (`.rlp-*` family).

**Verification + grep gates:**

```bash
npx vue-tsc --noEmit
npm run lint
npm test -- --run "raw-llm-exchange-panel"
! rg -n '\.rlp-(refresh|tabs|tab|tab--active|status--error|error-box|redaction-banner)' web/src/components/agents/RawLlmExchangePanel.vue
rg -n 'data-testid="rlp-(refresh|tab|status|error-box|redaction-banner)"' web/src/components/agents/RawLlmExchangePanel.vue
```

### C13 — `components/chat/AnalystChatPanel.vue` non-chip rewrite

The chip swap already landed in C5. C13 rewrites the composer, the
message list, the header, the toaster, and every other surviving
bespoke selector per analysis §4.10 (MINUS the chip family, which
is already gone).

**Modifies:** `chat/AnalystChatPanel.vue`,
`chat/AnalystToaster.vue`, `analyst-chat-panel.test.ts` (only the
non-chip queries — chip selectors already migrated in C5),
`analyst-toaster.test.ts`.

**Deletes:** `.primary-btn`, `.message-bubble`, `.msg.role-*`,
`.msg-meta`, `.msg-content`, `.on-screen-children` (layout-only
survives), `.chat-body`, `.chat-composer`, `.composer-footer`,
`.composer-input`, `.analyst-toaster`, `.toast`, `.analyst-chip`
(per matrix; `.on-screen-children` keeps a layout-only declaration
because tests assert on it; the rest are renamed/deleted).

**Verification + grep gates:**

```bash
npx vue-tsc --noEmit
npm run lint
npm test -- --run "(analyst-chat-panel|analyst-toaster|AnalystChatPanel.children)"
# Chip family is STILL absent (regression check).
! rg -n '\.tool-chip|\.pending-tool-' web/src/components/chat
# Chat surface uses primitives only.
! rg -n '\.primary-btn|\.message-bubble|\.msg\.role-|\.msg-(meta|content)' web/src/components/chat/AnalystChatPanel.vue
rg -n 'data-testid="analyst-send"|data-testid="analyst-toaster"|data-testid="toast"|data-testid="analyst-chip"' web/src/components/chat
```

### C14 — `components/cards/*.vue` rewrites

**Modifies:** `cards/CardDetailView.vue`, `cards/CardsBoardView.vue`,
`cards/CardsLeaderboardView.vue`, `cards/CardsTreeView.vue`,
`cards/CardHistoryPanel.vue`, `cards/StaleWarningRibbon.vue`, plus
the tests `card-detail-view*.test.ts`, `cards-view.test.ts`,
`cards-tree-view-order.test.ts`, `card-history-panel*.test.ts`,
`stale-warning-ribbon.test.ts`.

**Deletes:** every selector in analysis §4.11.

**Verification + grep gates:**

```bash
npx vue-tsc --noEmit
npm run lint
npm test -- --run "(card-detail-view|cards-view|cards-tree|card-history|stale-warning)"
! rg -n '\.nav-pill|\.retry-btn|\.discuss-btn|\.detail-status-chip|\.detail-type-badge|\.badge\.(warning|error)|\.child-row|\.board-card|\.column-(header|title|dot|count|cards)|\.col-(metric|rank|score|title|type)|\.node-(title|children)|\.filter-chip|\.analyst-badge' web/src/components/cards
rg -n 'data-testid="(retry-btn|discuss-btn|filter-chip|analyst-badge|stale-warning-ribbon)"' web/src/components/cards
```

### C15 — `components/nav/NavRail.vue` rewrite

**Modifies:** `nav/NavRail.vue`, `nav-rail.test.ts`.

**Deletes:** every selector in analysis §4.4 (except `.nav-rail`
itself, which survives as a layout-only class). The
`.api-token-btn` row was already deleted in C6; this commit MUST
NOT re-introduce it.

**Verification + grep gates:**

```bash
npx vue-tsc --noEmit
npm run lint
npm test -- --run "nav-rail"
! rg -n '\.nav-rail-link\.active|\.api-token-btn' web/src/components/nav/NavRail.vue
rg -n 'data-testid="api-token-btn"' web/src/components/nav/NavRail.vue
# .nav-rail survives layout-only.
rg -n '\.nav-rail\b' web/src/components/nav/NavRail.vue
```

---

## 3. Validation (after every commit AND at the end of C15)

Every commit runs the per-commit gates in §2. After C15 the
following **full-suite gates** must also pass:

```bash
mkdir -p tmp

# (a) typecheck
npx vue-tsc --noEmit

# (b) lint (all five no-restricted-imports overrides exercised)
npm run lint

# (c) tests
npm test -- --run

# (d) production build
npm run build

# (e) no bespoke class assertions in surface tests
! rg -n "find\('\.[a-z]|findAll\('\.[a-z]|get\('\.[a-z]" web/src/__tests__/ \
    --glob '!web/src/__tests__/{ui,content,conversation}/**'

# (f) no scoped <style> declarations carry colour/background/border outside styles/.
#     Run one multi-line rg in PCRE mode (the only place this plan uses -P)
#     and write the report to the workspace-local tmp/ directory
#     (Blocking 2 fix — no /tmp).
rg -n -P --multiline -U \
   "<style[^>]*scoped[^>]*>[\s\S]*?(color:|background-color:|background:|border-color:|border-radius:|border:[^n])" \
   web/src --glob '*.vue' --glob '!web/src/styles/**' \
   > tmp/f02-style-leaks.txt || true
# Any non-empty output is a violation EXCEPT for explicit allow-listed primitives whose scoped style is
# pure layout (Button's .btn-icon padding; etc.). Manual review of tmp/f02-style-leaks.txt; expected:
# zero hits in surface files (views/*, components/agents/*, components/chat/*, components/cards/*, components/layout/*).

# (g) exactly one ToolChip renderer at HEAD
[ "$(rg -l --type-add 'vue:*.vue' -tvue 'data-testid="tool-chip"' web/src | wc -l)" = "1" ]
rg -l --type-add 'vue:*.vue' -tvue 'data-testid="tool-chip"' web/src   # must print conversation/ToolChip.vue only

# (h) no barrel index.ts under components/ui|content|conversation
test ! -e web/src/components/ui/index.ts
test ! -e web/src/components/content/index.ts
test ! -e web/src/components/conversation/index.ts

# (i) the single-file tool-presenters.ts is gone; the directory is canonical
#     and the canonical F05 r3 §3.4 sideEffects array is in place
#     (Blocking 1 regression check).
test ! -f web/src/utils/tool-presenters.ts
test -f web/src/utils/tool-presenters/index.ts
node -e '
  const pkg = JSON.parse(require("fs").readFileSync("web/package.json","utf8"));
  const se = pkg.sideEffects;
  if (!Array.isArray(se)) { console.error("sideEffects must be an array"); process.exit(1); }
  const required = ["src/utils/tool-presenters/**/*.ts", "*.css"];
  for (const r of required) {
    if (!se.includes(r)) { console.error("missing sideEffects entry:", r); process.exit(1); }
  }
'

# (j) `web:no-bespoke-class-assertions` CI gate
rg -n "find\('\.[a-z]" web/src/__tests__/ \
    --glob '!web/src/__tests__/ui/**' \
    --glob '!web/src/__tests__/content/**' \
    --glob '!web/src/__tests__/conversation/**' \
    && { echo "Bespoke class assertion leaked into a surface test"; exit 1; } || true

# (k) `data-modal-open` shortcut suppression is single-sourced.
#     Overlay.vue sets the flag (C2). AppShell.vue reads it (C6).
#     No third reader at HEAD.
[ "$(rg -l 'document\.body\.dataset\.modalOpen' web/src | wc -l)" -le 2 ]
rg -n 'document\.body\.dataset\.modalOpen' web/src/components/ui/Overlay.vue
rg -n 'document\.body\.dataset\.modalOpen' web/src/components/layout/AppShell.vue
```

Saivage v3 deployment validation (runs after the branch is built
and pushed): per the workspace skill
`saivage-development-validation`, restart
`saivage-v3-getrich-v2` (the v3 deployment), curl `/health`, hit
each rewritten surface in the browser via the integrated browser
tool and confirm:

- `<Card tone="danger">` banners render with the danger entry-bg.
- Auth overlay traps focus and returns it on close.
- ToolChip on the analyst panel expands and renders
  `<FormattedContent>` for the call (always) and the result (when
  present).
- Debug-view tabs reflect `aria-pressed` correctly.
- Files-view banners render via `<Card>` not `.files-global-banner`.

The Saivage v3 deployment validation step is OUT OF SCOPE of this
plan's CI gates — it is a manual smoke step recorded in the PR
description per skill
`/home/salva/g/ml/.github/skills/saivage-development-validation/SKILL.md`.

---

## 4. Rollback

**Project guideline restated:** ARCHITECTURE-FIRST, NO BACKWARD
COMPATIBILITY. The **default rollback strategy is `git revert` of
the offending commit(s)** — not feature flags, not aliasing back to
the deleted selectors, never a partial alias-period rollback.

**Blocking 4 fix — dependency-aware ordering.** Several commits in
the 15-commit sequence share files; reverting an earlier overlapping
commit after a later surface rewrite has landed will conflict, or
worse, restore stale selectors into a post-migration file. The
table below makes the dependency order explicit. The rule is:
**if any commit in the "revert-first" column has landed, revert it
(or them, in the order shown) before reverting the target commit.**
After the reverts the working tree is consistent; the team then
re-lands fixed commits forward — no aliases, no shims.

| Commit | Shared file(s) with later commits | Revert-first column (must be reverted before this one if landed) | Rollback shape |
| --- | --- | --- | --- |
| C1 | — | — | `git revert` is safe; only the new SFC, its test, and one ESLint block are affected. |
| C2 | `web/src/styles/patterns.css` (if F01 absorption is deferred) | — | `git revert` is safe; SFCs and tests are additive. If the F02 r2 extension rules were appended to `patterns.css` in this commit, the revert removes them — C8/C10/C14 will then fail their visual checks if they were ever merged ahead. Recovery: re-land C2 with the F01 extensions before re-landing C8/C10/C14. |
| C3 | — | — | `git revert` re-creates `components/code/` but the consumer imports were updated in the same commit, so the revert restores them too. Safe. |
| **C4** | `web/src/utils/tool-presenters/**`, `web/package.json` | **C5** (consumes the directory barrel via `ToolChip.vue` and the adapter) | `git revert` restores `web/src/utils/tool-presenters.ts` (single file), removes the directory, and removes the `sideEffects` entry. The new content/ SFCs (`JsonView`, `FormattedContent`, `InlineParts`) and `json-tokenize.ts` revert in the same operation. **If C5 has landed, revert C5 first** — otherwise the chip's eight-prop API loses its `ToolCallPresentation` / `ToolResultPresentation` type imports and vue-tsc breaks at HEAD. |
| **C5** | `chat/AnalystChatPanel.vue` (with C13); `agents/AgentConversationView.vue` (with C11); `analyst-chat-panel.test.ts` (with C13) | **C11** (AgentConversationView non-round rewrite); **C13** (AnalystChatPanel non-chip rewrite). Revert order if both landed: C13 → C11 → C5. | `git revert` restores in-line `.tool-chip*` in `AnalystChatPanel.vue` and removes the new `conversation/*` SFCs + the adapter + the pairing utility. Selector-migration tests revert with them. Because C5 is the cross-batch boundary co-owned with the F03 PR, the revert MUST be coordinated with F03's owner. **If C11 has landed**, reverting C5 first would re-introduce `.tc-*` / `.tr-*` blocks into AgentConversationView that C11 deleted — the file would not compile against the partly-reverted structure; revert C11 first. **If C13 has landed**, reverting C5 first would re-introduce the in-line chip markup into a file whose composer/header/toaster were already rewritten on primitives — revert C13 first. |
| **C6** | `web/src/components/layout/AppShell.vue` keydown short-circuit (with C7); `web/src/components/nav/NavRail.vue` `.api-token-btn` line (with C15) | **C7** (AppShell auth-banner rewrite touches the same file); **C15** (NavRail full rewrite). Revert order if both landed: C15 → C7 → C6. | `git revert` restores `.token-*` selectors, removes the AppShell keydown short-circuit, and restores the NavRail `.api-token-btn` line. **If C7 has landed**, reverting C6 first would leave AppShell with a rewritten auth-banner but no keydown short-circuit — global shortcuts would fire while the (deleted) overlay was open. Revert C7 first. **If C15 has landed**, reverting C6 first would conflict on NavRail; revert C15 first. The full-suite gate (k) (`<= 2` readers of `data-modal-open`) is the regression detector. |
| **C7** | `web/src/components/layout/AppShell.vue` auth-banner markup (with C6's keydown edit); `WorkspaceHeader.vue` (no later overlap) | **none in the forward sequence** — C7 is the last to touch AppShell's auth banner. | `git revert` restores `.auth-required-banner` / `.auth-banner-*` selectors and the WorkspaceHeader chip cluster. The C6 keydown short-circuit is NOT touched (different lines). Safe in isolation. |
| C8 | `views/DashboardView.vue` (no later overlap) | — | `git revert` is safe; bounded to one view + its tests. |
| C9 | `views/FilesView.vue` (no later overlap) | — | `git revert` is safe. |
| C10 | `views/DebugView.vue` (no later overlap) | — | `git revert` is safe. |
| **C11** | `agents/AgentConversationView.vue` (with C5) | — (forward direction); see C5 row for the reverse | `git revert` is safe in isolation — restores the toolbar/state-panel selectors. The shared-file overlap is on the C5-side dependency, not the C11-side. |
| C12 | `agents/RawLlmExchangePanel.vue` (no later overlap) | — | `git revert` is safe. |
| **C13** | `chat/AnalystChatPanel.vue` (with C5); `analyst-chat-panel.test.ts` (with C5) | — (forward direction); see C5 row for the reverse | `git revert` is safe in isolation — restores the composer/header/toaster selectors and the non-chip test queries. The shared-file overlap is on the C5-side dependency. |
| C14 | `components/cards/*.vue` (no later overlap) | — | `git revert` is safe. |
| **C15** | `nav/NavRail.vue` (with C6) | — (forward direction); see C6 row for the reverse | `git revert` is safe in isolation — restores the rest of NavRail's selectors. The shared-file overlap is on the C6-side dependency. |

**No partial rollback (alias period) is permitted in any of the
chains above.** If a commit must be rolled back, every dependent
commit downstream is rolled back atomically per the order shown,
and re-landed forward later. The deleted selectors come back with
the revert; consumer surface tests pass against the restored
selectors after the dependent commits are also reverted.

Recovery procedure (after any revert chain):

1. `git revert <newest-sha>` first, then walk backwards through
   the chain (`git revert <next-sha>` …), or for a chain of N
   commits use `git revert <newest-sha>..<oldest-sha>` (mind the
   non-merge boundary; if the chain crossed a merge use
   `git revert -m 1 <merge-sha>`).
2. Push the revert branch, open a PR, get one approving review.
3. Re-land each commit with the fix in new SHAs, in the original
   forward order (C1 → … → C15).

---

## 5. Risks (with mitigations)

| # | Risk | Likelihood | Mitigation |
| --- | --- | --- | --- |
| R1 | F01 r2 has not yet absorbed the F02 extension list (analysis §2.2). | Medium | C2 lands the extensions in `patterns.css` inline (default path). Q1 review of this plan resolves whether they migrate to F01 r2 in a follow-up. |
| R2 | C5 grows large (3 SFCs + 5 F03 composites + adapter + pairing util + surface swap + 2 tests + selector migration). | High | Mitigated by the cross-batch coordination contract (design §1.6). The C5 commit is allowed to land as a single squashed commit on a feature branch; PR review focuses on the cross-batch ordering invariants (one chip renderer, one prop bag). If the diff is unwieldy, an internal split into "primitive add" + "swap" sub-commits on the same PR branch is acceptable as long as the green-commit-by-commit invariant holds. |
| R3 | `vue-tsc` could regress between C4 (when the barrel ships) and C5 (when ToolChip consumes it) if the F05 batch imports drift. | Medium | C4's grep gates assert `barrel-integrity.test.ts` passes and the directory is the only resolution path. C5 imports the eight-prop types from the F05 r3 directory barrel by the canonical path. If C5 fails typecheck, the failure is contained inside the F03 PR branch — it does not contaminate `main`. |
| R4 | Overlay focus-trap regressions when nested with portal'd menus (e.g. dropdown inside `ApiTokenEntry`). | Low | Overlay test contract in design §5.4 enumerates seven cases. Q3 (closed) confirmed; fallback to `radix-vue` `<Dialog>` recorded in analysis §8.3. |
| R5 | The `web:no-bespoke-class-assertions` CI gate (`rg -n "find\('\..*` outside the three primitive test folders) could over-flag legitimate surface tests that query `.code-block` (a pattern class). | Low | The gate's exclusion list (the three primitive test folders) catches the pattern-class assertions. Pattern-class selectors that survive (per analysis §4.13) are by definition layout-only and tests do NOT assert on them. |
| R6 | Removing `web/src/utils/tool-presenters.ts` (the single file) in C4 could break any consumer importing it directly via the `.ts` suffix. | Low | `barrel-integrity.test.ts` enforces directory-only resolution; the grep gate `! rg -n "utils/tool-presenters\.ts"` runs in C4. The existing v3 codebase has exactly one such file; after C4 it is gone. |
| R7 | The auth-shortcut suppression flag (`data-modal-open`) could be left set if Overlay crashes mid-open. | Low | Overlay's `onMounted`/`onUnmounted` symmetrically increment/decrement the module-level counter (design §9.3). Vitest covers crash-on-open by simulating the watch-side error path. The full-suite gate (k) caps readers of the flag at 2 (Overlay + AppShell) and asserts both files reference it. |
| R8 | Saivage v3 deployment regression because of CSS-only differences not covered by Vitest. | Medium | Manual smoke validation (workspace skill `saivage-development-validation`) covers the rewritten surfaces. The plan's PR description must include the validation transcript. |
| R9 | A re-export shim sneaks back in during code review pressure (reviewer "this breaks one consumer, please add a shim"). | Low | Project guideline is binding; the plan reviewer enforces it. If a consumer genuinely cannot be migrated in-scope, the correct response is to split the commit (e.g. delete the selector only after the consumer migration), not to add a shim. |
| R10 | Selector-migration tests in C5 fail because `analyst-chat-panel.test.ts` queries a chip header detail that the new `<ToolChip>` does not surface. | Medium | The test rewrite asserts `[data-testid="tool-chip"]` + `data-status`; chip-internal details (headline text, detail pill text) are asserted by `ToolChip.test.ts` and `tool-chip-adapter.test.ts`. The analyst surface test only checks chip presence + status. |
| R11 | The `tablist > .pill[aria-pressed="true"]` pattern rule (design §1.2 table, last-row F01 extension) collides with future ARIA toggle-button uses outside a `.tablist` wrapper. | Low | The selector is scoped under `.tablist`, so isolated `<Pill :aria-pressed>` outside a `tablist` keeps its default border. Q2 (design §8) tracks whether to switch to a `.pill-pressed` modifier instead. |
| **R12 (r2)** | C4's exact `web/package.json` `sideEffects` edit conflicts with a base-branch addition (e.g. an existing CSS side-effect entry the v3 build already depends on). | Low–Medium | The C4 edit MUST preserve every pre-existing entry and add `src/utils/tool-presenters/**/*.ts` alongside; the Node-based verification block in §2 C4 / §3 (i) asserts presence (not equality), so an extra entry beyond the required two is tolerated. If a pre-existing entry uses the legacy `./web/...` prefix, treat that as a base-branch bug and fix it in a precursor commit before C4. |
| **R13 (r2)** | The portable C4 grep gate could over-flag a future legitimate import shape the rule does not anticipate (e.g. `from '#utils/tool-presenters'` via a TS-paths alias). | Low | Add a fourth allowed shape line (`-e "utils/tool-presenters['\"];?$"` already matches the trailing-semicolon and EOL cases) when such an alias is introduced. The current rule covers `'../../utils/tool-presenters'`, `'../../../utils/tool-presenters'`, and the `@/utils/tool-presenters` alias; per-tool deep imports remain forbidden by construction. |

---

## 6. Out of scope (carry-overs to other batches)

The following work is **explicitly NOT in this plan**; each item
has a named owner in the cross-issue graph:

1. The `tokenizeJson` utility extraction and the F05 r3 §3
   `tool-presenters/` directory creation are F05-owned. They ship
   *inside* C4 of this plan because the deletion of the single-file
   presenter is co-committed with the directory creation, but
   ownership stays with F05 and reviewer attention for those files
   sits with F05.
2. The F03 round bodies (`RoundCard`, `DiagnosticRow`,
   `PendingCallFooter`, `CompactedCluster`, `ContextBlock`),
   timeline pairing utility (`analyst-timeline.ts`), and the
   `analyst-chat-panel.test.ts` selector migration are F03-owned;
   they ship in C5 of this plan (the F03 PR).
3. F04's chat surface decomposition (`ChatHeader`, `MessageList`,
   `MessageItem`, `ChatComposer`, `JumpToLatest`) ships AFTER C15.
   F04 only relocates the `v-bind="adapt…"` call site from
   `AnalystChatPanel.vue` (post-C5) into the decomposed
   `MessageItem.vue`. The shared `ToolChip` already exists; F04
   does not modify it.
4. F01 r2's absorption of the F02 extension rules listed in
   analysis §2.2 (status-dot tones, card tones, pill-purple,
   tablist active-pill rule). Default in this plan: C2 lands them
   inline. Q1 reviewer chooses migration cadence.
5. Form-control primitives (input, textarea, select) — explicitly
   excluded per analysis §6.7.
6. Headless-UI library adoption (radix-vue / reka-ui /
   @headlessui/vue) — explicitly rejected per analysis §8.3.
7. Storybook / Histoire / Chromatic visual-diff tooling — rejected
   per design §1.8.
8. Pinia store / Vue Router / WebSocket changes — F02 is
   presentation-only.

Out-of-scope items are tracked in the cross-issue graph; this plan
does not block on them except where C4/C5 land their dependencies.

---

## 7. Commit-by-commit checklist (operator quick reference)

```
[ ] C1  ui/Button.vue + ESLint block 1                       (additive)
[ ] C2  ui/{Pill,Card,PanelHeading,StatusDot,Spinner,Overlay} + F01 extensions + ESLint blocks 2-5
[ ] C3  content/{CodeBlock,MarkdownText}.vue moves; delete components/code/
[ ] C4  utils/tool-presenters/ directory + content/{JsonView,FormattedContent,InlineParts} + json-tokenize; delete utils/tool-presenters.ts; web/package.json sideEffects ["src/utils/tool-presenters/**/*.ts", "*.css"]
[ ] C5  conversation/{MessageBubble,ThinkingDots,ToolChip,RoundCard,DiagnosticRow,PendingCallFooter,CompactedCluster,ContextBlock} + chat/{tool-chip-adapter,analyst-timeline} + AnalystChatPanel chip swap + selector migration in analyst-chat-panel.test.ts  (F03 PR boundary)
[ ] C6  auth/ApiTokenEntry.vue rewrite on Overlay + Button + AppShell.vue keydown short-circuit + NavRail .api-token-btn line
[ ] C7  layout/AppShell.vue auth banner + layout/WorkspaceHeader.vue chip cluster (NO change to AppShell keydown handler — already in C6)
[ ] C8  views/DashboardView.vue rewrite
[ ] C9  views/FilesView.vue rewrite
[ ] C10 views/DebugView.vue rewrite
[ ] C11 agents/AgentConversationView.vue non-round rewrite
[ ] C12 agents/RawLlmExchangePanel.vue rewrite
[ ] C13 chat/AnalystChatPanel.vue non-chip rewrite + chat/AnalystToaster.vue
[ ] C14 cards/{CardDetailView,CardsBoardView,CardsLeaderboardView,CardsTreeView,CardHistoryPanel,StaleWarningRibbon}.vue rewrites
[ ] C15 nav/NavRail.vue rewrite + final full-suite validation
```

After C15: open PR, attach the §3 validation transcript and the
Saivage v3 deployment smoke transcript. The reviewer's job is the
§3 full-suite gates; the ARCHITECTURE-FIRST guideline is the
non-negotiable acceptance criterion.
