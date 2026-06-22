# F05 — Tool-call / JSON detail rendering is minimal

## Summary

When a tool chip is expanded in v3, the detail is a `<CodeBlock>` of pretty-printed JSON only. There is:

- No fallback to rendered markdown when the payload is plain prose (LLM tools frequently return prose).
- No detection of "prose with embedded JSON" (e.g. `Tool result: {…}`), which v2 handles in `extractEmbeddedJson()`.
- No semantic JSON colouring beyond highlight.js defaults — keys, strings, numbers, booleans, nulls all share the same hue family.
- No inline file/url linkification of tool inputs and outputs — operators have to copy-paste paths into the Files view rather than clicking them.

v2 has three layers that solve this:

1. `FormattedContent.vue` — input is raw string; output is either `JsonHighlight` (parsed JSON) or markdown-rendered HTML. Handles embedded-JSON-after-prose.
2. `JsonHighlight.vue` — token-aware syntax highlighting that uses `--syn-key`, `--syn-string`, `--syn-number`, `--syn-boolean`, `--syn-null`, `--syn-punctuation`. Identifies keys by tracking object-vs-array stack depth, so values that happen to be strings don't get the key colour.
3. `toolFormatters.ts` — per-tool functions that return a structured **summary line** (`InlinePart[]`: `{kind:'file'|'url'|'code'|'text', value, tone}`) which the chip uses for the headline. The view then renders each part as a `<a>` (file → opens Files view; url → external) or styled `<span>`.

In v3 the equivalent is `web/src/utils/tool-presenters.ts` (already exists) but it returns flat strings, not parts. Extend it (don't rewrite) so the headline can carry file/url affordances; keep the existing call sites compiling. JSON colour tokens come from F01.

## Evidence

- v3 today:
  - [web/src/components/code/CodeBlock.vue](../../../web/src/components/code/CodeBlock.vue) — single highlighter, no special handling.
  - [web/src/utils/tool-presenters.ts](../../../web/src/utils/tool-presenters.ts) — returns `{ icon, name, headline, detail, status }` only.
- v2 reference:
  - [saivage/web/src/components/JsonHighlight.vue](../../../../saivage/web/src/components/JsonHighlight.vue)
  - [saivage/web/src/components/FormattedContent.vue](../../../../saivage/web/src/components/FormattedContent.vue)
  - [saivage/web/src/utils/toolFormatters.ts](../../../../saivage/web/src/utils/toolFormatters.ts)

## Category

Half-implemented.

## Severity

Medium.

## Transversality

Localized — only the chip-expansion path. Consumed by F03 / F04 once landed.
