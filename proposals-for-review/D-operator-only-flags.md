# Operator-only deferred residuals (from closed ARCH-001..030 cycle)

These four items were recorded as accepted residuals during the closed
ARCH-001..030 architecture-audit cycle. They are not regressions; each is
a small follow-up that the cycle deliberately deferred. Preserved here so
they aren't lost when the audit tree is archived.

## ARCH-025 Proposal B — audit-artifact manifest / status boundary

Proposal B was deferred during ARCH-025. It would add a manifest +
machine-readable status boundary to audit artifacts. Source-anchor
governance and `docs:verify` integration already provide coverage; the
manifest layer was held back to avoid scope creep.

Source pointer: see `architecture-audit/implementation-log/ARCH-025.md`
(in `old-documents/architecture-audit/` after archival).

## Analyst `list_cards` scalar-or-array filters

Conservative residual accepted during the analyst schema reconciliation
follow-up: `list_cards` accepts either a scalar enum or an array for
filter fields. Wider filter shapes (regex, partial match) were rejected as
out of scope. Source: `src/agents/analyst-tools.ts` (current schema) and
runtime handling in the analyst adapter.

## CI24 error-logger fixture follow-up

Residual fixture work flagged during the CI24 integrated regression
closeout. The current fixture set is sufficient for regression; the
follow-up would expand error-logger fixtures to cover additional redaction
permutations.

## CardStore health remote-clear / diagnostic endpoint

A diagnostic endpoint to remotely clear / inspect CardStore health
warnings was discussed during the ARCH-028 closeout and deferred.
`getAndClearWarnings()` exists in source but no REST/WS route exposes it.
Current code: `src/cards/card-store.ts` + `src/server/routes/runtime-config-notes.ts:152`.
