# Subsystem Map — UI Port from Saivage v2 to Saivage v3

Scope: the **web frontend** of `saivage-v3` ([web/](../../../web/)), and the parts of the **`saivage` v2 frontend** that define the visual identity and conversation-display semantics we want to import. Backend / runtime is out of scope; only the v3 web layer changes.

## In-scope subsystems

### v3 (target) — `/home/salva/g/ml/saivage-v3/web/src/`

- **Entry & routing**
  - [web/src/main.ts](../../../web/src/main.ts) — Vue app bootstrap, router, Pinia. Currently imports only `highlight.js/styles/github-dark.css`. **No global stylesheet** is loaded.
  - [web/src/App.vue](../../../web/src/App.vue) — 7-line shell that just mounts `AppShell`.
- **Layout / shell**
  - [web/src/components/layout/AppShell.vue](../../../web/src/components/layout/AppShell.vue) — top-level grid; embeds `NavRail`, `WorkspaceHeader`, `AnalystChatPanel`, `AnalystToaster`, `ApiTokenEntry`. Hard-codes dark-theme hex (`#0d1117`, `#161b22`, `#30363d`, `#da3633`, `#58a6ff`, …).
  - [web/src/components/layout/WorkspaceHeader.vue](../../../web/src/components/layout/WorkspaceHeader.vue) — sticky top bar.
  - [web/src/components/nav/NavRail.vue](../../../web/src/components/nav/NavRail.vue) — left rail navigation.
- **Views (routed)** under [web/src/views/](../../../web/src/views/) — `DashboardView`, `CardsView`, `AgentsView`, `FilesView`, `DebugView`, `NotFound`.
- **Conversation / chat surfaces**
  - [web/src/components/agents/AgentConversationView.vue](../../../web/src/components/agents/AgentConversationView.vue) — per-agent timeline: flat `step` list (reasoning + tool-call + tool-result). Each tool chip is a single bar with `+/-` to expand a `CodeBlock` of raw JSON. No grouping by round, no diagnostic categories, no compacted clusters, no pending footer.
  - [web/src/components/agents/RawLlmExchangePanel.vue](../../../web/src/components/agents/RawLlmExchangePanel.vue) — drawer that shows the last raw LLM request/response.
  - [web/src/components/chat/AnalystChatPanel.vue](../../../web/src/components/chat/AnalystChatPanel.vue) — right-rail analyst chat (compose, send, tool chips, badges).
  - [web/src/components/chat/AnalystToaster.vue](../../../web/src/components/chat/AnalystToaster.vue) — transient toast surface.
- **Markdown / code primitives**
  - [web/src/components/code/CodeBlock.vue](../../../web/src/components/code/CodeBlock.vue) — pre + highlight.js + copy.
  - [web/src/components/code/MarkdownText.vue](../../../web/src/components/code/MarkdownText.vue) — markdown render to HTML.
- **Cards surface** under [web/src/components/cards/](../../../web/src/components/cards/) — `CardDetailView`, `CardHistoryPanel`, `Cards{Board,Leaderboard,Timeline,Tree}View`, `StaleWarningRibbon`. Every file ships its own scoped `<style>` with hex values.
- **Auth**
  - [web/src/components/auth/ApiTokenEntry.vue](../../../web/src/components/auth/ApiTokenEntry.vue) — modal token entry.
- **Stores** under [web/src/stores/](../../../web/src/stores/) — Pinia stores for agents, analystChat, cards, debug, files, mcp, runtime, ws, workspaceRoute. **Out of scope as data sources** — we will reuse them; we are not changing the API contracts.
- **Utilities** under [web/src/utils/](../../../web/src/utils/) — `format-json`, `highlight`, `markdown`, `tool-presenters`, etc. `tool-presenters.ts` already exists; we will extend (not replace) it.

### v2 (source) — `/home/salva/g/ml/saivage/web/src/`

- **Style system** (the asset we want to port)
  - [saivage/web/src/styles/index.css](../../../../saivage/web/src/styles/index.css) — aggregator.
  - [saivage/web/src/styles/tokens.css](../../../../saivage/web/src/styles/tokens.css) — raw palette (`--c-gray-*`, `--c-green`, `--c-indigo`, …), typography stacks, radii, shadows.
  - [saivage/web/src/styles/semantic.css](../../../../saivage/web/src/styles/semantic.css) — mappings: `--bg`, `--surface-1..3`, `--border*`, `--text*`, `--accent`, `--accent-2`, `--warn`, `--danger`, `--entry-*-bg/border`, `--code-*`, `--syn-*`, `--btn-primary-*`, `--overlay-bg`, `--hover-bg`.
  - [saivage/web/src/styles/base.css](../../../../saivage/web/src/styles/base.css) — global resets, scrollbar, default code element.
  - [saivage/web/src/styles/patterns.css](../../../../saivage/web/src/styles/patterns.css) — pattern classes consumed across components: `.entry-{user,accent,warn,danger,purple}`, `.card`, `.btn`, `.btn-primary`, `.btn-danger`, `.pill[-warn|-accent|-danger]`, `.code-inline`, `.code-block`, `.syn-*`, `.panel-heading`, `.status-dot`, text utilities, `.overlay`, `.spin`, `.pulse`.
- **Conversation rendering** (the behavior we want to port)
  - [saivage/web/src/components/AgentsView.vue](../../../../saivage/web/src/components/AgentsView.vue) — sidebar (Active / History tabs) + thread panel. The thread panel groups raw `ConversationEntry[]` into **rounds** keyed by `roundId` (`r-pre`, `r-msg:N`, `r{k}`, `r-compacted-{n}`), each round containing:
    - `reasoning` (assistant text / activity),
    - `toolPairs` (tool_call + tool_result matched by `toolUseId`, with statuses `pending | ok | error | orphan | missing`),
    - `context` (user/system text in a round that has no assistant reasoning yet),
    - `diagnostics` (`model_issue` / `model_repair` / `model_recovered`).
    - Standalone diagnostics, standalone context, and **compacted clusters** also appear as timeline items.
    - A live pending-call footer is rendered from `activity_status.pending_call` (`in_flight` vs `backoff`, attempt, throttled, retry-at).
  - [saivage/web/src/components/ChatWindow.vue](../../../../saivage/web/src/components/ChatWindow.vue) — composer + message list with role-colored bubbles, thinking dots, jump-to-latest, model chips, auth panel.
  - [saivage/web/src/components/FormattedContent.vue](../../../../saivage/web/src/components/FormattedContent.vue) — auto-detect JSON vs markdown rendering; reused by every conversation surface.
  - [saivage/web/src/components/JsonHighlight.vue](../../../../saivage/web/src/components/JsonHighlight.vue) — token-aware JSON pretty-printer using `--syn-*` tokens.
  - [saivage/web/src/utils/toolFormatters.ts](../../../../saivage/web/src/utils/toolFormatters.ts) — per-tool summary/result formatters returning `InlinePart[]` with `file` / `url` / `code` / `text` tones; consumed by `AgentsView` tool rows.

### Out of scope

- v3 backend (`src/`), v2 backend, runtime contracts. The API surface stays as-is.
- Pinia stores' data shapes; we only consume what already exists.
- v2 itself — we do not touch `saivage/`.
- `.saivage/` runtime state in either repo.
- Tests beyond updating selectors / assertions affected by the structural changes.

## Relationships (data flow)

```
Pinia store (v3)            UI primitives (new)            Surfaces (refactored)
─────────────────           ─────────────────────          ──────────────────────────
useAgentStore               <PanelHeading>                 AgentConversationView
  steps                     <Pill>, <Button>, <Card>         → round timeline
  expandedToolCalls         <CodeBlock>, <JsonView>          → tool pairs
useAnalystChat              <MessageBubble>                AnalystChatPanel
  messages, draft           <ToolChip>                       → composer + bubbles
useRuntimeStore             <StatusDot>                    WorkspaceHeader, AppShell
                            <FormattedContent>             (state-tinted strips)
```

The pattern classes (`.btn`, `.pill`, …) live in `styles/patterns.css`. UI primitives are thin Vue wrappers that emit those classes plus a small typed API (variant, tone). Surfaces only do layout; visuals come from semantic tokens.

## Key invariants for the port

- v3 stays **dark by default** (current values map closer to GitHub-dark than to v2's light VitePress palette). v2's `tokens.css` is **light**, so we cannot just copy it byte-for-byte: we must create a v3 dark-mode token set that uses **the same semantic variable names** (`--surface-1`, `--entry-user-border`, `--syn-key`, …) so the pattern layer and components are theme-portable.
- No backward compatibility with the hard-coded hex literals: all hex in `web/src/components/**` and `web/src/views/**` is **removed** and replaced with `var(--…)` references.
- No backward compatibility with v3's current flat `step` model in `AgentConversationView` — replace with the round/timeline structure outright. The store provides flat `steps`; the grouping is a view concern.
