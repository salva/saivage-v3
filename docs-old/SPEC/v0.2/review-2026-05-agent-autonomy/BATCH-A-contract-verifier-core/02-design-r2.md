# Batch A — Contract Verifier Core: Design

Scope: implementation-level design that resolves F02, F03, F04, F09. Two
proposals are presented (P-A1 focused, P-A2 architectural) followed by a
comparison, a recommendation, and rejected alternatives. All paths are
workspace-relative to `saivage-v3/`. No backward compatibility is preserved
anywhere in this design: every old shape named here is deleted in the same
change set as the new shape.

---

## 1. Design goal

Replace the per-turn protocol cop with a contract verifier that owns the
end of the invocation. In implementation terms:

- The agent loop in [src/agents/agent-adapter.ts](../../../../src/agents/agent-adapter.ts#L225)
  becomes contract-agnostic: it dispatches tool calls and persists messages
  until either the agent signals done, the turn budget is exhausted without
  a done signal, or the session is cancelled. It never throws
  `contract_mismatch` and it never writes a hand-written nudge.
- A new verifier module owns the only success exit, the only repair
  message producer (the structured `model_repair` row), and the only
  contract-layer terminal failure (`repair_exhausted`).
- Failures bifurcate at the type system. `LlmTransportFailure` is what
  `decideFailure` and the candidate-health subsystem see. `ContractViolation`
  is what the verifier produces; it never enters `LlmRequestError` and never
  reaches `invokeWithRecovery`.
- The agent ↔ runtime repair exchange is request/response on the same
  candidate inside the same `agentFn` attempt: verifier writes a structured
  `model_repair` message describing unmet obligations; agent takes more
  turns; agent re-signals done; verifier re-checks. Done-signal intent and
  envelope validity are decoupled.
- The tactical mitigation in commit `a2a6f05` (the inline plain-message
  nudge at [agent-adapter.ts#L302-L320](../../../../src/agents/agent-adapter.ts#L302-L320))
  is deleted in the same change set. Plain messages become normal
  in-progress traffic, not a repair trigger.

The wire form of the done signal in both proposals is a **dedicated function
tool** whose canonical name is `signal_done` (P-A1) or whose name is
declared by the active `Contract` (P-A2). Justification: every provider in
scope (opencode-go, openai-chat, openai-codex) reports tool calls through a
uniform `tool_calls` field; structured assistant content blocks (role-
specific JSON in `result.content`) are not uniformly surfaced. A dedicated
tool also keeps the agent's mental model simple ("everything you do is a
tool call") and survives provider transport without a new message kind on
the wire. P-A2 additionally permits a `kind: 'message'` done signal for the
analyst contract; that path coexists with the tool path via the same
`Contract` interface and does not introduce a parallel adapter.

---

## 2. Proposal P-A1 — Focused fix

A localised rewrite that touches the failure types, the adapter inner loop,
the terminal-tool plumbing, the recovery policy, the persistence
serializers, the event/exchange schemas, and the recorder. Adjacent
subsystems (role-runner, planner-control synthesis, system-prompt builder)
are touched only where the new contract surfaces force a change.

### 2.1 New types and modules

#### 2.1.1 Failure split

Delete the unified `LlmFailure` from [src/agents/llm-failure.ts#L9-L20](../../../../src/agents/llm-failure.ts#L9-L20)
and replace it with `LlmTransportFailure`. The `contract_mismatch` arm and
the `ContractMismatchSubtype` union at
[llm-failure.ts#L1-L7](../../../../src/agents/llm-failure.ts#L1-L7) are
deleted with no replacement on the transport side. The
`LlmFailure` / `ContractMismatchSubtype` re-exports in
[src/agents/llm-errors.ts#L1-L8](../../../../src/agents/llm-errors.ts#L1-L8)
are also deleted.

```ts
// src/agents/llm-failure.ts (rewritten end-to-end)

export type LlmTransportFailure =
  | { kind: 'auth_permanent'; provider: string; message: string; status: number }
  | { kind: 'rate_limit'; provider: string; message: string; status: number; retryAfterMs?: number; resetsAt?: string }
  | { kind: 'server_transient'; provider: string; message: string; status: number }
  | { kind: 'provider_protocol_error'; provider: string; message: string; status: number; bodyPreview?: string }
  | { kind: 'timeout'; provider: string; message: string }
  | { kind: 'capability_mismatch'; provider: string; message: string; model: string; requested: string[]; supported: string[] }
  | { kind: 'token_budget_exceeded'; provider: string; message: string; status: number }
  | { kind: 'parse_error'; provider: string; message: string; bodyPreview?: string }
  | { kind: 'cancelled'; provider: string; message: string; reason: 'abort' | 'timeout' }
  | { kind: 'unknown'; provider: string; message: string };

export class LlmRequestError extends Error {
  readonly failure: LlmTransportFailure;
  constructor(failure: LlmTransportFailure) {
    super(failure.message);
    this.name = 'LlmRequestError';
    this.failure = failure;
  }
}

export function unwrapFailure(err: unknown): LlmTransportFailure {
  if (err instanceof LlmRequestError) return err.failure;
  const message = err instanceof Error ? err.message : String(err);
  return { kind: 'unknown', provider: 'unknown', message };
}
```

`provider_protocol_error` is the replacement target for what
`OpenCodeGoClassifier` previously laundered as `contract_mismatch / unknown`
at [llm-failure-classifiers.ts#L99-L125](../../../../src/agents/llm-failure-classifiers.ts#L99-L125):
an HTTP 400 with a body the provider classifier cannot map. The recovery
policy treats it like `server_transient` for retry shaping but logs it
distinctly so opencode-go protocol drift is visible.

#### 2.1.2 Persistence errors are not LlmRequestError

[src/agents/persisted-tool-call.ts](../../../../src/agents/persisted-tool-call.ts#L1-L120)
today throws `LlmRequestError{kind:'contract_mismatch', subtype:
'legacy_message_shape' | 'tool_arguments_invalid_json'}` for malformed
persistence rows. Those throw sites are rewritten to throw a new, plain
error class `PersistedRowCorruptError extends Error`. Corrupt rows are an
integrity failure, never a transport failure, and never a contract
violation. The error surfaces to the caller of `parseToolCallMessage`
(session resume / replay code) and is handled there; it does not enter the
recovery policy or the verifier. The same module's
`parseToolCallArgsAgainstSchema` is deleted entirely — its zod responsibility
moves into the verifier (see 2.1.3); no caller outside the verifier needs
schema validation of tool arguments.

```ts
// src/agents/persisted-tool-call.ts (rewritten throw shape)

export class PersistedRowCorruptError extends Error {
  readonly code: 'not_object' | 'legacy_tool_calls_wrapper' | 'malformed_tool_call' | 'invalid_json';
  constructor(code: PersistedRowCorruptError['code'], message: string) {
    super(message);
    this.name = 'PersistedRowCorruptError';
    this.code = code;
  }
}
```

#### 2.1.3 Contract verifier surface

New module `src/agents/contract-verifier.ts`:

```ts
// src/agents/contract-verifier.ts

import type { z } from 'zod';
import type { EnvelopeBearingRole } from './role-envelope-schemas.js';

export interface Obligation {
  /** stable, machine-readable code; rendered into model_repair text */
  code:
    | 'envelope_missing'
    | 'envelope_invalid_json'
    | 'envelope_schema_violation'
    | 'envelope_field_missing'
    | 'envelope_field_invalid'
    | 'envelope_cross_field';
  /** JSON pointer into the proposed envelope; '' when the envelope itself is absent or unparsed */
  locator: string;
  /** model-facing description (already redacted) */
  description: string;
  /** optional expected value or shape, model-facing */
  expected?: string;
}

export interface ObligationReport {
  role: EnvelopeBearingRole;
  obligations: Obligation[];
  /** raw envelope as received from the agent; null when no done signal carried one or JSON parse failed */
  proposed: Record<string, unknown> | null;
}

/** Discriminated outcome of parsing the done-signal tool's raw `arguments` string. */
export type DoneArgsParse =
  | { kind: 'ok'; result: Record<string, unknown> | null }
  | { kind: 'invalid_json'; detail: string };

export type ContractCheckResult =
  | { kind: 'satisfied'; envelope: Record<string, unknown> }
  | { kind: 'violated'; report: ObligationReport };

export interface ContractVerifier {
  /** Parse the raw tool-call arguments string into the proposed envelope. */
  parseDoneArgs(rawArguments: string): DoneArgsParse;
  /** Verify a proposed envelope (or its absence) against the role's contract. */
  check(role: EnvelopeBearingRole, parsed: DoneArgsParse): ContractCheckResult;
  /** Render an obligation report into the model_repair payload string. */
  renderRepairMessage(report: ObligationReport): string;
}

export function createContractVerifier(): ContractVerifier { /* impl */ }
```

The verifier is the only place that consults `ENVELOPE_SCHEMAS` from
[src/agents/role-envelope-schemas.ts](../../../../src/agents/role-envelope-schemas.ts).
`validateTerminalToolCall` at
[terminal-protocol.ts#L6-L25](../../../../src/agents/terminal-protocol.ts#L6-L25)
is deleted; its zod-parse responsibility moves into `check`. Invalid JSON
in the done-signal arguments is reported as `Obligation.code:
'envelope_invalid_json'` with `locator: ''` — never as `envelope_missing`.

`renderRepairMessage` produces deterministic text from the obligation list
(one line per obligation: `[code] locator — description (expected: ...)`)
and is the only producer of `MessageKind: 'model_repair'` from
[src/schemas/types.ts#L83](../../../../src/schemas/types.ts#L83). The hand-
written templates in [agent-adapter.ts#L309-L318](../../../../src/agents/agent-adapter.ts#L309-L318)
are deleted. Strings rendered to the model are passed through
`sanitizeRecoveryMessage` from
[invocation-recovery-policy.ts#L56-L67](../../../../src/agents/invocation-recovery-policy.ts#L56-L67)
before persistence.

#### 2.1.4 Done signal tool

The role-specific terminal tools `emit_planner_result`,
`emit_executor_result`, `emit_reviewer_result` defined in
[role-result-tools.ts#L4-L8](../../../../src/agents/role-result-tools.ts#L4-L8)
are deleted. A single role-agnostic tool replaces them:

```ts
// src/agents/done-signal-tool.ts

import { zodToJsonSchemaMini, type JsonSchema } from './zod-to-jsonschema-mini.js';
import { ENVELOPE_SCHEMAS, type EnvelopeBearingRole } from './role-envelope-schemas.js';

export const DONE_SIGNAL_TOOL_NAME = 'signal_done' as const;
export type DoneSignalToolName = typeof DONE_SIGNAL_TOOL_NAME;

export interface DoneSignalToolDefinition {
  type: 'function';
  function: {
    name: DoneSignalToolName;
    description: string;
    parameters: JsonSchema;
  };
}

/** Build a per-role done-signal tool. parameters is the role envelope schema wrapped under a single `result` property. */
export function buildDoneSignalTool(role: EnvelopeBearingRole): DoneSignalToolDefinition {
  return {
    type: 'function',
    function: {
      name: DONE_SIGNAL_TOOL_NAME,
      description:
        'Signal that you have finished this invocation. Pass your proposed result envelope ' +
        'as the "result" argument. The runtime will verify it against the contract and, if ' +
        'anything is missing, reply with a structured list of unmet obligations.',
      parameters: zodToJsonSchemaMini(buildDoneSignalSchema(ENVELOPE_SCHEMAS[role])),
    },
  };
}
```

The done tool's `result` argument is *not* validated at dispatch time. The
adapter's tool-dispatch branch records "agent emitted done signal, raw
arguments = call.function.arguments". The verifier owns both JSON parsing
(`parseDoneArgs`) and schema validation (`check`).

#### 2.1.5 Repair budget and invocation outcome

The repair budget has exactly one scope: **one budget per `agentFn`
attempt**. It is allocated at the top of `agentFn` (inside
`invokeWithRecovery`'s closure body), incremented exactly once per
verifier-driven repair message append, persisted into the final
`InvocationOutcome` for that attempt, and never read by anything outside
that attempt. A transport-driven replay of `agentFn` (a new attempt issued
by `invokeWithRecovery` after `cooldown_and_failover` / `failover_without_cooldown`
/ `retry_same_after_delay`) starts a fresh budget; the previous budget's
counter is gone with the previous attempt's `InvocationOutcome`.

This is the only budget scope in the design. There is no
"per invocation across all candidates" counter. The rationale is that
each `agentFn` attempt is a fresh conversation on a fresh
`AgentSessionCoordinator` context (the system prompt is rebuilt, the
recovery directive is injected, the message log resumes from the same
session id but with a recovery message appended), so carrying the repair
counter across attempts would conflate two independent failure modes.

```ts
// src/agents/invocation-outcome.ts

import type { LlmTransportFailure } from './llm-failure.js';
import type { ObligationReport } from './contract-verifier.js';

export interface RepairBudget {
  /** total repair attempts allowed for one agentFn attempt */
  readonly max: number;
  /** consumed so far in the current agentFn attempt */
  consumed: number;
}

export function createRepairBudget(max: number): RepairBudget {
  return { max, consumed: 0 };
}

export type InvocationOutcome =
  | { kind: 'succeeded'; envelope: Record<string, unknown>; repairAttempts: number }
  | { kind: 'repair_exhausted'; lastReport: ObligationReport; repairAttempts: number }
  | { kind: 'no_progress'; turnsConsumed: number; repairAttempts: number }
  | { kind: 'transport_failed'; failure: LlmTransportFailure }
  | { kind: 'cancelled'; reason: 'abort' | 'timeout' };
```

`no_progress` is the new failure class introduced when the turn budget runs
out *without* a done signal. It is contract-layer (the agent simply did not
finish), so it does not enter `decideFailure`. `repair_exhausted` and
`no_progress` are surfaced via the new event payloads in 2.1.7; neither
maps to a `LlmFailureClass`.

#### 2.1.6 Recovery policy slimming

[src/agents/invocation-recovery-policy.ts#L127-L129](../../../../src/agents/invocation-recovery-policy.ts#L127-L129)
— the `case 'contract_mismatch':` arm — is deleted. The
`switch (failure.kind)` in `decideFailure` now has no contract arm and an
exhaustiveness check (`assertNever`) at the end so a future addition to
`LlmTransportFailure` is a compile error rather than a runtime fall-through.

`OpenCodeGoClassifier` at
[llm-failure-classifiers.ts#L99-L125](../../../../src/agents/llm-failure-classifiers.ts#L99-L125)
stops minting `contract_mismatch`. HTTP 400s with an unrecognised body map
to `provider_protocol_error`. The classifier signature loses its access to
contract subtypes (none exist anymore).

#### 2.1.7 Event and exchange schema rewrites

The terminal-tool name leaks across recorded exchanges and runtime events.
This proposal deletes those leaks rather than adapting them.

- [src/contracts/llm-exchange.ts#L32-L36](../../../../src/contracts/llm-exchange.ts#L32-L36)
  — `TERMINAL_TOOL_NAMES` constant and `TerminalToolName` type are deleted.
  Replaced by a single import `DoneSignalToolName` from
  `src/agents/done-signal-tool.ts`. Any zod schema in
  [src/contracts/llm-exchange.ts](../../../../src/contracts/llm-exchange.ts)
  that today references `TerminalToolName` instead references the literal
  `z.literal(DONE_SIGNAL_TOOL_NAME)`.
- [src/agents/llm-recording.ts#L4-L66](../../../../src/agents/llm-recording.ts#L4-L66)
  — `deriveTerminalToolFromOptions` is deleted. The recorder's
  `LlmRecorderRequest.terminalTool: TerminalToolName | null` field is
  renamed to `doneSignalTool: DoneSignalToolName | null` and is set to
  `DONE_SIGNAL_TOOL_NAME` whenever `opts.tools` includes the done-signal
  tool, and to `null` otherwise. `LlmCompleteOptionsTerminal` (the
  unused `phase: 'terminal'` branch of
  [llm-contracts.ts#L47-L52](../../../../src/agents/llm-contracts.ts#L47-L52))
  is deleted; `LlmCompleteOptions` becomes the sole type
  `LlmCompleteOptionsTools` (without the discriminant property — the
  `phase` field disappears entirely).
- [src/schemas/types.ts#L154-L163](../../../../src/schemas/types.ts#L154-L163)
  — `LlmAttemptOutcome.succeeded.terminal_tool` and
  `LlmInvocationSummaryEvent.final_terminal_tool` are deleted. The
  succeeded variant becomes:

  ```ts
  | { kind: 'succeeded' }  // no per-attempt tool name; signal_done is implicit
  ```

  The summary's `final_terminal_tool` field is replaced by nothing —
  consumers that today filter by terminal tool name filter on the role
  instead (`role: 'planner' | 'executor' | 'reviewer'`), which is already
  on the event.
- [src/schemas/types.ts#L154](../../../../src/schemas/types.ts#L154)
  — `LlmFailureClass` removes the `'contract_mismatch'` arm; the union
  shrinks to nine arms. A new field is added to
  `LlmInvocationSummaryEvent`:

  ```ts
  contract_verdict?: 'satisfied' | 'repair_exhausted' | 'no_progress';
  repair_attempts: number; // always present; zero when no repair occurred
  ```

  Verdicts not on this enum (transport-failed, cancelled) leave
  `contract_verdict` unset and use the existing `verdict` field.
- [src/schemas/event-catalog.ts#L7-L54](../../../../src/schemas/event-catalog.ts#L7-L54)
  — `failureClassSchema` enum drops `'contract_mismatch'`,
  `terminalToolNameSchema` and the `terminal_tool` property on the
  succeeded discriminant are deleted, and `llmInvocationSummaryBaseShape`
  gains `contract_verdict: z.enum(['satisfied','repair_exhausted','no_progress']).optional()`
  and `repair_attempts: z.number().int().nonnegative()`. The
  `final_terminal_tool` zod field is removed.

A new optional event kind `llm_verifier_rejection` is added to
[src/schemas/event-catalog.ts](../../../../src/schemas/event-catalog.ts) so
the dashboard can render per-repair-round detail:

```ts
export interface LlmVerifierRejectionEvent extends BaseEvent {
  kind: 'llm_verifier_rejection';
  session_id: string;
  role: 'planner' | 'executor' | 'reviewer';
  attempt: number;           // agentFn attempt index
  repair_round: number;      // 1-based round within this attempt
  obligation_codes: string[];
  proposed_present: boolean;
}
```

This event is emitted by the adapter exactly once per `model_repair` row it
appends. The transport-shaped `llm_attempt` event remains exclusively
transport-shaped.

### 2.2 Modules rewritten end-to-end (delete + replace)

The list below is the complete set of modules touched by P-A1. Every
deletion is hard (no shim, no re-export, no compatibility branch).

- [src/agents/terminal-protocol.ts](../../../../src/agents/terminal-protocol.ts)
  — **deleted**. Envelope parsing moves into the verifier; recognising the
  done-signal tool name is a literal comparison against
  `DONE_SIGNAL_TOOL_NAME`.
- [src/agents/role-result-tools.ts](../../../../src/agents/role-result-tools.ts)
  — **deleted**. Replaced by `src/agents/done-signal-tool.ts`. All
  symbols (`EMIT_PLANNER_RESULT`, `EMIT_EXECUTOR_RESULT`,
  `EMIT_REVIEWER_RESULT`, `ROLE_RESULT_TOOL_NAMES`, `ROLE_RESULT_TOOLS`)
  are removed; no shim file is left.
- [src/agents/agent-tool-catalog.ts](../../../../src/agents/agent-tool-catalog.ts#L5-L137)
  — **rewritten**. The import line
  `import { EMIT_PLANNER_RESULT, EMIT_EXECUTOR_RESULT, EMIT_REVIEWER_RESULT, ROLE_RESULT_TOOL_NAMES } from './role-result-tools.js'`
  is deleted. `ROLE_TOOL_NAMES.planner / .executor / .reviewer` arrays
  drop the trailing `ROLE_RESULT_TOOL_NAMES.<role>` entry; the done-signal
  tool is appended *by the adapter* via `buildDoneSignalTool(role)` when
  constructing `turnTools`, not stored on the catalogue. `ALL_TOOL_DEFINITIONS_BY_NAME`
  drops the three `EMIT_*_RESULT` entries; `signal_done` is looked up
  via `buildDoneSignalTool` on demand. A new helper
  `AgentToolCatalog.isDoneSignalTool(name)` returns
  `name === DONE_SIGNAL_TOOL_NAME`.
- [src/agents/persisted-tool-call.ts](../../../../src/agents/persisted-tool-call.ts)
  — **rewritten** per 2.1.2. Function `parseToolCallArgsAgainstSchema` is
  deleted. All `LlmRequestError` throws are replaced by
  `PersistedRowCorruptError`. The `legacy_message_shape` detector is
  deleted; corrupted persistence rows are surfaced as
  `PersistedRowCorruptError{code:'legacy_tool_calls_wrapper'}` for the
  one case in [persisted-tool-call.ts#L33-L40](../../../../src/agents/persisted-tool-call.ts#L33-L40),
  and the caller (session resume) treats it as an integrity failure.
- [src/agents/llm-errors.ts](../../../../src/agents/llm-errors.ts) —
  **rewritten**. Re-exports `LlmRequestError` and `unwrapFailure` only.
  `LlmFailure` and `ContractMismatchSubtype` re-exports are deleted.
- [src/agents/llm-recording.ts](../../../../src/agents/llm-recording.ts) —
  **rewritten** per 2.1.7. `TerminalToolName` import is replaced by
  `DoneSignalToolName`; `deriveTerminalToolFromOptions` is rewritten as
  `deriveDoneSignalToolFromOptions(opts: LlmCompleteOptions): DoneSignalToolName | null`
  which returns `DONE_SIGNAL_TOOL_NAME` iff `opts.tools.some(t =>
  t.function.name === DONE_SIGNAL_TOOL_NAME)` and `null` otherwise.
  `LlmRecorderRequest.terminalTool` is renamed `doneSignalTool` with the
  matching type.
- [src/agents/llm-contracts.ts#L47-L52](../../../../src/agents/llm-contracts.ts#L47-L52)
  — `LlmCompleteOptionsTerminal` is deleted. `LlmCompleteOptions` becomes
  exactly the previous `LlmCompleteOptionsTools` minus the `phase` field
  (the union is now a single object).
- [src/agents/llm-options-factory.ts#L23-L66](../../../../src/agents/llm-options-factory.ts#L23-L66)
  — `LlmRolePhase` type is deleted, `phase` parameter is removed from
  `buildLlmOptions`. The `'terminal'` branch in the function body is
  deleted with no replacement; the function builds tools-only options.
- [src/scripts/probe-llm-contract.ts#L14-L89](../../../../src/scripts/probe-llm-contract.ts#L14-L89)
  — imports and uses of `LlmRolePhase` are deleted; the script tests the
  `signal_done` tool directly.
- [src/contracts/llm-exchange.ts#L32-L36](../../../../src/contracts/llm-exchange.ts#L32-L36)
  — `TERMINAL_TOOL_NAMES`, `TerminalToolName` deleted; replaced by a
  re-export of `DONE_SIGNAL_TOOL_NAME` from `src/agents/done-signal-tool.ts`.
  Any zod schema literal `terminalToolNameSchema` references the new name.
- [src/schemas/types.ts](../../../../src/schemas/types.ts) and
  [src/schemas/event-catalog.ts](../../../../src/schemas/event-catalog.ts)
  — rewritten per 2.1.7.
- [src/agents/invocation-recovery-policy.ts](../../../../src/agents/invocation-recovery-policy.ts)
  — rewritten per 2.1.6.
- [src/agents/llm-failure-classifiers.ts](../../../../src/agents/llm-failure-classifiers.ts)
  — rewritten per 2.1.6.
- [src/agents/llm-failure.ts](../../../../src/agents/llm-failure.ts) —
  rewritten per 2.1.1.
- The contract-error path inside `AgentAdapter.invokeAgent`
  ([agent-adapter.ts#L273-L459](../../../../src/agents/agent-adapter.ts#L273-L459))
  — **rewritten** per 2.3.
- The deferred-`activate_card` synthesis branch at
  [agent-adapter.ts#L347-L382](../../../../src/agents/agent-adapter.ts#L347-L382)
  — rewritten: `PlannerControlExecutor` calls a new adapter-internal
  method `adapter.signalDoneFromRuntime(envelope)` which pushes a
  synthetic `signal_done` outcome into the same `pendingDone` slot the
  agent's tool call would. The verifier then sees the runtime-synthesised
  envelope through the same `check` path.

### 2.3 Agent ↔ runtime repair conversation

This section defines the only ordering. There is no other ordering anywhere
in the design.

Per agent turn, the adapter does the following, in this exact order:

1. **Receive LLM result.** `result = await llmCall(...)`.
2. **If `result.kind === 'message'`.** Append one
   `assistant / text` row with `result.content` and `continue` the turn
   loop. No repair message, no done-signal tracking.
3. **If `result.kind === 'tool_calls'`.** Iterate `result.tool_calls` in
   array order. For each call:
   - **Persist the call row first.** `appendSessionMessage` for the
     `assistant / tool_calls` row, exactly as today.
   - **Branch on name.**
     - `call.function.name === DONE_SIGNAL_TOOL_NAME`:
       - If `pendingDone === null`, parse with `verifier.parseDoneArgs(call.function.arguments)`,
         store `pendingDone = { parse, toolCallId: call.id }`, and continue
         to the next call.
       - If `pendingDone !== null`, persist a
         `tool / tool_result` row immediately with
         `tool_call_id: call.id, content: 'ignored_duplicate_done'` and do
         not overwrite `pendingDone`. The **first** done signal in a turn
         is canonical; any subsequent done signal in the same turn is
         logged-and-ignored.
     - Otherwise (any other tool): dispatch via `toolExecutor.processToolCall`,
       which persists its own `tool / tool_result` row.
4. **End-of-turn verification.** After the tool-call loop:
   - If `pendingDone === null`, `continue` the turn loop (no done signal
     this turn, so no verification, no repair message).
   - If `pendingDone !== null`, invoke `verifier.check(role, pendingDone.parse)`.
     - **Satisfied.** Persist `tool / tool_result` against the stored
       `pendingDone.toolCallId` with `content: 'verified'`. Set
       `finalEnvelope = check.envelope`. Break the turn loop.
     - **Violated, `repairBudget.consumed < repairBudget.max`.**
       Persist `tool / tool_result` against the stored
       `pendingDone.toolCallId` with `content: 'violated'`. Append exactly
       one `system / model_repair` row whose `content` is
       `verifier.renderRepairMessage(check.report)` and whose
       `tool_call_id` is `pendingDone.toolCallId`. Emit one
       `llm_verifier_rejection` event with `repair_round =
       repairBudget.consumed + 1`. Set `repairBudget.consumed += 1`. Set
       `pendingDone = null`. `continue` the turn loop.
     - **Violated, `repairBudget.consumed >= repairBudget.max`.**
       Persist `tool / tool_result` against the stored
       `pendingDone.toolCallId` with `content: 'violated_exhausted'`. Do
       not append a `model_repair` row. Do not emit
       `llm_verifier_rejection`. Return `InvocationOutcome{kind:
       'repair_exhausted', lastReport: check.report, repairAttempts:
       repairBudget.consumed}` from `agentFn`.
5. **End-of-loop fallback.** If the `for (let turn = 0; turn < maxToolTurns; turn++)`
   loop exits without `finalEnvelope` being set and without
   `repair_exhausted` being returned, return
   `InvocationOutcome{kind: 'no_progress', turnsConsumed: maxToolTurns,
   repairAttempts: repairBudget.consumed}`.

The pseudocode below is normative for the adapter's inner loop:

```ts
// pseudocode; lives in agent-adapter.ts

interface PendingDoneSignal { parse: DoneArgsParse; toolCallId: string; }

const repairBudget = createRepairBudget(repairBudgetMax);
let finalEnvelope: Record<string, unknown> | null = null;

for (let turn = 0; turn < maxToolTurns; turn++) {
  if (sessionCoordinator.isCancelled(session.id)) {
    return { kind: 'cancelled', reason: 'abort' };
  }

  const result = await llmCallFn(candidate, systemPrompt, modelMessages, session.id, opts);

  if (result.kind === 'message') {
    if (result.content) appendSessionMessage(session.id, { role: 'assistant', kind: 'text', content: result.content });
    continue;
  }

  let pendingDone: PendingDoneSignal | null = null;
  for (const tc of result.tool_calls) {
    appendSessionMessage(session.id, persistToolCallRow(tc));
    if (tc.function.name === DONE_SIGNAL_TOOL_NAME) {
      if (pendingDone !== null) {
        appendSessionMessage(session.id, { role: 'tool', kind: 'tool_result', tool_call_id: tc.id, content: 'ignored_duplicate_done' });
        continue;
      }
      pendingDone = { parse: verifier.parseDoneArgs(tc.function.arguments), toolCallId: tc.id };
      continue;
    }
    await toolExecutor.processToolCall(tc, /* ...session context... */);
  }

  if (pendingDone === null) continue;

  const check = verifier.check(role, pendingDone.parse);
  if (check.kind === 'satisfied') {
    appendSessionMessage(session.id, { role: 'tool', kind: 'tool_result', tool_call_id: pendingDone.toolCallId, content: 'verified' });
    finalEnvelope = check.envelope;
    break;
  }

  if (repairBudget.consumed >= repairBudget.max) {
    appendSessionMessage(session.id, { role: 'tool', kind: 'tool_result', tool_call_id: pendingDone.toolCallId, content: 'violated_exhausted' });
    return { kind: 'repair_exhausted', lastReport: check.report, repairAttempts: repairBudget.consumed };
  }

  appendSessionMessage(session.id, { role: 'tool', kind: 'tool_result', tool_call_id: pendingDone.toolCallId, content: 'violated' });
  appendSessionMessage(session.id, {
    role: 'system',
    kind: 'model_repair',
    content: verifier.renderRepairMessage(check.report),
    tool_call_id: pendingDone.toolCallId,
  });
  emitVerifierRejectionEvent({ attempt, repairRound: repairBudget.consumed + 1, report: check.report });
  repairBudget.consumed += 1;
}

if (finalEnvelope !== null) {
  return { kind: 'succeeded', envelope: finalEnvelope, repairAttempts: repairBudget.consumed };
}

return { kind: 'no_progress', turnsConsumed: maxToolTurns, repairAttempts: repairBudget.consumed };
```

Repair messages are subject to the same redaction as recovery directives —
the verifier passes its rendered text through `sanitizeRecoveryMessage`
([invocation-recovery-policy.ts#L56-L67](../../../../src/agents/invocation-recovery-policy.ts#L56-L67))
before returning it from `renderRepairMessage`.

### 2.4 How "agent declares done" is signalled

A dedicated tool: `signal_done(result: <role-specific envelope schema>)`.

Justified over the alternatives:

- **Dedicated tool vs distinguished message kind.** A `signal_done` tool
  survives every provider in scope. A `MessageKind: 'agent_done'` would
  require provider transports to surface structured assistant blocks
  faithfully; opencode-go has known gaps.
- **Single tool vs three role tools.** The three role tools today are
  identical in shape except for the name and schema. Collapsing them to one
  tool with a per-invocation parameter schema removes the role → tool-name
  map duplicated in
  [src/agents/role-result-tools.ts#L4-L8](../../../../src/agents/role-result-tools.ts#L4-L8)
  and [src/contracts/llm-exchange.ts#L32-L36](../../../../src/contracts/llm-exchange.ts#L32-L36).
- **Tool args not validated at dispatch.** Dispatch-time validation is what
  produced F02. The adapter's job is to *route* the done signal to the
  verifier; the verifier's job is to validate. Failed validation is normal
  traffic, not an exception.

### 2.5 Where the verifier lives and what it returns

Module: `src/agents/contract-verifier.ts` (new). Instantiated once and
injected into `AgentAdapter` via the constructor (next to
`sessionCoordinator`, `toolExecutor`, etc.). The verifier is in-process,
synchronous, and pure — it does not touch the session log, does not emit
events, and does not know about the candidate. It returns
`DoneArgsParse`, `ContractCheckResult`, and `Obligation[]`; the adapter
owns all I/O (persisting the repair message, incrementing the budget,
emitting events).

A per-issue verdict object is the `Obligation`: code + locator + description
+ optional expected. A repair round emits one `model_repair` row containing
the full list; the dashboard renders per-round detail from the
`llm_verifier_rejection` event in 2.1.7.

### 2.6 Transport vs contract repair split

- **Transport faults** travel `LlmTransportFailure → LlmRequestError →
  catch → decideFailure → InvocationRecoveryAction`. The candidate-health
  subsystem cools, fails over, retries the same candidate after a delay, or
  aborts. The transport recovery harness `invokeWithRecovery`
  ([recovery.ts#L93-L177](../../../../src/agents/recovery.ts#L93-L177))
  may replay the whole `agentFn` with a fresh candidate chain and a free-
  text directive.
- **Contract repair** stays *inside* `agentFn`, on the same candidate, on
  the same session, on the same model context. It consumes the
  per-`agentFn`-attempt repair budget (see 2.1.5), never bumps the
  transport attempt counter, never writes a `RecoveryContext.directive`,
  and never tells the candidate-health subsystem anything.
- The two budgets do not nest. The verifier never re-enters
  `invokeWithRecovery`; the transport harness never invokes the verifier.

### 2.7 Removal of the tactical mitigation

The plain-message branch at
[agent-adapter.ts#L302-L320](../../../../src/agents/agent-adapter.ts#L302-L320)
is deleted in the same commit as the rest of the rewrite. The post-loop
`terminal_tool_missing` throw at
[agent-adapter.ts#L385-L387](../../../../src/agents/agent-adapter.ts#L385-L387)
is also deleted. The two paths the analysis identifies as the runtime's
separate contract-miss handlers (the inline mitigation and the post-loop
throw) collapse into the verifier-driven repair loop above. Plain messages
become unremarkable; turn-budget exhaustion produces `no_progress`, not
`contract_mismatch`.

`MessageKind: 'model_repair'` from
[src/schemas/types.ts#L83](../../../../src/schemas/types.ts#L83) is kept,
but the verifier is the only producer. `model_issue` continues to mean
"transport-layer failure surfaced to the model" and remains written from
`decideFailure`'s `appendModelIssue`; `model_recovered` continues to mean
"transport recovery succeeded" and is unchanged.

---

## 3. Proposal P-A2 — One conceptual level up

A more architectural alternative that introduces a per-invocation
**Contract** object owning everything role-specific about an invocation, and
restructures the agent loop as an explicit state machine. P-A2 includes
everything in P-A1 (failure split, done-signal tool, verifier module,
repair budget, deletion of the tactical mitigation, every event/schema and
deletion-list item) and adds the generalisation that the analyst path and
any future role can use.

### 3.1 The Contract object

A `Contract<TEnvelope>` is the per-invocation bundle of done-signal
definition, envelope schema, repair format, and verifier strategy. The
contract is **generic in the envelope type**: a satisfied check returns
the fully typed envelope so no caller-side cast can reintroduce a schema
failure.

```ts
// src/agents/contract.ts

import type { JsonSchema } from './zod-to-jsonschema-mini.js';
import type { Obligation } from './contract-verifier.js';

/** Form of the done signal — tool call (envelope-bearing roles) or message (analyst-style). */
export type DoneSignalForm<TEnvelope> =
  | {
      kind: 'tool';
      toolName: string;
      /** schema for the tool's argument object, e.g. { type:'object', properties:{ result: ... } } */
      argsSchema: JsonSchema;
      /** projection from raw tool args object to the proposed envelope; identity for envelope tools */
      project: (args: Record<string, unknown>) => TEnvelope | null;
    }
  | {
      kind: 'message';
      /** projection from raw assistant text to the proposed envelope */
      project: (content: string) => TEnvelope | null;
    };

export interface RepairFormat {
  /** Stable header line for the rendered model_repair payload. */
  header: string;
  /** Render one obligation into a single line. */
  renderObligation: (o: Obligation) => string;
  /** Footer instruction. */
  footer: string;
}

export type ContractCheckResult<TEnvelope> =
  | { kind: 'satisfied'; envelope: TEnvelope }
  | { kind: 'violated'; obligations: Obligation[] };

export interface Contract<TEnvelope> {
  /** Identifier rendered into events for filtering (e.g. 'planner', 'reviewer-assessment', 'analyst'). */
  readonly id: string;
  readonly doneSignal: DoneSignalForm<TEnvelope>;
  readonly repairFormat: RepairFormat;
  /** Pure check; never touches I/O. Returns the typed envelope on success. */
  check(proposed: unknown): ContractCheckResult<TEnvelope>;
}

export interface ContractRegistry {
  forPlanner(): Contract<PlannerEnvelope>;
  forExecutor(): Contract<ExecutorEnvelope>;
  forReviewer(): Contract<ReviewerEnvelope>;
  forAnalyst(): Contract<AnalystEnvelope>;
}
```

`AgentAdapter.invokeAgent` takes a `Contract<TEnvelope>` argument; the
role's contract is looked up from a registry by the adapter's public
methods (`invokePlanner`, `invokeExecutor`, `invokeReviewer`,
`invokeAnalyst`). `parseEnvelope` at
[agent-adapter.ts#L46-L60](../../../../src/agents/agent-adapter.ts#L46-L60)
is **deleted**. Because `Contract.check`'s satisfied branch already returns
`TEnvelope`, the public methods now return
`Promise<{outcome: InvocationOutcomeOf<TEnvelope>}>` directly with no
projection step. The role → schema map `ENVELOPE_SCHEMAS` is deleted;
schemas live inside contract factories.

```ts
// src/agents/invocation-outcome.ts (P-A2 variant — generic in envelope)

import type { LlmTransportFailure } from './llm-failure.js';
import type { ObligationReport } from './contract-verifier.js';

export type InvocationOutcomeOf<TEnvelope> =
  | { kind: 'succeeded'; envelope: TEnvelope; repairAttempts: number }
  | { kind: 'repair_exhausted'; lastReport: ObligationReport; repairAttempts: number }
  | { kind: 'no_progress'; turnsConsumed: number; repairAttempts: number }
  | { kind: 'transport_failed'; failure: LlmTransportFailure }
  | { kind: 'cancelled'; reason: 'abort' | 'timeout' };
```

### 3.2 State machine for the agent loop

The inner per-turn loop is rewritten as an explicit state machine. States
and transitions are pure functions; the active `Contract` and the current
`RepairBudget` are inputs to every transition that needs them (no
contract-aware state without the contract in the signature):

```ts
// src/agents/agent-loop-state.ts

import type { LlmCompleteResult } from './llm-contracts.js';
import type { Contract, ContractCheckResult } from './contract.js';
import type { ObligationReport, DoneArgsParse } from './contract-verifier.js';
import type { RepairBudget } from './invocation-outcome.js';

export type AgentLoopState<TEnvelope> =
  | { kind: 'agent_turn'; turn: number; repairAttempts: number }
  | { kind: 'verifying'; proposed: DoneArgsParse | { kind: 'message_proposed'; raw: string }; toolCallId: string | null; turn: number; repairAttempts: number }
  | { kind: 'repairing'; report: ObligationReport; turn: number; repairAttempts: number }
  | { kind: 'done'; envelope: TEnvelope; repairAttempts: number }
  | { kind: 'repair_exhausted'; lastReport: ObligationReport; repairAttempts: number }
  | { kind: 'no_progress'; turnsConsumed: number; repairAttempts: number }
  | { kind: 'cancelled'; reason: 'abort' | 'timeout' };

export interface AgentLoopTransitions<TEnvelope> {
  onLlmResult(
    state: AgentLoopState<TEnvelope>,
    result: LlmCompleteResult,
    contract: Contract<TEnvelope>,
    maxToolTurns: number,
  ): AgentLoopState<TEnvelope>;
  onVerifierResult(
    state: AgentLoopState<TEnvelope>,
    check: ContractCheckResult<TEnvelope>,
    budget: RepairBudget,
  ): AgentLoopState<TEnvelope>;
  onCancellation(
    state: AgentLoopState<TEnvelope>,
    reason: 'abort' | 'timeout',
  ): AgentLoopState<TEnvelope>;
}
```

The transitions are pure. I/O (LLM call, tool dispatch, message
persistence, event recording, budget increment) is the **driver's**
responsibility — `onVerifierResult` returns the next state but does not
mutate `budget`; the driver increments `budget.consumed` exactly when it
transitions from `verifying` to `repairing` via that function's
`{kind:'violated'}` branch and the budget has not been exhausted. This
makes the loop trivially testable end-to-end: feed scripted LLM results
and verifier results and assert the state sequence; budget mutation is the
driver's concern, not the transition function's.

Recognising the done signal is a function of the contract, not of the
state machine:

```ts
// src/agents/agent-loop-state.ts (continued)

export function extractDoneSignal<TEnvelope>(
  result: LlmCompleteResult,
  contract: Contract<TEnvelope>,
): { found: 'tool'; rawArgs: string; toolCallId: string }
 | { found: 'message'; content: string }
 | { found: 'none' };
```

`onLlmResult` consults `extractDoneSignal(result, contract)` to decide
whether to transition into `verifying` (and which projection branch to
use) or to stay in `agent_turn` for the next round. This is how the state
machine knows which tool name is the done signal and how to project a
message — by reading them from the contract argument.

### 3.3 New modules to introduce

- `src/agents/contract.ts` — `Contract<TEnvelope>`, `ContractRegistry`,
  `DoneSignalForm<TEnvelope>`, `RepairFormat`, `ContractCheckResult<TEnvelope>`.
- `src/agents/contracts/` — directory containing one factory per contract:
  `planner-contract.ts`, `executor-contract.ts`, `reviewer-contract.ts`,
  `analyst-contract.ts`. Each factory owns its zod schema (moved out of
  `role-envelope-schemas.ts`).
- `src/agents/contract-verifier.ts` — same `Obligation` /
  `ObligationReport` / `DoneArgsParse` types as P-A1, but
  `createContractVerifier` becomes a thin shim that delegates to
  `Contract.check`. Verifier signature is the contract-typed variant:

  ```ts
  export interface ContractVerifier {
    parseDoneArgs(rawArguments: string): DoneArgsParse;
    check<TEnvelope>(contract: Contract<TEnvelope>, parse: DoneArgsParse): ContractCheckResult<TEnvelope>;
    renderRepairMessage(report: ObligationReport, format: RepairFormat): string;
  }
  ```
- `src/agents/agent-loop-state.ts` — the state types and pure transitions
  shown above.
- `src/agents/agent-loop-driver.ts` — wires the state machine to
  `AgentSessionCoordinator`, `AgentToolExecutor`,
  `AgentLlmInvocationGateway`, and the verifier. Owns budget increments
  and event emissions.
- `src/agents/done-signal-tool.ts` — the tool name and args schema come
  from `Contract.doneSignal` of `kind:'tool'`. The constant
  `DONE_SIGNAL_TOOL_NAME` becomes the planner/executor/reviewer factories'
  default name; a contract may override it (e.g. a future reviewer
  assessment scope can use `submit_assessment`).
- `src/agents/invocation-outcome.ts` — `InvocationOutcomeOf<TEnvelope>` as
  in 3.1.

### 3.4 Modules rewritten end-to-end (delete + replace)

- Everything in P-A1's delete list (2.2), plus:
- [src/agents/agent-adapter.ts](../../../../src/agents/agent-adapter.ts)
  — the `invokeAgent` body is rewritten around `AgentLoopDriver`. The
  public methods (`invokePlanner`, `invokeExecutor`, `invokeReviewer`,
  `reinvokeSession`, `callMcpTool`, etc.) keep their *names* because the
  supervisor and planner-control consumers depend on them; their return
  types change from `Promise<PlannerResult>` /
  `Promise<ExecutorResult>` / `Promise<ReviewerResult>` to
  `Promise<InvocationOutcomeOf<PlannerEnvelope>>` etc. Consumers that need
  the envelope project `outcome.kind === 'succeeded' ? outcome.envelope
  : throw` at their own callsite — there is one such projection per
  consumer, and it is purely a discriminator narrowing with no schema
  work. `parseEnvelope` at
  [agent-adapter.ts#L46-L60](../../../../src/agents/agent-adapter.ts#L46-L60)
  is deleted with no replacement.
- [src/agents/role-envelope-schemas.ts](../../../../src/agents/role-envelope-schemas.ts)
  — deleted as a runtime constant module. Its zod schemas move into the
  contract factory functions in `src/agents/contracts/`. The
  `EnvelopeBearingRole` type is also deleted (its only meaningful use is
  selecting the contract; in P-A2 the contract is selected by the
  adapter's public method, not by a role enum).
- [src/agents/llm-options-factory.ts](../../../../src/agents/llm-options-factory.ts)
  — the `LlmRolePhase` distinction (`'tools' | 'terminal'`) and the
  `'terminal'` branch at
  [llm-options-factory.ts#L23-L66](../../../../src/agents/llm-options-factory.ts#L23-L66)
  are deleted (latent machinery the hot path never used).
  `buildLlmOptions` takes the role's tools plus the done-signal tool
  derived from `contract.doneSignal` when `doneSignal.kind === 'tool'`,
  or only the role's tools when `doneSignal.kind === 'message'` (the
  analyst case).
- The planner-control synthesis at
  [agent-adapter.ts#L347-L382](../../../../src/agents/agent-adapter.ts#L347-L382)
  — `PlannerControlExecutor` is rewritten to register its own
  *runtime-internal done signal handler* on the loop driver. When
  `activate_card` transfers control, the executor calls
  `driver.signalDoneFromRuntime(envelope)` directly, which feeds the
  verifier the same proposed envelope an agent's `signal_done` call
  would. The adapter loses the special case.
- `AgentRoleRunner.applySelfCheck` at
  [agent-role-runner.ts#L34](../../../../src/agents/agent-role-runner.ts#L34)
  is deleted. Self-check responsibility moves into the contract's prompt
  builder (so prompt and contract cannot drift, addressing F07 by side
  effect). The system-prompt builders in
  [system-prompt.ts](../../../../src/agents/system-prompt.ts) are rewritten
  to read the done-signal definition from the active `Contract` rather than
  hand-writing "wrap it in a code block or return raw JSON".

### 3.5 Agent ↔ runtime repair conversation

Identical to P-A1's section 2.3 at the wire level (done signal → verifier →
optional repair message → repeat), with the same first-wins / ignored-
duplicate ordering, the same `tool_result` content vocabulary
(`'verified'` / `'violated'` / `'violated_exhausted'` /
`'ignored_duplicate_done'`), and the same per-`agentFn`-attempt budget
scope. The difference is structural: the loop driver mediates, the
transitions are explicit, and the contract — not the adapter — owns the
rendering of the repair message (`renderRepairMessage(report,
contract.repairFormat)`) and the schema check (`Contract.check`).

A second, equivalent path exists for tool-less contracts (`doneSignal.kind
=== 'message'`): a turn that returns `result.kind === 'message'` *with
non-empty content* is interpreted as the done signal by
`extractDoneSignal`, with the proposed envelope synthesised by
`contract.doneSignal.project(result.content)`. This is how analyst
unification works without inventing a separate adapter; the verifier and
repair loop run unchanged.

### 3.6 How "agent declares done" is signalled

For envelope-bearing contracts: a dedicated `signal_done` (or
contract-named) tool with the contract's envelope schema as the `result`
argument, exactly as P-A1.

For analyst-style contracts: a turn whose `result.kind === 'message'` with
non-empty content. The contract object distinguishes the two; the driver
does not.

### 3.7 Where the verifier lives and what it returns

`ContractVerifier` becomes a thin adapter that calls `Contract.check`.
Every contract owns its own check. The driver only depends on the abstract
`Contract<TEnvelope>` interface; it does not know which schema is in play
for a given invocation. The per-issue verdict object is still `Obligation`
(code + locator + description + optional expected) and an
`ObligationReport` aggregates them.

### 3.8 Transport vs contract repair split

Identical to P-A1: `LlmTransportFailure` is the only thing the recovery
policy sees, `ContractViolation` (here surfaced through `Contract.check`'s
`{kind:'violated'}` branch) never enters `LlmRequestError`. The driver
enforces the boundary: only LLM gateway exceptions can become transport
failures, only `Contract.check` results can become repair conditions.
The repair-budget scope is per `agentFn` attempt, exactly as P-A1.

### 3.9 Removal of the tactical mitigation

Same as P-A1: the inline mitigation at
[agent-adapter.ts#L302-L320](../../../../src/agents/agent-adapter.ts#L302-L320)
is deleted. In P-A2 it disappears in the larger adapter rewrite around the
driver; the plain-message branch becomes a transition into `agent_turn`
for envelope-bearing contracts and a transition into `verifying` for the
analyst contract.

### 3.10 Event and exchange schema rewrites

Same as P-A1's 2.1.7, with one addition: the new
`llm_verifier_rejection` event gains a `contract_id: string` field so
dashboards can filter by contract (`'planner'`, `'analyst'`, future
per-invocation overrides). `LlmInvocationSummaryEvent` likewise gains
`contract_id: string` so the summary identifies which contract verified
(or failed to verify) the run.

---

## 4. Comparison

| Dimension | P-A1 (focused) | P-A2 (architectural) |
|---|---|---|
| Blast radius | `llm-failure.ts`, `llm-failure-classifiers.ts`, `llm-errors.ts`, `llm-contracts.ts`, `llm-options-factory.ts` (phase deleted), `llm-recording.ts`, `invocation-recovery-policy.ts`, `terminal-protocol.ts` (deleted), `role-result-tools.ts` (deleted), `agent-tool-catalog.ts`, `persisted-tool-call.ts`, `contracts/llm-exchange.ts`, `schemas/types.ts`, `schemas/event-catalog.ts`, `scripts/probe-llm-contract.ts`, inner loop of `agent-adapter.ts`, `PlannerControlExecutor` callback rewrite. ~16 files. | Everything in P-A1 plus `role-envelope-schemas.ts` (deleted), `agent-adapter.ts` (full rewrite around driver), `agent-role-runner.ts` (self-check deleted), `system-prompt.ts` (prompts read from contract), new contract registry + state-machine modules + per-contract factories. ~22 files. |
| Autonomy gain | High. Resolves F02, F03, F04, F09. Verifier-driven repair is in place, contract failures stop aborting, transport and semantics are split. | High plus: contract is per-invocation pluggable, analyst can join the loop with no new code path, planner-control activation is a first-class contract event rather than a special case. |
| Future extensibility | Medium. Adding a new role still requires touching the role enum and writing a schema. Per-invocation contract overrides require additional plumbing. Analyst unification (F-batch-C work) needs a parallel path. | High. Adding a new role is "write a `Contract` factory"; per-invocation overrides are a parameter; analyst unification is a contract whose `doneSignal.kind === 'message'`. Removes the hard-coded role → tool-name map and the role → schema map in one stroke (preparing the ground for F05 in a later batch). |
| Implementation cost | Lower. Touches fewer call sites, leaves `agent-adapter.ts`'s public surface mostly untouched. | Higher. State-machine driver, contract registry, schema migration into contract factories, prompt-builder rewrite. Public method return types change from `PlannerResult` / `ExecutorResult` / `ReviewerResult` to `InvocationOutcomeOf<...>`, forcing every supervisor/planner-control caller to narrow on the discriminant. |
| Residual debt | The role → tool/schema/prompt fan-out remains in `ENVELOPE_SCHEMAS`, the per-role done-signal schema lookup, and the system-prompt builders. F05 and F07 are not addressed and will collide with this design when they are. The planner-control activation callback couples the adapter to the executor through a side channel. | Lower. The role → contract mapping is the only fan-out and lives in one registry. `LlmRolePhase` is gone. The planner-control activation is uniform with agent-driven done. F05 and F07 collapse to "extend `ContractRegistry`". |

---

## 5. Recommendation

**Adopt P-A2.**

The brief explicitly invites "one conceptual level up" and flags analyst
unification as an option to take if it materially simplifies the design.
P-A2 does both. The four issues in scope (F02, F03, F04, F09) reduce to
contract-layer concerns that the verifier owns, and the architectural moves
(per-invocation `Contract<TEnvelope>`, explicit loop driver, prompt-from-
contract) collapse three separate maps (role → tool name, role → schema,
role → prompt) into one registry. That removes the structural pressure
behind F05 ("hardcoded role taxonomy") and F07 ("system prompt misaligned
with runtime contract") before those batches even start, so Batch B and
Batch C inherit a smaller surface to redesign.

The implementation cost difference is real but bounded — most of the extra
work is rewriting the adapter's inner loop, which P-A1 already touches end-
to-end, and migrating three zod schemas into three contract factories. The
project rules forbid backward-compatibility scaffolding; the redesign deletes
old shapes and updates call sites in the same change set either way.
Choosing P-A1 means accepting that the next batch's redesign will rewrite
the same code again, which is worse than doing the architectural work once.

The analyst contract (`doneSignal.kind === 'message'`) is the deciding
factor: P-A1 cannot accept analyst into the verifier loop without inventing
a parallel adapter; P-A2 accepts it with no additional driver code. Even if
analyst is not unified in this review cycle, having the affordance in the
type system is cheaper than retrofitting it.

The typed `Contract<TEnvelope>` also closes one boundary P-A1 leaves open:
in P-A1 the verifier returns `Record<string, unknown>` and the callers in
the adapter project it back into the typed `PlannerResult / ExecutorResult
/ ReviewerResult` shapes, which is precisely the projection step that today
can fail schema validation outside the verifier. In P-A2 the satisfied
branch returns the typed envelope, so the projection cannot fail.

---

## 6. Rejected alternatives

- **Keep the phase machinery, just soften the gate.** Make
  `case 'contract_mismatch':` return `retry_same_after_delay` instead of
  `fail_invocation + abort`. Rejected: it routes contract repair through
  the transport recovery harness, replays the entire `agentFn` with a
  free-text directive instead of a structured report, and bumps the
  candidate-health attempt counter on every contract miss. It addresses
  F02 symptomatically and leaves F03, F04, F09 untouched.

- **Promote the inline `model_repair` nudge to a helper module.** Pull
  the template literal at
  [agent-adapter.ts#L309-L318](../../../../src/agents/agent-adapter.ts#L309-L318)
  into `src/agents/model-repair-prompts.ts` and call it from both the
  plain-message branch and the post-loop throw site. Rejected: the
  fundamental problem is that the runtime invents the repair vocabulary
  from a templated string instead of from a structured contract diff. A
  helper module preserves the band-aid layer.

- **Validate `signal_done` arguments at dispatch time using the
  existing `parseToolCallArgsAgainstSchema`.** Rejected: this rebuilds F02
  one level lower. A dispatch-time `LlmRequestError` would still need a
  recovery arm, and the verifier loop would have two entry points (parse
  failure vs cross-field violation) for what is logically one event.

- **Use a distinguished `MessageKind: 'agent_done'` instead of a tool.**
  Rejected for transport-compatibility reasons documented in 2.4. Provider
  transports vary in how they surface non-tool structured assistant
  content; the `tool_calls` channel is the only uniformly available
  structured surface for envelope-bearing roles. (P-A2's analyst contract
  uses message-kind done specifically because the analyst envelope is
  free-form text where the transport already round-trips the content.)

- **Have the verifier produce a `LlmFailure { kind: 'contract_violation'
  }` that flows through `decideFailure` with a contract-specific arm.**
  Rejected: this preserves the type-level conflation F04 calls out. The
  whole point of the failure split is that the recovery policy never sees
  a semantic failure. A "contract" arm in `decideFailure` would attract
  transport-policy thinking (cooldowns, candidate-health updates) that
  does not apply to contract repair.

- **Per-invocation repair budget carried across transport-driven `agentFn`
  retries.** Rejected: each `agentFn` attempt rebuilds the system prompt
  and appends a recovery directive, so it is a new conversation; carrying
  the previous attempt's repair count would conflate two independent
  failure modes. The chosen scope is per `agentFn` attempt, with the
  counter reported in `InvocationOutcome.repairAttempts` and on the
  `llm_invocation_summary` event so cross-attempt patterns remain
  observable without coupling the budget to the transport harness.

- **Last-wins for multiple `signal_done` calls in one turn.** Rejected: the
  agent's first done signal is the one the prompt asks for and the only
  one the verifier should diff against. Permitting last-wins would let an
  agent overwrite a failing envelope by tacking on a second tool call in
  the same turn, which is the dispatch-time-validation antipattern in a
  new dress. The chosen rule is first-wins; duplicates persist a
  `tool_result` row with content `'ignored_duplicate_done'` so the
  behaviour is observable.

- **Cross-candidate repair handoff** (failed repair on candidate A is
  retried on candidate B, carrying the obligation report with it).
  Rejected for this batch: the open question in the analysis (4.4) lists
  it as one valid resolution for repeated identical reports, but it
  requires the contract layer to own its own candidate-rotation policy,
  which duplicates the transport layer's. The chosen resolution is
  `repair_exhausted` as a terminal state; cross-candidate handoff is left
  as a future enhancement that can be added without re-architecting the
  verifier.
