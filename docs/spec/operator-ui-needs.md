# Operator UI: Functional Needs Specification

Operators need native source ownership visible alongside card outcomes: distinguish
OFF from not-yet-initialized native source, original delivery from private source,
actual correction Executor work from product approval, and last completed delivery
from current checkout verification. Bootstrap has no activation/session. Terminated
commands and missing logical completion retain uncertainty; stopped or queued does
not imply source returned, notification delivery or successful continuation.

Quality evidence must distinguish scoped clean/findings from incomplete analysis,
execution failure and product acceptance. Operators need counts, coverage limits,
omission disclosure and links to full mutable work artifacts without exposure of
code-bearing provisioning. A tool result is not an accepted action-output record.

## Observed source evidence

Operators need to distinguish advisory references from source completeness or
acceptance. Show selected logical views, actual lexical/neural channel facts,
unknown embedding coverage, stale/partial limitations and transformed excerpts.
Offer original-file navigation only for permitted returned paths, distinctly labeled
as a current source preview rather than a metadata/output directory listing. The
current protected read may differ from the indexed observation or fail; navigation
does not refresh indexing or expand reading permissions. Search
absence is not source absence. There is no collection-management or native index
inspection UI; external Analyst receipts remain body-free.

This register defines the operator capabilities required of one project's web UI.
The [contracts register](operator-ui-contracts.md) owns their exact presentation;
the [system specification](system-specification.md) owns backend behavior. These
are current requirements, not an implementation plan or evidence of conformance.

## Purpose and acceptance

The UI's prime directive is to let the operator **see and understand what is going on**
and **take action through the Analyst**—directing, questioning, and requesting mutations—
without taking over autonomous engineering work.
This document defines observable operator capabilities, not pages or visual composition.

The requirements cover situational supervision at 1,500+ active cards, evidence
inspection and deliberate steering. They do not make the operator a dispatcher
or promise autonomous correctness. The owner-selected product acceptance target
is 1920×1080 desktop; preserve the possibility of a later phone-friendly display.
Existing narrow-layout behavior is not a new mobile acceptance guarantee.

### Reading and auditing requirements

Operators need consistently distinguishable JSON keys and values in dedicated
data displays without losing literal text, selection or existing safe-copy
behavior. Files inspection must preserve the received safe text, not reconstruct
it through parsing. Readable JSON decoration is not validation, an editor or an
exact model-wire viewer; ordinary logs and authored prose remain ordinary text.
See the [shared presentation contract](operator-ui-contracts.md#shared-json-data-display).

- **Must:** necessary for the prime directive or its safe, truthful operation.
- **Should:** strong operational value; absence is a substantive improvement opportunity.
- **Could:** optional convenience, not necessary for acceptance of the core experience.
- Each F-number is one auditable requirement; its accompanying check defines evidence.
  Audit outcomes are pass, partial, fail, or not verified, with scenario and source.
  A capability gap is not a pass merely because the current backend lacks support.
- Use retained, backend-permitted evidence, not invented data. “Unknown” is a valid
  answer when evidence is genuinely absent, not a substitute for hiding available facts.
- Notes N1–N3 bound permitted evidence and discovery; they authorize neither new
  persistence nor stronger completeness guarantees. A missing implementation is
  an audit gap, not permission to weaken a requirement.
- There are 48 active requirements: 33 Must, 14 Should and 1 Could. Keep every
  stable F identifier and priority when assessing or extending the UI. F39 and
  F50 remain retired for the reasons below.
- Assess healthy running work, settled pause/stop, failed/blocked work, compaction,
  missing history, failed refresh, unauthorized access, abrupt disconnect and deep/
  wide projects. The ten-second F1 check is an acceptance target, not a measured
  claim. Accessibility requires the F46 core journeys; no formal WCAG level is claimed.

## Operator tasks

Optional CLI/API [work GC](../runbook/work-gc.md) adds no collection button,
dashboard or public maintenance status. During its private hold, new Analyst,
mutation and MCP lifecycle actions can receive temporary busy refusals; operators
must retain read-only inspection and project Stop. Start/Resume cannot bypass the
hold. Existing pause observation remains truthful, not a claim that all filesystem
writers are frozen; a separate ordinary Pause withdraws GC auto-resume intent.
An already stopped project stays stopped, but Start and mutations still receive
busy refusals during its hold. No duration/countdown or automatic completion is promised.

The operator observes autonomous engineering work lasting hours or days
and steers it by asking the Analyst. They may
leave and return, understand project intent better than every implementation detail,
and need evidence before intervening. They are not a dispatcher, per-agent supervisor,
or routine editor of the agents' work. Analyst authority is their ordinary steering channel: the internal conversation when enabled, or explicitly configured direct external MCP operations. References below to conversation-based steering, discovery and interval catch-up apply when internal interaction is enabled; external clients use the same selected canonical tools and real retained evidence, not a proxy chat. The web UI remains an inspection surface in external-only mode. This changes no broader operator need or direct-UI-control restriction.

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

## Requirement register

### A. Establish the situation without investigation

**F1 — Must — First-screen orientation.** On ordinary initial entry, identify the project,
runtime status, current work or its absence, and observation/connection condition without
navigating to another resource. Check: an operator familiar with the vocabulary can
answer those four questions within ten seconds after initial reads settle; failed reads
yield explicit unknown/error answers. Network time is measured separately, not hidden.
Product branding must remain distinguishable from the target project's identity;
the Saivage mark must not replace the project name or current-work orientation.

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
none is classified as executing solely because a conversation exists. An admitted
invocation remains outstanding during provider overload/backoff; executing does not
prove bytes are currently in flight. See N1.

**F4 — Must — Progress evidence.** Provide an immediately discoverable route from current
work to its latest available activity or result evidence. Check a running scenario, one
with no recent recorded activity, and backend-reported internal progress, specifically
selected-session conversation-compaction progress (completed summary calls, in-flight, elapsed):
visible compaction progress is system activity evidence, not agent liveness; its absence
must not be presented as agent idleness. Where refresh failure retains progress, it may
be shown as last-known. Report the observation, not an invented heartbeat, percentage
complete, ETA, or definitive “stuck” classification. An in-flight summary call may
retry overload without adding any completed fold. Attempt evidence may remain
unpublished until settlement; its absence proves neither idleness nor success.

**F5 — Must — Problems relevant now.** Expose known runtime degradation, retained halt
error, and current-card blocking/failure evidence from ordinary orientation without
requiring transcript search. Check each supplied problem fixture and a missing-data
fixture; absence of loaded errors must not be presented as “no project problems.”
Provider cooling is advisory availability, not a failed card or successful progress.
Runtime current identity must remain distinct from retained last-known card problem
detail, including after departure to another card or no current work and return to
the prior identity. Detail loading, authoritative card-not-found, ordinary failed
observation and unauthorized access have distinct meanings; a failed detail read
does not prove runtime work disappeared. Unauthorized observations suppress retained
problem text rather than exposing it as last-known evidence.

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
observed workflow position, recorded result, error/completion facts, card publication
revision, and record revisions. Overview must lead with the effective current content
of the configured bootstrap record as its source-labeled objective, then expose every
other declared current record in declaration order with independent loading, failure,
freshness, and Retry states. Check custom bootstrap and arbitrary record names, Baseline v0
versus Draft for vN versus Accepted effective sources, running, blocked, stopped, and done cards: record
names/content are not automatically categorized as progress, a work-status narrative
cannot substitute for a recorded outcome, revision numbers do not measure completion,
and absent fields are not invented. Complete source content remains directly readable
from Overview, not only through navigation.

**F9 — Should — Workflow explanation.** Let the operator inspect the selected type's
configured entries, agent responsibilities, outcome transitions, and terminal meanings.
Check a custom type and a cyclic workflow: static possibilities are distinguishable
from observed execution; named agents and record declarations are not hard-coded roles.

**F10 — Must — Change explanation and comparison.** Let the operator inspect card
versions, publication times, available ordinary change summaries/fields/actors, a selected
snapshot, and its difference from current. Check an attributed update and null change
metadata: the latter yields no inferred author or cause. Record revisions remain separate.
Retained card evidence contains ordinary snapshots only; records retain accepted evidence plus the sole current draft, not historical drafts. Pending selection is current-only: delivered conversation bodies remain readable, but the UI promises neither a queue audit nor physical erasure. Current mutation revision must be distinguishable from sparse ordinary card versions and consecutive accepted record document versions, with no fabricated locator for a queue-only revision or draft.
Current selection freshness pairs the exact published head UUID with displayed revision; matching numeric revisions alone cannot certify a restored or newly published selection. Preserve the current identity in card/record read models while retaining immutable provenance unchanged. Old authored reviewer prose is evidence, not a new approval. Previous slots are not browsable history, UI recovery controls or normal-reader fallbacks.
Conversation freshness likewise pairs the immutable segment UUID with its displayed ordinal. Lower ordinals must still invalidate, and rollback/recompaction must never mix old and new transcripts even when they share a cursor. Historical ordinal navigation selects the present catalog; immutable identity remains visible in catalog/content contracts, not inferred from a number.

### C. Understand activity in its work context

#### Instructions and record context

Historical preparation distinguishes actual activation identity, root/parent/global
caller, stable card orientation and exact recorded parent direction from current
configured instructions. Parent text is privacy-filtered advisory direction, not
acceptance, wire delivery or model recall. Globals have no synthetic card/parent
context. Non-model ingress is not applicable; unrecorded text is unavailable, and
no current template or record fills missing historical bytes.

Show rendered role/node text in actual node chronology, even when a named-agent
session spans several nodes. At the activation row, **Prepared instructions** has
distinct role/node disclosures and full safe copy. Owned workflow prompts remain
**Recorded workflow instruction** at their original rows; repair/protected details
retain positive provenance. Do not classify unmarked prose by resemblance.

Distinguish **Historical instructions unavailable — not recorded**, **No model
invocation for this ingress**, and an activation start outside the displayed
segment/tail. Earlier instructions remain in explicitly selected indexed source
history, never automatic stitching. **Currently configured instructions** stays
separate and current-only. Shared card/global readers retain tool/image inspection,
anchors, activation jumps, provider details and follow behavior.

Conditional record instructions appear in source order. Separate metadata, slice,
full-body preparation, reference-only and excerpt exposure. Oversized instructions
disclose encoded/redacted display previews and display-byte omissions, not source
offsets or complete bodies. Versionless links read latest effective content, possibly
a newer draft; they do not reconstruct omitted history or waive requirements. The
accepted bootstrap remains full. Latest compacted descriptors retain original
coordinates/time, not new occurrences or recall. Immutable links inspect **record
evidence**, not prepared requests. Internal hashes are not public. Shared server
filtering covers JSON-quoted record text for current/history/protected disclosures
and full copy; preserve safe encoded spelling, not decoded/raw original bodies.

#### Non-LLM executions

Non-LLM action nodes and postcommit advisory hooks need their own **Executions**
facet alongside real agent Conversations. Operators can inspect chronological
entry/process/finish observations, exact operation/version/provider and binding,
committed hook selection, known leader/group/capture facts and selected files.
Native Git steps share this facet with an explicit native label, actual binding,
known effects/ref selections and source return, never a fake provider or product
verdict. Partial native evidence retains the same uncertainty presentation.
An absent log is only absent retained evidence; an unfinished invocation says
**no completion retained; effects unknown**, not live work. Show generated files
as mutable current sources and absent/missing files honestly. Preview and download
must share Files confidentiality and bounded text access, including alias/attic
refusal, without publishing private configuration/environment or raw secrets.
This evidence cannot promise historical artifact bytes, all effects stopped,
workflow acceptance, or replay safety.

**F11 — Must — Work-to-agent navigation.** From a selected card, reach its published
named-agent sessions without locating them in a project-wide inventory. A card session,
including one opened by direct link, remains inside the owning card cockpit with the
selected card, represented tree, header, participant rail, and five facet tabs visible;
participant selection changes the one exact reader without leaving that context. Wherever
a session is inspected, expose its owning
card's exact identity or global scope and the session's named-agent identity. For a card
session, expose that agent's configured workflow role/node(s) from the current compiled
graph (which may be plural), the card's observed current workflow position where the
runtime projection supplies it, and the card's place in its represented chain where
available. Static configured roles, observed current card state, and transcript history
remain distinct facts; old node-looking transcript rows are not position authority.
The other card facets remain available only where that flow is admitted under the exact
card contract. If it is unavailable, including for an exact retained
session whose card is absent from active projections, retain the exact card identity/scope
and present honest unavailability; do not identify tombstone state, search for a replacement,
or fabricate hierarchy/workflow context (F40).
Check multiple agents on one card, the same agent name on different cards, and sessions
reached both from a card and by direct link: the selected session remains exact and its
available flow context is visible; unavailable context is identified, never fabricated
into a session-owned singular position. Check a retained exact session with unavailable
card flow against the same identity and unavailability rules. A global session such as
Analyst or Oversight shows global scope, not a fabricated card context.

**F12 — Must — Inspect the recorded conversation.** Read a selected session's indexed
segment on one conversation-owned scroll surface, with legible prose and secondary author,
entry identity, source coordinates and time. Compact tool summaries keep abbreviated targets
on one visual line, with small intentional stacking in narrow panes rather than long
payload-proportional wrapping; full semantic detail expands directly in the same surface.
Matched tool exchanges appear once at the
call position by owner-authorized visual grouping, even across intervening rows; both
exact Request/Result anchors and original provenance remain inspectable. A later-result
cue prevents backdated knowledge; other messages keep their relative source order.
Reused provider call IDs across source inputs retain independent outcomes and unique
half anchors; matching requires equal session/source-input/call identity.
Recorded system text closes at its source position; diagnostic, refusal and activation
statuses remain visible. A repair instruction is not achieved repair; an interrupted
activation notice visibly says effects are uncertain, with full targeted inline detail.
One arrival-following owner respects scroll-away and Analyst Pause; Analyst Jump is
one-shot and does not clear explicit Pause. Reading/disclosure changes do not force jumps.
Retained content is request-assembly basis, not an exact request or private reasoning viewer.

**F13 — Must — Understand tool effects.** Distinguish a tool call, successful result,
failed result, and final call with no recorded result; inspect the safe projected request
and recorded response. Check all four, including an unknown tool. “No result recorded”
must not imply pending execution, failure, success, or permission to replay.
Always-visible compact summaries identify friendly action, meaningful abbreviated target
and honest outcome, with at most one short faithful reason/observation and without repeated
internal codes/output pills. Failure/refusal, uncertainty, partial effects, confirmation,
delivery not reported, draft versus acceptance, restart/not-contained and meaningful
omitted/truncated/partial coverage remain unhidden, even when critical qualifiers need
an extra line. Expansion shows Request then Result with full tool-specific operation,
target, arguments, observations, content and errors directly inspectable;
exact tool codes, identities and times and complete received safe projected values are
secondary inspection; safe-original request/result disclosures copy the exact received
public strings through the final character, unaffected by summary abbreviation.
Current and selected-history request inspection/copy must filter recognized credentials
in rejected-call locations too, while keeping exact record evidence and source identities
usable; a call with no result receives the same public argument filtering.
An unmatched result stays at its original
position with requested context unavailable. Inspect exact selected image snapshots,
including safe descriptors in raw/copy; snapshot recorded proves neither delivery nor
model perception. Source paths stay text; Files separately previews potentially changed
current sources. Repeated-ID exchanges inspect only their own exact result images, never
another input's snapshot. Check process exit
versus tool settlement, draft versus acceptance, output-head coverage and confirmation
without inventing completion, delivery or unavailable content.

**F14 — Must — Compaction and historical context.** Distinguish current transcript,
selected compacted context, and an explicitly selected older segment. A concise initially
closed outer context disclosure contains independent full safe summary, ordered protected
instructions, required facts and source/continuation sections. Activation index and provider
technical metadata are also optional closed disclosures, not competing scrollports.
Separately inspect composed **Currently configured instructions**, covering the configured
global participant or every matching current workflow node in declaration order, including
retained-card orientation. Label these as server-loaded configuration, never historical
snapshots, dynamic context, tool definitions or exact requests. Open/reopen reads afresh,
Refresh explicitly, close/departure discards; unactivated disk edits are not loaded authority.
Unauthorized, absent/unconfigured and required-current-state-unavailable views must leave
retained history usable. Summary is historical context, not execution/acceptance evidence.
Check a segment transition and unavailable history: no stitched transcript or loss of
current selection is implied.

**F15 — Should — Provider evidence.** From an exact session, inspect its latest available
settled provider exchange's safe provider/model/account and settlement/request-parameter
metadata, including reported input/output/total, cached-input and reasoning-output token facts.
Check partial and absent usage: unreported values are unknown, not zero; cached input is
part of input and reasoning output part of output, not additional totals. Check no
exchange and failed refresh separately. Latest-only scope remains unchanged;
the resource is not a raw HTTP body, prompt viewer, or all-exchanges history.

**F16 — Should — Global activity with purpose.** Permit inspection of published global
participants and cross-card session activity while retaining each session's work/scope
identity. Check Analyst and published Oversight alongside card agents. A standalone
agents-first destination is neither required nor sufficient to satisfy F3 and F11.

### D. Explain outcomes without inventing certainty

#### Image evidence

**Image snapshot recorded** identifies a retained selection, safe source and sent/
resize dimensions, not model delivery or interpretation; continuation may still
fail admission. Safe-original rows/copy remain descriptor-only. Authenticated
inspection shows exact selected pixels without claiming pixel secrets were removed.
All admitted producers share an accessible Fit/1:1 dialog. Closing returns focus
and retains mounted history, expansion, scroll and follow policy, not visit state.
Files uses the same viewer for freshly decoded **Current source** bytes.

Card and Analyst Result halves preserve every typed text/image occurrence in
recorded content order. Generic image inspection requires no workspace metadata
and promotes no ordinary JSON attachment. `view_image` supplies workspace metadata;
native MCP supplies indexed capture facts, never an invented path. Native text/
descriptors appear once, with capture metadata separately inspectable as JSON.
Exact exchange anchors, safe-original copy, uncertainty and one reading surface remain.

#### Loss and selection identity

Loss must be visible without promising preservation or repaired availability.
Strict startup failure leads to [offline repair](../runbook/state-adoption.md#current-format-repair):
stopped service, positively absent owner, fresh complete preserved backup, exact
report/consent and separately authorized restart. There is no degraded control
room, automatic repair, attic browser or repair control. Files refuses attic and
aliases before inspection. Missing owning cards say **Card not found**, separately
from record/version misses.

Synthetic `runtime:repair` FAILED cards show loss status and required bootstrap
placeholders through ordinary Files, not an old approval or completion. Former
unlinked children remain ignored. Repair/startup start no work. FAILED rejects
direct activation only while FAILED: later explicit healthy-ancestor Run may let
its Planner reopen the child to CHANGED and execute unchanged placeholders. Replacing
lost requirements first is recommended, not an enforced operator-only hold.

Head UUID plus revision determines current card/record freshness, not revision
alone or retained review prose. Exact segment UUID plus ordinal determines a
conversation baseline, including lower/reused ordinals; replace/refetch stale
baselines rather than mixing messages.

**F17 — Must — Outcome evidence.** From failed, blocked, stopped, cancelled, or done work,
reach the recorded outcome and relevant available record/conversation/history evidence.
Check each status, including missing explanation: state “reason not recorded/available”
instead of supplying causality from time proximity, workflow position, session activity,
or child lifecycle. Overview neutrally labels the recorded result, reports an available
card error once, and states when current card detail supplies no reason while pointing to
records and conversations only as possible context. Done is acceptance, not independent
proof of correctness; failed completion is an ending, not acceptance.

**F18 — Must — Recovery semantics.** Present recorded recovery notices, uncertainty-only
failed tool mates, later activation, and lifecycle correction as separate facts. Check
`model_recovered` and a later Run: neither proves the prior effects, resumes the old call,
or certifies lossless history; stopped remains recoverable, not cancelled or failed.
After a successful new-server restart, check fresh card detail/tree and cockpit **before Run**:
interrupted cards show their recorded stopped lifecycle, runtime is stopped with no
current card or executing owners, and no work launches. Recovery notices, uncertainty-only
mates, and lifecycle rows remain distinct. Contrast same-process project Stop, which
contains execution but may leave durable cards running until explicit Run or new startup;
the UI must not rewrite those observations to stopped.
A startup-produced configured-global failed mate records uncertain prior effects,
not a new Analyst submission, Oversight check, recovery notice, or active owner.

**F19 — Must — Publication uncertainty.** On abrupt connection loss, preserve the
distinction between last observed state and unknown current outcome. Check a disconnected
pending action: do not declare terminal failure/success or identify publication uncertainty
as its cause without evidence. Explain that connection loss alone cannot establish effects.

**F20 — Must — Safe refusal explanation.** Present authoritative content-policy blocking
through fixed safe diagnostics and exact evidence locators. Check a refusal marker:
no raw refused response, paraphrase, inferred bypass advice, or ordinary provider retry
is substituted for the backend's reported outcome.

### E. Inspect what the work produced

#### Record state and authorship

Distinguish absence, established empty heads, baseline0, draft0/target1, positive
authored drafts and acceptance. **Baseline v0 — not authored or accepted** makes
no progress claim; positive drafts remain unaccepted. Accepted document numbers
are independent of mutable revisions. Historical mutation revision is unavailable,
not derived from document number. Accepted backing remains separately inspectable
without satisfying the effective draft's gates. These distinctions survive recorded
observations and compaction without reconstruction from current templates.

Safe record content remains inspectable. The Analyst may accept content under its
ordinary admission before entry, but an open workflow draft, including an interrupted
scaffold, conflicts. No UI draft takeover or creation-time scaffold preview exists.

Show agent, external credential-holder, runtime bootstrap/repair and action-output
authorship distinctly. Reports retain node, operation, declared output source and actual disposition,
not an agent verdict, completed program work or workflow approval. Accepted versions,
history and diffs retain their own author even for equal-content invocations; capture
inspection is separate. Drafts/baselines never borrow backing attribution. Apply
confidentiality to content, metadata, previews and downloads equally.

**F21 — Must — Declared card records.** Inspect every record declared by a card's compiled
type, its available current content, metadata, versions, and current-relative differences.
Check custom record names, an absent optional record, a missing required record, and a
failed historical read; absence, failure, and accepted empty content remain distinct.

**F22 — Must — Artifact access.** Follow admitted record/file/output references from work
evidence into read-only inspection. Check a valid text artifact, oversized or unsupported
preview, and unavailable target: keep its identity and explain the admitted failure category,
without exposing physical persistence paths or silently substituting a different artifact.
Current and historical record references whose owning card is absent show **Card not found**, distinct from missing record content or an unavailable accepted revision on an existing card. Corruption remains a failure, not card absence.
Read-only inspection offers no repair control and does not promise that backend
consumption is non-mutating: an exact growing-file owner may discard only a proven
torn final suffix after full retained-prefix validation. Complete corruption stays
an honest failure; uncertain truncation is fatal before a response, not a recoverable
missing artifact. Older conversation segments remain immutable.

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
when internal interaction is enabled, converse with the configured shared Analyst while retaining access to inspected content.
Check “why did this card stop?” and “summarize this file”: active entity/refinement is
provided as one submitting client's send-time advisory observation, not ongoing screen observation or proof of reading a file. Only matched active cards have a compact card snapshot; ambiguity prompts clarification. The dedicated read-only Analyst inspection
exception remains as specified by current policy. In external-only mode reclaim the desktop/mobile workspace space: no interactive pane, composer, Analyst tab/activity indicator, skip target or focus/send shortcut. Unknown/loading/failed availability never enables sending; failures remain visible. Preserve browser drafts and the exact read-only historical Analyst inspector, explaining disabled interaction without fabricating external transcript entries. Explicit startup selection also permits direct authenticated external MCP operations, not external chat.

**F26 — Must — Intervention readiness.** Explain whether the observed lifecycle admits
ordinary Analyst mutations: settled paused/stopped versus starting/running/pausing/
closing/error. Check transitions and stale observations: readiness is not HTTP health,
not a reservation, and not a universal gate overriding operation-specific exceptions.
The same owner admission applies to configured external tools; transport availability does not grant intervention readiness.

**F27 — Must — One direct runtime control.** Offer only capability-gated, confirmed
Restart server as a direct runtime mutation; project Start, Stop, Pause, and Resume
have no direct UI controls and are requested through the enabled Analyst conversation or configured direct external MCP tools.
Check running and stopped observations with no such controls, restart unavailable,
rejected confirmation, and exact `RESTART SERVER` confirmation. Explain project
halt versus server shutdown; Restart neither cancels a card nor starts project work.

**F28 — Must — Truthful action feedback.** Distinguish sending, busy/admission denial,
returned failure, and accepted effect. Check a busy Analyst submission and an
accepted restart: restart acceptance means scheduled shutdown, not replacement
readiness. An independent observation failure does not undo an accepted effect;
no action-specific follow-up observation is required. Never auto-replay.
External response loss likewise proves neither failure nor absence of effects; later ordinary reads are fresh observations, not automatic reconciliation.

**F29 — Must — Shared Analyst semantics.** Make clear that the Analyst conversation is
shared, not a private browser task. Check overlapping submissions: a losing busy request
has understandable feedback, preserves newer draft edits, and is not queued or retried;
closing the browser is not represented as cancellation of the shared turn. Other clients' routes do not overwrite a submitted focus, and historical focus is not replayed as current focus.
In both mode internal turns retain this busy rule while multiple external clients operate concurrently through the same domain owners. They do not share a model conversation or an exclusive steering lease. Returning to internal mode on a separate startup retains history, without catch-up transcript synthesis.

**F30 — Should — Evidence of intervention.** Let the operator inspect retained settled
control-action evidence with its recorded actor, target, time, and ok/denied/error result.
The current producer is the bounded audited Analyst mutation surface; valid historical
Planner rows remain evidence. Actions is not complete mutation or runtime-control history.
External mutation rows show `mcp` and `external:<principal>`; separate body-free settled external tool receipts identify the credential holder, not a verified model/person. They are not internal conversation/provider exchanges or a complete effects ledger.
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
This is logical workspace navigation, not retained operator-visit state.

### G. Diagnose runtime and integration problems

#### Configured MCP observations

Recorded lifecycle/discovery exchanges show concise ready/stopped outcomes,
context-loss caution and complete inspectable input schemas, not browser controls.
Restart remains visibly restart: a reported ready outcome means discovery completed
then, not present readiness, remote restart or target continuity. Stop-first restart
is non-atomic; context may be lost, failed containment retains ownership and effects
can remain unknown. Failed/missing results never imply success or replay permission.
The authenticated restart API accepts `{}` under existing authority/default grants.
Current instructions show composed browser guidance, not discovery, pixels or wire.

Distinguish starting from discovery-complete running; show operator/agent definition
origin or its absence for a retained blocker, containment failure, binding and safe
current process association. Association grants no wait/kill authority or captured
protocol output; HTTP has no process association. Registration/removal show recorded
facts, not inferred later lifetime. No topology editor or lifetime timeline is added.

**F31 — Must — Recorded errors.** Reach available recorded runtime and failed-tool/MCP
error evidence, retaining supplied time, identity, and safe diagnostic text. Check an
activation rejection distinct from a card failure; the explanation must not depend on
exception stacks or a fictitious durable runtime-status history.

**F32 — Should — Routing availability.** Inspect configured candidates and current
process-local routing availability, distinguishing recorded cooling/blocking state from
present eligibility. Check restart and deadline expiry: no durable health history or
base URL is inferred; missing token/cost/usage metrics remain unknown. Overload
cooling uses existing resource refresh, not a new poller or countdown, and its
advisory horizon is not an exact invocation send promise.

**F33 — Should — Process and integration diagnosis.** Inspect currently listed processes
with supplied owner/card identity, status, output references, and MCP connection/status
evidence. Check retirement: a no-longer-listed process is not reconstructed as a completed
history row, and visible ownership never grants a terminate control.
Distinguish unavailable group/cleanup authority from actual leader exit and output
settlement. Inspect stream open/EOF/close independently of capture errors; neither EOF
nor leader success confirms cleanup. Later activations cannot take ownership; service-level
intervention belongs to the operator. Historical lists show supplied facts only, not
refreshed liveness or invented missing evidence.

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
selected work across retained ordinary card versions, accepted record revisions, current drafts, and session segments. Sparse mutation revisions are not automatically selectable history; exact absent selectors must show honest local errors. Accepted provenance must distinguish observed current card revision from the ordinary historical link. Check an
hours-long scenario: identify source and coverage of each sequence and reach its evidence;
timestamp proximity does not establish cross-resource causal or atomic order.
Check a marker-only session segment: **Activation entry recorded** remains visible and
opens its real transcript row, but proves neither provider invocation nor completion.
The activation index covers one selected session/segment, not every prior activation;
compacted inherited continuation is context, not another entry.

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
Check direct-control outcomes: returned `pausing` is not paused, Stop preserves both
`contained` results, and restart scheduled is not replacement readiness. Handler rejections
are informational evidence, not runtime errors; missing events do not prove no effect.

### I. Find, trust, and use the information

**F40 — Must — Exact navigation.** Open/share exact card, session, evidence-entry, and
admitted file references and navigate back without selecting another entity accidentally.
An exact card-session link selects Conversations in the persistent owning-card cockpit;
global sessions instead show global purpose without fabricated card selection or tabs.
Preserve the exact supplied identity; never normalize identity, guess, or search elsewhere
for a replacement. Check cold deep links, rapid selection changes, malformed IDs, and
missing targets for each resource against its authoritative contract: score whether exact
selection is preserved and its prescribed invalid/not-found outcome is honestly presented.
Check a Card Evidence segment link and an activation link through cold load, reload,
same-session changes and Back: the exact numeric segment and unchanged opaque marker ID
remain selected. Invalid segment, unavailable exact segment, failed read and entry missing
within an accepted segment are distinct, with no search elsewhere or fallback to current.
Malformed Cards routes make no detail request and share the same **Card not found**
presentation as typed detail 404s; malformed direct Agent routes instead show a
distinct invalid-session state without mounting detail. These per-resource
presentation differences are contract-owned (see the contracts register).

**F41 — Should — Discovery at scale.** Ask the Analyst to find work by operator-known
identity, title, or relevant state without exhaustive manual expansion. Existing exact
references and manual tree browsing remain available, but the cockpit provides no card
search or filter. Analyst results carry no new completeness guarantee. See N3.

**F42 — Must — Freshness honesty.** Distinguish accepted REST observations from live
transport status and failed refresh. Check a connected socket with a failed REST read:
retained data stays qualified. Show the resource's applicable refresh information; no
runtime age-based stale state or event timestamp may masquerade as authoritative freshness.
For Files, a directory read at least 30 seconds ago keeps its listing-age advisory
even when a preview succeeds at second 29 or the other root is read. A failed
refresh retains the listing observation and its age; initial failure is not empty.

**F43 — Must — Understand update behavior.** Explain which inspected resources refresh
from hints/reconnect and which require explicit observation. Check a conversation update,
a file change, and an event publication: do not promise Files/Processes/event invalidations,
polling, or guaranteed delivery. Provide permitted resource-local refresh/retry paths.
Files retains mounted connection-open/connected-registration refresh attempts as
well as navigation and explicit Refresh. Check a reconnect whose directory read
fails while its selected preview succeeds, and the reverse: outcomes remain
independent, and transport connection alone clears no listing-age advisory.

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

## Evidence and discovery boundaries

- **N1 — Current-work synthesis (F2–F3):** runtime ownership, current-card identity,
  committed hierarchy, and backend-decorated session liveness exist. Runtime status also
  supplies a per-owned-card process-state projection of observed entry/node/terminal
  position; the per-type compiled-workflow presentation supplies configured entries,
  nodes, outcome edges, and terminals. Their integrated presentation in current-work
   orientation must preserve their distinct authorities. Current
   policy permits these process-state and compiled-workflow presentation projections as
  evidence for card workflow position. Agent liveness/activity comes only from
  backend-decorated session summaries; the browser performs no runtime join and derives
  no agent/session liveness or ownership from card process-state, actor state, graph
  mappings, or any combination of them. Current policy prohibits bootstrap global inventory
   fan-out. Presentation must use permitted evidence, not add a shadow ownership
  model or infer history or planned destinations beyond available evidence.
- **N2 — Catch-up (F37–F38):** card/record history, conversation segments, retained app
  events/errors, and control-action rows provide bounded evidence. There is no complete
  durable Run/global activity ledger, durable actor cursor, or “last visit” contract.
  Card Evidence and System Events consume bounded retained events; the ordinary exact
  conversation reader indexes activation markers in just its selected segment. Neither
  is a Debug Timeline, all-history index, or global chronology. Catch-up is Analyst-mediated with
   operator-supplied horizons; no operator-visit state tracking viewing/reading over time or dedicated UI catch-up surface
  is built. A new ledger, guaranteed digest, or alert service is not authorized.
- **N3 — Broad discovery (F41):** no global card index or complete browser inventory is
   guaranteed. Analyst-mediated discovery through canonical tools is the accepted
   end state; no search projection is commissioned. Do not crawl all namespaces
   or build a persistence index. The cockpit has no card
  search or filter, including loaded-only filtering; exact navigation and manual browsing
  remain available.

## Shared constraints

Private opt-in failed-provider diagnostics are outside the UI's evidence scope.
Files must omit/refuse `.saivage/diagnostics`, including project/work aliases and
resolved symlinks, before directory, content or image inspection. There is no
diagnostic inspector/export or enablement control. Project/prompt text remains
sensitive after projection; neither redaction nor hashes certify secret-free,
complete, replayable or provider-received input. Canonical request metadata and
historical refusal counts do not establish completeness of internal-summary
refusal observation. Accumulated summary may show a code-owned notice declaring active
memory omission rather than completed semantic summarization. Its full safe text and
existing source/continuation remain inspectable without a new field/screen/counter.
Maintenance evidence is not primary refusal or task approval. Completed-fold progress
counts validated LLM calls only; local omission adds zero. Successful maintenance
returns ordinary primary admission; failed no-candidate refusal retains existing safe
card/global outcomes.

Apply `AGENTS.md`, the contracts register, and the system specification's control,
API, persistence and publication-fatal contracts.

- Projection-oriented inspection and Analyst-mediated mutation remain the product model.
  Confirmed, capability-gated Restart server is the sole direct runtime exception;
  project start/stop and pause/resume are Analyst-mediated, with no direct UI
  controls. This UI ships no authentication/bootstrap surface: no token entry,
  sign-out UI, or provider-secret entry. Deployments are expected to run
  auth-disabled behind deployment-owned isolation
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
  compacted summary or reconstructed provider-private context is exposed, including
  private Responses producer metadata. Existing public routing/account aliases remain unchanged.
- Independently ordered session evidence may be juxtaposed, but never represented as one
  canonical cross-session order. Any cross-session ordering claim must be anchored in
  durable publication facts (card versions, retained events, control actions) or explicitly
  presented as grouped/approximate. Canonical segments are never merged; no invented
  sequence replaces per-session source order. Exact context or content unavailable under
  its contract, including F11's exact retained-session case, is presented honestly as
  unavailable, without fabricated context or replacement search.
- Tombstones remain absent from active discovery. Exact known retained evidence exceptions
  do not authorize a deleted-card inventory, forensic browser, restoration, or orphan scan.
- Incompatible adoption follows the [runbook adoption decision](../runbook/state-adoption.md#choose-the-operation), outside the UI. This spec adds no migration/reset/recovery UI.
  It adds no compatibility reader, automatic lock repair, publication retry or recovery protocol.
- Notification queues remain private. Known enqueue/interruption facts prove neither
  delivery nor action; chronology cannot manufacture queue membership or receipts.
- Analyst may queue normal steering while work runs without Pausing. Urgent results
  distinguish queued-only, interrupted exact work and suppressed interruption;
  none certifies delivery or compliance.
  Pause needs explicit Resume; without an eligible active owner, execution needs
  explicit Run and may still never reach the target. No new queue panel or
  receipt-update timeline exists.
- The UI keeps no operator-visit state (no tracked viewing times, last-looked markers, unread/read state, recorded reading positions retained across views or visits for later resumption, or return-to-reading points); no viewing-derived state may frame catch-up or derive “what's new”; horizons are operator-supplied in conversation. Ephemeral session-local navigation history (including Back and Analyst-driven Back) is navigation mechanics, not operator-visit state; ephemeral in-view stability of the currently mounted presentation (scroll/content stability during loads, refreshes, and live updates, including follow/pause-follow) is presentation behavior, not operator-visit state.

## Product non-goals

- Designing routes, panel proportions, component libraries, graph layout, or visual style.
- A separate agents-first work model or merged canonical cross-session transcript.
- Making the operator micromanage agents, edit workflows, or operate a configuration console.
- A complete historical ledger, guaranteed catch-up digest, completed-process archive,
  hidden-reasoning inspector, cost estimator, progress predictor, or stuck detector.
- Mobile-first design and mobile acceptance remain outside the owner-selected desktop
  target. A future mobile-phone-friendly display is a design input: avoid decisions
  that structurally foreclose a later
  mobile-friendly presentation. Multi-project fleet management and individual operator accounts
  are not introduced into the shared project/Analyst model.
- Deployment actions, state inspection on live installations, persistence repair, or reset.

## Resolved owner decisions

These decisions remain binding; no specification-level owner question is open.
The old phase tasks are complete, not ongoing instructions.

| Decision | Current rule and owning section |
| --- | --- |
| **Q1 — Canonical authority** (2026-09-20, promoted 2026-09-24) | This needs register and the contracts register replace the retired `operator-ui.md`. Requirements remain an acceptance rubric, not proof of implementation. |
| **Q2 — Catch-up** (clarified 2026-09-20) | H and N2: Analyst-mediated answers use an operator-supplied time/version/entry horizon. No dedicated catch-up surface, visit/read tracking, saved return position, guaranteed digest, ledger or alert service. Mounted scroll/follow stability (F45) and ephemeral logical Back (F40/F49) remain permitted mechanics, never viewing-derived “what's new”. |
| **Q3 — Situational supervision** | The card is the primary granularity; activity must be intelligible within its represented chain and workflow trajectory. F2/F11 carry particular situational importance without a priority change or permission to infer history/destinations. |
| **Q4 — Presentation is a design decision** | Withdrawn as an owner question. Multiple-agent presentation is evaluated against F2/F11/F12–F14, no invented cross-session order/segment merging, backend liveness, honest unavailability, practical situational supervision and implementability/cost/risk. No particular interleaved or parallel design, or wholesale backend rewrite, is mandated. |
| **Q5 — Desktop and accessibility** | Purpose and F46: 1920×1080 desktop acceptance, future phone-friendly design not structurally foreclosed. Core journeys require keyboard-only operation, names, visible focus and non-color meaning. No formal WCAG claim; accessibility outside those journeys is best-effort. |
| **Q6 — Discovery** (2026-09-20; clarified 2026-09-28) | F41 remains Should through canonical Analyst discovery plus F49 navigation. No backend search projection, browser namespace crawl, persistent index or cockpit filter, including loaded-only filtering. Exact references/manual browsing remain. |
| **Q7 — No authentication UI** (2026-09-20) | Shared constraints: no token entry/sign-out/provider-secret entry. Expected browser use is trusted host-local/LXC access with auth disabled behind deployment-owned isolation. Backend bearer support and honest unauthorized F44 remain; outbound confidentiality is not relaxed. Future user authentication needs separate design. |
