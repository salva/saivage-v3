# Saivage v3 Runbook

This runbook is the current operator entry point for starting, controlling, diagnosing, and releasing Saivage v3. It consolidates the prior operation guide, operator runbook, troubleshooting guide, and release checklist while leaving source-of-truth architecture in [Agents and Runtime Architecture](/agents).

## Sections

- [Operations](./operations.md) — startup, auth, public/protected surfaces, health, runtime state, pause/resume/freeze, WebSocket chat, backups, and LXC/systemd operations.
- [Incidents](./incidents.md) — unauthorized access, stale UI state, frozen/error runtime recovery, evidence issues, preview-only actions, and degraded-agent workflows.
- [Release](./release.md) — release-candidate documentation, security, runtime-control, build, web, and serving gates.
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

## Verification contract

`npm run docs:verify` runs `scripts/check-runbook-curl-examples.js`. That guard extracts the curl/http examples in `docs/runbook/*.md`, checks that every documented route exists in the source route table, and validates the documented top-level response keys/status codes for `/health`, `/api/state`, `/api/runtime/pause`, `/api/runtime/resume`, `/api/runtime/freeze`, and `/api/runtime/resume-from-freeze` against a freshly seeded temporary runtime fixture.
