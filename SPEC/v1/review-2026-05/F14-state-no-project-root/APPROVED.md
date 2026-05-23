# F14 Approved

F14 (`state-no-project-root`) is approved after r2. The revised analysis, design, and plan address the r1 blockers without adding compatibility shims or broadening implementation scope.

Approved r2 documents:

- [01-analysis-r2.md](01-analysis-r2.md)
- [02-design-r2.md](02-design-r2.md)
- [03-plan-r2.md](03-plan-r2.md)
- [01-analysis-review-r2.md](01-analysis-review-r2.md)

Rationale:

- Backend validation now uses the repo's Jest runner for root/backend tests.
- The plan explicitly tests `redactOperatorErrorMessage(message, projectRoot)` so the deliberate `/api/state.projectRoot` success field does not erode error-message redaction guarantees.
- Source links now resolve from the review subdirectory to the repository root with the corrected `../../../../` prefix.
- The selected design exposes required `projectRoot` and `projectId` fields in both runtime-state branches and keeps F08/F18/F19/F22/F23 work out of scope.