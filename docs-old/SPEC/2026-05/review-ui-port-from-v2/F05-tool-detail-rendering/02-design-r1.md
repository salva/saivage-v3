# F05 — Tool detail rendering: Design (R1)

Writer round 1. Approved analysis (binding):
[01-analysis-r2.md](01-analysis-r2.md) /
[ANALYSIS-APPROVED.md](ANALYSIS-APPROVED.md).
Companion approved analyses (cross-issue, binding):
[F02 r2](../F02-component-hierarchy/01-analysis-r2.md),
[F03 r2](../F03-conversation-rounds/01-analysis-r2.md),
[F04 r3](../F04-chat-surface-style/01-analysis-r3.md).
Project guideline (binding): **architecture-first, no backward
compatibility**. Every replaced type, helper, template, route field,
file route shape, and test is removed in the same commit set as its
replacement. No `string | InlinePart[]` shims, no `FormattedToolPair`
ghost, no aliased presenter exports, no `?path=` bare prefix sniffing
left in the watcher.

---

## 0. Scope

This design picks one implementation strategy for the F05 r2 contract
(`presentToolCall` / `presentToolResult` returning structured
`InlinePart[]` headline/detail, plus a token-aware JSON view and a
prose-vs-JSON `FormattedContent` shell, plus a chip group with a
single expand `<button>` and sibling file/url links, plus a
`FilesView` that accepts `?root=meta|output&path=`).

Two proposals are developed in full:

- [Proposal A — Focused fix](#proposal-a--focused-fix). Direct port of
  F05 r2 §2–§8 as one `tool-presenters.ts` module with `CALL_PRESENTERS`
  / `RESULT_PRESENTERS` maps plus a `__default__` bucket, a pure
  `json-tokenize.ts` utility, three new content components, and the
  chip group consumed by F03 r2 §7.2 / F04 r3 §3.3.
- [Proposal B — Registry-based presenters](#proposal-b--registry-based-presenters).
  Replace the giant `CALL_PRESENTERS` / `RESULT_PRESENTERS` maps with
  a `registerToolPresenter(name, { call?, result? })` registry and one
  file per tool under `web/src/tool-presenters/`, each file
  self-registering on import via a barrel.

A third option (Proposal C — schema-driven generic renderer) is
described briefly in [§9 Alternatives considered](#9-alternatives-considered)
and rejected.

[Recommendation](#10-recommendation) selects **Proposal B**.

---

## 1. Shared deliverables (both proposals)

These are identical in Proposal A and Proposal B. They follow F05 r2
exactly.

### 1.1 Exported `InlinePart` type

File: `web/src/utils/tool-presenters.ts` (proposal A) /
`web/src/tool-presenters/types.ts` (proposal B).

```ts
export type InlinePart =
  | { kind: 'text'; value: string; tone?: 'ok' | 'warn' | 'danger' | 'muted' }
  | { kind: 'file'; path: string; root: 'meta' | 'output' }
  | { kind: 'url';  url: string }
  | { kind: 'code'; value: string };
```

Four kinds, exhaustive. Renderer uses the discriminant only. No
shared `value` field across variants, no `headlineString` shim, no
`root: 'project'` (until the project file API lands; see F05 r2 §4.3).

### 1.2 Public presenter contract

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
  rawContent: string,
  fallbackName?: string,
): ToolCallPresentation;

export function presentToolResult(
  rawContent: string,
  ctx: { tool?: string; kind?: 'tool_result' | 'tool_error' },
): ToolResultPresentation;
```

`presentToolCall` and `presentToolResult` are independent. Neither
function consults the other's payload. Pairing is a surface concern
owned by F03 r2 (`entriesToTimeline`) and F04 r3 (`pairAnalystMessages`).

The old string-based `ToolCallPresentation` / `ToolResultPresentation`
exported from
[saivage-v3/web/src/utils/tool-presenters.ts](../../../web/src/utils/tool-presenters.ts)
is deleted in the same commit set, and so are the
`expandedDetail`/`toolCallView`/`toolResultView` callsites in
[AgentConversationView.vue](../../../web/src/components/agents/AgentConversationView.vue#L68-L106)
and [AnalystChatPanel.vue](../../../web/src/components/chat/AnalystChatPanel.vue#L36-L52).

### 1.3 `web/src/utils/json-tokenize.ts` (full skeleton)

Pure utility, zero Vue imports. Direct port of v2's `tokenize` in
[saivage/web/src/components/JsonHighlight.vue](../../../../saivage/web/src/components/JsonHighlight.vue#L11-L92).

```ts
// web/src/utils/json-tokenize.ts

export type TokenKind =
  | 'key' | 'string' | 'number' | 'boolean' | 'null'
  | 'brace' | 'bracket' | 'colon' | 'comma' | 'whitespace';

export interface Token {
  type: TokenKind;
  /** Raw source text for the token (no escaping transformations). */
  text: string;
}

/**
 * Tokenise a (typically pretty-printed) JSON document.
 *
 * The algorithm walks the input in one pass, maintaining a stack of
 * the most recent container opener ('{' or '[') and an `expectKey`
 * flag set to true immediately after '{' and after a ',' whose
 * enclosing container is an object. The flag distinguishes the two
 * string token kinds: object member names become `key` tokens, every
 * other quoted string becomes `string`.
 *
 * Defensive behaviour:
 *  - Unterminated strings consume to end-of-input and emit a single
 *    `string` token (no throw).
 *  - Unrecognised characters are emitted as a one-char `whitespace`
 *    token so the rendered output never loses bytes.
 */
export function tokenizeJson(input: string): Token[] {
  const tokens: Token[] = [];
  const stack: Array<'{' | '['> = [];
  let expectKey = false;
  let i = 0;
  const n = input.length;

  while (i < n) {
    const c = input[i];

    // Whitespace run
    if (c === ' ' || c === '\n' || c === '\r' || c === '\t') {
      let j = i + 1;
      while (j < n && /\s/.test(input[j])) j++;
      tokens.push({ type: 'whitespace', text: input.slice(i, j) });
      i = j;
      continue;
    }

    // Container open
    if (c === '{' || c === '[') {
      tokens.push({ type: c === '{' ? 'brace' : 'bracket', text: c });
      stack.push(c as '{' | '[');
      expectKey = c === '{';
      i++;
      continue;
    }

    // Container close
    if (c === '}' || c === ']') {
      tokens.push({ type: c === '}' ? 'brace' : 'bracket', text: c });
      stack.pop();
      expectKey = false;
      i++;
      continue;
    }

    // Colon (object key/value separator). Recognise ': ' as a single
    // token to mirror the v2 formatter's pretty-printed output.
    if (c === ':') {
      const next = input[i + 1] === ' ' ? ': ' : ':';
      tokens.push({ type: 'colon', text: next });
      expectKey = false;
      i += next.length;
      continue;
    }

    // Comma. Re-arms expectKey iff the enclosing container is '{'.
    if (c === ',') {
      tokens.push({ type: 'comma', text: ',' });
      expectKey = stack[stack.length - 1] === '{';
      i++;
      continue;
    }

    // String / key
    if (c === '"') {
      let j = i + 1;
      while (j < n) {
        const ch = input[j];
        if (ch === '\\' && j + 1 < n) { j += 2; continue; }
        if (ch === '"') { j++; break; }
        j++;
      }
      const text = input.slice(i, j);
      tokens.push({ type: expectKey ? 'key' : 'string', text });
      if (expectKey) expectKey = false;
      i = j;
      continue;
    }

    // Number
    if (c === '-' || (c >= '0' && c <= '9')) {
      let j = i + 1;
      while (j < n && /[0-9eE+.\-]/.test(input[j])) j++;
      tokens.push({ type: 'number', text: input.slice(i, j) });
      i = j;
      continue;
    }

    // true / false / null literals
    if (input.startsWith('true', i))  { tokens.push({ type: 'boolean', text: 'true'  }); i += 4; continue; }
    if (input.startsWith('false', i)) { tokens.push({ type: 'boolean', text: 'false' }); i += 5; continue; }
    if (input.startsWith('null', i))  { tokens.push({ type: 'null',    text: 'null'  }); i += 4; continue; }

    // Defensive: emit one byte as whitespace so we never lose input
    tokens.push({ type: 'whitespace', text: c });
    i++;
  }

  return tokens;
}
```

### 1.4 `web/src/components/content/JsonView.vue`

```vue
<script setup lang="ts">
import { computed } from 'vue';
import { tokenizeJson } from '../../utils/json-tokenize';

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

function classFor(type: string): string {
  if (type === 'key')     return 'jt-key syn-key';
  if (type === 'string')  return 'jt-string syn-string';
  if (type === 'number')  return 'jt-number syn-number';
  if (type === 'boolean') return 'jt-boolean syn-boolean';
  if (type === 'null')    return 'jt-null syn-null';
  if (type === 'brace' || type === 'bracket' || type === 'colon' || type === 'comma') return 'jt-punctuation syn-punctuation';
  return 'jt-ws';
}
</script>

<template>
  <pre v-if="oversize" class="json-raw" :style="{ maxHeight }">{{ formatted }}</pre>
  <pre v-else class="json-hl" :style="{ maxHeight }"
  ><span
      v-for="(tok, i) in tokens"
      :key="i"
      :class="classFor(tok.type)"
    >{{ tok.text }}</span></pre>
</template>

<style scoped>
.json-hl, .json-raw {
  margin: 0;
  padding: 8px 12px;
  overflow: auto;
  font-family: var(--font-mono);
  font-size: 12px;
  line-height: 1.45;
  background: var(--bg-elev);
  border: 1px solid var(--border);
  border-radius: 6px;
  color: var(--text);
  white-space: pre;
}
.jt-ws { white-space: pre; }
</style>
```

All colour comes from F01's `.syn-key`, `.syn-string`, `.syn-number`,
`.syn-boolean`, `.syn-null`, `.syn-punctuation` pattern classes (F01 r2
§2.1 inherits from v2 verbatim).

### 1.5 `web/src/components/content/FormattedContent.vue`

```vue
<script setup lang="ts">
import { computed } from 'vue';
import JsonView from './JsonView.vue';
import MarkdownText from './MarkdownText.vue';

const props = defineProps<{ content: string; maxHeight?: string }>();

type Parsed =
  | { kind: 'json'; data: unknown }
  | { kind: 'text'; text: string };

const PROSE_PREFIX = /^(Tool call|Tool result|Result|Error|Response|Request)\b/i;

function parseEmbeddedJson(text: string): Parsed {
  const trimmed = text.trimStart();
  if (!trimmed) return { kind: 'text', text: '' };

  // Direct JSON
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try { return { kind: 'json', data: JSON.parse(trimmed) }; } catch { /* fall through */ }
  }

  // Embedded JSON after an allow-listed prose prefix
  const objIdx = text.search(/[{\[]/);
  if (objIdx > 0) {
    const prefix = text.slice(0, objIdx).trim();
    if (prefix === '' || PROSE_PREFIX.test(prefix)) {
      try { return { kind: 'json', data: JSON.parse(text.slice(objIdx)) }; } catch { /* fall through */ }
    }
  }
  return { kind: 'text', text };
}

const parsed = computed<Parsed>(() => parseEmbeddedJson(props.content));
</script>

<template>
  <JsonView v-if="parsed.kind === 'json'" :data="parsed.data" :max-height="maxHeight" />
  <MarkdownText v-else :source="parsed.text" />
</template>
```

No `v-html`; the prose branch goes through `MarkdownText` (F02 r2
relocates from `code/` to `content/`).

### 1.6 Chip group Vue template (no nested interactive elements)

Owned by `conversation/ToolChip.vue` per F02 r2 §1 / F03 r2 §3.1. F04
r3 §3.3 consumes the same shape via `v-bind`.

```vue
<!-- web/src/components/conversation/ToolChip.vue (template only) -->
<template>
  <div
    class="tool-chip"
    :class="chipClass"
    role="group"
    :aria-label="ariaLabel"
  >
    <button
      type="button"
      class="tool-chip-toggle"
      :aria-expanded="expanded"
      :aria-controls="detailsId"
      :aria-label="expanded ? 'Collapse details' : 'Expand details'"
      @click="$emit('toggle')"
    >
      <span class="tool-chip-caret" aria-hidden="true">{{ expanded ? '▾' : '▸' }}</span>
    </button>
    <span class="tool-chip-icon" aria-hidden="true">{{ headIcon }}</span>
    <span class="tool-chip-name">{{ headName }}</span>
    <InlineParts class="tool-chip-headline" :parts="headHeadline" />
    <InlineParts v-if="headDetail.length" class="tool-chip-tag" :parts="headDetail" />
    <span v-if="timestamp" class="tool-chip-time" :title="timestamp">{{ shortTime }}</span>
  </div>

  <div
    v-if="expanded"
    :id="detailsId"
    class="tool-chip-detail"
  >
    <section v-if="call" class="tool-chip-section">
      <header class="tool-chip-section-head">call</header>
      <FormattedContent :content="call.rawContent" />
    </section>
    <section v-if="result" class="tool-chip-section">
      <header class="tool-chip-section-head">{{ result.status === 'error' ? 'error' : 'result' }}</header>
      <FormattedContent :content="result.rawContent" />
    </section>
  </div>
</template>
```

`InlineParts.vue` (one source of truth, consumed by both `ToolChip`
and any inline use site):

```vue
<script setup lang="ts">
import type { InlinePart } from '../../tool-presenters/types';
defineProps<{ parts: InlinePart[] }>();
function shortPath(p: string): string { return p.length > 64 ? '…' + p.slice(-63) : p; }
</script>

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
      class="inline-code code-inline"
    >{{ part.value }}</code><span
      v-else
      :class="['inline-text', part.tone ? `tone-${part.tone}` : null]"
    >{{ part.value }}</span></template>
  </span>
</template>
```

Status classes derive from `status`:

```ts
function chipClass(p: ToolCallPresentation | ToolResultPresentation): string {
  if (p.status === 'call')  return 'tool-chip-call';
  if (p.status === 'error') return 'tool-chip-error';
  return 'tool-chip-ok';
}
```

These three classes are scoped to the `ToolChip` SFC (per F02 r2
§2.3, not pattern classes).

The DOM never nests interactives: only the expand `<button>` is
inside the `role="group"`; `<a>` and `<router-link>` siblings sit
next to it. The detail body lives OUTSIDE the group, addressed by
`aria-controls=detailsId`.

### 1.7 `FilesView` routing changes

[saivage-v3/web/src/views/FilesView.vue](../../../web/src/views/FilesView.vue#L234-L250):

```ts
function applyQueryPath(): void {
  const p = route.query.path;
  const r = route.query.root;
  if (typeof p !== 'string') return;
  if (r === 'meta')   { fileStore.navigateMeta(p).catch(() => {});   return; }
  if (r === 'output') { fileStore.navigateOutput(p).catch(() => {}); return; }
  // Per the project guideline, no bare ?path= fallback survives. F03 r2
  // and F04 r3 emit { path, root } unconditionally; any other shape is
  // a caller bug and we ignore it.
}
```

```ts
watch(() => [route.query.path, route.query.root], () => applyQueryPath());
```

The watcher is widened to two keys. No prefix-sniffing fallback
(architecture-first: every navigation site emits `root` explicitly).

The other in-file callsites
([FilesView.vue#L32](../../../web/src/views/FilesView.vue#L32),
[#L44](../../../web/src/views/FilesView.vue#L44),
[#L71](../../../web/src/views/FilesView.vue#L71),
[#L83](../../../web/src/views/FilesView.vue#L83),
[#L98](../../../web/src/views/FilesView.vue#L98)) keep their direct
`navigateMeta` / `navigateOutput` calls — they are not router-driven.

### 1.8 Consumer surface changes (verbatim across both proposals)

**[AgentConversationView.vue](../../../web/src/components/agents/AgentConversationView.vue):**

- Delete the `tc-header` / `tr-header` blocks
  ([L63-L103](../../../web/src/components/agents/AgentConversationView.vue#L63-L103))
  and the bare `<CodeBlock>` expansion blocks they wrap.
- Replace with `<ToolChip v-bind="...">` (the prop shape comes from
  F03 r2 §7.2 — `{ call, result, status, expanded, detailsId, timestamp }`).
- Delete `toolCallView`, `toolResultView`, and `expandedDetail`
  helpers from the `<script setup>` block (their substring callsites
  go away with the templates).
- The store-owned `expandedToolCalls` Set continues to key by the
  paired chip id (F03 r2 §3.2). No new state.

**[AnalystChatPanel.vue](../../../web/src/components/chat/AnalystChatPanel.vue):**

- Delete the `<button class="tool-chip">` wrapper
  ([L36-L52](../../../web/src/components/chat/AnalystChatPanel.vue#L36-L52))
  and the bespoke `ChipParts` local interface.
- Replace with `<MessageItem :item="..." :expanded="..." />` per
  F04 r3 §3.3 / §3.4, which itself binds `<ToolChip v-bind="...">`.
- Delete `toolChipDetail` (now `FormattedContent`) and any local
  string-headline helpers.
- The `pendingToolInvocationsForActiveSession` rows route through
  the same chip with `result: null` and `status: 'call'`.

### 1.9 Status-derivation rules (shared)

`presentToolResult` derives status from two sources, in order:

1. `ctx.kind === 'tool_error'` → `status: 'error'`, regardless of payload.
2. Else parse payload; if `record.ok === false` OR `typeof record.error === 'string'` → `status: 'error'`.
3. Else `status: 'ok'`.

Error path is uniform: `headline = [{ kind: 'text', value: errorMessage, tone: 'danger' }]`,
`detail = []`. Per-tool result presenters are NEVER invoked on the
error path.

`presentToolCall` always returns `status: 'call'`.

---

## Proposal A — Focused fix

Direct port of F05 r2. One module owns the catalogue.

### A.1 File layout

```
web/src/utils/
  tool-presenters.ts         ← presentToolCall, presentToolResult, CALL_PRESENTERS, RESULT_PRESENTERS, __default__
  json-tokenize.ts           ← tokenizeJson (§1.3)
web/src/components/content/
  JsonView.vue               ← §1.4
  FormattedContent.vue       ← §1.5
  MarkdownText.vue           ← relocated from components/code/ by F02 r2 §1
  CodeBlock.vue              ← relocated from components/code/ by F02 r2 §1
web/src/components/conversation/
  ToolChip.vue               ← §1.6, owned by F02/F03
  InlineParts.vue            ← §1.6 (sub-component of ToolChip)
web/src/__tests__/
  json-tokenize.test.ts
  JsonView.test.ts
  FormattedContent.test.ts
  tool-presenters.test.ts    ← rewritten (no string assertions)
```

`tool-presenters.ts` exports:

```ts
export type { InlinePart };
export type { ToolCallPresentation, ToolResultPresentation, ToolStatus };
export function presentToolCall(rawContent: string, fallbackName?: string): ToolCallPresentation;
export function presentToolResult(rawContent: string, ctx?: { tool?: string; kind?: 'tool_result' | 'tool_error' }): ToolResultPresentation;
```

Nothing else is public. Internal helpers (`asRecord`, `oneLine`,
`shortPath`, `formatBytes`, `argKeys`, `readToolCallEnvelope`,
`makeContext`, `describeCardOutcome`, `describeJsonlTail`) stay
module-private.

### A.2 Internal type definitions

```ts
// internal to tool-presenters.ts

interface CallContext {
  args: Record<string, unknown>;
  rawArgs: unknown;
}

interface ResultContext {
  status: 'ok' | 'error';
  parsed: unknown;
  record: Record<string, unknown> | null;
  rawContent: string;
}

interface CallPresenter {
  icon: string;
  call(ctx: CallContext): { headline: InlinePart[]; detail: InlinePart[] };
}

interface ResultPresenter {
  iconOk: string;
  iconErr?: string;        // defaults to '⚠'
  result(ctx: ResultContext): { headline: InlinePart[]; detail: InlinePart[] };
}

const CALL_PRESENTERS:   Record<string, CallPresenter>;
const RESULT_PRESENTERS: Record<string, ResultPresenter>;
const DEFAULT_CALL_PRESENTER:   CallPresenter;
const DEFAULT_RESULT_PRESENTER: ResultPresenter;
```

Dispatch:

```ts
export function presentToolCall(rawContent: string, fallbackName?: string): ToolCallPresentation {
  const env = readToolCallEnvelope(rawContent, fallbackName);
  const presenter = CALL_PRESENTERS[env.name] ?? DEFAULT_CALL_PRESENTER;
  const ctx: CallContext = { args: asRecord(env.args) ?? {}, rawArgs: env.args };
  const { headline, detail } = presenter.call(ctx);
  return { icon: presenter.icon, name: env.name, headline, detail, status: 'call' };
}

export function presentToolResult(rawContent: string, ctx0: { tool?: string; kind?: 'tool_result' | 'tool_error' } = {}): ToolResultPresentation {
  const name = resolveResultName(rawContent, ctx0.tool);
  const parsed = safeJsonParse(rawContent);
  const record = asRecord(parsed);
  const isError = ctx0.kind === 'tool_error' || record?.ok === false || typeof record?.error === 'string';
  const status: 'ok' | 'error' = isError ? 'error' : 'ok';
  const ctx: ResultContext = { status, parsed, record, rawContent };
  const presenter = RESULT_PRESENTERS[name] ?? DEFAULT_RESULT_PRESENTER;

  if (status === 'error') {
    const message = str(record?.error ?? record?.message ?? parsed ?? rawContent);
    return {
      icon: presenter.iconErr ?? '⚠',
      name, status,
      headline: [{ kind: 'text', value: oneLine(message, 120), tone: 'danger' }],
      detail: [],
    };
  }

  const { headline, detail } = presenter.result(ctx);
  return { icon: presenter.iconOk, name, headline, detail, status };
}
```

### A.3 Per-tool coverage table (Proposal A)

The table below enumerates every tool currently in
[saivage-v3/web/src/utils/tool-presenters.ts](../../../web/src/utils/tool-presenters.ts)
and the parts emitted by the focused-fix presenter. `[…]` is a literal
`text` part; tone is in parentheses; `<file>`/`<url>`/`<code>` are
typed parts. The `tone` column applies to the result on the success
path; the error path always uses `danger` (§1.9).

| tool name                       | call.headline                              | call.detail                                | result.headline (ok)                       | result.detail (ok)        | result tone |
| ------------------------------- | ------------------------------------------ | ------------------------------------------ | ------------------------------------------ | ------------------------- | ----------- |
| `read_project_file`             | `[path]`                                   | `[]`                                       | `[N lines · B bytes]` or `[binary file]`   | `[]`                      | muted       |
| `read_file`                     | → same as `read_project_file`              | `[]`                                       | → same                                     | `[]`                      | muted       |
| `list_project_files`            | `[path]`                                   | `[]`                                       | `[N entries]`                              | `[]`                      | muted       |
| `list_directory`                | → same as `list_project_files`             | `[]`                                       | → same                                     | `[]`                      | muted       |
| `write_project_file`            | `[path]`                                   | `[N chars]`                                | `[wrote B]` or `[wrote file]`              | `[]`                      | ok          |
| `run_project_command`           | `<code:command>`                           | `[]`                                       | `[exit N · status]`                        | `[· process pid, muted]`  | ok / danger |
| `run_shell_command`             | → same as `run_project_command`            | `[]`                                       | → same                                     | → same                    | same        |
| `start_and_wait`                | → same                                     | `[]`                                       | → same                                     | → same                    | same        |
| `wait_for_process`              | `[process pid]`                            | `[]`                                       | `[exit N · status]` or `[completed]`       | `[process pid]`           | ok / danger |
| `kill_process`                  | `[process pid]`                            | `[]`                                       | `[killed]` or `[process signalled]`        | `[]`                      | ok          |
| `activate_card`                 | `[card id]`                                | `[]`                                       | `[activated id]`                           | `[status]`                | ok          |
| `cancel_card`                   | `[card id]`                                | `[]`                                       | `[cancelled id]`                           | `[status]`                | ok          |
| `restart_card`                  | `[card id]`                                | `[]`                                       | `[restarted id]`                           | `[status]`                | ok          |
| `delete_card`                   | `[card id]`                                | `[]`                                       | `[deleted id]`                             | `[]`                      | ok          |
| `create_card`                   | `[title or '<type> card' or 'new card']`   | `[type · parent N, muted]`                 | `[created id]`                             | `[type · status]`         | ok          |
| `edit_card`                     | `[card id]`                                | `[change keys, muted]`                     | `[edited id]`                              | `[changed keys, muted]`   | ok          |
| `move_card`                     | `[card id → newParent]`                    | `[]`                                       | `[moved id]`                               | `[]`                      | ok          |
| `get_card`                      | `[card id]`                                | `[]`                                       | `[title]` or `[card id]`                   | `[type · status, muted]`  | muted       |
| `list_cards`                    | `[filters or 'all cards']`                 | `[]`                                       | `[N cards]`                                | `[]`                      | muted       |
| `get_tree`                      | `[subtree id]` or `[project tree]`         | `[]`                                       | `[tree fetched]`                           | `[]`                      | muted       |
| `get_status`                    | `[project status]`                         | `[]`                                       | `[summary, muted]`                         | `[]`                      | muted       |
| `get_plan_diary`                | `[goal id]`                                | `[]`                                       | `[N entries]`                              | `[]`                      | muted       |
| `get_card_output`               | `[card id · last N lines]`                 | `[]`                                       | `[N lines · B bytes]`                      | `[]`                      | muted       |
| `report_goal_done`              | `[status_text, muted]`                     | `[]`                                       | `[recorded done report]`                   | `[]`                      | ok          |
| `report_goal_failed`            | `[status_text, muted]`                     | `[]`                                       | `[recorded failed report, danger]`         | `[]`                      | danger      |
| `report_goal_blocked`           | `[status_text, muted]`                     | `[]`                                       | `[recorded blocked report, warn]`          | `[]`                      | warn        |
| `mark_goal_needs_corrections`   | `[goal id]`                                | `[N issues, muted]`                        | `[corrections queued, warn]`               | `[]`                      | warn        |
| `add_note`                      | `[card id [kind]]`                         | `[content, muted]`                         | `[note id]` or `[note added]`              | `[]`                      | ok          |
| `list_notes`                    | `[card id]`                                | `[]`                                       | `[N notes]`                                | `[]`                      | muted       |
| `get_note`                      | `[note id on card id]`                     | `[]`                                       | `[content, muted]`                         | `[]`                      | muted       |
| `mark_note_handled`             | `[note id]`                                | `[]`                                       | `[note handled]`                           | `[]`                      | ok          |
| `read_runtime_events`           | `[events × N [kind]]`                      | `[]`                                       | `[N events]`                               | `[]`                      | muted       |
| `read_runtime_errors`           | `[errors × N]`                             | `[]`                                       | `[N errors]`                               | `[]`                      | muted       |
| `read_control_actions`          | `[control actions × N]`                    | `[]`                                       | `[N control actions]`                      | `[]`                      | muted       |
| `list_processes_tool`           | `[filter keys]` or `[all processes]`       | `[]`                                       | `[N processes]`                            | `[]`                      | muted       |
| `list_agent_sessions`           | `[agent sessions]`                         | `[]`                                       | `[N sessions]`                             | `[]`                      | muted       |
| `read_agent_session`            | `[session id]`                             | `[]`                                       | `[N messages]`                             | `[]`                      | muted       |
| `pause_runtime`                 | `[pause runtime]`                          | `[]`                                       | `[paused]`                                 | `[]`                      | ok          |
| `resume_runtime`                | `[resume runtime]`                         | `[]`                                       | `[resumed]`                                | `[]`                      | ok          |
| `abort_goal`                    | `[goal id]`                                | `[]`                                       | `[aborted]`                                | `[]`                      | ok          |
| `restart_goal`                  | `[goal id]`                                | `[]`                                       | `[restarted]`                              | `[]`                      | ok          |
| `load_skill`                    | `[skill name]`                             | `[]`                                       | `[loaded name]` or `[skill loaded]`        | `[]`                      | ok          |
| `mcp_tool_call`                 | `[tool name]`                              | `[params, muted]`                          | `[summary, muted]`                         | `[]`                      | muted       |
| `list_card_history`             | `[card id]`                                | `[]`                                       | `[N entries]`                              | `[]`                      | muted       |
| `get_card_history_entry`        | `[card id @ vN]`                           | `[]`                                       | `[author · date, muted]`                   | `[]`                      | muted       |
| `diff_card`                     | `[card id]`                                | `[]`                                       | `[N changes]`                              | `[]`                      | muted       |
| **`__default__`** (unknown)     | `[(argKeys)]` or `[]`                      | `[oneLine(args), muted]`                   | `[oneLine(summary/message/raw), muted]`    | `[]`                      | ok / error  |

Path arguments for `read_project_file` / `read_file` /
`write_project_file` / `list_project_files` / `list_directory` /
`get_card_output` are emitted as `{ kind: 'text', value: path }`, not
`{ kind: 'file' }`, because v3 does not expose the project root (F05
r2 §4.3). The day a project root lands, only the table entries
above need to switch to `{ kind: 'file', path, root: 'project' }`.

### A.4 Test plan (Proposal A)

Identical to F05 r2 §8. Recapped here so the proposal is self-contained:

- `web/src/__tests__/json-tokenize.test.ts` — 12 cases on the pure
  tokeniser (key after `{`, key after `,` inside `{` only, escaped
  quotes, escaped backslash, signed/exponent numbers,
  `true`/`false`/`null`, punctuation, whitespace preservation,
  unterminated-string defensive).
- `web/src/__tests__/JsonView.test.ts` — three component cases (token
  spans, oversize raw fallback, `undefined` stringify).
- `web/src/__tests__/FormattedContent.test.ts` — eight cases (direct
  object, direct array, malformed leading `{` → text, embedded JSON
  after `Tool result:` / `Error:`, non-allowlisted brace prose stays
  text, plain prose routes to `MarkdownText`, empty input → empty
  text).
- `web/src/__tests__/tool-presenters.test.ts` — rewritten, one
  `describe` per tool plus `__default__`, plus three call/result
  context cases (`ctx.kind === 'tool_error'` override; `ctx.tool`
  fallback; `fallbackName` on the call side). Every assertion
  inspects `InlinePart[]` via two test-local helpers:

  ```ts
  function partsOfKind<K extends InlinePart['kind']>(parts: InlinePart[], kind: K): Extract<InlinePart, { kind: K }>[];
  function textValues(parts: InlinePart[]): string[];
  ```

  Names: see F05 r2 §8.4 (40+ tests). Zero string-match assertions.

### A.5 Pros / cons of Proposal A

**Pros**

- Minimal new files. One module (`tool-presenters.ts`), one utility
  (`json-tokenize.ts`), three SFCs (`JsonView`, `FormattedContent`,
  `InlineParts`), one rewritten test file. Matches F05 r2 line for line.
- One reading order: open `tool-presenters.ts`, scroll to a tool
  name, see exactly what it emits.
- Adding a new tool is one keyboard line in one map plus one test
  case; no module-creation overhead.

**Cons**

- Today's [tool-presenters.ts](../../../web/src/utils/tool-presenters.ts)
  is already 380 lines with a string contract; the
  `InlinePart[]`-returning version will be ~600 lines. Past 700 lines,
  PR diffs that touch two tools start to look noisy because they share
  a file.
- Per-tool tests live in one `tool-presenters.test.ts`. With 45+ tools
  and ~2 cases each, that file pushes ~1500 lines. Test failures
  bisect cleanly, but reviewers reading "what does `create_card`
  emit" page through the same file regardless of how unrelated their
  current change is.
- The `CALL_PRESENTERS` / `RESULT_PRESENTERS` records and the
  default bucket are special-cased in the dispatch function; new
  presenter kinds (e.g. a streaming-aware variant or per-tool
  custom expand body) require code edits to the dispatch.

---

## Proposal B — Registry-based presenters

The big maps disappear. Each tool registers itself by importing a
shared `registerToolPresenter(name, presenter)` from its own module
file. The dispatch function looks up `name` in a single `Map<string,
ToolPresenter>` that is built up by side-effectful imports.

### B.1 File layout

```
web/src/tool-presenters/
  types.ts                       ← public types (InlinePart, presentations, presenter contract)
  registry.ts                    ← registerToolPresenter, presentToolCall, presentToolResult, __default__ bucket
  helpers.ts                     ← shared helpers: oneLine, shortPath, formatBytes, asRecord, str, partsFromCommandResult, describeCardOutcome, describeJsonlTail
  index.ts                       ← side-effect barrel: imports every per-tool file once, re-exports the public API
  __default__.ts                 ← fallback bucket presenter
  read_project_file.ts
  read_file.ts                   ← `registerAlias('read_file', 'read_project_file')` (one-line file)
  list_project_files.ts
  list_directory.ts              ← alias
  write_project_file.ts
  run_project_command.ts
  run_shell_command.ts           ← alias
  start_and_wait.ts              ← alias
  wait_for_process.ts
  kill_process.ts
  activate_card.ts
  cancel_card.ts
  restart_card.ts
  delete_card.ts
  create_card.ts
  edit_card.ts
  move_card.ts
  get_card.ts
  list_cards.ts
  get_tree.ts
  get_status.ts
  get_plan_diary.ts
  get_card_output.ts
  report_goal_done.ts
  report_goal_failed.ts
  report_goal_blocked.ts
  mark_goal_needs_corrections.ts
  add_note.ts
  list_notes.ts
  get_note.ts
  mark_note_handled.ts
  read_runtime_events.ts
  read_runtime_errors.ts
  read_control_actions.ts
  list_processes_tool.ts
  list_agent_sessions.ts
  read_agent_session.ts
  pause_runtime.ts
  resume_runtime.ts
  abort_goal.ts
  restart_goal.ts
  load_skill.ts
  mcp_tool_call.ts
  list_card_history.ts
  get_card_history_entry.ts
  diff_card.ts

web/src/utils/
  json-tokenize.ts               ← §1.3 (unchanged from Proposal A)

web/src/components/content/
  JsonView.vue                   ← §1.4
  FormattedContent.vue           ← §1.5
  MarkdownText.vue, CodeBlock.vue (relocated per F02 r2)

web/src/components/conversation/
  ToolChip.vue                   ← §1.6
  InlineParts.vue

web/src/__tests__/
  json-tokenize.test.ts
  JsonView.test.ts
  FormattedContent.test.ts
  tool-presenters/
    registry.test.ts             ← dispatch behaviour, __default__, error path, ctx.tool, ctx.kind overrides
    read_project_file.test.ts
    write_project_file.test.ts
    run_project_command.test.ts
    create_card.test.ts
    edit_card.test.ts
    move_card.test.ts
    get_card.test.ts
    list_cards.test.ts
    report_goal_*.test.ts        ← one per goal-report verb
    mark_goal_needs_corrections.test.ts
    add_note.test.ts
    list_notes.test.ts
    get_note.test.ts
    mark_note_handled.test.ts
    read_runtime_events.test.ts
    read_runtime_errors.test.ts
    read_control_actions.test.ts
    mcp_tool_call.test.ts
    aliases.test.ts              ← read_file → read_project_file, list_directory → list_project_files, run_shell_command + start_and_wait → run_project_command
    coverage.test.ts             ← asserts every tool name in `EXPECTED_TOOL_NAMES` registers a call AND result presenter (or aliases one)
```

`web/src/tool-presenters/index.ts` is the **only** entry point:

```ts
// web/src/tool-presenters/index.ts
import './read_project_file';
import './read_file';
import './list_project_files';
import './list_directory';
import './write_project_file';
import './run_project_command';
import './run_shell_command';
import './start_and_wait';
import './wait_for_process';
import './kill_process';
// … one line per tool file …
import './diff_card';
import './__default__';

export { presentToolCall, presentToolResult } from './registry';
export type { InlinePart, ToolCallPresentation, ToolResultPresentation, ToolStatus } from './types';
```

A small lint rule (or a `coverage.test.ts` assertion, see B.5) keeps
the barrel honest: every file in the directory must appear in
`index.ts`, and `EXPECTED_TOOL_NAMES` must equal the registry keys
modulo aliases.

### B.2 Public types and registry contract

`web/src/tool-presenters/types.ts`:

```ts
export type InlinePart =
  | { kind: 'text'; value: string; tone?: 'ok' | 'warn' | 'danger' | 'muted' }
  | { kind: 'file'; path: string; root: 'meta' | 'output' }
  | { kind: 'url';  url: string }
  | { kind: 'code'; value: string };

export type ToolStatus = 'call' | 'ok' | 'error';

export interface ToolCallPresentation {
  icon: string;
  name: string;
  headline: InlinePart[];
  detail: InlinePart[];
  status: 'call';
}

export interface ToolResultPresentation {
  icon: string;
  name: string;
  headline: InlinePart[];
  detail: InlinePart[];
  status: 'ok' | 'error';
}

export interface CallContext {
  args: Record<string, unknown>;
  rawArgs: unknown;
}

export interface ResultContext {
  status: 'ok' | 'error';
  parsed: unknown;
  record: Record<string, unknown> | null;
  rawContent: string;
}

export interface ToolCallPresenter {
  icon: string;
  call(ctx: CallContext): { headline: InlinePart[]; detail: InlinePart[] };
}

export interface ToolResultPresenter {
  iconOk: string;
  iconErr?: string;     // defaults to '⚠'
  result(ctx: ResultContext): { headline: InlinePart[]; detail: InlinePart[] };
}

export interface ToolPresenter {
  call?: ToolCallPresenter;
  result?: ToolResultPresenter;
}
```

`web/src/tool-presenters/registry.ts`:

```ts
import type {
  CallContext, ResultContext, InlinePart,
  ToolCallPresentation, ToolResultPresentation,
  ToolPresenter,
} from './types';
import { asRecord, oneLine, readToolCallEnvelope, resolveResultName, safeJsonParse, str } from './helpers';

const REGISTRY = new Map<string, ToolPresenter>();
const ALIASES  = new Map<string, string>();
let DEFAULT_PRESENTER: ToolPresenter | null = null;

/** Register call+result presenters for a tool. Idempotent within one boot. */
export function registerToolPresenter(name: string, presenter: ToolPresenter): void {
  if (REGISTRY.has(name)) {
    throw new Error(`tool-presenters: duplicate registration for "${name}"`);
  }
  REGISTRY.set(name, presenter);
}

/** Make `aliasName` resolve to the presenter registered under `target`. */
export function registerAlias(aliasName: string, target: string): void {
  if (ALIASES.has(aliasName)) {
    throw new Error(`tool-presenters: duplicate alias for "${aliasName}"`);
  }
  ALIASES.set(aliasName, target);
}

/** Register the default fallback presenter (called for unknown tool names). */
export function registerDefaultPresenter(presenter: ToolPresenter): void {
  if (DEFAULT_PRESENTER) {
    throw new Error('tool-presenters: default presenter already registered');
  }
  DEFAULT_PRESENTER = presenter;
}

function resolve(name: string): ToolPresenter {
  const target = ALIASES.get(name) ?? name;
  return REGISTRY.get(target) ?? assertDefault();
}

function assertDefault(): ToolPresenter {
  if (!DEFAULT_PRESENTER) throw new Error('tool-presenters: default presenter not registered (forgot to import barrel?)');
  return DEFAULT_PRESENTER;
}

/** Internal: enumerate registered names. Used by coverage.test.ts. */
export function _registryKeysForTest(): { tools: string[]; aliases: Array<[string, string]> } {
  return { tools: [...REGISTRY.keys()], aliases: [...ALIASES.entries()] };
}

export function presentToolCall(rawContent: string, fallbackName?: string): ToolCallPresentation {
  const env = readToolCallEnvelope(rawContent, fallbackName);
  const presenter = resolve(env.name);
  const call = presenter.call ?? assertDefault().call!;
  const ctx: CallContext = { args: asRecord(env.args) ?? {}, rawArgs: env.args };
  const { headline, detail } = call.call(ctx);
  return { icon: call.icon, name: env.name, headline, detail, status: 'call' };
}

export function presentToolResult(
  rawContent: string,
  ctx0: { tool?: string; kind?: 'tool_result' | 'tool_error' } = {},
): ToolResultPresentation {
  const name = resolveResultName(rawContent, ctx0.tool);
  const parsed = safeJsonParse(rawContent);
  const record = asRecord(parsed);
  const isError = ctx0.kind === 'tool_error' || record?.ok === false || typeof record?.error === 'string';
  const status: 'ok' | 'error' = isError ? 'error' : 'ok';
  const ctx: ResultContext = { status, parsed, record, rawContent };
  const presenter = resolve(name);
  const result = presenter.result ?? assertDefault().result!;

  if (status === 'error') {
    const message = str(record?.error ?? record?.message ?? parsed ?? rawContent);
    return {
      icon: result.iconErr ?? '⚠',
      name, status,
      headline: [{ kind: 'text', value: oneLine(message, 120), tone: 'danger' }],
      detail: [],
    };
  }

  const { headline, detail } = result.result(ctx);
  return { icon: result.iconOk, name, headline, detail, status };
}
```

### B.3 Example per-tool files

`web/src/tool-presenters/read_project_file.ts`:

```ts
import { registerToolPresenter } from './registry';
import { asRecord, formatBytes, shortPath, str } from './helpers';
import type { InlinePart } from './types';

registerToolPresenter('read_project_file', {
  call: {
    icon: '📖',
    call: ({ args }): { headline: InlinePart[]; detail: InlinePart[] } => ({
      headline: [{ kind: 'text', value: shortPath(str(args.path)) }],
      detail: [],
    }),
  },
  result: {
    iconOk: '↩',
    result: ({ record, rawContent }): { headline: InlinePart[]; detail: InlinePart[] } => {
      const rec = asRecord(record) ?? null;
      if (!rec) return { headline: [{ kind: 'text', value: rawContent.slice(0, 96) }], detail: [] };
      if (rec.binary === true) return { headline: [{ kind: 'text', value: 'binary file' }], detail: [] };
      const content = typeof rec.content === 'string' ? rec.content : '';
      const bytes = typeof rec.bytes === 'number' ? rec.bytes : content.length;
      const lines = content ? content.split('\n').length : typeof rec.lines === 'number' ? rec.lines : 0;
      const text = lines ? `${lines} lines · ${formatBytes(bytes)}` : formatBytes(bytes);
      return { headline: [{ kind: 'text', value: text, tone: 'muted' }], detail: [] };
    },
  },
});
```

`web/src/tool-presenters/read_file.ts` (one-line alias):

```ts
import { registerAlias } from './registry';
registerAlias('read_file', 'read_project_file');
```

`web/src/tool-presenters/run_project_command.ts`:

```ts
import { registerToolPresenter } from './registry';
import { asRecord, oneLine, str } from './helpers';
import type { InlinePart } from './types';

registerToolPresenter('run_project_command', {
  call: {
    icon: '⚡',
    call: ({ args }) => ({
      headline: [{ kind: 'code', value: oneLine(args.command, 80) }],
      detail: [],
    }),
  },
  result: {
    iconOk: '↩',
    result: ({ record }) => {
      const exit = typeof record?.exitCode === 'number' ? record.exitCode : typeof record?.exit_code === 'number' ? record.exit_code : null;
      const status = typeof record?.status === 'string' ? record.status : null;
      const timedOut = record?.timedOut === true || record?.timed_out === true;
      const procId = typeof record?.id === 'string' ? record.id : typeof record?.processId === 'string' ? record.processId : null;
      const segs: string[] = [];
      if (exit !== null) segs.push(`exit ${exit}`);
      if (status) segs.push(status);
      if (timedOut) segs.push('timed out');
      const tone = exit !== null && exit !== 0 ? 'danger' : undefined;
      const headline: InlinePart[] = segs.length ? [{ kind: 'text', value: segs.join(' · '), tone }] : [{ kind: 'text', value: 'completed' }];
      const detail: InlinePart[] = procId ? [{ kind: 'text', value: `process ${procId}`, tone: 'muted' }] : [];
      return { headline, detail };
    },
  },
});
```

`web/src/tool-presenters/__default__.ts`:

```ts
import { registerDefaultPresenter } from './registry';
import { argKeys, asRecord, oneLine, str } from './helpers';
import type { InlinePart } from './types';

registerDefaultPresenter({
  call: {
    icon: '🔧',
    call: ({ args, rawArgs }) => {
      const keys = argKeys(args);
      const headline: InlinePart[] = keys ? [{ kind: 'text', value: `(${keys})` }] : [];
      const detail: InlinePart[] = oneLine(rawArgs, 96) ? [{ kind: 'text', value: oneLine(rawArgs, 96), tone: 'muted' }] : [];
      return { headline, detail };
    },
  },
  result: {
    iconOk: '↩',
    result: ({ record, parsed, rawContent }) => {
      const text = str(asRecord(record)?.summary ?? asRecord(record)?.message ?? asRecord(record)?.content ?? parsed ?? rawContent);
      return { headline: [{ kind: 'text', value: oneLine(text, 120), tone: 'muted' }], detail: [] };
    },
  },
});
```

### B.4 Per-tool coverage table (Proposal B)

**Identical** to Proposal A's table in [§A.3](#a3-per-tool-coverage-table-proposal-a)
— Proposal B preserves the same output semantics. The only difference
is *where* each row lives:

| tool family                   | implementation file                                  |
| ----------------------------- | ---------------------------------------------------- |
| read_project_file, read_file  | `read_project_file.ts` + `read_file.ts` (alias)      |
| list_project_files, list_directory | `list_project_files.ts` + alias                  |
| write_project_file            | `write_project_file.ts`                              |
| run_project_command, run_shell_command, start_and_wait, wait_for_process | `run_project_command.ts` + 3 aliases (`wait_for_process` is its own file because the headline differs; see below) |
| kill_process                  | `kill_process.ts`                                    |
| card mutations (activate / cancel / restart / delete / create / edit / move / get / list) | one file each (`activate_card.ts`, … `list_cards.ts`); all four "outcome verb" tools (activate, cancel, restart, delete, create, edit, move) share a `helpers.describeCardOutcome` |
| tree, status, plan diary, card output | one file each                                |
| goal reports (done / failed / blocked / mark needs corrections) | one file each |
| notes (add / list / get / mark_handled) | one file each                              |
| runtime tails (events / errors / control actions) | one file each, sharing `helpers.describeJsonlTail` |
| process / session listings (list_processes_tool, list_agent_sessions, read_agent_session) | one file each |
| runtime control (pause / resume / abort_goal / restart_goal) | one file each   |
| skill / mcp / card history (load_skill, mcp_tool_call, list_card_history, get_card_history_entry, diff_card) | one file each |
| fallback                      | `__default__.ts` via `registerDefaultPresenter`      |

Aliasing rules:

- `read_file` → `read_project_file`
- `list_directory` → `list_project_files`
- `run_shell_command` → `run_project_command`
- `start_and_wait` → `run_project_command`
- (`wait_for_process` keeps its own file: its call headline is
  `[process pid]`, not the command.)

### B.5 `coverage.test.ts` (registry safety net)

```ts
// web/src/__tests__/tool-presenters/coverage.test.ts
import { describe, it, expect } from 'vitest';
import '../../tool-presenters';                                  // side-effect: register everything
import { _registryKeysForTest } from '../../tool-presenters/registry';

const EXPECTED_TOOL_NAMES = [
  'read_project_file','read_file','list_project_files','list_directory',
  'write_project_file','run_project_command','run_shell_command','start_and_wait',
  'wait_for_process','kill_process',
  'activate_card','cancel_card','restart_card','delete_card','create_card','edit_card','move_card','get_card','list_cards',
  'get_tree','get_status','get_plan_diary','get_card_output',
  'report_goal_done','report_goal_failed','report_goal_blocked','mark_goal_needs_corrections',
  'add_note','list_notes','get_note','mark_note_handled',
  'read_runtime_events','read_runtime_errors','read_control_actions',
  'list_processes_tool','list_agent_sessions','read_agent_session',
  'pause_runtime','resume_runtime','abort_goal','restart_goal',
  'load_skill','mcp_tool_call','list_card_history','get_card_history_entry','diff_card',
] as const;

describe('tool-presenter registry coverage', () => {
  const { tools, aliases } = _registryKeysForTest();
  const aliasNames = new Set(aliases.map(([from]) => from));
  const all = new Set([...tools, ...aliasNames]);

  it('registers every expected tool name (directly or via alias)', () => {
    for (const name of EXPECTED_TOOL_NAMES) {
      expect(all.has(name), `missing presenter for ${name}`).toBe(true);
    }
  });

  it('contains no presenters not listed in EXPECTED_TOOL_NAMES', () => {
    for (const name of all) expect(EXPECTED_TOOL_NAMES).toContain(name as typeof EXPECTED_TOOL_NAMES[number]);
  });
});
```

### B.6 Test plan (Proposal B)

`registry.test.ts` covers dispatch and the error path:

- `presentToolCall > resolves a registered name`
- `presentToolCall > follows an alias`
- `presentToolCall > falls back to __default__ for an unknown name`
- `presentToolCall > uses fallbackName when the body lacks a function name`
- `presentToolResult > respects ctx.kind === 'tool_error' even when payload looks healthy`
- `presentToolResult > respects ctx.tool override when payload has no tool field`
- `presentToolResult > error path sets status error, headline tone danger, detail []`
- `registerToolPresenter > throws on duplicate registration`
- `registerAlias > throws on duplicate alias`

Per-tool tests live in `web/src/__tests__/tool-presenters/<tool>.test.ts`,
each one importing only its own tool file plus the registry. Sample
shape:

```ts
import { describe, it, expect } from 'vitest';
import '../../tool-presenters/registry';      // ensure registry exists
import '../../tool-presenters/read_project_file';
import { presentToolCall, presentToolResult } from '../../tool-presenters/registry';

describe('read_project_file', () => {
  it('call emits a text part for the path', () => { /* … */ });
  it('result emits a single text part with line count and byte count', () => { /* … */ });
  it('result on binary payload emits "binary file"', () => { /* … */ });
});
```

`aliases.test.ts` asserts that the aliased tools emit identical output
to their target for a sample of fixtures.

`json-tokenize.test.ts`, `JsonView.test.ts`, and
`FormattedContent.test.ts` are identical to Proposal A.

### B.7 Pros / cons of Proposal B

**Pros**

- **Per-tool tests in isolation.** A regression in `create_card`
  result formatting fails one ~100-line test file, not a 1500-line
  monolith. Reviewer cognitive load drops to "the file named after
  the tool that changed".
- **Adding a new tool is one new file and one barrel line.** No diff
  noise in unrelated tools. PRs that add three tools touch 6 files
  (3 new + 3 lines in `index.ts`) rather than 60–100 lines in one
  shared module.
- **`coverage.test.ts` mechanises the "every tool must be covered"
  rule** that today lives only in code review. A future tool added
  to the backend but not the UI fails CI immediately.
- **Aliasing is explicit.** Instead of `read_file: (ctx) =>
  RESULT_PRESENTERS.read_project_file(ctx)` (Proposal A's pattern),
  `read_file.ts` is a one-line `registerAlias` that documents
  intent.
- **Registry surface invites future extensions** without changing the
  dispatch site: e.g. an optional `expand: { body(ctx): VNode }`
  field for tools that want a custom expand body (the
  `diff_card`-as-side-by-side-diff use case in F03 r2 §11), or a
  `streaming: true` flag, without touching `registry.ts`.

**Cons**

- **45 new files** under `web/src/tool-presenters/`. Tree noise is
  real; mitigated by their predictable naming and by the fact that
  the dispatch entry point is a single `index.ts`.
- **Side-effect-on-import pattern** must be exercised exactly once.
  We rely on `index.ts` being the only entry point; the
  `coverage.test.ts` net + the `assertDefault()` throw catches the
  "forgot to import the barrel" mistake at the first call site.
- **Bundle splitting is harder** if we ever want it: every presenter
  is loaded eagerly with the barrel. (Not a concern today — the
  combined module is ~600 lines, smaller than `lucide-vue-next`.)

---

## 9. Alternatives considered

### (a) Structured content tree (ContentNode with children) — rejected

Model the chip body as `ContentNode = { kind, children?: ContentNode[] }`
so a `tool_result` containing a diff that contains code blocks could be
expressed as a tree. The four `InlinePart` kinds cover every observed
v3 tool payload; the deepest legitimate nesting is "JSON document
containing strings that happen to be paths" which `InlinePart` already
expresses via sibling parts. A nested tree would also force the
renderer to recurse, multiplying ARIA decisions (each level needs its
own `role`/`aria-label`). The win is hypothetical (no tool currently
emits nested structured content); the cost is real (renderer
complexity, test surface area). Reject.

### (b) JSON-Schema-driven generic renderer — rejected

Each tool declares a schema describing its result shape; a single
generic renderer walks the schema and emits parts. This would
eliminate the per-tool code entirely. But:

- v3's tools today emit free-form JSON. There is no schema source of
  truth; we'd be writing the schemas in the UI repo, divorced from
  the backend handlers — same maintenance cost as the per-tool
  presenters, with the added burden of designing a domain-specific
  schema annotation language (which field is the "headline", which
  field is "muted detail", which field is a `kind: 'file'` link).
- The interesting per-tool behaviour (e.g.
  `run_project_command` derives tone from exit code, `create_card`
  picks among three fallbacks for the title) is conditional logic
  that does not fit a declarative schema cleanly. We'd end up with
  imperative escape hatches inside the schema, which is the worst
  of both worlds.
- F05 r2 §9(b) already rejects external JSON pretty libraries on a
  related axis (CSS opacity + behavioural opacity). Same shape of
  argument.

Reject. If schemas eventually arrive in v3 (e.g. for backend tool
manifests), a `ToolPresenter` can be derived from a schema without
changing the registry surface.

### (c) Reuse `MarkdownText` for everything — rejected

Forces backend tools to emit markdown. v3 emits JSON today; the
round-trip is ugly and loses key/value highlighting. Already
rejected by F05 r2 §9(d).

---

## 10. Recommendation

**Selected: Proposal B (Registry-based presenters).**

Reasoning against the four criteria:

1. **Testability.** Proposal B's per-file tests turn the test suite
   from one ~1500-line file into ~45 ~100-line files. Failures
   localise; bisects narrow to a single tool. `coverage.test.ts`
   mechanises the matrix in §A.3 / §B.4 instead of leaving it to
   reviewer discipline.

2. **Extensibility for new tools.** Adding a tool in Proposal A
   means editing two records, the dispatch (if a new presenter
   shape is needed), and the central test file. Adding a tool in
   Proposal B means creating one file, adding one line to
   `index.ts`, and one line to `EXPECTED_TOOL_NAMES`. The latter
   pattern scales linearly; the former asymptotically slows down
   as the central file grows.

3. **Alignment with F03 r2 chip composition.** F03 r2 §7.2 specifies
   the shared `ToolChip` consumes `call: ToolCallPresentation` /
   `result: ToolResultPresentation`. Both proposals produce the same
   presentation shape — the chip cannot tell A from B at runtime.
   But F03 r2 §11 hints at future per-tool customisation (e.g.
   `diff_card` rendered as a side-by-side diff in the expand body):
   adding an optional `expand?: { body(ctx): VNode }` field to
   `ToolPresenter` in Proposal B is a one-line type extension; in
   Proposal A the dispatch and the consumer would both need to learn
   a new `details` branch. Proposal B is the cleaner forward seat.

4. **F02 component-folder fit.** F02 r2 §1.3 declares
   `web/src/components/conversation/` and `web/src/components/content/`
   as the locations for chip and content rendering. Neither proposal
   conflicts. But Proposal B's `web/src/tool-presenters/` directory
   sits cleanly outside `components/` and `utils/`, which keeps the
   `utils/` folder free of a 600-line specialised catalogue — F02
   r2's discriminator ("anything that imports a store, router, or
   fetch client lives in a surface folder") is silent on
   single-purpose catalogues like this, but isolating them under a
   named directory matches the layering spirit better than burying
   them in `utils/`.

The cost (45 small files) is real but bounded; the matrix at §B.4
gives reviewers a one-page index, and `index.ts` gives readers a
single jumping-off point.

The shared deliverables in §1 (the `InlinePart` type, `json-tokenize`,
`JsonView`, `FormattedContent`, the chip template, the FilesView
routing change, and the consumer cleanup) are unchanged regardless of
which proposal lands.

---

## 11. Out of scope (this design)

- Backend project file root (`root: 'project'`). Listed in F05 r2 §4.3.
- Richer `MarkdownText` (headings/bullets/emphasis). Listed in F05 r2 §10.
- Replacing `highlight.js` in `CodeBlock`. Listed in F05 r2 §10.
- Streaming-aware JSON tokeniser. Listed in F05 r2 §10.
- Bundle-splitting the presenter registry (lazy import per tool). Could
  land later under Proposal B without changing the public API.
- Custom expand bodies (`expand?: { body(ctx): VNode }` on
  `ToolPresenter`). Reserved as a Proposal B forward seat for F03 r2
  §11's `diff_card` follow-up; not implemented in this batch.

---

## Result

- Absolute path: `/home/salva/g/ml/saivage-v3/SPEC/2026-05/review-ui-port-from-v2/F05-tool-detail-rendering/02-design-r1.md`
- Chosen proposal: **B** (Registry-based presenters).
