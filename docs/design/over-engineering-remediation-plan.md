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
- Two items need an explicit product decision before coding: WI-1 (freeze concept) and WI-17 (config legacy-key migration shim). They are written as "decision + plan-for-each-branch".

Suggested order: WI-2 → WI-3 → WI-4 → WI-5 → WI-6 → WI-7 → WI-8 → WI-9 → WI-10 → WI-11 → WI-13 → WI-14 → WI-1 → WI-15 → WI-16 → WI-17. (Safe dead-code/unreachable removals first; then small collapses; then the freeze removal; then the higher-leverage refactors; decision-gated config shim last. WI-12 is optional/skip. WI-15 deliberately follows WI-1 because WI-1 removes `frozen_reason`.)

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

- Repoint all remaining test import sites from `../../src/agents/fake-agent.js` to `../../src/runtime/fake-agent.js`: `tests/runtime/planner-context-length-blocker.test.ts:12`, `tests/agents/agent-adapter-abort.test.ts:10`, `tests/agents/agent-runtime.test.ts:6`, `tests/utils/runtime-integration.test.ts:9,10`, `tests/utils/runtime-idle-running-intent-reconciliation.test.ts:14`, `tests/utils/runtime-agent-events.test.ts:12`, `tests/utils/error-logger.test.ts:16`, `tests/runtime/planner-non-actionable-output.test.ts:6`, `tests/runtime/planner-context-compaction.test.ts:6`, `tests/e2e/hardening-e2e.test.ts:30`. (The `tests/utils/agents-module-boundary.test.ts:13` site is removed in WI-2; `tests/utils/runtime-adapter-wiring.test.ts` and `tests/utils/runtime-continuous-improvement.test.ts` were removed during the XState runtime switchover cleanup.)
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
- `createLlmProviderGateway` — delete from `src/agents/llm-provider-gateway.ts`. Keep the `LlmProviderGateway` class.
- `RuntimeStateSnapshotPort` — delete from `src/contracts/agent-execution.ts` AND remove the explicit re-export line `src/contracts/index.ts:242`.
- `runtimeStatusForApi`, `markDescendantChanged`, `normalizeRuntimeStatus` — delete all three from `src/agents/analyst-stage6.ts`; then prune now-unused imports in that file.
- `ANALYST_TOOL_REGISTRY` — delete the alias at `src/agents/analyst-prompt.ts`.
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

`src/runtime/process-runner.ts` (largest file) exposes free-function + class-method twins.

Reassessed during execution (the findings list was too aggressive): most of the "dead wrapper" free functions (`saveRegistry`, `startProcess`, `cleanupProcessOutput`, `cleanupAllCompleted`, `snapshotProcessRuntimeScope`) have **0 production callers but many test callers** (9, 22, 4, 4, 9 respectively) — they are the process-runner public test API, not dead code, and AGENTS.md does not call actively-used test scaffolding dead. Only two chains had **zero refs anywhere** and were removed:

- `registerProcessTerminalSink` (free fn + class method + `registerProcessTerminalSinkForService`, whose only caller was the class method) — fully dead chain, deleted.
- `stopAllRunningForRuntimeShutdown` free fn + class method — dead wrappers, deleted; the `stopAllRunningForRuntimeShutdownForService` core stays (still called by `disposeProcessRuntimeScopeForService`).

Status: DONE (WI-10), scoped to the two genuinely-dead chains. The remaining twins are test-API; converting them would be churn, not dead-code removal — leave them unless the process-runner test surface is refactored separately.

Gates: `npm run typecheck`, `npm test`, `npm run validate:routine`.
Risk: MEDIUM (large file; verified each name's callers individually).

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

## WI-12 — Demote `*PhaseRunner` classes to functions (OPTIONAL / LOW VALUE — default: skip)

Reassessed after review: this is the weakest item in the plan and is **not recommended on its own**. `ReviewerPhaseRunner`, `ExecutorPhaseRunner`, `PlannerPhaseRunner` are stateless single-`run()` classes `new`'d-and-discarded at one call site, so `new XPhaseRunner(deps).run(input)` → `runXPhase(deps, input)` is a lateral move: it shifts dependencies from a constructor to a function argument without removing real complexity or any dead path. It does not delete code; it rewrites working, tested code and churns three test files for a stylistic preference.

Decision: **skip unless** you are already editing these files for another reason (e.g. they touch a renamed symbol), in which case the conversion is a cheap drive-by. Do not schedule it as standalone work. This keeps the plan aligned with "simple/clean" without manufacturing churn ("brave refactoring" is for real complexity, not cosmetic class-vs-function preference).

If done opportunistically: convert each to `async function runXPhase(deps, input)` preserving the body verbatim; update call sites `src/runtime/phases/planner-iteration-runner.ts:46`, `src/runtime/executor-activation-dispatcher.ts:77`, `src/runtime/runtime-reviewer-dispatcher.ts:70`; update tests `tests/runtime/executor-phase-runner.test.ts:25`, `tests/runtime/planner-phase-runner.test.ts:12`, `tests/runtime/reviewer-phase-runner.test.ts:17` (change construction only, keep assertions).

Gates (if done): the three focused phase-runner tests; then `npm run typecheck`, `npm test`, `npm run validate:routine`.
Risk: LOW. Value: LOW.

---

## WI-13 — Smaller pass-through cleanups (batchable)

These are independent one-liners; can be one commit.

- DONE: `src/agents/agent-adapter.ts` `redactModelIssueText` and `redactProviderErrorMessage` had byte-identical bodies. Merged into a single private `redactModelIssue`; the two consumer config keys (`AgentInvocationRunner` ctor and `compensateActivationBarrierThrow`) both feed it.
- DEFERRED (reassessed): `redactTextForOutbound`/`redactSnippetForOutbound` in `src/redaction/index.ts` accept `options` then `void options`. The param is genuinely dead (even the concrete `redactText`/`snippet` impls ignore it, and `RedactionOptions.source` is never read), BUT it is threaded through the `RedactionPort` interface and ~25 call sites pass `{ source: ... }`. Removing it cleanly means editing the interface + ~25 call sites — that is lateral churn disproportionate to the LOW value, the same concern that demoted WI-12. Skip unless the redaction subsystem is being refactored for another reason; if removed, do the interface signatures and all call sites in one focused commit.
- DEFERRED (reassessed): the `controls` object (`src/runtime/runtime.ts`) is NOT a 1:1 pass-through — `src/runtime/core-composition.ts` consumes `controls.X()` in TWO places to build separate API objects. Collapsing it touches the core runtime public-API assembly for LOW value; skip unless that wiring is being changed anyway.

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

The same in-memory `CardRecord` is parsed 3× per mutation: `src/cards/card-patch-service.ts:53` (entry) → `src/cards/apply-mutation.ts:169` (create) / `:209` (persist) → `src/cards/apply-mutation.ts:106` (`stageByIdTmp`, last line before disk).

Correction (supersedes the original "keep the disk parse" wording): validate at the **entry boundary** and let the downstream typed code trust the `CardRecord` type. This is the fail-fast direction per AGENTS.md: catch bad input before any mutation/business logic runs, not after the object has already flowed through cycle detection, version-seq invariants, and history building. Keeping the disk-boundary parse as the only gate would be the opposite — validating last, after everything has already operated on unvalidated data.

- Keep the entry-layer parse at each entry point: `src/cards/card-patch-service.ts:53` (it throws a clear `Card validation failed: …`) and `src/cards/lifecycle-commands.ts:105`. These run before the mutation and are the meaningful fail-fast gate.
- Drop the two inner parses that re-validate an already-validated, owned, in-process object under the lock: `cardRecordSchema.parse(op.card)` (`src/cards/apply-mutation.ts:169`) and `cardRecordSchema.parse(op.next)` (`:209`). Note `applyMutationLocked` also performs version-seq invariant checks around these parses — keep those checks; only the `cardRecordSchema.parse(...)` wrapping goes.
- Judgment call on the disk-boundary parse (`stageByIdTmp`, `src/cards/apply-mutation.ts:106`): this is the last guard before `writeFileSync`, so dropping it means a programming error that builds a malformed in-memory card would be written to disk and only caught on next read. Two defensible options:
  1. Drop it too (full trust-the-type): cleanest, consistent with "no over-defensive code", because the entry parse already validated the object and nothing untyped mutates it afterward.
  2. Keep only this one as a cheap last-write integrity check and instead drop the entry parse.
  Recommended: option 1 (drop all but the entry parse) for consistency with the fail-fast-at-boundary principle, UNLESS the team wants disk-write hardening, in which case option 2. Do not keep both the entry parse and the disk parse — that is the redundancy being removed. Pick one and record the choice in the commit.

Status: DONE (WI-16), with a deliberately conservative variant. The two clearly-redundant middle re-parses in `applyMutationLocked` (`op.card` create / `op.next` persist) were removed — they re-validated an object the entry layer had just validated and which only flows through typed, owned, lock-held code. The entry parse (the fail-fast gate) and the `stageByIdTmp` parse (the last-write integrity guard before `writeFileSync`) were both kept, because they guard different failure modes (bad external input vs an in-process programming bug corrupting a card before disk) rather than being pure duplicates. This removes the genuine redundancy (2 of 3 parses on the hot path collapse to the entry gate) without giving up disk-corruption detection. If later you want the stricter option 1, drop the `stageByIdTmp` parse too.
- Keep `src/cards/position-repair.ts:20` (parses JSON read from disk — a real untrusted boundary) and `src/cards/evidence-ref-service.ts:97` (verify it is a separate entry, not this hot path, before touching).
- This is a behavior-adjacent change (validation timing). Keep/add a test that malformed input is rejected with a clear error at the entry gate.

Gates: focused card tests (`tests/cards/**`), then `npm run typecheck`, `npm test`, `npm run validate:routine`.
Risk: MEDIUM (validation path; one authoritative entry gate, prove rejection still works).

---

## WI-17 — Config legacy-key migration shim (DECISION REQUIRED)

The findings doc flagged this (Tier 5) but it had no work item; adding it for completeness. `src/agents/config-schema.ts` carries a camelCase→snake_case config migration: `LEGACY_RUNTIME_KEYS` (`:7`), `migrateLegacyRuntimeSection` (`:28`), `normalizeLegacyRootConfig` (`:52`), wired live in `loadConfig` (`:376,382,386`) and `src/config/environment.ts:170`. AGENTS.md says "no backward compatibility, no migration code", so this is a policy-violating shim.

Unlike the dead-code items, this is REACHABLE code: removing it changes which config files are accepted (legacy camelCase configs would start failing). That is a behavior change, hence a decision.

### Decision
- **A: remove the shim, require snake_case.** Delete `LEGACY_RUNTIME_KEYS`/`migrateLegacyRuntimeSection`/`normalizeLegacyRootConfig` and their call sites; the Zod schema then rejects legacy keys (fail fast). Migrate any in-repo/deployment config files that still use camelCase first (grep `.saivage/saivage.json` and deployment configs). Add a clear error pointing at the renamed keys.
- **B: keep the shim.** Only if real deployments still ship camelCase config and can't be migrated in this cycle. If so, this is an accepted, documented exception to the no-migration rule — note it and stop.

Recommended: A, but only after confirming no active deployment config relies on the legacy keys (check the LXC-backed projects' `.saivage/saivage.json`). This is the one item where the "no migration code" rule must be weighed against not breaking running deployments — do not remove it blind.

Gates: `npm run typecheck`, `npm test`, `npm run validate:routine`, and a config-load test proving snake_case works and legacy keys fail with a clear message.
Risk: MEDIUM (config-acceptance behavior change). Decision-gated.

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
- [ ] WI-12 PhaseRunner classes → functions (OPTIONAL — default skip)
- [ ] WI-13 small pass-through cleanups
- [ ] WI-14 agentExecutionFactory dead seam
- [ ] WI-15 RuntimeState interface + `?? []` sweep
- [ ] WI-16 triple card parse collapse (validate at entry, not disk)
- [ ] WI-17 config legacy-key migration shim (decision: A/B)
- [ ] smaller defensive cleanups (opportunistic)

## Review responses (verified against code)

An external review challenged several items. Each was checked against the real code before accepting or rejecting. Summary so the record isn't re-litigated:

- **"The shipped duplicate-block guard is over-defensive symptom-masking; replace with a loop-level early-exit."** REJECTED with evidence. The five block paths converge on `transitionCard('block')` inside the two terminal-commit helpers — that is the single chokepoint, not any runtime loop. The second block originates in the LLM tool-execution layer via the synchronous activation barrier (`src/agents/invocation-runner.ts:309`), so a `runPlannerLoop` early-exit is not even on the throwing path. Covering it at the loop layer would need ≥3 scattered early-exits (`planner-iteration-runner`, `reviewer-invocation-failure`, `planner-invocation-failure`) vs 2 lines at the convergence point. The guard is also consistent with three pre-existing idempotent-terminal-commit precedents (`commitReviewerPass:19`, `terminateIfNonTerminal:193`, `alignBlockedPlanningCardStatuses:29`), the first of which has been by-design since the terminal-commit layer was created. Fail-fast is preserved (scoped to `status==='blocked'`; `done->block` still throws). Keep the shipped fix.
- **"Fix reentrancy with a floating Promise (`Promise.resolve().then(dispatchChild)`) + a `{parked:true}` signal instead of the queue design."** REJECTED with evidence. This is not simpler: it reintroduces the hardest part of the queue design (protocol-valid parking of the parent turn + a resume path), because the current loop ends a turn by `await`-ing dispatch then `continue` (`src/agents/invocation-runner.ts:309,314`); replacing the await with a floating Promise + `continue` would issue the next provider call with the `activate_card` tool call still unresolved. It also makes the load-bearing "parent run still open when child completes" invariant (`reduceActivationCompletion` / `findParentPlannerRunForResumption`) depend on microtask scheduling rather than a call-stack guarantee. Reentrancy decoupling remains a real rearchitecture, not warranted by the incident (which the guard already fixes).
- **WI-16 validation direction.** ACCEPTED. The original "keep the disk parse, drop the entry parse" was backwards; fail-fast wants validation at the entry boundary with the typed object trusted downstream. WI-16 rewritten accordingly (with an honest note about the disk-write integrity tradeoff).
- **WI-12 (PhaseRunner classes → functions) is low-value churn.** ACCEPTED. Demoted to OPTIONAL/skip-by-default; it's a lateral class→function move that deletes no dead code.
- **WI-14 (agentExecutionFactory) may break a test seam.** ALREADY HANDLED. The live test seam is `fakeAgentConfig` + injected `agentRuntime` (via `createRuntimeCoreTestContainer`), NOT the `agentExecutionFactory` config field, which is never assigned anywhere. WI-14 already keeps `createDefaultAgentExecution`/`FakeAgentAdapter` and removes only the dead field. No change needed.
- **Other items (WI-1 freeze removal, WI-15 RuntimeState interface, WI-2..WI-11 dead code).** The review endorsed these; they stand.
