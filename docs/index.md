# Saivage v3 documentation

Use this index as the current entry point for operator procedures, design references, provenance records, and remediation dossiers.

## Runbook

- [Runbook index](/runbook/) — single operator entry point.
- [Operations](/runbook/operations) — startup, auth, health, state, runtime controls, WebSocket chat, backups, and LXC/systemd notes.
- [Incidents](/runbook/incidents) — unauthorized access, stale UI, frozen/error runtime recovery, preview limitations, and degraded-agent workflows.
- [Release](/runbook/release) — release-candidate validation gates.
- [LXC operations](/runbook/lxc-operations) — deployment-oriented service checks and safe restart flow.

## Design

- [Design index](/design/) — concept-level map for the consolidated design tree.
- [Card model](/design/card-model) — card fields, status, priority, evidence, and persisted records.
- [Card lifecycle](/design/card-lifecycle) — planner/executor/reviewer transitions.
- [Agents](/design/agents) — analyst, planner, executor, reviewer, and tool boundaries.
- [Runtime](/design/runtime) — scheduler, durable state, directives, and recovery.
- [Security](/design/security) — auth, redaction, safe file access, and provider failures.
- [Configuration](/design/configuration) — project settings and runtime knobs.
- [Skills](/design/skills) — skill loading and workspace-tool constraints.
- [Server API](/design/server-api) — HTTP and WebSocket surfaces.
- [Data model](/design/data-model) — persisted JSON and JSONL shapes.
- [UX design](/design/ux-design) — operator control room layout and interaction patterns.
- [Decisions](/design/decisions) — design choices and findings-dossier rationale.
- [Implementation plan](/design/implementation-plan) — consolidated implementation context.

## Source-of-truth references

- [Agents and runtime architecture](/agents) — authoritative planner/runtime contract.
- [Analyst guide](/analyst) — analyst-facing tools and WebSocket behavior.
- [Configuration reference](/configuration) — schema-aligned configuration details.
- [Operation route inventory](/operation) — documented operator-facing HTTP and WebSocket routes.
- [Goal planning runtime](/goal-planning-runtime) — legacy runtime summary retained for current context.
- [Documentation inventory](/documentation-inventory) — classification and disposition for every root and `docs/` Markdown file.

## Findings dossiers

- [Audit findings](../audit-findings/README.md) — source-vs-docs remediation dossier and remediation log.
- [Audit coverage](../audit-findings/coverage.md) — audit coverage notes.
- [Audit cross-references](../audit-findings/cross-references.md) — finding cross-reference map.
- [UI findings](../ui-findings/README.md) — operator-surface remediation dossier and remediation log.

## Provenance

- See historical: [Historical documentation](/historical/README) — archived plans, audits, and pre-consolidation design records.
- See historical: [2026 documentation consolidation summary](/historical/2026-doc-consolidation-summary) — Stage 21-26 consolidation outcome.
- See historical: [2026 pre-consolidation design](/historical/2026-pre-consolidation/01-card-model) — original numbered design series.
- See historical: [2026-05 remediation dossiers](/historical/2026-05-remediation-dossiers/historical-artifacts) — archived remediation and review plans.
