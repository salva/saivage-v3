# F20 — Plan (r3)

Supersedes [03-plan-r2.md](03-plan-r2.md). Addresses [01-analysis-review-r2.md](01-analysis-review-r2.md) Plan Issues S3 and P6. Every other step (P8 hard precondition, S1, S2, P1, P2, P3, P4, P5, P7) is unchanged and inherited verbatim from r2.

## Step S2 — schema & state-machine widenings (delta only)

All of [§Step S2 r2](03-plan-r2.md#step-s2--schema--state-machine-widenings) stands, with one correction: `VALID_TRANSITIONS` lives in [src/cards/card-store.ts#L217-L227](../../../src/cards/card-store.ts#L217-L227), not in `src/runtime/state-machine.ts`. F20 edits the card-store source-of-truth file directly per [02-design-r3.md §D2](02-design-r3.md#d2-valid_transitions-minimal-surface):

- Append `'needs_verification'` to the `running` row's targets (one new edge).
- Add row `needs_verification: ['cancelled']`.

No other row in `VALID_TRANSITIONS` is touched. The state-machine action union (`'executor_partial_finish'`) is still added in `src/runtime/state-machine.ts` per r2.

## Step S3 — runtime executor-terminal branch (the F19 r5 site)

Picks **Option (b)** from [01-analysis-review-r2.md Plan Issue 1](01-analysis-review-r2.md): fix the `markActivationComplete` mapper per [02-design-r3.md §D3](02-design-r3.md#d3-truthful-activation-outcome--markactivationcomplete-mapper-fix) and use the existing single `appendChildUnwindToolResult(card.id, outcome, summary)` call. The helper's current call surface — `(childCardId: string, outcome: ActivationCompletionOutcome, summary: string): void` per [src/runtime/runtime.ts#L187-L196](../../../src/runtime/runtime.ts#L187-L196) — already accommodates `'needs_verification'` once `ActivationCompletionOutcome` is widened in S2; no helper refactor is needed. `appendChildUnwindToolResult` already calls `markActivationComplete` internally, so calling both at the executor terminal would double-complete. r2's snippet did that and also passed a non-existent `activationId` parameter — both removed in r3.

### S3.a — `markActivationComplete` mapper edit

[src/runtime/runtime.ts#L172-L173](../../../src/runtime/runtime.ts#L172-L173) — replace the existing `runResult` ternary with the corrected mapper from [02-design-r3.md §D3](02-design-r3.md#d3-truthful-activation-outcome--markactivationcomplete-mapper-fix):

```ts
const terminalStatus = outcome === 'done' ? 'completed' : outcome;
const runResult: RuntimeRunRecord['result'] =
  outcome === 'done' ? 'done'
  : outcome === 'blocked' ? 'blocked'
  : outcome === 'cancelled' ? 'cancelled'
  : outcome === 'needs_verification' ? 'needs_verification'
  : 'failed';
```

The `terminalStatus` line is unchanged. The `runResult` ternary gains one branch and only one branch. No helper signature changes.

### S3.b — executor-terminal block

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

this.appendChildUnwindToolResult(card.id, outcome, summary);
```

`appendChildUnwindToolResult` is the single completion call (it internally calls `markActivationComplete`); there is no separate `markActivationComplete` call here, and no `activationId` parameter is in scope or required. The helper is synchronous (`void`) per [src/runtime/runtime.ts#L187-L196](../../../src/runtime/runtime.ts#L187-L196) — no `await` is added.

Other runtime sites — verify NO regression (unchanged from r2):
- L266 reviewer-phase repair (F19 r5 owned) — F20 does NOT modify.
- L278 startup executor-phase repair (`fallback_kind: service_restart`) — F20 does NOT modify; uses `'executor_finish'` `'failed'` path, no `fallback_with_evidence`.
- L660-L664 goal-complete unwind (`'done'`) — F20 does NOT modify.
- L703 child-goal unwind — F20 does NOT modify.
- L715 executor-exception catch — F20 does NOT modify; remains canonical `'failed'` with `fallback_with_evidence: null` and emits `'executor_finish'` `'failed'`.

**Gate S3:**
```bash
cd /home/salva/g/ml/saivage-v3 && npm run typecheck && npm run lint
NODE_OPTIONS=--experimental-vm-modules npx jest tests/runtime/state-machine.test.ts tests/runtime/executor-done.test.ts tests/runtime/executor-failed.test.ts --runInBand --forceExit
```

## Step P6 — live LXC probe (informational gate)

Per [/home/salva/g/ml/.github/skills/saivage-development-validation/SKILL.md](../../../../.github/skills/saivage-development-validation/SKILL.md) and the workspace handoff: the `saivage-v3-getrich-v2` container at `10.0.3.170` bind-mounts the host `/home/salva/g/ml/saivage-v3/` directory into the container's service deployment. Building on the host updates the running deployment in place — no `rsync` step is required or correct, and rsync to `/opt/saivage-v3-getrich/` targets the wrong path. The r2 `rsync -a --delete dist/ root@10.0.3.170:/opt/saivage-v3-getrich/dist/` and the analogous `web/dist/` line are REMOVED in r3.

```bash
cd /home/salva/g/ml/saivage-v3 && npm run build
ssh root@10.0.3.170 'systemctl restart saivage-v3-getrich.service && systemctl is-active saivage-v3-getrich.service'
curl -fsS http://10.0.3.170:8080/health
ssh root@10.0.3.170 'curl -fsS http://127.0.0.1:8080/api/state' \
  | jq '.cards[] | select(.status == "needs_verification") | { id, title, status, status_text }'
```

No token reads, no secret prints, no `sleep`. Build-on-host + restart + `is-active` + `/health` is the standard liveness check per the validation skill; the `api/state` jq is an informational filter to confirm the new lifecycle slot serializes correctly. If `/health` returns non-2xx, abort and roll back (`git checkout`-style on the host workspace, `npm run build`, restart) and do NOT mark the gate green.

## Steps inherited unchanged from r2

- Hard precondition (P8 — F19 r5 must be merged on `origin/main`; `git diff` gate).
- [Step S1 — `ExecutorResult` extension and adapter call-site typed reason](03-plan-r2.md#step-s1--executorresult-extension-and-adapter-call-site-typed-reason).
- [Step S2 — schema & state-machine widenings](03-plan-r2.md#step-s2--schema--state-machine-widenings) (with the `VALID_TRANSITIONS` location correction above).
- [Step P1 — acceptance test: resume-or-park](03-plan-r2.md#step-p1--acceptance-test-resume-or-park-no-50-iter-spin-not-failed-operator-visible-parked-state).
- [Step P2 — runtime integration tests for `needs_verification` and rejection-path regression](03-plan-r2.md#step-p2--runtime-integration-tests-for-needs_verification-and-rejection-path-regression).
- [Step P3 — parser & adapter tests](03-plan-r2.md#step-p3--parser--adapter-tests).
- [Step P4 — frontend fanout (every consumer + final `rg` gate)](03-plan-r2.md#step-p4--frontend-fanout-every-consumer--final-rg-gate).
- [Step P5 — full validation gate](03-plan-r2.md#step-p5--full-validation-gate).
- [Step P7 — dead-code sweep checklist](03-plan-r2.md#step-p7--dead-code-sweep-checklist).

## Per-ask traceability (P1–P8) — unchanged from r2

See [03-plan-r2.md §Per-ask traceability](03-plan-r2.md#per-ask-traceability-p1p8). r3 does not change any P1–P8 mapping; the S3 and P6 edits are scoped fixes to the steps already covered.

## Changes vs r2

- **Step S3.** Picked Option (b): rely on existing single `appendChildUnwindToolResult(card.id, outcome, summary)` call (which already calls `markActivationComplete` internally) after fixing the mapper. Removed r2's double-completion `markActivationComplete(...)` + `appendChildUnwindToolResult(...)` pair and the dangling `activationId` parameter. Added S3.a: the `markActivationComplete` `runResult` mapper gains one branch for `'needs_verification'` per [02-design-r3.md §D3](02-design-r3.md#d3-truthful-activation-outcome--markactivationcomplete-mapper-fix).
- **Step S2.** Corrected the location of `VALID_TRANSITIONS` to `src/cards/card-store.ts#L217-L227` (the F19 r5 hard-pin); r2 listed `src/runtime/state-machine.ts`, which has no such constant.
- **Step P6.** Removed both `rsync -a --delete ... root@10.0.3.170:/opt/saivage-v3-getrich/...` commands (host bind-mount makes them redundant and wrong-path). Kept `npm run build` on host, the `systemctl restart` + `is-active` SSH probe, the `/health` curl, and the informational `api/state` jq filter, per the validation skill.
- Every other step unchanged.
