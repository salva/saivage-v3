# Configuration

## Image tool and routes

Opt in with `view_image` in each intended named agent's exact tool list. Bundled
Analyst/Executor/Reviewer declarations include it; materialized custom configuration
does not inherit template changes. Image-enabled surfaces and fixed
`compaction.summarizer_candidate` require compatible image input. Capability
`imageInput` defaults unsupported; exact `gpt-6.1-sol` and `gpt-6-astra` resolve support
on Responses/Codex. Explicit configuration can declare another compatible endpoint.
Transport support is also required: Chat image input is not implemented. Native
tools alone does not prove these models' Chat tool support; Sol/Astra tool routes
require Responses or compatible Codex, without automatic rerouting. Retained images
require image capability at use even after tool removal.

Use an existing command to create a non-secret PNG/JPEG, then explicitly call
`view_image({path:"screenshots/settings.png",max_dimension:1600})`. Omission is 1600;
integer 1..16384 or `'original'` is the sole override. Original disables local spatial
reduction only, not orientation/PNG normalization, limits or backend preprocessing.
Provider detail is omitted/default auto. Small text may need a focused screenshot
or larger override; never invent unreadable text. Source limits are 32 MiB, one frame,
40 million pixels; selected PNG is at most 16 MiB. Image-bearing wire is at most
32 MiB. No retry ladder or source mutation. Avoid credential/configuration screens:
pixel secrets cannot be redacted. `read` and command stdout stay text-only.

Local estimation is complete serialized UTF-8 bytes/4 plus
`2*ceil(sentWidth/32)*ceil(sentHeight/32)` per emitted image: one heuristic for both
models, not billing or guaranteed fit. Official context is 1,050,000, maximum input
922,000 and maximum output 128,000; configure existing budgets conservatively.
There is no independent maximum-input axis. Snapshots remain in backups and disk
retention without GC after lossy compaction. See the
[native prerequisites/adoption](../runbook/index.md#image-snapshots-and-native-dependencies).

Status: non-authoritative guide. The selected configuration's exact contracts
are owned by the [System specification](../spec/system-specification.md) and
the [Operator runbook](../runbook/index.md); this page explains how to
configure a working instance. New to cards, records, or sessions? See the
[glossary](../overview.md#glossary).

Saivage reads one strict YAML file: `.saivage/saivage.yaml` in the target
project. `saivage init` materializes it from a bundled template; after that
the instance owns it, and every change takes effect on the next start.
`${ENV_VAR}` references are interpolated from the service environment at
startup, except literal record scaffold content at
`card_types.<type>.records.<name>.initialization.template` and action execution
configuration/inputs — keep API keys out of
the file and scaffolds. Validation is strict: unknown or
obsolete keys fail startup instead of being ignored.

Missing `${ENV_VAR}` references still substitute an empty string. After a
successful configuration/environment load, startup prints advisory
`Configuration warning: Environment variable 'ENV_VAR' is not set.` lines to
stderr before runtime construction. Offline CLI workflow loads also report
their own successful load's warnings. Values are never included, and warning
text is outbound-redacted (including credential-shaped names); the REST config
warning array uses the same text defense without the stderr prefix.
Check the environment supplied to the service or CLI and correct the missing
variable through your ordinary configuration/deployment procedure. A warning
does not test credential validity or bypass strict configuration validation.

## Providers

Choose an endpoint **and a specific model**, not just a brand name. OpenAI Chat
Completions, OpenRouter, and a local vLLM-compatible endpoint are examples of
the endpoint category, not endorsements or promises that any listed model will
work. Replace the example's URL, model ID and credential variable with values
for your selected service. Its actual transport, native tool-call support and
exclusive tool-choice behavior must match the capabilities you declare. The
example below assumes a Chat Completions model verified to support native
tools and native exclusive tool choice; its context/output figures are
illustrative, not defaults to copy:

This example is text-only: remove `view_image` from intended agents if selecting
Chat, or choose compatible image primary/summary Responses or Codex routes. In
particular, do not substitute Sol/Astra into this Chat tool example.

```yaml
providers:
  my-provider:
    apiKey: ${MY_PROVIDER_API_KEY}
    baseUrl: https://api.example.com/v1
    capabilities:
      transportProtocol: openai-chat-completions
      toolsMode: native
      exclusiveToolChoiceSupport: native
      contextWindowTokens: 400000 # replace with the selected model's limit
      maxOutputTokens: 65536     # replace; cover route output and 2000-token summaries
    models: [my-model]
```

- `transportProtocol` selects the wire adapter: the example uses
  `openai-chat-completions`, while `openai-responses` and
  `openai-codex-backend` are distinct protocols, not interchangeable names
  for every OpenAI-compatible URL. `toolsMode: native` means the selected
  service/model can exchange native tool calls. `exclusiveToolChoiceSupport`
  describes whether it supports the required exclusive choice (`native` or,
  where actually supported, `parallel_off`); `unsupported` cannot satisfy the
  bundled tool-using agents. Do not claim native support merely because an
  endpoint accepts ordinary chat requests. A mismatch may fail startup binding
  or a real provider call.
- `capabilities` must tell the truth about the selected service/model; context
  admission and compaction use `contextWindowTokens`, and route output requests
  must fit `maxOutputTokens`. Per-model overrides go in `modelCapabilities`.
- Use `apiKey`, or `authProfile` to reference a stored OAuth-style
  authentication profile instead of a raw key.
- Providers with several credentials add an `accounts` map; each named
  account can carry its own `priority`, `apiKey`, `baseUrl`, `authProfile`,
  `models`, and `capabilities`.
- Credential validity is not probed at startup — a bad key surfaces on the
  first real model call.

## Model routes

Each named agent binds to a route. Routes name an ordered candidate list;
failover follows that order when a model is unavailable:

```yaml
models:
  routes:
    executor:
      candidates: [big-model, small-model]
      temperature: 0.3
      max_tokens: 8192
    planner:
      candidates: [big-model]
      temperature: 0.7
      max_tokens: 4096
  profiles:
    planning: { preferred: [big-model], allowed: [] }
    review:   { preferred: [big-model], allowed: [] }
  equivalents: []
  failover: {}
```

- `candidates` is an explicit ordered list; `profile` selects a reusable
  preference set instead (the bundled templates use the `planning` and
  `review` profiles). Route resolution happens once at startup.
- `equivalents` groups model IDs as additional route choices: for each explicit
  route candidate (or profile `preferred` then `allowed` model), resolution adds
  that model, then the other IDs in its first matching equivalence group.
  `equivalents: []` adds none; it does not remove explicit candidates.
- `failover` maps each route model to an ordered list of fallback model
  IDs, added after that model's equivalents. The resulting order keeps only
  the first occurrence of each ID. `failover: {}` adds no such lists; neither
  empty setting disables other route candidates or provider/account failover.
- A model ID resolves to **every** provider that lists it, ordered by
  provider `priority` and then by account `priority` (lower first; defaults
  100 and 50) — that ordering is the failover chain across providers. Named
  `account:` selection exists only for the compaction summarizer.
- Larger windows can materially increase request cost and latency; Saivage
  does not compact merely to make a small fallback fit.

## Agents

The global `agents` catalog defines every named agent: its prompt, tools,
skills, session scope, model route, and record-writing rights:

```yaml
analyst_agent: analyst
agents:
  planner:
    prompt: { reference: planner, compactable: true }
    tools: [create_card, edit_card, activate_card, reopen_card, ...]
    model_route: planner
    session: card            # one session per card
    can_create_children: true
    record_writes: [brief.md, status.md]
    skills: false
```

- `session: card` agents get one conversation per card; `session: global`
  agents (the Analyst, Oversight) get one project-wide conversation.
- Tool lists are exact inventories — capability is configured per agent, not
  inferred from its name. The shipped defaults are documented in the
  [specification's agent tables](../spec/system-specification.md#1-product-boundary).
- Prompts resolve by `reference` through the override tree; see
  [Prompt handling](../architecture/prompts.md).

## Card types

Omit `card_types` to select the bundled `classic` definitions (nine types:
`project`, `goal`, `architecture`, `code`, `test`, `doc`, `data`, `research`,
`ops`) — recommended for a first instance. Advanced: `saivage init --profile
classic-typed` materializes the typed template — with per-type processes such
as code red/green/refactor and test diagnose/verify loops — before any config
exists, or provide a complete closed `card_types` map by hand:

```yaml
card_types:
  project:
    permitted_child_types: [goal, code, test, doc, ...]
    records:
      brief.md: { format: markdown, schema: card-brief.v1, bootstrap: true }
      status.md: { format: markdown, schema: work-status.v1 }
    workflow:
      format_version: 2
      notification_recipient: planner
      entries: { BACKLOG: { node: plan }, CHANGED: { node: plan }, ... }
      nodes:
        plan:
          execution:
            kind: agent
            agent: planner
            prompt: { reference: plan }
            correction_prompt: { reference: correction, compactable: true }
          edges: { ... }
```

Every workflow's `STOPPED` entry must target a node run by its declared
`notification_recipient` and supply a recovery prompt. The compiler derives an
interruption transition from every node to that same target, including same-node
re-entry; it is not a model outcome. The recipient must reconstruct current
facts rather than resume an old invocation. Child-bearing custom recipients
need not have activation tools merely to accept the workflow: ancestor notices
ask for discretionary action, not guaranteed dispatch. All three bundled profiles
already supply recipient-first STOPPED routes. Materialized instance prompts
and configuration are instance-owned; reconcile them deliberately while stopped.

All three shipped profiles specialize only `project` with Planner
`assess-completion`. Plan/recover request assessment or review; approved review
always enters assessment, and only assessment can reach DONE. Goals retain their
direct completion and conditional notification handler. Reviewed root completion
promotes the real Reviewer result while exporting accepted Planner status; see
the [configured graph contract](../spec/system-specification.md#shipped-project-completion-and-profile-graphs).

Existing-config `init` preserves YAML/prompts rather than upgrading the graph.
Removing the former project `handle-notifications` node from the effective
workflow of a reached non-tombstoned retained project, including DONE/FAILED,
is incompatible identity adoption even if that handler never ran. It requires
separately consented complete reset or explicitly owner-requested external offline
migration before use; stopping and reconciling inputs alone is insufficient.
Unused declarations and identity-preserving changes do not trigger this predicate,
but independent format cutovers still apply. Startup checks current configured
indexes, not prior node identities; passing compilation/startup/readiness is not
compatibility certification. Fresh profile initialization uses its ordinary fresh-init
preconditions. This guidance grants no deployment or migration permission.

Switching templates or replacing the map is a stopped configuration change;
the runbook owns [identity-cutover rules](../runbook/index.md#agent-and-workflow-identity-cutovers)
for instances with retained history. After a change, verify what actually
compiled in the control room's [System > Installed workflows](./operating.md#system) view.

### Action execution and typed handoff

Nodes select either the agent execution object above or an action. Common
`records` and `edges` remain on the node. For example, this node checks before
an agent assesses acceptance (surrounding nodes/records/entries are omitted):

```yaml
check:
  execution:
    kind: action
    action: shell.run
    contract_version: 1
    config:
      script: 'npm test -- "$@"'
      cwd: .
      env: { CI: '1' }
      timeout_ms: 120000
      terminate_grace_ms: 2000
      artifacts: ['reports/test-summary.txt']
    inputs: { args: { literal: ['--runInBand'] } }
  stdout_record: check-report.md
  records:
    check-report.md: { mode: continue, gate: updated }
  edges:
    passed: { target: { node: assess } }
    failed: { target: { node: repair } }
    signalled: { target: { node: repair } }
    timed_out: { target: { node: repair } }
```

The enclosing type must declare `check-report.md` as an ordinary nonbootstrap
record, for example `{format: markdown, schema: check-report.v1, bootstrap: false}`.
This is a node excerpt, not a complete configuration. Omit `stdout_record` and
use `records: {}` for an unbound capture-only node. Every workflow, bound or not,
requires `format_version: 2`; `shell.run` still selects operation contract1.

All four outcomes are required. Commands produce ordinary captured stdout/stderr,
not plugin JSON. Script is literal Bash with pipefail, no implicit `set -e`;
`args` are separate argv, so quote `"$@"` rather than injecting data into syntax.
The environment is the existing sanitized command environment plus root variables
and explicit nonsecret env; credentials and root-variable overrides are refused.
`${NAME}` in action config is literal shell program text, not configuration
interpolation. Cwd is project-relative (default `.`); artifact paths are exact,
relative, no globs, at most 16. They select mutable current workspace content,
not historical snapshots. See [action operations](../spec/system-specification.md#stateless-action-nodes)
for timeout limits, interruption and evidence semantics.

Plugins are trusted explicitly compiled modules, not discovered/installed services.
IDs are exactly `namespace.operation` (each component lowercase letter followed by
at most 47 lowercase letters/digits/hyphens); `shell`, `git`, `saivage` are reserved
namespaces, not promises of available operations. Declarations select contract1,
supported bindings, strict config, required flat input/output fields, finite named
outcomes and concrete capabilities. Duplicate/shadowed/unresolved IDs fail compilation.

Fields are `string`, `boolean`, safe `integer`, or `strings` (`string[]`), with
optional declaration-time string enums/integer bounds. Limits are 32 fields,
4096 UTF-8 bytes per string, 256 list entries and 64 KiB encoded values. Private
output fields cannot route, feed successors or be retained as public observations.
No nested JSON, defaults, coercion, dynamic target or expression language exists.
An outcome edge is direct or has at most eight ordered cases and required
`otherwise`. Each case has an ID and one `when: {field,op,value}`; `eq` is typed,
`gt|gte|lt|lte` require integers. First match wins only after full validation.
Edge `inputs: {findings: {output: count}}` passes selected predecessor data to a
destination's declared input. An agent declares e.g.
`data_inputs: {findings: {type: integer, min: 0, max: 1000}}` inside `execution`.
Node inputs use `{literal: value}` or `{source: card_id|card_type|card_title}`;
hooks additionally allow `committed_status`. Missing/duplicate suppliers fail
compilation on every incoming route, and inputs are checked again at use.
Hooks have no incoming edge and must explicitly supply every declared required
input, including an empty argv list for `shell.run` when appropriate.
Agent handoff quotes only selected facts; it does not grant tools or instructions.
Literal and card-fact agent inputs also reach direct lifecycle entries, STOPPED
recovery and urgent re-entry, not only predecessor handoffs. Nonempty selected
inputs are delivered once per entry as compactable quoted user text; empty inputs
add no message. Original-name outbound filtering preserves scalar/list display
shape without changing the typed values used internally or for routing.

The optional `stdout_record` binding is only for an exact declared nonbootstrap
own-card destination on `shell.run`, with exactly `continue/updated`. An open
draft blocks launch and publication. Eligible completed stdout is copied through
normal acceptance, not parsed as JSON or a semantic verdict; it must be substantive
valid UTF-8 without NUL and at most 1 MiB. No trimming/truncation or stderr fallback
occurs. Nonzero/signal/deadline dispositions retain their actual meaning; cancelled
ownership publishes nothing before acceptance. A new invocation may publish equal
text as a new version. No writer permission is granted to agents, plugins or hooks.
Other action requirements remain accepted-only `continue/exists`; actions cannot
initialize, clean or close records. Notification recipients and
STOPPED recovery remain actual agents. Edge prompts targeting actions are invalid.

At most one `workflow.after_activation_commit` attachment may select an action
and `statuses: [done]` (allowed: `done`, `blocked`, `failed`). It runs only after
a natural outcome is committed. It is advisory: nonzero cannot undo DONE. Put a
required build/test in an action node before DONE instead. No recovery, Stop,
record write or startup replay invokes the hook. Neither an execution log nor
a lost result authorizes retry. Pause gates providers only; an admitted action
chain can continue until a provider frontier or natural completion.

### Optional record scaffolds

Configure non-bootstrap `records.<name>.initialization:{format_version:1,template}`
and an ordered node `initialize_records` list in the complete owning card type.
Selection is independent of completion requirements and requires a declared
initializer, matching `record_writes` and direct `write`. Old content/triggers
are rejected, never upgraded. The narrow host supports cardType/cardId/cardTitle/
nodeId/recordName and direct fragment includes; `${NAME}` remains literal.
Only absent heads render once into nonauthored baseline0. Every existing head,
including empty-after-discard, suppresses rendering. Explicit clean remains separate:
open from baseline0 or otherwise empty for the next document version, preserving
accepted backing without rerendering. Baseline0/draft0 and empty drafts cannot
satisfy authored gates. Configuration changes need new-process compilation, never
rewrite retained text and are not installed by existing-config init.
All three shipped profiles select status starters at responsible work nodes and
neutral review starters at review nodes (including both typed architecture reviews).
Bootstrap briefs are excluded; a review starter is not a verdict and still requires
authored assessment and acceptance. Creation-time initialization remains deferred. See the
[example and incompatible adoption boundary](../runbook/index.md#optional-record-scaffolds)
before changing an instance; head3/accepted3/conversation12 adoption is not authorized by
editing configuration or installing source.

## Compaction

Long conversations are summarized when they approach the model window:

```yaml
compaction:
  enabled: true
  context_utilization_fraction: 0.80   # usable fraction of the window
  trigger_fraction: 0.90               # when to prepare compaction
  tail_fraction: 0.25                  # preferred recent-source tail target
  snap: keep_straddler_verbatim        # or compact_straddler
  summarizer_candidate: { provider: my-provider, account: null, model: my-model }
```

The tail target is `floor(I * tail_fraction)` for route usable input `I`, not a
verbatim-retention guarantee. All agent-session rounds count, including the
newest open/inherited round. When newest fits, whole rounds are retained
backward; `snap` retains or covers the first older straddling round whole. Only
an oversized newest round uses a recent row suffix, retaining the crossing row
and snapping the covered prefix backward to a safe atomic boundary under either
snap setting. Atomic groups can retain more than the target, while the existing
furthest fallback can cover the whole settled tail. This policy adds no setting
or reset requirement.

`summarizer_candidate` must be a Registry-resolved model with a large window
(it summarizes with its own 2,000-token output request). Removed legacy keys
(absolute budgets, completion reserves) are invalid. Capacity and failure
limits are owned by the [runbook](../runbook/index.md#prepared-conversation-compaction).

## Project Oversight

```yaml
oversight:
  enabled: true
  agent: oversight
  interval_seconds: 7200
```

Oversight is an independent read-only check by its own global agent. New
projects enable it by default with a two-hour cadence. Its first check waits
one full continuous eligible interval while the project is running; pausing or
stopping discards that wait. Its only project effect is an evidenced
notification to a planning-capable card. See
[Project Oversight](../spec/system-specification.md#project-oversight).

## MCP servers

```yaml
mcpServers:
  my-tools:
    transport: streamable-http
    url: https://mcp.example.com/mcp
    disabled: false
    autostart: true
  local-tool:
    transport: stdio
    command: node
    args: [/path/to/server.js]
    autostart: true
```

MCP tools become available to agents as `mcp_tool_call` according to each
agent's configured tool inventory. Reconciliation happens at startup. Independent
`mcp_server_control` and `mcp_tools` selections allow configured runtime start/stop/restart
and exact-schema discovery. Defaults select all three for Analyst/Executor; Reviewer
requires opt-in and Oversight admits none. Edit alone changes no running server:
explicit stop/start or restart reloads only its current entry, not other workflows/routing.
Restart requires a retained owner and stops it before fresh start/discovery; it is
non-atomic, with no replay, remote restart or target-continuity promise. See the
[restart procedure](../runbook/index.md#explicit-mcp-server-restart).
See the [pinned browser recipe](../runbook/index.md#configured-browser-lifecycle).

An explicitly selected `mcp_server_register` may instead add a connection to the
lazy `.saivage/config/mcp-servers.json` (format 1, type `mcp-server-definitions`,
`servers` map). Names must not collide with YAML. Registration does not start;
dynamic definitions survive restart/reset but always require explicit start.
`mcp_server_unregister` removes only dynamic entries and contains their exact
runtime. `mcp_servers` observes configured and retained owners independently.
An independently selected `mcp_server_replace` wholly replaces only an existing
exclusively agent-owned connection at a known-stopped boundary. Used owners require
successful explicit stop/join; pristine unstarted definitions need no ceremony.
Transport may change and omitted args/env are removed, not merged. Dynamic command,
args, env and URL values remain literal (including `${...}`); only YAML uses configuration
interpolation. No auth-profile lookup or credential injection is added. Replacement
does not launch; separately start/discover before calling with fresh identities.
No new permissions are added to defaults. Discover with `mcp_tools`, then pass
its `bindingId` and `catalogId` to `mcp_tool_call`; stop/start or restart requires fresh discovery.
Any eligible configured global/card agent may independently opt in to
`mcp_catalog_refresh` in its `tools` list. It requires an observed ready connection,
re-lists on that same connection and publishes a new catalog identity; discover
again for exact schemas before calling. This selection grants neither discovery,
invocation nor lifecycle control, and defaults remain unchanged. Oversight admits
no MCP tools. See [explicit refresh](../runbook/index.md#explicit-mcp-catalog-refresh).
Stdio is an MCP-managed runtime process, not an attachable agent command;
ordinary process wait/kill remains denied. HTTP is an external URL and local
stop does not terminate it. Hot editing, notifications/native projection and card-tree lifetime
refinements are deferred. `show_config` remains YAML-only; Files refuses the
secret-bearing dynamic definition file. Include it in complete project backups.

## Server

Failed-provider request diagnostics are **CLI-only**, disabled by default:
`saivage start --failed-provider-diagnostics <UUID>`. This ephemeral start input is
not a YAML key, environment alias, retained configuration field or effective
provider setting; duplicate/invalid UUIDs and options on other commands are rejected.
One manually named activation permits 16 failure publication attempts within one
hour, at most 8 MiB each (oversize bodies yield metadata only, at most 16 KiB).
It stores sensitive private projected text, not guaranteed secret-free raw/replay
input. Reusing the consumed UUID disables capture on restart. See the
[runbook](../runbook/index.md#private-failed-provider-request-diagnostics) for
eligibility, notices, fidelity, retention and rollback precautions.

```yaml
server:
  host: 0.0.0.0
  port: 8080
```

`--host`/`--port` CLI options and their precedence are owned by the
[CLI contract](../spec/system-specification.md#8-lifecycle-lock-and-cli).

## Skills

Optional `.saivage/skills/index.json` registers skill files for
`executor`, `reviewer`, or `analyst`. Each `file` path is relative to the
`.saivage/skills/` directory and may not escape it:

```json
[
  { "name": "deploy-checklist", "file": "deploy.md", "target_agents": ["executor"] }
]
```

## Changing configuration while running

The Analyst's `reconfigure` tool supports only strict validation-style
changes (`set_agent_model_route`, `set_model_failover`, host/port
`set_server_setting`); every success reports `requires_restart: true`.
Current configuration must pass source/effective-schema decoding and mutation
preconditions; the complete edited candidate must also compile before replacement.
A supported edit can correct a compiler-only current error (such as an agent's
missing model route), but cannot bypass invalid current schemas or publish an
invalid candidate. This is neither general config repair nor hot reload.
Everything else — prompts, tool lists, workflows, providers — is a stopped
edit followed by a fresh start.
