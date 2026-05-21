# Dependency hygiene runbook

<!-- doc-authority
status: current
disposition: keep
owner: platform-maintainers
superseded_by: none
last_verified_against: scripts/check-dependency-freshness.js:1
-->

This runbook defines the ARCH-029 dependency hygiene gate for the root package graph (`package.json`) and web package graph (`web/package.json`). It is governance only: do not run `npm audit fix`, `npm update`, or broad dependency upgrades as part of the gate unless a separate dependency-remediation change is approved.

## Ownership and cadence

- Owner: platform maintainers own dependency triage, waiver approval, and follow-up issue creation.
- Daily signal: scheduled CI runs the dependency-hygiene job from `.github/workflows/validation.yml`.
- Monthly review: run the manual governance profile and record triage decisions in the maintenance tracker.

```bash
npm run audit:security
npm run deps:review
```

## Severity thresholds

- `npm run audit:security` is the required production gate. It runs `audit:root` and `audit:web`, both with `--audit-level=high --omit=dev`, so high and critical production advisories fail closed.
- `npm run audit:security:all` is the scheduled/manual full graph scan at moderate threshold, including development dependencies. It is a governance signal unless a release-impacting risk is identified.
- Critical production advisories require same-day triage and either remediation or a short-lived waiver.
- High production advisories require prompt triage, owner assignment, and remediation or a time-boxed waiver.
- Moderate, low, transitive-only, and dev-tooling findings are reviewed during the monthly cadence unless risk escalates.

## Lockfile freshness and direct runtime review

`npm run deps:freshness` runs `scripts/check-dependency-freshness.js`. The checker verifies that `package-lock.json` and `web/package-lock.json` are present and remain package-lock v3, classifies root/web direct runtime dependencies separately from dev/transitive entries, and validates waiver metadata. During the first ARCH-029 calibration cycle, direct-runtime staleness is reporting-only; malformed/expired waivers and missing or downgraded lockfiles fail immediately.

Offline tests use fixture mode, for example:

```bash
node scripts/check-dependency-freshness.js --root-outdated-fixture fixtures/root-outdated.json --web-outdated-fixture fixtures/web-outdated.json
```

Fixture mode is deterministic for tests, but it does not prove the live npm advisory service passed. If the registry or audit service is unavailable, the required `audit:security` gate remains unproven and should fail closed in CI.

## Waiver metadata

Only create `docs/runbook/dependency-hygiene-waivers.json` when a high/critical production advisory cannot be remediated immediately. Each waiver must include:

- `package`
- `ecosystem` (`root` or `web`)
- `advisory`
- `severity`
- `owner`
- `created`
- `expires`
- `reason`
- `compensating_control`

Expired or malformed waivers fail `npm run deps:freshness` and `npm run deps:review`. Waivers must be time-boxed and reviewed before expiry.

## Rollback and override semantics

For urgent CI recovery, first relax only the `dependency-hygiene` enforcement in the inline `validation-required` aggregate in `.github/workflows/validation.yml`; keep the package scripts available for local diagnosis. Do not replace audit commands with `|| true` in required paths. If registry flakiness is the reason, document an owner, expiry, and restoration plan before making live audit enforcement reporting-only. Preserve waiver history and implementation-log decisions when reverting policy.
