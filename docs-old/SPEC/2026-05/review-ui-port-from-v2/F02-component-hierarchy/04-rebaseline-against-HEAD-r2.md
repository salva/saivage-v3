# F02 — Rebaseline against HEAD `eb98caf` (r2)

Writer round 2. Addresses the reviewer findings on r1
(stale line number for `globalKeyHandler`; chip-swap ownership
contradiction with the F03 plan; missing tablist-rule and
selector-migration-test stages; missing C8 AgentConversationView
helper deletions). This document supersedes
[04-rebaseline-against-HEAD-r1.md](04-rebaseline-against-HEAD-r1.md).

This is a **binding addendum** to the F02 approved artifacts:

- analysis: [01-analysis-r2.md](01-analysis-r2.md)
- design:   [02-design-r3.md](02-design-r3.md)
- plan:     [03-plan-r2.md](03-plan-r2.md)

The approved analysis, design, and plan are unchanged. This
document records what HEAD `eb98caf` already contains relative to
the F02 plan, what remains to land in this batch, and what is
explicitly delegated to F03 R2 (a separate mailbox batch). A
reader who has never seen earlier review rounds can implement
F02's remaining work by combining [02-design-r3.md](02-design-r3.md),
[03-plan-r2.md](03-plan-r2.md), and this rebaseline.

The implementer MUST NOT recreate files listed in §2, MUST NOT
introduce alias re-exports, MUST NOT touch the files explicitly
delegated to F03 in §3.6, and MUST follow the nothing-lost
invariant in §5.

---

## 1. HEAD reference

- Commit: `eb98caf` (`master`).
- F02-relevant prior landings: `05b8594` (F02 partial — `ui/`,
  `content/`, `auth/ApiTokenEntry` migration, `patterns.css`
  tone rules), `feb442f` (F05 — `tool-presenters/` registry +
  `InlinePart` + `json-tokenize.ts`).
- Mailbox cycle audit:
  [architecture-audit/mailbox-004-ui-port-f02-component-hierarchy/decision.md](../../../../architecture-audit/mailbox-004-ui-port-f02-component-hierarchy/decision.md)
  records the explicit scope reduction that left C5 (most of it),
  C6 (partial), and C7–C15 unimplemented.

The implementer MUST verify HEAD has not modified
`web/src/components/{ui,content,conversation,nav,layout,chat,agents}/`,
`web/src/views/`, `web/src/styles/patterns.css`, or
`web/src/components/cards/` before starting.

---

## 2. Already-landed deliverables (NO-OP)

### 2.1 Primitives (`web/src/components/ui/`) — plan C1+C2

| File | Status |
| --- | --- |
| `Button.vue` | landed |
| `Pill.vue` | landed |
| `Card.vue` | landed |
| `PanelHeading.vue` | landed |
| `StatusDot.vue` | landed |
| `Spinner.vue` | landed |
| `Overlay.vue` | landed (partial — missing the `data-modal-open` body flag; see §3.3) |

### 2.2 Content layer (`web/src/components/content/`) — plan C3+C4

| File | Status |
| --- | --- |
| `CodeBlock.vue` (relocated from `components/code/`) | landed |
| `MarkdownText.vue` (relocated) | landed |
| `JsonView.vue` | landed |
| `FormattedContent.vue` | landed |
| `InlineParts.vue` | landed |

`web/src/components/code/` is deleted.

### 2.3 F05 registry — plan C4 cross-batch row

`web/src/utils/tool-presenters/` exists with 52 files (barrel,
registry, types, helpers, default, 45 per-tool modules);
`web/src/utils/json-tokenize.ts` exists; legacy
`web/src/utils/tool-presenters.ts` is deleted. (Full F05 status
is tracked in the F05 rebaseline; this row covers only the F02
plan C4 cross-batch dependency.)

### 2.4 `patterns.css` tone rules — plan C2

All present in
[web/src/styles/patterns.css](../../../../web/src/styles/patterns.css):

- `.status-dot-{ok,warn,danger,accent,muted}` — landed.
- `.card-{warn,danger,accent,user,purple}` — landed.
- `.pill-purple` — landed.

### 2.5 Bounded surface migration — plan C6 row

`web/src/components/auth/ApiTokenEntry.vue` rewritten on
`Overlay` + `Card` + `Button`; bespoke
`.token-overlay/.token-dialog/.token-btn*/.token-toggle`
selectors deleted.

### 2.6 ESLint / build infrastructure

- [scripts/check-web-component-boundaries.cjs](../../../../scripts/check-web-component-boundaries.cjs)
  exists and runs via `npm run lint`. Lines 86–87 enforce the
  tool-presenter barrel-import restriction (the rule lives here,
  not in `web/eslint.config.js`).
- `web/package.json` `sideEffects` array includes
  `src/utils/tool-presenters/**/*.ts` and `*.css`.

---

## 3. Remaining deliverables (IN SCOPE for this batch)

Every row below is a binding deliverable for the F02 R1 batch.
The harness's stage-plan MUST cover every row. Items explicitly
delegated to F03 R2 are listed separately in §3.6 and are NOT
covered by this batch.

### 3.1 Conversation primitives — plan C5 (F02-owned portion only)

| Deliverable | Path | Contract |
| --- | --- | --- |
| `MessageBubble.vue` | `web/src/components/conversation/MessageBubble.vue` | design [§1.3](02-design-r3.md#13-primitive-catalogue) row; analysis [§5.5](01-analysis-r2.md#55-messagebubble-test-contract) |
| `ThinkingDots.vue` | `web/src/components/conversation/ThinkingDots.vue` | design [§1.3](02-design-r3.md#13-primitive-catalogue); analysis [§5.6](01-analysis-r2.md#56-thinkingdots-test-contract) |
| `__tests__/conversation/MessageBubble.test.ts` | analysis §5.5 cases | |
| `__tests__/conversation/ThinkingDots.test.ts` | analysis §5.6 cases | |

The remaining C5 deliverables (`ToolChip.vue` eight-prop rewrite,
`RoundCard.vue`, `DiagnosticRow.vue`, `PendingCallFooter.vue`,
`CompactedCluster.vue`, `ContextBlock.vue`,
`web/src/components/chat/tool-chip-adapter.ts`,
`web/src/components/chat/analyst-timeline.ts`, chip swap inside
`AnalystChatPanel.vue` and `AgentConversationView.vue`) are
**F03-owned** per [F03 plan r2 §2.1 + §2.2](../F03-conversation-rounds/03-plan-r2.md);
they belong to the R2 batch. See §3.6.

### 3.2 `patterns.css` final extension rule

| Deliverable | Path |
| --- | --- |
| Add `.tablist > .pill[aria-pressed="true"]` rule (analysis §2.2) | `web/src/styles/patterns.css` |

Required by C8 (Dashboard tablists) and C10 (Debug tablists).
At HEAD, `grep -n 'tablist' web/src/styles/patterns.css` returns
nothing.

### 3.3 AppShell modal-flag short-circuit — plan C6

| Deliverable | Path |
| --- | --- |
| `globalKeyHandler` (declared at [web/src/components/layout/AppShell.vue:135](../../../../web/src/components/layout/AppShell.vue#L135), registered at L158) short-circuits on `document.body.dataset.modalOpen === 'true'` | `web/src/components/layout/AppShell.vue` |
| `Overlay.vue` sets/clears `document.body.dataset.modalOpen` symmetrically via a module-level open counter so nested overlays compose (design §9.3) | `web/src/components/ui/Overlay.vue` |

Both land in the same commit (plan C6); the full-suite gate (k)
(`<= 2` readers of `data-modal-open`) is the regression detector.

### 3.4 NavRail `.api-token-btn` chip migration — plan C6 + C15

| Deliverable | Path |
| --- | --- |
| Replace `class="nav-link api-token-btn"` at [web/src/components/nav/NavRail.vue:21](../../../../web/src/components/nav/NavRail.vue#L21) with `<Button icon-only>`; remove the `.api-token-btn { … }` block at line 185 | `web/src/components/nav/NavRail.vue` |

### 3.5 Surface rewrites — plan §2 C7, C8, C9, C10, C12, C14, C15

The implementer MUST execute every surface rewrite in the plan
that still has bespoke selectors at HEAD AND that is NOT
delegated to F03 in §3.6. Survey results at HEAD `eb98caf`:

| Plan commit | Surface | Bespoke selectors still present | Owning plan section |
| --- | --- | --- | --- |
| C7 | `web/src/components/layout/AppShell.vue` auth banner | `.auth-required-banner` family | plan §2 C7 |
| C7 | `web/src/components/layout/WorkspaceHeader.vue` chip cluster | `.ws-chip`, `.runtime-chip`, `.pause-chip`, `.chip-dot` | plan §2 C7 |
| C8 | `web/src/views/DashboardView.vue` | `.refresh-btn` (3), `.runtime-banner` (3), `.actionable-error` (1) | plan §2 C8 |
| C9 | `web/src/views/FilesView.vue` (co-committed with F05 routing) | `.files-global-banner` (1), `.panel-root` / `.panel-refresh-btn` / `.panel-crumbs` / `.panel-card` / `.panel-loading` / `.panel-empty` family | plan §2 C9 + F05 rebaseline §3.1 |
| C10 | `web/src/views/DebugView.vue` | `.debug-tab` (5), `.dg-item` (1) | plan §2 C10 |
| C12 | `web/src/components/agents/RawLlmExchangePanel.vue` | `.rlp-tab` (3) | plan §2 C12 |
| C14 | `web/src/components/cards/*.vue` | `.board-card` (2), `.nav-pill` (1) — verify full plan analysis §4.11 list | plan §2 C14 |
| C15 | `web/src/components/nav/NavRail.vue` | rest of `nav-link` family beyond §3.4 | plan §2 C15 |

Every selector in the plan's analysis §4.1–§4.11 deletion matrix
for these C-numbers MUST be removed in the same commit that
introduces its replacement. Per-commit grep gates in plan §2 are
authoritative.

### 3.6 F03-owned files (NOT in this batch — for reference only)

The F03 plan r2 §2.2 specifies a **full rewrite** of the
following files. The F02 R1 batch MUST NOT touch them; they are
the F03 R2 batch's territory.

- `web/src/components/agents/AgentConversationView.vue` (F03
  plan §2.2 row 15; F03 commit 7). The F02 plan C11 surface
  rewrite for this file is subsumed by F03's full rewrite — F03
  R2 covers both the non-round chrome (`.conv-tb-btn`) and the
  round timeline render.
- `web/src/components/chat/AnalystChatPanel.vue` (F03 plan §2.2
  row 16; F03 commit 6 — chip swap; subsequently F04 R3 batch
  B5 — full decomposition). The F02 plan C13 surface rewrite
  for this file is subsumed by F03 + F04.
- `web/src/components/conversation/ToolChip.vue` (F03 plan §2.1
  + commit 5 — eight-prop rewrite from the F05-legacy four-prop
  signature).

If at the moment of F02 R1 implementation any of these three
files has already been rewritten by F03 R2 (out-of-order
landings), the F02 batch leaves them untouched and proceeds.
The F02 R1 batch's grep gates (§3.5) MUST exclude these three
files from their failure conditions.

### 3.7 Selector-migration tests — plan §1.3 test rows

For every surface in §3.5, update the corresponding test file
to query `data-testid="..."` instead of bespoke class
selectors. The full test list is plan analysis §5.2 row by row;
no shortcut. Tests for `AgentConversationView` and
`AnalystChatPanel` are F03 R2 territory and excluded here.

---

## 4. Reconciliation deliverables (replace shipped-with-wrong-shape)

### 4.1 `Overlay.vue` `data-modal-open` flag (design §9.3)

Pair this reconciliation with §3.3 in the **same commit** (plan
C6). The Overlay must own the open counter and the body-flag
set/clear in `onMounted` / `onUnmounted` (or `watchEffect`).

There is no F02 R1 reconciliation of `ToolChip.vue`. The chip
API change is F03 R2 territory (F03 plan §2.1 row "ToolChip" +
commit 5). F02 R1 leaves the file as-is.

---

## 5. Nothing-lost invariant (binding)

The harness MUST:

1. Read this rebaseline plus [02-design-r3.md](02-design-r3.md)
   and [03-plan-r2.md](03-plan-r2.md).
2. Produce a stage-plan whose stages, taken together, cover
   every row in §3.1 through §3.5 and §3.7, plus §4.1. No row
   may be silently dropped, narrowed, merged into "primitive
   only", or marked "future work".
3. Respect §3.6: F02 R1 MUST NOT modify
   `AgentConversationView.vue`, `AnalystChatPanel.vue`, or
   `ToolChip.vue`. Any change to those files belongs in F03 R2.
4. If a precondition shifts during implementation, file a delta
   proposal naming the exact row, OR reject the batch via
   `<basename>.decision.md` listing every row that would be
   lost. Implementing a subset and archiving to `done/` is
   forbidden.
5. Per-commit grep gates in plan §2 are acceptance criteria for
   each surface commit. Full-suite gates in plan §3 are the PR
   acceptance criteria.

---

## 6. Stage-mapping suggestion (non-binding shape)

A reasonable decomposition:

- Stage S1 — Conversation primitives + AppShell modal flag +
  Overlay body flag + NavRail single-line chip + tablist CSS
  rule. (plan C5 F02 portion + plan C6 + §3.2 tablist + §3.4
  NavRail line) Tests in §3.1.
- Stage S2 — AppShell auth banner + WorkspaceHeader chip cluster
  (plan C7). Tests in §3.7 for these surfaces.
- Stage S3 — DashboardView (plan C8) + tests.
- Stage S4 — FilesView (plan C9; co-committed with F05 routing
  per F05 rebaseline §3.1) + tests.
- Stage S5 — DebugView (plan C10) + tests.
- Stage S6 — RawLlmExchangePanel (plan C12) + tests.
- Stage S7 — Cards (plan C14) + tests.
- Stage S8 — NavRail full rewrite (plan C15) + tests.

After Stage S8: full-suite gates per plan §3. Open PR.

If the harness chooses a different decomposition, every row in
§3 + §4 must still be covered, every selector deletion in plan
§2 must complete, and §3.6 must remain a hard no-touch list.
