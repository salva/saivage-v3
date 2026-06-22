# F20 — Analysis (r2)

Supersedes [01-analysis-r1.md](01-analysis-r1.md). This revision addresses [01-analysis-review-r1.md](01-analysis-review-r1.md) asks A1, A2, A3.

## Symptom

Unchanged from r1. `implement-stepwise-multijump` was committed with `CardRecord.status = 'failed'` and `latest_self_report.result = 'failed'` (`"Updated UI multi-jump tests, but verification was interrupted before npm test/build could complete."`) while the on-disk evidence is green: vitest `13/13` ([t40-vitest.txt](../../../../tmp/saivage-v3-checkers-e2e-artifacts-20260523-phase2/t40-vitest.txt)) and production build ok ([t41-build.txt](../../../../tmp/saivage-v3-checkers-e2e-artifacts-20260523-phase2/t41-build.txt)). The runtime collapses "executor produced artefacts; tool-call loop terminated before verification" onto the binary `'done' | 'failed'` verdict.

## Root cause — four composed defects (extended per ask A2)

### a) Executor-fallback assembly hard-codes `status: 'failed'` AND its provenance is invisible at the runtime seam

[src/agents/result-parser.ts L231-L269](../../../src/agents/result-parser.ts#L231-L269) defines `buildExecutorFallbackResult(raw, context)`. The function is invoked by [src/agents/agent-adapter.ts](../../../src/agents/agent-adapter.ts) when the canonical envelope is unparseable but tool evidence is present. It preserves `generatedFiles`, `verifiedCommands`, `artifact_paths`, `tool_errors`, `parse_failure`, and returns `null` only when there is no evidence at all ([L239](../../../src/agents/result-parser.ts#L239) `if (!hadEvidence) return null;`). For every "we produced something" branch it returns:

```ts
return {
  card_id: partial.card_id ?? context.cardId,
  status: 'failed',
  status_text: partial.status_text ?? parseFailure.message,
  error,
  summary: partial.summary ?? parseFailure.message,
  artifacts: partial.artifacts ?? [],
  attachments: partial.attachments ?? [],
  result: { ..., generated_files, verification_commands, artifact_paths, tool_errors, parse_failure },
};
```

`ExecutorResult.status` is constrained to `'done' | 'failed'` at [src/agents/result-parser.ts L51-L58](../../../src/agents/result-parser.ts#L51-L58) and [L133-L140 (`rawExecutorResultSchema`)](../../../src/agents/result-parser.ts#L133-L140); the truncation prompt at [src/agents/agent-adapter.ts L334](../../../src/agents/agent-adapter.ts#L334) explicitly asks the model for `"status":"done"|"failed"`. The mechanism for the false failure is the hard-coded `'failed'`.

Per ask A1, two seams compose to produce the defect:

1. The fallback is produced by the parser for three distinct adapter recovery paths ([src/agents/agent-adapter.ts L531-L533](../../../src/agents/agent-adapter.ts#L531) toolCalls-envelope recovery; [L548-L550](../../../src/agents/agent-adapter.ts#L548) self-check recovery; [L554-L556](../../../src/agents/agent-adapter.ts#L554) raw parse failure). The parser cannot itself know which recovery path is in effect — it only sees the malformed final response plus accumulated tool evidence. It cannot, on its own, distinguish "the model emitted an unparseable but evidence-rich payload" from "the model declared a real failure and we mislabel it."
2. The runtime consumer ([src/runtime/runtime.ts](../../../src/runtime/runtime.ts) executor terminal write) reads `execResult.status` verbatim and has no flag to discriminate fallback-with-evidence from a model-declared verdict.

The fix is composite: (i) the three adapter call sites pass a typed `reason` into `buildExecutorFallbackResult` via `ExecutorFallbackContext`, (ii) the parser writes that reason verbatim into a new `ExecutorResult.fallback_with_evidence: { reason: 'tool_calls_envelope_recovery' | 'self_check_recovery' | 'parse_failure' } | null` field, (iii) the runtime branches on `fallback_with_evidence != null` to drive the lifecycle. The flag name is intentionally `fallback_with_evidence` per ask A1's "rename the flag to a truthful generic value such as `fallback_with_evidence`": every value in the discriminated union is a recovery-with-evidence case, so every such fallback consistently produces the new lifecycle status. The typed `reason` is preserved on the value for diagnostics and downstream branching, without overloading the field name with parser-internal semantics.

### b) Top-level `CardStatus` mirror at the executor terminal write

[src/runtime/runtime.ts L725-L733](../../../src/runtime/runtime.ts#L725-L733):

```ts
this.cardStore.update(card.id, {
  status: execResult.status,
  result: { ...(execResult.result ?? {}), executor: execResult.result ?? null, latest_self_report },
  error: execResult.error ?? null,
  status_text: execResult.status_text,
  status_text_updated_at: acceptedAt,
  status_text_author_session_id: lastSessionId,
  latest_self_report: latestSelfReport,
});
```

This is the literal `CardStatus` write. F19 r5 Step 5 rewraps it as `await this._stateMachine.transitionCard(card.id, 'executor_finish', { goalId, finalStatus })` followed by one awaited non-status `cardStore.update` ([F19 02-design-r5.md §Executor terminal restructure](../F19-runtime-pinned-failed-card/02-design-r5.md#executor-terminal-restructure-the-l725-733--l740-fix), [F19 03-plan-r5.md §Step 5 L725-733](../F19-runtime-pinned-failed-card/03-plan-r5.md#step-5--route-runtime-originating-cardstore-status-writes-through-await-transitioncard-await-every-follow-up-cardstoreupdate)). The F19 r5 `'executor_finish'` action still emits `'done' | 'failed'` — F20 must add a sibling action that emits `running → needs_verification` so the F19 r5 contract per action ("from `running`, emits one step") stays interpretable per row.

### c) Downstream status surfaces beyond the `CardStatus` mirror (ask A2)

The false-failed signal leaks through five additional runtime surfaces; each must reflect the truthful outcome rather than collapse to `failed`:

1. **`appendChildUnwindToolResult`** ([src/runtime/runtime.ts L187-L196](../../../src/runtime/runtime.ts#L187)). Argument type is `ActivationCompletionOutcome`. The current executor-terminal call site at [L744](../../../src/runtime/runtime.ts#L744) passes `outcome = execResult.status === 'done' ? 'done' : 'failed'`. If we map `needs_verification → 'failed'` here, the parent planner's activation tool-result envelope is identical to the rejection path — operator/analyst inspection cannot distinguish "executor rejected the work" from "executor's tool loop was terminated mid-flight." F20 must pass the truthful `'needs_verification'` value.
2. **`ActivationCompletionOutcome`** ([src/schemas/types.ts L73](../../../src/schemas/types.ts) — `'done' | 'failed' | 'blocked' | 'cancelled' | 'timed_out'`). The activation completion envelope outcome must accept `'needs_verification'`, otherwise step (1) is impossible without lying. The Zod schema at [src/schemas/validators.ts L53](../../../src/schemas/validators.ts#L53) `activationCompletionOutcomeSchema` must mirror.
3. **`RuntimeActivationStatus`** ([src/schemas/types.ts L31](../../../src/schemas/types.ts) — `'pending' | 'running' | 'completed' | 'failed' | 'blocked' | 'cancelled'`). `markActivationComplete` at [src/runtime/runtime.ts L171-L183](../../../src/runtime/runtime.ts#L171) computes `terminalStatus = outcome === 'done' ? 'completed' : outcome` — for `outcome === 'needs_verification'` this would attempt to write `'needs_verification'` as the activation status. F20 adds `'needs_verification'` to the union and to [src/schemas/validators.ts L106](../../../src/schemas/validators.ts#L106) `runtimeActivationStatusSchema`.
4. **`RuntimeRunRecord.result`** ([src/schemas/types.ts L33](../../../src/schemas/types.ts) — `'done' | 'failed' | 'blocked' | 'cancelled' | 'stopped' | null`). `markActivationComplete` maps `outcome` to `runResult` with the same shape; `'needs_verification'` must be a legal terminal `result` value or the run record must remain `null` for this outcome. F20 widens the union by adding `'needs_verification'` and writes that literal at the markActivationComplete site, matching the activation-status decision and keeping the per-run ledger honest.
5. **Parent planner activation envelope** ([src/runtime/runtime.ts L151-L168](../../../src/runtime/runtime.ts#L151) `buildCardActivationOutcome` → `createActivationCompletionEnvelope({ outcome, ... })`). With (2) widened, the planner receives `outcome: 'needs_verification'` in the canonical activation completion envelope and may surface it to operators, route it to the analyst, or hold for a future resume action. No planner-side handling is added in F20 — the envelope value itself is the contract.

The unwidened alternative is to map `needs_verification` to `'failed'` in surfaces 1–5 while the `CardRecord.status` mirror reports the truthful value. That is the bug r1 re-introduced and that ask A2 / D3 rejects: it preserves the false-failed signal in the activation ledger and the planner context.

### d) `CardStatus` enum has no "produced, not yet verified" slot

Unchanged from r1. [src/schemas/types.ts L12-L22](../../../src/schemas/types.ts#L12-L22):

```ts
export type CardStatus =
  | 'drafting' | 'backlog' | 'active' | 'running'
  | 'blocked' | 'changed' | 'done' | 'failed' | 'cancelled';
```

No member of this enum nor of `TERMINAL_STATES` / `TERMINAL_STATUSES` nor of `STARTABLE_STATES` / `RESTARTABLE_STATES` / `PLANNER_MUTABLE_STATES` / `DELETABLE_STATES` / `ANALYST_RESTARTABLE_STATES` describes the verification-pending case.

## Why the binary collapse is structurally wrong

Three meaningfully distinct outcomes downstream of an executor turn:

1. **`done`** — executor declared completion AND verification (registration + reviewer) accepted it.
2. **`failed`** — executor declared completion and verification rejected it, OR executor declared failure outright, OR an exception/registration error tripped the downgrade.
3. **(missing)** — executor's tool-call loop was terminated before it could declare a verdict, yet some or all artefacts were produced and persisted. The fallback at [src/agents/result-parser.ts L231-L269](../../../src/agents/result-parser.ts#L231-L269) already collects the evidence; the lifecycle never names this outcome.

## Composition with F19 r5 — concrete post-F19 branch (ask A3)

F19 r5 lands first ([F19 03-plan-r5.md](../F19-runtime-pinned-failed-card/03-plan-r5.md)). The post-F19 branch at the executor terminal write is the ordered sequence below; F20 inserts ONE machine action selection driven by `fallback_with_evidence`. No new top-level `cardStore.update({ status: ... })` writer is introduced — the F19 r5 Step 7 Part A gate at [F19 03-plan-r5.md §Step 7](../F19-runtime-pinned-failed-card/03-plan-r5.md#step-7--remove-staging-flag-sweep-dead-code-lock-final-invariants) stays unchanged.

Step-by-step branch ordering, per the F19 r5 [§Executor terminal restructure](../F19-runtime-pinned-failed-card/02-design-r5.md#executor-terminal-restructure-the-l725-733--l740-fix):

1. **Registration first** (unchanged from F19 r5). The artefact and attachment registration loops run before any status transition. `artifactRegistrationErrors`, `attachmentRegistrationErrors`, `ignoredArtifactRegistrations`, `ignoredAttachmentRegistrations` are computed. The optional `evidence_registration_ignored` write is an awaited `cardStore.update` per F19 r5 binding rule.
2. **`registrationFailed` computation** (unchanged from F19 r5). `registrationFailed = execResult.status === 'done' && (artifactRegistrationErrors.length > 0 || attachmentRegistrationErrors.length > 0)`.
3. **ONE state-machine action, selected by `fallback_kind`** (F20-owned branch). Precedence is `registrationFailed` first, then `fallback_with_evidence`, then canonical executor status:
   - **If `registrationFailed`** — emit `'executor_finish'` with `finalStatus: 'failed'`. `registrationFailed` wins over `fallback_with_evidence` because the runtime has concrete evidence that the executor's claimed completion does not register; that is a real terminal failure, not a verification-pending state. This precedence is asserted in plan §Step 6 test `executor_partial_finish.registrationFailedWins`.
   - **Else if `execResult.fallback_with_evidence !== null`** — emit `'executor_partial_finish'` with `{ reason: execResult.fallback_with_evidence.reason }`. Card lands in `needs_verification`.
   - **Else** — emit `'executor_finish'` with `finalStatus: execResult.status` (canonical `done | failed`).
4. **ONE awaited non-status `cardStore.update`** (unchanged shape from F19 r5). Writes `result`, `error`, `status_text`, `status_text_updated_at`, `status_text_author_session_id`, `latest_self_report`. The `result` payload merges `execResult.result`, `executor`, `latest_self_report`, and (when `registrationFailed`) `evidence_registration_failures`. Identical across all three branches in (3) — `await`ed per F19 r5 binding rule 2.
5. **Downstream surfaces** (per §c above). The post-transition tail computes a single `outcome` from `(card.status, execResult.fallback_with_evidence, registrationFailed)`:
   - `registrationFailed` → `outcome = 'failed'`.
   - `execResult.fallback_with_evidence !== null && !registrationFailed` → `outcome = 'needs_verification'`.
   - else if `execResult.status === 'done'` → `outcome = 'done'`.
   - else → `outcome = 'failed'`.
   `appendChildUnwindToolResult(card.id, outcome, summary)` is called with the truthful `outcome`. `markActivationComplete` propagates it to the activation ledger and run record. The parent planner activation envelope receives the truthful `outcome` literal. The `card_failed` event is emitted **only** when `outcome === 'failed'`; for `outcome === 'needs_verification'` no `card_failed` event fires, no `card_done` event fires, and `dispatchPendingActivations` returns with `failed: false` (the card is parked but the goal is not unwound).

`fallback_kind` provenance is read exactly once at step (3); `registrationFailed` always wins. The card-status write fans out from the single `'executor_partial_finish'` action into one legal `running → needs_verification` step in `VALID_TRANSITIONS`. The non-status payload fans out from the single awaited `cardStore.update` in step (4). The activation-ledger fanout in step (5) is contained in the existing helpers (`markActivationComplete`, `appendChildUnwindToolResult`, `buildCardActivationOutcome`) and uses the widened unions from §c.

## Out-of-scope for F20

- The L740 evidence-registration downgrade — collapsed into F19 r5 Step 5's `registrationFailed → executor_finish('failed')` branch. F20 inherits the collapse without rewriting it.
- The reviewer-side `needs_corrections` assessment value at [src/cards/diary.ts L24](../../../src/cards/diary.ts#L24) and [src/agents/analyst-tools.ts L115](../../../src/agents/analyst-tools.ts#L115) — a reviewer assessment value, not a `CardStatus`. F20 does not modify it.
- The resume contract for `needs_verification` (named follow-up issue F24-needs-verification-resume; see [02-design-r2.md §D1](02-design-r2.md#d1-resume-contract--remove-extra-edges-park-state-name-follow-up-f24)).
- Widening the LLM-facing executor schema at [src/agents/agent-adapter.ts L334](../../../src/agents/agent-adapter.ts#L334) to let the model pick `needs_verification` itself. F20's `needs_verification` is a runtime-derived verdict from observable evidence, not a model-declared one.

## Changes vs r1

- **A1 — typed reason at adapter call sites.** New `ExecutorFallbackContext.reason: 'tool_calls_envelope_recovery' | 'self_check_recovery' | 'parse_failure'` passed by each of the three [src/agents/agent-adapter.ts](../../../src/agents/agent-adapter.ts) sites (L531, L548, L554). The parser writes the reason verbatim into `ExecutorResult.fallback_with_evidence.reason`. Flag is `fallback_with_evidence` (truthful generic name) with the typed reason preserved on the value.
- **A2 — root-cause inventory extended.** Adds §c with five downstream surfaces: `appendChildUnwindToolResult`, `ActivationCompletionOutcome`, `RuntimeActivationStatus`, `RuntimeRunRecord.result`, parent planner activation envelope. Each must reflect the truthful `needs_verification` outcome; mapping any of them to `'failed'` preserves the bug.
- **A3 — post-F19 branch ordering pinned.** §Composition with F19 r5 spells out the five-step branch: registration → `registrationFailed` → ONE state-machine action selected by `(registrationFailed, fallback_with_evidence)` → ONE awaited non-status `cardStore.update` → activation-ledger fanout. `registrationFailed` wins over `fallback_with_evidence` precedence is named explicitly and tested.
- Other content (symptom, defect §a §b §d, three-outcome rationale, out-of-scope list) unchanged from r1.
