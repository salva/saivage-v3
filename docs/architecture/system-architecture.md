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

The detailed micro-actor module architecture is specified in [Declarative micro-actor module architecture](./declarative-micro-actor-module.md).

## 3. Ownership Boundaries

The runtime is the only dispatcher. Agents request work through tools; they do not directly invoke other agents.

Planner/card state owns hierarchy, objectives, dependencies, evidence, status, result data, working status, and history. Runtime execution state owns root intent, command/run/activation ledgers, active-card-run state, process records, and recovery metadata.

Changing planner/card state does not by itself dispatch work. Root work starts through explicit runtime control; child work starts through parent-planner `activate_card`.

The Analyst is the global card mutation authority for user-requested changes. Analyst card mutations go through the canonical card service, which must not start autonomous work directly. Planners have local card authority only over direct children of the goal they own; they do not directly target ancestors, siblings, unrelated cards, or deeper descendants. Recursive operations such as cancelling or deleting a direct child may affect that child's subtree as a runtime consequence. Cards may be reordered among siblings where supported, but cross-parent movement is not a supported operation.

## 4. Active Work Model

At most one leaf card is doing real work at a time. The active work chain can contain multiple cards with durable status `running`, but only the leaf receives scheduling, LLM turns, or process work.

Ancestors hold activation context for their active child. That context is actor data, not a separate card state.

The runtime persists enough active-card-run and activation-ledger information to unwind one child activation outcome back to its parent planner.

Activation validation happens before dispatch. A parent planner can activate only an immediate child in `backlog`, `changed`, or `blocked`. Activation transitions the child to `running`; child main-agent `done`, `failed`, or `blocked` outcomes update the child card before the parent planner receives the activation tool result. Runtime cancellation can instead resolve the parent-visible activation as `cancelled`; processors do not emit `cancelled`. `done` cards are not activatable unless later modification changes them to `changed`; `failed` cards are not activatable and require explicit planner/operator handling such as cancellation, replacement, edit-to-`changed`, or escalation.

## 5. Agent Lifecycle

Planner sessions are goal-lived and should have deterministic identity derived from the goal card. A planner is created lazily the first time it is needed, can become inactive after reporting done, failed, or blocked, and can later be resumed by activation of the same goal as the same logical agent session.

Executor sessions are one-shot per terminal card activation.

Reviewer sessions are one-shot per assessment.

Reviewer assessment happens after runtime readiness and evidence gates pass. The reviewer receives the project card data, the assessed goal subtree, and the planner return value. Reviewer approval is valid only for the card tree snapshot it assessed. If the goal or any descendant changes before approval commits, the runtime invalidates the reviewer pass and returns the goal to planner ownership with correction/change context. Reviewer sessions must never drain the card's main-agent notification queue; notifications queued during review remain pending for planner/main-agent delivery and may invalidate reviewer success through currentness checks (see [Implementation Plan P5](./micro-actor-runtime-implementation-plan.md#p5-reviewer-cannot-reach-main-agent-notification-delivery)). Negative reviewer results are stored with the card and injected back into the planner context through the completion-return response; positive reviewer text is only attached to the card.

Analyst sessions are user-facing conversational sessions. Analyst mutations go through canonical runtime, card, config, process, and notification services.

## 6. Runtime Control Flow

Run:

1. Analyst receives a user request to run, start, continue, or resume.
2. If the runtime is paused, the runtime opens the global provider-admission gate so provider waiters proceed before new autonomous work is admitted.
3. If no root run exists, `SupervisorRuntimeApi` records durable running intent and creates the root runtime run.
4. If the project is already running, `SupervisorRuntimeApi` returns an already-running warning and creates no duplicate root run.
5. When needed, `SupervisorRuntimeApi` activates the parentless project card through the runtime/composition root.

Child execution:

1. Planner calls `activate_card(child_id)`.
2. Runtime validates parent ownership and child readiness.
3. Runtime records an activation edge from parent run/tool call to child run.
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

## 8. Changed-State Propagation

Analyst mutation or parent-planner mutation sets a non-active, non-terminal card to `changed`. Terminal `cancelled` cards cannot be edited or reactivated. If the modified card is already `running`, it remains `running`. In both cases the runtime queues a notification to the modified card so the card's main agent becomes aware of the change.

When a modification affects an inactive descendant, inactive ancestors on the direct path to the project root receive changed-subtree context and become `changed` until the first running ancestor. Running ancestors stay `running` and receive notification/context instead of status overwrite. In practice, deep propagation is most often needed for Analyst edits because parent-planner edits target direct children of the active goal. Ancestors are not automatically dispatched by the status change.

The acceptance gate prevents a planner from closing a goal while any executable descendant is not in a completion-compatible state. This forces the planner to observe and handle changed, blocked, backlog, running, failed, or otherwise incomplete executable descendants before claiming completion. Done and `cancelled` descendants are completion-compatible and do not block `done`.

`result` is attached from accepted main-agent results only. It is not updated from progress chatter, rejected reports, or reviewer correction requests. `working_status` is separate free text for agents attached to the card.

## 9. Cancellation

Cancellation is immediate only for inactive cards. Recursive cancellation preserves descendants that are already `done` and converts inactive non-completion-compatible descendants, including `failed`, `blocked`, `backlog`, and `changed`, to `cancelled`.

Cancelling a running card is authoritative: `CardActor.cancel()` cancels the current activation, writes `cancelled` to the card store immediately, resolves the pending activation as cancelled, stops activation-owned runtime process scope, and drops late provider/tool/process outcomes through the CardActor cancellation flag (see [Implementation Plan P3](./micro-actor-runtime-implementation-plan.md#p3-cardactor-owns-authoritative-cancellation-and-activation-id-settlement)). Running children are cancelled through their own `CardActor.cancel()` so they are cancelled too. Shutdown remains the hard operation for forcibly stopping all runtime-owned process scopes.

Project-card cancellation is the root case of the same operation. Inactive project work is cancelled immediately; running project work is cancelled via the same activation path, which marks the card store `cancelled` immediately and rejects late outcomes.

## 10. Persistence

Durable state remains project-local. Saivage state must live under the project `.saivage/` and `.saivage-work/` directories, not under user-global state.

Model-facing scoped filesystem references use canonical triple-slash URLs: `project:///`, `record:///`, `tmp:///`, read-only `work:///`, and `system:///`. The workspace layer parses and emits these URLs through one string-based helper that validates raw path segments symmetrically and rejects old two-slash forms. Scoped URL resolution is centralized through a narrow workspace VFS with exactly three operations: `resolve`, `list`, and `glob`. `read`, `write`, and `edit` use VFS `resolve` and then operate on the resolved OS path; `resolve` returns `null` for non-scoped relative paths so callers keep their relative-path branch, and returns a resolved node for scoped input. Scoped URL-shape, segment, record URL, and unsupported-record-slot failures are classified as `WorkspaceToolInputError` at the tool-facing boundary rather than escaping as plain parser throws.

For directory schemes, `project:///`, `work:///`, and `system:///` resolve to the project root, `.saivage-work`, and `/` respectively. `tmp:///` and `record:///` still require their mandatory leading segments. The VFS distinguishes two record namespaces: document URLs such as `record:///<filename>?card=<id>&v=<n>` (or bare `record:///<filename>` using the agent's current card and latest version) are used by `read`, `write`, and `edit`; card-id URLs such as `record:///<cardId>` are used by `list`/`glob` and by `read` when the segment is not a record slot filename. Card-id record namespaces split by operation: `list record:///<cardId>` (and `read` of a card-id record URL) return the metadata projection of all exposed slots with nullable `latest`, including unclosed slots, for inspection; `glob record:///<cardId>` and `grep record:///<cardId>` enumerate only records that have a latest closed version with readable content, returning record URLs. All three hide raw version files and the internal `card.json` slot. Record URLs are derived from card id, slot filename, and version when projected; they are not persisted in record slot index entries. `glob` and `grep` share the internal `collectScopedFiles` enumeration substrate so per-scheme walk and display-path policy live in one place; `grep` searches file content across all scoped schemes, including record card-id latest closed versions.

Startup recovery is process-first and root-cascade based (see [Implementation Plan P1](./micro-actor-runtime-implementation-plan.md#p1-processrunner-owns-truthful-process-state-and-scoped-termination) and [P2](./micro-actor-runtime-implementation-plan.md#p2-startup-reconciles-processes-before-actor-recovery)). The runtime reconciles persisted running process records before actor recovery: runtime/agent-owned process records are killed by PID/process-group or marked lost, operator-owned records are observed best-effort or marked lost, and no `reattach_state` or live process reattachment fiction is used. After process reconciliation (runtime/agent-owned records killed or marked lost as terminal `killed`/`failed`; operator-owned records still alive matched and remaining `running`; operator-owned missing/skewed records marked lost as terminal `failed`; no record removed), startup validates the project root card record and throws if it is missing or schema-invalid. Recovery then runs the pre-reconstruction `runActorStartupRecovery` pass for terminal projection, cancelled/terminal-projected snapshot cleanup, stale-tool-call abandonment, and sanitized diagnostics, constructs running card actors with deferred processor start, and calls `recoverCurrentCardState()` on the root card only. Recovery cascades through replayed `activate_card` calls; processors start lazily when reached, recovered LLM snapshots are adopted inside `processor.recoverActive`, in-flight provider calls are reissued, and waiting tool calls are resolved inline through `resolveInitialOutcome` and tool replay. Safe terminal decisions may be projected from complete durable terminal records. A `blocked` card status may still arise from safe terminal projection when the persisted planner terminal is itself `blocked`. Process reattachment remains excluded.

Expected persisted concerns include:

- card tree and history;
- record-backed card state, including internal structured card versions plus authored document records such as `brief.md`, `status.md`, and `review.md`;
- agent messages and manifests;
- runtime state, intent, commands, runs, and activations;
- process registry and safe process logs;
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
- `BaseMainLLMCardProcessorActor` owns shared main-agent LLM loop mechanics and per-turn notification delivery without role-specific policy;
- `PlanningCardProcessorActor` owns project/goal planner and reviewer semantics;
- `TerminalCardProcessorActor` owns executor semantics for terminal cards; it constructs card-scoped capabilities and does not own child cards.

Process execution follows a launch-and-monitor model through the process runner, process registry, and process tool provider. Agents launch project commands, inspect status/logs over time, use bounded waits for completion, and explicitly terminate processes when needed. `run_command`, `wait_process`, and `kill_process` share one result shape with process identity, exit/status, byte counts, redacted tails, and canonical `work:///processes/<id>/stdout.log` / `stderr.log` URLs. Process-list read models derive `work:///processes/<id>/{stdout,stderr,combined}.log` log URLs from registry paths. The functional specification does not impose process concurrency limits for now.

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
| `GET /api/runtime/card-runs` | Runtime card-run projection. | `src/contracts/operator-api-runtime-cards.ts:283` |
| `GET /api/runtime/status` | Runtime status projection. | `src/contracts/operator-api-runtime-cards.ts:253` |
| `GET /api/state` | Operator state projection. | `src/contracts/operator-api-runtime-cards.ts:187` |
| `GET /health` | Liveness probe. | `src/contracts/operator-api-runtime-cards.ts:165` |
| `GET /health/ready` | Readiness probe. | `src/contracts/operator-api-runtime-cards.ts:176` |
| `POST /api/auth/ws-ticket` | WebSocket ticket issuance. | `src/contracts/operator-api-auth.ts:22` |
| `POST /api/chats/:sessionId` | Analyst chat turn submission. | `src/contracts/operator-api-chats.ts:78` |
| `POST /api/runtime/pause` | Runtime pause control. | `src/contracts/operator-api-runtime-cards.ts:263` |
| `POST /api/runtime/resume` | Runtime resume control. | `src/contracts/operator-api-runtime-cards.ts:273` |
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
| `top-level` | `mcpServers,models,notifications,providers,runtime,security,server,telegram` | `src/agents/config-schema.ts:167` |
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
| `mcpServers.entry` | `args,autostart,command,disabled,env,transport,url` | `src/agents/config-schema.ts:155` |
<!-- saivage:config-schema:end -->
