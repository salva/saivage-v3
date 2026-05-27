# Rejection decision — F03 conversation rounds rebaseline batch 2

Decision date: 2026-05-27

## Decision

Rejected for this mailbox cycle. The approved Branch B F03 contract cannot be marked complete in the current corrective implementation attempt without violating the all-or-nothing constraint.

## Reason

The governing artifacts require the full F03 §3 + §4 + §5 union to land together: backend schema/runtime round stamping, every producer in the §4 audit, server and websocket contract changes, web API/store/timeline/component rewrites, required deletions, validation, and archive evidence. Current evidence shows the tree still has the pre-F03 architecture and the required new F03 files and markers are absent.

A subset implementation is explicitly forbidden by the proposal and stage plan. Accepting a partial rewrite would leave incompatible message/wire shapes and preserve legacy surfaces that the contract requires deleting.

## Evidence

- `architecture-audit/mailbox-011-ui-port-rebaseline-batch-2/stage-plan.md` binds this cycle to the full F3-S1 through F3-S9 coverage table.
- `architecture-audit/mailbox-011-ui-port-rebaseline-batch-2/implementation-log.md` records that no source implementation was produced and that F03 remains unimplemented.
- `architecture-audit/mailbox-011-ui-port-rebaseline-batch-2/validation/retry-added-files-audit.stdout.log` records required F03 added files still missing.
- `architecture-audit/mailbox-011-ui-port-rebaseline-batch-2/validation/retry-f03-marker-grep.stdout.log` records no F03 schema/runtime/web markers found.
- `architecture-audit/mailbox-011-ui-port-rebaseline-batch-2/validation/retry-legacy-shape-grep.stdout.log` records required-delete legacy shapes still present.
- `architecture-audit/mailbox-011-ui-port-rebaseline-batch-2/validation/formal-rejection-evidence.stdout.log` captures the final live-mailbox and legacy-shape check before the rejection move.

## Analyst authorization directive

No touched analyst/runtime/model code adds or preserves any runtime-forced analyst authorization requirement over model selection. Because the F03 implementation did not proceed, broader removal of any remaining model-authorization behavior is left as a follow-up candidate outside this rejected mailbox cycle.

## Follow-up candidate

Run a new approved delta/implementation cycle that either allocates the full F03 F3-S1 through F3-S9 rewrite in one all-or-nothing pass or formally revises the Branch B contract to split the work safely. The split must be reviewed before implementation because the current approved proposal forbids subset completion.
