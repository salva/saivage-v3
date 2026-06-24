# Saivage v3 Instructions

This repository root is `/home/salva/g/ml/saivage-v3`.

Read `AGENTS.md`, `/home/salva/g/ml/WORKSPACE_HANDOFF.md`, and `/home/salva/g/ml/CODEX_PROJECT_MEMORY.md` before changing Saivage deployments, runtime state, or long-running autonomous processes.

## Authority

- `docs/spec/system-specification.md` is the current functional authority.
- `docs/spec/operator-ui.md` is the current operator UI authority.
- `docs/architecture/system-architecture.md` is the current architecture summary.
- `README.md` defines validation profiles and the current documentation map.

Historical material under `docs-old/` is provenance unless current docs cite it.

## Skills

Project-local skills live under `.github/skills/`. Workspace skills remain available from `/home/salva/g/ml/.github/skills` for broader operations.

## Validation

Use focused tests for small changes, then broaden according to risk:

```bash
npm run validate:docs
npm run validate:routine
npm run validate:ui-smoke
npm run validate:ui
npm run validate:release
```

For the bind-mounted GetRich v2 deployment, build on the host before restarting:

```bash
npm run build
ssh root@10.0.3.170 'systemctl restart saivage-v3-getrich.service && systemctl is-active saivage-v3-getrich.service'
curl -fsS http://10.0.3.170:8080/health
```

Do not print tokens, provider configs, `.saivage/auth-profiles.json`, `.saivage/saivage.json`, env files, or backups. API bearer tokens must not be placed in URLs.
