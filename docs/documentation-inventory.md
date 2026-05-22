# Documentation inventory

<!-- doc-authority
status: current
disposition: keep
owner: docs-maintainers
superseded_by: none
last_verified_against: scripts/check-doc-inventory.js:1
-->

This inventory maps every tracked Markdown file in the repository root and `docs/` tree to its current source-of-truth status. Stage 22 moved the numbered root design documents into `docs/historical/2026-pre-consolidation/`; Stage 24 moved remediation and review dossiers into `docs/historical/2026-05-remediation-dossiers/` and added a historical-isolation guard; Stage 25 consolidated operator guidance into `docs/runbook/`; Stage 26 finalized the root landing page, curated docs index, consolidation summary, and global Markdown link guard.

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
| `README.md` | current | The root landing page is the Stage 26 concise entry point with install, serve, runbook, design, historical, and key-concept links. | package.json:1 | keep |
| `bugs.md` | historical | This bug scratchpad is provenance material and not a current defect tracker for the remediated codebase. | audit-findings/README.md:1 | move-to-docs/historical/ |
| `docs/agents.md` | current | This is the authoritative agent and runtime architecture reference for the current planner, tool, scheduler, and recovery contracts. | src/agents/agent-adapter.ts:1 | keep |
| `docs/analyst.md` | current | The analyst guide aligns with the implemented analyst handler, authorization checks, and safe inspection tools. | src/agents/analyst-handler.ts:1 | keep |
| `docs/configuration.md` | current | The configuration reference follows the current config schema and runtime-control configuration surface. | src/agents/config-schema.ts:1 | keep |
| `docs/design/agents.md` | stale | The consolidated agent design is superseded by `docs/agents.md` and does not fully capture the current tool surfaces and Codex recovery behavior. | src/agents/agent-adapter.ts:1 | merge-into |
| `docs/design/card-lifecycle.md` | stale | The consolidated lifecycle narrative predates later terminal-goal reactivation, destructive-operation, restart, and pause/resume contract repairs. | src/utils/planner-tools.ts:1 | merge-into |
| `docs/design/card-model.md` | stale | The consolidated card-model design remains useful but lacks later runtime invariants, priority-scale, evidence, and mirroring repairs. | src/utils/card-store.ts:1 | merge-into |
| `docs/design/configuration.md` | stale | The consolidated configuration guide duplicates active configuration docs and does not fully track the current runtime config schema. | src/agents/config-schema.ts:1 | merge-into |
| `docs/design/data-model.md` | stale | The consolidated data-model design predates current `RuntimeState`, active-card-run, and persisted session invariants. | src/schemas/validators.ts:1 | merge-into |
| `docs/design/decisions.md` | historical | The consolidated decisions log records historical design choices and should remain provenance rather than current implementation authority. | docs/agents.md:1 | move-to-docs/historical/ |
| `docs/design/implementation-plan.md` | historical | The consolidated implementation plan is a delivery artifact superseded by current source and remediation dossiers. | docs/historical/2026-05-remediation-dossiers/planner-redesign-plan.md:1 | move-to-docs/historical/ |
| `docs/design/index.md` | current | The design index is the Stage 22 canonical entry point for consolidated design-era concept documents. | docs/.vitepress/config.ts:1 | keep |
| `docs/design/runtime.md` | stale | The consolidated runtime design has useful context but trails the current scheduler, safe-tick, runtime-state invariant, and HTTP response contracts. | src/runtime/runtime.ts:1 | merge-into |
| `docs/design/security.md` | stale | The consolidated security overview omits later provider-error redaction, auth-banner, and path-denylist details now enforced in source. | src/utils/error-logger.ts:1 | merge-into |
| `docs/design/server-api.md` | stale | The consolidated server API doc predates repaired runtime-control response shapes and the current route verification guard. | src/server/server.ts:1 | merge-into |
| `docs/design/skills.md` | stale | The consolidated skills design is still conceptually relevant but lacks current workspace-tool and skill-engine implementation details. | src/agents/skills-engine.ts:1 | merge-into |
| `docs/design/ux-design.md` | stale | The consolidated UX design predates multiple operator-surface fixes for agents, debug, files, token modal, and analyst panel behavior. | web/src/App.vue:1 | merge-into |
| `docs/documentation-inventory.md` | current | This file is the enforced Stage 21 source-of-truth map for tracked root and docs Markdown files. | scripts/check-doc-inventory.js:1 | keep |
| `docs/historical/README.md` | historical | The historical README explains that archived documentation is provenance only and not current operator guidance. | docs/historical/README.md:1 | keep |
| `docs/historical/2026-doc-consolidation-summary.md` | historical | The Stage 21-26 consolidation summary records documentation restructuring outcomes for provenance only. | scripts/docs-verify.sh:1 | keep |
| `docs/historical/2026-05-remediation-dossiers/executor-workspace-tooling-failure-report.md` | historical | The executor workspace tooling failure report is an incident record retained for provenance after implementation changes. | src/agents/workspace-tools.ts:1 | keep |
| `docs/historical/2026-05-remediation-dossiers/executor-workspace-tooling-remediation-plan.md` | historical | The executor workspace tooling remediation plan is a superseded implementation plan, not current operator guidance. | src/agents/workspace-tools.ts:1 | keep |
| `docs/historical/2026-05-remediation-dossiers/full-codebase-review-remediation-plan.md` | historical | The full-codebase review remediation plan is a historical audit artifact superseded by findings and source. | audit-findings/README.md:1 | keep |
| `docs/goal-planning-runtime.md` | current | Current authority for explicit runtime commands, planner/card state separation, activation ledger semantics, restart repair, confirmation scope, and Runtime Console / Planning Tree split. | src/runtime/runtime.ts:1 | keep |
| `docs/historical/2026-05-remediation-dossiers/historical-artifacts.md` | historical | The historical-artifact guide is now retained as a Stage 24 provenance index superseded by `docs/historical/README.md`. | docs/historical/README.md:1 | keep |
| `docs/historical/2026-pre-consolidation/01-card-model.md` | historical | The original numbered card-model design file was moved during Stage 22 and is retained only as pre-consolidation provenance. | src/utils/card-store.ts:1 | move-to-docs/historical/ |
| `docs/historical/2026-pre-consolidation/02-card-lifecycle.md` | historical | The original numbered card lifecycle design file was moved during Stage 22 and is retained only as pre-consolidation provenance. | src/utils/planner-tools.ts:1 | move-to-docs/historical/ |
| `docs/historical/2026-pre-consolidation/03-agents.md` | historical | The original numbered agent design file was moved during Stage 22 and is retained only as pre-consolidation provenance. | src/agents/agent-adapter.ts:1 | move-to-docs/historical/ |
| `docs/historical/2026-pre-consolidation/04-runtime.md` | historical | The original numbered runtime design file was moved during Stage 22 and is retained only as pre-consolidation provenance. | src/runtime/runtime.ts:1 | move-to-docs/historical/ |
| `docs/historical/2026-pre-consolidation/05-security.md` | historical | The original numbered security design file was moved during Stage 22 and is retained only as pre-consolidation provenance. | src/utils/error-logger.ts:1 | move-to-docs/historical/ |
| `docs/historical/2026-pre-consolidation/06-configuration.md` | historical | The original numbered configuration design file was moved during Stage 22 and is retained only as pre-consolidation provenance. | src/agents/config-schema.ts:1 | move-to-docs/historical/ |
| `docs/historical/2026-pre-consolidation/07-skills.md` | historical | The original numbered skills design file was moved during Stage 22 and is retained only as pre-consolidation provenance. | src/agents/skills-engine.ts:1 | move-to-docs/historical/ |
| `docs/historical/2026-pre-consolidation/08-server-api.md` | historical | The original numbered server API design file was moved during Stage 22 and is retained only as pre-consolidation provenance. | src/server/server.ts:1 | move-to-docs/historical/ |
| `docs/historical/2026-pre-consolidation/09-data-model.md` | historical | The original numbered data model design file was moved during Stage 22 and is retained only as pre-consolidation provenance. | src/schemas/validators.ts:1 | move-to-docs/historical/ |
| `docs/historical/2026-pre-consolidation/10-ux-design.md` | historical | The original numbered UX design file was moved during Stage 22 and is retained only as pre-consolidation provenance. | web/src/App.vue:1 | move-to-docs/historical/ |
| `docs/historical/2026-pre-consolidation/11-decisions.md` | historical | The original numbered decisions log file was moved during Stage 22 and is retained only as pre-consolidation provenance. | docs/agents.md:1 | move-to-docs/historical/ |
| `docs/historical/2026-pre-consolidation/12-implementation-plan.md` | historical | The original numbered implementation plan file was moved during Stage 22 and is retained only as pre-consolidation provenance. | docs/historical/2026-05-remediation-dossiers/planner-redesign-plan.md:1 | move-to-docs/historical/ |
| `docs/index.md` | current | The docs index is the Stage 26 curated table of contents for runbook, design, source-of-truth references, findings dossiers, and provenance. | docs/.vitepress/config.ts:1 | keep |
| `docs/install.md` | current | The installation guide matches the package scripts and current CLI/server bootstrap flow. | src/cli.ts:1 | keep |
| `docs/operation.md` | current | The operation guide tracks current HTTP, WebSocket, docs, runtime-control, and route-verification behavior. | src/server/server.ts:1 | keep |
| `docs/operator-runbook.md` | current | This legacy top-level page forwards operators to the consolidated Stage 25 runbook tree. | docs/runbook/index.md:1 | keep |
| `docs/historical/2026-05-remediation-dossiers/planner-redesign-plan.md` | historical | The planner redesign plan remains historical design evidence but is not final operator guidance. | docs/agents.md:1 | keep |
| `docs/release-checklist.md` | current | This legacy top-level page forwards release validation to the consolidated runbook release checklist. | docs/runbook/release.md:1 | keep |
| `docs/runbook/incidents.md` | current | The incidents runbook consolidates current troubleshooting and degraded-state recovery guidance. | src/server/routes/chats-files-debug.ts:341 | keep |
| `docs/runbook/dependency-hygiene.md` | current | The dependency hygiene runbook defines ARCH-029 production audit thresholds, freshness checks, waivers, cadence, and rollback semantics. | scripts/check-dependency-freshness.js:1 | keep |
| `docs/runbook/index.md` | current | The runbook index is the Stage 25 single entry point for operator procedures. | scripts/check-runbook-curl-examples.js:1 | keep |
| `docs/runbook/lxc-operations.md` | current | The LXC operations page records current systemd unit names and deployment checks. | src/cli.ts:1 | keep |
| `docs/runbook/operations.md` | current | The operations runbook documents current startup, auth, health, state, runtime control, WebSocket, and backup procedures. | src/server/server.ts:28 | keep |
| `docs/runbook/release.md` | current | The release runbook consolidates current documentation, build, runtime-control, web, and security release gates. | package.json:1 | keep |
| `docs/historical/2026-05-remediation-dossiers/second-codebase-review-remediation-cycle.md` | historical | This second-cycle remediation record is a provenance artifact superseded by resolved findings and tests. | audit-findings/README.md:1 | keep |
| `docs/historical/2026-05-remediation-dossiers/top-level-planner-control-flow-review.md` | historical | The planner control-flow review documents a prior audit state and should not be used as current control guidance. | src/runtime/runtime.ts:1 | keep |
| `docs/historical/2026-05-remediation-dossiers/top-level-planner-mcp-redesign-plan.md` | historical | The top-level planner MCP redesign plan is superseded by `docs/agents.md` and current implementation. | src/agents/agent-adapter.ts:1 | keep |
| `docs/troubleshooting.md` | current | This legacy top-level page forwards troubleshooting guidance to the consolidated incidents runbook. | docs/runbook/incidents.md:1 | keep |
| `docs/v3-planner-control-mcp-contract.md` | current | Current authority for planner-control tool ownership, `activate_card` activation records, idempotency, and actionable precondition errors. | src/agents/planner-control-executor.ts:1 | keep |
| `future.md` | historical | The future-ideas file is non-authoritative planning material outside the current source-of-truth set. | docs/documentation-inventory.md:1 | move-to-docs/historical/ |
| `use-cases.md` | stale | The use-case catalog is helpful product context but contains assumptions that need reconciliation into the design docs. | web/src/App.vue:1 | merge-into |

## Verification

`npm run docs:verify` now builds VitePress and runs the active documentation guard bundle: `scripts/check-doc-inventory.js` for root/docs Markdown inventory completeness, `scripts/verify-doc-routes.js` for operator route/role/config/runtime anchors, `scripts/check-historical-isolation.js` for `See historical:` isolation, `scripts/check-runbook-curl-examples.js` for runbook curl route/shape checks, `scripts/check-design-doc-links.js` for design-doc allowed-link boundaries, and `scripts/check-markdown-links.js` plus `scripts/check-source-anchors.js` for global internal Markdown file/heading and documented source-anchor resolution. Source anchors may use strict exact-line form (`<path-to-source-file>:<line>`), context-tolerant line form (`<path-to-source-file>:<line> "nearby source text"`, accepted only when the quoted text appears within five lines of the cited line), or verified symbol form (`<path-to-source-file>#symbol:<exportedName>`); all forms still fail on missing source files, past-EOF line numbers, missing nearby context, or missing symbols.
