# Historical artifacts

> **Historical/Audit Artifact Policy**  
> Documents listed here are preserved as audit evidence, redesign notes, incident records, or superseded remediation plans. They are **not** current operator instructions unless a current active doc explicitly revalidates them against current source and tests.

## Use current docs first

For current behavior and supported procedures, use:

- [Install](/install)
- [Configuration](/configuration)
- [Operation](/operation)
- [Goal Planning Runtime](/goal-planning-runtime)
- [Operator Runbook](/operator-runbook)
- [Troubleshooting](/troubleshooting)
- [Release Checklist](/release-checklist)
- [Documentation Inventory](/documentation-inventory)

## Historical docs kept for provenance

- [Full Codebase Review Remediation Plan](/full-codebase-review-remediation-plan)
- [Second Review Remediation Cycle](/second-codebase-review-remediation-cycle)
- [Executor Workspace Tooling Failure Report](/executor-workspace-tooling-failure-report)
- [Executor Workspace Tooling Remediation Plan](/executor-workspace-tooling-remediation-plan)
- [Top-Level Planner Control Flow Review](/top-level-planner-control-flow-review)
- [Top-Level Planner MCP Redesign Plan](/top-level-planner-mcp-redesign-plan)
- [V3 Planner Control MCP Contract](/v3-planner-control-mcp-contract)
- `inspections/stage-01-*.md` through `inspections/stage-06-*.md`

## How to read historical material safely

Treat historical pages as answers to these questions only:

- What defect or redesign concern was observed at that time?
- What rationale informed later repair work?
- What evidence should be rechecked against current source or tests?

Do **not** treat them as current truth for:

- active operator workflows
- supported runtime controls
- current API shape
- current UI state behavior
- current security and file-access guarantees

## Root-level legacy design docs

Several root markdown files (`docs/design/card-model.md` through `docs/design/implementation-plan.md`, plus `use-cases.md`) remain in the repository as historical design-era material. They are not part of the active docs set and should not be treated as authoritative without explicit current revalidation.
