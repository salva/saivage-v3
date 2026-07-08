# Saivage v3 Instructions

This repository root is `/home/salva/g/ml/saivage-v3`.

`AGENTS.md` is the shared instruction source for this project. Read it first and avoid duplicating project policy here.

Read `/home/salva/g/ml/WORKSPACE_HANDOFF.md` and `/home/salva/g/ml/CODEX_PROJECT_MEMORY.md` before changing Saivage deployments, runtime state, or long-running autonomous processes.

## Shared Sources

- Project rules and authority map: `AGENTS.md`.
- Reusable workflows: `.github/skills/*/SKILL.md`.
- OpenCode shim: `.opencode/opencode.json` loads `AGENTS.md` and `.github/skills/`.

GitHub Copilot does not auto-load OpenCode skills. When a task matches a workflow under `.github/skills/`, read that `SKILL.md` and follow it.

Do not add symlinked or duplicate tool-specific skill trees; keep `.github/skills/` as the shared project-local source of truth.

Do not print tokens, provider configs, `.saivage/auth-profiles.json`, `.saivage/saivage.yaml`, env files, or backups. API bearer tokens must not be placed in URLs.
