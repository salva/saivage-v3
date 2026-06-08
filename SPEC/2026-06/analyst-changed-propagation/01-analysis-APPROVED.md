# Analysis APPROVED

`01-analysis.md` was reviewed across three adversarial rounds against the
actual source. All blocking findings resolved:

- B1: ancestor ordering corrected to root-first / nearest-last
  (`state.ts:73-81` `unshift`), with the reverse-iteration / `getParent`
  caveat for the stop-at-first-`running` walk.
- B2/B3: the required behavior's contradiction with `docs/agents.md` §4.2
  ("ancestors keep their current status") and §11, and the §4.2-vs-§11
  internal note-routing inconsistency, are surfaced as required authority
  edits.
- B4: "never flip a `running` ancestor" rationale re-attributed to the
  activation/run ledger + `active_card_run` invariants, not caller-edge
  reconstruction.
- B5: the `previous_status` proposal is cheap to capture at the producer
  (no history lookup) but conflicts with the existing
  `queueSyntheticPlannerNote` dedup key; the design must pick a
  reconciliation. Two projection sites identified.
- B6: the dedup-collision trace corrected to a same-target-session,
  no-intervening-planner-turn window (descendant edit routed to an ancestor
  planner), since re-activating a goal drains its own queued notes
  (`planner-phase-runner.ts:65`).

Final verdict: VERDICT: APPROVED.

Chosen open-question dispositions to carry into design:
1. Non-terminal descendants (including `failed`/`backlog`) block
   `report_goal_done` (tighten `collectSubtreeReadinessReasons`).
2-7. Left open for the design to decide with reviewer vetting.
