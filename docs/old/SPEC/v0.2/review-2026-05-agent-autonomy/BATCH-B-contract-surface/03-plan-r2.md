# Batch B - Contract Surface Implementation Plan

## 1. Overview

Replace the role-keyed contract taxonomy (F05), the adapter-synthesised deferred envelope (F06), and the hand-written prompt restatement of the wire shape (F07) with a single per-invocation `Contract<Envelope, TypedResult>` value constructed by planner / executor / reviewer factories and threaded positionally through `invokeAgent`. The planner contract carries two terminals (`emit_planner_result`, `emit_planner_deferred`); executor and reviewer each carry one. System prompt, tool exposure, verifier consumption, recorder, and supervisor projection all read from the contract. See [02-design-r1.md sections 2.1-2.9](02-design-r1.md#21-the-contract-interface). One `Contract<Envelope, TypedResult>` type exists in the codebase; Batch B owns it, the verifier batch consumes it.

## 2. Ordering

Two landing phases per the workspace coordination document:

- **Skeleton phase (steps 1-4)** lands first: new files at `src/contracts/contract.ts` plus the three role factories, no deletions. The verifier batch then ships, importing these types. Skeleton factories' `verify()` return a batch-local `ContractVerifyResult<Envelope>` whose fail arm carries a structured `{ code, message, locator }` violation - never an `LlmRequestError` - so neither phase reintroduces a transport-shaped contract error and the skeleton survives the verifier batch's removal of `LlmRequestError`'s `contract_mismatch` arm without change. See [02-design-r1.md section 2.1](02-design-r1.md#21-the-contract-interface).
- **Continuation phase (steps 5-13)** lands after the verifier batch: rewrites adapter loop, prompts, recorder, tool catalogue, policy, persistence, and tests against the contract; deletes the role-keyed surfaces and the synthesis branch. Every continuation step assumes the verifier batch has already removed the `LlmRolePhase` consumers and the `contract_mismatch` subtype it owns. See [02-design-r1.md section 2.3](02-design-r1.md#23-migration-of-the-role-taxonomy).

## 3. Steps (every step lands compile-green and test-green atomically)

### Skeleton phase

1. **Add `src/contracts/contract.ts`** with `Contract`, `ContractTerminalDescriptor`, `ContractToolDefinition`, `ContractVerifyOk<Envelope>`, `ContractVerifyFail`, `ContractVerifyResult<Envelope>`, and a local `ContractViolation = { code: 'terminal_tool_unexpected' | 'terminal_tool_invalid_envelope'; message: string; locator: string }`. Fail arm carries `ContractViolation`, not `LlmRequestError`. Add `src/contracts/verify-against-terminals.ts` with `verifyAgainstTerminals<Envelope>(call, terminals, contractName)` returning the new violation shape. Add `src/contracts/json-schema-to-prose.ts` and `describe-terminals.ts` per [02-design-r1.md section 2.5](02-design-r1.md#25-system-prompt-rendered-from-the-contract). Pure additions; no existing module imports them yet.

2. **Add `src/contracts/{planner,executor,reviewer}-envelope.ts`** exporting the per-role envelope zod schemas. Same atomic step: rewrite `src/agents/role-envelope-schemas.ts` to re-export the moved schemas so every existing consumer (`agent-adapter.ts`, `terminal-protocol.ts`, recorder tests) keeps compiling and passing. See [02-design-r1.md section 2.3](02-design-r1.md#23-migration-of-the-role-taxonomy).

3. **Add `src/contracts/{planner,executor,reviewer}-contract.ts`**. Planner factory returns the two-terminal contract per [02-design-r1.md section 2.6.1](02-design-r1.md#261-planner-contract-shape-under-position-c) and `PlannerEnvelope` / `PlannerTypedResult` from [section 2.2](02-design-r1.md#22-per-invocation-contract-construction); executor and reviewer factories carry one terminal each. Projection bodies are copied (not moved) from `agent-adapter.ts#L49-L75`; the originals stay live until step 5. Re-export factories and contract types from `src/contracts/index.ts`. No call-site change yet.

4. **Add focused tests for the skeleton** under `tests/contracts/`: `contract-types.test.ts`, `verify-against-terminals.test.ts` (both violation codes; all three contracts; unknown-name rejection), `{planner,executor,reviewer}-contract.test.ts`, `describe-terminals.test.ts`, `json-schema-to-prose.test.ts`. They exercise the new surfaces without touching the adapter or any role-keyed symbol; must pass against the live runtime before the skeleton merges.

### Continuation phase

5. **Rewrite `agent-adapter.ts` per-turn loop and delete its projection helpers in one atomic step.** Add `contract: Contract<Envelope, TypedResult>` to `InvokeAgentRequest`; build `turnTools = [...actionTools, ...contract.terminals.map((t) => t.toolDefinition)]`; classify terminal calls via `contract.isTerminalToolName(call.function.name)`; surface `contract.verify(call)` to the verifier batch's `ContractVerifier` (which lifts a contract-fail into an `ObligationReport` and drives repair); use `contract.project(envelope, terminalName)` for the typed result. Same step: delete the inline `expectsEnvelope` / `envelopeRole` / `terminalToolName` / `terminalToolDef` block at `agent-adapter.ts#L292-L295`, delete the three projection helpers at `L49-L75`, and update the three supervisor entry points (`runtime.ts#L453-L470`, `#L677-L697`, `#L822-L842`) to construct contracts via the factories. See [02-design-r1.md sections 2.2-2.3](02-design-r1.md#22-per-invocation-contract-construction).

6. **Delete the deferred-activation synthesis branch and tighten the legacy parser fallback in one atomic step.** Remove the synthesis block at `agent-adapter.ts#L358-L380` including the inline `CardStore` construction, the dependency walk, and the `system / model_issue` synthesis rows. Same step: rewrite `parseDeferredActivationEnvelope` in `src/schemas/validators.ts#L68-L70` to accept only the strict `DeferredActivationEnvelopeV1` schema (no `'legacy'` identity fabrication); update every caller and the persistence scanners at `session-persistence.ts#L404/L445` so the tree compiles green. The planner LLM now calls `emit_planner_deferred` directly, echoing the `deferred_activate_card` payload returned by `activate_card`. See [02-design-r1.md section 2.6.3](02-design-r1.md#263-mechanics).

7. **Rewrite the three prompt builders AND preserve non-schema narrative role constraints in one atomic step.** Rewrite `buildPlannerPrompt`, `buildExecutorPrompt`, `buildReviewerPrompt` in `src/agents/system-prompt.ts` to accept `contract` and emit `contract.describe()` in place of the hand-written "Expected JSON Output Format" sections at `L64-L102`, `L129-L160`, `L233-L253`. Delete `buildSelfCheckPrompt` and the `self_check` example block at `L253-L272`. Update every caller. Before deleting each hand-written JSON example, diff it against `contract.describe()` output and move every behavioural constraint NOT captured by the zod schema into an explicit `### Constraints` prose block above the contract-rendered terminal section, keyed by role. Concrete carry-overs (non-exhaustive): executor file-scope rule "never a project source / config / test file or directory" at `L143`, planner "do not invent new skills" rule at `L80`, reviewer "cite the evidence row id" rule at `L240`. Same commit: add `tests/agents/system-prompt.preserved-constraints.test.ts` asserting per role both (a) the rendered prompt contains `contract.describe()` output and (b) every preserved constraint string appears verbatim; fails closed if a future schema-render change drops them. See [02-design-r1.md section 2.5](02-design-r1.md#25-system-prompt-rendered-from-the-contract).

8. **Rewrite `LlmRecorderRequest`, `exchangeAttemptSchema`, and every fixture in one atomic step.** Add `terminalToolNames: readonly string[]` to `LlmRecorderRequest` at `src/agents/llm-recording.ts#L51` (from `contract.terminals.map((t) => t.name)`); add `LlmRecorderCompletion.terminalToolFired: string | null` and `contractName: string`; delete `asTerminalToolName` at `L59-L65` and `deriveTerminalToolFromOptions`. Rewrite `exchangeAttemptSchema` in `src/contracts/llm-exchange.ts#L24-L36`: drop `terminalTool: z.enum(TERMINAL_TOOL_NAMES)`; add `terminalToolOffered: z.array(z.string()).readonly()`, `terminalToolFired: z.string().nullable()`, and `llmExchangeSchema.contractName: z.string()`. Drop `TERMINAL_TOOL_NAMES`, `TerminalToolName`, and the re-export at `src/contracts/index.ts#L100`. Update every recorder caller, every fixture under `tests/fixtures/llm-exchange/*`, and every consumer of the removed enum (dashboard query layer included). See [02-design-r1.md section 2.7](02-design-r1.md#27-recorder-integration).

9. **Remove the role splice from `agent-tool-catalog.ts`** at `L105`, `L120`, `L130` so `ROLE_TOOL_NAMES` lists action tools only; terminal tools come from `contract.terminals` at adapter call time. Drop imports of `ROLE_RESULT_TOOL_NAMES` and the `EMIT_*_RESULT` constants in the same step. See [02-design-r1.md section 2.3](02-design-r1.md#23-migration-of-the-role-taxonomy).

10. **Add the `'contract-terminal'` surface to `RoleToolPolicy`** per [02-design-r1.md section 2.8](02-design-r1.md#28-role-tool-policyts-after-the-redesign): extend `RoleToolPolicySurface` with `'contract-terminal'`; add `contractTerminals?: readonly string[]` to `RoleToolPolicyInput`; add a single branch that allows iff `surface === 'contract-terminal' && contractTerminals?.includes(toolName)` and denies otherwise (including missing or empty `contractTerminals`); every other surface branch is unchanged. Same step: route the adapter's terminal-tool dispatch through `RoleToolPolicy.decide` with `surface: 'contract-terminal'` and `contractTerminals: contract.terminals.map((t) => t.name)`. Same commit: add `tests/agents/role-tool-policy.contract-terminal.test.ts` covering (a) allow when name is in `contractTerminals`; (b) deny when name is not in `contractTerminals`; (c) deny when `contractTerminals` is undefined or empty; (d) deny when the same terminal name is requested at any other surface (`'planner-control'`, `'agent-runtime'`, `'workspace'`, `'external-mcp'`, `'skill'`); (e) snapshot of every existing surface decision against the current `ROLE_TOOL_NAMES` fixture, asserting behaviour is unchanged for non-terminal tools.

11. **Delete legacy files and their test counterparts in one atomic commit.** Files `src/agents/role-envelope-schemas.ts` (the re-export shim added in step 2 plus `EnvelopeBearingRole`, `ENVELOPE_SCHEMAS`), `role-result-tools.ts` (`ROLE_RESULT_TOOL_NAMES`, `ROLE_RESULT_TOOLS`, `EMIT_PLANNER_RESULT`, `EMIT_EXECUTOR_RESULT`, `EMIT_REVIEWER_RESULT`, `buildToolDef`), `terminal-protocol.ts` (`validateTerminalToolCall`). No shims, no re-exports. Same step: delete every test importing a removed symbol (`ROLE_RESULT_TOOL_NAMES`, `EnvelopeBearingRole`, `validateTerminalToolCall`, `TERMINAL_TOOL_NAMES`, `envelopeTo{Planner,Executor,Reviewer}Result`, `isEnvelopeBearing`, `'terminal'` phase of `buildLlmOptions`, `self_check`, legacy `'legacy'` fabrication); new tests in steps 4, 7, 10, 13 cover their intent.

12. **Rewrite `tests/agents/agent-adapter.*.test.ts`, `tests/agents/llm-recording.test.ts`, and `tests/agents/system-prompt.test.ts` against the contract** in one commit. Adapter tests construct contracts via the factories and assert `contract.verify` is the only verification seam. Recorder tests assert the new `terminalToolNames` / `terminalToolFired` / `contractName` fields. System-prompt tests assert prompts render `contract.describe()` and no longer contain the hand-written "Expected JSON Output Format" prose.

13. **Add the continuation-phase exit-gate end-to-end test.** `tests/agents/agent-adapter.planner-deferred.test.ts` drives a planner invocation through `activate_card` plus `emit_planner_deferred`, asserts the supervisor receives `PlannerTypedResult.kind === 'deferred'`, and asserts the persisted message log shows a real `assistant / tool_call` row for `emit_planner_deferred` (not a synthesised `assistant / text` row).

## 4. New files

- `src/contracts/contract.ts`, `verify-against-terminals.ts`, `json-schema-to-prose.ts`, `describe-terminals.ts`, `{planner,executor,reviewer}-envelope.ts`, `{planner,executor,reviewer}-contract.ts`
- `tests/contracts/*` per step 4
- `tests/agents/system-prompt.preserved-constraints.test.ts` (step 7)
- `tests/agents/role-tool-policy.contract-terminal.test.ts` (step 10)
- `tests/agents/agent-adapter.planner-deferred.test.ts` (step 13)

## 5. Deleted files / symbols

- Files `src/agents/role-envelope-schemas.ts`, `role-result-tools.ts`, `terminal-protocol.ts` (whole files).
- `TERMINAL_TOOL_NAMES`, `TerminalToolName` from `src/contracts/llm-exchange.ts` and re-export at `src/contracts/index.ts#L100`.
- `asTerminalToolName`, `deriveTerminalToolFromOptions` at `src/agents/llm-recording.ts#L59-L66`.
- `envelopeTo{Planner,Executor,Reviewer}Result` at `src/agents/agent-adapter.ts#L49-L75`.
- Deferred-activation synthesis block at `agent-adapter.ts#L358-L380`; inline `expectsEnvelope` block at `L292-L295`.
- `buildSelfCheckPrompt` and `self_check` example block at `system-prompt.ts#L253-L272`.
- Legacy-identity fabrication branch in `parseDeferredActivationEnvelope` at `src/schemas/validators.ts#L68-L70`.

## 6. Tests (delete / rewrite / new)

- **Delete**: enumerated in step 11.
- **Rewrite**: enumerated in step 12.
- **New**: per steps 4, 7, 10, and 13.

## 7. Validation commands

Per [00-COORDINATION.md](../00-COORDINATION.md) and the workspace skill [saivage-development-validation](../../../../../.github/skills/saivage-development-validation/SKILL.md). Run from `/home/salva/g/ml/saivage-v3`:

```bash
npm run typecheck
npm test -- --runInBand \
  tests/contracts \
  tests/agents/agent-adapter.test.ts \
  tests/agents/agent-adapter.planner-deferred.test.ts \
  tests/agents/system-prompt.test.ts \
  tests/agents/system-prompt.preserved-constraints.test.ts \
  tests/agents/llm-recording.test.ts \
  tests/agents/role-tool-policy.contract-terminal.test.ts
npm run build
grep -rn "ENVELOPE_SCHEMAS\|ROLE_RESULT_TOOL_NAMES\|validateTerminalToolCall\|TERMINAL_TOOL_NAMES\|EnvelopeBearingRole\|isEnvelopeBearing\|envelopeToPlannerResult\|envelopeToExecutorResult\|envelopeToReviewerResult\|LlmRolePhase\|buildSelfCheckPrompt" src/ tests/ web/
grep -rn "Expected JSON Output Format" src/agents/system-prompt.ts
# Both greps expect zero hits.
```

Skeleton phase exits when `npm run typecheck`, the Jest run scoped to `tests/contracts`, and `npm run build` are green against the unchanged adapter. Continuation phase exits when the full Jest run above plus `npm run build` are green and both greps return no hits.

Live deploy and smoke after the continuation phase (`saivage-v3-getrich-v2` container at `10.0.3.170:8080`, service `saivage-v3-getrich.service`):

```bash
rsync -a --delete dist/ root@10.0.3.170:/opt/saivage-v3/dist/
ssh root@10.0.3.170 'systemctl restart saivage-v3-getrich.service'
sleep 4
curl -fsS http://10.0.3.170:8080/health
curl -fsS http://10.0.3.170:8080/api/providers | jq
```

Then drive one planner invocation against a small goal and assert that `http://10.0.3.170:8080/api/sessions/<id>/messages` shows a real `assistant / tool_call` row for `emit_planner_deferred`, and that recorded exchanges carry `terminalToolFired` and `contractName`.

## 8. Rollback

Single-batch revert per phase: `git revert <skeleton-merge-sha>` or `git revert <continuation-merge-sha>` returns the tree to the prior compile-green and test-green state. Per the workspace architecture-first rule ([00-COORDINATION.md](../00-COORDINATION.md)) there is no partial rollback inside a phase and no migration shims: the per-role taxonomy, synthesis branch, prompt restatement, and recorder shape come back together when the continuation phase is reverted. No on-disk state migration is required. Persisted sessions written under the continuation phase carry real `emit_planner_deferred` tool-call rows whose content schema is the unchanged `deferred_activation_envelope_v1`; a revert leaves those rows in place but ignored by the restored synthesis branch. Recorded exchanges written under the new `exchangeAttemptSchema` (with `terminalToolOffered` / `terminalToolFired` / `contractName`) are not consumed by any runtime path after a revert; they remain on disk as dead diagnostic rows and may be purged manually.
