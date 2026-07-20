# Operator UI Specification

Tombstoned cards are absent from active card/detail/tree, record, history, version, diff, and recovery projections and return the same active not-found contract as an unknown ID. A tombstoned ancestor never authorizes descendant access. The current UI has no deleted-card state, retained-evidence browser, restore action, or forensic view. An already known exact role conversation remains directly readable and appendable after tombstone, but it is omitted from aggregate inventory.

Cards expose immutable hierarchical Stable IDs whose segments come from each parent's local spreadsheet sequence, plus mutable display-path labels derived in the client from active indices in represented committed parent order. Consumed namespace segments do not give UI membership or order: each successful `GET /api/cards/:id/children` response owns one immutable `{ parent, children }` hierarchy slice for that stable parent ID, and its ordered active `children` rows are the sole render authority for those edges. Raw child IDs are only expansion hints until that exact slice is loaded. Selected detail is a separate object populated only by `GET /api/cards/:id`; neither detail nor hierarchy completion updates the other authority. Incomplete, unlinked, and retained tombstoned namespaces produce no inferred row, warning, repair, or compatibility state.

Application bootstrap is the sole initial root owner and requests only `project/children`; Cards view mount does not issue a second request. Expanding an idle node requests only that node, collapse requests nothing, and ordinary re-expansion consumes its accepted slice. Same-parent initial callers share one exact keyed request-owner promise. A newer exact refresh aborts and replaces that owner; success, failure, finalization, and owner removal update state only while the exact object remains current. Reset aborts and clears all hierarchy, detail, record, history, entry, and diff owners before clearing accepted state, so old completions cannot alter reset or later state. Different exact scopes remain independent.

On a cold deep route, Cards loads root and each required ancestor-parent slice in order, and proceeds only across membership represented by an accepted non-stale containing slice. If a stale or refresh-failed slice blocks the next edge, reveal stops without requesting the descendant, inferring membership, or retrying. A successful replacement of a required ancestor invokes one continuation of the existing reveal action; it can follow multiple newly represented levels, requests only the next idle ancestor slices, shares already in-flight exact owners, and remains bounded by the maximum five-segment card ID. An irrelevant sibling replacement does nothing, and failed-stale membership cannot continue until explicit Retry succeeds. Current detail may still return 200 and remain visible while no selected tree row or Path can be rendered. A current-owner detail 404 instead retains only route identity plus typed terminal not-found, aborts and clears detail, records, history, selected entry, and diff, and neither retries nor certifies or clears hierarchy. Rapid route changes use separate action-local monotonic ownership: a superseded reveal stops after each await and before issuing any later ancestor request, but it never aborts shared children work or changes request/slice authority. Root and current-invalid Cards routes clear selected-card ownership and supersede reveal while retaining hierarchy. Route-owned selection, represented ancestor reveal, expand/collapse, independent loading/errors/scrolling, direct navigation, Back behavior, and Files API/VFS/client shapes remain; Files applies the canonical-card virtual projection specified below.

Reorder exact-reads one parent and its committed active children. A real active reorder appends one complete parent version with the requested active IDs first and all retained non-active links afterward in stable prior order; it writes no child stream and changes no ID, namespace, parent relationship, or session. An active-order no-op appends nothing and causes no Analyst change propagation, status mutation, or notification. `delete_card(ids)` is one all-request subtree-union operation: duplicate and overlapping roots occur once, every request/permission/dependency constraint is preflighted before mutation, and successful results follow deterministic dependent-before-dependency and child-before-parent tombstone order. Preflight has no partial success; only an append I/O failure can leave a valid committed prefix, with no event or hint for the uncertain append. Agent inventory derives only exact eligible role streams from active cards plus `analyst:global`.

Card kind is selected through card creation and is read-only thereafter. Cards has no type-edit affordance, and neither Analyst nor planner edit actions can change type. The UI adds no action, warning, fallback rendering, or compatibility treatment for this invariant.

Analyst UI operations accept no session argument; parsed server contracts are exactly `analyst:global`. Generic Agent selection, detail, conversation, LLM exchange, and live-sync use the shared exact role/global identity union. A malformed, empty, or multi-valued direct Agent route renders an invalid-session state without mounting detail, making Agent API calls, selecting store state, subscribing, redirecting, or falling back. Invalid raw subscription input receives no acknowledgement. There is no identity aliasing or UI normalization.

Direct persistence operations fail at their owning request and do not poison unrelated later mutations through a persistence-health latch. Provider-routing availability is explicitly live process-local state and resets after process restart; the UI must not present it as historical or durable. Auth-profile refresh uses strict direct file reads and optimistic complete replacement, with concurrent last-completed-write-wins risk left to operator retry. Returned `work:///tmp/stash/...` URLs retain their existing presentation but refer to disposable work output with no retention guarantee.

Status: current functional UI authority.

Last updated: 2026-07-20.

## 1. Purpose

The operator UI shows Saivage state and hosts the Analyst. It is projection-oriented and Analyst-mediated by default, with the Dashboard's direct **Stop project** and bearer-only, capability-gated, exactly confirmed **Restart server** actions as the two runtime-control exceptions.

The UI must help the user understand what the autonomous runtime is doing, inspect cards, record-backed card documents, files, and processes, and stay oriented during Analyst conversations. Ordinary mutations still go through the Analyst.

## 2. Layout

At typical desktop widths, ordinary workspace routes display a single screen with two always-visible regions:

- A left workspace area, roughly 70-80% of the viewport.
- A right Analyst panel, roughly 20-30% of the viewport.

On those routes, the Analyst panel contains the current Analyst session, chat history, and composer. It is not a drawer, modal, popover, slide-over, or hidden panel. At desktop widths there is no control whose job is to open, close, hide, reveal, expand-to-full-screen, or toggle the Analyst panel.

At narrow widths on ordinary workspace routes, the shell collapses to a single column and exposes a presentation-only `Workspace` / `Analyst` pane switch so the user can choose which region is visible. The switch changes only the local layout; it does not mutate server state and does not turn the Analyst into a modal or separate control surface.

Within the Cards workspace at desktop widths, the card tree and selected-card detail are independently vertically scrollable panes. Tree overflow does not move the detail, detail overflow does not move the tree, and normal Cards content does not create one combined Cards/page scrollbar. A valid loaded tree remains mounted, interactive, and at its existing scroll position while selected-card detail loads or fails; detail loading and error presentation is confined to the detail pane. A route outside the current card-ID grammar makes no detail request and shows the same **Card not found** state as a typed detail 404, explaining that the link may be obsolete after a reset. The URL is not normalized or automatically navigated, no Retry or global refresh is offered, and explicit **Back to Cards** pushes `/cards` with ordinary Back/Forward history. At widths below the Cards split breakpoint, `/cards` shows the tree alone and `/cards/:id` shows the detail alone; exactly the shell's **Back to Cards** action restores the tree, while desktop exposes exactly the state-local action.

On ordinary workspace routes, the current project name is shown in a slim header at the top of the Analyst panel only, occupying the top of the Analyst column rather than a full-width page bar.

The one layout exception is the canonical Agents detail route for the exact session `analyst:global`. On that route, the workspace hosts the read-only Analyst conversation-inspection component, which may show loading, unauthorized, error, empty, or loaded-conversation state and has no chat composer. To avoid duplicating that conversation surface, the shell omits the persistent Analyst panel, including its project-name header and composer, and omits the narrow `Analyst` pane switch. Navigating to any other route, including another agent's detail, restores the persistent panel/composer surface without guaranteeing loaded transcript data, authorization, or writable sending.

## 3. Workspace Area

The workspace area renders read-only projections of runtime state, including:

- lazy immediate-child hierarchy slices and separate current card detail;
- distinct structured card state, card `working_status`, accepted `result`, versioned card document records such as `brief.md`, `status.md`, and `review.md`, specialized result fields, and card/record history when available;
- the lazy card tree;
- runtime dashboard/state;
- agent sessions and transcripts;
- files and file previews;
- processes and process output;
- runtime events, errors, debug views, and control-action audit records;
- configuration projections where appropriate.

These projections combine strict card/conversation reads with process-local runtime state. There is no persisted runtime-state, actor-snapshot, recovery-diagnostic, role cursor, or conversation-version authority.

The web client has one owner for each separate core resource family: the runtime store owns `/api/state` together with `/api/runtime/status`; CardStore alone owns response-owned hierarchy slices, selected detail, all three selected latest-closed record slots, separately lazy selected history and entry, and the selected current-relative diff; and the agent store owns `/api/agents`, selected conversations, and selected LLM exchanges. Records components present CardStore state and actions and own no request or cache. Debug's State presentation uses runtime and agent owners and its distinct diagnostic resources; it has no card inventory, histogram, complete child projection, or duplicate aggregate owner. Application bootstrap starts runtime, one root hierarchy request, and agent reads independently of WebSocket availability. Token/config identity change marks the replacement socket's next successful open baseline-only, resets CardStore, and performs one ordinary root load. Every reconfiguration resets this baseline-open suppression; the following open issues no Cards healing request whether root is pending or accepted, and later reconnect opens heal loaded scopes. Loaded hierarchy titles may decorate Dashboard or Agents, otherwise those surfaces show the stable card ID. Files and Analyst child shortcuts consume only an explicitly loaded exact slice and do not trigger or imply a complete inventory. `/api/state` contains no `cardIndex` or global card counts.

Cards WebSocket invalidations are exact `children(cardId)`, `detail(cardId)`, `history(cardId)`, `diff(cardId)`, or `record(cardId,slot)` freshness hints. They refresh only an accepted exact hierarchy slice or the currently selected accepted and visible detail, record, mounted history, or displayed diff scope; hidden history, unselected cards, and unloaded branches make no request. A reconnect snapshots those same loaded/visible scopes and starts at most one read for each, without discovery or global traversal. Scopes already stale after failed refresh wait for operator Retry rather than reconnect retry. Accepted tree, records, history, diff, and detail after a non-404 refresh failure remain mounted with scope-local stale/error state and exact **Retry**. The exception is a current-owner selected-detail 404: it clears the complete selected-card resource scope, installs fresh non-retryable typed absence, and leaves no selected-card invalidation/reconnect scope until a new explicit route fetch succeeds. Accepted hierarchy remains independent and eligible for its ordinary exact refresh. There is no polling, timer, automatic retry, trailing request, replay, or broad Cards refresh.

Authored close invalidates only the selected exact accepted slot when its card is selected; it does not refresh sibling record slots or card-version history. Authored open/edit/discard do not change the latest-closed UI projection. Record reads are independently abortable per slot, and selection change aborts/removes old-card owners before loading the new card. Even a late completion after abort cannot install old content, empty state, loading, error, or stale state into the new selection. Record 404 presentation follows this complete status-and-state table and never parses backend message text:

| Request state and outcome | UI/CardStore state |
| --- | --- |
| Initial required `brief` 200 | accepted content |
| Initial required `brief` 404 | required-record initial error; no accepted value |
| Initial optional `status`/`review` 200 | accepted content |
| Initial optional `status`/`review` 404 | accepted empty, current and successful |
| Any refresh 200 | replace with accepted content; clear stale/error |
| Refresh 404 after accepted content, all slots | retain exact content visibly stale with error and exact Retry |
| Refresh 404 after accepted-empty optional `status`/`review` | retain empty as unchanged success; clear transient stale/error and show no Retry |
| Any non-404 refresh failure after accepted content or empty | retain exact accepted state visibly stale with error and exact Retry |

Initial non-404 failure is an initial error, and required `brief` never accepts empty. Closed authored records are append-only: accepted content cannot legitimately disappear from an active card, but tombstone opacity and optional absence share the fixed HTTP 404, so accepted content must not be erased. A malformed canonical record stream, I/O failure, or other unexpected record-read failure is not absence and reaches the opaque strict HTTP 500 boundary; the UI never depends on exception prose. An already-empty optional slot still represents unchanged absence after 404. These are semantics of a record request while active detail exists; parent-detail 404 teardown clears record ownership as selected-card cleanup and does not reinterpret any record response. Independently refreshed hierarchy/detail communicates tombstone or path inaccessibility.

Every displayed **Diff vs current** uses request identity `{cardId,fromSeq,to:'current'}` and literal query `to=current`, regardless of selected-detail version or completion order. The numeric response `to` is evidence only. A diff refresh failure retains its rows visibly stale with exact Retry.

The runtime dashboard is current-state-only. It shows process-local runtime status and exact active-card evidence without a runtime-state file, command/run ledger, control audit, or durable actor cursor. The strict runtime-status debug projection gives every card actor required `processState`: null while its processor is structurally deferred, otherwise the planning/terminal family, exact live state ID and kind, entry or terminal identity where applicable, and a nonnegative-safe-integer `executionOrdinal` for nodes. This is transient observability, not a visual process editor or resumable position. The runtime state's `current_card_id` is the UI's sole current-card source. The displayed Started value is the stable lifecycle-lock start time and does not change on refresh, Pause/Resume, leaf transition, Stop, or another Run in the same server process. Dashboard does not synthesize an active phase, and Debug does not synthesize a current agent session. It exposes one **Stop project** action while starting/running/pausing/paused; closing, stopped, and error disable it. Stop is containment, not domain cancellation. Natural stopped projection with null current card appears only after the complete parent-owned child-to-root unwind and strict root finish; root completion never rediscovers a leaf. A later Run validates and resets the complete durable running chain, publishes stopped leaf-to-root, and activates only project through configured STOPPED; descendants stay stopped until ordinary immediate-parent activation, and the deepest old node is not resumed. These lifecycle semantics change no public UI, REST, or WebSocket shape or control.

The Dashboard sends Stop as a bodyless request without JSON `Content-Type`; bearer `Authorization` and ordinary request headers remain independent and are preserved. The distinct **Restart server** action is rendered only when the required runtime-status field `restart_server_available` is true. `DashboardView` owns the direct browser prompt, accepts only exact `RESTART SERVER`, and initiates the strict JSON request `{confirmation:'RESTART SERVER'}` with JSON `Content-Type` to the auth-gated `restart_server` operation. The Dashboard owns only that prompt and direct request initiation; the application-owned `RestartPort` owns terminal coordination shared with the separate Analyst restart path. When false, the UI does not offer the action; a stale direct request still receives typed `restart_unavailable`. Stop project never calls or aliases Restart server.

`restart_scheduled` acknowledges accepted asynchronous intent, not replacement readiness. Terminal closer/leaf warnings do not retroactively alter acknowledgement or normal restart behavior. The internal immutable shutdown report is for direct App callers and process adapters; it is not a card outcome, containment result, or operator-editable state.

Agent conversation surfaces render the one stable append-only session in physical row order. They may show `model_recovered` uncertainty, the original-call paired failed tool result, node/edge transition rows, node prompts, correction rows, and a later fresh UUID continuation as separate facts; source UUIDs have no sequence or timestamp meaning. Notification-defeated candidates remain visible as ordinary failed `emit_result` rows followed by exact operator context and correction. Reviewer revision routes appear as ordinary transition context containing the accepted review record URL and summary; no special UI row type, durable reviewer phase, or recovered outcome exists. Run recovery never shows a reconstructed child result: every unmatched parent call is ordinary interruption, project begins through STOPPED, and descendants can resume only through later ordinary parent activation.

Agent-list, selected-conversation, and selected-LLM-exchange resources have independent loaded/loading/refreshing/error state. An accepted empty agent list is distinct from an initial failure. A same-session conversation refresh keeps the last accepted transcript visible on non-abort failure and reports the refresh error separately from an initial-load failure. An LLM-exchange 404 is an accepted loaded-empty result, including on refresh where it authoritatively clears an older exchange; another refresh failure retains the accepted exchange or accepted-empty result and reports only a refresh error.

Debug keeps explicit session selection as presentation intent and derives its effective session as that explicit ID when it remains in the canonical agent list, otherwise the first row in canonical list order. Disappearance falls back without erasing intent, so reappearance restores the explicit session; an accepted empty list mounts no detail. The effective session and detail kind form the key of one Debug detail component. The primary Agents conversation is likewise keyed by route session, and its conditional Raw LLM Exchange panel is keyed by session. Each keyed conversation lifetime claims a fresh opaque current-consumer token, subscribes before fetching, unregisters before token-guarded clear, and aborts/invalidates the departed request. Exchange lifetimes claim and clear their independent token without opening a conversation subscription. Stale callbacks, completions, and delayed cleanup therefore cannot change or clear a newer consumer, and no consumer registry or copied agent rows exist.

Agent badges are exactly **active**, **waiting**, and **inactive**. Agent lists omit tombstoned-card sessions; direct navigation to a known tombstoned session remains readable with the same inactive metadata and conversation projection. Old roles and retained failed/fatal sessions are inactive. There is no completion/attention grouping, completed-session timestamp, or terminal session styling. Active uses the shared timeline footer labelled “Active”; waiting renders its one exact pending tool; inactive renders no liveness footer or activity-only round. Compaction remains active rather than becoming a public subphase.

The Agents UI uses only Agent session/conversation projection, including Analyst when its durable aggregate row exists. It never consumes or recreates `runtime.status.actorRuntime.agents`, because runtime status contains only pause mode and card actors. Analyst chat obtains its detail session, transcript, and activity only from `chats.get`; an uncreated conversation remains null/inactive without a synthetic list row or timestamp. On mount it registers the conversation subscription immediately, then starts independent `chats.list` and `chats.get` reads, so initialization works without WebSocket. A subscription acknowledgement carries no state and can request only another store-owned detail read. One latest-request owner governs initial, invalidation, manual, and send-follow-up reads, so superseded responses and errors cannot commit.

Analyst active/waiting activity feeds the same timeline/footer as Agent detail. The shell activity dot appears only for exact active/waiting; inactive or absent shows no dot. `Sending…` remains transport progress for duplicate-submit prevention and button state only. It never displays “thinking,” creates activity, or changes liveness.

When an active provider turn is in backend transient recovery, the operator UI should continue to show the card/agent as active or running and must not invent an immediate terminal failure. The backend may be retrying the same candidate first for non-rate-limit transient failures, trying later alternates after a rate-limit/`Retry-After`, or waiting under the fixed two-hour deadline. No new API fields, countdowns, or UI controls are required; terminal failure appears only when the backend reports exhaustion/deadline/cancellation or a permanent/non-waitable provider, input, protocol, configuration, authentication, or local setup failure.

A strict raw provider rejection, malformed provider-attempt envelope, pre-provider failure, processor failure, or executor-cleanup failure is not indefinitely active work. The backend publishes the selected failed card lifecycle before resolving the waiting parent's existing failed `activate_card` tool result and before releasing the completed activation owner. Card and actor projections therefore do not retain stale `running` state for a normally published failure; existing REST refetch and invalidation behavior exposes the corrected durable card without a UI control, color, or API-shape change. Fatal-handler server logs are not a durable UI diagnostic; these strict failures add neither a synthetic provider exchange to Raw LLM Exchange nor a `model_issue` entry.

If terminal lifecycle publication itself throws, visibility is deliberately qualified: REST may show either the prior running version or a terminal version that became canonical before a later callback failed. The runtime does not reread to infer success, does not report the activation terminal result to its parent, and does not naturally release that owner. This persistence-failure case adds no alternate UI status or API field.

The backend exposes append-only compacted conversation rows for future `CompactedCluster` rendering. Each row is a strict `context_compaction` entry with `role: 'system'`, a `compacted` round ID, and canonical-JSON string `content`. Raw views show that exact JSON string. Its one ordered `summaries` array contains an optional leading merged group and individual groups; round segments' `source_message_ids` are the sole covered-source identity, alongside completeness, group hashes, summary prose, evidence, retained static IDs, boundary, and applied policy. The policy contains only mode, band, input budget, canonical static estimate, trigger/completion fractions, selected merge/summary fractions, and snap; derived completion, trigger, hard-ceiling, tail, and middle token values are not raw payload fields. Provider/debug projections show one system-context unit derived from validated groups. Round labels, repair anchors, cutoff, and rendered text are not payload fields. The physically latest validated row supersedes earlier metadata without versions, generations, caches, or replacement, while every complete row must validate against only physically preceding source rows. Rows carrying superseded derived policy fields fail strict reads and require the documented stop/reset/start cutover.

This payload is a reset-only durable-format cutover. The UI does not compatibility-render old generated rows: operators stop the service, preserve configuration, credentials, operator inputs, source, and documentation, run the current built reset, and start the current binary.

Boot requires `compaction.enabled: true`, route-independent `compaction.input_budget_tokens`, and one exact structured summarizer candidate. `/api/config` therefore exposes a complete enabled policy on a running server. `/api/providers` uses only the Registry-backed ordered structured candidate projection: `account: null` means implicit, while explicit `_implicit` and `_` remain exact names; no account-only list or internal sentinel is exposed. Runtime status has no disabled-protection state because that server cannot boot, and the UI provides no warning-only mode or configuration editor. The effective configured Analyst output request must fit the configured completion reserve at startup. Exact role prompt and ordered tool capacity is prepared for every persisted planner, reviewer, executor, and Analyst conversation turn; an Analyst submission prepares before its marker/workspace/user batch is appended and retains that value across distinct tool continuations. Preventive compaction runs transparently on its initial and continuation provider calls. An eligible context rejection may yield exactly one forced canonical compaction and same-input provider retry. An accepted Analyst tool and its one result are outside that retry seam and are never replayed, rebroadcast, or duplicated. Clean no-smaller ends without a retry, a second rejection is terminal, and fatal local/cancellation outcomes use existing failure visibility.

Automatic Analyst protection changes no operator interaction: there is no manual compact action, new `compacting` phase/status, warning, API/WebSocket field, or altered send, cancellation, tool, restart-confirmation, or restart-scheduling behavior. Raw conversation views expose the existing durable canonical row and rendered views expose the existing synthetic context. Direct summarizers remain fixed-route, unprepared, nonpersisting, and without self-compaction or replay.

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

Card tree rows show only the depth-indented state ball, human-friendly display-path level number when represented, card title, and card kind. Tags and priority are not displayed in card rows or card detail. Card detail renders only retained actions that the backend authorizes for that card. Blocked warning state, stopped neutral state, error/stale state, action count, phase, completion, and blocking-child presentation derive from their explicit fields. The card action vocabulary is exactly `card.start`, `card.create`, `card.cancel`, `card.delete`, and `card.reorder_child`. It never contains `card.restart`, and a blocked card exposes neither start nor restart: only its exact parent planner can re-enter it through `activate_card` and configured `BLOCKED`. Those projected card actions are distinct from the Dashboard's capability-gated, exactly confirmed **Restart server** control. Card detail does not render Related or Hierarchy sections; represented children and ancestors remain navigable through the lazy card tree. Cards has no search, status, type, Clear, or other filter controls and does not claim that currently loaded slices are a complete project inventory. The former card-inventory Timeline route and primary navigation item do not exist. Debug's distinct event timeline and agent-conversation timelines remain.

The exact opaque card ID in `/cards/:id` is the only selected-detail authority. A tree row receives visible selected treatment and semantic `aria-current` only when that ID is represented by loaded hierarchy slices; its lifecycle state ball remains independently visible. For rendering, represented ancestors of that route card are forced open even when explicit collapse intent would otherwise hide the selected row. That route-required reveal takes precedence only while needed: explicit expand/collapse intent remains recorded throughout detail loading or failure and resumes after navigation leaves the branch. Selection is not inferred from the last click or synchronized as a second identity, and the row is not scrolled into view.

The project row expands by default once its root hierarchy slice arrives; explicit collapse intent remains recorded while represented route ancestors may be forced open. Exact invalidation or reconnect may replace an accepted slice while preserving the mounted tree and its expansion/scroll state; a successful relevant ancestor replacement may continue bounded route reveal as specified above. Detail returns only current card state and never children, descendants, embedded history, or authored records. Version history remains lazy: opening its disclosure requests descending embedded card-version headers, and selecting one version requests its immutable entry plus a current-relative diff. Closing/unmounting history clears its loaded visibility so reconnect does not fetch it. Canonical non-empty `brief.md`, `status.md`, and `review.md` content is fetched separately through the Records resource and rendered as Markdown; card-version history never reconstructs authored-record revisions. An out-of-code `[[card:<id>]]` reference remains a card-route link. Following that link changes `/cards/:id`, and the same bounded route reveal applies. Card Conversations filters the canonical agent-store list reactively by card ID: mount and card-ID changes make no list request, and its explicit Refresh makes one canonical list request while preserving accepted rows and reporting refresh failure separately.

## 4. Analyst Panel

The Analyst panel is the user's ordinary mutation path. The user asks for changes in natural language; the Analyst invokes canonical services.

`/api/control-actions` exposes one settled row for each audited Analyst mutation invocation whose append succeeds: `denied` for authorization or current-admission rejection, `error` for returned or thrown failure, and `ok` for returned committed success. A cancelled Analyst turn can therefore show an `ok` control action when its tool effect committed before cancellation, even though no `tool_result` appears in the conversation and no model continuation ran. The UI must not reinterpret that row as an error or request a replay. A failed audit append is not retried.

Apart from the two direct Dashboard runtime controls in Section 3, the workspace remains projection-oriented. Other runtime lifecycle requests use the retained Analyst Run and Pause/Resume controls, and Analyst server restart remains a separate request with actor-owned confirmation. Internal server/application disposal cleanup is not an Analyst, UI, or HTTP control.

The shared Analyst session is the singular authenticated operator authority at `analyst:global`, not a private per-browser chat. HTTP bearer and WebSocket ticket validation admit normal web access to that same authority without creating an individual identity. Closing any browser socket removes only that socket's local queue; it never cancels shared Analyst work. Token changes intentionally replace the WebSocket generation; stale ticket, message, and close callbacks cannot take the current connection offline, while a current `1008` remains terminal unauthorized. Server restart is exposed only when API-token authentication is enabled; disabled-auth deployments retain ordinary chat but do not expose restart.

All backend event, process list/detail, redacted config, provider-routing, and control-action contracts are operator-session resources. Existing browser consumers use one shared bearer transport and one generic 401 auth-required signal; the Debug process list is the current affected example. This adds no per-resource login/session, endpoint-specific token handling, or new browser consumer for the backend-only event, config, provider, or control-action contracts. Auth-disabled deployments continue to use the same resources without a header.

An unexpected failure caught while a registry-backed operator route computes its pre-send response is always the opaque strict 500 `{error:'InternalServerError',message:'Internal server error'}`; the UI never depends on exception prose, stacks, paths, credentials, malformed values, or provider/dependency payloads. This rule does not remove intentional successful diagnostic projections: Availability, Debug Errors/Timeline, Supervision reviews, provider exchanges, and Doctor results retain their bounded redacted or fixed useful content. Doctor may return a successful `issues_found` report with fixed safe card-load details. Doctor and Supervision evaluate authentication as the first operation inside their own local pre-send boundaries: ordinary denial remains the exact typed 401, while a thrown authentication evaluation receives the opaque 500. Neither route has an external authentication pre-handler. These non-disclosure guarantees end before the one final response send; serializer, framework, socket, and later transport failures are not covered by this boundary.

The panel renders the last accepted authoritative `analyst:global` transcript together with send-owned optimistic user rows. Session and transcript requests abort superseded work and reject stale completions. An authoritative refresh removes an optimistic row only when a server row proves it by identity or by the same session, user role, and content; otherwise the pending row remains visible. Refresh failure retains both authoritative and pending rows and is reported independently from send failure. A failed send removes only its own pending row and restores its captured draft only when the user has not edited the cleared composer since that send began.

Runtime invalidations prompt an immediate authoritative REST refetch after direct owner mutations. These include CardService-owned root or dynamic admission, cancellation and terminal status changes, card create/delete changes that affect the type index, launch lifecycle/run-identity and each retained-row insertion even when later launch work fails, separately ordered current-child entry and parent resumption, retained card/agent membership changes, public autonomous-agent phase changes, pause/resume, completion, and failure. Ordinary updates cannot change the type index; non-index card edits do not require runtime invalidation. The hints are lossy and may be coalesced only by `SyncHub`; the UI never treats them as state. Lock-held CLI pause/resume delegates to the same REST authority and therefore has the same behavior. Unlocked CLI persistence, startup recovery/reconciliation, and shutdown state are visible through the authoritative initial load or reconnect read and do not promise an immediate live hint.

After the Analyst returns restart confirmation-required, the composer shows the inline warning: `Restart confirmation required. Send exactly RESTART SERVER to schedule server shutdown.` It is presentation of actor-owned pending state, not a transcript entry. The warning remains after a failed or aborted next submission and changes only after a successful response proves that actor ingress consumed that message: a new confirmation-required acknowledgement replaces it, while `null` or `scheduled` clears it.

When shutdown is scheduled, the global toaster shows warning title `Server restart scheduled` and message `The server is shutting down. This does not confirm that a replacement is running.` The UI queues that warning before transcript refetch. If the expected shutdown disconnect makes that refetch fail, it retains the cleared draft and optimistic sent message without a send error or rollback. A scheduled acknowledgement is not a readiness claim and adds no acknowledgement/status transcript entry.

Planner, executor, reviewer, and analyst prompts are configurable by editing Markdown overrides under `.saivage/config/prompts/<cardType>/<role>.md`; process artifacts use `.saivage/config/prompts/<cardType>/process/<identity>.md`. Card graphs and both prompt kinds are startup-only configuration. The UI has no graph editor, process reload, durable cursor, or recovery control; runtime-status process position is debug/status data and is not currently rendered as a workflow view. Every effective planner/reviewer/executor role override must contain `{{contractDescription}}` exactly once and must not hard-code an old `emit_result.status` field or fixed result values. An incompatible override is an offline startup error: update it or remove it to select the bundled template; no API or UI normalization exists.

On ordinary workspace routes, the chat composer must be reachable without opening a drawer or switching page modes, and the user should be able to inspect the workspace and talk to the Analyst at the same time. The exact `analyst:global` Agents detail exception in Section 2 instead provides read-only conversation inspection without the persistent panel or composer.

Card management is Analyst-owned and process-lifecycle-gated. Card status `blocked` retains warning/blocking presentation because the work is unresolved, but it has no projected start or restart control; its parent planner may re-enter it through `activate_card`. Card status `stopped` renders as neutral inactive recoverable work: it is nonactive, nonblocking, and may expose backend-authorized start/cancel/delete/edit operations, but never a restart or graph-position control. Starting stopped work is explicit and selects configured `STOPPED`; it is not automatic resumption. A displayed card `stopped` status or runtime `stopped`/`paused` status is not by itself mutation admission: the private runtime facet must report stopped-ready or settled-paused after admitted work has settled. Supported Analyst brief/card edits preserve stopped. These status presentations do not add direct UI mutations: outside the explicit Dashboard controls, the user asks the Analyst to invoke the canonical operations. Scoped file URLs shown by the UI use canonical triple-slash form (`project:///`, `record:///`, `tmp:///`, `work:///`, `system:///`). The UI may show relevant record URLs and metadata, but it must not perform mutations directly.

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

The Files backend read model, not client-side presentation, is authoritative for file browsing, card membership, metadata, and preview admission. In the Files Metadata tree, normal navigation lists `.saivage`, follows its one synthetic `{ name: 'cards', path: '.saivage/cards', type: 'directory', modifiedAt: <project.updated_at> }` row, then follows the sole project row into `.saivage/cards/project`. Every reached card namespace shows required `card.jsonl` and `brief.jsonl`, present optional `status.jsonl` and `review.jsonl`, and an always-visible virtual `children` directory whose timestamp is that card's canonical `updated_at`. Opening `children` shows only active children from the parent's committed links, in committed order, with exact paths `<parent-namespace>/children/<segment>` and each child's canonical `updated_at`; an empty leaf renders an empty listing even when no physical children directory exists. Fixed artifact rows alone use descriptor mtime. The unchanged UI renders these server rows and breadcrumbs exactly and never infers membership, order, or directory metadata from disk.

Unlinked, incomplete, and tombstoned physical namespaces remain hidden. Allowed project-path or validated-`work:///` spellings and symlink aliases that enter card storage are opaque as 404 for direct navigation or omitted rows; there is no physical fallback. Lexically blocked sources retain precedence and remain existing 403 responses or omitted listing rows without classifier filesystem I/O, even when they alias into cards. Conclusively non-card aliases retain the generic real-target blocked policy. A malformed optional regular status/review stream may remain visible because listing is metadata-only, while selecting it for preview performs strict content validation and can fail. Unknown/unlinked/tombstoned card paths and absent optional content are 404; oversized content is 413; binary content is 415; reached malformed, incomplete, symlinked, non-regular, or unreadable canonical state is the ordinary safe server error. Card preview size is intentionally slot-specific: `card.jsonl` is already read for reachability and checked afterward, while brief/status/review can be rejected from descriptor size before their content is read.

Blocked secret paths and generic aliases to blocked targets are absent from browsable listings and cannot be previewed. Admitted explicitly redacted generic files and aliases remain visible and readable only through redacted previews; the UI must not reconstruct or request unredacted content. Card browsing introduces no client cache, scan, repository, membership inference, or fallback path.

## 10. Process And Tool Output Projections

Process visibility is broader than termination authority. `owner_kind`, `owner_id`, card association, labels, and displayed command/log metadata explain provenance only; a tool can terminate a process only through the exact direct scope capability and category that launched it. The UI must not infer authority from a visible owner match. A process group is not displayed or acknowledged as stopped until the backend proves group absence with `ESRCH`; an unverifiable group remains a failed/diagnostic outcome rather than being normalized to stopped.

Process rows and process detail responses expose nullable `card_id`, explicit `owner_kind` / `owner_id`, and `logs.stdout` / `logs.stderr` as canonical `work:///cards/<cardId>/processes/<id>/{stdout,stderr}.log` URLs for card-owned processes or `work:///processes/<id>/{stdout,stderr}.log` URLs for non-card Analyst/operator/runtime processes. They do not expose a duplicate `owner` shorthand, and there is no Combined log entry. The operator process API contract rejects bare `.saivage/work` paths, non-work schemes, non-canonical encodings, and mismatched log filenames. The Debug process-log Browse action forwards these `work:///` values to the Files read-model, which resolves them under `.saivage/work/` and previews the log content without reintroducing a bare path field. The Files work root is `.saivage/work`, while durable card records are visible under `.saivage/cards`. The Debug agents area shows Conversation and Raw LLM Exchange views; the duplicate Tool Deliveries tab is removed. Raw LLM Exchange reads the latest settled app-log `provider_exchange` metadata entry through `/api/agents/:id/llm-exchange` and displays the same metadata envelope shape for that latest attempt. It shows provider/model/account, contract, source input id, attempt index, timing, status, response status, finish reason, token usage, terminal tool, assistant output ids, request parameters, and structured errors. Raw HTTP bodies and retry-attempt arrays are not available, and panel availability is derived from the app-log-backed API rather than listing `.saivage/agents/llm-exchanges`. On a successful completion, the current producer first commits one visible assistant-side output row, then supplies that exact persisted row ID as the sole `assistant_output_ids` element on successful attempt records. That row is a normal message, a supported tool call, or the output-validation `model_issue` created for a successfully returned but unacceptable completion. This one-element shape describes the current producer and records it writes; the persistence/API schema accepts a general array of strings and does not enforce one-element or non-empty cardinality. The API returns the stored conversation linkage and Raw LLM Exchange displays it unchanged, without either layer inferring or rewriting an ID. This linkage is distinct from the provider-exchange app-log row's own `(session_id, source_input_id, attempt_index)` identity. Error payloads have no `assistant_output_ids`. For `openai-responses`, Raw LLM Exchange may show sanitized metadata such as transport label, endpoint, `store:false`, include keys, reasoning keys, output-token limits, status, and usage, but it must never expose raw Responses output, reasoning encrypted content, provider-private rows or ids, API keys, raw request/response bodies, or tool output bodies.

Canonical Agent-session provider-exchange publication prompts Agent refresh only after persistence returns successfully. Event, error, control-action, content-review, `summary:*`, and other noncanonical-session app-log rows do not prompt Agent refresh. Existing REST resources and WebSocket frame shapes are unchanged; freshness remains a lossy prompt to reread authoritative REST state.

Current Raw LLM Exchange request-parameter metadata has no LLM `phase` key. The panel renders transport-specific request parameters generically; old rows that contain `phase` remain raw records and are neither interpreted nor normalized.

The backend independently projects the latest canonical exchange under `operator.api` before returning Raw LLM Exchange, even though newly written provider-exchange diagnostics already receive their producer-side policy. This defense-in-depth projection recursively redacts supported credential-shaped text and values under secret-like keys while retaining the existing envelope, relational IDs, timestamps, and structured request-parameter property names. Request parameters therefore remain structured metadata; raw HTTP bodies and provider-private context are unavailable. A strict canonical read or projection failure returns only the stable generic API error and writes only the stable operation and validated session identity to the server log; raw exception text, malformed content, stack, and project path are exposed to neither sink.

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
