# Saivage v3 — Release Checklist

Release validation has been consolidated into [Runbook: Release](/runbook/release).

Use that page for documentation gates, core checks, web checks, security/containment checks, runtime-control checks, serving checks, and final sign-off. The current clean-checkout release command anchors remain:

```bash
npm run build
SAIVAGE_API_TOKEN=test ./bin/saivage.js start
```
