# Terminal commit layer

This document proposes a redesign of the Saivage v3 runtime layer that commits terminal agent outcomes to durable card, runtime-run, activation, review, and event state.

The design is motivated by a class of observed inconsistencies where a card can be marked `done` while still carrying stale failure data, claiming project files that do not exist, or causing reviewer/runtime state to diverge from the committed work. The immediate guardrails (generated-file validation on executor completion, stale-error clearing on reviewer pass) are correct as far as they go, but the architectural fix is to give phase handlers thinner, validated commit boundaries rather than letting each one freely assemble durable card patches.

## Problem statement

Current runtime code has a status transition machine, but terminal semantics are spread across phase handlers and storage helpers.

- `src/runtime/state-machine.ts` validates status transitions, but it does not own the meaning of `done`, `failed`, `blocked`, or `needs_verification`.
- Executor completion currently combines status transitions, result merging, evidence registration, activation unwind, runtime diagnostics, and failure event emission across `src/runtime/executor-activation-dispatcher.ts`, `src/runtime/phases/executor-completion-handler.ts`, and `src/runtime/phases/executor-evidence.ts`.
- Reviewer completion currently validates cited evidence, persists a review assessment, transitions the goal card, updates the goal result, appends activation unwind results, transitions runtime state, and emits completion events across `src/runtime/phases/reviewer-assessment-handler.ts`, `src/runtime/phases/reviewer-phase.ts`, and `src/runtime/reviewer-assessment.ts`.
- Planner completion and blockage paths can write planning state, error state, created-card references, updated-card references, and status text independently of executor/reviewer terminal semantics.
- Card mutation rules in `src/cards/lifecycle.ts` allow many terminal-card metadata fields to be patched after terminal status, so storage-level legality is not the same as semantic consistency.
- Runtime-run and activation ledgers have their own lifecycle and can drift from card status if terminal handling returns early, fails after a partial mutation, or accepts an invalid agent envelope.

The result is a weak boundary between agent output and durable truth. Individual phase handlers can each make locally reasonable updates that combine into an invalid global state.

## Design goals

- Make terminal state semantic, not only a status string.
- Validate terminal claims before a card transitions to a terminal status.
- Keep phase handlers as the semantic owners of their domain, but route their durable mutations through shared, validated commit functions instead of free-form `Partial<CardRecord>` patches.
- Keep the state machine as the single authority for status transitions.
- Make common invariants easy to test without repeating integration scaffolding for every phase.
- Preserve JSON and JSONL storage; this proposal does not introduce a database or alternate persistence layer.

## Non-goals

- A monolithic committer that owns card status, runtime runs, activations, review state, events, and diagnostics simultaneously. That concentrates every domain in one type and makes the commit boundary the new god object.
- True atomic cross-file transactions. JSON storage cannot provide them; this design acknowledges partial writes and uses deterministic commit ordering and recovery instead.
- Rewriting the scheduler, event bus, server API, or card store in the same step.
- Changing the durable card JSON schema before the commit boundary exists.
- Adding backward compatibility adapters for old malformed runtime state beyond explicit recovery code.
- Making reviewer LLMs responsible for filesystem or ledger truth.
- Using prompts as the primary correctness mechanism.

## Architecture: validated phase handlers, not a central committer

The proposed architecture keeps phase handlers as the semantic owners of their domain. Each handler produces a typed `PhaseOutcome` and calls shared validation and mutation functions instead of building its own `Partial<CardRecord>` patches.

```text
Agent output
  -> contract parser
  -> PhaseOutcome projection
  -> shared semantic validators
  -> shared mutation functions
  -> state machine status transition
  -> events / diagnostics
```

Phase handlers remain responsible for their domain logic (an executor knows what `succeeded` vs `failed` means, a reviewer knows what `pass` vs `needs_corrections` means), but they delegate three things:

1. **Semantic validation** to shared pure functions that check facts the LLM cannot verify (file existence, path safety, stale error clearing, evidence completeness).
2. **Durable mutation** to shared commit functions that apply the canonical card patch, runtime run update, activation update, and event emission in a consistent order.
3. **Status transition** to the existing state machine, which remains the single authority for allowed status moves.

This avoids the central-committer antipattern because:
- No single type owns every domain's mutations.
- Phase handlers still decide what their outcomes mean.
- The state machine still decides which status transitions are legal.
- Validators are pure functions that any phase can call or any test can exercise.
- Commit functions are small, domain-specific, and composable.

## Core abstractions

### Phase outcome

`PhaseOutcome` is the normalized domain-level result of an agent phase. It is not a card patch and does not contain storage-specific merge behavior.

```ts
type PhaseOutcome =
  | ExecutorPhaseOutcome
  | ReviewerPhaseOutcome
  | PlannerPhaseOutcome;

type ExecutorPhaseOutcome =
  | {
      role: 'executor';
      kind: 'succeeded';
      cardId: string;
      goalId: string;
      summary: string;
      statusText: string;
      result: Record<string, unknown>;
      generatedFiles: string[];
      processEvidence: ProcessEvidenceClaim[];
      acceptedAt: string;
      sessionId: string | null;
    }
  | {
      role: 'executor';
      kind: 'failed';
      cardId: string;
      goalId: string;
      summary: string;
      statusText: string;
      error: string;
      partialResult: Record<string, unknown> | null;
      acceptedAt: string;
      sessionId: string | null;
    }
  | {
      role: 'executor';
      kind: 'needs_verification';
      cardId: string;
      goalId: string;
      reason: string;
      preservedResult: Record<string, unknown>;
      acceptedAt: string;
      sessionId: string | null;
    };
```

`kind: 'succeeded'` is a claim, not a commit. It becomes `status: 'done'` only if semantic validators pass.

### Semantic validators

Shared pure functions that check facts an LLM cannot verify. Each validator returns a structured result that the phase handler uses to decide how to proceed.

```ts
interface GeneratedFileValidation {
  valid: string[];
  missing: string[];
  unsafe: string[];
}

function validateGeneratedFiles(projectRoot: string, claims: string[]): GeneratedFileValidation;

interface StaleErrorCheck {
  hasStaleError: boolean;
  hasStaleBlockage: boolean;
}

function checkStaleTerminalState(card: CardRecord): StaleErrorCheck;

interface EvidenceCompleteness {
  semanticallyComplete: boolean;
  reasons: string[];
}

function validateEvidenceCompleteness(
  card: CardRecord,
  readCard: (id: string) => CardRecord | null,
): EvidenceCompleteness;
```

Validators do not write state, transition cards, or emit events. They answer questions.

### Shared mutation functions

Small, domain-specific functions that apply canonical patches to cards, runtime runs, activations, and events. Each function handles one well-scoped mutation and is called in a deterministic order by the phase handler that owns the terminal outcome.

```ts
function commitExecutorSuccess(context: ExecutorCommitContext): ExecutorCommitReceipt;
function commitExecutorFailure(context: ExecutorFailureContext): ExecutorCommitReceipt;
function commitExecutorParkedVerification(context: ExecutorParkContext): ExecutorCommitReceipt;
function commitReviewerPass(context: ReviewerPassContext): ReviewerCommitReceipt;
function commitReviewerCorrection(context: ReviewerCorrectionContext): ReviewerCommitReceipt;
function commitPlannerDone(context: PlannerDoneContext): PlannerCommitReceipt;
function commitPlannerBlocked(context: PlannerBlockedContext): PlannerCommitReceipt;
```

Each commit function:
1. Validates its preconditions (the card can transition, the outcome is semantically sound).
2. Calls `stateMachine.transitionCard()` for the status change.
3. Applies the canonical card patch (result, error, completed_at, status_text).
4. Updates runtime run and activation records.
5. Persists review assessment if applicable.
6. Appends planner tool result or activation unwind output.
7. Emits events and diagnostics.

The order is deterministic for each commit function, but different commit functions handle different domains. No single function owns all domains.

### Phase outcome projection

Each phase handler has a projection function that converts raw agent contract output into a `PhaseOutcome`. The projection is a pure transformation that does not write state.

```ts
function projectExecutorResult(contractOutput: ExecutorResult): ExecutorPhaseOutcome;
function projectReviewerResult(contractOutput: ReviewerResult): ReviewerPhaseOutcome;
function projectPlannerResult(contractOutput: PlannerResult): PlannerPhaseOutcome;
```

These replace the current patch-builder functions (`buildExecutorCompletionPatch`, `buildReviewerPassCompletionPatch`, etc.).

## Terminal semantics by phase

### Executor success

An executor success can commit `done` only when all semantic validators pass.

- `error` is set to `null`.
- `completed_at` is set if missing.
- `result.executor` stores the agent-provided result.
- `result.generated_files` is normalized and verified against the workspace.
- Stale `parse_failure`, `evidence_registration_failures`, or active blockage markers must not remain as active completion facts.
- The child activation is completed with outcome `done`.
- The child runtime run is completed with result `done`.
- A `card_completed` or equivalent durable event is emitted.

If a generated file claim is missing or unsafe, the outcome is downgraded to failure or `needs_verification` according to policy. The existing guard converts it to failure through evidence-registration failure semantics; this proposal makes that policy explicit and testable.

### Executor failure

- `error` is required and non-empty.
- `completed_at` is set if missing.
- Partial result may be retained under a non-success field.
- The child activation completes with outcome `failed`.
- The parent planner receives a tool result that clearly reports failure.

### Executor needs verification

- `error` explains why verification is required.
- `completed_at` remains unset unless the state is considered terminal for runtime scheduling.
- Preserved evidence is explicitly marked as untrusted or fallback-derived.
- Activation parks rather than reporting `done` to the parent planner.

### Reviewer pass

- The goal card transitions to `done` if not already done.
- `error` is set to `null`.
- `completed_at` is set if missing.
- `result.planning.status` becomes `done`.
- Any previous active planning blockage is cleared from active fields.
- The review assessment is persisted with its evidence IDs.
- Evidence cards are validated for semantic completeness, not just existence and status.
- Root project run completion happens only when the reviewed goal is the project card and root completion invariants pass.

### Reviewer needs corrections

- The assessment is persisted as a failed review.
- The goal remains available for planner correction.
- Runtime transitions back to planner phase.
- No activation reports `done` to a parent planner.

### Planner done

- If the goal has terminal child cards, reviewer should be scheduled before final goal completion.
- Created and updated child cards are committed through planner result application before terminal planner state changes.
- Planner blockage clears only when a valid resumed or completed planner outcome supersedes it.

### Planner blocked

- `error` matches the active blocked reason.
- `status_text` is operator-readable.
- Runtime run is blocked or idle according to whether retry is scheduled.
- Reviewer pass or executor success must not preserve active planner blockage markers.

## Required code changes

### Phase outcome types

Add `src/runtime/terminal-commit/outcomes.ts` defining `PhaseOutcome` variants and `PlannerPhaseOutcome`, `ReviewerPhaseOutcome` types.

### Semantic validators

Add `src/runtime/terminal-commit/validators.ts` with:

- `validateGeneratedFiles` — already partially implemented in `src/runtime/phases/executor-evidence.ts`, extract and extend.
- `checkStaleTerminalState` — detect stale `error`, `result.planning.status: 'blocked'`, `result.parse_failure`, `result.evidence_registration_failures` on cards about to become `done`.
- `validateEvidenceCompleteness` — extend `src/runtime/reviewer-assessment.ts` `validateReviewerAssessment` to check that cited cards have valid generated files and are not carrying stale failure markers.

Phase handlers call these validators and use the results to decide whether to proceed, downgrade, or park.

### Shared mutation functions

Add `src/runtime/terminal-commit/commit-executor.ts`, `commit-reviewer.ts`, `commit-planner.ts` with the commit functions listed above. Each function replaces the corresponding patch builders currently scattered across phase handlers.

### Executor path

- `src/runtime/phases/executor-phase.ts` keeps pure projection helpers but stops building durable `Partial<CardRecord>` completion patches.
- `src/runtime/phases/executor-completion-handler.ts` shrinks to calling `commitExecutorSuccess` or `commitExecutorFailure` after validation.
- `src/runtime/phases/executor-evidence.ts` keeps low-level evidence helpers; generated-file validation moves to the shared validators.
- `src/runtime/executor-activation-dispatcher.ts` calls projection, then validation, then the shared commit function.

### Reviewer path

- `src/runtime/reviewer-assessment.ts` uses `validateEvidenceCompleteness` for stronger evidence checks.
- `src/runtime/phases/reviewer-phase.ts` stops building durable pass patches.
- `src/runtime/phases/reviewer-assessment-handler.ts` calls `commitReviewerPass` or `commitReviewerCorrection` instead of directly transitioning cards, patching runtime state, and emitting events.

### Planner path

- `src/runtime/phases/planner-result-applier.ts` remains responsible for card creation and edits.
- Terminal planner status is committed through `commitPlannerDone` or `commitPlannerBlocked`.
- `src/runtime/phases/planner-invocation-failure.ts` uses `commitPlannerBlocked` instead of building its own patch.

### Card lifecycle

- Keep `src/cards/lifecycle.ts` as the low-level mutation guard.
- Add a convention that terminal fields (`result`, `error`, `completed_at`) on terminal-status cards are normally written only by the commit functions.
- After all phases are migrated, consider narrowing `ALWAYS_ALLOWED_FIELDS` so arbitrary phase code cannot patch terminal fields directly.

### Runtime state machine

- `transitionCard()` continues validating allowed status paths.
- `observeRuntimeStateInvariants()` gains invariants that assume terminal commits are coherent: `done` cards have `error === null`, completed activations match their card status, root run completion matches project card status.
- `planProjectRootRedispatch()` uses root completion facts from committed runtime runs and review state.

### Runtime reconciliation observer

Add a periodic observer (extending `observeRuntimeStateInvariants`) that detects and logs cross-domain inconsistencies without trying to repair them. This is separate from the commit functions and can report problems the commit layer prevents.

```ts
function observeTerminalInvariants(state: RuntimeState, readCard: (id: string) => CardRecord | null): InvariantObservation[];
```

Invariants:
- A `done` card has `error === null`.
- A `done` terminal card with `result.generated_files` references only existing project-root-relative files.
- A `done` goal card does not carry active `result.planning.status: 'blocked'`.
- A completed child activation has a matching terminal child runtime run.
- A root runtime run cannot be `done` while the project card is still `running`.
- Runtime intent cannot remain `running` after a root run completes unless a new root run has been started.

## Migration plan

### Step 1: Extract shared validators

Extract `validateGeneratedFiles`, `checkStaleTerminalState`, and `validateEvidenceCompleteness` into `src/runtime/terminal-commit/validators.ts`. Call them from the existing phase handlers alongside the current patch builders. Add tests for each validator.

### Step 2: Introduce commit functions alongside patch builders

Add `commitExecutorSuccess`, `commitExecutorFailure`, `commitReviewerPass`, etc. alongside the existing `buildExecutorCompletionPatch`, `buildReviewerPassCompletionPatch` functions. Phase handlers call the new commit functions, which internally use the shared validators and the state machine. Old patch builders remain until all callers are migrated.

### Step 3: Migrate executor dispatcher

Replace `handleExecutorCompletion` and the executor activation dispatcher's direct patch calls with `commitExecutorSuccess`/`commitExecutorFailure`. Remove `buildExecutorCompletionPatch` once equivalent test coverage exists through the commit function.

### Step 4: Migrate reviewer assessment handler

Replace `handleReviewerAssessmentDecision`'s direct card transitions, runtime patches, and event emissions with `commitReviewerPass`/`commitReviewerCorrection`. Remove `buildReviewerPassCompletionPatch`.

### Step 5: Migrate planner terminal states

Introduce `commitPlannerDone`/`commitPlannerBlocked` and migrate planner-result and planner-invocation-failure handlers.

### Step 6: Add terminal invariant observer

Add `observeTerminalInvariants` to the state machine tick. It reports inconsistencies but does not repair them. Once the commit layer is in place across all phases, violations should only come from historical state or operator intervention.

### Step 7: Tighten card mutation rules

After phase paths stop directly writing terminal fields, narrow `ALWAYS_ALLOWED_FIELDS` to exclude `result`, `error`, and `completed_at` on terminal-status cards. Leave explicit operator/admin repair paths if needed.

### Step 8: Expose validation and commit diagnostics

Add debug/operator routes for terminal validation results, rejected claims, and commit receipts. The card detail UI can show why a claimed success was downgraded to failure or parked for verification.

## Testing strategy

- Unit-test each semantic validator with synthetic cards, runtime runs, activations, generated files, unsafe paths, and stale result objects.
- Unit-test each commit function by checking the full set of side effects (card patch, status transition, runtime run update, activation update, events) against expected output.
- Unit-test commit ordering with fake ports that record writes and simulate failures.
- Add integration tests for: executor success, executor missing-file downgrade, executor fallback verification, reviewer invalid pass, reviewer valid pass, planner blocked recovery, and root completion reconciliation.
- Add regression tests for the observed inconsistency class: `done` plus stale error, `done` plus missing generated file, goal `done` plus active planning blockage, runtime idle plus running intent, and root run complete plus project card running.
- Keep `npm run validate:routine` as the routine gate and run focused Jest suites during migration.

## Open design questions

- Should missing generated files always fail executor completion, or should some cases park the card as `needs_verification`?
- Should `needs_verification` be a terminal runtime-run result or a paused/nonterminal runtime-run state?
- How much historical failure data should remain on a card after success, and under which field should it live?
- Should reviewer evidence cite card IDs only, or should it cite normalized evidence handles within card results?
- Which operator actions should be allowed to repair terminal fields after the commit functions own them?