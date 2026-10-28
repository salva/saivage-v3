# Control project work and server lifetime

Server startup, project Run, Resume, project Stop, application close and server
restart are different operations. Check the current runtime and exact lifecycle
owner before choosing. [Deployment](./deployment.md) owns server installation;
[state adoption](./state-adoption.md) owns offline changes, not runtime controls.

## Choose the control

| Intent | Operation and expected observation |
|---|---|
| Start project work from stopped | Analyst `start_project({})`; a new Run activates project through its configured entry |
| Pause autonomous provider admission | `pause_runtime({})` / `saivage pause`; `pausing` is not yet `paused` |
| Continue the same settled-paused Run | `resume_runtime({})` / `saivage resume`; not a new Run |
| Contain card execution | `stop_project({})` / `saivage stop`; inspect `contained`, not merely HTTP success |
| Dispose the server and all application-owned integrations | Application close through authorized deployment/lifecycle owner |
| Request server replacement | Confirmed, bearer-only `restart_server`; separately verify exit/replacement |

HTTP Pause/Resume/Stop must **omit body and JSON Content-Type**. Any payload is
400 before control mutation. Restart alone uses exact JSON
`{"confirmation":"RESTART SERVER"}`. Analyst controls use their discovered tool
schemas. Wrong-state Pause/Resume are ordinary failed tool results; Stop joins its
existing halt including closing/error cases. Stopped needs Run, not Resume.

## Five ownership outcomes

CLI `status`, `pause`, `resume`, `stop`, `restart_server` classify the exact
`.saivage/locks/runtime.lock` under the nearest ancestor of cwd (including cwd)
containing the canonical YAML marker. This is not the exact-cwd rule for offline
mutations; see [command selection](../reference/configuration.md#command-specific-input-selection).
They never control runtime by reading/writing an
offline runtime-state file.

| Outcome | Meaning and CLI consequence |
|---|---|
| missing | No recorded owner. Status succeeds stopped; Stop succeeds stopped/`contained:false`; Pause/Resume/restart fail no-live. |
| live | PID **and process-start identity** positively match. Delegate only to its published non-null control endpoint/auth mode. |
| dead | Positive ownership death/identity mismatch. Same status/Stop no-live behavior, plus manual abandoned-lock instruction. |
| indeterminate | Read/probe/identity verification cannot prove ownership, including denial. Fail closed; not “live.” |
| malformed | Invalid/mismatched lock/project identity. Fail closed. |

A verified live null endpoint means exactly **active lifecycle owner; runtime
control unavailable**, not an inferred init/start/reset phase. Never rediscover
endpoint/auth from YAML, flags, defaults or process environment. Bearer delegation
requires the operator token; disabled mode sends no Authorization. Connection,
auth, response and schema failure have no fallback. Every existing lock blocks
new lifecycle acquisition; no classification automatically removes/takes it over.
Owners: `src/runtime/lock.ts` and `src/cli.ts`.

`gc-work` uses these classifications separately: live delegates, including when project
execution is stopped; only missing permits interactive offline bound-lock GC.
Dead/malformed/indeterminate and live null endpoint refuse. No failed delegation
falls back. See [work GC](./work-gc.md) for maintained writer exclusion, cooperative
cancellation without an elapsed deadline and release-before-result semantics.
This exception does not change ordinary controls or authorize source commissioning.

### Abandoned locks

Only after separately authorized exact abandoned-lock handling: stop the exact
service, prevent restart and positively prove no Saivage process owns the target,
including descendants where containment is in question. A stale PID or stopped unit
alone is insufficient. Resolve uncertainty before deletion, including malformed
first-write locks. Use only the lock-status diagnostic's exact manual removal
command for the canonical lock. Never scan/remove siblings or automate takeover.
Removal does not repair state, certify containment or authorize start/Run.

## Run and Pause

Run installs one prepared root owner, reports starting, and may first settle the
durable interrupted running chain. It launches only project; descendants need
ordinary immediate-parent activation with fresh explicit direction. It never
rediscovers an old leaf/node or replays an old call. Application close permanently
closes Run admission. Intervention-ready means stopped or settled paused, not
starting/running/pausing/closing/error.

Pause is cooperative, run-scoped **provider admission control**, not SIGSTOP or
universal action suspension. An admitted provider can keep retrying; actions/hooks
can finish and an action chain can advance until the next autonomous provider
frontier or natural completion. A natural root completion can win from running,
pausing or paused, clear the old Pause request and leave stopped. Do not Resume
an old Run after it completed. Use project Stop when containment is required.

## Project Stop and application close

Stop freezes the exact ownership graph, installs closing/intervention rejection,
interrupts/disposes work and joins processors and runtime-card processes through
one retained halt. It is not `cancel_card` and writes no Stop-fabricated card/root
outcome, ToolResult or provider round. Near-terminal result/cancellation may have
published or be abandoned. Continuation fences prevent post-freeze publication.
Known enqueue results have a narrow matching-result settlement ordering before
disposal; that result never certifies complete halt.

`{status:'stopped',contained:true}` means that halt completed; no live runtime
returns `contained:false`, not a new containment claim. Failed halt retains error,
rejects intervention/repeated Stop with the retained cause and requires separately
authorized service action. Stop waits for admitted finite raw actions/hooks,
cleanup/evidence and matching consumer, not just leader exit. Scope termination
cannot prove remote/escaped effects ended. See [unavailable process evidence](./evidence.md#process-state-and-missing-output).

Project Stop leaves the server, Analyst, outbound MCP services and external Analyst
listener alive. Durable running cards may remain for the next explicit Run's shared
recovery; Stop does not replay or perform full-chain corrective settlement.

Application close additionally closes every application admission permanently,
contains Analyst/direct-external processes and MCP owners, and closes HTTP/listeners/
subscriptions/lock. Concurrent Stop joins the same runtime halt, not duplicate cleanup.
The terminal coordinator attempts synchronous closers independently before awaits,
then bounded reverse component cleanup. A timed-out leaf can continue under its
disjoint root while later leaves proceed. Fixed `closer_failed`, `cleanup_failed`,
`cleanup_timeout` reports require inspection; they are not aggregate containment
proof or process-exit guarantee. Exact bounds remain in the
[cleanup timing contract](../spec/system-specification.md#exact-cleanup-timing-contract).
[Publication uncertainty](./state-adoption.md#stop-on-uncertainty) exits before all cleanup.

## Confirmed server restart

Available only when operator auth is enabled and the verified live owner publishes
bearer mode; capability is projected in runtime status. The UI global strip shows
Restart server only then and requires confirmation. CLI `saivage restart_server`
asks for exact `RESTART SERVER`. Disabled mode has no restart action; a configured
Analyst restart tool reports unavailable rather than weakening auth.

The Analyst/MCP `restart_server` tool requests the separately authenticated operator
confirmation; its credential is not restart authority. Accepted intent enters App
terminal cleanup, not project Stop. REST acknowledgement is response-finish-based;
the live server exits75 after cleanup. The delegating CLI prints acknowledgement
and returns normally. Verify the authorized service manager's replacement and
health/readiness separately; scheduling/acknowledgement/exit75 is not boot proof.

## Steering and cancellation

Normal notifications can queue while running without Pause. Enqueue success means
admission, not delivery, understanding or model action. Urgent notifications can
interrupt an eligible exact active owner, settle/join it and enter recipient-first
recovery; parent direction survives, descendants need later ordinary activation.
Urgent root replacement goes through STOPPED within the same Run, not a second Run.
With no eligible owner it only queues; later execution needs explicit Run, and
terminal ancestors are not reopened by Run. Paused work still needs explicit Resume.

Only the workflow-designated recipient consumes pending context, appending context
before exact-ID removal. Nonrecipient DONE follows its configured conditional edge;
nonterminal nonrecipients do not inspect/remove pending. Cancellation/BLOCKED/failure
may clear already admitted context without delivery. Synthesized ancestor notices
skip terminal/BLOCKED statuses without forbidding direct BLOCKED notification or
ordinary parent activation. Claimed terminal winners reject later interruption.
Old `pending_tool_settlement` receipts are original enqueue evidence, not current
capability or a completed stop. There is no public queue count/body/membership API.
On request failure after possible enqueue, inspect supported evidence; never resend
blindly. [Evidence limits](./evidence.md#control-events-notifications-and-external-receipts) apply.

Analyst normal nonrecord write/edit, notification and cancel have operation-specific
running admission; create/reorder/reopen/delete/reconfigure/record mutation retain
their own intervention-ready gates. Tool possession is not enough: record mutation
requires exact active-linked current URL, scope/tool/write permission, supported
lifecycle and no open workflow draft. CHANGED correction can be admitted while
stopped/settled-paused without Run; cancelled targets remain denied.

Planner `cancel_card` is immediate-child, parent-owner-bound, owner-first; Analyst
rejects root and preflights the entire requested subtree, rejecting done/cancelled
members. Supervisor synchronously claims the complete installed target suffix only
after all owner/result/interruption conflicts pass, then publishes deepest-first.
Durable running without an exact owner is an invariant failure, never direct-write
fallback. Stop/close may interrupt unfinished cancellation; they never initiate it.

## Startup and Run recovery

After lifecycle exclusion and required config/canonical admission, server startup
strictly consumes configured Analyst, then Oversight only if its exact index is
established (even disabled). A sole strict-valid final unmatched tool call gets
one permanent uncertainty-only failed mate, preserving identity/policy, without
new ingress/check/recovery notice/provider/tool work. Absent Oversight stays absent;
missing Analyst/reference/malformed/multiple/nonfinal-unmatched history blocks.
CLI init performs no global settlement.

The sole Supervisor startup/Run operation selects the complete linked running set,
rejecting branching/discontinuous topology, and works leaf-to-root: stabilize that
card's configured sessions, immediately publish its stopped artifact/head, then
advance to its ancestor. Startup creates no activation owner and publishes usable
stopped only after success, before MCP/listener/readiness/operator admission.
Run uses the same operation then activates only project through STOPPED. A recovery
notice is not resume/redispatch authority. Existing broader startup/init reads of
stopped sessions/evidence/records remain strict; the suspect set bounds corrective
writers, not consumption.

At actual use, an ordinarily selected card session can receive its sole valid final
uncertainty mate before fresh activation. Later newly admitted internal Analyst
submission can do likewise before ingress. Neither proves whether old effects
occurred or resumes/replays old work. Do not manually append mates. Malformed or
nonfinal/multiple unmatched history still fails. Repeated HTTP500 proves neither
repeated execution nor persistent poisoned-session state.

Recovery is nontransactional: permitted tail truncations/global mates can precede
a later topology/read failure. First failure stops that attempt, without rollback
or processing later ancestors. A genuinely new process may consume a valid committed
prefix; no lossless/exactly-once guarantee. Later MCP/listener failure does not undo
known correction. Stay stopped after failure; [repair](./state-adoption.md#current-format-repair)
requires its own gates. Outcome uncertainty permits no subsequent halt/cleanup.

## Reopen a failed root, then explicitly Run

This conservative incident procedure is for a diagnosed **strict failed root**
where ordinary reopen/new Run is explicitly determined appropriate. It is not
generic startup admission or a reset recipe. Require current matching build,
verified live owner/published control authority, stopped or settled-paused runtime
and positive evidence of no running card process. Record exact deployment/cause
and incident counts outside this reusable procedure.

Derive every root card participant from the current compiled workflow, not default
role names or directory enumeration. Require strict root histories
`agent:<configured-name>:project`. A pre-existing sole valid final unmatched root
call is not itself a blocker: actual workflow selection determines if/when it is
settled; Run need not select all participants, and FAILED is not a running-chain
target. Conservatively require selected global Analyst
`agent:<analyst-name>:global` settled with no unmatched call for this procedure.

Capture the strict active-linked projection without scanning. Before each submission
re-establish expected failed/changed root, valid participant histories, settled global
Analyst, unchanged projection, same owner/control authority, intervention-ready
runtime and no running card process. Do not read/mutate the root brief; no brief
head/content/version assertion is required.

1. Submit exactly one Analyst `reopen_card({cardId:'project'})`, no read/control call,
   then final prose. Wait for known settlement.
2. Audit the entire settled suffix byte-for-byte: exactly that one matching call/
   result, success, current root `changed`, exact ordinary `failed -> changed`
   history, unchanged linked projection, same owner, no running process and stopped/
   settled-paused runtime. Require its low-safety `card.reopen` control_action `ok`.
3. Denial, extra/different call, partial propagation, failed/unknown/unmatched result,
   unexpected state or uncertain observation blocks. No repeat, undo/compensation,
   generated-stream inspection/patch, reset or inferred intent.
4. Only after all checks and no safety Stop, submit a **separate** fresh one-call
   `start_project({})`, then final prose. Audit exact call/result, runtime, ordinary
   `changed -> running`, unchanged linked projection, owner/process/service health
   and first completed post-reopen root provider turn. Runtime control has no required
   control_action row. Never combine reopen and Run.
5. At most one supported authenticated bodyless safety `stop_project` is allowed
   only with positive evidence a successful start from a blocked submission left
   runtime active (including expected start followed by an extra call). Require known
   settled transport result, strict stopped/settled-paused runtime, exactly observed
   root/history without Stop-fabricated transition, same owner and no running process.
   It does not undo effects and has no required control_action row.

Unknown submission/start/active relationship/Stop/settlement authorizes no safety
Stop, retry, compensation, stream mutation or further recovery submission. Report
the blocker. Newly submitted calls must settle exactly; permissive treatment of one
pre-existing unmatched call does not waive this audit. Installing a tool-target fix
or global startup settlement alone does not recover the failed root.
