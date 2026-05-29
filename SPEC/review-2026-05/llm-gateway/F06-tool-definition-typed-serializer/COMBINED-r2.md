# F06 — Tool Definition Typed Serializer (COMBINED-r2)

Status: Proposed (standalone, NOT absorbed by F05).
Scope: Outbound `tools[]` array in LLM requests — the boundary between the catalog
representation (`ToolDefinition` from `src/agents/llm-contracts.ts`) and the per-provider
wire shape. F05 is adjacent and owns the assistant-message serialization (function-call
items, tool result items). F06 owns tool *definition* serialization. The two surfaces
are disjoint.

---

## 1. Functional analysis (verified)

### 1.1 Current catalog shape

`src/agents/llm-contracts.ts:5-14`:

```ts
export interface ToolFunctionDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}
export interface ToolDefinition {
  type: 'function';
  function: ToolFunctionDefinition;
}
```

All catalog entries are produced via `tool(...)` in
`src/agents/agent-tool-catalog.ts:8-10`:

```ts
function tool(name, description, properties, required = []): ToolDefinition {
  return { type: 'function', function: { name, description,
    parameters: { type: 'object', properties, required, additionalProperties: false } } };
}
```

Exports (`agent-tool-catalog.ts:27`, `:131`, `:140-145`):
- `PLANNER_TOOL_DEFINITIONS: ToolDefinition[]`
- `ALL_TOOL_DEFINITIONS_BY_NAME: Map<string, ToolDefinition>`
- `AgentToolCatalog.definitionFor(name) → ToolDefinition | undefined`

Sibling sources feeding the catalog: `analyst-tool-schemas.ts`,
`workspace-tools.ts`, `skill-tools.ts`. All produce the same uniform shape
(`type: 'function'`, `function: { name, description, parameters }`) — there is no
`roles`, no `action`, no UI-only metadata on `ToolDefinition` today. The "strict
allow-list" therefore guards against future drift (e.g. a contributor adding a
`uiHint` or `roles` field to `ToolFunctionDefinition`) and against the inverse
direction (catalog regressions that drop `description` or send a non-object
`parameters`).

### 1.2 Current wire reshape (inlined, untyped)

`src/agents/llm-openai-chat-gateway.ts:176-177`:

```ts
if (opts?.tools && opts.tools.length > 0) {
  requestBody.tools = opts.tools.map((t) => ({ type: t.type, function: t.function }));
}
```

`src/agents/llm-openai-codex-gateway.ts:122-123` calls a private helper
`codexTool` defined at `:181-188`:

```ts
interface CodexTool { type: 'function'; name: string; description: string; parameters: Record<string, unknown>; }
function codexTool(tool: ToolDefinition): CodexTool {
  return { type: 'function', name: tool.function.name,
    description: tool.function.description, parameters: tool.function.parameters };
}
```

Problems:
1. `WireToolDefinitionChat` is implicit (an inline object literal typed as
   `{ type, function }` — no nominal type, no `readonly`, no rejection of
   surprise fields if `function` gains one).
2. `CodexTool` is declared in the codex gateway as a private `interface` and is
   not reused anywhere — a sibling provider would re-invent it.
3. Neither path validates input. An empty array, a `null` entry, or a malformed
   `parameters` value (e.g. `parameters: undefined` after a refactor) is shipped
   to the provider where it surfaces as an opaque 400.
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

## 2. Design — Proposal B (recommended)

### 2.1 New module

File: `src/agents/tool-definition-serializer.ts`.

```ts
import type { ToolDefinition } from './llm-contracts.js';

export interface WireToolDefinitionChat {
  readonly type: 'function';
  readonly function: {
    readonly name: string;
    readonly description: string;
    readonly parameters: Record<string, unknown>;
  };
}

export interface WireToolDefinitionCodex {
  readonly type: 'function';
  readonly name: string;
  readonly description: string;
  readonly parameters: Record<string, unknown>;
}

const ALLOWED_TOOL_KEYS = new Set(['type', 'function']);
const ALLOWED_FN_KEYS = new Set(['name', 'description', 'parameters']);

function assertCatalogShape(tool: unknown, index: number): asserts tool is ToolDefinition {
  if (tool === null || typeof tool !== 'object') {
    throw new Error(`tool-definition-serializer: tools[${index}] must be an object`);
  }
  const obj = tool as Record<string, unknown>;
  for (const k of Object.keys(obj)) {
    if (!ALLOWED_TOOL_KEYS.has(k)) {
      throw new Error(`tool-definition-serializer: tools[${index}] has disallowed key '${k}'`);
    }
  }
  if (obj.type !== 'function') {
    throw new Error(`tool-definition-serializer: tools[${index}].type must be 'function'`);
  }
  const fn = obj.function;
  if (fn === null || typeof fn !== 'object') {
    throw new Error(`tool-definition-serializer: tools[${index}].function must be an object`);
  }
  const fnObj = fn as Record<string, unknown>;
  for (const k of Object.keys(fnObj)) {
    if (!ALLOWED_FN_KEYS.has(k)) {
      throw new Error(`tool-definition-serializer: tools[${index}].function has disallowed key '${k}'`);
    }
  }
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

export function serializeToolsForChat(tools: readonly ToolDefinition[]): WireToolDefinitionChat[] {
  assertNonEmpty(tools);
  return tools.map((tool, i) => {
    assertCatalogShape(tool, i);
    return Object.freeze({
      type: 'function' as const,
      function: Object.freeze({
        name: tool.function.name,
        description: tool.function.description,
        parameters: tool.function.parameters,
      }),
    });
  });
}

export function serializeToolsForCodex(tools: readonly ToolDefinition[]): WireToolDefinitionCodex[] {
  assertNonEmpty(tools);
  return tools.map((tool, i) => {
    assertCatalogShape(tool, i);
    return Object.freeze({
      type: 'function' as const,
      name: tool.function.name,
      description: tool.function.description,
      parameters: tool.function.parameters,
    });
  });
}
```

Design notes:
- Both serializers throw on `tools === []`, `tools` not an array, any element
  not an object, any element carrying an unknown top-level key (future-proof
  against `roles` / `action` / UI fields leaking from the catalog), or any
  missing / wrong-typed required sub-field.
- `Object.freeze` enforces that downstream gateway code cannot mutate the wire
  object before fetch (defends against in-place edits during request shaping).
- `readonly ToolDefinition[]` input lets the gateway pass the catalog array
  directly without copying.
- No JSON serialization, no transport concerns, no provider HTTP knowledge —
  pure data reshape and validation.

### 2.2 Gateway swap-in

`src/agents/llm-openai-chat-gateway.ts:176-177` becomes:

```ts
if (opts?.tools && opts.tools.length > 0) {
  requestBody.tools = serializeToolsForChat(opts.tools);
}
```

`src/agents/llm-openai-codex-gateway.ts:122-123` becomes:

```ts
if (opts?.tools && opts.tools.length > 0) {
  body.tools = serializeToolsForCodex(opts.tools);
}
```

Delete:
- `codexTool` helper at `llm-openai-codex-gateway.ts:181-188`.
- Private `CodexTool` interface at `llm-openai-codex-gateway.ts:18` (replaced
  by the exported `WireToolDefinitionCodex`).

Add imports at the top of each gateway:

```ts
import { serializeToolsForChat /* or serializeToolsForCodex */ } from './tool-definition-serializer.js';
```

The gateway's `tools?: ToolDefinition[]` option type (e.g.
`llm-openai-chat-gateway.ts:22`) is unchanged — the catalog type stays the
public input.

### 2.3 Snapshot tests

File: `tests/agents/tool-definition-serializer.test.ts`.

Fixtures: import real entries from `agent-tool-catalog.ts` so the snapshot is a
live contract between catalog and provider wire.

```ts
import { describe, it, expect } from 'vitest';
import {
  serializeToolsForChat,
  serializeToolsForCodex,
} from '../../src/agents/tool-definition-serializer.js';
import { PLANNER_TOOL_DEFINITIONS, ALL_TOOL_DEFINITIONS_BY_NAME } from '../../src/agents/agent-tool-catalog.js';

const SAMPLE = [
  ALL_TOOL_DEFINITIONS_BY_NAME.get('list_project_files')!,
  ALL_TOOL_DEFINITIONS_BY_NAME.get('create_card')!,
  ALL_TOOL_DEFINITIONS_BY_NAME.get('load_skill')!,
];

describe('tool-definition-serializer', () => {
  it('serializes Chat tools array (snapshot)', () => {
    expect(serializeToolsForChat(SAMPLE)).toMatchSnapshot();
  });

  it('serializes Codex tools array (snapshot)', () => {
    expect(serializeToolsForCodex(SAMPLE)).toMatchSnapshot();
  });

  it('serializes the full planner catalog for Chat without throwing', () => {
    const wire = serializeToolsForChat(PLANNER_TOOL_DEFINITIONS);
    expect(wire.length).toBe(PLANNER_TOOL_DEFINITIONS.length);
    for (const t of wire) expect(t.type).toBe('function');
  });

  it('serializes the full planner catalog for Codex without throwing', () => {
    const wire = serializeToolsForCodex(PLANNER_TOOL_DEFINITIONS);
    expect(wire.length).toBe(PLANNER_TOOL_DEFINITIONS.length);
    for (const t of wire) {
      expect(t.type).toBe('function');
      expect(typeof t.name).toBe('string');
      expect(typeof t.description).toBe('string');
      expect(typeof t.parameters).toBe('object');
    }
  });

  it('rejects empty arrays', () => {
    expect(() => serializeToolsForChat([])).toThrow(/must not be empty/);
    expect(() => serializeToolsForCodex([])).toThrow(/must not be empty/);
  });

  it('rejects unknown top-level fields (future-proofing)', () => {
    const polluted = [{ type: 'function', function: { name: 'x', description: 'y', parameters: {} }, roles: ['planner'] }] as any;
    expect(() => serializeToolsForChat(polluted)).toThrow(/disallowed key 'roles'/);
    expect(() => serializeToolsForCodex(polluted)).toThrow(/disallowed key 'roles'/);
  });

  it('rejects unknown function fields', () => {
    const polluted = [{ type: 'function', function: { name: 'x', description: 'y', parameters: {}, uiHint: 'badge' } }] as any;
    expect(() => serializeToolsForChat(polluted)).toThrow(/disallowed key 'uiHint'/);
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

  it('freezes wire objects', () => {
    const [first] = serializeToolsForChat(SAMPLE);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.function)).toBe(true);
    const [firstCodex] = serializeToolsForCodex(SAMPLE);
    expect(Object.isFrozen(firstCodex)).toBe(true);
  });
});
```

Snapshots check the exact wire shape: Chat must keep the `function` envelope,
Codex must flatten `name` / `description` / `parameters` to the top level.
Snapshot drift on either side is a contract change that requires explicit
review.

### 2.4 Why Proposal B over alternatives

- *Proposal A — keep inline reshape, add a typed return*: leaves validation
  unaddressed; an empty `tools[]` still ships to the provider; a future
  catalog field still leaks.
- *Proposal C — push validation into the catalog `tool(...)` factory*: only
  guards entries built through that factory, not future direct-object
  contributions (e.g. external skill packs); also conflates catalog
  construction with wire concerns.
- Proposal B isolates the wire boundary in one file, lets each provider's
  shape be snapshotted independently, and trivially extends to a third
  provider (Anthropic, Gemini) by adding one more `serializeToolsForX`.

### 2.5 Non-goals (explicit)

- F06 does NOT serialize assistant `tool_calls` or `tool` result messages —
  that is F05.
- F06 does NOT validate JSON-schema *contents* of `parameters` (only that it
  is a plain object). Schema validation belongs to a separate concern
  (catalog-time lint, not request-time).
- F06 does NOT change `ToolDefinition` itself — the catalog type stays the
  single source of truth for tool authors.

---

## 3. Implementation plan

Single batch B1. All steps run from `/home/salva/g/ml/saivage-v3`.

### B1 — Serializer module + gateway swap-in + tests

1. Create `src/agents/tool-definition-serializer.ts` per §2.1.
2. Edit `src/agents/llm-openai-chat-gateway.ts`:
   - Add `import { serializeToolsForChat } from './tool-definition-serializer.js';`.
   - Replace the body of the `if (opts?.tools && opts.tools.length > 0)` block
     at line 176-177 with `requestBody.tools = serializeToolsForChat(opts.tools);`.
3. Edit `src/agents/llm-openai-codex-gateway.ts`:
   - Add `import { serializeToolsForCodex } from './tool-definition-serializer.js';`.
   - Replace the body of the `if (opts?.tools && opts.tools.length > 0)` block
     at line 122-123 with `body.tools = serializeToolsForCodex(opts.tools);`.
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
  to confirm Chat keeps `{ type, function: { ... } }` and Codex flattens.
- *Catalog future drift*: if a future PR adds a field to
  `ToolFunctionDefinition` (e.g. `strict: boolean` for OpenAI strict mode),
  both `ALLOWED_FN_KEYS` and both wire types must be updated together — the
  thrown error makes this loud, not silent.
- *Empty `tools[]` regression*: the previous code silently no-op'd on empty
  arrays (the `if` guard). The serializer now throws, but the gateway's
  `if (opts?.tools && opts.tools.length > 0)` guard already filters that case
  before reaching the serializer, so behaviour is preserved.

---

## 4. Closure

F06 is closed by this design. Cross-link with F05:

- F05 (`02-design-r4.md`) owns: assistant message → wire (`tool_calls` items,
  Codex `function_call` / `function_call_output` items, role mapping).
- F06 (this doc) owns: catalog `ToolDefinition[]` → wire `tools[]` array.

The two surfaces are adjacent and non-overlapping. Neither imports the other.
Both share `ToolDefinition` from `src/agents/llm-contracts.ts` as the upstream
type, and both produce frozen wire objects that the gateway assembles into the
final request body.
