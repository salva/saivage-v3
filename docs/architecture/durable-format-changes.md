# Durable format changes

## Purpose and evidence limits

This is the maintained source-contract baseline and bounded change record under
[AGENTS Storage Policy](https://github.com/salva/saivage-v3/blob/HEAD/AGENTS.md#durable-format-versioning).
It is not a supported-version matrix, exhaustive retrospective changelog,
deployment inventory, runtime registry, compatibility checker, converter or
operational consent. Current contracts remain owned by the
[specification](../spec/system-specification.md) and
[architecture](./system-architecture.md); procedures remain owned by the
[state-adoption runbook](../runbook/state-adoption.md).

The summary-maintenance entry records source parent
`9dce1e8eef3e43d04a7711f3c4225fcfc30ae5c4` (conversation 6) and its format-7
target. The later minimal dynamic MCP entry records its exact source parent
`e980b1b14ce859808e469d4e2018e75f142ab30d`, already conversation 7.
Introduction commits below establish source boundaries, not deployment dates or
installed-state facts. Compare the selected releases' actual owning schemas and
semantic consumers, including later changes; equal versions and successful startup
do not certify whole-project or historical compatibility. Maintain affected
baseline/change entries with implementation, recording evidence and honest unknowns.

## Current source baseline

This table describes the current owning source contracts, not an installed-state
inventory. Paths/owners are relative to `src/` unless they start with `.saivage`.
The [historical entries](#historical-source-contract-entries) retain their own
source-era values; they must not be read as today's accepted-version list.

| Durable family | Exact path/owner | Discriminator and selected meaning |
| --- | --- | --- |
| Card current head / previous slot | Card namespace `card-head.json`, `card-head.prev.json`; `persistence/canonical-card-artifacts.ts`, `card-files.ts` | `format_version:1`, `kind:card-head`; fresh head UUID, ordinary selection and ordered current-only mailbox UUIDs. Previous slot shares this selector contract, not separate numbering. |
| Immutable card history | `card-history/<UUID>.json`; same owners | `format_version:5`, `card-version` / `card-tombstone`; minimal ordinary/final payload, qualified action executor and external attribution, predecessor-linked sparse ordinary revisions, no historical queue. |
| Mailbox documents | `mailbox/<UUID>.json`; same owners | `format_version:1`, `kind:card-message`; exact message identity selected by current head, not a queue log. |
| Record head / previous slot | `records/record-<stem>.json` and injective `.prev.json` sibling; `persistence/canonical-record-artifacts.ts`, `authored-record-files.ts` | `format_version:3`, `kind:record-head`; fresh UUID/mutation revision, current-only baseline0, explicit draft version/target and latest accepted reference. Baseline/draft0/empty is ineligible. |
| Accepted record history | `records/accepted/<UUID>.json`; same owners | `format_version:5`, `kind:accepted-record`; consecutive document versions, immutable body/discriminated agent/external/runtime/action-output author with body-bound output descriptor and ordinary card provenance. Historical projection has null current head/revision. |
| Record initialization input | Card-type YAML; `schemas/saivage-config.ts`, workflow compiler | `initialization.format_version:1`, `template` plus explicit node `initialize_records`; no old content/trigger input reader. |
| Workflow input | Card-type YAML `workflow`; same owners | `format_version:4`; literal authored durable prompt keys; qualified action IDs, optional declared `output_record` binding, typed fields/cases/inputs and advisory natural-postcommit attachment. |
| Operation selection | Explicit compiled definition; `runtime/card-process/operation-contract.ts`, `shell-operation.ts` | `contract_version:1` for `shell.run` and explicitly declared plugin contracts; retained in action results/execution observations, not package/shared-envelope version. |
| Card execution evidence | Lazy `records/executions.jsonl`; `persistence/card-execution-log.ts`, `runtime/actors/operation-execution.ts` | `version:2`, `type:card-execution`; qualified IDs, declared output source/exact artifact paths, nullable completed-output descriptor and strict entry/spawn/finish/file associations. Incomplete is valid, not resumable state; artifacts select mutable source. |
| Conversation index / previous index and ordinary/compacted genesis | Session `index.json`, `index.prev.json`, selected `versions/<ordinal>-<UUID>.jsonl`; `persistence/canonical-conversation-artifacts.ts`, `conversation-file.ts` | `format_version:12`; exact catalog/source/cutoff/continuation, baseline/draft/current/historical record facts, protected prompts, excerpts and declared structural omission. |
| Conversation segment envelope / selected PNGs | Same versions and `images/<UUID>.png`; above owners plus `contracts/{tool-result,image,view-image,conversation-validation}.ts`, `persistence/conversation-image.ts`, `layout.ts` | `version:12`, `type:conversation-segment`; strict message/private-context/activation and ordered result-content selection. Raw PNGs use this identified owning descriptor contract, not an independent image envelope/catalog version. |
| App log and session provider evidence | `.saivage/logs/app.jsonl`, session `provider-exchange.jsonl`; `contracts/{app-log,provider-exchange-log}.ts`, `persistence/{app-log,provider-exchange-log,growing-file}.ts` | Both use **shared** `version:2`, `type:rows`, with distinct strict row owners. App log includes event/control/external-receipt rows; provider grammar is unchanged by the attribution bump. Not independently numbered envelopes. |
| Dynamic MCP definitions | `.saivage/config/mcp-servers.json`; `mcp/server-definitions.ts` | `format_version:1`, `type:mcp-server-definitions`; strict literal connection map, absent means empty, preserved by reset, never autostart/shadow YAML. |
| Observed definitions | `.saivage/config/observed-collections.json`; `retrieval/collection-definitions.ts` | New `format_version:1`, `type:observed-collections`; strict logical names/purposes/kinds/roots and bounded slash patterns. Absent disables retrieval; reset preserves operator input. |
| Private observed native deployment | `.saivage/config/observed-collections-native.json`; same schema owner, `retrieval/xerj-deployment.ts` producer | New `format_version:1`, `type:xerj-observed-deployment`; loopback endpoint, exact native/model identities and root→prefix association. No concrete destinations/progress. Selects fixed raw `xerj.key` encoding and derived deployment bundle. |
| Lifecycle lock | `.saivage/locks/runtime.lock`; `runtime/lock.ts` | `format_version:1`; exceptional lifecycle exclusion, outside generated-root replacement. |
| Private failed-provider diagnostics | `.saivage/diagnostics/failed-provider-requests/<activation-UUID>/<diagnostic-UUID>.json`; `agents/failed-provider-request-diagnostics.ts` | `format_version:3`, `kind:failed-provider-request-diagnostic`, `privacy_policy:failed-provider-request-privacy-2`; opt-in finite private observation, no retained runtime reader/index. |

### Generalized action output — 2026-10-24

Source parent `5f52e186d386fb39549a88433766a88ec8cea348` has workflow3,
accepted4, card4 and execution1. This source cutover freshly increments workflow
**3→4**, accepted records **4→5**, ordinary/tombstone cards **4→5** and execution
envelopes **1→2**. Deployment applicability is unknown; no unreleased-version reuse
is assumed. Owners, producers, current/history readers, templates and fixtures
change together.

Workflow4 replaces `stdout_record` with `output_record` for declared output-capable
actions. A shared qualified-ID grammar permits two or more components and widens
retained lifecycle executor IDs in card5. Accepted5 replaces shell-only authorship
with `action-output`: operation/contract/provider, actual activation/invocation/node/
ordinal, nullable process/leader facts, outcome and source/byte-size/SHA256 matched
against the literal accepted body. Returned text is not native stdout. Execution2
retains the declared output source and exact artifact selection, completed-output
descriptor and actual process/capture associations. Shell contract1 and its native
outcomes/literal stdout semantics remain unchanged.

No head/mailbox/initializer/conversation/shared-log/MCP/observed/lock/diagnostic
family changes. Optional quality-tool bindings and actual analyzers are not part
of this generic-output cutover. No installed adoption, migration or reset is
performed or implied. Old/mixed input and retained state fail strict consumption;
materialized workflows require deliberate matching adoption. Binary-only rollback
after new writes is unsupported. External migration requires a separate explicit
identified-project request and full offline gates; see
[adoption](../runbook/state-adoption.md#generalized-action-output).

### Quality operation initial contracts

The subsequent quality-action integration registers three new explicit contract1
operations (`code-quality.javascript.eslint`, `code-quality.typescript.eslint`,
`code-quality.python.ruff`) under the existing qualified operation owner. Raw UUID
work files are selected by execution2 descriptors and their exact operation contract;
they are not a new canonical family or a global artifact registry. Generic accepted5
output authorship and workflow4 remain unchanged. Optional per-agent quality-tool
binding inputs have their own initial contract below, not execution-family numbering.

### Quality tool binding input introduction

Source parent `82a582d544b320d6ed4f0b8a4362556b3402c87b` had no per-agent quality
binding family. The owning `qualityToolBindingsSchema` introduces optional
`agents.<name>.quality_tools` with required `format_version: 1` and at least one of
`code_quality_javascript_eslint`, `code_quality_typescript_eslint`,
`code_quality_python_ruff`. Each value uses its corresponding strict action config
schema. Unknown keys/versions fail. Each entry requires its matching selected
`tools` name and vice versa; absence grants nothing. The source and effective input
schemas share this contract. Outbound effective configuration omits the entire
section and retains only ordinary selected tool names.

This is a new embedded input, not a retrofit of the unversioned outer config or a
workflow/execution bump. Old binaries reject adopted inputs; adoption requires a
matching release and explicit operator provisioning. No installed adoption,
migration/probing or deployment is implied. Compiled bindings are frozen and used
only by the selected policy agent's optional tools through the shared finite owner.
Tool results remain ordinary opaque conversation data; no new conversation family
or discriminator is introduced.

### Observed source input introduction

Source parent `8bcd8acedecb449ffd9b186afa23358940953a6f` contained neither family.
This source unit introduces the two version1 inputs with strict direct readers,
prepare producer, fixtures and adoption docs. No deployment is claimed. It is
not a rename/migration of the earlier unimplemented projection proposal.
The private descriptor selects fixed raw key encoding: nonblank opaque text≤4096
UTF-8 bytes including one optional final newline, no embedded whitespace/controls.
Generated engine/unit/argv files are derived deployment inputs owned by this
contract, not canonical progress, admission registries or independent families.
Absent definitions disable retrieval; malformed present inputs fail consumption.
Explicit installation/commissioning remains separate. Native indexes/model files/
journals are external-tool state. No existing conversation/card/record/workflow/
shared-envelope meaning changes in this preparation unit; no existing bump.
Tool integration preserves that boundary. See
[adoption](../runbook/observed-collections.md).

The integrated two query tools use existing opaque tool-result data and ordinary
observational settlement. Source references add no canonical record observations,
image/context/provenance fields, conversation rows or app-log kinds. External
operations retain body-free receipts and existing UUID/cancellation ownership.
Historical unknown-tool rendering remains the existing generic path; introducing
named current presenters is not retained-state normalization. Existing family
discriminators are unchanged; complete settlement/provider/compaction validation
is part of source acceptance, not inferred from equal version numbers.

`project-identity.ts` consumes `projectConfigSchema` without a dedicated format
discriminator. YAML/other operator inputs, raw work/process bytes and required
directories are not assigned invented versions or certified by this table. Files
current/history wrappers are projections, not durable families. Existing unversioned
inputs are not retrofitted. Compare the actual selected source/target release's
schemas **and semantic consumers**, including nested payload/provenance/layout.

The [external-attribution entry](#external-analyst-operation-attribution-2026-10-20)
records the earlier card4/accepted4/shared2 source boundary; conversation12 and
heads1/3 remain unchanged. The [literal-key entry](#literal-authored-protection-keys-workflow-2-to-3-2026-10-21)
records the later workflow2→3 input change. Deployment applicability remains unknown.
The earlier editorial reorganization changed no contract/discriminator and created
no new cutover or adoption obligation; that does not describe the later runtime fix.
Version equality, startup and this table are not whole-project
compatibility proofs or operation permission.

## Find historical source evidence

| Question / family | Entries |
| --- | --- |
| Current card/record creators and actors | [External attribution](#external-analyst-operation-attribution-2026-10-20); [shell stdout](#shell-stdout-record-authorship-2026-10-19); [action executor](#stateless-node-operations-2026-10-19); [minimal card](#minimal-card-bodies-ev01-2026-10-19). |
| Document numbering, templates and prompt observations | [Document0/templates](#record-document-0-and-selected-node-templates-2026-10-18); [scaffolds](#node-entry-record-scaffolds-2026-10-16); [excerpts](#record-prompt-excerpts-2026-10-16); [activation/records](#explicit-activation-and-record-context-2026-10-13); [instruction evidence](#historical-instruction-evidence-2026-10-11). |
| Graph identity without a new family format | [Project assessment](#main-planner-completion-no-family-format-bump-incompatible-reached-node-identity-adoption-2026-10-20); [typed test policy](#typed-test-work-ownership-—-no-durable-impact-2026-10-16). |
| Compaction semantics versus transient construction | [Summary maintenance6→7](#loss-tolerant-summary-maintenance-2026-10-10); [C01 framing](#c01-historical-prefix-framing-—-no-durable-impact-2026-10-15); [C02 condensation](#c02-decision-relevant-condensation-—-no-durable-impact-2026-10-15); [C05 packing](#c05-whole-component-packing-—-no-durable-impact-2026-10-15); [B01 deletion](#b01-prepared-context-attestation-deletion-—-no-durable-impact-2026-10-14); [dead invocation context](#dead-invocation-context-deletion-—-no-durable-impact-2026-10-14). |
| Image selections and transient image boundaries | [Image4→5](#conversation-image-results-—-2026-10-07-conversation-format-4→5); [ordered5→6 / known incompatibilities](#known-incompatible-changes); [operator inspection](#durable-preserving-operator-image-inspection-2026-10-08); [AR03 facts](#ar-03-producer-neutral-image-normalization-facts-—-no-durable-impact-2026-10-15); [AR08 eligibility](#ar-08-shared-image-eligibility-facts-—-no-durable-impact-2026-10-15). |
| Outbound MCP persistence versus live lifecycle | [Definitions](#minimal-dynamic-mcp-definitions-2026-10-10); [restart](#explicit-selected-mcp-restart-—-no-durable-impact-2026-10-18); [lifecycle baseline](#durable-preserving-mcp-cancellation-native-results-and-lifecycle-source-baseline-422b315f); [AR05 counter](#ar-05-redundant-mcp-closure-counter-removal-—-no-durable-impact-2026-10-15); [AR06 result typing](#ar-06-native-mcp-result-typing-—-no-durable-impact-2026-10-15); [F05 telemetry](#durable-preserving-native-mcp-invocation-telemetry-f-05-2026-10-09); [F07 discovery](#durable-preserving-mcp-discovery-settlement-f-07-2026-10-09); [schema language](#durable-preserving-mcp-schema-language-fix); [F10 deletion](#f10-dead-mcp-health-and-aggregate-api-deletion-—-no-durable-impact-2026-10-14). |
| Provider diagnostics and operational observation | [Introduction](#historical-introduction-private-failed-provider-diagnostic-family-2026-10-09); [F01 privacy](#protocol-owned-failed-provider-diagnostic-privacy-f-01-2026-10-09); [overload](#provider-overload-diagnostics-2026-10-12); [HTTP lifecycle](#outbound-http-lifecycle-—-no-durable-impact-2026-10-14); [summary cancellation](#urgent-internal-summary-cancellation-—-no-durable-impact-2026-10-16). |
| Durable-preserving reads and display | [Absolute reads](#ordinary-absolute-agent-reads-—-no-durable-impact-2026-10-16); [native cwd](#native-absolute-command-cwd-—-no-durable-impact-2026-10-14); [unavailable processes](#durable-preserving-unavailable-process-observations-2-2026-10-09); [record UI](#current-record-ui-settlement-ownership-—-no-durable-impact-2026-10-14); [conversation UI](#durable-preserving-conversation-api-ui-change); [Markdown refresh](#durable-preserving-markdown-dependency-refresh-2026-10-08); [card ID admission](#durable-preserving-card-inspection-id-admission); [timeline](#durable-preserving-timeline-local-presentation); [F06 YAML tooling](#f06-workflow-yaml-structural-authority-—-no-durable-impact-2026-10-15). |
| Pre-policy equal-number incompatibilities and unknown boundaries | [Known incompatible changes](#known-incompatible-changes), including heads1→1, shared envelope1→1 and unestablished producer/inline-output source boundaries. |

## Historical source-contract entries

Everything below describes its named source boundary. “Unchanged” compares that
entry's source/target, not that historical value to today's baseline. Original
source parents, reported applicability, evidence limits and adoption consequences
are retained; no historical version is retrospectively repaired.

### Literal authored protection keys: workflow 2 to 3 (2026-10-21)

Exact implementation parent: `315d425839ea94a3b69bcf4548c072a05fbcc2ca`.
Card-type `workflow.format_version` advances **2→3**. Source workflow2 expanded
ordinary YAML strings, including durable prompt keys; target workflow3 preserves
the exact parsed `compaction_key` string at lifecycle, correction, record,
direct/conditional route and pending-notification sites. Schema/compiler strictness
and ordinary interpolation elsewhere remain. Owners are `config/env-interpolation.ts`,
`schemas/saivage-config.ts` and the workflow compiler; classic/classic-typed producers
and PAAD's inherited typed configuration now emit3. Explicit2 is rejected.

The introduction `781a340b69533a3ab046cd8a0e7b43ae1d971923` already paired a
categorical no-interpolation promise with a loader that expanded ordinary string
values. This is a historical requirement/implementation mismatch, not a retrospective
bump or evidence of deployed behavior. Deployment applicability is unknown, so this
is a fresh2→3 change, not an assumed unreleased grouping.

Conversation index/genesis/segment remain **12**: stored strings still denote exact
keys, with unchanged latest-equal-key/anonymous retention and provenance. No reader
reinterprets or rewrites old expanded keys; no authored-spelling provenance is invented.
Other family versions are unchanged. A new literal `${POLICY_KEY}` does not supersede
an old `expanded-name` merely because the source environment once equated them.

Retained explicit workflow2 inputs block the new release, even without substitutions.
Omitting the entire type map still selects current bundled definitions, not old-format
acceptance. Bundled templates declare no environment-generated protection keys;
installed customizations remain unknown. A bare version edit is not a universal
semantic migration: assess source-era effective keys and retained relationships under
[workflow3 adoption](../runbook/state-adoption.md#workflow3-literal-protection-keys).
No continuity/losslessness promise, installed edit, implicit reset or migration follows.
Any needed retained-state transformation requires explicit owner-requested external
offline migration; reset remains separately consented.

### External Analyst operation attribution (2026-10-20)

Exact implementation parent: `575edeb877e58bc0a66fc09c445f37d122d351c4`.
Ordinary/tombstone card artifacts advance **3→4**, including the strict ordinary
creator and update/delete actor contracts. Reserved `external:<principal>` labels
are distinct from configured agent names. Accepted-record artifacts advance
**3→4** with strict `{kind:'external-agent',principal}` authorship. Initial child
bootstrap acceptance carries the actual creator; root bootstrap and explicit repair
remain runtime-authored. Initial bootstrap strict semantic readers admit these
actual authors, never infer them from body text or normalize retained authors.

The **shared provider-evidence/app-log `version/type:rows` envelope advances 1→2**.
Provider row grammar is unchanged; app log additionally admits `surface:mcp`,
external control actors and strict body-free `external_tool_call` settled receipts.
Those receipts are observations, not execution intents, delivery guarantees,
complete history or replay authority. Unknown requested tools use `<unsupported>`;
arguments, bodies, client metadata, exceptions and credentials are absent.

Card-head/previous slot and mailbox remain **1**; record-head/previous slot remain
**3**. Workflow input **2**, initializer **1**, card-execution envelope **1** and
shell operation **1** are unchanged. Conversation index/genesis/segment remain
**12**: typed record observations have no author; ordinary card/record tool data
is opaque and successful process results retain their specialized contract.
Normalized call-local PNG bytes are separate from durable ToolResult content;
only actual LLM settlement publishes the existing descriptor-selected PNGs.
External calls create no internal transcript or provider evidence. MCP definition
**1**, lifecycle-lock **1**, diagnostics **3** and unversioned YAML/identity are
unchanged. Current/history, generated Files, bootstrap and repair consumers use
the same strict owning schemas; no old reader or conversion is provided.

Deployment applicability is unknown; these are fresh bumps, not an unreleased
cutover exception. Old/mixed canonical state blocks. Source completion authorizes
no deployment, configuration adoption, migration, reset, restart or Run. Adoption
requires separately consented complete reset or an explicitly owner-requested
identified-project external offline migration to a pinned matching release under
the full runbook gates. Binary-only downgrade after new publications is unsupported.

### Main Planner completion: no family-format bump; incompatible reached-node identity adoption (2026-10-20)

Exact implementation parent: `c6de78865ef72a19c2f4e75b13365351191cdce1`.
`classic-shared.ts::projectCompletion`, selected by classic and classic-typed
before record-context expansion and by paad-typed's identical typed config,
adds project `assess-completion`, routes candidate direct closure and approved
review there, and removes project `handle-notifications`. Goals retain their
handler. These configured identity/edge choices do not change durable family
grammar or historical interpretation:

- Workflow input **2** already represents named nodes/outcomes, nonterminal edges
  and independent terminal promotion/exports; `card-process-config.ts` compiles
  those declarations without a new grammar or old-graph normalization.
- Ordinary/tombstone card artifacts **3** retain `schemas/lifecycle.ts`'s open
  nonempty string node/outcome and discriminated executor contract. An old DONE
  or report result remains its factual historical result, not a new objective
  assessment. Card-head/mailbox **1** selection and payload meanings do not change.
- Accepted records **3**, record heads **3** and initializer **1** retain author,
  numbering, provenance and selection meanings. `NodeExecution` closes each
  node's required records; `CardProcessActor` independently selects promoted
  result and terminal-source exports. Reviewed completion promotes the real
  Reviewer result while exporting Planner assessment status citing immutable
  review. It neither reauthors review nor rewrites historical exports.
- Conversation index/genesis/envelope **12** retain actual node names, prepared
  instructions, handoffs and record observations, not reconstruction from today's
  graph. `AgentExecutor` supplies ordinary accepted-edge context and existing
  record inputs; no row, typed observation, generic tool-result shape or
  compaction retention meaning changes. Execution evidence **1**, shell operation
  **1** and the provider/app-log shared envelope **1** retain their existing owners
  and contracts: no action, invocation or evidence layout is introduced here.

No discriminator is increased because these family contracts are preserved, not
because equal versions prove installation compatibility. Deployment applicability
is unknown; no unreleased-cutover grouping or equal-number reuse is claimed.
Existing-config init preserves YAML/prompts, while fresh profile initialization
receives the new graph/closure under ordinary fresh-init preconditions.

Removing/replacing a node identity from the selected workflow of a reached active
canonical card is incompatible adoption, including **non-tombstoned DONE/FAILED**,
not merely running actors or a node known to have executed. Thus removing this
project handler requires separately consented complete reset or explicitly
owner-requested external offline migration before use. Stopping and reconciling
YAML/prompts, preserving custom guidance, or passing compilation/startup/readiness
is insufficient. A reached tombstone terminates workflow/session admission;
unused declarations and changes outside the participating-identity predicate are
not made incompatible by this rule. Independent format cutovers still apply.

`persistence/current-generated-graph.ts` admits linked cards and requires current
configured distinct node-agent indexes, not a stored prior graph; same-agent node
removal can leave all those indexes present. There is no
detector, alias, compatibility route, converter or historical verdict rewrite.
Any future external migration must resolve the exact source/target identities,
preserve evidenced historical facts and validate the complete candidate under the
[offline gates](../runbook/state-adoption.md#explicit-external-offline-migration); this entry specifies no
transformation and authorizes no operation. Source revert alone does not revert
materialized inputs or reopen historical DONE. Binary-only rollback is not
certified against this identity change or independent format cutovers.

### Shell stdout record authorship (2026-10-19)

Exact implementation parent: `ed4aa204f4a2f0aec32baa025f5813226f41b91b`.
Accepted-record artifacts advance **2→3**: required discriminated `author` replaces
`writer_agent`. Agent, bootstrap/repair runtime and shell-stdout authors remain
distinct; a new shell invocation may publish equal content as a new factual
accepted version, without reusing an agent verdict. Ordinary content/hash/size,
immutable card provenance, predecessor chain and artifact-before-head publication
remain. Record-head **3** is unchanged; a head selecting an old accepted2 artifact
fails when that artifact is consumed. Current/history/API and repair consumers
use the same strict author contract. There is no old-author normalization.

Workflow input advances **1→2**, including unbound workflows. Optional node-level
`stdout_record: check-report.md` names exactly one declared nonbootstrap own-card
record with a `continue/updated` requirement. Only `shell.run` nodes can select
it; agents, other operations and hooks cannot. Initializer **1** is unchanged.

Ordinary/tombstone card **3**, card-head/mailbox **1**, execution evidence **1**,
`shell.run` operation contract **1** and provider/app-log shared envelope **1**
remain unchanged. Conversation index/genesis/segment **12** and typed record
selection observations are unchanged: ordinary tool data is opaque under
`contracts/tool-result.ts`; author metadata is not a new typed observation or
specialized process result. Retained observations are factual, never rewritten
to the new author shape. `tests/contracts/record-observation-foundation.test.ts`
publishes real current/historical record-read settlements with `content_author`,
strictly reads retained format12 history, materializes it, projects public rows
and an actual OpenAI request, and publishes/consumes a compacted successor with
unchanged typed selection facts. An old opaque `writer_agent` observation remains
unchanged through those consumers. `tests/tools/card-version-provider.test.ts`
independently retains old opaque card observations. The real process producers in
`tests/e2e/process-inline-output.e2e.test.ts` retain their specialized result shape
through strict format12 current/history consumption, actual compaction and
provider/public projection; no record author fields or shell-publication mutation observations
are added to those results. `tests/e2e/execution-evidence.e2e.test.ts` and the
existing production-server browser journey exercise workflow2 capture-to-record3
publication, equal-content versions, independent capture deletion, normal record
history/diffs and privacy-filtered display/download. These are source-contract
proofs, not installed-state or model-comprehension claims.

Deployment applicability is unknown; no unreleased version reuse is claimed.
Old/mixed state stays a stopped blocker. Adoption requires matching configuration
and release plus a separately consented reset or explicitly requested external
offline migration; this source change authorizes neither. Binary-only rollback
after new writes is unsupported.

### Stateless node operations (2026-10-19)

Exact implementation parent: `a768ee4a0bf341738c5ebfa55fa8b85cf219f2ed`.
Ordinary `card-version` and `card-tombstone` artifact `format_version` advance
**2→3** together. Embedded workflow results replace `agent_name` with strict
`executor:{kind:'agent',agent}` or
`executor:{kind:'action',action,contract_version,provider,invocation_id}`.
No generic operation values or hook results become card results. Both ordinary
publication sites, tombstone publication, strict current/history/repair readers
and generated Files artifact projections use3. Card-head and mailbox remain1.
Reached card2 history and previous selections fail strictly.
No startup history scan, compatibility reader, normalization or stored observation rewrite is added.

The new lazy card-owned `records/executions.jsonl` family starts at
`version:1,type:'card-execution'`. Invocation entry, positive process spawn and
known settlement observations are strict nonempty envelope rows. Exact recorded
capture references select runner-owned files; declared artifacts are mutable
current-source references, not historical snapshots. An unmatched entry is valid
incomplete evidence, never permission to replay. Complete malformed rows fail
on consumption; only an identifiable unterminated suffix may be truncated.

The formerly unversioned workflow input establishes `format_version:1`, selecting
agent or exact qualified/versioned stateless operations, typed routes and input
bindings. `shell.run` declares operation contract1. Record-head **3**, accepted
record **2**, conversation index/genesis/segment **12**, initializer **1** and
provider/app-log shared envelope **1** remain unchanged. Actions consume exact
accepted authored records but never author or close them, and create no synthetic
conversation, tool call or provider attempt.

Nested-owner evidence: `schemas/lifecycle.ts` strictly owns the changed card
result; retained generic card-tool data remains `unknown` in conversation12.
The card-version-provider regression exercises an old `agent_name` workflow
result through actual strict segment consumption, materialization, OpenAI
serialization and outbound projection without changing its digest or meaning.
Specialized agent process-result contracts are untouched. Agent handoff appends
quoted selected facts via existing text rows, not a new nested conversation field.

Deployed applicability of parent/target contracts is unknown; no unreleased
version reuse is claimed. These fresh source bumps make no deployment claim. Adoption
requires a separately consented complete reset or explicitly requested external
offline migration to the matching pinned release, with stopped exclusion,
preserved complete backup and strict complete linked/indexed-history validation.
Source completion authorizes no migration, deployment, restart or Run.

### Minimal card bodies EV01 (2026-10-19)

Exact implementation parent: `54e04123885de26d8fa81a1677d2c80ecc18d815`.
At that parent `persistence/canonical-card-artifacts.ts` requires format1 for
`kind:card-version` and `kind:card-tombstone`; `card-files.ts` emits format1
at both ordinary publication sites and the tombstone publication site. This
source freshly advances each of those artifact variants' `format_version`
**1→2**. Their strict embedded `card`/`final_card` loses nine required-null
members: `subtype`, `assigned_to`, `metrics`, `estimate`, `started_at`,
`duration_ms`, `status_text_author_session_id`, `latest_self_report`, `metadata`.
They are absent, not optional, stripped or normalized. Retained status text/time,
lifecycle/result/provenance, relationships, revisions and history meaning remain.

Card-head and mailbox-message `format_version` remain **1**, including previous
head slots: neither embeds the changed card shape or changes selection semantics.
Generated Files historical ordinary/tombstone wrappers emit **2**, synchronized
with their artifact view, not a separate durable family. Current `card-current`
stays versionless. Record-head **3**, accepted-record **2**, conversation
index/genesis/segment **12**, initializer input **1** and provider/app-log shared
`version:1,type:rows` are unchanged by EV01. The independent record0/templates
cutover below remains intact; its bumps are not reused or undone.

Nested-owner evidence: strict retained conversation validation consumes the common
tool-result envelope with `data:unknown`, not today's CardRecord. Composition
specializes process results only; ordinary card-result text reaches the actual
OpenAI serializer unchanged. Public invocation projection preserves opaque card
data and recorded artifact digests while legitimately reserializing JSON and
recomputing only the transient projected row's content hash. Record observations
remain strict conversation12 baseline/draft/accepted selections, not embedded card
bodies; accepted-record card-history provenance remains an exact immutable link.
The focused card-version-provider regression covers strict retained segment reads,
materialization, provider serialization and outbound semantic preservation of an
old all-null card observation, alongside new minimal tool output/digest derivation.
It grants no acceptance of canonical artifact1 or old conversation envelopes.

These are fresh bumps, not an unreleased-cutover exception or installation claim.
Dated JSQLite2 conversation10 workspace evidence and reported absence of prerequisite
adoption do not certify current deployment. Complete old canonical artifacts,
including all-null bodies, fail strict current or reached-history consumption;
previous heads selecting them cannot qualify as current-format repair candidates.
No proactive history scan or stored result/hash rewrite is introduced.

Source work authorizes no deployment, service action, migration, reset or Run.
The owner intends one later separately requested final-release external migration,
under the runbook's stopped exclusion, complete preserved backup, independent
complete candidate and strict linked/indexed-history validation gates; alternatively
a destructive reset requires its own consent. Neither family numbers nor equal
outer envelopes establish whole-release compatibility. Binary-only rollback after
new writes is unsupported; matching complete-state/release restoration requires
separate authorization. Historical equal-number incompatibilities below remain
honest source provenance, not supported old representations.

### Record document 0 and selected node templates (2026-10-18)

Exact implementation parent: `10463cd83369b1eda687525c6522492836f133c0`.
This source changes record-head `format_version` **2→3**, including previous
slots: current-only baseline0, explicit draft document/target versions and removal
of seed fingerprints. Immutable accepted-record artifacts advance **1→2**:
consecutive document numbering is independent of mutation revisions; historical
projection has no known head identity or publication revision. No retained file
is renumbered by the product. Bootstrap/repair accepted1 attribution stays factual.

The single conversation family advances index/genesis `format_version` and
segment-envelope `version` **11→12** together. Baseline and explicit draft
version/target observations replace `unfilled`, including nested tool results,
compacted latest-current facts, public projections and model composition.
Historical tool/VFS selections expose null mutation revision/head, never a version
relabelled as revision. Current observations retain exact head UUID/revision.

Formerly unversioned initialization `{content,at}` is replaced with explicit
owning input `initialization:{format_version:1,template}` and node
`initialize_records`. Macro/include syntax is compiled, not preserved literally;
`${NAME}` remains data. Already established heads suppress rendering entirely.
Explicit clean remains separate and does not rerender retained text.

Provider/app-log shared `version:1,type:rows` is **unchanged**. The three OpenAI
transport adapters emit transport metadata, `llm-provider-attempt.ts` adds endpoint
and method, and publication/retained/public readers use the unchanged strict
transport-specific schemas in `agents/provider-exchange-outbound.ts` via
`provider-exchange-projection.ts` and `persistence/provider-exchange-log.ts`.
Record facts are instead composed from conversation observations through
`publicRecordSelection`; their change belongs to conversation12, not provider
evidence metadata. This is a strict nested-contract trace, not an opacity claim.
Card families and other durable owners have no intended change.

These are fresh bumps, not an unreleased-cutover exception. Source applicability
is the parent above; dated workspace evidence of JSQLite2 conversation10 does not
certify current installations or target deployment. Old/mixed state and old
initialization input block strictly. Source completion authorizes no adoption.
Later adoption requires a separately consented reset or explicitly requested
external offline migration to a pinned final matching release, complete preserved
stopped backup and strict complete linked/indexed-history candidate validation.
Never infer template origin from equal text or invent historical authorship,
acceptance or observations. No converter, dual reader, backfill, implicit reset
or binary-only downgrade is introduced; GitHub #4 creation-time support remains
residual and AR09 remains parked.

### Explicit selected MCP restart — no durable impact (2026-10-18)

Exact implementation parent: `1adefa5e7b8a974ea58d649b89c39e5a39d27030`.
This source change adds `restart` to the existing generic lifecycle input through
`contracts/mcp-invocation.ts`, `tools/mcp-provider.ts`, the installed invocation
port and `mcp/mcp-manager.ts`; `contracts/operator-api-mcp.ts` adds the shared
authenticated operation. The manager composes retained-owner stop and fresh start,
without a persisted restart event, configuration write or historical reinterpretation.
The existing `{serverName,status,toolCount}` lifecycle result is unchanged.
Historical start/stop/call/result arguments, outcome meanings, source identities,
rows and prompt facts remain recorded facts, never normalized or replayed.
Transient binding/catalog UUIDs are not durable-family discriminators.

No durable shape, meaning, selection, provenance or layout changes; no discriminator
bump. MCP definitions remain `format_version:1/type:mcp-server-definitions`;
conversation index/genesis/segment remain **11**, record heads **2**, immutable
accepted records and card families unchanged. Provider/app-log envelopes retain
shared `version:1/type:rows`. No unreleased-cutover reuse or deployment claim is
made. Source applicability is the exact parent above, not an installation inventory
or a whole-release compatibility assertion.

Source coverage added in `tests/mcp/mcp-historical-topology.test.ts` retains
start/stop/restart arguments and unchanged running/stopped results through the
owning strict segment/catalog readers, materialization, provider composition and
public tool-invocation projection (`persistence/conversation-file.ts`,
`runtime/actors/conversation-session.ts` and
`tools/tool-invocation-outbound.ts`). Manager validation in `focused-final.log`
passed all 31 suites / 372 tests, including strict historical materialization,
the actual OpenAI serializer and public projection. This is bounded consuming-owner
evidence, not whole-release compatibility or security certification.

Adoption needs matching updated source/server and newly compiled generated tool
contracts; custom prompts are not automatically rewritten. This entry authorizes
no deployment, service action, reset or migration. Other incompatible changes in
a selected whole release still require their separately authorized adoption;
equal family numbers do not prove compatibility. No binary-only rollback,
converter, dual reader or implicit reset is introduced.

### Node-entry record scaffolds (2026-10-16)

Exact implementation parent: `07ed080bb4cd4be78b1ba223f64a5fb7fbe90082`.
Target is this coherent source changeset, not an invented self-referential commit.
`persistence/canonical-record-artifacts.ts` and `authored-record-files.ts` advance
record-head `format_version` **1→2**, including exact previous slots. Every non-null
draft requires nullable `seed_sha256`, preserving its opening commitment through
edits; equality with current content hash means unfilled. Such effective content
cannot satisfy gates or close as authored work, even with accepted backing. Heads
retain the same paths, selection, head identities and publication protocol.
Immutable `accepted-record` artifacts and embedded accepted snapshots remain
**format 1**: body, attribution, predecessor, provenance and historical acceptance
meanings are unchanged. The previously shared schema identity is separated by owner,
not a dual reader or permission to bump accepted artifacts unnecessarily.

The single conversation family advances index and ordinary/compacted genesis
`format_version` **10→11** and segment-envelope `version` **10→11**, retaining
`type:conversation-segment`. Typed draft selections require `unfilled`, including
nested observations and compacted latest descriptor facts. Public projections and
historical rendering preserve that recorded fact and independent accepted backing;
no current-template reconstruction or automatic-opener authorship is introduced.
Source evidence: those schema/publication owners, `schemas/record-observation.ts`,
`persistence/record-observation.ts`, exact requirement preparation in
`runtime/actors/agent-node-execution.ts`, shared eligibility/close consumers, and
conversation compaction/public/UI projections.

Applicability: workspace memory records `cb2bb15c37729a0e516dcf5ed3da83d111222bf5`
actually deployed to JSQLite2 on **2026-10-16**, with conversation **10**. This dated
evidence is not a new live inspection or installation inventory. The source parent
also consumes 10; this is a fresh bump, not reuse of an unreleased 9→10 cutover.
No target deployment or adoption is claimed. Old/mixed retained heads/conversations
strictly block. Adoption requires separately consented destructive complete reset
or explicitly owner-requested external offline migration of an identified project
to a pinned matching release, with stopped exclusion, successful complete preserved
backup, independent complete candidate and strict linked/indexed history validation.
This work authorizes neither operation. A future migration must preserve old draft
authorship honestly, not infer seed provenance from today's config. Binary-only
rollback after new writes is unsupported; matching complete-state/release rollback
is separately authorized. No converter, probing, normalization, backfill or dual path.

Workflow YAML remains an unversioned input with optional/null literal initialization;
only its exact owning content path skips environment interpolation.
No generated-state compatibility reader is introduced. Cards/history/mailbox, provider/app-log shared
`version:1/type:rows`, lifecycle lock, MCP definitions, diagnostics3/privacy2 and raw
selected PNG bytes remain unchanged; PNGs retain the bumped owning conversation
descriptor contract, without a new wrapper/family. Creation-time scaffolds remain
deferred and GitHub #4 remains OPEN; source completion grants no live operation.

### Typed test work ownership — no durable impact (2026-10-16)

Exact implementation parent: `2028d619b2badeca94039a1736ae03b1fd9d0985`.
Only bundled instruction prose and new-occurrence guidance change: unfinished
review remains with verification, independent findings retain correction ownership,
and the four typed test nodes describe truthful existing BLOCKED returns. Graphs,
record gates, schemas, stored interpretation, selection, linkage, provenance,
layout and prompt delivery are unchanged. Historical accepted outcomes, summaries
and recorded instructions remain opaque factual text, neither reclassified nor
rewritten. No discriminator advances: the shared conversation index/genesis/envelope
family remains **10**, card/record/head/history/mailbox remain **format 1**,
provider/app-log retain shared `version:1/type:rows`, and diagnostics retain
format 3/privacy policy 2. This does not extend the independent record-excerpt
9→10 cutover below or establish a deployed baseline from repository HEAD.

Applicability is newly compiled bundled bytes after this source boundary. Existing
materialized/custom hosts require separately authorized stopped reconciliation of
the actual selected prompts, preserving custom guidance, and a genuinely new
server process; binary installation, existing-config init, Run and refresh do not
adopt them. Prompt-only adoption requires no reset/migration; whole-release
adoption must separately honor every actual incompatible contract, including the
conversation cutover below. No deployment or external migration is authorized.

### Record-prompt excerpts (2026-10-16)

Exact implementation parent: `d27a34d42fe09d54756c686241aa2707535eec5e`.
Conversation index and ordinary/compacted genesis `format_version` advance **9→10**;
conversation-segment envelope `version` advances **9→10** (same owning conversation
contract, not independent family numbering). `record-observation.ts` now admits
strict `exposure:{kind:'excerpt'}` for a non-complete source-body presentation,
including nested rows and compacted latest descriptor facts; absence/empty selection
rejects excerpt. Existing full-body/slice/reference/metadata meanings are unchanged.

`runtime/records/record-prompt-content.ts` preserves small/null substitutions and
prepares raw bodies over 32768 UTF-8 bytes as complete supplier JSON encoding →
existing record-prompt outbound redaction → scalar-safe display head/tail and
disclosure/current-pointer notice → fresh JSON quoting of the entire preview.
The prepass output is opaque text, never parsed back. The retained display allocation
is at most 8192 bytes per end, not a final JSON/notice/host or total-context bound.
If redaction leaves at most 16384 bytes, display appears once without further middle
elision. Every oversized transformation has excerpt exposure. Source provenance
identifies selected source, not display-byte equality; actual rendered prompt text
is persisted, protected and summarized by existing owners. Versionless pointers
select latest effective content through ordinary bounded reads, not historical
omitted bytes. Separate full accepted bootstrap and record storage remain unchanged.

This cutover also includes the shared raw/encoded inline masking correction used
by that durable prepass: conservative candidates and boundary checks remain, with
escape-aware complete double-quoted extension only for actually masked recognized
secret values. Non-secret/unmodified candidates retain original advancement and
incomplete values retain conservative coverage. New prompt bytes therefore differ
durably; separately, current/history/protected public projection and other existing
outbound callers can conceal previously exposed escaped-quote suffixes transiently.
No retained old rows are rewritten or reinterpreted; opaque result/evidence bytes
still mean what was recorded, with no new non-conversation validation requirement.

Applicability: the owner supplied that format 9 is deployed, with incident
`4edc1c7b`; installed commit/date were not inspected. This is a fresh 9→10 bump,
not unreleased version reuse. Source completion grants no deployment/adoption,
migration, reset or rollback permission. Old/mixed state blocks strictly; adoption
requires a separately consented complete reset or explicitly requested external
offline migration under the runbook gates. Binary-only rollback against new writes
is unsupported. No converter, compatibility reader, probing or automatic reset.

Raw selected PNG bytes are unchanged under the bumped owning conversation descriptor.
Card/record/head/mailbox/config and MCP definitions remain unchanged; provider/app-log
retain shared `version:1/type:rows`, diagnostics retain format 3/privacy policy 2,
and unrelated families do not advance. Earlier dated entries below describe their
source boundaries, not current format-10 claims or installation inventories.

### Ordinary absolute agent reads — no durable impact (2026-10-16)

Exact implementation parent: `261447e5c2788039a6f7a468d6ec4361af809cd1`.
Only new read/glob/grep invocation admission and output path spellings change.
`contracts/tool-result.ts` retains opaque data; conversation validation checks call
identity/common result envelopes, and the context composition projector retains
non-process results without resolving filesystem paths. Outbound invocation
projection treats read paths as locations, not Files fetch authority. Historical
successes/failures are neither replayed nor reclassified; record provenance and
typed selected-image consumers are unchanged. No retained shape, interpretation,
selection, linkage, provenance or layout change: conversation index/genesis/envelope
and selected PNG ownership remain format 9, provider/app-log retain shared
`version:1/type:rows`, and every other discriminator is unchanged. No migration,
reset or unreleased-cutover exception applies. Installed applicability is unknown;
this source boundary is not deployment evidence or whole-release certification.
External migration remains separately owner-requested and offline.

### Urgent internal-summary cancellation — no durable impact (2026-10-16)

Exact implementation parent: `c08578fc26bdccab997e70645b8f1982b12c19df`.
The provider attempt/invocation owners preserve transient exact cancellation
identity and real accumulated attempts; the summary owner publishes existing
evidence before emitting that reason to actor settlement. Distinct failures and
publication uncertainty retain precedence. Existing raw failure evidence, tool
results, audits and lifecycle publications keep their shapes and meanings; no
synthetic attempt, completion or prior effect is introduced. No retained shape,
interpretation, selection, provenance or layout changes. Conversation
index/genesis/segments and selected raw PNG contract remain format 9;
provider/app-log evidence retains shared `version:1/type:rows`, not independent
family numbering. Card/record/mailbox, diagnostics and all other discriminators
are unchanged. No retained-state adoption, migration, reset or unreleased-cutover
exception is involved. The incident deployment was `4edc1c7b`; the implementation
parent is source evidence, not proof of installation or whole-release
compatibility. This source-only fix repairs no retained incident history and
authorizes no deployment or runtime action. External migration remains separately
owner-requested and offline.

### C02 decision-relevant condensation — no durable impact (2026-10-15)

Exact implementation parent: `00eb6d6572c87f978e951d17328e32051d55e221`.
Only the shared ordinary/corrective replacement-summary condensation paragraph
changes, prioritizing consequential facts over superseded attempt narration.
This is transient quality guidance; retained prose, schemas, meaning, selection,
provenance and layout remain unchanged. Conversation index/genesis/segments and
selected raw PNG contract remain format 9; provider/app-log envelopes retain
shared `version:1/type:rows`; every other discriminator is unchanged.
No retained-state adoption, migration, reset or unreleased-cutover exception is
involved. Installed applicability is unknown/uninspected; source completion
authorizes no deployment. External migration remains separately owner-requested
and offline.

### C05 whole-component packing — no durable impact (2026-10-15)

Exact implementation parent: `a73cfdec43cd7e470c6ad56199f8592de19ccb32`.
The accumulator replaces per-component growing-prefix probes with geometric
whole-component bracketing and component bisection before text refinement. Only
unpublished call-local probes change; source coverage, serial summary inheritance,
exact winning admission/send authority and persisted contracts are unchanged.
No stored shape, interpretation, selection, provenance or layout changes.
Conversation index/genesis/segments and selected raw PNG contract remain format 9;
provider/app-log envelopes retain shared `version:1/type:rows`; card/record, MCP,
diagnostics and all other family discriminators are unchanged. No retained-state
adoption, migration, reset or unreleased-cutover exception is involved.
Installed-release applicability is unknown/uninspected. This source-only entry
certifies no whole-release compatibility and authorizes no deployment or runtime
action; external migration remains separately owner-requested and offline.

### C01 historical-prefix framing — no durable impact (2026-10-15)

Exact implementation parent: `dd69aa145df85d8ac6c32d4f9a8fa9d5f3a6adc0`.
Primary composition transports the existing genesis source version and exact
covered-through message ID through transient validation/projection contracts;
prospective candidates use the same already-selected cutoff. Existing summary
prose is unchanged on disk and gains request-only prefix framing. Ordinary and
corrective summary instructions scope status and authority to supplied history.
No stored shape, meaning, selection, provenance or layout changes. Conversation
index/genesis/segments remain format 9; provider/app-log evidence retains shared
`version:1/type:rows`; every other family is unchanged. No adoption, migration,
reset or unreleased-cutover exception is involved. Installed applicability is
unknown/uninspected; source completion authorizes no deployment. External
migration remains separately owner-requested and offline.

### AR-03 producer-neutral image normalization facts — no durable impact (2026-10-15)

Exact implementation parent: `4fe4b45916cadcf5e9ee1b20b77ab819e67b1266`.
The shared facts schema/predicate now owns normalization fields independently of
the workspace schema; the decoder's neutral return type and optional browser
enrichment use that owner. Workspace result and indexed MCP capture keys/values,
strict canonical workspace validation, ordered descriptors and selected PNG bytes,
selection, provenance and layout remain unchanged. Browser MCP labels no longer
fabricate a schema path; a foreign `source_path` now declines optional enrichment
only, without rejecting or rewriting retained tool data or hiding image actions.
No durable family or discriminator changes: conversation index/genesis/segments
remain format 9 (also owning raw selected PNGs), MCP definitions remain format 1,
and app-log/provider evidence retain shared `version:1/type:rows`; all other
families are unchanged. No retained-state adoption, migration, reset or unreleased
cutover exception is involved. Installed-release applicability is unknown and
uninspected; this source-only entry certifies no whole-release compatibility and
authorizes no deployment or runtime action. External migration remains separately
owner-requested and offline.

### AR-08 shared image eligibility facts — no durable impact (2026-10-15)

Exact implementation parent: `7d884c3abd00b58798f0ffbff4f6e17c01eaaf89`.
Composition and actual summary serialization reuse the existing capability owner;
ordinary and summary admission share only the identical pure size condition.
Their independent checks, errors/verdicts, exact serialized bytes/hashes and final
summary re-admission remain unchanged. No retained shape, interpretation,
selection, provenance, layout or discriminator changes: conversation remains
format 9, card/record and MCP definitions format 1, app-log/provider evidence
shared `version:1/type:rows`, and private diagnostics format 3/privacy policy 2.
All other durable families are unchanged. This source-only refactor needs no
retained-state adoption, reset, migration or unreleased cutover exception.
Installed-release applicability is unknown and uninspected; this entry certifies
no whole-release compatibility and authorizes no deployment or runtime action.
External migration remains separately owner-requested and offline.

### AR-06 native MCP result typing — no durable impact (2026-10-15)

Exact implementation parent: `97ca57172f5d5a6d66e9fd93614cd520d36abcce`.
The existing live protocol mapper's schema-inferred result now flows through the
runtime, manager, internal invocation port, provider and converter without type
erasure or a second envelope parse. The owning ingress schema, conversion checks,
projected outputs and native invocation telemetry semantics remain unchanged.
No serializer, retained shape, interpretation, selection, provenance or layout
changes; no discriminator changes. Conversation index/genesis/segments remain
format 9, MCP definitions remain format 1, and app-log/provider evidence retain
shared `version:1/type:rows`; all other durable families are unchanged.
No retained-state adoption, reset, migration or unreleased cutover is involved.
Installed-release applicability is unknown and uninspected; this source entry
certifies no whole-release compatibility and authorizes no deployment or runtime
action. External migration remains separately owner-requested and offline.

### AR-05 redundant MCP closure counter removal — no durable impact (2026-10-15)

Exact implementation parent: `48b3ecd7f4f50c18cbaf99e484cffd38d0829523`.
The private `server-runtime.ts` counter changed only when that owner's admission
permanently closed; continuations now check the same owner-local admission state
directly. Manager replacement still creates a fresh runtime and binding after
containment. No serializer, retained shape, interpretation, selection, provenance
or layout changes; no discriminator changes. MCP definitions remain format 1,
conversation index/genesis/segments remain format 9, app-log/provider evidence
retain shared `version:1/type:rows`, and all other durable families are unchanged.
No retained-state adoption, reset, migration or unreleased cutover is involved.
Installed applicability is unknown and uninspected; this entry certifies no
whole-release compatibility and authorizes no deployment or runtime action.
External migration remains separately owner-requested and offline.

### F06 workflow-YAML structural authority — no durable impact (2026-10-15)

Exact implementation parent: `1b710d2a834fd21af2cb340c547f427e05f0cb65`.
The cadence guard consumes repository CI source through one YAML parse and
job-local step enumeration. No Saivage retained shape, interpretation, selection,
provenance, layout or discriminator changes; no adoption, reset, migration or
unreleased cutover is involved. Installed applicability is unknown and uninspected;
this tooling change certifies no whole-release compatibility or deployment action.
External migration remains separately owner-requested and offline.

### F10 dead MCP health and aggregate API deletion — no durable impact (2026-10-14)

Exact implementation parent: `6295ef852d39407c70c5aa66fb5e3fe5af07abfb`.
Deleted manager aggregate catalogs and health API, runtime health, HTTP health
producer and exclusive `mcp-health` purpose are process-local only. Evidence is
their source ownership in `mcp-manager.ts`, `server-runtime.ts` and
`streamable-http-transport.ts`, the explicitly transient `contracts/outbound-http.ts`
contract and the operational Fastify sink. No retained bytes, interpretation,
provenance, selections, layout or serializers change; external journal retention
does not create a Saivage durable family.

No discriminator changes: MCP definitions remain format 1; conversation
index/genesis remain format 9 and segments version 9; app-log/provider evidence
retain shared `version:1/type:rows`; card/record remain format 1; private diagnostics
remain format 3/privacy policy 2. All other durable contracts are unchanged.
This source-only deletion needs no retained-state adoption, reset or migration and
uses no unreleased cutover exception. Installed applicability is unknown and
uninspected; this entry certifies no whole-release compatibility and authorizes no
deployment or runtime action. External migration remains separately owner-requested
and offline.

### B01 prepared-context attestation deletion — no durable impact (2026-10-14)

Exact implementation parent: `b4337558725dfa23e69c4defd9446867d513be17`.
Removed prefix serialization/digest, provider-definition serialization and aggregate
tool/stable/record digests are transient preparation data only. Their exclusive
consumers were deleted aggregate producers and same-reference continuity checks;
record digest had no reader. Runtime composition and positive application mapping
consume actual instructions, ordered blocks and provider definitions. Canonical
activation evidence is independently selected, and tool-local policy bytes/hash,
per-block commitments and admitted request bytes/hash remain unchanged.

No discriminator, retained shape, interpretation or layout changes: conversation
index/genesis remain format 9 and segments version 9; card/record remain format 1;
app-log/provider evidence retain shared envelope version 1; private diagnostics
remain format 3/privacy policy 2. All other durable contracts are unchanged.
This separate source-only deletion needs no adoption, reset or migration and reuses
no cutover. Installed applicability is unknown and uninspected; it authorizes no
deployment, runtime action or whole-release compatibility claim. External migration
remains separately owner-requested and offline.

### Dead invocation context deletion — no durable impact (2026-10-14)

Exact implementation parent: `d689d4cdce9c62ac698b13caabff17893a28237f`.
Removed runtime episode payload and agents-request prepared-context/signal fields
are transient only. Positive adapter mappings, candidate serialization and explicit
execution bindings never consumed them; canonical activation, record, repair and
tool-result evidence remain independently produced. Model bytes and admitted
request/tool commitments are unchanged. No discriminator changes: conversation
index/genesis retain format 9 and segments `version:9/type:conversation-segment`;
app-log/provider evidence retain shared `version:1/type:rows`. Card, record,
private diagnostics and all other durable contracts are unchanged.

This isolated deletion requires no adoption, reset or migration and reuses no
cutover. Installed applicability is unknown and uninspected; no whole-release
compatibility, binary downgrade, deployment or runtime action is authorized.
External migration remains separately owner-requested and offline.

### Outbound HTTP lifecycle — no durable impact (2026-10-14)

Exact implementation parent: `04b66d24153a66e394be90335f02d189bf6c9952`.
Owner-local external fetch and scheduler wait observations use the existing process
operational logger, not Saivage retained application state. Evidence is the closed
outbound HTTP contract, safe source projection, Fastify sink and transport/scheduler
owners. No canonical request IDs, event kinds, payloads, layout or interpretation
change, and no discriminator changes: app-log/provider evidence retain shared
`version:1/type:rows`; conversation index/genesis remain format 9 and segments
version 9; private diagnostics remain format 3/privacy policy 2. Card, record, auth,
MCP, configuration, lock and work contracts are unchanged. External journal retention
does not create a Saivage durable family.

This isolated source-only change needs no state adoption, reset or migration and
reuses no prior cutover. Installed applicability is unknown; no deployment or
retention policy was inspected/certified. Source reversion of instrumentation is
not permission for binary downgrade across unrelated formats. Source completion
authorizes no deployment or runtime action; external migration remains separately
owner-requested and offline.

### Current-record UI settlement ownership — no durable impact (2026-10-14)

Implementation parent: `e0c55a5ff3fef058622a94753738e8475867dc17`.
Current REST completion now preserves independent transient catalog, selection
and diff state. REST contracts, retained bytes and interpretation are unchanged;
record heads/accepted artifacts remain format 1 and conversation index/genesis/
envelopes remain 9. No discriminator changes or F12 migration/reset are needed.
This is outside the earlier 8→9 cutover; source evidence establishes no installed
applicability or compatibility of other release changes.

### Native absolute command cwd — no durable impact (2026-10-14)

Exact implementation parent: `c48a9e57a953cfb8817c3ce332edd75b59e3bc44`.
The process provider now admits native absolute cwd for future command invocations,
with the same execution authority as the equivalent system URL. The strict optional
string input shape, retained tool-call/result interpretation and raw work outputs
are unchanged; historical arguments/results are not replayed or reclassified.
No discriminator changes: conversation index/genesis format 9 and envelope version 9,
work outputs and all card/record families retain their contracts. This is not part
of the earlier 8→9 cutover and requires no migration/reset by itself. The parent is
source evidence, not installation evidence; unrelated release differences still need
their own adoption decisions, and no installation compatibility is certified.

### Explicit activation and record context (2026-10-13)

Exact source parent: `4933242451429396049631c11b3d61ea258808d4`, conversation 8.
This coherent source unit freshly advances conversation index and ordinary/compacted
genesis `format_version:8→9` and segment envelope `version:8→9`, retaining
`type:conversation-segment`; the previous index shares its selector contract.
Installed source applicability is unknown. No undeployed format-8 exception is assumed.

The source contract adds owner-produced current/historical record selection
and metadata/slice/full/reference exposure descriptors on exact successful tool
settlements, descriptor-only preparation rows, and actual workflow-origin
`record_prompt` text. Required compacted facts include a strict explicit
`latestRecordObservations` array, initialized empty only for genuinely new history.
Latest knowledge derives in canonical source order per conversation/card/record/view,
including current reads and known mutation results, then merges retained suffix;
immutable historical reads never advance it. Facts contain no body/template text
and preserve source coordinates/time. Record prompts independently use existing
keyed-latest or anonymous protection. Missing facts and old/mixed 8 data fail;
no returned JSON parsing, inferred observations, backfill or compatibility path exists.

Current bootstrap preparation now supplies the full accepted body afresh at each new
logical operation, separately from stable card/node blocks. Its descriptor-only
preparation occurrence records actual selection/full exposure, not historical body
bytes, and deduplicates only against actual latest conversation knowledge. Same-operation
maintenance and retries retain the captured snapshot. This is part of this same
unpublished coherent 8→9 source unit, not another format family or record acceptance change.

The same unpublished source unit now implements conditional prompt production:
finite own-card declarations, accepted/effective same-read union with bootstrap,
pre-batch actual-conversation comparison, opaque body substitution and one ordered
prompt/descriptor envelope. Primary and summary project descriptor-only knowledge
independently of protected text. This completes those format-9 producer meanings,
not a second bump or a deployed cutover; record family remains unchanged.

The same unpublished source unit now requires named prepared evidence for actual
activation identity, stable card orientation, trusted root/parent/global caller and
exact rendered parent direction (null for root/globals). Parent invocation provenance
comes from the retained exact owner/lease, not caller-supplied authority or transcript
reconstruction. Root caller is valid only for `project`; parent card/session must name
the exact immediate parent. Role/node/orientation/parent text is positively projected and privacy
filtered. Global non-model ingress remains explicitly not applicable; unrecorded
text remains unavailable, never today's template. This nested incompatibility shares
the already-started coherent 8→9 source unit; no unrelated family changes.

Current/history/protected/fact public projections separately select descriptor
identity/exposure/source and redact text and metadata, omitting internal raw hashes,
tool-policy templates and evidence arguments. Actual conditional bytes and recorded
role/node/parent orientation remain inspectable; prepared-bootstrap descriptors link
immutable record evidence, not reconstructed historical request text. Source evidence
is the owning schemas, synchronous supplier, exact result settlement, compaction
derivation and shared public projector/timeline. This is one coherent source 8→9
change, not an installed-release or delivery certification.

Later source-only correction (2026-10-14): public `record_prompt` projection preserves
existing redaction coverage through the supplier's one JSON-string layer, using finite
encoded rules in `redaction/text.ts` selected by `canonical-conversation-outbound.ts`.
Current/history/protected reads filter retained text without rewrite or historical
reconstruction. Canonical rows, nested descriptors/provenance, private model context,
layout and strict consumers are unchanged: conversation index/previous index/genesis
remain format 9, segment envelope remains version 9, and record/head/acceptance remain
format 1; no family discriminator changes. This later presentation correction is not
part of the historical unpublished 8→9 source unit above. Installed applicability
remains unknown; no unreleased-cutover exception, migration, reset or deployment is
needed or authorized by this correction. External migration remains separately
owner-requested and offline under AGENTS/runbook gates.
Record/head/acceptance remain format 1. Card/mailbox, lifecycle lock,
MCP definitions, provider/app-log envelopes and private diagnostic/privacy families
are unchanged. Generic provider request/diagnostic bodies remain opaque.

Source completion grants no deployment, reset, migration or Run. Adoption requires
separately consented complete reset or explicitly requested external offline migration
to a pinned matching release under the runbook/AGENTS gates. Historical read JSON
cannot be converted into invented typed knowledge. Binary-only downgrade over 9 is
unsupported; complete-state/matching-release rollback is separately authorized.

### Provider overload diagnostics (2026-10-12)

Exact implementation parent: `2c9ed2ab7d0f2354f4281d2e65dd25925b0c0108`.
`agents/failed-provider-request-diagnostics.ts` advances private
`kind:failed-provider-request-diagnostic` **`format_version:2→3`** by adding
strict `failure_kind:server_overloaded`. This is a fresh owner-local bump,
not an assumed unreleased shared cutover. The privacy projection and
`privacy_policy:'failed-provider-request-privacy-2'` remain unchanged.
New opt-in activations write only 3 with the existing capture bounds/source
attribution. Retained diagnostics have no runtime reader/index: old files remain
untouched/unconsumed, with no reset, converter, probing, scan or migration needed
for this isolated adoption. Parent deployment is incident-reported provenance,
not independently certified here; no deployment date or installed-state claim is made.

Source evidence: the owning strict diagnostic schema/writer and diagnostic-pipeline
tests; invocation retry state remains in memory only. Conversation index/genesis
`format_version:8` and segment `version:8/type:conversation-segment` stay unchanged.
App-log and provider evidence retain their shared `version:1/type:rows` envelope,
raw safe error/status and source/output attribution, not a persisted transport
failure-kind enum. Card, record, lock, configuration and MCP families are unchanged.
Source completion grants no deployment, Run, reset or migration; rollback must
consider all release contracts/privacy, not infer compatibility from conversation 8.

### Historical instruction evidence (2026-10-11)

Exact implementation parent: `10900176cfe8f28fd0501664b0db201b73ec8eec`.
This coherent cutover freshly advances conversation index and ordinary/compacted
genesis `format_version:7→8` and segment envelope `version:7→8`, retaining
`type:conversation-segment`. `persistence/canonical-conversation-artifacts.ts`
owns these discriminators; previous index slots share the selector contract.
`schemas/activation-instructions.ts` owns the shared strict activation parser.
Every activation payload requires `instructions`: prepared rendered role text
and nullable exact node ID/text, explicit `unavailable/not_recorded`, or global
`not_applicable/non_model_ingress`. Card prepared snapshots require a node; globals
have none. New model-backed producers record prepared values, never absence.
Existing card user text/model-repair rows may positively record only
`instruction_origin:'workflow_prompt'`, including embedded protected prompts.
Unmarked rows are not inferred to be human-authored or retroactively classified.

Snapshots are structural evidence, excluded from provider/summarizer context,
accounting and protected/fact selection. Public projection positively selects and
independently privacy-filters role/node text. Preparation is not delivery evidence;
compaction retains source snapshots only in their indexed source segments.
Source applicability is conversation 7 at the exact parent; installed deployment
applicability is unknown. This is not reuse of the 6→7 cutover or evidence of an
undeployed format-8 release. Old/mixed retained state strictly blocks.
Source completion authorizes no adoption, deployment, reset or migration. Adoption
requires separately consented complete reset or explicitly requested external offline
migration to a pinned matching release under all AGENTS/runbook gates. Unknown
historical instructions stay unavailable; current templates, hashes, private
diagnostics and resemblance cannot invent text or provenance. No product converter,
dual reader or normalization is provided; binary-only downgrade over 8 is unsupported.
Card/record/head/mailbox, descriptor-selected raw PNGs, MCP definitions 1, lifecycle
lock, unversioned configuration, private diagnostic 2/privacy-policy-2 and shared
app-log/provider-exchange envelope 1 remain unchanged. Historical entries below
describe their own source boundaries, not the new current baseline.

### Minimal dynamic MCP definitions (2026-10-10)

Exact source/implementation parent: `e980b1b14ce859808e469d4e2018e75f142ab30d`.
Target is this coherent source changeset. The genuinely new lazy configuration
family `.saivage/config/mcp-servers.json` declares `format_version:1`,
`type:mcp-server-definitions` and a strict `servers` connection map. Its owner,
schema and stateless synchronous reader/writer are `src/mcp/server-definitions.ts`;
connection schemas are factored from `src/schemas/saivage-config.ts`. Absence is
intentional empty state. Definitions are preserved by normal reset and complete
backup, never autostart, and cannot shadow YAML. Older binaries may ignore this
file; binary-only downgrade is not an approved rollback.

At that cutover conversation index/genesis/segment remained **7**. Prior name-only MCP input and new
bound/registration input are arbitrary recorded call JSON and generic result data,
not executable retained contracts. Current strict reader, materializer and outbound
projector tests retain both as historical facts without inventing bindings or replay.
See `tests/mcp/mcp-historical-topology.test.ts` for the no-bump evidence. The prior
conversation-7 summary-maintenance cutover below is preserved, not shared with this
change. Deployment applicability is unknown; no undeployed/shared-cutover exception
is claimed. No migration, reset, deployment or live adoption is performed here.

YAML remains unversioned with unchanged disabled/autostart semantics. Card, record,
head, mailbox and lifecycle-lock contracts are unchanged; app-log/provider-evidence
envelope **1**, diagnostic/privacy policy **2**, compaction and image descriptors
are unchanged. Bindings/status/process associations are transient projections or
generic observation results, not additions to strict retained event/descriptor
payloads. Equal discriminators still do not certify whole-installation compatibility.

### Loss-tolerant summary maintenance (2026-10-10)

Source/implementation parent: `9dce1e8eef3e43d04a7711f3c4225fcfc30ae5c4`.
Target: this coherent source changeset, not a self-referential invented commit hash.
Owning schemas/producers are `canonical-conversation-artifacts.ts` and
`conversation-file.ts`; compactor/validator/actor and strict current/historical,
bootstrap and repair consumers adopt them together. Index and ordinary/compacted
genesis `format_version:6→7`, segment envelope `version:6→7`, unchanged
`type:conversation-segment`. Coverage may now mean strict structural selection with
declared omission of covered compactable narrative and all inherited summary prose,
not successful semantic refine of every compactable component. Nested history still
has exactly summary text, protected prompts and newest required model facts. Ordinary
semantic summaries remain ordinary summaries. Exact protected coordinates, canonical
facts, continuation and unconsumed suffix remain strict. Refusal metadata is call-local,
not persisted. The durable `compaction-summary-blocked` literal/schema is unchanged.

Examined source and safe operator reports identify installed source `9dce1e8e`;
no independent live certification occurred. This is a fresh bump, not reuse of an
evidenced undeployed format-6 cutover. Earlier historical source-6 entries below remain
honest provenance. Card/record/head/mailbox, shared app-log/provider-evidence envelope
1, diagnostic 2/privacy-policy-2, lifecycle lock and unversioned configuration are
unchanged. Raw selected PNGs remain descriptor-governed with unchanged pixels.

Old/mixed indexed state blocks strictly; no probing, compatibility or implicit reset.
Adoption requires separately consented complete reset or explicitly requested external
offline migration to a pinned matching target under the runbook/AGENTS full gates.
Every retained canonical index/genesis/envelope and applicable previous selector must
match that target, preserving factual content/identities/links; historical generated
summaries must not be relabeled as observed omission, nor provider effects fabricated.
Normal compaction leaves prior indexed bytes unchanged; external adoption reencoding
is a distinct authorized operation. Source completion grants no instance action,
including JSQLite2. Startup alone is not complete validation, and binary-only downgrade
after 7 publication is unsupported. Loss beyond accepted active-memory omission needs
explicit concrete disclosure/consent.

### Durable-preserving unavailable process observations (#2, 2026-10-09)

Implementation parent: `5936c08ec67e8748ea741faf1705a3bf885d8378`.
Original reproduction baseline `f8d05e75`; incident registry/runner source
`7a9a6415` remains unchanged through that parent. Current API observations add
required evidence and unavailable status; successful `list_processes_tool` pages
may retain those redacted facts as generic recorded query data. This **is persisted**,
but does not change the existing unconstrained successful `ToolResult.data` domain.
Canonical conversation reader/semantic validator retain pairing, policy and content
hash checks without parsing list items through ProcessView. Current-primary's strict
process set is only run/wait/kill; historical list presentation selects supplied
generic fields. Prior list observations lacking evidence remain valid and unchanged,
not backfilled or reinterpreted. Strict successful command payload/status is unchanged;
unavailable commands use the existing failed error-string/no-data envelope.

Conversation index/genesis/segment **6→6**, shared app-log/provider-evidence envelope
**1→1**, card/record families and previous selectors **1→1**, lifecycle lock **1→1**:
no incompatible shape, meaning, provenance or layout change from this parent. Raw
process output remains ordinary bytes at the same paths, without an evidence wrapper.
Failed-provider diagnostics remain **2 / failed-provider-request-privacy-2**;
preserve F-01's independent 1→2 cutover and historical limits. F-04 compound UI
identity, F-05 native telemetry, F-06 connection lifetime and F-07 classified discovery
settlement remain intact. No shared unreleased cutover is claimed.

Deployment applicability is unknown. #2 alone needs no migration/reset for valid
current state, but unrelated release differences still require assessment. No
deployment, restart, reset or external migration is authorized by this source change.

### Durable-preserving native MCP invocation telemetry (F-05, 2026-10-09)

Source evidence: the regression was introduced by `cadf0f21`, observed at audit
baseline `f8d05e75` and implementation parent
`2c25b70d5c6d8a67ef592ad3a3caaea1ab6d451d`. This F-05 source changeset
corrects the runtime producer: a validated returned native `isError:true` envelope
now supplies `success:false` to the existing counter/event owners; false or absent
`isError` supplies true. `cadf0f21^:src/mcp/tools-call-response.ts` threw
`TOOL_EXECUTION_ERROR` for native true, reaching the existing failure telemetry
branch. Canonical Errors semantics remained failed MCP invocations. This restores
future production of that existing meaning, not a new retained interpretation.
Synthetic actual-runtime and production-composition tests cover returned native
outcomes through counters, strict app-log queries, authenticated Errors and the
browser projector, preserving known completed stdio responses after closure.

The app-log/provider-evidence shared `version:1,type:rows` envelope remains **1**;
`mcp_tool_invocation.success:false` already denotes failure and `error` is already
optional. Conversation index/genesis/segment remain **6**, including descriptor-
selected PNGs; failed-provider diagnostic **2 / privacy-policy-2** is unchanged.
No family, selection, provenance or layout changes, bump or shared unreleased
cutover are claimed. Existing incorrectly recorded success rows remain successes:
no reinterpretation, history reconstruction or append-only rewrite. Later image
projection failures remain distinct from known native invocation outcomes.

Installed release/deployment applicability is **unknown**. This fix alone requires
no migration/reset for valid current state, certifies no complete installation and
authorizes no deployment. Older incompatible state remains a stopped blocker;
external migration still requires an explicit identified-project owner request
and the AGENTS offline boundary. None is requested here.

### Durable-preserving MCP discovery settlement (F-07, 2026-10-09)

Source evidence: examined `f8d05e75`, implementation parent `6cb23dd2`, and
the existing lifecycle baseline `422b315f`; deployment/release applicability is
unknown. `mcp/stdio-transport.ts` and `mcp/streamable-http-transport.ts` classify
known external discovery rejection; `mcp/server-runtime.ts` retains containment
and stop joins, and `tools/mcp-provider.ts` retains its narrow typed conversion.
Future known rejected starts now produce the existing failed executed ToolResult
with evidence `none`. Retained failed results, attribution, unmatched calls and
uncertainty mates keep their existing interpretation and are never rewritten.
Synthetic production-composition coverage strictly consumes the new call/result
pairs, including a distinct corrective new start, through the current reader.

Conversation index/genesis `format_version:6` and segment `version:6` /
`type:conversation-segment` remain unchanged; selected images, card/record
selectors, app-log/provider-evidence shared envelope **1**, and configuration
are unaffected. No new family, bump or shared unreleased cutover is claimed.
This change alone requires no migration/reset; earlier 5→6 adoption remains
independent. Source approval grants no deployment, reset or migration consent,
and equal versions do not certify installed-state compatibility.

### Protocol-owned failed-provider diagnostic privacy (F-01, 2026-10-09)

Existing diagnostic family **`format_version:1 → 2`**, unchanged
`kind:failed-provider-request-diagnostic`; `privacy_policy` changes from
`failed-provider-request-privacy-1` to `failed-provider-request-privacy-2`.
The policy tag does not replace the owning family bump. The source contract was
introduced by `f8d05e75a7918cd74f7c24ec6f4a020fe4a3ce49` (historical introduction
below); this implementation's source parent is `d2092d63`. Installed/released
applicability is **unknown**: this is a fresh bump, not a shared unreleased cutover
or invented deployment date.

Evidence: strict v2 producer in `agents/failed-provider-request-diagnostics.ts`
and adjacent pure `failed-provider-request-projection.ts`; synthetic privacy and
pipeline regressions exercise actual Responses parsing/private-row publication/
same-account replay and actual prepared Codex system strings. Native positions now
use positive visible-field projection, omitting annotations, unknown items/content
and extensions without echoing unknown keys; a fixed aggregate extension marker
and precise subtree counts change retained diagnostic interpretation. Ordinary
application JSON retains type/ID-shaped data subject to structured/text privacy.
Raw submitted serialization/hash, transport and canonical replay remain unchanged.

New activations publish only v2; there is no retained reader/index. V1 files remain
untouched and must not be claimed to satisfy v2 privacy. Reused activation UUIDs
remain disabled. No scan, conversion, automatic disposal, application-state reset
or migration is needed or authorized for this isolated observational family.
Conversation **6**, card/record families, shared app-log/provider-evidence envelope
**1**, lifecycle lock and configuration remain unchanged. External migration/disposal
and deployment require separate operator scope.

### Historical introduction: private failed-provider diagnostic family (2026-10-09)

New family initial **`format_version:1`**, strict
`kind:failed-provider-request-diagnostic`, owned by
`src/agents/failed-provider-request-diagnostics.ts` (schema, privacy projection and
direct publisher). Exact path:
`.saivage/diagnostics/failed-provider-requests/<activation-UUID>/<diagnostic-UUID>.json`.
There is no selector/index or normal retained-document consumption. An exclusively
claimed activation directory and self-ignoring `.gitignore` precede publication;
reuse disables capture without retained reads. Later incompatible diagnostic shape
or interpretation requires this family's bump, not silent normalization.

Source applicability: reviewed baseline
`b818acddaf8194ec6c7a2964f2eaa4251dd9ec48`, freshness-checked introduction parent
`615ae32ce028ca32047cb4d31dad30e613a77144`. These are source boundaries only;
deployment/release applicability is **unknown**, not evidence of an unreleased
shared cutover. Evidence: the owner above, `agents/llm-provider-attempt.ts`,
`agents/invocation-service.ts`, `contracts/provider-request.ts`, actor/application
pinned-offset plumbing, CLI/start-input composition and
`workspace/file-access-security.ts`; synthetic pipeline/privacy/publication and
Files/startup tests cover these source contracts, not installed-state adoption.

The document records actual submitted-string raw hash/UTF-8 size, separately hashed
decoded stored body, exact/redacted/omitted fidelity, reencoding and counted privacy/
size omissions, canonical source versus actual invocation, purpose/input/final
attempt index and observed versus embedded statuses. Sensitive projected text is
not a secret-free export, replay fixture or provider receipt. CLI-only explicit
`start --failed-provider-diagnostics <UUID>` adoption is finite (16 failure slots,
one hour, 8 MiB per publication; metadata-only at most 16 KiB), not persistent YAML
or a canonical evidence field. Files excludes the new private subtree and aliases.

Existing card/head/history/mailbox/record discriminators remain **1**; conversation
index/genesis/envelopes remain **6**; app-log/provider-evidence retain their **shared
envelope 1**; lifecycle lock remains **1**. Ephemeral error code/attempt context is
not persisted there; unversioned configuration inputs are unchanged, not retrofitted.
This feature alone needs no reset/migration of already-valid canonical state.
Diagnostics accumulate separately from reset's four roots with no scan/cleanup.
Older Files lacks the exclusion: rollback must remove the opt-in argument and
separately avoid exposing retained diagnostics through old releases, or remain on
patched source. Deployment, reset and explicit external migration consent remain
separate; no converter or old-format reader is introduced. See the
[runbook](../runbook/diagnosis.md#private-failed-request-captures).

### Durable-preserving Markdown dependency refresh (2026-10-08)

Source applicability: implementation parent
`7a9a6415752eb71bdbbe3c8169892cbb82992f02`, not an installed-release claim.
`web/package.json` and its lock select Marked **18.1.0** (from 18.0.4) and
DOMPurify **3.4.16** (from 3.4.15). The unchanged
`web/src/components/content/MarkdownText.vue` transforms card references, parses
synchronously and sanitizes an HTML string for shared conversation/record/Files
presentation. Upstream rendering changes affect ephemeral HTML, not retained
source, reference/provenance interpretation, selections or layout; no data is rewritten.

Card/head/history/mailbox/record discriminators remain **1**, conversation
index/genesis/envelopes **6**, app-log/provider-evidence shared envelope **1**,
and lifecycle lock **1**. No affected family, bump or unreleased-cutover exception.
This change alone requires no migration/reset; adoption uses a matching built UI
over already-valid current data, with deployment authorization separate. Existing
old/mixed-state blockers and external-migration consent boundaries remain unchanged;
equal discriminators do not certify whole-installation compatibility.

### Durable-preserving operator image inspection (2026-10-08)

Source applicability: format-6 baseline `7a899887ec7b7d5972b2483fb72c219351e29139`,
including the recorded ordered-content cutover; this asserts no installed format.
Authenticated exact conversation-image and ordinary Files raster reads add binary
API success and a shared caller-local Fit/1:1 viewer, not durable shapes or changed
selection meaning. Evidence: `contracts/operator-api-{agents,core,files-debug}.ts`,
`application/read-models/{agent-operator,workspace-file}-read-model.ts` and the common
descriptor byte reader in `persistence/conversation-image.ts`. Conversation
index/genesis/envelope remain **6**, raw PNGs remain governed by that descriptor
contract, and card/record/provider-evidence families are untouched. No bump,
new image family or accumulated incompatible cutover is claimed. Adoption is
matching API/UI source over already-valid current state, not migration/reset
permission; old/mixed state remains unsupported.

The [original observed source tree](https://github.com/salva/saivage-v3/tree/fb0152e99e423f5e5e2db5e28d7e38bb3166b759/src)
preserves original schemas/direct owners, not today's baseline. Later source values
are indexed in [Current source baseline](#current-source-baseline); they do not
retroactively update that historical tree or the unchanged values in this entry.

For the ordered-tool-content change, provider evidence retains its existing
shape and interpretation. Evidence: `agents/provider-exchange-recorder.ts`,
`provider-exchange-projection.ts`, `provider-exchange-outbound.ts` and the
Responses/Codex adapters retain the same request-parameter metadata (endpoint,
method, stream, tool count and existing protocol options), outcome/usage and
output identities. Native request `input`/pixels are not stored in those
parameters. App-log owners likewise retain their existing rows; the changed
provider wire serialization alone does not bump their shared envelope `1`.

### Durable-preserving MCP cancellation, native results and lifecycle (source baseline `422b315f`)

The combined implementation changes live invocation cancellation and transport
deadlines/admission, native CallToolResult validation and ordered text/image
production, and configured server lifecycle/control/discovery. Source evidence:
`mcp/{server-runtime,stdio-transport,streamable-http-transport,mcp-manager,native-result}.ts`
and `tools/{mcp-provider,mcp-native-result}.ts`, the producer-neutral decoder and
authenticated operator routes. Exact caller-reason propagation, provider error
classification, application joins and the single start deadline change live
ownership only; exact-entry configuration reads leave the configuration shape unchanged.

No additional durable impact or discriminator change is introduced. Conversation
index/genesis/envelope remain **6**, owned by `canonical-conversation-artifacts.ts`
and `conversation-file.ts`; descriptor fields, raw PNG selection/provenance, exact
session layout and generic tool rows retain their existing contracts. Native
envelope/structured metadata and indexed capture/discovery facts are ordinary
unconstrained tool data, not strict producer-specific retained contracts. Historical
MCP data is not reinterpreted or normalized. The 48 MiB wire, 32 MiB aggregate decoded
source and 1 MiB projected non-image bounds concern current input/production only.
Lifecycle tools and the pinned browser recipe use the same generic rows; no install
registry, durable topology or enable-state is introduced. App-log/provider-evidence
row shapes, interpretation and shared envelope **1** are unchanged, as are unrelated
durable families. Official integration E2E is separate validation evidence.

Source-release deployment applicability remains unknown; this is not a shared
unreleased cutover or a format-reuse claim. The existing 5→6 adoption decision
remains separate: adopting earlier-format retained state requires separately
consented reset or explicitly requested external offline migration to a matching
release. No deployment, reset or migration is authorized by this source work.

### Durable-preserving conversation API/UI change

The shared UI timeline now matches tool exchanges using the existing canonical
session/source-input/call identity rather than provider call ID alone. This is an
ephemeral association correction only: no payload, selection, layout interpretation
or discriminator changes; conversation index/genesis/envelope remain **6**. Adoption
is matching-source UI delivery, with no retained-state transformation or cutover.

Source evidence: `agents.currentInstructions` in `src/contracts/operator-api-agents.ts`,
`src/application/read-models/agent-operator-read-model.ts` and its operator handler;
`web/src/utils/agent-timeline/timeline.ts` and the shared conversation/disclosure renderers.
The new read composes loaded static configuration without publishing snapshots. Combined
call-position tool exchanges and diagnostic disclosures change visual presentation only;
canonical rows, nested payloads, identities, selection/provenance and layout are untouched.
No durable family or discriminator changes. The `c527da662ef3d2c6db616983643bfbe7aeab1055` /
`9d4f16e5c51feed64de8efccdd35bd1a8388ac95` image baseline remains strict conversation
index/genesis/envelope **5**, with selected PNGs governed by that same descriptor contract.
Unrelated families are unaffected. This note proves no installed-state compatibility and
grants no adoption/deployment/migration/reset action; prior format-5 warnings remain in force.

The compact-summary refinement against source baseline
`95bf404720d6d2b76a81b8710cc8576eff38ac4e` is likewise durable-preserving. Source evidence:
`web/src/utils/tool-presenters/{helpers,present,presenters}.ts` selects meaningful abbreviated
targets and separates essential outcomes from short optional reasons;
`web/src/utils/tool-friendly.ts` bounds combined display excerpts, and
`web/src/components/conversation/ToolChip.vue` keeps targets on one line with narrow-pane
stacking. Full semantic sections, safe-original strings/copy and exact link destinations
remain separate from those display labels. This changes no canonical JSON, nested payload,
selection/provenance, persistence layout or discriminator, including the unchanged format-5
image contract above; it establishes no deployment or retained-state compatibility claim.

### Durable-preserving MCP schema-language fix

Against `fb0152e99e423f5e5e2db5e28d7e38bb3166b759`,
`src/mcp/mcp-argument-validator.ts` dispatches current external discovery schemas
by declared/default language, and `src/mcp/protocol.ts` retains complete schema
typing. These change current external argument interpretation, not retained state.
Conversation index/genesis/envelope remain **6**, owned by
`canonical-conversation-artifacts.ts` and `conversation-file.ts`; typed result,
descriptor, PNG selection/provenance and unconstrained producer data are unchanged.
No other family/discriminator changes. The baseline link and current enclosing
version wording are accuracy corrections, not retrospective bumps.
This unit adds no native MCP producer or lifecycle surface and certifies no browser
containment or installed-state compatibility. Existing format-6 adoption warnings
remain; no deployment, reset or migration is authorized.

### Durable-preserving card-inspection ID admission

Against source baseline `cadf0f2144e9ae8fe56a2b3027e16e59d449e44e`,
`src/contracts/builtin-tool-inputs.ts` adopts the existing `cardIdSchema` for
`get_card.id`, `get_tree.rootId` and optional `list_cards.parent`. Real inspection
binders and `llmToolDefinition` derive future runtime/provider argument admission
from these inputs. Generic persisted call arguments and failed results keep their
original identities and pairing semantics; historical arguments are not revalidated
against current tool-input schemas. `conversation-file.ts` and the canonical
conversation/result consumers remain unchanged: index/genesis **format 6** and
segment envelope **version 6**. Card/record heads/history/mailbox **format 1**,
app-log/provider evidence shared envelope **version 1** and lifecycle lock
**format 1** are unchanged. No nested retained payload, provenance, selection,
layout or discriminator changes.

This note applies to this source change; installation applicability beyond the
reported incident pin `4df03ba88114bff605d3fab46c3c5074fe92f1c5` is unknown.
There is no shared unreleased cutover or version-reuse claim. This change itself
needs no migration/reset, but unrelated release differences still require full
source-contract comparison; it neither certifies adoption of current HEAD by
that older installation nor authorizes deployment or any instance action.

### Durable-preserving timeline-local presentation

Against exact implementation parent `8cb426230de451de3091c7a068a61f7eb14e5237`,
`web/src/components/conversation/ConversationTimeline.vue` derives tool display and
image occurrences together for ordinary displayed rows. This changes ephemeral
frontend evaluation only, not retained shape, interpretation, selection, provenance,
layout, readers or producers. No family/discriminator changes: conversation
index/genesis/segments remain **9**, and raw images remain selected by their existing
owning descriptor contract. All other durable families are unchanged.

Installed releases are unknown and uninspected. There is no unreleased-cutover
exception, retained-state adoption, reset or migration requirement for this change,
nor certification of whole-release compatibility or authorization for deployment.
Any external migration remains separately owner-requested under the offline policy.

### Known incompatible changes

These source boundaries are directly evidenced, not an exhaustive timeline.
Historical unchanged discriminators are **pre-policy incompatibilities**, not
permission for future reuse or retrospective renumbering. The adoption consequence
for each incompatible boundary is a matching release plus separately consented
complete reset (losing generated history) or explicitly owner-requested external
offline migration under the runbook gates, never automatic conversion/deployment.

| Affected family / discriminator change | Source boundary and evidence | Change and adoption consequence |
| --- | --- | --- |
| Conversation index/genesis/envelope `5→6` | Ordered tool-content implementation against `d3cb2f4a2112ce08fe4f61f09d9904726d005cae`; `canonical-conversation-artifacts.ts`, `conversation-file.ts`, `contracts/{tool-result,conversation-validation,provider-conversation}.ts` and image/context/provider consumers | Replaces singular successful `image` with strict ordered nonempty optional `content` text/image blocks. All selected image occurrences retain exact source-session attribution and order, including retained rows and private-context conversation consumption. PNG bodies remain raw under the owning conversation descriptor contract. Format-5 deployment applicability is unknown, so this is a fresh bump, not reuse of the earlier cutover. Old/mixed state fails; adoption needs a separately consented complete reset or explicitly requested external offline migration to a matching release. Neither is authorized by source implementation; binary-only rollback over format 6 is unsupported. |
| Card/record representation replacement: card stream artifact `format_version:4` → owner heads/history/mailbox initial `1`; record stream `1` → replacement representation `1` | [`7405fa217df739bea481e93a99e1194a3df7ce1e`](https://github.com/salva/saivage-v3/commit/7405fa217df739bea481e93a99e1194a3df7ce1e), parent `8874026fbc765fe56828c87bee9a809943a7fef3`; diffs in `canonical-card-artifacts.ts`, `canonical-record-artifacts.ts`, `layout.ts` and direct file owners | Replaced `card.jsonl` and `authored-record-version` streams with `card-head` / predecessor-linked `card-version` / `card-tombstone` / `card-message` and `record-head` / `accepted-record` documents. Sparse ordinary/accepted history, current-only queues/drafts and ordinary card provenance replace full mutation streams. Old/mixed layouts fail; this historical representation replacement is **not** a prospective precedent for resetting an existing counter. |
| Card/record heads `format_version:1→1` — historical unchanged discriminator | [`71ad32847325a29c348799235fb95d81b22b652e`](https://github.com/salva/saivage-v3/commit/71ad32847325a29c348799235fb95d81b22b652e); head schemas and `publish-head.ts` | Required fresh `head_id` and exact previous-selector hardlinks; missing identities fail. Previous slots do not guarantee a usable recovery selection. No invented 1→2; [head adoption](../runbook/state-adoption.md#current-selections-previous-slots-and-orphans) remains separately authorized. |
| Conversation index/genesis/envelope `3→4` | [`2f70b3db51529905ea96e2828957f27b1c1efabc`](https://github.com/salva/saivage-v3/commit/2f70b3db51529905ea96e2828957f27b1c1efabc); `canonical-conversation-artifacts.ts`, `conversation-validation.ts` and compaction owners | Removed compaction checksums, retained-row metadata and accumulated accounting while keeping source/cutoff/continuation semantics strict. Older schemas are rejected; unrelated families did not advance. Later 4→5 applies below. |
| App log / provider evidence shared envelope `version:1→1` — historical unchanged discriminator | [`251c93badf43f747dd93c2f99e6f2382fa0716e7`](https://github.com/salva/saivage-v3/commit/251c93badf43f747dd93c2f99e6f2382fa0716e7), parent `93ed39fff82a196ff1252d46547128e125202503`; `contracts/app-log.ts`, `provider-exchange-log.ts`, persistence owner/layout and unchanged `growing-file.ts` | Provider rows moved from app log to session-owned evidence, including owner-specific internal-summary identities. New app log rejects old provider rows; split ownership is not a same-format upgrade. Complete adoption covers all four generated roots, not selective logs. |
| Provider-usage payload, shared envelope `version:1→1` — historical unchanged discriminator | [`a45a1a6323b17bbc98ae1adb90395b66ea931351`](https://github.com/salva/saivage-v3/commit/a45a1a6323b17bbc98ae1adb90395b66ea931351); `contracts/llm-usage.ts`, `provider-exchange.ts` | Added optional cached-input/reasoning-output counters to strict usage. Old readers reject populated new keys; absence does not prove every old file incompatible, certify compatibility or authorize backfill. Preserve omission as unknown; no invented usage. See [payload adoption](../runbook/state-adoption.md#storage-and-interruption). |
| Responses private producer identity and inline process-result payload — earlier source/discriminator boundaries unestablished here | [Runbook storage/adoption warnings](../runbook/state-adoption.md#storage-and-interruption); source owners `contracts/responses-conversation.ts`, `conversation-validation.ts`, `operator-api-processes.ts` and `tools/process-tool-result.ts` | Independent cumulative incompatibilities: required private `producer_account_id` and strict bounded inline stdout/stderr heads/completeness/counts/fallback URLs. The enclosing conversation version recorded at this entry's source boundary is 6, **not evidence of the earlier enclosing versions or a historical 4→4/5→5 change**. External migration must evidence producer/stream facts, not fabricate them. |

Earlier workflow/configuration/card-order milestones remain bounded source-history
provenance, not a fabricated release timeline. Current adoption decisions belong
to the [state-adoption runbook](../runbook/state-adoption.md). The text-only transient recovery
reason rename introduced no supported format and is not another cutover. Multiple
changes in one complete operational adoption do not grant permission to reuse a
deployed discriminator.

### Conversation image results — 2026-10-07, conversation format 4→5

Introducing source commit:
`c527da662ef3d2c6db616983643bfbe7aeab1055` (`feat(agents): support immutable image inspection`).
The producer-neutral result follow-up
`9d4f16e5c51feed64de8efccdd35bd1a8388ac95`
(`refactor(agents): decouple typed image results from workspace metadata`)
belongs to this **same undeployed cutover**,
not a format-6 change. No installed instance was deployed or migrated by this
source issue; source completion/push is not deployment, reset or migration permission.

Exact discriminators advance together from **4 to 5**:

- Conversation index `format_version`.
- Ordinary and compacted conversation genesis `format_version`.
- Conversation-segment envelope `version`.

These discriminators are defined together in
`src/persistence/canonical-conversation-artifacts.ts`
(`conversationVersionIndexSchema`, shared `genesisBase`, and
`conversationSegmentEnvelopeSchema`), not inferred from PNG files or release names.

Unrelated card, record and provider-evidence versions do not change. Selected image
bodies are ordinary PNG files, not a separate versioned catalog.

The durable successful result may explicitly select one strict image descriptor
`{id,mime_type:'image/png',width,height,byte_length,sha256}` only with an executed
settlement and matching canonical call/result, policy, evidence and hash commitments.
Pixels live in the exact owning session's `images/<UUID>.png`, outside JSONL.
Consumption validates selected bytes/hash/dimensions; metadata inspection does not
inventory binary bodies. Unselected artifacts remain ignored forever.

`view_image` is the only implemented authorized producer. Its workspace metadata
is strict at production and canonical consumption, including sent-dimension
consistency. The lower typed result/constructor is producer-neutral: a future
explicitly implemented producer could supply its own data without pretending to be
`view_image`. This installs no MCP image ingress; arbitrary nested `data.image`,
`image_url` or base64 objects remain ordinary data, never attachments.

#### Adoption and limits

Earlier-format and mixed state is rejected by strict current consumers. Equal
outer versions alone do not prove release compatibility. Adoption requires a
matching release and separately authorized operational actions:

- A separately consented whole-generated-state reset loses generated history.
- An explicitly owner-requested external offline migration follows the runbook's
  stopped/excluded, successful fresh complete preserved backup, independent
  complete candidate and strict full-validation gates, outside Saivage core.
  Never fabricate prior images/provenance or ship format converters.

This reference has bounded baseline and known-change coverage, not an exhaustive historical catalog.
Absent entries do not establish compatibility. The entry records durable format
meaning and source status; it certifies no installed state, migration fidelity,
provider perception, or lossless recovery.
