# System Architecture

This document is the canonical architecture authority for Saivage v3. The current durable-format cutover is reset-only; old binaries, mixed formats, migrations, compatibility readers, bridges, and normalization paths are unsupported.

The supported runtime is Node.js 24 with npm `>=10 <12`, matching `package.json` engines and CI.

## 1. Ownership Model

The runtime is card-centered. The runtime alone dispatches work. Project and goal cards start with a planner; terminal card types start with an executor. Reviewer work is nested process-local planner work and is never a restart entry.

`CardActor` owns one live card activation. Its synchronous `open | claimed_result | claimed_cancel | claimed_stop` claim decides result, cancellation, and Stop ownership before any await. Role processors own terminal validation, record closure, accepted tool-result settlement, reviewer rework handoff, and executor cleanup; they return one final activation outcome and never publish terminal card lifecycle. `CardActor` is the sole non-cancellation outcome publisher and owns caller and activation-ownership finalization. The supervisor keeps one retained-actor map for process-local ownership and one exact-live-activation map for running cancellation resolution. A running card without exactly one live owner is impossible and fails fast; callers never fall back to direct cancellation.

Cancellation first revokes provider, tool, child, reviewer, process, and callback admission. The cached actor-local cancellation promise runs `finishCancellation()` as the exact winner boundary: it contains activation-owned processes and exact live descendants, directly publishes the cancelled card, and settles its caller once. For natural result or cancellation settlement outside closing, the actor synchronously delegates its own identity to the supervisor. The supervisor requires that exact actor in both maps and removes both entries; mismatch fails fast. This release means the completed activation no longer has live ownership or a retained runtime projection. It does not certify or wait for the detached micro-actor object to consume an already-queued cosmetic `settled` or `cancel` event. A later legitimate activation constructs a fresh `CardActor` and processor. Already-done descendants remain done. This is process-lifecycle authority and reference release, not a persistence lock, queue, transaction, generation, or currentness mechanism.

## 2. Card Identity And Discovery

Card identity is `project` or one-to-five opaque 28-letter lowercase hierarchical segments. Parent, depth, namespace, exact card/record streams, and fixed-role conversation paths are forward-derived. UI ordering uses positions and exposes `logical_path`; it never assigns identity meaning to a segment.

One non-root attempt asks its segment factory once and exclusively claims `.saivage/cards/project/children/<s1>/.../children/<sn>/`. Exact `brief.jsonl` and `card.jsonl` publication precedes one cumulative parent `children` append. Any failure ends the call without retry, follow-up read, rollback, reconciliation, cleanup, or effects.

Initial publication is closed `brief.jsonl` first and card version 1 in `card.jsonl` last, followed by one confirmed cumulative `children` append to the freshly reread parent. A normal reader derives the bounded root-to-target chain from the requested ID, validates each reached exact card stream and required exact brief stream, requires the next ID in the active parent's committed `children`, and only then touches the exact `children/<segment>` component. A terminal tombstone is the final row of `card.jsonl`: it makes that card absent from every card-domain detail/history/version/diff/record projection and terminates traversal before descendants. Direct exact-known conversation I/O remains a separate lifecycle-ungated path. Namespace-only, brief-only, temp-only, unlinked malformed, and arbitrary noncanonical entries are silent invisible orphans. They are never scanned for allocation, validated in aggregate, cleaned, warned about, adopted, quarantined, or repaired.

## 3. Direct File Persistence

Saivage-owned persistence is direct stateless synchronous file I/O by the domain or actor owner:

- `card-files.ts` owns exact `card.jsonl` reads, initial publication, append-only card versions/history, cumulative child links, and terminal tombstone rows.
- `authored-record-files.ts` owns exact append-only `brief.jsonl`, `status.jsonl`, and `review.jsonl` streams. The initial brief is closed logical version 1; status and review use their strict open/edit/terminal revision transitions.
- `conversation-file.ts` owns one stable append-only conversation per role session.
- `app-log.ts` owns strict event, error, unrelated control-action, provider-exchange, and content-review entries.
- `ResolvedConfigAuthority` owns selected YAML document reads, effective validation, and config mutation orchestration; `config-file.ts` owns canonical atomic replacement.
- `auth-profile-file.ts` and `project-identity.ts` own their single canonical files.
- `runtime/lock.ts` is the exceptional process-exclusion boundary only.

`CardService` performs operation-local rereads and invokes these direct functions. In autonomous execution, `CardActor` is the sole caller of terminal lifecycle commit for non-cancellation activation outcomes. The supported `setStatus('changed')` transition is the sole terminal-card reopening authority; there is no actor-owned reopening callback, terminal lifecycle repair, or admin-repair path. A disposable `CardIndex` may project one read, but it never authorizes a later write. There are no repositories, generic stores, persistence health latches, writer registries, queues, generations, transactions, repair orchestrators, or durable runtime owners.

Planner child admission exact-reads the linked target and each dependency in declared order. It never invokes list/tree/index APIs and retains no authorization state. Linked-tree operations start at the exact root and recursively follow committed `children`; their disposable projection validates active dependencies and sibling positions and is discarded with the call. Multi-root deletion uses that one fresh projection to form a subtree union, reject permissions and surviving dependents, and topologically order dependent-before-dependency plus child-before-parent tombstones. This graph is call-local write admission, not persistence coordination.

The common planner request order is an exact linked target read → exact dependency reads in declared order with `done` validation → `children.get()`. It never builds or scans a tree/index. `children.get()` may construct and register a `CardActor`, construct its processor, and call the idle processor actor's `start()`; that lifecycle initialization is not processor activation or provider execution. An admitted new activation continues with `running` status write → exact live-ownership claim → current-leaf transfer → `CardActor` running transition → processor activation/provider work. An admitted running join instead continues with `awaitSettlement()` and its parent `enterChild`/`resumeParent` relationship, without reactivation.

Dependency rejection precedes `children.get()`. It therefore prevents both request-caused lookup-time construction/idle start and every later new-activation or join effect. This guarantee is attributed only to the rejected request: it neither revokes an already-running actor's owner nor stops or freezes its processor/provider work, which may settle independently. The rule adds no scheduler, dependency traversal, status propagation, or cancellation behavior.

Every replacement and first JSONL publication calls `replaceFile`. It creates one fresh random UUID same-directory temp exactly once with `O_CREAT | O_EXCL | O_WRONLY`, writes and fsyncs it, renames over the target, and fsyncs the parent. A collision or other failure propagates. Crash-left temps remain ignored forever. The card-segment factory, publication-temp UUID factory, and invocation UUID generation are distinct identity scopes.

All file, directory, append, and lifecycle-lock creation uses ordinary Node defaults filtered only by the process umask. No mode argument, chmod/fchmod, permission probe, or repair exists.

Growing canonical JSONL files append one newline-terminated strict envelope with non-empty rows. An owning reader may truncate only an identifiable unterminated final suffix of that exact canonical file. Complete malformed data remains and fails.

## 4. Stable Sessions And Local Recovery

Stable sessions are exactly `analyst:global` plus planner/reviewer/executor identities whose suffix is a hierarchical card ID. The dependency-low shared identity module owns the literal and role-correlated schemas, types, and parser. `AgentMessage.session_id`, persistence, actor/source classification, generic Agent and chat contracts, `conversation_changed` payload/log schemas, live-sync frames, and web contracts consume that one authority. Card-role streams live at their card's fixed `conversations/<role>.jsonl`; the singleton Analyst stream is the fixed `.saivage/agents/conversations/analyst%3Aglobal.jsonl`. Direct known-session I/O derives the exact path and is not card-lifecycle-gated, so it remains available after tombstone. No session directory is claimed or enumerated. Project-wide inventory derives eligible role candidates from one fresh active linked-card projection, probes only those exact files, adds exact `analyst:global`, and discards the projection. `AnalystRuntime` owns at most one lazily created actor, and its operation boundary accepts no identity. There is no resolver, alias, safe-ID checker, identity cast, dynamic actor map, UI normalization, or external-chat package/config/composition surface.

Generic Agent successes are role-discriminated and preserve matching exact identities; conversation rows equal their enclosing identity and LLM-exchange success carries the selected `sessionId`. Raw Vue route input is parsed once through the shared parser before any detail component, store selection, REST call, or live-sync work. The exact union then flows through production props, API methods, stores, SyncClient maps, and subscription calls. Raw conversation frames are parsed before socket mutation or acknowledgement, and the same type flows from persistence through `ReadModelChanges`, `SyncHub`, and `LiveSyncSocket.invalidate`. The conversation publisher deliberately reparses even its typed message identity before emitting `conversation_changed`; the event registry validates the same union. `mapLiveSyncEvent` still does not map that event, avoiding a duplicate path: owner-driven read-model changes remain authoritative for conversation invalidation.

Each role, Analyst turn, compactor summary call, repair, and continuation uses a fresh opaque UUID `source_input_id` generated by its live owner. Tool identities derive only from the original source UUID `S` and provider tool-call ID `T`:

```text
${S}:tool-call:${T}
${S}:tool-result:${T}
```

The next provider UUID is unrelated. Provider attempt indexes order attempts within one invocation only. `ProviderConversationProjection.sourceSessionId` is the stable identity of the validated source conversation; `LlmInvocationInput.inputId` is the fresh identity of one logical provider call, and `LlmInvocationInput.sessionId` owns invocation logging and any newly persisted turn rows. For every ordinary persisted planner, reviewer, executor, or Analyst call, `LLMActor` requires invocation session equality with the projection source session before the pre-provider hook and requires it again on the hook result before turn-start append, candidate admission, or provider use. A mismatch fails without relabeling rows or either identity.

Round summarization is the explicit structural exception. Its dedicated provider path persists no invocation or completion rows to the actor conversation, so the synthetic `summary:<round>` invocation label and fresh input UUID remain distinct from the stable actor source session carried by the projection and its rows. Merge summarization renders ordered summaries directly into provider input under the non-conversation `summary:merge` invocation/evidence label; it does not construct an `AgentMessage` or weaken the durable conversation grammar.

On restart or Stop→Run, the session owner validates and locally settles the latest conversation round. One unmatched call in an interrupted latest round receives a provider-visible failed `tool_result` with `outcome_unknown:true`, followed by a truthful recovery notice in a fresh activation. This durable-log settlement does not reconstruct an actor or continue a provider call. Multiple, older-round, malformed, or cleanly-closed unmatched combinations fail. Cards and records never infer whether an interrupted external effect succeeded.

## 5. Notifications And Terminal Arbitration

Notifications persist only in the target card's ordered `pending_notifications`. The durable request identifies one `card_id`; no role/session recipient or session-delivery result exists. `backlog`, `changed`, `running`, and `blocked` preserve pending context. Only `done`, `failed`, and `cancelled` clear and reject it with `terminal_card`.

Planner and executor session owners drain pending context at provider safe points by appending ordered notification rows and then removing those exact IDs from the card without an await. Append-before-remove intentionally permits duplicate context after interruption.

Immediately before planner/executor terminal acceptance, one no-await reread chooses:

1. no pending context: record close → accepted terminal-tool settlement → processor return; or
2. pending context: paired failed `emit_result` → ordered notification rows → exact card removal, followed by another model round.

The executor's invocation-surface cleanup runs after accepted terminal handling but before its processor outcome is final. A cleanup exception therefore replaces the accepted candidate with one failed processor outcome. Only after the processor has selected and returned that final outcome does `CardActor` publish the card lifecycle, so accepted terminal handlers cannot publish an earlier contradictory state.

Reviewer never drains the queue. Before accepting `done`, `blocked`, `failed`, or `rework`, it recomputes semantic currentness and rereads pending context. Pending context wins: discard the open review first, append the paired defer failure second, transition nothing, and return to planner. Stale-without-pending similarly discards before its failed stale result and refreshed context. Every fresh reviewer activation unconditionally discards an existing open review before its activation marker. There is no reviewer round limit.

Accepted reviewer rework has one processor-owned handoff in this order: close the accepted `review.md` → settle the reviewer terminal result → strictly read the just-closed review URL and append one canonical user-text row to `planner:<card-id>` through the conversation owner → begin the next planner activation and ordinary provider projection. The row contains that exact closed review URL and the accepted reviewer summary. A strict review read or conversation append failure propagates and prevents the next planner admission; there is no notification, transient prompt path, or alternate handoff owner.

## 6. Runtime Controls

Runtime lifecycle is process-local. Startup is stopped. An installed instance is starting, running, pausing, paused, or closing. Pause uses one boolean and at most one parked frontier; admitted synchronous settlement may finish, but no fresh provider/tool/process/child/reviewer admission begins until Resume.

The operation-specific REST contracts are distinct: Pause, Resume, and `stop_project` declare no request body, while `restart_server` declares the strict exact `{confirmation:'RESTART SERVER'}` body. The three bodyless handlers inspect the raw request first and locally return their declared 400 validation envelope for every defined body before invoking runtime control; this is not a shared `ContractRuntime` parser policy. Clients emit JSON `Content-Type` only with an actually serialized JSON body. Authentication and ordinary headers remain independent, so bodyless Stop retains them without advertising JSON.

Run validates the unique contiguous project-rooted running chain and installs its complete ownership in both supervisor maps before admission. Every owner is a fresh process-local `CardActor`; the micro-actor lifecycle has only initial-state `start()` and no recover or rehydrate entrypoint. Every ancestor holds only an immediate-child `structural_wait`; only the deepest owner creates a processor and starts planner/executor by card type. For a non-cancellation outcome, `CardActor` synchronously performs one durable publication, finalizes activation fields and queues `settled`, invokes the supervisor's identity-checked natural release from both maps outside closing, and only then resolves the deferred caller. Parent continuation therefore observes both canonical publication and exact ownership release. Queued actor-state consumption is presentation cleanup rather than domain authority, so this ordering adds no state-entry hook, state-machine wait, or cancellation redesign.

A throw from replacement or a synchronous post-publication callback leaves canonical visibility outcome-unknown. `CardActor` fails in place without retry, reread, reconciliation, further lifecycle write, deferred caller settlement, or natural release, even if a later observer can see the terminal version. A later Stop may contain the claimed result and aggregate-clear process-local ownership without inferring or reporting a durable outcome.

`stop_project` is restartable non-domain containment, never cancellation. It closes global continuation/admission and freezes both complete ownership maps before first-claim classification. Open owners receive one identity-preserved `RuntimeStoppedInterruption`, use aborting tracker revocation, and preserve durable `running` state. Result winners are not reclaimed or aborted: Stop non-abortively closes processor-operation and LLM-invocation admission with that same interruption, permits already-admitted winner delivery, cleanup, and `CardActor` publication to finish, then joins the closed trackers and suppresses later continuation. A cancellation winner is likewise not reclaimed or aborted: Stop starts or joins its cached actor-local cancellation promise and waits for `finishCancellation()` to publish `cancelled` and settle its caller. While the runtime is closing, result and cancellation settlement do not invoke natural release and leave both ownership entries installed for the supervisor. LLM, processor, card, structural-parent, child-tool, and root catches rethrow the exact Stop interruption rather than mapping it to domain failure. Cancellation-settlement, cleanup, and process failures side-report to one Stop-local collector and cannot replace a committed winner. Only after every owner settlement succeeds does the supervisor atomically clear both frozen maps and the current instance; this aggregate clear is separate from per-actor natural release. Otherwise one `RuntimeContainmentError` leaves both full closed maps and the runtime closing. Stop itself writes no card/root outcome or event.

The negative terminal call graph is explicit: `App.stop()`/signals/startup failure/acknowledged restart → sole App terminal coordinator → flat admission closers and cleanup leaves; no edge reaches `stopProject`, cancellation, `RuntimeContainmentError`, or the Stop collector. The coordinator tries every closer synchronously before its first await, then sequentially settles reverse-registration-order leaves through one referenced ten-second bound. Rejection/timeout records only fixed allowlisted component+code data and never skips later leaves. Direct `App.stop()` returns an immutable `ShutdownReport` and does not log; process-boundary adapters log fixed warnings and preserve exit/restart/original-error behavior.

Process cleanup has one `ProcessRunner` and one registry with sibling `runtimeRootScope`, `analystRootScope`, and `mcpRootScope`. The registry owns child-event safety immediately when platform spawn returns and attaches its mandatory `error` listener before inspecting the leader PID. It admits a group only with a positive leader PID; after admission, `ProcessRunner` owns output and user-facing process presentation. A rejected child can therefore emit its asynchronous OS launch error without escaping the already-handled launch failure. For stdio MCP children, stdout remains the protocol channel; the MCP runtime continuously drains and discards child stderr for the child's lifetime. Stderr content is neither retained nor exposed, and the existing empty process-log placeholder remains unchanged. The sole runtime, Analyst, and MCP leaves each perform `close/revoke → one asserted owned-root termination call → initiate/continue joins → combined settlement`; termination starts before any await, so a hanging join cannot postpone it. A nonempty fulfilled `ProcessStopReport.failed` rejects the leaf. A timed-out component can continue only under its own root while later disjoint-root leaves proceed. Project Stop and App runtime cleanup may overlap on the runtime root, tolerating repeated signals and already-exited/missing/removal observations without locks, deduplication, shared promises, registry-wide drains, or collector sharing. LiveSync and Fastify are independent leaves; Fastify close does not dispose LiveSync.

The process tool passes each `run_command` command unchanged as one `bash -c` argument. Its cwd boundary classifies scoped-looking values before filesystem resolution: canonical project and system roots/descendants are accepted, ordinary relative paths remain project-contained, and malformed, unknown, or non-cwd scoped schemes fail before spawn.

## 7. Lifecycle Lock And CLI Delegation

Read-only lock classification is `missing | live | dead | indeterminate | malformed`. Live requires a valid record plus matching process-start identity. Dead requires positive proof. Permission denial, unavailable process identity, and observation races are indeterminate. No classification authorizes lock removal or takeover.

`src/boot/app.ts` owns server startup ordering. It derives only canonical project root and `--create-runtime` intent before acquiring the exact lifecycle lock, because exclusion must precede startup publication. Inside the existing terminal-cleanup boundary it then loads and fully validates the selected config/environment. Only a valid environment may enter the optional canonical root-card read/cards-directory/initial-publication branch, then server start and control-endpoint publication. A load failure uses ordinary terminal cleanup to release the lock and rethrows; it performs no generated card read or mutation.

CLI status, pause, resume, stop, and restart delegate only for a verified live record and only through its published non-null `control_endpoint.origin` and `control_endpoint.auth`. A null endpoint fails exactly `active lifecycle owner; runtime control unavailable`; no phase is inferred.

- missing/dead status reports stopped;
- missing/dead stop succeeds with `contained:false`;
- missing/dead pause/resume fails no-live;
- dead also reports manual abandoned-lock repair;
- indeterminate/malformed fails closed.

The shared operator HTTP client appends only canonical operation paths. It sends bodyless Pause, Resume, and Stop requests without JSON `Content-Type`, while confirmed Restart carries its exact JSON body and content type. It never rediscovers YAML, flags, host/port environment, defaults, runtime files, or current process config. Published disabled auth omits Authorization; published bearer requires `SAIVAGE_API_TOKEN` and sends it only in a header. Connection, authentication, response, or schema failure has no fallback.

## Conversation Compaction

Compaction is context construction by the stable session owner over immutable non-compaction source rows. Its owner inputs are `ConversationFileContext.projectRoot` and `LlmInvocationInput.sessionId`; `compact()` binds them once, reads that canonical conversation, constructs the metadata row with that session, and appends through the same context. `appendConversationBatch()` derives the destination from the context root and row session and publishes through `ConversationFileContext.changes`. The removed explicit root/session aliases formerly controlled both the durable read and append while `ConversationFileContext` supplied publication; there was no split durable read/write path, but disagreement could misassociate the operation with the publication owner.

The appended strict system `context_compaction` row contains canonical JSON with one ordered `summaries` array. At most one `merged` group occurs first; every later `individual` group owns one round. Round descriptors own ordered `initial`/`repair` segments, and their non-empty `source_message_ids` arrays are the only persisted covered-source identity. Completeness, summary prose, recoverable evidence, and one source hash per group remain. Round labels are derived from activation-marker source rows, repair anchors from the first source ID of repair segments, cutoff from the final covered source row, and rendered context from validated groups; none is separately persisted.

`readConversation()` performs the sole direct synchronous conversation read and returns an ephemeral source-identified `ValidatedConversation`. Its one left-to-right source-aware boundary validates every complete metadata row against only source rows physically preceding that row, including canonical contiguous order, exact complete/final-partial round extent, classifier-derived segmentation, hashes, retained static rows, and boundary. Every physical row must belong to the requested stable source session; missing files return a validated empty conversation carrying that identity. Prospective append candidates pass through the same boundary over existing plus candidate rows; the derivation is neither persisted nor retained to authorize a later write.

`conversation-session.ts` is the sole owner of provider conversation projection. From one validated conversation it selects only the physically latest validated compaction, emits one derived synthetic system-context row, eligible retained static rows, and the eligible uncovered source suffix. It emits no physical compaction metadata, older rendered context, or compacted-away source row to either provider or summarizer input. Eligible OpenAI Responses private/visible bundles in the uncovered suffix remain paired and ordered. Every projected row must exactly match the projection source session; Responses additionally requires exactly one private row and one marked visible row per source input with exact mutual IDs. Wrong-session, missing, duplicate, or mismatched pairs fail before transport without filtering, relabeling, remapping, or normalization.

`llm-failure-classifiers.ts` owns one transport-independent HTTP dispatcher for input-context evidence. Chat, public Responses, and Codex gateways call it before their provider-specific generic failures. It accepts only exact direct structured code/type/param markers in eligible parsed HTTP 400 objects; Responses also classifies its exact failed terminal object, and the Codex parser classifies its exact `error` and `response.failed` stream events. Message text and nested/recursive search never authorize replay. Output exhaustion is the separate `output_token_limit_exceeded` kind. Codex passes the status of the successfully opened HTTP response into stream parsing, so an event-classified `input_context_exhausted` remains typed context evidence while its exchange truthfully records the opened status, normally 200. The similarly named durable lifecycle blocker vocabulary is outside this transport taxonomy.

The strict schema admits only one complete compaction mode: literal `enabled: true`, positive budget, and a structured exact summarizer candidate. It also rejects an effective Analyst output request (`analyst`, then `default`, then hard default 4096) greater than `floor(input_budget_tokens * completion_reserve_fraction)`. `ProviderRegistry` projects implicit account identity by object identity and preserves every explicit account name and slash-bearing model verbatim. Immediately after Registry construction, `createRuntimeApplication()` validates candidate membership exactly once. It retains candidate identity only in one fixed-element summarizer closure, while both runtime and Analyst receive the same identity-free numeric/fraction/snap policy, compactor port, and fixed summarizer provider. Analyst primary/continuation invocation remains the distinct ordinary role-routed provider port. `PreparedCompaction`, compactor calls, summarizer prompts, and episode context carry no candidate/model label.

Each new autonomous activation builds its exact prompt and ordered tool surface once. Each Analyst submission resolves its role surface and builds its exact ordered tools and rendered prompt, including current project context, then calls `prepareCompaction()` with the configured Analyst output request before any marker/source append. Reserved completion determines hard capacity; requested completion is the exact provider output authority and may not exceed it. Preparation rejects invalid fractions, completion, widths, static trigger capacity, or hard capacity before conversation, summarizer, router, provider, or tool I/O. The singular `ConversationLLMActor.turn()` accepts prepared input for planner, reviewer, executor, and Analyst persisted calls and rejects stale/cast unprepared input before transition or persistence. Direct summarization is the explicit unprepared, nonpersisting exception: it uses the one Registry-validated candidate, fixed 2000-token no-tools prose request, distinct evidence identities, and no self-compaction or replay.

Process-local availability compares structured candidate triples directly. `/api/providers` has one Registry-backed projection with ordered `{ candidate, state, reason?, untilMs? }` entries; route composition requires that read model and has no config-derived fallback or account-only list. A running server has no disabled status because invalid compaction cannot boot. `init` and `start --create-runtime` do not generate provider/model/compaction configuration.

Analyst source classification is session-aware and current-format-only. Every round begins with the exact activity payload `{event:'activation_open',role:'analyst',input_id,timestamp}` and no `card_id`; no preamble is permitted. Ordinary ingress appends `[marker, workspace-context system text, operator user text]` in one physical batch, publishes each change, rereads the canonical session once, and creates the sole source-identified provider projection before preventive compaction and turn-start evidence. Confirmed restart uses `[marker, user confirmation]` and never enters preparation, compaction, or provider I/O. A next valid marker closes the preceding round; the newest remains open/verbatim under ordinary bands. Unmarked, malformed, wrong-role, or mixed Analyst histories fail every strict read without inference or compatibility classification.

Normal and escalated partitions measure newest-relative completed-round tail and middle windows backward from the newest completed round. The current round stays verbatim in normal operation. Canonical segment source IDs and raw-row hashes remain authority; the derived cutoff advances monotonically. Hard fallback runs only for residual oversize after whole-round partitioning and never splits tool pairs, Responses bundles, static units, or an open call.

The compactor requires either `preventive` or `authoritative_context_recovery` strategy and returns `compacted` or, only for authoritative recovery, clean `no_smaller_projection`. Preventive selection keeps normal → escalated → hard fallback. Authoritative recovery starts at escalated and may use safe hard fallback, but accepts only a valid provider projection strictly smaller than the rejected one. Candidate construction and prospective validation precede the singular append; `compacted` means exactly one canonical row was appended. No-smaller means no append. Summary construction and append have narrow typed error boundaries, while source/candidate validation, returned projection/source mismatch, and cancellation preserve their own identities; append uncertainty is never reread, retried, repaired, or converted to no-smaller.

Classification computes each source row's existing visible-message estimate once and one aggregate per round; band partitioning and retained-suffix sizing reuse those values. Newly rendered summary context is estimated per distinct candidate, and normal, escalated, and safe hard-fallback candidates are each fit-tested at most once. The strict durable policy stores only mode, selected band, input budget, canonical static estimate, trigger and completion fractions, selected merge and summary fractions, and snap. Completion, hard ceiling, trigger line/threshold, and tail/middle budgets remain exact ephemeral derivations.

All transports consume that one ordered projection and perform transport-only wire mapping. Chat and Codex omit provider-private rows; Responses maps the same projection into instructions and input while enforcing source-session and private/visible pairing. Transport code cannot request physical durable history or independently render compaction metadata.

Actor compaction weighting and provider wire admission are distinct contracts. Compactor message estimates use visible row content plus structural characters, with `provider_private` fixed at zero actor weight while the marked visible row is counted and its bundle remains indivisible; rendered-context estimates use UTF-8 bytes; rejection diagnostics retain their independent final-section character estimates. For each provider candidate, the actual request builder maps the projection once, canonicalizes the complete protocol body once, estimates `ceil(UTF8 bytes / 4)`, and hashes those exact bytes. This deterministic best-effort heuristic may skip obvious oversize but is not a fit proof. Admission, retries, and the final transport send reuse that exact serialized body without rebuilding or normalizing it, so Responses wire admission includes private output bytes present in the sent body. Prepared persisted requests prohibit ordinary `modelParams.maxTokens`; Invocation Service uses only prepared requested-completion tokens for candidate admission and options. Chat emits `max_tokens`, public Responses emits `max_output_tokens`, and Codex emits neither while retaining admission/options authority.

Invocation Service owns one ordinary route pass and keeps existing admission skips and non-context retry/failover behavior. The singular prepared `ConversationLLMActor` retains turn-start append, source consumption, completion persistence, output, state, tool delivery, preventive compaction, and bounded recovery for planner/reviewer/executor/Analyst turns; its provider-call hook is the only recovery seam. An eligible first-pass `input_context_exhausted` must occur before accepted completion/output or completion-persistence entry. The rejection ends pass one, the actor consumes its sole allowance, and successful forced compaction precedes exactly one fresh ordinary pass. The second call keeps the same input/source identity, prompt, tools, prepared capacity, temperature, episode context, and ordinary route behavior; only the provider projection changes, and marker/ingress/result rows are not re-appended. The actor combines and contiguously reindexes both passes' exchanges under that identity before singular success/final-failure persistence. A second context rejection or any pass-two failure is final; there is no third pass or candidate-route × compaction loop.

For Analyst continuations, the actor first settles the waiting call, appends exactly one tool result, allocates a fresh continuation UUID, and rereads canonical history while retaining the submission's prepared object. Preventive compaction then runs before the continuation provider call. The accepted tool invocation, external/domain effect, activity broadcast, and persisted result are outside the provider retry seam; a context rejection retries only that same continuation input and never replays the tool, rebroadcasts it, or duplicates its result or source ingress. Restart-confirmation settlement remains terminal and model-free.

Clean no-smaller and non-cancelled typed summary-construction failure are normal final actor error outcomes: pass-one exchanges attach to one final model issue and no provider retry occurs. Validation/projection-identity, summary-exchange publication, and append failures are fatal local outcomes with no later triggering-input projection or conversation write; cancellation remains cancellation without a model issue. If cancellation follows a successful append, the one canonical row remains. `compaction/summarizer.ts` separately owns summary-attempt evidence: each round/merge call has a `summary:<round-id>`/`summary:merge` session and fresh input UUID, projects settled attempts exactly once through `InvocationService.projectProviderExchanges()` with empty assistant output IDs, and never merges them into the triggering input. Projection failure is outcome-unknown and is not retried. Only these direct summarizers remain unprepared and without last-chance recovery.

This design adds no operator activity phase or live `compacting` status. Operator surfaces can expose the durable canonical row and existing final success/failure projections only; truthful live activity semantics remain a separate design problem.

## 9. Availability And Credentials

Candidate availability is one process-local map that resets on process restart. Provider completion checks the exact invocation signal before changing it. No availability file, replay, restabilization, or persistence-health dependency exists.

Auth profiles use direct strict whole-file reads and optimistic replacement. Exact-path `ENOENT` alone means absence. OAuth refresh threads the original invocation abort signal through gateway, transport, resolver, and refresh implementation; it checks after response/body awaits and immediately before the synchronous latest-file reread and replacement. Concurrent refresh is accepted last-completed-write-wins behavior with no revision, CAS, lock, or merge protocol.

## 10. API And UI Projection

REST and WebSocket are projection/transport surfaces. REST remains authoritative; WebSocket carries lossy freshness hints. Runtime, readiness, and debug responses contain no persistence-health component or durable runtime/snapshot file. Provider views label availability as process-local. Card routes and links preserve immutable hierarchical card identity while displaying title and mutable `logical_path` hierarchy labels.

Runtime freshness publication follows direct synchronous mutation ownership. `CardService` invokes card and runtime changes, in that order, after successful create and delete publication; after an actual update it invokes runtime change only when the already-pruned patch owns changed `status` and/or `type`. This complete create/delete/status/type set is the minimal correction required by the existing all-card runtime index (`total`, `byStatus`, and `byType`), not a generic all-card-write rule or an unrelated card audit. Non-index card edits remain runtime-silent while retaining their card change hint.

Actor-only owners synchronously report post-mutation lifecycle/run-identity boundaries, every retained-card insertion (including an initial-chain prefix that survives later launch failure), retained-card release, active-leaf changes, retained-agent membership, and autonomous-agent public phase changes through the supervisor's single translation callback. `ActiveCardLeaf` is the sole current-card source. Launch reports the complete supervisor-owned running boundary before actor construction, reports each retained insertion at its `Map.set`, and installs/reports the active leaf only after running ownership installation and validation complete. Mutations that remain visible after a later synchronous throw have therefore already supplied a freshness hint.

The singular `ReadModelChanges` broadcaster feeds `SyncHub`; `SyncHub` alone debounces and coalesces successful owner hints before `LiveSyncSocket` sends canonical invalidation frames. Clients treat those frames as lossy prompts and refetch authoritative REST state. There is no owner-side suppression, polling, queue, generation, acknowledgement, replay, or alternate publication path.

In the web dependency direction, the runtime, card, and agent Pinia stores are the separate canonical owners of runtime/status, card, and agent-list/conversation/exchange resources. Application bootstrap performs their unfiltered initial REST reads and registers exactly one live-sync refetch target per core family; routes and Debug consume those owners instead of refetching or copying their rows. Debug's State presentation composes the runtime, card, and agent stores backed by `/api/state`, `/api/runtime/status`, `/api/cards`, and `/api/agents`. DebugStore owns only diagnostic errors, timeline, processes, doctor, and supervision; there is no duplicate runtime/card aggregate boundary.

For Cards specifically, one CardStore owns the canonical collection, keyed detail, and history data with independent operation state for each resource. Keyed-detail requests mutate only selected-detail loading/error state; they do not mutate collection loading/error, replace the canonical collection, or assume selection ownership. The router alone owns selected presentation identity. `CardsView` passes the exact route card ID into the tree; the tree computes and discards the route-selected ancestor set used for render reveal. No store field, watcher, event bus, selection synchronization, or resize coordinator shares that responsibility. The layout chain is the bounded workspace stack → flex-column workspace content → optional non-growing auth banner → remaining-space route host → contained Cards route → existing inspector panes. The route host is the normal page scroller for other routes; Cards suppresses combined overflow and delegates vertical overflow to its existing tree and detail pane owners without fixed viewport heights or JavaScript sizing.

DebugAgentDetail and the primary Agents conversation/raw-exchange components are keyed presentation lifetimes over AgentStore, not data owners or a consumer registry. A mounted conversation claims one fresh opaque current-consumer token, disposes its live subscription before token-guarded clear, and invalidates its request when the key or route departs; subscribe precedes fetch so initial loading cannot miss an invalidation. Exchange selection uses an independent token and abort boundary. Token identity and request epochs reject stale callbacks, completion, `finally`, and delayed cleanup, including replacement by the same session ID.

The Files read model maps canonical `work:///` to the `.saivage/work` directory root and emits canonical descendant URLs. The process API remains narrower: stdout/stderr fields require a concrete card-owned or non-card process-log URL and reject the root.

The UI exposes one **Stop project** action and a distinct confirmed **Restart server** action only when required `restart_server_available` is true. It never optimistically writes a running card as cancelled. Raw conversation views retain canonical compaction JSON; rendered views show its single synthetic system context.

## 11. Reset And Failure Model

Durable-format changes require stopping the service, running the current built reset, and then starting the current binary. The ordered summary-group payload, minimal strict `applied_policy`, and marker-first/no-preamble Analyst source contract are such cutovers: old generated rows and pre-marker or mixed Analyst histories fail strict reads, and there is no migration, marker backfill, compatibility classifier/renderer, format probe, or mixed-version operation. `resetOwnedGeneratedRoots()` in `src/persistence/layout.ts` is the singular reset ownership contract: `.saivage/cards`, `.saivage/agents`, `.saivage/logs`, and `.saivage/work`. These generated roots are removed as whole trees without descendant inspection. Durable configuration and operator inputs under `.saivage`, including identity, credentials, prompt overrides, skills, and instructions, remain outside that ownership boundary, as do source and canonical documents.

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
| `GET /api/files` | Workspace listing. | `src/contracts/operator-api-files-debug.ts:46` |
| `GET /api/files/content` | Workspace content. | `src/contracts/operator-api-files-debug.ts:57` |
| `GET /api/mcp/status` | MCP status. | `src/contracts/operator-api-mcp.ts:72` |
| `GET /api/mcp/tools` | MCP tools. | `src/contracts/operator-api-mcp.ts:82` |
| `GET /api/processes` | Process list. | `src/contracts/operator-api-processes.ts:71` |
| `GET /api/processes/:id` | Process detail. | `src/contracts/operator-api-processes.ts:81` |
| `GET /health` | Liveness. | `src/contracts/operator-api-runtime-cards.ts:137` |
| `GET /health/ready` | Readiness. | `src/contracts/operator-api-runtime-cards.ts:148` |
| `GET /api/state` | Operator runtime state. | `src/contracts/operator-api-runtime-cards.ts:159` |
| `GET /api/cards` | Card list. | `src/contracts/operator-api-runtime-cards.ts:169` |
| `GET /api/cards/:id` | Card detail. | `src/contracts/operator-api-runtime-cards.ts:179` |
| `GET /api/cards/:id/history` | Card history. | `src/contracts/operator-api-runtime-cards.ts:191` |
| `GET /api/cards/:id/history/:seq` | Card history entry. | `src/contracts/operator-api-runtime-cards.ts:202` |
| `GET /api/cards/:id/diff` | Card diff. | `src/contracts/operator-api-runtime-cards.ts:213` |
| `GET /api/runtime/status` | Runtime status. | `src/contracts/operator-api-runtime-cards.ts:225` |
| `POST /api/runtime/pause` | Bodyless Pause project work. | `src/contracts/operator-api-runtime-cards.ts:235` |
| `POST /api/runtime/resume` | Bodyless Resume project work. | `src/contracts/operator-api-runtime-cards.ts:245` |
| `POST /api/runtime/stop-project` | Bodyless Stop project containment. | `src/contracts/operator-api-runtime-cards.ts:255` |
| `POST /api/runtime/restart-server` | Strict-confirmation authenticated server restart. | `src/contracts/operator-api-runtime-cards.ts:265` |
| `GET /api/runtime/card-runs` | Current card-run projection. | `src/contracts/operator-api-runtime-cards.ts:276` |
<!-- saivage:operator-routes:end -->

### Internal debug routes

<!-- saivage:internal-debug-routes:start -->
| Route | Purpose | Source |
|---|---|---|
| `GET /api/debug/doctor` | Internal card diagnostic. | `src/server/routes/chats-files-debug.ts:16` |
| `GET /api/debug/errors` | Internal error projection. | `src/contracts/operator-api-files-debug.ts:68` |
| `GET /api/debug/supervision` | Internal supervision projection. | `src/server/routes/chats-files-debug.ts:37` |
| `GET /api/debug/timeline` | Internal timeline projection. | `src/contracts/operator-api-files-debug.ts:78` |
<!-- saivage:internal-debug-routes:end -->

### Agent tools

The inventory lists every tool that each runtime role can potentially be offered by its composed providers and, for autonomous roles, terminal contract. Conditional gates still apply: in particular, Analyst `restart_server` is offered only when restart is available and destructive authorization allows it.

<!-- saivage:agent-tools:start -->
| Role | Tools | Source |
|---|---|---|
| `planner` | `activate_card,cancel_card,create_card,diff_card,edit,edit_card,emit_result,get_card,get_card_history_entry,get_tree,glob,grep,list_card_history,list_cards,queue_notification,read,reorder_child,webfetch,websearch,write` | `src/tools/role-invocation-surfaces.ts:40` |
| `executor` | `apply_patch,diff_card,edit,emit_result,get_card_history_entry,glob,grep,kill_process,list_card_history,mcp_tool_call,read,run_command,skill,wait_process,webfetch,websearch,write` | `src/tools/role-invocation-surfaces.ts:42` |
| `reviewer` | `diff_card,edit,emit_result,get_card_history_entry,glob,grep,list_card_history,mcp_tool_call,read,skill,webfetch,websearch,write` | `src/tools/role-invocation-surfaces.ts:41` |
| `analyst` | `apply_patch,cancel_card,create_card,delete_card,diff_card,edit,get_card,get_card_history_entry,get_status,get_tree,glob,grep,kill_process,list_agent_sessions,list_card_history,list_cards,list_processes_tool,mcp_reconcile,mcp_tool_call,navigate_back,navigate_workspace,pause_runtime,queue_notification,read,read_agent_session,read_control_actions,read_runtime_errors,read_runtime_events,reconfigure,reorder_child,restart_server,resume_runtime,run_command,show_config,skill,start_project,stop_project,wait_process,webfetch,websearch,write` | `src/tools/role-invocation-surfaces.ts:43` |
<!-- saivage:agent-tools:end -->

### Config schema

Each row is one reachable fixed-field object occurrence rooted at `saivageConfigSchema`. Record value occurrences use `.entry`; reused schemas appear at every occurrence path.

<!-- saivage:config-schema:start -->
| Section | Fields | Source |
|---|---|---|
| `top-level` | `compaction,mcpServers,models,providers,runtime,security,server` | `src/agents/config-schema.ts:182` |
| `models` | `default,equivalents,failover,max_tokens,profiles,routing,temperature` | `src/agents/config-schema.ts:36` |
| `models.profiles.entry` | `allowed,preferred` | `src/agents/config-schema.ts:15` |
| `providers.entry` | `accounts,apiKey,authProfile,baseUrl,capabilities,modelCapabilities,models,priority` | `src/agents/config-schema.ts:94` |
| `providers.entry.capabilities` | `contextWindowTokens,exclusiveToolChoiceSupport,maxOutputTokens,quirks,responsesReasoning,streaming,toolsMode,transportProtocol` | `src/agents/config-schema.ts:72` |
| `providers.entry.capabilities.responsesReasoning` | `effort` | `src/agents/config-schema.ts:77` |
| `providers.entry.modelCapabilities.entry` | `contextWindowTokens,exclusiveToolChoiceSupport,maxOutputTokens,quirks,responsesReasoning,streaming,toolsMode,transportProtocol` | `src/agents/config-schema.ts:72` |
| `providers.entry.modelCapabilities.entry.responsesReasoning` | `effort` | `src/agents/config-schema.ts:77` |
| `providers.entry.accounts.entry` | `apiKey,authProfile,baseUrl,capabilities,models,priority` | `src/agents/config-schema.ts:84` |
| `providers.entry.accounts.entry.capabilities` | `contextWindowTokens,exclusiveToolChoiceSupport,maxOutputTokens,quirks,responsesReasoning,streaming,toolsMode,transportProtocol` | `src/agents/config-schema.ts:72` |
| `providers.entry.accounts.entry.capabilities.responsesReasoning` | `effort` | `src/agents/config-schema.ts:77` |
| `server` | `host,port` | `src/agents/config-schema.ts:106` |
| `runtime` | `continuous_improvement,process_timeouts` | `src/agents/config-schema.ts:118` |
| `runtime.process_timeouts` | `executor_ms,planner_ms,reviewer_ms` | `src/agents/config-schema.ts:112` |
| `security` | `injectionModel,injectionScanner,maxScanLengthBytes` | `src/agents/config-schema.ts:131` |
| `compaction` | `completion_reserve_fraction,enabled,escalate_merge_line_fraction,escalate_summary_line_fraction,input_budget_tokens,merge_line_fraction,snap,summarizer_candidate,summary_line_fraction,trigger_fraction` | `src/agents/config-schema.ts:143` |
| `compaction.summarizer_candidate` | `account,model,provider` | `src/agents/config-schema.ts:137` |
| `mcpServers.entry` | `args,autostart,command,disabled,env,transport,url` | `src/agents/config-schema.ts:179` |
<!-- saivage:config-schema:end -->
