#!/usr/bin/env bash
set -euo pipefail

# docs:verify — Build VitePress docs and run documentation drift guards.
# Used by the root npm script "docs:verify".
#
# Guard bundle:
#   - VitePress build output for top-level docs/*.md pages.
#   - VitePress dist artifact policy: docs/.vitepress/dist is ignored generated output.
#   - Operator route, agent-tool, runtime-control, config-schema, and anchor parity.
#   - Design-doc allowed-link boundaries.
#   - Historical-link isolation for current/stale docs.
#   - Runbook curl/example route and response-shape checks.
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
if [ -f docs/operation.md ] && [ -f docs/agents.md ] && [ -f docs/configuration.md ]; then
  node scripts/verify-doc-routes.js || ALL_OK=false
else
  echo "Skipping operator route/tool/config doc parity; current docs do not include docs/operation.md, docs/agents.md, and docs/configuration.md"
fi

echo ""
if [ -d docs/design ]; then
  node scripts/check-design-doc-links.js || ALL_OK=false
else
  echo "Skipping design-doc link check; docs/design/ is not part of current docs"
fi

echo ""
if [ -f docs/operation.md ] && [ -f docs/agents.md ]; then
  node scripts/check-historical-isolation.js || ALL_OK=false
else
  echo "Skipping historical isolation check; old documentation is outside docs/"
fi

echo ""
if [ -d docs/runbook ]; then
  node scripts/check-runbook-curl-examples.js || ALL_OK=false
else
  echo "Skipping runbook curl/http example check; docs/runbook/ is not part of current docs"
fi

echo ""
echo "==> Verifying fixture-backed operator API response contracts..."
if [ -f docs/runbook/operations.md ]; then
  NODE_OPTIONS=--experimental-vm-modules npx jest tests/server/operator-api-contract-fixtures.test.ts --runInBand || ALL_OK=false
else
  echo "Skipping operator API response contract doc fixtures; docs/runbook/operations.md is not part of current docs"
fi

echo ""
echo "==> Verifying planner tool docs/source parity..."
if [ -f docs/agents.md ]; then
  NODE_OPTIONS=--experimental-vm-modules npx jest tests/agents/agent-adapter-planner-tools.test.ts --runInBand || ALL_OK=false
else
  echo "Skipping planner tool docs/source parity; docs/agents.md is not part of current docs"
fi

echo ""
echo "==> Verifying non-planner agent tool docs/source parity..."
if [ -f docs/agents.md ]; then
  NODE_OPTIONS=--experimental-vm-modules npx jest tests/agents/agent-adapter-non-planner-tools.test.ts --runInBand || ALL_OK=false
else
  echo "Skipping non-planner tool docs/source parity; docs/agents.md is not part of current docs"
fi

echo ""
node scripts/check-markdown-links.js || ALL_OK=false

echo ""
node scripts/check-source-anchors.js --doc README.md --doc docs || ALL_OK=false

echo ""
if [ -d docs/runbook ]; then
  node scripts/check-validation-cadence.js || ALL_OK=false
else
  echo "Skipping validation cadence check; docs/runbook/ is not part of current docs"
fi

echo ""
if $ALL_OK; then
  echo "✓ docs:verify passed — docs build output, VitePress dist artifact policy, route/role/config/runtime anchors, design links, historical isolation, runbook examples, operator API response contracts, planner and non-planner agent tool docs/source parity, global Markdown links, README.md/docs source anchors, and validation cadence are valid"
else
  echo "✗ docs:verify FAILED — one or more documentation build or drift guards failed"
  exit 1
fi
