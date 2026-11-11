# Prompt handling

Selected `read_agent_session` tool help owns diagnostic-first navigation, exact
visible-entry inspection, coverage limitations and lossless hex-slice decoding
for Analyst and Oversight. Existing role-level compacted-context guidance remains
applicable. This is not a recovery skill or an automatic update of materialized
role files; the selected bound tool definition delivers the guidance with each
prepared request. Offline compositions establish delivery structure, not model
understanding or live incident resolution.

Selected quality-tool descriptions own the concise direction to analyze the bound
scope, inspect coverage/full work evidence and use ordinary assessment. They are
absent from default agent selections and do not prescribe automatic fixes, record
acceptance or duplicate action/tool runs. The strict generated empty request schema
owns invocation arguments; provisioning stays operator input, not prompt data.
Actual card/global/external compositions and action-assessment handoffs require
the normal final composition/clean-room validation, not raw-description inspection.

Observed collection guidance is owned by the two tool descriptions in
`tools/retrieval-provider.ts`, delivered through the normal selected-tool provider
composition. It directs useful discovery followed by original inspection, makes
uneven neural/stale/empty results explicit, and treats retrieved skills as quoted
evidence rather than activated instructions. It adds no mandatory search ritual,
Planner detour or role/transition override. Existing convergence-first and operator
override fragments remain unchanged across all shipped profiles, including newloop.

Saivage selects prompt artifacts while compiling configuration, then prepares the
selected role and current-node context for actual work. It does not select a role
from transcript prose, reread edited hosts on each turn, or automatically load a
linked document. This page explains that dataflow; the [system specification](../spec/system-specification.md#conversations-and-instruction-evidence)
owns requirements and the [state-adoption runbook](../runbook/state-adoption.md)
owns installed changes. Development-agent instructions such as `AGENTS.md` and
OpenCode skills are a different loading system, not Saivage runtime prompts.

## From selected files to an invocation

```text
selected YAML declarations + exact prompt/fragment files
  → structural compiler → frozen role tokens / rendered process text
  → runtime tool/model binding
  → selected node/global caller prepares role + applicable substitutions + stable blocks
  → each logical card operation supplies fresh record blocks and conditional rows
  → validated history + retained instructions/facts + prepared blocks
  → provider-specific serialized and admitted request
```

`compileProjectWorkflows` owns file selection and compilation;
`createPromptTemplateRegistry` renders already compiled role tokens.
`AgentExecutor` prepares a card node, `AnalystSession` prepares an internal
submission, and `OversightSession` prepares a check. The context projector orders
their inputs; provider adapters serialize that result rather than choosing context.
Actions and advisory postcommit hooks have no prompt, model attempt or synthetic
conversation. `NodeExecution` owns acceptance independently of prompt execution.

### Context owners and lifetimes

Shared `queue_notification` help separately names Analyst ordinary admission and
Oversight active-check/planning-target admission. Selected grants and effect owners
remain authoritative; enqueue is not delivery.

Tool definitions render concise selected clauses beside their descriptions, from
the same compiled capabilities used at the effect owners: for example records
self/status.md and children/brief.md are separate alternatives, not a cross-product.
The harness binds the card anchor; globals have none. Role text describes bundled
parent-owned assignments without forbidding deliberate custom self-bootstrap grants.
The child proposes a requirement change and uses its supported BLOCKED handoff;
the parent accepts/rejects against upstream obligations and may amend the same
inactive child. Root decisions reach Analyst/operator. Fresh activation reads the
current accepted requirements, not a historical review or frozen own brief.

Automatic bootstrap, declared record prompts and descendant context are workflow
inputs, not hidden calls to scoped read tools. Global evidence may mention other
cards. Direct-object grants therefore provide neither information-flow isolation
nor shell containment. Role/node/fragment, generated result/tool contracts, record
feeds, continuation/reentry and summary context must be reviewed together; rendered
offline evidence establishes composition, not model understanding or compliance.

| Context | Selection / lifetime | Meaning |
| --- | --- | --- |
| Role, node outcome contract where applicable, ordered tools | Compiled/bound agent; prepared for the selected node or global operation | Reusable method and permitted surface; not init-only memory. |
| Card orientation and full current-node text | Actual compiled node; stable through its continuations | `{cardId,cardType,title}` and today's task, not a frozen brief. |
| Parent direction | Exact Supervisor parent relationship; entire child activation | Advisory bytes with trusted invocation provenance; never transitive to grandchildren. |
| Accepted bootstrap and record inputs | Synchronous supplier at each newly armed logical primary operation | Same-read requirements snapshot, retained unchanged through that operation's maintenance/retries. |
| Conditional record prompt | Supplier compares actual prior conversation selection knowledge | Actual rendered occurrence, with declaration-owned retention; not guaranteed refresh. |
| Entry, edge, correction, notification and recovery context | Actual producer occurrence at its existing conversation position | Attributed context or task delta; not current-node selection authority. |
| Selected typed inputs / action handoff | Actual accepted edge or entry into an agent | Quoted redacted data, summary, invocation detail and immutable accepted-record links; not instructions or tool authority. |
| Latest record observations | Internal source-order fold of actual observations and retained suffix | Preparation, strict successor validation and audit bookkeeping, not an automatic primary/summarizer ledger or body recall, acceptance or later write authority. |
| Global ingress | Analyst/Oversight owner | No automatic card/bootstrap/parent feed; confirmed restart is model-free. |

`activate_card` requires preserved non-whitespace `instructions`. Supervisor
captures exact parent card/session/source-input/tool-call/name through the owned
lease. A same-lease join cannot overwrite them. Root Run has no parent direction;
a grandchild receives only its own parent's direction. Both primary and summary
preparation receive the retained activation-local parent block, subordinate to
accepted requirements, workflow and permissions. Public notification tools belong
to configured global Analyst/Oversight, not a second Planner direction channel.

## Exact prompt references and lookup

The override root is `.saivage/config/prompts`. Bundled source trees belong to
`src/config/system-templates/<name>/prompts/`; packaged copies live under the same
per-template path in `dist/src/`. Each root has this shape:

```text
agents/{_shared|<card-type>}/<reference>.md
process/{_shared|<card-type>}/<reference>.md
fragments/{_shared|<card-type>}/<fragment-id>.md
```

For every card-scoped host or direct include, lookup is exactly:

1. project card-specific;
2. project shared;
3. bundled card-specific;
4. bundled shared.

Global Analyst and Oversight hosts use only project shared, then bundled shared.
The discriminated host, not a card name comparison, selects the policy: a card type
named `global` remains ordinary card scope. Only exact `ENOENT` advances. Empty,
whitespace-only, invalid UTF-8, directory, unreadable or malformed selected files
fail compilation. There is no directory enumeration or invalid-override fallback.

`agents.<name>.prompt` is `{reference,compactable?}`. The reference names a file;
the agent name names a configured participant/session. Two agents selecting one
reference share applicable overrides. Independent content needs independent
references. An independently named agent selecting `planner` receives that host's
includes; a custom `project-planner` reference receives only includes it contains.

Within workflow input format 6, agent-node `execution` contains `agent`, static `prompt`
and durable `correction_prompt`. Action execution has neither. Process references
remain on declarations; the compiled workflow's `processPrompts` map owns bodies.
There is no runtime workflow-family lookup or prompt manifest.

## Compiler and host contract

The provisioned `classic-git` bundle has its own standalone selected tree, derived
from classic. Every card role includes `native-source`, and each global role
includes `native-global`; ON compilation refuses replacement hosts omitting their
capability include. Includes still resolve through the ordinary override rules;
their presence is not semantic certification of custom prose. The real Executor
is selected for compiler-owned `git-rebase-correction` on all types, with optional
`git-correction.md` diagnostics and ordinary rejected-result feedback. Its prepared
task distinguishes original full history, current private work and partial source
snapshots. `source_ready` requests verification/continuation, never product DONE.
Role/task context is prepared for new sessions, reentry and urgent continuation,
not remembered only from initialization. Native blocks use ordinary prepared-context
ordering, and compaction does not convert internal observations or diagnostic text
into source authority.

::: v-pre

`src/utils/prompt-api.ts` is the single tokenizer/compiler. It accepts literals,
`{{value}}` placeholders and direct `{{>fragment-id}}` includes. It expands each
include independently using the host scope, rejects nested includes, validates the
complete token stream once and freezes it. Repeated direct includes are allowed;
arguments, arbitrary paths, recursion, conditions and inheritance are not.

| Host | Allowed values / required counts after expansion |
| --- | --- |
| Global agent | `vocabularySnippet` |
| Workflow agent | Exactly one `contractDescription` |
| Process | `cardType` |
| Record context | `cardType`; exactly one `recordSelection`; zero or one `recordContent` |
| Record initializer | `cardType`, `cardId`, `cardTitle`, `nodeId`, `recordName` |

Unknown/inapplicable values fail. Role/process hosts do not accept `toolList`,
`projectContext`, `cardId`, `cardTitle` or `cardBrief`: those facts arrive through
typed context/tools, not textual template shortcuts. Initializer card values render
stored data only. Inserted values are opaque and never retokenized.

For example, a workflow role contains `{{contractDescription}}` exactly once,
directly or through a fragment. A shared role can include:

```text
{{>project-guidance-common}}

{{>project-guidance-planner}}
```

The same shared host on a `project` card can select
`fragments/project/project-guidance-common.md` ahead of its shared counterpart.
That specialized fragment replaces, not appends to, the shared file. Globals
cannot select card-specific fragments. Putting a document link or a file in
`_shared` makes neither automatic model context.

:::

Structural validation does not certify natural-language coherence. Generated node
result and actual tool schemas remain authoritative; custom prose must be reviewed
for stale task, authority or result advice. `emit_result` remains exactly outcome
and nonempty summary, at most 2000 characters; there is no prose-defined alternative.

### Declaration-owned retention

Static role/node declarations accept `compactable` (default true) but no key.
That flag does not change their prepared delivery or manufacture durable context.
Durable entry, edge, pending-notification, correction and record-prompt declarations
own these policies:

| Declaration | Successful compaction treatment |
| --- | --- |
| omitted/true `compactable` | Ordinary summary material; `compaction_key` forbidden. |
| false, no key | Retain every actual occurrence. |
| false, exact nonempty key | Retain the newest occurrence; older occurrence becomes summary material. |

Keys preserve the exact parsed YAML string: `${POLICY_KEY}` and embedded
substitutions remain literal with present or absent environment variables. Case,
Unicode and whitespace are unchanged; empty keys fail, whitespace-only keys remain
nonempty. This applies to entries, correction and record prompts, direct routes,
conditional cases/defaults and their pending alternatives. See the
[loading exception](../reference/configuration.md#owners-and-selected-input).

The compiler freezes keys separately from prompt bodies. Host/fragment selection
and placeholder rendering do not transform them; execution and record delivery
copy them into durable context policy. History and compaction compare the actual
stored strings, never consult environment or reconstruct authored source spelling.
An old expanded key and a new literal key remain independent; only a later equal
key supersedes its predecessor, while anonymous occurrences stay independent.
See [workflow3 adoption](../runbook/state-adoption.md#workflow3-literal-protection-keys)
before changing retained inputs. Two sites may share a file but choose different
policies. Shared fragments are policy-free. Protection, observation facts and
structural prepared evidence are independent; no feeding/retention rule changes.

Declaration excerpt (other required agents, routes, records, entries and edges
omitted; not a complete configuration):

```yaml
agents:
  executor:
    prompt: { reference: executor, compactable: false }
card_types:
  code:
    workflow:
      format_version: 6
      entries:
        STOPPED:
          node: red
          prompt: { reference: stopped-recovery }
      nodes:
        red:
          execution:
            kind: agent
            agent: executor
            prompt: { reference: code-red, compactable: false }
            correction_prompt:
              reference: correct-execution-result
              compactable: false
              compaction_key: execution.correction
```

## Runtime preparation and record observations

`AgentExecutor` reads the selected full node text before record/session effects.
Preparation separates stable blocks from per-operation record blocks, composing
stable first without another retained combined array. The role/generated contract,
ordered tools, card orientation, node and parent blocks remain stable over that
node's continuations. Each newly armed initial, tool or corrective operation first
checks its captured invocation lease in the deferred raw callback, then reads
current conversation knowledge and invokes the synchronous node-bound supplier.

### Same-read record supplier

`bootstrap-context.ts` reads each distinct record in the union of bootstrap and
declared `record_prompts` once. The full current accepted bootstrap is mandatory
and supplied on **every** operation outside historical compaction. Required
absence fails before maintenance/admission/provider work. A descriptor-only
preparation row is added only when latest actual knowledge lacks that exact
selection/full exposure; deduplication never suppresses the actual bootstrap block.

Each ordered record input selects own-card `accepted` or `effective`, required or
optional, and a durable prompt declaration. Duplicate record/view pairs or foreign
records fail compilation. `recordSelection` describes current, prior-or-null and
`initial|changed`; optional absent content is JSON null. Comparison uses pre-batch
knowledge keyed by card/record/view, not node or prompt site. Unknown/changed
semantic selection fires text; unchanged same-agent re-entry need not. A head-only
change can produce metadata without repeating a body. Historical reads do not
regress current selection knowledge. Fired prompt bytes and needed observations
publish in one ordered envelope with no record reread after comparison.

Bodies up to 32768 raw UTF-8 bytes use ordinary exact JSON encoding. Larger bodies
pass through complete JSON encoding, complete record-prompt outbound redaction,
scalar-safe display cuts (up to 8192 UTF-8 bytes per end), disclosure/latest-current
pointer, then fresh JSON quoting of the entire preview. If the redacted display
fits 16384 bytes, it appears once with no-further-elision disclosure. This is still
`exposure:{kind:'excerpt'}`: not full source, a contiguous slice or a final injection
limit. Omission counts describe intermediate display bytes, not raw source offsets.
Fragments must not be decoded as a record. A versionless pointer reads latest
effective content, possibly a draft, not omitted historical bytes. Omitted
requirements remain binding; the separate accepted bootstrap stays complete.

Typed observations preserve source selection, exposure and coordinates separately
from actual text. Current metadata/slice/full reads and known mutations can advance
knowledge without preserving bodies. Conversation format 13 compacted facts retain the
newest descriptor per key in surviving occurrence order (A1,B1,A2 becomes B1,A2),
not revision/time or first-key insertion order. Source hashes/head revisions identify
source, not transformed display bytes. Facts confer neither body recall nor write
authority. Shell accepted content is quoted record evidence with factual
`content_author`, not an agent verdict; baseline/draft author is null. External
authorship attributes credential use, not a verified person/model.

### Entry data and record initialization

Selected typed inputs append once as compactable quoted user data after actual
entry/recovery/predecessor facts and optional prompt. Original field names govern
scalar/list-element redaction before JSON quoting. Empty inputs add no row;
compaction does not reappend them. Fresh entry resolves fresh inputs, not prior
action logs. An accepted action handoff carries its redacted summary, selected
facts, exact invocation detail and immutable accepted-record links through existing
text context; a receipt is never acceptance.

Record initialization is separate: explicit node `initialize_records` and exact
head absence trigger lazy rendering of
`initialization:{format_version:1,template}`. The initializer host permits only the
values above and direct fragments; `${NAME}` remains literal in that exact field.
It publishes current-only baseline0, not instructions or authored acceptance.
Existing heads, even empty-after-discard, suppress rendering. Clean opens baseline
as draft0/target1 or opens an empty next draft with accepted backing; it does not
rerender. Baseline/draft0/empty drafts cannot satisfy acceptance. Current
observations retain version/target/backing after compaction, never today's template
or omitted body. [Record evidence](../runbook/evidence.md#baseline0-drafts-and-accepted-documents)
and the [configuration guide](../guides/configuration.md) own examples and use.

## Composition, compaction and evidence

The primary composition projector places prepared dynamic blocks first, then one
system provenance boundary when non-dynamic context exists, accumulated-summary
context with exact source segment/cutoff, newest recovery/refusal facts, retained
instructions and uncovered suffix. Latest record observations remain internal
bookkeeping, not a generated ledger in primary composition, summarizer orientation
or covered source. Useful conclusions survive through normal summarization; needed
detail/current evidence can be explicitly reread with existing tools, without a
per-record prose inventory or mandatory reread ceremony. Existing historical summary
text remains unchanged. Actual tool results and record-prompt selection/body text remain,
including explicitly requested observation-inspection data. Internal facts remain
strict and available for preparation and operator audit; they do not reconstruct
omitted bodies or grant freshness, acceptance or write authority. Summary coordinates
delimit a historical prefix, not all origins or a cutoff date. Later continuation
may supersede old status/authorization claims; still-applicable requirements and
one-time accepted handoff obligations do not expire. Summary/replay grants no
approval. Uncovered tool/private bundles remain atomic and visible according to
their policy until successful compaction covers a strict source prefix.

Primary copies of successful current process results may omit only done+complete
stream URLs after strict acceptance and update the copied serialization/hash.
Summarizer source keeps canonical URL-bearing rows. Responses private/visible pairs
are validated before protocol projection; covered private bytes are not summary
prose. Images materialize descriptor-selected source-session PNGs, never today's
workspace file. Chat, Responses and Codex map the same ordered composition; adapters
add no context-selection or authority rule.

Summary requests receive the full frozen prepared blocks, protected instructions, genuine accumulator and
labeled new source ranges. Guidance prioritizes final applicable decisions, known
effects, uncertainty, ownership and useful anchors; it distinguishes proposals,
drafts and accepted work. A successful last newline-separated command does not
establish earlier command success. Normal/corrective 12000/6000-byte targets are
guidance, not prose-validity ceilings. Exact protections/facts/continuation survive;
eligible declared omission can lose inherited prose and days of narrative. No fit,
semantic fidelity, recall or model-compliance guarantee follows. See
[provider context](./system-architecture.md#provider-context-and-compaction) and
[capacity diagnosis](../runbook/diagnosis.md#compaction-and-context-capacity).

### Prepared, current and historical instructions

The activation marker records named prepared role/node/card/caller/activation/parent
fields once. This structural evidence is **not** ordinary context fed back to
primary/summary, a protected instruction occurrence or a snapshot of bootstrap/tool
definitions. It is not carried into compacted genesis: inspect the exact indexed
source segment. Existing positively marked `workflow_prompt` occurrences retain
their producer position and policy; unmarked text is not reclassified by resemblance.

The current-instructions endpoint renders **server-loaded configuration**, redacts
each complete binding and excludes dynamic context/tools/private wire data. It does
not reread edited disk hosts, reproduce a historical request or prove delivery.
Historical views show actual retained strings/coordinates or explicit absence and
outside-tail distinctions, never reconstructed current templates. Prepared text,
recorded images and a serialized request prove neither provider perception nor
model understanding. [Instruction inspection](../runbook/evidence.md#prepared-current-and-historical-instructions)
owns the operator procedure.

The external Analyst MCP service instead supplies concise initialize instructions,
bound tool schemas and a fresh context resource. It does not export the internal
Analyst prompt/conversation or manufacture transcript rows. Client retention is
client-owned; policy authority remains the configured Analyst surface. See
[external clients](../runbook/mcp.md#external-client-to-analyst).

## Author at the effective owner

Read and follow the repository's
[saivage-prompt-authoring workflow](https://github.com/salva/saivage-v3/blob/HEAD/.github/skills/saivage-prompt-authoring/SKILL.md) before changing
model-facing text. Inspect selected hosts, actual substitutions/tools, repeated
turns, re-entry and compaction; finish with a separate whole-composition sufficiency
and baggage review. Static projection is not delivery or quality evidence.

| Instruction responsibility | Effective owner |
| --- | --- |
| Reusable strategy, evidence reuse, scope and authority | Always-prepared shared role. |
| Today's work, evidence and outcome distinction | Actual current-node process host. |
| Accepted findings, immutable citations, outstanding obligations | One-time edge/handoff; not a second destination task. |
| Correct the attempted result/record violations using supplied diagnostics and budget | Correction host; not indiscriminate reimplementation or a future activation's task. |
| Current selected record data | Supplier/record-context host; not indispensable init-only procedure. |
| Parameter/output mechanics | Generated tool/result contract. |

The shared Planner interprets separately supplied `cardType`: project strategy
through complete evidenced acceptance versus goal-local decomposition/repair.
There is one role artifact, not a project/goal role classifier. Executor owns
scoped work, useful verification/current status; Reviewer owns independent
inspection and review records; Analyst resolves requests within permitted controls;
Oversight performs bounded diagnosis/advice or successful no-action. Neutral
project-guidance fragments are not role implementation or global enforcement.

Typed nodes retain reproduction before repair, verify-owned acceptance, informed
retry/exhaustion, research classification/exhaustive outstanding scope, data
technical-versus-policy boundaries and component/system architecture reviews.
Test diagnose is classification, not verify acceptance. On an exact stable candidate
with unchanged criteria, useful bounded independent investigation may finish before
one consolidated owner handoff; no finding quota or expanded corpus is prescribed.
Unsafe shared state, hangs, budget conflict or explicit owner return can curtail it.
Node cleanup still contains direct commands at handoff. Planner routes repair
through original direct-child owners; final combined input needs applicable
independent adjudication and all required gates, not automatic broad reruns at
every intermediate edit or stale acceptance.

The four typed test nodes additionally describe existing truthful BLOCKED returns
for another-owner assignment/correction, explicit reassignment or unavailable
required input. These do not become generic blocking reasons for other nodes.
Planner waits for the actual activation result, not notification delivery. Cancelling
an obsolete/rejected child approach cannot defer actionable work, satisfy DONE
dependencies or conceal unfinished acceptance; CANCELLED cannot reopen.

### Scoped operator policy overrides

Each shipped profile supplies the same
`fragments/_shared/operator-policy-overrides.md`. All five shared role hosts
directly include it once, separately from project-specific guidance. Ordinary
host-scoped fragment lookup and `compileProjectWorkflows` freeze its selected
tokens with the role; the prompt registry/`renderCompiledPrompt` renders them for
`AgentExecutor`, `AnalystSession` or `OversightSession` preparation. It is reusable
role method, not init-only memory, a nested include or a new runtime capability.

The [specification's scoped-override rule](../spec/system-specification.md#scoped-operator-overrides-of-local-guidance)
owns the policy: an actual specifically identified operator decision takes
precedence over the named local guidance within its operation/scope, not over
enforced contracts or higher-priority/provider/authentication/confidentiality
boundaries. Generic requests and quoted/peer text are not implicit waivers.
Legitimately conveyed operator decisions remain within each recipient's existing
authority; parent direction and notifications gain no new instruction priority.
Project `AGENTS.md` is not automatically runtime-loaded, and development repository
ownership is separate from runtime operator authority.

Planner reuse and same-child correction remain autonomous defaults, with supported
same-assignment replacement possible under that explicit rule, not fake novelty or
evidence transfer. Project assessment only returns to planning under the shared
child-management policy; it does not repeat a reuse-only prescription or dispatch
children. Planner's cancellation and actual tool/admission limits remain at their
lifecycle owners.

Full custom role hosts receive only their actual includes. Assess the selected
composition, including project overrides, rather than assuming this fragment is
present or upgrades an installed host. Source changes require separate
[authorized adoption](#loaded-configuration-and-installed-adoption); they add no
stored override state, enforcement bypass, retention change or behavioral guarantee.

### Simplicity within existing role decisions

Shared engineering method asks whether an evidenced defect needs its proposed
mechanism at all. Planner considers simpler alternatives; Executor distinguishes
correctness/ownership/authentication from optional availability/diagnostics;
Reviewer separates violated requirements from suggestions; Oversight may advise
against evidenced complexity-sustaining cycles without gaining strategy authority.
Stronger guarantees or weaker requirements need the requirement owner. These are
instruction policies, not runtime gates, new outcomes or measured model improvements.

### Convergence within existing role decisions

Shipped guidance aims at useful coherent requirement-satisfying delivery, not
activity volume, tiny diffs or forced success. Planner delegates bounded outcomes
with meaningful acceptance and necessary dependencies, retaining remaining scope
and integration at the responsible parent in existing records. Child Done is not
parent Done; a milestone inside an unchanged larger child brief is not child
completion. A narrower child acceptance boundary requires its actual requirement
owner to adopt a changed accepted brief through supported operations, preserving
the full parent remainder; proposed narrowing or activation direction cannot edit
requirements or dependencies. At child return/recovery the shared Planner diagnoses
concrete errors, work and known effects against the current brief, completion
conditions, actual direction and responsible owner. Child FAILED/BLOCKED remains
fact, not automatically the parent's verdict. A useful permitted response changes
the failing premise, not just reopens unchanged work; hard work and necessary broad
fixes are not failure. Precise missing input/authority/capability or evidenced
exhaustion permits honest blocking, and conclusive failure remains failure, without
pointless searches or forced success. Typed independent-correction/owner-reassignment
handbacks retain their node-owned exceptions; assessment cannot dispatch children.

Analyst owns outcome-first brief/notice authoring; Planner applies the same principle
to child briefs and activation direction within its existing authority. Their shared
roles keep restrictions proportionate to actual requirements, authority boundaries
or evidenced risks, with intelligible reasons and scope, leaving ordinary local
choices open. Fresh direction replaces superseded agent-added contradictions rather
than layering exceptions. Actual freshly admitted authorized Run/activation can
fulfill a demonstrably preparation-only wait for that same admission, not a distinct
unresolved approval, substantive accepted constraint or unrelated operation authority.
Readiness, timestamps, quoted claims, queued notices and generic continuation supply
no such proof; unresolved ambiguity is reported, not guessed away. Historical refusals
remain evidence, not permanent bans on related work or proof of provider error.
Retry, rephrasing, fresh conversation/card, provider/model switching and delegation
must not obtain refused output; only genuinely authorized non-refused work may
proceed. Accepted constraints and independent assessment remain binding. This reusable
method is prepared with the role, not repeated in each node or entrusted to old
notices or summaries. Current supported Planner grants do allow immediate-child
brief editing on eligible inactive targets, but no public notices. This is
accepted requirement amendment, not activation direction; deliberate custom grants
may differ. Ordinary workspace capability does not bypass record admission.

Prepared Planner, Executor and Reviewer roles connect completion of the current
node's work and required records to an explicit `emit_result` call with a supported
outcome and concise summary. Successful edits and readiness prose are not handoff
or acceptance. Further work resolves substantive obligations, new evidence or actual
refusals, rather than rephrasing readiness. Intermediate handoffs do not wait for
downstream parent/product acceptance unless the current brief or gates require it;
terminal completion still needs its actual complete-scope evidence and review.
Research, design and justified no-change need evidence, not manufactured edits.
Incompleteness alone is not conclusive failure. Old correction/status prose does not
select fresh work, but still-applicable requirements, failures and effect/resource
facts remain consequential. Correction fixes actual result/record violations from
the supplied diagnostics and remaining-attempt contract; a valid envelope proves
neither fulfillment nor impossibility. Native correction applies this method to
its authorized source task and `source_ready` verification, not product status or
subtree completion; checkpoint and optional diagnostics do not supply approval.

Reviewer independently assesses the requested combined outcome/current input against
every assigned criterion, retaining applicable unchanged evidence rather than
automatically restarting broad checks at every edit. Historical verdicts and isolated
green pieces are not fresh acceptance. During existing bounded checks, Oversight
distinguishes successful readiness-only paraphrasing from work resolving real gates
or refused results, and compares inspected evidence to objectives and delivery gaps
even when patches, commits or checks show local progress. Qualified normal advice
acknowledges that progress and asks the nearest eligible responsible Planner to
reassess approach, decomposition or ownership. Healthy research narrowing uncertainty,
truthful red cycles and deep review remain legitimate; partial observation, elapsed
time or difficulty alone establish no futility. No new actionable concern means
successful no-action. Advice gains no strategy, acceptance or guaranteed-attention
authority.

These are role/node instruction policies, not new runtime gates, outcomes, progress
detectors, retention rules or durable contracts. Static composition does not prove
improved convergence or model understanding. Source changes do not upgrade installed
materialized/custom prompts; [authorized adoption](#loaded-configuration-and-installed-adoption)
remains separate.

### Current status

Planner/Executor status is a brief-relative current assessment, not a separate
activity-history log. Preserve decisions, failed/partial checks, actual source and
artifact identities, unresolved effects/resources, cumulative accounting and
remaining work when consequential. Later success does not erase an earlier relevant
failure or confirm release. Reviewer still owns `review.md`, not `status.md`.
No fixed template, quota or new acceptance gate follows.

### Illustrative status consolidation

**Illustrative scenario, not executed evidence or required wording:** brief requires
CSV export and successful retry on source X, then independent review. Export exists,
retry failed, worker remains allocated without confirmed release. A current status
can consolidate repeated update narration. Before:

```markdown
Implemented CSV export on X. Ran retry round-trip; failed
(reports/export-X-failed.txt). Still need successful retry on X and independent
review. Kept task-owned worker allocated; no release confirmed. Updated status again.
```

After, with the same supplied facts:

```markdown
CSV export is implemented on source X, not yet accepted: retry round-trip still
fails ([failed check](reports/export-X-failed.txt)). Fix retry handling and verify
the required round-trip on X before independent review. The task-owned worker
remains allocated for that investigation; no release is confirmed.
```

### Dedicated file-tool preference

All five shipped roles prefer selected `read`, `glob` and `grep` for inspection.
Planner/Reviewer prefer permitted `write`/`edit`; Analyst also names `apply_patch`;
Executor prefers available `apply_patch` for deliberate source edits over shell
replacement, retaining appropriate record/write/edit use. Oversight stays read-only.
Legitimate role-authorized builds, tests, Git, generators and pipelines still use
`run_command`. Analyst gains no delivery/source-shell/deployment/build authority.
Failure/conflict grants no bypass of tools, paths, records or confidentiality.

Shared Executor guidance prefers ordinary high-level operations for authorized Git
work: preserve unrelated files and staged work, avoid destructive cleanup or history
rewriting without authorization, and avoid ad-hoc advancement of a checked-out branch
ref that leaves its actual checkout and index out of sync. This is instruction
guidance, not runtime enforcement, new Git authority or a universal commit requirement.

The same shared Executor owns versioned-work selection: meaningful source, compact
faithful fixtures/goldens, pinned deterministic generators and concise reproducible
research/provenance, rather than full logs, exhaustive exploratory captures or
duplicated large result sets. Secret/runtime inputs and generated state/cache/build
outputs are not ordinary commit content; authored non-secret configuration and
genuinely required data remain legitimate. Compactness must preserve every applicable
workload/assertion. Existing raw-evidence locations may be referenced when useful,
without promised retention, mandatory hashes or new storage/approval mechanisms.
This is future work-product guidance, not permission to delete unique/historical
evidence or rewrite Git history. Role preparation, generated contracts and separate
installed/customized-host adoption remain unchanged.

## newloop2 task and composition ownership

Newloop2 is a separate graph and physical closure, not another prose delta on
classic-typed. Always-prepared roles own stable method; full current-node hosts own
framing, alignment, delivery, root reconciliation, acceptance, debt and reentry.
Generated contracts remain the sole result authority; generic correction uses
actual diagnostics. Final pending-context handoff is historical, not duplicate
next-node instruction. Distinct doc/ops hosts retain asset-specific completion.

One Planner and one distinct Reviewer session recur across nodes. Accepted prior
review and effective clean draft feed separately; only the required record is
initialized. Conditional feeds may be suppressed/excerpted; compaction retains
current prepared task without guaranteeing earlier body recall. Read exact history
where needed and retain useful immutable citations before replacing review.
Own feeds are not an automatic own-record tuple fence; descendant freshness is
bounded to consumed selections, not workspace. Selective reentry reuses applicable
work, never old activation-local accepted results. Only current final debt/system
verdict is promoted.

Original local wording is informed by [PAAD v2.1.0](https://curtispoe.org/paad/),
read November 10, 2026: reality-grounded premise challenge, bidirectional intent
coverage, alignment, verified/deduplicated findings and structural quality for code
and non-code work. No human-approval/specialist-count/coverage-quota/Git ritual is
imported. See the [exact graph and limits](../spec/system-specification.md#newloop2-explicit-review-loop)
and [profile README](https://github.com/salva/saivage-v3/blob/HEAD/src/config/system-templates/newloop2/README.md).
Scripted real-owner/composition evidence qualifies configuration/instructions, not
empirical model wisdom, compliance or improved output quality.

## Shipped profiles and customization

`classic` is default; explicitly provisioned `classic-git` adds native source
ownership to classic graphs; `classic-typed` supplies typed graphs; opt-in `paad-typed`
uses the same frozen typed config with five prose differences; opt-in `newloop`
uses that exact config with eight original prose differences for intent-to-delivery
quality across code and other assets. Neither variant changes tools, records,
routes, identities or native-Git OFF policy. Packaging compiles
each registered template standalone, observes the complete selected artifact closure
and requires physical source/copied output equality. Classic-family shared
agent/fragment membership/bytes and common shared process bytes are checked;
typed-only paths are allowed. Newloop has its own bounded config/path/byte parity
check, separate from PAAD's five-path check. There is no union tree or maintained
numeric closure count.
All closures include five shared roles, six project-guidance fragments, the shared
operator-policy-overrides fragment and graph-selected process hosts. Fresh
config-absent init materializes the selected closure, marker and YAML last.
Existing-config init preserves all three.

### Project objective assessment

The classic/classic-typed/paad-typed/classic-git/newloop family selects `assess-completion` and project plan/recover hosts
(classic `plan/recover`, typed `specialized-plan/specialized-recover`). Assessment
is current-node context through turns/summary, not an init reminder. It reconciles
accepted brief, current status/children, applicable review/evidence and delivered
owner context, writes current status and submits replan, necessary review,
legitimate completion or honest blocker/failure without child dispatch or delivery.
Reconciled continuing work calls for `replan`, not implementation or further
readiness polishing inside assessment; no additional review is needed merely to
return remaining work to planning. Typed research similarly submits evidence to
assessment, its supported classification to report, and the completed bounded
report to its parent. It does not invent a research review node or treat report
completion as downstream independent acceptance. Classic research uses execute.
Accepted-edge context carries actual Reviewer evidence/immutable links; compaction
may summarize it, so links do not substitute for needed body reads. STOPPED prepares
recover from current facts; historical review is not a new activation verdict.
Goal notification hosts remain selected in the closure. Adopting removal of the old
project node independently follows [participating identity rules](../runbook/state-adoption.md#participating-identity-changes).

### Project-specific guidance hooks

Each shipped role directly includes common and matching role guidance. Under
`fragments/_shared/`, the six defaults are nonempty neutral text:

| File | Default body |
| --- | --- |
| `project-guidance-common.md` | `No additional project-specific guidance is configured in this file.` |
| `project-guidance-planner.md` | `No additional project-specific Planner guidance is configured in this file.` |
| `project-guidance-executor.md` | `No additional project-specific Executor guidance is configured in this file.` |
| `project-guidance-reviewer.md` | `No additional project-specific Reviewer guidance is configured in this file.` |
| `project-guidance-analyst.md` | `No additional project-specific Analyst guidance is configured in this file.` |
| `project-guidance-oversight.md` | `No additional project-specific Oversight guidance is configured in this file.` |

Common reaches only hosts retaining that include; subsets use matching role files.
Specialized fragments replace shared text, and full custom roles may omit hooks.
Fragments are trusted prompt syntax under the host policy, not opaque Markdown.

### Optional paad-typed guidance

The complete physical path set matches classic-typed; bytes outside these paths match:

| Path under `prompts/` | Local adaptation |
| --- | --- |
| `agents/_shared/planner.md` | Evidence-grounded pushback, bidirectional alignment; owner decides material requirement choices. |
| `agents/_shared/executor.md` | Resolve task uncertainty; return unavailable decisions through existing outcomes; current validation/interface coherence. |
| `agents/_shared/reviewer.md` | Independent scope/source comparison, verified findings and supported no-finding outcomes. |
| `process/architecture/architecture-component-review.md` | Component fit, contracts, complexity and maintenance. |
| `process/architecture/architecture-system-review.md` | Integration/operational/persistence lens, preserving immutable component evidence. |

These are prepared role/node instructions, not conditional record or one-time
procedures. Graphs, tools, outcomes, feeding/retention and neutral fragments remain
identical; Analyst/Oversight are unchanged. This adapts Curtis “Ovid” Poe's PAAD
(Pushback, Alignment, Architecture, Discipline), not the full upstream plugin.
The [profile README](https://github.com/salva/saivage-v3/blob/HEAD/src/config/system-templates/paad-typed/README.md)
records pinned sources/exclusions. Its full pinned MIT notice travels with Planner;
it neither replaces Saivage's GPL nor claims endorsement or measured quality.

### Optional newloop guidance

Newloop foregrounds a coherent responsibility loop: critically examine accepted
intent and current facts, choose an appropriate design/approach, progressively plan
and deliver, then revise and assess from actual evidence. It is not five mandatory
stages. The complete standalone physical path set equals classic-typed; only these
eight paths under `prompts/` differ:

| Path | Effective responsibility |
| --- | --- |
| `agents/_shared/planner.md` | Consolidated intent examination, design/planning, direct-child delegation, revision and completion method. |
| `agents/_shared/executor.md` | Proportionate interpretation, actual output alignment and asset-appropriate production/validation inside the current leaf node. |
| `agents/_shared/reviewer.md` | Independent bidirectional alignment, verified/deduplicated findings and proportionate quality/debt assessment. |
| `process/_shared/specialized-plan.md` | Goal's current analysis, useful next slice, delegation and full remaining obligations. |
| `process/project/specialized-plan.md` | Root version with full objective and assessment handoff, not direct DONE. |
| `process/_shared/specialized-recover.md` | Recover relevant reasoning/plan/design from current evidence, preserving sound work. |
| `process/project/specialized-recover.md` | Root recovery with objective and historical-review limits. |
| `process/_shared/specialized-review.md` | Integrated goal/project assessment and supported verdict. |

All other bytes match classic-typed: Analyst/Oversight, architecture nodes, project
assessment, notification handling, correction/transition hosts and all seven shared
fragments. Direct includes and exactly one generated contract token per workflow
role remain unchanged. Reusable method belongs to prepared roles, today's task to
the full current-node host—not replaceable project-guidance hooks or init-only
memory. Primary invocation instructions retain the role method through continuing
turns, reentry and after compaction. Summary requests instead use summary-specific
instructions; selected prepared card/current-node/bootstrap context and
activation-local parent direction where applicable supply read-only orientation,
not the role method as summarizer instructions or historical evidence. Conditional
record bodies need not repeat; relevant detail belongs in current records/work
products and must be read when needed.

Planner tests premises against the intended need and relevant documentation/facts,
then closes ordinary decisions into work. It retains the full remainder while
detailing the next slice and executes via direct children, never delivery source
edits/builds/tests. A bounded architecture/research child can inform later work;
local design reasoning is also legitimate. Returns distinguish execution mistakes,
plan gaps, design faults and requirement decisions. Consequential decisions outside
authority return through truthful BLOCKED with evidence, impact, options and the
needed decision; parent direction cannot edit a child's accepted brief. Actual
requirement changes reach their requirement owner. Failed tactics do not imply
objective failure; conclusive failure remains failure, with no forced success,
uncertain-effect replay or provider-refusal circumvention.

Assessment relates intent to analysis/design, intent/design to plan, design/plan to
actual output and useful delivery back to the authorized need. Consistent artifacts
can share a mistaken premise. Independent examination verifies findings rather than
echoing author claims or green checks; required acceptance is preserved. Relevant
quality lenses include behavior, ownership/data, structure/coupling, integration,
state/error semantics, observability/configuration, security/confidentiality,
maintainability and applicable accessibility. These are lenses, not mandatory
specialists, reports or stronger guarantees. Evidence follows asset purpose:
research needs credible sources/method/limits; documentation needs factual and task
usability checks; data needs meaning/provenance and required validation; design
needs system fit/feasibility; operations need authorized observable effects. Code
commits and test frameworks are not universal obligations. Necessary in-scope
structural correction can return to ordinary owners, while adequate structure
merits no change and unrelated cleanup is not a completion gate. Low-risk direct
completion remains legitimate; it cannot bypass necessary independent assessment.

Conceptual input is Curtis “Ovid” Poe's [PAAD course](https://curtispoe.org/paad/)
(consulted as v1.24.1, modules 2–4 and 6–9): reality-grounded pushback, intent/action
and design alignment, structural ownership/quality review, verified independent
findings, accessibility and missing-context limits. Newloop adapts its
human-decision-oriented reasoning to autonomous local choices plus accountable
escalation, not human approval for every step. It imports no specialist quota,
branch ritual, fixed history scan, report template, universal TDD task rewriting
or extra recovery/accessibility requirement. Its eight hosts use original local
wording, not upstream course/skill expression or paad-typed's licensed adaptations.
The [newloop README](https://github.com/salva/saivage-v3/blob/HEAD/src/config/system-templates/newloop/README.md)
records choices, attribution and exclusions. PAAD's case reports motivate the
method; they are not controlled proof of this profile's effectiveness or endorsement.

Offline renders, source/package parity and scripted runtime paths qualify available
instructions and legal handoffs—not provider delivery, model understanding or
measured output quality. No durable contract/version changes solely for these
prose differences. Fresh config-absent init can select `--profile newloop`;
existing-config init preserves inputs and is not a switch. Matching classic-typed
contracts/identities need no migration solely for prose adoption, but still require
separately authorized stopped reconciliation and a fresh process. Whole-release
identity/format assessment and operational consent remain separate.

## Loaded configuration and installed adoption

Prompt selection/compilation happens when an artifact is built for startup or
offline candidate validation. Runtime consumes that immutable artifact. Reconfigure
validates and publishes next-start YAML with `requires_restart:true`; it does not
install new workflows or reread prompt files into the running process.

Existing-config init, Run, Pause/Resume and browser refresh do not upgrade prompts.
An authorized installed change stops the service, reconciles actual selected
materialized/custom hosts and fragments while preserving project guidance, and
starts a genuinely new process. Prompt-only same-contract content adoption needs
no generated reset; whole-release participating-identity/durable differences are
separate blockers requiring their own authorized procedure. Hand-authored typed
configs must supply their typed-only hosts: the runtime bundled default closure is
classic, not an implicit cross-profile fallback. Removed path/key forms are never
read, moved or normalized. Source completion authorizes no installed operation.

## Source map

| Source | Ownership |
| --- | --- |
| `src/runtime/card-process/card-process-config.ts` | Exact selection, structural compilation, eager process text, retained record-context tokens. |
| `src/utils/prompt-api.ts` | Tokenization, host policy, one-level includes, opaque rendering and loaded role registry. |
| `src/runtime/actors/agent-executor.ts` | Selected card-node preparation, transition/correction and real conversation/tool lifecycle. |
| `src/runtime/actors/node-execution.ts` | Shared record entry/acceptance, typed inputs and action/agent split. |
| `src/runtime/records/bootstrap-context.ts` | Same-read bootstrap/conditional record supplier. |
| `src/runtime/records/record-prompt-content.ts` | Encoded/redacted excerpt construction and disclosure. |
| `src/runtime/actors/context/composition-projector.ts` | Ordered primary/summary projection and provenance boundary. |
| `src/contracts/conversation-validation.ts` | Actual source facts, protection, pairing and coverage. |
| `src/runtime/actors/compaction/summarizer.ts` | Refine instruction/source composition and source-owned attempt evidence. |
| `src/application/read-models/agent-operator-read-model.ts` | Current loaded instructions and exact historical/image inspection. |
| `src/config/system-templates/<name>/prompts/**` | Per-template complete bundled closure. |
| `scripts/copy-system-template-prompts.js` | Compiler-derived closure/parity and byte-preserving package copying. |
