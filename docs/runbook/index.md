# Saivage Operator Runbook

Status: current operator procedures for runtime maintenance.

## Autonomous conversation compaction

When enabling `compaction`, set a positive route-independent `input_budget_tokens` and a summarizer model. Configuration load validates fraction order, completion reserve, and that escalated tail and middle widths are each no wider than normal. A config may still fail for a particular planner, executor, or reviewer: before its first transcript append, Saivage measures that invocation's exact system prompt and complete tool definitions. Raise the actor budget, reduce the prompt/tool surface, or lower the completion reserve when this Stage-2 capacity check fails.

Compaction is append-only. The newest strict system/canonical-JSON `context_compaction` row defines rendered context; raw rows remain untouched and authoritative. Normal and escalated windows slide backward from the newest completed round, and hard fallback handles only a residual safe prefix after both whole-round passes. Candidate admission uses a deterministic best-effort estimate of one canonicalized complete body (`ceil(UTF-8 bytes / 4)`). A heuristic skip suggests lowering `input_budget_tokens` or changing declared route capabilities. A provider can still reject an admitted request authoritatively; Saivage does not recompact per candidate.

## Runtime controls and lifecycle lock

`status`, `pause`, `resume`, `stop`, and `restart_server` classify `.saivage/locks/runtime.lock` as missing, verified live, positively dead, indeterminate, or malformed. Only verified live delegates, using exactly the record's published non-null origin and disabled/bearer auth mode. Null means only `active lifecycle owner; runtime control unavailable`; do not infer init/start/reset phase. Bearer mode requires `SAIVAGE_API_TOKEN`; disabled mode sends no Authorization header. Connection, auth, response, and schema failures have no config/file fallback.

Missing/dead `status` reports stopped and missing/dead `stop` succeeds with `{status:'stopped',contained:false}`; dead also prints manual abandoned-lock repair. Missing/dead `pause` and `resume` fail no-live. Indeterminate/malformed fail closed. Every existing lock still blocks lifecycle acquisition and is never automatically removed or taken over.

`saivage stop` delegates to `POST /api/runtime/stop-project`. Project Stop is containment, not cancellation: it never calls `cancel_card` and does not itself write a card/root outcome, ToolResult, provider round, or Stop event. It first closes continuation/admission, then Stop-claims only open owners, whose durable `running` cards remain restartable. Result winners remain authoritative and only suppress continuation. A cancellation that already won also remains authoritative; Stop starts or joins its full settlement and does not report success or clear owner maps until durable `cancelled` publication and caller settlement complete. Cancellation-settlement, cleanup, or process failure returns containment failure and retains closing ownership, so all controls conflict until terminal restart. A later Run installs every ancestor owner remaining in the running chain in structural wait and activates only the deepest card. The server, Analyst, MCP resources, and lifecycle lock remain live. Pause is cooperative: one flag parks one active admission frontier.

## Server restart

`restart_server` is available only when operator authentication is enabled/published bearer. It requires the exact `RESTART SERVER` confirmation. The acknowledgement means accepted asynchronous intent, not that replacement is running. It enters the App terminal coordinator, never project Stop. Disabled-auth catalogs/UI omit it and direct calls fail `restart unavailable: operator authentication disabled`.

## Terminal application cleanup

The App terminal coordinator first attempts every synchronous admission closer, catching each independently, before awaiting cleanup. It then attempts exactly one runtime, one Analyst, and one MCP component leaf plus independent LiveSync, Fastify, Telegram, subscription/listener, and lifecycle-lock leaves. Each process-owning component closes/revokes and starts its one root termination before any await, then joins owned work; there is no later process-registry drain. A timed-out component can continue only under its root while later disjoint-root leaves proceed. App runtime termination may overlap project Stop on the runtime root, so repeated signals and already-absent/removal observations are normal; App neither joins nor consumes Stop's strict result.

Each leaf has one referenced ten-second bound. Fast completion clears the timer; a hanging leaf keeps the process alive through the bound, records `cleanup_timeout`, and then permits later leaves. Rejection records `cleanup_failed`; closer failure records `closer_failed`. `ShutdownReport` contains only fixed component/code values. Direct callers must inspect it. It is not an aggregate error, containment proof, or process-exit guarantee and does not change signal/restart behavior. Telegram stop succeeds only when poll/backoff rejection is the exact private lifecycle stop reason; a distinct racing error is cleanup failure.

## Running-card cancellation

Analyst and planner explicit `cancel_card` route running cancellation through the runtime cancellation port. The exact live `CardActor` synchronously claims the target and complete running descendant suffix before containment awaits, revokes callbacks, contains scope, preserves done descendants, publishes deepest-first cancellation, settles once, and removes ownership last. Project Stop and App cleanup never call this port. If cancellation already owns the terminal claim when Stop begins, Stop joins that same exact actor settlement; closing retains ownership until it succeeds, then the supervisor clears the maps. A running card with no exact live owner is an invariant failure, never a direct-write fallback. If a cancellation request resumes after its captured runtime closed or was replaced, it reports `runtime_control_interrupted` before reread or mutation; inspect state and intentionally retry.

## Storage and interruption

Runtime state, actor snapshots, recovery diagnostics, provider availability, conversation versions, summary sidecars, and lifecycle-control audits are not durable files. Cards, records, stable conversations, identity/config/auth, and the app log use their direct domain-owner functions. Canonical JSONL may truncate only an identifiable unterminated final suffix; complete malformed canonical data fails.

Provider availability begins empty after every service restart and should be interpreted only as current-process routing advice. Auth refresh strictly rereads and replaces the complete canonical auth file after network completion. Concurrent refreshes are last-completed-write-wins and can overwrite another credential change; retry authentication/refresh when that accepted race occurs. Stop during response or body handling aborts before auth replacement.

Fresh replacement/first-publication writes use one fresh UUID same-directory temporary opened exclusively, then fsync/rename/fsync-directory. Crash-left noncanonical files and incomplete prepublication card namespaces are harmless and ignored forever: do not scan, warn, adopt, repair, reuse, or selectively clean them. Explicit reset may remove generated roots wholesale. Files use ordinary Node defaults filtered by the process umask.

Durable-format cutovers are reset-only. Stop the service, preserve configuration, credentials, operator inputs, source, and documentation, reset generated persistence, and start the current binary. Mixed-version operation and rollback against current-format state are unsupported.
