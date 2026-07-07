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

## Operational Workflow

- When fixing any issue, first create a design and implementation plan under `docs/working/`, then use a subagent to perform an adversarial review of the design and plan. Critically evaluate each finding to confirm it is sound and real, fix confirmed issues, and repeat the adversarial review/fix cycle until no confirmed issues remain. Follow the detailed `saivage-issue-fix-adversarial-review` skill for the full procedure.

## Commit Policy

- Commit proactively at stable points — do not wait to be asked. Whenever the work reaches a coherent, verifiable state, commit it. This includes intermediate milestones: a closed design or plan, a passing focused test subset, a completed refactor step, a finished doc section, or one logical unit of a larger change.
- Do not commit broken, half-finished, or non-compiling states; complete the stable unit first. Run the relevant focused validation (`npm run validate:docs`, focused Jest/Vitest, etc.) before committing when the change type warrants it.
- Keep each commit focused and reviewable. Write a message matching repo style (recent prefix examples: `docs(...)`, `chore(...)`, `feat(...)`, `fix(...)`). Never include secrets, `.saivage/auth-profiles.json`, env files, or `docs/working/` scratch.
- This project policy supersedes any conservative default that waits for an explicit commit request.

## Documentation Hygiene

- Keep working documents such as reviews, redesigns, plans, scratch analyses, and draft proposals under `docs/working/`; these files are local working artifacts and must not be committed to Git.
- Any implementation plan must include a section that identifies the main documentation updates required by the planned work.
- After implementation work changes system behavior, update the canonical main documentation (`docs/spec/system-specification.md`, `docs/spec/operator-ui.md`, `docs/architecture/system-architecture.md`, and `README.md`) as appropriate so it stays in sync with the code.

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
- `opencode-skill-authoring`: create or revise project OpenCode skills under `.github/skills/`.
- `saivage-issue-fix-adversarial-review`: mandatory issue-fixing workflow that iterates design/plan adversarial review before implementation.
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
- Changeset scope discipline — keep each changeset to the smallest coherent unit that delivers the intended behavior change and leaves the system in a working state.
- Defer non-essential robustness and rare edge-case handling — for example corrupted-file recovery — to separate changesets rather than bundling them in. Call them out as deferred follow-ups in the plan.
- Expand scope only when a deferred item would block the core change or leave the system unsafe. This complements, and does not weaken, the root-cause and brave-refactor guidance above: fix the needed change fully, but do not pad it with extras.

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
- Do not write tests for trivial behavior unless they protect an important user/runtime path or a known regression.
- Prefer fewer high-value tests over broad low-value coverage that forces abstractions, mocks, adapters, or brittle seams into production code.

## Safety

- Do not print tokens, provider configs, `.saivage/auth-profiles.json`, `.saivage/saivage.json`, env files, or backups.
- API bearer tokens must not be placed in URLs.
- Treat `.saivage/stages/**` and `.saivage/runtime/**` as live/generated runtime state unless the task targets them.
