#!/usr/bin/env bash
set -euo pipefail

# docs:verify — Build VitePress docs and sanity-check the output
# Used by the root npm script "docs:verify"
# Requires: npm (for vitepress), bash
#
# Maintenance contract:
#   This script auto-discovers expected top-level HTML pages from docs/*.md.
#   - index.md      → index.html     (VitePress special case)
#   - anything.md   → anything.html  (standard mapping)
#   Add a new docs/*.md page and it is automatically verified.
#   No hardcoded page list to keep in sync.
#   The landing page (index.html) is also explicitly verified as a
#   hardcoded check, independent of the auto-discovery loop.

DIST="docs/.vitepress/dist"

echo "==> Building docs (vitepress build docs)..."
npm run docs:build

echo ""
echo "==> Verifying dist output in $DIST..."

# Derive expected HTML pages from docs/*.md files (non-recursive, top-level only)
EXPECTED_FILES=()
for md in docs/*.md; do
  basename="${md##*/}"               # strip docs/
  html="${basename%.md}.html"        # replace .md → .html
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

# Explicit landing-page check (hardcoded, independent of auto-discovery)
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
if $ALL_OK; then
  echo "✓ docs:verify passed — all expected output files are present, non-empty, route docs match the server, documentation inventory is complete, and design-doc links stay in allowed locations, and current docs isolate historical links"
else
  echo "✗ docs:verify FAILED — generated docs, operator route docs, documentation inventory, design-doc links, or historical-link isolation are invalid"
  exit 1
fi
