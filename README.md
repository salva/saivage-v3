# Saivage v3 — Design Documents

## Documents

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
