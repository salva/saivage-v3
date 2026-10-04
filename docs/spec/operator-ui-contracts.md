# Operator UI: Exact Contracts Register

Status: canonical operator-UI contracts register, created at the Card Cockpit
cutover (owner decision Q1, 2026-09-20; 2026-09-24). It is paired with the
needs register in [operator-ui-needs.md](operator-ui-needs.md); together they
replace the retired `docs/spec/operator-ui.md`. Backend wire contracts remain
owned by [system-specification.md](system-specification.md); this register
owns surviving UI-facing wire/behavior contracts and the exact presentation
contracts the current Card Cockpit implements.

## 1. Product model

- Projection-oriented inspection with Analyst-mediated mutation. Project start,
  stop, pause, and resume are requested through the Analyst conversation, not
  direct UI controls. The sole direct runtime mutation is capability-gated,
  confirmed **Restart server**; it does not start project work. Agent-owned
  cards, records, notifications, processes, routes, and settings gain no direct
  mutation affordance; displayed permissions never
  reserve invocation-time admission.
- Backend-owned safe projections govern every view, copied value, link, and
  tool payload. Outbound secret non-disclosure and redaction are unchanged.
  Provider exchange presentation is metadata only (provider/model/account and
  settlement/request-parameter facts), never raw HTTP bodies or prompt views.
- There is no authentication/bootstrap UI: no token entry, sign-out, or
  provider-secret entry. Deployments are expected to run auth-disabled behind
  deployment-owned isolation; backend bearer-auth capability is unchanged for
  deployments that want it. Unauthorized surfaces present honest
  resource-specific rejection and must not instruct the operator to provide,
  re-enter, save, clear, or retry with a token, or offer sign-out.
- Tombstones stay absent from discovery. Exact retained-evidence exceptions
  (card history/version/diff, `card.json?v=N`, known retained conversations)
  never authorize a deleted-card inventory, forensic browser, replacement
  search, restoration, or orphan scan.
- The UI keeps no operator-visit state: no viewing timestamps, unread/read
  models, or recorded reading positions retained across views or visits.
  Ephemeral logical Back history and mounted-presentation stability
  (including pause-follow) are mechanics, not visit state.

## 2. Runtime observation and the global strip

- The browser runtime authority is the accepted `runtime.status` observation
  used together: `runtime` lifecycle label, `currentCardId`, and
  `actorRuntime.cards` positions. `GET /api/state` supplies project identity
  and its separately qualified facts (availability). There is no fallback
  between these independently sampled fields, and `/api/state`'s
  `runtime.current_card_id` is not a selector rule for the UI.
- After successful fresh startup settlement, accepted runtime and fresh card
  detail/tree/cockpit observations show stopped runtime, null current card,
  no executing autonomous participant, and the interrupted linked cards' actual
  stopped lifecycles before any Run. No work starts until an explicit Run. Recorded
  notices, uncertainty-only mates, and lifecycle rows remain separate evidence;
  the UI adds no synthetic status or inferred explanation. Same-process project
  Stop may instead leave durable running cards even while runtime is stopped;
  display their canonical status without rewriting it. A disconnected view retains
  only its last accepted observation, not a claim about current startup outcome.
  A startup-produced configured-global failed mate means uncertain prior effects,
  not a new submission/check, recovery notice, or active owner. Existing tool-result
  presentation applies; no new UI state or action is inferred.
- Socket connection and REST acceptance are independent observations, each
  displayed with its own condition (loading, refreshing, refresh-failed,
  retained error, unauthorized, not loaded). No aggregate green light; the
  strip may say some observations are unavailable while individual facts
  retain their last successful labels. Age-based staleness is never inferred.
- Terminal socket **Unauthorized** appears only on a validated ticket-endpoint
  401 or close code 1008; every other failure is an ordinary reconnect.
- Restart availability comes solely from the `restart_server_available`
  boolean. The confirmation dialog explains shutdown versus project halt,
  requires exact text `RESTART SERVER`, supports Cancel, traps/restores
  focus, and disables duplicate sending. Submission is the strict JSON
  request `{confirmation:'RESTART SERVER'}` to the auth-gated
  `restart_server` operation; `restart_scheduled` acknowledges scheduled
  shutdown, not replacement readiness. The application-owned `RestartPort`
  terminal coordination shared with the Analyst restart path is unchanged.
- The **Updates** disclosure states exactly: cards, conversations, and
  records refresh through permitted WebSocket invalidation hints and
  reconnect snapshots of eligible mounted/accepted resources; hints are not
  data or guaranteed delivery; reconnect does not certify a successful REST
  observation; Files, Processes, and Events have no invalidation resource
  and use explicit Refresh.

## 3. Identity, routes, and navigation

- Conversation session identity is the exact `agent:<name>:<cardId|global>`
  grammar. Malformed session routes render a distinct invalid-session state
  without mounting detail; malformed card routes make no detail request and
  share the typed **Card not found** presentation.
- The singular route table is `/` (cockpit home: accepted current work,
  accepted **No current work**, or honest unknown/loading/error before
  acceptance), `/cards` (explicit tree/selection surface),
  `/cards/:id?facet=overview|conversations|records|evidence` (card cockpit),
  `/agents/:id?entry=…` (the sole exact-session address, presented by the
  shared cockpit owner), `/files`, and
  `/system?section=…&process=…`. Retired destinations
  (`/dashboard`, `/agents` list, `/debug`) are removed with ordinary
  route-not-found and no redirects or aliases.
- Evidence-link grammar `/agents/<session>?entry=<marker>` is retained.
  `entry` targeting is validated separately, located only in the addressed
  source, and reported missing without searching elsewhere.
  A rendered tool-call target reveals its containing group, then highlights,
  scrolls to, and focuses the exact canonical call row without opening raw
  request/result payloads or unrelated groups. Superseded render-delayed focus
  is cancelled. Tool-result IDs are not aliases for call IDs, and omitted or
  private rows are not promised rendered targets.
- A resolved card-session address selects Conversations in its exact owning
  card cockpit. The represented tree, selected card, compact header, participant
  rail, and four tabs persist across exact participant selection. Conversations
  points to the current exact session (including a valid `entry`); another facet
  points to its exact card and drops session/entry refinements. Returning to
  Conversations opens the unselected card facet rather than retaining visit state.
- After the first successful scoped membership observation, an unselected card
  Conversations facet with exactly one active session replaces itself with that
  canonical exact-session address. `workspaceRoute` owns this single-flight
  replacement and omits the synthetic empty source from browser and Analyst
  logical history; duplicate pending requests are inert. Explicit participant
  choices use ordinary push and remain in both histories. Failed replacement
  leaves the real empty facet in history and projects no uncommitted destination.
- Workspace navigation intents keep singular target kinds: `card` → card
  cockpit; `transcript` → exact session reader; `process`/`process_list` →
  System Processes; `agent_session_list` → System Participants. Failed or
  malformed navigation results are inert. Logical Back pops without
  re-recording the restored destination.
- Analyst chat context is a detached `{view, entityId, refinement}` copy captured at Send, not a live route. Views are cockpit/files/system or null; entity identity is opaque and refinements are opaque string metadata (not evidence of reading a facet or entry). The strict serialized context is bounded to 2048 UTF-8 bytes; invalid input preserves the draft and reports the send error, without truncating identity or retrying. Server preparation may add only a bounded linked-card or owning-card snapshot for exact cockpit card/session identity; Files/System identity supplies no content. Displayed context is not evidence the Analyst has read it.
- A rejected capacity submission is not automatically resent. A later explicit Send is a fresh submission on retained history; earlier ingress, compaction or tool effects/results may already be present. Rejection is not a success acknowledgement or proof of no effects; existing error/draft handling is unchanged.
- Analyst form/Enter submission and System participant refresh consume action failures at their UI event boundaries. Store-owned send feedback/restored drafts and initial/refresh inventory errors remain visible; failed sends do not run success-only composer focus. Targeted global membership observations retain sibling sessions and explicit System selection.
- The shared card header stays compact on every cockpit facet and on the
  exact card-session reader: title, type, one lifecycle badge, exact identity,
  represented path, and one plain-language **Observed workflow step** lead.
  Exact position/state/node/ordinal, configured outcomes and conditions, the
  complete configured workflow, and publication facts live in the initially
  closed **Workflow & technical details** disclosure. Header and Participants
  consume `workflows.presentation` for the exact detail type, including all
  entries, nodes, configured/runtime edges, terminals, and record labels.
  Same-type pending reads are shared; detail arrival/type changes select only
  matching facts, accepted facts are immutable for the server incarnation,
  and failed reads offer explicit retry. System alone retains rich Debug Graph
  installed bindings. None of these structural facts supplies liveness or
  runtime ownership. The header is a named,
  keyboard-focusable scrollport bounded to at most 45% of the available
  center/session height; expanding it preserves an independently usable body
  scrollport. An unavailable card flow retains exact identity and its explicit
  warning rather than fabricating hierarchy or workflow context.
- Overview is work-first, in this order: **Objective**, **Activity and
  participants**, **Recorded result and records**, **Problems and waiting**,
  then **Parent and related work**. Detailed workflow mechanics remain
  available from the shared header rather than leading the reading order.

Plain resource reads cancel their pending request when their owner departs. Superseded success or failure cannot change the current view or clear newer loading. System resources and diagnostic/MCP refreshes retain last-good values on failure; file selection and exact-session resolution clear departed content, while current-card orientation retains its last accepted detail and reports authoritative 404 unavailability. These request-lifetime rules do not replace Cards freshness or conversation lease contracts.

## 4. Card tree and hierarchy

- Hierarchy slices are the sole render authority. Discovery states are
  `undiscovered`, loading, error, loaded-empty (configured-empty types),
  loaded-nonempty, and `confirmed-leaf`; disclosure means "discover
  children", not "has children". Committed sibling order comes only from the
  parent's accepted slice. Stable identity is distinct from the mutable
  display path (`logical_path`).
- Tree rows are color-only (owner decision 2026-09-25); lifecycle text remains
  available on selected-card surfaces, not repeated on every tree row. The
  cockpit provides no card title/state search or filter. Operator card/work
  discovery by known identity, title, or state is exclusively Analyst-mediated;
  manual tree browsing and exact card navigation remain available.
- At scale, load the root and necessary represented ancestor slices, then
  only requested immediate children. No bootstrap global inventory or
  transcript fan-out.

## 5. Records, versions, and diffs

- Record declarations render in declaration order; descriptor reads precede
  content reads; each record is fetched independently. Exactly one record is
  the bootstrap record. Overview consumes these same selected-card CardStore
  descriptor and current-record slots; it adds no overview endpoint, cache,
  summary authority, or persistence contract. Once selected detail is admitted,
  the descriptor read and each exact current-record read retain independent
  request ownership and outcomes.
- Overview labels the configured `bootstrap:true` record as **Objective**
  regardless of its custom name and presents every other declared record in
  declaration order under that exact name. A source's `effective_content_source`
  alone determines **Draft** versus **Accepted**; an accepted HTTP observation
  is not acceptance of the work. Arbitrary records are not classified as
  progress, review, constraints, or completion from their names or Markdown.
  Objective descriptor loading, initial content failure, empty effective
  content, and retained stale content remain distinct; missing required content
  is an error, not a fabricated absent objective.
- Each record shows a deterministic plain-text excerpt of at most 600 source
  characters and makes its complete content directly readable in a **Full
  content** disclosure through the existing sanitized Markdown presentation.
  **Records & History** is additional generic navigation to `facet=records`,
  with no promised record focus and no record/version query refinement.
- Record request outcomes follow the fixed table: initial required 404 is an
  initial error with no accepted value; initial optional 404 is accepted
  empty; refresh 404 after accepted content retains it visibly stale with
  exact Retry; refresh 404 after accepted-empty optional retains unchanged
  empty success with no Retry; any non-404 refresh failure retains the
  accepted state visibly stale with exact Retry. The required bootstrap record
  never accepts absent content. Unexpected strict HTTP 500 failures are opaque and never
  reinterpreted as absence. Each source owns its loading, current-observation,
  stale, error, and exact Retry presentation: failure of one optional record
  does not hide the objective, recorded result, or other usable records, and
  Retry does not reload unrelated successful records. Parent-detail 404 tears
  down card-owned reads.
- Selected card/record history is a committed immutable ordinary/accepted predecessor document: a
  failed history or exact sparse selected-version request is an ordinary selection-local
  error that preserves accepted current and metadata state, never a separate
  availability state.
- Records-facet record/version query refinement waits for matching card,
  successful definitions, and completion of the initial current-record load;
  a pending current refresh also delays refinement. Failed definitions remain
  an error; an undeclared requested record is explicitly unavailable, without
  a synthetic slot or dropped query. History and exact version reads are
  independent. Manual History, catalog selection, selected-version Retry and
  Retry diff are unavailable during initial current loading; pending actions
  are not queued. Once it settles, including failure, those controls are usable.
  This admission restriction never hides historical output: current failure
  remains visible alongside independent history/selection loading, local
  error/Retry, or selected content and provenance. Missing exact versions never
  substitute current content; a diff error does not hide selected content.
- Card versions expose publication facts and current-relative differences.
  Null change metadata means attribution unavailable; no author or cause is
  inferred. Record revisions keep their own sequences. Overview explains that
  card revision counts all card mutations, including enqueue/removal, while each record has its own revision
  sequence, and neither measures work completed. When displayed, record head
  revision and accepted source revision remain distinct.
- Catalogs contain only retained ordinary card or accepted record entries; totals count entries, not maximum revisions. Current revision need not have a selectable artifact. Loaded catalogs do not veto exact card/record version requests: success or missing selection comes from the server, with selection-local errors preserving current detail. Explicit absent selectors show a local error, never a first-entry/nearest fallback. Current draft is not synthesized into history and has no immutable locator; current record URLs remain reusable, with nullable `accepted_version_url` separately linking latest acceptance.
- Card diffs tag their target as `{kind:'version',version}` or `{kind:'current',version_seq,history_version}`. Record current-side diffs tag mutable revision separately from immutable accepted sides. Redaction precedes comparison. Files `card.json` projects current head metadata and selected ordinary content; `card.json?v=N` projects exact immutable history. Sizes/hashes/times describe those virtual bytes, never physical heads/history/mailbox files.
- Accepted provenance displays observed `card_version_seq` separately from `card_history_version` and its immutable ordinary locator. Queue-only current revisions never become fabricated historical URLs. Current draft and latest accepted content remain visibly distinct. Pending-only mailbox reachability promises neither a queue audit nor physical erasure; delivered conversation text remains independently readable, and private mailbox paths/bodies never leak through Files.
- A lifecycle result is neutrally labeled **Recorded result**, with its summary
  quoted through the existing bounded one-liner and complete JSON/provenance one
  disclosure away. **No result recorded** makes no progress claim. For `done`,
  Overview says **Accepted as done; not independently verified correctness**;
  a failed completion timestamp is **Ended**, never accepted completion.
  `lifecycle.error` is reported once. When stopped, cancelled, changed, or
  running detail supplies no reason, Overview says that no reason is supplied
  by current card detail and points to records and conversations as possible
  context; it never derives a wait cause from time, graph position, session
  activity, or child lifecycle.

### Exact displayed-current-diff request contract

<!-- saivage:value-contract:displayed-current-diff:start -->
```text
pivot.ui-cards-diff-current-request = {"currentness":{"abortPreviousOwner":true,"acceptedSideCondition":["retained.cardId===key.cardId","retained.fromSeq===key.fromSeq"],"fences":["success:diffOwner===owner","rejection:diffOwner===owner","finalization:diffOwner===owner"],"freshOwner":["controller","promise"],"retainedKey":"original-request-key","selectionGuards":["selectedCardId===key.cardId","cardHistorySelectedVersion===key.fromSeq"]},"key":[{"name":"cardId","type":"string"},{"name":"fromSeq","type":"number"},{"name":"to","type":"'current'"}],"request":{"operation":"cards.diff","params":{"id":"key.cardId"},"query":{"from":"String(key.fromSeq)","to":"key.to"},"signal":"forwarded"},"reuse":{"invalidationGates":["scope=diff","visible","retained-key"],"reconnectGates":["visible","retained-key","freshness!=refresh-failed"],"refresh":"startDiff(cardHistoryDiffKey, reason)","retry":"refreshDiff(invalidated)"},"selection":{"construction":{"cardId":"cardId","fromSeq":"version","to":"current"},"frozen":true,"startArgument":"key"}}
```
<!-- saivage:value-contract:displayed-current-diff:end -->

## 6. Conversation readers

- `/agents/:id?segment=N&entry=ID` selects one exact indexed segment and optionally
  its exact row. `segment` is a scalar decimal `[1-9][0-9]*` with a positive safe
  integer value; absence selects current. Invalid values render **Invalid segment
  selection** without a version-content request or current fallback. Explicit selection
  reads the requested version even when equal to current and opens Segment history.
  `entry` is any nonempty scalar router-decoded string, preserved verbatim: no trim,
  case folding, extra decoding, UUID restriction, prefix parsing, or reconstructed ID.
  Missing, empty, or nonscalar values give no target; unknown opaque IDs reach ordinary
  missing-entry presentation. Vue Router builds encoded query values.
- **Activation entries — this segment** projects already returned public markers in
  physical source order and labels each **Activation entry recorded**, configured
  participant and recorded time, with copyable recorded identities and **Open entry**.
  Every link carries the observed numeric segment and full marker row ID; marker-only
  rounds render actual escaped transcript anchors, focused/highlighted by exact identity.
  Coverage says **Markers retained in this segment only; earlier entries may have been
  compacted. Entry does not prove a provider call or completion.** Empty accepted coverage
  says **No activation markers retained in this segment**. Claimed malformed markers
  produce explicit projection failure, not empty coverage. Inherited-open-round genesis
  is **Continuation context**, not a new marker, inferred node, timestamp or location;
  omitted markers are not searched for. This index applies only to the ordinary exact
  reader, not the unchanged identity-resolved Analyst inspector exception.
- Current loading/error/retained-stale state follows the current reader; an accepted
  explicit segment is independent of current refresh failures and arrivals. Missing exact
  segment, failed read, and entry absent within a successfully accepted segment are distinct.
  Entry-only links report absence only **in the current segment**. Route changes retarget
  even without content changes; cold load, reload and Back retain exact selection.
  Historical inspection is not stolen by live hints or auto-scroll. No stitched transcript,
  second conversation owner, catalog crawl, adjacent-version guess or all-history search exists.
- One focused exact session reader exists (shared store selection with
  owner-local request lifetimes and teardown before a newer selection).
  System session opening, evidence links, and card participant selection all
  reach the canonical address and mount the same exclusive reader inside the
  shared cockpit owner, never two instances. Reading offsets and arrival counters are
  discarded on leaving the inspector.
- The transcript preserves physical source order including corrections,
  recovery rows, and tool rows. Tool call, successful result, failed result,
  and **No result recorded** are distinct; the last proves neither pending
  execution nor permission to replay. Compaction is presented as separate
  system activity (completed summary calls, in-flight state, elapsed,
  last-known on failed refresh), never as agent liveness, heartbeat,
  percentage, or ETA. `model_recovered` uncertainty, failed uncertainty-only
  mates, later activation, and lifecycle corrections remain separate facts.
- Current content, compacted-context metadata, retained instructions, and an
  explicitly selected historical segment remain separate; no stitched
  cross-segment transcript and no summary prose or prepared provider-private
  context as evidence. Private Responses producer identifiers and their field
  are excluded from public current/history/context DTOs and copied transcript
  values; this does not remove existing public routing/account aliases.
- Participant rails show backend-decorated `active · busy` or
  `inactive · idle` meaning only. The browser performs no join with actor
  state, process state, or graph agent mappings, and derives no
  agent/session liveness or ownership from them. Configured node/role labels
  are workflow facts; one agent on several nodes shows every association
  with one exact session selection.
- For a direct session entry, the exact session scope resolves first. Card scope
  then claims the existing CardStore selection/detail owner; no detached card
  context reader exists, while the transcript remains independently usable.
  Loading or initial card failure leaves Conversations active and disables the
  other three facet labels. An unavailable card flow keeps the
  exact card identity and says **Card flow unavailable**; it does not
  identify tombstone state, search for a replacement, infer hierarchy, or mount
  card membership reads. A retained admitted detail stays visibly stale on
  refresh failure; a later authoritative 404 removes card-owned subordinates but
  retains the exact reader. Global scope shows global purpose and the same exact
  reader, not a card header, selected card, participant rail, or card tabs.
- The identity-resolved, read-only Analyst-session inspection exception
  (via `GET /api/chat`) is retained; its inspector and the ordinary Analyst
  conversation consumer are never mounted together.

## 7. Analyst panel

- The Analyst is shared, not a private browser task. Busy denial preserves
  newer draft edits, is not queued or retried, and browser closure is not
  cancellation. Identity comes from `GET /api/chat`.
- A local UTF-8 context-limit failure or server redaction-budget HTTP 400 keeps the unsent draft and displays the ordinary send error; neither retries nor submits a no-focus substitute. A newly accepted request by another client captures that client's own route independently.
- Readiness explanations distinguish settled paused/stopped from other
  lifecycles and never act as HTTP health, a reservation, or an
  operation-specific admission gate.
- The restart composer acknowledgement keeps the exact
  `confirmation_required`/`scheduled` discrimination and the literal
  `RESTART SERVER` message.
- Analyst notification results retain ordinary chat/tool-result presentation:
  `queued` confirms enqueue; `pending_tool_settlement` is not a completed stop,
  and `interrupted` lists completed stopped cards, not delivery or model action.
  `not_applicable` does not start a Run; Pause needs explicit Resume. No queue
  field, new control, receipt refresh, or timeline state is presented.

## 8. Files, processes, and evidence

- Files is the canonical virtual-file read-only browser (metadata/output
  roots, breadcrumbs, `card.json[?v=N]` format reads, typed failures, safe
  redaction notice). Physical persistence paths are never disclosed. Files
  and previews expose explicit Refresh and permitted resource-local Retry;
  a failed historical read preserves usable listing/current state.
- Current and historical `record:///` preview HTTP 404 `{error:'workspace_card_not_found',path,card_id}` displays **Card not found**, retaining the requested identity. Existing-card record/content and historical-version misses keep their distinct failures; corruption is not presented as missing-card.
- Current and exact accepted `record:///` previews receive backend text
  redaction, including current drafts; authenticated Files access is not a
  raw-record escape hatch. Redaction flags mean the policy was applied, even
  when ordinary prose is unchanged. Record-URL size describes source bytes,
  not necessarily the displayed projected text length.
- Read-only presentation is not a promise of non-mutating backend consumption:
  exact owners may discard a current growing file's proven torn final suffix
  only after full retained-prefix validation. Older conversation segments stay
  immutable; complete corruption remains unavailable/error, and publication
  uncertainty is fatal before a response, not translated to not-found or Retry.
  No browser repair action or new control is introduced.
- Process rows carry supplied owner/card identity, status, and canonical
  `work:///` log references. Successfully stopped scope-tree selections disappear
  after terminal settlement and retirement. Retirement does not erase a known link or
  promise retention; there is no terminate control or process-history cache.
- Evidence is a source-labeled navigation index: card-version, per-record
  revision, and per-session segment catalogs open on demand with exact links
  into their owning readers and coverage labels. A session segment link includes
  `segment=N`, rather than merely opening the session's current content. The card events tail uses
  `GET /api/events` with `selection:'newest_tail'`, limit 50, offset 0, and
  the card filter; explicit oldest-page browsing uses contract-valid
  offset/limit. Each response is a fresh bounded observation with returned
  coverage/total; chronological physical order is preserved within a
  response; no session/since filter, polling, WebSocket replay, or invented
  invalidation exists. Independent sources are juxtaposed only as grouped
  facts anchored in durable publication order, never as one canonical
  cross-session order.

## 9. System surface

- Events presents informational `operator_runtime_control` rows with their bounded
  `result`: **Pause/Resume returned runtime status: …**, **Stop returned stopped;
  execution contained (contained: true)** or **execution not newly contained
  (contained: false)**, **Restart scheduled — shutdown and replacement readiness not
  established**, or the explicit body-not-allowed/restart-unavailable rejection.
  These global rows have no synthetic card link and are excluded from Errors and
  card-filtered Events. Errors explicitly includes runtime diagnostics, actionable
  errors and failed MCP invocations only. Direct controls record known handler returns
  and explicit handler rejections; status reads, pre-handler denials, thrown failures
  and transport loss have no promised row. Missing evidence does not authorize repeating
  a command. Analyst tool evidence remains in conversations, not duplicate control events.
- System consolidates State, Operator observation, Participants (global and
  cross-card inventory), Errors, Events (no card filter), Processes, MCP,
  Provider availability, Configuration, Installed workflows/bindings,
  Actions, and manual Doctor. Sections read on selection; opening System
  fetches none of them.
- Operator observation is diagnostic-only: it directs operators to Cockpit for
  current runtime and activation ownership and System > Errors for durable
  command, precondition, activation, and actionable-error evidence. Ask the
  Analyst to run, pause, resume, or stop the project; project Stop does not
  shut down the server or replace the distinct confirmed Restart Server action.
- Provider states are process-local (`process_local_reset_on_restart`);
  expiry eligibility differs from recorded cooling; no durable health
  history, base URL, or inferred cost is shown. Saved effective
  configuration and installed workflow/model/tool bindings are labeled
  separately; no editor, prompt-body viewer, or hot reload exists. Actions
  show retained settled actor/target/time/result rows without guaranteed
  audit completeness: only the bounded audited Analyst mutation surface currently
  produces them, while historical Planner rows remain readable. Oversight appears as an ordinary global participant
  conversation with epoch diagnostics (waiting/checking/unavailable) and no
  manual check, configuration editor, or trigger.

## 10. Legibility presentation register (2026-09-25)

Presentation-only layer over the surfaces above; no request, contract, or
honesty-rule changes. Owners: `web/src/utils/legibility.ts` and
`web/src/components/ui/ExactValue.vue`.

- **Tiers**: Primary plain-language facts (state, trajectory, participants,
  problems, outcome) lead at reading size; Secondary support (titles,
  humanized times, counts, exact liveness pairs) stays visible muted or, on
  Overview, in the adjacent **Session details** disclosure;
  Tertiary exact identities (IDs, UUIDs, hashes, raw payloads) remain exact
  and copyable but never lead.
- `livenessPhrase` maps exactly the two contract-enforced pairs
  (`active · busy`, `inactive · idle`); any other pair renders the exact
  backend words unchanged.
- `positionGloss` supplies the primary **Observed workflow step** only from the
  per-type compiled-workflow presentation (node → owning agent's step; terminal → configured end
  states). Exact raw position belongs in **Workflow & technical details**;
  without matching presentation the UI states that workflow details are unavailable rather
  than guessing a role or business milestone.
- The recorded-result one-liner quotes the backend-recorded `summary`
  verbatim (120-char truncation; full JSON one disclosure away); key
  listing exists only for future summary-less shapes.
- Card-tree rows are color-only (owner decision 2026-09-25); non-color
  status meaning lives on the selected surfaces (flow-header badge,
  Overview situation and lists).
- The provider-exchange surface is named **Provider exchange metadata**
  everywhere; segment-context and retained-instruction IDs render compact
  with full values in `title` and copy.
- Record diffs carry a "Changes from previous version" label; card-version
  diffs carry explicit Before/After columns; EventsPanel coverage counts
  derive from returned data, never the request limit.
- `ExactValue` is the exact-identity carrier: mono, full value in `title`,
  copy button with accessible name and transient Copied feedback.
