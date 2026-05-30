# F02 Component Hierarchy Implementation Plan Review - Round 2

Review target: [03-plan-r2.md](03-plan-r2.md)
Previous critique: [03-plan-review-r1.md](03-plan-review-r1.md)
Previous draft: [03-plan-r1.md](03-plan-r1.md)
Approved design: [02-design-r3.md](02-design-r3.md)
Additional binding sibling-contract check: [F05 design r3](../F05-tool-detail-rendering/02-design-r3.md)

## Findings

No blocking findings.

The r2 plan addresses every required item from the r1 review while preserving the approved 15-commit sequence, the architecture-first/no-backward-compatibility rule, the C4/C5 cross-issue boundaries, and the no-barrel rule for `components/ui`, `components/content`, and `components/conversation`.

## Required Item Verification

### Blocking 1 - C4 `sideEffects` path and verification

Addressed.

r2 replaces the incorrect `./web/src/utils/tool-presenters/**` form with the F05 r3 canonical package-relative entries:

```json
[
  "src/utils/tool-presenters/**/*.ts",
  "*.css"
]
```

The C4 plan now uses a Node-based assertion that `sideEffects` is an array, requires both canonical entries, rejects legacy `./web/...` paths, and repeats the regression check in final validation §3(i). The plan also preserves pre-existing side-effect entries instead of forcing destructive equality, which is the right behavior for a base branch that may already carry other required entries.

### Blocking 2 - Non-runnable `rg` gate and temp-file location

Addressed.

r2 removes the default-`rg` negative-lookahead gate and replaces it with portable positive collection plus negative filtering under `tmp/f02-c4-import-lines.txt` and `tmp/f02-c4-leaks.txt`. The C2 lucide check and final style-leak check also use workspace-local `tmp/` paths. The only intentional PCRE use is explicitly marked with `rg -P` in final validation §3(f), so the gate is now executable rather than accidentally relying on unsupported lookaround.

### Blocking 3 - C6 ownership of AppShell shortcut suppression

Addressed.

r2 moves the `document.body.dataset.modalOpen === 'true'` short-circuit into C6, the first commit where `Overlay` becomes a real auth-dialog dependency through `ApiTokenEntry.vue`. The modified-file table, C6 narrative, C6 grep gate, C7 scope note, C7 regression check, and quick-reference checklist all agree on this ordering. C7 is reduced to the auth-banner and `WorkspaceHeader` chip-cluster rewrite.

### Blocking 4 - Dependency-aware rollback ordering

Addressed.

r2 replaces the overly broad independent-revert language with a dependency-aware rollback table. The table explicitly covers the overlapping chains from the r1 critique:

- C4 must be reverted after C5 if C5 has landed.
- C5 must be reverted after C13 and/or C11 if those later rewrites have landed.
- C6 must be reverted after C15 and/or C7 if those later rewrites have landed.
- C7, C11, C13, and C15 are safe in the forward direction, with reverse dependencies called out from the earlier commit rows.

The rollback model remains aligned with the project guideline: dependent commits are reverted, then re-landed forward; no flags, shims, aliases, or transitional compatibility paths are introduced.

## Coverage Check

- **Approved design coverage:** r2 preserves Proposal A's three-layer split, explicit per-file imports, test reorganization, component-folder no-barrel policy, and commit-bound deletion matrix from the approved design. The plan follows the newer F05 r3 package-relative `sideEffects` contract where the older F02 design prose was superseded by sibling-contract review.
- **Cross-issue ordering:** C4 still lands the F05-owned presenter directory, content renderers, JSON tokenizer, and single-file-presenter deletion before C5. C5 remains the atomic shared-chip boundary with the F03/F04 adapter and selector migration.
- **No alias period:** C3, C4, C5, and C6-C15 all continue to delete old files/selectors in the same commit as their replacements. r2 does not add compatibility shims or deprecated re-exports.
- **Per-commit gates:** typecheck, lint, tests, and grep gates remain present on every commit. The r2 fixes make the formerly weak C4 and C6 gates meaningful.
- **Final validation:** the full-suite gates include typecheck, lint, test, build, class-assertion checks, style-leak reporting under `tmp/`, single ToolChip renderer, no component-folder barrels, canonical presenter directory checks, and `data-modal-open` single-source checks. Manual Saivage v3 deployment smoke is correctly recorded as PR-description validation rather than a CI gate.
- **Out-of-scope boundaries:** r2 retains the inherited out-of-scope list and quick-reference checklist, updated for C4/C6/C7. It does not smuggle in F04 decomposition, form controls, headless UI adoption, Storybook, or store/router/WebSocket changes.

## Residual Risk

The remaining risks are implementation risks already captured by the plan: C5 is large, C4 depends on F05 presenter-directory discipline, and the manual smoke pass must still be recorded after the branch is built. None of these require another plan revision.

## Recommendation

Approve r2. It is implementable, ordered, and consistent with the binding critique and approved design direction.

VERDICT: APPROVED