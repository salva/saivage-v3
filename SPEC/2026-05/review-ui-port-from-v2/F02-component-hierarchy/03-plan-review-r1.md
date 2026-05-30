# F02 Component Hierarchy Implementation Plan Review - Round 1

Review target: [03-plan-r1.md](03-plan-r1.md)
Approved design: [02-design-r3.md](02-design-r3.md)
Approved analysis: [01-analysis-r2.md](01-analysis-r2.md)
Additional sibling-contract check: [F05 design r3](../F05-tool-detail-rendering/02-design-r3.md)

## Findings

### Blocking 1 - C4 uses the wrong `sideEffects` glob and its verification would not catch it

The plan's C4 file list and verification say `web/package.json` should add:

```json
"sideEffects": ["./web/src/utils/tool-presenters/**"]
```

That contradicts the approved F05 r3 contract. F05 r3 §3.4 standardises the package-relative `web/package.json` entry as:

```json
"sideEffects": [
  "src/utils/tool-presenters/**/*.ts",
  "*.css"
]
```

Because `web/package.json` is already inside the `web/` package, the `./web/src/...` form is not the canonical package-relative path. More importantly, C4's verification only greps for the existence of a `sideEffects` key, so the wrong path would pass the F02 plan while violating the F05 initialization/tree-shaking contract.

Required change: update every C4 mention of the `sideEffects` entry to `src/utils/tool-presenters/**/*.ts`, preserve any existing CSS side-effect entry, and make the C4 gate assert the exact canonical path rather than only the key.

### Blocking 2 - C4 contains a non-runnable `rg` gate

C4's import-shape grep uses a negative lookahead with default ripgrep:

```bash
! rg -n "from\s+['\"].*utils/tool-presenters['\"](?!/)" web/src 2>/dev/null \
  | rg -v "from ['\"]\.\./\.\./utils/tool-presenters['\"]" \
  | tee /tmp/f02-c4-leaks.txt
```

Default `rg` does not support lookaround without `-P`, and the `! ... | ... | tee ...` pipeline shape makes the exit status easy to misread or mask. As written, the C4 verification is not a reliable green gate for an implementer.

Required change: replace this with a portable check. For example, use separate positive/negative `rg` checks without lookaround, or explicitly use `rg -P` if PCRE2 is required. Also move the temporary outputs from `/tmp/...` to workspace-local `tmp/...`, matching the workspace operating rule. The same `/tmp` cleanup applies to the C2 and final validation leak files.

### Blocking 3 - C6 verification expects an AppShell change that C6 does not own

C6's verification requires `AppShell.vue` to short-circuit global shortcuts on `document.body.dataset.modalOpen`, but C6's modified-file list only includes `ApiTokenEntry.vue`, the `.api-token-btn` line in `NavRail.vue`, and the API-token test. The consolidated modified-file table assigns `AppShell.vue` to C7, and C2 introduces `Overlay.vue` without listing an `AppShell.vue` edit.

That leaves the commit sequence ambiguous: either C6 cannot pass its own grep gate, or an implementation must modify a file that C6 does not claim to own.

Required change: assign the AppShell modal-shortcut suppression to one explicit commit and keep the verification there. The most natural landing point is C6, when `Overlay` first becomes a real auth-dialog dependency; C7 can then stay focused on the auth banner and workspace-header visual rewrite.

### Blocking 4 - rollback notes overstate per-commit independence after overlapping edits

The rollback section is good on the no-alias principle, and it correctly calls out the C4/C5 dependency. It is not yet accurate for later overlapping commits:

- C5 and C11 both touch `AgentConversationView.vue`.
- C5 and C13 both touch `AnalystChatPanel.vue` / related tests.
- C6 and C15 both touch `NavRail.vue`.
- If Blocking 3 is resolved by moving AppShell shortcut suppression into C6, C6 and C7 both touch `AppShell.vue`.

Because of those overlaps, the blanket statement that C6-C15 are each independently safe and idempotent to `git revert` is too strong. Reverting an earlier overlapping commit after a later surface rewrite has landed can conflict or restore stale selectors into a post-migration file.

Required change: add dependency-aware rollback notes. For example, if C13 has landed, revert C13 before reverting C5's chip swap; if C11 has landed, revert C11 before reverting the AgentConversationView portion of C5; if C15 has landed, revert C15 before reverting C6's NavRail token-button rewrite. This still preserves the required no-alias rollback model: dependent commits are reverted atomically, not shimmed.

## Coverage Check

- **Implementability:** close, but blocked by the wrong F05 `sideEffects` path, the non-runnable C4 grep, and the C6 ownership mismatch.
- **Commit ordering:** the plan preserves the approved 15-commit C1-C15 shape. C5 is large but matches the approved cross-batch boundary.
- **Per-commit verification:** broad coverage is present, including typecheck, lint, tests, and grep gates, but C4 and C6 need the fixes above before the gates are executable and meaningful.
- **No alias period:** satisfied in intent. C3 deletes `components/code/`, C4 deletes the single-file presenter, C5 deletes the inline chip renderer, and later surface commits delete selectors in the same commit as replacement usage.
- **Validation:** final suite coverage plus manual Saivage deployment smoke is sufficient once the exact `sideEffects` and grep-gate fixes land.
- **Rollback:** the strategy is architecturally right (`git revert`, no flags/shims), but needs the dependency ordering described above.
- **Cross-issue coordination:** F01-first is explicit in preconditions. F05's C4 presenter directory must use F05 r3's canonical side-effect path. F03's chip swap is safe only at the C5 atomic boundary: if C5 is split internally on a branch, `ToolChip.vue` must land before any swap commit and the landing history must still avoid an alias period.

## Recommendation

Request changes for the four narrow blockers above. Once they are corrected, the plan should be approvable: the architecture follows the approved analysis/design, the 15-commit sequence is sensible, and the no-backward-compatibility rule is preserved.

VERDICT: CHANGES_REQUESTED