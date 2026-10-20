# Prompt handling

Bound shell stdout is ordinary quoted record evidence, not a role instruction or
agent verdict. Actual `read` metadata/text results expose `content_author` from the
selected acceptance (agent, external-agent, runtime or shell-stdout); draft/baseline content has
null author even over accepted shell backing. Historical reads retain historical
authors. A report link in the existing handoff is enough: no new starter/template
instruction, fake action tool call or synthetic mutation observation is introduced.
Typed selection observations stay author-free; recorded opaque old tool data is
not normalized. Static role/node/card/advisory-parent context, fresh bootstrap and
record suppliers, two-field generated result (outcome and nonempty summary≤2000),
correction, re-entry and compaction delivery are unchanged. Assessment still belongs
to the admitted agent using the actual evidence and its existing permissions.

This in-depth companion to [System architecture](./system-architecture.md) and [System specification](../spec/system-specification.md) explains prompt discovery, validation, rendering, and runtime use. Saivage has no prompt editor, hot reload, manifest, runtime selection, or prompt-builder framework. Prompt handling is deterministic and startup-only; actors consume immutable compiled artifacts.

The optional direct external Analyst MCP service supplies its own concise initialize
instructions, generated bound tool descriptions/schemas, and a freshly read context
resource. It neither loads the internal Analyst prompt/conversation into the client
nor creates transcript rows. The configured Analyst policy owns authority; the
configured external principal attributes credential use, not verified model identity.
Client retention of initialize instructions is client-owned; current facts remain
available through the context resource and canonical read tools.

::: v-pre
## Purposes and layout

| Channel | Owner and lifetime | Authority / evidence |
| --- | --- | --- |
| Role, generated outcome/tools, node, card orientation | Startup compiler and node preparation; stable through this node | Present method/task and permitted effects, not init-only memory |
| Parent direction | Exact Supervisor parent relationship; entire actual child activation | Advisory direction with trusted invocation provenance; no grandchild inheritance |
| Current accepted bootstrap / declared record inputs | Synchronous node-bound supplier at each new logical primary operation | Same-read current requirement snapshot; retained through that operation's maintenance/retries |
| Conditional record prompt | Same supplier, compared against pre-existing conversation record/view knowledge | Actual rendered occurrence; declaration-controlled instruction retention |
| Entries, accepted edges, correction, notifications | Existing event/result/recipient owner; once per actual occurrence | Attributed facts, immutable evidence and scoped direction, not current-node selection |
| Action handoff | Accepted edge into an actual agent; existing durable text context | Quoted, outbound-redacted summary, exact invocation-detail reference and immutable accepted-record links; observations, never instructions or tool authority |
| Selected agent inputs | Once per actual lifecycle/recovery/urgent entry or configured outcome/pending-notification edge, after its prelude and optional prompt | One optional compactable quoted user message; original-name scalar/list-element redaction preserves display shape, not new instructions, protection or routing facts |
| Latest record observations | Canonical source-order fact derivation plus retained suffix | Descriptor-only selection/exposure knowledge, not a subscription, body recall or write authority |
| Global/non-model ingress | Existing Analyst/Oversight owners | Actual explicit read observations only; no synthetic card/parent feed; confirmation-only is model-free |

Parent activation direction is a retained activation-local system block alongside
stable card orientation and the current node, supplied to both primary and summary.
It is advisory under accepted requirements, workflow, permissions and acceptance.
`activate_card` requires explicit preserved non-whitespace `instructions`. The
Supervisor captures them with trusted exact parent invocation provenance. An exact
lease join does not replace them; another lease cannot overwrite an owned child.
New activations use new direction, root/global ingress has none, and grandchildren
receive only their own parent's direction. Historical markers record the named
role/node/card/caller/activation/parent fields, never positional block guesses or
current-template reconstruction. Public notifications are configured-global advice,
not a second Planner task-direction channel; internal notifications and recipients
retain their ordinary behavior.

`NodeExecution` keeps common acceptance outside prompt execution. `AgentExecutor`
retains preparation, real tool-result settlement, correction re-arm budget16,
notification delivery, fresh bootstrap/record suppliers and compaction; it does
not rewrite the LLM actor. Accepted action handoff supplies quoted selected typed
facts, a redacted summary and exact invocation detail reference through existing
text context. It is not a new result tool, role instruction or automatic output
dump. Actions/hooks have no prompt, provider attempt or synthetic conversation;
agent `emit_result` remains exactly outcome/summary with its 2000-character bound.
Re-entry prepares the actual newly selected agent node; later Run reconstructs
current facts, not prior action inputs from logs. Existing prepared role/node/card
and advisory parent blocks, fresh logical-operation record snapshots and summary
feeding remain unchanged. A log receipt never substitutes for agent acceptance.

Agent prompts become provider static instructions. Process prompts are startup-compiled operational context: the actual current agent node's prompt is frozen as prepared request context, while lifecycle-entry, correction, configured non-terminal-edge, and pending-notification prompts remain durable conversation context at their producer-owned positions. Each consuming declaration owns its compaction policy; shared prompt text remains policy-free. Fragments are not prompts; they are directly included pieces compiled under the host prompt's policy.

Bundled defaults and project overrides use the same tree:

```text
<prompt-root>/
  agents/
    _shared/<prompt-reference>.md
    <card-type>/<prompt-reference>.md
  process/
    _shared/<prompt-id>.md
    <card-type>/<prompt-id>.md
  fragments/
    _shared/<fragment-id>.md
    <card-type>/<fragment-id>.md
```

The project override root is `.saivage/config/prompts`; each registered system template owns its own bundled source tree under `src/config/system-templates/<name>/prompts/`, and packaging copies each tree per-template under `dist/src/config/system-templates/<name>/prompts/`. Packaging compiles each registered template standalone against its own source prompts root, observes every selected bundled agent, process, and direct-fragment artifact, and requires the physical source and copied output trees to equal that template's compiled closure exactly. There is no union tree, runtime discovery, or separately maintained numeric file count. Before copying shipped templates, packaging checks compiler-derived classic/classic-typed shared agent/fragment membership and byte parity, plus common-path shared process byte parity; typed-only process paths remain permitted. Generic per-template copying remains independent of that explicit family policy. All three shipped closures contain five shared agent prompts and six shared project-guidance fragments, including Oversight, plus all process prompts selected by their graphs. `classic-typed` and `paad-typed` contain the same selected typed card-specific process paths and architecture notification-return prompt; PAAD has only the five intentional prose deltas below. No tree has a card-specific agent prompt. `saivage init --profile <name>` materializes the selected template's complete closure into a config-absent project override root, after which the instance owns its prompts; with an existing config, init preserves the prompt tree, marker, and YAML and performs no template upgrade.

Typed-only process hosts cover specialized planning (`specialized-plan`, `specialized-review`, `specialized-recover` and their review handoffs); code reproduction, repair, refactor and evidence/retry handoffs; test diagnosis, coverage, repair and verification; research exploration, assessment and reporting; data schema, validation and implementation; and architecture drafting, component/system review, revision handoffs and `architecture-notifications-to-draft`. The compiler-observed closure, not a maintained numeric total, owns the complete inventory. Each reference maps to `<reference>.md` under its shared or card-specific process directory.

### Project objective assessment

Every shipped closure selects `process/project/assess-completion.md` and
project-scoped plan/recover hosts: classic uses `plan.md`/`recover.md`, while both
typed profiles use `specialized-plan.md`/`specialized-recover.md`. The three
assessment hosts have identical bytes; shared Planner role ownership and PAAD's
five intentional deltas remain. Goal-selected shared notification handler and
handoff files stay in the physical closure although project no longer selects
that node. Generated outcomes, not copied schemas in prose, describe each graph.

Assessment is the prepared **current-node** task, present throughout its turns
and summary maintenance, not an init-only reminder. It directs current objective
reconciliation using the accepted brief, current status/children, applicable
accepted review/evidence and delivered owner context. Bootstrap/record suppliers
refresh at each logical primary operation. Ordinary accepted-edge context carries
the Reviewer's accepted outcome/summary and immutable record links; no extra
assessment handoff or review write permission is introduced. Compaction may
summarize that historical handoff: links and selection descriptors do not recall
bodies, so assessment reads actual records as needed. STOPPED prepares recover
from current durable facts; historical review is not acceptance in this activation.

The assessment writes concise current `status.md`, preserves outstanding scope,
and chooses replan, necessary review, legitimate direct/reviewed completion or an
honest blocker/failure without child dispatch or implementation. Reconciliation
does not guarantee model understanding or beta quality. Existing-config init
preserves selected prompts and YAML; separately adopting this matching closure
must preserve custom guidance **and** resolve the removed participating project
node under the [identity-cutover rules](../runbook/index.md#agent-and-workflow-identity-cutovers).
Stopped prompt reconciliation alone cannot resolve that incompatibility.

## Optional paad-typed guidance

`paad-typed` is an init-only opt-in methodology variant over the identical deeply
frozen classic-typed config. It owns a full physical closure, not an overlay or
fallback to another profile. Classic remains default; neither existing profile is
modified. Its compiled path set equals classic-typed's, and all bytes outside
these five paths remain identical:

| Path under `prompts/` | Effective responsibility |
| --- | --- |
| `agents/_shared/planner.md` | Evidence-grounded pushback before creation/activation; bidirectional scope alignment; ordinary local decisions remain autonomous, material requirement choices stay with the authorized owner. |
| `agents/_shared/executor.md` | Resolve task-defining uncertainty from the brief/direction/source before implementation; return unavailable required decisions through the current node's existing outcome and status; validation currency and changed interface/caller/doc coherence. |
| `agents/_shared/reviewer.md` | Independently compare delivery, accepted scope and actual source; verify findings, separate suggestions and accept supported no-finding results. |
| `process/architecture/architecture-component-review.md` | Component fit, boundaries/contracts, avoidable complexity and maintenance burden within existing criteria. |
| `process/architecture/architecture-system-review.md` | Complementary intent/integration/operational/persistence lens, preserving immutable component evidence while deciding system acceptance. |

These are prepared role/current-node instructions, not lifecycle-entry, handoff or
conditional record procedures. The three roles continue across operations and
compaction; the architecture nodes add only their current scoped lens. Bootstrap
is still supplied separately per operation. Parent direction remains advisory and
activation-local, never transitive. No feeding, declaration, retention, compaction,
graph, tool, result or durable-format contract changes. All six guidance fragments
remain neutral; Analyst/Oversight, including successful no-action, are unchanged.

A Planner cannot amend a child's accepted brief through metadata or activation
direction. Genuine changed requirements need the authorized owner; a truthful
supported result, not a notice or indefinite wait, returns unavailable input.
This supplies no new BLOCKED reason: ordinary diagnosis/repair, code already-green,
test verification-owned acceptance, data policy boundaries and exhaustive research
obligations remain intact. Existing independent review is the verification pass,
not a new validator or reviewer-of-reviewer gate. Status remains a current
brief-relative synthesis, not a PAAD activity log or mandatory matrix.

This deliberately adapts Curtis "Ovid" Poe's PAAD — Pushback, Alignment,
Architecture, **Discipline** — with a local anti-degradation emphasis, not the
upstream plugin's full procedures. The profile README records pinned sources,
adopted/excluded mechanics and attribution. The Planner carries the full pinned
MIT notice in a clearly delimited non-procedural section so it travels through
normal packaging/init. It neither changes Saivage's GPL license nor implies
endorsement or measured model quality. Existing-config init never upgrades or
switches a profile; later adoption needs separately authorized stopped
reconciliation and independently resolved identity/format compatibility.

## Selection and references

For a card host, exact lookup order is:

1. project `<purpose>/<card-type>/<reference>.md`
2. project `<purpose>/_shared/<reference>.md`
3. bundled `<purpose>/<card-type>/<reference>.md`
4. bundled `<purpose>/_shared/<reference>.md`

The global Analyst has no card type and checks project shared then bundled shared only. Prompt APIs represent that with `{kind:'global-agent'}`; workflow and process hosts instead carry `{kind,cardType}`. Scope is never encoded by comparing a card name. Consequently a configured card type named `global` follows the complete card-host order above for agents, processes, and fragments and receives workflow/process placeholder policy, while the Analyst remains independent. Only exact `ENOENT` advances. Empty, invalid UTF-8, directory, unreadable, malformed, or otherwise failing paths abort compilation. Selection never enumerates directories.

`agents.<agent-name>.prompt` is the strict declaration `{reference,compactable?}` at every agent tier. `reference` is the filename reference and omitted `compactable` resolves to `true`. Static agent and node declarations accept explicit true or false but never `compaction_key`; their policy does not change delivery or create durable model-context occurrences. Once-per-activation structural prepared-instruction evidence is distinct and never becomes model context or protected instruction authority. Agent name remains runtime/session identity, not a file key. Agents sharing a prompt reference share the same applicable override; independent override content requires distinct configured references. This is a breaking no-compatibility contract.

Within `workflow.format_version:2`, each agent node selects `execution.kind:agent` and declares its `agent`, `prompt:{reference,compactable?}` and `correction_prompt:{reference,compactable?,compaction_key?}` inside `execution`. Action nodes have no prompt or correction prompt. Lifecycle entries, nonterminal edge prompts, and pending-notification prompts use the durable declaration shape. At durable sites omitted/true means ordinary compactable content and forbids a key; false without a key retains every occurrence; false with a nonempty exact key retains only the latest occurrence of that key and releases the older occurrence into the next successful compaction summary. Keys are exact, including whitespace, and are neither trimmed nor synthesized. Policy belongs to the consuming declaration, so two sites may share one reference while choosing different retention.

Prompt-related configuration excerpt (other required fields and routes omitted):

```yaml
agents:
  executor:
    prompt: { reference: executor, compactable: false }
card_types:
  code:
    workflow:
      format_version: 2
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
            correction_prompt: { reference: correct-execution-result, compactable: false, compaction_key: execution.correction }
```

Fragments use the host card type even when the host itself came from a shared tier. Thus a shared code host may select a project `fragments/code/<id>.md`. The Analyst can use only shared fragments.

## Authoring shipped project guidance

Shipped model-facing files under `src/config/system-templates/**/prompts/**` are
excluded from Prettier. Author their bytes deliberately, including whitespace;
packaging copies bytes without normalization. Compiler-derived shared-template
parity, source/package byte comparison, and compiled prompt-composition checks
remain required by build.

The shipped selected-global set now contains Analyst and Oversight. Oversight has its own shared `oversight.md` prompt, directly includes `project-guidance-common.md` and the sixth shipped guidance fragment `project-guidance-oversight.md`, and accepts no workflow-agent placeholders. Both selected globals use global-host selection; card-specific fragments never reach them. Template packaging and init materialization derive the complete closure from compilation rather than a maintained file count. Existing instances adopt the complete six-fragment closure deliberately while stopped; init never upgrades an existing config.

Each shipped Planner, Executor, Reviewer, Analyst, and Oversight prompt leads with its functional responsibility and groups one common project-guidance include with its matching role include under **Project-specific guidance**. A freshly materialized template supplies these exact nonempty neutral defaults:

| Instance file beneath `.saivage/config/prompts/fragments/_shared/` | Default body |
| --- | --- |
| `project-guidance-common.md` | `No additional project-specific guidance is configured in this file.` |
| `project-guidance-planner.md` | `No additional project-specific Planner guidance is configured in this file.` |
| `project-guidance-executor.md` | `No additional project-specific Executor guidance is configured in this file.` |
| `project-guidance-reviewer.md` | `No additional project-specific Reviewer guidance is configured in this file.` |
| `project-guidance-analyst.md` | `No additional project-specific Analyst guidance is configured in this file.` |
| `project-guidance-oversight.md` | `No additional project-specific Oversight guidance is configured in this file.` |

For example, the shipped Planner prompt contains two direct includes, not a nested fragment:

```text
{{>project-guidance-common}}

{{>project-guidance-planner}}
```

Edit `project-guidance-common.md` when guidance should reach all five shipped role prompts that still select that shared fragment. For a subset, edit only the matching role files and leave every other fragment at its nonempty neutral default. These are shipped prompt hooks, not global enforcement: a card-specific same-ID fragment replaces the shared selection, and a full project agent-prompt override may omit the hooks.

Fragment selection follows the host, independently for each include. For example, a Planner host on a `project` card selects `fragments/project/project-guidance-common.md` ahead of `fragments/_shared/project-guidance-common.md`; a code-card Executor similarly selects `fragments/code/project-guidance-executor.md` ahead of its shared counterpart. A card-specific fragment **replaces**, rather than appends to, the same-ID shared fragment. Repeat any wanted shared guidance in that specialized file. The global Analyst and Oversight hosts have no card-type tier and can select only project-shared or bundled-shared fragments, so `fragments/project/…`, `fragments/goal/…`, and other card-specific guidance never reaches them.

Configured agent name does not insert these hooks. An independently named agent whose configured prompt reference is `planner` selects the shipped Planner prompt and therefore its two includes. A different reference such as `project-planner` receives no hooks unless that custom prompt directly contains both wanted includes. Putting a fragment in `_shared` only makes it selectable; it does not inject the fragment into arbitrary prompts.

Treat fragment text as trusted operator-authored prompt syntax, not opaque Markdown or a document link. The compiler parses placeholders in fragment bodies under the host policy. Nested includes, arbitrary-path imports, unknown or host-inapplicable placeholders, and composition that duplicates or removes the required workflow contract fail startup. Naming or linking `docs/**/*.md` does not load that document; place the desired guidance text in the fragment itself. Every selected referenced fragment must exist, be nonempty, valid UTF-8, and valid for its host. Exact absence of a project override may select the bundled fallback, but an existing invalid or whitespace-only override fails rather than falling through.

Compilation is startup-only and the compiled tokens remain frozen for that service process. There is no hot reload, prompt editor, API mutation, or UI authoring surface. To change a materialized instance, stop the service, preserve and reconcile its selected role-prompt customizations, ensure all six instance fragments have the intended valid content, and start a genuinely new server process. Existing-config `init` does not install or upgrade these files. This same-format prompt-content reconciliation requires no generated-state reset. An older installed binary without the bundled defaults can use the hooks only after the selected custom role prompts contain the direct includes and all referenced instance fragments have been supplied while stopped.

## One compiler and one discriminated host contract

The production compiler in `src/utils/prompt-api.ts` parses literals, value placeholders, and direct `{{> fragment-id}}` includes. It resolves each include independently, rejects a fragment containing another include, splices literal/value tokens in semantic order, validates the fully composed stream once, and freezes it. Repeated direct references are allowed. There are no arguments, recursion, cycles, conditions, labels, or inheritance.

The closed `PromptHost` variants select both artifact scope and placeholder policy, so callers cannot pair a card name with a contradictory policy. Their value sets are:

- global agent: `vocabularySnippet`
- workflow agent: `contractDescription`
- process: `cardType`
- record-context: `cardType`, exactly one `recordSelection`, and zero or one `recordContent` (counts after fragment expansion)
- record-initializer: `cardType`, `cardId`, `cardTitle`, `nodeId`, `recordName`; inline record data template, not an agent instruction or record-context host

Nodes may declare an ordered finite `record_prompts` array. Each strict entry names
an exact configured own-card `record`, `selection: accepted | effective`,
`presence: required | optional`, and a durable `prompt` declaration. Duplicate
record/view pairs and foreign records reject compilation. The record-context host
uses the same process paths, overrides and direct fragments, but retains frozen
tokens at the workflow owner for runtime substitution. `recordSelection` is a
JSON descriptor with the observed selection, prior known selection or null, and
`initial | changed` reason. `recordContent` is a JSON string, or null for optional
absence/empty selection. Bodies at or below 32768 raw UTF-8 bytes retain their exact
ordinary JSON encoding. Larger bodies use a marked encoded display preview:
`canonicalJson(complete body)` → complete record-prompt outbound redaction →
scalar-safe display head/tail and notice → `canonicalJson(complete previewText)`.
No prepass output is parsed back. Up to 8192 UTF-8 display bytes at each end are
retained; if redaction leaves at most 16384 display bytes, that display appears once
with an explicit no-further-elision notice. Omission counts measure intermediate
display bytes, not raw source offsets or bytes removed by redaction. Final JSON
quoting expands escape spellings; neither 16384 bytes nor the raw threshold is a
total injection/context limit. The notice identifies this lossy encoded display,
forbids decoding its fragments as a record, and supplies the selected projection's
versionless current-record URL. A later normal bounded read selects latest effective
content (possibly a draft), not the excerpt's historical omitted bytes. Omitted
requirements remain requirements; this is not a summary or acceptance evidence.
The separate complete accepted-bootstrap block remains full on every operation,
including with a custom body-bearing brief prompt. Substituted bytes are opaque:
template-looking record data is never retokenized. Required missing selection
fails; no trimming, alternate prompt or body-to-reference fallback exists.

Public record-prompt projection lifts the existing seven text-redaction rules through
exactly this one supplier JSON-string layer, then filters ordinary surrounding prose.
Matched syntax alone is decoded and its shared replacement re-encoded; safe original
bytes and supplier quoting remain. The outbound conversation owner opts in only for
`record_prompt`, including indexed history and retained protected instructions.
The oversized supplier prepass already persists its actual prepared display;
public projection still filters the resulting row and surrounding prose. It does
not reconstruct a current template or record, or recursively decode the preview.
The shared inline owner extends an escape-aware complete double-quoted value only
when actually masking a recognized secret; non-secret/unmodified candidates keep
their conservative scan advancement. Existing outbound callers can consequently
mask formerly exposed escaped-quote suffixes, without new secret categories.

The supplier reads the union of mandatory accepted bootstrap and declared inputs
once per distinct record. All views, descriptors and bodies derive from those
same reads. Conditional comparison uses the pre-batch actual conversation facts
keyed by card/record/view, not node or prompt site. Unknown or changed semantic
selection fires; metadata/slice knowledge of B suppresses a false A→B prompt, and
historical A does not regress B. Same-agent new nodes do not force first prompts;
distinct conversations have independent knowledge. Head-only changes do not
change semantic selection. Actual prompt bytes and needed preparation descriptors
publish in one ordered envelope, with no record reread after comparison.

All shipped templates declare reference-only accepted-bootstrap guidance and
effective/optional body-bearing inputs for each node's own record requirements.
These inputs are data, not write permission or acceptance. Template changes do not
constitute record changes or replay old prompt occurrences; indispensable new-node
procedure belongs in the always-prepared node text.

Typed record observation descriptors are separate from prompt text: owning current
metadata/slice/full reads and known mutation results can advance selection knowledge
without preserving a body. Immutable historical reads do not advance that knowledge.
Conversation 11 required facts retain the latest descriptor per card/record/view in
source order, independently of instruction protection. Durable `record_prompt` rows
retain actual rendered text and declaration provenance; false without a key retains
every occurrence, while an exact key selects the latest occurrence even in a newer
suffix. Descriptor-only `record_observation` rows are structural evidence, not a
protected copy or reconstruction of a prepared body.
Raw-oversized body prompts carry `exposure:{kind:'excerpt'}`, including displays
that fit after redaction. This is neither a contiguous source slice nor complete
body exposure; absent/empty selections cannot carry it. Source hashes/head/revision
still identify the selected source, not a byte commitment to the transformed text.
Small-body prompts and separate full-bootstrap observations remain full-body.
Primary composition and summary orientation separately project latest descriptor
facts with actual source/exposure attribution, independently of protected prompt
text. Primary, summary orientation and summary-source projection preserve the
surviving newest-occurrence order, including inherited facts overridden by the
suffix (A1, B1, A2 becomes B1, A2), not first-key insertion or revision/time order.
This claims neither retained body bytes nor delivery, recall or currentness.

Unknown or host-inapplicable placeholders fail startup. Every effective workflow-agent system prompt contains `{{contractDescription}}` exactly once after fragment expansion. The Analyst, process and record-initializer hosts reject that value. Validation is structural, not semantic policing of authored prose: generated node contracts and actual tool/result schemas remain authoritative. Authors must review custom instructions for stale or contradictory advice; Saivage never rewrites overrides or supplies compatibility fallback. Agent/process instructions do not admit `toolList`, `projectContext`, `cardId`, `cardTitle` or `cardBrief`: tools, project orientation and card data arrive as typed dynamic context. The initializer-only cardId/cardTitle substitutions above render stored record data, not agent prompts.

## Compiled artifacts and runtime use

### Node-entry record templates produce data, not prompt authority

Optional `records.<name>.initialization:{format_version:1,template}` belongs to the
complete owning card type. Nodes independently select `initialize_records`.
The existing tokenizer/compiler admits only the narrow initializer values above,
plus direct fragment includes resolved through normal card/shared lookup and
artifact closure accounting. Nested includes, malformed/unavailable macros and
arbitrary paths fail. `${NAME}` remains literal in the exact owning template field
and fragment text; substitutions are not reparsed. `{{...}}` is syntax, not silently
preserved data. No recordSelection/body, contractDescription, tool/provider or env
authority is available. Full prompt assembly/retention does not apply. See the
[entry/eligibility contract](../spec/system-specification.md) and
[configuration procedure](../runbook/index.md#optional-record-scaffolds).

Actual selected entry renders only after exact head absence is established and
publishes current-only baseline0. Existing heads, even empty-after-discard, do not
invoke the renderer. Explicit clean is separate: opening baseline yields draft0
for1; otherwise clean opens empty for the next accepted document. Ordinary effective
reads and the same-read conditional supplier expose baseline/draft version/target.
Accepted-only suppliers still select accepted backing or absence. The shared
`changed-record-with-body` host quotes the selected body as JSON data and distinguishes
starter data from authored drafts and independent accepted evidence. Always-prepared
role/node instructions and generated gates still own today's task, scope and outcome;
the starter is not acceptance, an agent write, progress or mandatory headings.
Bundled classic/classic-typed/paad-typed status starters ask for a brief-relative current
assessment, evidence and remaining work without duplicating a full example at each
node. Existing status-purpose guidance and substantive deliverable obligations remain.
The generated node contract supplies shared lifecycle/gate direction to every
workflow role in all three profiles. Role guidance keeps reusable current URLs
without assuming the first author write sees an absent record; meaningful
completion remains brief/evidence-relative, not a template fingerprint or version
increment. No instruction moves to initialization-only memory.

Initial/changed selection uses ordinary conversation knowledge, not an extra feed
or guaranteed refresh: unchanged re-entry need not repeat a conditional row. Actual
record-prompt text retains its declaration's policy; descriptor-only facts preserve
recorded baseline/draft-target/backing distinctions after compaction, never omitted bodies or
today's template. Later edits/config replacement cannot rewrite old observations.
Roles and node context remain always prepared across continuation and fresh nodes;
no instruction moves to init-only memory and no retention/feeding policy changes.
Creation-time seeding/preview remains deferred. Existing instance YAML and selected
materialized/custom hosts require deliberate authorized stopped reconciliation and
new-process compilation, not existing-config init or hot reload; the head3/accepted3/conversation12
cutover independently requires incompatible-adoption authorization.

### Compilation and preparation

`compileProjectWorkflows()` owns exact root/scope selection and fragment reads. It compiles each selected agent template once. Process templates render raw `cardType` eagerly and are stored as final frozen non-empty text. Source edits after compilation cannot affect the artifact.

`PromptTemplateRegistry` stores the selected global Analyst and Oversight entries and card-type workflow entries structurally separately and substitutes runtime variables into already-compiled agent tokens without re-tokenization. The rendered agent instruction is the singular static instruction prefix of the prepared invocation; its generated node outcome contract is supplied through `contractDescription`, and provider tool-definition bytes plus terminal names complete the immutable prefix. At each submission or check, the existing Analyst/Oversight preparation owner supplies `vocabularySnippet`: card status, reopenable and target status, selected compiled card types, and urgency. Selected tool contracts, not vocabulary, determine authority. Recorded role text remains historical fact and is not regenerated when vocabulary changes. Analyst's bounded project orientation is a typed activation-local context block, not prompt content.

Card-node preparation separates `stableBlocks` from per-logical-operation `recordBlocks`; their ordered accessor composes stable blocks first, then record blocks, without storing another combined array. Stable context contains canonical `{cardId,cardType,title}` orientation and the complete selected current-node prompt, never a frozen bootstrap body. Prefix, tools and stable blocks remain continuous across the node's continuations. Named role/node fields produce the historical activation evidence without positional block lookup. The compiled node—not prior transcript placement, lifecycle status or summary prose—selects the current step.

`AgentExecutor` appends nonempty selected inputs through one common transition
message after route-specific predecessor/recovery facts and any configured prompt.
Notification/reviewer context still precedes these rows. Empty inputs add no row;
action observations and agent preludes do not serialize another input object.
Original field names govern outbound scalar/list-element filtering before JSON
quoting; this is a display copy, never mutation of admitted inputs or accepted
predecessor values. The message is ordinary compactable user text, without
workflow-instruction provenance or required-fact promotion. An uncovered suffix
retains it verbatim; covered text is ordinary summary material and may be omitted.
No synthetic reappend follows compaction. A fresh entry resolves fresh inputs;
full current accepted requirements remain the separate per-operation supplier.

At each newly armed initial, tool or corrective logical operation, the deferred raw callback first checks its exact captured invocation lease. Then the LLM owner consumes current conversation knowledge and calls the node-bound synchronous bootstrap supplier. One exact owning record read selects the complete current accepted bootstrap, identity and full-body exposure; required missing acceptance fails before compaction/admission/provider work. Descriptor-only preparation evidence is appended when the latest actual observation does not already represent that exact identity/exposure. No body is stored in that row. Current bootstrap is supplied outside historical compaction on every operation even when the descriptor append is deduplicated. A new operation may replace A with B; preventive/local/authoritative compaction, pinned retry and admitted-byte transport retain that operation's captured blocks unchanged. There is no refresh during recovery or current-at-transport guarantee. Globals retain their ordinary stable preparation with no automatic bootstrap supplier.

Current-node text is request context and is not appended as an ordinary conversation row. The existing activation marker records the rendered role instruction and exact frozen full node block once as structural evidence, not context fed back to the model. Existing unmarked node-looking rows remain unchanged ordinary history and are neither recognized nor suppressed. Lifecycle-entry, configured edge/pending-notification and correction prompt producers positively mark their existing user text/model-repair rows with `instruction_origin:'workflow_prompt'`. This display provenance changes no role, content, delivery, protection or append count; transition preludes, notification bodies and diagnostics remain unmarked. Summary prose never inherits this tag. Lifecycle-entry, edge, transition-handoff, correction, notification, and recovery context keeps its existing durable producer position. A transition handoff is delivered once, but its accepted facts, immutable record URLs, and still-applicable requirements do not expire merely because delivery is not repeated.

Card/record evidence is retained ordinary/accepted predecessor content, not every mutation revision. Current readers and mutation results remain observational: use reusable `current_url` for the next mutation, never an immutable acceptance URL; drafts have no immutable locator. Dedicated immutable readers require exact sparse ordinary card versions or consecutive accepted record document versions from immutable record URLs and return exact ordinary/accepted locators, with absent selectors reported not found. Accepted provenance preserves observed card mutation revision separately from its ordinary historical link. Notification context already published to conversation remains independently readable; pending pointers are current-only and delivery may repeat after interruption. Do not infer a queue audit, physical erasure or startup/check-once certificate.

The composition projector is the single request-composition boundary. Its provider conversion places one concise system provenance boundary after prepared blocks and before any historical/current conversation suffix. Only accumulated history receives a summary header identifying its exact source segment version and covered-through message ID. These coordinates delimit the accumulated prefix, not a completeness guarantee about prose or a claim that every fact originated in that segment. Summary state and authorization claims describe that prefix, not necessarily the current head: later continuation may supersede them, while still-applicable requirements remain binding. Summary/replay grants no new approval or execution. Genesis creation time is not a historical cutoff date. At the direct canonical branch, successful current process results are strictly accepted and copied for the primary audience: each done+complete stream loses only its URL and every successful copy is canonically serialized with its copied hash updated. Prepared blocks and retained instructions are unchanged. Summarizer requests instead retain the exact durable URL-bearing process bytes as source alongside prepared blocks, inherited history, and other new source. Chat, Responses, and Codex serialize the same ordered primary items; adapters add no authority rules. Shared ordinary/corrective guidance describes status, grants and restrictions relative only to inherited history and the currently supplied labeled byte ranges, not unseen split-source portions, retained continuation or prepared orientation. It preserves attribution, scope, subsequent changes, applicable obligations, actual work, uncertainty and evidence; distinguishes proposed from executed and draft from accepted/approved; and does not treat a final successful newline-separated shell command as proof that earlier commands passed (`pipefail` concerns pipelines).

Participant discovery for preparation and reserve validation traverses every node in every selected compiled graph, including typed-graph nodes, rather than deriving participation from default role names, classic graphs, or this prompt-file inventory.

Each shipped template retains one shared Planner system-prompt artifact selected for both `project` and `goal`. Its prose interprets the separately supplied frozen `cardType`: project Planner owns coherent strategy through complete evidenced acceptance, while goal Planner owns local decomposition, coordination, and repair within its delegated outcome. The distinction is not a workflow-agent placeholder—`contractDescription` remains that host's only value—and needs no card-specific Planner artifact, specialized fragment, selector, role classifier, or agent. Typed review-to-plan remains the concrete accepted-review revision handoff. Typed architecture uses the shared Reviewer with node-owned component and system scope; immutable versioned review URLs let each Reviewer node start a clean cycle of the same record without a specialized agent template.

The always-prepared roles own reusable work methods and authority: Planner strategy, delegation and direct-child repair; Executor scoped work, evidence interpretation and current status-record mechanics; Reviewer independent inspection and current review-record mechanics; Analyst request resolution and permitted inspection/control; Oversight bounded diagnosis, useful advice and successful no-action. Conditional image/MCP guidance follows task and authority; selected tool definitions own their parameter and command-output mechanics. Analyst card-pagination mechanics live in the selected `get_card` and `get_card_version` definitions; the role retains the distinction between historical child membership and current liveness. No direction relies on init-only model memory.

Shared Planner and Executor own brief-relative current status authorship in all profiles. Conversation is the work history, not a timeline to relocate into a separate log/history record or document; actual deliverables and necessary primary evidence still belong in permitted work products and records. They consolidate superseded current sections rather than prepend continuation accounts, distinguishing actual delivery, proposals/in-progress work, acceptance and remaining actions. Material decisions, blockers, uncertainty, partial/failed checks and exact source/artifact identities with evidence applicability remain explicit; existing work products and retained accepted history hold supporting detail, not an undisclosed backlog. Current resource ownership, unresolved effects and applicable cumulative accounting remain explicit when needed for current conclusions or safe continuation; consolidation neither confirms release/cleanup nor restarts an accounting period. Nodes supply scoped evidence deltas, diagnoses, classifications and required substantive deliverables; concise status does not replace that work or erase a failed check because another input passed. No quota, fixed template, new acceptance gate or artifact-per-action rule is introduced. Reviewer still independently inspects evidence and owns `review.md`, not `status.md`. This changes authoring prose only, not composition, delivery, compaction, record/history semantics or durable formats.

New config-absent init receives these packaged role and node bytes. Existing materialized/custom prompts do not auto-upgrade: adoption requires separately authorized stopped reconciliation of the actual selected Planner/Executor and affected node/handoff hosts, preserving project custom guidance, then a genuinely new process. Source completion authorizes no installed-project inspection or reconciliation; see [operator cutover](#runtime-invariants-and-operator-cutover).

Accepted-review notification handling deliberately retains two complementary artifacts in the unchanged compiled closure. The durable `review-to-notifications` edge owns historical framing and carries accepted summary and immutable versioned review evidence, not a rejection. The separately prepared `handle-notifications` destination owns current action, mandatory status update, and re-review; its body is not part of transition context. Shared Reviewer owns independent inspection and representative-family method, while specialized planning and architecture nodes own subtree, component, or system scope.

Current nodes own the scoped task, evidence and outcome meaning. Classic planning coordinates remaining work before evidenced completion or review, and classic execute satisfies its brief with relevant verification, including justified no-change. Typed nodes retain reproduction-before-repair, verification-owned acceptance, informed retry/exhaustion, research classification and exhaustive outstanding scope, data technical-versus-policy boundaries, and renewed architecture component/system review after notification return. Handoffs preserve accepted findings, classification, immutable citations and outstanding obligations rather than prescribing the destination's whole task again. Correction hosts use the supplied violations and remaining attempts to repair the result or required records; they do not indiscriminately redo delivery.

Planner policy preserves required scope and distinguishes bounded research delivery, implementation, evidence promotion and project acceptance. Retrying the same blocker needs a material input, decision, correction or different approach. Root acts on direct goals and leaves grandchild repair to the goal Planner; configured capability restrictions remain binding. Executor evidence remains reusable only while relevant inputs are unchanged and it applies to current criteria; later successes do not erase earlier failed or unresolved checks. The code refactor handoff preserves accepted green/already-green evidence: cleanup requires applicable checks, while a reasoned no-cleanup decision may reuse applicable recent evidence unless current criteria require a rerun. These are composed instruction policies, not new runtime gates, workflow state or admission mechanisms.

Typed test nodes distinguish actionable missing assertions, concrete verified failures and unfinished assigned investigation. Verify owns remaining source/control/caller inspection and acceptance reconciliation against the agreed input and brief-relative required items; passing tests settle only applicable checks. Supported acceptance, concrete defects and precise evidence limits are dispositions, not a fixed output template or permission to waive mandatory checks or turn non-goals into new gates. Re-entry adjudicates actual combined repaired input with exact provenance, reusing applicable settled items and inspecting affected changes rather than restarting unrelated review or testing obsolete input plus an overlay.

Shared Executor distinguishes authorized repair from a specifically independent assessment: author checks are not independent approval. Only the four prepared typed test nodes own the additional truthful BLOCKED reasons for assignment/correction requiring another owner and applicable explicit owner reassignment, alongside unavailable required input. A mistaken coverage handoff without a missing assertion returns the precise needed Planner correction, not no-op coverage success. Otherwise unfinished permitted investigation continues in its current node. Shared roles supply no new blocking reason to classic execute, typed data/code or notification handlers; Planner recognition of a test child's handoff does not change its own result criteria. Planner waits for the actual child activation result, not notification delivery, resolves the mismatch through existing direct-child authority, and gives fresh agreed input and remaining decisions on reactivation. A supported owner return does not require exhausting further technically possible work.

These responsibilities reside in always-prepared roles/current nodes; one-time edges carry accepted historical evidence and task deltas, not infallible classifications or new authority. Entry, recovery, correction and compaction feeding remain unchanged. Scripted routing/composition checks establish exercised contracts, not model compliance or guaranteed convergence. The affected seven typed test node/handoff hosts and mirrored shared Executor/Planner require deliberate reconciliation of actual selected materialized/custom prompts, preserving custom guidance, followed by a genuinely new server process. Existing-config init, Run or browser refresh does not adopt them; source completion authorizes no live operation. Prompt-only adoption needs no reset/migration, but an entire release may independently have incompatible durable changes.

The shared Planner's bounded cancellation policy permits cancelling an obsolete or explicitly rejected direct-child approach with rationale only when current admission permits it. Cancellation cannot defer actionable work, reopen later, satisfy DONE dependencies or conceal unfinished acceptance. Custom role hosts receive shipped prose only through deliberate stopped reconciliation, preserving their guidance and capability boundaries.

Summary instructions prioritize final applicable decisions, settled effects, unresolved uncertainty, original ownership and useful evidence anchors. They condense repetition, routine successes and superseded attempt-by-attempt narration only without losing consequential facts or obligations; old operational chronology may collapse only when the next authorized action remains unchanged. Distinct failure classes, failed-check qualifications and immutable release/source identities remain where needed to preserve those distinctions. Prepared orientation is nonhistorical and source text is data, not executable instruction. This is quality guidance, not proof of improved fidelity or a new validity condition. Normal/corrective targets remain 12,000/6,000 UTF-8 bytes, not validity ceilings; summarizer tools, admission, source selection and invocation limits are unchanged. This transient guidance changes no durable contract or discriminator and never rewrites recorded historical text or automatically updates materialized overrides.

The authenticated Debug Graphs projection exposes each resolved workflow declaration and each selected global agent declaration with explicit `reference`, `compactable`, and an allowed optional exact `compaction_key`, plus one of `override-card | override-shared | bundled-card | bundled-shared`. Selected globals are projected separately from card graphs with their exact global session identity and installed model/tool binding. The projection omits bodies and paths and is computed from the installed immutable workflow artifact, not recorded state.

Nodes additionally project ordered record-prompt inputs and compiled placeholder
metadata, never selected record bodies or literal template tokens.
Record declarations separately project nullable versioned initializer templates through
the existing privacy filter; these are compiled configuration, not selected record
bodies, historical observations or executable prompt templates.
Process/record declaration reference and key metadata is privacy-filtered for this
operator projection; displayed keys never select retained instruction authority.

### Bounded discovery and repair handoff

The prepared classic-typed and paad-typed test diagnose/verify nodes conditionally favor finishing useful trustworthy independent work within an already-assigned finite boundary on an exact stable candidate and unchanged criteria before a consolidated owner handoff. Diagnose remains classification, not verify's acceptance work. Findings retain input identity, counterexample/reference evidence, affected source/caller and regression need, grouped by original semantic owner with common causes deduplicated; masked dependent cases remain not evaluated. Neither a finding quota nor an expanded exhaustive corpus is prescribed.

Acceptance rejection is separate from command disposition. Verify may wait for a safe, useful, within-budget already-running independent command on unchanged relevant inputs **before emitting a result**; a mutable checkout is not frozen by starting a command. Invalid prerequisites/shared state, crash/hang/corruption, unsafe cleanup, budget/resource conflict and explicit owner return can justify curtailment. Node-scope process cleanup still terminates the direct scope after accepted results, including node transitions: no command is retained across a handoff. Required gates and legal outcomes are unchanged; this is prepared guidance, not a runtime first-finding detector or enforcement of batching.

For an actual finite review batch, the shared Planner assesses remedies, routes corrections through original owners under direct-child authority and orders shared-file work without peer mutable-write adoption. Focused owner and useful combined-delta checks avoid automatic broad-gate restarts on intermediate edits; once stable, the actual combined input needs independent non-author adjudication of affected items and every required regression/package/acceptance gate. Applicable unchanged settled evidence remains reusable, never stale acceptance. Classic receives this parent guidance but retains its one-node Executor and narrower outcomes; PAAD retains its five intentional deltas. No extra Reviewer-role gate or mandatory review for direct completion is introduced.

These seven bundled hosts (two test nodes in each typed profile and Planner in all three profiles) affect new compilation only where selected. Existing materialized/custom prompts need separately authorized stopped reconciliation preserving customization, then a fresh process; init never upgrades them. No adoption, historical reinterpretation, retention or durable-format change follows source completion. Scripted runtime/composition evidence demonstrates feasibility under scripted choices, not model compliance, incident causality or measured savings.

### Simplicity within existing role decisions

The four shared Planner, Executor, Reviewer and Oversight methods in all three
profiles favor the simplest coherent approach meeting actual requirements.
Planner assesses an evidenced defect separately from its proposed remedy, rejects
speculative expansion, and rederives simpler alternatives at real design/revision
choices, including choices still open before proceeding on an approved approach.
Existing code, sunk cost and reviewer agreement do not establish necessity;
removing an introduced mechanism may be better than repairing its interactions.
Ordinary scoped engineering choices remain autonomous; stronger product guarantees
or weaker explicit requirements need the requirement owner's decision.

Executor applies this method to code and design, distinguishing correctness and
safety from optional availability, diagnostic precision and rare-failure recovery.
Explicit failure at an appropriate safe boundary, pre-admission capacity rejection
or omission of optional oversized diagnostics may suffice. Actual failures and
known/possible/unknown effects, owned-resource identity/cleanup, independent
disposal/control, authentication/authorization and confidentiality remain binding.
Ordinary contention does not justify cross-session destruction; uncertainty grants
no replay or false success. Checks belong at actual trust/consumption boundaries,
not in machinery for impossible or unhandleable internal states. Focused useful
verification does not justify complicating production architecture for tests.

Reviewer separates violated requirements and concrete impact from recommendations,
proposes the simplest sufficient correction and distinguishes required fixes from
suggestions without waiving any assigned or exhaustive criterion. Oversight may
recognize evidenced non-progress cycles sustaining unnecessary machinery and advise
Planner to reconsider its need; it gains no complexity patrol, strategy authority
or review gate. Successful no-action and reasoned disagreement remain legitimate.
Existing unfinished-investigation ownership, supported early returns, bounded
discovery/throughput and exact-input evidence qualifications remain unchanged.

This is consolidated role instruction policy, not a new checklist, outcome,
runtime enforcement mechanism or measured model-quality result. Nodes and handoffs
retain their scoped tasks and historical evidence; no method moves to init-only
memory or conditional records. Feeding, continuation/re-entry, compaction and
retention are unchanged. Recorded old role/edge bytes remain historical facts;
no durable contract or discriminator changes. New config-absent init receives the
packaged text. Existing materialized/custom prompts need separately authorized
stopped reconciliation of the actual selected four role hosts, preserving
customization, then a genuinely new process. Existing-config init, Run and browser
refresh do not adopt it; source completion authorizes no live action or whole-release
compatibility claim. PAAD retains its five intentional differences and attribution.

### Illustrative status consolidation

**Illustrative facts and paths, not executed checks or runtime evidence; not a required format.** Both versions use only this supplied scenario: the accepted brief requires CSV export and a successful retry round-trip on source X, followed by independent review. Export is implemented on X, but its retry round-trip failed; the primary failed-check report is `reports/export-X-failed.txt`. Review remains outstanding. The task-owned worker remains allocated for the retry investigation, with no confirmed release.

Before (activity inventory):

```markdown
Implemented CSV export on X. Ran retry round-trip; failed (reports/export-X-failed.txt). Still need the brief's successful retry round-trip on X and independent review. Kept the task-owned worker allocated to investigate; no release confirmed. Updated status again.
```

After (same supplied facts, current assessment):

```markdown
CSV export is implemented on source X, not yet accepted: retry round-trip still fails ([failed check](reports/export-X-failed.txt)). Fix retry handling and verify the required round-trip on X before independent review. The task-owned worker remains allocated for that investigation; no release is confirmed.
```

## Dedicated file-tool preference

The five shared role prompts in all profiles own capability-conditioned file-work method, not the neutral project-guidance hooks or individual nodes. For authorized work, prefer selected `read`, `glob` and `grep` for inspection/search; Planner/Reviewer prefer selected `write`/`edit` for permitted changes, and Analyst additionally names `apply_patch`. Executor prefers available `apply_patch` for deliberate source edits over shell replacements or heredoc source rewrites in `run_command`, retaining appropriate selected `write`/`edit` use, including permitted record work. Prefer small, reviewable edits over unnecessary whole-file rewrites. Oversight remains inspection-only. A renamed custom agent selecting a shipped role reference receives that prose, subject to its actual selected tools; an independent custom reference inherits none of it automatically.

Within role authority, `run_command` remains appropriate for builds, tests, Git, external commands, generators, legitimate pipelines and operations dedicated tools cannot reasonably serve. Analyst still cannot perform delivery work, mutate source through shell, deploy or run delivery builds/tests. No unsuitable-tool attempt or explanation for every choice is required. Failure/conflict alone grants no shell bypass of tool contracts, permissions or record-write rules. Current `record:///` write/edit authority, invocation-final classified failures, publication-uncertainty fatality and confidentiality remain unchanged. Native absolute read/discovery support does not expand mutation authority; selected tool definitions own arguments, paths and result contracts.

The shared Executor alone also owns authorized Git-delivery method: prefer standard high-level operations and simple permitted isolation, not ad-hoc plumbing or custom alternate-index integration. Owned delivered paths, including additions, must be synchronized in the delivery checkout and its real index with the delivered revision; ref advancement or isolated passing commits do not establish a usable combined delivery. Verify that actual combined revision with applicable checks, preserving unrelated dirty work/staging and surfacing concrete conflicts instead of broad reset/overwrite. Read-only plumbing and vetted tooling remain permitted within existing authority. This grants no Git/workspace authority, universal commit obligation or new BLOCKED reason; independent assessment stays assessment, and unchanged applicable evidence remains reusable under the existing rule.

This is instruction policy, not a runtime acceptance gate, enforcement or evidence of model compliance. The prepared role, generated contract, selected tools and current-node context remain available over continuation and compaction; fresh node/session preparation selects the same compiled role. No feeding, retention or durable contract changes. New config-absent init receives packaged guidance; materialized overrides and independent custom references require separately authorized stopped reconciliation of actual selected hosts, preserving customizations, then a genuinely new server process. Existing-config init, Run and browser refresh do not upgrade prompts; source completion authorizes no installed changes.

## Runtime invariants and operator cutover

- Prompt/config reads happen only during startup structural compilation.
- Reconfigure is validation-only; changing prompts requires restart.
- There is no fallback after any error except exact absence.
- There is no workflow-family map or runtime prompt selection; templates are consulted only by `init`, never at runtime.
- Old path forms and agent-name-keyed overrides are not read, moved, warned about, or normalized.
- A fresh `saivage init [--profile <name>]` on a config-absent project materializes the selected template's complete closure; a materialized instance is upgrade-independent by construction because its override tree resolves every reference at the override tier. Hand-authored typed-graph configs carry their typed-only prompt files in `.saivage/config/prompts` (one-time copy from the classic-typed template's tree) because the bundled root contains only the classic template's compiled source closure.
- Operators stop the service, manually reconcile the selected materialized overrides while preserving customizations, then start a genuinely new server process. Project Stop/Run, pause/resume, and browser refresh do not compile prompt changes.
- Producer-declared compaction policy uses strict object declarations and current conversation format12, with the fresh [11→12 record-document cutover](./durable-format-changes.md#record-document-0-and-selected-node-templates-2026-10-18), retaining earlier excerpt and instruction-evidence contracts. Incompatible adoption follows the [runbook reset/external-migration decision](../runbook/index.md#external-migrations); no runtime converter or adoption permission follows source completion. Earlier cutovers are historical provenance, not supported formats. Declaration-based protection applies to eligible durable entry, edge, pending-notification, correction and record-prompt occurrences. Structural prepared role/node evidence adds no durable model-context occurrence, changes no static/node delivery according to a declaration flag, and is not carried into compacted genesis; inspect its exact indexed source history instead. Record observation facts retain descriptors independently, never those historical instruction strings.

## Key source files

| File | Responsibility |
| --- | --- |
| `src/runtime/card-process/card-process-config.ts` | roots, exact selection, fragment reads, workflow compilation, eager process rendering |
| `src/utils/prompt-api.ts` | singular tokenizer/compiler, composition, discriminated host/placeholder policy, rendering, structurally scoped agent registry |
| `src/runtime/actors/agent-executor.ts` | agent preparation, exact-workflow process-text consumption and transition composition |
| `src/runtime/actors/node-execution.ts` | shared execution and typed input resolution |
| `src/application/runtime-composition.ts` | runtime wiring |
| `src/config/system-templates/<name>/prompts/**` | per-template bundled tree equal to that template's exact compiler-observed source closure, including the six shared project-guidance fragments and all process prompts selected by that template |
| `scripts/copy-system-template-prompts.js` | per-template standalone closure validation and copy to `dist/src/config/system-templates/<name>/prompts/` |
:::
