# Remove lifecycle compatibility bridges

This plan removes the backward-compatibility code left behind by the terminal lifecycle migration. The target is a clean Saivage v3 state model: lifecycle state is canonical, lifecycle results are typed, persisted JSON is validated strictly, and API/read-model code does not expose legacy flat-result projections.

The implementation assumes old Saivage v3 deployments and project runtime state will be wiped. There is no requirement to load old `.saivage/cards/by-id/*.json`, historical runtime ledgers, or pre-cleanup API responses. Do not add dual-shape adapters, migration normalizers, or compatibility parsing to preserve old deployments.

## Architecture Target

### Canonical Card Lifecycle

`CardRecord` should have one lifecycle source of truth.

```ts
interface CardRecord {
  id: string;
  type: CardType;
  parent: string | null;
  // structural/card metadata fields...
  status: CardStatus; // derived from lifecycle.status for indexing and filtering
  lifecycle: CardLifecycleState;
}
```

Keep top-level `status` as a derived denormalized field because indexing, filtering, transition checks, and operator summaries already use it heavily. It must always equal `lifecycle.status` and must not be independently mutable. Remove independent top-level `result`, `error`, and `completed_at` from `CardRecord`.

### Strict Typed Results

Lifecycle terminal results are closed discriminated unions. Arbitrary records may exist inside typed payload fields, but an arbitrary record is never itself a valid lifecycle result.

```ts
type CardResult =
  | ExecutorSuccessResult
  | ExecutorFailureResult
  | ExecutorNeedsVerificationResult
  | PlannerDoneResult
  | PlannerBlockedResult
  | ReviewerPassResult;

type DoneResult = ExecutorSuccessResult | PlannerDoneResult | ReviewerPassResult;
type FailureResult = ExecutorFailureResult;
type BlockedResult = PlannerBlockedResult;
type NeedsVerificationResult = ExecutorNeedsVerificationResult;
```

`ReviewerCorrectionResult` remains outside `CardResult`; corrections belong to review assessment/history, not the current card lifecycle result.

`ExecutorSuccessResult.executor`, `ExecutorNeedsVerificationResult.preserved_result`, and `ReviewerCorrectionResult.issues` may keep opaque record payloads, but use a clearly named schema such as `arbitraryRecordSchema`. Do not use that schema as a fallback lifecycle result variant.

### Strict Persisted-State Boundary

Card loading validates the canonical shape and rejects invalid data. It must not normalize historical shapes, fill missing errors, fill missing results, clear stale errors, or synthesize timestamps. Existing deployments will be wiped, so invalid persisted cards should fail fast with actionable diagnostics.

### Lifecycle Write Ownership

Lifecycle writes flow through explicit lifecycle commit or repair paths. Ordinary `CardStore.update()` and `mutateCard()` must not patch lifecycle-owned fields. Explicit repair paths may remain, but they write canonical lifecycle state and derived `status`, not legacy overlays.

### Runtime Ledgers

Runtime activations and runs currently carry both legacy terminal fields and `outcome_snapshot`. The target is one canonical outcome representation for historical facts. Live scheduling can keep a separate status/phase if needed, but terminal outcome facts must not be duplicated.

## Implementation Stages

### Stage 0: Clean-State Boundary

Files:
- Deployment/runbook docs as needed
- Test fixtures that depend on old card JSON

Changes:
- Document that old Saivage v3 runtime state must be wiped before deploying this cleanup.
- Do not write a compatibility converter.
- Do not preserve loading of historical card/result shapes.
- Keep fixtures only if they already use canonical lifecycle shape.

Acceptance:
- The implementation can reject all pre-cleanup card files.
- Operators have a clear reset/wipe step before using the new build.

### Stage 1: Make Persisted Card Loading Strict

Files:
- `src/schemas/lifecycle.ts`
- `src/cards/state.ts`
- `src/schemas/validators.ts`
- `tests/schemas/lifecycle.test.ts`

Changes:
- Delete `normalizePersistedCardLifecycle()` and `NormalizedPersistedCardLifecycle`.
- Delete `asResult()` and all logic that turns missing results into `{}`.
- Make `validatePersistedCardLifecycle()` strictly validate the current canonical shape and reject invalid data.
- Tighten `cardRecordSchema.result` at the persisted boundary. During the flat-field interim, it must validate as `cardResultSchema.nullable().optional()` rather than `z.record(...).nullable().optional()`.
- Change `parseCard()` to validate strict lifecycle state after `cardRecordSchema` parsing and throw on invalid lifecycle fields.
- Remove tests expecting load-time repair of invalid cards.
- Add negative tests for:
  - `done` with non-null `error`
  - `done` without valid result
  - `failed` without error
  - `blocked` without error
  - `needs_verification` with non-null `error`
  - missing required terminal `completed_at`

Acceptance:
- Loading invalid card JSON fails fast.
- No load path repairs lifecycle fields.

### Stage 2: Remove Legacy Result Fallbacks

Files:
- `src/schemas/lifecycle.ts`
- `src/schemas/index.ts`
- lifecycle schema tests

Changes:
- Delete `LegacyCardResult`.
- Remove arbitrary-record fallback variants from `CardResult`, `DoneResult`, `FailureResult`, `BlockedResult`, and `NeedsVerificationResult`.
- Remove arbitrary-record fallback members from `cardResultSchema`, `doneResultSchema`, `failureResultSchema`, `blockedResultSchema`, and `needsVerificationResultSchema`.
- Rename the record helper used by intentionally opaque payload fields to `arbitraryRecordSchema` or equivalent.
- Keep opaque payload fields only inside typed result variants:
  - `ExecutorSuccessResult.executor`
  - `ExecutorFailureResult.partial_result`
  - `ExecutorNeedsVerificationResult.preserved_result`
  - `ReviewerCorrectionResult.issues`
- Add negative tests proving arbitrary records are rejected as lifecycle results.

Acceptance:
- No lifecycle schema accepts `{}` or `{ planning: ... }` as a result unless it is inside a typed `kind` variant.
- `LegacyCardResult` is gone from public exports.

### Stage 3: Stop Emitting Legacy Result Overlays

Files:
- `src/runtime/terminal-commit/commit-executor.ts`
- `src/runtime/terminal-commit/commit-reviewer.ts`
- `src/runtime/terminal-commit/commit-planner.ts`
- `src/runtime/phases/planner-iteration-runner.ts`
- `src/runtime/phases/planner-invocation-failure.ts`
- `src/runtime/phases/reviewer-assessment-handler.ts`
- `tests/runtime/terminal-commit.test.ts`
- executor/reviewer/planner focused tests

Changes:
- In executor commits, remove result-level `success: true` and `success: false` overlays, including parked `needs_verification`.
- In reviewer pass, remove `reviewerPassPlanningFallback()` and `legacyPlanningProjection()`.
- Make `commitReviewerPass()` require typed planning context. If planning context is missing, throw a clear error.
- In planner commits, remove legacy `result.planning` embedding.
- Remove `preservedResult` and `planning` inputs from `commitPlannerBlocked()`.
- Update all callers that currently pass `preservedResult` or depend on fallback planning.
- Delete helper predicates that exist only to parse legacy reviewer/planner result records.
- Update `validateTerminalOverlay()` to use typed discriminants instead of untyped record-key checks. It should not reject `ReviewerPassResult.planning.kind === 'planner_blocked'`, because that is intentional historical context.

Acceptance:
- Commit helpers write only typed lifecycle results.
- No commit helper writes `result.success` or `result.planning.status`.
- No production caller depends on reviewer pass fallback planning.

### Stage 4: Remove Direct Lifecycle Field Patches Outside Commit Helpers

Files:
- `src/runtime/phases/planner-phase.ts`
- `src/runtime/startup-blocked-planning.ts`
- `src/runtime/startup-repair.ts`
- `src/runtime/activation-repair.ts`
- `src/runtime/phases/planner-failure-handler.ts`
- `src/runtime/runtime-reviewers-dispatcher.ts`
- `src/cards/card-store.ts`
- `src/cards/lifecycle.ts`

Changes:
- Remove or replace planner-phase patch builders that directly set `result`, `error`, `completed_at`, or terminal `status`.
- Make startup and repair paths write canonical lifecycle state through explicit repair helpers.
- Keep `repairTerminalLifecycle()` only as an explicit canonical lifecycle repair path.
- Remove the unused `_legacy` `CardStore` constructor parameter.
- Ensure `CardStore.update()` and `mutateCard()` reject lifecycle-owned field mutations except through commit/repair contexts.

Acceptance:
- Searches show no non-commit/non-repair `Partial<CardRecord>` writes to lifecycle-owned fields.
- Repair paths do not construct legacy result overlays.

### Stage 5: Persist Canonical `lifecycle`

Files:
- `src/schemas/types.ts`
- `src/schemas/lifecycle.ts`
- `src/schemas/validators.ts`
- `src/cards/card-store.ts`
- `src/cards/lifecycle.ts`
- `src/runtime/terminal-commit/lifecycle-patch.ts`
- runtime lifecycle callers
- card fixtures and tests

Changes:
- Add `lifecycle: CardLifecycleState` to `CardRecord`.
- Keep top-level `status` as derived from `lifecycle.status`.
- Remove top-level `result`, `error`, and `completed_at` from `CardRecord`.
- Rename `lifecyclePatch()` to a new helper such as `lifecycleCardPatch()` that returns `{ lifecycle, status: lifecycle.status }`.
- Update all commit and repair helpers to use the renamed helper.
- Replace `projectCardLifecycleState(card)` callers with direct `card.lifecycle` reads.
- Update runtime invariant checks to assert `card.status === card.lifecycle.status`.
- Update all `CardRecord` fixtures to include canonical `lifecycle`.

Acceptance:
- `CardRecord['result']` no longer exists.
- `projectCardLifecycleState()` is removed.
- New cards are created with canonical `lifecycle`.

### Stage 6: Migrate Runtime Code To Typed Lifecycle Reads

Files:
- `src/runtime/phases/planner-phase.ts`
- `src/runtime/planning-blockers.ts`
- `src/runtime/startup-blocked-planning.ts`
- `src/runtime/activation-repair.ts`
- `src/runtime/phases/executor-completion-handler.ts`
- `src/runtime/phases/executor-evidence.ts`
- `src/runtime/activation-unwind.ts`
- `src/runtime/context-builder.ts`
- `src/runtime/terminal-commit/validators.ts`
- `src/runtime/reviewer-assessment.ts`
- `src/runtime/phases/reviewer-phase.ts`
- `src/runtime/phases/reviewer-invocation-failure.ts`
- `src/agents/system-prompt.ts`

Changes:
- Replace untyped `card.result` reads with typed `card.lifecycle.result` discriminant checks.
- Replace `result.planning` prompt text with the typed lifecycle result shape.
- Replace `evidenceIdsFromResult()` with typed evidence extraction or explicit evidence parameters.
- Remove unsafe casts to `Record<string, unknown>` and `CardRecord['result']`.

Acceptance:
- Searches show no `CardRecord['result']`, `card.result`, `result.planning`, or `goal.result.planning` production references outside historical docs.
- Runtime code narrows lifecycle result by `kind`.

### Stage 7: Remove Read-Model/API Flat Compatibility

Files:
- `src/application/read-models/cards-read-model.ts`
- `src/contracts/operator-api-runtime-cards.ts`
- server route tests
- `web/src/stores/cards.ts`
- `web/src/api/types.ts`
- `web/src/api/contracts.ts`
- Vue components that read flat card lifecycle fields
- `tests/application/read-models.test.ts`

Changes:
- Stop returning flat `result`, `error`, and `completed_at` as independent card fields.
- Return canonical `lifecycle` and derived top-level `status`.
- Update web/UI and tests to consume `card.lifecycle.status`, `card.lifecycle.result`, `card.lifecycle.error`, and `card.lifecycle.completed_at`.
- Remove tests that assert backward-compatible flat fields.

Acceptance:
- Operator API and web UI use canonical lifecycle state.
- No read model synthesizes lifecycle from flat fields.

### Stage 8: Collapse Runtime Ledger Outcome Duplication

Files:
- `src/schemas/types.ts`
- `src/schemas/validators.ts`
- `src/runtime/runtime-core.ts`
- `src/runtime/runtime-run-ledger.ts`
- `src/runtime/activation-reducer.ts`
- `src/runtime/activation-unwind.ts`
- runtime ledger tests

Changes:
- Rename `outcome_snapshot` to canonical `outcome` if practical.
- Remove legacy terminal outcome duplication from run records (`result`) once all runtime code uses the canonical outcome.
- For activations, separate live scheduling status from terminal/historical outcome:
  - `status`: pending/running only if needed for live scheduling
  - `outcome`: done/failed/blocked/cancelled/needs_verification once no longer running
- Update invariant checks to validate canonical outcome only.

Acceptance:
- Runtime run and activation terminal outcomes are stored once.
- Historical outcome facts are not recomputed from mutable card state on read.

### Stage 9: Remove Non-Lifecycle Compatibility Parsers

Files:
- `src/schemas/validators.ts`
- `src/schemas/index.ts`
- `src/observability/event-logger.ts`
- event parsing tests

Changes:
- Remove `loggedEventCompatibilitySchema`, `LoggedEventCompatResult`, and `parseLoggedEventCompat()` unless a current non-compatibility requirement exists.
- Reject unknown event kinds instead of accepting them.

Acceptance:
- Event parsing is strict.

## Search Checklist

Before each commit, search for these strings and remove matches unless they are in this plan or historical docs:

```bash
rg "LegacyCardResult|legacyPlanningProjection|reviewerPassPlanningFallback|normalizePersistedCardLifecycle|asResult\(|result\.planning|goal\.result\.planning|CardRecord\['result'\]|card\.result|outcome_snapshot"
rg "result:\s*\{\s*\.\.\.result,\s*success|success:\s*(true|false)" src tests
```

The second search has expected false positives for tool/API success flags. Only result overlays are in scope.

## Tests To Delete Or Rewrite

- `tests/schemas/lifecycle.test.ts`: legacy persisted normalization tests.
- `tests/schemas/lifecycle.test.ts`: arbitrary flat planning result accepted by schema.
- `tests/runtime/terminal-commit.test.ts`: reviewer fallback planning context.
- `tests/runtime/terminal-commit.test.ts`: planner blocked preserving legacy nested planning metadata.
- `tests/application/read-models.test.ts`: backward-compatible flat card fields plus derived lifecycle.
- `tests/runtime/planner-phase.test.ts`: direct `card.result.planning` assertions.
- `tests/runtime/planning-blockers.test.ts`: `CardRecord['result']` helpers.
- `tests/utils/runtime-adapter-wiring.test.ts`: `card.result.success` assertions.
- Runtime ledger tests that assert `outcome_snapshot`, once Stage 8 runs.

## Validation Gates

Run after each stage:

```bash
npm run typecheck
NODE_OPTIONS=--experimental-vm-modules npx jest <focused-tests> --runInBand --forceExit
npm run build
```

Run after all stages:

```bash
npm run validate:routine
npm test -- --runInBand --forceExit
npm run validate:ui-smoke
npm run build
```

If web/API contracts change, run the relevant web tests and update operator API docs in the same commit.

## Risks

- Existing Saivage v3 runtime/card state will not load. This is intentional; deployments must be wiped/reset before using the new build.
- Removing flat API fields will break current web consumers unless they are updated in the same stage.
- Removing legacy run `result` fields may touch scheduler assumptions; keep runtime ledger cleanup as a dedicated stage.
- Strict result schemas may expose hidden code paths that still produce untyped records. Fix those producers rather than widening schemas.

## Definition Of Done

- Old deployments have been wiped/reset before the new build is used.
- No `LegacyCardResult` type exists.
- No lifecycle schema accepts arbitrary records as terminal results.
- Card load does not normalize invalid lifecycle fields.
- `CardRecord` stores canonical `lifecycle` plus derived `status`.
- Top-level `result`, `error`, and `completed_at` are removed from `CardRecord` and operator card responses.
- Commit helpers emit only typed lifecycle results.
- Reviewer/planner/executor code consumes typed result `kind` variants.
- Operator read models and web UI consume canonical lifecycle state.
- Lifecycle-owned mutation paths are explicit and minimal.
- Tests no longer assert compatibility behavior.
