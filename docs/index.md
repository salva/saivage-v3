# Saivage v3

An autonomous multi-agent system for software development.

## What is Saivage?

Saivage is an autonomous multi-agent system that uses a **Planner → Executor → Reviewer** goal workflow to execute software development tasks. It maintains a persistent card store, stores planning state on goal cards, and provides a Fastify-based API server with WebSocket events.

## Quick Links

- **[Installation Guide](/install)** — Set up Saivage v3 from a clean checkout
- **[Configuration Reference](/configuration)** — Configure models, providers, MCP servers, Telegram, and notifications
- **[Operation Guide](/operation)** — Runtime management, API usage, backup, recovery, and web verification commands
- **[Goal Planning Runtime](/goal-planning-runtime)** — Goal-owned planning state and planner/executor/reviewer contract
- **[Operator Runbook](/operator-runbook)** — Day-to-day operator procedures and local verification commands
- **[Troubleshooting](/troubleshooting)** — Common issues and their solutions
- **[Release Checklist](/release-checklist)** — Steps to create a new release
- **[Full Codebase Review Remediation Plan](/full-codebase-review-remediation-plan)** — Current review findings, staged fixes, and validation loop
- **[Second Review Remediation Cycle](/second-codebase-review-remediation-cycle)** — Follow-up findings, analyst fixes, and live validation plan

## Verifying the Web Control Room

The Web Control Room SPA can be verified independently of the backend test suite using root-level npm scripts. See the **[Operation Guide → Web Verification Commands](/operation#web-verification-commands)** for the full set of commands, or run a quick sweep:

```bash
npm run web:typecheck
npm run web:test:sweep
```

These commands exercise the SPA's views, stores, and TypeScript types without touching backend agent logic or MCP integration tests.

## Architecture

Saivage uses a goal-level multi-agent architecture with these key roles:

- **Planner** — Goal strategist that creates and updates child cards, then returns `continue`, `done`, or `blocked`
- **Executor** — Runs concrete terminal cards such as code, test, doc, data, research, and ops work
- **Reviewer** — Validates completed goals and either passes them or sends them back to the planner

The system maintains all state in a project-local `.saivage` directory using a JSON-based card store.

### Verified v3 control and evidence behavior

Current verified behavior includes:

- Durable planner-control frames and dispatch records under `.saivage/runtime/` so project and goal planners can suspend while child work runs, then resume and create follow-up work when acceptance criteria remain incomplete.
- Executor evidence fallback: if an executor performs workspace/tool actions but returns malformed final JSON, Saivage preserves generated files, verification commands, tool errors, artifact paths, and parse-failure context for parent planners/reviewers.
- Card detail generated-file inspection: `GET /api/cards/:id` returns normalized evidence for that card, and the Web Control Room card detail view can preview recorded text files with path containment, secret blocking/redaction, size limits, and binary-file rejection. This evidence enrichment is detail-route only; list/board responses still require opening or fetching the card detail when generated-file metadata is needed.
