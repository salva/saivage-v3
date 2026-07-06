# Saivage v3 AI Agent Instructions


Scope: `/home/salva/g/ml/saivage-v3`.

Read `/home/salva/g/ml/CODEX_PROJECT_MEMORY.md` and the current docs before substantial work here. OpenCode loads this file through `.opencode/opencode.json` because `saivage-v3` is its own Git repository.

This file is the shared project instruction source for AI development tools. Keep
tool-specific files such as `.github/copilot-instructions.md` and
`.opencode/opencode.json` as thin compatibility shims that point back here
rather than duplicating project policy.

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

## Shared Skills

Reusable project workflows live under `.github/skills/<skill>/SKILL.md`.

- OpenCode loads these skills directly through `.opencode/opencode.json`.
- GitHub Copilot does not auto-load OpenCode skills; when a task matches a skill description, read the relevant `SKILL.md` and follow it as the project-local workflow.
- Do not add symlinked or duplicate tool-specific skill trees. Keep `.github/skills/` as the shared source of truth.

Current high-value skills include:

- `saivage-development-validation`: validation after Saivage v3 code, docs, UI, API, or deployment changes.
- `saivage-lxc-operations`: LXC operations for Saivage v3-relevant deployments such as the v2-on-v3 harness, GetRich v2, and Pueblicos.
- `saivage-project-reset`: reset target projects managed by Saivage v3 deployments, such as GetRich v2 or Pueblicos.
- `saivage-v3-mailbox-submit`: submit proposals to the v2-on-v3 harness mailbox.
- `iterative-dual-llm-review`: heavyweight systematic review workflow when explicitly requested.

## Engineering Priorities

Clean, simple architecture and code are the top priority. Prefer the design that
makes the system easier to understand and change, even when that requires a
large or cross-cutting refactor.

- No backward compatibility. Breaking internal or external APIs is acceptable when it produces the correct current design.
- No bridge, adapter, shim, migration, dual-path, or legacy-normalization code. Update all components and call sites to the current API instead.
- No over-engineered designs. Keep abstractions minimal, direct, and justified by current behavior.
- Think holistically. Fix root causes across the relevant subsystem rather than adding local band-aids.
- Be brave with refactors. Do not choose small/easy changes merely because they are easier if a broader change is the right fix.
- Remove dead code aggressively. Do not preserve unused paths, deprecated overloads, or legacy fallbacks.

## Runtime Coding Rules

- Fail fast for impossible states. If a code path should be unreachable under correct operation, throw rather than silently recovering, normalizing, or returning fallback values.
- No over-defensive code. Do not guard against states that cannot happen or that we do not know how to handle. If we cannot handle it, let it crash loudly.
- Keep data models and API contracts singular. When a contract changes, update producers, consumers, tests, docs, and deployment assumptions in the same change set.

## Testing Priorities

- Do not complicate production code or architecture for the sake of tests.
- Small helpers that make tests simpler are acceptable when they also keep production code clear.
- Testing is not the main priority; clean architecture and simple code are.
- E2E tests are the highest-trust tests. Unit and integration tests are useful, but do not treat them as proof that behavior is correct.
- Do not chase 100% coverage. Around 60-70% coverage is acceptable when the important user/runtime paths are covered.
- Prefer fewer high-value tests over broad low-value coverage that forces abstractions, mocks, adapters, or brittle seams into production code.

## Safety

- Do not print tokens, provider configs, `.saivage/auth-profiles.json`, `.saivage/saivage.json`, env files, or backups.
- API bearer tokens must not be placed in URLs.
- Treat `.saivage/stages/**` and `.saivage/runtime/**` as live/generated runtime state unless the task targets them.
