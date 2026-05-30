# Batch C — Scaffolding Cleanup: Design

Scope: implementation-level design that resolves F01 (per-turn phase
machinery), F08 (overlapping budgets), and F10 (`invokeAgent` god method).
Two proposals are presented (P-C1 focused, P-C2 architectural) followed by
a comparison, a recommendation, and rejected alternatives. All paths are
workspace-relative to `saivage-v3/`. No backward compatibility is
preserved at any boundary in this design — every old shape named here is
deleted in the same change set as the new shape, including the legacy
runtime-config migration entries.

---

## 0. Assumptions about Batches A and B

Batch C must compose with the contract-verifier work without depending on
which variant Batches A/B ultimately ship. The collaborator boundaries
below were chosen so that any of the following Batch A/B outcomes drops
into the same shape with a single import swap.

A1. **Per-invocation `Contract` value.** Batch B defines a value carrying
    the terminal-tool definition(s), the schema, a `verify(toolCall) ->
    Result | Violation` predicate, and a `project(envelope) -> Typed`
    function. Batch C consumes this value through a single import
    (`Contract` from `src/contracts/contract.ts`). If Batch B keeps a thin
    `ContractTerminalDescriptor` + separate verifier function, the
    `ContractVerifier` collaborator below adapts by holding both as
    fields. The boundary is the `Contract` type symbol, not its internal
    shape.

A2. **Explicit done signal.** Batch A treats one dedicated tool call (a
    `signal_done` / `submit_result` / `emit_*_result` family member,
    enumerated by the contract) as the success exit. Batch C names the
    same tool through `contract.terminals` and treats any other tool call
    as in-progress traffic; the loop never inspects tool names directly.

A3. **`ObligationReport` verifier output.** Batch A's verifier returns
    either a typed `Envelope`, an `ObligationReport` (structured
    non-compliance to be rendered as a `model_repair` row), or a
    `RepairExhausted` terminal diagnostic. Batch C's `ContractVerifier`
    collaborator returns the same three-way value through a typed
    discriminated union (`VerifierOutcome` below). If Batch A ships a
    different name for the union, the alias is a one-line rename here.

A4. **Deferred activation as a terminal signal.** Batch B Position C
    dissolves the deferred-`activate_card` synthesis into a first-class
    terminal envelope on the planner contract. Batch C therefore removes
    the synthesis branch from the conversation loop entirely; if Batch B
    instead lands Position A/B and keeps the synthesis as a runtime
    concern, it moves into `PlannerControlExecutor` (the planner-control
    tool dispatch surface), still out of the verifier. Either way the
    conversation loop never branches on `tc.function.name ===
    'activate_card'`.

A5. **Failure-type split.** Batch A deletes `contract_mismatch` from
    `LlmFailure` and introduces `LlmTransportFailure`. Batch C's
    `InvocationAttemptRecorder` consumes only the transport failure type;
    the verifier outcomes do not flow through `LlmRequestError`. If Batch
    A's split is not yet merged at implementation time, this batch
    introduces a thin `isTransportFailure(failure)` discriminator at the
    recorder boundary so the unified `LlmFailure` is filtered at one
    point.

Assumptions explicitly *not* made:

- Whether the contract registry is per-role-string or per-`Contract`
  value.
- Whether `ObligationReport` is a free-form string or a structured array
  of `Obligation` items.
- Whether `signal_done` is one tool or a small family — this batch only
  needs `contract.terminals` to yield one or more named tool entries.

---

## 1. Design goal

Concrete restatement:

1. **F01.** Delete every site that distinguishes a `'tools'` phase from a
   `'terminal'` phase, including the `phase: 'tools'` literal still
   constructed by tests and production code. The runtime ships one
   options shape, one tool list, and one transport path. The terminal-
   tool *name* survives as data on the contract value (Batch B), never as
   a discriminator on per-turn options.
2. **F08.** Replace four overlapping counters (`maxToolTurns`,
   `maxRecoveryRetries`, `recoveryDelayMs`-as-`retry_same_after_delay`,
   `sameCandidateRecoveryAttempt`) with three orthogonal named budgets
   owned by three distinct layers: free-turn budget (verifier), repair-
   round budget (verifier), transport-retry budget (outer attempt loop).
   The
   `contract_mismatch`-routes-through-`fail_invocation`-routes-through-outer-replay
   pathway is dissolved; contract outcomes are values, not exceptions.
3. **F10.** Replace `AgentAdapter.invokeAgent`
   ([agent-adapter.ts#L225-L497](../../../../src/agents/agent-adapter.ts#L225-L497))
   with a ~50-line orchestrator that composes named collaborators. Each
   collaborator owns one concern (plan construction, candidate
   resolution, session lifecycle, conversation execution, attempt
   recording, outcome projection). Status-to-lifecycle projection becomes
   a function keyed by the contract value, not by `role === 'planner'`
   string comparisons.

The decomposition must remain compatible with Batches A/B (see §0) while
making zero assumptions that lock it into either of their variants.

---

## 2. Proposal P-C1 — Focused fix

A direct decomposition along the responsibility boundaries already named
in the analysis. Each collaborator is an injected class; the orchestrator
wires them. No state machine, no Sans-IO indirection. The outer recovery
loop becomes a direct collaborator (`OuterAttemptLoop`) owned by Batch C;
`src/agents/recovery.ts` is deleted in this change set because nothing
outside this hot path uses it.

### 2.1 F01 — exact deletions and replacements

The terminal-phase scaffolding is deleted with no shim. Every existing
`phase: 'tools'` literal is also rewritten because the field is gone.
Replacement references point at constructs that already exist or are
introduced in §2.3.

| Symbol | File | Lines | Action | Replacement |
| --- | --- | --- | --- | --- |
| `LlmRolePhase` type | [src/agents/llm-options-factory.ts](../../../../src/agents/llm-options-factory.ts) | 13 | delete | none — phase concept is gone |
| `buildLlmOptions(role, phase, ...)` signature + tools branch + terminal branch + `deriveTerminalTool` helper | [src/agents/llm-options-factory.ts](../../../../src/agents/llm-options-factory.ts) | 19-69 | replace with the body in §2.1 below | new `buildLlmOptions(input)` signature |
| `LlmCompleteOptionsTerminal` interface | [src/agents/llm-contracts.ts](../../../../src/agents/llm-contracts.ts) | 42-54 (terminal arm) | delete | none |
| `LlmCompleteOptionsTools` interface + the `phase` discriminator | [src/agents/llm-contracts.ts](../../../../src/agents/llm-contracts.ts) | 42-54 | rename + flatten | `LlmCompleteOptions` (sole, non-discriminated record) |
| `opts.phase === 'terminal'` branch + `opts.phase` reads | [src/agents/llm-provider-gateway.ts](../../../../src/agents/llm-provider-gateway.ts) | 42 | delete branch, drop `phase` access | tools list reads `opts.tools` unconditionally |
| `opts.phase === 'terminal'` branch + `opts.phase` reads | [src/agents/llm-openai-chat-gateway.ts](../../../../src/agents/llm-openai-chat-gateway.ts) | 183-187 | delete branch, drop `phase` access | tools list reads `opts.tools` unconditionally |
| `opts.phase === 'terminal'` branch + `opts.phase` reads | [src/agents/llm-openai-codex-gateway.ts](../../../../src/agents/llm-openai-codex-gateway.ts) | 122-127 | delete branch, drop `phase` access | tools list reads `opts.tools` unconditionally |
| first arm of `deriveTerminalToolFromOptions` | [src/agents/llm-recording.ts](../../../../src/agents/llm-recording.ts) | 64-66 | delete | second arm becomes the whole body (the `tool_choice.kind === 'required_named'` lookup) |
| `agent-adapter.ts` per-turn `buildLlmOptions(role, 'tools', turnTools, ...)` call | [src/agents/agent-adapter.ts](../../../../src/agents/agent-adapter.ts) | 295-300 | rewrite | call to new `buildLlmOptions({...})` inside `ConversationRunner` (§2.3.4) |
| `terminalToolName` / `terminalToolDef` per-turn re-derivation | [src/agents/agent-adapter.ts](../../../../src/agents/agent-adapter.ts) | 292-296 | delete | derived once via `contract` on `AgentInvocationPlan` |
| `analyst-llm-resolver.ts` `buildLlmOptions('analyst', 'tools', ...)` call | [src/agents/analyst-llm-resolver.ts](../../../../src/agents/analyst-llm-resolver.ts) | 159-166 | rewrite | call to new `buildLlmOptions({ tools, modelParams, signal: undefined, recorder })` — no contract is needed because the analyst flow has no terminal-tool concept |
| `probe-llm-contract.ts` `phase` argument plumbing + `'terminal'` branch | [src/scripts/probe-llm-contract.ts](../../../../src/scripts/probe-llm-contract.ts) | 86-90 | rewrite | probe collapses to a single round-trip exercising the contract value (one `buildLlmOptions({...})` call per round, no phase argument) |
| `{ phase: 'terminal' }` + `phase: 'tools'` test constructions | [tests/agents/llm-openai-chat-gateway-request.test.ts](../../../../tests/agents/llm-openai-chat-gateway-request.test.ts) | 48, 75, 88 | rewrite all three | single-shape options object; test asserts the single tool-list path |
| `{ phase: 'terminal' }` + `phase: 'tools'` test constructions | [tests/agents/llm-openai-codex-gateway-request.test.ts](../../../../tests/agents/llm-openai-codex-gateway-request.test.ts) | 48, 74, 87 | rewrite all three | same as above |
| `phase: 'tools'` test-helper factory | [tests/agents/_llm-test-helpers.ts](../../../../tests/agents/_llm-test-helpers.ts) | 4 | rewrite | helper returns the flat record without a phase field |
| `phase: 'tools'` recorder-test factory | [tests/agents/llm-client-recorder.test.ts](../../../../tests/agents/llm-client-recorder.test.ts) | 28 | rewrite | same as above |
| `phase: 'tools'` integration-test factory | [tests/agents/llm-client-integration.test.ts](../../../../tests/agents/llm-client-integration.test.ts) | 253 | rewrite | same as above |

What survives unchanged:

- `TERMINAL_TOOL_NAMES` and `TerminalToolName` in
  [src/contracts/llm-exchange.ts#L35-L36](../../../../src/contracts/llm-exchange.ts#L35-L36).
  These are the names of the result-emitting tools; Batch B exposes them
  via `contract.terminals` but the constants stay as the canonical string
  source.
- `LlmToolChoice` keeps its `required_named` variant because the
  transports still emit it on the wire when a contract wants forced-tool
  turns; it is no longer a discriminator on the options object.

New `buildLlmOptions` signature (compiles in isolation against the
existing `LlmToolDefinition`, `LlmExchangeRecorder`, `LlmToolChoice`,
`LlmCompleteOptions` symbols defined in §2.1.1 below):

```ts
// src/agents/llm-options-factory.ts (rewritten body)
import type { LlmCompleteOptions, LlmToolDefinition } from './llm-contracts.js';
import type { LlmExchangeRecorder } from './llm-recording.js';

export interface BuildLlmOptionsInput {
  tools: readonly LlmToolDefinition[];
  modelParams: { temperature?: number; maxTokens?: number };
  signal?: AbortSignal;
  recorder?: LlmExchangeRecorder;
}

export function buildLlmOptions(input: BuildLlmOptionsInput): LlmCompleteOptions {
  return {
    tools: input.tools.slice(),
    toolChoice: { kind: 'auto' },
    temperature: input.modelParams.temperature,
    maxTokens: input.modelParams.maxTokens,
    abortSignal: input.signal,
    recorder: input.recorder,
  };
}
```

The renames `tools` (already the field name; unchanged), `toolChoice`
(was `tool_choice`), `temperature` (unchanged), `maxTokens` (was
`max_tokens`), `abortSignal` (was `signal`) are a single coordinated edit
across `llm-contracts.ts`, the three transports (`llm-provider-gateway`,
`llm-openai-chat-gateway`, `llm-openai-codex-gateway`), the recorder
(`llm-recording.ts`), the two transport-request tests, the helper
factories, and `agent-adapter.ts`. The deletion list above is the
exhaustive set of sites that hold one of those identifiers.

#### 2.1.1 `LlmCompleteOptions` collapses to a single non-discriminated record

```ts
// src/agents/llm-contracts.ts (terminal arm deleted, tools arm flattened)
import type { LlmExchangeRecorder } from './llm-recording.js';

export interface LlmToolDefinition {
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export interface LlmToolChoice {
  kind: 'auto' | 'required_named';
  name?: string;
}

export interface LlmCompleteOptions {
  tools: readonly LlmToolDefinition[];
  toolChoice: LlmToolChoice;
  temperature?: number;
  maxTokens?: number;
  abortSignal?: AbortSignal;
  recorder?: LlmExchangeRecorder;
}
```

### 2.2 F08 — three-axis budget model

The three runtime-config knobs below replace the existing four. The old
keys (`maxToolTurns`, `maxRecoveryRetries`, `recoveryDelayMs`) are
removed from the schema with no migration arm — see §2.5 for the
boundary delete.

| New knob | Owner | Replaces | Default | Counter visible on which event |
| --- | --- | --- | --- | --- |
| `maxAgentTurns` | `ContractVerifier` (axis 1) | `maxToolTurns` ([agent-adapter.ts#L297](../../../../src/agents/agent-adapter.ts#L297)) | 16 | `llm_attempt.turns_used` (new field on the existing per-attempt payload) |
| `maxRepairRounds` | `ContractVerifier` (axis 2) | `sameCandidateRecoveryAttempt` ([agent-adapter.ts#L278](../../../../src/agents/agent-adapter.ts#L278)) + `parse_error` arm of `retry_same_after_delay` ([invocation-recovery-policy.ts#L131-L138](../../../../src/agents/invocation-recovery-policy.ts#L131-L138)) | 3 | `llm_attempt.repair_rounds_used` (new field) |
| `maxTransportRetries` | `OuterAttemptLoop` (axis 3) | `maxRecoveryRetries` ([recovery.ts#L97](../../../../src/agents/recovery.ts#L97)) | 3 | `llm_invocation_summary.attempts_count` (derived from `InvocationAttempt[]` length) |
| `transportRetryDelayMs` | `OuterAttemptLoop` (axis 3) | `recoveryDelayMs` ([recovery.ts#L174](../../../../src/agents/recovery.ts#L174)) | 60000 | not separately surfaced; consumed inline by `InvocationAttemptRecorder` when it returns a `continue_same_candidate` or `replay_outer` directive |

The fourth current concept (`recoveryDelayMs` used as the per-attempt
`retryDelayMs` for `retry_same_after_delay` at
[invocation-recovery-policy.ts#L138](../../../../src/agents/invocation-recovery-policy.ts#L138))
is **deleted**: contract violations no longer go through the recovery
policy. Transport-side `parse_error` (HTTP body malformed) keeps a same-
candidate retry, but under the renamed `transportRetryDelayMs` and only
via the recorder's directive return value (§2.3.5).

Per-axis failure-class table — who increments what under each failure
class in the new model:

| Failure class | Where it surfaces | Axis 1 (`maxAgentTurns`) | Axis 2 (`maxRepairRounds`) | Axis 3 (`maxTransportRetries`) | Visible result |
| --- | --- | --- | --- | --- | --- |
| `auth_permanent` | transport | n/a | n/a | does **not** consume; immediate failover to next candidate | candidate failover, `llm_attempt.outcome=failed`, no outer replay |
| `capability_mismatch` | transport | n/a | n/a | does not consume; immediate failover | candidate failover |
| `rate_limit` | transport | n/a | n/a | does not consume; cooldown + failover | candidate failover |
| `server_transient` / `timeout` | transport | n/a | n/a | does not consume; cooldown + failover | candidate failover |
| `provider_protocol_error` (Batch A §2.1.1) | transport | n/a | n/a | +1 axis 3, full `agentFn` replay on a fresh candidate chain | outer replay |
| `parse_error` (transport-body parse, *not* terminal-tool args) | transport | n/a | n/a | +1 axis 3, full replay | outer replay |
| `token_budget_exceeded` | transport | n/a | n/a | does not consume; failover | candidate failover |
| `cancelled` | transport | n/a | n/a | does not consume; abort, no replay | abort |
| `envelope_missing_at_done_signal` (Batch A `Obligation` code) | verifier | n/a | +1 axis 2; verifier renders `ObligationReport` as `model_repair` row, conversation continues on the same candidate | n/a | repair round, possibly success |
| `envelope_invalid_json` | verifier | n/a | +1 axis 2 | n/a | repair round |
| `envelope_schema_violation` | verifier | n/a | +1 axis 2 | n/a | repair round |
| `terminal_tool_args_invalid_json` (was `LlmRequestError{contract_mismatch/tool_arguments_invalid_json}`) | verifier | n/a | +1 axis 2 | n/a | repair round |
| `max_repair_rounds_exhausted` | verifier (terminal) | n/a | budget hit | n/a | verifier returns `RepairExhausted`; `ConversationRunner` returns a terminal outcome; orchestrator records via `recordVerifierTerminal` and stops the outer loop without replay |
| `max_agent_turns_exhausted` | verifier (terminal) | budget hit | n/a | n/a | verifier returns `TurnsExhausted`; same termination path as above |
| no candidates resolved | candidate resolver | n/a | n/a | does not consume; abort, no replay | abort |
| plain message during a contract-bearing turn | not a failure | +1 axis 1 (the LLM call counts as a turn) | n/a | n/a | conversation continues; the inline `model_repair` nudge from commit `a2a6f05` ([agent-adapter.ts#L304-L320](../../../../src/agents/agent-adapter.ts#L304-L320)) is **deleted** — plain messages become normal in-progress traffic per Batch A §1 |
| non-terminal tool batch | not a failure | +1 axis 1 | n/a | n/a | tool results persisted, conversation continues |
| terminal tool call without `signal_done` semantics (Batch A) | not a failure | +1 axis 1 | n/a | n/a | non-result tool; treated like above |

Three structural problems from the analysis are dissolved by this table:

1. The same-candidate counter no longer rides the generic `attempt`
   field. The outer loop sees only axis-3 retries; its attempt counter
   means exactly "transport retries used so far".
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

### 2.3 F10 — `invokeAgent` decomposition (TypeScript signatures)

Seven collaborator types. Each is a class with one public entry point
unless noted; all are constructor-injected into `AgentAdapter`. The
signatures below are written as valid implementation `.ts` shapes — every
declared method has either a `Promise<...>` return on a stub or a typed
`async` body sketch sufficient for a reviewer to confirm compilation
intent. The full bodies live in the implementation; the design specifies
only what must be type-checkable from the public surface.

#### 2.3.1 `AgentInvocationPlan`

Pure-data record built once per call. Owns capability request, resolved
tool list, model params, system prompt (with self-check already applied),
the contract value, and the two intra-conversation budgets. Does *not*
own a candidate chain (per analysis r2 finding 2).

```ts
// src/agents/agent-invocation-plan.ts
import type { CapabilityRequest } from './provider-capabilities.js';
import type { LlmToolDefinition } from './llm-contracts.js';
import type { Contract } from '../contracts/contract.js';
import type { AgentRole } from '../schemas/index.js';

export interface AgentInvocationPlan<Envelope = unknown, Result = unknown> {
  readonly role: AgentRole;
  readonly goalId: string;
  readonly cardId: string;
  readonly sessionId: string;
  readonly systemPrompt: string;
  readonly tools: readonly LlmToolDefinition[];
  readonly capabilityRequest: CapabilityRequest;
  readonly modelParams: { temperature?: number; maxTokens?: number };
  readonly contract: Contract<Envelope, Result>;
  readonly budgets: {
    readonly maxAgentTurns: number;
    readonly maxRepairRounds: number;
  };
}
```

Replaces analysis items 1, 2, 5.

#### 2.3.2 `CandidateResolver`

Single authority for `router.resolve` + capability-skip snapshot. Returns
both atomically; downstream code never re-reads
`router.getLastCapabilitySkips()`.

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
    const capabilitySkips = (this.router.getLastCapabilitySkips() ?? []).slice();
    return { candidates, capabilitySkips, resolvedAt: Date.now() };
  }
}
```

Replaces analysis items 3 and 9, and centralises the four
`getLastCapabilitySkips()` reads
([L243](../../../../src/agents/agent-adapter.ts#L243),
[L270](../../../../src/agents/agent-adapter.ts#L270),
[L395](../../../../src/agents/agent-adapter.ts#L395),
[L431](../../../../src/agents/agent-adapter.ts#L431)) into the one read
inside `resolve`. The snapshot travels through `ConversationRunner` and
`InvocationAttemptRecorder` as data, eliminating the concurrency hazard.

#### 2.3.3 `AgentSessionLifecycle`

Owns session creation, the single-active-session assertion, lifecycle
events, abort-controller tracking, cancellation polling, and the post-
invocation `markSessionWaiting` / `completeSession` projection. Absorbs
the existing `AgentSessionCoordinator` plus the inline `createSession` /
`assertNoActiveAgentSession` / `persistFailure` closure currently at
[agent-adapter.ts#L249-L256](../../../../src/agents/agent-adapter.ts#L249-L256).

```ts
// src/agents/agent-session-lifecycle.ts
import type { EventEmitter } from 'node:events';
import type { AgentMessage, AgentRole, AgentSession, HandoffSummary, SessionStatus } from '../schemas/index.js';
import type { NotificationCenter } from '../notifications/index.js';
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

export interface AgentSessionLifecycleOptions {
  saivageDir: string;
  notificationCenter: NotificationCenter;
  eventBus?: EventEmitter;
  eventLogger?: EventLogger;
}

export class AgentSessionLifecycle {
  constructor(private readonly opts: AgentSessionLifecycleOptions) {}

  async start(input: SessionStartInput): Promise<SessionRuntime> { /* impl */ throw new Error('stub'); }
  cancel(sessionId: string): boolean { /* impl */ return false; }
  forceCancel(sessionId: string): boolean { /* impl */ return false; }
  getActiveHandoffs(): HandoffSummary[] { /* impl */ return []; }
}
```

Replaces analysis items 4, 6, 7-partial, 11, and the post-invocation half
of item 23 (lifecycle transitions; the role-to-status projection itself
lives in `InvocationOutcomeProjector`).

#### 2.3.4 `ConversationRunner`

Owns the per-candidate intra-conversation loop. One `run()` call drives
one candidate from the first LLM turn until the verifier returns a
terminal outcome or a transport failure is raised by the LLM call.
Internally composes the verifier (Batch A) and the tool executor. The
returned `ConversationOutcome` is a discriminated union with three
shapes; one of those (`transport_failure`) carries the raw transport
error and a typed `LlmTransportFailure`, replacing the previous `throw`
pattern so the orchestrator does not have to use `try/catch` around the
runner.

```ts
// src/agents/conversation-runner.ts
import type { Candidate } from './provider.js';
import type { AgentInvocationPlan } from './agent-invocation-plan.js';
import type { SessionRuntime } from './agent-session-lifecycle.js';
import type { AgentToolExecutor } from './agent-tool-executor.js';
import type { LlmCallFn } from './llm-contracts.js';
import type { ContractVerifier, ObligationReport } from './contract-verifier.js';
import type { LlmTransportFailure } from './llm-failure.js';

export type ConversationOutcome<Envelope> =
  | { tag: 'success'; envelope: Envelope; terminalToolName: string; turnsUsed: number; repairRoundsUsed: number }
  | { tag: 'turns_exhausted'; turnsUsed: number; repairRoundsUsed: number }
  | { tag: 'repair_exhausted'; turnsUsed: number; repairRoundsUsed: number; finalReport: ObligationReport }
  | { tag: 'transport_failure'; turnsUsed: number; repairRoundsUsed: number; failure: LlmTransportFailure; error: Error };

export interface ConversationRunnerOptions {
  llmCallFn: LlmCallFn;
  toolExecutor: AgentToolExecutor;
  verifier: ContractVerifier;
}

export class ConversationRunner {
  constructor(private readonly opts: ConversationRunnerOptions) {}

  async run<Envelope, Result>(
    plan: AgentInvocationPlan<Envelope, Result>,
    candidate: Candidate,
    session: SessionRuntime,
  ): Promise<ConversationOutcome<Envelope>> { /* impl */ throw new Error('stub'); }
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

`ObligationReport` is the Batch A type referenced through a typed import;
this batch does not redefine it.

#### 2.3.5 `InvocationAttemptRecorder`

Owns *all* per-attempt effects: `llm_attempt` event emission, failure
classification, candidate-availability marking, `model_issue` /
`model_recovered` row persistence, retry-delay sleep, redaction, and the
abort-vs-continue-vs-replay directive. The outer loop only consumes the
directive — it never classifies, persists, emits, or sleeps. This is the
only owner of those effects in the new design.

```ts
// src/agents/invocation-attempt-recorder.ts
import type { EventEmitter } from 'node:events';
import type { Candidate } from './provider.js';
import type { LlmTransportFailure } from './llm-failure.js';
import type { CandidateAvailability } from './candidate-availability.js';
import type { InvocationRecoveryPolicy } from './invocation-recovery-policy.js';
import type { CandidateChain } from './candidate-resolver.js';
import type { SessionRuntime } from './agent-session-lifecycle.js';
import type { AgentInvocationPlan } from './agent-invocation-plan.js';
import type { LlmAttemptPayload, LlmFailureClass } from '../schemas/index.js';
import type { ConversationOutcome } from './conversation-runner.js';
import type { EventLogger } from '../observability/index.js';

export interface AttemptStart {
  readonly attemptNumber: number;
  readonly maxAttempts: number;
  readonly candidate: Candidate;
  readonly chain: CandidateChain;
  readonly startedAtMs: number;
}

export type AttemptDirective =
  | { action: 'next_candidate'; reason: LlmFailureClass; cooldownMs?: number }
  | { action: 'continue_same_candidate'; reason: 'parse_error_transport'; retryDelayMs: number }
  | { action: 'replay_outer'; reason: 'provider_protocol_error' | 'parse_error_transport_exhausted' }
  | { action: 'abort'; reason: 'cancelled' | 'verifier_terminal' };

export interface AttemptOutcomeRecord {
  readonly payload: LlmAttemptPayload;
  readonly directive: AttemptDirective;
}

export interface InvocationAttemptRecorderOptions {
  policy: InvocationRecoveryPolicy;
  availability: CandidateAvailability;
  transportRetryDelayMs: number;
  eventLogger?: EventLogger;
  eventBus?: EventEmitter;
}

export class InvocationAttemptRecorder {
  constructor(private readonly opts: InvocationAttemptRecorderOptions) {}

  async recordSuccess<Envelope, Result>(
    plan: AgentInvocationPlan<Envelope, Result>,
    session: SessionRuntime,
    start: AttemptStart,
    outcome: Extract<ConversationOutcome<Envelope>, { tag: 'success' }>,
  ): Promise<LlmAttemptPayload> { /* impl */ throw new Error('stub'); }

  async recordTransportFailure<Envelope, Result>(
    plan: AgentInvocationPlan<Envelope, Result>,
    session: SessionRuntime,
    start: AttemptStart,
    outcome: Extract<ConversationOutcome<Envelope>, { tag: 'transport_failure' }>,
  ): Promise<AttemptOutcomeRecord> { /* impl */ throw new Error('stub'); }

  async recordVerifierTerminal<Envelope, Result>(
    plan: AgentInvocationPlan<Envelope, Result>,
    session: SessionRuntime,
    start: AttemptStart,
    outcome:
      | Extract<ConversationOutcome<Envelope>, { tag: 'turns_exhausted' }>
      | Extract<ConversationOutcome<Envelope>, { tag: 'repair_exhausted' }>,
  ): Promise<AttemptOutcomeRecord> { /* impl */ throw new Error('stub'); }

  injectRecoveryDirective(session: SessionRuntime, attemptNumber: number, previousError: Error): void { /* impl */ }
}
```

The recorder is the only emitter of `llm_attempt`, the only writer of
`model_issue` / `model_recovered`, and the only place that calls
`await delay(transportRetryDelayMs)`. It also owns the abort-vs-continue
mapping: `recordVerifierTerminal` always returns a directive with
`action === 'abort'` and `reason === 'verifier_terminal'`, which is the
signal the outer loop uses to stop without consuming axis 3.

The legacy `invokeWithRecovery` wrapper does *not* coexist with this
collaborator. `src/agents/recovery.ts` is deleted (§2.5); the events
previously emitted by it (`agent_recovered`, `agent_invocation_failed`)
fold into the recorder's `llm_attempt` payload as new `recovery_phase`
fields, removing the duplicate observability path.

#### 2.3.6 `OuterAttemptLoop`

Tiny loop that owns axis 3 only: it calls `agentFn`, collects each
returned `InvocationAttempt`, and decides whether to loop again based on
the directive returned by `InvocationAttemptRecorder`. It does not
classify failures, does not emit events, does not write messages, does
not sleep, and does not know about the verifier. It is small enough to
inline in the orchestrator, but extracting it keeps the test surface
clean and makes the budget split obvious.

```ts
// src/agents/outer-attempt-loop.ts
import type { AttemptDirective } from './invocation-attempt-recorder.js';

export interface InvocationAttempt {
  readonly attempt: number;
  readonly success: boolean;
  readonly result?: unknown;
  readonly error?: Error;
  readonly directive: AttemptDirective;
}

export interface OuterAttemptLoopOptions {
  readonly maxTransportRetries: number;
}

export type AgentAttemptFn<T> = (attemptNumber: number, previousError: Error | undefined) => Promise<{
  readonly value?: T;
  readonly error?: Error;
  readonly directive: AttemptDirective;
}>;

export class OuterAttemptLoop {
  constructor(private readonly opts: OuterAttemptLoopOptions) {}

  async run<T>(agentFn: AgentAttemptFn<T>): Promise<{
    readonly attempts: readonly InvocationAttempt[];
    readonly value?: T;
  }> {
    const attempts: InvocationAttempt[] = [];
    const maxAttempts = this.opts.maxTransportRetries + 1;
    let previousError: Error | undefined;
    for (let i = 1; i <= maxAttempts; i++) {
      const r = await agentFn(i, previousError);
      const success = r.value !== undefined && r.error === undefined;
      attempts.push({
        attempt: i,
        success,
        result: r.value,
        error: r.error,
        directive: r.directive,
      });
      if (success) return { attempts, value: r.value };
      if (r.directive.action !== 'replay_outer') return { attempts };
      previousError = r.error;
    }
    return { attempts };
  }
}
```

Only `replay_outer` (returned exclusively for `provider_protocol_error`
and transport-`parse_error`-after-same-candidate-exhaustion per the
recorder's classification) consumes axis 3. `abort`, `next_candidate`,
and `continue_same_candidate` are intra-`agentFn` and never reach the
outer loop — `agentFn` returns once the conversation produces a terminal
outcome or fully exhausts its candidate chain.

#### 2.3.7 `InvocationOutcomeProjector`

Given the `InvocationAttempt[]` array from `OuterAttemptLoop` and the
contract value, builds the `llm_invocation_summary` event and applies the
status-to-session-lifecycle projection. The role-to-lifecycle table moves
here as an explicit function on the contract.

```ts
// src/agents/invocation-outcome-projector.ts
import type { EventEmitter } from 'node:events';
import type { InvocationAttempt } from './outer-attempt-loop.js';
import type { Contract } from '../contracts/contract.js';
import type { AgentInvocationPlan } from './agent-invocation-plan.js';
import type { SessionRuntime } from './agent-session-lifecycle.js';
import type { LlmInvocationSummaryPayload, SessionStatus } from '../schemas/index.js';
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

export interface InvocationOutcomeProjectorOptions {
  eventLogger?: EventLogger;
  eventBus?: EventEmitter;
}

export class InvocationOutcomeProjector {
  constructor(private readonly opts: InvocationOutcomeProjectorOptions) {}

  project<Envelope, Result>(
    plan: AgentInvocationPlan<Envelope, Result>,
    session: SessionRuntime,
    attempts: readonly InvocationAttempt[],
    invocationStartMs: number,
  ): InvocationOutcome<Result> { /* impl */ throw new Error('stub'); }
}
```

The verdict-to-status mapping is driven by
`plan.contract.projectStatus(typedResult)`, where each contract (planner,
executor, reviewer) exports its own pure function returning a
`SessionStatus`. This deletes the `if (role === 'planner' && resultStatus
=== 'continue') ...` ladder at
[agent-adapter.ts#L484-L495](../../../../src/agents/agent-adapter.ts#L484-L495)
and answers the reviewer-arm open question from the analysis: the
reviewer contract returns `'done'` for any successful assessment unless
the contract author overrides it.

Replaces analysis items 22 and 23.

### 2.4 Top-level orchestration

`AgentAdapter.invokeAgent` becomes the following. The body is a straight-
line composition; no per-turn logic appears here. The directive returned
by the recorder is the only branch — it never inspects raw failure
classes.

```ts
// src/agents/agent-adapter.ts (rewritten invokeAgent body, ~50 lines)
private async invokeAgent<Envelope, Result>(
  role: AgentRole,
  goalId: string,
  cardId: string,
  systemPrompt: string,
  contextMessages: AgentMessage[],
  contract: Contract<Envelope, Result>,
  requestedSessionId?: string,
): Promise<Result> {
  if (!this.llmCallFn) throw new Error('No LLM call function registered.');
  this.roleRunner.resetOnRoleChange(role);

  const modelParams = getModelParamsForRole(this.config, role);
  const tools = this.toolExecutor.buildToolsForRole(role);
  const augmentedTools = contract.augmentTools(tools);
  const capabilityRequest = capabilityRequestForLlmOptions({ tools: augmentedTools, stream: false });

  const preflight = await this.candidateResolver.resolve(role, capabilityRequest);
  if (preflight.candidates.length === 0) {
    throw new Error(this.policy.decideNoCandidates({
      role, attempt: 1, maxAttempts: 1,
      recoveryDelayMs: this.runtimeConfig.transportRetryDelayMs ?? 60_000,
      maxRecoveryRetries: this.runtimeConfig.maxTransportRetries ?? 3,
      capabilityRequest, capabilitySkips: preflight.capabilitySkips.slice(),
    }).message);
  }

  const sessionRuntime = await this.sessionLifecycle.start({
    role, goalId, cardId, requestedSessionId, contextMessages,
  });

  const plan: AgentInvocationPlan<Envelope, Result> = {
    role, goalId, cardId,
    sessionId: sessionRuntime.session.id,
    systemPrompt: this.roleRunner.applySelfCheck(role, systemPrompt, sessionRuntime.session.id),
    tools: augmentedTools,
    capabilityRequest, modelParams,
    contract,
    budgets: {
      maxAgentTurns: this.runtimeConfig.maxAgentTurns ?? 16,
      maxRepairRounds: this.runtimeConfig.maxRepairRounds ?? 3,
    },
  };

  const invocationStart = Date.now();
  const { attempts, value } = await this.outerLoop.run<Result>(async (attemptNumber, previousError) => {
    if (previousError) this.attemptRecorder.injectRecoveryDirective(sessionRuntime, attemptNumber, previousError);
    const chain = await this.candidateResolver.resolve(role, capabilityRequest);
    if (chain.candidates.length === 0) {
      const err = new Error(this.policy.decideNoCandidates({
        role, attempt: attemptNumber, maxAttempts: this.outerLoop['opts'].maxTransportRetries + 1,
        recoveryDelayMs: this.runtimeConfig.transportRetryDelayMs ?? 60_000,
        maxRecoveryRetries: this.runtimeConfig.maxTransportRetries ?? 3,
        capabilityRequest, capabilitySkips: chain.capabilitySkips.slice(),
      }).message);
      return { error: err, directive: { action: 'abort', reason: 'cancelled' } };
    }
    for (const candidate of chain.candidates) {
      if (!this.candidateAvailability.isAvailable(candidate)) continue;
      const start: AttemptStart = {
        attemptNumber, maxAttempts: this.runtimeConfig.maxTransportRetries! + 1,
        candidate, chain, startedAtMs: Date.now(),
      };
      const outcome = await this.conversationRunner.run<Envelope, Result>(plan, candidate, sessionRuntime);
      if (outcome.tag === 'success') {
        await this.attemptRecorder.recordSuccess(plan, sessionRuntime, start, outcome);
        return { value: plan.contract.project(outcome.envelope, outcome.terminalToolName), directive: { action: 'abort', reason: 'verifier_terminal' } };
      }
      if (outcome.tag === 'turns_exhausted' || outcome.tag === 'repair_exhausted') {
        const rec = await this.attemptRecorder.recordVerifierTerminal(plan, sessionRuntime, start, outcome);
        return { error: new Error(`Verifier terminal: ${outcome.tag}`), directive: rec.directive };
      }
      // outcome.tag === 'transport_failure'
      const rec = await this.attemptRecorder.recordTransportFailure(plan, sessionRuntime, start, outcome);
      if (rec.directive.action === 'continue_same_candidate') continue;
      if (rec.directive.action === 'next_candidate') continue;
      return { error: outcome.error, directive: rec.directive };
    }
    return { error: new Error(`All candidates exhausted for role '${role}'.`), directive: { action: 'replay_outer', reason: 'parse_error_transport_exhausted' } };
  });

  const finalised = this.outcomeProjector.project<Envelope, Result>(plan, sessionRuntime, attempts, invocationStart);
  sessionRuntime.finalize(finalised.sessionStatus);
  if (finalised.verdict === 'succeeded' && value !== undefined) return value;
  throw finalised.error ?? new Error(`Agent '${role}' invocation failed with verdict '${finalised.verdict}'.`);
}
```

Why this satisfies the verifier-terminal-no-replay requirement: when the
runner returns `turns_exhausted` or `repair_exhausted`, `agentFn` returns
with a directive whose `action === 'abort'` (recorder always returns
`{ action: 'abort', reason: 'verifier_terminal' }` for those outcomes).
`OuterAttemptLoop.run` consults `directive.action` and stops because it
is not `'replay_outer'`. Axis 3 is never consumed for verifier terminals.
`InvocationOutcomeProjector` then sees the failed attempt and emits the
`turns_exhausted` / `repair_exhausted` verdict.

Why this removes the recorder-vs-`invokeWithRecovery` ownership overlap:
`invokeWithRecovery` is deleted in this change set (§2.5). The recorder
is the only owner of `llm_attempt` emission, `model_issue` /
`model_recovered` persistence, `decideSuccess` / `decideFailure` policy
calls, candidate-availability marking, and the transport-retry sleep.
`OuterAttemptLoop` only loops and stops; it has no effects.

Public `invokePlanner` / `invokeExecutor` / `invokeReviewer` change only
in that they now pass the contract value instead of a `parseEnvelope`
callback:

```ts
async invokePlanner(req: PlannerInvocationRequest): Promise<PlannerResult> {
  return this.invokeAgent('planner', req.goalId, req.goalId,
    req.systemPrompt ?? '', req.contextMessages ?? [], plannerContract,
  );
}
```

The three `envelopeTo*Result` helpers at
[agent-adapter.ts#L49-L62](../../../../src/agents/agent-adapter.ts#L49-L62)
are deleted; each contract owns its own `project()`.

### 2.5 Deletions outside `agent-adapter.ts`

The following deletions are required for the design to compile against
the project rules (no compatibility shims, no parallel ownership):

| File | Lines | Action |
| --- | --- | --- |
| [src/agents/recovery.ts](../../../../src/agents/recovery.ts) | whole file | delete (`invokeWithRecovery`, `createCancellableRecovery`, `RecoveryContext`, `RecoveryOptions`, `InvocationAttempt`, `AgentFn`) — the only production caller is `agent-adapter.ts`, which switches to `OuterAttemptLoop` |
| [tests/agents/recovery.test.ts](../../../../tests/agents/recovery.test.ts) | whole file | delete (covers the deleted module) |
| [tests/agents/integration.test.ts](../../../../tests/agents/integration.test.ts) | 18, 221 | remove `invokeWithRecovery` import and replace its single call site with an `OuterAttemptLoop` test driver |
| [tests/utils/agents-module-boundary.test.ts](../../../../tests/utils/agents-module-boundary.test.ts) | 54 | update the asserted symbol set — `invokeWithRecovery` is no longer expected to be a non-export because the module is gone; replace with assertion that `OuterAttemptLoop` is exported from `src/agents/index.ts` if applicable |
| [src/agents/config-schema.ts](../../../../src/agents/config-schema.ts) | 13-40 | delete `LEGACY_RUNTIME_KEYS` entries for `recoveryDelayMs` and `maxRecoveryRetries`; delete the `'maxRecoveryRetries' in runtime ⇒ migratedRuntime['max_review_retries']` fallback at L39 |
| [src/agents/config-schema.ts](../../../../src/agents/config-schema.ts) | 181, 187, 188 | replace `recoveryDelayMs: 60000`, `maxRecoveryRetries: 3`, `maxToolTurns: 16` defaults with `maxAgentTurns: 16`, `maxRepairRounds: 3`, `maxTransportRetries: 3`, `transportRetryDelayMs: 60000` |
| [src/agents/config-schema.ts](../../../../src/agents/config-schema.ts) | 372-379 | delete the legacy-runtime rehydration block (`if (typeof legacy['recoveryDelayMs'] === 'number') runtime.recoveryDelayMs = ...`, same for `maxRecoveryRetries`, plus `selfCheck` rehydration if it depends on the deleted block) — the schema accepts only the new keys |
| `RuntimeSection` zod schema (same file, around the runtime-section definition) | n/a | remove `recoveryDelayMs`, `maxRecoveryRetries`, `maxToolTurns` fields; add the four new fields with their defaults |
| [src/agents/invocation-recovery-policy.ts](../../../../src/agents/invocation-recovery-policy.ts) | 127-128 | delete the `contract_mismatch` arm of `decideFailure` (no caller can produce a `contract_mismatch` failure after Batch A's type split) |
| [src/agents/invocation-recovery-policy.ts](../../../../src/agents/invocation-recovery-policy.ts) | 131-138 | replace the `parse_error` arm so that the same-candidate-retry decision is expressed as a recorder directive (`continue_same_candidate` with `retryDelayMs: transportRetryDelayMs`) rather than as a policy `retry_same_after_delay` action — the policy still classifies, but the recorder owns the loop |
| [src/agents/invocation-recovery-policy.ts](../../../../src/agents/invocation-recovery-policy.ts) | `InvocationRecoveryContext` | rename `recoveryDelayMs` to `transportRetryDelayMs` and `maxRecoveryRetries` to `maxTransportRetries`; remove the same-candidate-counter alias from the `attempt` field semantics (the field now means "outer-loop attempt" only) |

The deletion of the legacy-runtime migration entries (`config-schema.ts`
L13-L40 and L372-L379) is mandatory per the project rule: no deprecate-
and-keep at the runtime-config boundary. Loading an old `.saivage.json`
that contains `maxRecoveryRetries` is a hard validation failure with a
clear error message ("unknown runtime key `maxRecoveryRetries`; renamed
to `maxTransportRetries`").

---

## 3. Proposal P-C2 — One conceptual level up

A small, explicit state machine drives the per-attempt conversation. The
collaborators from P-C1 survive, but `ConversationRunner` becomes a pure-
data step function over an `AttemptState`, and a thin `AttemptDriver`
loops over it. The motivation is that the per-attempt loop has three
genuinely orthogonal axes (turn budget, repair budget, tool dispatch)
that P-C1 keeps interleaved inside one method body; the state machine
names each transition.

### 3.1 The `AttemptState` value

```ts
// src/agents/attempt-state.ts
import type { ObligationReport } from './contract-verifier.js';

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

export type AttemptPhase<Envelope = unknown> =
  | { tag: 'awaiting_llm' }
  | { tag: 'awaiting_tool_results'; toolCalls: readonly PendingToolCall[] }
  | { tag: 'awaiting_repair_reply'; report: ObligationReport }
  | { tag: 'terminal'; result: AttemptTerminal<Envelope> };

export type PersistRole = 'assistant' | 'tool' | 'system';

export interface PendingPersist {
  readonly role: PersistRole;
  readonly kind: string;
  readonly content: string;
}

export interface AttemptState<Envelope = unknown> {
  readonly phase: AttemptPhase<Envelope>;
  readonly turnsUsed: number;
  readonly repairRoundsUsed: number;
  readonly pendingPersist: readonly PendingPersist[];
}
```

### 3.2 Step function and effects

A pure step function takes `(state, event) -> (state, effects)`. Effects
are an explicit list (call LLM, run tool, persist message, write
`model_repair`). The `AttemptDriver` executes effects against injected
ports.

```ts
// src/agents/attempt-step.ts
import type { AttemptState, PersistRole } from './attempt-state.js';
import type { AgentInvocationPlan } from './agent-invocation-plan.js';
import type { LlmCompleteResult } from './llm-contracts.js';
import type { ObligationReport, VerifierOutcome } from './contract-verifier.js';

export type AttemptEvent<Envelope = unknown> =
  | { tag: 'start' }
  | { tag: 'llm_reply'; reply: LlmCompleteResult }
  | { tag: 'tool_result'; callId: string; toolName: string; result: string; isError: boolean }
  | { tag: 'verifier_outcome'; outcome: VerifierOutcome<Envelope> }
  | { tag: 'transport_error'; error: Error }
  | { tag: 'cancelled' };

export type AttemptEffect =
  | { tag: 'call_llm' }
  | { tag: 'run_tool'; call: { id: string; name: string; argsJson: string } }
  | { tag: 'run_verifier'; terminalCallId: string; terminalToolName: string; argsJson: string }
  | { tag: 'persist'; role: PersistRole; kind: string; content: string; toolCallId?: string }
  | { tag: 'send_repair'; report: ObligationReport };

export interface StepResult<Envelope = unknown> {
  readonly nextState: AttemptState<Envelope>;
  readonly effects: readonly AttemptEffect[];
}

export function step<Envelope, Result>(
  state: AttemptState<Envelope>,
  event: AttemptEvent<Envelope>,
  plan: AgentInvocationPlan<Envelope, Result>,
): StepResult<Envelope> { /* impl */ throw new Error('stub'); }
```

### 3.3 `AttemptDriver`

```ts
// src/agents/attempt-driver.ts
import type { Candidate } from './provider.js';
import type { AgentInvocationPlan } from './agent-invocation-plan.js';
import type { SessionRuntime } from './agent-session-lifecycle.js';
import type { LlmCallFn } from './llm-contracts.js';
import type { AgentToolExecutor } from './agent-tool-executor.js';
import type { ContractVerifier } from './contract-verifier.js';
import type { AttemptTerminal } from './attempt-state.js';

export interface AttemptDriverOptions {
  llmCallFn: LlmCallFn;
  toolExecutor: AgentToolExecutor;
  verifier: ContractVerifier;
}

export class AttemptDriver {
  constructor(private readonly opts: AttemptDriverOptions) {}

  async drive<Envelope, Result>(
    plan: AgentInvocationPlan<Envelope, Result>,
    candidate: Candidate,
    session: SessionRuntime,
  ): Promise<AttemptTerminal<Envelope>> { /* impl */ throw new Error('stub'); }
}
```

The `drive` method runs a deterministic effect-execution loop: `step` is
pure, the driver handles the I/O. Tests can run `step` against curated
event sequences without a transport, a session, or a verifier.

The other six P-C1 collaborators (`AgentInvocationPlan`,
`CandidateResolver`, `AgentSessionLifecycle`,
`InvocationAttemptRecorder`, `OuterAttemptLoop`,
`InvocationOutcomeProjector`) are unchanged. The orchestrator body is
identical to P-C1 except it instantiates `AttemptDriver` instead of
`ConversationRunner` and wraps the driver's `AttemptTerminal` in the
`ConversationOutcome` shape the orchestrator already consumes.

### 3.4 Why a state machine here

Three axes are encoded structurally rather than by counter arithmetic.
Turn-budget exhaustion is a transition into `terminal{turns_exhausted}`;
repair-round exhaustion is a transition into
`terminal{repair_exhausted}`; transport failure is a transition into
`terminal{transport_failure}`. The "plain message" case becomes a legal
transition from `awaiting_llm` back to `awaiting_llm` with `turnsUsed +=
1` and no effect other than persisting the assistant text — no policy
hook, no nudge string, no special case in the loop body.

---

## 4. Comparison

| Axis | P-C1 (focused decomposition) | P-C2 (state machine driving the conversation) |
| --- | --- | --- |
| Blast radius | 7 new files + heavy rewrite of `agent-adapter.ts`; deletes `LlmRolePhase`, terminal arms in 3 transports + 1 recorder, `llm-options-factory.ts` shape change, `recovery.ts` whole module, legacy runtime-config migration entries; runtime-config knob rename | Same 7 new files + 3 additional (`attempt-state.ts`, `attempt-step.ts`, `attempt-driver.ts`); `ConversationRunner` swapped for `AttemptDriver`; all P-C1 deletions still apply |
| Readability | Orchestrator is straight-line composition. Per-attempt loop body still contains turn / repair / tool decisions, but factored behind `ConversationRunner` | Orchestrator identical to P-C1; per-attempt logic is a pure step function over an explicit state, making transitions enumerable |
| Test surface | Per-collaborator unit tests; `ConversationRunner` needs a fake LLM + fake verifier; integration via existing transport tests | Pure step function testable with no fakes; driver still needs the same fakes; effect-list assertions enable golden-trace tests of attempt flows |
| Compatibility with Batch A (verifier core + done signal) | Verifier is a constructor-injected collaborator; outcomes flow as values; no exception path remains for contract failures | Same; verifier is invoked via the `run_verifier` effect; transition is explicit |
| Compatibility with Batch B (contract surface) | Contract is a positional argument on `invokeAgent`; orchestrator does not look up by role string | Same; the step function receives `plan.contract` |
| Compatibility with Batch B Position A/B (synthesis stays in adapter) | `AgentToolExecutor` becomes the synthesis owner; runner remains contract-name-blind | Synthesis remains in `AgentToolExecutor`; step function never branches on tool names |
| Implementation cost | Medium. Four of the seven collaborators (`AgentSessionLifecycle`, `CandidateResolver`, `InvocationAttemptRecorder`, `OuterAttemptLoop`) are extractions of existing logic; the runner and projector are mostly moves; orchestrator becomes a short body | Medium-high. Adds the step function and its tests; the driver is roughly the size of the runner; the win is structural, not lines-of-code |
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
P-C2 in this batch also forces an extra round of API alignment with
Batch A's `VerifierOutcome` shape before either batch can ship.

P-C2 is the right next step *after* the contract-verifier batch lands
and the verifier API is stable. The collaborator boundary in P-C1
(`ConversationRunner` is an injected class with a single `run()` method
returning a value-typed outcome) is chosen so that P-C2 lands by
swapping `ConversationRunner` for `AttemptDriver` without touching the
orchestrator, the recorder, the projector, or any of the deletions. This
batch should call that out as a follow-up rather than absorb it now.

Concrete acceptance criteria for the recommended P-C1 implementation:

1. `grep -RnE "phase\s*:\s*['\"](tools|terminal)['\"]|LlmRolePhase|LlmCompleteOptionsTerminal|deriveTerminalTool\b"`
   across `src/` **and** `tests/` returns nothing.
2. `grep -RnE "maxToolTurns|maxRecoveryRetries|sameCandidateRecoveryAttempt|recoveryDelayMs"`
   across `src/` **and** `tests/` returns nothing (the rename to
   `transportRetryDelayMs` is single-shot; no legacy alias survives).
3. `grep -Rn "invokeWithRecovery\|createCancellableRecovery"` across
   `src/` **and** `tests/` returns nothing; `src/agents/recovery.ts` and
   `tests/agents/recovery.test.ts` are deleted.
4. `src/agents/agent-adapter.ts`'s `invokeAgent` method is under 80
   lines, contains no `for (let turn = 0; ...)` loop, contains no
   `appendSessionMessage` call, and contains no role-string equality
   check.
5. The three `envelopeTo*Result` helpers at module scope are deleted.
6. `LlmCompleteOptions` is a single record type (no discriminated
   union), and no source or test file constructs an object with a
   `phase` field.
7. The verdict enum on `llm_invocation_summary` includes
   `turns_exhausted` and `repair_exhausted`.
8. Loading a `.saivage.json` containing `runtime.maxRecoveryRetries` or
   `runtime.recoveryDelayMs` produces a hard validation error naming the
   new key.

---

## 6. Rejected alternatives

- **Keep the `LlmRolePhase` type as a typing hint for transports that
  might want forced-tool turns later.** Rejected: nothing in scope wants
  forced-tool turns, the `tool_choice: { kind: 'required_named' }`
  variant on `LlmToolChoice` already covers that case if it ever
  returns, and keeping a dead type "for future use" is the exact anti-
  pattern the workspace rule forbids.

- **Collapse all three budgets into one "max LLM calls" knob.**
  Rejected: the three axes have genuinely different semantics — turn-
  budget exhaustion is the agent failing to make progress, repair-budget
  exhaustion is the agent failing to comply, transport-budget exhaustion
  is the infrastructure failing the agent. Collapsing them hides the
  distinction the brief asks for and makes the outcome event lose its
  diagnostic value.

- **Keep `contract_mismatch` in `LlmFailure` and route the verifier's
  outcomes through `LlmRequestError` to minimise type churn.** Rejected:
  this is exactly the path that produces today's "abort-but-also-replay"
  contradiction. Batch A's failure-type split is the right move; this
  batch's collaborator boundaries presuppose it.

- **Keep `invokeWithRecovery` and have `InvocationAttemptRecorder`
  share `llm_attempt` emission, `model_issue` persistence, and the
  retry-delay sleep with the wrapper.** Rejected: two owners of the same
  per-attempt effects make the budget table unenforceable and
  reintroduce the outer-replay path that the F08 split is meant to
  remove. The single-owner shape (recorder owns effects, `OuterAttemptLoop`
  owns only the loop) is the only one in which verifier-terminal
  outcomes provably do not consume axis 3.

- **Narrow `invokeWithRecovery` instead of deleting it.** Rejected: the
  only production caller is `agent-adapter.ts`; once the wrapper is
  narrowed to a thin attempt-array runner with no effects, it is
  identical to `OuterAttemptLoop` but lives in a module named for
  effects it no longer owns. Renaming + relocating + slimming is a
  delete + add. Deleting `src/agents/recovery.ts` outright also lets the
  `RecoveryContext.directive` prose string be deleted, which removed
  another redaction-relevant free-form-text surface from the hot path.

- **Sans-IO core (move the entire per-attempt loop into a pure module
  that emits effect descriptions, with a thin imperative shell).**
  Rejected: cancellation, abort controllers, and per-session message
  persistence interact with the loop on every turn. A Sans-IO split
  forces those interactions through additional event/effect pairs with
  no readability win over the §3 state machine, which keeps the I/O in
  a driver but still gets the explicit-transitions benefit.

- **Make `AgentInvocationPlan` own the candidate chain (a single resolve
  at construction time).** Rejected by the analysis review: candidate
  availability genuinely changes between outer attempts, so the chain
  must be re-resolved per outer attempt. The `CandidateResolver`
  collaborator owns both call sites and returns the chain + skip
  snapshot as one atomic value, which solves the concurrency hazard
  without freezing the chain.

- **Drop `InvocationOutcomeProjector` and put the lifecycle transitions
  inline in the orchestrator after the outer loop returns.** Rejected:
  that is what `invokeAgent` does today and it is exactly the role-
  string-keyed ladder that F10 calls out. Moving the projection onto the
  contract value via `contract.projectStatus(...)` is the F10 fix; the
  projector exists to host that call and the `llm_invocation_summary`
  emission together so the orchestrator stays straight-line.

- **Keep the inline `model_repair` nudge from commit `a2a6f05` because
  Batch A may not ship in the same window.** Rejected per the brief.
  If Batch A slips, `ConversationRunner` still treats plain messages as
  in-progress traffic; the nudge is gone either way. The verifier (when
  it lands) is the one place where any agent-facing repair message is
  generated.

- **Preserve the legacy-runtime migration arms for `maxRecoveryRetries`
  and `recoveryDelayMs` in `config-schema.ts` for one release.**
  Rejected per the project rule: no deprecate-and-keep at the runtime-
  config boundary. The migration entries are deleted in the same change
  set as the schema rename, and old configs fail loud at startup with a
  validation error that names the new key.
