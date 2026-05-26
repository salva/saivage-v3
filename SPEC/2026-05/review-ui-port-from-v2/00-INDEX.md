# Issue Inventory — UI Port from Saivage v2 to v3

This inventory frames the port as discrete, dual-LLM-reviewable issues. Each `Fxx` becomes a directory under this folder with the writer/reviewer rounds.

| ID  | Title                                                | Severity | Transversality |
|-----|------------------------------------------------------|----------|----------------|
| F01 | No global design-token / semantic CSS layer          | high     | architectural  |
| F02 | No hierarchical UI primitive layer                   | high     | architectural  |
| F03 | Agent conversation lacks round/diagnostic structure  | high     | cross-cutting  |
| F04 | Chat / analyst surfaces do not match v2 visual idiom | medium   | cross-cutting  |
| F05 | Tool-call / JSON detail rendering is minimal         | medium   | localized      |

Issue files: [F01-design-tokens.md](F01-design-tokens.md), [F02-component-hierarchy.md](F02-component-hierarchy.md), [F03-conversation-rounds.md](F03-conversation-rounds.md), [F04-chat-surface-style.md](F04-chat-surface-style.md), [F05-tool-detail-rendering.md](F05-tool-detail-rendering.md).

## Cross-issue dependencies

- F02 depends on F01 (primitives consume semantic tokens).
- F03 depends on F01 + F02 (the round timeline reuses primitives and tokens).
- F04 depends on F01 + F02.
- F05 depends on F01 (syntax token vars) and is consumed by F03/F04.

Order for the metaplan: **F01 → F02 → F05 → F03 → F04**.
