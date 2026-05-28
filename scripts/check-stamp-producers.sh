#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
fail=0
check_absent() {
  local label="$1" pattern="$2" paths="$3" exclude="${4:-}"
  local out
  if [[ -n "$exclude" ]]; then
    out=$(git grep -nE "$pattern" -- $paths | grep -vE "$exclude" || true)
  else
    out=$(git grep -nE "$pattern" -- $paths || true)
  fi
  if [[ -n "$out" ]]; then
    printf 'Forbidden stamp-producer pattern: %s\n%s\n' "$label" "$out" >&2
    fail=1
  fi
}
check_absent 'optional chained stamp/open/close calls' 'activeRuntime\?\.(stampUserMessage|stampInRound|stampPre|stampCompacted|stampDiagnosticInCurrentRound|openAssistantRound|closeRound|closeAssistantRound)' 'src/ web/src/' ''
check_absent 'literal round fallback' '\?\?\s*\{\s*round_id' 'src/ web/src/' ''
check_absent 'local stamp producer methods outside ActiveRuntime' 'private (stampInRound|stampUserMessage|openAssistantRound|closeAssistantRound|stampPre|stampCompacted|stampDiagnosticInCurrentRound)' 'src/' 'src/runtime/active-runtime\.ts'
check_absent 'legacy agent conversation fallback' 'legacyConversationEntry|legacyAgentMessage' 'src/' ''
check_absent 'contract config route owner uses hand-mounted Fastify routes' "fastify\.(get|post|patch|delete)\('/api/(config|providers|control-actions)'" 'src/server/routes/' ''
check_absent 'partial eventBus-as-never ActiveRuntime mocks' '\{ runtime: \{ eventBus \} \} as never' 'tests/' ''
check_absent 'hard-coded RoundStamp literals outside stamp producers/helpers' "\{\s*round_id:\s*['\"]r-(diagnostic|user|assistant|pre|compacted|truncated)" 'src/ web/src/' 'src/runtime/active-runtime\.ts|src/agents/session-persistence\.ts'
exit "$fail"
