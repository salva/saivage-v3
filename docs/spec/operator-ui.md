# Operator UI Specification

Status: current functional UI authority.

Last updated: 2026-07-13.

## 1. Purpose

The operator UI shows Saivage state and hosts the Analyst. It does not compete with the Analyst as a control surface.

The UI must help the user understand what the autonomous runtime is doing, inspect cards, record-backed card documents, files, and processes, and stay oriented during Analyst conversations. Mutations still go through the Analyst.

## 2. Layout

At typical desktop widths, the operator web UI is a single screen with two always-visible regions:

- A left workspace area, roughly 70-80% of the viewport.
- A right Analyst panel, roughly 20-30% of the viewport.

The Analyst panel contains the current Analyst session, chat history, and composer. It is not a drawer, modal, popover, slide-over, or hidden panel. At desktop widths there is no control whose job is to open, close, hide, reveal, expand-to-full-screen, or toggle the Analyst panel.

At narrow widths, the shell collapses to a single column and exposes a presentation-only `Workspace` / `Analyst` pane switch so the user can choose which region is visible. The switch changes only the local layout; it does not mutate server state and does not turn the Analyst into a modal or separate control surface.

The current project name is shown in a slim header at the top of the Analyst panel only, occupying the top of the Analyst column rather than a full-width page bar.

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

The runtime dashboard is current-state-only. It shows runtime status and the `active_card_run` cursor, including activation ownership as the parent card plus the full parent conversation triple (`session_id`, `source_input_id`, `tool_call_id`) when the current card is activation-owned. It does not expose `activation_id`, `parent_run_id`, runtime command/run/activation ledgers, `Last Command`, `Root Run`, `Active Child Runs`, or `Activation Edges` placeholder panels. Analyst runtime tools receive current-state results (`runtime`, `status`, started/stopped flags, and optional error text), not command/run records or ids. Recovery diagnostics may report synthetic interrupted tool results appended during startup repair.

Agent conversations in the Analyst panel, Agents conversation detail, and Debug agents conversation detail follow the shared design in [Agent Conversation UI Redesign](../architecture/agent-conversation-ui-redesign.md). That document defines the round, tool-row, grouping, detail, raw-payload, and Debug-as-transcript-entry behavior for conversation displays. All conversation entries are backend conversation records from the active conversation version; the UI does not synthesize transcript rows from send responses, websocket activity frames, or pending-tool adapters. These conversation surfaces present rounds in active-version/API input order; projected tool results display with their call rounds without changing the call round's original transcript position. The Analyst panel subscribes to the canonical Analyst conversation live-sync resource and receives tool-call/tool-result progress through refetches after `{ resource: 'conversation', id: <session id> }` invalidations. While a send is in flight, the panel may show the optimistic user input, but assistant/tool transcript content is replaced by canonical refetch/live-sync records rather than inserted from a chat response or websocket transcript reply. All three conversation surfaces auto-scroll to the tail while the user is near the bottom and has not paused auto-scroll, including within-round entry growth and activity footers; the Debug agents conversation live-updates from the conversation invalidation channel without requiring manual Refresh for new entries; and each surface has a `Pause auto-scroll` checkbox that suspends auto-scroll and routes new content to the `Jump to latest · N new` unseen counter. The UI addresses conversations and agents only by backend session/actor ids; it does not depend on whether the physical transcript lives under a card-owned conversation directory or the Analyst conversation root.

Debug selected-conversation requests are scoped to the current session identity: changing the session or detail kind aborts the old request, and stale completions cannot alter rows or request state. A same-session refresh keeps the last accepted transcript visible on failure and reports the refresh error separately from an initial-load failure.

Agent activity status may be `compacting` while the backend is summarizing an oversized card-lifetime conversation before a provider call. The status is transient and read-only; it means the runtime is preserving the active conversation by writing a new compacted version, not that the card has changed state.

When an active provider turn is in backend transient recovery, the operator UI should continue to show the card/agent as active or running and must not invent an immediate terminal failure. The backend may be retrying the same candidate first for non-rate-limit transient failures, trying later alternates after a rate-limit/`Retry-After`, or waiting under the fixed two-hour deadline. No new API fields, countdowns, or UI controls are required; terminal failure appears only when the backend reports exhaustion/deadline/cancellation or a permanent/non-waitable provider, input, protocol, configuration, authentication, or local setup failure.

A strict raw provider rejection or malformed provider-attempt envelope is not indefinitely active work. Its armed card resolves through the existing failed card/lifecycle projection, and a waiting parent planner receives the existing failed `activate_card` tool result. Fatal-handler server logs are not a durable UI diagnostic; these strict failures add neither a synthetic provider exchange to Raw LLM Exchange nor a `model_issue` entry.

The backend exposes compacted conversation rows for future `CompactedCluster` rendering. Each compacted row is a `context_compaction` entry with `role: 'user'`, `round_id` using the `compacted` round kind, and `content` containing the runtime framing marker, summary text, and deterministic `Recoverable evidence` section. Read-model metadata for compacted clusters includes `compaction_generation`, `compacted_through`, `summary_ids`, and `bands` when present. The `CompactedCluster.vue` component is owned by the agent-conversation-ui-redesign phases and is not required by this change.

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

These affordances do not mutate server state.

Card tree rows show only the depth-indented state ball, human-friendly display-path level number, card title, and card kind. Tags and priority are not displayed in card rows or card detail. Card detail does not render Related or Hierarchy sections; children and ancestors remain navigable through the card tree.

## 4. Analyst Panel

The Analyst panel is the user's mutation path. The user asks for changes in natural language; the Analyst invokes canonical services.

The workspace remains read-only. Runtime lifecycle requests use the retained Analyst Run and Pause/Resume controls, and server restart remains an Analyst request. Internal server/application disposal cleanup is not an Analyst, UI, or HTTP control.

The shared Analyst session is the singular authenticated operator authority at `analyst:global`, not a private per-browser chat. HTTP bearer and WebSocket ticket validation admit normal web access to that same authority without creating an individual identity. Closing any browser socket removes only that socket's local queue; it never cancels shared Analyst work. Token changes intentionally replace the WebSocket generation; stale ticket, message, and close callbacks cannot take the current connection offline, while a current `1008` remains terminal unauthorized. Server restart is exposed only when API-token authentication is enabled; disabled-auth deployments retain ordinary chat but do not expose restart.

The panel renders the last accepted authoritative `analyst:global` transcript together with send-owned optimistic user rows. Session and transcript requests abort superseded work and reject stale completions. An authoritative refresh removes an optimistic row only when a server row proves it by identity or by the same session, user role, and content; otherwise the pending row remains visible. Refresh failure retains both authoritative and pending rows and is reported independently from send failure. A failed send removes only its own pending row and restores its captured draft only when the user has not edited the cleared composer since that send began.

Runtime projections refresh immediately after successful serving-process start, pause/resume, active-run, completion, and failure writes. Lock-held CLI pause/resume delegates to the same REST authority and therefore has the same behavior. Unlocked CLI persistence, startup recovery/reconciliation, and shutdown state are visible through the authoritative initial load or reconnect read and do not promise an immediate live hint.

After the Analyst returns restart confirmation-required, the composer shows the inline warning: `Restart confirmation required. Send exactly RESTART SERVER to schedule server shutdown.` It is presentation of actor-owned pending state, not a transcript entry. The warning remains after a failed or aborted next submission and changes only after a successful response proves that actor ingress consumed that message: a new confirmation-required acknowledgement replaces it, while `null` or `scheduled` clears it.

When shutdown is scheduled, the global toaster shows warning title `Server restart scheduled` and message `The server is shutting down. This does not confirm that a replacement is running.` The UI queues that warning before transcript refetch. If the expected shutdown disconnect makes that refetch fail, it retains the cleared draft and optimistic sent message without a send error or rollback. A scheduled acknowledgement is not a readiness claim and adds no acknowledgement/status transcript entry.

Planner, executor, reviewer, and analyst prompts are configurable by editing Markdown overrides under `.saivage/config/prompts/<cardType>/<role>.md`; rendered prompts still appear through the normal agent transcript and Debug conversation surfaces.

The chat composer must be reachable without opening a drawer or switching page modes. The user should be able to inspect the workspace and talk to the Analyst at the same time.

Card management is Analyst-owned and runtime-state-gated. When runtime status is `stopped` or `paused`, the Analyst may use supported semantic card operations such as creating cards, reordering direct children where supported, cancelling dormant work, and delete/archive removal with deleted-id reservation. The Analyst updates a card's goal/instructions/acceptance content by using `write`, `edit`, or `webfetch.save_as` for `record:///brief.md?card=<id>&v=next` when the target card is `backlog`, `done`, `failed`, or `running`; `changed`, `blocked`, and `cancelled` brief edits fail before writing. Scoped file URLs shown by the UI use canonical triple-slash form (`project:///`, `record:///`, `tmp:///`, `work:///`, `system:///`). The UI may show the relevant record URLs and metadata, but it must not perform these mutations directly.

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

The UI must not expose buttons, menus, context menus, drag/drop gestures, or keyboard shortcuts that perform Analyst-only mutations directly.

Forbidden direct UI mutations include:

- creating cards;
- editing cards;
- writing or editing card document records through the Analyst-only `record:///brief.md?card=<id>&v=next` new-version contract;
- deleting or archiving cards;
- reordering cards directly through the UI;
- queueing notifications;
- starting/running/resuming the runtime;
- pausing the runtime;
- shutting down the runtime;
- cancelling cards/subtrees;
- marking goals as needing corrections;
- terminating processes;
- changing model/provider routing;
- changing failover order;
- editing MCP server entries, including `stdio` and `streamable-http` transports;
- changing runtime/server settings.

The UI can offer read-only controls that help the user inspect those things. If the user wants to change them, the path is the Analyst.

## 8. Bootstrap Exception

The only user-visible controls permitted outside the Analyst are the minimum controls needed to reach the Analyst:

- sign in / sign out;
- initial provider-secret entry required to make an Analyst-capable model available when none exists.

Once an Analyst-capable profile exists, additional provider/profile/model/configuration management is Analyst-owned.

## 9. Secret Display

The Analyst may inspect secrets when authorized and necessary. The UI may still redact secret values by default in projections, previews, logs, and transcript chips.

If the Analyst needs to discuss or use a secret, it should avoid unnecessary disclosure and should summarize where possible. Redaction in the UI is a display policy, not a limitation on Analyst inspection authority.

## 10. Process And Tool Output Projections

Process visibility is broader than termination authority. `owner_kind`, `owner_id`, card association, labels, and displayed command/log metadata explain provenance only; a tool can terminate a process only through the exact direct scope capability and category that launched it. The UI must not infer authority from a visible owner match. A process group is not displayed or acknowledged as stopped until the backend proves group absence with `ESRCH`; an unverifiable group remains a failed/diagnostic outcome rather than being normalized to stopped.

Process rows and process detail responses expose nullable `card_id`, explicit `owner_kind` / `owner_id`, and `logs.stdout` / `logs.stderr` as canonical `work:///cards/<cardId>/processes/<id>/{stdout,stderr}.log` URLs for card-owned processes or `work:///processes/<id>/{stdout,stderr}.log` URLs for non-card Analyst/operator/runtime processes. They do not expose a duplicate `owner` shorthand, and there is no Combined log entry. The operator process API contract rejects bare `.saivage/work` paths, non-work schemes, non-canonical encodings, and mismatched log filenames. The Debug process-log Browse action forwards these `work:///` values to the Files read-model, which resolves them under `.saivage/work/` and previews the log content without reintroducing a bare path field. The Files work root is `.saivage/work`, while durable card records are visible under `.saivage/cards`. The Debug agents area shows Conversation and Raw LLM Exchange views; the duplicate Tool Deliveries tab is removed. Raw LLM Exchange reads the latest settled app-log `provider_exchange` metadata entry through `/api/agents/:id/llm-exchange` and displays the same metadata envelope shape for that latest attempt. It shows provider/model/account, contract, source input id, attempt index, timing, status, response status, finish reason, token usage, terminal tool, assistant output ids, request parameters, and structured errors. Raw HTTP bodies and retry-attempt arrays are not available, and panel availability is derived from the app-log-backed API rather than listing `.saivage/agents/llm-exchanges`. When the latest settled attempt is successful, `assistant_output_ids` is the invocation-boundary value, normally `[]`, and the UI must not infer later assistant message ids into that provider-exchange payload. For `openai-responses`, Raw LLM Exchange may show sanitized metadata such as transport label, endpoint, `store:false`, include keys, reasoning keys, output-token limits, status, and usage, but it must never expose raw Responses output, reasoning encrypted content, provider-private rows or ids, API keys, raw request/response bodies, or tool output bodies.

The Debug supervision panel shows content-review stats and recent sanitized review summaries from `/api/debug/supervision`. Blocked content has no Browse-in-Files action: supervision does not persist raw blocked content, does not create quarantine paths, and does not expose quarantine IDs for file browsing.

Tool-activity websocket projections use the unified metadata-only process result fields: `process_id`, `exit_code`, `status`, `stdout_url`, `stderr_url`, `stdout_bytes`, and `stderr_bytes`. Legacy inline-output fields such as `stdout`, `stderr`, `stdout_tail`, `stderr_tail`, `tail_truncated`, `truncated`, `log_path`, `running`, `terminated`, and `still_running` are not projected.

Oversized `webfetch` text returns `stash_url: work:///tmp/stash/<file>`. The websocket projection forwards `stash_url`, and the webfetch result presenter displays that URL; `stash_path` is not part of the UI contract.

## 11. Acceptance Criteria

The UI satisfies this specification when:

- the Analyst panel is visible on first paint at desktop widths;
- no drawer/toggle control is required to reach the Analyst;
- the workspace remains visible beside the Analyst panel;
- card detail distinguishes structured card state, live `working_status`, accepted `result`, and versioned card document records including `brief.md`, `status.md`, and `review.md`;
- card detail can expose record URLs, metadata, and history when available, while leaving record mutation to the Analyst;
- read-only workspace navigation/filtering/copy/refresh still works;
- no direct UI control performs an Analyst-only mutation;
- the Analyst receives active workspace context for deictic requests;
- the Analyst can navigate the workspace on the user's behalf;
- agent conversations in the Analyst panel, Agents conversation detail, and Debug agents conversation detail follow the shared design in [Agent Conversation UI Redesign](../architecture/agent-conversation-ui-redesign.md) (rounds, tool rows, grouping, human-readable details, raw-payload access, activity-backed pending-call states, compaction bounding, live-update stability, and Debug as the transcript entry point);
- all three conversation surfaces auto-tail while near the bottom and not paused for new visible content, including entries, within-round entry growth, and activity footer rows; the Debug agents conversation live-updates without manual Refresh; and each surface's `Pause auto-scroll` checkbox routes new content to the `Jump to latest · N new` unseen counter.
