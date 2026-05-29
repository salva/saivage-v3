# F08 — APPROVED

- Combined analysis+design+plan: [COMBINED-r2.md](COMBINED-r2.md) — APPROVED at round 2.
- Selected proposal: **Proposal B (level-up) — typed `LlmFailure` discriminated union + per-provider classifier table**. Eliminates string-classified failures; HTTP 400 contract errors classified as `ContractMismatch` (no failover, no cooldown).
- Closes F08. Cross-links: F05 (defines `LlmContractMismatchError`); F03 (consumes typed failures for `BLOCKED_UNTIL` / `COOLING`); F04 (failure type is a key field in `llm_attempt.outcome`).
- Sequencing: F08 should land BEFORE F03 wiring + F04 emission consumers.
