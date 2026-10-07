---
name: saivage-development-validation
description: 'Validate Saivage v3 code, docs, web UI, and live deployment after changes. Use when modifying TypeScript runtime code, Vue components, docs, planner contracts, API schemas, or LXC-backed Saivage deployments.'
---

# Saivage Development Validation

## Local Validation

Select the README validation profile for the actual change. Documentation-only
work uses `npm run validate:docs`, plus any focused guard/skill checks in its plan;
the backend/build recipes below are not mandatory for policy-only documentation.

When durable contracts change, review affected discriminator, producer, strict
consumer, fixture and [format-reference](../../../docs/architecture/durable-format-changes.md)
synchronization under [AGENTS Storage Policy](../../../AGENTS.md#durable-format-versioning).
Versions/reference assist release comparison; they neither prove complete
compatibility nor authorize live actions.

Run from `/home/salva/g/ml/saivage-v3`:

```bash
npm run validate:routine
NODE_OPTIONS=--experimental-vm-modules npx jest <focused-tests> --runInBand --forceExit
npm run build
```

For Vue single-file components, check for duplicate script blocks before building:

```bash
for f in web/src/components/*.vue web/src/components/cards/*.vue web/src/views/*.vue web/src/App.vue; do
  count=$(grep -c "script setup" "$f" 2>/dev/null || true)
  printf '%s %s\n' "$count" "$f"
done
```

## Live Verification

Validation alone authorizes no deployment, restart, migration, reset or Run. Use
live recipes only with separate authorization for the exact deployment. Establish
matching durable contracts from the selected releases before restart: same-format
deployment retains valid state; incompatibility stays stopped until separately
consented reset or explicit owner-requested external migration through
`saivage-format-migration` completes. Never infer consent from a passing build.

Use passwordless SSH (`root@<ip>`) for service control when reachable; `sudo lxc-attach` is fallback only. Verify current container IPs before service control because 2026-06-03 host health probes for Saivage services failed or timed out.

For the v2-on-v3 harness:

```bash
ssh root@10.0.3.112 'systemctl is-active saivage.service'
curl -fsS http://10.0.3.112:8080/health
```

For an authorized same-format Saivage v3 GetRich-v2 deployment, the codebase is bind mounted. Build on the host, restart only the authorized service, then probe health. If an incompatible adoption applies, complete its separately authorized workflow first:

```bash
cd /home/salva/g/ml/saivage-v3
npm run build
ssh root@10.0.3.170 'systemctl restart saivage-v3-getrich.service && systemctl is-active saivage-v3-getrich.service'
curl -fsS http://10.0.3.170:8080/health
```

For authenticated API checks, use authorized local tokens and avoid unnecessary token disclosure in chat or logs.

## Reporting

Report commands that passed, live service status, and any remaining test gaps. Avoid unnecessary disclosure of secrets or token values.
