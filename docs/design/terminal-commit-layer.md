# Terminal commit layer

This document proposes a redesign of the Saivage v3 runtime data structures and phase handler boundaries so that inconsistent terminal states become difficult to represent and easy to detect.

The design is motivated by a class of observed inconsistencies: a card marked `done` with stale `error` data, a `done` card claiming `generated_files` that do not exist, a goal with `result.planning.status: 'blocked'` surviving a reviewer pass, and runtime intent remaining `running` after a root run completes. Runtime validation guards (generated-file existence checks, stale-error clearing) are correct as far as they go, but they patch over structural gaps in the data model. The root cause is that the current data structures make illegal states easy to represent and hard to detect.

## Problem statement

The current `CardRecord` has four independent terminal fields:

```ts
status: CardStatus;                          // 'done'
error?: string | null;                       // 'rate limit exceeded'  ← allowed
completed_at?: string | null;                // '2026-01-01'           ← independent
result?: Record<string, unknown> | null;    // { planning: { status: 'blocked' } } ← independent
```

A `done` card with a non-null `error` is a valid `CardRecord`. A `done` card with `result.planning.status: 'blocked'` is a valid `CardRecord`. Every phase handler must remember to clear `error` when transitioning to success, and each handler builds its own `Partial<CardRecord>` spread-merge that can accidentally overlay contradictory keys.

Three structural gaps enable the observed inconsistency class:

1. **`result` is an untyped grab bag.** `Record<string, unknown>` allows any phase to write any keys. Executor fields, planner fields, reviewer fields, and failure markers coexist without constraint. A `done` card can carry `result.parse_failure`, `result.evidence_registration_failures`, and `result.planning.status: 'blocked'` simultaneously because nothing prevents contradictory keys in an unconstrained record.

2. **Terminal state fields are independent.** `status`, `error`, `completed_at`, and `result` are four unrelated optional fields. The type system cannot enforce that a `done` card has `error === null` and `completed_at` set, or that a `failed` card has a non-empty `error`. Phase handlers build `Partial<CardRecord>` patches and merge them with spread, so each handler must independently remember the invariants.

3. **Runtime state, runs, activations, and card status are independent stores.** `RuntimeState` holds `active_card_run`, `runtime_runs[]`, and `runtime_activations[]` as separate arrays. Card status lives in `CardRecord`. An activation can be `completed` while its card is still `running`, or a runtime run can be `done` while the project card is `running`, because nothing ties these lifecycles together.

## Design goals

- Make illegal terminal states hard to represent at the type level.
- Make common invariants automatic rather than requiring each phase handler to remember them.
- Keep phase handlers as semantic owners but route their writes through typed commit boundaries.
- Keep the state machine as the single authority for status transitions.
- Preserve JSON and JSONL storage; this proposal does not introduce a database or alternate persistence layer.
- Provide a clean migration path that introduces the new types alongside the old flat fields, then phases out the flat fields.

## Non-goals

- A monolithic committer that owns card status, runtime runs, activations, review state, events, and diagnostics in a single type. That concentrates every domain in one place.
- True atomic cross-file transactions. JSON storage cannot provide them; this design uses deterministic commit ordering and typed write boundaries instead.
- Rewriting the scheduler, event bus, server API, or card store in the same step.
- Using prompts as the primary correctness mechanism.

## Architecture overview

The redesign has two layers: a **data structure layer** that makes illegal states unrepresentable, and a **phase handler boundary layer** that routes writes through typed commit functions instead of free-form patches.

```text
Agent output
  -> contract parser
  -> PhaseOutcome projection (typed domain outcome)
  -> shared semantic validators (runtime checks: file existence, path safety)
  -> typed commit functions (write CardLifecycleState, derived activation outcome)
  -> state machine status transition
  -> events / diagnostics
```

Phase handlers remain responsible for their domain logic. An executor knows what `succeeded` vs `failed` means; a reviewer knows what `pass` vs `needs_corrections` means. But they delegate three things to shared infrastructure:

1. **Data structure constraints** — the type system prevents constructing a `done` state with `error: 'stale'` or a `failed` state without an error message.
2. **Semantic validation** — pure functions check facts the LLM cannot verify (file existence, path safety, stale field clearing).
3. **Durable mutation** — commit functions write the typed terminal state, derive activation/run outcomes, and emit events in a consistent order.

The state machine remains the single authority for allowed status transitions. Commit functions call it; they do not bypass it.

## Data structure changes

### CardLifecycleState discriminated union

Replace the four independent terminal fields (`status`, `error`, `completed_at`, `result`) with a single discriminated union that makes illegal combinations unrepresentable.

```ts
type CardRecord = {
  id: string;
  type: CardType;
  parent: string | null;
  depth: number;
  position: number;
  title: string;
  description: string;
  subtype: string | null;
  instructions_file: string | null;
  tags: string[];
  priority: number;
  urgency: Urgency;
  created_by: CreatedBy;
  created_at: string;
  updated_at: string;
  version_seq: number;
  assigned_to: string | null;
  depends_on: string[];
  blocks: string[];
  related: string[];
  acceptance: string;
  metrics: Record<string, number | string | boolean | null> | null;
  artifacts: ArtifactRef[];
  attachments: AttachmentRef[];
  estimate: string | null;
  started_at: string | null;
  retries: number;
  latest_self_report: SelfReport | null;
  status_text: string | null;
  status_text_updated_at: string | null;
  status_text_author_session_id: string | null;
  metadata: CardMetadata | null;
  allowed_actions: CardAction[];
} & CardLifecycleState;
```

The discriminated union for lifecycle state:

```ts
type CardLifecycleState =
  // Non-terminal states: result and error are tightly constrained
  | { status: 'drafting'; result: null; error: null; completed_at: null }
  | { status: 'backlog'; result: null; error: null; completed_at: null }
  | { status: 'active'; result: null; error: null; completed_at: null }
  | { status: 'running'; result: CardResult | null; error: string | null; completed_at: null }
  | { status: 'changed'; result: CardResult | null; error: string | null; completed_at: null }

  // Terminal states: each shape guarantees the invariants that matter
  | { status: 'done'; result: DoneResult; error: null; completed_at: string }
  | { status: 'failed'; result: FailureResult; error: string; completed_at: string }
  | { status: 'blocked'; result: BlockedResult; error: string; completed_at: null }
  | { status: 'needs_verification'; result: NeedsVerificationResult; error: string; completed_at: null }
  | { status: 'cancelled'; result: null; error: null; completed_at: string | null };
```

Key invariants enforced by the type:

- A `done` card structurally requires `error: null` and `completed_at: string`.
- A `failed` card structurally requires `error: string` and `completed_at: string`.
- A `blocked` card structurally requires `error: string` and `completed_at: null`.
- Stale error merging on a `done` card becomes a type error.
- Forgetting `completed_at` on a terminal card becomes a type error.

### Typed CardResult variants

Replace `result: Record<string, unknown> | null` with a discriminated union so contradictory executor/planner/reviewer keys cannot coexist.

```ts
type CardResult =
  | ExecutorSuccessResult
  | ExecutorFailureResult
  | ExecutorNeedsVerificationResult
  | PlannerDoneResult
  | PlannerBlockedResult
  | ReviewerPassResult
  | ReviewerCorrectionResult;

interface SelfReport {
  result: string;
  outcome: string;
  summary: string;
  status_text: string;
  at: string;
}

interface ExecutorSuccessResult {
  kind: 'executor_success';
  executor: Record<string, unknown>;
  generated_files: string[];
  verified_at: string;
  latest_self_report: SelfReport;
  warnings: string[];
}

interface ExecutorFailureResult {
  kind: 'executor_failure';
  error: string;
  partial_result: Record<string, unknown> | null;
  latest_self_report: SelfReport;
}

interface ExecutorNeedsVerificationResult {
  kind: 'executor_needs_verification';
  reason: string;
  preserved_result: Record<string, unknown>;
  fallback_reason: string | null;
  latest_self_report: SelfReport;
}

interface PlannerDoneResult {
  kind: 'planner_done';
  created_cards: string[];
  updated_cards: string[];
  summary: string;
}

interface PlannerBlockedResult {
  kind: 'planner_blocked';
  blocked_reason: string;
  resume_reason: string;
  created_cards: string[];
  updated_cards: string[];
}

interface ReviewerPassResult {
  kind: 'reviewer_pass';
  planning: PlannerDoneResult | PlannerBlockedResult;
  review_summary: string;
  assessment_id: string;
}

interface ReviewerCorrectionResult {
  kind: 'reviewer_correction';
  issues: ReviewerIssue[];
  summary: string;
  assessment_id: string;
}
```

Key properties:

- `result.planning.status: 'blocked'` surviving on a `done` card becomes impossible because `ReviewerPassResult.planning` is explicitly typed, not merged from arbitrary keys.
- `result.generated_files` on a `failed` card is impossible because `ExecutorFailureResult` has no `generated_files` field.
- `result.parse_failure` on a `done` card is impossible because `ExecutorSuccessResult` has no `parse_failure` field.
- `result.evidence_registration_failures` on a `done` card becomes `warnings: string[]` which is semantically accurate: registration warnings are not failure facts.

The `DoneResult` type for the `done` lifecycle state:

```ts
type DoneResult =
  | ExecutorSuccessResult
  | PlannerDoneResult
  | ReviewerPassResult;
```

A `done` card can only carry result kinds that are semantically compatible with success. A `blocked` planner state cannot appear inside a `DoneResult` because `ReviewerPassResult.planning` is explicitly `PlannerDoneResult | PlannerBlockedResult` — the type makes the planner state visible and intentional, not accidentally merged.

The `FailureResult` type:

```ts
type FailureResult =
  | ExecutorFailureResult;
```

A `failed` card can only carry failure-specific result data.

### Derived activation outcome

Currently runtime activations have an independent `status` field that can drift from card status. Restructure so that terminal card status is the source of truth for activation outcome.

```ts
type ActivationOutcome =
  | { kind: 'completed'; outcome: 'done'; card_id: string; completed_at: string }
  | { kind: 'completed'; outcome: 'failed'; card_id: string; error: string; completed_at: string }
  | { kind: 'completed'; outcome: 'needs_verification'; card_id: string; reason: string }
  | { kind: 'running'; card_id: string; phase: 'executor' | 'reviewer'; started_at: string }
  | { kind: 'pending'; card_id: string; precondition: 'accepted' }
  | { kind: 'blocked'; card_id: string; error: string };
```

When a card transitions to `done`, the activation outcome must be `completed/done`. When a card transitions to `failed`, the activation outcome must be `completed/failed`. The commit function that transitions the card also transitions the activation, and the types enforce they agree.

Similarly for runtime runs:

```ts
type RuntimeRunOutcome =
  | { kind: 'completed'; result: 'done'; finished_at: string }
  | { kind: 'completed'; result: 'failed'; error: string; finished_at: string }
  | { kind: 'completed'; result: 'blocked'; error: string }
  | { kind: 'completed'; result: 'needs_verification'; reason: string }
  | { kind: 'completed'; result: 'stopped' }
  | { kind: 'running'; phase: RuntimeRunPhase; started_at: string };
```

A root run cannot be `done` while the project card is `running` because the run outcome would require pairing with a project card terminal state.

## Phase handler boundary layer

### PhaseOutcome types

Each phase handler produces a typed domain outcome. The outcome is a claim, not a commit.

```ts
type PhaseOutcome =
  | ExecutorPhaseOutcome
  | ReviewerPhaseOutcome
  | PlannerPhaseOutcome;

type ExecutorPhaseOutcome =
  | { role: 'executor'; kind: 'succeeded'; card_id: string; goal_id: string; summary: string; status_text: string; result: Record<string, unknown>; generated_files: string[]; process_evidence: ProcessEvidenceClaim[]; accepted_at: string; session_id: string | null }
  | { role: 'executor'; kind: 'failed'; card_id: string; goal_id: string; summary: string; status_text: string; error: string; partial_result: Record<string, unknown> | null; accepted_at: string; session_id: string | null }
  | { role: 'executor'; kind: 'needs_verification'; card_id: string; goal_id: string; reason: string; preserved_result: Record<string, unknown>; accepted_at: string; session_id: string | null };
```

`kind: 'succeeded'` is a claim. It becomes `status: 'done'` only if the semantic validators pass and the typed commit function accepts it.

### Semantic validators

Shared pure functions that check runtime facts. The type system handles the structural invariants; validators handle filesystem and runtime truths.

```ts
interface GeneratedFileValidation {
  valid: string[];
  missing: string[];
  unsafe: string[];
}

function validateGeneratedFiles(projectRoot: string, paths: string[]): GeneratedFileValidation;

function checkStaleError(card: CardRecord): boolean;
// Returns true if card.error is non-null and card is transitioning to done.

interface EvidenceCompleteness {
  semantically_complete: boolean;
  reasons: string[];
}

function validateEvidenceCompleteness(
  card: CardRecord,
  readCard: (id: string) => CardRecord | null,
): EvidenceCompleteness;
```

Validators do not write state, transition cards, or emit events. They answer questions that the type system cannot (file existence, runtime run alignment).

### Typed commit functions

Small, domain-specific functions that write the discriminated union lifecycle state. Each function handles one terminal transition and produces the derived activation/run outcomes.

```ts
function commitExecutorSuccess(context: ExecutorSuccessContext): ExecutorCommitReceipt;
function commitExecutorFailure(context: ExecutorFailureContext): ExecutorCommitReceipt;
function commitExecutorParkedVerification(context: ExecutorParkContext): ExecutorCommitReceipt;
function commitReviewerPass(context: ReviewerPassContext): ReviewerCommitReceipt;
function commitReviewerCorrection(context: ReviewerCorrectionContext): ReviewerCommitReceipt;
function commitPlannerDone(context: PlannerDoneContext): PlannerCommitReceipt;
function commitPlannerBlocked(context: PlannerBlockedContext): PlannerCommitReceipt;
```

Each commit function:

1. Validates preconditions (the card can transition, the outcome is semantically sound).
2. Calls `stateMachine.transitionCard()` for the status change.
3. Writes the `CardLifecycleState` discriminated union, guaranteeing invariants like `error: null` for `done`.
4. Derives the activation outcome and run outcome from the card's terminal state.
5. Persists review assessment if applicable.
6. Emits events and diagnostics.

The commit functions produce the discriminated union directly. They never build `Partial<CardRecord>` patches. The type system guarantees that a `commitExecutorSuccess` call produces a `{ status: 'done'; result: DoneResult; error: null; completed_at: string }` lifecycle state.

### Phase outcome projection

Each phase handler has a projection function that converts raw agent contract output into a `PhaseOutcome`. Projection is a pure transformation that does not write state.

```ts
function projectExecutorResult(contractOutput: ExecutorResult): ExecutorPhaseOutcome;
function projectReviewerResult(contractOutput: ReviewerResult): ReviewerPhaseOutcome;
function projectPlannerResult(contractOutput: PlannerResult): PlannerPhaseOutcome;
```

These replace the current patch-builder functions (`buildExecutorCompletionPatch`, `buildReviewerPassCompletionPatch`, etc.).

## Terminal semantics by phase

### Executor success

An executor success can commit `done` only when all semantic validators pass.

- The commit function writes `{ status: 'done'; result: ExecutorSuccessResult; error: null; completed_at: string }`.
- `ExecutorSuccessResult.generated_files` has been validated against the workspace.
- `ExecutorSuccessResult.verified_at` records when file existence was checked.
- Stale `parse_failure` and `evidence_registration_failures` keys are impossible because `ExecutorSuccessResult` has no such fields. Registration warnings go into `warnings: string[]`.
- The activation outcome is derived as `{ kind: 'completed'; outcome: 'done'; card_id; completed_at }`.
- The run outcome is derived as `{ kind: 'completed'; result: 'done'; finished_at }`.

If a generated file claim is missing or unsafe, the outcome is downgraded. The existing guard converts it to failure through evidence-registration failure semantics; this design makes that policy explicit and testable through the commit function's validation path.

### Executor failure

- The commit function writes `{ status: 'failed'; result: ExecutorFailureResult; error: string; completed_at: string }`.
- `ExecutorFailureResult` has no `generated_files` field, so partial file claims cannot appear as success evidence.
- The activation outcome is `{ kind: 'completed'; outcome: 'failed'; card_id; error; completed_at }`.

### Executor needs verification

- The commit function writes `{ status: 'needs_verification'; result: ExecutorNeedsVerificationResult; error: string; completed_at: null }`.
- Preserved evidence is explicitly typed as untrusted/fallback.
- The activation outcome is `{ kind: 'completed'; outcome: 'needs_verification'; card_id; reason }`.

### Reviewer pass

- The commit function writes `{ status: 'done'; result: ReviewerPassResult; error: null; completed_at: string }`.
- `ReviewerPassResult.planning` is explicitly `PlannerDoneResult | PlannerBlockedResult`. If the planner state was blocked, it is carried intentionally, not accidentally merged. The reviewer pass commit can then clear or archive it.
- Evidence cards are validated for semantic completeness, not just existence and status.

### Reviewer needs corrections

- The assessment is persisted as a `ReviewerCorrectionResult`.
- The goal card status transitions back to `active` or `backlog`, not to a terminal state.
- No activation reports `done` to a parent planner.

### Planner done

- Terminal planner state is committed through `commitPlannerDone`, which writes a `CardLifecycleState` with `result: PlannerDoneResult`.
- If the goal has terminal child cards, reviewer scheduling is triggered.
- Planner blockage clears only when a valid outcome supersedes it.

### Planner blocked

- The commit function writes `{ status: 'blocked'; result: PlannerBlockedResult; error: string; completed_at: null }`.
- The type guarantees that `error` matches the `blocked_reason` in the result because `PlannerBlockedResult.blocked_reason` and the outer `error` field are both required strings in the same discriminated union branch.

## Invariants enforced by the data structure

These invariants move from runtime checks to compile-time guarantees:

- A `done` card has `error: null` — enforced by the `CardLifecycleState` discriminated union.
- A `done` card has `completed_at: string` — enforced by the discriminated union.
- A `failed` card has `error: string` — enforced by the discriminated union.
- A `done` card cannot carry `parse_failure` or `evidence_registration_failures` as active completion facts — enforced because `ExecutorSuccessResult` has no such fields.
- A `done` card cannot accidentally retain `result.planning.status: 'blocked'` — enforced because `ReviewerPassResult.planning` is an explicit type, not an arbitrary key.
- A `done` card's `result.generated_files` field exists only in `ExecutorSuccessResult` — enforced by the type union.
- A completed activation outcome matches the card's terminal status — enforced by the `ActivationOutcome` discriminated union.
- A completed runtime run outcome matches the card's terminal status — enforced by the `RuntimeRunOutcome` discriminated union.

These invariants are still checked at runtime for filesystem truths (file existence, path safety) and cross-entity alignment (activation/run matching), but the type system prevents the structural inconsistencies that caused the observed bugs.

## Required code changes

### New type module

Add `src/schemas/lifecycle.ts` defining:

- `CardLifecycleState` discriminated union.
- `CardResult` and its variants (`ExecutorSuccessResult`, `ExecutorFailureResult`, `PlannerDoneResult`, `PlannerBlockedResult`, `ReviewerPassResult`, `ReviewerCorrectionResult`, `ExecutorNeedsVerificationResult`).
- `DoneResult`, `FailureResult`, `BlockedResult`, `NeedsVerificationResult` constrained result types.
- `ActivationOutcome` discriminated union.
- `RuntimeRunOutcome` discriminated union.
- `SelfReport` type.

### New terminal-commit module

Add `src/runtime/terminal-commit/` with:

- `outcomes.ts` — `PhaseOutcome` variants and projection functions.
- `validators.ts` — `validateGeneratedFiles`, `checkStaleError`, `validateEvidenceCompleteness`.
- `commit-executor.ts` — `commitExecutorSuccess`, `commitExecutorFailure`, `commitExecutorParkedVerification`.
- `commit-reviewer.ts` — `commitReviewerPass`, `commitReviewerCorrection`.
- `commit-planner.ts` — `commitPlannerDone`, `commitPlannerBlocked`.
- `index.ts` — stable public API.

### Card store migration

- `src/cards/card-store.ts` gains read/write adapters that convert between the old flat `CardRecord` and the new `CardLifecycleState`-enriched record.
- New code writes through the discriminated union. Old code still reads the flat fields during migration.
- `src/cards/lifecycle.ts` gains lifecycle-state-aware validation: transitioning to `done` requires a `DoneResult`, transitioning to `failed` requires a non-empty error string.
- After all terminal writes go through commit functions, `ALWAYS_ALLOWED_FIELDS` is narrowed so phase code cannot directly patch `result`, `error`, or `completed_at` on terminal cards.

### Executor path

- `src/runtime/phases/executor-phase.ts` keeps pure projection helpers but stops building `Partial<CardRecord>` completion patches.
- `src/runtime/phases/executor-completion-handler.ts` shrinks to calling `commitExecutorSuccess` or `commitExecutorFailure` after validation.
- `src/runtime/phases/executor-evidence.ts` keeps low-level evidence helpers; generated-file validation moves to `terminal-commit/validators.ts`.
- `src/runtime/executor-activation-dispatcher.ts` calls projection, then validation, then the commit function.

### Reviewer path

- `src/runtime/reviewer-assessment.ts` uses `validateEvidenceCompleteness` for stronger evidence checks.
- `src/runtime/phases/reviewer-phase.ts` stops building durable pass patches.
- `src/runtime/phases/reviewer-assessment-handler.ts` calls `commitReviewerPass` or `commitReviewerCorrection` instead of directly transitioning cards and patching runtime state.

### Planner path

- `src/runtime/phases/planner-result-applier.ts` remains responsible for card creation and edits.
- Terminal planner status is committed through `commitPlannerDone` or `commitPlannerBlocked`.
- `src/runtime/phases/planner-invocation-failure.ts` uses `commitPlannerBlocked` instead of building its own patch.

### Runtime state machine

- `transitionCard()` continues validating allowed status paths.
- `observeRuntimeStateInvariants()` gains invariants that check `CardLifecycleState` alignment: `done` cards have `error === null`, `failed` cards have non-empty `error`, completed activations match their card status, root run outcomes match project card status.
- `planProjectRootRedispatch()` uses root completion facts from derived `RuntimeRunOutcome` and review state.

### Activation and run ledgers

- `src/runtime/activation-unwind.ts` and `src/runtime/activation-reducer.ts` gain `ActivationOutcome` derivation: when a card transitions to terminal, the activation outcome is computed from the card's `CardLifecycleState`.
- `src/runtime/runtime-run-ledger.ts` gains `RuntimeRunOutcome` derivation: when a run completes, its result is computed from the card's terminal state.
- Parent planner tool results are generated from the activation outcome, not independently set.

### API and web UI

- Card read responses can expose both the flat legacy fields and the new `lifecycle` object during migration.
- Once all terminal writes go through the discriminated union, the flat fields become read-only derived fields for backward compatibility.
- Eventually the flat fields can be deprecated and removed in a later release.

## Migration plan

### Step 1: Introduce CardLifecycleState and CardResult types alongside the flat fields

Add `src/schemas/lifecycle.ts` with the discriminated union types. Add read/write adapters in the card store that convert between flat `CardRecord` and the enriched structure. New code writes through the discriminated union; old code still reads the flat fields. No behavior change yet.

### step 2: Extract shared validators

Move `validateGeneratedFiles`, `checkStaleError`, and `validateEvidenceCompleteness` into `src/runtime/terminal-commit/validators.ts`. Call them from existing phase handlers alongside current patch builders. Add tests for each validator.

### step 3: Introduce commit functions alongside patch builders

Add `commitExecutorSuccess`, `commitExecutorFailure`, `commitReviewerPass`, etc. alongside existing `buildExecutorCompletionPatch` and `buildReviewerPassCompletionPatch`. Phase handlers call the new commit functions. Old patch builders remain until all callers are migrated.

### step 4: Migrate executor dispatcher

Replace `handleExecutorCompletion` and the executor activation dispatcher's direct patch calls with `commitExecutorSuccess`/`commitExecutorFailure`. These functions write `CardLifecycleState` instead of `Partial<CardRecord>`. Remove `buildExecutorCompletionPatch`.

### step 5: Migrate reviewer assessment handler

Replace `handleReviewerAssessmentDecision`'s direct card transitions and runtime patches with `commitReviewerPass`/`commitReviewerCorrection`. Remove `buildReviewerPassCompletionPatch`.

### step 6: Migrate planner terminal states

Introduce `commitPlannerDone`/`commitPlannerBlocked` and migrate planner-result and planner-invocation-failure handlers.

### step 7: Add lifecycle invariant observer

Extend `observeRuntimeStateInvariants()` to check `CardLifecycleState` alignment. Violations are logged but not auto-repaired. Once all terminal writes go through the discriminated union, invariant violations should only come from historical state or operator intervention.

### step 8: Tighten card mutation rules

After all phase paths use commit functions, narrow `ALWAYS_ALLOWED_FIELDS` to exclude `result`, `error`, and `completed_at` on terminal-status cards that carry a `CardLifecycleState`. Leave explicit operator/admin repair paths.

### step 9: Derive activation and run outcomes from card state

Change `ActivationRecord.status` and `RuntimeRunRecord.result` to be derived from the card's `CardLifecycleState` at commit time, using the `ActivationOutcome` and `RuntimeRunOutcome` discriminated unions. This prevents drift between card status and activation/run status.

### step 10: Deprecate flat terminal fields in the API

Once all clients read from the `lifecycle` object, the flat `status`, `error`, `completed_at`, and `result` fields can be deprecated and eventually removed.

## Testing strategy

- Unit-test the `CardLifecycleState` discriminated union: verify that the type system prevents constructing a `done` state with `error: 'stale'` or a `failed` state without an error string.
- Unit-test each semantic validator with synthetic cards, files, and stale result objects.
- Unit-test each commit function by checking the full set of side effects (lifecycle state, status transition, activation outcome, run outcome, events) against expected output.
- Unit-test commit ordering with fake ports that record writes and simulate failures.
- Add integration tests for: executor success, executor missing-file downgrade, executor fallback verification, reviewer invalid pass, reviewer valid pass, planner blocked recovery, and root completion reconciliation.
- Add regression tests for the observed inconsistency class: `done` plus stale error, `done` plus missing generated file, goal `done` plus active planning blockage, runtime idle plus running intent, and root run complete plus project card running.
- The type system prevents many of these at compile time; runtime tests cover the remaining filesystem and cross-entity checks.

## Open design questions

- Should `needs_verification` be a terminal runtime run result or a paused/nonterminal runtime run state?
- How much historical failure data should remain accessible on a card after success, and under which field? The current design puts warnings in `ExecutorSuccessResult.warnings`, but review/failure details from prior attempts may need a separate history log.
- Should reviewer evidence cite card IDs only, or should it cite normalized evidence handles within card results?
- Which operator actions should be allowed to override terminal lifecycle state for manual repair, and should those overrides go through the commit functions or through a separate admin path?
- Should the `CardLifecycleState` discriminated union be persisted directly in the JSON card file, or should the card file continue to use flat fields during migration and only convert internally?