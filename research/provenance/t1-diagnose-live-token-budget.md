# t1-diagnose-live-token-budget provenance

Access date: 2026-06-01T04:06Z UTC.

Purpose: Acquire redacted live evidence identifying which planner prompt/context section remains oversized after prior compaction, and confirm reviewer capacity/current runtime state.

Sources and methods:
- Local runtime state and cards under `/work/diedrico-lessons/.saivage/`, accessed by bounded Python probes that emitted metadata, byte sizes, status fields, event kind/role/failure flags, and schema/key shapes only. Raw card bodies, raw event payloads, auth/provider values, and secret-shaped values were not copied into this note or report.
- Service/HTTP checks: status-only `systemctl is-active`, selected `systemctl show` properties for `saivage-v3.service` and `diedrico.service`, and HTTP status/content-type/first-byte-count checks for `http://localhost:8081/health`, `http://localhost:8081/health/ready`, and `http://localhost:5173/`.
- Narrow source-code inspection of `src/runtime/runtime.ts` and `src/agents/system-prompt.ts` to map live oversized sections to prompt assembly functions. No source code was modified.
- Redacted journal scan counted only diagnostic keywords from recent entries; raw journal lines were not persisted in reports.

Artifacts written:
- `.saivage/stages/repair-live-planner-token-budget-002/data/t1-redacted-live-probe.stdout`
- `.saivage/stages/repair-live-planner-token-budget-002/data/t1-redacted-live-probe.stderr`
- `.saivage/stages/repair-live-planner-token-budget-002/data/t1-code-locations.stdout`
- `.saivage/stages/repair-live-planner-token-budget-002/data/t1-code-locations.stderr`
- `.saivage/stages/repair-live-planner-token-budget-002/data/t1-runtime-prompt-assembly.stdout`
- `.saivage/stages/repair-live-planner-token-budget-002/data/t1-runtime-prompt-assembly.stderr`
- `.saivage/stages/repair-live-planner-token-budget-002/data/t1-summary-helpers-locations.stdout`
- `.saivage/stages/repair-live-planner-token-budget-002/data/t1-summary-helpers-locations.stderr`
- `.saivage/stages/repair-live-planner-token-budget-002/data/t1-session-and-helper-probe.stdout`
- `.saivage/stages/repair-live-planner-token-budget-002/data/t1-session-and-helper-probe.stderr`
- `.saivage/stages/repair-live-planner-token-budget-002/data/t1-recent-flagged-events.stdout`
- `.saivage/stages/repair-live-planner-token-budget-002/data/t1-recent-flagged-events.stderr`
- `.saivage/stages/repair-live-planner-token-budget-002/reports/t1-diagnose-live-token-budget.json`

Validation performed:
- JSON probes parsed successfully and reported live project/card/event metadata.
- Saivage health and readiness returned HTTP 200; Diedrico root returned HTTP 200.
- `saivage-v3.service` and `diedrico.service` reported active/running.
- Recent redacted events confirmed planner-role `token_budget_exceeded` / `context_length_exceeded` failures and did not show reviewer-unavailable or reviewer-invocation-failed flags in the recent token-budget sequence.

License/terms: Not applicable; no external data was downloaded. All evidence came from local runtime state and project source.

Redaction constraints: Durable outputs summarize sizes, paths, statuses, keys, hashes, and failure categories. They intentionally omit raw HTTP bodies, raw logs, raw `.saivage` card/config/auth payloads, provider/account values, tokens, and lesson product content.
