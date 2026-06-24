# Saivage v3 AI Agent Instructions


Scope: `/home/salva/g/ml/saivage-v3`.

Read `/home/salva/g/ml/CODEX_PROJECT_MEMORY.md` and the current docs before substantial work here. OpenCode loads this file through `.opencode/opencode.json` because `saivage-v3` is its own Git repository.

## Current Authority

- `docs/spec/system-specification.md` for functional behavior.
- `docs/spec/operator-ui.md` for operator UI behavior.
- `docs/architecture/system-architecture.md` for system architecture.
- `README.md` for validation profiles and documentation authority status.

See historical: docs under `docs-old/` and stale design docs are provenance, not implementation authority.

## Validation

```bash
npm run validate:docs
npm run validate:routine
npm run validate:ui-smoke
npm run validate:ui
npm run validate:release
```

Use focused Jest/Vitest commands for small changes, then broaden according to risk.

## Architecture Principles

- Simple and clean architecture. No backward compatibility, no compatibility shims, no migration code.
- Fail fast for impossible states. If a code path should be unreachable under correct operation, throw rather than silently recovering, normalizing, or returning fallback values.
- No over-defensive code. Do not guard against states that cannot happen or that we do not know how to handle. If we cannot handle it, let it crash loudly.
- Brave refactoring. When needed, tackle complex, large, or deep changes rather than patching around symptoms.
- Remove dead code aggressively. Do not preserve unused paths, deprecated overloads, or legacy fallbacks.

## Safety

- Do not print tokens, provider configs, `.saivage/auth-profiles.json`, `.saivage/saivage.json`, env files, or backups.
- API bearer tokens must not be placed in URLs.
- Treat `.saivage/stages/**` and `.saivage/runtime/**` as live/generated runtime state unless the task targets them.
