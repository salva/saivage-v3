# Prompt handling

This in-depth companion to [System architecture](./system-architecture.md) and [System specification](../spec/system-specification.md) explains prompt discovery, validation, rendering, and runtime use. Saivage has no prompt editor, hot reload, manifest, runtime selection, or prompt-builder framework. Prompt handling is deterministic and startup-only; actors consume immutable compiled artifacts.

::: v-pre
## Purposes and layout

| Channel | Owner and lifetime | Authority / evidence |
| --- | --- | --- |
| Role, generated outcome/tools, node, card orientation | Startup compiler and node preparation; stable through this node | Present method/task and permitted effects, not init-only memory |
| Parent direction | Exact Supervisor parent relationship; entire actual child activation | Advisory direction with trusted invocation provenance; no grandchild inheritance |
| Current accepted bootstrap / declared record inputs | Synchronous node-bound supplier at each new logical primary operation | Same-read current requirement snapshot; retained through that operation's maintenance/retries |
| Conditional record prompt | Same supplier, compared against pre-existing conversation record/view knowledge | Actual rendered occurrence; declaration-controlled instruction retention |
| Entries, accepted edges, correction, notifications | Existing event/result/recipient owner; once per actual occurrence | Attributed facts, immutable evidence and scoped direction, not current-node selection |
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

Agent prompts become provider static instructions. Process prompts are startup-compiled operational context: the actual current node's prompt is frozen as prepared request context, while lifecycle-entry, correction, configured non-terminal-edge, and pending-notification prompts remain durable conversation context at their producer-owned positions. Each consuming declaration owns its compaction policy; shared prompt text remains policy-free. Fragments are not prompts; they are directly included pieces compiled under the host prompt's policy.

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

The project override root is `.saivage/config/prompts`; each registered system template owns its own bundled source tree under `src/config/system-templates/<name>/prompts/`, and packaging copies each tree per-template under `dist/src/config/system-templates/<name>/prompts/`. Packaging compiles each registered template standalone against its own source prompts root, observes every selected bundled agent, process, and direct-fragment artifact, and requires the physical source and copied output trees to equal that template's compiled closure exactly. There is no union tree, runtime discovery, or separately maintained numeric file count. Before copying shipped templates, packaging checks compiler-derived classic/classic-typed shared agent/fragment membership and byte parity, plus common-path shared process byte parity; typed-only process paths remain permitted. Generic per-template copying remains independent of that explicit family policy. Both shipped closures contain five shared agent prompts and six shared project-guidance fragments, including Oversight, plus all process prompts selected by their graphs. `classic-typed` additionally contains its selected typed card-specific process prompts and architecture notification-return prompt. Neither tree has a template-specific agent prompt. `saivage init --profile <name>` materializes the selected template's complete closure into a config-absent project override root, after which the instance owns its prompts; with an existing config, init preserves the prompt tree, marker, and YAML and performs no template upgrade.

Typed-only process hosts cover specialized planning (`specialized-plan`, `specialized-review`, `specialized-recover` and their review handoffs); code reproduction, repair, refactor and evidence/retry handoffs; test diagnosis, coverage, repair and verification; research exploration, assessment and reporting; data schema, validation and implementation; and architecture drafting, component/system review, revision handoffs and `architecture-notifications-to-draft`. The compiler-observed closure, not a maintained numeric total, owns the complete inventory. Each reference maps to `<reference>.md` under its shared or card-specific process directory.

## Selection and references

For a card host, exact lookup order is:

1. project `<purpose>/<card-type>/<reference>.md`
2. project `<purpose>/_shared/<reference>.md`
3. bundled `<purpose>/<card-type>/<reference>.md`
4. bundled `<purpose>/_shared/<reference>.md`

The global Analyst has no card type and checks project shared then bundled shared only. Prompt APIs represent that with `{kind:'global-agent'}`; workflow and process hosts instead carry `{kind,cardType}`. Scope is never encoded by comparing a card name. Consequently a configured card type named `global` follows the complete card-host order above for agents, processes, and fragments and receives workflow/process placeholder policy, while the Analyst remains independent. Only exact `ENOENT` advances. Empty, invalid UTF-8, directory, unreadable, malformed, or otherwise failing paths abort compilation. Selection never enumerates directories.

`agents.<agent-name>.prompt` is the strict declaration `{reference,compactable?}` at every agent tier. `reference` is the filename reference and omitted `compactable` resolves to `true`. Static agent and node declarations accept explicit true or false but never `compaction_key`; their policy does not change delivery or create durable model-context occurrences. Once-per-activation structural prepared-instruction evidence is distinct and never becomes model context or protected instruction authority. Agent name remains runtime/session identity, not a file key. Agents sharing a prompt reference share the same applicable override; independent override content requires distinct configured references. This is a breaking no-compatibility contract.

Every process node likewise declares `prompt:{reference,compactable?}` and `correction_prompt:{reference,compactable?,compaction_key?}`. Lifecycle entries, nonterminal edge prompts, and pending-notification prompts use the durable declaration shape. At durable sites omitted/true means ordinary compactable content and forbids a key; false without a key retains every occurrence; false with a nonempty exact key retains only the latest occurrence of that key and releases the older occurrence into the next successful compaction summary. Keys are exact, including whitespace, and are neither trimmed nor synthesized. Policy belongs to the consuming declaration, so two sites may share one reference while choosing different retention.

```yaml
agents:
  executor:
    prompt: { reference: executor, compactable: false }
card_types:
  code:
    workflow:
      entries:
        STOPPED:
          node: red
          prompt: { reference: stopped-recovery }
      nodes:
        red:
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

Nodes may declare an ordered finite `record_prompts` array. Each strict entry names
an exact configured own-card `record`, `selection: accepted | effective`,
`presence: required | optional`, and a durable `prompt` declaration. Duplicate
record/view pairs and foreign records reject compilation. The record-context host
uses the same process paths, overrides and direct fragments, but retains frozen
tokens at the workflow owner for runtime substitution. `recordSelection` is a
JSON descriptor with the observed selection, prior known selection or null, and
`initial | changed` reason. `recordContent` is the complete selected body as a JSON
string, or null for optional absence/empty selection. Substituted bytes are opaque:
template-looking record data is never retokenized. Required missing selection
fails; no trimming, alternate prompt or body-to-reference fallback exists.

Public record-prompt projection lifts the existing seven text-redaction rules through
exactly this one supplier JSON-string layer, then filters ordinary surrounding prose.
Matched syntax alone is decoded and its shared replacement re-encoded; safe original
bytes and supplier quoting remain. The outbound conversation owner opts in only for
`record_prompt`, including indexed history and retained protected instructions.
Canonical/model-context text stays opaque and unchanged, with no current-template
reconstruction, general decoder or prompt-language restriction.

The supplier reads the union of mandatory accepted bootstrap and declared inputs
once per distinct record. All views, descriptors and bodies derive from those
same reads. Conditional comparison uses the pre-batch actual conversation facts
keyed by card/record/view, not node or prompt site. Unknown or changed semantic
selection fires; metadata/slice knowledge of B suppresses a false A→B prompt, and
historical A does not regress B. Same-agent new nodes do not force first prompts;
distinct conversations have independent knowledge. Head-only changes do not
change semantic selection. Actual prompt bytes and needed preparation descriptors
publish in one ordered envelope, with no record reread after comparison.

Both shipped templates declare reference-only accepted-bootstrap guidance and
effective/optional body-bearing inputs for each node's own record requirements.
These inputs are data, not write permission or acceptance. Template changes do not
constitute record changes or replay old prompt occurrences; indispensable new-node
procedure belongs in the always-prepared node text.

Typed record observation descriptors are separate from prompt text: owning current
metadata/slice/full reads and known mutation results can advance selection knowledge
without preserving a body. Immutable historical reads do not advance that knowledge.
Conversation 9 required facts retain the latest descriptor per card/record/view in
source order, independently of instruction protection. Durable `record_prompt` rows
retain actual rendered text and declaration provenance; false without a key retains
every occurrence, while an exact key selects the latest occurrence even in a newer
suffix. Descriptor-only `record_observation` rows are structural evidence, not a
protected copy or reconstruction of a prepared body.
Primary composition and summary orientation separately project latest descriptor
facts with actual source/exposure attribution, independently of protected prompt
text. Primary, summary orientation and summary-source projection preserve the
surviving newest-occurrence order, including inherited facts overridden by the
suffix (A1, B1, A2 becomes B1, A2), not first-key insertion or revision/time order.
This claims neither retained body bytes nor delivery, recall or currentness.

Unknown or host-inapplicable placeholders fail startup. Every effective workflow-agent system prompt contains `{{contractDescription}}` exactly once after fragment expansion and passes obsolete fixed-result-directive validation. The Analyst and process hosts reject that value. Old `toolList`, `projectContext`, `cardId`, `cardTitle`, and `cardBrief` placeholders do not exist: tools, project orientation, and card data are typed dynamic context, never rendered prompt variables.

## Compiled artifacts and runtime use

`compileProjectWorkflows()` owns exact root/scope selection and fragment reads. It compiles each selected agent template once. Process templates render raw `cardType` eagerly and are stored as final frozen non-empty text. Source edits after compilation cannot affect the artifact.

`PromptTemplateRegistry` stores the selected global Analyst and Oversight entries and card-type workflow entries structurally separately and substitutes runtime variables into already-compiled agent tokens without re-tokenization. The rendered agent instruction is the singular static instruction prefix of the prepared invocation; its generated node outcome contract is supplied through `contractDescription`, and provider tool-definition bytes plus terminal names complete the immutable prefix. Both global hosts supply the selected compiled card-type vocabulary through `vocabularySnippet`; Analyst's bounded project orientation is a typed activation-local context block, not prompt content.

Card-node preparation separates `stableBlocks` from per-logical-operation `recordBlocks`; their ordered accessor composes stable blocks first, then record blocks, without storing another combined array. Stable context contains canonical `{cardId,cardType,title}` orientation and the complete selected current-node prompt, never a frozen bootstrap body. Prefix, tools and stable blocks remain continuous across the node's continuations. Named role/node fields produce the historical activation evidence without positional block lookup. The compiled node—not prior transcript placement, lifecycle status or summary prose—selects the current step.

At each newly armed initial, tool or corrective logical operation, the deferred raw callback first checks its exact captured invocation lease. Then the LLM owner consumes current conversation knowledge and calls the node-bound synchronous bootstrap supplier. One exact owning record read selects the complete current accepted bootstrap, identity and full-body exposure; required missing acceptance fails before compaction/admission/provider work. Descriptor-only preparation evidence is appended when the latest actual observation does not already represent that exact identity/exposure. No body is stored in that row. Current bootstrap is supplied outside historical compaction on every operation even when the descriptor append is deduplicated. A new operation may replace A with B; preventive/local/authoritative compaction, pinned retry and admitted-byte transport retain that operation's captured blocks unchanged. There is no refresh during recovery or current-at-transport guarantee. Globals retain their ordinary stable preparation with no automatic bootstrap supplier.

Current-node text is request context and is not appended as an ordinary conversation row. The existing activation marker records the rendered role instruction and exact frozen full node block once as structural evidence, not context fed back to the model. Existing unmarked node-looking rows remain unchanged ordinary history and are neither recognized nor suppressed. Lifecycle-entry, configured edge/pending-notification and correction prompt producers positively mark their existing user text/model-repair rows with `instruction_origin:'workflow_prompt'`. This display provenance changes no role, content, delivery, protection or append count; transition preludes, notification bodies and diagnostics remain unmarked. Summary prose never inherits this tag. Lifecycle-entry, edge, transition-handoff, correction, notification, and recovery context keeps its existing durable producer position. A transition handoff is delivered once, but its accepted facts, immutable record URLs, and still-applicable requirements do not expire merely because delivery is not repeated.

Card/record evidence is retained ordinary/accepted predecessor content, not every mutation revision. Current readers and mutation results remain observational: use reusable `current_url` for the next mutation, never an immutable acceptance URL; drafts have no immutable locator. Dedicated immutable readers require actual sparse catalog selectors and return exact ordinary/accepted locators, with gaps reported not found. Accepted provenance preserves observed card mutation revision separately from its ordinary historical link. Notification context already published to conversation remains independently readable; pending pointers are current-only and delivery may repeat after interruption. Do not infer a queue audit, physical erasure or startup/check-once certificate.

The composition projector is the single request-composition boundary. Its provider conversion places one concise system provenance boundary after prepared blocks and before any historical/current conversation suffix. Only accumulated history receives a summary header identifying its exact source segment version and covered-through message ID. These coordinates delimit the accumulated prefix, not a completeness guarantee about prose or a claim that every fact originated in that segment. Summary state and authorization claims describe that prefix, not necessarily the current head: later continuation may supersede them, while still-applicable requirements remain binding. Summary/replay grants no new approval or execution. Genesis creation time is not a historical cutoff date. At the direct canonical branch, successful current process results are strictly accepted and copied for the primary audience: each done+complete stream loses only its URL and every successful copy is canonically serialized with its copied hash updated. Prepared blocks and retained instructions are unchanged. Summarizer requests instead retain the exact durable URL-bearing process bytes as source alongside prepared blocks, inherited history, and other new source. Chat, Responses, and Codex serialize the same ordered primary items; adapters add no authority rules. Shared ordinary/corrective guidance describes status, grants and restrictions relative only to inherited history and the currently supplied labeled byte ranges, not unseen split-source portions, retained continuation or prepared orientation. It preserves attribution, scope, subsequent changes, applicable obligations, actual work, uncertainty and evidence; distinguishes proposed from executed and draft from accepted/approved; and does not treat a final successful newline-separated shell command as proof that earlier commands passed (`pipefail` concerns pipelines).

Participant discovery for preparation and reserve validation traverses every node in every selected compiled graph, including typed-graph nodes, rather than deriving participation from default role names, classic graphs, or this prompt-file inventory.

Each shipped template retains one shared Planner system-prompt artifact selected for both `project` and `goal`. Its prose interprets the separately supplied frozen `cardType`: project Planner owns coherent strategy through complete evidenced acceptance, while goal Planner owns local decomposition, coordination, and repair within its delegated outcome. The distinction is not a workflow-agent placeholder—`contractDescription` remains that host's only value—and needs no card-specific Planner artifact, specialized fragment, selector, role classifier, or agent. Typed review-to-plan remains the concrete accepted-review revision handoff. Typed architecture uses the shared Reviewer with node-owned component and system scope; immutable versioned review URLs let each Reviewer node start a clean cycle of the same record without a specialized agent template.

The always-prepared roles own reusable work methods and authority: Planner strategy, delegation and direct-child repair; Executor scoped work, evidence interpretation and current status-record mechanics; Reviewer independent inspection and current review-record mechanics; Analyst request resolution and permitted inspection/control; Oversight bounded diagnosis, useful advice and successful no-action. Conditional image/MCP guidance follows task and authority; selected tool definitions own their parameter and command-output mechanics. No direction relies on init-only model memory.

Shared Planner and Executor own brief-relative current status authorship in both profiles. They consolidate superseded current sections rather than prepend continuation accounts, distinguishing actual delivery, proposals/in-progress work, acceptance and remaining actions. Material decisions, blockers, uncertainty, partial/failed checks and exact source/artifact identities with evidence applicability remain explicit; existing work products and retained accepted history hold supporting detail, not an undisclosed backlog. Nodes supply scoped evidence deltas, diagnoses, classifications and required substantive deliverables; concise status does not replace that work or erase a failed check because another input passed. No quota, fixed template, new acceptance gate or artifact-per-action rule is introduced. Reviewer still independently inspects evidence and owns `review.md`, not `status.md`. This changes authoring prose only, not composition, delivery, compaction, record/history semantics or durable formats.

New config-absent init receives these packaged role and node bytes. Existing materialized/custom prompts do not auto-upgrade: adoption requires separately authorized stopped reconciliation of the actual selected Planner/Executor and affected node/handoff hosts, preserving project custom guidance, then a genuinely new process. Source completion authorizes no installed-project inspection or reconciliation; see [operator cutover](#runtime-invariants-and-operator-cutover).

Accepted-review notification handling deliberately retains two complementary artifacts in the unchanged compiled closure. The durable `review-to-notifications` edge owns historical framing and carries accepted summary and immutable versioned review evidence, not a rejection. The separately prepared `handle-notifications` destination owns current action, mandatory status update, and re-review; its body is not part of transition context. Shared Reviewer owns independent inspection and representative-family method, while specialized planning and architecture nodes own subtree, component, or system scope.

Current nodes own the scoped task, evidence and outcome meaning. Classic planning coordinates remaining work before evidenced completion or review, and classic execute satisfies its brief with relevant verification, including justified no-change. Typed nodes retain reproduction-before-repair, verification-owned acceptance, informed retry/exhaustion, research classification and exhaustive outstanding scope, data technical-versus-policy boundaries, and renewed architecture component/system review after notification return. Handoffs preserve accepted findings, classification, immutable citations and outstanding obligations rather than prescribing the destination's whole task again. Correction hosts use the supplied violations and remaining attempts to repair the result or required records; they do not indiscriminately redo delivery.

Planner policy preserves required scope and distinguishes bounded research delivery, implementation, evidence promotion and project acceptance. Retrying the same blocker needs a material input, decision, correction or different approach. Root acts on direct goals and leaves grandchild repair to the goal Planner; configured capability restrictions remain binding. Executor evidence remains reusable only while relevant inputs are unchanged and it applies to current criteria; later successes do not erase earlier failed or unresolved checks. The code refactor handoff preserves accepted green/already-green evidence: cleanup requires applicable checks, while a reasoned no-cleanup decision may reuse applicable recent evidence unless current criteria require a rerun. These are composed instruction policies, not new runtime gates, workflow state or admission mechanisms.

The shared Planner's bounded cancellation policy permits cancelling an obsolete or explicitly rejected direct-child approach with rationale only when current admission permits it. Cancellation cannot defer actionable work, reopen later, satisfy DONE dependencies or conceal unfinished acceptance. Custom role hosts receive shipped prose only through deliberate stopped reconciliation, preserving their guidance and capability boundaries.

Summary instructions prioritize final applicable decisions, settled effects, unresolved uncertainty, original ownership and useful evidence anchors. They condense repetition, routine successes and superseded attempt-by-attempt narration only without losing consequential facts or obligations; old operational chronology may collapse only when the next authorized action remains unchanged. Distinct failure classes, failed-check qualifications and immutable release/source identities remain where needed to preserve those distinctions. Prepared orientation is nonhistorical and source text is data, not executable instruction. This is quality guidance, not proof of improved fidelity or a new validity condition. Normal/corrective targets remain 12,000/6,000 UTF-8 bytes, not validity ceilings; summarizer tools, admission, source selection and invocation limits are unchanged. This transient guidance changes no durable contract or discriminator and never rewrites recorded historical text or automatically updates materialized overrides.

The authenticated Debug Graphs projection exposes each resolved workflow declaration and each selected global agent declaration with explicit `reference`, `compactable`, and an allowed optional exact `compaction_key`, plus one of `override-card | override-shared | bundled-card | bundled-shared`. Selected globals are projected separately from card graphs with their exact global session identity and installed model/tool binding. The projection omits bodies and paths and is computed from the installed immutable workflow artifact, not recorded state.

Nodes additionally project ordered record-prompt inputs and compiled placeholder
metadata, never selected record bodies or literal template tokens.
Process/record declaration reference and key metadata is privacy-filtered for this
operator projection; displayed keys never select retained instruction authority.

## Runtime invariants and operator cutover

- Prompt/config reads happen only during startup structural compilation.
- Reconfigure is validation-only; changing prompts requires restart.
- There is no fallback after any error except exact absence.
- There is no workflow-family map or runtime prompt selection; templates are consulted only by `init`, never at runtime.
- Old path forms and agent-name-keyed overrides are not read, moved, warned about, or normalized.
- A fresh `saivage init [--profile <name>]` on a config-absent project materializes the selected template's complete closure; a materialized instance is upgrade-independent by construction because its override tree resolves every reference at the override tier. Hand-authored typed-graph configs carry their typed-only prompt files in `.saivage/config/prompts` (one-time copy from the classic-typed template's tree) because the bundled root contains only the classic template's compiled source closure.
- Operators stop the service, manually reconcile the selected materialized overrides while preserving customizations, then start a genuinely new server process. Project Stop/Run, pause/resume, and browser refresh do not compile prompt changes.
- Producer-declared compaction policy uses strict object declarations and current conversation format 9, with the fresh [8→9 record-context cutover](./durable-format-changes.md#explicit-activation-and-record-context-2026-10-13). Incompatible adoption follows the [runbook reset/external-migration decision](../runbook/index.md#external-migrations); no runtime converter or adoption permission follows source completion. Earlier cutovers are historical provenance, not supported formats. Declaration-based protection applies to eligible durable entry, edge, pending-notification, correction and record-prompt occurrences. Structural prepared role/node evidence adds no durable model-context occurrence, changes no static/node delivery according to a declaration flag, and is not carried into compacted genesis; inspect its exact indexed source history instead. Record observation facts retain descriptors independently, never those historical instruction strings.

## Key source files

| File | Responsibility |
| --- | --- |
| `src/runtime/card-process/card-process-config.ts` | roots, exact selection, fragment reads, workflow compilation, eager process rendering |
| `src/utils/prompt-api.ts` | singular tokenizer/compiler, composition, discriminated host/placeholder policy, rendering, structurally scoped agent registry |
| `src/runtime/actors/agent-node-execution.ts` | direct exact-workflow process-text consumption |
| `src/application/runtime-composition.ts` | runtime wiring |
| `src/config/system-templates/<name>/prompts/**` | per-template bundled tree equal to that template's exact compiler-observed source closure, including the six shared project-guidance fragments and all process prompts selected by that template |
| `scripts/copy-system-template-prompts.js` | per-template standalone closure validation and copy to `dist/src/config/system-templates/<name>/prompts/` |
:::
