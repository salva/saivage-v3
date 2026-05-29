# F07 — APPROVED

- Combined analysis+design+plan: [COMBINED-r2.md](COMBINED-r2.md) — APPROVED at round 2.
- Selected proposal: **Proposal A — `models.default` + per-role overrides, with `models.failover` as the sole accepted top-level fallback location**. Root `failover` field removed (strict rejection); analyst writer migrated to `setFailoverChain → models.failover`; empty per-role arrays rejected.
- Closes F07. Deploy step includes one-time migration of `/work/getrich-v2/.saivage/saivage.json` to the new shape.
