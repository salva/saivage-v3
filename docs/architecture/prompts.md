# Prompt handling

This in-depth companion to [System architecture](./system-architecture.md) and [System specification](../spec/system-specification.md) explains prompt discovery, validation, rendering, and runtime use. Saivage has no prompt editor, hot reload, manifest, runtime selection, or prompt-builder framework. Prompt handling is deterministic and startup-only; actors consume immutable compiled artifacts.

::: v-pre
## Purposes and layout

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

The project override root is `.saivage/config/prompts`; each registered system template owns its own bundled source tree under `src/config/system-templates/<name>/prompts/`, and packaging copies each tree per-template under `dist/src/config/system-templates/<name>/prompts/`. Packaging compiles each registered template standalone against its own source prompts root, observes every selected bundled agent, process, and direct-fragment artifact, and requires the physical source and copied output trees to equal that template's compiled closure exactly. There is no union tree, runtime discovery, cross-template packaging rule, or separately maintained numeric file count. Both shipped closures contain five shared agent prompts and six shared project-guidance fragments, including Oversight, plus all process prompts selected by their graphs. `classic-typed` additionally contains its selected typed card-specific process prompts and architecture notification-return prompt. Neither tree has a template-specific agent prompt. `saivage init --profile <name>` materializes the selected template's complete closure into a config-absent project override root, after which the instance owns its prompts; with an existing config, init preserves the prompt tree, marker, and YAML and performs no template upgrade.

The 42 typed-only process files are five shared planning hosts (`specialized-plan`, `specialized-review`, `specialized-recover`, `specialized-plan-to-review`, `specialized-review-to-plan`); seven `code` hosts (`code-red`, `code-green`, `code-refactor`, `code-red-to-green`, `code-to-refactor`, `code-green-retry`, `code-regression-to-green`); eight `test` hosts (`test-diagnose`, `test-add-coverage`, `test-repair`, `test-verify`, `test-to-add-coverage`, `test-to-repair`, `test-to-verify`, `test-repair-retry`); eight `research` hosts (`research-explore`, `research-assess`, `research-report`, `research-to-assess`, `research-continue-exploration`, `research-supported-to-report`, `research-refuted-to-report`, `research-inconclusive-to-report`); seven `data` hosts (`data-schema`, `data-validate`, `data-implement`, `data-to-validate`, `data-to-implement`, `data-revise-schema`, `data-implementation-retry`); and seven `architecture` hosts (`architecture-draft`, `architecture-component-review`, `architecture-system-review`, `architecture-to-component-review`, `architecture-to-system-review`, `architecture-component-revision`, `architecture-system-revision`). Each reference maps to `<reference>.md` under the stated shared or card-specific process directory.

## Selection and references

For a card host, exact lookup order is:

1. project `<purpose>/<card-type>/<reference>.md`
2. project `<purpose>/_shared/<reference>.md`
3. bundled `<purpose>/<card-type>/<reference>.md`
4. bundled `<purpose>/_shared/<reference>.md`

The global Analyst has no card type and checks project shared then bundled shared only. Prompt APIs represent that with `{kind:'global-agent'}`; workflow and process hosts instead carry `{kind,cardType}`. Scope is never encoded by comparing a card name. Consequently a configured card type named `global` follows the complete card-host order above for agents, processes, and fragments and receives workflow/process placeholder policy, while the Analyst remains independent. Only exact `ENOENT` advances. Empty, invalid UTF-8, directory, unreadable, malformed, or otherwise failing paths abort compilation. Selection never enumerates directories.

`agents.<agent-name>.prompt` is the strict declaration `{reference,compactable?}` at every agent tier. `reference` is the filename reference and omitted `compactable` resolves to `true`. Static agent and node declarations accept explicit true or false but never `compaction_key`; their policy does not change delivery because neither creates a durable occurrence. Agent name remains runtime/session identity, not a file key. Agents sharing a prompt reference share the same applicable override; independent override content requires distinct configured references. This is a breaking no-compatibility contract.

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

The shipped selected-global set now contains Analyst and Oversight. Oversight has its own shared `oversight.md` prompt, directly includes `project-guidance-common.md` and the sixth shipped guidance fragment `project-guidance-oversight.md`, and accepts no workflow-agent placeholders. Both selected globals use global-host selection; card-specific fragments never reach them. Template packaging and init materialization derive the complete closure from compilation rather than a maintained file count. Existing instances adopt the complete six-fragment closure deliberately while stopped; init never upgrades an existing config.

Each shipped Planner, Executor, Reviewer, Analyst, and Oversight prompt directly includes one common project-guidance fragment and its matching role fragment immediately after its identity paragraph. A freshly materialized template supplies these exact nonempty neutral defaults:

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

Unknown or host-inapplicable placeholders fail startup. Every effective workflow-agent system prompt contains `{{contractDescription}}` exactly once after fragment expansion and passes obsolete fixed-result-directive validation. The Analyst and process hosts reject that value. Old `toolList`, `projectContext`, `cardId`, `cardTitle`, and `cardBrief` placeholders do not exist: tools, project orientation, and card data are typed dynamic context, never rendered prompt variables.

## Compiled artifacts and runtime use

`compileProjectWorkflows()` owns exact root/scope selection and fragment reads. It compiles each selected agent template once. Process templates render raw `cardType` eagerly and are stored as final frozen non-empty text. Source edits after compilation cannot affect the artifact.

`PromptTemplateRegistry` stores the selected global Analyst and Oversight entries and card-type workflow entries structurally separately and substitutes runtime variables into already-compiled agent tokens without re-tokenization. The rendered agent instruction is the singular static instruction prefix of the prepared invocation; its generated node outcome contract is supplied through `contractDescription`, and provider tool-definition bytes plus terminal names complete the immutable prefix. Both global hosts supply the selected compiled card-type vocabulary through `vocabularySnippet`; Analyst's bounded project orientation is a typed activation-local context block, not prompt content.

For a card node, preparation first retains the existing system-role card block byte-for-byte as canonical `{cardId,cardType,title,brief}` JSON, with the complete accepted configured bootstrap brief. It then adds one system-role retained block containing a minimal current-node label followed by the unaltered full process text selected from the actual compiled workflow and node. That selected node text is read once before record, notification, or conversation-ingress effects. Both completed blocks are frozen through the initial request and every tool, notification, repair, retry, compaction, admission, and recovery continuation, and prepared anew for the next node. The compiled state-machine node—not prior transcript placement, lifecycle status, or summary prose—selects the current step. Role instruction and generated outcome contract remain in the static instruction position, and the current node's compiled tools remain the tool contract; neither is copied into the node block.

Current-node text is request context and is no longer appended as an ordinary conversation row. Existing old node-looking rows remain unchanged ordinary history and are neither recognized nor suppressed. Lifecycle-entry, edge, transition-handoff, correction, notification, and recovery context keeps its existing durable producer position. A transition handoff is delivered once, but its accepted facts, immutable record URLs, and still-applicable requirements do not expire merely because delivery is not repeated.

The composition projector is the single request-composition boundary. Its provider conversion places one concise system provenance boundary after prepared blocks and before any historical/current conversation suffix; only an accumulated summary receives the additional `Historical summary:` label. This distinguishes synthesized history from current-node authority without demoting applicable owner requirements or claiming that replay proves execution, transition, or approval. Chat, Responses, and Codex serialize the same ordered provider items; adapters add no authority rules. Summarizer requests instead receive the prepared blocks as labeled read-only orientation, then inherited history and new source. Their guidance preserves attribution, actual work and decisions, applicable requirements, unresolved uncertainty and evidence references; it distinguishes proposed from executed and draft from accepted/approved, and does not treat a final successful newline-separated shell command as proof that earlier commands passed (`pipefail` concerns pipelines).

Participant discovery for preparation and reserve validation traverses every node in every selected compiled graph, including typed-graph nodes, rather than deriving participation from default role names, classic graphs, or this prompt-file inventory.

Each shipped template retains one shared Planner system-prompt artifact selected for both `project` and `goal`. Its prose interprets the separately supplied frozen `cardType`: project Planner owns coherent strategy through complete evidenced acceptance, while goal Planner owns local decomposition, coordination, and repair within its delegated outcome. The distinction is not a workflow-agent placeholder—`contractDescription` remains that host's only value—and needs no card-specific Planner artifact or specialized fragment, selector, role classifier, or agent; the common and Planner fragments are generic project-guidance hooks. The shared Planner host owns generic autonomy, evidence-versus-suggested-remedy judgment, immediate-child reuse versus a genuinely distinct bounded follow-up, and the configured local authority to reopen a done or failed direct child. Typed plan and recover process guidance applies those policies to current-node assessment, action order, corrective context, activation, and evidence-based outcomes; it does not turn ordinary local repair into an Analyst-only typed escalation. Typed review-to-plan owns only the concrete accepted-review handoff, including its immutable versioned URL, and directs the Planner to assess findings and remedy supported defects rather than blindly adopt suggested remedies. Shared review-to-notifications and handler prompts preserve an accepted review as evidence while directing the designated Planner to reconsider newly delivered context and pass review again. Typed architecture continues to use the unchanged shared Reviewer system prompt, whose current target is `review.md`; its notification-specific system-review edge prompt returns accepted evidence to Executor draft, which must pass component and system review again. Node prompts distinguish component and system scope; generated transition context places accepted summary and immutable versioned `review.md` URLs before edge and destination prompts, allowing each Reviewer node to start a clean cycle of the same record without a specialized agent template.

The shared Planner prompt also owns prompt-level distinctions among bounded research delivery, implementation, evidence promotion, and project acceptance. It preserves required scope while removing only locally invented sequencing, returns exhausted research as a useful handoff, and requires a material input, decision, correction, or different approach before retrying the same blocker. It directs the owning Planner to correct ordinary in-scope defects autonomously: reopen the same done direct child when its original task needs correction, queue concrete context, and activate it; retry failed work only with material new diagnosis/input/correction or a justified different route; and use a separate child only for a genuinely distinct bounded follow-up. Root acts only on its own direct goals and leaves grandchild repair to the goal Planner. Typed planning and recovery repeat that actionable-BLOCKED and local-repair judgment without changing BLOCKED admission, STOPPED recovery, notification delivery, global Analyst intervention authority, or configured tool restrictions. A deliberately restricted named-agent configuration remains a real capability boundary, not permission to bypass it. The shared Executor prompt in both templates owns verification interpretation and reuse: later successful invocations do not erase earlier failed or unresolved checks, still-applicable evidence may be reused, and current required validation remains mandatory. These are composed instruction policies, not runtime gates, workflow state, or new admission mechanisms.

The same shared Planner host in both templates states the existing bounded cancellation policy without changing its tool contract: an obsolete or explicitly rejected direct-child approach may be cancelled with rationale when current admission permits it, but cancellation cannot defer actionable work, reopen later, satisfy DONE dependencies, or conceal unfinished acceptance. In the typed test process, `test-diagnose` may classify a fresh or resumed already-passing, meaningfully covered baseline as `coverage_ready`; the existing `test-to-verify` transition then requires independent verification-owned acceptance. This changes no process-host inventory—the typed-only count remains 42—and custom Planner hosts still receive this policy only if operators merge it while preserving their explicit guidance includes.

The authenticated Debug Graphs projection exposes each resolved workflow declaration and each selected global agent declaration with explicit `reference`, `compactable`, and an allowed optional exact `compaction_key`, plus one of `override-card | override-shared | bundled-card | bundled-shared`. Selected globals are projected separately from card graphs with their exact global session identity and installed model/tool binding. The projection omits bodies and paths and is computed from the installed immutable workflow artifact, not recorded state.

## Runtime invariants and operator cutover

- Prompt/config reads happen only during startup structural compilation.
- Reconfigure is validation-only; changing prompts requires restart.
- There is no fallback after any error except exact absence.
- There is no workflow-family map or runtime prompt selection; templates are consulted only by `init`, never at runtime.
- Old path forms and agent-name-keyed overrides are not read, moved, warned about, or normalized.
- A fresh `saivage init [--profile <name>]` on a config-absent project materializes the selected template's complete closure; a materialized instance is upgrade-independent by construction because its override tree resolves every reference at the override tier. Hand-authored typed-graph configs carry their typed-only prompt files in `.saivage/config/prompts` (one-time copy from the classic-typed template's tree) because the bundled root contains only the classic template's compiled source closure.
- Operators stop the service, manually reconcile the selected materialized overrides while preserving customizations, then start a genuinely new server process. Project Stop/Run, pause/resume, and browser refresh do not compile prompt changes.
- Producer-declared compaction policy uses strict object declarations and conversation format 2. It is a reset-only cutover from format 1. It protects eligible durable entry, edge, pending-notification, and correction occurrences; it adds no durable current-node occurrence and never changes static or node delivery according to a declaration flag.

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
