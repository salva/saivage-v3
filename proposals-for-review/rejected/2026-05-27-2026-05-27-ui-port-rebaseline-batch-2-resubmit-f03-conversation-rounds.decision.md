# Rejection decision — F03 conversation rounds resubmit

Rejected on 2026-05-27 by mailbox-013 PR-tip validation.

The resubmitted Branch B proposal authorized intermediate red states, but still required the final PR tip to satisfy the full F03 §3 + §4 + §5 contract with green or explicitly attributed validation. The current tip does not satisfy that requirement.

Blocking evidence:

- `architecture-audit/mailbox-013-ui-port-rebaseline-batch-2-resubmit/validation/t3-producer-audit-git-grep.stdout.log` shows remaining legacy producer/deletion violations, including local `appendMessage`/`readMessages` in `src/agents/analyst-handler.ts` and manual `AgentMessage` literals in `src/agents/compaction.ts`.
- `architecture-audit/mailbox-013-ui-port-rebaseline-batch-2-resubmit/validation/t3-focused-vitest.stderr.log` shows `ToolChip` still nests an anchor under `button.tool-chip-toggle`, failing the one-button/sibling-link contract.
- `architecture-audit/mailbox-013-ui-port-rebaseline-batch-2-resubmit/validation/t3-full-jest.stderr.log` shows `tests/server/agents-detail-route.test.ts` failing with HTTP 500 instead of 200.
- `architecture-audit/mailbox-013-ui-port-rebaseline-batch-2-resubmit/validation/t3-web-test.stderr.log` shows full web test failures in ToolChip, AnalystChatPanel, and stale AgentConversationView checklist assertions.
- `architecture-audit/mailbox-013-ui-port-rebaseline-batch-2-resubmit/validation/t3-e2e-smoke.stdout.log` shows the Playwright smoke test cannot find the expected synthetic agent transcript.

Passing but insufficient gates included root typecheck, web typecheck, lint, build, docs:verify, and basic live health/root/runtime reachability probes. Those passes do not override the binding all-or-nothing F03 failures above.

The proposal is therefore archived under `proposals-for-review/rejected/` instead of `done/`. A future resubmission should either complete the full F03 contract and reconcile the failing validations, or submit a delta proposal explaining a concrete contract contradiction.
