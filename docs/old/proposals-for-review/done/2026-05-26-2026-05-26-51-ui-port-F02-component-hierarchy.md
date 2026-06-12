# Design: F02 — hierarchical UI component layering (ui / content / conversation)

Second of five linked proposals. Requires `2026-05-26-50-ui-port-F01-design-tokens.md` to be merged first.

The canonical documents live under `SPEC/2026-05/review-ui-port-from-v2/F02-component-hierarchy/`. This file is the mailbox entry.

## Problem

v3 components duplicate scoped-style CSS for the same visual primitives (buttons, pills, cards, chips, code blocks, markdown text). The chat and agent surfaces independently re-implement message bubbles, tool chips, and JSON renderers. Without a primitives library, F03/F04/F05 would each ship their own variants and the codebase would drift further.

## Decision

Implement [F02 02-design-r3.md](../SPEC/2026-05/review-ui-port-from-v2/F02-component-hierarchy/02-design-r3.md), which is the converged, reviewer-approved design. Read [01-analysis-r2.md](../SPEC/2026-05/review-ui-port-from-v2/F02-component-hierarchy/01-analysis-r2.md) for the deletion matrix and [03-plan-r2.md](../SPEC/2026-05/review-ui-port-from-v2/F02-component-hierarchy/03-plan-r2.md) for the 15-commit landing sequence with per-commit grep gates.

Binding contract:

- Three-layer split: `web/src/components/ui/`, `web/src/components/content/`, `web/src/components/conversation/`.
- 14 primitive components: `Button`, `Pill`, `Card`, `PanelHeading`, `StatusDot`, `Overlay`, `Spinner`, `CodeBlock`, `MarkdownText`, `JsonView`, `FormattedContent`, `MessageBubble`, `ToolChip`, `ThinkingDots`. Prop interfaces are specified verbatim in §1.3 / §3 of the design.
- `ToolChip` lives in `components/conversation/`. Its prop bag is the canonical 8-prop contract referenced by F03/F04/F05.
- Composition rules enforced by `no-restricted-imports` per directory + a forbidden-property allowlist for surviving scoped styles (§1.2 / §1.9).
- 15 commits, each pairing a primitive introduction with deletion of the bespoke-selector implementations it replaces. **No alias period** — old + new must never coexist at any commit boundary.
- F02 also adds 9 `patterns.css` rules listed in §4 (the only F02 → F01 contribution; safe to add in this batch because F01 is already merged).

## Files to change

Plan is authoritative. High-level: ~14 new primitive `.vue` files, ~15 modified surface components, ~1,260 LOC of new tests in `web/src/__tests__/{ui,content,conversation}/`, ESLint config updated.

## Files / tests / docs to delete

Per the deletion matrix in the analysis: bespoke scoped-style blocks in surface components (e.g., `AnalystChatPanel`, `AgentConversationView`, `DashboardView`, `CardDetailView`, …). Tests that assert against bespoke class selectors are rewritten in the same commit they're invalidated.

## Validation gate

For EACH of the 15 commits:

1. `pnpm -C web typecheck`
2. `pnpm -C web test`
3. `pnpm -C web build`
4. The per-commit grep gate specified in §1.4 of the design (e.g., after commit N introduces `Button` and removes `.primary-btn`, `grep -rn '\.primary-btn' web/src` must be empty).

After the full batch, also:

- ESLint with the new `no-restricted-imports` rule passes.
- The forbidden-property allowlist gate passes.
- Playwright MCP smoke against `http://127.0.0.1:8090` for every surface in the visual matrix.

## Risks / accepted residuals

- A 15-commit batch is large. Each commit is independently validated, so partial rollback is single-commit-revert.
- The new ESLint rule may flag legitimate cross-layer imports during the migration; treat any such case as a commit-ordering bug, not as a rule weakening.

## Out of scope

- Conversation round timeline (F03).
- Chat surface decomposition (F04).
- Tool presenter registry (F05).
- AnalystChatPanel ToolChip swap (owned by F03's batch, not F02).

## Architecture rule

`ARCHITECTURE-FIRST, NO BACKWARD COMPATIBILITY`. No alias period between commits. No barrel `index.ts` re-exports of removed components.
