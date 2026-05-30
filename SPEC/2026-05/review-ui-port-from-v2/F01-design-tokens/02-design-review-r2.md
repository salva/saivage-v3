# F01 — Design tokens & semantic CSS layer — Design review (r2)

Reviewer verdict: approved.

I reviewed the r2 design against the r1 critique, the previous r1 draft, and the approved r2 analysis. The r1 blocking findings are addressed.

## Required-change verification

1. **F02 pattern ownership is corrected.** Proposal A no longer describes `patterns.css` as a purely verbatim v2 copy. It now defines `patterns.css` as v2 Block 1 plus a closed F02 tone-extension Block 2, with the required `.status-dot-{ok,warn,danger,accent,muted}`, `.card-{warn,danger,accent,user,purple}`, and `.pill-purple` selectors present in the skeleton. The implementation steps also require appending the extension block rather than using `cp` as the complete operation.

2. **The positive and negative grep gates are present.** The validation matrix now requires 11 matches for the F02 tone extensions and zero matches for global `.tool-chip*` selectors in `web/src/styles`. It also adds the broader negative gate for `.msg-*`, `.role-*`, `.kind-*`, `.btn-sm`, `.thinking-dots`, `.pill-active`, and `.panel-heading-h1` selectors.

3. **The F03/F04/F05 chip contract is reframed correctly.** The cross-issue section now treats `ToolChip` as the shared conversation composite owned by F02 and consumed by F03/F04/F05. F01's role is limited to semantic vars plus primitive tone classes composed through `.card`, `.card-{accent,danger,warn}`, `.pill-*`, `.btn`, and `.status-dot-*`. The previous r1 claim that F02 would introduce a global `.tool-chip*` pattern family is removed.

4. **Proposal B no longer keeps a chip recipe contract.** The old `--tool-chip-*` recipe block is removed, and the new B.7 section explicitly rejects global chip recipes because they cut across the F02/F04/F05 shared-ToolChip decision. The recommendation uses that as evidence for choosing Proposal A.

5. **The non-blocking r1 notes are handled well enough for approval.** The semantic `rgba()` prose is corrected, an optional Playwright screenshot baseline is added without making it a design blocker, and the markdown links are re-rooted from the F01 directory.

## Non-blocking note

- If Proposal B is ever revived, its B-only `grep -E 'tool-chip' web/src/styles/recipes.css` gate should either ignore comments or match only declarations/selectors, because the proposed `recipes.css` comment intentionally says there is no `--tool-chip-*` recipe family. This does not block r2 because Proposal A is the selected design and its required style-layer gate is correct.

VERDICT: APPROVED