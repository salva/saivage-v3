# Provenance: t1-redacted-recovery-watch

- Access date: 2026-06-01T04:43:05.208123+00:00
- Acquisition type: local service/endpoint metadata observation; no external dataset download.
- Sources inspected (metadata-only): systemd show for saivage-v3.service and diedrico.service; redacted journal count scan since 2026-06-01T04:38:00Z; HTTP status-only probes for http://localhost:8081/health, http://localhost:8081/health/ready, http://localhost:5173/; file metadata and schema/key summaries under /work/diedrico-lessons/.saivage and top-level product documents.
- Retrieval method: Python subprocess/curl/stat/json parsing via Saivage run_command; stdout/stderr logs stored under .saivage/tmp/command-logs/.
- Artifact: /work/saivage-v3/.saivage/stages/supervision-cycle-025-recovery-watch/reports/observation-metadata.json
- Checksum method: filesystem artifact retained in git worktree; no remote checksum available for local runtime state.
- Redaction: raw logs, HTTP bodies, card bodies, event bodies, lesson/product document content, and secret-shaped values were not copied.
- License/terms: not applicable; local operational metadata from project runtime.
