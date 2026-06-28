# Agent Invocation Output Slots

Status: design proposal.

## Problem

The current runtime lets agents decide how to represent durable evidence. Executors can return `artifacts` and `attachments` in their terminal envelope. Reviewers cite `evidence_card_ids`. Planners may describe evidence in card prose. The runtime then tries to validate whether enough durable evidence exists.

That model is too flexible. It lets important evidence live only in prompt text, agent prose, or generated repository files that are not bound to the invocation that required them. The current GetRich v2 card-1 blockage is an example: durable evidence files exist on disk, and the reviewer can emit `pass`, but the card has no structured artifacts/attachments at the point the review gate checks them. The runtime keeps rejecting the pass with `Reviewer cited card 'card-1' without durable result, artifact, or attachment evidence.`

The core issue is not that the reviewer needs more discretion. The issue is that the runtime did not declare concrete output files before the agent ran and did not validate those required files as part of the same invocation contract.

## Design Principle

Every agent invocation must have a runtime-created private directory and a runtime-declared output manifest.

The agent receives exact output paths in its prompt. If the runtime requires a particular result, report, evidence package, or review, the runtime must tell the agent the exact file path before the invocation starts. The agent must write that file before calling its terminal tool.

The runtime validates those files after the terminal tool call. If required files are missing or invalid, the runtime re-enters the same agent session with a specific repair event. It must not immediately hand the issue to another role unless the same-role repair budget is exhausted or the defect belongs to another role.

For reviewer output failures, the reviewer fixes the reviewer output. The planner is not called merely because the reviewer forgot to write the required review file.

## Goals

- Make durable outputs explicit, file-backed, and runtime-addressable.
- Remove implicit evidence discovery from agent prose.
- Make missing output files a same-agent repairable error.
- Give reviewers deterministic required review paths.
- Preserve role ownership: reviewer fixes review-output defects, planner fixes plan/evidence defects, executor fixes delivery-output defects.
- Keep output files under project-local `.saivage-work/`, not global state.
- Let runtime automatically register required output files as card evidence where appropriate.

## Non-Goals

- Do not make reviewers perform planner or executor work.
- Do not let agents invent arbitrary evidence locations and expect the runtime to discover them.
- Do not expose raw actor internals through the API/UI.
- Do not preserve compatibility shims for old evidence behavior unless needed for existing persisted active work.
- Do not create a broad, open-ended `register_evidence` tool as the primary mechanism. Registration should be runtime-owned from declared output slots.

## Terminology

| Term | Meaning |
|---|---|
| Invocation | One admitted agent run or continuation turn series for a role/card/assessment. |
| Invocation directory | Runtime-created private directory for that invocation. |
| Output slot | A named required or optional file path declared by the runtime before invocation. |
| Output manifest | JSON file describing slots, schemas, validation rules, and ownership. |
| Terminal tool | Role-specific completion tool such as `emit_planner_result`, `emit_executor_result`, or `emit_reviewer_result`. |
| Repair event | Same-session model-visible event that tells the agent why its terminal output was rejected and what file(s) to fix. |

## Directory Layout

All invocation output lives under `.saivage-work/cards/{cardId}/invocations/{invocationId}/`.

Example:

```text
.saivage-work/cards/card-1/invocations/reviewer-assessment-card-1-2/
  invocation.json
  outputs/
    review.md
    review-result.json
  logs/
    validation-errors.jsonl
```

Planner example:

```text
.saivage-work/cards/card-1/invocations/planner-card-1-20260628T123000Z/
  invocation.json
  outputs/
    plan-summary.md
    completion-evidence.md
    planner-result.json
```

Executor example:

```text
.saivage-work/cards/card-42/invocations/executor-card-42-20260628T123500Z/
  invocation.json
  outputs/
    executor-result.json
    command-log.md
    artifacts/
      generated-report.md
```

The invocation ID must be stable enough for recovery and unique enough to avoid collisions. Suggested formats:

| Role | Invocation ID |
|---|---|
| Planner | `planner-{cardId}-{activationId}` |
| Executor | `executor-{cardId}-{activationId}` |
| Reviewer | `reviewer-{assessmentId}` |

If activation IDs are not available in the micro-actor path yet, use the processor's deterministic session ID plus a monotonic invocation sequence persisted in actor state.

## Output Manifest

Each invocation directory contains `invocation.json`.

Example:

```json
{
  "version": 1,
  "invocation_id": "reviewer-assessment-card-1-2",
  "card_id": "card-1",
  "role": "reviewer",
  "session_id": "reviewer:card-1:assessment-card-1-2",
  "assessment_id": "assessment-card-1-2",
  "created_at": "2026-06-28T12:30:00.000Z",
  "output_dir": ".saivage-work/cards/card-1/invocations/reviewer-assessment-card-1-2/outputs",
  "slots": [
    {
      "name": "review_markdown",
      "path": ".saivage-work/cards/card-1/invocations/reviewer-assessment-card-1-2/outputs/review.md",
      "required": true,
      "kind": "review_report",
      "mime": "text/markdown",
      "register_as": "artifact",
      "artifact_type": "report",
      "description": "Human-readable reviewer assessment."
    },
    {
      "name": "review_result_json",
      "path": ".saivage-work/cards/card-1/invocations/reviewer-assessment-card-1-2/outputs/review-result.json",
      "required": true,
      "kind": "review_result",
      "mime": "application/json",
      "schema": "reviewer-result.v1",
      "register_as": "artifact",
      "artifact_type": "report",
      "description": "Machine-readable reviewer result matching the terminal reviewer envelope."
    }
  ],
  "repair": {
    "max_attempts": 2,
    "same_session": true
  }
}
```

Slot fields:

| Field | Meaning |
|---|---|
| `name` | Stable slot identifier referenced in prompts and validation errors. |
| `path` | Exact path the agent must write. |
| `required` | Missing file blocks terminal acceptance. |
| `kind` | Runtime semantic kind. |
| `mime` | Expected MIME/content type. |
| `schema` | Optional JSON/schema validator. |
| `register_as` | Whether runtime should register the file as a card `artifact`, `attachment`, or neither. |
| `artifact_type` | ArtifactRef `type` when `register_as = artifact`. |
| `description` | Human-readable purpose for prompts and UI. |

## Role-Specific Required Outputs

### Planner

Planner invocations should receive output slots for planning and completion evidence.

Default planner slots:

| Slot | Required When | Purpose |
|---|---|---|
| `planner_result_json` | Always | Machine-readable mirror of `emit_planner_result`. |
| `plan_summary_md` | On non-trivial goal activations | Durable reasoning summary for the planning diary. |
| `completion_evidence_md` | Before reporting `done` | Summary of evidence cards/files used to justify `done`. |

The planner prompt must say:

```text
Your private invocation output directory is:
<INVOCATION_OUTPUT_DIR>

Before calling emit_planner_result, write required output files exactly at these paths:
- planner_result_json: <PATH>
- plan_summary_md: <PATH>
- completion_evidence_md: <PATH> (required if reporting done)

If you report done, completion_evidence_md must list the cards and files that prove acceptance criteria are satisfied.
```

Planner validation:

- `planner_result_json` must exist and agree with `emit_planner_result`.
- If planner reports `done`, required evidence summary slots must exist.
- Planner `done` still goes through descendant completion gates and reviewer assessment.

### Executor

Executor invocations already have the strongest evidence path because executor terminal envelopes include `artifacts`, `attachments`, and `generated_files`. The new design makes this explicit by adding output slots.

Default executor slots:

| Slot | Required When | Purpose |
|---|---|---|
| `executor_result_json` | Always | Machine-readable mirror of `emit_executor_result`. |
| `command_log_md` | When commands/processes are run | Summary of commands, outputs, failures, and verification. |
| `artifact_files` | As specified by card type | Runtime-declared expected artifact paths. |

Executor validation:

- `executor_result_json` must exist and agree with `emit_executor_result`.
- Declared artifact files must exist.
- Files listed in the executor terminal envelope must either be declared output slots or be inside the invocation output directory.
- Runtime registers declared output files as evidence using `appendEvidenceRefs`.

### Reviewer

Reviewer invocations must always receive required review output slots. The reviewer should not be allowed to finish with only a terminal tool call.

Default reviewer slots:

| Slot | Required | Purpose |
|---|---|---|
| `review_markdown` | yes | Human-readable assessment and rationale. |
| `review_result_json` | yes | Machine-readable result matching `emit_reviewer_result`. |

Reviewer prompt must say:

```text
Your private invocation output directory is:
<INVOCATION_OUTPUT_DIR>

You must write your human-readable review to:
<REVIEW_MARKDOWN_PATH>

You must write your machine-readable review result to:
<REVIEW_RESULT_JSON_PATH>

Do not call emit_reviewer_result until both files exist.
The JSON file must match the same assessment you pass to emit_reviewer_result.
```

Reviewer validation:

- `review_markdown` exists and is non-empty.
- `review_result_json` exists and parses as reviewer result schema.
- `review_result_json.assessment` matches the `emit_reviewer_result` tool payload.
- `evidence_card_ids` cite existing cards.
- Cited evidence cards have accepted result or registered artifacts/attachments according to the evidence policy.

If the reviewer emits `pass` but required review files are missing, the runtime must re-enter the same reviewer session with a repair event. It must not immediately block the goal or call the planner for a reviewer-output defect.

## Repair Events

Validation failures are classified by ownership.

| Failure | Owner | Repair Target |
|---|---|---|
| Required reviewer file missing | reviewer | Same reviewer session. |
| Reviewer JSON malformed | reviewer | Same reviewer session. |
| Reviewer cites missing/non-evidenced card | reviewer first, then planner if repeated | Reviewer should correct citation; if the evidence really does not exist, emit `needs_corrections` for planner. |
| Planner result file missing | planner | Same planner session. |
| Executor artifact missing | executor | Same executor session. |
| Descendant incomplete | planner | Parent planner. |
| Runtime cannot validate due to platform bug | runtime | Error diagnostic, not agent correction. |

Repair event shape:

```json
{
  "kind": "required_output_repair",
  "role": "reviewer",
  "card_id": "card-1",
  "session_id": "reviewer:card-1:assessment-card-1-2",
  "invocation_id": "reviewer-assessment-card-1-2",
  "attempt": 1,
  "max_attempts": 2,
  "errors": [
    {
      "slot": "review_markdown",
      "path": ".saivage-work/cards/card-1/invocations/reviewer-assessment-card-1-2/outputs/review.md",
      "code": "missing_required_output",
      "message": "Required review file was not created."
    }
  ],
  "instruction": "Create or fix the required output files at the exact paths, then call emit_reviewer_result again."
}
```

The repair event is appended as model-visible context to the same LLM actor, then the runtime admits another reviewer turn. Repair attempts must be bounded.

## Evidence Registration Policy

Runtime-owned registration replaces open-ended agent discretion.

When a required output slot has `register_as = artifact` or `attachment`, the runtime registers it on the invocation's owning card after validation succeeds.

Registration uses the existing `CardStore.appendEvidenceRefs` path. The runtime constructs refs from slot metadata:

```json
{
  "path": ".saivage-work/cards/card-1/invocations/reviewer-assessment-card-1-2/outputs/review.md",
  "type": "report",
  "description": "Human-readable reviewer assessment.",
  "retain": true,
  "created_at": "..."
}
```

Rules:

- Agents write files; runtime registers validated declared slots.
- Agents may not claim arbitrary paths as durable evidence unless those paths are declared slots or the tool explicitly imports them into the invocation directory.
- Reviewer output files are registered on the reviewed goal card after review validation.
- Executor output files are registered on the executor card after executor validation.
- Planner evidence summaries are registered on the planner goal card after planner validation.

## Tool Surface Implications

The earlier idea "planners should be able to use any tool available to executors" should be implemented as shared non-terminal capabilities, not shared terminal contracts.

| Capability | Planner | Executor | Reviewer |
|---|---:|---:|---:|
| Read project files | yes | yes | yes |
| Search project files | yes | yes | yes |
| Write declared invocation outputs | yes | yes | yes |
| Write arbitrary project files | limited | yes | no |
| Run project commands/processes | limited | yes | no by default |
| Create/activate child cards | yes | no | no |
| Register evidence manually | no by default | no by default | no |
| Terminal result tool | planner-only | executor-only | reviewer-only |

The preferred evidence path is not a manual `register_evidence` tool. It is:

1. Runtime declares output slots.
2. Agent writes required files.
3. Runtime validates files.
4. Runtime registers slot files as evidence.

Manual evidence import may exist later for exceptional cases, but it should not be the normal path.

## Reviewer Flow

Current simplified reviewer flow:

```text
planner emits done
runtime invokes reviewer
reviewer emits pass/needs_corrections
runtime validates reviewer assessment
runtime accepts pass or returns correction to planner
```

New flow:

```text
planner emits done
runtime creates reviewer invocation directory and output manifest
runtime invokes reviewer with required file paths
reviewer writes review.md and review-result.json
reviewer emits pass/needs_corrections
runtime validates required reviewer files
  if reviewer files are missing/invalid:
    append repair event to same reviewer session
    reviewer fixes files and emits again
  else:
    validate evidence_card_ids and card evidence
      if citation/evidence policy fails due to reviewer citation mistake:
        repair same reviewer session if retry budget remains
      if evidence truly missing from planner/executor work:
        convert to reviewer needs_corrections for planner
      if valid pass:
        register reviewer output files as artifacts
        accept reviewer_pass
```

The distinction matters:

- Missing `review.md` is a reviewer-output defect. Reviewer fixes it.
- Bad `evidence_card_ids` caused by reviewer citing the wrong card is a reviewer-output defect. Reviewer fixes it.
- Real missing evidence from completed work is a planner/executor defect. Planner fixes it.

## Validation Gate Algorithm

Pseudo-code:

```ts
async function evaluateReviewerInvocation(input) {
  const toolResult = verifyTerminalToolOutcome(reviewerContract, input.outcome);
  const assessment = buildReviewAssessment(toolResult, input.assessmentId, input.sessionId, input.card.id);

  const outputValidation = validateInvocationOutputs(input.invocationManifest, {
    expectedRole: 'reviewer',
    terminalPayload: toolResult,
  });

  if (!outputValidation.valid) {
    if (input.repairAttempt < input.maxRepairAttempts) {
      return sameAgentRepair('reviewer', outputValidation.errors);
    }
    return reviewerFailure('Reviewer did not create required output files.', outputValidation.errors);
  }

  const evidenceValidation = validateReviewerAssessment({
    goalId: input.card.id,
    assessment,
    candidatePlannerResult: input.candidatePlanning,
    readCard: input.store.read,
  });

  if (!evidenceValidation.valid) {
    if (isReviewerFixableCitationError(evidenceValidation) && input.repairAttempt < input.maxRepairAttempts) {
      return sameAgentRepair('reviewer', [evidenceValidation]);
    }
    return correctionOutcome(input.assessmentId, evidenceValidation.reason);
  }

  if (assessment.result === 'needs_corrections') {
    return correctionOutcome(input.assessmentId, assessment.summary, assessment.issues);
  }

  registerValidatedOutputSlots(input.invocationManifest, input.card.id, input.store);
  return reviewerPass(assessment);
}
```

## Prompt Requirements

Prompt builders must include an invocation-output section.

Reviewer prompt section:

```text
Required output files:

1. Human-readable review:
   Path: <review_markdown.path>
   Requirements: Markdown, non-empty, summarize acceptance, evidence, and decision.

2. Machine-readable review result:
   Path: <review_result_json.path>
   Requirements: JSON matching reviewer-result.v1. It must match your emit_reviewer_result payload.

You must create these files before calling emit_reviewer_result.
If the runtime returns a required_output_repair event, fix the listed files and call emit_reviewer_result again.
```

Planner prompt section:

```text
Required output files:
<slot list>

Before reporting done, ensure required planner outputs exist. If reviewer feedback says evidence is missing, create or activate work to produce concrete files and ensure they are present in the declared output slots or descendant card outputs.
```

Executor prompt section:

```text
Required output files:
<slot list>

Write generated reports/logs/artifacts into the declared paths. Your emit_executor_result must reference those files.
```

## API And UI Projection

Operator APIs should expose invocation output read models, not raw actor internals.

Useful read models:

| Projection | Purpose |
|---|---|
| Invocation list for card | Shows planner/executor/reviewer attempts. |
| Invocation detail | Shows output slots, validation status, and repair attempts. |
| Output file preview | Lets operator inspect required files. |
| Validation errors | Explains missing/invalid outputs. |

These projections should point to files, not embed large file contents by default.

## Migration / Compatibility

No broad compatibility shim is required. This is a forward-looking runtime contract.

For existing blocked cards like GetRich v2 card-1:

- The next activation should create fresh invocation output slots.
- The reviewer should be invoked with explicit review output paths.
- The planner should be instructed to ensure evidence files are produced under declared slots or descendant invocation outputs.
- Existing ad-hoc evidence files can be copied/imported into a declared invocation output path by an executor/planner task, not silently discovered.

## Implementation Plan

### Phase 1: Data Model

1. Add invocation manifest types under `src/runtime/actors/invocation-outputs.ts` or `src/runtime/invocation-outputs.ts`:
   - `InvocationOutputManifest`
   - `InvocationOutputSlot`
   - `InvocationOutputValidationError`
   - `InvocationRepairEvent`
2. Add path builder helpers:
   - `invocationRoot(projectRoot, cardId, invocationId)`
   - `invocationOutputPath(...)`
   - `writeInvocationManifest(...)`
   - `readInvocationManifest(...)`
3. Use project-local `.saivage-work/cards/{cardId}/invocations/{invocationId}/` only.

### Phase 2: Output Validation

1. Implement `validateInvocationOutputs(manifest, terminalPayload)`:
   - required file exists;
   - non-empty where required;
   - JSON parses where `schema` is set;
   - reviewer JSON agrees with `emit_reviewer_result`;
   - executor JSON agrees with `emit_executor_result`;
   - planner JSON agrees with `emit_planner_result`.
2. Implement `registerValidatedOutputSlots(manifest, cardId, store)` using `appendEvidenceRefs`.
3. Add focused unit tests for missing file, malformed JSON, mismatch, and successful registration.

### Phase 3: Reviewer Integration

1. In `PlanningCardProcessorActor.reviewPlannerDone(...)`, create a reviewer invocation manifest before `llm.turn(...)`.
2. Pass output paths into `buildReviewerLlmInput(...)` and `reviewerPrompt(...)`.
3. After reviewer terminal tool call, validate output slots before evidence-card validation.
4. If reviewer output validation fails, continue the same reviewer LLM session with a `required_output_repair` context message.
5. Bound repair attempts. On exhaustion, return a reviewer failure/block with clear runtime diagnostics.
6. Register valid reviewer output slots as artifacts on the reviewed goal card.

### Phase 4: Planner Integration

1. Create planner invocation manifests in `PlanningCardProcessorActor.runActivation(...)`.
2. Pass planner output slots to `plannerPrompt(...)`.
3. Validate planner output files before accepting `emit_planner_result`.
4. If planner output files are missing, repair the same planner session.
5. Register planner output slots as goal-card artifacts where configured.

### Phase 5: Executor Integration

1. Create executor invocation manifests in `TerminalCardProcessorActor` activation.
2. Pass executor output slots to executor prompt.
3. Keep existing executor terminal `artifacts`/`attachments` support initially.
4. Validate declared executor outputs and auto-register slot files.
5. Later simplify executor evidence handling by making declared output slots the preferred artifact path.

### Phase 6: Shared Non-Terminal Tools

1. Expand planner tool surface to include executor-like non-terminal tools where safe:
   - file read/search;
   - writing declared invocation output files;
   - limited command execution if needed for planning/evidence tasks.
2. Keep terminal tools role-specific.
3. Add write-territory enforcement so planners/reviewers can write only declared output paths unless explicitly granted more.

### Phase 7: UI/API Projection

1. Add read model for invocation outputs.
2. Add API route for card invocation list/detail.
3. Add UI projection for required output files and validation errors.
4. Keep mutations through Analyst/runtime only.

### Phase 8: Documentation And Prompt Tests

1. Update `docs/spec/system-specification.md` with invocation output slots.
2. Update `docs/architecture/system-architecture.md` with invocation output ownership.
3. Update role prompt tests to assert required output paths appear in planner/reviewer/executor prompts.
4. Add runtime tests:
   - reviewer missing review file re-enters reviewer;
   - reviewer malformed result JSON re-enters reviewer;
   - reviewer valid files + pass registers artifacts and returns done;
   - evidence-card validation failure from real missing planner evidence returns correction to planner;
   - planner missing output repairs planner;
   - executor required artifact slot registers evidence.

## Open Questions

1. Should reviewer `review_result_json` be authoritative, or should the terminal tool payload remain authoritative with JSON only as durable mirror? Initial recommendation: terminal tool remains authoritative, JSON must match it.
2. Should review markdown be registered as an artifact on every pass and needs-corrections result? Initial recommendation: yes; both are useful evidence.
3. How many same-agent repair attempts should be allowed? Initial recommendation: 2 for reviewer output files, 2 for planner output files, 1 for executor output files unless card metadata overrides.
4. Should planners have command execution? Initial recommendation: yes, but limited and audited; terminal delivery work remains executor-owned.
5. Should existing files outside the invocation directory be importable? Initial recommendation: yes, but only by copying them into a declared output slot or by a runtime-owned import helper.

## Conclusion

The runtime should stop relying on agents to invent evidence structure. It should declare output slots before every invocation, require agents to write exact files, validate those files before accepting terminal tools, and repair missing/invalid outputs with the same agent that owns them.

For reviewers, this means missing review files are fixed by the reviewer, not by the planner. For real missing implementation evidence, the reviewer returns corrections and the planner/executor produce the missing files through their own invocation output slots. This gives the system a deterministic evidence path while preserving role ownership.
