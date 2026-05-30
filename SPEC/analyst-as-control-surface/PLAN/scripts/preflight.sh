#!/usr/bin/env bash
set -u -o pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"; WORKSPACE_ROOT="$(cd "$SCRIPT_DIR/../../../../.." && pwd)"; PLAN_DIR="$WORKSPACE_ROOT/saivage-v3/SPEC/analyst-as-control-surface/PLAN"; failures=()
pass(){ echo "[PASS] $1 — $2"; }; fail(){ echo "[FAIL] $1 — $2"; failures+=("$1"); }
ping -c1 -W2 10.0.3.112 >/dev/null 2>&1 && pass 1 "LXC container reachable" || fail 1 "harness container 10.0.3.112 is unreachable"
if command -v jq >/dev/null 2>&1 && curl --silent --show-error --fail --max-time 10 http://10.0.3.112:8080/health 2>/dev/null | jq -e '.status == "ok" // (. != null)' >/dev/null 2>&1; then pass 2 "health endpoint returned parseable OK JSON"; else fail 2 "health endpoint did not return 200 parseable OK JSON"; fi
[[ "${OPERATOR_CONFIRM_SERVICE_ACTIVE:-}" == "yes" ]] && pass 3 "OPERATOR_CONFIRM_SERVICE_ACTIVE=yes" || fail 3 "operator has not confirmed saivage.service active (set OPERATOR_CONFIRM_SERVICE_ACTIVE=yes)"
bad=$(find "$PLAN_DIR/stages" -mindepth 1 -maxdepth 1 -printf '%f\n' 2>/dev/null | grep -Ev '^[0-9]{3}-[a-z0-9]+(-[a-z0-9]+)*$' | wc -l | tr -d ' '); [[ "$bad" == 0 ]] && pass 4 "stages directory contains only published stage names or nothing" || fail 4 "stray entry under stages/"
if command -v jq >/dev/null 2>&1 && jq -e '.schema_version == 1 and (.gates|length == 4)' "$PLAN_DIR/baseline-gates.json" >/dev/null 2>&1; then pass 5 "baseline snapshot present and parses"; else fail 5 "baseline snapshot missing or invalid"; fi
if [[ -f "$PLAN_DIR/expected-breakage-ledger.md" ]] && [[ "$(grep -c '^## Open entries' "$PLAN_DIR/expected-breakage-ledger.md")" == 1 ]] && [[ "$(grep -c '^### ' "$PLAN_DIR/expected-breakage-ledger.md")" == 0 ]]; then pass 6 "ledger present and empty"; else fail 6 "ledger missing, malformed, or non-empty"; fi
stale=$(ls "$WORKSPACE_ROOT/saivage-v3/.saivage/tmp/state/shutdown-summary.json" "$WORKSPACE_ROOT/saivage-v3/.saivage/tmp/state/shutdown-request.json" 2>/dev/null | wc -l | tr -d ' '); [[ "$stale" == 0 ]] && pass 7 "no stale shutdown handoff state" || fail 7 "stale shutdown handoff files exist and must be removed by harness owner"
missing=""; for f in saivage.json config.json plan.json plan-history.json runtime/runtime-state.json; do test -f "$WORKSPACE_ROOT/saivage-v3/.saivage/$f" || { missing="$f"; break; }; done; [[ -z "$missing" ]] && pass 8 "expected v2 harness runtime files exist" || fail 8 "missing saivage-v3/.saivage/$missing"
[[ "${OPERATOR_CONFIRM_WATCHED_PATH:-}" == "yes" ]] && pass 9 "OPERATOR_CONFIRM_WATCHED_PATH=yes" || fail 9 "operator has not confirmed the consumer is watching the stages path (set OPERATOR_CONFIRM_WATCHED_PATH=yes)"
if [[ ${#failures[@]} -eq 0 ]]; then echo "PREFLIGHT OK"; exit 0; else IFS=,; echo "PREFLIGHT FAILED: ${failures[*]}"; exit 1; fi
