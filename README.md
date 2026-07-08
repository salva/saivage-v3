# Saivage v3

Saivage v3 is an autonomous multi-agent runtime for software-development work. A top-level planner decomposes goals into cards, executors perform scoped work, reviewers verify results, and the operator workspace projects cards, agents, files, timeline events, and runtime state while the Analyst chat is the mutating user control surface.

## Quick start

Use Node.js 24 (the repository engines require `node >=24 <25` and `npm >=10 <12`, matching the GitHub Actions validation profile). Build Saivage from a source checkout, then operate it from the target project directory so the project-local `.saivage/` runtime tree is created beside the work Saivage will manage:

```bash
cd <SAIVAGE_SOURCE_CHECKOUT>
npm install
npm run build
SAIVAGE_BIN="/absolute/path/to/saivage-v3/bin/saivage.js"

TARGET_PROJECT="/absolute/path/to/target-project"
mkdir -p "$TARGET_PROJECT"
cd "$TARGET_PROJECT"
"$SAIVAGE_BIN" init
```

Before starting, configure model roles in `$TARGET_PROJECT/.saivage/saivage.yaml`. `start` fail-fasts at boot unless every dispatched model role (`planner`, `executor`, `reviewer`, and `analyst`) resolves. Each role resolves, in order, through one of three paths: `models.<role>` as a model name or a non-empty list for that role; `models.routing[role]` pointing to `models.profiles[<name>]`, whose `preferred` and `allowed` arrays merge; or `models.default` as a shared fallback. The minimal recommended quick-start path is the third one: a single `models.default` plus a provider entry that can serve it satisfies all four roles. Operators who want per-role or routing-profile control use the first two paths; see the Source-Derived Reference section in [the architecture summary](docs/architecture/system-architecture.md) for the full config-schema inventory.

Minimal model configuration (quick-start path only):

```yaml
models:
  default: ["gpt-4.1"]
providers:
  openai:
    models: ["gpt-4.1"]
    apiKey: "<your-api-key>"
server:
  port: 8080
  host: "0.0.0.0"
runtime: {}
```

Agent prompts are customizable inline via `prompts:` in `.saivage/saivage.yaml`. Copy a role block from `dist/src/utils/prompt-defaults.yaml` into the config and edit the YAML literal block scalar; omitted roles keep the built-in defaults.

Existing deployments must rename `.saivage/saivage.json` to `.saivage/saivage.yaml` with `mv`, not `cp`. If both files exist, startup fails and directs the operator to delete the obsolete JSON because it may still contain provider credentials. After the rename, operators may rewrite the file to idiomatic YAML and optionally add `prompts:` overrides. `${ENV_VAR}` interpolation does not apply inside `prompts:`; use `{{variable}}` placeholders there.

Start Saivage from the target project directory:

```bash
SAIVAGE_API_TOKEN=test "$SAIVAGE_BIN" start
```

Open the web UI at `http://localhost:8080/`, or check health with:

```bash
curl http://localhost:8080/health
```

## Current documentation

| Link | Authority status | Reader guidance |
|---|---|---|
| [Functional specification](docs/spec/system-specification.md) | current functional authority | What Saivage must do from the user and runtime point of view. |
| [Operator UI specification](docs/spec/operator-ui.md) | current UI functional authority | Analyst panel, read-only workspace, UI mutation boundaries, and contextual navigation. |
| [Architecture](docs/architecture/system-architecture.md) | current architecture summary | How the functional model is organized into runtime, agents, storage, API, and UI subsystems. |
| [README](README.md) | current validation and documentation authority map | Quick start, validation profiles, and this canonical documentation map. |

## Key concepts

| Link | Authority status | Reader guidance |
|---|---|---|
| [Functional specification](docs/spec/system-specification.md) | current | Start here for product behavior and runtime semantics. |
| [Operator UI specification](docs/spec/operator-ui.md) | current | Use for UI behavior and Analyst integration details. |
| [Architecture summary](docs/architecture/system-architecture.md) | current | Use after the functional spec for design orientation. |
| `docs/working/<date>/` | local, ignored | Temporary working documents and plans; not committed to git. |

## Verification

Run the validation profile that matches the change type. The checked-in GitHub Actions workflow at [`.github/workflows/validation.yml`](.github/workflows/validation.yml) is least-privilege and secret-free (`contents: read`, no `secrets.*` or token-like env assignments), cancels superseded runs for the same workflow/ref, sets up Node.js 24 with npm caching, and installs with `npm ci`. On push to `main` and on pull request, the `routine-docs` job runs `npm run validate:routine` and `npm run validate:docs`. A `classify-changes` job gates `backend-jest-build`, `ui-smoke`, `browser-smoke`, and `dependency-hygiene` by changed paths. `workflow_dispatch` exposes a single `run_full_sweep` choice; when it is `true`, all path-aware jobs run regardless of changed paths. The scheduled nightly backstop (`cron: '17 5 * * *'`) runs `npm run validate:release` and the browser smoke. The `dependency-hygiene` job runs on schedule, manual full sweep, or package/workflow changes; it runs `npm run audit:security` and, on schedule or manual full sweep, `npm run deps:review`.

```bash
npm run validate:docs
npm run validate:routine
npm run validate:ui-smoke
npm run validate:ui
npm run validate:release
```

`npm run validate:docs` is the docs-only validation profile: it runs the documentation drift guards (`npm run docs:verify`) and intentionally excludes `npm test` and `web:test:operator-smoke` so documentation-only changes can validate without the full backend Jest suite or the browser operator-smoke gate. The heavier `npm run validate:routine`, `validate:ui-smoke`, and `validate:release` profiles layered above it add typecheck, the UI smoke, build, and full test coverage respectively.

The GitHub Actions `dependency-hygiene` job runs `npm run audit:security` and, on schedule or manual full-sweep, `npm run deps:review`. Run those dependency-governance checks directly with:

```bash
npm run audit:security
npm run deps:review
```

For final stage/release gates, run the underlying checks directly when requested:

```bash
npm run docs:verify
npm run typecheck
npm run build
npm test
npm run web:test:operator-smoke
```

The canonical docs listed above are current authority. `npm run validate:docs` is the documentation drift gate for keeping those docs, links, source anchors, validation cadence, and source-derived route/tool/config inventories in sync.
