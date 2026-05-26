# Rejection decision — F04 chat surface style

Rejected/deferred on 2026-05-26.

Reason: the proposal is stale against current code and depends on F03, which was rejected/deferred in mailbox-006. Current `ToolChip.vue` still uses the F05 presentation API (`presentation`, `expanded`, `variant`, `labelPrefix`) rather than the F03/F04 eight-prop call/result contract. The current analyst chat surface is still a monolithic `AnalystChatPanel.vue`; implementing F04 exactly would require a broad component/composable/type/test rewrite plus a shared chip-contract migration.

A partial patch would violate the proposal’s binding rule against aliases, fallback styles, shims, and chat-local chip APIs. Replan this work as a future wave or fresh proposal after the shared conversation/tool-chip contract is reconciled.

Evidence: `architecture-audit/mailbox-007-ui-port-f04-chat-surface-style/scope-check.md` and `architecture-audit/mailbox-007-ui-port-f04-chat-surface-style/validation/current-code-evidence.stdout.log`.
