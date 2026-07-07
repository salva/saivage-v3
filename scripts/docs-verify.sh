#!/usr/bin/env bash
set -euo pipefail

# docs:verify — Build VitePress docs and run documentation drift guards.
# Used by the root npm script "docs:verify".
#
# Guard bundle:
#   - VitePress build output for top-level docs/*.md pages.
#   - VitePress dist artifact policy: docs/.vitepress/dist is ignored generated output.
#   - Operator route, internal-debug route, agent-tool, config-schema, and anchor parity against canonical docs.
#   - Architecture-doc allowed-link boundaries.
#   - Historical-link isolation for canonical current docs.
#   - Fixture-backed operator API response contract checks.
#   - Planner tool documentation/source parity checks.
#   - Global Markdown internal-link and anchor resolution.
#   - Documented source-anchor path/line validation for README.md and docs/.
#   - Validation-cadence command/package-script/docs:verify sub-guard parity, including operator smoke command drift (without executing Vitest smoke).
#   - Audit/UI finding dossier status, resolution, and remediation-log consistency.

DIST="docs/.vitepress/dist"

echo "==> Building docs (vitepress build docs)..."
npm run docs:build

echo ""
node scripts/check-vitepress-dist-policy.js

echo ""
echo "==> Verifying dist output in $DIST..."

EXPECTED_FILES=()
shopt -s nullglob
for md in docs/*.md; do
  basename="${md##*/}"
  html="${basename%.md}.html"
  EXPECTED_FILES+=("$html")
done
shopt -u nullglob

if [ "${#EXPECTED_FILES[@]}" -eq 0 ]; then
  echo "  No top-level docs/*.md pages found; skipping top-level page check"
else
  echo "  Expecting ${#EXPECTED_FILES[@]} page(s) derived from docs/*.md:"
  for f in "${EXPECTED_FILES[@]}"; do
    echo "    $f"
  done
fi

echo ""
ALL_OK=true
for f in "${EXPECTED_FILES[@]}"; do
  path="$DIST/$f"
  if [ -f "$path" ] && [ -s "$path" ]; then
    echo "  ✓ $f"
  else
    echo "  ✗ MISSING or EMPTY: $f"
    ALL_OK=false
  fi
done

echo ""
echo "==> Explicit landing-page check: $DIST/index.html"
if [ ! -f docs/index.md ]; then
  echo "  No docs/index.md source page; skipping landing-page check"
elif [ -f "$DIST/index.html" ] && [ -s "$DIST/index.html" ]; then
  echo "  ✓ index.html (landing page present and non-empty)"
else
  echo "  ✗ MISSING or EMPTY: index.html (landing page)"
  ALL_OK=false
fi

echo ""
node scripts/verify-doc-routes.js || ALL_OK=false

echo ""
node scripts/check-design-doc-links.js || ALL_OK=false

echo ""
node scripts/check-historical-isolation.js || ALL_OK=false

echo ""
echo "==> Verifying fixture-backed operator API response contracts..."
NODE_OPTIONS=--experimental-vm-modules npx jest tests/server/operator-api-contract-fixtures.test.ts --runInBand || ALL_OK=false

echo ""
node scripts/check-markdown-links.js || ALL_OK=false

echo ""
node scripts/check-source-anchors.js --doc README.md --doc docs || ALL_OK=false

echo ""
node scripts/check-validation-cadence.js || ALL_OK=false

echo ""
if $ALL_OK; then
  echo "✓ docs:verify passed — docs build output, VitePress dist artifact policy, route/debug-route/role/config anchors, architecture links, canonical-doc historical isolation, operator API response contracts, planner and non-planner agent tool docs/source parity, global Markdown links, README.md/docs source anchors, and validation cadence are valid"
else
  echo "✗ docs:verify FAILED — one or more documentation build or drift guards failed"
  exit 1
fi
