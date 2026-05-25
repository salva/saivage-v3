#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"; PLAN_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"; OUT="$PLAN_DIR/scripts/out/current-gates.json"
bash "$SCRIPT_DIR/run-gates.sh" > "$OUT"
for id in tsc-build web-vite-build web-vitest analyst-e2e; do test -f "$PLAN_DIR/scripts/out/raw/$id.log" || { echo "missing raw log for $id" >&2; exit 1; }; done
jq -e --slurpfile b "$PLAN_DIR/baseline-gates.json" '([.gates[].id] == ["tsc-build","web-vite-build","web-vitest","analyst-e2e"]) and ([.gates[].id] == [$b[0].gates[].id]) and all(.gates[]; (.failing_ids|type)=="array" and all(.failing_ids[]; type=="string"))' "$OUT" >/dev/null || { echo "validate-baseline.sh: emitted snapshot has wrong gate order or invalid failing_ids arrays" >&2; exit 1; }
empty_abort="$(jq -r '.gates[] | select(.observed_exit_code != 0 and (.failing_ids|length) == 0) | .id' "$OUT" | head -n 1)"
if [[ -n "$empty_abort" ]]; then
  echo "gate exited nonzero with zero failing_ids: $empty_abort" >&2
  exit 1
fi
