# SPEC inventory direct-citation correction

## Summary

Updated `architecture-audit/baseline/inventory.md` so SPEC inventory evidence no longer relies on support-log-only citations for included SPEC trees. The revised SPEC sections cite current on-disk SPEC Markdown files directly:

- `SPEC/2026-05/review-ui-port-from-v2/00-INDEX.md`
- `SPEC/2026-05/review-ui-port-from-v2/00-SUBSYSTEM-MAP.md`
- `SPEC/v1/review-2026-05/00-INDEX.md`
- `SPEC/v1/review-2026-05/00-SUBSYSTEM-MAP.md`
- `SPEC/v1/review-2026-05/99-METAPLAN.md`

The excluded `SPEC/analyst-as-control-surface/` tree remains unmined per stage scope.

## Evidence collection

Captured direct line-number snippets in:

- `architecture-audit/baseline/logs/t1c-spec-direct-citations.stdout.log`
- `architecture-audit/baseline/logs/t1c-spec-v1-direct-citations.stdout.log`

No source/product/test code was modified.
