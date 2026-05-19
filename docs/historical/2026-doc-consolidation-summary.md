# 2026 documentation consolidation summary

This historical note summarizes the Stage 21-26 documentation consolidation. It is provenance only; current operator guidance starts at [the runbook](../runbook/index.md) and current design navigation starts at [the design index](../design/index.md).

## Outcome

- Stage 21 refreshed `docs/documentation-inventory.md` so every tracked root and `docs/` Markdown file has a classification, justification, source anchor, and disposition.
- Stage 22 moved the original numbered design series into `docs/historical/2026-pre-consolidation/` and created the canonical `docs/design/` tree.
- Stage 23 reconciled active operator/source-of-truth docs with implemented HTTP routes, agent tools, runtime-control shapes, and configuration schema anchors.
- Stage 24 isolated historical remediation and review dossiers under `docs/historical/` and added the `See historical:` convention for links from active docs.
- Stage 25 consolidated operational guidance into `docs/runbook/` and added route/shape checks for documented curl examples.
- Stage 26 made `README.md` the concise repository landing page, made `docs/index.md` the curated documentation table of contents, and added a global Markdown internal-link guard to `npm run docs:verify`.

## Current verification bundle

`npm run docs:verify` now builds the docs and runs guards for documentation inventory completeness, operator route/role/config/runtime anchors, historical isolation, runbook curl examples, design-doc link boundaries, and global Markdown internal-link resolution.
