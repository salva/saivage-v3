# Baseline inventory exhaustiveness correction

## Summary

The original `architecture-audit/baseline/inventory.md` described the major source modules but grouped several immediate children under `web/`, `scripts/`, `docs/`, and `tests/`. This task added an explicit exhaustiveness correction section that enumerates every immediate child under the Phase 1 scoped roots: `src/`, `web/`, `web/src/`, `bin/`, `scripts/`, `docs/`, `SPEC/`, and `tests/`.

## Evidence generated

- `architecture-audit/baseline/logs/t1b-top-level-listing.stdout.log`: raw scoped immediate-child listing.
- `architecture-audit/baseline/logs/t1b-top-level-listing-numbered.stdout.log`: numbered version used for path:line citations of directory existence.
- `architecture-audit/baseline/logs/t1b-citation-snippets.stdout.log`: line-number snippets for files that were previously grouped or omitted.

## Scope/safety notes

- No source/product/test code was modified.
- `SPEC/analyst-as-control-surface/` remains excluded and was not mined.
- `web/.saivage/` was listed as an immediate child but not read, because `.saivage` subtrees may contain auth/provider material and are not application source.
- Existing unrelated worktree modifications were left untouched.
