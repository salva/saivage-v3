# Provenance: t1 redacted operational assessment

- Access date: 2026-05-31T17:49:21.766477+00:00
- Acquisition mode: local service metadata, status-only HTTP GETs, filesystem stat/shape summaries, locally redacted journal/event summaries.
- Sources: systemd units `saivage-v3.service`, `diedrico.service`; status-only endpoints on localhost ports 8081 and 5173; non-secret project status documents; redacted shape summaries under `/work/diedrico-lessons/.saivage/`.
- Sensitive-data handling: no HTTP bodies were read; raw journal/log/event messages and raw `.saivage` JSON values were not written. Secret-shaped keys/values were excluded from summaries.
- Report artifact: `.saivage/stages/supervision-cycle-001-assess/reports/t1-redacted-operational-assessment.json`
- Report sha256: 5c7568cc6e365712e0b83cfd93450444fed336b80b50bd466afa3ed36ab6a36c
- Attempt count: 13
- Determination: misconfigured/bootstrap-incomplete
- Classification note: endpoint/service health is available, but missing bootstrap-state and required lesson-pipeline documents prevent verification of completed bootstrap or pipeline progress.
