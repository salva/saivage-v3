# Terminal commit layer


This document proposes a redesign of the Saivage v3 runtime layer that commits terminal agent outcomes to durable card, runtime-run, activation, review, and event state.

The design is motivated by a class of observed inconsistencies where a card can be marked `done` while still carrying stale failure data, claiming project files that do not exist, or causing reviewer/runtime state to diverge from the committed work. The immediate guardrails live in source, but the architectural fix is to make terminal completion a single semantic commit rather than a collection of phase-local patches.

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
- Ensure card status, card `result`, card `error`, `completed_at`, runtime runs, activation records, review assessments, and emitted events are committed as one planned operation.
- Reject or park invalid terminal claims before a card can become `done`.
- Keep agent contracts separate from storage contracts.
- Keep runtime recovery deterministic by deriving repair actions from one terminal commit model.
- Make common invariants easy to test without repeating integration scaffolding for every phase.
- Preserve JSON and JSONL storage; this proposal does not introduce a database or alternate persistence layer.

## Non-goals

- Rewriting the scheduler, event bus, server API, or card store in the same step.
- Changing the durable card JSON schema before the commit boundary exists.
- Adding backward compatibility adapters for old malformed runtime state beyond explicit recovery code.
- Making reviewer LLMs responsible for filesystem or ledger truth.
- Using prompts as the primary correctness mechanism.

## Proposed ownership model

The runtime should have a single terminal commit layer that sits between phase outcomes and durable mutations.

```text
Agent output
  -> contract parser
  -> phase outcome projector
  -> semantic validators
  -> terminal transition planner
  -> atomic-ish mutation commit
  -> ledger/event emission
```

Phase runners should stop building durable card patches directly. They should convert parsed agent output into typed domain outcomes. The terminal commit layer should decide what durable changes are legal and how they are applied.

## Core abstractions

### Phase outcome

`PhaseOutcome` is the normalized domain-level result of an agent phase. It is not a card patch and should not contain storage-specific merge behavior.

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

The important rule is that `kind: 'succeeded'` is a claim, not a commit. It becomes `status: 'done'` only if semantic validators pass.

### Terminal commit request

`TerminalCommitRequest` adds runtime context to a phase outcome.

```ts
interface TerminalCommitRequest {
  outcome: PhaseOutcome;
  currentCard: CardRecord;
  parentGoal: CardRecord | null;
  activeRun: RuntimeState['active_card_run'] | null;
  runtimeRun: RuntimeRunRecord | null;
  activation: RuntimeActivationRecord | null;
  projectRoot: string;
  now: string;
}
```

This request is read-only. It should gather the current state needed for validation and planning before any mutation is applied.

### Semantic validation result

Semantic validators convert a requested outcome into either an accepted commit or a rejection that has a deterministic fallback state.

```ts
type SemanticValidationResult =
  | { ok: true; normalized: NormalizedTerminalOutcome; evidence: ValidatedEvidence }
  | { ok: false; reason: string; fallback: TerminalFallback };
```

Validators should check facts that cannot be delegated to an LLM.

- Generated project files are relative to the project root and exist when the executor claims success.
- Project file claims do not point into `.saivage/`, `.saivage-work/`, secret-bearing files, or outside the project root.
- Process evidence artifacts and attachments point only to allowed `.saivage-work` metadata.
- A terminal success does not retain stale `error`, stale planning blockage, parse failure markers, or evidence-registration failure markers as active facts.
- Reviewer pass assessments cite committed evidence cards that are semantically complete, not merely cards with arbitrary `result` objects.
- Runtime run and activation records match the card and phase being completed.
- Root project completion is allowed only when the root goal has passed review and no child activation remains pending/running.

### Terminal transition plan

`TerminalTransitionPlan` is a pure description of all mutations and events needed to commit the normalized outcome.

```ts
interface TerminalTransitionPlan {
  cardStatusSteps: CardStatus[];
  cardPatch: Partial<CardRecord>;
  runtimeStatePatch: Partial<RuntimeState> | null;
  runtimeRunPatch: RuntimeRunPatch | null;
  activationPatch: RuntimeActivationPatch | null;
  reviewAssessmentWrite: ReviewAssessment | null;
  sessionToolResult: PlannerToolResultWrite | null;
  events: RuntimeEventWrite[];
  diagnostics: RuntimeDiagnosticWrite[];
}
```

The plan should be produced without writing to disk. This makes unit tests direct and exhaustive.

### Terminal committer

The committer applies a validated plan through existing ports.

```ts
interface TerminalCommitter {
  plan(request: TerminalCommitRequest): TerminalTransitionPlan;
  commit(plan: TerminalTransitionPlan): Promise<TerminalCommitReceipt>;
}
```

`commit()` should use the existing mutation port and stores. Saivage's JSON storage cannot provide a true cross-file transaction, but the committer can still be the single ordered write boundary.

The commit order should be deterministic.

1. Persist validation diagnostics that explain rejected success claims.
2. Apply card status transitions through the state machine or a card-transition port.
3. Apply the canonical card patch.
4. Update runtime run and activation records.
5. Persist review assessment if applicable.
6. Append planner tool result or activation unwind output.
7. Patch runtime state.
8. Emit durable events.

If a later write fails, recovery should be able to inspect the partial receipt and finish or roll forward the plan. Rollback across JSON files is not required for this design.

### Terminal evidence model

Evidence should be normalized before it reaches reviewers.

```ts
interface ValidatedEvidence {
  generatedFiles: Array<{ path: string; exists: true }>;
  processArtifacts: CardRecord['artifacts'];
  processAttachments: CardRecord['attachments'];
  verificationCommands: VerificationCommandEvidence[];
  warnings: string[];
}
```

Reviewers should cite evidence handles that the runtime can validate. A card with `status: 'done'` is not automatically sufficient if its result contains stale failure facts or only self-reported text.

## Terminal semantics by phase

### Executor success

An executor success can commit `done` only when all success evidence is valid.

- `error` is set to `null`.
- `completed_at` is set if missing.
- `result.executor` stores the agent-provided result.
- `result.latest_self_report` records the agent summary and status text.
- `result.generated_files` is normalized from the executor result and verified against the workspace.
- Evidence-registration warnings can be retained only as warnings if they do not invalidate success.
- Stale `parse_failure`, `evidence_registration_failures`, or active blockage markers must not remain as active completion facts.
- The child activation is completed with outcome `done`.
- The child runtime run is completed with result `done`.
- A `card_completed` or equivalent durable event is emitted.

If a generated file claim is missing or unsafe, the plan should convert the outcome to a failed or `needs_verification` terminal state according to policy. The current guard converts it to failure through evidence-registration failure semantics. A redesign can make this policy explicit as `TerminalFallback`.

### Executor failure

Executor failure should commit `failed` without pretending partial evidence is success.

- `error` is required and non-empty.
- `completed_at` is set if missing.
- Partial result may be retained under `result.executor.partial` or a similar non-success field.
- Generated file claims are treated as partial evidence, not success evidence.
- The child activation completes with outcome `failed`.
- The child runtime run completes with result `failed`.
- Parent planner receives a tool result that clearly reports failure and the error.

### Executor needs verification

`needs_verification` should be a first-class parked state, not an accidental blend of success and failure.

- `error` should explain why human or reviewer verification is required.
- `completed_at` should remain unset unless the state is considered terminal for runtime scheduling.
- Preserved evidence should be explicitly marked as untrusted or fallback-derived.
- Activation should park rather than report `done` to the parent planner.
- Runtime run status should distinguish parked verification from completed success.

### Reviewer pass

Reviewer pass should commit a goal completion only after cited evidence validates.

- The goal card transitions to `done` if not already done.
- `error` is set to `null`.
- `completed_at` is set if missing.
- `result.planning.status` becomes `done`.
- Any previous active planning blockage should be moved to historical review/planning notes or removed from active fields.
- The review assessment is persisted with its evidence IDs.
- The parent activation unwinds with outcome `done` if the reviewed goal was activated by another planner.
- The runtime state transitions out of reviewer phase.
- Root project run completion happens only when the reviewed goal is the project card and root completion invariants pass.

### Reviewer needs corrections

Reviewer corrections should not directly mutate the goal into success or failure.

- The assessment is persisted as a failed review.
- The goal remains available for planner correction.
- Runtime transitions back to planner phase.
- Planner context should include the concrete assessment issues.
- No activation should report `done` to a parent planner.

### Planner done

Planner `done` should mean the planner has no more planning actions for the current goal, not necessarily that the goal is complete.

- If the goal has terminal child cards, reviewer should be scheduled before final goal completion.
- If the planner is the root project planner, root runtime completion should still require reviewer pass or explicit no-review policy.
- Created and updated child cards should be committed through planner result application before terminal planner state changes.
- Planner blockage should clear only when a valid resumed or completed planner outcome supersedes it.

### Planner blocked

Planner blockage should be the only active owner of `result.planning.status: 'blocked'`.

- `error` should match the active blocked reason.
- `status_text` should be operator-readable.
- Runtime run should be blocked or idle according to whether retry is scheduled.
- Reviewer pass or executor success must not preserve active planner blockage markers.

## Required code changes

### New runtime module

Add `src/runtime/terminal-commit/` with small files rather than one large class.

- `outcomes.ts` defines `PhaseOutcome` variants.
- `request.ts` defines `TerminalCommitRequest` and context builders.
- `validators.ts` owns semantic validators for generated files, process evidence, stale failure facts, review evidence, activation/run matching, and root completion.
- `planner.ts` converts normalized outcomes into `TerminalTransitionPlan` objects.
- `committer.ts` applies plans through existing mutation ports.
- `receipt.ts` defines commit receipts and recovery hints.
- `index.ts` exports only the stable facade.

### Executor path

Replace phase-local terminal patching with outcome projection and commit calls.

- `src/runtime/phases/executor-phase.ts` should keep pure projection helpers, but stop building durable `Partial<CardRecord>` completion patches.
- `src/runtime/phases/executor-completion-handler.ts` should become unnecessary or shrink to a compatibility wrapper around `TerminalCommitter`.
- `src/runtime/phases/executor-evidence.ts` should keep low-level evidence validation helpers, but the terminal commit layer should decide whether validation errors imply `failed` or `needs_verification`.
- `src/runtime/executor-activation-dispatcher.ts` should invoke the executor, build an `ExecutorPhaseOutcome`, call `terminalCommitter.commitExecutorOutcome()`, and return the receipt summary.
- `src/contracts/executor-contract.ts` should remain an agent-envelope parser and projector, not a storage patch producer.

### Reviewer path

Move reviewer pass/fail state mutation into terminal commits.

- `src/runtime/reviewer-assessment.ts` should validate evidence with semantic evidence facts, not just card existence and status.
- `src/runtime/phases/reviewer-phase.ts` should stop building durable pass patches.
- `src/runtime/phases/reviewer-assessment-handler.ts` should persist or pass assessment data through the committer, not independently transition cards, patch runtime state, append unwind results, and emit events.
- Reviewer prompt contracts can continue asking for `evidence_card_ids`, but those IDs should be checked against committed evidence handles.

### Planner path

Planner commit migration should come after executor and reviewer because it has more creation/update behavior.

- `src/runtime/phases/planner-result-applier.ts` should remain responsible for card creation and allowed edits, but terminal planner status should be committed through the terminal layer.
- `src/runtime/phases/planner-phase.ts` should produce `PlannerPhaseOutcome` values rather than directly deciding final durable state.
- `src/runtime/phases/planner-invocation-failure.ts` should commit blocked/failure outcomes through the same semantic path as planned blockage.
- `src/agents/planner-control-executor.ts` should remain the owner of planner tool execution, but terminal status tool results should become phase outcomes rather than direct storage mutation when possible.

### Card lifecycle and store

Card storage should remain simple, but lifecycle rules should distinguish syntactic mutability from semantic commit authority.

- Keep `src/cards/lifecycle.ts` as the low-level mutation guard.
- Add a rule or convention that terminal fields are normally written only by the terminal committer.
- Consider narrowing `ALWAYS_ALLOWED_FIELDS` after the committer migration so arbitrary phase code cannot patch terminal `result`, `error`, or `completed_at` directly.
- Keep card status transitions delegated to `src/runtime/state-machine.ts` or a dedicated transition port so the terminal committer does not bypass allowed status movement.

### Runtime state machine

The state machine should remain the status and runtime-state transition authority, but it should not be the semantic terminal validator.

- `transitionCard()` should continue validating allowed status paths.
- `observeRuntimeStateInvariants()` should gain invariants that assume terminal commits are coherent.
- Runtime invariant logging should identify whether a violation is repairable by replaying a terminal commit receipt.
- `planProjectRootRedispatch()` should use root completion facts from committed runtime runs and review state, not just coarse runtime intent.

### Runtime run ledger and activation unwind

Runtime run and activation updates should be planned alongside card commits.

- `src/runtime/runtime-run-ledger.ts` should expose idempotent patch operations that the committer can call.
- `src/runtime/activation-unwind.ts` should provide write primitives, but outcome selection should move into the terminal plan.
- `src/runtime/activation-reducer.ts` should remain a pure reducer for activation state, while terminal commit planning decides when to call it.
- Parent planner tool results should be generated from terminal receipts so they reflect exactly what was committed.

### Events and diagnostics

Event emission should become part of the terminal plan.

- Success, failure, parked verification, review pass, review correction, and root completion events should be derived from `TerminalTransitionPlan.events`.
- Rejected success claims should emit diagnostics before fallback commit.
- Error logging should use structured codes such as `terminal_commit_validation_failed`, `terminal_commit_partial_write`, and `terminal_commit_recovery_required`.
- Operator UI can then explain terminal decisions without parsing arbitrary status text.

### Server API and web UI

The API does not need a large first migration, but it can benefit from exposing terminal commit facts.

- Card responses can include normalized evidence availability derived from committed evidence.
- Debug routes can expose terminal commit receipts and validation failures.
- The card detail UI can show why a claimed success was downgraded to failure or parked for verification.
- Runtime state views can show active run, activation, and terminal receipt alignment.

## Invariants to enforce

The redesigned layer should make these invariants testable and eventually observable.

- A `done` card has `error === null`.
- A `done` terminal card with `result.generated_files` references only existing project-root-relative files.
- A `done` goal card does not carry active `result.planning.status: 'blocked'`.
- A reviewer `pass` assessment cites at least one semantically valid evidence card.
- A completed child activation has a matching terminal child runtime run.
- A completed child runtime run has a matching terminal card status.
- A root runtime run cannot be `done` while the project card is still `running`.
- Runtime intent cannot remain `running` after a root run completes unless a new root run has been started.
- A terminal commit emits exactly one durable terminal event for the card/run pair.
- A failed terminal commit is recoverable by receipt replay or by a deterministic repair diagnostic.

## Migration plan

### Step 1: Introduce pure terminal planning for executor outcomes

Add the new module and migrate executor success/failure/needs-verification handling first. Keep existing storage schemas. Tests should cover the full plan for success, missing generated files, unsafe generated files, evidence registration failure, executor failure, and fallback evidence.

### Step 2: Route executor dispatcher through the committer

Replace executor completion handler calls with terminal committer calls. Keep old helper tests until equivalent terminal-plan tests exist, then remove redundant patch-builder tests.

### Step 3: Migrate reviewer pass/correction handling

Move reviewer pass and correction durable mutations into terminal plans. Strengthen evidence validation so reviewer pass cannot cite stale failed cards or cards whose success evidence is invalid.

### Step 4: Add runtime-run and activation receipt alignment

Make terminal plans update card status, runtime run status, activation status, and parent planner tool results together. Add recovery tests for interrupted commit order.

### Step 5: Migrate planner terminal states

Move planner blocked/done/failure terminal handling into the same commit layer. Keep card creation and update application separate, but commit final planner semantics centrally.

### Step 6: Tighten card mutation rules

After phase paths stop directly writing terminal fields, narrow direct mutation access for `result`, `error`, and `completed_at` on terminal cards. Leave explicit operator/admin repair paths if needed.

### Step 7: Expose receipts and diagnostics

Add debug/operator surfaces for terminal commit receipts, rejected success claims, and repair diagnostics.

## Testing strategy

- Unit-test semantic validators with synthetic cards, runtime runs, activations, generated files, unsafe paths, and stale result objects.
- Unit-test terminal planners by comparing complete `TerminalTransitionPlan` objects.
- Unit-test commit ordering with fake ports that record writes and simulate failures.
- Add integration tests for executor success, executor missing-file downgrade, executor fallback verification, reviewer invalid pass, reviewer valid pass, planner blocked recovery, and root completion reconciliation.
- Add regression tests for the observed inconsistency class: `done` plus stale error, `done` plus missing generated file, goal `done` plus active planning blockage, runtime idle plus running intent, and root run complete plus project card running.
- Keep `npm run validate:routine` as the routine gate and run focused Jest suites during migration.

## Open design questions

- Should missing generated files always fail executor completion, or should some cases park the card as `needs_verification`?
- Should `needs_verification` be a terminal runtime-run result or a paused/nonterminal runtime-run state?
- How much historical failure data should remain on a card after success, and under which field should it live?
- Should reviewer evidence cite card IDs only, or should it cite normalized evidence handles within card results?
- Should terminal commit receipts be persisted in a dedicated JSONL ledger from the start, or introduced after executor/reviewer migration?
- Which operator actions should be allowed to repair terminal fields after the committer owns them?

## Expected outcome

After this redesign, phase code will no longer assemble durable terminal patches. Agent outputs will be treated as claims, semantic validators will decide whether claims can commit, and one terminal committer will write card status, result, error, completed time, runtime run state, activation state, review state, parent tool results, diagnostics, and events in a consistent order.

This is a better boundary than adding checks in each phase because it makes invalid terminal states difficult to represent and straightforward to test.
