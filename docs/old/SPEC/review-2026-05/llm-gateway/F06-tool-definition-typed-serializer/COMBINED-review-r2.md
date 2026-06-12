# F06 Combined r2 Review

## Findings

### Architectural blocker: strict top-level key rejection breaks the active runtime tool path

COMBINED-r2 fixes the r1 closure problem by making F06 standalone, but its proposed `assertCatalogShape` now rejects any tool entry with top-level keys outside `type` and `function`. That does not match the current live tool source. `AgentToolExecutor.buildToolsForRole` builds the LLM `tools` array from `this.toolRuntime.schema()` first, falling back to `AgentToolCatalog.definitionFor(name)` only when the runtime schema lacks an entry. `ToolRuntime.schema()` returns entries shaped as `{ type, function, roles, action }`.

That means the proposed serializer would throw `disallowed key 'roles'` for normal planner/executor/reviewer calls that use runtime-backed tools. This is not just tactical polish: it makes the new gateway boundary incompatible with the architecture already in use, and it would disable the tool path the serializer is meant to harden.

The fix should preserve the architecture-first goal without backward-compat shims: introduce an explicit projection/normalization boundary from runtime registry schema entries to provider tool definitions before exact-key validation, or make the serializer accept the current upstream union and deliberately project only `{ type, function: { name, description, parameters } }` before validating the emitted wire object. In either version, tests need to include a runtime-style entry carrying `roles` and `action` and assert those keys are stripped from both Chat and Codex wire output.

## Advisory Notes

- The empty-array rejection is mostly a serializer unit concern today because both gateways already guard on `opts.tools.length > 0`; the plan should not claim current empty arrays are shipped to providers.
- `Object.freeze` is shallow: `parameters` remains mutable through the shared catalog/runtime reference. If immutability is part of the contract, either deep-freeze the parameters object or narrow the claim to preventing mutation of the wrapper/envelope.

VERDICT: CHANGES_REQUESTED