# Configuration field reference

Init provisioning uses the same field validators as native `git_workflow` for
delivery branch, private namespace, source roots and exclusions. Its four
`--git-*` options are singleton/all-or-none; JSON path arrays preserve their exact
order and entries. No implicit source/exclusion/branch value is supplied. Existing
configurations are preserved, and supplied values must match their selected policy
exactly. The `classic-git` registry entry has a provision-required builder, not a
default effective config. Compilation selects its standalone prompt root, including
the real Executor correction participant on every type. Selected role overrides
must retain the `native-source` (card) or `native-global` capability include.

## Native Git policy declarations

The strict source/effective `git_workflow` input has initial `format_version: 1`.
Absence is OFF; explicit OFF is exactly `{format_version: 1, enabled: false}`.
ON requires all of:

- `delivery_branch`: literal attached branch name, not an OID, revision expression
  or full `refs/heads/` ref;
- `private_ref_namespace`: explicit namespace beneath `refs/saivage/`;
- nonempty, duplicate-free `source_roots` and `excluded_paths`: literal relative
  paths (`.` denotes the project root), not globs or URLs; exclusions include
  `.git` and `.saivage`;
- `integration: squash` and
  `preservation: {source_checkpoint: eligible-worktree, interrupted_rebase: preserve-source-before-abort}`;
- `correction: {agent, prompt, correction_prompt}`: an actual card Executor
  participant without child authority, with command/write tools and diagnostic
  `git-correction.md` permission; task and result-correction prompts use the existing
  static and durable declarations respectively;
- `review_bindings`: every configured card type explicitly maps to
  `{node, approved_outcome}` or null for a type without review. Bound review uses
  unchanged descendant context and routes approval to DONE or root completion
  assessment. Every participating type declares nonbootstrap `git-correction.md`.

Compilation freezes a detached policy and rejects authored correction-node
collisions/references, postcommit hooks and unsupported selected global writer
surfaces. Public effective configuration exposes only version/enabled, not source
paths, refs or correction provisioning. This validation is **not** native repository
qualification, identity-scoped ref allocation, commissioning or source adoption.

The opt-in classic-git profile supports ON with explicit provisioning and fresh
lifecycle-owned commissioning. Existing profiles remain OFF; there is no startup
toggle or retained-state adoption. Do not add these declarations to a running
project or interpret schema acceptance as successful repository commissioning.

The dependent native domain foundation currently qualifies an ordinary real-index
checkout, checkpoints eligible final worktree bytes through that real index, and
performs protected switches to an exact existing branch/tip. The initializer owns
fresh commissioning; CardService publishes source facts. Checkpoint normalization discards the prior staging split;
tracked/new/deleted files, executable bits and symlinks are source, while excluded
or nonignored out-of-scope dirt refuses before checkpoint. Sparse/split indexes,
submodules, filesystem-monitor hooks and non-round-tripping attributes are not
supported. Source names must be UTF-8; native command output is bounded to 8 MiB.
Git hooks are not disabled. Timeout, incomplete capture or unexpected mutation
failure contains the attempt without retry or inferred source publication.
Supervisor owns runtime native lifecycle, acceptance and source-fact publication;
fresh commissioning belongs to the lifecycle-held initializer, not the first Run.
Native entry derives `refs/heads/saivage/<commissioned-namespace-suffix>/<card-id>`
and creates that exact branch only when absent. Retained originals use the distinct
`refs/saivage/<suffix>/retained/<card-id>/<invocation-uuid>` namespace, create-only.
Reentry replays explicit old B..C onto the exact current parent; after a previous
delivery the delivered child endpoint replaces B as the replay boundary. Empty
and reapplied owned commits are retained. An identified untouched native conflict
is aborted and verified back at clean C before returning a correction task; hook
or custom-driver involvement prevents that automatic-abort certification.
Candidate preparation returns post-checkpoint source observations, not approval.
Correction verification requires exact task/retained-original/parent identities,
clean source and linear parent ancestry; it cannot prove semantic completeness.
Only CardService publishes returned source facts. Native delivery requires the exact clean
accepted child and parent tuple and materializes a squash in the **real parent
index**. It commits only that staged accepted tree, not later worktree dirt; an
unchanged tree makes no empty commit. Ordinary failure return checkpoints eligible
source privately and switches back without merging it.

ON global source writes use final synchronous stopped/clean delivery admission,
including delayed Webfetch saves and resolved aliases; OFF retains ordinary
mid-run behavior. Records and permitted non-source files are unaffected. Global
command-backed quality, arbitrary commands and unknown MCP writers are rejected
from actual provider bindings, not silently removed. Wait/kill process controls
and read-only MCP discovery remain available, but no unknown writer can start.
The MCP manager retains the startup mode across later configuration reads and
rejects dynamic registration/replacement, start/restart, catalog refresh/invocation
and enabled persisted reconciliation before connection or publication effects.
This is not permission to edit policy on a commissioned project or adopt dirt.

Interrupted correction preservation has two independent owner calls, each using
sequential direct managed Git commands rather than a subprocess coordinator.
`captureRebase` leaves the actual rebase/index untouched, selects final eligible
bytes/deletions/modes/symlinks through a fresh command-work index, and retains a
native snapshot separately from original B..C. Its result names both the original
task and partial snapshot plus the selected work artifact. Only **successful caller
source-fact publication and continuing settlement authority** permit a separate
`restoreRebaseAndReturn` invocation. That invocation rechecks exact task/snapshot
and actual source with a fresh index, then aborts the identified rebase, restores
the snapshot through native real-index/worktree restore, checkpoints it privately
and returns to the unchanged parent. It never uses the first temporary index as
authority or runs across a publication frontier. Source mismatch refuses before
abort; later failure contains without retry or manual file cleanup.

A partial c1 snapshot may omit original c2. The original endpoint/ref and correction
task remain retained: the snapshot is neither a new replay endpoint nor proof of
semantic completeness. A later correction must reconstruct original work and useful
resolutions while preserving parent-only work. Captures and returns consume only
their exact identified task/native rebase; foreign or unexplained progress refuses.
These steps use the native lifecycle owner and execution evidence. Fresh init
commissions the root before publishing its initial head; retained state is never
implicitly adopted. `checkpoint_source` is selected only for the bundle's Executor:
an empty-argument private checkpoint, not delivery, review approval or a repair API.

## Quality actions

### Optional tool binding input

The source/effective agent input accepts optional `quality_tools` with explicit
`format_version: 1`. It requires at least one of `code_quality_javascript_eslint`,
`code_quality_typescript_eslint`, `code_quality_python_ruff`, whose values use the
same strict action configs described below. Each binding requires that exact tool
name in the agent's `tools` list, and a selected quality tool requires its binding.
Unknown entries/versions fail. Omission configures and grants nothing. Outbound
effective configuration omits the entire provisioning section, including paths and
scope, while ordinary selected tool names remain visible.

Selected tools accept strict empty `{}` requests. They use only the configured
policy agent's frozen bindings; requests cannot supply paths, executable/module
names, operation IDs, scope, arguments or an output record. Card/global/internal
Analyst and external Analyst calls use the same compiled operation and interpreter.
External calls retain authentication and the configured Analyst/tool-subset policy;
credential attribution does not select a different agent. Tool calls produce work
evidence only, never a card execution entry or accepted action-output record.
Action and tool configuration are alternatives, not a requirement to run both.
The existing Oversight allowed-tool restriction is unchanged; this integration
does not grant it command-capable quality tools.

Explicit contract1 operations are `code-quality.javascript.eslint`,
`code-quality.typescript.eslint` and `code-quality.python.ruff`. No default workflow
selects them and no agent tool grant is implied. Use `execution.kind: action`,
`inputs: {}`, and optionally the ordinary `output_record` binding. See exact
[native prerequisites/licenses](./quality-tool-qualification.md).

All three strict configs require `cwd`, `native_config`, nonempty `source_paths`,
`exclusions`, `timeout_ms` (1–600000) and `terminate_grace_ms` (0–10000).
Source/exclusion entries are exact files or directory roots, not globs. Paths are
project-root-relative except executables; `cwd: .` is allowed. Runtime/private
roots, credentials, blocked resolved aliases and containment escapes are refused.
Unsupported/unmatched/ignored scope is incomplete analysis, not clean; explicit
exclusions stay visible. Source traversal never inventories canonical state.

JS requires absolute `node_binary` and contained `eslint_module` package directory.
TS additionally requires `typescript_eslint_module`, `typescript_module` package
directories and exact `tsconfig`. Python requires absolute `ruff_binary`. Native
configuration/imports/plugins are operator-authorized code, not request data or a
sandbox. Exact consumed pins are ESLint10.13.0, typescript-eslint/parser8.72.0,
TS5.9.3 and Ruff0.17.2. No PATH discovery, runtime installation or default grants.

Required outcomes: `clean`, `findings`, `analysis_failed`, `timed_out`, `signalled`.
Each exposes `finding_count`, `error_count`, `warning_count`, `analyzed_files`,
`coverage_complete`. Clean/findings lead to ordinary assessment, not automatic
DONE. Cancellation is not an outcome. Warning-only ESLint exit0 can be findings;
empty/incomplete scope, native failure and malformed output cannot be clean.

TS requires each file's effective pinned parser object, explicit single bound
project/tsconfigRootDir, enabled actual pinned typed-rule object through its plugin
alias, and Program/source/checker/maps/config identity observed during traversal.
No projectService, injected programs or syntax-only fallback. Missing/suppressed
observation or mixed typed/untyped scope fails. Inline suppressions remain disclosed
policy; lint is not `tsc` or complete correctness.

One managed helper owns metadata/analyzer children. Node compile cache is disabled;
ESLint uses fix:false/cache:false and an invocation-owned unused cache location;
Ruff forces no-fix/no-fix-only/no-cache/force-exclude. Host publication selects exact
UUID work artifacts `request.json`, `native.json`, `findings.json`, `metadata.json`,
`report.md`. Native and normalized findings retain full supported detail. Bounded
reports disclose omitted counts and full mutable artifact references, never a
lossless/native-output or product-acceptance claim. Limits are2000 selected files,
10000 visited source entries,16MiB complete helper transport,32MiB per complete
artifact and48000-byte report display. Full-resource overflow fails, not truncates.
Observed Git HEAD/dirty status, config/tsconfig/root lock hashes and scope metadata
do not freeze inputs or certify native-config dependency closure. Non-Git is valid.

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

Under workflow5, a key remains the exact parsed YAML string, not quote delimiters or
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
| `workflow` | Required workflow5 object below |

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
| `format_version` | Required | Literal4, independent of operation/initializer versions |
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
| `output_record` | Optional | Declared own nonbootstrap record; output-declaring action only, requires exactly continue/updated |
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
needs a route. `output_record` is on the **node**, not in this config or hook.
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
