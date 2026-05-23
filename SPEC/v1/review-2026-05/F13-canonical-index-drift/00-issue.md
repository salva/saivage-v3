# F13 — Canonical hierarchy invariant drift between `cards/index.json` and by-id records

## Summary

The runtime logs `Canonical hierarchy invariant failed: cards/index.json entry for 'project' does not match by-id record.` during mutation bursts. Steady-state reads recover (`cardStoreHealth.canonical = "ok"` per G2/T23), suggesting drift self-heals on the next index write, but the window where the index and by-id store disagree is observable from the operator API and is the most likely shared root cause for [F12](../F12-card-history-empty/00-issue.md) (history never gets appended atomically with the version bump).

## Evidence

- Source emitter: [src/cards/card-store.ts:87](../../../src/cards/card-store.ts) — `Canonical hierarchy invariant failed: cards/index.json entry for '${card.id}' does not match by-id record.` (the broader invariant block spans ~line 60-150).
- Phase-2 G1/T20 — Debug → Errors showed the invariant: [tmp/saivage-v3-checkers-e2e-artifacts-20260523-phase2/G1-report.md](../../../../tmp/saivage-v3-checkers-e2e-artifacts-20260523-phase2/G1-report.md) §T20 (`t20-debug-errors.png`).
- Phase-2 G5/T45 — re-observed in `errors.jsonl` line 4 (2026-05-23 13:51:55): [tmp/saivage-v3-checkers-e2e-artifacts-20260523-phase2/G5-report.md](../../../../tmp/saivage-v3-checkers-e2e-artifacts-20260523-phase2/G5-report.md) §T45.
- Steady-state contradiction: G2/T23 `cardStoreHealth.canonical = "ok"` ([t23-state.json](../../../../tmp/saivage-v3-checkers-e2e-artifacts-20260523-phase2/t23-state.json)).

## Category

bad design (non-atomic multi-file mutation), correctness

## Severity

P1 — would be P0 if reproduced across a restart with stuck inconsistency. Currently P1 because steady-state self-heals.

## Transversality

Architectural: the card store is a single-writer assumption that the rest of the runtime relies on. Fixing this likely requires introducing a transactional write boundary (write-temp + rename, or a single-file append-only log + projection rebuild). Touches [src/cards/card-store.ts](../../../src/cards/card-store.ts), all callers in [src/cards/index.ts](../../../src/cards/index.ts), and `src/projections/index.ts`.
