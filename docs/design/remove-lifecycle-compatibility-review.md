# Review: Remove lifecycle compatibility bridges plan

This review audits `docs/design/remove-lifecycle-compatibility.md` against the current codebase. Findings are grouped by severity and category.

---

## Structural issues

### S1. Stage ordering is unsafe — Stage 1 will break production callers that are not addressed until Stage 3

Stage 1 removes `LegacyCardResult` from the result type unions and removes `resultRecordSchema` from `cardResultSchema`, `doneResultSchema`, `failureResultSchema`, `blockedResultSchema`, and `needsVerificationResultSchema`. The plan acknowledges that "commit helpers and tests that still write `success`, `result.planning`, or preserved legacy blobs will fail until later stages."

But it is not just tests. Production code in `commit-executor.ts` (lines 47, 71, 94) spreads `{ ...result, success: true }` into card patches. These patches flow through `lifecyclePatch()` into `Partial<CardRecord>`. If `cardResultSchema` rejects arbitrary records, the commit functions will still *produce* valid `ExecutorSuccessResult` etc. objects — the schema tightening will not break their TypeScript compilation. The break is more subtle: `commit-reviewer.ts` line 15 calls `reviewerPassPlanningFallback(input.card, input.reviewSummary)` which reads `card.result` as an arbitrary record and produces a typed `PlannerDoneResult | PlannerBlockedResult`. If `card.result` was loaded through `normalizePersistedCardLifecycle` (which fills empty `{}` for missing results), and then `cardResultSchema` rejects `{}`, the Zod parse inside `projectCardLifecycleState` will reject it. This means **loading any historical card with `result: {}` or `result: null` will throw** once `cardResultSchema` no longer accepts `resultRecordSchema`.

This is not just a test concern. `parseCard()` at (state.ts) calls `normalizePersistedCardLifecycle()` which fills empty `{}` for null results on `done`/`failed`/`blocked`/`needs_verification` cards. If Stage 1 is applied before Stage 2 replaces normalization with strict validation, **any persisted card with `status: 'done'` and `result: null` (which is normalized to `{}`) will fail to load**, because `doneResultSchema` will reject `{}` once `resultRecordSchema` is removed from the union.

**Recommendation**: Swap Stage 1 and Stage 2. Remove normalization first (making load fail fast on invalid cards), then tighten the type schemas. Or merge Stages 1 and 2 into a single atomic change that removes both `LegacyCardResult` and `normalizePersistedCardLifecycle` simultaneously, with a one-time fixture/script to convert existing cards.

### S2. Stage 3 does not enumerate production callers that must change when commit helper signatures change

Stage 3 says to remove `preservedResult` and `planning` inputs from `commitPlannerBlocked()` and make `commitReviewerPass()` require typed planning context. The callers that pass these arguments are:

| Caller | File | Line | Argument passing |
|--------|------|------|------------------|
| `commitPlannerBlocked` | `planner-iteration-runner.ts` | 114 | `preservedResult: card.result` |
| `commitPlannerBlocked` | `planner-invocation-failure.ts` | 85 | `preservedResult: input.currentCard.result` |
| `commitPlannerBlocked` | `terminal-commit.test.ts` | 125, 202 | test data |
| `commitReviewerPass` | `reviewer-assessment-handler.ts` | 64 | indirection through callers |

The plan's Stage 3 file list covers `commit-executor.ts`, `commit-reviewer.ts`, `commit-planner.ts`, and tests, but does not list `planner-iteration-runner.ts`, `planner-invocation-failure.ts`, or `reviewer-assessment-handler.ts` — all of which are production callers that will have TypeScript compilation errors when the commit helper signatures change.

Additionally, (commit-executor.ts) spreads `{ ...result, success: true }` for `commitExecutorParkedVerification`, but Stage 3 description only mentions removing `success: true/false` from "executor commits" generically without calling out the `needs_verification` case.

**Recommendation**: Add an exhaustive caller enumeration per commit helper to Stage 3.

### S3. Stage 4 is the widest-impact stage but has the least detail

Stage 4 changes `CardRecord` to add a `lifecycle` field and remove independent `result`, `error`, `completed_at`. This is a **schema-breaking change** that touches:

- Every file that reads `card.result` (20+ production sites)
- Every file that reads `card.error` (10+ production sites)
- Every file that reads `card.completed_at` (5+ production sites)
- The Zod `cardRecordSchema` at (validators.ts)
- The runtime invariant observer at (runtime-core.ts)
- The card mutation validation at (lifecycle.ts)
- The web API contracts and Vue stores
- All test fixtures that construct `CardRecord` objects

The plan says "Decide whether `status` remains a top-level derived field" but does not resolve this. If `status` stays as a top-level field derived from `lifecycle.status`, every spread `{ ...card, ...changes }` in `buildUpdatedCard` (which is how every card update works today) must ensure the derivation is maintained, or `lifecyclePatch()` must set both. If `status` is removed from `CardRecord`, every consumer that groups, filters, or indexes by `card.status` must change.

The plan also says "Remove `projectCardLifecycleState()` once all callers read `card.lifecycle` directly" but currently only (cards-read-model.ts), (startup-run-reconciliation.ts), and (activation-unwind.ts) call it. This is fewer callers than expected, but the web layer reads `card.lifecycle` from API responses — removing the projection from the read model means the API must start sending `lifecycle` in card responses, which is a contract change.

**Recommendation**: Split Stage 4 into at least two sub-stages: (4a) add `lifecycle` to `CardRecord` as a derived/redundant field alongside existing flat fields; (4b) migrate all consumers to read from `lifecycle`; (4c) remove flat fields from `CardRecord`. This avoids a big-bang change where every file must compile simultaneously.

### S4. `asResult()` helper continues the normalization problem

The `asResult()` function at (lifecycle.ts) converts `null`/`undefined` card results to `{}` for `done`/`failed`/`blocked`/`needs_verification` status values in `projectCardLifecycleState`. This is the same silent-fill behavior that `normalizePersistedCardLifecycle` does, but it lives in the projection path rather than the load path.

Stage 2 targets `normalizePersistedCardLifecycle` but does not mention `asResult()`. If `normalizePersistedCardLifecycle` is removed and `projectCardLifecycleState` still calls `asResult()` for `done`/`failed`/`blocked`/`needs_verification`, then cards with `result: null` in those statuses will silently produce `{}` as the lifecycle result — which defeats the "fail fast" goal.

**Recommendation**: Add `asResult()` to the Stage 2 removal list. After strict validation, a `done`/`failed`/`blocked`/`needs_verification` card with `result: null` should fail, not silently produce an empty record.

### S5. `resultRecordSchema` has uses beyond the type unions

The plan says to remove `resultRecordSchema` from `cardResultSchema`, `doneResultSchema`, etc., but `resultRecordSchema` is also used for:

- `ExecutorSuccessResult.executor` (line 124): accepts `Record<string, unknown>` — an intentionally opaque executor payload
- `ExecutorNeedsVerificationResult.preserved_result` (line 141): accepts `Record<string, unknown>` — an intentionally opaque preserved state
- `ReviewerCorrectionResult.issues` (line 170): accepts `Array<Record<string, unknown>>` — intentionally opaque issue records

These are not "legacy fallback" positions; they are fields where the result type genuinely carries arbitrary data. The plan should clarify whether `resultRecordSchema` is removed entirely or retained under a different name for these specific typed uses.

Similarly, `nullableResultRecordSchema` (line 5) is derived from `resultRecordSchema`. Removing the base schema without updating these references will break compilation.

**Recommendation**: Either (a) rename `resultRecordSchema` to something like `arbitraryRecordSchema` and keep it for the intentionally-opaque fields, or (b) introduce more specific schemas (e.g., `executorPayloadSchema`, `preservedResultSchema`) for each field. Document this choice in Stage 1.

---

## Missing scope items

### M1. `cardRecordSchema.result` in validators.ts is not addressed

`validators.ts` defines `result: z.record(z.string(), z.unknown()).nullable().optional()` — this Zod schema is what validates persisted card JSON at the store's load boundary. It accepts any record.

Removing `resultRecordSchema` from the lifecycle type unions (Stage 1) does not change `cardRecordSchema.result`. Cards with `result: { any: 'garbage' }` will still load successfully and produce an untyped `CardRecord` — and then fail at the lifecycle projection step.

**Recommendation**: Add `cardRecordSchema.result` to Stage 4 (or Stage 2) and document that the persisted-card Zod schema must tighten from `z.record(z.string(), z.unknown()).nullable().optional()` to `cardResultSchema.nullable()` or equivalent.

### M2. Planner-phase patches bypass commit helpers

The following functions in `planner-phase.ts` set `result`, `error`, and other lifecycle fields directly on `Partial<CardRecord>` without going through any commit helper or `lifecyclePatch`:

| Function | Lines | Fields set |
|----------|-------|------------|
| `buildPlannerContinuePatch` | 153-189 | `error`, `result` |
| `buildPlannerActivationPlanningPatch` | 401-435 | `error`, `result`, `status_text` |
| `buildProjectPlannerRetryPatch` | 438-467 | `status`, `error`, `result`, `status_text` |

The architecture target says "Lifecycle writes should flow through terminal/lifecycle commit helpers" and "Ordinary `CardStore.update()` and `mutateCard()` must not patch lifecycle-owned fields." But the plan does not enumerate these functions or assign them to any stage.

**Recommendation**: Add an explicit stage or sub-step to migrate these planner-phase patch builders to use commit helpers or `lifecyclePatch`. Without this, lifecycle-locked fields (`result`, `error`) can still be written by planner-phase code after Stage 5 locks direct patching.

### M3. Startup/repair paths set lifecycle fields outside commit helpers

Multiple non-commit sites write lifecycle fields on cards undergoing repair or startup reconciliation:

| File | Lines | Pattern |
|------|-------|---------|
| `startup-blocked-planning.ts` | 29-37 | `repairTerminalLifecycle(id, { status: 'blocked', error, result: { ..., planning } })` |
| `startup-blocked-planning.ts` | 62-66 | `repairTerminalLifecycle(id, { status: 'blocked', error, status_text })` |
| `startup-repair.ts` | 209-212 | `updateCard(card_id, { error, result: { ..., failure_kind, error } })` |
| `activation-repair.ts` | 44-45 | Reads `result.review` as untyped record |

`repairTerminalLifecycle` is called with `reason: 'terminal lifecycle repair'` which is in the `EXPLICIT_LIFECYCLE_WRITE_REASONS` allowlist at (lifecycle.ts). After Stage 4/5, these repair paths must write canonical `lifecycle` state, not flat fields.

**Recommendation**: Enumerate `startup-blocked-planning.ts`, `startup-repair.ts`, and `activation-repair.ts` in the stage that tightens card mutation rules, and specify that they must write `{ lifecycle }` patches with the explicit repair reason rather than `{ result, error }` patches.

### M4. `system-prompt.ts` must reference canonical lifecycle state

`src/agents/prompts/system-prompt.ts:56` tells the planner that planning state lives in canonical `lifecycle.result`. Earlier drafts referenced `goal.result.planning`; after lifecycle compatibility removal, prompt text must continue to point at canonical lifecycle state rather than flat result fields.

**Recommendation**: Add `system-prompt.ts` to the Stage 4 file list and update the prompt to reference the new result shape.

### M5. `CardRecord['result']` type remains `Record<string, unknown> | null` in many places

The audit found 14+ production sites that use `CardRecord['result']` as a type, and 6+ sites that cast `card.result` to `Record<string, unknown>` with `as`. The plan's Stage 4 removes the `result` field from `CardRecord`, but does not enumerate these read sites or describe the migration path for each.

Key sites that read `card.result` as an untyped record:

- `planner-phase.ts`: reads `result.planning`, casts to `CardRecord['result']`
- `startup-blocked-planning.ts`: spreads `...(card.result ?? {})`, reads `result.planning`
- `activation-repair.ts`: reads `result.review`
- `context-builder.ts`: reads `result.review`, `goal.result.review`
- `executor-evidence.ts`: reads `result.generated_files`
- `executor-completion-handler.ts`: calls `recordResult(card.result)` to spread into outcome
- `activation-unwind.ts`: reads `result.failure_kind`, `result.review`
- (validators.ts): reads `result.evidence_card_ids`, `result.review.evidence_card_ids`

**Recommendation**: Create a migration checklist for each of these sites in Stage 4. Some can use the typed result's `kind` discriminant to narrow; others (like `evidenceIdsFromResult`) need a different access pattern entirely.

### M6. Web/UI consumers are not enumerated

The plan's Stage 5 mentions "server route tests and web client consumers" generically but does not list the specific files. The audit found:

- `web/src/stores/cards.ts:207` — reads `response.lifecycle`
- `web/src/stores/cards.ts:310, 319` — receives flat `CardRecord` from WebSocket
- `web/src/api/types.ts` — extends `CardRecord` with optional fields
- `web/src/api/contracts.ts:100` — imports `CardRecord`

The web layer currently reads `card.status`, `card.error`, `card.completed_at`, and `card.result` as flat fields across multiple components. Stage 5 must enumerate these consumers.

**Recommendation**: Add explicit file list to Stage 5.

### M7. `repairTerminalLifecycle` in CardStore is not addressed

`CardStore.repairTerminalLifecycle()` at (card-store.ts) is called by startup repair, planner failure handler, runtime reviewers dispatcher, and activation repair. It writes `Partial<CardRecord>` patches with lifecycle fields through `EXPLICIT_LIFECYCLE_WRITE_REASONS`. After Stage 5, this path must also write canonical `lifecycle` objects, not flat field patches.

**Recommendation**: Add `repairTerminalLifecycle` and its callers to the stage that tightens mutation rules.

### M8. `_legacy` constructor parameter in CardStore is dead code

`CardStore` constructor at (card-store.ts) has `_legacy?: unknown` which is unused. The plan identifies this in the Key Decisions section but does not assign it to any stage.

**Recommendation**: Add this trivial removal to Stage 1 or as a pre-stage cleanup.

---

## Design concerns

### D1. The plan should resolve the `status` question before execution

Stage 4 says "Decide whether `status` remains a top-level derived field." This is a critical architectural decision that affects every consumer of `CardRecord`. If `status` becomes derived from `lifecycle.status`, then:
- Every spread `{ ...card, ...changes }` must also update the derived `status`.
- The invariant observer must validate `card.status === card.lifecycle.status` at boundaries.
- The card index (`byStatus`) and API query parameters will still need `status` to be present on the record.

If `status` is removed from `CardRecord`, every indexing, filtering, and grouping operation must change. This decision should not be left open in Stage 4.

**Recommendation**: Resolve this upfront. The simpler path is to keep `status` as a derived field that is always set alongside `lifecycle`, with an invariant check that they match. This avoids changing every `card.status` consumer in one shot.

### D2. `lifecyclePatch` should be replaced, not just modified

Currently `lifecyclePatch()` returns `Pick<CardRecord, 'status' | 'result' | 'error' | 'completed_at'>` and is spread into `Partial<CardRecord>` patches alongside other fields. After Stage 4, this function should return `{ lifecycle: CardLifecycleState }` and optionally `{ status: CardStatus }` (if `status` stays derived). The plan mentions this ("Replace `lifecyclePatch()` with a function that writes `{ lifecycle }` and, only if needed, derived `status`") but this is a high-risk change: every spread `{ ...lifecyclePatch(lifecycle), ...extra }` must become `{ ...lifecyclePatch(lifecycle), ...extra }` with a different return shape, or the function must be renamed to avoid silent type coercion.

**Recommendation**: Rename `lifecyclePatch` to something like `lifecycleCardPatch` that returns the new shape, and update all 6 call sites explicitly.

### D3. The Zod schema at load time must validate the canonical shape, not project and normalize

The plan's Stage 2 says "Change `parseCard()` to call `validatePersistedCardLifecycle()` and return the parsed strict card." But `validatePersistedCardLifecycle()` currently just calls `projectCardLifecycleState()`, which calls `asResult()` for `null` results. So `validatePersistedCardLifecycle` will still silently fill empty results on `done`/`failed`/`blocked`/`needs_verification` cards unless `projectCardLifecycleState` is also changed.

After Stage 2, the load path should be:
1. Parse card JSON through a strict `cardRecordSchema` that validates `result` as `cardResultSchema.nullable()`.
2. Validate that the flat fields are consistent with lifecycle invariants (no `done` + non-null `error`, etc.).
3. Reject cards that fail strict validation with clear diagnostics.
4. Do not normalize or fill missing fields.

**Recommendation**: Make Stage 2 explicitly replace `validatePersistedCardLifecycle` → `projectCardLifecycleState` → `asResult` with a single strict validation that fails on invalid cards, with a documented operator procedure for resetting or converting existing project state.

### D4. `validateTerminalOverlay` in `validators.ts` checks flat `result.planning.status` — this should check `lifecycle.result.kind`

(validators.ts) checks `Done lifecycle must not carry stale result.planning.status='blocked'`. This reads `lifecycle.result` and uses `hasRecordKey` / `recordValue` helper functions that treat the result as an untyped record. After Stage 1, `lifecycle.result` should be a typed discriminated union, and this check should be `lifecycle.result.kind === 'reviewer_pass' && lifecycle.result.planning.kind === 'planner_blocked'` — which is valid (per the design doc's intentional historical context rule). The validator should probably not reject this case at all after typed results.

**Recommendation**: Add `validateTerminalOverlay` validators update to Stage 1 or Stage 3, noting that `hasRecordKey(result, 'parse_failure')` and `recordValue(result, 'planning')` must be replaced with typed discriminant checks.

### D5. The plan does not address `evidenceIdsFromResult` in `validators.ts`

(validators.ts) has `evidenceIdsFromResult()` which reads `result.evidence_card_ids` and `result.review.evidence_card_ids` from `CardRecord['result']` as untyped records. After Stage 4, result access should use typed discriminants.

**Recommendation**: Add to Stage 4 or Stage 5 file list.

---

## Risk amplification

### R1. No migration or reset procedure for existing project state

The plan acknowledges "Existing `.saivage/cards/by-id/*.json` created before the cleanup may fail to load. This is acceptable under the no-backward-compatibility rule, but operators need a reset/conversion procedure." But no such procedure is provided or sketched.

Without a conversion script, any existing Saivage project that has cards with `result: null` on done/failed/blocked cards, or `result: { success: true }` on executor-completed cards, or `result: { planning: { status: 'done' } }` on planner-completed cards, will fail to load after Stage 2.

**Recommendation**: Add a pre-stage that writes and documents a one-time conversion script (or `CardStore` upgrade method) that migrates existing cards to canonical lifecycle state. This script should:
1. Load cards through `cardRecordSchema`.
2. Project flat fields to `CardLifecycleState` using `projectCardLifecycleState`.
3. Replace `result` with the typed variant (add `kind` discriminant where missing).
4. Remove `success`, `planning.status`, and other legacy overlays.
5. Write back the canonical card JSON.
6. Log which cards were converted and what changed.

### R2. Stage 5 (API contract change) requires coordinated web deployment

Removing flat `result`, `error`, `completed_at` from API responses is a breaking API change. The web UI and any other consumers must be updated to read `card.lifecycle.result`, `card.lifecycle.error`, etc. in the same commit that changes the API contract. The plan mentions this briefly under "Risks" but does not specify a deployment coordination strategy.

**Recommendation**: Stage 5 should be deployed as a single commit that changes the API contract, the read model, and all web consumers simultaneously. Alternatively, add `lifecycle` to the API first (non-breaking) and then remove flat fields after web consumers are migrated.

---

## Minor issues

### m1. The search checklist regex is too broad

The plan's search checklist includes `success: true` and `success: false`, which produces false positives in test code, web UI toast messages, and tool-result success flags that are not card lifecycle results. The audit found `success: true` in `analyst-handler.ts`, `analyst-tools.ts`, and `planner-control-executor.ts` — all of which are tool-return success flags, not card result fields.

**Recommendation**: Narrow the search to `result.*success: true` or `result: { ...result, success` to avoid noise.

### m2. `loggedEventCompatibilitySchema` (Stage 7) is a different concern from lifecycle

The plan puts `parseLoggedEventCompat` removal in Stage 7 and acknowledges "This is not lifecycle-specific, but it violates the same rule." Mixing concerns across stages increases the blast radius of each stage. If Stage 7 breaks historical event parsing, it is a separate domain from card lifecycle.

**Recommendation**: Consider separating the event compatibility parser removal into its own PR or plan that can be executed independently. It does not block or depend on the lifecycle migration.

### m3. Test fixture breadth is underestimated

The plan lists 6 test files under "Known compatibility tests to delete or rewrite," but the audit found additional test sites that read or assert flat card fields:

- `tests/runtime/terminal-commit.test.ts` (listed)
- `tests/schemas/lifecycle.test.ts` (listed)
- `tests/application/read-models.test.ts` (listed)
- `tests/runtime/planner-phase.test.ts` (not listed — reads `card.result!.planning`)
- `tests/runtime/planning-blockers.test.ts` (not listed — constructs cards with `CardRecord['result']`)
- `tests/runtime/runtime-core.test.ts` (not listed — asserts `outcome_snapshot`)
- `tests/utils/runtime-adapter-wiring.test.ts` (not listed — asserts `card.result.success`)
- `tests/utils/runtime-idle-running-intent-reconciliation.test.ts` (not listed — asserts `outcome_snapshot`)
- `tests/runtime/runtime-mutations.test.ts` (not listed — `outcome_snapshot` fixtures)

**Recommendation**: Expand the test enumeration in Stage 4/5 to cover all test files that construct or assert `CardRecord` fields.

### m4. `normalizePersistedCardLifecycle` is the only caller of `validatePersistedCardLifecycle`

(lifecycle.ts) shows that `validatePersistedCardLifecycle` just calls `projectCardLifecycleState`, and `normalizePersistedCardLifecycle` (line 269-345) calls `validatePersistedCardLifecycle` at line 344. If Stage 2 removes the normalizer and makes validation strict, the `validatePersistedCardLifecycle` function becomes identical to `projectCardLifecycleState`. Consider merging them or renaming.

### m5. `ReviewerCorrectionResult.issues` uses `resultRecordSchema` — intentionally opaque

The plan does not mention that `ReviewerCorrectionResult.issues` at (lifecycle.ts) uses `z.array(resultRecordSchema)`. This is intentionally opaque: reviewer issues are arbitrary records. If `resultRecordSchema` is removed from `cardResultSchema` but kept under a different name, this reference must be updated.

**Recommendation**: Explicitly note that `ReviewerCorrectionResult.issues` is intentionally opaque and should keep an `arbitraryRecordSchema` reference.

---

## Summary

The overall approach — discriminated-union lifecycle state, strict validation at persistence boundary, commit helpers as single write path — is sound and directly addresses the root cause (unsafe data structures that make illegal states representable). The staged migration is the right shape.

The main risks are:

1. **Stage ordering**: Stage 1 and Stage 2 must be merged or reversed, because removing `resultRecordSchema` from type unions before removing load-time normalization will break production card loading for any card with `result: null` or `result: {}`.

2. **Scope gaps**: Several production sites that read `card.result` as an untyped record, write lifecycle fields outside commit helpers, or pass `CardRecord['result']` parameters are not enumerated in the plan stages.

3. **Missing migration tooling**: No one-time card conversion script is sketched for existing project state.

4. **Unresolved `status` question**: Whether `status` stays or goes from `CardRecord` affects every consumer and should be decided before implementation starts.

5. **Web/API contract change**: Needs coordinated deployment strategy.
