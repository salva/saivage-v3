# Documentation inventory

This Stage 21 inventory maps every tracked Markdown file in the repository root and `docs/` tree to its current source-of-truth status. It is intentionally a map only: no Markdown files are moved, deleted, or consolidated until later remediation stages.

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
| `01-card-model.md` | stale | The root card-model design remains useful but lacks later runtime invariants, priority-scale, evidence, and mirroring repairs. | src/utils/card-store.ts:1 | merge-into |
| `02-card-lifecycle.md` | stale | The lifecycle narrative predates later terminal-goal reactivation, destructive-operation, restart, and pause/resume contract repairs. | src/utils/planner-tools.ts:1 | merge-into |
| `03-agents.md` | stale | The root agent summary is superseded by `docs/agents.md` and does not fully capture the current tool surfaces and Codex recovery behavior. | src/agents/agent-adapter.ts:1 | merge-into |
| `04-runtime.md` | stale | The runtime design has useful context but trails the current scheduler, safe-tick, runtime-state invariant, and HTTP response contracts. | src/utils/runtime.ts:1 | merge-into |
| `05-security.md` | stale | The security overview omits later provider-error redaction, auth-banner, and path-denylist details now enforced in source. | src/utils/error-logger.ts:1 | merge-into |
| `06-configuration.md` | stale | The root configuration guide duplicates active configuration docs and does not fully track the current runtime config schema. | src/agents/config-schema.ts:1 | merge-into |
| `07-skills.md` | stale | The skills design is still conceptually relevant but lacks current workspace-tool and skill-engine implementation details. | src/agents/skills-engine.ts:1 | merge-into |
| `08-server-api.md` | stale | The root server API doc predates repaired runtime-control response shapes and the current route verification guard. | src/server/server.ts:1 | merge-into |
| `09-data-model.md` | stale | The data-model design predates current `RuntimeState`, active-card-run, and persisted session invariants. | src/schemas/validators.ts:1 | merge-into |
| `10-ux-design.md` | stale | The UX design predates multiple operator-surface fixes for agents, debug, files, token modal, and analyst panel behavior. | web/src/App.vue:1 | merge-into |
| `11-decisions.md` | historical | The decisions log records historical design choices and should remain provenance rather than current implementation authority. | docs/agents.md:1 | move-to-docs/historical/ |
| `12-implementation-plan.md` | historical | The staged implementation plan is a delivery artifact superseded by current source and remediation dossiers. | docs/planner-redesign-plan.md:1 | move-to-docs/historical/ |
| `README.md` | stale | The landing page points to current docs but will need Stage 26 rewrite into the concise final entry point. | package.json:1 | rewrite |
| `bugs.md` | historical | This bug scratchpad is provenance material and not a current defect tracker for the remediated codebase. | audit-findings/README.md:1 | move-to-docs/historical/ |
| `docs/agents.md` | current | This is the authoritative agent and runtime architecture reference for the current planner, tool, scheduler, and recovery contracts. | src/agents/agent-adapter.ts:1 | keep |
| `docs/analyst.md` | current | The analyst guide aligns with the implemented analyst handler, authorization checks, and safe inspection tools. | src/agents/analyst-handler.ts:1 | keep |
| `docs/configuration.md` | current | The configuration reference follows the current config schema and runtime-control configuration surface. | src/agents/config-schema.ts:1 | keep |
| `docs/documentation-inventory.md` | current | This file is the enforced Stage 21 source-of-truth map for tracked root and docs Markdown files. | scripts/check-doc-inventory.js:1 | keep |
| `docs/executor-workspace-tooling-failure-report.md` | historical | The executor workspace tooling failure report is an incident record retained for provenance after implementation changes. | src/agents/workspace-tools.ts:1 | move-to-docs/historical/ |
| `docs/executor-workspace-tooling-remediation-plan.md` | historical | The executor workspace tooling remediation plan is a superseded implementation plan, not current operator guidance. | src/agents/workspace-tools.ts:1 | move-to-docs/historical/ |
| `docs/full-codebase-review-remediation-plan.md` | historical | The full-codebase review remediation plan is a historical audit artifact superseded by findings and source. | audit-findings/README.md:1 | move-to-docs/historical/ |
| `docs/goal-planning-runtime.md` | stale | The goal-planning runtime summary is useful but overlaps with newer authoritative scheduler and planner sections in `docs/agents.md`. | src/utils/runtime.ts:1 | merge-into |
| `docs/historical-artifacts.md` | current | The historical-artifact guide currently labels provenance material and will feed the later historical directory organization. | docs/historical-artifacts.md:1 | merge-into |
| `docs/index.md` | stale | The docs index is serviceable but will need Stage 26 restructuring after design, runbook, and historical trees exist. | docs/.vitepress/config.ts:1 | rewrite |
| `docs/install.md` | current | The installation guide matches the package scripts and current CLI/server bootstrap flow. | src/cli.ts:1 | keep |
| `docs/operation.md` | current | The operation guide tracks current HTTP, WebSocket, docs, runtime-control, and route-verification behavior. | src/server/server.ts:1 | keep |
| `docs/operator-runbook.md` | stale | The operator runbook is useful but will be merged into the Stage 25 runbook tree with operation and troubleshooting content. | src/server/routes/runtime-config-notes.ts:1 | merge-into |
| `docs/planner-redesign-plan.md` | historical | The planner redesign plan remains binding historical design evidence for remediation but is not final operator guidance. | docs/agents.md:1 | move-to-docs/historical/ |
| `docs/release-checklist.md` | stale | The release checklist matches current scripts in broad terms but belongs in the consolidated Stage 25 runbook tree. | scripts/docs-verify.sh:1 | merge-into |
| `docs/second-codebase-review-remediation-cycle.md` | historical | This second-cycle remediation record is a provenance artifact superseded by resolved findings and tests. | audit-findings/README.md:1 | move-to-docs/historical/ |
| `docs/top-level-planner-control-flow-review.md` | historical | The planner control-flow review documents a prior audit state and should not be used as current control guidance. | src/utils/runtime.ts:1 | move-to-docs/historical/ |
| `docs/top-level-planner-mcp-redesign-plan.md` | historical | The top-level planner MCP redesign plan is superseded by `docs/agents.md` and current implementation. | src/agents/agent-adapter.ts:1 | move-to-docs/historical/ |
| `docs/troubleshooting.md` | stale | The troubleshooting guide remains useful but should be folded into the consolidated incidents runbook. | src/utils/stuck-agent-supervisor.ts:1 | merge-into |
| `docs/v3-planner-control-mcp-contract.md` | historical | The V3 planner control MCP contract is a pre-implementation contract retained for provenance and later reconciliation. | src/agents/agent-adapter.ts:1 | move-to-docs/historical/ |
| `future.md` | historical | The future-ideas file is non-authoritative planning material outside the current source-of-truth set. | docs/documentation-inventory.md:1 | move-to-docs/historical/ |
| `use-cases.md` | stale | The use-case catalog is helpful product context but contains assumptions that need reconciliation into the design docs. | web/src/App.vue:1 | merge-into |

## Verification

`npm run docs:verify` runs `scripts/check-doc-inventory.js`, which fails when a tracked Markdown file in the repository root or `docs/` tree is missing from this table or when a table row points to a non-existent file.
