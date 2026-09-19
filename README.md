# Saivage v3

Saivage is autonomous software engineering built for the long run. Give it the
specification for a software project and it carries the work from
specification to accepted delivery — planning, implementing, testing, and
reviewing on its own, over long runs, with evidence for every step — asking
for you only when a real decision is missing. The operator observes
everything through a web control room and steers through a single Analyst
conversation.

Start with the [documentation overview](docs/overview.md), the
[getting-started guide](docs/guides/getting-started.md), or the
[documentation site](https://salva.github.io/saivage-v3/) (also served by
every running instance at `/docs/`).

For an AI-guided LXC installation, use the subordinate
[AI setup procedure](README-IF-YOU-ARE-AN-AI.md). It applies the canonical
contracts linked below; it is not an independent product or operations
authority.

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
# At minimum, configure a provider and point the model routes and compaction
# summarizer at it before starting; the bundled template ships no provider.
SAIVAGE_API_TOKEN=test "$SAIVAGE_BIN" start
```

The [getting-started guide](docs/guides/getting-started.md) walks through a
complete minimal configuration and first objective, and the
[configuration guide](docs/guides/configuration.md) documents every key. The [system specification](docs/spec/system-specification.md#8-lifecycle-lock-and-cli)
owns startup options and precedence; the [runbook](docs/runbook/index.md)
owns deployment, configuration cutovers, lifecycle operations, recovery, and
reset, including its [command-environment guidance](docs/runbook/index.md#command-environment).

Open the UI at `http://localhost:8080/` and the built documentation at
`http://localhost:8080/docs/`, or check the public probes:

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
| [Documentation overview](docs/overview.md) | Orientation summary: what Saivage is, the card model, agent roles, the run loop, and vocabulary. Not an authority. |
| [Getting started](docs/guides/getting-started.md) | Guide: build, initialize, configure, start, and hand over a first objective. |
| [Configuration](docs/guides/configuration.md) | Guide: every `saivage.yaml` key with annotated examples. |
| [Operating a project](docs/guides/operating.md) | Guide: the control room, the Analyst conversation, and long-run operation. |
| [System specification](docs/spec/system-specification.md) | Sole authority for product, runtime, CLI-visible behavior, and exact functional contracts. |
| [Operator UI specification](docs/spec/operator-ui.md) | Sole authority for operator web UI behavior and presentation. |
| [System architecture](docs/architecture/system-architecture.md) | Sole authority for component ownership, dependency direction, internal architecture, and source-derived inventories. |
| [Operator runbook](docs/runbook/index.md) | Sole authority for deployment, startup, lifecycle, recovery, reset, and other operator procedures. |
| [Validation internals](docs/validation.md) | Validation toolchain detail: guard contracts, CI job topology, and browser/E2E profiles. |
| [README](README.md) | Introduction, minimal quick start, authority navigation, and repository validation profiles. |
| [AI setup procedure](README-IF-YOU-ARE-AN-AI.md) | Subordinate seven-stage LXC setup procedure; follow its links to the authorities above. |

For prompt customization, see the canonical [shipped project-guidance authoring guide](docs/architecture/prompts.md#authoring-shipped-project-guidance).

## Notable current behaviors

- Conversation compaction is model-aware (`context_utilization_fraction` 0.80,
  `trigger_fraction` 0.90, `tail_fraction` 0.25) with one contextual
  sequential-refine accumulator inside a shared 16-logical-call bound; see the
  [compaction runbook](docs/runbook/index.md#prepared-conversation-compaction).
  The conversation index/genesis/segment format is version 2 with strict
  protected-prompt declarations
  ([prompt contract](docs/architecture/prompts.md),
  [cutover procedure](docs/runbook/index.md#configuration-file-cutovers)).
- New projects enable an independent two-hour
  [Project Oversight](docs/spec/system-specification.md#project-oversight)
  check by default; its only project effect is an evidenced notification.
- Process tools return bounded, redacted inline stdout/stderr heads with
  completeness flags and durable log URLs
  ([process result contract](docs/spec/system-specification.md#7-run-pause-resume-stop-and-restart));
  adopting that payload from metadata-only rows is a reset-only cutover
  ([procedure](docs/runbook/index.md#card-process-configuration-and-prompt-cutover)).
- `glob`/`grep` results are packed into byte-bounded stateless pages
  ([search result contract](docs/spec/system-specification.md#10-prepared-invocation-exact-admission-and-compaction)).

## Verification

Use the profile that matches the change; `docs/validation.md` owns the
toolchain internals and CI topology behind them.

| Profile | Runs | Use for |
| --- | --- | --- |
| `npm run validate:docs` | `docs:verify` (docs build + all drift guards); excludes `npm test` and `web:test:operator-smoke` | Documentation-only changes |
| `npm run validate:routine` | typecheck, `check:export-consumers`, canonical-persistence drift, `docs:verify` | Routine backend/runtime changes (no Jest) |
| `npm run validate:ui-smoke` | `npm run web:test:operator-smoke` | Quick UI/operator smoke |
| `npm run validate:ui` | web typecheck, complete `web:test`, operator browser smoke | Web UI changes |
| `npm run validate:release` | typecheck, build, non-E2E Jest, backend E2E, operator smoke, docs | Release sign-off |

Focused backend commands: `npm test` is the
complete non-E2E backend authority — it runs ordinary parallel Jest followed by the exact serial
real-terminal-child suite after ordinary workers exit. Use `npm run
test:parallel -- <Jest arguments>` or `npm run test:direct -- <Jest
arguments>` for focused tests in the ordinary Jest set, which excludes the
terminal-child suite; run `npm run test:terminal-child` for that in-band
exceptional suite, and `npm run test:e2e` for the backend E2E tier.
Required guards: `npm run check:export-consumers`, `npm run
web:test:operator-smoke`, `npm run lint`, `npm run test:import-boundaries`,
`npm run audit:security`, and `npm run deps:review`. Root and web
dependencies must be installed before `npm run check:export-consumers`,
`npm run lint`, or `npm run validate:routine`.

CI notes: the always-run `routine-docs` job clean-installs both root and web
dependencies before `validate:routine` and `validate:docs`; `backend-jest-build`
performs the dual clean install — root `npm ci`, then web `cd web && npm ci` —
before build and non-E2E Jest. `npm run web:test:e2e:smoke` is the
complete self-contained browser profile: it owns
every production-preview smoke test
and the one source browser-client test. The preview owner starts the
production preview server; the browser-client owner starts the Vite
dev server, and neither contacts a live Saivage deployment. After a failed or cancelled
CI browser run, a best-effort artifact upload preserves
`tmp/playwright-report` and `tmp/playwright-results`; missing output only
warns. See [validation internals](docs/validation.md) for the guard
contracts, full CI topology, and dependency governance.

```bash
npm run check:export-consumers
npm run validate:docs
npm run validate:routine
npm run validate:ui-smoke
npm run validate:ui
npm run validate:release
npm run audit:security
npm run deps:review
```

README owns validation selection and navigation, not product contracts.
