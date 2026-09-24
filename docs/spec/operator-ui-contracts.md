# Operator UI: Exact Contracts Register

Status: canonical operator-UI contracts register, created at the Card Cockpit
cutover (owner decision Q1, 2026-09-20; 2026-09-24). It is paired with the
needs register in [operator-ui-needs.md](operator-ui-needs.md); together they
replace the retired `docs/spec/operator-ui.md`. Backend wire contracts remain
owned by [system-specification.md](system-specification.md); this register
owns surviving UI-facing wire/behavior contracts and the exact presentation
contracts the current Card Cockpit implements.

## 1. Product model

- Projection-oriented inspection with Analyst-mediated mutation. The UI offers
  exactly two direct runtime mutations: **Stop project** and capability-gated
  **Restart server**. Neither cancels a card, resumes work, or launches a
  project. Agent-owned cards, records, notifications, processes, routes, and
  settings gain no direct mutation affordance; displayed permissions never
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
- Socket connection and REST acceptance are independent observations, each
  displayed with its own condition (loading, refreshing, refresh-failed,
  retained error, unauthorized, not loaded). No aggregate green light; the
  strip may say some observations are unavailable while individual facts
  retain their last successful labels. Age-based staleness is never inferred.
- Terminal socket **Unauthorized** appears only on a validated ticket-endpoint
  401 or close code 1008; every other failure is an ordinary reconnect.
- Stop is enabled in starting/running/pausing/paused/error and disabled in
  closing/stopped or before a usable lifecycle observation. Stop is a
  bodyless request with no JSON `Content-Type`; a failed Stop starts no
  compensating read, and an accepted Stop remains accepted if its follow-up
  observation fails.
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
  `/agents/:id?entry=…` (the sole session reader route), `/files`, and
  `/system?section=…&process=…`. Retired destinations
  (`/dashboard`, `/agents` list, `/debug`) are removed with ordinary
  route-not-found and no redirects or aliases.
- Evidence-link grammar `/agents/<session>?entry=<marker>` is retained.
  `entry` targeting is validated separately, located only in the addressed
  source, and reported missing without searching elsewhere.
- Workspace navigation intents keep singular target kinds: `card` → card
  cockpit; `transcript` → exact session reader; `process`/`process_list` →
  System Processes; `agent_session_list` → System Participants. Failed or
  malformed navigation results are inert. Logical Back pops without
  re-recording the restored destination.
- Analyst chat context is `{view, entityId, refinement}` naming the focused
  resource (cockpit/files/system, exact card/session/file identity, explicit
  facet/entry refinements). Displayed context is not evidence the Analyst
  has read it.

## 4. Card tree and hierarchy

- Hierarchy slices are the sole render authority. Discovery states are
  `undiscovered`, loading, error, loaded-empty (configured-empty types),
  loaded-nonempty, and `confirmed-leaf`; disclosure means "discover
  children", not "has children". Committed sibling order comes only from the
  parent's accepted slice. Stable identity is distinct from the mutable
  display path (`logical_path`).
- Every tree row carries a text lifecycle status alongside any marker.
  Title/state filtering declares its scope as **Loaded branches**/**These
  children** and never claims project search. Exact-ID opening is separate;
  broad discovery is Analyst-mediated.
- At scale, load the root and necessary represented ancestor slices, then
  only requested immediate children. No bootstrap global inventory or
  transcript fan-out.

## 5. Records, versions, and diffs

- Record declarations render in declaration order; descriptor reads precede
  content reads; each record is fetched independently. Exactly one record is
  the bootstrap record.
- Record request outcomes follow the fixed table: initial required 404 is an
  initial error with no accepted value; initial optional 404 is accepted
  empty; refresh 404 after accepted content retains it visibly stale with
  exact Retry; refresh 404 after accepted-empty optional retains unchanged
  empty success with no Retry; any non-404 refresh failure retains the
  accepted state visibly stale with exact Retry. Required `brief` never
  accepts empty. Unexpected strict HTTP 500 failures are opaque and never
  reinterpreted as absence. Parent-detail 404 tears down card-owned reads.
- Selected card/record history is already a row in one strict stream: a
  failed history or selected-version request is an ordinary selection-local
  error that preserves accepted current and metadata state, never a separate
  availability state.
- Card versions expose publication facts and current-relative differences.
  Null change metadata means attribution unavailable; no author or cause is
  inferred. Record revisions keep their own sequences.

### Exact displayed-current-diff request contract

<!-- saivage:value-contract:displayed-current-diff:start -->
```text
pivot.ui-cards-diff-current-request = {"currentness":{"abortPreviousOwner":true,"acceptedSideCondition":["retained.cardId===key.cardId","retained.fromSeq===key.fromSeq"],"fences":["success:diffOwner===owner","rejection:diffOwner===owner","finalization:diffOwner===owner"],"freshOwner":["controller","promise"],"retainedKey":"original-request-key","selectionGuards":["selectedCardId===key.cardId","cardHistorySelectedVersion===key.fromSeq"]},"key":[{"name":"cardId","type":"string"},{"name":"fromSeq","type":"number"},{"name":"to","type":"'current'"}],"request":{"operation":"cards.diff","params":{"id":"key.cardId"},"query":{"from":"String(key.fromSeq)","to":"key.to"},"signal":"forwarded"},"reuse":{"invalidationGates":["scope=diff","visible","retained-key"],"reconnectGates":["visible","retained-key","freshness!=refresh-failed"],"refresh":"startDiff(cardHistoryDiffKey, reason)","retry":"refreshDiff(invalidated)"},"selection":{"construction":{"cardId":"cardId","fromSeq":"version","to":"current"},"frozen":true,"startArgument":"key"}}
```
<!-- saivage:value-contract:displayed-current-diff:end -->

## 6. Conversation readers

- One focused exact session reader exists (shared store selection with
  owner-local request lifetimes and teardown before a newer selection).
  System session opening and card session opening mount the same exclusive
  reader, never two instances. Reading offsets and arrival counters are
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
  context as evidence.
- Participant rails show backend-decorated `active · busy` or
  `inactive · idle` meaning only. The browser performs no join with actor
  state, process state, or graph agent mappings, and derives no
  agent/session liveness or ownership from them. Configured node/role labels
  are workflow facts; one agent on several nodes shows every association
  with one exact session selection.
- For a direct session entry, the exact session scope resolves first, then
  the admitted card context is requested independently; context failure does
  not erase a usable retained transcript. An unavailable card flow keeps the
  exact card identity and says **Card flow unavailable**; it does not
  identify tombstone state, search for a replacement, or infer hierarchy.
  Global scope shows global purpose, not a card header.
- The identity-resolved, read-only Analyst-session inspection exception
  (via `GET /api/chat`) is retained; its inspector and the ordinary Analyst
  conversation consumer are never mounted together.

## 7. Analyst panel

- The Analyst is shared, not a private browser task. Busy denial preserves
  newer draft edits, is not queued or retried, and browser closure is not
  cancellation. Identity comes from `GET /api/chat`.
- Readiness explanations distinguish settled paused/stopped from other
  lifecycles and never act as HTTP health, a reservation, or an
  operation-specific admission gate.
- The restart composer acknowledgement keeps the exact
  `confirmation_required`/`scheduled` discrimination and the literal
  `RESTART SERVER` message.

## 8. Files, processes, and evidence

- Files is the canonical virtual-file read-only browser (metadata/output
  roots, breadcrumbs, `card.json[?v=N]` format reads, typed failures, safe
  redaction notice). Physical persistence paths are never disclosed. Files
  and previews expose explicit Refresh and permitted resource-local Retry;
  a failed historical read preserves usable listing/current state.
- Process rows carry supplied owner/card identity, status, and canonical
  `work:///` log references. Retirement does not erase a known link or
  promise retention; there is no terminate control or process-history cache.
- Evidence is a source-labeled navigation index: card-version, per-record
  revision, and per-session segment catalogs open on demand with exact links
  into their owning readers and coverage labels. The card events tail uses
  `GET /api/events` with `selection:'newest_tail'`, limit 50, offset 0, and
  the card filter; explicit oldest-page browsing uses contract-valid
  offset/limit. Each response is a fresh bounded observation with returned
  coverage/total; chronological physical order is preserved within a
  response; no session/since filter, polling, WebSocket replay, or invented
  invalidation exists. Independent sources are juxtaposed only as grouped
  facts anchored in durable publication order, never as one canonical
  cross-session order.

## 9. System surface

- System consolidates State, Operator observation, Participants (global and
  cross-card inventory), Errors, Events (no card filter), Processes, MCP,
  Provider availability, Configuration, Installed workflows/bindings,
  Actions, and manual Doctor. Sections read on selection; opening System
  fetches none of them.
- Provider states are process-local (`process_local_reset_on_restart`);
  expiry eligibility differs from recorded cooling; no durable health
  history, base URL, or inferred cost is shown. Saved effective
  configuration and installed workflow/model/tool bindings are labeled
  separately; no editor, prompt-body viewer, or hot reload exists. Actions
  show retained settled actor/target/time/result rows without guaranteed
  audit completeness. Oversight appears as an ordinary global participant
  conversation with epoch diagnostics (waiting/checking/unavailable) and no
  manual check, configuration editor, or trigger.
