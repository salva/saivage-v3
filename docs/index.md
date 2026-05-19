# Saivage v3

Saivage is an autonomous multi-agent system for software-development work. Current verified behavior is grounded in the current source tree, current tests, and validated repair stages 07-10.

## Current behavior summary

- Goal cards own planning state; operators should not infer strategic completion from an empty ready queue alone.
- Planner-control frames and dispatch records persist under `.saivage/runtime/` so parent planners can suspend and resume around child work.
- Card detail inspection is the supported place to review generated files, verification commands, tool errors, and parse-failure context.
- File preview is safety-constrained: containment checks, secret blocking/redaction, size limits, and binary rejection apply to both direct file browsing and generated-file evidence.
- `/health`, the SPA, and built docs are public surfaces; `/api/*` and `/ws` require the API token when one is configured.
- WebSocket events accelerate UI freshness, but REST snapshots remain the authoritative state after refresh or reconnect.

## Use these docs for current operation

### Getting started

- [Install](/install)
- [Configuration](/configuration)

### Operate Saivage

- [Operator Runbook](/operator-runbook)
- [Operation Guide](/operation)
- [Goal Planning Runtime](/goal-planning-runtime)
- [Troubleshooting](/troubleshooting)
- [Release Checklist](/release-checklist)

### Documentation governance

- [Documentation Inventory](/documentation-inventory)
- See historical: [Historical documentation](/historical/README)

## Verification commands

```bash
npm run docs:verify
npm run docs:build
npm run web:typecheck
npm run web:test:sweep
```

`npm run docs:verify` runs the VitePress build and then verifies expected output pages derived from `docs/*.md`.

## Historical records

Older remediation plans, redesign notes, and audit artifacts remain in the repository for provenance, but they are not current operator authority. See historical: use [Historical documentation](/historical/README) to find them safely.
