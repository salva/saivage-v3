# System Architecture

This document is the canonical architecture authority for Saivage v3. The current durable-format cutover is reset-only; old binaries, mixed formats, migrations, compatibility readers, bridges, and normalization paths are unsupported.

The supported runtime is Node.js 24 with npm `>=10 <12`, matching `package.json` engines and CI.

## 1. Ownership Model

The runtime is card-centered. The runtime alone dispatches work. Project and goal cards start with a planner; terminal card types start with an executor. Reviewer work is nested process-local planner work and is never a restart entry.

`CardActor` owns one live card activation. Its synchronous `open | claimed_result | claimed_cancel | claimed_stop` claim decides result, cancellation, and Stop ownership before any await. The supervisor keeps one retained-actor map for process-local ownership and one exact-live-activation map for running cancellation resolution. A running card without exactly one live owner is impossible and fails fast; callers never fall back to direct cancellation.

Cancellation first revokes provider, tool, child, reviewer, process, and callback admission. The cached actor-local cancellation promise runs `finishCancellation()` as the exact winner boundary: it contains activation-owned processes and exact live descendants, directly publishes the cancelled card, and settles its caller once. For natural result or cancellation settlement outside closing, the actor then synchronously delegates its own identity to the supervisor. The supervisor requires that exact actor in both maps and removes both entries; mismatch fails fast. A later legitimate activation constructs a fresh `CardActor` and processor. Already-done descendants remain done. This is process-lifecycle authority and reference release, not a persistence lock, queue, transaction, generation, or currentness mechanism.

## 2. Card Identity And Discovery

Card identity is exactly `project` for the fixed root or a canonical lowercase UUID for every non-root card. IDs are opaque. UI labels, hierarchy paths, ordering, and scheduling never parse numeric meaning from them.

One non-root creation attempt asks its card-identity factory exactly once and exclusively claims `.saivage/cards/<uuid>/`. It reuses that UUID in all attempt-local paths and artifacts. A collision or any publication failure ends the attempt without retry, alternate identity, allocation scan, adoption, or reuse.

Initial publication is brief first and canonical card last. Discovery probes a tombstone first. A valid non-root tombstone reserves the UUID and excludes retained evidence from active projection. Without a tombstone, only exact canonical card artifacts establish an active card. Namespace-only, brief-only, temp-only, and arbitrary noncanonical entries are silent invisible orphans. They are never scanned for allocation, validated in aggregate, cleaned, warned about, adopted, quarantined, or repaired.

## 3. Direct File Persistence

Saivage-owned persistence is direct stateless synchronous file I/O by the domain or actor owner:

- `card-files.ts` owns card reads, versions, initial publication, history, and tombstones.
- `authored-record-files.ts` owns record reads, open replacement, close, and discard.
- `conversation-file.ts` owns one stable append-only conversation per role session.
- `app-log.ts` owns strict event, error, unrelated control-action, provider-exchange, and content-review entries.
- `config-file.ts`, `auth-profile-file.ts`, and `project-identity.ts` own their single canonical files.
- `runtime/lock.ts` is the exceptional process-exclusion boundary only.

`CardService` performs operation-local rereads and invokes these direct functions. A disposable `CardIndex` may project one read, but it never authorizes a later write. There are no repositories, generic stores, persistence health latches, writer registries, queues, generations, transactions, repair orchestrators, or durable runtime owners.

Every replacement and first JSONL publication calls `replaceFile`. It creates one fresh random UUID same-directory temp exactly once with `O_CREAT | O_EXCL | O_WRONLY`, writes and fsyncs it, renames over the target, and fsyncs the parent. A collision or other failure propagates. Crash-left temps remain ignored forever. The card-identity factory, publication-temp factory, and invocation UUID generation are distinct scopes.

All file, directory, append, and lifecycle-lock creation uses ordinary Node defaults filtered only by the process umask. No mode argument, chmod/fchmod, permission probe, or repair exists.

Growing canonical JSONL files append one newline-terminated strict envelope with non-empty rows. An owning reader may truncate only an identifiable unterminated final suffix of that exact canonical file. Complete malformed data remains and fails.

## 4. Stable Sessions And Local Recovery

Stable autonomous sessions are `planner:<card-id>`, `executor:<card-id>`, and `reviewer:<card-id>`. Each has one canonical `conversation.jsonl`; there are no versions, active-version inventories, sidecars, summary caches, or reconstructed provider continuations.

Each role, Analyst turn, compactor summary call, repair, and continuation uses a fresh opaque UUID `source_input_id` generated by its live owner. Tool identities derive only from the original source UUID `S` and provider tool-call ID `T`:

```text
${S}:tool-call:${T}
${S}:tool-result:${T}
```

The next provider UUID is unrelated. Provider attempt indexes order attempts within one invocation only.

On restart or Stop→Run, the session owner validates and locally settles the latest conversation round. One unmatched call in an interrupted latest round receives a provider-visible failed `tool_result` with `outcome_unknown:true`, followed by a truthful recovery notice in a fresh activation. This durable-log settlement does not reconstruct an actor or continue a provider call. Multiple, older-round, malformed, or cleanly-closed unmatched combinations fail. Cards and records never infer whether an interrupted external effect succeeded.

## 5. Notifications And Terminal Arbitration

Notifications persist only in the target card's ordered `pending_notifications`. The durable request identifies one `card_id`; no role/session recipient or session-delivery result exists. `backlog`, `changed`, `running`, and `blocked` preserve pending context. Only `done`, `failed`, and `cancelled` clear and reject it with `terminal_card`.

Planner and executor session owners drain pending context at provider safe points by appending ordered notification rows and then removing those exact IDs from the card without an await. Append-before-remove intentionally permits duplicate context after interruption.

Immediately before planner/executor terminal acceptance, one no-await reread chooses:

1. no pending context: record close → canonical success → card transition; or
2. pending context: paired failed `emit_result` → ordered notification rows → exact card removal, followed by another model round.

Reviewer never drains the queue. Before accepting `done`, `blocked`, `failed`, or `rework`, it recomputes semantic currentness and rereads pending context. Pending context wins: discard the open review first, append the paired defer failure second, transition nothing, and return to planner. Stale-without-pending similarly discards before its failed stale result and refreshed context. Every fresh reviewer activation unconditionally discards an existing open review before its activation marker. There is no reviewer round limit.

## 6. Runtime Controls

Runtime lifecycle is process-local. Startup is stopped. An installed instance is starting, running, pausing, paused, or closing. Pause uses one boolean and at most one parked frontier; admitted synchronous settlement may finish, but no fresh provider/tool/process/child/reviewer admission begins until Resume.

The operation-specific REST contracts are distinct: Pause, Resume, and `stop_project` declare no request body, while `restart_server` declares the strict exact `{confirmation:'RESTART SERVER'}` body. The three bodyless handlers inspect the raw request first and locally return their declared 400 validation envelope for every defined body before invoking runtime control; this is not a shared `ContractRuntime` parser policy. Clients emit JSON `Content-Type` only with an actually serialized JSON body. Authentication and ordinary headers remain independent, so bodyless Stop retains them without advertising JSON.

Run validates the unique contiguous project-rooted running chain and installs its complete ownership in both supervisor maps before admission. Every owner is a fresh process-local `CardActor`; the micro-actor lifecycle has only initial-state `start()` and no recover or rehydrate entrypoint. Every ancestor holds only an immediate-child `structural_wait`; only the deepest owner creates a processor and starts planner/executor by card type. After durable outcome and activation-caller settlement, the supervisor's identity-checked natural release removes the settled actor from both maps synchronously. Normal child settlement wakes one parent at a time with current facts and no reconstructed child ToolResult.

`stop_project` is restartable non-domain containment, never cancellation. It closes global continuation/admission and freezes both complete ownership maps before first-claim classification. Open owners receive one identity-preserved `RuntimeStoppedInterruption` and preserve durable `running` state; result winners are not reclaimed or aborted and only suppress continuation. A cancellation winner is likewise not reclaimed or aborted: Stop starts or joins its cached actor-local cancellation promise and waits for `finishCancellation()` to publish `cancelled` and settle its caller. While the runtime is closing, result and cancellation settlement do not invoke natural release and leave both ownership entries installed for the supervisor. LLM, processor, card, structural-parent, child-tool, and root catches rethrow the exact Stop interruption rather than mapping it to domain failure. Cancellation-settlement, cleanup, and process failures side-report to one Stop-local collector and cannot replace a committed winner. Only after every owner settlement succeeds does the supervisor atomically clear both frozen maps and the current instance; this aggregate clear is separate from per-actor natural release. Otherwise one `RuntimeContainmentError` leaves both full closed maps and the runtime closing. Stop itself writes no card/root outcome or event.

The negative terminal call graph is explicit: `App.stop()`/signals/startup failure/acknowledged restart → sole App terminal coordinator → flat admission closers and cleanup leaves; no edge reaches `stopProject`, cancellation, `RuntimeContainmentError`, or the Stop collector. The coordinator tries every closer synchronously before its first await, then sequentially settles reverse-construction-order leaves through one referenced ten-second bound. Rejection/timeout records only fixed allowlisted component+code data and never skips later leaves. Direct `App.stop()` returns an immutable `ShutdownReport` and does not log; process-boundary adapters log fixed warnings and preserve exit/restart/original-error behavior.

Process cleanup has one `ProcessRunner` and one registry with sibling `runtimeRootScope`, `analystRootScope`, and `mcpRootScope`. The registry owns child-event safety immediately when platform spawn returns and attaches its mandatory `error` listener before inspecting the leader PID. It admits a group only with a positive leader PID; after admission, `ProcessRunner` owns output and user-facing process presentation. A rejected child can therefore emit its asynchronous OS launch error without escaping the already-handled launch failure. For stdio MCP children, stdout remains the protocol channel; the MCP runtime continuously drains and discards child stderr for the child's lifetime. Stderr content is neither retained nor exposed, and the existing empty process-log placeholder remains unchanged. The sole runtime, Analyst, and MCP leaves each perform `close/revoke → one asserted owned-root termination call → initiate/continue joins → combined settlement`; termination starts before any await, so a hanging join cannot postpone it. A nonempty fulfilled `ProcessStopReport.failed` rejects the leaf. A timed-out component can continue only under its own root while later disjoint-root leaves proceed. Project Stop and App runtime cleanup may overlap on the runtime root, tolerating repeated signals and already-exited/missing/removal observations without locks, deduplication, shared promises, registry-wide drains, or collector sharing. LiveSync, Fastify, and Telegram are independent leaves; Fastify close does not dispose LiveSync. Telegram uses one private stop reason per lifecycle and normalizes only exact rejection identity.

The process tool passes each `run_command` command unchanged as one `bash -c` argument. Its cwd boundary classifies scoped-looking values before filesystem resolution: canonical project and system roots/descendants are accepted, ordinary relative paths remain project-contained, and malformed, unknown, or non-cwd scoped schemes fail before spawn.

## 7. Lifecycle Lock And CLI Delegation

Read-only lock classification is `missing | live | dead | indeterminate | malformed`. Live requires a valid record plus matching process-start identity. Dead requires positive proof. Permission denial, unavailable process identity, and observation races are indeterminate. No classification authorizes lock removal or takeover.

CLI status, pause, resume, stop, and restart delegate only for a verified live record and only through its published non-null `control_endpoint.origin` and `control_endpoint.auth`. A null endpoint fails exactly `active lifecycle owner; runtime control unavailable`; no phase is inferred.

- missing/dead status reports stopped;
- missing/dead stop succeeds with `contained:false`;
- missing/dead pause/resume fails no-live;
- dead also reports manual abandoned-lock repair;
- indeterminate/malformed fails closed.

The shared operator HTTP client appends only canonical operation paths. It sends bodyless Pause, Resume, and Stop requests without JSON `Content-Type`, while confirmed Restart carries its exact JSON body and content type. It never rediscovers YAML, flags, host/port environment, defaults, runtime files, or current process config. Published disabled auth omits Authorization; published bearer requires `SAIVAGE_API_TOKEN` and sends it only in a header. Connection, authentication, response, or schema failure has no fallback.

## Conversation Compaction

Compaction is context construction by the stable session owner over immutable non-compaction source rows. It appends one strict system `context_compaction` row whose content is canonical JSON. The physically latest valid row supplies one generated `rendered_context`; older metadata is never provider-visible or summary input.

When enabled, `compaction.input_budget_tokens` is required and route-independent. Stage 1 validates budget, fractions, positive derived completion tokens, and that escalated tail/middle widths are no larger than normal. Stage 2 builds the exact prompt and tool surface, estimates static tokens, and rejects nonpositive trigger or hard capacity before any conversation, summarizer, router, or provider I/O.

Normal and escalated partitions measure newest-relative completed-round tail and middle windows backward from the newest completed round. The current round stays verbatim in normal operation. Raw IDs and hashes remain authority; cutoff coverage advances monotonically. Hard fallback runs only for residual oversize after whole-round partitioning and never splits tool pairs, Responses bundles, static units, or an open call.

For each candidate, the actual request builder runs once. The body is canonicalized once and estimated as `ceil(UTF8 bytes / 4)`. This deterministic best-effort heuristic may skip obvious oversize but is not a fit proof. The admitted transport sends that same serialized body. Provider context rejection remains authoritative. One derived `requestedCompletionTokens` controls hard ceiling, capability admission, model authority, and the Chat and public Responses wire output limits. The Codex backend intentionally omits an output-limit field while retaining that quantity for compaction and capability admission.

## 9. Availability And Credentials

Candidate availability is one process-local map that resets on process restart. Provider completion checks the exact invocation signal before changing it. No availability file, replay, restabilization, or persistence-health dependency exists.

Auth profiles use direct strict whole-file reads and optimistic replacement. Exact-path `ENOENT` alone means absence. OAuth refresh threads the original invocation abort signal through gateway, transport, resolver, and refresh implementation; it checks after response/body awaits and immediately before the synchronous latest-file reread and replacement. Concurrent refresh is accepted last-completed-write-wins behavior with no revision, CAS, lock, or merge protocol.

## 10. API And UI Projection

REST and WebSocket are projection/transport surfaces. REST remains authoritative; WebSocket carries lossy freshness hints. Runtime, readiness, and debug responses contain no persistence-health component or durable runtime/snapshot file. Provider views label availability as process-local. Card routes and links preserve opaque UUID identity while displaying title and hierarchy labels.

Runtime freshness publication follows direct synchronous mutation ownership. `CardService` invokes card and runtime changes, in that order, after successful create and delete publication; after an actual update it invokes runtime change only when the already-pruned patch owns changed `status` and/or `type`. This complete create/delete/status/type set is the minimal correction required by the existing all-card runtime index (`total`, `byStatus`, and `byType`), not a generic all-card-write rule or an unrelated card audit. Non-index card edits remain runtime-silent while retaining their card change hint.

Actor-only owners synchronously report post-mutation lifecycle/run-identity boundaries, every retained-card insertion (including an initial-chain prefix that survives later launch failure), retained-card release, active-leaf changes, retained-agent membership, and autonomous-agent public phase changes through the supervisor's single translation callback. `ActiveCardLeaf` is the sole current-card source. Launch reports the complete supervisor-owned running boundary before actor construction, reports each retained insertion at its `Map.set`, and installs/reports the active leaf only after running ownership installation and validation complete. Mutations that remain visible after a later synchronous throw have therefore already supplied a freshness hint.

The singular `ReadModelChanges` broadcaster feeds `SyncHub`; `SyncHub` alone debounces and coalesces successful owner hints before `LiveSyncSocket` sends canonical invalidation frames. Clients treat those frames as lossy prompts and refetch authoritative REST state. There is no owner-side suppression, polling, queue, generation, acknowledgement, replay, or alternate publication path.

In the web dependency direction, the runtime, card, and agent Pinia stores are the separate canonical owners of runtime/status, card, and agent-list/conversation/exchange resources. Application bootstrap performs their unfiltered initial REST reads and registers exactly one live-sync refetch target per core family; routes and Debug consume those owners instead of refetching or copying their rows. DebugStore owns only diagnostic errors, timeline, processes, doctor, and supervision. `/api/debug/state` and `/api/runtime/status` remain available with unchanged contracts; the absence of a current Debug UI consumer does not alter either backend projection.

DebugAgentDetail and the primary Agents conversation/raw-exchange components are keyed presentation lifetimes over AgentStore, not data owners or a consumer registry. A mounted conversation claims one fresh opaque current-consumer token, disposes its live subscription before token-guarded clear, and invalidates its request when the key or route departs; subscribe precedes fetch so initial loading cannot miss an invalidation. Exchange selection uses an independent token and abort boundary. Token identity and request epochs reject stale callbacks, completion, `finally`, and delayed cleanup, including replacement by the same session ID.

The Files read model maps canonical `work:///` to the `.saivage/work` directory root and emits canonical descendant URLs. The process API remains narrower: stdout/stderr fields require a concrete card-owned or non-card process-log URL and reject the root.

The UI exposes one **Stop project** action and a distinct confirmed **Restart server** action only when required `restart_server_available` is true. It never optimistically writes a running card as cancelled. Raw conversation views retain canonical compaction JSON; rendered views show its single synthetic system context.

## 11. Reset And Failure Model

Durable-format changes require stopping the service and resetting generated persistence. `resetOwnedGeneratedRoots()` in `src/persistence/layout.ts` is the singular reset ownership contract: `.saivage/cards`, `.saivage/agents`, `.saivage/logs`, and `.saivage/work`. These generated roots are removed as whole trees without descendant inspection. Durable configuration and operator inputs under `.saivage`, including identity, credentials, prompt overrides, skills, and instructions, remain outside that ownership boundary, as do source and canonical documents.

The `.saivage/locks` namespace is the exceptional lifecycle-exclusion boundary, not reset-owned generated persistence. Reset acquires the exact canonical `runtime.lock`, removes the four complete roots, publishes the new `project` root card while still holding the lock, and then uses exact-owner release. A pre-existing exact lock blocks deletion. Lock siblings and every other outside-boundary path are neither discovered nor cleaned. Mixed-version operation and rollback against current-format state are unsupported.

Saivage file persistence does not guarantee no data loss. Interrupted external effects may repeat; notification context may duplicate; concurrent auth refresh may overwrite another change; incomplete card namespaces and publication temps may remain forever. Exact canonical corruption fails clearly for operator repair or reset rather than automatic recovery.

## 12. Source-Derived Reference

This appendix is maintained as source-derived reference data for documentation drift guards.

### Operator routes

<!-- saivage:operator-routes:start -->
| Route | Purpose | Source |
|---|---|---|
| `GET /api/agents` | Agent session list projection. | `src/contracts/operator-api-agents.ts:56` |
| `GET /api/agents/:id` | Agent session detail projection. | `src/contracts/operator-api-agents.ts:66` |
| `GET /api/agents/:id/conversation` | Agent conversation projection. | `src/contracts/operator-api-agents.ts:77` |
| `GET /api/agents/:id/llm-exchange` | Agent provider-exchange projection. | `src/contracts/operator-api-agents.ts:88` |
| `POST /api/auth/ws-ticket` | WebSocket ticket issuance. | `src/contracts/operator-api-auth.ts:22` |
| `GET /api/chats` | Analyst session list. | `src/contracts/operator-api-chats.ts:56` |
| `GET /api/chats/:sessionId` | Analyst transcript. | `src/contracts/operator-api-chats.ts:66` |
| `POST /api/chats/:sessionId` | Analyst turn submission. | `src/contracts/operator-api-chats.ts:77` |
| `GET /api/config` | Redacted configuration. | `src/contracts/operator-api-config.ts:73` |
| `GET /api/providers` | Provider routing projection. | `src/contracts/operator-api-config.ts:83` |
| `GET /api/control-actions` | Control-action projection. | `src/contracts/operator-api-config.ts:93` |
| `GET /api/events` | Event timeline. | `src/contracts/operator-api-events.ts:35` |
| `GET /api/files` | Workspace listing. | `src/contracts/operator-api-files-debug.ts:54` |
| `GET /api/files/content` | Workspace content. | `src/contracts/operator-api-files-debug.ts:65` |
| `GET /api/mcp/status` | MCP status. | `src/contracts/operator-api-mcp.ts:72` |
| `GET /api/mcp/tools` | MCP tools. | `src/contracts/operator-api-mcp.ts:82` |
| `GET /api/processes` | Process list. | `src/contracts/operator-api-processes.ts:71` |
| `GET /api/processes/:id` | Process detail. | `src/contracts/operator-api-processes.ts:81` |
| `GET /health` | Liveness. | `src/contracts/operator-api-runtime-cards.ts:138` |
| `GET /health/ready` | Readiness. | `src/contracts/operator-api-runtime-cards.ts:149` |
| `GET /api/state` | Operator runtime state. | `src/contracts/operator-api-runtime-cards.ts:160` |
| `GET /api/cards` | Card list. | `src/contracts/operator-api-runtime-cards.ts:170` |
| `GET /api/cards/:id` | Card detail. | `src/contracts/operator-api-runtime-cards.ts:180` |
| `GET /api/cards/:id/history` | Card history. | `src/contracts/operator-api-runtime-cards.ts:192` |
| `GET /api/cards/:id/history/:seq` | Card history entry. | `src/contracts/operator-api-runtime-cards.ts:203` |
| `GET /api/cards/:id/diff` | Card diff. | `src/contracts/operator-api-runtime-cards.ts:214` |
| `GET /api/runtime/status` | Runtime status. | `src/contracts/operator-api-runtime-cards.ts:226` |
| `POST /api/runtime/pause` | Bodyless Pause project work. | `src/contracts/operator-api-runtime-cards.ts:236` |
| `POST /api/runtime/resume` | Bodyless Resume project work. | `src/contracts/operator-api-runtime-cards.ts:246` |
| `POST /api/runtime/stop-project` | Bodyless Stop project containment. | `src/contracts/operator-api-runtime-cards.ts:256` |
| `POST /api/runtime/restart-server` | Strict-confirmation authenticated server restart. | `src/contracts/operator-api-runtime-cards.ts:266` |
| `GET /api/runtime/card-runs` | Current card-run projection. | `src/contracts/operator-api-runtime-cards.ts:277` |
<!-- saivage:operator-routes:end -->

### Internal debug routes

<!-- saivage:internal-debug-routes:start -->
| Route | Purpose | Source |
|---|---|---|
| `GET /api/debug/doctor` | Internal card diagnostic. | `src/server/routes/chats-files-debug.ts:16` |
| `GET /api/debug/errors` | Internal error projection. | `src/contracts/operator-api-files-debug.ts:86` |
| `GET /api/debug/state` | Internal state projection. | `src/contracts/operator-api-files-debug.ts:76` |
| `GET /api/debug/supervision` | Internal supervision projection. | `src/server/routes/chats-files-debug.ts:37` |
| `GET /api/debug/timeline` | Internal timeline projection. | `src/contracts/operator-api-files-debug.ts:96` |
<!-- saivage:internal-debug-routes:end -->

### Agent tools

<!-- saivage:agent-tools:start -->
| Role | Tools | Source |
|---|---|---|
| `planner` | `cancel_card,create_card,queue_notification,reorder_child` | `src/tools/analyst-card-tools.ts:142` |
| `executor` | `` | `src/tools/analyst-tool-registry.ts:55` |
| `reviewer` | `` | `src/tools/analyst-tool-registry.ts:55` |
| `analyst` | `cancel_card,create_card,delete_card,get_status,list_agent_sessions,list_processes_tool,mcp_reconcile,navigate_back,navigate_workspace,pause_runtime,queue_notification,read_agent_session,read_control_actions,read_runtime_errors,read_runtime_events,reconfigure,reorder_child,restart_server,resume_runtime,show_config,start_project,stop_project` | `src/tools/analyst-tool-registry.ts:64` |
<!-- saivage:agent-tools:end -->

### Config schema

<!-- saivage:config-schema:start -->
| Section | Fields | Source |
|---|---|---|
| `top-level` | `compaction,mcpServers,models,notifications,providers,runtime,security,server,telegram` | `src/agents/config-schema.ts:198` |
| `models` | `default,equivalents,failover,max_tokens,profiles,routing,temperature` | `src/agents/config-schema.ts:36` |
| `providers.entry` | `accounts,apiKey,authProfile,baseUrl,capabilities,modelCapabilities,models,priority` | `src/agents/config-schema.ts:94` |
| `providers.account` | `apiKey,authProfile,baseUrl,capabilities,models,priority` | `src/agents/config-schema.ts:84` |
| `server` | `host,port` | `src/agents/config-schema.ts:106` |
| `runtime` | `continuous_improvement,process_timeouts` | `src/agents/config-schema.ts:118` |
| `runtime.process_timeouts` | `executor_ms,planner_ms,reviewer_ms` | `src/agents/config-schema.ts:112` |
| `security` | `injectionModel,injectionScanner,maxScanLengthBytes` | `src/agents/config-schema.ts:131` |
| `supervisor` | `` | `src/agents/config-schema.ts:215` |
| `telegram` | `allowedUserIds,botToken,notificationChatIds` | `src/agents/config-schema.ts:138` |
| `notifications` | `channels` | `src/agents/config-schema.ts:147` |
| `mcpServers.entry` | `args,autostart,command,disabled,env,transport,url` | `src/agents/config-schema.ts:186` |
<!-- saivage:config-schema:end -->
