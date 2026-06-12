# Source-flow diagnosis: stuck terminal reconciliation

Access date: 2026-05-31. Scope: source/runtime diagnosis only; no lesson content, raw card bodies, raw logs, HTTP bodies, provider/auth values, or secret-shaped values are included.

## Executive summary

The source flow supports a likely v3-side reconciliation defect rather than a lesson-product issue. The strongest source-level root cause is in `src/runtime/runtime.ts` `dispatchPendingActivations()`: for non-goal child cards it chooses `start` only for `STARTABLE_STATES` and otherwise chooses `restart`, but it does **not** verify that the start/restart transition succeeded before setting `active_card_run` and invoking the executor. A card already in `active` status (the observed metadata-only state of `produce-intro-tool-lesson`) is neither startable nor restartable per `src/permissions/card-permissions.ts` and `src/runtime/transition-policy.ts`; the ignored transition failure can lead to executor work and artifact/result side effects without a legal `running -> done` transition, so the child card can remain `active` and the parent/project planner can keep seeing unfinished child work.

A second, separate source gap explains why `.saivage/reviews/` and `.saivage/diaries/` can remain empty even if a runtime reviewer runs: `src/cards/diary.ts` implements `appendReviewAssessment()` and `appendDiaryEntry()`, but production runtime review persistence in `Runtime.persistReviewState()` only writes the assessment into the goal card result. There are no production callers of `appendReviewAssessment()` outside the diary unit tests.

I found no v3 source producer/discoverer for Diedrico lesson publication-manifest files or `pipeline-status.md`; these appear to be project artifacts created by the active lesson-production executor/planner, not a dedicated runtime subsystem. Therefore the absence of a manifest-like file is a product-pipeline artifact concern unless a runtime card completion bug prevents the planner from performing or confirming the expected publication step.

## Redacted current-state metadata used for source correlation

Targeted metadata-only probes during this task showed:

- Authoritative runtime state path is `/.saivage/tmp/state/runtime.json`, not the legacy `/.saivage/runtime/state.json` (per `src/runtime/state.ts` and spec amendment context). The legacy-path probe failed with ENOENT; this is expected under v3 layout.
- Runtime-state summary at probe time showed no open `active_card_run`, no open runtime runs, and no open activations.
- Card metadata summary at probe time:
  - `project`: type `project`, status `running`, updated at `2026-05-31T21:53:21.533Z`, version sequence `383`, result keys `latest_self_report` and `planning`.
  - `produce-intro-tool-lesson`: type `data`, parent `project`, status `active`, updated at `2026-05-31T21:53:14.378Z`, version sequence `271`, has latest self report, result keys indicating generated/validated project files and checks, and a large nonzero artifact count.

This combination is internally suspicious: runtime ledger has no open activation/run, yet the child leaf remains `active` with durable evidence-like result/artifact metadata, leaving the parent project `running`.

## Source flow map

### 1. Activation request and child runtime ledger

`PlannerControlExecutor.execute()` handles planner `activate_card` calls in `src/agents/planner-control-executor.ts`:

- validates the target child exists and dependencies are done;
- requires an active parent planner runtime run;
- appends a child `runtime_run` with phase `pending` and `runtime_status: running`;
- upserts a `runtime_activation` with status `pending`;
- returns a deferred activation envelope to the planner.

Relevant source: `src/agents/planner-control-executor.ts` around the `activate_card` case.

### 2. Runtime dispatch loops pending activations

`Runtime.dispatchGoal()` in `src/runtime/runtime.ts` invokes the planner, applies planner card creations/updates, then calls `dispatchPendingActivations(goalId)`.

`dispatchPendingActivations()`:

- gets pending activations for the goal;
- for child goals, recursively dispatches the goal and unwinds a result;
- for terminal/non-goal cards, transitions the card to execution status, sets `active_card_run`, invokes executor, registers evidence, transitions via `executor_finish`, stores executor result/status text, and appends the child unwind tool result.

Critical implementation detail: for non-goal children, the code chooses:

```ts
const startAction = STARTABLE_STATES.includes(card.status) ? 'start' : 'restart';
await this._stateMachine.transitionCard(card.id, startAction, { goalId });
updateRuntimeState(... active_card_run ...);
```

It does not check the boolean returned by `transitionCard()` before continuing.

### 3. Why an `active` child can stay active

`src/permissions/card-permissions.ts` defines:

- `STARTABLE_STATES = ['drafting', 'backlog', 'changed']`
- `RESTARTABLE_STATES = ['blocked', 'changed', 'done', 'failed', 'cancelled']`

`src/runtime/transition-policy.ts` accepts:

- `start` only from startable states; `active` is rejected.
- `restart` only from restartable states; `active` is rejected.
- `executor_finish` only from `running`; `active` is rejected.

Therefore, if a pending activation points at a child currently persisted as `active`, `dispatchPendingActivations()` will select `restart`, `transitionCard()` will return `false`, but runtime still sets an executor `active_card_run` and invokes the executor. Later `executor_finish` will also reject because the persisted card status is still `active`; the code then returns `{ failed: true }` before appending `appendChildUnwindToolResult()`.

This matches the observed class of failure: a child card can have executor evidence/artifacts but remain `active`, and the parent/project can remain `running` because `dispatchGoal()` treats any child whose status is not `done`, `failed`, or `cancelled` as unfinished child work.

### 4. Child unwind and terminal activation completion

When terminal execution succeeds normally, `appendChildUnwindToolResult()` calls `markActivationComplete()` and appends an activation-completion envelope to the caller planner session. `markActivationComplete()` marks pending/claimed/running activations for the child terminal and updates related runtime runs.

If execution reaches the `if (!transitioned) { failed = true; return ... }` branch after a rejected `executor_finish`, the unwind is skipped. That leaves the planner without the normal terminal completion envelope for that activate-card call.

### 5. Review/diary emission gap

`src/cards/diary.ts` provides durable diary and review index APIs:

- `initDiary()`
- `appendDiaryEntry()`
- `appendReviewAssessment()`
- `getReviewAssessments()`

However grep confirmed production callers are absent. The only callers of `appendReviewAssessment()` and `appendDiaryEntry()` are the diary module itself and `tests/utils/diary.test.ts`.

Runtime review persistence is `Runtime.persistReviewState()` in `src/runtime/runtime.ts`, which only updates the goal card result with `review: assessment`. It does not call `appendReviewAssessment(join(projectRoot, '.saivage'), assessment)`.

Implication: zero recursive files under `.saivage/reviews/` and `.saivage/diaries/` is not sufficient evidence by itself that no reviewer ran. It is also a source implementation gap. Event log `review_complete`/`review_failed`, reviewer session manifests, and card `result.review` are the currently implemented production surfaces.

### 6. Pipeline-status and publication manifest

Searches for `pipeline-status`, `publication-manifest`, `publication_manifest`, and manifest-related terms found no dedicated v3 runtime source producer for Diedrico lesson publication manifests or pipeline-status updates. The only manifest code in v3 source is runtime freeze/session/process metadata, not lesson publication metadata.

Conclusion: pipeline-status and lesson manifest files are created or discovered by planner/executor work in project space, not by a fixed runtime subsystem. A runtime completion bug can still prevent the planner from scheduling the next production card or performing final reconciliation after project files are written.

## Likely minimal repair direction

The smallest source-side repair to test first is in `src/runtime/runtime.ts` `dispatchPendingActivations()`:

1. After the initial `start`/`restart` transition for a non-goal child, check the returned boolean.
2. If the card is already `active`, either transition it through a supported recovery path to `running` or fail/requeue deterministically before invoking the executor.
3. If the transition fails, do not invoke the executor; emit a runtime diagnostic and mark/unwind the activation in a way that lets the parent planner resume with an actionable failure instead of leaving an ambiguous active card.
4. Add a focused runtime test for a pending activation whose child starts in `active` status, asserting no executor invocation occurs without a legal transition and the parent does not hang without an activation completion/failure signal.

A second, independent repair should wire `Runtime.persistReviewState()` to `appendReviewAssessment()` so `.saivage/reviews/by-goal/*.json` and `.saivage/diaries/<goal>/...review_assessment.json` are emitted when reviewer assessments are persisted. This should be tested separately because it changes observability/artifact emission, not the active-card terminal transition itself.

## Files and functions to cite for coder follow-up

- `src/runtime/runtime.ts`
  - `dispatchGoal()` — planner loop, unfinished-child-work detection, reviewer dispatch.
  - `dispatchPendingActivations()` — non-goal child start/restart, executor invocation, `executor_finish`, unwind.
  - `appendChildUnwindToolResult()` and `markActivationComplete()` — activation completion envelope and runtime ledger closure.
  - `persistReviewState()` — currently card-result-only review persistence.
- `src/runtime/transition-policy.ts`
  - `planCardTransition()` — rejects `restart` from `active`; rejects `executor_finish` unless status is `running`.
- `src/permissions/card-permissions.ts`
  - `STARTABLE_STATES` and `RESTARTABLE_STATES` — `active` is in neither set.
- `src/agents/planner-control-executor.ts`
  - `activate_card` case — creates runtime activation/run and deferred activation envelope.
- `src/cards/diary.ts`
  - `appendReviewAssessment()` — implemented durable review/diary emission not wired into runtime.
- `src/runtime/state.ts`
  - `runtimeStatePath()` — authoritative v3 state path `.saivage/tmp/state/runtime.json`.

## Checklist assessment

- Trace terminal reconciliation source paths: passed.
- Trace publication manifest discovery/producer logic: passed with gap; no runtime producer found.
- Trace review/diary emission: passed; implementation exists but production runtime does not call it.
- Trace pipeline status: passed with gap; no dedicated runtime source path found.
- Trace next-production scheduling: passed at runtime level; parent project redispatch depends on child terminal status and runtime intent/open root run, while planner creates/schedules product cards.
- Identify likely minimal v3-side fix: passed; check failed start/restart transition in `dispatchPendingActivations()` before executor invocation, plus separate review/diary persistence wiring.

## Sources

- Local source: `/work/saivage-v3/src/runtime/runtime.ts`, accessed 2026-05-31.
- Local source: `/work/saivage-v3/src/runtime/transition-policy.ts`, accessed 2026-05-31.
- Local source: `/work/saivage-v3/src/permissions/card-permissions.ts`, accessed 2026-05-31.
- Local source: `/work/saivage-v3/src/agents/planner-control-executor.ts`, accessed 2026-05-31.
- Local source: `/work/saivage-v3/src/cards/diary.ts`, accessed 2026-05-31.
- Local source: `/work/saivage-v3/src/runtime/state.ts`, accessed 2026-05-31.
- Local package/validation reference: `/work/saivage-v3/AGENTS.md` and `/work/saivage-v3/package.json`, accessed 2026-05-31.
