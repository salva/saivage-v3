# Batch A — Contract Verifier Core: Design

Scope: implementation-level design that resolves F02, F03, F04, F09. Two
proposals are presented (P-A1 focused, P-A2 architectural) followed by a
comparison, a recommendation, and rejected alternatives. All paths are
relative to `saivage-v3/`.

---

## 1. Design goal

Replace the per-turn protocol cop with a contract verifier that owns the
end of the invocation. In implementation terms:

- The agent loop in [src/agents/agent-adapter.ts#L225](../../../../src/agents/agent-adapter.ts#L225)
  becomes contract-agnostic: it dispatches tool calls and persists messages
  until either the agent signals done, the turn budget is exhausted without
  a done signal, or the session is cancelled. It never throws
  `contract_mismatch` and it never writes a hand-written nudge.
- A new verifier module owns the only success exit (`invocation_succeeded`),
  the only repair message producer (the structured `model_repair` row), and
  the only contract-layer terminal failure (`repair_exhausted`).
- Failures bifurcate at the type system. `LlmTransportFailure` is what
  `decideFailure` and the candidate-health subsystem see. `ContractViolation`
  is what the verifier produces; it never enters `LlmRequestError` and never
  reaches `invokeWithRecovery`.
- The agent ↔ runtime repair exchange is a request/response on the same
  candidate inside the same `invokeWithRecovery` attempt: verifier writes a
  structured `model_repair` message describing unmet obligations; agent
  takes more turns; agent re-signals done; verifier re-checks. Done-signal
  intent and envelope validity are decoupled.
- The tactical mitigation in commit `a2a6f05` (the inline plain-message
  nudge at [agent-adapter.ts#L302-L320](../../../../src/agents/agent-adapter.ts#L302-L320))
  is deleted in the same change set. Plain messages become normal
  in-progress traffic, not a repair trigger.

The wire form of the done signal in both proposals is a **dedicated function
tool**: a single role-agnostic `signal_done` (P-A1) or `submit_result`
(P-A2) whose arguments carry the candidate envelope. Justification: every
provider currently in scope (opencode-go, openai-chat, openai-codex) reports
tool calls through a uniform `tool_calls` field; structured assistant
content blocks (e.g. role-specific JSON in `result.content`) are not
uniformly surfaced. A dedicated tool also keeps the agent's mental model
simple ("everything you do is a tool call") and survives provider transport
without a new message kind on the wire.

---

## 2. Proposal P-A1 — Focused fix

A localised rewrite that touches the failure types, the adapter inner loop,
the terminal-tool plumbing, and the recovery policy. Adjacent subsystems
(role-runner, planner-control synthesis, system-prompt builder) are touched
only where the new contract surfaces force a change.

### 2.1 New types and modules

#### 2.1.1 Failure split

Delete the unified `LlmFailure` from [src/agents/llm-failure.ts#L9-L20](../../../../src/agents/llm-failure.ts#L9-L20)
and replace it with `LlmTransportFailure`. The `contract_mismatch` arm and
the `ContractMismatchSubtype` union at
[llm-failure.ts#L1-L7](../../../../src/agents/llm-failure.ts#L1-L7) are
deleted with no replacement on the transport side.

```ts
// src/agents/llm-failure.ts (rewritten)

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

#### 2.1.2 Contract verifier surface

New module `src/agents/contract-verifier.ts`:

```ts
// src/agents/contract-verifier.ts

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
  /** JSON pointer into the proposed envelope; '' when the envelope itself is absent */
  locator: string;
  /** model-facing description (already redacted) */
  description: string;
  /** optional expected value or shape, model-facing */
  expected?: string;
}

export interface ObligationReport {
  role: EnvelopeBearingRole;
  obligations: Obligation[];
  /** raw envelope as received from the agent, or null when no done signal carried one */
  proposed: Record<string, unknown> | null;
}

export type ContractCheckResult =
  | { kind: 'satisfied'; envelope: Record<string, unknown> }
  | { kind: 'violated'; report: ObligationReport };

export interface ContractVerifier {
  check(
    role: EnvelopeBearingRole,
    proposed: Record<string, unknown> | null,
  ): ContractCheckResult;
  /** Render an obligation report into the model_repair payload string. */
  renderRepairMessage(report: ObligationReport): string;
}

export function createContractVerifier(): ContractVerifier { /* impl */ }
```

The verifier is the only place that consults `ENVELOPE_SCHEMAS` from
[src/agents/role-envelope-schemas.ts](../../../../src/agents/role-envelope-schemas.ts).
`validateTerminalToolCall` at
[terminal-protocol.ts#L6-L25](../../../../src/agents/terminal-protocol.ts#L6-L25)
is deleted; its zod-parse responsibility moves into the verifier without
the `LlmRequestError` wrapper.

`renderRepairMessage` produces deterministic text from the obligation list
(one line per obligation: `[code] locator — description (expected: ...)`)
and is the only producer of `MessageKind: 'model_repair'` from
[src/schemas/types.ts#L83](../../../../src/schemas/types.ts#L83). The hand-
written templates in [agent-adapter.ts#L309-L318](../../../../src/agents/agent-adapter.ts#L309-L318)
are deleted.

#### 2.1.3 Done signal

The role-specific terminal tools `emit_planner_result`,
`emit_executor_result`, `emit_reviewer_result` defined in
[role-result-tools.ts#L4-L8](../../../../src/agents/role-result-tools.ts#L4-L8)
are deleted. A single role-agnostic tool replaces them:

```ts
// src/agents/done-signal-tool.ts

import { zodToJsonSchemaMini, type JsonSchema } from './zod-to-jsonschema-mini.js';
import { ENVELOPE_SCHEMAS, type EnvelopeBearingRole } from './role-envelope-schemas.js';

export const DONE_SIGNAL_TOOL_NAME = 'signal_done' as const;

export interface DoneSignalToolDefinition {
  type: 'function';
  function: {
    name: typeof DONE_SIGNAL_TOOL_NAME;
    description: string;
    parameters: JsonSchema;
  };
}

/** Build a per-role done-signal tool. parameters.result is the role envelope schema. */
export function buildDoneSignalTool(role: EnvelopeBearingRole): DoneSignalToolDefinition {
  return {
    type: 'function',
    function: {
      name: DONE_SIGNAL_TOOL_NAME,
      description:
        'Signal that you have finished this invocation. Pass your proposed result envelope ' +
        'as the "result" argument. The runtime will verify it against the contract and, if ' +
        'anything is missing, reply with a structured list of unmet obligations.',
      parameters: zodToJsonSchemaMini(buildDoneSignalSchema(role)),
    },
  };
}
```

The done tool's `result` argument is *not* validated at dispatch time. The
adapter's tool-dispatch branch simply records "agent emitted done signal,
proposed = call.args.result". The verifier owns validation.

`TERMINAL_TOOL_NAMES` duplicated in
[src/contracts/llm-exchange.ts#L32-L36](../../../../src/contracts/llm-exchange.ts#L32-L36)
is deleted. The single constant `DONE_SIGNAL_TOOL_NAME` is the only name
anyone may grep for.

#### 2.1.4 Repair budget and invocation outcome

```ts
// src/agents/invocation-outcome.ts

export interface RepairBudget {
  /** total repair attempts per invocation, across all candidates */
  readonly max: number;
  /** consumed so far */
  consumed: number;
}

export type InvocationOutcome<T> =
  | { kind: 'succeeded'; result: T; repairAttempts: number }
  | { kind: 'repair_exhausted'; lastReport: ObligationReport; repairAttempts: number }
  | { kind: 'no_progress'; turnsConsumed: number; repairAttempts: number }
  | { kind: 'transport_failed'; failure: LlmTransportFailure }
  | { kind: 'cancelled'; reason: 'abort' | 'timeout' };
```

`no_progress` is the new failure class introduced when the turn budget runs
out *without* a done signal. It is contract-layer (the agent simply did not
finish), not transport-layer, so it does not enter `decideFailure`.

#### 2.1.5 Recovery policy slimming

[src/agents/invocation-recovery-policy.ts#L127-L129](../../../../src/agents/invocation-recovery-policy.ts#L127-L129)
— the `case 'contract_mismatch':` arm — is deleted. The
`switch (failure.kind)` in `decideFailure` now has no contract arm.
`AvailabilityDecision` and `InvocationRecoveryAction` types are unchanged
in shape but their inputs are statically constrained to
`LlmTransportFailure`.

`OpenCodeGoClassifier` at
[llm-failure-classifiers.ts#L99-L125](../../../../src/agents/llm-failure-classifiers.ts#L99-L125)
stops minting `contract_mismatch`. HTTP 400s with an unrecognised body map
to `provider_protocol_error`. The classifier signature loses its access to
contract subtypes.

### 2.2 Modules rewritten end-to-end (delete + replace)

- [src/agents/terminal-protocol.ts](../../../../src/agents/terminal-protocol.ts)
  — deleted. Responsibilities split into the verifier (envelope parsing)
  and the adapter (recognising the done-signal tool name).
- [src/agents/role-result-tools.ts](../../../../src/agents/role-result-tools.ts)
  — deleted. Replaced by `src/agents/done-signal-tool.ts`.
- The contract-error path inside `AgentAdapter.invokeAgent`
  ([agent-adapter.ts#L299-L451](../../../../src/agents/agent-adapter.ts#L299-L451))
  — rewritten. The new inner loop is:

```ts
// pseudocode showing the new shape; lives in agent-adapter.ts

interface PendingDoneSignal { proposed: Record<string, unknown> | null; toolCallId: string; }

let pendingDone: PendingDoneSignal | null = null;
let report: ObligationReport | null = null;

for (let turn = 0; turn < maxToolTurns; turn++) {
  if (this.sessionCoordinator.isCancelled(session.id)) throw cancelledError;
  const result = await this.llmCallFn(candidate, systemPrompt, modelMessages, session.id, opts);

  if (result.kind === 'message') {
    if (result.content) this.appendSessionMessage(session.id, { role: 'assistant', kind: 'text', content: result.content });
    continue; // plain messages are normal in-progress traffic
  }

  pendingDone = null;
  for (const tc of result.tool_calls) {
    if (tc.function.name === DONE_SIGNAL_TOOL_NAME) {
      pendingDone = { proposed: parseDoneArgs(tc), toolCallId: tc.id };
      continue;
    }
    await this.toolExecutor.processToolCall(...);
  }

  if (!pendingDone) continue;

  const check = this.verifier.check(role, pendingDone.proposed);
  if (check.kind === 'satisfied') { finalEnvelope = check.envelope; break; }

  if (repairBudget.consumed >= repairBudget.max) {
    return { kind: 'repair_exhausted', lastReport: check.report, repairAttempts: repairBudget.consumed };
  }
  repairBudget.consumed += 1;
  this.appendSessionMessage(session.id, {
    role: 'system', kind: 'model_repair',
    content: this.verifier.renderRepairMessage(check.report),
    tool_call_id: pendingDone.toolCallId,
  });
  report = check.report;
}

if (!finalEnvelope) {
  return { kind: 'no_progress', turnsConsumed: turn, repairAttempts: repairBudget.consumed };
}
```

- The deferred-`activate_card` synthesis branch at
  [agent-adapter.ts#L347-L382](../../../../src/agents/agent-adapter.ts#L347-L382)
  is rewritten. `PlannerControlExecutor` now emits a runtime-internal done
  signal directly when activation transfers control: instead of returning a
  `deferred` envelope that the adapter pattern-matches, it pushes a
  fully-formed `PlannerResult` (`status:'continue'` or `status:'blocked'`)
  into `pendingDone` via a new internal callback. The adapter has no special
  case for activation; the verifier sees the same proposed envelope shape it
  would see from the agent itself.

### 2.3 Agent ↔ runtime repair conversation

One repair round consists of exactly:

1. **Agent → runtime.** Agent emits zero or more non-done tool calls, then
   emits the `signal_done` tool call with `args.result = { ... }`. Multiple
   tool calls in the same turn are allowed; only one `signal_done` per turn
   is meaningful (extras are ignored after the first). The turn ends when
   the LLM call returns.

2. **Runtime → verifier.** Adapter unwraps `args.result` and hands it to
   `verifier.check(role, proposed)`.

3a. **Satisfied.** Adapter writes a `tool_result` row against the
   `signal_done` tool call (content: `"verified"`), exits the loop, runs
   `parseEnvelope` as a pure projection, and `recordAttemptOutcome` writes
   one transport attempt.

3b. **Violated, repair budget remaining.** Adapter writes a `tool_result`
   row against the `signal_done` tool call (content: `"violated"`) and
   appends one `system / model_repair` row containing the rendered
   obligation report. The session resumes the inner loop on the next turn;
   the agent's tool catalogue is unchanged (the runtime does *not* switch
   to a "terminal-only" mode). Repair budget consumed += 1.

3c. **Violated, repair budget exhausted.** Adapter writes the same
   `tool_result` row, does *not* append a further `model_repair` (the agent
   gets no more turns), and propagates `InvocationOutcome.repair_exhausted`
   to the outer wrapper. This is the contract-layer terminal state.

Repair messages are subject to the same redaction as recovery directives —
the verifier renders strings through `sanitizeRecoveryMessage` from
[invocation-recovery-policy.ts#L56-L67](../../../../src/agents/invocation-recovery-policy.ts#L56-L67)
before persisting.

### 2.4 How "agent declares done" is signalled

A dedicated tool: `signal_done(result: <role-specific envelope schema>)`.

Justified over the alternatives:

- **Dedicated tool vs distinguished message kind.** A `signal_done` tool
  survives every provider in scope. A `MessageKind: 'agent_done'` would
  require provider transports to surface structured assistant blocks
  faithfully; opencode-go has known gaps.
- **Single tool vs three role tools.** The three role tools today are
  identical in shape except for the name and schema. Collapsing them to one
  tool with a per-invocation parameter schema removes the role -> tool-name
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
`ContractCheckResult` and `Obligation[]`; the adapter is responsible for
all I/O (persisting the repair message, incrementing the budget, recording
events).

A per-issue verdict object is the `Obligation`: code + locator + description
+ optional expected. A repair round emits one `model_repair` row containing
the full list; the dashboard can render either form.

### 2.6 Transport vs contract repair split

- **Transport faults** travel `LlmTransportFailure -> LlmRequestError -> catch
  -> decideFailure -> InvocationRecoveryAction`. The candidate-health
  subsystem cools, fails over, retries the same candidate after a delay, or
  aborts. The transport recovery harness `invokeWithRecovery`
  ([recovery.ts#L93-L177](../../../../src/agents/recovery.ts#L93-L177))
  may replay the whole `agentFn` with a fresh candidate chain and a free-
  text directive.
- **Contract repair** stays *inside* `agentFn`, on the same candidate, on
  the same session, on the same model context. It consumes the repair
  budget, never bumps the transport attempt counter, never writes a
  `RecoveryContext.directive`, and never tells the candidate-health
  subsystem anything.
- The two budgets do not nest. The verifier never re-enters
  `invokeWithRecovery`; the transport harness never invokes the verifier.
  `RepairBudget` is per-invocation, allocated when `invokeAgent` enters,
  not per `agentFn` attempt. A transport-driven retry of `agentFn` starts a
  fresh repair budget (rationale: the new attempt is a new conversation).

### 2.7 Removal of the tactical mitigation

The plain-message branch at
[agent-adapter.ts#L302-L320](../../../../src/agents/agent-adapter.ts#L302-L320)
is deleted in the same commit as the rest of the rewrite. The post-loop
`terminal_tool_missing` throw at
[agent-adapter.ts#L385-L387](../../../../src/agents/agent-adapter.ts#L385-L387)
is also deleted. The two paths the analysis identifies as the runtime's two
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
repair budget, deletion of the tactical mitigation) and adds the
generalisation that the analyst path and any future role can use.

### 3.1 The Contract object

A `Contract` is the per-invocation bundle of schema, done-signal definition,
repair format, and verifier strategy.

```ts
// src/agents/contract.ts

import type { JsonSchema } from './zod-to-jsonschema-mini.js';
import type { Obligation, ObligationReport } from './contract-verifier.js';

export type DoneSignalForm =
  | {
      kind: 'tool';
      toolName: string;
      /** schema for the tool's argument object */
      argsSchema: JsonSchema;
      /** projection from raw tool args to the proposed result; identity by default */
      project: (args: Record<string, unknown>) => Record<string, unknown> | null;
    }
  | {
      /** Used by analyst-style invocations where any non-empty text content satisfies the contract. */
      kind: 'message';
    };

export interface RepairFormat {
  /** Stable header line for the rendered model_repair payload. */
  header: string;
  /** Render one obligation into a single line. */
  renderObligation: (o: Obligation) => string;
  /** Optional footer instruction. Defaults to "Fix these issues and signal done again." */
  footer?: string;
}

export interface Contract {
  /** Identifier rendered into events for filtering (e.g. 'planner', 'reviewer-assessment'). */
  readonly id: string;
  readonly doneSignal: DoneSignalForm;
  readonly repairFormat: RepairFormat;
  /** Pure check; never touches I/O. */
  check(proposed: Record<string, unknown> | null): { kind: 'satisfied'; envelope: Record<string, unknown> }
                                                  | { kind: 'violated'; obligations: Obligation[] };
}

export interface ContractRegistry {
  forPlanner(): Contract;
  forExecutor(): Contract;
  forReviewer(): Contract;
  forAnalyst(): Contract; // doneSignal.kind === 'message'
}
```

`AgentAdapter.invokeAgent` takes a `Contract` argument (or, equivalently,
the role's contract is looked up from a registry). `parseEnvelope` is
absorbed into `Contract.check`'s envelope projection — the supervisor
consumers still receive `PlannerResult / ExecutorResult / ReviewerResult`
shapes because `Contract.check`'s success branch returns a fully-formed
envelope, and a thin caller-side projection casts to the static type. The
role -> schema map `ENVELOPE_SCHEMAS` is deleted; schemas live inside
contract factories.

### 3.2 State machine for the agent loop

The inner per-turn loop is rewritten as an explicit state machine. States:

```ts
// src/agents/agent-loop-state.ts

export type AgentLoopState =
  | { kind: 'agent_turn'; turn: number; repairAttempts: number }
  | { kind: 'verifying'; proposed: Record<string, unknown> | null; toolCallId: string | null; turn: number; repairAttempts: number }
  | { kind: 'repairing'; report: ObligationReport; turn: number; repairAttempts: number }
  | { kind: 'done'; envelope: Record<string, unknown>; repairAttempts: number }
  | { kind: 'repair_exhausted'; lastReport: ObligationReport; repairAttempts: number }
  | { kind: 'no_progress'; turnsConsumed: number; repairAttempts: number }
  | { kind: 'cancelled'; reason: 'abort' | 'timeout' };

export interface AgentLoopTransitions {
  onLlmResult(state: AgentLoopState, result: LlmCompleteResult): AgentLoopState;
  onVerifierResult(state: AgentLoopState, check: ContractCheckResult, budget: RepairBudget): AgentLoopState;
  onCancellation(state: AgentLoopState, reason: 'abort' | 'timeout'): AgentLoopState;
}
```

Transitions are pure; I/O (LLM call, tool dispatch, message persistence,
event recording) is the driver's responsibility. This makes the loop
trivially testable end-to-end: feed scripted LLM results and verifier
results and assert the state sequence.

### 3.3 New modules to introduce

- `src/agents/contract.ts` — `Contract`, `ContractRegistry`,
  `DoneSignalForm`, `RepairFormat`.
- `src/agents/contract-verifier.ts` — same `Obligation` /
  `ObligationReport` types as P-A1, but `createContractVerifier` becomes a
  thin shim that delegates to `Contract.check`.
- `src/agents/agent-loop-state.ts` — the state types and pure transitions.
- `src/agents/agent-loop-driver.ts` — wires the state machine to
  `AgentSessionCoordinator`, `AgentToolExecutor`,
  `AgentLlmInvocationGateway`, and the verifier.
- `src/agents/done-signal-tool.ts` — as in P-A1, but the tool name and
  args schema come from `Contract.doneSignal`.
- `src/agents/invocation-outcome.ts` — as in P-A1.

### 3.4 Modules rewritten end-to-end (delete + replace)

- Everything in P-A1's delete list, plus:
- [src/agents/agent-adapter.ts](../../../../src/agents/agent-adapter.ts)
  — the `invokeAgent` body is rewritten around `AgentLoopDriver`. The
  public methods (`invokePlanner`, `invokeExecutor`, `invokeReviewer`,
  `reinvokeSession`, `callMcpTool`, etc.) keep their signatures because the
  supervisor and planner-control consumers depend on them; the
  implementations route through `ContractRegistry`.
- [src/agents/role-envelope-schemas.ts](../../../../src/agents/role-envelope-schemas.ts)
  — deleted as a runtime constant module. Its zod schemas move into the
  contract factory functions in `src/agents/contracts/`.
- [src/agents/llm-options-factory.ts](../../../../src/agents/llm-options-factory.ts)
  — the `LlmRolePhase` distinction (`'tools' | 'terminal'`) and the
  `'terminal'` branch at
  [llm-options-factory.ts#L23-L66](../../../../src/agents/llm-options-factory.ts#L23-L66)
  are deleted (latent machinery the hot path never used). `buildLlmOptions`
  takes only the role's tools plus the done-signal tool derived from the
  active `Contract`.
- The planner-control synthesis at
  [agent-adapter.ts#L347-L382](../../../../src/agents/agent-adapter.ts#L347-L382)
  — `PlannerControlExecutor` is rewritten to register its own
  *runtime-internal done signal handler* on the loop driver. When
  `activate_card` transfers control, the executor calls
  `driver.signalDone(envelope)` directly, which feeds the verifier the same
  proposed envelope an agent's `signal_done` call would. The adapter loses
  the special case.
- `AgentRoleRunner.applySelfCheck` at
  [agent-role-runner.ts#L34](../../../../src/agents/agent-role-runner.ts#L34)
  is deleted. Self-check responsibility moves into the contract's prompt
  builder (so prompt and contract cannot drift, addressing F07 by side
  effect). The system-prompt builders in
  [system-prompt.ts](../../../../src/agents/system-prompt.ts) are rewritten
  to read the done-signal definition from the active `Contract` rather than
  hand-writing "wrap it in a code block or return raw JSON".

### 3.5 Agent ↔ runtime repair conversation

Identical to P-A1 at the wire level (done signal → verifier → optional
repair message → repeat). The difference is that the loop driver mediates,
the transitions are explicit, and the contract — not the adapter — owns
the rendering of the repair message and the schema check.

A second, equivalent path exists for tool-less contracts (`doneSignal.kind ===
'message'`): a turn that returns `result.kind === 'message'` *with non-empty
content* is interpreted as the done signal, with `proposed` synthesised by
the contract's `project` callback (default: `{ content: result.content }`).
This is how analyst unification works without inventing a separate
adapter.

### 3.6 How "agent declares done" is signalled

For envelope-bearing roles: dedicated `signal_done` tool with the role's
envelope schema as the `result` argument, exactly as P-A1.

For analyst-style contracts: the absence of a tool call paired with non-
empty assistant content. The contract object distinguishes the two; the
driver does not.

### 3.7 Where the verifier lives and what it returns

`ContractVerifier` becomes a one-line adapter that calls `Contract.check`.
Every contract owns its own verifier. The adapter/driver only depends on
the abstract `Contract` interface; it does not know which schema is in play
for a given invocation. The per-issue verdict object is still `Obligation`
(code + locator + description + optional expected) and an `ObligationReport`
aggregates them.

### 3.8 Transport vs contract repair split

Identical to P-A1: `LlmTransportFailure` is the only thing the recovery
policy sees, `ContractViolation` (here surfaced through `Contract.check`'s
violated branch) never enters `LlmRequestError`. The driver enforces the
boundary: only LLM gateway exceptions can become transport failures, only
`Contract.check` results can become repair conditions.

### 3.9 Removal of the tactical mitigation

Same as P-A1: the inline mitigation at
[agent-adapter.ts#L302-L320](../../../../src/agents/agent-adapter.ts#L302-L320)
is deleted. In P-A2 it disappears in the larger adapter rewrite around the
driver; in P-A1 it disappears as a localised deletion in the same file.

---

## 4. Comparison

| Dimension | P-A1 (focused) | P-A2 (architectural) |
|---|---|---|
| Blast radius | `llm-failure.ts`, `llm-failure-classifiers.ts`, `invocation-recovery-policy.ts`, `terminal-protocol.ts` (deleted), `role-result-tools.ts` (deleted), inner loop of `agent-adapter.ts`, `PlannerControlExecutor` callback rewrite, `TERMINAL_TOOL_NAMES` callers. ~10 files. | Everything in P-A1 plus `role-envelope-schemas.ts` (deleted), `llm-options-factory.ts` (phase machinery deleted), `agent-adapter.ts` (full rewrite around driver), `agent-role-runner.ts` (self-check deleted), `system-prompt.ts` (prompts read from contract), new contract registry + state-machine modules. ~16-20 files. |
| Autonomy gain | High. Resolves F02, F03, F04, F09. Verifier-driven repair is in place, contract failures stop aborting, transport and semantics are split. | High plus: contract is per-invocation pluggable, analyst can join the loop with no new code path, planner-control activation is a first-class contract event rather than a special case. |
| Future extensibility | Medium. Adding a new role still requires touching the role enum and writing a schema. Per-invocation contract overrides require additional plumbing. Analyst unification (F-batch-C work) needs a parallel path. | High. Adding a new role is "write a `Contract` factory"; per-invocation overrides are a parameter; analyst unification is a contract whose `doneSignal.kind === 'message'`. Removes the hard-coded role -> tool-name map and the role -> schema map in one stroke (preparing the ground for F05 in a later batch). |
| Implementation cost | Lower. Touches fewer call sites, leaves `llm-options-factory.ts` and the role enum alone, leaves `AgentAdapter`'s public surface untouched. | Higher. State-machine driver, contract registry, schema migration into contract factories, prompt-builder rewrite. Substantially more test surface. |
| Residual debt | The role -> tool/schema/prompt fan-out remains hard-coded in three places (`ENVELOPE_SCHEMAS`, `buildPlannerPrompt`/`buildExecutorPrompt`/`buildReviewerPrompt`, the per-role done-signal schema lookup in `buildDoneSignalTool`). F05 and F07 are not addressed and will collide with this design when they are. The `LlmRolePhase` enum and the unused `'terminal'` branch in `llm-options-factory.ts` survive. The planner-control activation callback couples the adapter to the executor through a side channel. | Lower. The role -> contract mapping is the only fan-out and lives in one registry. `LlmRolePhase` is gone. The planner-control activation is uniform with agent-driven done. F05 and F07 collapse to "extend `ContractRegistry`". |

---

## 5. Recommendation

**Adopt P-A2.**

The brief explicitly invites "one conceptual level up" and flags analyst
unification as an option to take if it materially simplifies the design.
P-A2 does both. The four issues in scope (F02, F03, F04, F09) reduce to
contract-layer concerns that the verifier owns, and the architectural moves
(per-invocation `Contract`, explicit loop driver, prompt-from-contract)
collapse three separate maps (role -> tool name, role -> schema, role ->
prompt) into one registry. That removes the structural pressure behind F05
("hardcoded role taxonomy") and F07 ("system prompt misaligned with runtime
contract") before those batches even start, so Batch B and Batch C inherit
a smaller surface to redesign.

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
  structured surface.

- **Have the verifier produce a `LlmFailure { kind: 'contract_violation'
  }` that flows through `decideFailure` with a contract-specific arm.**
  Rejected: this preserves the type-level conflation F04 calls out. The
  whole point of the failure split is that the recovery policy never sees
  a semantic failure. A "contract" arm in `decideFailure` would attract
  transport-policy thinking (cooldowns, candidate-health updates) that
  does not apply to contract repair.

- **Cross-candidate repair handoff** (failed repair on candidate A is
  retried on candidate B, carrying the obligation report with it).
  Rejected for this batch: the open question in the analysis (4.4) lists
  it as one valid resolution for repeated identical reports, but it
  requires the contract layer to own its own candidate-rotation policy,
  which duplicates the transport layer's. The chosen resolution is
  `repair_exhausted` as a terminal state; cross-candidate handoff is left
  as a future enhancement that can be added without re-architecting the
  verifier.
