#!/usr/bin/env bash
set -euo pipefail

# docs:verify — Build VitePress docs and sanity-check the output
# Used by the root npm script "docs:verify"
# Requires: npm (for vitepress), bash

DIST="docs/.vitepress/dist"
EXPECTED_FILES=(
  "index.html"
  "install.html"
  "configuration.html"
  "operation.html"
  "operator-runbook.html"
  "troubleshooting.html"
  "release-checklist.html"
)

echo "==> Building docs (vitepress build docs)..."
npm run docs:build

echo ""
echo "==> Verifying dist output in $DIST..."

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
if $ALL_OK; then
  echo "✓ docs:verify passed — all expected output files present and non-empty"
else
  echo "✗ docs:verify FAILED — some output files are missing or empty"
  exit 1
fi
