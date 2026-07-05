# Operator UI/UX Audit

Status: findings document (input for `docs/spec/operator-ui.md` and follow-up work).

Date: 2026-07-04

## 1. Purpose and method

This is a ground-up usability audit of the operator web UI as it stands after the 2026-07-04 card-page and conversation rework. It is written from the operator's point of view: *what is this screen trying to tell me, and does it succeed?*

The audit is grounded in the current source under `web/src/`. Findings cite component files so they can be verified and turned into tasks. It is **not** an implementation plan; it is the catalog of issues and improvement opportunities. Implementation should be sequenced separately, ideally against the existing `docs/spec/operator-ui.md` and `docs/architecture/agent-conversation-ui-redesign.md`.

Severity key:

- **P0** — broken, actively misleading, or blocks understanding.
- **P1** — significant friction or redundancy that hurts the core tasks.
- **P2** — polish, consistency, or low-frequency rough edges.

The operator's core tasks, used as the yardstick throughout:

1. Understand what the runtime is doing right now (state, current run, errors).
2. Inspect a card: its objective, its status, what agents said about it, and its records.
3. Read an agent conversation as a narrative, not a JSON log.
4. Navigate laterally between cards, files, processes, and conversations.
5. Get immediate feedback when the system is working, and see new agent/card state as soon as it is available.

Design constraints confirmed during review:

- Preserve the user-decided shell: left workspace plus always-visible right Analyst panel at desktop widths. Do not introduce drawers or hidden panels for the Analyst.
- Preserve the Analyst-owned mutation boundary from `docs/spec/operator-ui.md`. UI improvements may add read-only navigation, filtering, copy, refresh, and preference controls, but not card/runtime mutation controls.
- Prefer a small shared component vocabulary over one-off surfaces. Most current roughness comes from AI-agent-added local CSS patterns rather than an intentional platform language.
- Keep the product visually calm and operator-focused: dense enough for technical work, but with clear hierarchy, accessible non-color cues, and document/chrome distinction.
- Treat latency as part of the UX. If an agent is thinking, waiting on tools, streaming text, or updating cards, the UI should show that state intentionally and quickly rather than leaving stale content or blank transcript boxes.

## 2. Cross-cutting issues

These affect every surface and should be fixed at the design-system level before per-view polish.

### C1 — No shared "section"/"panel" primitive (P1)

Every view reimplements section framing with ad-hoc `border-bottom` + an uppercase muted `.section-heading`. There is no reusable card/panel component, so framing is inconsistent and weak (see F1). Introduce one `Panel`/`Section` primitive with a clear header slot, optional meta/actions, and a body slot, then migrate card detail, dashboard, agents, files, debug, and conversation diagnostic panels onto it. This should be a restrained platform primitive, not a decorative per-view card style.

### C2 — Inverted visual hierarchy: labels are quieter than content (P1, P0 effect on record-heavy card pages)

Section headings are 12px, uppercase, muted (`web/src/components/cards/CardDetailView.vue`, `.section-heading`). Rendered markdown bodies are 13px regular. The result is that **content visually outweighs the labels that delimit it**, so the eye cannot find section boundaries. The issue is most severe on card detail because rendered records contain their own headings. Headings must be at least as prominent as the body they label, or sections must be framed by the shared panel primitive.

### C3 — Monospace overuse (P2)

`'SF Mono'` is applied to tool rows, record paths, tags, ids, status values, and many labels. Monospace signals "machine data"; applying it to prose-ish UI chrome increases visual noise and competes with the places where mono is meaningful (ids, paths, code, commands). Reserve `--mono` for genuinely machine-produced tokens.

### C4 — Type icons are cryptic text glyphs (P2)

Cards are typed with `(P) (G) (A) (C) (T) (D) (DA) (R) (O)` text in both the tree (`web/src/components/cards/CardsTreeView.vue:68`) and the detail header (`web/src/components/cards/CardDetailView.vue`, `TYPE_ICONS`). These are illegible to anyone who has not memorized the map. Use the SVG icon set already used in the NavRail (`web/src/components/layout/AppShell.vue:93`), or at minimum a single colored shape per type, plus a tooltip with the full word.

### C5 — Redundant status surfaced in multiple places (P1)

Status/runtime state is shown in the workspace header chips, the dashboard runtime console, and (for cards) the detail header — often restating the same value in three forms. The header already exposes connection/runtime/cue; the dashboard and the card header should *not* repeat the ambient state, they should add detail. (See F3, S3.)

### C6 — Project name is hardcoded (P1)

`web/src/components/layout/AppShell.vue:103` sets `projectName = 'saivage-v3'`, which is the *product* name, not the *project*. On the pueblicos or getrich deployments the header reads `saivage-v3`, which is wrong. Pull a project display label from the runtime-state response when available. Today the web API exposes `projectId` as `basename(projectRoot)`, while persisted `runtime.project_id` is the literal `project`; a true human display name would need the project config `name` to be exposed by the backend.

### C7 — Header section title is generic (P2)

`WorkspaceHeader` shows the route label ("Card Detail", "Agents") rather than the entity in focus (the card title, the session id). The operator loses context about *which* card/agent they are looking at. Prefer a stable route label in the global header plus an entity breadcrumb/context strip in the view header; only promote entity titles into `WorkspaceHeader` if the shared shell can do it without coupling tightly to every store.

## 3. Card detail page

`web/src/components/cards/CardDetailView.vue` and `web/src/views/CardsView.vue`.

### F1 — Sections are not visually delimited (P1, P0 for first-time comprehension)

The whole card page is a single scroll of flat sections separated only by a 1px `border-bottom` (`CardDetailView.vue` `.detail-section`). With quiet headings (C2) and large rendered markdown bodies, there is no clear boundary between "Objectives", "Agent status", "Review", "Agent conversations", etc. The operator cannot tell what is UI chrome and what is rendered document content.

Recommendation: frame each section with the shared panel primitive from C1 — a modest surface with a header row (label + optional meta/actions) and a body. Use a subtle document treatment for *rendered record* bodies so they read as "attached document," distinct from UI-assembled metadata grids. Avoid a rainbow of per-section accent colors; if accents are used, reserve them for state/tone (warning, error, active) rather than content category.

### F2 — Redundant "Back to Cards" button (P1)

`web/src/views/CardsView.vue:6` renders a "← Back to Cards" button plus the raw card id in a header bar above the detail. The current bar is weak because it repeats navigation and shows the least meaningful label (raw id). However, removing the only in-view return path would be a regression unless the list remains visible.

Recommendation: replace the bar with a real card context header. On wide desktop, prefer master-detail so the tree/list remains visible and no back button is needed. On narrower workspace widths, keep a clear "Cards" return affordance but pair it with a breadcrumb such as `Cards / …ancestors / <display_path>` and the card title. Do not rely only on the NavRail or browser back for returning to the card list.

### F3 — Status is shown twice; cancellation reason is verbose (P1)

The header row has a status chip (`cancelled`) and immediately below a always-visible `STATE` line repeating the explainer sentence, e.g. "This card was cancelled and should not be treated as completed work." (`CardDetailView.vue` `state-line`, `statusExplainer`). For cancellations and failures the long sentence adds little and competes with the title.

Recommendation: keep the status chip as the single status affordance; move the explainer into the chip's `title` (tooltip) and/or show a one-line reason *only* for error/blocked/cancelled states. Drop the always-present state line for healthy states.

### F4 — UI label collides with rendered document content (P1)

The section is titled "Objectives & records", and the first record body is the `brief.md`, whose markdown typically begins with its own `# Objectives` heading. The result is two "Objectives" stacked, with nothing distinguishing UI label from document (`CardRecordsSection.vue`). 

Recommendation: name the group "Records" and each document by **record slot** (`brief.md`, `status.md`, `review.md`) with a human label only as secondary text (Brief, Status, Review). These names are stable, unambiguous, and match the `record://` URLs the operator sees elsewhere. Render each record inside a document frame: a header row `brief.md · v3 · <writer>` and a body with a faintly different surface (`--surface-1`) so it is unmistakably "the attached document," not UI text.

### F5 — Metadata is buried and collapsed (P1)

Metadata (id, created/updated, version, priority, urgency, assigned_to) is a collapsed `<details>` at the bottom. It is low-height and genuinely useful for orientation (especially `id`, `version_seq`, `assigned_to`, timestamps). The collapse forces an extra click for information that fits in one row.

Recommendation: promote a **compact orientation strip** under the title (display path/id · type · version · priority · assigned · updated-relative). Keep it short enough not to compete with the card objective. Keep the verbose/full metadata grid in a disclosure for the rest.

### F6 — Header row ordering and emphasis (P2)

The title row order is `status chip → type badge → title → discuss button`. Status before the title is unusual; the cryptic type badge (C4) sits between status and title. Lead with the **title** (the card's identity), then secondary affordances (type label/icon, status chip) and the "Discuss with analyst" action grouped as a header action. This matches common page-header practice and keeps state visible without making it the title.

### F7 — Hierarchy is split across two sections (P2)

Ancestors render under "Hierarchy & dependencies" while children render under "Child work" (`CardDetailView.vue`). This splits the single concept of hierarchy into two places. Merge into one "Hierarchy" section with ancestors (↑) above and children (↓) below, so the operator sees the card in context.

### F8 — `lifecycle.result` is dumped as raw JSON (P1)

The "Result" section renders `currentCard.lifecycle.result` through `CodeBlock` as JSON (`CardDetailView.vue`). This is the one place on the card page that shows a raw JSON dump by default, inconsistent with the conversation principle (JSON only on request). Render a human summary if available, with the raw JSON behind a toggle, mirroring the tool detail.

### F9 — Record empty-states are inconsistent (P2)

`CardRecordsSection.vue` uses a prominent "No brief has been recorded for this card yet." for the brief but a muted "No status record yet." for status/review. Align tone and wording across the three slots, and make the brief empty-state actionable ("Ask the analyst to write a brief").

### F10 — CardConversationsSection reloads all sessions (P2)

`CardConversationsSection.vue` calls `listAgentSessions()` (the whole list) on every card open and filters client-side, and the inline conversation frame is a fixed `height: 480px` regardless of viewport. Consider a server-side `card_id` filter when the API grows that projection. In the meantime, a cached store-level session list is probably a better first step than adding a one-off endpoint. Use a flexible frame height with sensible min/max bounds.

### F11 — Multiple stacked stale/error ribbons (P2)

`StaleWarningRibbon`, the `.detail-callout.warning` freshness line, and the error callout can stack, producing two or three yellow/red bands at once. Collapse into a single status ribbon with the most severe message.

## 4. Cards list / tree

`web/src/views/CardsView.vue`, `web/src/components/cards/CardsTreeView.vue`.

### L1 — No filter UI despite store support (P1)

The card store already carries `filterStatus`, `filterType`, `filterTag`, `searchQuery` and computed `filteredCards`/`board` (`web/src/stores/cards.ts`), but the Cards view exposes **only** the tree, with no filter/search controls. Operators cannot narrow a large tree. Surface a compact filter bar (status, type, search) over the tree.

### L2 — Only the tree view is exposed (P2)

The store computes a kanban `board` (by status) that the UI never renders. For status-oriented triage a board/column view can be valuable, and `docs/spec/operator-ui.md` explicitly allows tree/board/list projections. Treat this as a secondary projection after search/filter and master-detail. Avoid adding a board toggle if it becomes a new visual language unrelated to the tree/list row components.

### L3 — Selecting a card replaces the list (P1)

`CardsView` swaps the tree out for the detail view entirely, so the operator loses their place in the tree and must use the back button (F2). Prefer a responsive master-detail layout within the existing workspace: persistent tree/list on wide screens, single-column list/detail with breadcrumb return on constrained widths. Avoid a slide-over unless it becomes a shared platform pattern; the product already has a permanent Analyst rail, so additional side panels would add spatial complexity.

### L4 — Tree node density and affordances (P2)

Each node renders display_path, title, priority, tags, and a dependency count, in monospace, with `node-title` truncated. Priority only appears if `> 5`. The row is information-dense and the status is a tiny 8px dot with no label. Consider a secondary line for full title and a status *label* (not only color, for accessibility — the dot is color-only).

## 5. Agent conversations (analyst rail + debug/agents view)

Shared: `web/src/components/conversation/*`, `web/src/components/agents/AgentConversationView.vue`. Spec authority: `docs/architecture/agent-conversation-ui-redesign.md`.

### V1 — Assistant turns have no delimiter at all (P1)

After the rework, `RoundCard` hides the header for assistant rounds (`showHeader` = user/diagnostic only). A long assistant turn is now an undifferentiated wall of text and tool rows with no "turn" boundary, which conflicts with the redesign spec's retained round structure. Restore a subtle, calm round header/delimiter (`Assistant · round 5`, model only when non-ambient) without reintroducing heavy cards.

### V2 — No role tinting on text bubbles (P2)

The spec calls for role-tinted bubbles; currently `ContextBlock` only colors the role *label* (`Assistant`/`You`). Consecutive user/assistant turns read as undifferentiated text. Add one restrained role cue shared across Analyst and Debug surfaces: either a left border or a very light background tint. Do not use both, and do not introduce per-role bubble styles that fight the compact operator-console aesthetic.

### V3 — Diagnostic rows are uniformly alarming (P2)

`DiagnosticRow` renders every diagnostic (including benign `model_repair`/`model_recovered`) as a full warn-colored box. Reserve warn/error styling for unrecovered issues; render recovered/repair events as neutral, collapsed notes.

### V4 — Pending-call footer is still generic (P2)

`PendingCallFooter` shows `{tool} pending` for all pending tool states. The conversation redesign spec requires distinct states (thinking, retry in Ns, rate-limited, next-retry time), but the current backend only exposes `activity_status.status` and `pending_calls[]` with `id`, `tool`, and `started_at`. Rich retry/rate-limit/backoff/attempt metadata is backend functionality still needed before this can be completed.

### V5 — Conversation header toolbar is ungrouped (P2)

`AgentConversationView` shows `Expand all · Collapse all · Last raw LLM exchange` as three flat buttons with a verbose label. Group as primary (expand/collapse) vs. diagnostic (raw exchange), and shorten the raw-exchange toggle label.

### V6 — Grouped rows do not yet split out late failures (P2)

`ToolGroupRow` collapses adjacent context calls. Per the spec, if a grouped call later errors during live updates it should be split out or the group should auto-expand with an error count. Not yet implemented; groups are static.

### V7 — Waiting feedback must be explicit and immediate (P1)

When a view is showing an active agent conversation, the operator needs confirmation within a fraction of a second that work is underway. The display should show a calm animated indicator for `thinking`, `tool_calling`, `responding`, and `compacting` states, including the period before the first text/tool row exists. This must be an intentional status row, not an accidental empty round.

Recommendation: render a shared activity indicator from `activity_status` in agent conversation views and from the Analyst chat send/pending state in the Analyst rail. The indicator should use short labels such as `Thinking...`, `Waiting for tool result...`, or `Writing response...`, with `aria-live="polite"` for screen readers.

### V8 — Partial conversation data should render ASAP (P1)

Conversation UX should not wait for an arbitrary "complete chunk" before updating. User-submitted chat text should appear optimistically; provider text/tool-call/tool-result segments should appear as soon as the server exposes them; and raw diagnostic events such as `llm_turn_started` should drive status indicators, not visible transcript bubbles.

Recommendation: keep transcript rendering segment-based and append/reconcile incrementally. If backend/provider streaming is not yet available, the UI should still expose every persisted segment as soon as it arrives through WebSocket invalidation or polling. Raw `activity` entries should stay available to Debug/raw views but be filtered from the narrative transcript unless mapped to a human-readable status row.

### V9 — Conversation rounds can render empty boxes from diagnostic events (P1)

The Analyst panel has shown repeated empty boxes labeled `User · <number>` with no content. The likely cause is transcript entries with no narrative content (empty text or raw activity events like `llm_turn_started`) being grouped into visible rounds. This is misleading: it looks like the user said something blank, when the entry is really internal progress metadata.

Recommendation: suppress rounds with no visible text, diagnostics, tools, or active status. Keep `llm_turn_started` as diagnostic/progress input for Debug and status indicators, not as a user-visible chat message.

### V10 — Runtime/card projections must refresh ASAP (P1)

The same freshness rule applies outside conversations. Cards, runtime status, process state, and record history should update as soon as authoritative state changes, not only after manual refresh or a slow polling interval. Stale-state ribbons are useful, but they are a fallback; the primary UX should be prompt live reconciliation.

Recommendation: treat WebSocket invalidation plus REST refetch as the standard projection path for cards, card detail, card history, runtime status, processes, and conversations. Views should show small live-update affordances while refetching and preserve scroll/selection context when new data arrives.

## 6. Workspace shell

`web/src/components/layout/AppShell.vue`, `WorkspaceHeader.vue`, `web/src/components/nav/NavRail.vue`.

### S1 — Header pills are redundant and jargon-heavy (P1)

`WorkspaceHeader` shows up to three pills: a WebSocket pill (`WS LIVE`/`WS OFFLINE`), a runtime pill, and a cue pill. "WS LIVE" is internal jargon; the cue often restates the runtime pill. Consolidate only where meanings overlap: keep live-update connectivity and runtime execution state distinct, but rename the WebSocket label to operator language (`Live`, `Offline`, `Reconnecting`, `Unauthorized`) and show stale/degraded as a state overlay or tooltip rather than a third default chip.

### S2 — Runtime tooltip is repetitive (P2)

The runtime chip tooltip always appends "Use Dashboard → Runtime Console for execution controls." (`web/src/components/layout/WorkspaceHeader.vue:72`), regardless of context. Show this hint only when the action is actually available/relevant.

### S3 — Dashboard restates header state (P1)

The Dashboard "Runtime Console" repeats Status / Live State / runtime chip that the header already shows (`DashboardView.vue`). The dashboard should add *detail and controls* (current run, actionable errors, commands), not restate ambient state. Drop the redundant status grid or make it the authoritative detailed expansion of the header chip.

## 7. Other views (brief)

### Agents view (`web/src/views/AgentsView.vue`)
- **A1 (P2):** session rows show raw `goal_card_id`/`card_id` text; resolve to display paths/titles. Role icons are `(AN)/(PL)` text (C4).
- **A2 (P2):** same list-replaces-detail pattern as cards (L3); consider master–detail.

### Files, Timeline, Debug
- **O1 (P2):** Timeline is a thin wrapper over `CardsTimelineView`; ensure its affordances match the cards list (filters, selection model).
- **O2 (P2):** Debug view is large and out of scope for this audit, but it should reuse the shared `Panel`/`Section` primitive (C1) and the conversation primitives per the redesign doc.

## 8. Empty, loading, error, and unauthorized states

Copy and tone vary across views ("No cards match…", "No messages yet. Ask the analyst something.", "No agent sessions have run against this card yet.", "No tracked card history exists yet…"). **P2:** standardize a small set of empty/loading/error patterns via the shared primitives, with consistent action guidance.

## 9. What is working well (keep)

- The conversation **tool-row grammar** (`Action target… status`) and the generic fallback for unknown/MCP tools (`web/src/utils/tool-friendly.ts`) — calm, scannable, JSON kept behind a toggle.
- **Context grouping** of consecutive read-only calls (`ToolGroupRow`) materially reduces noise.
- The **NavRail keyboard shortcuts** (1–6, `/` to focus chat) are a genuine productivity win.
- The **header status chip** concept is the right idea; it just needs clearer separation between live connectivity and runtime execution, less jargon (S1), and a correct project name (C6).
- **Records fetched and rendered as markdown** on the card page is the right direction; it only needs the document/label distinction (F4) and section framing (F1).

## 10. Target design

This section supersedes the earlier sequencing/review drafts. The operator UI does three things: watch the runtime, inspect an entity, and talk to the Analyst. The architecture follows from that, and it is smaller than a general-purpose design system.

### 10.1 Structure

- **Workspace shell (keep, user-decided):** NavRail | workspace | always-visible Analyst panel. Not renegotiated.
- **Entity inspector shell (new, shared):** Cards, Agents, and Files are all list/tree + detail. One master-detail shell provides the list pane, selection model, entity header, and detail pane; each type plugs in its own list renderer and detail renderer. Dashboard and Debug are not entity inspectors — they stay specialised but consume the same primitives.
- **Conversation timeline (new, one renderer):** the shared unit is the timeline of rounds/text/tools/diagnostics, rendered by one `ConversationTimeline`. The Analyst panel and the Debug/Agents view remain *different shells* (composer + narrow density vs raw-exchange panels + wide density) that both embed `ConversationTimeline`. The shells are not merged into one flag-driven component — that would create a god-component. This is the highest-value consolidation and removes the Analyst/Debug timeline divergence.
- **Document (new, one component):** renders a versioned markdown document. Used by card records (`brief`/`status`/`review`), notes, and any future attached document.
- **Status (new, one system):** one tone vocabulary (`neutral`, `active`, `success`, `warning`, `danger`, `pending`, `stale`, `unauthorized`) plus `StatusBadge`/`StatusBanner`. Every domain status maps into it once.
- **Layout primitives (small):** `Section`, `EmptyState`. The full shared set is intentionally tiny; a new primitive is added only when a second consumer already exists.

### 10.2 Card detail: faceted, not one scroll

The card body stops being one undifferentiated scroll of equally-styled blocks. It becomes a set of facets behind a single entity header (identity + status badge + compact orientation strip), where each facet is framed by the `Section` primitive and rendered by the appropriate component:

- **record facets** (`brief`, `status`, `review`) render as attached documents through the `Document`/`RecordDocument` component — a distinct document surface, header `brief.md · v3`, so UI chrome never collides with a document's own headings;
- **conversation facets** render through `ConversationTimeline`;
- **structural facets** (merged hierarchy of ancestors + children, dependencies, dispatches, notes, result, history) render as compact panels.

The fix for the original complaints (sections not delimited, labels quieter than content, label/content collision, duplicate status, buried metadata) is the shared `Section` framing rule plus the document treatment — not a rigid two-zone taxonomy and not per-section styling.

### 10.3 The one structural rule

Components never fetch directly and never interpret raw API state. Existing Pinia stores and composables are the single sources of truth; they are completed/fixed (not duplicated) to emit view models with explicit display states (`loading`, `empty`, `error`, `unauthorized`, `ready`). Renderers are dumb. Applied at this level, the rule removes the file-path record fetchers (H1), the client-side session joins (H2), the local status/empty interpretation (H6), and the fake tool-call adapter (H3) — instead of policing each smell individually.

### 10.4 No bridges

No adapter, bridge, or synthetic-payload code is added or kept. The two existing tool-presentation layers converge into one `ToolDisplayModel`/`ToolDetailModel`, and `ToolRow` becomes a dumb renderer. Pending Analyst activity, card records, and card-scoped sessions are never synthesised into shapes the backend does not produce; they are either real projections or honest limited states.

### 10.5 Backend dependencies (in flight — not designed here)

Verified gaps the clean frontend depends on, all backend-side and currently being changed: a card records projection (so `get_card` carries record content — today `CardDetailCardSchema` only adds `dependencyRefs`/`relatedRefs`); Analyst tool activity as real transcript entries (today it arrives on a separate WebSocket activity channel); a card-scoped session filter; structured tool-result envelopes; richer activity/pending status (retry/backoff/rate-limit); token streaming (`stream: false` today); a project display name (today only project-root basename is exposed); entity links in tool results; child-dispatch/conversation references; compaction summaries; full invalidation coverage for every projection.

### 10.6 Sequencing

Stage by backend readiness, not by what is easiest. Brave does not mean big-bang: prove one vertical slice end-to-end, then expand.

1. **Now, frontend-only:** consolidate to one Conversation component and one `ToolDisplayModel`/`ToolDetailModel`; delete the fake pending-tool adapter; prove it across Analyst + Debug first. Then add the tiny shared set (`Section`, `EmptyState`, `StatusBadge`/`StatusBanner`, `Document`, `EntityHeader`) and the status vocabulary. Then build the entity-inspector master-detail shell and move Cards onto it (Filters, L1, included); reuse for Agents and Files. Then reframe card detail into the documents/structure zones.
2. **Backend-gated — render honest limited states until each lands:** records projection, card-scoped sessions, analyst-activity-as-entries, structured tool envelopes, richer pending status, streaming, project name, entity links, child-dispatch refs, compaction summaries, full invalidation coverage.
3. **Rule:** never remove a frontend data path before its backend replacement exists, or the UI loses its data. Order deletions by backend readiness.

The original operator complaints are mostly visual hierarchy (section framing, duplicate status, buried metadata, label/content collision); those fall out of 10.1–10.3 for free. The genuinely architectural pieces (records, card-scoped conversations, analyst activity) are backend-blocked and are represented honestly, not faked.
