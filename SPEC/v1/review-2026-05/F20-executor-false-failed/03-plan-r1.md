# F20 — Implementation Plan (r1)

Implements Proposal A from [02-design-r1.md](02-design-r1.md). Sequenced **after** [F19 03-plan-r5.md](../F19-runtime-pinned-failed-card/03-plan-r5.md): the `RuntimeStateMachine` and the executor terminal restructure in `src/runtime/runtime.ts` must already be in place. Each step below is self-contained and leaves the system in a runnable, `npm run typecheck`-clean state.

## Coordination with F19 r5

- F19 r5 Step 5 lands the executor terminal restructure (`await transitionCard('executor_finish', { finalStatus })` replacing the L725-733 + L740 sites). F20 Step 5 below modifies the **same** branch to introduce the `'executor_partial_finish'` alternative when `execResult.fallback_kind === 'tool_loop_terminated'`.
- F20 imports the (post-Step-1.5-of-F19) exported `STARTABLE_STATES` / `RESTARTABLE_STATES` from [src/permissions/card-permissions.ts](../../../src/permissions/card-permissions.ts).
- F20 introduces no new `cardStore.update` call sites; the F19 r5 await-everywhere rule is honored by construction. The F19 r5 Step 7 gate (multiline `rg` for top-level `status:` writers in `runtime.ts`) is **unchanged** — F20 does not introduce a top-level `CardStatus` writer in `runtime.ts` beyond what F19 r5 produces.

## Validation commands (run after every step)

Per [/home/salva/g/ml/.github/skills/saivage-development-validation/SKILL.md](/home/salva/g/ml/.github/skills/saivage-development-validation/SKILL.md) and repo memory `saivage-validation-commands`:

```
cd /home/salva/g/ml/saivage-v3
npm run typecheck
npm run lint
npm run test:direct
npm run web:test
```

Live LXC probe (informational, the deterministic gates are the unit/integration tests):

```
curl -fsS http://10.0.3.170:8080/api/state | jq '.cards[] | select(.status == "needs_verification") | .id'
```

## Step 1 — `CardStatus` enum and Zod schema

**Files**: [src/schemas/types.ts](../../../src/schemas/types.ts) L12-L22; [src/schemas/validators.ts](../../../src/schemas/validators.ts) L13; [src/permissions/card-permissions.ts](../../../src/permissions/card-permissions.ts) L10.

Add `'needs_verification'` to the three literal lists in matching position (between `'running'` and `'blocked'`):

```ts
// src/schemas/types.ts L12-L22
export type CardStatus =
  | 'drafting' | 'backlog' | 'active' | 'running'
  | 'needs_verification'                                  // NEW
  | 'blocked' | 'changed' | 'done' | 'failed' | 'cancelled';
```

```ts
// src/schemas/validators.ts L13
export const cardStatusSchema = z.enum([
  'drafting','backlog','active','running','needs_verification','blocked','changed','done','failed','cancelled'
]);
```

```ts
// src/permissions/card-permissions.ts L10
export const CARD_STATES = [
  'drafting','backlog','active','running','needs_verification','blocked','changed','done','failed','cancelled'
] as const satisfies readonly CardStatus[];
```

The four named exception/affirmative sets above (`STARTABLE_STATES`, `RESTARTABLE_STATES`, `PLANNER_MUTABLE_STATES`, `DELETABLE_STATES`, `ANALYST_RESTARTABLE_STATES`) and the two terminal sets (`TERMINAL_STATES` at [src/cards/card-store.ts L189-L193](../../../src/cards/card-store.ts#L189-L193), `TERMINAL_STATUSES` at [src/runtime/runtime.ts L83](../../../src/runtime/runtime.ts#L83)) are **not** modified. `needs_verification` is correctly *not* a member of any of them; the `NOT_*` exception sets are computed from the affirmative sets so they include `needs_verification` automatically.

**Tests**: existing schema tests must still pass without modification. Add one new round-trip case in `tests/schemas/validators.test.ts` (or the nearest existing card-record schema test) asserting `cardRecordSchema.parse(record)` succeeds for a `CardRecord` with `status: 'needs_verification'`.

**Acceptance**: §Validation green; `rg -n "'needs_verification'" src/schemas src/permissions` returns three matches (one per file above).

## Step 2 — `VALID_TRANSITIONS` row and matrix completeness

**Files**: [src/cards/card-store.ts](../../../src/cards/card-store.ts) L217-L227.

Extend the `running` row and add the `needs_verification` row:

```ts
// src/cards/card-store.ts L217-L227 (post-F20)
const VALID_TRANSITIONS: Record<CardStatus, CardStatus[]> = {
  drafting: ['backlog', 'cancelled'],
  backlog: ['active', 'cancelled'],
  active: ['running', 'cancelled', 'backlog'],
  running: ['done', 'failed', 'needs_verification', 'blocked', 'changed', 'cancelled', 'backlog'], // +needs_verification
  needs_verification: ['done', 'failed', 'running', 'cancelled', 'backlog'],                       // NEW row
  blocked: ['backlog', 'running', 'changed', 'cancelled'],
  changed: ['backlog', 'active', 'cancelled'],
  done: ['backlog', 'cancelled'],
  failed: ['backlog', 'cancelled'],
  cancelled: ['drafting'],
};
```

**Tests**: extend the existing `card-store` transition tests with three rows:

- `running → needs_verification` accept.
- `needs_verification → running` accept (verification re-dispatch).
- `needs_verification → done` and `needs_verification → failed` accept.
- `needs_verification → active` reject (no skip-back-to-active edge — the verification-resume path goes through `running` directly).

**Acceptance**: §Validation green.

## Step 3 — Web fanout: type mirror, badge, per-status arrays

**Files**: [web/src/api/types.ts](../../../web/src/api/types.ts) L12-L21; [web/src/components/cards/CardsBoardView.vue](../../../web/src/components/cards/CardsBoardView.vue) L72 and L150-L158; [web/src/stores/cards.ts](../../../web/src/stores/cards.ts) L158; [web/src/views/CardsView.vue](../../../web/src/views/CardsView.vue) L246.

```ts
// web/src/api/types.ts L12-L21
export type CardStatus =
  | 'drafting' | 'backlog' | 'active' | 'running'
  | 'needs_verification'                                  // NEW
  | 'blocked' | 'changed' | 'done' | 'failed' | 'cancelled';
```

The three explicit per-status arrays gain `'needs_verification'` in matching position. The badge mapping at [web/src/components/cards/CardsBoardView.vue L150-L158](../../../web/src/components/cards/CardsBoardView.vue#L150-L158) gains one CSS rule:

```css
/* web/src/components/cards/CardsBoardView.vue */
.status-needs_verification { background: #f0b429; }
```

**Tests**: extend `web/src/__tests__/cards-view.test.ts` (or the nearest existing cards-board smoke test) with a fixture card whose `status === 'needs_verification'`; assert it renders without throwing and that the column dot has class `status-needs_verification`.

**Acceptance**: §Validation green; `npm run web:test` passes the new fixture.

## Step 4 — `ExecutorResult.fallback_kind` provenance flag

**Files**: [src/agents/result-parser.ts](../../../src/agents/result-parser.ts) L51-L58 (`ExecutorResult` interface), L231-L269 (`buildExecutorFallbackResult`), L304-L320 (`parseExecutorResult`).

1. Extend the `ExecutorResult` interface:

```ts
// src/agents/result-parser.ts L51-L58
export interface ExecutorResult {
  card_id: string;
  status: 'done' | 'failed';
  status_text: string;
  error?: string;
  result?: Record<string, unknown>;
  artifacts: ExecutorArtifactDef[];
  attachments: ExecutorAttachmentDef[];
  summary?: string;
  fallback_kind: 'tool_loop_terminated' | null;           // NEW — required field
}
```

2. `parseExecutorResult` returns `fallback_kind: null` for canonical envelopes.

3. `buildExecutorFallbackResult` returns `fallback_kind: 'tool_loop_terminated'` literal:

```ts
// src/agents/result-parser.ts L231-L269 (return object, post-F20)
return {
  card_id: partial.card_id ?? context.cardId,
  status: 'failed',
  status_text: partial.status_text ?? parseFailure.message,
  error,
  summary: partial.summary ?? parseFailure.message,
  artifacts: partial.artifacts ?? [],
  attachments: partial.attachments ?? [],
  fallback_kind: 'tool_loop_terminated',                  // NEW
  result: {
    ...(partial.result ?? {}),
    generated_files: evidence.generatedFiles,
    verification_commands: verification,
    artifact_paths: [...artifactPaths],
    tool_errors: toolErrors,
    parse_failure: parseFailure,
  },
};
```

4. [src/agents/fake-agent.ts L50](../../../src/agents/fake-agent.ts#L50) `convertExecutorResult` populates `fallback_kind: null` for fixtures. Add an optional `fallback_kind` field to `FakeExecutorResult` at [src/agents/fake-agent.ts L23](../../../src/agents/fake-agent.ts#L23) so test fixtures can drive the new path.

**Tests**:

- `tests/agents/result-parser.test.ts` (or nearest existing) — assert `parseExecutorResult` of a canonical envelope returns `fallback_kind: null`; assert `buildExecutorFallbackResult` of a raw response with tool-evidence returns `fallback_kind: 'tool_loop_terminated'`; assert the fallback still returns `null` (not a record) when there is no evidence.

**Acceptance**: §Validation green; `rg -n "fallback_kind" src/` returns matches in `result-parser.ts` and `fake-agent.ts` only.

## Step 5 — `RuntimeStateMachine.executor_partial_finish` action + runtime branch

**Files**: `src/runtime/state-machine.ts` (introduced by [F19 03-plan-r5.md §Step 2](../F19-runtime-pinned-failed-card/03-plan-r5.md#step-2--skeleton-runtimestatemachine-class-with-invariant-types-async-signatures-staging-flag)); [src/runtime/runtime.ts](../../../src/runtime/runtime.ts) executor terminal write (the post-F19-r5 restructured block that replaced L725-733/L740).

1. Add `'executor_partial_finish'` to the `RuntimeCardAction` union; implement its decomposition in `transitionCard`:

```ts
// src/runtime/state-machine.ts (post-F19 r5 + F20)
case 'executor_partial_finish': {
  if (card.status !== 'running') {
    this.logInvariant('state_machine_invalid_source_state', { cardId, action, from: card.status });
    return false;
  }
  await this.cardStore.setStatus(cardId, 'needs_verification');
  return true;
}
```

2. In `src/runtime/runtime.ts`, branch the post-F19-r5 executor terminal restructure on `execResult.fallback_kind`:

```ts
// src/runtime/runtime.ts (post-F19 r5 §Step 5 + F20)
const registrationFailed =
  execResult.status === 'done' &&
  (artifactRegistrationErrors.length > 0 || attachmentRegistrationErrors.length > 0);

let transitioned: boolean;
if (execResult.fallback_kind === 'tool_loop_terminated' && !registrationFailed) {
  // F20: fallback-with-evidence path → needs_verification, not failed.
  transitioned = await this._stateMachine.transitionCard(card.id, 'executor_partial_finish', {
    goalId,
    reason: 'tool_loop_terminated',
  });
} else {
  const finalStatus: 'done' | 'failed' = registrationFailed ? 'failed' : execResult.status;
  transitioned = await this._stateMachine.transitionCard(card.id, 'executor_finish', {
    goalId,
    finalStatus,
    reason: registrationFailed ? 'evidence_registration_failed' : undefined,
  });
}
if (!transitioned) { /* machine refused; one log line already written; bail out */ ... }

// Non-status payload — single awaited cardStore.update covering both branches.
await this.cardStore.update(card.id, {
  result: {
    ...(execResult.result ?? {}),
    executor: execResult.result ?? null,
    latest_self_report: latestSelfReport,
    ...(registrationFailed
      ? { evidence_registration_failures: { artifacts: artifactRegistrationErrors, attachments: attachmentRegistrationErrors } }
      : {}),
  },
  error: registrationError ?? execResult.error ?? null,
  status_text: execResult.status_text,
  status_text_updated_at: acceptedAt,
  status_text_author_session_id: lastSessionId,
  latest_self_report: latestSelfReport,
});

// Tail unwind: only emit card_failed when the actual outcome is 'failed'.
executedTerminal = true;
const outcome =
  execResult.fallback_kind === 'tool_loop_terminated' && !registrationFailed ? 'needs_verification'
  : execResult.status === 'done' && !registrationFailed                       ? 'done'
                                                                              : 'failed';
this.appendChildUnwindToolResult(card.id, outcome === 'needs_verification' ? 'failed' : outcome,
  `Terminal card ${card.id} finished with status ${outcome}.`);
if (outcome === 'failed') {
  this.emit('card_failed', { card_id: card.id, goal_id: goalId });
  this._eventLogger.appendEvent({ kind: 'card_failed', card_id: card.id, goal_id: goalId });
  failed = true;
  return { dispatchedGoal, executedTerminal, failed };
}
// `needs_verification` and `done` both fall through; the dispatch loop's next
// iteration recomputes `getPendingActivationCards(goalId)` and exits because no
// further activations remain.
```

**Notes on `appendChildUnwindToolResult`**: the existing API takes `'done' | 'failed' | 'blocked' | 'cancelled'`. We map `needs_verification` to the `'failed'` unwind kind so the planner is notified that the terminal card did not produce a green verdict; the *card* status remains the truthful `needs_verification` on disk. (Widening the unwind-result kind to include `'needs_verification'` is out of scope; the planner does not yet have an action for this case.)

**Notes on `dispatchPendingActivations` return**: `needs_verification` is **not** a failure — the function returns with `failed: false` so the goal loop is not unwound. The card is parked; the operator surface and a follow-up PR resume it.

**Tests** — see Step 6.

**Acceptance**: §Validation green; the F19 r5 Step 7 gates still pass (no new top-level `cardStore.update({ status: ... })` writer in `runtime.ts`; every `cardStore.update` is awaited).

## Step 6 — Tests

Add the following test files (or extend the nearest existing one):

1. `tests/runtime/state-machine.test.ts` — extend the `it.each` matrix from [F19 03-plan-r5.md §Step 5 — tests added in this step](../F19-runtime-pinned-failed-card/03-plan-r5.md#tests-added-in-this-step-in-testsruntimestate-machinetest-ts-and-new-test-files):
   - `executor_partial_finish` from `running` → `['running → needs_verification']`.
   - `executor_partial_finish` from every other source state → reject (`steps == []`, one `state_machine_invalid_source_state` log line). Cover every other member of `CARD_STATES`.

2. `tests/runtime/executor-partial-finish.test.ts` (NEW integration test):
   - Pre-seed a goal with one terminal child card; configure the fake executor fixture so `invokeExecutor` returns a `FakeExecutorResult` whose `convertExecutorResult` produces `{ status: 'failed', fallback_kind: 'tool_loop_terminated', artifacts: [...one synthetic artifact...], result: { generated_files: [...], verification_commands: [...] } }`.
   - Drive `dispatchPendingActivations(goalId)`.
   - Assert the spy `cardStore` step trace is `[L706 start/restart sequence] + ['running → needs_verification']` — no `'running → failed'` step.
   - Assert `cardStore.read(cardId)?.status === 'needs_verification'`.
   - Assert `cardStore.read(cardId)?.latest_self_report.result === 'failed'` (the executor's claimed verdict is preserved verbatim in the self-report).
   - Assert `cardStore.read(cardId)?.result.parse_failure` is present.
   - Assert no `card_failed` event was emitted on the runtime event emitter.
   - Assert `errors.jsonl` contains zero `Invalid transition` lines.
   - Assert the spy `update` call recorded for the non-status payload resolved before any subsequent runtime action timestamp (mirrors F19 r5's await-ordering assertion).

3. `tests/runtime/executor-failed.test.ts` (already specified in [F19 03-plan-r5.md §Step 5 — tests added in this step](../F19-runtime-pinned-failed-card/03-plan-r5.md#tests-added-in-this-step-in-testsruntimestate-machinetest-ts-and-new-test-files)) — **extend** to also assert: a canonical-envelope `FakeExecutorResult` with `status: 'failed'` and `fallback_kind: null` still takes the `executor_finish` branch (spy trace ends with `'running → failed'`, not `'running → needs_verification'`). This guards the discriminator.

4. `tests/runtime/executor-done.test.ts` (already specified by F19 r5) — **extend** to also assert `fallback_kind: null` does not divert a canonical `status: 'done'` result. (Defensive — `fallback_kind: 'tool_loop_terminated'` with `status: 'done'` is not produced by `buildExecutorFallbackResult` today; the test asserts the runtime does the right thing if a future regression introduced it: registrationFailed branch still wins by construction; otherwise the `executor_partial_finish` branch is taken and the card lands in `needs_verification`. This documents the precedence.)

5. `tests/schemas/validators.test.ts` — round-trip a `CardRecord` with `status: 'needs_verification'` (Step 1 acceptance).

6. `tests/cards/card-store.test.ts` (or the nearest existing transitions test) — Step 2 acceptance: the four `VALID_TRANSITIONS` cases listed above.

7. `web/src/__tests__/cards-view.test.ts` — Step 3 acceptance: render a fixture card with `status: 'needs_verification'`.

**Acceptance**: §Validation green; `npm run test:direct` includes the new `executor-partial-finish.test.ts`; `npm run web:test` covers the new badge.

## Step 7 — Dead-code sweep

Per architecture-first guideline, remove any code path that is rendered redundant by the new flow. After Steps 1-6, the following are candidates for removal:

- **None at the F20 PR boundary.** The L740 evidence-registration downgrade is owned by F19 r5, not F20. The `buildExecutorFallbackResult` function is *not* dead — it is the source of the `fallback_kind` flag we now branch on; only its semantic changed (from "the only signal we have is to declare failed" to "preserve evidence and mark the provenance for the runtime to choose the lifecycle slot").
- One thing to confirm absent: no other callsite in `src/agents/` or `src/runtime/` hard-codes `status: 'failed'` on the executor-result envelope path on the basis of a parse-failure heuristic. Verification command: `rg -n "status:\s*'failed'" src/agents/ src/runtime/`. Expected matches: the fallback assembly at [src/agents/result-parser.ts L256](../../../src/agents/result-parser.ts#L256) (intentional — see Step 4) and the executor-exception catch at [src/runtime/runtime.ts L715](../../../src/runtime/runtime.ts#L715) (intentional — a thrown exception is *not* a fallback-with-evidence case). No other matches expected.

**Dead-code list size**: **0 files removed, 0 functions removed.** This is by design — F20 is a state-machine-level slot insertion, not a refactor. The minimum-diff principle applies because the change is structural, not tactical.

## Step 8 — Final gates

1. F19 r5 Step 7 gates ([F19 03-plan-r5.md §Step 7](../F19-runtime-pinned-failed-card/03-plan-r5.md#step-7--remove-staging-flag-sweep-dead-code-lock-final-invariants)) still pass — F20 introduces no new top-level `cardStore.update({ status: ... })` in `runtime.ts` and no unawaited `cardStore.update`. The Part A and Part B `rg` checks are unchanged.

2. New F20 gate — every `CARD_STATES` consumer covers `needs_verification`:

```sh
# Every literal list of card statuses in src/ and web/src/ must include 'needs_verification'.
EXPECTED_LISTS=(
  "src/schemas/types.ts"
  "src/schemas/validators.ts"
  "src/permissions/card-permissions.ts"
  "src/cards/card-store.ts"
  "web/src/api/types.ts"
  "web/src/components/cards/CardsBoardView.vue"
  "web/src/stores/cards.ts"
  "web/src/views/CardsView.vue"
)
for f in "${EXPECTED_LISTS[@]}"; do
  if ! rg -q "needs_verification" "$f"; then
    echo "F20 gate FAIL: $f missing 'needs_verification'"
    exit 1
  fi
done
echo "F20 status-fanout gate: OK"
```

3. Live LXC probe (informational):

```
ssh root@10.0.3.170 'curl -fsS http://127.0.0.1:8080/api/state' \
  | jq '.cards[] | select(.status == "needs_verification")'
```

After deploying the F20 PR and replaying the offending fixture, the `implement-stepwise-multijump` card (or an equivalent synthetic) appears with `status: 'needs_verification'`, an amber badge in the operator dashboard, and `latest_self_report.result === 'failed'` preserved verbatim.

## Risks and mitigations

- **Parked `needs_verification` cards** — see [02-design-r1.md §Failure modes](02-design-r1.md#failure-modes). Visible via the amber badge; resume path is a documented follow-up PR. **Acceptable** for the F20 PR boundary because today the same card is silently *failed*, which is strictly worse.
- **Mis-ordering with F19** — F20 cannot land without F19 r5's `RuntimeStateMachine` already merged. **Mitigation**: the F20 PR description blocks on the F19 PR; the integration test `executor-partial-finish.test.ts` imports `RuntimeStateMachine` directly and fails to compile without F19 r5.
- **Permission-matrix completeness** — verified by extending `CARD_STATES`; the `matrixCompletenessTriples()` helper at [src/permissions/card-permissions.ts L98-L107](../../../src/permissions/card-permissions.ts#L98-L107) walks the cartesian product, so any uncovered triple is caught by the existing permission-matrix completeness tests without modification.

## Changes vs prior revisions

This is r1 — no prior revisions.
