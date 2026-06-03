# LXC operations

<!-- doc-authority
status: current
disposition: keep
owner: docs-maintainers
superseded_by: none
last_verified_against: src/cli.ts:1
-->

This page mirrors the workspace-local LXC operating pattern for Saivage deployments. Use it together with [Operations](./operations.md).

## Unit names

Known LXC unit names:

- `saivage.service`
- `saivage-v3-target.service`

Use the unit that matches the container/workspace you are operating. Do not assume both units exist in every container.

## Inspect service state

```bash
systemctl status saivage.service
journalctl -u saivage.service -n 100 --no-pager
```

For per-workspace units:

```bash
systemctl status saivage-v3-target.service
journalctl -u saivage-v3-target.service -n 100 --no-pager
```

## Safe restart flow

1. Check health and authenticated runtime state.
2. Pause before disruptive maintenance; do not rely on generic freeze controls.
3. Confirm no critical agent/process action is mid-flight in Debug.
4. Restart the relevant unit.
5. Re-check `/health`, `/api/state`, and recent journal entries.
6. Resume only after the service is coherent; frozen states require project-specific incident recovery.

Example commands:

```bash
systemctl restart saivage.service
systemctl status saivage.service
journalctl -u saivage.service -n 100 --no-pager
```

For per-workspace units:

```bash
systemctl restart saivage-v3-target.service
systemctl status saivage-v3-target.service
journalctl -u saivage-v3-target.service -n 100 --no-pager
```

## Token bootstrap and runtime ownership

The service environment must provide `SAIVAGE_API_TOKEN` for production-like operation. Runtime-owning services should start Saivage with `--create-runtime` so the process owns dispatch after boot:

```bash
SAIVAGE_API_TOKEN=your-token ./bin/saivage.js start --create-runtime
```

Server-only services can omit `--create-runtime` for inspection/control mode, but pause/resume then mutate persisted runtime state only unless a live runtime is attached elsewhere.

## Network checks

From inside the container, health should be reachable without auth:

```bash
curl http://localhost:8080/health
```

Protected API checks require the token:

```bash
curl -H "Authorization: Bearer $SAIVAGE_API_TOKEN" \
  http://localhost:8080/api/state
```

If the UI or API is unreachable, check port binding, systemd unit environment, and journal output before editing `.saivage/` directly.
