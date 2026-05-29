# F06 — Tool definition typed serializer (COMBINED)

Status recommendation: **ABSORBED-BY-F05 with one small addendum.** F05 already owns the per-provider boundary for `tool_choice`, freezes both `tools[]` wire shapes via [§8.1 gateway tests](../F05-envelope-vs-toolcalls-orthogonality/02-design-r4.md), and adds `serializeToolCallMessage` for the persisted-row side. The remaining gap — the inline `[].map((t) => ({ type, function }))` reshape in the chat gateway and the ad-hoc `codexTool` helper in the codex gateway — is a 1-commit follow-up that should land inside F05's batches 3 and 4, not as an independent F06 effort. No second design pass is needed.

---

## 1. Analysis

### 1.1 Current ad-hoc reshape sites (verified at HEAD)

Internal source of truth — `ToolRuntime.schema()` at [src/tools/runtime.ts#L96-L107](../../../src/tools/runtime.ts#L96) returns:

```ts
{ type: 'function', function: { name, description, parameters }, roles, action }
```

The leak surface is `roles: PermissionRole[]` and `action: ToolAction` — both Saivage-internal. They are typed onto the values flowing through `LlmCompleteOptions.tools` because `ToolRegistrySchemaEntry` widens to (or is assignable to) `ToolDefinition` at the gateway boundary.

Provider reshape sites (chat, nested `function` object):

- [src/agents/llm-openai-chat-gateway.ts#L178-L181](../../../src/agents/llm-openai-chat-gateway.ts#L178) — `requestBody.tools = opts.tools.map((t) => ({ type: t.type, function: t.function }));` This map IS what currently strips `roles`/`action`. It is structural-projection-only; no Zod, no type assertion, no snapshot.

Provider reshape sites (codex Responses, FLAT top-level `name`):

- [src/agents/llm-openai-codex-gateway.ts#L124](../../../src/agents/llm-openai-codex-gateway.ts#L124) — `body.tools = opts.tools.map(codexTool);`
- [src/agents/llm-openai-codex-gateway.ts#L181-L188](../../../src/agents/llm-openai-codex-gateway.ts#L181) — `codexTool(tool)` returns `{ type: 'function', name: tool.function.name, description: tool.function.description, parameters: tool.function.parameters }`. This also strips `roles`/`action` implicitly by re-projecting.

Catalog duplication (the second sub-issue F06 flags):

- `PLANNER_TOOL_DEFINITIONS` / `ROLE_TOOL_NAMES` at [src/agents/agent-tool-catalog.ts#L26-L75](../../../src/agents/agent-tool-catalog.ts#L26) — hand-maintained.
- `RoleToolPolicy.listToolNamesForRole` at [src/agents/role-tool-policy.ts#L64](../../../src/agents/role-tool-policy.ts#L64) — prefers runtime view, falls back to catalog. The catalog is dead-by-fallback once the runtime registry covers every role.

### 1.2 Fields that must NEVER cross the boundary

From `RuntimeToolDefinition` and `ToolRegistrySchemaEntry`: `roles`, `action`, plus any future Saivage-internal metadata added to the runtime entry. The current implicit-projection mechanism (`{ type: t.type, function: t.function }`) drops them only by accident of the projection key set; a new field on `RuntimeToolDefinition` would leak immediately on the next refactor that returns the runtime entry verbatim.

### 1.3 Per-provider expected wire shape

| Provider | Tool entry shape | Source |
| --- | --- | --- |
| chat-completions (`opencode`, `opencode-go`, `github-copilot`, `nvidia-nim`) | `{ type: 'function', function: { name, description, parameters } }` (nested) | OpenAI chat spec |
| `openai-codex` Responses | `{ type: 'function', name, description, parameters }` (FLAT) | OpenAI Responses spec; matches `CodexTool` at [src/agents/llm-openai-codex-gateway.ts#L18](../../../src/agents/llm-openai-codex-gateway.ts#L18) |

### 1.4 Is F05 enough?

F05 directly addresses:

- `tool_choice` typed boundary via `TerminalChoice` discriminated union ([F05 02-design-r4 §3.5](../F05-envelope-vs-toolcalls-orthogonality/02-design-r4.md)). Per-provider wire translation owned by `buildOpenAIChatRequest` and `buildOpenAICodexRequest`. Shapes asserted SEPARATELY in §8.1.
- Always sends `parallel_tool_calls: false`.
- Adds `serializeToolCallMessage` / `parseToolCallMessage` for the persisted assistant-tool-call row shape ([F05 §6](../F05-envelope-vs-toolcalls-orthogonality/02-design-r4.md)).
- Introduces `role-result-tools.ts` and `buildLlmOptions(...)` so the terminal tool entry is constructed in one typed place ([F05 §3.2, §3.3](../F05-envelope-vs-toolcalls-orthogonality/02-design-r4.md)).
- §8.1 freezes `tools[0].function.name` (chat) and `tools[0].name` (codex) per-provider — the snapshot test F06 asks for is already in F05's plan.

F05 does NOT do:

- Introduce a typed `WireToolDefinition` discriminated union covering the FULL tool entry per provider. The `tools[]` projection at the chat builder is still the inline `(t) => ({ type: t.type, function: t.function })` literal; the codex builder still has the `codexTool` helper. Neither projection is type-checked against an exhaustive provider-shape union; both are structural.
- Make the implicit `roles`/`action` strip explicit. Today it works because the projection key set is `{ type, function }` (chat) or `{ type, name, description, parameters }` (codex). A future contributor returning `opts.tools` verbatim from a new builder, or extending the inline map to spread, would leak.

Conclusion: F05 closes the dynamic risk (per-provider request shaping is now in one owned place, with §8.1 snapshots). The remaining gap is purely structural hygiene — replacing two short inline projections with one named, typed serializer module. That is a 1-commit follow-up inside F05's batches, not a parallel F06 design.

---

## 2. Design

### 2.1 Recommendation

Mark F06 **ABSORBED-BY-F05** and land one addendum commit inside F05's implementation. Do not open a parallel F06 design/implementation track. Reasons:

1. F05 already owns every gateway boundary F06 needs to touch. Splitting ownership would require a second set of conflict-prone gateway-builder edits.
2. F05's §8.1 already specifies the snapshot/per-provider assertion F06 recommends. Restating it under F06 would duplicate test surface.
3. The two-source-of-truth sub-issue (`agent-tool-catalog.ts` vs `ToolRuntime`) is operationally fine: the runtime view wins at every call site that matters, the catalog is fallback-only, and the catalog's deletion is a separate hygiene task with no contract impact. Bundling it into F06 would inflate scope.

### 2.2 Addendum to F05 — `serializeToolForProvider`

Add a single new module owned by F05's batch 3 + batch 4 edits:

`src/agents/wire-tool-definition.ts`:

```ts
import type { ToolDefinition } from './llm-contracts.js';

export interface ChatWireTool {
  type: 'function';
  function: { name: string; description: string; parameters: unknown };
}

export interface CodexWireTool {
  type: 'function';
  name: string;
  description: string;
  parameters: unknown;
}

export type WireToolDefinition = ChatWireTool | CodexWireTool;

export function serializeToolForChat(tool: ToolDefinition): ChatWireTool {
  return {
    type: 'function',
    function: {
      name: tool.function.name,
      description: tool.function.description,
      parameters: tool.function.parameters,
    },
  };
}

export function serializeToolForCodex(tool: ToolDefinition): CodexWireTool {
  return {
    type: 'function',
    name: tool.function.name,
    description: tool.function.description,
    parameters: tool.function.parameters,
  };
}
```

Key properties:

- Two named functions, not one polymorphic dispatcher. Each gateway calls the one it owns. Avoids a `provider` parameter and the corresponding switch — keeps each builder's call site type-correct without a discriminator lookup.
- Return types are nominal interfaces. Each function explicitly enumerates the keys it writes; spreading `tool.function` or `tool` is forbidden, which is exactly the property that makes a future `roles`/`action` leak structurally impossible.
- `WireToolDefinition` exists as a union for tests in F05 §8.1 to consume but is NOT used in `LlmToolsOptions` itself. `LlmToolsOptions.tools` stays as `ToolDefinition[]` (internal shape). Conversion happens once, at the gateway boundary, exactly as `TerminalChoice` translation does in F05 §3.5.

### 2.3 Alternative considered: `WireToolDefinition` as a request-side type carried by `LlmToolsOptions`

Rejected. Would push provider-specific shape selection upstream of the gateway and force `buildLlmOptions` to know which transport will be selected — duplicating the per-candidate routing already owned by `AgentLlmInvocationGateway`. Worse, it would require re-serializing once per failover candidate. The keep-internal-`ToolDefinition`-and-translate-at-the-builder pattern matches F05's `TerminalChoice` treatment.

### 2.4 What this addendum does NOT do

- Does not touch `ToolRuntime.schema()` at [src/tools/runtime.ts#L96](../../../src/tools/runtime.ts#L96). The runtime entry keeps `roles` and `action` because role-policy and tool-executor consumers need them. The hygiene win is that those fields never reach a gateway builder's output object.
- Does not delete `agent-tool-catalog.ts`. That is a separate cleanup with no contract impact.
- Does not add a snapshot library. The §8.1 inline literal assertions in F05 are sufficient; once the serializer module owns the projection, the assertions effectively snapshot it.

---

## 3. Plan

No separate F06 batch. Two micro-edits folded into F05 batches 3 and 4 plus one micro-edit added to F05 batch 15 (tests). Verification: F05's existing §8.1 chat/codex split assertions, extended to import from the new module.

### 3.1 Addendum commits (folded into F05)

**Inside F05 batch 1** (new modules): also create `src/agents/wire-tool-definition.ts` per §2.2. No imports change.

**Inside F05 batch 3** (rewrite `buildOpenAIChatRequest`): replace the inline projection at [src/agents/llm-openai-chat-gateway.ts#L178-L181](../../../src/agents/llm-openai-chat-gateway.ts#L178) with:

```ts
requestBody.tools = opts.tools.map(serializeToolForChat);
```

Import `serializeToolForChat` from `./wire-tool-definition.js`. The `tool_choice` translation in this batch is unchanged from F05 §3.5.

**Inside F05 batch 4** (rewrite `buildOpenAICodexRequest`): replace the `codexTool` map at [src/agents/llm-openai-codex-gateway.ts#L124](../../../src/agents/llm-openai-codex-gateway.ts#L124) with:

```ts
body.tools = opts.tools.map(serializeToolForCodex);
```

DELETE the local `codexTool` helper at [src/agents/llm-openai-codex-gateway.ts#L181-L188](../../../src/agents/llm-openai-codex-gateway.ts#L181) and DELETE the `CodexTool` interface at [src/agents/llm-openai-codex-gateway.ts#L18](../../../src/agents/llm-openai-codex-gateway.ts#L18) (replaced by `CodexWireTool` import). `tool_choice` translation unchanged from F05 §3.5.

**Inside F05 batch 15** (tests): add `tests/agents/wire-tool-definition.test.ts` with two cases per envelope-bearing role × provider:

- `serializeToolForChat__strips_roles_and_action_returns_nested_function_object` — feed a `ToolDefinition` that carries spurious extra keys (cast); assert returned object has exactly `{ type, function: { name, description, parameters } }` (use `Object.keys` equality, not just superset).
- `serializeToolForCodex__strips_roles_and_action_returns_flat_name` — same, asserting `{ type, name, description, parameters }` exactly.

F05's §8.1 gateway tests are then tightened to assert `requestBody.tools[0]` against `serializeToolForChat(...)` and `serializeToolForCodex(...)` respectively — one assertion line per case — which freezes the per-provider wire shape against the serializer module.

### 3.2 Green checkpoints

After each F05 batch lands as in F05 §9, run F05's existing checks plus:

- `npx tsc --noEmit` — typecheck the new module and its two import sites.
- `npx vitest run tests/agents/wire-tool-definition.test.ts` — new module unit tests.
- `npx vitest run tests/agents/llm-openai-chat-gateway.test.ts tests/agents/llm-openai-codex-gateway.test.ts` — F05 §8.1 per-provider gateway suites, now asserting against the serializer output.

### 3.3 What this plan does NOT do

- Does not pre-empt or reorder any F05 batch.
- Does not introduce a `roles`/`action` runtime-type change.
- Does not touch `agent-tool-catalog.ts`. The catalog/runtime duplication is a separate, no-contract-impact cleanup; if desired, file it as a follow-up F-issue but not under F06.

### 3.4 Risk and rollback

Risk: zero new wire behaviour — the new functions return the same JSON the inline projections produce today. Rollback: revert the three folded edits (new file + two builder import swaps + new test file); F05's main batches remain green.

---

## 4. F-closure

**F06 is ABSORBED-BY-F05.** Mark `F06-tool-definition-typed-serializer.md` as resolved by:

1. F05 batches 3 + 4 incorporating the `serializeToolForChat` / `serializeToolForCodex` swap from §3.1.
2. F05 batch 1 creating `src/agents/wire-tool-definition.ts` per §2.2.
3. F05 batch 15 adding `tests/agents/wire-tool-definition.test.ts` and tightening §8.1 chat/codex gateway assertions to compare against the serializer output.

No standalone F06 design-r2, implementation plan, or batched commit set is needed. The F06 spec file at [F06-tool-definition-typed-serializer.md](../F06-tool-definition-typed-serializer.md) should be annotated `Status: ABSORBED-BY-F05 (see F06-tool-definition-typed-serializer/COMBINED-r1.md §3.1)` and not assigned an independent owner. Verifier MUST confirm during F05 review that the addendum commits appear in F05's diff; otherwise F06 reopens as a 1-batch focused issue using the same §2.2 module.

The catalog-vs-runtime duplication F06 flags as a secondary concern is OUT OF SCOPE for both F05 and the F06 absorption; it has no contract or wire impact and is filed as a separate hygiene task if desired.
