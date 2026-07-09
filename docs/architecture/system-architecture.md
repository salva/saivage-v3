# Saivage v3 System Architecture

Status: current design summary.

Last updated: 2026-07-07.

## 1. Architectural Shape

Saivage is a card-centered autonomous runtime with a conversational control surface.

The runtime engine is Node.js 24; `package.json` engines require `node >=24 <25` and `npm >=10 <12`, matching the GitHub Actions CI validation environment.

The major subsystems are:

- Operator web UI: read-only workspace plus always-visible Analyst panel.
- Analyst agent: user-facing inspection and mutation orchestrator.
- Runtime control surface: `SupervisorRuntimeApi` coordinates root intent, run/resume, pause state, active-work ownership, and recovery against durable `RuntimeState`. Shutdown process termination is performed at the runtime/composition root (`SupervisorRuntimeApi.shutdown()` → `ProcessRunner.stopRuntimeOwned`).
- Canonical card service: Analyst-owned card mutation validation, durable tree updates, audit/projection events, and active-runtime change notification.
- Card store: durable project hierarchy and card history.
- Agent sessions: planner, executor, reviewer, and analyst transcripts.
- Agent services: LLM invocation, tool dispatch, model-visible message construction, and transcript persistence.
- Process registry: durable process records, safe process read models, restart reconciliation.
- Notification queue: card-addressed ephemeral context delivery.
- HTTP/WebSocket server: authenticated projections, chat transport, and invalidate/event delivery.

## 2. Semantic Layers

Runtime is infrastructure. Operator UI and HTTP/WebSocket transport are infrastructure surfaces. Analyst is the user-facing control agent. Planner, executor, and reviewer are worker agent roles.

This distinction matters: the runtime should not be described as a peer of planner/executor/reviewer. It owns dispatch and persistence. Worker agents perform card work under runtime control. The Analyst controls the system on behalf of the user through canonical services.

Planner, executor, reviewer, and analyst system prompts are rendered by the `PromptTemplateRegistry` through `src/utils/prompt-api.ts`. Agent identity is the `(cardType, role)` pair: project and goal planners are distinct prompt slots, each terminal card type has its own executor prompt, and the analyst uses the synthetic `analyst/analyst.md` slot. Built-in defaults ship as Markdown files under `src/prompts/<cardType>/<role>.md` and are copied to `dist/prompts/` at build time. Project overrides live in `.saivage/config/prompts/<cardType>/<role>.md`; an override file replaces the matching default, while absent override files fall back to the shipped default. Startup validates placeholder syntax and role-specific placeholder names for every active effective template before any agent turn. Planner templates can render card identity/brief, terminal contract description, and the live tool list; executor templates add card type; reviewer templates add assessment identity; analyst templates render the analyst tool list, vocabulary snippet, and project context. Type-specific executor guidance is ordinary prose inline in each terminal executor Markdown file. System-prompt persistence is still deduped once per session, and reviewer turns intentionally skip notification delivery; the registry changes the source of prompt text, not those persistence and notification rules.

The detailed micro-actor module architecture is specified in [Declarative micro-actor module architecture](./declarative-micro-actor-module.md).

## 3. Ownership Boundaries

The runtime is the only dispatcher. Agents request work through tools; they do not directly invoke other agents.

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

Actor cursor snapshots follow the same ownership boundary. Card actors, processors, and card-scoped planner/executor/reviewer LLM actors persist under `.saivage/cards/<cardId>/runtime/actors/<kind>/<encoded-actor-id>.json`; Analyst LLM cursors persist under `.saivage/agents/runtime/actors/llm/<encoded-actor-id>.json`. Actor-id parsers are the singular routing authority for cursor placement; the old global `.saivage/runtime/actors` cursor root is not current state.

The conversation log follows the encapsulation principle: every provider-visible message is persisted as a transcript row when it is added to provider context. That includes assistant text, tool calls, tool results with full bodies, model repairs, notifications delivered at safe pre-provider-call points, continuation-hook directives, planner-state snapshots, and reviewer descendant context. Provider exchange audit metadata is also persisted as `provider_exchange` conversation rows, but those rows are system audit events, not provider-visible transcript content: they contain envelope metadata only, never raw HTTP request/response bodies, and are excluded from prompt construction and from every compaction token-budget, trigger, partition, hashing, provenance, and summarizer-input path. Reviewer currentness is not a separate provider-visible transcript row: the processor captures an in-memory snapshot of the reviewed subtree and included descendant `status.md` record versions, uses that snapshot to construct the persisted reviewer descendant context row, and compares it with current state before committing reviewer approval. Tool-delivery and tool-call-status side ledgers do not exist; recovery derives pending tool calls from conversation rows, and terminal-projected or abandoned settlements are recorded as `tool_result` rows. A `tool_call` is settled only by a `tool_result` that matches the full `(session_id, source_input_id, tool_call_id)` triple, never by `(session_id, tool_call_id)` alone, because provider call ids may repeat within a session. Synthetic settlements use `${source_input_id}:tool:0:tool-result:${tool_call_id}` so the same source-input extraction path handles real and synthetic results. System-prompt persistence is the only special case: it is deduped once per session while still being supplied to the provider through the dedicated system-prompt field. Recovered card processors seed their invocation input counters from durable conversation rows so deterministic provider-exchange ids remain restart-safe. One runtime activation of a card agent is one conversation round; compaction classifies and summarizes the card-lifetime thread across those activation rounds.

Continuation hooks insert caller-provided context only while preparing the next provider input. Planner/executor notification delivery uses those hooks for initial turns, non-terminal tool continuations, failed terminal `emit_result` repair continuations, and plain-text repair continuations. Terminal `emit_result` validation itself does not sample pending notifications and does not merge notification text into terminal repair errors. Failed terminal repairs are represented as the assistant `emit_result` tool call followed by a failed `tool_result` for that same call; any queued notifications for the repair turn appear as separate provider-input context rows.

`tool_error` rows are recovery-visible but not provider-visible. A current `tool_error` row requires `tool`, `tool_call_id`, and an id of `${source_input_id}:tool-error:${tool_call_id}`; malformed rows fail schema validation instead of being ignored by recovery. Startup matches `tool_call`, `tool_result`, and `tool_error` rows by the full `(session_id, source_input_id, tool_call_id)` triple. Before provider reissue, a valid `tool_error`-only settlement is converted into a provider-visible failed `tool_result` for that exact triple.

Reviewer assessment happens after runtime readiness and evidence gates pass for completed project or goal planning cards. Goal reviewers receive the project card data, the assessed goal subtree, and the planner return value; the project reviewer assesses the completed project/root tree outcome against the project card brief and acceptance criteria. Reviewer approval is valid only for the assessed card tree snapshot. If the assessed planning card or any descendant changes before approval commits, the runtime invalidates the reviewer pass and returns that card to planner ownership with correction/change context. Reviewer sessions must never drain the card's main-agent notification queue; notifications queued during review remain pending for planner/main-agent delivery at the next safe provider-input point, and pending notification state alone does not invalidate reviewer success (see [Implementation Plan P5](./micro-actor-runtime-implementation-plan.md#p5-reviewer-cannot-reach-main-agent-notification-delivery)). Negative reviewer results are stored with the card and injected back into the planner context through the completion-return response; positive reviewer text is only attached to the card.

Analyst mutations go through canonical runtime, card, config, process, and notification services.

### Conversation Compaction

Conversation compaction bounds planner, executor, and reviewer card-lifetime threads before provider calls. The subsystem lives under the conversation-index and compaction modules: versioned storage (`conversation-index.ts`, `conversation-store.ts`), round classification, band selection, recoverable-result body dropping, summary cache, summarizer, and compactor orchestration.

Compaction treats `activity` and `provider_exchange` rows as zero-budget non-model-visible rows. Provider exchange rows may remain in durable kept tails, but they cannot trigger compaction, move round or band boundaries, alter summary cache keys, or leak provider-exchange JSON into generated `context_compaction` prose.

Each session directory uses a versioned layout: `index.json`, numbered active/frozen `<N>.jsonl` version files, and `summaries.jsonl`. Legacy `seg-NNN.jsonl` conversation segments are not a supported current format. Code that builds provider input from disk reads only the active version. Frozen versions remain audit evidence. Compaction runs at one hook site only: `LLMActor.onBeforeProviderCall`, invoked from the base `_on_enter__calling_provider` path after the actor is entering a provider call and before the request is sent. If compaction runs, it swaps the in-memory `input.contextMessages` wholesale to the new active version's provider-visible rows and refreshes active reconstruction before the provider call.

Activation-marker `activity` rows delimit top-level rounds; persisted failed `tool_result` and `model_repair` rows delimit sub-rounds. Compaction estimates payload size, applies configurable trigger/reserve/merge/summary fractions and boundary snapping, summarizes far and middle history, and preserves a verbatim recent tail. `context_compaction` rows are provider-visible `role: 'user'` summaries with a runtime framing marker.

Recoverable-result body dropping is the only content removal and happens only inside compaction. Source-recallable results, stash-backed webfetch results, and process-output-backed stdout/stderr results keep enough pointer data for the model to issue `read` later. Every summary row includes a deterministic `Recoverable evidence` section generated by the compactor, not by the summarizer. Cleanup preserves stash and process-log files referenced either by verbatim compacted `tool_result` rows or by those summary sections.

The summary cache stores immutable per-round `summary_text` plus recoverable-evidence descriptors. On re-compaction, existing `context_compaction` rows are treated as already-compacted history; they are not re-summarized. The merged summary is rebuilt from cached per-round entries, prior summary rows are replaced rather than duplicated, and the active version maintains exactly-once coverage: each still-relevant round appears once as merged cached summary content, as a per-round compacted summary, or as verbatim tail rows. Version entries record consumed `summary_ids` for audit.

Configuration knobs live under `compaction`: enablement, trigger/completion-reserve fractions, merge/summary lines, escalation lines, snapping policy, and summarizer model routing. The default leaves automatic compaction disabled unless configured. During an actual summarizer window the LLM actor snapshot reports `compacting: true`; no no-op turn reports that status.

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
4. Runtime dispatches the child to planner/executor/reviewer flow.
5. Runtime returns exactly one activation outcome to the parent planner.

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

State remains project-local under `.saivage/`, not under user-global state. Durable card metadata, record slots, card-owned conversations, and card-owned actor cursors live under `.saivage/cards/<cardId>/`. Disposable operational work lives under `.saivage/work/`, including card tmp files, card-owned process logs at `.saivage/work/cards/<cardId>/processes/<procId>/`, non-card process logs at `.saivage/work/processes/<procId>/`, runtime locks, stashes, uploads, previews, downloads, and raw quarantine bytes. `.saivage/work` may be wiped while the runtime is stopped and is recreated on startup.

Model-facing scoped filesystem references use canonical triple-slash URLs: `project:///`, `record:///`, `tmp:///`, read-only `work:///`, and `system:///`. The workspace layer parses and emits these URLs through one string-based helper that validates raw path segments symmetrically and rejects old two-slash forms. Scoped URL resolution is centralized through a narrow workspace VFS with exactly three operations: `resolve`, `list`, and `glob`. `read`, `write`, and `edit` use VFS `resolve` and then operate on the resolved OS path; `resolve` returns `null` for non-scoped relative paths so callers keep their relative-path branch, and returns a resolved node for scoped input. Scoped URL-shape, segment, record URL, and unsupported-record-slot failures are classified as `WorkspaceToolInputError` at the tool-facing boundary rather than escaping as plain parser throws.

For directory schemes, `project:///`, `work:///`, and `system:///` resolve to the project root, `.saivage/work`, and `/` respectively. `tmp:///` and `record:///` still require their mandatory leading segments. The VFS distinguishes two record namespaces: document URLs such as `record:///<filename>?card=<id>&v=<n>` (or bare `record:///<filename>` using the agent's current card and latest version) are used by `read`, `write`, and `edit`; card-id URLs such as `record:///<cardId>` are used by `list`/`glob` and by `read` when the segment is not a record slot filename. Card-id record namespaces split by operation: `list record:///<cardId>` (and `read` of a card-id record URL) return the metadata projection of all exposed slots with nullable `latest`, including unclosed slots, for inspection; `glob record:///<cardId>` and `grep record:///<cardId>` enumerate only records that have a latest closed version with readable content, returning record URLs. All three hide raw version files and the internal `card.json` slot. Record URLs are derived from card id, slot filename, and version when projected; they are not persisted in record slot index entries. `glob` and `grep` share the internal `collectScopedFiles` enumeration substrate so per-scheme walk and display-path policy live in one place; `grep` searches file content across all scoped schemes, including record card-id latest closed versions.

Process read models expose one ownership contract: `card_id` is a real card id for card-owned processes and `null` for Analyst/operator/runtime processes, while `owner_kind` and `owner_id` identify the owning session/scope. Process log URLs follow ownership: card-owned logs use `work:///cards/<cardId>/processes/<procId>/...`; non-card logs use `work:///processes/<procId>/...`.

Startup recovery is root-cascade based with a pre-reconstruction nested consistency pass. The process runner registry is in-memory only and starts empty after every runtime restart; previous process ids are unknown, no PID/process-group records are reconciled, and OS-process reattachment remains excluded. Startup validates the project root card record and throws if it is missing or schema-invalid. Recovery then runs `runActorStartupRecovery`: it classifies active-version conversations per LLM role/session, projects complete durable terminal outcomes where safe, removes active inner snapshots that conflict with the card's durable status, settles recovery-only `tool_error` rows before provider reissue, appends actionable failed `tool_result` rows for dangling unrelinked tools, and writes sanitized diagnostics. Dangling `activate_card` rows are inspected before generic settlement; without a reconstructed parent continuation they become explicit failed activation results instead of preserved dead edges. Startup then constructs running card actors with deferred processor start and calls `recoverCurrentCardState()` on the root card only. Recovery cascades through replayed `activate_card` calls that remain live; processors start lazily when reached, compatible recovered LLM snapshots are adopted inside `processor.recoverActive`, in-flight provider calls are reissued, and waiting tool calls are resolved inline through `resolveInitialOutcome` and tool replay. Safe terminal decisions may be projected from complete durable terminal records. A `blocked` card status may still arise from safe terminal projection when the persisted planner terminal is itself `blocked`.

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

The UI fetches authoritative read models through REST and receives freshness hints through WebSocket invalidation or event frames. WebSocket does not replace REST as source of truth.

The Analyst can drive workspace navigation by asking the webapp to show a specific card, file, process, debug view, runtime view, or agent session. The UI also sends enough active view/entity/filter context for the Analyst to reason about what the user is seeing.

Internal actor state and compiled transition tables must not leak directly through operator APIs. Public responses expose Saivage read models.

## 12. Security Architecture

All protected API and WebSocket routes require authenticated access when a token is configured.

API bearer tokens are accepted in `Authorization: Bearer` headers, not URL query strings. Browser WebSocket connections use short-lived one-use tickets rather than bearer tokens in URLs.

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

Process execution follows a launch-and-monitor model through the process runner's in-memory registry and process tool provider. Agents launch project commands, inspect status/logs over time, use bounded waits for completion, and explicitly terminate currently known processes when needed. Normal shutdown best-effort terminates live child processes through their `ChildProcess` handles; abrupt-crash survivors are ignored on the next start. `run_command`, `wait_process`, and `kill_process` share one metadata-only result shape with process identity, exit/status, byte counts, and canonical `work:///processes/<id>/stdout.log` / `stderr.log` URLs. Process-list read models derive stdout and stderr log URLs from the in-memory process records; process output directories contain `stdout.log` and `stderr.log` only, with no duplicate `combined.log`. The functional specification does not impose process concurrency limits for now.

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
| `planner` | `cancel_card,create_card,queue_notification,reorder_child` | `src/tools/analyst-card-tools.ts:265` |
| `executor` | `` | `src/tools/analyst-tool-registry.ts:55` |
| `reviewer` | `` | `src/tools/analyst-tool-registry.ts:55` |
| `analyst` | `cancel_card,create_card,delete_card,get_status,list_agent_sessions,list_processes_tool,navigate_back,navigate_workspace,pause_runtime,queue_notification,read_agent_session,read_control_actions,read_runtime_errors,read_runtime_events,reconfigure,reorder_child,restart_server,resume_runtime,show_config,start_project,stop_project` | `src/tools/analyst-tool-registry.ts:64` |
<!-- saivage:agent-tools:end -->

### Config schema

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
