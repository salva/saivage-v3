# Analyst as the Sole User Control Surface

Saivage is two coupled systems: an autonomous runtime that makes its own progress, and an Analyst chat that is the user's only way to inspect, steer, reconfigure, and repair that runtime. Every user-visible action that mutates server state must be reachable by talking to the Analyst in natural language, and only by talking to the Analyst. This document specifies what that system does, observed from the outside; it does not prescribe how to build it.

## Vision

The user's directive (verbatim):

> "saivage has two parts, one autonomous agent system which works automatically and then a chat (the analyst) which is the way in which the user controls the autonomous agent system. The analyst should be able to inspect any aspect of the platform, start/pause/continue the system, reconfigure it, handle the cards, investigate why something is not working as expected and fix it, etc."

> "the buttons for adding cards, or moving them, or starting/stopping the system must be removed. The Analyst must have the capability of handling all those actions."

This is architectural law. It is not a feature request, not a UX preference, not opt-in. The web UI displays state and offers passive affordances. The Analyst performs every action that mutates server state. There is no third surface and no fallback path: no operator console, no second-class API the browser can reach, no keyword parser, no degraded conversational mode. When the Analyst is unavailable, mutation is unavailable; this is the correct behavior, not a regression.

## Two-Part Model

### The autonomous runtime

The runtime owns the card tree, the notification queue, runtime state and event logs, the planner/executor/reviewer agents, the process registry, and the model and provider configuration. Once started, it advances on its own — activating child cards, executing planner-control actions, recording reviewer assessments, spawning and reaping processes — without user intervention. The runtime publishes events and state for any consumer to read.

### The Analyst chat

The Analyst is a single conversational session per project. The user types in natural language; the Analyst inspects, mutates, reconfigures, and reports back. It inherits the authenticated user's authority. It is not an autonomous worker: it does not write code, run builds, or deploy. Delivery work is delegated by creating or editing cards, by queueing notifications to cards, and by issuing runtime control actions, all of which the autonomous runtime then executes.

The runtime acts on its own according to project state. The user steers via the Analyst — no other control path exists.

### Spatial division in the operator UI

The two parts have a fixed spatial division in the operator web UI. The Analyst chat is the always-visible right-side panel. The autonomous-runtime state — cards, debug view, files, agent sessions, dashboard — lives in the always-visible left-side workspace area. The Analyst can navigate that left-side area on the user's behalf, and is aware of what the user is currently looking at there; the contractual details of that arrangement are specified under "Persistent panel layout and contextual awareness" below.

## Terminology: from "notes" to "notifications"

Saivage v2 had a user-visible object class called a "note". Notes were how the user passed information to the planner, because v2 objectives were static. That assumption no longer holds in v3: objectives evolve through the card tree itself, and any durable information about a goal attaches to the card it concerns. The v2 "note" is therefore retired.

In v3 the equivalent low-level mechanism is the **notification**. A notification is an ephemeral piece of content queued onto a card. The card runtime delivers that content, as soon as possible, to the main agent session responsible for that card: either the currently running but paused session for the card, or the next future session for that card. Notifications are not addressed directly to arbitrary roles; if the user phrases a request in role terms (for example, "tell the executor for goal-7"), the Analyst resolves it to the relevant card or asks a clarifying question. Notifications are not a user-managed object class: there is no notification inbox, no per-notification acknowledge action, no edit, no delete, no bulk-handle operation, and no list/get capability. The platform (planner, executor, reviewer, runtime, error reporter) is the primary producer of notifications; the user, via the Analyst, is one of several producers.

Notification semantics:

- **Queue-only and immutable.** Once a notification is queued it cannot be edited or deleted. To retract or correct a queued notification, queue a follow-up notification that instructs the agent to disregard the previous one.
- **Ephemeral.** Once a notification has been delivered to an agent session it is forgotten by the platform.
- **No durable surface.** Durable information about a card lives on the card itself (acceptance criteria, history, tags, dependencies, priority, urgency). There is no permanent-note concept.
- **No direct inspection.** Notifications are not retrievable after queueing. There is no second notification-reading surface anywhere in the platform: no inbox, no list, no per-notification get, no read-only notification panel, no audit endpoint that returns notification content as a queryable object. The control-action audit log MAY record the fact that the Analyst performed a queueing action (so that "did the Analyst queue this on my behalf?" can be answered), but such an audit entry references the queueing action only; it does not retain notification content as a retrievable object and is not a delivery-confirmation path. The only way to confirm whether a queued notification was delivered to an agent and how that agent reacted is to inspect the receiving agent session transcript through the existing agent-session inspection capability.

References to "notes" elsewhere in the v3 codebase, prompts, or stored data are legacy artifacts of the v2 model and are out of scope for this functional document.

## Analyst Capability Classes

The user must be able to complete each of the following classes end-to-end by talking to the Analyst, without touching any other UI control.

### Inspect

The user can read any non-secret artifact the runtime produces: any card and its full history, runtime state, runtime events and errors, the control-action audit log, agent session transcripts (planner, executor, reviewer, analyst), the process registry, process stdout and stderr, directory listings, and individual file contents on the project host.

Inspect commands also bring the inspected artifact into view: when the user asks the Analyst to show or read an entity that has a corresponding view in the left-side workspace area (a card, an agent session, a debug filter, a file, a runtime card), the Analyst navigates the left panel to that entity as part of answering. The conversational answer and the on-screen context stay in sync; the user does not have to click a separate navigation control to see what they just asked about.

Example utterances and expected outcomes:

- "Show me goal-7 and its last three history entries." → Analyst returns the card record and a summary of the three most recent history entries, and the left panel opens goal-7's detail view.
- "What's running right now?" → Analyst reports running processes with their card scope and start time; if the user then asks "open process P-123 in the debug view", the left panel switches accordingly.
- "Read the last 200 lines of runtime errors." → Analyst returns the lines as conversational output and the left panel shows the runtime-errors view.
- "Show me the planner session that last touched goal-7." → Analyst returns the relevant agent session transcript and the left panel opens that session.

### Navigate the workspace area

The Analyst can change what is rendered in the left-side workspace area on the user's behalf. The user does not need to click any navigation control to reach a view or entity they can name conversationally; asking the Analyst is sufficient. The UI's own navigation controls remain available as a read-only convenience, but they are not a precondition for any inspect or steer action.

The Analyst can switch between view categories (cards, debug, files, agents, dashboard), open a specific entity in the appropriate view (a card by id, an agent session by id, a file by path, a runtime card by id, a process by id), return to a previous view, and combine navigation with a subsequent action in the same turn.

- "Open card code-3." → the left panel switches to the cards view and opens card code-3; the Analyst confirms.
- "Take me to the debug view, filtered to errors." → the left panel switches to the debug view with the errors filter applied; the Analyst confirms.
- "Open the planner session that last touched goal-7 and queue context for that card saying we should retry with smaller batches." → the left panel opens the planner session, the Analyst queues a notification/context item for goal-7 with that content (or edits the card per the user's intent), and the Analyst reports both outcomes.
- "Go back to where I was before." → the left panel returns to the previously active view and entity; the Analyst confirms.

### Mutate cards

The user can create cards (individually or in batches, as siblings or children of any parent), edit cards (title, description, acceptance criteria, priority, urgency, tags, dependencies, status), reorder cards within their parent's child list, move cards along the parent-child axis (subject to the bounded-move rule below), and delete cards individually or by a described set.

#### Child ordering within a parent

Every child card has an explicit position within its parent's child list; children form an ordered list, not a set. The default order is creation order: a newly created child appends to the end of its parent's child list. Both the planner (autonomously) and the analyst (via user instruction) can reorder children within a single parent. This order is a presentation and comprehension convention: the planner typically dispatches children in the displayed order, but it is not required to and remains free to dispatch out of order based on its own scheduling. Order is therefore not a hard scheduling constraint.

#### Bounded card move

Moving a card to a different parent is restricted to the parent-child axis. Only two move directions are supported:

- **Move down (into a sibling).** Card X, currently a child of parent P, can be moved to become a child of one of its current siblings S; S becomes the new parent of X.
- **Move up (out to grandparent).** Card X, currently a child of parent P, can be moved out to become a sibling of P; P's current parent becomes the new parent of X.

Cross-tree moves — moving a card under an unrelated card that is not a current sibling and not the current grandparent — are not supported, and the Analyst refuses such requests with a clear explanation of the parent-child-axis restriction. A card with no parent (the root project card) cannot be moved out.

Example utterances and expected outcomes:

- "Create three sibling cards under goal-12 titled A, B, C." → three cards are created, appended in the given order to goal-12's child list, and the Analyst lists their ids.
- "Move goal-19 into goal-18." → goal-19 is moved down into its sibling goal-18, which becomes its new parent; the Analyst confirms the new parent.
- "Move goal-19 out to be a sibling of its parent." → goal-19 is moved up to become a sibling of its current parent; the Analyst confirms the new parent.
- "Move the move-generator card to the top of its subgoal." → the card's position within its parent's child list is updated to first; the Analyst confirms the new order.
- "Put the research card right after the architecture card under goal-4." → both cards remain children of goal-4 and the research card is repositioned immediately after the architecture card; the Analyst confirms the new order.
- "Edit the acceptance criteria of goal-7 to add: results reproducible from a clean checkout." → the criteria are updated and the Analyst reports the new value.
- "Delete every cancelled card." → all cards with status `cancelled` are deleted in one turn, and the Analyst reports the count and ids.

### Queue notifications to cards

The user can queue a notification onto a card. The card runtime injects the content into that card's current paused main agent session when it resumes or next accepts injected context, or into the next future main agent session for that card. The queued content is whatever natural-language instruction or context the user wants the agent responsible for the card to see. The Analyst is one producer among several; the runtime itself queues notifications as part of its normal operation.

- "Queue a notification for goal-7 telling the agent to prefer streaming over batched calls." → a notification is queued on goal-7 for the card's current paused or next future main agent session and the Analyst confirms.
- "Tell goal-19 to disregard the last notification I queued." → a follow-up notification is queued on goal-19; the Analyst confirms.

The Analyst does not offer "edit notification", "delete notification", "list pending notifications", "mark notification handled", or any equivalent management operation, because notifications are not a managed object class.

Pause-mutate-resume semantics: pausing is a canonical runtime control. While paused, the Analyst may perform Analyst-owned mutations such as card edits, configuration changes, or notification/context queueing. Resuming is also a canonical runtime control. After resume, planner/executor/reviewer agents remain responsible for delivery work.

### Control the runtime

The user can start root project execution; stop it; pause and resume the runtime globally; cancel a card or goal subtree when cancellation is supported for its current state; mark a goal as needing corrections, which causes the relevant parent planner to see the changed state and decide whether to reactivate that goal; and terminate a live runtime process. Resetting or restarting a planner's internal state is not a required user capability: if work should be replaced, the planner or Analyst can create a new card and cancel the old one.

- "Start the project." → if the project is idle or stopped, root execution begins and the Analyst confirms the new runtime state; if it is already running, the runtime returns an error or warning and the Analyst tells the user the system is already running.
- "Stop the project." → autonomous progress stops; the Analyst reports the stopped state.
- "Pause." / "Resume." → the runtime stops and resumes producing autonomous progress; the Analyst reports the new state.
- "Cancel goal-7." → if goal-7 can be cancelled in its current state, work on goal-7 is cancelled and the Analyst confirms; if it cannot be cancelled because it is currently running or contains the active leaf, the Analyst explains the limitation and performs zero mutation.
- "Mark goal-7 as needing corrections." → the goal is flagged for corrections-aware re-execution; the Analyst confirms.
- "Terminate process P-123." → the process is killed; the Analyst reports the exit status.

### Reconfigure

The user can change which model and provider profile is used for any role (planner, executor, reviewer, analyst), edit the failover order across providers for a role, manage MCP server entries (add, edit, remove), and adjust runtime and server settings. Configuration changes apply to subsequent relevant autonomous work without the user being asked to restart the server, unless the specific change cannot be applied without a restart; in that case the Analyst says so explicitly and asks the user before restarting.

- "Route the planner role to gpt-5.5-mini." → the routing is changed and the next planner invocation uses the new candidate.
- "Make Anthropic the second failover for the executor role, after OpenAI." → the failover order for that role is updated and the Analyst reports the new ordering.
- "Add an MCP server called weather that runs the following command ..." → the entry is added and subsequent Analyst and runtime operations can use it.
- "Remove the MCP server called weather." → the entry is removed and subsequent operations no longer use it.
- "Set the runtime autonomous-progress interval to 30 seconds." → the runtime setting controlling the cadence at which the runtime advances autonomous work is updated, and the new value takes effect on subsequent autonomous work.
- "Raise the maximum number of concurrent executor processes the server will allow to four." → the server-level concurrency setting is updated and subsequent process spawning honors the new limit.
- "Show me the current config." → the Analyst returns the project configuration with secrets redacted.

### Investigate and repair

The user can correlate a card failure with the originating planner or executor session, runtime events, and process output; ask for a diagnosis; and apply the fix in the same conversation.

- "Why did goal-7 fail and what should we do?" → the Analyst returns a narrative answer grounded in card history, runtime errors, agent sessions, and process output, and proposes concrete next actions (queue a directive notification, edit acceptance, mark the goal as needing corrections, create replacement work, cancel obsolete work, change model routing).
- "Apply that fix." → the proposed mutations are executed in the same turn.

### Multi-turn conversation

When the user's request is ambiguous, the Analyst asks one clarifying question rather than guessing. The next user turn carries the disambiguation forward. The Analyst remembers the immediate prior context within the session.

### Batch and set-based operations

A single natural-language request that describes a set ("every cancelled card", "every process older than ten minutes") is resolved in one user turn, not by asking the user to list ids.

### Chained reasoning across artifacts

A single request can walk across multiple artifacts (cards, history, agent sessions, runtime errors, process output) and produce a coherent answer or coordinated set of mutations. The user does not have to know the underlying decomposition.

## Persistent panel layout and contextual awareness

The operator web UI is a single screen split into two always-visible regions:

- The **Analyst panel** occupies the right 20–30% of the viewport. It hosts the chat history, the chat composer, and the current Analyst session.
- The **workspace area** occupies the remaining left 70–80% of the viewport. It hosts whichever runtime-state view the user (or the Analyst) has navigated to: cards, debug, files, agents, dashboard, and any read-only views nested within them.

Neither region is a drawer, modal, popover, slide-over, or other togglable overlay. There is no UI control whose action is to open, close, expand-to-full-screen, or otherwise toggle the visibility of the Analyst panel; the chat composer, history, and current session are reachable on every screen without a click. The "Discuss with analyst" affordance on cards and on other inspectable entities does not open or reveal anything: the Analyst panel is already visible. Its only behavior is to stage a contextual chat seed in the always-visible composer (a prefilled draft referencing the active entity), which the user can edit or send.

### Contextual awareness of the workspace area

On every user turn, the Analyst has, as part of its context, what the user is currently looking at in the workspace area. At minimum this includes:

- the active view category (cards, debug, files, agents, dashboard, or any equivalent top-level category that exists),
- the active entity identifier when applicable (card id, agent session id, file path, runtime card id, process id, and equivalents), and
- the active read-only refinement when applicable (for example, a debug-view filter currently set to "errors only").

The Analyst uses this context to resolve deictic phrases — "this", "here", "the current", "the one I'm looking at", "this card", "this agent", "the conversation on screen", "this file", "the current runtime activity" — and bare verbs like "summarize", "explain", "what happened here?", "why did it stop?". All of these resolve to the active workspace entity without the user restating its identifier. When the active context is ambiguous (for example, the user has multiple sub-entities visible at once), the Analyst follows the normal Multi-turn conversation rule: it asks one clarifying question rather than guessing.

If the user is on a view that has no specific entity in focus (an empty dashboard, a top-level cards tree with no card selected), a deictic phrase that requires an entity cannot be resolved; the Analyst says so and offers the natural next step (for example, "There's no card open right now — which card did you mean?"), rather than acting on the wrong scope.

The Analyst can also drive the workspace area in the opposite direction (see "Navigate the workspace area"): asking the Analyst to "open card code-3" or "show me the debug view" is sufficient to change what is rendered on the left, with no UI click required.

## UI Behavior

Principle: the UI shows state; the Analyst takes actions. Read-only refresh, filter, navigation, expand/collapse, copy-to-clipboard, route switching, and presentational toggles are part of the UI. Anything that mutates server state is not.

Every UI view that renders a card's children — the cards tree, board lanes, the detail-view child list, and any future child-rendering surface — presents those children in the explicit child order described under "Child ordering within a parent". The displayed order is the order the user has asked for (directly, or implicitly via creation), and is not re-sorted by the UI on a different key.

The UI MAY contain:

- read-only views of cards, the card tree, runtime state, processes, files, events, errors, history, and agent sessions, all rendered in the always-visible workspace area on the left;
- navigation, filtering, sorting, search, expand/collapse, and refresh of those views;
- copy-to-clipboard of any displayed value;
- a "Discuss with analyst" affordance on inspectable entities that, when invoked, stages a contextual chat seed in the always-visible Analyst panel (a prefilled draft referencing the active entity); it does not open, reveal, or toggle the panel, because the panel is always visible;
- the chat composer and chat history of the always-visible Analyst panel, which send turns to the Analyst;
- the bounded authentication-bootstrap affordances defined below.

The UI MUST NOT contain any control whose action is to toggle, open, close, expand-to-full-screen, or otherwise change the visibility of the Analyst panel. The panel is always visible by definition, and any such control would be either a no-op or a violation of the layout contract.

### Bounded authentication-bootstrap exception

The only user-visible control surface that is permitted to exist outside the Analyst is the minimum needed to bring an unauthenticated user to the point where the Analyst can answer. Specifically, the UI MAY offer:

- a login affordance for the user's own session (sign in, sign out);
- initial entry of the provider secret(s) required to authenticate the model used for the Analyst role itself, when no profile capable of running the Analyst exists yet, so that the user has any way to reach the Analyst at all.

Everything else, including but not limited to role routing (planner, executor, reviewer, analyst), failover ordering, provider profile selection once at least one Analyst-capable profile is configured, additional or subsequent provider secret entry, MCP server entries, runtime settings, server settings, card state (create, edit, reorder, move, delete), notifications (queueing), and runtime control (start, stop, pause, resume, cancel, mark-corrections, terminate process), is Analyst-only and MUST NOT be reachable through UI controls.

The UI MAY NOT contain any button, menu entry, context-menu action, drag-and-drop interaction, or keyboard shortcut that, when invoked, performs any of the Analyst-only actions listed above. The following mutating controls currently present in the operator UI must no longer exist after this change; they are listed here as evidence of what is being removed, not as instructions on how to remove them:

- new-card, action-menu, and delete-draft controls in [saivage-v3/web/src/views/CardsView.vue](saivage-v3/web/src/views/CardsView.vue);
- the "click + New Card" empty-state copy and any right-click context-menu action on cards in the cards tree view in [saivage-v3/web/src/components/cards/CardsTreeView.vue](saivage-v3/web/src/components/cards/CardsTreeView.vue) that performs a card mutation;
- start-project and stop-project controls in [saivage-v3/web/src/views/DashboardView.vue](saivage-v3/web/src/views/DashboardView.vue);
- the terminate-process control in [saivage-v3/web/src/views/DebugView.vue](saivage-v3/web/src/views/DebugView.vue);
- any residual mutating affordance discovered in [saivage-v3/web/src/components/cards/CardDetailView.vue](saivage-v3/web/src/components/cards/CardDetailView.vue) or [saivage-v3/web/src/components/cards/CardHistoryPanel.vue](saivage-v3/web/src/components/cards/CardHistoryPanel.vue).

Any existing analyst-drawer / toggle-analyst control in the workspace header or elsewhere in the operator UI must no longer exist after this change, since the Analyst panel is always visible and there is no drawer to open or close.

The user-facing controls previously associated with the v2 "operator note" concept — the per-note acknowledge, delete, and clear-all controls in [saivage-v3/web/src/views/DebugView.vue](saivage-v3/web/src/views/DebugView.vue) and the per-notification acknowledge control in [saivage-v3/web/src/components/cards/NotificationsPanel.vue](saivage-v3/web/src/components/cards/NotificationsPanel.vue) — also do not exist after this change, but for a more fundamental reason than "the Analyst owns mutation": notifications have no management surface to expose. There is nothing to acknowledge, delete, or clear, because notifications are queue-only, immutable, and ephemeral by definition.

Copy and tooltips that direct the user to any of the removed controls ("click + New Card", "can be acknowledged here", and any equivalent helper copy pointing at removed mutation paths) must also be removed, since the controls no longer exist.

## Failure Modes (User-Facing Behavior)

### Analyst LLM is unavailable

When no provider is configured for role `analyst`, or the configured provider fails to authenticate, the chat reply contains the explicit message `The Analyst is offline: no provider is configured for role=analyst, or the configured provider failed to authenticate. Configure a provider for role 'analyst' in the project configuration and try again.` (or an equivalent string that contains the phrase "analyst is offline"). The chat performs no mutations and runs no tools. There is no degraded keyword fallback.

### User asks for something the Analyst cannot do

The Analyst explains in plain language that the action is not supported and, when reasonable, suggests the closest available capability or proposes filing a card or queueing a notification as a workaround. The Analyst does not invent capabilities or silently substitute a different action.

### Multi-step action partially succeeds

When a single user turn maps to several internal steps and some succeed while others fail, the Analyst reports which steps succeeded, which failed, and why, in its final reply. It does not silently retry forever and it does not pretend the failed steps succeeded. It offers concrete next steps (retry, edit inputs, abandon).

### User asks for something dangerous or irreversible

For destructive or hard-to-reverse actions (deleting cards, bulk operations across many objects, stopping the project, restarting the server, cancelling a goal subtree), the Analyst confirms in conversation before executing. Confirmation is conversational, not a modal dialog. The observable outcomes of confirmation are:

- **Affirmation.** The user replies in the affirmative ("yes", "do it", "go ahead") in direct response to the confirmation. The Analyst then executes the action and reports the result.
- **Cancellation or refusal.** The user replies in the negative ("no", "cancel", "stop") or otherwise indicates they do not want to proceed. The Analyst performs zero mutations and explicitly reports that nothing changed.
- **Amendment.** The user replies with a modified intent ("instead, delete only goal-12"). The amended request supersedes the pending action: the Analyst re-states the new intent, re-confirms if it is still destructive, and only then executes. The original pending action is discarded without being executed.
- **Stale affirmation.** If the user replies affirmatively to a destructive prompt after enough turns have passed that the prompt is no longer obviously the immediate prior context, the Analyst restates what it is about to do and reconfirms before executing, rather than acting on a stale "yes".

### LLM proposes an unknown capability internally

If the model proposes an action that does not exist, the Analyst reports the limitation to the user rather than silently failing. From the user's point of view this is the same as "asked for something I can't do".

## Out of Scope

- Voice input or voice output.
- Multiple concurrent users editing the same project through the same Analyst session at once.
- The Analyst spawning its own autonomous workers; delivery work is delegated through cards and runtime controls.
- Programmatic, non-conversational user-facing control APIs that bypass the Analyst.
- Migration shims that translate old button clicks into Analyst turns, or preserve removed surfaces under deprecation headers.
- A user-managed "notification" object class, an inbox, an acknowledge action, or any other notification management surface. Notifications are queue-only, immutable, ephemeral, and not user-managed by design.
- A confirmation modal UX inside the chat; confirmation is conversational.
- Arbitrary cross-tree re-parenting of cards. Moving a card to any parent other than one of its current siblings (move down) or its current grandparent (move up) is not supported, and there is no plan to support it.
- Treating child order as a hard scheduling constraint that the planner must obey; order is a presentation convention, not a contract on dispatch sequence.
- Telegram-specific UI parity audit (the telegram surface routes through the same Analyst; any telegram-specific render path that bypasses the Analyst is tracked separately).
- A drawer-style or otherwise togglable Analyst panel. The panel is always visible on the right; there is no collapsed or hidden mode.
- A prescribed mobile or narrow-viewport layout. This SPEC defines the layout for the operator web UI at typical desktop widths; behavior at substantially narrower widths is left unspecified at the functional level (see Open Functional Questions).

## Acceptance Criteria

Each item must be verifiable by a tester with only the rendered web UI and the Analyst chat.

### UI removal

- The operator web UI has no button, menu entry, context-menu action, drag interaction, or keyboard shortcut that, when invoked, performs any Analyst-only action (card create/edit/reorder/move/delete, notification queueing, runtime start/stop/pause/resume/cancel/mark-corrections/terminate-process, model routing, failover order, MCP entry management, runtime or server settings change).
- The only mutation-capable controls reachable from the rendered UI outside the chat are the bounded bootstrap affordances: a login/sign-out affordance and an initial provider-secret entry needed when no Analyst-capable provider is configured yet.
- No "Start Project" or "Stop Project" control exists in the rendered web UI.
- No "New card", "Create card", card action-menu, or delete-draft control exists in the rendered web UI.
- No "click + New Card" copy exists in the cards tree view, and the cards tree view exposes no context-menu action that performs a card mutation when a user right-clicks a card.
- No "Terminate process" control exists in the rendered web UI.
- The legacy v2 per-note "Acknowledge", "Delete", and "Clear all" controls are absent from the rendered UI, and no equivalent per-notification "Acknowledge" control exists in the notifications panel; subtitles and helper copy no longer direct the user to such controls.
- Read-only affordances continue to work: refresh, filter, sort, search, expand/collapse, copy-to-clipboard, navigation between views.

### Persistent panel layout

- Loading the operator web UI (at typical desktop widths) shows both the left workspace area and the right Analyst panel at the same time, without any user click; the chat composer is reachable and focusable on first paint.
- The Analyst panel occupies the right 20–30% of the viewport and the workspace area occupies the remaining left 70–80%; neither is hidden behind the other.
- There is no button, menu entry, keyboard shortcut, or other control whose action is to toggle, open, close, expand-to-full-screen, hide, or otherwise change the visibility of the Analyst panel; in particular, no "open analyst", "close analyst", or analyst-drawer toggle control exists anywhere in the rendered UI.
- The "Discuss with analyst" affordance on an inspectable entity, when invoked, stages a contextual chat seed in the always-visible composer (a prefilled draft referencing the active entity) and does not open, reveal, or toggle any panel; the Analyst panel was already visible before the click and remains visible after.

### Contextual awareness

- With card X open in the left workspace area, asking the Analyst "what is this card blocked on?" produces an answer about card X, without the user restating its id.
- With agent session S open in the left workspace area, asking "why did the agent decide to do Y?" produces an answer about session S, without the user restating its id.
- With the debug view filtered to errors in the left workspace area, asking "show me the most recent error" produces an answer scoped to that filter context.
- With a file F open in the left workspace area, asking "summarize this file" produces a summary of F, without the user restating its path.
- When the user is on a view with no specific entity in focus and uses a deictic phrase that needs one, the Analyst does not act on the wrong scope; instead it explicitly says no entity is currently in focus and asks which one was meant.

### Analyst-driven navigation

- Asking the Analyst "open card code-3" navigates the left workspace area to card code-3's view AND the Analyst confirms in chat; the user does not have to click any navigation control.
- Asking the Analyst "open the debug view" navigates the left workspace area to the debug view AND the Analyst confirms.
- Asking the Analyst "open the planner session that last touched goal-7 and queue context saying we should retry with smaller batches" navigates the left workspace area to that session AND performs the mutation in the same turn AND the Analyst reports both outcomes.
- Asking the Analyst "go back to where I was before" returns the left workspace area to the previously active view and entity AND the Analyst confirms.

### Conversational equivalence

The Analyst can perform every action whose UI control was removed. Each of the following utterances, in plain English, produces the described observable outcome:

#### Cards

- "Create a child card under goal-7 titled 'Investigate slow planner'." → a new child card is created under goal-7, appended at the end of goal-7's child list, with that title; the Analyst reports the new id.
- "Edit goal-7: set priority high and add tag urgent." → goal-7's priority and tags are updated; the Analyst reports the new values.
- "Move goal-19 into goal-18." → goal-19, previously a sibling of goal-18, becomes a child of goal-18; the Analyst reports the new parent. (Bounded move down: into a current sibling.)
- "Move goal-19 out to be a sibling of its parent." → goal-19's new parent is the grandparent of its previous position; the Analyst reports the new parent. (Bounded move up: out to grandparent.)
- "Move goal-19 under goal-42." → if goal-42 is neither a current sibling of goal-19 nor the current grandparent of goal-19, the Analyst refuses the request with a clear explanation that moves are restricted to the parent-child axis (into a current sibling, or out to the current grandparent), and performs zero mutations.
- "Reorder goal-19 to be the first child of its parent." → goal-19 remains under the same parent and its position within that parent's child list becomes first; the Analyst confirms the new order, and the displayed order of that parent's children reflects the change.
- "Put the research card right after the architecture card under goal-4." → both cards remain children of goal-4 and the research card is positioned immediately after the architecture card in goal-4's child list; the Analyst confirms the new order, and any view rendering goal-4's children reflects the change.
- "Why did the planner just work on goal-B before goal-A even though I put goal-A first?" → the Analyst explains that child order is a presentation convention and the planner is free to dispatch out of order; reordering does not constrain dispatch sequence, and the user-issued reorder remains in effect for display.
- "Delete every cancelled card." → all cancelled cards are deleted in one turn; the Analyst reports the count and ids.

#### Notifications

- "Queue a notification for goal-7 saying: prefer streaming over batched calls in the next run." → a notification with that content is queued on goal-7 for the current paused or next future main agent session for that card; the Analyst confirms.
- "Queue a notification for goal-19 saying: disregard my previous notification about streaming." → a follow-up notification is queued on goal-19; the Analyst confirms.
- "Show me the most recent planner session for goal-7 and tell me whether my queued notification was delivered." → the Analyst inspects the relevant agent session transcript and reports whether the notification content appears in it.
- With an executor session for goal-7 currently paused, "Tell the current executor for goal-7 to prefer streaming over batched calls, then resume" queues the context for that paused session through the Analyst, resumes through canonical runtime control, and the executor receives the context after resume. The Analyst does not perform the delivery work itself.

#### Runtime control

- "Start the project." → root execution begins; the Analyst confirms the running state.
- If the user asks to start the project while it is already running, the runtime returns an already-running error or warning, the Analyst reports that state, and no second root run is created.
- "Stop the project." → autonomous progress stops; the Analyst confirms the stopped state.
- "Pause." then "Resume." → the runtime pauses and resumes; the Analyst confirms each transition.
- "Cancel goal-7." → if goal-7 is cancellable in its current state, it is cancelled; if it is running or contains the active leaf, the Analyst explains that cancellation is not supported for that active scope and performs zero mutation.
- "Mark goal-7 as needing corrections." → goal-7 is flagged for corrections-aware re-execution; the Analyst confirms.
- "Terminate process P-123." → the named process is terminated; the Analyst reports the exit status.

#### Reconfiguration

- "Route the planner role to gpt-5.5-mini." → role routing is changed; the next planner invocation uses the new candidate; no server-restart prompt appears unless the change inherently requires one.
- "Make Anthropic the second failover for the executor role." → the failover ordering for that role is updated; the Analyst reports the new ordering.
- "Add an MCP server called weather that runs the following command ..." → the MCP entry is added and is usable in subsequent Analyst and runtime operations.
- "Remove the MCP server called weather." → the MCP entry is removed and is no longer usable.
- "Change the runtime autonomous-progress interval to 30 seconds." → the runtime setting controlling the cadence at which the runtime advances autonomous work is updated, and the new value takes effect on subsequent autonomous work.
- "Raise the maximum number of concurrent executor processes the server will allow to four." → the server-level concurrency setting is updated; subsequent process spawning honors the new limit; the Analyst reports the new value.
- "Show me the config." → the Analyst returns the project configuration with secret values absent or visibly redacted.

#### Investigation

- "Why did goal-X fail and what should we do?" → the Analyst returns a narrative answer grounded in card history, runtime errors, and agent session data, and proposes concrete next actions.
- "Apply that fix." → the proposed mutations are executed in the same conversation and the Analyst reports the outcome of each step.

### Confirmation behavior

- For destructive or bulk actions, the Analyst confirms in conversation before executing.
- Asking the Analyst to delete card X, then replying "yes, delete it" to the confirmation prompt in the next turn, causes card X to be deleted, and the Analyst reports the deletion in the same chat turn.
- Replying in the negative to a confirmation results in zero mutations; the Analyst explicitly reports that nothing changed.
- Replying with an amended request (for example, narrowing the scope) supersedes the pending action: the Analyst re-states the new intent, reconfirms if still destructive, and only then executes. The original action is not executed.
- Replying affirmatively to a destructive confirmation after the topic has shifted causes the Analyst to restate the pending action and reconfirm before executing, rather than acting on a stale "yes".

### Failure and audit

- When the analyst provider is unavailable, the chat reply contains the explicit phrase "analyst is offline" (or equivalent), performs zero mutations, and does not invoke any degraded keyword-driven behavior.
- A user inspecting the rendered web UI can find no path — no button, menu, context menu, drag interaction, or keyboard shortcut — that performs any Analyst-only action; the same actions are reachable conversationally through the chat, with the resulting state changes observable in the read-only views.
- The control-action audit log records every mutating Analyst action with `actor='analyst'` and the originating surface (web chat, telegram), and is inspectable through the Analyst on request.
- No emojis appear in user-visible strings introduced or modified by this change.

## Open Functional Questions

1. Should the Analyst confirm irreversible operations on every card type, or only for hard deletes and bulk operations? "Delete one cancelled card" feels lighter than "delete all cancelled cards" — is that distinction part of the contract or left to the model?
2. Should the user be able to mutate non-secret project configuration purely through free-form natural language ("make the planner use a smaller model"), or should the Analyst always echo the intended structured change and ask for explicit confirmation before applying it?
3. Should there be one persistent Analyst session per project, or should the user be able to open multiple named conversation threads against the same project?
4. When a configuration change requires a server restart, should the Analyst always ask the user, or should an explicit user preference ("auto-restart on config that needs it") be honored without a per-change confirmation?
5. Should the read-only UI offer a generic recent-runtime-events view (drawn from platform events such as card transitions, process starts, reviewer assessments) as a passive activity stream — and if so, what is the minimum useful scope? Such a view, if it exists, presents general runtime activity only; it does not present notifications as inspectable objects, since notifications are ephemeral by definition.
6. Should the Analyst expose a dedicated "inspect delivery of my queued notification" shortcut, or is the existing agent-session inspection capability sufficient on its own?
7. When the planner dispatches children in an order that differs from the user-visible child order, should that divergence be surfaced to the user as a first-class observation (for example, as part of the cards view or the planner-session inspection), or is it sufficient that the user can ask the Analyst about it on demand?
8. On viewports narrower than a typical desktop (for example, phone-class widths), should the left workspace area collapse so that the Analyst panel remains the primary surface, should the Analyst panel collapse so that the workspace area remains primary, or should both regions remain side-by-side at reduced widths? This SPEC currently leaves narrow-viewport behavior unspecified.

Companion documents covering how this is built and rolled out — an architectural design and a staged implementation plan — will live alongside this spec in [saivage-v3/SPEC/analyst-as-control-surface/](saivage-v3/SPEC/analyst-as-control-surface/) once they are written.

ROUND: 7
