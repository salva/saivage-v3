# Phase-2 Issue Inventory (review-2026-05)

Source audit: [tmp/saivage-v3-checkers-e2e-issues-20260523-phase2.md](../../../../tmp/saivage-v3-checkers-e2e-issues-20260523-phase2.md). Numbering preserves the Phase-2 aggregate; only F12–F23 are in scope for this review (per user direction).

| ID | Severity | Transversality | Title |
| --- | --- | --- | --- |
| [F12](F12-card-history-empty/00-issue.md) | P1 | Cross-cutting (store + routes + UI) | Card history endpoint returns empty even when `version_seq > 1` |
| [F13](F13-canonical-index-drift/00-issue.md) | P1 | Architectural (store invariants) | Canonical hierarchy invariant drift between `cards/index.json` and by-id records |
| [F14](F14-state-no-project-root/00-issue.md) | P3 | Local (API contract) | `/api/state` contract drift: no `projectRoot` field |
| [F15](F15-mcp-degraded-label/00-issue.md) | P3 | Local (classification) | `serverAvailability.components.mcp.state="degraded"` when no MCP servers configured |
| [F16](F16-seeded-improvement-regex/00-issue.md) | P3 | Test-tooling-only | Seeded-improvement regex `/capture\|announce/i` is non-deterministic across planner runs |
| [F17](F17-no-agent-detail-endpoint/00-issue.md) | P3 | Local (API surface) | No agent-detail endpoint exposes per-session message/turn count |
| [F18](F18-runtime-status-pid-null/00-issue.md) | P3 | Local (state field) | `/api/runtime/status.pid` returns `null` even when the service is up |
| [F19](F19-runtime-pinned-failed-card/00-issue.md) | P1 | Cross-cutting (runtime ↔ cards) | Runtime status pinned to a `failed` current card; no auto-replan |
| [F20](F20-executor-false-failed/00-issue.md) | P2 | Cross-cutting (runtime ↔ agents) | Executor declares card `failed` despite producing correct, test-passing artefacts |
| [F21](F21-diff-rejects-to-last/00-issue.md) | P2 | Local (API DX) | `/api/cards/<id>/diff` rejects `to=last` and requires integer pivots |
| [F22](F22-planner-no-default-model/00-issue.md) | P1 | Cross-cutting (config ↔ agents) | Planner role has no default model list at boot |
| [F23](F23-invalid-failed-active/00-issue.md) | P2 | Cross-cutting (state machine ↔ orchestrator) | Orchestrator attempts illegal `failed → active` transition |

## Cross-references

- F12 ↔ F13: card-store atomicity is the most likely shared root cause; resolve F13 first, F12 may collapse into it or require an additional history-append fix.
- F19 ↔ F20 ↔ F23: all three describe the same wedged state — executor reports false `failed`, orchestrator tries illegal recovery, runtime status pinned to dead card. Sequence: fix F20 (or surface honest verdict) → F23 (legal recovery routing) → F19 (runtime auto-advance).
- F14 ↔ F17 ↔ F18: API-surface gaps. Group into a single contract-cleanup batch.
- F22 is a soft prerequisite for F19/F20: planner cycles error out before reaching the bad-recovery code path.
- F16 is matrix-tooling, not Saivage code. Treat as the lightest item; may be relocated to the test prompt.

## Out of Scope (per user)

- Phase-1 findings F01–F11 (still open and reproduced in Phase-2 G1, but excluded from this dual-LLM loop).
- Mobile responsive (UC11) — blocked by Playwright MCP harness limitation.
