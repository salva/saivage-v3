# Rejection decision — F04 chat surface style rebaseline batch 3

Decision date: 2026-05-27

## Decision

Rejected for this mailbox cycle. F04 R3 is blocked because the required F03/R2 preconditions are missing at current HEAD.

## Reason

The live F04 Branch B proposal and approved rebaseline addendum both require F03/R2 to land before F04 begins. They specifically require the eight-prop `ToolChip` surface with `callContent` and `resultContent`, the chat `tool-chip-adapter.ts` exports, the `agent-timeline` utilities, `useAgentTimeline.ts`, and removal of inline chat tool-chip markup from `AnalystChatPanel.vue`.

Current evidence shows these conditions are not met. The prior F03 batch was formally rejected and remains unimplemented. Therefore F04 cannot be implemented without decomposing a flat/pre-F03 chat surface, which the proposal explicitly forbids.

## Evidence

- `architecture-audit/mailbox-012-ui-port-rebaseline-batch-3/classification.md` classifies the proposal as Branch B and records that dual proposals are forbidden.
- `architecture-audit/mailbox-012-ui-port-rebaseline-batch-3/stage-plan.md` records the F04 §3 coverage table and the hard precondition checks.
- `architecture-audit/mailbox-012-ui-port-rebaseline-batch-3/validation/precondition-evidence.stdout.log` records:
  - `ToolChip.vue` currently exposes only `presentation`, `expanded`, `variant`, and `labelPrefix`, not the required eight-prop bag.
  - no `callContent` / `resultContent` props in `ToolChip.vue`.
  - missing `web/src/components/chat/tool-chip-adapter.ts`.
  - missing `web/src/utils/agent-timeline/`.
  - missing `web/src/composables/useAgentTimeline.ts`.
  - `AnalystChatPanel.vue` still contains inline `class="tool-chip pending"`, `pending-tool-*`, `message-bubble`, `message-badges`, `state-panel`, `on-screen-section`, `chat-composer`, `composer-input`, local `ChipParts`, `toolChipParts`, and `toolChipVariant` markers.
- `architecture-audit/mailbox-011-ui-port-rebaseline-batch-2/implementation-log.md` records F03 as rejected and unimplemented.
- `proposals-for-review/rejected/2026-05-27-2026-05-27-ui-port-rebaseline-batch-2-f03-conversation-rounds.decision.md` states the tree still has the pre-F03 architecture and the required F03 files and markers are absent.

## Scope discipline

No source files under `web/src/components/chat/` or related F04 implementation files were changed. No backend, F03 pipeline, conversation primitive, README, later mailbox, wave, or analyst-authorization work was performed.

## Follow-up

A future approved cycle must first land or formally revise the F03/R2 conversation-rounds contract. Only after the F03/R2 preconditions exist at HEAD may F04 be reintroduced for implementation.
