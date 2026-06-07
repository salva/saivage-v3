# Card Display Identity Analysis

Date: 2026-06-07

Scope: investigation only. This document records observed issues and possible designs. It does not implement changes.

## Problem Statement

Saivage v3 has two card identifiers with different purposes:

- Internal card ids, such as `card-33`, are stable and must remain the only identity used by runtime state, tools, persistence, APIs, routes, dependencies, activations, histories, process records, and agent protocols.
- Human-friendly display paths, such as `1.2.1`, are presentation labels derived from a card's current tree position. They are useful for operators, but are not stable because reordering or moving cards can change them.

The current implementation mixes those concerns in user-facing surfaces:

- The tree view can show display paths that do not correspond to the row's visible position in the tree.
- Many user-facing surfaces still render raw internal ids where a user-friendly path or card reference would be more appropriate.
- Markdown-bearing content has no card-reference escape that stores the stable id while rendering the current user-friendly path.

## Findings

### F1. Tree display paths can diverge from visible tree position

Severity: high for operator usability.

The backend computes `display_path` from each card's stored `position` field in `src/application/read-models/card-view.ts`. The algorithm walks ancestors and uses `position + 1` for each segment.

The web tree, however, renders cards in the order supplied by the list API. `CardsTreeView` builds `childrenMap` from `props.cards` and never sorts each sibling group by `position`. The store passes `orderedFilteredCards`, and `selectOrderedFilteredCards` intentionally returns filtered cards without sorting.

This issue is specific to list/tree surfaces fed by `cards.list`. Backend child access through `store.listChildren(parentId)` is already position-sorted because `CardStoreState.childrenOf()` returns `_childrenByParent` edges that are sorted by `(position, id)`. For example, `CardsReadModelService.getCard()` uses `listChildren()` for detail children and is not the same path as the tree's flat list input.

The persistence loader validates sibling positions but returns `cardsInDepthOrder` sorted only by depth. It does not sort siblings by `(parent, position)` within a depth, so `store.list()` can preserve filesystem/read/insertion order for cards at the same depth. For ids such as `card-10`, lexicographic or filesystem ordering can place later-position children before earlier-position children.

Concrete GetRich v2 evidence, captured on 2026-06-07 from host path `/home/salva/g/ml/getrich-v2/.saivage/cards/by-id`. The live `saivage-v3-getrich-v2` service was active and `/work/getrich-v2` contained the same 24-card bind-mounted state when checked:

```text
PARENT card-1
1. id=card-10 pos=5 display=1.6 title=G1.6 Build evaluation, comparison, and result-recording infrastructure
2. id=card-21 pos=6 display=1.7 title=G1.7 Validate framework with sanity-check baselines end-to-end
3. id=card-4  pos=0 display=1.1 title=G1.1 Define common experiment and validation standard
4. id=card-5  pos=1 display=1.2 title=G1.2 Build trusted historical market-data substrate
5. id=card-6  pos=2 display=1.3 title=G1.4 Build modular component interfaces and registry
6. id=card-8  pos=3 display=1.4 title=G1.3 Define data validation, provenance, and snapshotting rules
7. id=card-9  pos=4 display=1.5 title=G1.5 Build long-only backtesting and portfolio simulation engine
```

This means the user sees `1.6` and `1.7` as the first two children under `1`, then `1.1`. The number no longer represents the visible tree position.

Likely root cause:

- `computeCardDisplayPath()` assumes `position` is authoritative.
- `CardStoreState.childrenOf()` sorts child edges by `position`, but `listCards()` does not expose that tree order.
- `CardsTreeView` uses the flat list order when constructing `childrenMap`, not the card's `children` field or a per-parent position sort.
- Current tests assert that the tree and detail children preserve backend order, but do not assert that backend order is position order or that visible row order matches `display_path`.

### F2. Display paths are currently persisted only as outbound presentation, which is correct, but the contract is incomplete

Severity: medium.

`display_path` appears in API/web test fixtures and is returned as a derived `CardView` property. That is the right direction because the path is unstable and should not be persisted as card identity.

The missing contract is that every user-facing card reference needs enough information to render a friendly label while retaining the stable id:

- `id`: stable target for navigation and commands.
- `display_path`: current human label for rendering.

Some API responses provide only ids for relationships, so the web cannot render a friendly label without joining against the card index. This does not necessarily mean every API response should embed duplicate `display_path` labels; the design must choose where refs are projected server-side and where ids are resolved client-side from the current card index.

Examples:

- Detail `ancestorIds` are returned as raw ids from `CardsReadModelService.getCard()`.
- `depends_on`, `related`, review evidence card ids, runtime activation ids, and dispatch summaries often remain raw ids.
- Runtime state must keep ids, but user-facing read models should project resolvable card references.

### F3. User-facing detail views still render raw internal ids in relationship labels

Severity: medium.

The primary card detail title already renders `display_path` plus title when `display_path` is present. The remaining issue is that secondary metadata and relationship pills still expose raw ids as their only labels.

Examples in `web/src/components/cards/CardDetailView.vue`:

- The secondary metadata row renders `ID: &#123;&#123; currentCard.id &#125;&#125;` and only optionally appends `Path: &#123;&#123; currentCard.display_path &#125;&#125;`.
- Dependency pills render `&#123;&#123; depId &#125;&#125;`.
- Ancestor pills render `&#123;&#123; ancestorId &#125;&#125;`.
- Review evidence card pills render `&#123;&#123; evidenceId &#125;&#125;`.
- Dispatch summary buttons render `&#123;&#123; dispatch.targetCardId &#125;&#125;` and `&#123;&#123; dispatch.parentCardId &#125;&#125;`.

Raw ids may still be useful in tooltips, copied debug details, or explicitly technical panes. They should not be the primary visible label in normal operator views.

### F4. Other web surfaces use raw card ids in labels and summaries

Severity: medium.

Examples:

- `web/src/views/CardsView.vue` shows the route param as `currentCardId` in the detail header bar.
- `web/src/components/chat/AnalystChatPanel.vue` renders `child.id — child.title` in the contextual children list.
- `web/src/components/conversation/ContextBlock.vue` uses `link.label ?? link.entity_id`, so links without labels expose raw ids.
- `web/src/utils/tool-presenters/registrations.ts` formats many card-related tools as `card ${id}`, including `activate_card`, `cancel_card`, `restart_card`, `delete_card`, `edit_card`, `move_card`, `get_card`, `get_card_output`, notes, history, and diff tools.

These surfaces need a shared card-reference presentation layer rather than ad hoc string formatting.

### F5. Agent/tool output correctly uses internal ids, but persisted text then leaks those ids to users

Severity: medium.

Planner, executor, reviewer, and analyst protocols should continue to call tools with stable ids. The issue is that their natural-language summaries, notes, markdown descriptions, diaries, and conversation transcripts can mention ids such as `card-23`. When those documents are rendered to users, the current UI has no way to distinguish an id that should remain technical from a card reference that should render as the current path.

The GetRich v2 state shows internal ids throughout runtime JSON, session names, activations, dependency arrays, and agent messages. Those are appropriate internally, but the same ids become unfriendly when surfaced as plain text.

### F6. Current Markdown rendering has no card-reference extension

Severity: medium.

There are two text-rendering paths:

- `MarkdownText.vue` renders GFM with `marked` and `DOMPurify`.
- `CardDetailView.vue` uses a local `renderMarkdown()` helper for descriptions and notes, but that helper is not real Markdown; it only escapes text and turns newlines into `<br>`.

Neither path resolves card references. A description or note containing `card-33` will render exactly as `card-33`, even when the card exists and has a better current path. A future implementation should explicitly decide whether descriptions and notes migrate to the shared Markdown renderer or remain plain text with only card-reference expansion.

## Design Constraints

- Internal identity must remain card id only.
- Display paths must be derived at read/render time and never treated as stable identifiers.
- A persisted document must not store only `1.2.1` because the same card can later move.
- Canonical routes and copied durable references must carry card ids. Friendly paths in URLs, if ever shown, should be decorative/query-only or resolved immediately to ids; they must not become accepted durable identity.
- User-facing views should prefer current path plus title where space allows, and path alone where compactness is required.
- Debug/diagnostic surfaces may expose ids, but should do so intentionally, often as a tooltip or secondary field.
- References to missing/deleted cards must degrade gracefully while preserving the original id.
- Historical and audit views need explicit semantics because rendering an old reference with today's path can distort what the operator saw when the note, history entry, or transcript was written.

## Recommended Direction

### R1. Make the API's card list order tree-position-aware

The simplest fix for F1 is to ensure every backend/user-facing list used for tree rendering is ordered by tree traversal, with siblings sorted by `position`. Then `display_path` and visible row position agree.

Concrete invariant for a user-facing tree/list read model:

- `CardStore.list()` can remain a general unordered collection if internal callers depend on that.
- Read-model/API methods that feed operator tree views should expose `cards` in preorder tree order: project first, then depth-first children sorted by `(position, id)` per parent.
- Alternatively, `CardsTreeView` can sort each `childrenMap` group by `position`, but this duplicates backend semantics in the frontend and does not fix other consumers of `listCards()`.

Preferred approach: centralize tree order in the backend read model and add tests proving that the visible tree order matches `display_path` segments.

### R2. Add a CardRef presentation model

Introduce a read-model shape for user-facing references:

```ts
interface CardRefView {
  id: string;
  display_path: string | null;
  title: string | null;
  missing?: boolean;
}
```

Use it in operator-facing read models where the response is naturally partial and cannot rely on the web already having a fresh full card index, such as card dependencies, ancestors, related cards, evidence cards, and dispatch summaries. Runtime state and tool inputs should continue to use raw ids. For broader debug/runtime views, prefer returning ids plus resolving labels client-side from the current card index unless the API needs to be self-contained.

Rendering rule:

- Primary text: `display_path` if present, otherwise `id`.
- Secondary text where space allows: title.
- Tooltip/copy affordance: raw id.
- Missing card: `missing card card-33` or `card-33 (missing)`.

Freshness rule:

- Server-projected refs are point-in-time presentation data for that response.
- Client-resolved refs should update when the card index is refreshed or when reorder/move invalidation events arrive.
- Neither form should be persisted as authoritative identity.

### R3. Add a Markdown card-reference escape

Use a lightweight card-reference syntax that persists the stable id and renders the current path dynamically.

Recommended syntax:

```md
[[card:card-33]]
[[card:card-33|optional fallback label]]
```

Rendering examples:

- Source: `Blocked by [[card:card-22]].`
- Rendered today: `Blocked by 1.6.1.` with tooltip `card-22 · Implement canonical evaluation/result schema and metric computation`.
- Rendered after reorder: `Blocked by 1.4.3.` using the same persisted source.
- Missing card: `card-22 (missing)` or the fallback label if provided.

Reasons to prefer this over storing display paths:

- The source keeps the stable id.
- The rendered label stays current.
- It is visually distinct from normal prose.
- It does not conflict with Markdown links.
- It can be resolved by a preprocessor before `marked`, or by a Markdown tokenizer extension.

Alternative syntax using ordinary Markdown links:

```md
[card](saivage-card:card-33)
[schema work](saivage-card:card-33)
```

This is more standard Markdown, but the source does not obviously expose the id in the visible token and the renderer must rewrite custom-scheme links. The bracket syntax is clearer for agents and operators editing raw markdown.

Important parsing and rendering rules:

- Do not rewrite references inside fenced code blocks or inline code. A regex preprocessor is only acceptable if it tokenizes Markdown enough to honor those regions; otherwise use a `marked` tokenizer/extension or an AST transform.
- Resolve only exact `[[card:&lt;id&gt;]]` patterns, not every `card-33` substring.
- Escape fallback labels before rendering, and test malicious fallback content.
- Sanitization must still run after rendering. If the output uses custom attributes, verify that `DOMPurify` preserves only the intended safe attributes.
- Prefer a safe link shape or Vue-rendered component over inline event handlers. For example, render a sanitized anchor such as `<a href="/cards/card-33" data-card-id="card-33">1.6.1</a>` and handle navigation by id. The rendered element should navigate by id, not by display path.

Historical rendering rule:

- Live operator surfaces should render the current path because the user's next action navigates in the current tree.
- Audit/history/transcript views should make the time basis explicit: current path plus raw id is safe by default; historical path should be shown only if the system intentionally captured a path snapshot at write time.

### R4. Teach agents to write card references in documents, not display paths

Tool calls and runtime state should remain id-based, but prompts can instruct agents:

- Use raw ids only in tool arguments and explicitly technical/debug sections.
- In Markdown intended for operator display, write card references as `[[card:&lt;id&gt;]]`.
- Never write `1.2.1` as a durable reference unless describing a historical UI observation.

This avoids relying on lossy post-processing of arbitrary `card-33` text.

### R5. Add a shared web-side card-reference resolver

Create a single resolver that can be used by pills, conversation links, Markdown rendering, and tool presentations:

```ts
resolveCardRef(id): { id, label, title, missing }
```

The resolver can use the current card store/index and should update labels after card fetches or reorder events.

Tool presenters need an explicit architecture change before they can use this. Today `InlinePart` supports `text`, `file`, `url`, and `code`, and presenter functions receive only tool args or result context. Two viable designs:

- Add `InlinePart { kind: 'card'; id: string; fallbackLabel?: string }` and resolve/render it later in the component layer.
- Inject a `resolveCardRef(id)` function into presenter execution so presenters can emit ordinary text with current labels.

The first option is preferable because it preserves stable ids through the presentation pipeline and lets the UI update labels as card data refreshes.

## Open Questions

- Should top-level goals render as `1`, `2`, `3`, or include a project prefix such as `G1`? Current `display_path` returns `null` for the project and `1` for first-level goals.
- Should user-facing labels include the title by default, for example `1.6.2 Add result recording...`, or only show the path with title in a tooltip?
- Should route paths remain `/cards/card-33` only, or should the UI support copyable deep links that look friendly while still carrying the id? Durable identity must remain the id either way.
- Should card descriptions/notes use full Markdown through `MarkdownText`, or stay plain text plus card-reference expansion?

## Suggested Verification For Future Implementation

- Unit test `computeCardDisplayPath` against reordered and moved cards.
- API/read-model test that `listCards()` or tree-specific endpoint returns preorder tree order by `position`.
- Web tree test that visible row order under a parent is `1.1`, `1.2`, `1.3`, not filesystem/id order.
- Card detail tests for dependencies, ancestors, review evidence, and dispatches showing `display_path` instead of raw ids.
- Tool presenter tests for card-related tool calls using `CardRefView` labels.
- Markdown rendering tests for `[[card:card-33]]`, fallback labels, missing cards, inline code, and fenced code.
