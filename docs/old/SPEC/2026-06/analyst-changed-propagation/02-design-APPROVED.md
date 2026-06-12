# Design APPROVED

`02-design.md` is approved as amended.

Approved amendments after the earlier review rounds:

- Synthetic planner notes are primary-planner-only. Reviewer prompt/context
  construction must not drain or render notes targeted at `planner:<goalId>`.
- Planner resume drains notes once and passes the same notes to both
  resume-reason inference and prompt rendering, including pause/resume resume
  context.
- `active` is removed as redundant transient state.
- `drafting` is removed as an unused pre-backlog state the planner does not
  meaningfully handle.
- New cards default to `backlog`; cancelled cards reopen through `backlog`.
- `PlannerToolsService.activateCard` and its direct unit test are removed.

The amended implementation plan received final adversarial approval in
`03-plan-review.md`.
