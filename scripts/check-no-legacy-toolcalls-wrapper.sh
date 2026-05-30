#!/usr/bin/env bash
set -uo pipefail
fail=0
check() {
  local name="$1"; shift
  local out
  out=$("$@") || true
  if [ -n "$out" ]; then
    echo "SWEEP FAIL: $name"
    echo "$out"
    fail=1
  fi
}
check "response_format or .toolCalls in src/" bash -c "grep -rn 'response_format\|\\.toolCalls' src/ --include='*.ts' | grep -v 'never_sends\\|deprecated_marker'"
check "deleted symbols in src/" bash -c "grep -rn 'extractJson\\|parsePersistedToolCalls\\|parseToolCallsFromResponse\\|envelopeMode\\|responseShape\\|forceFinalAnswer\\|handleToolCallsLoop\\|ResultParseError\\|buildExecutorFallbackResult\\|parsePlannerResult\\|parseExecutorResult\\|parseReviewerResult\\|LlmEnvelopeOptions' src/ --include='*.ts' | grep -v 'deprecated_marker'"
check "toolCalls: in tests/web" bash -c "grep -rn 'toolCalls:' tests/ web/src/__tests__/ web/src/utils/ | grep -v 'capabilities:'"
check "response_format in gateways" grep -n "response_format" src/agents/llm-openai-chat-gateway.ts src/agents/llm-openai-codex-gateway.ts
check "parallel_tool_calls truthy" bash -c "grep -n 'parallel_tool_calls' src/agents/llm-openai-chat-gateway.ts src/agents/llm-openai-codex-gateway.ts | grep -v 'false'"
check "class-based contract errors" grep -rn "LlmContractMismatchError\|LegacyMessageShapeError" src/ tests/ web/src/
check "instanceof contract errors" bash -c "grep -rnE 'instanceof\\s+\\w*(ContractMismatch|LegacyMessage)' src/ tests/ web/src/"
exit $fail
