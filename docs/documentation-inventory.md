# Documentation inventory

This inventory reconciles Saivage v3 documentation after validated repair stages 07-10. It distinguishes current operator/reference docs from historical audit and remediation artifacts.

## Classification legend

- **current** — matches current source, tests, and accepted repair outcomes.
- **stale** — partly useful, but incomplete against current behavior.
- **misleading** — likely to send operators or maintainers toward wrong current behavior.
- **obsolete** — superseded by the redesigned and repaired system.
- **historical** — preserved for provenance only; not current operator guidance.
- **missing** — needed coverage that did not previously exist or was insufficient.

## Current behavior anchors

Primary anchors used for this inventory:

- Docs build and serving: `package.json`, `scripts/docs-verify.sh`, `docs/.vitepress/config.ts`, `src/server/server.ts`, `tests/server/spa-static-serving.test.ts`
- Auth, public docs, and WebSocket protection: `src/server/auth.ts`, `src/server/websocket.ts`, `tests/server/auth-mode.test.ts`, `web/src/__tests__/nav-rail.test.ts`
- Runtime controls and freeze/resume: `src/server/server.ts`, `src/server/routes/runtime-config-notes.ts`, `src/utils/runtime-state.js`, `src/utils/freeze-manifest.js`
- Card detail evidence and safe generated-file inspection: `src/server/routes/cards.ts`, `src/server/routes/chats-files-debug.ts`, `tests/server/generated-file-inspection.test.ts`, `web/src/__tests__/card-detail-view.test.ts`
- Safe process views: `src/server/routes/processes.ts`, `tests/server/processes-api.test.ts`
- Operator-state UI coverage: `web/src/__tests__/dashboard-view.test.ts`, `web/src/__tests__/agents-view.test.ts`, `web/src/__tests__/files-view.test.ts`, `web/src/__tests__/workspace-header.test.ts`

## Active docs inventory

| Path | Classification | Rationale |
|---|---|---|
| `README.md` | current | Updated to point at current docs and historical artifacts separately. |
| `docs/index.md` | current | Landing page for active docs and authoritative current behavior summary. |
| `docs/install.md` | current | Build/install guide for current docs/server/web layout. |
| `docs/configuration.md` | current | Active configuration reference. |
| `docs/operation.md` | current | Current runtime, health, freeze/resume, process, docs, and verification guidance. |
| `docs/operator-runbook.md` | current | Current operator workflows for Dashboard, Cards, Agents, Files, Debug, Docs, and recovery paths. |
| `docs/goal-planning-runtime.md` | current | Current planner-control and goal-owned planning model. |
| `docs/troubleshooting.md` | current | Symptom-based troubleshooting aligned to current API/UI behavior. |
| `docs/release-checklist.md` | current | Release verification gates aligned to current scripts and documentation policy. |
| `docs/documentation-inventory.md` | current | This inventory. |
| `docs/historical-artifacts.md` | current | Index and labeling policy for non-authoritative historical material. |
| `docs/.vitepress/config.ts` | current | Active VitePress navigation/build config for the live docs surface; defines docs base path plus the current nav and sidebar information architecture for active pages. Verified against `package.json` (`docs:build`), `scripts/docs-verify.sh`, and current docs page set. |

## Historical docs retained but non-authoritative

These pages remain available for provenance but are not current operator instructions.

| Path | Classification | Why historical |
|---|---|---|
| `docs/full-codebase-review-remediation-plan.md` | historical | Audit/remediation record from a pre-repair phase. |
| `docs/second-codebase-review-remediation-cycle.md` | historical | Follow-up remediation-cycle record, not current product guidance. |
| `docs/executor-workspace-tooling-failure-report.md` | historical | Incident record predating Stage 08 repairs. |
| `docs/executor-workspace-tooling-remediation-plan.md` | historical | Superseded remediation plan. |
| `docs/top-level-planner-control-flow-review.md` | historical | Pre-repair review of planner control behavior. |
| `docs/top-level-planner-mcp-redesign-plan.md` | historical | Redesign plan superseded by later implementation. |
| `docs/v3-planner-control-mcp-contract.md` | historical | Pre-implementation contract, not the live implementation reference. |
| `inspections/stage-01-*.md` through `inspections/stage-06-*.md` | historical | Accepted audit/redesign inputs preserved as evidence, not operator docs. |

## Root markdown inventory

| Path | Classification | Rationale |
|---|---|---|
| `README.md` | current | Current project entry point. |
| `01-card-model.md` | obsolete | Early design-era model, not maintained as active authority. |
| `02-card-lifecycle.md` | obsolete | Predates current planner-control and review/evidence semantics. |
| `03-agents.md` | obsolete | Predates role/tool-policy repairs. |
| `04-runtime.md` | obsolete | Predates current runtime and freeze/process repairs. |
| `05-security.md` | obsolete | Predates current containment/redaction/process safety behavior. |
| `06-configuration.md` | obsolete | Duplicates active docs and risks drift. |
| `07-skills.md` | stale | Historical design context, not active reference. |
| `08-server-api.md` | obsolete | Predates current endpoint and security behavior. |
| `09-data-model.md` | obsolete | Predates current state/schema redesign. |
| `10-ux-design.md` | obsolete | Encodes superseded UI and visible-plan-card assumptions. |
| `11-decisions.md` | stale | Historical decisions log, not current operator authority. |
| `12-implementation-plan.md` | obsolete | Superseded staged plan. |
| `bugs.md` | historical | Historical bug note. |
| `future.md` | historical | Non-authoritative future ideas. |
| `use-cases.md` | misleading | Includes superseded visible plan-card assumptions. |

## Missing coverage addressed in Stage 11

The following previously missing or insufficient topics are now covered in active docs:

- Current Web Control Room operator workflows
- Public docs vs token-protected API/WebSocket behavior
- Freeze and `resume-from-freeze` operator procedures
- Safe generated-file preview states and evidence inspection
- Safe process views and process-control constraints
- Historical-artifact labeling policy
- Documentation inventory and authority boundaries
- Active docs navigation/build config coverage for the live docs IA

## Documentation policy

Active docs describe current source/test-verified behavior. Historical audit, redesign, remediation, and generated-plan documents are not authoritative unless a current active doc explicitly revalidates them against current source and tests.
