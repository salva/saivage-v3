# t2 Redacted Provider Runtime State Provenance

Access date: 2026-06-01T03:30:58.718027+00:00

## Sources and methods
- Local systemd status via `systemctl is-active/show` for `saivage-v3.service` and `diedrico.service`.
- Local journal category scan via `journalctl` with secret-shaped lines redacted.
- Local HTTP endpoint status checks for `http://localhost:8081/health`, `http://localhost:8081/health/ready`, and `http://localhost:5173/`; only status, content type, sampled byte count, and body sample checksums were retained.
- Local Saivage state schema/key inspection for `/work/diedrico-lessons/.saivage/saivage.json`, `/work/diedrico-lessons/.saivage/auth-profiles.json`, project card, runtime events, reviews, diaries, cards, and pipeline-status semantics. Secret-shaped key values were not copied; only key presence/type and file stats were retained.
- Prior stage summary files were read for schema/file provenance only.

## Artifact
- Redacted evidence JSON: `.saivage/stages/repair-reviewer-provider-capacity-001/reports/t2-redacted-provider-runtime-evidence.json`
- Size: 40439 bytes
- SHA256: 93f2961dcb88ea1712bf4a2c942499a7c8f6ea840f34670d1d49cc9bd6dc8044

## License/terms
Local operational state and logs from the project/container; no external dataset license applies.

## Schema
Top-level keys: acquired_at_utc, cards_progress, config_auth_schema, diaries_progress, health_endpoints, pipeline_status_semantics, prior_stage_summaries, project_card_schema, recent_journal_error_categories, reviews_progress, runtime_events, service_status

## Validation
- JSON parsed successfully.
- Health endpoint checks retained HTTP status codes and hashes, not raw bodies.
- Config/auth inspection retained schema/key presence and redacted secret-shaped values.
- Runtime events inspection summarized tail categories and relevant timestamps without raw event payloads.
