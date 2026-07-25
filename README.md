# Saivage v3

> **Want to try Saivage?** Launch your favorite AI agent and point it to
> [README-IF-YOU-ARE-AN-AI.md](README-IF-YOU-ARE-AN-AI.md). It will guide you
> through requirements, project specification, LXC setup, credentials, startup,
> and verification while explaining each step as it proceeds. This README has
> not yet been polished for direct human consumption, so the AI-guided setup is
> currently the preferred way to get started.

Saivage v3 is an autonomous multi-agent runtime for software-development work. A top-level planner decomposes goals into cards, executors perform scoped work, reviewers verify results, and the operator workspace projects cards, agents, files, strict app-log events/derived errors, runtime state, and read-only compiled workflow diagrams while the Analyst chat is the ordinary mutating user surface, with direct Dashboard **Stop project** and confirmed bearer-only **Restart server** as bounded exceptions. Debug > Errors—not Dashboard—is the durable command, activation, actionable, and runtime-error surface. Debug > Graphs shows one accessible effective startup workflow per card type; it is visualization only and never edits or reloads configuration.

Configured planning and terminal workflows are genuine micro-actors. Startup compiles one immutable topology per family: lifecycle entries, configured nodes, and terminal sinks become states, while accepted outcomes become events and edges become transitions. Same-node edges are explicit external reentry. Node corrections remain hidden inside one state task. Promptless ordinary entries add no lifecycle message; STOPPED adds the discarded-position recovery statement and its configured prompt. Live state and zero-based node ordinal are transient only—there is no graph interpreter or durable cursor.

Runtime execution state is process-local. The acquired lifecycle lock supplies one stable PID/start identity for the server process, and the scheduler-owned active leaf supplies the exact current card; runtime state/status project those facts on demand without an application cache or inventory/session inference. `saivage status|pause|resume|stop` delegates only through a verified live lifecycle-lock owner's published non-null origin/auth mode; it never reads a runtime-state file or rediscovers an endpoint from config. CLI `stop` maps to resumable non-domain project halt `stop_project`, which never cancels or mutates cards. A delegated live halt returns `contained:true`; missing/dead or no-runtime Stop returns `contained:false`. Auth-enabled confirmed `restart_server` is the separate terminal operation.

Ordinary activation state, transition, persistence, and lease coordination is callback-free supervisor state: one `activationOwners` map contains plain owners in exactly `prepared_root | child_admission | active | settling`. The sole narrow callback exception reports a terminal `CardProcessActor` main-loop failure to the exact current/frozen owner. One nullable supervisor halt record freezes an exact owner snapshot and carries the shared interruption/promise for Stop, application close, and actor-main invariant failure. Outcome-unknown durable publication exits through the injected fatal boundary before this halt or any status mutation. `CardProcessActor` remains the micro-actor; `ConversationLLMActor` is a direct provider/tool phase state machine.

The direct Conversation LLM owner has no `BaseActor` queue or lifecycle. Every autonomous and Analyst LLM tool call uses the complete LLM-owner-built invocation context; an admitted child lease makes the exact planner wait until supervisor structure/currentness is released and invalidated. Runtime halt synchronously interrupts every admitted wait and owner settlement before any processor join, then clears only after complete volatile quiescence. A failed actor main rejects its activation and lifecycle locally with the exact caught value, cannot restart, and synchronously starts or joins that same halt. A failed join retains the frozen graph in `error` and requires service restart; a successful halt leaves durable `running` recovery input for the next Run. The supervisor directly implements runtime control, including Run preparation/launch, readiness, and gate mutation; composition exposes one `RuntimeApi`. Natural root completion atomically retires a pending or settled Pause before publishing stopped; Dashboard disables Stop in `closing` and enables it in `error` to report the retained non-retrying failure.

`App.stop(): Promise<ShutdownReport>` is the sole production aggregate teardown API. Its App terminal coordinator synchronously attempts every admission closer, then independently attempts flat runtime, Analyst, MCP, transport, subscription, and lifecycle-lock leaves under one referenced ten-second per-leaf bound. The runtime closer starts or joins the same supervisor halt and its cleanup leaf awaits it; it never calls project Stop or creates duplicate runtime termination. Reports expose only fixed component/code warnings and must be inspected by direct callers; even an empty report does not prove process exit or full OS containment. Signal/restart/startup adapters log safe warnings and preserve normal process behavior.

Provider candidate availability is live process-local routing advice and resets on process restart. Auth profiles use direct strict canonical-file reads and complete `replaceFile` publication. OAuth refresh carries the original invocation abort signal through response/body completion and the final no-await reread/replace; concurrent refresh is deliberately optimistic last-completed-write-wins with no repository, revision/CAS, mode enforcement, or persistence-health machinery.

**Files security:** Operator Files has two concerns in a fixed order: admission/classification, then either the unchanged generic resolver or the canonical-card virtual read model. Traversal/outside-root rejection and canonical `work:///` validation/path derivation run first; lexical blocked-source policy then returns 403 or omits a listed child without classifier filesystem I/O; only allowed sources undergo lexical card reservation and bounded symlink classification. Allowed project or validated-work aliases into `.saivage/cards` are opaque (404 or omitted), while conclusively non-card aliases retain generic lexical and real-target blocking. Card storage is browsable only as the linked virtual subtree: `.saivage` receives a synthetic `cards` row, parent/child directory rows use canonical card `updated_at`, and fixed artifact rows use descriptor metadata rather than physical directory discovery. Fixed-file listings are metadata-only; explicit content reads are strict and bound to one no-follow descriptor. Physical unlinked namespaces are never browsable, and there is no scan, cache, repository, or physical fallback. Explicitly redacted generic paths are read only for an outbound-redacted projection.

**Operator egress:** Backend-owned typed projectors preserve structural identity while redacting only schema-classified prose, secrets, URLs, and opaque leaves. Effective config guarantees replacement of provider/account API keys and every stdio MCP environment value regardless of key spelling. Files recognizes the startup-selected config through its admitted lexical path or resolved alias and renders projected effective config; all other admitted work text, including process logs and webfetch stashes, receives text defense. Card hierarchy, displayed detail, compiled descriptors, exact record content, runtime breadcrumbs, tools, history, and diffs each validate their own strict redacted projection; hierarchy exposes no raw links and detail exposes no dependency, assignment, start, note, or bundled-record fields.

The invocation projector recognizes the exact 41 Analyst tools, planner-only `edit_card`/`activate_card`, and terminal `emit_result` (44 identities) for call arguments. Unsupported, malformed-JSON, and schema-invalid known calls remain readable without invented mates. Durable results use only the generic strict success/failure envelope; optional `data` is opaque and every known or unknown tool uses the same recursive outbound redaction rather than a named-result parser. Historical Analyst arrays/wrappers and `emit_result` payloads remain valid under `data: unknown`, with no migration or compatibility branch. Current workflow-owned terminal settlements are separately parsed beside `AgentNodeExecution` immediately before each direct append/settlement, without changing ordinary tool, MCP, provider, acceptance, publication-fatal, record, or cleanup contracts. Complete Agent conversations permit zero or one unmatched tool call only when it is the final durable source row. That prefix has no active, waiting, pending, or snapshot meaning. Bounded `read_agent_session` validates the complete stream before keeping its exact suffix and counts, without expanding the suffix to recover a matching call.

Provider exchange, event, and control rows are source-projected before publication and on read. Provider endpoint scheme/host/port/path and adapter identity remain exact while userinfo/query/fragment are removed. MCP tools expose one displayed server/tool hierarchy with nested direct statistics and omit integration errors, descriptions, schemas, annotations, `_meta`, duplicate flat inventories, and a duplicate all-stats table. Every `webfetch` result exposes `redacted_url` and no raw URL, and durable call rows expose no raw query.

## Quick start

Saivage is designed for deployment inside an isolated LXC container, where trusted in-container agents may have root shell access; authentication and secret-safe output still protect external/operator surfaces. Local builds and tests outside LXC remain valid, and Saivage neither detects nor enforces LXC at startup.

Use Node.js 24 (the repository engines require `node >=24 <25` and `npm >=10 <12`, matching the GitHub Actions validation profile) on a POSIX system with Bash and POSIX process-group behavior. Build Saivage from a source checkout, then operate it from the target project directory so the project-local `.saivage/` runtime tree is created beside the work Saivage will manage:

```bash
cd <SAIVAGE_SOURCE_CHECKOUT>
npm ci
(cd web && npm ci)
npm run build
SAIVAGE_BIN="/absolute/path/to/saivage-v3/bin/saivage.js"

TARGET_PROJECT="/absolute/path/to/target-project"
mkdir -p "$TARGET_PROJECT"
cd "$TARGET_PROJECT"
"$SAIVAGE_BIN" init
```

Initial project-card publication is allowed only when all four exact generated roots—`.saivage/cards`, `.saivage/agents`, `.saivage/logs`, and `.saivage/work`—are absent. `init` first creates and binds missing durable project identity, then either accepts a strictly valid existing project card, publishes from zero generated roots, or rejects the first retained exact root. After that partial-state rejection, the new identity intentionally remains so the remedy is executable: stop Saivage, run the current built `"$SAIVAGE_BIN" reset`, and retry `init`. Do not selectively delete roots or expect `init` or `start --create-runtime` to repair retained state.

Before starting, configure the required named-agent catalog, selected global Analyst, named model routes, and all nine card-type workflows in `$TARGET_PROJECT/.saivage/saivage.yaml`. Agent names are configuration identities, not code-owned roles. Every agent owns one generic prompt reference, exact ordered tools, model route, skill capability, session scope, and child-creation ceiling. Every card type independently owns its permitted child types, records, bootstrap record, lifecycle entries, nodes, outcome edges, exports, and result promotion. Unknown fields and incomplete card-type maps fail startup.

The following abbreviated shape shows the current contract; `saivage init` publishes the complete default with all nine workflows:

```yaml
agents:
  analyst: {prompt: analyst, tools: [read, write, edit, create_card, get_status, reconfigure], model_route: analyst, skills: false, session: global, can_create_children: true}
  planner: {prompt: planner, tools: [read, write, edit, create_card, activate_card], model_route: planner, skills: false, session: card, can_create_children: true}
  reviewer: {prompt: reviewer, tools: [read, write, edit, skill], model_route: reviewer, skills: true, session: card, can_create_children: false}
  executor: {prompt: executor, tools: [read, write, edit, run_command, skill, mcp_tool_call], model_route: executor, skills: true, session: card, can_create_children: false}
analyst_agent: analyst
models:
  routes:
    analyst: {candidates: ["gpt-4.1"], temperature: 0.7, max_tokens: 4096}
    planner: {candidates: ["gpt-4.1"], temperature: 0.7, max_tokens: 4096}
    reviewer: {candidates: ["gpt-4.1"], temperature: 0.2, max_tokens: 4096}
    executor: {candidates: ["gpt-4.1"], temperature: 0.3, max_tokens: 8192}
  profiles: {}
  equivalents: []
  failover: {}
providers:
  openai:
    models: ["gpt-4.1", "org/summary/model"]
    apiKey: "<your-api-key>"
compaction:
  enabled: true
  input_budget_tokens: 120000
  summarizer_candidate:
    provider: openai
    account: null
    model: "org/summary/model"
server:
  port: 8080
  host: "0.0.0.0"
card_types:
  project:
    permitted_child_types: [goal, architecture, code, test, doc, data, research, ops]
    records:
      brief.md: {format: markdown, schema: card-brief.v1, writers: [analyst, planner], bootstrap: true}
      status.md: {format: markdown, schema: work-status.v1, writers: [planner, executor], bootstrap: false}
      review.md: {format: markdown, schema: work-review.v1, writers: [reviewer], bootstrap: false}
    workflow:
    entries:
      BACKLOG: {node: plan}
      CHANGED: {node: plan}
      BLOCKED: {node: plan}
      STOPPED: {node: recover, prompt: stopped-recovery}
    nodes:
      plan:
        agent: planner
        prompt: plan
        correction_prompt: correct-plan-result
        records: {status.md: updated}
        edges:
          complete_direct: {target: {terminal: DONE, promote: current, export_records: [status.md]}}
          admit_review: {target: {node: review}, prompt: plan-to-review}
          blocked: {target: {terminal: BLOCKED, promote: current, export_records: [status.md]}}
          failed: {target: {terminal: FAILED, promote: current, export_records: [status.md]}}
      review:
        agent: reviewer
        prompt: review
        correction_prompt: correct-review-result
        records: {review.md: updated}
        edges:
          approved: {target: {terminal: DONE, promote: current, export_records: [review.md]}}
          revision_required: {target: {node: plan}, prompt: review-to-plan}
          blocked: {target: {terminal: BLOCKED, promote: current, export_records: [review.md]}}
          failed: {target: {terminal: FAILED, promote: current, export_records: [review.md]}}
      recover:
        agent: planner
        prompt: recover
        correction_prompt: correct-plan-result
        records: {status.md: updated}
        edges:
          complete_direct: {target: {terminal: DONE, promote: current, export_records: [status.md]}}
          admit_review: {target: {node: review}, prompt: plan-to-review}
          blocked: {target: {terminal: BLOCKED, promote: current, export_records: [status.md]}}
          failed: {target: {terminal: FAILED, promote: current, export_records: [status.md]}}
# goal has an independent copy of the project-style workflow. Architecture,
# code, test, doc, data, research, and ops each have an independent one-node
# workflow in the generated default; aliases or missing types are not accepted.
```

The generated default preserves the visible project/goal plan-review loop and one-node execution workflows, but these are independent card-type artifacts rather than families. Edges are strict tagged objects; terminal edges choose ordered record exports and either the current accepted result or an earlier reachable node result. Configuration is required—there is no runtime family fallback.

Direct public OpenAI GPT-5.6 through the Responses API is selected by provider capability, not by a model-name heuristic. Public OpenAI Responses uses API-key credentials only; Codex/OpenAI OAuth auth profiles are a separate `openai-codex-backend` contract and are not aliases for public OpenAI API keys.

```yaml
models:
  default: ["gpt-5.6"]
providers:
  openai:
    models: ["gpt-5.6"]
    apiKey: "<openai-api-key>"
    baseUrl: "https://api.openai.com"
    capabilities:
      transportProtocol: openai-responses
      toolsMode: native
      exclusiveToolChoiceSupport: native
      streaming: true
      responsesReasoning:
        effort: medium
compaction:
  enabled: true
  input_budget_tokens: 120000
  summarizer_candidate:
    provider: openai
    account: null
    model: "gpt-5.6"
```

Compaction is a boot requirement, not an optional feature. `init` and `start --create-runtime` create generated project/runtime state but never synthesize model, provider, or compaction policy. Omitted, `enabled: false`, incomplete, or non-configured summarizer candidates fail startup. The candidate is an exact structured identity: `account: null` selects the provider-level implicit account, while `account: "_implicit"` and `account: "_"` select those exact explicit account names and remain distinct. Model IDs may contain slashes; there is no flattened compatibility spelling or fallback summarizer route. Autonomous static preparation uses the final ordered provider array—operational tools followed by the sole terminal `emit_result`—rather than the operational-only prompt array; Analyst prompt, provider, and preparation use one terminal-free operational array. The effective Analyst output request (`models.max_tokens.analyst`, then `models.max_tokens.default`, then 4096) must not exceed `floor(compaction.input_budget_tokens * compaction.completion_reserve_fraction)`. Startup acquires the lifecycle lock before full selected-config/environment validation, but completes that validation before any `--create-runtime` generated root-card read or publication; invalid configuration therefore creates or changes no generated root-card state. The operator must select a positive budget appropriate to the configured routes.

Configured MCP reconciliation must converge before runtime mechanics start. Startup installs the reconciled MCP invocation authority exactly once; reconciliation or later runtime-start failure aborts startup and is contained through the normal App terminal coordinator, without retry or configuration rollback.

Agent prompts use card-specific overrides at `.saivage/config/prompts/<cardType>/<agentName>.md`. Exact absence falls back to `.saivage/config/prompts/agents/<agentName>.md`, then the bundled generic template selected by `agents.<name>.prompt`; other read errors fail startup. Process prompts remain `.saivage/config/prompts/<cardType>/process/<identity>.md`. Every autonomous effective template includes `{{contractDescription}}` exactly once and does not hard-code `emit_result` fields or values.

```markdown
Perform the current configured executor node step. Follow its node/edge prompt context.
{{contractDescription}}
Use the generated Executor contract for this node exactly; the configured edge decides what follows.
```

The generated contract accepts strict parsed `{outcome,summary}`. Hidden correction keeps plain text, invalid outcomes, pending notifications, and stale/missing required records in the same node. `updated:true` compares the once-captured record version/revision baseline. Terminal routes claim before close/settlement/node cleanup and supervisor-owned publication through the exact activation owner; intermediate routes do not claim and clean the current executor scope before the next node.

Prompt overrides are durable operator configuration preserved by reset. Audit every named-agent override before deployment; startup fails rather than normalizing old role paths, `status` fields, or outcome values.

Skills are optional and on demand. `target_agents` contains exact configured agent names, and an agent may load skills only when its global contract has `skills: true` and lists `skill`. `.saivage/skills/index.json` is a strict JSON array whose entries contain exactly `name`, `file`, and `target_agents`:

```json
[
  {
    "name": "typescript-testing",
    "file": "typescript-testing.md",
    "target_agents": ["executor", "reviewer"]
  }
]
```

Files are exact normalized relative paths beneath `.saivage/skills`. Listing and loading are filtered to the caller's configured name; content is loaded only when requested. An absent index is allowed. Unknown fields or agent names fail strict validation, with no compatibility rewrite.

Current card IDs use parent-local spreadsheet segments (`card-a`, `card-b`, ..., `card-z`, `card-aa`; nested parents restart at `a`). Every creation starts at `a` and directly attempts exclusive creation of each exact candidate namespace, advancing only when that `mkdir` returns `EEXIST` and never inspecting or enumerating the collision. A successful namespace claim remains consumed even if publication or linking later fails; membership begins only after complete initial publication and the parent's cumulative `children` array append.

Card streams use only format v2. One strict `cardRecordSchema` defines the current card record everywhere it appears, including card-version rows, embedded history snapshots, and tombstone final state. Current, history, and tombstone snapshots have one status authority at `lifecycle.status` and have no top-level `status`, persisted `parent`, persisted `depth`, `allowedActions`, or `position`. The complete cumulative parent `children` snapshot is the sole linked-membership and semantic sibling-order authority, including retained tombstone links. Directory creation claims identity, complete initial publication proves the child, and only the later single parent append grants membership and places it in order. A real active reorder is likewise one parent append: requested active IDs come first and retained non-active links follow in their prior relative order; an active-order no-op writes nothing. Generic card patches cannot write `children` or lifecycle.

Card status rules are operation-specific, not one universal terminal taxonomy. Blocked work remains unresolved and can be re-entered by its exact parent through `activate_card` and configured `BLOCKED`; stopped work is reused only by explicit activation through `STOPPED`. See the [functional specification](docs/spec/system-specification.md) and [architecture](docs/architecture/system-architecture.md) for the authoritative contracts.

Operator Card APIs are granular. A hierarchy request returns only one active parent and its active immediate `{id,title,type,status}` children in committed order; it does not expose raw links or inspect grandchildren, and a tombstoned link terminates there. The browser gives every newly displayed child an undiscovered disclosure control and requests that child's one slice only on interaction; an empty response confirms a leaf. Deep links reveal one ancestor slice at a time. Card detail contains only displayed identity, lifecycle, version, urgency, timestamps, and allowed actions—no records, dependencies, assignment, start, notes, or child arrays. Compiled record descriptors and one exact latest closed record are separate Card endpoints and owners. The Records panel no longer routes through generic Files, while the independently mounted Files workspace remains available. A fixture with many grandchildren instruments hierarchy opens to enforce this one-level cost boundary.

Canonical card state lives in `card.jsonl`. Each card type's compiled workflow defines an ordered set of safe Markdown record names, exact schema identity, named writers, and exactly one bootstrap record. Each name maps directly to its card-owned stream; `card.jsonl` remains distinct. Default names such as `brief.md`, `status.md`, and `review.md` are examples, not a closed registry.

Generated card state uses exact append-only streams. The root lives at `.saivage/cards/project/{card,brief}.jsonl`; each child adds its claimed spreadsheet segment beneath the parent's `children/<segment>/` namespace, with `card.jsonl`, configured record streams, and exact `conversations/<agent-name>.jsonl` files. Exclusive child-namespace creation is claim authority, while the cumulative `children` array is the sole membership authority. Card streams contain exactly `card-version` rows followed by at most one terminal `card-tombstone`; every version and tombstone retains the initial immutable card type. Tombstones make card-domain detail/history/version/diff/record reads opaque, but an already known exact Agent conversation remains directly readable and appendable. Records use logical versions plus contiguous stream revisions. Normal reads follow committed links and exact paths without enumerating child, version, record, session, or temporary siblings; incomplete and complete-but-unlinked child namespaces remain invisible. Stable sessions use the compiled global Analyst and card workflow agents. Known-successful conversation publication emits exact last-row conversation freshness; first publication additionally emits the applicable lossy membership-reconciliation hint. Inventory derives only present compiled candidates from the global Analyst and active linked cards, while exact known-session reads retain historical access. The former external chat integration and its dynamic Analyst identities have been removed completely. Multi-root subtree deletion performs one whole-set dependency/permission preflight and a deterministic dependent-before-dependency, child-before-parent tombstone order; an append I/O failure may leave only a valid committed prefix with no uncertain-append effects. Every replacement/first publication uses a fresh exclusive same-directory UUID temp under ordinary umask. Reset requires stop → back up and manually make preserved inputs current → current-built `saivage reset` → start, removes exactly `.saivage/cards`, `.saivage/agents`, `.saivage/logs`, and `.saivage/work` wholesale, and republishes only the current format while preserving configuration, credentials, prompts, source, skills, and docs. Generic Files behavior is unchanged.

Growing-file persistence classifies and, when necessary, truncates/fsyncs an unterminated suffix before fatal UTF-8 decoding, then parses bounded newline frames with positional replay checkpoints. Truncate or immediate fsync uncertainty uses the existing fatal publication signal and permits no close or follow-up; successful publication resumes ordinary parsing and close. Compact conversation validation retains IDs and fixed classification/pair/round/segment/boundary facts rather than source content, and replays exact envelope spans for compaction hashes. A separate first-envelope reader plus shared bounded prefix validator stops before later history. Agent inventory, card-session inventory, and exact Agent summary reads use that first-envelope path; transcript and bounded tool content use the complete strict fold.

Agent inventory contains strict durable-only summaries derived from compiled workflows and active linked cards. It has no activity, pending-call, model, message-count, app-log, or runtime-snapshot decoration. Exact known-session summary and transcript reads retain historical access after tombstone, but never reinsert that session into active membership. `GET /api/chat` returns only the configured global Analyst identity; the generic Agent resources provide its summary and transcript.

The four reset-owned roots are also the initial-publication presence boundary. When no canonical project namespace exists, any object at one of them blocks a new root card; a non-directory or symlink at exact `.saivage/cards` is classified before child access. A valid canonical root card with a strict current-format two-kind stream is accepted directly rather than triggering a four-root health scan.

Card type is selected at creation and is immutable for the card's entire durable lifetime. Directory-owned child claiming, the two-kind card stream, removal of card `position`, complete parent-owned `children` membership/order, and the type invariant are reset-only durable changes: every rollout unconditionally requires each deployment to stop, preserve configuration, credentials, operator inputs, source, skills, instructions, and canonical documentation, run the current built `saivage reset` to replace generated persistence wholesale, and then start the current binary; no compatibility check or apparently unchanged history exempts an installation. Generated streams containing old `card-child-reservation` rows are unsupported and rejected, never compatibility-read or migrated. A successful candidate `mkdir` consumes its segment even if later publication or linking fails, and only the parent's committed cumulative `children` snapshot grants and orders membership.

MCP server entries in `.saivage/saivage.yaml` are strict transport variants. A `transport: stdio` entry requires a nonempty `command` and may also define `args`, `env`, `disabled`, and `autostart`; it must not define `url`. A `transport: streamable-http` entry requires an absolute `http://` or `https://` `url`, may also define `disabled` and `autostart`, and must not define `command`, `args`, or `env`. Unknown and cross-transport fields fail configuration validation, and disabled entries still require their transport's complete shape. Stdio entries inherit only the shared safe command environment (`PATH`, `HOME`, `USER`, `LANG`, `TERM`, and `LC_*`), not ambient Saivage, provider, or deployment credentials. Declare every required non-base variable explicitly in that server's `env`; explicit entries override inherited base values. Before starting the current binary, operators must directly correct every invalid entry; there is no compatibility syntax, migration, or fallback interpretation.

Existing deployments must rename `.saivage/saivage.json` to `.saivage/saivage.yaml` with `mv`, not `cp`. If both files exist, startup fails and directs the operator to delete the obsolete JSON because it may still contain provider credentials. After the rename, operators may rewrite the file to idiomatic YAML and optionally add prompt override files under `.saivage/config/prompts/`.

Start Saivage from the target project directory:

```bash
SAIVAGE_API_TOKEN=test "$SAIVAGE_BIN" start
```

Open the web UI at `http://localhost:8080/`, or check the two public probes with:

```bash
curl http://localhost:8080/health
curl http://localhost:8080/health/ready
```

Every `/api/*` operator contract uses the operator-session boundary. When `SAIVAGE_API_TOKEN` is configured, send it only as a bearer header, for example:

```bash
curl -H "Authorization: Bearer $SAIVAGE_API_TOKEN" http://localhost:8080/api/processes
```

Omitting `SAIVAGE_API_TOKEN` intentionally runs development auth-disabled mode, in which those same operator-session routes accept headerless requests. Never place the token in a URL.

## Current documentation

| Link | Authority status | Reader guidance |
|---|---|---|
| [Functional specification](docs/spec/system-specification.md) | current functional authority | What Saivage must do from the user and runtime point of view. |
| [Operator UI specification](docs/spec/operator-ui.md) | current UI functional authority | Analyst panel, projection-oriented workspace with explicit Dashboard Stop/Restart exceptions, UI mutation boundaries, and contextual navigation. |
| [Architecture](docs/architecture/system-architecture.md) | current architecture summary | How the functional model is organized into runtime, agents, storage, API, and UI subsystems. |
| [README](README.md) | current validation and documentation authority map | Quick start, validation profiles, and this canonical documentation map. |

Recovery from a dirty shutdown guarantees only that the reconstructed runtime is internally structurally consistent and runnable; semantic completeness is best-effort and is not guaranteed (a stopped card may resume, a done card may reactivate if its trace was lost, a duplicate activation is harmless). Explicit Run selects the complete linked project-rooted running chain without installing actors, derives each card's deterministic named sessions from its compiled workflow, stabilizes every eligible conversation leaf-to-root, publishes every participant `stopped` leaf-to-root, and starts only project through configured STOPPED. An unmatched parent `activate_card` is settled as ordinary interrupted outcome-unknown work; terminal child results are never reconstructed or replayed. A partial reset is not atomic: the first error stops the attempt, and a later Run freshly selects the remaining running prefix or stopped project. Stopped descendants remain inactive until an exact parent `activate_card` reuses their identity through STOPPED. Intervention-ready Analyst configured-record/card edits and immediate-parent named-agent edits preserve stopped.

Conversation and app-log mutation use direct synchronous domain-owner functions. Stable role conversations are append-only: compaction never replaces a version or writes a cache. Planner, reviewer, executor, and Analyst persisted turns all use the singular prepared conversation actor. Each autonomous activation carries one exact prompt/tool budget; each Analyst submission prepares its exact rendered prompt, ordered tools, configured output request, and temperature before source publication, then retains that prepared value across tool continuations. Candidate admission uses a best-effort canonical-body byte/4 heuristic, while providers remain authoritative. One first-pass rejection backed by strict structured input-context evidence and no accepted output may force one strictly reducing compaction append and one fresh ordinary route pass under the same input identity; for an Analyst continuation, an already accepted tool effect and its one persisted result remain outside this seam and are never replayed or duplicated. A second rejection or clean no-smaller result is terminal, with no third pass or route-by-compaction expansion. Direct, nonpersisting summarizers remain unprepared, fixed to the one Registry-validated configured candidate, and receive no self-compaction or replay; summary attempts retain distinct summary-session/input app-log evidence. Durable policy stores only policy inputs plus the otherwise unreconstructible static estimate, not derived completion/threshold/window values. The minimal ordered summary-group payload and strict marker-first Analyst source format are reset-only cutovers: stop the service, preserve configuration, credentials, operator inputs, source, and documentation, run the current built `saivage reset`, and start the current binary. Old generated conversations are not migrated or compatibility-read.

Every production provider attempt unconditionally verifies its canonical request plan before the one generic capability check or any credential side effect. An integrity mismatch fails the whole invocation without recovery or failover. The capability-selected closed protocol adapter carries its credential requirement into delayed per-attempt resolution, and admission, retries, hashing, and send reuse the same canonical serialized bytes. Invocation Service has one unconditional path through the shared attempt runner, with the candidate plan as the sole request authority. The selected adapter directly consumes the successful fetched response; structured recorder evidence does not buffer or capture its raw body.

The application log has one strict `{type,data}` row union with only `event`, `control_action`, and `provider_exchange` lanes. Event kinds are exactly `runtime_diagnostic`, `runtime_actionable_error`, and `mcp_tool_invocation`; Debug Errors derives both runtime kinds and failed MCP invocations. Preparation, validation, directory, and acquisition failures remain ordinary. The direct append/replacement primitive alone creates `PublicationOutcomeUnknownError` after canonical mutation becomes uncertain; catches preserve that exact object until immediate fatal delivery, with no read, retry, second append, failed result, later attempt, write, hint, halt, API response, or WebSocket frame.

`EventQueryService` is the sole event/error reader. `/api/events` supports strict oldest-page or newest-tail selection with a maximum of 1000. Debug requests events only while Timeline is selected and errors only while Errors is selected; hidden tabs have no eager fan-out or registrations. MCP loads once on selection and never polls. There is no EventBus, generic read-model broadcaster, `/api/debug/timeline`, dedicated error lane, or content-supervision surface.

This format/config cutover is unconditional. For every deployment: stop the matching service, back up and preserve configuration, credentials, identity, prompts, instructions, skills, source, and canonical docs; manually remove the top-level scanner-only `security` section and unknown/deleted model-role keys; validate skill targets as exactly `executor | reviewer | analyst`; run the current built `saivage reset` over the four generated roots; then start the current binary. Never restore an old app log or old generated state. There is no migration, normalization, mixed-version startup, or binary-only rollback.

## Key concepts

| Link | Authority status | Reader guidance |
|---|---|---|
| [Functional specification](docs/spec/system-specification.md) | current | Start here for product behavior and runtime semantics. |
| [Operator UI specification](docs/spec/operator-ui.md) | current | Use for UI behavior and Analyst integration details. |
| [Architecture summary](docs/architecture/system-architecture.md) | current | Use after the functional spec for design orientation. |
| `docs/working/<date>/` | local, ignored | Temporary working documents and plans; not committed to git. |

## Verification

`npm run lint` keeps stamp-producer checks, ESLint, and web-component boundary checks as gates. The backend import-boundary scan currently reports accumulated debt as advisory findings; this is not a permanent waiver of the intended package boundaries.

Run the validation profile that matches the change type. The checked-in GitHub Actions workflow at [`.github/workflows/validation.yml`](.github/workflows/validation.yml) runs only on pushes to `master`. It is least-privilege and secret-free (`contents: read`, no `secrets.*` or token-like env assignments), cancels superseded runs for the same workflow/ref, and sets up Node.js 24 with npm caching. The `routine-docs` job runs `npm run validate:routine` and `npm run validate:docs` on every selected push. A fail-closed `classify-changes` job gates `backend-jest-build`, `ui-vitest`, `browser-smoke`, and `dependency-hygiene` by changed paths. The `backend-jest-build` job performs the dual clean install—root `npm ci`, then web `cd web && npm ci`—before the root build and Jest suite. For every applicable UI path, `ui-vitest` runs exactly `npm run web:typecheck && npm run web:test`; browser smoke remains a separate Playwright job. Dependency hygiene applies to package/workflow pushes (including fail-closed full validation) and runs the production `npm run audit:security` gate.

```bash
npm run validate:docs
npm run validate:routine
npm run validate:ui-smoke
npm run validate:ui
npm run validate:release
```

Root `npm test` is the complete non-E2E backend authority. It runs the ordinary parallel Jest set first, followed by the exact serial real-terminal-child suite after the ordinary workers exit. Use `npm run test:parallel -- <Jest arguments>` or the unchanged `test:direct` helper for focused tests in the ordinary Jest set; that set excludes the real terminal-child suite. Use `npm run test:terminal-child` as the focused command for that exceptional suite. `validate:release` and the `backend-jest-build` CI job continue to invoke singular `npm test`, so both phases remain part of their backend authority.

For Debug Graphs changes, run the strict projection/handler tests, the Graphs store/SVG tests, and the operator browser smoke before broader profiles:

```bash
npm run test:parallel -- tests/runtime/card-process/compiled-graphs-projection.test.ts tests/server/operator-files-debug-handlers.test.ts --runInBand
(cd web && npx vitest run src/__tests__/debug-graphs.test.ts src/__tests__/debug-view.integration.test.ts)
npm run web:test:operator-smoke
```

`npm run validate:docs` is the docs-only validation profile: it runs the documentation drift guards (`npm run docs:verify`) and intentionally excludes `npm test` and `web:test:operator-smoke`. `npm run validate:routine` runs TypeScript typechecking, the canonical-persistence drift guard, and documentation verification; it does **not** run backend Jest. Backend/runtime changes, especially managed-process changes, therefore require explicit focused Jest plus `npm test` (or `npm run validate:release`). Central operator card-read/API changes also require explicit `npm run test:e2e`; this suite is not implied by the default backend Jest profile. `npm run validate:ui` runs web typechecking, the complete `web:test` Vitest authority, and the separate operator browser smoke; it does not use a curated sweep. `validate:ui-smoke` runs the browser smoke, while `validate:release` adds typecheck, build, default non-E2E backend Jest, browser smoke, and docs verification. The `web:test:operator-smoke` gate includes the production browser direct-load route smoke for the operator `/dashboard`, `/cards`, `/agents`, `/files`, and `/debug` views. `tests/playwright/smoke/cards-independent-scroll-selection.spec.ts` remains the normal Cards smoke authority and is included by the existing script; no separate spec path or validation profile is required. Its Cards cases cover filter-free desktop independent tree/detail scrolling, auth-banner geometry, mobile single-pane/Back behavior, one root request and baseline-only socket open per reconfiguration identity, exact lazy expansion paths, bounded cold deep-route ancestor requests and continuation after relevant refreshed membership, rapid route-reveal supersession without cancelling shared children work, disjoint hierarchy/detail authority, loaded-scope reconnect healing without hidden/unselected fan-out, retained stale data with explicit exact Retry and no automatic request, state-dependent authored-record 404 behavior and old-selection completion exclusion, exact-slot close refresh, canonical literal `to=current` diffs independent of detail ordering, detail-failure isolation, and canonical record-link navigation. Request assertions prohibit the bare `/api/cards` collection request, broad/global Cards refresh, unrelated branch reads, and unselected record/history/diff requests. Playwright always starts and owns a fresh fixed-port preview server for this gate; an existing listener causes a port-conflict failure rather than reuse of an unknown server or stale build.

The same Cards browser authority covers obsolete/missing detail recovery, one responsive **Back to Cards** action with ordinary browser history, complete selected-card teardown and invalidation/reconnect suppression, independent hierarchy refresh, and retained tree identity after detail 404. `tests/playwright/smoke/card-status-presentation.spec.ts` is the card-status presentation regression authority for computed stopped/running/done/cancelled styling and representative tree, detail, and Dashboard layout; it is included in `web:test:operator-smoke` and is also discovered by the complete preview-smoke profile.

`npm run web:test:e2e:smoke` runs the complete self-contained browser profile: every production-preview smoke test plus the one source browser-client test. The preview owner builds and starts the production preview server; the browser-client owner starts the Vite dev server because that test imports source modules directly. Neither owner contacts a live Saivage deployment. Run the external suite separately with `npm run web:test:live-getrich-v2`; it has a reachable deployment prerequisite and defaults to the recorded GetRich v2 deployment. Set `SAIVAGE_LIVE_BASE_URL=http://host:port` to override that target.

After a failed or cancelled CI browser-smoke run, one best-effort artifact upload preserves `tmp/playwright-report` and `tmp/playwright-results`; missing output only warns, so cancellation before browser output does not replace the original job conclusion.

Agent resources are granular. Agents and the selected Debug Agents tab acquire the global acknowledged lease and partition the baseline by global/card scope. Card Conversations acquires only its selected card's lease and `/api/cards/:id/agent-sessions`; it never requests global inventory. Exact conversations use opaque cursor tails under a conversation lease. Raw Exchange has an independent exact session lease, performs no REST read before acknowledgement, and accepts only populated `200` or the exact no-exchange `404` baseline. Summary/list/detail reads prefix-validate only the first envelope and read no app log or runtime snapshot; complete transcripts retain strict compact validation and the durable sole-final-unmatched-call rule. Membership hints cause authoritative partition replacement, not blind upsert/remove, and every first card conversation emits a reconciliation hint after known success. Canonical Agent provider-exchange evidence emits exact exchange freshness; `summary:*` evidence remains durable without an Agent hint. Provider/model and liveness/activity fields are absent from Agent summaries and appear only in explicit exchange metadata.

Application bootstrap reads only runtime/project state and the root Card hierarchy. Debug owns only its selected tab: Doctor is manual, Agents owns the Agent lease only while selected, and MCP loads its one nested server/tool hierarchy without polling. Dashboard and hidden Debug tabs make no Agent, event, or MCP request. The obsolete `runtime.cardRuns`, `processes.get`, and `mcp.status` operations are removed; process navigation uses the process-list-backed Debug tab, while generic Files remains independently mounted.

`web:test:operator-smoke`, and therefore `validate:ui-smoke`, `validate:ui`, and `validate:release`, also includes a real non-loopback plain-HTTP live-sync conversation scenario. Its validation host must expose a non-internal IPv4 interface that local Chromium can reach. If none is available, the gate fails with a clear prerequisite error rather than skipping or substituting localhost; this is validation-host guidance, not a production HTTPS or network requirement.

The backend build gate and `validate:release` run a post-build compiled prompt-composition smoke after copying `src/prompts` to `dist/prompts`. Run `npm run test:compiled-prompt-composition` to repeat that focused packaged-layout check against existing build output.

To use a locally installed Chrome for release validation, run:

```bash
PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/absolute/path/to/chrome npm run validate:release
```

Omitting the variable preserves the managed-browser default. This is local validation configuration only, never checked-in service configuration.

The GitHub Actions `dependency-hygiene` job runs `npm run audit:security` when its push path classification applies. Operators can also run that gate and the broader local-only dependency governance review directly with:

```bash
npm run audit:security
npm run deps:review
```

For final stage/release gates, run the underlying checks directly when requested:

```bash
npm run docs:verify
npm run typecheck
npm run build
npm test
npm run test:e2e
npm run web:test:operator-smoke
```

The canonical docs listed above are current authority. `npm run validate:docs` is the documentation drift gate for keeping those docs, links, source anchors, validation cadence, and source-derived route/tool/config inventories in sync.
## Publication-fatal exits

If Saivage reports `PublicationOutcomeUnknownError` on server stderr, it exits
immediately without cleanup or a runtime `error` transition. Follow the
[operator runbook](docs/runbook/index.md) for positive dead-owner verification and
manual abandoned-lock repair. Ordinary halt/containment failures still use the
documented runtime `error` state. Publication primitive, child-process fatal-delivery,
process-drain, and source-inventory assertions are part of the focused validation
surface before the broader profiles below.
