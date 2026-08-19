# Prompt handling

This in-depth companion to [System architecture](./system-architecture.md) and [System specification](../spec/system-specification.md) explains prompt discovery, validation, rendering, and runtime use. Saivage has no prompt editor, hot reload, manifest, runtime selection, or prompt-builder framework. Prompt handling is deterministic and startup-only; actors consume immutable compiled artifacts.

::: v-pre
## Purposes and layout

Agent prompts become provider system prompts. Process prompts are short transition context attached to lifecycle entries, nodes, corrections, and configured non-terminal edges. Fragments are not prompts; they are directly included pieces compiled under the host prompt's policy.

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

The project override root is `.saivage/config/prompts`; each registered system template owns its own bundled source tree under `src/config/system-templates/<name>/prompts/`, and packaging copies each tree per-template under `dist/src/config/system-templates/<name>/prompts/`. Packaging compiles each registered template standalone against its own source prompts root, observes every selected bundled agent, process, and direct-fragment artifact, and requires the physical source and copied output trees to equal that template's compiled closure exactly. There is no union tree, runtime discovery, or cross-template packaging rule. The `classic` closure is locked to exactly 14 files: four `agents/_shared` prompts and ten `process/_shared` prompts. The `classic-typed` closure is exactly 51 files: those same four shared agent prompts, the five shared correction/stopped/execute process prompts its graphs reference, and 42 typed-only process files. Neither tree has a `fragments` subtree or template-specific agent prompt. `saivage init --profile <name>` materializes the selected template's complete closure into the project override root, after which the instance owns its prompts.

The 42 typed-only process files are five shared planning hosts (`specialized-plan`, `specialized-review`, `specialized-recover`, `specialized-plan-to-review`, `specialized-review-to-plan`); seven `code` hosts (`code-red`, `code-green`, `code-refactor`, `code-red-to-green`, `code-to-refactor`, `code-green-retry`, `code-regression-to-green`); eight `test` hosts (`test-diagnose`, `test-add-coverage`, `test-repair`, `test-verify`, `test-to-add-coverage`, `test-to-repair`, `test-to-verify`, `test-repair-retry`); eight `research` hosts (`research-explore`, `research-assess`, `research-report`, `research-to-assess`, `research-continue-exploration`, `research-supported-to-report`, `research-refuted-to-report`, `research-inconclusive-to-report`); seven `data` hosts (`data-schema`, `data-validate`, `data-implement`, `data-to-validate`, `data-to-implement`, `data-revise-schema`, `data-implementation-retry`); and seven `architecture` hosts (`architecture-draft`, `architecture-component-review`, `architecture-system-review`, `architecture-to-component-review`, `architecture-to-system-review`, `architecture-component-revision`, `architecture-system-revision`). Each reference maps to `<reference>.md` under the stated shared or card-specific process directory.

## Selection and references

For a card host, exact lookup order is:

1. project `<purpose>/<card-type>/<reference>.md`
2. project `<purpose>/_shared/<reference>.md`
3. bundled `<purpose>/<card-type>/<reference>.md`
4. bundled `<purpose>/_shared/<reference>.md`

The global Analyst has no card type and checks project shared then bundled shared only. Prompt APIs represent that with `{kind:'global-agent'}`; workflow and process hosts instead carry `{kind,cardType}`. Scope is never encoded by comparing a card name. Consequently a configured card type named `global` follows the complete card-host order above for agents, processes, and fragments and receives workflow/process placeholder policy, while the Analyst remains independent. Only exact `ENOENT` advances. Empty, invalid UTF-8, directory, unreadable, malformed, or otherwise failing paths abort compilation. Selection never enumerates directories.

`agents.<agent-name>.prompt` is the filename reference at every agent tier. Agent name remains runtime/session identity, not a file key. Agents sharing a prompt reference share the same applicable override; independent override content requires distinct configured references. This is a breaking no-compatibility contract.

Fragments use the host card type even when the host itself came from a shared tier. Thus a shared code host may select a project `fragments/code/<id>.md`. The Analyst can use only shared fragments.

## One compiler and one discriminated host contract

The production compiler in `src/utils/prompt-api.ts` parses literals, value placeholders, and direct `{{> fragment-id}}` includes. It resolves each include independently, rejects a fragment containing another include, splices literal/value tokens in semantic order, validates the fully composed stream once, and freezes it. Repeated direct references are allowed. There are no arguments, recursion, cycles, conditions, labels, or inheritance.

The closed `PromptHost` variants select both artifact scope and placeholder policy, so callers cannot pair a card name with a contradictory policy. Their value sets are:

- global agent: `vocabularySnippet`
- workflow agent: `contractDescription`
- process: `cardType`

Unknown or host-inapplicable placeholders fail startup. Every effective workflow-agent system prompt contains `{{contractDescription}}` exactly once after fragment expansion and passes obsolete fixed-result-directive validation. The Analyst and process hosts reject that value. Old `toolList`, `projectContext`, `cardId`, `cardTitle`, and `cardBrief` placeholders do not exist: tools, project orientation, and card data are typed dynamic context, never rendered prompt variables.

## Compiled artifacts and runtime use

`compileProjectWorkflows()` owns exact root/scope selection and fragment reads. It compiles each selected agent template once. Process templates render raw `cardType` eagerly and are stored as final frozen non-empty text. Source edits after compilation cannot affect the artifact.

`PromptTemplateRegistry` stores global Analyst and card-type workflow entries structurally separately and substitutes runtime variables into already-compiled agent tokens without re-tokenization. The rendered agent instruction is the singular static instruction prefix of the prepared invocation: provider tool-definition bytes and terminal names complete the immutable prefix, and everything else reaches the model as typed dynamic context blocks. The Analyst supplies the selected compiled card-type vocabulary through `vocabularySnippet`; its bounded project orientation is a typed activation-local context block, not prompt content. Card agents supply only the generated node contract through `contractDescription`; card identity/brief/type arrive as typed dynamic blocks. Typed process prompts remain startup-compiled **dynamic process context**: node-entry, transition, correction, and recovery text is appended and projected at its existing semantic position and never enters the immutable prefix. Node execution reads already-rendered process strings by ID directly from the exact compiled workflow's `processPrompts` map; transition ordering and message placement are unchanged. Participant discovery for preparation and reserve validation traverses every node in every selected compiled graph, including typed-graph nodes, rather than deriving participation from default role names, classic graphs, or this prompt-file inventory.

Typed planning remains process guidance layered after the unchanged shared Planner system prompt: it describes the exact notification/activation/metadata limits and Analyst-only `reopen_card` escalation without granting Planner another tool. Typed architecture likewise uses the unchanged shared Reviewer system prompt, whose current target is `review.md`. Node prompts distinguish component and system scope; generated transition context places accepted summary and immutable versioned `review.md` URLs before edge and destination prompts, allowing each Reviewer node to start a clean cycle of the same record without a specialized agent template.

The authenticated Debug Graphs projection exposes prompt reference and one of `override-card | override-shared | bundled-card | bundled-shared`. It omits bodies and paths. The projection is computed from the installed immutable workflow artifact, not recorded state.

## Runtime invariants and operator cutover

- Prompt/config reads happen only during startup structural compilation.
- Reconfigure is validation-only; changing prompts requires restart.
- There is no fallback after any error except exact absence.
- There is no workflow-family map or runtime prompt selection; templates are consulted only by `init`, never at runtime.
- Old path forms and agent-name-keyed overrides are not read, moved, warned about, or normalized.
- A fresh `saivage init [--profile <name>]` materializes the selected template's complete closure; a materialized instance is upgrade-independent by construction because its override tree resolves every reference at the override tier. Hand-authored typed-graph configs carry their typed-only prompt files in `.saivage/config/prompts` (one-time copy from the classic-typed template's tree) because the bundled root is the classic 14-file closure.
- Operators stop the service, manually relocate overrides to the exact new tree, then start the new binary. Generated-state reset is not required solely for this configuration cutover.

## Key source files

| File | Responsibility |
| --- | --- |
| `src/runtime/card-process/card-process-config.ts` | roots, exact selection, fragment reads, workflow compilation, eager process rendering |
| `src/utils/prompt-api.ts` | singular tokenizer/compiler, composition, discriminated host/placeholder policy, rendering, structurally scoped agent registry |
| `src/runtime/actors/agent-node-execution.ts` | direct exact-workflow process-text consumption |
| `src/application/runtime-composition.ts` | runtime wiring |
| `src/config/system-templates/<name>/prompts/**` | per-template bundled tree equal to that template's exact compiled closure; `classic` is exactly 14 files, `classic-typed` exactly 51 |
| `scripts/copy-system-template-prompts.js` | per-template standalone closure validation and copy to `dist/src/config/system-templates/<name>/prompts/` |
:::
