# Proposals for review

This directory holds design proposals and operator follow-ups that are **not
yet landed in current source** but have been preserved across the
2026-05-23 historical-doc cleanup so they aren't lost when the old audit and
research trees are archived.

Each file inside is meant to be triaged by the operator and either:

1. promoted into a Saivage v3 stage and implemented, or
2. formally rejected (in which case the file moves to `old-documents/`).

This directory is not part of the canonical docs tree and is not built by
VitePress. Files here are inert until acted upon.

## Contents

- [B-pending-active.md](./B-pending-active.md) — 14 architecture proposals
  from the 2026-05-22 audit pack that the audit declared "accepted" but
  whose implementation has not (yet) landed in source.
- [D-operator-only-flags.md](./D-operator-only-flags.md) — 4 small
  deferred-residual items recorded during the closed ARCH-001..030 cycle.
- [cardstore-health-ws-broadcaster.md](./cardstore-health-ws-broadcaster.md)
  — a deferred follow-up evaluating whether the WebSocket runtime-state
  broadcaster should populate `cardStoreHealth`.

Reference: the full per-file evidence for the 14 B items lives at
`tmp/cleanup-reports/review-2026-05-22.md` until that working note is also
archived.
