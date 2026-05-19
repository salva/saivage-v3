# Saivage v3

Saivage v3 is an autonomous multi-agent runtime for software-development work. A top-level planner decomposes goals into cards, executors perform scoped work, reviewers verify results, and the operator control room exposes cards, agents, files, timeline events, and runtime controls.

## Quick start

Install dependencies:

```bash
npm install
```

Build and serve the control room, API, and docs:

```bash
SAIVAGE_API_TOKEN=test npm run build && SAIVAGE_API_TOKEN=test ./bin/saivage.js start --create-runtime
```

Open the web UI at `http://localhost:8080/`, or check health with:

```bash
curl http://localhost:8080/health
```

## Current documentation

- [Operator runbook](docs/runbook/index.md) — start, pause, resume, freeze, diagnose, and release Saivage.
- [Design documentation](docs/design/index.md) — canonical concept map for cards, agents, runtime, security, data, and UX.
- [Documentation index](docs/index.md) — curated table of contents for current docs and findings dossiers.
- [Documentation inventory](docs/documentation-inventory.md) — source-of-truth status for every root and `docs/` Markdown file.
- See historical: [Historical documentation](docs/historical/README.md) — provenance-only plans, audits, and pre-consolidation designs.

## Key concepts

- [Card model](docs/design/card-model.md) — goal cards, statuses, priority, evidence, and persisted card shape.
- [Card lifecycle](docs/design/card-lifecycle.md) — planner/executor/reviewer transitions and correction paths.
- [Agents](docs/design/agents.md) — analyst, planner, executor, and reviewer responsibilities.
- [Runtime](docs/design/runtime.md) — scheduler, durable runtime state, directives, and recovery flow.
- [Security](docs/design/security.md) — authentication, redaction, file-safety, and provider-error handling.
- [Configuration](docs/design/configuration.md) — project config, providers, runtime knobs, and migrations.
- [Skills](docs/design/skills.md) — reusable agent capabilities and workspace tooling boundaries.
- [Server API](docs/design/server-api.md) — HTTP, WebSocket, docs, and static serving surfaces.
- [Data model](docs/design/data-model.md) — persisted JSON/JSONL records and invariants.
- [UX design](docs/design/ux-design.md) — operator control room views and interaction contracts.
- [Decisions](docs/design/decisions.md) — design choices and dossier-organization rationale.
- [Implementation plan](docs/design/implementation-plan.md) — consolidated delivery plan context.

## Verification

Run the final documentation and code gates from the repository root:

```bash
npm run docs:verify
npm run typecheck
npm run build
npm test
```

`npm run docs:verify` builds VitePress and checks documentation inventory completeness, route/role/config/runtime anchors, historical isolation, runbook curl examples, design-doc link boundaries, global Markdown internal links, documented validation-command parity, and docs:verify sub-guard entry points.
