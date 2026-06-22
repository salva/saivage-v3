# F15 — `serverAvailability.components.mcp.state="degraded"` when no MCP servers configured

## Summary

When the MCP manager is running with zero configured servers it reports `state: "degraded"` with diagnostic `mcp-manager-empty`. The UI handles this gracefully (no red banner), but `degraded` conflates "no servers configured" with "servers misbehaving" and is misleading in dashboards and alert rules. A neutral classification (`unconfigured`, `idle`) would be both more accurate and avoid false-positive monitoring.

## Evidence

- Phase-2 G2/T26: [tmp/saivage-v3-checkers-e2e-artifacts-20260523-phase2/G2-report.md](../../../../tmp/saivage-v3-checkers-e2e-artifacts-20260523-phase2/G2-report.md) §T26.
- Raw payload: [tmp/saivage-v3-checkers-e2e-artifacts-20260523-phase2/t26-mcp-status.json](../../../../tmp/saivage-v3-checkers-e2e-artifacts-20260523-phase2/t26-mcp-status.json).
- Owner code: [src/mcp/](../../../src/mcp/), [src/observability/](../../../src/observability/) (`buildServerAvailability`).

## Category

bad design (semantic classification)

## Severity

P3 — cosmetic / API hygiene.

## Transversality

Local: one classifier + one allowed-states enum, plus any consumer that branches on `degraded`.
