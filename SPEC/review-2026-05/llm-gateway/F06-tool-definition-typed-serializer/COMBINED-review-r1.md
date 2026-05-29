# F06 Combined r1 Review

## Findings

### Architectural blocker: ABSORBED-BY-F05 is not sound against F05 r4

F06 correctly identifies the needed typed outbound serializer surface, but its closure recommendation depends on F05 already owning that surface. Cross-checking F05 r4 shows that F05 owns provider-neutral `TerminalChoice` and per-provider `tool_choice` translation, and §8.1 freezes chat vs Codex request shapes in tests. It does not introduce a typed serializer module or return types for full outbound `tools[]` entries for both chat and Codex gateways.

The decisive evidence is that F05 r4 still describes chat/Codex request shaping in the gateway builders and explicitly references the existing Codex `CodexTool` / `codexTool` shape, while its implementation order never creates `wire-tool-definition.ts`, `ChatWireTool`, `CodexWireTool`, `serializeToolForChat`, or `serializeToolForCodex`. Gateway snapshot assertions are valuable, but they are not the architecture surface F06 is about: they do not make `roles`, `action`, or future runtime-only fields structurally impossible to leak.

Per the review policy, because F05 does not already provide the typed outbound tool serializer surface for both gateways, F06 cannot be closed as ABSORBED-BY-F05. It needs a standalone proposal that normatively owns the serializer module, chat/Codex call-site replacements, and exact-key tests, unless F05 r4 is revised first to include those requirements as part of its own implementation plan.

## Notes

The proposed serializer shape in F06 §2.2 is architecturally reasonable: keep `LlmToolsOptions.tools` internal as `ToolDefinition[]`, translate once at the gateway boundary, and use separate typed functions for nested chat tools and flat Codex tools. The issue is not the design content; it is the closure path.

VERDICT: CHANGES_REQUESTED