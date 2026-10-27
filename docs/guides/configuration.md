# Configure an instance

Init preserves an existing configuration when `--profile` is omitted. An explicit
profile must match the retained `.saivage/config/template.json` selection; a missing
selection cannot be guessed. Fresh configuration is compiled against its selected
bundled prompts and existing project overrides before configuration/prompt effects,
then reloaded canonically after publication.

The native provisioning CLI accepts four singleton values together:
`--git-delivery-branch`, `--git-private-ref-namespace`, `--git-source-roots` and
`--git-excluded-paths`. The last two take JSON arrays of literal paths, not globs;
explicit exclusions include `.git` and `.saivage`. Partial/duplicate values,
OFF-profile use and conflicting retained policy are errors, never merged defaults.
The `classic-git` registry entry requires provisioning rather than exposing a sample
effective configuration. Its shared classic builder supplies fixed squash,
preservation and review/correction bindings. Init compiles the complete selected
bundle before materialization and commissions only through the lifecycle owner.

## Opt in to native quality evidence

Preprovision the [qualified native tools](../reference/quality-tool-qualification.md)
and an offline native configuration first. This partial YAML adds a JavaScript
binding to an existing agent; preserve its other fields/tools. Paths are examples,
not installed defaults. Do not place credentials in native configuration.

```yaml
tools: [code_quality_javascript_eslint]
quality_tools:
  format_version: 1
  code_quality_javascript_eslint:
    cwd: .
    native_config: analysis/eslint.config.mjs
    source_paths: [src]
    exclusions: [src/generated]
    node_binary: /opt/node/bin/node
    eslint_module: analysis/node_modules/eslint
    timeout_ms: 30000
    terminate_grace_ms: 2000
```

The selected agent invokes `code_quality_javascript_eslint({})`. TS/Ruff use the
corresponding named binding and the [same action config schemas](../reference/configuration.md#quality-actions).
Requests cannot replace configuration or narrow/widen its scope. For an automated
workflow alternative, use this node execution excerpt with that same config:

```yaml
execution:
  kind: action
  action: code-quality.javascript.eslint
  contract_version: 1
  config: # insert the same JavaScript config above
    cwd: .
    native_config: analysis/eslint.config.mjs
    source_paths: [src]
    exclusions: [src/generated]
    node_binary: /opt/node/bin/node
    eslint_module: analysis/node_modules/eslint
    timeout_ms: 30000
    terminate_grace_ms: 2000
  inputs: {}
```

Complete the node with all five outcome routes, routing clean/findings to ordinary
assessment and failures to diagnosis, not automatic DONE. An optional action
`output_record` additionally requires the ordinary declared nonbootstrap record and
updated-record gate. Tools do not borrow that publication authority.

Optional [observed source definitions](../reference/configuration.md#optional-observed-source-inputs)
select logical code/docs/skill views. The [prepare/adopt procedure](../runbook/observed-collections.md)
generates private native deployment inputs without indexing or starting services.
Native watcher adoption is separate; lexical-only small-file coverage is valid,
and original-source inspection remains authoritative.

Configure the models, capabilities and workflows that enable autonomous work;
this is not a per-task dispatch checklist. Use this page for configuration tasks
and the [field reference](../reference/configuration.md)
for exact keys, defaults and constraints. Saivage loads one selected strict YAML
document, normally `<target>/.saivage/saivage.yaml`. Unknown keys fail; there is no
legacy overlay. Initial templates are starting points, not ongoing authorities
over an installation's materialized YAML/prompts.

For a fresh target follow the [tutorial](getting-started.md). For retained state,
read [selected configuration and prompts](../runbook/state-adoption.md#selected-configuration-and-prompts)
before editing identities. The guide's examples are synthetic/source-reviewed;
they do not authorize provider calls, deployment or state adoption.

## Choose a fresh profile

Run `saivage init --profile NAME` from the fresh target directory:

| Profile | Choose it for | Difference |
| --- | --- | --- |
| `classic` (default) | A simpler first project | Planning/review on project and goal; most leaf types use one execute node |
| `classic-typed` | Specialized work loops | Typed code/test/research/data/doc/ops and architecture graphs using the ordinary engine |
| `paad-typed` | The same typed graphs with optional adapted planning guidance | Five selected prose paths differ, not tools, routing or outcomes; [attribution and scope](../architecture/prompts.md#optional-paad-typed-guidance) |

All include nine types: project, goal, architecture, code, test, doc, data, research
and ops. All specialize root completion with Planner assessment after approved
review; goals retain their own completion/notification path. The
[exact graph table](../spec/system-specification.md#shipped-project-completion-and-profile-graphs)
shows the outcomes rather than relying on role names.

`init` with existing configuration preserves it and existing prompt destinations;
it is not a profile switch/upgrade. Omitting `card_types` selects the complete
bundled classic type map, not a merge with a partial custom map. Supply a complete
closed map when defining it yourself. Verify the compiled result in **System →
Installed workflows** after an authorized fresh start, not merely saved YAML.

## Wire provider, routes and summary

Choose a model **and matching transport**. Do not infer native tools, exclusive
tool choice or image support from a provider brand or an ordinary successful chat
request. Binding validates local capabilities; it does not probe credential validity.

The following is a **three-section replacement excerpt** for a freshly initialized
bundled profile, not a standalone configuration. Retain `agents`, `analyst_agent`,
`oversight`, `card_types` and other desired generated sections. Replace the example
URL, model ID and limits with verified facts for your chosen service. It assumes
an image-capable Responses endpoint with native tools/exclusive choice; the
400000/65536 limits are illustrative, not inferred or recommended model limits.

```yaml
providers:
  trial-provider:
    apiKey: ${TRIAL_PROVIDER_API_KEY}
    baseUrl: https://provider.example.invalid/v1
    models: [trial-model]
    capabilities:
      transportProtocol: openai-responses
      toolsMode: native
      exclusiveToolChoiceSupport: native
      imageInput: true
      contextWindowTokens: 400000
      maxOutputTokens: 65536

models:
  routes:
    analyst: { candidates: [trial-model], temperature: 0.7, max_tokens: 4096 }
    oversight: { candidates: [trial-model], temperature: 0.2, max_tokens: 4096 }
    planner: { candidates: [trial-model], temperature: 0.7, max_tokens: 4096 }
    reviewer: { candidates: [trial-model], temperature: 0.2, max_tokens: 4096 }
    executor: { candidates: [trial-model], temperature: 0.3, max_tokens: 8192 }
  profiles: {}
  equivalents: []
  failover: {}

compaction:
  enabled: true
  context_utilization_fraction: 0.8
  trigger_fraction: 0.9
  tail_fraction: 0.25
  snap: keep_straddler_verbatim
  summarizer_candidate: { provider: trial-provider, account: null, model: trial-model }
```

Provide the key privately in the actual server environment; never publish the
effective credentials. An `authProfile` may select an already established stored
authentication profile instead. Multiple credentials belong in an `accounts` map;
see [providers and accounts](../reference/configuration.md#providers-and-accounts).

Every named agent selects a `model_route`. Each route uses **either** candidates
or a profile, with required temperature/output limit. Profiles expand preferred
then allowed IDs; equivalents and failover append choices in documented order.
Empty `equivalents`/`failover` add nothing; they do not disable explicit candidates
or provider/account selection. Provider priority defaults **50**, account priority
**100**, lower first. See [model routes](../reference/configuration.md#models-and-route-expansion).

The summarizer is a fixed Registry-resolved provider/account/model candidate with
its own capacity and 2000-token output request. It is not an agent route or the
smallest fallback. Image-bearing sessions need compatible primary **and summary**
capability, including retained images even if you later remove the producer tool.
There is no automatic transport reroute. Do not substitute Sol/Astra into a Chat
tools example: those exact models' Chat tool capability resolves unsupported.

## Select agents, tools and skills

Start from the generated agent declaration; edit its **exact** tools list rather
than adding a broad global grant. This is a complete declaration excerpt for the
bundled Planner shape, not an additional agent or a full catalog:

```yaml
planner:
  prompt: { reference: planner, compactable: true }
  tools: [create_card, edit_card, cancel_card, activate_card, reopen_card, reorder_child,
          list_cards, get_card, get_tree, read, write, edit, glob, grep,
          list_card_versions, get_card_version, diff_card_versions,
          read_record_version, websearch, webfetch]
  model_route: planner
  session: card
  can_create_children: true
  record_writes: [brief.md, status.md]
  skills: false
```

The tool must exist in the selected global/card scope; duplicates fail. Names do
not imply permission. `record_writes` restricts record mutation independently of
filesystem tools. `can_create_children` and the type's permitted-child set both
matter. Public `queue_notification` is selected only for the configured globals
Analyst/Oversight, not arbitrary card agents.

`skills: true` must agree with selecting `skill`. Optional target-project
`.saivage/skills/index.json` entries use configured skill-enabled agent names:

```json
[
  { "name": "release-checklist", "file": "release.md", "target_agents": ["executor"] }
]
```

Here `executor` must actually exist and be skill-enabled. File paths are relative
to `.saivage/skills/` and cannot escape it. A missing index is legitimate; `[]` is
empty. Selection makes a skill available for explicit tool use, not automatic
prompt injection. This runtime catalog is separate from OpenCode development skills.

### Enable explicit image inspection

Select `view_image` only for intended participants, with compatible routes and
summary capability. Bundled Analyst/Executor/Reviewer include it. Example tool
input, not YAML:

```json
{ "path": "screenshots/settings.png", "max_dimension": 1600 }
```

`max_dimension` defaults1600; integer1..16384 or `"original"` is supported.
Original skips spatial reduction, not orientation, normalization or limits.
Ordinary `read`/stdout is text, not image inspection. The source must be one static
raster within32MiB/40million pixels; selected PNG≤16MiB and image-bearing wire≤32MiB.
Avoid secrets in pixels: they cannot be text-redacted. See
[current versus recorded images](../runbook/evidence.md#current-file-versus-recorded-image)
and [native dependencies](../runbook/deployment.md#native-image-dependencies).
The [image accounting contract](../spec/system-specification.md#explicit-image-observations)
owns the bytes/raster reservation formula and documented Sol/Astra model limits;
those estimates are not billing, provider preprocessing equivalence or guaranteed fit.
Recorded snapshots remain retained evidence even when compaction omits narrative;
there is no image garbage-collection promise.

## Configure workflows and records

A card type declares permitted children, records and `workflow.format_version: 5`.
For retained explicit workflow2 inputs, follow the
[literal-key adoption boundary](../runbook/state-adoption.md#workflow3-literal-protection-keys),
not an automatic version rewrite.
Exactly one record is bootstrap; it supplies accepted objective context. Other
records may have absence-only starter data. Nodes select an agent or action,
completion record gates and outcome edges. All four lifecycle entries must resolve;
STOPPED requires a recovery prompt and must target the designated card-scoped
`notification_recipient`. Interruption routes to that recipient, not an old
invocation resumed from a transcript.

For graph changes, use the [developer workflow task](development.md#change-a-workflow-at-its-compiler-boundary)
and [exact field lookup](../reference/configuration.md#card-types-records-and-workflow).
Compiler closure includes topology, tool authority, prompt hosts, records,
incoming typed values and terminal promotion, not just YAML parsing. An unused
declaration is not equivalent to a participating retained identity; see
[participating identity changes](../runbook/state-adoption.md#participating-identity-changes).

### Add an action before acceptance

This **complete node excerpt** requires surrounding `assess`/`repair` nodes, lifecycle
entries and a declared nonbootstrap `check-report.md` record. It is not a full
workflow. It preserves a real command report before agent assessment:

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
      artifacts: [reports/test-summary.txt]
    inputs: { args: { literal: [--runInBand] } }
  output_record: check-report.md
  records:
    check-report.md: { mode: continue, gate: updated }
  edges:
    passed: { target: { node: assess } }
    failed: { target: { node: repair } }
    signalled: { target: { node: repair } }
    timed_out: { target: { node: repair } }
```

`shell.run` requires all four outcomes. Scripts are literal Bash with pipefail,
not implicit `set -e`; `args` are separate argv and belong in quoted `"$@"`, not
interpolated syntax. Config and inputs are not YAML environment-interpolated.
Environment is sanitized plus root variables and explicit safe literals; no secret
delivery or root-variable overrides. Artifacts are at most16 exact relative paths,
not globs or captured historical contents.

Omit `output_record` and use `records: {}` for capture-only execution. Binding
requires an exact declared nonbootstrap record and `continue/updated`. An open
draft blocks launch/publication. Eligible complete stdout is substantive strict
UTF-8 without NUL,≤1MiB, copied without trimming/truncation or stderr fallback.
It is factual `action-output` authorship with a command-stdout descriptor, not a test verdict; equal text from a fresh
invocation can become another accepted document. Actions cannot initialize/clean/
close records; other action requirements are accepted-only `continue/exists`.
Compiled plugins declaring returned-text use the same binding and acceptance owner,
with separately validated copied text rather than a plugin-selected capture path.
No-output actions cannot bind a destination. See the
[four-family cutover](../runbook/state-adoption.md#generalized-action-output) before
adopting this workflow input against retained state.

Typed routing supports action cases and predecessor output handoff, not arbitrary
expressions. Agent inputs use declared flat `data_inputs`; every entry/route must
supply each required field exactly once. A source such as `card_title` is a fact,
not new instructions. See [typed inputs and routes](../reference/configuration.md#typed-inputs-and-routes).

An optional `after_activation_commit` action runs only after a natural selected
done/blocked/failed outcome. It is advisory: it cannot undo DONE. Required build/test
checks belong in nodes **before** DONE. No startup/Stop/recovery replay or lost
result authorizes a retry. Pause gates providers; an admitted action chain can
continue. See [execution evidence](../runbook/evidence.md#action-execution-and-stdout).

### Initialize records without inventing authorship

These are two coordinated **excerpts**, inserted into the same complete card type
and an agent work node; the selected agent needs matching `record_writes` and `write`:

<div v-pre>

```yaml
# Under card_types.<type>.records:
status.md:
  format: markdown
  schema: work-status.v1
  bootstrap: false
  initialization:
    format_version: 1
    template: |
      # {{cardTitle}}
      Card: {{cardId}} ({{cardType}}), step {{nodeId}}, record {{recordName}}

# On its agent node, beside execution/edges:
initialize_records: [status.md]
records:
  status.md: { mode: continue, gate: updated }
```

</div>

Only an absent head renders a starter into **Baseline0**. Existing heads, including
empty-after-discard, suppress it. Baseline0/draft0/empty draft cannot satisfy an
authored gate. `clean` is a separate entry operation, not rerendering. Initializer
hosts allow the five shown tokens and direct fragments, no bootstrap initializer,
nested include or general interpolation; `${NAME}` stays literal. Starters are data,
not runtime prompt authority or review approval. Full semantics:
[entry data and record initialization](../architecture/prompts.md#entry-data-and-record-initialization).

## Set context budgets and Oversight

The provider example shows default compaction fractions. Utilization determines
usable input after output allowance; trigger and tail are fractions of that usable
input, not dollars or exact retention promises. `tail_fraction≤trigger_fraction`.
Whole rounds/atomic groups and straddler policy can retain more than the preferred
tail; fallback can cover more. The summarizer uses its own capacity. There is no
absolute-budget/completion-reserve legacy setting. See
[capacity and accounting](../runbook/diagnosis.md#capacity-and-accounting).

Oversight section excerpt:

```yaml
oversight:
  enabled: true
  agent: oversight
  interval_seconds: 7200
```

It uses a distinct global agent, read-only tools, no record writes, child creation,
skills or MCP. Configuration still compiles when disabled. The first check waits
one full continuous eligible running interval; Pause/Stop discard the wait. It can
notify a planning-capable card, not repair work directly. See
[Project Oversight](../spec/system-specification.md#project-oversight).

## Connect outbound MCP tools

This YAML excerpt defines **Saivage→tool-server** connections, not the inbound
Analyst listener:

```yaml
mcpServers:
  documentation-tools:
    transport: streamable-http
    url: https://tools.example.invalid/mcp
    disabled: false
    autostart: false
  local-tools:
    transport: stdio
    command: node
    args: [/absolute/path/to/server.js]
    autostart: false
```

Definitions do not grant agent tools. Select `mcp_server_control`, `mcp_tools` and
`mcp_tool_call` independently where intended. Start/discover before calling with
fresh binding/catalog identities. Restart is not catalog refresh; HTTP local stop
does not terminate the remote service. Dynamic registered definitions are separate
literal connections with no autostart, not YAML merges. Exact lifecycle, deadlines,
native ordered images/text, roots and the pinned browser recipe are in the
[outbound MCP procedure](../runbook/mcp.md#saivage-tools-to-configured-mcp-servers).

To expose **external client→Analyst**, choose immutable `start --analyst-mode`
inputs and the separate `SAIVAGE_ANALYST_MCP_TOKEN`; these are not `mcpServers`
fields. Use the [inbound procedure](../runbook/mcp.md#external-client-to-analyst)
for exact subset, project-bound loopback URL, protocol handshake and headers.

## Change stopped inputs deliberately

General prompt/tool/workflow/provider changes require new-process loading; editing
disk is not hot reload. Supported Analyst `reconfigure` operations (agent route,
model failover, server host/port) fresh-read and validate/compile the candidate,
**publish** next-start YAML and return `requires_restart: true`. This is neither
general invalid-schema repair nor live rebinding. Outbound MCP lifecycle operations
have their own current-entry reload rules, not whole-runtime reconfiguration.

Use the [canonical interpolation rules](../reference/configuration.md#owners-and-selected-input)
to distinguish expandable YAML values from literal data before changing the
service environment. Inspect that environment without disclosing values; warnings
do not validate credentials. Startup CLI/env selection is in the
[separate startup lookup](../reference/configuration.md#startup-only-cli-and-environment).

Changing a retained participating agent/node/record/workflow identity or durable
contract may require separately authorized adoption. Compilation, required-index
admission and readiness are not whole-history compatibility certification. Use
[state adoption](../runbook/state-adoption.md#choose-the-operation); do not let init,
previous slots, source approval or a restart stand in for consented reset or an
explicit external migration request. Prompt selection/custom guidance is explained
at [its actual composition owner](../architecture/prompts.md).
