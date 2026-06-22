# Adversarial Final Review: Amended 03-plan.md

## BLOCKING

None.

The amended live proposal resolves the prior blockers and does not introduce a new lifecycle blocker from removing `drafting`.

## NON-BLOCKING

### N1 - Legacy note-injection naming is slightly imprecise

Batch C now explicitly removes or no-ops duplicate synthetic planner-note delivery and includes the pause/resume path, satisfying the prior concern. The implementation has multiple related names (`injectSyntheticPlannerNotes`, `injectQueuedSyntheticPlannerNotes`, `injectQueuedPlannerNotes`), so the implementer should verify all legacy out-of-band planner-note injection paths are covered by the single-drain planner-context replacement.

### N2 - Source-wide removed-status sweep is correctly required, but must be treated as authoritative

Batch A includes the required `rg "\b(active|drafting)\b" src tests web/src docs/agents.md` sweep and false-positive review. This is sufficient, provided implementation treats every remaining card-status literal as a bug rather than relying only on the named examples.

## Verification Notes

- Prior B1 is fixed: `03-plan.md` explicitly changes `FULL_EDIT_STATES` from `['drafting','backlog']` to `['backlog']`, and `02-design.md` also mentions the same lifecycle update.
- Prior B2 is fixed: `03-plan.md` explicitly moves `src/runtime/runtime-pause-resume.ts` onto the planner-specific single-drain context path, and `02-design.md` mentions pause/resume uses that same path.
- Prior N2 is addressed: both design and plan require removal/no-op of the legacy synthetic-note injection route so planner notes are not delivered twice.
- Prior N1 is addressed: the plan includes a source-wide removed-status sweep covering `src`, `tests`, `web/src`, and `docs/agents.md`.
- The final transition table is coherent after Batches A+B: no `drafting`/`active` rows; `backlog -> running/cancelled`; `changed -> backlog/running/cancelled`; terminal states reopen to `backlog`, can cancel where already allowed, and can flip to `changed`; `cancelled -> backlog/changed` supports restart through `backlog -> running`.

VERDICT: APPROVED
