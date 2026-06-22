# t1 Diagnose Live Blocker Overwrite — Provenance

Access date: 2026-06-01T02:11Z UTC

## Purpose
Acquire redacted live-state evidence for the reviewer-capacity blocker preservation defect: prior terminal acceptance retry observed `reviewer_unavailable` / `reviewer_invocation_failed` transiently, while final durable live state was later generic `planner_blocked` or otherwise not fully structured for the precise blocker.

## Sources and methods
- Local HTTP status checks using `curl`:
  - `http://localhost:8081/health`
  - `http://localhost:8081/health/ready`
  - `http://localhost:5173/`
- Local systemd metadata using `systemctl is-active` and `systemctl show` for:
  - `saivage-v3.service`
  - `diedrico.service`
- Local runtime files, read with a redacting Python collector:
  - `/work/diedrico-lessons/.saivage/cards/by-id/project.json`
  - `/work/diedrico-lessons/.saivage/runtime/events.jsonl`
  - inventories only for `/work/diedrico-lessons/.saivage/cards/by-id`, `reviews`, `diaries`, and `supervision`
  - prior stage summaries under `/work/saivage-v3/.saivage/stages/.../summary.json`

No external downloads were required; all sources are local runtime/state files or local health endpoints.

## Artifacts
- `.saivage/stages/repair-reviewer-blocker-preservation-001/artifacts/live-state-redacted.json`
  - SHA256: `f7a105d2d9083ece81cc13f8ee4df0b227b7b5c609df0e89d86c09abadd463e3`
  - Schema: JSON object with acquisition timestamp, project-card selected fields, runtime events tail summary, prior-summary selected fields, and directory inventories.
- `.saivage/stages/repair-reviewer-blocker-preservation-001/artifacts/live-health-status-redacted.txt`
  - Contains endpoint status codes/body snippets and service metadata only.
- `.saivage/stages/repair-reviewer-blocker-preservation-001/artifacts/SHA256SUMS`
  - Checksum manifest for generated redacted artifacts.

## Validation
- JSON parse succeeded for the redacted live-state artifact.
- Project card source exists, size 5268 bytes, mtime 2026-06-01T02:00:59.458727+00:00, SHA256 recorded in artifact metadata.
- Runtime events source exists, size 505589 bytes, mtime 2026-06-01T02:00:57.725726+00:00, SHA256 recorded in artifact metadata.
- Health endpoints returned HTTP 200 for Saivage health, Saivage readiness, and Diedrico root.
- Both systemd units were active/running with NRestarts=0 at acquisition time.

## Redaction and scope
Secret-shaped keys/values were redacted by regex, and only selected project-card fields plus metadata/inventories were persisted. Raw card bodies, raw event lines, raw journal logs, auth/provider configs, and lesson product files were not copied. `pipeline-status.md` and lesson/curriculum/catalog/backlog artifacts were not edited.

## Observed evidence
- Current project card is `status=blocked` and its selected error text describes terminal acceptance blocked by reviewer/provider capacity after `report_goal_done` was re-issued.
- Selected current project-card fields available in the durable artifact do not expose structured `resume_reason` / `failure_kind`; the prior accepted stage summary records that the transient precise blocker was later masked by generic `planner_blocked` in final live state.
- The tail scan of the last 2000 runtime event records found zero matching records for the relevant terms; this is an evidence limitation rather than proof that the transient overwrite did not happen.
- Reviews and diaries directories were empty at acquisition time, supporting that no durable terminal review/diary progress was produced.
