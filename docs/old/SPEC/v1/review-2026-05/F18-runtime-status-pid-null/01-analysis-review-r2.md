# F18 — Analysis Review (r2)

Bias: approved. The round-2 documents fix the r1 operational blockers and keep the architecture clean: `pid` is removed from persisted `RuntimeState`, synthesized at server response boundaries, and read from the runtime lock for out-of-process CLI status.

## Findings

No blocking findings.

## Confirmed Good

- The deployment flow is corrected to host-side `npm run build`, SSH `systemctl restart saivage-v3-getrich.service && systemctl is-active saivage-v3-getrich.service`, and a health probe against `10.0.3.170`; the plan no longer requires in-container git, package install, build, copy, or rsync steps.
- The backend Jest validation commands now consistently include `NODE_OPTIONS=--experimental-vm-modules` plus `--runInBand --forceExit`, matching the package script and Saivage validation expectations.
- The runtime lock path is corrected to `lockPath(projectRoot)` / `<projectRoot>/.saivage-work/tmp/runtime/runtime.lock`, and the proposed CLI helper reuses that single source instead of documenting or hard-coding `.saivage/.lock`.
- The planned implementation matches the existing code shape: `/api/runtime/status` currently omits `pid`, `/api/debug/state` currently returns persisted runtime state directly, and `runtimeStateSchema` is non-strict, so old on-disk `pid` keys will be stripped without adding a compatibility shim.
- The test plan covers the important semantics: active and fallback status branches, stale on-disk pid immunity, debug-state overlay, schema stripping, touched fixtures, and unchanged lock-file integration behavior.

VERDICT: APPROVED