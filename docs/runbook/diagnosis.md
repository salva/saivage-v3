# Diagnose without inventing outcomes

Start with the exact symptom, project, release and time horizon. Read the owning
surface once; observations are not write authority or evidence of absent effects.
Do not make reset, restart, retry or Run the default response to missing evidence.

| Symptom | First evidence | Safe next step |
|---|---|---|
| Server never becomes ready | Process stderr/journal, exact command, lock classification | [Startup](#startup-does-not-reach-readiness); remain stopped on strict failure |
| UI loads but API is unauthorized | Published auth mode, request status, matching assets | [Authentication](#unauthorized-ui-or-api), not a token-login/reset workaround |
| Long provider wait / pausing | Active request phase, availability, exact exchange classification | [Provider wait](#provider-unavailable-or-overloaded), not blind resubmit |
| Context/capacity refusal | Bounded process diagnostic, selected session/route/summary evidence | [Compaction](#compaction-and-context-capacity); never edit history |
| Process/output/image unavailable | Exact process/stream or image occurrence | [Evidence](./evidence.md), not “completed” or fallback source |
| MCP stale catalog / containment | Definition, binding/catalog, retained owner | [MCP lifecycle](./mcp.md#stop-replace-restart-or-refresh) |
| Current canonical data invalid | Exact owning error and format applicability | [Repair/adoption decision](./state-adoption.md#choose-the-operation) |
| Publication outcome unknown | Fixed fatal stderr diagnostic | [Uncertainty](#publication-uncertainty), no follow-up inspection |

## Startup does not reach readiness

1. Identify exact release/project/config/service command and actual environment
   selection; do not print provider credentials/config or whole environment.
   [Deployment](./deployment.md#start-inputs) lists precedence/strict options.
2. Classify the lifecycle lock. Live null endpoint is only active owner/control
   unavailable; malformed/indeterminate is fail-closed, not absence. An existing
   lock is never automatically removed. Follow separately authorized
   [abandoned-lock handling](./runtime-control.md#abandoned-locks).
3. Distinguish selected-input compilation/binding from network/provider work.
   Undefined scope tool, unavailable expanded model or capability-incompatible
   final surface blocks startup. Card bindings include generated emit_result even
   with an empty operational list; Analyst does not. Correct intended route/tool/
   capability inputs through stopped reconciliation. Startup does not probe credentials.
4. For generated-state rejection, distinguish current damage, missing required index,
   unsupported contract and partial initial publication. No replacement empty
   Analyst/card history, head promotion, prefix salvage or degraded UI. Valid empty
   index is legitimate; absent lazy Oversight differs from broken selected references.
   [State adoption](./state-adoption.md) is the only applicable operation map.
5. Account for known startup effects: init can materialize prompts/YAML/identity;
   ordinary consuming reads can truncate validated torn tails; bounded global mates
   and leaf-to-root card correction can precede a later failure. Listener failure
   does not roll them back. Repeated speculative starts are not diagnosis.

Current card startup reads exact selected heads/documents and linked graph, not
all immutable predecessors. Required indexes, selected current sessions/provider
evidence/records/shared log retain their consumption scope, including stopped cards.
Healthy readiness cannot certify unconsumed history, established empty publication
parents, identity adoption or productive execution. Doctor's `issues_found` is a
bounded ordinary cards-read diagnostic, not repair or global certification.

## Unauthorized UI or API

Static UI/docs can load publicly while protected API requests fail. There is no
browser token-entry/login/sign-out screen. Verify the actual published server auth
mode and matching web assets. Bearer clients supply Authorization; disabled mode
sends none. Never place credentials in URLs, copy secrets into chat/logs, weaken
backend auth to make UI work, or assume the MCP secret authenticates REST.

Use public `/health`, `/health/ready` and `/docs/` for safe orientation. Browser
access in disabled mode needs deployment-owned isolation; it is not safe general
networking. WebSocket uses tickets for observation only; old chat frames close1008.
Correct access through the deployment's authorized auth arrangement, not a new
token UI or filesystem reset. Auth rejection occurs before request validation.
Strict response-validation failure is different from401: preserve bounded safe
operation/status/phase diagnostics, use matching client/server, never expose raw
exceptions or accept arbitrary fallback JSON.

## Provider unavailable or overloaded

Inspect actual configured route/candidate and current-process availability alongside
the source session's settled provider evidence. Availability starts empty after
restart and is routing advice, not durable health or a promised next send. A long
invocation/overload count does not require reopen, restart or another Run.

Exact direct structured `server_is_overloaded`/`overloaded` retries indefinitely:
30,60,120,240,480,then600 seconds repeatedly. Bare503/529 or overload prose is not
that policy. Auth/rate/context/policy evidence retains stronger classification;
other failures remain finite/terminal. Ordinary work can use admitted alternatives.
No success guarantee. Stop/close cancel request/backoff promptly; cooperative Pause
does not cancel an admitted call, so pausing may persist during indefinite overload.

Completed tools/results are never replayed because continuation overloads. Settled
attempt evidence may appear only at terminal settlement; process memory can grow
through an outage and interruption may lose it. Execution/compaction/availability
observations prove neither bytes in flight nor useful progress. No provider countdown
or tool/child/process wait barrier is implied.

### Request deadlines and credential refresh

Provider HTTP consumption has120000ms inactivity and separate900000ms absolute
deadline, both starting before fetch/headers. Headers do not renew inactivity.
Codex renews only on consumed dispatched SSE data events, not comments/partial
frames/event-only/unknown fields. Chat/public Responses/error bodies renew on
nonempty chunks. Continuous data cannot extend the absolute deadline; a fragmented
Codex event can expire despite incoming bytes. Timeout is finite cooling/failover,
not owner cancellation; known success cannot become late timeout during settlement.
Timers end before evidence recording and are not hard real-time/progress guarantees.
Backoff waits are outside consumption windows; refresh/model each has its own scope.

Codex/Copilot refresh spans preheaders and successful body. Inactivity is pre-provider
server_transient/status0: no stale-token request, synthetic401, exchange or auth
replacement. HTTP429 is pre-provider rate_limit, using positive Retry-After seconds/
date timing or >=60s fallback with finite waits/failover; it is not final auth or
overload authority. Other non-OK decisions finish at headers; network/5xx retains
transient policy. Other4xx, malformed complete successful JSON and ordinary nontimeout
body failures retain previous-token fallback, with final auth based on the subsequent
real provider response. No reset/restart/reauth is required solely for these policies.
Refresh rereads/replaces the complete canonical credential file after network
completion; concurrent refresh is last-completed-write-wins and can lose another
credential change. Address a demonstrated auth/refresh race through authorized
credential work, never disclosure or automatic history repair.

Responses encrypted reasoning replays only for the same local provider/account
identity; another identity omits whole encrypted items before admission while
keeping visible text/calls/results. Aliases, not actual remote credential equivalence,
define the boundary: changed model/credentials under one alias remains same identity;
two aliases sharing credentials differ. `invalid_encrypted_content` without stronger
evidence is terminal protocol failure, not strip-and-resend, failover repair or
guaranteed reauthentication remedy. Missing producer provenance is canonical damage,
not permission to fabricate it.

## Compaction and context capacity

Open exact selected Conversations context: Accumulated summary, Retained instructions,
Required model facts, Source and continuation; Segment history is independent.
These explain prepared context, not actual wire delivery. Ordinary null context
has no fabricated summary. Current instructions are loaded config, not historical
templates. Internal summary evidence belongs to the **known canonical source session**
in its exact `provider-exchange.jsonl`, with invocation identity
`internal:compaction-summary:<source-session-sha256>` and summary UUID; no separate
internal conversation/app log or session scan. Card paths are under that card's
`conversations/<agent>/`; globals under `.saivage/agents/conversations/<agent>/`.
Use authorized exact evidence, never a directory inventory.

### Capacity and accounting

Required compaction uses utilization default0.8, trigger0.9, tail0.25 and a fixed
structured Registry candidate, with enabled true. Removed absolute-budget/reserve/
merge/escalation keys do not alias current fields. `account:null` is provider implicit;
`_implicit`/`_` are different explicit aliases. Slash-bearing model IDs are ordinary
data. [Configuration](../guides/configuration.md) owns the exact constraints.

Route binding freezes the largest positive eligible
`floor(utilization * contextWindowTokens) - max_tokens` for preventive preparation.
Each primary candidate still admits its own complete serialized bytes against its
own capacity. A large candidate can fit while smaller fallback is excluded; loss
of the large candidate does not compact just to restore the smaller one. Bigger
windows can increase cost/latency. Fixed summarizer uses2000 output tokens (e.g.
120000-window at0.8 gives94000 usable input), no tools and no self-compaction.
Startup checks empty refine wrapper; actual history/orientation is admitted at use.

Images add `2 * ceil(width/32) * ceil(height/32)` per emitted occurrence, with
complete data URLs measured and32MiB wire cap. This is a local deterministic fit
heuristic, **not billing or guaranteed provider fit**. Frozen bootstrap/node/tools,
protected prompts and required facts are nonsplittable and may dominate context;
there is no eviction/truncation or universal reduction guarantee.

Preventive compaction precedes provider I/O when threshold requires, including
Analyst initial/tool/corrective continuations. Exact local admission builds each
candidate once before turn-start/I/O. Zero-attempt local capacity failure is not
provider context rejection; only a size-fixable compatible candidate permits its
one bounded local compaction. Exact structured eligible provider context exhaustion
has real attempt evidence and at most one authoritative compacted retry with
retained original membership, context-failed candidate first and viable admitted
alternatives. No third pass, second compaction of either kind or fan-out. Accepted
tool effects/results stay outside this seam and never replay.

Preferred tail is `floor(I * tail_fraction)` in marker-defined rounds, including
newest open/inherited round. Whole fitting rounds remain; older straddler is wholly
kept/covered by snap. Only oversized newest round uses a recent row suffix, retaining
the crossing row then snapping backward to safe atomic boundary or zero. Zero target
desires empty suffix; atomic tool/private groups can force more retention or zero
positive endpoint. Preferred plus distinct furthest fallback are at most two
increasing endpoints through one accumulator/successor. Fallback may cover all settled
tail. Preventive selects shrinking/hard-fitting projection, preferring below trigger;
authoritative stops at first token reduction; local exact selects smallest qualifying
image-aware bytes, ties furthest. None guarantees fit or source retention.

### Refusal and summary outcomes

Message wording/token language/nested markers/malformed responses/output-token
exhaustion do not authorize context recovery. Eligible parsed400/failed terminal
direct code/type/param does; actual opened status remains200 for streamed errors.
The separate supported direct invalid_prompt phrase on an opened200 terminal is
summary prompt-flag evidence, not primary retry permission.

Content-policy pin preflights only the refusing candidate; ineligible/oversize pin
terminates without local compaction, wait, substitution or I/O. Only confirmed
overload repeats identical admitted bytes; every other pin failure, including
context/timeout, is terminal without authoritative recovery/failover/third request.
A second refusal yields typed BLOCKED. A later ordinarily authorized tool/plaintext
continuation is a fresh logical input with original ordinary chain, not another pin.

Summary work is <=16 logical calls and one correction, not64 wire attempts. Confirmed
overload repeats packed bytes/summary UUID inside one call, not a completed fold or
omission eligibility. Empty/tool/Chat-length output permits one correction; complete
nonempty prose above12000-byte normal/6000 stronger target is still valid. First typed
policy refusal/prompt flag/content filter stops summary attempts, never regenerates
refusal text. Already fully completed qualifying candidates remain preferred; partial
advance grants no coverage. Unknown/inconsistent Chat completion metadata is terminal.

Eligible exhausted construction/capacity/refusal can select declared **local omission**
at preferred then furthest safe endpoint, without provider call or fold. It may lose
all inherited summary and compactable narration—potentially days of decisions,
hypotheses/tools/next steps—while preserving selected protected instructions, newest
facts, frozen prepared context and exact continuation/suffix. The summary discloses
loss, not semantic preservation; history remains explicitly readable, not automatic
recall. Auth/transport/protocol/cancellation/source/image/invariant/evidence failures
authorize no omission. Evidence-publication failure supersedes fallback/settlement.

Successful maintenance returns already-authorized work to ordinary admission/existing
bounded retry, not task approval; primary may still refuse. Clean no_smaller_projection
publishes no successor and makes no primary retry. Failed no-candidate refusal keeps
card BLOCKED/global safe outcome; preventive/local has no primary attempt, authoritative
retains original primary evidence once. Analyst can accept a later explicit submission;
Oversight waits normal cadence, no immediate automatic check. Other terminal provider
exhaustion retains its safe unavailable error and triggering evidence exactly once.

Analyst mandatory/static orientation capacity can reject **before ingress**; primary
local capacity can reject after durable ingress/compaction/tool effect/result. A fresh
explicit send can be reusable yet fail again under unchanged pressure. Bounded typed
capacity diagnostics are in service process log, not chat/UI Debug/app log. Correct
the actual primary or fixed-summary capacity; restart does not erase pressure.
Internal-summary/config-only/owner-integrity failures retain their own poisoning
policy; repeated500 alone does not identify it. No manual compact, selective
conversation deletion/edit or ordinary reset/migration remedy. Destructive adoption
needs its own explicit decision, not a capacity-recovery shortcut.

## Network exchange observations

Ordinary info-level process logger observations are independent of opt-in private
captures and settled provider evidence. Inspect an already-authorized service
journal or local capture, with exact unit/path placeholders resolved first:

```bash
SERVICE_UNIT='<actual-service-unit>'
timeout --kill-after=2s 10s journalctl --unit "$SERVICE_UNIT" --since '15 minutes ago' --no-pager --output=cat
timeout --kill-after=2s 10s jq -R 'fromjson? | select(.event == "outbound_http_terminal" and .request_id == "<request-UUID>")' '<local-process-log>'
```

Production (NODE_ENV absent/empty) emits structured JSON; development uses
pino-pretty if available, otherwise JSON. LOG_LEVEL absent/empty defaults info;
exact lowercase info/debug/trace show info events, warn/error/fatal/silent suppress;
invalid values fail startup. No CLI level or live reload. Process startup text can
coexist with JSON. These are not canonical JSONL, app Events, API or UI Debug data.

| Event | Interpretation |
|---|---|
| outbound_http_dispatch | Local pre-fetch intent after admission/auth/preabort; not server receipt. Sleeping retry/reused token/rejected admission emits none. |
| outbound_http_headers | Actual numeric status/elapsed, not headers/success. HTTP200 SSE can still fail. |
| outbound_http_terminal | Response handling ended, **before** later credentials/evidence/records; not logical completion or remote-effect proof. consumed=EOF; not_consumed=header-only; cancelled_by_policy=bounded/parser policy, not user cancellation; incomplete=unfinished. |
| outbound_http_retry_wait | Scheduler chose sleep. delay is duration; optional deadline is availability Unix time, not request timeout/next-send promise. Hashed waiting candidate can change on wake. No countdown. |

Correlate request_id/input_id, source_session/card and invocation_session. Source is
initiating agent/card, not destination MCP or saved-record card; globals omit card,
ownerless startup omits source. Agent/model refs are hashed labels, not content
hashes. Prior attempt/request may be absent in shared waits. One lifecycle per owned
fetch, not physical hop: provider/auth/MCP automatic redirects are not separately
observed; manually dispatched web redirects get new UUIDs with same source.

Coverage: Chat/Responses/Codex including custom endpoints, Codex/Copilot refresh,
HTTP MCP initialize/notification/list pages/invocation, Websearch/Webfetch including
record preparation/metadata/bounded reads. Excludes CLI-control/browser API/LiveSync,
shell/package/target traffic, stdio MCP, browser subresources and remote peer traffic.
Only fixed labels/identities/status/time/outcome are emitted, not URL/host/path/query/
redirect Location, headers/credentials/payload/images/tool arguments/results/names,
account/profile/MCP names or raw errors. Endpoint labels cannot identify custom hosts.

Service manager/operator owns rotation/retention/rate limiting/drops. Saivage adds
no file/retention policy, fsync/flush acknowledgement/retry/lossless/crash-terminal
promise. Missing terminal does not mean live; suppression does not mean no request.
Ordinary sink failure preserves transport result/policy without fallback logging.
Publication uncertainty is fatal before any next observation or operation.

## Private failed-request captures

Disabled by default. A separately authorized
`start --failed-provider-diagnostics <fresh-UUID>` arms one finite local capture
session; no YAML/env/REST/UI toggle.
Use a new UUID, not a recurring service argument. Exact destination is
`.saivage/diagnostics/failed-provider-requests/<activation-UUID>/<diagnostic-UUID>.json`.
Exclusive activation mkdir consumes the UUID even on later failure; reuse disables
capture without opening old content. Normal canonical startup gates still apply.

The source owner `src/agents/failed-provider-request-diagnostics.ts` emits format3 /
`failed-provider-request-privacy-2`. Shared16 publication-attempt slots across
primary/summary within one monotonic hour, completion-time eligibility; no timer.
Known capture failures/omissions consume slots without refund/retry. File <=8MiB total
UTF-8 JSON; oversized raw bodies are not parsed, oversized projected envelopes become
metadata-only <=16KiB (`raw_body_size_limit`/`stored_envelope_size_limit`). No prefix
masquerades as full body. <=128MiB publications/temporaries per activation plus tiny
setup; repeated activations can accumulate without bound.

Qualifies: non2xx, HTTP200 terminal SSE errors, malformed/truncated responses,
network/inactivity after model transport entry, parsed content_filter refusals.
Not success, refresh, pretransport/admission, cancellation or successful-request
empty/length summary validation. Finish-reason refusal can still have canonical
status ok. Fixed stderr enabled/disabled/limit-reached/capture-failed notices expose
no content. Known prepublication error preserves provider outcome; publication
uncertainty exits before warning/settlement/retry/cleanup even if cancelled.

**Authorized local inspection only.** Files omits/refuses namespace and aliases
before access; no UI/API link/export/replay. These contain sensitive project/prompt
text, not permission to upload/paste. Session `.gitignore` containing `*` protects
likely accidental staging, not forced add/root access. Diagnostic content/hashes/
dynamic errors are not public reports/log output.

Inspect disposition before fidelity claims:

* Source is exact submitted serialized string, not reconstructed transcript.
  source_session is canonical owner; invocation_session/purpose identify summary;
  input_id/final zero-based attempt_index includes retained/pinned attempts.
  Actual opened http_status differs from embedded_status; code is not inferred from
  prose (`cyber_policy` is not automatically `cyber_attack`).
* Raw hash/byte size includes omitted private/image data. Stored hash/bytes covers
  decoded stored_body string, not outer escaping/file; null when omitted. exact,
  redacted (including reencoding), omitted, reencoded/counts/size_reason matter.
* Projection keeps native visible text/order/function correlation, omits native IDs,
  annotations/citations/unknown extensions, preserving array positions and fixed
  `_diagnostic_omitted_extensions`. `[OMITTED_PRIVATE_REPLAY]`, `[OMITTED_IMAGE]`,
  data URLs and structured auth/header/cookie/env/config exclusions are protocol-
  positional, not ordinary JSON type/ID keys granting native authority. Counts treat
  whole omitted subtree/annotation/extension once, not hidden descendants.
* Only known argument strings decode once as ordinary JSON then reencode;
  unprojectable_tool_arguments is wholly omitted, never raw fallback. Instruction/
  description/result prose is not decoded. Remaining leaves use outbound redaction
  plus active credential-literal removal. Not exhaustive secret certification:
  unusual encoding/sensitive prose can remain. Even normal Codex often redacted
  because cache key is private. Submission/hash proves neither delivery, provider
  receipt, replayability nor the refusal-triggering passage.

Older privacy captures are historical, not retroactively current. No automatic reading,
conversion, scan, rotation, selective temporary cleanup or disposal.
Diagnostics are outside reset roots; reset preserves them. Omit flag at an authorized
later start to disable without reading/deleting old captures. An older Files release
may expose this subtree: binary rollback alone is not safe privacy handling; separately
keep it outside that exposure or remain patched, alongside matching-state obligations.

## Provider commissioning limits

Codex stable opaque owner-session affinity is in admitted prompt_cache_key/session-id,
derived from absolute project root and owner, not input UUID. Primary/summary owners
differ; moved roots change label, equal root/session across installations is not
globally unique. No setting/durable cache state to reset; not encryption/auth or hit,
retention/cost/quota guarantee. Cold/evicted/changed prefixes can reduce reuse.

Offline tests prove composition, not backend hits. Never retain obsolete context,
suppress compaction, expand budgets or expose bodies/headers for a metric. Commissioning
requires explicit deployment/provider/spending authorization, validated pin, normal
stopped safeguards, preserved accounts/budgets, finite pre-agreed time/attempt/input-
spend ceiling, operator able to stop and agreed success/stop criteria; no paid prewarm
or unrestricted resume. Distinguish cold/later same-owner/model/account, reported usage,
weighted cached/input ratio, zero-hit count, gaps/owner/activation/compaction changes.
Unknown usage is not zero or billing. Poor/unmeasurable efficacy or ceiling means
contain expenditure and report unresolved, not silently continue.

## Oversight is unavailable or a check failed

Oversight's selected policy, prompt, allowed read-only tools, model route and
capacity compile even when checks are disabled; disabled policy performs no
credential/network probe. An eligible service epoch waits one full interval after
runtime becomes exactly running, and another full interval after an ordinary
attempt settles. Restart restores conversation, not due time, last-attempt/success
or catch-up schedule; it does not Run. Debug State unavailable during ineligibility
is not failed service health. Read bounded session messages and page the separate
context when needed, not an assumed stable complete snapshot.

Expected provider/refusal/admission failure is an ordinary failed attempt, not
authority for immediate force-check/retry. Fixed `[oversight] owner failure;
application terminating`, bounded shutdown warnings and exit1 instead indicate
owner/protocol/required-settlement failure. Publication uncertainty bypasses that
cleanup at its fatal boundary. Neither permits transcript repair, schedule
reconstruction, reset or unauthorized deployment. Owners:
`src/application/project-oversight.ts`, `src/boot/app.ts`.

## Publication uncertainty

The fixed PublicationOutcomeUnknownError stderr diagnostic means fatal exit before
cleanup. Never inspect/reread/retry its artifact, append logs/receipts, clean descriptors,
take over locks or reconcile the outcome. See the complete
[no-follow-up boundary](./state-adoption.md#stop-on-uncertainty). A separately authorized
new process may consume valid canonical state after positive exclusion/exact lock
handling; it does not inspect or replay the uncertain operation. Run remains separate.
