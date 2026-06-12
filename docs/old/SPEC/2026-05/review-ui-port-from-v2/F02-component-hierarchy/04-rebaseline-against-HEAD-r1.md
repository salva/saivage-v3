# F02 — Rebaseline against HEAD `eb98caf` (r1)

This is a **binding addendum** to the F02 approved artifacts:

- analysis: [01-analysis-r2.md](01-analysis-r2.md)
- design:   [02-design-r3.md](02-design-r3.md)
- plan:     [03-plan-r2.md](03-plan-r2.md)

The approved analysis and design are unchanged. The approved
plan's 15-commit sequence (C1–C15) and its deletion matrix, no-alias
rule, ESLint contract, and grep gates remain the binding
contract. This document records which of those deliverables
already exist on HEAD `eb98caf`, which remain to land, and which
shipped with a contract that must be reconciled with the design.
A reader who has never seen earlier review rounds can implement
the remaining F02 work by combining [02-design-r3.md](02-design-r3.md),
[03-plan-r2.md](03-plan-r2.md), and this rebaseline; no other
document is required.

The implementer MUST NOT recreate files listed in §2, MUST NOT
introduce alias re-exports for them, MUST NOT silently descope
anything in §3 or §4, and MUST follow the nothing-lost invariant
of §5.

---

## 1. HEAD reference

- Commit: `eb98caf` (`master`).
- Prior F02 implementation commits (already landed): `7c8af8d`
  (F01 design tokens), `05b8594` (F02 partial — `ui/` and
  `content/` foundation + `auth/ApiTokenEntry` migration),
  `feb442f` (F05 — `tool-presenters/` registry + InlinePart +
  `json-tokenize.ts`).
- Mailbox cycle audits:
  [architecture-audit/mailbox-004-ui-port-f02-component-hierarchy/decision.md](../../../../architecture-audit/mailbox-004-ui-port-f02-component-hierarchy/decision.md)
  records the explicit scope reduction that left C5, C7–C15, and
  parts of C6 unimplemented.

The implementer MUST verify HEAD matches `eb98caf` (or a
descendant that has not modified `web/src/components/ui/`,
`web/src/components/content/`, `web/src/components/conversation/`,
or `web/src/utils/tool-presenters/`) before starting. If HEAD has
moved in those directories, file a delta proposal against the new
HEAD before any implementation.

---

## 2. Already-landed deliverables (NO-OP; do not re-add)

The implementer MUST NOT recreate, move, or `git mv` these files.
They are the foundation the remaining batch builds on.

### 2.1 Primitives (`web/src/components/ui/`) — from plan §1.1 C1+C2

| File | Status | Path |
| --- | --- | --- |
| `Button.vue` | landed | [web/src/components/ui/Button.vue](../../../../web/src/components/ui/Button.vue) |
| `Pill.vue` | landed | [web/src/components/ui/Pill.vue](../../../../web/src/components/ui/Pill.vue) |
| `Card.vue` | landed | [web/src/components/ui/Card.vue](../../../../web/src/components/ui/Card.vue) |
| `PanelHeading.vue` | landed | [web/src/components/ui/PanelHeading.vue](../../../../web/src/components/ui/PanelHeading.vue) |
| `StatusDot.vue` | landed | [web/src/components/ui/StatusDot.vue](../../../../web/src/components/ui/StatusDot.vue) |
| `Spinner.vue` | landed | [web/src/components/ui/Spinner.vue](../../../../web/src/components/ui/Spinner.vue) |
| `Overlay.vue` | landed (partial — see §4.1) | [web/src/components/ui/Overlay.vue](../../../../web/src/components/ui/Overlay.vue) |

### 2.2 Content layer (`web/src/components/content/`) — from plan §1.1 C3+C4

| File | Status | Path |
| --- | --- | --- |
| `CodeBlock.vue` (relocated from `components/code/`) | landed | [web/src/components/content/CodeBlock.vue](../../../../web/src/components/content/CodeBlock.vue) |
| `MarkdownText.vue` (relocated) | landed | [web/src/components/content/MarkdownText.vue](../../../../web/src/components/content/MarkdownText.vue) |
| `JsonView.vue` | landed | [web/src/components/content/JsonView.vue](../../../../web/src/components/content/JsonView.vue) |
| `FormattedContent.vue` | landed | [web/src/components/content/FormattedContent.vue](../../../../web/src/components/content/FormattedContent.vue) |
| `InlineParts.vue` | landed | [web/src/components/content/InlineParts.vue](../../../../web/src/components/content/InlineParts.vue) |

`web/src/components/code/` is deleted. Verified
`test ! -e web/src/components/code` passes.

### 2.3 F05 utility registry — from plan §1.2 C4

| File | Status |
| --- | --- |
| `web/src/utils/tool-presenters/index.ts` | landed (barrel) |
| `web/src/utils/tool-presenters/types.ts` | landed; defines `ToolCallPresentation`, `ToolResultPresentation`, `InlinePart` (see §4.3 for contract status) |
| `web/src/utils/tool-presenters/registry.ts` | landed |
| `web/src/utils/tool-presenters/<per-tool>.ts` × 45 | landed |
| `web/src/utils/tool-presenters/helpers.ts`, `__default__.ts` | landed |
| `web/src/utils/json-tokenize.ts` | landed |
| `web/src/utils/tool-presenters.ts` (legacy single file) | DELETED |

### 2.4 `patterns.css` extensions — from plan §1.3 C2 row

All of these tone rules are present in
[web/src/styles/patterns.css](../../../../web/src/styles/patterns.css):

- `.status-dot-{ok,warn,danger,accent,muted}` — landed.
- `.card-{warn,danger,accent,user,purple}` — landed.
- `.pill-purple` — landed.

### 2.5 Bounded surface migration — from plan §1.3 ApiTokenEntry row

- `web/src/components/auth/ApiTokenEntry.vue` rewritten on
  `Overlay`+`Card`+`Button`; bespoke `.token-overlay/.token-dialog/.token-btn*/.token-toggle`
  selectors deleted. Landed in `05b8594`.

### 2.6 ESLint / build infrastructure

- The component-boundary gate
  [scripts/check-web-component-boundaries.cjs](../../../../scripts/check-web-component-boundaries.cjs)
  exists and runs via `npm run lint`.
- `web/package.json` `sideEffects` array includes
  `src/utils/tool-presenters/**/*.ts` and `*.css` (plan §1.3 C4
  row, F05 r3 §3.4 canonical shape).

---

## 3. Remaining deliverables (IN SCOPE for this batch)

Every row below is a binding deliverable. The implementer's
stage-plan MUST cover every row. The plan and design referenced
in the right column are the binding contract for the row's prop
bag, deletion list, and grep gate. **Nothing may be silently
descoped from this table.**

### 3.1 Conversation primitives — plan C5 (F02-owned)

| Deliverable | Path | Binding contract |
| --- | --- | --- |
| `MessageBubble.vue` (entry, role, tone variants per [02-design-r3.md §1.3](02-design-r3.md#13-primitive-catalogue) row "MessageBubble") | `web/src/components/conversation/MessageBubble.vue` | design [§1.3](02-design-r3.md#13-primitive-catalogue) row, analysis [§5.5](01-analysis-r2.md#55-messagebubble-test-contract) |
| `ThinkingDots.vue` (animated dot triplet driven by `.pulse` pattern) | `web/src/components/conversation/ThinkingDots.vue` | design [§1.3](02-design-r3.md#13-primitive-catalogue) row, analysis [§5.6](01-analysis-r2.md#56-thinkingdots-test-contract) |
| `__tests__/conversation/MessageBubble.test.ts` | `web/src/__tests__/conversation/MessageBubble.test.ts` | analysis §5.5 cases |
| `__tests__/conversation/ThinkingDots.test.ts` | `web/src/__tests__/conversation/ThinkingDots.test.ts` | analysis §5.6 cases |

### 3.2 `patterns.css` final extension rule — plan §0 step 2

| Deliverable | Path | Contract |
| --- | --- | --- |
| `.tablist > .pill[aria-pressed="true"]` rule | `web/src/styles/patterns.css` | analysis §2.2; required by C8/C10 tablist surfaces. **Not yet present at HEAD** (grep returns nothing). |

### 3.3 AppShell keydown short-circuit — plan §1.3 C6 row

| Deliverable | Path |
| --- | --- |
| AppShell global keydown handler short-circuits on `document.body.dataset.modalOpen === 'true'` | `web/src/components/layout/AppShell.vue` (the `globalKeyHandler` declared at line 158) |
| `Overlay.vue` sets/clears `document.body.dataset.modalOpen` symmetrically on mount/unmount (design §9.3) | `web/src/components/ui/Overlay.vue` (currently does NOT reference `modalOpen` — verify by grep) |

### 3.4 NavRail `.api-token-btn` chip migration — plan §1.3 C6 + C15 rows

| Deliverable | Path |
| --- | --- |
| Replace the `class="nav-link api-token-btn"` button at [web/src/components/nav/NavRail.vue:21](../../../../web/src/components/nav/NavRail.vue#L21) with `<Button icon-only>`; remove the `.api-token-btn { … }` block at line 185. | `web/src/components/nav/NavRail.vue` |
| Remaining NavRail rewrite (rest of nav-link classes, layout-only `.nav-rail` survives) | `web/src/components/nav/NavRail.vue` — see plan §2 C15 |

### 3.5 Surface rewrites — plan §2 C7–C14

The implementer MUST execute every surface rewrite in the plan
that still has bespoke selectors at HEAD. Survey results (grep on
HEAD `eb98caf`):

| Plan commit | Surface | Bespoke selectors still present (count) | Owning plan section |
| --- | --- | --- | --- |
| C7 | `web/src/components/layout/AppShell.vue` auth banner | `.auth-required-banner` family — verify; not greped above but design §6.1 demands rewrite | plan §2 C7 |
| C7 | `web/src/components/layout/WorkspaceHeader.vue` chip cluster | `.ws-chip`, `.runtime-chip`, `.pause-chip`, `.chip-dot` — verify | plan §2 C7 |
| C8 | `web/src/views/DashboardView.vue` | `.refresh-btn` (3), `.runtime-banner` (3), `.actionable-error` (1) | plan §2 C8 |
| C9 | `web/src/views/FilesView.vue` | `.files-global-banner` (1) — plus F05 routing reconciliation (see §4.4) | plan §2 C9 + F05 plan §2 C9 |
| C10 | `web/src/views/DebugView.vue` | `.debug-tab` (5), `.dg-item` (1) | plan §2 C10 |
| C11 | `web/src/components/agents/AgentConversationView.vue` non-round | `.conv-tb-btn` (2) — plus F03 round body rewrite (see F03 rebaseline) | plan §2 C11 |
| C12 | `web/src/components/agents/RawLlmExchangePanel.vue` | `.rlp-tab` (3) | plan §2 C12 |
| C13 | `web/src/components/chat/AnalystChatPanel.vue` non-chip | `.message-bubble` (2) — plus F03 round body rewrite + chip swap (see F03 rebaseline + §4.2) | plan §2 C13 |
| C14 | `web/src/components/cards/*.vue` | `.board-card` (2), `.nav-pill` (1) — verify full §4.11 list | plan §2 C14 |
| C15 | `web/src/components/nav/NavRail.vue` | `.api-token-btn` (1) — see §3.4 | plan §2 C15 |

Every selector in the plan's analysis §4.1–§4.11 deletion matrix
MUST be removed in the same commit that introduces its
replacement. The grep gates in plan §2 for each commit are
authoritative.

### 3.6 Selector-migration tests — plan §1.3 test rows

Update each surface test listed in plan §1.3 to assert
`data-testid="..."` queries instead of bespoke class selectors.
The list of test files is plan analysis §5.2 row by row; no
shortcut is permitted.

---

## 4. Reconciliation deliverables (replace shipped-with-wrong-shape; no alias period)

These items shipped on 2026-05-26 but with a contract that
conflicts with the F02 r3 design. Each must be REPLACED in-place
(not aliased, not wrapped). The same commit that lands the
correct contract MUST delete the legacy contract.

### 4.1 `Overlay.vue` `data-modal-open` flag (design §9.3)

`Overlay.vue` currently does NOT set or clear
`document.body.dataset.modalOpen`. The design contract requires
symmetric set/clear via a module-level open counter so nested
overlays compose. Implementer:

1. Add the open-counter and the body-flag set/clear in
   `onMounted` / `onUnmounted` (or `watchEffect`, per design
   §9.3) inside `web/src/components/ui/Overlay.vue`.
2. Pair this with the AppShell short-circuit in §3.3 in the
   **same commit** (plan C6); the full-suite gate (k) (`<= 2`
   readers of `data-modal-open`) is the regression detector.

### 4.2 `ToolChip.vue` prop bag — eight-prop contract (design §1.3 + F03 r3 §3.2 + F04 r2 §4.1)

`web/src/components/conversation/ToolChip.vue` currently exposes
four props (`presentation`, `expanded`, `variant`, `labelPrefix`)
on the F05-legacy `ToolCallPresentation | ToolResultPresentation`
shape. The binding cross-batch contract (design §1.3 ToolChip
row, F03 r3 §3.2, F04 r2 §4.1) is the eight-prop bag:

```
{
  call:           ToolCallPresentation;
  result:         ToolResultPresentation | null;
  callContent:    string;
  resultContent:  string | null;
  status:         'pending' | 'ok' | 'error';
  expanded:       boolean;
  detailsId:      string;
  timestamp?:     string;
}
```

Implementer:

1. Rewrite `web/src/components/conversation/ToolChip.vue` to take
   the eight-prop bag. Emits ONLY `(event: 'toggle'): void`.
2. Delete the four-prop signature in the same commit. No
   `@deprecated` re-export, no shim component.
3. Update every existing consumer of the old API in the same
   commit. Consumers at HEAD `eb98caf`:
   - `web/src/components/agents/AgentConversationView.vue` —
     migrate per design §1.6 (raw `callContent` / `resultContent`
     from the `ToolPair` view-model).
   - `web/src/components/chat/AnalystChatPanel.vue` — migrate
     via `v-bind="adaptChatMessageToToolChip(call, result, expanded)"`
     (the adapter is §4.4 below).
4. The selector-migration test rewrites for both surfaces
   (plan analysis §5.2 rows for `analyst-chat-panel.test.ts` and
   `agents-view.test.ts`) land in the same commit.

### 4.3 `tool-presenters/types.ts` cleanup

Once §4.2 lands, `ToolCallPresentation` / `ToolResultPresentation`
are still used by the per-tool presenter modules (legitimate) but
NOT by the chip. Verify the type file does not still export a
`FormattedToolPair` or `presentation` legacy union; if such an
export survives, delete it in the §4.2 commit per design §1.6 +
F05 r3 §4 ("no `formatToolPair`, no shared pair state").

### 4.4 `chat/tool-chip-adapter.ts` (plan C5; F04 r2 §4.1)

Add `web/src/components/chat/tool-chip-adapter.ts` exporting
`adaptChatMessageToToolChip(call, result, expanded)` and
`adaptPendingInvocationToToolChip(call, expanded)`. The return
type is the eight-prop bag. Compile-time test
`web/src/__tests__/components/chat/tool-chip-adapter.test.ts`
enforces the bag exactly.

### 4.5 `chat/analyst-timeline.ts` (plan C5; F03 r3 §3.4)

Add the pairing utility per F03 r3 §3.4. The unit owns
ToolUseId-based call/result pairing for the analyst surface.
Tests in `web/src/__tests__/components/chat/analyst-timeline.test.ts`.

Note: the conversation round composites (`RoundCard`,
`DiagnosticRow`, `PendingCallFooter`, `CompactedCluster`,
`ContextBlock`) are F03 deliverables and tracked in the F03
rebaseline document, not here. They are listed in plan §1.1 for
context because they share the C5 commit boundary, but ownership
sits with F03.

### 4.6 FilesView `?root=meta|output&path=…` routing

Owned by F05 plan §2 C9, tracked in the F05 rebaseline document.
The plan C9 row for `FilesView.vue` in F02's table (§3.5 above)
covers the bespoke-selector deletion only; the routing change is
F05's. Both land in the same commit (plan C9).

---

## 5. Nothing-lost invariant (binding)

The harness MUST:

1. Read this rebaseline plus [02-design-r3.md](02-design-r3.md)
   and [03-plan-r2.md](03-plan-r2.md).
2. Produce a stage-plan whose ordered stages, taken together,
   cover **every** row in §3 and §4. No row may be silently
   dropped, narrowed, merged into "primitive only", or marked
   "future work".
3. If any row's precondition has shifted at the harness's HEAD
   (e.g. another agent landed a partial substitute), the harness
   MUST file a delta proposal naming the exact row and the
   conflict, OR reject the batch via `<basename>.decision.md`
   listing every row that would be lost. Implementing a subset
   and archiving to `done/` is forbidden per the mailbox
   classification objective in
   [.saivage/config.json](../../../../.saivage/config.json).
4. The plan's per-commit grep gates (plan §2) and full-suite
   gates (plan §3) are the acceptance criteria.

The order between stages is the plan's C1–C15 order, restricted
to the C-numbers that contain remaining rows from §3 + §4 (C1–C4
are already done; C5 onwards are in-scope except for parts of C6
that are done).

---

## 6. Stage-mapping suggestion (non-binding shape; harness MAY follow)

A reasonable decomposition the harness MAY use; it is not the
contract. The contract is §3 + §4 and the original plan §2
sequence.

- Stage S1 — Cross-batch chip + primitives + adapters
  (plan C5 + §3.3 AppShell+Overlay + §4.1 + §4.2 + §4.3 + §4.4 +
  §4.5 + §3.4 NavRail single line, all in one commit per plan
  §1.6). Tests in §3.1.
- Stage S2 — AppShell auth banner + WorkspaceHeader (plan C7).
- Stage S3 — DashboardView (plan C8).
- Stage S4 — FilesView (plan C9; F02 deletes bespoke; F05
  delivers `?root=` routing, see F05 rebaseline §3).
- Stage S5 — DebugView (plan C10).
- Stage S6 — AgentConversationView non-round (plan C11).
- Stage S7 — RawLlmExchangePanel (plan C12).
- Stage S8 — AnalystChatPanel non-chip (plan C13).
- Stage S9 — Cards (plan C14).
- Stage S10 — NavRail full rewrite (plan C15).

After Stage S10: full-suite gates per plan §3. Open PR.

If the harness chooses a different decomposition, it MUST still
honour every row in §3 + §4 and every grep gate in plan §2.
