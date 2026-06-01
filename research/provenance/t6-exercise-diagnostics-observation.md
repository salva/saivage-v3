# t6 exercise diagnostics observation provenance

- Task: t6-exercise-diagnostics-observation
- Stage: repair-live-planner-token-budget-002
- Access date: 2026-06-01T04:33:02Z
- Retrieval method: local bounded metadata-only observation script run from /work/saivage-v3 with Python stdlib, systemctl, journalctl, and HTTP GET probes.
- Sources observed:
  - systemd: saivage-v3.service, diedrico.service status only.
  - HTTP: http://localhost:8081/health, http://localhost:8081/health/ready, http://localhost:5173/; status/content-type only, bodies not retained.
  - Runtime metadata: /work/diedrico-lessons/.saivage/cards/by-id/project.json parsed for status/planning metadata only; raw card body not copied.
  - Runtime events: /work/diedrico-lessons/.saivage/runtime/events.jsonl last 300 records parsed for event kind counts and redacted signal counts only; raw lines not copied.
  - Journal: journalctl -u saivage-v3.service --since '30 minutes ago' parsed for mention counts only; raw messages not retained in report.
  - File metadata: /work/diedrico-lessons/pipeline-status.md, curriculum.md, backlog.md, catalog.md stat data only.
- Artifact written: .saivage/stages/repair-live-planner-token-budget-002/reports/t6-observation.stdout.json
- Validation: observation command exited 0; JSON artifact parseable; stderr artifact size 0.
- Redaction: no raw logs, HTTP bodies, card bodies, lesson content, provider/auth values, tokens, or secret-shaped values intentionally recorded.
- License/terms: not applicable; all sources are local runtime/service metadata within the assigned project/container.
