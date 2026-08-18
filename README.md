# Saivage v3

Conversation persistence uses deterministic configured-session indexes and immutable versioned JSONL segments. Ordinary first publication creates v1; compaction publishes a self-contained N+1 segment and retains prior segments as history. This is a reset-only format cutover.

> **Want to try Saivage?** Launch your favorite AI agent and point it to
> [README-IF-YOU-ARE-AN-AI.md](README-IF-YOU-ARE-AN-AI.md). It will guide you
> through requirements, project specification, LXC setup, credentials, startup,
> and verification while explaining each step as it proceeds. This README has
> not yet been polished for direct human consumption, so the AI-guided setup is
> currently the preferred way to get started.

Saivage v3 is an autonomous multi-agent runtime for software-development work. A top-level planner decomposes goals into cards, executors perform scoped work, reviewers verify results, and the operator workspace projects cards, agents, files, strict app-log events/derived errors, runtime state, and read-only compiled workflow diagrams while the Analyst chat is the ordinary mutating user surface, with direct Dashboard **Stop project** and confirmed bearer-only **Restart server** as bounded exceptions. Debug > Errors—not Dashboard—is the durable command, activation, actionable, and runtime-error surface. Debug > Graphs shows one accessible effective startup workflow per card type; it is visualization only and never edits or reloads configuration.

Configured planning and terminal workflows are genuine micro-actors. Startup compiles one immutable semantic state table per card type: lifecycle entries, configured nodes, and terminal sinks become states, while every transition carries one target identity plus non-target route semantics. BaseActor, execution, and Debug Graphs consume that same table without a second actor definition or node/edge index. Same-node edges are explicit external reentry. Node corrections remain hidden inside one state task. Promptless ordinary entries add no lifecycle message; STOPPED adds the discarded-position recovery statement and its configured prompt. Live state and zero-based node ordinal are transient only—there is no graph interpreter or durable cursor.

Structural compilation also freezes expanded ordered model IDs and exact scope-aware operational tool references. Startup installs one immutable binding for the selected Analyst and every card agent used by those state tables; execution and Debug Graphs use that installation as their sole model/tool authority. Card capability admission includes generated `emit_result` last, while Analyst remains terminal-tool-free. Invocation only attaches current scope closures and never re-expands routes or reselects configured names. The exact default operational inventories are Analyst 43, Planner 20, Reviewer 12, and Executor 17 tools; the outbound/presenter identity union is 46 (the 43 Analyst identities plus planner-only `edit_card` and `activate_card` plus terminal `emit_result`).

Runtime execution state is process-local. The acquired lifecycle lock supplies one stable PID/start identity for the server process, and the scheduler-owned active leaf supplies the exact current card; runtime state/status project those facts on demand without an application cache or inventory/session inference. `saivage status|pause|resume|stop` delegates only through a verified live lifecycle-lock owner's published non-null origin/auth mode; it never reads a runtime-state file or rediscovers an endpoint from config. CLI `stop` maps to resumable non-domain project halt `stop_project`, which never cancels or mutates cards. A delegated live halt returns `contained:true`; missing/dead or no-runtime Stop returns `contained:false`. Auth-enabled confirmed `restart_server` is the separate terminal operation.

Ordinary activation state, transition, persistence, and lease coordination is callback-free supervisor state: one `activationOwners` map contains plain owners in exactly `prepared_root | child_admission | active | settling`. The sole narrow callback exception reports a terminal `CardProcessActor` main-loop failure to the exact current/frozen owner. One nullable supervisor halt record freezes an exact owner snapshot and carries the shared interruption/promise for Stop, application close, and actor-main invariant failure. Outcome-unknown durable publication exits through the injected fatal boundary before this halt or any status mutation. `CardProcessActor` remains the micro-actor; `ConversationLLMActor` is a direct provider/tool phase state machine.

The direct Conversation LLM owner has no `BaseActor` queue or lifecycle. Analyst turns have no cancellation surface or hidden cancellation winner; application teardown directly disposes their owners and joins completion, including already-entered result and publication effects. Every autonomous and Analyst LLM tool call uses the complete LLM-owner-built invocation context; an admitted child lease makes the exact planner wait until supervisor structure/currentness is released and invalidated. Runtime halt synchronously interrupts every admitted wait and owner settlement before any processor join, then clears only after complete volatile quiescence. A failed actor main rejects its activation and lifecycle locally with the exact caught value, cannot restart, and synchronously starts or joins that same halt. A failed join retains the frozen graph in `error` and requires service restart; a successful halt leaves durable `running` recovery input for the next Run. The supervisor directly implements runtime control, including Run preparation/launch, gate mutation, and process-local Analyst intervention admission. One Supervisor status field begins at internal `uninitialized`, becomes public `stopped` only after successful startup validation, and thereafter supplies both public lifecycle status and the stopped/settled-paused intervention assertion; there is no readiness binding, cache, or initialization flag. This admission is unrelated to HTTP `GET /health/ready`. Composition exposes one `RuntimeApi`. Natural root completion atomically retires a pending or settled Pause before publishing stopped; Dashboard disables Stop in `closing` and enables it in `error` to report the retained non-retrying failure.

`App.stop(): Promise<ShutdownReport>` is the sole production aggregate teardown API. Its App terminal coordinator synchronously attempts every admission closer, then independently attempts flat runtime, Analyst, MCP, transport, subscription, and lifecycle-lock leaves under one referenced ten-second per-leaf bound. The runtime closer starts or joins the same supervisor halt and its cleanup leaf awaits it; it never calls project Stop or creates duplicate runtime termination. Reports expose only fixed component/code warnings and must be inspected by direct callers; even an empty report does not prove process exit or full OS containment. Signal/restart/startup adapters log safe warnings and preserve normal process behavior.

Provider candidate availability is live process-local routing advice and resets on process restart. Auth profiles use direct strict canonical-file reads and complete `replaceFile` publication. OAuth refresh carries the original invocation abort signal through response/body completion and the final no-await reread/replace; concurrent refresh is deliberately optimistic last-completed-write-wins with no repository, revision/CAS, mode enforcement, or persistence-health machinery.

**Files security:** Operator Files has two concerns in a fixed order: admission/classification, then either the generic resolver or the canonical-card virtual read model. Traversal/outside-root rejection and canonical `work:///` validation/path derivation run first; lexical blocked-source policy then returns 403 or omits a listed child without classifier filesystem I/O; only allowed sources undergo lexical card reservation and bounded symlink classification. Allowed project or validated-work aliases into `.saivage/cards` are opaque (404 or omitted), while conclusively non-card aliases retain generic lexical and real-target blocking. Those deliberate policy/reservation omissions remain distinct from generic metadata projection: only exact requested-target `ENOENT` is absence and only exact reached-child `ENOENT` is a disappearance omission; other metadata failures fail the request opaquely rather than returning an incomplete listing. Card storage is browsable only as the linked virtual subtree: `.saivage` receives a synthetic `cards` row, parent/child directory rows use canonical card `updated_at`, and fixed artifact rows use descriptor metadata rather than physical directory discovery. Fixed-file listings are metadata-only; explicit content reads are strict and bound to one no-follow descriptor. Physical unlinked namespaces are never browsable, and there is no scan, cache, repository, or physical fallback. Explicitly redacted generic paths are read only for an outbound-redacted projection.

**Operator egress:** Backend-owned typed projectors preserve structural identity while redacting only schema-classified prose, secrets, URLs, and opaque leaves. Effective config structurally omits provider/account `baseUrl`, replaces provider/account API keys and every stdio MCP environment value regardless of key spelling, and retains each streamable-HTTP MCP URL only after `redactUrl` removes userinfo credentials, query contents, and fragments. Files recognizes the startup-selected config through its admitted lexical path or resolved alias and renders projected effective config; all other admitted work text, including process logs and webfetch stashes, receives text defense. Card hierarchy, displayed detail, compiled descriptors, exact record content, runtime breadcrumbs, tools, history, and diffs each validate their own strict redacted projection; card diff specifically contains required strict `{field,before,after}` recursive-JSON rows. Hierarchy exposes no raw links and detail exposes no dependency, assignment, start, note, or bundled-record fields.

The invocation projector recognizes the exact 43 Analyst tools, including `reopen_card` and `read_record_version`, planner-only `edit_card`/`activate_card`, and terminal `emit_result` (46 identities) for call arguments. Unsupported, malformed-JSON, and schema-invalid known calls remain readable without invented mates. Durable results use only the generic strict success/failure envelope; optional `data` is opaque and every known or unknown tool uses the same recursive outbound redaction rather than a named-result parser. Historical Analyst arrays/wrappers and `emit_result` payloads remain valid under `data: unknown`, with no migration or compatibility branch. Current workflow-owned terminal settlements are separately parsed beside `AgentNodeExecution` immediately before each direct append/settlement, without changing ordinary tool, MCP, provider, acceptance, publication-fatal, record, or cleanup contracts. Complete Agent conversations permit zero or one unmatched tool call only when it is the final durable source row. That prefix has no active, waiting, pending, or snapshot meaning. Bounded `read_agent_session` validates the complete stream before keeping its exact suffix and counts, without expanding the suffix to recover a matching call.

Provider exchange, event, and control rows are source-projected before publication and on read. Provider endpoint scheme/host/port/path and adapter identity remain exact while userinfo/query/fragment are removed. MCP tools expose one displayed server/tool hierarchy with nested direct statistics and omit integration errors, descriptions, schemas, annotations, `_meta`, duplicate flat inventories, and a duplicate all-stats table. Every `webfetch` result exposes `redacted_url` and no raw URL, and durable call rows expose no raw query.

Authored records use one reusable current URL, `record:///<name>?card=<id>`, for reads, writes, edits, and record-targeted Webfetch saves; only ordered numeric `&v=N` addresses immutable history. A first admitted write creates an absent dynamic record, subsequent mutations resolve or reuse its current draft, and framework acceptance—not a client head token—closes card-agent drafts. Saved Webfetch text preserves plain/project/tmp/system destination identity in a nested workspace result; record saves instead nest the strict record mutation result. Audited Analyst record saves preflight before the sole network request and recheck cancellation, intervention readiness, and fresh full current admission after it. Denial, open conflict, absent edit content, unchanged/invalid edit, empty result, and unavailable canonical state remain structured failures.

An authoritative provider content-policy refusal during autonomous card work receives exactly one fixed safety-respecting reframing row and one admitted retry pinned to the same provider/account/model. A second refusal stores one strict marker containing only the second terminal raw provider response, publishes both passes' safe diagnostics, and settles the card BLOCKED with a safe nested parent result. The first raw response, request conversation, and generated paraphrases are absent from the marker, parent result, Dashboard, and rendered Agent conversation. Analyst refusals remain terminal after one call and receive no automatic retry. Dashboard obtains only a read-derived refusal high-water/latest projection and links to the exact redacted Agent row.

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

`init` reads project identity to select a bound or bootstrap-unbound lock record, exclusively publishes that init lifecycle lock, publishes missing `.saivage/saivage.yaml`, loads and validates configuration/workflows, and conditionally creates and binds identity. It then classifies generated state. Four absent generated roots permit the singular initial-runtime publisher to create project authority and the global Analyst conversation. Existing state enters strict startup admission only through required current-format project card and bootstrap record streams; partial required publication and old or mixed formats fail reset-required. A nonempty canonical linked-card projection, active dependencies, compiled workflows, and parent/type admission are validated before exact-missing conversation indexes are initialized. Every declared bootstrap record stream must already exist from card creation; startup never recreates one.

The pre-acquisition identity read does not mutate. A known-unsuccessful exclusive open publishes no lock; failure after that open is outcome-unknown and may retain the lock. After successful acquisition, ordinary failure releases the exact current bound or bootstrap-unbound lock but preserves completed config, identity, and generated durable effects, including identity after create succeeds but lock binding fails. Card, authored-record, and conversation streams are strict: missing, malformed, unreadable, schema-invalid, or identity-mismatched complete stream state blocks startup directly, without truncation or repair. Startup's explicit conversation owner alone may truncate bytes after the final newline when the retained nonempty complete prefix fully validates; uncertainty from attempted truncation is fatal and authorizes no follow-up operation. A generated-publication failure may leave retained partial state. The explicit remedy is to stop Saivage, run the current built `"$SAIVAGE_BIN" reset`, and retry `init`; do not selectively delete roots or expect `init` or `start --create-runtime` to repair them. There is no `init --force`.

Before starting, configure the required global named-agent catalog, selected global Analyst, named model routes, and the project's card-type source in `$TARGET_PROJECT/.saivage/saivage.yaml`. The source contract permits exactly `card_type_set: <name>`, a complete `card_types` map, or omission of both, which selects `standard`. The two keys are mutually exclusive. An explicit malformed or unknown set fails directly; it never falls back to `standard` and never merges with an explicit map. Bundled sets contain complete card types, workflows, and record declarations only; agents, model routes, providers, compaction, server, and MCP remain global configuration. `ResolvedConfigAuthority` consumes the source choice once and supplies one complete effective `card_types` map to all compiler/runtime and outbound effective-config consumers.

| Selection | Purpose |
| --- | --- |
| omitted or `card_type_set: standard` | Stable default: unchanged project/goal plan-review flows and one-node execution for the other seven types. |
| `card_type_set: specialized` | Opt-in purpose-specific code, test, research, data, architecture, and planning flows; doc and ops remain one-node. |
| complete `card_types` | Advanced replacement of the entire map; never an overlay on a bundled set. |

To opt in, stop the service, set `card_type_set: specialized`, and start a new process. The engine does not branch on the set name: it compiles one complete map and uses it everywhere, including read-only Debug Graphs and record descriptors. Under specialized, project/goal/architecture expose `brief.md`, `status.md`, and `review.md`; code/test/doc/data/research/ops expose `brief.md` and `status.md`. Record tabs and history always follow those selected compiled declarations rather than a fixed UI list.

An explicit complete map must contain the fixed reserved `project` root entry and may contain any number of non-root names matching `[a-z][a-z0-9-]{0,63}`; only `project` is reserved, so `global` is a valid ordinary card type. Every `permitted_child_types` reference must name another entry in that same complete map, be unique, and must not be `project`. Agent names are global configuration identities, not code-owned roles. Every agent owns one generic prompt reference, exact ordered tools, model route, skill capability, session scope, and child-creation ceiling. Every effective card type independently owns its permitted child types, records, bootstrap record, lifecycle entries, nodes, outcome edges, exports, and result promotion. Unknown fields and unclosed references fail startup.

The following abbreviated shape shows the normal source contract. `saivage init` publishes `card_type_set: standard`; that selector resolves to the nine standard definitions in this order: `project`, `goal`, `architecture`, `code`, `test`, `doc`, `data`, `research`, `ops`.

```yaml
agents:
  analyst: {prompt: analyst, tools: [read, write, edit, skill, create_card, get_status, reconfigure], record_writes: [brief.md], model_route: analyst, skills: true, session: global, can_create_children: true}
  planner: {prompt: planner, tools: [read, write, edit, create_card, activate_card], record_writes: [brief.md, status.md], model_route: planner, skills: false, session: card, can_create_children: true}
  reviewer: {prompt: reviewer, tools: [read, write, edit, skill], record_writes: [review.md, review-*.md], model_route: reviewer, skills: true, session: card, can_create_children: false}
  executor: {prompt: executor, tools: [read, write, edit, run_command, skill, mcp_tool_call], record_writes: [status.md], model_route: executor, skills: true, session: card, can_create_children: false}
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
card_type_set: standard
```

This example intentionally abbreviates each tool list, but capability booleans remain exact: the Analyst lists `skill` and has `skills: true`, while Planner has `skills: false`.

As the mutually exclusive advanced alternative, remove `card_type_set` and provide the complete map directly. The following is only a structural excerpt; a selected source map must include every referenced definition and each definition's complete workflow and records:

```yaml
card_types:
  project:
    permitted_child_types: [goal]
    records:
      brief.md: {format: markdown, schema: card-brief.v1, bootstrap: true}
      status.md: {format: markdown, schema: work-status.v1, bootstrap: false}
      review.md: {format: markdown, schema: work-review.v1, bootstrap: false}
    workflow:
      entries: {BACKLOG: {node: plan}, CHANGED: {node: plan}, BLOCKED: {node: plan}, STOPPED: {node: recover, prompt: stopped-recovery}}
      nodes: # complete plan/review/recover definitions required
        # ...
  goal: # complete referenced definition required
    # ...
```

Do not place this map beside `card_type_set`. There is no partial-map overlay, inheritance, merge, alias, or missing-reference fallback.

The generated default preserves the visible project/goal plan-review loop and one-node execution workflows, but these are independent card-type artifacts rather than families. Edges are strict tagged objects; terminal edges choose ordered record exports and either the current accepted result or an earlier reachable node result. Configuration is required—there is no runtime family fallback.

Changing `card_type_set`, replacing an explicit map, adding a card type, or changing matching prompt/config inputs is an ordinary stopped configuration change: stop, edit, and start so one complete effective map is resolved and compiled; no unconditional generated-state reset is required. Strict startup validates every reached active or tombstoned card and retained parent/type/record admission before optional generated-state effects. Matching names and hierarchy do not guarantee compatibility. If startup rejects the selection, restore the compatible selector or complete explicit map and restart, or intentionally perform the existing stopped whole-generated-state reset for a fresh history. Saivage never probes, falls back, merges, migrates, aliases, selectively repairs, or normalizes generated state, and rolling back to a binary/configuration that cannot admit it is unsupported.

Non-empty model equivalence groups use nested arrays, for example `equivalents: [["model-a", "model-b"]]`. Legacy mapping/object forms are invalid and must be manually corrected to nested arrays before restart; Saivage does not rewrite them.

Direct public OpenAI GPT-5.6 through the Responses API is selected by provider capability, not by a model-name heuristic. Public OpenAI Responses uses API-key credentials only; Codex/OpenAI OAuth auth profiles are a separate `openai-codex-backend` contract and are not aliases for public OpenAI API keys.

```yaml
models:
  routes:
    analyst:
      candidates: ["gpt-5.6"]
      temperature: 0.7
      max_tokens: 4096
providers:
  openai:
    models: ["gpt-5.6"]
    apiKey: "<openai-api-key>"
    baseUrl: "https://api.openai.com"
    capabilities:
      transportProtocol: openai-responses
      toolsMode: native
      exclusiveToolChoiceSupport: native
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

The `streaming` provider capability key is obsolete and is rejected at provider, model, and account capability scopes. Stop the service, remove every such key from the selected configuration, and restart the current binary. This configuration-only cutover requires no generated-state reset and has no migration or compatibility interpretation.

Compaction is a boot requirement, not an optional feature. `init` publishes the complete default with all nine workflows, named model-route/profile scaffolding, enabled compaction, and a summarizer candidate, but its `providers` map is empty and it supplies no credential. This default can be structurally compiled offline without contacting a provider; the operator must configure a real provider, credential, and exact candidate identities before startup. `start --create-runtime` does not synthesize those choices. Omitted, `enabled: false`, incomplete, or non-configured summarizer candidates fail startup. The candidate is an exact structured identity: `account: null` selects the provider-level implicit account, while `account: "_implicit"` and `account: "_"` select those exact explicit account names and remain distinct. Model IDs may contain slashes; there is no flattened compatibility spelling or fallback summarizer route. Autonomous static preparation uses the final ordered provider array—operational tools followed by the sole terminal `emit_result`—rather than the operational-only prompt array; Analyst prompt, provider, and preparation use one terminal-free operational array. The configured global Analyst selects its compiled named route through `agents.<name>.model_route`; that route's required numeric `temperature` and `max_tokens` are the request authority, and omission is a configuration failure rather than an adapter default. Workflow compilation validates the completion reserve for every participant—the configured global Analyst plus every named node agent in every selected compiled graph, including specialized nodes—requiring each participant route's `max_tokens` to be no greater than `floor(compaction.input_budget_tokens * compaction.completion_reserve_fraction)` and reporting every offending `agents.<name>.model_route`; configured agents unused by the selected graphs are exempt. Startup acquires the lifecycle lock before full selected-config/environment validation, but completes that validation before any `--create-runtime` generated root-card read or publication; invalid configuration therefore creates or changes no generated root-card state. The operator must select a positive budget appropriate to the configured routes.

Configured MCP reconciliation must converge before runtime mechanics start. Startup installs the reconciled MCP invocation authority exactly once; reconciliation or later runtime-start failure aborts startup and is contained through the normal App terminal coordinator, without retry or configuration rollback.

Prompt files use one singular purpose-first tree: `agents|process|fragments/<cardType|_shared>/<reference>.md`. Card hosts select project card-specific, project shared, bundled card-specific, then bundled shared; the global Analyst checks only project shared then bundled shared. Only exact absence advances. Agent filenames always use `agents.<name>.prompt`, not the agent name. Agents sharing one prompt reference share the same applicable override; configure distinct references for independent content. Process templates allow only raw `&#123;&#123;cardType&#125;&#125;` and render at startup. Hosts may directly include one-level fragments with `&#123;&#123;> fragment-id&#125;&#125;`; nested includes are rejected. Every effective workflow-agent system prompt includes `&#123;&#123;contractDescription&#125;&#125;` exactly once. Packaging requires the physical bundled tree to equal the union of artifacts selected by both registered sets. Standard stays locked to exactly its historical 14 files—four shared agent prompts and ten shared process prompts—while specialized adds only process prompts and reuses the shared agents; no specialized agent or fragment files exist. Changes require restart.

This is a breaking configuration-path cutover with no migration or old-path fallback. Stop the service and manually rewrite existing overrides into `.saivage/config/prompts/{agents,process,fragments}/{<cardType>,_shared}/<reference>.md` before starting the new binary. This path-only cutover does not require generated-state reset.

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

Current card IDs are `project` or `card-<segment>[-<segment>...]` with one to twelve lowercase alphabetic segments, allocated from parent-local spreadsheet segments (`card-a`, `card-b`, ..., `card-z`, `card-aa`; nested parents restart at `a`). A card at the final depth twelve must select a card type whose compiled permitted-child set is empty. Every creation starts at `a` and directly attempts exclusive creation of each exact candidate namespace, advancing only when that `mkdir` returns `EEXIST` and never inspecting or enumerating the collision. A successful namespace claim remains consumed even if publication or linking later fails; membership begins only after complete initial publication and the parent's cumulative `children` array append. Widening the unchanged ID field grammar from five to twelve segments is a same-format forward deployment and requires no reset; after deeper cards are created, do not roll back to a binary that accepts only five segments.

Card streams use only format v2. One strict `cardRecordSchema` defines the current card record everywhere it appears, including card-version rows, embedded history snapshots, and tombstone final state. Current, history, and tombstone snapshots have one status authority at `lifecycle.status` and have no top-level `status`, persisted `parent`, persisted `depth`, `allowedActions`, or `position`. The complete cumulative parent `children` snapshot is the sole linked-membership and semantic sibling-order authority, including retained tombstone links. Directory creation claims identity, complete initial publication proves the child, and only the later single parent append grants membership and places it in order. A real active reorder is likewise one parent append: requested active IDs come first and retained non-active links follow in their prior relative order; an active-order no-op writes nothing. Generic card patches cannot write `children` or lifecycle.

Card status rules are operation-specific, not one universal terminal taxonomy. Blocked work remains unresolved and can be re-entered by its exact parent through `activate_card` and configured `BLOCKED`; stopped work is reused only by explicit activation through `STOPPED`. See the [functional specification](docs/spec/system-specification.md) and [architecture](docs/architecture/system-architecture.md) for the authoritative contracts.

In the default workflow, Planner corrects and activates only immediate children through parent-owned execution, while the intervention-ready Analyst performs global maintenance such as explicit reopen, cancellation, deletion, reorder, and authorized record mutation; creation ceilings do not grant activation or reopening. The linked canonical specifications define the caller-specific admission and effects.

Operator Card APIs are granular. A hierarchy request returns only one active parent and its active immediate `{id,title,type,status}` children in committed order; it does not expose raw links or inspect grandchildren, and a tombstoned link terminates there. Card detail contains only displayed identity, lifecycle, version, urgency, timestamps, and allowed actions. Compiled record descriptors/current artifacts, metadata-only record history, explicit record versions, and record diffs are separate Card endpoints and owners. The Records panel no longer routes through generic Files, while the independently mounted Files workspace remains available.

Canonical card state is one exact append-only `card.jsonl` stream, and each authored record is one exact append-only `record-<stem>.jsonl` stream beside it in the card namespace; the fixed `record-` physical prefix is injective, so even a record literally named `card.md` uses `record-card.jsonl` and stays disjoint from card authority while every user-visible `.md` name is unchanged. Each card type's compiled workflow declares ordered safe Markdown metadata hints and exactly one bootstrap record; each agent's compiled `record_writes` globs are the sole record-name mutation authority. Undeclared valid names use deterministic Markdown/`authored-record.v1` metadata and are directly addressable without a catalog. An admitted first mutation publishes an undeclared record's first open row at its exact stream path. Open, edit, close, and discard each append the next row, so numeric history versions identify immutable transitions rather than logical review cycles.

Generated card and authored-record state uses exact append-only JSONL streams: `card.jsonl` for card state/history/tombstone and one collision-free `record-<stem>.jsonl` per record. One logical mutation appends exactly one strict envelope, and current/history/diff derive from one strict complete fold of the stream. Conversations use deterministic configured-session indexes and immutable appendable JSONL segments, unchanged. Exclusive child namespace creation claims identity; the current parent card row grants membership/order. A declared bootstrap record stream is published nonempty at card creation, a missing optional record stream classifies empty, and no canonical stream is ever created empty: a present empty canonical stream fails startup. Tombstone is the final card row. Rollback against generated state written by this cutover is unsupported: rollback means stop, deploy the chosen binary, and another wholesale generated-state reset that loses generated history. The format is reset-only and old layouts are never accepted as current.

The generic growing-file whole-file reader opens the exact path read-only with no-follow/nonblocking flags, requires a regular descriptor, and strictly validates all bytes and envelopes without mutation. Empty, incomplete, invalid UTF-8, malformed-envelope, and invalid-row content fails. One canonical durable conversation validator owns session/source classification, tool settlement, rounds, segments, provider bundles, and compaction facts for in-memory reads, prospective append admission, compaction source selection, provider source selection, and card Run recovery. Its immutable `ValidatedConversation` contains durable facts; provider and summarizer projections are one-way derived views, and summarizer recoverable-result-body replacement is never durable conversation data. Agent inventory, card-session inventory, and exact Agent summary reads use canonical conversation index metadata; transcript and bounded tool content validate the complete current segment.

Before publishing a conversation batch, the owner canonically pre-reads the exact current stream without mutation, validates the complete current-plus-candidate sequence, and rejects a candidate that makes an unmatched call nonfinal or creates multiple unmatched calls before candidate-envelope open, candidate-byte transfer, or freshness. Startup initializes the exact missing configured global Analyst index and strictly validates its current segment before Fastify, MCP, runtime, or transport admission. Settled/text-ended history remains unchanged, including final assistant text; a sole final unmatched call or invalid complete history fails startup unchanged. Only startup's explicit owner may truncate a proven unterminated final suffix, and it never appends an Analyst recovery row. Immediate Analyst overlap instead returns exact typed busy from REST or WebSocket and is never queued; browser `sending` only suppresses duplicate local clicks and does not claim server ownership.

Agent inventory contains strict durable configured membership derived from compiled workflows and active linked cards, decorated at read time by exact membership in one request-local canonical process-live session-ID set. Every summary requires `active`/`busy` or `inactive`/`idle`; a live unpublished session synthesizes no durable inventory. Exact known-session summary and transcript reads retain historical access after tombstone as inactive/idle, but never reinsert that session into active membership. Provider/model remains exchange-only, and runtime status contains no Agent telemetry array. `GET /api/chat` returns only the configured global Analyst identity; the generic Agent resources provide its summary and transcript.

The four reset-owned roots are also the initial-publication presence boundary. Four absent roots permit first publication. Existing generated state enters initialization only through required current-format project card and bootstrap record streams; partial required publication and old or mixed formats fail reset-required. A non-directory or symlink at exact `.saivage/cards` fails before child access. No retained old-layout file is accepted as current-format authority.

Card type is selected at creation and is immutable for the card's entire durable lifetime. Directory-owned child claiming, the two-kind card stream, removal of card `position`, complete parent-owned `children` membership/order, and the type invariant are named reset-only durable changes. Applying one of those incompatible cutovers requires each affected deployment to stop, preserve configuration, credentials, operator inputs, source, skills, instructions, and canonical documentation, run the matching current built `saivage reset` to replace generated persistence wholesale, and then start that binary; no compatibility check or apparently unchanged history exempts an affected installation. Generated streams containing old `card-child-reservation` rows are unsupported and rejected, never compatibility-read or migrated. A successful candidate `mkdir` consumes its segment even if later publication or linking fails, and only the parent's committed cumulative `children` snapshot grants and orders membership.

Content-policy retry/refusal conversation rows, typed refusal BLOCKED results, and required error-exchange terminal-output IDs are part of that same named reset-only cutover inventory. When crossing that incompatible cutover, stop the service, preserve configuration/credentials/operator inputs/source/docs, run the matching current built reset, and start that binary. Do not restore old generated fixtures or state; there is no compatibility reader, migration, omitted-field fallback, or mixed-version operation.

An ordinary same-format deployment is different: stop the old service, deploy and strictly start the new binary against retained current-format generated state, and do not reset. Release format knowledge is authoritative. Startup never probes, samples, or normalizes retained state to decide that an old format is compatible; unsupported, mixed, or malformed canonical state fails fast.

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

Every `/api/*` operator contract, including Doctor, uses the shared operator registry and operator-session boundary. Required exact status-response maps validate both server output and browser input for status 200 and declared non-200 responses; `npm run validate:docs` checks the source-derived route inventory and response-contract fixtures. When `SAIVAGE_API_TOKEN` is configured, send it only as a bearer header, for example:

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

Conversation and app-log mutation use direct synchronous domain-owner functions. Stable role conversations are append-only: compaction never replaces a version or writes a cache. Configured card-node and Analyst persisted turns all use the singular prepared conversation actor. Each activation freezes one immutable static prefix—the rendered instruction, ordered provider tool-definition bytes, and terminal names—and prepares typed dynamic context and one exact prompt/tool budget; each Analyst submission prepares its rendered prompt, the bounded orientation snapshot, ordered tools, configured output request, and temperature before source publication, then retains that prepared value across tool continuations. Provider tool definitions are wire-only; the separate compiled invocation tool contracts own settlement policy, and executors return one typed execution result whose provider-visible `ToolResult` is distinct from internal evidence. Each tool surface carries one fixed evidence mode: mutable current discovery is observational, and the dedicated immutable card/record readers `get_card_version` and `read_record_version` alone emit canonical locators. The deliberately scoped bounded discovery/read/version APIs pack `list_cards`, `get_tree`, current `get_card`, every general `read` branch, the card-version catalog/diff surfaces, and `read_record_version` inside one exact 32,768-byte envelope with deterministic stateless continuations; other tool and MCP bodies stay arbitrary and are bounded only when exact compaction materialization and admission accept a subsequent provider request. Compaction keeps one accumulated summary with validated coverage as the sole omission authority—uncovered summary-only work stays primary-visible below the trigger—fixed-size commitments, two bounded required-model-fact slots, explicit open-round inheritance, and the internal compaction-summary evidence namespace. This conversation/compaction durable-format change is a named reset-only cutover.

Ordinary exact admission is local and aggregate: capability compatibility is considered before compaction, capability-ineligible candidates neither cause nor suppress a compaction needed by compatible oversized candidates, at most one pre-provider compaction and one re-admission run before any primary I/O, and only admitted serialized bytes are ever sent—it is not provider `input_context_exhausted`. When the compacted ordinary projection still cannot be admitted, the turn terminates with a bounded local error before any provider attempt. Ordinary authoritative provider recovery retains the immutable admitted membership plus mutable process-local attempt state, retries the context-failed member first with the compacted bytes, then resumes existing scheduling over still-viable retained members while original rejects and exhausted members never reopen. Separately, a content-policy pin is purely preflighted once: both ineligible and oversized results fail without compaction, substitution, or provider I/O; its admitted provider call occurs at most once with no availability, retry, or failover; every non-refusal failure including context exhaustion terminates; and the actor's combination/reindexing of original plus pinned attempts is evidence composition, not retained recovery state.

Within one `compact()` call, at most one summarizer provider call is in flight, and every leaf and reduction request is materialized through the one exact serialized-request estimator/packer with deterministic chunking and provable progress. Failure or abort admits no later summary, candidate, or triggering-provider call. Direct, nonpersisting summarizers remain unprepared, fixed to the one Registry-validated configured candidate, run under the internal evidence namespace, and receive no self-compaction or replay; they consume a post-validation projection rather than canonical-looking durable rows. Durable policy stores only policy inputs plus fixed-size commitments, not derived completion/threshold/window values. The rollout for this and every named reset-only cutover is the ordered stopped procedure in the [operator runbook](docs/runbook/index.md): exact service stop, positive owner-absence verification, mandatory full stopped target-project backup, separate explicit destructive authorization, preservation of configuration/credentials/identity/operator inputs/prompts/skills/instructions/source/canonical docs, wholesale reset of the four generated roots with the positively identified current build, and restart of that same current artifact. Old or invalid generated conversations are not migrated, selectively repaired, or compatibility-read, and an affected service must remain stopped until that reset-only procedure is authorized.

Exact direct Codex `server_is_overloaded` code/type evidence, including supported `error` and `response.failed` events after HTTP 200 opened, is `server_transient` with truthful response status 200. Invocation Service remains the sole fixed-candidate retry/deadline/cancellation/evidence owner. Provider exhaustion, cancellation, publication/projection uncertainty, invariants, append failure, and malformed transport-successful summary output retain distinct failure identities. In last-chance context recovery only, a narrow fieldless actor marker is thrown after separate summary evidence and original triggering card-node attempts have each been published once; it carries the exact summary `ProviderTurnFailure` as cause and prevents false attempt republication or `model_issue` fabrication. It is not a provider taxonomy or retry owner.

Every production provider attempt unconditionally verifies its canonical request plan before the one generic capability check or any credential side effect. An integrity mismatch fails the whole invocation without recovery or failover. The capability-selected closed protocol adapter carries its credential requirement into delayed per-attempt resolution, and admission, retries, hashing, and send reuse the same canonical serialized bytes. Invocation Service has one unconditional path through the shared attempt runner, with the candidate plan as the sole request authority. The selected adapter directly consumes the successful fetched response; structured recorder evidence does not buffer or capture its raw body.

The application log has one strict `{type,data}` row union with only `event`, `control_action`, and `provider_exchange` lanes. Event kinds are exactly `runtime_diagnostic`, `runtime_actionable_error`, and `mcp_tool_invocation`; Debug Errors derives both runtime kinds and failed MCP invocations. Initialization, runtime reads, and append admission are strict and correction-free, validate global logical-ID uniqueness, and reject incomplete or malformed content without changing bytes. Only exact missing `app.jsonl` is absent; a present zero-byte app log is malformed and fails startup. Publication uncertainty reaches immediate fatal delivery with no read, retry, second append, failed result, later attempt, hint, halt, API response, or WebSocket frame.

`EventQueryService` is the sole event/error reader. `/api/events` supports strict oldest-page or newest-tail selection with a maximum of 1000. Debug requests events only while Timeline is selected and errors only while Errors is selected; hidden tabs have no eager fan-out or registrations. MCP loads once on selection and never polls. There is no EventBus, generic read-model broadcaster, `/api/debug/timeline`, dedicated error lane, or content-supervision surface.

Applying this named incompatible format/config cutover is mandatory for each affected deployment: stop the matching service, back up and preserve configuration, credentials, identity, prompts, instructions, skills, source, and canonical docs; manually remove the top-level scanner-only `security` section and unknown/deleted model-role keys; validate skill targets as exactly `executor | reviewer | analyst`; run the matching current built `saivage reset` over the four generated roots; then start that binary. Never restore an old app log or old generated state. There is no migration, format probing, normalization, mixed-version startup, or binary-only rollback. Later ordinary same-format deployments use the stop/deploy/strict-start rule above and do not repeat this reset.

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

Agent resources are granular. Agents and the selected Debug Agents tab acquire the global acknowledged lease and partition the baseline by global/card scope. Card Conversations acquires only its selected card's lease and `/api/cards/:id/agent-sessions`; it never requests global inventory. Exact conversations use opaque cursor tails under a conversation lease. Raw Exchange has an independent exact session lease, performs no REST read before acknowledgement, and accepts only populated `200` or the exact no-exchange `404` baseline. Summary/list/detail reads use canonical conversation index metadata plus one exact process-local live-ID capture; complete transcripts use the singular canonical durable validator and retain the durable sole-final-unmatched-call rule. Membership hints cause authoritative partition replacement, not blind upsert/remove, and every first card conversation emits a reconciliation hint after known success. Canonical Agent provider-exchange evidence emits exact exchange freshness; internal `internal:compaction-summary:*` evidence remains durable without an Agent hint. Provider/model appears only in explicit exchange metadata; summary liveness/activity is only the required paired projection.

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
