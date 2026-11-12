---
name: saivage-issue-fix-adversarial-review
description: 'Main-coordinator workflow for Saivage v3 issue fixes that go through the full protocol: use ONLY in the primary build or plan session to accept bugs, regressions, review findings, design flaws, behavior gaps or issue-fix workflow changes, intake each issue into the todo tracker, run one issue-fixer at a time as a whole serialized run, record each fixer's exact session ID, continue a waiting or cancelled fixer in its original session at an eligible boundary, apply tracker lifecycle updates at safe boundaries and report dispositions. Clearly trivial fixes are done directly under AGENTS.md. Workers never load this skill.'
---

# Saivage Issue Fix Adversarial Review (Main Coordinator)

Use this skill only in the primary coordinator session that accepts an issue batch: the primary `build` or `plan` agent. Do not select a fixer or another worker as coordinator. Workers never load this skill. Each development role carries its complete procedure in its own agent body under `.opencode/agents/`.

This skill covers issue fixes that go through the full protocol, which is the default for an issue fix. `AGENTS.md` lets the primary do a genuinely simple, clearly understood fix directly, without this skill, a plan, an approval, a tracker entry or a report. In case of doubt about triviality, impact, remedy or scope, use this skill. Non-issue edits need it only when the user frames the work as an issue fix. A clearly trivial wording fix may be assigned directly to a documentation or prompt author and its distinct reviewer, as `AGENTS.md` describes. That direct assignment is not an issue run and launches no fixer.

`AGENTS.md` governs throughout. The complete maintainer reference is [docs/development/issue-fix-protocol.md](../../../docs/development/issue-fix-protocol.md). Consult it for detail this skill does not cover.

## Identities

For a NEW issue started after the canonical transition, launch and continue with agent `issue-fixer`. Its roles are:

- **`issue-fixer`** (`openai/gpt-6.1-sol`): one issue end to end. It owns design and review, merit, freshness, the manager handoff, and its disposition. It launches `issue-designer`, `design-reviewer`, `design-reviewer-secondary` only when a requester explicitly asks, and `implementation-manager`.
- **`implementation-manager`** (unchanged): the only lock holder. It alone invokes the implementation workers: `code-developer`, `doc-developer`, `doc-reviewer`, `prompt-developer`, and `prompt-reviewer`.

For an issue that already started under a pre-transition session, continue that exact original session, whose identity is `fixer`, using its exact recorded session ID. Never replace, re-launch, or rename a running fixer to normalize its identity. The retained profiles `fixer`, `designer`, `reviewer`, `reviewer-2`, `developer`, and `documenter` remain registered for those existing sessions only. Do not launch them for new work.

You never take over an issue's design, review, or implementation. You never launch a designer, reviewer, developer, documenter, author, or implementation reviewer for ordinary issue work. You never request a manager implementation yourself beyond the approved fixer handoff. For a clearly trivial direct wording assignment described above, you invoke the named author and its distinct reviewer yourself, and no other implementation role.

## Launch the batch

1. Intake each issue before launching it. Read `saivage-todo-protocol`, then find the issue's existing entry in `docs/working/todo.md` by its identifier, including a table row inside a section. Merge into that entry and keep its identifier; never create a duplicate. If none exists, add it as Open, or as Analyzed when investigation already exists, with its facts and evidence path.
2. Give each issue a unique absolute working-plan path under `docs/working/<date>-<issue-slug>/`.
3. Give each new issue fixer a complete issue statement, its absolute plan path, and its existing tracker entry identifier with the tracker paths.
4. Launch one new issue fixer at a time, with agent `issue-fixer` through the exposed subagent tool (see Native delegation below). Its whole run (design, review, freshness, manager handoff and read-only reconciliation) is the unit of selection. Do not launch the next new issue, or resume any waiting fixer, while the selected fixer can still launch an implementation manager. Launching fixers in parallel only adds lock contention and wasted calls; the lock is not a reason to fan out.
5. Record, in your session context only, each issue's identity and summary, the exact session ID returned at launch, the identity used, the plan path, the latest disposition, known implementation-lock ownership, and any tracker facts still pending. Session IDs are routing state. Never copy them into `todo.md`, `done.md`, or any repository file.
6. Handle each return before selecting the next run. A failure or cancellation does not cancel other recorded fixers unless directed, and it never makes other work eligible while settlement or shared-worktree safety is unknown.
7. If launch, continuation, or session-ID routing is unavailable, report the batch workflow as blocked. Do not silently weaken it.

### Native delegation and settlement

Use the exposed native subagent tool. Its arguments are the agent ID, a short description, and the complete assignment as the prompt. A continuation names the same agent and passes the recorded session ID as `sessionID`. A launch returns that session ID. Illustrative argument fields, not a callable namespace:

```text
agent: "issue-fixer"
description: "<issue short label>"
prompt: "<complete issue statement, absolute plan path, tracker identifier and tracker paths>"
```

```text
agent: "<identity recorded at launch>"
description: "<continuation label>"
prompt: "<continuation prompt>"
sessionID: "<exact recorded session ID>"
```

Use the exposed tool's contract for any delivery option. Do not assume a background or foreground default, and do not assume a universal execution mode.

A session ID is routing state, not a return. A fixer's return is its substantive final report, which starts with exactly one disposition. For asynchronous delivery, that report arrives with the host's completion or idle message for the round. An idle message without the report, or a session ID alone, does not settle the run. If a launched or continued run produces no substantive report, treat it as a missing result: it is unsettled, it makes no further launch or resume eligible, and you report it as `BLOCKED` with its recorded session ID.

## Handle dispositions

Each fixer return starts with exactly one disposition: `COMPLETED`, `ABANDONED`, `WAITING_FOR_IMPLEMENTATION_LOCK`, `BLOCKED`, `FAILED`, or `CANCELLED`.

- **`COMPLETED`:** record it. Check that the report gives the approval facts (in full, or by reference to the earlier report of this run), the files changed, the manager validation results with whether each was reused or newly run, the commit hashes, and repository stability.
- **`ABANDONED`:** an intentional terminal merit decision not to implement further issue scope. It may come before any implementation or after stabilized partial delivery. Record the delivered scope (units, commit hashes, validation with its failures and limits) and the abandoned remainder separately, and check that the report supports both claims. Do not resume it, replace it, or relaunch it automatically.
- **`WAITING_FOR_IMPLEMENTATION_LOCK`:** record the fixer's exact session ID, its identity, and its waiting facts. Keep it dormant until you select it as the single next run, after the known lock holder has returned, released its lock, and reported a stable committed state. Resume it as described under Resume below. Do not launch a replacement.
- **`BLOCKED` or `FAILED`:** record the stated cause. Do not launch a replacement fixer. Resolve the named cause first.
- **`CANCELLED`:** keep the session ID, identity, plan path, and last known facts, including cumulative prior manager effects, as a dormant cancelled waiter. It resumes only on the owner's direction, as described under Resume below.

## Select one run at a time

Advance only on evidenced settlement:

- A `COMPLETED` issue advances only with its full evidence: the approval facts, manager validation, commit hashes, and stable read-only reconciliation.
- A partial or redesign return that continues the same fixer's design loop keeps that fixer selected until it returns.
- An `ABANDONED`, `BLOCKED`, `FAILED`, or `CANCELLED` return may allow the next run only after its launched calls have settled and the shared worktree is established safe. Such a return is never converted to success and is never retried automatically.
- Unknown settlement, a retained lock, a timeout, a missing result, or an unsafe worktree blocks every further implementation-capable launch and resume. For an unusual state, stop and ask the owner.
- Do not use lock inspection, polling, sleeps, speculative manager calls, or new approval ceremonies to establish eligibility.

At each eligible boundary, select exactly one next run: either one new issue, one recorded waiting fixer whose known lock holder has returned, released its lock, and reported a stable committed state, or one cancelled waiter whose owner has directed continuing it (below). Never select two. Resume the selected fixer as described under Resume, then await that entire run. Leave every other waiter, cancelled waiters included, dormant with its session ID and identity unchanged until a later eligible boundary. Waiters never race for the lock. If the selected fixer's freshness check requires design review, its own design and review loop continues; no other waiter is selected in its place. Do not create a queue, timer, poller, watcher, or extra lock.

## Tracker lifecycle at safe boundaries

Apply the tracker lifecycle from `saivage-todo-protocol` only at a quiescent boundary. Every previously launched or resumed issue call has settled (a fixer whose disposition report has returned counts as settled, including a waiting one; a fixer that could still launch a manager does not), no implementation manager is active or retains the lock, and no launch or resume follows until the bounded update finishes. Establish this from task results and reports. Do not inspect, poll, or wait on the lock to create it. If ownership or settlement is unknown, keep the pending facts in session context, report tracker maintenance as pending, and edit nothing.

At each boundary, apply each affected item's latest evidenced lifecycle once, using the protocol's settlement mapping:

- `COMPLETED` with the approval facts, manager validation, commit hashes, and stable reconciliation: move the entry to Done. If any of that evidence is missing, the entry stays out of Done and the missing evidence is named.
- `WAITING_FOR_IMPLEMENTATION_LOCK` with an approved plan: Designed, with the waiting as a note.
- `ABANDONED`: Analyzed, with an explicit terminal ABANDONED note giving the merit reason and the abandoned scope. Retain delivered units, validation and commit references when any exist, and never move the entry to Done. Claim no implementation only when none occurred. Do not relaunch.
- `BLOCKED`, `FAILED`, or `CANCELLED`: Blocked, with the actual named cause or the cancellation note.
- A design returned to revision after a manager return: Analyzed, with the plan revision needed.

Then select the next run under the rules above. Before a cancelled waiter is resumed, apply its pending cancellation note first. Do not add per-round notifications, intermediate status gates, a queue, or a registry. Do not hold a settled return for an unrelated tracker update beyond the bounded update itself; the next launch or resume waits for that update to finish.

## Resume

Continue a waiting or cancelled fixer with one ordinary continuation call to the agent identity recorded at launch, passing its exact recorded session ID as `sessionID`:

```text
agent: "<the identity recorded at launch>"
description: "<continuation label>"
prompt: "<continuation prompt>"
sessionID: "<exact recorded session ID>"
```

The prompt:

- asks the fixer to continue the named issue from its plan at the recorded absolute path, and gives it the tracker entry identifier and paths;
- for a cancelled waiter, says that the earlier waiting episode was cancelled, and forwards the owner's continuation instruction verbatim;
- for an affected retained session, whose stored procedure still carries the continuity nonce, the challenge and two-call authorization, cancelled-wait re-entry, or an exceptional lock recipe, also forwards the owner's direction that supersedes that procedure, quoted verbatim from your session context. Its own stored body is not changed by this message;
- supplies no freshness conclusion and no approval. The fixer runs its own freshness gate before any manager attempt.

If the owner's direction is not in your session context verbatim when it applies, do not resume that session. Ask the owner.

Handle the return as any other disposition, once its substantive report has returned. The recorded session ID is ordinary routing state. It is not proof of continuity, and this procedure makes no claim to detect a different session. A tool or host failure, or an unusable session ID, is an ordinary blocker: report it, guess no IDs, and launch no replacement fixer.

**Owner-directed continuation of a cancelled waiter.** A cancelled waiter resumes only when all of these hold: the owner explicitly instructs continuing this cancelled issue; you select it as the single next run at an eligible boundary (every prior call settled, the shared worktree safe and stable, no manager lock held, and the known holder has returned and reported a stable state, which a settlement during the cancellation satisfies); and any pending cancellation note is applied first. Cancellation alone never resumes work, and owner direction does not bypass these conditions. If any condition is unknown, block the entry. Do not poll, probe, or send a speculative manager call. The earlier approval and prior manager effects are historical: the resumed fixer checks freshness before any manager attempt, and its reports keep the cumulative effects.

## Manager returns, stray locks and unusual states

- Partial work, divergence, or redesign-worthy learning returns the issue to design and review inside the fixer. A later attempt needs a new freshness check and a new manager lock.
- A manager that could not stabilize and kept the lock is `BLOCKED`. No issue implementation resumes until the owner or operator decides.
- A stray or unexplained lock, an unsettled call, or an unsafe worktree: stop and ask the owner. Do not resume, launch, repair, remove, or take over, and never remove or modify another session's lock. This procedure has no owner-override or interrupted-manager continuation path. A later exceptional step needs a separate owner decision.

## Aggregate acceptance

Run aggregate acceptance only when every issue disposition is exactly `COMPLETED` or `ABANDONED`, no fixer has pending implementation work, and the implementation lock is absent. Any `WAITING_FOR_IMPLEMENTATION_LOCK`, `BLOCKED`, `FAILED`, or `CANCELLED` issue prevents it.

Aggregate checks are harmless: they never stage, commit, repair, or start an implementation attempt. Use only your allowed launch edges. Do not launch an author, an implementation reviewer, a developer, or a retained profile. Do not request a real manager implementation or delegation.

1. **Plan-required aggregate validation.** Run the read-only or harmless aggregate validation that the approved plan requires to test batch coordination. Settle every launched command. Report any unexpected tracked or generated diff as a failed aggregate check. Do not repair it outside the manager boundary.
2. **Scenario evidence.** Report the plan's ordinary waiting, resume, and freshness scenario evidence, and the source validation, separately from implementation completion. Static scenario evidence does not establish live native delegation behavior; say so, and report unavailable evidence as unavailable. Do not run a delegation smoke test, a real cancellation, lock contention, or a manager call merely to test the wording.
3. **Reporting.** Report the aggregate results separately from implementation completion. A failed or blocked aggregate check means the source implementation may be complete while workflow validation is blocked or failed. Route any required correction through ordinary design, review, freshness, and a new serialized manager attempt. Never repair outside a fresh manager attempt.

## Cancellation

Stop further launches and resumes. Cancel children only when explicitly requested and supported. Report every issue's last disposition, identity, and any active lock holder. Never remove another session's lock. Cancelled waiters keep their session ID, identity, and last facts for later owner-directed resumption.

## Reporting

Reporting has two recipients, and each receives the facts it needs to act.

**Internal evidence.** Keep the evidence that a later decision, resume, or review depends on, in your session context or in accessible reports that already exist. No separate report file is required, and a reference to an existing report can carry an unchanged fact. For each issue this covers the issue and plan paths; the tracker entry identifier with its lifecycle applied or pending; the review and final merit outcomes; material findings; the main files and docs changed; the author and reviewer identities used for documentation and model-facing assets; prompt-review evidence when model-facing assets changed; manager validation commands and results, each marked reused or newly run; commit hashes; the delivered and remaining or abandoned scope, with their failures and limits; repository stability; residual risks; and any retained profile the issue used. It also covers the order of selected runs, the boundary evidence used before each launch or resume, and every waiting fixer left dormant, by identifier only. For each owner-directed resumption of a cancelled waiter, keep the owner instruction, the cancellation evidence, the resume result, and the historical facts the run carried. Those facts stay historical and are never presented as new contention or fresh freshness evidence. Session IDs are routing state: they stay in session context and never go into tracker or repository files.

**The user reply.** State each issue's outcome, and any decision or action the user needs. Include:

- for any partly delivered, abandoned, blocked, or cancelled issue, the delivered scope and the remaining or abandoned scope, reported separately. Partial delivery never implies whole-issue completion, and it is never omitted;
- errors, partial effects, uncertainty, blockers, and validation limits that affect the outcome or the user's decision, even when the detailed evidence is only referenced;
- review status as the reviews actually settled. An incomplete review or a blocker handback is reported as blocked or pending, never as a completed review;
- aggregate results, reported separately from implementation completion. Source implementation alone does not establish aggregate acceptance;
- that an issue ran under a retained profile rather than a canonical identity, when that bears on the outcome or the decision;
- the result of any owner-directed resumption of a cancelled waiter, marked as historical carry-over where it applies, and any cancelled or dormant waiter that needs owner direction;
- residual risks the user must weigh.

List paths or file lists only when the user needs them for a decision or action. A brief commit reference may be given when it helps. Give each fact once, refer to earlier reports for unchanged facts, and do not repeat fixed blocks. Do not commit `docs/working/` artifacts.

A running session keeps the stored instructions of its agent body. Ambient and configured instruction files that the root configuration selects are documented to take effect before a running session's next model request, so they can reach a current session while its stored body stays old. A nested AGENTS entry already discovered is not refreshed automatically, and an already-loaded skill keeps its earlier text; a session that later loads a changed skill may read it. Neither a read nor a load proves effective authority or adoption, and a read grants no authority the effective instructions lack. Do not restart OpenCode or rewrite stored sessions to adopt this change. Claim receipt only with evidence supporting that claim, and report any effective instruction conflict as a blocker rather than patching the session.
