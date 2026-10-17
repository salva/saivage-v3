# Validation internals

Status: contributor reference. This page owns the validation toolchain
detail: guard contracts, CI job topology, and browser/E2E profiles. README
owns validation selection and navigation; the workflow file
[`.github/workflows/validation.yml`](../.github/workflows/validation.yml) is
the executable authority.

## Portable temporary fixtures

Allocate disposable fixtures with `os.tmpdir()` and `path.join`, retaining each
fixture's existing `mkdtemp` prefix rather than a developer-home path. Callers can
select an existing writable short `TMPDIR`; keep workspace-harness artifacts under
workspace `tmp/`. Local validation success is not exact-SHA GitHub CI success.

## Native-path script entrypoints

`tests/scripts/file-url-entrypoints.test.js` exercises actual CLI invocation in
tracked-file relocation fixtures on Linux. Packaging uses the build's installed
tsx CLI in ordinary and `checkout café` paths (spaces/non-ASCII); the full docs
verifier uses native Node in ordinary and `checkout café #?%20%` paths (also
fragment/query punctuation, a valid-looking percent escape and literal percent).
Each case requires a healthy baseline before rejecting a missing selected prompt
or deliberate public-route drift. Packaging checks exact source/output file sets,
bytes and compiler-derived closure. Fresh distinct-driver and no-argv imports must
remain silent, even with the invalid fixture inputs retained.

Run the callers separately from the repository root:

```bash
timeout --kill-after=10s 900s env NODE_OPTIONS=--experimental-vm-modules node node_modules/jest/bin/jest.js --runInBand --runTestsByPath tests/scripts/file-url-entrypoints.test.js --testNamePattern='packaging entrypoint'
timeout --kill-after=10s 900s env NODE_OPTIONS=--experimental-vm-modules node node_modules/jest/bin/jest.js --runInBand --runTestsByPath tests/scripts/file-url-entrypoints.test.js --testNamePattern='docs entrypoint'
```

Each command must execute two cases. Child processes, including tracked-file
discovery, use `timeout --kill-after=5s 60s`; each case has a 360-second Jest
budget. This is caller-specific regression coverage, not full platform portability
or a new validation profile. The observed tsx source-loading failure before the
entrypoint in combined `#?%` checkout paths is outside this fix; these checks do
not establish packaging or full-build success in that combined punctuation path.

## Local toolchain-upgrade evidence

Use the latest supported Node 24.x LTS patch within the existing Node/npm engine
ranges. For a local toolchain comparison, record the actual `node --version`,
`npm --version`, resolved Node executable and architecture inside the validation
environment, alongside the source revision and dependency lockfile hashes.
Keep baseline and candidate source/dependencies matched; record clean-install
evidence separately, including Sharp's native import and image-conversion tests.
Retain natural command exits, timings, suite totals and warnings. This adds no
universal gate or warning-fatal policy: canonical `npm test` still owns ordinary
parallel Jest followed by the serial terminal-child suite, without forced exit.

## Matched Vue core patch comparison

Compare both root and `web/` lock graphs, recording source revision, manifest/lock
hashes and actual in-environment Node/npm versions. In separate disposable baseline
and candidate package roots, clean-install both graphs with development and optional
dependencies (`npm ci --include=dev --include=optional`) and require successful
`npm ls --all` for each. Inspect core-specific tree paths as well as exits: Vue and
its nine core companions must resolve the intended matched patch, without stranded
old copies or unrelated resolver churn. Necessary transitive changes need explicit
assessment; do not use overrides, blanket dedupe or `npm audit fix`.

Establish baseline mounted frontend and semantic SFC results. Candidate checks from
the repository root are:

```bash
npm run web:typecheck
npm run web:test
npm run test:direct -- --runInBand --runTestsByPath tests/scripts/export-consumers.test.js
npm run validate:routine
npm run validate:docs
npm run build
npm run validate:ui-smoke
node node_modules/@playwright/test/cli.js test -c tests/playwright/smoke/playwright.config.ts tests/playwright/smoke/storage-head-history.spec.ts tests/playwright/smoke/conversation-instruction-flows.spec.ts tests/playwright/smoke/operator-image-inspection.spec.ts tests/playwright/smoke/markdown-rendering.spec.ts
npm run audit:security
```

Retain mounted Records, both history panels, recorded observations, compacted context,
historical/current instructions, ContextBlock, ConversationTimeline, cockpit navigation,
UI primitives/Dialog and Markdown results. The focused root test protects the actual
compiler-semantic consumer; preserve independent counter arithmetic, not repinned
classification counts. Build includes real VitePress SSR/static generation, web types
and production assets, compiled prompt composition and static serving. Do not commit
generated outputs or change prompts/scaffold semantics to pass.

Use disposable browser fixtures, never a live project. Retain visible-browser
evidence of cockpit/Records/history/context interactions, including **Unfilled scaffold
— not authored or accepted** versus independently accepted backing; the existing
storage-history scenario covers this distinction. Report assertions, console errors
and artifacts, not merely browser startup. Mocked navigation/storage evidence and the
real disposable-server image fixture have distinct scopes. Preserve existing private-IP
namespace setup, no-egress runtime checks, short TMPDIR and writable build caches;
only bounded registry install/audit work needs external network access.

Run independent root and web `npm audit --include=dev --json` before and after, even
when the aggregate security gate short-circuits. Preserve nonzero advisory exits and
report severity counts **and unique advisory IDs**: propagated affected-package entries
are not distinct vulnerabilities. Retained unrelated advisories stay disclosed; a
new blocking result requires assessment, not an automatic broad fix. Required candidate
failures block acceptance even if baseline also fails. Keep natural exits and warnings;
do not force exit, weaken assertions or retry until green. This scoped Vue consumer
comparison is not full release certification or deployment approval; it does not claim
`npm test`, backend E2E or `validate:release` success, or waive an observed required gate.

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

Backend suites use Jest 30 with ts-jest 29.4.15's ESM transformation and the
Node test environment. Explicit `testMatch` patterns retain the JS/TS families
`**/__tests__/**/*.[jt]s?(x)` and `**/?(*.)+(spec|test).[tj]s?(x)`.
The Node-owned `tests/scripts/import-boundary-ratchet.test.cjs` is not a Jest
suite; `npm run test:import-boundaries` runs it with `node --test`.
Ordinary Jest excludes Playwright, backend E2E, and the real-terminal-child
suite. `npm test` runs ordinary parallel Jest, then the exact terminal-child
suite serially; `npm run test:e2e` separately owns backend E2E.

The shared Jest configuration sets `workerGracefulExitTimeout` to 5000ms,
a finite worker-pool shutdown allowance, not a test/hook deadline or performance
requirement. Workers receive that allowance concurrently; test selection,
concurrency and terminal-child ownership remain unchanged. Jest retains its
automatic force-exit fallback and visible warning when a worker exceeds the
allowance; no `forceExit` option is enabled. Complete canonical stages with a
natural npm exit 0 pass even if that warning appears. Warning absence establishes
only that the run emitted no warning, not leak-free cleanup or repair of an
unattributed teardown problem.

ts-jest compatibility follows declared peer ranges, not equal major numbers:
29.4.15 supports Jest `^29.0.0 || ^30.0.0` and TypeScript `>=4.3 <7`;
its Node engine includes `>=20.0.0`. Jest 30.5.2, TypeScript 5.9.3 and the
comparison toolchain Node 24.22.0 satisfy those constraints. Compatible ranges
alone do not establish correct transform behavior. The explicit JS/TS transforms
retain `useESM: true`, inline `module: ESNext`, `moduleResolution: NodeNext`,
`isolatedModules: true`, `.js`-relative mapping and VM modules. Diagnostics are
not disabled; new diagnostics block acceptance rather than justify suppression
or resolver/configuration changes. Isolated transformation does not replace
independent strict semantic typechecking through `tsc --noEmit`.

### Scoped ts-jest patch comparison

The 2026-10-16 comparison of 29.4.9 with 29.4.15 uses independent fresh root/web
`npm ci --include=dev --include=optional` environments, full peer trees and the
specific Jest/transformer/compiler dependency tree. Only the root ts-jest floor
and selected entry change; web manifest/lock bytes and all other resolutions
remain unchanged. This is maintained-line compiler correctness upkeep, not an
evidenced local bug fix, security remediation or performance improvement.

Both versions require the semantic export consumer, runtime gate/running-chain,
terminal coordinator/real-process cleanup and process-runner/registry focused
suites, a separate `npm run test:terminal-child`, and the named
`process-inline-output.e2e.test.ts` with only the Playwright ignore override.
Run the focused matrix with a fresh issue-owned Jest cache, then repeat only
`tests/scripts/export-consumers.test.js` once with that same cache. A failed cold
run blocks warming; preserve semantic assertions and export-counter arithmetic,
not timing targets. Separately run
`node --test --test-name-pattern='ts-jest config:init' tests/scripts/devtool-security.test.cjs`
in each disposable environment, with its required `../tmp` inside the fixture.
That Node-owned CLI/configuration check is not selected by Jest; unrelated
Vite/Babel cases are intentionally unselected by this filter.

Every command is finitely bounded with GNU `timeout --kill-after=5s`; tests/builds
use private-IP/no-egress isolation, short writable TMPDIR and writable dependency
caches. Require natural exits and proven empty owned cgroups, without `forceExit`,
warning suppression, retries or altered workers/deadlines. The terminal gate must
run independently even when ordinary Jest fails. Retain raw output, warnings,
timings and containment results; matching cold/warm assertions imply neither
performance savings nor reproduction of upstream's Bundler/CommonJS regression.

On 2026-10-16, baseline and candidate fresh installs and peer trees passed.
Each version passed the focused matrix (8 suites/107 tests), warm export
comparison (1/44), separate terminal gate (1/11), process-inline E2E (1/1) and
filtered config:init check (1 passed, 0 skipped; three other cases unselected).
Candidate `validate:routine`, `build`, one canonical `npm test` (333 ordinary
suites/4401 tests, then 1 serial suite/11 tests) and `audit:security` passed with
natural exits and empty owned cgroups. Routine retained strict typechecking and
semantic export counters; build covered docs SSR, web compilation, compiled
prompt composition and static-serving smoke. Independent root/web audits matched
baseline: root exit 1 reported 20 moderate affected-package entries from the sole
sprintf-js advisory GHSA-hp3w-g68c-fv3c; web exit 0 reported none, with no
low/high/critical findings in either graph. This is not security remediation.
Final-document `validate:docs` is a separate required gate. Required failures
block completion, even if also present on baseline. This comparison neither claims nor
waives applicable CI jobs or `validate:release`: full backend E2E remains an
independent unresolved release gate, not a ts-jest timing experiment. No deployment
readiness follows from these local checks.

### Terminal ownership and deadlines

The terminal-child suite launches both fixtures directly with Node `--import tsx`
(the full loader, not `tsx/esm`), without the tsx CLI process intermediary.
The signal fixture publishes a complete `READY:<pid>` line after App startup;
the test buffers that line and requires its PID to equal the spawned PID before
sending real SIGTERM, then requires exit code 0 with no terminating signal.
Each child close emits labelled, complete stdout/stderr and exit code/signal
before exit assertions consume the result. Close before READY rejects immediately
with the collected result, as do spawn errors; teardown retains partial output
for a child still running at the unchanged test deadline.

Heavy functional fixtures use explicit per-test 30-second harness deadlines
covering setup, settlement and in-test cleanup, not a new default or global multiplier. Examples include:

- `tests/e2e/reviewer-rework-feedback.e2e.test.ts`: `lets the owning goal Planner reopen the same completed child for reviewed correction` — durable multi-activation correction.
- `tests/e2e/specialized-card-type-flows.e2e.test.ts`: `cycles clean architecture reviews, redrafts after system revision, and promotes the latest draft while exporting final review evidence` — durable review/redraft cycles.
- `tests/e2e/failed-child-activation.e2e.test.ts`: `rejects autonomous reactivation of a failed child without ownership, then continues through a sibling to natural completion` — durable failed-child rejection and sibling settlement.
- `tests/e2e/urgent-summary-cancellation.e2e.test.ts`: `retains real canonical evidence and truthful queue effects on %s` (`cancel` and `distinct_failure`) — durable lifecycle/HTTP setup, cancellation settlement and joined cleanup.
- `tests/tools/project-file-tools-read-limits.test.ts`: `reports exact totals beyond the count window and reconstructs an oversized glob item from global positions` — 1002-file packing and byte pagination.
- `tests/tools/view-image.test.ts`: `accepts the exact 40M-pixel boundary with a >16K side: normalizes 2000x20000 without upscaling or metadata` — exact-cap normalization; the adjacent decoded-pixel/selected-PNG hard-cap rejection case also retains its 30-second deadline.

Inner polling/iteration guards, completion waits, semantic assertions, fixture/result limits, and application timers remain
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
top-level least-privilege `contents: read` defaults and cancels superseded runs.
Validation jobs use Node 24 without GitHub secrets; the separate Pages deployment
job retains its job-local `pages: write` and `id-token: write` permissions and
does not require Node setup.

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

The guard reads and parses each workflow once with strict duplicate-key rejection.
That parsed YAML is the sole structural authority for permissions, concurrency,
jobs, steps and decoded run scalars; quoted keys, flow mappings and block-scalar
formatting do not change policy ownership. Steps and commands are enumerated once
within their owning jobs, never ordered by unrelated jobs' source positions.
Command recognition remains bounded: blank/comment lines, backslash continuations,
environment assignments and established command-segment splitting are supported,
not arbitrary shell control flow. Independent file-scoped lexical secret-safety
checks retain their existing prohibited forms; they are not a universal prose ban.
Diagnostics use parsed source ranges and job/step identity (a run scalar's start
line for folded/escaped commands), while lexical checks retain match source lines.
Required coverage, fail-closed test gates and prerequisite relations are unchanged.

## Browser and E2E profiles

The exact-pinned test runner `@playwright/test` 1.64.1 selects `playwright` and
`playwright-core` 1.64.1. Its matched managed Chromium and headless shell are
revision 1248 / version 156.0.8078.4, with installer-selected ffmpeg revision 1013.
After refreshing these packages, rerun `npm run web:test:e2e:install` to install
their matching browsers. For isolated assessment, explicitly set
`PLAYWRIGHT_BROWSERS_PATH=/home/salva/g/ml/tmp/2026-10-16-playwright-supported-update/browsers`
for both installation and validation, with `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH`
unset. The separately pinned external Playwright MCP tooling is a distinct
contract, not this test runner/browser pairing. The optional system-Chrome
override below remains a separate validation choice, not matched-browser evidence.

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

`web/src/components/content/MarkdownText.vue` parses Marked GFM synchronously to
an HTML string, calls default `DOMPurify.sanitize(html)`, and renders the result
through `v-html`. Conversation and record presentation share this untrusted-content
boundary; there are no sanitizer hooks, XHTML options, `IN_PLACE`,
`SAFE_FOR_TEMPLATES` or DOM-returning modes in this consumer.

The web lock selects DOMPurify **3.4.17** instead of 3.4.16, retaining the
`^3.4.16` manifest range. Dated publisher evidence identifies 3.4.17 as the patched
release for [GHSA-c6gr-qvv4-5v3f](https://github.com/cure53/DOMPurify/security/advisories/GHSA-c6gr-qvv4-5v3f)
(XHTML SVG animation/attributeName),
[GHSA-mrv2-3pqr-j5jr](https://github.com/cure53/DOMPurify/security/advisories/GHSA-mrv2-3pqr-j5jr)
(`IN_PLACE` hooks detaching subtrees), and
[GHSA-cg2g-xh64-v4q7](https://github.com/cure53/DOMPurify/security/advisories/GHSA-cg2g-xh64-v4q7)
(`SAFE_FOR_TEMPLATES`, DOM output and attached shadow roots with downstream
evaluation). These nondefault-mode demonstrations are not reproduced Saivage
exploits. The publisher supports its latest release; a dated patch selection is
neither a latest-forever promise nor proof of comprehensive security.

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

For sanitizer comparisons, run these actual consumers before and after fresh
root/web installs and peer-tree checks. Preserve benign GFM/tables/code/HTTPS,
encoded Cards links/navigation, literal references in code, and image/alt retention;
require removal of scripts, executable attributes and plain/encoded JavaScript
URLs. The browser scenario covers conversation, record disclosure and Records &
History, a false execution sentinel and no unexpected requests/page/API errors.
Image-element retention does not establish PNG decoding fidelity. Focused passes
do not replace full candidate validation or certify release/deployment readiness.

Run root and web `npm audit --json --include=dev --audit-level=high` independently,
then separate requests with `--audit-level=moderate`, before and after. Record
natural exits, severity/affected-package counts, unique advisory IDs/ranges and
remediation availability; aggregate scripts can short-circuit or obscure exits.
The 2026-10-17 baseline retained 20 root moderate affected-package entries from
the single sprintf-js advisory GHSA-hp3w-g68c-fv3c, with no web findings and no
high/critical findings. This is baseline evidence, not candidate acceptance or
20 distinct vulnerabilities. Publisher advisories absent from the audit feed
cannot be claimed removed from its counts by a patch. New findings require
assessment, not automatic audit fixes or unrelated upgrades.

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

Root tsx 4.23.15 selects esbuild 0.28.2 within its existing `~0.28.0` range,
without a direct dependency or override; Vite's separate esbuild 0.25.12
remains unchanged. Source-launcher consumers include Node `--import tsx`
terminal, publication, public-entry, process, logger and Supervisor fixtures,
CLI-backed disposable init/repair tests, and `scripts/copy-system-template-prompts.js`
in `npm run build`. The copy script compiles and copies every registered prompt
closure, then recompiles the packaged closure. Registry/copy-script Jest checks
and the full build, including compiled composition's source/package byte comparison,
protect that packaging consumer. Applicability of the Windows `servedir` traversal
advisory to this Linux transpilation consumer is not established.

Compare baseline and candidate in separate clean-installed root/web dependency
roots, retaining exact toolchain versions, lock graphs, selected tests, warnings
and natural exits. Run the terminal-child suite independently, targeting the actual
App PID through Node `--import tsx`, never a CLI intermediary. Explicitly select
the process-inline E2E consumer and the separate ts-jest config-init smoke rather
than infer their coverage from default Jest selection. Disposable CLI probes for
typed stdin and one-shot SIGINT asynchronous cleanup supplement, not replace,
the actual App tests: require typed output with exit0 and completed cleanup with
exit42 on the candidate, while recording the baseline's actual outcome. Required
candidate failures block acceptance even if baseline also fails; forced exits,
retries or relaxed deadlines are not passing evidence. This comparison is not
full E2E/release certification or deployment approval; tsx does not own Jest's
ts-jest transformations.

The Jest/Istanbul chain's sprintf-js advisory remains unpatched and deferred;
upstream repair or compatible parent removal is the revisit trigger. Run root
and web audits independently with development dependencies included, including
at the lower moderate threshold so a root finding cannot hide the web result.
These dated audit results are not security certification or proof of deployed state.

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

### Backend patch decision — 2026-10-16

Updated Fastify 5.12.5 → 5.12.7 and @fastify/static 10.1.3 → 10.1.6,
retaining caret manifest floors and exact lock resolutions. These supported
security-maintenance patches remove the affected package ranges for
[Fastify header-schema validation bypass (GHSA-389g-gv7q-r4x8)](https://github.com/fastify/fastify/security/advisories/GHSA-389g-gv7q-r4x8)
and [static path-guard bypass (GHSA-r799-r9gc-m956)](https://github.com/fastify/fastify-static/security/advisories/GHSA-r799-r9gc-m956).
No Saivage exploit was demonstrated: the Fastify advisory's schema constructs
were not observed here, and the static advisory requires a case-insensitive
filesystem rather than the intended ordinary Linux deployment. Static requires
content-disposition 3.0.0 (Node >=22), compatible with the tested Node 24.22.0 /
npm 11.19.1 toolchain; no other transitive resolution changed.

@fastify/cors and @fastify/websocket remain 11.2.0. Their newer 11.3 minor lines
are independent assessments, not required security patches for this unit:
CORS supplied no evidenced necessary behavior fix, while WebSocket error/upgrade
lifecycle maintenance remains separately worthwhile to assess. No blanket
backend refresh, compatibility override or runtime workaround was introduced.

Baseline and candidate focused server checks each passed eight suites / 82 tests
with no skips: real-Fastify REST/authentication and TCP-WebSocket admission,
observation-only and inbound-bound consumers, plus policy and credential-safe
request-serializer coverage. Candidate clean install, full dependency-tree check,
`validate:routine` and `build` passed, including compiled prompt composition and
real-Fastify static serving. The static smoke checks the docs redirect/landing,
six linked navigation pages, CSS/JS and conditional icons, docs misses returning
404, SPA `/` and `/cards`, a built web asset, and asset/API misses returning 404
rather than the SPA. All commands exited naturally without owner containment.

Independent include-dev root/web audits passed the high/critical gate before and
after: root retained 20 moderate affected-package entries and zero low/high/critical;
web had zero findings. Neither selected advisory was yet in the audit feed;
their affected ranges were removed by the locked package versions, not certified
absent by that feed. At that dated backend decision, DOMPurify continuation was
deferred pending its original owner; that ownership deferral is historical, not
the current sanitizer acceptance disposition. The separate sanitizer comparison
above requires its own candidate gates; sprintf-js remains deferred. This is bounded
source patch acceptance, not an audit-free, full-release or deployment certificate. No browser,
case-insensitive-filesystem exploit or unused download-API coverage is claimed.
