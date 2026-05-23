# F20 — Analysis (r1)

## Symptom

`implement-stepwise-multijump` was committed with `status = 'failed'` and `latest_self_report.result = 'failed'` (`status_text = "Updated UI multi-jump tests, but verification was interrupted before npm test/build could complete."`), while the on-disk evidence is green: vitest `13/13` ([t40-vitest.txt](../../../../tmp/saivage-v3-checkers-e2e-artifacts-20260523-phase2/t40-vitest.txt)) and production build ok ([t41-build.txt](../../../../tmp/saivage-v3-checkers-e2e-artifacts-20260523-phase2/t41-build.txt)). The lifecycle is missing a state for "executor produced artefacts, but its tool-call loop was terminated before the verification step closed", so the runtime collapses that case onto the terminal `failed` verdict.

## Root cause — three composed defects

### a) Executor self-report assembly hardcodes `status: 'failed'` for early-termination

[src/agents/result-parser.ts L231-269](../../../src/agents/result-parser.ts#L231-L269) defines `buildExecutorFallbackResult(raw, context)`. The function is called when the canonical envelope cannot be parsed (provider truncated, response is plain text, tool-call loop bailout). It deliberately preserves tool evidence (`generatedFiles`, `verifiedCommands`, `artifact_paths`, `tool_errors`) and only returns `null` when there is no evidence at all (L239: `if (!hadEvidence) return null;`). For every "we produced something" case it then assembles:

```ts
// src/agents/result-parser.ts L254-269
return {
  card_id: partial.card_id ?? context.cardId,
  status: 'failed',                                       // <-- hard-coded
  status_text: partial.status_text ?? parseFailure.message,
  error,
  summary: partial.summary ?? parseFailure.message,
  artifacts: partial.artifacts ?? [],
  attachments: partial.attachments ?? [],
  result: { ..., generated_files, verification_commands, artifact_paths, tool_errors, parse_failure },
};
```

The hard-coded `status: 'failed'` is the literal mechanism by which a card that *did* produce a green vitest run and a passing build is reported as failed. The `ExecutorResult` schema at [src/agents/result-parser.ts L51-58](../../../src/agents/result-parser.ts#L51-L58) and [L133-L140 (`rawExecutorResultSchema`)](../../../src/agents/result-parser.ts#L133-L140) constrains `status` to the binary union `'done' | 'failed'`, so the fallback cannot express any third outcome today.

Three call sites in [src/agents/agent-adapter.ts](../../../src/agents/agent-adapter.ts) feed the fallback into the parser slot when the canonical parse fails:

- [src/agents/agent-adapter.ts L531-533](../../../src/agents/agent-adapter.ts#L531) — after `toolCalls`-in-content envelope recovery parse failure.
- [src/agents/agent-adapter.ts L548-550](../../../src/agents/agent-adapter.ts#L548) — after self-check recovery parse failure.
- [src/agents/agent-adapter.ts L554-556](../../../src/agents/agent-adapter.ts#L554) — after the first parse failure (no recovery path).

The truncation-prompt that the loop emits to coax a final envelope is also binary by construction:

```text
// src/agents/agent-adapter.ts L334
'... Reply with ONLY your final executor result JSON envelope:
 {"card_id":"...","status":"done"|"failed", ... }'
```

So even when the model is given one last turn to emit a canonical envelope after tool-call truncation, the schema we ask it to use cannot represent "I produced artefacts, verification pending". The model is forced to pick `"failed"`, which is what the offending `latest_self_report` recorded.

### b) Runtime terminal-status decision is a 1:1 mirror of executor `status` with no intermediate slot

The executor `status` is written verbatim to `CardStatus` in the runtime's executor-result block at [src/runtime/runtime.ts L725-733](../../../src/runtime/runtime.ts#L725-L733):

```ts
// src/runtime/runtime.ts L725-733
this.cardStore.update(card.id, {
  status: execResult.status,                              // 'done' | 'failed' → CardStatus
  result: { ...(execResult.result ?? {}), executor: execResult.result ?? null, latest_self_report },
  error: execResult.error ?? null,
  status_text: execResult.status_text,
  status_text_updated_at: acceptedAt,
  status_text_author_session_id: lastSessionId,
  latest_self_report: latestSelfReport,
});
```

There is no branch on "fallback path with evidence" vs "model-declared terminal verdict". The runtime treats the binary executor `status` as authoritative even when its provenance is `buildExecutorFallbackResult`. F19 r5 rewraps this site in `RuntimeStateMachine.transitionCard(card.id, 'executor_finish', { finalStatus })` ([F19 02-design-r5.md §Executor terminal restructure](../F19-runtime-pinned-failed-card/02-design-r5.md#executor-terminal-restructure-the-l725-733--l740-fix)), but the post-F19 contract still requires `finalStatus: 'done' | 'failed'` — the new state machine inherits F20's binary verdict unless F20 widens it.

The secondary downgrade site at [src/runtime/runtime.ts L740](../../../src/runtime/runtime.ts#L740) (evidence-registration failure flipping `done → failed`) is in scope for F19 r5's restructure and is not a separate F20 defect. F20's defect is upstream: even a clean `execResult` whose true semantic is "needs verification" is reduced to `failed` before this branch ever runs.

### c) `CardStatus` enum has no "produced, not yet verified" slot

[src/schemas/types.ts L12-L22](../../../src/schemas/types.ts#L12-L22) defines the enum:

```ts
export type CardStatus =
  | 'drafting' | 'backlog' | 'active' | 'running'
  | 'blocked' | 'changed' | 'done' | 'failed' | 'cancelled';
```

The matching Zod schema is [src/schemas/validators.ts L13](../../../src/schemas/validators.ts#L13) (`cardStatusSchema`). The transition matrix at [src/cards/card-store.ts L217-227](../../../src/cards/card-store.ts#L217-L227) maps `running` directly to `{done, failed, blocked, changed, cancelled, backlog}`; there is no intermediate node between `running` and the terminal verdicts. `blocked` and `changed` are conceptually adjacent but mean different things (`blocked` = external dependency missing; `changed` = scope/inputs changed and require re-planning) — neither captures "executor produced artefacts but the verification step did not run".

`TERMINAL_STATES` at [src/cards/card-store.ts L189-L193](../../../src/cards/card-store.ts#L189-L193) and `TERMINAL_STATUSES` at [src/runtime/runtime.ts L83](../../../src/runtime/runtime.ts#L83) both enumerate the closed set `{done, failed, cancelled}`. Permissions in [src/permissions/card-permissions.ts](../../../src/permissions/card-permissions.ts) split the lifecycle into `STARTABLE_STATES` (L29 — `{drafting, backlog, changed}`), `RESTARTABLE_STATES` (L28 — `{blocked, changed, done, failed, cancelled}`), `PLANNER_MUTABLE_STATES` (L27 — `{backlog, active, changed}`), and `DELETABLE_STATES` (L26 — `{backlog, blocked, done, failed, cancelled}`). There is no membership slot that captures an intermediate "verification-pending" card: such a card is neither `STARTABLE` (work has begun) nor `RESTARTABLE` (it is not terminal) nor `PLANNER_MUTABLE` (the planner did not produce it; the executor did) nor `DELETABLE` (it has artefacts on disk).

The web badge mapping at [web/src/components/cards/CardsBoardView.vue L150-L158](../../../web/src/components/cards/CardsBoardView.vue#L150-L158) and the `CardStatus` mirror at [web/src/api/types.ts L12-L21](../../../web/src/api/types.ts#L12-L21) (also the explicit per-status arrays at [web/src/stores/cards.ts L158](../../../web/src/stores/cards.ts#L158) and [web/src/views/CardsView.vue L246](../../../web/src/views/CardsView.vue#L246)) likewise have no slot for the missing state.

## Why the binary collapse is structurally wrong

The system already distinguishes three meaningfully different outcomes downstream of an executor turn:

1. **`done`** — executor declared completion and the verification step (registration + reviewer) accepted it.
2. **`failed`** — executor declared completion but verification rejected it, or executor declared failure outright, or an exception/registration error tripped the downgrade at L740.
3. **(missing)** — executor's tool-call loop was terminated by the provider/transport before it could declare a verdict, *yet some or all artefacts were produced and persisted on disk*. The fallback at [src/agents/result-parser.ts L231-269](../../../src/agents/result-parser.ts#L231-L269) already collects the tool-evidence needed to recognise this outcome (it just labels the result `failed`); the lifecycle never names it.

The card data carries the truth — `latest_self_report.status_text` says "verification was interrupted before npm test/build could complete", `result.generated_files` lists the produced files, `result.verification_commands` records partial runs — but the top-level `CardStatus` says `failed`, which is what the operator dashboard renders, what `RESTARTABLE_STATES` consumers consider, and what reviewer/analyst-supervised paths see.

## Composition with F19 r5

[F19 r5 02-design](../F19-runtime-pinned-failed-card/02-design-r5.md) introduces `RuntimeStateMachine.transitionCard(cardId, action, payload)` with the `'executor_finish'` action that emits exactly one legal step `running → done` or `running → failed`. F20's remedy must compose with that machine, not bypass it. Two seams are relevant:

- The action set defined in [F19 02-design-r5.md §Actions](../F19-runtime-pinned-failed-card/02-design-r5.md#actions) is the source of truth for runtime-emitted card transitions; F20 must either reuse `executor_finish` with a widened `finalStatus` union, or introduce a sibling action (e.g. `executor_partial_finish`). The latter keeps the precondition `card.status === 'running'` invariant at [F19 02-design-r5.md §Permission-matrix + `validateTransition` rules per action](../F19-runtime-pinned-failed-card/02-design-r5.md#permission-matrix--validatetransition-rules-per-action) interpretable per row.
- The Step 5 conversion at [F19 03-plan-r5.md §Step 5 — L725-733](../F19-runtime-pinned-failed-card/03-plan-r5.md#step-5--route-runtime-originating-cardstore-status-writes-through-await-transitioncard-await-every-follow-up-cardstoreupdate) computes `finalStatus = registrationFailed ? 'failed' : execResult.status`. F20 must update that decision so that "fallback-produced executor result with evidence" also yields the new intermediate status instead of `failed`. The fallback's provenance must be observable at the call site for this to work — see plan §Step 2.

The verdict: F19 r5 lands first, F20 rebases onto the state machine, and F20's fix adds (i) one new `CardStatus` member, (ii) one new machine action, (iii) one new `VALID_TRANSITIONS` row, plus the schema/permission/web fanout. No F19 r5 file is rewritten.

## Out-of-scope for F20 (per project guidelines: no over-engineering)

- The L740 evidence-registration downgrade is F19 r5's restructure target, not F20's.
- The reviewer-side `needs_corrections` flow ([src/cards/diary.ts L24](../../../src/cards/diary.ts#L24), [src/agents/analyst-tools.ts L115](../../../src/agents/analyst-tools.ts#L115)) is a *reviewer assessment value*, not a `CardStatus`, and is unrelated to the executor early-termination case despite the name overlap. F20 does not modify it.
- No new docstrings or comments on out-of-scope sites.
