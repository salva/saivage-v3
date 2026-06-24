---
name: saivage-v3-mailbox-submit
description: 'Submit ideas, bug reports, or full design proposals to the Saivage v3 proposal mailbox so the v2-on-v3 harness picks them up. Use when the operator asks to "drop an idea / issue / design / proposal into saivage-v3", "give v2-on-v3 work to do", "queue a fix for saivage-v3", or to file an architecture proposal for the continuous-improvement loop.'
---

# Saivage v3 Mailbox Submission

## Purpose

The dedicated v2-on-v3 harness (`saivage.service` in the `saivage-v3` LXC container) treats `/home/salva/g/ml/saivage-v3/proposals-for-review/` as a **work mailbox**. Whenever any `.md` file appears there (outside `README.md`, `done/`, `rejected/`), the harness preempts its continuous-improvement wave loop, picks the lexicographically first proposal, runs a single self-contained cycle on it, then archives the file. Use this skill to file work into that mailbox correctly.

## Where the mailbox lives

- Host path: `/home/salva/g/ml/saivage-v3/proposals-for-review/`
- Container path (the harness sees this): `/work/saivage-v3/proposals-for-review/`
- Subdirectories (managed by the harness, do not write into them manually except for forensic recovery):
  - `done/<YYYY-MM-DD>-<basename>` — proposals successfully implemented
  - `rejected/<YYYY-MM-DD>-<basename>` + sibling `<basename>.decision.md` — proposals the harness declined
- Ignored by scanner: `README.md`, hidden files, anything under `done/` or `rejected/`

The active objectives that bind this behavior live in `saivage-v3/.saivage/config.json` under the "Mailbox" objective clause. Do not edit that clause when filing a proposal; just drop the file in.

## Filename convention

Use a short, kebab-case slug ending in `.md`. The harness consumes in lexicographic order, so prefix with a sortable date when ordering matters:

```
YYYY-MM-DD-<short-slug>.md
```

Examples:
- `2026-05-27-add-mcp-server-health-card.md`
- `2026-06-01-fix-analyst-chat-stream-truncation.md`
- `2026-06-03-design-permissions-by-state-matrix.md`

If the proposal is urgent and should be picked up before other queued items, prefix with `00-` (e.g. `00-urgent-fix-runtime-lockfile-leak.md`). Do not abuse this.

## Three submission kinds

The skill supports three intents. Pick the template that matches what the operator asked for.

### 1. Idea (loose, harness must scope it itself)

Use when the operator gives a rough direction and expects the harness to flesh it out via the dual-proposal review loop.

```markdown
# Idea: <one-line title>

## Intent
<2–5 sentences. What outcome does the operator want? Why is the current state unsatisfying?>

## Scope hints (optional)
- Likely touches: `<paths>`
- Out of scope: `<paths or behaviors the operator does NOT want changed>`

## Success signal
<How the operator will know it's done. Be observable: a UI behavior, a test that should pass, a metric, a deleted code path.>

## Notes
<Free-form context, links to related code, prior discussion. Cite `path:line` where possible.>
```

The harness will treat this as **open-ended** and run the bounded dual-proposal review convergence before implementing.

### 2. Issue / bug report (concrete, narrow fix)

Use when the operator has identified a specific defect and wants it fixed directly.

```markdown
# Issue: <one-line title>

## Symptom
<What goes wrong. Include the exact error message, screenshot path, or reproduction steps.>

## Reproduction
1. <step>
2. <step>
3. <observed result>
4. <expected result>

## Suspected cause (optional)
<File:line citations and a short hypothesis. Leave empty if you don't know.>

## Acceptance criteria
- <Bullet 1: observable behavior that must hold after the fix.>
- <Bullet 2: regression test or e2e check that must pass.>

## Out of scope
<Adjacent code the harness must NOT refactor while fixing this.>
```

The harness treats this as **concrete** and may skip the dual-proposal step, going straight to implementation + validation.

### 3. Full design proposal (the operator already did the design work)

Use when the operator already wrote a converged design and just wants the harness to implement it.

```markdown
# Design: <one-line title>

## Problem
<Why this design exists. The behavior or architectural concern it addresses.>

## Decision
<The chosen design, stated as a contract. Include data shapes, API surfaces, file layout, lifecycle.>

## Files to change
- `<path>` — <what changes>
- `<path>` — <what changes>

## Files / tests / docs to DELETE
- `<path>` — <why obsolete>

## Validation gate
- `<commands the harness must run>`
- `<Playwright scenarios that must pass>`

## Risks / accepted residuals
<Known trade-offs the operator has already accepted. The harness must not re-litigate these.>

## Out of scope
<Adjacent concerns explicitly deferred to future proposals.>
```

The harness treats this as **converged** — it implements exactly what the design says, with at most a delta-proposal mini-cycle for unavoidable deviations.

## How the harness classifies and branches

When a mailbox file is picked up, the harness first runs a **classification step** that decides whether the proposal includes a converged design:

- **Design-included** — the file uses the `# Design:` template above OR cites converged design documents under `SPEC/` (typical pattern: `02-design-rN.md` + `03-plan-rN.md`) and binds the harness to them.
- **Design-not-included** — idea or bug-report shape (no `Decision` / `Files to change` / `Validation gate` sections, no `SPEC/.../02-design*.md` references).

The two branches behave very differently:

| Aspect | Design-not-included | Design-included |
|---|---|---|
| Dual-proposal review | Runs (`proposal-direct.md` + `proposal-restructure.md`) | **Forbidden** — design IS the contract |
| Scope variation | Harness may converge on a restructured scope | **Forbidden** — no descoping, no "safer subset" |
| Mapping artifact | `decision.md` + `implementation-log.md` | Adds `classification.md` + `stage-plan.md` with a deliverable→stage coverage table |
| On precondition conflict | Adjust proposal via review round | **Stop and report** — file delta-proposal mini-cycle OR reject with `.decision.md` naming the lost deliverables |
| On partial completion | Not allowed; full or rejected | Not allowed; full or rejected; never archive to `done/` if any deliverable was dropped |

The **nothing-lost invariant** for design-included proposals: the union of executed stages must exactly equal the design's deliverable set (every file listed, every deletion, every validation gate). If the harness believes a part is unsafe or has been preempted by prior work in a different shape, it must report-and-stop, not silently substitute.

This protocol is binding in `saivage-v3/.saivage/config.json` under the "Mailbox" objective clause.

## Choosing the template for an operator request

- If the operator says "have v2-on-v3 figure out X" or "drop an idea" → **Idea** template (Branch A).
- If the operator describes a concrete bug → **Issue** template (Branch A; harness may skip dual-proposal step but still owns the fix shape).
- If the operator already converged on a design (especially when SPEC docs exist under `SPEC/<wave>/<feature>/02-design-rN.md` + `03-plan-rN.md`) → **Full design proposal** template (Branch B). Cite those docs explicitly; the harness will stage-map them and refuse to descope.

When in doubt, ask the operator whether they want the harness to redesign or just to implement.

## Workflow when filing

1. Confirm the file name and intent with the operator if either is ambiguous.
2. Write the file directly under `saivage-v3/proposals-for-review/` (host path). Do NOT write into `done/` or `rejected/`.
3. Do not edit `proposals-for-review/README.md`.
4. Do not commit on the operator's behalf unless they explicitly ask. The harness operates on the worktree; the operator decides when to commit.
5. After dropping the file, tell the operator the file path and that the harness will pick it up at the next cycle boundary (it polls between cycles; do not restart `saivage.service` to force this).
6. Include secret material in the proposal file only when the operator explicitly asks for that content to be part of the proposal; otherwise reference secret-bearing files by path.

## Forbidden in proposals

- LXC/container/service control instructions (the harness must not touch `saivage.service`, `saivage-v3-checkers.service`, or the container). File those as operator tasks instead.
- Provider/model routing changes (those belong in `.saivage/saivage.json`, not as a proposal).
- Branch switches, rebases, or force-pushes.
- Changes to immutable historical paths: `SPEC/analyst-as-control-surface/` and prior `architecture-audit/cycle-*` artifacts.
- Editing other entries in the mailbox or moving them out of order.

## What the harness will do with a submitted file

1. List `proposals-for-review/` at the start of its cycle, pick the lex-first eligible `.md`.
2. Open a mailbox cycle directory: `architecture-audit/mailbox-<NNN>-<short-slug>/`.
3. **Classify** the proposal (design-included vs design-not-included) and record `classification.md`.
4. Scope-check the proposal against current code.
5. **Branch A (design-not-included)**: write `proposal-direct.md` + `proposal-restructure.md`, run a bounded review round, converge a decision.
6. **Branch B (design-included)**: write `stage-plan.md` with a deliverable→stage coverage table; refuse to start implementation if any deliverable is uncovered (file a delta-proposal or reject instead).
7. Implement, running the full validation cadence after each stage (lint, typecheck, focused + full vitest/jest, build, `docs:verify`, Playwright smoke, and live Playwright MCP run against `http://127.0.0.1:8090`).
8. `git mv` the file to `done/<YYYY-MM-DD>-<basename>` on success (full coverage; no dropped deliverables for Branch B), or to `rejected/<YYYY-MM-DD>-<basename>` with a sibling `<basename>.decision.md` on rejection or when stage-mapping cannot honour the nothing-lost invariant.
9. Re-check the mailbox before resuming wave work.

If the operator wants to retract a proposal that has not yet been picked up, just `git rm` it (or move it out of the directory). If it is already mid-cycle, ask the operator before interfering — interrupting a cycle mid-implementation is not safe.

## Related skills

- [saivage-v2-on-v3-control](../saivage-v2-on-v3-control/SKILL.md) — operating the v2 harness service itself
- [saivage-development-validation](../saivage-development-validation/SKILL.md) — running the validation cadence locally before filing
- [saivage-lxc-operations](../saivage-lxc-operations/SKILL.md) — container-level checks if the harness appears stuck
