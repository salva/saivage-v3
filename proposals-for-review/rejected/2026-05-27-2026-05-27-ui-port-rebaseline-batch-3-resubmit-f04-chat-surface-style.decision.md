# Rejection decision — F04 chat surface style resubmit

Rejected on 2026-05-27 by mailbox-016 precondition check.

The live proposal `2026-05-27-ui-port-rebaseline-batch-3-resubmit-f04-chat-surface-style.md` is Branch B design-included, so no dual-proposal review was run and no scope variation was attempted. The proposal itself requires F03/R2 to be merged before F04/R3 starts and says that if any precondition is missing the harness must reject or file a delta rather than decomposing the current panel.

## Blocking precondition failures

1. **F03/R2 remains rejected/incomplete.** `architecture-audit/mailbox-015-f03-pr-tip-completion/implementation-log.md` records: "Rejected at PR-tip validation" and says the F03 proposal was not archived to `done/` because required producer-audit/root-Jest gates remain red. Rows 1 and 6 in that log remain incomplete, and root Jest failed with `TypeError: this.activeRuntime?.stampUserMessage is not a function`.
2. **The prior F03 rejection decision is still binding evidence.** `proposals-for-review/rejected/2026-05-27-2026-05-27-ui-port-rebaseline-batch-2-completion-f03-pr-tip-fixes.decision.md` states that the current tip "does not satisfy that all-or-nothing contract" and cites remaining producer-audit violations, failed full root Jest, and failed web test evidence.
3. **The chat tool-chip adapter does not match the F04/F03 required signature.** The required precondition is `adaptChatMessageToToolChip(call, result, expanded)`. Current `web/src/components/chat/tool-chip-adapter.ts` exports `adaptChatMessageToToolChip(message: ChatMessage, expanded: boolean)`, a two-argument message adapter, while `adaptPendingInvocationToToolChip(pending, expanded)` exists.
4. **Current `AnalystChatPanel.vue` is not an accepted F03/R2 substrate.** Although the literal inline `<button class="tool-chip">` marker is absent, the panel still contains old monolithic chat-surface markers such as `state-panel`, `on-screen-section`, `message-bubble`, `message-badges`, `pending-tool`, `chat-composer`, `composer-input`, and `primary-btn`; F04 cannot safely rewrite this on top of a rejected/incomplete F03 batch.

Passing but insufficient preconditions include the F02/R1 UI primitives, `MessageBubble.vue`, `ThinkingDots.vue`, the eight-prop `ToolChip.vue` including `callContent` and `resultContent`, agent-timeline utilities, and `useAgentTimeline.ts`.

## Outcome

The proposal is archived to `proposals-for-review/rejected/2026-05-27-2026-05-27-ui-port-rebaseline-batch-3-resubmit-f04-chat-surface-style.md` rather than `done/`.

No F04 source implementation was attempted. The next appropriate action is to complete/accept the F03/R2 substrate first, including the producer/root-Jest gates and the required chat adapter signature, then resubmit F04 if still desired.
