# Batch C — Scaffolding Cleanup: Functional Analysis

Scope: three issues that together describe leftover scaffolding in the
agent-invocation layer — a dead phase type, two un-reconciled budgets, and a
single method that owns far too many roles. All file references are
workspace-relative to `saivage-v3/`.

- F01 — per-turn `tools` vs `terminal` phase machinery is dead architecture.
- F08 — `maxToolTurns` and `maxRecoveryRetries` are two budgets pretending to
  be one.
- F10 — `AgentAdapter` owns envelope projection, status mapping, and session
  lifecycle in one method.

These are scaffolding / leaky-abstraction concerns rather than behavioural
changes. They unblock the contract-verifier work: (a) removing the phase type
unblocks declaring the contract once at invocation construction time;
(b) collapsing the two budgets is a precondition for naming the
"free agent turns" vs "verify-and-repair rounds" split; and (c) decomposing
`invokeAgent` is required to give the contract verifier a small enough home
to live in.

---

## 1. Functional analysis

### 1.1 F01 — every site that mentions `tools` / `terminal` phase

The `LlmRolePhase` type is exported once and threaded through six runtime
files plus two transport-request tests and one probe script. The following
table enumerates every site and classifies it against the current hot-path
shape.

| Site | Code shape | Live? |
| --- | --- | --- |
| [src/agents/llm-options-factory.ts#L13](../../../../src/agents/llm-options-factory.ts#L13) | `export type LlmRolePhase = 'tools' \| 'terminal';` | dead-type (only the `'tools'` branch is constructed in production) |
| [src/agents/llm-options-factory.ts#L35-L44](../../../../src/agents/llm-options-factory.ts#L35-L44) | `if (phase === 'tools') { ... return opts; }` | live |
| [src/agents/llm-options-factory.ts#L45-L64](../../../../src/agents/llm-options-factory.ts#L45-L64) | terminal branch with `expectedName` / `tools.length !== 1` invariants and explicit `LlmCompleteOptionsTerminal` shape | dead in production (no caller passes `'terminal'`) |
| [src/agents/llm-options-factory.ts#L66-L69](../../../../src/agents/llm-options-factory.ts#L66-L69) | `deriveTerminalTool(opts)` switches on `opts.phase === 'terminal'` | superseded by `deriveTerminalToolFromOptions` in `llm-recording.ts`; no remaining production caller |
| [src/agents/llm-contracts.ts#L42-L54](../../../../src/agents/llm-contracts.ts#L42-L54) | `LlmCompleteOptionsTools` / `LlmCompleteOptionsTerminal` discriminated union | live as a type, but the `Terminal` member is never constructed |
| [src/agents/agent-adapter.ts#L295-L300](../../../../src/agents/agent-adapter.ts#L295-L300) | builds `turnTools = [...tools, terminalToolDef]` and calls `buildLlmOptions(role, 'tools', turnTools, ...)` every single turn | live (sole production caller of `buildLlmOptions`) |
| [src/agents/llm-provider-gateway.ts#L42](../../../../src/agents/llm-provider-gateway.ts#L42) | `const tools = opts.phase === 'terminal' ? [opts.terminalToolDefinition] : opts.tools;` | dead-branch in production; the `'terminal'` arm is only reachable from tests |
| [src/agents/llm-openai-chat-gateway.ts#L183-L187](../../../../src/agents/llm-openai-chat-gateway.ts#L183-L187) | duplicate `opts.phase === 'terminal'` branch for OpenAI-chat transport (tools list and tool-choice) | dead-branch in production |
| [src/agents/llm-openai-codex-gateway.ts#L122-L127](../../../../src/agents/llm-openai-codex-gateway.ts#L122-L127) | duplicate `opts.phase === 'terminal'` branch for OpenAI-codex transport | dead-branch in production |
| [src/agents/llm-recording.ts#L64-L66](../../../../src/agents/llm-recording.ts#L64-L66) | `deriveTerminalToolFromOptions` switches on `opts.phase === 'terminal'` first | live (recorder still works), but the first arm is unreachable in production |
| [src/contracts/llm-exchange.ts#L35-L36](../../../../src/contracts/llm-exchange.ts#L35-L36) | `TERMINAL_TOOL_NAMES` constant and `TerminalToolName` type exported from the contract package | live and useful (the projection that downstream consumers depend on) |
| [src/scripts/probe-llm-contract.ts#L86-L90](../../../../src/scripts/probe-llm-contract.ts#L86-L90) | hand-rolled probe that exercises both `'tools'` and `'terminal'` | the only production-shaped caller of `phase === 'terminal'` |
| [tests/agents/llm-openai-chat-gateway-request.test.ts#L48](../../../../tests/agents/llm-openai-chat-gateway-request.test.ts#L48) | constructs `{ phase: 'terminal', ... }` directly | test-only |
| [tests/agents/llm-openai-codex-gateway-request.test.ts#L48](../../../../tests/agents/llm-openai-codex-gateway-request.test.ts#L48) | constructs `{ phase: 'terminal', ... }` directly | test-only |

Live / dead summary:

- **Live**: the `'tools'` branch of `buildLlmOptions`, the
  `LlmCompleteOptionsTools` type, `deriveTerminalTool` /
  `deriveTerminalToolFromOptions` (only the `tool_choice.kind ===
  'required_named'` arm), `TerminalToolName` exported from
  `src/contracts/llm-exchange.ts`.
- **Dead in production**: `LlmRolePhase = 'terminal'`,
  `LlmCompleteOptionsTerminal`, `buildLlmOptions(..., 'terminal', ...)`, the
  four `opts.phase === 'terminal'` branches across the two gateways and the
  provider gateway, the first arm of `deriveTerminalToolFromOptions`, and
  the corresponding test scaffolding.
- **Probe-only**: `src/scripts/probe-llm-contract.ts` is the sole
  production-shape that still constructs a `'terminal'` options object. It
  is a diagnostic CLI, not part of the runtime hot path.

Inside the live `'tools'` branch, the adapter's call site
([agent-adapter.ts#L296](../../../../src/agents/agent-adapter.ts#L296)) merges
the terminal tool into the regular tool list every turn. The phase
distinction is not merely unused but actively misleading: every turn carries
the same tool-list shape, so there is no "tools phase" vs "terminal phase" at
all — there is one phase with one tool list.

The terminal tool *name* itself
([src/contracts/llm-exchange.ts#L35-L36](../../../../src/contracts/llm-exchange.ts#L35-L36))
remains useful: the recorder, the gateway adapters, and the
`llm_invocation_summary` event refer to it after the fact. Removing the
phase split does not remove the concept of "which tool the agent used to
declare its result"; it removes the per-turn switching that pretended a
separate options shape was needed.

### 1.2 F08 — composition of `maxToolTurns`, `maxRecoveryRetries`, `recoveryDelayMs`, and the same-candidate counter

Four independent counters / budgets exist on the hot path:

- **`maxToolTurns`** (default 16) — read inline at
  [agent-adapter.ts#L297](../../../../src/agents/agent-adapter.ts#L297), caps
  the inner `for (let turn = 0; ... turn++)` loop at
  [agent-adapter.ts#L299](../../../../src/agents/agent-adapter.ts#L299).
  Counts every LLM call that resulted in a plain message or a non-terminal
  tool batch. Reset on each candidate.
- **`maxRecoveryRetries`** (default 3) — turned into
  `maxAttempts = maxRetries + 1` inside
  [recovery.ts#L97](../../../../src/agents/recovery.ts#L97). Caps the outer
  `invokeWithRecovery` loop at
  [recovery.ts#L99](../../../../src/agents/recovery.ts#L99), which replays
  the *whole* `agentFn` (including a fresh `router.resolve` at
  [agent-adapter.ts#L269](../../../../src/agents/agent-adapter.ts#L269)).
  Reset only when the invocation finishes.
- **`recoveryDelayMs`** (default 60000) — used in two places. (a) Constant
  delay between outer recovery replays
  ([recovery.ts#L174](../../../../src/agents/recovery.ts#L174)). (b) The
  per-attempt `retryDelayMs` for `retry_same_after_delay` decisions
  ([invocation-recovery-policy.ts#L138](../../../../src/agents/invocation-recovery-policy.ts#L138)).
- **`sameCandidateRecoveryAttempt`** — local counter inside the
  per-candidate `for (;;)` loop, initialised at
  [agent-adapter.ts#L278](../../../../src/agents/agent-adapter.ts#L278) and
  passed to the policy as `attempt` at
  [agent-adapter.ts#L417](../../../../src/agents/agent-adapter.ts#L417). Only
  incremented on `retry_same_after_delay`
  ([agent-adapter.ts#L454](../../../../src/agents/agent-adapter.ts#L454)).

Concrete failure-class table — who increments what when an attempt fails.
"+1 outer" means the outer `invokeWithRecovery` replays from scratch; "+1
same-candidate" means the policy sends control back to the same candidate
inside the same `agentFn` call; "advance candidate" means the inner
`for ... of candidateChain` moves to the next; "+1 tool turn" means another
iteration of the inner `for (turn = 0; ...)` loop.

| Failure class (from [invocation-recovery-policy.ts#L94-L153](../../../../src/agents/invocation-recovery-policy.ts#L94-L153)) | Policy action | Same-candidate counter | Outer counter | Tool-turn counter |
| --- | --- | --- | --- | --- |
| `auth_permanent` | `failover_without_cooldown` | n/a (break inner loop) | unchanged | n/a |
| `capability_mismatch` | `failover_without_cooldown` | n/a | unchanged | n/a |
| `rate_limit` | `cooldown_and_failover` | n/a | unchanged | n/a |
| `server_transient` / `timeout` | `cooldown_and_failover` | n/a | unchanged | n/a |
| `contract_mismatch` (any subtype) | `fail_invocation` with `abort=true` ([L127-L128](../../../../src/agents/invocation-recovery-policy.ts#L127-L128)) | n/a | not incremented inside — the outer wrapper *sees* the throw, increments its own attempt counter, **and replays** unless `maxAttempts` reached | n/a |
| `token_budget_exceeded` | `failover_without_cooldown` | n/a | unchanged | n/a |
| `parse_error` while `attempt <= maxRecoveryRetries` ([L131-L138](../../../../src/agents/invocation-recovery-policy.ts#L131-L138)) | `retry_same_after_delay` (delay = `recoveryDelayMs`) | +1 same-candidate | unchanged | n/a |
| `parse_error` after exhausting same-candidate budget | `failover_without_cooldown` | n/a | unchanged | n/a |
| `cancelled` ([L142](../../../../src/agents/invocation-recovery-policy.ts#L142)) | `abort_without_retry` | n/a | not retried (abort) | n/a |
| `unknown` | `cooldown_and_failover` | n/a | unchanged | n/a |
| no candidates resolved | `abort_without_retry` from `decideNoCandidates` | n/a | not retried | n/a |
| inner loop exhausted with `finalEnvelope === null` (synthetic `contract_mismatch{terminal_tool_missing}` at [agent-adapter.ts#L386](../../../../src/agents/agent-adapter.ts#L386)) | `fail_invocation` `abort=true` | n/a | replayed by outer wrapper (same as any `contract_mismatch`) | the +1 happened inside the inner loop and is never reported |
| plain `message` response (post-`a2a6f05`) | not classified at all — handled inline at [agent-adapter.ts#L304-L320](../../../../src/agents/agent-adapter.ts#L304-L320) | n/a | unchanged | +1 tool turn |
| non-terminal tool batch | not a failure | n/a | unchanged | +1 tool turn |

Three structural problems fall out of the table:

1. The same-candidate counter is wired into the policy as the generic
   `attempt` field
   ([agent-adapter.ts#L417](../../../../src/agents/agent-adapter.ts#L417)
   passes `attempt: sameCandidateRecoveryAttempt`), while the outer
   `invokeWithRecovery` passes its *own* `recoveryCtx.attempt` to the
   `decideSuccess` / `decideNoCandidates` paths
   ([agent-adapter.ts#L392](../../../../src/agents/agent-adapter.ts#L392),
   [L272](../../../../src/agents/agent-adapter.ts#L272)). The same policy
   field carries different semantics depending on whether the caller is
   the success site or the failure site.
2. `contract_mismatch` is classified as `fail_invocation` + `abort=true`
   ([invocation-recovery-policy.ts#L127-L128](../../../../src/agents/invocation-recovery-policy.ts#L127-L128)),
   which **exits the per-candidate `for (;;)` loop via `throw lastError`**
   ([agent-adapter.ts#L447-L450](../../../../src/agents/agent-adapter.ts#L447-L450)).
   The throw escapes the inner `agentFn` and is caught by the outer
   `invokeWithRecovery`, which then replays the entire candidate chain
   ([recovery.ts#L99](../../../../src/agents/recovery.ts#L99)). So the
   "abort" actually triggers an outer recovery cycle — the inner "abort"
   semantics and the outer "retry" semantics directly contradict each
   other.
3. The `maxToolTurns` exhaustion path
   ([agent-adapter.ts#L386](../../../../src/agents/agent-adapter.ts#L386))
   is indistinguishable on the wire from a real `contract_mismatch`. There
   is no event, no telemetry attribute, and no policy hook that says "we
   ran out of free turns" — it is reported as if the agent emitted a
   malformed envelope on turn 0.

In summary, the runtime has one *exhaustion* concept (turns ran out) and one
*give-up* concept (we tried this candidate too many times), but four counters
implement them, and the wiring lets the outer wrapper retry exactly the
class of failure (`contract_mismatch`) that the policy claims is fatal.

### 1.3 F10 — responsibilities currently fused into `AgentAdapter.invokeAgent`

`invokeAgent` is a single method spanning
[agent-adapter.ts#L225-L497](../../../../src/agents/agent-adapter.ts#L225-L497).
The following responsibilities are interleaved inside it, in roughly the
order they execute:

1. **Pre-flight role housekeeping**
   ([L226-L229](../../../../src/agents/agent-adapter.ts#L226-L229)) —
   `resetOnRoleChange`, model-params lookup, role tool build.
2. **Capability-request construction**
   ([L230-L233](../../../../src/agents/agent-adapter.ts#L230-L233)) —
   `capabilityRequestForLlmOptions` from the tool list.
3. **Pre-flight candidate resolution and "no candidates" diagnosis**
   ([L234-L248](../../../../src/agents/agent-adapter.ts#L234-L248)) — calls
   `router.resolve`, reads `router.getLastCapabilitySkips()`
   ([L243](../../../../src/agents/agent-adapter.ts#L243)), and if empty
   constructs a `decideNoCandidates` policy call and throws the resulting
   message string.
4. **Session creation, single-active-session assertion, and `session_started`
   event** ([L249-L252](../../../../src/agents/agent-adapter.ts#L249-L252)).
5. **System-prompt mutation** via `applySelfCheck`
   ([L254](../../../../src/agents/agent-adapter.ts#L254)) — bypasses the
   contract surface to inject self-check prose into the system prompt.
6. **Context-message persistence**
   ([L255](../../../../src/agents/agent-adapter.ts#L255)).
7. **Recovery-options construction and `persistFailure` closure**
   ([L256](../../../../src/agents/agent-adapter.ts#L256)) — builds the
   options bag that `invokeWithRecovery` consumes, including a closure that
   writes `model_issue` messages to the session log via
   `redactProviderErrorMessage`.
8. **Attempt-recording state** —
   `attemptOutcomeCount`, `lastSucceededAttemptPayload`,
   `lastFailedFailureClass`, `recordAttemptOutcome`
   ([L258-L266](../../../../src/agents/agent-adapter.ts#L258-L266)) — the
   `recordAttemptOutcome` closure emits `llm_attempt` events on both the
   event logger and the event bus
   ([L265-L266](../../../../src/agents/agent-adapter.ts#L265-L266)).
9. **Inner `agentFn` re-resolve** of the candidate chain on every outer
   recovery attempt ([L269](../../../../src/agents/agent-adapter.ts#L269))
   plus a second capability-skip read
   ([L270](../../../../src/agents/agent-adapter.ts#L270)), with its own
   `decideNoCandidates` call
   ([L272](../../../../src/agents/agent-adapter.ts#L272)).
10. **Per-candidate loop** with its own "same-candidate recovery attempt"
    counter ([L278](../../../../src/agents/agent-adapter.ts#L278)) and the
    `for (;;)` inner repair-attempt loop
    ([L279](../../../../src/agents/agent-adapter.ts#L279)).
11. **Cancellation polling** at the top of every inner-loop iteration
    ([L280](../../../../src/agents/agent-adapter.ts#L280)).
12. **Per-turn LLM call** — model update on the session
    ([L285](../../../../src/agents/agent-adapter.ts#L285)),
    `model_recovered` diagnostic injection on retry
    ([L286](../../../../src/agents/agent-adapter.ts#L286)), abort-controller
    tracking ([L288](../../../../src/agents/agent-adapter.ts#L288)), tool
    list assembly with the terminal tool appended
    ([L294-L296](../../../../src/agents/agent-adapter.ts#L294-L296)),
    `buildLlmOptions` and the actual `llmCallFn` call
    ([L300-L302](../../../../src/agents/agent-adapter.ts#L300-L302)).
13. **Plain-message handling** — the tactical nudge from commit `a2a6f05`,
    crafting the nudge string inline and persisting a `model_repair` row
    ([L304-L320](../../../../src/agents/agent-adapter.ts#L304-L320)).
14. **Tool-call persistence as `tool_call` messages**
    ([L324-L329](../../../../src/agents/agent-adapter.ts#L324-L329)).
15. **Terminal-tool validation** and envelope extraction
    ([L333-L341](../../../../src/agents/agent-adapter.ts#L333-L341)), with
    inline `LlmRequestError(contract_mismatch / tool_arguments_invalid_json)`
    construction at
    [L338](../../../../src/agents/agent-adapter.ts#L338).
16. **Non-terminal tool execution** via `toolExecutor.processToolCall`
    ([L351](../../../../src/agents/agent-adapter.ts#L351)) and the
    deferred-activation pattern-match
    ([L352](../../../../src/agents/agent-adapter.ts#L352)).
17. **Deferred-`activate_card` envelope synthesis** — including dependency
    inspection through a freshly-allocated `CardStore`, blocked-reason
    aggregation, and the construction of synthetic `PlannerResult`
    (`status: 'continue'` or `'blocked'`)
    ([L361-L381](../../../../src/agents/agent-adapter.ts#L361-L381)).
    Planner-specific logic inside a generic per-role loop.
18. **Tool-turn exhaustion** — converted into a synthetic
    `contract_mismatch{terminal_tool_missing}`
    ([L386](../../../../src/agents/agent-adapter.ts#L386)).
19. **Final-envelope projection** — `JSON.stringify(finalEnvelope)`
    persisted as an assistant `text` row
    ([L388-L389](../../../../src/agents/agent-adapter.ts#L388-L389)) and
    `parseEnvelope(finalEnvelope)`
    ([L391](../../../../src/agents/agent-adapter.ts#L391)).
20. **Per-attempt success bookkeeping** — `decideSuccess` policy call,
    candidate-availability mark, success `llm_attempt` event with the
    capability-skip snapshot
    ([L392-L416](../../../../src/agents/agent-adapter.ts#L392-L416)), then
    cancellation clear and return.
21. **Per-attempt failure bookkeeping** — `decideFailure` policy call,
    candidate-availability mark, `model_issue` redaction and append, failure
    `llm_attempt` event with the capability-skip snapshot, cooldown
    computation, abort-vs-continue decision, retry-delay sleep,
    same-candidate counter increment
    ([L417-L455](../../../../src/agents/agent-adapter.ts#L417-L455)).
22. **Outer invocation summary** — `verdict` derivation, `summaryPayload`
    construction, `llm_invocation_summary` event on both channels
    ([L463-L482](../../../../src/agents/agent-adapter.ts#L463-L482)).
23. **Status-to-session-lifecycle projection**
    ([L484-L495](../../../../src/agents/agent-adapter.ts#L484-L495)) — for a
    successful attempt: if `role === 'planner' && status === 'continue'`
    call `markSessionWaiting`; if `role === 'planner' && status ===
    'blocked'` call `completeSession(..., 'blocked')`; if `role ===
    'executor' && status === 'failed'` call `completeSession(..., 'failed')`;
    otherwise `completeSession(..., 'done')`. For an unsuccessful attempt:
    `completeSession(..., 'failed')` and rethrow.
24. **Outbound redaction** — `redactModelIssueText` and
    `redactProviderErrorMessage` are called at six sites inside the method
    ([L256](../../../../src/agents/agent-adapter.ts#L256),
    [L375](../../../../src/agents/agent-adapter.ts#L375),
    [L380](../../../../src/agents/agent-adapter.ts#L380),
    [L420](../../../../src/agents/agent-adapter.ts#L420),
    [L426](../../../../src/agents/agent-adapter.ts#L426),
    [L427](../../../../src/agents/agent-adapter.ts#L427)).

The three envelope projections themselves
([agent-adapter.ts#L49-L62](../../../../src/agents/agent-adapter.ts#L49-L62))
live at module scope and are passed as the `parseEnvelope` argument to
`invokeAgent`; they are static maps from envelope to typed result and there
is no slot for a caller to supply a different one for a non-standard role.

Status projection (item 23) is the single point where a `PlannerResult.status`
or `ExecutorResult.status` becomes a `SessionStatus`
(`'active' | 'waiting' | 'done' | 'failed' | 'blocked'`). The mapping is
hardcoded by role string comparison, the reviewer role has no branch (it
silently falls through to `'done'`), and the inverse — a planner result that
is neither `continue` nor `blocked` and is therefore "done" — is implicit.

---

## 2. Target behaviour (informal)

### 2.1 Where the phase concept (or its replacement) belongs

The phase split disappears entirely from the options factory and from the
type system. The runtime has one operational mode for any contract-bearing
role: "here is the system prompt, the tool list (including the
result-emitting tool), and a recipe for what counts as done". The
replacement is a single contract object declared once at invocation
construction time, carrying:

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
rewritten against the single-shape options object (or removed when their
coverage is redundant).

### 2.2 The single canonical budget model

The runtime budgets resolve onto three orthogonal axes, each owned by a
different layer. Naming the axes is what removes the
counter-aliasing problems in §1.2.

1. **Free-turn budget (intra-conversation).** How many LLM calls the agent
   may issue in one *same-session* conversation before the contract verifier
   intervenes. Unit: one tool turn (one round-trip with the model in the
   same session). Owned by the contract verifier. Replaces `maxToolTurns`
   ([agent-adapter.ts#L297](../../../../src/agents/agent-adapter.ts#L297)).
   Exhaustion is a first-class outcome with its own `verdict` discriminator
   on `llm_invocation_summary` and its own diagnostic message; it is *not*
   reported as `contract_mismatch{terminal_tool_missing}` and it does *not*
   trigger any outer replay.

2. **Verify-and-repair-round budget (intra-conversation).** How many times,
   *within the same session and the same candidate*, the contract verifier
   may inject a structured non-compliance report and ask the agent to bring
   its envelope into compliance. Unit: one repair round (one
   verify + structured-report-injection + agent reply cycle). Owned by the
   contract verifier. This is a same-conversation continuation: the
   session-message history grows by one assistant turn and one
   system-or-tool repair turn per round; the candidate, the abort
   controller, the recorder, and the model-message window are all
   preserved. It is *not* a replay of the whole `agentFn`. Replaces the
   `sameCandidateRecoveryAttempt` counter
   ([agent-adapter.ts#L278](../../../../src/agents/agent-adapter.ts#L278))
   together with the contract-mismatch portion of the recovery policy
   ([invocation-recovery-policy.ts#L127-L128](../../../../src/agents/invocation-recovery-policy.ts#L127-L128)).

3. **Transport-class wrapper retries (cross-invocation replay).** How many
   times the runtime is willing to throw away the candidate chain and rebuild
   it from scratch in response to *transport-class* failures (transient
   HTTP, timeout, rate-limit cooldown rollover, candidate-availability
   change between attempts). Unit: one `invokeWithRecovery` outer attempt
   ([recovery.ts#L99](../../../../src/agents/recovery.ts#L99)). Owned by the
   recovery harness around the verifier. Replaces `maxRecoveryRetries`
   ([recovery.ts#L97](../../../../src/agents/recovery.ts#L97)). It must *not*
   be triggered by any `contract_mismatch` subtype, by free-turn exhaustion,
   or by repair-round exhaustion — those are intra-conversation outcomes
   that the verifier already handled and reported.

Two consequences of the axis split that the design phase must honour:

- Replay of the whole `agentFn` (a fresh `router.resolve`, fresh candidate
  chain, fresh session window from disk) is reserved for axis 3. Axes 1 and
  2 stay inside the same session and the same per-candidate LLM
  conversation. The current code violates this because
  `contract_mismatch` rides axis 3 through the `fail_invocation` /
  `abort=true` path
  ([invocation-recovery-policy.ts#L128](../../../../src/agents/invocation-recovery-policy.ts#L128)).
- The same-candidate parse-error retry (`retry_same_after_delay` at
  [invocation-recovery-policy.ts#L131-L138](../../../../src/agents/invocation-recovery-policy.ts#L131-L138))
  splits across two axes by failure semantics: terminal-tool argument parse
  errors are contract violations and move to axis 2; transport-body parse
  errors stay on axis 3 (see §4.3).

Total cost (the token-budget envelope enforced by
`token_budget_exceeded` at
[invocation-recovery-policy.ts#L129](../../../../src/agents/invocation-recovery-policy.ts#L129))
is a fourth, orthogonal concern that the new design leaves where it is.

### 2.3 The decomposition of `invokeAgent` into named collaborators

The 24 responsibilities listed in §1.3 partition into five named
collaborators called by a much smaller top-level
`AgentAdapter.invokeAgent` orchestrator. None of them need to know about
"planner / executor / reviewer" string roles — they are parameterised by
the contract object from §2.1.

1. **`AgentInvocationPlan`** — pure-data record built once per call. Owns
   the capability request, the resolved tool list, the model params, the
   system prompt (with self-check already applied), the contract object
   (terminal-tool name + schema + verifier predicate + envelope
   projection), the free-turn budget, and the repair-round budget. It does
   *not* own a candidate chain. Replaces items 1, 2, 5 from §1.3.

2. **`CandidateResolver`** — the single authority for candidate-chain
   freshness. Wraps `router.resolve(role, capabilityRequest)` plus the
   immediately-following `router.getLastCapabilitySkips()` read into one
   call that returns both pieces atomically. Called once before session
   creation (the pre-flight "is there at least one candidate?" check) and
   once per outer `invokeWithRecovery` attempt to pick up
   candidate-availability changes between attempts. Both call sites use the
   *same* resolver instance, so the "no candidates" diagnosis
   (`decideNoCandidates` at
   [agent-adapter.ts#L236](../../../../src/agents/agent-adapter.ts#L236) and
   [L272](../../../../src/agents/agent-adapter.ts#L272)) lives in one place,
   not two. Replaces items 3 and 9 and centralises the
   `getLastCapabilitySkips` reads at
   [L243](../../../../src/agents/agent-adapter.ts#L243),
   [L270](../../../../src/agents/agent-adapter.ts#L270),
   [L395](../../../../src/agents/agent-adapter.ts#L395), and
   [L431](../../../../src/agents/agent-adapter.ts#L431) into "ask the
   resolver for the skips that produced the chain you are about to use /
   just used".

3. **`AgentSessionLifecycle`** — owns session creation, the
   single-active-session assertion, session-started / session-cancelled /
   session-force-cancelled events, abort-controller registration,
   cancellation polling, and the `persistFailure` closure (items 4, 6,
   7-partial, 11). Already partially present as `AgentSessionCoordinator`
   ([agent-session-coordinator.ts](../../../../src/agents/agent-session-coordinator.ts));
   absorbs the inline `createSession` /
   `assertNoActiveAgentSession` calls and the `persistFailure` closure that
   currently lives in `invokeAgent` at
   [L256](../../../../src/agents/agent-adapter.ts#L256).

4. **`ContractVerifier`** — owns the inner free-turn loop, the per-turn LLM
   call, plain-message handling, tool-call persistence, non-terminal tool
   execution via `AgentToolExecutor`, terminal-tool extraction, the
   structured non-compliance report on repair rounds, free-turn-budget
   exhaustion, repair-round-budget exhaustion, and the final-envelope
   projection (items 12-15, 18, 19, plus the contract-aware portions of 13
   and 17). Returns a typed result, a typed non-compliance diagnostic, or a
   typed free-turn-exhaustion diagnostic. Does not throw
   `contract_mismatch` exceptions — all contract outcomes are values.

5. **`InvocationAttemptRecorder`** — owns the `recordAttemptOutcome` closure,
   the success / failure `llm_attempt` events, the `decideSuccess` /
   `decideFailure` policy calls, the candidate-availability marking, the
   `model_recovered` / `model_issue` injections, the retry-delay sleep, and
   the abort-vs-continue decision (items 8, 20, 21). Lives inside
   `invokeWithRecovery`. After the budget split (§2.2) the recovery policy
   sees only transport-class failures plus the verifier's typed
   diagnostics; it never sees a raw `contract_mismatch` exception escaping
   from the inner loop.

6. **`InvocationOutcomeProjector`** — given the result of the recovery
   harness, builds the `llm_invocation_summary` event and applies the
   status-to-session-lifecycle projection (items 22, 23). The role-to-
   lifecycle mapping table moves here as an explicit function keyed by the
   contract object, not by `role === 'planner'` string comparisons.

The deferred-`activate_card` envelope synthesis (item 17) is *not* part of
this decomposition's core. It is a planner-control concern that belongs
inside `PlannerControlExecutor` and / or the planner contract object as a
per-tool post-processor, so that the `ContractVerifier` only ever sees a
clean envelope or no envelope. From the F10 perspective, the cleanup is
that the contract verifier never branches on tool names; the question of
where exactly the deferred-activation logic lands is left open in §4.5.

The three module-scope `envelopeTo*Result` helpers
([agent-adapter.ts#L49-L62](../../../../src/agents/agent-adapter.ts#L49-L62))
collapse into the `projection` field of the per-role contract objects
defined alongside §2.1. There is no longer a `parseEnvelope` argument on
the inner method.

---

## 3. Cross-cutting constraints

### 3.1 Provider / router

- Candidate resolution (`router.resolve`) is called twice in the current
  hot path: once at the top of `invokeAgent`
  ([L234](../../../../src/agents/agent-adapter.ts#L234)) and once inside
  `agentFn` on every outer recovery attempt
  ([L269](../../../../src/agents/agent-adapter.ts#L269)). The
  `CandidateResolver` collaborator from §2.3 owns both call sites; the
  per-outer-attempt call must remain so candidate-availability changes
  between transport-class retries are picked up, but the duplicated
  `decideNoCandidates` shape (constructed at
  [L236](../../../../src/agents/agent-adapter.ts#L236) and
  [L272](../../../../src/agents/agent-adapter.ts#L272)) collapses into one
  call site.
- `router.getLastCapabilitySkips()` is read at four distinct sites
  ([L243](../../../../src/agents/agent-adapter.ts#L243),
  [L270](../../../../src/agents/agent-adapter.ts#L270),
  [L395](../../../../src/agents/agent-adapter.ts#L395),
  [L431](../../../../src/agents/agent-adapter.ts#L431)). The router-side
  "last skips" state is implicitly tied to the most recent `resolve` call,
  so the new design captures the skip snapshot alongside the chain at the
  moment of resolve (inside `CandidateResolver`) and hands it forward
  through `AgentInvocationPlan` / per-attempt context rather than re-asking
  the router later. Eliminating the late re-reads is mandatory because the
  router has no per-attempt isolation: a concurrent invocation can change
  the "last skips" value between resolve and read.
- The capability request is built once from the tool list and never
  re-derived
  ([L230-L233](../../../../src/agents/agent-adapter.ts#L230-L233)). It
  moves into the `AgentInvocationPlan` record cleanly.

### 3.2 Recovery harness

- `invokeWithRecovery` already returns an `InvocationAttempt[]` array
  ([recovery.ts#L84-L87](../../../../src/agents/recovery.ts#L84-L87)) — the
  outcome projector derives `attempts_count` from the array length
  instead of the parallel `attemptOutcomeCount` integer that
  `invokeAgent` currently maintains
  ([agent-adapter.ts#L258](../../../../src/agents/agent-adapter.ts#L258)).
  Removing the parallel counter eliminates one of the
  `recordAttemptOutcome` side effects.
- `RecoveryContext.directive`
  ([recovery.ts#L108-L109](../../../../src/agents/recovery.ts#L108-L109)) is
  a hardcoded prose string injected as a `model_recovered` message at
  [agent-adapter.ts#L286](../../../../src/agents/agent-adapter.ts#L286).
  After the budget split (§2.2), the wrapper-level directive only fires for
  transport-class retries; the agent-facing repair message is the contract
  verifier's responsibility and uses a structured payload, not free-form
  prose.
- `createCancellableRecovery`
  ([recovery.ts#L185](../../../../src/agents/recovery.ts#L185)) is not
  currently used by `invokeAgent` (cancellation flows through
  `AgentSessionCoordinator` instead). It is dead scaffolding for the new
  surface and is deleted.

### 3.3 Session-persistence side effects

- `appendPersistentMessage` and `appendSessionMessage` are called from at
  least six distinct sites inside `invokeAgent` for seven distinct message
  `kind` values (`text`, `tool_call`, `tool_result`, `tool_error`,
  `model_issue`, `model_repair`, `model_recovered`). The decomposition
  keeps message-kind responsibility close to the actor that produced the
  message: the contract verifier owns `text` / `tool_call` / `tool_result`
  / `tool_error` / `model_repair`; the attempt recorder owns `model_issue`
  / `model_recovered`.
- `markSessionWaiting`, `completeSession`, and `setSessionStatus` are
  called from `invokeAgent` and from the embedded `reviewer` closure
  passed to `PlannerControlExecutor`
  ([agent-adapter.ts#L110-L114](../../../../src/agents/agent-adapter.ts#L110-L114)).
  The outcome projector owns the post-invocation transitions; the
  in-flight `markSessionWaiting` / `setSessionStatus` toggling inside the
  reviewer closure is a separate (planner-control-driven) concern that the
  redecomposition does not absorb.
- `updateSessionModel` is called every same-candidate attempt
  ([L285](../../../../src/agents/agent-adapter.ts#L285)) — the contract
  verifier owns it because the model identity changes per LLM call inside
  the same candidate chain only when the candidate advances, which is a
  verifier-loop concern.

### 3.4 eventBus / EventLogger observability — current surface and ownership

The following event shapes are emitted from `invokeAgent` or its direct
collaborators. They are listed here because the decomposition shuffles
*who* emits them, not because the wire shape is frozen — the runtime owns
these schemas and the consumers ship in the same workspace, so any shape
change is a coordinated edit, not a compatibility constraint.

- `session_started`, `session_cancelled`, `session_force_cancelled` —
  emitted by `AgentSessionCoordinator` at
  [agent-session-coordinator.ts#L44-L46](../../../../src/agents/agent-session-coordinator.ts#L44-L46),
  [L60-L61](../../../../src/agents/agent-session-coordinator.ts#L60-L61),
  and [L72-L73](../../../../src/agents/agent-session-coordinator.ts#L72-L73);
  schema in
  [src/schemas/validators.ts#L163](../../../../src/schemas/validators.ts#L163)
  and event-catalog entry at
  [src/schemas/event-catalog.ts#L122](../../../../src/schemas/event-catalog.ts#L122).
  Current direct consumer: `RuntimeContainer.emitAgentEvent` at
  [src/runtime/runtime.ts#L487](../../../../src/runtime/runtime.ts#L487)
  uses `session_started` to update `current_agent_session_id` in runtime
  state. Ownership stays in `AgentSessionLifecycle`.

- `llm_attempt` — emitted twice per attempt (success / failure) inside
  `recordAttemptOutcome` at
  [agent-adapter.ts#L265-L266](../../../../src/agents/agent-adapter.ts#L265-L266);
  payload type `LlmAttemptPayload` at
  [src/schemas/types.ts#L159](../../../../src/schemas/types.ts#L159);
  schema entry `llmAttemptEventSchema` at
  [src/schemas/validators.ts#L164](../../../../src/schemas/validators.ts#L164);
  event-catalog entry at
  [src/schemas/event-catalog.ts#L123](../../../../src/schemas/event-catalog.ts#L123)
  (marked `tracked: true, audit: true, broadcast: true, outbound:
  'operator'`). No direct in-process consumer of the `llm_attempt` payload
  is wired in `src/`; the event is persisted via the tracked-events log and
  re-broadcast via `active-runtime.ts`
  ([src/runtime/active-runtime.ts#L217](../../../../src/runtime/active-runtime.ts#L217))
  for downstream readers. Ownership moves to
  `InvocationAttemptRecorder`.

- `llm_invocation_summary` — emitted once per invocation
  ([agent-adapter.ts#L481-L482](../../../../src/agents/agent-adapter.ts#L481-L482));
  payload type `LlmInvocationSummaryEvent` at
  [src/schemas/types.ts#L161](../../../../src/schemas/types.ts#L161);
  schema entry at
  [src/schemas/validators.ts#L165](../../../../src/schemas/validators.ts#L165);
  event-catalog entry at
  [src/schemas/event-catalog.ts#L124](../../../../src/schemas/event-catalog.ts#L124).
  Payload includes `attempts_count`, `total_duration_ms`, `verdict`
  (`'succeeded' | 'exhausted' | 'cancelled'`), `final_terminal_tool`, and
  `last_failure_class`. The new design adds free-turn-exhaustion as a
  first-class `verdict` (§2.2) and a corresponding
  `last_failure_class` value, which is a deliberate schema change applied
  to the schema, the validator, the event-catalog entry, and any
  downstream reader together. Ownership moves to
  `InvocationOutcomeProjector`.

- `model_repair`, `model_issue`, `model_recovered` — these are *not* events
  on the event bus; they are message rows persisted with those `kind`
  values, defined as part of `MessageKind` at
  [src/schemas/types.ts#L83](../../../../src/schemas/types.ts#L83) and
  emitted via `appendSessionMessage`. The contract verifier emits
  `model_repair` (replacing the inline nudge at
  [agent-adapter.ts#L319](../../../../src/agents/agent-adapter.ts#L319)
  with a structured non-compliance report rendered as the same `kind`).
  The attempt recorder emits `model_issue` (transport-class failure
  reports) and `model_recovered` (cross-attempt directive). The new design
  keeps the three kinds because the analyst surface and the
  session-message history both read them back, and the names match the
  semantics; if the structured non-compliance report makes
  `model_repair` insufficient (for example because the verifier wants to
  attach a typed `non_compliance` payload), the schema and its consumers
  are updated together in the Batch A design phase.

### 3.5 Redaction

Six redaction sites inside `invokeAgent`
([L256](../../../../src/agents/agent-adapter.ts#L256),
[L375](../../../../src/agents/agent-adapter.ts#L375),
[L380](../../../../src/agents/agent-adapter.ts#L380),
[L420](../../../../src/agents/agent-adapter.ts#L420),
[L426](../../../../src/agents/agent-adapter.ts#L426),
[L427](../../../../src/agents/agent-adapter.ts#L427)) call
`redactTextForOutbound(..., 'model.issue', ...)` via the two thin private
wrappers at
[L165-L166](../../../../src/agents/agent-adapter.ts#L165-L166). After
decomposition, the contract verifier owns the two synthetic-envelope sites
(L375, L380), the attempt recorder owns the three failure-message sites
(L256, L420, L426, L427), and the redaction policy name `'model.issue'`
stays the contract. The call sites are not the contract.

---

## 4. Open questions for the design phase

1. **Free-turn budget unit.** Is "tool turn" still the right unit if the
   verifier is allowed to interrupt the agent mid-batch (e.g. drop a
   non-terminal tool result and inject a verification message)? Two
   alternatives: (a) count LLM calls only; (b) count tool turns but allow
   the verifier to consume one budget unit per repair injection. The choice
   affects how the budget composes with the existing `maxToolTurns`
   runtime-config knob and how the verifier records its own actions in the
   session log.
2. **Runtime-config key names after the split.** The runtime config
   currently exposes `maxToolTurns` and `maxRecoveryRetries`. After the
   axis split in §2.2 there are three knobs (free-turn budget, repair-round
   budget, transport-class wrapper retries) plus the existing
   `recoveryDelayMs`. The design phase must pick the three names in one go
   so the rename is a single coordinated edit across config schema,
   runtime, recovery harness, contract verifier, and tests.
3. **`parse_error` split.** The current policy distinguishes same-candidate
   retry from candidate failover by the `attempt <= maxRecoveryRetries`
   test
   ([invocation-recovery-policy.ts#L132](../../../../src/agents/invocation-recovery-policy.ts#L132)).
   In the contract-verifier model, parse-errors on the *terminal*-tool
   arguments are contract violations and belong on axis 2 (repair-round
   budget). Should transport-side parse errors (HTTP body malformed, etc.)
   keep their same-candidate retry on axis 3, or fold into the generic
   transport recovery? Either answer changes the policy table.
4. **Reviewer status branch.** The current status projection has no
   reviewer arm and silently falls through to `'done'`
   ([agent-adapter.ts#L484-L492](../../../../src/agents/agent-adapter.ts#L484-L492)).
   Is the reviewer ever expected to produce `'failed'` or `'blocked'`
   sessions, or is `'done'` always correct? The
   `InvocationOutcomeProjector` design needs an answer before the role ->
   lifecycle table can be made exhaustive.
5. **Deferred-activation envelope synthesis ownership.** The long-term
   home of the
   [agent-adapter.ts#L361-L381](../../../../src/agents/agent-adapter.ts#L361-L381)
   logic must be decided. For F10 specifically: does the contract verifier
   need to know about the "only deferred `activate_card` in this turn" case
   at all, or can it be 100% removed from the verifier and pushed into
   `PlannerControlExecutor` (which would then return a "the planner is now
   blocked / continuing on its behalf" outcome that the verifier treats as
   an envelope source)?
6. **Tests that construct `{ phase: 'terminal' }` directly.** Two transport
   tests
   ([tests/agents/llm-openai-chat-gateway-request.test.ts#L48](../../../../tests/agents/llm-openai-chat-gateway-request.test.ts#L48)
   and
   [tests/agents/llm-openai-codex-gateway-request.test.ts#L48](../../../../tests/agents/llm-openai-codex-gateway-request.test.ts#L48))
   exercise the dead transport branches directly. Once the branches are
   deleted, do they keep the tests at all (rewriting them against the
   single options shape), or is the underlying transport contract already
   covered by other tests in the suite? Quick audit needed during design.
7. **`probe-llm-contract.ts` survival.** It is the only production-shaped
   caller of the `'terminal'` phase
   ([src/scripts/probe-llm-contract.ts#L86-L90](../../../../src/scripts/probe-llm-contract.ts#L86-L90)).
   Does the diagnostic CLI still serve a purpose after the phase split,
   and if so, what does it probe — a transport sanity check, a contract
   round-trip, or both?
8. **`llm_attempt` downstream readers.** The event is registered as
   `tracked: true` and `broadcast: true` in
   [src/schemas/event-catalog.ts#L123](../../../../src/schemas/event-catalog.ts#L123)
   but no direct in-process consumer of the payload is wired in `src/`.
   The design must confirm whether the only consumers are the
   tracked-events log file and any web / analyst readers that subscribe via
   the event bus; if so, the move of emission ownership to
   `InvocationAttemptRecorder` is a pure relocation and the wire shape
   stays. If a runtime consumer is added later, the contract is the
   event-catalog entry, not the emission site.
