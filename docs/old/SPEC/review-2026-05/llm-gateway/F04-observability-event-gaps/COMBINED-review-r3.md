# F04 COMBINED r3 Review

No architectural blockers found. r3 closes the prior strict-schema composition issue by separating `baseShape` from `refine`, and it closes the summary-count issue by making `attempts_count` derive from emitted `llm_attempt` rows rather than outer recovery attempts.

Advisory: after F04 lands, F05 r4's `invocation_succeeded.terminal_tool` implementation steps should be applied to `llm_attempt.outcome.kind === 'succeeded'` and `llm_invocation_summary.final_terminal_tool`, as this document already states.

VERDICT: APPROVED