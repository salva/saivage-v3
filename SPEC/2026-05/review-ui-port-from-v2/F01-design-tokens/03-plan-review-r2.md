# F01 -- Design tokens & semantic CSS layer -- Plan review (r2)

Reviewed:

- New plan: `03-plan-r2.md`
- Previous critique: `03-plan-review-r1.md`
- Previous draft: `03-plan-r1.md`
- Approved design: `02-design-r2.md`

## Blocking findings

None.

## R1 review coverage

1. Package-manager correction is addressed.

   The r1 review required replacing executable `pnpm -C web ...` commands with the repo-native npm form and correcting the bootstrap precondition. The r2 plan now states that the root and `web/` packages use npm, verifies both `package-lock.json` files, verifies absence of both `pnpm-lock.yaml` files, and uses:

   ```bash
   npm --prefix web run typecheck
   npm --prefix web run test
   npm --prefix web run build
   ```

   in the preconditions, numbered execution steps, and final validation suite. Step 15 also uses `npm --prefix web run dev` for the optional dev server path. I verified the repository facts directly: root `package-lock.json` and `web/package-lock.json` exist; root and web `pnpm-lock.yaml` do not. The remaining `pnpm` mentions in r2 are non-executable historical references in the coverage table or explicit negative lockfile checks.

2. Visual diff matrix coverage is addressed.

   The r1 review required adding all omitted hex-bearing, visually affected surfaces with per-surface checks. The r2 matrix adds rows 17-25 for every missing file named in the critique:

   - `web/src/components/layout/WorkspaceHeader.vue`
   - `web/src/components/agents/RawLlmExchangePanel.vue`
   - `web/src/components/chat/AnalystToaster.vue`
   - `web/src/views/CardsView.vue`
   - `web/src/components/cards/CardsLeaderboardView.vue`
   - `web/src/components/cards/CardsTreeView.vue`
   - `web/src/components/cards/CardHistoryPanel.vue`
   - `web/src/components/cards/StaleWarningRibbon.vue`
   - `web/src/views/NotFound.vue`

   Each new row has a concrete visual check tied to the relevant semantic vars, not just a filename. Row 26 also adds a cross-surface check for inline `:style` bindings, which strengthens the original matrix rather than merely satisfying the minimum requirement.

## Confirmations

- The single atomic F01 commit boundary remains intact: one commit covers the style files, `main.ts` import order, all hex-to-var rewrites, and any snapshot re-baseline.
- The no-backward-compatibility constraint remains intact: r2 still forbids `--legacy-*` mirrors, `var(--x, #fallback)` shims, deprecated re-exports, dual visual systems, and global `.tool-chip*` patterns.
- The edit ordering remains consistent with the approved design and r1 confirmation: add style layer, import it in `main.ts`, mechanically rewrite hex literals, then run grep/typecheck/test/build gates.
- The rollback story remains realistic: one `git revert <F01-sha>` restores the previous `main.ts`, removes `web/src/styles/`, and restores pre-F01 scoped hex blocks.

**Absolute path of this review:** `/home/salva/g/ml/saivage-v3/SPEC/2026-05/review-ui-port-from-v2/F01-design-tokens/03-plan-review-r2.md`

VERDICT: APPROVED