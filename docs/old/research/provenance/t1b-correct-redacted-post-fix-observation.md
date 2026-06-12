# Provenance — t1b-correct-redacted-post-fix-observation

- Access date (UTC): 2026-06-01T12:33:22Z
- Acquisition method: local metadata-only collection from /work/diedrico-lessons using systemctl metadata, status-code-only HTTP probes, file stat/inventory, selected JSON status-field extraction, and runtime event keyword/timestamp counts.
- Sources: local systemd units saivage-v3.service and diedrico.service; http://localhost:8081/health; http://localhost:8081/health/ready; http://localhost:5173/; /work/diedrico-lessons/.saivage/cards/by-id/; /work/diedrico-lessons/.saivage/tmp/state/runtime.json; /work/diedrico-lessons/.saivage/runtime/events.jsonl; product/status file mtimes; reviews/diaries/lessons directory metadata.
- License/terms: local operational project/runtime state; not a third-party dataset.
- Retrieval bounds: no raw logs, HTTP bodies, raw card/event bodies, secret-shaped values, or lesson/product text copied into the report; events reduced to post-baseline line count and keyword categories.
- Artifact: .saivage/stages/supervision-cycle-039-watch-post-report-goal-envelope-fix/reports/t1b-live-metadata.json
- Artifact SHA256: 219f77991b461c5a51ab8a9e5c009cb17f64dc9df2875ebbdf9915b36ad4ff20
- Schema summary: JSON object containing service/endpoints metadata, selected runtime/card status metadata, product file stat metadata, evidence directory counts, lesson artifact metadata, event keyword counts, and journal keyword category counts.
