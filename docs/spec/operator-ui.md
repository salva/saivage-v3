# Operator UI Specification

Status: current functional UI authority.

Last updated: 2026-07-07.

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

The runtime dashboard is current-state-only. It shows runtime status and the `active_card_run` cursor, including activation ownership as the parent card plus the full parent conversation triple (`session_id`, `source_input_id`, `tool_call_id`) when the current card is activation-owned. It does not expose `activation_id`, `parent_run_id`, runtime command/run/activation ledgers, `Last Command`, `Root Run`, `Active Child Runs`, or `Activation Edges` placeholder panels. Runtime start/stop controls and Analyst runtime tools receive current-state results (`runtime`, `status`, started/stopped flags, and optional error text), not command/run records or ids. Recovery diagnostics may report synthetic interrupted tool results appended during startup repair.

Agent conversations in the Analyst panel, Agents conversation detail, and Debug agents conversation detail follow the shared design in [Agent Conversation UI Redesign](../architecture/agent-conversation-ui-redesign.md). That document defines the round, tool-row, grouping, detail, raw-payload, and Debug-as-transcript-entry behavior for conversation displays. All conversation entries are backend conversation records from the active conversation version; the UI does not synthesize transcript rows from send responses, websocket activity frames, or pending-tool adapters. The Analyst panel subscribes to the canonical Analyst conversation live-sync resource and receives tool-call/tool-result progress through refetches after `{ resource: 'conversation', id: <session id> }` invalidations. While a send is in flight, the panel may show the optimistic user input, but assistant/tool transcript content is replaced by canonical refetch/live-sync records rather than inserted from a chat response or websocket transcript reply. All three conversation surfaces auto-scroll to the tail while the user is near the bottom and has not paused auto-scroll, including within-round entry growth and activity footers; the Debug agents conversation live-updates from the conversation invalidation channel without requiring manual Refresh for new entries; and each surface has a `Pause auto-scroll` checkbox that suspends auto-scroll and routes new content to the `Jump to latest · N new` unseen counter. The UI addresses conversations and agents only by backend session/actor ids; it does not depend on whether the physical transcript lives under a card-owned conversation directory or the Analyst conversation root.

Agent activity status may be `compacting` while the backend is summarizing an oversized card-lifetime conversation before a provider call. The status is transient and read-only; it means the runtime is preserving the active conversation by writing a new compacted version, not that the card has changed state.

When all configured, capability-compatible LLM candidates for an active provider turn are temporarily unavailable, the backend keeps the turn pending for up to two hours while retrying. The operator UI should continue to show the card/agent as active or running during that wait and must not invent an immediate terminal failure. No new API fields, countdowns, or UI controls are required; terminal failure appears only when the backend reports the two-hour timeout or a permanent/non-waitable provider failure.

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

Planner, executor, reviewer, and analyst prompts are configurable by editing Markdown overrides under `.saivage/config/prompts/<cardType>/<role>.md`; rendered prompts still appear through the normal agent transcript and Debug conversation surfaces.

The chat composer must be reachable without opening a drawer or switching page modes. The user should be able to inspect the workspace and talk to the Analyst at the same time.

Card management is Analyst-owned and runtime-state-gated. When runtime status is `stopped` or `paused`, the Analyst may use supported semantic card operations such as creating cards, reordering direct children where supported, cancelling dormant work, and delete/archive-backed removal. The Analyst updates a card's goal/instructions/acceptance content by using `write`, `edit`, or `webfetch.save_as` for `record:///brief.md?card=<id>&v=next` when the target card is `backlog`, `done`, `failed`, or `running`; `changed`, `blocked`, and `cancelled` brief edits fail before writing. Scoped file URLs shown by the UI use canonical triple-slash form (`project:///`, `record:///`, `tmp:///`, `work:///`, `system:///`). The UI may show the relevant record URLs and metadata, but it must not perform these mutations directly.

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

Process rows and process detail responses expose nullable `card_id`, explicit `owner_kind` / `owner_id`, and `logs.stdout` / `logs.stderr` as canonical `work:///cards/<cardId>/processes/<id>/{stdout,stderr}.log` URLs for card-owned processes or `work:///processes/<id>/{stdout,stderr}.log` URLs for non-card Analyst/operator/runtime processes. They do not expose a duplicate `owner` shorthand, and there is no Combined log entry. The operator process API contract rejects bare `.saivage/work` paths, non-work schemes, non-canonical encodings, and mismatched log filenames. The Debug process-log Browse action forwards these `work:///` values to the Files read-model, which resolves them under `.saivage/work/` and previews the log content without reintroducing a bare path field. The Files work root is `.saivage/work`, while durable card records are visible under `.saivage/cards`. The Debug agents area shows Conversation and Raw LLM Exchange views; the duplicate Tool Deliveries tab is removed. Raw LLM Exchange reads the latest settled `provider_exchange` conversation row through `/api/agents/:id/llm-exchange` and displays one metadata envelope for that latest attempt. It shows provider/model/account, contract, source input id, attempt index, timing, status, response status, finish reason, token usage, terminal tool, assistant output ids, request parameters, and structured errors. Raw HTTP bodies and retry-attempt arrays are not available, and panel availability is derived from the conversation-backed API rather than listing `.saivage/agents/llm-exchanges`.

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
