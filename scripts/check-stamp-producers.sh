#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
fail=0
check_absent() {
  local label="$1" pattern="$2" paths="$3" exclude="${4:-}"
  local out
  if [[ -n "$exclude" ]]; then
    out=$(grep -rEn --include='*.ts' --include='*.vue' "$pattern" $paths | grep -vE "$exclude" || true)
  else
    out=$(grep -rEn --include='*.ts' --include='*.vue' "$pattern" $paths || true)
  fi
  if [[ -n "$out" ]]; then
    printf 'Forbidden stamp-producer pattern: %s\n%s\n' "$label" "$out" >&2
    fail=1
  fi
}
check_anchor() {
  local label="$1" pattern="$2" paths="$3"
  if ! grep -rEq --include='*.ts' --include='*.vue' "$pattern" $paths; then
    printf 'Stale rule / vacated anchor: %s — anchor pattern no longer matches; update or delete the rule.\n' "$label" >&2
    fail=1
  fi
}
round_literal_pattern="['\"\\\`]r-(pre|user|assistant|compacted)-"
check_anchor 'round-id producer exclusivity (generateRoundId defined)' 'function generateRoundId' 'src/schemas/round-id-server.ts'
check_anchor 'round-id producer exclusivity (deterministicRoundId defined)' 'function deterministicRoundId' 'src/schemas/round-id-server.ts'
check_anchor 'round-id producer exclusivity (r-${kind}- template)' 'r-\$\{kind\}-' 'src/schemas/round-id-server.ts'
check_absent 'local round-id producer functions outside the server producer module' '(function|const) (generateRoundId|deterministicRoundId)' 'src/' 'src/schemas/round-id-server\.ts'
check_absent 'hard-coded RoundStamp literals outside round-id producers' "$round_literal_pattern" 'src/ web/src/' 'src/schemas/round-id-server\.ts|web/src/utils/round-id\.ts|__tests__/|\.test\.ts'
check_anchor 'contract route ownership (operator contracts mount)' 'runtime\.mount\(' 'src/server/routes/operator-contracts.ts'
check_anchor 'contract route ownership (contract runtime route mounting)' 'fastify\.route\(' 'src/server/contract-runtime.ts'
check_absent 'hand-mounted Fastify /api/ routes outside the contract runtime' "fastify\.(get|post|put|patch|delete|head|options)\(\s*['\"]/api/" 'src/server/' 'src/server/contract-runtime\.ts'
exit "$fail"
