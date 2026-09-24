# Operator UI: Functional Needs Specification

Status: canonical operator-UI needs register, promoted at the Card Cockpit
cutover (owner decision Q1, 2026-09-20; promoted 2026-09-24). It is paired
with the exact contracts register in
[operator-ui-contracts.md](operator-ui-contracts.md); together they replace
the retired `docs/spec/operator-ui.md`. Scope: one project's operator web UI.

## 1. Purpose and use

The UI's prime directive is to let the operator **see and understand what is going on**
and **take action through the Analyst**—directing, questioning, and requesting mutations—
without taking over autonomous engineering work.
This document defines observable operator capabilities, not pages or visual composition.

Provenance: this register was authored as a phase-1 working specification,
used as the phase-2 audit rubric, and drove the phase-3 Card Cockpit redesign.
The phase-3 cutover replaced `docs/spec/operator-ui.md` with this register plus
the exact contracts register; everything else in the retired document was
discarded and re-derived by the redesign. The requirements below are stable
operator needs and remain the acceptance rubric for future UI work.

Grounding: `README.md`, `docs/spec/system-specification.md`, and
`docs/architecture/system-architecture.md`; the coordinating `brief.md` supplied
owner intent and the 1,500+ card scale scenario.

### Reading and auditing requirements

- **Must:** necessary for the prime directive or its safe, truthful operation.
- **Should:** strong operational value; absence is a substantive improvement opportunity.
- **Could:** optional convenience, not necessary for acceptance of the core experience.
- Each F-number is one auditable requirement; its accompanying check defines evidence.
  Audit outcomes are pass, partial, fail, or not verified, with scenario and source.
  A capability gap is not a pass merely because the current backend lacks support.
- Use retained, backend-permitted evidence, not invented data. “Unknown” is a valid
  answer when evidence is genuinely absent, not a substitute for hiding available facts.
- Notes N1–N3 identify needs whose breadth is not established by current contracts.
  Phase 3 must choose a compliant bounded answer or obtain an owner-approved scope
  decision; these notes authorize no new persistence or stronger completeness guarantee.

## 2. The operator and their goals

The operator observes autonomous engineering work lasting hours or days
and steers it by asking the Analyst. They may
leave and return, understand project intent better than every implementation detail,
and need evidence before intervening. They are not a dispatcher, per-agent supervisor,
or routine editor of the agents' work. The Analyst is their ordinary steering channel.

Ranked questions, derived from urgency and consequence rather than current navigation:

| Rank | Operator question | Why it matters | Requirements |
| --- | --- | --- | --- |
| 1 | What is happening now, where did it come from, where can it go next, and can I trust this observation? | Establishes the present situation and its trajectory in context, and whether other conclusions are safe. | F1–F5, F11, F42–F45 |
| 2 | Is work progressing, waiting, or in trouble? | Distinguishes useful autonomy from need for attention. | F3–F5, F17–F20, F31 |
| 3 | How do I act on this through the Analyst, and what happened to my request? | Makes supervision effective without bypassing ownership. | F25–F30, F49 |
| 4 | Why did this happen? | Prevents uninformed retries and incorrect blame. | F8–F10, F12–F20 |
| 5 | What is the work structure and state? | Relates the current activity to project intent and unfinished work. | F2, F6–F11, F40–F41 |
| 6 | What are the agents doing, for which work, and why? | Makes execution evidence understandable rather than an isolated roster. | F11–F16 |
| 7 | What happened over an interval I care about? | Restores orientation through the Analyst using an operator-supplied horizon and available chronological evidence. | F25, F36–F38 |
| 8 | What did the work produce, and how can I inspect it? | Connects activity and completion claims to usable evidence. | F21–F24 |
| 9 | Is a runtime, provider, tool, or configuration problem involved? | Supports diagnosis when ordinary work evidence is insufficient. | F31–F35 |

Accessibility, consistent vocabulary, and progressive disclosure apply to every question
(F46–F48). Priority is not a promise of project completion, throughput, or autonomous correctness.

## 3. Functional requirements by operator need

### A. Establish the situation without investigation

**F1 — Must — First-screen orientation.** On ordinary initial entry, identify the project,
runtime status, current work or its absence, and observation/connection condition without
navigating to another resource. Check: an operator familiar with the vocabulary can
answer those four questions within ten seconds after initial reads settle; failed reads
yield explicit unknown/error answers. Network time is measured separately, not hidden.

**F2 — Must — Active work in context.** Identify the current card and its relationship
to the represented parent chain that led to the current activation, with access to each
represented card's detail. Identify its trajectory through the card's current workflow
position, configured outcome transitions, and represented children where applicable.
Check a multi-level activation and a card mid-workflow: the leaf is not confused with
a parent awaiting its child; the current position and possible next steps are identifiable;
static configured possibilities remain distinguishable from observed execution history
(F9). Missing chain, activation, or workflow evidence is identified, not inferred. See N1.

**F3 — Must — Active participation.** From current-work orientation, identify available
executing named-agent evidence and its card or global scope without searching a global
roster. Check an executing child, its waiting parent, and an interval-waiting Oversight:
none is classified as executing solely because a conversation exists. See N1.

**F4 — Must — Progress evidence.** Provide an immediately discoverable route from current
work to its latest available activity or result evidence. Check a running scenario, one
with no recent recorded activity, and backend-reported internal progress, specifically
selected-session conversation-compaction progress (completed summary calls, in-flight, elapsed):
visible compaction progress is system activity evidence, not agent liveness; its absence
must not be presented as agent idleness. Where refresh failure retains progress, it may
be shown as last-known. Report the observation, not an invented heartbeat, percentage
complete, ETA, or definitive “stuck” classification.

**F5 — Must — Problems relevant now.** Expose known runtime degradation, retained halt
error, and current-card blocking/failure evidence from ordinary orientation without
requiring transcript search. Check each supplied problem fixture and a missing-data
fixture; absence of loaded errors must not be presented as “no project problems.”

### B. Understand the work, not just individual cards

**F6 — Must — Hierarchy orientation.** Let the operator identify a selected card's
represented ancestors, siblings, ordered children, title, type, and lifecycle. Check
deep and wide branches: undiscovered relationships are not described as empty; stable
identity remains distinct from a display path that can change after reorder.

**F7 — Must — Large-tree comprehension.** At 1,500+ active cards, let the operator locate
current work, inspect its branch, and compare the known states of sibling work without
expanding every branch. Check these three tasks on a deep/wide fixture; summaries must
state their coverage and must not imply complete subtree counts or completion rates.

**F8 — Must — Meaningful card detail.** For a selected card, distinguish lifecycle,
working status, accepted result, error/completion facts, version, and declared record
content where projected. Check running, blocked, stopped, and done cards: a work-status
narrative cannot substitute for an accepted outcome, and absent fields are not invented.

**F9 — Should — Workflow explanation.** Let the operator inspect the selected type's
configured entries, agent responsibilities, outcome transitions, and terminal meanings.
Check a custom type and a cyclic workflow: static possibilities are distinguishable
from observed execution; named agents and record declarations are not hard-coded roles.

**F10 — Must — Change explanation and comparison.** Let the operator inspect card
versions, publication times, available ordinary change summaries/fields/actors, a selected
snapshot, and its difference from current. Check an attributed update and null change
metadata: the latter yields no inferred author or cause. Record revisions remain separate.

### C. Understand activity in its work context

**F11 — Must — Work-to-agent navigation.** From a selected card, reach its published
named-agent sessions and return to that card without locating them in a project-wide
inventory. Wherever a session is inspected, including by direct link, expose its owning
card's exact identity or global scope and the session's named-agent identity. For a card
session, expose that agent's configured workflow role/node(s) from the current compiled
graph (which may be plural), the card's observed current workflow position where the
runtime projection supplies it, and the card's place in its represented chain where
available. Static configured roles, observed current card state, and transcript history
remain distinct facts; old node-looking transcript rows are not position authority.
Navigation back into the owning card flow is required only where that flow is available
under the exact card contract. If it is unavailable, including for an exact retained
session whose card is absent from active projections, retain the exact card identity/scope
and present honest unavailability; do not identify tombstone state, search for a replacement,
or fabricate hierarchy/workflow context (F40).
Check multiple agents on one card, the same agent name on different cards, and sessions
reached both from a card and by direct link: the selected session remains exact and its
available flow context is visible; unavailable context is identified, never fabricated
into a session-owned singular position. Check a retained exact session with unavailable
card flow against the same identity and unavailability rules. A global session such as
Analyst or Oversight shows global scope, not a fabricated card context.

**F12 — Must — Inspect the recorded conversation.** Read a selected session's current
indexed segment in source order, with author, entry identity, and available time/context
distinctions. Check user/agent prose, transitions, corrections, and tool rows; presentation
must not fabricate hidden reasoning, prepared instructions, or missing transcript rows.

**F13 — Must — Understand tool effects.** Distinguish a tool call, successful result,
failed result, and final call with no recorded result; inspect the safe projected request
and recorded response. Check all four, including an unknown tool. “No result recorded”
must not imply pending execution, failure, success, or permission to replay.

**F14 — Must — Compaction and historical context.** Distinguish current transcript,
compacted-context metadata, retained instruction context, and an explicitly selected
older segment. Check a segment transition and unavailable historical content: no stitched
continuous transcript, summary prose, or loss of the usable current selection is implied.

**F15 — Should — Provider evidence.** From an exact session, inspect its latest available
settled provider exchange's safe provider/model/account and settlement/request-parameter
metadata. Check no exchange, failed refresh, and absent usage: unknown usage is not zero;
the resource is not a raw HTTP body, prompt viewer, or all-exchanges history.

**F16 — Should — Global activity with purpose.** Permit inspection of published global
participants and cross-card session activity while retaining each session's work/scope
identity. Check Analyst and published Oversight alongside card agents. A standalone
agents-first destination is neither required nor sufficient to satisfy F3 and F11.

### D. Explain outcomes without inventing certainty

**F17 — Must — Outcome evidence.** From failed, blocked, stopped, cancelled, or done work,
reach the recorded outcome and relevant available record/conversation/history evidence.
Check each status, including missing explanation: state “reason not recorded/available”
instead of supplying causality from time proximity. Done is acceptance, not independent proof.

**F18 — Must — Recovery semantics.** Present recorded recovery notices, uncertainty-only
failed tool mates, later activation, and lifecycle correction as separate facts. Check
`model_recovered` and a later Run: neither proves the prior effects, resumes the old call,
or certifies lossless history; stopped remains recoverable, not cancelled or failed.

**F19 — Must — Publication uncertainty.** On abrupt connection loss, preserve the
distinction between last observed state and unknown current outcome. Check a disconnected
pending action: do not declare terminal failure/success or identify publication uncertainty
as its cause without evidence. Explain that connection loss alone cannot establish effects.

**F20 — Must — Safe refusal explanation.** Present authoritative content-policy blocking
through fixed safe diagnostics and exact evidence locators. Check a refusal marker:
no raw refused response, paraphrase, inferred bypass advice, or ordinary provider retry
is substituted for the backend's reported outcome.

### E. Inspect what the work produced

**F21 — Must — Declared card records.** Inspect every record declared by a card's compiled
type, its available current content, metadata, versions, and current-relative differences.
Check custom record names, an absent optional record, a missing required record, and a
failed historical read; absence, failure, and accepted empty content remain distinct.

**F22 — Must — Artifact access.** Follow admitted record/file/output references from work
evidence into read-only inspection. Check a valid text artifact, oversized or unsupported
preview, and unavailable target: keep its identity and explain the admitted failure category,
without exposing physical persistence paths or silently substituting a different artifact.

**F23 — Should — Recorded provenance.** Identify who produced or changed an artifact
where a tool result, process owner, record, or change entry supplies that relationship.
Check a known association and an unrelated generic file: inferred attribution must not
replace “not recorded.” No universal file-authorship index is assumed.

**F24 — Must — Process output completeness.** Inspect process result status/exit and
stdout/stderr separately, with their complete/partial indicators and canonical log links.
Check a retired process whose returned log remains readable and one whose log is absent;
retirement must not erase the known link or promise log retention.

### F. Direct the system deliberately

**F25 — Must — Analyst access with context.** On ordinary desktop inspection journeys,
converse with the configured shared Analyst while retaining access to inspected content.
Check “why did this card stop?” and “summarize this file”: active entity/refinement is
provided; ambiguity prompts clarification. The dedicated read-only Analyst inspection
exception remains as specified by current policy.

**F26 — Must — Intervention readiness.** Explain whether the observed lifecycle admits
ordinary Analyst mutations: settled paused/stopped versus starting/running/pausing/
closing/error. Check transitions and stale observations: readiness is not HTTP health,
not a reservation, and not a universal gate overriding operation-specific exceptions.

**F27 — Must — Two distinct direct controls.** Offer only Stop project and capability-
gated Restart server as direct runtime mutations. Check Stop enabled/disabled lifecycle
states, restart unavailable, rejected confirmation, and exact `RESTART SERVER` confirmation.
Explain halt versus server shutdown; neither control is card cancellation or project Run.

**F28 — Must — Truthful action feedback.** Distinguish sending, busy/admission denial,
returned failure, accepted effect, and subsequent observation failure. Check a successful
Stop followed by failed refresh and an accepted restart: the former remains a successful
command; the latter means scheduled shutdown, not replacement readiness. Never auto-replay.

**F29 — Must — Shared Analyst semantics.** Make clear that the Analyst conversation is
shared, not a private browser task. Check overlapping submissions: a losing busy request
has understandable feedback, preserves newer draft edits, and is not queued or retried;
closing the browser is not represented as cancellation of the shared turn.

**F30 — Should — Evidence of intervention.** Let the operator inspect retained settled
control-action evidence with its recorded actor, target, time, and ok/denied/error result.
Check an admitted effect followed by caller disposal: its successful audit is not relabelled
as failed. Missing audit evidence proves neither no action nor permission to repeat it.

**F49 — Should — Analyst-driven navigation.** On request, the Analyst navigates the
workspace on the operator's behalf: open an exact card, session, or view, or go logically
Back to the previous workspace view/entity without re-recording the restored destination.
Navigation can be combined with mutation in one turn. Check “open card card-g” and
“show me the latest planner session for card-g” style requests, consecutive Back operations,
and navigation combined with mutation: Back traverses logical workspace history rather
than oscillating between two views; only strictly validated successful navigation results
take effect; failed or malformed navigation results are inert and change nothing.
Grounding: operator-ui.md §6, as recorded in the salvage map.

### G. Diagnose runtime and integration problems

**F31 — Must — Recorded errors.** Reach available recorded runtime and failed-tool/MCP
error evidence, retaining supplied time, identity, and safe diagnostic text. Check an
activation rejection distinct from a card failure; the explanation must not depend on
exception stacks or a fictitious durable runtime-status history.

**F32 — Should — Routing availability.** Inspect configured candidates and current
process-local routing availability, distinguishing recorded cooling/blocking state from
present eligibility. Check restart and deadline expiry: no durable health history or
base URL is inferred; missing token/cost/usage metrics remain unknown.

**F33 — Should — Process and integration diagnosis.** Inspect currently listed processes
with supplied owner/card identity, status, output references, and MCP connection/status
evidence. Check retirement: a no-longer-listed process is not reconstructed as a completed
history row, and visible ownership never grants a terminate control.

**F34 — Should — Configuration understanding.** Inspect safe configuration projections
and installed workflow/model/tool bindings. Check a next-start configuration change:
the saved configuration must not be mistaken for current execution bindings. Offer no
direct editor, prompt-body viewer, hot reload, or compatibility interpretation.

**F35 — Should — On-demand checks.** Request read-only doctor-style diagnostics and
inspect current-epoch Oversight eligibility/outcome diagnostics on demand. Check never-run,
waiting, checking, unavailable, failed, and unknown cases where provided: waiting is not
busy; a nominal due time is not a guaranteed check. No manual Oversight trigger is implied.

### H. Regain orientation over time

**F36 — Must — Scoped chronology.** Navigate the available chronological evidence for
selected work across card versions, record revisions, and session segments. Check an
hours-long scenario: identify source and coverage of each sequence and reach its evidence;
timestamp proximity does not establish cross-resource causal or atomic order.

**F37 — Should — Interval catch-up through the Analyst.** Through the Analyst conversation,
obtain relevant available changes and current outcome over an operator-supplied horizon
(a time or known version/entry) without rereading every transcript. Check a request with
an explicit horizon and incomplete evidence: the answer states its scope and omissions
rather than claiming “everything since you left”; no UI-maintained operator-visit state
participates in framing or answering. See N2.

**F38 — Should — Event/activity orientation.** Inspect available retained event evidence
with its kinds, timestamps, scopes, and bounded coverage, and relate exact referenced
cards/sessions where supplied. Check non-card events and missing evidence: events are
not a comprehensive run ledger or a replay of WebSocket invalidations. See N2.

### I. Find, trust, and use the information

**F40 — Must — Exact navigation.** Open/share exact card, session, evidence-entry, and
admitted file references and navigate back without selecting another entity accidentally.
Preserve the exact supplied identity; never normalize identity, guess, or search elsewhere
for a replacement. Check cold deep links, rapid selection changes, malformed IDs, and
missing targets for each resource against its authoritative contract: score whether exact
selection is preserved and its prescribed invalid/not-found outcome is honestly presented.
Malformed Cards routes make no detail request and share the same **Card not found**
presentation as typed detail 404s; malformed direct Agent routes instead show a
distinct invalid-session state without mounting detail. These per-resource
presentation differences are contract-owned (see the contracts register).

**F41 — Should — Discovery at scale.** Find work by operator-known identity or title and
refine by relevant state without exhaustive manual expansion. Check a matching card
outside loaded branches in a 1,500+ card fixture: search must declare its searched scope;
loaded-only “no matches” cannot mean project-wide absence. See N3.

**F42 — Must — Freshness honesty.** Distinguish accepted REST observations from live
transport status and failed refresh. Check a connected socket with a failed REST read:
retained data stays qualified. Show the resource's applicable refresh information; no
runtime age-based stale state or event timestamp may masquerade as authoritative freshness.

**F43 — Must — Understand update behavior.** Explain which inspected resources refresh
from hints/reconnect and which require explicit observation. Check a conversation update,
a file change, and an event publication: do not promise Files/Processes/event invalidations,
polling, or guaranteed delivery. Provide permitted resource-local refresh/retry paths.

**F44 — Must — Distinct degraded states.** Distinguish not loaded, loading, accepted empty,
refreshing, refresh failed, offline/reconnecting, unauthorized, and typed not-found.
Check each independently: transport loss is not stopped runtime, an initial failure is
not empty data, and unexpected server errors remain safe opaque errors.

**F45 — Must — Stable inspection.** Preserve accepted content and the operator's reading
position during unrelated loads and same-resource refresh failures, subject to authoritative
selection/not-found teardown. Check new transcript entries while reading older entries:
the operator can pause following and reach newly arrived content without losing their place.

**F46 — Must — Accessible operation.** Complete orientation, card/session inspection,
Analyst submission, and permitted controls with keyboard alone and accessible names,
visible focus, and non-color status meanings. Check these journeys with a screen reader
and zoomed desktop text; relationship/status information cannot depend solely on a diagram.

**F47 — Should — Consistent, layered explanation.** Use consistent lifecycle/uncertainty
terms across resources, with plain-language explanations and inspectable technical evidence.
Check stopped versus cancelled, blocked versus failed, and active versus merely recorded;
answer basic questions without opening raw payloads while keeping safe details reachable.

**F48 — Could — Presentation preferences.** Let the operator adjust reading density or
detail disclosure without changing server state. Check preference changes during an
inspection: identity, lifecycle meaning, evidence access, and uncertainty indicators remain.

### Retired requirements

F39 (personal return point) was removed by owner decision on 2026-09-20 — the UI keeps
no operator-visit state; catch-up is Analyst-mediated with operator-supplied horizons.
F50 (Bootstrap reachability) was removed by owner decision on 2026-09-20 — no
authentication/bootstrap UI; trusted host-local/LXC access behind deployment-owned
isolation with auth-disabled deployments. Future user authentication is separate scope;
backend bearer-auth capability and outbound secret non-disclosure remain unchanged.
All other F-numbers remain unchanged.

### Capability boundaries needing phase-3 resolution

- **N1 — Current-work synthesis (F2–F3):** runtime ownership, current-card identity,
  committed hierarchy, and backend-decorated session liveness exist. Runtime status also
  supplies a per-owned-card process-state projection of observed entry/node/terminal
  position; the compiled workflow/Debug-Graph projection supplies configured entries,
  nodes, outcome edges, and terminals. Their integrated presentation in current-work
  orientation (chain, workflow, and session together) is not established today. Current
  policy permits these process-state and compiled workflow/Debug-Graph projections as
  evidence for card workflow position. Agent liveness/activity comes only from
  backend-decorated session summaries; the browser performs no runtime join and derives
  no agent/session liveness or ownership from card process-state, actor state, graph
  mappings, or any combination of them. Current policy prohibits bootstrap global inventory
  fan-out. A new presentation must use permitted evidence, not add a shadow ownership
  model or infer history or planned destinations beyond available evidence.
- **N2 — Catch-up (F37–F38):** card/record history, conversation segments, retained app
  events/errors, and control-action rows provide bounded evidence. There is no complete
  durable Run/global activity ledger, durable actor cursor, or “last visit” contract.
  Existing UI has no event timeline consumer. Catch-up is Analyst-mediated with
   operator-supplied horizons; no operator-visit state tracking viewing/reading over time or dedicated UI catch-up surface
  is built. A new ledger, guaranteed digest, or alert service is not authorized.
- **N3 — Broad discovery (F41):** no global card index or complete browser inventory is
  guaranteed. Project-wide title/state discovery support has not been established here.
  Phase 3 must evaluate existing canonical discovery/Analyst paths or request a scope
  decision; it must not silently crawl all namespaces or build a persistence index.
  The broad-discovery scope decision is resolved: Analyst-mediated discovery is the
  accepted end state; phase 3 commissions no search projection.

## 4. Constraints any UI must respect

Apply `AGENTS.md` and the current authorities, especially the contracts register,
Publication-fatal operator behavior, and system-specification Sections 7–12.

- Projection-oriented inspection and Analyst-mediated mutation remain the product model.
  Stop project and Restart server are exactly the two direct runtime exceptions. This UI
  ships no authentication/bootstrap surface: no token entry, sign-out UI, or provider-secret
  entry. Deployments are expected to run auth-disabled behind deployment-owned isolation
  (trusted host-local/LXC access). Backend bearer-auth capability remains unchanged;
  bearer-configured deployments receive the honest unauthorized state without an in-browser
  remedy. Future user authentication is separately scoped; outbound secret non-disclosure
  and redaction constraints remain unchanged.
- Agent-owned cards, records, notifications, processes, routes, and settings gain no
  direct mutation affordance. Displayed permissions do not reserve invocation-time admission.
- Backend-owned safe projections and outbound secret non-disclosure govern every view,
  copied value, and link. Provider exchange metadata is not raw provider content.
- Canonical file reads own durable truth; process-local runtime/routing observations
  have different lifetimes. Browser caches and lossy hints never become durable authority.
- Current segment and explicitly selected historical segment remain distinct; no raw
  compacted summary or reconstructed provider-private context is exposed.
- Independently ordered session evidence may be juxtaposed, but never represented as one
  canonical cross-session order. Any cross-session ordering claim must be anchored in
  durable publication facts (card versions, retained events, control actions) or explicitly
  presented as grouped/approximate. Canonical segments are never merged; no invented
  sequence replaces per-session source order. Exact context or content unavailable under
  its contract, including F11's exact retained-session case, is presented honestly as
  unavailable, without fabricated context or replacement search.
- Tombstones remain absent from active discovery. Exact known retained evidence exceptions
  do not authorize a deleted-card inventory, forensic browser, restoration, or orphan scan.
- Cutovers remain reset-only; this spec authorizes no migration, compatibility reader,
  reset control, automatic lock repair, publication retry, or new recovery protocol.
- Notification queues remain private. Known enqueue/interruption facts prove neither
  delivery nor action; chronology cannot manufacture queue membership or receipts.
- The UI keeps no operator-visit state (no tracked viewing times, last-looked markers, unread/read state, recorded reading positions retained across views or visits for later resumption, or return-to-reading points); no viewing-derived state may frame catch-up or derive “what's new”; horizons are operator-supplied in conversation. Ephemeral session-local navigation history (including Back and Analyst-driven Back) is navigation mechanics, not operator-visit state; ephemeral in-view stability of the currently mounted presentation (scroll/content stability during loads, refreshes, and live updates, including follow/pause-follow) is presentation behavior, not operator-visit state.

## 5. Explicit non-goals

- Designing routes, panel proportions, component libraries, graph layout, or visual style.
- Deciding to remove the current Agents destination or choosing a merged conversation view.
- Making the operator micromanage agents, edit workflows, or operate a configuration console.
- A complete historical ledger, guaranteed catch-up digest, completed-process archive,
  hidden-reasoning inspector, cost estimator, progress predictor, or stuck detector.
- Mobile-first design and mobile support remain out of scope for this redesign; acceptance
  targets 1920×1080 desktop, while a future mobile-phone-friendly display is a phase-3
  forward-compatibility design input: avoid decisions that structurally foreclose a later
  mobile-friendly presentation. Multi-project fleet management and individual operator accounts
  are not introduced into the shared project/Analyst model.
- Deployment actions, state inspection on live installations, persistence repair, or reset.

## 6. Open questions for the owner

### Owner decisions

**Q1 — Answered: canonical end state.** At the phase-3 cutover, replace
`docs/spec/operator-ui.md` with this needs specification promoted to `docs/spec/`
and a new low-level contracts document (working name `operator-ui-contracts.md`)
seeded from the salvage map. Discard and re-derive the remainder through the redesign;
operator-ui.md remains the behavior authority during phases 1–2.

**Q2 — Answered: Analyst-mediated catch-up.** The Analyst analyzes what has been happening
and answers the operator's questions. When the operator wants a look-back horizon, they
supply it in the request (a time or known version/entry). The UI keeps no operator-visit
state tracking viewing/reading over time—no tracked viewing times, last-looked markers,
unread/read state, recorded reading positions retained across views or visits for later resumption,
or return-to-reading points—and
builds no dedicated catch-up surface. N2's prohibitions on a new ledger, guaranteed digest,
or alert service remain unchanged.
Clarification confirmed by the owner on 2026-09-20: the prohibition covers viewing/reading
tracking only, including recorded reading positions retained across views or visits for later
resumption; no viewing-derived state may frame catch-up or derive “what's new”. Ephemeral
in-view stability of the currently mounted presentation (F45)—scroll/content stability during
loads, refreshes, and live updates, including follow/pause-follow—is presentation behavior,
not operator-visit state, and remains permitted. Ephemeral session-local navigation history
(F49/F40), including Back and Analyst-driven Back, is navigation mechanics, not operator-visit
state, and remains permitted.

**Q3 — Answered: situational supervision with trajectory.** The dominant operator task
is understanding what the system is doing right now, where that activity came from,
and where it can go next, always in context. The card is the operator's primary
granularity. An agent conversation is intelligible primarily within its card's flow—
its chain position and workflow position—not as an isolated inventory entry. Phase 3
designs the card view around activity embedded in that flow context. This decision
weights phase-2 gap severity highest for situational-awareness and activity-in-context
requirements, including F2 and F11; it does not change requirement priorities or authorize
inferred history or destinations.

**Q4 — Withdrawn as an owner question: phase-3 design evaluation.** The presentation
of multiple agents' conversations within the card view is a design-level decision,
not a functional requirement. Q3's card-centric frame remains decided. Phase 3 must
evaluate candidate presentations, including but not limited to the interleaved
cross-agent chronology and parallel contextualized tracks discussed with the owner,
plus any other presentations phase 3 devises. Score each candidate against three criteria:

- **Fit with this specification:** in particular F2, F11, F12–F14, and the constraints
  of no invented cross-session order, no merging of canonical segments, backend-decorated
  liveness authority, and honest unavailability.
- **Practicality for the operator's dominant tasks:** situational supervision with
  trajectory and activity in card-flow context, as decided in Q3.
- **Implementability:** backend modifications are permitted, but their cost and risk
  must be weighed; candidates must not assume a full backend rewrite is acceptable.

**Q5 — Answered: desktop target and accessibility acceptance.** Design and acceptance
target 1920×1080 desktop. A mobile-phone-friendly display is desired in the future;
phase 3 must treat that goal as a forward-compatibility design input and avoid decisions
that structurally foreclose it. Mobile support is not an acceptance requirement of this
redesign and remains out of scope.
Accessibility acceptance formalizes exactly F46's core-journey bar: keyboard-only
operation, accessible names, visible focus, and non-color status meaning for orientation,
card/session inspection, Analyst submission, and permitted controls. No formal WCAG
level is claimed; accessibility beyond these core journeys is best-effort.

**Q6 — Answered: discovery scope (2026-09-20).** “Only option A. The Analyst handles
that kind of things.” F41 is satisfied through the Analyst conversation: server-side
card discovery via the Analyst's canonical card tools plus F49 navigation. No backend
search projection is commissioned; browser namespace crawling and persistent search
indexes remain prohibited. F41 stays a Should satisfied through that path.

**Q7 — Answered: no authentication/bootstrap UI (2026-09-20).** Owner decision:

> "I think we can really drop the token thing. In the future we could add some form of user authentication. Currently, saivage is expected to be used from the host machine where the LXC where saivage lives is contained, so we can relax the security model."

The redesign ships no token entry, sign-out UI, or provider-secret entry. Deployments
are expected to use the backend's existing auth-disabled mode behind deployment-owned
isolation (trusted host-local/LXC access). Backend bearer-auth capability remains unchanged
for deployments that want it; F44 retains the honest unauthorized degraded state without
an in-browser token remedy. Outbound secret non-disclosure and redaction constraints are
unchanged, not relaxed. Proper user authentication is a future separately designed product
possibility, not current scope.

### Remaining questions

None remain at specification level. Phases 2 and 3 may surface new owner questions,
but no spec-level owner question is open.

## 7. Provenance: phase-1 documentation plan and review obligations

This section records the phase-1 authoring process for provenance only; the
register itself in sections 1–6 is the canonical content.

### Problem, evidence, and root-cause hypothesis

The owner gives equal priority to seeing and understanding current activity and acting
through the Analyst, and questions the usefulness of isolated agent navigation and
small/unintuitive card graphs. Those are reported concerns, not established audit findings.
The working hypothesis is that view-led evaluation misses operator questions crossing
work, activity, outcome, evidence, and intervention/action boundaries. Establishing those
questions first addresses the decision-making root cause without prematurely prescribing
a UI implementation fix.

### Scope and alternatives

The minimal coherent deliverable is this self-contained rubric. No runtime, API, UI,
test, or tracked documentation contract changes. The audit and redesign are separate.

- **Spec by current view:** easy to map to code, but entrenches the navigation being
  questioned and cannot assess whether cross-resource operator questions are answered.
- **Spec by operator need (chosen):** separates outcome requirements from presentation
  and permits current implementations or a later overhaul to be assessed consistently.
- **Immediate comprehensive redesign:** may address the root information architecture,
  but lacks audit evidence now and exceeds the owner's explicit phase ordering.

### Ordered main work tasks

1. Read the brief, policy authorities, and current UI structure; establish evidence limits.
2. Author this file with ranked questions, independently checkable requirements and priorities.
3. Submit the complete revision to the coordinator's reviewer; triage factual findings
   separately from proposed remedies and revise only confirmed material defects.
4. Repeat review as required; the fixer owns periodic and final design-value reassessment.
   Hand the reviewed rubric to phase 2 without claiming implementation or audit completion.

### Cleanup tasks

No obsolete code, tests, fixtures, scripts, or main documentation are removed. Keep only
this deliverable edit within the assigned scope; do not clean unrelated working artifacts.
Non-essential robustness, automated cross-source correlation,
and rare corrupted-evidence UX enhancements remain later work, not new core mechanisms.

### Main documentation-update tasks

None in phase 1, by explicit task scope. `docs/spec/operator-ui.md` remains unchanged;
the phase-3 replacement changeset will replace it with the needs + contracts pair:
promote this specification to `docs/spec/` and create `docs/spec/operator-ui-contracts.md`
(working name) from the salvage map's SEED entries, including NEEDS+SEED entries.
Update `AGENTS.md` (Current Authority) and `README.md` pointers to the pair, and assess
corresponding changes to `docs/spec/system-specification.md` (product/API contracts)
and `docs/architecture/system-architecture.md` (ownership).
No related stale main-document claim has been established by this limited investigation;
phase 2 must record any discovered drift rather than silently adopting it as policy.

### Validation and acceptance

Acceptance targets 1920×1080 desktop design and exactly the F46 core-journey accessibility bar; no formal WCAG level is claimed.

Review all 48 active requirements for unique numbering, honest priority, observable checks,
absence of layout prescriptions, and coverage of the ranked questions. Counts: **33 Must,
14 Should, 1 Could**. Check every control, status, historical claim, and evidence source against
the authorities; specifically challenge N1–N3 rather than treating them as implemented.

Use scenario walkthroughs for healthy running work, settled pause/stop, failed/blocked
work, compaction, missing history, refresh failure, unauthorized access, abrupt disconnect,
and a deep/wide 1,500+ card project. Phase 2 records observed UI evidence, not prose matches;
state both usability gaps and backend/policy dependencies. This phase needs document
inspection and adversarial review only, not builds, generated docs, or runtime validation.
No command/test success or reviewer approval is claimed by authoring this document.

### Risks and rollback

Risks are premature layout commitments, unbounded completeness expectations, unsupported
causal attribution, and prioritizing diagnostics over immediate orientation. Requirements
and N1–N3 constrain these; an unsupported proposed mechanism should be removed or narrowed,
not sustained with extra machinery. Owner policy tradeoffs require a decision, not a workaround.
The ten-second check is a proposed comprehension target, not a measured current performance
claim. Rejection or revision affects only this ignored working file; there is no deployment,
format cutover, data rollback, commit, or tracked-document change to undo.
