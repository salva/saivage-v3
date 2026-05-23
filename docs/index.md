# Saivage v3 documentation

<!-- doc-authority
status: current
disposition: keep
owner: docs-maintainers
superseded_by: none
last_verified_against: docs/.vitepress/config.ts:1
-->

Use this index as the current entry point for operator procedures, design references, provenance records, and remediation dossiers. Each prominent link is labeled before click-through as current authority, stale context, or historical provenance according to `docs/documentation-inventory.md`.

## Runbook

- [Runbook index](/runbook/) — current authority: single operator entry point.
- [Operations](/runbook/operations) — current authority: startup, auth, health, state, runtime controls, WebSocket chat, backups, and LXC/systemd notes.
- [Incidents](/runbook/incidents) — current authority: unauthorized access, stale UI, frozen/error runtime recovery, preview limitations, and degraded-agent workflows.
- [Release](/runbook/release) — current authority: release-candidate validation gates.
- [LXC operations](/runbook/lxc-operations) — current authority: deployment-oriented service checks and safe restart flow.

## Design

<!-- doc-authority-status:start -->
| Link | Authority status | Reader guidance |
|---|---|---|
| [Design index](/design/) | current authority | Concept-level map for the consolidated design tree; follow each linked page status. |
| [Card model](/design/card-model) | stale context | Useful design-era context; prefer `docs/agents.md` and current card-store/source behavior. |
| [Card lifecycle](/design/card-lifecycle) | stale context | Useful design-era context; prefer `docs/agents.md` and current planner-tool/runtime source behavior. |
| [Agents](/design/agents) | stale context | Useful design-era context; prefer [Agents and runtime architecture](/agents). |
| [Runtime](/design/runtime) | stale context | Useful design-era context; prefer [Agents and runtime architecture](/agents). |
| [Security](/design/security) | stale context | Useful design-era context; prefer [Operation route inventory](/operation). |
| [Configuration](/design/configuration) | stale context | Useful design-era context; prefer [Configuration reference](/configuration). |
| [Skills](/design/skills) | stale context | Useful design-era context; prefer [Agents and runtime architecture](/agents). |
| [Server API](/design/server-api) | stale context | Useful design-era context; prefer [Operation route inventory](/operation). |
| [Data model](/design/data-model) | stale context | Useful design-era context; prefer `docs/agents.md` and current validators/source behavior. |
| [UX design](/design/ux-design) | stale context | Useful design-era context; prefer [Operation route inventory](/operation) and current web source behavior. |
| [Decisions](/design/decisions) | historical provenance | Provenance-only design choices; prefer [Agents and runtime architecture](/agents) for current behavior. |
| [Implementation plan](/design/implementation-plan) | historical provenance | Provenance-only delivery context; prefer current source, runbook, and remediation dossiers. |
<!-- doc-authority-status:end -->

## Source-of-truth references

- [Agents and runtime architecture](/agents) — current authority: authoritative planner/runtime contract.
- [Analyst guide](/analyst) — current authority: analyst-facing tools and WebSocket behavior.
- [Configuration reference](/configuration) — current authority: schema-aligned configuration details.
- [Operation route inventory](/operation) — current authority: documented operator-facing HTTP and WebSocket routes.
- [Goal planning runtime](/goal-planning-runtime) — stale context: legacy runtime summary retained for context; prefer [Agents and runtime architecture](/agents).
- [Documentation inventory](/documentation-inventory) — current authority: classification and disposition for every root and `docs/` Markdown file.

## Provenance

- See historical: [Historical documentation](/historical/README) — historical provenance: archived plans, audits, and pre-consolidation design records.
- See historical: [2026 documentation consolidation summary](/historical/2026-doc-consolidation-summary) — historical provenance: Stage 21-26 consolidation outcome.
- See historical: [2026 pre-consolidation design](/historical/2026-pre-consolidation/01-card-model) — historical provenance: original numbered design series.
- See historical: [2026-05 remediation dossiers](/historical/2026-05-remediation-dossiers/historical-artifacts) — historical provenance: archived remediation and review plans.
