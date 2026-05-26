# Design: F05 — tool presenter registry, InlinePart, FilesView routing

Third of five linked proposals. Requires F01 + F02 merged.

The canonical documents live under `SPEC/2026-05/review-ui-port-from-v2/F05-tool-detail-rendering/`. This file is the mailbox entry.

## Problem

`web/src/utils/tool-presenters.ts` is a 600+ line switch statement that mixes per-tool presentation logic into one module. It blocks per-tool tests, makes the file/url anchor surface inconsistent across consumers, and conflicts with the chip-as-`role="group"` markup that F03 needs. `FilesView` currently has no canonical query routing for the two file roots (`meta` vs `output`).

## Decision

Implement [F05 02-design-r3.md](../SPEC/2026-05/review-ui-port-from-v2/F05-tool-detail-rendering/02-design-r3.md). Read [01-analysis-r2.md](../SPEC/2026-05/review-ui-port-from-v2/F05-tool-detail-rendering/01-analysis-r2.md) for the per-tool coverage matrix and [03-plan-r1.md](../SPEC/2026-05/review-ui-port-from-v2/F05-tool-detail-rendering/03-plan-r1.md) for the 9-commit sequence.

Binding contract:

- Registry-based presenters under `web/src/utils/tool-presenters/`; one file per tool name. Single barrel `index.ts` is the only production entrypoint; ESLint `no-restricted-imports` forbids deep imports.
- `InlinePart` discriminated union: `text | file | url | code`, with `file.root: 'meta' | 'output'` (no `project` / `saivage` legacy roots).
- `presentToolCall` and `presentToolResult` are independent — no `formatToolPair`, no shared pair state.
- New pure utility `web/src/utils/json-tokenize.ts`.
- `ToolChip` Vue template (in F02's `components/conversation/`): non-button `<div role="group">` with ONE dedicated `<button>` for expand + sibling `<a>` anchors for files/urls. No nested interactives.
- `FilesView` accepts `?root=meta|output&path=<file>`. No bare-path fallback.
- `web/package.json` `sideEffects` array lists the per-tool registration files so bundler tree-shaking does not drop them. `assertDefault()` runtime guard.
- Per-tool coverage table matches every tool currently in the existing presenter; `coverage.test.ts` asserts the registry equals `EXPECTED_TOOL_NAMES` exactly.
- Old single-file `web/src/utils/tool-presenters.ts` is deleted in the same change set. No re-export shim.

## Files to change

Plan §C1–C9 is authoritative. High-level: scaffold the directory + barrel + ESLint rule + `sideEffects`; per-tool files; `InlineParts.vue` + types under `components/content/`; `json-tokenize.ts`; `ToolChip.vue` template in `components/conversation/`; `FilesView` rewrite; consumer migration in `AgentConversationView` and `AnalystChatPanel` (chip rendering only — the chip swap on AnalystChatPanel is F03's responsibility); test suite (coverage, barrel-integrity, ARIA/DOM, routing).

## Files / tests / docs to delete

- `web/src/utils/tool-presenters.ts` (single-file legacy).
- Tests that assert against the old `formatToolPair` / `FormattedToolPair` API.

## Validation gate

1. `pnpm -C web typecheck`
2. `pnpm -C web test`
3. `pnpm -C web build`
4. ESLint barrel-only rule passes.
5. `coverage.test.ts` and `barrel-integrity.test.ts` pass.
6. Playwright MCP smoke against `http://127.0.0.1:8090`: open an agent conversation with tool calls, expand a tool chip, click a file anchor (verify it routes to `FilesView` with `?root=...&path=...`), and visit the analyst chat panel to confirm tool chips still render via the same chip component.

## Risks / accepted residuals

- Registry init ordering: handled by `sideEffects` manifest + bare-import statements in the barrel + runtime `assertDefault()` guard.
- Tree-shaking: the `sideEffects` array is the only safety net; do not lose it during refactors.

## Out of scope

- ToolChip swap in `AnalystChatPanel.vue` consumer code — F03 owns that swap (it lands in the same batch as the round timeline).
- Conversation round bucketing (F03).
- Chat surface decomposition (F04).

## Architecture rule

`ARCHITECTURE-FIRST, NO BACKWARD COMPATIBILITY`. Delete the old presenter file outright. No `file.root: 'project'` shim. No `rawContent` field on `ToolCallPresentation`/`ToolResultPresentation`.
