# F01 — No global design-token / semantic CSS layer

## Summary

The v3 web app has no global stylesheet. `web/src/main.ts` only imports `highlight.js`. Every Vue component scopes its own `<style>` block and hard-codes GitHub-dark hex literals (`#0d1117`, `#161b22`, `#21262d`, `#30363d`, `#58a6ff`, `#7ee787`, `#f85149`, `#d2a8ff`, `#c9d1d9`, `#8b949e`, `#484f58`, …). This means:

- Color changes require touching every component.
- Semantically equivalent things (e.g. "border on a surface") use 4–5 slightly different hex values across files.
- There is no theming / accessibility lever, no dark/light split, no path to a single source of truth.
- Tests that snapshot HTML drift when one component is restyled.

v2 solves this with a four-file pipeline in [saivage/web/src/styles/](../../../../saivage/web/src/styles/): `tokens.css` (raw palette) → `semantic.css` (named variables) → `base.css` (resets) → `patterns.css` (reusable classes). v2 is a **light** theme; v3 must stay dark, so the values must be re-derived while keeping the variable **names** identical so patterns and components are theme-portable.

## Evidence

- v3 has no `styles/` directory:
  - [web/src/main.ts](../../../web/src/main.ts) — the only CSS import is `highlight.js/styles/github-dark.css`.
- Hex literals scattered throughout v3 components, e.g.:
  - [web/src/components/layout/AppShell.vue](../../../web/src/components/layout/AppShell.vue#L160) — `background:#0d1117`, `background:#241818`, `border-bottom:1px solid #da3633`.
  - [web/src/components/chat/AnalystChatPanel.vue](../../../web/src/components/chat/AnalystChatPanel.vue#L235) — full GitHub-dark palette inline.
  - [web/src/components/agents/AgentConversationView.vue](../../../web/src/components/agents/AgentConversationView.vue#L150) — same.
- v2 source to port:
  - [saivage/web/src/styles/tokens.css](../../../../saivage/web/src/styles/tokens.css)
  - [saivage/web/src/styles/semantic.css](../../../../saivage/web/src/styles/semantic.css)
  - [saivage/web/src/styles/base.css](../../../../saivage/web/src/styles/base.css)
  - [saivage/web/src/styles/patterns.css](../../../../saivage/web/src/styles/patterns.css)
  - [saivage/web/src/styles/index.css](../../../../saivage/web/src/styles/index.css)

## Category

Bad design / over-featurism by omission. Cross-cuts every UI file.

## Severity

High. Without F01 no other issue can be cleanly closed, because they all need stable semantic variables.

## Transversality

Architectural. Touches every `*.vue` `<style>` block. Affects ~30 components.
