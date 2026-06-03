# Saivage v3 Runbook

<!-- doc-authority
status: current
disposition: keep
owner: docs-maintainers
superseded_by: none
last_verified_against: scripts/check-runbook-curl-examples.js:1
-->

This runbook is the current operator entry point for starting, controlling, diagnosing, and releasing Saivage v3. It consolidates the prior operation guide, operator runbook, troubleshooting guide, and release checklist while leaving source-of-truth architecture in [Agents and Runtime Architecture](/agents).

## Sections

- [Operations](./operations.md) — startup, auth, public/protected surfaces, health, runtime state, pause/resume/freeze, WebSocket chat, backups, and LXC/systemd operations.
- [Incidents](./incidents.md) — unauthorized access, stale UI state, frozen/error runtime recovery, evidence issues, preview-only actions, and degraded-agent workflows.
- [Release](./release.md) — release-candidate documentation, security, runtime-control, build, web, and serving gates.
- [Dependency hygiene](./dependency-hygiene.md) — high/critical production audit gate, monthly review cadence, lockfile freshness, waivers, and rollback semantics.
- [LXC operations](./lxc-operations.md) — deployment-oriented LXC notes, systemd unit names, journal checks, and safe restart flow.

## Quick operator sequence

1. Confirm the service is reachable:

```bash
curl http://localhost:8080/health
```

2. Confirm authenticated runtime state:

```bash
curl -H "Authorization: Bearer $SAIVAGE_API_TOKEN" \
  http://localhost:8080/api/state
```

3. Pause before low-risk maintenance, or freeze before disruptive handoff.
4. Inspect Debug, Cards, Agents, Files, and Notifications in the Web Control Room before editing runtime files manually.
5. Use this runbook for procedures and [Troubleshooting incidents](./incidents.md) for recovery paths.

## Validation profiles

See [Release](./release.md#validation-matrix) for the full validation matrix. The routine profiles are:

```bash
npm run validate:docs
npm run validate:routine
npm run validate:ui-smoke
npm run validate:ui
npm run validate:release
npm run audit:security
npm run deps:review
```

`npm run validate:docs` intentionally runs `npm run docs:verify` only; it does not run `npm test` or the Vitest operator smoke guard. Use `npm run validate:ui-smoke` after Dashboard/AppShell operator-surface changes, `npm run validate:ui` for broader UI work, and `npm run validate:release` for heavy release sign-off.

## Verification contract

`npm run docs:verify` runs `scripts/check-runbook-curl-examples.js`. That guard extracts the curl/http examples in `docs/runbook/*.md`, checks that every documented route exists in the source route table, and validates the documented top-level response keys/status codes for `/health` and `/api/state` against a freshly seeded temporary runtime fixture. It also runs `scripts/check-validation-cadence.js`, which verifies documented validation commands in README/release docs and every docs:verify sub-guard entry point still resolves to an existing package script, executable script, or focused Jest file. The same guard enforces the named `npm run web:test:operator-smoke` command and its documentation, while intentionally leaving the Vitest smoke execution out of `docs:verify` so documentation checks remain lightweight; run the smoke command directly after operator-dashboard changes and before release sign-off.
