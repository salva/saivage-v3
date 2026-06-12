## Analysis review

1. The stale-reference and audit-scope asks from [01-analysis-review-r3.md](./01-analysis-review-r3.md) are mostly addressed, but Appendix A is still not mechanically correct. The current recipe sets `card.version_seq = 99` and appends a history row with `version_seq = 98`; current `reconcileCardHistory` only drops rows with `history.version_seq >= card.version_seq`, so that row is not an orphan under the documented pre-F13 predicate and will not be silently truncated. Either make the destructive setup create a true orphan (`history.version_seq >= card.version_seq`) while seeding/clearing history intentionally, or change the expected result to a non-empty history list whose `total < card.version_seq - 1`. As written, the recipe still claims `total === 0` / silent truncation for a state the current code should preserve.
2. The F12 acceptance shape is not consistent with the orchestrator-bound `entry_id` + `kind` requirement. [01-analysis-r4.md](./01-analysis-r4.md) mentions commit markers carrying those fields in the F13 ownership paragraph, but §4's binding F12 acceptance list does not require every returned history row/header to include `entry_id` and `kind`. Add that requirement to the acceptance bullets so F12, F13, and the tests share one closure contract.
3. The synthetic scratch-path split is otherwise acceptable: the destructive container path is under `/work/saivage-v3/tmp/f12-invariant`, the optional host-side staging path is under `/home/salva/g/ml/tmp/...`, and the document avoids `/tmp`.

## Design review

1. The binding architecture choices are correctly reflected: F13 is the umbrella, derived files are deleted, the mutex is project-wide, and commit markers carry `entry_id` / `kind`.
2. The F12-specific acceptance enumeration in [02-design-r4.md](./02-design-r4.md) still omits the `entry_id` + `kind` assertion. Add it explicitly to the backend, agent, and web fixture/test requirements rather than relying on F13's schema section to imply it.
3. The `card_history_appended` public event is preserved and required exactly once per version bump. That part is consistent with the analysis and plan.
4. The out-of-scope note on comment/docstring discipline is acceptable for F12 closure: it adopts the workspace rule and does not introduce any code-change carveout.

## Plan review

1. The numeric history contract is now consistent in the F12 plan: `history.total >= card.version_seq - 1`, `max(history[].version_seq) === card.version_seq - 1`, and `history/<seq>` populated for `[1, card.version_seq - 1]`.
2. The live probe in [03-plan-r4.md](./03-plan-r4.md) still checks only the three numeric invariants. Per the closure contract under review, it must also assert every history row/header has a required `entry_id` and `kind` value, or explicitly delegate that final live assertion to the F13 r4 live probe.
3. The implementation pointer still targets F13 r3 even though the closure cross-check is against F13 r4. Update the F12 r4 analysis/design/plan links to the final F13 r4 documents, or state explicitly that F13 r4 supersedes the linked r3 plan and is the actual closure owner.

## Cross-check with F13 r4

1. F13 r4 adopts the orchestrator-bound history math (`V - 1`, `total >= V - 1`) and the async `transitionCard` decision. It also preserves `card_history_appended` and requires `entry_id` / `kind` in schema, fixtures, and live probe checks.
2. F13 r4 does not include the F12 r4 enumerated test list verbatim. Both [01-analysis-r4.md](../F13-canonical-index-drift/01-analysis-r4.md) and [03-plan-r4.md](../F13-canonical-index-drift/03-plan-r4.md) refer to F12 r3, not F12 r4, and the absorbed list paraphrases/weakens some assertions.
3. Concrete non-verbatim drift: F12's operator-contract test requires the single-PATCH cases to assert `max(history[].version_seq) === card.version_seq - 1`; F13's absorbed item only states that max assertion in the two-PATCH case. F12's diff assertion requires a non-empty `changed_fields` list including the relevant changed field; F13's absorbed item says only that a `changed_fields` list is returned. F12's plan also states the `total >= card.version_seq - 1` invariant in the acceptance math, while F13's absorbed list does not carry it into every corresponding test item.
4. To close F12, make F13 r4 copy the F12 r4 test enumeration exactly, or change F12 r4 to define a precise mapping contract instead of a verbatim-inclusion requirement. The current documents cannot simultaneously require verbatim inclusion and accept the present F13 r4 paraphrase.

VERDICT: CHANGES_REQUESTED