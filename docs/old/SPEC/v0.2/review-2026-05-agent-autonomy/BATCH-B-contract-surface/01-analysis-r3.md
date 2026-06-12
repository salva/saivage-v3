# Batch B — Contract Surface (F05, F06, F07)

This batch covers the three issues that together define how the runtime
declares what a finished invocation looks like, how that declaration
reaches the agent, and how the runtime closes the gap when the agent
never produces the declared shape itself.

- F05 — the role -> tool-name -> schema indirection is a global,
  hardcoded taxonomy.
- F06 — the runtime fabricates planner envelopes from deferred
  `activate_card` results, and silently accepts a legacy payload shape
  on the deferred path.
- F07 — the system prompts describe a return shape that does not match
  the runtime contract.

## 1. Functional analysis

### 1.1 Where the per-invocation contract lives today

There is no per-invocation contract. There is a global role-keyed bundle:

1. The role union [`EnvelopeBearingRole`](../../../src/agents/role-envelope-schemas.ts#L64)
   is a literal `'planner' | 'executor' | 'reviewer'`. It is the
   cardinality of "what kinds of envelope can the runtime verify".
2. The schema map [`ENVELOPE_SCHEMAS`](../../../src/agents/role-envelope-schemas.ts#L66)
   is a `Record<EnvelopeBearingRole, ZodTypeAny>` keyed by that role and
   is the only source of truth for what shape the envelope must have.
   Adding a discriminant such as "executor for `card.type === 'data'`"
   requires forking the key space.
3. The tool-name map [`ROLE_RESULT_TOOL_NAMES`](../../../src/agents/role-result-tools.ts#L4)
   maps each role to a literal function name (`emit_planner_result`,
   etc.). The three tool definitions are pre-built at module load with
   [`buildToolDef`](../../../src/agents/role-result-tools.ts#L19) by
   calling `zodToJsonSchemaMini(ENVELOPE_SCHEMAS[role])` once. The JSON
   schema is frozen at process start; no caller can vary it per
   invocation.
4. The pre-built tool list is re-published as a third
   `Record<EnvelopeBearingRole, RoleResultToolDefinition>` map
   [`ROLE_RESULT_TOOLS`](../../../src/agents/role-result-tools.ts#L34).

The adapter consumes those maps by re-deriving the role discriminant
inline every turn:

- [agent-adapter.ts#L292-L295](../../../src/agents/agent-adapter.ts#L292)
  computes `expectsEnvelope`, casts `role as EnvelopeBearingRole`, picks
  the tool name via `ROLE_RESULT_TOOL_NAMES[envelopeRole]`, and appends
  `ROLE_RESULT_TOOLS[envelopeRole]` to the tool list for that turn.
- The same role membership test repeats in
  [llm-options-factory.ts#L15](../../../src/agents/llm-options-factory.ts#L15)
  as `isEnvelopeBearing`, which then reads `ROLE_RESULT_TOOL_NAMES[role]`
  again at [L49](../../../src/agents/llm-options-factory.ts#L49) to
  validate the `terminal` phase shape.
- The verifier in
  [terminal-protocol.ts#L6](../../../src/agents/terminal-protocol.ts#L6)
  takes `role: EnvelopeBearingRole`, reads the expected name from
  `ROLE_RESULT_TOOL_NAMES[role]` and the schema from
  `ENVELOPE_SCHEMAS[role]`. All three lookups (name, schema, role-set
  membership) happen independently from independent imports.

The contracts layer duplicates the terminal-name set as a string-literal
constant [`TERMINAL_TOOL_NAMES`](../../../src/contracts/llm-exchange.ts#L35)
that is re-exported from
[`src/contracts/index.ts#L100`](../../../src/contracts/index.ts#L100)
and is also baked into the exchange-recording zod schema
[L32](../../../src/contracts/llm-exchange.ts#L32) as a literal
`z.enum([...])`. The agent-side recorder narrows incoming names through
the same enum in
[`deriveTerminalToolFromOptions`](../../../src/agents/llm-recording.ts#L64)
and [`asTerminalToolName`](../../../src/agents/llm-recording.ts#L59).
Recording, replay, and observability know the three names literally, so
any change to the role set propagates across the contracts layer, the
recording layer, and the agent layer.

The role-aware tool catalog itself bakes the terminal-tool names into
each role's allowed tool list at
[agent-tool-catalog.ts#L105/L120/L130](../../../src/agents/agent-tool-catalog.ts#L105),
which the [`RoleToolPolicy`](../../../src/agents/role-tool-policy.ts#L63)
then uses to authorize listing and invocation. The terminal tool is
therefore "just another tool the role happens to be allowed to call",
not a contract artefact distinct from the rest of the surface.

The supervisor consumes the role-typed result through three projection
functions defined in the adapter itself:
[`envelopeToPlannerResult`, `envelopeToExecutorResult`,
`envelopeToReviewerResult`](../../../src/agents/agent-adapter.ts#L49)
selected by `invokePlanner` / `invokeExecutor` / `invokeReviewer`
([L180](../../../src/agents/agent-adapter.ts#L180),
[L184](../../../src/agents/agent-adapter.ts#L184),
[L187](../../../src/agents/agent-adapter.ts#L187)), each calling the
generic [`invokeAgent`](../../../src/agents/agent-adapter.ts#L225) with
a hard-wired role string and the matching projection. The role
discrimination therefore exists in five layers:

1. The schema/tool definition modules
   ([role-envelope-schemas.ts](../../../src/agents/role-envelope-schemas.ts),
   [role-result-tools.ts](../../../src/agents/role-result-tools.ts)).
2. The factory and verifier
   ([llm-options-factory.ts](../../../src/agents/llm-options-factory.ts),
   [terminal-protocol.ts](../../../src/agents/terminal-protocol.ts)).
3. The adapter loop's inline check
   ([agent-adapter.ts#L292](../../../src/agents/agent-adapter.ts#L292)).
4. The tool catalogue / policy
   ([agent-tool-catalog.ts#L105](../../../src/agents/agent-tool-catalog.ts#L105),
   [role-tool-policy.ts](../../../src/agents/role-tool-policy.ts)).
5. The contracts layer's recording schemas and re-exports plus the
   agent-side recorder narrowing
   ([llm-exchange.ts#L32](../../../src/contracts/llm-exchange.ts#L32),
   [contracts/index.ts#L100](../../../src/contracts/index.ts#L100),
   [llm-recording.ts#L64](../../../src/agents/llm-recording.ts#L64)).

The caller of `invokeAgent` has no input into the contract beyond the
role string; everything else is positional global state.

### 1.2 How the system prompt communicates (or fails to communicate) the contract

The prompts in
[`system-prompt.ts`](../../../src/agents/system-prompt.ts) build the
role-specific text from a hand-written template that includes an
"Expected JSON Output Format" section:

- Planner prompt at
  [L64-L65](../../../src/agents/system-prompt.ts#L64):
  > Your response MUST be a single JSON object with the fields below.
  > Wrap it in a ```json code block or return raw JSON.
- Executor prompt at
  [L129](../../../src/agents/system-prompt.ts#L129) uses the same
  template, with the JSON shape repeated by hand.
- Reviewer prompt at
  [L218](../../../src/agents/system-prompt.ts#L218) uses the same
  template a third time.

The fields inside each block are written by hand from the developer's
recollection of the zod schema. They have already drifted from the
schemas:

- The planner schema
  ([role-envelope-schemas.ts#L23](../../../src/agents/role-envelope-schemas.ts#L23))
  is `.strict()` and allows `tags`/`id` as optional fields on created
  cards and `acceptance` on updated cards; the prompt
  ([system-prompt.ts#L79](../../../src/agents/system-prompt.ts#L79))
  describes `tags` and `id` but omits `acceptance` from the
  update template.
- The executor schema
  ([role-envelope-schemas.ts#L49](../../../src/agents/role-envelope-schemas.ts#L49))
  has `artifacts.sourceFile` and `artifacts.path` both optional and a
  free `result: z.record(z.string(), z.unknown())`; the prompt
  ([system-prompt.ts#L143](../../../src/agents/system-prompt.ts#L143))
  inserts narrative constraints inside the JSON shape ("never a project
  source/config/test file or directory") that have no schema
  counterpart.
- The reviewer schema requires `assessment.result` to be
  `'pass' | 'needs_corrections'` via `reviewerResultSchema` in
  [src/schemas/index.ts](../../../src/schemas/index.ts), which the
  prompt restates as a stringly-typed enumeration in prose
  ([system-prompt.ts#L223](../../../src/agents/system-prompt.ts#L223)).

More importantly, the prompts disagree with the runtime contract on the
*mechanism* of return:

- The prompt says "return a single JSON object, wrap it in a ```json
  code block or return raw JSON".
- The runtime only accepts the return as the `arguments` of a
  structured tool call named `emit_${role}_result`.
- The verifier
  ([terminal-protocol.ts#L6](../../../src/agents/terminal-protocol.ts#L6))
  raises `LlmRequestError(contract_mismatch / terminal_tool_missing)`
  when the agent obeys the prompt verbatim and produces a plain JSON
  message.
- The recovery policy then turns that error into `fail_invocation` +
  abort, per the brief.

The terminal tool name `emit_${role}_result` is never mentioned in any
prompt: there is no string `emit_planner_result` (or sibling) anywhere
in `system-prompt.ts`. The agent can only learn that name from the tool
catalogue passed in the LLM request payload, which OpenAI-style
providers generally surface only as a function list — the prompt itself
never claims that the function exists, never describes it as the
terminal action, and never tells the agent that a failure to call it
terminates the candidate.

The per-invocation prompt mutations on the role runner are also
non-contractual.
[`agent-role-runner.ts#L40`](../../../src/agents/agent-role-runner.ts#L40)
appends a `buildSelfCheckPrompt` block every N rounds; that block
carries its own ad-hoc JSON shape
(`{"self_check": "ok" | "stuck" | "escalate", ...}`) with no verifier
on the runtime side. The system prompt therefore carries two
contract-shaped descriptions — the envelope and the self-check — and
the runtime enforces neither of them through the prompt itself.

### 1.3 How deferred activations synthesise envelopes

The planner's runtime tool `activate_card` is special: the
planner-control executor does not run a child; it records an activation
in the ledger and returns a `deferred_activate_card` envelope inside
the tool result.

- [planner-control-executor.ts#L120](../../../src/agents/planner-control-executor.ts#L120)
  and
  [L131](../../../src/agents/planner-control-executor.ts#L131) shape
  the success path:
  ```
  result = { success: true, activation,
             deferred: createDeferredActivationEnvelope({ ... }) };
  ```
  Both the existing-activation and new-activation branches embed the
  same `DeferredActivationEnvelopeV1` schema produced by
  [`createDeferredActivationEnvelope`](../../../src/schemas/validators.ts#L54).

The parser used by the adapter to recognise the deferred shape carries
a backward-compatibility fallback that must not survive the redesign:

- [`parseDeferredActivationEnvelope`](../../../src/schemas/validators.ts#L64)
  first tries the strict `DeferredActivationEnvelopeV1` schema.
- If that fails, it accepts any payload with
  `__saivage_defer_tool_result === true` and a string `child_card_id`
  (or `cardId` / `card_id`), then manufactures a
  `DeferredActivationEnvelopeV1` whose `parent_card_id`,
  `planner_session_id`, and `tool_call_id` are the literal string
  `legacy` ([validators.ts#L68-L70](../../../src/schemas/validators.ts#L68)).
- The adapter treats any parsed deferred envelope as the trigger for
  the synthesis branch
  ([agent-adapter.ts#L352](../../../src/agents/agent-adapter.ts#L352)),
  so this fallback is part of the live contract surface, not dead
  parser code.

Under the workspace constraint of no migration shims and no preserved
old formats, this branch is a smell that the redesign must delete
rather than refactor: it manufactures three "identity" fields that
downstream session-persistence consumers
(see [1.5](#15-persistence-and-recording-consumers-of-the-deferred-and-activate_card-surfaces))
expect to be real ledger keys.

The adapter looks for the deferred envelope explicitly inside the
per-turn loop:

- For each non-terminal tool result,
  [agent-adapter.ts#L352](../../../src/agents/agent-adapter.ts#L352)
  calls
  ```
  const deferred = role === 'planner' && tc.function.name === 'activate_card'
    ? parseDeferredActivationEnvelope(msg.content) : null;
  if (deferred) deferredActivations.push(deferred);
  else toolMessages.push(msg);
  ```
  Deferred activations are diverted out of the normal `tool_result`
  stream.

- When the turn ends with
  `toolMessages.length === 0 && deferredActivations.length > 0`
  ([agent-adapter.ts#L358](../../../src/agents/agent-adapter.ts#L358)),
  the adapter:
  1. Constructs an ad-hoc `CardStore` from `projectRoot` inline at
     [agent-adapter.ts#L360](../../../src/agents/agent-adapter.ts#L360)
     to look up each activated child.
  2. Walks each child's `depends_on` and reads each dependency card.
  3. If any dependency is in `failed` or `blocked`, fabricates
     `finalEnvelope = { status: 'blocked', blocked_reason, summary, ... }`
     and appends a `system / model_issue` row narrating that synthesis.
  4. Otherwise fabricates
     `finalEnvelope = { status: 'continue', summary: 'Activated child card ...', created_cards: [], updated_cards: [] }`
     and appends a `system / model_issue` row.
  5. Breaks out of the turn loop with that envelope as if the planner
     had called `emit_planner_result`.

The envelope is then passed unchanged to `envelopeToPlannerResult`, and
the supervisor consumes it as a real planner result. The planner never
sees the synthesised envelope: it is not stored as a `tool_call`, it is
stored as an `assistant / text` row with the JSON string at
[agent-adapter.ts#L388](../../../src/agents/agent-adapter.ts#L388).

This synthesis couples several concerns into the generic adapter loop:

- Card-store reads (the `CardStore` constructor is invoked inline).
- Card-graph traversal (dependency walking).
- Planner-specific state-machine knowledge ("`blocked` is the right
  status if a dependency is `failed`/`blocked`").
- A specific reading of the verifier-and-repair contract: the planner
  is considered "done" with this turn even though it never produced a
  result the verifier would accept on its own.
- An out-of-band side channel through `model_issue` system rows that
  becomes part of the next planner context, but is not part of the
  result the verifier sees.

The synthesis branch also short-circuits the maxToolTurns budget: as
soon as the turn produced only a deferred activation, the loop exits
regardless of how many turns remained.

The result: the deferred-activation path is structurally a second
terminal action that lives outside the contract — a way for the planner
to "finish" its turn without ever calling `emit_planner_result`.
Whether this is allowed depends on which file you read.

### 1.4 Downstream supervisor consumers of the typed results

The role envelope projections feed concrete consumers that the
supervisor cannot ignore when the contract shape changes. The public
types live in
[src/contracts/agent-execution.ts#L30-L79](../../../src/contracts/agent-execution.ts#L30):
`PlannerResult` (status + `created_cards` + `updated_cards`),
`ExecutorResult` (with required `status_text` and
`fallback_with_evidence`), and `ReviewerResult` (assessment shape).

- The planner driver in
  [runtime.ts#L677-L697](../../../src/runtime/runtime.ts#L677) calls
  `agentRuntime.invokePlanner` and consumes the resulting
  `PlannerResult.status`, `blocked_reason`, and `created_cards` to
  decide whether to mark the goal `blocked`, finish the iteration loop,
  or dispatch pending activations.
- `applyPlannerResult` in
  [runtime.ts#L822-L842](../../../src/runtime/runtime.ts#L822)
  materialises `created_cards` and `updated_cards` directly into the
  card store and the state machine; it reads `cardDef.id`, `tags`,
  `acceptance`, and `status` off the typed result.
- The reviewer driver reads `ReviewerResult.assessment`
  (`evidence_card_ids`, `result`, `summary`, `achieved`, `issues`) when
  validating and persisting an assessment at
  [runtime.ts#L453-L470](../../../src/runtime/runtime.ts#L453).

These consumers are the actual blast radius of "we change the result
type" or "we move the projection to the contract". The redesign cannot
keep them implicitly working through ambient role strings; the chosen
contract value has to either project to exactly these shapes or the
consumers move with the projections.

### 1.5 Persistence and recording consumers of the deferred and activate_card surfaces

Beyond the synthesised `assistant / text` row at
[agent-adapter.ts#L388](../../../src/agents/agent-adapter.ts#L388),
`activate_card` participates in three persistence/recording surfaces
that the redesign must account for:

- The session-persistence scanner
  [`findUniqueUnresolvedActivateCardToolCall`](../../../src/agents/session-persistence.ts#L404)
  walks persisted assistant `tool_call` rows for unresolved
  `activate_card` calls and reconciles them against persisted
  `tool_result` / `tool_error` rows
  ([L404-L432](../../../src/agents/session-persistence.ts#L404)).
- The completion-side writer
  [`appendActivateCardToolResultOnce`](../../../src/agents/session-persistence.ts#L445)
  persists the activation-completion tool result idempotently when a
  child terminates ([L445-L461](../../../src/agents/session-persistence.ts#L445)).
- The runtime keeps a parallel unresolved-activation scanner
  [`findUnresolvedActivateCards`](../../../src/runtime/runtime.ts#L235)
  ([L235-L260](../../../src/runtime/runtime.ts#L235)) that recognises a
  completion only when
  [`parseActivationCompletionEnvelope`](../../../src/schemas/validators.ts#L75)
  succeeds on the `tool_result` content.

These scanners are the reason `parent_card_id`, `planner_session_id`,
and `tool_call_id` matter: they key resolution off the persisted
tool-call id, and they reason about "unresolved activate_card" purely
from the message log. A redesign that changes whether `activate_card`
is an ordinary tool, a terminal signal, or a contract-recognised
deferred signal has to specify how each scanner distinguishes
unresolved calls, completion envelopes, and contract terminal records.

## 2. Target behaviour (informal)

### 2.1 Per-invocation contract declaration

The desired model is that every `invokeAgent` call declares the
contract explicitly rather than inferring it from a role string. The
contract is a value with three responsibilities, owned by the caller of
`invokeAgent`:

- **Schema** — a zod (or zod-equivalent) schema that describes the
  wire shape the agent must produce. Used by (a) the verifier in
  `terminal-protocol.ts`, (b) the JSON-schema rendering that the
  runtime exposes to the LLM, and (c) the supervisor that consumes the
  typed result.
- **Done signal** — the structural shape that says "this invocation is
  finished". Today this is "the agent called the terminal tool". The
  redesign needs to express it as part of the contract value, not as
  membership in a global tool-name map, so that:
  - The done signal can be a tool call whose name is derived from the
    contract instance.
  - The done signal can be expressed in prose to the agent in the
    prompt using the same source of truth as the verifier.
  - Other shapes ("done, awaiting child") can be added as additional
    declared done signals on the same contract rather than as
    out-of-band synthesis (see 2.3).
- **Repair-message format** — when the verifier finds the produced
  shape does not satisfy the contract, the runtime must turn the diff
  into a structured message back to the agent. The repair format is
  therefore a symmetric pair with the schema and lives on the same
  contract.

What "lives in the contract" means concretely:

- The contract is constructed by the caller of `invokeAgent`. The
  supervisor building a planner invocation owns the planner contract;
  the supervisor building an executor invocation owns the executor
  contract. The contract is not picked up by passing a role enum.
- The runtime stops treating "role" as the contract key. The role
  remains meaningful for *prompt selection*, *tool catalogue
  selection*, and *recording metadata*, but the verifier no longer
  indexes anything by role. Concretely:
  - `EnvelopeBearingRole`, `ENVELOPE_SCHEMAS`, `ROLE_RESULT_TOOL_NAMES`,
    `ROLE_RESULT_TOOLS`, the `isEnvelopeBearing` branch in
    `llm-options-factory.ts`, the inline check at
    [agent-adapter.ts#L292-L295](../../../src/agents/agent-adapter.ts#L292),
    and the literal enum in
    [llm-exchange.ts#L32](../../../src/contracts/llm-exchange.ts#L32)
    all collapse into "the contract value carries its own name and its
    own schema, and the recording layer reads those off the contract".
  - `validateTerminalToolCall` becomes
    `verifyAgainstContract(call, contract)`.
  - The role -> tool-name list in
    [agent-tool-catalog.ts#L105/L120/L130](../../../src/agents/agent-tool-catalog.ts#L105)
    is computed by appending `contract.toolDefinition()` to the role's
    base tool list at the call site of `buildToolsForRole`, not at
    module load.
- Adding a new contract (for example, splitting executor by card type)
  is a new contract instance constructed at the call site. No new
  entry in any role-keyed map is required.

The flow of the contract through the system becomes:

```
caller constructs Contract{schema, doneShape, repairFormat, name}
  -> invokeAgent(..., contract)
       -> system prompt rendered from prompt source + contract.describeFor(prompt)
       -> tool list includes contract.toolDefinition()
       -> verifier = contract.verify(call) | contract.diff(call)
       -> recording layer logs candidate + contract.name
       -> supervisor receives contract.project(envelope) typed result
```

The supervisor's three projection functions
([`envelopeToPlannerResult`,
`envelopeToExecutorResult`,
`envelopeToReviewerResult`](../../../src/agents/agent-adapter.ts#L49))
become projections owned by the contract or by the caller, not by the
adapter. Their outputs are the typed results in
[contracts/agent-execution.ts#L30-L79](../../../src/contracts/agent-execution.ts#L30)
that the planner driver, `applyPlannerResult`, and the reviewer driver
already consume; the redesign must move them as a unit so that those
consumers still receive the same typed values whether or not the
contract is per-invocation.

### 2.2 System prompt and runtime contract as one source of truth

The redesign requires a single source of truth for both:

- The wire shape (what the agent must return).
- The naming and mechanism of return ("call the function `X`").

Concrete consequences:

- The hand-written JSON shape in `system-prompt.ts` for each role is
  deleted. Whatever describes the contract to the agent is generated
  from the same schema the verifier uses.
- The prompt text *names* the terminal tool
  ("call `${contract.toolName}`") using the contract value. There is
  no scenario in which the prompt and the verifier can disagree
  because both consume the contract.
- The "wrap it in a ```json code block or return raw JSON"
  instruction is removed; the prompt instead tells the agent that
  producing a plain message does not finish the invocation and that
  the runtime will respond with a structured repair request. This
  aligns the prompt with the verifier-and-repair model in the brief.
- The narrative constraints currently embedded inside the JSON shape
  (for example the artifact "never a project source/config/test file"
  prose) move to prompt-level guidance outside the contract block,
  since they are not enforced by the schema. Alternatively the schema
  gains the constraint and the prompt simply describes it once.
- The self-check block from `buildSelfCheckPrompt` is either deleted
  (it bypasses the contract anyway) or upgraded to be a contract of
  its own that flows through the same verifier path. The redesign
  should not leave it as a half-channel.

The brief's "phase swap" pattern in `llm-options-factory.ts` (`'tools'`
vs `'terminal'`) becomes contract-driven as well: the existence of a
contract means every turn carries the contract's done-signal tool. The
role-keyed phase machinery (`LlmRolePhase`, the dead `terminal` branch
at
[llm-options-factory.ts#L44](../../../src/agents/llm-options-factory.ts#L44))
disappears.

### 2.3 Deferred activations under the redesign

The synthesis at
[agent-adapter.ts#L358](../../../src/agents/agent-adapter.ts#L358)
only exists because the planner's terminal contract
(`emit_planner_result` with `status: 'continue' | 'done' | 'blocked'`)
has no clean way to express "I am done with this turn, I am awaiting a
child activation". The operator complaint in the brief is that the
runtime is "a per-turn protocol cop"; the synthesis is the most extreme
instance of that, because the runtime is not just policing the
protocol, it is forging the answer.

Independently of which path below is chosen, the legacy
`__saivage_defer_tool_result` fallback at
[validators.ts#L68-L70](../../../src/schemas/validators.ts#L68) is
removed. There is no "legacy" identity-field synthesis under the
redesign; if a deferred shape is accepted at all, it is accepted only
when the strict `DeferredActivationEnvelopeV1` schema validates and
carries real session/tool-call/parent identities.

The redesign question is how the runtime should treat the deferred
case under a contract-verifier model. Three positions are possible;
this batch intentionally enumerates them rather than picking one — the
choice is a design-phase decision.

- **Position A: synthesise, but only via a contract-recognised
  done-signal value.**
  The planner contract grows a second done signal
  "deferred-child-activation" whose body is the
  `DeferredActivationEnvelopeV1` already produced by the
  planner-control executor. The adapter pattern still fires when the
  planner ends a turn having only called `activate_card`, but instead
  of fabricating an envelope it constructs a contract-recognised
  done-signal value from the deferred envelope. The synthesis branch
  shrinks to a one-liner because the dependency walk and the planner-
  result fabrication go away; the supervisor learns to project the
  deferred-activation done signal into `PlannerResult` itself, not the
  adapter.

  **Compatibility risk:** Position A is the only option that keeps the
  runtime "finishing the turn on the agent's behalf". Under the
  brief's verifier-and-repair model and the workspace rule of no
  backward-compatibility preservation, "still synthesise" is the
  shape closest to today's behaviour, and the contract wrapper can
  cleanly hide that fact from downstream code. The design phase must
  not treat A as architecture-neutral: if A is chosen, it has to be
  reframed as a real contract output owned by the tool invocation
  (the planner-control executor emits the done-signal value, the
  adapter only forwards it), not as a planner-result fabrication path
  in the adapter under a new name.

- **Position B: require the agent to emit the terminal envelope.**
  The deferred case is just one more case the planner has to handle.
  The prompt tells the planner "after `activate_card`, also call
  `emit_planner_result` with `status: 'continue'`". The adapter loses
  the synthesis branch entirely; the verifier-and-repair loop takes
  over when the planner forgets. The deferred-activation envelope
  returned by the tool result becomes informational only.

- **Position C: introduce a new "done, awaiting child" terminal
  signal as its own contract output.**
  Neither the planner-control executor nor the adapter synthesises
  anything; instead the agent has a second terminal tool (e.g.
  `emit_planner_continuation`) that is part of the planner contract
  and that the verifier recognises. The done signal is no longer
  unique; the contract value carries a *set* of acceptable terminal
  tool names plus a schema per name.

Open question for the design phase: which of A/B/C best matches the
verifier-and-repair model. A and C also resolve F03 (no clean
"awaiting child" signal); B leaves F03 to be addressed by prompt
instructions alone. Whichever path is chosen, the synthesis branch's
incidental concerns must move out of the adapter regardless:

- The CardStore construction inside the adapter
  ([agent-adapter.ts#L360](../../../src/agents/agent-adapter.ts#L360))
  is not the adapter's responsibility.
- The dependency walk is planner-state-machine logic and belongs in
  the planner-control executor or the supervisor.
- The `system / model_issue` rows narrating synthesis are
  observability artefacts; if the synthesis stops being a thing,
  those rows stop too.

## 3. Cross-cutting constraints

Removing the role-keyed taxonomy and the synthesis branch and aligning
the prompt with the verifier touches the following surfaces:

- **`src/contracts/`**
  - `TERMINAL_TOOL_NAMES` at
    [llm-exchange.ts#L35](../../../src/contracts/llm-exchange.ts#L35)
    and its re-export at
    [contracts/index.ts#L100](../../../src/contracts/index.ts#L100)
    cease to be a static literal. The recording layer must accept any
    `contract.toolName` value; the zod enum in
    [llm-exchange.ts#L32](../../../src/contracts/llm-exchange.ts#L32)
    becomes `z.string()` or is derived from a registered-contract
    list held by the recorder rather than the schema.
  - The `terminalTool` field on `ExchangeAttempt` becomes
    informational metadata rather than a closed enum.
  - `PlannerResult` / `ExecutorResult` / `ReviewerResult` in
    [contracts/agent-execution.ts#L30-L79](../../../src/contracts/agent-execution.ts#L30)
    stay (the supervisor still wants typed results); their
    construction moves to contract projections, and the
    `envelopeTo*Result` functions in
    [agent-adapter.ts#L49-L75](../../../src/agents/agent-adapter.ts#L49)
    move to the same module as the contract value or to the
    supervisor side.

- **Supervisor consumers**
  - `invokePlanner` / `invokeExecutor` / `invokeReviewer` stop
    hard-wiring a role string + projection pair; instead they take
    (or construct) a contract value and pass it through.
  - The planner driver
    ([runtime.ts#L677-L697](../../../src/runtime/runtime.ts#L677)),
    `applyPlannerResult`
    ([runtime.ts#L822-L842](../../../src/runtime/runtime.ts#L822)),
    and the reviewer driver
    ([runtime.ts#L453-L470](../../../src/runtime/runtime.ts#L453))
    must continue to receive `PlannerResult` and
    `ReviewerResult` of the same shape they consume today, or be
    edited in lockstep with the projection move. Typed-result
    compatibility with these sites is to be broken intentionally
    rather than left to drift.
  - The supervisor must learn to project the deferred-activation
    case if Position A is chosen, or to tolerate retries if Position
    B is chosen.
  - Tests around `envelopeToPlannerResult` move with the projection.

- **`src/agents/planner-control-executor.ts`**
  - The `deferred: createDeferredActivationEnvelope(...)` payload at
    [L120](../../../src/agents/planner-control-executor.ts#L120) and
    [L131](../../../src/agents/planner-control-executor.ts#L131)
    either stays (Position A or C) or is replaced with an ordinary
    `tool_result` describing the activation (Position B). The
    card-store reads and dependency walk that the adapter currently
    does on top of this response also belong here if they stay
    anywhere.

- **`src/schemas/validators.ts` (parser shape)**
  - The legacy `__saivage_defer_tool_result` fallback at
    [validators.ts#L68-L70](../../../src/schemas/validators.ts#L68)
    is deleted. `parseDeferredActivationEnvelope` either keeps only
    its strict-schema branch or is removed entirely, depending on
    whether deferred envelopes remain a recognised tool-result shape
    in the chosen position.
  - `DeferredActivationEnvelopeV1` and its strict schema stay if
    Position A or C is chosen; under Position B they remain as a
    tool-result body rather than as a synthesis signal.

- **`src/agents/system-prompt.ts`**
  - The "Expected JSON Output Format" blocks in
    `buildPlannerPrompt`, `buildExecutorPrompt`,
    `buildReviewerPrompt` are removed and replaced with a single
    rendering of `contract.describeFor(prompt)`. The hand-written
    field lists drop.
  - The terminal tool name appears in the prompt via the contract
    value, not as a hard-coded string.
  - The `buildSelfCheckPrompt` ad-hoc JSON shape either becomes a
    self-check contract or is removed entirely; either way it is no
    longer a parallel un-verified channel.

- **`src/agents/agent-tool-catalog.ts`**
  - The `ROLE_TOOL_NAMES` entries that splice in
    `ROLE_RESULT_TOOL_NAMES.{role}` at
    [L105/L120/L130](../../../src/agents/agent-tool-catalog.ts#L105)
    drop the terminal tool from the static list. The terminal tool
    is appended at call time from the contract by
    `buildToolsForRole` (or its successor).
  - `RoleToolPolicy` no longer treats the terminal tool as a
    generic role-allowed tool; it has a separate code path "the
    contract's done signal is always allowed for this invocation".

- **Persistence and recording around `activate_card`**
  - The session-persistence scanners
    [`findUniqueUnresolvedActivateCardToolCall`](../../../src/agents/session-persistence.ts#L404)
    and
    [`appendActivateCardToolResultOnce`](../../../src/agents/session-persistence.ts#L445),
    plus the runtime's
    [`findUnresolvedActivateCards`](../../../src/runtime/runtime.ts#L235),
    key off persisted `assistant / tool_call` rows, persisted
    `tool_result` / `tool_error` rows, and
    `parseActivationCompletionEnvelope`. Whichever position is
    chosen for deferred activations must define how these scanners
    classify (a) the planner's `activate_card` tool call, (b) the
    activation-completion tool result, and (c) any contract-emitted
    terminal record. The synthesised
    `assistant / text` row at
    [agent-adapter.ts#L388](../../../src/agents/agent-adapter.ts#L388)
    must either become a `tool_call` of the contract's done signal
    (when the planner emits it) or a typed
    `system / contract_synthesis` record (if a contract-recognised
    synthesis path stays), so that replay can distinguish "planner
    wrote this" from "runtime wrote this".

- **`src/agents/llm-options-factory.ts` and
  `src/agents/terminal-protocol.ts`**
  - `isEnvelopeBearing`, `LlmRolePhase`, and the entire `terminal`
    branch of `buildLlmOptions`
    ([L44-L62](../../../src/agents/llm-options-factory.ts#L44))
    collapse with the role taxonomy. The factory becomes "build
    options given a tool list and a contract".
  - `validateTerminalToolCall(call, role)` becomes
    `verify(call, contract)`, with no role argument.

- **`src/agents/agent-adapter.ts`**
  - The inline role-discriminant block at
    [L292-L295](../../../src/agents/agent-adapter.ts#L292)
    disappears.
  - The synthesis block at
    [L358-L380](../../../src/agents/agent-adapter.ts#L358)
    disappears (Position B) or shrinks dramatically (Position A/C),
    and in both cases the inline `CardStore` construction at
    [L360](../../../src/agents/agent-adapter.ts#L360) and the
    `system / model_issue` synthesis rows move out.
  - The `model_repair` nudge introduced by the tactical mitigation
    is subsumed by the verifier-and-repair loop and removed as a
    special case.

- **Recording, replay, exchange schemas**
  - `TERMINAL_TOOL_NAMES` is consumed at runtime by the agent-side
    recorder in
    [`deriveTerminalToolFromOptions`](../../../src/agents/llm-recording.ts#L64)
    and [`asTerminalToolName`](../../../src/agents/llm-recording.ts#L59).
    When the enum widens, the recorder must read the terminal-tool
    name from contract metadata carried on the invocation (for
    example a `terminalToolName` field on the `LlmCompleteOptions`
    or on the recorder request), instead of narrowing through a
    closed three-name set.
  - Tests in `tests/agent-recording*` and similar that pin the
    `terminalTool` enum to the three literal names need to follow
    the `TERMINAL_TOOL_NAMES` widening.

## 4. Open questions for the design phase

1. **Where is the contract value declared?** A standalone module
   under `src/agents/contracts/` parallel to today's
   `role-envelope-schemas.ts`, or co-located with the supervisor
   that constructs each invocation? The brief says "the contract
   is a property of the call, not a global role string"; we still
   have to pick the file.
2. **Schema rendering for the prompt.** Does
   `contract.describeFor(prompt)` render the same
   `zodToJsonSchemaMini` output that the tool definition uses,
   render a human-readable description generated from the schema,
   or render both? The current prompt uses prose with embedded type
   hints, which is friendlier to weaker models than raw JSON schema.
3. **Cardinality of done signals.** Is a contract
   `{ schema, toolName, repairFormat }` (Position A/B, single done
   signal), or `{ schemas: Record<toolName, schema>, repairFormat }`
   (Position C, multiple done signals)? The choice changes how the
   verifier and recorder are typed.
4. **Repair-format definition.** The brief says the runtime sends "a
   structured list of unmet obligations". Where does that structure
   live? On the contract itself (each schema describes how to diff
   itself), as a runtime-owned format that consumes a zod issue
   list, or as a contract-owned method
   `contract.diff(envelope) -> repair_message`?
5. **Deferred activations (positions A vs B vs C, see 2.3).** This
   is intentionally deferred to design. Whichever path is chosen,
   F03's "no clean awaiting-child signal" must be resolved
   coherently with this batch's outcome, and the persistence
   scanners listed in 1.5 must remain functional under the new
   shape.
6. **Analyst path.** The analyst currently bypasses the envelope
   contract (the `expectsEnvelope` check at
   [agent-adapter.ts#L304-L305](../../../src/agents/agent-adapter.ts#L304)
   takes the `result.kind === 'message'` early exit). Once the
   contract becomes a value, the analyst can either keep using a
   "free text" contract whose schema is `z.string()`, or remain
   genuinely outside the loop. The brief leaves this optional.
7. **Recording-layer back-pressure.** `TERMINAL_TOOL_NAMES` is
   currently a closed `z.enum(...)` on
   `exchangeAttemptSchema.terminalTool` and a closed runtime check
   inside `deriveTerminalToolFromOptions`. If we widen it to
   `z.string()` and pass terminal-tool metadata through the
   invocation, do we lose any test or downstream consumer that
   depends on closed-enum exhaustiveness?
8. **Self-check channel.** Is the self-check block emitted by
   [`buildSelfCheckPrompt`](../../../src/agents/system-prompt.ts#L253)
   (with the ad-hoc `self_check` JSON examples at
   [L268](../../../src/agents/system-prompt.ts#L268),
   [L270](../../../src/agents/system-prompt.ts#L270), and
   [L272](../../../src/agents/system-prompt.ts#L272))
   removed, kept as prose only, or formalised as a separate
   contract? Today it has the shape but none of the enforcement of
   one.
9. **Role still exists.** Roles remain meaningful for prompt
   selection, tool catalogue selection, and observability tags.
   Where does the role/contract boundary live in the resulting
   types — does the role stay on the `invokeAgent` signature for
   prompt routing, or does the contract carry a "human label" that
   the recorder uses instead?

These questions are the input to the design phase for this batch.
