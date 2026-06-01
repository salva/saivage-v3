# t4 post-repair follow-up observation provenance

- Access date: 2026-06-01T05:12:08.944295+00:00
- Retrieval method: local bounded observation script using systemctl, localhost HTTP GETs, filesystem stat/JSON parsing, and git metadata. No external downloads.
- Sources observed:
  - systemd units: saivage-v3.service, diedrico.service
  - HTTP endpoints: http://localhost:8081/health, http://localhost:8081/health/ready, http://localhost:5173/
  - Runtime events: /work/diedrico-lessons/.saivage/runtime/events.jsonl (classified by safe structural fields only)
  - Cards: /work/diedrico-lessons/.saivage/cards/by-id/*.json (status/state/mtime/size only)
  - Product files: pipeline-status.md, curriculum.md, backlog.md, catalog.md (stat/hash only in evidence; no content copied)
  - Lessons directory: newest file paths, sizes, mtimes only
- Artifact: /work/saivage-v3/.saivage/stages/repair-scheduler-idle-start-next-work-001/reports/t4-post-repair-followup-observation.evidence.json
- Artifact SHA-256: bd547bc88d70b6743617b76f65387beee90065137d9ce05cf24e9924d3387698
- Artifact bytes: 56460
- Redaction policy: raw logs, raw HTTP bodies, raw card bodies, raw event payloads, and secret-shaped values were not written to the report. HTTP bodies were represented only by status/content type and a prefix hash in evidence.
- License/terms: not applicable; local operational observation only.
- Schema: JSON object with observed_at, services, health, runtime_events, cards, product_files, lessons, stage_files, git, and supervision_notes.
