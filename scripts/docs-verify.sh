#!/usr/bin/env bash
set -euo pipefail

# docs:verify — Build VitePress docs and run documentation drift guards.
# Used by the root npm script "docs:verify".
#
# Guard bundle:
#   - VitePress docs build (vitepress build docs).
#   - VitePress dist artifact policy: docs/.vitepress/dist is ignored generated output.
#   - Operator route, internal-debug route, agent-tool, config-schema, and anchor parity against canonical docs.
#   - Architecture-doc allowed-link boundaries.
#   - Historical-link isolation for canonical current docs.
#   - Fixture-backed operator API response contract checks.
#   - Named-agent tool documentation/source parity checks.
#   - Global Markdown internal-link and anchor resolution.
#   - Documented source-anchor path/line validation for README.md and docs/.
#   - Validation-cadence command/package-script/docs:verify sub-guard parity, including operator smoke command drift (without executing Vitest smoke).

echo "==> Building docs (vitepress build docs)..."
npm run docs:build

echo ""
node scripts/check-vitepress-dist-policy.js

echo ""
ALL_OK=true

echo ""
node scripts/verify-doc-routes.js || ALL_OK=false

echo ""
node scripts/check-design-doc-links.js || ALL_OK=false

echo ""
node scripts/check-historical-isolation.js || ALL_OK=false

echo ""
echo "==> Verifying operator API response contracts..."
NODE_OPTIONS=--experimental-vm-modules npx jest tests/server/operator-api-contracts.test.ts --runInBand || ALL_OK=false

echo ""
node scripts/check-markdown-links.js || ALL_OK=false

echo ""
node scripts/check-source-anchors.js --doc README.md --doc docs || ALL_OK=false

echo ""
node scripts/check-validation-cadence.js || ALL_OK=false

echo ""
if $ALL_OK; then
  echo "✓ docs:verify passed — VitePress docs build, dist artifact policy, route/debug-route/agent/config anchors, architecture links, canonical-doc historical isolation, operator API response contracts, named-agent tool docs/source parity, global Markdown links, README.md/docs source anchors, and validation cadence are valid"
else
  echo "✗ docs:verify FAILED — one or more documentation build or drift guards failed"
  exit 1
fi
