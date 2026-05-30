# F05 - Tool detail rendering: Design Review (R1)

Reviewer round 1 for [02-design-r1.md](02-design-r1.md). Inputs checked:

- F05 approved analysis: [01-analysis-r2.md](01-analysis-r2.md)
- Cross-issue contracts: [F02 r2](../F02-component-hierarchy/01-analysis-r2.md), [F03 r2](../F03-conversation-rounds/01-analysis-r2.md), [F04 r3](../F04-chat-surface-style/01-analysis-r3.md)
- Current v3 presenter catalogue: [web/src/utils/tool-presenters.ts](../../../../web/src/utils/tool-presenters.ts)

## Blocking Findings

### 1. Proposal B violates the explicit no-alias requirement

The design opens with the correct architecture-first rule: no backward compatibility shims, no aliased presenter exports, and no old presenter contract left behind. The selected Proposal B then introduces a first-class alias subsystem:

- `registerAlias(aliasName, target)` in `registry.ts`
- `ALIASES` in runtime state
- `read_file.ts`, `list_directory.ts`, `run_shell_command.ts`, and `start_and_wait.ts` as alias files
- `_registryKeysForTest()` returning `{ tools, aliases }`
- `aliases.test.ts` and `presentToolCall > follows an alias`

Even if the intent is only implementation reuse, it still adds a second resolution path and makes the chosen contract non-direct. The user instruction for this review is explicit: the chosen path replaces the existing presenter contract without aliases.

Required change: remove `registerAlias`, `ALIASES`, alias coverage, and alias tests from Proposal B. If multiple tool names share behavior, use a shared factory/helper and have each tool file call `registerToolPresenter(name, makeXPresenter(...))` directly. The registry keys should be the complete expected tool-name set, with no alias side channel.

### 2. `ToolChip` cannot render expanded details from the proposed props

The public presenter contract returns:

```ts
{ icon, name, headline: InlinePart[], detail: InlinePart[], status }
```

It does not include raw call or result content. But the `ToolChip.vue` template in the design renders:

```vue
<FormattedContent :content="call.rawContent" />
<FormattedContent :content="result.rawContent" />
```

That property does not exist on `ToolCallPresentation` or `ToolResultPresentation`. F03 r2 and F04 r3 also describe a chip prop bag of `{ call: ToolCallPresentation, result: ToolResultPresentation | null, status, expanded, detailsId, timestamp? }`, which has the same gap.

Required change: define the raw-content ownership explicitly. Good options are:

- `ToolChip` props carry `callRawContent: string` and `resultRawContent?: string`, while `call`/`result` remain pure presentations.
- A `ToolChipCall`/`ToolChipResult` wrapper carries `{ presentation, rawContent }` for each half.
- The expanded detail slot is owned by the container, and `ToolChip` only exposes the accessible header/toggle.

Do not add `rawContent` to `ToolCallPresentation`/`ToolResultPresentation`; that would mix presenter output with source payload and weaken the clean F05 contract.

### 3. Proposal B's entrypoint story conflicts with the cross-issue consumers and its own tests

Proposal B says `web/src/tool-presenters/index.ts` is the only entry point. The cross-issue contracts and snippets still import from `../../utils/tool-presenters`, and Proposal B's own per-tool test example imports `../../tool-presenters/registry` plus an individual presenter file directly.

That creates three public surfaces:

- `web/src/tool-presenters/index.ts`
- `web/src/tool-presenters/registry.ts`
- the old/current `web/src/utils/tool-presenters.ts` path used by F03/F04 snippets

This is exactly the kind of parallel surface the project guideline is trying to avoid.

Required change: pick one canonical public import path and make every consumer/test snippet use it. If Proposal B keeps `web/src/tool-presenters/` as the new public module, update AgentConversationView, AnalystChatPanel/F04 adapter examples, F03 examples, and tests to import from that module. The old `web/src/utils/tool-presenters.ts` must be deleted in the same batch or become the real implementation entrypoint, not a compatibility re-export.

### 4. Registry initialization and tree-shaking risks are acknowledged but not closed

Proposal B depends on self-registering modules plus side-effect imports. The design notes that the side-effect pattern must be exercised exactly once, but the mitigation is thin:

- `assertDefault()` only catches a missing default at runtime.
- Per-tool tests that import `registry` and a single tool file do not exercise the real barrel initialization path.
- The design does not specify a rule preventing app code from importing `registry.ts` directly and bypassing `index.ts`.
- Tree-shaking is waved away as not a concern, but the selected architecture relies on side effects being retained.

Required change: add a concrete initialization contract. At minimum:

- no production imports from `registry.ts` are allowed outside `web/src/tool-presenters/index.ts` and test-only files;
- a test imports only the canonical public entrypoint and asserts default registration plus every tool name;
- a barrel-integrity test asserts every presenter file is imported by `index.ts`;
- the design states why Vite/Rollup will retain the side-effect imports, or changes the registry to an explicit static object/array that does not depend on module side effects.

Without this, Proposal B is not yet justified against Proposal A's simpler direct-map initialization.

### 5. The per-tool matrix is mostly complete, but one row is internally inconsistent

The design enumerates all current `CALL_PRESENTERS` names from [web/src/utils/tool-presenters.ts](../../../../web/src/utils/tool-presenters.ts): `read_project_file`, `read_file`, `list_project_files`, `list_directory`, `write_project_file`, command/process tools, card tools, runtime tools, notes, skills, MCP, history, and `diff_card`. The B `EXPECTED_TOOL_NAMES` list also includes the full call-side set, including names that currently fall through the old result fallback (`get_status`, `get_plan_diary`, `get_card_output`, `get_note`, `pause_runtime`, `resume_runtime`, `abort_goal`, `restart_goal`, `list_card_history`, `get_card_history_entry`, `diff_card`). That is the right scope for the replacement.

Spot checks against the current file:

- `read_project_file`: call path and result line/byte/binary summary are represented, with project-root paths correctly non-clickable.
- `write_project_file`: call path plus char count and result wrote-bytes/wrote-file are represented.
- `run_project_command`: current result detail is the process id when available; the shared table earlier says `stdout-tail`, while Proposal A/B later says process id. This must be reconciled.
- `wait_for_process`: correctly has its own call headline (`process pid`) even though the result can share command-result logic.
- `mcp_tool_call`: call tool name/detail params and result summary are represented.

Required change: make the matrix single-source and remove the `stdout-tail` vs `process pid` contradiction. Also make the coverage test derive or hard-check both required dimensions: every current named call presenter has a registered call presenter, and every expected result behavior intentionally registers a result presenter instead of accidentally falling through `__default__`.

### 6. The test plan misses the browser-facing seams most likely to regress

The tokenizer, JsonView, FormattedContent, and presenter unit tests are strong. The selected design also changes accessibility markup, routing, and two consumer surfaces, but the test plan does not name tests for them.

Required additions:

- `ToolChip` component test: outer `role="group"`, exactly one expand `<button>`, `aria-expanded`, `aria-controls`, detail id wiring, and file/url anchors rendered as siblings rather than nested interactives.
- `InlineParts` test: file parts route to `{ name: 'files', query: { root, path } }`; url parts use `target="_blank"` and `rel="noopener noreferrer"`.
- `FilesView` route test: `?root=meta&path=...` calls `navigateMeta`, `?root=output&path=...` calls `navigateOutput`, and bare `?path=` does nothing.
- Agent conversation integration test: paired call/result chips render via the shared `ToolChip`, expand into call/result `FormattedContent`, and delete old string helpers.
- Analyst chat integration test: persisted tool pairs and pending invocations both use the same `ToolChip` prop bag.
- Registry entrypoint test for Proposal B as described above.

## Checks That Pass

- Two real proposals are present. Proposal A is a focused direct-port map; Proposal B is a registry-based alternative with separate files and per-tool tests. The schema-driven renderer is treated as an alternative and rejected for concrete reasons.
- The `InlinePart` union is discriminated by `kind`, keeps `file` and `url` canonical (`path`/`url`) rather than display-value overloads, and limits file roots to `meta | output`.
- `json-tokenize.ts` is a pure utility skeleton: no Vue imports, no DOM, no stores, no router, and defensive non-throwing behavior.
- `FormattedContent` keeps the prose branch behind `MarkdownText` and avoids `v-html`.
- The chip template has the right high-level ARIA shape: a non-button `role="group"`, a dedicated expand button, `aria-expanded`, `aria-controls`, and details outside the group.
- The `FilesView` route shape is correct for the project guideline: `?root=meta|output&path=...`, widened watcher on both keys, and no bare `?path=` fallback.
- The consumer cleanup direction is correct: delete old string helpers in `AgentConversationView`; remove the analyst-local chip API and route persisted and pending analyst tools through the shared chip.

## Recommendation

Proposal B can be justified over Proposal A only after the alias and entrypoint problems are fixed. Its per-tool files and isolated tests are useful for a growing tool catalogue, and `coverage.test.ts` is a real improvement over review-only discipline. But the current side-effect registry introduces more initialization surface than the design closes, and the alias mechanism violates the binding no-backward-compatibility rule.

I would keep Proposal B as the selected direction if the next revision makes the registry explicit and alias-free, defines raw-content ownership for expanded details, and expands the tests to cover the accessibility/routing/consumer seams. Otherwise Proposal A is safer because it has fewer boot-order and tree-shaking failure modes.

VERDICT: CHANGES_REQUESTED
