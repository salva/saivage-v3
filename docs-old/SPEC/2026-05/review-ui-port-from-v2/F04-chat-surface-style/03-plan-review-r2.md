# F04 - Chat / analyst surface style - Plan review (r2)

Reviewer round 2 for [03-plan-r2.md](03-plan-r2.md), checked
against the binding r1 critique [03-plan-review-r1.md](03-plan-review-r1.md),
the prior draft [03-plan-r1.md](03-plan-r1.md), and the approved
design [02-design-r2.md](02-design-r2.md).

## Findings

No blocking findings. No required changes remain open.

## Verification

- The r1 blocker is resolved. r2 adds an authoritative rename table
  and applies it consistently across the child-SFC instructions,
  container deletion checklist, test selector guidance, per-batch
  commands, and final merge gates: `.chat-composer` ->
  `.composer-form`, `.composer-input` -> `.composer-textarea`,
  `.pending-tool-list` -> `.pending-invocations`, and
  `.message-badges` -> `.badge-stack`.
- The no-alias contract is now internally consistent. The forbidden
  family regex includes the full design r2 deletion list, including
  `chat-composer`, and the final gate scans the whole
  `web/src/components/chat/` subtree. r2 also makes clear that these
  are replacements, not compatibility aliases, and that old selectors
  are deleted in the same commit as the new surface.
- The stable `data-testid="pending-tool-list"` is intentionally
  preserved while the CSS class is renamed to `.pending-invocations`.
  That preserves the design/test surface without violating the
  forbidden CSS-selector contract.
- Design r2's B1/B2/B3/C1/P1/P2/P3/P4 requirements are all covered:
  local `thinking` derivation remains outside the store, model pills
  gate on `modelLabel`, pending-footer resize emits `0` on empty and
  element cleanup, `.on-screen-children` keeps both class and testid,
  `ChatHeader` has no `unauthorized` prop, the debounced connection
  composable accepts readonly refs, the eight-prop adapter contract is
  guarded, and Proposal B remains documentation-only.
- The implementation order remains sound: type surface, consumer
  verification, leaf composables, pure utility, child SFCs, container
  rewrite, tests, then cross-issue verification. No batch requires a
  sibling component before it exists, and the PR is still treated as a
  single architecture-first unit rather than a set of independently
  mergeable aliases.
- The test plan now includes the selector-hygiene expectations that
  were missing in r1, while retaining the approved design coverage for
  chat panel behavior, store fixtures, on-screen children, jump pill,
  pending-footer resizing, adapter content, composables, timeline
  pairing, and model-label gating.
- Cross-issue dependencies are still correctly enforced as gates
  instead of patched around locally: F02 primitives, F03 `ToolChip` /
  adapter / timeline contracts, and F05 formatted-content rendering
  must already be present at HEAD before F04 proceeds.
- Validation and rollout gates are adequate for this plan: typecheck,
  lint, full tests, build, Vue SFC corruption checks, forbidden hex /
  selector scans, cross-issue contract checks, deployment health, and
  manual analyst-chat behavior checks.

The remaining risk is execution risk only: the implementer must apply
the r2 rename overlay rather than copying design r2's older class names
verbatim. r2 calls this out repeatedly and gives merge gates that would
catch the mistake, so it is no longer a plan defect.

VERDICT: APPROVED