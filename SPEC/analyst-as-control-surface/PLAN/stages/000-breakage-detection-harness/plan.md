# Stage 000 — Breakage Detection Harness — Plan

This plan is the step-by-step companion to [design.md](./design.md). Every design decision is already made; this document only sequences the concrete operations.

## Pre-conditions

Verify before the first edit:

1. The workspace at `/home/salva/g/ml` is on the intended branch and has no uncommitted local changes that would interfere with this stage. Confirm with `git -C /home/salva/g/ml status --porcelain`; it prints nothing, or only files the operator has explicitly authorised the implementer to touch.
2. Node and npm versions match [saivage-v3/package.json](saivage-v3/package.json) engines (`node >=22.12.0`, `npm >=10`). `node --version && npm --version` confirms.
3. [saivage-v3/node_modules/](saivage-v3/node_modules/) is populated (`( cd saivage-v3 && npm ci )` is the way to populate from scratch; skip if already present).
4. [saivage-v3/web/node_modules/](saivage-v3/web/node_modules/) is populated (`( cd saivage-v3/web && npm ci )`).
5. [saivage-e2e-checkers/node_modules/](saivage-e2e-checkers/node_modules/) is populated (`( cd saivage-e2e-checkers && npm ci )`).
6. Playwright browser binaries installed on this host: `npx --prefix saivage-e2e-checkers playwright install --with-deps chromium`. If already installed, the command is a no-op.
7. Workspace-level [tmp/](tmp/) directory exists and is writable: `mkdir -p tmp && test -w tmp`.
8. Workspace [.gitignore](.gitignore) already ignores [tmp/](tmp/) (verify by `git -C /home/salva/g/ml check-ignore -v tmp/anything`).
9. `jq` is installed and on `PATH`: `command -v jq`.
10. The v2-on-v3 LXC container at `10.0.3.112` is reachable from the workspace host: `ping -c1 -W2 10.0.3.112`. If not, STOP and tell the operator; do not attempt to start or repair the container.
11. The three canonical inputs exist at their expected paths: [saivage-v3/SPEC/analyst-as-control-surface/SPEC-r7.md](saivage-v3/SPEC/analyst-as-control-surface/SPEC-r7.md), [saivage-v3/SPEC/analyst-as-control-surface/PLAN/00-MASTER-PLAN-r7.md](saivage-v3/SPEC/analyst-as-control-surface/PLAN/00-MASTER-PLAN-r7.md), [saivage-v3/SPEC/analyst-as-control-surface/PLAN/PROTOCOL-r4.md](saivage-v3/SPEC/analyst-as-control-surface/PLAN/PROTOCOL-r4.md), plus this stage's [design.md](./design.md).

## Step-by-step implementation

### Phase A — Driver script and ignores

A.1 Create the scripts directory: `mkdir -p saivage-v3/SPEC/analyst-as-control-surface/PLAN/scripts/out/raw`.

A.2 Add a `.gitignore` inside [saivage-v3/SPEC/analyst-as-control-surface/PLAN/scripts/](saivage-v3/SPEC/analyst-as-control-surface/PLAN/scripts/) containing exactly the single line `out/` so the transient snapshot and raw logs never become tracked.

A.3 Create the driver script at [saivage-v3/SPEC/analyst-as-control-surface/PLAN/scripts/run-gates.sh](saivage-v3/SPEC/analyst-as-control-surface/PLAN/scripts/run-gates.sh). The script:

- Sets `WORKSPACE_ROOT="$(cd "$(dirname "$0")"/../../../../.. && pwd)"` (resolves to `/home/salva/g/ml`).
- Defines the four gate descriptors inline (id, cwd, command, normalization rule). Source of truth is [design.md](./design.md); the script's gate table mirrors the JSON literally.
- For each gate: `( cd "$WORKSPACE_ROOT/$cwd" && bash -c "$command" )` with stdout+stderr tee'd into `PLAN/scripts/out/raw/<id>.log`. Captures exit code into a per-gate variable.
- Parses the runner output per gate's normalization rule into a sorted, de-duplicated array of failing-id strings:
  - `tsc-build`: grep over the captured tsc log; line regex `^(.+)\(([0-9]+),[0-9]+\): error TS([0-9]+):`; emit `tsc-build:<path>:<line>:TS<code>` with path made workspace-relative.
  - `web-vite-build`: same vue-tsc regex emits `web-vite-build:<path>:<line>:TS<code>`; additionally, if the captured log contains `[vite]:` or `error during build` and no vue-tsc line, emit one id `web-vite-build:saivage-v3-web:vite-failed`; if exit is non-zero and no recognised diagnostic is present, emit `web-vite-build:saivage-v3-web:unknown-failure`.
  - `web-vitest`: read `tmp/web-vitest-report.json` with `jq`; for each entry in `testResults` with `status != "passed"`, walk `assertionResults` and emit `web-vitest:<workspace-relative testFilePath>::<fullName>` per failed assertion; if a `testResult` has `status == "failed"` and `assertionResults` is empty, emit `web-vitest:<...>::<SUITE>`.
  - `analyst-e2e`: read `tmp/playwright-analyst-report.json` with `jq`; recursively walk `suites[*].specs[*]`; for each spec whose outcome is `unexpected` or `flaky`, emit `analyst-e2e:<workspace-relative spec file>::<title chain joined by ' > '>`.
- Emits a JSON document to stdout matching the snapshot shape in [design.md](./design.md), with `captured_at` set to the current ISO-8601 UTC timestamp, `captured_by` set to `"per-stage gate run"` (or `"saivage-v3 S00 baseline"` when invoked with `--baseline`), and the four `gates[].failing_ids` arrays populated from the parses above.
- Supports `--diff <baseline.json>`: reads the baseline file, runs the gates, and prints per-gate `NEW` and `REPAIRED` sections to stdout. Exit code 0 when every gate's NEW set is empty; 1 otherwise.
- Supports `--baseline`: identical to the bare invocation except `captured_by` is `"saivage-v3 S00 baseline"`. This is how S00 captures the first snapshot.
- Uses only `bash`, `jq`, and the existing `npm` / `npx` scripts. Verifies `command -v jq` and aborts with a clear error if missing.

A.4 `chmod +x saivage-v3/SPEC/analyst-as-control-surface/PLAN/scripts/run-gates.sh`.

A.5 Smoke-test the driver in current-snapshot mode: `bash saivage-v3/SPEC/analyst-as-control-surface/PLAN/scripts/run-gates.sh > saivage-v3/SPEC/analyst-as-control-surface/PLAN/scripts/out/current-gates.json`. Verify with `jq -e '.gates | length == 4' saivage-v3/SPEC/analyst-as-control-surface/PLAN/scripts/out/current-gates.json`.

### Phase B — Capture the baseline snapshot

B.1 Confirm the live `/health` returns 200 at capture time. Run `curl --silent --show-error --fail --max-time 10 http://10.0.3.112:8080/health | jq -e '.status == "ok" // (. != null)'`. If it fails, STOP and tell the operator; the implementer does not repair the container.

B.2 Capture the baseline: `bash saivage-v3/SPEC/analyst-as-control-surface/PLAN/scripts/run-gates.sh --baseline > saivage-v3/SPEC/analyst-as-control-surface/PLAN/baseline-gates.json`. Inspect: `jq '.gates[] | {id, observed_exit_code, n_failing: (.failing_ids|length)}' saivage-v3/SPEC/analyst-as-control-surface/PLAN/baseline-gates.json`.

B.3 If any gate aborted by environment (e.g. missing playwright browser, missing `jq`), fix the environment (re-run the install command from Pre-conditions) and re-run Phase B from B.2. Do not patch product code.

B.4 The baseline snapshot is the committed source of truth for the failing-id sets observed at this moment. Implementers do NOT hand-edit `failing_ids`; the array is whatever the driver emitted.

### Phase C — Cookbook

C.1 Create [saivage-v3/SPEC/analyst-as-control-surface/PLAN/VALIDATION-COOKBOOK.md](saivage-v3/SPEC/analyst-as-control-surface/PLAN/VALIDATION-COOKBOOK.md) with the ten H2 sections enumerated in design [Cookbook contract](./design.md#cookbook-contract). Use the exact literal H2 strings (`## 1. Purpose`, `## 2. Pre-conditions`, ..., `## 10. Pre-publication forbidden-anchor grep`) so the section-validator script can grep for them.

C.2 Section 1 (`## 1. Purpose`): one sentence identifying the file.

C.3 Section 2 (`## 2. Pre-conditions`): copy from Pre-conditions items 2–9 above (skip stage-local items 1, 10, 11).

C.4 Section 3 (`## 3. Gate command blocks`): one fenced `bash` block per gate. Exact contents per gate:

```bash
# Gate tsc-build
( cd /home/salva/g/ml/saivage-v3 && npx tsc -p . )
```

```bash
# Gate web-vite-build
( cd /home/salva/g/ml/saivage-v3/web && npm run build )
```

```bash
# Gate web-vitest
mkdir -p /home/salva/g/ml/tmp
( cd /home/salva/g/ml/saivage-v3/web && npx vitest run --reporter=json --outputFile=../../tmp/web-vitest-report.json )
```

```bash
# Gate analyst-e2e
mkdir -p /home/salva/g/ml/tmp
( cd /home/salva/g/ml/saivage-e2e-checkers && npm run test:analyst -- --reporter=json --output=../tmp/playwright-analyst-report.json )
```

Follow each block with a one-sentence "what counts as a failure" recap quoted from design [The four gates](./design.md#the-four-gates).

C.5 Section 4 (`## 4. Driver invocation`):

```bash
bash /home/salva/g/ml/saivage-v3/SPEC/analyst-as-control-surface/PLAN/scripts/run-gates.sh \
  --diff /home/salva/g/ml/saivage-v3/SPEC/analyst-as-control-surface/PLAN/baseline-gates.json
```

C.6 Section 5 (`## 5. Comparison rule`): copy verbatim from `baseline-gates.json` `comparison_rule`.

C.7 Section 6 (`## 6. Close criterion`): single sentence, verbatim: `A stage may close only if every NEW failure relative to baseline-gates.json has an open ledger entry naming a later stage; otherwise the stage's acceptance fails.`

C.8 Section 7 (`## 7. Ledger update procedure`): numbered (a)–(e) per design [Cookbook contract](./design.md#cookbook-contract) item 7.

C.9 Section 8 (`## 8. Ledger entry shape`): copy the five required fields and the H3-heading shape from design [Ledger seed](./design.md#ledger-seed).

C.10 Section 9 (`## 9. Activation preflight`): copy the nine numbered steps from design [Bootstrap preflight](./design.md#bootstrap-preflight) verbatim, including the stop-and-ask rule. Each step is followed by its single shell check (or the env-var contract for steps 3 and 9) and the pass/fail interpretation.

C.11 Section 10 (`## 10. Pre-publication forbidden-anchor grep`): exact command from design [Cookbook contract](./design.md#cookbook-contract) item 10.

### Phase D — Ledger seed

D.1 Create [saivage-v3/SPEC/analyst-as-control-surface/PLAN/expected-breakage-ledger.md](saivage-v3/SPEC/analyst-as-control-surface/PLAN/expected-breakage-ledger.md) with three sections in order:

- Header paragraph (single paragraph, stating purpose and close-time bookkeeping rules, per design [Ledger seed](./design.md#ledger-seed)).
- `## Entry shape` with the five-field bullet list and the H3-heading shape rule.
- `## Open entries` with no entries underneath.

D.2 Verify `grep -c '^### ' saivage-v3/SPEC/analyst-as-control-surface/PLAN/expected-breakage-ledger.md` prints `0` AND `grep -c '^## Open entries' saivage-v3/SPEC/analyst-as-control-surface/PLAN/expected-breakage-ledger.md` prints `1`.

### Phase E — Preflight script

E.1 Create [saivage-v3/SPEC/analyst-as-control-surface/PLAN/scripts/preflight.sh](saivage-v3/SPEC/analyst-as-control-surface/PLAN/scripts/preflight.sh), executable. It runs the nine checks from design [Bootstrap preflight](./design.md#bootstrap-preflight) sequentially. Each check prints either `[PASS] <step> — <one-line reason>` or `[FAIL] <step> — <one-line reason>` and continues to the next check (so the operator sees every result). After all checks: print `PREFLIGHT OK` and exit 0 if every step passed; otherwise print `PREFLIGHT FAILED: <comma-separated failed step numbers>` and exit non-zero.

E.2 Check 3 (`saivage.service` active) is FAIL-CLOSED: the script does NOT call `systemctl` or `lxc-attach`. It reads the env var `OPERATOR_CONFIRM_SERVICE_ACTIVE`; only the literal value `yes` counts as PASS. Any other value (unset, empty, anything else) is FAIL. The script's PASS line for this step reads `[PASS] 3 — OPERATOR_CONFIRM_SERVICE_ACTIVE=yes`; the FAIL line reads `[FAIL] 3 — operator has not confirmed saivage.service active (set OPERATOR_CONFIRM_SERVICE_ACTIVE=yes)`.

E.3 Check 9 (consumer watching the stages path) is FAIL-CLOSED with the same pattern using env var `OPERATOR_CONFIRM_WATCHED_PATH`. PASS line: `[PASS] 9 — OPERATOR_CONFIRM_WATCHED_PATH=yes`. FAIL line: `[FAIL] 9 — operator has not confirmed the consumer is watching the stages path (set OPERATOR_CONFIRM_WATCHED_PATH=yes)`.

E.4 Check 8 (expected runtime files under `saivage-v3/.saivage/`) verifies existence only, never reads contents. The script iterates the file list pinned in design [Bootstrap preflight](./design.md#bootstrap-preflight) step 8 with `test -f` per file and records the first missing path in the FAIL line.

E.5 `chmod +x saivage-v3/SPEC/analyst-as-control-surface/PLAN/scripts/preflight.sh`.

E.6 Smoke-test the preflight against the current harness state with both env vars set:

```bash
OPERATOR_CONFIRM_SERVICE_ACTIVE=yes OPERATOR_CONFIRM_WATCHED_PATH=yes \
  bash saivage-v3/SPEC/analyst-as-control-surface/PLAN/scripts/preflight.sh
```

The script terminates with either `PREFLIGHT OK` or `PREFLIGHT FAILED: <step list>`.

E.7 Smoke-test the fail-closed behaviour under BOTH the missing-confirmation path and the wrong-value path. Each invocation MUST produce a `PREFLIGHT FAILED: ...` verdict whose failed-step list includes both `3` and `9`:

```bash
unset OPERATOR_CONFIRM_SERVICE_ACTIVE OPERATOR_CONFIRM_WATCHED_PATH
bash saivage-v3/SPEC/analyst-as-control-surface/PLAN/scripts/preflight.sh
```

```bash
OPERATOR_CONFIRM_SERVICE_ACTIVE=no OPERATOR_CONFIRM_WATCHED_PATH=no \
  bash saivage-v3/SPEC/analyst-as-control-surface/PLAN/scripts/preflight.sh
```

In both invocations the verdict line MUST be `PREFLIGHT FAILED: ...` and MUST include step `3` and step `9` in the failed list. Any value other than the literal `yes` for either env var counts as FAIL for its respective step.

### Phase F — Gitignore

F.1 Confirm [.gitignore](.gitignore) at the workspace root already excludes `tmp/`. If not, add it (single line `tmp/`). Do not modify any other ignore rule.

F.2 The phase-A `.gitignore` under `PLAN/scripts/` already ignores `out/`. No further change.

### Phase G — Self-containment verification and validator scripts

G.1 Create the workspace anchor file at [saivage-v3/SPEC/analyst-as-control-surface/PLAN/forbidden-anchors.txt](saivage-v3/SPEC/analyst-as-control-surface/PLAN/forbidden-anchors.txt) containing one forbidden anchor per line. The exact anchor set is the one enumerated in the master plan's autonomy gate (see [00-MASTER-PLAN-r7.md](saivage-v3/SPEC/analyst-as-control-surface/PLAN/00-MASTER-PLAN-r7.md) section 9.2). The file lives directly under `PLAN/`, NOT inside any `stages/NNN-*/` or `drafts/NNN-*/` directory, so it is never part of a publishable stage tree and is never scanned by the grep itself. The implementer copies the anchor list from the canonical input verbatim into this file, one per line, lowercase.

G.2 Create the cookbook-section validator [saivage-v3/SPEC/analyst-as-control-surface/PLAN/scripts/check-cookbook-sections.sh](saivage-v3/SPEC/analyst-as-control-surface/PLAN/scripts/check-cookbook-sections.sh), executable. The script greps for each of the ten pinned H2 headings in [saivage-v3/SPEC/analyst-as-control-surface/PLAN/VALIDATION-COOKBOOK.md](saivage-v3/SPEC/analyst-as-control-surface/PLAN/VALIDATION-COOKBOOK.md), asserts each appears exactly once and in the listed order (by checking that `grep -n '^## ' VALIDATION-COOKBOOK.md` yields the ten headings as the prefix sequence). Exit 0 = pass.

G.3 Create the baseline validator [saivage-v3/SPEC/analyst-as-control-surface/PLAN/scripts/validate-baseline.sh](saivage-v3/SPEC/analyst-as-control-surface/PLAN/scripts/validate-baseline.sh), executable. The script:

- Calls the driver in current-snapshot mode and writes the result to `PLAN/scripts/out/current-gates.json`.
- Asserts each of the four raw logs exists at `PLAN/scripts/out/raw/<id>.log` and is non-empty (or, for `tsc-build` on a clean tree, is at least an empty file the runner created).
- Asserts the emitted snapshot has the same four gate ids in the same order as the baseline.
- Asserts each gate's `failing_ids` is a JSON array of strings.
- Exit 0 on all-pass, non-zero with a single explanatory line on first failure.

G.4 Create the link validator [saivage-v3/SPEC/analyst-as-control-surface/PLAN/scripts/check-stage-links.sh](saivage-v3/SPEC/analyst-as-control-surface/PLAN/scripts/check-stage-links.sh), executable. The script takes a stage directory path as its sole argument; it greps every `](target)` markdown link in `design.md` and `plan.md` inside that directory, strips any `#anchor` suffix and any leading `./`, resolves remaining targets against the stage directory (for relative paths) or against `/home/salva/g/ml` (for paths that begin with a top-level workspace folder name), and asserts each resolved path exists. Exit 0 = every link resolves; non-zero on first unresolved link with the path printed.

G.5 Run the pre-publication forbidden-anchor grep against the draft stage directory using the workspace anchor file as the pattern source:

```bash
grep -REn -i -f saivage-v3/SPEC/analyst-as-control-surface/PLAN/forbidden-anchors.txt \
  saivage-v3/SPEC/analyst-as-control-surface/PLAN/drafts/000-breakage-detection-harness/
```

G.6 If the grep prints any line, edit the offending file to remove the anchor (without changing the technical content). Re-run G.5 until it prints nothing. The atomic publish of the draft directory into `stages/` MUST NOT happen while the grep prints any line.

## Validation gate

The implementer runs the following at the end of the stage, before declaring it complete. Each step is one shell command; pass = exit 0.

V.1 Acceptance criterion 1 — baseline shape:

```bash
jq -e '.schema_version == 1 and (.gates|length == 4) and ([.gates[].id] == ["tsc-build","web-vite-build","web-vitest","analyst-e2e"]) and all(.gates[]; ["id","cwd","command","runner","failure_id_kind","expected_exit_code_when_clean","observed_exit_code","normalization_rule","failing_ids"] - keys == [])' saivage-v3/SPEC/analyst-as-control-surface/PLAN/baseline-gates.json
```

V.2 Acceptance criterion 2 — gates run end-to-end:

```bash
bash saivage-v3/SPEC/analyst-as-control-surface/PLAN/scripts/validate-baseline.sh
```

V.3 Acceptance criterion 3 — driver supports `--diff`:

```bash
test -x saivage-v3/SPEC/analyst-as-control-surface/PLAN/scripts/run-gates.sh && bash saivage-v3/SPEC/analyst-as-control-surface/PLAN/scripts/run-gates.sh --diff saivage-v3/SPEC/analyst-as-control-surface/PLAN/baseline-gates.json >/dev/null
```

V.4 Acceptance criterion 4 — cookbook sections:

```bash
bash saivage-v3/SPEC/analyst-as-control-surface/PLAN/scripts/check-cookbook-sections.sh
```

V.5 Acceptance criterion 5 — ledger is shape-correct and empty:

```bash
grep -c '^## Entry shape' saivage-v3/SPEC/analyst-as-control-surface/PLAN/expected-breakage-ledger.md | grep -qx 1 && grep -c '^## Open entries' saivage-v3/SPEC/analyst-as-control-surface/PLAN/expected-breakage-ledger.md | grep -qx 1 && [ "$(grep -c '^### ' saivage-v3/SPEC/analyst-as-control-surface/PLAN/expected-breakage-ledger.md)" = "0" ]
```

V.6 Acceptance criterion 6 — preflight terminates with a parseable verdict:

```bash
OPERATOR_CONFIRM_SERVICE_ACTIVE=yes OPERATOR_CONFIRM_WATCHED_PATH=yes bash saivage-v3/SPEC/analyst-as-control-surface/PLAN/scripts/preflight.sh 2>&1 | grep -Eq '^PREFLIGHT (OK|FAILED:)'
```

V.7 Acceptance criterion 7 — preflight is fail-closed for BOTH step 3 and step 9, under BOTH missing-confirmation and wrong-value env-var inputs:

```bash
unset OPERATOR_CONFIRM_SERVICE_ACTIVE OPERATOR_CONFIRM_WATCHED_PATH; v1=$(bash saivage-v3/SPEC/analyst-as-control-surface/PLAN/scripts/preflight.sh 2>&1 | grep -E '^PREFLIGHT FAILED:'); v2=$(OPERATOR_CONFIRM_SERVICE_ACTIVE=no OPERATOR_CONFIRM_WATCHED_PATH=no bash saivage-v3/SPEC/analyst-as-control-surface/PLAN/scripts/preflight.sh 2>&1 | grep -E '^PREFLIGHT FAILED:'); echo "$v1" | grep -Eq '(^|[^0-9])3([^0-9]|$)' && echo "$v1" | grep -Eq '(^|[^0-9])9([^0-9]|$)' && echo "$v2" | grep -Eq '(^|[^0-9])3([^0-9]|$)' && echo "$v2" | grep -Eq '(^|[^0-9])9([^0-9]|$)'
```

V.8 Acceptance criterion 8 — product code untouched:

```bash
[ -z "$(git diff --name-only HEAD -- saivage-v3/src saivage-v3/web/src saivage-v3/bin saivage-v3/scripts saivage-v3/tests)" ]
```

V.9 Acceptance criterion 9 — no forbidden anchor in this stage's draft:

```bash
! grep -REn -i -f saivage-v3/SPEC/analyst-as-control-surface/PLAN/forbidden-anchors.txt saivage-v3/SPEC/analyst-as-control-surface/PLAN/drafts/000-breakage-detection-harness/
```

V.10 Acceptance criterion 10 — every link in this stage's docs resolves:

```bash
bash saivage-v3/SPEC/analyst-as-control-surface/PLAN/scripts/check-stage-links.sh saivage-v3/SPEC/analyst-as-control-surface/PLAN/drafts/000-breakage-detection-harness
```

V.11 Diff the fresh snapshot against the baseline; expect zero NEW failures (S00 captures the baseline; an immediate re-run MUST produce no NEW ids unless the environment changed):

```bash
bash saivage-v3/SPEC/analyst-as-control-surface/PLAN/scripts/run-gates.sh --diff saivage-v3/SPEC/analyst-as-control-surface/PLAN/baseline-gates.json
```

Exit 0 means every gate's NEW set is empty. Exit 1 with a non-empty NEW set means the baseline capture was inconsistent or the environment drifted between captures; the implementer re-captures the baseline and investigates rather than committing the drift.

## Breakage triage

Per master plan section 6.2, the close-time triage step. For S00:

1. Run the driver in `--diff` mode against the freshly-captured baseline (which is itself; the diff MUST be empty by construction).
2. Confirm no NEW failures for any gate. If any appear, the baseline capture and the validation-run capture disagree, which is an internal harness inconsistency — fix the driver script before closing.
3. The ledger MUST remain empty at S00's close. No entries are appended.
4. No REPAIRED ids to remove (the ledger started empty and remains empty).
5. Record in this Breakage triage sub-step the literal outcome: "S00 closed with zero NEW failures and zero ledger entries; the baseline gates snapshot is the authoritative starting point for every later stage."
6. The baseline snapshot is NOT refreshed by any later step in S00; it is the artifact this stage produces.

## Breakage forecast

S00 introduces no product mutation. The forecast per master plan section 6.1 is:

- No forecast entries. S00 does not modify any product code path that the four gates observe. The expected close state is zero NEW failures and an empty ledger.

## Expected breakage ledger entries to add at close

None. S00 closes with an empty ledger by construction.

## Done definition

S00 is done when every acceptance criterion in [design.md](./design.md#acceptance-criteria) (items 1–10) holds, every validation step V.1–V.11 above passes, the anchor file [saivage-v3/SPEC/analyst-as-control-surface/PLAN/forbidden-anchors.txt](saivage-v3/SPEC/analyst-as-control-surface/PLAN/forbidden-anchors.txt) is present, and the autonomy gate (Phase G.5) prints no forbidden anchors against the draft directory. At that point the stage is ready for the operator to atomically rename the draft directory [saivage-v3/SPEC/analyst-as-control-surface/PLAN/drafts/000-breakage-detection-harness/](saivage-v3/SPEC/analyst-as-control-surface/PLAN/drafts/000-breakage-detection-harness/) into [saivage-v3/SPEC/analyst-as-control-surface/PLAN/stages/000-breakage-detection-harness/](saivage-v3/SPEC/analyst-as-control-surface/PLAN/stages/000-breakage-detection-harness/) per the publication protocol. The rename itself is the operator's responsibility and not part of this stage's implementation steps.
