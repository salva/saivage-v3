# Saivage v3

Saivage v3 is an autonomous multi-agent runtime for software-development work. A top-level planner decomposes goals into cards, executors perform scoped work, reviewers verify results, and the operator workspace projects cards, agents, files, timeline events, and runtime state while the Analyst chat is the mutating user control surface.

## Quick start

Use Node.js 24 (the repository engines require `node >=24 <25` and `npm >=10 <12`, matching the GitHub Actions validation profile), then install dependencies:

```bash
npm install
```

Build and serve the control room, API, and docs:

```bash
SAIVAGE_API_TOKEN=test npm run build && SAIVAGE_API_TOKEN=test ./bin/saivage.js start --create-runtime
```

Open the web UI at `http://localhost:8080/`, or check health with:

```bash
curl http://localhost:8080/health
```

## Current documentation

| Link | Authority status | Reader guidance |
|---|---|---|
| [Functional specification](docs/spec/system-specification.md) | current functional authority | What Saivage must do from the user and runtime point of view. |
| [Architecture](docs/architecture/system-architecture.md) | current architecture summary | How the functional model is organized into runtime, agents, storage, API, and UI subsystems. |
| [Old documentation](docs/old/) | superseded provenance | Previous docs generations preserved for reference only. |

## Key concepts

| Link | Authority status | Reader guidance |
|---|---|---|
| [Functional specification](docs/spec/system-specification.md) | current | Start here for product behavior and runtime semantics. |
| [Architecture summary](docs/architecture/system-architecture.md) | current | Use after the functional spec for design orientation. |
| `docs/working/<date>/` | local, ignored | Temporary working documents and plans; not committed to git. |
| `docs/old/` | superseded | Previous generations of documentation. |

## Verification

Run the validation profile that matches the change type. The checked-in GitHub Actions workflow at [`.github/workflows/validation.yml`](.github/workflows/validation.yml) is least-privilege and secret-free (`contents: read`, no `secrets.*` or token-like env assignments), cancels superseded runs for the same workflow/ref, sets up Node.js 24 with npm caching, installs with `npm ci`, and runs `npm run validate:routine` plus `npm run validate:docs` automatically on push/pull request. `workflow_dispatch` inputs expose the heavier `npm run validate:ui-smoke` and `npm run validate:release` profiles as manual gates.

```bash
npm run validate:docs
npm run validate:routine
npm run validate:ui-smoke
npm run validate:ui
npm run validate:release
```

For final stage/release gates, run the underlying checks directly when requested:

```bash
npm run docs:verify
npm run typecheck
npm run build
npm test
npm run web:test:operator-smoke
```

The documentation tree is being reconstructed under `docs/spec/` and `docs/architecture/`. Treat docs-specific validation as deferred until that reconstruction is complete; use code, build, and focused test gates for implementation changes in the meantime.
