## Analysis

No blocking issues. The r5 analysis is intentionally unchanged from r4, and that is appropriate: the r4 review had no analysis asks. It still includes the multi-line executor-result writer at `runtime.ts` L725-L733, the L740 evidence-registration downgrade hazard, the corrected L266 reviewer repair construction proof, and the nested `planning.status` payloads as out-of-scope for `CardStatus` mutation inventory. The note translating the old ts-morph forward pointer to the r5 multiline `rg` gate is clear enough because no analytical conclusion depends on the gate implementation mechanism.

## Design

No blocking issues. The r4 await concern is resolved in substance: `transitionCard` is async, runtime call sites are required to await it, and r5 adds an explicit binding that every post-`transitionCard` non-status `cardStore.update` follow-up is awaited, with durability, error-surface, and audit-ordering rationale. The design also pins `STARTABLE_STATES` and `RESTARTABLE_STATES` to exported constants from `src/permissions/card-permissions.ts`, so the runtime and machine do not need parallel local definitions. No new docstrings or comments in untouched code are proposed.

Non-blocking implementation note: the `planner_set_status` conversion lands inside today's synchronous `applyPlannerResult` method, so Step 5 implementation will necessarily make `applyPlannerResult` async and await its lone caller. The plan's compile-every-step and awaited-`transitionCard` rules already force that edit; spelling it out would reduce implementation friction, but it is not a substantive design defect.

## Plan

No blocking issues. Step 1.5 explicitly exports `STARTABLE_STATES` and `RESTARTABLE_STATES`; the current source still has them non-exported, so this is the right planned diff. Step 7 removes the unrunnable ts-morph/tsx/ts-node gate; `package.json` still has no such gate dependencies. The multiline `rg` Part A command catches the current L725-L733 multi-line `cardStore.update(... status: ...)` shape, and the companion `setStatus` check catches direct `cardStore.setStatus` survivors. The L644/L645/L663 nested `planning.status` allowlist is acceptable as a conservative false-positive disposal list; on the current compact runtime shape the `[^)]{0,400}` pattern may not report those nested payloads because `this.cardStore.read(...)` appears before `planning.status`, but that makes the allowlist harmless rather than unsafe. Part B explicitly fails unawaited `cardStore.update` calls, Probe-D is informational, and the deterministic Jest gates are called out as acceptance criteria.

VERDICT: APPROVED