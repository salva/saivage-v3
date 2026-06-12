# F04 — Chat / analyst surface does not match v2 visual idiom

## Summary

v3's [AnalystChatPanel.vue](../../../web/src/components/chat/AnalystChatPanel.vue) is functional but visually impoverished compared to v2's [ChatWindow.vue](../../../../saivage/web/src/components/ChatWindow.vue):

- No header strip with session id, connection indicator (Wifi / WifiOff / ShieldAlert / Spinner), unauth panel.
- No role-tinted message bubbles (`entry-user`, `entry-warn`, `entry-danger`). Today v3 only flips the `background` for `role-user`.
- No model chip per assistant message (`shortModelLabel(msg)`), no `via` ambient logic.
- No thinking dots while a response is pending.
- No "jump to latest" floating button with unseen-message counter.
- No auth panel inline (v3 uses a separate `ApiTokenEntry` modal + global banner — fine, but the *inline* unauthorized affordance is missing inside the panel context).
- Composer is plain; v2's composer has resize-to-content, Enter/Shift+Enter discipline (v3 already has this), and a labeled Send icon button.

The port should not duplicate v2 wholesale — v3's analyst chat is the right-rail companion, not the main `dashboard` chat. The intent is to **lift the patterns** and re-apply them through the new primitives (F02):

- Use `<MessageBubble role tone>` for each entry.
- Use `<Pill>` for the model chip.
- Use `<StatusDot>` + `<Pill tone="warn">` for connection / unauthorized.
- Use `<ThinkingDots />` for in-flight assistant.
- Reuse `<ToolChip>` (defined in F03) for tool entries; the same component renders in both surfaces.

Functional behavior to copy:

- Auto-scroll stickiness (`stickToBottom`, `unseenCount`, `jumpToLatest`).
- Connection-status debounce (v2 debounces visible status by 400 ms — important on flaky links).
- Model chip with full string in `title` and short suffix in label.
- Markdown rendering inside assistant bubbles (already partially done via `MarkdownText`).

## Evidence

- v3 current:
  - [web/src/components/chat/AnalystChatPanel.vue](../../../web/src/components/chat/AnalystChatPanel.vue#L243-L420) — bespoke styles, hex literals, no role-tinted bubbles.
- v2 reference:
  - [saivage/web/src/components/ChatWindow.vue](../../../../saivage/web/src/components/ChatWindow.vue#L289-L675) — composer, role tinting, thinking dots, jump-to-latest.

## Category

Half-implemented. Functional regression vs v2.

## Severity

Medium.

## Transversality

Cross-cutting within the analyst surface; depends on F01/F02.
