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

The project root is `.saivage/config/prompts`; bundled source assets are under the one singular `src/prompts` tree and are copied to the one `dist/prompts` tree. Packaging compiles both explicitly registered bundled card-type sets with the shared global defaults, observes every selected bundled agent, process, and direct-fragment artifact through the production selector, and requires the physical source and copied output trees to equal that registered-set union exactly. There is no per-set prompt root, runtime discovery, or default-set-only packaging rule. Standard's closure remains locked to exactly its historical 14 files: four `agents/_shared` prompts and ten `process/_shared` prompts. Specialized selects those same four shared agent prompts, existing shared correction/stopped/execute process prompts, and exactly 42 additional process files. The registered union is therefore exactly 56 files and has no `fragments` subtree or specialized agent prompt.

The 42 specialized-only process files are five shared planning hosts (`specialized-plan`, `specialized-review`, `specialized-recover`, `specialized-plan-to-review`, `specialized-review-to-plan`); seven `code` hosts (`code-red`, `code-green`, `code-refactor`, `code-red-to-green`, `code-to-refactor`, `code-green-retry`, `code-regression-to-green`); eight `test` hosts (`test-diagnose`, `test-add-coverage`, `test-repair`, `test-verify`, `test-to-add-coverage`, `test-to-repair`, `test-to-verify`, `test-repair-retry`); eight `research` hosts (`research-explore`, `research-assess`, `research-report`, `research-to-assess`, `research-continue-exploration`, `research-supported-to-report`, `research-refuted-to-report`, `research-inconclusive-to-report`); seven `data` hosts (`data-schema`, `data-validate`, `data-implement`, `data-to-validate`, `data-to-implement`, `data-revise-schema`, `data-implementation-retry`); and seven `architecture` hosts (`architecture-draft`, `architecture-component-review`, `architecture-system-review`, `architecture-to-component-review`, `architecture-to-system-review`, `architecture-component-revision`, `architecture-system-revision`). Each reference maps to `<reference>.md` under the stated shared or card-specific process directory.

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

- global agent: `toolList`, `vocabularySnippet`, `projectContext`
- workflow agent: `cardId`, `cardTitle`, `cardBrief`, `cardType`, `contractDescription`, `toolList`
- process: `cardType`

Unknown or host-inapplicable placeholders fail startup. Every effective workflow-agent system prompt contains `{{contractDescription}}` exactly once after fragment expansion and passes obsolete fixed-result-directive validation. The Analyst and process hosts reject that value.

## Compiled artifacts and runtime use

`compileProjectWorkflows()` owns exact root/scope selection and fragment reads. It compiles each selected agent template once. Process templates render raw `cardType` eagerly and are stored as final frozen non-empty text. Source edits after compilation cannot affect the artifact.

`PromptTemplateRegistry` stores global Analyst and card-type workflow entries structurally separately and substitutes runtime variables into already-compiled agent tokens without re-tokenization. The Analyst supplies tools, the selected compiled card-type vocabulary, and exact-or-throw project context. Card agents supply card identity/brief/type, generated node contract, and tools. Node execution reads already-rendered process strings by ID directly from the exact compiled workflow's `processPrompts` map; transition ordering and message placement are unchanged.

Specialized planning remains process guidance layered after the unchanged shared Planner system prompt: it describes the exact notification/activation/metadata limits and Analyst-only `reopen_card` escalation without granting Planner another tool. Specialized architecture likewise uses the unchanged shared Reviewer system prompt, whose current target is `review.md`. Node prompts distinguish component and system scope; generated transition context places accepted summary and immutable versioned `review.md` URLs before edge and destination prompts, allowing each Reviewer node to start a clean cycle of the same record without a specialized agent template.

The authenticated Debug Graphs projection exposes prompt reference and one of `override-card | override-shared | bundled-card | bundled-shared`. It omits bodies and paths. The projection is computed from the installed immutable workflow artifact, not recorded state.

## Runtime invariants and operator cutover

- Prompt/config reads happen only during startup structural compilation.
- Reconfigure is validation-only; changing prompts requires restart.
- There is no fallback after any error except exact absence.
- There is no workflow-family map or runtime prompt selection.
- Old path forms and agent-name-keyed overrides are not read, moved, warned about, or normalized.
- Operators stop the service, manually relocate overrides to the exact new tree, then start the new binary. Generated-state reset is not required solely for this configuration cutover.

## Key source files

| File | Responsibility |
| --- | --- |
| `src/runtime/card-process/card-process-config.ts` | roots, exact selection, fragment reads, workflow compilation, eager process rendering |
| `src/utils/prompt-api.ts` | singular tokenizer/compiler, composition, discriminated host/placeholder policy, rendering, structurally scoped agent registry |
| `src/runtime/actors/agent-node-execution.ts` | direct exact-workflow process-text consumption |
| `src/application/runtime-composition.ts` | runtime wiring |
| `src/prompts/**` | singular bundled tree equal to the exact registered-set union; `standard` remains exactly 14 files |
| `scripts/copy-prompt-defaults.js` | compile-time selected-artifact union, exact `standard` lock, inventory validation, and copy to `dist/prompts` |
:::
