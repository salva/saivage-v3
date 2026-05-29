# F06 — APPROVED

- Combined analysis+design+plan: [COMBINED-r3.md](COMBINED-r3.md) — APPROVED at round 3.
- Selected proposal: **Proposal B — typed outbound `tool-definition-serializer.ts` module** with `WireToolDefinitionChat` / `WireToolDefinitionCodex` discriminated union and provider-specific projection from `RuntimeToolEntry`. Snapshot tests assert internal fields (`roles`, `action`) are stripped.
- Closes F06. Disjoint from F05 (assistant message serialization vs outbound tool definition serialization).
