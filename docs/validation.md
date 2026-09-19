# Validation internals

Status: contributor reference. This page owns the validation toolchain
detail: guard contracts, CI job topology, and browser/E2E profiles. README
owns validation selection and navigation; the workflow file
[`.github/workflows/validation.yml`](../.github/workflows/validation.yml) is
the executable authority.

## Export-consumer guard

`npm run check:export-consumers` is the singular complete semantic
external-consumer guard. Its candidate boundary is every tracked, non-test,
non-declaration TypeScript-family module under `src/**` and `web/src/**`, plus
every tracked, non-test Vue SFC under `web/src/**`. Its consumer boundary is
all tracked TypeScript-family files, including declarations and out-of-config
tooling, all tracked Vue SFCs under `web/src/**`, and all tracked
JavaScript-family files. Effective SFC defaults and explicit ordinary-script
exports are governed surfaces. Exact `dist/src/**/*.js` JavaScript mappings and
canonical browser `/src/<path>.ts` mappings participate in the same fixed
analysis; the function and CLI expose no scope selector or alternate phase.

Every explicit compiler-semantic cross-module source reference is immutable
direct evidence, including references in type and declaration contexts. Each
actual governed barrel or re-export route remains a distinct surface. For
ordinary TypeScript-family candidate owners, the checker adds a strictly
additive, seeded emitter-only declaration closure. Every genuinely production-
or test-consumed exported surface seeds traversal of its complete
compiler-emitted public/protected declaration contract. Declaration emit and
checking are candidate-owner-scoped and in memory only: they create no
artifact. Production reachability outranks test reachability. The dead-outer
non-rescue rule means an unconsumed outer export never seeds emitter-only
dependencies. SFCs remain complete surface and semantic-consumer owners but
do not originate declaration units or emitter-only edges; `npm run
web:typecheck` remains the authoritative Vue type gate. The four reported
classes are `production-consumed`, `test-only`, `local-only`, and `zero-use`;
the latter two fail, as do stale or unresolved edges and unsupported consumer
forms. Run `node scripts/check-export-consumers.js --report-test-only` for the
sorted test-only report. `scripts/export-consumer-allowlist.json` is the
strict exceptional allowlist and remains an empty array.

Intentional governed export-inventory changes must update the pinned
classification counts in `tests/scripts/export-consumers.test.js` in the same
commit.

## Import-boundary ratchet

Backend import-boundary findings are pinned by both their count and a SHA-256
digest of normalized file/rule/resolved-target identities in
`scripts/import-boundary-baseline.json`. The check fails on increases,
genuine removals, and equal-count substitutions; line-only movement and
equivalent relative, alias, or terminal `.ts`/`.js` spellings of the same
resolved target do not change identity. After reviewing a genuine removal,
copy both printed fields into the baseline in the same commit. Admitting any
new identity, including through an equal or lower count, weakens the guard
and requires an explicit owner decision. `npm run test:import-boundaries` is
the canonical focused command: it runs the checker self-test, real-CLI
ratchet subprocess regressions, and repository admission. The lint profile
delegates to that command once; direct component invocations are diagnostic
evidence, not alternative maintained profiles.

## Lint profile ordering

Both root and web dependencies must be installed before `npm run lint` or
`npm run validate:routine`; both installs retain development dependencies so
the validation toolchain remains available. The lint profile runs the
export-consumer guard before stamp-producer, ESLint, backend
import-boundary, and web-component boundary checks. A fresh dual `npm ci` is
required for CI setup, not before every ordinary local command invocation.

## CI topology

The push-only `master` workflow in
[`.github/workflows/validation.yml`](../.github/workflows/validation.yml) uses
least-privilege, secret-free Node 24 jobs and cancels superseded runs.

- `routine-docs` (always run) clean-installs root and web dependencies, then
  runs `validate:routine` and `validate:docs`.
- Fail-closed path classification gates the remaining jobs: `backend-jest-build`
  (dual clean install, `npm run build`, non-E2E Jest), the independent
  `backend-e2e` (root clean install, `npm run test:e2e`; no web install,
  browser, secret, or external service), `ui-vitest`, `browser-smoke`,
  `dependency-hygiene` (package/workflow changes run `npm run audit:security`),
  and `lint-guards` (enforced by `validation-required` with the same
  applies/skipped semantics).
- `docs-pages-build`/`docs-pages-deploy` build this documentation site with
  its Pages base and publish it to GitHub Pages after `routine-docs`
  succeeds; deployment is intentionally outside the `validation-required`
  aggregate. The same build output is served by every running instance at
  `/docs/` (guarded by `npm run test:static-serving`).

## Browser and E2E profiles

- `npm run web:test:operator-smoke` is the operator smoke owner: the Vitest
  dashboard smoke plus the Playwright smoke specs, including the Cards
  browser regression owners (`cards-independent-scroll-selection.spec.ts`,
  `card-status-presentation.spec.ts`).
- `npm run web:test:e2e:smoke` is the complete self-contained browser
  profile: exactly `web:test:e2e:preview-smoke` (production preview server)
  and `web:test:e2e:browser-client-smoke` (Vite dev server); neither contacts
  a live Saivage deployment. Install Chromium with `npm run
  web:test:e2e:install` and host browser dependencies where required. After a
  failed or cancelled CI browser run, a best-effort artifact upload preserves
  `tmp/playwright-report` and `tmp/playwright-results`; missing output only
  warns.
- Operator browser smoke includes a non-loopback plain-HTTP scenario; the
  validation host must expose a non-internal IPv4 interface reachable by
  local Chromium. Absence is a failing prerequisite, not a skipped test.
- To use a locally installed Chrome for release validation:
  `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/absolute/path/to/chrome npm run
  validate:release`. Omitting the variable retains the managed-browser
  default; this affects local validation only.

## Build and release gates

The build and release gates package every registered prompt tree and run its
compiled composition smoke (`npm run test:compiled-prompt-composition`,
resolving `--source-root` against the invocation working directory for source
byte comparison). After building documentation and the web UI they also run a
real-Fastify static-serving smoke over the `/docs` redirect, built landing
and linked pages, documentation resources, web entry point, and built web
assets (`npm run test:static-serving`, which requires freshly built assets).
For isolated validation, compile production modules and the smoke into one
output root, package prompts into that root, then execute the copied smoke
with `--source-root <repository>` — release-equivalent coverage, not a
literal pass of the default profile. `npm run validate:release` is the
singular local release-sign-off composition; its constituent commands remain
useful for diagnosis.

## Dependency governance

`npm run audit:security` is the CI gate for high and critical findings in the
root and web dependency graphs. Both project `.npmrc` files set `include=dev`,
so npm's explicit inclusion takes precedence over the audit scripts' retained
`--omit=dev` flags and the effective audit scope includes development
dependencies. `npm run audit:security:all` uses the lower moderate threshold.
`npm run deps:review` runs that broader audit plus local
dependency-freshness review; it does not replace the CI gate.
