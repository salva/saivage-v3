# Configuration field reference

## Optional observed source inputs

`src/retrieval/collection-definitions.ts` owns two strict version1 JSON contracts.
`.saivage/config/observed-collections.json` has type `observed-collections` and
`collections` (0–32 entries). Each has unique name `[a-z][a-z0-9-]{0,63}`, purpose
(1–1024 UTF-8 bytes), kind `documentation|code`, project-relative directory
(1–512 bytes), include (1–64 patterns) and exclude (0–64 patterns). Skills are
documentation. Literal components allow letters, digits, underscore, dot, space
and `@+,-`; patterns also allow component `*` and whole-component `**`. Empty,
dot/parent components, absolute roots, negation and regex syntax are rejected;
directory `.` denotes project root. Patterns are case-sensitive; exclusions win.
Absent definitions disable retrieval; malformed present inputs fail their consumer.
No hot reload. Reset preserves these operator inputs.

Private `.saivage/config/observed-collections-native.json` has type
`xerj-observed-deployment`: endpoint `http://127.0.0.1:<port>`, native
`{source,executable,sha256}`, model `{revision,directory,mode,dimensions,files}`,
roots `[{directory,prefix}]`. Exact source/build/model values are schema-selected;
prefixes are unique `sv-` plus32 lowercase hex digits. Roots are canonical
project-relative identities. No concrete destinations, mapping/copy-pipeline
schema, token, progress or capability cache. Unsupported versions/unknown fields
fail. Descriptor and fixed `.saivage/config/xerj.key` are refused by Files,
including resolved aliases before body reads. The raw key allows nonblank opaque
text≤4096 UTF-8 bytes total, one optional final newline, no embedded whitespace/
controls. Failures do not expose content; rotation requires adoption/client restart.

See [prepare/adopt](../runbook/observed-collections.md) for exact dependency paths,
CLI, generated units and uneven native embedding limits.

Lookup for the **current source contract**, not a supported-version matrix or a
second behavior specification. For tasks and coordinated examples use
[Configure an instance](../guides/configuration.md). For existing-state changes use
[state adoption](../runbook/state-adoption.md). All objects below are strict:
unknown keys are rejected, not ignored. “Required” means no source-schema default;
bundled template values are listed separately from defaults.

## Owners and selected input

| Concern | Actual owner |
| --- | --- |
| YAML shape and defaults | [`saivageConfigSchema`](https://github.com/salva/saivage-v3/blob/HEAD/src/schemas/saivage-config.ts) |
| Selected file, decode, effective type map and publication | [`ResolvedConfigAuthority`](https://github.com/salva/saivage-v3/blob/HEAD/src/config/resolved-config-authority.ts) |
| Environment expansion/exceptions | [`interpolateValue`](https://github.com/salva/saivage-v3/blob/HEAD/src/config/env-interpolation.ts) |
| Cross-field semantics, prompts, graph, tool scope | [`compileProjectWorkflows`](https://github.com/salva/saivage-v3/blob/HEAD/src/runtime/card-process/card-process-config.ts) |
| Candidate capabilities/model resolution | [`Provider`](https://github.com/salva/saivage-v3/blob/HEAD/src/agents/provider.ts), [capability merge](https://github.com/salva/saivage-v3/blob/HEAD/src/agents/provider-capabilities.ts) |
| Live model/tool capacity binding | `bindRuntimeWorkflows` in the workflow compiler |
| Startup selection | [`loadEnvironment`](https://github.com/salva/saivage-v3/blob/HEAD/src/config/environment.ts), [`parseCommand`](https://github.com/salva/saivage-v3/blob/HEAD/src/cli.ts), [Analyst startup](https://github.com/salva/saivage-v3/blob/HEAD/src/config/analyst-mode.ts) |

Default path is `<project>/.saivage/saivage.yaml`. Ordinary string values expand
`${ENV_VAR}` from the captured startup environment. Missing variables substitute
empty strings and, after successful loading, produce redacted advisory warnings
without values. Keys are not expansion hosts. Record initializer `template` and
action execution `config`/`inputs` and durable prompt `compaction_key` values remain
literal. The latter exception applies to lifecycle entry, correction, record,
direct/conditional route and pending-notification declarations, not arbitrary
fields sharing that name. Prompt references still expand normally. Dynamic MCP connection values
are also literal, independently of YAML.

The source schema decodes first; an omitted `card_types` gets the complete classic
map; the effective schema and workflow compiler then validate it. There is no
partial-map merge. Reconfigure publishes validated next-start YAML and reports
restart required; it does not hot-load workflows/prompts.

### Command-specific input selection

| Command | Project root | YAML / control authority |
| --- | --- | --- |
| `start` | `--project-root` → `SAIVAGE_PROJECT_ROOT` → cwd, canonicalized | `--config` → `SAIVAGE_CONFIG` → selected root's `.saivage/saivage.yaml` |
| `init`, `reset`, `repair` | Exact cwd, canonicalized; no ancestor search | That root's `.saivage/saivage.yaml`, with the invoking process's interpolation environment; Start root/config selectors do not apply |
| `status`, `pause`, `resume`, `stop`, `restart_server`, `gc-work` | Nearest ancestor of cwd, including cwd, containing `.saivage/saivage.yaml` (`findProjectRoot`) | Only the selected project's verified live lock endpoint/auth; never endpoint rediscovery from YAML, flags, environment or defaults |

Offline commands do not accept `--project-root` or `--config`. Init alone may
materialize an absent canonical YAML from its selected profile. Identical YAML text
does not establish identical effective inputs when interpolation environments or
prompt closure differ. Before consequential retained-input operations, follow the
[offline input gate](../runbook/state-adoption.md#offline-command-inputs).
Control commands retain their [five-way ownership outcomes](../runbook/runtime-control.md#five-ownership-outcomes),
not offline runtime-state access.

## Top-level YAML

### Explicit work GC inputs

`saivage gc-work [--before <timestamp>] [--target-bytes <bytes>] [--dry-run | --delete]`
has no YAML settings, scheduler or startup/environment aliases for its filters.
Default and explicit dry-run select API mode `dry_run`; `--delete` selects `delete`.
Both flags together are rejected before delegation. `before` is RFC3339 with an
explicit zone and means mtime strictly earlier; `target_bytes` is an optional
nonnegative safe integer for best-effort accounted logical bytes remaining. The
strict `POST /api/runtime/gc-work` body requires `mode`, accepts only those two
optional fields and rejects unknown keys. Operator-session authentication applies;
CLI bearer delegation uses `SAIVAGE_API_TOKEN` only when the live lock publishes
bearer mode. Missing/dead/unverifiable owners or null endpoints refuse without
fallback. This is not an offline command. Follow the
[preview-first procedure](../runbook/work-gc.md); each delete computes a new selection.

### YAML keys

| Key | Required/default | Contents |
| --- | --- | --- |
| `agents` | Required | Map of named declarations; [agents](#agents) |
| `analyst_agent` | Required | Existing global agent name |
| `oversight` | Required | Enabled policy, distinct global agent and interval; [Oversight](#oversight) |
| `models` | Required | Routes plus profile/equivalence/failover expansion |
| `providers` | `{}` | Provider map; empty may parse but cannot supply required runtime candidates |
| `server` | `{port: 8080, host: '0.0.0.0'}` | Bind defaults, overridable by startup inputs |
| `compaction` | Required | Enabled literal true, fractions and fixed summarizer |
| `card_types` | Optional in source | Omission selects complete classic types; required in effective config |
| `mcpServers` | Optional | Outbound server entries; not inbound Analyst settings |

No top-level legacy role-model keys, `analyst_mode`, token field, absolute context
budget or arbitrary plugin-install declaration exists.

### Identifier vocabulary

Agent, card-type, route/profile, prompt reference and compiled node identifiers
start with a lowercase letter, then up to63 lowercase letters/digits/hyphens.
Outcome IDs additionally allow underscore. Tool names use lowercase letters/digits/
underscore, letter first,≤64. Record names are a letter-led lowercase
letters/digits/hyphens stem≤64 followed by `.md`, with no directories.
`record_writes` patterns allow `*` within that stem (including at its start).
Record `schema` labels use the same letter-led stem followed by `.v` and a positive
decimal version. These labels are not runtime migration instructions.

Owners: [agent](https://github.com/salva/saivage-v3/blob/HEAD/src/schemas/agent-name.ts), [card type](https://github.com/salva/saivage-v3/blob/HEAD/src/schemas/card-type-name.ts),
[record](https://github.com/salva/saivage-v3/blob/HEAD/src/schemas/record-name.ts) and the configuration/compiler schemas.

## Providers and accounts

Path `providers.<provider>`, source `providerEntrySchema`:

| Field | Default/constraint | Meaning |
| --- | --- | --- |
| `priority` | Optional integer; runtime50 | Lower provider priority selected first |
| `models` | Optional string array; runtime empty | Model IDs this provider offers |
| `apiKey` | Optional string | Credential; prefer environment substitution/private input |
| `baseUrl` | Optional string | Protocol endpoint override, not a universal URL default |
| `authProfile` | Optional string | Stored auth-profile reference |
| `capabilities` | Optional object | Provider-level declarations below |
| `modelCapabilities` | Optional map model→capability object | Highest-priority capability overrides |
| `accounts` | Optional map name→account | Explicit candidate credentials/configuration |

Each account accepts only `priority` (integer, runtime100), `apiKey`, `baseUrl`,
`authProfile`, `models` and `capabilities`. Omitted account models inherit provider
model eligibility. Provider must list the model. Eligible explicit accounts are
ordered lower-priority first; when none serves it, the provider's implicit account
can serve it from provider settings. With no explicit accounts the implicit account
is used. Its candidate `account` is `null`; named candidates carry the account name.
Model routes do not select a named account; the fixed summarizer candidate can.

### Capability object

All fields are optional **overrides**, not universal service facts:

| Field | Accepted values / constraint | Global resolution default |
| --- | --- | --- |
| `transportProtocol` | `openai-chat-completions`, `openai-responses`, `openai-codex-backend` | `openai-chat-completions` |
| `toolsMode` | `native`, `unsupported` | `native` |
| `imageInput` | Boolean | false |
| `exclusiveToolChoiceSupport` | `native`, `parallel_off`, `unsupported` | `native` |
| `responsesReasoning` | Strict object with optional `effort`: minimal/low/medium/high | Absent |
| `contextWindowTokens` | Positive integer | No global numeric default |
| `maxOutputTokens` | Positive integer | No global numeric default |
| `quirks` | String array | `[]` |

Resolution is model override→account→provider→built-in model/provider→global.
Built-in `openai-codex` uses Codex transport, `parallel_off` and its named quirk;
`github-copilot` supplies its auth-profile quirk. Exact models `gpt-6.1-sol` and
`gpt-6-astra` get built-in image support, but their Chat transport tool mode is
unsupported. Image requirements reject Chat even if `imageInput: true`. Local
declarations do not certify remote behavior or credential validity.

Use the [coherent provider/routes/summary excerpt](../guides/configuration.md#wire-provider-routes-and-summary)
instead of copying one capability row as a provider recipe. Secret-bearing auth
profiles are separate inputs, not a YAML object to paste into docs or logs.

## Models and route expansion

| Path | Required/default | Constraint |
| --- | --- | --- |
| `models.routes` | Required map | Named route declarations |
| `routes.<name>.candidates` | One of candidates/profile | Nonempty list of nonempty IDs; compiler rejects duplicate route candidates |
| `routes.<name>.profile` | One of candidates/profile | Existing named profile with nonempty resolved model list |
| `routes.<name>.temperature` | Required | Number0..2 |
| `routes.<name>.max_tokens` | Required | Positive integer; candidate capacity must support request |
| `models.profiles` | `{}` | Name→strict `{preferred, allowed}` |
| `profiles.<name>.preferred` / `.allowed` | Each `[]` | Ordered string lists; compiler checks duplicates for referenced profiles |
| `models.equivalents` | `[]` | Array of model-ID arrays |
| `models.failover` | `{}` | Model→ordered nonempty-string array; compiler rejects unknown/duplicate references |

Expansion takes explicit candidates, or profile preferred then allowed. For each
model: add that model, then other IDs in its first matching equivalence group,
then its configured failover list. Keep the first occurrence of each ID. Each ID
resolves across providers/accounts by their priorities. This is candidate ordering,
not a promise of failover for every failure class; see
[provider failure classification](../spec/system-specification.md#provider-failure-classification-and-transport-completion).
Saivage does not compact merely to fit a small fallback model.

Profile-route **excerpt** (assumes these IDs have provider declarations):

```yaml
models:
  routes:
    planner: { profile: planning, temperature: 0.7, max_tokens: 4096 }
  profiles:
    planning: { preferred: [large-model], allowed: [other-model] }
  equivalents: []
  failover: {}
```

This is not the five-route replacement used by the bundled catalog; use the
guide's coordinated example for that task.

## Agents

Path `agents.<name>`; all fields required except the inner prompt default:

| Field | Type / constraint |
| --- | --- |
| `prompt` | Static prompt declaration below |
| `tools` | Exact ordered array of canonical scope-valid tool names; no duplicates |
| `model_route` | Existing route identifier |
| `skills` | Boolean; must equal whether `skill` is selected |
| `session` | `global` or `card` |
| `can_create_children` | Boolean; `create_card` requires true |
| `record_writes` | Unique lowercase `.md` name/pattern array, with `*` wildcard support |

The configured `analyst_agent` must be global. Card nodes/notification recipients
must be card-scoped. Only configured Analyst/Oversight globals may select public
`queue_notification`. Tools are compiled from actual binders, not inferred from
agent labels. The [shipped inventory](../architecture/system-architecture.md#agent-tools)
is the precise tool lookup, not this field table.

### Prompt declarations

| Declaration | Fields | Default/constraint |
| --- | --- | --- |
| Static: agent role, agent-node task | `reference`, `compactable` | Reference required; compactable defaults true |
| Durable: correction, entry, edge, pending-notification or record prompt | `reference`, `compactable`, optional `compaction_key` | compactable true; a nonempty key is allowed only with compactable false |

Under workflow3, a key is the exact parsed YAML string, not quote delimiters or
escape spelling. `${POLICY_KEY}`, embedded substitutions, whitespace, case and
Unicode remain literal whether variables exist or not; no key-only missing-variable
warning is emitted. Empty is invalid; whitespace-only is nonempty and is not
trimmed. Static declarations still forbid keys. Body rendering and fragment
inclusion do not transform key identity. See [protection semantics](../architecture/prompts.md#declaration-owned-retention)
and [workflow adoption](../runbook/state-adoption.md#workflow3-literal-protection-keys).

References select `.md` files by the actual override tiers, not by agent name
alone. Globals use shared hosts; card hosts select project-card/shared then bundled
card/shared tiers in root-major order. One-level fragments and host-specific tokens
are compiled. Card-workflow **agent role templates** use the `workflow-agent` host,
which requires exactly one `contractDescription` placeholder after fragment
expansion. Node task and other **process templates** use the `process` host: they
accept `cardType`, not `contractDescription`. Record-context and initializer hosts
have their own tokens and counts. Complete host table and selection rules:
[prompt compiler contract](../architecture/prompts.md#compiler-and-host-contract).

## Oversight

All fields required; bundled values are `enabled: true`, `agent: oversight`,
`interval_seconds: 7200` (template choices, not source-schema defaults).

| Field | Constraint |
| --- | --- |
| `enabled` | Boolean; disabled policy still compiles |
| `agent` | Existing global agent distinct from Analyst; no child creation, record writes or skills; restricted read-only/notification tool inventory |
| `interval_seconds` | Positive number whose milliseconds are finite and positive; not restricted to integers |

The running epoch/cadence is process-local. First check waits a full continuous
eligible interval; no persisted due-time queue. See the complete
[schedule and lifecycle](../spec/system-specification.md#schedule-and-lifecycle).

## Compaction

Path `compaction`; source `compactionSectionSchema`:

| Field | Required/default | Constraint |
| --- | --- | --- |
| `enabled` | Required | Literal true; disabling is not a current option |
| `context_utilization_fraction` | 0.8 | >0 and≤1 |
| `trigger_fraction` | 0.9 | >0 and≤1 |
| `tail_fraction` | 0.25 | 0..1 and≤trigger_fraction |
| `snap` | `keep_straddler_verbatim` | Or `compact_straddler` |
| `summarizer_candidate` | Required | Strict `{provider, account, model}`; provider/model nonempty strings, account nonempty string or explicit null |

Usable input is candidate-specific, subtracting requested output after utilization;
binding freezes positive eligible capacities. Tail is a target of that usable
input, not guaranteed verbatim retention. The fixed summary candidate must resolve
and support its2000-token output request and relevant image capability. Full
arithmetic/whole-round snapping/atomic constraints and failures are owned by
[capacity and accounting](../runbook/diagnosis.md#capacity-and-accounting) and the
[provider-context specification](../spec/system-specification.md#provider-context-and-preparation).
These fractions do not cap cost or ensure a request fits.

## Card types, records and workflow

Path `card_types.<type>`; `project` required in a supplied map:

| Field | Constraint |
| --- | --- |
| `permitted_child_types` | Required array; configured unique types, never `project`; empty means leaf |
| `records` | Required name→record declaration map; exactly one bootstrap record |
| `workflow` | Required workflow3 object below |

At resulting card depth12 creation requires a compiled leaf type. Child permission
and card identity are runtime requirements, not configurable allocation scans.

### Record declarations and initialization

| Field | Required/default | Constraint |
| --- | --- | --- |
| `format` | Required | Literal `markdown` |
| `schema` | Required | Label such as `work-status.v1` |
| `bootstrap` | Required | Boolean; exactly one true per type |
| `initialization` | Optional or null | Strict `{format_version: 1, template: nonblank-string}`; bootstrap initialization forbidden |

Initializer text allows cardType/cardId/cardTitle/nodeId/recordName tokens and direct
fragment includes. It is literal data, not environment expansion or a prompt grant.
Node selection and exact write permission are separate. See the
[coordinated initializer example](../guides/configuration.md#initialize-records-without-inventing-authorship)
and [baseline0/draft/accepted semantics](../runbook/evidence.md#baseline0-drafts-and-accepted-documents).

### Workflow object

| Field | Required/default | Constraint |
| --- | --- | --- |
| `format_version` | Required | Literal3, independent of operation/initializer versions |
| `notification_recipient` | Required | Existing card agent used by a workflow node |
| `entries` | Required | Exactly BACKLOG, CHANGED, BLOCKED, STOPPED |
| `entries.<entry>.node` | Required | Existing node; compiler validates identifier |
| `entries.<entry>.prompt` | Optional except required STOPPED | Durable declaration; cannot target action |
| `nodes` | Required | Nonempty node map; all reachable from entries and with a path to terminal |
| `after_activation_commit` | Optional | Strict `{statuses, execution}`; unique nonempty subset done/blocked/failed and action execution |

STOPPED must target the notification recipient's agent node. Nonrecipient DONE
edges require a pending-notification route to that recipient; recipient DONE edges
cannot declare it. Full graph semantics, including interruption and promotion, are
owned by the [workflow engine](../spec/system-specification.md#workflow-engine).

### Node object

| Field | Required/default | Constraint |
| --- | --- | --- |
| `execution` | Required | Discriminated agent/action below |
| `stdout_record` | Optional | Declared own nonbootstrap record; shell.run only, requires exactly continue/updated |
| `initialize_records` | Optional unique ordered record list | Agent only; each declared initializer, matching write pattern and direct write tool |
| `record_prompts` | Optional array | Agent only; each strict `{record, selection, presence, prompt}` |
| `record_prompts[].selection` | Required | accepted/effective |
| `record_prompts[].presence` | Required | required/optional |
| `record_prompts[].prompt` | Required | Durable record-context host declaration |
| `records` | `{}` | Name→strict `{mode: clean\|continue, gate: exists\|updated}` |
| `descendant_context` | Optional | Agent only; strict `{records: record-name-array, require_unchanged_until_accept: boolean}` |
| `edges` | Required nonempty map | Outcome→direct or conditional edge |

Agent record requirements must match record-write authority; clean/updated needs
`write`. Apart from its bound stdout record, action requirements are accepted-only
continue/exists; actions cannot initialize/clean/close records. Conditional record
prompts are fresh same-read observations, not immutable requirement text inferred
from a descriptor. See [same-read record supplier](../architecture/prompts.md#same-read-record-supplier).

### Agent and action execution

| Agent `execution` field | Required/default |
| --- | --- |
| `kind` | Literal `agent` |
| `agent` | Existing card-scoped agent |
| `prompt` | Static process-host declaration for the node task |
| `correction_prompt` | Durable declaration |
| `data_inputs` | Optional name→flat data-field declarations |
| `inputs` | Optional name→literal/factual binding |

| Action `execution` field | Required/default |
| --- | --- |
| `kind` | Literal `action` |
| `action` | Exact compiled operation ID, e.g. shell.run |
| `contract_version` | Literal1 |
| `config` | Required; selected operation's strict schema |
| `inputs` | Required map, including explicit args supplier for shell.run |

No model, prompt or session is selected by an action. Operation IDs use exactly
two dot-separated components, each letter-led lowercase letters/digits/hyphens≤48.
Trusted plugin declarations are explicitly compiled modules, not a YAML-installed
service. Reserved shell/git/saivage namespaces do not imply operations exist.
Owner: [operation contracts](https://github.com/salva/saivage-v3/blob/HEAD/src/runtime/card-process/operation-contract.ts).

### shell.run config

Owner: [`shellOperationConfigSchema`](https://github.com/salva/saivage-v3/blob/HEAD/src/runtime/card-process/shell-operation.ts).

| Field | Required/default | Constraint |
| --- | --- | --- |
| `script` | Required | Nonblank safe literal≤4096UTF-8 bytes; Bash with pipefail, no implicit set-e |
| `cwd` | `.` | Exact project-relative path; no absolute, empty, dot or dotdot components (except sole `.`) |
| `env` | `{}` | Shell variable name→safe literal≤4096bytes; no secret keys or PROJECT_ROOT/SAIVAGE_ROOT overrides |
| `timeout_ms` | 120000 | Integer1..600000 |
| `terminate_grace_ms` | 2000 | Integer0..10000 |
| `artifacts` | `[]` | ≤16 unique exact relative paths, no globs |

Required input `args` is strings. Outcomes are exactly passed(exit_code0),
failed(exit_code≥1), signalled(signal string), timed_out(reason string). Every outcome
needs a route. `stdout_record` is on the **node**, not in this config or hook.
See the [action example](../guides/configuration.md#add-an-action-before-acceptance).

### Typed inputs and routes

Owner: [`operation-routing.ts`](https://github.com/salva/saivage-v3/blob/HEAD/src/runtime/card-process/operation-routing.ts).
Flat fields are string (optional enum), integer (optional safe min/max), boolean
or strings. Field names are letter-led lowercase letters/digits/underscore≤48;
max32 fields,≤4096UTF-8 bytes/string,≤256 list elements,≤64KiB encoded values. No
nested objects, defaults, coercion or expression evaluator. Private operation fields
cannot route, feed another node or be retained as public observations.

| Shape | Fields / constraints |
| --- | --- |
| Base input binding | Exactly `{literal: string\|boolean\|safe-integer\|string[]}` or `{source: card_id\|card_type\|card_title\|committed_status}`; committed_status hook-only |
| Direct route | Required target, optional durable prompt, pending_notifications and inputs |
| Node target | Exactly `{node: identifier}` |
| Terminal target | Exactly `{terminal: DONE\|BLOCKED\|FAILED, promote: current\|{latest_node: identifier}, export_records: record-name-array}` |
| `pending_notifications` | Exactly `{node, prompt}`; recipient agent recovery alternative on nonrecipient DONE only |
| Route `inputs` | Destination field→`{output: predecessor-field}`; terminal routes cannot bind inputs |
| Conditional edge | `{cases: [...], otherwise: direct-route}`; action only,1..8 cases |
| Each case | Direct-route fields plus required unique `id` and `when: {field, op, value}` |
| `when` | eq (typed scalar equality), gt/gte/lt/lte (integer only); scalar value string/boolean/safe-integer |

First matching case wins after full operation-return validation. All incoming
routes/lifecycle entries/pending re-entry must supply every destination input
exactly once, with compatible bounds. Agent predecessor outputs are not invented.
Promotion by latest_node must name a real reachable predecessor; export and record
context closure is compiler-checked. Agent prompts cannot target actions.

Typed handoff **excerpt**, assuming a declared compatible integer output `count`
and destination input `findings`:

```yaml
# On an action outcome route:
target: { node: assess }
inputs: { findings: { output: count } }
# In assess.execution:
# data_inputs: { findings: { type: integer, min: 0, max: 1000 } }
```

This does not claim shell.run returns `count`; it demonstrates the binding shape
for an explicitly compiled operation declaring that field. Nonempty selected agent
entry data is delivered once as quoted compactable facts, not tool/write authority.

## Outbound MCP YAML

Path `mcpServers.<name>`; two disjoint strict shapes:

| Field | stdio | streamable-http |
| --- | --- | --- |
| `transport` | Required literal stdio | Required literal streamable-http |
| `command` | Required nonempty string | Not accepted |
| `args` | Optional string array | Not accepted |
| `env` | Optional string→string map | Not accepted |
| `url` | Not accepted | Required absolute HTTP(S) URL |
| `disabled` | false | false |
| `autostart` | true | true |

YAML connections use normal interpolation. Dynamic
`.saivage/config/mcp-servers.json` definitions use connection-only fields, remain
literal and never autostart; they cannot collide with YAML names. Transport config,
tool grants, live binding and discovered catalog are distinct. Definition edits do
not hot-rebind the whole runtime. Full example and operations:
[outbound MCP](../runbook/mcp.md#saivage-tools-to-configured-mcp-servers).

## Server YAML

`server.host` is a string default `0.0.0.0`; `server.port` is a positive integer
default8080. YAML does not admit0 and does not itself impose the CLI65535 upper
bound. Do not advertise wildcard binding without deployment-owned confinement.
Actual listener parsing/binding is a separate startup boundary; port0 is available
only through startup CLI/env. There are no YAML operator-token, inbound Analyst or
private failed-request-capture fields.

## Startup-only CLI and environment

These are **not YAML keys**. `start` singleton options reject duplicates; other
commands do not inherit start flags. Runtime-control CLI commands use only the
verified live lock's published endpoint/auth, not these startup inputs.

| Selection | Precedence/default or constraint |
| --- | --- |
| Project | `--project-root`→SAIVAGE_PROJECT_ROOT→cwd; canonical existing root |
| Config | `--config`→SAIVAGE_CONFIG→project/.saivage/saivage.yaml |
| Host | `--host`→SAIVAGE_HOST→server.host |
| Port | `--port`→SAIVAGE_PORT→server.port; CLI/env integer0..65535, selected raw input validated without fallback |
| `--create-runtime` | Explicit initial-runtime publication option, not repair/reset |
| SAIVAGE_API_TOKEN | Unset disables operator auth; blank/padded fails; never a URL token |
| NODE_ENV | production default; development/production/test |
| LOG_LEVEL | info default; fatal/error/warn/info/debug/trace/silent |
| `--failed-provider-diagnostics UUID` | CLI-only, off by default; sensitive bounded private capture, not a persisted setting/environment alias |

Failed-request capture consequences/retention are in
[private failed-request captures](../runbook/diagnosis.md#private-failed-request-captures).
Bind/auth/service setup is in [deployment](../runbook/deployment.md#start-inputs).
The browser has no token login; use [private browser credential setup](../runbook/deployment.md#browser-credential-setup).
Credential environment is not automatically passed
to child commands; the [command allowlist](../runbook/deployment.md#child-command-environment)
owns that separate contract.

### Inbound Analyst startup selection

| Input | Default/constraint |
| --- | --- |
| `--analyst-mode` | internal default; internal/external/both |
| `--analyst-mcp-port` | Required external/both; decimal integer1..65535 |
| `--analyst-mcp-principal` | Required external/both; letter-led lowercase letters/digits/hyphens≤64; credential-holder label, not verified identity |
| `--analyst-mcp-tools` | Required nonempty unique comma-separated exact subset of configured Analyst canonical tools; no wildcard/role inference |
| SAIVAGE_ANALYST_MCP_TOKEN | Required external/both, nonblank/unpadded, different from operator REST token |

There are **no mode/port/principal/tools environment aliases**. Internal mode
rejects unused external settings/token. Selected startup settings are immutable.
External-only disables internal submissions before ingress/provider, not internal
history inspection. Both exposes concurrent operations, not shared chat/lease.

The listener is `127.0.0.1` at a project-digest-bound path announced on startup;
do not construct a guessed URL. The full
[inbound procedure](../runbook/mcp.md#external-client-to-analyst) owns protocol2025-11-25,
initialize/context/discovery, mandatory JSON+event-stream Accept/header requirements,
separate bearer, no Origin/query/session/batch/GET stream, and calls surviving
disconnect. Project Stop does not close this application-owned listener.

## What lookup does not establish

Schema acceptance is not workflow compilation, runtime capability binding, whole
retained-history compatibility, remote credential validation or provider delivery.
Read [participating identity changes](../runbook/state-adoption.md#participating-identity-changes)
before replacing installed maps, and [durable source evidence](../architecture/durable-format-changes.md#current-source-baseline)
when comparing releases. This reference performs no conversion or live adoption.
