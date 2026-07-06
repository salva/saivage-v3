---
name: saivage-issue-fix-adversarial-review
description: 'Mandatory Saivage v3 issue-fixing workflow. Use when fixing bugs, regressions, review findings, design flaws, architectural issues, or behavior gaps: create a docs/working design+plan, run adversarial subagent review, critically validate findings, iterate until no confirmed issues remain, then implement and update main docs.'
---

# Saivage Issue Fix Adversarial Review

Use this workflow before fixing any concrete issue in Saivage v3, including bugs, regressions, review findings, architectural flaws, behavior gaps, failed validation findings, and operator-reported problems. Also use it when creating or changing operational workflow rules or skills that govern how issues are fixed.

This skill is mandatory for issue fixes and issue-fixing workflow changes. It is not required for trivial non-issue edits such as typo fixes or formatting-only changes unless the user frames the work as fixing an issue or changing the required issue-fix workflow.

When the change creates or revises a skill, also follow `opencode-skill-authoring` for OpenCode skill layout, frontmatter, descriptions, and validation.

## Objectives

- Prevent local band-aids by designing the fix before editing implementation code.
- Force a skeptical second pass before implementation.
- Treat adversarial findings as hypotheses, not truth: confirm each finding is sound and real before changing the design.
- Repeat review and revision until there are no confirmed design/plan issues left.
- Keep working artifacts out of Git while keeping main docs synchronized with implemented behavior.

## Required Working Files

Create a working directory under `docs/working/`, for example:

```text
docs/working/<date>-<issue-slug>/
  01-design-plan.md
  02-adversarial-review-r1.md
  03-design-plan-r2.md
  04-adversarial-review-r2.md
  ...
```

Rules:

- `docs/working/` is ignored and must not be committed.
- Keep each revised design/plan self-contained. Do not require readers to diff prior rounds to understand the current plan.
- Keep review files factual and actionable. Do not preserve weak or speculative critiques as required work.

## Design And Plan Requirements

The first design/plan must include:

- Problem statement with evidence and affected user/runtime behavior.
- Root-cause analysis or the best current hypothesis if the root cause is still being investigated.
- Scope and non-scope.
- Proposed design, including affected modules, data contracts, APIs, and UI/runtime surfaces as applicable.
- Alternatives considered, including at least one broader/root-cause alternative when reasonable.
- Implementation plan with ordered steps split into three explicit sections: main work tasks, cleanup tasks, and documentation-update tasks.
- Cleanup tasks must identify obsolete/dead code, obsolete tests, stale fixtures, and superseded docs or scripts that should be removed or updated as part of the fix.
- Documentation-update tasks must name the main docs to update and describe the behavior, architecture, runbook, or validation changes each doc needs.
- Validation plan with focused checks and broader gates appropriate to the risk.
- Main documentation updates required by the work, naming the expected files under `docs/spec/`, `docs/architecture/`, `docs/runbook/`, or `README.md`.
- Risks, rollback considerations, and unresolved questions.

## Adversarial Review

After writing the design/plan, use a subagent to review it adversarially before implementation.

Subagent prompt requirements:

- Include the absolute path to the current design/plan.
- Include the relevant project rules from `AGENTS.md`, especially clean architecture, no backward compatibility, no bridge/shim/migration code, no over-engineering, and documentation sync requirements.
- Ask the subagent to look for correctness gaps, hidden assumptions, missed root causes, over-local fixes, contract mismatches, missing docs updates, missing validation, unnecessary compatibility code, dead-code preservation, and excessive complexity.
- Require findings to be sound, actionable, and tied to concrete evidence or reasoning.
- Ask for a verdict: `NO_CONFIRMED_ISSUES` or `ISSUES_FOUND`.

Example prompt shape:

```text
Review this Saivage v3 issue-fix design/plan adversarially: <absolute-path>.

Do not edit files. Check it against AGENTS.md and current docs/code as needed.
Find only sound, actionable issues. For each finding, include severity, evidence,
why it is real, and the required design/plan change. End with exactly one verdict:
NO_CONFIRMED_ISSUES or ISSUES_FOUND.
```

Save or summarize the subagent review in the working directory.

## Finding Triage

Do not blindly accept adversarial findings. For each finding:

- Confirm whether it is factually correct and relevant to the issue being fixed.
- Reject findings that are speculative, preference-only, contradicted by current project rules, or outside the agreed scope.
- If the finding is real, revise the design/plan to address it directly.
- If the finding is real but should not be fixed in this issue, record why it is deferred and whether it needs a follow-up.

## Review Loop

Repeat this loop until no confirmed issues remain:

1. Write or revise the current self-contained design/plan under `docs/working/`.
2. Launch a subagent adversarial review of the current design/plan.
3. Critically triage every finding.
4. Fix confirmed issues in the design/plan.
5. Repeat with a new review round.

Stop conditions:

- Stop and implement when the latest adversarial review has no confirmed issues.
- Stop and ask the user if the loop reaches repeated disagreement, unclear scope, or a tradeoff that needs operator choice.
- If the subagent tooling is unavailable, report that blocker explicitly, do not claim that adversarial review passed, and proceed only when the user has directed you to continue despite the blocker or the change is needed to repair the review workflow itself.

## Implementation

Only after the design/plan has passed the review loop:

- Implement the chosen plan directly. Avoid compatibility shims, legacy bridges, migrations, or dual paths unless the user explicitly requires them.
- Update all producers, consumers, tests, docs, and deployment assumptions affected by a contract change.
- Remove dead code made obsolete by the fix.
- Keep changes scoped to the issue and the approved plan unless implementation reveals a real root-cause correction that requires updating the plan.

If implementation reveals a material design change, update the working plan and run another adversarial review before continuing.

## Main Documentation Sync

After implementation changes behavior, update the main docs named in the plan:

- `docs/spec/system-specification.md` for functional behavior.
- `docs/spec/operator-ui.md` for operator UI behavior.
- `docs/architecture/system-architecture.md` for architecture and runtime contracts.
- `docs/runbook/` for operator procedures, deployment, incidents, and validation.
- `README.md` for validation profiles and documentation authority status.

Do not commit `docs/working/` artifacts. Commit only source, tests, main docs, and configuration changes that belong in Git.

## Validation And Reporting

Run validation appropriate to the change, using `saivage-development-validation` when the change touches TypeScript runtime code, Vue UI, API contracts, docs, or deployment behavior.

Final report should include:

- The issue fixed and the core design choice.
- Confirmation that adversarial review was completed, including the final verdict, or a clear blocker if subagent review could not run.
- Confirmed findings that changed the plan, if any.
- Main docs updated.
- Validation commands run and their results.
- Any residual risks or follow-ups.
