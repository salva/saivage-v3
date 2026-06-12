# Validation Cookbook

## 1. Purpose

This document is the operator-runnable command catalogue for the four baseline gates used by the analyst-as-control-surface migration.

## 2. Pre-conditions

- Node and npm versions match `saivage-v3/package.json` engines (`node >=22.12.0`, `npm >=10`).
- `saivage-v3/node_modules/`, `saivage-v3/web/node_modules/`, and `saivage-e2e-checkers/node_modules/` are populated.
- `npx --prefix saivage-e2e-checkers playwright install --with-deps chromium` has been run on this host.
- The workspace `tmp/` directory exists and is writable.
- `jq` is on `PATH`.

## 3. Gate command blocks

```bash
# Gate tsc-build
( cd /work/saivage-v3 && npx tsc -p . )
```
What counts as a failure: any `error TS<code>` line on stderr/stdout; warnings are ignored.

```bash
# Gate web-vite-build
( cd /work/saivage-v3/web && npm run build )
```
What counts as a failure: any vue-tsc `error TS<code>` line, OR any vite/rollup build error.

```bash
# Gate web-vitest
mkdir -p /work/tmp
( cd /work/saivage-v3/web && npx vitest run --reporter=json --outputFile=../../tmp/web-vitest-report.json )
```
What counts as a failure: any `assertionResult` with `status != 'passed'` in the JSON report, OR any suite-level failed result with zero assertion results.

```bash
# Gate analyst-e2e
mkdir -p /work/tmp
( cd /work/saivage-e2e-checkers && npm run test:analyst -- --reporter=json --output=../tmp/playwright-analyst-report.json )
```
What counts as a failure: any spec whose final outcome is `unexpected` or `flaky`.

## 4. Driver invocation

```bash
bash /work/saivage-v3/SPEC/analyst-as-control-surface/PLAN/scripts/run-gates.sh   --diff /work/saivage-v3/SPEC/analyst-as-control-surface/PLAN/baseline-gates.json
```

## 5. Comparison rule

A NEW failure for a gate is any failing-id (test_id, scenario_id, or error_id) observed by a per-stage gate run that is not present in this snapshot's failing_ids array for the same gate id. The driver script implements this diff and is the single source of truth.

## 6. Close criterion

A stage may close only if every NEW failure relative to baseline-gates.json has an open ledger entry naming a later stage; otherwise the stage's acceptance fails.

## 7. Ledger update procedure

1. (a) Run the driver in `--diff` mode.
2. (b) For each NEW id, attempt the holistic fix described in the closing stage's `design.md` Downstream impact section; if it succeeds, re-run gates and skip to (e).
3. (c) If the fix legitimately belongs in a later stage, append one entry to `saivage-v3/SPEC/analyst-as-control-surface/PLAN/expected-breakage-ledger.md` per the entry shape below.
4. (d) For each REPAIRED id, remove its open ledger entry if the entry's `Target fix stage` is the closing stage.
5. (e) Commit the ledger delta as part of the stage's close commit.

## 8. Ledger entry shape

- A markdown heading at H3 level naming the failing artifact, in the exact form `### <failing-id>` where `<failing-id>` is one of the normalized strings from the snapshot.
- `Failure mode`: one sentence describing the symptom.
- `Reason acceptable now`: which SPEC-r7 requirement or earlier-stage decision forces it.
- `Target fix stage`: the id of a strictly later stage from the dependency DAG in the master plan (one of `S01`..`S10`; `S00` is not valid).
- `Recorded by`: the stage id and ISO-date that authored the entry.

## 9. Activation preflight

1. `ping -c1 -W2 10.0.3.112`; pass if the LXC container is reachable, otherwise stop and ask the operator.
2. `curl --silent --show-error --fail --max-time 10 http://10.0.3.112:8080/health | jq -e '.status == "ok" // (. != null)'`; pass on parseable OK JSON, otherwise stop.
3. `test "$OPERATOR_CONFIRM_SERVICE_ACTIVE" = yes`; pass only when the operator set the literal confirmation after independently verifying `saivage.service` active; any other value fails closed.
4. `ls -1 saivage-v3/SPEC/analyst-as-control-surface/PLAN/stages 2>/dev/null | grep -Ev '^[0-9]{3}-[a-z0-9]+(-[a-z0-9]+)*$' | wc -l`; pass when it prints `0`.
5. `jq -e '.schema_version == 1 and (.gates|length == 4)' saivage-v3/SPEC/analyst-as-control-surface/PLAN/baseline-gates.json`; pass if the baseline parses.
6. `grep -c '^## Open entries' saivage-v3/SPEC/analyst-as-control-surface/PLAN/expected-breakage-ledger.md` prints `1` and `grep -c '^### ' ...` prints `0`; pass if the ledger is present and empty.
7. `ls saivage-v3/.saivage/tmp/state/shutdown-summary.json saivage-v3/.saivage/tmp/state/shutdown-request.json 2>/dev/null | wc -l`; pass when it prints `0`.
8. `for f in saivage.json config.json plan.json plan-history.json runtime/runtime-state.json; do test -f saivage-v3/.saivage/$f || exit 1; done`; pass if all expected runtime files exist; contents are never read.
9. `test "$OPERATOR_CONFIRM_WATCHED_PATH" = yes`; pass only when the operator set the literal confirmation after independently verifying the consumer watches the stages path; any other value fails closed.

On any failed preflight check, stop and ask the operator; do not restart the container or service, edit `.saivage/`, redeploy the harness, or touch runtime state.

## 10. Pre-publication forbidden-anchor grep

```bash
! grep -REn -i -f /work/saivage-v3/SPEC/analyst-as-control-surface/PLAN/forbidden-anchors.txt   /work/saivage-v3/SPEC/analyst-as-control-surface/PLAN/drafts/000-breakage-detection-harness/
```
If this grep prints any line, the stage directory MUST NOT be renamed into `stages/`.
