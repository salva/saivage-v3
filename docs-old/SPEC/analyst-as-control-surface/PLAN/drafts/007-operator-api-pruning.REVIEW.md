# S07 Reviewer Pass 4

Verdict: APPROVED

Findings: 0 total (0 blocker, 0 major, 0 minor).

Single most important issue: none.

## Representative Carry-over Spot-checks

- R-CLASS-3: PASS. The two valid card-like fixtures in [saivage-v3/tests/schemas.test.ts](saivage-v3/tests/schemas.test.ts#L71-L124) both carry `priority: 0` and omit `position`; [saivage-v3/src/schemas/validators.ts](saivage-v3/src/schemas/validators.ts#L22) requires `position: z.number().int().nonnegative()`, so inserting `position: 0,` after `priority: 0,` is correct.
- R-CLASS-4: PASS. `baseOk` in [saivage-v3/tests/runtime/runtime-state-last-tick-at.test.ts](saivage-v3/tests/runtime/runtime-state-last-tick-at.test.ts#L36-L52) lacks `pid`, while [saivage-v3/src/schemas/validators.ts](saivage-v3/src/schemas/validators.ts#L109) requires a positive integer `pid`; adding `pid: 123,` is correct. The inversion planned for [saivage-v3/tests/schemas/runtime-state-pid.test.ts](saivage-v3/tests/schemas/runtime-state-pid.test.ts) is sensible: test 1 should assert pid preservation plus `hasOwnProperty`, and test 2 should assert pid-less RuntimeState input throws.
- R-CLASS-6: PASS. The stubborn-child test in [saivage-v3/tests/lifecycle/resource-scope.test.ts](saivage-v3/tests/lifecycle/resource-scope.test.ts#L89-L105) currently uses `timeoutMs: 100`; [saivage-v3/src/lifecycle/resource-scope.ts](saivage-v3/src/lifecycle/resource-scope.ts#L44-L189) defines `MIN_CHILD_KILL_GRACE_MS = 25`, computes `graceMs = max(25, timeoutMs / 2)`, and wraps child disposal with `timeoutMs + 25`. Bumping the test timeout to 500 gives a 525 ms outer cap and 250 ms inner SIGTERM/SIGKILL grace, making the SIGKILL escalation observable on slower hosts.

Because all three representative spot-checks pass, I accept the writer's per-suite analysis for the remaining 20 carry-over failures.

## Mechanical Re-runs

- Autonomy literal grep on `design.md` and `plan.md`: PASS, no output.
- Emoji grep on `design.md` and `plan.md`: PASS, no output.
- Host-path `/work/` grep on `design.md` and `plan.md`: PASS, no output.
- Independent substep count: PASS, `grep -cE '^[A-Z]\.[0-9]+[a-z]?( |\.)' plan.md` returned 119, matching A:8 + B:18 + C:14 + D:16 + E:5 + F:9 + G:34 + H:15.

## Carry-over Checks

- BLOCKER-1 Fastify-aware mutation grep: PASS. A.4 inventories the current five pre-stage Fastify mutation registrations with `grep -REn 'fastify\.(post|put|delete|patch)\(' src/server`, and H.6 requires the final post-stage match set to shrink to exactly two registrations: auth ws-ticket and analyst chat.
- Option A registry-internal vs external split: PASS. The design keeps `operatorApiContracts` read-only while preserving auth bootstrap and analyst chat as non-contract Fastify routes; B.8 and C.9 explicitly reject adding auth/chat registry entries.
- H.4 ledger prose: PASS. The plan states the cumulative ledger has exactly one open entry, targets S08, and produces zero S07 close-out rows, making H.4 a true no-op.
- 0 NEW S07 forecasts: PASS. The design's paper-plan default is zero S07-targeted forecast entries, and H.11 permits only S08-S10 targets for any genuinely out-of-scope new failure.
- S06 live-probe re-run: PASS. A.8 records the pre-stage probe in both bootstrap states, and H.5 reruns the same probe post-stage for `empty` and `configured` fixture states.# S07 reviewer pass 3

Verdict: CHANGES_REQUESTED

Finding counts: 1 blocker, 0 non-blocking findings.

## Findings

### BLOCKER: G.20-G.30 do not yet repair the captured carry-over Jest failures

R-BLOCKER-2 does not pass. The captured `tmp/s07-review-npm-test.out` summary at lines 3899-3900 is correctly read as 28 failed suites / 44 failed tests, and the 5 S07-scope plus 23 carry-over split is broadly plausible. However, the concrete G.20-G.30 repairs are not sufficient for several representative carry-over suites because the proposed root causes do not match the actual failing assertions.

Representative spot checks:

- `tests/schemas.test.ts`: G.21 says to add `priority: 50`, but the inspected fixtures already contain `priority: 0`; they are missing `position`. The failure will survive unless `position` is added/aligned.
- `tests/server/generated-file-inspection.test.ts`: G.22 says to add `priority: 50`, but both card JSON fixtures already contain `priority`; the captured failure is missing `position` on `.saivage/cards/by-id/project.json`. Same issue applies to the inspected `tests/agents/card-history-tools.test.ts` project fixture.
- `tests/runtime/runtime-state-last-tick-at.test.ts` and `tests/schemas/runtime-state-pid.test.ts`: G.24-G.25 discuss `last_tick_at` nullability and pid preservation, but `runtimeStateSchema` currently requires positive numeric `pid`. The failing `baseOk` and `baseRuntimeState()` fixtures omit `pid`, and the second pid test still asserts a runtime state without pid is valid. The substeps do not cover those fixes.
- `tests/lifecycle/resource-scope.test.ts`: G.28 covers the `exitCode === null` case, but the same suite also fails because the escalation test expects `SIGKILL` while the actual signal is `SIGTERM`. The substep leaves that assertion unresolved.
- `tests/mcp/mcp-manager.test.ts` and `tests/mcp/mcp-invoke.test.ts`: G.26-G.27 cover one disabled/autostart expectation and one error-class expectation, but the captured output shows broader failures: `mcp-manager` has multiple spawn/status failures, and `mcp-invoke` also has a timeout and elapsed-time assertion failure. The current substeps would not make these suites green.

Because G.31 requires final `npm test` green, these gaps are blocking. The writer needs to update G.20-G.30 so every observed failure class has a fix that corresponds to the actual captured output and source/test artifacts.

## Targeted Checks

- R-BLOCKER-1 mutation grep: PASS. `design.md` uses `grep -REn 'fastify\.(post|put|delete|patch)\(' saivage-v3/src/server` in the Goal and Final mechanical gate. `plan.md` uses the same Fastify-aware method pattern in A.4 and H.6 with project-root-relative `src/server`, consistent with its stated working directory. H.6 asserts exactly two matches: auth `ws-ticket` and `chats-files-debug.ts:149`.
- R-BLOCKER-2 npm test carry-over repairs: FAIL for the blocker above.

## Independent Checks

- Substep count: PASS with strict heading grep. A:8, B:18, C:14, D:16, E:5, F:9, G:31, H:15, total:116.
- Autonomy literal grep on `design.md` and `plan.md`: PASS, zero hits.
- Emoji grep on `design.md` and `plan.md`: PASS, zero hits.
- Workspace-host path guard on `design.md` and `plan.md`: PASS, zero hits.
- Ledger prose: PASS. The live ledger has exactly one open entry, `analyst-e2e:scenario-analyst-chat-context-child-order:step-1`, targeting S08; no S07-targeted entries are present.
- Option A registry-internal/external split: PASS. The draft preserves the split between read-only `operatorApiContracts` entries and non-contract Fastify auth/chat writes.
- S06 live-probe re-run: PASS. A.8 and H.5 cover both `empty` and `configured` bootstrap states.
- Forecast policy: PASS in prose. The draft keeps zero S07 forecast entries and repairs carry-overs in-stage, but the actual repair substeps need correction before approval.

## Spot-check Plausibility Summary

- Jest ESM transform: plausible root-cause class. `package.json` still transforms TS/JS through CommonJS, and the captured failures include `import.meta`, top-level await, and ESM `.js` test issues. The exact script edit should account for the current `NODE_OPTIONS=--experimental-vm-modules jest` script already present.
- Card fixture schema drift: not plausible as written. The failures and inspected fixtures point to missing `position`, not missing `priority`.
- Runtime-state schema drift: not plausible as written. The source schema requires `pid`; the plan only partially adjusts pid expectations and misses pid fixture insertion.
- MCP behavior drift: partially plausible but incomplete. One named error-class fix is real, but several captured MCP failures remain unaddressed.
- Hardening e2e timeout and redaction budget: plausible. The captured output matches the proposed timeout bump and redaction budget refresh.