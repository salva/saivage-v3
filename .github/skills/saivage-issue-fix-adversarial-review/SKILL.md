---
name: saivage-issue-fix-adversarial-review
description: 'Mandatory Saivage v3 issue-fixing workflow. Use when fixing bugs, regressions, review findings, design flaws, architectural issues, or behavior gaps: create a docs/working design+plan, run adversarial subagent review, critically validate findings, iterate until every finding is false or minor, then implement via the dedicated issue-fix subagents.'
---

# Saivage Issue Fix Adversarial Review

Use this workflow before fixing any concrete issue in Saivage v3, including bugs, regressions, review findings, architectural flaws, behavior gaps, failed validation findings, and operator-reported problems. Also use it when creating or changing operational workflow rules or skills that govern how issues are fixed.

This skill is mandatory for issue fixes and issue-fixing workflow changes. It is not required for trivial non-issue edits such as typo fixes or formatting-only changes unless the user frames the work as fixing an issue or changing the required issue-fix workflow.

When the change creates or revises a skill, also follow `opencode-skill-authoring` for OpenCode skill layout, frontmatter, descriptions, and validation.

Apply the project rules in `AGENTS.md` throughout design, review, implementation, validation, and reporting. Do not duplicate them here; `AGENTS.md` is the single source of truth for clean-architecture, no-compatibility-code, no-over-engineering, fail-fast, documentation-sync, and safety rules.

## Roles

The primary agent owns this workflow and does not design, review, or implement directly. It drives the specialist subagents:

- **`designer`** (`zai-coding-plan/glm-5.2`) — writes and revises the design/plan, including revisions driven by implementation feedback.
- **`reviewer`** (`openai/gpt-5.5`) — adversarial review of the design/plan.
- **`implementation-manager`** (`openai/gpt-5.5`) — decomposes the approved plan into tasks, drives them to completion, and reports divergences and learnings; the only agent that spawns the `developer`.
- **`developer`** (`openai/gpt-5.5`) — leaf implementer of individual plan tasks.

## Objectives

- Prevent local band-aids by designing the fix before editing implementation code.
- Force a skeptical second pass before implementation.
- Treat adversarial findings as hypotheses, not truth: confirm each finding is sound and real before changing the design.
- Repeat review and revision until every reported finding is false or minor.
- Keep working artifacts out of Git while keeping main docs synchronized with implemented behavior.

## Required Working Files

Create a working directory under `docs/working/` for the issue, for example `docs/working/<date>-<issue-slug>/`, holding the current design/plan and one file per adversarial review round.

Rules:

- `docs/working/` is ignored and must not be committed. Its files are temporary working documents only, not main documentation and not a substitute for updating `docs/spec/`, `docs/architecture/`, `docs/runbook/`, or `README.md`.
- Keep each revised design/plan self-contained. Do not require readers to diff prior rounds to understand the current plan.
- Keep review files factual and actionable. Do not preserve weak or speculative critiques as required work.

## Design And Plan Requirements

The first design/plan must include:

- Problem statement with evidence and affected user/runtime behavior.
- Root-cause analysis, or the best current hypothesis if the root cause is still being investigated.
- Scope and non-scope.
- Proposed design, including affected modules, data contracts, APIs, and UI/runtime surfaces as applicable.
- Alternatives considered, including at least one broader/root-cause alternative when reasonable.
- Implementation plan with ordered steps split into three explicit sections:
  - Main work tasks.
  - Cleanup tasks: obsolete/dead code, obsolete tests, stale fixtures, and superseded docs or scripts to remove or update as part of the fix.
  - Documentation-update tasks: the specific main docs to update as part of the implementation, and the changes each needs. Documentation updates are implementation work, executed alongside the code changes by the `developer`, not a separate phase. Do not count the working design/plan itself as a documentation update. Canonical main docs:
    - `docs/spec/system-specification.md` — functional behavior.
    - `docs/spec/operator-ui.md` — operator UI behavior.
    - `docs/architecture/system-architecture.md` — architecture and runtime contracts.
    - `docs/runbook/` — operator procedures, deployment, incidents, and validation.
    - `README.md` — validation profiles and documentation authority status.
- If current main docs are already stale or inconsistent with the implementation for the area being changed, document that finding and include tasks to correct those docs as part of the same change. Keep the correction scoped to the parts related to the issue/fix; do not expand into an unrelated documentation rewrite.
- Validation plan with focused checks and broader gates appropriate to the risk.
- Risks, rollback considerations, and unresolved questions.

## Adversarial Review And Revision Loop

Enter this loop, using the `designer` subagent for all plan authoring and the `reviewer` subagent for all review:

1. Have the `designer` subagent write or revise the self-contained design/plan under `docs/working/` (see Designer Subagent below). For revisions, pass the designer the material findings to address.
2. Launch the `reviewer` subagent on the current design/plan (see Reviewer Subagent below).
3. Triage every finding per Finding Triage.
4. Decide whether to run another round: if any finding was material, loop back to step 1 (have the `designer` revise the plan) for another review round; if every finding was false or minor (nothing material to fix), stop and implement.

### Designer Subagent

Use the project's `designer` subagent (`.opencode/agents/designer.md`, pinned to `zai-coding-plan/glm-5.2`) for all design/plan authoring. It applies the `AGENTS.md` rules and writes plans that satisfy the Design And Plan Requirements above.

Invoke it via the Task tool with `subagent_type: "designer"`, passing the issue/context and the absolute path of the working file to write. For revisions, also pass the material findings to address. Example:

```text
Write the Saivage v3 issue-fix design/plan for: <issue description>.
Write the self-contained plan to <absolute-path>, satisfying the
Design And Plan Requirements in this skill.
```

### Reviewer Subagent

Use the project's `reviewer` subagent (`.opencode/agents/reviewer.md`, pinned to `openai/gpt-5.5`) for adversarial review. It already applies the `AGENTS.md` rules, the review checklist, and the verdict format, so each invocation only needs to point it at the current design/plan.

Invoke it via the Task tool with `subagent_type: "reviewer"` and a prompt containing the absolute path to the current design/plan, for example:

```text
Review the Saivage v3 issue-fix design/plan at <absolute-path>.
Read it fully, verify its claims against current code and docs, and return
your findings plus your verdict.
```

Save or summarize each reviewer output in the working directory.

### Finding Triage

Do not blindly accept adversarial findings. Classify each reported finding:

- **False**: speculative, preference-only, contradicted by current project rules, or outside the agreed scope. Reject it.
- **Minor**: factually correct but too small to affect the design or plan (e.g. wording, a clarifying note, a low-impact cleanup). Note it and proceed; it does not force another review round and need not block implementation.
- **Material**: real and significant enough to change the design or plan. Revise the design/plan to address it directly.
- **Deferred**: real but should not be fixed in this issue. Record why it is deferred and whether it needs a follow-up.

### Escalation And Blockers

- Stop and ask the user if the loop reaches repeated disagreement, unclear scope, or a tradeoff that needs operator choice.
- If the subagent tooling is unavailable, report that blocker explicitly, do not claim that adversarial review passed, and proceed only when the user has directed you to continue despite the blocker, or the change is needed to repair the review workflow itself.

## Implementation

Only after the design/plan has passed the review loop, hand it to the `implementation-manager` subagent, which decomposes the plan into ordered tasks and drives them to completion via the `developer` subagent (see Implementation Manager Subagent below). The `designer` and `reviewer` subagents are for planning and review only; the primary agent does not implement directly.

### Implementation Manager Subagent

Use the project's `implementation-manager` subagent (`.opencode/agents/implementation-manager.md`, pinned to `openai/gpt-5.5`) to run an approved plan to completion. It breaks the plan into ordered tasks, delegates each to the `developer` subagent, tracks progress, runs integration validation, and is scoped to spawn only the `developer` subagent.

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
- Confirmation that adversarial review was completed, including the final verdict, or a clear blocker if subagent review could not run.
- Confirmed findings that changed the plan, if any.
- Main docs updated.
- Validation commands run and their results.
- Any residual risks or follow-ups.

Do not commit `docs/working/` artifacts. Commit only source, tests, main docs, and configuration changes that belong in Git.
