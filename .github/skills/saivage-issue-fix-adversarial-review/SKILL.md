---
name: saivage-issue-fix-adversarial-review
description: 'Mandatory Saivage v3 issue-fixing workflow. Use when fixing bugs, regressions, review findings, design flaws, architectural issues, or behavior gaps: create a docs/working design+plan, run two independent reviewers concurrently, triage their union, then implement via the dedicated issue-fix subagents.'
---

# Saivage Issue Fix Adversarial Review

Use this workflow before fixing any concrete issue in Saivage v3, including bugs, regressions, review findings, architectural flaws, behavior gaps, failed validation findings, and operator-reported problems. Also use it when creating or changing operational workflow rules or skills that govern how issues are fixed.

This skill is mandatory for issue fixes and issue-fixing workflow changes. It is not required for trivial non-issue edits such as typo fixes or formatting-only changes unless the user frames the work as fixing an issue or changing the required issue-fix workflow.

When the change creates or revises a skill, also follow `opencode-skill-authoring` for OpenCode skill layout, frontmatter, descriptions, and validation.

Apply the project rules in `AGENTS.md` throughout design, review, implementation, validation, and reporting. Do not duplicate them here; `AGENTS.md` is the single source of truth for clean-architecture, no-compatibility-code, no-over-engineering, fail-fast, documentation-sync, and safety rules.

## Roles

The primary agent owns this workflow and does not design, review, or implement directly. It drives the specialist subagents:

- **`designer`** (`openai/gpt-5.6-sol`) — writes and revises the design/plan, including revisions driven by implementation feedback.
- **`reviewer`** (`openai/gpt-5.6-sol`) — first independent adversarial review of the design/plan.
- **`reviewer-2`** (`nvidia/z-ai/glm-5.2`) — second independent adversarial review under the same review contract.
- **`implementation-manager`** (`openai/gpt-5.6-sol`) — decomposes the approved plan into tasks, drives them to completion, and reports divergences and learnings; the only agent that spawns the `developer`.
- **`developer`** (`openai/gpt-5.6-sol`) — leaf implementer of individual plan tasks.

## Objectives

- Prevent local band-aids by designing the fix before editing implementation code.
- Force two independent, model-diverse skeptical reviews before implementation.
- Treat adversarial findings as hypotheses, not truth: confirm each finding is sound and real before changing the design.
- Repeat paired review and revision until neither review has a confirmed material finding.
- Keep working artifacts out of Git while keeping main docs synchronized with implemented behavior.

## Required Working Files

Create a working directory under `docs/working/` for the issue, for example `docs/working/<date>-<issue-slug>/`, holding the current design/plan and three files per adversarial review round: one verbatim raw response from each reviewer and a separate union-triage synthesis.

Rules:

- `docs/working/` is ignored and must not be committed. Its files are temporary working documents only, not main documentation and not a substitute for updating the canonical main docs: `docs/spec/system-specification.md`, `docs/spec/operator-ui.md`, `docs/architecture/system-architecture.md`, and `README.md`.
- Keep each revised design/plan self-contained. Do not require readers to diff prior rounds to understand the current plan.
- Store each raw reviewer output verbatim in a distinct reviewer-attributed file such as `round-<n>-reviewer.md` and `round-<n>-reviewer-2.md`. Never summarize, combine, edit, or normalize these raw responses.
- Put classifications, deduplication, and remediation decisions only in `round-<n>-synthesis.md`, citing both raw artifacts when they identify the same issue and preserving meaningful evidence differences.

## Design And Plan Requirements

The first design/plan must include:

- Problem statement with evidence and affected user/runtime behavior.
- Root-cause analysis, or the best current hypothesis if the root cause is still being investigated.
- Scope and non-scope. Non-essential robustness and rare edge-case handling (e.g. corrupted-file recovery) must be listed as deferred follow-ups, not bundled into the fix; expand scope only when a deferred item would block the core change or leave the system unsafe (see Changeset Scope Discipline in `AGENTS.md`).
- Proposed design, including affected modules, data contracts, APIs, and UI/runtime surfaces as applicable.
- Alternatives considered, including at least one broader/root-cause alternative when reasonable.
- Implementation plan with ordered steps split into three explicit sections:
  - Main work tasks.
  - Cleanup tasks: obsolete/dead code, obsolete tests, stale fixtures, and superseded docs or scripts to remove or update as part of the fix.
  - Documentation-update tasks: the specific main docs to update as part of the implementation, and the changes each needs. Documentation updates are implementation work, executed alongside the code changes by the `developer`, not a separate phase. Do not count the working design/plan itself as a documentation update. Canonical main docs:
    - `docs/spec/system-specification.md` — functional behavior.
    - `docs/spec/operator-ui.md` — operator UI behavior.
    - `docs/architecture/system-architecture.md` — architecture and runtime contracts.
    - `README.md` — validation profiles and documentation authority status.
- If current main docs are already stale or inconsistent with the implementation for the area being changed, document that finding and include tasks to correct those docs as part of the same change. Keep the correction scoped to the parts related to the issue/fix; do not expand into an unrelated documentation rewrite.
- Validation plan with focused checks and broader gates appropriate to the risk.
- Risks, rollback considerations, and unresolved questions.

## Adversarial Review And Revision Loop

Enter this loop, using the `designer` subagent for all plan authoring and both reviewer subagents for every review round:

1. Have the `designer` subagent write or revise the self-contained design/plan under `docs/working/` (see Designer Subagent below). For revisions, pass the designer the material findings to address.
2. Finish the complete plan revision before dispatch. Emit independent Task calls for `reviewer` and `reviewer-2` in the same assistant turn, using the available parallel mechanism or wrapper, with the same absolute plan path and verification request. Neither review receives the other's output. Do not invent a batch Task schema and do not fall back to sequential calls.
3. Wait for both calls, then persist each raw response verbatim in its own reviewer-attributed artifact. Create a separate synthesis artifact and triage the union per Finding Triage. Deduplicate only remediation items, cite both sources, preserve meaningful evidence differences, and validate conflicts against repository evidence rather than voting.
4. Decide whether to run another paired round: if either review contains a confirmed material finding, loop back to step 1. Stop and implement only when neither review has a confirmed material finding. A clean review cannot cancel the other's material finding. Before looping back, check Reassessment On Repeated Review Loops below.

One round means one completed plan revision and its pair of concurrent reviews, not each reviewer output. If concurrent Task dispatch is unavailable, or either required call cannot launch or return, fail fast under Escalation And Blockers; do not serialize the calls or treat one result as a passing round.

### Reassessment On Repeated Review Loops

The review loop can keep surfacing new material findings without converging when the
issue is aimed at the wrong level/layer/component, the root cause is not being solved
at the right place, or the plan is over-complicated. Repeated rounds are a signal to
step back, not just to keep revising the same plan.

The primary agent — not the `designer` or either reviewer — runs this reassessment, because
only the primary synthesizes the combined triage history across rounds. Trigger it when any of these is
true:

- Roughly three or more paired review rounds have returned material findings.
- The same or closely related findings recur in either review stream after being addressed.
- Each revision keeps widening scope or shifting the fix rather than converging it.

When triggered, pause the loop and re-evaluate the overall approach along these axes:

First synthesize agreements, complementary findings, conflicts, and recurring themes across both reviewers and all prior paired rounds. Give the designer one consolidated re-aimed framing; do not privilege one review stream or count the two outputs as separate rounds.

- **Layer/component fit**: is the fix applied at the layer or component where the
  root cause actually lives, or is it patching a symptom one level away?
- **Root-cause placement**: does the plan solve the root cause directly, or does it
  add compensating logic that a deeper fix would remove?
- **Complexity and scope**: is the plan over-complicated, over-scoped, or bundling
  deferred concerns that should be split out (see Changeset Scope Discipline in
  `AGENTS.md`)?
- **Issue framing**: is the issue itself stated at the wrong level, so that no plan
  at this layer can satisfy review?

Act on the reassessment with exactly one of:

- **Simplify** the plan: cut complexity and deferred concerns; re-aim at the minimal
  coherent fix.
- **Re-scope** the issue: narrow or shift the stated scope to match where the real
  problem is.
- **Move the fix**: relocate the design to the correct component/layer and update the
  affected modules, contracts, and call sites accordingly.
- **Ask the user**: when the tradeoff between the options above is unclear or the
  issue framing itself is in question (this overlaps with Escalation And Blockers
  below).

Reassessment is not an exit from the loop. After re-aiming the design (or receiving
user direction), hand the revised framing to the `designer`, resume the Adversarial
Review And Revision Loop, and proceed to implementation only once findings are false
or minor. Reassessment must not be used to skip review or to push through material
findings.

### Designer Subagent

Use the project's `designer` subagent (`.opencode/agents/designer.md`, pinned to `openai/gpt-5.6-sol`) for all design/plan authoring. It applies the `AGENTS.md` rules and writes plans that satisfy the Design And Plan Requirements above.

Invoke it via the Task tool with `subagent_type: "designer"`, passing the issue/context and the absolute path of the working file to write. For revisions, also pass the material findings to address. Example:

```text
Write the Saivage v3 issue-fix design/plan for: <issue description>.
Write the self-contained plan to <absolute-path>, satisfying the
Design And Plan Requirements in this skill.
```

### Reviewer Subagents

Use both of the project's read-only reviewer subagents for every plan revision: `.opencode/agents/reviewer.md`, pinned to `openai/gpt-5.6-sol`, and `.opencode/agents/reviewer-2.md`, pinned to `nvidia/z-ai/glm-5.2`. They have equivalent review checklists, evidence requirements, permissions, and verdict formats. Neither can mutate the repository or spawn a task.

Invoke them through two independent Task calls emitted in the same assistant turn, one with `subagent_type: "reviewer"` and one with `subagent_type: "reviewer-2"`. Use the available parallel mechanism or wrapper, without prescribing a fabricated batch payload. Give both the same prompt containing the absolute path to the current design/plan, for example:

```text
Review the Saivage v3 issue-fix design/plan at <absolute-path>.
Read it fully, verify its claims against current code and docs, and return
your findings plus your verdict.
```

Save both outputs verbatim and separately, then write the distinct synthesis artifact described above.

### Finding Triage

Do not blindly accept adversarial findings and do not resolve conflicts by vote. Classify every finding in the union:

- **False**: speculative, preference-only, contradicted by current project rules, or outside the agreed scope. Reject it.
- **Minor**: factually correct but too small to affect the design or plan (e.g. wording, a clarifying note, a low-impact cleanup). Note it and proceed; it does not force another review round and need not block implementation.
- **Material**: real and significant enough to change the design or plan. Revise the design/plan to address it directly.
- **Deferred**: real but should not be fixed in this issue. Record why it is deferred and whether it needs a follow-up. Non-core robustness and rare edge-case handling that would expand the fix beyond its minimal coherent unit belong here, with a recorded follow-up.

### Escalation And Blockers

- Stop and ask the user if the loop reaches repeated disagreement, unclear scope, or a tradeoff that needs operator choice. Run Reassessment On Repeated Review Loops first; escalate here only when re-aiming cannot resolve the tradeoff.
- If the subagent tooling is unavailable, report that blocker explicitly, do not claim that adversarial review passed, and proceed only when the user has directed you to continue despite the blocker, or the change is needed to repair the review workflow itself.
- If the environment cannot dispatch both reviewer calls concurrently, or either reviewer cannot launch or return, stop and report the blocker. Never serialize the pair, substitute one reviewer, or approve a round from one output.

## Implementation

Only after the design/plan has passed the paired review loop, hand it to the `implementation-manager` subagent, which decomposes the plan into ordered tasks and drives them to completion via the `developer` subagent (see Implementation Manager Subagent below). The `designer` and reviewer subagents are for planning and review only; the primary agent does not implement directly.

### Implementation Manager Subagent

Use the project's `implementation-manager` subagent (`.opencode/agents/implementation-manager.md`, pinned to `openai/gpt-5.6-sol`) to run an approved plan to completion. It breaks the plan into ordered tasks, delegates each to the `developer` subagent, tracks progress, runs integration validation, and is scoped to spawn only the `developer` subagent.

Invoke it via the Task tool with `subagent_type: "implementation-manager"`, passing the absolute path of the approved design/plan. Example:

```text
Run the approved Saivage v3 issue-fix design/plan at <absolute-path> to completion.
```

### Handling Every Manager Return

The `implementation-manager` reports on every return: completion status (fully done vs partial), tasks completed and remaining, validation results, any divergences from the plan, and anything learned during implementation that might warrant a redesign. Every time it returns, act on that report:

1. If the report shows the plan fully executed with no divergences and no redesign-worthy learnings, proceed to Validation And Reporting.
2. Otherwise — work remains, the run was partial, the implementation diverged from or contradicted the plan, or implementation surfaced something that warrants a redesign — have the `designer` revise or partially redesign the plan based on the report, run another full Adversarial Review And Revision Loop until no material findings remain, then call the `implementation-manager` again with the revised plan. Repeat from step 1.

## Validation And Reporting

Run validation appropriate to the change, using `saivage-development-validation` when the change touches TypeScript runtime code, Vue UI, API contracts, docs, or deployment behavior.

Final report should include:

- The issue fixed and the core design choice.
- Confirmation that both adversarial reviews were completed concurrently and the final union had no confirmed material finding, or a clear blocker if either review could not run.
- The two reviewer-attributed raw artifact paths and their separate synthesis artifact path.
- Confirmed findings that changed the plan, if any.
- Main docs updated.
- Validation commands run and their results.
- Any residual risks or follow-ups.

Do not commit `docs/working/` artifacts. Commit only source, tests, main docs, and configuration changes that belong in Git.
