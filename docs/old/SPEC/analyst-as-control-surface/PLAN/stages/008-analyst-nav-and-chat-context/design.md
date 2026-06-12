# S08 — Analyst navigation and chat-panel context — design

## Goal

Wire the two analyst navigation tools (`navigate_workspace`,
`navigate_back`) — which S02 shipped as backend no-op stubs —
into actual SPA route changes in the always-visible
operator web UI, attach a per-turn workspace-context payload
(active view category, active entity id, active read-only
refinement) to every analyst chat turn so the model can
resolve deictic phrases without the user restating ids, and
flip the `AnalystChatPanel` context-list region to consume
  `cardStore.childrenOf(activeCardId)` (the
position-ordered getter shipped in S06) so that the chat's
"on-screen children" panel renders in the same order the
operator sees in the workspace area.

The substantive observable outcomes are the four SPEC-r7
"Analyst-driven navigation" acceptance bullets, the five
SPEC-r7 "Contextual awareness" acceptance bullets, and the
SPEC-r7 "Persistent panel layout and contextual awareness"
ordered-child-rendering guarantee for the chat panel itself.

## Scope

### In scope

- Rewrite `navigate_workspace` and `navigate_back` backend
  handlers in `saivage-v3/src/agents/analyst-tools.ts` to
  flow through `runAuditedAnalystTool` with
  `safety_class: 'low'` and return a structured navigation
  intent that the web layer can interpret without parsing
  free-form text.
- Add a `workspaceContext` field (optional, additive) to
  the `POST /api/chats/:sessionId` request body shape and
  to the analyst handler's `handleMessage` contract, with a
  zod schema in
  `saivage-v3/src/server/routes/chats-files-debug.ts`.
- Make the analyst handler in
  `saivage-v3/src/agents/analyst-handler.ts` (or wherever
  `handleMessage` is owned) prepend a single
  server-authored system-style context note to the
  per-turn model input that describes the operator's
  current view category, active entity id, and active
  refinement — visible to the model, invisible in the
  transcript surface used by the user.
- Introduce one new Pinia store
  `saivage-v3/web/src/stores/workspaceRoute.ts` that
  reflects the SPA route as a single source of truth
  (view + entityId + refinement + a bounded back-stack),
  subscribes to `router.afterEach` for user-driven nav,
  and exposes a `apply(intent)` mutator that the analyst
  chat store calls when it observes a navigation
  tool-invocation in a chat response.
- Update the chat composer in
  `saivage-v3/web/src/stores/analystChat.ts` so every
  `sendMessage` call reads from the workspace-route store
  and attaches the per-turn `workspaceContext` payload.
- Update `saivage-v3/web/src/stores/analystChat.ts` to
  post-process `response.toolInvocations` and, for any
  invocation matching `tool === 'navigate_workspace'` or
  `tool === 'navigate_back'`, call
  `workspaceRoute.apply(result.data)` — passing the full
  flat payload object (`{ intent: 'navigate_workspace', target }`
  or `{ intent: 'navigate_back' }`) — which in turn
  drives the appropriate `router.push(…)` (forward
  navigation for `navigate_workspace`, store-popped
  snapshot for `navigate_back`).
- Update
  `saivage-v3/web/src/components/chat/AnalystChatPanel.vue`
  to render an "On screen" context block. When the active
  entity is a card, the block lists the active card's
  children using `useCardStore().childrenOf(activeCardId)`
  (the S06 getter) — i.e. in the parent's recorded
  `position` order, not a client-side re-sort.
- Add vitest coverage in `web/src/__tests__/` and jest
  coverage in `tests/` that pins (a) the new request-body
  shape, (b) the audited-runner authorization path for
  both nav tools, (c) the chat-store route-intent
  dispatch, (d) the workspace-route store SSoT behavior,
  (e) the AnalystChatPanel ordered-children render against
  a shuffled-position fixture.
- Conditionally close the single OPEN ledger entry
  `analyst-e2e:scenario-analyst-chat-context-child-order:step-1`
  (Recorded by S03 / 2026-05-25, Target fix stage S08) in
  Phase H per PROTOCOL-r4 conditional-close-out rules.

### Out of scope

- Adding any new analyst tool name beyond the two
  navigation tools that already exist in the registry
  (`navigate_workspace`, `navigate_back`). Other analyst
  tools (mutation, queueing, reconfigure) are not touched.
- Changing the SPEC-r7 layout invariants (always-visible
  right-side analyst panel, always-visible left workspace
  area, no togglable analyst drawer); those are owned by
  S05 and S06 and were verified at their close-out.
- Removing any further UI mutation surface; S06 owns UI
  mutation removal and S07 owns backend route pruning.
- Telegram-surface parity for the new per-turn context
  payload; the chat send path on Telegram does not
  carry workspace context because there is no operator
  workspace area on that surface.
- Per-turn context for chat sessions whose `sessionId`
  is `card-<id>` (the existing seeded card-discussion
  flow in `seedCardContext`). That synthetic-hint path
  remains as a pre-fill convenience layered ABOVE the
  per-turn context payload; both can coexist and the
  per-turn payload is the substantive context source.
- A user-facing "history of recent views" UI affordance;
  the back-stack is internal state of the workspace-route
  store, exposed only via the `navigate_back` tool's
  effect.

## Dependencies

- **S00** — Breakage-detection harness. S08 depends on the
  four S00 gates (`run-gates.sh`, `baseline-gates.json`),
  the cumulative ledger, `forbidden-anchors.txt`, and
  `VALIDATION-COOKBOOK.md` for its Phase H close-out.
  Cross-reference of done-definition items V.1 through
  V.11 of [S00 plan.md](../../stages/000-breakage-detection-harness/plan.md)
  is given under "Done-definition cross-reference" below.
- **S02** — Tool surface alignment. S02 shipped both
  `navigate_workspace` (schema:
  `saivage-v3/src/agents/analyst-tool-schemas.ts` line 47)
  and `navigate_back` (schema: same file line 48) as
  no-op handlers in
  `saivage-v3/src/agents/analyst-tools.ts` lines 134 and
  136. S08 wires both handlers without changing either
  schema; the input/output shapes remain backward-
  schema-compatible at the model-facing layer.
- **S03** — Ordered children and bounded move. S03 made
  `position` the authoritative child-ordering field and
  the backend `/api/cards` responses honor that order.
  S03 also recorded the single OPEN ledger entry
  `analyst-e2e:scenario-analyst-chat-context-child-order:step-1`
  whose target fix stage is S08. S08 consumes the
  ordered-position contract via `cardsStore.childrenOf`
  (the getter S06 added) and closes the ledger entry
  in Phase H.4.
- **S04** — Notifications queue (ephemeral). No-op
  dependency for S08; notifications do not appear in the
  per-turn workspace context. Listed for completeness so
  the dependency graph in MASTER-PLAN-r7 remains
  satisfied.
- **S05** — Right panel and shell. S05 made the analyst
  panel persistent and always-visible; S08 adds new
  content (the "On screen" block) inside that panel and
  relies on the persistent layout invariant.
- **S06** — UI mutation removal and ordered rendering.
  S06 added `cardsStore.childrenOf(parentId): CardRecord[]`
  (in `saivage-v3/web/src/stores/cards.ts` line 239,
  exported line 487) which returns children in `position`
  order. S08 calls this getter directly from
  `AnalystChatPanel.vue` to render the on-screen children
  list; without the S06 getter the chat panel would have
  to re-sort, which is exactly the failure mode the
  cumulative ledger entry names.
- **S07** — Operator API pruning. No-op dependency for
  S08 beyond the fact that S07 left
  `POST /api/chats/:sessionId` as one of only two
  remaining non-bootstrap mutating routes. S08 extends
  that route's request-body schema (additive); no other
  routes are added or removed.

S08 does NOT depend on a hypothetical S09 or S10; both are
strictly later stages and the master-plan DAG (see
[MASTER-PLAN-r7 §S08](../../00-MASTER-PLAN-r7.md))
confirms only the six earlier-stage dependencies above.

## Approach

### Architecture summary

The SPA's vue-router instance (created in
`saivage-v3/web/src/main.ts` and already exposed for
testing as `(window as any).__vueRouter`) is the
underlying transport for view changes. S08 layers a
single Pinia store on top of it, named
`workspaceRoute`, that:

1. Reflects the current route's view category, active
   entity id, and any active read-only refinement (for
   example, the debug-view filter).
2. Maintains a bounded LIFO back-stack (default depth 16)
   of prior `{ view, entityId, refinement }` snapshots.
3. Exposes a single `apply(intent)` mutator that the
   chat store calls when it observes a navigation
   tool-invocation. `apply` resolves the intent to a
   router action: `router.push({ name, params, query })`
   for `navigate_workspace`; for `navigate_back` the store
   pops the most recent snapshot off its bounded LIFO
   back-stack and calls `router.push(poppedSnapshot)`.
4. Subscribes to `router.afterEach` so that user-driven
   navigation (clicking links, typing URLs) also flows
   into the same back-stack and the same `current`
   accessors. The store is the SSoT for both user-driven
   and analyst-driven navigation; neither side reads
   `window.location` directly and neither side calls
   `router.push` outside of `apply`.

This SSoT discipline is what MASTER-PLAN-r7 §S08 means by
"a single source of truth for the SPA route state shared
between the analyst tool and direct user-driven
navigation".

### Backend handler shape

Both nav tools become audited:

```ts
// src/agents/analyst-tools.ts (post-S08)
export async function navigate_workspace(
  ctx: ToolContext,
  params: { target: NavigateTarget }
): Promise<ToolResult> {
  return runAuditedAnalystTool(ctx, params, {
    action: 'workspace.navigate',
    safety_class: 'low',
    target_kind: 'session',
    getTargetId: (p) => `${p.target.kind}:${p.target.id ?? '-'}`,
    run: async () => ({
      success: true,
      data: {
        intent: 'navigate_workspace',
        target: params.target,
      },
    }),
  });
}

export async function navigate_back(
  ctx: ToolContext,
  _params: Record<string, never> = {}
): Promise<ToolResult> {
  return runAuditedAnalystTool(ctx, {}, {
    action: 'workspace.navigate_back',
    safety_class: 'low',
    target_kind: 'session',
    getTargetId: () => 'workspace',
    run: async () => ({
      success: true,
      data: { intent: 'navigate_back' },
    }),
  });
}
```

Wrapping both in `runAuditedAnalystTool` gives S08 the
same authorization, audit-trail, and observability
treatment as every other analyst write tool — even though
the tools do not mutate any persisted state, they DO
mutate observable UI state on the operator's behalf, and
SPEC-r7 §"Analyst-driven navigation" treats them as
analyst-driven actions. `safety_class: 'low'` matches the
risk profile (no destructive effect, no persistent data
change, reversible by `navigate_back` or by any other
navigation). `target_kind: 'session'` is the closest
existing target kind in the audit schema and avoids
introducing a new target_kind value in S08.

The backend handler does NOT call `router.push` (there is
no router on the backend); it returns the structured
intent as a flat object in `result.data` with shape
`{ intent: 'navigate_workspace', target }` or
`{ intent: 'navigate_back' }`. The web layer carries the
actual routing effect.

### Web tool-invocation dispatch

The existing analyst-chat response shape already includes
`response.toolInvocations: Array<{ tool: string; result: unknown }>`
(used at `web/src/stores/analystChat.ts` line 364). S08
adds a post-processing pass after that block: for each
invocation whose `tool` is `'navigate_workspace'` or
`'navigate_back'` and whose `result.success === true`,
the chat store calls
`workspaceRoute.apply(result.data)` — the full flat
payload object (`{ intent: 'navigate_workspace', target }`
or `{ intent: 'navigate_back' }`) is passed directly to
the route store; the chat store never extracts the
discriminator string from the payload in isolation,
because doing so would drop `target.kind`,
`target.id`, and `refinement`. Failures (rejected
authorization, malformed target) leave the route
unchanged and surface as ordinary tool-error messages in
the transcript; the route store is never called with a
failed intent.

The chat store does NOT itself reach into vue-router; all
router interaction is encapsulated in the workspace-route
store. This keeps the chat store ignorant of routing
specifics and makes the dispatch trivially unit-testable
by stubbing `workspaceRoute.apply`.

### Per-turn workspace-context payload

The chat composer reads the current `workspaceRoute`
snapshot and attaches it to the POST body:

```ts
// web/src/api/client.ts (post-S08)
export function sendChatMessage(
  sessionId: string,
  content: string,
  workspaceContext?: WorkspaceContext
): Promise<ChatResponse> { /* ... */ }

// shared shape
export interface WorkspaceContext {
  view: 'cards' | 'agents' | 'files' | 'debug' | 'dashboard' | null;
  entityId: string | null;
  refinement: Record<string, string> | null;
}
```

The backend route handler in
`src/server/routes/chats-files-debug.ts` extends its body
schema to accept the optional `workspaceContext` object,
validates it with a small zod schema, and passes it to
`handler.handleMessage(sessionId, content, workspaceContext)`.
The analyst handler prepends a single deterministic
system-style note to the model input (NOT to the
transcript shown to the user) of the form:

```
[workspace-context]
view: cards
entity: code-3
refinement: status=running
```

When `view`, `entity`, or `refinement` is null/absent the
corresponding line is omitted; when ALL three are
null/absent the note degenerates to a single line
`[workspace-context] none — no entity is currently in focus`,
which gives the model a deterministic anchor for the
SPEC-r7 "no specific entity in focus" branch (the model
asks one clarifying question rather than guessing).

The existing `seedCardContext` synthetic-hint pathway
(used when the user clicks "Discuss with analyst" on a
card) is unchanged — it remains a pre-fill convenience
for the composer's draft text. The per-turn workspace-
context payload is independent and applies to every
analyst session, not just `card-<id>` synthetic sessions.

### Chat-panel on-screen-children rendering

`AnalystChatPanel.vue` adds an "On screen" header section
above the transcript. When `workspaceRoute.view === 'cards'`
and `workspaceRoute.entityId` is non-null, the section
renders:

```vue
<ul class="on-screen-children">
  <li v-for="child in childrenOnScreen" :key="child.id">
    {{ child.id }} — {{ child.title }}
  </li>
</ul>
```

where `childrenOnScreen` is a computed:

```ts
const cards = useCardStore();
const workspaceRoute = useWorkspaceRouteStore();
const childrenOnScreen = computed(() =>
  workspaceRoute.view === 'cards' && workspaceRoute.entityId
    ? cards.childrenOf(workspaceRoute.entityId)
    : []
);
```

`cards.childrenOf` returns children in `position` order
because S06 implemented it that way. The template does
not call `.sort` and does not derive an alternate
ordering; whatever order `childrenOf` returns is the
order rendered. This is what closes the cumulative
ledger entry
`analyst-e2e:scenario-analyst-chat-context-child-order:step-1`.

### Back-stack semantics

The workspace-route store's back-stack is bounded to 16
entries (a constant in the store). Each user-driven
navigation event from `router.afterEach` pushes the
PREVIOUS `{ view, entityId, refinement }` snapshot onto
the stack and replaces `current` with the new one. Each
analyst-driven navigation event via `apply` does the
same. A `navigate_back` intent pops the most recent
snapshot from the stack and calls `router.push` with the
popped value, which keeps the Pinia store authoritative
over the route even when the underlying browser history
is stale due to in-app navigation patterns. If the stack
is empty, `apply({ intent: 'navigate_back' })` is a pure
web-side no-op: no `router.push` call, no exception, no
side effect, and no transcript injection. The backend
tool result for `navigate_back` is unconditionally
`{ success: true, data: { intent: 'navigate_back' } }`
regardless of the web-side stack state, because the
empty-stack branch is decided inside the route store and
the model has no channel to observe it. This is an
acceptable invisible failure mode: the user can see
that the URL did not change and can clarify in a
follow-up turn. The empty-stack vitest in Phase F
asserts exactly this — that `router.push` is not called
and that `apply` does not throw — and nothing more.

### Deictic-resolution flow

The analyst system prompt is owned by
`saivage-v3/src/agents/analyst-llm-resolver.ts`, where the
string constant `ANALYST_SYSTEM_PROMPT` is built and
exposed via the exported function `getAnalystSystemPrompt()`.
S08 extends THAT prompt — by editing the prompt source in
`analyst-llm-resolver.ts`, not the handler — with a short
additive paragraph instructing the model to resolve
deictic phrases ("this card", "here", "the current",
"this file", etc.) against the `[workspace-context]`
header attached to each user turn, and to ask exactly one
clarifying question when the header reports
`none — no entity is currently in focus`. The per-turn
`[workspace-context]` note itself is prepended to the
model input by the handler that owns `handleMessage`
(`src/agents/analyst-handler.ts`); the system-prompt
extension and the per-turn note are two complementary
changes in two different files. This matches SPEC-r7
§"Contextual awareness" verbatim semantics.

## Surfaces touched

- **Analyst tools (backend):**
  - `saivage-v3/src/agents/analyst-tools.ts` — rewrite
    `navigate_workspace` and `navigate_back` handlers to
    flow through `runAuditedAnalystTool` with
    `safety_class: 'low'` and return structured intents.
  - `saivage-v3/src/agents/analyst-tool-schemas.ts` — no
    change to schemas (the model-facing contract is
    unchanged).
  - `saivage-v3/src/agents/role-tool-policy.ts` — no
    change (both tools remain analyst-role only).
  - `saivage-v3/src/tools/agent-tools.ts` — no change
    (registry entries unchanged, no new tool names).
- **Analyst handler (backend):**
  - `saivage-v3/src/agents/analyst-handler.ts` — the
    file that owns `handleMessage`. Accept an optional
    `workspaceContext` parameter and prepend a
    deterministic `[workspace-context]` note to the
    per-turn model input.
  - `saivage-v3/src/agents/analyst-llm-resolver.ts` — the
    file that owns `ANALYST_SYSTEM_PROMPT` and exports
    `getAnalystSystemPrompt()`. Extend the prompt body
    with the deictic-resolution paragraph described in
    "Deictic-resolution flow" above.
- **HTTP route (backend):**
  - `saivage-v3/src/server/routes/chats-files-debug.ts` —
    extend the `POST /api/chats/:sessionId` body schema
    to include an optional `workspaceContext` object with
    a zod validator; forward to `handler.handleMessage`.
- **API client (web):**
  - `saivage-v3/web/src/api/client.ts` — extend
    `sendChatMessage` signature with an optional
    `workspaceContext` parameter; serialize it into the
    POST body.
  - `saivage-v3/web/src/api/types.ts` (if shared types
    live there) — export `WorkspaceContext` interface.
- **Pinia stores (web):**
  - **NEW** `saivage-v3/web/src/stores/workspaceRoute.ts`
    — single source of truth for SPA route state, with
    bounded back-stack and `apply(intent)` mutator.
  - `saivage-v3/web/src/stores/analystChat.ts` — read
    workspace-route state in `sendMessage` to build the
    `workspaceContext` payload; post-process
    `response.toolInvocations` to dispatch
    navigation intents to the workspace-route store.
- **Router (web):**
  - `saivage-v3/web/src/main.ts` — register the
    `workspaceRoute` store's `router.afterEach` listener
    during app bootstrap, after the router is created.
- **Vue components (web):**
  - `saivage-v3/web/src/components/chat/AnalystChatPanel.vue`
    — add the "On screen" header section that renders
    `cards.childrenOf(activeCardId)` when applicable.
  - No other component is touched. In particular,
    `CardDetailView.vue`, `CardsView.vue`, `DebugView.vue`,
    `DashboardView.vue`, `FilesView.vue`, and
    `AgentsView.vue` are unchanged — they continue to
    drive `router.push` via their own user-driven
    interactions, and the workspace-route store's
    `router.afterEach` listener picks those up
    transparently.
- **Tests:**
  - **NEW** `web/src/__tests__/stores/workspaceRoute.test.ts`
    — covers SSoT invariants, back-stack bounds, and
    `apply(intent)` dispatch for both nav intents.
  - **NEW** `web/src/__tests__/stores/analystChat.context.test.ts`
    — covers `sendMessage` attaching the `workspaceContext`
    payload from the route store and the tool-invocation
    dispatch loop.
  - **NEW** `web/src/__tests__/components/AnalystChatPanel.children.test.ts`
    — renders `AnalystChatPanel` with a shuffled-position
    cards fixture and asserts the on-screen-children list
    appears in `position` order (the substantive S03
    ledger-close evidence).
  - **NEW** `tests/agents/analyst-navigation.test.ts`
    — backend jest covering audited-runner
    authorization for both nav tools and the
    structured-intent shape returned as a flat object
    in `result.data`
    (`{ intent: 'navigate_workspace', target }` or
    `{ intent: 'navigate_back' }`).
  - **NEW** `tests/server/chats-route-workspace-context.test.ts`
    — backend jest covering the `POST /api/chats/:sessionId`
    body-schema extension, including the case where the
    workspaceContext field is omitted (backward-additive)
    and the case where every field is null (no-entity
    branch).
- **e2e checker (saivage-e2e-checkers):**
  - No new scenario file is authored in S08; the ledger
    entry
    `analyst-e2e:scenario-analyst-chat-context-child-order:step-1`
    is closed conditionally on the fact that after S08
    the chat panel consumes the ordered-children getter,
    so the failure mode the entry names cannot occur in
    the post-S08 source. Authoring a corresponding live
    e2e scenario is S10's responsibility per the master
    plan; S08 close-out does not gate on it.

## Test plan

### vitest (web, run with `cd web && npm test`)

- `stores/workspaceRoute.test.ts`:
  - `current` reflects the initial route on store
    instantiation.
  - User-driven navigation via `router.push` updates
    `current` (via `router.afterEach`) and pushes the
    previous snapshot onto the back-stack.
  - `apply({ intent: 'navigate_workspace', target: ... })`
    is exercised once per exposed `target.kind` value;
    the test asserts the resolved `router.push` argument
    for every kind in the schema:
    - `card` → `{ name: 'card-detail', params: { id } }`.
    - `transcript` → `{ name: 'agent-detail', params: { id } }`.
    - `process` → `{ name: 'process-detail', params: { id } }`.
    - `plan_diary` → `{ name: 'card-plan', params: { id } }`.
    - `process_list` → `{ name: 'debug' }`.
    - `agent_session_list` → `{ name: 'agents' }`.
    - `config` → `{ name: 'config' }`.
    No kind is omitted; the assertion table is exhaustive
    over the schema's seven enum values.
  - `apply({ intent: 'navigate_back' })` pops the back-
    stack and calls `router.push` with the popped value.
  - Back-stack is bounded to 16 entries (the 17th push
    drops the oldest).
  - `apply` with `intent: 'navigate_back'` on an empty
    stack is a no-op (no router call, no exception).
- `stores/analystChat.context.test.ts`:
  - `sendMessage` calls the API client with a third arg
    that mirrors the current `workspaceRoute` snapshot.
  - When `workspaceRoute.view` is null, `sendMessage`
    still sends a `workspaceContext` with `view: null,
    entityId: null, refinement: null` (deterministic
    shape, never undefined).
  - On a response containing
    `toolInvocations: [{ tool: 'navigate_workspace', result: { success: true, data: { intent: 'navigate_workspace', target } } }]`,
    the store calls `workspaceRoute.apply` exactly once
    with the full `invocation.result.data` object
    (the assertion uses object-equality against
    `{ intent: 'navigate_workspace', target }`, not
    against the string discriminator alone).
  - On a response containing a `navigate_back` invocation
    with `result.success: false`, the store does NOT call
    `workspaceRoute.apply` (failed intents are inert).
- `components/AnalystChatPanel.children.test.ts`:
  - The file's `<script setup>` imports the singular
    `useCardStore` symbol from `../../stores/cards`
    (the test asserts this import line is present in the
    SFC source AND that the imported symbol matches the
    real export named `useCardStore` in
    `web/src/stores/cards.ts`). This guard catches the
    "wrong store name" failure mode named in REVIEW.md
    Finding 2 mechanically.
  - Mount `AnalystChatPanel` with `workspaceRoute.view`
    set to `'cards'` and `entityId` set to a parent card
    whose children are written into the cards store in
    `position` order [2, 0, 1] (so the natural array
    order does NOT match the position order). Assert the
    rendered DOM lists the children in position order
    [0, 1, 2] — i.e. by the `position` field — not by
    insertion order.
  - With `workspaceRoute.view === 'dashboard'`, the on-
    screen-children list is empty regardless of cards-
    store content.

### jest (backend, run with `npm test`)

- `agents/analyst-navigation.test.ts`:
  - `navigate_workspace` invoked through
    `runAuditedAnalystTool` with `actor: 'analyst'`,
    `surface: 'agent-runtime'` returns
    `{ success: true, data: { intent: 'navigate_workspace', target } }`.
  - Same invocation with `actor: 'planner'` is denied
    (the role-tool-policy keeps both nav tools
    analyst-only).
  - `navigate_back` invoked the same way returns
    `{ success: true, data: { intent: 'navigate_back' } }`.
  - The audit log (via the same hooks every other
    audited tool uses) contains entries with
    `action: 'workspace.navigate'` and
    `action: 'workspace.navigate_back'` and
    `safety_class: 'low'`.
- `server/chats-route-workspace-context.test.ts`:
  - `POST /api/chats/:sessionId` with body
    `{ content: 'hi' }` (no workspaceContext) returns
    200 and `handler.handleMessage` is called with
    `(sessionId, 'hi', undefined)`.
  - Same route with body
    `{ content: 'hi', workspaceContext: { view: 'cards', entityId: 'code-3', refinement: null } }`
    returns 200 and `handler.handleMessage` is called
    with the third arg equal to the payload.
  - Same route with a malformed `workspaceContext`
    (for example, `view: 42`) returns 400 with a clear
    validation error.
- The analyst-handler-level test (a small inline test
  inside `tests/agents/`) covers the deictic-resolution
  system-prompt extension by snapshotting the rendered
  system prompt when a workspaceContext is provided and
  when it is not.

### Existing test suites (regression)

- `cd web && npm test` runs the full vitest suite,
  including the existing
  `tests/components/CardsTreeView.test.ts` ordered-render
  tests (added in S06) and the analyst-chat tests added
  in S05. None of these expectations are modified;
  S08 only ADDS coverage. (The documented working
  directory is already `saivage-v3/` per plan.md
  "Working directory", so nested-cd shorthand is never
  used.)
- `npm test` runs the full jest suite,
  including S03's child-ordering tests and S07's
  route-pruning tests. None of these expectations are
  modified.

### Live-runtime smoke (manual, not gated)

S08 does not introduce a new live-runtime smoke; the
existing S00 four-gate `run-gates.sh --diff` is the
acceptance for `analyst-e2e:` and `web-vitest:` ids.

## Expected breakage forecast

S08 anticipates the following NEW failing ids only if the
underlying issue cannot be fixed holistically in-stage
(MASTER-PLAN section 3 rule (3)). Any forecast target is
strictly later than S08 per MASTER-PLAN section 3 rule
(8) — S08 NEVER forecasts breakage targeting itself.

- **None expected.** S08 is a wiring stage: it activates
  two existing no-op tools and adds one optional request-
  body field. The substantive risk surfaces are
  (a) the cards-tree-view existing ordered-render tests
  (unaffected: S08 does not touch `CardsTreeView.vue`)
  and (b) any analyst-handler test that snapshot-matches
  the rendered system prompt (the snapshot must be
  re-recorded as part of S08's own scope under the
  holistic-fix-first rule).
- If the post-stage gate diff in Phase H.9 reports any
  NEW `analyst-e2e:` failing id whose root cause is
  outside S08's chat-panel + nav-tool scope, the
  forecast target is **S10** (the e2e-checker matrix
  expansion stage) per MASTER-PLAN.
- If the post-stage gate diff reports any NEW
  `web-vitest:` failing id whose root cause is in a
  component S08 did not touch, the forecast target is
  **S09** (UX polish + accessibility) per MASTER-PLAN.
- Any NEW `forbidden-anchor:` or `host-path:` failing id
  detected during S08 close-out is NOT a forecast: it is
  an in-stage HYGIENE failure on S08's own draft
  directory. Such a hit trips the H.1 (forbidden-anchor)
  or H.2 (host-path) gate, blocks publication, and must
  be fixed before close-out completes. It is never
  appended to the cumulative ledger and never assigned a
  forecast target stage. The holistic-fix-first
  restatement above applies in its strongest form here:
  the only acceptable resolution is to clean the draft.

## Done-definition cross-reference

S08 close-out maps each of the S00 V.1–V.11 acceptance
items as follows (see
[S00 plan.md V.1–V.11](../../stages/000-breakage-detection-harness/plan.md)):

- **V.1 baseline shape.** S08 does not modify
  `baseline-gates.json` in the default (no-regression)
  path; Phase H.10 is a conditional no-op. The baseline
  remains shape-correct (four entries, the schema S00
  pinned).
- **V.2 gates run end-to-end.** Phase H.9 runs
  `bash scripts/run-gates.sh --diff baseline-gates.json`
  and requires exit code 0. The gate runner exercises
  all four gates end-to-end.
- **V.3 driver supports `--diff`.** Phase H.9 invokes
  the driver with `--diff` and consumes its diff output;
  V.3 is exercised by construction.
- **V.4 cookbook sections.** Phase H's substeps follow
  the cookbook sections cited (autonomy anchor — §3,
  host-path — §4, emoji — §5, ledger close-out — §6,
  gate diff — §2, baseline refresh conditional — §7,
  forecast append — §8, atomic publication — §9). No
  cookbook section is bypassed.
- **V.5 ledger is shape-correct.** Phase H.4 either
  removes the one OPEN entry whose target is S08 (the
  default outcome under the holistic-fix-first rule
  applied to the on-screen-children render) and leaves
  the ledger structurally empty, or is a true no-op
  if the close-out condition fails. Either outcome
  leaves the ledger shape-correct.
- **V.6 preflight terminates with parseable verdict.**
  S08 does not invoke `preflight.sh` (it is a
  WRITER-side concern, not an implementer concern);
  V.6 is preserved transitively because S08 does not
  modify the preflight script or its inputs.
- **V.7 preflight is fail-closed.** Same as V.6 —
  unchanged by S08.
- **V.8 product code untouched.** S08 deliberately
  touches product code (this is an implementation
  stage), so V.8 in its S00 verbatim form is
  inapplicable; the corresponding S08 invariant is
  "product code touched is exactly the surface area
  enumerated under Surfaces touched", verified by
  Phase H.6's directed grep for `navigate_workspace`,
  `navigate_back`, and `workspaceContext` symbols in
  the file set listed under Surfaces touched.
- **V.9 no forbidden anchor in this stage's draft.**
  Phase H.1 runs the autonomy anchor grep in both
  forms (anchor-file form and inline literal form) over
  `drafts/008-analyst-nav-and-chat-context/`. Required
  outcome: zero hits each.
- **V.10 every link in this stage's docs resolves.**
  Phase A.5 runs `scripts/check-stage-links.sh` over
  the draft directory and requires exit code 0;
  Phase H.12's final guard re-runs include a link re-
  check.
- **V.11 zero NEW failures on the fresh diff.** Phase
  H.9's `run-gates.sh --diff` must report zero NEW
  failing ids on every gate. REPAIRED rows are
  permitted only if Phase H.10's conditional baseline
  refresh actually fires, which the paper-plan default
  forbids.

## Downstream impact

S08's changes ripple into specific later stages and
specific test surfaces. This section enumerates them
explicitly so close-out reviewers can confirm S08's
contract with downstream stages without re-deriving it.

### Later stages affected by S08

- **S09 (UX polish + accessibility).** S09 inherits the
  three NEW route entries S08 adds (`process-detail`,
  `card-plan`, `config`, all reusing existing components).
  S09 is responsible for any accessibility audit of the
  reused-component surfaces under their new route paths
  (focus management on entering `/cards/:id/plan`,
  keyboard navigation on `/debug/process/:id`, etc.).
  S09 is ALSO responsible for any dedicated `ConfigView`
  authoring should the placeholder reuse of `DebugView`
  prove insufficient at a UX level; the navigation
  contract S08 publishes (`{ name: 'config' }`) is the
  stable anchor.
- **S10 (e2e checker matrix expansion).** S10 inherits
  the live-runtime closure of the ordered-children
  ledger entry: S08's `AnalystChatPanel.children.test.ts`
  proves the post-S08 source cannot regress the position-
  order rendering, but S10 must author the corresponding
  live e2e scenario that exercises the analyst chat
  panel against a real running runtime to durably
  protect the SPEC-r7 \"Persistent panel layout and
  contextual awareness\" guarantee end-to-end. S10 also
  inherits any analyst-driven navigation scenarios
  (deictic resolution against multiple consecutive
  `[workspace-context]` headers, `navigate_back`
  semantics across a deep back-stack) that exercise the
  S08 plumbing in live mode.
- **No earlier stage is affected.** S00 through S07 are
  upstream of S08 in the master-plan DAG; S08 does not
  re-open any of their close-out conditions and does not
  retroactively modify their `Surfaces touched` sets.

### Test surfaces affected by S08

- **Vitest (web).** Three NEW test files
  (`stores/workspaceRoute.test.ts`,
  `stores/analystChat.context.test.ts`,
  `components/AnalystChatPanel.children.test.ts`) are
  added. The existing `tests/components/CardsTreeView.test.ts`
  ordered-render tests (S06) are NOT modified; the
  cards-tree-view component itself is not touched in S08.
- **Jest (backend).** Two NEW test files
  (`tests/agents/analyst-navigation.test.ts`,
  `tests/server/chats-route-workspace-context.test.ts`)
  and one ADDITIVE jest
  (`tests/agents/analyst-system-prompt.test.ts`, see
  Test plan above) lock in the audited-runner path, the
  body-schema extension, and the deictic-resolution
  paragraph respectively. No existing backend tests are
  rewritten.
- **S00 four-gate `run-gates.sh --diff`.** All four gates
  (`web-vitest:`, `analyst-e2e:`, `forbidden-anchor:`,
  `host-path:`) must show zero NEW failing ids after
  Phase H.9. The one OPEN cumulative-ledger entry
  (`analyst-e2e:scenario-analyst-chat-context-child-order:step-1`)
  is removed in Phase H.4 ("Breakage triage" — see
  plan.md H.11) on the paper-plan default path.
- **Forbidden-anchor and host-path gates.** Both gates
  scope to the S08 draft directory in Phase H.1 and
  H.2; the draft itself must hit zero anchor and zero
  host-path hits. The product-source edits S08 makes
  (under `saivage-v3/src/`, `saivage-v3/web/src/`,
  `saivage-v3/tests/`) are out-of-scope for these two
  gates by S00 design.

### Cross-reference to Expected breakage forecast

The "Expected breakage forecast" section above
enumerates the NEW failing ids S08 anticipates (paper-
plan default: none) and their target stages for the
forecast-append fallback. This Downstream impact section
is the complementary forward-looking view: it lists
which later stages and test surfaces S08 hands work to,
regardless of whether any breakage is forecast.

## Open issues

- **Open issue 1.** RESOLVED in this draft. The exact
  route-name mapping for each `NavigateTarget.kind` value
  is fixed below and is not deferred to any later stage.
  The schema kinds are `card, transcript, process,
  plan_diary, process_list, agent_session_list, config`
  (verbatim from `src/agents/analyst-tool-schemas.ts`).
  The current `web/src/main.ts` routes are `/`,
  `/dashboard`, `/cards`, `/cards/:id` (name `card-detail`),
  `/agents`, `/agents/:id` (name `agent-detail`), `/files`,
  and `/debug`. S08's resolver maps every exposed kind to
  exactly one route, adding the minimum new read-only
  routes inside Phase D.4:
  - `card` → existing `card-detail` route `/cards/:id`
    (component `CardsView.vue`).
  - `agent_session_list` → existing `agents` route
    `/agents` (component `AgentsView.vue`).
  - `transcript` → existing `agent-detail` route
    `/agents/:id` (component `AgentsView.vue`). The
    transcript surface for an agent session lives inside
    `AgentsView.vue`'s detail pane; the navigation tool
    passes the session id as the route param.
  - `process_list` → existing `debug` route `/debug`
    (component `DebugView.vue`, which already lists
    processes).
  - `process` → NEW route, name `process-detail`, path
    `/debug/process/:id`, component `DebugView.vue`
    (reused). `DebugView.vue` reads `route.params.id`
    and focuses the matching process row; no new
    component is authored in S08.
  - `plan_diary` → NEW route, name `card-plan`, path
    `/cards/:id/plan`, component `CardsView.vue`
    (reused). `CardsView.vue` reads `route.name === 'card-plan'`
    and scrolls to / opens the plan-diary block of the
    card detail; no new component is authored in S08.
  - `config` → NEW route, name `config`, path `/config`,
    component `DebugView.vue` (reused as a read-only
    placeholder surface for the runtime configuration
    that the analyst is permitted to inspect under
    SPEC-r7 §"Reconfigure" read-only semantics). No new
    component is authored in S08.
  Total new route entries added in S08: three
  (`process-detail`, `card-plan`, `config`), all reusing
  existing components; aggregate route-config addition
  is well under 50 lines.
- **Open issue 2.** RESOLVED in this draft. The
  deictic-resolution paragraph is added inside
  `getAnalystSystemPrompt()` in
  `saivage-v3/src/agents/analyst-llm-resolver.ts` — the
  prompt's real owner. Phase A.7 snapshots the function's
  output before the edit, Phase C.4 adds the paragraph
  inside the prompt body (Phase C.3 owns the orthogonal
  per-turn `[workspace-context]` note inside the handler
  message path), and Phase C.5 captures the after-state
  and asserts (a) the deictic paragraph is present in the
  new output and (b) the pre-existing prompt text is a
  substring of the new output (modulo the intentional
  insertion point), guaranteeing no prior content was
  clobbered.
- **Open issue 3.** The bounded back-stack depth (16)
  is a paper-plan default. If e2e scenarios in S10
  demand deeper navigation history, the depth can be
  tuned without changing the store's public API; the
  constant is documented in
  `workspaceRoute.ts` for future tuning.
