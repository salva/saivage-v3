# F02 Component Hierarchy Review - Round 1

Review target: [01-analysis-r1.md](01-analysis-r1.md)
Issue: [F02-component-hierarchy.md](../F02-component-hierarchy.md)
Subsystem map: [00-SUBSYSTEM-MAP.md](../00-SUBSYSTEM-MAP.md)

## Summary

The analysis correctly identifies the core failure: v3 has no shared UI primitive layer, so buttons,
pills, status markers, message rows, tool rows, overlays, cards, and code/content renderers are
re-created in many scoped style blocks. The proposed direction, a small set of typed Vue wrappers
that emit the F01 pattern classes, is directionally right.

I am requesting changes because the current primitive inventory is not yet cleanly carved, the
pattern-class contract does not line up with the actual v2/F01 class surface, the deletion list misses
many destructive selector removals, and the alternative analysis is incomplete. The writer should keep
the good nucleus but revise the analysis before moving to design/plan.

## 1. Clean Architecture

The strongest part of the draft is the separation rule: anything in `web/src/components/ui/` must not
import Pinia, router, fetch, or WebSocket clients. That is the right architectural boundary, and it
matches the data-flow split in [00-SUBSYSTEM-MAP.md](../00-SUBSYSTEM-MAP.md).

The primitive set is too mixed, though. `Button`, `Pill`, `Card`, `StatusDot`, `Spinner`, and maybe
`Overlay` are primitives. `ToolChip`, `MessageBubble`, `FormattedContent`, `MarkdownText`, `JsonView`,
and `CodeBlock` are reusable presentational/content components, not primitives in the same sense. They
may still belong under a shared UI area, but the analysis should name the layers explicitly, for example:

- `components/ui/primitives/`: `Button`, `Pill`, `Card`, `StatusDot`, `Spinner`, `Overlay`.
- `components/ui/content/`: `CodeBlock`, `MarkdownText`, `JsonView`, `FormattedContent`.
- `components/ui/conversation/`: `ToolChip`, `MessageBubble`, maybe `ThinkingDots`.

Without that split, `ui/` becomes a dumping ground for any reusable SFC that happens not to import a
store. That is not a clean architectural joint.

`ToolChip` is also a composite disguised as a primitive. It composes a button row, an icon/name/headline
layout, a detail pill, an expansion state, `aria-controls`, and a details slot. It is useful and reused
by [web/src/components/agents/AgentConversationView.vue](../../../../web/src/components/agents/AgentConversationView.vue)
and [web/src/components/chat/AnalystChatPanel.vue](../../../../web/src/components/chat/AnalystChatPanel.vue), but it
should be documented as a conversation component, not a base primitive.

`MessageBubble` has the same issue. It owns article semantics, role/kind mapping, default meta, badge
slots, and role-to-entry-class mapping. That is a conversation atom/composite, not a pattern primitive.
The analysis should avoid pretending it is equivalent to `Button` or `Pill`.

`PanelHeading` is plausible, but the proposed API is too narrow for [web/src/components/layout/WorkspaceHeader.vue](../../../../web/src/components/layout/WorkspaceHeader.vue),
which currently needs an `h1`-level page title plus multiple status chips. The draft only allows heading
levels `2 | 3` and assumes a generic `meta/actions` arrangement. That may fit panel sections but not the
workspace-level header.

There is also an internal inconsistency around `Card`: section 2.3 defines only `active` and `as`, but
section 5.6 and the container table expect `Card tone="warn"`. Either `tone` is part of the API, or
warning/error banners need a separate documented pattern. The current draft cannot be implemented as
written.

## 2. No Backward Compatibility

The analysis correctly says there should be no aliasing of removed v3 classes. That honors the project
rule: delete old structures rather than preserving compatibility shims.

The deletion list is not concrete enough yet. It lists important classes such as `.conv-tb-btn`,
`.primary-btn`, `.tool-chip-tag`, `.token-btn*`, `.nav-pill`, `.tc-*`, and `.tr-*`, but the actual v3
surface has many more bespoke selectors that would disappear or change under the proposed primitive
layer. Examples include:

- Dashboard refresh, banners, status rows, record rows, and chips in [web/src/views/DashboardView.vue](../../../../web/src/views/DashboardView.vue).
- File pane refresh buttons, breadcrumbs, viewer state boxes, quarantine footer buttons, and file rows in [web/src/views/FilesView.vue](../../../../web/src/views/FilesView.vue).
- Debug tabs, operator banners, fetch buttons, process badges, MCP badges, supervision pills, doctor banners, and process link buttons in [web/src/views/DebugView.vue](../../../../web/src/views/DebugView.vue).
- App auth banner selectors tested in [web/src/__tests__/app-shell-auth-banner.test.ts](../../../../web/src/__tests__/app-shell-auth-banner.test.ts).
- History filter chips and history badges in [web/src/components/cards/CardHistoryPanel.vue](../../../../web/src/components/cards/CardHistoryPanel.vue).
- Toast selectors in [web/src/components/chat/AnalystToaster.vue](../../../../web/src/components/chat/AnalystToaster.vue).
- Raw LLM panel selectors in [web/src/components/agents/RawLlmExchangePanel.vue](../../../../web/src/components/agents/RawLlmExchangePanel.vue).

The revised analysis needs a deletion matrix, not just a representative list. For each old class family,
name the replacement primitive/pattern class or say it remains as layout-only.

The draft also suggests new pattern names that do not exist in v2 and are not specified by F01. If these
are required, the analysis must state that F02 extends `patterns.css`; otherwise these are just bespoke
styles with nicer names.

## 3. Correctness

The primitive wrappers must genuinely emit established pattern classes. Several proposed classes are
not in [../saivage/web/src/styles/patterns.css](../../../../../saivage/web/src/styles/patterns.css) and are not in the
F01 analysis as delivered:

- `btn-sm` is used by `Button`, but v2 `patterns.css` has `.btn`, `.btn-primary`, and `.btn-danger`, not
  `.btn-sm`.
- `pill-purple` is used by `Pill`, but v2 has `.pill-warn`, `.pill-accent`, and `.pill-danger`, not
  `.pill-purple`.
- `status-dot-{tone}` is required by `StatusDot`, but v2 only defines `.status-dot` and expects the
  color to come from context or inline style.
- `thinking-dots` is proposed as a pattern class, but v2 keeps the dot markup and animation in
  [../saivage/web/src/components/ChatWindow.vue](../../../../../saivage/web/src/components/ChatWindow.vue), while
  `patterns.css` only defines `pulse`.
- `tool-chip`, `tool-chip-row`, `tool-chip-details`, `msg`, `msg-meta`, and `msg-content` are not v2
  pattern classes. If `ToolChip` and `MessageBubble` rely on them, F02 must define the global pattern
  rules explicitly.

The proposed `ToolChip` prop type is also wrong as written. [web/src/utils/tool-presenters.ts](../../../../web/src/utils/tool-presenters.ts)
defines `ToolCallPresentation` and `ToolResultPresentation`; it does not define `ToolPresenterView`.
A revised API should either introduce a shared `ToolPresentationView` type in that utility or accept a
specific union/normalized view object.

`MessageBubble` has a role mapping gap. It allows `role: 'tool'`, but the described `entryClass(role)`
maps only to `entry-user`, `entry-accent`, `entry-warn`, and `entry-purple`. The analysis needs an
explicit mapping for tool rows or should remove `tool` from `MessageBubble` and keep tool content in
`ToolChip`.

ARIA contracts are directionally good but not yet realistic enough for implementation. `Overlay` promises
focus trap, focus restoration, Escape handling, and backdrop behavior, but leaves the actual strategy as
an open question. That is too late for a functional analysis because the chosen strategy affects whether
we hand-roll this primitive or use a headless dialog component. Also, AppShell installs a window-level
keydown listener in [web/src/components/layout/AppShell.vue](../../../../web/src/components/layout/AppShell.vue), so
`Overlay` must specify how it prevents global shortcuts from firing while dialogs are active.

`StatusDot` should not always render `role="img"`. In status chips that already include visible text,
the dot is decorative and should likely be `aria-hidden="true"`; when used alone it needs an accessible
name. The revised API should support both cases.

`CodeBlock` is already a behavior-bearing content component with highlight, copy, oversize handling, and
clipboard fallback in [web/src/components/code/CodeBlock.vue](../../../../web/src/components/code/CodeBlock.vue). Relocating it is fine, but the
analysis should not describe it like a thin pattern-class primitive.

## 4. Completeness

The required sampling finds several misses.

Composer button: covered in principle by `Button`, but the analysis should explicitly include the
`AnalystChatPanel` submit button and any test migration away from `.primary-btn` in
[web/src/__tests__/analyst-chat-panel.test.ts](../../../../web/src/__tests__/analyst-chat-panel.test.ts).

Auth banner: partially covered, but the composition table for [web/src/components/layout/AppShell.vue](../../../../web/src/components/layout/AppShell.vue)
does not mention the sticky auth-required banner. The draft later suggests using `Card tone="danger"` or
`entry-danger`, but that API is not defined.

Status chips: not fully covered. `Pill` plus `StatusDot` can express parts of the pattern, but the app
has repeated dot-plus-label status chips in [web/src/components/layout/WorkspaceHeader.vue](../../../../web/src/components/layout/WorkspaceHeader.vue),
[web/src/views/DashboardView.vue](../../../../web/src/views/DashboardView.vue), [web/src/views/AgentsView.vue](../../../../web/src/views/AgentsView.vue),
and [web/src/views/DebugView.vue](../../../../web/src/views/DebugView.vue). The analysis should decide whether there is a `StatusChip`
composite or a documented `Pill` slot convention.

Tool chips: covered, but the draft must reconcile the two current renderers and the actual
`tool-presenters.ts` types.

Message bubbles: covered, but the analysis does not state how v2's [../saivage/web/src/components/FormattedContent.vue](../../../../../saivage/web/src/components/FormattedContent.vue)
and [../saivage/web/src/components/JsonHighlight.vue](../../../../../saivage/web/src/components/JsonHighlight.vue) replace the current
plain-string rendering in `AnalystChatPanel`.

Modal overlay: covered for [web/src/components/auth/ApiTokenEntry.vue](../../../../web/src/components/auth/ApiTokenEntry.vue), but the draft
incorrectly treats [web/src/components/agents/RawLlmExchangePanel.vue](../../../../web/src/components/agents/RawLlmExchangePanel.vue) as an overlay/drawer
candidate even though it is currently an inline panel below the conversation header. If F02 intends to
change that interaction model, say so and justify it; otherwise keep it as an inline panel using shared
heading/button/card/code components.

Navigation pills: covered only for `CardDetailView`'s `.nav-pill`. The larger navigation idioms are
`NavRail` links, `CardsView` view tabs, `DebugView` tabs, and Raw LLM attempt tabs. A primitive set that
only has `Button` and `Pill` will leave several duplicated tab/segmented-control styles untouched.

Refresh/spinner: `Spinner` exists in the inventory, but the actual v3 refresh idioms are `.refresh-btn`,
`.panel-refresh-btn`, `.rlp-refresh`, `.sv-fetch-btn`, `.retry-btn`, `viewer-close-btn`, and symbol-only
buttons. The analysis needs either an `IconButton`/`Button iconOnly` convention or a concrete decision
that these all become `Button size="sm"` with icon slots. This is currently missing.

Other duplicated idioms omitted from the analysis include callouts/banners/state panels, empty/loading/error
states, form controls (`textarea`, `input`, `select`), tab strips, file/list rows, and toast surfaces. Not
everything needs a Vue wrapper, but the analysis must account for why these stay layout-local or map to
patterns.

## 5. Testability

The per-primitive test convention is a good start. `web/src/__tests__/ui/Button.test.ts` and similar files
are a clear convention.

The destructive selector migration plan is not sufficient. Existing tests assert old classes directly,
for example `.primary-btn`, `.auth-required-banner`, `.auth-banner-action`, `.token-overlay`,
`.refresh-btn`, `.files-global-banner`, `.debug-loading`, `.mcp-server-badge`, `.sv-pill`, and many card
badge classes under [web/src/__tests__/](../../../../web/src/__tests__/). The revised analysis needs a
selector migration table with at least these columns:

- Old selector.
- Owning component/test file.
- New selector or preserved `data-testid`.
- Whether the selector is visual-only, behavioral, or accessibility-critical.

For tests, prefer stable role/text/test-id queries for behavior and only assert pattern classes in the
new primitive unit tests. Otherwise F02 will replace one brittle selector surface with another.

`Overlay` tests also need to be explicit: Escape closes once, backdrop click respects `closeOnBackdrop`,
focus moves into the dialog, focus is restored, Tab cycles, and global AppShell shortcuts are suppressed
while open.

`ToolChip` tests need to cover `aria-expanded`, `aria-controls`, keyboard activation, details slot
visibility, status class mapping, and the normalized presenter type.

## 6. Transversal Impact

The document identifies many container components, but the "pure layout shells" framing is overstated.
Several listed containers still own data fetching, store wiring, routing, polling, or WebSocket behavior:
`RawLlmExchangePanel`, `AnalystToaster`, `CardHistoryPanel`, `StaleWarningRibbon`, `FilesView`,
`DebugView`, and `DashboardView` are not pure layout shells. What should become layout-only is their
scoped visual CSS, not their component responsibility.

The container list is broad but the composition descriptions are too shallow to drive implementation.
For example, `DashboardView` is described as a grid of cards, but the actual file contains runtime
console sections, banners, refresh controls, status chips, record rows, and index bars. `FilesView` is
more than tree plus viewer: it has stale/unauthorized banners, file panels, breadcrumbs, refresh buttons,
a viewer drawer, and quarantine controls. `DebugView` has multiple tab-specific sub-surfaces with their
own badges, banners, refresh buttons, process cards, and supervision pills. The revised analysis should
name these families or it will under-plan the blast radius.

The analysis also does not explain how the v2 [../saivage/web/src/components/StatusPanel.vue](../../../../../saivage/web/src/components/StatusPanel.vue)
and [../saivage/web/src/components/PlanView.vue](../../../../../saivage/web/src/components/PlanView.vue) idioms map to the v3 Dashboard/Debug/Cards
surfaces. Those v2 components are in the requested cross-check set and should influence the shared
patterns for metrics, queues, stage rows, status dots, and refresh buttons.

## 7. Over-Engineering

Some wrappers look premature as standalone Vue components.

`ThinkingDots` appears to be a one-off extraction from v2 `ChatWindow`. Unless the v3 target has at least
two call sites in this port, a global `.thinking-dots` pattern plus inline markup may be enough.

`Spinner` may be worthwhile if refresh/loading icons are standardized, but the draft does not show that
call-site plan. If loading states remain text-only in many places, a wrapper component is premature.

`Overlay` is complex enough that it should not be casually hand-rolled as a 15-to-60-line primitive. It
needs either a precise local implementation plan or a dependency decision.

`Card tone` is a good alternative to inventing a one-use `Banner`, but it must be specified consistently.
If only one warning ribbon uses it, prefer existing `Card` plus `entry-warn`/`Pill` composition rather
than adding banner-specific props.

## 8. Alternatives Considered

The document rejects Tailwind and broad UI libraries, which is fine, but it does not consider the main
alternative implied by v2: CSS pattern classes only, no Vue wrappers for simple elements.

A serious revision should compare:

- CSS-class-only: port F01 patterns and update templates to use `.btn`, `.pill`, `.card`, `.panel-heading`,
  `.overlay`, `.code-block`, and `.status-dot` directly.
- Thin Vue wrappers: add typed props/events for highly repeated elements while still emitting only pattern
  classes.
- Headless dialog/tabs option: use an unstyled library only for the hard accessibility cases such as
  dialog focus trapping and possibly tab groups.

The current Headless UI/Radix rejection is not persuasive because those libraries are intentionally
unstyled. Saying they would reintroduce design-token coupling is inaccurate for headless primitives. A
better rejection would be based on dependency cost, bundle size, project simplicity, and the small number
of truly hard ARIA widgets.

## Required Items

1. Split or rename the shared component layers so base primitives are not mixed with conversation/content composites; explicitly classify `ToolChip`, `MessageBubble`, `CodeBlock`, `MarkdownText`, `JsonView`, and `FormattedContent`.
2. Reconcile every proposed class with the actual v2/F01 pattern surface. Either remove unsupported names (`btn-sm`, `pill-purple`, `status-dot-*`, `thinking-dots`, `tool-chip-*`, `msg-*`) or state exactly which F02 pattern rules are added.
3. Fix incorrect or incomplete APIs: define the real tool presenter prop type, resolve `MessageBubble`'s `tool` role mapping, decide `Card tone`, and expand `PanelHeading` or exclude `WorkspaceHeader` from that primitive.
4. Replace the partial deletion list with a concrete old-selector to new-pattern/primitive migration matrix covering Dashboard, Files, Debug, Raw LLM, Toaster, CardHistory, AppShell auth banner, nav/tabs, and existing tests.
5. Add a selector/test migration plan that names affected test files, preserves behavioral `data-testid` selectors where needed, and moves pattern-class assertions into primitive tests only.
6. Complete the required duplicated-idiom coverage: auth banner, status chips, refresh/icon buttons, spinner/loading states, navigation/tabs, callouts/banners/state panels, form controls, and toast/list-row surfaces.
7. Correct the transversal impact section so container components are described as retaining data/routing/store behavior while losing scoped visual CSS, and add the missing Dashboard/Files/Debug sub-surface breakdown.
8. Add a real alternatives section comparing CSS-class-only, thin Vue wrappers, and headless dialog/tabs libraries, with accurate rejection criteria for each.
9. Resolve the `Overlay` accessibility strategy in the analysis, including focus trap, focus restoration, Escape/backdrop handling, and suppression of AppShell global shortcuts.

VERDICT: CHANGES_REQUESTED