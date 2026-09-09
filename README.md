# Saivage v3

Saivage v3 is an autonomous multi-agent runtime for software-development work.

For an AI-guided LXC installation, use the subordinate
[AI setup procedure](README-IF-YOU-ARE-AN-AI.md). It applies the canonical
contracts linked below; it is not an independent product or operations authority.

## Quick start

Saivage is designed for an externally isolated LXC container in which trusted
agents may have root access. See the
[architecture trust model](docs/architecture/system-architecture.md#deployment-and-trust-model)
before deployment. Local builds and tests outside LXC remain supported.

Use Node.js 24. The package engines require `node >=24 <25` and `npm >=10 <12`,
matching GitHub Actions. Build from a source checkout, then initialize and start
from the target project:

```bash
cd <SAIVAGE_SOURCE_CHECKOUT>
npm ci
(cd web && npm ci)
npm run build
SAIVAGE_BIN="/absolute/path/to/saivage-v3/bin/saivage.js"

TARGET_PROJECT="/absolute/path/to/target-project"
mkdir -p "$TARGET_PROJECT"
cd "$TARGET_PROJECT"
"$SAIVAGE_BIN" init
# Configure .saivage/saivage.yaml before starting.
SAIVAGE_API_TOKEN=test "$SAIVAGE_BIN" start
```

The [system specification](docs/spec/system-specification.md#8-lifecycle-lock-and-cli)
owns startup options and precedence. The [runbook](docs/runbook/index.md) owns
deployment, configuration cutovers, lifecycle operations, recovery, and reset.

Conversation compaction uses one contextual sequential-refine accumulator and at
most two preselected safe coverage endpoints. Current configuration has one
`tail_fraction` (default `0.25`) and no merge/summary escalation fractions. See
the [prepared conversation compaction runbook](docs/runbook/index.md#prepared-conversation-compaction)
for capacity, 16-call, and failure limits; these bounds are not latency or
summary-quality guarantees.
Selected Agents and Debug conversation detail can show ephemeral completed-call,
in-flight, and elapsed compaction progress without polling or durable state.

Open the UI at `http://localhost:8080/`, or check the public probes:

```bash
curl http://localhost:8080/health
curl http://localhost:8080/health/ready
```

When authentication is enabled, send the bearer token only in the
`Authorization` header, never in a URL:

```bash
curl -H "Authorization: Bearer $SAIVAGE_API_TOKEN" http://localhost:8080/api/processes
```

## Current documentation

| Link | Role |
| --- | --- |
| [System specification](docs/spec/system-specification.md) | Sole authority for product, runtime, CLI-visible behavior, and exact functional contracts. |
| [Operator UI specification](docs/spec/operator-ui.md) | Sole authority for operator web UI behavior and presentation. |
| [System architecture](docs/architecture/system-architecture.md) | Sole authority for component ownership, dependency direction, internal architecture, and source-derived inventories. |
| [Operator runbook](docs/runbook/index.md) | Sole authority for deployment, startup, lifecycle, recovery, reset, and other operator procedures. |
| [README](README.md) | Introduction, minimal quick start, authority navigation, and repository validation profiles. |
| [AI setup procedure](README-IF-YOU-ARE-AN-AI.md) | Subordinate seven-stage LXC setup procedure; follow its links to the authorities above. |

## Verification

`npm run check:export-consumers` is the singular complete semantic
external-consumer guard. Its candidate boundary is every tracked, non-test,
non-declaration TypeScript-family module under `src/**` and `web/src/**`, plus
every tracked, non-test Vue SFC under `web/src/**`. Its consumer boundary is all
tracked TypeScript-family files, including declarations and out-of-config
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
checking are candidate-owner-scoped and in memory only: they create no artifact.
Production reachability outranks test reachability. The dead-outer non-rescue
rule means an unconsumed outer export never seeds emitter-only dependencies.
SFCs remain complete
surface and semantic-consumer owners but do not originate declaration units or
emitter-only edges; `npm run web:typecheck` remains the authoritative Vue type
gate. The four reported classes are `production-consumed`, `test-only`,
`local-only`, and `zero-use`; the latter two fail, as do stale or unresolved
edges and unsupported consumer forms. Run
`node scripts/check-export-consumers.js --report-test-only` for the sorted
test-only report. `scripts/export-consumer-allowlist.json` is the strict
exceptional allowlist and remains an empty array.

`npm run lint` runs the export-consumer guard before stamp-producer, ESLint,
backend import-boundary, and web-component boundary checks. Backend
import-boundary findings remain advisory accumulated debt.

The push-only `master` workflow in
[`.github/workflows/validation.yml`](.github/workflows/validation.yml) uses
least-privilege, secret-free Node 24 jobs and cancels superseded runs. Its
always-run `routine-docs` job executes `validate:routine` and `validate:docs`.
Fail-closed path classification gates the other jobs. `backend-jest-build`
performs the dual clean install—root `npm ci`, then web `cd web && npm ci`—before
build and non-E2E Jest. The independently visible `backend-e2e` job uses a root
clean install and owns `npm run test:e2e`; it needs no web install, browser,
secret, or external service. Applicable UI paths run complete web typechecking
and Vitest plus a separate browser-smoke job. Package/workflow changes run the
production dependency gate `npm run audit:security`.

```bash
npm run check:export-consumers
npm run validate:docs
npm run validate:routine
npm run validate:ui-smoke
npm run validate:ui
npm run validate:release
```

Root `npm test` is the complete non-E2E backend authority: it runs ordinary parallel Jest
followed by the exact serial real-terminal-child suite after
ordinary workers exit. Use `npm run test:parallel -- <Jest arguments>` or
`npm run test:direct -- <Jest arguments>` for focused tests in the ordinary Jest
set, which excludes the terminal-child suite. Run `npm run test:terminal-child`
for that in-band exceptional suite. `validate:release` runs singular `npm test`,
then the distinct `npm run test:e2e` backend tier exactly once before browser
smoke.

For Debug Graphs changes, run the focused projection/handler, web, and browser
owners before broader profiles:

```bash
npm run test:parallel -- tests/runtime/card-process/compiled-graphs-projection.test.ts tests/server/operator-files-debug-handlers.test.ts --runInBand
(cd web && npx vitest run src/__tests__/debug-graphs.test.ts src/__tests__/debug-view.integration.test.ts)
npm run web:test:operator-smoke
```

`validate:routine` invokes `check:export-consumers` directly after TypeScript
typechecking and before documentation guards. `validate:docs` is the docs-only
profile: it runs `docs:verify` and excludes `npm test` and
`web:test:operator-smoke`. `validate:routine` does not run backend Jest, so
backend/runtime changes require focused Jest. `validate:ui-smoke` runs operator
browser smoke. `validate:ui` runs web typechecking, complete `web:test` Vitest,
and operator browser smoke. `validate:release` includes typecheck, build,
non-E2E backend Jest, backend E2E, operator browser smoke, and docs verification.

The normal Cards browser regression owner is
`tests/playwright/smoke/cards-independent-scroll-selection.spec.ts`; card-status
presentation is owned by
`tests/playwright/smoke/card-status-presentation.spec.ts`. Both are included by
the existing operator smoke scripts.

`npm run web:test:e2e:smoke` is the complete self-contained browser profile:
it owns every production-preview smoke test and the one source browser-client test.
It composes exactly `npm run web:test:e2e:preview-smoke` and
`npm run web:test:e2e:browser-client-smoke`.
The preview owner starts the production preview server; the
browser-client owner starts the Vite dev server. Neither contacts a live Saivage
deployment. Install Chromium with `npm run web:test:e2e:install` and install host
browser dependencies where required. After a failed or cancelled CI browser
run, a best-effort artifact upload preserves `tmp/playwright-report` and
`tmp/playwright-results`; missing output only warns.

Operator browser smoke includes a non-loopback plain-HTTP scenario. The
validation host must expose a non-internal IPv4 interface reachable by local
Chromium; absence is a failing prerequisite, not a skipped test or production
network requirement.

The build and release gates package every registered prompt tree and run its
compiled composition smoke. Repeat that focused check against existing build
output with `npm run test:compiled-prompt-composition`.

To use a locally installed Chrome for release validation:

```bash
PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/absolute/path/to/chrome npm run validate:release
```

Omitting the variable retains the managed-browser default. This affects local
validation only, never service configuration.

Run production dependency security and the broader local-only freshness review
with:

```bash
npm run audit:security
npm run deps:review
```

`npm run validate:release` is the singular local release-sign-off composition.
Its constituent commands remain useful for diagnosis; release validation does
not require another manual backend-E2E invocation. README owns validation
selection and navigation, not product contracts.
