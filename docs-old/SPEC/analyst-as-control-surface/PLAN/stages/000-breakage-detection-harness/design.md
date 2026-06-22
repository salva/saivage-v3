# Stage 000 — Breakage Detection Harness — Design

## Goal

Establish, before any product mutation touches [saivage-v3/](saivage-v3/), a reproducible breakage-detection harness that every later stage uses to decide whether it may close. The harness consists of four named validation gates that match the master-plan S00 acceptance list, a machine-readable baseline snapshot of their current failing-id sets, a short cookbook of exact commands an implementer runs at each stage's close, an empty cumulative expected-breakage ledger, and an operator-runnable bootstrap preflight that verifies the v2-on-v3 autonomous harness is ready to consume published stages. This stage adds only artifacts under [saivage-v3/SPEC/analyst-as-control-surface/PLAN/](saivage-v3/SPEC/analyst-as-control-surface/PLAN/); no product code is modified.

## Scope

### In scope

- The four baseline gates pinned by [00-MASTER-PLAN-r7.md](saivage-v3/SPEC/analyst-as-control-surface/PLAN/00-MASTER-PLAN-r7.md) S00 acceptance — `tsc-build` (TypeScript build of [saivage-v3/](saivage-v3/)), `web-vite-build` (Vite build of [saivage-v3/web/](saivage-v3/web/)), `web-vitest` (vitest in [saivage-v3/](saivage-v3/)), and `analyst-e2e` (Playwright analyst suite in [saivage-e2e-checkers/](saivage-e2e-checkers/)) — together with their exact shell commands, working directories, exit-code interpretation, and failing-id normalization rules.
- The baseline snapshot artifact [saivage-v3/SPEC/analyst-as-control-surface/PLAN/baseline-gates.json](saivage-v3/SPEC/analyst-as-control-surface/PLAN/baseline-gates.json) with the JSON shape pinned in this design.
- The cookbook [saivage-v3/SPEC/analyst-as-control-surface/PLAN/VALIDATION-COOKBOOK.md](saivage-v3/SPEC/analyst-as-control-surface/PLAN/VALIDATION-COOKBOOK.md) containing the exact commands per gate, the comparison rule, the ledger update procedure, the activation preflight (including the live `/health` probe, which is a preflight check and not a gate), and the pre-publication forbidden-anchor grep.
- The empty cumulative ledger [saivage-v3/SPEC/analyst-as-control-surface/PLAN/expected-breakage-ledger.md](saivage-v3/SPEC/analyst-as-control-surface/PLAN/expected-breakage-ledger.md) with its header and zero open entries.
- A small driver script under [saivage-v3/SPEC/analyst-as-control-surface/PLAN/scripts/](saivage-v3/SPEC/analyst-as-control-surface/PLAN/scripts/) that runs the four gates, captures their raw output, parses the failing-id sets, and emits a fresh snapshot to stdout in the same JSON shape as the baseline.
- A preflight script under [saivage-v3/SPEC/analyst-as-control-surface/PLAN/scripts/](saivage-v3/SPEC/analyst-as-control-surface/PLAN/scripts/) that fails closed on any unverified readiness condition.
- A cookbook-section validator script and a baseline-JSON validator script that allow every acceptance criterion below to be a single-command mechanical check.

### Out of scope

- Any change to product code under [saivage-v3/src/](saivage-v3/src/), [saivage-v3/web/src/](saivage-v3/web/src/), [saivage-v3/bin/](saivage-v3/bin/), or [saivage-v3/scripts/](saivage-v3/scripts/) outside the harness directory.
- Any change to existing tests, test fixtures, jest config, vitest config, or playwright configs. If a gate cannot currently run end-to-end on a fresh checkout, this design enumerates the environment fix (install command, missing browser binary, etc.) and that fix is applied at the environment level only; it is not encoded as a product-code patch.
- Repair of the v2-on-v3 harness in container `saivage-v3` (10.0.3.112). Another agent owns that container. If the activation preflight fails, the implementer stops and asks the operator. See the preflight section.
- Editing [saivage-v3/SPEC/analyst-as-control-surface/SPEC-r7.md](saivage-v3/SPEC/analyst-as-control-surface/SPEC-r7.md), [saivage-v3/SPEC/analyst-as-control-surface/PLAN/00-MASTER-PLAN-r7.md](saivage-v3/SPEC/analyst-as-control-surface/PLAN/00-MASTER-PLAN-r7.md), or [saivage-v3/SPEC/analyst-as-control-surface/PLAN/PROTOCOL-r4.md](saivage-v3/SPEC/analyst-as-control-surface/PLAN/PROTOCOL-r4.md).
- Adding any gate beyond the four named above (e.g. jest backend suite, eslint, audit, docs build). Later stages may add additional gates by editing this snapshot; they are not part of the baseline-or-ledger close criterion this stage establishes.
- Wiring the harness into any CI system. The harness is operator-runnable from the workspace host.

## Architecture

### Snapshot location and lifecycle

The baseline snapshot lives at [saivage-v3/SPEC/analyst-as-control-surface/PLAN/baseline-gates.json](saivage-v3/SPEC/analyst-as-control-surface/PLAN/baseline-gates.json). It is committed to the repository. S00 writes the initial copy.

Subsequent stages MUST NOT refresh `baseline-gates.json` opportunistically. The file is the immutable starting point used by every stage's close check; refreshing it would silently erase a known failure that a later stage promised to fix. Two narrow rewrites are permitted, both under the master-plan acceptance discipline:

- The S10 reconciliation stage refreshes the snapshot as part of its acceptance work — drain the ledger, capture a fresh baseline, commit the new file.
- Any stage that legitimately deletes tests for a removed product feature MUST rewrite the snapshot in the same commit that removes the tests, so the deleted failing-id strings disappear from `failing_ids` in lockstep. The stage's `design.md` Downstream impact section names the file edit explicitly and treats it as a real architectural change, not a baseline refresh of convenience.

Any other modification to `baseline-gates.json` by a stage other than S10 is a reviewer-rejectable error.

A fresh per-stage snapshot is computed on demand by the driver script described below, written to a transient path (e.g. [saivage-v3/SPEC/analyst-as-control-surface/PLAN/scripts/out/current-gates.json](saivage-v3/SPEC/analyst-as-control-surface/PLAN/scripts/out/current-gates.json), git-ignored), and diffed against the committed baseline. The transient snapshot is never committed.

### Snapshot JSON shape

The baseline and any per-stage snapshot share the exact same shape. A reviewer rejects any snapshot that does not parse against it.

```json
{
  "schema_version": 1,
  "captured_at": "2026-05-24T12:00:00Z",
  "captured_by": "saivage-v3 S00 baseline",
  "workspace_root": "/home/salva/g/ml",
  "comparison_rule": "A NEW failure for a gate is any failing-id (test_id, scenario_id, or error_id) observed by a per-stage gate run that is not present in this snapshot's failing_ids array for the same gate id. The driver script implements this diff and is the single source of truth.",
  "gates": [
    {
      "id": "tsc-build",
      "cwd": "saivage-v3",
      "command": "npx tsc -p .",
      "runner": "tsc (TypeScript compiler, emits to dist/)",
      "failure_id_kind": "tsc_diagnostic",
      "expected_exit_code_when_clean": 0,
      "observed_exit_code": 0,
      "normalization_rule": "Each diagnostic line matching '<path>(<line>,<col>): error TS<code>:' is normalized to 'tsc-build:<path>:<line>:TS<code>'. <path> is workspace-relative (prefix with 'saivage-v3/' when tsc emits a cwd-relative path). Warnings are ignored.",
      "failing_ids": []
    },
    {
      "id": "web-vite-build",
      "cwd": "saivage-v3/web",
      "command": "npm run build",
      "runner": "vue-tsc --noEmit && vite build",
      "failure_id_kind": "web_build_diagnostic",
      "expected_exit_code_when_clean": 0,
      "observed_exit_code": 0,
      "normalization_rule": "Each diagnostic line matching '<path>(<line>,<col>): error TS<code>:' is normalized to 'web-vite-build:<path>:<line>:TS<code>' with <path> prefixed by 'saivage-v3/web/' when emitted cwd-relative. Any Rollup/vite error line matching '\\[vite\\]:' or 'error during build' that is not a vue-tsc diagnostic emits a single id 'web-vite-build:saivage-v3-web:vite-failed' (one id per run, not per line). If exit code is non-zero and no vue-tsc or vite-tagged line is observed, emit 'web-vite-build:saivage-v3-web:unknown-failure'.",
      "failing_ids": []
    },
    {
      "id": "web-vitest",
      "cwd": "saivage-v3/web",
      "command": "npx vitest run --reporter=json --outputFile=../../tmp/web-vitest-report.json",
      "runner": "vitest (run mode, JSON reporter)",
      "failure_id_kind": "vitest_test",
      "expected_exit_code_when_clean": 0,
      "observed_exit_code": 0,
      "normalization_rule": "Parse the vitest JSON report at tmp/web-vitest-report.json (cwd-relative '../../tmp/web-vitest-report.json' resolves to workspace-root tmp/). Walk testResults[*]; for each assertion with status != 'passed' emit one failing-id 'web-vitest:<workspace-relative testFilePath>::<fullName>'. Suite-level failures with no assertionResults emit 'web-vitest:<workspace-relative testFilePath>::<SUITE>'.",
      "failing_ids": []
    },
    {
      "id": "analyst-e2e",
      "cwd": "saivage-e2e-checkers",
      "command": "npm run test:analyst -- --reporter=json --output=../tmp/playwright-analyst-report.json",
      "runner": "playwright (playwright.analyst.config.js)",
      "failure_id_kind": "playwright_test",
      "expected_exit_code_when_clean": 0,
      "observed_exit_code": 0,
      "normalization_rule": "Parse the playwright JSON reporter file at tmp/playwright-analyst-report.json. Walk suites recursively; for each spec whose outcome is 'unexpected' or 'flaky' (any failed test attempt), emit one failing-id as 'analyst-e2e:<workspace-relative spec file>::<test title path joined by ' > '>'. Skipped tests (.fixme) are not failures.",
      "failing_ids": []
    }
  ]
}
```

Notes on the shape:

- `id` is the stable string used everywhere else (cookbook, ledger entries, driver script). The four ids are exactly `tsc-build`, `web-vite-build`, `web-vitest`, `analyst-e2e`, in that order.
- `cwd` is workspace-relative to `/home/salva/g/ml` (the workspace root recorded in `workspace_root`). A reviewer can verify the path by `ls /home/salva/g/ml/<cwd>`.
- `command` is a single shell string. Each gate's driver-script invocation does `( cd "$WORKSPACE_ROOT/$cwd" && bash -c "$command" )`. No interactive prompts; everything is non-interactive.
- `failure_id_kind` is a free-form tag describing the source of the ids; it is informational and not used by the diff.
- `expected_exit_code_when_clean` is documentation; the actual failure decision is the failing-id diff, not exit code. A run can exit non-zero while producing zero new failing-ids if every failing-id is already in baseline.
- `failing_ids` is the array of normalized strings observed at capture time. It is sorted lexicographically and contains no duplicates. The empty array means the gate is fully green at capture time.

### Per-gate descriptor and normalization

Each gate's normalization rule is fully specified by its `normalization_rule` field in the JSON above. The driver script implements those rules. The rules are intentionally simple string-shape transforms over the runner's machine-readable output (vitest JSON, playwright JSON reporter, tsc/vue-tsc diagnostic line-grep, vite stderr line-grep) so a reviewer can re-derive any normalized id from the raw output by inspection.

For each runner the driver script writes both:

- The raw runner output to [saivage-v3/SPEC/analyst-as-control-surface/PLAN/scripts/out/raw/<gate-id>.log](saivage-v3/SPEC/analyst-as-control-surface/PLAN/scripts/out/raw/<gate-id>.log), and
- The normalized failing-id list to the `failing_ids` array of the emitted JSON.

Both outputs are git-ignored. Implementers attach them when the diff against baseline is non-trivial.

### Comparison rule

The comparison rule is the literal `comparison_rule` string above and is mechanical:

> For each gate id `g`, let `B(g)` be the baseline's `failing_ids` set for `g` and `C(g)` be the current run's `failing_ids` set for the same gate id. The set of NEW failures for `g` is `C(g) \ B(g)`. The set of REPAIRED failures for `g` is `B(g) \ C(g)`. The union over all four gates of NEW failures is the value the close criterion (master plan section 3) and the ledger update procedure operate on.

The driver script's `--diff <baseline.json>` mode prints two sections per gate: `NEW` (one id per line) and `REPAIRED` (one id per line). Exit code is 0 when every gate's `NEW` set is empty, 1 otherwise. This exit code is informational only; the close criterion in section 3 of the master plan also allows non-empty `NEW` when each id has an open ledger entry naming a later stage.

## The four gates

### Gate `tsc-build`

- Working directory: [saivage-v3/](saivage-v3/).
- Command: `npx tsc -p .` (the TypeScript build that produces `dist/`, equivalent to the first half of `npm run build`).
- Runner: TypeScript compiler.
- What counts as a failure: any `error TS<code>` line on stderr/stdout. Warnings are ignored.
- Failing-id normalization: each line matching the regex `^(?<path>[^()]+)\((?<line>\d+),\d+\): error TS(?<code>\d+):` becomes `tsc-build:<path>:<line>:TS<code>`, with `<path>` made workspace-relative (prefix `saivage-v3/` if tsc emits a cwd-relative path).

### Gate `web-vite-build`

- Working directory: [saivage-v3/web/](saivage-v3/web/).
- Command: `npm run build` (vue-tsc type-check followed by `vite build`).
- Runner: vue-tsc + vite.
- What counts as a failure: any vue-tsc `error TS<code>` line, OR any vite/rollup build error.
- Failing-id normalization: vue-tsc diagnostics emit `web-vite-build:<workspace-relative path>:<line>:TS<code>`. A failed vite build (non-zero exit with no vue-tsc lines, or with a `[vite]:`/`error during build` marker) emits the single id `web-vite-build:saivage-v3-web:vite-failed`. A non-zero exit with no recognised diagnostic emits `web-vite-build:saivage-v3-web:unknown-failure`.

### Gate `web-vitest`

- Working directory: [saivage-v3/web/](saivage-v3/web/).
- Command: `npx vitest run --reporter=json --outputFile=../../tmp/web-vitest-report.json`.
- Runner: vitest. The `--outputFile` path is cwd-relative; `../../tmp/` resolves to `/home/salva/g/ml/tmp/`.
- What counts as a failure: any `assertionResult` with `status != 'passed'` in the JSON report, OR any `testResult` with `status == 'failed'` and zero assertion results (suite setup/teardown).
- Failing-id normalization: `web-vitest:<workspace-relative testFilePath>::<fullName>` per failed assertion; `web-vitest:<workspace-relative testFilePath>::<SUITE>` for suite-level failures.

Backend jest suites under [saivage-v3/src/](saivage-v3/src/) are NOT part of this gate; the master plan S00 acceptance lists exactly the four gates above. Later stages may add a jest gate if needed.

### Gate `analyst-e2e`

- Working directory: [saivage-e2e-checkers/](saivage-e2e-checkers/).
- Command: `npm run test:analyst -- --reporter=json --output=../tmp/playwright-analyst-report.json`.
- Runner: Playwright invoked via `playwright test --config playwright.analyst.config.js` per [saivage-e2e-checkers/package.json](saivage-e2e-checkers/package.json) `scripts.test:analyst`. The `--reporter=json --output=...` flags route the JSON reporter to `../tmp/` which resolves to workspace-root `tmp/`.
- What counts as a failure: any spec whose final outcome is `unexpected` or `flaky`.
- Failing-id normalization: `analyst-e2e:<workspace-relative spec path>::<joined title chain>` per spec.

Environment prerequisite: `npx --prefix saivage-e2e-checkers playwright install --with-deps chromium` must have been run on the workspace host at least once before this gate can execute. The cookbook records the install command.

### Where the live `/health` probe lives

The live health probe against `http://10.0.3.112:8080/health` is NOT one of the four gates. The master plan S00 acceptance lists only the four gates above; live health is the responsibility of the activation preflight (see Bootstrap preflight below). Treating live health as a gate would block stage closure on transient harness-side network issues that are not breakages in the code under change.

## Cookbook contract

[saivage-v3/SPEC/analyst-as-control-surface/PLAN/VALIDATION-COOKBOOK.md](saivage-v3/SPEC/analyst-as-control-surface/PLAN/VALIDATION-COOKBOOK.md) MUST contain, in this exact order, sections with these literal H2 headings:

1. `## 1. Purpose` — one-line statement identifying the document as the operator-runnable command catalogue for the baseline gates.
2. `## 2. Pre-conditions` — what the operator verifies before any gate runs: workspace at HEAD on the intended branch; node and npm versions match [saivage-v3/package.json](saivage-v3/package.json) engines; [saivage-v3/node_modules/](saivage-v3/node_modules/) and [saivage-v3/web/node_modules/](saivage-v3/web/node_modules/) and [saivage-e2e-checkers/node_modules/](saivage-e2e-checkers/node_modules/) populated; `npx --prefix saivage-e2e-checkers playwright install --with-deps chromium` has been run on this host; the workspace [tmp/](tmp/) directory exists and is writable; `jq` is on `PATH`.
3. `## 3. Gate command blocks` — four fenced `bash` blocks (one per gate) containing exactly the `command` string from the snapshot plus the `cd "$WORKSPACE_ROOT/$cwd"` prefix, copy-pasteable. Each block is followed by a one-sentence "what counts as a failure" recap.
4. `## 4. Driver invocation` — a fenced `bash` block invoking the driver script to run all four gates, write the per-gate raw logs and the transient snapshot, and print a diff against the committed baseline.
5. `## 5. Comparison rule` — the `comparison_rule` string quoted verbatim from the snapshot.
6. `## 6. Close criterion` — single sentence, verbatim: `A stage may close only if every NEW failure relative to baseline-gates.json has an open ledger entry naming a later stage; otherwise the stage's acceptance fails.`
7. `## 7. Ledger update procedure` — numbered steps, mechanically runnable: (a) run the driver in `--diff` mode; (b) for each NEW id, attempt the holistic fix described in the closing stage's `design.md` Downstream impact section; if it succeeds, re-run gates and skip to (e); (c) if the fix legitimately belongs in a later stage, append one entry to [saivage-v3/SPEC/analyst-as-control-surface/PLAN/expected-breakage-ledger.md](saivage-v3/SPEC/analyst-as-control-surface/PLAN/expected-breakage-ledger.md) per the entry shape below; (d) for each REPAIRED id, remove its open ledger entry if the entry's `Target fix stage` is the closing stage; (e) commit the ledger delta as part of the stage's close commit.
8. `## 8. Ledger entry shape` — the five required fields and the H3-heading shape rule (see Ledger seed below), so the cookbook is self-sufficient.
9. `## 9. Activation preflight` — the operator-runnable preflight (see Bootstrap preflight below) as a numbered checklist. Each item is a single shell command followed by the pass/fail interpretation, plus the explicit stop-and-ask rule on any failure.
10. `## 10. Pre-publication forbidden-anchor grep` — exact command using [saivage-v3/SPEC/analyst-as-control-surface/PLAN/forbidden-anchors.txt](saivage-v3/SPEC/analyst-as-control-surface/PLAN/forbidden-anchors.txt) as the pattern source. The cookbook notes the rule: if this grep prints any line, the stage directory MUST NOT be renamed into `stages/`. The anchor file itself lives OUTSIDE any stage directory (under `PLAN/`, not `PLAN/stages/`) so it is never subject to the grep against a publishable tree.

The cookbook contains no narrative beyond the items above. It is a command catalogue, not a discussion document. The literal H2 strings above (`## 1. Purpose` through `## 10. Pre-publication forbidden-anchor grep`) are pinned so a single grep against the file mechanically verifies the section list.

## Ledger seed

[saivage-v3/SPEC/analyst-as-control-surface/PLAN/expected-breakage-ledger.md](saivage-v3/SPEC/analyst-as-control-surface/PLAN/expected-breakage-ledger.md) is created with the following content shape and no open entries:

- A short header paragraph stating the file's purpose (the cumulative expected-breakage record for the analyst-as-control-surface migration) and the close-time bookkeeping rules (each stage appends entries for its own NEW failures; each stage removes entries whose `Target fix stage` is itself and whose underlying failure is now resolved).
- A `## Entry shape` section that pins each entry's required fields:
  - A markdown heading at H3 level naming the failing artifact, in the exact form `### <failing-id>` where `<failing-id>` is one of the normalized strings from the snapshot (e.g. `### web-vitest:saivage-v3/web/src/__tests__/analyst-chat-panel.test.ts::renders empty drawer`).
  - A `Failure mode` line: one sentence describing the symptom.
  - A `Reason acceptable now` line: which SPEC-r7 requirement or earlier-stage decision forces it.
  - A `Target fix stage` line: the id of a strictly later stage from the dependency DAG in the master plan (one of `S01`..`S10`; `S00` is not valid).
  - A `Recorded by` line: the stage id and ISO-date that authored the entry (e.g. `S03 / 2026-05-30`).
- A `## Open entries` section that is empty at creation. Implementers append H3 entries under it; they remove entries by deleting the H3 block.

The ledger is human-readable Markdown by design; the only mechanical constraint is the H3 heading line shape so the driver script (or a reviewer's grep) can enumerate open ids by scanning `^### ` lines under `## Open entries`.

## Bootstrap preflight

Before the operator atomically renames the first published stage directory into [saivage-v3/SPEC/analyst-as-control-surface/PLAN/stages/](saivage-v3/SPEC/analyst-as-control-surface/PLAN/stages/), thereby triggering the v2-on-v3 autonomous consumer to pick it up, the operator runs the preflight script [saivage-v3/SPEC/analyst-as-control-surface/PLAN/scripts/preflight.sh](saivage-v3/SPEC/analyst-as-control-surface/PLAN/scripts/preflight.sh). The preflight is copy-pasteable from the cookbook. Every check is non-secret. Every check is automated; the script never auto-passes a check on behalf of the operator.

The preflight covers each readiness fact required by the master plan S00 acceptance: service health, protocol-consumer presence and watched-path visibility, no stale shutdown handoff state, and expected v2 harness runtime files present under [saivage-v3/.saivage/](saivage-v3/.saivage/).

Checks, in order:

1. **LXC container reachable.** `ping -c1 -W2 10.0.3.112` exits 0. Pass: continue. Fail: STOP and tell the operator the harness container is unreachable.
2. **Health endpoint returns 200.** `curl --silent --show-error --fail --max-time 10 http://10.0.3.112:8080/health` exits 0 and prints a parseable JSON body whose top-level `status` is `"ok"` (or, if `status` is absent, any 2xx with parseable JSON body). Verified mechanically by piping curl's stdout through `jq -e '.status == "ok" // (. != null)'`. Fail: STOP.
3. **Service active (fail-closed).** The script reads the environment variable `OPERATOR_CONFIRM_SERVICE_ACTIVE`. The operator MUST set it to the literal string `yes` if and only if they have confirmed via classic LXC tooling that `saivage.service` inside container `saivage-v3` is `active (running)`. The script treats any value other than `yes` as FAIL. The script never invokes `systemctl` or `lxc-attach` itself; the operator owns the manual check. The stop-and-ask rule applies on FAIL.
4. **Stages directory exists and contains only published stages or nothing.** `ls -1 saivage-v3/SPEC/analyst-as-control-surface/PLAN/stages 2>/dev/null | grep -Ev '^[0-9]{3}-[a-z0-9]+(-[a-z0-9]+)*$' | wc -l` prints `0`. Fail: STOP and tell the operator there is a stray entry under `stages/`.
5. **Baseline snapshot present and parses.** `jq -e '.schema_version == 1 and (.gates|length == 4)' saivage-v3/SPEC/analyst-as-control-surface/PLAN/baseline-gates.json` exits 0. Fail: STOP.
6. **Ledger present and parseable.** `grep -c '^## Open entries' saivage-v3/SPEC/analyst-as-control-surface/PLAN/expected-breakage-ledger.md` prints `1` AND `grep -c '^### ' saivage-v3/SPEC/analyst-as-control-surface/PLAN/expected-breakage-ledger.md` prints `0` (immediately after S00; the ledger starts empty). Fail: STOP.
7. **No stale shutdown handoff state.** `ls saivage-v3/.saivage/tmp/state/shutdown-summary.json saivage-v3/.saivage/tmp/state/shutdown-request.json 2>/dev/null | wc -l` prints `0`. Stale handoff files queue old SYSTEM RESTART HANDOFF work on the next consumer startup. Fail: STOP and tell the operator these files must be removed (by the harness owner) before activation.
8. **Expected v2 harness runtime files present under `saivage-v3/.saivage/`.** All of the following files exist on disk: [saivage-v3/.saivage/saivage.json](saivage-v3/.saivage/saivage.json), [saivage-v3/.saivage/config.json](saivage-v3/.saivage/config.json), [saivage-v3/.saivage/plan.json](saivage-v3/.saivage/plan.json), [saivage-v3/.saivage/plan-history.json](saivage-v3/.saivage/plan-history.json), [saivage-v3/.saivage/runtime/runtime-state.json](saivage-v3/.saivage/runtime/runtime-state.json). Verified mechanically by `for f in saivage.json config.json plan.json plan-history.json runtime/runtime-state.json; do test -f saivage-v3/.saivage/$f || exit 1; done`. The script never reads the file contents (these files carry secrets). Fail: STOP.
9. **Protocol-consumer watching the stages path (fail-closed).** The script reads the environment variable `OPERATOR_CONFIRM_WATCHED_PATH`. The operator MUST set it to the literal string `yes` if and only if they have confirmed (via an operator-visible status endpoint, configuration check, or harness-owner report) that the v2-on-v3 consumer is watching [saivage-v3/SPEC/analyst-as-control-surface/PLAN/stages/](saivage-v3/SPEC/analyst-as-control-surface/PLAN/stages/). The script treats any value other than `yes` as FAIL. The implementer never modifies the consumer's configuration; on FAIL, STOP.

**Stop-and-ask rule (non-negotiable).** On ANY failed check above, the implementer stops. The implementer MUST NOT: restart the `saivage-v3` container, restart `saivage.service`, edit files inside [saivage-v3/.saivage/](saivage-v3/.saivage/), redeploy the harness, or otherwise touch the runtime state the other agent owns. The implementer reports the failed check to the operator and waits for instructions. This rule applies even if the failure looks trivial (e.g. a stale lockfile); diagnosing or fixing the v2-on-v3 harness is out of scope for S00 and for every later stage produced by this writer.

## Downstream impact

Per master plan section 6.1, the subsystems S00 may affect, the holistic fix per concern, and the validation gate that catches it.

- [saivage-v3/.gitignore](saivage-v3/.gitignore) and the workspace-level [.gitignore](.gitignore): the driver script writes raw runner logs and a transient snapshot under [saivage-v3/SPEC/analyst-as-control-surface/PLAN/scripts/out/](saivage-v3/SPEC/analyst-as-control-surface/PLAN/scripts/out/) and the vitest/playwright JSON reports under [tmp/](tmp/). Holistic fix: add precise ignore globs for `PLAN/scripts/out/` and confirm `tmp/` is already ignored. Caught by: `tsc-build` is unaffected; a reviewer's `git status` after a dry run shows no stray tracked files.
- [tmp/](tmp/) directory layout: the vitest and playwright runners write `tmp/web-vitest-report.json` and `tmp/playwright-analyst-report.json`. Holistic fix: the driver script ensures `tmp/` exists (`mkdir -p tmp`) before invoking either runner; no permanent on-disk reservation is needed. Caught by: dry run of the driver script.
- [saivage-v3/package.json](saivage-v3/package.json), [saivage-v3/web/package.json](saivage-v3/web/package.json), and [saivage-e2e-checkers/package.json](saivage-e2e-checkers/package.json) `scripts` sections: the gate commands invoke existing scripts (`tsc`, `npm run build`, `npx vitest run`, `npm run test:analyst`) with forwarded flags. No script changes are required. Holistic fix (preventive): if a later refactor renames any of those scripts, the snapshot's `command` strings MUST be updated in the same commit (this is a real change to baseline-gates.json, not a ledger entry). Caught by: any of the four gates fails to run end-to-end on the next snapshot capture.
- The cumulative ledger file format: the file is human-readable Markdown with H3-heading entries. Any later script that programmatically enumerates open ids relies on the `^### ` line shape. Holistic fix: the driver script's optional `--list-open-ledger` subcommand (if added) reads `^### ` lines under `## Open entries`. Caught by: a manual review of any ledger update.
- The activation preflight depends on the v2-on-v3 container being reachable from the workspace host and on the runtime files under [saivage-v3/.saivage/](saivage-v3/.saivage/) being present. No code change in S00 affects either path. Caught by: the preflight itself.
- No other subsystem is touched. The four gate runners are invoked as-is; their configurations are not modified. The backend jest suite, eslint, audit, docs build, and any CI configuration are explicitly out of scope; later stages may add additional gates by writing new snapshot entries, but that is a real change to the baseline-gates.json file, not a per-stage adjustment.

## Acceptance criteria

Each criterion below is a single shell command run from the workspace root `/home/salva/g/ml`. Pass = exit code 0. Multi-step verifications are delegated to validator scripts produced by this stage.

1. Baseline snapshot exists and has the pinned shape:
   ```bash
   jq -e '.schema_version == 1 and (.gates|length == 4) and ([.gates[].id] == ["tsc-build","web-vite-build","web-vitest","analyst-e2e"]) and all(.gates[]; ["id","cwd","command","runner","failure_id_kind","expected_exit_code_when_clean","observed_exit_code","normalization_rule","failing_ids"] - keys == [])' saivage-v3/SPEC/analyst-as-control-surface/PLAN/baseline-gates.json
   ```
2. Every gate's `command` runs end-to-end (no abort by missing binary, no shell syntax error) and the driver script captures a parseable per-gate result for each:
   ```bash
   bash saivage-v3/SPEC/analyst-as-control-surface/PLAN/scripts/validate-baseline.sh
   ```
   The validator runs the four gates via the driver and asserts each gate's raw log exists at `PLAN/scripts/out/raw/<id>.log` and its `failing_ids` array is JSON-typed in the emitted snapshot. Exit 0 = pass.
3. Driver script exists, is executable, and exposes the documented invocations:
   ```bash
   test -x saivage-v3/SPEC/analyst-as-control-surface/PLAN/scripts/run-gates.sh && bash saivage-v3/SPEC/analyst-as-control-surface/PLAN/scripts/run-gates.sh --diff saivage-v3/SPEC/analyst-as-control-surface/PLAN/baseline-gates.json >/dev/null
   ```
4. Cookbook exists and contains the ten H2 sections in order:
   ```bash
   bash saivage-v3/SPEC/analyst-as-control-surface/PLAN/scripts/check-cookbook-sections.sh
   ```
   The script greps for each of the ten literal H2 headings pinned in this design's Cookbook contract section and asserts they appear in the listed order, exactly once each.
5. Ledger exists, is shape-correct, and is empty:
   ```bash
   grep -c '^## Entry shape' saivage-v3/SPEC/analyst-as-control-surface/PLAN/expected-breakage-ledger.md | grep -qx 1 && grep -c '^## Open entries' saivage-v3/SPEC/analyst-as-control-surface/PLAN/expected-breakage-ledger.md | grep -qx 1 && [ "$(grep -c '^### ' saivage-v3/SPEC/analyst-as-control-surface/PLAN/expected-breakage-ledger.md)" = "0" ]
   ```
6. Preflight script runs and terminates with a parseable verdict (either `PREFLIGHT OK` or `PREFLIGHT FAILED: ...`):
   ```bash
   bash saivage-v3/SPEC/analyst-as-control-surface/PLAN/scripts/preflight.sh 2>&1 | grep -Eq '^PREFLIGHT (OK|FAILED:)'
   ```
   This criterion only asserts the script terminates cleanly with a recognised verdict line; both verdicts are acceptable for S00's own validation. Other criteria assert the script's fail-closed behaviour for steps 3 and 9.
7. Preflight is fail-closed for BOTH operator-confirmed checks (step 3 and step 9), under BOTH the missing-confirmation path and the wrong-value path. A single command runs the preflight twice — once with the two confirmation env vars unset and once with them set to a non-`yes` literal — and asserts that each run's `PREFLIGHT FAILED:` verdict line names both step `3` and step `9`:
   ```bash
   unset OPERATOR_CONFIRM_SERVICE_ACTIVE OPERATOR_CONFIRM_WATCHED_PATH; v1=$(bash saivage-v3/SPEC/analyst-as-control-surface/PLAN/scripts/preflight.sh 2>&1 | grep -E '^PREFLIGHT FAILED:'); v2=$(OPERATOR_CONFIRM_SERVICE_ACTIVE=no OPERATOR_CONFIRM_WATCHED_PATH=no bash saivage-v3/SPEC/analyst-as-control-surface/PLAN/scripts/preflight.sh 2>&1 | grep -E '^PREFLIGHT FAILED:'); echo "$v1" | grep -Eq '(^|[^0-9])3([^0-9]|$)' && echo "$v1" | grep -Eq '(^|[^0-9])9([^0-9]|$)' && echo "$v2" | grep -Eq '(^|[^0-9])3([^0-9]|$)' && echo "$v2" | grep -Eq '(^|[^0-9])9([^0-9]|$)'
   ```
   Pass = exit 0, i.e. both runs produce a `PREFLIGHT FAILED:` verdict line and both verdict lines list step 3 AND step 9 as failed checks. This proves that neither operator-confirmed check can be silently bypassed by unset env vars or by setting them to any value other than the literal `yes`.
8. Product code is untouched by this stage:
   ```bash
   [ -z "$(git diff --name-only HEAD -- saivage-v3/src saivage-v3/web/src saivage-v3/bin saivage-v3/scripts saivage-v3/tests)" ]
   ```
9. No file under the published draft directory contains any forbidden anchor:
   ```bash
   ! grep -REn -i -f saivage-v3/SPEC/analyst-as-control-surface/PLAN/forbidden-anchors.txt saivage-v3/SPEC/analyst-as-control-surface/PLAN/drafts/000-breakage-detection-harness/
   ```
   `grep -R` exits 0 when any match is found and 1 when none. `! grep ...` inverts that, so exit 0 means no forbidden anchor was found.
10. Every relative-path link in this stage's `design.md` and `plan.md` points at a path that exists in the workspace:
    ```bash
    bash saivage-v3/SPEC/analyst-as-control-surface/PLAN/scripts/check-stage-links.sh saivage-v3/SPEC/analyst-as-control-surface/PLAN/drafts/000-breakage-detection-harness
    ```
    The script enumerates every `](target)` link in the two stage files, strips any `#anchor` suffix, and asserts each remaining target resolves to an existing file or directory under `/home/salva/g/ml`. Exit 0 = every link resolves.
