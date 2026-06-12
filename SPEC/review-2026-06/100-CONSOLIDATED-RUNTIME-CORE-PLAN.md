# Consolidated Runtime Core Plan

Status: new execution plan, written after reassessing the XState runtime review findings against current code and the active cleanup plans on 2026-06-12. Updated on 2026-06-12 to make XState central and load-bearing, not optional or decorative.

This plan supersedes the local ordering in `99-METAPLAN.md` for runtime-core work. It does not replace the broader over-engineering plan wholesale; it pulls forward the parts that matter for the new runtime core and leaves lower-priority cleanup as later batches.

## Architectural Directive

XState is a central design requirement for the new core. The corrective action is not to remove XState from runners, and not to keep imperative runner loops with snapshots attached. The corrective action is to make XState own runtime behavior.

Mandatory rules for the next implementation tranche:

1. `RuntimeSupervisor`, `GoalCardRunner`, `TerminalCardRunner`, `LlmRunner`, and `ProcessRunner` must be real XState actors whose states and events drive behavior.
2. Long-running provider calls, reviewer calls, child activations, and process waits must be invoked services / actors owned by the machine, not ad-hoc `for` loops around `await`.
3. Cancellation, pause/quiescence, startup recovery, and tool delivery must be represented as machine events and states.
4. Controller classes are suspect baggage from the drifted implementation. Delete them by default. Keep a wrapper only when it is a real external boundary, such as a `RuntimeApi` adapter for HTTP/CLI/application code.
5. Child actors should normally be exported as machine definitions plus small actor factory functions, not as `*Controller` classes with behavior methods.
6. Persisted actor snapshots must correspond to meaningful recovery states, not post-hoc logs of what imperative code already did.
7. Keep the architecture simple: use the smallest XState machines that remove invalid states. Do not add generic workflow frameworks, event sourcing, queues, or compatibility bridges.

Controller deletion rule:

1. If a class has `start()`, `cancel()`, `reviewPlannerResult()`, `handleExecutorToolCall()`, or any loop/branching that decides runtime progress, it is competing with XState and must be removed or reduced to a test-only helper during the rework.
2. A retained external adapter may construct the top-level actor system, send commands to the supervisor actor, subscribe/wait for supervisor snapshots, and project read-model state. It must not import, instantiate, or call card, LLM, reviewer, child-activation, or process runner implementations. It must not call `runner.start()`, `runner.cancel()`, `startChild()`, `runTurn()`, `wait()`, or any method that advances runtime behavior. Runtime behavior may advance only through XState actor events, invocations, spawned children, and machine transitions.
3. Prefer files named `*.machine.ts`, `*.actor.ts`, `*.actors.ts`, or `*.projection.ts` over `*Controller` for the new core.

## Review Verdicts

The earlier review found real problems, but not all deserve the same priority or framing.

| Finding | Verdict | Reason |
| --- | --- | --- |
| F01 `startProject()` is synchronous/imperative | Accepted, reframed | The immediate bug is not that it awaits completion by itself; the bug is that active execution is not represented as runtime-owned cancellable work. |
| F02 XState machines are decorative | Accepted as top-priority architectural defect | True for `GoalCardRunner`, `TerminalCardRunner`, and `LlmRunner`. Because XState is a central requirement, this must be fixed by making machines own invocation, tool, cancellation, completion, and recovery transitions. |
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
4. Delete remaining old dispatcher/core-adjacent source in the same tranche that replaces the product behavior with XState actor/domain/API tests. Do not preserve old implementation behavior, old lifecycle artifacts, old run ledgers, or old broad integration coverage as acceptance criteria.

From `docs/design/over-engineering-remediation-plan.md`, the runtime-relevant cleanup still worth keeping in the queue is:

1. WI-1 freeze removal, after an explicit decision.
2. WI-5/WI-6/WI-7 terminal-commit dead symbol and dead branch cleanup.
3. WI-14 legacy `agentExecutionFactory` seam cleanup, if still present after the XState deletion tranche.
4. WI-15 `RuntimeState` required-field typing and `?? []` guard sweep, after freeze and old-runtime deletion reduce churn.
5. WI-17 config legacy-key migration shim decision, after deployment config inspection.

## Priority Order

### P0: Make XState Load-Bearing

Goal: replace imperative runner orchestration with XState-owned behavior before adding more runtime features.

Issues covered: F01, F02, F04, F13.

Work:

1. Redesign `LlmRunner` as an invoked-actor machine:
   - `idle` -> `requesting_admission` -> `calling_provider` -> `returned_message` / `returned_tool_call` / `failed` / `cancelled`.
   - Provider invocation must be an XState invocation with cancellation/cleanup semantics.
   - Admission request/release must happen through machine entry/exit actions, not manual `try/finally` in controller code.
   - Provider output must be represented faithfully. If the first XState runtime supports only one tool call per turn, the machine must fail fast on multiple tool calls in P0 rather than silently selecting the first. Later tool-protocol work may add richer exactly-once persistence, but P0 must not encode lossy provider-output semantics.
2. Redesign `TerminalCardRunner` as an XState machine whose states drive executor turns:
   - `idle`, `marking_running`, `waiting_for_llm`, `handling_tool`, `delivering_tool_result`, `committing_success`, `committing_failure`, `blocked`, `cancelled`, `done`.
   - Tool handling (`run_process`, `wait_process`, `inspect_process`, `kill_process`) must be invoked actors/services owned by the machine.
   - The hard turn budget should be machine context updated on each `LLM_RESULT`/`LLM_TOOL_CALL`, not a `for` loop.
3. Redesign `GoalCardRunner` as an XState machine whose states drive planner/reviewer/child flow:
   - `idle`, `marking_running`, `planning`, `activating_child`, `reviewing`, `delivering_child_result`, `applying_review_corrections`, `committing_outcome`, `blocked`, `failed`, `cancelled`, `done`.
   - `activate_card` must not call a `ChildActivationPort.startChild()` Promise API. The goal machine handles the tool call by spawning/invoking the child card actor through the supervisor-owned actor registry or an injected actor factory. The child result returns as a typed actor completion/event. Any child-activation adapter that contains branching, recursion, or awaits child completion is old-runtime baggage and must be deleted.
   - Reviewer verdict must be a typed event, not a direct function return that decides the next imperative loop iteration.
4. Redesign `RuntimeSupervisor` as the parent actor that owns the root project actor and runtime mode:
   - `idle`, `running`, `pausing`, `paused`, `stopping`, `stopped`.
   - `startProject()` sends a `START_PROJECT` event and returns once the command is accepted/started; completion is observed through actor state/events.
   - `stopProject()` and `shutdown()` send cancellation/stop events to children and wait for the supervisor actor to reach a terminal/quiescent state.
5. Delete or collapse controller classes:
   - Replace `LlmRunnerController` with a `llmTurnMachine` plus `createLlmTurnActor(...)` or a parent-spawned actor.
   - Replace `TerminalCardRunnerController` with a `terminalCardMachine` plus actor input/dependency injection.
   - Replace `GoalCardRunnerController` with a `goalCardMachine` plus actor input/dependency injection.
   - Replace `ProcessRunnerController` if it contains process lifecycle decisions that belong in `processMachine`.
   - Keep only a thin `RuntimeApi` adapter if needed for the existing public `RuntimeApi` interface.
6. Move orchestration into machine definitions and invoked actors:
   - provider turn invocation belongs to `llmTurnMachine`;
   - executor tool dispatch belongs to `terminalCardMachine` or spawned tool/process actors;
   - child activation belongs to `goalCardMachine` via spawned/invoked child card actors;
   - reviewer verdict handling belongs to `goalCardMachine`;
   - cancellation/quiescence belongs to parent/child XState event flow.
7. Persist meaningful XState snapshots at machine state boundaries. Recovery should be able to inspect a snapshot and know whether the actor was calling a provider, waiting for a child, handling a tool, committing a result, or done.
8. For every P0 machine state, define a recovery classification before implementation: `resume_safe`, `abandon_with_diagnostic`, `reconcile_then_resume`, or `terminal`. Persist only context required by those classifications. Full startup rebuilding may land later, but P0 machines must not introduce states whose recovery behavior is undefined.
9. Keep the implementation small. The first pass may use explicit `fromPromise`/invoked service actors and typed events; do not introduce extra abstraction layers around XState.
10. A machine state should normally represent a durable wait point, cancellation boundary, recovery boundary, or externally meaningful lifecycle phase. Pure synchronous side effects such as marking running or committing a result may be entry/exit actions unless they need retry/recovery semantics. Do not create transient states solely to mirror every function call.

P0 is not complete unless `stopProject()` and `shutdown()` can cancel an active provider call, reviewer call, child activation, and process wait through supervisor-to-child XState events, and can observe a bounded quiescent state. P1 may refine diagnostics and projections, but cancellability and quiescence are P0 acceptance criteria.

Tests:

1. Replace tests that assert imperative `start()` loop completion with tests that send machine events or use the facade to observe state transitions.
2. Add state-transition tests for planner tool call, child activation, reviewer correction, executor tool call, provider error, cancellation while provider call is active, and cancellation while process wait is active.
3. Add tests that `stopProject()` sends cancellation to active children and reaches quiescence.
4. Add boundary tests that `src/runtime/actors/*controller*.ts` files are absent or contain no orchestration methods/loops.
5. Add a boundary test that `supervisor-runtime-api.ts` imports only the supervisor actor/factory and read-model projection modules from `src/runtime/actors`; it must not import `goal-card-runner`, `card-runner`, `llm-runner`, `process-runner`, or `xstate-child-activation` orchestration APIs.
6. Add direct machine tests that can exercise transitions without constructing controller classes.
7. `npm run typecheck`, focused actor tests, `npm test`, `npm run validate:routine`.

### P1: Polish Runtime Ownership Diagnostics And Status After P0 Cancellation

Goal: refine diagnostics, public command records, and state projection after P0 proves active runtime work is owned, observable, and stoppable by the XState actor tree.

Issues covered: F01, F04, F13.

Work:

1. Store the root project actor reference in the supervisor actor context or child actor map, not as an untracked local in `startProject()`.
2. Improve diagnostics around explicit machine cancellation events (`CANCEL_REQUESTED`, `CHILD_CANCELLED`, `PROVIDER_CANCELLED`, `PROCESS_CANCELLED`) and terminal states created in P0.
3. Make `stopProject()` and `shutdown()` command records reflect whether cancellation reached quiescence, timed out, or abandoned unsafe work.
4. If a public adapter method needs to wait for completion, implement it by subscribing to actor snapshots or waiting for a machine state, not by running the orchestration itself.

Tests:

1. Focused tests in `tests/runtime/actors/xstate-minimal-core.test.ts` for cancellation during planner, reviewer, executor, and process waits.
2. `tests/runtime/actors/supervisor-runtime-api.test.ts` for `stopProject()` cancelling active work.
3. `npm run typecheck`, `npm test`, `npm run validate:routine`.

### P2: Make Operator Status Truthful

Goal: status APIs must reflect active XState runtime work instead of returning idle placeholders.

Issues covered: F09, F14, partial F01.

Work:

1. Replace hardcoded `getActivityStatus()` with a projection from supervisor/card/LLM actor snapshots and tool-delivery read-model records. Do not query or preserve `LlmRunnerController`; by P2 it must be gone or reduced to a test-only helper outside the production runtime import tree.
2. Replace `getStatus()` placeholders: distinguish idle, paused, stopping, and active work; compute current card from the active runner; compute `goalCount` from the card store or a cheap read-model projection.
3. Decide whether `RuntimeStatus` needs a schema enum addition for `stopping` or whether `stopping` remains internal and maps to an existing public status with a separate flag.
4. Keep XState snapshots out of API responses; expose Saivage read-model projections only.

Tests:

1. Extend `tests/runtime/actors/supervisor-runtime-api.test.ts` for active/paused/stopping status.
2. Extend `tests/application/xstate-runtime-api-factory.test.ts` for application-composed status.
3. Run `npm run validate:ui-smoke` because operator projections are affected.

### P3: Complete Tool Protocol Hardening

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

### P4: Replace Brittle Reviewer Verdict Parsing

Goal: reviewer control-plane results should be structured, not accidental prose.

Issues covered: F05.

Work:

1. Prefer a reviewer tool/schema for `pass`, `needs_corrections`, and `fail` outcomes.
2. If tool-based reviewer output is too large for the immediate batch, add a small parser that accepts a strict JSON object and rejects ambiguous prose with an actionable error.
3. Do not normalize arbitrary prose into pass/fail. Fail loudly when the reviewer violates the protocol.

Tests:

1. Focused tests for valid pass/corrections/failure reviewer outputs.
2. Tests that unsupported prose fails without committing a false success.

### P5: Implement Real Startup Recovery

Goal: the recovery plan should drive safe actor/process/card reconciliation, not just be exposed for tests.

Issues covered: old-plan startup recovery gap, F08, F10, F16.

Work:

1. Define recovery policy by actor kind and state value: supervisor, card, LLM, process.
2. Rebuild only safe XState actor trees from snapshots; explicitly abandon unsafe provider/tool/process boundaries with diagnostics.
3. For active card snapshots, reconcile public card status before dispatching more work.
4. Reconcile running process snapshots: either reattach if safe or mark abandoned/failed with evidence.
5. Add typed snapshot context schemas only for contexts that recovery will actually consume.
6. Decide completed snapshot retention policy: remove after completion, retain bounded history, or move to a history directory. Do not keep unbounded active-snapshot clutter by default.

Tests:

1. Startup tests for active card, active LLM, running process, stale pending tool call, and missing owner card.
2. Tests that recovery emits diagnostics for abandoned unsafe state.

### P6: Persist And Route NoteBox State, Then Remove Old Synthetic Fallback

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

### P7: Delete Dead Runtime-Path Modules And Legacy Runtime Config Shapes

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

### P8: Terminal Commit And Runtime State Cleanup

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

### P9: Broader Over-Engineering Cleanup

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
4. Do not keep XState as a decorative persistence/state-label layer around imperative loops.
5. Do not preserve `*Controller` classes as renamed old-runtime orchestration. They are allowed only as thin external adapters, and only if a plain function/factory would be worse.
6. Do not preserve `ChildActivationPort.startChild()` or equivalent Promise-returning child dispatch facades as the card-activation mechanism.
7. Do not perform a full event-sourced workflow rewrite.
8. Do not preserve dead code because tests happen to import it. Either move the useful behavior into current actor/domain tests or delete the test.

## Execution Checklist

1. P0 make XState load-bearing.
2. P1 runtime ownership diagnostics/status after P0 cancellation.
3. P2 truthful status/activity reporting.
4. P3 durable tool protocol hardening.
5. P4 structured reviewer verdicts.
6. P5 startup recovery.
7. P6 NoteBox persistence and synthetic fallback removal.
8. P7 dead runtime-path module deletion.
9. P8 terminal/state cleanup.
10. P9 broader over-engineering cleanup.

Each priority block should be a separate tranche with focused tests first, then `npm run validate:routine`, `npm test`, `npm run build`, and `npm run validate:ui-smoke` when API/UI projections change.
