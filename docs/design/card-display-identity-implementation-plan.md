# Card Display Identity Implementation Plan

Date: 2026-06-07

Status: proposed implementation plan.

Related analysis: `docs/design/card-display-identity-analysis.md`.

## Goals

- Keep stable internal card ids as the only authoritative identity in persistence, runtime state, tool inputs, process records, activation records, dependencies, routes, and agent protocols.
- Show current human-friendly card paths, such as `1.2.1`, in operator-facing UI wherever a raw internal id is not the intended primary label.
- Fix unfiltered tree view numbering so a visible row's friendly path matches its actual current full-tree position, and make filtered views preserve or clearly label full-tree path semantics.
- Add a durable Markdown card-reference escape that stores the stable id and renders the current friendly path at display time.
- Make missing/deleted card references graceful and debuggable.
- Avoid persisting display paths as authoritative identity.

## Non-Goals

- Do not make friendly paths stable identifiers.
- Do not support tool calls that accept friendly paths instead of card ids.
- Do not migrate existing persisted prose automatically in the first pass.
- Do not hide raw ids from explicit debug/audit surfaces; make them secondary or intentional instead.

## Invariants

- Internal APIs and persisted structures use ids only for card identity.
- Operator read models may include derived display labels, but those labels are point-in-time presentation data.
- Canonical durable URLs remain id-based, for example `/cards/card-33`.
- Markdown source stores ids through an explicit escape such as `[[card:card-33]]`.
- Rendered Markdown links navigate by id, never by display path.
- Historical/audit views must state whether a card label is current or historical; current path plus raw id is the safe default.
- Friendly paths mean the card's current full-tree position, not its row number in a filtered subset. Filtered tree views must preserve ancestor context for matching descendants. If a compact search-only mode is added later, it must be a flat results view with an explicit `Full path` label rather than a promoted-root tree.

## Target Architecture

### Tree Order

Add one shared backend helper for user-facing tree order:

```ts
orderedCardsForTree(store): CardRecord[]
```

Behavior:

- Start at `project` when present.
- Walk depth-first.
- Sort siblings by `(position, id)`.
- In canonical card state, missing parents are topology corruption and should fail loudly or surface an operator-visible error. Missing dependency/evidence targets are different: those are references and should degrade through `CardRefView.missing`.
- Include orphaned roots only in explicitly degraded/debug paths, sorted deterministically by `(depth, parent, position, id)`.

Use this helper in operator read models that feed tree/list views. `CardStore.list()` may remain an unordered general collection if internal callers depend on that behavior.

### CardRefView

Introduce a presentation-only reference type:

```ts
interface CardRefView {
  id: string;
  display_path: string | null;
  title: string | null;
  missing?: boolean;
}
```

Resolution rules:

- Existing card: `id`, current `display_path`, current `title`, `missing: false` or omitted.
- Project card: `display_path: null`, title from the project card.
- Missing/deleted card: `id`, `display_path: null`, `title: null`, `missing: true`.

Rendering rules:

- Compact primary label: `display_path ?? id`.
- Full primary label: `display_path ? `${display_path} ${title}` : title ?? id`.
- Tooltip/copy detail: raw id.
- Missing label: `card-33 (missing)`.

### Server vs Client Resolution

Use server-side `CardRefView` where the response is partial or self-contained:

- Card detail dependencies.
- Card detail ancestors.
- Card detail related cards if surfaced.
- Agent session `card_id` and `goal_card_id` summaries.
- Review evidence cards when review/evidence read models are present in the relevant API response.
- Dispatch summary parent/target cards when dispatch read models are present in the relevant API response.
- Conversation/entity links emitted by server-side read models when labels are available.

Use client-side resolution where the UI already has the current card index:

- Tool-chip rendering.
- Global cards table/tree/list rows.
- Analyst chat contextual children.
- Markdown rendered in already-card-aware views.

Client-side resolution should update when the card store refreshes or receives reorder/move invalidation events.

### Markdown Card References

Use this source syntax:

```md
[[card:card-33]]
[[card:card-33|optional fallback label]]
```

The `&lt;id&gt;` part is URL-component encoded source text, not a raw arbitrary string. Generated ids such as `card-33` remain readable, while unusual schema-valid ids must be written as `[[card:&lt;encodeURIComponent(id)&gt;]]`. The renderer decodes exactly once and rejects malformed encodings or decoded empty ids. The optional fallback label is plain text up to the closing `]]`; if fallback labels need literal `]]`, they must use an escaped form defined by the parser before implementation, such as backslash escaping. Do not accept ambiguous fallback text silently.

Rendered examples:

- Current card exists: `1.6.2` with title/id in tooltip.
- Card has no display path: title or id, depending on context.
- Card is missing: fallback label if provided, otherwise `card-33 (missing)`.

Parsing rules:

- Match only explicit `[[card:&lt;id&gt;]]` escapes.
- Treat the id token as `encodeURIComponent(id)`. The raw encoded token must not contain `]`, `|`, or whitespace delimiters.
- Define and test fallback delimiter escaping before supporting fallback text that can contain `]]` or backslashes.
- Do not rewrite plain `card-33` substrings.
- Do not rewrite inside fenced code blocks or inline code.
- Escape fallback labels before rendering.
- Sanitize rendered output after conversion.
- Avoid inline event handlers. Prefer Vue-rendered `CardRefLink` instances after Markdown tokenization. If HTML anchors are used as an interim representation, delegated click handling must route through Vue Router by route name with encoded id params.

Recommended rendered HTML shape for Markdown surfaces:

```html
<a href="/cards/card-33" data-card-id="card-33" class="card-ref" title="card-33 · Card title">1.6.2</a>
```

This anchor shape is only a fallback/intermediate representation. The preferred final UI is a Vue `CardRefLink` rendered from parsed tokens so route generation uses the app router rather than hardcoded absolute paths. If `DOMPurify` strips an attribute needed for delegated navigation, either add a narrowly scoped allowlist or render card references as Vue components after Markdown tokenization instead of relying on custom attributes.

### Tool Presenters

Current tool presenters are pure functions and `InlinePart` has no card kind. Add a presentation-level card part:

```ts
type InlinePart =
  | { kind: 'text'; text: string }
  | { kind: 'file'; root: 'meta' | 'output'; path: string; label?: string }
  | { kind: 'url'; href: string; label?: string }
  | { kind: 'code'; code: string; language?: string }
  | { kind: 'card'; id: string; fallbackLabel?: string };
```

Tool presenters should emit `kind: 'card'` for card arguments and card ids in result records. Rendering components should resolve the card part at render time using the card store/index.

This is preferred over injecting a resolver into presenter functions because it preserves stable ids through the presentation pipeline and lets labels update after refresh.

### Shared Card Link Modes

Shared card-reference renderers should require an explicit time/display mode:

```ts
type CardRefMode = 'current' | 'historicalSnapshot' | 'debugRaw';
```

Mode behavior:

- `current`: render the current full-tree path and title, with raw id as tooltip/copy detail.
- `historicalSnapshot`: render a captured historical label if the caller provides one; otherwise render current path plus an explicit `current path` hint and raw id.
- `debugRaw`: render raw id as the primary label, optionally with current path as secondary detail.

This mode must exist before replacing labels in history, transcript, debug, or audit surfaces so those views do not silently inherit current-path semantics.

## Implementation Plan

### Phase 1. Backend Tree Ordering

Files likely involved:

- `src/application/read-models/card-view.ts`
- `src/application/read-models/cards-read-model.ts`
- `src/cards/state.ts`
- `src/tools/analyst-card-tools.ts`
- `tests/**/cards*`
- `web/src/__tests__/cards-tree-view-order.test.ts`

Steps:

1. Add a backend helper that returns cards in user-facing preorder tree order.
2. Use it in `CardsReadModelService.listCards()`.
3. Preserve `CardStore.list()` unless a repo-wide audit proves it is safe to make it ordered.
4. Make `computeCardDisplayPath()` fail loudly or return an explicit operator-visible corruption state when a canonical parent chain is missing. Do not silently emit partial paths for canonical card data.
5. Keep any orphan/degraded ordering behavior out of normal operator card-tree rendering; reserve it for debug/doctor output with clear corruption labels.
6. Update analyst `list_cards` to use the same user-facing tree order, or explicitly mark it as protocol/debug output. Prefer ordering it because planner/analyst transcripts are later shown to users.
7. Add tests with `card-10`, `card-4`, and non-lexicographic ids to prove tree/list ordering follows `position`.
8. Add corrupt parent-chain tests for display-path computation and card-list read models.
9. Update web tests so unfiltered visible tree order and `display_path` agree.
10. Update filtered-tree behavior so matched descendants are not misleadingly shown as new visible roots with unchanged full-tree paths. The default algorithm should include unmatched ancestors as context rows, visually marked as context/ancestor-only and not counted as matched results. If a compact search-only mode is later introduced, make it a separate flat result view with a `Full path` column.

Acceptance criteria:

- A parent with children at positions `0..n` renders as `1.1`, `1.2`, `1.3`, not filesystem/id order.
- `getCard()` detail children remain position-ordered.
- Search/filter results preserve ancestor context for matching descendants and do not imply that full-tree paths are filtered-row numbers.
- Missing canonical parents fail loudly or surface a corruption state; missing dependency/evidence references remain graceful `CardRefView.missing` cases.

### Phase 2. CardRefView Read Models

Files likely involved:

- `src/application/read-models/card-view.ts`
- `src/application/read-models/cards-read-model.ts`
- `src/application/read-models/agent-operator-read-model.ts`
- `src/application/read-models/runtime-card-runs-read-model.ts`
- `src/application/read-models/debug-read-model.ts`
- `src/contracts/operator-api-runtime-cards.ts`
- `src/contracts/operator-api-agents.ts`
- `src/schemas/types.ts`
- `src/schemas/validators.ts`
- `src/contracts/operator-api.ts` and `src/contracts/index.ts` export surfaces if new schemas/types must be re-exported.
- Generated/openapi contract files if applicable.
- `web/src/api/contracts.ts` consumes `@saivage/contracts/operator-api` through web path aliases; do not treat it as the source of truth.
- `web/src/api/types.ts` only for local wrapper types that are not generated from contracts.
- `web/src/stores/card-detail-view-model.ts`
- `tests/server/operator-api-contract*.test.ts`

Steps:

1. Add a `toCardRefView(store, id)` helper.
2. Extend existing card detail responses first: ancestors, dependencies, related cards if surfaced by the existing `CardView`, and children where useful.
3. Keep original id arrays during transition only if needed by existing UI code; otherwise replace user-facing fields cleanly with ref arrays.
4. Update schema/contracts at the server source (`src/contracts/operator-api*.ts`, `src/contracts/operator-api.ts`, `src/contracts/index.ts`) and run the existing contract validation path so the web re-export from `@saivage/contracts/operator-api` stays aligned.
5. Add focused backend tests for existing, project, and missing refs.
6. Extend agent session summaries with card refs for currently exposed `card_id` and `goal_card_id` values, or document that the web must resolve those ids client-side.
7. Plan evidence-card and dispatch-summary refs only after those read models are actually present in the card detail API. Current `CardsReadModelService.getCard()` does not return evidence/review/planning/dispatch payloads directly, so that work is separate from the first `CardRefView` pass.

Acceptance criteria:

- User-facing detail data can render refs without looking up raw ids manually.
- Missing references do not crash read-model generation.
- Runtime/persistence schemas still store ids only.
- Operator API contract tests prove generated web contracts match the server response shapes.
- Contract tests assert `CardRefView` appears in `cards.get` and any agent/runtime responses that adopt it, and does not appear in runtime persistence schemas.

### Phase 3. Shared Web Card Reference Components

Files likely involved:

- `web/src/components/cards/CardDetailView.vue`
- `web/src/views/DashboardView.vue`
- `web/src/views/DebugView.vue`
- `web/src/views/AgentsView.vue`
- `web/src/components/chat/AnalystChatPanel.vue`
- `web/src/components/conversation/ContextBlock.vue`
- New `web/src/components/cards/CardRefLink.vue` or similar.
- New `web/src/stores/card-ref-resolver.ts` or similar.

Steps:

1. Add `CardRefMode` and tests for `current`, `historicalSnapshot`, and `debugRaw` before replacing labels in any history, transcript, debug, or audit surface.
2. Add a `CardRefLink` component that accepts `CardRefView` or `{ id }` plus an explicit `mode`.
3. Add a resolver that maps ids to current `display_path`, title, and missing state from the card store. The resolver must be reactive and must define fallbacks for empty/stale card indexes.
4. Replace raw-id relationship pills in `CardDetailView` with `CardRefLink`.
5. Replace raw ids in the Cards detail header bar with a friendly label where current card data is available.
6. Replace `AgentsView` session `Goal: &#123;&#123; session.goal_card_id &#125;&#125;` and `Card: &#123;&#123; session.card_id &#125;&#125;` labels with `CardRefLink` using server-projected refs or client resolution.
7. Replace Dashboard active-card/runtime card-id labels with `CardRefLink` in `current` mode where the surface is operator-facing, not debug-only.
8. Mark Debug card-id labels as `debugRaw` and optionally show current path as secondary text. Do not silently convert debug primary labels to paths.
9. Replace analyst chat child-list labels with friendly path plus title.
10. Update conversation link fallback so card links without server labels resolve client-side.
11. Ensure direct navigation to `/cards/:id` works before `fetchCards()` has populated the global card index: render an id or detail-card-derived label first, then upgrade after card index refresh.

Acceptance criteria:

- Normal card detail surfaces show friendly paths as primary labels.
- Raw ids remain available via title/tooltip/copy/debug detail.
- Navigation still uses route ids.
- Empty/stale card indexes render stable fallbacks rather than blank labels.
- Dashboard uses friendly current card labels; Debug explicitly uses `debugRaw` or shows raw ids as primary diagnostic labels.

### Phase 4. Tool Presenter Card Parts

Files likely involved:

- `web/src/utils/tool-presenters/types.ts`
- `web/src/utils/tool-presenters/registrations.ts`
- `web/src/components/content/InlineParts.vue`
- `web/src/components/conversation/ToolChip.vue`
- Tool presenter rendering components.
- `web/src/__tests__/tool-presenters/*.test.ts`

Steps:

1. Extend `InlinePart` with `kind: 'card'`.
2. Update `InlineParts.vue` to display `CardRefLink` for card parts.
3. Update `ToolChip.vue` interaction classification so card parts are navigable/interactive where appropriate and are not duplicated awkwardly between headline/detail areas.
4. Update card-related tool presenters to emit card parts instead of `textPart('card card-33')`.
5. Audit all card-bearing tool arguments and result records in `web/src/utils/tool-presenters/registrations.ts` and helper extractors before changing presenters. Known fields include `cardId`, `id`, `goalId`, `parentId`, `childId`, `targetCardId`, `parentCardId`, `newParent`, `parent`, `rootId`, evidence card ids, activation `parent_card_id`/`child_card_id`, runtime-run `card_id`, and nested `card.id` result records.
6. Prefer precise field-specific card parts over generic text formatting; do not convert unrelated `id` fields such as process ids, note ids, session ids, or tool-call ids.
7. Add tests for resolved and missing cards in both inline-part rendering and tool-chip interaction paths.
8. Add snapshot/fixture tests for each card-bearing presenter family: card tools, goal/runtime tools, note tools with `cardId`, history/diff tools, move/reorder tools, activation/runtime status results, and nested card result records.

Acceptance criteria:

- Tool chips for `activate_card`, `edit_card`, `get_card`, `get_card_output`, notes, history, diff, move/reorder, restart/cancel/delete show friendly labels when card data exists.
- Tool JSON bodies may still show raw ids because they are technical details.

### Phase 5. Markdown Card Reference Renderer

Files likely involved:

- `web/src/components/content/MarkdownText.vue`
- `web/src/components/cards/CardDetailView.vue`
- New markdown/tokenizer utility under `web/src/utils/`.
- Tests under `web/src/__tests__/`.

Steps:

1. Decide up front whether card descriptions and notes migrate to full Markdown through `MarkdownText` or keep plain-text rendering. If they stay plain text, implement a separate plain-text card-ref expander with the same safety semantics.
2. Define the allowed card-reference id grammar. Prefer matching the actual card-id creation policy; if arbitrary ids remain valid in schemas, require escaping/encoding for all rendered routes and parser delimiters.
3. Implement a Markdown-aware card-reference tokenizer/transform for `[[card:&lt;id&gt;]]`.
4. Ensure inline code and fenced code are not rewritten.
5. Render card refs through safe anchors or Vue components.
6. Use `encodeURIComponent(id)` for route construction and escape tooltip/title text.
7. Sanitize the final output and test the sanitizer contract.
8. Add tests for existing cards, missing cards, fallback labels, malicious fallback labels, malicious/unusual ids, inline code, fenced code, and normal Markdown links.

Acceptance criteria:

- `[[card:card-33]]` renders as the current display path when resolvable.
- Source remains id-based and durable.
- Plain `card-33` is unchanged.
- No XSS path is introduced through fallback labels or generated links.
- Unusual but schema-valid ids cannot break routes, parsing, or sanitized output.

### Phase 6. Agent Prompt Guidance

Files likely involved:

- `src/agents/prompts/system-prompt.ts`
- Tool descriptions in `src/tools/analyst-card-tools.ts` if needed.
- Current docs: `docs/agents.md`, `docs/operation.md`, `docs/analyst.md`.

Steps:

1. Add prompt guidance: use ids in tool calls, use `[[card:&lt;id&gt;]]` in operator-facing Markdown.
2. Explicitly tell agents not to persist friendly paths as durable references.
3. Mention that raw ids are acceptable in debug/protocol sections.
4. Update docs explaining card references and unstable display paths.

Acceptance criteria:

- New agent-authored Markdown can carry stable card references without exposing raw ids as user-facing prose.
- Tool protocol remains id-only.

### Phase 7. Historical And Audit Semantics

Files likely involved:

- `web/src/components/cards/CardHistoryPanel.vue`
- Conversation/timeline components.
- Debug/runtime panels.

Steps:

1. Use `CardRefMode` from the shared renderer instead of ad hoc labels.
2. Mark history/transcript card labels as current labels unless a historical snapshot exists.
3. Show raw ids in secondary text or tooltips for auditability.
4. Do not attempt to reconstruct old display paths unless display-path snapshots are intentionally added later.

Acceptance criteria:

- Historical views do not imply the path shown was the path at write time.
- Operators can still identify the stable raw id for audit/debug work.

## Test Matrix

- Backend display path: nested cards, moved cards, reordered cards, project card, missing parents fail-fast where appropriate.
- Backend list order: non-lexicographic ids, duplicate priorities, mixed depths, filtered views.
- CardRefView: existing, project, missing/deleted, stale card index.
- Corrupt topology: missing parent fails loudly or surfaces an operator-visible error; missing dependency/evidence refs degrade gracefully.
- Web detail first pass: dependencies, ancestors, children, related-card fields if surfaced, and header bar.
- Later evidence/dispatch pass: evidence cards and dispatch parent/target cards once those read models exist in the relevant API response.
- Dashboard/Agents/Debug: Dashboard friendly current labels, Agents friendly session card labels, Debug `debugRaw` labels with optional path secondary text.
- Web tree: visible order matches display path segments.
- Tool presenters: every card-related presenter emits/render card parts.
- Markdown: refs in paragraphs, lists, tables, fallback labels, inline code, fenced code, malicious labels, malicious/unusual ids, missing cards.
- Navigation: rendered card refs navigate to `/cards/&lt;id&gt;`.
- Audit: history/transcript views show current-path semantics and raw-id access.
- Direct route load: `/cards/:id` before global card index load still renders stable fallback labels and upgrades after refresh.

## Validation Commands

Run from `/home/salva/g/ml/saivage-v3` after implementation:

```bash
npm run validate:docs
npm run typecheck
npm test
npm run validate:ui-smoke
npm run validate:routine
```

For focused web work, also run the relevant Vitest files under `web/src/__tests__/` before broader validation. For contract changes, run the operator API contract tests directly before the broader suite.

## Risks And Mitigations

- Risk: API contract churn. Mitigation: introduce `CardRefView` only on targeted operator read models first.
- Risk: stale labels after reorder. Mitigation: resolve client-side where possible and refresh card index on card move/reorder invalidations.
- Risk: Markdown XSS. Mitigation: tokenization before rendering, escaped fallback labels, sanitization after rendering, no inline handlers.
- Risk: malformed ids break links or parsing. Mitigation: strict reference grammar plus `encodeURIComponent(id)` for routes and tests for unusual ids.
- Risk: historical confusion. Mitigation: label historical views as current-path rendering and keep raw ids visible.
- Risk: agents keep writing raw ids in prose. Mitigation: prompt guidance plus explicit Markdown card-reference docs.

## Recommended Sequence

1. Fix backend tree order first because it directly addresses wrong numbering and reduces confusion immediately.
2. Add `CardRefMode` and `CardRefView`/`CardRefLink` for existing detail relationship surfaces.
3. Add tool presenter card parts.
4. Add Markdown/plain-text card-reference rendering after deciding the description/note rendering mode.
5. Update agent prompts/docs to generate the new syntax.
6. Apply historical/audit labeling through `CardRefMode` as each affected surface adopts shared card refs.
