# Consolidated Runtime Core Plan

Status: new execution plan, written after reassessing the XState runtime review findings against current code and the active cleanup plans on 2026-06-12.

This plan supersedes the local ordering in `99-METAPLAN.md` for runtime-core work. It does not replace the broader over-engineering plan wholesale; it pulls forward the parts that matter for the new runtime core and leaves lower-priority cleanup as later batches.

## Review Verdicts

The earlier review found real problems, but not all deserve the same priority or framing.

| Finding | Verdict | Reason |
| --- | --- | --- |
| F01 `startProject()` is synchronous/imperative | Accepted, reframed | The immediate bug is not that it awaits completion by itself; the bug is that active execution is not represented as runtime-owned cancellable work. |
| F02 XState machines are decorative | Accepted as design debt | True for `GoalCardRunner`, `TerminalCardRunner`, and `LlmRunner`. Do not fix with a large rewrite before cancellation/recovery semantics are clear. |
| F03 dead production modules | Accepted with precision | The runtime-path modules are dead or legacy-adjacent. Do not confuse them with similarly named live modules under `src/agents/`. |
| F04 no cancellation path in runner loops | Accepted | Highest-priority correctness issue. Pause/stop can only deny future provider admission; it does not cooperatively stop active runner loops. |
| F05 brittle reviewer parsing | Accepted | Raw string verdicts are too fragile for a control-plane decision. |
| F06 global note sink lifecycle | Accepted, medium priority | Real leak/stale-sink risk, but smaller than cancellation/recovery. |
| F07 actor ID prefix fragility | Demoted | Current IDs are internally produced and guarded. Do not prioritize before functional gaps. |
| F08 untyped snapshot context | Accepted, tied to recovery | Low value until snapshots become executable recovery state. Becomes important when implementing real recovery. |
| F09 hardcoded activity status | Accepted | Operator-visible and misleading. |
| F10 recovery plan is read but not used | Accepted | This is already listed as the top remaining gap in `card-runner-xstate-porting-plan.md`. |
| F11 legacy `RuntimeConfig`/`RuntimeAssembly` | Accepted as cleanup | Important for clarity, not runtime correctness. |
| F12 ad-hoc tool arg parsing | Accepted, low-medium | Real duplication; address with tool protocol work. |
| F13 runner cleanup missing | Accepted, medium | Process/actor cleanup should be fixed with cancellation and lifecycle ownership. |
| F14 ambiguous status | Accepted | Same family as F09: operator read model/status correctness. |
| F15 hard-coded tool names | Accepted | Should be fixed with F12/tool protocol hardening. |
| F16 no snapshot cleanup | Accepted, low-medium | Depends on the recovery policy: completed snapshots may be retained for observability or removed after read-model persistence is sufficient. |
| F17 stuck supervisor/runtime-config legacy | Accepted as cleanup | It belongs with old-runtime deletion work, not with core behavior fixes. |

## Remaining Old-Plan Work To Preserve

From `docs/design/card-runner-xstate-porting-plan.md`, the important unfinished runtime-core work remains:

1. Complete startup recovery from the validated actor recovery plan.
2. Complete the durable tool protocol with exactly-one delivery/error for every tool call.
3. Replace old synthetic planner-note fallback once CardRunner NoteBox persistence covers inactive/no-owner cases.
4. Delete remaining old dispatcher/core-adjacent source once current behavior is protected by actor/domain/API tests.

From `docs/design/over-engineering-remediation-plan.md`, the runtime-relevant cleanup still worth keeping in the queue is:

1. WI-1 freeze removal, after an explicit decision.
2. WI-5/WI-6/WI-7 terminal-commit dead symbol and dead branch cleanup.
3. WI-14 legacy `agentExecutionFactory` seam cleanup, if still present after the XState deletion tranche.
4. WI-15 `RuntimeState` required-field typing and `?? []` guard sweep, after freeze and old-runtime deletion reduce churn.
5. WI-17 config legacy-key migration shim decision, after deployment config inspection.

## Priority Order

### P0: Stabilize Runtime Ownership And Cancellation

Goal: active runtime work must be owned, observable, and stoppable before deeper recovery or cleanup.

Issues covered: F01, F02, F04, F13.

Work:

1. Introduce explicit in-flight work ownership in `SupervisorRuntimeApi`.
2. Keep a reference to the currently running root/goal runner instead of creating it as an untracked local in `startProject()`.
3. Add cooperative cancellation checks to `GoalCardRunnerController.start()` and `TerminalCardRunnerController.start()` before and after each awaited provider/tool/child operation.
4. Add a minimal runner cancellation interface that marks cards cancelled or blocked consistently and stops child process actors where applicable.
5. Make `stopProject()` and `shutdown()` request cancellation and wait for quiescence, with a bounded timeout and clear diagnostic if quiescence fails.
6. Do not do a full event-driven XState rewrite in this batch. Treat XState-as-recording as a known smell until cancellation and recovery semantics are correct.

Tests:

1. Focused tests in `tests/runtime/actors/xstate-minimal-core.test.ts` for cancellation during planner, reviewer, executor, and process waits.
2. `tests/runtime/actors/supervisor-runtime-api.test.ts` for `stopProject()` cancelling active work.
3. `npm run typecheck`, `npm test`, `npm run validate:routine`.

### P1: Make Operator Status Truthful

Goal: status APIs must reflect active XState runtime work instead of returning idle placeholders.

Issues covered: F09, F14, partial F01.

Work:

1. Replace hardcoded `getActivityStatus()` with real activity from active `LlmRunnerController` and tool-delivery state.
2. Replace `getStatus()` placeholders: distinguish idle, paused, stopping, and active work; compute current card from the active runner; compute `goalCount` from the card store or a cheap read-model projection.
3. Decide whether `RuntimeStatus` needs a schema enum addition for `stopping` or whether `stopping` remains internal and maps to an existing public status with a separate flag.
4. Keep XState snapshots out of API responses; expose Saivage read-model projections only.

Tests:

1. Extend `tests/runtime/actors/supervisor-runtime-api.test.ts` for active/paused/stopping status.
2. Extend `tests/application/xstate-runtime-api-factory.test.ts` for application-composed status.
3. Run `npm run validate:ui-smoke` because operator projections are affected.

### P2: Complete Tool Protocol Hardening

Goal: every tool call must have exactly one terminal delivery or error, and tool definitions must not drift from dispatch.

Issues covered: old-plan durable tool protocol gap, F12, F15.

Work:

1. Introduce shared tool-name constants for XState planner/executor tools.
2. Derive runtime argument validators from the same source as tool definitions, or define a single adjacent schema source that both definitions and dispatch use.
3. Enforce exactly-one pending -> delivered/errored/abandoned transition for each tool call.
4. Handle provider responses with multiple tool calls explicitly: fail fast or select a documented protocol rule, but do not silently take the first call.
5. Verify cancellation racing with active tool handling records a terminal tool status.

Tests:

1. Add tests for multi-tool-call provider output in `tests/runtime/actors/xstate-minimal-core.test.ts` or a focused tool-protocol suite.
2. Add tests for tool parser/schema parity.
3. Run `npm run typecheck`, `npm test`, `npm run validate:routine`.

### P3: Replace Brittle Reviewer Verdict Parsing

Goal: reviewer control-plane results should be structured, not accidental prose.

Issues covered: F05.

Work:

1. Prefer a reviewer tool/schema for `pass`, `needs_corrections`, and `fail` outcomes.
2. If tool-based reviewer output is too large for the immediate batch, add a small parser that accepts a strict JSON object and rejects ambiguous prose with an actionable error.
3. Do not normalize arbitrary prose into pass/fail. Fail loudly when the reviewer violates the protocol.

Tests:

1. Focused tests for valid pass/corrections/failure reviewer outputs.
2. Tests that unsupported prose fails without committing a false success.

### P4: Implement Real Startup Recovery

Goal: the recovery plan should drive safe actor/process/card reconciliation, not just be exposed for tests.

Issues covered: old-plan startup recovery gap, F08, F10, F16.

Work:

1. Define recovery policy by actor kind: supervisor, card, LLM, process.
2. Rebuild only safe actor trees from snapshots; explicitly abandon unsafe provider/tool/process boundaries with diagnostics.
3. For active card snapshots, reconcile public card status before dispatching more work.
4. Reconcile running process snapshots: either reattach if safe or mark abandoned/failed with evidence.
5. Add typed snapshot context schemas only for contexts that recovery will actually consume.
6. Decide completed snapshot retention policy: remove after completion, retain bounded history, or move to a history directory. Do not keep unbounded active-snapshot clutter by default.

Tests:

1. Startup tests for active card, active LLM, running process, stale pending tool call, and missing owner card.
2. Tests that recovery emits diagnostics for abandoned unsafe state.

### P5: Persist And Route NoteBox State, Then Remove Old Synthetic Fallback

Goal: changed-card propagation should use CardRunner NoteBox ownership rather than old synthetic planner-note fallback.

Issues covered: old-plan note fallback gap, F06.

Work:

1. Persist pending and delivered NoteBox state enough for recovery.
2. Route active notes through runtime-owned goal note sinks.
3. On shutdown, clear per-project active note registries.
4. Once inactive/no-owner recovery is covered, delete old synthetic planner-note fallback paths that only exist for the old planner/session model.

Tests:

1. Active goal receives changed note.
2. Restart recovers pending note or explicitly reports abandoned note.
3. Shutdown clears active note sink registry.

### P6: Delete Dead Runtime-Path Modules And Legacy Runtime Config Shapes

Goal: remove code that is not part of the new core.

Issues covered: F03, F11, F17, old-plan deletion targets.

Candidate deletes after one final grep:

1. `src/runtime/agent-runtime-factory.ts`
2. `src/runtime/candidate-availability-store.ts` (runtime-path copy only; keep live `src/agents/candidate-availability-store.ts`)
3. `src/runtime/crash-recovery.ts`
4. `src/runtime/persisted-planner-history.ts`
5. `src/runtime/runtime-diagnostics.ts`
6. `src/runtime/session-persistence-port.ts`
7. Legacy-only shapes in `src/runtime/runtime-config.ts`
8. `src/runtime/stuck-agent-supervisor.ts`, if still zero production importers after runtime-config cleanup and if its tests are not protecting a live product surface

Rules:

1. Re-grep each symbol immediately before deletion.
2. Delete direct tests that only protect deleted dead code.
3. Add or update boundary assertions only for old-runtime modules that should never reappear.

Tests:

1. `npm run typecheck`
2. `npm test`
3. `npm run validate:routine`

### P7: Terminal Commit And Runtime State Cleanup

Goal: finish low-risk cleanup that became easier after old runtime deletion.

Work from old plan:

1. Delete dead terminal-commit symbols and dead tests from WI-5/WI-6.
2. Remove the `transitionCard === false` / `!transitioned` family from WI-7 if still present.
3. Make `RuntimeState` required fields match the schema and remove false `?? []` guards from WI-15.
4. Fold in the small defensive cleanup in `reviewer-assessment.ts` when touching runtime state or terminal commit code.

Tests:

1. Focused terminal-commit tests.
2. Runtime reducer/state tests.
3. `npm run validate:routine`.

### P8: Broader Over-Engineering Cleanup

Goal: keep reducing accidental surface without distracting from core runtime correctness.

Work:

1. WI-1 freeze removal, decision-gated.
2. WI-2/WI-3/WI-4 dead barrels and path-preservation barrels.
3. WI-8 runtime-done signalling removal.
4. WI-9 dead `_input` contract factory params.
5. WI-11 `ProcessReadModelService` pass-through collapse.
6. WI-17 config legacy-key migration shim, decision-gated and only after checking live deployment configs.

Tests:

1. Follow the per-WI gates in `docs/design/over-engineering-remediation-plan.md`.
2. Run `npm run validate:ui-smoke` for web-visible status/schema changes.

## Explicit Non-Goals For This Plan

1. Do not reintroduce old runtime-core, dispatcher, startup repair, phase runner, or phase helper layers.
2. Do not add compatibility shims for old `.saivage` runtime state.
3. Do not expose XState snapshots directly through operator API/UI.
4. Do not perform a full event-sourced workflow rewrite.
5. Do not preserve dead code because tests happen to import it. Either move the useful behavior into current actor/domain tests or delete the test.

## Execution Checklist

1. P0 runtime ownership and cancellation.
2. P1 truthful status/activity reporting.
3. P2 durable tool protocol hardening.
4. P3 structured reviewer verdicts.
5. P4 startup recovery.
6. P5 NoteBox persistence and synthetic fallback removal.
7. P6 dead runtime-path module deletion.
8. P7 terminal/state cleanup.
9. P8 broader over-engineering cleanup.

Each priority block should be a separate tranche with focused tests first, then `npm run validate:routine`, `npm test`, `npm run build`, and `npm run validate:ui-smoke` when API/UI projections change.
