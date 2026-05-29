# F06 — No typed serializer for the on-the-wire tool definition

## Summary

The shape of a tool definition that goes out on the wire is defined twice (once by `ToolRuntime.schema()` and once by `agent-tool-catalog.ts`), then reshaped ad-hoc by each provider gateway. There is no single typed serializer, no snapshot test, and no contract assertion that the wire shape excludes Saivage-internal fields (`roles`, `action`, `targetState` rules, etc.). Today only `roles`/`action` are silently dropped because the chat gateway happens to map `{ type, function }`; the next contributor who adds a field to `RuntimeToolDefinition` will leak it.

## Evidence

Internal shape, with extra fields:
- [src/tools/runtime.ts#L96-L107](src/tools/runtime.ts#L96)
```ts
schema(): ToolRegistrySchemaEntry[] {
  return [...this.definitions.values()].map((definition) => ({
    type: 'function',
    function: { name, description, parameters },
    roles: definition.roles,
    action: definition.action,
  }));
}
```

Ad-hoc strip at the chat gateway:
- [src/agents/llm-openai-chat-gateway.ts#L160-L168](src/agents/llm-openai-chat-gateway.ts#L160) — `body.tools = opts.tools.map((t) => ({ type: t.type, function: t.function }));`

Different reshape at the codex gateway:
- [src/agents/llm-openai-codex-gateway.ts#L106-L130](src/agents/llm-openai-codex-gateway.ts#L106) — wraps as `{ type: 'function', name, description, parameters }` (flat, not nested under `function`).

Two sources of truth for the catalog:
- `agent-tool-catalog.ts` lists `PLANNER_TOOL_DEFINITIONS` and `ROLE_TOOL_NAMES` manually ([src/agents/agent-tool-catalog.ts#L26-L75](src/agents/agent-tool-catalog.ts#L26)).
- `ToolRuntime` is the runtime-time registry built from `tool({...})` factories in `src/tools/agent-tools.ts`.
- `RoleToolPolicy.listToolNamesForRole` picks the runtime view first ([src/agents/role-tool-policy.ts#L64](src/agents/role-tool-policy.ts#L64)) and falls back to the catalog.

## Category

architectural / contract hygiene

## Severity

medium — no current observable failure, but the design has already produced two near-bugs (`roles`/`action` would leak verbatim if the gateways had not stripped them; the codex gateway's flat shape diverges from the chat gateway's nested one).

## Transversality

scoped: runtime + 2 gateways + 1 catalog file.

## Recommended direction

- Introduce a single `serializeToolForProvider(definition, provider)` function whose return type is a discriminated union over provider shapes (`OpenAIChatTool`, `OpenAICodexTool`). Build the wire body from these typed values; neither gateway re-shapes.
- Replace the ad-hoc `[].map((t) => ({ type: t.type, function: t.function }))` in `OpenAIChatGateway` with that serializer.
- Add one snapshot test per provider that exercises the planner role's tool list and freezes the wire shape, so regressions surface in CI.

## Cross-links

- F05 — both are about boundaries that conflate internal and wire shapes.
- F10 — `response_format` is similarly leaked through with no typed normalization.
