# Historical artifacts


> **Authority status: historical.** This page is retained for provenance only. Prefer `docs/historical/README.md` for current authority where applicable.

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

## Historical docs kept for provenance

- [Full Codebase Review Remediation Plan](/historical/2026-05-remediation-dossiers/full-codebase-review-remediation-plan)
- [Second Review Remediation Cycle](/historical/2026-05-remediation-dossiers/second-codebase-review-remediation-cycle)
- [Executor Workspace Tooling Failure Report](/historical/2026-05-remediation-dossiers/executor-workspace-tooling-failure-report)
- [Executor Workspace Tooling Remediation Plan](/historical/2026-05-remediation-dossiers/executor-workspace-tooling-remediation-plan)
- [Top-Level Planner Control Flow Review](/historical/2026-05-remediation-dossiers/top-level-planner-control-flow-review)
- [Top-Level Planner MCP Redesign Plan](/historical/2026-05-remediation-dossiers/top-level-planner-mcp-redesign-plan)
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

## Design-era material

Stage 22 moved the original numbered root design documents (`01-card-model.md` through `12-implementation-plan.md`) into `docs/historical/2026-pre-consolidation/` for provenance. The `docs/design/*.md` files are the canonical Stage 22 design entry points; they consolidate the design-era material and should be used instead of the moved numbered originals.

`use-cases.md` remains a root-level legacy product-context file until a later consolidation stage decides whether to merge or archive it.
