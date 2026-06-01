# Provenance: repair-project-card-terminal-error-to-status-dispatch-001 / t3-post-fix-live-observation

- Stage: repair-project-card-terminal-error-to-status-dispatch-001
- Task: t3-post-fix-live-observation
- Access date: 2026-06-01T06:21:12.821477+00:00
- Source: local Saivage/Diedrico runtime in /work/diedrico-lessons and services on localhost.
- Retrieval methods: systemctl service metadata, journalctl redacted tail, curl status-only checks for http://localhost:8081/health, http://localhost:8081/health/ready, and http://localhost:5173/, plus metadata-only Python parsing of cards/events/product artifact mtimes.
- License/terms: not applicable; no external dataset downloaded.
- Redaction: secret-shaped key/value patterns were redacted from journal output; durable report records categories, status codes, mtimes, sizes, and checksums only.
- Schema: local evidence logs plus TaskReport JSON at `.saivage/stages/repair-project-card-terminal-error-to-status-dispatch-001/reports/t3-post-fix-live-observation.json`.

## Evidence log checksums

```json
[
  {
    "path": ".saivage/tmp/t3-live-service-health.stdout.log",
    "size_bytes": 23203,
    "sha256": "837522b2a72d3b09a1056f55e21a5b248d27a193e80add0a70f1124e70d76c51"
  },
  {
    "path": ".saivage/tmp/t3-live-service-health.stderr.log",
    "size_bytes": 370,
    "sha256": "69d3c0bc6f9e168784abf7957f89b138016b9b82b76f3ca536799805eaf853cb"
  },
  {
    "path": ".saivage/tmp/t3-live-runtime-metadata.stdout.log",
    "size_bytes": 3243,
    "sha256": "7be87a9e14d12f0c913b65850211339d521f65dab305a8936c85d1a6a813ef8e"
  },
  {
    "path": ".saivage/tmp/t3-live-runtime-metadata.stderr.log",
    "size_bytes": 0,
    "sha256": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
  },
  {
    "path": ".saivage/tmp/t3-live-structural-followup.stdout.log",
    "size_bytes": 7090,
    "sha256": "2e7d02a69b5b0e28a3a12e93782c4ea143b2382d46236905906e57c6b4a2c5cf"
  },
  {
    "path": ".saivage/tmp/t3-live-structural-followup.stderr.log",
    "size_bytes": 0,
    "sha256": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
  }
]
```
