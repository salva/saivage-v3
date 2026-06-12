# F05 — Tool detail rendering: Functional Analysis (R2)

Scope: detail rendering for tool-call / tool-result chips in the v3 web UI. Port the three v2 layers — token-aware JSON view, JSON-vs-prose auto-detection (including embedded-JSON-after-prose), and per-tool structured headlines/details with inline file/url/code parts — into v3 with no backward-compatibility carve-outs.

Reviewer critique of R1 (binding): [01-analysis-review-r1.md](01-analysis-review-r1.md). Previous draft: [01-analysis-r1.md](01-analysis-r1.md).

## 0. Changes since R1

- Dropped the `FormattedToolPair` layer. `presentToolCall` and `presentToolResult` are independent and each emit `{ icon, name, headline: InlinePart[], detail: InlinePart[], status }`. Pairing is a surface concern.
- File-link routing aligned with what v3 actually exposes: `root: 'meta' | 'output'` only. `read_project_file`-style paths (no resolvable root) are emitted as plain `text` parts, not clickable files. Adding a third project root is called out as a separate backend change.
- Chip markup is a non-button `<div role="group">` with one dedicated expand `<button>` and inline `<a>` / `<router-link>` siblings — no nested interactive elements.
- Full per-tool coverage matrix (call/result × headline/detail × tone) plus an explicit `__default__` fallback bucket.
- Concrete test plans for an extracted `tokenizeJson` utility, a rewritten `tool-presenters.test.ts` around structured parts, and a new `FormattedContent` test file.

## 1. v3 today

Both expansion surfaces — [AgentConversationView.vue](../../../web/src/components/agents/AgentConversationView.vue) and [AnalystChatPanel.vue](../../../web/src/components/chat/AnalystChatPanel.vue) — call the presenters independently and feed their `headline` / `detail` strings into chip spans, then drop the raw step content into one `<CodeBlock language="json">` on expand. The current presenter contract in [tool-presenters.ts](../../../web/src/utils/tool-presenters.ts) is flat string text:

```ts
export interface ToolCallPresentation   { icon; name; headline: string; detail?: string }
export interface ToolResultPresentation { icon; status; name; headline: string; detail?: string }
```

Tools enumerated by `CALL_PRESENTERS` and `RESULT_PRESENTERS` (read in full): `read_project_file`, `read_file`, `list_project_files`, `list_directory`, `write_project_file`, `run_project_command`, `run_shell_command`, `start_and_wait`, `wait_for_process`, `kill_process`, `activate_card`, `cancel_card`, `restart_card`, `delete_card`, `create_card`, `edit_card`, `move_card`, `get_card`, `list_cards`, `get_tree`, `get_status`, `get_plan_diary`, `get_card_output`, `report_goal_done`, `report_goal_failed`, `report_goal_blocked`, `mark_goal_needs_corrections`, `add_note`, `list_notes`, `get_note`, `mark_note_handled`, `read_runtime_events`, `read_runtime_errors`, `read_control_actions`, `list_processes_tool`, `list_agent_sessions`, `read_agent_session`, `pause_runtime`, `resume_runtime`, `abort_goal`, `restart_goal`, `load_skill`, `mcp_tool_call`, `list_card_history`, `get_card_history_entry`, `diff_card`.

File store roots ([stores/files.ts](../../../web/src/stores/files.ts)): `METADATA_ROOT = '.saivage'` and `OUTPUT_ROOT = '.saivage-work'`. `FilesView` only honours `?path=` when it starts with `.saivage-work/` ([FilesView.vue](../../../web/src/views/FilesView.vue) `applyQueryPath`). There is no `project` root.

## 2. Presenter contract (independent, no hidden pair state)

```ts
export type ToolStatus = 'call' | 'ok' | 'error';

export interface ToolCallPresentation {
  icon: string;
  name: string;
  headline: InlinePart[];
  detail: InlinePart[];          // [] when nothing to show
  status: 'call';
}

export interface ToolResultPresentation {
  icon: string;
  name: string;
  headline: InlinePart[];
  detail: InlinePart[];
  status: 'ok' | 'error';
}

export function presentToolCall(
  content: string,
  tool?: string,
): ToolCallPresentation;

export function presentToolResult(
  content: string,
  ctx: { tool?: string; kind?: 'tool_result' | 'tool_error' },
): ToolResultPresentation;
```

Properties:

- Each function works against its own payload only. `presentToolResult` does NOT consult the originating call args. If a future surface wants paired data it computes it at render time from the two messages, not from the presenter layer.
- `detail` is always an array (possibly empty); no `string | undefined` shim. The renderer treats `[]` as "no detail row".
- `status` is set on the presentation itself so the chip class (`tool-chip-call` / `-ok` / `-error`) is derived from one place.
- The unknown-tool path goes through a single `__default__` bucket described in §5.

## 3. `InlinePart` type (final, exported)

```ts
export type InlinePart =
  | { kind: 'text'; value: string; tone?: 'ok' | 'warn' | 'danger' | 'muted' }
  | { kind: 'file'; path: string; root: 'meta' | 'output' }
  | { kind: 'url';  url: string }
  | { kind: 'code'; value: string };
```

- Four kinds, exhaustive. The renderer uses the discriminant only — no string fallback, no `headlineString` shim, no `value` field shared across variants. Display text for `file` is derived from `path` (rightmost segment or `shortPath(path)`); display text for `url` is the URL itself; display text for `code` is `value`; `text` is `value`.
- `tone` only applies to `text`, matching v3 semantic tokens (`--ok`, `--warn`, `--danger`, `--text-muted`). v2's `'error'` is renamed to `'danger'` per project guideline.
- Type is the single source of truth for what an inline part can be; `tool-presenters.ts` exports it and the renderer (`InlineParts.vue`) imports it. No parallel definition lives in the v2 source — that file is not consumed.

Rationale for diverging from R1's shape (`value` on every variant, `root: 'project' | 'saivage'`):

- `value` on `file` / `url` was redundant with `path` / `url` and invited callers to set a "display string" that drifts from the actual link target. Renderer truncates for display; the part stores only the canonical target.
- `root: 'project'` is removed because v3 does not expose the project root through the file API. Formatters that previously emitted `root: 'project'` now emit a plain `text` part (see §4).

## 4. File click routing

### 4.1 Resolvable roots (v3 today)

| Root value | Backing store call         | Path prefix          |
| ---------- | -------------------------- | -------------------- |
| `meta`     | `fileStore.navigateMeta`   | starts with `.saivage` (not `.saivage-work`) |
| `output`   | `fileStore.navigateOutput` | starts with `.saivage-work` |

Formatters classify by prefix:

- Path starts with `.saivage-work/` → `{ kind: 'file', path, root: 'output' }`.
- Path starts with `.saivage/` (and not `.saivage-work/`) → `{ kind: 'file', path, root: 'meta' }`.
- Any other path (e.g. `src/foo.ts`, `/abs/path`, `~/foo`) → `{ kind: 'text', value: path }`. Not clickable, no broken link.

### 4.2 FilesView query handling

[FilesView.vue](../../../web/src/views/FilesView.vue) `applyQueryPath` is updated to accept `?root=meta|output&path=<p>`:

```ts
function applyQueryPath(): void {
  const p = route.query.path;
  const r = route.query.root;
  if (typeof p !== 'string') return;
  if (r === 'meta')   { fileStore.navigateMeta(p).catch(() => {});   return; }
  if (r === 'output') { fileStore.navigateOutput(p).catch(() => {}); return; }
  // Back-compat with the link forms already in AgentConversationView
  // (`navigateToLink`) that pass bare `?path=`: infer by prefix.
  if (p.startsWith('.saivage-work/')) fileStore.navigateOutput(p).catch(() => {});
  else if (p.startsWith('.saivage'))  fileStore.navigateMeta(p).catch(() => {});
}
```

Watcher on `() => [route.query.path, route.query.root]` replaces the single-key watcher.

### 4.3 If a project root is genuinely needed (out of scope for F05)

`read_project_file` / `write_project_file` / `list_project_files` operate on the project working tree, not under `.saivage`. To make those paths clickable a third root `project` would need to be added with:

- Backend: a new `/api/files/project/...` endpoint mirroring the existing meta/output endpoints, with the same protections (no traversal, allowlist of extensions, byte cap).
- Store: `projectPath`, `projectFiles`, `navigateProject` siblings in [files.ts](../../../web/src/stores/files.ts).
- View: a third panel or a panel switcher in [FilesView.vue](../../../web/src/views/FilesView.vue).
- Presenter: `root: 'meta' | 'output' | 'project'`.

This is intentionally not part of F05. The F05 implementation ships with two roots; project-file headlines are non-clickable text until that work lands.

## 5. Per-tool coverage matrix

`H` = headline, `D` = detail. `Inline` columns list the parts emitted; bracketed text is a literal `text` part with tone, `<file>` / `<url>` / `<code>` are typed parts. Tone column applies to the result presentation as a whole (sets the chip class).

| tool name | call H | call D | result H | result D | result tone |
| --------- | ------ | ------ | -------- | -------- | ----------- |
| `read_project_file` | `<text:path>` (not clickable; project root) | `[]` | `[Nl lines · Bs]` or `[binary file]` | `[]` | `muted` |
| `read_file` | same as `read_project_file` | `[]` | same | `[]` | `muted` |
| `list_project_files` | `<text:path>` | `[]` | `[Nentries entries]` | `[]` | `muted` |
| `list_directory` | same as `list_project_files` | `[]` | same | `[]` | `muted` |
| `write_project_file` | `<text:path>` | `[Nch chars]` | `[wrote Bs]` or `[wrote file]` | `[]` | `ok` |
| `run_project_command` | `<code:command>` | `[]` | `[exit N, ok|danger]` | `[· stdout-tail, muted]` | `ok` if exit 0 else `danger` |
| `run_shell_command` | same | `[]` | same | same | same |
| `start_and_wait` | same | `[]` | same | same | same |
| `wait_for_process` | `[process pid]` | `[]` | `[exit N…]` or `[completed]` | `[process pid]` | `ok`/`danger` |
| `kill_process` | `[process pid]` | `[]` | `[killed]` or `[signalled]` | `[]` | `ok` |
| `activate_card` | `[card id]` | `[]` | `[activated id]` | `[status]` | `ok` |
| `cancel_card` | `[card id]` | `[]` | `[cancelled id]` | `[status]` | `ok` |
| `restart_card` | `[card id]` | `[]` | `[restarted id]` | `[status]` | `ok` |
| `delete_card` | `[card id]` | `[]` | `[deleted id]` | `[]` | `ok` |
| `create_card` | `[title or 'new card']` | `[type · parent]` | `[created id]` | `[type · status]` | `ok` |
| `edit_card` | `[card id]` | `[change keys]` | `[edited id]` | `[changed keys]` | `ok` |
| `move_card` | `[card id → newParent]` | `[]` | `[moved id]` | `[]` | `ok` |
| `get_card` | `[card id]` | `[]` | `[title]` or `[card id]` | `[type · status]` | `muted` |
| `list_cards` | `[filters or 'all cards']` | `[]` | `[N cards]` | `[]` | `muted` |
| `get_tree` | `[subtree id]` or `[project tree]` | `[]` | `[tree fetched]` | `[]` | `muted` |
| `get_status` | `[project status]` | `[]` | `[summary, muted]` | `[]` | `muted` |
| `get_plan_diary` | `[goal id]` | `[]` | `[N entries]` | `[]` | `muted` |
| `get_card_output` | `[card id · last N lines]` | `[]` | `[Nlines lines · Bs]` | `[]` | `muted` |
| `report_goal_done` | `[status_text, muted]` | `[]` | `[recorded done]` | `[]` | `ok` |
| `report_goal_failed` | `[status_text, muted]` | `[]` | `[recorded failed]` | `[]` | `danger` |
| `report_goal_blocked` | `[status_text, muted]` | `[]` | `[recorded blocked]` | `[]` | `warn` |
| `mark_goal_needs_corrections` | `[goal id]` | `[N issues]` | `[corrections queued]` | `[]` | `warn` |
| `add_note` | `[card id [kind]]` | `[content, muted]` | `[note id]` or `[note added]` | `[]` | `ok` |
| `list_notes` | `[card id]` | `[]` | `[N notes]` | `[]` | `muted` |
| `get_note` | `[note id on card id]` | `[]` | `[content, muted]` | `[]` | `muted` |
| `mark_note_handled` | `[note id]` | `[]` | `[note handled]` | `[]` | `ok` |
| `read_runtime_events` | `[events × N [kind]]` | `[]` | `[N events]` | `[]` | `muted` |
| `read_runtime_errors` | `[errors × N]` | `[]` | `[N errors]` | `[]` | `muted` |
| `read_control_actions` | `[control actions × N]` | `[]` | `[N control actions]` | `[]` | `muted` |
| `list_processes_tool` | `[filter ...]` or `[all processes]` | `[]` | `[N processes]` | `[]` | `muted` |
| `list_agent_sessions` | `[agent sessions]` | `[]` | `[N sessions]` | `[]` | `muted` |
| `read_agent_session` | `[session id]` | `[]` | `[N messages]` | `[]` | `muted` |
| `pause_runtime` | `[pause runtime]` | `[]` | `[paused]` | `[]` | `ok` |
| `resume_runtime` | `[resume runtime]` | `[]` | `[resumed]` | `[]` | `ok` |
| `abort_goal` | `[goal id]` | `[]` | `[aborted]` | `[]` | `ok` |
| `restart_goal` | `[goal id]` | `[]` | `[restarted]` | `[]` | `ok` |
| `load_skill` | `[skill name]` | `[]` | `[loaded name]` | `[]` | `ok` |
| `mcp_tool_call` | `[tool name]` | `[params, muted]` | `[summary, muted]` | `[]` | `muted` |
| `list_card_history` | `[card id]` | `[]` | `[N entries]` | `[]` | `muted` |
| `get_card_history_entry` | `[card id @ v seq]` | `[]` | `[author · date, muted]` | `[]` | `muted` |
| `diff_card` | `[card id]` | `[]` | `[N changes]` | `[]` | `muted` |
| `__default__` (fallback) | `[(argKeys)]` or `[]` | `[oneLine(args), muted]` | `[oneLine(summary or message or raw), muted]` | `[]` | `ok`/`error` from `kind`/`ok`/`error` payload |

Notes:

- `__default__` is the only fallback. Named v3 tools must not accidentally land here; the test plan in §8 asserts coverage of every name above.
- The path arguments for `read_project_file` / `read_file` / `write_project_file` / `list_project_files` / `list_directory` / `get_card_output` are emitted as `text`, not `file`, since they target the project root that v3 does not expose. If the project root is later added (§4.3), those become `{ kind: 'file', path, root: 'project' }` in one place.
- Error path: when `kind === 'tool_error'` or the payload `ok === false`, the result presenter returns `{ status: 'error', headline: [{ kind: 'text', value: errorMessage, tone: 'danger' }], detail: [] }`. The tone column in the table describes the success path; the error path always sets `danger`.

## 6. Chip markup (no nested interactive elements)

Replaces the current `<button class="tool-chip">…</button>` wrapping. New shape (used by both consumer surfaces):

```vue
<div
  class="tool-chip"
  :class="toolChipClasses(item)"
  role="group"
  :aria-label="toolChipAriaLabel(item)"
>
  <button
    type="button"
    class="tool-chip-toggle"
    :aria-expanded="expandedIds.has(item.id)"
    :aria-controls="`tool-detail-${item.id}`"
    :aria-label="expandedIds.has(item.id) ? 'Collapse details' : 'Expand details'"
    @click="toggleExpanded(item.id)"
  >
    <span class="tool-chip-caret" aria-hidden="true">{{ expandedIds.has(item.id) ? '▾' : '▸' }}</span>
  </button>
  <span class="tool-chip-icon" aria-hidden="true">{{ parts.icon }}</span>
  <span class="tool-chip-name">{{ parts.name }}</span>
  <InlineParts class="tool-chip-headline" :parts="parts.headline" />
  <InlineParts v-if="parts.detail.length" class="tool-chip-tag" :parts="parts.detail" />
</div>
<div
  v-if="expandedIds.has(item.id)"
  :id="`tool-detail-${item.id}`"
  class="tool-chip-detail"
>
  <FormattedContent :content="item.content" />
</div>
```

`InlineParts.vue`:

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

Consumer updates:

- [AnalystChatPanel.vue](../../../web/src/components/chat/AnalystChatPanel.vue#L36-L52): replace the `<button class="tool-chip">` wrapper and the `<CodeBlock>` expansion path; drop `toolChipDetail` (now `FormattedContent`); local `ChipParts` interface replaced by importing `ToolCallPresentation` / `ToolResultPresentation`.
- [AgentConversationView.vue](../../../web/src/components/agents/AgentConversationView.vue#L71-L103): replace `tc-header` / `tr-header` and the `<CodeBlock>` expansion path with the same chip markup; `toolCallView` and `toolResultView` keep their names but typecheck against the new `InlinePart[]` headline/detail.

The expand toggle is the only interactive element inside the chip group; file/url links are siblings of the toggle, so the DOM has no nested buttons or nested links.

## 7. JSON view and FormattedContent

### 7.1 `web/src/utils/json-tokenize.ts`

Pure utility extracted so it is independently testable.

```ts
export type Token =
  | { type: 'key';        text: string }
  | { type: 'string';     text: string }
  | { type: 'number';     text: string }
  | { type: 'boolean';    text: string }
  | { type: 'null';       text: string }
  | { type: 'brace';      text: '{' | '}' }
  | { type: 'bracket';    text: '[' | ']' }
  | { type: 'colon';      text: ': ' }
  | { type: 'comma';      text: ',' }
  | { type: 'whitespace'; text: string };

/** Tokenise a JSON document (assumed already pretty-printed). */
export function tokenizeJson(text: string): Token[];
```

Algorithm is the byte-equivalent port of v2's `tokenize` in [JsonHighlight.vue](../../../../saivage/web/src/components/JsonHighlight.vue): stack of `{`/`[`, `expectKey` set on `{`, cleared on `[`, re-set on `,` only when stack top is `{`. Strings consume escape sequences (`\\` + next char). Numbers consume `[-0-9.eE+\-]`.

### 7.2 `web/src/components/ui/JsonView.vue`

```ts
const props = withDefaults(defineProps<{
  data: unknown;
  maxHeight?: string;
  copyable?: boolean;
}>(), { maxHeight: '60vh', copyable: false });

const OVERSIZE_BYTES = 1_000_000;

const formatted = computed<string>(() => {
  try { return JSON.stringify(props.data, null, 2) ?? 'undefined'; }
  catch { return String(props.data); }
});

const oversize = computed(() => formatted.value.length > OVERSIZE_BYTES);
const tokens   = computed(() => oversize.value ? [] : tokenizeJson(formatted.value));
```

Template renders `<pre class="json-hl"><span class="jt-…">…</span>…</pre>` when not oversize, else a plain `<pre class="json-raw">{{ formatted }}</pre>` with no tokenisation (matches the 1 MB fallback in [CodeBlock.vue](../../../web/src/components/code/CodeBlock.vue)). All colours come from `--syn-key`, `--syn-string`, `--syn-number`, `--syn-boolean`, `--syn-null`, `--syn-punctuation` (provided by F01).

### 7.3 `web/src/components/ui/FormattedContent.vue`

Behaviour mirrors [v2 FormattedContent](../../../../saivage/web/src/components/FormattedContent.vue) with v3 wiring:

```ts
type ParsedContent =
  | { kind: 'json'; data: unknown }
  | { kind: 'text'; text: string };

const PROSE_PREFIX = /^(Tool call|Tool result|Result|Error|Response|Request)\b/i;
```

1. Empty input → `text`.
2. Trimmed starts with `{` or `[` → try `JSON.parse`; success → `json`; failure → fall through.
3. Otherwise locate first `{` or `[`; if the prefix is empty OR matches `PROSE_PREFIX`, try `JSON.parse(suffix)`; success → `json`.
4. Else `text`.

Template:

```vue
<JsonView v-if="parsed.kind === 'json'" :data="parsed.data" :max-height="maxHeight" />
<MarkdownText v-else :source="parsed.text" />
```

No `v-html`; markdown goes through [MarkdownText.vue](../../../web/src/components/code/MarkdownText.vue) (segments + `CodeBlock` for fences). XSS surface unchanged.

`MarkdownText` headings/bullets/emphasis are out of scope for F05 (it currently handles fenced code and inline code only). Adding richer markdown is a separate issue; F05's prose branch renders text exactly as `MarkdownText` does today, which is acceptable for the v3 use case (tools mostly emit JSON; prose is short).

## 8. Test plan

### 8.1 `web/src/__tests__/json-tokenize.test.ts` (new)

One file, all assertions against the pure utility.

- `tokenizeJson > emits a key token for object members`
- `tokenizeJson > emits a string token for object values`
- `tokenizeJson > does not flip expectKey when a comma appears inside an array`
- `tokenizeJson > emits a key token after a comma when inside an object`
- `tokenizeJson > handles escaped quotes inside strings`
- `tokenizeJson > handles backslash escapes inside strings`
- `tokenizeJson > tokenises a negative number`
- `tokenizeJson > tokenises a number with exponent and decimal`
- `tokenizeJson > tokenises true, false, and null with their kinds`
- `tokenizeJson > emits punctuation tokens for braces, brackets, colon, comma`
- `tokenizeJson > preserves whitespace tokens for indentation`
- `tokenizeJson > does nothing destructive on an unterminated string` (defensive)

### 8.2 `web/src/__tests__/JsonView.test.ts` (new, component test)

- `JsonView > renders a span per token for a small object`
- `JsonView > skips tokenisation and renders a plain pre when input exceeds 1 MB` (constructs a >1 MB array, asserts `pre.json-raw` exists and `span.jt-key` does not)
- `JsonView > renders "undefined" when stringify returns undefined`

### 8.3 `web/src/__tests__/FormattedContent.test.ts` (new)

- `FormattedContent > renders direct JSON object through JsonView`
- `FormattedContent > renders direct JSON array through JsonView`
- `FormattedContent > falls back to text when a leading "{" is not valid JSON`
- `FormattedContent > extracts embedded JSON after the "Tool result:" prefix`
- `FormattedContent > extracts embedded JSON after the "Error:" prefix`
- `FormattedContent > leaves non-allowlisted prose with braces as text` (e.g. `I will write {config} to disk`)
- `FormattedContent > routes plain prose through MarkdownText`
- `FormattedContent > renders empty input as empty text` (no JsonView, no MarkdownText error)

### 8.4 `web/src/__tests__/tool-presenters.test.ts` (rewritten)

The existing string-headline assertions are removed entirely. New file structure: one `describe` per tool, two `it` blocks per tool (call + result), plus the fallback bucket. Every assertion inspects `headline` / `detail` as `InlinePart[]`.

Helper utilities (test-local):

```ts
function partsOfKind<K extends InlinePart['kind']>(parts: InlinePart[], kind: K): Extract<InlinePart, { kind: K }>[];
function textValues(parts: InlinePart[]): string[];
```

Test names (one per tool × call/result):

- `read_project_file > call emits a text part for the path` (asserts no `file` part, since project root is non-clickable)
- `read_project_file > result emits a single text part with line count and byte count`
- `read_file > call delegates to read_project_file`
- `read_file > result delegates to read_project_file`
- `list_project_files > call emits a text part for the directory`
- `list_project_files > result emits a single text part with entry count`
- `list_directory > call / result mirror list_project_files`
- `write_project_file > call emits a text path and a "chars" detail`
- `write_project_file > result emits "wrote Bs"`
- `run_project_command > call emits a code part with the command`
- `run_project_command > result emits exit 0 + tone ok + stdout tail in muted detail`
- `run_project_command > result on non-zero exit sets status error and tone danger`
- `run_shell_command > call / result mirror run_project_command`
- `start_and_wait > call / result mirror run_project_command`
- `wait_for_process > call emits "process pid"`
- `wait_for_process > result on exit 0 sets tone ok`
- `kill_process > call emits "process pid"`
- `kill_process > result emits "killed"`
- `activate_card > call emits "card id"`
- `activate_card > result emits "activated id" with status detail`
- (same pattern for `cancel_card`, `restart_card`, `delete_card`)
- `create_card > call uses title when provided, else type or "new card"`
- `create_card > result emits "created id" with type · status detail`
- `edit_card > call lists changed keys in detail`
- `edit_card > result emits "edited id"`
- `move_card > call emits "id → newParent"`
- `move_card > result emits "moved id"`
- `get_card > result emits title with type · status detail`
- `list_cards > call emits "all cards" when args are empty`
- `list_cards > result emits "N cards"`
- `get_tree > call emits "project tree" by default`
- `get_tree > result emits "tree fetched"`
- `get_status > call/result emit a muted summary`
- `get_plan_diary > call / result`
- `get_card_output > call / result`
- `report_goal_done > result emits "recorded done" with tone ok`
- `report_goal_failed > result emits "recorded failed" with tone danger`
- `report_goal_blocked > result emits "recorded blocked" with tone warn`
- `mark_goal_needs_corrections > call shows N issues in detail`
- `mark_goal_needs_corrections > result tone warn`
- `add_note > call / result`
- `list_notes > call / result`
- `get_note > call / result`
- `mark_note_handled > call / result`
- `read_runtime_events > call / result emit count`
- `read_runtime_errors > call / result emit count`
- `read_control_actions > call / result emit count`
- `list_processes_tool > call / result`
- `list_agent_sessions > call / result`
- `read_agent_session > call / result`
- `pause_runtime > call / result`
- `resume_runtime > call / result`
- `abort_goal > call / result`
- `restart_goal > call / result`
- `load_skill > call emits skill name; result emits "loaded name"`
- `mcp_tool_call > call emits mcp tool name; result emits muted summary`
- `list_card_history > call / result`
- `get_card_history_entry > call / result`
- `diff_card > call / result`
- `__default__ > call emits "(keys)" or empty headline plus muted args in detail`
- `__default__ > result on ok payload emits muted summary; status ok`
- `__default__ > result on payload with ok:false sets status error and tone danger`
- `presentToolResult > respects ctx.kind === 'tool_error' even when payload looks healthy`
- `presentToolResult > respects ctx.tool override when payload has no tool field`
- `presentToolCall > falls back to ctx.tool when the body lacks a function name`

Every test reads structured parts. There is no `view.headline.includes('…')` string match, no `headlineString` helper, and no implicit `.toString()` coercion.

## 9. Alternatives considered

### (a) Port v2 `JsonHighlight` + `FormattedContent` + per-tool parts — SELECTED

Pros: keeps v3 dark theme via existing `--syn-*` tokens, no new dependency, behaviour matches v2 byte-for-byte where it matters (key/value detection, prose+JSON allowlist), reuses `MarkdownText` so the XSS surface is unchanged. Small surface: one utility, two components, one rewritten module.

### (b) External dependency: `vue-json-pretty` or equivalent — REJECTED

`vue-json-pretty` and similar libraries (`vue3-json-viewer`, `json-tree-view`) ship their own CSS keyed off internal class names, not `--syn-*`. To match F01 we would either patch those CSS rules at runtime (brittle) or copy them into the project (defeats the point of a dependency). Bundle cost is ~10–20 kB minified for behaviour we already have in ~80 lines of pure TS. Accessibility is library-specific and unknown for the chip context. Embedded-JSON-after-prose detection is not provided; we would still need `FormattedContent` on top. Reject.

### (c) MDX-style renderer for tool detail — REJECTED

Treat tool result as MDX and let formatters emit a small tree. Adds a runtime MDX/MD parser, expands the XSS / sanitization surface (MDX allows arbitrary component invocation), and introduces a parser dependency for behaviour that is at most "JSON or markdown". The four `InlinePart` kinds cover every observed use case. Overkill.

### (d) Reuse `MarkdownText` for everything, have tools emit markdown — REJECTED

Existing v3 tools emit JSON (`read_project_file`, `run_project_command`, `list_cards`, …). Forcing the LLM to switch to markdown for chip rendering would require either a backend conversion layer or a prompt change applied to every tool, and the round-trip from structured JSON → markdown → DOM is ugly (no key/value highlighting, copy-as-JSON would round-trip through the renderer). Inline file/url affordances would have to be smuggled through link syntax, losing the distinction from real markdown links. Reject.

## 10. Non-goals

- No full DSL for inline parts beyond the four kinds (`text`, `file`, `url`, `code`).
- No streaming-aware JSON tokeniser; payloads arrive complete via the store.
- No replacement of highlight.js. `CodeBlock` still handles fenced code and non-JSON languages.
- No new sanitization library. `MarkdownText` stays the markdown surface.
- No project file root in this issue (see §4.3).
- No richer `MarkdownText` (headings/bullets/emphasis) in this issue.
- No changes to Pinia store data shapes (subsystem map invariant).
