# Saivage v3 — Design Documents


## Current Verified v3 Behavior

The current recovery-cycle verification confirms these operator-relevant behaviors:

- Durable planner-control frames and dispatch records under `.saivage/runtime/` allow project and goal planners to suspend while child work runs, then resume and create follow-up work when acceptance criteria remain incomplete.
- Executor evidence fallback preserves generated files, verification commands, tool errors, artifact paths, and parse-failure context when workspace/tool work succeeded but the executor's final JSON is malformed.
- Card detail generated-file inspection is available through `GET /api/cards/:id` and the Web Control Room card detail view. Evidence enrichment is detail-route only; list/board views must fetch card detail for generated-file metadata.

## Documentation

| Document | Contents |
|---|---|
| [Install Guide](docs/install.md) | Prerequisites, installation, first run |
| [Configuration](docs/configuration.md) | Config file reference and examples |
| [Operations Guide](docs/operation.md) | Start/stop, runtime management, backup/recovery |
| [Troubleshooting](docs/troubleshooting.md) | Common issues and solutions |
| [Release Checklist](docs/release-checklist.md) | Pre-release verification steps |
| [Operator Runbook](docs/operator-runbook.md) | Daily ops and incident response |
| [Full Codebase Review Remediation Plan](docs/full-codebase-review-remediation-plan.md) | Review findings, staged fixes, and validation loop |

## Design Documents

| Document | Contents |
|---|---|
| [Card Model](01-card-model.md) | Card types, planning mechanism, card fields, hierarchy rules. |
| [Card Lifecycle](02-card-lifecycle.md) | States, transitions, permissions, leaderboard/board/timeline views. |
| [Agents](03-agents.md) | Agent model, analyst, planner, executor, reviewer roles and tools. |
| [Runtime](04-runtime.md) | Runtime loop, startup/shutdown, crash recovery, locking, health checks, event bus, self-check, compaction, agent invocation recovery. |
| [Security](05-security.md) | Content supervisor, prompt injection scanning, agent conventions, stash. |
| [Configuration](06-configuration.md) | Config schema, model routing, failover, provider accounts, MCP servers, Telegram, notifications, authentication. |
| [Skills](07-skills.md) | Skill discovery, matching, loading, format. |
| [Server & API](08-server-api.md) | HTTP API routes, WebSocket protocol, Telegram channel, API authentication. |
| [Data Model & File Tree](09-data-model.md) | Entity schemas, persistent metadata layout, generated output layout, cleanup policy. |
| [UX Design](10-ux-design.md) | Web UI layout, navigation, section behavior, UX coverage checklist. |
| [Decisions](11-decisions.md) | Deferred items, persistence summary, web UI summary. |
| [Implementation Plan](12-implementation-plan.md) | Staged implementation plan with scope boundaries and acceptance criteria. |
