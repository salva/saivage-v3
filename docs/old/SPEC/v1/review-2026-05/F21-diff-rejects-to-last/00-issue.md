# F21 — `/api/cards/<id>/diff` rejects `to=last` and requires integer pivots

## Summary

`GET /api/cards/<id>/diff?from=1&to=last` returns HTTP 400 `"from and to query parameters are required positive integers"`. Callers must first hit `/api/cards/<id>/history` to learn the latest `version_seq`, but `/history` is broken (see [F12](../F12-card-history-empty/00-issue.md)), creating a chicken-and-egg situation. Trivial DX fix: accept `to=last` / `to=current` aliases (resolve server-side to the current `version_seq`), and consider defaulting `from` to `to - 1` when omitted.

## Evidence

- Phase-2 G5/T44: [tmp/saivage-v3-checkers-e2e-artifacts-20260523-phase2/G5-report.md](../../../../tmp/saivage-v3-checkers-e2e-artifacts-20260523-phase2/G5-report.md) §T44; raw [t44-diff.json](../../../../tmp/saivage-v3-checkers-e2e-artifacts-20260523-phase2/t44-diff.json), [t44-diff-1-1.json](../../../../tmp/saivage-v3-checkers-e2e-artifacts-20260523-phase2/t44-diff-1-1.json).
- Owner code: [src/server/routes/cards.ts](../../../src/server/routes/cards.ts) — diff route querystring validator.

## Category

bad DX (over-strict parser)

## Severity

P2 — meaningful operator pain even after [F12](../F12-card-history-empty/00-issue.md) is fixed; trivial cost to address.

## Transversality

Local: one route handler + one schema.
