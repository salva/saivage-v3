---
name: saivage-issue-fix-adversarial-review
description: 'Mandatory Saivage v3 workflow for single or batched issue fixes. Use for bugs, regressions, review findings, design flaws, architectural issues, behavior gaps, or issue-fix workflow changes: coordinate parallel planning, require per-issue design and adversarial review, then serialize complete implementation through the implementation-manager lock.'
---

# Saivage Issue Fix Adversarial Review

Use this workflow before fixing any concrete issue in Saivage v3, including bugs, regressions, review findings, architectural flaws, behavior gaps, failed validation findings, and operator-reported problems. Also use it when creating or changing operational workflow rules or skills that govern how issues are fixed.

This skill is mandatory for issue fixes and issue-fixing workflow changes. It is not required for trivial non-issue edits such as typo fixes or formatting-only changes unless the user frames the work as fixing an issue or changing this workflow.

When the change creates or revises a skill, also follow `opencode-skill-authoring`. Apply `AGENTS.md` throughout; it remains authoritative for architecture, scope, documentation, commit, validation, and safety rules.

## Ownership Model

- **Batch coordinator (primary agent):** accepts the issue batch, assigns one unique `docs/working/<date>-<issue-slug>/` path per issue, launches and tracks one `fixer` Task per issue, records each exact Task-returned ID and disposition in its own session context, and decides when a waiting fixer may resume. It never takes over an issue's design, review, or implementation.
- **Issue fixer (`fixer`):** owns one issue end to end: designer/reviewer delegation, finding triage, approved-plan freshness decisions, implementation-manager delegation, and read-only reconciliation and reporting after manager return. It may write ignored planning/review artifacts, but it never performs implementation edits, validation, artifact generation, staging, or commits.
- **Designer (`designer`):** writes and revises the issue's design/plan, including revisions prompted by review or implementation learning.
- **Reviewer (`reviewer`):** adversarially reviews every current design/plan revision.
- **Implementation manager (`implementation-manager`):** is the sole issue implementation orchestrator and the only agent that invokes `developer`. Its one lock covers all implementation mutation, required validation, generated artifacts, staging, commits, and stabilization.
- **Developer (`developer`):** is the leaf implementer for manager-assigned plan tasks.

Each issue must complete its own design/review loop. Potentially colliding issues may plan and review concurrently; plan approval reserves no file or contract. Issue-level implementation remains serialized regardless of apparent independence. For a one-issue batch, the primary is the one-item coordinator and drives the same specialist workflow.

## Objectives

- Design root-cause fixes before implementation and force a skeptical second pass.
- Treat review findings as hypotheses and repeat revision/review until no confirmed material finding remains.
- Permit concurrent issue investigation and review without permitting overlapping issue implementations.
- Keep working artifacts out of Git while updating tracked documentation required by the fix.

## Required Working Files

Create a unique working directory for each issue, such as `docs/working/<date>-<issue-slug>/`, containing the current design/plan and one file per adversarial review round.

- `docs/working/` is ignored and must not be committed. It is not a substitute for canonical documentation.
- Keep every revised plan self-contained; readers must not need prior revisions.
- Keep reviews factual and actionable; do not preserve weak critiques as required work.

## Design And Plan Requirements

The first design/plan must include:

- Problem statement with evidence and affected user/runtime behavior.
- Root-cause analysis, or the best current hypothesis.
- Scope and non-scope. List non-essential robustness and rare edge cases as deferred follow-ups unless deferral blocks the core fix or leaves the system unsafe.
- Proposed design, including affected modules, contracts, APIs, and UI/runtime surfaces as applicable.
- Alternatives, including a broader/root-cause alternative when reasonable.
- An ordered implementation plan with three explicit sections:
  - Main work tasks.
  - Cleanup tasks for obsolete code, tests, fixtures, docs, and scripts.
  - Documentation-update tasks naming each main document to update and how. Documentation is implementation work, not a later phase. Consider `docs/spec/system-specification.md`, `docs/spec/operator-ui.md`, `docs/architecture/system-architecture.md`, and `README.md`; do not count the working plan itself.
- Related stale main documentation and scoped tasks to correct it.
- Focused and broader validation appropriate to risk.
- Risks, rollback considerations, and unresolved questions.

## Adversarial Review And Revision Loop

The issue fixer must use `designer` for all plan authoring and `reviewer` for every plan review:

1. Ask `designer` to write or revise the self-contained plan at the issue's unique path. For revisions, provide all confirmed material findings.
2. Invoke `reviewer` on the complete current plan.
3. Triage every finding.
4. If any finding is material, revise and repeat. Implement only when every finding is false, minor, or explicitly deferred and no confirmed material finding remains.

### Reassessment On Repeated Review Loops

The issue fixer, not the designer or reviewer, reassesses the approach when roughly three rounds find material issues, findings recur, or revisions repeatedly widen or shift scope. Re-evaluate layer/component fit, root-cause placement, complexity, scope, and issue framing. Then do exactly one of: simplify, re-scope, move the fix, or ask the user. Reassessment never skips review; send the revised framing through the full loop again.

### Designer And Reviewer Calls

Invoke the designer with `subagent_type: "designer"`, the issue context, and absolute plan path. Invoke the reviewer with `subagent_type: "reviewer"` and the absolute current plan path. Save or summarize each review in the issue working directory.

### Finding Triage

- **False:** speculative, preference-only, contradicted by current rules, or outside scope; reject it.
- **Minor:** correct but too small to affect the plan; note it without forcing another round.
- **Material:** real and significant enough to change the design or plan; revise directly.
- **Deferred:** real but outside the minimal coherent fix; record why and whether follow-up is needed.

### Escalation And Blockers

- Ask the user when reassessment cannot resolve unclear scope, repeated disagreement, or a required tradeoff.
- If required subagent tooling is unavailable, report `BLOCKED`; never claim review or implementation passed. Proceed only if the user explicitly changes the workflow or the change repairs the unavailable workflow itself.

## Batch Launch And Tracking

For a batch, the coordinator must:

1. Give each fixer a complete issue statement and unique absolute working-plan path.
2. Launch independent initial Task calls concurrently, in the same orchestration turn/tool batch when supported, with `subagent_type: "fixer"`. Do not serialize design/review merely because issues may touch the same files.
3. Record in coordinator session context, never a repository file or registry: issue identity/summary, exact returned fixer task ID, plan path, latest disposition, and known implementation-lock ownership.
4. Handle returns independently. One issue failure or cancellation does not cancel others unless explicitly requested.

Sequentially awaiting each initial fixer defeats the batch contract. If concurrent Task launch or exact returned-ID observation is unavailable, report the batch workflow blocked rather than silently weakening it.

## Approval And Freshness Gate

When review closes, the fixer records the examined `HEAD` in its approval report. Immediately before every implementation-manager attempt, including every attempt after lock waiting, it performs a read-only semantic freshness check against current `HEAD`, commits since its last approval/check, and current shared-worktree changes.

Compare the plan's assumptions, named files, contracts, call sites, cleanup, documentation, and validation:

- **`PLAN_STILL_VALID`:** intervening changes do not materially affect root cause, intended contract, affected components/call sites, ordered tasks, or validation. Record the evidence and invoke the manager.
- **`PLAN_REVIEW_REQUIRED`:** a contract or assumption changed, a target was removed/substantially rewritten, planned changes conflict, scope changed, or validation/docs no longer establish correctness. Do not invoke the manager. Send current evidence to `designer` and repeat the complete review/triage loop.
- **`BLOCKED`:** the shared workspace is broken, unclassified, or unsafe for a reliable check. Do not mutate or improvise.

A successful check does not reserve implementation. The manager must still acquire the sole lock; if it loses contention, the fixer waits and repeats freshness after its verified resume.

## Singular Complete Implementation Boundary

Every approved fixer invokes Task with `subagent_type: "implementation-manager"` and the absolute approved-plan path; no primary or fixer inspects the lock and implements around it. The existing `.opencode/locks/implementation-manager-working.md` is the only serialization boundary.

The manager must:

1. Atomically acquire the lock before reading the implementation plan or making/delegating implementation mutation. On contention it edits and delegates nothing and returns the existing lock description.
2. Capture pre-existing Git status/diff sufficiently to preserve unrelated work and avoid staging or removing it.
3. Decompose the approved plan into developer assignments. Assign sequentially when work overlaps or has ordering dependencies. It may launch a concurrent developer group only after positively determining that the assignments do not conflict in files, contracts, generated outputs, validation side effects, or required order.
4. Await every developer in a concurrent group and reconcile each result plus the combined repository state against assigned scopes and the approved plan. No shared/integration validation, staging, or commit may start while any developer remains active.
5. Run all validation required by the plan, including focused and broad checks; handle generated artifacts; selectively stage only intended paths; and commit coherent stable units under `AGENTS.md`. Developer checks may inform progress but do not replace manager-run required validation.
6. Prepare its final report with command results and commit hashes. Before normal release, ensure completed issue work is stable and committed and no issue-owned uncommitted mutation remains.
7. For partial completion or redesign-worthy learning after edits, validate and commit only coherent completed units, then finish or remove only this run's incomplete uncommittable changes while preserving pre-existing/unrelated work. If safe stabilization is impossible, retain the lock and escalate; do not expose an unsafe worktree to another run.
8. Remove only the lock created by this run as the final mutation, then return the prepared report. Abnormal termination may leave the lock; no other agent removes or takes it over.

The lock spans tracked/main-document edits, generated outputs, mutating build/test/docs commands, staging, commit hooks, commits, and final issue cleanup. Concurrent developers remain inside one lock holder's one issue and do not permit another issue implementation to overlap.

## Lock Contention And Event-Driven Resume

An acquisition contender that returns without edits or delegation maps exactly to `WAITING_FOR_IMPLEMENTATION_LOCK`. This is not failure, partial implementation, divergence, or evidence requiring redesign. The fixer retains issue ownership and must not poll, sleep, retry in the same turn, inspect/remove/classify the lock as stale, or launch another manager.

The coordinator may resume waiting fixers only after the known holder has returned, released its lock, and reported a stable committed state. Several waiting fixers may be resumed optimistically; one manager wins and the others wait again. This creates no queue, scheduler, fairness promise, timer, watcher, or additional lock.

### Waiting Nonce

On each waiting return, the fixer generates a fresh opaque continuity nonce, retains it in its existing session context, and reports it. The coordinator records it with the exact returned task ID and replaces any prior nonce for that issue. It is session correlation state, not a credential or durable state. Successful authorization consumes it; repeated waiting requires a new nonce. Cancellation or terminal failure discards it.

### Mandatory Two-Call Resume Handshake

Both calls use:

```text
subagent_type: "fixer"
task_id: "<exact recorded task ID>"
```

**Call 1 — challenge:** The coordinator does not include the expected nonce. Its prompt unconditionally forbids tools, edits, commands, and every mutation and asks for only the issue identity, plan path, prior `WAITING_FOR_IMPLEMENTATION_LOCK` disposition, and nonce retained in session context. If any value is unavailable, the fixer returns `BLOCKED` without tools. The coordinator independently verifies the Task result's returned task ID is byte-for-byte identical and all retained values exactly match its record.

Any missing/mismatched value, task-ID mismatch, or tool/mutation makes the issue `BLOCKED`; make no Call 2. An invalid ID may create a new session, but that session cannot know the undisclosed nonce and its output is never adopted.

**Call 2 — authorization:** Only after Call 1 passes, invoke the same exact task ID again. Authorize the read-only freshness gate and, only if still approved, manager delegation. Before using any tool, the fixer confirms from its own context that the immediately preceding handshake succeeded for the retained waiting episode; absent context means `BLOCKED` without tools. The coordinator again verifies the exact returned task ID. Successful authorization consumes the nonce.

## Handling Manager Returns

### Contention-Only Return

Map a manager return that acquired no lock, edited nothing, and delegated nothing to `WAITING_FOR_IMPLEMENTATION_LOCK`. Do not revise or re-review solely because of contention. Return control to the coordinator with a fresh nonce and wait for event-driven resume.

### Acquired-Lock Return

The fixer performs read-only reconciliation only: inspect the manager report, commit hashes, `HEAD`, status/diff, and manager-supplied validation evidence. It must not run commands that can mutate files, regenerate artifacts, stage, commit, or finish implementation.

- If the approved plan is fully executed with no divergence or redesign-worthy learning and the repository is stable, report issue completion.
- If work remains, the run is partial, implementation diverged, or learning changes the design, return the issue to `designer` and the complete adversarial review loop. Planning-file edits remain allowed. A later implementation attempt requires a new freshness check and manager lock.
- If the manager cannot stabilize and retains the lock, report `BLOCKED`; no issue implementation resumes until explicit owner/operator verification and repair.

## Structured Fixer Dispositions

Every fixer return to a coordinator starts with exactly one disposition:

- `COMPLETED`
- `WAITING_FOR_IMPLEMENTATION_LOCK`
- `BLOCKED`
- `FAILED`
- `CANCELLED`

A waiting return includes:

```text
Disposition: WAITING_FOR_IMPLEMENTATION_LOCK
Issue: <identifier and summary>
Plan: <absolute path>
Plan approval: <review verdict and examined HEAD>
Implementation attempt: <number>
Lock holder: <verbatim or concise faithful existing lock description>
Continuity nonce: <fresh opaque value retained in this fixer session>
Work performed in this attempt: none
Resume condition: known lock-holder run has returned and released its lock
Coordinator action: retain this nonce with the exact fixer task ID, then use the two-call handshake; do not launch a replacement
```

The coordinator records each Call 1 result as:

```text
Requested task ID: <exact recorded ID>
Returned task ID: <Task result ID>
Continuity: CONFIRMED | BLOCKED
Prior issue from session context: <identifier or unavailable>
Prior plan from session context: <path or unavailable>
Prior disposition from session context: <WAITING_FOR_IMPLEMENTATION_LOCK or unavailable>
Retained nonce from session context: <opaque value or unavailable>
```

`CONFIRMED` requires no tool/mutation, all four retained values matching, and identical requested/returned IDs. It only makes Call 2 eligible; it does not authorize freshness work itself.

Before manager delegation after Call 2, record:

```text
Resume check: PLAN_STILL_VALID | PLAN_REVIEW_REQUIRED | BLOCKED
Previously examined HEAD: <commit>
Current HEAD: <commit>
Relevant intervening changes: <summary or none>
Decision and evidence: <reason>
```

Completion/failure reports include issue identity, plan path, review result, files changed, manager-supplied validation results, commit hashes, remaining work/divergence, and repository stability. The fixer generates no new implementation evidence after manager return.

## Cancellation And Error Handling

- **Waiting fixer cancelled:** mark `CANCELLED`, discard its nonce, make no handshake call, and do not touch the lock. Other issues continue unless directed otherwise.
- **Call 1 mismatch/absence/tool use:** mark `BLOCKED`, discard the nonce, and make no Call 2. Never adopt a replacement session.
- **Cancellation between calls:** discard authorization and make no Call 2. Never reuse the nonce; later continuation requires a fresh waiting disposition from the original session.
- **Call 2 ID/context mismatch:** mark `BLOCKED` before freshness/implementation tools and never delegate from replacement-session output.
- **Design/review/Task problem before implementation:** use `BLOCKED` for unavailable required tooling and `FAILED` for an actual issue-local failure. Other fixers may continue if the shared worktree is safe.
- **Acquired-lock error/partial/divergence:** the manager stabilizes coherent work before normal release; the fixer reconciles read-only and returns to design/review or reports failure. Resume other issues only when report, lock, and repository state are safe.
- **Manager cannot stabilize or terminates abnormally:** leave the lock in place. No contender removes or takes it over; report a batch-level blocker requiring explicit owner/operator action.
- **Coordinator cancellation:** stop launches/resumes; cancel children only when explicitly requested/supported; report all last dispositions and any active holder. Never remove another session's lock.
- **Unresumable task ID:** a Task error or failed challenge is `BLOCKED`; do not automatically launch a replacement fixer.

## Post-Batch Aggregate Validation

Only after every fixer implementation is `COMPLETED`, no fixer has pending implementation work, and the implementation lock is absent may the coordinator run one final read-only-or-harmless aggregate validation required to test batch coordination. It never stages or commits. Any unexpected tracked/generated diff fails the aggregate check and is reported rather than repaired outside the manager boundary.

For workflow changes that require Task continuity validation, run the plan's harmless live smoke exactly as written: concurrent synthetic fixer sessions, exact-ID recording, nonce-free/tool-free Call 1, verified same-ID Call 2, and safe mismatch detection. If Task concurrency, IDs, resume, nonce retention, or tool-free evidence is unavailable, report workflow validation `BLOCKED`; do not substitute a sequential, one-call, or text-only imitation.

## Prohibited Mechanisms

Do not introduce parallel issue-level implementation, multiple lock-holding managers, direct primary/fixer implementation, extra locks, lock takeover/stale classification, polling, sleeps, retry timers, watchers, queues, schedulers, registries, replacement fixers, branches/worktrees/clones, or merge orchestration. Do not run concurrent developer assignments that overlap in files, contracts, outputs, validation side effects, or ordering.

## Final Reporting

Report the issue(s), core design choice, plan path(s), adversarial-review outcome and material findings, main docs/files changed, manager-run validation commands/results, commit hashes, repository stability, residual risks/follow-ups, and any blocked/cancelled issues. Do not commit `docs/working/` artifacts. After changes to skills or agent prompts, tell the operator to restart OpenCode before relying on them.
