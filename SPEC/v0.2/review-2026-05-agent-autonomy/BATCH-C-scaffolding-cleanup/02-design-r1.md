# Batch C — Scaffolding Cleanup: Design

Scope: implementation-level design that resolves F01 (per-turn phase
machinery), F08 (overlapping budgets), and F10 (`invokeAgent` god method).
Two proposals are presented (P-C1 focused, P-C2 architectural) followed by
a comparison, a recommendation, and rejected alternatives. All paths are
workspace-relative to `saivage-v3/`.

---

## 0. Assumptions about Batches A and B

This batch must compose with the contract-verifier work without depending on
which variant Batches A/B ultimately ship. The collaborator boundaries below
were chosen so that any of the following Batch A/B outcomes drops into the
same shape with a single import swap.

A1. **Per-invocation `Contract` value.** Batch B defines a value carrying
    the terminal-tool definition(s), the schema, a `verify(toolCall) ->
    Result | Violation` predicate, and a `project(envelope) -> Typed`
    function. Batch C consumes this value through a single import
    (`Contract` from `src/contracts/contract.ts` or equivalent). If Batch B
    keeps a thin `ContractTerminalDescriptor` + separate verifier
    function, the `ContractVerifier` collaborator below adapts by holding
    both as fields. The boundary is the `Contract` type symbol, not its
    internal shape.

A2. **Explicit done signal.** Batch A treats one dedicated tool call (a
    `signal_done` / `submit_result` / `emit_*_result` family member,
    enumerated by the contract) as the success exit. Batch C names the same
    tool through `contract.terminalToolNames()` and treats any other tool
    call as in-progress traffic; the loop never inspects tool names
    directly.

A3. **`ObligationReport` verifier output.** Batch A's verifier returns
    either a typed `Envelope`, an `ObligationReport` (structured
    non-compliance to be rendered as a `model_repair` row), or a
    `RepairExhausted` terminal diagnostic. Batch C's `ContractVerifier`
    collaborator returns the same three-way value through a typed
    discriminated union (`VerifierOutcome` below). If Batch A ships a
    different name for the union, the alias is a one-line rename here.

A4. **Deferred activation as a terminal signal.** Batch B Position C dissolves
    the deferred-`activate_card` synthesis into a first-class terminal
    envelope on the planner contract. Batch C therefore removes the
    synthesis branch from the conversation loop entirely; if Batch B
    instead lands Position A/B and keeps the synthesis as a runtime concern,
    it moves into `PlannerControlExecutor` (the planner-control tool dispatch
    surface), still out of the verifier. Either way the conversation loop
    never branches on `tc.function.name === 'activate_card'`.

A5. **Failure-type split.** Batch A deletes `contract_mismatch` from
    `LlmFailure` and introduces `LlmTransportFailure`. Batch C's
    `InvocationAttemptRecorder` consumes only the transport failure type;
    the verifier outcomes do not flow through `LlmRequestError`. If Batch
    A's split is not yet merged at implementation time, this batch
    introduces a thin `isTransportFailure(failure)` discriminator at the
    recorder boundary so the unified `LlmFailure` is filtered at one point.

Assumptions explicitly *not* made:

- Whether the contract registry is per-role-string or per-`Contract`-value.
- Whether `ObligationReport` is a free-form string or a structured array of
  `Obligation` items.
- Whether `signal_done` is one tool or a small family — this batch only
  needs `contract.terminalToolNames()` returning a non-empty `string[]`.

---

## 1. Design goal

Concrete restatement:

1. **F01.** Delete every site that distinguishes a `'tools'` phase from a
   `'terminal'` phase. The runtime ships one options shape, one tool list,
   and one transport path. The terminal-tool *name* survives as data on the
   contract value (Batch B), never as a discriminator on per-turn options.
2. **F08.** Replace four overlapping counters (`maxToolTurns`,
   `maxRecoveryRetries`, `recoveryDelayMs`-as-`retry_same_after_delay`,
   `sameCandidateRecoveryAttempt`) with three orthogonal named budgets
   owned by three distinct layers: free-turn budget (verifier), repair-round
   budget (verifier), transport-retry budget (recovery harness). The
   `contract_mismatch`-routes-through-`fail_invocation`-routes-through-outer-replay
   pathway is dissolved; contract outcomes are values, not exceptions.
3. **F10.** Replace `AgentAdapter.invokeAgent`
   ([agent-adapter.ts#L225-L497](../../../../src/agents/agent-adapter.ts#L225-L497))
   with a ~40-line orchestrator that composes named collaborators. Each
   collaborator owns one concern (plan construction, candidate resolution,
   session lifecycle, conversation execution, attempt recording, outcome
   projection). Status-to-lifecycle projection becomes a function keyed by
   the contract value, not by `role === 'planner'` string comparisons.

The decomposition must remain compatible with Batches A/B (see §0) while
making zero assumptions that lock it into either of their variants.

---

## 2. Proposal P-C1 — Focused fix

A direct decomposition along the responsibility boundaries already named
in the analysis. Each collaborator is an injected class; the orchestrator
wires them. No state machine, no Sans-IO indirection.

### 2.1 F01 — exact deletions and replacements

The terminal-phase scaffolding is deleted with no shim. Replacement
references point at constructs that already exist or are introduced in
§2.3.

| Symbol | File | Lines | Action | Replacement |
| --- | --- | --- | --- | --- |
| `LlmRolePhase` type | [src/agents/llm-options-factory.ts](../../../../src/agents/llm-options-factory.ts) | 13 | delete | none — phase concept is gone |
| `if (phase === 'tools') { ... }` branch | [src/agents/llm-options-factory.ts](../../../../src/agents/llm-options-factory.ts) | 35-44 | inline as the only body of `buildLlmOptions` | new signature in §2.1 below |
| terminal-phase branch | [src/agents/llm-options-factory.ts](../../../../src/agents/llm-options-factory.ts) | 45-64 | delete | none |
| `deriveTerminalTool(opts)` | [src/agents/llm-options-factory.ts](../../../../src/agents/llm-options-factory.ts) | 66-69 | delete | `contract.terminalToolNames()` (Batch B) |
| `LlmCompleteOptionsTerminal` interface | [src/agents/llm-contracts.ts](../../../../src/agents/llm-contracts.ts) | 42-54 (terminal arm) | delete | none — `LlmCompleteOptions` becomes a non-discriminated record |
| `LlmCompleteOptionsTools` interface | [src/agents/llm-contracts.ts](../../../../src/agents/llm-contracts.ts) | 42-54 (tools arm) | rename + flatten | `LlmCompleteOptions` (sole shape) |
| `opts.phase === 'terminal'` branch | [src/agents/llm-provider-gateway.ts](../../../../src/agents/llm-provider-gateway.ts) | 42 | delete | tools list reads `opts.tools` unconditionally |
| `opts.phase === 'terminal'` branch | [src/agents/llm-openai-chat-gateway.ts](../../../../src/agents/llm-openai-chat-gateway.ts) | 183-187 | delete | tools list reads `opts.tools` unconditionally |
| `opts.phase === 'terminal'` branch | [src/agents/llm-openai-codex-gateway.ts](../../../../src/agents/llm-openai-codex-gateway.ts) | 122-127 | delete | tools list reads `opts.tools` unconditionally |
| first arm of `deriveTerminalToolFromOptions` | [src/agents/llm-recording.ts](../../../../src/agents/llm-recording.ts) | 64-66 | delete | second arm becomes the whole body |
| `agent-adapter.ts` per-turn `buildLlmOptions(role, 'tools', turnTools, ...)` call | [src/agents/agent-adapter.ts](../../../../src/agents/agent-adapter.ts) | 295-300 | rewrite | `buildLlmOptions({ tools: contract.augmentTools(tools), modelParams, signal })` inside `ConversationRunner` |
| `terminalToolName` / `terminalToolDef` per-turn re-derivation | [src/agents/agent-adapter.ts](../../../../src/agents/agent-adapter.ts) | 292-296 | delete | derived once via `contract` on `AgentInvocationPlan` |
| `probe-llm-contract.ts` `'terminal'` branch | [src/scripts/probe-llm-contract.ts](../../../../src/scripts/probe-llm-contract.ts) | 86-90 | delete | probe collapses to a single round-trip exercising the contract value |
| direct `{ phase: 'terminal' }` test construction | [tests/agents/llm-openai-chat-gateway-request.test.ts](../../../../tests/agents/llm-openai-chat-gateway-request.test.ts) | 48 | rewrite | single-shape options object; test asserts the single tool-list path |
| direct `{ phase: 'terminal' }` test construction | [tests/agents/llm-openai-codex-gateway-request.test.ts](../../../../tests/agents/llm-openai-codex-gateway-request.test.ts) | 48 | rewrite | same as above |

What survives unchanged:

- `TERMINAL_TOOL_NAMES` and `TerminalToolName` in
  [src/contracts/llm-exchange.ts#L35-L36](../../../../src/contracts/llm-exchange.ts#L35-L36).
  These are the names of the result-emitting tools; Batch B exposes them via
  `contract.terminalToolNames()` but the constants stay as the canonical
  string source.

New `buildLlmOptions` signature:

```ts
// src/agents/llm-options-factory.ts (rewritten body)

import type { LlmCompleteOptions, LlmToolDefinition } from './llm-contracts.js';
import type { LlmExchangeRecorder } from './llm-recording.js';

export interface BuildLlmOptionsInput {
  tools: LlmToolDefinition[];
  modelParams: { temperature?: number; max_tokens?: number };
  signal: AbortSignal;
  recorder?: LlmExchangeRecorder;
}

export function buildLlmOptions(input: BuildLlmOptionsInput): LlmCompleteOptions {
  return {
    tools: input.tools,
    toolChoice: { kind: 'auto' },
    temperature: input.modelParams.temperature,
    maxTokens: input.modelParams.max_tokens,
    abortSignal: input.signal,
    recorder: input.recorder,
  };
}
```

`LlmCompleteOptions` collapses to a single non-discriminated record:

```ts
// src/agents/llm-contracts.ts (terminal arm deleted, tools arm flattened)

export interface LlmToolChoice { kind: 'auto' | 'required_named'; name?: string }

export interface LlmCompleteOptions {
  tools: LlmToolDefinition[];
  toolChoice: LlmToolChoice;
  temperature?: number;
  maxTokens?: number;
  abortSignal: AbortSignal;
  recorder?: LlmExchangeRecorder;
}
```

The `required_named` variant of `LlmToolChoice` is kept because the
transports still emit it on the wire when a future contract wants
forced-tool turns; it is no longer a discriminator on the options object.

### 2.2 F08 — three-axis budget model

The three runtime-config knobs replace the existing four:

| New knob | Owner | Replaces | Default | Counter visible on which event |
| --- | --- | --- | --- | --- |
| `maxAgentTurns` | `ContractVerifier` (axis 1) | `maxToolTurns` ([agent-adapter.ts#L297](../../../../src/agents/agent-adapter.ts#L297)) | 16 | `llm_attempt.turns_used` (new field on the existing per-attempt payload) |
| `maxRepairRounds` | `ContractVerifier` (axis 2) | `sameCandidateRecoveryAttempt` ([agent-adapter.ts#L278](../../../../src/agents/agent-adapter.ts#L278)) + `parse_error` arm of `retry_same_after_delay` ([invocation-recovery-policy.ts#L131-L138](../../../../src/agents/invocation-recovery-policy.ts#L131-L138)) | 3 | `llm_attempt.repair_rounds_used` (new field) |
| `maxTransportRetries` | `invokeWithRecovery` (axis 3) | `maxRecoveryRetries` ([recovery.ts#L97](../../../../src/agents/recovery.ts#L97)) | 3 | `llm_invocation_summary.attempts_count` (already exists, derived from `InvocationAttempt[]` length) |
| `transportRetryDelayMs` | `invokeWithRecovery` (axis 3) | `recoveryDelayMs` ([recovery.ts#L174](../../../../src/agents/recovery.ts#L174)) | 60000 | not separately surfaced; consumed inline |

The fourth current concept (`recoveryDelayMs` used as the per-attempt
`retryDelayMs` for `retry_same_after_delay` at
[invocation-recovery-policy.ts#L138](../../../../src/agents/invocation-recovery-policy.ts#L138))
is **deleted** in this design: contract violations no longer go through
the recovery policy. Transport-side `parse_error` (HTTP body malformed)
keeps a same-candidate retry, but under the renamed
`transportRetryDelayMs` and only via axis 3.

Per-axis failure-class table — who increments what under each failure class
in the new model:

| Failure class | Where it surfaces | Axis 1 (`maxAgentTurns`) | Axis 2 (`maxRepairRounds`) | Axis 3 (`maxTransportRetries`) | Visible result |
| --- | --- | --- | --- | --- | --- |
| `auth_permanent` | transport | n/a | n/a | does **not** consume; immediate failover to next candidate | candidate failover, `llm_attempt.outcome=failed`, no replay |
| `capability_mismatch` | transport | n/a | n/a | does not consume; immediate failover | candidate failover |
| `rate_limit` | transport | n/a | n/a | does not consume; cooldown + failover | candidate failover |
| `server_transient` / `timeout` | transport | n/a | n/a | does not consume; cooldown + failover | candidate failover |
| `provider_protocol_error` (replaces opencode-go-laundered `contract_mismatch{unknown}`; defined in Batch A §2.1.1) | transport | n/a | n/a | +1 axis 3, full `agentFn` replay on a fresh candidate chain | outer replay |
| `parse_error` (transport-body parse, *not* terminal-tool args) | transport | n/a | n/a | +1 axis 3, full replay | outer replay |
| `token_budget_exceeded` | transport | n/a | n/a | does not consume; failover | candidate failover |
| `cancelled` | transport | n/a | n/a | does not consume; abort, no replay | abort |
| `envelope_missing_at_done_signal` (Batch A `Obligation` code) | verifier | n/a | +1 axis 2; verifier renders `ObligationReport` as `model_repair` row, conversation continues on the same candidate | n/a | repair round, possibly success |
| `envelope_invalid_json` | verifier | n/a | +1 axis 2 | n/a | repair round |
| `envelope_schema_violation` | verifier | n/a | +1 axis 2 | n/a | repair round |
| `terminal_tool_args_invalid_json` (was `LlmRequestError{contract_mismatch/tool_arguments_invalid_json}`) | verifier | n/a | +1 axis 2 | n/a | repair round |
| `max_repair_rounds_exhausted` | verifier (terminal) | n/a | budget hit | n/a | verifier returns `RepairExhausted`; orchestrator marks invocation `failed` with `verdict='repair_exhausted'`, no axis 3 replay |
| `max_agent_turns_exhausted` | verifier (terminal) | budget hit | n/a | n/a | verifier returns `TurnsExhausted`; orchestrator marks invocation `failed` with `verdict='turns_exhausted'`, no axis 3 replay |
| no candidates resolved | candidate resolver | n/a | n/a | does not consume; abort, no replay | abort |
| plain message during a contract-bearing turn | not a failure | +1 axis 1 (the LLM call counts as a turn) | n/a | n/a | conversation continues; the inline `model_repair` nudge from commit `a2a6f05` ([agent-adapter.ts#L304-L320](../../../../src/agents/agent-adapter.ts#L304-L320)) is **deleted** — plain messages become normal in-progress traffic per Batch A §1 |
| non-terminal tool batch | not a failure | +1 axis 1 | n/a | n/a | tool results persisted, conversation continues |
| terminal tool call without `signal_done` semantics (Batch A) | not a failure | +1 axis 1 | n/a | n/a | non-result tool; treated like above |

Three structural problems from the analysis are dissolved by this table:

1. The same-candidate counter no longer rides the generic `attempt` field
   in `InvocationRecoveryContext`. The policy sees only axis-3 retries; its
   `attempt` field means exactly "transport retries used so far".
2. `contract_mismatch` no longer exists as a recovery-policy class. The
   verifier handles all contract outcomes as values; the inline `throw
   lastError` ([agent-adapter.ts#L447-L450](../../../../src/agents/agent-adapter.ts#L447-L450))
   on `decision.abort` for contract failures is deleted because no
   contract failure produces an exception.
3. `max_agent_turns_exhausted` is a first-class `verdict` value on
   `llm_invocation_summary`. The synthetic
   `contract_mismatch{terminal_tool_missing}` exception at
   [agent-adapter.ts#L386](../../../../src/agents/agent-adapter.ts#L386) is
   deleted with no replacement.

Runtime-config schema changes (single coordinated edit in
`src/agents/config-schema.ts` and any zod schema mirroring it):

- Remove: `maxToolTurns`, `maxRecoveryRetries`.
- Add: `maxAgentTurns`, `maxRepairRounds`, `maxTransportRetries`,
  `transportRetryDelayMs`.
- Keep: anything else on `RuntimeSection`.

### 2.3 F10 — `invokeAgent` decomposition (TypeScript signatures)

Six collaborator types. Each is a class with one public entry point unless
noted; all are constructor-injected into `AgentAdapter`. The signatures
below compile in isolation against the existing exports (`Candidate`,
`AgentRole`, `AgentMessage`, `AgentSession`, `LlmTransportFailure`,
`LlmAttemptPayload`, `LlmInvocationSummaryPayload`, `SessionStatus`,
`Contract`, `ObligationReport` — the last two come from Batches A/B).

#### 2.3.1 `AgentInvocationPlan`

Pure-data record built once per call. Owns capability request, resolved
tool list, model params, system prompt (with self-check already applied),
the contract value, and the two intra-conversation budgets. Does *not*
own a candidate chain (per analysis r2 review finding 2).

```ts
// src/agents/agent-invocation-plan.ts

import type { CapabilityRequest } from './provider-capabilities.js';
import type { LlmToolDefinition } from './llm-contracts.js';
import type { Contract } from '../contracts/contract.js';
import type { AgentRole } from '../schemas/index.js';

export interface AgentInvocationPlan {
  readonly role: AgentRole;
  readonly goalId: string;
  readonly cardId: string;
  readonly sessionId: string;
  readonly systemPrompt: string;
  readonly tools: readonly LlmToolDefinition[];
  readonly capabilityRequest: CapabilityRequest;
  readonly modelParams: { temperature?: number; maxTokens?: number };
  readonly contract: Contract;
  readonly budgets: {
    readonly maxAgentTurns: number;
    readonly maxRepairRounds: number;
  };
}
```

Replaces analysis items 1, 2, 5.

#### 2.3.2 `CandidateResolver`

Single authority for `router.resolve` + capability-skip snapshot. Returns
both atomically; downstream code never re-reads `router.getLastCapabilitySkips()`.

```ts
// src/agents/candidate-resolver.ts

import type { Candidate } from './provider.js';
import type { ModelRouter } from './model-router.js';
import type { CapabilityRequest, CapabilitySkipDiagnostic } from './provider-capabilities.js';
import type { AgentRole } from '../schemas/index.js';

export interface CandidateChain {
  readonly candidates: readonly Candidate[];
  readonly capabilitySkips: readonly CapabilitySkipDiagnostic[];
  readonly resolvedAt: number;
}

export class CandidateResolver {
  constructor(private readonly router: ModelRouter) {}

  async resolve(role: AgentRole, request: CapabilityRequest): Promise<CandidateChain> {
    const candidates = await this.router.resolve(role, request);
    const capabilitySkips = this.router.getLastCapabilitySkips() ?? [];
    return { candidates, capabilitySkips: capabilitySkips.slice(), resolvedAt: Date.now() };
  }
}
```

Replaces analysis items 3 and 9, and centralises the four
`getLastCapabilitySkips()` reads ([L243](../../../../src/agents/agent-adapter.ts#L243),
[L270](../../../../src/agents/agent-adapter.ts#L270),
[L395](../../../../src/agents/agent-adapter.ts#L395),
[L431](../../../../src/agents/agent-adapter.ts#L431)) into the one read
inside `resolve`. The snapshot travels through `ConversationRunner` and
`InvocationAttemptRecorder` as data, eliminating the concurrency hazard
flagged in analysis §3.1.

#### 2.3.3 `AgentSessionLifecycle`

Owns session creation, the single-active-session assertion, lifecycle
events, abort-controller tracking, cancellation polling, and the
post-invocation `markSessionWaiting` / `completeSession` projection.
Absorbs the existing `AgentSessionCoordinator` plus the inline
`createSession` / `assertNoActiveAgentSession` / `persistFailure` closure
currently at [agent-adapter.ts#L249-L256](../../../../src/agents/agent-adapter.ts#L249-L256).

```ts
// src/agents/agent-session-lifecycle.ts

import type { AgentMessage, AgentRole, AgentSession, HandoffSummary, SessionStatus } from '../schemas/index.js';
import type { NotificationCenter } from '../notifications/index.js';
import type { EventEmitter } from 'node:events';
import type { EventLogger } from '../observability/index.js';

export interface SessionStartInput {
  readonly role: AgentRole;
  readonly goalId: string;
  readonly cardId: string;
  readonly requestedSessionId?: string;
  readonly contextMessages: readonly AgentMessage[];
}

export interface SessionRuntime {
  readonly session: AgentSession;
  isCancelled(): boolean;
  trackAbort(controller: AbortController): void;
  clearAbort(): void;
  buildModelMessages(): AgentMessage[];
  persistFailureNote(message: string, attempt: number): void;
  finalize(status: SessionStatus): void;
  getHandoffSummary(): HandoffSummary | null;
}

export class AgentSessionLifecycle {
  constructor(opts: {
    saivageDir: string;
    notificationCenter: NotificationCenter;
    eventBus?: EventEmitter;
    eventLogger?: EventLogger;
  });

  start(input: SessionStartInput): Promise<SessionRuntime>;
  cancel(sessionId: string): boolean;
  forceCancel(sessionId: string): boolean;
  getActiveHandoffs(): HandoffSummary[];
}
```

Replaces analysis items 4, 6, 7-partial, 11, and the post-invocation
half of item 23 (lifecycle transitions; the role-to-status projection
itself lives in `InvocationOutcomeProjector`).

#### 2.3.4 `ConversationRunner` (a.k.a. `ContractVerifier` per-attempt host)

Owns the per-candidate intra-conversation loop. One `run()` call drives
one candidate from the first LLM turn until the verifier returns a
terminal outcome or a transport failure escapes. Internally composes the
verifier (Batch A) and the tool executor.

```ts
// src/agents/conversation-runner.ts

import type { Candidate } from './provider.js';
import type { AgentInvocationPlan } from './agent-invocation-plan.js';
import type { SessionRuntime } from './agent-session-lifecycle.js';
import type { AgentToolExecutor } from './agent-tool-executor.js';
import type { LlmCallFn } from './llm-contracts.js';
import type { ContractVerifier, VerifierOutcome } from './contract-verifier.js';

export interface ConversationOutcome<Envelope> {
  readonly kind:
    | { tag: 'success'; envelope: Envelope; terminalToolName: string; turnsUsed: number; repairRoundsUsed: number }
    | { tag: 'turns_exhausted'; turnsUsed: number; repairRoundsUsed: number }
    | { tag: 'repair_exhausted'; turnsUsed: number; repairRoundsUsed: number; finalReport: import('./contract-verifier.js').ObligationReport };
}

export class ConversationRunner {
  constructor(opts: {
    llmCallFn: LlmCallFn;
    toolExecutor: AgentToolExecutor;
    verifier: ContractVerifier;
  });

  run<Envelope>(
    plan: AgentInvocationPlan,
    candidate: Candidate,
    session: SessionRuntime,
  ): Promise<ConversationOutcome<Envelope>>;
}
```

The runner owns analysis items 12-15, 18 (as `turns_exhausted` outcome),
19 (final-envelope persistence). Item 13 (the `a2a6f05` plain-message
nudge) is deleted; plain messages are normal in-progress traffic per
Batch A §1. Item 17 (deferred-activation envelope synthesis) is removed
from the runner per assumption A4; if Batch B does not dissolve it into
the contract, the planner-control side does the synthesis inside
`AgentToolExecutor` and returns a tool result that the runner treats
opaquely.

`VerifierOutcome` is the Batch A discriminated union; this batch references
it but does not define it. It carries either an `Envelope`, an
`ObligationReport` (the verifier renders it into `model_repair`
internally), or a `RepairExhausted` terminal.

#### 2.3.5 `InvocationAttemptRecorder`

Lives inside the outer recovery loop. Owns `llm_attempt` event emission
(success + failure), `decideSuccess` / `decideFailure` policy calls (now
only seeing `LlmTransportFailure`), candidate-availability marking,
`model_issue` / `model_recovered` row persistence, retry-delay sleep, and
the abort-vs-continue decision.

```ts
// src/agents/invocation-attempt-recorder.ts

import type { Candidate } from './provider.js';
import type { LlmTransportFailure } from './llm-failure.js';
import type { CandidateAvailability } from './candidate-availability.js';
import type { InvocationRecoveryPolicy } from './invocation-recovery-policy.js';
import type { CandidateChain } from './candidate-resolver.js';
import type { SessionRuntime } from './agent-session-lifecycle.js';
import type { AgentInvocationPlan } from './agent-invocation-plan.js';
import type { LlmAttemptPayload, LlmFailureClass } from '../schemas/index.js';
import type { ConversationOutcome } from './conversation-runner.js';
import type { EventEmitter } from 'node:events';
import type { EventLogger } from '../observability/index.js';

export interface AttemptStart {
  readonly attemptNumber: number;
  readonly maxAttempts: number;
  readonly candidate: Candidate;
  readonly chain: CandidateChain;
  readonly startedAtMs: number;
}

export interface AttemptDirective {
  readonly action: 'continue_same_candidate' | 'next_candidate' | 'replay_outer' | 'abort';
  readonly cooldownMs?: number;
  readonly retryDelayMs?: number;
}

export class InvocationAttemptRecorder {
  constructor(opts: {
    policy: InvocationRecoveryPolicy;
    availability: CandidateAvailability;
    eventLogger?: EventLogger;
    eventBus?: EventEmitter;
  });

  recordSuccess<Envelope>(
    plan: AgentInvocationPlan,
    session: SessionRuntime,
    start: AttemptStart,
    outcome: Extract<ConversationOutcome<Envelope>['kind'], { tag: 'success' }>,
  ): Promise<LlmAttemptPayload>;

  recordTransportFailure(
    plan: AgentInvocationPlan,
    session: SessionRuntime,
    start: AttemptStart,
    failure: LlmTransportFailure,
    error: Error,
  ): Promise<{ payload: LlmAttemptPayload; directive: AttemptDirective; lastFailureClass: LlmFailureClass }>;

  recordVerifierTerminal<Envelope>(
    plan: AgentInvocationPlan,
    session: SessionRuntime,
    start: AttemptStart,
    outcome:
      | Extract<ConversationOutcome<Envelope>['kind'], { tag: 'turns_exhausted' }>
      | Extract<ConversationOutcome<Envelope>['kind'], { tag: 'repair_exhausted' }>,
  ): Promise<LlmAttemptPayload>;

  injectRecoveryDirective(session: SessionRuntime, directive: string): void;
}
```

Replaces analysis items 8, 20, 21, the `attemptOutcomeCount` parallel
counter at [agent-adapter.ts#L258](../../../../src/agents/agent-adapter.ts#L258)
(derived from `InvocationAttempt[]` length per analysis §3.2), and the
six redaction sites at the message-persistence boundary.

#### 2.3.6 `InvocationOutcomeProjector`

Given the `InvocationAttempt[]` array from `invokeWithRecovery` and the
contract value, builds the `llm_invocation_summary` event and applies the
status-to-session-lifecycle projection. The role-to-lifecycle table moves
here as an explicit function on the contract.

```ts
// src/agents/invocation-outcome-projector.ts

import type { InvocationAttempt } from './recovery.js';
import type { Contract } from '../contracts/contract.js';
import type { AgentInvocationPlan } from './agent-invocation-plan.js';
import type { SessionRuntime } from './agent-session-lifecycle.js';
import type { LlmInvocationSummaryPayload, SessionStatus } from '../schemas/index.js';
import type { EventEmitter } from 'node:events';
import type { EventLogger } from '../observability/index.js';

export type InvocationVerdict =
  | 'succeeded'
  | 'turns_exhausted'
  | 'repair_exhausted'
  | 'transport_exhausted'
  | 'cancelled';

export interface InvocationOutcome<Result> {
  readonly verdict: InvocationVerdict;
  readonly result?: Result;
  readonly summary: LlmInvocationSummaryPayload;
  readonly sessionStatus: SessionStatus;
  readonly error?: Error;
}

export class InvocationOutcomeProjector {
  constructor(opts: { eventLogger?: EventLogger; eventBus?: EventEmitter });

  project<Result>(
    plan: AgentInvocationPlan,
    session: SessionRuntime,
    attempts: readonly InvocationAttempt[],
    invocationStartMs: number,
  ): InvocationOutcome<Result>;
}
```

The verdict-to-status mapping is driven by `plan.contract.projectStatus(
typedResult)`, where each contract (planner, executor, reviewer) exports
its own pure function returning a `SessionStatus`. This deletes the
`if (role === 'planner' && resultStatus === 'continue') ...` ladder at
[agent-adapter.ts#L484-L495](../../../../src/agents/agent-adapter.ts#L484-L495)
and answers open question §4.4 from the analysis (reviewer arm): the
reviewer contract explicitly returns `'done'` for any successful
assessment unless the contract author overrides.

Replaces analysis items 22 and 23.

### 2.4 Top-level orchestration

`AgentAdapter.invokeAgent` becomes the following. The body is a
straight-line composition; no per-turn logic appears here.

```ts
// src/agents/agent-adapter.ts (rewritten invokeAgent body, ~40 lines)

private async invokeAgent<Result>(
  role: AgentRole,
  goalId: string,
  cardId: string,
  systemPrompt: string,
  contextMessages: AgentMessage[],
  contract: Contract,
  requestedSessionId?: string,
): Promise<Result> {
  if (!this.llmCallFn) throw new Error('No LLM call function registered.');

  this.roleRunner.resetOnRoleChange(role);
  const modelParams = getModelParamsForRole(this.config, role);
  const tools = this.toolExecutor.buildToolsForRole(role);
  const capabilityRequest = capabilityRequestForLlmOptions({
    tools: contract.augmentTools(tools), stream: false,
  });

  const preflight = await this.candidateResolver.resolve(role, capabilityRequest);
  if (preflight.candidates.length === 0) {
    throw new Error(this.policy.decideNoCandidates(...).message);
  }

  const sessionRuntime = await this.sessionLifecycle.start({
    role, goalId, cardId, requestedSessionId, contextMessages,
  });

  const plan: AgentInvocationPlan = {
    role, goalId, cardId,
    sessionId: sessionRuntime.session.id,
    systemPrompt: this.roleRunner.applySelfCheck(role, systemPrompt, sessionRuntime.session.id),
    tools: contract.augmentTools(tools),
    capabilityRequest, modelParams,
    contract,
    budgets: {
      maxAgentTurns: this.runtimeConfig.maxAgentTurns ?? 16,
      maxRepairRounds: this.runtimeConfig.maxRepairRounds ?? 3,
    },
  };

  const invocationStart = Date.now();
  const attempts = await invokeWithRecovery(async (recoveryCtx) => {
    const chain = await this.candidateResolver.resolve(role, capabilityRequest);
    if (chain.candidates.length === 0) {
      throw new Error(this.policy.decideNoCandidates(...).message);
    }
    for (const candidate of chain.candidates) {
      if (!this.candidateAvailability.isAvailable(candidate)) continue;
      const start: AttemptStart = {
        attemptNumber: recoveryCtx.attempt,
        maxAttempts: recoveryCtx.maxAttempts,
        candidate, chain, startedAtMs: Date.now(),
      };
      try {
        const outcome = await this.conversationRunner.run<Result>(plan, candidate, sessionRuntime);
        if (outcome.kind.tag === 'success') {
          await this.attemptRecorder.recordSuccess(plan, sessionRuntime, start, outcome.kind);
          return plan.contract.project(outcome.kind.envelope) as Result;
        }
        await this.attemptRecorder.recordVerifierTerminal(plan, sessionRuntime, start, outcome.kind);
        throw new InvocationVerifierTerminalError(outcome.kind);
      } catch (err) {
        if (err instanceof InvocationVerifierTerminalError) throw err;
        const failure = unwrapTransportFailure(err);
        const { directive } = await this.attemptRecorder.recordTransportFailure(plan, sessionRuntime, start, failure, err as Error);
        if (directive.action === 'abort') throw err;
        if (directive.action === 'next_candidate') continue;
        if (directive.action === 'continue_same_candidate') { /* delay handled by recorder */ continue; }
        if (directive.action === 'replay_outer') throw err;
      }
    }
    throw new Error(`All candidates exhausted for role '${role}'.`);
  }, {
    maxRetries: this.runtimeConfig.maxTransportRetries ?? 3,
    recoveryDelayMs: this.runtimeConfig.transportRetryDelayMs ?? 60000,
    publishEvents: true, eventBus: this.eventBus,
    sessionId: sessionRuntime.session.id, goalId, cardId, agentRole: role,
    persistFailure: (err, attempt) => sessionRuntime.persistFailureNote(err.message, attempt),
  });

  const outcome = this.outcomeProjector.project<Result>(plan, sessionRuntime, attempts, invocationStart);
  sessionRuntime.finalize(outcome.sessionStatus);
  if (outcome.verdict === 'succeeded' && outcome.result !== undefined) return outcome.result;
  throw outcome.error ?? new Error(`Agent '${role}' invocation failed with verdict '${outcome.verdict}'.`);
}
```

Public `invokePlanner` / `invokeExecutor` / `invokeReviewer` change only in
that they now pass the contract value instead of a `parseEnvelope` callback:

```ts
async invokePlanner(req: PlannerInvocationRequest): Promise<PlannerResult> {
  return this.invokeAgent('planner', req.goalId, req.goalId,
    req.systemPrompt ?? '', req.contextMessages ?? [],
    plannerContract, // from Batch B
  );
}
```

The three `envelopeTo*Result` helpers at
[agent-adapter.ts#L49-L62](../../../../src/agents/agent-adapter.ts#L49-L62)
are deleted; each contract owns its own `project()`.

---

## 3. Proposal P-C2 — One conceptual level up

A small, explicit state machine drives the per-attempt conversation. The
collaborators from P-C1 survive, but `ConversationRunner` becomes a
pure-data step function over an `AttemptState`, and a thin `AttemptDriver`
loops over it. The motivation is that the per-attempt loop has three
genuinely orthogonal axes (turn budget, repair budget, tool dispatch) that
P-C1 keeps interleaved inside one method body; the state machine names
each transition.

### 3.1 The `AttemptState` value

```ts
// src/agents/attempt-state.ts

import type { AgentMessage, MessageKind, MessageRole } from '../schemas/index.js';
import type { ObligationReport } from './contract-verifier.js';

export type AttemptPhase =
  | { tag: 'awaiting_llm' }
  | { tag: 'awaiting_tool_results'; toolCalls: PendingToolCall[] }
  | { tag: 'awaiting_repair_reply'; report: ObligationReport }
  | { tag: 'terminal'; result: AttemptTerminal };

export interface PendingToolCall {
  readonly id: string;
  readonly name: string;
  readonly argsJson: string;
}

export type AttemptTerminal<Envelope = unknown> =
  | { kind: 'success'; envelope: Envelope; terminalToolName: string }
  | { kind: 'turns_exhausted' }
  | { kind: 'repair_exhausted'; finalReport: ObligationReport }
  | { kind: 'transport_failure'; error: Error };

export interface AttemptState {
  readonly phase: AttemptPhase;
  readonly turnsUsed: number;
  readonly repairRoundsUsed: number;
  readonly pendingPersist: readonly { role: MessageRole; kind: MessageKind; content: string }[];
}
```

### 3.2 Step function and effects

A pure step function takes `(state, event) -> (state, effects)`. Effects
are an explicit list (call LLM, run tool, persist message, write
`model_repair`). The `AttemptDriver` executes effects against injected
ports.

```ts
// src/agents/attempt-step.ts

import type { AttemptState } from './attempt-state.js';
import type { AgentInvocationPlan } from './agent-invocation-plan.js';
import type { Contract, VerifierOutcome } from '../contracts/contract.js';
import type { LlmCompleteResult } from './llm-contracts.js';

export type AttemptEvent =
  | { tag: 'start' }
  | { tag: 'llm_reply'; reply: LlmCompleteResult }
  | { tag: 'tool_result'; callId: string; toolName: string; result: string; isError: boolean }
  | { tag: 'verifier_outcome'; outcome: VerifierOutcome<unknown> }
  | { tag: 'transport_error'; error: Error }
  | { tag: 'cancelled' };

export type AttemptEffect =
  | { tag: 'call_llm' }
  | { tag: 'run_tool'; call: { id: string; name: string; argsJson: string } }
  | { tag: 'run_verifier'; terminalCallId: string; terminalToolName: string; argsJson: string }
  | { tag: 'persist'; role: 'assistant' | 'tool' | 'system'; kind: string; content: string; toolCallId?: string }
  | { tag: 'send_repair'; report: import('./contract-verifier.js').ObligationReport };

export interface StepResult {
  readonly nextState: AttemptState;
  readonly effects: readonly AttemptEffect[];
}

export function step(
  state: AttemptState,
  event: AttemptEvent,
  plan: AgentInvocationPlan,
): StepResult;
```

### 3.3 `AttemptDriver`

```ts
// src/agents/attempt-driver.ts

import type { AttemptEvent, AttemptEffect } from './attempt-step.js';
import type { AttemptState, AttemptTerminal } from './attempt-state.js';
import type { AgentInvocationPlan } from './agent-invocation-plan.js';
import type { Candidate } from './provider.js';
import type { SessionRuntime } from './agent-session-lifecycle.js';
import type { LlmCallFn } from './llm-contracts.js';
import type { AgentToolExecutor } from './agent-tool-executor.js';
import type { ContractVerifier } from './contract-verifier.js';

export class AttemptDriver {
  constructor(opts: {
    llmCallFn: LlmCallFn;
    toolExecutor: AgentToolExecutor;
    verifier: ContractVerifier;
  });

  drive<Envelope>(
    plan: AgentInvocationPlan,
    candidate: Candidate,
    session: SessionRuntime,
  ): Promise<AttemptTerminal<Envelope>>;
}
```

The `drive` method runs a deterministic effect-execution loop: `step` is
pure, the driver handles the I/O. Tests can run `step` against curated
event sequences without a transport, a session, or a verifier.

The other five P-C1 collaborators (`AgentInvocationPlan`,
`CandidateResolver`, `AgentSessionLifecycle`, `InvocationAttemptRecorder`,
`InvocationOutcomeProjector`) are unchanged. The orchestrator body is
identical to P-C1 except it instantiates `AttemptDriver` instead of
`ConversationRunner`.

### 3.4 Why a state machine here

Three axes are encoded structurally rather than by counter arithmetic.
Turn-budget exhaustion is a transition into `terminal{turns_exhausted}`;
repair-round exhaustion is a transition into `terminal{repair_exhausted}`;
transport failure is a transition into `terminal{transport_failure}`. The
"plain message" case becomes a legal transition from `awaiting_llm` back
to `awaiting_llm` with `turnsUsed += 1` and no effect other than persisting
the assistant text — no policy hook, no nudge string, no special case in
the loop body.

Sans-IO option (rejected, see §6) was considered as an alternative to the
state machine. The state machine retains direct LLM/tool invocations
because the driver is the only natural owner of cancellation tokens and
abort controllers; pushing those through a Sans-IO core would require
re-exporting the abort signal as another event, with no readability win.

---

## 4. Comparison

| Axis | P-C1 (focused decomposition) | P-C2 (state machine driving the conversation) |
| --- | --- | --- |
| Blast radius | 6 new files + heavy rewrite of `agent-adapter.ts`; deletes `LlmRolePhase`, terminal arms in 3 transports + 1 recorder, `llm-options-factory.ts` shape change; runtime-config knob rename | Same 6 new files + 3 additional (`attempt-state.ts`, `attempt-step.ts`, `attempt-driver.ts`); `ConversationRunner` swapped for `AttemptDriver`; all P-C1 deletions still apply |
| Readability | Orchestrator is straight-line composition. Per-attempt loop body still contains turn / repair / tool decisions, but factored behind `ConversationRunner` | Orchestrator identical to P-C1; per-attempt logic is a pure step function over an explicit state, making transitions enumerable |
| Test surface | Per-collaborator unit tests; `ConversationRunner` needs a fake LLM + fake verifier; integration via existing transport tests | Pure step function testable with no fakes; driver still needs the same fakes; effect-list assertions enable golden-trace tests of attempt flows |
| Compatibility with Batch A (verifier core + done signal) | Verifier is a constructor-injected collaborator; outcomes flow as values; no exception path remains for contract failures | Same; verifier is invoked via the `run_verifier` effect; transition is explicit |
| Compatibility with Batch B (contract surface) | Contract is a positional argument on `invokeAgent`; orchestrator does not look up by role string | Same; the step function receives `plan.contract` |
| Compatibility with Batch B Position A/B (synthesis stays in adapter) | `AgentToolExecutor` becomes the synthesis owner; runner remains contract-name-blind | Synthesis remains in `AgentToolExecutor`; step function never branches on tool names |
| Implementation cost | Medium. Three of the six collaborators (`AgentSessionLifecycle`, `CandidateResolver`, `InvocationAttemptRecorder`) are extractions of existing logic; the runner and projector are mostly moves; orchestrator becomes a short body | Medium-high. Adds the step function and its tests; the driver is roughly the size of the runner; the win is structural, not lines-of-code |
| Residual debt | `ConversationRunner` is still imperative; turn-budget enforcement lives inline; future additions (e.g. parallel candidate races) still mutate the runner | None of the above; the step function is the natural place for any future extension; turn-budget enforcement is a transition guard |
| Risk to schedule | Lower — closer to a mechanical refactor of the existing imperative loop | Higher — designing the right `AttemptEvent` / `AttemptEffect` set requires one more iteration of the verifier API with Batch A |
| Observability impact | Same — `llm_attempt` / `llm_invocation_summary` shapes evolve identically | Same; the step function makes it easier to add per-transition events later, but does not require any in this batch |

---

## 5. Recommendation

Adopt **P-C1** for this batch.

Reasoning. The brief explicitly scopes Batch C as "scaffolding cleanup":
F01 is dead-code removal, F08 is a rename + a counter reshuffle, F10 is a
method split. P-C1 delivers all three with the smallest possible
deviation from the existing imperative model, which is the right scope
for a clean-up batch that must compose with two other batches landing in
the same window. The state machine in P-C2 is genuinely better
long-term, but the structural win comes from making future extensions
clean — it does not unlock anything F01/F08/F10 themselves need. Taking
P-C2 in this batch also forces an extra round of API alignment with Batch
A's `VerifierOutcome` shape before either batch can ship.

P-C2 is the right next step *after* the contract-verifier batch lands and
the verifier API is stable. The collaborator boundary in P-C1
(`ConversationRunner` is an injected class with a single `run()` method)
is chosen so that P-C2 lands by swapping `ConversationRunner` for
`AttemptDriver` without touching the orchestrator, the recorder, the
projector, or any of the deletions. This batch should call that out as a
follow-up rather than absorb it now.

Concrete acceptance criteria for the recommended P-C1 implementation:

1. `grep -RnE "phase\s*:\s*['\"](tools|terminal)['\"]|LlmRolePhase|LlmCompleteOptionsTerminal|deriveTerminalTool\b"`
   inside `src/` returns nothing.
2. `grep -RnE "maxToolTurns|maxRecoveryRetries|sameCandidateRecoveryAttempt"`
   inside `src/` returns nothing.
3. `src/agents/agent-adapter.ts`'s `invokeAgent` method is under 80 lines,
   contains no `for (let turn = 0; ...)` loop, contains no
   `appendSessionMessage` call, and contains no role-string equality check.
4. The three `envelopeTo*Result` helpers at module scope are deleted.
5. `LlmCompleteOptions` is a single record type (no discriminated union).
6. The two `tests/agents/llm-openai-*-gateway-request.test.ts` files
   contain no `phase: 'terminal'` literal.
7. The verdict enum on `llm_invocation_summary` includes
   `turns_exhausted` and `repair_exhausted`.

---

## 6. Rejected alternatives

- **Keep the `LlmRolePhase` type as a typing hint for transports that
  might want forced-tool turns later.** Rejected: nothing in scope wants
  forced-tool turns, the `tool_choice: { kind: 'required_named' }`
  variant on `LlmToolChoice` already covers that case if it ever returns,
  and keeping a dead type "for future use" is the exact anti-pattern
  the workspace rule forbids.

- **Collapse all three budgets into one "max LLM calls" knob.** Rejected:
  the three axes have genuinely different semantics — turn-budget
  exhaustion is the agent failing to make progress, repair-budget
  exhaustion is the agent failing to comply, transport-budget exhaustion
  is the infrastructure failing the agent. Collapsing them hides the
  distinction the brief asks for ("name the budgets so we can talk about
  them") and makes the outcome event lose its diagnostic value.

- **Keep `contract_mismatch` in `LlmFailure` and route the verifier's
  outcomes through `LlmRequestError` to minimise type churn.** Rejected:
  this is exactly the path that produces today's "abort-but-also-replay"
  contradiction (analysis §1.2 problem 2). Batch A's failure-type split
  is the right move; this batch's collaborator boundaries presuppose it.

- **Sans-IO core (move the entire per-attempt loop into a pure module
  that emits effect descriptions, with a thin imperative shell).**
  Rejected: cancellation, abort controllers, and per-session message
  persistence interact with the loop on every turn. A Sans-IO split
  forces those interactions through additional event/effect pairs with no
  readability win over the §3 state machine, which keeps the I/O in a
  driver but still gets the explicit-transitions benefit.

- **Make `AgentInvocationPlan` own the candidate chain (a single resolve
  at construction time).** Rejected by the analysis r2 review (finding
  2): candidate availability genuinely changes between outer attempts, so
  the chain must be re-resolved per outer attempt. The `CandidateResolver`
  collaborator owns both call sites and returns the chain + skip snapshot
  as one atomic value, which solves the concurrency hazard without
  freezing the chain.

- **Drop `InvocationOutcomeProjector` and put the lifecycle transitions
  inline in the orchestrator after `invokeWithRecovery` returns.**
  Rejected: that is what `invokeAgent` does today (analysis item 23) and
  it is exactly the role-string-keyed ladder that F10 calls out. Moving
  the projection onto the contract value via `contract.projectStatus(...)`
  is the F10 fix; the projector exists to host that call and the
  `llm_invocation_summary` emission together so the orchestrator stays
  straight-line.

- **Keep the inline `model_repair` nudge from commit `a2a6f05` because
  Batch A may not ship in the same window.** Rejected per the brief
  ("the redesign should subsume or replace it cleanly without leaving the
  patch as residue"). If Batch A slips, this batch's `ConversationRunner`
  still treats plain messages as in-progress traffic; the nudge is gone
  either way. The verifier (when it lands) is the one place where any
  agent-facing repair message is generated.
