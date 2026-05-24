#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"; PLAN_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"; OUT="$PLAN_DIR/scripts/out/current-gates.json"
bash "$SCRIPT_DIR/run-gates.sh" > "$OUT"
for id in tsc-build web-vite-build web-vitest analyst-e2e; do test -f "$PLAN_DIR/scripts/out/raw/$id.log" || { echo "missing raw log for $id" >&2; exit 1; }; done
jq -e --slurpfile b "$PLAN_DIR/baseline-gates.json" '([.gates[].id] == ["tsc-build","web-vite-build","web-vitest","analyst-e2e"]) and ([.gates[].id] == [$b[0].gates[].id]) and all(.gates[]; (.failing_ids|type)=="array" and all(.failing_ids[]; type=="string") and (.observed_exit_code == 0))' "$OUT" >/dev/null || { echo "validate-baseline.sh: one or more gates exited nonzero or emitted an invalid failing_ids array" >&2; exit 1; }
nonzero_gate="$(jq -r '.gates[] | select(.observed_exit_code != 0) | .id + " observed_exit_code=" + (.observed_exit_code|tostring)' "$OUT" | head -n 1)"
if [[ -n "$nonzero_gate" ]]; then
  echo "gate exited nonzero during baseline validation: $nonzero_gate" >&2
  exit 1
fi
empty_abort="$(jq -r '.gates[] | select(.observed_exit_code != 0 and (.failing_ids|length) == 0) | .id' "$OUT" | head -n 1)"
if [[ -n "$empty_abort" ]]; then
  echo "gate exited nonzero with zero failing_ids: $empty_abort" >&2
  exit 1
fi
