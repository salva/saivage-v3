# Provenance: t1 redacted live state and evidence

- Task: t1-redacted-live-state-and-evidence
- Stage: repair-planner-completion-dispatch-handling-001
- Access date: 2026-06-01T05:35:25.608661+00:00
- Sources: local systemd unit metadata; count-only journal scans; local HTTP status-only checks; local filesystem metadata under /work/diedrico-lessons; runtime event key/category/timestamp summaries; git status counts.
- Retrieval method: python3 metadata-only collector using systemctl show, journalctl count-only scanning, curl status-only checks, JSONL parse for keys/category/timestamps only, file stat/mtime counts, and SHA-256 for artifacts.
- License/terms: local operational project/runtime data; no external dataset used.
- Redaction policy: raw logs, HTTP bodies, event payloads, .saivage/card bodies, environment dumps, auth/provider values, token-like values, and lesson product content were not retained.
- Evidence artifact: .saivage/stages/repair-planner-completion-dispatch-handling-001/reports/t1-redacted-live-state-and-evidence.evidence.json
- Evidence SHA-256: 2944a13041271b6ab0303cfeb83ca3762a43e9accb9564e99876e8e6259cf773
- Schema: redacted-live-evidence-v2.
