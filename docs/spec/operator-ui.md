# Operator UI Specification

Tombstoned cards are absent from all existing card, tree, history, exact-version, diff, record, conversation, and recovery projections and return the same not-found contract as an unknown id. The UI has no deleted-card state, retained-evidence browser, restore action, or forensic view.

Direct persistence operations fail at their owning request and do not poison unrelated later mutations through a persistence-health latch. Provider-routing availability is explicitly live process-local state and resets after process restart; the UI must not present it as historical or durable. Auth-profile refresh uses strict direct file reads and optimistic complete replacement, with concurrent last-completed-write-wins risk left to operator retry. Returned `work:///tmp/stash/...` URLs retain their existing presentation but refer to disposable work output with no retention guarantee.

Status: current functional UI authority.

Last updated: 2026-07-17.

## 1. Purpose

The operator UI shows Saivage state and hosts the Analyst. It is projection-oriented and Analyst-mediated by default, with the Dashboard's direct **Stop project** and bearer-only, capability-gated, exactly confirmed **Restart server** actions as the two runtime-control exceptions.

The UI must help the user understand what the autonomous runtime is doing, inspect cards, record-backed card documents, files, and processes, and stay oriented during Analyst conversations. Ordinary mutations still go through the Analyst.

## 2. Layout

At typical desktop widths, ordinary workspace routes display a single screen with two always-visible regions:

- A left workspace area, roughly 70-80% of the viewport.
- A right Analyst panel, roughly 20-30% of the viewport.

On those routes, the Analyst panel contains the current Analyst session, chat history, and composer. It is not a drawer, modal, popover, slide-over, or hidden panel. At desktop widths there is no control whose job is to open, close, hide, reveal, expand-to-full-screen, or toggle the Analyst panel.

At narrow widths on ordinary workspace routes, the shell collapses to a single column and exposes a presentation-only `Workspace` / `Analyst` pane switch so the user can choose which region is visible. The switch changes only the local layout; it does not mutate server state and does not turn the Analyst into a modal or separate control surface.

On ordinary workspace routes, the current project name is shown in a slim header at the top of the Analyst panel only, occupying the top of the Analyst column rather than a full-width page bar.

The one layout exception is the canonical Agents detail route for the exact session `analyst:global`. On that route, the workspace hosts the read-only Analyst conversation-inspection component, which may show loading, unauthorized, error, empty, or loaded-conversation state and has no chat composer. To avoid duplicating that conversation surface, the shell omits the persistent Analyst panel, including its project-name header and composer, and omits the narrow `Analyst` pane switch. Navigating to any other route, including another agent's detail, restores the persistent panel/composer surface without guaranteeing loaded transcript data, authorization, or writable sending.

## 3. Workspace Area

The workspace area renders read-only projections of runtime state, including:

- cards and card detail assembled from the `get_card` read model;
- distinct structured card state, card `working_status`, accepted `result`, versioned card document records such as `brief.md`, `status.md`, and `review.md`, specialized result fields, and card/record history when available;
- card tree/board/list views;
- runtime dashboard/state;
- agent sessions and transcripts;
- files and file previews;
- processes and process output;
- runtime events, errors, debug views, and control-action audit records;
- configuration projections where appropriate.

These projections combine strict card/conversation reads with process-local runtime state. There is no persisted runtime-state, actor-snapshot, recovery-diagnostic, role cursor, or conversation-version authority.

The web client has one owner for each separate core resource family: the runtime store owns `/api/state` together with `/api/runtime/status`, the card store owns `/api/cards` and keyed card detail/history, and the agent store owns `/api/agents`, selected conversations, and selected LLM exchanges. Debug's State presentation is composed from those runtime, card, and agent stores backed by `/api/state`, `/api/runtime/status`, `/api/cards`, and `/api/agents`; it has no duplicate aggregate owner. Application bootstrap starts the three unfiltered owner reads independently of WebSocket availability and repeats those owner reads on token change. Routes consume the resulting state and do not issue another unfiltered initial read; explicit Refresh controls and keyed detail reads remain. Live invalidations target those same owners and never synchronize copied Debug rows.

The runtime dashboard is current-state-only. It shows process-local runtime status and active card without a runtime-state file, command/run ledger, control audit, actor snapshot, or offline mutation. It exposes one **Stop project** action while starting/running/pausing/paused; closing and stopped disable it. The current Dashboard has no Pause/Resume action or disabled-reason affordance, while genuine paused status remains displayed as runtime state. Stop is containment, not domain cancellation: it does not itself change card status or root result, and open cards remain durably `running`. While the request remains closing, a cancellation that already won may complete its durable `cancelled` publication and caller settlement; the UI must not show Stop success before that settlement. The result distinguishes contained Stop from already stopped; containment failure must not claim stopped and leaves the UI in closing/conflict state. A successful later Run reuses the cards that remain in the running chain, installs all ancestor owners, and activates only the deepest card.

The Dashboard sends Stop as a bodyless request without JSON `Content-Type`; bearer `Authorization` and ordinary request headers remain independent and are preserved. The distinct **Restart server** action is rendered only when the required runtime-status field `restart_server_available` is true. `DashboardView` owns the direct browser prompt, accepts only exact `RESTART SERVER`, and initiates the strict JSON request `{confirmation:'RESTART SERVER'}` with JSON `Content-Type` to the auth-gated `restart_server` operation. The Dashboard owns only that prompt and direct request initiation; the application-owned `RestartPort` owns terminal coordination shared with the separate Analyst restart path. When false, the UI does not offer the action; a stale direct request still receives typed `restart_unavailable`. Stop project never calls or aliases Restart server.

`restart_scheduled` acknowledges accepted asynchronous intent, not replacement readiness. Terminal closer/leaf warnings do not retroactively alter acknowledgement or normal restart behavior. The internal immutable shutdown report is for direct App callers and process adapters; it is not a card outcome, containment result, or operator-editable state.

Agent conversation surfaces render the one stable append-only session in physical row order. They may show `model_recovered` uncertainty, the original-call paired failed tool result, and a later fresh UUID continuation as separate facts; source UUIDs have no sequence or timestamp meaning. Notification-defeated terminal candidates remain visible as ordinary failed `emit_result` rows followed by operator context. Reviewer deferral shows discard/result effects without inventing a durable reviewer phase, delivery marker, or recovered outcome.

Agent-list, selected-conversation, and selected-LLM-exchange resources have independent loaded/loading/refreshing/error state. An accepted empty agent list is distinct from an initial failure. A same-session conversation refresh keeps the last accepted transcript visible on non-abort failure and reports the refresh error separately from an initial-load failure. An LLM-exchange 404 is an accepted loaded-empty result, including on refresh where it authoritatively clears an older exchange; another refresh failure retains the accepted exchange or accepted-empty result and reports only a refresh error.

Debug keeps explicit session selection as presentation intent and derives its effective session as that explicit ID when it remains in the canonical agent list, otherwise the first row in canonical list order. Disappearance falls back without erasing intent, so reappearance restores the explicit session; an accepted empty list mounts no detail. The effective session and detail kind form the key of one Debug detail component. The primary Agents conversation is likewise keyed by route session, and its conditional Raw LLM Exchange panel is keyed by session. Each keyed conversation lifetime claims a fresh opaque current-consumer token, subscribes before fetching, unregisters before token-guarded clear, and aborts/invalidates the departed request. Exchange lifetimes claim and clear their independent token without opening a conversation subscription. Stale callbacks, completions, and delayed cleanup therefore cannot change or clear a newer consumer, and no consumer registry or copied agent rows exist.

Agent activity status may be `compacting` while the backend projects an oversized stable conversation before a provider call. The status is transient and read-only; compaction appends one metadata row and never replaces or versions the conversation.

When an active provider turn is in backend transient recovery, the operator UI should continue to show the card/agent as active or running and must not invent an immediate terminal failure. The backend may be retrying the same candidate first for non-rate-limit transient failures, trying later alternates after a rate-limit/`Retry-After`, or waiting under the fixed two-hour deadline. No new API fields, countdowns, or UI controls are required; terminal failure appears only when the backend reports exhaustion/deadline/cancellation or a permanent/non-waitable provider, input, protocol, configuration, authentication, or local setup failure.

A strict raw provider rejection or malformed provider-attempt envelope is not indefinitely active work. Its armed card resolves through the existing failed card/lifecycle projection, and a waiting parent planner receives the existing failed `activate_card` tool result. Fatal-handler server logs are not a durable UI diagnostic; these strict failures add neither a synthetic provider exchange to Raw LLM Exchange nor a `model_issue` entry.

The backend exposes append-only compacted conversation rows for future `CompactedCluster` rendering. Each row is a strict `context_compaction` entry with `role: 'system'`, a `compacted` round ID, and canonical-JSON string `content`. Raw views show that exact JSON string. Its one ordered `summaries` array contains an optional leading merged group and individual groups; round segments' `source_message_ids` are the sole covered-source identity, alongside completeness, group hashes, summary prose, evidence, retained static IDs, boundary, and applied policy. The policy contains only mode, band, input budget, canonical static estimate, trigger/completion fractions, selected merge/summary fractions, and snap; derived completion, trigger, hard-ceiling, tail, and middle token values are not raw payload fields. Provider/debug projections show one system-context unit derived from validated groups. Round labels, repair anchors, cutoff, and rendered text are not payload fields. The physically latest validated row supersedes earlier metadata without versions, generations, caches, or replacement, while every complete row must validate against only physically preceding source rows. Rows carrying superseded derived policy fields fail strict reads and require the documented stop/reset/start cutover.

This payload is a reset-only durable-format cutover. The UI does not compatibility-render old generated rows: operators stop the service, preserve configuration, credentials, operator inputs, source, and documentation, run the current built reset, and start the current binary.

When compaction is enabled, configuration requires route-independent `compaction.input_budget_tokens`. Editor validation reports budget/fraction errors, including wider escalated tail or middle windows and a nonpositive derived completion reserve. Exact role/card prompt and tool-schema capacity is prepared once for each stable autonomous activation/repair loop before any transcript append or model I/O; continuations retain it while refreshing context. Diagnostics may derive and display ephemeral thresholds even though those values are not durable policy fields. They distinguish static-capacity failure from the deterministic best-effort full-request byte/4 candidate heuristic and from an authoritative provider context rejection; the heuristic is not presented as tokenizer-exact or proof of fit.

The workspace may provide projection-only affordances:

- navigation;
- filtering;
- sorting;
- search;
- expand/collapse;
- refresh;
- copy-to-clipboard;
- route changes;
- view preferences.

Except for the explicit runtime Stop/Restart controls above, these affordances do not mutate server state.

Card tree rows show only the depth-indented state ball, human-friendly display-path level number, card title, and card kind. Tags and priority are not displayed in card rows or card detail. Card detail does not render Related or Hierarchy sections; children and ancestors remain navigable through the card tree.

Cards default project expansion is derived from the current canonical card list plus explicit expand/collapse intent. A project arriving after route mount expands without a watcher or route fetch, while an explicit collapse survives list refreshes. Card Conversations filters the canonical agent-store list reactively by card ID: mount and card-ID changes make no list request, and its explicit Refresh makes one canonical list request while preserving accepted rows and reporting refresh failure separately.

## 4. Analyst Panel

The Analyst panel is the user's ordinary mutation path. The user asks for changes in natural language; the Analyst invokes canonical services.

Apart from the two direct Dashboard runtime controls in Section 3, the workspace remains projection-oriented. Other runtime lifecycle requests use the retained Analyst Run and Pause/Resume controls, and Analyst server restart remains a separate request with actor-owned confirmation. Internal server/application disposal cleanup is not an Analyst, UI, or HTTP control.

The shared Analyst session is the singular authenticated operator authority at `analyst:global`, not a private per-browser chat. HTTP bearer and WebSocket ticket validation admit normal web access to that same authority without creating an individual identity. Closing any browser socket removes only that socket's local queue; it never cancels shared Analyst work. Token changes intentionally replace the WebSocket generation; stale ticket, message, and close callbacks cannot take the current connection offline, while a current `1008` remains terminal unauthorized. Server restart is exposed only when API-token authentication is enabled; disabled-auth deployments retain ordinary chat but do not expose restart.

The panel renders the last accepted authoritative `analyst:global` transcript together with send-owned optimistic user rows. Session and transcript requests abort superseded work and reject stale completions. An authoritative refresh removes an optimistic row only when a server row proves it by identity or by the same session, user role, and content; otherwise the pending row remains visible. Refresh failure retains both authoritative and pending rows and is reported independently from send failure. A failed send removes only its own pending row and restores its captured draft only when the user has not edited the cleared composer since that send began.

Runtime invalidations prompt an immediate authoritative REST refetch after direct owner mutations. These include CardService-owned root or dynamic admission, cancellation and terminal status changes, card create/delete/type index changes, launch lifecycle/run-identity and each retained-row insertion even when later launch work fails, separately ordered current-child entry and parent resumption, retained card/agent membership changes, public autonomous-agent phase changes, pause/resume, completion, and failure. Non-index card edits do not require runtime invalidation. The hints are lossy and may be coalesced only by `SyncHub`; the UI never treats them as state. Lock-held CLI pause/resume delegates to the same REST authority and therefore has the same behavior. Unlocked CLI persistence, startup recovery/reconciliation, and shutdown state are visible through the authoritative initial load or reconnect read and do not promise an immediate live hint.

After the Analyst returns restart confirmation-required, the composer shows the inline warning: `Restart confirmation required. Send exactly RESTART SERVER to schedule server shutdown.` It is presentation of actor-owned pending state, not a transcript entry. The warning remains after a failed or aborted next submission and changes only after a successful response proves that actor ingress consumed that message: a new confirmation-required acknowledgement replaces it, while `null` or `scheduled` clears it.

When shutdown is scheduled, the global toaster shows warning title `Server restart scheduled` and message `The server is shutting down. This does not confirm that a replacement is running.` The UI queues that warning before transcript refetch. If the expected shutdown disconnect makes that refetch fail, it retains the cleared draft and optimistic sent message without a send error or rollback. A scheduled acknowledgement is not a readiness claim and adds no acknowledgement/status transcript entry.

Planner, executor, reviewer, and analyst prompts are configurable by editing Markdown overrides under `.saivage/config/prompts/<cardType>/<role>.md`; rendered prompts still appear through the normal agent transcript and Debug conversation surfaces.

On ordinary workspace routes, the chat composer must be reachable without opening a drawer or switching page modes, and the user should be able to inspect the workspace and talk to the Analyst at the same time. The exact `analyst:global` Agents detail exception in Section 2 instead provides read-only conversation inspection without the persistent panel or composer.

Card management is Analyst-owned and process-lifecycle-gated. A displayed or persisted `stopped`/`paused` status is not by itself mutation admission: the private runtime facet must report stopped-ready or settled-paused after admitted work has settled. The Analyst may then use supported semantic card operations such as creating cards, reordering direct children where supported, cancelling dormant work, and delete/archive removal with deleted-id reservation. The Analyst updates a card's goal/instructions/acceptance content by using `write`, `edit`, or `webfetch.save_as` for `record:///brief.md?card=<id>&v=next` when the target card is `backlog`, `done`, `failed`, or `running`; `changed`, `blocked`, and `cancelled` brief edits fail before writing. Scoped file URLs shown by the UI use canonical triple-slash form (`project:///`, `record:///`, `tmp:///`, `work:///`, `system:///`). The UI may show the relevant record URLs and metadata, but it must not perform these mutations directly.

Files and card-record panels are logical projections of canonical artifacts and never expose writable physical body or artifact paths. Record panels display the slot-local version and commit timestamp. Timestamp, local version, and card/slot identity are the deterministic display-order facts; the UI has no project-wide record ordinal.

## 5. Contextual Awareness

On every user turn, the Analyst receives enough workspace context to resolve phrases like:

- "this card"
- "this file"
- "the current agent"
- "what happened here?"
- "summarize this"
- "why did this stop?"

At minimum, the UI provides the Analyst with:

- active view category;
- active entity identifier when applicable;
- active filter/refinement when applicable.

If the active context is ambiguous, the Analyst asks one clarifying question.

## 6. Analyst-Driven Navigation

The Analyst can change the workspace view on the user's behalf.

Examples:

- "Open card goal-7" navigates the workspace to that card.
- "Show me the latest planner session for goal-7" opens that session.
- "Open the errors view" switches the workspace to runtime errors.
- "Go back" restores the previous workspace view/entity when available.

Navigation can be combined with mutation in one Analyst turn. For example, the Analyst can open a relevant session, queue a card notification, and report both outcomes.

Analyst Back owns logical workspace history rather than browser transport history. Restoration replaces the displayed route without re-recording it, so Back cannot oscillate between two views. REST remains the source of read models: card, history, agent-session, transcript, and LLM-exchange reads carry local request ownership, and a stale resolve, rejection, or completion cannot overwrite a newer card, version, or session selection.

## 7. Forbidden UI Mutations

Except for the Section 3 Dashboard **Stop project** and confirmed **Restart server** controls, the UI must not expose buttons, menus, context menus, drag/drop gestures, or keyboard shortcuts that perform Analyst-only mutations directly.

Forbidden direct UI mutations include:

- creating cards;
- editing cards;
- writing or editing card document records through the Analyst-only `record:///brief.md?card=<id>&v=next` new-version contract;
- deleting or archiving cards;
- reordering cards directly through the UI;
- queueing notifications;
- starting/running/resuming the runtime;
- pausing the runtime;
- shutting down the runtime through any other direct UI control;
- cancelling cards/subtrees;
- marking goals as needing corrections;
- terminating processes;
- changing model/provider routing;
- changing failover order;
- editing MCP server entries, including `stdio` and `streamable-http` transports;
- changing runtime/server settings.

The UI can offer read-only controls that help the user inspect those things. Apart from the two named Dashboard exceptions, if the user wants to change them, the path is the Analyst.

## 8. Bootstrap Exception

The user-visible controls permitted outside the Analyst are the two Section 3 Dashboard runtime controls and the following minimum controls needed to reach the Analyst:

- sign in / sign out;
- initial provider-secret entry required to make an Analyst-capable model available when none exists.

Once an Analyst-capable profile exists, additional provider/profile/model/configuration management is Analyst-owned.

The configuration projection and every Analyst configuration mutation address the exact file selected when the active server started, including a custom `--config` or `SAIVAGE_CONFIG` path. The UI does not derive `.saivage/saivage.yaml`, choose another file, or expose a write-in-progress retry state; accepted mutations apply synchronously after intervention-readiness, permission, and current-config checks. A failed direct replacement fails that request without poisoning later unrelated mutation. Analyst MCP desired-config mutation and explicit reconciliation remain unavailable with their existing rejection results. No MCP topology UI shape change is required.

An MCP mutation response distinguishes persisted desired configuration from active runtime convergence. A pending activation is reported as persisted but not reconciled, includes the desired/active/pending reconciliation projection, and names `mcp_reconcile` as the explicit mutation-free retry. The Analyst must retry that action rather than replaying add/edit/remove; Saivage does not roll desired config back. No graphical MCP control panel is added.

## 9. Secret Display

The Analyst may inspect secrets when authorized and necessary. The UI may still redact secret values by default in projections, previews, logs, and transcript chips.

If the Analyst needs to discuss or use a secret, it should avoid unnecessary disclosure and should summarize where possible. Redaction in the UI is a display policy, not a limitation on Analyst inspection authority.

## 10. Process And Tool Output Projections

Process visibility is broader than termination authority. `owner_kind`, `owner_id`, card association, labels, and displayed command/log metadata explain provenance only; a tool can terminate a process only through the exact direct scope capability and category that launched it. The UI must not infer authority from a visible owner match. A process group is not displayed or acknowledged as stopped until the backend proves group absence with `ESRCH`; an unverifiable group remains a failed/diagnostic outcome rather than being normalized to stopped.

Process rows and process detail responses expose nullable `card_id`, explicit `owner_kind` / `owner_id`, and `logs.stdout` / `logs.stderr` as canonical `work:///cards/<cardId>/processes/<id>/{stdout,stderr}.log` URLs for card-owned processes or `work:///processes/<id>/{stdout,stderr}.log` URLs for non-card Analyst/operator/runtime processes. They do not expose a duplicate `owner` shorthand, and there is no Combined log entry. The operator process API contract rejects bare `.saivage/work` paths, non-work schemes, non-canonical encodings, and mismatched log filenames. The Debug process-log Browse action forwards these `work:///` values to the Files read-model, which resolves them under `.saivage/work/` and previews the log content without reintroducing a bare path field. The Files work root is `.saivage/work`, while durable card records are visible under `.saivage/cards`. The Debug agents area shows Conversation and Raw LLM Exchange views; the duplicate Tool Deliveries tab is removed. Raw LLM Exchange reads the latest settled app-log `provider_exchange` metadata entry through `/api/agents/:id/llm-exchange` and displays the same metadata envelope shape for that latest attempt. It shows provider/model/account, contract, source input id, attempt index, timing, status, response status, finish reason, token usage, terminal tool, assistant output ids, request parameters, and structured errors. Raw HTTP bodies and retry-attempt arrays are not available, and panel availability is derived from the app-log-backed API rather than listing `.saivage/agents/llm-exchanges`. On a successful completion, the current producer first commits one visible assistant-side output row, then supplies that exact persisted row ID as the sole `assistant_output_ids` element on successful attempt records. That row is a normal message, a supported tool call, or the output-validation `model_issue` created for a successfully returned but unacceptable completion. This one-element shape describes the current producer and records it writes; the persistence/API schema accepts a general array of strings and does not enforce one-element or non-empty cardinality. The API returns the stored conversation linkage and Raw LLM Exchange displays it unchanged, without either layer inferring or rewriting an ID. This linkage is distinct from the provider-exchange app-log row's own `(session_id, source_input_id, attempt_index)` identity. Error payloads have no `assistant_output_ids`. For `openai-responses`, Raw LLM Exchange may show sanitized metadata such as transport label, endpoint, `store:false`, include keys, reasoning keys, output-token limits, status, and usage, but it must never expose raw Responses output, reasoning encrypted content, provider-private rows or ids, API keys, raw request/response bodies, or tool output bodies.

Canonical `work:///` is the browsable Files root for `.saivage/work`; content preview rejects that root as a directory. Concrete process-log Browse actions remain canonical descendant URLs, and the process API rejects `work:///` itself as a log reference.

The Debug supervision panel shows content-review stats and recent sanitized review summaries from `/api/debug/supervision`. Blocked content has no Browse-in-Files action: supervision does not persist raw blocked content, does not create quarantine paths, and does not expose quarantine IDs for file browsing.

Tool-activity websocket projections use the unified metadata-only process result fields: `process_id`, `exit_code`, `status`, `stdout_url`, `stderr_url`, `stdout_bytes`, and `stderr_bytes`. Legacy inline-output fields such as `stdout`, `stderr`, `stdout_tail`, `stderr_tail`, `tail_truncated`, `truncated`, `log_path`, `running`, `terminated`, and `still_running` are not projected.

Oversized `webfetch` text returns `stash_url: work:///tmp/stash/<file>`. The websocket projection forwards `stash_url`, and the webfetch result presenter displays that URL; `stash_path` is not part of the UI contract.

## 11. Acceptance Criteria

The UI satisfies this specification when:

- on ordinary workspace routes, the Analyst panel is visible on first paint at desktop widths; on the exact `analyst:global` Agents detail route, the workspace instead hosts the read-only conversation-inspection component and the persistent panel, header, composer, and narrow `Analyst` pane switch are omitted;
- no drawer/toggle control is required to reach the ordinary persistent Analyst panel;
- on ordinary workspace routes, the workspace remains visible beside the Analyst panel;
- card detail distinguishes structured card state, live `working_status`, accepted `result`, and versioned card document records including `brief.md`, `status.md`, and `review.md`;
- card detail can expose record URLs, metadata, and history when available, while leaving record mutation to the Analyst;
- read-only workspace navigation/filtering/copy/refresh still works;
- no direct UI control performs an Analyst-only mutation;
- the Analyst receives active workspace context for deictic requests;
- the Analyst can navigate the workspace on the user's behalf;
- agent conversations in the Analyst panel, Agents conversation detail, and Debug agents conversation detail use rounds, tool rows, grouping, human-readable details, raw-payload access, activity-backed pending-call states, compaction bounding, live-update stability, and Debug as the transcript entry point;
- all three conversation surfaces auto-tail while near the bottom and not paused for new visible content, including entries, within-round entry growth, and activity footer rows; the Debug agents conversation live-updates without manual Refresh; and each surface's `Pause auto-scroll` checkbox routes new content to the `Jump to latest · N new` unseen counter.
