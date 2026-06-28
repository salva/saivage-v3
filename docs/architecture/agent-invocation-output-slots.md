# Mandatory Output Files

Status: design proposal.

## Problem

The current runtime accumulated soft evidence mechanisms that give the illusion of control without enforcing anything:

- Executors *may* return `artifacts` and `attachments` in their terminal envelope.
- `registerEvidenceRefsBestEffort` copies files and registers refs but swallows errors.
- Write territories check paths but always return `allowed: true` with an advisory warning.
- `generated_files` is tracked but never enforced.
- `validateReviewerAssessment` checks `card.artifacts.length > 0 || card.attachments.length > 0 || card.lifecycle.result` — a soft gate that rejects reviewer `pass` when no structured refs exist, even if the work is done and evidence files are on disk.

These mechanisms failed closed on card-1: the reviewer emitted `pass`, the evidence gate rejected it, but nothing forced anyone to close the loop. The runtime kept blocking with the same stale reason across five reviewer attempts.

## Design Principle

Replace soft mechanisms with hard contracts.

1. The runtime declares mandatory output file paths in the prompt before invoking an agent.
2. The agent writes those files.
3. The runtime hard-validates their existence after the terminal tool call.
4. Missing files trigger same-agent repair, not escalation to another role.
5. Output paths are versioned so all history remains available.
6. Agents write normal work files directly into the project directory — no special registration, no artifact refs, no copy step.

No best-effort. No advisory warnings. No optional evidence. No soft gates.

## What Gets Removed

| Mechanism | Reason |
|---|---|
| `ArtifactRef` / `AttachmentRef` types and card fields | Replaced by output files at declared paths. |
| `appendEvidenceRefs` / `registerEvidenceRefs` / `registerEvidenceRefsBestEffort` | No artifact/attachment registration. |
| `artifacts` / `attachments` / `generated_files` in executor terminal envelope | Replaced by mandatory output file checks. |
| `validateReviewerAssessment`'s `artifacts.length > 0 \|\| attachments.length > 0 \|\| lifecycle.result` check | Replaced by: do mandatory output files exist, and do cited descendant cards have their own mandatory outputs. |
| Write-territory advisory warnings that always return `allowed: true` | Replaced by hard scheme-based enforcement in the file tools. |
| Path-pattern-based write territories | Replaced by `output://` vs `project://` scheme enforcement. |

## What Stays

| Mechanism | Reason |
|---|---|
| Cards, card tree, lifecycle, status | Core. |
| Agent sessions and transcripts | Core observability. |
| Process actors | Core execution. |
| Terminal tools (`emit_*_result`) | Role contracts. |
| Notifications | Coordination. |
| Card field-level history | Already works. |

## Versioned Output Paths

Every mandatory output file lives under a versioned directory on the card:

```text
.saivage-work/cards/{cardId}/generated-files/{N}/{filename}
```

Where `{N}` is a monotonically increasing counter per card. The counter increments each time the runtime declares a new output file for a new invocation. All prior versions remain on disk.

Example:

```text
.saivage-work/cards/card-1/generated-files/
  1/
    review.md
  2/
    review.md
  3/
    review.md
    planner-summary.md
```

Version 1 and 2 reviews remain available even after the version 3 review replaces them as the current one. The runtime, UI, and reviewer can read prior versions for comparison.

The counter is card-scoped, not invocation-scoped, because a card may have multiple invocations across its lifecycle (planner, reviewer, executor) and each contributes files. The counter is persisted alongside card state so it survives restarts.

## File Path Schemes

File tools accept a URL-like scheme prefix that tells the runtime where the file lives and enforces the write boundary.

| Scheme | Format | Resolves to |
|---|---|---|
| `output://` | `output://{cardId}/{version}/{filename}` | `.saivage-work/cards/{cardId}/generated-files/{version}/{filename}` |
| `project://` | `project://{relative}` or absolute path | `{projectRoot}/{relative}` |

Examples:
- `output://card-1/23/review.md` → `.saivage-work/cards/card-1/generated-files/23/review.md`
- `output://card-34/7/planner-result.md` → `.saivage-work/cards/card-34/generated-files/7/planner-result.md`
- `project://src/foo.ts` → `{projectRoot}/src/foo.ts`
- `/home/salva/g/ml/getrich-v2/README.md` → absolute, same as `project://`

The `output://` URL is fully-qualified: it contains the card ID, the version number, and the filename. Any agent can read any output file by URL, regardless of which card or invocation produced it. This makes output references passable between agents — the reviewer can cite `output://card-7/3/executor-result.md` in its review, and the planner can read `output://card-1/23/review.md` to see why the reviewer rejected its work.

There is no implicit or context-relative `output://` resolution. The prompt always passes the full URL. This avoids ambiguity when an agent needs to reference another card's output.

### Write enforcement

Write enforcement is three-dimensional, checking all components of the URL:

| Rule | Check |
|---|---|
| Card matches current invocation's card | `url.cardId == allocatedCardId` |
| Version matches current invocation's allocated version | `url.version == allocatedVersion` |
| Filename matches role's designated output | `url.filename == roleAllowedFilename` |

| Role | Allowed output filename | `project://` write | `output://` read | `project://` read |
|---|---|---|---|---|
| Planner | `planner-result.md` | yes | any card, any version | yes |
| Executor | `executor-result.md` | yes | any card, any version | yes |
| Reviewer | `review.md` | no | any card, any version | yes |

The planner physically cannot overwrite `output://card-1/23/review.md` because:
1. Version 23 was allocated to the reviewer's invocation, not the planner's.
2. `review.md` is not the planner's designated filename.

The reviewer cannot write `project://` paths at all. These are hard checks enforced in the file tools, not advisory warnings.

### Role designated filenames

Each role has exactly one designated output filename:

| Role | Filename |
|---|---|
| Planner | `planner-result.md` |
| Executor | `executor-result.md` |
| Reviewer | `review.md` |

An agent can only write its role's designated filename to its own allocated version. It can read any file from any version of any card.

## How It Works

### Before invocation

The runtime allocates the next version number for the card, creates the directory, and passes the full `output://` URL in the prompt.

```text
You must write your review to:
output://card-1/23/review.md

Do not call emit_reviewer_result until that file exists.
```

The agent receives:
- The full `output://` URL for mandatory files.
- The instruction to create the file before calling the terminal tool.

The URL is fully-qualified and stable. The agent copies it into file tools. The runtime resolves it to the filesystem path.

### After terminal tool call

The runtime checks whether each mandatory file exists at the resolved path and is non-empty.

- **All files present:** accept the terminal result.
- **Files missing:** reject, re-enter the same agent session with a continuation message naming the missing `output://` URLs, increment nothing.
- **Repair budget exhausted:** fail the activation with a clear runtime diagnostic.

### What the agent uses to write files

The agent uses normal file-writing tools (`write`, `edit`, `apply_patch`) with the `output://` scheme to create the mandatory file. There is no special `register_evidence` tool. The file existing at the resolved path is the evidence.

For project work files (code, tests, docs), the agent uses `project://` or absolute paths with the same tools.

### Cross-agent references

When the reviewer returns `needs_corrections`, the runtime passes the review URL to the planner:

```text
Reviewer rejected at output://card-1/23/review.md. Read it for corrections.
```

The planner reads `output://card-1/23/review.md` — a fully-qualified URL it can resolve regardless of its own card or version. No agent needs to construct or guess paths.

When the reviewer is invoked, its context message includes descendant output URLs:

```text
Descendant work:
- card-7 (executor, done): output://card-7/3/executor-result.md
- card-8 (executor, done): output://card-8/1/executor-result.md
```

The reviewer reads those URLs to verify the work before citing the descendant cards.

## Role-Specific Mandatory Outputs

### Reviewer

| File | Required | Purpose |
|---|---|---|
| `review.md` | yes | Human-readable assessment. |

The reviewer prompt says:

```text
Write your review to:
output://card-1/23/review.md

Create the file, then call emit_reviewer_result.
```

After `emit_reviewer_result`, the runtime checks `output://card-1/23/review.md` exists. If not, the same reviewer session gets:

```text
Required output file output://card-1/23/review.md was not created. Create it, then call emit_reviewer_result again.
```

### Planner

| File | Required When | Purpose |
|---|---|---|
| `planner-result.md` | Always | Planning summary for the diary. |

The planner prompt says:

```text
Write your planning summary to:
output://card-1/24/planner-result.md

Create the file, then call emit_planner_result.
```

### Executor

| File | Required When | Purpose |
|---|---|---|
| `executor-result.md` | Always | Work summary and evidence of what was done. |

The executor prompt says:

```text
Write your work summary to:
output://card-42/5/executor-result.md

Create the file, then call emit_executor_result.
```

Executors continue writing code, tests, and other work files directly into the project directory. The mandatory output file is the summary, not the full work product.

## Reviewer Evidence Gate

The current `validateReviewerAssessment` checks whether cited evidence cards have `artifacts.length > 0 || attachments.length > 0 || lifecycle.result`. That check is removed.

The new gate is:

1. Does the reviewer's own mandatory `review.md` exist? (Checked before this point; if not, same-agent repair.)
2. Did the reviewer cite at least one descendant card in `evidence_card_ids`?
3. For each cited descendant card, does that card have at least one mandatory output file in its `generated-files/` directory?

If a cited descendant has no mandatory outputs, the reviewer should emit `needs_corrections`, not `pass`. If the reviewer emits `pass` citing a card with no outputs, the gate rejects with `needs_corrections` routed to the planner — that is a real missing-work problem, not a reviewer-output problem.

If the reviewer emits `pass` citing cards that all have mandatory outputs, the gate passes. No `ArtifactRef`, no `appendEvidenceRefs`, no artifact-length check.

## Reviewer Context

The reviewer currently receives only the goal card's title, description, and acceptance — no descendant information. That is the root cause of card-1's blockage: the reviewer had no descendant evidence to cite, so it cited the goal card itself, which had no artifacts.

The reviewer must receive descendant summaries as context messages before invocation. For each descendant of the goal card:

- `id`, `type`, `title`, `status`
- `lifecycle.result.kind` (executor_success, planner_done, planner_blocked, etc.)
- `lifecycle.result.summary` or `lifecycle.result.error`
- The descendant's output URLs (e.g., `output://card-7/3/executor-result.md`) so the reviewer can `read` them

This lets the reviewer cite descendant cards that have real work products and read those products if needed. The reviewer reads descendant files by their `output://` URL; it writes its own review to its allocated `output://` URL.

This was already designed in `agent-tool-surfaces-and-information-flow.md` (section "Reviewer context — special case") but never implemented. The mandatory-output design depends on it being implemented now.

## File Tools For Reviewer And Planner

The reviewer and planner currently have no file-writing tools. All agents share the same file tools (`read`, `write`, `edit`, `apply_patch`, `glob`, `grep`), but path resolution and write enforcement are scheme-based and fully-qualified.

### Path resolution

| Scheme | Format | Resolves to |
|---|---|---|
| `output://{cardId}/{version}/{filename}` | Fully-qualified card output URL | `.saivage-work/cards/{cardId}/generated-files/{version}/{filename}` |
| `project://{relative}` | Project-relative path | `{projectRoot}/{relative}` |
| Absolute path `/...` | Same filesystem path | Same filesystem path |

The `output://` URL is fully-qualified. The runtime resolves it before the file tool touches the filesystem. Any agent can read any `output://` URL. Write is restricted to the current invocation's allocated `(cardId, version, filename)`.

### Write enforcement

The file tool checks all three components of an `output://` write:

1. `cardId` must match the current invocation's card.
2. `version` must match the current invocation's allocated version.
3. `filename` must match the role's designated filename.

The reviewer can only write `output://{itsCard}/{itsVersion}/review.md`. Any other `output://` write or any `project://` write is hard-rejected. The planner and executor can write their designated output file and any `project://` path.

This replaces the current advisory write-territory system with hard scheme-based enforcement in the file tools. No advisory warnings, no path-pattern territories.

## Validation And Repair Flow

```text
runtime allocates version N for card C
runtime creates .saivage-work/cards/C/generated-files/N/
runtime invokes agent with mandatory output://C/N/{filename} URL(s) in prompt
agent writes mandatory file(s) using file tools with output:// scheme
agent calls terminal tool (emit_*_result)
runtime checks mandatory file(s) exist at output://C/N/{filename} and are non-empty
  if missing:
    append continuation message to same LLM session:
      "Required file output://C/N/{filename} was not created. Create it and call {terminal_tool} again."
    re-enter same agent (not a new session)
    if repair budget exhausted:
      fail activation with runtime diagnostic
  if present:
    accept terminal result
    proceed with role-specific evaluation (evidence gate, completion gates, etc.)
```

The repair uses the existing `LLMToolContinuationContextHook` seam — the same mechanism that injects notification context between tool result and next LLM turn. No new "repair event" framework.

Repair budget: 2 attempts by default. Configurable per card via card metadata if needed later.

## Persistence

The versioned output files ARE the persistent evidence. No separate `invocation.json` manifest, no slot metadata database, no registration records.

The version counter is persisted on the card record as a simple integer field:

```ts
// On CardRecord
output_version: number
```

The runtime reads it to allocate the next version, increments it, and persists it. The files themselves are durable on disk under `.saivage-work/cards/{cardId}/generated-files/`.

## Crash Recovery

If the runtime crashes after allocating a version number but before the agent writes the file:

- The version directory exists but is empty.
- On recovery, the runtime sees no active activation for that version (the processor actor was not settled).
- The empty directory is harmless. The next activation allocates the next version number.

If the runtime crashes after the agent writes the file but before validating:

- The file exists on disk.
- On recovery, the processor actor's `activeReconstruction` record shows it was mid-activation.
- The existing recovery path either resumes or fails the activation. If it fails, the file remains in the versioned directory as historical evidence of the attempt.

No special recovery logic is needed for output files beyond what the actor recovery path already does.

## What The Prompt Contains

Reviewer prompt:

```text
You are reviewing card {cardId}: {title}

{description}

Acceptance criteria:
{acceptance}

Descendant work:
{for each descendant: id, type, title, status, result summary, output file paths}

Assessment id: {assessmentId}

Write your review to:
output://{cardId}/{N}/review.md

Do not call emit_reviewer_result until the review file exists.
End by calling emit_reviewer_result with your assessment.
```

Planner prompt addition:

```text
Write your planning summary to:
output://{cardId}/{N}/planner-result.md

Do not call emit_planner_result until the summary file exists.
```

Executor prompt addition:

```text
Write your work summary to:
output://{cardId}/{N}/executor-result.md

Do not call emit_executor_result until the summary file exists.
```

## Simplified Evidence Gate

Replace `validateReviewerAssessment` with:

```ts
function validateReviewerAssessment(input: {
  assessment: ReviewerResult['assessment'];
  cardId: string;
  readCard(cardId: string): CardRecord | null;
  cardOutputDir(cardId: string): string | null;
}): { valid: boolean; reason?: string } {
  if (input.assessment.evidence_card_ids.length === 0) {
    return { valid: false, reason: 'Reviewer must cite at least one evidence card.' };
  }
  for (const evidenceId of input.assessment.evidence_card_ids) {
    const card = input.readCard(evidenceId);
    if (!card) return { valid: false, reason: `Reviewer cited missing card '${evidenceId}'.` };
    const outputs = input.cardOutputDir(evidenceId);
    if (!outputs || countNonEmptyFiles(outputs) === 0) {
      return { valid: false, reason: `Cited card '${evidenceId}' has no mandatory output files.` };
    }
  }
  return { valid: true };
}
```

No `artifacts` array. No `attachments` array. No `lifecycle.result` check. Just: do the cited descendant cards have output files on disk?

## API / UI

The operator UI and API expose:

- Card detail shows `generated-files/` directory with versioned outputs.
- Each version shows the files it contains.
- The UI can preview file contents.
- No `artifacts`/`attachments` projections.

This is simpler than the current artifacts/attachments UI.

## Implementation Plan

### Phase 1: Versioned output directory, counter, and path-scheme resolver

1. Add `output_version: number` to `CardRecord` (default 0).
2. Add `allocateOutputVersion(cardId)` to card store: increments `output_version`, creates `.saivage-work/cards/{cardId}/generated-files/{N}/`, returns the directory path.
3. Add `getOutputDir(cardId, version)` helper.
4. Add `countNonEmptyFiles(dir)` helper.
5. Add `resolveOutputUrl(url, projectRoot)` resolver: parses `output://{cardId}/{version}/{filename}` → `.saivage-work/cards/{cardId}/generated-files/{version}/{filename}`, `project://{relative}` → `{projectRoot}/{relative}`, absolute paths unchanged.
6. Add `checkOutputWrite(url, role, allocatedCardId, allocatedVersion)` enforcer: hard reject unless cardId/version/filename all match the current invocation's allocation and the role's designated filename.
7. Tests: allocation increments, directory creation, URL resolution for each scheme, write enforcement per role (reviewer can only write its allocated `output://cardId/version/review.md`, planner cannot write `review.md`, etc.), recovery after crash.

### Phase 2: Reviewer mandatory output + descendant context

1. In `PlanningCardProcessorActor.reviewPlannerDone(...)`, allocate the next output version for the goal card.
2. Build descendant summary context message: for each descendant, include id/type/title/status/result.kind/result.summary and the descendant's latest output URL (e.g., `output://card-7/3/executor-result.md`).
3. Update `reviewerPrompt(...)` to include the mandatory `output://{cardId}/{version}/review.md` URL and the descendant summaries.
4. After reviewer terminal tool call, check `review.md` exists at the allocated URL.
5. If missing, use the existing `LLMToolContinuationContextHook` to inject: "Required file output://{cardId}/{version}/review.md was not created. Create it and call emit_reviewer_result again."
6. Bound repair attempts (2). On exhaustion, fail with runtime diagnostic.
7. When the reviewer returns `needs_corrections`, pass the review URL (e.g., `output://card-1/23/review.md`) to the planner context.
8. Tests: missing file triggers same-session repair; repair succeeds on second attempt; budget exhaustion fails; planner receives review URL in corrections context.

### Phase 3: Replace evidence gate

1. Remove `validateReviewerAssessment`'s `artifacts`/`attachments`/`lifecycle.result` check.
2. Replace with: do cited descendant cards have non-empty files in their `generated-files/` directory.
3. If reviewer emits `pass` but cited descendants have no outputs, route `needs_corrections` to the planner — that is a real missing-work problem.
4. Tests: pass with cited descendant outputs; rejection when cited descendant has no outputs; rejection when no evidence cards cited.

### Phase 4: Planner mandatory output

1. In `PlanningCardProcessorActor.runActivation(...)`, allocate the next output version before the planner LLM turn.
2. Update `plannerPrompt(...)` to include the mandatory `output://{cardId}/{version}/planner-result.md` URL.
3. If received reviewer corrections context, include the review URL (e.g., `output://card-1/23/review.md`) as a readable reference.
4. After planner terminal tool call, check the file exists. If missing, same-session repair via continuation hook.
5. Tests: missing planner summary triggers repair; present file accepts; planner can read prior review URL.

### Phase 5: Executor mandatory output

1. In `TerminalCardProcessorActor` activation, allocate the next output version.
2. Update executor prompt to include the mandatory `output://{cardId}/{version}/executor-result.md` URL.
3. After executor terminal tool call, check the file exists. If missing, same-session repair.
4. Tests: missing executor summary triggers repair; present file accepts.

### Phase 6: Add file tools to reviewer and planner with scheme enforcement

1. Add shared `read`, `write`, `edit`, `apply_patch`, `glob`, `grep` tools to reviewer and planner actor surfaces.
2. All file tools resolve paths via `resolveOutputUrl(url, projectRoot)`.
3. All file tools enforce `checkOutputWrite(url, role, allocatedCardId, allocatedVersion)` before writing.
4. Reviewer can write only `output://{itsCard}/{itsVersion}/review.md`; any other `output://` write or any `project://` write is hard-rejected.
5. Planner can write its own `output://` and any `project://` path; it cannot write another card's or another invocation's `output://`.
6. Both roles can read any `output://` URL and any `project://` path.
7. Keep terminal tools role-specific.
8. Tests: reviewer can write its allocated output URL; reviewer cannot write other output URLs; reviewer cannot write `project://`; planner can read prior reviews by full `output://` URL; planner cannot overwrite `review.md` on any card or version.

### Phase 7: Remove old mechanisms

1. Remove `ArtifactRef`, `AttachmentRef` from `CardRecord`.
2. Remove `artifacts`, `attachments`, `generated_files` from executor terminal envelope and contract.
3. Remove `appendEvidenceRefs`, `registerEvidenceRefs`, `registerEvidenceRefsBestEffort`, `CardStore.appendEvidenceRefs`.
4. Remove `appendExecutorEvidence` from `TerminalCardProcessorActor`.
5. Remove `artifacts`/`attachments` from `PLANNER_ALLOWED_EDIT_FIELDS`.
6. Remove advisory write-territory warnings that always return `allowed: true`; either enforce or delete.
7. Update card creation to no longer initialize `artifacts: []`, `attachments: []`.
8. Update API/UI to show `generated-files/` instead of artifacts/attachments.
9. Tests: confirm no references to removed types; confirm card store still works; confirm executor no longer tries to register artifacts.

### Phase 8: Docs and prompt tests

1. Update `docs/spec/system-specification.md`: remove artifact/attachment language; add mandatory output file language.
2. Update `docs/architecture/system-architecture.md`: remove artifact/evidence-ref references; add versioned output directory.
3. Update `docs/architecture/agent-tool-surfaces-and-information-flow.md`: implement the reviewer descendant-summary design.
4. Add prompt tests asserting mandatory output paths appear in planner/reviewer/executor prompts.
5. Update existing tests that reference `artifacts`/`attachments`/`appendEvidenceRefs`.

## Scope Of Change

This removes more code than it adds:

**Removed:**
- `ArtifactRef`, `AttachmentRef` types and all their usage.
- `appendEvidenceRefs`, `registerEvidenceRefs`, `registerEvidenceRefsBestEffort`.
- Executor envelope `artifacts`, `attachments`, `generated_files` fields.
- `appendExecutorEvidence` in terminal processor.
- `validateReviewerAssessment`'s artifact-length check.
- Advisory write-territory warnings.
- Artifacts/attachments UI projections.

**Added:**
- `output_version` on `CardRecord` (one integer field).
- `allocateOutputVersion` (one store method).
- `resolveOutputUrl` and `checkOutputWrite` URL resolver and three-dimensional write enforcer.
- Versioned directory creation.
- Mandatory file-existence checks after terminal tool calls.
- Same-session repair via existing continuation hook.
- Reviewer descendant summary context message with `output://` URLs (already designed, not implemented).
- Cross-agent output references via fully-qualified `output://{cardId}/{version}/{filename}` URLs.
- Shared file tools for reviewer (write to its allocated output URL, read any output URL and project files) and planner (full file access via `project://` and its own `output://`).
- `generated-files/` UI projection.

**Net:** fewer types, fewer methods, fewer soft gates, fewer advisory layers. One new integer field, one new store method, one new directory convention, and hard file-existence checks.

## Conclusion

The current codebase has soft mechanisms that failed closed. The fix is not to add more mechanisms; it is to replace soft controls with hard contracts: mandatory output files at versioned declared paths, hard existence checks, same-agent repair via existing seams, and a simple evidence gate that checks whether cited descendant cards have output files on disk.

Output files are addressed by fully-qualified `output://{cardId}/{version}/{filename}` URLs that any agent can read and pass to other agents. Write is three-dimensionally enforced: only your card, only your version, only your role's filename. No implicit resolution, no context-relative ambiguity, no stale references.

No `ArtifactRef`. No `appendEvidenceRefs`. No `registerEvidenceRefsBestEffort`. No `generated_files` tracking. No advisory write territories. No `invocation.json` manifest. No slot metadata. No registration step. The file existing at the declared URL is the evidence.