# Batch C — Scaffolding Cleanup: Functional Analysis

Scope: the three issues that together describe leftover scaffolding in the
agent-invocation layer — a dead phase type, two un-reconciled budgets, and a
single method that owns far too many roles. All file references are
workspace-relative to `saivage-v3/`.

- F01 — per-turn `tools` vs `terminal` phase machinery is dead architecture.
- F08 — `maxToolTurns` and `maxRecoveryRetries` are two budgets pretending to
  be one.
- F10 — `AgentAdapter` owns envelope projection, status mapping, and session
  lifecycle in one method.

These three issues are scaffolding/leaky-abstraction concerns rather than
behavioural changes. They are blockers for Batch A / Batch B because (a)
removing the phase type unblocks declaring the contract once at invocation
construction time; (b) collapsing the two budgets is a precondition for
naming the "free agent turns" vs "verify-and-repair rounds" split; and
(c) decomposing `invokeAgent` is required to give the contract verifier a
small enough home to live in.

---

## 1. Functional analysis

### 1.1 F01 — every site that mentions `tools` / `terminal` phase

The `LlmRolePhase` type is exported once and threaded through six files plus
two test fixtures and one probe script. The following table enumerates every
live site, and classifies it as live or dead given the current hot-path
shape (commit `a2a6f05` and after).

| Site | Line | Code shape | Live? |
| --- | --- | --- | --- |
| [src/agents/llm-options-factory.ts](../../../../src/agents/llm-options-factory.ts#L14) | L14 | `export type LlmRolePhase = 'tools' \| 'terminal';` | dead (only the `'tools'` branch is constructed) |
| [src/agents/llm-options-factory.ts](../../../../src/agents/llm-options-factory.ts#L36-L44) | L36-L44 | `if (phase === 'tools') { ... return opts; }` | live |
| [src/agents/llm-options-factory.ts](../../../../src/agents/llm-options-factory.ts#L46-L65) | L46-L65 | terminal branch with `expectedName` / `tools.length !== 1` invariants and explicit `LlmCompleteOptionsTerminal` shape | dead in production (no caller passes `'terminal'`) |
| [src/agents/llm-options-factory.ts](../../../../src/agents/llm-options-factory.ts#L68-L72) | L68-L72 | `deriveTerminalTool(opts)` switches on `opts.phase === 'terminal'` | superseded by `deriveTerminalToolFromOptions` in `llm-recording.ts` and unused elsewhere |
| [src/agents/llm-contracts.ts](../../../../src/agents/llm-contracts.ts#L43-L52) | L43-L52 | `LlmCompleteOptionsTools` / `LlmCompleteOptionsTerminal` discriminated union | live as a type, but the `Terminal` member is never constructed |
| [src/agents/agent-adapter.ts](../../../../src/agents/agent-adapter.ts#L297-L302) | L297 | builds `turnTools = [...tools, terminalToolDef]` and calls `buildLlmOptions(role, 'tools', turnTools, ...)` every single turn | live (sole production caller of `buildLlmOptions`) |
| [src/agents/llm-provider-gateway.ts](../../../../src/agents/llm-provider-gateway.ts#L42) | L42 | `const tools = opts.phase === 'terminal' ? [opts.terminalToolDefinition] : opts.tools;` | dead-branch (the `'terminal'` arm is never reached in production; it survives only for tests) |
| [src/agents/llm-openai-chat-gateway.ts](../../../../src/agents/llm-openai-chat-gateway.ts#L183-L189) | L183-L189 | duplicate `opts.phase === 'terminal'` branch for OpenAI-chat transport | dead-branch in production |
| [src/agents/llm-openai-codex-gateway.ts](../../../../src/agents/llm-openai-codex-gateway.ts#L122-L128) | L122-L128 | duplicate `opts.phase === 'terminal'` branch for OpenAI-codex transport | dead-branch in production |
| [src/agents/llm-recording.ts](../../../../src/agents/llm-recording.ts#L64-L67) | L64-L67 | `deriveTerminalToolFromOptions` switches on `opts.phase === 'terminal'` first | live (recorder still works), but the first arm is unreachable in production |
| [src/contracts/llm-exchange.ts](../../../../src/contracts/llm-exchange.ts#L36) | L36 | `export type TerminalToolName` exported from the contract package | live and useful (it is the projection consumers depend on) |
| [src/scripts/probe-llm-contract.ts](../../../../src/scripts/probe-llm-contract.ts#L86-L90) | L86-L90 | hand-rolled probe that exercises both `'tools'` and `'terminal'` | the only production-shaped caller of `phase === 'terminal'` |
| [tests/agents/llm-openai-chat-gateway-request.test.ts](../../../../tests/agents/llm-openai-chat-gateway-request.test.ts#L48) | L48 | constructs `{ phase: 'terminal', ... }` directly | test-only |
| [tests/agents/llm-openai-codex-gateway-request.test.ts](../../../../tests/agents/llm-openai-codex-gateway-request.test.ts#L48) | L48 | constructs `{ phase: 'terminal', ... }` directly | test-only |

Live / dead summary:

- **Live**: the `'tools'` branch of `buildLlmOptions`, the `LlmCompleteOptionsTools`
  type, `deriveTerminalTool` / `deriveTerminalToolFromOptions` (only the
  `tool_choice.kind === 'required_named'` arm), `TerminalToolName` exported
  from `src/contracts/llm-exchange.ts`.
- **Dead in production**: `LlmRolePhase = 'terminal'`, `LlmCompleteOptionsTerminal`,
  `buildLlmOptions(..., 'terminal', ...)`, the four `opts.phase === 'terminal'`
  branches across the two gateways and the provider gateway, the first arm
  of `deriveTerminalToolFromOptions`, and the corresponding test scaffolding.
- **Probe-only**: `src/scripts/probe-llm-contract.ts` is the sole production
  shape that still constructs a `'terminal'` options object. It is a
  diagnostic CLI, not part of the runtime hot path.

Note that even within the live `'tools'` branch the adapter's call
([agent-adapter.ts](../../../../src/agents/agent-adapter.ts#L297-L302)) merges
the terminal tool into the regular tool list every turn. This makes the phase
distinction not merely unused but actively misleading: every turn carries
the same tool list shape, so there is no "tools phase" vs "terminal phase" at
all — there is one phase with one tool list.

The terminal tool *name* (`TerminalToolName` in
[src/contracts/llm-exchange.ts](../../../../src/contracts/llm-exchange.ts#L36))
remains useful because the recorder, the gateway adapters, and the
`llm_invocation_summary` event refer to it after the fact. Removing the
phase split does not remove the concept of "which tool the agent used to
declare its result"; it removes the per-turn switching that pretended a
separate options shape was needed.

### 1.2 F08 — composition of `maxToolTurns`, `maxRecoveryRetries`, `recoveryDelayMs`, and the same-candidate counter

Four independent counters / budgets exist on the hot path:

- `maxToolTurns` (default 16) — read inline at
  [agent-adapter.ts](../../../../src/agents/agent-adapter.ts#L297), caps the
  inner `for (let turn = 0; ... turn++)` loop. Counts every LLM call that
  resulted in a plain message or a non-terminal tool batch. Reset on each
  candidate.
- `maxRecoveryRetries` (default 3) — turned into `maxAttempts = maxRetries + 1`
  inside
  [recovery.ts](../../../../src/agents/recovery.ts#L99). Caps the outer
  `invokeWithRecovery` loop, which replays the *whole* `agentFn` (including
  resolving candidates again, etc.). Reset only when the invocation finishes.
- `recoveryDelayMs` (default 60000) — used in two places. (a) Constant delay
  between outer recovery replays
  ([recovery.ts](../../../../src/agents/recovery.ts#L173)). (b) Per-attempt
  `retryDelayMs` for `retry_same_after_delay` decisions
  ([invocation-recovery-policy.ts](../../../../src/agents/invocation-recovery-policy.ts#L137)).
- `sameCandidateRecoveryAttempt` — local counter inside the per-candidate
  `for (;;)` loop in
  [agent-adapter.ts](../../../../src/agents/agent-adapter.ts#L283), passed to
  the policy as `attempt`. Only incremented on
  `retry_same_after_delay`
  ([agent-adapter.ts](../../../../src/agents/agent-adapter.ts#L453-L456)).

Concrete failure-class table — who increments what when an attempt fails.
"+1 outer" means the outer `invokeWithRecovery` replays from scratch; "+1
same-candidate" means the policy sends control back to the same candidate
inside the same `agentFn` call; "advance candidate" means the inner `for ...
of candidateChain` moves to the next; "+1 tool turn" means another iteration
of the inner `for (turn = 0; ...)` loop.

| Failure class (from [invocation-recovery-policy.ts](../../../../src/agents/invocation-recovery-policy.ts#L94-L153)) | Policy action | Same-candidate counter | Outer counter | Tool-turn counter |
| --- | --- | --- | --- | --- |
| `auth_permanent` | `failover_without_cooldown` | n/a (break inner loop) | unchanged | n/a |
| `capability_mismatch` | `failover_without_cooldown` | n/a | unchanged | n/a |
| `rate_limit` | `cooldown_and_failover` | n/a | unchanged | n/a |
| `server_transient` / `timeout` | `cooldown_and_failover` | n/a | unchanged | n/a |
| `contract_mismatch` (any subtype) | `fail_invocation` with `abort=true` | n/a | not incremented — the outer wrapper *sees* the throw, increments its own attempt counter, **and replays** unless `maxAttempts` reached | n/a |
| `token_budget_exceeded` | `failover_without_cooldown` | n/a | unchanged | n/a |
| `parse_error` while `attempt <= maxRecoveryRetries` | `retry_same_after_delay` (delay = `recoveryDelayMs`) | +1 same-candidate | unchanged | n/a |
| `parse_error` after exhausting same-candidate budget | `failover_without_cooldown` | n/a | unchanged | n/a |
| `cancelled` | `abort_without_retry` | n/a | not retried (abort) | n/a |
| `unknown` | `cooldown_and_failover` | n/a | unchanged | n/a |
| no candidates resolved | `abort_without_retry` from `decideNoCandidates` | n/a | not retried | n/a |
| inner loop exhausted with `finalEnvelope === null` (synthetic `contract_mismatch{terminal_tool_missing}` at [agent-adapter.ts](../../../../src/agents/agent-adapter.ts#L386)) | `fail_invocation` `abort=true` | n/a | replayed by outer wrapper (same as any `contract_mismatch`) | the +1 happened inside the inner loop and is never reported |
| plain `message` response (post-`a2a6f05`) | not classified at all — handled inline at [agent-adapter.ts](../../../../src/agents/agent-adapter.ts#L304-L320) | n/a | unchanged | +1 tool turn |
| non-terminal tool batch | not a failure | n/a | unchanged | +1 tool turn |

Three structural problems fall out of the table:

1. The same-candidate counter is wired into the policy as the generic
   `attempt` field
   ([agent-adapter.ts](../../../../src/agents/agent-adapter.ts#L446) passes
   `attempt: sameCandidateRecoveryAttempt`), while the outer
   `invokeWithRecovery` passes its *own* `recoveryCtx.attempt` to the
   `decideSuccess` / `decideNoCandidates` paths
   ([agent-adapter.ts](../../../../src/agents/agent-adapter.ts#L392),
   [L272](../../../../src/agents/agent-adapter.ts#L272)). The same policy
   field carries different semantics depending on whether the caller is
   the success site or the failure site.
2. `contract_mismatch` is classified as `fail_invocation` + `abort=true`
   ([invocation-recovery-policy.ts](../../../../src/agents/invocation-recovery-policy.ts#L130)),
   which **exits the per-candidate `for (;;)` loop via `throw lastError`**
   ([agent-adapter.ts](../../../../src/agents/agent-adapter.ts#L460-L463)).
   The throw escapes the inner `agentFn` and is caught by the outer
   `invokeWithRecovery`, which then replays the entire candidate chain.
   So the "abort" actually triggers an outer recovery cycle — the inner
   "abort" semantics and the outer "retry" semantics directly contradict
   each other.
3. The `maxToolTurns` exhaustion path
   ([agent-adapter.ts](../../../../src/agents/agent-adapter.ts#L386)) is
   indistinguishable on the wire from a real `contract_mismatch`. There is
   no event, no telemetry attribute, and no policy hook that says "we ran
   out of free turns" — it is reported as if the agent emitted a malformed
   envelope on turn 0.

In summary, the runtime has one *exhaustion* concept (turns ran out) and one
*give-up* concept (we tried this candidate too many times), but four counters
implement them, and the wiring lets the outer wrapper retry exactly the
class of failure (`contract_mismatch`) that the policy claims is fatal.

### 1.3 F10 — responsibilities currently fused into `AgentAdapter.invokeAgent`

`invokeAgent` is a single method spanning
[agent-adapter.ts](../../../../src/agents/agent-adapter.ts#L225-L497).
The following responsibilities are interleaved inside it, in roughly the
order they execute:

1. **Pre-flight role housekeeping**
   ([L226-L228](../../../../src/agents/agent-adapter.ts#L226-L228)) —
   `resetOnRoleChange`, model-params lookup, role tool build, capability
   request construction.
2. **Candidate resolution and "no candidates" diagnosis**
   ([L233-L249](../../../../src/agents/agent-adapter.ts#L233-L249)) — calls
   `router.resolve`, then if empty constructs a `decideNoCandidates` policy
   call and throws the resulting message string.
3. **Session creation, single-active-session assertion, and session-started
   event**
   ([L250-L253](../../../../src/agents/agent-adapter.ts#L250-L253)).
4. **System-prompt mutation** via `applySelfCheck`
   ([L255](../../../../src/agents/agent-adapter.ts#L255)) — bypasses the
   contract surface to inject self-check prose into the system prompt.
5. **Context-message persistence**
   ([L256](../../../../src/agents/agent-adapter.ts#L256)).
6. **Recovery-options construction and `persistFailure` closure**
   ([L257](../../../../src/agents/agent-adapter.ts#L257)) — builds the
   options bag that `invokeWithRecovery` consumes, including a closure that
   writes `model_issue` messages to the session log.
7. **Attempt-recording state** — `attemptOutcomeCount`,
   `lastSucceededAttemptPayload`, `lastFailedFailureClass`,
   `recordAttemptOutcome`
   ([L258-L267](../../../../src/agents/agent-adapter.ts#L258-L267)) — the
   `recordAttemptOutcome` closure emits `llm_attempt` events on both the
   event logger and the event bus.
8. **Per-candidate loop** with its own "same-candidate recovery attempt"
   counter
   ([L283](../../../../src/agents/agent-adapter.ts#L283)).
9. **Cancellation polling** at the top of every inner-loop iteration
   ([L284](../../../../src/agents/agent-adapter.ts#L284)).
10. **Per-turn LLM call** — model update on the session
    ([L289](../../../../src/agents/agent-adapter.ts#L289)), `model_recovered`
    diagnostic injection on retry
    ([L286](../../../../src/agents/agent-adapter.ts#L286)), abort-controller
    tracking
    ([L287-L288](../../../../src/agents/agent-adapter.ts#L287-L288)), tool
    list assembly with the terminal tool appended
    ([L294-L300](../../../../src/agents/agent-adapter.ts#L294-L300)), the
    actual `llmCallFn` call
    ([L302-L304](../../../../src/agents/agent-adapter.ts#L302-L304)).
11. **Plain-message handling** — the tactical nudge from commit `a2a6f05`,
    crafting the nudge string inline and persisting a `model_repair` row
    ([L306-L320](../../../../src/agents/agent-adapter.ts#L306-L320)).
12. **Tool-call persistence as `tool_call` messages**
    ([L323-L328](../../../../src/agents/agent-adapter.ts#L323-L328)).
13. **Terminal-tool validation** and envelope extraction
    ([L331-L345](../../../../src/agents/agent-adapter.ts#L331-L345)), with
    inline `LlmRequestError(contract_mismatch / tool_arguments_invalid_json)`
    construction.
14. **Non-terminal tool execution** via `toolExecutor.processToolCall`
    ([L348-L359](../../../../src/agents/agent-adapter.ts#L348-L359)).
15. **Deferred `activate_card` envelope synthesis** — including dependency
    inspection through a freshly-allocated `CardStore`, blocked-reason
    aggregation, and the construction of a synthetic
    `PlannerResult` (`status: 'continue'` or `'blocked'`)
    ([L361-L381](../../../../src/agents/agent-adapter.ts#L361-L381)). This
    is planner-specific logic inside a generic per-role loop.
16. **Tool-turn exhaustion** — converted into a synthetic
    `contract_mismatch{terminal_tool_missing}`
    ([L386](../../../../src/agents/agent-adapter.ts#L386)).
17. **Final-envelope projection** — `parseEnvelope(finalEnvelope)`
    ([L391](../../../../src/agents/agent-adapter.ts#L391)) and `finalResponse`
    text persistence
    ([L389](../../../../src/agents/agent-adapter.ts#L389)).
18. **Per-attempt success bookkeeping** — `decideSuccess` policy call,
    candidate-availability mark, success `llm_attempt` event, cancellation
    clear, return
    ([L392-L419](../../../../src/agents/agent-adapter.ts#L392-L419)).
19. **Per-attempt failure bookkeeping** — `decideFailure` policy call,
    candidate-availability mark, `model_issue` redaction and append, failure
    `llm_attempt` event, cooldown computation, abort-vs-continue decision,
    retry-delay sleep, same-candidate counter increment
    ([L421-L465](../../../../src/agents/agent-adapter.ts#L421-L465)).
20. **Outer invocation summary** — `verdict` derivation, `summaryPayload`
    construction, `llm_invocation_summary` event on both channels
    ([L468-L482](../../../../src/agents/agent-adapter.ts#L468-L482)).
21. **Status-to-session-lifecycle projection**
    ([L483-L495](../../../../src/agents/agent-adapter.ts#L483-L495)) — for
    a successful attempt: if `role === 'planner' && status === 'continue'`
    call `markSessionWaiting`; if `role === 'planner' && status === 'blocked'`
    call `completeSession(..., 'blocked')`; if `role === 'executor' && status
    === 'failed'` call `completeSession(..., 'failed')`; otherwise
    `completeSession(..., 'done')`. For an unsuccessful attempt:
    `completeSession(..., 'failed')` and rethrow.
22. **Outbound redaction** — `redactModelIssueText` and
    `redactProviderErrorMessage` are called at five sites inside the method
    ([L450](../../../../src/agents/agent-adapter.ts#L450),
    [L441](../../../../src/agents/agent-adapter.ts#L441),
    [L442](../../../../src/agents/agent-adapter.ts#L442),
    [L374](../../../../src/agents/agent-adapter.ts#L374),
    [L377](../../../../src/agents/agent-adapter.ts#L377)).

The three envelope projections themselves
([agent-adapter.ts](../../../../src/agents/agent-adapter.ts#L49-L62)) live
at module scope and are passed as the `parseEnvelope` argument to
`invokeAgent`; they are static maps from envelope to typed result and there
is no slot for a caller to supply a different one for a non-standard role.

Status projection (item 21) is the single point where a `PlannerResult.status`
or `ExecutorResult.status` becomes a `SessionStatus`
(`'active' | 'waiting' | 'done' | 'failed' | 'blocked'`). The mapping is
hardcoded by role string comparison, the reviewer role has no branch (it
silently falls through to `'done'`), and the inverse — a planner result that
is neither `continue` nor `blocked` and is therefore "done" — is implicit.

---

## 2. Target behaviour (informal)

### 2.1 Where the phase concept (or its replacement) belongs

The phase split should disappear entirely from the options factory and from
the type system. The runtime has one operational mode for any contract-bearing
role: "here is the system prompt, the tool list (including the result-emitting
tool), and a recipe for what counts as done". The replacement is a single
contract object declared once at invocation construction time, carrying:

- the result tool name and JSON-schema parameters (currently `ROLE_RESULT_TOOL_NAMES[role]`
  and `ROLE_RESULT_TOOLS[role]`);
- the predicate that decides whether a turn's tool-call batch satisfies the
  contract;
- the projection from the envelope payload to the typed result.

`buildLlmOptions` becomes a thin wrapper that always emits the
`'tools' + tool_choice: auto` shape. `LlmCompleteOptionsTerminal`,
`LlmCompleteOptionsTools`, `LlmRolePhase`, and `deriveTerminalTool` are
deleted. The terminal-tool *name* survives as a piece of contract metadata
exposed by the contract object, not as a discriminator on the per-turn
options object. The gateway-side `opts.phase === 'terminal'` branches in
`src/agents/llm-provider-gateway.ts`,
`src/agents/llm-openai-chat-gateway.ts`,
`src/agents/llm-openai-codex-gateway.ts`, and the first arm of
`deriveTerminalToolFromOptions` in `src/agents/llm-recording.ts` go with it.
The two transport-request tests and `src/scripts/probe-llm-contract.ts` are
rewritten against the single-shape options object.

### 2.2 The single canonical budget concept

The two budgets should be named for what they actually mean in the contract-
verifier model:

- **Free-turn budget** — how many LLM calls the agent gets between
  contract-verification checkpoints. The unit is "tool turn". Lives next to
  the contract verifier itself, not next to the recovery harness. Exhaustion
  is a first-class event with its own diagnosis — "agent did not emit
  contract after N free turns" — and a first-class observability signal
  (e.g. a `verdict` discriminator on the existing
  `llm_invocation_summary` event), not a synthetic
  `contract_mismatch{terminal_tool_missing}`.
- **Verify-and-repair-round budget** — how many times the runtime is willing
  to send the agent a structured non-compliance report and ask it to bring
  the result into compliance. The unit is "repair round" (one
  verify + nudge + agent reply cycle). Lives in the contract verifier. This
  is the *only* budget that recovery-harness-style "replay the whole agent
  function" semantics should apply to.

The current `maxRecoveryRetries` / `recoveryDelayMs` pair becomes a separate,
transport-level concern attached to `invokeWithRecovery`: it caps how many
times the entire candidate chain is retried in response to *transport-class*
failures (transient HTTP, timeout, rate-limit cooldown rollover). It must
*not* be triggered by `contract_mismatch`. The same-candidate counter
disappears as a free-standing concept; per-candidate same-call retries for
parse errors are an attribute of the recovery policy table, not a counter
that the adapter advances inline.

Total cost is a third, orthogonal axis (token-budget enforcement) and is
already partially modelled by the `token_budget_exceeded` failure kind in
[invocation-recovery-policy.ts](../../../../src/agents/invocation-recovery-policy.ts#L132).
It stays where it is.

### 2.3 The decomposition of `invokeAgent` into named collaborators

The 21 responsibilities listed in §1.3 partition into five named
collaborators, all called by a much smaller top-level
`AgentAdapter.invokeAgent` orchestrator. None of them need to know about
"planner / executor / reviewer" string roles — they are parameterised by the
contract object from §2.1.

1. **`AgentInvocationPlan`** (or similar) — pure-data record built once per
   call. Owns the candidate chain, the capability request, the resolved tool
   list, the model params, the system prompt (with self-check already
   applied), the contract object, the free-turn budget, and the repair-round
   budget. Replaces items 1, 2, 4 from §1.3.
2. **`AgentSessionLifecycle`** — owns session creation, session-started /
   session-cancelled events, abort-controller registration, and the
   `persistFailure` closure (items 3, 5, 9). Already partially present as
   `AgentSessionCoordinator`
   ([agent-session-coordinator.ts](../../../../src/agents/agent-session-coordinator.ts));
   absorbs the inline session-create call and the `persistFailure` closure
   that currently lives in `invokeAgent`.
3. **`ContractVerifier`** (the new core; designed in Batch A) — owns the
   inner free-turn loop, the per-turn LLM call, plain-message handling,
   tool-call persistence, non-terminal tool execution via `AgentToolExecutor`,
   terminal-tool extraction, free-turn-budget exhaustion, the
   verify-and-repair conversation, and the final envelope projection
   (items 10-17, 22 partially). Returns either a typed result or a typed
   non-compliance / exhaustion diagnostic.
4. **`InvocationAttemptRecorder`** — owns the `recordAttemptOutcome` closure,
   the success / failure `llm_attempt` events, the `decideSuccess` /
   `decideFailure` policy calls, the candidate-availability marking, the
   `model_recovered` / `model_issue` injections, the retry-delay sleep, and
   the abort-vs-continue decision (items 7, 18, 19). Wraps the
   `invokeWithRecovery` harness.
5. **`InvocationOutcomeProjector`** — given the result of the recovery
   harness, builds the `llm_invocation_summary` event and applies the
   status-to-session-lifecycle projection (items 20, 21). The
   role-to-lifecycle mapping table moves here as an explicit function
   keyed by the contract object, not by `role === 'planner'` string
   comparisons.

The deferred-`activate_card` envelope synthesis (item 15) is *not* part of
this decomposition's core. It belongs in the planner-control surface — i.e.
inside `PlannerControlExecutor` and / or the planner contract object as a
per-tool post-processor — so that the `ContractVerifier` only ever sees a
clean envelope or no envelope. F06 covers this in detail; from the F10
perspective, the cleanup means the contract verifier never branches on tool
names.

The three module-scope `envelopeTo*Result` helpers
([agent-adapter.ts](../../../../src/agents/agent-adapter.ts#L49-L62)) collapse
into the `projection` field of the per-role contract objects defined in
Batch A. There is no longer a `parseEnvelope` argument on the inner method.

---

## 3. Cross-cutting constraints

### 3.1 Provider / router

- Candidate resolution (`router.resolve`) is called twice in the current
  hot path: once at the top of `invokeAgent`
  ([L233](../../../../src/agents/agent-adapter.ts#L233)) and once inside
  `agentFn` on every outer recovery attempt
  ([L271](../../../../src/agents/agent-adapter.ts#L271)). The decomposition
  must keep the second call (to pick up candidate-availability changes
  between recovery rounds) but should not duplicate the "no candidates"
  diagnosis — currently both sites construct a `decideNoCandidates` call
  with the same arguments shape.
- `router.getLastCapabilitySkips()` is read at four distinct sites
  ([L240](../../../../src/agents/agent-adapter.ts#L240),
  [L274](../../../../src/agents/agent-adapter.ts#L274),
  [L411](../../../../src/agents/agent-adapter.ts#L411),
  [L443](../../../../src/agents/agent-adapter.ts#L443)). The router-side
  "last skips" state is implicitly tied to the most recent `resolve` call,
  so the new decomposition must keep the read close to the
  resolve call or capture the value alongside the candidate chain.
- The capability request is built once from the tool list and never
  re-derived
  ([L229-L232](../../../../src/agents/agent-adapter.ts#L229-L232)). It can
  move into the `AgentInvocationPlan` record cleanly.

### 3.2 Recovery harness

- `invokeWithRecovery` already returns an `InvocationAttempt[]` array
  ([recovery.ts](../../../../src/agents/recovery.ts#L93-L177)) — the
  outcome projector can derive `attempts_count` from the array length
  instead of the parallel `attemptOutcomeCount` integer that
  `invokeAgent` currently maintains
  ([agent-adapter.ts](../../../../src/agents/agent-adapter.ts#L260)).
- `RecoveryContext.directive`
  ([recovery.ts](../../../../src/agents/recovery.ts#L122-L127)) is a
  hardcoded prose string. After the budget split (§2.2), the wrapper-level
  directive is only emitted for transport-class retries; the agent-facing
  repair message is the contract verifier's responsibility.
- `createCancellableRecovery`
  ([recovery.ts](../../../../src/agents/recovery.ts#L184-L210)) is not
  currently used by `invokeAgent` (cancellation flows through
  `AgentSessionCoordinator` instead). It can be deleted along with the rest
  of the dead recovery scaffolding, or repurposed for the new transport-only
  retry harness.

### 3.3 Session-persistence side effects

- `appendPersistentMessage` and `appendSessionMessage` are called from at
  least six distinct sites inside `invokeAgent` for six different `kind`
  values (`text`, `tool_call`, `tool_result`, `tool_error`, `model_issue`,
  `model_repair`, `model_recovered`). The decomposition must keep
  message-kind responsibility close to the actor that produced the message
  (the contract verifier for `text` / `tool_call` / `model_repair`, the
  attempt recorder for `model_issue` / `model_recovered`).
- `markSessionWaiting`, `completeSession`, and `setSessionStatus` are called
  from `invokeAgent` and from the embedded `reviewer` closure passed to
  `PlannerControlExecutor`
  ([agent-adapter.ts](../../../../src/agents/agent-adapter.ts#L110-L114)).
  The outcome projector must own the post-invocation transitions; the
  in-flight `markSessionWaiting` / `setSessionStatus` toggling inside the
  reviewer closure is a separate (planner-control-driven) concern that
  should not be conflated.
- `updateSessionModel` is called every same-candidate attempt
  ([L289](../../../../src/agents/agent-adapter.ts#L289)) — the new
  per-attempt collaborator owns it.

### 3.4 eventBus / EventLogger observability

The following event shapes are emitted from `invokeAgent` or its direct
collaborators and must remain wire-compatible across the redecomposition:

- `session_started`, `session_cancelled`, `session_force_cancelled`
  ([agent-session-coordinator.ts](../../../../src/agents/agent-session-coordinator.ts#L45-L46),
  [L60-L61](../../../../src/agents/agent-session-coordinator.ts#L60-L61),
  [L70-L73](../../../../src/agents/agent-session-coordinator.ts#L70-L73)) —
  schema in
  [src/schemas/validators.ts](../../../../src/schemas/validators.ts#L163-L169)
  and types in
  [src/schemas/types.ts](../../../../src/schemas/types.ts#L153-L165).
- `llm_attempt` — emitted twice (success / failure) inside `recordAttemptOutcome`
  ([agent-adapter.ts](../../../../src/agents/agent-adapter.ts#L265-L266)).
  Payload type
  `LlmAttemptPayload`; consumed by the runtime ledger
  ([runtime.ts](../../../../src/runtime/runtime.ts#L487) registers it as the
  trigger that updates `current_agent_session_id`, but that is `session_started`;
  the ledger also persists `llm_attempt` rows).
- `llm_invocation_summary` — emitted once per invocation
  ([agent-adapter.ts](../../../../src/agents/agent-adapter.ts#L481-L482)),
  payload includes `attempts_count`, `total_duration_ms`, `verdict`,
  `final_terminal_tool`, `last_failure_class`. The redecomposed projector
  must keep this surface; it is the single point of truth for invocation
  outcome in the runtime ledger.
- `model_repair`, `model_issue`, `model_recovered` are not events; they are
  message rows persisted with those `kind` values. They round-trip via the
  session-message history and the analyst surface reads them back. The
  contract verifier and the attempt recorder must continue to emit them
  with the same `kind` strings.

### 3.5 Redaction

Five redaction sites inside `invokeAgent`
([L450](../../../../src/agents/agent-adapter.ts#L450),
[L441](../../../../src/agents/agent-adapter.ts#L441),
[L442](../../../../src/agents/agent-adapter.ts#L442),
[L374](../../../../src/agents/agent-adapter.ts#L374),
[L377](../../../../src/agents/agent-adapter.ts#L377)) call
`redactTextForOutbound(..., 'model.issue', ...)`. After decomposition, the
contract verifier owns the two synthetic-envelope sites; the attempt
recorder owns the three failure-message sites. The `'model.issue'` policy
name is the contract; the call sites are not.

---

## 4. Open questions for the design phase

1. **Free-turn budget unit.** Is "tool turn" still the right unit if the
   verifier is allowed to interrupt the agent mid-batch (e.g. drop a
   non-terminal tool result and inject a verification message)? Two
   alternatives: (a) count LLM calls only; (b) count tool turns but allow
   the verifier to consume one budget unit per repair injection. Choice
   affects how the budget composes with the existing
   `maxToolTurns` runtime-config knob.
2. **Survival of `maxToolTurns` config name.** The runtime config currently
   exposes `maxToolTurns` and `maxRecoveryRetries`. After the split into
   "free-turn budget" and "repair-round budget", the config keys should be
   renamed; pick names now to avoid a second rename pass.
3. **Same-candidate retry vs candidate failover for `parse_error`.** The
   current policy distinguishes them by the
   `attempt <= maxRecoveryRetries` test
   ([invocation-recovery-policy.ts](../../../../src/agents/invocation-recovery-policy.ts#L141-L145)).
   In the contract-verifier model, "parse_error" of the *terminal* tool
   args is a contract violation and belongs in the repair budget. Should
   transport-side parse errors (HTTP body malformed, etc.) keep their
   same-candidate retry, or fold into the generic transport recovery?
4. **Reviewer status branch.** The current status projection has no
   reviewer arm and silently falls through to `'done'`
   ([agent-adapter.ts](../../../../src/agents/agent-adapter.ts#L483-L492)).
   Is the reviewer ever expected to produce `'failed'` or `'blocked'`
   sessions, or is `'done'` always correct? The Batch B design needs an
   answer before the projector can be made exhaustive.
5. **Deferred-activation envelope synthesis ownership.** F06 will decide
   the long-term home of this logic. For F10 specifically: does the
   contract verifier need to know about the "only deferred `activate_card`
   in this turn" case at all, or can it be 100% removed from the verifier
   and pushed into `PlannerControlExecutor` (which would then return a
   "the planner is now blocked / continuing on its behalf" outcome that the
   verifier treats as an envelope source)?
6. **Tests that construct `{ phase: 'terminal' }` directly.** Two transport
   tests
   ([tests/agents/llm-openai-chat-gateway-request.test.ts](../../../../tests/agents/llm-openai-chat-gateway-request.test.ts#L48)
   and
   [tests/agents/llm-openai-codex-gateway-request.test.ts](../../../../tests/agents/llm-openai-codex-gateway-request.test.ts#L48))
   exercise the dead transport branches directly. Once the branches are
   deleted, do we keep the tests at all (rewriting them against the single
   options shape), or is the underlying transport contract already covered
   by other tests in the suite? Quick audit needed during design.
7. **`probe-llm-contract.ts` survival.** It is the only production-shaped
   caller of the `'terminal'` phase. Does the diagnostic CLI still serve a
   purpose after the phase split, and if so, what does it probe?
