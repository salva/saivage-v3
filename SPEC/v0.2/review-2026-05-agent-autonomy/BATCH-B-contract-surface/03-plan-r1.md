# Batch B - Contract Surface Implementation Plan (P-B1)

## 1. Overview

Replace the role-keyed contract taxonomy (F05), the adapter-synthesised
deferred envelope (F06), and the hand-written prompt restatement of the
wire shape (F07) with a single per-invocation `Contract<Envelope,
TypedResult>` value constructed by the planner / executor / reviewer
drivers and threaded positionally through `invokeAgent`. The planner
contract carries two terminals (`emit_planner_result`,
`emit_planner_deferred`); executor and reviewer each carry one. System
prompt, tool exposure, verifier, recorder, and supervisor projection all
read from the contract. See design [02-design-r1.md §2.1-§2.9](02-design-r1.md#21-the-contract-interface).

## 2. Ordering relative to Batch A and Batch C

Batch B consumes Batch A's verifier-and-repair loop (`ContractVerifier`,
`InvocationOutcome`, repair budget, `signal_done` mechanics, exhaustive
`LlmTransportFailure` split) - so all Batch B steps land **after Batch A
§2.1-§2.3 of [BATCH-A/02-design-r3.md](../BATCH-A-contract-verifier-core/02-design-r3.md)**.
Concretely: Batch A ships `Contract.verify` as the only verification
seam and removes `contract_mismatch` from the transport failure union;
Batch B then bundles the per-role terminal sets, projections, and
prompt descriptors behind that seam, and replaces Batch A's
role-agnostic `buildDoneSignalTool(role)` call with
`contract.terminals[*].toolDefinition` (the planner contract carries
two; executor/reviewer one). Batch C consumes Batch B's
`Contract` shape end-to-end ([BATCH-C/02-design-r3.md §A1, §A5,
§A7](../BATCH-C-scaffolding-cleanup/02-design-r3.md)) and must land
after Batch B.

## 3. Steps (tree compiles after each)

1. **Add `src/contracts/contract.ts`** with the `Contract`,
   `ContractTerminalDescriptor`, `ContractToolDefinition`,
   `ContractVerifyResult` interfaces from [§2.1](02-design-r1.md#21-the-contract-interface).
   No consumers yet. Pure type addition.
2. **Add `src/contracts/verify-against-terminals.ts`** implementing the
   shared `verifyAgainstTerminals` helper from [§2.1](02-design-r1.md#21-the-contract-interface).
   Imports `LlmRequestError` from Batch A's rewritten
   `src/agents/llm-failure.ts`. Internal to `src/contracts/`.
3. **Add `src/contracts/json-schema-to-prose.ts`** (recursive walk over
   the mini-JSON-Schema shape produced by `zodToJsonSchemaMini`) and
   `src/contracts/describe-terminals.ts` per [§2.5](02-design-r1.md#25-system-prompt-rendered-from-the-contract).
   Unit-test in isolation; not yet wired into prompts.
4. **Add `src/contracts/planner-envelope.ts`, `executor-envelope.ts`,
   `reviewer-envelope.ts`** exporting the per-role envelope zod schemas
   currently inlined in `src/agents/role-envelope-schemas.ts` (move,
   do not copy - the schemas become contract-local). The old file is
   not deleted yet (step 11) so the tree still compiles.
5. **Add `src/contracts/planner-contract.ts`** with
   `createPlannerContract(input)` returning the two-terminal contract
   per [§2.6.1](02-design-r1.md#261-planner-contract-shape-under-position-c).
   Includes the deferred terminal `emit_planner_deferred` consuming
   `DeferredActivationEnvelopeV1` and the `PlannerTypedResult`
   discriminated union from [§2.2](02-design-r1.md#22-per-invocation-contract-construction).
6. **Add `src/contracts/executor-contract.ts` and
   `src/contracts/reviewer-contract.ts`** with the single-terminal
   factories per [§2.2](02-design-r1.md#22-per-invocation-contract-construction).
   Projection bodies are lifted verbatim from the deleted helpers at
   `agent-adapter.ts#L49-L75` (step 9 removes the originals).
7. **Re-export the three factories and the `Contract` types from
   `src/contracts/index.ts`.** Still no call-site changes.
8. **Add the `'contract-terminal'` surface to `RoleToolPolicy`** per
   [§2.8](02-design-r1.md#28-role-tool-policyts-after-the-redesign):
   new `contractTerminals?: readonly string[]` field on
   `RoleToolPolicyInput`, new surface branch that allows iff
   `contractTerminals.includes(toolName)`. Existing surfaces unchanged.
9. **Rewrite `agent-adapter.ts` per-turn loop** to accept
   `contract: Contract<Envelope, TypedResult>` on `InvokeAgentRequest`
   ([§2.2](02-design-r1.md#22-per-invocation-contract-construction)),
   build `turnTools = [...actionTools, ...contract.terminals.map(t => t.toolDefinition)]`,
   call `contract.isTerminalToolName(call.function.name)` to classify
   terminal calls, route verification through `contract.verify(call)`
   into Batch A's `pendingDone` slot, and call
   `contract.project(envelope, terminalName)` for the typed result.
   Delete the inline `expectsEnvelope` / `envelopeRole` /
   `terminalToolName` / `terminalToolDef` block at L292-L295 and the
   three projection helpers at L49-L75 ([§2.3](02-design-r1.md#23-migration-of-the-role-taxonomy)).
10. **Delete the deferred-activation synthesis branch** at
    `agent-adapter.ts#L358-L380` along with the inline `CardStore`
    construction, dependency walk, and `system / model_issue`
    synthesis rows ([§2.6.3](02-design-r1.md#263-mechanics)). The
    `PlannerControlExecutor` no longer needs the adapter to forge an
    envelope: the planner LLM is now expected to call
    `emit_planner_deferred` itself, echoing the
    `deferred_activate_card` payload returned by `activate_card`.
11. **Rewrite `buildLlmOptions`** to drop the `'tools' | 'terminal'`
    phase parameter and the `LlmRolePhase` union ([§2.3](02-design-r1.md#23-migration-of-the-role-taxonomy)).
    Coordinates with Batch A §2.1.8 which already collapses
    `LlmCompleteOptions`; this step removes the role-keyed phase
    leftover. Every call site already passes `'tools'` after the
    Batch A landing, so this is a signature shrink only.
12. **Rewrite `buildPlannerPrompt`, `buildExecutorPrompt`,
    `buildReviewerPrompt`** in `src/agents/system-prompt.ts` to accept
    `contract: Contract<unknown, unknown>` and emit
    `contract.describe()` in place of the hand-written
    "Expected JSON Output Format" sections at L64-L102, L129-L160,
    L233-L253 ([§2.5](02-design-r1.md#25-system-prompt-rendered-from-the-contract)).
    Delete `buildSelfCheckPrompt` and the `self_check` JSON example
    block at L253-L272 (same section). The planner prompt gains one
    paragraph on `emit_planner_deferred` per [§2.6.3](02-design-r1.md#263-mechanics);
    this paragraph is rendered automatically because the deferred
    terminal is now part of `contract.describe()`.
13. **Update the three supervisor entry points** (`invokePlanner`,
    `invokeExecutor`, `invokeReviewer`) at
    `runtime.ts#L453-L470`, `#L677-L697`, `#L822-L842` to construct
    the contract via the factories and pass it to `invokeAgent` per
    [§2.2](02-design-r1.md#22-per-invocation-contract-construction).
    The planner driver reads `PlannerTypedResult.kind` to decide
    `'deferred'` vs `'result'`, per [§2.9](02-design-r1.md#29-impact-on-contractsagent-executionts);
    `applyPlannerResult` itself does not change.
14. **Rewrite `LlmRecorderRequest`** ([§2.7](02-design-r1.md#27-recorder-integration))
    to carry `terminalToolNames: readonly string[]` (from
    `contract.terminals.map(t => t.name)`) and add
    `LlmRecorderCompletion.terminalToolFired: string | null`. Delete
    the `asTerminalToolName` narrowing at `llm-recording.ts#L59-L65`
    and the `deriveTerminalToolFromOptions` helper. Add a new
    `contractName: string` field threaded through the recorder
    request.
15. **Rewrite `exchangeAttemptSchema`** in
    `src/contracts/llm-exchange.ts`: drop `TERMINAL_TOOL_NAMES` and
    the closed `terminalTool: z.enum(...)` field at L32-L35; add
    `terminalToolOffered: z.array(z.string()).readonly()` and
    `terminalToolFired: z.string().nullable()`; add
    `llmExchangeSchema.contractName: z.string()` ([§2.7](02-design-r1.md#27-recorder-integration)).
    Drop the `TERMINAL_TOOL_NAMES` re-export at
    `src/contracts/index.ts#L100`.
16. **Remove the role splice from `agent-tool-catalog.ts`** at L105,
    L120, L130: `ROLE_TOOL_NAMES` lists action tools only; terminal
    tools come from `contract.terminals` at adapter call time ([§2.3](02-design-r1.md#23-migration-of-the-role-taxonomy)).
    Drop the imports of `ROLE_RESULT_TOOL_NAMES` and the
    `EMIT_*_RESULT` constants.
17. **Delete legacy parser fallback** in
    `src/schemas/validators.ts#L68-L70`: the
    `parseDeferredActivationEnvelope` legacy branch that fabricates
    `parent_card_id = 'legacy'` etc. becomes a one-liner that only
    accepts the strict `DeferredActivationEnvelopeV1` schema ([§2.6.3](02-design-r1.md#263-mechanics)).
18. **Delete the now-unused symbols**: `src/agents/role-envelope-schemas.ts`
    (whole file - `EnvelopeBearingRole`, `ENVELOPE_SCHEMAS`),
    `src/agents/role-result-tools.ts` (whole file -
    `ROLE_RESULT_TOOL_NAMES`, `ROLE_RESULT_TOOLS`,
    `EMIT_PLANNER_RESULT`, `EMIT_EXECUTOR_RESULT`,
    `EMIT_REVIEWER_RESULT`, `buildToolDef`),
    `src/agents/terminal-protocol.ts` (whole file -
    `validateTerminalToolCall`; superseded by
    `verifyAgainstTerminals` from step 2). All per [§2.3](02-design-r1.md#23-migration-of-the-role-taxonomy)
    and the replacement map at [§2.4](02-design-r1.md#24-replacement-map).
    No shim files, no re-exports.

## 4. New files

- `src/contracts/contract.ts`
- `src/contracts/verify-against-terminals.ts`
- `src/contracts/json-schema-to-prose.ts`
- `src/contracts/describe-terminals.ts`
- `src/contracts/planner-envelope.ts`
- `src/contracts/executor-envelope.ts`
- `src/contracts/reviewer-envelope.ts`
- `src/contracts/planner-contract.ts`
- `src/contracts/executor-contract.ts`
- `src/contracts/reviewer-contract.ts`

## 5. Deleted files / symbols

- File `src/agents/role-envelope-schemas.ts` (`EnvelopeBearingRole`,
  `ENVELOPE_SCHEMAS`).
- File `src/agents/role-result-tools.ts` (`ROLE_RESULT_TOOL_NAMES`,
  `ROLE_RESULT_TOOLS`, `EMIT_PLANNER_RESULT`, `EMIT_EXECUTOR_RESULT`,
  `EMIT_REVIEWER_RESULT`, `buildToolDef`).
- File `src/agents/terminal-protocol.ts` (`validateTerminalToolCall`).
- Symbols: `TERMINAL_TOOL_NAMES`, `TerminalToolName` from
  `src/contracts/llm-exchange.ts` and its re-export in
  `src/contracts/index.ts#L100`.
- Symbols: `isEnvelopeBearing`, `LlmRolePhase`, the `'terminal'` phase
  branch in `src/agents/llm-options-factory.ts#L15-L62`.
- Symbols: `asTerminalToolName`, `deriveTerminalToolFromOptions` in
  `src/agents/llm-recording.ts#L59-L66`.
- Symbols: `envelopeTo{Planner,Executor,Reviewer}Result` at
  `src/agents/agent-adapter.ts#L49-L75`.
- Block: deferred-activation synthesis at `agent-adapter.ts#L358-L380`
  plus the inline `expectsEnvelope` block at L292-L295.
- Function: `buildSelfCheckPrompt` and its `self_check` example block
  in `src/agents/system-prompt.ts#L253-L272`.
- Legacy fallback branch in `src/schemas/validators.ts#L68-L70`
  (`parseDeferredActivationEnvelope` legacy identity-fabrication path).

## 6. Tests (delete / rewrite / new)

- **Delete**: any fixture or unit that imports
  `ROLE_RESULT_TOOL_NAMES`, `EnvelopeBearingRole`,
  `validateTerminalToolCall`, `TERMINAL_TOOL_NAMES`,
  `envelopeTo{Planner,Executor,Reviewer}Result`,
  `isEnvelopeBearing`, the `'terminal'` phase of `buildLlmOptions`, or
  the `self_check` JSON shape. No replacement.
- **Delete**: tests covering the adapter's deferred-activation
  synthesis branch and the `model_issue` synthesis row. The behaviour
  is gone (see [§2.6.3](02-design-r1.md#263-mechanics)).
- **Delete**: legacy-parser tests for
  `parseDeferredActivationEnvelope` that assert `parent_card_id =
  'legacy'`. The strict-only path supersedes them.
- **Rewrite**: `tests/agents/agent-adapter.*.test.ts` to construct
  contracts via the factories and assert that `contract.verify` is
  the only verification seam; the planner deferred-terminal flow is
  asserted via an `emit_planner_deferred` tool call instead of an
  adapter-forged envelope.
- **Rewrite**: `tests/agents/llm-recording.test.ts` to assert the new
  `terminalToolNames` / `terminalToolFired` / `contractName` fields.
- **Rewrite**: `tests/agents/system-prompt.test.ts` to assert that
  prompts render `contract.describe()` and no longer contain the
  hand-written "Expected JSON Output Format" prose.
- **New**: `tests/contracts/planner-contract.test.ts`,
  `tests/contracts/executor-contract.test.ts`,
  `tests/contracts/reviewer-contract.test.ts` exercising
  `verify` / `project` / `describe` / `isTerminalToolName` per
  [§2.1, §2.6.1](02-design-r1.md#21-the-contract-interface).
- **New**: `tests/contracts/describe-terminals.test.ts` and
  `tests/contracts/json-schema-to-prose.test.ts` for the prose
  renderer.
- **New**: `tests/contracts/verify-against-terminals.test.ts` for the
  shared helper, asserting `terminal_tool_unexpected` and
  `terminal_tool_invalid_envelope` error shapes per [§2.1](02-design-r1.md#21-the-contract-interface).
- **New**: end-to-end planner-deferred test that drives a planner
  invocation through `activate_card` + `emit_planner_deferred` and
  asserts the supervisor receives `PlannerTypedResult.kind ===
  'deferred'`.

## 7. Validation commands

Run from `/home/salva/g/ml/saivage-v3`:

```bash
npm run build
npx tsc --noEmit
npm test -- --runInBand
npm run lint
npx vitest run tests/contracts tests/agents/agent-adapter \
  tests/agents/system-prompt tests/agents/llm-recording
grep -rn "ENVELOPE_SCHEMAS\|ROLE_RESULT_TOOL_NAMES\|validateTerminalToolCall\|TERMINAL_TOOL_NAMES\|EnvelopeBearingRole\|isEnvelopeBearing\|envelopeToPlannerResult\|envelopeToExecutorResult\|envelopeToReviewerResult\|LlmRolePhase\|buildSelfCheckPrompt" src/ tests/ web/
# Expect zero hits.
grep -rn "Expected JSON Output Format" src/agents/system-prompt.ts
# Expect zero hits.
```

After the build is green, deploy to the `saivage-v3-getrich-v2`
container per the
[saivage-development-validation](../../../../.github/skills/saivage-development-validation/SKILL.md)
skill and run one planner invocation against a small goal; assert that
`http://10.0.3.170:8080/api/sessions/<id>/messages` shows a real
`assistant / tool_call` row for `emit_planner_deferred` (not the
prior synthesised `assistant / text` row).

## 8. Rollback

Single-batch revert: `git revert <batch-B-merge-sha>` returns the
tree to the post-Batch-A state. Because the design preserves zero
backward compatibility (architecture-first rule), there is no partial
rollback path - the per-role taxonomy, the synthesis branch, and the
prompt restatement come back together. No on-disk state migration is
required: persisted sessions written under Batch B carry real
`emit_planner_deferred` tool-call rows that the pre-Batch-B scanners
in `session-persistence.ts#L404/L445` treat as ordinary terminal tool
calls (their content schema is `deferred_activation_envelope_v1`,
unchanged), so a revert leaves those rows in place but ignored by the
restored synthesis branch. Recorded exchanges written under the new
`exchangeAttemptSchema` (with `terminalToolOffered` /
`terminalToolFired` / `contractName`) are not consumed by any runtime
code path after a revert; they remain on disk as dead diagnostic
rows and may be purged manually.
