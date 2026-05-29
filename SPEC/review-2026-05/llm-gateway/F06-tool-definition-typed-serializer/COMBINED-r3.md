# F06 — Tool Definition Typed Serializer (COMBINED-r3)

Status: Proposed (standalone, NOT absorbed by F05).
Scope: Outbound `tools[]` array in LLM requests — the boundary between the
in-process tool entry (catalog `ToolDefinition` from
[src/agents/llm-contracts.ts](../../../../src/agents/llm-contracts.ts#L11-L14)
or runtime `ToolRegistrySchemaEntry` from
[src/tools/runtime.ts](../../../../src/tools/runtime.ts#L18-L26)) and the
per-provider wire shape. F05 is adjacent and owns the assistant-message
serialization (function-call items, tool result items). F06 owns tool
*definition* serialization. The two surfaces are disjoint.

---

## 1. Functional analysis (verified)

### 1.1 Upstream sources feeding `opts.tools`

Two shapes flow into the gateway, both built by
[`AgentToolExecutor.buildToolsForRole`](../../../../src/agents/agent-tool-executor.ts#L45-L50):

```ts
buildToolsForRole(role: AgentRole) {
  const runtimeSchema = this.toolRuntime.schema().filter((tool) => tool.roles.includes(role));
  return this.getToolNamesForRole(role)
    .map((name) => runtimeSchema.find((tool) => tool.function.name === name) ?? AgentToolCatalog.definitionFor(name))
    .filter((tool): tool is NonNullable<ReturnType<typeof AgentToolCatalog.definitionFor>> => Boolean(tool));
}
```

- *Runtime-backed tools* come from
  [`ToolRuntime.schema()`](../../../../src/tools/runtime.ts#L96-L106) and carry
  the extra in-process fields `roles` (required) and `action` (optional):

  ```ts
  // src/tools/runtime.ts:18-26
  export interface ToolRegistrySchemaEntry<Name extends string = string> {
    type: 'function';
    function: { name: Name; description: string; parameters: JsonSchemaObject };
    roles: readonly PermissionRole[];
    action?: CardAction;
  }
  ```

- *Catalog fallback* comes from
  [`AgentToolCatalog.definitionFor`](../../../../src/agents/agent-tool-catalog.ts)
  and is a plain `ToolDefinition`:

  ```ts
  // src/agents/llm-contracts.ts:5-14
  export interface ToolFunctionDefinition { name: string; description: string; parameters: Record<string, unknown> }
  export interface ToolDefinition { type: 'function'; function: ToolFunctionDefinition }
  ```

The serializer must accept the union of both shapes and PROJECT down to a
wire-only shape, dropping `roles` and `action` (and any other in-process key
that may join the upstream surface in the future). It must NOT reject upstream
keys — doing so would make the new boundary incompatible with the live tool
path that flows through `ToolRuntime.schema()`.

### 1.2 Current wire reshape (inlined, untyped)

[`src/agents/llm-openai-chat-gateway.ts:176-177`](../../../../src/agents/llm-openai-chat-gateway.ts#L176-L177):

```ts
if (opts?.tools && opts.tools.length > 0) {
  requestBody.tools = opts.tools.map((t) => ({ type: t.type, function: t.function }));
}
```

The Chat reshape happens to project away `roles` / `action` only because it
rebuilds the top-level keys explicitly — but the inner `function` reference is
passed through by identity, so any future field on `ToolFunctionDefinition`
would leak. There is no static type guarding the output.

[`src/agents/llm-openai-codex-gateway.ts:122-123`](../../../../src/agents/llm-openai-codex-gateway.ts#L122-L123)
calls the private helper at
[`:181-188`](../../../../src/agents/llm-openai-codex-gateway.ts#L181-L188):

```ts
// :18
interface CodexTool { type: 'function'; name: string; description: string; parameters: Record<string, unknown>; }

// :122-123
if (opts?.tools && opts.tools.length > 0) {
  body.tools = opts.tools.map(codexTool);
}

// :181-188
function codexTool(tool: ToolDefinition): CodexTool {
  return { type: 'function', name: tool.function.name,
    description: tool.function.description, parameters: tool.function.parameters };
}
```

Codex flattens to the top level. The helper is typed against
`ToolDefinition`, which silently widens when a runtime entry is passed in
(`roles` / `action` are accepted by TypeScript via excess-property tolerance
for value sources).

Problems:
1. `WireToolDefinitionChat` is implicit — no nominal type, no `readonly`,
   no guarantee that a future `ToolFunctionDefinition` field stays out.
2. `CodexTool` is declared privately in the codex gateway and would be
   re-invented by any sibling provider.
3. No projection invariant is enforced: nothing structurally asserts that the
   wire object contains only the wire keys.
4. Cross-provider divergence (Chat keeps the `function` envelope; Codex
   flattens) lives inside the gateway alongside HTTP plumbing, mixing two
   concerns and making the wire contract hard to snapshot-test in isolation.

### 1.3 Why F05 does not cover this

F05 (`02-design-r4.md`) covers serialization of `AgentMessage[]` →
provider-specific message arrays (system / user / assistant / tool result, plus
the assistant `tool_calls` / Codex `function_call` items). F05's `assistant`
branch encodes *tool invocations the model produced*. The `tools[]` array at
request top-level is the *catalog of callable tools the model is allowed to
invoke* — a separate field, with separate types, populated from
`opts.tools`, not from `AgentMessage[]`. F05's serializer never reads
`opts.tools` and cannot. F06 is therefore not absorbable.

---

## 2. Design

### 2.1 New module

File: `src/agents/tool-definition-serializer.ts`.

```ts
import type { ToolDefinition } from './llm-contracts.js';
import type { ToolRegistrySchemaEntry } from '../tools/runtime.js';

// Union of every entry shape the agent layer hands to the gateway as opts.tools.
// Adding a third source (e.g. an MCP-derived definition) means widening this union,
// nothing else.
export type RuntimeToolEntry = ToolDefinition | ToolRegistrySchemaEntry;

// Wire shapes are nominal and frozen. Only these keys ever reach the provider.
export interface WireToolDefinitionChat {
  readonly type: 'function';
  readonly function: {
    readonly name: string;
    readonly description: string;
    readonly parameters: Readonly<Record<string, unknown>>;
  };
}

export interface WireToolDefinitionCodex {
  readonly type: 'function';
  readonly name: string;
  readonly description: string;
  readonly parameters: Readonly<Record<string, unknown>>;
}

function assertProjectableEntry(tool: unknown, index: number): asserts tool is RuntimeToolEntry {
  if (tool === null || typeof tool !== 'object') {
    throw new Error(`tool-definition-serializer: tools[${index}] must be an object`);
  }
  const obj = tool as { type?: unknown; function?: unknown };
  if (obj.type !== 'function') {
    throw new Error(`tool-definition-serializer: tools[${index}].type must be 'function'`);
  }
  const fn = obj.function;
  if (fn === null || typeof fn !== 'object') {
    throw new Error(`tool-definition-serializer: tools[${index}].function must be an object`);
  }
  const fnObj = fn as { name?: unknown; description?: unknown; parameters?: unknown };
  if (typeof fnObj.name !== 'string' || fnObj.name.length === 0) {
    throw new Error(`tool-definition-serializer: tools[${index}].function.name must be a non-empty string`);
  }
  if (typeof fnObj.description !== 'string' || fnObj.description.length === 0) {
    throw new Error(`tool-definition-serializer: tools[${index}].function.description must be a non-empty string`);
  }
  if (fnObj.parameters === null || typeof fnObj.parameters !== 'object' || Array.isArray(fnObj.parameters)) {
    throw new Error(`tool-definition-serializer: tools[${index}].function.parameters must be a JSON-schema object`);
  }
}

function assertNonEmpty(tools: readonly unknown[]): void {
  if (!Array.isArray(tools)) {
    throw new Error('tool-definition-serializer: tools must be an array');
  }
  if (tools.length === 0) {
    throw new Error('tool-definition-serializer: tools must not be empty');
  }
}

// Recursive deep-freeze for the parameters JSON-schema subtree. The catalog and
// runtime share these objects by reference; freezing prevents any later code path
// from mutating a schema after the wire array has been built.
function deepFreezeJson<T>(value: T): T {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as Record<string, unknown>)) deepFreezeJson(child);
  return Object.freeze(value);
}

export function serializeToolsForChat(tools: readonly RuntimeToolEntry[]): WireToolDefinitionChat[] {
  assertNonEmpty(tools);
  return tools.map((tool, i) => {
    assertProjectableEntry(tool, i);
    const parameters = deepFreezeJson(tool.function.parameters as Record<string, unknown>);
    return Object.freeze({
      type: 'function' as const,
      function: Object.freeze({
        name: tool.function.name,
        description: tool.function.description,
        parameters,
      }),
    });
  });
}

export function serializeToolsForCodex(tools: readonly RuntimeToolEntry[]): WireToolDefinitionCodex[] {
  assertNonEmpty(tools);
  return tools.map((tool, i) => {
    assertProjectableEntry(tool, i);
    const parameters = deepFreezeJson(tool.function.parameters as Record<string, unknown>);
    return Object.freeze({
      type: 'function' as const,
      name: tool.function.name,
      description: tool.function.description,
      parameters,
    });
  });
}
```

Design notes:
- **Projection, not strict allow-list.** The serializer accepts entries with
  in-process keys (`roles`, `action`, and any future sibling). It does NOT
  enumerate top-level keys with an `ALLOWED_*` set. The wire object is built
  fresh by listing the wire keys explicitly; nothing else can survive into the
  output. Static typing of the return type (`WireToolDefinitionChat` /
  `WireToolDefinitionCodex`) plus the snapshot tests in §2.3 lock that down.
- **Validation is on the projected fields**, not on the input shape: the four
  fields actually shipped (`type`, `function.name`, `function.description`,
  `function.parameters`) must each be present and well-typed. Anything else on
  the input is ignored.
- **Deep-freeze of `parameters`.** `Object.freeze` is shallow; the catalog and
  the runtime both share `parameters` objects by reference, so a shallow freeze
  would still let downstream code mutate nested arrays/objects. `deepFreezeJson`
  walks the JSON-schema subtree once. This is safe because schemas are intended
  to be immutable contracts; if any catalog construction code mutates a schema
  after registration today, that is a latent bug the freeze will surface as a
  loud `TypeError` rather than a silent wire change.
- **Readonly input.** `readonly RuntimeToolEntry[]` lets the gateway pass the
  array it received from `buildToolsForRole` directly without copying.
- **No JSON serialization, no transport concerns.** Pure data reshape and
  validation; the gateway still owns the `fetch` body.

### 2.2 Gateway swap-in

[`src/agents/llm-openai-chat-gateway.ts:176-177`](../../../../src/agents/llm-openai-chat-gateway.ts#L176-L177)
becomes:

```ts
if (opts?.tools && opts.tools.length > 0) {
  requestBody.tools = serializeToolsForChat(opts.tools);
}
```

[`src/agents/llm-openai-codex-gateway.ts:122-123`](../../../../src/agents/llm-openai-codex-gateway.ts#L122-L123)
becomes:

```ts
if (opts?.tools && opts.tools.length > 0) {
  body.tools = serializeToolsForCodex(opts.tools);
}
```

Delete:
- `codexTool` helper at
  [`llm-openai-codex-gateway.ts:181-188`](../../../../src/agents/llm-openai-codex-gateway.ts#L181-L188).
- Private `CodexTool` interface at
  [`llm-openai-codex-gateway.ts:18`](../../../../src/agents/llm-openai-codex-gateway.ts#L18)
  (replaced by the exported `WireToolDefinitionCodex`).

Add imports at the top of each gateway:

```ts
import { serializeToolsForChat /* or serializeToolsForCodex */ } from './tool-definition-serializer.js';
```

The gateway's `tools?: ToolDefinition[]` option type widens to
`tools?: RuntimeToolEntry[]` so the runtime-backed entries built by
`AgentToolExecutor.buildToolsForRole` are typed end-to-end without a cast.
Everything else in the gateways is unchanged.

### 2.3 Snapshot tests

File: `tests/agents/tool-definition-serializer.test.ts`.

```ts
import { describe, it, expect } from 'vitest';
import {
  serializeToolsForChat,
  serializeToolsForCodex,
  type RuntimeToolEntry,
} from '../../src/agents/tool-definition-serializer.js';
import { PLANNER_TOOL_DEFINITIONS, ALL_TOOL_DEFINITIONS_BY_NAME } from '../../src/agents/agent-tool-catalog.js';

const SAMPLE = [
  ALL_TOOL_DEFINITIONS_BY_NAME.get('list_project_files')!,
  ALL_TOOL_DEFINITIONS_BY_NAME.get('create_card')!,
  ALL_TOOL_DEFINITIONS_BY_NAME.get('load_skill')!,
];

// A runtime-shaped entry — must be projected, not rejected.
const RUNTIME_STYLE: RuntimeToolEntry = {
  type: 'function',
  function: {
    name: 'runtime_demo',
    description: 'runtime-backed tool',
    parameters: { type: 'object', properties: { x: { type: 'string' } }, required: ['x'], additionalProperties: false },
  },
  roles: ['planner', 'executor'],
  action: 'plan',
} as RuntimeToolEntry;

describe('tool-definition-serializer', () => {
  it('projects Chat wire entries from catalog tools (snapshot)', () => {
    expect(serializeToolsForChat(SAMPLE)).toMatchSnapshot();
  });

  it('projects Codex wire entries from catalog tools (snapshot)', () => {
    expect(serializeToolsForCodex(SAMPLE)).toMatchSnapshot();
  });

  it('projects runtime entries and strips roles/action for Chat', () => {
    const [wire] = serializeToolsForChat([RUNTIME_STYLE]);
    expect(Object.keys(wire).sort()).toEqual(['function', 'type']);
    expect(Object.keys(wire.function).sort()).toEqual(['description', 'name', 'parameters']);
    expect((wire as Record<string, unknown>).roles).toBeUndefined();
    expect((wire as Record<string, unknown>).action).toBeUndefined();
  });

  it('projects runtime entries and strips roles/action for Codex', () => {
    const [wire] = serializeToolsForCodex([RUNTIME_STYLE]);
    expect(Object.keys(wire).sort()).toEqual(['description', 'name', 'parameters', 'type']);
    expect((wire as Record<string, unknown>).roles).toBeUndefined();
    expect((wire as Record<string, unknown>).action).toBeUndefined();
    expect((wire as Record<string, unknown>).function).toBeUndefined();
  });

  it('projects the full planner catalog for Chat without throwing', () => {
    const wire = serializeToolsForChat(PLANNER_TOOL_DEFINITIONS);
    expect(wire.length).toBe(PLANNER_TOOL_DEFINITIONS.length);
    for (const t of wire) expect(t.type).toBe('function');
  });

  it('projects the full planner catalog for Codex without throwing', () => {
    const wire = serializeToolsForCodex(PLANNER_TOOL_DEFINITIONS);
    expect(wire.length).toBe(PLANNER_TOOL_DEFINITIONS.length);
    for (const t of wire) {
      expect(t.type).toBe('function');
      expect(typeof t.name).toBe('string');
      expect(typeof t.description).toBe('string');
      expect(typeof t.parameters).toBe('object');
    }
  });

  // Unit-level invariant: gateways already guard `opts.tools.length > 0` before
  // calling the serializer, so an empty array never reaches the wire in
  // production. The throw here is defence-in-depth for direct callers and tests.
  it('rejects empty arrays (unit invariant)', () => {
    expect(() => serializeToolsForChat([])).toThrow(/must not be empty/);
    expect(() => serializeToolsForCodex([])).toThrow(/must not be empty/);
  });

  it('rejects missing description / empty name', () => {
    expect(() => serializeToolsForChat([{ type: 'function', function: { name: '', description: 'd', parameters: {} } }] as any))
      .toThrow(/name must be a non-empty string/);
    expect(() => serializeToolsForChat([{ type: 'function', function: { name: 'n', description: '', parameters: {} } }] as any))
      .toThrow(/description must be a non-empty string/);
  });

  it('rejects non-object parameters', () => {
    expect(() => serializeToolsForCodex([{ type: 'function', function: { name: 'n', description: 'd', parameters: null } }] as any))
      .toThrow(/parameters must be a JSON-schema object/);
    expect(() => serializeToolsForCodex([{ type: 'function', function: { name: 'n', description: 'd', parameters: [] } }] as any))
      .toThrow(/parameters must be a JSON-schema object/);
  });

  it('rejects non-function type', () => {
    expect(() => serializeToolsForChat([{ type: 'custom', function: { name: 'n', description: 'd', parameters: {} } }] as any))
      .toThrow(/type must be 'function'/);
  });

  it('deep-freezes wire wrapper, function envelope, and parameters subtree', () => {
    const [first] = serializeToolsForChat(SAMPLE);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.function)).toBe(true);
    expect(Object.isFrozen(first.function.parameters)).toBe(true);
    const props = (first.function.parameters as { properties?: Record<string, unknown> }).properties;
    if (props) expect(Object.isFrozen(props)).toBe(true);
    const [firstCodex] = serializeToolsForCodex(SAMPLE);
    expect(Object.isFrozen(firstCodex)).toBe(true);
    expect(Object.isFrozen(firstCodex.parameters)).toBe(true);
  });
});
```

Snapshots check the exact wire shape: Chat keeps the `function` envelope,
Codex flattens `name` / `description` / `parameters` to the top level, and
the runtime-style projection tests assert that `roles` / `action` are absent
from both outputs. Snapshot drift on either side is a contract change that
requires explicit review.

### 2.4 Why projection over strict allow-list

A strict top-level allow-list (the approach in r2) would throw
`disallowed key 'roles'` on every planner/executor/reviewer call that uses a
runtime-backed tool, because `ToolRuntime.schema()` entries carry `roles` and
`action` by construction (see §1.1). That makes the new boundary incompatible
with the live tool path it is supposed to harden.

Projection achieves the same future-proofing goal — the wire object cannot
contain anything other than the wire keys — without coupling the serializer to
the upstream type's evolution. When a future field is added to
`ToolRegistrySchemaEntry` or `ToolFunctionDefinition`, the serializer is
unaffected; the wire stays exactly what the snapshot tests show.

### 2.5 Non-goals (explicit)

- F06 does NOT serialize assistant `tool_calls` or `tool` result messages —
  that is F05.
- F06 does NOT validate JSON-schema *contents* of `parameters` (only that it
  is a plain object). Schema-content validation belongs to a separate concern
  (catalog/runtime construction lint, not request-time).
- F06 does NOT change `ToolDefinition` or `ToolRegistrySchemaEntry`
  themselves — both stay the single source of truth for their respective
  authors. The serializer's `RuntimeToolEntry` is just a union over them.

---

## 3. Implementation plan

Single batch B1. All steps run from `/home/salva/g/ml/saivage-v3`.

### B1 — Serializer module + gateway swap-in + tests

1. Create `src/agents/tool-definition-serializer.ts` per §2.1.
2. Edit
   [src/agents/llm-openai-chat-gateway.ts](../../../../src/agents/llm-openai-chat-gateway.ts):
   - Add `import { serializeToolsForChat, type RuntimeToolEntry } from './tool-definition-serializer.js';`.
   - Widen the `tools?: ToolDefinition[]` option type to
     `tools?: RuntimeToolEntry[]`.
   - Replace the body of the `if (opts?.tools && opts.tools.length > 0)` block
     at lines 176-177 with `requestBody.tools = serializeToolsForChat(opts.tools);`.
3. Edit
   [src/agents/llm-openai-codex-gateway.ts](../../../../src/agents/llm-openai-codex-gateway.ts):
   - Add `import { serializeToolsForCodex, type RuntimeToolEntry } from './tool-definition-serializer.js';`.
   - Widen the `tools?: ToolDefinition[]` option type to
     `tools?: RuntimeToolEntry[]`.
   - Replace the body of the `if (opts?.tools && opts.tools.length > 0)` block
     at lines 122-123 with `body.tools = serializeToolsForCodex(opts.tools);`.
   - Delete the `interface CodexTool` at line 18.
   - Delete the `function codexTool(...)` at lines 181-188.
4. Create `tests/agents/tool-definition-serializer.test.ts` per §2.3.
5. Run, in order:
   - `npx tsc --noEmit` — must pass.
   - `npx vitest run tests/agents/tool-definition-serializer.test.ts` — must pass.
   - `npx vitest run tests/agents/` — regression sweep on adjacent gateway tests.
6. Green checkpoint: commit with message
   `F06: typed tool-definition serializer for Chat and Codex tools[]`.

### Risks and mitigations

- *Snapshot churn*: the first run writes snapshots; reviewer must inspect them
  to confirm Chat keeps `{ type, function: { ... } }`, Codex flattens, and
  runtime-only fields (`roles`, `action`) are absent.
- *Deep-freeze surfaces latent mutation*: if any current code path mutates a
  `parameters` schema after the gateway has serialized it (no such path is
  known), it will throw `TypeError: Cannot assign to read only property`. That
  is the intended failure mode; the fix is to stop mutating shared schemas.
- *Upstream type drift*: if a future PR adds a field to
  `ToolFunctionDefinition` or `ToolRegistrySchemaEntry`, the snapshot tests
  stay green because projection is by explicit key list; the new field simply
  does not reach the wire until the serializer is updated to forward it.
- *Empty `tools[]` regression*: the previous code silently no-op'd on empty
  arrays. Both gateways already guard
  [`opts.tools.length > 0`](../../../../src/agents/llm-openai-chat-gateway.ts#L176)
  and
  [the same](../../../../src/agents/llm-openai-codex-gateway.ts#L122)
  before reaching the serializer, so the serializer's throw is a unit-level
  invariant for direct callers and tests, not a production behaviour change.

---

## 4. Closure

F06 is closed by this design. Cross-link with F05:

- F05 (`02-design-r4.md`) owns: assistant message → wire (`tool_calls` items,
  Codex `function_call` / `function_call_output` items, role mapping).
- F06 (this doc) owns: upstream `RuntimeToolEntry[]` → wire `tools[]` array.

The two surfaces are adjacent and non-overlapping. Neither imports the other.
Both produce frozen wire objects that the gateway assembles into the final
request body.
