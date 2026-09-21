# Saivage v3 AI Agent Instructions


Scope: `/home/salva/g/ml/saivage-v3`.

Read `/home/salva/g/ml/CODEX_PROJECT_MEMORY.md` and the current docs before substantial work here. OpenCode loads this file through root `opencode.json` because `saivage-v3` is its own Git repository. Do not recreate `.opencode/opencode.json`: both locations are OpenCode config candidates, and competing configs create precedence ambiguity.

This file is the shared project instruction source for AI development tools. Keep
the tool-specific entry points `.github/copilot-instructions.md` and root
`opencode.json` thin by having them reference this file rather than duplicate
project policy; “thin” here concerns duplicated project policy, not JSON size.

## Current Authority

- `docs/spec/system-specification.md` for functional behavior.
- `docs/spec/operator-ui.md` for operator UI behavior.
- `docs/architecture/system-architecture.md` for system architecture.
- `docs/runbook/index.md` for deployment, startup, lifecycle, recovery, reset, and operator procedures.
- `README.md` for introduction, quick start, authority navigation, and validation profiles.

Superseded and stale design documents are provenance available only through Git history, not implementation authority.

## Project Owner Overrides

- The project owner may explicitly override a project-local rule in this file for a specific task. The override must identify the rule being overridden, the intended operation, and its scope; an explicit conversational instruction is sufficient and does not require another edit to this file.
- Before acting on an override that permits irreversible mutation, data loss, weakened validation, or unsupported state, the agent must state the concrete consequence and receive explicit confirmation. Once confirmed, follow the owner's scoped override without substituting a different operation.
- An override is task-scoped unless the owner explicitly makes it standing. It does not override system, platform, or tool-level instructions, and it does not relax external authentication or outbound secret non-disclosure unless a higher-priority instruction expressly permits that change.

## Deployment And Trust Model

- Saivage is intended to run inside an externally isolated LXC container. That isolation is deployment-owned; Saivage neither creates nor verifies it.
- In-container agents are trusted and may execute shell commands as root. This capability does not make every ordinary workflow unconstrained: tools may still constrain operations to simplify agent/operator work, prevent accidents, uphold API contracts, and preserve runtime/data correctness and integrity.
- Saivage-internal controls cannot comprehensively contain a malicious or rogue root-capable agent. Do not add exhaustive hardening for malicious symlink placement, forbidden-file access, anti-tamper behavior, or equivalent attacks by that principal.
- Apply the following test only to controls proposed as security or hardening defenses against that trusted root-capable principal: retain or add such a control only when independently justified by at least one of exactly these four reasons: simplifying ordinary agent/operator work; preventing a likely accident; preserving an explicit product/API trust boundary; satisfying a concrete deployment requirement. Name the actual rationale; do not claim root-agent containment.
- Ordinary runtime/data correctness and integrity invariants remain valid outside that four-reason test, but they do not contain the agent.
- Preserve external/operator authentication and outbound secret non-disclosure. Trusted agent inspection and root capability grant neither unauthenticated external access nor permission to disclose secrets through UI, API, log, or chat output.

## Operational Workflow

- When fixing any issue, first create a design and implementation plan under `docs/working/`, then have the `reviewer` subagent review every current plan revision. Critically evaluate its findings and repeat the adversarial review/fix cycle until no confirmed material finding remains. During repeated loops, periodically reassess whether the evolving design remains worthwhile, simple, scoped, and aligned with these instructions; after review closes, always repeat that higher-level assessment before freshness checking or implementation. A salvageable fault restarts the complete design/review loop with precise constraints; a non-salvageable design is abandoned without implementation. Follow the `saivage-issue-fix-adversarial-review` skill for the exact cadence, rubric, outcomes, and reporting.
- For batched issues, planning and review may run concurrently, but the sole implementation-manager lock serializes each issue's complete mutating phase through required validation, generated artifacts, staging, commits, and stabilization. Post-manager fixer reconciliation is read-only; a deferred fixer must resume its original Task and revalidate plan freshness under the detailed `saivage-issue-fix-adversarial-review` skill before another implementation attempt.

## Commit Policy

- The project owner explicitly grants standing permission to commit and normally push coherent, validated, scoped repository work, including reviewed new files, at stable points without repeated task-specific permission, subject to higher-level instructions and explicit task restrictions. Stable units include completed source or refactor work, finished documentation work, and one logical unit of a larger change; a test pass alone is not a committable unit.
- Do not commit broken, half-finished, or non-compiling states. Run the relevant focused validation (`npm run validate:docs`, focused Jest/Vitest, etc.) before committing when the change type warrants it. Keep each commit focused and reviewable, and write a message matching repository style (recent prefix examples: `docs(...)`, `chore(...)`, `feat(...)`, `fix(...)`).
- Preserve other people's unready work. Never stage, commit, or push secrets, generated or live runtime state, or `docs/working/` artifacts.
- Push normally only to the configured upstream. Report authentication, conflict, remote-ahead, or other push failures rather than overwriting them. Never force push, amend, bypass hooks, change Git configuration, add remotes, rewrite history, or overwrite conflicts.
- Permission to push never authorizes deployment or service action.

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

- OpenCode loads these skills directly through root `opencode.json`.
- GitHub Copilot does not auto-load OpenCode skills; when a task matches a skill description, read the relevant `SKILL.md` and follow it as the project-local workflow.
- Do not add symlinked or duplicate tool-specific skill trees. Keep `.github/skills/` as the shared source of truth.

Current high-value skills include:

- `saivage-development-validation`: validation after Saivage v3 code, docs, UI, API, or deployment changes.
- `saivage-lxc-operations`: LXC operations for Saivage v3-relevant deployments such as the v2-on-v3 harness, GetRich v2, and Pueblicos.
- `saivage-project-reset`: reset target projects managed by Saivage v3 deployments, such as GetRich v2 or Pueblicos.
- `opencode-skill-authoring`: create or revise project OpenCode skills under `.github/skills/`.
- `saivage-issue-fix-adversarial-review`: mandatory issue-fixing workflow that iterates design/plan adversarial review before implementation.
- `saivage-todo-protocol`: track work items through their lifecycle using `docs/working/todo.md` and `docs/working/done.md`.
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
- For loss-tolerant advisory or observational behavior, prefer simple owner-local operations and later fresh observation or ordinary recovery over exactly-once guarantees, retries, acknowledgements, registries, or race restabilization; this never excuses stranded owners, unmatched canonical history, incorrect known effects, unauthorized actions, or secret disclosure.
- Expand scope only when a deferred item would block the core change or leave the system unsafe. This complements, and does not weaken, the root-cause and brave-refactor guidance above: fix the needed change fully, but do not pad it with extras.
- Accepting an evidenced defect does not authorize its suggested remedy. Evaluate changes against the original evidenced need. When an introduced mechanism causes a problem, consider removing it before adding machinery to sustain it.
- Obtain an owner decision before strengthening product guarantees or removing unrelated capabilities beyond the authorized scope. General engineering slogans do not authorize those tradeoffs; ordinary implementation and refactoring choices within established requirements remain autonomous.

## Storage Policy

- This policy governs Saivage-owned durable application and runtime persistence. It does not constrain target projects, MCP integrations, external tools, or use of SQL as a language when SQL is not being used as a Saivage persistence backend.
- Every database persistence backend is forbidden for Saivage-owned durable state, including SQL, embedded, document, key-value, graph, and other database forms. Saivage durable state selected for persistence must be stored as ordinary files.
- Saivage persistence is direct stateless synchronous file I/O performed by the domain or actor owner. Reader-local indexes may validate and project one direct read, then are discarded; they never authorize a later write. Do not introduce persistence lifecycles, health latches, generic stores or repositories, queues, registries, subordinate locks, generations, currentness protocols, or other storage coordination machinery.
- A growing Saivage-owned JSONL file is append-only. Each logical append is exactly one newline-terminated physical line containing one strict, versioned, type-discriminated envelope with a non-empty `rows` array in semantic order. An owning reader may truncate only an identifiable unterminated final suffix of the exact canonical JSONL file. Every complete malformed envelope, unsupported version or type, invalid row, and other complete malformed exact canonical data remains present and fails clearly; it is never discarded, normalized, repaired, or recovered.
- Replacement and first publication use one fresh random UUID same-directory temporary path opened exactly once with `O_CREAT | O_EXCL | O_WRONLY`. Write and `fsync` the temporary file, rename it over the one target, then `fsync` the parent directory. A collision or any other error fails directly. Never retry, choose an alternate name, inspect, scan, clean, reuse, validate, warn about, quarantine, or delete a temporary path; a crash-left temporary remains a harmless noncanonical orphan ignored forever.
- All Saivage file and directory creation, replacement, append, `mkdir`, and lifecycle-lock creation uses ordinary Node defaults filtered only by the process/user umask. Supply no mode argument, mode option, or default override, and perform no permission enforcement, mode probing, `chmod`/`fchmod` repair, or umask orchestration.
- **Standing orphan-simplicity review gate:** harmless noncanonical files and directories left by interrupted publication remain ignored forever during normal operation. Startup, runtime, and review code must never discover, classify, inspect, selectively clean, delete, reuse, warn on, quarantine, or repair them. Reviews must reject orphan or allocation scans, aggregate validation, startup cleanup, restabilization, adoption, and every other mechanism that handles such orphans. Exact canonical state remains strict.
- Card identity is the fixed root `project` or `card-<segment>[-<segment>...]`, with one to twelve lowercase alphabetic segments. A child created at resulting depth twelve must select a compiled card type whose `permittedChildTypes` set is empty. After the exact parent read, resulting depth above twelve is rejected before ordinary parent workflow admission and before namespace claim or any other write effect; in-limit ordinary admission and child-workflow resolution precede the depth-twelve leaf check, and that complete initial sequence precedes every namespace/write effect. Each child-creation call starts at parent-local segment `a` and derives each exact candidate namespace directly. Exclusive candidate `mkdir` success is the sole claim; only that `mkdir` returning `EEXIST` advances through the spreadsheet sequence (`a` through `z`, then `aa`, and so on). Never inspect or enumerate a collided candidate or siblings, and never derive allocation from parent streams, active children, positions, discovery, scans, adoption, cleanup, or reuse. A successfully claimed namespace remains consumed even when later publication or linking fails, and incomplete or unlinked namespaces stay ignored forever. Canonical membership exists only after complete initial publication and one parent version appends the child to both monotonic `child_membership` and complete `active_child_order`. The two arrays always contain the same IDs; retained tombstones remain in both, while filtering `active_child_order` through exact live child folds is the sole semantic sibling order.
- Card state/history/tombstone and brief/status/review state use their exact card-owned append-only JSONL streams. Normal card and session operations derive exact paths from committed identities; they never enumerate child, version, slot, session, or temporary siblings. A retained tombstoned child link terminates traversal.
- Replacement, append, truncation, and lifecycle-lock publication errors may be outcome-unknown. They authorize no follow-up read, retry, rollback, replay, reconciliation, effect, descriptor cleanup, or artifact inspection. The only write repetition is a call-local first-write `EINTR` that proves zero transferred bytes; positive short writes advance only through the unsent suffix. Unknown or potentially committed bytes are never resent. Lifecycle-lock exclusive creation is a known committed empty canonical namespace effect; its first record write may repeat only under the same proven-zero-transfer rule. Multi-root deletion freshly preflights the complete linked active subtree union and orders independent tombstone appends dependent-before-dependency and child-before-parent so every possible committed prefix remains valid.
- Application-built or custom transaction and primitive-layer recovery protocols are categorically forbidden. Do not build write-ahead logs, journals, two-phase commit, commit manifests, multi-file or cross-line coordination, generic recovery engines or orchestrators, transaction emulation, persistence queues, writer registries, generic ledgers, or equivalent machinery. This prohibition does not remove the Supervisor's specified best-effort, loss-tolerant full-chain Run recovery: it uses strict canonical reads, may truncate only an identifiable unterminated final suffix, and appends corrective or `stopped` rows leaf-to-root. It never rewrites an append-only body, skips or repairs a complete malformed envelope, inspects an uncertain result, or retries a publication. The exact consuming card-session activation owner may also, at actual use of the configured session selected for imminent activation, settle its sole strict-valid final unmatched prior tool call with one permanent uncertainty-only failed result before publishing the new activation. In an already-running server, the configured global Analyst owner may do the same at actual use by a later newly admitted explicit submission, immediately before publishing its fresh ingress. Neither path replays or continues the prior call, asserts whether effects occurred, appends a recovery notice, scans other sessions, repairs malformed/nonfinal/multiple-unmatched history, or permits follow-up after publication uncertainty. Startup remains strict and Supervisor Run remains the only broad chain recovery owner.
- The runtime lifecycle lock remains the exceptional process-exclusion boundary; it is not application-state persistence or same-file write coordination. Read-only classification has exactly `missing`, verified `live`, positively verified `dead`, `indeterminate`, and `malformed` outcomes. `indeterminate` covers failures or denials that prevent proof of ownership and is never reported as live; malformed and indeterminate observations fail closed. No classification authorizes automatic lock removal or takeover.
- CLI `status`, `pause`, `resume`, and `stop` delegate only for a verified live lock record and only through that record's published non-null control endpoint and auth mode. A null endpoint has only the generic result `active lifecycle owner; runtime control unavailable`; do not infer or add a lifecycle phase. Never rediscover endpoint or auth authority from configuration, flags, environment, defaults, or current process state, and never fall back after delegation or authentication failure. Runtime-control CLI commands do not read or mutate runtime state offline.
- For a missing or positively dead owner, `status` succeeds with stopped/no-live status and `stop` succeeds with the already-stopped, not-contained result; `pause` and `resume` fail because no live runtime exists. Dead-lock results also direct the operator to manual abandoned-lock repair. `indeterminate` and `malformed` fail closed without REST or file mutation.
- Public server restart remains a distinct confirmed `restart_server` operation available only when the verified live owner publishes bearer authentication and operator authentication is enabled. Ordinary project Stop remains `stop_project`, is available under both disabled and bearer runtime auth, and neither disposes nor restarts the server.
- Durable-format changes use a reset-only cutover. Do not add migrations, compatibility readers, format probing, adapters, dual paths, or legacy normalization. Operators must stop the service, reset generated persistence while preserving configuration, credentials, operator inputs, source, and documentation, and then start the current binary; mixed-version operation and rollback against current-format state are unsupported. An explicit operator-invoked reset may delete an entire generated persistence root wholesale without inspecting, classifying, or selectively handling any orphan contents. This is reset of generated state, not orphan cleanup.
- Every preceding Storage Policy rule remains absolute for Saivage implementation, production and review code, the running service, startup, normal runtime and reset, supported operator behavior, and all other normal operations. Outside Saivage and those operations, only the project owner may explicitly authorize a one-off manual offline reconstruction under the existing **Project Owner Overrides** contract, identifying the exact overridden rules, intended operation, affected project, service, work/instance, complete generated-state boundary, and scope; its concrete irreversible, data-loss, weakened-validation, unsupported-state, and audit/evidentiary consequences must be stated and explicitly confirmed as that contract requires. The exact service must first be stopped and absence of a live owner/process for that project positively verified before beginning a complete target-project backup. That stopped backup must succeed before inspection or reconstruction and remain preserved unchanged; it is a prerequisite, not authorization, evidence of authorization, or a candidate workspace. Ownership absence must remain established or be positively reconfirmed before inspecting backup contents, mutating the separate candidate, and cutting over; a live, indeterminate, or malformed observation blocks the relevant phase. Authorization, an archive, plan approval, deployment permission, or backup existence alone authorizes none of this work.
- Such authorization permits narrowly bounded inspection only of canonical generated state in the preserved backup, including obsolete or malformed canonical state, to derive recoverable semantics while preserving outbound secret non-disclosure. Noncanonical orphans, publication temporary paths, incomplete or unlinked namespaces, and uncertain-publication artifacts remain ignored and must not be discovered, interpreted, adopted, or used as evidence; do not build inventories, source registries, generic forensic facilities, or other reusable discovery machinery. Author derived state only in the current exact format as one wholly separate, complete candidate covering the complete applicable generated-state boundary, or as a complete replacement workspace; never mutate the affected installation or backup in place, and never patch, truncate, append to, normalize, rewrite, merge, or selectively replace retained generated roots, streams, files, or rows. Strictly validate the complete candidate against all current contracts before complete-boundary or complete-workspace cutover; failure blocks cutover and authorizes no relaxation, compatibility interpretation, prefix retention, or selective merge. The candidate is new reconstructed state and has no byte-for-byte, historical, forensic, audit, or evidentiary equivalence to the original. Record its source, scope, validation, omissions, unresolved uncertainties, and known transformations in an external, non-authoritative operator report outside both the backup and Saivage-generated state, with no prescribed schema, generic ledger, tracked utility, or canonical-history entry. This exceptional boundary authorizes no Saivage product/runtime compatibility, recovery, migration, cleanup, orphan discovery, startup or runtime mechanism, tracked generic utility, running-service append-only rewrite, normal selective repair, mixed-version operation, rollback compatibility, supported API contract, or routine operator remedy.
- Saivage file persistence provides no guarantee against data loss for any persisted state after interruption or corruption. This applies to authoritative and non-reconstructible state as well as generated state; loss tolerance is not limited to deterministically reconstructible or explicitly disposable data.

## Runtime Coding Rules

- Fail fast for impossible states. If a code path should be unreachable under correct operation, throw rather than silently recovering, normalizing, or returning fallback values.
- Fail fast means detection at use. The strict operation that consumes state rejects corrupted or impossible values when it actually reads them; it does not require re-checking state ahead of use. Do not add proactive internal state validation, cleanliness assertions, or pre-use verification passes for conditions that existing consumers already reject at use time — or that cannot arise under correct operation. A pre-use verification pass is over-defensive machinery even when its failure mode is loud; deletion of the defensive path is preferred over replacing it with an assertion.
- The specified exact-session final-unmatched settlement at actual card activation or newly admitted global Analyst submission use is the narrow exception to entry stabilization. It authorizes neither proactive cleanliness/preflight passes nor inspection or stabilization of any session not selected for that imminent use.
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
