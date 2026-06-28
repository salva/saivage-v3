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
| `validateReviewerAssessment`'s `artifacts.length > 0 \|\| attachments.length > 0 \|\| lifecycle.result` check | Replaced by: does the reviewer's mandatory record exist, and did the reviewer cite accepted cards from the reviewed subtree. |
| Write-territory advisory warnings that always return `allowed: true` | Replaced by hard scheme-based enforcement in the file tools. |
| Path-pattern-based write territories | Replaced by `record://`, `tmp://`, and `project://` scheme enforcement. |

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
.saivage/outputs/cards/{cardId}/{N}/{filename}
```

Where `{N}` is a monotonically increasing record version per card. The persisted `record_version` is the last published record version, not a counter that advances merely because a card was activated.

The processor declares the current draft record URL as `record://{cardId}/{record_version + 1}/{filename}`. That version is committed only when an agent calls its terminal `emit_*` tool and the runtime accepts the declared file as that agent's output. The committed version is visible to the next planner/reviewer/executor iteration.

If a card is reactivated after a blocked activation or parent retry without a new accepted terminal record, the record version does not advance. The next attempt reuses the same next version number. Missing-file repair attempts also reuse the same draft version.

Examples:

- A parent reactivates a previously blocked planner card, but the planner does not emit a new accepted terminal record. `record_version` does not change.
- A planner emits `emit_planner_result` with `planner-result.md`, and the runtime accepts that file as the planner's terminal record. `record_version` advances after that emit commits, so the next planner/reviewer iteration sees the next version number.
- A reviewer emits `emit_reviewer_result` with `review.md`, and the runtime accepts that file. `record_version` advances after that review record commits.

Example:

```text
.saivage/outputs/cards/card-1/
  1/
    review.md
  2/
    review.md
  3/
    review.md
    planner-result.md
```

Version 1 and 2 reviews remain available even after the version 3 review replaces them as the current one. The runtime, UI, and reviewer can read prior versions for comparison.

Mandatory output files are durable runtime evidence, so they live under `.saivage/outputs/`, not under `.saivage-work/` or future `.saivage/work/`. The work directory is disposable operational scratch for shell/process outputs and caches; removing it must not lose critical agent evidence.

The record version is card-scoped, not invocation-scoped, because a card may have multiple planner/reviewer/executor cycles across its lifecycle. The version advances when an emitted file becomes the accepted record for the card, not when an LLM turn starts. This keeps retries and blocked reactivations from creating meaningless gaps, while preserving a stable historical sequence of accepted records.

## File Path Schemes

File tools accept a URL-like scheme prefix that tells the runtime where the file lives and enforces the write boundary.

| Scheme | Format | Resolves to |
|---|---|---|
| `record://` | `record://{cardId}/{version}/{filename}` | `.saivage/outputs/cards/{cardId}/{version}/{filename}` |
| `tmp://` | `tmp://{cardId}/{relative}` | `.saivage/work/cards/{cardId}/tmp/{relative}` |
| `project://` | `project://{relative}` or absolute path | `{projectRoot}/{relative}` |

Examples:
- `record://card-1/23/review.md` → `.saivage/outputs/cards/card-1/23/review.md`
- `record://card-34/7/planner-result.md` → `.saivage/outputs/cards/card-34/7/planner-result.md`
- `tmp://card-34/scratch-notes.md` → `.saivage/work/cards/card-34/tmp/scratch-notes.md`
- `project://src/foo.ts` → `{projectRoot}/src/foo.ts`
- `/home/salva/g/ml/getrich-v2/README.md` → absolute, same as `project://`

The `record://` URL is fully-qualified: it contains the card ID, the version number, and the filename. Any agent can read any record output file by URL, regardless of which card or invocation produced it. This makes output references passable between agents — the reviewer can cite `record://card-7/3/executor-result.md` in its review, and the planner can read `record://card-1/23/review.md` to see why the reviewer rejected its work.

`record://` is not a shortcut for `project://.saivage/...`. It uses a dedicated resolver and access policy for durable runtime evidence. Agents never get discretionary write access to `.saivage/`: they may only write a runtime-declared mandatory `record://` URL for the current invocation. Ordinary `project://` access must continue to treat `.saivage/` and the work directory as internal state unless a specific operator-facing tool allows inspection.

There is no implicit or context-relative `record://` resolution. The prompt always passes the full URL. This avoids ambiguity when an agent needs to reference another card's output.

`tmp://` is the discretionary scratch scheme. Any card can read any card's tmp files, but an agent can write only under its current card's `tmp://{cardId}/...` tree. Tmp files are not evidence and may be deleted with `.saivage/work` cleanup.

### Write enforcement

Write enforcement is three-dimensional, checking all components of the URL:

| Rule | Check |
|---|---|
| Card matches current invocation's card | `url.cardId == declaredCardId` |
| Version matches current invocation's draft version | `url.version == declaredDraftVersion` |
| Filename matches role's designated record output | `url.filename == roleAllowedFilename` |

| Role | Allowed record filename | `record://` write | `tmp://` write | `project://` write | `record://` read | `tmp://` read | `project://` read |
|---|---|---|---|---|---|---|---|
| Planner | `planner-result.md` | current invocation's declared URL only | current card only | no | any card, any version | any card | yes |
| Executor | `executor-result.md` | current invocation's declared URL only | current card only | yes | any card, any version | any card | yes |
| Reviewer | `review.md` | current invocation's declared URL only | current card only | no | any card, any version | any card | yes |

The planner physically cannot overwrite `record://card-1/23/review.md` because:
1. Version 23 was declared for the reviewer's terminal record, not the planner's.
2. `review.md` is not the planner's designated filename.

The reviewer cannot write `project://` paths at all. No agent can freely write `.saivage/` by path or scheme. These are hard checks enforced in the file tools, not advisory warnings.

### Role designated filenames

Each role has exactly one designated record filename:

| Role | Filename |
|---|---|
| Planner | `planner-result.md` |
| Executor | `executor-result.md` |
| Reviewer | `review.md` |

An agent can only write its role's designated record filename to its own declared draft version. It can read any record file from any version of any card. Its only discretionary scratch writes are under `tmp://{currentCardId}/...`.

## How It Works

### Before invocation

The processor derives the draft version as `record_version + 1`, creates that directory if needed, and passes the full `record://` URL in the prompt. It does not advance the persisted `record_version` yet.

```text
You must write your review to:
record://card-1/23/review.md

Do not call emit_reviewer_result until that file exists.
```

The agent receives:
- The full `record://` URL for mandatory files.
- The instruction to create the file before calling the terminal tool.

The URL is fully-qualified and stable. The agent copies it into file tools. The runtime resolves it to the filesystem path.

### After terminal tool call

The runtime checks whether each mandatory file exists at the resolved path and is non-empty.

- **All files present:** accept the terminal result and advance `record_version` to the draft version.
- **Files missing:** reject, re-enter the same agent session with a continuation message naming the missing `record://` URLs, increment nothing.
- **Repair budget exhausted:** fail the activation with a clear runtime diagnostic.

### What the agent uses to write files

The agent uses normal file-writing tools (`write`, `edit`, `apply_patch`) with the `record://` scheme to create the runtime-declared mandatory file. There is no special `register_evidence` tool. The file existing at the resolved path is the evidence. The agent cannot use `record://` for discretionary writes.

For project work files (code, tests, docs), the agent uses `project://` or absolute paths with the same tools.

### Cross-agent references

When the reviewer returns `needs_corrections`, the runtime passes the review URL to the planner:

```text
Reviewer rejected at record://card-1/23/review.md. Read it for corrections.
```

The planner reads `record://card-1/23/review.md` — a fully-qualified URL it can resolve regardless of its own card or version. No agent needs to construct or guess paths.

When the reviewer is invoked, its context message includes descendant record URLs:

```text
Descendant work:
- card-7 (executor, done): record://card-7/3/executor-result.md
- card-8 (executor, done): record://card-8/1/executor-result.md
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
record://card-1/23/review.md

Create the file, then call emit_reviewer_result.
```

After `emit_reviewer_result`, the runtime checks `record://card-1/23/review.md` exists. If not, the same reviewer session gets:

```text
Required record file record://card-1/23/review.md was not created. Create it, then call emit_reviewer_result again.
```

### Planner

| File | Required When | Purpose |
|---|---|---|
| `planner-result.md` | Always | Planning summary for the diary. |

The planner prompt says:

```text
Write your planning summary to:
record://card-1/24/planner-result.md

Create the file, then call emit_planner_result.
```

### Executor

| File | Required When | Purpose |
|---|---|---|
| `executor-result.md` | Always | Work summary and evidence of what was done. |

The executor prompt says:

```text
Write your work summary to:
record://card-42/5/executor-result.md

Create the file, then call emit_executor_result.
```

Executors continue writing code, tests, and other work files directly into the project directory. The mandatory output file is the summary, not the full work product.

## Reviewer Evidence Gate

The current `validateReviewerAssessment` checks whether cited evidence cards have `artifacts.length > 0 || attachments.length > 0 || lifecycle.result`. That check is removed.

The new gate is:

1. Does the reviewer's own mandatory `review.md` exist? (Checked before this point; if not, same-agent repair.)
2. Did the reviewer cite at least one descendant card in `evidence_card_ids`?
3. Does each cited card exist, belong to the reviewed subtree, and already have an accepted terminal status such as `done`?

The gate does not re-open accepted descendant cards to check their record files. Accepted descendant status is the runtime fact that those cards already satisfied their own mandatory-record contract. Rechecking descendant files here duplicates acceptance logic and can produce stale false negatives.

If the reviewer emits `pass` citing accepted descendant cards from the reviewed subtree, the gate passes. No `ArtifactRef`, no `appendEvidenceRefs`, no artifact-length check, no descendant file scan.

## Reviewer Context

The reviewer currently receives only the goal card's title, description, and acceptance — no descendant information. That is the root cause of card-1's blockage: the reviewer had no descendant evidence to cite, so it cited the goal card itself, which had no artifacts.

The reviewer must receive descendant summaries as context messages before invocation. For each descendant of the goal card:

- `id`, `type`, `title`, `status`
- `lifecycle.result.kind` (executor_success, planner_done, planner_blocked, etc.)
- `lifecycle.result.summary` or `lifecycle.result.error`
- The descendant's record URLs (e.g., `record://card-7/3/executor-result.md`) so the reviewer can `read` them

This lets the reviewer cite descendant cards that have real work products and read those products if needed. The reviewer reads descendant files by their `record://` URL; it writes its own review only to its runtime-declared `record://` URL.

This was already designed in `agent-tool-surfaces-and-information-flow.md` (section "Reviewer context — special case") but never implemented. The mandatory-output design depends on it being implemented now.

## File Tools For Reviewer And Planner

The reviewer and planner currently have no file-writing tools. All agents share the same file tools (`read`, `write`, `edit`, `apply_patch`, `glob`, `grep`), but path resolution and write enforcement are scheme-based and fully-qualified.

### Path resolution

| Scheme | Format | Resolves to |
|---|---|---|
| `record://{cardId}/{version}/{filename}` | Fully-qualified durable record URL | `.saivage/outputs/cards/{cardId}/{version}/{filename}` |
| `tmp://{cardId}/{relative}` | Per-card scratch URL | `.saivage/work/cards/{cardId}/tmp/{relative}` |
| `project://{relative}` | Project-relative path | `{projectRoot}/{relative}` |
| Absolute path `/...` | Same filesystem path | Same filesystem path |

The `record://` URL is fully-qualified. The runtime resolves it before the file tool touches the filesystem. Any agent can read any `record://` URL. Write is restricted to the current invocation's declared draft `(cardId, version, filename)` and is allowed only for declared mandatory record files.

The `tmp://` URL is card-scoped scratch. Any agent can read any `tmp://` URL, but writes are allowed only under `tmp://{currentCardId}/...`.

### Write enforcement

The file tool checks all three components of a `record://` write:

1. `cardId` must match the current invocation's card.
2. `version` must match the current invocation's declared draft version.
3. `filename` must match the role's designated filename.

The reviewer can only write its declared `record://{itsCard}/{itsVersion}/review.md`. Any other `record://` write or any `project://` write is hard-rejected. The planner and executor can write their declared record file. Only the executor can write `project://` work products; the planner and reviewer coordinate through cards, records, and `tmp://` scratch.

This replaces the current advisory write-territory system with hard scheme-based enforcement in the file tools. No advisory warnings, no path-pattern territories.

## Validation And Repair Flow

```text
runtime derives draft version N = C.record_version + 1
runtime creates .saivage/outputs/cards/C/N/
runtime invokes agent with mandatory record://C/N/{filename} URL(s) in prompt
agent writes mandatory file(s) using file tools with record:// scheme
agent calls terminal tool (emit_*_result)
runtime checks mandatory file(s) exist at record://C/N/{filename} and are non-empty
  if missing:
    append continuation message to same LLM session:
      "Required file record://C/N/{filename} was not created. Create it and call {terminal_tool} again."
    re-enter same agent (not a new session)
    if repair budget exhausted:
      fail activation with runtime diagnostic
  if present:
    accept terminal result
    persist C.record_version = N
    proceed with role-specific evaluation (evidence gate, completion gates, etc.)
```

The repair uses the existing `LLMToolContinuationContextHook` seam — the same mechanism that injects notification context between tool result and next LLM turn. No new "repair event" framework.

Repair budget: 2 attempts by default. Configurable per card via card metadata if needed later.

## Persistence

The versioned output files ARE the persistent evidence. No separate `invocation.json` manifest, no slot metadata database, no registration records.

Because these files are persistent evidence, they are not stored in `.saivage-work/` or future `.saivage/work/`. That directory is disposable work state for shell command outputs, temporary process data, caches, and other rebuildable operational files. Generic work cleanup may delete `.saivage/work`, but it must not delete `.saivage/outputs`.

The last published record version is persisted on the card record as a simple integer field:

```ts
// On CardRecord
record_version: number
```

The runtime reads it to derive the next draft version. It advances the persisted value only after a terminal `emit_*` call has selected an existing non-empty file as the accepted record. The files themselves are durable on disk under `.saivage/outputs/cards/{cardId}/`.

## Crash Recovery

If the runtime crashes after declaring a draft version but before the agent writes the file:

- The version directory may exist but be empty.
- The card's persisted `record_version` has not advanced.
- The empty directory is harmless. The next activation reuses the same draft version unless a prior terminal emit was already committed.

If the runtime crashes after the agent writes the file but before validating or committing the terminal emit:

- The file exists on disk.
- On recovery, the processor actor's `activeReconstruction` record shows it was mid-activation.
- The existing recovery path either resumes or fails the activation. If it fails before terminal commit, `record_version` has not advanced and the next activation may overwrite or replace that unaccepted draft file. Only files selected by an accepted terminal emit are part of the durable accepted-record sequence.

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
record://{cardId}/{N}/review.md

Do not call emit_reviewer_result until the review file exists.
End by calling emit_reviewer_result with your assessment.
```

Planner prompt addition:

```text
Write your planning summary to:
record://{cardId}/{N}/planner-result.md

Do not call emit_planner_result until the summary file exists.
```

Executor prompt addition:

```text
Write your work summary to:
record://{cardId}/{N}/executor-result.md

Do not call emit_executor_result until the summary file exists.
```

## Simplified Evidence Gate

Replace `validateReviewerAssessment` with:

```ts
function validateReviewerAssessment(input: {
  assessment: ReviewerResult['assessment'];
  cardId: string;
  readCard(cardId: string): CardRecord | null;
  isDescendantOf(cardId: string, ancestorId: string): boolean;
}): { valid: boolean; reason?: string } {
  if (input.assessment.evidence_card_ids.length === 0) {
    return { valid: false, reason: 'Reviewer must cite at least one evidence card.' };
  }
  for (const evidenceId of input.assessment.evidence_card_ids) {
    const card = input.readCard(evidenceId);
    if (!card) return { valid: false, reason: `Reviewer cited missing card '${evidenceId}'.` };
    if (!input.isDescendantOf(evidenceId, input.cardId)) {
      return { valid: false, reason: `Reviewer cited card '${evidenceId}' outside the reviewed subtree.` };
    }
    if (card.status !== 'done') {
      return { valid: false, reason: `Reviewer cited non-accepted card '${evidenceId}' with status '${card.status}'.` };
    }
  }
  return { valid: true };
}
```

No `artifacts` array. No `attachments` array. No `lifecycle.result` check. No descendant record-file scan. Just: did the reviewer cite accepted cards from the reviewed subtree?

## API / UI

The operator UI and API expose:

- Card detail shows `.saivage/outputs/cards/{cardId}/` with versioned outputs.
- Each version shows the files it contains.
- The UI can preview file contents.
- No `artifacts`/`attachments` projections.

This is simpler than the current artifacts/attachments UI.

## Implementation Plan

### Phase 1: Versioned record directory, cursor, and path-scheme resolver

1. Add `record_version: number` to `CardRecord` (default 0), meaning the last published record version.
2. Add `beginRecordDraft(cardId)` helper: computes `N = record_version + 1`, creates `.saivage/outputs/cards/{cardId}/{N}/`, returns the draft URL components, and does not mutate the card.
3. Add `getRecordDir(cardId, version)` helper.
4. Add `resolveAgentUrl(url, projectRoot)` resolver: parses `record://{cardId}/{version}/{filename}` through a dedicated durable-record branch → `.saivage/outputs/cards/{cardId}/{version}/{filename}`; parses `tmp://{cardId}/{relative}` through the disposable card scratch branch → `.saivage/work/cards/{cardId}/tmp/{relative}`; parses `project://{relative}` through ordinary project-file policy → `{projectRoot}/{relative}`; absolute paths remain ordinary project paths.
5. Add `checkAgentWrite(url, role, declaredCardId, declaredDraftVersion, currentCardId)` enforcer: hard reject `record://` unless cardId/version/filename all match the current invocation's declared mandatory record file; hard reject `tmp://` unless cardId matches the current card; hard reject direct `.saivage/` writes through `project://` or absolute paths.
6. Tests: draft directory creation without incrementing `record_version`, terminal commit advances `record_version`, blocked/reactivated cards reuse the same next version, URL resolution for each scheme, write enforcement per role (reviewer can only write its declared `record://cardId/version/review.md`, planner cannot write `review.md`, every role can write `tmp://{currentCardId}/...` but not another card's tmp dir, etc.), recovery after crash.

### Phase 2: Add scheme-enforced file tools

1. Add shared `read`, `write`, `edit`, `apply_patch`, `glob`, `grep` tools to planner, executor, and reviewer actor surfaces as appropriate for each role.
2. All file tools resolve paths via `resolveAgentUrl(url, projectRoot)`.
3. All file tools enforce `checkAgentWrite(url, role, declaredCardId, declaredDraftVersion, currentCardId)` before writing.
4. Reviewer can write only `record://{itsCard}/{itsVersion}/review.md`, plus `tmp://{itsCard}/...`; any other `record://` write or any `project://` write is hard-rejected.
5. Planner can write its own declared `record://` file and `tmp://{itsCard}/...`; it cannot write project files, another card's tmp dir, or another card's record.
6. Executor can write its own declared `record://` file, `tmp://{itsCard}/...`, and ordinary `project://` work files.
7. All roles can read any `record://`, any `tmp://`, and allowed `project://` paths.
8. Keep terminal tools role-specific.
9. Tests: reviewer can write its declared record URL; reviewer cannot write other record URLs; reviewer cannot write `project://`; planner can read prior reviews by full `record://` URL; planner cannot overwrite `review.md` on any card or version; all roles can write only current-card `tmp://` scratch.

### Phase 3: Reviewer mandatory output + descendant context

1. In `PlanningCardProcessorActor.reviewPlannerDone(...)`, declare the next draft record version for the goal card.
2. Build descendant summary context message: for each descendant, include id/type/title/status/result.kind/result.summary and the descendant's latest record URL (e.g., `record://card-7/3/executor-result.md`).
3. Update `reviewerPrompt(...)` to include the mandatory `record://{cardId}/{version}/review.md` URL and the descendant summaries.
4. After reviewer terminal tool call, check `review.md` exists at the declared URL.
5. If missing, use the existing `LLMToolContinuationContextHook` to inject: "Required file record://{cardId}/{version}/review.md was not created. Create it and call emit_reviewer_result again."
6. Bound repair attempts (2). On exhaustion, fail with runtime diagnostic.
7. When the reviewer returns `needs_corrections`, pass the review URL (e.g., `record://card-1/23/review.md`) to the planner context.
8. Tests: missing file triggers same-session repair; repair succeeds on second attempt; budget exhaustion fails; planner receives review URL in corrections context.

### Phase 4: Replace evidence gate

1. Remove `validateReviewerAssessment`'s `artifacts`/`attachments`/`lifecycle.result` check.
2. Replace with: do cited cards exist, belong to the reviewed subtree, and already have accepted terminal status.
3. Do not scan descendant record files; accepted descendant cards already passed their own mandatory-record checks.
4. Tests: pass with cited accepted descendants; rejection when cited card is missing, outside the subtree, not accepted, or no evidence cards are cited.

### Phase 5: Planner mandatory output

1. In `PlanningCardProcessorActor.runActivation(...)`, declare the next draft record version before the planner LLM turn without advancing `record_version`.
2. Update `plannerPrompt(...)` to include the mandatory `record://{cardId}/{version}/planner-result.md` URL.
3. If received reviewer corrections context, include the review URL (e.g., `record://card-1/23/review.md`) as a readable reference.
4. After planner terminal tool call, check the file exists. If missing, same-session repair via continuation hook.
5. Tests: missing planner summary triggers repair; present file accepts; planner can read prior review URL.

### Phase 6: Executor mandatory output

1. In `TerminalCardProcessorActor` activation, declare the next draft record version without advancing `record_version`.
2. Update executor prompt to include the mandatory `record://{cardId}/{version}/executor-result.md` URL.
3. After executor terminal tool call, check the file exists. If missing, same-session repair.
4. Tests: missing executor summary triggers repair; present file accepts.

### Phase 7: Remove old mechanisms

1. Remove `ArtifactRef`, `AttachmentRef` from `CardRecord`.
2. Remove `artifacts`, `attachments`, `generated_files` from executor terminal envelope and contract.
3. Remove `appendEvidenceRefs`, `registerEvidenceRefs`, `registerEvidenceRefsBestEffort`, `CardStore.appendEvidenceRefs`.
4. Remove `appendExecutorEvidence` from `TerminalCardProcessorActor`.
5. Remove `artifacts`/`attachments` from `PLANNER_ALLOWED_EDIT_FIELDS`.
6. Remove advisory write-territory warnings that always return `allowed: true`; either enforce or delete.
7. Update card creation to no longer initialize `artifacts: []`, `attachments: []`.
8. Update API/UI to show `.saivage/outputs/cards/{cardId}/` instead of artifacts/attachments.
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
- `record_version` on `CardRecord` (one integer field).
- `beginRecordDraft` and terminal record commit helpers.
- `resolveAgentUrl` and `checkAgentWrite` URL resolver and write enforcer.
- Versioned directory creation.
- Mandatory file-existence checks after terminal tool calls.
- Same-session repair via existing continuation hook.
- Reviewer descendant summary context message with `record://` URLs (already designed, not implemented).
- Cross-agent record references via fully-qualified `record://{cardId}/{version}/{filename}` URLs.
- Shared file tools with strict scheme enforcement: mandatory `record://` writes only, current-card `tmp://` scratch writes, no discretionary `.saivage/` writes.
- `.saivage/outputs/cards/{cardId}/` UI projection.

**Net:** fewer types, fewer methods, fewer soft gates, fewer advisory layers. One new integer field, one new store method, one new directory convention, and hard file-existence checks.

## Conclusion

The current codebase has soft mechanisms that failed closed. The fix is not to add more mechanisms; it is to replace soft controls with hard contracts: mandatory output files at versioned declared paths, hard existence checks, same-agent repair via existing seams, and a simple reviewer gate that checks whether cited evidence cards are accepted descendants of the reviewed card.

Record files are addressed by fully-qualified `record://{cardId}/{version}/{filename}` URLs that any agent can read and pass to other agents. Record writes are three-dimensionally enforced: only your card, only your version, only your role's declared filename. Discretionary writes go only to `tmp://{currentCardId}/...`. No implicit resolution, no context-relative ambiguity, no stale references.

No `ArtifactRef`. No `appendEvidenceRefs`. No `registerEvidenceRefsBestEffort`. No `generated_files` tracking. No advisory write territories. No `invocation.json` manifest. No slot metadata. No registration step. The file existing at the declared URL is the evidence.
