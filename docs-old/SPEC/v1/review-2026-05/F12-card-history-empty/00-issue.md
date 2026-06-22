# F12 — Card history endpoint returns empty even when `version_seq > 1`

## Summary

`GET /api/cards/<id>/history` returns `{ "history": [], "total": 0 }` for both `project` (reported `version_seq=4`) and child cards. The Card → History UI tab consequently renders `"No history entries yet."` permanently. Because the diff endpoint (see [F21](../F21-diff-rejects-to-last/00-issue.md)) requires an integer pivot the caller has to read from history first, this gap makes per-card auditing effectively impossible from the operator surface.

## Evidence

- Phase-2 audit, G1/T15–T16 — UI history empty: [tmp/saivage-v3-checkers-e2e-artifacts-20260523-phase2/G1-report.md](../../../../tmp/saivage-v3-checkers-e2e-artifacts-20260523-phase2/G1-report.md) §T15/T16.
- Phase-2 audit, G5/T44 — API empty: [tmp/saivage-v3-checkers-e2e-artifacts-20260523-phase2/G5-report.md](../../../../tmp/saivage-v3-checkers-e2e-artifacts-20260523-phase2/G5-report.md) §T44.
- Raw response sample: [tmp/saivage-v3-checkers-e2e-artifacts-20260523-phase2/t44-history.json](../../../../tmp/saivage-v3-checkers-e2e-artifacts-20260523-phase2/t44-history.json) and [t44-project-history.json](../../../../tmp/saivage-v3-checkers-e2e-artifacts-20260523-phase2/t44-project-history.json).
- Likely owner code: [src/cards/card-store.ts](../../../src/cards/card-store.ts) (history path at `.saivage/cards/history/<id>.history.jsonl`, ~line 316-318), [src/server/routes/cards.ts](../../../src/server/routes/cards.ts) (history route).

## Category

half-implemented / bad design

## Severity

P1 — eliminates the only operator-side audit trail for card evolution.

## Transversality

Cross-cutting: card store (writer), HTTP route (reader), UI (history tab). Probably shares root cause with [F13](../F13-canonical-index-drift/00-issue.md).
