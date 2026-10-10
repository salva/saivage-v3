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

`tests/scripts/export-consumers.test.js` checks semantic inventory correctness,
not fixed repository-wide classification counts. It independently checks
candidate/consumer parity, unique identities, record/histogram arithmetic,
effective totals, declaration reachability and promotion evidence, zero-use
cleanup, and empty failure/stale/unsupported/allowlist results. It also checks
selected current-owner SFC consumption examples, not historical API preservation
or a complete export inventory. Update those examples after evidenced intentional
owner replacements while retaining all independent parity/cleanup checks and
per-example existence, production-consumed classification, and SFC consumption
assertions. Controlled fixtures retain exact semantic classification expectations.
Legitimate public-surface changes must preserve these invariants rather than
automatically repin examples or aggregate counts.
Run the focused test with `npm run test:direct -- --runInBand --runTestsByPath
tests/scripts/export-consumers.test.js`; this script enables Node's experimental
VM modules for Jest. Direct Jest invocation likewise requires
`NODE_OPTIONS=--experimental-vm-modules`. Export and boundary refactors also
require the full `npm test`, including its serial terminal-child stage;
`validate:routine` runs the export CLI and architecture Jest, but not that semantic export Jest coverage.

## Canonical-persistence drift guard

`npm run check:canonical-persistence-drift` provides bounded lexical hints
against retired card/authored-record index authority. Established conversation
session indexes and empty catalogs remain legitimate. Its source restrictions
and semantic owner tests provide independent evidence; the documentation checks
do not fully interpret natural language or verify runtime persistence invariants.
Migration-policy scope is established by semantic review of AGENTS and current
operator guidance, not word detection. This guard does not ban affirmative
external-migration prose or certify that an operation is authorized.

## Import-boundary ratchet

Backend import-boundary findings are pinned by both their count and a SHA-256
digest of the sorted multiset of slash-normalized source path, selected rule,
and normalized resolved-target identities in
`scripts/import-boundary-baseline.json`. The check fails on increases,
genuine removals, and equal-count substitutions; line-only movement and
equivalent relative, alias, or terminal `.ts`/`.js` spellings of the same
resolved target do not change identity. After reviewing a genuine removal,
compare the complete before/after identity multisets, including duplicates:
the after multiset must be a subset, not just smaller. The current baseline is
zero, including runtime-origin imports, with no surviving exception tables:
all backend callers use permitted owner roots or the reviewed exact public
entrypoint set in `scripts/check-import-boundaries.cjs`, not a `*-api` filename
convention. Neighboring and nested paths are not admitted. There is no blanket
runtime permission for other packages' leaves. Runtime conversation operations use
`persistence/session-api.ts`; text sanitization is runtime-local in
`runtime/analyst-sanitization.ts`.
The exact defining `schemas/round-id-server.ts` module is a server-only public
owner API (including normalized terminal `.ts` spelling), not a schemas-wide
or general `*-server` exemption. `schemas/index.ts` remains browser-safe and
does not export those generators. Cross-package consumers of runtime use only
`runtime/runtime-api.ts`; agents may not import runtime, and runtime may not
import agents, even through public APIs. Workspace must not import runtime and
server must not import boot, including type-only references and export-from
occurrences; public surfaces do not override these denials. Redaction primitives
may reference only schemas and contracts across packages, including type-only
references; direct owner projectors do not live in redaction. Same-package leaves remain allowed.
The scanner and self-test use one classifier returning null or a single rule,
with precedence `contracts-declarative`, `schemas-bottom-layer`, `redaction-primitive`, `agents-runtime`,
`runtime-agents`, `workspace-runtime`, `server-boot`, `server-import`, then `cross-package-deep`. Specific ownership
prohibitions override public-surface admission; boot's server imports still
require a permitted public surface. Each offending matched import/export-from
occurrence contributes exactly one tuple. Repeated identical edges count
separately and remain duplicated in the digest; neither line numbers nor
diagnostic wording participates in identity, and no deduplication occurs.
Copy both printed fields into the baseline in the same commit only after a
reviewed genuine removal.
Admitting any new identity, including through an equal or lower count, weakens
the guard and requires an explicit owner decision.
`npm run test:import-boundaries` is the canonical focused command: it runs the
checker exact-rule self-test, real-CLI ratchet subprocess regressions (including
overlap precedence, repeated occurrences, substitution, line movement, exact public
entries, direct owner projector admission, and type-only upward redaction denial),
and repository admission. The lint profile
delegates to that command once; direct component invocations are diagnostic
evidence, not alternative maintained profiles.
For component diagnosis use `node scripts/check-import-boundaries.cjs --self-test`
and `node scripts/check-import-boundaries.cjs`. Admission does not prove cycle
freedom or complete import-syntax coverage; routed value imports also need
focused execution coverage of their actual semantic owners.

## Backend test runner ownership

Backend suites use Jest 30 with ts-jest 29.4.9's ESM transformation and the
Node test environment. Explicit `testMatch` patterns retain the JS/TS families
`**/__tests__/**/*.[jt]s?(x)` and `**/?(*.)+(spec|test).[tj]s?(x)`.
The Node-owned `tests/scripts/import-boundary-ratchet.test.cjs` is not a Jest
suite; `npm run test:import-boundaries` runs it with `node --test`.
Ordinary Jest excludes Playwright, backend E2E, and the real-terminal-child
suite. `npm test` runs ordinary parallel Jest, then the exact terminal-child
suite serially; `npm run test:e2e` separately owns backend E2E.

Heavy functional fixtures use explicit per-test 30-second harness deadlines
for parallel validation contention, not a new default or global multiplier. Examples include:

- `tests/e2e/reviewer-rework-feedback.e2e.test.ts`: `lets the owning goal Planner reopen the same completed child for reviewed correction` — durable multi-activation correction.
- `tests/e2e/specialized-card-type-flows.e2e.test.ts`: `cycles clean architecture reviews, redrafts after system revision, and promotes the latest draft while exporting final review evidence` — durable review/redraft cycles.
- `tests/tools/project-file-tools-read-limits.test.ts`: `reports exact totals beyond the count window and reconstructs an oversized glob item from global positions` — 1002-file packing and byte pagination.
- `tests/tools/view-image.test.ts`: `accepts the exact 40M-pixel boundary with a >16K side: normalizes 2000x20000 without upscaling or metadata` — exact-cap normalization; the adjacent decoded-pixel/selected-PNG hard-cap rejection case also retains its 30-second deadline.

Completion waits, assertions, fixture/result limits, and application timers remain
unchanged. These harness deadlines are not application latency guarantees and do
not suppress process-exit diagnostics.

Independently of those unchanged harness deadlines, ProcessRunner now retires its
losing wait timeout. Focused timer-retirement and isolated natural-exit regressions
cover that defect; historical tails/warnings were not complete handle attribution,
and this coverage does not certify all teardown fixed.

## Profile coverage and prerequisites

Both root and web dependencies must be installed before `npm run lint` or
`npm run validate:routine`; both installs retain development dependencies so
the validation toolchain remains available. The lint profile currently runs the
export-consumer guard, stamp-producer guard, ESLint, backend import-boundary
checks, web-component boundary check, reachable-browser import guard
(`node scripts/check-web-browser-imports.cjs`), then the `npm run format`
Prettier check. This is the current script sequence, not a required relative
order for independent checks; the cadence guard enforces required coverage and
fail-propagating composition. The formatter checks `src/` excluding
`src/config/system-templates/**/prompts/**` using the existing Prettier settings
and does not rewrite files. Shipped model-facing prompt bytes, including whitespace,
are authored deliberately rather than automatically formatted; build retains
packaging parity, source/package byte comparison, and compiled composition checks.
The existing `lint-guards` CI job runs this lint profile and is enforced by
`validation-required` under its existing applies/skipped semantics.
`validate:routine` includes typecheck, export-consumer guard,
canonical-persistence drift, `npm run test:direct -- --runInBand tests/architecture`,
and `docs:verify`, each once. Their independent relative order is not a cadence
contract. This is limited
architecture Jest coverage, not the complete backend suite or lint; export and
boundary refactors still require the focused semantic checks and full `npm test`.
A fresh dual `npm ci` is required for CI setup, not before every ordinary local
command invocation.

## CI topology

The push-only `master` workflow in
[`.github/workflows/validation.yml`](../.github/workflows/validation.yml) uses
least-privilege, secret-free Node 24 jobs and cancels superseded runs.

- `routine-docs` (always run) clean-installs root and web dependencies, then
  runs `validate:routine` once. Its included `docs:verify` is the job's sole
  docs gate; there is no separate `validate:docs` invocation. The local
  `validate:docs` profile remains available.
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
  aggregate. Pages and instance `/docs/` use separate builds from the same
  documentation sources: Pages retains `DOCS_BASE=/saivage-v3/`, while the
  instance build uses `/docs/` (guarded by `npm run test:static-serving`).

The cadence guard requires command coverage and real prerequisite relations:
checkout precedes cached Node setup, Node 24 setup precedes installs, and root
and web installs precede their routine, build, or browser consumers. Backend E2E
requires the root install. Chromium and host browser dependencies are installed
before browser smoke, and artifact upload follows smoke. Independent installs
and browser setup operations need no relative order; harmless extra steps do
not change this contract.

## Browser and E2E profiles

Shared-root export changes require `node scripts/check-web-browser-imports.cjs`
and `npm --prefix web run build` (browser graph admission, Vue typecheck, Vite
production build), plus `npm --prefix web run test --
src/__tests__/card-store.test.ts src/__tests__/operator-cockpit-smoke.test.ts`
for the actual schemas-root consumers. Web uses `schemas/index.ts` as well as
selected contract/schema leaves; the backend-facing contracts root is not a
browser entry. Node typecheck/Jest alone cannot establish browser eligibility;
Node-externalization warnings are not browser-safety success.

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
- The real-server fixture helper explicitly binds both the disposable project
  root and its `.saivage/saivage.yaml`; ordinary fixture setup must not leave
  process-global startup selectors behind. `restarted-card-cockpit.spec.ts`
  supplies conflicting synthetic stale `SAIVAGE_CONFIG` and
  `SAIVAGE_PROJECT_ROOT` selectors through both starts and restores their exact
  prior presence and values afterward. This regression exercises current strict
  production loading of the intended fixture, not missing-config recovery.
- The control-room route smoke checks visible collapsed partial-message qualifiers,
  selected versus full message counts and incomplete-item byte coverage in semantic
  detail, then the secondary safe-original result disclosure. Its mocked REST and
  WebSocket preview evidence does not validate a real backend.
- Operator browser smoke includes a non-loopback plain-HTTP scenario; the
  validation host must expose a non-internal IPv4 interface reachable by
  local Chromium. Absence is a failing prerequisite, not a skipped test.
- The preview failure observer tolerates same-origin `/api/` GET failures only
  for exact `net::ERR_ABORTED`, independent of any named navigation phase;
  other failed requests remain asserted absent. This is not proof of a
  cancellation's cause.
- To use a locally installed Chrome for release validation:
  `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/absolute/path/to/chrome npm run
  validate:release`. Omitting the variable retains the managed-browser
  default; this affects local validation only.

### Markdown consumer checks

Run `npm --prefix web run test -- src/__tests__/content/markdown-text.test.ts
src/__tests__/card-records-section.test.ts` for mounted parser/sanitizer semantics
and record presentation. The component coverage includes GFM, literal code and
malformed links, Unicode NBSP preservation, card-reference hrefs, and removal of
scripts, executable attributes and unsafe URLs through the actual string path.

`tests/playwright/smoke/markdown-rendering.spec.ts` exercises conversation Markdown
and full record content in the built application, including sanitized DOM
and card-reference navigation to selected card detail. Run it with
`node node_modules/@playwright/test/cli.js test -c
tests/playwright/smoke/playwright.config.ts
tests/playwright/smoke/markdown-rendering.spec.ts`. It uses synthetic API fixtures
and mocked transport, not a live deployed project or provider.

For parser dependency refreshes, observe the upstream `'[](' + '\u00a0'.repeat(n)`
workload in isolated child processes with external timeouts, increasing bounded
sizes before the full upstream size of 50,000. Compare exact versions and literal
paragraph semantics. These task-local observations are not timing CI thresholds,
an arbitrary-input complexity guarantee, or audit/security certification.

### Development-tool semantic checks

After installing both dependency graphs, run these focused checks from the
repository root:

```bash
node --test tests/scripts/devtool-security.test.cjs
npm --prefix web run test -- src/__tests__/devtool-lifecycle.test.ts --maxConcurrency=2
npm run web:test:e2e:browser-client-smoke
```

The Node checks use disposable harmless fixtures under workspace `tmp/`: Vite's
actual web configuration must deny direct filesystem and resolved-alias requests
to a denied file, before and after intentional shared-root imports. Babel must
reject a source map outside the fixture package while retaining same-package and
inline maps; the real babel-jest transformer also produces usable code and maps.
The real installed ts-jest CLI also runs `config:init` in a fresh disposable
directory, rendering its own fixed template without an existing config or
`--force`. The generated CommonJS config is evaluated with repository-root
module resolution to check the Node environment and usable ts-jest transform
selection through the real preset. This config-generation smoke protects
consumer compatibility; ordinary Jest JS/TS suites separately exercise the
normal ts-jest ESM transformation path.
The browser-client check executes the actual cards store, shared schemas and API
client in Chromium with intercepted API calls, not a live deployment.

The nested concurrent Vitest regression bounds each test's beforeEach/body/afterEach
lifetime by the effective `maxConcurrency`; the full `npm run web:test` also runs
it with the ordinary limit. This does not promise suite-level hook serialization,
cross-worker limits, or application ownership correctness. Retain the existing
conversation-store cancellation and UI unmount coverage separately.

These checks accompany current-line security patches for Vite's resolved-file
admission, Vitest's mocker filesystem boundary and lifecycle limiter, and Babel's
input-source-map boundary. The dependency refresh retains unrelated resolutions,
with only Babel's required generator and the seven installed Vitest companions
following their owners. It adds no production security wrapper or durable-format
change. The checks are bounded consumer evidence, not comprehensive security
certification, proof of old-release local exploitability, or root-agent containment;
the jsdom suite does not exercise standalone Vitest mocker/browser mode.

Handlebars 4.7.10 is selected through ts-jest's existing dependency range,
without a direct dependency or override. The observed Handlebars consumer is
ts-jest's config-init CLI, which compiles a fixed string template with default
options, not an untrusted AST, prototype-method-enabled rendering, or inline
HTML precompilation. No affected production HTTP/template path is evidenced;
this bounded observation is not a comprehensive no-exposure proof or a reason
to waive the independent root/web audit gate and its include-dev scope below.
Consumer checks or a patched dependency alone do not establish all-green
validation or whole-project acceptance.

## Build and release gates

The build and release gates package every registered prompt tree. Packaging
checks independently compiled classic/classic-typed closures for equal selected
shared agent/fragment path membership and bytes, plus byte equality of shared
process prompts at common paths; typed-only process paths remain permitted.
The ordinary registry/copy-script Jest suites protect this family parity guard.
Build then runs each template's
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
Passing `npm run validate:release` does not run or replace the separately
required root-and-web `npm run audit:security` gate.
