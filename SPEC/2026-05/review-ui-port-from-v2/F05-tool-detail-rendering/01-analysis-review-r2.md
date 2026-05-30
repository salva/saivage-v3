# F05 Tool Detail Rendering Analysis Review R2

Review target: [01-analysis-r2.md](01-analysis-r2.md)
Previous review: [01-analysis-review-r1.md](01-analysis-review-r1.md)
Previous draft: [01-analysis-r1.md](01-analysis-r1.md)

## Summary

I found no blocking issues. R2 directly addresses the R1 objections and is specific enough to guide implementation without relying on hidden pair state, broken file roots, nested interactive chip controls, or string shims.

I spot-checked the live v3 sources requested by the prompt: [tool-presenters.ts](../../../../web/src/utils/tool-presenters.ts), [files.ts](../../../../web/src/stores/files.ts), and [FilesView.vue](../../../../web/src/views/FilesView.vue). The draft matches the current v3 file-browser reality: only `.saivage` metadata and `.saivage-work` output roots are exposed today, and project-root files are deliberately rendered as non-clickable text until a backend project-root browser exists.

## Required Item Verification

1. Independent presenter contract: satisfied. R2 removes `FormattedToolPair`; `presentToolCall` and `presentToolResult` each return their own `{ icon, name, headline, detail, status }` payload and `presentToolResult` does not consult original call args. Pairing is explicitly left to surfaces that have both messages.

2. File click routing: satisfied. `InlinePart.file` is limited to `root: 'meta' | 'output'`, aligned with `METADATA_ROOT = '.saivage'` and `OUTPUT_ROOT = '.saivage-work'` in the file store. R2 also updates the `FilesView` query design to use `?root=meta|output&path=...` and makes project paths plain text instead of broken links.

3. Chip markup: satisfied. The proposed chip is a non-button `div role="group"` with a dedicated expand `button`; `router-link` and external `a` elements are siblings of that button. The consumer notes explicitly mention both [AgentConversationView.vue](../../../../web/src/components/agents/AgentConversationView.vue) and [AnalystChatPanel.vue](../../../../web/src/components/chat/AnalystChatPanel.vue), including their current raw `CodeBlock` expansion paths.

4. Per-tool coverage matrix: satisfied. I mechanically compared `CALL_PRESENTERS` and `RESULT_PRESENTERS` in the live `tool-presenters.ts` against the R2 matrix. The live maps contain 46 unique tool names; the matrix covers all 46 with no missing tool rows. The apparent extra `meta` and `output` names came from the separate file-root table, not the tool matrix.

5. Final `InlinePart` type and no string shim: satisfied. The union is precise and exported, with no `headlineString`, string fallback, or `detail?: string` compatibility path. `detail` is always `InlinePart[]`. I also type-checked a standalone strict TypeScript snippet using the proposed union; exhaustive switching compiled cleanly, and `@ts-expect-error` checks confirmed the old overloaded `value` fields on `file` / `url` parts and `root: 'project'` are rejected.

6. JSON tokenizer testability: satisfied. R2 extracts `tokenizeJson` into a pure utility and gives a concrete test plan covering object keys, array comma behavior, escaped strings, numbers, booleans, null, punctuation, whitespace, defensive unterminated strings, and the 1 MB fallback in `JsonView`.

7. Presenter and `FormattedContent` tests: satisfied. The rewritten `tool-presenters.test.ts` plan is structured-part based and removes string headline assertions. `FormattedContent` tests cover direct JSON, embedded JSON with the v2 allowlist regex, invalid JSON fallback, non-allowlisted prose with braces, plain prose, and empty input.

8. Alternatives: satisfied. R2 considers and rejects a JSON-view dependency, MDX-style rendering, and markdown-for-everything with concrete Vue/v2-port reasons: token mismatch, dependency and CSS surface, sanitization risk, bundle cost, and loss of structured JSON/link semantics.

## Additional Checks

The `InlinePart` shape is consumer-friendly: the renderer can switch on `kind` and derive display text for `file` and `url` from canonical target fields instead of carrying a second display value that can drift. The only shared `value` field remains on `text` and `code`, where it represents the actual visible literal and is discriminated safely by `kind`.

The one small wording note is that R2 calls bare `?path=` inference in `FilesView` "Back-compat". That is not blocking because it is local query handling for currently emitted links, not an old data format or presenter shim, and the new typed route is still `root=meta|output`.

VERDICT: APPROVED
