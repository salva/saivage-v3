# F05 Tool Detail Rendering Analysis Review R1

Review target: [01-analysis-r1.md](01-analysis-r1.md)

## Summary

Verdict: changes requested.

The analysis is directionally strong. It correctly identifies the current v3
problem: both conversation surfaces render expanded tool details as JSON
`CodeBlock`s, and the current presenter contract is flat string text instead of
structured inline parts.

It also correctly imports the three important v2 ideas: token-aware JSON,
embedded-JSON detection, and per-tool inline summaries. The no-backward-
compatibility stance is mostly honored: the draft explicitly says
`headline: InlinePart[]` replaces `headline: string`, `detail` follows the same
shape, all call sites migrate, and no `headlineText` shim remains.

I cannot approve R1 because several requirements are still under-specified or
incorrect enough to cause implementation drift. The biggest risks are the file
routing contract, nested interactive chip markup, the ambiguous pair formatter
contract, and the missing test plan for the tokenizer and presenter rewrite.

## Axis Review

### 1. Clean code and clean architecture

The proposed separation into `JsonView`, `FormattedContent`, typed presenter
output, and an inline-parts renderer is a good architectural direction. It keeps
JSON tokenization out of the conversation surfaces and avoids putting router
logic inside `tool-presenters.ts`.

The architecture is not yet clean enough around formatter data flow. R1 says
`presentToolCall` and `presentToolResult` remain public and internally call
`formatToolPair`, then split the pair across call/result presentations. That is
not sound for the current v3 consumers: [AgentConversationView.vue](../../../../web/src/components/agents/AgentConversationView.vue#L142-L150)
and [AnalystChatPanel.vue](../../../../web/src/components/chat/AnalystChatPanel.vue#L160-L184)
call the call and result presenters independently. A result presenter often has
only the result payload plus the tool name, not the original call args. R1 must
choose a type-level design that works without hidden pairing state, or must
explicitly make pairing a surface concern in the same PR.

The `InlineParts.vue` rendering glue is useful, but placing `<router-link>` and
`<a>` elements inside existing chip `<button>`s would create nested interactive
controls. [AnalystChatPanel.vue](../../../../web/src/components/chat/AnalystChatPanel.vue#L36-L52)
renders the whole chip as a button today. R1 needs to specify the markup change:
for example a non-button chip row with a dedicated expand button, or inline
parts rendered outside the button with explicit event handling.

### 2. No backward compatibility

R1 passes the main compatibility requirement in spirit. It identifies the
existing string contract in [tool-presenters.ts](../../../../web/src/utils/tool-presenters.ts#L16-L26)
and states that [01-analysis-r1.md](01-analysis-r1.md#L185-L206) replaces it
with `InlinePart[]`, including `detail?: InlinePart[]`. It also rejects
`headlineText` in [01-analysis-r1.md](01-analysis-r1.md#L366).

The next round should make this stricter: tests and consumers must stop treating
`headline` as truthy string text. [tool-presenters.test.ts](../../../../web/src/__tests__/tool-presenters.test.ts#L10-L45)
currently asserts exact string headlines. Those assertions must become structured
part assertions, not helper conversions back to strings.

### 3. Correctness

The embedded JSON detection is correctly identified. R1 cites the v2 rule, and
v2's source confirms the allowlist regex
`/^(Tool call|Tool result|Result|Error|Response|Request)\b/i` in
[FormattedContent.vue](../../../../../saivage/web/src/components/FormattedContent.vue#L41-L46).
The rule is intentionally conservative and should be kept byte-equivalent unless
there is a documented reason to diverge.

The JSON token coverage is also correct at the variable level. v2 binds key,
string, number, boolean, null, brace/bracket, colon, and comma classes to the
six semantic variables in [JsonHighlight.vue](../../../../../saivage/web/src/components/JsonHighlight.vue#L126-L133):
`--syn-key`, `--syn-string`, `--syn-number`, `--syn-boolean`, `--syn-null`, and
`--syn-punctuation`. R1 correctly names these tokens in [01-analysis-r1.md](01-analysis-r1.md#L155).

The file routing proposal is not correct yet. R1 says file parts route to
`{ name: 'files', query: { path, root } }` and that `root: 'project'` resolves
via `navigateOutput`, while `root: 'saivage'` resolves via `navigateMeta` in
[01-analysis-r1.md](01-analysis-r1.md#L350-L358). Current v3 has only metadata
`.saivage` and output `.saivage-work` roots in [files.ts](../../../../web/src/stores/files.ts#L22-L23),
and `FilesView` only applies a query path when it starts with `.saivage-work/`
in [FilesView.vue](../../../../web/src/views/FilesView.vue#L234-L250). A
`read_project_file` path like `src/foo.ts` will not open correctly under that
contract. R1 must define whether `project` means actual project root support is
added, or whether formatter paths are normalized to one of the existing exposed
roots. The implementation cannot guess this.

URL routing is fine at a high level: external anchors with `target="_blank"` and
`rel="noopener noreferrer"` are the right primitive. The nested-button problem
above still applies to where those anchors are mounted.

### 4. Completeness

R1 correctly enumerates the v3 tool catalog in [01-analysis-r1.md](01-analysis-r1.md#L56)
and sketches a `FORMATTERS` table covering that catalog in [01-analysis-r1.md](01-analysis-r1.md#L274-L320).
That is better than copying v2's table blindly; v2's formatter table is a
different tool set, as seen in [toolFormatters.ts](../../../../../saivage/web/src/utils/toolFormatters.ts#L608-L685).

However, a name-only dispatch table is not enough for this analysis to be
approved. The current v3 file has separate call and result presenter maps in
[tool-presenters.ts](../../../../web/src/utils/tool-presenters.ts#L102-L209), and
the new design needs to state coverage for both call and result outputs. For
each listed v3 tool, R1 should specify either the per-tool formatter behavior or
a documented fallback bucket. The fallback should be explicit for unknown MCP or
future tools, not accidentally used for named v3 tools.

R1 also needs to address the prose renderer gap. It claims v3 `MarkdownText` is
the markdown branch, but current `MarkdownText` only splits fenced code and
inline code, not v2-style rendered headings, bullets, emphasis, or strong text.
That may be an acceptable product decision, but it must be named as a deliberate
scope choice or corrected in the plan.

### 5. Testability

This is the weakest part of the draft. R1 says there will be test churn, but it
does not give a concrete rewrite plan for [tool-presenters.test.ts](../../../../web/src/__tests__/tool-presenters.test.ts)
or for the new JSON tokenizer.

The tokenizer cannot be well-tested if it stays as a private function inside a
Vue SFC. R1 should require either a small pure `tokenizeJson` utility or another
explicit exportable seam, then test key-vs-string classification, arrays not
flipping `expectKey`, escaped strings, numbers, booleans, null, punctuation, and
the oversize fallback that mirrors [CodeBlock.vue](../../../../web/src/components/code/CodeBlock.vue#L49-L60).

`FormattedContent` tests should cover direct JSON, invalid leading braces falling
back to text, embedded JSON with the exact v2 prefix regex, non-allowlisted prose
with braces staying text, and markdown/prose routing through `MarkdownText`.

Presenter tests should assert structured parts: file paths produce `{ kind:
'file' }`, URLs produce `{ kind: 'url' }`, command snippets produce `{ kind:
'code' }`, result tones map to the v3 vocabulary, and unknown tools use the
single documented fallback.

### 6. Transversal impact

R1 names the two required consumers and says call sites update in the same PR.
That is necessary. The next round should be more explicit about the files and
local types that change: `ChipParts` in [AnalystChatPanel.vue](../../../../web/src/components/chat/AnalystChatPanel.vue#L153-L167),
the repeated `toolCallView`/`toolResultView` calls in [AgentConversationView.vue](../../../../web/src/components/agents/AgentConversationView.vue#L71-L103),
and the raw `CodeBlock` expansion paths in both consumers.

The Files view watcher and store routing are also transversal impact for F05,
not a follow-up. If `InlinePart.file` is clickable in this PR, then the query
routing needed to open the right pane must land in this PR.

### 7. Over-engineering

The draft stays appropriately small on inline kinds: `text`, `file`, `url`, and
`code` only. It also explicitly rejects streaming tokenization, a DSL, and a
highlight.js replacement in [01-analysis-r1.md](01-analysis-r1.md#L371-L374). That
part is approved.

The one over-complexity risk is the `FormattedToolPair` layer if the surfaces do
not actually render paired calls/results yet. It may still be the right model for
future F03/F04 work, but F05 needs a contract that compiles cleanly against the
current separate call/result consumers.

### 8. Alternative considered

R1 does not satisfy this axis. It rejects a DSL, streaming, and a highlight.js
replacement, but it never considers an MDX-style renderer or a
react-json-view-equivalent dependency. The next round must include those
alternatives and reject them with concrete reasons: Vue integration cost,
dependency surface, token mismatch with `--syn-*`, accessibility/copy behavior,
bundle size, and the fact that v2's behavior is small enough to port directly.

## Required Items

1. REQUIRED: Specify a presenter contract that works with independent call and result consumers, or explicitly move pairing into the surfaces in the same PR; do not rely on hidden pair state inside `presentToolResult`.
2. REQUIRED: Fix the file click routing design. Define how `root: 'project'` maps to actual v3 file browsing, update `FilesView` query handling for `root`, and ensure `src/foo.ts`-style project paths open correctly or are not emitted as clickable project files.
3. REQUIRED: Redesign the chip markup so file/url inline parts are not anchors or router links nested inside a `<button>`.
4. REQUIRED: Provide a complete coverage matrix for every named v3 tool in `tool-presenters.ts`, covering call headline/detail, result headline/detail, tone, and the single documented fallback for unknown tools.
5. REQUIRED: State the final `InlinePart` type precisely and add structured tests proving `headline` and `detail` are `InlinePart[]` only, with no `headlineString` or string coercion shim.
6. REQUIRED: Add a concrete test plan for `JsonView` tokenization, preferably by extracting a pure tokenizer utility, and verify exact v2 token coverage and the 1 MB oversize fallback.
7. REQUIRED: Rewrite the `tool-presenters.test.ts` plan around structured parts and add `FormattedContent` tests for direct JSON, embedded JSON with the exact v2 regex, invalid JSON fallback, and non-allowlisted prose.
8. REQUIRED: Add the missing alternative analysis for MDX-style rendering and a JSON-view dependency, and reject or accept them with reasons tied to this Vue/v2-port context.
VERDICT: CHANGES_REQUESTED
