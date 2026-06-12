# Rejection decision — F03 PR-tip completion fixes

Rejected on 2026-05-27 by mailbox-015 PR-tip validation.

The proposal required all six F03 remediation items and green PR-tip validation before archival to `done/`. The current tip does not satisfy that all-or-nothing contract.

Blocking evidence:

- `architecture-audit/mailbox-015-f03-pr-tip-completion/validation/final-f03-grep-gates.stdout.log` shows producer-audit violations remain, including optional hard-coded fallback stamps in `src/agents/analyst-handler.ts`, local fake-agent stamp usage, runtime hard-coded stamp sites, and legacy conversation compatibility parsing.
- `architecture-audit/mailbox-015-f03-pr-tip-completion/validation/final-root-jest-rerun.stderr.log` shows full root Jest failed in `tests/server/analyst-tool-invoked-broadcast.test.ts` with `TypeError: this.activeRuntime?.stampUserMessage is not a function` at `src/agents/analyst-handler.ts:226`.
- `architecture-audit/mailbox-015-f03-pr-tip-completion/validation/final-web-test.stdout.log` / `.stderr.log` show the full web test gate is not green (`src/__tests__/read-only-positive-checklist.test.ts` failure reported by final reviewer). 
- The Manager attempted a direct correction, but it caused typecheck regressions and was reverted; `architecture-audit/mailbox-015-f03-pr-tip-completion/validation/manager-direct-patch2-typecheck.stdout.log` captures the failed attempt and `manager-restore-typecheck.stdout.log` confirms the revert restored typecheck.

Passing but insufficient gates include lint, root typecheck, web typecheck, focused `tests/server/agents-detail-route.test.ts`, build, docs:verify, and live health. These do not override the binding producer/root-Jest failures.

The proposal is therefore archived under `proposals-for-review/rejected/` rather than `done/`.
