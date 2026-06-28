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

1. The runtime declares mandatory record slot URLs in the prompt before invoking an agent.
2. The agent writes those record files using a URL-scheme with hard write enforcement.
3. The runtime hard-validates their existence after the terminal tool call.
4. Missing files trigger same-agent repair, not escalation to another role.
5. Record versions are slot-scoped and append-only so all history remains available.
6. The executor writes normal work files directly into the project directory via `project://`; planner and reviewer coordinate through cards, records, and `tmp://` scratch — no special registration, no artifact refs, no copy step.

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

## Versioned Record Slots

Every mandatory output file lives in a card-local record slot. Each slot has its own version sequence:

```text
.saivage/outputs/cards/{cardId}/{slot}/
  index.json
  {version}.md
```

For example:

```text
.saivage/outputs/cards/card-1/
  review/
    index.json
    1.md
    2.md
  status/
    index.json
    1.md
```

The slot name comes from the record filename without its extension. `review.md` writes to the `review/` slot, and `status.md` writes to the `status/` slot. This makes versions independent per record type: a new review does not advance the status slot, and a new status record does not advance the review slot.

The current writable version is slot-local. A new version is created only when a write asks for `v=next` and the current version for that slot is already closed or discarded. Closing happens when an agent calls its terminal `emit_*` tool and the runtime accepts the declared record file as that agent's output. Blocked activations, parent retries, and missing-file repair attempts do not create new versions unless they need a fresh writable slot after a previous emitted version was closed or discarded.

Examples:

- A parent reactivates a previously blocked planner card, but the planner does not emit a new accepted terminal record. No slot version advances.
- A planner writes `record://status.md?v=next`, gets a concrete URL such as `record://status.md?card=card-1&v=2`, then emits `emit_planner_result`. The runtime closes `status/2.md`.
- A reviewer writes `record://review.md?v=next`, gets `record://review.md?card=card-1&v=1`, then emits `emit_reviewer_result`. The runtime closes `review/1.md`.

Prior reviews remain available even after a later review becomes the current one. The runtime, UI, and reviewer can read prior versions for comparison.

Mandatory output files are durable runtime evidence, so they live under `.saivage/outputs/`, not under `.saivage-work/` or future `.saivage/work/`. The work directory is disposable operational scratch for shell/process outputs and caches; removing it must not lose critical agent evidence.

Record versions are slot-scoped, not invocation-scoped or card-global. The version advances when an emitted file closes that slot, not when an LLM turn starts. This keeps retries and blocked reactivations from creating meaningless gaps, while preserving a stable historical sequence for each record type.

## File Path Schemes

File tools accept a URL-like scheme prefix that tells the runtime where the file lives and enforces the write boundary.

| Scheme | Format | Resolves to |
|---|---|---|
| `record://` | `record://{slot}.md?card={cardId}&v={version}` | `.saivage/outputs/cards/{cardId}/{slot}/{version}.md` |
| `tmp://` | `tmp://{cardId}/{relative}` | `.saivage/work/cards/{cardId}/tmp/{relative}` |
| `project://` | `project://{relative}` or absolute path | `{projectRoot}/{relative}` |

Examples:
- `record://review.md?card=card-1&v=23` → `.saivage/outputs/cards/card-1/review/23.md`
- `record://status.md?card=card-34&v=7` → `.saivage/outputs/cards/card-34/status/7.md`
- `record://review.md` → latest closed `review` record for the current card
- `record://review.md?v=next` → writable next `review` record for the current card
- `record://review.md?v=latest&card=card-7` → latest closed `review` record for card-7
- `tmp://card-34/scratch-notes.md` → `.saivage/work/cards/card-34/tmp/scratch-notes.md`
- `project://src/foo.ts` → `{projectRoot}/src/foo.ts`
- `/home/salva/g/ml/getrich-v2/README.md` → absolute, same as `project://`

The `record://` URL addresses a record slot. If `card` is omitted, it defaults to the current card. If `v` is omitted for reads, it defaults to `latest`. If `v=next` is used for writes, the file tool resolves or creates the current writable version for that slot and returns the concrete URL, such as `record://review.md?card=card-1&v=3`. Any agent can read any closed record by URL, regardless of which card or invocation produced it. This makes record references passable between agents — the reviewer can cite `record://status.md?card=card-7` in its review, and the planner can read `record://review.md?card=card-1&v=23` to see why the reviewer rejected its work.

`record://` is not a shortcut for `project://.saivage/...`. It uses a dedicated resolver and access policy for durable runtime evidence. Agents never get discretionary write access to `.saivage/`: they may only write a runtime-declared mandatory `record://` URL for the current invocation. Ordinary `project://` access must continue to treat `.saivage/` and the work directory as internal state unless a specific operator-facing tool allows inspection.

For writes, the prompt can pass a symbolic `record://{slot}.md?v=next` URL and the write tool returns the concrete URL. For reads, `latest` is a convenience selector over closed records. Concrete URLs with `card` and numeric `v` remain stable historical references.

Every file operation that accepts a `record://` URL returns the normalized concrete record URL in the tool response. For example, reading `record://review.md` from card 5 might return `record_url: "record://review.md?v=2&card=card-5"`; writing `record://review.md?v=next` might return `record_url: "record://review.md?v=3&card=card-5"`. Agents should cite and emit the returned normalized URL, not reconstruct it.

`tmp://` is the discretionary scratch scheme. Any card can read any card's tmp files, but an agent can write only under its current card's `tmp://{cardId}/...` tree. Tmp files are not evidence and may be deleted with `.saivage/work` cleanup.

`glob` and `grep` accept a `record://` value for their directory/path argument to target a card's record tree. `glob directory="record://card-1" pattern="**/*.md"` searches all slots of card-1. `grep path="record://card-1/review"` searches only the `review` slot of card-1. These search only closed records.

The `record://` URL format is `record://{filename}?card={cardId}&v={version}` where `{filename}` is any filename (not just `.md`). The slot name is the filename without its extension. Current mandatory records use `.md`, but the format allows future non-markdown records without scheme changes.

Record files under `.saivage/outputs/` are durable evidence and must never be removed by `cleanup.ts` or generic work cleanup. The existing card `tmp/` cleanup in `cleanup.ts` remains limited to `tmp/` and must not be expanded to touch `outputs/`.

### Write enforcement

Write enforcement is slot-scoped, checking the record target before any write:

| Rule | Check |
|---|---|
| Card matches current invocation's card | `url.card == currentCardId` for writes |
| Slot is writable for the role | `url.slot == roleAllowedSlot` |
| Version is open | `url.v` resolves to an open, unclosed slot version |

| Role | Allowed record filename | `record://` write | `tmp://` write | `project://` write | `record://` read | `tmp://` read | `project://` read |
|---|---|---|---|---|---|---|---|
| Planner | `status.md` | current card's `status` slot only | current card only | no | any card, any version | any card | yes |
| Executor | `status.md` | current card's `status` slot only | current card only | yes | any card, any version | any card | yes |
| Reviewer | `review.md` | current card's `review` slot only | current card only | no | any card, any version | any card | yes |

The planner physically cannot overwrite `record://review.md?card=card-1&v=23` because:
1. `review` is not the planner's writable slot.
2. Version 23 is closed after the reviewer emits it.

The reviewer cannot write `project://` paths at all. No agent can freely write `.saivage/` by path or scheme. These are hard checks enforced in the file tools, not advisory warnings.

### Role designated filenames

Each role has designated record filenames:

| Role | Filename |
|---|---|
| Planner | `status.md` |
| Executor | `status.md` |
| Reviewer | `review.md` |

An agent can only write its role's designated record slot for the current card. It can read any closed record file from any version of any card. Its only discretionary scratch writes are under `tmp://{currentCardId}/...`.

## How It Works

### Before invocation

The prompt passes a symbolic slot URL such as `record://review.md?v=next`. The file tool resolves that symbolic URL for the current card, creates or reuses the open slot version, and returns a normalized concrete URL such as `record://review.md?v=2&card=card-5`.

```text
You must write your review to:
record://review.md?v=next

Do not call emit_reviewer_result until that file exists.
```

The agent receives:
- The symbolic `record://` URL for mandatory files.
- The instruction to create the file before calling the terminal tool.

The agent copies it into file tools. The write tool returns the normalized concrete record URL, and the agent uses that returned URL when citing or emitting the record.

### After terminal tool call

The runtime checks whether each mandatory record slot has a concrete normalized URL, exists at the resolved path, and is non-empty.

- **All files present:** accept the terminal result and close that slot version.
- **Files missing:** reject, re-enter the same agent session with a continuation message naming the missing `record://` URLs, increment nothing.
- **Repair budget exhausted:** fail the activation with a clear runtime diagnostic.

### What the agent uses to write files

The agent uses normal file-writing tools (`write`, `edit`, `apply_patch`) with the `record://` scheme to create the runtime-declared mandatory file. There is no special `register_evidence` tool. The file existing at the resolved path is the evidence. The agent cannot use `record://` for discretionary writes.

For project work files (code, tests, docs), the agent uses `project://` or absolute paths with the same tools.

### Cross-agent references

When the reviewer returns `needs_corrections`, the runtime passes the review URL to the planner:

```text
Reviewer rejected at record://review.md?v=23&card=card-1. Read it for corrections.
```

The planner reads `record://review.md?v=23&card=card-1` — a concrete URL it can resolve regardless of its own card. No agent needs to construct or guess filesystem paths.

When the reviewer is invoked, its context message includes descendant record URLs:

```text
Descendant work:
- card-7 (executor, done): record://status.md?v=3&card=card-7
- card-8 (executor, done): record://status.md?v=1&card=card-8
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
record://review.md?v=next

Create the file, then call emit_reviewer_result.
```

After `emit_reviewer_result`, the runtime checks the normalized concrete review URL returned by the write tool exists. If not, the same reviewer session gets:

```text
Required record file record://review.md?v=next was not created. Create it, then call emit_reviewer_result again.
```

### Planner

| File | Required When | Purpose |
|---|---|---|
| `status.md` | Every planner invocation, all outcomes | Current status/summary visible to the parent, including done, blocked, or failed reports. |

The planner prompt says:

```text
Write your current invocation status to:
record://status.md?v=next

Do not call emit_planner_result until the status file exists.
```

### Executor

| File | Required When | Purpose |
|---|---|---|
| `status.md` | Every executor invocation, all outcomes | Current status/summary visible to the parent, including done, blocked, or failed reports. |

The executor prompt says:

```text
Write your current invocation status to:
record://status.md?v=next

Do not call emit_executor_result until the status file exists.
```

Executors continue writing code, tests, and other work files directly into the project directory. The mandatory output file is the summary, not the full work product.

### Status Records

`status.md` is a per-invocation parent-observability record. Planner and executor invocations must close a new `status` slot version every time they reach a terminal `emit_*` call, including blocked or failed results. This gives the parent card a durable, human-readable account of what happened without waiting for a successful result record.

If an agent emits failure through its terminal tool, the failure still requires a `status.md` record. If the runtime fails before the agent can emit anything, the runtime may write a runtime-authored status record for the failure path so the parent still has a visible explanation. Runtime-authored status writes use the slot open/close helpers directly and bypass `checkAgentWrite` (the runtime is not an agent role). The slot version is authored, marked closed, and `latest` advances.

The reviewer does not produce a `status.md` record because it is a phase of `PlanningCardProcessorActor`, not a separately observed child process. The parent already observes the reviewer outcome through the planner-processor flow.

## Reviewer Evidence Gate

The current `validateReviewerAssessment` checks whether cited evidence cards have `artifacts.length > 0 || attachments.length > 0 || lifecycle.result`. That check is removed.

The new gate has two parts: currentness and cited evidence.

### Childless goals

If the goal card has no descendants, there is no work to assess. Review is skipped and the planner's `done` result is accepted directly. This matches the runtime fact that the planner produced no child work that could be cited.

### Reviewer currentness

When the reviewer starts, the runtime records the reviewed subtree's current state: card versions/statuses plus the latest closed record versions for the slots included in reviewer context. Before accepting `emit_reviewer_result`, the runtime compares that snapshot with the current tree.

If any relevant card version, status, or included record-slot latest version changed while the reviewer was running, the reviewer result is stale. The runtime does not accept the result; it relaunches the reviewer with fresh context or routes back through the planner if the change requires planner ownership. This keeps a reviewer pass tied to the exact work snapshot it assessed.

The currentness gate **subsumes** the existing notification-pending invalidation logic. If main-agent notifications arrive during review, that is a subtree change captured by the currentness snapshot. The standalone notification-pending check is removed in favor of this general version-stability gate.

### Cited evidence

The cited-evidence gate is:

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
- The descendant's record URLs (e.g., `record://status.md?v=3&card=card-7`) so the reviewer can `read` them

This lets the reviewer cite descendant cards that have real work products and read those products if needed. The reviewer reads descendant files by their `record://` URL; it writes its own review only to its runtime-declared `record://` URL.

This was already designed in `agent-tool-surfaces-and-information-flow.md` (section "Reviewer context — special case") but never implemented. The mandatory-output design depends on it being implemented now.

## File Tools For Reviewer And Planner

The reviewer and planner currently have no file-writing tools. All agents share the same file tools (`read`, `write`, `edit`, `apply_patch`, `glob`, `grep`), but path resolution and write enforcement are scheme-based and return normalized concrete URLs.

### Path resolution

| Scheme | Format | Resolves to |
|---|---|---|
| `record://{slot}.md?card={cardId}&v={version}` | Durable record slot URL | `.saivage/outputs/cards/{cardId}/{slot}/{version}.md` |
| `tmp://{cardId}/{relative}` | Per-card scratch URL | `.saivage/work/cards/{cardId}/tmp/{relative}` |
| `project://{relative}` | Project-relative path | `{projectRoot}/{relative}` |
| Absolute path `/...` | Same filesystem path | Same filesystem path |

The `record://` URL names a record slot plus optional `card` and `v` selectors. The runtime resolves it before the file tool touches the filesystem.

Read access:
- Any agent can read any **closed** `record://` URL from any card.
- The current card's role-designated agent may also **read its own open slot version** so that `edit` and `apply_patch` can modify the in-progress file within the same invocation.

Write access is restricted to the current card's role-designated slot and is allowed only for declared mandatory record files. File tools return the normalized concrete URL they resolved.

Repeated writes within a single invocation: `write`, `edit`, and `apply_patch` to the same `v=next` URL all operate on the same open file in that slot. A second `write` replaces the file content; `edit`/`apply_patch` modify it in place. The slot version is not closed until the terminal `emit_*` call accepts it.

The `tmp://` URL is card-scoped scratch. Any agent can read any `tmp://` URL, but writes are allowed only under `tmp://{currentCardId}/...`.

### Write enforcement

The file tool checks all three components of a `record://` write:

1. `card` must resolve to the current invocation's card.
2. `slot` must match the role's designated slot.
3. `v` must resolve to an open, unclosed slot version.

The reviewer can only write its declared `record://review.md?v=next` slot for the current card. Any other `record://` write or any `project://` write is hard-rejected. The planner and executor can write their declared record slot. Only the executor can write `project://` work products; the planner and reviewer coordinate through cards, records, and `tmp://` scratch.

This replaces the current advisory write-territory system with hard scheme-based enforcement in the file tools. No advisory warnings, no path-pattern territories.

## Validation And Repair Flow

```text
runtime invokes agent with mandatory record://{slot}.md?v=next URL(s) in prompt
agent writes mandatory file(s) using file tools with record:// scheme
file tool resolves and returns concrete record://{slot}.md?card=C&v=N URL(s)
agent calls terminal tool (emit_*_result)
runtime checks mandatory concrete record URL(s) exist and are non-empty
  if missing:
    append continuation message to same LLM session:
      "Required file record://{slot}.md?v=next was not created. Create it and call {terminal_tool} again."
    re-enter same agent (not a new session)
    if repair budget exhausted:
      fail activation with runtime diagnostic
  if present:
    for reviewer results, first check currentness:
      compare currentness snapshot with current subtree/record versions
      if anything changed during review, reject the result as stale
      discard the stale open review slot version without advancing latest
      relaunch reviewer with fresh context or route to planner
      if relaunch budget exhausted, fail activation with runtime diagnostic
    accept terminal result
    close the concrete slot version(s) in index.json
    proceed with role-specific evaluation (evidence gate, completion gates, etc.)
```

The repair uses the existing `LLMToolContinuationContextHook` seam — the same mechanism that injects notification context between tool result and next LLM turn. No new "repair event" framework.

Repair budget: 2 attempts by default. Configurable per card via card metadata if needed later.

Relaunch budget: 2 reviewer relaunch attempts by default. A missing-file repair is a same-session continuation (agent mistake); a currentness relaunch is a fresh reviewer invocation with updated context (runtime-driven). These are separate budgets. Repair budgets do not affect relaunch counts and vice versa.

## Persistence

The versioned output files ARE the persistent evidence. Each slot has a small `index.json` that tracks its open version and latest closed version. There is no separate `invocation.json` manifest, no card-global record counter, and no artifact registration records.

Because these files are persistent evidence, they are not stored in `.saivage-work/` or future `.saivage/work/`. That directory is disposable work state for shell command outputs, temporary process data, caches, and other rebuildable operational files. Generic work cleanup may delete `.saivage/work`, but it must not delete `.saivage/outputs`.

Each slot index is persisted next to the slot files:

```json
{
  "slot": "review",
  "latest": 2,
  "open": null,
  "versions": {
    "1": { "status": "closed", "closed_at": "..." },
    "2": { "status": "discarded", "discarded_at": "...", "reason": "stale_review" },
    "3": { "status": "open", "opened_at": "..." }
  }
}
```

When a write requests `v=next`, the runtime reads the slot index. If there is an open version, it returns that concrete URL. If there is no open version, it creates the next unused version number, marks it open, and returns the concrete URL. It marks the version closed only after a terminal `emit_*` call selects an existing non-empty file as the accepted record. A stale reviewer record is marked `discarded`, clears `open`, and does not advance `latest`; the next `v=next` write creates the next unused version number instead of reusing stale content. The files themselves are durable on disk under `.saivage/outputs/cards/{cardId}/{slot}/`.

## Crash Recovery

If the runtime crashes after opening a slot version but before the agent writes the file:

- The slot index may contain an open version whose file is empty or missing.
- `latest` has not advanced because the version is not closed.
- The next `v=next` write for that slot reuses the open version unless recovery closes or discards it explicitly.

If the runtime crashes after the agent writes the file but before validating or committing the terminal emit:

- The file exists on disk.
- On recovery, the processor actor's `activeReconstruction` record shows it was mid-activation.
- The existing recovery path either resumes or fails the activation. If it fails before terminal commit, the slot version remains open or is discarded by recovery. Only files selected by an accepted terminal emit and marked closed are part of the durable accepted-record sequence.

No special recovery logic is needed for output files beyond what the actor recovery path already does.

## What The Prompt Contains

Reviewer prompt:

```text
You are reviewing card {cardId}: {title}

{description}

Acceptance criteria:
{acceptance}

Descendant work:
{for each descendant: id, type, title, status, result summary, record URLs}

Assessment id: {assessmentId}

Write your review to:
record://review.md?v=next

Do not call emit_reviewer_result until the review file exists.
End by calling emit_reviewer_result with your assessment.
```

Planner prompt addition:

```text
Write your current invocation status to:
record://status.md?v=next

Do not call emit_planner_result until the status file exists.
```

Executor prompt addition:

```text
Write your current invocation status to:
record://status.md?v=next

Do not call emit_executor_result until the status file exists.
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

No `artifacts` array. No `attachments` array. No `lifecycle.result` check. No descendant record-file scan. Just: did the reviewer cite accepted cards from the reviewed subtree? The reviewer currentness check (subsection above) is performed by the processor before calling this gate; this function validates only cited evidence.

## API / UI

The operator UI and API expose:

- Card detail shows `.saivage/outputs/cards/{cardId}/` with record slots.
- Each slot shows its versions and `index.json` state.
- The UI can preview file contents.
- No `artifacts`/`attachments` projections.

This is simpler than the current artifacts/attachments UI.

## Implementation Plan

Status after commit `48d1c3af feat(runtime): enforce agent record slots`: Phases 1, 2, 4, 5, and 6 have their first implementation slice in place. Phase 3 is partially implemented. Phase 7 and broad docs/UI cleanup remain.

### Phase 1: Versioned record slots and path-scheme resolver - implemented

Implemented in `src/runtime/records/record-slots.ts` and `src/tools/project-file-tools.ts`:

1. Slot indexes live at `.saivage/outputs/cards/{cardId}/{slot}/index.json`.
2. `record://` writes with `v=next` create or reuse the open slot version and return normalized `record_url` values.
3. Closed/latest numeric reads work through the file tools.
4. `tmp://{cardId}/{relative}` resolves to `.saivage/work/cards/{cardId}/tmp/{relative}`.
5. `project://` and absolute project paths keep the existing project-file safety policy.
6. Stale/open record discard support exists through `discardOpenRecordSlot`, but reviewer currentness does not call it yet.
7. Focused tests cover open/reuse/close, discard without advancing `latest`, normalized record URLs, and role write enforcement.

Remaining follow-up:

1. Add recovery-focused tests for open slots after reconstructed activations.
2. Consider extracting the resolver/enforcer from `project-file-tools.ts` if it grows further; keep it inline until reuse demands it.

### Phase 2: Add scheme-enforced file tools - implemented

Implemented:

1. Planner and reviewer now receive `read`, `write`, `glob`, `grep`, and `edit`.
2. Executor now receives `read`, `write`, `glob`, `grep`, `edit`, and `apply_patch`, plus its existing process tools.
3. Planner/reviewer project writes are hard-rejected by role-aware file-tool context.
4. Reviewer can write only `review`; planner/executor can write only `status`.
5. `record://` file-tool responses include normalized `record_url`.
6. `glob` and `grep` can target `record://` trees without opening general `.saivage` access.

Remaining follow-up:

1. Add tests for `tmp://` writes and record `glob`/`grep` searches.
2. Add tests for owning-agent reads of an open record through `edit`/`read`.

### Phase 3: Reviewer mandatory output + descendant context - partially implemented

Implemented:

1. Childless goals skip review and accept planner `done` directly.
2. Reviewer prompt includes `record://review.md?v=next`.
3. Reviewer receives descendant context with id/type/status/title/result summary and latest closed descendant `status.md` record URL when available.
4. Reviewer can use file tools to read descendant records and write its review.
5. Missing `review.md` triggers same-session repair through `LLMActor.appendToolResult` continuation context.

Remaining follow-up:

1. Capture a reviewer currentness snapshot: reviewed subtree card versions/statuses plus latest closed record versions included in context.
2. Before accepting the reviewer result, compare the snapshot with current state.
3. On stale review, call `discardOpenRecordSlot(..., reason: 'stale_review')`, do not advance `latest`, and relaunch the reviewer with fresh context.
4. Replace the standalone notification-pending invalidation check with currentness. It still exists in `PlanningCardProcessorActor.reviewPlannerDone(...)` and must be removed only when currentness is wired.
5. Pass the normalized concrete review URL into planner correction context when reviewer returns `needs_corrections`.
6. Add focused actor tests for missing-review repair, stale-review relaunch/discard, childless review skip, budget exhaustion, and planner correction context.

### Phase 4: Replace evidence gate - implemented

Implemented in `src/runtime/reviewer-assessment.ts` and `src/runtime/actors/reviewer-terminal-evaluation.ts`:

1. Removed the artifact/attachment/lifecycle-result fallback from reviewer validation.
2. Reviewer evidence cards must exist, be descendants of the reviewed goal, and have status `done`.
3. The reviewed goal itself is no longer valid evidence for its own review.
4. Focused tests cover accepted descendants, missing cards, outside-subtree citations, non-accepted cards, and no evidence.

### Phase 5: Planner mandatory output - implemented

Implemented:

1. Planner prompt requires `record://status.md?v=next`.
2. Planner terminal acceptance closes `status.md`; missing/empty status triggers same-session repair with budget 2.
3. Planner gets scheme-aware file tools and can read reviewer records.

Remaining follow-up:

1. Add focused actor tests for missing status repair on `done`, `blocked`, and `continue` outcomes.
2. Add the normalized review URL to correction context once Phase 3 currentness/correction wiring is completed.

### Phase 6: Executor mandatory output - implemented

Implemented:

1. Executor prompt requires `record://status.md?v=next`.
2. Executor terminal acceptance closes `status.md`; missing/empty status triggers same-session repair with budget 2.
3. Executor keeps project-write tools and can write ordinary work files through `project://` or project paths.
4. Executor no longer appends artifact/attachment evidence refs during terminal acceptance.

Remaining follow-up:

1. Update existing terminal-processor actor tests so mock providers write status records before emitting terminal results.
2. Add focused actor tests for missing status repair on success and failure outcomes.

### Phase 7: Remove old mechanisms - partially implemented

Implemented:

1. Removed `appendExecutorEvidence` from `TerminalCardProcessorActor`.
2. Executor terminal acceptance no longer registers artifact/attachment evidence refs.
3. Reviewer validation no longer depends on artifacts, attachments, generated files, or lifecycle result fallback.

Remaining follow-up:

1. Remove `ArtifactRef`, `AttachmentRef` from `CardRecord`.
2. Remove `artifacts`, `attachments`, `generated_files` from executor terminal envelope and contract.
3. Remove `appendEvidenceRefs`, `registerEvidenceRefs`, `registerEvidenceRefsBestEffort`, `CardStore.appendEvidenceRefs`.
4. Remove `appendExecutorEvidence` from `TerminalCardProcessorActor`.
5. Remove `artifacts`/`attachments` from `PLANNER_ALLOWED_EDIT_FIELDS`.
6. Remove advisory write-territory warnings that always return `allowed: true`; either enforce or delete.
7. Update card creation to no longer initialize `artifacts: []`, `attachments: []`.
8. Update API/UI to show `.saivage/outputs/cards/{cardId}/` instead of artifacts/attachments.
9. Update older tests that still assert artifact/attachment preservation through executor terminal acceptance.
10. Tests: confirm no references to removed types; confirm card store still works; confirm executor no longer tries to register artifacts.

### Phase 8: Docs, prompt tests, and broad validation - remaining

1. Update `docs/spec/system-specification.md`: remove artifact/attachment language; add mandatory output file language.
2. Update `docs/architecture/system-architecture.md`: remove artifact/evidence-ref references; add versioned output directory.
3. Update `docs/architecture/agent-tool-surfaces-and-information-flow.md`: implement the reviewer descendant-summary design.
4. Add prompt tests asserting mandatory output paths appear in planner/reviewer/executor prompts.
5. Update existing tests that reference `artifacts`/`attachments`/`appendEvidenceRefs` or mock terminal emits without mandatory record writes.
6. Run broad actor/runtime Jest after legacy tests are updated.

## Scope Of Change

When complete, this removes more code than it adds:

**Removed so far:**
- `appendExecutorEvidence` in terminal processor.
- `validateReviewerAssessment`'s artifact/attachment/lifecycle-result fallback.

**Still to remove:**
- `ArtifactRef`, `AttachmentRef` types and all their usage.
- `appendEvidenceRefs`, `registerEvidenceRefs`, `registerEvidenceRefsBestEffort`.
- Executor envelope `artifacts`, `attachments`, `generated_files` fields.
- Advisory write-territory warnings and any remaining dead references.
- Artifacts/attachments UI projections.

**Added so far:**
- Per-slot `index.json` files with `latest`, `open`, and version status.
- Record slot open/close/discard helpers.
- Scheme-aware file tool resolution and write enforcement.
- Versioned directory creation.
- Mandatory file-existence checks after terminal tool calls.
- Same-session repair via existing continuation hook.
- Reviewer descendant summary context message with `record://` URLs.
- Mandatory per-invocation `status.md` records for planner and executor outcomes, including failures.
- Cross-agent record references via normalized concrete `record://{slot}.md?card={cardId}&v={version}` URLs.
- Shared file tools with strict scheme enforcement: mandatory `record://` writes only, current-card `tmp://` scratch writes, no discretionary `.saivage/` writes.

**Still to add:**
- Reviewer currentness snapshot and relaunch when reviewed versions change during review.
- `.saivage/outputs/cards/{cardId}/` UI projection.

**Net target:** fewer evidence types, fewer soft gates, fewer advisory layers. One new slot-directory convention, small per-slot indexes, and hard file-existence checks.

## Conclusion

The current codebase has soft mechanisms that failed closed. The fix is not to add more mechanisms; it is to replace soft controls with hard contracts: mandatory record files, hard existence checks, same-agent repair via existing seams, per-invocation status records for parent observability, and reviewer gates that reject stale reviews when the assessed versions changed during review.

Record files are addressed by normalized concrete `record://{slot}.md?card={cardId}&v={version}` URLs that any agent can read and pass to other agents. Record writes are slot-enforced: only the current card, only the role's declared slot, only an open version. Discretionary writes go only to `tmp://{currentCardId}/...`. Symbolic URLs are resolved by file tools, and tool responses include the normalized concrete URL to cite later.

No `ArtifactRef`. No `appendEvidenceRefs`. No `registerEvidenceRefsBestEffort`. No `generated_files` tracking. No advisory write territories. No `invocation.json` manifest. No artifact registration step. The closed slot version existing at the normalized concrete URL is the evidence.
