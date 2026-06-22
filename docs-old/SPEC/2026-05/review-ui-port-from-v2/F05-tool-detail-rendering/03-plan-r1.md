# F05 — Tool detail rendering: Implementation plan (R1)

Writer round 1. Implements the **approved** F05 design
([02-design-r3.md](02-design-r3.md), gated by
[DESIGN-APPROVED.md](DESIGN-APPROVED.md)) against the approved
analysis ([01-analysis-r2.md](01-analysis-r2.md) /
[ANALYSIS-APPROVED.md](ANALYSIS-APPROVED.md)).

Companion approved designs (binding, consumed verbatim):
[F02 r3 design](../F02-component-hierarchy/02-design-r3.md),
[F03 r3 design](../F03-conversation-rounds/02-design-r3.md),
[F04 r2 design](../F04-chat-surface-style/02-design-r2.md).

**Project rule (binding): architecture-first, NO backward
compatibility.** No alias subsystem, no `string | InlinePart[]`
shim, no `FormattedToolPair`, no `root: 'project'`, no parallel
public surface, no transitional `callContentRaw` /
`resultContentRaw` field names, no re-export module. Every
replaced helper / type / template / route field is removed in the
same commit that introduces its replacement.

Verified source paths (relative to this file):
[../../../../web/src/utils/tool-presenters.ts](../../../../web/src/utils/tool-presenters.ts),
[../../../../web/src/utils/](../../../../web/src/utils/),
[../../../../web/src/views/FilesView.vue](../../../../web/src/views/FilesView.vue),
[../../../../web/src/stores/files.ts](../../../../web/src/stores/files.ts),
[../../../../web/src/components/agents/AgentConversationView.vue](../../../../web/src/components/agents/AgentConversationView.vue),
[../../../../web/src/components/chat/AnalystChatPanel.vue](../../../../web/src/components/chat/AnalystChatPanel.vue),
[../../../../web/src/__tests__/tool-presenters.test.ts](../../../../web/src/__tests__/tool-presenters.test.ts),
[../../../../web/package.json](../../../../web/package.json).

---

## 0. Scope and boundaries

In scope (F05 owns):

- The `web/src/utils/tool-presenters/` registry directory, its
  barrel, the per-tool files, the shared factories in
  `helpers.ts`, the registry contract, and the `sideEffects`
  manifest entry.
- The `InlinePart` union, `InlineParts.vue`, `JsonView.vue`,
  `FormattedContent.vue`, and the `json-tokenize.ts` utility.
- The `?root=meta|output&path=…` query-handling rewrite in
  `FilesView.vue` (the watcher + `applyQueryPath`).
- The deletion of the single-file
  `web/src/utils/tool-presenters.ts` and the deletion of the
  string-headline shape from production code and tests.
- The ESLint `no-restricted-imports` rule that locks down the
  barrel as the only public entrypoint.
- The presenter-side changes in `AgentConversationView.vue` and
  `AnalystChatPanel.vue` that adapt to the new
  `InlinePart[]`-shaped presentations and to chip-rendering
  through `<ToolChip>`. **The shared `ToolChip.vue` file itself,
  the F03 round-card refactor, and the analyst surface's
  AnalystChatPanel → MessageList chip-swap belong to F03 / F04.**
  F05 contributes the chip's `defineProps` block and the
  `<InlineParts>` / `<FormattedContent>` usage inside it as a
  binding contract (§4 of [02-design-r3.md](02-design-r3.md));
  the file lives in `web/src/components/conversation/ToolChip.vue`
  per F03 r3 §7.2.

Out of scope (carried by sibling issues):

- F02 r3 owns the `content/` folder relocation (move
  `CodeBlock.vue`, `MarkdownText.vue` from `components/code/` to
  `components/content/`) and the analyst `.tool-chip*` CSS
  deletion as part of its commit C4 / C5 (see
  [F02 r3 §1.4 deletion matrix](../F02-component-hierarchy/02-design-r3.md#14-deletion-matrix-commit-bound)).
- F03 r3 owns the `<ToolChip>` Vue template body (head row,
  expand toggle, expanded body), the `RoundCard` integration,
  and the `toolChipPropsFor(pair)` helper. F05 only fixes the
  prop-bag contract (eight props) and the children it mounts.
- F04 r2 owns `chat/tool-chip-adapter.ts`
  (`adaptChatMessageToToolChip`,
  `adaptPendingInvocationToToolChip`) and the chip-swap inside
  `MessageList.vue`.

Out of scope for F05 entirely (carried forward as future issues):

- Backend `root: 'project'` file API and store.
- Richer markdown rendering in `MarkdownText.vue`.
- Replacement of `highlight.js` in `CodeBlock.vue`.
- Streaming-aware JSON tokeniser.
- Custom expand bodies per `ToolPresenter` (e.g. `diff_card`).

---

## 1. Coordination with sibling implementation plans

| Sibling | F05 dependency | Coordination rule |
| ------- | -------------- | ----------------- |
| F02 r3 commit C4 (deletes `web/src/utils/tool-presenters.ts`, creates the directory layout) | C4 of F02 = C2 of F05 (this plan). Same physical commit. | F02 r3 §1.4 binds C4's deletion to F05's directory introduction. F05's commit C2 (§3.2 below) **is** F02's C4 — the work is co-committed. |
| F02 r3 commits that relocate `CodeBlock`, `MarkdownText` into `content/` and add `content/InlineParts.vue` to the file layout | F05 places `JsonView.vue`, `FormattedContent.vue`, `InlineParts.vue` under `web/src/components/content/` (§4 of design). | F05 commits assume the `content/` folder already exists (created by F02 r3 ahead of F05's commits, or co-committed). If F05 lands first, F05's commit C4 (§3.4 below) creates `content/` and F02 r3 relocates into it. The metaplan (sibling) sequences this. |
| F03 r3 commit that ships `web/src/components/conversation/ToolChip.vue` | F05's chip-rendering contract (eight-prop bag) is consumed by F03's ToolChip implementation. F05's commit C8 (§3.8) updates consumers; F03's PR ships the chip file. | If the F03 commit lands first, F05 C8 simply consumes it. If F05 lands first, F05 creates a minimal `conversation/ToolChip.vue` whose `<script setup>` exposes the eight-prop signature and whose template is the §4.1 markup from design r3 — F03 then layers `<Card>` styling, `ToolPairStatus` tone mapping, and `timestamp` rendering on top. Either order is safe because the prop bag is fixed. |
| F04 r2 commit that ships `chat/tool-chip-adapter.ts` | F05's `presentToolCall` / `presentToolResult` are consumed by the adapter. | Order-independent: the presenter exports are stable from F05 C3 onward (§3.3). |

Within F05 itself, the commits below are ordered so that every
intermediate state still typechecks and tests still pass — no
"green at the end" big-bang flips.

---

## 2. Public-contract preconditions (verified against design r3)

The following are taken as binding from
[02-design-r3.md](02-design-r3.md) and re-stated here so the
implementer can typecheck against this plan alone:

1. **Public types** (`web/src/utils/tool-presenters/types.ts`):
   - `InlinePart` four-arm union (`text` / `file` / `url` /
     `code`); `file.root: 'meta' | 'output'`; `text.tone?: 'ok' |
     'warn' | 'danger' | 'muted'`.
   - `ToolStatus = 'call' | 'ok' | 'error'`.
   - `ToolCallPresentation = { icon; name; headline: InlinePart[]; detail: InlinePart[]; status: 'call' }`.
   - `ToolResultPresentation = { icon; name; headline: InlinePart[]; detail: InlinePart[]; status: 'ok' | 'error' }`.
2. **Public functions** (`web/src/utils/tool-presenters/registry.ts`,
   re-exported from `index.ts`):
   - `presentToolCall(rawContent: string, fallbackName?: string): ToolCallPresentation`.
   - `presentToolResult(rawContent: string, ctx?: { tool?: string; kind?: 'tool_result' | 'tool_error' }): ToolResultPresentation`.
3. **Internal types** (`types.ts`, not re-exported from the
   barrel):
   - `CallContext`, `ResultContext`, `ToolCallPresenter`,
     `ToolResultPresenter`, `ToolPresenter`.
4. **Internal registrations** (`registry.ts`, not re-exported):
   - `registerToolPresenter(name, presenter): void` — throws on
     duplicate.
   - `registerDefaultPresenter(presenter): void` — throws if
     called twice.
   - `_registryKeysForTest`,
     `_internalRegistryEntriesForTest` — underscore-prefixed,
     ESLint-gated to `__tests__/`.
5. **Canonical import paths**:
   - Production / app code: `'../../utils/tool-presenters'`
     (resolves to `index.ts` in the directory).
   - Tests: same barrel, plus
     `'../../utils/tool-presenters/registry'` strictly for
     `_*ForTest` helpers (registry.test.ts, coverage.test.ts).
6. **Chip prop bag** (eight props verbatim, owned by F05 r3 §4.1):
   `call`, `result`, `callContent`, `resultContent`, `status`,
   `expanded`, `detailsId`, `timestamp?`.
7. **Expected tool names** for the coverage test: see §3.6 of
   design r3.
8. **FilesView route schema**: `?path=<string>&root=meta|output`;
   `applyQueryPath` ignores any other shape. The watcher tracks
   both keys.

---

## 3. Commit plan

Commits are ordered by dependency. Each commit is intended to
keep the tree green (`npm run typecheck && npm run test`) on its
own, except where explicitly noted. Commit messages use the
`F05: <subject>` convention from
[iterative-dual-llm-review/SKILL.md](../../../../.github/skills/iterative-dual-llm-review/SKILL.md).
A commit's "files touched" list is exhaustive; if a file is not
listed it is not edited in that commit.

### 3.1 Commit C1 — `F05: extract json-tokenize utility`

Goal: extract the JSON tokeniser as a pure, independently testable
module so later commits can compose it into `JsonView.vue`. This
commit lands no UI changes and is independent of the registry
work.

Files created:

- `web/src/utils/json-tokenize.ts` — byte-equivalent port of v2's
  `tokenize` from
  [`../../../../../saivage/web/src/components/JsonHighlight.vue`](../../../../../saivage/web/src/components/JsonHighlight.vue);
  exports `Token` (nine-arm union) and `tokenizeJson(text: string): Token[]`.
  Algorithm: stack of `{`/`[`; `expectKey` set on `{`, cleared on
  `[`, re-set on `,` only when stack top is `{`; strings consume
  escape sequences (`\\` + next char); numbers consume
  `[-0-9.eE+\-]`. Pure function, no side effects.
- `web/src/__tests__/json-tokenize.test.ts` — 12 cases from
  design r3 §6.1 (object keys, array values, escaped quotes,
  backslash escapes, negative / exponent numbers, `true` /
  `false` / `null` kinds, punctuation, whitespace preservation,
  unterminated-string defence).

Validation: `npm run typecheck && npx vitest run web/src/__tests__/json-tokenize.test.ts`.

### 3.2 Commit C2 — `F05: introduce tool-presenters/ directory, registry, types, helpers; delete tool-presenters.ts`

This is the architectural pivot. It deletes the single-file
presenter module and replaces it with the directory layout from
design r3 §3.3, but with the per-tool files **stubbed** so the
diff stays reviewable; per-tool bodies arrive in C3.

Files created:

- `web/src/utils/tool-presenters/types.ts` — public types
  (§1.2 of design r3) and internal presenter interfaces (§3.1).
- `web/src/utils/tool-presenters/helpers.ts` — pure helpers
  (`asRecord`, `oneLine`, `shortPath`, `formatBytes`, `argKeys`,
  `readToolCallEnvelope`, `resolveResultName`, `safeJsonParse`,
  `str`) plus the factory functions (`makeReadFilePresenter`,
  `makeListDirectoryPresenter`, `makeRunCommandPresenter`,
  `makeCardOutcomePresenter`, `makeJsonlTailPresenter`,
  `makeRuntimeControlPresenter`, `makeGoalControlPresenter`,
  `makeGoalReportPresenter`). Bodies are direct ports of the
  matching blocks in
  [`../../../../web/src/utils/tool-presenters.ts`](../../../../web/src/utils/tool-presenters.ts),
  refactored to return `InlinePart[]` per §3.2 / §3.5 of design r3.
- `web/src/utils/tool-presenters/registry.ts` — verbatim §3.1 of
  design r3 (`REGISTRY`, `DEFAULT_PRESENTER`,
  `registerToolPresenter`, `registerDefaultPresenter`,
  `_registryKeysForTest`, `_internalRegistryEntriesForTest`,
  `presentToolCall`, `presentToolResult`).
- `web/src/utils/tool-presenters/__default__.ts` — fallback
  presenter (`makeDefaultPresenter` private to this file) plus
  one `registerDefaultPresenter(...)` call. Behaviour per the
  `__default__` row in design r3 §3.5.
- `web/src/utils/tool-presenters/index.ts` — bare-statement
  barrel listing every per-tool file (§3.4 of design r3, full
  block reproduced verbatim) terminated by
  `import './__default__';`. Re-exports `presentToolCall`,
  `presentToolResult` from `./registry` and the four public
  types from `./types`.
- One empty stub file per tool name in §3.6 of design r3 — each
  file contains a single line: `// stub — body lands in C3`.
  Forty-five stub files in total. (No registration yet; the
  barrel imports them so the import paths resolve.)

Files modified:

- `web/package.json` — add a top-level `"sideEffects"` array
  exactly as design r3 §3.4 paragraph 3:

  ```json
  {
    "sideEffects": [
      "src/utils/tool-presenters/**/*.ts",
      "*.css"
    ]
  }
  ```

  Placed between `"private": true` and `"engines"` to keep the
  manifest readable.

Files deleted:

- `web/src/utils/tool-presenters.ts`.

Files modified (consumers, defensive minimum to keep the tree
typechecking — full migration lands in C8):

- `web/src/components/agents/AgentConversationView.vue` — adjust
  imports of `presentToolCall` / `presentToolResult` /
  `ToolCallPresentation` / `ToolResultPresentation` so the
  resolution path is the new directory (Vite / TS infer
  `index.ts` from `'../../utils/tool-presenters'`; no source
  change should be needed if the import string is already
  `'../../utils/tool-presenters'`). If any test or component
  currently imports from `'../../utils/tool-presenters.ts'`
  with the explicit `.ts`, rewrite to `'../../utils/tool-presenters'`.
- `web/src/components/chat/AnalystChatPanel.vue` — same minor
  import-string normalisation if needed.
- `web/src/__tests__/tool-presenters.test.ts` — temporarily
  **skip** every assertion that depends on string headlines:
  rename `describe(...)` to `describe.skip(...)`. The file is
  rewritten and unskipped in C7. Keep the file (no churn) so
  diffs read clean.

Reasoning for stubs: the design r3 §3.6 `EXPECTED_TOOL_NAMES`
list mandates a per-tool file per name. Splitting registration
bodies out of C2 keeps the diff for the new architecture small
and reviewable; C3 fills in the bodies. The stubs are sufficient
to keep the barrel import-resolvable but they intentionally do
NOT call `registerToolPresenter`, so the coverage test (C7)
must come after C3.

Validation between C2 and C3 (interim state): `npm run
typecheck` is the only requirement; the runtime would fail at
the first `presentToolCall` call because the default registers
but no tool registers. C3 fixes that. The CI must therefore be
run on the merge of C2..C7 (the natural PR slice), not on C2 in
isolation. The plan acknowledges this and notes it in the PR
description (§5 below).

### 3.3 Commit C3 — `F05: per-tool presenter registrations (45 files + __default__)`

Goal: fill every per-tool stub file with one
`registerToolPresenter(name, ...)` call. After C3 the runtime is
functional under the new architecture; the only thing missing is
the InlinePart-aware UI (lands C4–C8).

Files modified (45 per-tool files; bodies per design r3 §3.3,
§3.5, plus the factory sites in §3.2):

| File | Body |
| ---- | ---- |
| `read_project_file.ts` | `registerToolPresenter('read_project_file', makeReadFilePresenter())` |
| `read_file.ts` | `registerToolPresenter('read_file', makeReadFilePresenter())` |
| `list_project_files.ts` | `registerToolPresenter('list_project_files', makeListDirectoryPresenter())` |
| `list_directory.ts` | `registerToolPresenter('list_directory', makeListDirectoryPresenter())` |
| `write_project_file.ts` | own-file implementation; icon `✏️`; call emits `[path]` + `[N chars]` detail; result emits `[wrote B]` or `[wrote file]` |
| `run_project_command.ts` | `registerToolPresenter('run_project_command', makeRunCommandPresenter())` |
| `run_shell_command.ts` | `registerToolPresenter('run_shell_command', makeRunCommandPresenter())` |
| `start_and_wait.ts` | `registerToolPresenter('start_and_wait', makeRunCommandPresenter())` |
| `wait_for_process.ts` | own-file; call headline `[process <pid>]`; result mirrors `run_project_command` result body but reads `processId` from args fallback |
| `kill_process.ts` | own-file; call `[process <pid>]`; result `[killed]` or `[process signalled]` |
| `activate_card.ts` | `registerToolPresenter('activate_card', makeCardOutcomePresenter('activated'))` |
| `cancel_card.ts` | `registerToolPresenter('cancel_card', makeCardOutcomePresenter('cancelled'))` |
| `restart_card.ts` | `registerToolPresenter('restart_card', makeCardOutcomePresenter('restarted'))` |
| `delete_card.ts` | `registerToolPresenter('delete_card', makeCardOutcomePresenter('deleted'))` |
| `create_card.ts` | own-file; title-fallback chain per design r3 §3.5 |
| `edit_card.ts` | own-file; change-keys detail per design r3 §3.5 |
| `move_card.ts` | own-file; `[card <id> → <newParent or 'root'>]` |
| `get_card.ts` | own-file |
| `list_cards.ts` | own-file |
| `get_tree.ts` | own-file |
| `get_status.ts` | own-file |
| `get_plan_diary.ts` | own-file |
| `get_card_output.ts` | own-file |
| `report_goal_done.ts` | `registerToolPresenter('report_goal_done', makeGoalReportPresenter('done', 'ok'))` |
| `report_goal_failed.ts` | `registerToolPresenter('report_goal_failed', makeGoalReportPresenter('failed', 'danger'))` |
| `report_goal_blocked.ts` | `registerToolPresenter('report_goal_blocked', makeGoalReportPresenter('blocked', 'warn'))` |
| `mark_goal_needs_corrections.ts` | own-file |
| `add_note.ts` | own-file |
| `list_notes.ts` | own-file |
| `get_note.ts` | own-file |
| `mark_note_handled.ts` | own-file |
| `read_runtime_events.ts` | `registerToolPresenter('read_runtime_events', makeJsonlTailPresenter('events'))` |
| `read_runtime_errors.ts` | `registerToolPresenter('read_runtime_errors', makeJsonlTailPresenter('errors'))` |
| `read_control_actions.ts` | `registerToolPresenter('read_control_actions', makeJsonlTailPresenter('control actions'))` |
| `list_processes_tool.ts` | own-file |
| `list_agent_sessions.ts` | own-file |
| `read_agent_session.ts` | own-file |
| `pause_runtime.ts` | `registerToolPresenter('pause_runtime', makeRuntimeControlPresenter('paused', '⏸'))` |
| `resume_runtime.ts` | `registerToolPresenter('resume_runtime', makeRuntimeControlPresenter('resumed', '▶'))` |
| `abort_goal.ts` | `registerToolPresenter('abort_goal', makeGoalControlPresenter('aborted', '⛔'))` |
| `restart_goal.ts` | `registerToolPresenter('restart_goal', makeGoalControlPresenter('restarted', '↻'))` |
| `load_skill.ts` | own-file |
| `mcp_tool_call.ts` | own-file |
| `list_card_history.ts` | own-file |
| `get_card_history_entry.ts` | own-file |
| `diff_card.ts` | own-file |

All "own-file" entries follow the matrix in design r3 §3.5 for
icons, headline templates, detail templates, and tones. Each
own-file body is implemented inline in its presenter file (no
new factories needed; the design r3 §3.2 factory list is
exhaustive).

Validation: `npm run typecheck`; smoke-test in the dev server
(`npm run dev`) is deferred to C8 because no consumer is yet on
the new shape.

### 3.4 Commit C4 — `F05: introduce components/content/{InlineParts,JsonView,FormattedContent}.vue`

Goal: ship the three Vue SFCs that render the new presenter
output. Their interfaces and templates are taken from
[01-analysis-r2.md](01-analysis-r2.md) §6–§7 (skeletons) and
[02-design-r3.md](02-design-r3.md) §4.2 (folder placement).

Files created:

- `web/src/components/content/InlineParts.vue` — template per
  analysis r2 §6 (the `<span class="inline-parts">` block with
  four `v-if` branches keyed by `part.kind`). Import path:
  `import type { InlinePart } from '../../utils/tool-presenters';`.
  Helper `shortPath(path: string)` lives inline (10 lines).
  Props: `{ parts: InlinePart[] }`. No emits.
- `web/src/components/content/JsonView.vue` — props
  `{ data: unknown; maxHeight?: string; copyable?: boolean }`
  with defaults `maxHeight: '60vh'`, `copyable: false`. Body
  per analysis r2 §7.2 (1 MB raw-fallback included). Token CSS
  classes (`jt-key`, `jt-string`, `jt-number`, `jt-boolean`,
  `jt-null`, `jt-punctuation`, `jt-whitespace`) wired to the
  CSS variables `--syn-key` etc. that F01 owns. If F01 has not
  yet landed those variables, fall back to sensible literal
  values and let F01 replace them — the variable names are
  fixed by design r3 §4.2.
- `web/src/components/content/FormattedContent.vue` — body per
  analysis r2 §7.3. Imports `JsonView` and the existing
  `MarkdownText` (which F02 r3 relocates into `content/`; if
  F05 lands first this commit creates the `content/` folder and
  F02 relocates `MarkdownText.vue` into it later, OR F05 imports
  from `'../code/MarkdownText.vue'` for one commit until F02
  C-relocation lands). The plan picks the **first** option:
  C4 creates `web/src/components/content/` and waits for F02 to
  relocate. The metaplan must ensure F02's relocation lands
  ahead of F05 C5; if not, C5 is amended to use the old import
  path.
- `web/src/__tests__/content/InlineParts.test.ts` — seven cases
  from design r3 §6.3.
- `web/src/__tests__/content/JsonView.test.ts` — three cases
  from design r3 §6.1 (renders span per token; oversize falls
  back to plain `<pre>`; "undefined" string when stringify fails).
- `web/src/__tests__/content/FormattedContent.test.ts` — eight
  cases from design r3 §6.1 / analysis r2 §8.3.

Files **not** modified in this commit (deliberate):

- `AgentConversationView.vue` and `AnalystChatPanel.vue` still
  use their pre-F05 chip templates. The new content components
  are not wired into them until C8.
- `web/src/__tests__/components/` mirrored test directory tree
  is created on first use only.

Validation: `npm run typecheck && npx vitest run web/src/__tests__/content/`.

### 3.5 Commit C5 — `F05: rewrite FilesView query handling for ?root=meta|output&path=`

Goal: switch `FilesView.vue` to the new query schema so
`<InlineParts>` file links navigate correctly.

Files modified:

- `web/src/views/FilesView.vue`:
  - Replace `applyQueryPath` with the body in design r3 §4.3
    verbatim (the no-fallback variant — any `?path=` without a
    recognised `?root=` is ignored).
  - Replace the existing `watch(() => route.query.path, ...)`
    with `watch(() => [route.query.path, route.query.root], () => applyQueryPath());`.
  - **No other navigation site changes.** Lines 32, 44, 71,
    83, 98 keep their direct `navigateMeta` / `navigateOutput`
    calls per design r3 §4.3 last paragraph.

Files modified (consumer migration to the new query shape, same
commit to avoid broken intermediate links):

- `web/src/components/agents/AgentConversationView.vue` — any
  existing `navigateToLink` / `<router-link>` call that
  navigates to `{ name: 'files', query: { path: '…' } }`
  becomes `{ name: 'files', query: { path: '…', root: '…' } }`
  with `root` inferred at the call site by prefix:
  `.saivage-work/` → `'output'`; `.saivage` → `'meta'`. If no
  call site exists today (i.e. the previous behaviour relied
  on `applyQueryPath`'s prefix inference), the migration is a
  no-op and the change is contained to `FilesView.vue`.

Files created:

- `web/src/__tests__/files-view-route.test.ts` — six cases from
  design r3 §6.4.

Validation: `npm run typecheck && npx vitest run web/src/__tests__/files-view-route.test.ts web/src/__tests__/files-view.test.ts`.

### 3.6 Commit C6 — `F05: enforce barrel import via ESLint no-restricted-imports`

Goal: pin the canonical public import path so deep imports of
the registry / per-tool files / internal helpers are rejected
at lint time, complementing the runtime `assertDefault()` guard.

Files created:

- `web/eslint.config.js` — minimal ESLint flat config that
  applies the rule block from design r3 §3.4 paragraph 1
  verbatim:

  ```js
  // web/eslint.config.js
  export default [
    {
      files: ['src/**/*.{ts,vue}'],
      ignores: ['src/__tests__/**', 'src/utils/tool-presenters/**'],
      rules: {
        'no-restricted-imports': ['error', {
          patterns: [{
            group: ['**/utils/tool-presenters/*', '!**/utils/tool-presenters', '!**/utils/tool-presenters/index'],
            message: 'Import the tool-presenters barrel (utils/tool-presenters), not its internals.',
          }],
        }],
      },
    },
  ];
  ```

  Globs are package-relative (`src/...`) because the config
  lives in `web/`. If `web/eslint.config.js` already exists
  when this commit lands (e.g. introduced by an unrelated PR),
  amend it to append the rule block instead of overwriting.

Files modified:

- `web/package.json`:
  - Add `"lint": "eslint . --max-warnings 0"` to `"scripts"`.
  - Add `eslint` (with the appropriate Vue + TS plugins —
    `eslint`, `@typescript-eslint/parser`, `eslint-plugin-vue`)
    to `"devDependencies"` only if not already present in the
    repo. If the repo already runs ESLint at a higher level
    (e.g. the repo-root `eslint.config.js` covers `web/`), keep
    this commit minimal and only add the rule block in the
    nearest existing flat-config file. Verify which is the case
    before running the commit; the plan defaults to "create
    `web/eslint.config.js`" because no such file exists today
    (`file_search` confirmed at planning time).

Validation: `cd web && npx eslint src/`.

### 3.7 Commit C7 — `F05: rewrite tool-presenters tests around structured parts; add registry + barrel-integrity coverage`

Goal: replace the string-headline tests with the per-tool,
registry, barrel, and coverage tests from design r3 §6.5 / §6.6.

Files deleted:

- `web/src/__tests__/tool-presenters.test.ts` — replaced by
  the per-tool suite under `web/src/__tests__/tool-presenters/`.

Files created (test-only):

- `web/src/__tests__/tool-presenters/_helpers.ts` — the two
  helpers from design r3 §6.6 (`partsOfKind`, `textValues`).
- `web/src/__tests__/tool-presenters/registry.test.ts` — ten
  cases from design r3 §6.5 (named "Registry and barrel-integrity").
- `web/src/__tests__/tool-presenters/coverage.test.ts` — exact
  body from design r3 §6.5 with `EXPECTED_TOOL_NAMES` from §3.6.
- `web/src/__tests__/tool-presenters/barrel-integrity.test.ts` —
  exact body from design r3 §6.5 (file-system walk + bare-import
  assertions + ordering assertion).
- One file per tool under
  `web/src/__tests__/tool-presenters/<tool>.test.ts` — case
  names per design r3 §6.6. Fixture payloads (raw JSON strings)
  are inlined in each file; no shared fixture dump.

The per-tool files are stubbed in a single "build all 45 test
files at once" pass so the coverage test fails loudly if any
tool name is missed in C3. Each file imports the barrel only
and uses the helpers from `_helpers.ts`.

Validation: `npm run typecheck && npx vitest run web/src/__tests__/tool-presenters/`.

### 3.8 Commit C8 — `F05: migrate AgentConversationView and AnalystChatPanel to InlinePart[] consumers (chip rendering)`

Goal: switch the two existing consumer surfaces to read
`InlinePart[]` headlines / details and to render through
`<ToolChip>`'s F05-owned children (`<InlineParts>`,
`<FormattedContent>`). **The chip itself is owned by F03**: F05
contributes the prop-bag binding and the children it mounts; F05
does NOT swap AnalystChatPanel into the shared `<ToolChip>`
(that's the F03 PR per [F03 r3 design §8.2](../F03-conversation-rounds/02-design-r3.md)).

Files modified:

- `web/src/components/agents/AgentConversationView.vue`:
  - Delete the `expandedDetail`, `toolCallView`, `toolResultView`
    helpers and the `tc-header` / `tr-header` template fragments
    at lines 63–103 (per design r3 §5.2 deletion list).
  - Rebind the existing per-step rendering to read
    `presentation.headline: InlinePart[]` and
    `presentation.detail: InlinePart[]`, mounting them via
    `<InlineParts :parts="...">` from
    `../content/InlineParts.vue`.
  - Replace the raw-content `<CodeBlock language="json">`
    expansion path with `<FormattedContent :content="step.content" />`.
  - Type imports updated to the new shapes:
    `import type { ToolCallPresentation, ToolResultPresentation } from '../../utils/tool-presenters';`
    (path unchanged; shape changed).
  - The chip swap to `<ToolChip>` is F03's commit; this commit
    keeps `AgentConversationView`'s current chip wrapper but
    renders the new structured parts inside it. F03's PR
    later replaces the wrapper.
- `web/src/components/chat/AnalystChatPanel.vue`:
  - Same `InlinePart[]` rebind; same `<FormattedContent>` swap
    for the expanded body.
  - Local `ChipParts` interface deleted; consumer imports
    `ToolCallPresentation` / `ToolResultPresentation` from the
    barrel directly.
  - The `<button class="tool-chip">` wrapper and its scoped CSS
    block (lines 298–347) are **kept** in this commit; they are
    deleted by **F03's commit C5** when the chip is swapped
    (per design r3 §5.2 and [F02 r3 §1.4 deletion matrix](../F02-component-hierarchy/02-design-r3.md#14-deletion-matrix-commit-bound)).
    F05's job here is the data-flow rewrite, not the wrapper
    removal.

Files modified (tests):

- `web/src/__tests__/analyst-chat-panel.test.ts` — update any
  assertion that reads string headlines (`'…'`-equals) to
  inspect the rendered DOM produced by `<InlineParts>` instead.
  Specifically, the helper that pulled `.tool-chip-headline
  span` text is repointed at `.inline-parts span.inline-text`
  and similar.
- `web/src/__tests__/agents-view.test.ts` — same data-flow
  rewrite if it reads headlines / details directly.
- `web/src/__tests__/code-block.test.ts` — no change (CodeBlock
  is unchanged).

Validation: full `npm run typecheck && npm run test`. Manual
smoke in `npm run dev`: open an agent conversation and an
analyst chat with a known tool call/result; confirm the
expanded body renders JSON via `<JsonView>` and the inline
parts render file links pointing at
`/files?path=…&root=…`.

### 3.9 Commit C9 — `F05: chip prop-bag contract (eight props) + InlineParts/FormattedContent integration test scaffolding for the shared ToolChip`

This commit ships the F05-owned **contract** for the shared
`web/src/components/conversation/ToolChip.vue` so F03 can layer
its template / `<Card>` styling on top without re-deriving the
prop names. It is a small, contract-only commit; F03 owns the
rest of the chip.

Files created (only if F03's chip commit has not yet landed
when F05 reaches this step; otherwise this commit is a no-op):

- `web/src/components/conversation/ToolChip.vue` — minimal
  shell whose `<script setup>` declares the eight props
  verbatim from design r3 §4.1 and whose `<template>` renders
  the §6 markup from analysis r2: a `<div class="tool-chip"
  role="group">` with one `<button class="tool-chip-toggle">`
  expand toggle and `<InlineParts>` children for headline /
  detail. The expanded body mounts `<FormattedContent
  :content="callContent" />` and conditionally
  `<FormattedContent :content="resultContent" />`. No tone
  classes, no `<Card>`, no `timestamp` rendering — F03's PR
  layers those.

Files created (tests; lives in
`web/src/__tests__/conversation/ToolChip.test.ts` either way,
appended-to if F03 already created the file):

- The eleven cases from design r3 §6.2, restricted to the
  assertions F05 owns (prop-bag shape, InlinePart field
  reading, file-link routing, `<FormattedContent>` mounting,
  sibling-DOM rule).
- Whichever cases already exist in F03's chip-contract test
  file are not duplicated; F05 only adds the cases not yet
  present.

Validation: `npm run typecheck && npx vitest run web/src/__tests__/conversation/`.

---

## 4. Files touched (cumulative across C1..C9)

### 4.1 Created

| Path | Owner | Commit |
| ---- | ----- | ------ |
| `web/src/utils/json-tokenize.ts` | F05 | C1 |
| `web/src/utils/tool-presenters/index.ts` | F05 | C2 |
| `web/src/utils/tool-presenters/types.ts` | F05 | C2 |
| `web/src/utils/tool-presenters/registry.ts` | F05 | C2 |
| `web/src/utils/tool-presenters/helpers.ts` | F05 | C2 |
| `web/src/utils/tool-presenters/__default__.ts` | F05 | C2 (stub) / C3 (full body) |
| `web/src/utils/tool-presenters/<each-of-45-tools>.ts` | F05 | C2 (stub) / C3 (full body) |
| `web/src/components/content/InlineParts.vue` | F05 | C4 |
| `web/src/components/content/JsonView.vue` | F05 | C4 |
| `web/src/components/content/FormattedContent.vue` | F05 | C4 |
| `web/src/components/conversation/ToolChip.vue` (if absent) | shared with F03 | C9 |
| `web/eslint.config.js` | F05 | C6 |
| `web/src/__tests__/json-tokenize.test.ts` | F05 | C1 |
| `web/src/__tests__/content/InlineParts.test.ts` | F05 | C4 |
| `web/src/__tests__/content/JsonView.test.ts` | F05 | C4 |
| `web/src/__tests__/content/FormattedContent.test.ts` | F05 | C4 |
| `web/src/__tests__/files-view-route.test.ts` | F05 | C5 |
| `web/src/__tests__/tool-presenters/_helpers.ts` | F05 | C7 |
| `web/src/__tests__/tool-presenters/registry.test.ts` | F05 | C7 |
| `web/src/__tests__/tool-presenters/coverage.test.ts` | F05 | C7 |
| `web/src/__tests__/tool-presenters/barrel-integrity.test.ts` | F05 | C7 |
| `web/src/__tests__/tool-presenters/<each-of-45-tools>.test.ts` | F05 | C7 |
| `web/src/__tests__/conversation/ToolChip.test.ts` (or appends) | shared with F03 | C9 |

### 4.2 Modified

| Path | Commit | Nature |
| ---- | ------ | ------ |
| `web/package.json` | C2, C6 | add `sideEffects`, optional `lint` script |
| `web/src/views/FilesView.vue` | C5 | `applyQueryPath` rewrite + watcher widen |
| `web/src/components/agents/AgentConversationView.vue` | C2 (imports), C5 (link query shape), C8 (InlinePart consumer) | data-flow migration; chip wrapper deletion is F03's job |
| `web/src/components/chat/AnalystChatPanel.vue` | C2 (imports), C8 (InlinePart consumer) | data-flow migration; chip wrapper deletion is F03's job |
| `web/src/__tests__/tool-presenters.test.ts` | C2 (skip) | replaced and deleted in C7 |
| `web/src/__tests__/analyst-chat-panel.test.ts` | C8 | rewire headline assertions to DOM-based |
| `web/src/__tests__/agents-view.test.ts` | C8 | rewire headline assertions to DOM-based |

### 4.3 Deleted

| Path | Commit | Reason |
| ---- | ------ | ------ |
| `web/src/utils/tool-presenters.ts` | C2 | Replaced by the directory layout; no re-export shim (design r3 §5). |
| `web/src/__tests__/tool-presenters.test.ts` | C7 | Replaced by the per-tool suite; no string-headline assertions survive (design r3 §6.8). |
| (No other deletions in F05's scope. The `<button class="tool-chip">` wrappers and their CSS are deleted by **F03's** commit set per design r3 §5.2.) | — | — |

---

## 5. PR layout

Recommended single-PR shape (one PR per issue per the metaplan):

- **Title:** `F05: tool-detail rendering (registry, InlinePart, JsonView, FormattedContent, FilesView route)`
- **Commits in order:** C1 → C9 as listed above.
- **Description sections:**
  1. Link to design r3 + analysis r2 + APPROVED markers.
  2. Coverage map row-for-row (this plan's §3).
  3. Validation matrix (§7).
  4. Cross-issue coordination notes (this plan's §1).
  5. Risks / rollback (this plan's §8).

An alternative two-PR shape — split between "engine" (C1..C3 +
C7) and "UI consumers" (C4..C6 + C8 + C9) — is rejected because
the InlinePart-shape change of `ToolCallPresentation` /
`ToolResultPresentation` is breaking; a PR that lands the engine
without the UI migration leaves AgentConversationView /
AnalystChatPanel non-functional in the dev server. Keeping it
all in one PR avoids that broken intermediate.

---

## 6. Test plan summary

Cross-referenced from design r3 §6 with one-to-one mapping to
files created in this plan:

| Design r3 section | Plan file | Commit |
| ----------------- | --------- | ------ |
| §6.1 `json-tokenize.test.ts` | `web/src/__tests__/json-tokenize.test.ts` | C1 |
| §6.1 `JsonView.test.ts` | `web/src/__tests__/content/JsonView.test.ts` | C4 |
| §6.1 `FormattedContent.test.ts` | `web/src/__tests__/content/FormattedContent.test.ts` | C4 |
| §6.2 `ToolChip.test.ts` (F05's owned cases) | `web/src/__tests__/conversation/ToolChip.test.ts` | C9 |
| §6.3 `InlineParts.test.ts` | `web/src/__tests__/content/InlineParts.test.ts` | C4 |
| §6.4 `files-view-route.test.ts` | `web/src/__tests__/files-view-route.test.ts` | C5 |
| §6.5 `registry.test.ts` | `web/src/__tests__/tool-presenters/registry.test.ts` | C7 |
| §6.5 `coverage.test.ts` | `web/src/__tests__/tool-presenters/coverage.test.ts` | C7 |
| §6.5 `barrel-integrity.test.ts` | `web/src/__tests__/tool-presenters/barrel-integrity.test.ts` | C7 |
| §6.6 per-tool `<tool>.test.ts` × 45 + `__default__` | `web/src/__tests__/tool-presenters/<name>.test.ts` | C7 |
| §6.7 (F03 / F04 integration cases) | Owned by F03 / F04 plans; F05 verifies the eight-prop names | C9 |
| §6.8 deletion of old `tool-presenters.test.ts` | `web/src/__tests__/tool-presenters.test.ts` | C7 |

---

## 7. Validation strategy

Per-commit gates (run before pushing each commit):

1. `cd web && npm run typecheck` — must pass.
2. `cd web && npx vitest run <files-introduced-in-this-commit>` —
   must pass.
3. From C6 onwards: `cd web && npx eslint src/` — must pass.

Whole-PR gates (run on the integration branch before review):

1. `cd web && npm run typecheck`.
2. `cd web && npm run test` (full Vitest suite).
3. `cd web && npx eslint src/`.
4. Manual smoke against the dev container per the
   [saivage-development-validation skill](../../../../.github/skills/saivage-development-validation/SKILL.md):
   - `cd web && npm run build && npm run preview` boots without
     errors.
   - On the agent surface, expand any tool chip; the body
     renders through `<FormattedContent>` (JSON path) and via
     `<MarkdownText>` for prose payloads.
   - Click a file link from a tool headline; the address bar
     shows `?path=…&root=meta` or `?path=…&root=output`;
     `FilesView` opens the right panel.
   - On the analyst surface, the existing chip wrapper still
     renders (F03's swap has not yet landed); inline parts
     render through the new `<InlineParts>` component (DOM
     inspection confirms `.inline-parts` class and `tone-*`
     suffixes on `text` parts).
5. On the deployed `saivage-v3` container (`10.0.3.112`), after
   `systemctl restart saivage.service`, repeat the manual
   smoke against the live UI.

Coverage-test guarantees:

- `tool-presenters/coverage.test.ts` fails CI if any name in
  `EXPECTED_TOOL_NAMES` is missing a registration or any extra
  name appears.
- `tool-presenters/barrel-integrity.test.ts` fails CI if any
  per-tool `.ts` file under `web/src/utils/tool-presenters/`
  is not imported as a bare statement from `index.ts`, or if
  `__default__` is not the last bare-statement import.
- `assertDefault()` throws at runtime if a test bypasses the
  barrel by importing `./registry` without first importing
  `./__default__` — the error message points at the canonical
  import path.

---

## 8. Risks and rollback

### 8.1 Risks

1. **Tree-shaking drops a per-tool registration in production.**
   Vite/Rollup defaults preserve side effects only when (a) the
   import is a bare statement and (b) the package's
   `sideEffects` manifest lists the file. C2 adds both. The
   barrel-integrity test and the coverage test would catch any
   regression at CI time, before a release.
2. **F02 r3 `content/` folder relocation lands after F05 C4.**
   If F02 has not yet relocated `MarkdownText.vue` into
   `content/` when F05 C4 runs, `FormattedContent.vue`'s
   import resolves to `../code/MarkdownText.vue` (current
   location). The plan accepts this — the metaplan sequences
   F02 ahead of F05 — but if the order slips, C4 is amended
   one line (the import path) and F02 fixes it later.
3. **F03 r3 `ToolChip.vue` shape disagrees with F05's
   eight-prop bag.** Design r3 §4.4 declares F02 r2's six-prop
   snippets errata. F03 r3 is approved with the eight props.
   C9's contract-only commit and the `ToolChip.test.ts` cases
   from design r3 §6.2 enforce the bag at PR review time.
4. **`AgentConversationView.vue` already imports
   `tool-presenters` without the `.ts` suffix.** Verified at
   planning time: it does. Then C2's import-string
   normalisation is a no-op and the directory resolution
   "just works". If a future edit reintroduces an explicit
   `.ts`, ESLint's `no-restricted-imports` rule catches it.
5. **A test imports `tool-presenters/registry` for the `_*ForTest`
   helpers without also importing the barrel.** `assertDefault()`
   in `registry.ts` throws with the hint message; the failure
   surfaces at test setup, not at production runtime. The
   helper signature (`_registryKeysForTest`,
   `_internalRegistryEntriesForTest`) is underscore-prefixed
   and only exempt from the ESLint rule under
   `web/src/__tests__/**`, so no production code can reach it.

### 8.2 Rollback

Each commit is independently revertible because the codebase
typechecks at every step except between C2 and C3. The PR ships
all nine commits together; rollback is a single PR revert.

Inside the PR, if a single commit fails review, the natural
choices are:

- **Roll back C8 only**: keeps the new engine and the new
  content components but reverts the consumer migration. The
  app would not compile (the old consumers expect
  `string`-typed headlines). Therefore not viable on its own.
- **Roll back C8 + C7 + C4 + C5**: keeps only the engine
  changes (C1..C3 + C6). The consumer surfaces are restored
  but they read from an engine that emits `InlinePart[]`; type
  errors surface immediately. Therefore not viable.
- **Roll back the whole PR**: the only safe partial rollback.
  This is acceptable because the F05 changes are bounded; the
  v3 codebase reverts to its pre-F05 state cleanly (the
  deletion of `tool-presenters.ts` reverses to a recreation, no
  data is lost).

The plan therefore treats the nine commits as one logical unit
for rollback purposes, while keeping them split for review
clarity.

---

## 9. Out of scope (mirrors design r3 §8)

- Backend project file root (`root: 'project'`) — separate issue.
- Richer `MarkdownText` (headings, bullets, emphasis) — separate
  issue. F05 ships prose rendering exactly as `MarkdownText`
  renders it today.
- Replacement of `highlight.js` in `CodeBlock` — separate issue.
- Streaming-aware JSON tokeniser — separate issue.
- Bundle-splitting / per-tool lazy import — separate issue. The
  `sideEffects` manifest is a hardening step against a future
  bundle-splitting effort, but the splitting itself is not done
  here.
- Custom expand bodies on `ToolPresenter` (per-tool view
  components, e.g. for `diff_card`) — separate issue and a
  forward seat preserved by Proposal B's shape.

---

## 10. Result

- Absolute path: `/home/salva/g/ml/saivage-v3/SPEC/2026-05/review-ui-port-from-v2/F05-tool-detail-rendering/03-plan-r1.md`
- Plan summary: nine commits (C1..C9) implementing the approved
  F05 design with:
  - One commit dedicated to the `json-tokenize` extraction (C1).
  - One commit that pivots the architecture (delete single file,
    introduce the directory, stubs only) (C2).
  - One commit that fills every per-tool registration (C3).
  - One commit for the three new content components plus their
    tests (C4).
  - One commit for the `FilesView` query-schema migration (C5).
  - One commit for the ESLint barrel-import rule (C6).
  - One commit for the rewritten / new presenter test suite (C7).
  - One commit for the consumer-surface data-flow migration (C8).
  - One contract-only commit for the F05-owned chip prop bag and
    its tests (C9).
- Cross-issue coordination (F02 r3 directory layout + C4
  deletion; F03 r3 ToolChip ownership; F04 r2 adapter
  consumption) documented in §1.
- Validation gates documented per commit and per PR in §7.
- Risks and rollback documented in §8; PR is treated as one
  logical rollback unit.
