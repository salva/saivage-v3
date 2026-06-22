# F04 — APPROVED

- Combined analysis+design+plan: [COMBINED-r3.md](COMBINED-r3.md) — APPROVED at round 3.
- Selected proposal: **Proposal B (level-up) — unified `llm_attempt` + `llm_invocation_summary` events**, with strict registry entries (separated `baseShape` + `refine`), single `recordAttemptOutcome` boundary, no double-emission.
- Closes F04. Subsumes F05's `terminal_tool` field into `llm_attempt.outcome` (variant `succeeded`).
