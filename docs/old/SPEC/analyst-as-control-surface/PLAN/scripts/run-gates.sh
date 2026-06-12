#!/usr/bin/env bash
set -u -o pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
WORKSPACE_ROOT="$(cd "$SCRIPT_DIR/../../../../.." && pwd)"
PLAN_DIR="$WORKSPACE_ROOT/saivage-v3/SPEC/analyst-as-control-surface/PLAN"
OUT_DIR="$PLAN_DIR/scripts/out"
RAW_DIR="$OUT_DIR/raw"
TMP_DIR="$WORKSPACE_ROOT/tmp"
mkdir -p "$RAW_DIR" "$TMP_DIR"
COMPARISON_RULE="A NEW failure for a gate is any failing-id (test_id, scenario_id, or error_id) observed by a per-stage gate run that is not present in this snapshot's failing_ids array for the same gate id. The driver script implements this diff and is the single source of truth."
GATE_IDS=(tsc-build web-vite-build web-vitest analyst-e2e)
GATE_CWDS=(saivage-v3 saivage-v3/web saivage-v3/web saivage-e2e-checkers)
GATE_COMMANDS=("npx tsc -p ." "npm run build" "npx vitest run --reporter=json --outputFile=../../tmp/web-vitest-report.json" "npm run test:analyst -- --reporter=json --output=../tmp/playwright-analyst-report.json")
GATE_RUNNERS=("tsc (TypeScript compiler, emits to dist/)" "vue-tsc --noEmit && vite build" "vitest (run mode, JSON reporter)" "playwright (playwright.analyst.config.js)")
GATE_KINDS=(tsc_diagnostic web_build_diagnostic vitest_test playwright_test)
GATE_RULES=(
"Each diagnostic line matching '<path>(<line>,<col>): error TS<code>:' is normalized to 'tsc-build:<path>:<line>:TS<code>'. <path> is workspace-relative (prefix with 'saivage-v3/' when tsc emits a cwd-relative path). Warnings are ignored."
"Each diagnostic line matching '<path>(<line>,<col>): error TS<code>:' is normalized to 'web-vite-build:<path>:<line>:TS<code>' with <path> prefixed by 'saivage-v3/web/' when emitted cwd-relative. Any Rollup/vite error line matching '\\[vite\\]:' or 'error during build' that is not a vue-tsc diagnostic emits a single id 'web-vite-build:saivage-v3-web:vite-failed' (one id per run, not per line). If exit code is non-zero and no vue-tsc or vite-tagged line is observed, emit 'web-vite-build:saivage-v3-web:unknown-failure'."
"Parse the vitest JSON report at tmp/web-vitest-report.json (cwd-relative '../../tmp/web-vitest-report.json' resolves to workspace-root tmp/). Walk testResults[*]; for each assertion with status != 'passed' emit one failing-id 'web-vitest:<workspace-relative testFilePath>::<fullName>'. Suite-level failures with no assertionResults emit 'web-vitest:<workspace-relative testFilePath>::<SUITE>'."
"Parse the playwright JSON reporter file at tmp/playwright-analyst-report.json. Walk suites recursively; for each spec whose outcome is 'unexpected' or 'flaky' (any failed test attempt), emit one failing-id as 'analyst-e2e:<workspace-relative spec file>::<test title path joined by ' > '>'. Skipped tests (.fixme) are not failures."
)
mode="run"; baseline_file=""
if [[ "${1:-}" == "--baseline" ]]; then mode="baseline"; shift; elif [[ "${1:-}" == "--diff" ]]; then mode="diff"; baseline_file="${2:-}"; shift 2 || true; fi
if [[ "$mode" == "diff" && -z "$baseline_file" ]]; then echo "usage: $0 --diff <baseline.json>" >&2; exit 2; fi
if ! command -v jq >/dev/null 2>&1; then echo "run-gates.sh: missing required dependency: jq" >&2; exit 127; fi
json_escape() { jq -R .; }
parse_tsc_like() { local gate="$1" log="$2" prefix="$3"; perl -ne 'if (/^(.+)\(([0-9]+),[0-9]+\): error TS([0-9]+):/) { $p=$1; $p =~ s#^\./##; if ($p !~ m#^(saivage-v3|saivage-e2e-checkers)/#) { $p="'"$prefix"'/$p"; } print "'"$gate"':$p:$2:TS$3\n"; }' "$log" | sort -u; }
parse_web_vite() { local log="$1" exit_code="$2" tmp="$OUT_DIR/web-vite.ids"; : > "$tmp"; parse_tsc_like web-vite-build "$log" saivage-v3/web >> "$tmp"; if [[ ! -s "$tmp" ]]; then if grep -Eq '\[vite\]:|error during build' "$log"; then echo 'web-vite-build:saivage-v3-web:vite-failed' >> "$tmp"; elif [[ "$exit_code" != 0 ]]; then echo 'web-vite-build:saivage-v3-web:unknown-failure' >> "$tmp"; fi; fi; sort -u "$tmp"; }
parse_vitest() {
  local exit_code="$1" report="$TMP_DIR/web-vitest-report.json" tmp="$OUT_DIR/web-vitest.parsed.ids"
  : > "$tmp"
  if [[ -f "$report" ]]; then
    jq -r --arg root "$WORKSPACE_ROOT/" '.testResults[]? as $tr | ($tr.name // $tr.testFilePath // "unknown") as $f | ($f | sub("^"+$root; "")) as $rf | if (($tr.assertionResults // [])|length) > 0 then ($tr.assertionResults[]? | select(.status != "passed") | "web-vitest:"+$rf+"::"+((.fullName // .title // "<unnamed>")|tostring)) elif ($tr.status == "failed") then "web-vitest:"+$rf+"::<SUITE>" else empty end' "$report" > "$tmp" || : > "$tmp"
  fi
  if [[ "$exit_code" != 0 && ! -s "$tmp" ]]; then
    echo 'web-vitest:saivage-v3-web:unknown-failure' > "$tmp"
  fi
  sort -u "$tmp"
}
parse_playwright() {
  local exit_code="$1" report="$TMP_DIR/playwright-analyst-report.json" tmp="$OUT_DIR/analyst-e2e.parsed.ids"
  : > "$tmp"
  if [[ -f "$report" ]]; then
    jq -r --arg root "$WORKSPACE_ROOT/" 'def walk_suite($prefix): (.specs[]? | select((.ok? == false) or (.outcome == "unexpected") or (.outcome == "flaky") or ([.tests[]?.results[]?.status] | any(. == "failed" or . == "timedOut" or . == "interrupted"))) | "analyst-e2e:"+((.file // "unknown")|sub("^"+$root; ""))+"::"+((($prefix + [.title]) | map(tostring)) | join(" > "))) , (.suites[]? | walk_suite($prefix + [(.title // empty)])); .suites[]? | walk_suite([.title // empty])' "$report" > "$tmp" || : > "$tmp"
  fi
  if [[ "$exit_code" != 0 && ! -s "$tmp" ]]; then
    echo 'analyst-e2e:saivage-e2e-checkers:unknown-failure' > "$tmp"
  fi
  sort -u "$tmp"
}
run_gate() {
  local i="$1" id="${GATE_IDS[$i]}" cwd="${GATE_CWDS[$i]}" cmd="${GATE_COMMANDS[$i]}" log="$RAW_DIR/$id.log"
  : > "$log"
  case "$id" in
    web-vitest) rm -f "$TMP_DIR/web-vitest-report.json" ;;
    analyst-e2e) rm -f "$TMP_DIR/playwright-analyst-report.json" ;;
  esac
  ( cd "$WORKSPACE_ROOT/$cwd" && bash -c "$cmd" ) > >(tee -a "$log" >&2) 2> >(tee -a "$log" >&2)
  return $?
}
ids_files=(); exit_codes=()
for i in 0 1 2 3; do id="${GATE_IDS[$i]}"; ids_file="$OUT_DIR/$id.ids"; ids_files+=("$ids_file"); run_gate "$i"; ec=$?; exit_codes+=("$ec"); case "$id" in tsc-build) parse_tsc_like tsc-build "$RAW_DIR/$id.log" saivage-v3 > "$ids_file";; web-vite-build) parse_web_vite "$RAW_DIR/$id.log" "$ec" > "$ids_file";; web-vitest) parse_vitest "$ec" > "$ids_file";; analyst-e2e) parse_playwright "$ec" > "$ids_file";; esac; done
captured_by="per-stage gate run"; [[ "$mode" == "baseline" ]] && captured_by="saivage-v3 S00 baseline"
snapshot="$OUT_DIR/last-snapshot.json"
{
  printf '{\n  "schema_version": 1,\n  "captured_at": %s,\n  "captured_by": %s,\n  "workspace_root": %s,\n  "comparison_rule": %s,\n  "gates": [\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ | json_escape)" "$(printf '%s' "$captured_by" | json_escape)" "$(printf '%s' "$WORKSPACE_ROOT" | json_escape)" "$(printf '%s' "$COMPARISON_RULE" | json_escape)"
  for i in 0 1 2 3; do [[ $i -gt 0 ]] && printf ',\n'; jq -n --arg id "${GATE_IDS[$i]}" --arg cwd "${GATE_CWDS[$i]}" --arg command "${GATE_COMMANDS[$i]}" --arg runner "${GATE_RUNNERS[$i]}" --arg kind "${GATE_KINDS[$i]}" --argjson ec "${exit_codes[$i]}" --arg rule "${GATE_RULES[$i]}" --slurpfile ids <(jq -R . "${ids_files[$i]}" | jq -s 'sort|unique') '{id:$id,cwd:$cwd,command:$command,runner:$runner,failure_id_kind:$kind,expected_exit_code_when_clean:0,observed_exit_code:$ec,normalization_rule:$rule,failing_ids:$ids[0]}'; done
  printf '\n  ]\n}\n'
} > "$snapshot"
if [[ "$mode" == "diff" ]]; then
  has_new=0
  baseline_invalid=0
  stale_baseline_ids="$(jq -r '.gates[] | select(.observed_exit_code != 0 and (.failing_ids|length) == 0) | .id + " observed_exit_code=" + (.observed_exit_code|tostring) + " with zero failing_ids"' "$baseline_file")"
  if [[ -n "$stale_baseline_ids" ]]; then
    baseline_invalid=1
    echo "BASELINE INVALID: nonzero gate exits with empty failing_ids" >&2
    printf '%s
' "$stale_baseline_ids" >&2
  fi
  for id in "${GATE_IDS[@]}"; do echo "## $id"; echo "NEW"; jq -n -r --arg id "$id" --slurpfile b "$baseline_file" --slurpfile c "$snapshot" '($b[0].gates[]|select(.id==$id)|.failing_ids) as $B | ($c[0].gates[]|select(.id==$id)|.failing_ids)[] | select(. as $x | ($B|index($x)|not))' | tee "$OUT_DIR/$id.new"; [[ -s "$OUT_DIR/$id.new" ]] && has_new=1; echo "REPAIRED"; jq -n -r --arg id "$id" --slurpfile b "$baseline_file" --slurpfile c "$snapshot" '($c[0].gates[]|select(.id==$id)|.failing_ids) as $C | ($b[0].gates[]|select(.id==$id)|.failing_ids)[] | select(. as $x | ($C|index($x)|not))'; done
  [[ "$baseline_invalid" == 1 ]] && exit 1
  exit "$has_new"
else cat "$snapshot"; fi
