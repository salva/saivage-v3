# F14 r2 Reviewer Notes

Reviewed:

- [01-analysis-r2.md](01-analysis-r2.md)
- [02-design-r2.md](02-design-r2.md)
- [03-plan-r2.md](03-plan-r2.md)
- Prior r1 objections in [01-analysis-review-r1.md](01-analysis-review-r1.md)

Bias was toward approval. I found no substantive blocker in r2.

## R1 Objection Verification

1. **Backend test runner corrected.** [03-plan-r2.md](03-plan-r2.md) now identifies the root runner as Jest from [../../../../package.json](../../../../package.json) and uses `NODE_OPTIONS=--experimental-vm-modules npx jest ... --runInBand --forceExit` for backend targeted tests. The remaining Vitest commands are scoped to `web/`, which matches the repo layout.
2. **Project-root redaction path is directly covered.** [03-plan-r2.md](03-plan-r2.md) adds a focused Jest regression block for `redactOperatorErrorMessage(message, projectRoot)` in `tests/utils/file-access-security.test.ts`, including `[PROJECT_ROOT]` substitution, absence of the raw root, omitted-`projectRoot` behavior, and repeated occurrences.
3. **Markdown link depth corrected.** The r2 docs now use `../../../../` for repo-root source links from this review subdirectory. A sweep for lingering `../../../src` / `../../../web` links and backend Vitest test commands found no remaining r1-pattern issue.

## Review Notes

- The contract change is clean: `projectRoot` and `projectId` are required top-level fields on `RuntimeGetStateResponseSchema`, with no compatibility shim or optional fallback.
- The handler plan emits the identity fields in both null-runtime and populated-runtime branches, which covers the actual deployment-identity gap rather than only the common populated-state path.
- The security model is internally consistent: typed success-body identity and operator error-message redaction are treated as separate channels, and r2 adds tests for both sides of that distinction.
- The scope remains disciplined. F14 wires identity through the API/store/test surfaces and explicitly leaves F08 header consumption, F18 PID, and liveness-contract cleanup out of this issue.

VERDICT: APPROVED