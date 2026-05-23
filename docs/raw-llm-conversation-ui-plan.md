# Raw LLM Exchange UI — Implementation Plan (iteration 4)

Operator-facing feature: in the Agents view, inspect the **last** raw LLM
request/response for a session as pretty-printed, syntax-highlighted JSON.
This plan also folds in a single, shared code-display primitive that replaces
every ad-hoc code/JSON renderer in the web app.

This plan applies the workspace-wide architecture-first / no-backward-compat
rule: duplicated formatters, regex blocks, CSS classes, and snapshots are
removed in the same change-set. There is no "additive-only" mode and no
deferred cleanup phase.

## §0 Worktree status

`cd /home/salva/g/ml/saivage-v3 && git status --short --branch` (verified):

```
## stage-44-permissions-by-state-matrix...origin/stage-44-permissions-by-state-matrix [ahead 69]
?? docs/raw-llm-conversation-ui-plan.md
?? tmp/cleanup-reports/
```

The branch is ahead of origin; commits land on
`stage-44-permissions-by-state-matrix`. No other in-flight raw-LLM-exchange
work was found (`rg 'raw LLM' src/` returns only an unrelated scanner doc).

## §1 Current state

### §1.1 Session/message storage

- `src/agents/session-persistence.ts:209` `appendMessage(saivageDir, sessionId, msg)`
  writes JSONL under `<saivageDir>/agents/messages/<sessionId>.jsonl`.
- `getSessionMessages(saivageDir, sessionId)` reads same file.
- `SAIVAGE_DIRS` in `src/persistence/file-tree.ts:75` enumerates pre-created
  subdirs: `agents/sessions`, `agents/messages`, etc. No `agents/llm-exchanges`
  exists yet.

### §1.2 Existing agent routes

`src/server/routes/runtime-config-notes.ts`:

- `74` `const SAFE_AGENT_ID_RE = /^[a-zA-Z0-9_:-]+$/`
- `179` `fastify.get('/api/agents/:id/conversation', ...)` — validates id,
  reads messages via `readAgentMessages(projectRoot, sessionId)`, 400/404/500.

Auth: `src/server/auth.ts` registers an `onRoute` hook covering `/api/*`;
new `/api/agents/:id/llm-exchange` inherits that.

### §1.3 LLM transport (verified line refs in `src/agents/llm-client.ts`)

- `63` `export interface LlmCompleteOptions { ... }`.
- `82` `class LlmAuthError`, `104` `class LlmServerError` (carries only
  `statusCode`), `124` `class LlmParseError` (carries `responseBody`).
- `251` `complete(candidate, systemPrompt, messages, sessionId, opts)` — note
  `sessionId` is **already** a parameter (no signature change needed).
- `261` early-return `completeOpenAICodex(...)`.
- `~270` generic (non-Codex) path: builds `apiMessages`, calls `fetch`, then
  either non-streaming JSON or `readStream(response.body)`.
- `331` first `await this.handleHttpError(response)` (generic path).
- `342` `const rawText = await response.text();` (generic non-streaming
  body read). **Current code declares `rawText` with `const` inside the
  non-streaming branch, so it is NOT visible to the outer catch.** This
  plan changes the declaration: hoist `let rawText: string | undefined;`
  to the outer `try` scope in `complete()` (just inside `try`, before the
  `fetch`), and convert every current `const rawText = ...` assignment
  into a reassignment of the hoisted binding. See §2.2 generic-path
  capture for the resulting outer-catch read.
- `345` `parsed = JSON.parse(rawText) as ChatCompletionResponse;` — point
  at which a parse failure can occur with `rawText` already populated.
- `412` `private async completeOpenAICodex(...)`.
- `433` Codex body hard-codes `stream: true`.
- `~460` first fetch; `465`–`475` `isUnsupportedCodexMaxOutputTokensQuirk`
  retry without `max_output_tokens`.
- `476` `await this.handleHttpError(response)` (if still !ok).
- `483` `return await this.readOpenAICodexStream(response.body)`.
- `~495` outer catch re-throws known `Llm*Error`s; wraps `AbortError` and
  `TypeError` into `LlmTimeoutError` / `LlmServerError`.
- `635` `private async readOpenAICodexStream(body)` — concatenates `data:`
  SSE deltas.
- `837` `private async handleHttpError(response): Promise<never>` —
  `await response.text()`, embeds a redacted 500-char snippet into the error
  message, then throws. **After this call the body is gone.** Raw HTTP
  bodies must therefore be captured *before* `handleHttpError`.
- `1060` `export function createLlmClient(baseUrl, apiKey?)` — used by test
  and utility code; will remain recorder-less.

### §1.4 Adapter / Analyst

- `src/agents/agent-adapter.ts:40` `interface AgentAdapterConfig` has
  `eventLogger?: EventLogger` (no `errorLogger`).
- `:156` `readonly eventLogger?: EventLogger`.
- `:619` `createLlmCallFn(): LlmCallFn` builds a closure that calls
  `client.complete(candidate, systemPrompt, messages, sessionId, opts)`.
- `src/agents/analyst-llm-resolver.ts:~87` `LlmIntentResolver.isAvailable()`
  returns `false`; `resolveAnalystLlm()` throws. No LLM HTTP dispatch occurs
  on the analyst path today. **Architectural contract:** any future analyst
  dispatch MUST go through `LlmClient.complete`; no separate capture path.

### §1.5 Web UI surfaces

- `web/src/components/agents/AgentConversationView.vue` — conversation pane
  with `.conv-toolbar` (Expand/Collapse). New "Last raw LLM exchange" toggle
  goes here.
- `web/src/stores/agents.ts` — Pinia store with `currentSession`,
  `messages`, fetch actions. Extended in step 9.
- No existing per-message detail; no highlighter in `web/`.

### §1.6 Code-display site inventory

Result of `rg -n '<pre|<code' web/src` (every hit classified). Each
`<pre>` site is listed individually so the migration to `<CodeBlock>` is
unambiguous:

| File | Site | Today | Action |
|---|---|---|---|
| `web/src/components/cards/CardDetailView.vue` | line 179 inline `<code>` verification cmd | label only | keep tag, swap class to shared `.inline-token` |
| `web/src/components/cards/CardDetailView.vue` | `<pre class="detail-json preview-content">` over `previewState.content` (raw file preview text — **not** `fmtJson`) | raw text preview | migrate to `<CodeBlock language="text">` |
| `web/src/components/cards/CardDetailView.vue` | `<pre class="detail-json">` over `fmtJson(currentCard.result)` (the **only** `fmtJson` site in this file) | duplicated `fmtJson` | migrate to `<CodeBlock language="json">` |
| `web/src/components/cards/CardHistoryPanel.vue` | 114 sanitize, 147 `fmtJson`, two `<pre>` sites | secret-sanitized JSON | extract `sanitizeCardHistoryValue`; render via `<CodeBlock>` with redactor |
| `web/src/views/FilesView.vue` | 198 `fmtJson`, 210 inline-code regex, `<pre class="json-view">` + `<pre class="plain-view">` | duplicated `fmtJson` + inline regex | migrate to `<CodeBlock>` / `<MarkdownText>` |
| `web/src/views/DebugView.vue` | `<pre class="error-details">{{ err.details }}` (raw error-detail text — **not** `fmtJson`) | raw text | migrate to `<CodeBlock language="text">` |
| `web/src/views/DebugView.vue` | `<pre class="tl-event-data">{{ fmtJson(timelineDetails(event)) }}` (the **only** `fmtJson` site in this file) | duplicated `fmtJson` | migrate to `<CodeBlock language="json">` with `redactObservabilityValue` redactor |
| `web/src/components/agents/AgentConversationView.vue` | 123 inline-code regex; `formatExpandedDetail` | duplicated fence/inline regex | migrate to `<MarkdownText>` |
| `web/src/views/DashboardView.vue` | 435 inline-code regex | duplicated regex | migrate to `<MarkdownText>` |
| `web/src/components/chat/AnalystChatPanel.vue` | `<pre>`/`<code>` (tool args/results) | ad-hoc | migrate to `<CodeBlock>` |
| `web/src/views/NotFound.vue` | 8 inline `<code>` route path | label only | keep tag, swap class to `.inline-token` |
| `web/src/components/auth/ApiTokenEntry.vue` | inline `<code>` instructions | label only | keep tag, swap class to `.inline-token` |

All four `fmtJson` declarations (one each in `CardDetailView`,
`CardHistoryPanel`, `FilesView`, `DebugView`) + `formatExpandedDetail` are
deleted after migration. The three duplicated inline-code regex blocks
(AgentConversationView, FilesView, DashboardView) are deleted; rendering
goes through `<MarkdownText>`.

### §1.7 Highlighter dependency

- `web/package.json`: **no** highlighter dep.
- Root `package-lock.json` has Shiki transitively via VitePress (docs only).
  Not used in `web/`.

## §2 Design

### §2.1 Capture architecture

New file `src/agents/llm-exchange-recorder.ts`:

```ts
export interface ExchangeRequestMeta {
  attempt: number;
  transport: 'generic' | 'codex';
  endpoint: string;
  candidate: { provider: string; model: string; account?: string };
  requestBody: unknown;
}
export interface ExchangeResponseMeta {
  attempt: number;
  status: number;
  bodyRaw: string;          // verbatim text (or concatenated SSE)
  bodyParsed: unknown;      // parsed JSON or synthesized stream object
}
export interface ExchangeErrorMeta {
  attempt: number;
  status?: number;
  bodyRaw: string | null;
  errorName: string;
  message: string;
}
export interface LlmExchangeRecorder {
  beginExchange(meta: ExchangeRequestMeta): Promise<ExchangeHandle>;
  flush(): Promise<void>;   // tests await this to ensure all writes settled
}
export interface ExchangeHandle {
  recordResponse(meta: ExchangeResponseMeta): Promise<void>;
  recordError(meta: ExchangeErrorMeta): Promise<void>;
}
```

`beginExchange` writes the initial in-progress record and returns a handle
that carries `{ sessionId, attemptId }` internally. The handle's
`recordResponse` / `recordError` complete that specific attempt regardless
of interleaving with other handles in the same session. The recorder uses
the session-level promise-chain mutex ONLY around disk writes; the handle
binds the response to the right attempt by ID.

- **Ownership.** ONE recorder per session, owned by the `AgentAdapter` for
  the session's lifetime. `AgentAdapter.createLlmCallFn` constructs the
  recorder once via `createLlmExchangeRecorder({ saivageDir, sessionId,
  eventLogger })` (or fetches the existing one for that session) and passes
  the same instance through `LlmCompleteOptions.recorder` on every call.
  Each call begins a fresh attempt-set: the first `beginExchange` of a new
  call (`attempt: 0`) resets the in-memory accumulator so the on-disk
  record always reflects the latest call for that session.
- **State.** Recorder keeps an in-memory `LlmExchange` accumulator
  (sessionId, capturedAt, transport, endpoint, candidate, attempts[]).
  `beginExchange` with `attempt: 0` starts a new accumulator and returns a
  handle bound to a fresh `attemptId`; later `beginExchange` calls in the
  same call (e.g. Codex retry with `attempt: 1`) push additional attempts
  and return their own handles. Each handle's `recordResponse` /
  `recordError` completes the attempt identified by its `attemptId`
  (NOT "the latest attempt"), so concurrent handles in the same session
  cannot cross-attribute responses. After completion the whole record is
  written.
- **Persistence.** Each `beginExchange` writes the initial in-progress
  record and each `recordResponse`/`recordError` rewrites the completed
  record via `writeLatestLlmExchange` (atomic temp+rename via existing
  `writeFileAtomic`). Single file per session at
  `<saivageDir>/agents/llm-exchanges/<sessionId>.json`.
- **Redaction.** Before write, the recorder calls
  `redactForOutbound(record, 'operator.api', { source: 'llm-client.exchange-capture' })`
  (policy registered at `src/redaction/index.ts:75`).
- **Concurrency.** A per-session (per-recorder) promise-chain mutex
  serializes the *disk-write* sections of `beginExchange` /
  `recordResponse` / `recordError` / `flush`. The handle's `attemptId`
  binds each response/error to the right attempt independently of mutex
  order, so interleaved request/response calls from two handles in the
  same session still produce a schema-valid record with each response
  attached to its own request. `writeFileAtomic` alone protects readers
  from partial files but does not order writers. No external dep.
- **Failure isolation.** Each public method wraps its body in `try { ... }
  catch (err) { eventLogger?.appendEvent({ kind: 'recorder_error',
  session_id, phase: 'request'|'response'|'error'|'flush',
  error_message: redactedMessage }); }`. Returned promises always **resolve**
  (never reject). Agent execution is unaffected by recorder failures.
- **Stream buffer cap.** Concatenated raw stream capture is capped at 16 MB;
  on overflow the recorder truncates and appends a sentinel
  `\n[... truncated at 16 MiB ...]`.

### §2.2 Capture points in `LlmClient`

`sessionId` is already in `complete()`; extend `LlmCompleteOptions` with
`recorder?: LlmExchangeRecorder`. If absent, all hooks become no-ops (the
`createLlmClient` factory at `:1060` stays recorder-less for tests).

**Code change in `complete()`:** hoist `let rawText: string | undefined;`
to the outer `try` scope (just inside the `try`, before `fetch`); convert
the existing `const rawText = await response.text();` into a reassignment
(`rawText = await response.text();`). The outer catch can then read
`rawText ?? null` for `bodyRaw`.

**Generic non-streaming path (`complete`):**

```ts
const attempt = 0;
let rawText: string | undefined;
const handle = await opts.recorder?.beginExchange({ attempt,
  transport: 'generic', endpoint: this.endpointUrl(), candidate,
  requestBody });
let recordedErr = false;
try {
  const response = await fetch(...);
  if (!response.ok) {
    const bodyRaw = await response.clone().text().catch(() => '');
    await handle?.recordError({ attempt, status: response.status,
      bodyRaw, errorName: classifyHttpError(response.status),
      message: `HTTP ${response.status}` });
    recordedErr = true;
    await this.handleHttpError(response);  // throws
  }
  rawText = await response.text();
  const parsed = JSON.parse(rawText);  // existing parse stays
  await handle?.recordResponse({ attempt, status: response.status,
    bodyRaw: rawText, bodyParsed: parsed });
  return synthesize(parsed);
} catch (err) {
  if (!recordedErr) {
    // `rawText` is hoisted to this outer `try` (see code change above),
    // so it is in scope here. Two branches:
    //   - If the failure happened BEFORE the body was read (network error,
    //     abort, or an HTTP error already captured above), `rawText` is
    //     `undefined` and we record `bodyRaw: null`.
    //   - Otherwise (e.g. a JSON.parse failure AFTER the body was read),
    //     `rawText` is a string and we record `bodyRaw: rawText`.
    await handle?.recordError({
      attempt,
      bodyRaw: rawText ?? null,
      errorName: err instanceof Error ? err.name : 'Error',
      message: err instanceof Error ? err.message : String(err),
    });
  }
  throw err;
}
```

The `recordedErr` flag prevents the outer catch from double-recording HTTP
failures. The two `bodyRaw` branches (raw text on post-body parse failure
vs. `null` on pre-body errors) MUST be exercised by separate integration
tests (see §4.1).

**Generic streaming path:** wrap the chunk decoder so the recorder receives
the concatenated raw SSE text and the synthesized final object. Same
pre/post structure; capture HTTP error before `handleHttpError`.

**Codex path (`completeOpenAICodex`):** identical pattern wrapped around the
fetch + optional retry. Each retry obtains a fresh handle via
`await opts.recorder?.beginExchange({...})` immediately before its `fetch`;
that handle's `recordResponse` / `recordError` completes that specific
attempt. Both attempts (the `max_output_tokens` rejection and the retry
without it) get their own `beginExchange` + `recordResponse`/`recordError`
pair.

### §2.3 On-disk format

Shared Zod schema at `src/contracts/llm-exchange.ts` (existing `src/contracts/`
already houses operator-api/operator-events contracts):

```ts
import { z } from 'zod';
export const llmExchangeAttemptSchema = z.object({
  attempt: z.number().int().nonnegative(),
  requestBody: z.unknown(),
  responseStatus: z.number().int().optional(),
  responseBodyRaw: z.string().optional(),
  responseBodyParsed: z.unknown().optional(),
  error: z.object({
    errorName: z.string(),
    message: z.string(),
    status: z.number().int().optional(),
    bodyRaw: z.string().nullable(),
  }).optional(),
});
export const llmExchangeSchema = z.object({
  sessionId: z.string(),
  capturedAt: z.string(),     // ISO 8601
  transport: z.enum(['generic', 'codex']),
  endpoint: z.string(),
  candidate: z.object({
    provider: z.string(), model: z.string(), account: z.string().optional(),
  }),
  attempts: z.array(llmExchangeAttemptSchema).min(1),
  status: z.enum(['ok', 'error']),
});
export type LlmExchange = z.infer<typeof llmExchangeSchema>;
```

Helper at `src/agents/llm-exchange-log.ts`:

```ts
export class LlmExchangeCorruptedError extends Error { /* ... */ }
export function readLatestLlmExchange(
  saivageDir: string, sessionId: string,
): LlmExchange | null;          // null on ENOENT; throws on schema fail
export async function writeLatestLlmExchange(
  saivageDir: string, exchange: LlmExchange,
): Promise<void>;
```

`readLatestLlmExchange` returns `null` only for missing-file. JSON-parse or
schema-parse failures throw `LlmExchangeCorruptedError` so the route can map
to 500 (distinct from 404).

Add `'agents/llm-exchanges'` to `SAIVAGE_DIRS` (`src/persistence/file-tree.ts:75`).

### §2.4 Redaction

`redactForOutbound(record, 'operator.api', ...)` applies the registered
`operator.api` policy, which (see `src/redaction/index.ts` ~L120-L160 and
~L213-L241) does TWO things to every string in the record:

1. Redacts values whose **key name** matches the secret-key matcher
   (`Authorization`, `api_key`, `token`, etc.) to the redaction placeholder.
2. Runs `redactProviderLikeText` over arbitrary string content, which
   replaces inline credential literals (`sk-…`, `ghu_…`, `tok_…`,
   `Bearer …`), JSON-encoded secret values, inline `KEY=secret`
   assignments, and secret query-string params — **even when they appear
   inside operator-domain prompts, tool args, or tool results**, not just
   in HTTP headers/URLs.

**Tradeoff**: operator-domain *prose* (system prompts, user prompts, tool
args/results) remains readable, but credential-shaped substrings inside it
are still replaced. The UI banner spells this out explicitly.

### §2.5 Backend route

Register in `src/server/routes/runtime-config-notes.ts` next to the
conversation handler. Pass `saivageDir` (derived once at top of file from
`projectRoot` — same as other handlers do, or via the existing helper that
maps project root to saivage dir).

```ts
fastify.get('/api/agents/:id/llm-exchange', async (request, reply) => {
  const { id } = request.params as { id: string };
  if (!SAFE_AGENT_ID_RE.test(id)) {
    return reply.status(400).send({ error: 'Invalid agent session ID' });
  }
  try {
    const exchange = readLatestLlmExchange(saivageDir, id);
    if (!exchange) return reply.status(404)
      .send({ error: 'No LLM exchange recorded', sessionId: id });
    // defense-in-depth re-validate
    const parsed = llmExchangeSchema.safeParse(exchange);
    if (!parsed.success) {
      return reply.status(500).send({ error: 'Corrupted LLM exchange record' });
    }
    return reply.send({ exchange: parsed.data });
  } catch (err) {
    if (err instanceof LlmExchangeCorruptedError) {
      return reply.status(500).send({ error: 'Corrupted LLM exchange record' });
    }
    return reply.status(500).send({ error: 'Failed to read LLM exchange',
      message: err instanceof Error ? err.message : String(err) });
  }
});
```

Auth inherited from `/api/*` `onRoute` hook ⇒ 401 for unauthenticated.

### §2.6 Frontend schema/type sharing

`web/tsconfig.json` already includes `../src/contracts/**/*.ts` and
`../src/schemas/**/*.ts`. Re-export from `web/src/api/contracts.ts` using
the extensionless import style already used in that file (see the existing
`'../../../src/contracts/operator-api'` re-exports at the top of
`web/src/api/contracts.ts`):

```ts
export { llmExchangeSchema, llmExchangeAttemptSchema } from
  '../../../src/contracts/llm-exchange';
export type { LlmExchange } from '../../../src/contracts/llm-exchange';
```

No manual mirror, no schema duplication, no `z._def` comparisons.

### §2.7 API client + store

`web/src/api/client.ts` already provides an internal `request<T>(method,
path, query?, body?, operationId?)` helper that handles auth headers, JSON
parsing, and a single exported `ApiError` class with an `isNotFound`
getter (see `web/src/api/client.ts` ~L64-L80). The new client function
follows the same `export function ...` pattern as the existing wrappers
(`getAgentConversation`, etc.):

```ts
import { llmExchangeSchema } from './contracts';
import type { LlmExchange } from './contracts';

export async function getAgentLlmExchange(sessionId: string): Promise<LlmExchange> {
  const { exchange } = await request<{ exchange: unknown }>(
    'GET',
    `/api/agents/${encodeURIComponent(sessionId)}/llm-exchange`,
  );
  return llmExchangeSchema.parse(exchange);
}
```

`request` throws the existing `ApiError` on any non-2xx; callers in the
store distinguish 404 via the existing `err.isNotFound` getter (no new
`ApiNotFoundError` type is introduced).

`web/src/stores/agents.ts` adds:

- `currentLlmExchange: Ref<LlmExchange | null>`
- `llmExchangeLoading: Ref<boolean>`
- `llmExchangeError: Ref<string | null>` (with sentinel `'not_found'`)
- `fetchLlmExchange(sessionId)`:

  ```ts
  try {
    llmExchangeLoading.value = true;
    currentLlmExchange.value = await getAgentLlmExchange(sessionId);
    llmExchangeError.value = null;
  } catch (err) {
    currentLlmExchange.value = null;
    if (err instanceof ApiError && err.isNotFound) {
      llmExchangeError.value = 'not_found';
    } else {
      llmExchangeError.value = err instanceof Error ? err.message : String(err);
    }
  } finally {
    llmExchangeLoading.value = false;
  }
  ```
- `clearLlmExchange()` — invoked on session switch.

### §2.8 Shared `<CodeBlock>` primitive

`web/src/components/code/CodeBlock.vue`:

```ts
defineProps<{
  code: string;
  language?: 'json'|'bash'|'diff'|'typescript'|'text';
  copyable?: boolean;
  maxHeight?: string;       // e.g. '60vh'
  wrap?: boolean;
  ariaLabel?: string;
}>();
```

- Internals: `web/src/utils/highlight.ts` exports `highlight(code, language)`
  returning HTML-escaped highlighted markup, plus a singleton `hljs` instance
  with only the listed languages registered.
- **1 MB fallback.** If `code.length > 1_000_000`, render `<code v-text>` plus
  notice "Syntax highlighting disabled (>1 MB)".
- **Clipboard.** Copy reads the `code` prop (byte-for-byte fidelity, never
  the rendered DOM). Tries `navigator.clipboard.writeText`; on absence
  (jsdom) falls back to a hidden `<textarea>` + `document.execCommand('copy')`.
- **Styling.** `import 'highlight.js/styles/github-dark.css';` once in
  `web/src/main.ts`. Container styling lives only in `CodeBlock.vue`.

`web/src/components/code/MarkdownText.vue` consumes
`splitMarkdownSegments(source)` (§2.9) and renders each segment as either
plain text, a `<CodeBlock>` (fenced) or `<code class="inline-token">`
(inline backticks).

### §2.9 Shared JSON formatter

`web/src/utils/format-json.ts`:

```ts
export function formatJson(
  value: unknown,
  opts?: { redactor?: (input: unknown) => unknown },
): string {
  if (value === undefined) return 'undefined';
  const safe = opts?.redactor ? opts.redactor(value) : value;
  try {
    const out = JSON.stringify(safe, null, 2);
    return out ?? String(safe);   // covers functions/symbols ⇒ undefined
  } catch {
    return String(safe);           // circular ⇒ String fallback
  }
}
```

Migrate all four `fmtJson` sites; pass redactors:

- `DebugView`: `(v) => redactObservabilityValue(v)`.
- `CardHistoryPanel`: extract the existing in-component sanitizer into
  `web/src/utils/sanitize-card-history.ts` as
  `sanitizeCardHistoryValue(v)` and pass it as `redactor`.
- `CardDetailView`, `FilesView`: no redactor.

Delete all four `fmtJson` declarations and `formatExpandedDetail`.

### §2.10 Shared markdown fence parser

`web/src/utils/markdown.ts`:

```ts
export type MarkdownSegment =
  | { kind: 'text';  content: string }
  | { kind: 'code';  content: string; language?: string }
  | { kind: 'inline-code'; content: string };
export function splitMarkdownSegments(input: string): MarkdownSegment[];
```

Handles ` ``` ` fenced blocks **and** single-backtick inline code. Delete
the three duplicated regex blocks in `AgentConversationView.vue`,
`FilesView.vue`, `DashboardView.vue`; replace usage with `<MarkdownText>`.

`RawLlmExchangePanel` (§2.12) MUST explicitly invoke `formatJson(...)` from
`web/src/utils/format-json.ts` on the request/response values before
passing the resulting string to `<CodeBlock>` — e.g.
`<CodeBlock language="json" :code="formatJson(attempt.requestBody)" />`.
`<CodeBlock>` itself does not stringify objects.

### §2.11 CSS cleanup (removed in step 4)

Re-derived by running `rg -n '^\.tc-body|^\.tr-body|^\.detail-json|^\.code-block|^\.json-view|^\.plain-view|^\.tool-chip-detail|^\.tl-event-data|^\.diff-side|^\.error-details' web/src`:

| Class | File:line where defined | Disposition |
|---|---|---|
| `.detail-json` | `web/src/components/cards/CardDetailView.vue:540` (font-family rule) and `web/src/components/cards/CardDetailView.vue:558` (box rule) | delete (both selectors) |
| `.tc-body`, `.tr-body` | `web/src/components/agents/AgentConversationView.vue:225-226` | delete |
| `.inline-code` | `web/src/components/agents/AgentConversationView.vue:207`, `web/src/views/FilesView.vue:287`, `web/src/views/DashboardView.vue:757` | delete (3 sites; replaced by shared `.inline-token` from `<MarkdownText>`) |
| `.code-block` (via `:deep`) | `web/src/components/agents/AgentConversationView.vue:206`, `web/src/views/FilesView.vue:286`, `web/src/views/DashboardView.vue:756` | delete (3 sites; rendering moves to `<CodeBlock>`) |
| `.tool-chip-detail` | `web/src/components/chat/AnalystChatPanel.vue:418` | delete |
| `.tl-event-data` | `web/src/views/DebugView.vue:586` | delete |
| `.error-details` | `web/src/views/DebugView.vue:576` | delete |
| `.json-view` | `web/src/views/FilesView.vue:284` | delete |
| `.plain-view` | `web/src/views/FilesView.vue:289` | delete |
| `.diff-side` | `web/src/components/cards/CardHistoryPanel.vue:225` | delete (replaced by `<CodeBlock language="diff">`) |

`<CodeBlock>` owns the styling. `<code class="inline-token">` is a single
shared utility class.

### §2.12 UI surface

In `AgentConversationView.vue`:

- New toolbar button "Last raw LLM exchange" in `.conv-toolbar` next to
  Expand/Collapse. Toggles a panel inserted between `.conv-header` and
  `.conv-messages`.
- `RawLlmExchangePanel.vue` (in `web/src/components/agents/`) contents:
  - Header line: `Captured: <iso> · Transport: generic|codex · Attempts: N`.
  - If N > 1, attempt tab strip; default selected = last attempt.
  - Redaction banner: "Raw exchange after server-side redaction. The
    `operator.api` policy redacts credential-shaped substrings (API keys,
    bearer tokens, secret-keyed JSON values, inline `KEY=secret`
    assignments, and secret query params) wherever they appear — including
    inside prompts, tool args, and tool results — and replaces values of
    secret-named keys with [REDACTED]. Other operator-domain text is
    unmodified."
  - The panel calls `formatJson(...)` on each JSON value before handing it
    to `<CodeBlock>` (see §2.10):
    `:code="formatJson(attempt.requestBody)"`, etc. Raw-text panes pass
    `attempt.error.bodyRaw` / `attempt.responseBodyRaw` directly (no
    `formatJson`).
  - **Request** pane: `<CodeBlock language="json" copyable maxHeight="60vh"
    :code="formatJson(attempt.requestBody)" />`.
  - **Response** pane:
    - If `attempt.error`: show `errorName`, `message`, and `bodyRaw`
      (`<CodeBlock language="text" :code="attempt.error.bodyRaw ?? ''" />`).
    - Else if `transport === 'codex'` or generic-streaming: primary
      `<CodeBlock language="text" :code="attempt.responseBodyRaw" />`
      shows raw verbatim; secondary collapsed
      `<CodeBlock language="json" :code="formatJson(attempt.responseBodyParsed)" />`.
    - Else non-JSON parsed (parse failure visible via raw text): primary
      `<CodeBlock language="text" :code="attempt.responseBodyRaw" />`
      with notice "Response body was not valid JSON".
    - Else: `<CodeBlock language="json" :code="formatJson(attempt.responseBodyParsed)" />`.
  - Refresh button calls `agentsStore.fetchLlmExchange(sessionId)`.
  - Empty state: "No LLM exchange recorded yet for this session." (on 404).
  - Session switch clears via `clearLlmExchange()`.

## §3 Implementation steps (each step buildable & testable)

1. **Add `highlight.js`** to `web/package.json`. `npm install` from `web/`.
2. **Create utilities** `web/src/utils/highlight.ts`, `format-json.ts`,
   `markdown.ts`, `sanitize-card-history.ts`. Unit tests for each.
3. **Create components** `web/src/components/code/CodeBlock.vue` and
   `code/MarkdownText.vue`. Import `github-dark.css` once in
   `web/src/main.ts`. Component tests.
4. **Migrate all code-display sites** (single change-set per §1.6 + §2.9 +
   §2.10 + §2.11). Delete the four `fmtJson` decls, `formatExpandedDetail`,
   three inline-code regex blocks, and all listed CSS classes. Re-record
   affected snapshots; rewrite tests that asserted on removed classes.
5. **Backend types & log helper.** Create `src/contracts/llm-exchange.ts`,
   `src/agents/llm-exchange-log.ts`. Add `'agents/llm-exchanges'` to
   `SAIVAGE_DIRS`. Re-export schema/type via `src/contracts/index.ts`. Tests
   for round-trip, schema validation, corrupted-file → `LlmExchangeCorruptedError`.
6. **Recorder.** Create `src/agents/llm-exchange-recorder.ts` with mutex,
   redaction, 16 MiB stream cap, `flush()`. Tests: success / error /
   streaming-tee / Codex retry / failure-isolation / mutex ordering / flush.
7. **Wire `LlmClient`.** Extend `LlmCompleteOptions` with
   `recorder?: LlmExchangeRecorder`. Insert capture points in `complete()`
   (non-stream + stream paths) and `completeOpenAICodex()` (both attempts)
   per §2.2 with `recordedErr` flag to prevent double-recording on HTTP
   errors. Update `createLlmCallFn` in `agent-adapter.ts` to fetch-or-create
   a per-session recorder via `createLlmExchangeRecorder({ saivageDir,
   sessionId, eventLogger: this.eventLogger })` (one instance reused for
   the session's lifetime). No new fields needed on `AgentAdapterConfig`.
   `createLlmClient` factory at `:1060` stays recorder-less (test/utility
   surface). Extend `tests/llm-client-integration.test.ts` with streaming,
   Codex, `max_output_tokens` retry, HTTP-error capture-once,
   network/abort/parse error cases.
8. **Route.** Register `GET /api/agents/:id/llm-exchange` in
   `src/server/routes/runtime-config-notes.ts`. Tests for 200 / 404 / 400 /
   401 / 500-corrupted in `tests/server/agents-routes.test.ts`.
9. **Frontend store + client.** Add `getAgentLlmExchange` to
   `web/src/api/client.ts` using the existing `request<T>` helper; add
   `currentLlmExchange`, `llmExchangeLoading`, `llmExchangeError`,
   `fetchLlmExchange`, `clearLlmExchange` to `web/src/stores/agents.ts`.
   Tests for happy / 404 (via `ApiError.isNotFound`) / 500 / 401 paths and
   session-switch clearing.
10. **Panel.** Build `RawLlmExchangePanel.vue`; wire toolbar toggle and
    `clearLlmExchange()` on session switch in `AgentConversationView.vue`.
    Tests for loading, empty, error, success, attempts tabs, stream view,
    non-JSON fallback, redaction banner, copy fidelity.

After each step: `npm run build` (root) and `npm run build` (web) succeed;
`npx vitest run` for the touched packages is green before moving on.

## §4 Test plan

### §4.1 Backend tests added

- `tests/agents/llm-exchange-log.test.ts`
  - write/read round-trip (atomic, schema-valid).
  - `readLatestLlmExchange` returns `null` on ENOENT.
  - `readLatestLlmExchange` throws `LlmExchangeCorruptedError` on bad JSON.
  - `readLatestLlmExchange` throws `LlmExchangeCorruptedError` on
    schema-invalid JSON.
- `tests/agents/llm-exchange-recorder.test.ts`
  - happy-path generic success: one `beginExchange` + one `recordResponse`
    → file with one attempt, `status: 'ok'`.
  - HTTP error: one `beginExchange` + one `recordError` → `status: 'error'`.
  - Stream tee: feed chunked decoder; assert `responseBodyRaw` equals the
    concatenation byte-for-byte; assert `responseBodyParsed` matches
    synthesized object.
  - 16 MiB cap truncation: raw stream truncated with sentinel.
  - Codex retry: two `beginExchange` calls with attempts 0 and 1; both
    recorded; final `status: 'ok'`.
  - Failure isolation: recorder configured with unwritable dir; agent code
    path completes; `eventLogger` received one `recorder_error` event;
    public methods all resolved.
  - Handle correlation (single session, single shared recorder, concurrent
    handles): in a single session fire two interleaved exchanges —
    `h1 = beginExchange(req1)`, `h2 = beginExchange(req2)`,
    `h2.recordResponse(res2)`, `h1.recordResponse(res1)` — and assert
    (a) the on-disk record is always schema-valid (never partial /
    corrupted), (b) each response is attached to its own request (req1↔res1,
    req2↔res2) regardless of completion order, and (c) `flush()` resolves
    only after both pairs are durable. Repeat with `h2.recordError(err2)`
    in place of `h2.recordResponse` to confirm errors don't cross-attribute
    to the other handle.
  - `flush()` resolves only after all pending writes settled.
  - Redaction applied: header `Authorization: Bearer xyz` in `requestBody`
    becomes `[REDACTED]` per `operator.api` policy.
- `tests/agents/llm-client-integration.test.ts` (extends existing)
  - generic non-stream success records 1 request + 1 response.
  - generic stream success records concatenated SSE + parsed object.
  - generic HTTP 500 records exactly one error with `bodyRaw` populated
    (verify capture happens before `handleHttpError` consumes body).
  - generic network `TypeError` → one error record with `errorName`
    `'TypeError'` AND `bodyRaw: null` (failure happens before body is
    read, so `rawText` is `undefined` at the outer catch).
  - generic abort → one error record with `errorName: 'AbortError'` AND
    `bodyRaw: null`.
  - generic parse failure → response NOT recorded; instead an error record
    with `errorName: 'SyntaxError'` AND `bodyRaw: <the raw text>` (the
    body was already read into `rawText` before `JSON.parse` threw, so the
    outer catch passes `rawText ?? null` = the raw text).
  - Codex success records one attempt (raw SSE + parsed object).
  - Codex `max_output_tokens` retry records two attempts (attempt 0 error,
    attempt 1 ok).
  - Codex HTTP error after retry records both error attempts; outer catch
    re-throws once.
- `tests/server/agents-routes.test.ts`
  - 200 with parsed exchange body.
  - 404 when file missing.
  - 400 on invalid session id (`../`, spaces, etc.).
  - 401 without auth header.
  - 500 when file is corrupted (helper throws).

### §4.2 Frontend tests added

- `web/src/__tests__/utils/format-json.test.ts`
  - object → pretty.
  - `undefined` → `'undefined'`.
  - circular → `String(value)` fallback.
  - `formatJson(value, { redactor })` applies redactor before stringify.
- `web/src/__tests__/utils/markdown.test.ts`
  - text-only, fenced (with and without language), inline backticks,
    mixed segments.
- `web/src/__tests__/utils/highlight.test.ts`
  - escapes `<script>` as `&lt;script&gt;` (XSS safety).
  - languages register without throwing.
- `web/src/__tests__/code-block.test.ts`
  - renders for each language.
  - `copyable` button invokes `navigator.clipboard.writeText` with the
    exact `code` prop value.
  - clipboard fallback path used when `navigator.clipboard` is undefined
    (jsdom path).
  - `maxHeight` / `wrap` apply expected style.
  - 1 MB+ input renders plain `<code>` + "Syntax highlighting disabled"
    notice; copy still works.
- `web/src/__tests__/markdown-text.test.ts` — segments render correctly.
- `web/src/__tests__/raw-llm-exchange-panel.test.ts`
  - loading state.
  - empty/404 state shows operator message.
  - error state shows error name/message and `bodyRaw`.
  - success: request `<CodeBlock>` shows pretty JSON; response same.
  - multi-attempt: tab strip; default selects last attempt.
  - streaming: primary pane shows raw text; collapsed pane shows parsed.
  - non-JSON parsed: text fallback + notice.
  - redaction banner present.
  - copy reads from `code` prop (assert clipboard call argument equals raw
    stored text byte-for-byte).
- `web/src/__tests__/agents-view.test.ts` (extended)
  - new toolbar button toggles the panel.
  - session switch calls `clearLlmExchange()`.
- `web/src/__tests__/agents-store.test.ts` (extended)
  - `fetchLlmExchange` happy / 404 (sentinel via `ApiError.isNotFound`) /
    500 / 401.

### §4.3 Tests to delete / rewrite

- Any snapshot under `web/src/__tests__/__snapshots__/` asserting `.tc-body`,
  `.tr-body`, `.detail-json`, `.code-block`, `.json-view`, `.plain-view`,
  `.tool-chip-detail`, `.tl-event-data`, `.diff-side`, `.error-details` —
  regenerate.
- Tests asserting raw `<pre><code>{{ fmtJson(...) }}</code></pre>` HTML —
  rewrite to assert presence of `<CodeBlock>` with expected `code` prop.
- Any test that mocked the per-component `fmtJson` — switch to mocking
  `formatJson` from `utils/format-json.ts` (or to passing data through).
- Tests asserting on the three inline-code regex blocks’ output HTML —
  rewrite against `<MarkdownText>` output.

## §5 Risks

- **Stream memory.** Raw stream capture is capped at 16 MiB; truncation is
  visible to the operator with a sentinel.
- **Read-during-write.** `writeFileAtomic` (temp+rename) ensures readers see
  either the old or the new complete record, never a partial one.
- **Concurrent same-session writers.** Per-session promise-chain mutex on
  the single shared recorder serializes read-modify-write of the in-memory
  `attempts[]`. Atomic disk writes alone are insufficient because two
  concurrent callers would each read an old in-memory snapshot.
- **Recorder failures never reach agent execution.** All methods catch,
  log via `eventLogger` (`recorder_error` event), and resolve.
- **Snapshot churn.** Expected. Re-recorded in step 4. Not a rollback risk.
- **Codex retry classification.** First attempt’s error carries
  `errorName: 'CodexUnsupportedMaxOutputTokens'`; UI shows both attempts.

## §6 Out of scope

- WebSocket push of new exchanges. Operator clicks Refresh.
- Per-tool-call exchange history beyond the latest call per session.
- Light theme.
- Reading or writing `.saivage/auth-profiles.json`, `.saivage/saivage.json`,
  provider configs, env files, token files, backups, shell history beyond
  existing redaction.
- Restarting deployments.

In scope (explicitly **not** deferred): streaming-response capture (Codex
uses it today), shared markdown fence + inline-code parser, full migration
of every code-display site to `<CodeBlock>` / `<MarkdownText>` /
`<code class="inline-token">`, deletion of duplicated formatters/regex/CSS.
