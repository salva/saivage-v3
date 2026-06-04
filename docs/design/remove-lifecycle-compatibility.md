# Remove lifecycle compatibility bridges

This plan removes the backward-compatibility code left behind by the terminal lifecycle migration. The target is a simpler runtime model: lifecycle state is canonical, lifecycle results are typed, persisted JSON is validated strictly, and API/read-model code does not carry legacy flat-result projections.

## Architecture target

### Canonical card lifecycle

`CardRecord` should have one lifecycle source of truth. During the previous migration, flat fields (`status`, `result`, `error`, `completed_at`) stayed as the persisted shape and `CardLifecycleState` was projected from them. That was useful for migration, but it now creates two conceptual models.

Target shape:

```ts
interface CardRecord {
  id: string;
  type: CardType;
  parent: string | null;
  // structural/card metadata fields...
  lifecycle: CardLifecycleState;
}
```

If keeping top-level `status` is still useful for indexing and simple filtering, it must be derived from `lifecycle.status`, not independently mutable. There should be no independent `result`, `error`, or `completed_at` fields outside `lifecycle`.

### Strict typed results

Lifecycle results must be closed discriminated unions. No arbitrary record may satisfy a terminal result branch.

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

### Strict persisted-state boundary

Loading card JSON must validate strict lifecycle state. It must not normalize invalid historical shapes, fill missing errors, clear stale errors, or synthesize empty results. Invalid persisted cards should fail fast with an actionable diagnostic.

### Commit helpers own lifecycle writes

Lifecycle writes should flow through terminal/lifecycle commit helpers. Ordinary `CardStore.update()` and `mutateCard()` must not patch lifecycle-owned fields. Explicit repair paths may remain, but they should write canonical lifecycle state, not compatibility overlays.

### Runtime ledgers

Runtime activations and runs currently carry both legacy status/result fields and `outcome_snapshot`. The long-term target is a single outcome representation for historical facts. Live scheduling state may still need a separate phase/status field, but terminal outcome facts should not be duplicated.

## Removal stages

### Stage 1: Remove legacy result unions

Files:
- `src/schemas/lifecycle.ts`
- `tests/schemas/lifecycle.test.ts`

Changes:
- Delete `LegacyCardResult`.
- Remove `resultRecordSchema` from `cardResultSchema`, `doneResultSchema`, `failureResultSchema`, `blockedResultSchema`, and `needsVerificationResultSchema`.
- Make result aliases strict as shown in the architecture target.
- Remove tests that assert legacy flat result objects are valid lifecycle states.
- Add negative tests proving arbitrary records are rejected for terminal lifecycle results.

Expected fallout:
- Commit helpers and tests that still write `success`, `result.planning`, or preserved legacy blobs will fail until later stages.

### Stage 2: Remove persisted lifecycle normalization

Files:
- `src/schemas/lifecycle.ts`
- `src/cards/state.ts`
- `tests/schemas/lifecycle.test.ts`

Changes:
- Delete `normalizePersistedCardLifecycle()` and `NormalizedPersistedCardLifecycle`.
- Change `parseCard()` to call `validatePersistedCardLifecycle()` and return the parsed strict card.
- Remove tests that expect load-time repair of invalid cards.
- Add tests that invalid persisted cards fail fast:
  - `done` with non-null `error`
  - `failed` without error
  - `blocked` without error
  - `needs_verification` with non-null `error`
  - missing terminal `completed_at` where required

Implementation note:
- This stage may require test fixture updates. Do not add compatibility normalization for tests; fixtures should be corrected to canonical lifecycle state.

### Stage 3: Stop emitting legacy result overlays

Files:
- `src/runtime/terminal-commit/commit-executor.ts`
- `src/runtime/terminal-commit/commit-reviewer.ts`
- `src/runtime/terminal-commit/commit-planner.ts`
- `tests/runtime/terminal-commit.test.ts`
- executor/reviewer/planner focused tests

Changes:
- In executor commits, remove top-level `success: true` and `success: false` from `result` patches.
- In reviewer pass, remove `reviewerPassPlanningFallback()` and `legacyPlanningProjection()`.
- Make `commitReviewerPass()` require typed planning context. If planning context is missing, fail with a clear error.
- In planner commits, remove legacy `result.planning` embedding.
- Remove `preservedResult` and `planning` inputs from `commitPlannerBlocked()`.
- Ensure every commit helper writes exactly `lifecyclePatch(lifecycle)` plus non-lifecycle metadata (`status_text`, `latest_self_report`, etc.).

Required behavior after stage:
- `card.lifecycle.result.kind` is the way to distinguish result shape.
- No code should inspect `card.result.success` or `card.result.planning.status`.

### Stage 4: Move from flat lifecycle fields to canonical lifecycle object

Files:
- `src/schemas/types.ts`
- `src/schemas/lifecycle.ts`
- `src/schemas/validators.ts`
- `src/cards/card-store.ts`
- `src/cards/lifecycle.ts`
- `src/runtime/terminal-commit/lifecycle-patch.ts`
- read models and operator contracts

Changes:
- Add `lifecycle: CardLifecycleState` to `CardRecord`.
- Remove independent `result`, `error`, and `completed_at` from `CardRecord`.
- Decide whether `status` remains a top-level derived field. If it remains, enforce that `status === lifecycle.status` at schema boundaries and mutation boundaries.
- Replace `lifecyclePatch()` with a function that writes `{ lifecycle }` and, only if needed, derived `status`.
- Update card mutation validation to treat `lifecycle` as lifecycle-owned.
- Remove `projectCardLifecycleState()` once all callers read `card.lifecycle` directly.

Migration policy:
- No backward compatibility. Existing project state may need a one-time operator reset or explicit conversion script. Do not keep runtime adapters that accept both shapes.

### Stage 5: Remove read-model/API flat compatibility

Files:
- `src/application/read-models/cards-read-model.ts`
- `src/contracts/operator-api-runtime-cards.ts`
- server route tests and web client consumers
- `tests/application/read-models.test.ts`

Changes:
- Stop returning flat `result`, `error`, and `completed_at` as independent card fields.
- Return canonical `lifecycle`.
- Update web/UI and tests to consume `card.lifecycle.status`, `card.lifecycle.result`, `card.lifecycle.error`, and `card.lifecycle.completed_at`.
- Remove tests that assert backward-compatible flat fields.

### Stage 6: Collapse runtime ledger outcome duplication

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

This can be separate from card lifecycle cleanup if it is too broad for the first pass.

### Stage 7: Remove broader compatibility parsers where in scope

Files:
- `src/schemas/validators.ts`
- event parsing tests

Changes:
- Remove `loggedEventCompatibilitySchema`, `LoggedEventCompatResult`, and `parseLoggedEventCompat()` unless a current non-compatibility requirement exists.
- Reject unknown historical event kinds instead of accepting them.

This is not lifecycle-specific, but it violates the same rule.

## Known compatibility tests to delete or rewrite

- `tests/schemas/lifecycle.test.ts`: legacy persisted normalization tests.
- `tests/schemas/lifecycle.test.ts`: arbitrary flat planning result accepted by schema.
- `tests/runtime/terminal-commit.test.ts`: reviewer fallback planning context.
- `tests/runtime/terminal-commit.test.ts`: planner blocked preserving legacy nested planning metadata.
- `tests/application/read-models.test.ts`: backward-compatible flat card fields plus derived lifecycle.
- Any test expecting `card.result.success` or `card.result.planning.status`.

## Search checklist

Before each commit, search for these strings and remove matches unless they are in this plan or historical docs:

```bash
rg "LegacyCardResult|legacyPlanningProjection|reviewerPassPlanningFallback|normalizePersistedCardLifecycle|backward-compatible|compatibility|result\.planning|result\.success|success: true|success: false|outcome_snapshot"
```

`outcome_snapshot` may remain until Stage 6, but should be tracked as technical debt, not ignored.

## Validation gates

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

If web/API contract changes are included, also run the relevant web tests and update operator API docs in the same commit.

## Risks

- Existing `.saivage/cards/by-id/*.json` created before the cleanup may fail to load. This is acceptable under the no-backward-compatibility rule, but operators need a reset/conversion procedure.
- Removing flat API fields will break current web consumers unless they are updated in the same stage.
- Removing legacy run `result` fields may touch scheduler assumptions; keep that as a dedicated stage.
- Strict result schemas may expose hidden code paths that still produce untyped records. Fix those producers rather than widening schemas.

## Definition of done

- No `LegacyCardResult` type exists.
- No lifecycle schema accepts arbitrary records as terminal results.
- Card load does not normalize invalid lifecycle fields.
- Commit helpers emit only typed lifecycle results.
- Reviewer/planner/executor code consumes typed result `kind` variants.
- Operator read models expose canonical lifecycle state without flat compatibility fields.
- Lifecycle-owned mutation paths are explicit and minimal.
- Tests no longer assert compatibility behavior.
