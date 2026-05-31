# t1-runtime-stall-audit provenance

Access date: 2026-05-31 UTC

Purpose: redacted metadata-only audit for stage `repair-stuck-terminal-reconciliation-001` task `t1-runtime-stall-audit`.

Sources and methods:

- Local service metadata: `systemctl show` for `saivage-v3.service` and `diedrico.service`; recent `journalctl` output summarized to line counts and error/warn-like counts only. Stable output: `.saivage/tmp/t1-runtime-stall-audit/services-endpoints-v2.stdout.json`.
- Local endpoint metadata: Python `urllib.request` GET requests to `http://localhost:8081/health`, `http://localhost:8081/health/ready`, and `http://localhost:5173/`; recorded status code, content type, and capped byte count only. Stable output: `.saivage/tmp/t1-runtime-stall-audit/services-endpoints-v2.stdout.json`.
- Runtime file metadata: narrow Python filesystem/JSON inspection under `/work/diedrico-lessons/.saivage`, `/work/diedrico-lessons/lessons/001-intro-to-the-diedrico-tool`, and `/work/saivage-v3/.saivage/stages/supervision-cycle-018-watch-terminal-reconciliation/summary.json`; recorded existence, sizes, mtimes, short checksums, JSON key names, event type counts, card lifecycle fields, and redacted summaries only. Stable outputs: `.saivage/tmp/t1-runtime-stall-audit/runtime-metadata.stdout.json` and `.saivage/tmp/t1-runtime-stall-audit/card-progress.stdout.json`.
- Retained production artifact metadata: narrow Python inspection of `/work/diedrico-lessons/.saivage-work/cards/produce-intro-tool-lesson/artifacts/retained`; recorded filenames, sizes, mtimes, short checksums, JSON top-level keys, and safe scalar validation counts only. Stable output: `.saivage/tmp/t1-runtime-stall-audit/retained-artifacts.stdout.json`.

Validation notes:

- No external downloads were required for this local runtime audit.
- No raw HTTP bodies, raw journal lines, raw card JSON bodies, environment dumps, auth/provider contents, tokens, or secret-shaped values are included in the durable report.
- The first service probe exited early while piping journal output; it was superseded by the safer Python probe in `services-endpoints-v2.stdout.json`.
