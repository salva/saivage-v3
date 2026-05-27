# Design: UI port rebaseline batch 1 — F02 + F05 completion against HEAD `eb98caf`

This is a **Branch B (design-included)** proposal under the
mailbox classification objective in
[.saivage/config.json](../.saivage/config.json). The harness MUST
NOT run a dual-proposal review on this entry, MUST NOT vary the
scope, MUST produce a `stage-plan.md` with a deliverable→stage
coverage table, and MUST honour the nothing-lost invariant. If
any precondition is missing at HEAD, file a delta proposal or
reject via `<basename>.decision.md` — do not implement a subset.

## Problem

The UI port from Saivage v2 to v3 has landed partially. F01
(design tokens) is complete. F02 (component hierarchy) and F05
(tool-detail rendering) have only their foundations shipped
(mailbox-003, mailbox-004, mailbox-005); the bulk of their
deliverables — primitives in `conversation/`, AppShell modal
flag, NavRail chip migration, the C7–C15 surface rewrites,
FilesView canonical routing, per-tool test suite — remain
pending. The mailbox-004 cycle silently descoped the cross-batch
C5 commit and the surface rewrites, which cascaded into the
rejections of mailbox-006 (F03) and mailbox-007 (F04).

This batch closes the F02 + F05 gap so that R2 (F03) and R3
(F04) have the primitive substrate they need.

## Decision (binding contract)

The implementation contract is the union of three documents,
all APPROVED:

- F02 analysis r2, design r3, plan r2 under
  [SPEC/2026-05/review-ui-port-from-v2/F02-component-hierarchy/](../SPEC/2026-05/review-ui-port-from-v2/F02-component-hierarchy/).
- F05 analysis r2, design r3, plan r2 under
  [SPEC/2026-05/review-ui-port-from-v2/F05-tool-detail-rendering/](../SPEC/2026-05/review-ui-port-from-v2/F05-tool-detail-rendering/).
- The rebaseline addendums against HEAD `eb98caf`:
  - [F02-component-hierarchy/04-rebaseline-against-HEAD-r2.md](../SPEC/2026-05/review-ui-port-from-v2/F02-component-hierarchy/04-rebaseline-against-HEAD-r2.md)
    (APPROVED — see sibling `REBASELINE-APPROVED.md`).
  - [F05-tool-detail-rendering/04-rebaseline-against-HEAD-r2.md](../SPEC/2026-05/review-ui-port-from-v2/F05-tool-detail-rendering/04-rebaseline-against-HEAD-r2.md)
    (APPROVED — see sibling `REBASELINE-APPROVED.md`).

The rebaseline addendums are binding extensions of the original
plans. Together they restate exactly which deliverables have
shipped (§2 of each), which remain (§3), and which are
explicitly delegated to a sibling batch (§3.6 of the F02
rebaseline).

**The R1 batch implements §3 + §4 of each rebaseline.** It does
**NOT** touch `web/src/components/agents/AgentConversationView.vue`,
`web/src/components/chat/AnalystChatPanel.vue`, or
`web/src/components/conversation/ToolChip.vue` — those three
files are R2 (F03) territory per F03 plan r2 §2.2 rows 15+16 +
§2.1, and the F02 rebaseline §3.6 explicitly delegates them.

## Files to change

The full, binding inventory is the rebaseline addendums. Compact
summary:

- **Add**: `web/src/components/conversation/MessageBubble.vue`,
  `web/src/components/conversation/ThinkingDots.vue`, plus
  matching tests under `web/src/__tests__/conversation/`.
- **Add**: `web/src/__tests__/tool-presenters/_helpers.ts`,
  `web/src/__tests__/tool-presenters/registry.test.ts`, and one
  `<tool>.test.ts` per per-tool module (45 files; tool names
  enumerated in F05 plan analysis §3.1).
- **Modify**: `web/src/styles/patterns.css` (add the
  `.tablist > .pill[aria-pressed="true"]` rule per F02 analysis
  §2.2).
- **Modify**: `web/src/components/layout/AppShell.vue`
  (`globalKeyHandler` at L135 short-circuits on
  `document.body.dataset.modalOpen === 'true'`).
- **Modify**: `web/src/components/ui/Overlay.vue` (module-level
  open counter + body-flag set/clear per F02 design r3 §9.3).
- **Modify**: `web/src/components/nav/NavRail.vue` (`api-token-btn`
  at L21 → `<Button icon-only>`; remove `.api-token-btn` CSS at
  L185; rest of NavRail rewrite per plan C15).
- **Modify**: `web/src/components/layout/WorkspaceHeader.vue`
  (chip cluster rewrite per plan C7).
- **Modify**: `web/src/views/DashboardView.vue` (plan C8).
- **Modify**: `web/src/views/FilesView.vue` (plan C9 + F05
  canonical `?root=meta|output&path=...` routing; bespoke
  `.panel-root`, `.panel-refresh-btn`, `.files-global-banner`,
  `.panel-crumbs`, `.panel-card`, `.panel-loading`,
  `.panel-empty` deleted).
- **Modify**: `web/src/views/DebugView.vue` (plan C10).
- **Modify**: `web/src/components/agents/RawLlmExchangePanel.vue`
  (plan C12).
- **Modify**: `web/src/components/cards/*.vue` (plan C14; full
  deletion list in plan analysis §4.11).
- **Modify**: selector-migration tests for each surface rewrite
  per F02 plan analysis §5.2 (excluding tests for
  `AgentConversationView` and `AnalystChatPanel`, which belong to
  R2/R3).

## Files / tests / docs to DELETE

- Bespoke selector blocks listed in F02 plan analysis §4.1–§4.11
  for the surfaces in scope (C7, C8, C9, C10, C12, C14, C15
  rows; NOT C11 / C13 — those are R2/R3).
- `web/src/__tests__/tool-presenters.test.ts` (flat legacy file;
  replaced by the nested per-tool suite). Keep
  `tool-presenters.coverage.test.ts` and
  `tool-presenters.barrel-integrity.test.ts` (cross-cutting
  invariants).
- `.api-token-btn { … }` CSS block in NavRail.vue at L185.

## Validation gate

The R1 PR tip must satisfy:

- Per-commit grep gates as specified in F02 plan r2 §2 for each
  C-number in scope.
- `npm --prefix web run typecheck && npm --prefix web run test -- --run && npm --prefix web run build`.
- `npm run lint` (includes the
  `scripts/check-web-component-boundaries.cjs` gate, in
  particular the tool-presenter barrel-import rule).
- F02 plan r2 §3 full-suite gates, in particular gate (k):
  `git grep -nE "document\.body\.dataset\.modalOpen|data-modal-open" web/src/ | wc -l` ≤ 2 (one reader in
  AppShell, one writer in Overlay).
- F05 forbidden-shape grep: `git grep -n 'formatToolPair\|FormattedToolPair' web/src/ | wc -l` MUST be 0.
- Live UI probe: visit `/files?root=meta&path=` and
  `/files?root=output&path=`; both panels render via the unified
  canonical router-driven view.

## Risks / accepted residuals

- The R1 batch leaves three files explicitly untouched
  (`AgentConversationView.vue`, `AnalystChatPanel.vue`,
  `ToolChip.vue`). Those surfaces still display the legacy
  inline-chip markup and the F05-legacy four-prop ToolChip API
  until R2 (F03) ships. The operator has accepted this residual.
- The C11 (`AgentConversationView` non-round) and C13
  (`AnalystChatPanel` non-chip) surface rewrites from the F02
  plan are subsumed by R2's full rewrites of those files; the
  F02 plan §2 grep gates for those two commits do NOT apply
  to R1.

## Sequencing note

This is the first of three mailbox batches in the rebaseline
sequence. R2 (F03) and R3 (F04) will follow as separate mailbox
entries; they hard-check R1 preconditions before starting.

The harness MUST produce
`architecture-audit/mailbox-<NNN>-ui-port-rebaseline-batch-1/classification.md`
identifying this as Branch B, and
`architecture-audit/mailbox-<NNN>-ui-port-rebaseline-batch-1/stage-plan.md`
with a deliverable→stage coverage table whose union equals §3 +
§4 of the F02 rebaseline plus §3 + §4 of the F05 rebaseline.

## Out of scope

- All R2 (F03) and R3 (F04) deliverables.
- Any modification of `AgentConversationView.vue`,
  `AnalystChatPanel.vue`, or `ToolChip.vue`.
- Backend changes (this is a web-only batch).
- Any new feature, new view, new route beyond the FilesView
  query rewrite.
