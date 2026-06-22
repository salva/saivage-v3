# F01 — Design tokens & semantic CSS layer — Design review (r1)

Reviewer verdict: close, but one cross-issue contract problem is blocking.

The design does the important F01 work well: it gives two real proposals, includes concrete `tokens.css` and `semantic.css` skeletons, cites the v2 `base.css` / `patterns.css` surface, commits to a single-batch no-alias landing, and has useful grep gates plus typecheck/test/build/visual validation. Proposal B is also a substantive one-level-up alternative, not filler, and the recommendation for Proposal A is justified by lower indirection and direct v2 parity.

## Blocking findings

1. **F02 pattern ownership is inverted in the F01 recommendation.**

   `02-design-r1.md` repeatedly says F02 will introduce the v3-only `.tool-chip*` family / aliases and that F01 should remain a verbatim v2 `patterns.css` port. That does not match F02 r2. F02 r2 says the only global pattern extensions that must land in F01 are:

   ```css
   .status-dot-ok { background: var(--accent); }
   .status-dot-warn { background: var(--warn); }
   .status-dot-danger { background: var(--danger); }
   .status-dot-accent { background: var(--accent-2); }
   .status-dot-muted { background: var(--text-muted); }

   .card-warn { border-color: var(--entry-warn-border); background: var(--entry-warn-bg); }
   .card-danger { border-color: var(--entry-danger-border); background: var(--entry-danger-bg); }
   .card-accent { border-color: var(--entry-accent-border); background: var(--entry-accent-bg); }
   .card-user { border-color: var(--entry-user-border); background: var(--entry-user-bg); }
   .card-purple { border-color: var(--entry-purple-border); background: var(--entry-purple-bg); }

   .pill-purple { border-color: var(--entry-purple-border); color: var(--purple); }
   ```

   F02 r2 also explicitly rejects global `tool-chip`, `tool-chip-row`, `tool-chip-call`, `tool-chip-ok`, `tool-chip-error`, `tool-chip-pending`, and `tool-chip-details` pattern classes. ToolChip is a conversation composite whose visuals come from `Card`, `Pill`, `Button`, tone classes, and scoped internal layout.

   Required correction: update Proposal A from "v2 `patterns.css` verbatim" to "v2 `patterns.css` plus the F02-approved tone extensions above". Then update A.1, A.2.4, A.3, A.4, A.6, and the recommendation to reflect that F01 owns those extensions. Add grep gates such as:

   ```bash
   grep -E '^\.(status-dot-(ok|warn|danger|accent|muted)|card-(warn|danger|accent|user|purple)|pill-purple)\b' web/src/styles/patterns.css
   grep -rEn '\.tool-chip|tool-chip-' web/src/styles
   ```

   The first gate should show the required tone classes; the second should show no global style-layer tool-chip classes.

2. **The F03/F04/F05 chip styling narrative needs to be aligned with the shared ToolChip contract.**

   The design says F05 tool chips read semantic vars for variants that F02 will introduce as class selectors. F04 r2 explicitly says there is no `.tool-chip-pending` global pattern and no second chip implementation; F05 r2 defines chip markup with a non-button group, one expand button, inline parts, and local chip classes; F03 consumes the same presenter-backed ToolChip path. F01 should frame its role as providing semantic vars plus the primitive pattern tones that ToolChip composes through `Card` / `Pill` / `Button`, not as pre-authorizing a global chip pattern family.

   Required correction: remove the `.tool-chip*` language from A.6 and the recommendation. If Proposal B remains in the document, make clear that its `--tool-chip-*` recipe idea is rejected partly because it cuts across the F02/F04/F05 decision to keep ToolChip styling component-scoped and primitive-composed.

## Non-blocking notes

- The token and semantic var lists match the approved analysis closely enough. The direct `rgba(255, 255, 255, 0.06)` and `rgba(0, 0, 0, 0.55)` values in `semantic.css` are acceptable under the current "zero hex outside tokens" rule, though the prose should stop saying every `rgba()` is "over a token".
- The validation matrix is good. A Playwright-backed screenshot diff command would make the visual matrix stronger, but the current manual matrix is sufficient for F01 design approval once the cross-issue contract is fixed.
- The markdown relative links to `web/src` and sibling `saivage/web/src/styles` appear to be off from the F01 directory. Not a design blocker, but fixing them would make the spec easier to use.

## Required changes

1. Add the F02-required `.status-dot-*`, `.card-*`, and `.pill-purple` extensions to the chosen Proposal A `patterns.css` skeleton, implementation steps, and grep gates; stop describing F01 as a purely verbatim `patterns.css` copy.
2. Remove the claim that F02 introduces global `.tool-chip*` patterns, and rewrite the F03/F04/F05 cross-issue section around the shared ToolChip composite using F01 semantic vars and primitive tone classes.

VERDICT: CHANGES_REQUESTED