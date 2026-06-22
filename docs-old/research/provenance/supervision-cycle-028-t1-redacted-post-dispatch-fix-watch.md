# Provenance: supervision-cycle-028 t1 redacted observation

- Access date: 2026-06-01T06:00:01.792148+00:00
- Source type: local operational metadata from systemd, localhost HTTP status checks, and project filesystem metadata.
- Sources observed: `saivage-v3.service`, `diedrico.service`, `http://localhost:8081/health`, `http://localhost:8081/health/ready`, `http://localhost:5173/`, `/work/diedrico-lessons/.saivage/cards/by-id/`, `/work/diedrico-lessons/.saivage/runtime/events.jsonl`, product-document paths, review/diary directories, and lesson artifact directory.
- Retrieval method: bounded shell/Python probes wrote metadata-only logs under `.saivage/tmp/supervision-cycle-028/`.
- Redaction: no raw HTTP bodies, journal bodies, card bodies, product-document content, lesson content, environment variables, or secret-shaped values were copied into durable report artifacts.
- Validation: service status commands completed, HTTP status codes were 200, JSON metadata and event tails parsed with zero parse errors in sampled windows.
- License/terms: not applicable; no external data source was downloaded.
