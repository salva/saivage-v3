# S04 Third-Pass Review - Notifications Queue Ephemeral

Verdict: APPROVED

Finding counts:

- Critical: 0
- Major: 0
- Minor: 0

Single most important issue: none.

## Scope

Reviewed `design.md` and `plan.md` against SPEC-r7, PROTOCOL-r4,
MASTER-PLAN-r7 S04, published S00-S03, and the cumulative expected
breakage ledger.

The published stage directories for S00-S03 are present:

- `PLAN/stages/000-breakage-detection-harness/`
- `PLAN/stages/001-real-llm-analyst-resolver/`
- `PLAN/stages/002-tool-surface-alignment/`
- `PLAN/stages/003-ordered-children-and-bounded-move/`

The cumulative ledger exists at
`SPEC/analyst-as-control-surface/PLAN/expected-breakage-ledger.md`.

## R-FORECAST

Resolved.

The reviewer-cited forecast-count locations now use four instead of the
stale three-count wording:

- `design.md` lines 727-729 limit expected diffs to the four
  S06-forecast entries plus the S02 close-out.
- `design.md` lines 820-822 describe four gates and the four H3
  forecasts.
- `design.md` lines 834-837 describe the four H3 ledger entries.
- `plan.md` line 384 states web tests show the four forecasted vitest
  failures.
- `plan.md` lines 399-405 allow only the four listed web-vitest ids and
  include `scenario-operator-events-contract:step-1`.
- `plan.md` lines 457-467 append the four forecast entries and include
  `web-vitest:scenario-operator-events-contract:step-1`.
- `plan.md` lines 502-507 require exactly the four NEW web-vitest
  failures and include
  `web-vitest:scenario-operator-events-contract:step-1`.

The operator-events contract id is present in all three enumerated
allowlists:

- G.2: `scenario-operator-events-contract:step-1`
- H.4: `web-vitest:scenario-operator-events-contract:step-1`
- H.7: `web-vitest:scenario-operator-events-contract:step-1`

`design.md` contains exactly four forecast H3 entries:

- `web-vitest:scenario-notifications-panel:step-1`
- `web-vitest:scenario-stale-warning-ribbon:step-1`
- `web-vitest:scenario-operator-dashboard-smoke:step-1`
- `web-vitest:scenario-operator-events-contract:step-1`

## Remaining Three Occurrences

`grep -n 'three\|3 \| 3$' design.md` and the independent `plan.md`
search leave no stale forecast-count wording. The remaining literal
`three` occurrences are all acceptable non-forecast contexts:

- `design.md:306`: "three usage sites" - local implementation audit
  count, not a forecast allowlist count.
- `design.md:841`: "all three conditions" - conditional S02 ledger
  close-out criteria.
- `plan.md:472`: "all three conditions" - conditional S02 ledger
  close-out criteria.
- `plan.md:543`: "all three invocations" - final close-out checks for
  emoji plus the two autonomy invocations.

The other `3 ` hits are section labels, stage identifiers, line-number
references, Q3 text, H3 heading references, or V.3/H.3 step labels.

## Mechanical Checks

- Literal autonomy grep against `design.md plan.md`: zero hits.
- Emoji grep against `design.md plan.md`: zero hits.
- Host-path `/work/` grep against `design.md plan.md`: zero hits.

## Carry-Overs

- E.6-E.9 operator-events substeps remain intact: the plan removes
  `notification_acknowledged` from the event-name tuple, narrows
  `NotificationAddedContentSchema`, deletes
  `NotificationAcknowledgedContentSchema`, removes it from the
  discriminated union, and drops the index re-export.
- H.8 operator-api zero-hit guard remains intact and fails the stage for
  any notification-named schema, route entry, or exported type in
  `src/contracts/operator-api.ts`.
- S02 conditional close-out remains intact in H.5: the plan only deletes
  the S02 H3 ledger block if the exact block exists, its target stage is
  S04, and the fresh gate diff no longer observes the failing id.
- `safety_class` remains `low` in `design.md`.
- Substep count is 66, within the expected range.
- Ledger references point only to the cumulative ledger path
  `SPEC/analyst-as-control-surface/PLAN/expected-breakage-ledger.md`
  or the equivalent relative link from the draft directory.

## Conclusion

R-FORECAST is resolved and the carry-over checks still hold. No blocking
issues remain.
