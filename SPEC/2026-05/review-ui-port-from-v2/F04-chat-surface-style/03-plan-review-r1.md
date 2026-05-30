# F04 - Chat / analyst surface style - Plan review (r1)

Reviewer round 1 for [03-plan-r1.md](03-plan-r1.md), checked against the approved design [02-design-r2.md](02-design-r2.md), approved analysis [01-analysis-r3.md](01-analysis-r3.md), and the F03 implementation plan [../F03-conversation-rounds/03-plan-r1.md](../F03-conversation-rounds/03-plan-r1.md).

## Blocking finding

1. The no-alias selector contract is internally inconsistent with the B4 component sketches.

   The plan correctly restates the architecture-first rule: no legacy class aliases, no new alias period, and no survivors for `.composer-input`, `.pending-tool-*`, `.message-badges`, `.state-panel`, `.on-screen-section`, `.message-bubble`, `.primary-btn`, or `.tool-chip*`. It also adds a PR merge gate requiring:

   ```bash
   rg -n "(tool-chip|message-bubble|primary-btn|composer-input|pending-tool-|message-badges|state-panel|on-screen-section)" web/src/components/chat/
   ```

   to print nothing.

   However, B4's concrete SFC sketches reintroduce several of those exact selector families in the new children:

   - `ChatComposer.vue`: `class="chat-composer"` and `class="composer-input"`.
   - `MessageList.vue`: `class="pending-tool-list"`, which matches the prohibited `pending-tool-` family.
   - `MessageItem.vue`: `class="message-badges"`.

   B5 only deletes these names from `AnalystChatPanel.vue`, while the final gate checks the whole `web/src/components/chat/` tree. An implementer cannot both follow the plan's "verbatim" component instructions and satisfy the no-alias / merge gates. This is directly blocking for item 6 in the review brief.

   Required correction: rename the new child-component layout classes to non-legacy names, and update the B4 sketches, B5 deletion checklist, B6 selector assumptions, and merge-gate grep accordingly. Examples: `chat-composer` -> `composer-form`, `composer-input` -> `composer-textarea`, `pending-tool-list` -> `pending-invocations`, `message-badges` -> `badge-stack`. The exact names are less important than making the plan self-consistent and preserving the no-new-alias-period rule.

## Non-blocking assessment

- Per-file implementability is otherwise strong. The file inventory is complete, ownership is clear, and B0/B2/B3/B4/B5 give enough implementation detail per file for a developer to execute without inventing missing contracts.
- The commit ordering is sound: type surface first, consumer grep checkpoint, leaf composables, pure model-label utility, child SFCs, then the container rewrite. Creating all children in B4 before B5 consumes them avoids a half-wired container. `MessageList.vue` comes after `MessageItem.vue`, and the presentational components (`UnauthorizedNotice`, `JumpToLatest`, `ChatHeader`, `ChatComposer`) are independent enough to be created in the listed order.
- The `ChatMessage` additive metadata boundary is correct. B0 adds only optional fields and promotes `PendingToolInvocation`; consumption is delayed until `model-label.ts` and `MessageItem.vue`. No store-shape extension is introduced for `thinking`, matching the approved design.
- Test rewrite scope is appropriate. `analyst-chat-panel.test.ts` is a true rewrite for selectors, model-pill gating, thinking dots, connection state, focus, state panels, and expansion content. `analyst-chat-store.test.ts` stays narrow: fixtures and type import only. `components/AnalystChatPanel.children.test.ts` correctly keeps behavior coverage, preserves the `.on-screen-children li` selector, and retargets the raw-source guard to the rewritten container.
- Cross-issue dependencies are correctly stated. The plan requires F01, F02, F05, and F03 before F04, and it correctly leaves the in-place analyst chip swap to F03. F04 only relocates the already-swapped call sites during decomposition.
- The plan does not introduce a new alias period in intent, but the class-name contradiction above must be fixed before approval.

VERDICT: CHANGES_REQUESTED