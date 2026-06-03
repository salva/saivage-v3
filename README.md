# Saivage v3

<!-- doc-authority
status: current
disposition: keep
owner: docs-maintainers
superseded_by: none
last_verified_against: package.json:1
-->

Saivage v3 is an autonomous multi-agent runtime for software-development work. A top-level planner decomposes goals into cards, executors perform scoped work, reviewers verify results, and the operator control room exposes cards, agents, files, timeline events, and runtime controls.

## Quick start

Use Node.js 24 (the repository engines require `node >=24 <25` and `npm >=10 <12`, matching the GitHub Actions validation profile), then install dependencies:

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

<!-- doc-authority-status:start -->
| Link | Authority status | Reader guidance |
|---|---|---|
| [Operator runbook](docs/runbook/index.md) | current authority | Start, pause, resume, freeze, diagnose, and release Saivage from the implemented runbook. |
| [Design documentation](docs/design/index.md) | current authority | Use as the concept map for design-era pages; follow status labels before relying on linked topic pages. |
| [Documentation index](docs/index.md) | current authority | Curated table of contents for current docs and findings dossiers. |
| [Documentation inventory](docs/documentation-inventory.md) | current authority | Source-of-truth ledger for every root and `docs/` Markdown file classification/disposition. |
| See historical: [Historical documentation](docs/historical/README.md) | historical provenance | Provenance-only plans, audits, and pre-consolidation designs; not current operator guidance. |
<!-- doc-authority-status:end -->

## Key concepts

| Link | Authority status | Reader guidance |
|---|---|---|
| [Card model](docs/design/card-model.md) | stale context | Useful design-era context; prefer `docs/agents.md` and current card-store/source behavior for implementation authority. |
| [Card lifecycle](docs/design/card-lifecycle.md) | stale context | Useful design-era context; prefer `docs/agents.md` and current planner-tool/runtime source behavior. |
| [Agents](docs/design/agents.md) | stale context | Useful design-era context; prefer [Agents and runtime architecture](docs/agents.md). |
| [Runtime](docs/design/runtime.md) | stale context | Useful design-era context; prefer [Agents and runtime architecture](docs/agents.md). |
| [Security](docs/design/security.md) | stale context | Useful design-era context; prefer [Operation guide](docs/operation.md) and current redaction/auth source behavior. |
| [Configuration](docs/design/configuration.md) | stale context | Useful design-era context; prefer [Configuration reference](docs/configuration.md). |
| [Skills](docs/design/skills.md) | stale context | Useful design-era context; prefer [Agents and runtime architecture](docs/agents.md). |
| [Server API](docs/design/server-api.md) | stale context | Useful design-era context; prefer [Operation guide](docs/operation.md). |
| [Data model](docs/design/data-model.md) | stale context | Useful design-era context; prefer `docs/agents.md` and current validators/source behavior. |
| [UX design](docs/design/ux-design.md) | stale context | Useful design-era context; prefer [Operation guide](docs/operation.md) and current web source behavior. |
| [Decisions](docs/design/decisions.md) | historical provenance | Provenance-only design choices; prefer [Agents and runtime architecture](docs/agents.md) for current behavior. |
| [Implementation plan](docs/design/implementation-plan.md) | historical provenance | Provenance-only delivery context; prefer current source, runbook, and remediation dossiers. |

## Verification

Run the validation profile that matches the change type; see the [validation matrix](docs/runbook/release.md#validation-matrix) for details. The checked-in GitHub Actions workflow at [`.github/workflows/validation.yml`](.github/workflows/validation.yml) is least-privilege and secret-free (`contents: read`, no `secrets.*` or token-like env assignments), cancels superseded runs for the same workflow/ref, sets up Node.js 24 with npm caching, installs with `npm ci`, and runs `npm run validate:routine` plus `npm run validate:docs` automatically on push/pull request. `workflow_dispatch` inputs expose the heavier `npm run validate:ui-smoke` and `npm run validate:release` profiles as manual gates.

```bash
npm run validate:docs
npm run validate:routine
npm run validate:ui-smoke
npm run validate:ui
npm run validate:release
```

For final stage/release gates, run the underlying checks directly when requested:

```bash
npm run docs:verify
npm run typecheck
npm run build
npm test
npm run web:test:operator-smoke
```

`npm run docs:verify` builds VitePress and checks documentation inventory completeness, authority metadata/status surfaces, route/role/config/runtime anchors, historical isolation, runbook curl examples, design-doc link boundaries, global Markdown internal links, documented validation-command parity, and docs:verify sub-guard entry points. It verifies that `npm run web:test:operator-smoke` exists and is documented, but intentionally does not execute that Vitest smoke guard so routine docs verification stays lightweight. Run `npm run web:test:operator-smoke` directly after operator-dashboard changes and during release sign-off.
