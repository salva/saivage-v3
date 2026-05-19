# Documentation inventory

This inventory maps every tracked Markdown file in the repository root and `docs/` tree to its current source-of-truth status. Stage 22 moved the numbered root design documents into `docs/historical/2026-pre-consolidation/` and created canonical concept pages under `docs/design/`; later stages will continue the planned runbook and historical consolidation.

## Classification legend

- **current** — matches current source, tests, and accepted remediation outcomes.
- **stale** — partly useful, but incomplete against current behavior.
- **misleading** — likely to send operators or maintainers toward wrong current behavior.
- **obsolete** — superseded by the redesigned and repaired system.
- **historical** — preserved for provenance only; not current operator guidance.
- **missing-coverage** — records a coverage gap or inventory need rather than current operator guidance.

## Inventory

| Path | Classification | Justification | Primary code anchor | Disposition |
|---|---|---|---|---|
| `README.md` | stale | The landing page now points at the canonical design entry point but remains scheduled for the Stage 26 rewrite. | package.json:1 | rewrite |
| `bugs.md` | historical | This bug scratchpad is provenance material and not a current defect tracker for the remediated codebase. | audit-findings/README.md:1 | move-to-docs/historical/ |
| `docs/agents.md` | current | This is the authoritative agent and runtime architecture reference for the current planner, tool, scheduler, and recovery contracts. | src/agents/agent-adapter.ts:1 | keep |
| `docs/analyst.md` | current | The analyst guide aligns with the implemented analyst handler, authorization checks, and safe inspection tools. | src/agents/analyst-handler.ts:1 | keep |
| `docs/configuration.md` | current | The configuration reference follows the current config schema and runtime-control configuration surface. | src/agents/config-schema.ts:1 | keep |
| `docs/design/agents.md` | stale | The consolidated agent design preserves design-era content and is superseded for current behavior by docs/agents.md. | src/agents/agent-adapter.ts:1 | merge-into |
| `docs/design/card-lifecycle.md` | stale | The consolidated lifecycle design predates terminal-goal reactivation, destructive-operation, restart, and pause/resume repairs. | src/utils/planner-tools.ts:1 | merge-into |
| `docs/design/card-model.md` | stale | The consolidated card-model design remains useful but lacks later runtime invariants, priority-scale, evidence, and mirroring repairs. | src/utils/card-store.ts:1 | merge-into |
| `docs/design/configuration.md` | stale | The consolidated configuration design duplicates active configuration docs and does not fully track the current runtime config schema. | src/agents/config-schema.ts:1 | merge-into |
| `docs/design/data-model.md` | stale | The consolidated data-model design predates current RuntimeState, active-card-run, and persisted session invariants. | src/schemas/validators.ts:1 | merge-into |
| `docs/design/decisions.md` | historical | The consolidated decisions log records historical design choices and is preserved as provenance rather than current authority. | docs/agents.md:1 | move-to-docs/historical/ |
| `docs/design/implementation-plan.md` | historical | The consolidated implementation plan is a delivery artifact superseded by current source and remediation dossiers. | docs/planner-redesign-plan.md:1 | move-to-docs/historical/ |
| `docs/design/index.md` | current | The design index is the Stage 22 canonical entry point for consolidated design-era concept documents. | docs/.vitepress/config.ts:1 | keep |
| `docs/design/runtime.md` | stale | The consolidated runtime design has useful context but trails the current scheduler, safe-tick, runtime-state invariant, and HTTP response contracts. | src/utils/runtime.ts:1 | merge-into |
| `docs/design/security.md` | stale | The consolidated security overview omits later provider-error redaction, auth-banner, and path-denylist details now enforced in source. | src/utils/error-logger.ts:1 | merge-into |
| `docs/design/server-api.md` | stale | The consolidated server API design predates repaired runtime-control response shapes and the current route verification guard. | src/server/server.ts:1 | merge-into |
| `docs/design/skills.md` | stale | The consolidated skills design is still conceptually relevant but lacks current workspace-tool and skill-engine implementation details. | src/agents/skills-engine.ts:1 | merge-into |
| `docs/design/ux-design.md` | stale | The consolidated UX design predates multiple operator-surface fixes for agents, debug, files, token modal, and analyst panel behavior. | web/src/App.vue:1 | merge-into |
| `docs/documentation-inventory.md` | current | This file is the enforced source-of-truth map for tracked root and docs Markdown files. | scripts/check-doc-inventory.js:1 | keep |
| `docs/executor-workspace-tooling-failure-report.md` | historical | The executor workspace tooling failure report is an incident record retained for provenance after implementation changes. | src/agents/workspace-tools.ts:1 | move-to-docs/historical/ |
| `docs/executor-workspace-tooling-remediation-plan.md` | historical | The executor workspace tooling remediation plan is a superseded implementation plan, not current operator guidance. | src/agents/workspace-tools.ts:1 | move-to-docs/historical/ |
| `docs/full-codebase-review-remediation-plan.md` | historical | The full-codebase review remediation plan is a historical audit artifact superseded by findings and source. | audit-findings/README.md:1 | move-to-docs/historical/ |
| `docs/goal-planning-runtime.md` | stale | The goal-planning runtime summary is useful but overlaps with newer authoritative scheduler and planner sections in docs/agents.md. | src/utils/runtime.ts:1 | merge-into |
| `docs/historical-artifacts.md` | current | The historical-artifact guide now points design-era numbered files at their Stage 22 historical location. | docs/historical-artifacts.md:1 | merge-into |
| `docs/historical/2026-pre-consolidation/01-card-model.md` | historical | The original numbered card-model design file was moved during Stage 22 and is retained only as pre-consolidation provenance. | src/utils/card-store.ts:1 | move-to-docs/historical/ |
| `docs/historical/2026-pre-consolidation/02-card-lifecycle.md` | historical | The original numbered card lifecycle design file was moved during Stage 22 and is retained only as pre-consolidation provenance. | src/utils/planner-tools.ts:1 | move-to-docs/historical/ |
| `docs/historical/2026-pre-consolidation/03-agents.md` | historical | The original numbered agent design file was moved during Stage 22 and is retained only as pre-consolidation provenance. | src/agents/agent-adapter.ts:1 | move-to-docs/historical/ |
| `docs/historical/2026-pre-consolidation/04-runtime.md` | historical | The original numbered runtime design file was moved during Stage 22 and is retained only as pre-consolidation provenance. | src/utils/runtime.ts:1 | move-to-docs/historical/ |
| `docs/historical/2026-pre-consolidation/05-security.md` | historical | The original numbered security design file was moved during Stage 22 and is retained only as pre-consolidation provenance. | src/utils/error-logger.ts:1 | move-to-docs/historical/ |
| `docs/historical/2026-pre-consolidation/06-configuration.md` | historical | The original numbered configuration design file was moved during Stage 22 and is retained only as pre-consolidation provenance. | src/agents/config-schema.ts:1 | move-to-docs/historical/ |
| `docs/historical/2026-pre-consolidation/07-skills.md` | historical | The original numbered skills design file was moved during Stage 22 and is retained only as pre-consolidation provenance. | src/agents/skills-engine.ts:1 | move-to-docs/historical/ |
| `docs/historical/2026-pre-consolidation/08-server-api.md` | historical | The original numbered server API design file was moved during Stage 22 and is retained only as pre-consolidation provenance. | src/server/server.ts:1 | move-to-docs/historical/ |
| `docs/historical/2026-pre-consolidation/09-data-model.md` | historical | The original numbered data model design file was moved during Stage 22 and is retained only as pre-consolidation provenance. | src/schemas/validators.ts:1 | move-to-docs/historical/ |
| `docs/historical/2026-pre-consolidation/10-ux-design.md` | historical | The original numbered UX design file was moved during Stage 22 and is retained only as pre-consolidation provenance. | web/src/App.vue:1 | move-to-docs/historical/ |
| `docs/historical/2026-pre-consolidation/11-decisions.md` | historical | The original numbered decisions log file was moved during Stage 22 and is retained only as pre-consolidation provenance. | docs/agents.md:1 | move-to-docs/historical/ |
| `docs/historical/2026-pre-consolidation/12-implementation-plan.md` | historical | The original numbered implementation plan file was moved during Stage 22 and is retained only as pre-consolidation provenance. | docs/planner-redesign-plan.md:1 | move-to-docs/historical/ |
| `docs/index.md` | stale | The docs index is serviceable and links to the new design tree but will need Stage 26 restructuring after runbook and historical trees exist. | docs/.vitepress/config.ts:1 | rewrite |
| `docs/install.md` | current | The installation guide matches the package scripts and current CLI/server bootstrap flow. | src/cli.ts:1 | keep |
| `docs/operation.md` | current | The operation guide tracks current HTTP, WebSocket, docs, runtime-control, and route-verification behavior. | src/server/server.ts:1 | keep |
| `docs/operator-runbook.md` | stale | The operator runbook is useful but will be merged into the Stage 25 runbook tree with operation and troubleshooting content. | src/server/routes/runtime-config-notes.ts:1 | merge-into |
| `docs/planner-redesign-plan.md` | historical | The planner redesign plan remains binding historical design evidence for remediation but is not final operator guidance. | docs/agents.md:1 | move-to-docs/historical/ |
| `docs/release-checklist.md` | stale | The release checklist matches current scripts in broad terms but belongs in the consolidated Stage 25 runbook tree. | scripts/docs-verify.sh:1 | merge-into |
| `docs/second-codebase-review-remediation-cycle.md` | historical | This second-cycle remediation record is a provenance artifact superseded by resolved findings and tests. | audit-findings/README.md:1 | move-to-docs/historical/ |
| `docs/top-level-planner-control-flow-review.md` | historical | The planner control-flow review documents a prior audit state and should not be used as current control guidance. | src/utils/runtime.ts:1 | move-to-docs/historical/ |
| `docs/top-level-planner-mcp-redesign-plan.md` | historical | The top-level planner MCP redesign plan is superseded by docs/agents.md and current implementation. | src/agents/agent-adapter.ts:1 | move-to-docs/historical/ |
| `docs/troubleshooting.md` | stale | The troubleshooting guide remains useful but should be folded into the consolidated incidents runbook. | src/utils/stuck-agent-supervisor.ts:1 | merge-into |
| `docs/v3-planner-control-mcp-contract.md` | historical | The V3 planner control MCP contract is a pre-implementation contract retained for provenance and later reconciliation. | src/agents/agent-adapter.ts:1 | move-to-docs/historical/ |
| `future.md` | historical | The future-ideas file is non-authoritative planning material outside the current source-of-truth set. | docs/documentation-inventory.md:1 | move-to-docs/historical/ |
| `use-cases.md` | stale | The use-case catalog is helpful product context but contains assumptions that need reconciliation into the design docs. | web/src/App.vue:1 | merge-into |

## Verification

`npm run docs:verify` runs `scripts/check-doc-inventory.js`, which fails when a tracked Markdown file in the repository root or `docs/` tree is missing from this table or when a table row points to a non-existent file. Stage 22 also adds `scripts/check-design-doc-links.js` to keep links in `docs/design/*.md` within allowed documentation, repository-root, or HTTPS destinations.
