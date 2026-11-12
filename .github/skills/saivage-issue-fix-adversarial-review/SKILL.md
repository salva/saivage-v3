---
name: saivage-issue-fix-adversarial-review
description: 'Main-coordinator workflow for Saivage v3 issue-fix batches: use ONLY in the primary build or plan session to accept bugs, regressions, review findings, design flaws, behavior gaps or issue-fix workflow changes, launch one fixer per issue concurrently, record exact fixer task IDs, run the two-call waiting resume and report dispositions. Workers never load this skill.'
---

# Saivage Issue Fix Adversarial Review (Main Coordinator)

Use this skill only in the primary coordinator session that accepts an issue batch: the primary `build` or `plan` agent. Select a real primary session for batch coordination. Do not select `fixer` or another worker as coordinator. Workers never load this skill. Each development role carries its complete procedure in its own agent body under `.opencode/agents/`.

This workflow is mandatory for any issue fix and for any change to the issue-fix workflow itself. It is not needed for trivial non-issue edits unless the user frames the work as an issue fix.

`AGENTS.md` governs throughout. The complete maintainer reference is [docs/development/issue-fix-protocol.md](../../../docs/development/issue-fix-protocol.md). Consult it for detail this skill does not cover.

## Roles you coordinate

- **`fixer`**: one per issue. Owns the design and review loop, merit gates, freshness decisions, the implementation-manager handoff, and the disposition.
- **`designer` and `reviewer`**: launched by the fixer. The reviewer reviews every plan revision. `reviewer-2` only when a requester explicitly asks.
- **`implementation-manager`**: the only lock holder. Launched by the fixer. It alone invokes `developer`, `documenter`, and the exact Sol prompt reviewer.

You never take over an issue's design, review, or implementation. You never launch `developer` or `documenter` directly. You never request a manager implementation yourself beyond the approved fixer handoff.

## Launch the batch

1. Give each issue a unique absolute working-plan path under `docs/working/<date>-<issue-slug>/`.
2. Give each fixer a complete issue statement and its absolute plan path.
3. Launch all initial fixers concurrently, in the same orchestration turn or tool batch, with `subagent_type: "fixer"`. Do not serialize design or review because issues may touch the same files.
4. Record, in your session context and never in a repository file, each issue's identity and summary, the exact returned fixer task ID, the plan path, the latest disposition, known implementation-lock ownership, and any nonce.
5. Handle each return independently. One failure or cancellation does not cancel the others unless directed.
6. If concurrent launch or exact returned-ID observation is unavailable, report the batch workflow as blocked. Do not silently weaken it.

## Handle dispositions

Each fixer return starts with exactly one disposition: `COMPLETED`, `ABANDONED`, `WAITING_FOR_IMPLEMENTATION_LOCK`, `BLOCKED`, `FAILED`, or `CANCELLED`.

- **`COMPLETED`:** record it. Check that the report includes the unchanged plan-approval block, files changed, manager validation results, commit hashes, and repository stability.
- **`ABANDONED`:** an intentional terminal no-implementation decision. Do not resume it, replace it, or relaunch it automatically.
- **`WAITING_FOR_IMPLEMENTATION_LOCK`:** record the fixer's fresh continuity nonce with its exact task ID, replacing any earlier nonce for that issue. Do not launch a replacement. Resume only through the two-call handshake below, and only after the known lock holder has returned, released its lock, and reported a stable committed state.
- **`BLOCKED` or `FAILED`:** record the stated cause. Do not automatically launch a replacement fixer. Resolve the named cause first.
- **`CANCELLED`:** discard any nonce. Do not touch the lock.

Several waiting fixers may be resumed optimistically. One manager wins and the others wait again. Do not create a queue, timer, poller, watcher, or extra lock.

## Two-call resume handshake

Both calls use:

```text
subagent_type: "fixer"
task_id: "<exact recorded task ID>"
```

**Call 1, challenge.** Do not include the expected nonce. The prompt unconditionally forbids tools, edits, commands, and every mutation. It asks only for the issue identity, the plan path, the prior `WAITING_FOR_IMPLEMENTATION_LOCK` disposition, and the nonce the fixer retained in its session context. Independently verify that the Task result's returned ID is byte-for-byte identical to the requested ID and that all retained values exactly match your record. Record the result:

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

**Call 2, authorization.** Only after `CONFIRMED`, invoke the same exact task ID again. The prompt authorizes the read-only freshness gate and, only if the plan is still approved, manager delegation. Independently verify the returned ID again. The fixer must confirm that the handshake succeeded before any tool use. If it reports missing context, treat the result as `BLOCKED` and never delegate from its output. Successful authorization consumes the nonce.

**Cancellation between calls.** Discard the authorization and make no Call 2. The nonce is never reused. A later continuation needs a fresh waiting disposition from the original session.

## Manager returns, stray locks and owner authorizations

The fixer reconciles a manager return read-only. You do not perform implementation reconciliation yourself.

- Completed work with no divergence is reported as `COMPLETED`.
- Partial work, divergence, or redesign-worthy learning returns the issue to design and review. Planning-file edits remain allowed. A later attempt needs a new freshness check and a new manager lock.
- A manager that could not stabilize and kept the lock is `BLOCKED`. No issue implementation resumes until explicit owner or operator verification and repair.

Use an owner-override only when the owner explicitly says an existing lock was wrongly acquired by an unrelated run and must be left untouched. Quote that instruction exactly in the initial assignment to the manager. You guarantee that this is the sole writing agent until the run reports completion. Never remove or modify the lock. Each responsible fixer re-checks before a new attempt whether the stray lock is gone.

Interrupted owner continuation is allowed only when the explicit project owner authorizes continuing the original interrupted manager session. You never create a replacement manager or transfer ownership. The original manager must itself establish identity, acquisition, and settlement. If it cannot, it remains blocked with the lock untouched.

## Aggregate acceptance

Run aggregate acceptance only when every issue disposition is exactly `COMPLETED` or `ABANDONED`, no fixer has pending implementation work, and the implementation lock is absent. Any `WAITING_FOR_IMPLEMENTATION_LOCK`, `BLOCKED`, `FAILED`, or `CANCELLED` issue prevents it.

Aggregate checks are harmless: they never stage, commit, repair, or start an implementation attempt. Use only your allowed launch edges. Do not launch `developer` or `documenter`, and do not request a real manager implementation or delegation.

1. **Plan-required aggregate validation.** Run the read-only or harmless aggregate validation that the approved plan requires to test batch coordination. Settle every launched command. Report any unexpected tracked or generated diff as a failed aggregate check. Do not repair it outside the manager boundary.
2. **Conditional continuity smoke.** Run this only when the approved plan of a completed issue is a workflow change that requires Task continuity validation. Then execute that plan's specified smoke exactly as written, and do not substitute your own version. Its requirements are: concurrent synthetic fixer sessions in one tool batch; exact returned-ID recording; a nonce-free, tool-free challenge whose returned ID and retained values match your record before any further call; a same-ID authorization only after that match; and a safe mismatch check that marks the synthetic episode `BLOCKED` without sending the second call. Never launch guessed IDs or substitute sessions. If the plan's required concurrency, IDs, resume, nonce retention, or tool-free evidence is unavailable, report workflow validation as `BLOCKED`. Do not replace it with a sequential, one-call, or text-only imitation.
3. **Reporting.** Report the aggregate results separately from implementation completion. A failed or blocked aggregate check means the source implementation may be complete while workflow validation is blocked or failed. Route any required correction through ordinary design, review, freshness, and a new serialized manager attempt. Never repair outside a fresh manager attempt.

## Cancellation

Stop further launches and resumes. Cancel children only when explicitly requested and supported. Report every issue's last disposition and any active lock holder. Never remove another session's lock.

## Reporting

Report the issues, the core design choice, the plan paths, the review and final merit outcomes, material findings, the main files and docs changed, documenter authorship and prompt-review evidence when model-facing assets changed, manager validation commands and results, commit hashes, repository stability, residual risks, and any abandoned, blocked, or cancelled issues. Never imply that an abandoned issue was implemented. Do not commit `docs/working/` artifacts.

After any change to skills or agent prompts, tell the operator to restart OpenCode before relying on them. A running session does not newly discover a changed file.
