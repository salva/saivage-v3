#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"; COOKBOOK="$(cd "$SCRIPT_DIR/.." && pwd)/VALIDATION-COOKBOOK.md"
expected=("## 1. Purpose" "## 2. Pre-conditions" "## 3. Gate command blocks" "## 4. Driver invocation" "## 5. Comparison rule" "## 6. Close criterion" "## 7. Ledger update procedure" "## 8. Ledger entry shape" "## 9. Activation preflight" "## 10. Pre-publication forbidden-anchor grep")
mapfile -t actual < <(grep '^## ' "$COOKBOOK")
[[ ${#actual[@]} -eq ${#expected[@]} ]] || { echo "expected ${#expected[@]} H2 headings, found ${#actual[@]}" >&2; exit 1; }
for i in "${!expected[@]}"; do [[ "${actual[$i]}" == "${expected[$i]}" ]] || { echo "heading $((i+1)) mismatch: ${actual[$i]}" >&2; exit 1; }; [[ $(grep -Fx "${expected[$i]}" "$COOKBOOK" | wc -l | tr -d ' ') == 1 ]] || { echo "heading not unique: ${expected[$i]}" >&2; exit 1; }; done
