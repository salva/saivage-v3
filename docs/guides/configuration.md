# Configuration

Status: non-authoritative guide. The selected configuration's exact contracts
are owned by the [System specification](../spec/system-specification.md) and
the [Operator runbook](../runbook/index.md); this page explains how to
configure a working instance. New to cards, records, or sessions? See the
[glossary](../overview.md#glossary).

Saivage reads one strict YAML file: `.saivage/saivage.yaml` in the target
project. `saivage init` materializes it from a bundled template; after that
the instance owns it, and every change takes effect on the next start.
`${ENV_VAR}` references are interpolated from the service environment at
startup — keep API keys out of the file. Validation is strict: unknown or
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
      notification_recipient: planner
      entries: { BACKLOG: { node: plan }, CHANGED: { node: plan }, ... }
      nodes:
        plan:
          agent: planner
          prompt: { reference: plan }
          edges: { ... }
```

Every workflow's `STOPPED` entry must target a node run by its declared
`notification_recipient` and supply a recovery prompt. The compiler derives an
interruption transition from every node to that same target, including same-node
re-entry; it is not a model outcome. The recipient must reconstruct current
facts rather than resume an old invocation. Child-bearing custom recipients
need not have activation tools merely to accept the workflow: ancestor notices
ask for discretionary action, not guaranteed dispatch. Both bundled profiles
already supply recipient-first STOPPED routes. Materialized instance prompts
and configuration are instance-owned; reconcile them deliberately while stopped.

Switching templates or replacing the map is a stopped configuration change;
the runbook owns [identity-cutover rules](../runbook/index.md#agent-and-workflow-identity-cutovers)
for instances with retained history. After a change, verify what actually
compiled in the control room's [System > Installed workflows](./operating.md#system) view.

## Compaction

Long conversations are summarized when they approach the model window:

```yaml
compaction:
  enabled: true
  context_utilization_fraction: 0.80   # usable fraction of the window
  trigger_fraction: 0.90               # when to prepare compaction
  tail_fraction: 0.25                  # recent history always kept verbatim
  snap: keep_straddler_verbatim        # or compact_straddler
  summarizer_candidate: { provider: my-provider, account: null, model: my-model }
```

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
agent's configured tool inventory. Reconciliation happens at startup.

## Server

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
Everything else — prompts, tool lists, workflows, providers — is a stopped
edit followed by a fresh start.
