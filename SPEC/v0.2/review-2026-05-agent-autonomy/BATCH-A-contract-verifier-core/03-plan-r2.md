# Batch A — Contract Verifier Core: Implementation Plan

## 1. Overview

Implements P-A2 from [02-design-r3.md §5](02-design-r3.md#5-recommendation):
the contract verifier, the explicit agent-loop state machine and driver,
the `signal_done` tool, the transport/contract failure-type split, and the
`MessageKind` split that makes the verifier the sole producer of
`model_repair`. The per-turn protocol cop, the inline plain-message nudge,
and the `contract_mismatch` failure family are removed in the same change
set as their replacements; no compatibility shims are introduced.

## 2. Cross-batch ordering

Batch A consumes the contract surface owned by Batch B and is consumed by
Batch C scaffolding work. The implementation sequence is:

1. **Batch B skeleton (B1–B3).** `src/contracts/contract.ts` and
   `src/contracts/{planner,executor,reviewer}-contract.ts` land as new
   files. They are unreferenced; the tree compiles. Batch A's verifier,
   driver, and done-signal tool import `Contract<Envelope, TypedResult>`
   and the per-role factories from these files; nothing else does yet.
2. **Batch A (this plan).** Lands end-to-end. After it lands, the
   verifier-driven loop is the only path the adapter takes, the failure
   union no longer has a `contract_mismatch` arm, `context_compaction`
   is its own `MessageKind`, and the new event payloads
   (`contract_verdict`, `repair_attempts`, `contract_id`,
   `llm_verifier_rejection`) are emitted.
3. **Batch B continuation (B4+).** Deletes `role-envelope-schemas.ts`,
   `role-result-tools.ts`, `TERMINAL_TOOL_NAMES`,
   `validateTerminalToolCall`, the deferred-activation parser fallback,
   and rewrites prompt builders, recorder, supervisor entry points, and
   deferred-activation handling against `Contract`.
4. **Batch C.** Deletes `LlmRolePhase`, `LlmCompleteOptionsTerminal`,
   the terminal-phase branches in `llm-options-factory.ts`, the gateway
   consumers, the analyst resolver caller, the probe script, the
   phase-bearing tests, and `recovery.ts`; decomposes `invokeAgent`;
   unifies budgets.

Batch A therefore does **not** delete `role-envelope-schemas.ts`,
`role-result-tools.ts`, `terminal-protocol.ts`, `LlmRolePhase`, or
`LlmCompleteOptionsTerminal`. Batch A keeps `agent-tool-catalog.ts`
intact and appends `buildDoneSignalTool(contract)` to the per-turn tools
array at the adapter level only.

## 3. Steps

Each numbered step is a single atomic change set. Within a step, every
file edit, deletion, and new module land together; the tree compiles
(`npm run typecheck`) only at step boundaries. Multi-file rewrites are
called out explicitly.

### Step 1 — Additive primitives (single-file new modules)

Introduce, as new files, the verifier surface and its supporting types.
No existing file is touched. Order within the step is irrelevant; the
modules form a DAG that does not cross any existing import.

- `src/agents/contract-verifier.ts` per [02-design-r3.md §2.1.3](02-design-r3.md#213-contract-verifier-surface).
  Consumes `Contract<Envelope, TypedResult>` from `src/contracts/contract.ts`.
- `src/agents/done-signal-tool.ts` per [§2.1.4](02-design-r3.md#214-done-signal-tool).
  `buildDoneSignalTool(contract)` derives `toolName` and `argsSchema`
  from the supplied contract.
- `src/agents/invocation-outcome.ts` per [§2.1.5 + §3.1](02-design-r3.md#31-the-contract-object)
  with the P-A2 generic `InvocationOutcomeOf<Envelope, TypedResult>`
  and `RepairBudget` scoped per `agentFn` attempt.
- `src/agents/agent-loop-state.ts` per [§3.2](02-design-r3.md#32-state-machine-for-the-agent-loop).
  Pure transitions plus `extractDoneSignal`.
- `src/agents/agent-loop-driver.ts` per [§3.3 + §3.4](02-design-r3.md#33-new-modules-to-introduce).
  Owns message persistence, event emission, budget increment, and
  `signalDoneFromRuntime`.

### Step 2 — Failure-class split (atomic, six files)

Single atomic rewrite touching six files; partial application would leave
the failure union and its consumers inconsistent.

- `src/agents/llm-failure.ts` rewritten per [§2.1.1](02-design-r3.md#211-failure-split):
  `LlmFailure` and `ContractMismatchSubtype` deleted;
  `LlmTransportFailure`, `LlmRequestError`, `unwrapFailure` exported;
  `provider_protocol_error` added.
- `src/agents/llm-errors.ts` re-exports stripped to match.
- `src/agents/llm-failure-classifiers.ts` rewritten per [§2.1.6](02-design-r3.md#216-recovery-policy-slimming):
  no producer of `contract_mismatch`; HTTP-400-with-unrecognised-body
  maps to `provider_protocol_error`.
- `src/agents/invocation-recovery-policy.ts` rewritten per [§2.1.6](02-design-r3.md#216-recovery-policy-slimming):
  the `contract_mismatch` arm of `decideFailure` is deleted; the
  `switch` gains an `assertNever` tail. `sanitizeRecoveryMessage` is
  preserved verbatim; the verifier reuses it.
- `src/agents/persisted-tool-call.ts` rewritten per [§2.1.2](02-design-r3.md#212-persistence-errors-are-not-llmrequesterror):
  throws `PersistedRowCorruptError`; `parseToolCallArgsAgainstSchema`
  deleted. Callers in `src/agents/agent-session-coordinator.ts` and any
  resume/replay path surfaced by `tsc` are updated in the same step to
  catch `PersistedRowCorruptError`.
- Tests: `tests/agents/llm-failure-classifiers.test.ts`,
  `tests/agents/invocation-recovery-policy.test.ts`,
  `tests/agents/persisted-tool-call.test.ts` rewritten to the new
  shapes; any fixture asserting `LlmRequestError({kind:'contract_mismatch'})`
  is removed.

### Step 3 — MessageKind split (atomic, seven files)

Single atomic rewrite of producers, consumers, schemas, and fixtures so
that no row of either kind is ever produced through the wrong code path.

- `src/schemas/types.ts` and `src/schemas/validators.ts` extend
  `MessageKind` / `messageKindSchema` with `'context_compaction'` per
  [§2.1.9](02-design-r3.md#219-messagekind-split-for-context-compaction).
- `src/agents/compaction.ts` rewritten so every compaction row carries
  `kind: 'context_compaction'`.
- `src/agents/agent-adapter.ts` round-stamper at the diagnostic branch
  widens to include `'context_compaction'`. (This is the only edit to
  `agent-adapter.ts` in this step.)
- `web/src/api/types.ts` and `web/src/utils/agent-timeline/timeline.ts`
  extend the frontend `MessageKind` and the diagnostic predicate.
- `tests/agents/compaction.test.ts` and `tests/agents/session-persistence.test.ts`
  fixtures are updated; any fixture today using `'model_repair'` to
  stand in for a compaction notice is moved to `'context_compaction'`.

### Step 4 — Event and exchange schema additions (atomic, three files)

Additive schema edits only; no field is removed in this step (terminal-
tool-name removal belongs to Batch B/C). Single atomic rewrite of:

- `src/schemas/types.ts`: drop `'contract_mismatch'` from
  `LlmFailureClass`; add `contract_verdict?: 'satisfied' |
  'repair_exhausted' | 'no_progress'`, `repair_attempts: number`, and
  `contract_id: string` to `LlmInvocationSummaryEvent`; add the
  `LlmVerifierRejectionEvent` interface per [§2.1.7](02-design-r3.md#217-event-and-exchange-schema-rewrites).
- `src/schemas/event-catalog.ts`: drop `'contract_mismatch'` from
  `failureClassSchema`; extend `llmInvocationSummaryBaseShape` with the
  three new fields; register the `llm_verifier_rejection` zod schema.
- `src/contracts/llm-exchange.ts`: add the `contract_id` field on the
  recorded exchange envelope per [§2.1.7](02-design-r3.md#217-event-and-exchange-schema-rewrites).
- Tests: `tests/schemas/event-catalog.test.ts` and a new
  `tests/schemas/llm-verifier-rejection-event.test.ts` cover the new
  fields and the new event shape.

### Step 5 — Adapter inner loop rewritten around the driver (atomic, five files)

The adapter, the planner-control executor, the role runner, and the
system prompt builder are rewritten together so that no consumer of the
new return type sees a stale shape. This is the largest atomic step in
the batch; it cannot be split without leaving the tree non-compiling.

- `src/agents/agent-adapter.ts`: `invokeAgent` is rebuilt around the
  driver from Step 1 per [§2.3](02-design-r3.md#23-agent--runtime-repair-conversation)
  and [§3.4](02-design-r3.md#34-modules-rewritten-end-to-end-delete--replace).
  Deleted in the same edit: the inline `model_repair` template literals
  ([agent-adapter.ts#L302-L320](../../../../src/agents/agent-adapter.ts#L302-L320)),
  the post-loop `terminal_tool_missing` throw
  ([agent-adapter.ts#L385-L387](../../../../src/agents/agent-adapter.ts#L385-L387)),
  and `parseEnvelope`
  ([agent-adapter.ts#L46-L60](../../../../src/agents/agent-adapter.ts#L46-L60)).
  `invokePlanner`, `invokeExecutor`, `invokeReviewer`, `invokeAnalyst`
  return `Promise<InvocationOutcomeOf<…>>`. The done-signal tool is
  appended to the per-turn tools array as
  `buildDoneSignalTool(contract)`; the contract is obtained from Batch
  B's `ContractRegistry` for the active role.
- `src/agents/planner-control-executor.ts`: deferred-`activate_card`
  synthesises an envelope and feeds it through
  `driver.signalDoneFromRuntime(envelope)` per [§3.4](02-design-r3.md#34-modules-rewritten-end-to-end-delete--replace).
- `src/agents/agent-role-runner.ts`: `applySelfCheck` is deleted; each
  caller narrows `outcome.kind === 'succeeded'` to access
  `outcome.envelope` and forwards non-success arms unchanged.
- `src/agents/system-prompt.ts`: the done-signal description is read
  from the active `Contract` rather than being template-literal-coded.
- `src/agents/agent-session-coordinator.ts` and any supervisor caller
  surfaced by `tsc`: narrowed on `outcome.kind`.

### Step 6 — Tests for the new modules and the rewritten loop

New suites for Step 1 + Step 5:

- `tests/agents/contract-verifier.test.ts` — `parseDoneArgs`, `check`,
  `renderRepairMessage` per [§2.1.3](02-design-r3.md#213-contract-verifier-surface)
  (good envelope, invalid JSON, schema violation, redaction).
- `tests/agents/agent-loop-state.test.ts` — pure-transition table per
  [§3.2](02-design-r3.md#32-state-machine-for-the-agent-loop).
- `tests/agents/agent-loop-driver.test.ts` — scripted-LLM end-to-end:
  success, single-round repair, exhaustion, duplicate `signal_done`
  (`'ignored_duplicate_done'`), `no_progress`, cancellation,
  `signalDoneFromRuntime`.
- `tests/agents/done-signal-tool.test.ts` — schema built from each
  contract; override path.

Rewritten suites:

- `tests/agents/agent-adapter.test.ts` — drop terminal-tool-missing
  assertions; assert driver-mediated `succeeded` / `repair_exhausted` /
  `no_progress` outcomes.
- `tests/agents/planner-control-executor.test.ts` —
  `signalDoneFromRuntime` path.
- `tests/agents/agent-role-runner.test.ts` and
  `tests/agents/system-prompt.test.ts` — outcome narrowing and
  contract-driven done-signal description.

## 4. New files

Listed in Step 1 and Step 6. All under `src/agents/` and `tests/agents/`.
No new directory is introduced. The per-role contract factories live in
`src/contracts/` and are owned by Batch B.

## 5. Deleted files and symbols

No files are deleted in this batch. Symbol deletions (all from edits to
existing files, all atomic with their callers):

- `LlmFailure`, `ContractMismatchSubtype`, and their re-exports from
  `src/agents/llm-errors.ts`.
- `LlmFailureClass.'contract_mismatch'` from `src/schemas/types.ts` and
  `src/schemas/event-catalog.ts`.
- `parseToolCallArgsAgainstSchema` from
  `src/agents/persisted-tool-call.ts`.
- `parseEnvelope`, the inline `model_repair` template branch, and the
  post-loop `terminal_tool_missing` throw from
  `src/agents/agent-adapter.ts`.
- `applySelfCheck` from `src/agents/agent-role-runner.ts`.

Symbols owned by Batch B/C and **not** removed here:
`role-envelope-schemas.ts`, `role-result-tools.ts`, `terminal-protocol.ts`,
`TERMINAL_TOOL_NAMES`, `validateTerminalToolCall`, `LlmRolePhase`,
`LlmCompleteOptionsTerminal`, the `terminal_tool` field on
`LlmAttemptOutcome.succeeded`, `final_terminal_tool` on the summary
event, `recovery.ts`.

## 6. Tests

See Step 6 for the new and rewritten suites. No tests are deleted in this
batch; the suites tied to `role-envelope-schemas.ts`,
`role-result-tools.ts`, and `terminal-protocol.ts` remain Batch B's
responsibility to remove when their modules are deleted.

## 7. Validation

All commands run from `/home/salva/g/ml/saivage-v3`. Per-step checks run
the focused Jest suites for the files touched in that step.

```bash
cd /home/salva/g/ml/saivage-v3
npm run typecheck

# Step 2
npm test -- --runInBand \
  tests/agents/llm-failure-classifiers.test.ts \
  tests/agents/invocation-recovery-policy.test.ts \
  tests/agents/persisted-tool-call.test.ts

# Step 3
npm test -- --runInBand \
  tests/agents/compaction.test.ts \
  tests/agents/session-persistence.test.ts

# Step 4
npm test -- --runInBand tests/schemas

# Step 5
npm test -- --runInBand \
  tests/agents/agent-adapter.test.ts \
  tests/agents/planner-control-executor.test.ts \
  tests/agents/agent-role-runner.test.ts \
  tests/agents/system-prompt.test.ts

# Step 6 — new suites
npm test -- --runInBand \
  tests/agents/contract-verifier.test.ts \
  tests/agents/agent-loop-state.test.ts \
  tests/agents/agent-loop-driver.test.ts \
  tests/agents/done-signal-tool.test.ts

# Full suite + build
npm test -- --runInBand
npm run build

# Deploy + restart + smoke
rsync -a --delete dist/ root@10.0.3.170:/opt/saivage-v3/dist/
ssh root@10.0.3.170 'systemctl restart saivage-v3-getrich.service'
sleep 4
curl -fsS http://10.0.3.170:8080/health
curl -fsS http://10.0.3.170:8080/api/providers | jq
```

Smoke target is `saivage-v3-getrich.service` on
`saivage-v3-getrich-v2` at `10.0.3.170:8080`. The container at
`10.0.3.112` is the v2 harness and is not redeployed by this batch.

The web build runs as part of `npm run build`; no separate
`npm --prefix web run build` is required.

## 8. Rollback

Each step is one or more files under a single commit. Rollback is
per-step via `git revert <step-commit>`; rolling back any single step
leaves the tree compiling because each step is closed on its own
imports. Whole-batch rollback is a sequence of reverts from Step 6 back
to Step 1, followed by:

```bash
cd /home/salva/g/ml/saivage-v3
npm run build
rsync -a --delete dist/ root@10.0.3.170:/opt/saivage-v3/dist/
ssh root@10.0.3.170 'systemctl restart saivage-v3-getrich.service'
```
