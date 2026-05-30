# F02 Component Hierarchy Review - Round 2

Review target: [01-analysis-r2.md](01-analysis-r2.md)
Prior review: [01-analysis-review-r1.md](01-analysis-review-r1.md)
Class-surface reference: [../F01-design-tokens/01-analysis-r2.md](../F01-design-tokens/01-analysis-r2.md)

## Blocking Findings

No blocking findings.

The r2 draft addresses the nine required items from r1 at the functional-analysis level. It now separates base primitives from content renderers and conversation composites, reconciles unsupported class names by either dropping them or enumerating F02 pattern extensions, fixes the main API gaps, expands the deletion/test matrices, covers the duplicated idioms requested by the review, corrects the transversal-impact framing, adds a real alternatives section, and resolves the Overlay accessibility strategy.

## Required Items Coverage

1. Shared layer split: addressed. `ui/`, `content/`, and `conversation/` are now distinct sublayers with import rules and a clear discriminator for store/router/fetch-coupled components.
2. Pattern-class reconciliation: addressed in substance. Unsupported r1 names such as `btn-sm`, `tool-chip-*`, `msg-*`, and `thinking-dots` are dropped or scoped; required additions are listed explicitly. See the non-blocking F01 wording note below.
3. API corrections: addressed. `ToolPresentationView` is defined as the F05 output, `MessageBubble` drops `tool`, `Card tone` is specified, and `WorkspaceHeader` is excluded from `PanelHeading`.
4. Deletion matrix: addressed. The matrix now covers AppShell/auth, ApiTokenEntry, WorkspaceHeader, NavRail, Dashboard, Files, Debug, Agents, Raw LLM, Analyst chat/toaster, cards, and catch-all selector families.
5. Selector/test migration plan: addressed. The draft names affected tests, separates behavioral `data-testid`/role queries from primitive-only pattern-class assertions, and gives explicit Overlay and ToolChip test contracts.
6. Duplicated idiom coverage: addressed. Auth banners, status chips, icon buttons, loading states, tabs/navigation, callouts/state panels, form controls, toaster, and list rows are all accounted for.
7. Transversal impact: addressed. r2 correctly states containers keep data/routing/store/WebSocket responsibility while losing bespoke visual CSS, and adds Dashboard/Files/Debug sub-surface breakdowns.
8. Alternatives: addressed. CSS-class-only, thin Vue wrappers, and headless dialog/tabs are compared with accurate rejection criteria.
9. Overlay accessibility: addressed. Focus trap, focus restoration, Escape/backdrop handling, inert background, AppShell shortcut suppression, multiple overlays, and tests are specified.

## Spot Checks

Deletion-matrix selector existence was spot-checked against the live v3 tree. The following selector names from the matrix exist in current source and/or tests: `.auth-required-banner`, `.token-overlay`, `.runtime-banner`, `.files-global-banner`, `.debug-tab`, `.sv-pill-kind`, `.rlp-refresh`, `.primary-btn`, `.conv-tb-btn`, and `.filter-chip`.

Component-to-matrix coverage was also spot-checked. Selected selectors from [web/src/components/auth/ApiTokenEntry.vue](../../../../web/src/components/auth/ApiTokenEntry.vue), [web/src/components/agents/RawLlmExchangePanel.vue](../../../../web/src/components/agents/RawLlmExchangePanel.vue), [web/src/components/cards/CardHistoryPanel.vue](../../../../web/src/components/cards/CardHistoryPanel.vue), [web/src/views/FilesView.vue](../../../../web/src/views/FilesView.vue), and [web/src/views/DebugView.vue](../../../../web/src/views/DebugView.vue) appear in the r2 matrix or its allowed layout-only survivor list.

## Nice-To-Haves

1. Update the stale opening text that says F01 r2 does not exist and that F02 is bound to F01 r1. F01 r2 does exist and should be the baseline reference.
2. Tighten the F01/F02 pattern-surface wording. F01 r2 explicitly says there is no `.pulse` class, only `@keyframes pulse`, while F02 r2 still lists `.pulse` as inherited in one place. Also, the optional `.tablist > .pill[aria-pressed="true"]` rule in section 6.5 should either be added to the section 2.2 extension list or kept purely surface-local.
3. Clean up two small matrix naming slips found during spot-checking: `.sv-fetch-btn` is a real DebugView selector, not a FilesView selector; DebugView has `.process-link-button`, while the matrix says `.process-link-btn (and similar)`.
4. Consider renaming `StatusDot` tone `ok` to `accent` or explicitly document why `ok` maps to `--accent`, since F01 r2 does not define a separate `--ok` slot.

VERDICT: APPROVED