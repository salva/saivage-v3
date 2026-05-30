# Batch A — Contract Verifier Core: Functional Analysis

Scope: the four tightly coupled issues that together define how the runtime
treats an envelope that does not yet satisfy its contract.

- F02 — `contract_mismatch` failures abort the whole invocation.
- F03 — no "agent declares done" signal distinct from "runtime forces a tool
  emission".
- F04 — recovery policy conflates transport faults with semantic contract
  violations.
- F09 — tactical `model_repair` nudge loop is a band-aid in the wrong layer.

All file references are workspace-relative to `saivage-v3/`.

---

## 1. Functional analysis

### 1.1 End-to-end flow when an agent fails to produce a valid envelope

A planner / executor / reviewer invocation enters
[src/agents/agent-adapter.ts](../../../../src/agents/agent-adapter.ts#L225)
through `invokeAgent(role, goalId, cardId, systemPrompt, contextMessages,
parseEnvelope, requestedSessionId?)`. The function:

1. Resolves the candidate chain via the model router and creates a persisted
   session (`createSession`,
   [agent-adapter.ts#L250](../../../../src/agents/agent-adapter.ts#L250)).
2. Wraps the per-candidate loop in `invokeWithRecovery` from
   [src/agents/recovery.ts#L93-L177](../../../../src/agents/recovery.ts#L93-L177).
   That wrapper provides a textual `RecoveryContext.directive`
   ("RECOVERY DIRECTIVE: Your previous invocation failed...") on retries; it
   is not contract-aware.
3. For each candidate, it enters an inner `for (;;)` loop ("same-candidate
   recovery attempt"), which itself contains a `for (let turn = 0; turn <
   maxToolTurns; turn++)` tool-call loop
   ([agent-adapter.ts#L299-L385](../../../../src/agents/agent-adapter.ts#L299-L385)).
4. Each turn calls `buildLlmOptions(role, 'tools', turnTools, ...)`
   ([agent-adapter.ts#L300](../../../../src/agents/agent-adapter.ts#L300))
   with the role's tools concatenated with the terminal tool
   (`emit_planner_result` / `emit_executor_result` /
   `emit_reviewer_result`), and dispatches the call through
   `AgentLlmInvocationGateway`.

Inside one turn there are exactly three branches:

- **Plain message branch**
  ([agent-adapter.ts#L302-L320](../../../../src/agents/agent-adapter.ts#L302-L320)).
  A `result.kind === 'message'` no longer kills the candidate. The adapter
  appends the assistant text and a `system / model_repair` row containing a
  hand-written nudge string:

  ```ts
  const nudge = remaining > 0
    ? `Your previous reply was a plain message, but this turn expects tool calls. ...`
    : `Your previous reply was a plain message and this is the last turn. ...`;
  this.appendSessionMessage(session.id, { role: 'system', kind: 'model_repair', content: nudge });
  continue;
  ```

  The vocabulary, the cap (`maxToolTurns - turn - 1`), and the decision to
  retry vs not are all encoded inline in the hot path.

- **Terminal-tool branch**
  ([agent-adapter.ts#L334-L345](../../../../src/agents/agent-adapter.ts#L334-L345)).
  If any tool call this turn matches `terminalToolName`, the adapter calls
  `validateTerminalToolCall(...)` from
  [src/agents/terminal-protocol.ts#L6-L25](../../../../src/agents/terminal-protocol.ts#L6-L25),
  which throws `LlmRequestError{kind:'contract_mismatch', subtype:
  'terminal_tool_unexpected' | 'tool_arguments_schema_violation' | ...}` on
  any deviation. Invalid JSON in the terminal tool's arguments throws
  `tool_arguments_invalid_json` directly from the adapter
  ([agent-adapter.ts#L338-L340](../../../../src/agents/agent-adapter.ts#L338-L340)).

- **Non-terminal tool-call branch**
  ([agent-adapter.ts#L347-L382](../../../../src/agents/agent-adapter.ts#L347-L382)).
  Tool results / errors are persisted; deferred `activate_card` envelopes are
  collected and, when the only effective tool call was a deferred
  `activate_card`, the adapter **synthesises a planner envelope** on the
  agent's behalf (`status: 'continue'` or `status: 'blocked'`) and breaks the
  loop.

If the loop exits with `finalEnvelope === null` (turn budget exhausted with
no terminal call), the adapter throws
([agent-adapter.ts#L385-L387](../../../../src/agents/agent-adapter.ts#L385-L387)):

```ts
throw new LlmRequestError({ kind: 'contract_mismatch',
  subtype: 'terminal_tool_missing',
  provider: candidate.provider,
  message: `Role '${role}' did not emit terminal tool within ${maxToolTurns} turns.` });
```

That `LlmRequestError` is caught in the same-candidate `try / catch`
([agent-adapter.ts#L417-L451](../../../../src/agents/agent-adapter.ts#L417-L451)),
which calls `defaultInvocationRecoveryPolicy.decideFailure(lastError,
policyContext)`. The policy is in
[src/agents/invocation-recovery-policy.ts](../../../../src/agents/invocation-recovery-policy.ts).
For `failure.kind === 'contract_mismatch'`
([invocation-recovery-policy.ts#L127-L129](../../../../src/agents/invocation-recovery-policy.ts#L127-L129))
it returns:

```ts
return this.buildDecision(context, 'fail_invocation', failure,
  `Candidate ${candidate} violated tool-call contract (subtype=${failure.subtype}): ${sanitized}`,
  { markFailed: false, appendModelIssue: true, abort: true });
```

`abort: true` is honoured at
[agent-adapter.ts#L447-L451](../../../../src/agents/agent-adapter.ts#L447-L451):
the adapter rethrows `lastError`, the candidate loop exits, and the outer
`invokeWithRecovery` records a failed attempt and applies its retry delay
(`recoveryDelayMs`, default 60000 ms) before re-running the entire `agentFn`.
On the next attempt the agent is given the textual "RECOVERY DIRECTIVE"
([recovery.ts#L115-L122](../../../../src/agents/recovery.ts#L115-L122)) and
the loop starts over from turn 0 with a fresh candidate chain — there is no
structured handoff of which obligations were unmet.

The same `decideFailure` switch also handles every transport fault:
`auth_permanent`, `capability_mismatch`, `rate_limit`, `server_transient`,
`timeout`, `token_budget_exceeded`, `parse_error`, `cancelled`, `unknown`
([invocation-recovery-policy.ts#L94-L150](../../../../src/agents/invocation-recovery-policy.ts#L94-L150)).
All of them produce `InvocationRecoveryDecision` values from one
`buildDecision` constructor, write to one event payload, and feed one
`InvocationRecoveryAction` enum (`mark_succeeded`, `cooldown_and_failover`,
`failover_without_cooldown`, `retry_same_after_delay`, `abort_without_retry`,
`fail_invocation`).

### 1.2 Why F02 manifests

`InvocationRecoveryPolicy.decideFailure` has exactly one arm for
`contract_mismatch` and it sets `action: 'fail_invocation'` with
`abort: true, markFailed: false`
([invocation-recovery-policy.ts#L127-L129](../../../../src/agents/invocation-recovery-policy.ts#L127-L129)).
That choice has three consequences:

- The candidate is **not** marked unavailable, so the candidate-health
  subsystem has nothing to act on.
- `abort: true` short-circuits the per-candidate `for` loop at
  [agent-adapter.ts#L447-L451](../../../../src/agents/agent-adapter.ts#L447-L451)
  by rethrowing `lastError`. No further candidates in the chain are tried.
- The outer `invokeWithRecovery` then bumps `attempt`, waits
  `recoveryDelayMs`, and re-enters `agentFn` from scratch with only a
  free-text directive — no record of which contract clauses were violated.

Because the contract subtypes (`terminal_tool_missing`,
`terminal_tool_unexpected`, `tool_arguments_invalid_json`,
`tool_arguments_schema_violation`, `legacy_message_shape`, `unknown`,
[llm-failure.ts#L1-L8](../../../../src/agents/llm-failure.ts#L1-L8)) are
flattened by the switch into a single response, the policy cannot distinguish
"agent never called the terminal tool" (a repairable miss) from
"agent's terminal arguments do not satisfy the schema" (also repairable) from
"opencode-go returned HTTP 400 with `usage_limit_reached`" (a provider issue
that should not even be in this family — see F04).

The trigger case (`nvidia-nim/_/meta/llama-3.3-70b-instruct` emitting a plain
message during a tools turn) reaches `decideFailure` only because the
pre-mitigation adapter threw `terminal_tool_missing` from the post-loop path.
With the inline mitigation in place, the plain-message branch
([agent-adapter.ts#L302-L320](../../../../src/agents/agent-adapter.ts#L302-L320))
absorbs *that one* shape; every other contract miss still routes straight to
`fail_invocation + abort`.

### 1.3 Why F03 manifests

There is no "agent declares done" message kind anywhere in the runtime.
Done-ness is implicitly equal to "emitted the terminal tool with valid
envelope arguments". This is enforced in three places:

- The terminal tool's description is hard-coded as the moment of completion
  ([role-result-tools.ts#L20-L24](../../../../src/agents/role-result-tools.ts#L20-L24)):
  `description: ``Emit the ${role} result envelope as the final action of this turn.``,`.
- The adapter's only success exit is "terminal tool seen → validate →
  `finalEnvelope = envelope; break;`"
  ([agent-adapter.ts#L334-L345](../../../../src/agents/agent-adapter.ts#L334-L345)).
- Any path that exhausts the loop throws `contract_mismatch /
  terminal_tool_missing`
  ([agent-adapter.ts#L385-L387](../../../../src/agents/agent-adapter.ts#L385-L387))
  with the same provider field (`candidate.provider`) used for transport
  errors. `terminal-protocol.ts` throws the same subtype with provider
  `'gateway-protocol'`
  ([terminal-protocol.ts#L7-L13](../../../../src/agents/terminal-protocol.ts#L7-L13)).

Because *intent* ("done") and *wire artefact* (the envelope) are the same
event, the runtime cannot react to "I'm done but the envelope is wrong"
differently from "I'm not done yet" — both look like *no terminal tool seen*.
The synthesised `continue` / `blocked` envelopes for deferred
`activate_card`
([agent-adapter.ts#L347-L382](../../../../src/agents/agent-adapter.ts#L347-L382))
exist precisely because the planner has no other way to say "I am done with
this round, control transfers to the activated child" without calling
`emit_planner_result`. The runtime invents the envelope on the planner's
behalf rather than asking it to declare done.

### 1.4 Why F04 manifests

`LlmFailure` is a single discriminated union
([llm-failure.ts#L9-L20](../../../../src/agents/llm-failure.ts#L9-L20))
that mixes:

- Transport-layer faults: `auth_permanent`, `rate_limit`, `server_transient`,
  `timeout`, `token_budget_exceeded`, `parse_error`, `cancelled`, `unknown`.
- Semantic-layer faults: `contract_mismatch` (with six subtypes).
- A capability-mismatch variant that is half-and-half.

Two leaks follow directly from this:

- `OpenCodeGoClassifier`
  ([llm-failure-classifiers.ts#L99-L125](../../../../src/agents/llm-failure-classifiers.ts#L99-L125))
  promotes **any** HTTP 400 from that provider into `contract_mismatch /
  subtype: 'unknown'` — a transport-shape decision dressed up as a contract
  decision. Downstream, `decideFailure` then routes the result through the
  contract arm and aborts.
- Conversely, a real envelope schema violation thrown by
  `validateTerminalToolCall`
  ([terminal-protocol.ts#L15-L24](../../../../src/agents/terminal-protocol.ts#L15-L24))
  is processed by the exact same `case 'contract_mismatch':` arm as the
  opencode-go HTTP 400. Both decisions about "cool the candidate, fail over,
  or repair the conversation" are made from one switch statement.

The adapter compounds this by treating `contract_mismatch` thrown in-band
(post-loop) and out-of-band (from the terminal-protocol validator) as
indistinguishable: both surface as `lastError` to the same `try/catch` and
the same `decideFailure` call.

### 1.5 Why F09 manifests

The plain-message repair is inlined directly into the inner turn loop
([agent-adapter.ts#L302-L320](../../../../src/agents/agent-adapter.ts#L302-L320)):
write the assistant text, write a `system / model_repair` row, `continue`.
The repair vocabulary is two template literals; the termination predicate is
`remaining > 0`; the structured contract diff is absent (the nudge does not
list "you did not call `emit_planner_result`" or "your last envelope failed
schema X"). Other contract misses — wrong terminal-tool name, bad JSON,
schema violation, turn budget exhausted — bypass this branch entirely and
still throw, hitting the `fail_invocation / abort` arm of F02.

So today the runtime has *two* fully separate code paths for "agent did not
produce a valid envelope":

- **The mitigation** — plain message, inline string, soft retry, no
  candidate failover.
- **The throw** — every other contract subtype, abort the candidate chain,
  free-text retry directive from `invokeWithRecovery`.

Neither path is contract-aware, neither path emits the *same* repair message
kind to the agent, and the `MessageKind: 'model_repair'` defined in
[src/schemas/types.ts#L83](../../../../src/schemas/types.ts#L83) is consumed
nowhere. The mitigation does, badly, exactly the work the redesign needs to
do well.

### 1.6 Implicit contract assumptions baked in today

These assumptions are not stated anywhere as a contract; they are
distributed across the call sites listed above:

- A turn is a single LLM call; "done" is observable only at turn granularity.
- "Done" is exclusively expressed as a function call to a hard-coded global
  name per role
  ([role-result-tools.ts#L4-L8](../../../../src/agents/role-result-tools.ts#L4-L8));
  there is no per-invocation contract override.
- The system prompt is the *only* channel through which the agent learns
  what counts as a valid envelope; the prompt and the runtime contract
  ("call this specific tool with these JSON args") are written independently
  and can drift (the prompt currently says "wrap it in a code block or
  return raw JSON", which the runtime never accepts).
- Recovery is a **textual** directive
  ([recovery.ts#L115-L122](../../../../src/agents/recovery.ts#L115-L122))
  rather than a structured list of unmet obligations.
- `contract_mismatch` is a *catastrophic* class — comparable to
  `auth_permanent` in the recovery switch, more severe than
  `server_transient` (which only cools and fails over).
- The phase machine in
  [llm-options-factory.ts](../../../../src/agents/llm-options-factory.ts#L23-L66)
  encodes a `'tools' | 'terminal'` distinction in the type system, but the
  hot path only ever calls `buildLlmOptions(role, 'tools', ...)`. The
  `'terminal'` branch (forcing the model to emit exactly the terminal tool)
  exists only as latent machinery — nothing dispatches into it.
- The provider field on `LlmRequestError` is overloaded: the adapter passes
  `candidate.provider`, the terminal protocol passes `'gateway-protocol'`,
  the classifiers pass the real provider. Anything that inspects
  `failure.provider` cannot tell where the error originated.

---

## 2. Target behaviour (informal)

The runtime stops policing the conversation turn by turn and instead acts as
a **contract verifier with an explicit repair loop**.

### 2.1 Roles and responsibilities

- **The runtime** owns: the contract definition for this invocation, the
  tool catalogue, the message log, the per-invocation budget (turns,
  wall-time, repair attempts), transport recovery, candidate health, and the
  termination predicate.
- **The agent** owns: which tools to call in what order, how many tool
  rounds to take, when to stop, and the content of its proposed result.
- **The system prompt** owns: declarative description of the task,
  available tools, expected return shape, and the rule "when you believe you
  are done, signal completion".

The runtime is forbidden from forcing a specific tool on any turn; the
`'terminal'` phase in `llm-options-factory.ts` is deleted along with the rest
of the implicit phase machinery.

### 2.2 Done signal

The agent declares completion with a dedicated, role-independent signal —
not by emitting the typed result envelope. The candidate result the agent
proposes for verification accompanies the done signal (or is reconstructed
from the conversation when the agent's signal omits it). Concretely the
runtime introduces a single mechanism — call it the *done signal*, whose
wire form is decided in the design phase — that satisfies:

- It is distinct from "called any tool" and distinct from "emitted a plain
  message".
- It carries the agent's candidate result in a single, schema-validated
  payload.
- It is mandatory for every envelope-bearing role.
- It is the *only* condition under which the runtime attempts contract
  verification. The runtime never auto-validates "the agent went silent" as
  "the agent might be done".

The synthesised planner envelope for deferred `activate_card` becomes a
first-class form of the done signal — the planner-control executor emits a
runtime-internal done signal on the planner's behalf when activation
transfers control. The inline synthesis at
[agent-adapter.ts#L347-L382](../../../../src/agents/agent-adapter.ts#L347-L382)
disappears as a special case.

### 2.3 Verification

When a done signal arrives, the runtime runs the contract verifier:

- Parse the proposed result against the role's schema (the work
  `validateTerminalToolCall` does today, but lifted out of the failure
  path).
- Apply contract-level cross-checks (e.g. planner `status:'continue'`
  requires non-empty `summary` and `created_cards` / `updated_cards` shapes;
  executor `status:'failed'` requires `error`).
- Produce a structured **obligation report**: a list of zero or more unmet
  obligations, each with a stable code, a machine-readable locator (JSON
  pointer or schema path), a human-readable description, and optionally an
  expected value.

If the obligation report is empty, the invocation completes with the
verified result; `parseEnvelope` becomes a pure projection, not a failure
site.

### 2.4 Repair conversation

If the obligation report is non-empty, the runtime appends a structured
**repair message** to the session log and reinvokes the agent on the same
candidate:

- The repair message is built from the obligation report, not from
  hand-written templates. It contains the unmet-obligation codes, locators,
  and descriptions, plus a single instruction: "fix these issues and signal
  done again".
- The message uses a single message kind (the `model_repair` kind already
  present in [src/schemas/types.ts#L83](../../../../src/schemas/types.ts#L83),
  but now produced *only* by the verifier).
- The agent's tool catalogue is unchanged; in particular the runtime does
  not switch to a "terminal-only" mode for repair.
- A repair attempt consumes one slot from the *repair budget* (a budget
  distinct from the turn budget and from the transport-recovery budget).

The verifier is also responsible for the case the F09 mitigation handles
today: a turn produces only a plain message and no done signal. In the
target model that is **not** a repair condition — it just means "agent isn't
done yet". The runtime keeps looping until the turn budget runs out. Turn-
budget exhaustion *with* a pending done signal trips the verifier; turn-
budget exhaustion *without* one trips a new, non-fatal failure class — call
it `no_progress` — which the recovery policy can choose to fail over or
abort, separate from the contract layer.

### 2.5 Transport vs semantic split

`LlmFailure` is split into two disjoint types:

- `LlmTransportFailure` — `auth_permanent`, `rate_limit`,
  `server_transient`, `timeout`, `token_budget_exceeded`, `cancelled`,
  `capability_mismatch`, `unknown`. These are the only inputs to the
  candidate-health / failover policy. `OpenCodeGoClassifier`'s blanket
  HTTP 400 -> contract promotion goes away; an HTTP 400 with an unknown body
  is a transport-layer "unknown" or "server" fault.
- `ContractViolation` — what the verifier produces. Never travels through
  `LlmRequestError` or `decideFailure`. It is the structured form of the
  obligation report.

`InvocationRecoveryPolicy` operates only on `LlmTransportFailure`; the
`case 'contract_mismatch':` arm is deleted. Anything that today wraps a
contract problem in `LlmRequestError` is rewritten to produce a
`ContractViolation` that flows into the verifier.

### 2.6 How the four issues resolve

- **F02** — `contract_mismatch` is no longer a member of the failure union
  that the recovery policy sees, so `fail_invocation + abort` cannot apply
  to envelope problems. Contract problems become obligation reports that
  drive a repair conversation; only repair-budget exhaustion can promote
  them into an invocation failure, and that failure is a distinct,
  non-aborting class.
- **F03** — the done signal exists separately from the typed envelope; the
  verifier can react to "claimed done with broken envelope" differently
  from "didn't claim done", which is the prerequisite for any structured
  repair.
- **F04** — the type-level split between transport and contract failures
  removes the leak in both directions: provider classifiers can no longer
  forge `contract_mismatch`, and verifier output can no longer leak into
  the candidate-health policy.
- **F09** — the inline plain-message nudge in the per-turn loop is deleted.
  Plain messages are normal in-progress traffic, not a repair trigger. The
  one place that produces repair messages is the verifier, and it does so
  from a structured obligation report rather than a template literal.

---

## 3. Cross-cutting constraints

The redesign reaches beyond `src/agents/`. The following invariants must be
preserved or explicitly migrated (no backward-compatibility shims; old
shapes get deleted and call sites get updated in the same change set).

### 3.1 Session persistence and message schema

- `MessageKind` in
  [src/schemas/types.ts#L83](../../../../src/schemas/types.ts#L83) already
  carries `model_repair`, `model_issue`, and `model_recovered`. The repair
  message kind must be emitted by the verifier and only by the verifier.
  The `model_recovered` directive currently emitted from
  [agent-adapter.ts#L286](../../../../src/agents/agent-adapter.ts#L286)
  belongs to transport recovery and stays in that layer.
- Whatever wire form the *done signal* takes (a distinguished message kind,
  a structured assistant block, a dedicated tool, or a header on the
  envelope tool call) must round-trip through `session-persistence` so a
  reinvocation can resume mid-repair.
- The current obligation that planner sessions reach status `waiting`
  (`markSessionWaiting`) on `status:'continue'` and `done` / `blocked` /
  `failed` on terminal states is set in
  [agent-adapter.ts#L489-L492](../../../../src/agents/agent-adapter.ts#L489-L492).
  The verifier output must continue to feed the same session-status
  transitions; the verifier's success path is the only thing that
  completes a session as `done`.

### 3.2 Supervisor loop and downstream consumers

- `envelopeToPlannerResult / envelopeToExecutorResult /
  envelopeToReviewerResult`
  ([agent-adapter.ts#L46-L60](../../../../src/agents/agent-adapter.ts#L46-L60))
  must become *projections of an already-verified envelope*, never the
  point where validation fails. Anything in `src/contracts/` that today
  assumes `PlannerResult.status` is one of `continue | blocked | done |
  failed` keeps working unchanged.
- The deferred-`activate_card` envelope synthesis at
  [agent-adapter.ts#L347-L382](../../../../src/agents/agent-adapter.ts#L347-L382)
  is the only consumer of `parseDeferredActivationEnvelope` and the only
  producer of the runtime-synthesised planner `continue` / `blocked`
  envelopes. It must move into the new done-signal mechanism without
  changing what supervisor / planner-control consumers observe (the planner
  still appears to have produced `status:'continue', summary:...` or
  `status:'blocked', blocked_reason:...`).
- `TERMINAL_TOOL_NAMES` duplicated in
  [src/contracts/llm-exchange.ts#L32-L36](../../../../src/contracts/llm-exchange.ts#L32-L36)
  must be removed or replaced with whatever name the done signal takes; no
  consumer should keep grepping for `emit_planner_result` etc. as a magic
  string.

### 3.3 Event logging and observability

- The per-attempt event `llm_attempt`
  ([agent-adapter.ts#L262-L271](../../../../src/agents/agent-adapter.ts#L262-L271))
  and the per-invocation `llm_invocation_summary`
  ([agent-adapter.ts#L466-L483](../../../../src/agents/agent-adapter.ts#L466-L483))
  carry `failure_class: LlmFailureClass`. The split into transport vs
  contract requires a new event kind (or a new field) for "verifier
  rejected, repair attempt N" so that the existing failure-class column
  stays exclusively transport-shaped. The dashboard consumers in
  `src/web/` rely on these payloads.
- `recordAttemptOutcome` must continue to fire exactly once per LLM round
  trip; repair invocations are additional rounds and must each produce
  their own attempt record.
- `sanitizeRecoveryMessage`
  ([invocation-recovery-policy.ts#L56-L67](../../../../src/agents/invocation-recovery-policy.ts#L56-L67))
  is applied to every outgoing model-visible string. The verifier's repair
  payloads must go through equivalent redaction before being persisted to
  the session log or shipped to the model — schema paths and obligation
  descriptions are unlikely to contain secrets, but agent-supplied values
  echoed back in error reports can.

### 3.4 Recovery harness boundary

- `invokeWithRecovery`
  ([recovery.ts#L93-L177](../../../../src/agents/recovery.ts#L93-L177))
  remains the *transport* recovery harness. Its `directive` string is
  emitted only on transport-class failures; the verifier never produces a
  `RecoveryContext` and never bumps `attempt`.
- The repair loop lives **inside** `agentFn`, on the same candidate, and
  consumes its own repair budget. The two budgets do not nest in the other
  direction — the verifier never re-enters `invokeWithRecovery`, and the
  transport recovery harness never invokes the verifier.
- Repair-budget exhaustion is a contract-layer terminal state, not a
  transport fault. It surfaces as a `RepairExhausted` outcome of the
  verifier that the adapter propagates as an explicit invocation failure
  with a dedicated verdict (alongside the existing `succeeded` /
  `exhausted` / `cancelled` verdicts written by
  [agent-adapter.ts#L466-L483](../../../../src/agents/agent-adapter.ts#L466-L483)).
  It does not enter `decideFailure` and it does not cool, fail over, or
  retry the candidate; the candidate-health subsystem only ever sees
  transport-shaped outcomes.

### 3.5 Skills, system prompts, and self-checks

- `AgentRoleRunner.applySelfCheck`
  ([agent-role-runner.ts#L34](../../../../src/agents/agent-role-runner.ts#L34),
  invoked from
  [agent-adapter.ts#L168](../../../../src/agents/agent-adapter.ts#L168))
  mutates the system prompt out of band. The redesign must decide whether
  the self-check still injects every N rounds or whether the verifier
  subsumes the responsibility; either way, self-check and repair must not
  produce *both* an inline system-prompt addendum and a `model_repair`
  message for the same condition.
- `system-prompt.ts` currently documents the envelope as "wrap in a code
  block or return raw JSON" — that wording becomes incorrect once the done
  signal is the contract surface. The prompt builders must regenerate from
  the same source of truth the verifier uses, so prompt and verifier cannot
  drift.

---

## 4. Open questions

These are decisions the design phase must make. Each is a *choice*, not a
gap in this analysis.

1. **Wire form of the done signal.** Options include: (a) a distinct tool
   such as `submit_result` whose arguments carry the envelope, (b) a
   dedicated message kind (`agent_done`) the agent emits as a structured
   assistant block, (c) keeping `emit_*_result` but treating its presence
   purely as a done marker, with the envelope validation moved entirely
   into the verifier. Each option has different consequences for provider
   transport compatibility (some providers do not surface non-tool
   structured blocks reliably).
2. **Should the agent's tool catalogue contain the done signal as a tool?**
   If yes, the contract has a uniform "everything is a tool call" shape but
   the runtime is back to relying on tool-call presence as the completion
   marker. If no, the agent has to learn a second channel, but the runtime
   stays transport-agnostic about completion.
3. **Repair budget shape.** Total repair attempts per invocation vs total
   per candidate vs decaying budget. Interaction with the existing
   `maxToolTurns`, `maxRecoveryRetries`, and `recoveryDelayMs` must be
   resolved so that one global ceiling governs wall-time behaviour.
4. **What happens when repair fails N times in a row with the *same*
   obligation report?** The valid options are limited to (a) declare the
   invocation a `RepairExhausted` failure and surface it to the surrounding
   flow, (b) rotate to a different candidate carrying the repair history so
   a different model can attempt the same obligation report. Demoting the
   verifier check (last-resort acceptance) is explicitly *not* an option —
   the brief's contract-verifier model treats unsatisfied contracts as a
   terminal repair condition, never as something to wave through. Falling
   back into the transport-layer failover path is also not an option —
   `RepairExhausted` is a contract-layer outcome and must not enter
   `decideFailure`. The design must pick between (a) and (b) and articulate
   the criterion; (b) implicitly requires the contract layer to own a
   cross-candidate retry policy that today lives entirely in the transport
   harness.
5. **Cross-role contract overrides.** Today the role -> schema map is a
   global constant (`ENVELOPE_SCHEMAS`). Should the verifier accept a
   per-invocation contract (e.g. reviewer responses scoped to a particular
   assessment with extra required fields)? If yes, the contract object
   becomes part of `invokeAgent`'s arguments and `parseEnvelope` is
   reconstructed from it.
6. **Analyst path unification (optional).** The analyst currently bypasses
   the envelope contract. Folding it under the verifier requires either
   defining an analyst contract or making "no contract" a first-class
   choice the verifier handles trivially (accept any non-empty content).
   The brief flags this as optional; the design must explicitly accept or
   reject.
7. **Capability classifier behaviour.** Once `contract_mismatch` leaves
   `LlmFailure`, `OpenCodeGoClassifier`'s "HTTP 400 means contract" rule
   loses its escape hatch. The replacement classification for opencode-go
   400s (likely `server_transient` or a new `provider_protocol_error`) is
   a transport-layer concern; the design must pick a class that the
   recovery policy already knows how to handle, or extend the policy.
8. **Persistence of the obligation report.** Does the report itself get
   stored as a structured row (new MessageKind or new event kind) so the
   dashboard can render it, or only as the text inside the `model_repair`
   message that the agent sees? The first option is more useful for
   debugging but adds a schema; the second keeps the surface area
   minimal.
9. **Provider field on contract events.** The current `provider:
   'gateway-protocol'` placeholder
   ([terminal-protocol.ts#L7-L13](../../../../src/agents/terminal-protocol.ts#L7-L13))
   conflates the model identity with the verifier identity. The design
   should decide whether contract events carry the *originating candidate*
   (so health metrics stay meaningful) or carry no provider at all (so the
   verifier is presented as an in-process subsystem).
10. **Termination predicate location.** Today the adapter owns the
    `for (let turn = 0; turn < maxToolTurns; turn++)` loop and the
    "envelope null -> throw" rule. In the target model, the verifier owns
    success, but the question of who owns "agent gave up without signalling
    done" (the new `no_progress` failure) is open: the adapter's inner loop
    is still the natural site, but the loop's vocabulary changes.
