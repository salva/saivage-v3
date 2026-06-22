# F14 r1 Reviewer Notes

Reviewed:

- [01-analysis-r1.md](01-analysis-r1.md)
- [02-design-r1.md](02-design-r1.md)
- [03-plan-r1.md](03-plan-r1.md)

Bias was toward approval, but three concrete review-axis failures need a small r2 pass before this should be marked approved.

## Blocking Findings

1. **Markdown source links in all r1 docs are broken by one directory level.** From this directory, links such as `../../../src/contracts/operator-api.ts` resolve under `SPEC/src/...`, not the repository `src/...`; `../../../../src/contracts/operator-api.ts` is the resolving path. The affected links include the core citations in `01-analysis-r1.md`, `02-design-r1.md`, and `03-plan-r1.md`. The cited line numbers themselves match the actual files I spot-checked: `RuntimeGetStateResponseSchema` is at `src/contracts/operator-api.ts` lines 132-137, `runtime.getState` is at lines 259-268, the handler is at `src/server/routes/operator-contracts.ts` lines 80-88, `redactOperatorErrorMessage` is at `src/workspace/file-access-security.ts` line 83, and the hard-coded AppShell project name is at `web/src/components/layout/AppShell.vue` line 100.

2. **The backend targeted test command is not realistic for this repo.** `03-plan-r1.md` asks for `npx vitest run tests/server/operator-state-identity.test.ts`, but the root package uses Jest (`npm test` / `NODE_OPTIONS=--experimental-vm-modules jest`) and has no root Vitest config or dependency; only `web/vitest.config.ts` exists for web tests. Replace the backend command with a Jest command, for example `NODE_OPTIONS=--experimental-vm-modules npx jest tests/server/operator-state-identity.test.ts --runInBand --forceExit`.

3. **The test plan does not directly cover the project-root redaction path.** The design correctly treats `/api/state.projectRoot` as a typed, intentional identity field, and the route branch tests cover null-runtime and populated-runtime behavior. However, existing tests do not directly exercise `redactOperatorErrorMessage(message, projectRoot)`, and the r1 plan only states that redaction should continue rather than adding a focused assertion. Add a Jest test, probably in `tests/utils/file-access-security.test.ts`, proving an error string containing the project root emits `[PROJECT_ROOT]`/redacted paths and never the raw root, while the `/api/state` identity test still proves the typed field is intentionally present.

## Confirmations

- The proposed contract change is not a backward-compatibility shim: `projectRoot` and `projectId` are required top-level fields, with no alias or optional fallback.
- The proposed handler shape emits identity in both branches: the null-runtime response and the populated-runtime response both spread the same identity object.
- The deployment plan uses host build plus SSH restart and health probing on `10.0.3.170`; it does not introduce `rsync`. Keep the authenticated `/api/state` probe gated on explicit token authorization, as the plan already notes.
- The source-level scope is appropriately small: API schema, operator state handler, web runtime store/type/mocks, and focused tests. No new docstrings/comments are proposed in untouched code.

VERDICT: CHANGES_REQUESTED