# Saivage v3 System Specification

This is the canonical functional specification.
Incompatible durable-format cutovers are reset-only.
Mixed-version operation, migration, compatibility reading, format probing, normalization, and rollback against current generated state are unsupported.
An ordinary same-format binary deployment instead stops the old service and strictly starts the new binary against retained current-format generated state; release format knowledge, not startup inspection, determines whether a reset-only cutover applies.


## Contents

- [1. Product Boundary](#1-product-boundary)
- [2. Cards](#2-cards)
- [3. Configured Card Processes And Sessions](#3-configured-card-processes-and-sessions)
- [4. Full-Chain Stopped Recovery](#4-full-chain-stopped-recovery)
- [5. Notifications And Reviewer Arbitration](#5-notifications-and-reviewer-arbitration)
- [6. Activation Outcomes And Cancellation](#6-activation-outcomes-and-cancellation)
- [7. Run, Pause, Resume, Stop, And Restart](#7-run-pause-resume-stop-and-restart)
- [8. Lifecycle Lock And CLI](#8-lifecycle-lock-and-cli)
- [9. Direct File Persistence](#9-direct-file-persistence)
- [10. Prepared Invocation, Exact Admission, And Compaction](#10-prepared-invocation-exact-admission-and-compaction)
- [11. API And Operator Projection](#11-api-and-operator-projection)
- [12. Reset And Failure Consequences](#12-reset-and-failure-consequences)
- [Publication outcome-unknown fatal boundary](#publication-outcome-unknown-fatal-boundary)
- [Appendix: cutovers and recent contract changes](#appendix-cutovers-and-recent-contract-changes)

Read this document top-down for the product model, or jump to the numbered
section that owns the behavior in question. Sections state contracts
normatively; the appendix collects recent cutover-level contract changes.

## 1. Product Boundary

Saivage autonomously plans and executes software work represented by cards.
It exposes an operator server, Analyst conversation, card/agent/file/debug read models, and process-local runtime controls. Pending notifications are a private delivery queue: `queue_notification` is the only public agent-facing notification operation, and no ordinary card read exposes that queue.
The runtime is the only dispatcher.

Default agent allocation is deliberate workflow/API discipline for trusted in-container agents, not a hard-coded privilege system.
Configured agent names remain identities, and the executable source remains the authority.

| Default agent | Card structure/lifecycle tools | Record mutation | Child-creation ceiling |
| --- | --- | --- | --- |
| Analyst | `create_card`, `reorder_child`, `reopen_card`, `cancel_card`, `delete_card`; root control through `start_project`; no `activate_card` or `edit_card` | `write`, `edit`; `record_writes: [brief.md]` | `true` |
| Planner | `create_card`, `edit_card`, `cancel_card`, `activate_card`, `reopen_card`, `reorder_child`; no `delete_card` | `write`, `edit`; `record_writes: [brief.md, status.md]` | `true` |
| Reviewer | no card structure/lifecycle tool | `write`, `edit`; `record_writes: [review.md, review-*.md]` | `false` |
| Executor | no card structure/lifecycle tool | `write`, `edit`; `record_writes: [status.md]` | `false` |

`can_create_children` is only a creation ceiling intersected with `create_card` and the selected parent type's permitted child types; it grants neither reopening nor activation.
Reviewer and Executor settle configured workflow outcomes rather than decomposing or dispatching child work.

Operation admission is caller-aware; similar lifecycle sets do not imply shared authority:

| Operation and caller | Scope/readiness and lifecycle admission | Additional admission | Durable effect |
| --- | --- | --- | --- |
| Planner create | Current Planner card through its active session; parent may be backlog, changed, running, blocked, or stopped | Compiled child type/creation ceiling; every dependency must already be an immediate child of that same parent | Backlog child publication followed by the parent link |
| Analyst create | Explicit global target while intervention-ready; parent must be non-running and otherwise creation-admitted | Selected Analyst ceiling/tool, permitted child type; each dependency need only be an existing active card, with completion deferred to activation | Backlog child publication followed by the parent link |
| Planner edit | Immediate child only; backlog/changed/stopped preserve status, blocked/failed may change, running/done/cancelled reject | At least one supplied editable field and a real title/priority/urgency delta | One metadata update, or for blocked/failed the existing `status -> changed` row then the update; an equal effective patch publishes nothing and does not reopen |
| Planner reopen | DONE or FAILED immediate child through the exact active parent owner | Parent activation remains active/open and application-admitted; target has no activation owner; no caller-supplied parent, activation, reason, content, or ancestor scope | Exactly one child status version to CHANGED; current result/error/completion clear through the existing status effect, historical versions and accepted records remain; no parent/ancestor version, propagation, notification, dispatch, audit, or automatic activation |
| Analyst reopen | Explicit global target while intervention-ready; blocked/done/failed only | No content delta; eligible resting ancestors are included by changed propagation | Status-only changed propagation and notifications; this is not activation |
| Planner cancel | Immediate child through the exact active parent owner | Owner-first delegation; Planner performs no target/status/subtree preflight | Supervisor claims the active suffix and publishes cancellation deepest-first |
| Analyst cancel | Explicit non-root target; no intervention-readiness requirement | Complete requested subtree preflight rejects the whole request if any member is done or cancelled | The same Supervisor cancellation authority after successful preflight |
| Planner reorder | Current parent inferred from the active session, including a running parent | Exact active-child permutation; no extra lifecycle or subtree gate | Real reorder appends one parent-only version; no changed propagation, notification, or control-action audit |
| Analyst reorder | Explicit non-running parent while intervention-ready | Exact active-child permutation and no running member in any requested active child's subtree | Real parent-only reorder followed by changed propagation/notification and ordinary audited invocation settlement |
| Planner activate | Immediate child through the exact active parent owner and invocation lease | Compiled activation type; target entry status; every dependency exactly done; exact Supervisor owner/currentness admission | Running publication and child execution ownership |
| Analyst delete | Explicit global non-root subtree while intervention-ready | No running member; complete survivor-dependency and ordering preflight | Permanent tombstones in dependent-before-dependency and child-before-parent order; this is not cancellation |
| Record mutation | Current active linked target; card-scoped agents only their own card | Matching `record_writes`; every operation-required tool (`write`, `edit`, and prepared Analyst Webfetch requirements as applicable); Analyst lifecycle effect support and no existing workflow draft | Card-agent draft publication, or Analyst open/edit/close followed by record change propagation |

For both reorder callers, an identity filtered active order succeeds with `changed:0` and appends no parent or child version.
It performs no status publication, changed propagation, or notification.
Planner has no control-action audit for either outcome.
Analyst's successful invocation still settles exactly one ordinary `card.reorder_child` audit row as `ok`; that audit is not a card mutation effect.
A real reorder changes only the parent's `active_child_order`; `changed` counts mismatched active ordinals, not movement of retained tombstones.
After an Analyst real reorder, `propagateChange()` walks from that parent toward root until a running card, changes encountered done/failed/blocked cards, and notifies the reordered parent plus the first running ancestor when one exists; Planner performs none of those follow-on effects.

Record tool possession plus a matching `record_writes` glob is necessary but not complete admission.
The current URL must resolve to an active linked card, card-scoped authority cannot cross cards, all operation-required tools must be present, Analyst lifecycle admission must be supported, and an Analyst mutation must find no open workflow draft.
Content-specific checks then reject absent edit content, missing or multiple old strings, empty results, and unchanged content.

Deletion is not cancellation, reopening is not activation, and creation authority is not dispatch authority.

## 2. Cards

Card IDs use the source-derived grammar and depth ceiling in the exact block below.
Root depth is zero; non-root depth is the hierarchical segment count.
CardService domain methods reject malformed card IDs; a well-formed inactive target instead produces that method's specified null, empty, or not-found result.
Each parent has a deterministic local spreadsheet sequence.
Every child-creation call starts at the first segment, derives the exact candidate namespace, and advances only when exclusive candidate `mkdir` returns `EEXIST`; it never enumerates siblings or inspects a collided path.
Successful directory creation is the sole claim authority and permanently consumes that segment, including when later publication or linking fails.
Parent and depth are derived from identity and absent from durable card snapshots.
Derivation never grants membership: exact path and history reads require each next ID in the reached parent's monotonic `child_membership`.
API routes, records, sessions, events, process provenance, and UI links preserve the same value; the mutable one-based sibling-rank label is `logical_path`, is derived from active indices in filtered `active_child_order`, and is null for root.

### Exact card identity contract

<!-- saivage:value-contract:card-identity:start -->
```text
identity.card = {"alternatives":[{"kind":"literal","value":"project"},{"kind":"pattern","source":"^card-[a-z]+(?:-[a-z]+){0,11}$"}],"maximumSegments":12,"minimumSegments":1,"pattern":{"anchored":true,"flags":"u","source":"^card-[a-z]+(?:-[a-z]+){0,11}$"},"segment":{"anchored":true,"flags":"u","source":"^[a-z]+$"},"separator":"-","stem":"card"}
constant.maximum-card-depth-segments = {"unit":"segments","value":12}
```
<!-- saivage:value-contract:card-identity:end -->

One non-root creation attempt accepts exactly `NewChildCardInput`.
After basic input validation it exact-reads and validates the parent, computes resulting child depth, and applies the [exact card identity contract](#exact-card-identity-contract) maximum before ordinary parent workflow/lifecycle admission, child-workflow lookup, dependency reads, fresh-parent reads, namespace claim, or any write.
The over-limit error reports the attempted depth and that source-derived maximum.
In-limit creation next performs ordinary parent admission, resolves the selected child workflow (retaining `No workflow for child type '<type>'.` precedence), and at the [maximum card depth](#exact-card-identity-contract) requires that workflow's compiled `permitted_child_types` be empty; otherwise it rejects with the selected type and source-derived maximum.
Only after this complete initial sequence does it admit existing dependencies and directly claim the first candidate whose exclusive namespace `mkdir` succeeds, progressing within that call only across `EEXIST`.
Every other claim error propagates immediately.
`publishInitialChildCard()` constructs every card property and one closed initial brief; root bootstrap separately accepts only `{title,brief}` and `publishInitialProjectCard()` constructs the exact Analyst-owned project defaults.
The successful child order is namespace claim, complete initial publication and proof, fresh parent reread/admission, second proof, one parent append adding the child to both `child_membership` and `active_child_order`, then fixed runtime/runtime `child_link` history and effects.
Dependencies are immutable after version 1.
Because a new child may depend only on already existing cards, creation cannot close a cycle; canonical whole-loaded-graph validation still rejects malformed dependency cycles.
A claimed but unlinked namespace remains consumed and invisible, and reported write failure authorizes no follow-up read, retry, or reconciliation.

Cards form a strict tree.
Card type is chosen exactly once and selects that type's independently compiled workflow; there is no planning/terminal family.
Child capability comes only from the intersection compiled for the active node between its named agent's global ceiling and the parent type's `permitted_child_types`.
Any card type may permit children.
Card statuses use the exact lifecycle vocabulary below.

### Exact card lifecycle vocabulary

<!-- saivage:value-contract:card-lifecycle-vocabulary:start -->
```text
vocabulary.lifecycle-status = {"members":["backlog","blocked","cancelled","changed","done","failed","running","stopped"]}
```
<!-- saivage:value-contract:card-lifecycle-vocabulary:end -->

`backlog` is the initial creation state: every planner or Analyst created card publishes backlog with null result, error, and completion.
It is inactive, nonterminal, mutable, notification-capable, and incomplete for dependency and descendant-completion checks.
The configured `BACKLOG` entry activates it; generic status moves it to running, and cancellation and deletion retain their separate operation rules.
A real immediate-child Planner `edit_card` delta and an accepted Analyst record mutation modify it without changing its status.

`changed` is an inactive, nonterminal, mutable, notification-capable state representing a card modified since its last activation, and is incomplete for dependency and descendant-completion checks.
It has the configured `CHANGED` entry.
Generic status reopens blocked, done, or failed to changed, while running-to-changed is not an operation.
A real immediate-child Planner `edit_card` delta modifies it in place; an Analyst record mutation rejects it.
It moves to running through activation and to cancelled through cancellation.

`running` is the sole active execution state: a card is running only while a live activation owns and executes its compiled workflow.
It is nonterminal and preserves notifications.
Terminal completion is owned only by a non-cancelled activation outcome on a running card, producing done, failed, or blocked; cancellation moves it to cancelled. The Supervisor alone may publish running-to-stopped after full-Run recovery stabilization or after safely joining an exact urgently interrupted live descendant.
running-to-changed is not an operation, and an exact parent or sibling `activate_card` may join its retained activation.

`blocked` is an inactive, unresolved activation result.
It settles the current activation and returns control to the parent, but it is not dependency-complete, cannot support successful ancestor completion, remains notification-capable, and is absent from the running chain.
An exact parent planner may later re-enter its blocked immediate child only through `activate_card`, which selects the configured `BLOCKED` entry; this is not an operator start or restart action.
A blocked planning card may create a backlog child subject to the ordinary caller, type, dependency, runtime, publication, and linking gates.
A real immediate-child Planner metadata delta or an accepted Analyst record mutation reopens blocked to `changed`; an equal Planner patch does not.
Cancellation, deletion, and reorder retain their separate rules.

`stopped` is inactive, non-running, nonterminal, mutable, notification-capable, and incomplete for dependency and descendant-completion checks.
It is never an active child or running-chain member and is never dispatched automatically.
It is the recovery state: recovery from a dirty shutdown moves any card whose durable status was interrupted or is uncertain to `stopped` to restore a structurally consistent starting point.
Existing intervention-ready Analyst authorized record/card mutations and a real immediate-child Planner `edit_card` delta may edit it without changing its status.
Only explicit project Run or exact parent `activate_card` reuses it through the configured `STOPPED` entry; new child creation remains `BACKLOG`.

`done` is a terminal success state carrying a `DoneResult` with null error and a completion timestamp.
It is notification-empty and not cancellable.
It admits no further activation; an accepted Analyst record mutation, the global Analyst `reopen_card`, or its exact active parent Planner's owner-bound `reopen_card` reopens it to changed, while Planner `edit_card` rejects it, and deletion and reorder retain their separate operation rules.

`failed` is a terminal failure state carrying a `FailedResult` with error equal to its summary and a completion timestamp.
It is notification-empty.
An accepted Analyst record mutation, the global Analyst `reopen_card`, its exact active parent Planner's owner-bound `reopen_card`, or a real immediate-child Planner metadata delta reopens it to changed; an equal Planner patch does not.
It remains cancellable and subject to deletion's separate operation rules.

`cancelled` is a terminal cancellation state reached only through the cancellation authority.
It is notification-empty, not itself cancellable, and carries null result, error, and completion.
It rejects Analyst record mutation and Planner metadata edits and admits no activation or reopening; deletion retains its separate operation rules.

In the Cards operator view, the opaque ID in `/cards/:id` is the sole selected-card authority.
CardStore owns disjoint immediate-child slices, route-selected displayed-only detail, separately loaded compiled record descriptors, exact effective current record content, selected version metadata, selected artifact, and current-relative diff.
Each exact resource remains an independent REST and request-owner authority.

The current Card REST contract is granular.
`GET /api/cards/:id/children` proves active root-to-parent linkage and returns exactly one `{id,title,type,status,permitted_child_types}` parent plus ordered active immediate-child summaries of that same shape.
Required `permitted_child_types` is the card type's ordered startup-compiled child-admission policy; it is not evidence that a current child or descendant exists.
The operation parses each linked child's canonical card stream only to classify that child; it never projects or follows the child's raw links, opens a grandchild namespace, or returns `children`, `has_children`, descendant counts, or another grandchild fact.
A retained tombstoned link is omitted and terminates traversal.
`GET /api/cards/:id` returns only `{id,title,type,lifecycle,version_seq,urgency,created_at,updated_at,allowedActions}` and reads no record definition or stream.
It contains no dependency, assignment, start, note, notification, child, or operator-summary data and imposes no dependency uniqueness rule.

`GET /api/cards/:id/records` proves active linkage and returns the selected card type's startup-compiled declarations in declaration order, with exact `{name,format,schema,bootstrap,current}` descriptors and no write-authority field.
It does not discover dynamic names.
`GET /api/cards/:id/records/:name` validates both path grammars before file access, proves active linkage, resolves declared metadata, and folds the record's exact `record-<stem>.jsonl` stream, returning the current row's effective content.
A missing optional record stream is exactly `Card record not found`; a missing bootstrap record stream, a present empty or malformed record stream, and every unreadable reached current authority are server failures.
Publication uncertainty is rethrown before every ordinary absence mapping and reaches the existing fatal boundary.
Titles, lifecycle summaries/errors, descriptor schemas, and record content are redacted before exact response validation.
Current authored-record content, explicit record versions, and record diffs share the authored-record outbound artifact projection.
Record-diff view selection, equality, line counts, and hunk construction operate on the redacted projected content, so raw secret-only differences that project identically emit no placeholder-only hunk.

Cards freshness frames are strict exact targets; the broad `{t:'invalidate',resource:'cards'}` frame is invalid.
The complete wire union is:

```text
{t:'invalidate',resource:'cards',scope:'children',card_id:<parent-id>}
{t:'invalidate',resource:'cards',scope:'detail',card_id:<card-id>}
{t:'invalidate',resource:'cards',scope:'history',card_id:<card-id>}
{t:'invalidate',resource:'cards',scope:'diff',card_id:<card-id>}
{t:'invalidate',resource:'cards',scope:'record',card_id:<card-id>,record_name:<configured-record-name>}
```

The only unscoped invalidation resource is `runtime`; `timeline`, `files`, and `processes` are not wire values.
A runtime frame is only a lossy trigger for a new combined runtime REST read; it neither authors that response nor supplies age or provenance.
RuntimeStore separately owns whether a current-epoch combined response has been accepted, its payload, initial loading/error, retained-state refreshing/refresh error, and the absolute completion instant of the last accepted response.
Before acceptance runtime status is unknown; accepted `runtime:null` means stopped with no live runtime; an accepted non-null payload supplies its exact status.
The browser has no runtime callback-provenance or age-derived stale model.
Browser-to-server Analyst input is the separate strict `message` envelope and is never valid server egress.
Server event egress is one strict `status | activity | error` union; it has no `message`, `thinking`, unknown, or open member.
Its event-bearing content uses only `connected`, `analyst_turn_acknowledged`, `notification_added`, `control_action_recorded`, `analyst_tool_invoked`, and `tool_invocation`.
`tool_invocation` requires the singular classified `ToolResult` contract.
Every server envelope and content variant is an exact strict object: an undeclared key is structurally invalid.
The server-egress parser returns a validated server value or throws for structurally invalid, unknown, malformed, or wrong-direction input; unknown events are never dispatched through a generic envelope path.
Ordinary Cards freshness is carried only by the scoped identity-only invalidations above; there is no card-history activity payload carrying changed fields.

`children.card_id` names the parent key of `GET /api/cards/:id/children`; `history` names ascending card-version metadata; `diff` names a displayed diff against current; and `record` names one effective current configured record.
The mutation owner publishes targets only after successful canonical publication, according to this effect matrix:

| Successful mutation effect | Exact Cards targets |
| --- | --- |
| Any actual current card-version change to `C` | `detail(C)`, `history(C)`, `diff(C)`, `children(C)`, and `children(P)` when `C` has active parent `P` |
| Child link or reorder owned by parent `C` | the preceding version targets for `C`, including `children(C)` for membership/order and `children(P)` when `P` exists because `C`'s containing row changed |
| Tombstone of `C` | preceding card targets plus one `record(C,name)` for every compiled definition on `C` |
| New closed accepted configured record for `C` | only `record(C,name)` |

No-op and reported write failure emit nothing.
Creation's pre-link bootstrap record emits no record target; the successful parent link emits its parent-version targets.
Authored open, edit, and discard publish durable record versions but emit no Cards target; close emits only its exact record name and never card-version history.
Subtree deletion emits each successfully committed tombstone's targets from its preflight-known parent before attempting the next append.
Targets do not cascade above the containing parent.

An exact invalidation refreshes only an accepted loaded slice or the currently selected accepted and visible detail/record/history/diff scope.
A reconnect takes one synchronous bounded snapshot of accepted hierarchy slices plus the selected accepted record names, mounted accepted history, and visible accepted current-relative diff, then refreshes each member once.
It does not discover ancestors, preload branches, refresh hidden or unselected resources, or retry a scope already stale because its previous refresh failed.
The initial socket open for each authentication/configuration identity is baseline-only; every `reconfigure()` resets this one-open suppression before replacing the connection.
Bootstrap/token change reconfigures, resets CardStore, and starts exactly one ordinary root load whether that request is still pending or already accepted when the baseline socket opens.
Later opens are reconnect-eligible.

Each exact scope has one current request-owner object containing its `AbortController` and promise.
A newer same-scope request immediately aborts and replaces it; success, rejection, and finalization may mutate state only while that exact owner remains current.
Selected record reads pass their per-record abort signal through the exact Card content request and additionally require the same selected `{cardId,recordName}` owner, so a completion after route change cannot affect the new card.
Reset aborts and removes every owner before clearing accepted state.
Refresh starts by marking only that accepted scope stale; success atomically replaces it and clears stale state.
Non-404 failure retains exact accepted data, marks only that scope `refresh-failed`, displays the error, and waits for exact Retry.
A current-owner selected-detail 404 is the exception: it aborts and removes every selected record/history/entry/diff owner, clears all accepted selected-card state, and installs fresh non-retryable typed absence while retaining route identity.
Late completions cannot repopulate cleared state, and selected-card invalidation/reconnect admits no read until a new explicit route fetch succeeds.
Retry performs one immediate REST request, does not refresh siblings, and schedules no further work.
There is no Cards polling, timer, automatic retry, trailing refresh, sequence ledger, acknowledgement, replay, persistent cache, or global refetch.

Displayed “Diff vs current” browser requests follow the [exact source-derived request identity and currentness contract](operator-ui.md#exact-displayed-current-diff-request-contract).

Current authored-record absence handling accepts only the exact strict `{error:'Card record not found',cardId,name}` response for a non-bootstrap definition as empty.
Card-not-found, definition-not-found, any other 404 body, and every other failure remain errors.
Bootstrap absence is canonical corruption and never empty.

| Request state and outcome | CardStore result |
| --- | --- |
| Initial bootstrap record 200 | accept content |
| Initial bootstrap record 404 | initial error, with no accepted value |
| Initial non-bootstrap record 200 | accept content |
| Initial non-bootstrap record 404 | successfully accept empty |
| Any refresh 200 | accept returned content and clear stale/error |
| Refresh 404 after accepted content, for any record | retain exact content stale, expose the refresh error and exact Retry |
| Refresh 404 after accepted empty non-bootstrap record | accept unchanged empty successfully and clear transient stale/error |
| Any non-404 refresh failure after accepted content or empty | retain that exact accepted state stale, expose the refresh error and exact Retry |

An initial non-404 failure is an initial error; the bootstrap record has no accepted-empty state.
Accepted content is carried self-contained in every later open or discarded current artifact, so a refresh 404 cannot authorize discarding previously accepted content.
A non-bootstrap record already accepted empty still represents the same absence after another 404, so that refresh is successful unchanged-empty.
This table governs record responses while active detail exists; clearing records after parent-detail 404 is selected-card teardown, not changed record-404 interpretation.
Independently invalidated hierarchy/detail surfaces expose card inaccessibility without inventing authored content.

On a cold store, route reveal loads each required ancestor-parent slice in order and follows an edge only when the containing accepted non-stale slice represents it.
A stale or failed required slice stops traversal without consuming obsolete membership or auto-retrying.
After a relevant ancestor slice is successfully replaced, CardsView invokes the existing reveal action once; that action may continue through newly represented idle descendants, sharing exact in-flight owners, and is bounded by the [exact card identity contract](#exact-card-identity-contract).
An irrelevant branch replacement does nothing, and a failed-stale ancestor waits for explicit Retry.
Successful detail or detail retained after non-404 refresh failure may remain visible while an absent or stale represented edge leaves the selected tree row and Path unrevealed.
Detail 404 instead clears the selected-card resource scope while neither clearing nor certifying hierarchy.
A direct route outside the current grammar makes no detail read, is not accepted or normalized, and exposes the same explicit not-found/**Back to Cards** recovery state.
Root/current-invalid routes clear route ownership and supersede reveal without cancelling shared hierarchy work.
Route-required reveal takes precedence over collapse intent only along represented edges.
Desktop uses independently scrolling tree and detail panes with no combined Cards scroll, while mobile presents the tree or selected detail as one pane with Back returning to the tree.

Every durable card requires ordered `pending_notifications`.
Backlog, changed, running, blocked, and stopped lifecycle state permits enqueue, while done, failed, and cancelled require an empty list and reject enqueue with `terminal_card`. For a currently owned activation, lifecycle permission is necessary but not sufficient: after its result or cancellation winner is synchronously claimed, enqueue rejects with `activation_closed` before a card append even while durable status can still be running.
Unrelated mutations preserve the list. Cancellation and done or failed publication clear it; BLOCKED activation settlement also clears it before publishing blocked.
Reopening supported statuses to changed uses only the supported `setStatus('changed')` transition; no actor callback or lifecycle-repair authority exists.
No `next_role`, retry count, reviewer phase, recovery cursor, or autonomous-round counter exists.

Authored records are exact versioned rows named directly from safe record names.
Card-type declarations provide ordered metadata hints and exactly one bootstrap; an undeclared valid name resolves deterministically to Markdown with schema `authored-record.v1`.
Each record owns one exact append-only `record-<stem>.jsonl` stream whose rows are the record's versions; opening from a non-open state, every edit, close, and discard each append the next row, so public `v=N` identifies an immutable transition rather than a logical cycle.
The current row carries accepted content plus, when open, the sole draft; discard removes the draft while preserving accepted content.
The schema string is opaque identity/guidance and never executable validation.
Card creation publishes the bootstrap record's nonempty first row with writer `runtime:bootstrap` and publishes nothing for optional records: a missing optional record stream classifies empty, startup validates it only when present, and startup never creates one.

The reusable current URL is exactly `record:///<name>?card=<card-id>` for read, write, and edit; ordered `&v=N` is explicit read-only history.
Extra parameters, historical mutation targets, fragments, noncanonical versions, and old head-token forms are rejected inputs.
Mutation admission first proves the active card, then applies cross-card scope, writer glob, required-tool, and Analyst lifecycle gates in that order using the reached card.
Every denial precedes definition and record-state I/O.
Only an authorized request resolves the definition and classifies current/open-conflict state; the reached card is ordinary call-local data, not write authority, and each later public open/edit/close/discard freshly admits the current card.
Requirements govern entry and acceptance, not free-name admission.
Card-agent mutations resolve or open the current cycle and leave a draft; an admitted first mutation on an undeclared target directly publishes the first open row at the exact `record-<stem>.jsonl` path, and that first publication's exact-target existence check is the sole claim—an existing path object there is unavailable canonical state and is never absence.
Analyst mutations reject an existing workflow draft, close their own new draft, and propagate the card change.
Denial, absent-content, open-conflict, unchanged, old-string missing/multiple, empty-result, and current-state-unavailable outcomes are strict structured failures; there is no recoverable stale result.

Every node requirement is `{mode:'clean'|'continue',gate:'exists'|'updated'}` and must match the node agent's record-write glob so framework close has valid attribution.
`clean + exists`, `clean + updated`, and `continue + updated` require the direct `write` tool; only `continue + exists` may omit it.
Neither `edit` nor `webfetch` substitutes for `write`, and a record-targeted Webfetch additionally requires both `webfetch` and `write`.
On entry, `clean` discards an exact open requirement draft and opens one fresh empty cycle before capturing its numeric head baseline; `continue` publishes nothing.
`exists` requires non-empty effective content; `updated` additionally requires a head version above the entry baseline.
Baselines and reviewer currentness use only card `version_seq` and accepted record `source_version`, not content hashes.

After all acceptance checks, the framework closes non-empty open requirements in declaration order and then other activation-written open records in record-name order.
A graceful non-accepted settlement discards activation-written drafts in that same deterministic name-local manner before generic surface cleanup; rejected correction loops retain them.
Once accepted close begins, a failure is not compensated: the committed prefix remains and no later record is handled.
Publication-unknown permits no follow-up effect.
A hard crash loses the activation-local written set: requirement drafts are handled only by a later node holding that exact requirement, while a free draft remains directly readable, conflicts with Analyst mutation, and may be reused and closed only by a later same-name glob-authorized activation; otherwise whole generated-state reset is the sole resolution.
No scan, catalog, warning inventory, adoption, or selective repair exists.

`webfetch` saves preserve destination identity in `write:{kind,data}` rather than nesting a tool-result envelope.
Plain relative, `project:///`, own-card `tmp:///`, and admitted `system:///` destinations use `kind:'workspace_file'` and data containing respectively `project_relative`, `project_url`, `tmp_url`, or `system_url`; a record destination uses `kind:'record'` and record mutation data containing the reusable `current_url` and exact immutable `version_url`.
A save rejection is the one top-level failed tool outcome.
Audited Analyst record Webfetch runs cancellation/readiness, read-only mutation preflight, exactly one HTTP fetch, cancellation/second readiness, then fresh full mutation admission.
A tool/glob/lifecycle denial, open conflict, or unavailable canonical parent at preflight performs no HTTP request; readiness or admission loss after fetch discards fetched bytes and performs no mutation.

The card-stream row schema is the sole structural parser for each raw row at a read or write stream boundary.
The resulting typed rows then undergo non-parsing semantic stream validation of identity, history, transitions, membership/order relationships, and tombstones; semantic validation does not invoke another Zod parse.

Card state/history/tombstone uses one exact append-only `card.jsonl` stream beneath the card namespace.
Every physical line is the strict growing-file envelope, and each row is one self-contained `card-version` or terminal `card-tombstone` artifact.
Versions are contiguous from one; at most one terminal non-root tombstone exists.
Current is exactly the last row's card; history lists and explicit historical reads select rows from one strict complete fold of the same stream.
Each configured authored record likewise owns one exact `record-<stem>.jsonl` stream of self-contained rows for open, edit, close, and discard transitions; its last row is current and `v=N` selects that exact row from the same validated fold.
Bootstrap starts closed at version one; a missing optional record stream classifies empty and no canonical stream is ever created empty.
Complete malformed, empty, unsupported, identity-invalid, or unreadable card/record stream state fails the owning operation directly; only a syntactically valid absent numeric version is not found.
Readers never enumerate siblings or accept old layouts.

Each parent snapshot has two required duplicate-free direct-child arrays with the same set and length.
`child_membership` is monotonic link chronology and grants reachability; `active_child_order` is the complete reorderable carrier.
Both retain tombstoned IDs because deletion is child-owned.
Immediate hierarchy reads each membership child exactly once, then filter the carrier through live folds; this filtered subsequence is the sole semantic sibling order.
`CardRecord` has no `position`.
Creation appends the newly published child to both arrays in one parent version; `child_link` changes exactly `['child_membership','active_child_order']` with runtime provenance and no piggyback fields.

A reorder request must be a duplicate-free permutation of the exact current active child IDs.
An active-order no-op, including one with interspersed retained tombstones, appends and emits nothing.
A real reorder writes no child stream: it preserves `child_membership` exactly and appends one parent version whose complete `active_child_order` places requested active IDs first and retained tombstones afterward in prior carrier-relative order.
Canonical transition validation is the sole direct-publication owner: it requires a nonidentity complete same-membership permutation, `changed_fields: ['active_child_order']`, exact runtime metadata, and no piggyback field.
Generic card patches cannot carry either relationship field.
Historical `get_card_version` section `children` deliberately pages the selected immutable row's complete stored carrier, which may include retained tombstones; it performs no child-liveness reads and makes no current-liveness claim.

Deletion accepts one non-empty requested-root list and performs one fresh complete active linked-tree preflight.
Duplicate and ancestor/descendant roots are unioned; unknown/root/permission-denied requests, surviving external dependents, and conflicting hierarchy/dependency constraints reject before mutation.
The call-local graph orders intended dependents before dependencies and children before parents, choosing IDs deterministically among ready vertices.
Each confirmed tombstone emits its ordinary deletion history event and card/runtime hints before the next append.
A reported append failure stops immediately and emits nothing for the uncertain append; every possible visible prefix remains dependency- and hierarchy-valid.

Current card history uses the exact discriminant vocabulary below.
Update and delete provenance records the configured agent name supplied by the admitted caller with runtime surface; every other family is runtime/runtime.
Planner edit changes only title, priority, or urgency.
`CardService.editCard()` exact-reads and prunes value-equal fields before any effect; an empty effective patch returns unchanged in every admitted status.
A real backlog/changed/stopped delta appends only the update.
A real blocked/failed delta calls public `setStatus(id, 'changed')`, whose nested fresh business read owns transition admission and status publication, then appends the metadata update from the returned changed card.
If that second publication fails, the completed changed-status prefix and its ordinary effects remain; the error escapes without reread, retry, rollback, compensation, notification, or artifact inspection.
Generic status targets are only running (from backlog/blocked/changed), changed (from blocked/done/failed), and cancelled (from backlog/running/blocked/changed/stopped/failed); running-to-changed is not an operation.
Running/changed preserve notifications, cancellation clears them, and the ordered delta contains `pending_notifications` only when a nonempty list changed.
Supervisor running-to-stopped and STOPPED stopped-to-running remain disjoint fixed-reason status families.

### Exact card history vocabulary

<!-- saivage:value-contract:card-change-vocabulary:start -->
```text
vocabulary.card-version-change-kind = {"members":["child_link","delete","notification_enqueue","notification_remove","reorder","status","terminal","update"]}
```
<!-- saivage:value-contract:card-change-vocabulary:end -->

Terminal completion is owned only by a non-cancelled activation outcome on a running card.
Done/failed/blocked results are respectively `DoneResult`, `FailedResult`, and `BlockedResult`; there is no rework result variant.
The outcome summary must equal its result summary.
Publication always assigns `status_text = summary`, `status_text_updated_at = settledAt`, and empty notifications.
Done has null error and completion equal to that timestamp; failed has error equal to summary and the same completion; blocked has error equal to summary and null completion.
Ordered changed fields are lifecycle, then each actually changed status companion, then notification clear when needed; `change_summary` is exactly those names joined in order plus ` updated`.
Every family rejects relabelling, wrong provenance/reason, wrong or reordered deltas, and piggyback fields.

## 3. Configured Card Processes And Sessions

Any failure escaping the BaseActor main loop is terminal.
BaseActor latches the exact value once, rejects every current and future lifecycle waiter with it, logs it once, invokes the required generic terminal-failure hook once, and never restarts the pump.
A throwing hook is logged separately and cannot replace the primary latch.
CardProcess owns one guarded first-winner activation boundary across normal terminal result, runtime interruption, cancellation/disposal, publication fatality, and actor-main failure.
A callback failure rejects an unsettled activation exactly; if cancellation, Stop, or application close already settled it, that later settlement loses harmlessly while the required exact-owner Supervisor notification still runs.

Configuration requires global `agents`, `analyst_agent`, and named `models.routes`, plus the card-type source form: a complete `card_types` map or omission for the bundled `classic` definitions.
Template definitions contain complete card types, workflows, and record declarations only; agents, routes, providers, compaction, server, and MCP remain global and references from the resolved definitions are validated against them.
Source resolution produces exactly one complete effective `card_types` map before compilation, and only that map reaches runtime consumers and outbound effective-config projections.
An agent owns its prompt, ordered tools, duplicate-free `record_writes` patterns, model route, skill capability, `global | card` session scope, and child-creation ceiling.
Each effective card type owns permitted child types, declared record metadata with exactly one bootstrap record, and a graph whose four entries are `BACKLOG | CHANGED | BLOCKED | STOPPED`.
Each workflow declares one designated notification recipient that exists in that workflow and is card-scoped. Nodes reference one card-scoped named agent, node/correction prompts, strict `{mode,gate}` requirements, optional descendant context, and strict outcome edges.
Every prompt reference is a strict declaration object. Static `agents.<name>.prompt` and node `prompt` use `{reference,compactable?}`; omitted `compactable` resolves to true, explicit true/false is preserved, and `compaction_key` is forbidden. Durable lifecycle-entry, `correction_prompt`, nonterminal edge, and pending-notification prompt sites additionally allow `compaction_key`. At those sites omitted/true forbids a key, false without a key protects every occurrence, and false with a nonempty exact key protects only the latest occurrence of that key. Keys are exact and are never trimmed, normalized, interpolated, or synthesized. A consuming site owns this policy independently of the shared referenced prompt text. Static and current-node flags never change their exact prepared delivery and create no durable occurrence.
Every descendant-context record must be declared by every transitively reachable permitted descendant type, though schemas may differ; arbitrary dynamic record names cannot enter descendant context.
Terminal edges select `DONE | FAILED | BLOCKED`, ordered exports required by that source node, and `current` or reachable `latest_node` promotion. Every DONE edge from a nonrecipient node declares one `pending_notifications` alternative to an existing node run by the recipient, with its own process prompt; recipient DONE edges and all other edges forbid that declaration.

The classic `project` and `goal` artifacts independently preserve the visible plan/review loop; the other seven classic types independently preserve one-node execution.
`classic-typed` supplies the configured graphs above without changing runtime classification.
These names are configuration values, not runtime classifications.
Default Reviewer omits MCP, while default Analyst and Executor list unrestricted configured `mcp_tool_call`.

Each card type is compiled once at startup into one shared immutable semantic state table.
Lifecycle entries, configured nodes, and terminal sinks are actor states; accepted typed outcomes are events and configured edges are transitions.
Every transition has exactly one target identity; consumers look up that state to obtain destination node or terminal identity.
The same configured-outcome transition carries its optional edge prompt and, for a terminal target, promotion and ordered exports. A declared pending-notifications alternative compiles as a distinct conditional event carrying the same accepted outcome and one target node; it participates in reachability, terminal-path, promotion-path, prompt-closure, and Debug Graph projection validation without creating another graph or durable cursor.
The actor starts in its explicit parked ready state, and activation sends the configured `BACKLOG | CHANGED | BLOCKED | STOPPED` entry event.
One activation tracker owns its raw node operation, cancellation signal, and matching completion/failure consumer through containment reporting while sharing the low-level FIFO containment mechanics with the separate provider invocation lifecycle.
When the one node task settles, the actor clears its task slot before invoking the matching function; the tracker consumer then stages the accepted result and sends its event.
A same-node edge explicitly reenters in this exact order: the old task is settled and cleared, its result is accepted and staged, the event is accepted, the transition runs, and state entry starts one new node task.
`BaseActor` performs no task cancellation; tracker revocation owns it.
Ordinary node failure instead stages and sends code-owned `execution:failed`; an app-log publication failure sends no event and halts the current task state for Supervisor-owned runtime halt.
Plain text, malformed results, recipient-node pending notifications, record/evidence failures, reviewer freshness failures, and completion-gate rejection are hidden corrections inside one node task and do not transition or increment the workflow ordinal. They jointly consume that node task's corrective re-arm budget. A nonrecipient accepted DONE candidate with pending context instead follows its configured conditional event and increments like any ordinary cross-node transition.
Activation `run` admits an activation operation; provider invocation `begin` admits one exact lease, whose later `runExternal` remains valid after non-aborting admission close.
This FIFO ownership matches one operation at each current frontier and does not promise generalized concurrent matching.
Promptless BACKLOG/CHANGED/BLOCKED entry contributes no transition message; STOPPED contributes the fixed discarded-position notice and its required configured prompt.
The first node ordinal is `0`; the entry bridge does not increment it, and each accepted cross-node or self-reentry advances exactly once (`0 -> 1 -> 2`).
Live runtime status reports node `executionOrdinal` as a required nonnegative safe integer.
No state ID or ordinal is durable.

`CardProcessActor` executes one compiled node at a time and keeps graph position only in live activation memory.
Each node's referenced named agent supplies the exact ordered operational tools.
Prompt rendering receives that array without `emit_result`; `AgentNodeExecution` directly creates and appends `emit_result` exactly once and last.
It first requires arguments to be a non-null, non-array JSON object, then directly applies the strict `{outcome,summary}` schema; failures remain in the same-node repair loop and consume its joint corrective re-arm budget.
The schema accepts only a configured edge and a trimmed non-empty summary bounded by the [exact terminal-result limit](#exact-terminal-result-limit).
Immediately before each direct terminal append or settlement, this owner parses exactly one strict settlement variant: accepted `{success:true,data:{accepted:true}}`, an ordinary nonempty-error failure with no data, or the pending-notification failure with exactly `{reason:'pending_notifications'}`.
Malformed arguments, record violations, stale descendant context, incomplete descendants, pending notifications, and acceptance all pass that boundary without changing claim, record closure, continuation, publication-uncertainty, or cleanup ordering.
Generated `contractDescription` is the sole agent-template authority for this contract.
The configured global Analyst uses its ordered operational surface unchanged and has no `emit_result`.

### Exact terminal-result limit

<!-- saivage:value-contract:emit-result-limit:start -->
```text
constant.emit-result-summary-max-chars = {"unit":"characters","value":2000}
```
<!-- saivage:value-contract:emit-result-limit:end -->

### Exact node corrective budget

<!-- saivage:value-contract:node-corrective-rearm-limit:start -->
```text
constant.node-corrective-rearm-limit = {"unit":"logical invocations","value":16}
```
<!-- saivage:value-contract:node-corrective-rearm-limit:end -->

One node task permits at most 16 corrective re-arms counted jointly across plain-text results and every rejected `emit_result`: malformed object or schema, pending notifications, record violations, stale reviewer context, and completion-gate rejection. Each corrective notice states the attempts remaining after that re-arm. Exhaustion costs no additional provider exchange. If `emit_result` is pending, the owner first settles it definitively with the ordinary nonempty-error failure `emit_result was not accepted: the node corrective budget is exhausted.` and no data; plain-text exhaustion has no pending call to settle and retains the complete assistant text row. The resulting `NodeCorrectiveBudgetExceededError` follows the ordinary code-owned `execution:failed` path to the FAILED terminal lifecycle and the waiting parent's failed activation result. Exhaustion can also occur without model fault through repeated externally timed notification arrivals at `emit_result` boundaries. Each admitted interception drains—delivers and removes—the entire selected pending notification batch for one re-arm. From a fresh budget, the first 16 such interceptions can re-arm; the next `emit_result` request exhausts the budget before delivering or removing its selected batch. Notification-only exhaustion therefore requires about 17 separate arrivals, each interleaved between recipient correction turns—for example, sustained paced arrivals from a looping sibling abusing `queue_notification`—not a burst or 17 notifications accumulated in one pending batch. The counter belongs only to one live node task, is never persisted, and starts fresh for each later node task or card re-activation.

Configured correction text and runtime diagnostics are separate durable rows. The configured text is the sole `model_repair` row and carries its declaration's compactability; validation errors and remaining-attempt diagnostics are ordinary compactable user context. A rejected tool call's original failed result, selected notification or refreshed reviewer context, and correction rows are built before publication and appended together in one known continuation batch under the fresh continuation input identity, while the result keeps the original call/input identity. Plain-text repair likewise appends configured repair, diagnostics, and ordinary continuation context in one batch. Call rows remain in their earlier envelope because execution lies between call and result. Callbacks and notification/reviewer updates run only after known batch success; publication uncertainty preserves its exact cause and permits no reread, retry, cleanup, or callback.

The optional on-demand skill catalog is the exact `.saivage/skills/index.json` JSON array.
Each entry is one strict three-field object:

```json
{
  "name": "typescript-testing",
  "file": "typescript-testing.md",
  "target_agents": ["executor", "reviewer"]
}
```

`name` and `file` are nonempty.
`target_agents` is a nonempty, duplicate-free array of configured agent names whose global contracts enable skills and list `skill`; the default Planner therefore cannot be targeted.
Entry names are unique.
`file` is a normalized relative path beneath `.saivage/skills`, with no absolute, empty, `.`, or `..` segment.
Unknown entry fields fail the complete index read.
Index order is listing order.

Reviewer, Executor, and Analyst invoke `skill` explicitly; Saivage performs no automatic matching, ranking, selection, preload, or prompt injection.
Omitted `name` lists only entries targeted to the caller and returns the complete tool result `{success:true,data:{skills:[{name}]}}`.
Supplied `name` loads only an entry targeted to the caller and returns `{success:true,data:{skill_name,skill_content}}`, where `skill_content` is the exact UTF-8 file text.
The result contains no target metadata, delimiter, or `loaded` flag.
A missing exact index is an optional-capability case: listing succeeds with `{success:true,data:{skills:[]}}`, named loading returns the generic `{success:false,error:string}` unavailable result, and absence is not cached or replaced by a created file.
A present malformed index, old-schema entry, duplicate name, invalid path, missing selected skill file, or other read failure returns that same generic failed ToolResult shape with its actionable error; there is no fallback, normalization, or skill-specific failure projection.
A name absent from the caller's filtered catalog and a name targeted only to another role are both unavailable.

At node entry the owner appends the activation marker, designated-recipient notification context or reviewer context when present, and immediate lifecycle/edge transition context when present. Nonrecipient nodes never receive or remove notification context at entry or continuation. It does not append the current node prompt: before any record, notification, or ingress effect, the actual compiled process/node selects that prompt's unaltered full text for the activation-local prepared node block.
Nodes referencing the same agent on one card reuse its stable session; a transition to another agent selects that agent's card session.
Immediate edge context contains only source node, accepted outcome and summary, accepted record URLs, and its optional edge prompt.
That handoff is delivered once rather than repeated as prepared context, but accepted facts, record evidence, and still-applicable instructions remain applicable after delivery. A later node prepares its own node text and generated outcome/tool contract; neither old rows nor summary prose select graph position.
No accumulated graph state is persisted.

One hidden corrective loop owns plain text, malformed or unknown results, record violations, pending notifications, planning completion, and reviewer currentness. Its single per-node-task budget permits at most 16 corrective re-arms across all of those causes; ordinary tool invocations and blocked or provider-error outcomes do not consume it.
Terminal completion is enforced by strict actor verification and these acceptance gates, not by a provider terminal phase.
Corrections remain in the same logical node, session, baseline, and role.
After all read-only gates, recipient terminal candidates with pending context remain in their same-node correction path. A nonrecipient DONE candidate validates records, descendant freshness, completion, and promotion, then synchronously tests only whether context is pending and either claims the ordinary terminal result when none exists or selects its compiled conditional event without claiming when context exists. Queue entries are not exposed to that nonrecipient. This decision occurs before record close or any asynchronous boundary. The conditional route closes the same accepted records, settles `emit_result` successfully, retains the real accepted result for transition context, and leaves queue selection/removal to recipient entry. Notifications admitted during that record close remain queued for recipient entry. After a no-pending result claim, enqueue is denied. Other terminal edges synchronously claim before record close, accepted tool settlement, cleanup, and later supervisor-owned publication through the exact activation owner.
Intermediate edges retain the same close/settle/node-local cleanup ordering.

Reviewer stale rejection discards the stale open review, captures one new exact descendant context and semantic snapshot pair, appends that exact refreshed context, replaces the comparison snapshot, and continues the same node.
A later semantic change may reject again; unchanged refreshed context may succeed.

Stable session IDs use the source-derived grammar in the exact block below for global-scoped and card-scoped configured agents.
One parser owns this grammar across messages, persistence, Agent APIs, chat, live sync, and web contracts.
Each deterministic configured session owns `conversations/<agent-name>/index.json` and immutable `versions/<version>-<uuid>.jsonl` segments; the global Analyst uses the corresponding `.saivage/agents/conversations/<agent-name>/` namespace.
First publication creates an index even while it is empty for every distinct node agent in the published card's compiled workflow. Successful initial runtime publication also creates the selected global Analyst index after publishing the project card. Later startup strictly consumes those exact indexes for reached active cards and the selected Analyst without enumerating session/version directories or creating replacements. An interrupted initial runtime publication can therefore leave strict incomplete state requiring the authorized reset remedy. Oversight is different: its selected global index is initialized lazily only when an actual check first uses it. Direct known tombstoned-card sessions remain readable.
Conversation indexes, ordinary and compacted genesis rows, and `conversation-segment` envelopes use strict format version 2. Segment-version numbers remain sequential conversation generations, not format numbers. Format 1 and mixed shapes are rejected; the generic append-only `rows` envelope used by card, record, and log owners remains version 1.

### Exact conversation-session identity contract

<!-- saivage:value-contract:session-identity:start -->
```text
identity.conversation-session = {"agentParser":"agentNameSchema","captures":[{"index":1,"meaning":"agentName"},{"index":2,"meaning":"cardId"}],"constructors":[{"name":"globalAgentSessionId","template":"`agent:${agentName}:global`"},{"name":"cardAgentSessionId","template":"`agent:${agentName}:${cardId}`"}],"grouping":"match !== null && agentNameSchema.safeParse(match[1]).success && (match[2] === 'global' || cardIdSchema.safeParse(match[2]).success)","identityParser":"conversationSessionIdentity","inputGuard":"string","nullTest":"match !== null","operators":["&&","!==","||","==="],"pattern":{"anchored":true,"flags":"u","source":"^agent:([a-z][a-z0-9-]{0,63}):(.+)$"},"scopeAlternatives":["global","cardIdSchema"]}
```
<!-- saivage:value-contract:session-identity:end -->

The Analyst runtime owns at most one lazily created actor and accepts no caller-selected session identity.
`GET /api/chat` returns only the configured global Analyst `session_id` and is the sole REST chat identity response.
`POST /api/chat` accepts exactly a strict object with required non-empty `content` and optional strict workspace context; success returns only tool-invocation and restart results, with no session identity field. REST `content` is additionally capped by schema at `1_048_576` UTF-16 code units (JavaScript `string.length`).
The first synchronous `AnalystSession.submit()` admission wins across REST and every WebSocket.
An overlap is rejected immediately, never queued: REST maps the typed busy error to HTTP 409 while WebSocket uses the corresponding strict discriminated error member; the exact shared variant is documented in [Section 11](#exact-shared-operator-error-contracts).
Failed, disposed, closed-admission, canonical-state, provider, persistence, invariant, and publication-uncertain failures are not busy.
WebSocket connection and successful turn acknowledgement and final Analyst tool activities carry the configured identity; a busy loser emits no acknowledgement or activity.
Generic Agent detail, conversation, and LLM-exchange parameters use the full shared session grammar.
Invalid raw frames are rejected before subscription mutation or acknowledgement, and malformed Vue Agent route input mounts no detail, REST, or live-sync work.
The single WebSocket transport caps the entire reassembled inbound message at 1 MiB (`1_048_576` bytes); an oversized message closes with code 1009 before JSON parsing, schema validation, or Analyst handler work. Inbound Analyst `text` is additionally capped by schema at `1_048_576` UTF-16 code units (JavaScript `string.length`). The transport limit is authoritative for multibyte content, and its nominal 1 MiB ceiling is aligned with the explicit global REST body limit.

Agent summaries require `id`, `agent_name`, `session_scope`, `card_id`, `started_at`, required nullable `compaction`, and exactly one valid liveness pair: `status:'active'` with `activity:'busy'`, or `status:'inactive'` with `activity:'idle'`. `compaction` is null unless that exact executing session owns current ephemeral progress; otherwise it is exactly `{strategy,started_at,folds_done,fold_in_flight}` with a nonnegative logical-success count.
`GET /api/agents` derives the configured global Analyst and every active linked card's distinct compiled workflow agents.
`GET /api/cards/:id/agent-sessions` derives only that active card's candidates.
Each summary-producing operation captures one request-local set of canonical session IDs from installed autonomous owners plus an already-instantiated Analyst runtime, then decorates each durable summary by exact ID membership.
Candidate admission and `started_at` remain canonical conversation-index facts: a live ID without a current conversation version synthesizes no inventory, and neither card lifecycle nor transcript history implies liveness.
Exact retained-tombstone detail remains readable and is `inactive`/`idle`.
Runtime-status payloads contain no Agent telemetry array.

Existing card/global Agent-membership freshness targets prompt authoritative rereads after process-local projection changes; the no-argument actor callback is coarse transport and does not define public transition semantics.

The conversation LLM actor separately owns nullable process-local compaction progress `{strategy,startedAt,foldsDone,foldInFlight}`. It begins at zero/false for each preventive, local-exact-admission, or authoritative-recovery compaction, including zero-call structural work. `foldInFlight` becomes true only after a fold is admitted immediately before logical invocation; validated success increments `foldsDone` and clears it, while a known failed logical fold clears it without increment before an eligible correction. Transient provider attempts do not increment the count. Ordinary completion, failure, cancellation, or disposal clears only current ownership. Publication-outcome uncertainty is delivered to the fatal owner first and permits no progress clear or later notification.
Successful Supervisor halt first validates and clears the frozen authoritative owner graph and retains runtime invalidation, then emits one existing card-membership target for every removed owner while their absence is observable.
A failed halt retains its owner graph and emits no successful-removal freshness.

One canonical durable conversation state machine owns exact session and message identity, source classification, tool call/result settlement and ordering, source rounds/segments, provider bundles, compaction coverage/hashes/static IDs, and the zero-or-one final-source unmatched-call rule.
Its in-memory adapter returns immutable `ValidatedConversation` physical/source rows and derived durable facts.
Append admission, `readConversation`, complete Agent transcripts, bounded `read_agent_session`, compaction source selection, ordinary provider source selection, card Run recovery, and exact selected card-session activation settlement consume this grammar or its facts.
`GET /api/agents/:id/conversation` returns exactly `{session_id,segment_version,segment_context,entries,cursor:{segment_version,message_id}}` only after complete exact validation. Selected conversation history returns exactly `{session_id,version,entry_id,published_at,segment_context,entries}`. An ordinary format-2 segment has `segment_context:null`; each compacted version has a strict separately projected context.
Optional `since` is an opaque equality token.
An absent token alone is `400`; later outward rows are selected only after complete validation, and the cursor advances over filtered provider-private rows.
A sole final unmatched call has no active, waiting, pending, or snapshot meaning. When a later ordinary card workflow selects that exact configured session for imminent activation, the consuming `AgentNodeExecution` may pair it with one permanent synthetic failed result stating that external or domain effects may or may not have happened. The result preserves the old source input, call, tool, and persisted result-policy template bytes/hash, carries `outcome_unknown:true` and evidence `none`, and is appended immediately before the fresh activation marker. It neither continues nor replays the old invocation and appends no recovery notice.

Successful `GET /api/agents/:id/llm-exchange` returns exactly `{session_id,exchange}`.
`session_id` is the selected Agent-session identity, and `exchange` is the strict provider-exchange projection.

Current providers and executors return only constructor-created nominal action outcomes; they do not construct wire ToolResults.
One settlement authority validates the nominal token, outbound-projects/redacts the fields, creates the strict success/failure ToolResult, and returns that exact result together with its canonical JSON bytes.
All failed outcomes receive no evidence.
The shared LLM invocation boundary records unsupported names as `unsupported_tool` and malformed/schema-invalid or already-cancelled calls as `rejected_before_execution` without executor entry. A typed argument-validation or response-packing failure thrown after executor entry is instead an executed failed result with no evidence. A returned execution result remains executed even if cancellation arrived meanwhile; only an entered throw identical to the signal's exact cancellation reason becomes synthetic `execution_failed`. Publication uncertainty, missing MCP installation, unrelated I/O, canonical corruption, and every other unclassified rejection propagate unchanged.
Successful `list_agent_sessions` and `list_processes_tool` data contain byte-packed `sessions` and `processes` pages. Successful `read_runtime_events` and `read_runtime_errors` data contain byte-packed `events` and `errors` pages whose page total is the selected newest tail and whose separate `total_lines` is the full matching retained line count. `read_agent_session` selects one byte-packed section: omitted or `section:'messages'` returns `{session,ownership,segment_version,section:'messages',has_segment_context,total_visible_entries,messages}`, where `messages.total` is the selected last-N tail count; `section:'context'` returns the same metadata with `section:'context'` and a zero-or-one-item `context` page containing the complete current projected segment-context object, using ordinary JSON slices when necessary. Context accepts no `last_n`. All pages are fresh stateless observations, redact before packing, and measure the complete settled success envelope against `response_bytes`.
A failure is the one top-level `{success:false,error,data?}` ToolResult.
Persisted result `data` remains opaque unknown JSON.

Each Analyst submission starts one strict source round with an exact system/activity marker payload `{agent_name:<configured-analyst>,event:'activation_open',input_id,timestamp}` and no `card_id`.
Card-agent markers use the same exact fields plus `card_id`; both forms require the marker timestamp to equal the row timestamp and `input_id` to be a canonical UUID.
Ordinary model-backed submissions append that marker, one workspace-context system-text row, and one operator user-text row as one ordered batch; confirmed restart appends only its marker and user confirmation row.
Global-agent conversations permit no preamble.
Unmarked, malformed, wrong-agent/card, or mixed history fails strict ordinary reads rather than receiving an inferred boundary.

`AnalystSession` is a plain serial coordinator with `idle | conversing | failed | disposed` ownership.
One accepted operation owns its caller deferred, tracker, abort controller, current step, and immutable `acceptedOperationId`; its registered tracker consumer is the only caller-delivery authority.
That accepted identity marks ingress and confirmed-restart publication.
Initial, tool-continuation, and plain-text-repair provider invocations each allocate a distinct fresh source ID and carry the exact canonical input in the direct LLM phase.
Deferred startup rechecks exact operation authority before ingress and nested admission.
Only positively identified pure pre-effect preparation rejection restores reusable admission; persistence, observer, cleanup, invariant, outcome-unknown, and unclassified rejection poison the session.
There is no Analyst-turn cancellation authority, backend method or callback, response flag, transcript notice, fabricated tool result, or hidden generic terminal/cancellation winner.
Transport-local WebSocket queues do not exist, and closing a socket does not cancel an accepted global turn.
Application teardown instead closes admission, cancels and settles an accepted Analyst operation that owns an initial or continuation provider handoff, and joins owned completion before final Conversation LLM disposal. Every returned tool call is matched without executor entry or model continuation before the submission rejects with the exact disposal reason.
If disposal re-enters after ordinary ingress publication has entered, the writer finishes exactly the one three-row activation/workspace/user batch; the submission then rejects with the exact disposal reason before conversation reread or provider admission, and the outer tracker and Conversation LLM join successfully.

Server composition derives one immutable discriminated restart capability from the selected authentication policy and boot-owned restart port.
Authenticated composition without that port fails; disabled authentication produces only `{available:false}`.
That exact capability reaches runtime status, the Analyst tool/session, REST routes, and WebSocket acknowledgement.
The sole public status projector maps its discriminator to `restart_server_available`; no downstream consumer re-derives availability from authentication or combines a boolean with an optional port.

Restart confirmation is one move-only in-memory capability.
Admission transfers it from idle to the accepted operation, reusable non-scheduling settlement restores it before delivery and returns `confirmation_required`, and only successful `RestartPort.schedule()` consumes it.
Exact `RESTART SERVER` first publishes the accepted-operation activation and user rows in one two-row batch, rechecks authority after the whole writer/observer boundary, and then enters scheduling.
If application disposal re-enters after that publication starts but before the writer returns, the two-row batch remains the sole second-submission effect, the submission rejects with the exact disposal reason, and scheduling is suppressed.
If disposal instead re-enters synchronously from an already-entered `RestartPort.schedule()`, schedule entry wins: the port is called once, the confirmation is consumed, and the submission returns `scheduled`; disposal still closes later admission.
Neither outcome appends fallback or cancellation rows, duplicates publication or scheduling, or implies process restart acknowledgement.

Conversation tool settlement has only caller-supplied result settlement, optional ordinary continuation, and direct owner disposal.
If disposal re-enters after an ordinary tool-result writer starts, that writer appends exactly one `tool_result` row with ID `<sourceInputId>:tool-result:<toolCallId>`, role `tool`, the original tool name and call ID, and content equal to the JSON encoding of the caller-supplied result.
The result settlement and outer Analyst submission then reject with the exact disposal reason, while internal settlement, the outer tracker, and Conversation LLM joins succeed; later admission is closed and no continuation context, conversation reread for continuation, nested provider call, fabricated failure, or cancellation text is admitted.
Successful `restart_server` settlement without continuation has the same entered-writer ownership and a distinct public outcome: its one row has that exact identity/shape and the caller-supplied successful `restart_server` result, the no-continuation settlement and outer submission reject with the exact disposal reason, internal settlement and joins succeed, later admission is closed, and no restart confirmation is installed.
In both cases Analyst application cleanup succeeds when its process-containment branches succeed.
When cancellation suppresses a terminal handoff during terminal-error publication, the persisted terminal error and provider-exchange facts remain authoritative, no Analyst notice is appended, and the outer operation consumes the returned terminal outcome before rejecting with the exact disposal reason. When synchronous terminal handoff actually entered first, its existing terminal completion/notice policy remains authoritative. Neither path reads history or fabricates a tool settlement.

The references above to caller-supplied results describe the existing entered-writer lifecycle only; the current caller supplies a nominal action settlement, not a wire envelope.
The append owner writes the settlement authority's exact canonical bytes and returns the same settled ToolResult and bytes through the LLM actor.
Analyst stores that returned result only after durable append and passes it unchanged to immediate REST and WebSocket activity, while those live projections outbound-project arguments only.
Successful restart no-continuation settlement likewise returns the authority-created facts before confirmation handling.

Every bounded tool response is admitted against canonical bytes of the final post-outbound settled ToolResult, not an inner pre-redaction payload estimate.
Current and immutable card summaries use one shared summary projector and therefore apply the same truncation and byte-fit decisions. Neither surface has a notification section.

Provider completion owns canonical conversation publication and all writer observers, mandatory provider-exchange evidence publication, synchronous enclosing-owner handoff carrying the exact terminal input, and only then direct promise delivery.
Analyst handoff installs outer settlement before promise callbacks: message completion needs no second row, while provider/model issue preserves `${terminalSource}:error` and evidence before the Analyst writes required `${terminalSource}:message`.
Disposal cannot replace entered completion or evidence, an already-entered synchronous handoff, its required notice, or their exact failure; cancellation that becomes owned during terminal publication suppresses only the not-yet-entered handoff as specified above.
Canonical writer failure authorizes no read, retry, fallback, compensation, or second append.
Direct LLM disposal/join retains the complete frozen tool context and concrete `ChildInvocationLease`, and shutdown starts all exact joins before propagating a stable failure.
Card result claim still pairs the existing `CardActivationOwner` winner with direct `continuation_closed` before record publication, so Stop joins the no-continuation settlement without adding another owner.

Every autonomous, Analyst, repair, continuation, and refine-summary invocation receives a fresh opaque UUID source input generated by its owner.
That per-call input identity and the invocation owner's session identity are distinct from the stable source-session identity carried by the validated provider conversation projection.
Ordinary persisted actor turns require the invocation and source-session identities to be equal.
For original source UUID `S` and provider tool-call ID `T`, settlement identities are `${S}:tool-call:${T}` and `${S}:tool-result:${T}`.
Success and failure both use `tool_result`; the next invocation UUID is unrelated.
Attempt index orders transport attempts only within one invocation.

Live sync has independent acknowledged leases for global Agents, one card's Agent sessions, one conversation, and one LLM exchange.
Conversation invalidations carry the exact current `segment_version` plus nullable final operator-visible message ID; higher segment versions supersede lower pending hints and equal versions keep the later committed tip.
Message IDs have no ordering authority.
Reconnect creates fresh lease generations and authoritative REST reloads.

## 4. Full-Chain Stopped Recovery

Recovery from a dirty shutdown—a process error, kill, crash, or host failure—guarantees exactly one outcome: the reconstructed runtime is internally structurally consistent and runnable.
Semantic completeness is explicitly best-effort and is not guaranteed.
For example, the recovered state may legitimately be stale (a child completed but its parent still reflects waiting), redundant (a done card is reactivated because its completion trace was lost or its parent was not yet updated), or lossy (an invocation whose evidence never reached disk is indistinguishable from one that never happened); a duplicate activation is harmless and a missed activation is recovered by ordinary runtime flow and the named agents.
The system avoids these situations but does not hard-guarantee against them.

Startup first reads the canonical linked-card projection exactly once and requires a nonempty project-rooted authority.
Traversal admits only active cards through workflow and parent/type admission: a reached retained tombstone terminates startup traversal before workflow lookup, record validation, conversation initialization, or conversation truncation for that card, and its descendants are not read.
It validates active dependency existence/cycles and checks each non-root active type against its reached active parent's compiled admission.
It then strictly reads the exact selected global Analyst conversation index and every distinct node-agent index derived from each admitted card's compiled workflow. Valid empty indexes are sufficient; startup creates none of these required indexes. Only after all required indexes are admitted does startup initialize the app log, run the exact conversation-tail owners, require each declared bootstrap record stream, and strictly validate each present record stream; an optional record stream is validated only when present and startup never creates one.
The selected global Analyst index is required even before its first segment or operator message. The selected Oversight index is not included: actual check use retains its owner-local lazy initialization. These operations complete before Fastify transport services, MCP reconciliation, runtime start, or listening.
Valid settled, final-assistant-text, and other text-ended history remains byte-identical; no text position proves interruption.
A canonically valid sole final unmatched call is non-continuable by a fresh Analyst owner and fails startup with bytes unchanged.
Complete malformed or invalid history also fails unchanged.
Only the startup conversation owner may truncate bytes after the final newline when the retained nonempty complete prefix fully validates against its current index/session; startup appends no failed result, notice, or other Analyst correction.
On explicit Run without a live owner, the supervisor follows only canonical committed links from project through the sole running child at each level.
A fork, malformed link, or discontinuous chain fails before mutation.
It installs no actors or structural waits before reset.

Explicit Run traverses all canonical linked membership and proves that every linked `running` card belongs to one unique project-rooted chain; missing links, malformed parent identity, branching, and a running card below a non-running ancestor fail before recovery writes.
Every selected card is then processed as one leaf-to-root unit.
Its configured planning-cycle nodes stabilize in graph order—by default the plan node's configured agent, then the review node's—while single-node types stabilize that node's configured executor; immediately after all of that card's sessions stabilize, that same card is published stopped before recovery advances to its ancestor.
Planner/Reviewer/Executor are the default named agents, not runtime roles.
This explicit Supervisor Run path is the only broad conversation corrective-recovery owner and accepts only card-scoped sessions; it consumes canonical `ValidatedConversation` call facts before applying its card policy. Separately, the exact consuming card-session activation owner may settle only the sole strict-valid final unmatched call of the configured session selected for imminent actual use. That bounded operation performs no chain selection, state classification, notice append, old continuation, or session scan.
Recovery makes an explicit local visibility decision for every current message kind before classification and rejects an unsupported runtime kind before filtering or state derivation.
`activity` and `provider_private` are ignored when deriving implicit state; every other current kind is recovery-visible.
For an OpenAI Responses bundle, the marked visible projection alone controls text, tool, and terminal state, while the private row remains persisted for provider replay.
Empty, system-prompt-only, settled-terminal, and exact settled-recovery sessions are read-only.
Tool-pending sessions receive the ordinary interrupted `outcome_unknown:true` failed tool result and then a recovery notice; provider/text-pending sessions receive only the notice.
Multiple or nonfinal unmatched calls and malformed canonical data fail directly at activation use, before its activation marker or provider request. Lifecycle admission is unchanged. Settlement publication uncertainty, or uncertainty while publishing the following activation, is fatal and authorizes no read, retry, second result, context append, provider request, cleanup, or reconciliation.
An unfinished `activate_card` is always ordinary interruption: a running child is independently in the reset set, while a terminal or other non-running child is unchanged.
No child result is read, formatted, reconstructed, or replayed.
Global Analyst startup and ordinary reads never enter this recovery path.

Every non-clean classification strictly validates the latest `activation_open` marker's role, card, session, and `input_id`.
The recovery notice uses `${inputId}:model-recovered` and `deterministicRoundId('pre', inputId)` and counts as settled only when that exact notice is the final canonical source row after the marker.
A malformed association, collision, or older notice followed by newer same-activation work fails rather than reusing the deterministic ID.
A fresh STOPPED activation has a fresh marker and can later receive its own distinct notice.

After all configured sessions for one selected card stabilize, `stopRunning` immediately publishes that card `stopped`, regardless of whether stabilization appended `model_recovered` or recognized an exact final existing notice as read-only clean conversation state.
The notice never waives lifecycle settlement.
The source must be running. Full-Run recovery and exact joined live-descendant interruption share this singular domain operation and its sole durable reason `recovery stopped lifecycle`; other literals are invalid and are not normalized. Run recovery remains the only conversation-corrective orchestration owner, while interruption does not invoke recovery; exact selected-session settlement at later activation use is owner-local and is not orchestration.
The first stabilization or publication error ends that attempt with no later effect, read, retry, rollback, or reconciliation.
Stopped descendants below the remaining unique running ancestor prefix are a valid committed prefix, and a later Run derives that remaining prefix from canonical state.
If all cards are already stopped, Run directly selects project `STOPPED`.

After full reset, `activateStopped` changes only project from stopped to running after the supervisor has installed its prepared owner; launch starts the configured STOPPED entry.
Descendants remain stopped until their exact live parent delegates ordinary activation.
Generic mutation cannot perform running-to-stopped or stopped-to-running.
There is no transaction, recovery generation, graph cursor, old-node inference, or atomicity guarantee.

## 5. Notifications And Reviewer Arbitration

The durable notification target is one `card_id`, and `queue_notification` is the only public agent-facing notification tool. It requires `card_id`, `kind`, `body`, and exact lowercase `urgency:'normal'|'urgent'`; roles and session IDs are not targets and urgency is not stored in `CardNotification`. The card type's configured designated recipient receives context through its card-scoped session regardless of which agent runs the current node.

The exact denial outcomes are missing `{queued:false,reason:'missing_card',card_id}`, persisted terminal `{queued:false,reason:'terminal_card',card_id,status:'done'|'failed'|'cancelled'}`, closed current activation `{queued:false,reason:'activation_closed',card_id}`, and planning-ineligible `{queued:false,reason:'planning_ineligible',card_id}`. Confirmed success is `{queued:true,card_id,notification_id,body,interruption}`; `body` is the submitting call's own outbound-redacted text, not a queue read. Interruption is `not_requested`, `not_applicable`, `interrupted` with exact `stopped_card_ids`, or `suppressed` for cancellation/runtime ineligibility/stale ownership with exact completed-prefix `stopped_card_ids`. The closed result carries no status or result/cancel winner discriminator because durable status may still be running. Saivage neither retries nor redirects that invocation. Analyst readiness denial is one expected failed tool result plus one denied control-action audit row and performs no queue write.

Successful queueing acknowledges durable enqueue, not delivery. Only a node run by the designated recipient uses the append-before-remove delivery path at entry, ordinary tool continuation, applicable plain-text correction, and same-node `emit_result` arbitration. Recipient entry appends selected bodies before exact selected-ID removal. At an otherwise accepted recipient terminal candidate, a non-empty ordered pending set defeats the candidate without claim: append the paired failed result with reason `pending_notifications`, append exactly those bodies in order, append the resolved correction and reconsider instruction, then remove exactly the selected IDs only after all appends succeed. Append failure removes nothing; a crash after append and before removal may duplicate visible context.

Urgent submission captures the target's exact recipient-node owner, current child wait lease, and installed active descendant chain before enqueue. After enqueue it synchronously revalidates that same ownership and, only while runtime status is exactly running, admits and claims the complete descendant suffix in one transition; any result, interruption, or unresolved-admission conflict denies before any ancestor changes. It closes continuation, cancels and joins each owned provider/tool/process scope deepest-first, settles every already-persisted tool call exactly once with its known result (or rejected-before-execution result), and publishes each safely joined running card stopped. Each released child lease delivers `{status:'stopped',summary}`; `activate_card` exposes this as a truthful failed tool result with `outcome:'stopped'`, never a workflow result. Stop/application halt takeover returns the enqueue receipt and completed stopped-ID prefix immediately without waiting on the halt. A retained card notification node still appends its exact matching result and cleans its surface before activation join; cancel-and-settle is installed before activation abort, and final LLM disposal/join follows node-consumer settlement. The halt alone owns complete containment and retains its frozen graph on cleanup failure. No post-takeover stop append, relationship release, lease delivery, continuation, replay, or retargeting occurs.

A nonrecipient nonterminal edge accepts without inspecting or delivering the queue. At a nonrecipient DONE edge, all ordinary acceptance gates run first; the final synchronous queue decision either claims the ordinary terminal route when empty or follows the required conditional edge while retaining accepted evidence when nonempty. The recipient handler owns later append-before-remove delivery and must traverse its configured path to a terminal. Classic project/goal routes accepted review through Planner `handle-notifications` and then review again; classic-typed architecture routes accepted system review to Executor `draft` and requires component and system review again. There is no every-later-arrival guarantee: configured BLOCKED/FAILED, runtime refusal/failure, and cancellation may clear admitted notifications without recipient delivery. After the result or cancellation winner claim, later attempts receive `activation_closed` and create no enqueue version.

A Planner queue operation is evidenced internally by canonical pending-notification state and externally by its normal tool result; it creates no current control-action audit row. Durable queue evidence is not an ordinary operator query.

Ordinary card query surfaces provide no explicit queue collection, count, membership, IDs/bodies, availability field, direction discriminator, or delivery receipt. Generic version/time/diff/invalidation observations may signal or support inference of hidden queue activity and are not a supported queue query. Explicit enqueue attempts/results, delivered context, and opaque retained conversation evidence remain visible through their existing contracts.

Pause does not interrupt these synchronous terminal sections; continuation parks only if it later reaches the single provider-admission frontier.

## 6. Activation Outcomes And Cancellation

Planner `activate_card` admission reads the target's current declared `depends_on` list and requires every dependency's current durable card status to be exactly `done`; every other status rejects in declared dependency order.
It then admits status before child actor lookup: `running` may join its retained activation, and a non-running status is activatable only when `cardProcessEntryForStatus` selects its lifecycle entry.
A missing target retains the ordinary not-found result, while malformed canonical state or an impossible missing declared dependency fails strictly.
An empty dependency list is vacuously admitted.
These are request-time admission rules only: they do not schedule dependencies, propagate status, cancel work, or continuously enforce completion after admission.

For a dependency-rejected or non-activatable request, the reserved lease is rejected before owner or processor construction, running publication, relationship/currentness change, or execution work.
A durably running child without its exact owner is an invariant failure and is never reconstructed.

The supervisor coordinates every non-cancellation activation publication through the exact owner.
Terminal lifecycle publication still requires running source and one complete strict done, blocked, or failed target.
Processors return one final outcome only after required record/tool work and cleanup.

For a non-cancellation result, winner/settling selection precedes publication.
Publication and local joins precede one transition that removes the exact owner and relationship, restores parent currentness, and releases the lease.
Invalidation precedes deferred outcome delivery and caller continuation.

If terminal publication becomes outcome-unknown at its direct primitive, a later genuinely new process may observe either the prior version or the newly canonical terminal version.
The failing process does not retry, reread, reconcile, write again, report the terminal result, naturally release ownership, or freeze/halt the graph.
It emits the fixed stderr diagnostic and exits.
After dead-owner verification and manual lock repair, explicit Run accepts either valid durable prefix through ordinary full-chain recovery.

The installed runtime's exact live-card map is the only resolver for running cancellation.
If a target or cancellable descendant is live, the request routes to those exact actors.
A running card with missing or duplicate live ownership is impossible and fails fast; no direct write fallback exists.

The supervisor synchronously claims cancellation versus result on the exact owner suffix before outward work.
Cancellation remains a distinct publication authority, publishes deepest-first, preserves done descendants, settles once, and removes ownership only through the checked one-map transition.

Cancellation has its own status rule: every status except done and cancelled is cancellable.
This rule is separate from activation settlement, dependency completion, and descendant completion.
Planner cancellation checks immediate-child identity and delegates owner-first through the exact parent port without target/status/subtree reads.
Analyst cancellation rejects the root and preflights the complete requested subtree; any done or cancelled member rejects the entire request before cancellation, and the operation may reach the runtime port while running/pausing/paused.
Supervisor remains the lifecycle owner: it claims active suffixes, publishes deepest-first, skips and preserves noncancellable stored descendants, rejects a noncancellable requested stored target, and fails on durable running state without an owner.
Direct domain cancellation is for verified nonrunning/stopped work under lifecycle-lock and permission admission.

Analyst record mutation has a separate exhaustive `analystRecordEditEffect`: backlog, running, and stopped preserve their status; blocked, done, and failed reopen to changed; changed and cancelled reject.
The first-class Analyst `reopen_card` mutation is admitted only while intervention-ready for an existing target whose current status is exactly blocked, done, or failed.
It edits no content and delegates target-to-ancestor reopening and notification to normal changed propagation.
The card-scoped Planner `reopen_card` instead accepts `{card_id}` and delegates through the exact captured `PlannerChildControlPort`. Before target I/O, the Supervisor requires that captured parent activation to remain its active/open owner with no halt, stop, cancellation, result, settling, or application-close fence. It then requires an ownerless exact immediate child whose status is exactly done or failed. Parent, root, grandchild, other-branch, missing, blocked, changed, backlog, running, stopped, and cancelled targets reject before effects.
After complete admission, the Supervisor uses that parent owner as the sole authority for one existing `publish(parent, () => CardService.setStatus(childCardId, 'changed'))` boundary. Success returns only `{card_id,status:'changed'}` and appends exactly one child status version; it clears only the current lifecycle result, error, and completion through the existing changed effect, preserves pending notifications and all other card fields, and leaves immutable historical versions and accepted records readable. It creates no child owner, parent or ancestor version, changed propagation, notification, dispatch, control-action audit, record rewrite, retry, or automatic activation. A repeated call sees changed and rejects without another append; a later genuinely new done or failed completion may be reopened again.
Expected admission denials are ordinary tool failures and do not initiate a runtime halt. Publication outcome unknown follows the existing immediate fatal boundary and is never converted to an operational result. Any other publication failure begins the existing `publication_failure` halt and the Planner receives the retained stopped interruption rather than success or a recoverable tool failure; a halt raised during publication behaves the same. No path rereads the outcome, retries, compensates, cleans up, or fabricates history.
Immediate-child Planner `edit_card` is independent: an effective backlog/changed/stopped delta edits in place; an effective blocked/failed delta publishes changed then metadata; running/done/cancelled reject; and an empty effective patch publishes nothing and never reopens.

## 7. Run, Pause, Resume, Stop, And Restart

Runtime lifecycle is process-local and is held in one Supervisor status field.
It begins at internal `uninitialized`; successful Supervisor startup strictly reads and validates the project root, establishes the initial empty ownership/gate state, and only then publishes `stopped`.
A failed startup attempt leaves the field `uninitialized`, public status reads fail fast, and Analyst intervention rejects.
`uninitialized` is not a public runtime-status or response value.
After startup, the field contains exactly `stopped | starting | running | pausing | paused | closing | error`: only `stopped` and settled `paused` admit Analyst intervention, while every other status rejects.
This process-local mutation-admission rule is distinct from the public server readiness probe at `GET /health/ready`.

The supervisor owns the complete Run sequence.
Preparation completely validates the linked running set as one project-rooted chain, installs the project owner, run identity, current root, and opaque one-shot launch authority as `starting`, then handles each selected card leaf-to-root by stabilizing all of its configured sessions and immediately publishing that card stopped.
Only after the full reset does it activate project through STOPPED.
Launch consumes that exact authority, rechecks owner and application admissibility, publishes `running`, opens the gate, and activates configured-node execution; only then may Run return the same authoritative runtime-state projection as `/api/state`.
A preparation or launch failure returns no successful Run result and never manufactures a second launch authority.

The non-null runtime state is built on demand and contains exactly the public projection of Supervisor status, fixed project identity, lifecycle-lock PID/start time, `current_card_id`, and the read observation `updated_at`.
The lifecycle identity is injected from the acquired lock handle and remains stable for the server process; only `updated_at` changes with observation.
The supervisor owns no runtime-state or intervention-readiness cache: it directly mutates lifecycle status and gate state for Run, Pause, Resume, and Stop, and its read-only intervention facet checks that same current status at invocation.
Pause sets one request flag.
`RuntimeGate.waitUntilOpen()` observes it at the single cooperative Pause frontier immediately before provider transport.
Pause does not interrupt already-admitted external, tool, or process work; that work may finish, and its continuation parks only when it reaches the next provider admission.
At most one frontier parks, and Resume clears and schedules it once.
Runtime state and compact status contain neither internal `uninitialized` nor synthetic counters, tick values, active-work classifier, actor diagnostics, phase, caller, or session telemetry.

The supervisor's inline current leaf is the sole current-card authority.
Child entry publishes that child only after owner/relationship installation and successful running publication; child settlement restores the immediate parent before continuation.
Pause and closing retain currentness.
Natural root fulfillment first proves no process-local owned child remains, then before any terminal root publication invokes the complete durable selector exactly once and requires the result to be exactly `[project]`.
Missing, branching, discontinuous, empty, or additional-running-card topology rejects the outcome while root bytes, version, and `running` status remain unchanged.
Successful publication and join then clear owner/run/currentness and the old Pause callback while publishing process-local `stopped`; there is no post-publication chain reread or separate readiness value.

REST Pause, Resume, and `stop_project` are bodyless operations.
Absence is their only accepted request shape; every supplied payload, including `{}` and `null`, receives that route's local 400 validation response before runtime mutation.
`restart_server` is the only operation in this group with a request body and accepts exactly the strict JSON object `{confirmation:'RESTART SERVER'}`.

Every recovered Run starts only project through the configured STOPPED entry.
It installs no descendant owners or old ancestor waits.
Any later legitimate activation constructs a fresh plain `CardActivationOwner` and ready `CardProcessActor` rather than reusing settled process-local ownership.

`stop_project` is a non-domain, restartable project-runtime halt.
Starting/running/pausing/paused synchronously installs the single intervention-rejecting `closing` status, closes the gate, revokes prepared launch and parent admission, freezes the exact owner map, and creates one shared `RuntimeStoppedInterruption`.
Stop never initiates domain cancellation and never itself writes a card, root result, child ToolResult, provider round, or Stop-caused durable event.
Before any await, every admitted or settling child lease becomes terminally interrupted, every owner settlement rejects, and every owner is aborted and disposed.
This intentionally abandons a near-terminal result or cancellation that had not completed before the freeze; its durable publication may already exist or may be absent.
Exact authority fences prevent every late continuation from publishing, activating, or naturally releasing after freeze.

Only after synchronous settlement does the halt start every memoized processor join and one runtime-process-root termination.
Actor-main invariant failure synchronously notifies its exact current owner and starts or joins this same halt; it creates no ordinary card result and no second halt or App path.
Supervisor processor activation observes both activation rejection and either path's subsequent result-settlement rejection. A current-owner settlement-phase invariant rejection starts or joins this same singular `runtime_failure` halt and retains the original invariant error as that owner's halt and settlement failure evidence. A stale observer with a remaining live run or retained halt still starts or joins containment as applicable without attributing its obsolete error to a current owner; a stale observer finding neither run nor halt has nothing left to contain and returns without effects. Publication-outcome-unknown activation rejection retains its distinct immediate fatal boundary.
Containment failure selection is fixed structural order, independent of completion timing, while every lane is observed: CardProcess pre-join cleanup, frozen LLM joins, tracker join, lifecycle failure; then Supervisor synchronous owner/action containment, frozen processor joins, process-root termination, and final halt-state transition.
The first failing slot wins without wrapping, so a cleanup error may be retained even though the exact actor error was logged and rejected locally.
Complete success verifies the identical frozen graph, completes the gate, clears ownership/run/currentness, publishes `stopped`, and maps every joining Stop to `{status:'stopped',contained:true}`; the status-derived facet then admits intervention.
Any interruption/join/termination or actor-main failure retains the halt and graph, publishes `error`, and rejects both intervention and every later Stop with the same settled failure; Run/Pause/Resume remain unavailable and service restart is required.
With no live run or halt Stop returns `{status:'stopped',contained:false}`.
A later Run after successful halt resets any canonical running chain and activates project through STOPPED.
Outcome-unknown publication remains the distinct policy specified above.

The App terminal coordinator is separate and deliberately best effort.
`App.stop()`, SIGINT/SIGTERM, startup failure, and acknowledged authenticated `restart_server` converge on the sole coordinator in `src/boot/app.ts`; no entry or cleanup leaf calls `stopProject` or cancellation.
Its runtime admission closer permanently closes application admission and synchronously starts or joins the same supervisor halt before the coordinator's first await; the runtime cleanup leaf awaits that exact operation.
It individually catches every closer, then attempts cleanup leaves sequentially in reverse registration order, continuing after rejection or timeout.
Exactly one `runtime`, one `analyst`, and one `mcp` component leaf coexist with independent LiveSync, Fastify, subscription, and lifecycle-lock leaves.

Server composition creates the one shared process registry, allocates exact disjoint runtime, Analyst, and MCP root scopes beneath its registry root, and creates the one shared runner before composing component mechanics.
The registry alone owns group/scope truth and exact scope/category authorization.
The runner owns no component roots; its declared public API exposes no registry/root object reference or undeclared broad access and intentionally exposes only narrow registry-mediated launch, lifecycle, and scope operations.
Exact scope/category admission constrains supported ordinary calls and is not containment of the trusted root-capable agent.
Each exact root is injected only into its owner.
Composition registers the runtime and Analyst terminal callbacks, constructs and registers MCP, reconciles the exact startup-selected persisted MCP configuration to convergence, and installs that manager exactly once behind the required narrow invocation port before starting runtime mechanics.
Rejected or non-converged MCP reconciliation does not install MCP or start runtime; runtime-start failure after installation and all earlier startup failures use the same App terminal coordinator and registered reverse-order component cleanup, without retry or desired-config rollback.

Application shutdown cleanup terminates and joins current component-owned work without becoming card recovery or graph-position authority.

Executor nodes, Analyst sessions, and MCP revisions allocate one exact direct scope under their injected component root.
Their lifecycle uses exact direct close-and-contain, not close followed by tree selection.
Closing an empty direct scope retires it synchronously.
Closing a nonempty scope blocks new launch and retains it only until the last exact member has positive absence.
The first positive absence validates the captured group and exact direct membership, marks that record confirmed, removes both entries, retires an empty closed direct scope, calls its absence effect once, and resolves settlement once.
A concurrent observer of that same captured record may report absence only when the record is already confirmed and no current group or conflicting membership exists; a reused ID, conflicting membership, or unconfirmed missing record fails.
Unverifiable groups and their closed scopes remain retained.
There is no scope/group scan, tombstone, historical-ID set, retry, or repair path.

Process presentation has one finite owner-visible lifetime: launch, live or unconsumed result, final owner consumption, then retirement. Foreground `run_command`, terminal `wait_process`, and confirmed `kill_process` copy the terminal record and form their result before retiring it; terminal capture failure is likewise consumed and then reported unchanged. `wait:false`, a running `timeout_ms:0` inspection, and a timed-out running wait do not retire the presentation: that outstanding result remains available for a later wait or kill. Closing the exact direct scope is the final consumer for all residual terminal presentations and joins every eligible settlement even when another rejects, retires eligible entries, and then propagates the first settlement rejection. A failed or unconfirmed group remains present.

Stdio MCP consumes each launch's terminal record or capture error in its terminal observer, retains the corresponding stopped/error MCP projection, clears the live handle and caches, and retires that launch without waiting for revision-scope teardown. Process lists are current-lifetime snapshots, not execution history; after final consumption the process ID is unknown to wait/kill and absent from lists. This claims no fixed bound on deliberately outstanding background jobs. Previously returned canonical `work:///` output URLs remain independently readable subject to ordinary Files admission and file availability; presentation retirement neither deletes output nor promises durable retention.

Each process-owning component leaf closes admission/revokes callbacks and starts exact root termination before any await, then awaits it with its actor/session/operation joins.
A fulfilled `ProcessStopReport` is successful only when `failed` is empty.
Runtime project Stop and App runtime cleanup share the supervisor halt's one runtime-root termination rather than overlapping it.
MCP retains its unrelated direct containment mechanics.
Analyst application cleanup synchronously starts its retained session's exact direct containment, then exact Analyst-root containment, then joins the session; root rejection has precedence, otherwise any failed root report or rejected direct/session settlement fails Analyst cleanup.
A timed-out component may continue only in its root while later disjoint-root leaves run.

MCP manager admission closure is the manager-level invocation fence.
Its synchronous prefix rejects every later manager invocation before runtime or transport delegation, closes every retained MCP runtime, and starts or retrieves each runtime's one exact direct-containment promise during the App admission phase before cleanup leaves.
MCP cleanup reuses those same runtime-owned settlements, starts exact MCP-root containment only after obtaining them, and joins all retained runtime containments, root containment, and current reconciliation.
A rejected root containment is rethrown unchanged; otherwise a failed root report or any rejected direct/reconciliation settlement fails MCP cleanup.
The runtime collection clears only after complete success.

### Command environment

The shared positive-allowlist command environment inherits exactly `PATH`, `HOME`, `USER`, `LANG`, `TERM`, every `LC_*` locale name, and the four optional Git identity names `GIT_AUTHOR_NAME`, `GIT_AUTHOR_EMAIL`, `GIT_COMMITTER_NAME`, and `GIT_COMMITTER_EMAIL` from the Saivage process. Supplied values pass through verbatim, including empty strings; absent names remain absent. Saivage supplies no Git identity, performs no identity precheck, and leaves validation to Git at use. Every other inherited name is excluded, including undeclared Saivage, provider, and deployment variables, arbitrary unknown names, `GIT_CONFIG` and related configuration overrides, `GIT_SSH`, and `GIT_SSH_COMMAND`; there is no `GIT_*` prefix admission.

Ordinary `run_command` children start from that shared environment, then receive the runner's explicit project locators and any explicit per-command environment overlay. Stdio MCP children also start from the same shared environment, followed by that server entry's exact configured `env` overlay. Explicit configured overlays are distinct from inherited environment policy, are not filtered by secret-like key names, and win on duplicate names.
Streamable HTTP MCP does not launch a child process.

The parsed configuration is the sole MCP server-entry authority.
Every strict `stdio` entry requires a nonempty `command`, may contain only `args`, `env`, `disabled`, and `autostart` in addition to its discriminator, and remains fully validated when disabled.
Every strict `streamable-http` entry requires one absolute `http:` or `https:` URL and may contain only `disabled` and `autostart` in addition to its discriminator.
Missing transport fields, cross-transport fields, unknown fields, relative or malformed URLs, and non-HTTP(S) protocols fail configuration validation before MCP lifecycle or transport work.

`run_command` executes its command as one argument to `bash -c`.
`timeout_ms` is its sole wait timeout; there is no inactivity-timeout input.
Every successful `run_command`, `wait_process`, and `kill_process` has data exactly `{process_id,exit_code,status,stdout,stderr,stdout_complete,stderr_complete,stdout_url,stderr_url,stdout_bytes,stderr_bytes}`. `process_id` is exactly `proc-` plus twelve lowercase hexadecimal digits. Each URL is a canonical query/fragment-free `work:///processes/<process_id>/{stdout,stderr}.log` or `work:///cards/<card-id>/processes/<process_id>/{stdout,stderr}.log`; card IDs satisfy the current card grammar, the decoded process segment equals `process_id`, and both URLs name the same card/non-card directory. `stdout_bytes` and `stderr_bytes` count the exact raw captured buffers.

Each stream is read once as one buffer. Streaming UTF-8 decoding preserves an initial BOM, omits an incomplete final code point, and otherwise uses ordinary replacement decoding. Complete decoded text is redacted before selecting the largest shared-certified code-point endpoint under both 2,048 UTF-8 bytes and 30 lines; newline terminates a line, a nonempty final segment is a line, the thirtieth newline is included, and CR in CRLF remains text. The two heads and flags are independent. A flag is true only when no raw suffix was buffered and the emitted prefix is the complete redacted decoded capture; redaction itself does not make a complete capture partial.

`validateProcessToolResult()` in `src/tools/process-tool-result.ts` is the singular producer/current-primary semantic acceptance owner. It strictly parses the data, requires both heads to be already stable complete outbound projections, and measures exactly one `settledSuccessBytes(data)` canonical successful provider envelope with both URLs; that complete pre-omission envelope must not exceed 32,768 UTF-8 bytes and its settled data must canonically equal the accepted data. A canonical identity or URL that makes fixed metadata too large fails rather than being shortened. This measurement is not a byte claim about the originally retained row serialization: exact source hashes still commit that original content, while harmless key order, escaping, and whitespace differences remain acceptable when current semantics pass.
A terminal result is consumed after result formation and its ID leaves current process observation; background and timed-out running results remain outstanding for later consumption or scope closure.
A missing or empty cwd and canonical `project:///` select the project root; plain cwd values are project-relative and contained; `project:///...` selects a contained project descendant; and `system:///` or `system:///...` selects the system root or descendant.
Malformed scoped URLs, query/fragment cwd values, unknown scoped schemes, and the `record`, `tmp`, and `work` schemes fail before launch.
The one shared card/global tool definition states the conditional scratch contract independently of the selected agent prompt: card-scoped invocations receive `SAIVAGE_CARD_WORK_ROOT` equal to the exact `.saivage/work/cards/<cardId>` root and must put disposable copies, extraction areas, caches, and intermediate command work in purpose-named children there, while ordinary source edits, builds, and tests remain in the project workspace; `processes/` and `tmp/` beneath that root are reserved, and project-root `.card-*-work` siblings must not be invented.
Global/non-card invocations do not receive `SAIVAGE_CARD_WORK_ROOT` and must not use it.
Supported agent-prompt replacement does not replace configured tool definitions.
This command environment locator does not grant workspace-tool writes into `.saivage` and does not change `tmp:///` or `work:///` behavior.
The managed-process registry consumes child `error` events immediately from spawn return, so a handled OS launch failure cannot independently crash the runtime, and it never registers a process group without a positive leader PID.
Raw output-readable `error` events and ordinary output append-open failures are recorded by the launch's capture owner rather than thrown from stream handlers. After registry-confirmed absence and both readable drains, they force the final presentation to `failed` while retaining any known leader exit code/signal, and the original error reaches terminal-settlement awaiters including command tools and the stdio MCP observer.

Workspace `read.read_mode` supports only `auto` and `text`; it controls the workspace tool's scoped text reads and is not the web fetch option.
Separately, `webfetch.read_mode` also supports only `auto` and `text`.
Ordinary web content fetches retain the 500,000-byte default and 1,000,000-byte hard `max_bytes` ceiling, existing text inference, binary metadata, and save behavior. Every path except a successful no-save text response fails immediately with the existing max-bytes error when a delivered byte beyond the ceiling is observed, before HTTP status or body classification can supersede it. A successful no-save text response instead retains at most the raw ceiling and sets `fetch_truncated:true` only after positively reading an additional body byte; equality, `Content-Length`, decoding, redaction, or head omission never imply fetch truncation.
`metadata_only` performs the same guarded GET, redirect validation, final-status, final-URL, and selected-header handling but never acquires or reads a response-body reader; it awaits cancellation of every discarded redirect body and the final body before returning metadata.
Every invocation URL removes userinfo, query values, and fragments through the typed URL projector.
Every successful metadata-only, binary, no-save text, save, redirect-final, and Analyst brief-write result contains only `redacted_url`, never a raw `url`; durable call rows follow that same redaction.

A successful no-save text result has exactly `{kind:'text',redacted_url,status,headers,head,head_utf8_bytes,redacted_text_utf8_bytes,fetched_text_utf8_bytes,head_complete,fetch_truncated,content_url?}`. `fetched_text_utf8_bytes` counts the complete normalized unredacted text retained by the fetch, `redacted_text_utf8_bytes` counts that text after one complete outbound text-redaction pass, and `head_utf8_bytes` counts the returned already-redacted head. All are safe nonnegative integers; the head count equals its actual UTF-8 bytes and cannot exceed the redacted total. `head_complete` is true exactly when those two counts are equal, in which case `content_url` is forbidden; an incomplete head has a strict smaller count and requires the exact canonical `work:///tmp/stash/webfetch-<positive-decimal-timestamp>-<16-lowercase-hex>.txt` URL. That file contains the complete normalized unredacted retained text and has exactly `fetched_text_utf8_bytes`; later work reads apply ordinary outbound text defense.

Normalization uses UTF-8 replacement decoding and preserves an initial BOM. At natural EOF, malformed or incomplete terminal input produces U+FFFD. At a positively observed artificial raw ceiling, streaming decode is deliberately not flushed, so an incomplete valid code point bisected by that ceiling is omitted rather than fabricated as U+FFFD. If replacement decoding expands normalized UTF-8 beyond effective `max_bytes`, the operation fails before publication. Complete normalized text is redacted once before slicing. The redaction owner certifies final-text prefix endpoints: recognized JSON, YAML, escaped-JSON, credential-literal, bearer, assignment, and URL-query matches are indivisible, a changing final-text match lowers the maximum stable endpoint to its start, and surrogate pairs are never bisected. The complete branch additionally requires a certified full endpoint; no repeated redaction or fixed-point interpretation exists. Consequently the longest permitted head can be empty while honestly incomplete.

`max_inline_bytes` defaults to 100,000 and clamps to `1..effective max_bytes`; it limits redacted-head UTF-8 bytes and has no line-count limit. The actual head may be smaller for certification or envelope fit. The complete canonical settled success `ToolResult` is at most 1,000,000 UTF-8 bytes. Packing measures actual generic settlement, chooses the longest certified prefix fitting both limits, and fails before publication when fixed metadata cannot fit. A stash is published only for the admitted incomplete result. Status, selected headers, binary/save/write identities, generic result settlement, and opaque historical-result interpretation remain unchanged.

Filesystem write, edit, and preauthorization share one resolved write gate.
Plain, `project:///`, and `system:///` spellings are rejected when their normalized absolute destination equals the project `.saivage` directory or lies beneath it.
Only a valid lexical `tmp:///` path carries the narrow scoped-write capability into its resolver-owned `.saivage/work/cards/<cardId>/tmp` backing namespace; a project or system spelling of that same backing destination remains rejected.
Component-safe destination comparison does not block siblings such as `.saivage-other`, and existing role, scoped-path, blocked-path, secret-path, and symlink rules remain in force.

Every leaf uses the coordinator's referenced cleanup timer, above the managed-process TERM grace and post-KILL verification periods in the [exact cleanup timing contract](#exact-cleanup-timing-contract).
Fast settlement clears the timer; timeout does not cancel or retain the leaf.
`App.stop()` resolves an immutable `ShutdownReport` containing only ordered allowlisted `{component, code}` warnings, where code is `closer_failed`, `cleanup_failed`, or `cleanup_timeout`; caught messages, paths, payloads, stacks, and causes are never inspected or exposed.
It never logs or changes exit status.
Process-owning signal/restart/startup adapters log only fixed component and code fields and preserve ordinary behavior.
Public terminal access remains confirmed `restart_server` only with operator authentication; Stop remains available in both auth modes.

### Exact cleanup timing contract

<!-- saivage:value-contract:cleanup-limits:start -->
```text
constant.app-cleanup-leaf-timeout-ms = {"unit":"milliseconds","value":10000}
constant.managed-process-term-grace-ms = {"unit":"milliseconds","value":5000}
constant.managed-process-post-kill-verification-ms = {"unit":"milliseconds","value":2000}
```
<!-- saivage:value-contract:cleanup-limits:end -->

Run, Pause, Resume, and Stop produce no lifecycle-control audit entries.
Unrelated audits remain.

## 8. Lifecycle Lock And CLI

Lock observation outcomes are missing, verified live, positively verified dead, indeterminate, and malformed.
Indeterminate includes permission denial, unavailable process-start identity, and observation races.
No outcome authorizes automatic lock deletion or takeover.
After identity admission and successful acquisition of the current process-start identity, lock acquisition creates exactly `.saivage` and then `.saivage/locks` with non-recursive default directory creation.
At either level only `EEXIST` permits an exact `lstat`, and only a real directory is admitted; files, symlinks, and other objects fail.
Bound acquisition rejects a missing project identity before either directory can be created.

Initial project publication permits first publication only after direct proof that all four generated roots are absent.
Existing generated state enters initialization only through required current-format project card and bootstrap record streams.
Partial required publication and old or mixed layouts fail reset-required; no stream is probed or accepted as current.
The decision derives only exact canonical authorities and never enumerates siblings or descendants.

`saivage init` performs pre-acquisition identity selection, exclusive lifecycle-lock publication, missing-only configuration publication, effective configuration/workflow validation, and identity creation/binding before generated-state classification.
Four absent roots permit the singular initial-runtime publisher to create card authority, publish the project card and its card-scoped workflow-agent indexes, and then create the selected global Analyst index.
Existing required current-format streams enter strict startup admission.
Both paths require one nonempty canonical linked-card projection, active dependency validation, and compiled workflow/parent-type admission before the exact required selected-Analyst and admitted-card node-agent indexes are strictly read. Existing-state admission never creates a missing required index.
After that final validation succeeds, `init` reports the two outcomes independently: `Project layout initialized at <canonical root>` or `Project layout already exists at <canonical root>`, followed by `Configuration materialized from template <selected name>` or `Existing configuration preserved`. No completion line is emitted before final success.

The first identity read is non-mutating.
A known-unsuccessful exclusive open publishes no new lock; a failure after that open is outcome-unknown and may retain the lock.
After successful acquisition, ordinary failure releases the exact current lock record, whether bootstrap-unbound or bound, but does not roll back completed config, identity, or generated durable effects.
Identity therefore remains if its creation completes but lock binding fails.
Card and authored-record streams are strict and append-only; missing, malformed, unreadable, schema-invalid, or identity-mismatched complete stream state fails directly without truncation or repair.
Only the startup owner of a current conversation segment may truncate a proven unterminated suffix after validating the retained complete prefix.
If truncation completion cannot be confirmed, the outcome is fatal/unknown and authorizes no follow-up read, retry, repair, or recovery.
Publication uncertainty is fatal, may retain its target and lock, and authorizes no inspection, repair, or rollback; generated-publication failure may retain partial state.
`saivage reset` is the separate explicit stopped-service operation over the four generated roots.
`init --force` does not exist.

The CLI performs exactly one strict token-producing option parse using command-specific definitions.
`init` accepts only `--profile`; `start` accepts only `--host`, `--port`, `--config`, `--project-root`, and `--create-runtime`; controls, reset, and help accept none.
Unknown, inapplicable, positional, missing-value, and repeated singleton inputs fail before lock or write effects, including equal repetitions and mixed separated/equals spellings.
Server startup receives typed parsed inputs rather than argv.
Those same inputs select both the canonical pre-lock project root and `--create-runtime` intent and the complete environment inside terminal cleanup.
Selection is project root `--project-root` > `SAIVAGE_PROJECT_ROOT` > current working directory; config path `--config` > `SAIVAGE_CONFIG` > `<resolved-project-root>/.saivage/saivage.yaml`; host `--host` > `SAIVAGE_HOST` > selected config `server.host` > `0.0.0.0`; and port `--port` > `SAIVAGE_PORT` > selected config `server.port` > `8080`.
Each chain selects its highest-precedence raw value before validating only that selected value.
This specification is the exact owner of those four startup precedence chains; deployment procedures reference rather than redefine them.
`NODE_ENV`, `LOG_LEVEL`, and `SAIVAGE_API_TOKEN` are independent environment-only inputs.
A set-but-blank `SAIVAGE_API_TOKEN` (empty or whitespace-only) and a token with leading or trailing whitespace each fail startup with a typed environment-load error. Unset is the only authentication-disabled selector, and an accepted token is used verbatim rather than trimmed.
Startup requires the existing project identity needed for bound lock acquisition.
Only after environment validation succeeds may `--create-runtime` invoke the shared initial-runtime publisher after the classifier returns `null`; a returned existing card skips publication.
Both cases then use the same strict startup admission.
Ordinary start never bootstraps and therefore fails immediately when the linked-card projection is empty.
Server start and control-endpoint publication follow.
A configuration or pre-mutation admission failure releases the acquired lock through ordinary cleanup.
`saivage reset` likewise remains identity-bound.

`saivage restart_server` is a delegating client process.
After exact confirmation it submits the request, prints the acknowledged REST result, and returns normally.
The separate live server/service process exits with code 75 only after acknowledgement drives terminal cleanup.
Exit 75 means accepted handoff and completed shutdown; it is not evidence that a process supervisor launched a replacement or that a replacement booted successfully.

CLI status, pause, resume, stop, and restart use only a verified live record's published non-null control endpoint and auth mode.
Null fails exactly `active lifecycle owner; runtime control unavailable`; it never implies a lifecycle phase.
The shared client never reads current YAML, host/port flags, host/port environment, defaults, runtime files, or current process config to select authority.

- missing/dead status succeeds with stopped/no-current-card;
- missing/dead stop succeeds with `contained:false`;
- missing/dead pause/resume fails because no live runtime exists;
- dead additionally reports abandoned-lock manual repair;
- indeterminate/malformed fails closed;
- delegation, authentication, response, and schema failure never falls back.

Published disabled auth omits Authorization.
Published bearer requires a non-blank `SAIVAGE_API_TOKEN` and sends it only as a header; the client rejects empty and whitespace-only values before making a request.
CLI `stop` delegates to REST operation `stop_project`; there is no `stop_project` CLI alias.

The exact public registry-owned operator REST contracts are `GET /health` and `GET /health/ready`, and the complete registry uses only `GET | POST`.
The public built web SPA, documentation site, and their static assets are HTTP resources outside that registry and its operator-session admission.
`GET /docs` redirects exactly once with status 302 and `Location: /docs/`; `GET /docs/` serves the built documentation landing page.
When the documentation build is absent, documentation paths return 404 rather than web SPA content.
Once the server is booted, readiness unconditionally returns 200 `{status:'ready',serverAvailability}`.
Readiness, runtime get-state, and the shared runtime status/Pause/Resume success response require concrete `serverAvailability`; omission is a response-contract failure.
Runtime-status observation failure produces the degraded member of the [exact availability vocabulary](#exact-availability-vocabulary) rather than an unavailable server.
The complete state and component-source lists are declaration-level contracts in that block.
Null runtime state and stopped runtime status remain valid.
Every `/api/*` operator contract requires operator-session admission through the shared policy and explicitly declares the shared unauthorized response in the [exact shared operator error contracts](#exact-shared-operator-error-contracts).
Ordinary deployments require bearer authentication.
With `SAIVAGE_API_TOKEN` configured, only the exact bearer header admits the request; rejection occurs before request validation or handler work.
Set-but-blank and leading- or trailing-whitespace values fail startup rather than silently disabling authentication or starting a server whose configured token cannot be presented unchanged by the bearer protocol.
Authentication-disabled mode, in which the same operator-session contracts admit headerless requests, is supported only when deployment-owned external isolation limits exposure to trusted origins.
Saivage neither establishes nor detects that isolation.
Wildcard CORS remains enabled and is not authentication.
API bearer credentials are accepted only in the `Authorization` header and never in URLs.

### Exact availability vocabulary

<!-- saivage:value-contract:availability-contract:start -->
```text
vocabulary.availability-state = {"members":["available","degraded","idle","unknown"]}
vocabulary.availability-component-source = {"members":["health-check","mcp-manager","runtime-application"]}
```
<!-- saivage:value-contract:availability-contract:end -->

Each registry-backed operator operation has one required status-to-schema response map.
Exact lookup in that map is the sole runtime authority for both status and body.
The browser likewise parses status 200 and every declared non-200 response through the exact operation-and-status schema before use.
A declared non-200 response becomes validated operator error data; an undeclared status, invalid JSON, or a body that fails its declared schema is a contract/protocol failure and never a generic API error.
On server output, an undeclared status or malformed declared body follows the fixed actionable-evidence/opaque-500 path without sending the candidate body or consulting another schema.
Fixed params, query, body, success, nested-row, and error objects are strict; records and explicitly opaque leaves alone remain open.
Runtime validation errors require `{error:'ValidationError',message,issues}` with strict issue rows, unauthorized responses require numeric `statusCode`, and handler-owned variants remain exact status-local schemas rather than a generic API error.
Agent detail/conversation absence is exactly `{error:'Agent session not found'}`, absent LLM exchange is exactly `{error:'No LLM exchange recorded for this session yet.'}`, and the conversation cursor failure is its own exact one-issue 400 variant.
Process-list status is exactly `running | exited | failed | killed`.

Each request computes one response descriptor inside one complete pre-send `ContractRuntime` boundary.
The ordered phases are authentication evaluation, request-schema execution and transformation, optional validated failure-identity projection, handler execution, exact declared response-schema execution, and contract-violation publication.
Ordinary authentication denial and request rejection remain declared 401 and 400 outcomes.
A throw in a pre-send phase instead selects the unexpected-internal variant in the [exact shared operator error contracts](#exact-shared-operator-error-contracts) and logs only the fixed operation plus `auth_evaluation_failed`, `request_validation_failed`, `failure_identity_projection_failed`, `handler_failed`, or `response_validation_failed`.
Only a successfully parsed canonical card or conversation-session identity may be added to that log; exception objects, text, request data, response data, and schema issues are excluded.
Fastify request logs retain request ID, method, host, remote address/port, and the other standard request metadata, but serialize the URL only through the path before the first `?`; routing and query parsing still receive the complete URL.
WebSocket tickets and all other query contents therefore never enter request logs.

Contract violation publication uses the required app-log boundary.
A response mismatch publishes fixed durable `runtime_actionable_error` evidence and emits no event-list WebSocket hint.
Contract handlers receive only pre-send header and raw-finish-hook capabilities, not status/send authority.
Primitive-classified `PublicationOutcomeUnknownError` reaches immediate fatal delivery before Fastify logging or a response.
Ordinary handler failures retain the generic 500 contract.
The separate Analyst mutation runner remains the sole current control-action audit producer.

Doctor is the normal authenticated registry operation `debug.doctor`.
`ContractRuntime` owns its authentication, request/response validation, outer failures, and final response boundary.
Its strict 200 union has exactly one cards check: `ok` contains the passing `cards_loadable` check with `Cards loaded successfully.` and no issues; `issues_found` contains the failing check with `Cards failed to load.` and exactly one error issue with that message.
`issues_found` is reserved for an ordinary card-read failure.
The bounded handler catch first rethrows `PublicationOutcomeUnknownError`; `ContractRuntime` delivers that identical value to the application fatal port before an ordinary diagnostic or response, so publication uncertainty produces no Doctor response.
Content supervision, its scanner configuration, routes, storage lane, and UI are absent.

## 9. Direct File Persistence

Saivage durable state uses direct synchronous named file functions.
Card state/history/tombstone lives in one exact card-owned append-only `card.jsonl` stream, and each authored record lives in one exact append-only `record-<stem>.jsonl` stream beneath the same card namespace; one logical mutation appends exactly one envelope with exactly one row, and current/history/version selection is derived by one strict complete fold of that stream.
Conversation indexes and immutable segments remain their separate durable authority: conversation append performs read-only strict current-plus-candidate admission and never truncates, and startup alone may truncate the exact current conversation segment only when bytes after its final newline are unterminated and the retained nonempty complete prefix fully validates against the current index, genesis, session, and conversation semantics. First-segment and compaction publication exclusively create the immutable segment, then atomically replace the cumulative index; only successful index publication grants discoverability. The segment is not published by renaming over an existing segment. A created segment left unindexed is ignored forever, with no cleanup or directory/crash-durability promise.
Complete malformed or invalid canonical data remains unchanged and fails.
There are no repositories, caches, queues, registries, transactions, scans, orphan handling, or compatibility readers.

The application log uses the [exact app-log vocabularies](#exact-app-log-vocabularies).
Identity and time exist only in each lane payload, and the derived error set is both runtime kinds plus failed MCP invocations.
The writer's sole boundary accepts the project root, lane, and synchronous preparation closure.
It first performs identity/time construction, centralized outbound redaction or audit/provider projection, authoritative validation, and serialization.
It then performs one bounded tail admission proving that an existing stream ends with a complete newline-terminated strict envelope; a missing target is admissible, while a present zero-byte file or dirty tail fails before any write and is never truncated by the append path.
Explicit reads use the call-local semantic validator over the complete sequence before optional lane filtering; complete-stream validation and global logical-ID rejection remain read-time and startup properties and no longer run at append.
A duplicate logical ID that a writer defect nonetheless produces is published and then fails every complete read and startup validation, with recovery only through the Storage Policy's exceptional owner-authorized offline reconstruction; append never silently accepts or repairs anything.
After successful validation the owner directly opens the exact target once with no-follow/nonblocking append flags and verifies the opened descriptor is a regular file before writing.
Append-open `ENOENT` alone selects one first-publication attempt after real owner-directory validation.
Every other open, read, or descriptor-operation failure propagates, and a symlink or non-regular target is never treated as missing or replaced.

### Exact app-log vocabularies

<!-- saivage:value-contract:app-log-contract:start -->
```text
vocabulary.app-log-type = {"members":["control_action","event","provider_exchange"]}
vocabulary.logged-event-kind = {"members":["mcp_tool_invocation","runtime_actionable_error","runtime_diagnostic"]}
```
<!-- saivage:value-contract:app-log-contract:end -->

Append open and descriptor regular-file admission are pre-publication.
Their failures remain exact ordinary errors and permit one close.
After the first canonical write begins, any write, zero-progress, fsync, or close failure becomes `PublicationOutcomeUnknownError`; no second close or operation follows.
Exact append-open `ENOENT` is the growing-file owner's `missing` selection result.
Preparation, validation, serialization, tail admission, and directory failures remain ordinary.
Once the shared signal exists, no catch may convert it into a failed tool/model/card result or perform a read, retry, append, fallback, later provider attempt, diagnostic, settlement, or hint.

The current terminal propagation path is direct Conversation LLM to plain `AnalystSession` or `CardProcessActor`, then centralized Supervisor ownership.
Inner catches rethrow the identical object before local classification.
The Supervisor `activateProcessor()` rejection callback synchronously begins the one runtime halt and preserves the identical publication error on the owning activation settlement.
Structural child waits receive the shared `RuntimeStoppedInterruption`, become terminal and consumable before joins, and cannot turn the stop into an ordinary failed planner tool result.
The halt performs no publication follow-up I/O and cleanup failure cannot replace publication-error identity at that owning boundary.
The other consuming roots remain the global Fastify handler and registered Analyst WebSocket message rejection observer; they publish no replacement evidence and expose no cause through HTTP or WebSocket responses, while delegation of the same publication error to the singular fatal port may emit the captured direct-syscall cause message on stderr.

Successful owners call narrow SyncHub effects directly.
Conversation publication emits `conversationChanged({session_id,segment_version,visible_message_id})` only after confirmed append/index commit.
Same-version arrivals keep the later committed tip; higher versions supersede lower pending hints, and lower versions are ignored.
Every known-successful first card conversation also emits a membership reconciliation hint; first global publication emits a global-session hint.
Failed or publication-unknown writes emit no hint.
Runtime, card, membership, conversation, and exchange effects remain lossy, non-throwing, debounced, and socket-only.

One stateless `EventQueryService` owns event/error queries for the authenticated operator API and Analyst tools.
Every operation performs exactly one complete strict read of the event lane before filtering and slicing.
`GET /api/events` is the singular non-UI operator event collection: it accepts exact event kind, optional goal/card, nonnegative safe-integer offset, positive safe-integer limit through 1000, and `selection:'oldest_page'|'newest_tail'`; defaults are oldest page, offset 0, limit 50, while newest-tail forbids nonzero offset and preserves chronological physical order.
`total` is the filtered count before slicing.
`GET /api/debug/errors` returns the complete event-derived error projection and is the Debug UI's only event-derived input.
There is no Debug Timeline, `/api/debug/timeline`, dedicated error lane, ErrorLog, session filter, or `since` filter.
Missing app-log state yields empty results.
Every full read validates the complete stream and globally rejects repeated logical app-log IDs before lane filtering.
Any incomplete content, duplicate, complete malformed canonical envelope, or invalid row fails the whole explicit read with HTTP 500 and returns no valid prefix; bytes remain unchanged.

Authenticated `GET /api/debug/graphs` returns one strict graph projection for each canonical card type in canonical order.
Its sole source is the immutable runtime workflow artifact compiled and bound during startup: the handler reads no configuration, prompt file, or runtime-state file.
The response includes the selected global agents separately from card graphs, with each exact global session identity, safe resolved static prompt declaration/source, installed model route/candidates, skills flag, and tools. Card graphs include the designated notification recipient, permitted child types, record definitions, lifecycle entries, named-agent nodes, safe resolved prompt declarations and sources, model routes and provider/model candidate identities with account identity omitted, tool and record capabilities, requirements and descendant context, outcome edges with explicit default or pending-notifications condition, cycles, terminal exports and promotion, all three terminal nodes, and distinct runtime-owned execution-failure edges. Resolved declarations expose explicit `reference` and `compactable` plus only a legal optional exact `compaction_key`; bodies and paths remain absent.
Prompt bodies and paths, credentials, auth profiles, provider accounts/secrets, MCP schemas/descriptions, and mutable workflow position are not part of the contract.
The complete response is validated before egress.
Restart-only `reconfigure` may change next-start configuration, but this projection remains unchanged until a fresh server startup compiles and binds a replacement artifact.

 Every invocation admitted to the audited Analyst mutation runner makes exactly one control-action append attempt.
Operation-owned current-admission or application/domain denial records `denied`; a returned failure or thrown preparation/readiness/application failure records `error`; and a returned success records `ok`.
Safety class is audit classification metadata rather than an admission rule.
The active application/operation owner's abort signal is checked before the owner mutation and again after its return: a pre-owner-call disposal abort prevents mutation, while a disposal abort observed after a committed owner return is surfaced without replaying or undoing that effect and its audit remains `ok`.
Control-action append failure propagates directly without read, retry, repair, or a second append attempt.
This Analyst settlement runner is the only current production control-action producer.
`/api/control-actions` strictly validates the complete stream before optional `card_id` and `since` narrowing and newest-first sorting; it applies no actor or validity filtering.
Valid historical rows, including rows whose actor is `planner`, remain readable and are returned unchanged apart from the shared outbound redaction projection.

Agent identity is configuration-defined.
Each `agents.<name>.model_route` references one `models.routes` entry; temperature and maximum output tokens belong to that route.
Routes select either direct candidates or one profile.
Skill targets are exact configured names and require the target agent's declared skill capability.
No role enum or role-indexed routing remains.

Replacement and first publication use one fresh random UUID same-directory temp opened exactly once with `O_CREAT | O_EXCL | O_WRONLY`, then write/fsync/rename/parent-fsync.
Before first publication, the owner calls `lstat` on the exact target exactly once and ignores a successful result: every existing path object is already published.
Only `ENOENT` from that call permits exactly one replacement attempt; every other error propagates.
Temporary-path collisions and failures propagate without retry or cleanup.
Child candidate claiming is the narrow exception: only candidate-namespace `mkdir` `EEXIST` advances to the next deterministic segment, without inspecting that path.
Crash-left noncanonical files and incomplete card namespaces are silently ignored forever.
Canonical readers derive exact paths from committed identities, validate the complete reached stream, and never discover card, tombstone, record version, session, or temporary artifacts from directory entries.
Complete malformed canonical state fails.

All creation uses ordinary Node defaults under process umask with no mode arguments, chmod, mode probing, or repair.
The generic whole-file growing-JSONL reader opens the exact path read-only with no-follow/nonblocking flags, requires a regular descriptor, reads the complete bytes, and strictly rejects empty, incomplete, invalid UTF-8, malformed-envelope, and invalid-row content without mutation.
App-log initialization admits only exact missing `app.jsonl` as absent; a present zero-byte, incomplete, or malformed stream fails unchanged.
Agent inventory, card-session inventory, and exact summary detail instead use canonical conversation index metadata, while complete transcript and bounded tool reads validate the complete current segment through the conversation owner.

Public OpenAI Responses and OpenAI Codex are separate provider contracts: public OpenAI uses its configured API-key credential, while Codex uses an `openai-codex-backend` OAuth auth profile; neither credential form aliases the other.
Auth profile refresh uses strict direct reads and optimistic whole-file replacement.
The original invocation signal is checked after response/body awaits and immediately before the synchronous latest-file reread and replacement.
For OpenAI Codex and GitHub Copilot, refresh fetch rejection is `server_transient` with status `0`, and refresh HTTP 5xx is `server_transient` with the actual status.
These failures occur before wire derivation, recorder creation, and provider request: the expired token is not sent, the auth file is not replaced, and no synthetic provider exchange is created.
Refresh HTTP 4xx and malformed successful responses retain the null-refresh and ordinary final-auth path.
The unchanged admitted-attempt budget and standard cooling apply to a refresh transient.
An exhausted invocation record is excluded from the final candidate-availability wait scan and cannot reopen when its process-local cooling entry expires; with no viable alternative, the fourth failed admission terminates immediately as a pre-provider failure with no provider exchanges.
Viable alternatives and non-exhausted rate-limit waits retain their existing scheduling order, while cooling remains process-local advice for other or future invocations.
Concurrent refresh is last-completed-write-wins with accepted credential-loss risk and no revision, CAS, lock, or merge.

## 10. Prepared Invocation, Exact Admission, And Compaction

Compaction is mandatory for a bootable server.
Configuration requires literal `enabled: true`, finite `context_utilization_fraction` `U` with `0 < U <= 1` (default `0.80`), `trigger_fraction` `T` (default `0.90`), `tail_fraction` `F` (default `0.25`) with `0 <= F <= T`, and a strict structured `summarizer_candidate` with exact non-empty `provider` and `model` plus required nullable `account`. Removed absolute-budget and completion-reserve keys are invalid.
Omission, false, incomplete or malformed fields, and a candidate not emitted by the configured Provider Registry fail startup.
`account: null` is the implicit provider account; explicit `_implicit` and `_` are exact distinct names, and slash-bearing model IDs are preserved without parsing.
Registry membership is exact and has no role routing, equivalent, failover, credential probe, or network fallback.
`/api/providers` exposes a strict Registry-backed summary with ordered models and candidates, effective capability axes for every model, and exact `HEALTHY`, `BLOCKED_UNTIL`, and `COOLING` availability variants; each `capabilitiesByModel` value is the provider/model default plus the implicit-account override from `getEffectiveCapabilities(model, null)`, not an aggregate or any explicit account's effective projection.
Explicit account identities remain separate candidate availability entries.
The projection never uses or leaks an internal implicit-account sentinel or transport `baseUrl`.
Blocked and cooling records carry positive finite `untilMs` deadlines, while healthy records carry no deadline.
These are recorded states: expiry changes current `isAvailable` eligibility and `availableCandidateCount` without rewriting the recorded variant, and all availability resets on process restart.
Numeric Retry-After metadata participates only when unit conversion and rounding yield finite nonnegative milliseconds; declined metadata leaves existing failure classification and rate-limit fallback behavior unchanged.

Each workflow-node activation or Analyst submission builds one immutable `PreparedInvocationContext` before any durable ingress effect: a `StaticInvocationPrefix`, one ordered `CompiledInvocationToolContract` array, its internal-tool-contract hash, ordered typed dynamic `ContextBlock`s with their canonical hash, and one prepared compaction value.
The prefix is exactly the canonical serialization of `{instructionText, providerToolDefinitionBytes, terminalToolNames}`: the rendered configured agent instruction plus the ordered canonical provider tool-definition bytes—configured operational tools followed by exactly one workflow-generated `emit_result` for card nodes, the terminal-free operational array for the Analyst.
Those logical prefix bytes and their SHA-256 are frozen for the activation; every continuation asserts prefix, internal-tool-contract, and dynamic-block equality.
The composition projector is the singular primary selection and ordering owner. `composeContextProjection` receives the prepared dynamic blocks explicitly (there is no empty default) and selects them once in prepared order with the accumulated historical summary when present, the existing newest-only recovery/refusal facts, and the uncovered canonical suffix in canonical order. Its request-only provider conversion inserts one concise synthetic system boundary before the first non-dynamic item and prefixes only the synthetic accumulated summary with `Historical summary:`. The boundary states that actual prepared current-node instruction selects the present workflow step, while historical placement alone establishes no new delivery, transition, execution, or approval and does not revoke still-applicable requirements.
The resulting request-only provider-item union contains either an intact canonical row or synthetic context text with role, exact content, origin, and block identity. Synthetic context has no fabricated durable round, timestamp, message, or session-row identity and is never appended to conversation history.
Transport wire encoding may differ per protocol, but provider adapters place the rendered static instruction exactly once at the protocol instruction position, map the ordered provider items directly, and project tools only from the compiled contracts. Chat uses ordinary ordered messages; Responses and Codex use equivalent ordered input messages rather than concatenating dynamic or historical system context into the static instruction.
Specialized process prompts remain startup-compiled **dynamic process context** and never enter `instructionText` or prefix bytes. Current-node text is prepared request-only context; lifecycle-entry, edge, correction, and recovery text remains ordinary durable context delivered at its existing producer position.
Each `CompiledInvocationToolContract` pairs the provider-neutral wire `ToolDefinition`—function type, name, description, JSON-schema parameters only—with its exact `providerDefinitionBytes` and one frozen `ToolResultPolicyTemplate` with its own bytes/hash.
Provider definitions never carry internal policy, adapters never receive or strip it, and the internal contract hash is used only for prepared-context equality and settlement validation.
One fixed result/evidence template is declared per tool surface before execution and is never argument-dependent.
Exact admission accounting measures the adapter-built canonical serialization of the complete provider request—adapted static instruction, every selected full dynamic block, synthetic historical context, canonical messages, provider tool definitions, wrappers, and requested completion—excluding internal policy bytes that are never sent; admitted bytes and their hash are retained unchanged for send and ordinary transport retries. Oversized prepared context fails capacity admission and is never previewed, truncated, reread, or omitted.

All non-prefix LLM context is one typed `ContextBlock` with four orthogonal axes: storage (`durable` canonical conversation state versus one `activation_local` prepared value), replacement (`retain` or `latest_snapshot` keyed by `contentSha256`, the generic recomputable represented-content revision), audience (`primary_and_summarizer`, `summarizer_only`, or `evidence_only`), and evidence (`none`, `canonical_locator` with locator plus SHA-256, or `observational_query` with tool, arguments, and observed SHA-256).
The axes never encode one another and there is no visibility flag.
Latest-snapshot selection is by last composition order per key.
The Analyst project orientation is exactly one `activation_local` `latest_snapshot` block keyed `analyst.project_tree`: a deterministic bounded compact tree rendered under the orientation and title-preview byte limits in the [exact context and compaction limits](#exact-context-and-compaction-limits) as compact JSON serialization with UTF-8-safe title previews, running-branch expansion, the exact active path, deterministic wide-parent aggregates, an explicit fresh-observation query marker, and a mandatory root/active-path skeleton whose overflow fails preparation; its constants are sized so the mandatory skeleton of the maximal structural running chain — the project root plus the full depth in the [exact card identity contract](#exact-card-identity-contract) — fits at allocation-derived identifiers, schema-bounded type-name length, and ordinary config-defined type cardinality.
Its builder owns `fullObservationSha256`, the SHA-256 over its complete strict input including cards omitted from the bounded rendering, and separately returns the composer-verifiable `contentSha256` of the final rendered bytes; callers supply neither.

Canonical conversation rows carry one exhaustive, mutually exclusive row policy. Every content policy has required explicit `compactable`; only non-compactable content may carry an optional exact `compaction_key`.
`text` and `model_repair` are direct primary-and-summarizer content; a non-compactable occurrence is valid only when it is independent visible configured user content with durable storage, retain replacement, no evidence, and no provider-private mate. `content_policy_retry` is code-owned retry text; `activity` is an activation boundary omitted from primary and summarizer prose; `model_issue` is structural provider failure whose following recovery notice owns semantics; `model_recovered` is a model-facing synthetic system notice, never evidence-only; `content_policy_refusal` renders fixed synthetic refusal text and never replays the raw provider response; `provider_private` is selectable only with its one marked visible mate; `tool_call` and `tool_result` form one bundle projecting the pre-execution call template and the settled pair. No role, filename, content match, or adjacency infers protection.
An uncovered `summarizer_only` or `evidence_only` bundle remains primary-visible; only validated compacted-genesis coverage may omit it, and an unmatched call is never coverable.
OpenAI Responses private/visible rows and tool call/result pairs remain atomic units that no projection splits.

Tool settlement derives one settled bundle policy from the exact composite call/result identity pair.
Mutable current discovery surfaces—`list_cards`, `get_tree`, current-section `get_card`, every general `read` branch, `glob`, `grep`, `list_card_versions`, and `diff_card_versions`—are fixed `observational_query` surfaces whose observational SHA-256 equals the hash of the exact canonical settled result bytes persisted for the provider.
Exact historical evidence is exposed only by the dedicated immutable readers `get_card_version` and `read_record_version`, whose `canonical_locator` evidence comes solely from their successful dedicated-reader execution, never from visible-result parsing or a second lookup.
Domain failures, unsupported calls, malformed/schema rejection, recovery settlement, and synthetic settlement carry `none`.
Unsupported and synthetic settlement construct their policy template directly and never fabricate locator or observational evidence.

The explicitly cut-over discovery/read/version surfaces pack every provider-visible `ToolResult` inside the default byte envelope in the [exact context and compaction limits](#exact-context-and-compaction-limits) using shared deterministic stateless collection positions and UTF-8-safe `TextSlice`/`JsonSlice` continuation: no unbounded arrays, no line-based paging, no duplicate collections, no inline unbounded record previews, and no count-only limits; a page observes fresh state and is never a stable snapshot cursor. Plaintext `TextSlice` is `{content,utf8_bytes,offset_bytes,next_offset_bytes}`. Collection-only `JsonSlice` is `{content_hex,utf8_bytes,offset_bytes,next_offset_bytes,total_bytes}`: `content_hex` is lowercase hexadecimal for a decoded-byte interval of the complete outbound-projected canonical JSON item. Consumers hex-decode, concatenate decoded bytes in item/offset order, UTF-8 decode, and JSON-parse the complete item; offsets and lengths count decoded bytes, while the hex payload itself costs two wire characters per decoded byte. Final sizing measures the complete settled success envelope after ordinary outbound projection, and failure to fit one positive UTF-8 progress unit is a bounded tool failure rather than an empty nonterminal success.

Every successful `mcp_tool_call` instead has data exactly `{result,result_complete,result_utf8_bytes}`. Its source is the outbound-projected MCP transport result serialized as canonical JSON, and `result_utf8_bytes` is the UTF-8 byte count of that complete source including JSON quoting and escaping. When the complete settled success envelope fits 32,768 UTF-8 bytes, `result` preserves the projected source structure and `result_complete` is true. Otherwise `result` is a lossy, projection-stable, exact UTF-8-safe prefix string of that canonical source and `result_complete` is false; secret-safe endpoint selection may make the prefix shorter than the available budget or empty. The complete settled success envelope remains at most 32,768 UTF-8 bytes. There is no continuation, artifact, stash, suffix, or replay. An ordinary MCP invocation failure has a final outbound-projected `error` field of at most 512 UTF-8 bytes; that limit does not include JSON escaping or the rest of the failure envelope. MCP remains outside the response-paging API and participates normally in compaction and request admission.

At the direct canonical branch of primary provider conversion, successful current process rows are strictly parsed and pass through `validateProcessToolResult()` before copying. For a done process (`status !== 'running'`), each URL is omitted independently only when its corresponding stream is complete; running and partial streams retain their references. Every successful process copy is canonically serialized even when neither URL is omitted, and only that copy's `result_content_sha256` is recomputed before `agentMessageSchema` acceptance. Failed results and other tools pass unchanged. Durable history, live/operator activity, and summarizer source retain both URLs and the original exact row bytes; prepared blocks, retained instructions, source commitments, and protected-prompt order are untouched. Chat, Responses, and Codex build and measure their actual candidate requests only after this copy. Structurally current hash-consistent retained data can therefore fail at actual primary use for invalid identity, URL, head stability, or canonical-envelope size, but formatting differences alone do not fail and no startup audit or durable normalization occurs.

`glob` and `grep` accept strict optional `position:{item_index,item_byte_offset}`, `response_bytes` from 512 through 32,768 (default 32,768), and `max_results` from 1 through 1,000 (default 200). Each call performs one complete fresh read-only traversal of its eligible discovery domain, counts the exact total, retains only the contiguous candidate window beginning at `item_index`, and returns `matches:{total,position,returned,next,items}`; it writes no stash or other result artifact. Copy `matches.next` unchanged for the same query and stable input. A consumed nonzero item offset must name an existing item, be strictly below its complete projected canonical-JSON byte length, and lie on a UTF-8 boundary; terminal zero-offset positions return a measured empty page. Filesystem traversal is depth-first with sibling names ordered by explicit JavaScript string comparison, and declared record filenames use that same order. Project-relative plus `project:///`, `tmp:///`, `system:///`, `record:///`, and read-only `work:///` scopes preserve their existing admission, display, hidden/binary, and include rules. Record scope reads only effective current declared records; work scope reads supported process/stash/work paths. Glob data is `{matches}`. Grep data is `{matches,content_truncated,max_line_chars:2000}`; `content_truncated` concerns only eligible line suffixes beyond the searched 2,000-character prefix, previews remain at most 500 characters, and it does not describe collection completion. Stable-input continuation is not a snapshot guarantee, and current search bounding does not promise that compaction will never occur.

The optional exact project-root file `.saivage-search-ignore` defines additional project-directory exclusions for recursive project-relative and `project:///` glob/grep discovery only. Saivage direct-reads that file once per project-directory search. Absence and an empty/comment-only file add no exclusions. The file is fatal-decoded as BOM-free UTF-8: malformed UTF-8 and any leading UTF-8 BOM fail the consuming search through the ordinary bounded expected-failure result. Lines accept LF or CRLF, trim surrounding whitespace, and ignore empty lines and full-line comments whose first non-whitespace character is `#`. Every other line is one literal project-root-relative slash-separated directory path. It has nonempty segments and no leading/trailing slash; `.`, `..`, repeated separators, backslashes, colon, control characters, glob characters `* ? [ ] { }`, and leading `!` are invalid. There are no inline comments, escapes, negation, URL/absolute forms, existence checks, or Git/`.gitignore` inference. Invalid syntax reports the policy filename, fixed reason, and line number without policy content; non-absence read errors and decoding errors likewise fail rather than enabling unrestricted traversal. The file is never repaired or rewritten by a read.

For normalized project-relative directory path `p`, entry `e` excludes `p` exactly when `p === e` or `p` starts with `e + '/'`; matching is literal, case-sensitive, and always anchored at the project root. The walker tests the requested starting directory and each descendant directory before its first enumeration. An excluded starting directory returns an ordinary empty successful page. A configured path that currently names a regular file does not exclude that file. Existing fixed/security exclusions remain independent and cannot be relaxed. Explicit regular-file glob/grep, all `read` operations including exact files beneath excluded roots and `.saivage-search-ignore` itself, nonrecursive directory/Files browsing, and `record:///`, `tmp:///`, `work:///`, and `system:///` search do not load or apply this policy. Required tracked or untracked fixtures remain discoverable only when projects keep them outside excluded roots; mixed artifacts directories must not be excluded wholesale merely to shorten search or conceal failed evidence. Policy content is part of stable input for continuation, and a later invocation observes edits without restart, cache, generation, retry, or cross-call stabilization.
`read_record_version(card_id, record_name, version)` selects exactly one row of the card's `record-<stem>.jsonl` stream by version after one strict complete fold, applies the state-dependent open/closed/discarded content-selection rule to that row's own payload, and never follows the row's embedded accepted source reference; it returns and validates the row's version/entry/state/source/hash on every page, the row's potentially different accepted `source_version` is never an alias or inference, and the `<version_url>#entry=<entry_id>` locator and selected-row hash repeat exactly across pages.
Diagnostic, control-action, and agent-session tool result bodies remain arbitrary and are bounded only when exact compaction materialization and request admission admit a subsequent provider request. Process results instead use the strict bounded contract and primary-only copy above.

For a candidate declaring context window `C`, output limit `M`, and exact positive configured output request `O <= M`, the shared arithmetic is `I = floor(U * C) - O`. Binding excludes missing limits, unsupported output requests, and nonpositive `I`, then freezes the maximum eligible `I` for each participating route. Preparation validates positive static capacity and derives `floor(T * I) - S` as the message trigger, `I - S` as the message hard ceiling, and `floor(F * I)` as the tail budget for static estimate `S`. Requested output is exact and is never clamped.
The prepared card context begins with exactly the unchanged system-role activation-local block containing canonical `{cardId,cardType,title,brief}` JSON, where `brief` is the complete accepted configured bootstrap content. A card node follows it with exactly one retained system-role activation-local block containing a minimal compiled-node label and the unaltered full text selected from the actual compiled process/node. The Analyst dynamic block remains its existing bounded project orientation and has no node block. These blocks are prepared before ingress, frozen through initial calls, tool and notification continuations, plain repair, pinned retry, preventive/local/authoritative compaction projection, and the one authoritative retry, and are never reconstructed by rereading current card/tree state. Tool effects, canonical results, and broadcasts remain outside retry seams. A later card-node activation or Analyst submission prepares anew; confirmed restart remains model-free.
Current-node text creates no new durable row. Previously written node-looking text remains unchanged, unrecognized ordinary history and can still appear in suffix or accumulated summary; exact textual duplication does not make it current. The complete prepared node block participates in ordinary request measurement, so an oversized node fails admission rather than being truncated or compacted away.
Tool-result and repair calls retain the activation's exact prefix, tools, and prepared object while refreshing source input ID and canonical projection.
Application composition retains candidate identity only in the summarizer's fixed one-candidate invocation route; runtime/Analyst policy, prepared policy, compactor arguments, prompts, and episode context are identity-free.
The singular `ConversationLLMActor` requires prepared input for every persisted named-agent provider turn and rejects an unprepared call before transition or persistence.

Structural workflow compilation remains provider-independent. Startup binding derives the distinct participant set—the configured global Analyst plus every named node agent in every selected graph—and requires each to have at least one capability-compatible configured candidate with positive usable input. Missing limits and output-ineligible candidates do not inflate the maximum. Configured agents unused by selected graphs are exempt. Binding uses the same immutable Registry snapshot as candidate admission and performs no credential, availability, auth, or network probe.

Compaction replaces one validated current conversation projection with a strictly smaller known-published successor and never rewrites an append-only body.
The successor segment's compacted genesis is self-contained and carries the accumulated history: the accumulated summary text; an ordered protected-prompt list with original exact message and first-extraction `{segmentVersion,rowIndex}` coordinates; coverage commitment including protected-list hash; disposition commitment including summarized, evidence-only, superseded, and protected row counts; exactly two nullable bounded required-model-fact slots (latest recovery notice and latest covered refusal); and an explicit continuation that is `between_rounds` or `inherited_open_round` carrying only the validated marker ID, canonical input UUID, and active initial/repair segment kind. The list size is variable and may grow without a configured bound.
The successor identity is preallocated once; the validated candidate and the published genesis share that exact identity and timestamp, and the returned in-memory projection is exactly the published one.
Publication-unknown escapes unwrapped before any append-error conversion.

Compacted genesis is the sole self-contained prior-history input to the next compaction: generation N+1 consumes the inherited accumulated summary and ordered protected-prompt list before newly selected groups and never opens a predecessor segment for current projection. The owning read validates strict row policy, session, unique/disjoint IDs, ordered coordinates, source-version bounds, and exact list hash. Publication's fresh source read additionally proves every copied, released, and newly extracted occurrence and its coordinate.
One call-local sequential refine accumulator owns a genuinely nullable accumulated summary: it is initially the inherited summary or null, and every successful content-bearing call returns its complete replacement.
`EMPTY_COVERAGE_SUMMARY` is candidate-facing text for structural-only coverage with no inherited or current-segment summary material; it is never stored as the accumulator, labeled as prior history, reduced, or sent to the provider.
A structural-only increment advances exact call-local coverage without provider I/O, carries genuine nullable accumulated semantic history unchanged, and uses `EMPTY_COVERAGE_SUMMARY` only when no accumulator exists; the resulting candidate remains subject to ordinary prospective validation and strategy acceptance.
Required-model-fact slots are derived newest-only from inherited slots plus newly covered rows; a superseded slot's historical meaning is folded into the accumulated summary before replacement, unchanged slots are carried without re-summarization, and each slot is bounded so neither code-owned text nor marker list grows across generations.
The exact code-owned recovery notice text and refusal replanning text each occur at most once in any materialized request; a covered refusal locator remains resolvable to the synthetic compacted fact only while it is the latest covered one, and a superseded older marker is no longer a current-transcript locator.
Removed raw provider-response bytes are unavailable and never reconstructed.

Validated coverage is the sole omission authority.
A `summarizer_only` or `evidence_only` bundle below the trigger remains primary-visible even after its round closes—closure alone changes only eligibility—and a closed round stays fully visible until a later successful compaction covers it.
The logically open round is never treated as complete because its physical rows are all observed; explicit open-round inheritance publishes an empty physical tail with validated coverage only after successful refine coverage of every currently safe settled row of that open round, and an unmatched call cannot be covered and remains in the tail.
Before construction, compaction selects at most two distinct positive increasing safe endpoints: the preamble and closed rounds outside the backward `floor(I * tail_fraction)` tail, using configured snap behavior, and the furthest legal closed/open atomic fallback. Empty inherited rounds contribute no endpoint. Equal, absent, and zero endpoints are omitted; no all-cutoff array or candidate memo exists.
Preventive compaction accepts a shrinking hard-budget-fitting preferred candidate immediately when it reaches the trigger; otherwise it retains that complete candidate while trying the furthest endpoint, then chooses the smallest qualifying complete projection even when it remains above the preventive trigger. Authoritative recovery retains its first strictly smaller complete projection. Local exact admission retains the smallest complete composed-byte projection strictly below the rejected projection, tying toward the furthest endpoint; an eligible later output/size/capacity failure does not destroy it. With no qualifying complete candidate, authoritative and local successful construction return `no_smaller_projection`; expected failed construction is distinct. Infrastructure, protocol, cancellation, invariant, and evidence failures never use a retained candidate.

Every refine request contains, in order, the dedicated replacement-summary instruction, every selected frozen prepared current block labeled `prepared_context`, every currently selected protected instruction labeled as full read-only orientation, the genuine accumulated history when present, and labeled new source. Static agent instruction is not duplicated. Protected rows remain in prefix grammar and coverage accounting but are excluded from summary source. A later false occurrence of an exact key releases only the older inherited occurrence; the released exact text enters summary source once on the first demanded successful positive advance, while the new occurrence remains orientation whether it is covered or still in the tail. Anonymous false occurrences never replace one another. Without a positive legal endpoint, release alone publishes nothing. The instruction preserves attribution, actual work and decisions, unresolved uncertainty, evidence references, important unrecorded information, and still-applicable requirements; distinguishes proposed from executed and draft from accepted or approved; and states that a final success from sequential newline-separated commands does not prove earlier commands passed (`pipefail` concerns pipelines). Tool arguments and results are separate ordered source components; evidence-only content uses its existing evidence projection, and private result bytes never enter summary source.
The actual-use packer assigns each immutable projected component exact UTF-8 byte ranges at code-point boundaries, total bytes, source hash, and `omitted_source_bytes=0`; empty components carry an explicit empty range. It first exact-admits the next code point or empty component, tries the whole remainder, and after whole rejection grows prefixes by doubling to establish an admitted lower and first rejected upper endpoint. It then bisects that code-point bracket to the greatest admitted prefix; a short final growth uses the already-rejected whole remainder as the upper endpoint. A rejected next-component minimum flushes already admitted material. Sent ranges reconstruct every projected component exactly once without gaps or overlaps, and each admitted serialized body/hash is retained unchanged for send.
Every probe includes actual wrappers, escaping, range-label digits, prepared orientation, genuine accumulator, and requested output through the real serializer. The fixed summarizer independently uses `I_s = floor(U * C_s) - 2000`; the primary route ceiling never constrains it. Prepared orientation and inherited summary are never split, trimmed, or hypothetically reserved. A representative production-composition test covers the 1,050,000-token Astra preparation and 120,000-token Sol summarizer case at `U=.80`, including full-window source, both endpoints, correction, strict coverage, and the unchanged 16-call ceiling; this is mechanical feasibility evidence, not a universal compactability, provider-token, quality, or latency guarantee.
Cancellation is observed with its exact reason before `compact()` reads or prepares source and before each accumulator advance, send, and resumed packing step. One `compact()` permits at most 16 logical refine invocations across normal folds, both endpoints, and the single optional corrective regeneration. Immediately before each invocation it checks abort, admission, and the ceiling, increments, then sends; a needed seventeenth call is not made. Ordinary Invocation Service transient attempts remain internal to one logical invocation.
Every strictly increasing advance computes its next summary, inherited-fact fold markers, and cutoff transactionally and commits that call-local state only after the entire advance succeeds. The accumulator retains only the latest genuine fold's pre-fold inherited summary and exact source ranges so one correction can regenerate that fold with a fresh UUID, stronger 6,000-byte concision target, and fresh exact admission; it never summarizes rejected output or drops source. A corrected inherited fold retries a blocked next-minimum-range probe from the same unconsumed cursor. After each successfully validated fold is recorded complete, cancellation is observed again before packing resumes.
Failure leaves the preceding committed advance state unchanged. Eligible output/model/size/capacity exhaustion may select an already completed qualifying candidate; all other failure classes terminate exactly. Invocation and progress accounting is not rolled back: admitted invocations and started folds remain counted, while only successfully validated folds are recorded complete.
Summary exchanges run under the internal evidence namespace `internal:compaction-summary:<sha256-of-source-session>` with the internal `internal-compaction-summary` label; they are not configured agents, never enter Agent inventories, and remain separate from primary provider-attempt state.
Refine calls execute sequentially, with at most one summarizer provider call in flight. One correction is eligible only for empty/tool output, Chat `length`, typed output-token capacity, a completed fold blocking the next minimum range, or a final no-reduction/residual-capacity obstruction. Refusal and input capacity are fallback-only where a complete candidate exists; infrastructure, unknown/protocol, cancellation, invariant, and evidence failures authorize neither correction nor fallback.

### Exact context and compaction limits

<!-- saivage:value-contract:context-limits:start -->
```text
constant.analyst-orientation-max-bytes = {"unit":"bytes","value":8192}
constant.analyst-title-preview-max-bytes = {"unit":"bytes","value":128}
constant.tool-result-envelope-max-bytes = {"unit":"bytes","value":32768}
constant.summarizer-completion-tokens = {"unit":"tokens","value":2000}
constant.summarizer-output-target-bytes = {"unit":"bytes","value":12000}
constant.compaction-refine-max-invocations = {"unit":"logical invocations","value":16}
```
<!-- saivage:value-contract:context-limits:end -->

The current durable compacted payload remains unchanged. Compaction configuration, endpoint choice, estimates, and prepared static values are not persisted in compacted genesis.

Preventive actor compaction assigns each visible row weight `max(1, ceil(UTF8-byte-length(projected visible content plus the existing aggregate structural text) / 4))`; `provider_private` rows have exactly zero actor weight, their marked visible projection carries the conversational weight, and protected bundles remain indivisible.
This row-derived weighting drives only the preventive threshold: it is neither complete-wire accounting nor fit proof.
Separately, each protocol candidate builds and canonical-serializes its actual complete transport body once and measures `ceil(UTF8 bytes / 4)`, so a Responses estimate includes private output bytes present in that exact body.
That complete serialized body is reused unchanged for admission, hashing, retries, and final send.
For every prepared ordinary, pinned, and retained-recovery request, each candidate compares this exact estimated input with its own `I`; equality fits. Any fitting candidates execute in original route order, while smaller nonfitting fallbacks are excluded and do not force compaction for a fitting larger candidate. Retained recovery membership never expands after compaction. The byte heuristic is deterministic and best-effort, not a provider-token fit proof; Codex intentionally does not transmit `maxTokens`, though exact `O` remains admission authority.
Prepared autonomous requests omit ordinary `modelParams.maxTokens`; their one prepared `requestedCompletionTokens` controls hard ceiling, candidate context/output admission, model authority, and the Chat and public Responses wire output limits.
The Codex backend transport uses it for admission/options authority but intentionally serializes no output-limit field.

Every Invocation Service attempt, including retries and direct summarizer calls, unconditionally enters the shared runner with the candidate's `CandidateRequestPlan` as the sole request authority and observes cancellation before unconditionally verifying the hash of its canonical serialized bytes.
A hash mismatch raises the one internal integrity failure and performs no generic capability work, credential/auth-profile read or refresh, recorder creation, network or app-log write.
Invocation Service rethrows that same failure before classification, attempt or candidate accounting, indexing, availability mutation, wait, retry, failover, later-candidate credential/provider I/O, or publication.
After a valid hash, the shared runner performs exactly one generic capability check; mismatch likewise precedes credentials, recorder, network, and writes.
The selected closed protocol adapter then carries its credential requirement into delayed resolution, which performs no capability or protocol selection, and the exact planned bytes are sent and reused on retry.
The selected adapter directly consumes the successful fetched `Response`; the structured recorder retains response status, usage, finish reason, terminal-tool evidence, and raw caught error evidence without buffering or capturing a raw response body.

For every started attempt whose success or error reaches the runner, the runner settles exactly one raw in-process exchange before returning or constructing recovery.
Raw caught name/message and an available typed status are evidence before classification; this includes Codex stream failures classified after HTTP 200, which retain response and error status 200.
An aborted signal relabels a caught in-attempt value as typed cancellation only when that value is identity-equal to `signal.reason`.
A direct Invocation Service caller then performs no retry or availability mutation and retains the indexed raw exchange.
In contained production, normal actor output persistence and per-attempt redacted app-log publication execute inside the admitted raw lifecycle callback before wrapper settlement and consumer delivery.
Immediate wrapper abort may abandon unresolved work; later runner settlement and Invocation Service aggregation remain possible internally, but currentness fences every late outcome from actor persistence, provider-exchange publication, read-model hints, actor-level retry/reconciliation, and delivery.

Provider input-context evidence is strict and structured.
`input_context_exhausted` requires the supported transport's exact direct code/type/param shape: an eligible parsed non-OK HTTP error object only when the actual response status is exactly 400, a failed public Responses terminal object, or a Codex error/failed event after a response opened.
Matching is case-sensitive; message prose, recursive/nested markers, malformed bodies, status alone, generic token language, and output-limit evidence do not qualify.
Responses `incomplete_details.reason: 'max_output_tokens'` is the distinct `output_token_limit_exceeded` failure.
Typed terminal evidence remains eligible after HTTP 200.
Every failure retains the actual HTTP response status; an embedded terminal status is classification evidence and never replaces transport evidence.
The durable lifecycle `blocker_cause: 'token_budget_exceeded'` is an independent current card-result value and remains unchanged.

Direct provider failure classification has one explicit source boundary and one precedence across non-OK HTTP responses, Codex `error`/`response.failed` terminals, and public Responses failed terminals, including terminals delivered after HTTP 200: HTTP or embedded 401 is permanent authentication; HTTP or embedded 429, valid retry metadata, exact rate-limit evidence, and exact `usage_limit_reached` are rate limit; HTTP or embedded 5xx and exact transient markers are server transient; eligible simultaneous exact input-context and explicit content evidence is a fail-closed provider-protocol ambiguity; eligible exact input context follows; then direct content-policy evidence; then remaining HTTP or embedded 403/direct auth; then the path's existing unmatched failure.
Exact HTTP 400 gates context eligibility only at the non-OK HTTP boundary; typed opened-terminal context evidence remains eligible after HTTP 200.
Direct content-policy evidence precedes residual embedded-403 authentication evidence, and every classified result reports the actual HTTP response status rather than an embedded terminal status.
Exact direct lower-cased `code` or `type` token `server_is_overloaded` is server transient, including supported Codex `error` and `response.failed` events received after an HTTP 200 stream opens; the exchange retains truthful response status 200.
Prose, nested values, prefixes, suffixes, and near matches do not qualify, while independent 5xx, retry, and rate-limit evidence keeps its existing authority.
Content evidence is limited to direct `code`, `type`, or message evidence for exact `cyber_policy`, `content_filter`, or the bounded supported phrases.
Generic policy/permission prose, 403 alone, and recursive JSON searching do not qualify.
A public Responses content refusal retains the exact complete JSON response body as `providerResponse`; a Codex stream refusal retains the normalized parsed SSE `dataText`.
Request bytes are never evidence.

Response mode is protocol-owned.
Chat Completions and public Responses request and parse one complete JSON response; Codex alone requests SSE and uses the incremental SSE line reader.
Its fatal UTF-8 decoder accepts CRLF, standalone LF, standalone CR, and valid mixtures, retaining a pending CR so chunk-split CRLF is one line ending.
Blank lines dispatch fields; EOF finalizes decoding, commits pending CR and a nonempty unterminated line, and deliberately dispatches one still-accumulated data event.
Comments and unknown fields are ignored.
The last case-sensitive `event` wins and empty/absent event means `message`; each `data` value removes at most one space after the first colon and values join with exactly `\n`.
Only exact normalized `[DONE]` is the sentinel.
The unchanged joined `dataText` is parsed once and is the sole Codex stream-failure evidence; framing, comments, chunks, and line-ending spelling are not evidence.
Malformed UTF-8 or JSON is a typed parse error, never skipped.
The Codex parser validates every recognized output-text delta but never assembles deltas into returned text, and nested content-part/output-text done forms are not completion authorities.
Its message candidate is the latest complete assistant `response.output_item.done`, replacing any prior completed message in full.
Only `response.completed` carrying a non-null, non-array object `response` with a string `response.id` permits success; a malformed completion is a typed parse failure even when a message or finalized tool candidate exists.
Physical EOF or `[DONE]` before that valid completion is typed truncation even with a candidate, while an EOF-finalized valid completion event retains the line reader's dispatch semantics.
A pre-completion `error` or `response.failed` supersedes every candidate.
After valid completion the parser returns finalized tools before the latest message and stops immediately without awaiting physical closure or consuming later framed or physical events.

Ordinary primary execution uses one exact local admission state machine.
`InvocationService.preparePrimaryRequestAdmission()` walks one ordinary route pass once: for every candidate in configured chain order it resolves effective capabilities, calls the pure `supportsCapabilityRequest()` exactly once against the one immutable known `CapabilityRequest`, and builds/canonical-serializes exactly one immutable request plan per projection; each candidate then receives exactly one verdict after capability, declared-limit, positive usable-input, and exact-size classification are all known.
`admitted` requires conjunctively capability support, declared context/output limits, candidate output capacity, positive usable input, and exact estimated input no greater than that candidate's `floor(U*C)-O` ceiling (or `C-O` for an unprepared internal call).
A failed capability match, undeclared required limit, insufficient output maximum, or nonpositive usable input is non-size-fixable `candidate_ineligible`; an otherwise eligible candidate whose exact serialized projection exceeds its usable-input ceiling is `projection_too_large`.
Aggregate no-fit is decided only after every route candidate is classified: at least one admitted plan executes only admitted plans in original relative order with reused serialized bytes; otherwise at least one `projection_too_large` yields `local_compaction_required`; otherwise `local_admission_failed`.
Capability-ineligible candidates neither cause nor suppress compaction—a fit-but-incapable candidate cannot block compaction needed by a compatible oversized one, and after the unchanged capability request re-classifies it ineligible again.
The verdict precedes execution; execution-time capability checking is only a fail-fast invariant reassertion of the immutable admitted plan, never a first decision, exhaustion, or failover event.
Both local outcomes are strictly separate from provider-reported `input_context_exhausted`, provider attempts, availability state, and recovery retries; neither is normalized into `ProviderTurnFailure`, `LlmTransportFailure`, candidate availability, a provider exchange, or a model issue.

On the first aggregate `local_compaction_required`, and always before any not-yet-performed initial turn-start append and primary provider I/O for that route pass, the actor performs exactly one `local_exact_admission` compaction with the same fresh prepared context and exact rejected projection, replaces only `providerConversation` after asserting prefix/dynamic/internal-contract/capability-request equality and source-session freshness, and invokes exact admission once more over the new projection with one fresh build and verdict per candidate.
Send happens only if that second outcome is `admitted`; a second `local_compaction_required`, `local_admission_failed`, `no_smaller_projection`, construction failure, or uncoverable safe prefix is one terminal `LocalExactAdmissionError` with bounded aggregate/per-candidate capability/limit/output/size reasons and no request body, provider attempt, or error row for the rejected pass. An owned non-provider construction failure appends its fixed safe reason/count/available-measurement diagnostic to that outer message without exposing its internal cause.
An initial `local_admission_failed` fails immediately as `LocalExactAdmissionError` with `local_compaction_attempted:false`.
There is no third admission, compaction retry, stale reread, alternate route pass, excluded-candidate bypass, or budget/capability weakening.

Provider-reported `input_context_exhausted` remains separate post-I/O recovery for ordinary admitted execution only, recognized solely from a real ordinary error provider exchange after an admitted request was sent and a valid `AdmittedProviderTurnFailure` transfers the typed suspended execution.
Ordinary authoritative recovery retains one immutable admitted-candidate membership (frozen from only the `admitted` verdicts of the ordinary admitted object that reached execution, in original route order, with hash) plus one invocation-owned process-local per-candidate state record with explicit `untried`, `temporarily_unavailable`, `retry_waiting`/`retry_ready` (standard or rate-limit), `context_failed`, and `exhausted` kinds.
The actor holds that suspension untouched during the one `authoritative_context_recovery` compaction—custody only, no mutation, scheduling, or exposure—and returns it to the recovery-scoped preparation/resume boundary, which verifies membership/hash, exactly one `context_failed` member matching the real failure, record uniqueness/order, settled-attempt indexing, and unchanged input/prefix/tool/dynamic/capability/deadline bindings before any retry transport; missing, copied, reordered, extra, duplicate, or malformed state fails closed with no fallback to route configuration or provider exchanges.
The context-failed member must re-admit and is attempted first with the compacted bytes; if it does not re-admit or reports context exhaustion again, recovery is terminal with the preserved real attempts.
Only afterward does the existing scheduler resume over the retained records—an earlier rate-limited, retry-waiting/ready, or temporarily unavailable member remains viable, later untried members remain viable, and exhausted members stay excluded—while attempt counts, the absolute unavailability deadline, last-failure values, and all settled primary exchanges survive unchanged with monotonically appended indexes.
Originally rejected or exhausted identities are never rebuilt even if compaction would make them fit; there is no route widening, state reset, or limit weakening.
A pinned failure never satisfies this predicate and never produces the suspension.

The terminal content-policy pin is a separate one-call exception, not a one-member ordinary route.
`preflightPinnedContentPolicyRequest()` performs one pure configuration/capability/declared-limit/usable-input/exact-size classification and one canonical request build for the single refusing candidate only, with no availability read/write, transport or auth resolution, provider-exchange publication, wait, retry, route enumeration, or compactor call.
Both `candidate_ineligible` and `projection_too_large` terminate pinned execution immediately with bounded diagnostics, the unchanged original refusal attempts, no compaction or substitution, and no provider I/O for the pin.
If and only if preflight admits, its exact retained serialized bytes are sent once with no availability, wait, retry, failover, retained execution state, suspension, or recovery.
Every non-refusal failure of that sole call—including `input_context_exhausted`, cancellation, timeout, protocol failure, rate limit, and availability-shaped transport failure—terminates directly.
The actor alone combines original refusal attempts followed by the sole pinned attempts through `combineProviderAttempts()`, overwriting the activation input ID and assigning contiguous attempt indexes; that combination is final evidence composition, not ordinary retained execution state, and never includes compactor or summarizer exchanges.

A clean `no_smaller_projection` result after successful local or authoritative construction appends no compaction, performs no second provider pass, and produces the existing owning terminal behavior. Preventive may publish a strictly shrinking hard-budget-fitting candidate above the desired trigger; the next genuinely refreshed invocation may compact again, but the same successful result is not rechecked in a loop.
The normal and corrective prompts target at most 12,000 and 6,000 UTF-8 bytes respectively; neither is an acceptance ceiling. Complete nonempty prose is valid even above target or when it mentions recoverable evidence. Empty text, tool-call output, and Chat `finish_reason:'length'` are correction-eligible `SummaryResultValidationError` values. A final successful Chat `content_filter` completion is a safe fixed `content_policy` `ProviderTurnFailure` and permits fallback but no regeneration; unknown explicit finish values and `stop`/`tool_calls` result mismatches become safe fixed `provider_protocol_error` failures and permit neither. Null/absent finish metadata uses ordinary result validation. Responses and Codex retain their native completion handling.
Only owned non-provider construction failures become `CompactionSummaryConstructionError`. Its fixed safe message reports reason, logical invocation count/limit, correction count/limit, and available summary-byte/target or projection-token/ceiling measurements; it never stringifies arbitrary provider prose. Eligible reasons are `empty_output`, `tool_calls`, `incomplete_output`, `request_context_capacity`, `fold_limit`, `residual_capacity`, and `no_reduction`. Provider failures—including typed output/input capacity and content policy—remain the exact original `ProviderTurnFailure` when no candidate/correction succeeds. Abort, summary-exchange projection/publication, publication-unknown, source/projection/hash/invariant, and append failures retain their exact owning identities.
`PublicationOutcomeUnknownError` authorizes no inspection, retry, or compensation, and canonical append failure remains `CompactionAppendError`.
Summary refine attempts are projected exactly once to the existing app log under the internal `internal:compaction-summary:<source-session-hash>` evidence session and fresh source-input identity, with no assistant output IDs, and are never merged into the triggering persisted input.

Last-chance context recovery has one narrow publication-ownership conversion after the triggering planner provider boundary has already been entered.
If summary recovery exhausts with `ProviderTurnFailure` after summary attempts were published, including the narrow Chat refusal/protocol conversion after its successful exchange was published once, the actor validates and publishes the original triggering planner context-failure attempts exactly once under the planner input, with null terminal conversation output and no assistant output.
Publication failure or uncertainty remains authoritative and creates no marker.
Only after successful triggering-attempt publication does the actor throw fieldless `LastChanceSummaryProviderUnavailableError`, whose safe generic message and exact summary `ProviderTurnFailure` cause prevent generic rejection from reidentifying or republishing summary attempts or fabricating a planner `model_issue`. Provider exhaustion gains no construction reason/count diagnostic.
The marker has no provider exchanges, failure phase, route pass, candidate, or classification and makes no recovery decision; it is solely an actor-operation publication-ownership signal.

Every persisted `ConversationLLMActor` has required immutable purpose.
`{kind:'autonomous-card',cardId}` must exactly match a card-scoped session; `{kind:'analyst'}` must match a global session.
CardProcess and AnalystSession are the two explicit production constructors.
Purpose is never inferred from episode context, tools, or names.
Every `LlmInvocationInput`, provider adapter call, and Invocation Service request carries one required route pass: ordinary with its bound candidate chain, or the private actor-produced pinned content-policy retry with the first refusing candidate.
Analyst and direct summarizers never produce the pinned variant.

On the first autonomous-card `content_policy` failure, the actor durably appends exactly: “Saivage authorizes only assistance that the provider can give within its applicable safety requirements. This automated message is not an operator attestation about the request's purpose, locality, or benignity. If compliant assistance is possible, continue within those requirements; otherwise refuse.”
It rereads canonical conversation and requests one pinned pass to the same provider/account/model.
The pinned pass retains request-plan integrity/admission, cancellation, credentials, attempt recording, and exchange indexing, but does not consult or mutate candidate availability, recover, delay, fail over, compact again, or make a third call.
Once planning, admission, credentials, and cancellation checks admit transport, exactly one call occurs.
Cancellation, invalid plan, admission rejection, or credential failure before transport is a final `pre_provider` zero-call result.
Analyst content refusal remains a one-call terminal model error with no retry row or pinned request.

If the pinned call also refuses, the actor combines and reindexes both error attempts under the original source input, appends one strict system `content_policy_refusal` marker, publishes the combined safe exchanges exactly once, then hands off typed BLOCKED.
The marker contains only version/type, source input, candidate, and the second terminal refusal's exact `provider_response`; it contains no request conversation, first response, generated paraphrase, tool input, or partial output.
Physical marker content never enters provider/summarizer input.
Projection replaces it once, including across compaction, with fixed generic replanning/safety text and its exact `/agents/<session>?entry=<marker>` locator.
A final marker is clean recovery state; malformed/colliding rows or rows after it fail.
Raw Agent API projection preserves marker structure while redacting terminal response text; rendered views show only synthetic text.
The first raw response is intentionally absent from the marker and UI.

Provider-exchange success and error identities are disjoint.
Success has `assistant_output_ids` and no terminal-error identity.
A transport-successful attempt whose output later fails local validation remains a success and links the resulting assistant `model_issue` through `assistant_output_ids`.
Every provider error attempt has required nullable `terminal_conversation_output_id` and no assistant IDs.
Both repeated-refusal attempts use the marker ID; ordinary provider-error attempts use their model-issue row ID; direct summarizer errors use null.
Marker append precedes one combined exchange publication, which precedes handoff; any uncertain append permits no retry, inspection, handoff, or fallback settlement.

Repeated refusal settles the running card BLOCKED with `{kind:'content-policy-refusal',summary:'Provider content policy blocked this card after one safety-respecting reframing attempt.',session_id,marker_id,evidence_url}` and null `completed_at`.
Every compiled node has a code-owned `execution:blocked` edge beside `execution:failed`.
The waiting parent's successful `activate_card` result contains only nested `{card_id,outcome:'blocked',summary,result}` and no duplicated evidence fields or provider prose.
The parent remains active and may re-scope work; there is no replanning cap.

For an ordinary Analyst submission, successful preparation precedes one physical `[activation_open marker, workspace context, user text]` append and publication.
Construction of the bounded Analyst orientation snapshot is part of that preparation and is exact-or-throwing: failure produces no substitute context, ingress, context diagnostic, provider call, or tool effect.
The session then rereads its canonical conversation once and constructs the sole source-identified provider projection; there is no pending-row concatenation or second projection owner.
Preventive compaction runs before the initial provider call and before every continuation whose refreshed canonical projection reaches threshold.
A tool continuation first settles the waiting call, appends its one canonical result, allocates a fresh continuation UUID, rereads canonical history, and retains the same prepared prefix/tool/capacity value.
The newest Analyst round is open; a following exact marker completes the prior round, which changes only compaction eligibility—a closed round and every uncovered summary-only bundle remain fully primary-visible below the trigger until a later successful validated compaction covers them.

An accepted Analyst tool invocation and its external/domain effect occur before the continuation provider seam.
If that continuation receives eligible authoritative context rejection, recovery retries only the same continuation UUID after one strictly reducing compaction: it does not replay or rebroadcast the tool, repeat its result, or append another marker/workspace/user batch.
Successful initial output containing a tool call likewise leaves the recovery seam before the tool runs.
Direct summarizers are the explicit unprepared, nonpersisting exception; each refine call uses the one fixed Registry-validated `summarizer_candidate`, the token limit in the [exact context and compaction limits](#exact-context-and-compaction-limits), a no-tools prose request without an exclusive-tool-choice requirement, the internal compaction-summary evidence identity, and no self-compaction or replay.
Analyst primary and continuation calls use the selected configured global Analyst agent's compiled named route and that route's ordered candidates and failover.

Every settled provider attempt passes through a provider-exchange-specific publication projection immediately before final schema validation and app-log append.
It preserves exact contract/provider/model/account, transport, source-input, attempt/status/time, response, finish-reason, token, terminal-tool, and assistant-output identities.
Request parameters are one closed transport variant: `generic` has the common endpoint/`POST`/stream/tool-count members plus numeric temperature and max tokens; `codex` has only the common members; `openai-responses` adds optional max-output/store/include and exact reasoning-key values.
The HTTP(S) endpoint preserves scheme, host, port, and path while replacing nonempty userinfo, redacting the query as a whole, and removing the fragment.
Error name and numeric status remain exact; only error message is classified prose.
Unknown transport members and invalid endpoints fail rather than entering generic recursion.
Logged events and control actions likewise pass through their discriminated projectors before app-log append and again on public read: event/action/target/actor/surface and contract-state identities remain exact, event/control prose redacts, `contract_response_violation` directly preserves operation/status/failure-code, and `invalid_enum_value` preserves field while projecting only its rejected value as opaque.
This publication projection does not mutate in-process attempts or effects, and generic app-log persistence selects no redaction behavior.

## 11. API And Operator Projection

REST remains authoritative.
Application bootstrap owns only the initial runtime/project read and the sole ordinary root card-hierarchy request; it performs no Agent, event, error, process, graph, doctor, or MCP read.
The persistent Analyst panel owns its exact mounted chat resources independently.
Token identity change resets CardStore, aborts its hierarchy/detail/history requests, and performs the ordinary root load under the new identity.
`/api/state` contains no card inventory, `cardIndex`, status/type totals, or hidden card traversal.
Operator projections and disposable reader-local indexes never authorize writes or persist beyond their owning read.

### Exact shared operator error contracts

<!-- saivage:value-contract:operator-error-contracts:start -->
```text
error.analyst-turn-busy = {"strict":true,"variants":[{"fields":{"error":{"kind":"literal","value":"analyst_turn_busy"},"message":{"kind":"literal","value":"Another Analyst turn is active. Retry after it finishes."}},"strict":true}]}
error.unauthorized = {"strict":true,"variants":[{"fields":{"error":{"kind":"literal","value":"Unauthorized"},"statusCode":{"kind":"literal","value":401}},"strict":true}]}
error.unexpected-internal = {"strict":true,"variants":[{"fields":{"error":{"kind":"literal","value":"InternalServerError"},"message":{"kind":"literal","value":"Internal server error"}},"strict":true}]}
```
<!-- saivage:value-contract:operator-error-contracts:end -->

Bootstrap additionally owns the focused content-policy-store read.
Authenticated `GET /api/runtime/content-policy` directly invokes persistence-owned linked history traversal.
Starting at exact `project`, it reads and validates each reached stream exactly once, follows only current committed child IDs after parent/namespace proof, includes a reached tombstoned card but never descends through it, and neither enumerates nor calls ancestor-rereading public readers.
Request-local artifacts pair each resulting card version with that version's associated history and numeric version; `history.snapshot` is the prior card and is never resulting state.
`refusal_high_water` counts every retained pair whose history is terminal and resulting card is blocked with the typed refusal result, including reopened versions and reached tombstoned cards.
`blocked_at` is terminal `history.changed_at`, not null `completed_at`; latest is the final ascending `(changed_at,card_id,version)` item.
Malformed canonical data fails the request.
No counter, cache, registry, timer, watcher, polling, or persisted projection exists.
Initial load, every accepted card invalidation, reconnect, and auth reset/refetch refresh this store through epoch/AbortController single-flight ownership.

The operator card representation is current strict card state plus operator actions and the pure card-only summary; it contains no backend `logical_path`, authored content, or pending-notification field. Analyst create/reopen CardView results and ordinary immutable card artifacts use the same strict queue-free card projection. Planner reopening instead returns only its queue-free `{card_id,status:'changed'}` success data.
Its typed projection treats `title`, every lifecycle result `summary`, blocked `resume_reason`, lifecycle `error`, `operator_summary.error`, and `status_text` as prose.
Card, child, and dependency IDs, allowed actions, status/type/result/action/blocker discriminants, timestamps, and other public structural scalar/null fields remain exact even when credential-shaped.
The same classification is used by `cards.get`, the parent and every child from `cards.children`, card tools, immutable card-version artifacts, and field-directed diffs; unknown diff fields fail rather than receiving opaque projection.
Its `allowedActions` values derive from the canonical action schema and an operator-only action projection, not mutation admission for runtime roles.
The action vocabulary is exactly `card.start`, `card.create`, `card.cancel`, `card.delete`, and `card.reorder_child`; `card.start` applies only to backlog, changed, and stopped, so blocked cards neither start nor restart through this projection.
Operator projections do not advertise `card.create`, `card.reorder_child`, or `card.restart`.
The hierarchy operation is `GET /api/cards/:id/children`, returning the requested active card and only its active immediate children in committed parent order.
Retained tombstone links are read and omitted, and traversal stops there.
`GET /api/cards/:id` returns only selected current detail.
Card-version history is separate: `GET /api/cards/:id/history` returns ascending items exactly `{entry_id,version,published_at,artifact_kind,change}` with `card_id` and `total` in the outer response; `GET /api/cards/:id/history/:version` returns outer `{card_id,version,entry_id,published_at,artifact}` where the artifact is exactly `{kind:'card-version',card,change}` or `{kind:'card-tombstone',final_card,change}`; and `GET /api/cards/:id/diff` compares explicit resulting versions or one version to current.
History listing projects rows from the card fold, while selected content/diff selects the exact requested row sides and never substitutes another version.
Current authored Records are a separate exact resource and do not expose authored-record history through card-version routes.

Every public history `change` slot is required and nullable. A non-null value is exactly `{summary,changed_fields,actor}`: summary is nonempty redacted ordinary prose, changed fields use the finite ordinary vocabulary `title`, `priority`, `urgency`, `lifecycle`, `status_text`, `status_text_updated_at`, `child_membership`, `active_child_order`, and `deleted`, and actor is the recorded update/delete agent name or null. Initial and queue-only publications use null. Mixed status/terminal publications expose only ordinary metadata; terminal summary text is rebuilt from ordinary changed fields, while result prose remains in the queue-free snapshot. Public metadata contains no durable kind, reason, surface, terminal-summary object, repeated identity, or repeated time. The durable change envelope, eight kind discriminants, provenance, summaries, resulting-version linkage, and time validation remain unchanged; the legal update fields are now only title, priority, and urgency. Agent `list_card_versions` carries the same required nullable change; `get_card_version` retains its existing card/version/entry/publication/artifact-kind/hash/section locator fields without repeating metadata in sections; and agent diffs retain their existing pivots, side entry/hash identities, observation, and sliced diff. Agent artifact hashes cover the queue-free `{kind,card,change}` or `{kind,final_card,change}` artifact, matching the selected REST artifact, and no public card diff row may name `pending_notifications`.

Ordinary card query surfaces provide no explicit queue collection, count, membership, IDs/bodies, availability field, direction discriminator, or delivery receipt. Generic version/time/diff/invalidation observations may signal or support inference of hidden queue activity and are not a supported queue query. This structural guarantee includes current/history/version, card diffs, Analyst create/reopen results, Planner reopen results, and Files; explicit enqueue attempts/results, delivered context, and opaque retained conversation evidence are excluded.

Every successful card-diff response contains a strict `diff` array whose rows are exactly required `{field,before,after}` objects.
`field` is a nonempty string; `before` and `after` are both present and each is recursive JSON: null, boolean, string, finite number, an array of recursive JSON values, or a string-keyed object of recursive JSON values.
Missing members, additional row properties, undefined values, non-JSON values, and non-finite numbers fail the contract.
The one shared row schema validates the backend's final projected response and the browser's declared status-200 response before CardStore admission.
Malformed valid JSON at declared status 200 is therefore a contract/protocol failure, not validated API error data or an `OperatorApiError`.

Operator egress projects granular Card resources source-adjacently and uses a small source-tagged owner dispatcher for provider exchanges, logged events, control actions, card diffs, effective config, process views, tool invocations, Agent conversations, strict server-egress WebSocket envelopes, and MCP tools. Card history artifacts use their direct outbound-card projector rather than a generic history redaction branch.
Webfetch argument projection belongs to the singular tool-invocation owner, and webfetch results use that owner's generic opaque-result projection; neither has an independent dispatcher branch.
A separately selected `dynamic` branch is available only for owner-classified opaque leaves.
Complete known owners never enter recursive credential guessing: identities, discriminants, topology, counts, timestamps, booleans, nulls, and canonical non-webfetch URLs are copied by their owner, while only classified prose, secret containers, URLs, and opaque payloads are transformed.

The invocation owner recognizes the identities and relations in the architecture's [exact shipped tool identities](../architecture/system-architecture.md#exact-shipped-tool-identities).
Each retains direct valid-argument classification for complete live invocations and canonical call rows.
Call rows never gain a result and result rows never gain arguments.
A structurally valid failed call remains readable when its identity is unsupported, its argument string is malformed JSON, or a known tool's parsed arguments fail its schema: unsupported/schema-rejected values project only that opaque value, malformed raw arguments receive text defense, and exact invocation identities remain unchanged.

Durable tool results have one strict generic envelope: `{success:true,data?:unknown}` or `{success:false,error:string,data?:unknown}`.
The optional data is opaque persisted JSON and historical projection never validates it against the current named tool implementation.
Known and unsupported result rows use the same shape-independent recursive outbound redaction for data and error; there is no result-side tool-name switch.
Historical Analyst list arrays, bounded session wrappers, earlier raw glob/grep match arrays, plaintext collection JsonSlice bodies, and earlier `emit_result` data therefore remain valid because they satisfy the current `unknown` field, not because of a compatibility reader or legacy-shape branch. They are not rewritten, decoded, retroactively bounded, or granted the current hex reconstruction guarantee.
Current producer correctness is separate and source-owned; this does not add output schemas to `ToolDefinition`, ordinary invocation, MCP, or provider contracts.
Navigation is an executable browser effect over that opaque data: only a successful `navigate_workspace` or `navigate_back` result whose data strictly satisfies the shared workspace-navigation intent contract and whose intent exactly matches the invoking tool is admitted to route application.
Malformed or cross-wired successful navigation data fails before any route effect.

`reconfigure` is a closed restart-only union: `set_agent_model_route` accepts one existing agent and existing route; `set_model_failover` accepts one known source model and duplicate-free ordered known models; and `set_server_setting` has strict host and positive-port variants.
The complete candidate is structurally compiled before file replacement.
Success returns `requires_restart:true` and does not mutate current workflows, routing, tools, MCP, or listener state.
Deleted role, runtime, and MCP mutation actions are schema-invalid.

Effective configuration has distinct strict internal and outbound contracts.
Source YAML carries the optional `card_types` map; after `ResolvedConfigAuthority` resolves it, internal and outbound contracts contain the complete effective `card_types` map and no source-only form.
The one typed outbound projection preserves namespace keys and ordinary model/profile/failover/provider/account/capability/process/auth-reference values, structurally omits provider and account `baseUrl`, replaces provider and account `apiKey` values, replaces every stdio MCP `env` value regardless of key spelling, and retains each streamable-HTTP MCP `url` only after `redactUrl` removes userinfo credentials, query contents, and fragments.
REST config, `show_config`, invocation results, and Files selected-config preview share that effective projection; none merges source and effective shapes or exposes a set-selection API.
Files identifies the startup-selected config by admitted lexical path or resolved real target, including custom paths and aliases, loads the effective config, and serializes it without a second text pass.
Every other admitted `work:///` text preview, including process logs and webfetch `content_url` output, receives text defense and sensitive-redacted metadata; normal denial, containment, binary, size, listing, and card behavior is unchanged.

`GET /api/mcp/tools` returns the one displayed hierarchy: ordered servers with name, transport, status, tool count, and ordered tools carrying name and direct invocation statistics.
It omits integration errors, descriptions, schemas, annotations, `_meta`, duplicate flat tool/server arrays, and a duplicate keyed statistics map.
Browser totals derive only from this hierarchy.
The obsolete `mcp.status`, `runtime.cardRuns`, and `processes.get` operations do not exist; callers use runtime status, the process list, and the MCP tools hierarchy.

For target depth `d` with root depth zero, active detail, hierarchy, and current records require an active target.
History list, exact history entry, and diff instead prove one committed target path: a tombstoned final target is permitted, a tombstoned ancestor blocks access, and the catalog, exact row, both diff pivots, and terminal current head are selected from one fold.
Each direct detail or historical operation reads exactly `d + 1` card streams, with the target once and zero authored streams.
Hierarchy adds one read for each committed immediate-child ID, including an omitted tombstone.
A current authored-record operation uses the path reads plus exactly one requested record stream; all-declared metadata uses one path proof plus one attempt per declaration.
These operations derive exact namespaces and record paths from compiled definitions without sibling enumeration; unrelated and unrequested streams are not inspected.

Card history and diff use the [exact backend card history and diff contract](#exact-backend-card-history-and-diff-contract).
HTTP syntax validation returns 400 before handler/read-model or persistence work.
Tool JSON, direct application/read-model, and CardService/domain boundaries independently reject zero, negative, fractional, non-finite, or unsafe supplied numbers before exact path/history reads.
A direct operator read-model rejection uses that operation's declared `ValidationError` 400 envelope with the exact `seq`, `from`, or `to` issue path.
Valid resolved `from > to` remains the separate semantic 400.

### Exact backend card history and diff contract

<!-- saivage:value-contract:backend-card-history-diff:start -->
```text
error.cards-history-404 = {"strict":true,"variants":[{"fields":{"cardId":{"kind":"schema","name":"cardIdSchema"},"error":{"kind":"literal","value":"Card not found"}},"strict":true},{"fields":{"error":{"kind":"literal","value":"historical_version_not_found"},"owner_id":{"kind":"schema","name":"cardIdSchema"},"resource":{"kind":"literal","value":"card"},"version":{"kind":"schema","name":"HistoricalVersionSchema"}},"strict":true}]}
error.cards-diff-404 = {"strict":true,"variants":[{"fields":{"cardId":{"kind":"schema","name":"cardIdSchema"},"error":{"kind":"literal","value":"Card not found"}},"strict":true},{"fields":{"error":{"kind":"literal","value":"historical_version_not_found"},"owner_id":{"kind":"schema","name":"cardIdSchema"},"resource":{"kind":"literal","value":"card"},"version":{"kind":"schema","name":"HistoricalVersionSchema"}},"strict":true}]}
pivot.cards-diff-from = {"field":"from","mapping":"fromVersion","presence":"required","refinement":"positiveSafeIntegerSchema.safeParse(Number(raw)).success","regex":"^[1-9][0-9]*$","transform":"Number","variants":[{"kind":"canonical-positive-safe-integer"}]}
pivot.cards-diff-to = {"field":"to","mapping":"toVersion","meanings":{"current":"current-artifact","numeric":"historical-version","omitted":"current-artifact"},"presence":"optional","refinement":"positiveSafeIntegerSchema.safeParse(Number(raw)).success","regex":"^[1-9][0-9]*$","transform":"Number","variants":[{"kind":"literal","value":"current"},{"kind":"canonical-positive-safe-integer"}]}
```
<!-- saivage:value-contract:backend-card-history-diff:end -->

CardStore keeps hierarchy slices, selected detail, and selected history as disjoint authorities: only a children response can install its complete parent slice, and only detail can install selected detail.
Completion order never merges them.
Each parent key has at most one exact in-flight owner object; same-parent callers share that object's promise.
Success, failure, finalization, and owner removal may update state only while that exact object remains current.
Reset aborts and clears owner objects before hierarchy state, so an old completion cannot install state or remove a later owner.
Route reveal has separate action-local monotonic ownership: after every await and before a later ancestor request, a superseded invocation stops.
Supersession never aborts shared `ensureChildren()` work, changes its keyed owner, installs or invalidates a slice, or grants persistence/currentness authority.

Files has exactly two concerns: a pre-generic admission/classification gate, followed by either the generic read path or the canonical-card virtual read model.
For an ordinary project spelling, the gate performs decoded traversal rejection and lexical derivation/outside-root rejection, lexical blocked-source admission, lexical card reservation, and then bounded symlink classification for an allowed lexical non-card source.
POSIX backslash is an ordinary filename character, not a card-grammar separator.
For `work:///`, existing parse, query/fragment rejection, exact canonical round-trip validation, project-relative `.saivage/work` derivation, and traversal/outside-root checks precede the same lexical blocked-source, reservation, and allowed-source symlink stages. Directory and metadata reads represent the exact admitted `.saivage/work` root as `work:///`; descendants retain canonical single encoding, including spaces, literal percent signs, and Unicode. `#` and `?` remain unrepresentable path characters, and raw query or fragment syntax remains rejected by the work resolver.
A lexically blocked explicit source returns 403 and a blocked listed child is omitted; both stop before any classifier `lstat`, `readlink`, or card-target I/O, even if the source aliases into cards.
A canonical project card spelling dispatches virtually.
Any allowed non-singular project spelling that normalizes into cards, any allowed card alias, and any allowed validated-work spelling or alias that enters cards is reserved but opaque as 404 for an explicit request or omitted from a listing; no generic fallback follows.
The classifier is request-local and bounded, grants no read authority, and its expanded result is never used for content.
A conclusively non-card result enters the generic resolver, which still applies blocked policy to both the lexical identity and any resolved in-project real-target identity before metadata, listing, or content I/O.
Thus a generic alias to a blocked real target remains 403 or omitted.
After those policy decisions, the generic resolver performs one direct metadata stat of the requested target: exact `ENOENT` alone is the existing 404, while every other metadata error reaches the ordinary opaque server-failure boundary.
During listing, child admission, reservation, containment, and blocked checks likewise precede metadata; exact `ENOENT` from a reached child's stat is the sole disappearance-race omission, and every other reached-child metadata error fails the request rather than returning a partial snapshot.
Direct outbound redaction remains post-read and applies when either admitted identity is explicitly redacted.
Canonical `work:///` response spelling and VFS behavior remain unchanged.

The virtual grammar is closed:

```text
cards-root      := .saivage/cards
card-namespace  := .saivage/cards/project ( /children/<segment> )*
children-dir    := <card-namespace>/children
artifact-file   := <card-namespace>/card.json[?v=N] | record:///<name>?card=<card-id>[&v=N]
```

Each segment and the derived stable ID must satisfy the [exact card identity contract](#exact-card-identity-contract).
No conversations, physical streams, physical conversation indexes, version directories, UUID filenames, or arbitrary descendants are exposed.
An active namespace returns virtual `children`, `card.json`, and present configured record URLs in declaration order; a missing optional record stream is omitted.
As a Files-only current-head exception, a directly addressed retained tombstone returns only its terminal `card.json`; explicit `card.json?v=N` selects from the same committed history catalog.
Neither form grants records, children, active-card access, or descendant access through that tombstone.
Child listing reads each membership fold once, emits live entries in filtered `active_child_order`, and never enumerates a physical directory.

Every virtual operation first proves the real configured project root and exact `.saivage`, `.saivage/cards`, and actually reached linked card namespace directories.
Each must be a contained real directory, not a symlink.
Parent linkage is validated before any child namespace probe; a missing link is 404 without child access, whereas a linked missing or invalid namespace is a server failure.
The operation never enumerates siblings.
Final canonical stream reads use one read-only `O_NOFOLLOW | O_NONBLOCK` regular-file descriptor and never truncate.
Ancestor `lstat`/`realpath` proof and the later final-descriptor open are ordered but non-atomic because the supported Node synchronous API has no descriptor-relative traversal.
The contract does not claim protection from a hostile concurrent ancestor replacement; it adds no lock, retry, reconciliation, or currentness protocol.
Final-component replacement after open cannot redirect work from the opened descriptor.

Card-namespace listing reads canonical card streams required for linked reachability, then projects present configured record descriptors from their validated record-stream folds without reading record content separately: the current row's effective-content UTF-8 byte length is the reported size, and its draft `updated_at` or accepted `committed_at` is the modified time.
A missing optional record stream omits that non-bootstrap record; a missing bootstrap record stream and every malformed, empty, or unreadable reached stream fail the listing.

Explicit content is selector-bound and strict.
`card.json` returns the last row's projected document; `card.json?v=N` returns exactly row N's document from the same validated fold. An ordinary version document is exactly `{format_version:3,kind,entry_id,card_id,version,published_at,card,change}`; a tombstone substitutes `final_card` and retains `prior_card_version`. The required nullable change is the same ordinary-only projection used by history and artifact hashes; these wrappers retain publication identity/time and contain no pending-notification field.
Record URLs use current or exact `v=N` row selection.
Virtual document bytes are produced once by the Files read model from the selected semantic artifact: listing size, preview admission against the 1 MiB limit, response content, and a successful preview's reported size are all the exact UTF-8 byte length of those selected-document bytes, and `modifiedAt` is the selected artifact's `committed_at`.
Appending unrelated history therefore cannot change an older selected document or cause a 413, and listing and current preview agree deterministically.
Physical `.jsonl` streams, their byte counts, and their mtimes are opaque to Files.
Complete malformed, empty, or unreadable card/record stream state fails the request through the ordinary server-error boundary; only a syntactically valid absent numeric version is the exact not-found variant.
There is no scan, request-time correction, cache, repository, or physical fallback.

The UI displays title/hierarchy labels and preserves immutable hierarchical card links.
It exposes Stop project with delegated `contained:true` and no-runtime `contained:false` results; concurrent application close joins the same halt rather than returning a conflict.
Restart server appears only when required `restart_server_available` is true and requires confirmation.
No UI action optimistically writes a running card cancelled.
Public conversation reads project compacted genesis separately from entries rather than returning durable compaction JSON verbatim. The strict projection intentionally mixes naming: disposition and coverage commitments use their declared snake_case wire keys, required-model-fact members retain their declared camelCase keys, and inherited-continuation activation uses its declared snake_case keys. Projection is explicit at this owner boundary; no recursive key conversion occurs.
Files route schemas, authorization, and client presentation remain unchanged; canonical card traversal is the virtual behavior above rather than generic physical browsing.

## 12. Reset And Failure Consequences

Incompatible changes to hierarchical card layout or durable shapes, deterministic child claims, exact card/record append-only streams, terminal card tombstones, complete parent-owned membership/order, self-contained current record rows, and indexed conversation segments are reset-only durable-format cutovers. Card stream v4/artifact row format 3, which removes Card `tags` and `related`, is such a cutover.
Notification query-surface removal and current-activation enqueue admission change no durable format. They require no reset, migration, prompt rematerialization, or special deployment operation; existing materialized prompts remain instance-owned.
The current widening of the unchanged card-ID field grammar from the former bound of five to the maximum in the [exact card identity contract](#exact-card-identity-contract) is instead a same-format forward deployment: every previously valid ID remains valid, so deployment requires no reset.
Once a deeper card is created, an old binary cannot read that state and must not be used against it.
Old or mixed structural formats are rejected and never migrated or accepted as current.
An incompatible durable-format cutover requires stop, current-built wholesale reset, and start; same-format retained state must already satisfy the exact current stream contract. The bounded participating card-agent, selected-Analyst, and existing workflow-state identity cutovers specified above are also reset-only after generated work exists, despite not changing a storage schema. The lazy Oversight qualification remains unchanged.

The content-policy retry/refusal conversation kinds, typed refusal BLOCKED lifecycle result, and required error-exchange `terminal_conversation_output_id` are also named reset-only durable-format changes.
The conversation-context compaction cutover—typed context blocks with the immutable activation prefix and compiled invocation tool contracts, append-order tool call/result policy with per-surface evidence templates, the bounded Analyst orientation snapshot, the bounded discovery/read/version surfaces, and the accumulated-history compacted-genesis schema with validated coverage, fixed-size commitments, required-model-fact slots, and open-round inheritance—is likewise a named reset-only durable-format change.
The process-result payload cutover from metadata-only process results to the current strict inline-head/completeness shape is independently reset-only. Retained conversations must carry current process payloads even when both releases otherwise use conversation index/genesis/envelope format 2 and card stream v4/artifact row format 3; matching those outer formats alone does not establish compatibility. There is no old-shape reader, migration, normalization, or retained-row rewrite.
When applying an applicable reset-only cutover, keep the exact service stopped and positively verify no owner/process; obtain explicit authorization for irreversible loss of generated cards, records, conversations, logs, and work artifacts; create and retain a successful full stopped target-project backup; preserve configuration, credentials, project identity, operator inputs, prompt overrides, skills, instructions, source, and canonical project documentation; then run the positively identified matching current build's reset over all four generated roots and start and verify that same build. Plan or deployment approval, backup existence, and startup rejection are not destructive authorization. Reset does not preserve generated history, prove the cause of a missing index, retire an old identity, or imply that no earlier lock, input-materialization, identity, bootstrap, or publication effects occurred.
Test and E2E generated-state fixtures use only this singular current format; omitted old fields, old blocked/tool shapes, mixed streams, compatibility readers, migrations, normalization, and backfill are unsupported.

Initial publication is separately forbidden whenever any of the four exact generated roots remains without a valid canonical project card.
Every exact-path object is an obstruction; Saivage does not inspect whether it is empty, complete, repairable, or directory-shaped.
The failure names the first blocking exact path and directs the operator to keep Saivage stopped and follow the authorized current-build whole-generated-state reset procedure before retrying; the failure itself is not destructive authorization.
Neither `init` nor `start --create-runtime` repairs, adopts, combines with, or selectively deletes retained state.

Reset first acquires the exact `.saivage/locks/runtime.lock`; every pre-existing exact lock blocks the command before deletion.
While retaining its acquired lock, reset recursively force-removes exactly `.saivage/cards`, `.saivage/agents`, `.saivage/logs`, and `.saivage/work` as whole trees, without probing or enumerating their descendants, then publishes a new canonical `project` root card and releases only its exact lock.
Every path outside those four roots is preserved, including configuration, credentials, project identity, operator inputs, source, skills, instructions, and canonical project documentation.
Reset never inventories or cleans lock siblings or other noncanonical paths.
Incomplete namespaces and publication temps require no action.
Malformed exact canonical targets require operator repair or reset.

File persistence provides no no-data-loss guarantee.
Interrupted external effects may repeat, notification context may duplicate, process-local availability resets, concurrent auth refresh may overwrite credentials, and orphan files may remain permanently.
## Publication outcome-unknown fatal boundary

Every Saivage-owned durable replacement, JSONL append, owning-reader suffix truncation, lifecycle-lock publication, process-output append, and work-artifact replacement classifies failure at its direct syscall boundary.
Preparation and safe acquisition failures remain ordinary.
Once canonical mutation is attempted and its result is unknown, the owner throws `PublicationOutcomeUnknownError`.
The first actor, Analyst, WebSocket, process-callback, server, startup, direct-mutation, or CLI boundary writes exactly one credential-free line to process stderr synchronously and exits with status 1. The line contains the fixed fatal sentence followed, when the direct syscall cause was captured, by ` Cause: ` and that cause's message, including the ordinary errno, syscall, and path detail carried by Node filesystem errors.
It performs no logging, response conversion, card settlement, process cleanup, descriptor cleanup, retry, inspection, or lifecycle-lock release.

Replacement becomes uncertain at rename.
JSONL append-open `ENOENT` remains the explicit `missing` selection result; process-output append-open `ENOENT` is an ordinary exact-file error.
Truncation becomes uncertain at `ftruncate`.
Successful exclusive lifecycle-lock creation is a known empty canonical namespace effect; subsequent record publication uncertainty leaves it for fail-closed manual repair.
The storage ceiling permits repetition only for a first-write `EINTR` proving zero transferred bytes. Node/libuv handles interrupted writes below JavaScript, so Saivage does not retry a thrown write; positive short writes continue with only the unsent suffix.

Captured process output is synchronously appended one chunk at a time without retained writers or descriptors.
Terminal process presentation and successful termination results require both registry-confirmed group absence and stdout/stderr readable drain; failed or unconfirmed groups are not awaited.
The runner immediately observes each original terminal-settlement rejection while retaining that same rejecting promise for later identity-preserving delivery. Raw readable errors and ordinary append-open failures therefore cannot become an unhandled rejection merely because a background launch has no current waiter. A later terminal wait, including timeout zero against an already-terminal record, and direct-scope closure still receive the original error. Process-output mutation uncertainty remains the fatal boundary above and is not converted into capture failure.

This fatal exit occurs before Supervisor halt or runtime-status mutation.
Ordinary Stop, application close, actor-main failure, and containment failure retain the existing `closing -> stopped | error` contract.
A genuinely new process follows the existing strict canonical startup and explicit Run full-chain recovery procedure: conversation stabilization and append-only `stopped` correction remain best-effort and lossy, complete malformed rows fail, and another publication-unknown failure exits again without retry.

## Appendix: cutovers and recent contract changes


## Named-Agent Workflow Cutover

The selected strict YAML chooses card-type definitions through exactly one source form: a complete `card_types` map, or omission of `card_types`, which selects the bundled `classic` definitions.
The deleted `card_type_set` selector key fails strict source validation as an unknown key; it never defaults, falls back, or merges with an explicit map.
`saivage init [--profile <classic|classic-typed>]` materializes the complete selected system template on a config-absent project: the template's full prompt tree into `.saivage/config/prompts`, a provenance marker into `.saivage/config/template.json`, and the complete config YAML—containing its explicit `card_types` map—published last as the single configuration-materialization completion commit. This input publication is separate from generated-state admission and does not make retained generated work compatible with the materialized identities.
An existing `.saivage/saivage.yaml` gates the whole template/config materialization: `init` preserves the prompt tree, marker, and YAML, and `--profile` is inert.
After successful init the instance is the single runtime authority; templates are materialization data and are never consulted at runtime. Template provenance is not authority for the effective identities that produced retained generated work.
`ResolvedConfigAuthority` resolves the source once to a complete effective `card_types` map before structural compilation.
All compiler, runtime, REST config, `show_config`, and selected-config Files consumers receive only that singular effective map.

The selected strict YAML is structurally compiled before any generated card publication.
Structural compilation validates every configured card-type workflow, exact named-agent/model/skill/session references, resolves every ordered operational tool through the exact global/card catalog scope, and freezes each route/profile plus array-form equivalence and direct-failover expansion as `orderedModelIds`; it also validates child narrowing, record/bootstrap definitions, local source-node terminal exports, graph reachability, `latest_node` existence/path, and every selected agent/process prompt.
Prompt roots mirror `agents|process|fragments/<card-type|_shared>/<reference>.md`; project card-specific, project shared, bundled card-specific, then bundled shared is the exact root-major order, and only exact absence advances.
Agent filenames use the configured prompt reference; the global Analyst uses shared scope only.
Direct `&#123;&#123;> fragment-id&#125;&#125;` inclusion is one level, uses the host card type, and is validated under the host policy.
Each shipped Planner, Executor, Reviewer, and Analyst agent prompt directly includes `project-guidance-common` and its matching role fragment. These hooks compose only when that selected prompt contains them: custom prompt references and full overrides are not automatically modified or required to include them, and the Analyst remains shared-scope only.
Workflow-agent system prompts require `&#123;&#123;contractDescription&#125;&#125;` exactly once after composition; process prompts allow only `&#123;&#123;cardType&#125;&#125;`, render eagerly, and are frozen as final text.
Startup discovers the selected Analyst and distinct card agents directly from the singular state tables, then installs one immutable `agentBindings` map before actor construction.
Each installation resolves only its explicit model IDs through the Provider Registry and retains its exact capability request: complete card surfaces include generated `emit_result` last and require tools plus exclusive choice, while Analyst has only its operational surface and may retain no-tools plus exclusive choice.
Provider admission consumes that retained request unchanged.
Real turns bind only selected invocation-scope executor/cleanup closures.
Offline `init`, `reset`, and `start --create-runtime` use only the same structural compiler and never reconcile MCP or require live provider availability.
Offline `init` additionally materializes the selected template's complete prompt tree and provenance marker before publishing the config YAML last; the copy skips already-existing destination paths, so a crashed config-absent materialization attempt can be completed by re-running `init`, while an existing config preserves the tree, marker, and YAML bytes exactly. If generated work already exists, that retry still undergoes strict current-state admission and is not an identity-changing upgrade or repair.
`reset` and `start --create-runtime` materialize nothing.
Actors receive only the bound artifact and perform no source-config, prompt, route, capability, or tool selection.

`models.equivalents` is optional and defaults to `[]`; when present, it is exactly an array of string arrays.
Mapping/object forms and malformed members fail selected-YAML validation as a complete input and are neither rewritten nor omitted.

The shipped bundled defaults are the two registered system templates `classic` and `classic-typed`; `classic` is the bundled default (the omission `card_types` source and the bundled prompt root), and each template is materialized whole by `saivage init --profile <name>`.
Both are complete definitions containing `project`, `goal`, `architecture`, `code`, `test`, `doc`, `data`, `research`, and `ops`, in that declaration order.
Classic `project` and `goal` use `plan -> optional review -> plan`, `recover` for STOPPED, and a conditional Planner `handle-notifications` node after an accepted Reviewer result when designated-recipient context is pending. The other seven types each use one `execute` node. Planner is the planning-card recipient and Executor is each leaf recipient.
A template is one complete TypeScript-owned config plus its exact prompt closure; its config contains the card types, workflows, and record declarations and does not own or override global agents, `analyst_agent`, model routes, providers, compaction, server, or MCP configuration beyond publishing the template's complete values for them at init.
The resolved effective configuration owns the actual complete map.
A card-type name matches `[a-z][a-z0-9-]{0,63}`; `project` is the sole reserved name, is required as the fixed root entry, and cannot be a child.
Every child reference is unique and names a key in the same map.
Compilation preserves declaration order in one immutable map and one ordered all-key vocabulary.
There is no planning/terminal family or autonomous role classifier.
Nodes reference card-scoped named agents; the configured global Analyst uses one global named session plus explicit parent/card targets.
Creation authority is the named agent's global `can_create_children` and `create_card` ceiling intersected with the selected parent's compiled `permitted_child_types`; activation separately requires `activate_card`.
Default Planner has the exact 21-tool inventory, Reviewer the 12-tool inventory without MCP, Executor the 17-tool inventory with unrestricted configured MCP invocation, and Analyst the 43-tool inventory.
`mcp_tool_call` is the only agent MCP admission; annotations are descriptive only.

In `classic-typed`, `project` and `goal` permit all eight non-root types in declaration order; every other type is a leaf.
`project`, `goal`, and `architecture` declare `brief.md`, `status.md`, and `review.md`; all other types declare `brief.md` and `status.md`.
`brief.md` is always the sole bootstrap record.
The classic-typed configured graphs are:

| Type | Exact configured flow |
| --- | --- |
| `project`, `goal` | Recipient Planner. `plan`: `complete_direct` -> DONE, `admit_review` -> `review`, `blocked` -> BLOCKED, `failed` -> FAILED; `review`: `approved` -> DONE when no context is pending, otherwise accepted `approved` -> `handle-notifications`; `revision_required` -> `plan`, `blocked` -> BLOCKED, `failed` -> FAILED. `handle-notifications`: `admit_review` -> `review`, `blocked` -> BLOCKED, `failed` -> FAILED. STOPPED enters `recover`, which has the same outcomes as `plan`. |
| `code` | `red`: `red_confirmed` -> `green`, `already_green` -> `refactor`; `green`: `green` -> `refactor`, `still_red` -> `green`; `refactor`: `done` -> DONE, `regressed` -> `green`; each node also has configured `blocked` and `failed` terminals. |
| `test` | `diagnose`: `coverage_ready` -> `verify`, `coverage_gap` -> `add-coverage`, `failing_test` -> `repair`; `add-coverage`: `coverage_passing` -> `verify`, `repair_needed` -> `repair`; `repair`: `tests_passing` -> `verify`, `still_failing` -> `repair`; `verify`: `done` -> DONE, `coverage_gap` -> `add-coverage`, `repair_needed` -> `repair`; each node also has configured `blocked` and `failed` terminals. |
| `research` | `explore`: `evidence_ready` -> `assess`, `more_exploration` -> `explore`; `assess`: `supported`, `refuted`, or `bounded_inconclusive` -> `report`, and `evidence_gap` -> `explore`; `report`: `done` -> DONE; each node also has configured `blocked` and `failed` terminals. |
| `data` | `schema`: `schema_ready` -> `validate`; `validate`: `valid` -> `implement`, `schema_invalid` -> `schema`; `implement`: `done` -> DONE, `implementation_retry` -> `implement`, `schema_revision` -> `schema`; each node also has configured `blocked` and `failed` terminals. |
| `architecture` | Recipient Executor. `draft`: `ready_for_component_review` -> `component-review`; `component-review`: `approved` -> `system-review`, `revision_required` -> `draft`; `system-review`: `approved` -> DONE when no context is pending, otherwise accepted `approved` -> `draft`; `revision_required` -> `draft`; each node also has configured `blocked` and `failed` terminals. A notification return must repeat component and system review. |
| `doc`, `ops` | One `execute` node: `done` -> DONE, `blocked` -> BLOCKED, `failed` -> FAILED. |

Typed research treats `evidence_ready` as readiness to assess the bounded question, including reasonably exhausted or inconclusive investigation, rather than support or exhaustive coverage. A return to exploration requires concrete obtainable evidence or materially different useful analysis capable of changing the assessment; exhausted uncertainty normally reaches an honest bounded-inconclusive report. Completing that report completes only its bounded research deliverable: unresolved questions, limits, required exhaustive follow-up, and actionable handoffs remain explicit, with no implied evidence promotion, policy approval, parent completeness, or project acceptance. An accepted brief remains authoritative; a required deliverable that cannot proceed without specific scope, input, or a decision uses the existing blocked route rather than being silently narrowed.

Typed data validation distinguishes correct rejection of invalid samples from a schema defect and technical acceptance from owner or policy approval. Only an actually mandatory missing decision or input blocks; ordinary engineering and accepted graph nodes require no new human signoff. Across both templates, shared Executor guidance interprets completed process status together with relevant output, preserves earlier failed or unresolved checks despite a later successful tool call, and reuses still-applicable evidence while rerunning after relevant changes, for current requirements, or to resolve an open verification question. Required validation is never waived; typed refactor may reuse recent valid focused evidence after a reasoned no-change decision unless current criteria require a rerun.

Typed test diagnosis classifies adequate meaningful coverage plus passing focused tests as `coverage_ready`, including on fresh entry or re-entry after interruption. That route requires no manufactured test, source, or metadata change: it reuses `test-to-verify` and enters the existing `verify` node, which owns affected-suite and coverage acceptance and remains the only node that can complete the test card successfully.

All classic-typed non-planning entries begin at the first node shown; STOPPED adds `stopped-recovery`.
Node IDs use the exact lowercase hyphenated form, notably `handle-notifications`, `add-coverage`, `component-review`, and `system-review`; underscore-bearing outcome IDs remain exact outcomes rather than node IDs.

Classic-typed planning reuses existing immediate children rather than duplicating them.
Planner may notify and activate BACKLOG, CHANGED, BLOCKED, or STOPPED children through their matching entries.
`edit_card` is only for a genuine immediate-child metadata change to `title`, `priority`, or `urgency`; it cannot edit a brief, dependency, parent, type, or lifecycle and is not a generic reopen.
An owning Planner with the configured card-scoped `reopen_card` capability may reopen only its exact DONE or FAILED immediate child through `reopen_card({card_id:"<id>"})`; success changes only that child to CHANGED, after which notification and activation remain separate ordinary operations.
A BLOCKED child normally needs only Planner notification and activation. CANCELLED never reopens.
The distinct global Analyst operation retains `reopen_card({cardId:"<id>"})`: while intervention-ready it may target BLOCKED, DONE, or FAILED work and applies the existing target-to-ancestor changed propagation and notifications. The two scoped contracts share a tool name but are not aliases or interchangeable authority.

Both shipped templates use one shared Planner instruction for `project` and `goal`, interpreted against the frozen card-type context supplied at invocation. At `project`, Planner owns the coherent strategy for carrying the owner's complete objective to evidenced acceptance: it maintains coverage, assumptions, risks, dependencies, integration, progress, remaining work, and acceptance evidence through the existing `brief.md` and `status.md` records. The owner's outcome and acceptance remain stable unless the owner changes them. At `goal`, Planner owns local decomposition, ordering, coordination, and repair within the delegated outcome and reports evidence and genuinely cross-scope implications upward; routine local choices do not require root approval.

Goals may add planning value for uncertain or evolving work, several coordinated deliverables, or decisions that should remain outside root context, including serial workstreams; independent review and parallelism are benefits rather than admission requirements. A bounded defect with implementation and regression coverage can remain one terminal assignment, and a small project or isolated bounded crosscutting assignment may use direct root leaves. Planner direct work remains coordination, investigation/evidence assessment, and permitted record work rather than Executor implementation, build, or test work.

With an explicit rationale, Planner may use its existing `cancel_card` tool for an abandoned, superseded, or unproductive direct-child approach only when that makes the work obsolete or explicitly rejected and current tool and lifecycle admission permits cancellation; cancellation is not scheduling deferral. Cancellation is terminal, cannot be reopened, and does not satisfy dependencies requiring DONE, so it must preserve honest status and outstanding acceptance and must never hide failed tests or unfinished obligations.

Planner reflects purposefully when child results, review findings, blockers, or meaningful new evidence arrive: it treats findings as evidence rather than blindly adopting a suggested remedy, retains sound direction and useful evidence, changes tactics or strategy only when facts warrant it, and never replans ceremonially or claims completion against uncovered acceptance. It distinguishes research delivery, implementation, evidence promotion, and project acceptance, compares specification requirements with card- or agent-introduced sequencing, and removes unnecessary local sequencing without lowering acceptance, erasing gaps, or discarding genuine dependencies. Exhaustive obligations remain in planning records and delegated outstanding work; all-goal signoff or exclusion decisions do not block unrelated scoped implementation absent a real dependency. A failed local tactic is not automatically a disproved strategy. A substantively different, evidenced path to the unchanged outcome may use a different goal, but relabeling or cloning failed work and fake metadata edits are forbidden. For ordinary in-scope correction, the owning Planner reopens the same DONE direct child, queues concrete corrective context, and activates it; a FAILED-child retry requires material new diagnosis, input, correction, or a justified different route stated in existing status or notification context. A genuinely distinct bounded follow-up may cite the earlier delivery or review without cloning its whole scope. Root reactivates an actionable BLOCKED goal or reopens its own DONE/FAILED goal so that goal's Planner can repair its children; root has no grandchild reopening authority. Planner exhausts reasonable in-scope tools and strategies before blocking. Real owner decisions, unavailable resources or configured capabilities, and materially exhausted strategies are escalated; ordinary correction and routine engineering judgment are not. Existing tool admission remains authoritative: Planner cannot reparent, cannot edit a child's brief or dependencies, and can choose dependencies only among existing immediate siblings at child creation. Fake metadata, pretend credit, weakened acceptance, cancelling failures to hide progress, and bypass of refusal, cancellation, or security limits remain forbidden.

Architecture uses the unchanged shared Reviewer prompt and one declared `review.md`.
Both `component-review` and `system-review` start a clean updated cycle of that record.
Accepted transition context carries immutable `record:///review.md?card=<id>&v=N` evidence with its optional edge prompt; the destination node prompt is supplied separately as the next activation's prepared compiled-node block. Component evidence therefore remains readable after system review opens a newer clean version and revision returns to `draft`.
A revised draft updates cumulative `status.md` and can cite the accepted review version.
Final system approval promotes the latest accepted `draft` result while exporting the current system `review.md`.

Card-type wire schemas validate only that identifier syntax.
Startup resolves every reached active canonical card against the selected compiled map and fails if its type is absent; parent/type admission follows from the reached active parent's compiled workflow. A reached retained tombstone is strictly consumed and terminates traversal before workflow, record, or session admission for that card or any descendant behind it.
The same ordered compiled vocabulary, always including `project`, supplies the Analyst prompt, Analyst `create_card` schema/preflight, both global-Analyst and card-agent `list_cards` schemas, and Planner execution membership.
Analyst `create_card` requires one exact existing parent card ID; omission, `null`, and malformed card IDs fail invocation-schema admission.
Analyst and Planner creation accept type, title, bootstrap content, optional priority/urgency, and optional `depends_on`; Analyst additionally supplies the explicit parent while Planner infers it from the session. Neither creation contract accepts tags or a generic related-card list. Current `get_card` sections are exactly summary, workflow, dependencies, children, and records; immutable `get_card_version` sections are summary, dependencies, and children. `list_cards` filters are exactly status, type, and parent, plus paging controls.
Vocabulary membership is not creation authority: Analyst `project` calls with an explicit parent still reach the one-root domain denial, Planner retains its explicit root denial, and node/parent admission remains later.
The fixed project root is published only by bootstrap and cannot be created by an agent tool.
Planner's wire schema stays a plain string.
`list_cards` rejects an unconfigured scalar or array filter at invocation-schema admission before its shared executor filters cards.
The shipped nine-name prompt and tool schemas remain byte-identical.

Changing templates, replacing an explicit map, adding a type, or changing matching prompt/config inputs requires stop, edit or fresh init, and start. Prompt, model-route, tool, host/port, edge, or outcome changes that retain participating identities are not made reset-only by the identity-cutover contract, although separately specified format cutovers still apply.
After initialization, deliberately renaming, removing, or replacing a participating card agent; changing its scope; changing the selected Analyst; rebinding a reached card workflow node to a different named agent; or renaming, removing, or replacing existing workflow-node/state identities requires an authorized stopped whole-generated-state reset before those new identities are used. This applies to reached active cards, including non-tombstoned DONE or FAILED cards, not merely currently running actors. A wholly new card type, an unused catalog declaration, or another change that does not alter existing participating identities is not prohibited by this rule.
Startup strictly admits retained generated state against the newly resolved effective map. It requires the exact current selected-Analyst index and every distinct node-agent index derived from each reached active card's compiled workflow. Missing expected indexes reject rather than being created; this catches some identity changes and incomplete or lost first publication, but it is not a comparison with prior configuration and does not certify that every identity was retained. In particular it cannot generally detect same-agent node-ID changes or changes whose newly expected indexes already exist.
If a reached active card type is absent, a retained active parent/child relationship is no longer admitted, or a required current session index is absent, startup fails before subsequent shared-admission app-log creation, conversation-tail truncation, and record consumption. Lifecycle-lock publication, configuration/template materialization, project-identity work, and any already completed first publication precede this gate and are not rolled back.
The operator must restore the compatible map or template, or intentionally use the stopped whole-generated-state reset for a fresh history; migration, probing, fallback, aliasing, compatibility reading, normalization, merging, and selective repair do not exist.

The selected Oversight session remains lazy and is not part of this startup required-index gate. Changing a never-used selected Oversight identity that has published no durable conversation does not require reset merely because unrelated card or Analyst history exists. Replacing an Oversight identity that the operator knows has published durable session history is an operator-assessed reset-only identity cutover. Saivage adds no scan, inventory, prior-identity detector, or startup certification for either case.

Bundled prompts live in per-template trees under `src/config/system-templates/<name>/prompts/`.
Packaging compiles each registered template standalone against its own source prompts root, observes the bundled agent, process, and direct-fragment artifacts actually selected, and requires that template's physical tree to equal its sorted compiled closure exactly.
Each template's physical prompt tree is locked to its complete compiler-observed source closure. `classic` contains the five shared agent prompts, including both global hosts, six shared project-guidance fragments, and every shared process prompt selected by its planning, review, notification-handler, recovery, and execution graph. `classic-typed` retains its typed card-specific process prompts and additionally selects the shared notification-handler prompts plus the architecture notification-return prompt.
Startup strictly composes the selected direct hooks and freezes the result. Existing materialized prompt trees remain instance-owned and are not upgraded by `init`; no hook is injected into a custom prompt and no automatic reconciliation occurs.

Prompt scope is a discriminator—global agent, workflow agent with card type, or process with card type—not a pseudo card name.
Therefore a configured card type literally named `global` receives ordinary card-specific agent, process, and fragment tiers and workflow/process placeholder rules, while the global Analyst remains shared-only.
A workflow with nonempty `permitted_child_types` is the existing capability used for Analyst record-edit ancestor notifications.
Analyst creation always uses its required explicit parent card ID.
Planner creation remains separate: its current parent is inferred from the active Planner session and cannot be supplied.

Records are arbitrary configured safe Markdown names, not three code-owned slots.
Each configured record owns one strict self-contained format-v1 `authored-record-version` row stream at `record-<stem>.jsonl` beneath the card namespace, with exact record name, format, schema, and named writer carried in every row.
The card type's one bootstrap record is published closed at version 1 by `runtime:bootstrap` as one nonempty first envelope.
Opening from a non-open state and every successful edit, close, or discard each append exactly one envelope containing exactly one new row; opening an already-open record is a no-op that returns the current projection after its own strict read and appends nothing.
Every record mutation directly reads and validates its exact stream call-locally before appending; no head token or other carried write authority exists.
Every successful close freshly proves its exact active card and derives durable `accepted.card_version_seq` from that close-owned observation.
Global Analyst record writes resolve the explicit target card and definition, require configured writer plus `write`/`edit`, reject an existing open revision, and synchronously open/edit/close before applying the generic Analyst record lifecycle effect.
Card detail, Files, REST, live sync, and Cards UI all use the selected card type's ordered descriptors and exact dynamic record names.

Every node edge uses one acceptance algorithm.
All requirements, descendant freshness, terminal completion, promotion, and exports are validated before mutation.
A terminal edge alone claims the terminal winner before closes.
Updated records close exactly once in declaration order; downstream context, accepted URLs, and terminal exports use retained closed projections and the exact close returns without rereading.
Primitive-classified close uncertainty permits no later close, read, transition, correction, accepted result, lifecycle publication, parent settlement, or Supervisor halt; the first fatal boundary exits.
Successful terminal routes promote either the current accepted result or an existing graph-reachable latest accepted node result and return ordered exported record references through lifecycle state and `activate_card`; ordinary pre-commit close and execution exceptions produce ordinary node failure.

`reconfigure` has only strict `set_agent_model_route`, `set_model_failover`, and host/port `set_server_setting` variants.
Every successful replacement reports `applied:true, requires_restart:true`; candidate structural compilation is discarded and the current workflows, installed agent bindings, tools, MCP manager, and listener remain unchanged until restart.
Role routing, runtime timeout/continuous-improvement mutation, and MCP add/edit/remove actions do not exist.
All old YAML, role sessions, record rows, and lifecycle results require stop, current-config rewrite, wholesale generated-state reset, and restart.

## Current Activation Ownership Contract

`SupervisorRuntimeApi` owns one private `activationOwners` map and one status field and is the sole coordinator of owner structure, current card, run identity/status, status-derived Analyst intervention admission, Pause state, terminal winners, and runtime halt.
That status field is internal `uninitialized` until startup succeeds, then contains exactly one public runtime status; there is no separately stored readiness or initialization flag.
Each map value is a plain `CardActivationOwner`, not an actor, with phase exactly `prepared_root | child_admission | active | settling` and terminal winner `open | result | cancel`.
The supervisor's one nullable halt record freezes an exact owner snapshot and carries one shared `RuntimeStoppedInterruption` and promise.
`CardProcessActor` remains a micro-actor; `ConversationLLMActor` is the direct provider/tool phase state machine.

The direct Conversation LLM owner has no `BaseActor`, event queue, or actor lifecycle settlement.
Concrete `CardService` remains the one card/root reader and the one strict `cardRecordSchema` remains unchanged.

Every live LLM tool call passes the complete frozen context from `ConversationLLMActor.toolInvocationContext(outcome)` to `invokeToolForLlm`.
It contains exact session/source/call/tool identity, external/process waits, and one mandatory child reservation.
`invokeToolForLlm` requires that context before its optional abort signal; only lower-level non-LLM `invokeTool` may omit it.
Analyst parses protocol arguments before passing the parsed object and the same complete context, but has neither `activate_card` nor a planner child-control port.

Planner activation, cancellation, and direct-child reopening delegate through a port bound to the exact parent owner.
The provider performs only schema and immediate-child ID checks.
Supervisor ownership is consulted before target I/O.
Fresh child admission installs owner, relationship, and admitted lease before the one running append; currentness remains at the parent until publication succeeds.
Exact same-parent/same-lease active or settling calls join without I/O.
Normal terminal work claims its winner before publication, joins local work, atomically removes structure/restores currentness/releases the lease, invalidates, and only then delivers the outcome.

A lifecycle append failure is outcome-unknown only when the direct primitive has attempted canonical mutation.
No reread, retry, rollback, replay, compensation, inferred outcome, owner settlement, process termination, or Supervisor halt is permitted; immediate fatal delivery exits and leaves the lifecycle lock abandoned.
Ordinary Stop, application close, and actor-main containment retain the singular halt: successful containment publishes `stopped`, which admits intervention, while failed containment publishes `error`, which rejects it.

The supervisor directly implements runtime control.
Its accepted Run preparation installs a `prepared_root` owner, run identity, current root, opaque launch token, and the single `starting` status before recovery or root-running publication; `starting` rejects Analyst intervention.
Launch consumes that exact authority, opens the gate, and activates execution.
Global application admission closes permanently only for application shutdown.
Natural root release is valid from running, pausing, or paused and calls `RuntimeGate.completeRun()` in the same transition that clears owners/run/currentness and publishes the single intervention-admitting `stopped` status.
Stop, application close, and ordinary actor-main failure start or join the same halt.
Publication uncertainty exits before that halt or a status transition.

Card stream format v4 keeps the newline envelope at `version: 1`, `type: 'rows'`, and accepts only `card-version` and `card-tombstone` rows with `format_version: 3`.
Artifact row formats 1 and 2, records with durable `children`, snapshots containing removed `tags` or `related` members, and streams containing more than one artifact format fail strict reads.
The one strict `cardRecordSchema` defines every current durable `CardRecord`, immutable ordinary version, and tombstone final state.
Every durable snapshot has exactly `id`, `type`, `child_membership`, `active_child_order`, `title`, `subtype`, `priority`, `urgency`, `created_by`, `created_at`, `updated_at`, `version_seq`, `assigned_to`, `depends_on`, `lifecycle`, `metrics`, `estimate`, `started_at`, `duration_ms`, `status_text`, `status_text_updated_at`, `status_text_author_session_id`, `latest_self_report`, `metadata`, and `pending_notifications`. It has one status authority at `lifecycle.status` and contains no tags, generic related-card list, top-level `status`, persisted `parent`, persisted `depth`, or `allowedActions`.
Operator hierarchy and detail are separate strict projections.

Applying the authoritative card/record exact-stream cutover is reset-only: each affected deployment stops the service, preserves configuration, credentials, operator inputs, source, skills, instructions, prompts, and canonical project documentation, runs the current built `saivage reset`, and starts the current binary.
No card/record index or immutable artifact layout is ever migrated, normalized, rendered, or accepted as current; old and mixed layouts fail reset-required.
A later same-format binary deployment may retain only the exact current `card.jsonl`/`record-<stem>.jsonl` format.

## Project Oversight

**Status: implemented.** Oversight is an independently scheduled selected global participant. Its shared designated-recipient notification prerequisite in §6 is also current behavior.

### 1. Identity, authority, and configuration

Each project has one independently configured global Oversight agent with its own identity, prompt, conversation, model route, check lifecycle, tools, output limits, and model-aware context budget.
It is distinct from the operator-driven Analyst and the sole-dispatcher Supervisor; its checks may coexist with both, subject to ordinary provider capacity.
Planners retain strategy, acceptance, corrective action, and the right to reasoned disagreement.
Oversight uses the ordinary named-agent catalog, explicit route and configured failover, invocation/capability admission, and conversation-history contracts, with no root-Planner model inheritance or special provider system.
The required strict configuration is `oversight:{enabled,agent,interval_seconds}` even when disabled. New-project defaults select global `oversight`, enable it, and use `7200` seconds. The selected agent must differ from Analyst, be global, disable skills and child creation, declare no record writes, use a resolvable route, and select only the observation inventory below. Invalid references, intervals, prompt closure, tools, or capabilities fail startup rather than falling back or silently disabling checks.
Existing projects adopt or disable it only through deliberate complete configuration and prompt work; configuration is epoch-frozen, with no automatic discovery, upgrade, compatibility default, missing-field normalization, or live toggle. Deployment applicability must still be established for every other retained durable-format cutover.

### 2. Schedule and lifecycle

A check is eligible only while Oversight is enabled and authoritative project runtime status is exactly `running`; a live server or any other status is insufficient.
The first check waits one full continuous eligible interval, and losing eligibility discards that wait. Each later check waits another full interval after the previous check, including continuations, compaction, and settlement, safely settles.
At most one check is in flight. There is no persistent timer, backlog, catch-up, burst, scheduling SLA, or server-triggered Run.
A check may run alongside normal card work and Analyst activity, but ordinary provider limits may delay it.
Leaving `running`, including pausing, completion, shutdown, or effective disablement, disarms the wait and requests cancellation.
Resume or a new Run begins a fresh full interval only after prior ownership settles, with no missed or pending check accumulated.

### 3. Cancellation and truthful settlement

Cancellation admits no new investigation read, model call or continuation, notification submission, or urgent interruption request, but bounded truthful settlement of obligations already owned by the check remains required.

- A call not durably recorded and not entered is not fabricated.
- A durably recorded call whose operation has not entered receives its ordinary matching non-executed result.
- Entered work is joined or cancelled only through its existing owner and is never reported as unexecuted.
- A safely known completed result is published exactly once unchanged; an already published result is not duplicated.
- A confirmed notification enqueue remains confirmed and is not retracted, while urgency not yet entered is suppressed after cancellation.

When outcomes are known and every required publication succeeds, ordinary cancellation or safely settled provider, refusal, context, or investigation failure releases check admission with continuable history.
It requires no final model report or immediate retry and does not fail cards or disrupt Analyst; a later check waits the next full interval.
An unknown effect or failed/outcome-unknown required result, evidence, or terminal publication retains the exact fatal owner policy: no follow-up effect, read, inspection, retry, repair, invented settlement, or admission release.
Strict history remains strict, and startup performs no reconstruction or synthetic completion.

### 4. Read-only intervention boundary

Oversight is read-only with respect to project work. Its exact default/maximum inventory is `get_status`, `list_cards`, `get_card`, `get_tree`, `list_card_versions`, `get_card_version`, `diff_card_versions`, `read_record_version`, `read`, `glob`, `grep`, `read_runtime_events`, `read_runtime_errors`, `list_processes_tool`, `list_agent_sessions`, `read_agent_session`, and `queue_notification`; custom selected Oversight agents may use subsets. Agent, process, runtime-event, runtime-error, card, record, search, and file collections use the ordinary stateless byte-bounded response packing contracts. Its sole project-affecting operation is a shared notification contract bound to the Oversight-specific effect port: compiled capability, exact active-check cancellation signal, current running admission, and planning eligibility are checked by that owner rather than inferred from agent-name spelling or borrowed Analyst/runtime authority. Analyst uses its distinct audited intervention-ready owner, and Planner uses its exact active card owner.
It cannot edit source, records, briefs, configuration, prompts, or policy; mutate, activate, reopen, cancel, delete, or reorder cards; run shell, build, test, process-kill, or effectful MCP operations; control project or model lifecycle; approve work; or obtain those effects through a broad tool.
Ordinary publication of its own conversation, provider evidence, and notification result remains allowed.
It normally selects the nearest responsible planning scope, uses root for strategic or cross-scope concerns, and never broadcasts.
This is workflow role discipline that simplifies ordinary work and preserves role separation, not containment of a malicious root-capable agent.

### 5. Proportionate observation

Each check performs bounded, proportionate observation of objectives, linked work, records, conversations, process evidence, and source, distinguishing facts, interpretations, uncertainty, and current evidence from historical evidence.
Reads are non-atomic observations and never authorize a later write; partial or failed reads do not prove absence, and time elapsed, call volume, or a red test alone does not prove waste.
Project guidance supplies context but cannot waive owner scope or acceptance.
A short no-intervention response is successful but does not certify the whole project.
Oversight uses ordinary conversation and compacted history, repeats advice only when new evidence or a stated material reason adds value, and corrects disproved advice.
It records unavailable recipients and owner-decision needs in its inspectable conversation without promising an operator alert; no intervention ledger, deduplication registry, or guaranteed-attention channel is introduced.

### 6. Shared designated-recipient workflow

Generic designated-recipient notification routing is current behavior and a prerequisite for Oversight. Every card type designates a workflow participant and provides defined opportunities for that participant to handle queued context.
Oversight targets additionally require that at least one node of the declared recipient has nonempty compiled child-creation and child-activation types. `get_card` exposes this bounded `workflow` policy projection as `planning_target`, together with recipient, permitted child types, and the current process position when available; it exposes no queue state.
Planner-directed context waits for that designated Planner. A nonrecipient node, especially a same-card Reviewer, must not consume it, skip review, fabricate a result, or jump the workflow graph.
Successful ordinary completion provides the generic handling opportunity through recipient arbitration or a configured nonrecipient-DONE conditional edge.
Current routing reconciles pending context with BLOCKED or failure settlement, cancellation, postclaim denial, and every successful completion route.
It preserves exceptional terminal clearing, notification-empty terminal states, and append-before-remove duplication/loss limits.
It promises neither eventual nor exactly-once delivery and adds no second queue, receipt service, transaction, replay, or recovery protocol.

### 7. Urgent notification ordering (implemented shared contract)

Urgency is a property of the shared notification operation, not a new queue, wire protocol, or control port, and requires current evidence of material ongoing harm, avoidable waste, or divergence plus why waiting is materially worse.
For a target Planner awaiting an active descendant chain, the runtime first performs fresh ordinary target/activation admission and **confirms notification enqueue before requesting interruption**.
Only then may it interrupt necessary active descendants through existing owners, preserve truthful interrupted outcomes, and permit later ordinary Planner-directed recovery or re-entry.
It must not permanently cancel work, fake completion, roll back effects, automatically replay a child, terminate the target's own turn or review, or interrupt unrelated work, naturally settled descendants, or replacement owners.
Without an active awaited descendant chain, urgency queues normally; it never activates/reopens a card, bypasses dependencies, redirects a denial, or creates or resumes a Run.
Missing, terminal, and postclaim denials stand. Enqueue failure or uncertainty permits no interruption.
Confirmed enqueue followed by denied or failed interruption is a truthful partial outcome: retain queued context, report known results separately, and do not retract, resend, or claim atomic rollback.
Pause, Stop, application closure, terminal winners, and ordinary runtime ownership always prevail. Both Analyst and Planner `queue_notification` inputs require exact lowercase `urgency:'normal'|'urgent'`; omitted values and aliases are invalid. Normal submission returns `interruption:{status:'not_requested'}`. Confirmed urgent enqueue returns `not_applicable`, `interrupted` with exact stopped IDs, or `suppressed` with its known reason and exact already-completed `stopped_card_ids`. Every confirmed form retains `queued:true`, card/notification identity, and the interruption result. A known enqueue receipt never waits for its encompassing Stop/application halt and proves neither delivery nor successful containment; later halt cleanup failure remains the halt owner's failure.

### 8. Privacy and failure containment

Pending queue state stays private. Authenticated/redacted sender body/result evidence and context actually appended to the recipient conversation remain normal inspectable transcript facts; they prove neither queue membership, receipt, model consideration, nor action.
There is no queue browser, count/body projection, delivery inference, or separate report store. Existing file, history, redaction, and fatal-publication policies remain unchanged.
Expected provider, refusal, context-admission, and investigation failures settle as process-local `failed` attempts and allow a later full interval. Publication uncertainty enters the existing nonreturning publication-fatal boundary. Other impossible owner/protocol, malformed-data, or required-settlement failures synchronously close application admission, run bounded existing cleanup, emit only a fixed safe Oversight owner-failure diagnostic plus safe shutdown warnings, and exit 1. No poisoned-health latch, report store, schedule persistence, retry queue, or feature-specific recovery exists.
