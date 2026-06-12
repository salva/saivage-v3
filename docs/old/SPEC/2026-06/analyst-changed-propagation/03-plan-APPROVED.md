# Plan APPROVED

`03-plan.md` was reviewed against the amended proposal and current source. The
live plan is approved after incorporating post-approval amendments:

- Synthetic planner notes are primary-planner-only. Reviewer context must not
  drain or render notes targeted at `planner:<goalId>`.
- Planner resume drains notes once and uses the same set for resume-reason
  inference and prompt rendering, including the pause/resume path.
- Both card statuses `active` and `drafting` are removed. New cards default to
  `backlog`; cancelled cards reopen through `backlog`; no `drafting` lifecycle
  remains.
- `PlannerToolsService.activateCard` and its direct unit test are deleted; no
  replacement helper is preserved.
- Batch A covers `FULL_EDIT_STATES`, source-wide removed-status sweeps, web UI
  status surfaces, enum-contract fixtures, and direct activation tests.

Final review: `03-plan-review.md`.

Final verdict: VERDICT: APPROVED.
