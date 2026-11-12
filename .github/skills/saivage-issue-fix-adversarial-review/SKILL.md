---
name: saivage-issue-fix-adversarial-review
description: 'Main-coordinator workflow for Saivage v3 issue-fix batches: use ONLY in the primary build or plan session to accept bugs, regressions, review findings, design flaws, behavior gaps or issue-fix workflow changes, intake each issue into the todo tracker, run one issue-fixer at a time as a whole serialized run, record exact fixer task IDs, resume one waiting fixer at a time through the two-call handshake, apply tracker lifecycle updates at safe boundaries and report dispositions. Workers never load this skill.'
---

# Saivage Issue Fix Adversarial Review (Main Coordinator)

Use this skill only in the primary coordinator session that accepts an issue batch: the primary `build` or `plan` agent. Do not select a fixer or another worker as coordinator. Workers never load this skill. Each development role carries its complete procedure in its own agent body under `.opencode/agents/`.

This workflow is mandatory for any issue fix and for any change to the issue-fix workflow itself. It is not needed for trivial non-issue edits unless the user frames the work as an issue fix.

`AGENTS.md` governs throughout. The complete maintainer reference is [docs/development/issue-fix-protocol.md](../../../docs/development/issue-fix-protocol.md). Consult it for detail this skill does not cover.

## Identities

For a NEW issue started after the canonical transition, launch and resume with `issue-fixer`. Its roles are:

- **`issue-fixer`** (`openai/gpt-6.1-sol`): one issue end to end. It owns design and review, merit, freshness, the manager handoff, and its disposition. It launches `issue-designer`, `design-reviewer`, `design-reviewer-secondary` only when a requester explicitly asks, and `implementation-manager`.
- **`implementation-manager`** (unchanged): the only lock holder. It alone invokes the implementation workers: `code-developer`, `doc-developer`, `doc-reviewer`, `prompt-developer`, and `prompt-reviewer`.

For an issue that already started under a pre-transition session, resume its exact original identity, `fixer`, with the exact returned task ID. Never replace, re-launch, or rename a running fixer to normalize its identity. The retained profiles `fixer`, `designer`, `reviewer`, `reviewer-2`, `developer`, and `documenter` remain registered for those existing sessions only. Do not launch them for new work.

You never take over an issue's design, review, or implementation. You never launch a designer, reviewer, developer, documenter, author, or implementation reviewer for ordinary issue work. You never request a manager implementation yourself beyond the approved fixer handoff.

## Launch the batch

1. Intake each issue before launching it. Read `saivage-todo-protocol`, then find the issue's existing entry in `docs/working/todo.md` by its identifier, including a table row inside a section. Merge into that entry and keep its identifier; never create a duplicate. If none exists, add it as Open, or as Analyzed when investigation already exists, with its facts and evidence path.
2. Give each issue a unique absolute working-plan path under `docs/working/<date>-<issue-slug>/`.
3. Give each new issue fixer a complete issue statement, its absolute plan path, and its existing tracker entry identifier with the tracker paths.
4. Launch one new issue fixer at a time, with `subagent_type: "issue-fixer"`. Its whole run (design, review, freshness, manager handoff and read-only reconciliation) is the unit of selection. Do not launch the next new issue, or resume any waiting fixer, while the selected fixer can still launch an implementation manager. Launching fixers in parallel only adds lock contention and wasted calls; the lock is not a reason to fan out.
5. Record, in your session context only, each issue's identity and summary, the exact returned fixer task ID, the fixer identity used, the plan path, the latest disposition, known implementation-lock ownership, any nonce, and any tracker facts still pending. Task IDs, nonces, and handshake records are task-continuity state. Never copy them into `todo.md`, `done.md`, or any repository file.
6. Handle each return before selecting the next run. A failure or cancellation does not cancel other recorded fixers unless directed, and it never makes other work eligible while settlement or shared-worktree safety is unknown.
7. If launch, resume, or exact returned-ID observation is unavailable, report the batch workflow as blocked. Do not silently weaken it.

## Handle dispositions

Each fixer return starts with exactly one disposition: `COMPLETED`, `ABANDONED`, `WAITING_FOR_IMPLEMENTATION_LOCK`, `BLOCKED`, `FAILED`, or `CANCELLED`.

- **`COMPLETED`:** record it. Check that the report includes the unchanged plan-approval block, files changed, manager validation results, commit hashes, and repository stability.
- **`ABANDONED`:** an intentional terminal merit decision not to implement further issue scope. It may come before any implementation or after stabilized partial delivery. Record the delivered scope (units, commit hashes, validation with its failures and limits) and the abandoned remainder separately, and check that the report supports both claims. Do not resume it, replace it, or relaunch it automatically.
- **`WAITING_FOR_IMPLEMENTATION_LOCK`:** record the fixer's fresh continuity nonce with its exact task ID and identity, replacing any earlier nonce for that issue. Do not launch a replacement. Keep it dormant until the coordinator selects it as the single next run. Resume it only through the two-call handshake below, and only after the known lock holder has returned, released its lock, and reported a stable committed state.
- **`BLOCKED` or `FAILED`:** record the stated cause. Do not launch a replacement fixer. Resolve the named cause first.
- **`CANCELLED`:** discard any nonce. Do not touch the lock.

## Select one run at a time

Advance only on evidenced settlement:

- A `COMPLETED` issue advances only with its full evidence: the approval block, manager validation, commit hashes, and stable read-only reconciliation.
- A partial or redesign return that continues the same fixer's design loop keeps that fixer selected until it returns.
- An `ABANDONED`, `BLOCKED`, `FAILED`, or `CANCELLED` return may allow the next run only after its launched calls have settled and the shared worktree is established safe. Such a return is never converted to success and is never retried automatically.
- Unknown settlement, a retained lock, a timeout, a missing result, or an unsafe worktree blocks every further implementation-capable launch and resume.
- Do not use lock inspection, polling, sleeps, speculative manager calls, or new approval ceremonies to establish eligibility.

At each eligible boundary, select exactly one next run: either one new issue, or one recorded waiting fixer whose known lock holder has returned, released its lock, and reported a stable committed state. Never select two. A selected waiter resumes through the two-call handshake, then you await that entire run. Leave every other recorded waiter dormant, with its task ID, identity, and nonce episode unchanged, until a later eligible boundary. Waiters never race for the lock. If the selected waiter's freshness check requires design review, its own design and review loop continues; no other waiter is selected in its place. Do not create a queue, timer, poller, watcher, or extra lock.

## Tracker lifecycle at safe boundaries

Apply the tracker lifecycle from `saivage-todo-protocol` only at a quiescent boundary. Every previously launched or resumed issue call has settled (a returned waiting fixer counts as settled; a fixer that could still launch a manager does not), no implementation manager is active or retains the lock, and no launch or resume follows until the bounded update finishes. Establish this from task results and reports. Do not inspect, poll, or wait on the lock to create it. If ownership or settlement is unknown, keep the pending facts in session context, report tracker maintenance as pending, and edit nothing.

At each boundary, apply each affected item's latest evidenced lifecycle once, using the protocol's settlement mapping:

- `COMPLETED` with the approval block, manager validation, commit hashes, and stable reconciliation: move the entry to Done. If any of that evidence is missing, the entry stays out of Done and the missing evidence is named.
- `WAITING_FOR_IMPLEMENTATION_LOCK` with an approved plan: Designed, with the waiting as a note.
- `ABANDONED`: Analyzed, with an explicit terminal ABANDONED note giving the merit reason and the abandoned scope. Retain delivered units, validation and commit references when any exist, and never move the entry to Done. Claim no implementation only when none occurred. Do not relaunch.
- `BLOCKED`, `FAILED`, or `CANCELLED`: Blocked, with the actual named cause or the cancellation note.
- A design returned to revision after a manager return: Analyzed, with the plan revision needed.

Then select the next run under the rules above. Do not add per-round notifications, intermediate status gates, a queue, or a registry. Do not hold a settled return for an unrelated tracker update beyond the bounded update itself; the next launch or resume waits for that update to finish.

## Two-call resume handshake

Both calls use the same identity the fixer was launched under and its exact recorded task ID:

- for a new issue: `subagent_type: "issue-fixer"`;
- for a pre-transition issue: `subagent_type: "fixer"`.

```text
subagent_type: "<the identity recorded at launch>"
task_id: "<exact recorded task ID>"
```

**Call 1, challenge.** Do not include the expected nonce. The prompt unconditionally forbids tools, edits, commands, and every mutation. It asks only for the issue identity, the plan path, the prior `WAITING_FOR_IMPLEMENTATION_LOCK` disposition, and the nonce the fixer retained in its session context. Independently verify that the returned task ID is byte-for-byte identical to the requested ID and that all retained values exactly match your record. Record the result in session context; it is never a tracker field:

```text
Requested task ID: <exact recorded ID>
Returned task ID: <Task result ID>
Continuity: CONFIRMED | BLOCKED
Prior issue from session context: <identifier or unavailable>
Prior plan from session context: <path or unavailable>
Prior disposition from session context: <WAITING_FOR_IMPLEMENTATION_LOCK or unavailable>
Retained nonce from session context: <opaque value or unavailable>
```

`CONFIRMED` requires no tool use or mutation, all four retained values matching, and identical requested and returned IDs. Any mismatch, absence, task-ID mismatch, or tool use makes the issue `BLOCKED`. Discard the nonce and make no Call 2. An invalid ID may create a new session, but its output is never adopted and it cannot know the undisclosed nonce.

**Call 2, authorization.** Only after `CONFIRMED`, invoke the same exact task ID again with the same identity. The prompt authorizes the read-only freshness gate and, only if the plan is still approved, manager delegation. Independently verify the returned ID again. The fixer confirms that the handshake succeeded before any tool use. If it reports missing context, treat the result as `BLOCKED` and never delegate from its output. Successful authorization consumes the nonce.

**Cancellation between calls.** Discard the authorization and make no Call 2. The nonce is never reused. A later continuation needs a fresh waiting disposition from the original session.

## Manager returns, stray locks and owner authorizations

The fixer reconciles a manager return read-only. You do not perform implementation reconciliation yourself.

- Completed work with no divergence is reported as `COMPLETED`.
- Partial work, divergence, or redesign-worthy learning returns the issue to design and review. Planning-file edits remain allowed. A later attempt needs a new freshness check and a new manager lock.
- A manager that could not stabilize and kept the lock is `BLOCKED`. No issue implementation resumes until explicit owner or operator verification and repair.

A manager may already have recorded its own in-progress or partial tracker state before release. Reconcile that with the fixer's disposition at the next safe boundary. Never write a tracker file while a manager attempt is active.

Use an owner override only when the owner explicitly says an existing lock was wrongly acquired by an unrelated run and must be left untouched. Quote that instruction exactly in the initial assignment to the fixer. You guarantee that this is the sole writing agent until the run reports completion. Never remove or modify the lock. Each responsible fixer re-checks before a new attempt whether the stray lock is gone.

Interrupted owner continuation is allowed only when the explicit project owner authorizes continuing the original interrupted manager session. You never create a replacement manager or transfer ownership. The original manager must itself establish identity, acquisition, and settlement. If it cannot, it remains blocked with the lock untouched.

## Aggregate acceptance

Run aggregate acceptance only when every issue disposition is exactly `COMPLETED` or `ABANDONED`, no fixer has pending implementation work, and the implementation lock is absent. Any `WAITING_FOR_IMPLEMENTATION_LOCK`, `BLOCKED`, `FAILED`, or `CANCELLED` issue prevents it.

Aggregate checks are harmless: they never stage, commit, repair, or start an implementation attempt. Use only your allowed launch edges. Do not launch an author, an implementation reviewer, a developer, or a retained profile. Do not request a real manager implementation or delegation.

1. **Plan-required aggregate validation.** Run the read-only or harmless aggregate validation that the approved plan requires to test batch coordination. Settle every launched command. Report any unexpected tracked or generated diff as a failed aggregate check. Do not repair it outside the manager boundary.
2. **Passive role checks.** When the approved plan requires them, run fresh passive checks of `issue-designer`, `design-reviewer`, an explicitly requested `design-reviewer-secondary`, and `implementation-manager`, using only their allowed edges. Each check is a fresh no-tool session that explains decisions only. It never reads a plan, acquires a lock, or delegates. Verify main-only skill access through the build and plan primaries. Passive checks never launch implementation roles.
3. **Conditional continuity smoke.** Run this only when the approved plan of a completed issue is a workflow change that requires Task continuity validation. Then execute that plan's specified smoke exactly as written, and do not substitute your own version. Its requirements are: concurrent synthetic `issue-fixer` sessions in one tool batch; exact returned-ID recording; a nonce-free, tool-free challenge whose returned ID and retained values match your record before any further call; a same-ID authorization only after that match; and a safe mismatch check that marks the synthetic episode `BLOCKED` without sending the second call. Never launch guessed IDs or substitute sessions. Its synthetic episodes acquire no lock, invoke no manager, and implement nothing; their concurrency is the approved validation requirement, not live issue fanout. If the plan's required concurrency, IDs, resume, nonce retention, or tool-free evidence is unavailable, report workflow validation as `BLOCKED`. Do not replace it with a sequential, one-call, or text-only imitation.
4. **Reporting.** Report the aggregate results separately from implementation completion. A failed or blocked aggregate check means the source implementation may be complete while workflow validation is blocked or failed. Route any required correction through ordinary design, review, freshness, and a new serialized manager attempt. Never repair outside a fresh manager attempt.

## Cancellation

Stop further launches and resumes. Cancel children only when explicitly requested and supported. Report every issue's last disposition, identity, and any active lock holder. Never remove another session's lock.

## Reporting

Report the issues, the core design choice, the plan paths, the tracker entry identifiers with their lifecycle applied or pending, the review and final merit outcomes, material findings, the main files and docs changed, the author and reviewer identities used for documentation and model-facing assets, prompt-review evidence when model-facing assets changed, manager validation commands and results, commit hashes, repository stability, residual risks, and any abandoned, blocked, or cancelled issues. Also report each selected run in order, the boundary evidence used before each launch or resume, and every waiting fixer left dormant, by identifier only. When an issue used a retained profile rather than a canonical identity, say so. For an abandoned or partly delivered issue, report the delivered scope and the abandoned remainder factually. Never imply whole-issue completion, and never omit partial delivery the reports show. Do not commit `docs/working/` artifacts.

A running session keeps the stored instructions of its agent body. Shared skills and instruction files may be consumed by sessions that load them after this change; consumption is not proof of effective authority or adoption. Do not restart OpenCode or rewrite stored sessions to adopt this change, do not claim that a running session discovered a changed file, and report any effective instruction conflict as a blocker rather than patching the session.
