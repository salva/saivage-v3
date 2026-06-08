# Over-Engineering Remediation Plan

Status: execution plan. Companion to `over-engineering-findings.md`. Every step below was verified against real code (callers, signatures, blast radius). Paths use full `src/...`/`tests/...` form so the source-anchor checker can resolve them.

## How to execute this plan

- Each work item (WI-n) is an independent, separately-committable unit. Land them in the suggested order; nothing here requires a big-bang change.
- Per item, run the gates listed in that item, then the global gate before committing:
  - `npm run typecheck`
  - `npm test` (or the focused Jest files named in the item, then broaden)
  - `npm run validate:routine`
- Commit message style: `refactor(scope): …` for deletes/collapses, `fix(scope): …` only if behavior changes. One WI per commit.
- Before editing any symbol, re-grep it (names drift). If an anchor moved, fix it in `over-engineering-findings.md` and here first.
- Two items (WI-1 freeze, WI-13 config shim) need an explicit product decision before coding. They are written as "decision + plan-for-each-branch".

Suggested order: WI-2 → WI-3 → WI-4 → WI-5 → WI-6 → WI-7 → WI-8 → WI-9 → WI-10 → WI-11 → WI-12 → WI-1 → WI-13.
(Safe dead-code/unreachable removals first; larger refactors next; decision-gated items last.)

---

## WI-1 — Remove the dead `frozen` runtime concept (DECISION REQUIRED)

Verdict from the trace: `'frozen'` is an abandoned feature. Producers are 100% dead (no code sets `status:'frozen'`, writes a freeze manifest, or emits `frozen`/`resumed_from_freeze`; the HTTP routes and CLI command were already deleted). Readers/handlers are live but permanently unreachable. `readFreezeManifest` can only ever return `null` in production because its sole writer `saveFreezeManifest` has no production caller.

### Decision
Choose A or B and record it in the commit:
- **A (recommended): remove the concept end-to-end.** Consistent with AGENTS.md ("remove dead paths aggressively"; "no over-defensive code"). This is safe because there is no producer to preserve.
- **B: keep `'frozen'` as a defended-but-unreachable state.** Only justifiable if a near-term feature will reintroduce a producer. If so, document that intent and stop; do not half-remove.

The rest of WI-1 assumes A.

### Scope is large and cross-cutting (backend + schema + web). Split into 3 commits:

WI-1a backend producers + handlers:
- Delete file `src/runtime/freeze-manifest.ts` entirely (`saveFreezeManifest`, `readFreezeManifest`, `clearFreezeManifest`, `freezeManifestExists`).
- Delete the freeze builders in `src/runtime/runtime-core.ts`: `buildFreezeManifest`, `buildFreezeRuntimeStatePatch`, `buildResumeFromFreezeRuntimeStatePatch`, `buildResumeHandoffContext`, and the `FreezeManifest` import. (Around `src/runtime/runtime-core.ts:165`–`228`.)
- `src/runtime/control-api.ts`: remove the `readFreezeManifest`/`clearFreezeManifest`/`FROZEN_RUNTIME_RECOVERY_MESSAGE` re-exports (lines ~3-4).
- `src/runtime/runtime-control-commands.ts`: remove the `'frozen'` member from `RuntimeControlResult.code`, the `action?: 'inspect-frozen-state'` field, the `FROZEN_RUNTIME_RECOVERY_MESSAGE` const, and the `if (current.status === 'frozen')` branches in `pauseRuntimeCommand` (`:37`) and `resumeRuntimeCommand` (`:55-63`).
- `src/runtime/runtime-shutdown.ts:56`: remove the frozen-specific shutdown branch.
- `src/runtime/control.ts`: remove the frozen doc-comment lines.
- `src/tools/analyst-runtime-tools.ts`: drop the `FROZEN_RUNTIME_RECOVERY_MESSAGE` import and simplify `:50` from `state?.status === 'frozen' || state?.status === 'error'` to the `error` case only.
- `src/application/read-models/debug-read-model.ts`: remove the `readFreezeManifest` import and the `if (state.status === 'frozen')` block (`:19-21`).
- `src/server/sync-hub.ts`: remove `'frozen'`/`'resumed_from_freeze'` from `liveSyncEventKinds` (`:27-28`) and the two `case` arms (`:110-113`).

WI-1b schema/types:
- `src/schemas/types.ts`: remove `'frozen'` from `RuntimeStatus` (`:106`); delete `FreezeManifest` (`:113`), `frozen_reason` from `RuntimeState` (`:114`), `FrozenEvent` (`:153`), `ResumedFromFreezeEvent` (`:154`), and their members of `LoggedEvent` (`:186`). Decide on `runtimeRunStatusSchema`'s `'frozen'` (`src/schemas/validators.ts:77`): it is a distinct run-status enum also documented in `docs/agents.md:282` — verify no run record uses it (grep showed none) and remove it too, updating that doc line.
- `src/schemas/validators.ts`: remove `'frozen'` from `runtimeStatusSchema` (`:76`); delete `freezeManifestSchema` (`:110`), `frozenEventSchema` (`:146`), `resumedFromFreezeEventSchema` (`:147`); remove `frozen_reason` from `runtimeStateSchema` (`:108`).
- `src/schemas/event-catalog.ts:133-134`: remove the `frozen`/`resumed_from_freeze` registry entries.
- `src/schemas/index.ts`: remove the now-dangling re-exports (`FreezeManifest`, `FrozenEvent`, `ResumedFromFreezeEvent`, `freezeManifestSchema`, `frozenEventSchema`, `resumedFromFreezeEventSchema`; keep `runtimeStatusSchema`/`runtimeRunStatusSchema` exports, just without the literal).
- `src/runtime/state.ts:103`: remove `frozen_reason: null` from `defaultRuntimeState()`.

WI-1c web + tests + docs:
- Web (the `RuntimeStatus` type flows from `@saivage/schemas`, so types update automatically; remove the UI that references `'frozen'`): `web/src/stores/runtime.ts` (`isFrozen`, lines 72/94/99/192), `web/src/stores/runtime-read-model.ts` (`:58,79,85-86,110,117`), `web/src/composables/useDashboardReadModel.ts` (`:15,17,29`), `web/src/stores/debug.ts:62-63`, `web/src/views/DebugView.vue` (banner/grid/styles `:20-33,112-128,463-490`), `web/src/views/DashboardView.vue` (`:200,217,297-303`), `web/src/components/layout/WorkspaceHeader.vue` (`:79,86,93,202,217`).
- Tests to delete/trim: delete `tests/utils/freeze-manifest.test.ts`; trim freeze blocks in `tests/runtime/runtime-core.test.ts` (`:121-145`), `tests/runtime/runtime-control-commands.test.ts` (`:47-50`), `tests/analyst.test.ts` (`:580-603`), `tests/utils/event-logger.test.ts` (`:139-152`), `tests/application/events-read-model.test.ts:29` (swap event kind), `tests/utils/runtime-module-boundary.test.ts` (freeze identity asserts), and remove `frozen_reason: null` from the ~5 `RuntimeState` fixtures listed in the findings doc (and `web/src/__tests__/runtime-read-model.test.ts:15`).
- Keep as permanent removal guards: `tests/cli/saivage-reset.test.ts:10-24`, `web/src/__tests__/runtime-store.test.ts:39-40`, `web/src/__tests__/dashboard-view.test.ts:16`, `web/src/__tests__/api-client-contracts.test.ts:14-15`.
- `scripts/verify-doc-routes.js:15`: drop `freeze|resume-from-freeze` from `RUNTIME_CONTROL_ROW_RE`.
- Docs: update current docs that describe freeze as "helpers only" to state it is removed: `docs/operation.md:55,229`, `docs/analyst.md:22`, `docs/runbook/operations.md:168-170`, `docs/runbook/incidents.md:23,71-78`, `docs/runbook/index.md`, `docs/runbook/release.md:101-102`, `docs/index.md:9`, `docs/troubleshooting.md:6`, `docs/design/data-model.md:421,432`, `docs/design/server-api.md:110`, `docs/agents.md:282`. Leave `docs/historical/**` untouched.

Gates: `npm run typecheck`, `npm test`, `npm run validate:routine`, plus `npm run web:test:control-room` (web UI touched), and `npm run validate:docs` (docs touched).
Risk: MEDIUM (wide surface). Mitigation: do 1a/1b/1c as three commits, gates green at each.

---

## WI-2 — Delete dead barrel files

All verified zero production importers.

- Delete `src/agents/index.ts`, `src/agents/execution-api.ts` (only consumer is `tests/utils/agents-module-boundary.test.ts`).
- Delete `src/mcp/status-api.ts` (zero importers).
- Delete `src/agents/default-agent-execution.ts` (zero importers). Then edit `scripts/check-import-boundaries.cjs`: remove the `RUNTIME_AGENT_IMPORT_EXCEPTIONS` entry (`:20`) and the self-test case (`:111`) that reference it.
- `tests/utils/agents-module-boundary.test.ts`: this test targets the two dead barrels AND four live facades (`analyst-api`, `config-api`, `session-api`, `tool-api`). Do NOT blanket-delete. Rewrite it: drop the `agentsIndex`/`executionApi` imports and the three sub-tests that assert on them (the wildcard-export check, the package-root facade check, the "does not export implementation helpers" check); KEEP the `it('publishes explicit API modules …')` assertions for the four live `*-api` facades. If, after pruning, the file only covers the live facades, that's correct coverage to retain.

Gates: `npm run typecheck`, `npm test`, `npm run validate:routine`. (`check-import-boundaries` runs in the suite/validate.)
Risk: LOW.

---

## WI-3 — Collapse `src/agents/fake-agent.ts` path-preservation barrel

`src/agents/fake-agent.ts` is `export * from '../runtime/fake-agent.js'`. Real impl is `src/runtime/fake-agent.ts`; production already imports the runtime path (`src/runtime/agent-runtime-factory.ts:5`).

- Repoint all 13 test import sites from `../../src/agents/fake-agent.js` to `../../src/runtime/fake-agent.js`: `tests/runtime/planner-context-length-blocker.test.ts:12`, `tests/agents/agent-adapter-abort.test.ts:10`, `tests/agents/agent-runtime.test.ts:6`, `tests/utils/runtime-integration.test.ts:9,10`, `tests/utils/runtime-idle-running-intent-reconciliation.test.ts:14`, `tests/utils/runtime-continuous-improvement.test.ts:7`, `tests/utils/runtime-agent-events.test.ts:12`, `tests/utils/runtime-adapter-wiring.test.ts:7`, `tests/utils/error-logger.test.ts:16`, `tests/runtime/planner-non-actionable-output.test.ts:6`, `tests/runtime/planner-context-compaction.test.ts:6`, `tests/e2e/hardening-e2e.test.ts:30`. (The `tests/utils/agents-module-boundary.test.ts:13` site is removed in WI-2.)
- `scripts/verify-stage-v3-local-recreation.mjs:25`: repoint `dist/src/agents/fake-agent.js` → `dist/src/runtime/fake-agent.js`. (Note: this script imports `{ Runtime }` from `dist/src/runtime/runtime.js` at `:24`, but `runtime.ts` no longer exports `class Runtime`; the script looks already-broken — flag separately, don't fix it here.)
- Delete `src/agents/fake-agent.ts`.
- `scripts/check-import-boundaries.cjs`: if it has `agents/fake-agent` allowlist entries, remove them.

Gates: `npm run typecheck`, `npm test`, `npm run validate:routine`. Do WI-3 AFTER WI-2 (the two dead barrels that also re-export it are gone by then).
Risk: LOW (mechanical repoint).

---

## WI-4 — Delete `src/tools/agent-tools.ts` barrel

`AGENT_TOOL_DEFINITIONS` is defined at `src/tools/definitions/index.ts:165` and re-exported by `src/tools/index.ts:2`; `src/tools/agent-tools.ts` duplicates it.

- `tests/utils/tools-module-boundary.test.ts`: repoint the `:7` import to `import { AGENT_TOOL_DEFINITIONS } from '../../src/tools/definitions/index.js';` and keep the `:18` identity assertion meaningful (compare `toolsIndex.AGENT_TOOL_DEFINITIONS` against the definitions-module value).
- Delete `src/tools/agent-tools.ts`.
- `scripts/check-import-boundaries.cjs:25-26`: remove the now-dead `tools/agent-tools.ts` deep-import allowlist entries.

Gates: `npm run typecheck`, `npm test`, `npm run validate:routine`.
Risk: LOW.

---

## WI-5 — Delete dead exported symbols (clean, no test edits)

Each verified zero references beyond definition/barrel.

- `commitReviewerCorrection` — delete from `src/runtime/terminal-commit/commit-reviewer.ts:27` (barrel is `export *`, no line edit).
- `createLlmProviderGateway` — delete from `src/agents/llm-provider-gateway.ts:62`. Keep the `LlmProviderGateway` class.
- `RuntimeStateSnapshotPort` — delete from `src/contracts/agent-execution.ts:124` AND remove the explicit re-export line `src/contracts/index.ts:242`.
- `runtimeStatusForApi` (`src/agents/analyst-stage6.ts:23`), `markDescendantChanged` (`:46`), `normalizeRuntimeStatus` (`:104`) — delete all three; then prune now-unused imports in that file (`RuntimeStatus` at `:2`, `readRuntimeState` at `:5` — confirm no remaining use first).
- `ANALYST_TOOL_REGISTRY` — delete the alias at `src/agents/analyst-prompt.ts:90`.
- `MAX_LIST_RESULTS` — delete from `src/runtime/command-policy.ts:22`.

Gates: `npm run typecheck`, `npm test`, `npm run validate:routine`.
Risk: LOW.

---

## WI-6 — Delete dead exported symbols (with test-block edits)

- `commitPlannerDone` (`src/runtime/terminal-commit/commit-planner.ts:6`): delete the function; in `tests/runtime/terminal-commit.test.ts` remove the import (`:10`) and the `it('rejects planner done for parent goal and commits it for planning-only cards')` block (`:221-237`).
- `validateEvidenceCompleteness` cluster (`src/runtime/terminal-commit/validators.ts`): delete `validateEvidenceCompleteness` (`:92`), the `EvidenceCompleteness` type (`:12`, only its return type), and the private `evidenceIdsFromResult` (`:119`, only its callee). In `tests/runtime/terminal-commit.test.ts` remove the import (`:13`) and the `it('checks reviewer evidence completeness')` block (`:137-149`).
- `deleteSession` (`src/runtime/session-persistence.ts:345`) and `buildConversationContext` (`:365`): delete both; in `tests/agents/session-persistence.test.ts` delete the `describe('deleteSession', …)` block (`:446-455`) and `describe('buildConversationContext', …)` block (`:484-496`). No import line to edit (namespace import). Deleting from the runtime source removes both access paths (the `src/agents/session-persistence.ts` `export *` re-export needs no edit).

Note: `commitPlannerDone` and `validateEvidenceCompleteness` both touch the same test file — do them in one commit. Neither test file becomes empty.

Gates: focused `tests/runtime/terminal-commit.test.ts` + `tests/agents/session-persistence.test.ts`, then `npm run typecheck`, `npm test`, `npm run validate:routine`.
Risk: LOW.

---

## WI-7 — Delete the dead `transitionCard === false` / `!transitioned` family

`RuntimeStateMachine.transitionCard` (`src/runtime/state-machine.ts:184`) only returns `true` or throws. Remove the unreachable arms and the over-widened type.

- `src/runtime/terminal-commit/commit-executor.ts`: change `TerminalCommitEffects.transitionCard` return type (`:6`) from `Promise<boolean | unknown> | boolean | unknown` to `Promise<void>` (the boolean was only used by the dead `=== false`). Delete the `transitionOrThrow` helper (`:126`) and replace its three call sites with a direct `await effects.transitionCard(...)`.
- `src/runtime/terminal-commit/commit-planner.ts`: delete `transitionOrThrow` (`:69`); replace `await transitionOrThrow(...)` calls with `await ...transitionCard(...)`. (Note: the `if (input.card.status !== 'blocked')` guard added by the duplicate-block fix stays.)
- `src/runtime/terminal-commit/commit-reviewer.ts`: same (`transitionOrThrow` at `:63`).
- `src/runtime/executor-activation-dispatcher.ts`: the `transitionCard` call at `:57` always yields `true`; delete the `if (!transitioned) { … failed:true }` branch (`:61`). Also simplify `:161`: `handleExecutorCompletion` always returns `transitioned:true`, so change `failed: !completion.transitioned || completion.failed` to `failed: completion.failed`, and drop the `transitioned` field from `handleExecutorCompletion`'s return type (`src/runtime/phases/executor-completion-handler.ts` returns at `:83,92,94`).
- `src/runtime/phases/planner-activation-runner.ts:44`: the `transitionCard` at `:43` always yields `true`; delete the `if (!transitioned) throw …`.
- The test `tests/runtime/terminal-commit.test.ts:149` ("throws and does not write when a terminal transition is rejected") sets `fx.transitionCard = async () => false` to force the dead path. Since `transitionCard` can never return `false` in reality, this test asserts a non-real contract — delete this test case (it tests removed behavior).

Gates: focused `tests/runtime/terminal-commit.test.ts`, `tests/runtime/executor-phase-runner.test.ts`; then `npm run typecheck`, `npm test`, `npm run validate:routine`. Watch for other tests that mock `transitionCard` returning false.
Risk: LOW–MEDIUM (touches several commit helpers; the test suite will catch regressions).

---

## WI-8 — Remove the unused runtime-done signalling path

- `src/agents/agent-loop-driver.ts`: change `executeActionToolCalls` return type (`:44`) from `Promise<{ runtimeSignalledDone: boolean }>` to `Promise<void>`; its result is never read (calls at `:101,127,143`). Delete the `signalDoneFromRuntime` interface method (`:64`) and implementation (`:203`), and the local `runtimeDoneEnvelope` variable (`:74`) and its branch (`:78-82`). Keep the `io.takeRuntimeDoneEnvelope()` mechanism (the real path).
- `src/agents/invocation-runner.ts:333`: stop computing/returning `{ runtimeSignalledDone: … }`; return nothing.
- `tests/agents/agent-loop-driver.test.ts`: delete the test(s) that call `driver.signalDoneFromRuntime(...)` (`:136-148`) since that method is removed; keep the `takeRuntimeDoneEnvelope` tests.

Gates: focused `tests/agents/agent-loop-driver.test.ts`; then `npm run typecheck`, `npm test`, `npm run validate:routine`.
Risk: LOW.

---

## WI-9 — Drop dead `_input` params on contract factories

`createExecutorContract` (`src/contracts/executor-contract.ts:22`), `createReviewerContract` (`src/contracts/reviewer-contract.ts:22`), `createPlannerContract` (`src/contracts/planner-contract.ts:28`) each take an `_input` that is never read; the returned contract is constant.

- Remove the parameter from each factory and from all ~7 call sites each (e.g. `src/agents/agent-adapter.ts:348,360`, the phase runners, `src/scripts/probe-llm-contract.ts`). Stop constructing the discarded argument objects at call sites.
- Optional follow-up (separate, do not bundle): since the contracts are now argument-free constants, consider making them module-level singletons. Leave as factories if that's a larger change.

Gates: `npm run typecheck`, `npm test`, `npm run validate:routine`. Note `src/contracts/**` is consumed by `web/src/api/contracts.ts`; run `npm run web:typecheck` too.
Risk: LOW–MEDIUM (many call sites; typecheck-driven).

---

## WI-10 — Trim the `process-runner.ts` dead wrapper surface

`src/runtime/process-runner.ts` (largest file, 1083 lines) exposes free-function + class-method twins, several with zero production imports. Production uses only: `getProcess`, `killProcess`, `listProcesses`, `tailOutput`, `reconcileProcessRecords`, `disposeProcessRuntimeScope`, `setProcessTerminalBuffering`, `loadRegistry`.

- Re-grep each candidate to reconfirm zero production importers before deleting (file is large; be careful):
  - Fully dead chains (delete free fn + method + the `*ForService` core if reached nowhere else): `saveRegistry` (+`saveRegistryForService`), `registerProcessTerminalSink` (+`registerProcessTerminalSinkForService`), `cleanupProcessOutput`/`cleanupAllCompleted` (+`cleanupProcessOutputForService`/`cleanupAllCompletedForService`).
  - Dead wrappers only (keep the `*ForService` core, which stays live via another path): `startProcess` (logic stays via `startProcessForService` used by `startAndWait`), `stopAllRunningForRuntimeShutdown` (stays via `disposeProcessRuntimeScopeForService`), `snapshotProcessRuntimeScope`.
- Remove the corresponding re-exports from `src/runtime/process-api.ts` / any barrel if present.
- Check `tests/` for references to the removed wrappers; delete/adjust those test cases.

Gates: focused process tests (grep `tests` for `process-runner`/`process-api`); then `npm run typecheck`, `npm test`, `npm run validate:routine`.
Risk: MEDIUM (large file; verify each name's callers individually; do it as one focused commit).

---

## WI-11 — Collapse `ProcessReadModelService` (pass-through class)

`src/application/read-models/process-read-model.ts` is a stateless class forwarding every method to `processApi(this.projectRoot)`.

- Replace the class with direct `processApi(projectRoot)` use at its one production consumer `src/server/routes/operator-process-handlers.ts:5` (it already has `options.projectRoot`).
- Keep the `ProcessView`/`ProcessListResponse`/… type re-exports if other modules import them from this path; otherwise move consumers to import from `src/runtime/process-api.ts`.
- Delete the class export from `src/application/read-models/index.ts:12` and delete `process-read-model.ts` (or reduce it to the type re-exports only, if those are used).
- `tests/application/process-read-model.test.ts` (89 lines): this tests the wrapper. Either delete it (the underlying `processApi` is tested elsewhere) or repoint it to assert on `processApi(projectRoot)` directly. Prefer repoint if it covers view-mapping logic not covered elsewhere; verify first.

Gates: focused `tests/application/process-read-model.test.ts` + the operator-process route test; then `npm run typecheck`, `npm test`, `npm run validate:routine`.
Risk: LOW–MEDIUM.

---

## WI-12 — Demote `*PhaseRunner` classes to functions

`ReviewerPhaseRunner`, `ExecutorPhaseRunner`, `PlannerPhaseRunner` are stateless single-`run()` classes, each `new`'d-and-discarded at one production call site.

- Convert each to a plain async function, e.g. `runPlannerPhase(deps, input)`, preserving the body verbatim.
- Update the three production call sites: `src/runtime/phases/planner-iteration-runner.ts:46`, `src/runtime/executor-activation-dispatcher.ts:77`, `src/runtime/runtime-reviewer-dispatcher.ts:70` (replace `await new XPhaseRunner({…}).run({…})` with `await runXPhase({…}, {…})`).
- Update the three tests: `tests/runtime/executor-phase-runner.test.ts:25`, `tests/runtime/planner-phase-runner.test.ts:12`, `tests/runtime/reviewer-phase-runner.test.ts:17` (they construct the class — switch to the function). These are small (42-61 lines) real-logic tests; keep their assertions, change only construction.
- These may sit behind `src/contracts` ports or be referenced in `docs/agents.md`/parity tests — check the agent-tool parity guard isn't affected (it shouldn't be; these are internal phases).

Gates: the three focused phase-runner tests; then `npm run typecheck`, `npm test`, `npm run validate:routine`.
Risk: LOW–MEDIUM (do the three together or one at a time).

---

## WI-13 — Smaller pass-through cleanups (batchable)

These are independent one-liners; can be one commit.

- `src/agents/agent-adapter.ts:277,280`: `redactModelIssueText` and `redactProviderErrorMessage` have byte-identical bodies. Merge to a single private method; update the two pass-through points (`AgentInvocationRunner` ctor at `:209-210` and `compensateActivationBarrierThrow` at `:217,390`) to use the one method.
- `src/redaction/index.ts:296`: `redactTextForOutbound`/`redactSnippetForOutbound` accept an `options` arg then `void options`. Drop the dead `options` parameter from both signatures and from all call sites (e.g. `src/agents/agent-adapter.ts:278`). Keep `redactForOutbound` (`:292`), which does forward options.
- `src/runtime/runtime.ts:150` ↔ `src/runtime/core-composition.ts:132`: the `controls` object is a 1:1 forwarder between `RuntimeApi` and `RuntimeLifecycleController`. Collapse the redundant `controls` intermediate so `RuntimeApi` calls the lifecycle controller directly (keep the two non-trivial entries `getStatus`/`getActivityStatus`).

Gates: `npm run typecheck`, `npm test`, `npm run validate:routine`.
Risk: LOW.

---

## WI-14 — `agentExecutionFactory` dead config seam (CAREFUL — not what it looks like)

Correction to the findings doc: `createDefaultAgentExecution` (`src/runtime/agent-runtime-factory.ts:15`) is NOT dead — it is the test fallback that constructs `FakeAgentAdapter` when `Runtime` is created without an injected `agentRuntime`. Production always injects `agentAdapter` (`src/application/runtime-composition.ts:113` → `src/runtime/runtime.ts:88,92`), so the fallback is dead in production but live in tests.

What IS dead: the `agentExecutionFactory` config field (`src/runtime/runtime-config.ts:69`) is never assigned anywhere; the `?? createDefaultAgentExecution` indirection at `src/runtime/agent-runtime-factory.ts:39` always resolves to `createDefaultAgentExecution`.

- Remove the `agentExecutionFactory?` field from `src/runtime/runtime-config.ts:69`.
- Simplify `src/runtime/agent-runtime-factory.ts:38-47`: drop `input.config.agentExecutionFactory ??`, call `createDefaultAgentExecution(...)` directly in the `input.agentRuntime ?? …` fallback.
- Do NOT delete `createDefaultAgentExecution` or `FakeAgentAdapter` (tests rely on the fallback). (The `src/agents/default-agent-execution.ts` barrel is removed separately in WI-2.)

Gates: `npm run typecheck`, `npm test`, `npm run validate:routine`.
Risk: LOW.

---

## WI-15 — `RuntimeState` interface/schema mismatch + `?? []` sweep (HIGH leverage)

`src/schemas/types.ts:114` marks `runtime_intent?`, `runtime_commands?`, `runtime_runs?`, `runtime_activations?` optional; `src/schemas/validators.ts:108` (`runtimeStateSchema`) makes them required. Every in-memory `RuntimeState` is schema-validated (`src/persistence/atomic-json-file.ts`) or built by `defaultRuntimeState()` (`src/runtime/state.ts:91`), so the optionality is false and drives ~47 reflexive `?? []`/`?? 'stopped'` guards in `src/runtime`.

Do this as a careful two-step commit:
1. Make the four fields non-optional in the `RuntimeState` interface (`src/schemas/types.ts:114`). Run `npm run typecheck` — it will flag any construction site that doesn't set all four. Fix those to set the arrays/intent explicitly (there should be few; `defaultRuntimeState` already does).
2. Remove the now-dead guards: replace `(state.runtime_runs ?? [])` → `state.runtime_runs`, `runtime_intent?.status ?? 'stopped'` → `runtime_intent.status` (verify each: keep guards only where the value is genuinely a partial/builder input, not a full `RuntimeState`). The ~47 sites are in `src/runtime/state.ts`, `runtime-core.ts`, `mutations.ts`, `startup-repair.ts`, `startup-blocked-planning.ts`, `runtime-diagnostics.ts`. Keep `active_card_run?`, `paused_at?`, `last_tick_at?`, `frozen_reason?` (genuinely nullable; note `frozen_reason` is removed by WI-1).

Caveat: do this AFTER WI-1 (freeze removes `frozen_reason`) to avoid churn, or coordinate. Sweep guards file-by-file with typecheck+tests green between files.

Gates: `npm run typecheck` (drives step 1), `npm test`, `npm run validate:routine`. Run after each file in step 2.
Risk: MEDIUM (touches many runtime files, but typecheck + the large runtime test suite are strong nets).

---

## WI-16 — Collapse triple `cardRecordSchema.parse` in the card write path (HIGH leverage, hot path)

The same in-memory `CardRecord` is parsed 3× per mutation: `src/cards/card-patch-service.ts:53` → `src/cards/apply-mutation.ts:209` (persist) / `:169` (create) → `src/cards/apply-mutation.ts:106` (`stageByIdTmp`).

- Decide the single authoritative gate. Recommended: keep the parse at the durable boundary (`stageByIdTmp`, `src/cards/apply-mutation.ts:106`) — it is the last point before bytes hit disk and covers both create and persist. Drop the redundant `cardRecordSchema.parse(op.next)` (`:209`) and `cardRecordSchema.parse(op.card)` (`:169`), and the service-layer `safeParse` in `src/cards/card-patch-service.ts:53` and `src/cards/lifecycle-commands.ts:105` — IF the writer-boundary parse fully covers them. Verify the error-handling contract: `card-patch-service.ts` currently throws a specific error on `safeParse` failure (`:53-54`); ensure the retained gate produces an equally clear failure.
- Keep `src/cards/position-repair.ts:20` and `src/cards/evidence-ref-service.ts:97` parses (different inputs/paths — verify they're not in this hot path before touching).
- This is a behavior-adjacent change (validation timing). Add/keep a test that a malformed card is still rejected with a clear error at the single gate.

Gates: focused card tests (`tests/cards/**`), then `npm run typecheck`, `npm test`, `npm run validate:routine`.
Risk: MEDIUM (validation path; keep one authoritative parse, prove rejection still works).

---

## Smaller defensive cleanups (fold into the nearest related WI when touching the file)

- `src/runtime/reviewer-assessment.ts:55`: `card.artifacts`/`card.attachments` are required arrays; drop `?.`/`?? 0` → `card.artifacts.length === 0 && card.attachments.length === 0`. (Do alongside WI-15 or standalone.)
- `src/runtime/state-machine.ts:92-97`: `patchRuntimeState` mutation discards `updateRuntimeState`'s returned state, forcing a re-read + null-throw. Have the mutation return the new state and pass it through (removes the redundant `readRuntimeState` + throw). Touches the mutation port's `void` contract — small, do as its own commit.
- `src/cards/validator.ts:96` `?? 0` after the depth map is fully populated; `src/runtime/runtime-core.ts:204` redundant cast — LOW priority, opportunistic.

---

## Items deliberately NOT changed (guardrails)

- Broad try/catch in `src/runtime/crash-recovery.ts`, `src/agents/tool-dispatcher.ts`, `src/agents/invocation-recovery-policy.ts`, `src/persistence/durable-write.ts`, and untrusted-JSON parsing — legitimate boundaries; leave them.
- `RuntimeStateMutationPort`, the fine-grained `Runtime*Port` DI seams, `McpToolInvocationPort` — real shared/test seams; keep.
- `src/contracts/**` exports — consumed by `web/src/api/contracts.ts`; a src-only scan misses them. Always check web before deleting a contract symbol.
- The reviewer-correction flow (`reviewer-assessment-handler.ts`, `{ kind: 'continue_planner' }`) is the live path; only the unused `commitReviewerCorrection` helper goes.

## Tracking checklist

- [ ] WI-1 freeze (decision: A/B) — 1a backend, 1b schema, 1c web/tests/docs
- [ ] WI-2 dead barrels + boundary test prune
- [ ] WI-3 fake-agent barrel collapse
- [ ] WI-4 agent-tools barrel
- [ ] WI-5 clean dead-symbol deletes
- [ ] WI-6 dead-symbol deletes with test-block edits
- [ ] WI-7 transitionCard dead-branch family
- [ ] WI-8 runtime-done signalling removal
- [ ] WI-9 contract-factory dead `_input` params
- [ ] WI-10 process-runner dead wrappers
- [ ] WI-11 ProcessReadModelService collapse
- [ ] WI-12 PhaseRunner classes → functions
- [ ] WI-13 small pass-through cleanups
- [ ] WI-14 agentExecutionFactory dead seam
- [ ] WI-15 RuntimeState interface + `?? []` sweep
- [ ] WI-16 triple card parse collapse
- [ ] smaller defensive cleanups (opportunistic)
