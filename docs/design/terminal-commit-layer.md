# Terminal commit layer

This document proposes a redesign of the Saivage v3 runtime data structures and phase handler boundaries so that inconsistent terminal states become harder to construct in new TypeScript code and easier to detect at persistence boundaries.

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

- Make illegal terminal states hard to represent at typed construction sites.
- Make common invariants automatic rather than requiring each phase handler to remember them.
- Keep phase handlers as semantic owners but route their writes through typed commit boundaries.
- Keep the state machine as the single authority for status transitions.
- Preserve JSON and JSONL storage; this proposal does not introduce a database or alternate persistence layer.
- Provide a migration path that introduces the new lifecycle model alongside the old flat fields, then makes the flat fields derived compatibility fields.

## Non-goals

- A monolithic committer that owns card status, runtime runs, activations, review state, events, and diagnostics in a single type. That concentrates every domain in one place.
- True atomic cross-file transactions. JSON storage cannot provide them; this design uses deterministic commit ordering and typed write boundaries instead.
- Rewriting the scheduler, event bus, server API, or card store in the same step.
- Using prompts as the primary correctness mechanism.

## Architecture overview

The redesign has two layers: a **data structure layer** that makes illegal states unrepresentable at typed construction sites, and a **phase handler boundary layer** that routes writes through typed commit functions instead of free-form patches.

```text
Agent output
  -> contract parser
  -> PhaseOutcome projection (typed domain outcome)
  -> shared semantic validators (runtime checks: file existence, path safety)
  -> typed commit functions (write CardLifecycleState, snapshot activation/run outcome)
  -> state machine status transition
  -> events / diagnostics
```

Phase handlers remain responsible for their domain logic. An executor knows what `succeeded` vs `failed` means; a reviewer knows what `pass` vs `needs_corrections` means. But they delegate three things to shared infrastructure:

1. **Data structure constraints** — the type system prevents typed code from constructing a `done` state with `error: 'stale'` or a `failed` state without an error message.
2. **Semantic validation** — pure functions check facts the LLM cannot verify (file existence, path safety, stale field clearing).
3. **Durable mutation** — commit functions write the typed lifecycle state, snapshot activation/run outcomes, and emit events in a consistent order.

The state machine remains the single authority for allowed status transitions. Commit functions call it; they do not bypass it.

## Data structure changes

### CardLifecycleState discriminated union

Replace the four independent terminal fields (`status`, `error`, `completed_at`, `result`) with a single discriminated union at the typed write boundary. During migration, persisted card JSON may still contain the flat fields; adapters project those fields into this lifecycle model and eventually expose an explicit `lifecycle` object while keeping flat fields as derived compatibility fields.

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
  allowedActions?: CardAction[];
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

  // Completed, blocked, and parked states: each shape guarantees the invariants that matter
  | { status: 'done'; result: DoneResult; error: null; completed_at: string }
  | { status: 'failed'; result: FailureResult; error: string; completed_at: string }
  | { status: 'blocked'; result: BlockedResult; error: string; completed_at: null }
  | { status: 'needs_verification'; result: NeedsVerificationResult; error: null; completed_at: null }
  | { status: 'cancelled'; result: null; error: null; completed_at: string | null };
```

The examples use `status` as the discriminant because the current API and card files already expose `status`. If the migration chooses to persist a nested `lifecycle` object, the nested object should contain this same shape and the top-level flat fields should be generated from it rather than maintained independently.

Key invariants enforced by the type:

- A `done` card structurally requires `error: null` and `completed_at: string`.
- A `failed` card structurally requires `error: string` and `completed_at: string`.
- A `blocked` card structurally requires `error: string` and `completed_at: null`.
- A `needs_verification` card structurally requires `error: null` and `completed_at: null`; the reason lives in `NeedsVerificationResult.reason`, because this is a parked review state rather than a failure.
- Stale error merging on a `done` card becomes a type error at typed lifecycle construction sites. Data arriving through `unknown`, `any`, JSON, or broad object spreads still requires schema validation.
- Forgetting `completed_at` on a completed success or failure becomes a type error.

### Runtime validation for persisted state

Discriminated unions enforce invariants at compile-time construction sites, but card files are persisted as JSON and reloaded from disk. The card store must validate deserialized data before trusting it.

- Zod schemas that mirror `CardLifecycleState`, `CardResult`, `ActivationOutcome`, and `RuntimeRunOutcome` validate card JSON at load time. They may be generated from a single source of truth or maintained beside the types with parity tests; TypeScript alone cannot derive runtime validation. A card with `status: 'done'` and `error: 'stale'` is caught and either normalized or rejected.
- Historical state that predates migration may not satisfy the new invariants. The load adapter normalizes missing or contradictory flat fields into valid `CardLifecycleState` branches and logs warnings for manual review.
- The Zod schemas live alongside the type definitions in `src/schemas/lifecycle.ts`, with type/schema parity tests to keep them synchronized.

### Typed CardResult variants

Replace `result: Record<string, unknown> | null` with a discriminated union so contradictory executor/planner/reviewer keys are rejected when values are constructed through the commit API or loaded through strict schemas.

```ts
type CardResult =
  | ExecutorSuccessResult
  | ExecutorFailureResult
  | ExecutorNeedsVerificationResult
  | PlannerDoneResult
  | PlannerBlockedResult
  | ReviewerPassResult;

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
  summary: string;
}

interface PlannerBlockedResult {
  kind: 'planner_blocked';
  blocked_reason: string;
  resume_reason: string;
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

`ReviewerCorrectionResult` is intentionally not a `CardResult`: reviewer corrections send the goal back to `active` or `backlog`, and those lifecycle branches keep `result: null`. The correction result belongs in the review assessment store, diary, or attempt history, not in the current card lifecycle result.

Key properties:

- Arbitrary `result.planning.status: 'blocked'` surviving on a `done` card is rejected at typed construction and schema-validation boundaries because `ReviewerPassResult.planning` is explicitly typed, not merged from arbitrary keys. A reviewer pass may still carry `PlannerBlockedResult` intentionally as historical planning context.
- `result.generated_files` on a `failed` card is rejected at typed construction and schema-validation boundaries because `ExecutorFailureResult` has no `generated_files` field.
- `result.parse_failure` on a `done` card is rejected at typed construction and schema-validation boundaries because `ExecutorSuccessResult` has no `parse_failure` field.
- `result.evidence_registration_failures` on a `done` card becomes `warnings: string[]` which is semantically accurate: registration warnings are not failure facts.

The `DoneResult` type for the `done` lifecycle state:

```ts
type DoneResult =
  | ExecutorSuccessResult
  | PlannerDoneResult
  | ReviewerPassResult;
```

A `done` card can only carry result kinds that are semantically compatible with success. `ReviewerPassResult.planning` can contain `PlannerBlockedResult`, which represents the planning state at the time of review — this is intentional historical context, not an invariant violation. A reviewer pass confirms the goal's deliverables despite blocked planning; the blocked state is carried to preserve what happened, not to claim the goal is still blocked.

`PlannerDoneResult` is a valid `DoneResult` for planning-only cards (task cards that execute directly without child goals). For parent goal cards, planner completion is not terminal because children and review may still be pending. `commitPlannerDone` enforces this domain rule: parent goals transition to `active` or `changed`, not `done`, when the planner finishes.

The `FailureResult` type:

```ts
type FailureResult =
  | ExecutorFailureResult;
```

A `failed` card can only carry failure-specific result data.

The blocked and parked result aliases used by `CardLifecycleState` are:

```ts
type BlockedResult = PlannerBlockedResult;
type NeedsVerificationResult = ExecutorNeedsVerificationResult;
```

Planner invocation failures that prevent planning from completing should map to `PlannerBlockedResult` and `status: 'blocked'` unless the state machine gains a distinct planner-failed terminal branch. They should not be forced into `ExecutorFailureResult`.

### Snapshot activation and run outcomes

Currently runtime activations have an independent `status` field that can drift from card status. Restructure so that the card transition is the source of truth at commit time, and the activation stores a historical snapshot of that outcome. Activation and run outcomes must not be recomputed from the card's current status on read, because cards can be reopened or retried later.

```ts
type ActivationOutcome =
  | { kind: 'completed'; outcome: 'done'; card_id: string; completed_at: string }
  | { kind: 'completed'; outcome: 'failed'; card_id: string; error: string; completed_at: string }
  | { kind: 'completed'; outcome: 'cancelled'; card_id: string; completed_at: string }
  | { kind: 'completed'; outcome: 'timed_out'; card_id: string; error: string; completed_at: string }
  | { kind: 'paused'; reason: 'needs_verification'; card_id: string; detail: string }
  | { kind: 'running'; card_id: string; phase: 'executor' | 'reviewer'; started_at: string }
  | { kind: 'pending'; card_id: string; precondition: 'accepted' }
  | { kind: 'rejected'; card_id: string; precondition: 'rejected'; error: string }
  | { kind: 'blocked'; card_id: string; error: string };
```

When a card transitions to `done`, the activation outcome snapshot must be `completed/done`. When a card transitions to `failed`, the activation outcome snapshot must be `completed/failed`. When a card transitions to `needs_verification`, the activation is parked as `paused/needs_verification` because verification work remains. The commit function that transitions the card also records the activation snapshot. The union types make the valid snapshot shapes explicit, but they do not by themselves prove that the snapshot matches a separately stored card record; the commit function and invariant observer must validate that pairing.

Similarly for runtime runs:

```ts
type RuntimeRunOutcome =
  | { kind: 'completed'; result: 'done'; finished_at: string }
  | { kind: 'completed'; result: 'failed'; error: string; finished_at: string }
  | { kind: 'completed'; result: 'cancelled'; finished_at: string }
  | { kind: 'completed'; result: 'stopped'; finished_at: string }
  | { kind: 'blocked'; error: string }
  | { kind: 'paused'; reason: 'needs_verification'; detail: string }
  | { kind: 'running'; phase: RuntimeRunPhase; started_at: string };
```

A root run should not be marked `done` while the project card is `running` because the run outcome snapshot is produced from the project card lifecycle state at commit time. This is a commit-time and invariant-observer guarantee, not a property the `RuntimeRunOutcome` union can enforce independently.

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

Shared pure functions that check runtime facts. The type system handles structural shape for typed values; validators handle filesystem, persistence, and cross-record runtime truths.

```ts
interface GeneratedFileValidation {
  valid: string[];
  missing: string[];
  unsafe: string[];
}

function validateGeneratedFiles(projectRoot: string, paths: string[]): GeneratedFileValidation;

function validateTerminalOverlay(previousCard: CardRecord, nextLifecycle: CardLifecycleState): string[];
// Returns diagnostics for stale flat fields or contradictory spread overlays.

interface EvidenceCompleteness {
  semantically_complete: boolean;
  reasons: string[];
}

function validateEvidenceCompleteness(
  card: CardRecord,
  readCard: (id: string) => CardRecord | null,
): EvidenceCompleteness;
```

Validators do not write state, transition cards, or emit events. They answer questions that the type system cannot answer alone, including file existence, path safety, historical flat-field repair, and cross-record runtime alignment.

### Typed commit functions

Small, domain-specific functions that write the discriminated union lifecycle state. Each function handles one lifecycle transition and records activation/run outcome snapshots.

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
4. Records activation and run outcome snapshots from the card's lifecycle state at commit time.
5. If the committed card completes or stops the project root run, updates `runtime_intent` and runtime status consistently with the run outcome.
6. Persists review assessment if applicable.
7. Emits events and diagnostics.

The commit functions produce the discriminated union directly. They never build unconstrained `Partial<CardRecord>` patches for terminal fields. The type system guarantees that the lifecycle value returned by `commitExecutorSuccess` has the shape `{ status: 'done'; result: DoneResult; error: null; completed_at: string }`; separate runtime checks still verify filesystem claims and cross-record ledger alignment.

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
- `ExecutorSuccessResult.generated_files` contains only paths that have been validated against the workspace.
- `ExecutorSuccessResult.verified_at` records when file existence was checked.
- Stale `parse_failure` and `evidence_registration_failures` keys are rejected by the commit path and schemas because `ExecutorSuccessResult` has no such fields. Registration warnings go into `warnings: string[]`.
- The activation outcome snapshot is `{ kind: 'completed'; outcome: 'done'; card_id; completed_at }`.
- The run outcome snapshot is `{ kind: 'completed'; result: 'done'; finished_at }`.

If a generated file claim is missing or unsafe, the outcome is downgraded. The existing guard converts it to failure through evidence-registration failure semantics; this design makes that policy explicit and testable through the commit function's validation path.

### Executor failure

- The commit function writes `{ status: 'failed'; result: ExecutorFailureResult; error: string; completed_at: string }`.
- `ExecutorFailureResult` has no `generated_files` field, so partial file claims cannot appear as success evidence.
- The activation outcome is `{ kind: 'completed'; outcome: 'failed'; card_id; error; completed_at }`.

### Executor needs verification

- The commit function writes `{ status: 'needs_verification'; result: ExecutorNeedsVerificationResult; error: null; completed_at: null }`.
- Preserved evidence is explicitly typed as untrusted/fallback.
- The activation outcome is `{ kind: 'paused'; reason: 'needs_verification'; card_id; detail }`.
- This state is intentionally nonterminal: no `completed_at`, no failure `error`, and no parent planner receives a completed child result until verification resolves.

### Reviewer pass

- The commit function writes `{ status: 'done'; result: ReviewerPassResult; error: null; completed_at: string }`.
- `ReviewerPassResult.planning` is explicitly `PlannerDoneResult | PlannerBlockedResult`. If the planner state was blocked, it is carried intentionally as historical context, not accidentally merged as the current goal state. The reviewer pass commit must clear the current blocked marker while preserving the historical planning result under `ReviewerPassResult.planning` or an attempt/history log.
- Evidence cards are validated for semantic completeness, not just existence and status.

### Reviewer needs corrections

- The assessment is persisted as a `ReviewerCorrectionResult` outside `CardLifecycleState.result`.
- The goal card status transitions back to `active` or `backlog`, not to a terminal state.
- No activation reports `done` to a parent planner.

### Planner done

- Planner completion is committed through `commitPlannerDone`, which writes a `CardLifecycleState` with `result: PlannerDoneResult`.
- If the goal has terminal child cards, reviewer scheduling is triggered.
- Planner blockage clears only when a valid outcome supersedes it.
- **Domain validation**: `PlannerDoneResult` in `DoneResult` is valid for planning-only cards (task cards whose type is not a parent goal). For parent goal cards, planner completion means children and review are still pending — `commitPlannerDone` must validate that the card type permits planner-done-as-terminal, and transition to `active` or `changed` instead of `done` for parent goals that still require child completion and review.

### Planner blocked

- The commit function writes `{ status: 'blocked'; result: PlannerBlockedResult; error: string; completed_at: null }`.
- The type guarantees that both outer `error` and `PlannerBlockedResult.blocked_reason` exist. It does not guarantee the strings are equal; `commitPlannerBlocked` must derive both values from one source or validate equality before writing.

## Invariants enforced by the data structure

These invariants move from ad hoc runtime checks to a mix of **typed construction guarantees** and runtime validation. TypeScript enforces the structural shape of values constructed as `CardLifecycleState`, `CardResult`, `ActivationOutcome`, or `RuntimeRunOutcome`. It does not validate persisted JSON, `unknown`/`any` values, broad object spreads, or relationships between separate records. The card store must validate loaded data against Zod schemas that mirror these types before trusting it.

Compile-time guarantees (enforced at every construction site):

- A `done` card has `error: null` — enforced by the `CardLifecycleState` discriminated union.
- A `done` card has `completed_at: string` — enforced by the discriminated union.
- A `failed` card has `error: string` — enforced by the discriminated union.
- A `done` card cannot carry `parse_failure` or `evidence_registration_failures` as active completion facts at typed construction/schema-validation boundaries because `ExecutorSuccessResult` has no such fields.
- A `done` card rejects unrelated keys in `result` when constructed through the commit API and validated schemas. `ReviewerPassResult.planning` may explicitly carry `PlannerBlockedResult` as intentional historical context; this is not an invariant violation because the type makes the state visible rather than accidentally merged.
- A `done` card's `result.generated_files` field exists only in `ExecutorSuccessResult` — enforced by the type union.
- A completed activation outcome has an internally valid terminal shape — enforced by the `ActivationOutcome` discriminated union. Matching it to the card's terminal status is enforced by the commit function and invariant observer.
- A completed runtime run outcome has an internally valid terminal shape — enforced by the `RuntimeRunOutcome` discriminated union. Matching it to the project card's terminal status is enforced by the commit function and invariant observer.

Runtime validation guarantees (enforced at deserialization for persisted state):

- Zod schemas that mirror the discriminated union types validate card JSON loaded from disk. Any card that violates the invariants (e.g. a `done` card with non-null `error`, or a `failed` card with empty `error`) is either normalized or rejected at load time.
- Historical state that predates the migration may not satisfy the new invariants. The load adapter normalizes missing or contradictory flat fields into valid `CardLifecycleState` branches, and logs warnings for manual review.
- Filesystem truths (file existence, path safety) and cross-entity alignment (activation/run matching) remain runtime checks.

Typed commit APIs prevent structural inconsistencies in new code paths. Zod validation prevents stale or corrupted persisted state from entering the runtime. Both are needed.

## Required code changes

### New type module

Add `src/schemas/lifecycle.ts` defining:

- `CardLifecycleState` discriminated union.
- `CardResult` and its variants (`ExecutorSuccessResult`, `ExecutorFailureResult`, `PlannerDoneResult`, `PlannerBlockedResult`, `ReviewerPassResult`, `ExecutorNeedsVerificationResult`).
- `ReviewerCorrectionResult` as a review-assessment result, not a card lifecycle result.
- `DoneResult`, `FailureResult`, `BlockedResult`, `NeedsVerificationResult` constrained result types.
- `ActivationOutcome` discriminated union.
- `RuntimeRunOutcome` discriminated union.
- `SelfReport` type.
- Zod schemas for every persisted lifecycle branch and result variant. These schemas are the runtime boundary for JSON loaded from disk; TypeScript types alone are not enough.

### New terminal-commit module

Add `src/runtime/terminal-commit/` with:

- `outcomes.ts` — `PhaseOutcome` variants and projection functions.
- `validators.ts` — `validateGeneratedFiles`, `validateTerminalOverlay`, `validateEvidenceCompleteness`.
- `commit-executor.ts` — `commitExecutorSuccess`, `commitExecutorFailure`, `commitExecutorParkedVerification`.
- `commit-reviewer.ts` — `commitReviewerPass`, `commitReviewerCorrection`.
- `commit-planner.ts` — `commitPlannerDone`, `commitPlannerBlocked`.
- `index.ts` — stable public API.

### Card store migration

- `src/cards/card-store.ts` gains read/write adapters that convert between the old flat `CardRecord` and the new `CardLifecycleState`-enriched record.
- The read adapter validates persisted JSON with the Zod lifecycle schemas before returning cards to runtime code. Historical invalid state is normalized only when the normalization is deterministic; otherwise the card is rejected with a diagnostic.
- New code writes through the discriminated union. Old code still reads the flat fields during migration.
- `src/cards/lifecycle.ts` gains lifecycle-state-aware validation: transitioning to `done` requires a `DoneResult`, transitioning to `failed` requires a non-empty error string.
- After all lifecycle writes go through commit functions, `ALWAYS_ALLOWED_FIELDS` is narrowed so phase code cannot directly patch `result`, `error`, or `completed_at` on completed, blocked, or parked cards.

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
- Planner completion and blockage state is committed through `commitPlannerDone` or `commitPlannerBlocked`.
- `src/runtime/phases/planner-invocation-failure.ts` uses `commitPlannerBlocked` instead of building its own patch.

### Runtime state machine

- `transitionCard()` continues validating allowed status paths.
- `observeRuntimeStateInvariants()` gains invariants that check `CardLifecycleState` alignment: `done` cards have `error === null`, `failed` cards have non-empty `error`, `needs_verification` cards have paused outcomes, completed activations match their card status at commit time, and root run outcomes match project card status at commit time.
- Root completion commits update `runtime_intent.status` and `RuntimeState.status` together with the root `RuntimeRunOutcome`; otherwise this design would not address the observed `runtime_intent: running` after root completion bug.
- `planProjectRootRedispatch()` uses root completion facts from snapshotted `RuntimeRunOutcome` and review state.

### Activation and run ledgers

- `src/runtime/activation-unwind.ts` and `src/runtime/activation-reducer.ts` gain an `ActivationOutcome` snapshot field: when a card transitions, the activation outcome is computed once from the new `CardLifecycleState` and then stored as historical data. Existing `RuntimeActivationRecord.status` remains a compatibility projection while clients migrate.
- `src/runtime/runtime-run-ledger.ts` gains a `RuntimeRunOutcome` snapshot field: when a run completes or pauses, its result is computed once from the card lifecycle state at commit time. Existing `RuntimeRunRecord.result` remains a compatibility projection while clients migrate.
- Parent planner tool results are generated from the activation outcome, not independently set.

### API and web UI

- Card read responses can expose both the flat legacy fields and the new `lifecycle` object during migration.
- Once all lifecycle writes go through the discriminated union, the flat fields become read-only derived fields for backward compatibility.
- Eventually the flat fields can be deprecated and removed in a later release.

## Migration plan

### Step 1: Introduce CardLifecycleState and CardResult types alongside the flat fields

Add `src/schemas/lifecycle.ts` with the discriminated union types and matching Zod schemas. Add read/write adapters in the card store that convert between flat `CardRecord` and the enriched structure. New code writes through the discriminated union; old code still reads the flat fields. The read adapter validates and normalizes historical JSON so runtime code never receives an invalid lifecycle branch. No behavior change yet beyond diagnostics for invalid persisted state.

### Step 2: Extract shared validators

Move `validateGeneratedFiles`, `validateTerminalOverlay`, and `validateEvidenceCompleteness` into `src/runtime/terminal-commit/validators.ts`. Call them from existing phase handlers alongside current patch builders. Add tests for each validator.

### Step 3: Introduce commit functions alongside patch builders

Add `commitExecutorSuccess`, `commitExecutorFailure`, `commitReviewerPass`, etc. alongside existing `buildExecutorCompletionPatch` and `buildReviewerPassCompletionPatch`. Phase handlers call the new commit functions. Old patch builders remain until all callers are migrated.

### Step 4: Migrate executor dispatcher

Replace `handleExecutorCompletion` and the executor activation dispatcher's direct patch calls with `commitExecutorSuccess`/`commitExecutorFailure`. These functions write `CardLifecycleState` instead of `Partial<CardRecord>`. Remove `buildExecutorCompletionPatch`.

### Step 5: Migrate reviewer assessment handler

Replace `handleReviewerAssessmentDecision`'s direct card transitions and runtime patches with `commitReviewerPass`/`commitReviewerCorrection`. Remove `buildReviewerPassCompletionPatch`.

### Step 6: Migrate planner lifecycle writes

Introduce `commitPlannerDone`/`commitPlannerBlocked` and migrate planner-result and planner-invocation-failure handlers.

### Step 7: Add lifecycle invariant observer

Extend `observeRuntimeStateInvariants()` to check `CardLifecycleState` alignment. Violations are logged but not auto-repaired. Once all lifecycle writes go through the discriminated union, invariant violations are expected to come from historical state, operator intervention, schema bugs, or code paths that still bypass the commit layer.

### Step 8: Tighten card mutation rules

After all phase paths use commit functions, narrow `ALWAYS_ALLOWED_FIELDS` to exclude `result`, `error`, and `completed_at` on completed, blocked, and parked cards that carry a `CardLifecycleState`. Leave explicit operator/admin repair paths.

### Step 9: Snapshot activation and run outcomes from card state

Add `RuntimeActivationRecord.outcome` and `RuntimeRunRecord.outcome` snapshots computed from the card's `CardLifecycleState` at commit time, using the `ActivationOutcome` and `RuntimeRunOutcome` discriminated unions. Keep `RuntimeActivationRecord.status` and `RuntimeRunRecord.result` as derived compatibility fields during migration. Do not recompute old activation or run outcomes from the card's current status on read; reopened cards must not rewrite history.

### Step 10: Deprecate flat terminal fields in the API

Once all clients read from the `lifecycle` object, the flat `status`, `error`, `completed_at`, and `result` fields can be deprecated and eventually removed.

## Testing strategy

- Add compile-time type tests for the `CardLifecycleState` discriminated union: verify that typed construction rejects a `done` state with `error: 'stale'` or a `failed` state without an error string.
- Add runtime tests showing the limits of TypeScript checks: JSON, `unknown`/`any`, and object spreads with stale terminal fields must be rejected or normalized by schemas/validators.
- Unit-test the Zod lifecycle schemas against persisted JSON examples: valid current cards, historical flat cards that can be normalized, invalid contradictory cards that must be rejected with diagnostics, and objects containing extra keys not allowed by the result variant.
- Unit-test each semantic validator with synthetic cards, files, and stale result objects.
- Unit-test `needs_verification` semantics: it has `error: null`, `completed_at: null`, a non-empty `NeedsVerificationResult.reason`, and paused activation/run outcomes.
- Unit-test `commitPlannerDone` domain validation: planning-only cards may complete with `PlannerDoneResult`, while parent goal cards with unresolved children transition to `active` or `changed` and schedule follow-up work instead of becoming `done`.
- Unit-test each commit function by checking the full set of side effects (lifecycle state, status transition, activation outcome, run outcome, events) against expected output, including equality/derivation checks such as outer blocked `error` matching `PlannerBlockedResult.blocked_reason`.
- Unit-test commit ordering with fake ports that record writes and simulate failures.
- Unit-test activation/run snapshot semantics: reopening or retrying a card does not mutate historical activation or runtime run outcomes.
- Add integration tests for: executor success, executor missing-file downgrade, executor fallback verification, reviewer invalid pass, reviewer valid pass, planner blocked recovery, and root completion reconciliation.
- Add regression tests for the observed inconsistency class: `done` plus stale error, `done` plus missing generated file, goal `done` plus active planning blockage, runtime idle plus running intent, and root run complete plus project card running.
- Add root completion regression tests that assert `runtime_intent.status`, `RuntimeState.status`, and the root `RuntimeRunOutcome` move together.
- Compile-time type tests cover typed construction mistakes; runtime tests cover persisted JSON, object-spread overlays, filesystem checks, and cross-entity checks.

## Open design questions

- Should `needs_verification` remain a paused/nonterminal runtime state permanently, or should a later operator workflow be able to convert it into a terminal failure after timeout or explicit rejection?
- How much historical failure data should remain accessible on a card after success, and under which field? The current design puts warnings in `ExecutorSuccessResult.warnings`, but review/failure details from prior attempts may need a separate history log.
- Should reviewer evidence cite card IDs only, or should it cite normalized evidence handles within card results?
- Which operator actions should be allowed to override terminal lifecycle state for manual repair, and should those overrides go through the commit functions or through a separate admin path?
- Should the `CardLifecycleState` discriminated union be persisted directly in the JSON card file, or should the card file continue to use flat fields during migration and only convert internally?

### Future direction: immutable CardAttempt and AttemptOutcome

The current design ties terminal state to the mutable `CardRecord`. This solves the immediate bug class (contradictory flat fields on the same card), but a card may undergo multiple executor attempts, review attempts, or planner blockage attempts over its lifetime. Reopening a card and transitioning it again overwrites the previous terminal state in-place.

A stronger model would introduce an immutable `CardAttempt` entity:

```ts
interface CardAttempt {
  attempt_id: string;
  card_id: string;
  role: 'planner' | 'executor' | 'reviewer';
  runtime_run_id: string | null;
  activation_id: string | null;
  started_at: string;
  finished_at: string | null;
  outcome: AttemptOutcome | null;
}

type AttemptOutcome =
  | { kind: 'executor_success'; generated_files: VerifiedGeneratedFile[]; payload: Record<string, unknown> }
  | { kind: 'executor_failure'; error: string; partial_payload: Record<string, unknown> | null }
  | { kind: 'planner_blocked'; blocked_reason: string; resume_reason: string }
  | { kind: 'planner_ready_for_review'; summary: string; child_card_ids: string[] }
  | { kind: 'reviewer_pass'; assessment_id: string; evidence_outcome_ids: string[] }
  | { kind: 'reviewer_needs_corrections'; assessment_id: string; issues: ReviewerIssue[] };
```

Under this model:
- `CardRecord.state` would reference the `attempt_id` and `outcome_id` of the current or terminal attempt, not embed the result directly.
- Activations and runtime runs would reference `attempt_id` and `outcome_id`, preventing drift when cards are reopened.
- Reviewer assessments would cite immutable `outcome_id`s, not mutable card IDs.
- The event log (`events.jsonl`) already captures attempt-level history, but first-class `CardAttempt` records would allow structured querying.

This is a larger scope change (new persistent entity, migration for activations/runs to reference `attempt_id`, card store CRUD) and is not a prerequisite for solving the current inconsistency class. The discriminated union approach in this document solves structural contradictions on the current card record. The `CardAttempt` model would solve historical integrity and cross-entity drift as a future step, once the current migration is stable.
