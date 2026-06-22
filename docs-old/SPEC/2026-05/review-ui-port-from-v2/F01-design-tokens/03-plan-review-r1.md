# F01 — Design tokens & semantic CSS layer — Plan review (r1)

Reviewed:

- New plan: `03-plan-r1.md`
- Approved design: `02-design-r2.md`
- Approved analysis: `01-analysis-r2.md`
- Cross-issue plans: F02/F03/F04/F05 `03-plan-r1.md`

## Blocking findings

1. Validation commands use the wrong package manager for this repo.

   The plan's preconditions and validation steps repeatedly use `pnpm -C web typecheck`, `pnpm -C web test`, and `pnpm -C web build`. The actual repo is npm-based: root and web `package.json` declare npm engines, and the checked-in lockfiles are `package-lock.json` and `web/package-lock.json`. The sibling plans also use npm / npx forms.

   This makes the plan not directly implementable and weakens the validation gate. Replace every pnpm command and the "pnpm workspace is bootstrapped" precondition with the repo-native commands, for example:

   ```bash
   npm --prefix web run typecheck
   npm --prefix web run test
   npm --prefix web run build
   ```

   Equivalent `cd web && npm run ...` commands are also fine, but the plan should be consistent and executable as written.

2. The visual diff matrix does not list every affected surface.

   The plan scopes F01 to every hex-bearing `.vue` file under `web/src`, but the matrix omits several files that currently contain raw hex and will therefore be edited by Step 9. The missing affected surfaces include:

   - `web/src/components/layout/WorkspaceHeader.vue`
   - `web/src/components/agents/RawLlmExchangePanel.vue`
   - `web/src/components/chat/AnalystToaster.vue`
   - `web/src/views/CardsView.vue`
   - `web/src/components/cards/CardsLeaderboardView.vue`
   - `web/src/components/cards/CardsTreeView.vue`
   - `web/src/components/cards/CardHistoryPanel.vue`
   - `web/src/components/cards/StaleWarningRibbon.vue`
   - `web/src/views/NotFound.vue`

   Add explicit rows, or clearly grouped rows that name each file, with per-surface visual checks. This is required by the review criterion that the matrix list every affected surface; otherwise an implementer can finish the mechanical grep gate while leaving user-visible color regressions unreviewed.

## Confirmations

- The edit ordering is otherwise sound: add the style layer, import it in `main.ts`, then mechanically replace raw hex values using the approved analysis mapping, then run grep/typecheck/test/build gates.
- The F01 commit boundary matches the approved design: one atomic F01 batch, no intermediate commits, no staging branch, and no F02/F03/F04/F05 template or composite work.
- Rollback is realistic once the validation-command issue is fixed: a single `git revert <F01-sha>` removes `web/src/styles/`, restores the previous `main.ts` import, and restores the pre-F01 scoped styles.
- No backward-compatibility leak is present in the F01 plan itself: no `--legacy-*`, no `var(--x, #fallback)`, no shims, no dual visual system, and no global `.tool-chip*` family.
- Cross-issue ordering is consistent at the F01 level: F01 is the first foundation batch, and the sibling plans consume it later. The F02 plan has its own fallback language around style extensions, but F01's closed extension set follows the approved F01 design and should remain single-batch.

VERDICT: CHANGES_REQUESTED
