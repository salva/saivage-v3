# Saivage v3

An autonomous multi-agent system for software development.

## Current verified behavior

Saivage currently provides:

- a goal-level **Planner → Executor → Reviewer** workflow with planning state stored on goals rather than separate visible plan cards;
- durable planner-control frames and dispatch records under `.saivage/runtime/` so parent planners can suspend and resume around child work;
- a Fastify API server with token-protected `/api/*` and `/ws`, plus public `/health`, SPA, and built docs under `/docs/`;
- card detail evidence inspection for generated files, verification commands, tool errors, and parse-failure context;
- safe text-file preview with containment, secret blocking/redaction, size limits, and binary rejection;
- operator-safe process views instead of raw process-registry records.

## Active documentation

- [Docs index](docs/index.md)
- [Design documentation](docs/design/index.md)
- [Install guide](docs/install.md)
- [Configuration reference](docs/configuration.md)
- [Operations guide](docs/operation.md)
- [Goal planning runtime](docs/goal-planning-runtime.md)
- [Operator runbook](docs/operator-runbook.md)
- [Troubleshooting](docs/troubleshooting.md)
- [Release checklist](docs/release-checklist.md)
- [Documentation inventory](docs/documentation-inventory.md)
- [Historical artifacts policy](docs/historical-artifacts.md)

## Verification commands

```bash
npm run docs:verify
npm run web:typecheck
npm run web:test:sweep
npm run typecheck
```

`npm run docs:verify` already runs the VitePress build and verifies expected output pages.

## Historical material

Historical audits, remediation plans, and earlier design-era markdown files are preserved as repository evidence but are **not** current operator instructions. Start with the active docs above, then use [docs/historical-artifacts.md](docs/historical-artifacts.md) if you need provenance.
