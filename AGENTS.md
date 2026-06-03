# Saivage v3 AI Agent Instructions

<!-- doc-authority
status: current
disposition: keep
owner: docs-maintainers
superseded_by: none
last_verified_against: scripts/check-doc-authority-metadata.js:1
-->

Scope: `/home/salva/g/ml/saivage-v3`.

Read `/home/salva/g/ml/CODEX_PROJECT_MEMORY.md` and the current docs before substantial work here. OpenCode loads this file through `.opencode/opencode.json` because `saivage-v3` is its own Git repository.

## Current Authority

- `docs/agents.md` for agent/runtime architecture.
- `docs/runbook/index.md` for operator procedures.
- `docs/operation.md` for API, auth, runtime control, evidence, and file browsing.
- `README.md` for validation profiles and documentation authority status.

See historical: docs under `docs/historical/` and stale design docs are provenance, not implementation authority.

## Validation

```bash
npm run validate:docs
npm run validate:routine
npm run validate:ui-smoke
npm run validate:ui
npm run validate:release
```

Use focused Jest/Vitest commands for small changes, then broaden according to risk.

## Safety

- Do not print tokens, provider configs, `.saivage/auth-profiles.json`, `.saivage/saivage.json`, env files, or backups.
- API bearer tokens must not be placed in URLs.
- Treat `.saivage/stages/**` and `.saivage/runtime/**` as live/generated runtime state unless the task targets them.
