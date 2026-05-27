# Issue: Restore TypeScript build + clear production npm audit advisories on default branch

## Symptom

The scheduled GitHub Actions workflow **Validation profiles** has been failing every day on the default branch (`stage-44-permissions-by-state-matrix`, which currently matches `master`). The previous infra-level failure (missing root `package-lock.json`) and a missing `cd web && npm ci` step in three jobs were just fixed in commits `3e4f994` and `bf47da2`. With those out of the way, the next workflow_dispatch run (`26529466115`) surfaced **real code-level failures** that had been masked:

1. **`backend-jest-build` → step "Build project" (`npm run build`)** fails with ~20 TypeScript errors.
2. **`routine-docs` → step "Routine validation profile" (`npm run typecheck`)** fails with the same TypeScript errors.
3. **`dependency-hygiene` → step "Production dependency security gate" (`npm run audit:security`)** fails: 4 moderate (esbuild / vite chain) at root + 1 high at `web/`.

## Reproduction

From `/home/salva/g/ml/saivage-v3` on the default branch:

```bash
npm ci
cd web && npm ci && cd ..
npm run typecheck        # → fails (TS2305 / TS2307 / TS7006)
npm run build            # → same failures
npm run audit:security   # → fails: high in web/, moderate at root
```

Observed: TS compiler exits non-zero; `npm audit --audit-level=high --omit=dev` reports a high-severity advisory in `web/` and the root audit reports vulnerable `vite`/`esbuild` versions in the production dependency closure.

Expected: clean `npm run build`, clean `npm run typecheck`, clean `npm run audit:security`. Both the **workflow_dispatch** run on `master` and the **scheduled** run on `stage-44-permissions-by-state-matrix` end green.

## Failure details — TypeScript

All errors are in the default-branch tree at HEAD (`bf47da2` at time of filing). Verbatim from CI log of run `26529466115`, job `78141955335` ("Build project"):

**A. Missing module:**

- `src/contracts/index.ts(198,8): error TS2307: Cannot find module './agent-execution.js' or its corresponding type declarations.`

**B. Missing exports from `./runtime/index.js`:**

- `src/cli.ts(9,10..59)` and `src/cli.ts(10,10)` — `isLocked`, `pauseRuntimeControl`, `readRuntimeState`, `resumeRuntimeControl`, `readLiveLockHolder`.
- `src/agents/fake-agent.ts(7,10..46)` — `appendRuntimeRun`, `readRuntimeState`, `upsertRuntimeActivation`.

**C. Missing export from `./agents/index.js`:**

- `src/cli.ts(6,10)` — `evaluateAuthz`.

**D. Implicit-`any` parameter errors (TS7006):**

- `src/agents/agent-adapter.ts(82,100)`, `(82,170)` — parameter `input`.
- `src/agents/fake-agent.ts(86,57)` — parameter `run`.
- `src/agents/planner-control-executor.ts(84,24)`, `(86,52)`, `(87,39)`, `(88,61)` — parameter `run`.
- `src/agents/planner-control-executor.ts(118,20)` — parameter `activation`.
- `src/runtime/active-runtime.ts(75,21)`, `(76,28)` — parameter `input`.

The shape of A–C (one missing module + an aligned cluster of missing exports) strongly suggests a half-finished refactor that moved or renamed symbols out of the runtime/agent barrels without updating consumers. The implicit-`any` errors (D) cluster on the same code paths and look like the same refactor lost its type annotations.

## Failure details — Production audit

From job `78141955222` ("Production dependency security gate"):

- **Root (`npm audit --audit-level=high --omit=dev`):** 4 moderate severity vulnerabilities; chain `esbuild ← vite`. Fix advertised as available via `npm audit fix`. Even though severity is moderate, the gate is configured to fail on `high` — the gate is failing because the **web** audit (next bullet) finds a high.
- **Web (`cd web && npm audit --audit-level=high --omit=dev`):** 1 high severity vulnerability. Fix advertised as available via `npm audit fix`.

The harness must identify which package is the high in `web/`, decide whether the bump is safe (semver-compatible advisory fix vs. breaking) and apply the minimum fix that closes the high — and ideally the moderates too, since root `validate:release` runs after audit and any downstream breakage will surface there.

## Suspected cause

For TS errors: a partial refactor (likely from a recent stage) renamed/moved symbols from the runtime and agents barrels and dropped type annotations on a few callbacks, without updating downstream consumers (`src/cli.ts`, `src/agents/fake-agent.ts`, `src/agents/agent-adapter.ts`, `src/agents/planner-control-executor.ts`, `src/runtime/active-runtime.ts`, `src/contracts/index.ts`). Git history near `src/runtime/index.ts`, `src/agents/index.ts`, and any commit that touched `agent-execution` will pinpoint the exact rename.

For audit: routine upstream advisories accumulated. Likely `vite` chain on the web side (the high) and `esbuild` chain at the root (the moderates).

## Acceptance criteria

After the fix, all of the following must succeed on the default branch:

- [ ] `npm run typecheck` exits 0 — no `TS2305`, `TS2307`, or `TS7006` errors anywhere in `src/`.
- [ ] `npm run build` exits 0.
- [ ] `npm test` exits 0 (the full Jest backend suite).
- [ ] `npm run web:test:sweep` exits 0 (the existing web vitest sweep — to verify the export restorations didn't silently regress UI behavior).
- [ ] `npm run web:test:operator-smoke` exits 0.
- [ ] `npm run validate:routine` exits 0.
- [ ] `npm run validate:ui-smoke` exits 0.
- [ ] `npm run audit:security` exits 0 — no remaining `high` advisories in production deps at root or in `web/`.
- [ ] The next manual run of the **Validation profiles** workflow on `stage-44-permissions-by-state-matrix` ends with conclusion `success` for every required job (the harness does not need to trigger that run; CI will pick it up on the next schedule).

## Out of scope

- **Do not edit `.github/workflows/validation.yml`.** It was just fixed in commits `3e4f994` (track `package-lock.json`) and `bf47da2` (install web/ deps in `ui-smoke`, `browser-smoke`, `scheduled-release-backstop`). Treat that workflow as frozen for this proposal.
- **Do not edit `.gitignore`** for `/package-lock.json`. The recent commit deliberately untracked that line; the lockfile must remain committed.
- **Do not change runtime or agent semantics** to make the TS errors go away. The correct fix is to **restore the public surface** the consumers expect — either by re-exporting from the barrel (`src/runtime/index.ts`, `src/agents/index.ts`) or by updating the import sites to point at the new symbol location, whichever matches the refactor's intent. If a deliberate rename happened, update both producers and consumers; do not stub out the missing function.
- **Do not silence TS7006 with `: any` casts.** Recover the original type (look at the symbol's definition or the surrounding contract) and annotate properly.
- **Do not bump web dependencies beyond what closes the high advisory** plus, optionally, the root moderates. No opportunistic major upgrades. If a fix requires a major bump that breaks tests, file a delta-proposal explaining the trade-off instead of force-pushing the upgrade.
- **Do not touch container, service, or LXC configuration** (`saivage.service`, `saivage-v3-checkers.service`, bind mounts).
- **Do not change `.saivage/saivage.json`, `.saivage/auth-profiles.json`, or any provider/model routing.**
- **Do not modify mailbox files other than this one** (the two batch-3 UI proposals already in the queue must run in their own cycles).
- **Do not rebase or force-push.** Use forward commits on whatever branch the harness operates on.

## Notes

- The infra fixes already shipped on `master` (`3e4f994`, `bf47da2`) are fast-forwardable onto `stage-44-permissions-by-state-matrix` and have been pushed to both refs.
- Reference CI run for the surfaced errors: `https://github.com/salva/saivage-v3/actions/runs/26529466115` (workflow_dispatch, `stage-44-permissions-by-state-matrix`).
- The harness can re-trigger the workflow via `gh workflow run validation.yml --ref stage-44-permissions-by-state-matrix` once the fix has been pushed, to confirm acceptance before archiving this proposal to `done/`.
