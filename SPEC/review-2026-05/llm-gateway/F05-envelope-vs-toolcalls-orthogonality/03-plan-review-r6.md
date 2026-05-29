# F05 plan r6 review

## Blocking findings

1. B6's deleted-surface sweep cannot pass as written because it bans `response_format` under `tests/` while B2 explicitly requires request tests named `chat_request__never_sends_response_format` and `codex_request__never_sends_response_format` ([03-plan-r6.md](03-plan-r6.md#L188), [03-plan-r6.md](03-plan-r6.md#L195), [03-plan-r6.md](03-plan-r6.md#L462-L464)). The planned `scripts/check-no-legacy-toolcalls-wrapper.sh` will necessarily report the mandated request tests, and likely their negative property assertions too, so B6 cannot reach its required exit-0 validation. Fix by scoping this grep to production/build source, or by explicitly allowing the negative request tests and updating the sweep contract.

2. B5's focused Vitest command names test files that do not exist in the current tree and are not created by the plan: `src/__tests__/tool-presenters.test.ts` and `src/__tests__/analystChat.test.ts` ([03-plan-r6.md](03-plan-r6.md#L429)). The current web tests use paths such as [web/src/__tests__/analyst-chat-store.test.ts](../../../../web/src/__tests__/analyst-chat-store.test.ts) and presenter tests under [web/src/__tests__/tool-presenters/registry.test.ts](../../../../web/src/__tests__/tool-presenters/registry.test.ts); r6 only creates the terminal-tool viewer/event-log tests. As written, the focused B5 validation command will fail before the batch can be considered green. Fix the path list or add those tests explicitly in B5.

## Notes

The r5 live-probe artifact blocker is fixed: r6 moves the TypeScript probe under `src/scripts/` and updates the playbook to run `dist/src/scripts/probe-llm-contract.js`.

VERDICT: CHANGES_REQUESTED