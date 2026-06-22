# Provenance — t1-redacted-scheduler-watch

Access date: 2026-06-01T04:49:40.902371+00:00

Retrieval method: local metadata-only scan using systemctl show, status-only curl probes, file stat/JSON key scans, and count/category extraction. No external downloads were required.

Sources inspected (metadata only):
- systemd properties for saivage-v3.service and diedrico.service; recent journal warning-or-higher line counts only.
- HTTP status probes for http://localhost:8081/health, http://localhost:8081/health/ready, and http://localhost:5173/. Bodies were discarded.
- /work/diedrico-lessons/.saivage/cards/by-id/*.json: path, size, mtime, JSON top-level keys, status/category fields only.
- /work/diedrico-lessons/.saivage/runtime/events.jsonl: line count, mtime, event kind/timestamp/key names only; no raw event bodies.
- /work/diedrico-lessons/pipeline-status.md, catalog.md, backlog.md, curriculum.md: stat metadata; pipeline-status keyword category flags only.
- /work/diedrico-lessons/lessons/: file count and newest artifact path-category/extension/mtime only.

Artifact checksum:
- .saivage/stages/supervision-cycle-026-watch-next-scheduler-after-recovery/tmp-scan.json sha256=8244e4f2ebbabf40f2e653c5878dd79d3facb2b43983ec849f3f036e5161372f

License/terms: not applicable; all sources are local operational artifacts for the assigned project.

Schema: JSON object with service status summaries, endpoint status summaries, card status counts, runtime event metadata counts, product document/directory stats, lesson artifact metadata, and cycle-025 comparison paths.

Redaction: raw logs, HTTP bodies, raw card/event/document content, environment dumps, auth/provider values, tokens, lesson content, and product-file text are intentionally excluded.
