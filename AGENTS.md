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

- When fixing any issue, first create a design and implementation plan under `docs/working/`, then have the `reviewer` subagent review the current plan revision. Critically evaluate its findings, fix confirmed issues, and repeat the adversarial review/fix cycle until no confirmed material finding remains. If the cycle keeps surfacing new material findings without converging, step back and re-aim the overall approach before looping further; see Reassessment On Repeated Review Loops in the `saivage-issue-fix-adversarial-review` skill. Follow the detailed `saivage-issue-fix-adversarial-review` skill for the full procedure.
- For batched issues, planning and review may run concurrently, but the sole implementation-manager lock serializes each issue's complete mutating phase through required validation, generated artifacts, staging, commits, and stabilization. Post-manager fixer reconciliation is read-only; a deferred fixer must resume its original Task and revalidate plan freshness under the detailed `saivage-issue-fix-adversarial-review` skill before another implementation attempt.

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

## Storage Policy

- This policy governs Saivage-owned durable application and runtime persistence. It does not constrain target projects, MCP integrations, external tools, or use of SQL as a language when SQL is not being used as a Saivage persistence backend.
- Every database persistence backend is forbidden for Saivage-owned durable state, including SQL, embedded, document, key-value, graph, and other database forms. Saivage durable state selected for persistence must be stored as ordinary files.
- Saivage persistence is direct stateless synchronous file I/O performed by the domain or actor owner. Reader-local indexes may validate and project one direct read, then are discarded; they never authorize a later write. Do not introduce persistence lifecycles, health latches, generic stores or repositories, queues, registries, subordinate locks, generations, currentness protocols, or other storage coordination machinery.
- A growing Saivage-owned JSONL file is append-only. Each logical append is exactly one newline-terminated physical line containing one strict, versioned, type-discriminated envelope with a non-empty `rows` array in semantic order. An owning reader may truncate only an identifiable unterminated final suffix of the exact canonical JSONL file. Every complete malformed envelope, unsupported version or type, invalid row, and other complete malformed exact canonical data remains present and fails clearly; it is never discarded, normalized, repaired, or recovered.
- Replacement and first publication use one fresh random UUID same-directory temporary path opened exactly once with `O_CREAT | O_EXCL | O_WRONLY`. Write and `fsync` the temporary file, rename it over the one target, then `fsync` the parent directory. A collision or any other error fails directly. Never retry, choose an alternate name, inspect, scan, clean, reuse, validate, warn about, quarantine, or delete a temporary path; a crash-left temporary remains a harmless noncanonical orphan ignored forever.
- All Saivage file and directory creation, replacement, append, `mkdir`, and lifecycle-lock creation uses ordinary Node defaults filtered only by the process/user umask. Supply no mode argument, mode option, or default override, and perform no permission enforcement, mode probing, `chmod`/`fchmod` repair, or umask orchestration.
- **Standing orphan-simplicity review gate:** harmless noncanonical files and directories left by interrupted publication remain ignored forever during normal operation. Startup, runtime, and review code must never discover, classify, inspect, selectively clean, delete, reuse, warn on, quarantine, or repair them. Reviews must reject orphan or allocation scans, aggregate validation, startup cleanup, restabilization, adoption, and every other mechanism that handles such orphans. Exact canonical state remains strict.
- Card identity is the fixed root `project` or `card-<segment>[-<segment>...]`, with one to five lowercase alphabetic segments. Each child-creation call starts at parent-local segment `a` and derives each exact candidate namespace directly. Exclusive candidate `mkdir` success is the sole claim; only that `mkdir` returning `EEXIST` advances through the spreadsheet sequence (`a` through `z`, then `aa`, and so on). Never inspect or enumerate a collided candidate or siblings, and never derive allocation from parent streams, active children, positions, discovery, scans, adoption, cleanup, or reuse. A successfully claimed namespace remains consumed even when later publication or linking fails, and incomplete or unlinked namespaces stay ignored forever. Canonical membership exists only after complete initial publication and one cumulative `children` snapshot is appended to the parent stream.
- Card state/history/tombstone and brief/status/review state use their exact card-owned append-only JSONL streams. Normal card and session operations derive exact paths from committed identities; they never enumerate child, version, slot, session, or temporary siblings. A retained tombstoned child link terminates traversal.
- Replacement or append errors may be outcome-unknown. They authorize no follow-up read, retry, rollback, replay, reconciliation, effect, or artifact inspection. Multi-root deletion freshly preflights the complete linked active subtree union and orders independent tombstone appends dependent-before-dependency and child-before-parent so every possible committed prefix remains valid.
- Application-built or custom transaction and recovery protocols are categorically forbidden. Do not build write-ahead logs, journals, two-phase commit, commit manifests, multi-file or cross-line coordination, recovery engines or orchestrators, transaction emulation, persistence queues, writer registries, generic ledgers, or equivalent machinery.
- The runtime lifecycle lock remains the exceptional process-exclusion boundary; it is not application-state persistence or same-file write coordination. Read-only classification has exactly `missing`, verified `live`, positively verified `dead`, `indeterminate`, and `malformed` outcomes. `indeterminate` covers failures or denials that prevent proof of ownership and is never reported as live; malformed and indeterminate observations fail closed. No classification authorizes automatic lock removal or takeover.
- CLI `status`, `pause`, `resume`, and `stop` delegate only for a verified live lock record and only through that record's published non-null control endpoint and auth mode. A null endpoint has only the generic result `active lifecycle owner; runtime control unavailable`; do not infer or add a lifecycle phase. Never rediscover endpoint or auth authority from configuration, flags, environment, defaults, or current process state, and never fall back after delegation or authentication failure. Runtime-control CLI commands do not read or mutate runtime state offline.
- For a missing or positively dead owner, `status` succeeds with stopped/no-live status and `stop` succeeds with the already-stopped, not-contained result; `pause` and `resume` fail because no live runtime exists. Dead-lock results also direct the operator to manual abandoned-lock repair. `indeterminate` and `malformed` fail closed without REST or file mutation.
- Public server restart remains a distinct confirmed `restart_server` operation available only when the verified live owner publishes bearer authentication and operator authentication is enabled. Ordinary project Stop remains `stop_project`, is available under both disabled and bearer runtime auth, and neither disposes nor restarts the server.
- Durable-format changes use a reset-only cutover. Do not add migrations, compatibility readers, format probing, adapters, dual paths, or legacy normalization. Operators must stop the service, reset generated persistence while preserving configuration, credentials, operator inputs, source, and documentation, and then start the current binary; mixed-version operation and rollback against current-format state are unsupported. An explicit operator-invoked reset may delete an entire generated persistence root wholesale without inspecting, classifying, or selectively handling any orphan contents. This is reset of generated state, not orphan cleanup.
- Saivage file persistence provides no guarantee against data loss for any persisted state after interruption or corruption. This applies to authoritative and non-reconstructible state as well as generated state; loss tolerance is not limited to deterministically reconstructible or explicitly disposable data.

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

- Do not print tokens, provider configs, `.saivage/auth-profiles.json`, `.saivage/saivage.yaml`, env files, or backups.
- API bearer tokens must not be placed in URLs.
- Treat `.saivage/stages/**`, `.saivage/state/**`, `.saivage/logs/**`, `.saivage/locks/**`, and `.saivage/work/**` as live/generated runtime state unless the task targets them.
