# F02 — No hierarchical UI primitive layer

## Summary

In v3, every surface re-implements the same visuals inline: buttons, pills/tags, status dots, card-like panels, panel headings, modal overlays, toolbars, code surfaces. There is no `components/ui/` or primitives directory. Cards-view files alone duplicate ~5 button styles. Tool chips in `AgentConversationView` and `AnalystChatPanel` are visually similar but implemented twice with slightly different markup and class names. The result: every visual tweak requires N edits, with drift.

v2 partially solves this with **pattern classes** (`.btn`, `.btn-primary`, `.pill`, `.pill-warn`, `.card`, `.code-block`, `.panel-heading`, `.status-dot`) that any element can adopt. v2 does **not** wrap them in Vue components — that is the next conceptual layer, which v3 is in a better position to add because it already uses Vue SFCs heavily.

The port should pair the v2 pattern classes (F01) with a **thin layer of Vue primitives** that emit those classes and expose a typed props API:

```
web/src/components/ui/
  Button.vue          (variant: primary | default | danger; size: sm | md)
  Pill.vue            (tone: default | accent | warn | danger | purple)
  Card.vue            (active?: boolean)
  PanelHeading.vue    (slots: title / actions)
  StatusDot.vue       (tone)
  Overlay.vue         (teleport to body)
  Spinner.vue         (size)
  JsonView.vue        (data: unknown)      ← reuse v2's JsonHighlight
  FormattedContent.vue (content: string)   ← reuse v2's autodetect
  ToolChip.vue        (presented tool view + expand state)
  MessageBubble.vue   (role; slots: meta / content)
  ThinkingDots.vue
```

Container components (`AgentConversationView`, `AnalystChatPanel`, `CardDetailView`, `WorkspaceHeader`, …) then compose primitives; their scoped `<style>` only sets layout (grid, gaps, sticky), never colors or radii.

## Evidence

- v3 components with bespoke inline button styles:
  - [web/src/components/agents/AgentConversationView.vue](../../../web/src/components/agents/AgentConversationView.vue#L160) `.conv-tb-btn`
  - [web/src/components/chat/AnalystChatPanel.vue](../../../web/src/components/chat/AnalystChatPanel.vue#L380) `.primary-btn`
  - [web/src/components/layout/AppShell.vue](../../../web/src/components/layout/AppShell.vue#L190) `.auth-banner-action`, `.auth-banner-dismiss`
  - [web/src/components/cards/CardDetailView.vue](../../../web/src/components/cards/CardDetailView.vue) — its own buttons + pills
  - [web/src/components/cards/CardsBoardView.vue](../../../web/src/components/cards/CardsBoardView.vue) — ibid
- Pill-shaped status badges with duplicated styles:
  - `conv-status-badge.s-*` in AgentConversationView; `tool-chip-tag` in AnalystChatPanel; `pending-tool-tag` ibid; card status pills in cards/*.
- Tool chip implementations:
  - [web/src/components/agents/AgentConversationView.vue](../../../web/src/components/agents/AgentConversationView.vue#L60) (`tool-call` / `tool-result` blocks)
  - [web/src/components/chat/AnalystChatPanel.vue](../../../web/src/components/chat/AnalystChatPanel.vue#L30) (`tool-chip`).

## Category

Bad architecture / over-featurism by absence. Cross-cuts cards, chat, agents.

## Severity

High.

## Transversality

Architectural; almost every component is touched.
