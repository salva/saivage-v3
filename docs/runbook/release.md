# Release

Use this checklist for a release candidate against the current repaired system.

## Documentation gates

- [ ] Active docs reflect current source and tests.
- [ ] No active doc presents historical plans or remediation notes as current authority.
- [ ] `docs/documentation-inventory.md` is updated when doc scope changes.
- [ ] Historical material is linked only with an explicit `See historical:` prefix.
- [ ] The runbook examples pass the docs verification drift guard.
- [ ] Documented validation commands still resolve to package scripts or executable script entry points.
- [ ] The operator-dashboard smoke guard command is present, documented, and passing before release sign-off.


## Validation matrix

Use Node.js 22 with the npm range declared in package engines (`node >=22.12.0 <23`, `npm >=10 <12`) before running release checks; this matches the CI setup-node profile. Use the named validation profiles from the repository root so routine checks stay consistent with package scripts. `validate:docs` intentionally runs only `npm run docs:verify`; it does not run `npm test` or the Vitest operator smoke guard, because documentation verification must stay lightweight and fast enough for routine doc drift checks.

| Change type | Required command profile | Underlying required commands | Notes |
|---|---|---|---|
| Docs-only | `npm run validate:docs` | `npm run docs:verify` | Use when Markdown, docs anchors, route inventory, or runbook examples change without source behavior changes. |
| Backend/runtime | `npm run validate:routine` plus `npm test` when runtime behavior changes | `npm run typecheck`, `npm run docs:verify`, and focused/full Jest as appropriate | Run the focused Jest suite for the touched runtime area; use full `npm test` before stage close or when behavior changes broadly. |
| UI/operator surface | `npm run validate:ui` | `npm run web:typecheck`, `npm run web:test:sweep`, `npm run web:test:operator-smoke`; add focused Vitest/Playwright for the changed component or flow | For dashboard-only smoke confirmation, `npm run validate:ui-smoke` is the lightweight profile that wraps `npm run web:test:operator-smoke`. |
| Release sign-off | `npm run validate:release` | `npm run typecheck`, `npm run build`, `npm test`, `npm run web:test:operator-smoke`, `npm run docs:verify` | This is the heavy composition profile for release candidates; run it after focused suites are already green. |

The validation-cadence guard checks that every documented `npm run validate:*` profile exists and that the profile composition continues to include the commands listed above, or documents intentional exclusions such as the lightweight docs-only profile.

## CI workflow guard

The repository includes a path-aware GitHub Actions workflow at [`.github/workflows/validation.yml`](../../.github/workflows/validation.yml). Pull requests, pushes to `main`, manual dispatches, and the scheduled nightly backstop use least-privilege `contents: read` permissions, cancel superseded runs for the same workflow/ref, set up Node.js 22 with `actions/setup-node@v4` and npm caching, and install dependencies with `npm ci`. The `routine-docs` job always runs `npm run validate:routine` and `npm run validate:docs` so CI exercises the same fast package profiles operators run locally.

The workflow then fans out based on the fail-closed `classify-changes` result: backend/source/test/script/package/workflow changes run `npm run build` and `npm test` in `backend-jest-build`; web, UI-contract, browser, package, or workflow changes run `npm run validate:ui-smoke` in `ui-smoke`; browser-relevant changes run `npm run web:test:e2e:install`, `npx playwright install-deps chromium`, and `npm run web:test:e2e:smoke` in `browser-smoke`. If changed-file detection is uncertain, classifier output sets `run_all=true` instead of silently skipping heavy jobs. The scheduled `scheduled-release-backstop` runs `npm run validate:release` plus the same explicit Chromium browser and host-dependency setup regardless of paths. Manual `workflow_dispatch` remains a maintainer full-sweep/rerun path, not the only heavy gate. Branch protection should require the stable `validation-required` aggregate status; it fails failed, cancelled, or unexpectedly skipped applicable jobs while allowing classifier-explained intentional skips for non-applicable path jobs.

The workflow is intentionally secret-free: it must not reference `secrets.*`, set token/API-key/password environment variables, or echo token-like values. The validation-cadence guard scans the workflow plus this runbook and the README; stale `npm run validate:*` references, missing package scripts, missing least-privilege permissions, missing Node 22 setup, missing `npm ci`, missing concurrency cancellation, broad permissions, secret references, token-like environment assignments, or a workflow that stops running routine/docs profiles fail `node scripts/check-validation-cadence.js` and therefore `npm run docs:verify`. Playwright setup can still depend on runner image support for Chromium host libraries; when CI image dependencies drift, fix setup rather than weakening the path-aware aggregate.

## Documentation build and verification

```bash
npm run docs:verify
```

This builds VitePress and runs the documented route, inventory, link, source-anchor, finding-dossier, runbook-example, and validation-cadence guards, including checks that every docs:verify sub-guard script or focused Jest entry still exists. It also verifies that the named operator-dashboard smoke command remains documented and points at the smoke test, but does not run the Vitest smoke guard because docs verification must remain lightweight.

If needed, run the raw VitePress build separately:

```bash
npm run docs:build
```

Confirm `/docs/` serves built docs in a running server build.

## Core checks

```bash
npm run typecheck
npm run build
npm test
```

For direct Jest validation without the npm wrapper:

```bash
npm run test:direct
```

## Web checks

```bash
npm run web:typecheck
npm run web:test:sweep
npm run web:test:operator-smoke
```

Run `npm run web:test:operator-smoke` after changes to the Dashboard/AppShell operator surface and as part of release sign-off. It executes `web/src/__tests__/operator-dashboard-smoke.test.ts`, covering the synthetic control-room path for pause/resume, 401 token recovery, analyst session picking, read-only transcripts, card detail evidence/result rendering, file preview, debug timeline/errors, and notifications. It is not part of `npm test` (server/Jest only) or `npm run docs:verify`; the validation-cadence guard only checks that this command stays present and documented.

For analyst control-room coverage:

```bash
npm run web:test:analyst-ui
```

## Security and containment checks

- [ ] `/health` is public and reports runtime from the configured project root.
- [ ] `/api/*` is token-protected when `SAIVAGE_API_TOKEN` is configured.
- [ ] `/ws` rejects unauthorized connections when auth is enabled.
- [ ] `.saivage/auth-profiles.json` is blocked from file preview.
- [ ] `.saivage/saivage.json` is redacted rather than exposing literal secrets.
- [ ] Path traversal attempts are rejected by file APIs.
- [ ] Process views expose safe redacted metadata rather than raw registry internals.

## Runtime control checks

- [ ] Pause and resume behave as documented and return `RuntimeState`.
- [ ] Freeze records a freeze state and reason.
- [ ] `resume-from-freeze` restores from a valid manifest.
- [ ] Operators are not forced to infer completion from empty queues alone.

## Build and serving checks

- [ ] Built server starts through the current CLI entrypoint:

```bash
SAIVAGE_API_TOKEN=test ./bin/saivage.js start
```

- [ ] Runtime-owning startup works when intended:

```bash
SAIVAGE_API_TOKEN=test ./bin/saivage.js start --create-runtime
```

- [ ] SPA serves from `/`.
- [ ] Docs serve from `/docs/`.
- [ ] Built artifacts are not committed unintentionally.

## Operator workflow checks

- [ ] Dashboard shows meaningful unauthorized, reconnecting, stale, and degraded states.
- [ ] Cards detail exposes generated-file evidence and verification-command inspection.
- [ ] Agents view supports conversation inspection and linked-entity navigation.
- [ ] Files view surfaces blocked, missing, redacted, and unauthorized states intentionally.
- [ ] Debug exposes state, events, errors, supervision, MCP, and process diagnostics.
- [ ] Docs navigation is visible from the control room and does not require API auth.

## Final sign-off

- [ ] Versioning/release notes are updated as needed.
- [ ] Known follow-ups are documented explicitly.
- [ ] No release decision relies on stale design-era or generated-plan assumptions.
