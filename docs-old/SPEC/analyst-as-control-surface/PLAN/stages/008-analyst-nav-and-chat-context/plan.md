# S08 — Analyst navigation and chat-panel context — plan

## Working directory

All commands below run from the workspace root
[saivage-v3/](../../../../) unless explicitly noted with
`cd web` (which means `saivage-v3/web/`) or with an absolute
path beginning `/home/`. Paths in this document are
workspace-relative to `saivage-v3/` unless they start with
`SPEC/` (in which case they are relative to `saivage-v3/`)
or with `/home/` (absolute).

## Phase A — Prep and inventory

A.1 Snapshot the current cumulative ledger
`SPEC/analyst-as-control-surface/PLAN/expected-breakage-ledger.md`
into `tmp/s08-ledger-before.md` so Phase H's close-out
comparisons have a fixed point of reference. Verify the
file is shape-correct (each entry has the required fields
per S00's ledger schema) before proceeding.

A.2 Snapshot the current baseline
`SPEC/analyst-as-control-surface/PLAN/baseline-gates.json`
into `tmp/s08-baseline-before.json` (byte-for-byte copy).
Phase H compares the post-edit snapshot to this one.

A.3 Snapshot the four S00 gates as-of S08 start. From
`saivage-v3/`, run
`bash SPEC/analyst-as-control-surface/PLAN/scripts/run-gates.sh --diff SPEC/analyst-as-control-surface/PLAN/baseline-gates.json`
and capture stdout+stderr into `tmp/s08-gates-before.txt`.
Confirm exit code 0; if non-zero, the stage cannot start.

A.4 Inventory current analyst nav tool wiring. Run
`grep -nE 'navigate_workspace|navigate_back' src/agents/analyst-tools.ts src/agents/analyst-tool-schemas.ts src/agents/role-tool-policy.ts src/tools/agent-tools.ts > tmp/s08-nav-tools-before.txt`
and confirm the file lists exactly the four registration
sites (two in `analyst-tools.ts`, two in
`analyst-tool-schemas.ts`, one in `role-tool-policy.ts`
per tool, one in `agent-tools.ts` per tool). Any deviation
from this set is a precondition failure: an earlier stage
moved a wiring site and S08's design must be re-read.

A.5 Run `bash SPEC/analyst-as-control-surface/PLAN/scripts/check-stage-links.sh SPEC/analyst-as-control-surface/PLAN/drafts/008-analyst-nav-and-chat-context/`
and capture to `tmp/s08-links-before.txt`. Required
outcome: exit code 0.

A.6 SFC corruption pre-check on
`AnalystChatPanel.vue`. Run
`for f in web/src/components/chat/AnalystChatPanel.vue; do count=$(grep -c '<script setup' "$f"); echo "$count $(basename $f)"; done`
and confirm exactly one `<script setup>` block. Any count
greater than 1 indicates a pre-existing VS Code SFC
duplication that must be fixed (per the workspace memory
note on Vue SFC corruption) before any edit in Phase E
touches the file.

A.7 Capture the current analyst system prompt for the
snapshot diff in Phase C.5. The prompt is owned by
`src/agents/analyst-llm-resolver.ts` (which builds the
`ANALYST_SYSTEM_PROMPT` constant and exports it via
`getAnalystSystemPrompt()`), NOT by
`src/agents/analyst-handler.ts`. From the workspace
root, run
`node -e "import('./dist/agents/analyst-llm-resolver.js').then(m => process.stdout.write(m.getAnalystSystemPrompt()))" > tmp/s08-system-prompt-before.txt`
(assuming a current `npm run build` artifact exists
under `dist/`; if not, build first with
`npm run build` and re-run the capture). Required
outcome: `tmp/s08-system-prompt-before.txt` is a
non-empty file containing the verbatim prompt body.
This snapshot is the substring-membership reference
that Phase C.5 diffs against.

A.8 Inventory existing chat-store toolInvocation handling.
Run
`grep -nE 'toolInvocations|invocation.tool|navigate_' web/src/stores/analystChat.ts > tmp/s08-chat-store-before.txt`
to anchor the post-processing insertion point. Required
outcome: at least one match for `toolInvocations` (the
existing flatMap at the line found earlier).

## Phase B — Backend nav-tool wiring

B.1 Edit `saivage-v3/src/agents/analyst-tools.ts`: replace
the body of `navigate_workspace` so the handler calls
`runAuditedAnalystTool` with `action: 'workspace.navigate'`,
`safety_class: 'low'`, `target_kind: 'session'`,
`getTargetId: (p) => ${'`${p.target.kind}:${p.target.id ?? "-"}`'}`,
and a `run` that returns
`{ success: true, data: { intent: 'navigate_workspace', target: params.target } }`.
The function signature is unchanged.

B.2 In the same file, replace the body of `navigate_back`
so the handler calls `runAuditedAnalystTool` with
`action: 'workspace.navigate_back'`,
`safety_class: 'low'`, `target_kind: 'session'`,
`getTargetId: () => 'workspace'`, and a `run` that returns
`{ success: true, data: { intent: 'navigate_back' } }`.
The function signature is unchanged.

B.3 Confirm no edits are required in
`src/agents/analyst-tool-schemas.ts` (the model-facing
schemas are unchanged in S08). Run
`git diff src/agents/analyst-tool-schemas.ts` after Phase B
and confirm zero output.

B.4 Confirm no edits are required in
`src/agents/role-tool-policy.ts` (both tools remain
analyst-role only). Run `git diff src/agents/role-tool-policy.ts`
after Phase B and confirm zero output.

B.5 Confirm no edits are required in
`src/tools/agent-tools.ts` (the registry entries already
point at the now-audited handlers; the wrapper is what
changed, not the registration shape). Run
`git diff src/tools/agent-tools.ts` after Phase B and
confirm zero output.

B.6 Run `npx tsc --noEmit` and capture
output to `tmp/s08-tsc-after-phase-B.txt`. Required
outcome: exit code 0. If non-zero, the most likely
diagnostic is a mismatched `ToolResult` shape — the new
audited path must return the same `ToolResult` type the
old no-op stubs returned.

## Phase C — Analyst handler workspace-context plumbing

C.1 Locate the analyst handler file owning
`handleMessage`. Run
`grep -rln "handleMessage" src/agents/ | head` and use
the first match (expected:
`src/agents/analyst-handler.ts`). Capture the file's
current `handleMessage` signature to
`tmp/s08-handle-message-sig-before.txt` for the diff in
C.5.

C.2 Extend `handleMessage`'s signature to accept an
optional third parameter
`workspaceContext?: WorkspaceContext` where
`WorkspaceContext` is the interface defined in the
companion design.md. Add the interface as an export in
the handler module (or in a small new shared module
`src/agents/workspace-context.ts` if the handler module
is already overcrowded; the implementer chooses).

C.3 In `handleMessage` (in `src/agents/analyst-handler.ts`),
before composing the per-turn model input, prepend a
single `[workspace-context]` system-style note built
from `workspaceContext`:

- If `workspaceContext` is undefined or every field is
  null, the note is exactly the single line
  `[workspace-context] none — no entity is currently in focus`.
- Otherwise, the note is multiple lines: `[workspace-context]`
  on the first line, then `view: <value>` if non-null,
  `entity: <value>` if non-null, and
  `refinement: <key=value>;<key=value>` if the refinement
  object is non-empty.

The note is prepended to the model input, NOT to the
transcript saved for the user.

C.4 Extend the analyst system prompt in
`src/agents/analyst-llm-resolver.ts`. Edit the
`ANALYST_SYSTEM_PROMPT` string body that
`getAnalystSystemPrompt()` returns and add a single
additive paragraph instructing the model to resolve
deictic phrases ("this", "here", "this card", "the
current", "the one I'm looking at", and equivalents)
against the `[workspace-context]` header, and to ask
exactly one clarifying question when the header reports
`none — no entity is currently in focus`. The paragraph
must NOT mention any specific tool name beyond what the
existing prompt already mentions; it describes
behavior, not capabilities. The edit MUST be additive
— do not delete or reorder any pre-existing prompt
lines.

C.5 Mechanical after-state check on the system prompt.
Rebuild (`npm run build`) so the resolver edits land in
`dist/`, then capture the after-state with
`node -e "import('./dist/agents/analyst-llm-resolver.js').then(m => process.stdout.write(m.getAnalystSystemPrompt()))" > tmp/s08-system-prompt-after.txt`.
Assert two conditions hold:

- (a) The deictic paragraph is present in the after
  snapshot. Verify with
  `grep -F 'deictic' tmp/s08-system-prompt-after.txt`
  (or whatever distinctive token Phase C.4 chose for the
  added paragraph — record the chosen token in
  `tmp/s08-deictic-token.txt` at the end of C.4 so this
  check is reproducible).
- (b) The pre-existing prompt was not clobbered. The
  before snapshot must be a contiguous substring of the
  after snapshot, modulo the intentional insertion
  point. Verify with the small node snippet
  `node -e "const fs=require('fs'); const b=fs.readFileSync('tmp/s08-system-prompt-before.txt','utf8'); const a=fs.readFileSync('tmp/s08-system-prompt-after.txt','utf8'); const ok = a.includes(b) || b.split('\n').every(line => !line || a.includes(line)); process.exit(ok ? 0 : 1)"`
  which exits 0 if the before content is preserved
  either as a single substring or, if the paragraph
  insertion split a single line, as line-wise substring
  membership across every non-empty pre-existing line.

Both conditions must hold; failure means C.4 clobbered
pre-existing prompt content and must be redone.

C.6 Run `npx tsc --noEmit` and capture
to `tmp/s08-tsc-after-phase-C.txt`. Required outcome:
exit code 0.

## Phase D — Web SSoT route store + dispatch

D.1 Create new file
`saivage-v3/web/src/stores/workspaceRoute.ts` exporting
`useWorkspaceRouteStore` (Pinia store) with reactive
state `view`, `entityId`, `refinement`, a private bounded
back-stack of depth 16, and a `current` getter returning
the snapshot `{ view, entityId, refinement }`.

D.2 In the same file, implement
`registerRouterListener(router: Router)` that subscribes
to `router.afterEach((to, from) => { … })`. Each
afterEach pushes the PREVIOUS snapshot onto the back-stack
(evicting the oldest entry past depth 16) and updates
`current` from the new route. The mapping from
`Route` → `{ view, entityId, refinement }` is centralized
in a private resolver function inside the store file.

D.3 In the same file, implement `apply(intent)` that
accepts either
`{ intent: 'navigate_workspace', target: NavigateTarget }`
or `{ intent: 'navigate_back' }`. For
`navigate_workspace`, the function resolves
`target.kind` (card, transcript, process, plan_diary,
process_list, agent_session_list, config) to a route
name + params + query and calls `router.push(...)`. For
`navigate_back`, the function pops the back-stack and
calls `router.push` with the popped snapshot; on an
empty stack the call is a pure no-op (no `router.push`,
no exception, no side effect, no transcript injection).

D.4 Add the route entries required by S08's resolver to
`web/src/main.ts`. The current routes (per pre-edit
`web/src/main.ts`) are `/`, `/dashboard`, `/cards`,
`/cards/:id` (name `card-detail`), `/agents`,
`/agents/:id` (name `agent-detail`), `/files`, `/debug`.
S08 adds exactly three NEW route entries, each reusing
an existing component, to make the resolver in D.3
exhaustive over the schema's seven `NavigateTarget.kind`
values:

- name `process-detail`, path `/debug/process/:id`,
  component `DebugView.vue` (reused). DebugView reads
  `route.params.id` and focuses the matching process
  row; no new SFC is authored.
- name `card-plan`, path `/cards/:id/plan`, component
  `CardsView.vue` (reused). CardsView reads
  `route.name === 'card-plan'` and opens/scrolls to the
  plan-diary block of the card detail; no new SFC is
  authored.
- name `config`, path `/config`, component
  `DebugView.vue` (reused as a read-only placeholder for
  the runtime configuration surface; the analyst's
  read-only Reconfigure semantics under SPEC-r7 do not
  require a dedicated SFC); no new SFC is authored.

The complete schema-to-route mapping after D.4 is:

- `card` → `card-detail` `/cards/:id` (existing).
- `transcript` → `agent-detail` `/agents/:id`
  (existing).
- `process` → `process-detail` `/debug/process/:id`
  (NEW).
- `plan_diary` → `card-plan` `/cards/:id/plan` (NEW).
- `process_list` → `debug` `/debug` (existing).
- `agent_session_list` → `agents` `/agents`
  (existing).
- `config` → `config` `/config` (NEW).

The addition is three new `routes` array entries plus
any resolver glue inside `workspaceRoute.ts`'s
`apply()` function. This substep is unconditional and
is not deferred; no kind is left without a route
mapping in S08.

D.5 In `web/src/main.ts`, after the existing
`createRouter` call and before `app.mount`, call
`useWorkspaceRouteStore().registerRouterListener(router)`
so the SSoT is bootstrapped on app start.

D.6 Update `web/src/api/client.ts`: extend
`sendChatMessage` signature with an optional third
parameter `workspaceContext?: WorkspaceContext`. When
provided, include `workspaceContext` in the JSON body
sent to `POST /api/chats/:sessionId`; when omitted,
the body is byte-identical to its pre-S08 shape
(backward-additive, but per the architecture-first
no-backward-compat workspace rule this matters only
for the gate, not for any deployed client). Export the
`WorkspaceContext` interface from this module or from a
shared `web/src/api/types.ts` file.

D.7 Update `web/src/stores/analystChat.ts`: at the top
of `sendMessage`, read
`useWorkspaceRouteStore().current` and pass it as the
third argument to `sendChatMessage`. If the store has
not yet been bootstrapped (test scenarios), pass
`{ view: null, entityId: null, refinement: null }`.

D.8 In the same file, immediately after the existing
`toolInvocations` flatMap block (found in A.8 at the
line referenced in `tmp/s08-chat-store-before.txt`),
add a new pass that iterates
`response.toolInvocations` and, for each invocation
with `tool === 'navigate_workspace'` or
`tool === 'navigate_back'` AND
`result.success === true`, calls
`workspaceRoute.apply(invocation.result.data)`. Failed
invocations are skipped. The new pass MUST NOT touch
the transcript messages computed by the existing
flatMap; both passes consume the same source array
independently.

D.9 Update the backend HTTP route in
`src/server/routes/chats-files-debug.ts`: extend the
zod (or hand-rolled) body validator for
`POST /api/chats/:sessionId` to accept an optional
`workspaceContext` object with shape
`{ view: string|null, entityId: string|null, refinement: Record<string, string>|null }`.
On success, forward the value as the third arg to
`handler.handleMessage`. On validation failure
(`view` is not a string-or-null, etc.), return
400 with the validation error message.

D.10 Run `npx tsc --noEmit` and capture
to `tmp/s08-tsc-after-phase-D.txt`. Required outcome:
exit code 0.

## Phase E — AnalystChatPanel on-screen-children render

E.1 Open `web/src/components/chat/AnalystChatPanel.vue`
and confirm the pre-edit SFC structure (one
`<template>`, one `<script setup>`, optional `<style>`)
matches the A.6 SFC-corruption pre-check. If any
divergence is observed, abort Phase E and fix the
corruption first (per workspace memory: SFC corruption
in `replace_string_in_file` flow).

E.2 Add an import of
`useCardStore` from `../../stores/cards` and of
`useWorkspaceRouteStore` from `../../stores/workspaceRoute`
at the top of `<script setup>`.

E.3 Add a `childrenOnScreen` computed that returns
`cards.childrenOf(workspaceRoute.entityId)` when
`workspaceRoute.view === 'cards'` and
`workspaceRoute.entityId` is non-null; otherwise
returns an empty array. The computed MUST NOT call
`.sort` on the result (S06's `childrenOf` already
returns position order).

E.4 In the `<template>`, add an "On screen" header
section above the transcript region with a `<ul>` that
renders one `<li>` per entry in `childrenOnScreen`
showing `{{ child.id }} — {{ child.title }}`. The
section MUST render only when `childrenOnScreen.length`
is non-zero (no empty list, no placeholder copy that
would visually clutter the no-card-open case).

E.5 Save the file in VS Code (per workspace memory:
`workbench.action.files.saveAll` before any build,
because VS Code buffers do not auto-save). Then run
`grep -c '<script setup' web/src/components/chat/AnalystChatPanel.vue`
to confirm exactly one block (catch the duplication
failure mode early).

E.6 Run `cd web && npm run build` and capture to
`tmp/s08-web-build-after-phase-E.txt`. Required
outcome: exit code 0. If the build fails for a
non-S08 reason (cascade from an earlier stage), the
issue must be tracked back to the cascading source
and fixed in-stage under the holistic-fix-first rule.

## Phase F — Tests (web + backend)

F.1 Create
`web/src/__tests__/stores/workspaceRoute.test.ts`
covering, at minimum: (a) `current` reflects the
initial route on store instantiation;
(b) `router.afterEach` triggers a back-stack push and a
`current` update; (c) `apply({ intent: 'navigate_workspace', target })`
is exercised once per exposed `target.kind` value and
the test asserts the exact `router.push` argument for
every kind — the assertion table covers ALL SEVEN
schema enum values without omission:
  - `card` → `{ name: 'card-detail', params: { id } }`
  - `transcript` → `{ name: 'agent-detail', params: { id } }`
  - `process` → `{ name: 'process-detail', params: { id } }`
  - `plan_diary` → `{ name: 'card-plan', params: { id } }`
  - `process_list` → `{ name: 'debug' }`
  - `agent_session_list` → `{ name: 'agents' }`
  - `config` → `{ name: 'config' }`
(d) `apply({ intent: 'navigate_back' })` pops the
back-stack and calls `router.push` with the popped
snapshot; (e) back-stack bounded to 16;
(f) `apply({ intent: 'navigate_back' })` on an empty
stack does not call `router.push` and does not throw;
the test asserts those two facts and nothing more.

F.2 Create
`web/src/__tests__/stores/analystChat.context.test.ts`
covering: (a) `sendMessage` calls the API client with a
third arg mirroring the route store snapshot;
(b) when the route store is at its default,
`sendMessage` sends `{ view: null, entityId: null, refinement: null }`;
(c) on a `navigate_workspace` invocation success, the
chat store calls `workspaceRoute.apply` exactly once
with the full `invocation.result.data` object
(`{ intent: 'navigate_workspace', target }`) — the
assertion uses object-equality against that payload,
not against the discriminator string alone;
(d) on a failed invocation (`result.success: false`),
the chat store does NOT call `workspaceRoute.apply`.

F.3 Create
`web/src/__tests__/components/AnalystChatPanel.children.test.ts`
covering: (a) the SFC's `<script setup>` imports the
singular `useCardStore` symbol from
`../../stores/cards` — the test reads the SFC source
and asserts a line matching
`/import\s*\{[^}]*\buseCardStore\b[^}]*\}\s*from\s*['\"]\.\./\.\./stores/cards['\"]/`
is present AND that the imported symbol is the same
object as the export named `useCardStore` in
`web/src/stores/cards.ts` (`expect(useCardStore).toBeDefined()`);
(b) with `workspaceRoute.view === 'cards'`
and `entityId` set to a parent whose children are
written into the cards store in position order
[2, 0, 1], the rendered list appears in position order
[0, 1, 2]; (c) with `workspaceRoute.view === 'dashboard'`,
the on-screen-children list does NOT render.

F.4 Create
`tests/agents/analyst-navigation.test.ts` (jest)
covering: (a) `navigate_workspace` via
`runAuditedAnalystTool` with `actor: 'analyst'` returns
`{ success: true, data: { intent: 'navigate_workspace', target } }`;
(b) the same call with `actor: 'planner'` is denied
(or whatever the audited runner's no-policy outcome
is — likely a deny verdict);
(c) `navigate_back` via the audited runner returns
`{ success: true, data: { intent: 'navigate_back' } }`;
(d) the audit log contains entries with
`action: 'workspace.navigate'` / `workspace.navigate_back`
and `safety_class: 'low'`.

F.5 Create
`tests/server/chats-route-workspace-context.test.ts`
(jest) covering: (a) `POST /api/chats/:sessionId` with
body `{ content: 'hi' }` returns 200 and forwards
`(sessionId, 'hi', undefined)` to `handler.handleMessage`;
(b) the same route with a valid `workspaceContext` body
returns 200 and forwards the exact payload as the third
arg; (c) malformed `workspaceContext` returns 400.

F.6 Add a small additional jest in
`tests/agents/analyst-system-prompt.test.ts` (or extend
an existing one if it already exists) that snapshots
the rendered system prompt with and without a
workspace-context fixture, to lock in the C.4
deictic-resolution paragraph.

F.7 Run `cd web && npm test` and capture to
`tmp/s08-vitest-after-phase-F.txt`. Required outcome:
exit code 0; zero failing tests.

F.8 Run `npm test` and capture to
`tmp/s08-jest-after-phase-F.txt`. Required outcome:
exit code 0; zero failing tests.

## Phase G — Static analysis + manual reviews

G.1 Run
`grep -nE 'navigate_workspace|navigate_back' src/agents/analyst-tools.ts src/agents/analyst-tool-schemas.ts src/agents/role-tool-policy.ts src/tools/agent-tools.ts`
and confirm the registration matrix has the same
cardinality as A.4 — only the handler bodies changed,
not the registration sites.

G.2 Run
`grep -nE 'workspaceContext|useWorkspaceRouteStore' web/src/ src/`
and confirm the matches enumerate exactly the files
listed under "Surfaces touched" in design.md (no
accidental call sites in unrelated components).

G.3 Run
`grep -REn 'router\.push|router\.back' web/src/`
and confirm the only call sites are
(a) inside `web/src/stores/workspaceRoute.ts` and
(b) the existing pre-S08 user-driven nav code in views
(unchanged by S08). Any `router.push` outside those
sets is a violation of the SSoT discipline and must be
re-routed through `workspaceRoute.apply`.

G.4 Run
`grep -REn 'childrenOf' web/src/components/chat/`
and confirm exactly one match in `AnalystChatPanel.vue`.

## Phase H — Close-out

H.1 Autonomy anchor grep across the draft directory,
run in two forms (per S00 cookbook §3) — both must
return zero hits.

Anchor-file form (the checked-in canonical list):

```
grep -REn -i -f SPEC/analyst-as-control-surface/PLAN/forbidden-anchors.txt SPEC/analyst-as-control-surface/PLAN/drafts/008-analyst-nav-and-chat-context/
```

Inline literal form (kept here so the gate is self-
contained even if the anchor file is missing or
diverges):

```
grep -REn -i -E '(spec-r[1-6]|protocol-r[1-3]|master-plan-r[1-6]|review[-]r|prior[ ]round|earlier[ ]round|previous[ ]version|previous[ ]draft|before[ ]the[ ]refactor|was[ ]superseded|older[ ]revision)' SPEC/analyst-as-control-surface/PLAN/drafts/008-analyst-nav-and-chat-context/
```

The inline alternation uses single-character classes
(for example `review[-]r`, `prior[ ]round`) so the
literal forbidden anchor strings do not appear
verbatim. The `r[1-6]` digit range excludes the
currently-active spec/plan revision so this stage may
legitimately reference SPEC sections of that revision
in `design.md` without tripping the gate.

H.2 Host-path guard. Run
`grep -REn '/wo''rk/' SPEC/analyst-as-control-surface/PLAN/drafts/008-analyst-nav-and-chat-context/`
(the empty single-quote concatenation produces the
literal forward-slash-w-o-r-k-forward-slash without
matching this grep line itself). Expected: zero hits.

H.3 Emoji guard. Run
`grep -RnP '[\x{1F300}-\x{1FAFF}\x{2600}-\x{27BF}]' SPEC/analyst-as-control-surface/PLAN/drafts/008-analyst-nav-and-chat-context/`.
Expected: zero hits. The `-P` flag invokes PCRE for
the Unicode range; do not substitute `-E` (it does not
support Unicode ranges in this form).

H.4 Conditional ledger close-out. Read
`SPEC/analyst-as-control-surface/PLAN/expected-breakage-ledger.md`
and identify every OPEN entry whose
`Target fix stage:` field reads `S08`. For each such
entry, verify the corresponding failing id is no
longer observed in the gate diff produced by H.9 below
(this substep runs after H.9 in real time even though
it appears earlier in the plan's numbering — H.4 is
conditional on H.9's diff, so the implementer runs
Phase H.9 first, returns to Phase H.4 with the diff in
hand, then proceeds to Phase H.5 through H.8).

The paper-plan default for S08 is: exactly one OPEN
entry matches, namely
`analyst-e2e:scenario-analyst-chat-context-child-order:step-1`
(Recorded by S03 / 2026-05-25, Target fix stage S08).
The failing id is not currently observed by any gate
in the S00 baseline (no live e2e scenario authored yet
on saivage-e2e-checkers carries that id), and after
S08 the chat panel consumes `cards.childrenOf` which
returns position order, so the failure mode the entry
names cannot occur in the post-S08 source. The
close-out condition therefore holds in the paper-plan
default: the entry is removed from the cumulative
ledger and a single-line evidence note is appended to
`SPEC/analyst-as-control-surface/PLAN/drafts/008-analyst-nav-and-chat-context/implementation-notes.md`
(creating it on first append) of the shape
`- closed analyst-e2e:scenario-analyst-chat-context-child-order:step-1 — chat panel now consumes cards.childrenOf (position order); ledger entry removed.`

If any condition fails (for example, a regression in
`AnalystChatPanel.children.test.ts` between Phase F
and Phase H), the substep is a TRUE no-op: zero edits
to the cumulative ledger, with a single-line note to
`implementation-notes.md` recording which condition
failed.

H.5 Run `cd web && npm run build` and capture to
`tmp/s08-web-build-after.txt`. Required outcome: exit
code 0.

H.6 Run `npm run build` and capture to
`tmp/s08-build-after.txt`. Required outcome: exit code
0.

H.7 Run `cd web && npm test` and capture to
`tmp/s08-vitest-after-H.txt`. Required outcome: exit
code 0; zero failing tests.

H.8 Run `npm test` and capture to
`tmp/s08-jest-after-H.txt`. Required outcome: exit
code 0; zero failing tests.

H.9 Gate diff. From `saivage-v3/`, run
`bash SPEC/analyst-as-control-surface/PLAN/scripts/run-gates.sh --diff SPEC/analyst-as-control-surface/PLAN/baseline-gates.json`
and capture to `tmp/s08-gates-after.txt`. Required
outcome: exit code 0; zero NEW failing ids on every
gate. REPAIRED rows are permitted only if H.10's
conditional baseline edit actually fires (which the
paper-plan default forbids).
`diff tmp/s08-gates-before.txt tmp/s08-gates-after.txt`
for the close-out comment block.

H.10 Conditional baseline refresh. Read
`tmp/s08-baseline-before.json`. S08 deliberately ADDS
new vitest files (Phase F.1–F.3) and new jest files
(Phase F.4–F.6). For each new file, check whether any
gate `failing_ids` entry references the file (the
paper-plan default: no — new test files start green
and the baseline does not pre-record green files).
The condition is therefore guaranteed false; the
paper-plan default outcome is a no-op on
`baseline-gates.json`. Confirm via
`diff tmp/s08-baseline-before.json SPEC/analyst-as-control-surface/PLAN/baseline-gates.json`
which must produce an empty diff.

H.11 **Breakage triage** — S09–S10-targeted conditional
forecast append.
After H.9 has produced its gate diff, the implementer
reviews the diff for NEW failing ids on the four
gates. For each such NEW failing id whose root cause
is NOT inside S08's scope and which holistic-fix-first
(MASTER-PLAN section 3 rule (3)) cannot resolve
in-stage, append exactly one H3-headed block to
`SPEC/analyst-as-control-surface/PLAN/expected-breakage-ledger.md`
following the authoritative schema in
`expected-breakage-ledger.md` and MASTER-PLAN
section 6.1: one H3 entry per failing id, followed by
four labeled single-line fields in this exact order:

```md
### <gate>:<failing-id>
Failure mode: <one sentence>
Reason acceptable now: <SPEC requirement or earlier-stage decision>
Target fix stage: <S09 or S10>
Recorded by: S08 / <YYYY-MM-DD>
```

The `Target fix stage:` value is exactly one of `S09`
or `S10` — NEVER `S08` itself per MASTER-PLAN
section 3 rule (8): a stage never forecasts breakage
for its own scope. The append shape is NEVER a
single-line checklist (`- [ ] ...`) — the cumulative
ledger uses only the H3/labeled-line schema above.
The paper-plan default outcome is zero such failures
observed (S08 is a wiring stage with two activated
tools, one optional body field, and one new
chat-panel render block; all four surfaces are inside
S08's scope and covered by Phase F's tests), so the
cumulative ledger is byte-unchanged from H.4's
post-state. Confirm by
`diff tmp/s08-ledger-before.md SPEC/analyst-as-control-surface/PLAN/expected-breakage-ledger.md`
which is expected to show ONLY the H.4 removal of the
chat-context-child-order entry (no other diff lines).

H.12 Final guard re-runs. Repeat H.1, H.2, H.3 against
the draft directory to confirm no transient violation
slipped in during H.4–H.11. Expected: zero hits on
each. Also re-run
`bash SPEC/analyst-as-control-surface/PLAN/scripts/check-stage-links.sh SPEC/analyst-as-control-surface/PLAN/drafts/008-analyst-nav-and-chat-context/`
to confirm all in-draft links still resolve. Required
outcome: exit code 0.

H.13 Publication via atomic rename. Confirm the draft
directory and the target stages directory are on the
same filesystem:
`stat -c '%d' SPEC/analyst-as-control-surface/PLAN/drafts/008-analyst-nav-and-chat-context`
and
`stat -c '%d' SPEC/analyst-as-control-surface/PLAN/stages`
must report the same device id. Capture pre-publication
file hashes:
`sha256sum SPEC/analyst-as-control-surface/PLAN/drafts/008-analyst-nav-and-chat-context/{design.md,plan.md} > tmp/s08-pre-publish-hashes.txt`
(and include `implementation-notes.md` in the hash set
if H.4 created it). Publish:
`mv SPEC/analyst-as-control-surface/PLAN/drafts/008-analyst-nav-and-chat-context SPEC/analyst-as-control-surface/PLAN/stages/008-analyst-nav-and-chat-context`.
Verify post-publication:
`ls -la SPEC/analyst-as-control-surface/PLAN/stages/008-analyst-nav-and-chat-context/`
shows `design.md` and `plan.md` present (and
`implementation-notes.md` if H.4 created it), and
`sha256sum SPEC/analyst-as-control-surface/PLAN/stages/008-analyst-nav-and-chat-context/{design.md,plan.md}`
matches the pre-publication hashes byte-for-byte.

The cumulative ledger
(`SPEC/analyst-as-control-surface/PLAN/expected-breakage-ledger.md`)
is the only file outside the draft directory that S08
modifies (via H.4's conditional close-out and H.11's
conditional forecast append). The cumulative ledger
holds OPEN entries only, per S00's
ledger-as-open-entries-only contract; the per-stage
attribution log lives in the stage-local
`implementation-notes.md` file (written by H.4, if
at all).
