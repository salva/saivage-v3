# Saivage v3 System Architecture

Status: current design summary.

Last updated: 2026-07-13.

## 1. Architectural Shape

Saivage is a card-centered autonomous runtime with a conversational control surface.

The runtime engine is Node.js 24; `package.json` engines require `node >=24 <25` and `npm >=10 <12`, matching the GitHub Actions CI validation environment.

The major subsystems are:

- Operator web UI: read-only workspace plus always-visible Analyst panel.
- Analyst agent: user-facing inspection and mutation orchestrator.
- Runtime control surface: `SupervisorRuntimeApi` coordinates root intent, run/resume, pause state, active-work ownership, and recovery against durable `RuntimeState`. Its current internal shutdown cleanup selects the runtime-root `runtime_card` process scope tree and rejects if any selected group cannot be proved absent; it is not an Analyst control. Server restart is scheduled only by the Analyst session actor through the application-owned `RestartPort`; tools and `ToolContext` cannot access that port.
- Canonical card service: Analyst-owned card mutation validation, durable tree updates, audit/projection events, and active-runtime change notification.
- Card store: durable project hierarchy and card history.
- Agent sessions: planner, executor, reviewer, and analyst transcripts.
- Agent services: LLM invocation, tool dispatch, model-visible message construction, and transcript persistence.
- Managed process registry: instance-local opaque scope topology, category-bound detached groups, safe in-memory process read models, and no restart adoption.
- Notification queue: card-addressed ephemeral context delivery.
- HTTP/WebSocket server: server-composition-owned `AuthPolicy` instances authenticate projections, debug ingress, ticket issuance, and chat transport; policies and tickets are never module-global.

## 2. Semantic Layers

Runtime is infrastructure. Operator UI and HTTP/WebSocket transport are infrastructure surfaces. Analyst is the user-facing control agent. Planner, executor, and reviewer are worker agent roles.

This distinction matters: the runtime should not be described as a peer of planner/executor/reviewer. It owns dispatch and persistence. Worker agents perform card work under runtime control. The Analyst controls the system on behalf of the user through canonical services.

### Server-restart boundary

`AuthPolicy.authEnabled` is the single composition-owned restart-availability capability. With it enabled, the authenticated `analyst`/`web-chat` catalog and prompt include `restart_server`; with it disabled, every catalog omits the tool while ordinary HTTP and WebSocket chat ingress remains available. The executor still enforces that capability and records the explicit unavailable denial for a direct or stale disabled-auth call. Authenticated `rest` and `telegram` surfaces also omit the destructive tool.

The actor, rather than the executor, owns the confirmation state and the sole `RestartPort.schedule()` call. The first allowed tool result establishes confirmation-required state without scheduling; the exact next global-session confirmation appends its canonical message and audit action before scheduling. HTTP bearer validation and WebSocket ticket validation authorize entry to that same global authority but create no principal identity. Pending restart state is therefore actor/session state, never client, connection, token, browser, device, or transport state.

Transport owns completion acknowledgement. REST calls `RestartPort.acknowledge()` only after its scheduled response finishes writing, while WebSocket calls it only after the terminal scheduled acknowledgement frame's send callback succeeds. `acknowledge()` disposes the application and exits once with status 75. No component claims that a successor is available or ready.

Planner, executor, reviewer, and analyst system prompts are rendered by the `PromptTemplateRegistry` through `src/utils/prompt-api.ts`. Agent identity is the `(cardType, role)` pair: project and goal planners are distinct prompt slots, each terminal card type has its own executor prompt, and the analyst uses the synthetic `analyst/analyst.md` slot. Built-in defaults ship as Markdown files under `src/prompts/<cardType>/<role>.md` and are copied to `dist/prompts/` at build time. Project overrides live in `.saivage/config/prompts/<cardType>/<role>.md`; an override file replaces the matching default, while absent override files fall back to the shipped default. Startup validates placeholder syntax and role-specific placeholder names for every active effective template before any agent turn. Planner templates can render card identity/brief, terminal contract description, and the live tool list; executor templates add card type; reviewer templates add assessment identity; analyst templates render the analyst tool list, vocabulary snippet, and project context. Type-specific executor guidance is ordinary prose inline in each terminal executor Markdown file. System-prompt persistence is still deduped once per session, and reviewer turns intentionally skip notification delivery; the registry changes the source of prompt text, not those persistence and notification rules.

The detailed micro-actor module architecture is specified in [Declarative micro-actor module architecture](./declarative-micro-actor-module.md).

## 3. Ownership Boundaries

The runtime is the only dispatcher. Agents request work through tools; they do not directly invoke other agents.

Snapshot-owning `LLMActor` is an autonomous card-work boundary for planner, reviewer, and executor identities only. Analyst conversations remain valid LLM identities but are served by `ConversationLLMActor`; they persist durable conversations and are excluded from autonomous startup recovery and global tool settlement.

Planner/card state owns hierarchy, objectives, dependencies, evidence, status, result data, working status, and history. Runtime execution state owns only current runtime status/cursor data, process records, and recovery metadata; command, run, and activation ledgers are not persisted runtime state.

Changing planner/card state does not by itself dispatch work. Root work starts through explicit runtime control; child work starts through parent-planner `activate_card`.

The Analyst is the global card mutation authority for user-requested changes. Analyst card mutations go through the canonical card service, which must not start autonomous work directly. Planners have local card authority only over direct children of the goal they own; they do not directly target ancestors, siblings, unrelated cards, or deeper descendants. Recursive operations such as cancelling or deleting a direct child may affect that child's subtree as a runtime consequence. Cards may be reordered among siblings where supported, but cross-parent movement is not a supported operation.

## 4. Active Work Model

At most one leaf card is doing real work at a time. The active work chain can contain multiple cards with durable status `running`, but only the leaf receives scheduling, LLM turns, or process work.

Durable card status is one of exactly `backlog`, `running`, `blocked`, `changed`, `done`, `failed`, or `cancelled`. Parent-visible card activation outcomes are exactly `done`, `failed`, `blocked`, or `cancelled`; the runtime completion outcome schema also admits `timed_out` where timeout handling applies.

Ancestors hold activation context for their active child. That context is actor data, not a separate card state.

The runtime persists only the active-card-run cursor for current work, never runtime command/run/activation ledgers. Direct ownership records the current direct source. Activation ownership records the parent card plus the canonical parent conversation triple (`session_id`, `source_input_id`, `tool_call_id`) for display/current-work routing; it never stores `activation_id`, `parent_run_id`, or replacement ledger ids. Startup recovery does not use that cursor as an activation ledger: activation edges are derived from active parent conversation `activate_card` tool calls and card/actor state.

Activation validation happens before dispatch. A parent planner can activate only an immediate child in `backlog`, `changed`, or `blocked`. Activation transitions the child to `running`; child main-agent `done`, `failed`, or `blocked` outcomes update the child card before the parent planner receives the activation tool result. Runtime cancellation can instead resolve the parent-visible activation as `cancelled`; processors do not emit `cancelled`. `done` cards are not activatable unless later modification changes them to `changed`; `failed` cards are not activatable and require explicit planner/operator handling such as cancellation, replacement, edit-to-`changed`, or escalation.

## 5. Agent Lifecycle

Planner, executor, and reviewer sessions are card-lifetime. Each role has a deterministic session id derived from the card, persists one conversation thread across activations, and resumes by loading the active persisted conversation version from disk before adding the current activation's runtime-provided context rows. Card-scoped session directories live under the owning card at `.saivage/cards/<cardId>/conversations/<encoded-session-id>/`; Analyst sessions are user-facing conversational sessions that load the same active-version format from `.saivage/agents/conversations/<encoded-session-id>/` before each model turn. There is no activation-lived executor transcript or one-shot reviewer transcript in the current architecture. `cardIdFromSessionId` is the singular routing authority for session ownership.

Actor cursor snapshots follow the same ownership boundary. Card actors, processors, and snapshot-owning card-scoped planner/executor/reviewer `LLMActor`s persist under `.saivage/cards/<cardId>/runtime/actors/<kind>/<encoded-actor-id>.json`; Analyst turns use `ConversationLLMActor` and persist only their durable conversations under `.saivage/agents/conversations/<encoded-session-id>/`. Actor-id parsers are the singular routing authority for cursor placement; the old global `.saivage/runtime/actors` cursor root is not current state.

The conversation log follows the encapsulation principle: every provider-visible message is persisted as a transcript row when it is added to provider context. That includes assistant text, tool calls, tool results with full bodies, model repairs, notifications delivered at safe pre-provider-call points, continuation-hook directives, and reviewer descendant context. Runtime-significant activity rows remain conversation state; at minimum `activation_open` markers are persisted as activation/round boundaries while remaining excluded from prompt construction. Provider exchange audit metadata is app-log backed instead of conversation backed: settled attempts append sanitized `provider_exchange` entries to `.saivage/logs/app.jsonl` with session id, source input id, attempt index, timestamp, and the provider-exchange payload. These entries contain envelope metadata only, never raw HTTP request/response bodies, and are excluded from prompt construction and from every compaction token-budget, trigger, partition, hashing, provenance, and summarizer-input path. Reviewer currentness is not a separate provider-visible transcript row: the processor captures an in-memory snapshot of the reviewed subtree and included descendant `status.md` record versions, uses that snapshot to construct the persisted reviewer descendant context row, and compares it with current state before committing reviewer approval. Tool-delivery and tool-call-status side ledgers do not exist; recovery derives pending tool calls from conversation rows, and terminal-projected or abandoned settlements are recorded as `tool_result` rows. A `tool_call` is settled only by a `tool_result` that matches the full `(session_id, source_input_id, tool_call_id)` triple, never by `(session_id, tool_call_id)` alone, because provider call ids may repeat within a session. Synthetic settlements use `${source_input_id}:tool:0:tool-result:${tool_call_id}` so the same source-input extraction path handles real and synthetic results. System-prompt persistence is the only special case: it is deduped once per session while still being supplied to the provider through the dedicated system-prompt field. Recovered card processors seed their invocation input counters from durable conversation rows so deterministic turn ids remain restart-safe. One runtime activation of a card agent is one conversation round; compaction classifies and summarizes the card-lifetime thread across those activation rounds.

Provider invocation has two explicit projections. The generic projection contains only model-visible Saivage transcript rows and is the only context Chat Completions, Codex, summarizers, UI projections, and token estimators may consume. The active Responses replay projection is built from the active conversation version, validates paired `provider_private` rows and `openai_responses` visible projection markers, and is consumed only by the OpenAI Responses gateway. `ProviderTurnCompletion` can carry a provider-private Responses context returned by a successful completed Responses call; the LLM actor commits the private row and marked visible assistant/tool-call row in one authorized conversation batch. Only after that batch is durable does it independently append the successful provider-exchange projection with the durable visible output id. The private row stores exact OpenAI `response.output` arrays and is never stored in provider exchanges.

The Responses gateway is selected by effective `transportProtocol: openai-responses`. It uses public OpenAI API-key credentials only and rejects auth profiles before HTTP. Requests are stateless (`store: false`) and include encrypted reasoning replay (`include: ["reasoning.encrypted_content"]`); continuation uses locally persisted private output plus visible tool-result settlements and never `previous_response_id` or provider-side stored chains. Model failover may move to the next configured candidate; a failed Responses call does not fall back to Chat for the same candidate. Chat/Codex candidates ignore private rows and use the generic projection.

One server-composed `ConversationStore` owns initialization, batch append, summary-cache append, and compaction publication on the shared synchronous mutation lane. Every mutation carries exact composition, root-plus-leaf, or Analyst-turn authority. A batch atomically replaces only the selected active version, is idempotent as one whole batch, and rejects partial replay or conflicting message identity. Compaction rechecks both active version and source-content digest inside the lane. The store publishes scoped conversation and `agents` freshness only after durable changed batches or durable compaction publication. A separate `conversation_changed` metadata event may describe the mutation for timeline/debug observability, but it is not a live-sync invalidation authority. UI chat and timeline surfaces consume conversation entries by refetching the active conversation version/current projection; inactive pre-compaction version files are storage history and are not merged into current operator transcripts, summaries, or last-activity calculations. Active-version JSONL append order, exposed unchanged as the operator API `entries` array order, is the semantic transcript order for operator conversation surfaces. `message_index` and `block_index` order rows within a round/provider exchange, while timestamps are display metadata and late deterministic tie-breakers rather than cross-round transcript order. Latest provider-exchange lookups read app-log entries instead of conversation versions. Activity events such as `analyst_tool_invoked`, websocket activity/status frames, chat send responses, and Analyst websocket responses are not transcript or conversation-invalidation authorities. The `conversation_changed` append payload uses `message_timestamp` when it needs a row timestamp, leaving the flattened event-log envelope `timestamp` intact; its strict payload validation rejects reserved flattened keys such as `timestamp` and unknown keys.

Provider-visible rows introduced through an LLM invocation's `turnMessages` are single-append rows. After the LLM actor durably appends them at provider-turn start, continuation inputs consume that list and must not re-append the same logical-turn context rows after tool results, repair directives, or continuation hooks.

Continuation hooks insert caller-provided context only while preparing the next provider input. Planner/executor notification delivery uses those hooks for initial turns, non-terminal tool continuations, failed terminal `emit_result` repair continuations, and plain-text repair continuations. Terminal `emit_result` validation itself does not sample pending notifications and does not merge notification text into terminal repair errors. Failed terminal repairs are represented as the assistant `emit_result` tool call followed by a failed `tool_result` for that same call; any queued notifications for the repair turn appear as separate provider-input context rows.

`tool_error` rows are recovery-visible but not provider-visible. A current `tool_error` row requires `tool`, `tool_call_id`, and an id of `${source_input_id}:tool-error:${tool_call_id}`; malformed rows fail schema validation instead of being ignored by recovery. Global startup settlement reads only planner, reviewer, and executor sessions, never Analyst conversations. Startup matches autonomous `tool_call`, `tool_result`, and `tool_error` rows by the full `(session_id, source_input_id, tool_call_id)` triple. Before provider reissue, a valid `tool_error`-only settlement is converted into a provider-visible failed `tool_result` for that exact triple.

Reviewer assessment happens after runtime readiness and evidence gates pass for completed project or goal planning cards. Goal reviewers receive the project card data, the assessed goal subtree, and the planner return value; the project reviewer assesses the completed project/root tree outcome against the project card brief and acceptance criteria. Reviewer approval is valid only for the assessed card tree snapshot. If the assessed planning card or any descendant changes before approval commits, the runtime invalidates the reviewer pass and returns that card to planner ownership with correction/change context. Reviewer sessions must never drain the card's main-agent notification queue; notifications queued during review remain pending for planner/main-agent delivery at the next safe provider-input point, and pending notification state alone does not invalidate reviewer success (see [Implementation Plan P5](./micro-actor-runtime-implementation-plan.md#p5-reviewer-cannot-reach-main-agent-notification-delivery)). Negative reviewer results are stored with the card and injected back into the planner context through the completion-return response; positive reviewer text is only attached to the card.

Analyst mutations go through canonical runtime, card, config, process, and notification services.

### Conversation Compaction

Conversation compaction bounds planner, executor, and reviewer card-lifetime threads before provider calls. The subsystem lives under the conversation-index and compaction modules: versioned storage (`conversation-index.ts`, `conversation-store.ts`), round classification, band selection, recoverable-result body dropping, summary cache, summarizer, and compactor orchestration.

Compaction treats `activity` rows as zero-budget non-model-visible rows while still using `activation_open` activity as activation/round boundaries. Provider exchange records are no longer conversation rows; they live in the app log, cannot trigger compaction, cannot move round or band boundaries, cannot alter summary cache keys, and cannot leak provider-exchange JSON into generated `context_compaction` prose.

Each session directory uses a versioned layout: `index.json`, numbered active/frozen `<N>.jsonl` version files, and `summaries.jsonl`. Legacy `seg-NNN.jsonl` conversation segments are not a supported current format. All readers are strict and non-mutating. Composition startup restabilization removes owned replacement temporaries and unindexed numeric versions, validates every indexed version and summary row, and fails if an index references missing or malformed authoritative content. Before the first provider turn, the shared `ConversationLLMActor` boundary applies the exact prompt identity lookup to direct conversation actors and recoverable `LLMActor`s alike. It scans indexed active and frozen versions, so compaction may omit `system_prompt` rows from the active projection without losing that session fact. A same-id wrong-kind row is a fail-fast durable-contract violation. Code that builds provider input from disk and operator/UI transcript projections reads only the active version. Frozen versions remain audit and prompt-identity recovery evidence. Batch idempotency scans all indexed versions, returns existing canonical rows for a complete replay, and rejects partial replay or same-id content conflict. Compaction runs at one hook site only: `LLMActor.onBeforeProviderCall`, invoked from the base `_on_enter__calling_provider` path after the actor is entering a provider call and before the request is sent. If compaction runs, it refreshes the in-memory generic provider projection from the new active version's provider-visible rows and rebuilds the active Responses replay projection before the provider call.

Provider-turn interruption authority lives above the provider adapters. Each `ConversationLLMActor` issues one opaque immutable invocation lease per provider-bearing turn and registers its Saivage wrapper before preprocessing or raw work starts. The wrapper races cancellation against preprocessing, compaction/summarization, gate admission, and provider completion, observes a late raw rejection, and suppresses delivery after revocation. Activation/session operation trackers retain processor or Analyst-loop wrappers and consumer acknowledgements. Join waits for those wrappers and consumers, then takes the actor-core lifecycle-settlement snapshot; an abort-ignoring raw dependency is reported as external abandonment rather than physical quiescence.

`BaseActor.awaitLifecycleSettlement()` is the sole authorized frozen-core observation hook. It is protected and policy-free: a call snapshots the highest event sequence already queued and resolves only after dispatch has decided that event and, for a state change, completed leave handling, old-state task abort/removal, state assignment, `_on_state_changed`, and enter handling. Unknown and self transitions acknowledge their dispatch decision. Later events are outside the snapshot, and dispatch/handler failure rejects the acknowledgement with that failure. Cancellation meaning, leases, timeout policy, and join outcomes remain in Card/LLM/Analyst layers.

Activation-marker `activity` rows delimit top-level rounds; persisted failed `tool_result` and `model_repair` rows delimit sub-rounds. Compaction estimates payload size, applies configurable trigger/reserve/merge/summary fractions and boundary snapping, summarizes far and middle history, and preserves a verbatim recent tail. `context_compaction` rows are provider-visible `role: 'user'` summaries with a runtime framing marker.

Recoverable-result body dropping is the only content removal and happens only inside compaction. Source-recallable results, stash-backed webfetch results, and process-output-backed stdout/stderr results keep enough pointer data for the model to issue `read` later. Every summary row includes a deterministic `Recoverable evidence` section generated by the compactor, not by the summarizer. Cleanup preserves stash and process-log files referenced either by verbatim compacted `tool_result` rows or by those summary sections.

The summary cache stores immutable per-round `summary_text` plus recoverable-evidence descriptors. On re-compaction, existing `context_compaction` rows are treated as already-compacted history; they are not re-summarized. The merged summary is rebuilt from cached per-round entries, prior summary rows are replaced rather than duplicated, and the active version maintains exactly-once coverage: each still-relevant round appears once as merged cached summary content, as a per-round compacted summary, or as verbatim tail rows. Version entries record consumed `summary_ids` for audit.

Configuration knobs live under `compaction`: enablement, trigger/completion-reserve fractions, merge/summary lines, escalation lines, snapping policy, and summarizer model routing. The default leaves automatic compaction disabled unless configured. During an actual summarizer window the LLM actor snapshot reports `compacting: true`; no no-op turn reports that status.

Model routing and live availability are separated at the provider boundary. `ModelRouter` resolves the full configured and capability-compatible route order for a role: base model candidates first, then configured equivalent models and failover models, with duplicate concrete candidates emitted only once. It does not filter on live candidate availability. `AgentLlmInvocationGateway` resolves transport configuration fresh for every provider attempt and does not cache credential-bearing provider gateways. Local setup resolution emits typed permanent `local_setup_error` failures before provider I/O: missing providers/accounts, explicit account/provider auth-profile misses, ambiguous implicit profile matches, sanitized auth-profile store read/JSON/schema/IO failures, and OpenAI Codex missing or structurally unusable credentials needed to derive `chatgpt-account-id`. An absent auth-profile store is not a store-load error: explicit profile selections fail as `missing_auth_profile`, implicit optional no-profile resolution may proceed, and implicit required Codex credentials fail as `missing_required_credential`. `InvocationService` owns live availability decisions and the recovery state machine for every LLM invocation, including compaction summarizer invocations: non-rate-limit transient failures retry the same candidate first and block alternates while waiting; rate-limit/`Retry-After` cools that candidate while allowing later currently eligible untried candidates; exhaustion or the fixed two-hour deadline ends recovery. Its composition-owned `CandidateAvailabilityStore` strictly replays one JSONL file after startup discards only an incomplete final tail. Every success/failure append and threshold compaction runs synchronously under the invocation's exact current authority through the shared mutation lane; append success is fsynced and compaction uses one-file atomic replacement. The store has no subordinate PID lock, constructor I/O, malformed-row skip, writer lifecycle, or fallback instance. Empty routes, capability incompatibility, local setup errors, and permanent auth/configuration/input/protocol failures fail fast.

`InvocationService` accumulates and indexes provider-exchange envelopes in memory without persisting successful completion metadata ahead of conversation state. The LLM actor first commits its assistant/error/tool-call conversation batch, then asks the invocation service to append provider exchanges independently through the shared `AppLogStore`. Durable identity is `(session_id, source_input_id, attempt_index)` and the app-log id is deterministic. Successful entries carry the already-durable visible assistant/tool-call output id; failed attempts accumulated before a later success are projected in the same later phase.

One composition-owned `AppLogStore` is the only writer for event, error, control-action, provider-exchange, and content-review entries. Appends are synchronous lane operations with exact caller authority, fsync the appended row, and are idempotent by immutable entry id. Startup truncates only an incomplete final JSONL row and rejects malformed complete rows. The former app-log lock, generic JSONL ledger writer, event-bus persistence projections, and root-taking append helpers do not exist.

Runtime lifecycle state, actor cursor snapshots, and outstanding recovery diagnostics are likewise composition-owned lane stores. `RuntimeStateStore` preserves the version-1 runtime envelope and existing Pause/Resume meanings; it is the sole initializer and mutator. `ActorSnapshotStore` preserves the version-1 per-actor envelope and accepts exact composition or active actor authority for save, notification append, and removal. `RecoveryDiagnosticsStore` owns the unwrapped schema-version-1 diagnostics projection. Their readers are strict and side-effect free, startup restabilization removes only owned durable-replacement temporaries before validation, and the former subsystem locks, per-operation atomic-file constructors, raw initialization functions, and authority-free writers do not exist.

All `InvocationService` waits receive the active invocation `AbortSignal`. `LLMActor` creates and stores that signal before pre-provider compaction starts, passes it through compaction summarizer calls and the main provider call, and recognizes either the exact signal reason or a standard `AbortError` from the already-aborted signal as cancellation. This keeps runtime stop, activation/card cancellation, and caller aborts from being recorded as provider failures or fatal pre-provider compaction failures. Provider-turn adapters that invoke `InvocationService` require a signal and forward it as `abortSignal`; there is no supported no-signal provider invocation path.

That same signal object is passed to `RuntimeGate.waitUntilOpen`; gate admission never receives the task-only signal. Ordinary gate closure is reversible Pause. Terminal gate closure rejects current and future waiters, removes their abort listeners, and makes later open attempts fail. After provider I/O returns, the invocation lease is checked and the exact captured mutation authority is submitted directly to the synchronous conversation store. OpenAI Responses private-plus-visible completion rows are one atomic conversation batch. No completion-persistence admission wrapper, release tracker, or parallel commit authority remains.

The durable-ownership cutover has an internal foundation that does not change this lifecycle contract. Four immutable process-local identities—root generation, leaf activation, Analyst turn, and installed MCP revision—form the complete currentness vocabulary; an MCP invocation authority is the product of its discriminated caller authority and installed revision, not a fifth identity. A composition-owned `MutationLane` executes synchronous callbacks immediately, rejects recursive or Promise-returning callbacks, and checks exact authority currentness immediately before application. Its dedicated MCP delivery operation additionally compares the current caller-kind admission and returns typed stale delivery without invoking the callback. Card/auth/config/candidate-availability/conversation/app-log persistence uses this lane: boot/recovery/direct commands use private composition authority, autonomous capabilities resolve the exact current root-plus-leaf identity at every call, and Analyst capabilities resolve the exact active turn identity. The existing `RuntimeGate`/`InvocationLease`, scheduling-only Pause, and Resume behavior remain current; no public `pausing` state, unified Run control, or quiescent-Pause claim is introduced.

Provider-boundary admission is scoped to each `calling_provider` entry, including model repairs and post-tool continuations: the LLM actor resets its admission marker before input setup or compaction and sets it immediately before that entry's provider call. A non-abort fatal error after an armed turn—whether a raw post-admission rejection, a malformed `provider_attempt` without an exchange envelope, or pre-provider setup failure—clears active reconstruction, clears invocation signals, queues `failed` while still in `calling_provider`, then rejects the detached turn promise. The queued transition writes the idle/no-reconstruction snapshot before card-processor promise reactions run. Strict raw and malformed failures never synthesize a provider exchange or model issue; valid typed provider failures and cancellation retain their separate normal paths.

## 6. Runtime Control Flow

Run:

1. Analyst receives a user request to run, start, continue, or resume.
2. If the runtime is paused, the runtime opens the global provider-admission gate so provider waiters proceed before new autonomous work is admitted.
3. `SupervisorRuntimeApi` records current running state in `RuntimeState.active_card_run` and opens the runtime gate.
4. If the project is already running, `SupervisorRuntimeApi` returns a current-state result with an error and creates no duplicate work.
5. When needed, `SupervisorRuntimeApi` activates the parentless project card through the runtime/composition root.

Child execution:

1. Planner calls `activate_card(child_id)`.
2. Runtime validates parent ownership and child readiness.
3. Runtime records the activation edge as the parent conversation `activate_card` tool call and current actor state.
4. Runtime transfers the sole leaf authority from parent to child and dispatches the child to planner/executor/reviewer flow.
5. The child processor returns an outcome without mutating terminal card-tree state. Runtime transfers leaf authority back to the parent, and that exact parent planner applies the returned outcome to its direct child before receiving the tool result. Root outcome application remains the runtime coordinator's narrow root responsibility.

Pause:

1. Pause closes the global provider-admission gate.
2. Existing provider calls and already-running OS processes reach the next durable safe point.
3. No new LLM/provider call is admitted while paused.
4. Already-received provider responses may continue to execute tool calls, spawn runtime-owned processes, and dispatch cards while paused until in-flight responses drain and the next provider call parks.
5. Completion facts from already-admitted work may persist and settle to durable boundaries while paused.
6. Running processes are not killed by pause.

Resume reopens the same gate. Existing waiters blocked at provider calls proceed exactly once in normal actor order without requiring a second Run, while preserving the one-active-leaf invariant. Already-admitted completions may have settled to durable boundaries while paused; the gate prevents follow-up provider calls from starting until resume.

Shutdown:

1. Shutdown first sets the pause gate.
2. The runtime enumerates owned running processes.
3. The runtime terminates those processes through canonical process control.
4. The runtime reports which processes terminated and which could not be terminated.

## 7. Card-Addressed Notifications

Notifications are queued on cards. The card runtime is responsible for delivering queued content to that card's main agent session.

Notification content is not a durable user-managed object. Persistence exists only to deliver it once. After delivery the platform forgets it as a queue item; delivery evidence is the receiving session transcript.

Delivery happens only while constructing provider input for planner/executor main-agent sessions. Reviewer turns intentionally skip notification delivery because notifications target the card's main agent session, not the reviewer assessment session. Safe delivery points are the initial provider input, a continuation after a non-terminal tool result, a continuation after a failed terminal `emit_result` repair tool result, and a continuation after a plain-text repair directive. A terminal `emit_result` handler validates the terminal payload, required records, completion gate, and reviewer rework only; it does not check pending notification state and does not gate terminal acceptance on notifications. In reviewer rework, the failed planner `emit_result` tool result contains reviewer guidance only, while queued notifications for the planner rework continuation are delivered as separate context rows in the next provider input.

## 8. Changed-State Propagation

Analyst record-backed brief mutations are committed through the same card-edit service for `write(record:///brief.md?card=<id>&v=next)`, `edit(record:///brief.md?card=<id>&v=next)`, and `webfetch.save_as` to the same record URL. The service is available only while runtime status is `stopped` or `paused`, requires the target card to be `backlog`, `done`, `failed`, or `running`, validates the final brief markdown, creates and closes a new `brief.md` version, and then applies propagation. Backlog targets remain `backlog`; `done` and `failed` targets become `changed`; `running` targets remain `running`; `changed`, `blocked`, and `cancelled` targets are denied before a record slot is opened.

When an Analyst brief modification affects an inactive descendant, the direct ancestor path is walked to the project root or first running ancestor. Backlog target edits start at the parent, keep the edited card out of the walked path, and do not notify the edited card. `done` and `failed` target edits start at the edited card. Only `done` and `failed` cards on the walked path become `changed`; other non-running ancestor states are left unchanged, and a running ancestor remains `running` and stops propagation. The service calls the fire-and-forget card notification capability for eligible `goal`/`project` ancestors through the first running ancestor, plus the edited card for `done`/`failed` targets, deduplicating recipients and ignoring callback return values. Ancestors are not automatically dispatched by the status change.

The acceptance gate prevents a planner from closing a goal while any executable descendant is not in a completion-compatible state. This forces the planner to observe and handle changed, blocked, backlog, running, failed, or otherwise incomplete executable descendants before claiming completion. Done and `cancelled` descendants are completion-compatible and do not block `done`.

`result` is attached from accepted main-agent results only. It is not updated from progress chatter, rejected reports, or reviewer correction requests. `working_status` is separate free text for agents attached to the card.

## 9. Cancellation

Cancellation is immediate only for inactive cards. Recursive cancellation preserves descendants that are already `done` and converts inactive non-completion-compatible descendants, including `failed`, `blocked`, `backlog`, and `changed`, to `cancelled`.

Cancelling a running card is authoritative: `CardActor.cancel()` cancels the current activation, writes `cancelled` to the card store immediately, resolves the pending activation as cancelled, stops activation-owned runtime process scope, and drops late provider/tool/process outcomes through the CardActor cancellation flag (see [Implementation Plan P3](./micro-actor-runtime-implementation-plan.md#p3-cardactor-owns-authoritative-cancellation-and-activation-id-settlement)). Running children are cancelled through their own `CardActor.cancel()` so they are cancelled too. Shutdown remains the hard operation for forcibly stopping all runtime-owned process scopes.

Project-card cancellation is the root case of the same operation. Inactive project work is cancelled immediately; running project work is cancelled via the same activation path, which marks the card store `cancelled` immediately and rejects late outcomes.

## 10. Persistence

State remains project-local under `.saivage/`. Card and authored-record authority consists of strict self-contained version artifacts under `.saivage/cards/<cardId>/{card,brief,status,review}/versions/`; adjacent indexes and deleted-id reservation state are deterministic card-subsystem projections. One composition-owned `CardStoreRepository` shares one in-memory generation and one synchronous `MutationLane`; authority-bound `CardStore` capabilities are the only mutating surface. There is no card-mutation project lock, per-card lock, slot lock, writer queue, close lifecycle, per-write lifecycle-lock proof, authority-free mutator, or path-based reopening constructor. Each canonical artifact and derived index replacement is independently durable, so semantic operations may expose an accepted prefix rather than cross-file atomicity.

`ResolvedConfigAuthority` is constructed for the one startup-selected path with the process lane and frozen interpolation environment. Composition authority exclusively restabilizes replacement temporaries and creates a selected missing default. Each Analyst mutation presents its exact current turn, and the complete raw-YAML read, typed mutation, validation, and one-file replacement occurs synchronously in one lane callback. Reads are strict and mutation-free. Before the final lifecycle cutover, Analyst MCP desired-config mutation and explicit reconciliation reject before either config or MCP work because scheduling-only Pause is not intervention readiness.

Normal opening first performs mutation-free complete canonical project-root observation. Only after that proof may one composition-authorized lane callback perform target-local temporary cleanup, incomplete non-root creation cleanup, index rebuilding, and full tree/brief validation. Plain start always chooses normal mode. Init, reset, and `start --create-runtime` choose card-store bootstrap only after strict read-only fresh/reset-empty verification; reset retains the lifecycle-lock handle while deleting generated roots and then explicitly bootstraps. Bootstrap creates the root through the same private lane-entered session and exposes it only after normal observation/restabilization. Fresh-root project identity is separate: only Init creates it through the lane-backed `ProjectIdentityStore` while holding bootstrap-unbound ownership. Server start and reset require bound project identity.

Runtime process ownership is centralized in `startApp()`. It acquires one strict bound `.saivage/locks/runtime.lock` with `O_EXCL`, creates the process lane and private composition authority, creates card persistence in an explicit mode, and passes the already-created repository into server composition. After listen, the same exact owner atomically adds the actual endpoint metadata; current lifecycle controls do not consume it until their later atomic cutover. Server read models receive only the repository's readers. Startup recovery receives a composition-bound card capability; each card actor receives a capability bound to its dynamic exact leaf; each Analyst turn receives a capability bound to its immutable active turn. Init and reset enter `withDirectMutationComposition` and use the same constructors and lane-backed contracts. Every pre-existing lock blocks; diagnosis never removes it, and binding, endpoint publication, and release verify the exact instance, PID-start, and canonical-root owner identity immediately before changing the lock file.

Model-facing scoped filesystem references use canonical triple-slash URLs: `project:///`, `record:///`, `tmp:///`, read-only `work:///`, and `system:///`. The workspace layer parses and emits these URLs through one string-based helper that validates raw path segments symmetrically and rejects old two-slash forms. Scoped URL resolution is centralized through a narrow workspace VFS with exactly three operations: `resolve`, `list`, and `glob`. `read`, `write`, and `edit` use VFS `resolve` and then operate on the resolved OS path; `resolve` returns `null` for non-scoped relative paths so callers keep their relative-path branch, and returns a resolved node for scoped input. Scoped URL-shape, segment, record URL, and unsupported-record-slot failures are classified as `WorkspaceToolInputError` at the tool-facing boundary rather than escaping as plain parser throws.

For directory schemes, `project:///`, `work:///`, and `system:///` resolve to the project root, `.saivage/work`, and `/` respectively. `tmp:///` and `record:///` still require their mandatory leading segments. The VFS distinguishes two record namespaces: document URLs such as `record:///<filename>?card=<id>&v=<n>` (or bare `record:///<filename>` using the agent's current card and latest version) are used by `read`, `write`, and `edit`; card-id URLs such as `record:///<cardId>` are used by `list`/`glob` and by `read` when the segment is not a record slot filename. Card-id record namespaces split by operation: `list record:///<cardId>` (and `read` of a card-id record URL) return the metadata projection of all exposed slots with nullable `latest`, including unclosed slots, for inspection; `glob record:///<cardId>` and `grep record:///<cardId>` enumerate only records that have a latest closed version with readable content, returning record URLs. All three hide raw version files and the internal `card.json` slot. Record URLs are derived from card id, slot filename, and version when projected; they are not persisted in record slot index entries. Scoped `glob` and `grep` share one awaited, sequential file visitor so per-scheme walk and display-path policy live in one place. Project and scoped grep traversal incrementally visits one candidate at a time, never builds a whole-tree candidate list, and stops requesting entries when the global result budget is exhausted. Each selected file is scanned from one read stream with same-stream binary head classification, streaming UTF-8 decoding, bounded logical-line state, and immediate stream closure on a result-limit stop or error. This preserves deterministic traversal and supports oversized text files while limiting retained line content to 2000 characters and previews to 500 characters; result metadata discloses when an overlong suffix was not searched. `grep` applies this contract across all scoped schemes, including record card-id latest closed versions, and redacts each bounded `work:///` preview before return.

Process read models expose provenance, not authority: `card_id` is a real card id for card-owned processes and `null` for Analyst/operator/runtime processes, while `owner_kind` and `owner_id` identify the visible origin. Termination authority is the exact opaque direct capability plus category captured at launch. Process log URLs follow provenance: card-owned logs use `work:///cards/<cardId>/processes/<procId>/...`; non-card logs use `work:///processes/<procId>/...`.

Startup recovery is root-cascade based with a pre-reconstruction nested consistency pass. The process runner registry is in-memory only and starts empty after every runtime restart; previous process ids are unknown, no PID/process-group records are reconciled, and OS-process reattachment remains excluded. Startup validates the project root card record and throws if it is missing or schema-invalid. Recovery then runs `runActorStartupRecovery`: it classifies active-version planner, reviewer, and executor conversations only, projects complete durable terminal outcomes where safe, removes active inner snapshots that conflict with the card's durable status, settles recovery-only `tool_error` rows before provider reissue, appends actionable failed `tool_result` rows for dangling unrelinked tools, and writes sanitized diagnostics. Analyst conversations are neither read nor changed by these autonomous recovery and settlement passes. Dangling `activate_card` rows are inspected before generic settlement; without a reconstructed parent continuation they become explicit failed activation results instead of preserved dead edges. Startup then constructs running card actors with deferred processor start and calls `recoverCurrentCardState()` on the root card only. Recovery cascades through replayed `activate_card` calls that remain live; processors start lazily when reached, compatible recovered LLM snapshots are adopted inside `processor.recoverActive`, in-flight provider calls are reissued, and waiting tool calls are resolved inline through `resolveInitialOutcome` and tool replay. Safe terminal decisions may be projected from complete durable terminal records. A `blocked` card status may still arise from safe terminal projection when the persisted planner terminal is itself `blocked`.

Expected persisted concerns include:

- card tree and history;
- record-backed card state, including internal structured card versions plus authored document records such as `brief.md`, `status.md`, and `review.md`;
- agent messages and manifests;
- minimal runtime status/cursor state and recovery metadata; command, run, and activation ledgers are not persisted runtime state;
- safe process logs and in-memory process projections during the current runtime;
- event and error timelines;
- redacted audit/control-action records;
- pending card-addressed notifications until delivery, or until their card leaves the active runtime through deletion/archival.

## 11. API And UI Projection

HTTP routes and WebSocket frames are projection and transport surfaces. They do not define runtime semantics.

The UI fetches authoritative read models through REST and receives freshness hints through WebSocket invalidation or event frames. WebSocket does not replace REST as source of truth. Each UI-store instance owns monotonically increasing read generations for its selected card/version/session/transcript/exchange; stale resolve, reject, and finally callbacks do not mutate the current selection.

Runtime freshness is process-local and lifecycle-bounded. One server-composed mutation owner publishes `runtime` only after successful post-readiness writes for project start, REST or Analyst pause/resume, active-run transitions, and asynchronous completion or failure settlement. Raw runtime-state persistence has no delivery collaborator. A lock-held CLI pause/resume POSTs the canonical server REST route and never writes directly or falls back; an unlocked CLI writes persisted state directly and makes no REST request. Startup recovery/reconciliation occurs before live-sync subscription, and shutdown persistence occurs after delivery closes; startup, shutdown, and unlocked CLI state are observed by authoritative initial-load or reconnect reads rather than guaranteed hints.

The server composes one `ReadModelChangeBroadcaster`, subscribes one `SyncHub`, and gives that broadcaster to semantic mutation owners. Hints are synchronous, process-local, lossy invalidations; REST remains authoritative and `SyncHub` may coalesce duplicates. Metadata events continue to feed timeline/debug observability but never infer `runtime`, `cards`, `agents`, or conversation freshness.

Semantic owners publish only after successful durable changes. Card creation targets `cards` and `runtime`; deletion targets `cards`, `runtime`, and `agents`; status changes target all three; mutable type changes target `cards` and `runtime`; content, ordering, and dependency changes target only `cards`. True no-ops and empty subtree deletion publish nothing. Card and processor snapshot save/remove and notification append target `runtime`; an LLM snapshot save/remove additionally targets `agents` and that actor's conversation. A failed removal or failed persistence publishes nothing.

Conversation append and active-version replacement target the scoped conversation and `agents`; idempotent append and failed persistence publish nothing. Each settled provider-exchange append targets `agents`. Progressive Runtime, Cards, and Agents stores retain accepted data during refetch, reject stale request completions, and reconcile keyed rows in place. Debug scopes transcript requests to selected identity and keeps accepted rows on refresh errors. Analyst rendering combines the last accepted authoritative transcript with send-owned pending rows until authoritative identity or same-session/user/content proves reconciliation.

`LoggedEvent` is the current flattened operator event-log public shape. Domain event payload fields are projected into the logged record for the operator event API; moving to nested domain-event payload records is deferred. Runtime event pagination validates present `limit` and `offset` as non-negative integer strings at the operator API boundary.

MCP server configuration and status use the `stdio` and `streamable-http` transport values. The Streamable HTTP client may parse `text/event-stream` response framing internally, but `streamable-http` is the configuration/API transport name.

Each active MCP server revision owns a distinct `service_infrastructure` direct process scope and a local lifecycle generation, synchronous admission fence, operation AbortControllers, and joinable operation set. Startup, discovery, stdio requests, Streamable HTTP requests/SSE reads, invocation publication, and health work are admitted through that containment boundary. Stop/remove/replace closes local and process-scope admission first, advances the generation, aborts and joins admitted work, suppresses obsolete-generation publication, and then requires stdio process-scope absence; HTTP-only containment ends after fence/abort/join. Runtime maps, tool caches, revisions, and scopes remain retained until containment succeeds.

The Analyst can drive workspace navigation by asking the webapp to show a specific card, file, process, debug view, runtime view, or agent session. The UI also sends enough active view/entity/filter context for the Analyst to reason about what the user is seeing.

Internal actor state and compiled transition tables must not leak directly through operator APIs. Public responses expose Saivage read models.

## 12. Security Architecture

All protected API and WebSocket routes require authenticated access when a token is configured.

API bearer tokens are accepted in `Authorization: Bearer` headers, not URL query strings. Browser WebSocket connections use short-lived one-use tickets rather than bearer tokens in URLs.

An `AuthPolicy` and its ticket store belong to one server composition. Token rotation advances the browser connection generation, and only callbacks for that generation may alter connection state; obsolete ticket/socket callbacks are ignored, while the current connection's authentication failure is terminal.

The Analyst may inspect secrets when the authenticated user request requires it. UI projections and logs may redact secrets by default, but that redaction is a display/output policy rather than a limit on Analyst authority.

File inspection and process output are filtered through containment, binary/size checks, and safe command rendering. The workspace `read` tool enforces hard inline caps: at most 2000 lines, at most 2000 characters per line, about 256KB total inline content, and a roughly 10MB file-size ceiling. It supports `metadata_only` reads for size, mtime, directory status, and directory entry counts. Oversized text reads return metadata and guidance for narrower inspection rather than inline content or a generic failure. Secret display should be deliberate and minimized, not categorically unavailable to the Analyst.

Provider diagnostics, account details, runtime internals, and raw error metadata must not be injected into planner, executor, reviewer, or analyst model context merely because they exist. Agent-visible context is deliberately constructed: include actionable recovery information when needed, sanitize diagnostic detail, and preserve raw data in logs or projections with appropriate access controls.

## 13. Implementation Direction

The runtime implementation direction is micro-actor-centered: actor states, submitted jobs, and pending internal events drive behavior, not imperative orchestration loops. The micro-actor module contract, delivery model, and persistence boundary are defined in [Declarative micro-actor module architecture](./declarative-micro-actor-module.md). The target runtime design is defined in [Micro-Actor Runtime Design](./micro-actor-runtime-design.md).

Target actor ownership:

- `CardActor`s own direct child `CardActor` instances and the associated processor actor for that card type;
- `BaseCardProcessorActor` owns shared processor mechanics: activation, settlement, outcome reporting to the owning `CardActor`, and processor snapshot mechanics. It has no cancellation API; running cancellation is owned by `CardActor` (see [Implementation Plan P3](./micro-actor-runtime-implementation-plan.md#p3-cardactor-owns-authoritative-cancellation-and-activation-id-settlement));
- `BaseMainLLMCardProcessorActor` owns shared main-agent LLM loop mechanics, lazy initial-input resolution for idle versus recovery branches, and delivery-only notification hooks for safe pre-provider-call points without role-specific policy;
- `PlanningCardProcessorActor` owns project/goal planner and reviewer semantics;
- `TerminalCardProcessorActor` owns executor semantics for terminal cards; it constructs card-scoped capabilities and does not own child cards.

Process execution is split cleanly between one composition-created `ManagedProcessGroupRegistry` and its `ProcessRunner` facade. The registry allocates identity-based opaque container/direct capabilities with immutable parent topology; duplicate diagnostic labels do not alias. Direct scopes are category-bound to `runtime_card`, `operator_session`, or `service_infrastructure`, and the registry validates instance identity, openness, directness, and category before detached spawn. Card activations, Analyst sessions, and MCP stdio runtimes receive separate direct scopes under category-specific roots. The synchronous launch-admission fence rejects before spawn when closed.

The registry retains each live leader PID/PGID, exact scope/category binding, output finalizer, and `active`, `terminating`, or `unverifiable` state. Scope-tree termination snapshots matching descendants and applies one aggregate TERM → grace → KILL → final-probe schedule. Only a zero-signal negative-PGID probe returning `ESRCH` releases the live binding and settles presentation state. Any ambiguous probe permanently moves the record to `unverifiable`, retains its topology/diagnostic, and forbids every later operation on that numeric PGID. `ProcessRunner.kill` additionally requires the invoking exact direct scope/category and ordinary visibility; owner metadata never authorizes it. The ordinary in-process `ResourceScope` owns timers, listeners, watchers, streams, and disposables only—it has no spawn, child-process registration, process polling, or process signal path.

`wait_process` is group-based: zero timeout inspects current state, a positive timeout returns the running view without killing, and terminal output waits for `ESRCH` settlement. The registry, capabilities, PIDs, and PGIDs are never persisted, reconstructed, scanned, or adopted; a successor has an empty registry and never signals predecessor groups. `run_command`, `wait_process`, and `kill_process` share one metadata-only result shape with process identity, exit/status, byte counts, and canonical stdout/stderr log URLs. Card-owned logs use `work:///cards/<cardId>/processes/<id>/stdout.log` / `stderr.log`; non-card logs use `work:///processes/<id>/stdout.log` / `stderr.log`. Process output directories contain no duplicate `combined.log`, and the functional specification imposes no process concurrency limit.

Planner, executor, and reviewer initial provider inputs are built only for fresh idle turns. The builder loads the persisted conversation prefix, writes a structural `activation_open` activity row that is excluded from provider context, persists this turn's runtime-provided user-context rows, and sends the provider the persisted prefix plus those new rows. Later continuation inputs are built through `LLMActor` continuation methods after tool results, failed terminal repairs, or plain-text repair directives; caller-provided continuation context, including safe notification delivery for planner/executor flows, is appended at that pre-provider point. Recovery paths for in-flight provider calls or waiting tool calls do not build a new input and therefore do not append unsent activation markers or context rows.

Controllers that advance runtime behavior are disallowed by default. A retained `RuntimeApi` may accept commands, call actor public methods, wait on projections, and project read models; it must not execute workflow logic itself.

## 14. Source-Derived Reference

This appendix is maintained as source-derived reference data for documentation drift guards. Route entries come from Fastify registrations and `src/contracts/operator-api*.ts`; tool and config entries come from the corresponding source registries and schemas.

### Operator routes

<!-- saivage:operator-routes:start -->
| Route | Purpose | Source |
|---|---|---|
| `GET /api/agents` | Agent session list projection. | `src/contracts/operator-api-agents.ts:56` |
| `GET /api/agents/:id` | Agent session detail projection. | `src/contracts/operator-api-agents.ts:66` |
| `GET /api/agents/:id/conversation` | Agent conversation transcript projection. | `src/contracts/operator-api-agents.ts:77` |
| `GET /api/agents/:id/llm-exchange` | Agent LLM exchange projection. | `src/contracts/operator-api-agents.ts:88` |
| `GET /api/cards` | Card list projection. | `src/contracts/operator-api-runtime-cards.ts:197` |
| `GET /api/cards/:id` | Card detail projection. | `src/contracts/operator-api-runtime-cards.ts:207` |
| `GET /api/cards/:id/diff` | Card diff projection. | `src/contracts/operator-api-runtime-cards.ts:241` |
| `GET /api/cards/:id/history` | Card history projection. | `src/contracts/operator-api-runtime-cards.ts:219` |
| `GET /api/cards/:id/history/:seq` | Card history entry projection. | `src/contracts/operator-api-runtime-cards.ts:230` |
| `GET /api/chats` | Analyst chat session list projection. | `src/contracts/operator-api-chats.ts:57` |
| `GET /api/chats/:sessionId` | Analyst chat session projection. | `src/contracts/operator-api-chats.ts:67` |
| `GET /api/config` | Redacted project configuration projection. | `src/contracts/operator-api-config.ts:71` |
| `GET /api/control-actions` | Control-action audit projection. | `src/contracts/operator-api-config.ts:91` |
| `GET /api/events` | Runtime event timeline projection. | `src/contracts/operator-api-events.ts:35` |
| `GET /api/files` | Project file listing projection. | `src/contracts/operator-api-files-debug.ts:52` |
| `GET /api/files/content` | Project file content projection. | `src/contracts/operator-api-files-debug.ts:63` |
| `GET /api/mcp/status` | MCP server status projection. | `src/contracts/operator-api-mcp.ts:72` |
| `GET /api/mcp/tools` | MCP tool list projection. | `src/contracts/operator-api-mcp.ts:82` |
| `GET /api/processes` | Process list projection. | `src/contracts/operator-api-processes.ts:48` |
| `GET /api/processes/:id` | Process detail projection. | `src/contracts/operator-api-processes.ts:58` |
| `GET /api/providers` | Provider configuration projection. | `src/contracts/operator-api-config.ts:81` |
| `GET /api/runtime/card-runs` | Runtime card-run projection. | `src/contracts/operator-api-runtime-cards.ts:259` |
| `GET /api/runtime/status` | Runtime status projection. | `src/contracts/operator-api-runtime-cards.ts:253` |
| `GET /api/state` | Operator state projection. | `src/contracts/operator-api-runtime-cards.ts:187` |
| `GET /health` | Liveness probe. | `src/contracts/operator-api-runtime-cards.ts:165` |
| `GET /health/ready` | Readiness probe. | `src/contracts/operator-api-runtime-cards.ts:176` |
| `POST /api/auth/ws-ticket` | WebSocket ticket issuance. | `src/contracts/operator-api-auth.ts:22` |
| `POST /api/chats/:sessionId` | Analyst chat turn submission. | `src/contracts/operator-api-chats.ts:78` |
| `POST /api/runtime/pause` | Runtime pause control. | `src/contracts/operator-api-runtime-cards.ts:263` |
| `POST /api/runtime/resume` | Runtime resume control. | `src/contracts/operator-api-runtime-cards.ts:249` |
<!-- saivage:operator-routes:end -->

### Internal debug routes

<!-- saivage:internal-debug-routes:start -->
| Route | Purpose | Source |
|---|---|---|
| `POST /api/debug/runtime/start` | Internal runtime-start diagnostic action. | `src/server/routes/chats-files-debug.ts:15` |
| `GET /api/debug/doctor` | Internal doctor diagnostic projection. | `src/server/routes/chats-files-debug.ts:24` |
| `GET /api/debug/errors` | Internal runtime error-log projection. | `src/contracts/operator-api-files-debug.ts:84` |
| `GET /api/debug/state` | Internal runtime state diagnostic projection. | `src/contracts/operator-api-files-debug.ts:74` |
| `GET /api/debug/supervision` | Internal supervision diagnostic projection. | `src/server/routes/chats-files-debug.ts:82` |
| `GET /api/debug/timeline` | Internal runtime timeline projection. | `src/contracts/operator-api-files-debug.ts:94` |
<!-- saivage:internal-debug-routes:end -->

### Agent tools

<!-- saivage:agent-tools:start -->
| Role | Tools | Source |
|---|---|---|
| `planner` | `cancel_card,create_card,queue_notification,reorder_child` | `src/tools/analyst-card-tools.ts:249` |
| `executor` | `` | `src/tools/analyst-tool-registry.ts:55` |
| `reviewer` | `` | `src/tools/analyst-tool-registry.ts:55` |
| `analyst` | `cancel_card,create_card,delete_card,get_status,list_agent_sessions,list_processes_tool,mcp_reconcile,navigate_back,navigate_workspace,pause_runtime,queue_notification,read_agent_session,read_control_actions,read_runtime_errors,read_runtime_events,reconfigure,reorder_child,restart_server,resume_runtime,show_config,start_project` | `src/tools/analyst-tool-registry.ts:64` |
<!-- saivage:agent-tools:end -->

### Config schema

Server composition injects one `ResolvedConfigAuthority` created by `loadEnvironment()` into the runtime/Analyst tool context, operator config handlers, and `McpManager`. The authority immutably owns the startup-selected absolute path, selection source, and interpolation-environment snapshot. It is the sole initializer and selected-config writer. Config mutations synchronously enter the composition-owned mutation lane, read the latest raw YAML, apply one closed-union mutation, validate the effective document with canonical schema and model-role checks, and perform one durable same-file replacement. Reads and MCP reloads return to the authority rather than deriving a path, accepting a preloaded config, or consulting current `process.env`. There is no private promise queue, global or path-keyed config lock, cleanup-on-read, or second per-operation writer. Raw-document mutation keeps placeholders in durable YAML while effective consumers receive interpolated values.

Server composition also constructs one `AuthProfileRepository` on that lane and injects it through provider resolution. Reads are strict and non-mutating after startup restabilization. OAuth refresh network I/O remains outside the lane; a successful refresh replaces the profile only under the originating current root-plus-leaf or Analyst-turn authority and the exact revision read before the request. A concurrent profile change fails the replacement rather than being overwritten. No provider path constructs a fallback auth writer or derives a second persistence owner.

`McpManager` has no mutable config copy or public mutation-facing start/stop/restart API. Its serialized reconciliation port reloads the authority on every turn, hashes a stable complete server configuration into a secret-free revision identifier, preflights the one-destructive-target bound, and compares desired revisions with retained active runtimes. Removes delete only after containment. Replacements stop the old revision before constructing a new per-server scope; failed old containment retains the exact runtime, while failed successor startup retains truthful stopped desired state for the next reconciliation. Startup invokes this same port and does not become ready with pending convergence. Analyst MCP mutations are one authority write followed by reconciliation, and `mcp_reconcile` retries only reconciliation. The manager exposes synchronous terminal admission closure and joinable terminal disposal for the future application stop coordinator; it does not coordinate App stop, composition disposal, lock release, or process exit.

Project persistence bootstrap creates generated directories and canonical card/runtime artifacts but not configuration. With `--create-runtime`, configuration initialization is queued through the same authority after directory scaffolding; it creates only a missing selected file and preserves an existing one.

<!-- saivage:config-schema:start -->
| Section | Fields | Source |
|---|---|---|
| `top-level` | `compaction,mcpServers,models,notifications,providers,runtime,security,server,telegram` | `src/agents/config-schema.ts:183` |
| `models` | `default,equivalents,failover,max_tokens,profiles,routing,temperature` | `src/agents/config-schema.ts:36` |
| `providers.entry` | `accounts,apiKey,authProfile,baseUrl,capabilities,modelCapabilities,models,priority` | `src/agents/config-schema.ts:93` |
| `providers.account` | `apiKey,authProfile,baseUrl,capabilities,models,priority` | `src/agents/config-schema.ts:83` |
| `server` | `host,port` | `src/agents/config-schema.ts:105` |
| `runtime` | `candidate_availability_compact_bytes,continuous_improvement,max_review_retries,process_timeouts` | `src/agents/config-schema.ts:117` |
| `runtime.process_timeouts` | `executor_ms,planner_ms,reviewer_ms` | `src/agents/config-schema.ts:111` |
| `security` | `injectionModel,injectionScanner,maxScanLengthBytes` | `src/agents/config-schema.ts:134` |
| `supervisor` | `` | `src/agents/config-schema.ts:215` |
| `telegram` | `allowedUserIds,botToken,notificationChatIds` | `src/agents/config-schema.ts:141` |
| `notifications` | `channels` | `src/agents/config-schema.ts:150` |
| `compaction` | `completion_reserve_fraction,enabled,escalate_merge_line_fraction,escalate_summary_line_fraction,merge_line_fraction,snap,summarizer_model,summary_line_fraction,trigger_fraction` | `src/agents/config-schema.ts:154` |
| `mcpServers.entry` | `args,autostart,command,disabled,env,transport,url` | `src/agents/config-schema.ts:171` |
<!-- saivage:config-schema:end -->
