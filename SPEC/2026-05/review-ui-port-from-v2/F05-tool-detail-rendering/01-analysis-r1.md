# F05 — Tool detail rendering: Functional Analysis (R1)

Scope: detail rendering for tool-call / tool-result chips in the v3 web UI. Goal: port the three v2 layers — token-aware JSON view, JSON-vs-prose auto-detection (including embedded-JSON-after-prose), and per-tool structured headlines/details with inline file / url / code parts — into v3 with no backward-compatibility carve-outs.

## 1. v3 today: current rendering pipeline

### 1.1 Tool chip expansion

Per the subsystem map ([00-SUBSYSTEM-MAP.md](../00-SUBSYSTEM-MAP.md)) the consumer surfaces are [web/src/components/agents/AgentConversationView.vue](../../../web/src/components/agents/AgentConversationView.vue) and [web/src/components/chat/AnalystChatPanel.vue](../../../web/src/components/chat/AnalystChatPanel.vue). Both render a chip that, when expanded, drops the raw step content into a single `<CodeBlock>` with `language="json"`. There is no auto-detect, no semantic colouring of JSON tokens, and no linkification of `path` / `url` arguments.

### 1.2 `CodeBlock`

`CodeBlock` ([web/src/components/code/CodeBlock.vue](../../../web/src/components/code/CodeBlock.vue)) is a thin highlight.js wrapper:

```ts
const props = withDefaults(defineProps<{
  code: string;
  language?: 'json' | 'bash' | 'diff' | 'typescript' | 'text';
  copyable?: boolean;
  maxHeight?: string;
  wrap?: boolean;
  ariaLabel?: string;
}>(), { language: 'text', copyable: false, maxHeight: '60vh', wrap: false });
```

Colour comes from `highlight.js/styles/github-dark.css` (the only stylesheet imported by [web/src/main.ts](../../../web/src/main.ts) per the subsystem map). The component hard-codes hex `#0d1117` / `#c9d1d9` — F01 will fix the token side; here we just stop using `CodeBlock` for JSON payloads and use `JsonView` instead, so colour comes from `--syn-*`.

### 1.3 `MarkdownText`

`MarkdownText` ([web/src/components/code/MarkdownText.vue](../../../web/src/components/code/MarkdownText.vue)) splits the source into `code` / `inline-code` / text segments via `splitMarkdownSegments` and renders fenced code with `CodeBlock`. We keep it as the prose renderer; the new `FormattedContent` will delegate to it for the non-JSON branch. Keeping `MarkdownText` for prose is what gives us safe rendering — there is no raw `v-html`, so the XSS surface is the same as today.

### 1.4 `tool-presenters.ts` (today)

[web/src/utils/tool-presenters.ts](../../../web/src/utils/tool-presenters.ts) already enumerates the v3 tool catalog. Its public surface today:

```ts
export interface ToolCallPresentation {
  icon: string;
  name: string;
  headline: string;            // flat string
  detail?: string;             // flat string
}

export interface ToolResultPresentation {
  icon: string;
  status: 'ok' | 'error';
  name: string;
  headline: string;            // flat string
  detail?: string;
}

export function presentToolCall(rawContent: string, fallbackName?: string): ToolCallPresentation;
export function presentToolResult(rawContent: string, opts?: { tool?: string; kind?: string }): ToolResultPresentation;
```

Tools currently surfaced by `CALL_PRESENTERS` / `RESULT_PRESENTERS` (enumerated from the file): `read_project_file`, `read_file`, `list_project_files`, `list_directory`, `write_project_file`, `run_project_command`, `run_shell_command`, `start_and_wait`, `wait_for_process`, `kill_process`, `activate_card`, `cancel_card`, `restart_card`, `delete_card`, `create_card`, `edit_card`, `move_card`, `get_card`, `list_cards`, `get_tree`, `get_status`, `get_plan_diary`, `get_card_output`, `report_goal_done`, `report_goal_failed`, `report_goal_blocked`, `mark_goal_needs_corrections`, `add_note`, `list_notes`, `get_note`, `mark_note_handled`, `read_runtime_events`, `read_runtime_errors`, `read_control_actions`, `list_processes_tool`, `list_agent_sessions`, `read_agent_session`, `pause_runtime`, `resume_runtime`, `abort_goal`, `restart_goal`, `load_skill`, `mcp_tool_call`, `list_card_history`, `get_card_history_entry`, `diff_card`. That set is what the new typed renderers must cover (and a generic fallback for unknowns).

Limitations the F05 work must remove:
- `headline` and `detail` are flat `string`s — no way to mark a substring as a file path that opens the Files view, a URL that opens a new tab, or inline code that wants `--syn-*` colour.
- The chip body falls back to a single `<CodeBlock language="json">` regardless of whether the payload is JSON, prose, or prose containing embedded JSON.
- No semantic token-aware JSON colouring; only highlight.js defaults.

## 2. v2 capabilities to port

### 2.1 Token-aware JSON view (`JsonHighlight.vue`)

[saivage/web/src/components/JsonHighlight.vue](../../../../saivage/web/src/components/JsonHighlight.vue) takes `data: unknown`, `JSON.stringify`s it with 2-space indent, then hand-tokenises it tracking a `{`/`[` stack so that strings appearing in the **key** position get `--syn-key` while strings in the **value** position get `--syn-string`. Token kinds and CSS bindings:

```ts
type Token =
  | { type: 'key';        text: string } // --syn-key
  | { type: 'string';     text: string } // --syn-string
  | { type: 'number';     text: string } // --syn-number
  | { type: 'boolean';    text: string } // --syn-boolean
  | { type: 'null';       text: string } // --syn-null (italic)
  | { type: 'brace'       /* {} */ }     // --syn-punctuation
  | { type: 'bracket'     /* [] */ }     // --syn-punctuation
  | { type: 'colon' | 'comma' | 'whitespace'; text: string };
```

Key invariants observed in v2:
- `expectKey` is set on `{` and re-set on `,` only when the current top-of-stack is `{` (so commas inside an array do not flip the next string into a key colour).
- All colours flow through `--syn-*` semantic tokens (which F01 supplies) — there are zero literal hex values inside the component.
- Container is `<pre class="json-hl">` with `white-space: pre-wrap`, `word-break: break-word`, scrollable with `maxHeight`.

### 2.2 JSON-vs-prose auto-detection (`FormattedContent.vue`)

[saivage/web/src/components/FormattedContent.vue](../../../../saivage/web/src/components/FormattedContent.vue) decides per render:

```ts
type ParsedContent =
  | { kind: 'json'; data: unknown }
  | { kind: 'text'; text: string };

// 1. trim; empty -> text
// 2. if starts with '{' or '[' try JSON.parse
// 3. else look for first '{' or '['; if the prefix is empty
//    OR matches /^(Tool call|Tool result|Result|Error|Response|Request)\b/i,
//    try JSON.parse of the candidate suffix
// 4. else text (rendered as markdown HTML)
```

Two affordances we must preserve:
- "Tool result: { ... }" style payloads get rendered as structured JSON, not as a code blob.
- The prose branch goes through the project's markdown renderer (v2 uses `renderMarkdown` from `utils/markdown`; v3 already has the equivalent `MarkdownText`, which we reuse so there is no new sanitization surface).

### 2.3 Per-tool `InlinePart[]` (`toolFormatters.ts`)

[saivage/web/src/utils/toolFormatters.ts](../../../../saivage/web/src/utils/toolFormatters.ts) exports:

```ts
export type InlinePart =
  | { kind: 'text';  value: string; tone?: 'muted' | 'ok' | 'warn' | 'error' }
  | { kind: 'code';  value: string }
  | { kind: 'file';  path: string; root?: 'project' | 'saivage' }
  | { kind: 'url';   url: string };

export interface FormattedToolPair {
  label: string;
  summary: InlinePart[];
  result: InlinePart[];
  resultTone?: 'muted' | 'ok' | 'warn' | 'error';
}

export function formatToolPair(
  toolName: string,
  argText: string | undefined,
  resultText: string | undefined,
  isError: boolean,
): FormattedToolPair;
```

The dispatch table at the end of the file (`FORMATTERS`) wires per-tool formatters: `read_file`, `write_file`, `list_dir`, `search_files`, `run_command`, `read_stash`, `git_status`, `git_log`, `git_diff`, `git_commit`, `read_skill`, `list_skills`, `web_search`, `fetch_url`, `fetch_page_text`, `download_file`, `download_with_fallbacks`, plus the `plan_*` family and the `run_manager`/`run_coder`/`run_researcher`/`run_data_agent`/`run_reviewer`/`run_inspector` dispatchers built via `dispatch(label, key)`. Unknown tools hit `genericFormatter`. Note that this v2 tool set targets v2's tool names; the v3 port will mirror the *shape* but populate the dispatch table with v3 tool names (the catalog in §1.4).

Two patterns from v2 worth keeping verbatim:
- `runCommand`: `summary = [{kind:'code', value: command}, ' (cwd …)']`; `result = [{kind:'text', value:'exit 0', tone:'ok'}, {kind:'text', value: ' · ' + tailLine(stdout), tone:'muted'}]`.
- `downloadFile`: `summary = [{kind:'url', url}, ' → ', {kind:'file', path, root:'project'}]`.

These already use `'file'` and `'url'` kinds — i.e. v2 designed them as click affordances.

## 3. New v3 module layout

### 3.1 `web/src/components/ui/JsonView.vue`

Direct port of `JsonHighlight.vue` renamed to fit v3's `ui/` namespace. Props:

```ts
const props = defineProps<{
  data: unknown;
  maxHeight?: string;       // default '60vh' to match CodeBlock
  copyable?: boolean;       // expose v3's copy affordance (CodeBlock has one)
}>();
```

Implementation copies the v2 tokenizer one-to-one. All colours come from `--syn-key`, `--syn-string`, `--syn-number`, `--syn-boolean`, `--syn-null`, `--syn-punctuation` (provided by F01). The container background uses `var(--code-block-bg)` and border `var(--code-block-border)` — same tokens `CodeBlock` will use after F01.

### 3.2 `web/src/components/ui/FormattedContent.vue`

```ts
type ParsedContent =
  | { kind: 'json'; data: unknown }
  | { kind: 'text'; text: string };

const props = withDefaults(defineProps<{
  content: string;
  maxHeight?: string;
}>(), { maxHeight: undefined });
```

Behaviour mirrors v2 (§2.2). Differences from v2:
- Markdown rendering goes through v3's `MarkdownText` component (segments + `CodeBlock` for fences) rather than `v-html` — same sanitization story v3 already accepts.
- `JsonView` is used for the JSON branch.

Template shape:

```vue
<template>
  <JsonView v-if="parsed.kind === 'json'" :data="parsed.data" :max-height="maxHeight" />
  <MarkdownText v-else :source="parsed.text" />
</template>
```

### 3.3 Extend `web/src/utils/tool-presenters.ts` (return type change, no parallel field)

Per the binding project guideline (no backward compatibility), we change `headline: string` to `headline: InlinePart[]`. Same for `detail`. All call sites get updated; no legacy `headlineText` field remains.

```ts
export type InlinePart =
  | { kind: 'text'; value: string; tone?: 'muted' | 'ok' | 'warn' | 'danger' }
  | { kind: 'code'; value: string }
  | { kind: 'file'; value: string; path: string; root?: 'project' | 'saivage' }
  | { kind: 'url';  value: string; url: string };

export interface ToolCallPresentation {
  icon: string;
  name: string;
  headline: InlinePart[];
  detail?: InlinePart[];
}

export interface ToolResultPresentation {
  icon: string;
  status: 'ok' | 'error';
  name: string;
  headline: InlinePart[];
  detail?: InlinePart[];
}

export interface FormattedToolPair {
  label: string;
  summary: InlinePart[];
  result: InlinePart[];
  resultTone?: 'muted' | 'ok' | 'warn' | 'danger';
}
```

Notes on the type:
- `value` exists on every variant so the renderer has one display string per part (e.g. `file` uses `value` for "look", `path` for the navigation target — they are usually equal but a formatter may want to display a shortened tail while routing on the full path).
- Tone vocabulary aligns with the v3 semantic palette: `ok` → `--ok`, `warn` → `--warn`, `danger` → `--danger`, `muted` → `--text-muted`. v2's `'error'` is renamed to `'danger'` to match the v3 token set defined in F01; this is a deliberate breaking rename per the guideline.

The rest of the file becomes a `FORMATTERS: Record<string, (args, res) => FormattedToolPair>` table that mirrors v2's structure but with v3 tool names. Each entry is a single function. Concrete sample (full file is the deliverable of the implementation issue, not this analysis):

```ts
const readProjectFile: Formatter = (args, res) => {
  const path = String(args.path ?? '');
  let result: InlinePart[];
  let tone: 'ok' | 'warn' | 'danger' | 'muted' = 'muted';
  if (res.isError) {
    result = errorParts(res);
    tone = 'danger';
  } else {
    const j = res.json as { content?: string; bytes?: number; lines?: number } | undefined;
    const bytes = j?.bytes ?? new TextEncoder().encode(j?.content ?? '').length;
    const lines = j?.lines ?? (j?.content ? j.content.split('\n').length : 0);
    result = [{ kind: 'text', value: `${plural(lines, 'line')} · ${formatBytes(bytes)}` }];
  }
  return {
    label: 'read',
    summary: [{ kind: 'file', value: shortPath(path), path, root: 'project' }],
    result,
    resultTone: tone,
  };
};

const runProjectCommand: Formatter = (args, res) => {
  const command = String(args.command ?? '').trim();
  const j = res.json as { exitCode?: number; stdout?: string; stderr?: string } | undefined;
  const stash = detectStash(res.raw);
  let result: InlinePart[];
  let tone: 'ok' | 'warn' | 'danger' | 'muted';
  if (res.isError) {
    result = errorParts(res); tone = 'danger';
  } else if (stash) {
    result = [{ kind: 'text', value: `stashed (${stash.chars.toLocaleString()} chars)`, tone: 'muted' }];
    tone = 'muted';
  } else if (j?.exitCode === 0) {
    const tail = tailLine(j.stdout ?? '');
    result = [
      { kind: 'text', value: 'exit 0', tone: 'ok' },
      ...(tail ? [{ kind: 'text' as const, value: ` · ${truncate(tail, 140)}`, tone: 'muted' as const }] : []),
    ];
    tone = 'ok';
  } else {
    const tail = tailLine(j?.stderr ?? '') || tailLine(j?.stdout ?? '') || res.raw;
    result = [
      { kind: 'text', value: `exit ${j?.exitCode ?? '?'}`, tone: 'danger' },
      { kind: 'text', value: ` · ${truncate(tail, 140)}`, tone: 'danger' },
    ];
    tone = 'danger';
  }
  return { label: '$', summary: [{ kind: 'code', value: truncate(command, 140) }], result, resultTone: tone };
};

const FORMATTERS: Record<string, Formatter> = {
  read_project_file: readProjectFile,
  read_file: readProjectFile,
  list_project_files: listProjectFiles,
  list_directory: listProjectFiles,
  write_project_file: writeProjectFile,
  run_project_command: runProjectCommand,
  run_shell_command: runProjectCommand,
  start_and_wait: runProjectCommand,
  wait_for_process: waitForProcess,
  kill_process: killProcess,
  activate_card: cardLifecycle('activated'),
  cancel_card: cardLifecycle('cancelled'),
  restart_card: cardLifecycle('restarted'),
  delete_card: cardLifecycle('deleted'),
  create_card: createCard,
  edit_card: editCard,
  move_card: moveCard,
  get_card: getCard,
  list_cards: listCards,
  get_tree: getTree,
  get_status: getStatus,
  get_plan_diary: getPlanDiary,
  get_card_output: getCardOutput,
  report_goal_done: reportGoal('done', 'ok'),
  report_goal_failed: reportGoal('failed', 'danger'),
  report_goal_blocked: reportGoal('blocked', 'warn'),
  mark_goal_needs_corrections: markGoalNeedsCorrections,
  add_note: addNote,
  list_notes: listNotes,
  get_note: getNote,
  mark_note_handled: markNoteHandled,
  read_runtime_events: readJsonlTail('events'),
  read_runtime_errors: readJsonlTail('errors'),
  read_control_actions: readJsonlTail('control actions'),
  list_processes_tool: listProcessesTool,
  list_agent_sessions: listAgentSessions,
  read_agent_session: readAgentSession,
  pause_runtime: simple('pause runtime'),
  resume_runtime: simple('resume runtime'),
  abort_goal: simple('abort goal'),
  restart_goal: simple('restart goal'),
  load_skill: loadSkill,
  mcp_tool_call: mcpToolCall,
  list_card_history: listCardHistory,
  get_card_history_entry: getCardHistoryEntry,
  diff_card: diffCard,
};
```

The `presentToolCall` and `presentToolResult` functions stay as the public entry points used by `AgentConversationView` / `AnalystChatPanel`; internally they now call into `formatToolPair` and split its output across call / result presentations.

## 4. Click affordances

`InlinePart` of kind `file` and `url` are rendered as clickable elements by a tiny new component (placed alongside the formatters, not as part of this issue's port logic — it is the rendering glue):

```vue
<!-- web/src/components/ui/InlineParts.vue -->
<template>
  <span class="inline-parts">
    <template v-for="(part, i) in parts" :key="i">
      <router-link
        v-if="part.kind === 'file'"
        class="inline-file"
        :to="{ name: 'files', query: { path: part.path, root: part.root ?? 'project' } }"
      >{{ part.value }}</router-link>
      <a
        v-else-if="part.kind === 'url'"
        class="inline-url"
        :href="part.url"
        target="_blank"
        rel="noopener noreferrer"
      >{{ part.value }}</a>
      <code v-else-if="part.kind === 'code'" class="inline-code">{{ part.value }}</code>
      <span v-else :class="['inline-text', part.tone ? `tone-${part.tone}` : null]">{{ part.value }}</span>
    </template>
  </span>
</template>
```

Routing target — based on [web/src/main.ts](../../../web/src/main.ts) (`{ path: '/files', name: 'files', component: Files }`) and [web/src/views/FilesView.vue](../../../web/src/views/FilesView.vue), which already reads `route.query.path` and calls `fileStore.navigateOutput(p)`:

- `file` parts push `{ name: 'files', query: { path, root } }`.
- `root: 'project'` (default) → `FilesView` resolves via `navigateOutput`.
- `root: 'saivage'` → `FilesView` resolves via `navigateMeta`. This is a small extension to the existing `route.query` watcher (it currently ignores `root`); it is in scope for F05 because without it the `file` part cannot point at `.saivage/` paths.
- `url` parts open in a new tab via `target="_blank" rel="noopener noreferrer"` (no auto-fetch, no preview proxy — that is explicitly a non-goal).

## 5. Risks and open questions

- JSON parser robustness on text that *starts* with `{` but is not JSON (e.g. log lines beginning with `{request_id=...}`). v2's `FormattedContent` already handles this by falling through to text on `JSON.parse` failure, but the embedded-JSON detector is more aggressive (it scans for the first `{` / `[`). We keep v2's `/^(Tool call|Tool result|Result|Error|Response|Request)\b/i` allowlist on the prefix to keep false positives bounded; without it, a markdown sentence "I will write `{config}` to disk" could be mis-parsed.
- Very large payloads. `JsonView` re-tokenises on every prop change. Same `>1 MB` cap that `CodeBlock` uses should apply: above 1 MB, render as a `<pre>` with the raw stringified JSON and no tokenisation. Cheaper than fighting GC.
- Markdown sanitization / XSS. v2's `FormattedContent` uses `v-html="renderedMarkdown"` (a known XSS surface mitigated only by the renderer itself). v3's `MarkdownText` does not use `v-html` — it splits into segments and emits text via `{{ }}` and code via `<CodeBlock>`. The port goes through `MarkdownText`, so we do not introduce a new XSS surface.
- Test churn. The return-type change of `tool-presenters.ts` will break every consumer that did `presentation.headline.length` or string concatenation on `.headline`. Audit and migrate; do not keep a `headlineText` shim.
- Tool catalog drift. v3 tools differ from v2 (e.g. `run_project_command` vs v2's `run_command`, the `*_card` family that v2 lacks). The dispatch table must enumerate v3's tools (§1.4) — copying v2's table verbatim would leave half the chips on the generic fallback.
- Inline parts at chip-header width. `headline` may overflow when it includes a long file path. The renderer uses `overflow: hidden; text-overflow: ellipsis` on the chip header and exposes the full path in the expanded body (where the full `JsonView` lives) — no per-part truncation that would break click targets.

## 6. Non-goals

- No full DSL for inline parts beyond the four kinds (`text` / `code` / `file` / `url`).
- No streaming-aware JSON tokeniser; payloads arrive already complete via the store.
- No replacement of highlight.js. `CodeBlock` still uses highlight.js for fenced code blocks inside markdown and for non-JSON languages (`bash`, `diff`, `typescript`). `JsonView` only replaces it for the JSON branch of `FormattedContent` and for chip expansion of tool payloads detected as JSON.
- No new sanitization library. `MarkdownText` stays the markdown surface.
- No changes to the agent / analyst store data shapes (subsystem map invariant).
