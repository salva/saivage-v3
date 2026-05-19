#!/usr/bin/env bash
set -euo pipefail

# docs:verify — Build VitePress docs and run documentation drift guards.
# Used by the root npm script "docs:verify".
#
# Guard bundle:
#   - VitePress build output for top-level docs/*.md pages.
#   - Operator route, agent-tool, runtime-control, config-schema, and anchor parity.
#   - Documentation inventory completeness for root/docs Markdown.
#   - Design-doc allowed-link boundaries.
#   - Historical-link isolation for current/stale docs.
#   - Runbook curl/example route and response-shape checks.
#   - Global Markdown internal-link and anchor resolution.
#   - Audit/UI finding dossier status, resolution, and remediation-log consistency.

DIST="docs/.vitepress/dist"

echo "==> Building docs (vitepress build docs)..."
npm run docs:build

echo ""
echo "==> Verifying dist output in $DIST..."

EXPECTED_FILES=()
for md in docs/*.md; do
  basename="${md##*/}"
  html="${basename%.md}.html"
  EXPECTED_FILES+=("$html")
done

if [ "${#EXPECTED_FILES[@]}" -eq 0 ]; then
  echo "  ✗ No docs/*.md files found — nothing to verify"
  exit 1
fi

echo "  Expecting ${#EXPECTED_FILES[@]} page(s) derived from docs/*.md:"
for f in "${EXPECTED_FILES[@]}"; do
  echo "    $f"
done

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
if [ -f "$DIST/index.html" ] && [ -s "$DIST/index.html" ]; then
  echo "  ✓ index.html (landing page present and non-empty)"
else
  echo "  ✗ MISSING or EMPTY: index.html (landing page)"
  ALL_OK=false
fi

echo ""
node scripts/verify-doc-routes.js || ALL_OK=false

echo ""
node scripts/check-doc-inventory.js || ALL_OK=false

echo ""
node scripts/check-design-doc-links.js || ALL_OK=false

echo ""
node scripts/check-historical-isolation.js || ALL_OK=false

echo ""
node scripts/check-runbook-curl-examples.js || ALL_OK=false

echo ""
node scripts/check-markdown-links.js || ALL_OK=false

echo ""
node scripts/check-finding-dossiers.js || ALL_OK=false

echo ""
if $ALL_OK; then
  echo "✓ docs:verify passed — docs build output, route/role/config/runtime anchors, documentation inventory, design links, historical isolation, runbook examples, global Markdown links, and finding dossiers are valid"
else
  echo "✗ docs:verify FAILED — one or more documentation build or drift guards failed"
  exit 1
fi
