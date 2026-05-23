# F20 — Plan (r2)

Supersedes [03-plan-r1.md](03-plan-r1.md). Addresses [03-plan-review-r1.md](03-plan-review-r1.md) asks P1–P8 and applies the design from [02-design-r2.md](02-design-r2.md).

## Hard precondition (ask P8)

**F19 r5 MUST be merged on `origin/main` before any F20 step is started.** F20 inserts a new `'executor_partial_finish'` action into the F19 r5 `RuntimeStateMachine.transitionCard` union and branches the executor-terminal write that F19 r5 owns ([F19 03-plan-r5.md §Step 5](../F19-runtime-pinned-failed-card/03-plan-r5.md#step-5--route-runtime-originating-cardstore-status-writes-through-await-transitioncard-await-every-follow-up-cardstoreupdate)).

Hard gate (run before opening Step S1):

```bash
cd /home/salva/g/ml/saivage-v3
git fetch origin main
git diff --name-only origin/main...HEAD | rg '^SPEC/v1/review-2026-05/F19-runtime-pinned-failed-card/(02-design-r5\.md|03-plan-r5\.md)$|^src/runtime/state-machine\.ts$|^src/runtime/runtime\.ts$' \
  | rg -v '^src/runtime/runtime\.ts$' \
  && { echo 'ABORT: F20 branch must NOT modify F19 r5 design/plan files or state-machine.ts outside the F20-additive lines'; exit 1; } || true
```

A second gate at PR review time: `git log --name-only origin/main..HEAD -- SPEC/v1/review-2026-05/F19-runtime-pinned-failed-card/` must return zero entries.

## Step ordering

Steps run sequentially. Each step ends with a focused validation gate (per [/home/salva/g/ml/.github/skills/saivage-development-validation/SKILL.md](../../../../.github/skills/saivage-development-validation/SKILL.md)).

### Step S1 — `ExecutorResult` extension and adapter call-site typed reason

1. [src/agents/result-parser.ts](../../../src/agents/result-parser.ts):
   - Extend `ExecutorResult` (~L51-L58) and `rawExecutorResultSchema` (~L133-L140) with `fallback_with_evidence: { reason: 'tool_calls_envelope_recovery' | 'self_check_recovery' | 'parse_failure' } | null`. Canonical parse paths (`parseExecutorEnvelope`) write `fallback_with_evidence: null` on returned objects.
   - Extend `ExecutorFallbackContext` (`{ cardId: string }`) with `reason: 'tool_calls_envelope_recovery' | 'self_check_recovery' | 'parse_failure'`.
   - `buildExecutorFallbackResult` (L231-L269): on every non-null return, set `fallback_with_evidence: { reason: context.reason }`. On the `if (!hadEvidence) return null;` exit at L239, return `null` unchanged (no evidence ⇒ canonical rejection upstream).
   - Keep the hard-coded `status: 'failed'` in `buildExecutorFallbackResult` — the runtime branches by `fallback_with_evidence` and does not consult `status` for parked cards (precedence rule from [02-design-r2.md §D1](02-design-r2.md#d1-resume-contract--remove-extra-edges-park-state-name-follow-up-f24) and [01-analysis-r2.md §A3](01-analysis-r2.md#composition-with-f19-r5--concrete-post-f19-branch-ask-a3)).
2. [src/agents/agent-adapter.ts](../../../src/agents/agent-adapter.ts) — three call sites:
   - L531-L533 (toolCalls-envelope recovery → no canonical envelope but evidence collected): pass `reason: 'tool_calls_envelope_recovery'`.
   - L548-L550 (self-check recovery): pass `reason: 'self_check_recovery'`.
   - L554-L556 (raw parse failure with evidence): pass `reason: 'parse_failure'`.

**Gate S1:**
```bash
cd /home/salva/g/ml/saivage-v3 && npm run typecheck
NODE_OPTIONS=--experimental-vm-modules npx jest tests/agents/result-parser.test.ts tests/agents/agent-adapter.test.ts --runInBand --forceExit
```

### Step S2 — schema & state-machine widenings

1. [src/schemas/types.ts](../../../src/schemas/types.ts):
   - `CardStatus` (L12-L22): add `'needs_verification'` literal.
   - `CARD_STATES`: add `'needs_verification'`.
   - `ActivationCompletionOutcome` (~L73): add `'needs_verification'`.
   - `RuntimeActivationStatus` (~L31): add `'needs_verification'`.
   - `RuntimeRunRecord.result` (~L33): add `'needs_verification'`.
   - `TERMINAL_STATES`, `STARTABLE_STATES`, `RESTARTABLE_STATES`, `PLANNER_MUTABLE_STATES`, `DELETABLE_STATES`, `ANALYST_RESTARTABLE_STATES`: NO change (see [02-design-r2.md §D3](02-design-r2.md#d3-truthful-activation-outcome--widen-runtimeactivationstatus--runtimerunrecordresult)).
2. [src/schemas/validators.ts](../../../src/schemas/validators.ts):
   - `cardStatusSchema` (L13): add `'needs_verification'` literal.
   - `activationCompletionOutcomeSchema` (L53): add `'needs_verification'` literal.
   - `runtimeActivationStatusSchema` (L106): add `'needs_verification'` literal.
3. [src/runtime/state-machine.ts](../../../src/runtime/state-machine.ts):
   - Extend the F19 r5 `RuntimeStateMachineAction` union with `{ kind: 'executor_partial_finish'; goalId: string; reason: 'tool_calls_envelope_recovery' | 'self_check_recovery' | 'parse_failure' }`.
   - `VALID_TRANSITIONS.running`: append `'needs_verification'`.
   - Add row `needs_verification: ['cancelled']` to `VALID_TRANSITIONS`.
   - Add `TERMINAL_STATUSES` membership decision: NO — `'needs_verification'` is parked, not terminal ([02-design-r2.md §D3](02-design-r2.md#d3-truthful-activation-outcome--widen-runtimeactivationstatus--runtimerunrecordresult)).
   - `transitionCard` action handler: `'executor_partial_finish'` source must be `'running'`, emits one `cardStatusChanged` event `{ from: 'running', to: 'needs_verification', reason: action.reason }`, returns `true`. Any other source returns `false` and emits no event (consistent with F19 r5 `'executor_finish'` shape).

**Gate S2:**
```bash
cd /home/salva/g/ml/saivage-v3 && npm run typecheck && npm run lint
NODE_OPTIONS=--experimental-vm-modules npx jest tests/schemas/validators.test.ts tests/runtime/state-machine.test.ts --runInBand --forceExit
```

### Step S3 — runtime executor-terminal branch (the F19 r5 site)

[src/runtime/runtime.ts](../../../src/runtime/runtime.ts) — executor-terminal block (post-F19 r5 collapsed L725-L744). Replace the F19 r5 single `'executor_finish'` action selection with the five-step ordering from [01-analysis-r2.md §A3](01-analysis-r2.md#composition-with-f19-r5--concrete-post-f19-branch-ask-a3):

```ts
const registrationFailed =
  execResult.status === 'done'
  && (artifactRegistrationErrors.length > 0 || attachmentRegistrationErrors.length > 0);

let outcome: ActivationCompletionOutcome;
let transitioned: boolean;

if (registrationFailed) {
  transitioned = await this._stateMachine.transitionCard(card.id, {
    kind: 'executor_finish',
    goalId,
    finalStatus: 'failed',
  });
  outcome = 'failed';
} else if (execResult.fallback_with_evidence !== null) {
  transitioned = await this._stateMachine.transitionCard(card.id, {
    kind: 'executor_partial_finish',
    goalId,
    reason: execResult.fallback_with_evidence.reason,
  });
  outcome = 'needs_verification';
} else {
  transitioned = await this._stateMachine.transitionCard(card.id, {
    kind: 'executor_finish',
    goalId,
    finalStatus: execResult.status,
  });
  outcome = execResult.status === 'done' ? 'done' : 'failed';
}

if (transitioned) {
  await this.cardStore.update(card.id, {
    result: { ...(execResult.result ?? {}), executor: execResult.result ?? null, latest_self_report, ...(registrationFailed ? { evidence_registration_failures: { artifacts: artifactRegistrationErrors, attachments: attachmentRegistrationErrors } } : {}) },
    error: execResult.error ?? null,
    status_text: execResult.status_text,
    status_text_updated_at: acceptedAt,
    status_text_author_session_id: lastSessionId,
    latest_self_report,
  });
}

await markActivationComplete(activationId, outcome, summary);
await appendChildUnwindToolResult(card.id, outcome, summary);
```

Other runtime sites — verify NO regression:
- L266 reviewer-phase repair (F19 r5 owned) — F20 does NOT modify.
- L278 startup executor-phase repair (`fallback_kind: service_restart`) — F20 does NOT modify; uses `'executor_finish'` `'failed'` path, no fallback_with_evidence.
- L660-L664 goal-complete unwind (`'done'`) — F20 does NOT modify.
- L703 child-goal unwind — F20 does NOT modify.
- L715 executor-exception catch — F20 does NOT modify; remains canonical `'failed'` with `fallback_with_evidence: null` and emits `'executor_finish'` `'failed'`.

**Gate S3:**
```bash
cd /home/salva/g/ml/saivage-v3 && npm run typecheck && npm run lint
NODE_OPTIONS=--experimental-vm-modules npx jest tests/runtime/state-machine.test.ts tests/runtime/executor-done.test.ts tests/runtime/executor-failed.test.ts --runInBand --forceExit
```

### Step P2 — runtime integration tests for `needs_verification` and rejection-path regression

New file `tests/runtime/executor-partial-finish.test.ts`:
- **Test 1 — happy parked**: feeds an `ExecutorResult` with `fallback_with_evidence: { reason: 'self_check_recovery' }` and `status: 'failed'` (the hard-coded parser shape). Asserts:
  - `cardStore.get(cardId).status === 'needs_verification'`.
  - No `card_failed` event emitted.
  - No `card_done` event emitted.
  - `runtime_activations.find(...).status === 'needs_verification'`.
  - `RuntimeRunRecord.result === 'needs_verification'`.
  - Parent planner activation envelope outcome === `'needs_verification'`.
- **Test 2 — registrationFailed wins** (precedence rule from [01-analysis-r2.md §A3](01-analysis-r2.md#composition-with-f19-r5--concrete-post-f19-branch-ask-a3)): feeds an `ExecutorResult` with `fallback_with_evidence: { reason: 'parse_failure' }` AND a synthetic registration error. Asserts `cardStore.get(cardId).status === 'failed'`, `card_failed` emitted, `outcome === 'failed'`.
- **Test 3 — fallback reason provenance for each adapter call site**: parametrised over `'tool_calls_envelope_recovery' | 'self_check_recovery' | 'parse_failure'`. Asserts the `cardStatusChanged` event reason matches the input.
- **Test 4 — rejection path unchanged**: feeds `ExecutorResult` with `status: 'failed', fallback_with_evidence: null`. Asserts `cardStore.get(cardId).status === 'failed'`, `card_failed` emitted, `runtime_activations.status === 'failed'`, `RuntimeRunRecord.result === 'failed'`. This is the regression guard for the canonical rejection path.
- **Test 5 — done path unchanged**: feeds `ExecutorResult` with `status: 'done', fallback_with_evidence: null`. Asserts `cardStore.get(cardId).status === 'done'`, `card_done` emitted.

**Gate P2:**
```bash
NODE_OPTIONS=--experimental-vm-modules npx jest tests/runtime/executor-partial-finish.test.ts --runInBand --forceExit
```

### Step P1 — acceptance test: resume-or-park (no 50-iter spin, not failed, operator-visible parked state)

New file `tests/runtime/executor-partial-finish-park.test.ts`:
- Drives a full `dispatchGoal` cycle with a synthetic planner that activates one card.
- The fake executor returns an `ExecutorResult` with `fallback_with_evidence: { reason: 'parse_failure' }` on the first call.
- Asserts:
  - The goal-dispatch loop terminates in **≤ 2** iterations (instrument the dispatcher with an iteration counter or spy on `dispatchPendingActivations` call count).
  - `runtimeState.current_card_id === null` after the loop.
  - No `card_failed` event with the parked card's id is emitted.
  - The card is queryable via `runtimeState.cards` with `status: 'needs_verification'` (operator-visible parked state).
  - The dispatch loop does NOT hit the 50-iter ceiling (assert loop iteration count is `< 50`).
- Top-of-file comment cites the named follow-up **F24-needs-verification-resume** as the issue that will add the resume action sequence.

**Gate P1:**
```bash
NODE_OPTIONS=--experimental-vm-modules npx jest tests/runtime/executor-partial-finish-park.test.ts --runInBand --forceExit
```

### Step P3 — parser & adapter tests

Extend `tests/agents/result-parser.test.ts`:
- **canonical-null**: a successful `parseExecutorEnvelope` call returns `ExecutorResult.fallback_with_evidence === null`.
- **fallback-with-evidence-provenance**: `buildExecutorFallbackResult(rawWithEvidence, { cardId, reason: 'self_check_recovery' })` returns `fallback_with_evidence: { reason: 'self_check_recovery' }`. Parametrised across all three `reason` literals.
- **fallback-without-evidence-null**: `buildExecutorFallbackResult(rawNoEvidence, ...)` returns `null` (the L239 exit), so no `fallback_with_evidence` is ever observed on a result-less rejection.

Extend `tests/agents/agent-adapter.test.ts`:
- **adapter-call-site reason matches recovery path**: parametrised across three recovery paths. For each, stub the LLM to yield the corresponding malformed envelope and assert the resulting `ExecutorResult.fallback_with_evidence.reason` matches: `tool_calls_envelope_recovery` for the L531 path, `self_check_recovery` for the L548 path, `parse_failure` for the L554 path.

**Gate P3:**
```bash
NODE_OPTIONS=--experimental-vm-modules npx jest tests/agents/result-parser.test.ts tests/agents/agent-adapter.test.ts --runInBand --forceExit
```

### Step P4 — frontend fanout (every consumer + final `rg` gate)

Apply the edits enumerated in [02-design-r2.md §D4](02-design-r2.md#d4-web-fanout--every-consumer-touched-and-asserted):

1. [web/src/api/types.ts L12-L21](../../../web/src/api/types.ts#L12-L21) — `CardStatus` `+ 'needs_verification'`.
2. [web/src/components/cards/CardDetailView.vue L319-L331](../../../web/src/components/cards/CardDetailView.vue#L319-L331) — explainer entry.
3. [web/src/components/cards/CardDetailView.vue L543-L546](../../../web/src/components/cards/CardDetailView.vue#L543-L546) — `.status-needs_verification` badge CSS.
4. [web/src/components/cards/CardsTreeView.vue L206-L213](../../../web/src/components/cards/CardsTreeView.vue#L206-L213) — `.status-needs_verification` dot CSS.
5. [web/src/components/cards/CardsTimelineView.vue L58-L63](../../../web/src/components/cards/CardsTimelineView.vue#L58-L63) — icon map entry.
6. [web/src/components/cards/CardsTimelineView.vue L153-L158](../../../web/src/components/cards/CardsTimelineView.vue#L153-L158) — `.tl-marker.status-needs_verification` CSS.
7. [web/src/components/cards/CardsTimelineView.vue L199-L206](../../../web/src/components/cards/CardsTimelineView.vue#L199-L206) — `.tl-status.status-needs_verification` CSS.
8. [web/src/components/cards/CardsBoardView.vue L71-L73](../../../web/src/components/cards/CardsBoardView.vue#L71-L73) — `STATUS_ORDER` entry between `'failed'` and `'cancelled'`.
9. [web/src/components/cards/CardsBoardView.vue L150-L158](../../../web/src/components/cards/CardsBoardView.vue#L150-L158) — `.status-needs_verification` column CSS.
10. [web/src/stores/cards.ts L158](../../../web/src/stores/cards.ts#L158) — `statuses` array entry between `'failed'` and `'cancelled'`.
11. [web/src/views/CardsView.vue L246](../../../web/src/views/CardsView.vue#L246) — `statuses` array entry between `'failed'` and `'cancelled'`.
12. [web/src/\_\_tests\_\_/card-detail-view.test.ts L32](../../../web/src/__tests__/card-detail-view.test.ts#L32) — `childCounts` fixture `needs_verification: 0`.

After every code-side edit lands, save all open buffers in VS Code (`workbench.action.files.saveAll`) per the workspace user-memory rule, then run the final `rg` gate:

```bash
cd /home/salva/g/ml/saivage-v3
rg -n "CardStatus\[\]|Record<CardStatus" src/ web/src/
rg -n "status-(drafting|backlog|active|running|blocked|changed|done|failed|cancelled|needs_verification)" web/src/
rg -n "needs_verification" web/src/
```

Acceptance: every `Record<CardStatus, ...>` and `CardStatus[]` literal listed in [02-design-r2.md §D4](02-design-r2.md#d4-web-fanout--every-consumer-touched-and-asserted) appears in the output with `needs_verification` present; every `.status-*` CSS block listed appears with a sibling `.status-needs_verification` rule; the third `rg` returns the full enumerated touch list.

**Gate P4:**
```bash
cd /home/salva/g/ml/saivage-v3 && npm run web:typecheck
npm run web:test:cardsview
npm run web:test:operator-smoke
```

### Step P7 — dead-code sweep checklist

Per ask P7, after Steps S1–S3 land, run the following `rg` scans and justify or remove every surviving site.

```bash
cd /home/salva/g/ml/saivage-v3
rg -n "status:\s*'failed'" src/agents/ src/runtime/
rg -n "outcome:\s*'failed'" src/
rg -n "result:\s*'failed'" src/
rg -nU "TERMINAL_STATUSES" src/
```

Expected surviving sites (justifications):
- `src/agents/result-parser.ts` `buildExecutorFallbackResult` — intentional: parser stays binary-typed; runtime branches by `fallback_with_evidence`.
- `src/runtime/runtime.ts` L715 executor-exception catch — intentional canonical failure path (no fallback_with_evidence, no executor result).
- `src/runtime/runtime.ts` L266 reviewer-phase repair — F19 r5 owned; F20 does not touch.
- `src/runtime/runtime.ts` L278 startup executor-phase repair — `fallback_kind: service_restart` rejection-path; F20 does not touch.
- `src/runtime/runtime.ts` Step S3 branch — uses literal `'failed'` for outcome in the `registrationFailed` and rejection-path branches per [02-design-r2.md §D1](02-design-r2.md#d1-resume-contract--remove-extra-edges-park-state-name-follow-up-f24).
- `TERMINAL_STATUSES` callers in `src/runtime/runtime.ts` — `'needs_verification'` is intentionally absent from `TERMINAL_STATUSES` per [02-design-r2.md §D3](02-design-r2.md#d3-truthful-activation-outcome--widen-runtimeactivationstatus--runtimerunrecordresult); each consumer (`getPendingActivationCards`, startup repair) is correct as-is.

Any other surviving site is either (a) explicitly noted above, (b) belongs to F19 r5 and out of F20's scope, or (c) must be removed in this same PR. The PR description lists the rg outputs.

### Step P5 — full validation gate

After all step gates pass:

```bash
cd /home/salva/g/ml/saivage-v3
npm run typecheck
NODE_OPTIONS=--experimental-vm-modules npx jest \
  tests/agents/result-parser.test.ts \
  tests/agents/agent-adapter.test.ts \
  tests/runtime/state-machine.test.ts \
  tests/runtime/executor-done.test.ts \
  tests/runtime/executor-failed.test.ts \
  tests/runtime/executor-partial-finish.test.ts \
  tests/runtime/executor-partial-finish-park.test.ts \
  tests/schemas/validators.test.ts \
  --runInBand --forceExit
npm run lint
npm run web:typecheck
npm run web:test:cardsview
npm run web:test:operator-smoke
npm run build
npm run docs:verify
```

All gates must be green before Step P6.

### Step P6 — live LXC probe (informational gate)

Per [/home/salva/g/ml/.github/skills/saivage-development-validation/SKILL.md](../../../../.github/skills/saivage-development-validation/SKILL.md) and the workspace handoff:

```bash
cd /home/salva/g/ml/saivage-v3 && npm run build
rsync -a --delete dist/ root@10.0.3.170:/opt/saivage-v3-getrich/dist/
rsync -a --delete web/dist/ root@10.0.3.170:/opt/saivage-v3-getrich/web/dist/
ssh root@10.0.3.170 'systemctl restart saivage-v3-getrich.service && systemctl is-active saivage-v3-getrich.service'
curl -fsS http://10.0.3.170:8080/health
ssh root@10.0.3.170 'curl -fsS http://127.0.0.1:8080/api/state' \
  | jq '.cards[] | select(.status == "needs_verification") | { id, title, status, status_text }'
```

No token reads, no secret prints, no `sleep`. Restart + `is-active` + `/health` is the standard liveness check; the `api/state` jq is an informational filter to confirm the new lifecycle slot serializes correctly. If `/health` returns non-2xx, abort and roll back the deploy; do NOT mark the gate green.

## Per-ask traceability (P1–P8)

- **P1** — Step P1 (acceptance: parked state, ≤ 2 iterations, not failed, operator-visible). Resume action explicitly deferred to F24-needs-verification-resume.
- **P2** — Step P2 (Tests 1, 2, 5 assert `needs_verification` happy/precedence/done; Test 4 asserts canonical rejection path unchanged with `fallback_with_evidence: null`).
- **P3** — Step P3 (parser canonical-null / fallback-with-evidence-provenance / fallback-without-evidence-null; adapter call-site-reason-matches per recovery path).
- **P4** — Step P4 (every consumer listed; final 3-line `rg` gate).
- **P5** — Step P5 (full validation matrix: typecheck, focused jest, lint, web:typecheck, web:test:cardsview, web:test:operator-smoke, build, docs:verify).
- **P6** — Step P6 (LXC restart + `is-active` + `/health` + `api/state` informational filter; no token reads).
- **P7** — Step P7 (dead-code sweep checklist with justification per surviving site).
- **P8** — Hard precondition at the top (`git diff` gate; F19 r5 must be merged; F20 must not modify F19 r5 docs or `state-machine.ts` outside additive lines).

## Changes vs r1

- Hard F19 r5 precondition added at the top (P8) with a `git diff` gate command.
- Step S3 explicitly threads the `(registrationFailed, fallback_with_evidence)` precedence and pins ONE state-machine action + ONE awaited non-status `cardStore.update` per the F19 r5 binding rule.
- New Step P1 acceptance test with explicit ≤ 2 iteration assertion and named F24-needs-verification-resume follow-up.
- Step P2 expanded to 5 cases including registrationFailed precedence and rejection-path regression guard.
- Step P3 parametrised across all three adapter recovery paths.
- Step P4 enumerates every web consumer with file+line+exact edit and adds the 3-line final `rg` gate.
- Step P5 lists every validation command per the skill (`typecheck`, focused jest, `lint`, `web:typecheck`, `web:test:cardsview`, `web:test:operator-smoke`, `build`, `docs:verify`).
- Step P6 specifies the exact LXC commands (ssh root@10.0.3.170, `is-active`, `/health`, informational `api/state` jq) with no token reads and no `sleep`.
- New Step P7 dead-code sweep checklist with the four `rg` scans and per-survivor justification table.
