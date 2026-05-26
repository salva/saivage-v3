# Rejection decision — F03 conversation rounds

Rejected/deferred on 2026-05-26 during mailbox-006.

## Reason

The proposal requires an atomic, broad backend/frontend conversation wire migration that is not safe as a bounded mailbox patch against the current tree. Current code still uses flat `messages`, lacks required round/message/block stamps in the persisted schema, retains many unstamped producers, and has a different F05 `ToolChip` prop contract than the F03 design assumes.

## Evidence

See `architecture-audit/mailbox-006-ui-port-f03-conversation-rounds/scope-check.md` and `architecture-audit/mailbox-006-ui-port-f03-conversation-rounds/validation/current-code-evidence.stdout.log`.

## Follow-up

Replan as a future architecture wave or fresh mailbox proposal against current code, explicitly reconciling the current F05 ToolChip contract and the full producer stamping migration before deleting the flat conversation surface.
