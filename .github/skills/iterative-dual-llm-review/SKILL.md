---
name: iterative-dual-llm-review
description: 'Systematic codebase review with per-issue dual-LLM (writer/reviewer) iteration to produce vetted functional analyses, designs, and implementation plans, followed by a prioritized metaplan. Use when the user asks for an extensive/systematic code review with proposals, alternative designs, reviewer-vetted plans, and a sequenced execution plan across an entire repo or subsystem.'
---

# Iterative Dual-LLM Review

A repeatable workflow for "review subsystem X, propose fixes, vet the proposals with a second model, then sequence the work into a metaplan." It is intentionally heavyweight -- only use it when the user explicitly asks for a systematic / extensive review with proposals and a plan, not for ad-hoc fixes.

## Phases

### Phase 0 -- Preconditions

1. Confirm with the user:
   - **Scope**: which directories/subsystems are in scope; what is explicitly excluded (e.g. another agent's active work).
   - **Output location**: a single dedicated directory, e.g. `<repo>/SPEC/<version>/review-<YYYY-MM>/`.
   - **Writer model** and **reviewer model** (e.g. `Claude Opus 4.7 (copilot)` writer, `GPT-5 (copilot)` reviewer). If the requested model name is not available, ask the user for a fallback rather than silently substituting.
   - **Iteration cap** per document (or "unlimited until reviewer approves" with an escape hatch to the user).
   - **Pause points** (recommended defaults below).
   - **Concurrency**: warn the user if another agent is working on the same repo. Get explicit go-ahead before any code-fix implementation phase.
2. Verify repo hygiene per the user's prerequisites (clean tree, on the right branch, pushed, merged). Do not silently merge shared branches -- confirm first.
3. Create a todo list covering all phases (A-G below) and keep it current.

### Phase A -- Git prep

Commit / push / merge / checkout exactly as the user specified. Never bypass safety (no `--force`, no `--no-verify`). Snapshot commit messages should make the intent ("snapshot before systematic review") explicit.

### Phase B -- Write/refresh this skill if missing

Skip if the skill already exists at the expected project path.

### Phase C -- Subsystem map + issue inventory

1. Produce a **subsystem map** (`00-SUBSYSTEM-MAP.md`) listing every layer/component in scope and the relations between them. Keep it concise -- purpose, key files, public surface, dependencies.
2. Produce an **issue inventory** as **one file per issue** under the output directory, named `FNN-<slug>.md` (e.g. `F03-runtime-state-races.md`). Numbering is stable; do not renumber later.
   - Each file: one-paragraph summary, evidence (file paths + line refs as markdown links), category (inconsistency / bad design / dead code / over-featurism / half-implemented / short-sighted / etc.), rough severity, rough transversality (local / cross-cutting / architectural).
3. Write an `00-INDEX.md` listing all issues with severity/transversality columns.
4. Pause point (b): show the user the inventory before launching the expensive per-issue loop, unless they opted out.

Rules:
- One issue per file. If two things are entangled, note the cross-link in both files.
- Exclude scope explicitly listed in Phase 0; do not silently expand scope.
- Do not include findings about the reviewer's own model or about workflow tooling unless they directly affect the code under review.

### Phase D -- Per-issue dual-LLM loop

For each issue file `FNN-<slug>.md`, produce a directory `FNN-<slug>/` containing iteratively-refined documents:

```
FNN-<slug>/
  00-issue.md                  # copy/link of the inventory entry
  01-analysis-r1.md            # writer: functional analysis
  01-analysis-review-r1.md     # reviewer: critique against project guidelines
  01-analysis-r2.md            # writer: revised analysis (if needed)
  ...
  02-design-r1.md              # writer: 1+ design proposals (focused fix AND
                               #   1 "one conceptual level up" alternative)
  02-design-review-r1.md       # reviewer: critique
  ...
  03-plan-r1.md                # writer: implementation plan for each design
  03-plan-review-r1.md         # reviewer: critique
  ...
  APPROVED.md                  # reviewer's final OK + chosen proposal pointer
```

#### Writer subagent prompt template

Use `runSubagent` with the configured writer model. Prompt must contain:
- Absolute paths to: the issue file, the subsystem map, the project's "clean code / architecture" guidelines (e.g. `AGENTS.md` rule "No backward compatibility"), and any prior round's reviewer critique.
- Explicit instruction: produce **at least two proposals** -- a focused fix AND a "one conceptual level up" alternative that may refactor adjacent code.
- Instruction to honor project guidelines: no backward-compat shims, no migration code, remove dead code aggressively, no over-engineering.
- Output file path the subagent must write to.
- Return contract: a 5-line summary + the absolute path of the file written.

#### Reviewer subagent prompt template

Use `runSubagent` with the configured reviewer model. Prompt must contain:
- Absolute paths to: the document under review, the subsystem map, the issue file, and the project guidelines.
- Explicit critique axes: clean code, clean architecture, no backward compatibility (per project rule), no over-engineering, no dead-code preservation, correctness, completeness, testability, transversal impact correctly identified, alternative proposals considered.
- Output file path. The reviewer MUST end the file with exactly one line:
  - `VERDICT: APPROVED` -- no further changes required.
  - `VERDICT: CHANGES_REQUESTED` -- followed by a numbered list of required changes.
- Return contract: the verdict line and the absolute path of the file written.

#### Loop control

```
round = 1
while round <= cap:
    write_doc(round)
    review_doc(round)
    if verdict == APPROVED:
        write APPROVED.md
        break
    round += 1
if not approved:
    escalate to user with the last review file
```

For "unlimited until reviewer approves", still bail out and escalate to the user if two consecutive rounds produce the same set of reviewer objections -- that is a sign the writer and reviewer disagree fundamentally and need human arbitration.

#### Parallelism

Issues are largely independent -- once Phase C is done, multiple per-issue loops may run in parallel via independent `runSubagent` calls. Cap parallel subagents at 3-4 to avoid rate limits and to keep terminal/tool state coherent. Sequence issues that share files.

### Phase E -- Selection, ordering, metaplan

1. For each issue, pick the best proposal (usually the one the reviewer approved with the strongest endorsement; prefer the "one conceptual level up" option if it subsumes the focused fix without ballooning scope).
2. Score each chosen proposal on two axes:
   - **Importance** (1-5): impact on correctness, security, maintainability, user-facing behavior.
   - **Transversality** (1-5): how many subsystems / files / contracts it touches.
3. Order the work so that **transversal foundational changes go first** (renames, type/contract refactors, dead-code removal), then localized high-importance fixes, then lower-priority cleanups. Group items that touch the same files into the same batch.
4. Write `99-METAPLAN.md` containing:
   - Ordered list of work items with cross-links to their approved proposals.
   - Batching / dependency graph.
   - For each batch: validation strategy (typecheck / test commands / live probes).
   - Rollback plan per batch.

### Phase F -- Pause for explicit go-ahead

This phase always exists, even if the user opted into "run end-to-end". The user is the only one who can confirm: (a) the other agent is done / paused, (b) the metaplan is the right plan, (c) implementation may start.

### Phase G -- Execute the metaplan

For each batch, spawn a writer-model subagent with a tight prompt: scope = files in the batch, must use repo-standard validation commands, must commit per batch with a message referencing the issue id (`F03: ...`). After each batch, run the project's validation skill (e.g. `saivage-development-validation`) and report results before starting the next batch.

## Defaults & conventions

- **Output dir**: `<repo>/SPEC/<version>/review-<YYYY-MM>/`.
- **Naming**: issues are `F01`, `F02`, ... (stable). Per-issue directory uses the same id.
- **No emojis** in any generated document.
- **No backward-compat suggestions** in any proposal (project-wide rule).
- **No new docstrings/comments** in untouched code (per `implementationDiscipline`).
- All file references inside generated docs MUST be relative to the repo root and clickable (markdown links with `path/to/file.ts#Lnn`).
- Subagent prompts must include absolute paths -- subagents have no shared context.
- **Autonomous documents**. Each new revision the writer produces (`01-analysis-rN.md`, `02-design-rN.md`, `03-plan-rN.md`) MUST be fully self-contained: a reader who has never seen the prior rounds or the reviewer critiques must understand and implement it without flipping to other documents in the dance. Concretely:
  - No back-references to prior revisions of the same document ("as in r2", "see r1 §3", "addresses finding F1 from round 2", revision-numbered titles like "Analysis r2", etc.).
  - No references to the review process itself ("the reviewer requested...", "reviewer must verify...", "per the APPROVED marker", "CHANGES_REQUESTED in round 1"). Replace "reviewer" with "implementer" / "operator" when the original meaning was code-review/verification, not the dance.
  - References to APPROVED-marker files (`ANALYSIS-APPROVED.md`, etc.) and to sibling rN documents in the same dance are forbidden in the body.
  - References to currently-shipped code (including a prior, separate, already-merged change in a different folder) ARE allowed -- those are factual code references, not previous versions of this document.
  - If the writer wants to record meta-commentary on the review (e.g. "I am not addressing reviewer finding F2 because it conflicts with constraint C3"), it goes in a sibling companion file named `<doc>.rN-companion.md` (e.g. `02-design.r3-companion.md`). Companion files are read by the orchestrator and the reviewer, never by the implementer.

## Anti-patterns to avoid

- Letting the writer model also review its own work -- defeats the point.
- Renumbering issues mid-review -- breaks cross-references.
- Producing only one design proposal per issue -- the user asked for alternatives, including a level-up.
- Skipping the metaplan and jumping to fixes.
- Silently expanding scope into excluded areas (e.g. another agent's territory).
- Using `cat >` / `sed` to write generated docs from the orchestrator -- use create/edit tools so VS Code buffers stay coherent.
- Running implementation subagents in parallel on overlapping files -- schedule them sequentially per file.
- Writing a revision that references earlier revisions or the review back-and-forth ("as r2 said", "to address finding F1", "per APPROVED.md"). Each `rN` document must stand alone; put meta-commentary in `<doc>.rN-companion.md`.
