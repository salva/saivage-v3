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

The project root is `.saivage/config/prompts`; bundled source assets are under `src/prompts` and are copied to `dist/prompts`. The production bundle contains exactly 14 files: four `agents/_shared` defaults and ten `process/_shared` defaults. It intentionally has no `fragments` subtree. Card-specific files are optional genuine exceptions.

## Selection and references

For a card host, exact lookup order is:

1. project `<purpose>/<card-type>/<reference>.md`
2. project `<purpose>/_shared/<reference>.md`
3. bundled `<purpose>/<card-type>/<reference>.md`
4. bundled `<purpose>/_shared/<reference>.md`

The global Analyst has no card type and checks project shared then bundled shared only. Only exact `ENOENT` advances. Empty, invalid UTF-8, directory, unreadable, malformed, or otherwise failing paths abort compilation. Selection never enumerates directories.

`agents.<agent-name>.prompt` is the filename reference at every agent tier. Agent name remains runtime/session identity, not a file key. Agents sharing a prompt reference share the same applicable override; independent override content requires distinct configured references. This is a breaking no-compatibility contract.

Fragments use the host card type even when the host itself came from a shared tier. Thus a shared code host may select a project `fragments/code/<id>.md`. The Analyst can use only shared fragments.

## One compiler and three host policies

The production compiler in `src/utils/prompt-api.ts` parses literals, value placeholders, and direct `{{> fragment-id}}` includes. It resolves each include independently, rejects a fragment containing another include, splices literal/value tokens in semantic order, validates the fully composed stream once, and freezes it. Repeated direct references are allowed. There are no arguments, recursion, cycles, conditions, labels, or inheritance.

Closed value sets are:

- global agent: `toolList`, `vocabularySnippet`, `projectContext`
- workflow agent: `cardId`, `cardTitle`, `cardBrief`, `cardType`, `contractDescription`, `toolList`
- process: `cardType`

Unknown or host-inapplicable placeholders fail startup. Every effective workflow-agent system prompt contains `{{contractDescription}}` exactly once after fragment expansion and passes obsolete fixed-result-directive validation. The Analyst and process hosts reject that value.

## Compiled artifacts and runtime use

`compileProjectWorkflows()` owns exact root/scope selection and fragment reads. It compiles each selected agent template once. Process templates render raw `cardType` eagerly and are stored as final frozen non-empty text. Source edits after compilation cannot affect the artifact.

`PromptTemplateRegistry` substitutes runtime variables into already-compiled agent tokens without re-tokenization. The Analyst supplies tools, vocabulary, and exact-or-throw project context. Card agents supply card identity/brief/type, generated node contract, and tools. `ProcessPromptRegistry` is a strict lookup over already-rendered process strings; transition ordering and message placement are unchanged.

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
| `src/utils/prompt-api.ts` | singular tokenizer/compiler, composition, host policy, rendering, agent registry |
| `src/runtime/card-process/process-prompt-registry.ts` | final process-text lookup and reference closure |
| `src/application/runtime-composition.ts` | runtime wiring |
| `src/prompts/**` | exact bundled 14-file defaults |
| `scripts/copy-prompt-defaults.js` | exact inventory validation and copy to `dist/prompts` |
:::
